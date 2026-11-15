/**
 * Retrieval over published stems: the keyword (BM25) channel, RRF fusion and the project index.
 *
 * Port of `backend/apps/search/services/{tokenize,index,hybrid,vector}.py`.
 *
 * Order of operations — the order *is* the security property:
 *
 *  1. `searchableDocuments` produces the candidate set. It re-derives the scope from live relations
 *     (owner project, published and not withdrawn versions, the subject's own project, sealed/holdout
 *     excluded), so a stale `is_searchable` flag cannot widen the result set.
 *  2. each channel scores **only** those candidates;
 *  3. reciprocal rank fusion merges the ranked lists;
 *  4. the top `limit` documents are serialised.
 *
 * The index holds stem-shaped text only — blocks, options, blanks, shared-material text and node
 * names/aliases. Answers, rubric criteria and explanations are not reachable from the builder, so a
 * retrieval bug cannot leak an answer.
 *
 * **The vector channel does not run here.** DSH has no embedding endpoint (03 §0 D-3/D-7), so
 * `vectorAvailability()` answers `available: false` with `code: "vector_not_configured"` and the
 * response says so instead of pretending a cosine pass happened. Keyword-only retrieval is a
 * documented degradation, not a silent one.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Instant } from '../domain/instant.ts'
import { pyJsonCanonical } from '../store/pyjson.ts'
import { countRows, findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { compareCodePoints } from './cycles.ts'
import { InvalidInput } from './errors.ts'
import { requireProject, requireSubject } from './exams.ts'
import { sealedQuestionIds } from './sealing.ts'

/** Bumped whenever the tokenisation rules change; reported in search responses. */
export const TOKENIZER_VERSION = 'zh-char-ngram-v1'
/** Okapi BM25 parameters (the standard defaults; reported in the response). */
export const BM25_K1 = 1.2
export const BM25_B = 0.75
/** Reciprocal rank fusion constant (the value from the original RRF paper). */
export const RRF_K = 60
/** Longest excerpt returned per hit; the excerpt is taken from indexed stem text. */
export const EXCERPT_LENGTH = 160
/** Hard ceiling for one request. */
export const MAX_LIMIT = 50
export const SEARCH_CHANNELS = ['keyword', 'vector', 'hybrid'] as const
const DEFAULT_LIMIT = 10

/** The machine-readable state of the vector channel in this deployment. */
export const VECTOR_NOT_CONFIGURED = 'vector_not_configured'
/**
 * Why the vector channel cannot run — stated once and reported verbatim.
 *
 * Never a zero vector and never a fabricated similarity: an invented embedding would produce fake
 * retrieval evidence, which is worse than an honestly unavailable channel.
 */
export const VECTOR_UNAVAILABLE_REASON =
  '未配置向量化模型（embedding provider）：DSH 不提供 embed 端点，关键词检索可用，向量检索与混合排序不可用。'

// --------------------------------------------------------------------------
// Tokenizer
// --------------------------------------------------------------------------
/** CJK ideograph ranges that participate in unigram+bigram tokenisation. */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2fa1f],
]

export function isCjk(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end)
}

/**
 * `str.casefold()` for the scripts this corpus uses.
 *
 * `toLowerCase()` covers the Latin-1 case pairs; the extra entries are the case-folding mappings
 * that differ from lowering (`ß` -> `ss` and the Greek final sigma). Anything outside this table
 * lowers exactly like Python does.
 */
function casefold(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replaceAll('ς', 'σ')
    .replaceAll('\u0130', 'i\u0307')
}

const WORD = /[\p{L}\p{N}]/u
const DECIMAL_DIGIT = /\p{Nd}/u

/** Latin letters and digits (after NFKC) form whole-word tokens. */
function isWordCharacter(character: string): boolean {
  return WORD.test(character)
}

/** Split normalised text into ordered `(kind, value)` runs; punctuation never becomes a token. */
function runs(text: string): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = []
  let buffer: string[] = []
  let kind = ''
  const flush = (): void => {
    if (buffer.length > 0) out.push({ kind, value: buffer.join('') })
    buffer = []
    kind = ''
  }
  const chars = [...text]
  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index]
    if (isCjk(character)) {
      if (kind !== 'cjk') {
        flush()
        kind = 'cjk'
      }
      buffer.push(character)
      continue
    }
    if (isWordCharacter(character)) {
      if (kind !== 'word') {
        flush()
        kind = 'word'
      }
      buffer.push(character)
      continue
    }
    if (character === '.' && kind === 'word' && buffer.length > 0 && DECIMAL_DIGIT.test(buffer[buffer.length - 1])) {
      // A decimal point stays inside a number ("3.14"); a sentence period never joins two tokens.
      const next = index + 1 < chars.length ? chars[index + 1] : ''
      if (next !== '' && DECIMAL_DIGIT.test(next)) {
        buffer.push(character)
        continue
      }
    }
    if (
      character === '%' &&
      kind === 'word' &&
      buffer.length > 0 &&
      (DECIMAL_DIGIT.test(buffer[buffer.length - 1]) || buffer[buffer.length - 1] === '.')
    ) {
      buffer.push(character)
      continue
    }
    flush()
  }
  flush()
  return out
}

/**
 * Return the ordered token list for `text`.
 *
 * Deterministic: identical input always yields an identical list, in the reading order of the
 * source text. Every CJK run contributes its character unigrams *and* its adjacent bigrams, so
 * `光合作用` is found by both `光` and `光合`.
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const normalized = casefold(String(text).normalize('NFKC'))
  const tokens: string[] = []
  for (const run of runs(normalized)) {
    if (run.kind === 'cjk') {
      const chars = [...run.value]
      tokens.push(...chars)
      for (let index = 0; index < chars.length - 1; index += 1) {
        tokens.push(chars[index] + chars[index + 1])
      }
    } else {
      tokens.push(run.value)
    }
  }
  return tokens
}

/** Term → occurrence count, ordered by term for stable JSON output. */
export function termFrequencies(tokens: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  const out: Record<string, number> = {}
  for (const term of [...counts.keys()].sort(compareCodePoints)) out[term] = counts.get(term)!
  return out
}

// --------------------------------------------------------------------------
// Text construction (stem-shaped fields only)
// --------------------------------------------------------------------------
function blocksText(blocks: unknown): string[] {
  const parts: string[] = []
  if (!Array.isArray(blocks)) return parts
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    const kind = record.kind
    if (kind === 'text' || kind === 'math') {
      const value = kind === 'text' ? record.text : record.latex
      if (typeof value === 'string' && value.trim() !== '') parts.push(value)
    } else if (kind === 'image') {
      const alt = record.alt
      if (typeof alt === 'string' && alt.trim() !== '') parts.push(alt)
    } else if (kind === 'table') {
      const caption = record.caption
      if (typeof caption === 'string' && caption.trim() !== '') parts.push(caption)
      for (const row of (record.rows ?? []) as unknown[]) {
        if (!Array.isArray(row)) continue
        for (const cell of row) {
          if (cell !== null && typeof cell === 'object') {
            const value = (cell as Record<string, unknown>).text
            if (typeof value === 'string' && value.trim() !== '') parts.push(value)
          } else if (typeof cell === 'string' && cell.trim() !== '') {
            parts.push(cell)
          }
        }
      }
    }
  }
  return parts
}

/**
 * The indexed text of one question version: stem + options + material text.
 *
 * Deliberately takes no answer or rubric argument, so no caller can pass answer material into the
 * index.
 */
export function buildQuestionText(version: Record<string, unknown>): string {
  const content = (version.content ?? {}) as Record<string, unknown>
  const parts: string[] = []
  parts.push(...blocksText(content.blocks))
  for (const option of (content.options ?? []) as unknown[]) {
    if (option !== null && typeof option === 'object') {
      parts.push(...blocksText((option as Record<string, unknown>).blocks))
    }
  }
  for (const blank of (content.blanks ?? []) as unknown[]) {
    if (blank !== null && typeof blank === 'object') {
      parts.push(...blocksText((blank as Record<string, unknown>).blocks))
    }
  }
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n')
}

/** `build_question_text` including the shared material of a child version. */
function questionText(db: DatabaseSync, version: Record<string, unknown>): string {
  const parts = [buildQuestionText(version)]
  const parentId = version.parent_material_version_id
  if (parentId !== null && parentId !== undefined) {
    const parent = findOne(db, 'question_bank_question_version', { id: String(parentId) })
    if (parent !== null) parts.push(buildQuestionText(parent))
  }
  return parts.filter((part) => part !== '').join('\n')
}

/** The indexed text of one knowledge node: canonical name plus aliases. */
export function buildNodeText(node: Record<string, unknown>): string {
  const parts = [String(node.canonical_name ?? '')]
  for (const alias of (node.aliases ?? []) as unknown[]) {
    if (typeof alias === 'string' && alias.trim() !== '') parts.push(alias)
  }
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n')
}

function digest(payload: unknown): string {
  return createHash('sha256').update(pyJsonCanonical(payload), 'utf8').digest('hex')
}

/** Digest naming exactly which revision a row holds. */
export function questionVersionRevision(version: Record<string, unknown>): string {
  const contentDigest = version.content_digest
  if (contentDigest !== null && contentDigest !== undefined && String(contentDigest) !== '') {
    return String(contentDigest).slice(0, 64)
  }
  return digest({
    id: String(version.id),
    version: Number(version.version),
    question_type: String(version.question_type),
    content: version.content ?? {},
  })
}

export function nodeRevision(node: Record<string, unknown>): string {
  return digest({
    id: String(node.id),
    name: String(node.canonical_name ?? ''),
    aliases: (node.aliases ?? []) as string[],
  })
}

// --------------------------------------------------------------------------
// Eligibility (index time) — kept in step with the visibility gate below
// --------------------------------------------------------------------------
const SEARCH_EXCLUSION_REASON = '该题目已按保留策略封存，不参与检索'

/** Exclusion reason when the question or its family is sealed (C03). */
function holdoutReason(db: DatabaseSync, projectId: string, questionId: string | null): string {
  if (questionId === null) return ''
  return sealedQuestionIds(db, projectId, [questionId]).has(questionId) ? SEARCH_EXCLUSION_REASON : ''
}

/** Whether one question version may be indexed as retrievable content. */
export function questionEligibility(
  db: DatabaseSync,
  version: Record<string, unknown>,
): { searchable: boolean; reason: string; projectId: string; subjectId: string } {
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  const project = subject === null ? null : findOne(db, 'exams_project', { id: String(subject.project_id) })
  if (question === null || subject === null || project === null) {
    return { searchable: false, reason: '题目不属于该项目', projectId: '', subjectId: '' }
  }
  const projectId = String(project.id)
  const subjectId = String(subject.id)
  if (String(version.status) !== 'published') {
    return {
      searchable: false,
      reason: `题目版本状态为 ${String(version.status)}，只有已发布内容可被检索`,
      projectId,
      subjectId,
    }
  }
  if (version.withdrawn_at !== null && version.withdrawn_at !== undefined) {
    return { searchable: false, reason: '题目版本已撤回', projectId, subjectId }
  }
  const reason = holdoutReason(db, projectId, String(question.id))
  if (reason !== '') return { searchable: false, reason, projectId, subjectId }
  return { searchable: true, reason: '', projectId, subjectId }
}

/** Whether one knowledge node may be indexed as retrievable content. */
export function nodeEligibility(
  db: DatabaseSync,
  node: Record<string, unknown>,
): { searchable: boolean; reason: string; projectId: string; subjectId: string } {
  const syllabus = findOne(db, 'exams_syllabus_version', { id: String(node.syllabus_version_id) })
  const subject = syllabus === null ? null : findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
  const project = subject === null ? null : findOne(db, 'exams_project', { id: String(subject.project_id) })
  if (syllabus === null || subject === null || project === null) {
    return { searchable: false, reason: '考点不属于该项目', projectId: '', subjectId: '' }
  }
  return { searchable: true, reason: '', projectId: String(project.id), subjectId: String(subject.id) }
}

// --------------------------------------------------------------------------
// Writing documents
// --------------------------------------------------------------------------
function documentRow(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    question_id: null,
    question_version_id: null,
    knowledge_node_id: null,
    embedding: null,
    embedding_model: '',
    embedding_dim: null,
    embedding_updated_at: null,
    ...fields,
  }
}

/**
 * Write (or update) the index row of one question version.
 *
 * Idempotent: keyed by `(question_version, kind)`, so re-indexing the same revision updates it in
 * place instead of creating a second row.
 */
export function indexQuestionVersion(
  db: DatabaseSync,
  versionId: string,
  now: Instant,
): Record<string, unknown> {
  const version = findOne(db, 'question_bank_question_version', { id: versionId })
  if (version === null) throw new InvalidInput('题目版本不存在')
  const eligibility = questionEligibility(db, version)
  if (eligibility.projectId === '') throw new InvalidInput('题目版本不属于该项目')
  const text = questionText(db, version)
  const tokens = tokenize(text)
  const values = documentRow({
    project_id: eligibility.projectId,
    subject_id: eligibility.subjectId,
    question_id: String(version.question_id),
    question_version_id: String(version.id),
    kind: 'question',
    text,
    tokens,
    term_frequencies: termFrequencies(tokens),
    doc_length: tokens.length,
    source_revision: questionVersionRevision(version),
    is_searchable: eligibility.searchable,
    exclusion_reason: eligibility.reason.slice(0, 200),
  })
  const existing = findOne(db, 'search_document', {
    question_version_id: String(version.id),
    kind: 'question',
  })
  if (existing !== null) return updateRow(db, 'search_document', existing.id, values, { now })!
  return insertRow(db, 'search_document', values, { now })
}

/** Write (or update) the index row of one knowledge node. */
export function indexKnowledgeNode(
  db: DatabaseSync,
  nodeId: string,
  now: Instant,
): Record<string, unknown> {
  const node = findOne(db, 'knowledge_node', { id: nodeId })
  if (node === null) throw new InvalidInput('考点不存在')
  const eligibility = nodeEligibility(db, node)
  if (eligibility.projectId === '') throw new InvalidInput('考点不属于该项目')
  const text = buildNodeText(node)
  const tokens = tokenize(text)
  const values = documentRow({
    project_id: eligibility.projectId,
    subject_id: eligibility.subjectId,
    knowledge_node_id: String(node.id),
    kind: 'node',
    text,
    tokens,
    term_frequencies: termFrequencies(tokens),
    doc_length: tokens.length,
    source_revision: nodeRevision(node),
    is_searchable: eligibility.searchable,
    exclusion_reason: eligibility.reason.slice(0, 200),
  })
  const existing = findOne(db, 'search_document', {
    knowledge_node_id: String(node.id),
    kind: 'node',
  })
  if (existing !== null) return updateRow(db, 'search_document', existing.id, values, { now })!
  return insertRow(db, 'search_document', values, { now })
}

// --------------------------------------------------------------------------
// The visibility gate
// --------------------------------------------------------------------------
export interface SearchDocument {
  id: string
  kind: string
  project_id: string
  subject_id: string
  question_id: string | null
  question_version_id: string | null
  knowledge_node_id: string | null
  text: string
  tokens: string[]
  term_frequencies: Record<string, number>
  doc_length: number
  embedding: number[] | null
  /** Index-time eligibility; the live gate above is what actually protects retrieval. */
  is_searchable: boolean
}

function normalizeDocument(row: Record<string, unknown>): SearchDocument {
  return {
    id: String(row.id),
    kind: String(row.kind),
    project_id: String(row.project_id),
    subject_id: String(row.subject_id),
    question_id: row.question_id === null || row.question_id === undefined ? null : String(row.question_id),
    question_version_id:
      row.question_version_id === null || row.question_version_id === undefined
        ? null
        : String(row.question_version_id),
    knowledge_node_id:
      row.knowledge_node_id === null || row.knowledge_node_id === undefined
        ? null
        : String(row.knowledge_node_id),
    text: String(row.text ?? ''),
    tokens: (row.tokens ?? []) as string[],
    term_frequencies: (row.term_frequencies ?? {}) as Record<string, number>,
    doc_length: Number(row.doc_length ?? 0),
    embedding: (row.embedding ?? null) as number[] | null,
    is_searchable: row.is_searchable === true,
  }
}

/**
 * Every document the caller may retrieve, derived from live relations.
 *
 * `is_searchable` is *not* the gate: it is an index-time record, and the live predicates below are
 * what protect the data. Sealed content is excluded through the single resolver, so a seal (or a
 * later unseal) takes effect on retrieval immediately.
 */
export function visibleDocuments(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string | null,
): SearchDocument[] {
  const project = requireProject(db, userId, projectId)
  const sealed = sealedQuestionIds(db, String(project.id))
  const documents: SearchDocument[] = []
  for (const row of findRows(db, 'search_document', { project_id: String(project.id) })) {
    const document = normalizeDocument(row)
    if (subjectId !== null && document.subject_id !== subjectId) continue
    if (document.kind === 'question') {
      const version =
        document.question_version_id === null
          ? null
          : findOne(db, 'question_bank_question_version', { id: document.question_version_id })
      if (version === null) continue
      if (String(version.status) !== 'published') continue
      if (version.withdrawn_at !== null && version.withdrawn_at !== undefined) continue
      const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
      if (question === null) continue
      if (String(question.subject_id) !== document.subject_id) continue
      const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
      if (subject === null || String(subject.project_id) !== document.project_id) continue
      if (document.question_id !== null && sealed.has(document.question_id)) continue
    } else if (document.kind === 'node') {
      const node =
        document.knowledge_node_id === null
          ? null
          : findOne(db, 'knowledge_node', { id: document.knowledge_node_id })
      if (node === null) continue
      const syllabus = findOne(db, 'exams_syllabus_version', { id: String(node.syllabus_version_id) })
      if (syllabus === null || String(syllabus.subject_id) !== document.subject_id) continue
      const subject = findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
      if (subject === null || String(subject.project_id) !== document.project_id) continue
    } else {
      continue
    }
    documents.push(document)
  }
  return documents.sort((a, b) => compareCodePoints(a.id, b.id))
}

/** The candidate set every scoring channel is fed with. */
export function searchableDocuments(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string | null,
): SearchDocument[] {
  return visibleDocuments(db, userId, projectId, subjectId).filter((document) => document.is_searchable)
}

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------
function orderedUnique(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    ordered.push(value)
  }
  return ordered
}

/**
 * Okapi BM25 over the filtered candidate set only.
 *
 * The corpus statistics come from the candidates the caller may see, not from the whole table: a
 * sealed document must not influence the idf of a document the learner can retrieve.
 */
export function bm25Scores(
  documents: readonly SearchDocument[],
  queryTerms: readonly string[],
): Map<string, number> {
  const scores = new Map<string, number>()
  // Python only ever calls this with `_ordered_unique(tokenize(text))`; de-duplicating here keeps a
  // repeated term from inflating `document_frequency` past the document count, which would make idf
  // negative and rank a matching document below a non-matching one.
  const terms = [...new Set(queryTerms)]
  if (documents.length === 0 || terms.length === 0) return scores
  const lengths = new Map<string, number>()
  let totalLength = 0
  for (const document of documents) {
    const length = document.doc_length || document.tokens.length
    lengths.set(document.id, length)
    totalLength += length
  }
  const documentCount = documents.length
  const averageLength = documentCount > 0 ? totalLength / documentCount : 0
  const documentFrequency = new Map<string, number>()
  for (const term of terms) documentFrequency.set(term, 0)
  for (const document of documents) {
    for (const term of terms) {
      if (document.term_frequencies[term]) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
    }
  }
  for (const document of documents) {
    const length = lengths.get(document.id)!
    let score = 0
    for (const term of terms) {
      const occurrences = document.term_frequencies[term] ?? 0
      if (!occurrences) continue
      const frequency = documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5))
      const normalization = 1 - BM25_B + BM25_B * (averageLength ? length / averageLength : 0)
      const denominator = occurrences + BM25_K1 * normalization
      if (denominator !== 0) score += (idf * (occurrences * (BM25_K1 + 1))) / denominator
    }
    if (score > 0) scores.set(document.id, score)
  }
  return scores
}

/** Deterministic ranking: score descending, document id ascending. */
function rank(scores: ReadonlyMap<string, number>): Array<{ id: string; score: number; rank: number }> {
  const ordered = [...scores.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1]
    return compareCodePoints(left[0], right[0])
  })
  return ordered.map(([id, score], index) => ({ id, score, rank: index + 1 }))
}

const PY_WHITESPACE = /[ \t\n\r\f\v\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u

/** `" ".join(text.split())` — collapse every whitespace run, Python-style. */
function collapse(text: string): string {
  return text
    .split(PY_WHITESPACE)
    .filter((part) => part !== '')
    .join(' ')
}

/** Code-point index of `needle` in `haystack`, or -1 (Python's `str.find`). */
function findCodePoints(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) return start
  }
  return -1
}

/** A readable window of the indexed text, preferring the first matched term. */
export function excerpt(text: string, terms: readonly string[], length = EXCERPT_LENGTH): string {
  const collapsed = [...collapse(text)]
  if (collapsed.length <= length) return collapsed.join('')
  let position = -1
  for (const term of terms) {
    const found = findCodePoints(collapsed, [...term])
    if (found >= 0 && (position < 0 || found < position)) position = found
  }
  if (position < 0) return `${collapsed.slice(0, length).join('')}…`
  let start = Math.max(0, position - Math.floor(length / 3))
  let end = Math.min(collapsed.length, start + length)
  start = Math.max(0, end - length)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < collapsed.length ? '…' : ''
  return `${prefix}${collapsed.slice(start, end).join('')}${suffix}`
}

function matchedTerms(document: SearchDocument, queryTerms: readonly string[]): string[] {
  return queryTerms
    .filter((term) => document.term_frequencies[term])
    .sort(compareCodePoints)
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

/** `vector_availability()` in a deployment with no embedding endpoint. */
export function vectorAvailability(): Record<string, unknown> {
  return {
    available: false,
    code: VECTOR_NOT_CONFIGURED,
    reason: VECTOR_UNAVAILABLE_REASON,
    model: null,
    dimension: null,
    provider: 'none',
    is_stub: false,
  }
}

function resultItem(
  db: DatabaseSync,
  document: SearchDocument,
  options: {
    keyword: { score: number; rank: number } | null
    vector: { score: number; rank: number } | null
    fusedScore: number
    queryTerms: readonly string[]
  },
): Record<string, unknown> {
  const question =
    document.question_id === null ? null : findOne(db, 'question_bank_question', { id: document.question_id })
  const node =
    document.knowledge_node_id === null
      ? null
      : findOne(db, 'knowledge_node', { id: document.knowledge_node_id })
  const label =
    (question === null ? '' : String(question.display_label ?? '')) ||
    (node === null ? '' : String(node.canonical_name ?? ''))
  const channels: string[] = []
  if (options.keyword !== null) channels.push('keyword')
  if (options.vector !== null) channels.push('vector')
  return {
    document_id: document.id,
    kind: document.kind,
    question_id: document.question_id,
    question_version_id: document.question_version_id,
    knowledge_node_id: document.knowledge_node_id,
    subject_id: document.subject_id === '' ? null : document.subject_id,
    display_label: label,
    excerpt: excerpt(document.text, options.queryTerms),
    keyword_score: options.keyword === null ? null : round6(options.keyword.score),
    keyword_rank: options.keyword === null ? null : options.keyword.rank,
    vector_score: options.vector === null ? null : round6(options.vector.score),
    vector_rank: options.vector === null ? null : options.vector.rank,
    fused_score: round6(options.fusedScore),
    channels,
    matched_terms: matchedTerms(document, options.queryTerms),
  }
}

export interface SearchParams {
  q: string
  subjectId?: string | null
  limit?: number | null
  channel?: string | null
}

/**
 * Retrieve question versions and knowledge nodes for one project.
 *
 * A requested channel that is not configured returns HTTP 200 with an empty `results` list, an
 * explicit `channels.<name>.reason` and a note — the honest reason is more useful to a caller than a
 * generic failure, and the same shape covers "no vectors stored yet".
 */
export function search(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  params: SearchParams,
  _now: Instant,
): Record<string, unknown> {
  const channel = params.channel === null || params.channel === undefined || params.channel === ''
    ? 'hybrid'
    : String(params.channel)
  if (!(SEARCH_CHANNELS as readonly string[]).includes(channel)) {
    throw new InvalidInput('检索通道无效', { details: { channel, allowed: [...SEARCH_CHANNELS] } })
  }
  const project = requireProject(db, userId, projectId)
  const subjectId =
    params.subjectId === null || params.subjectId === undefined || params.subjectId === ''
      ? null
      : String(params.subjectId)
  const subject = subjectId === null ? null : requireSubject(db, userId, String(project.id), subjectId)
  const effectiveLimit = Math.max(1, Math.min(Math.trunc(params.limit ?? DEFAULT_LIMIT), MAX_LIMIT))
  const text = String(params.q ?? '').trim()
  const queryTerms = orderedUnique(tokenize(text))
  const documents = searchableDocuments(db, userId, String(project.id), subject === null ? null : subjectId)
  const byId = new Map(documents.map((document) => [document.id, document]))

  const notes: string[] = []
  if (queryTerms.length === 0) notes.push('查询为空或只包含标点，未产生检索词，因此没有结果。')

  // --- keyword channel (BM25) -------------------------------------------
  const keywordRequested = channel === 'keyword' || channel === 'hybrid'
  const keywordRanked = keywordRequested
    ? rank(bm25Scores(documents, queryTerms))
    : []
  const keywordPositions = new Map(keywordRanked.map((entry) => [entry.id, { score: entry.score, rank: entry.rank }]))

  // --- vector channel (unavailable in DSH) ------------------------------
  const vectorRequested = channel === 'vector' || channel === 'hybrid'
  const availability = vectorAvailability()
  const vectorStatus: Record<string, unknown> = {
    requested: vectorRequested,
    used: false,
    available: availability.available,
    code: availability.code,
    reason: availability.reason,
    model: availability.model,
    dimension: availability.dimension,
    provider: availability.provider,
    is_stub: availability.is_stub,
    hits: 0,
    compared: 0,
    documents_with_embeddings: documents.filter((document) => document.embedding !== null).length,
    skipped_missing_embedding: 0,
    skipped_vector_mismatch: 0,
    skipped_non_positive: 0,
  }
  if (vectorRequested) {
    notes.push(`向量通道不可用，未参与排序：${String(availability.reason)}`)
  }
  if (channel === 'vector') {
    notes.push(
      `已请求仅向量通道，但该通道没有可用结果，因此 results 为空：${String(availability.reason)}`,
    )
  }

  // --- fusion -----------------------------------------------------------
  const fused = new Map<string, number>()
  const contribute = (positions: Map<string, { score: number; rank: number }>): void => {
    for (const [documentId, position] of positions) {
      fused.set(documentId, (fused.get(documentId) ?? 0) + 1 / (RRF_K + position.rank))
    }
  }
  // Keyword positions join the fusion for both keyword-only and hybrid requests; the vector channel
  // contributes nothing while it is unconfigured, which is why hybrid degrades to keyword ranking.
  contribute(keywordPositions)
  const orderedIds = [...fused.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return compareCodePoints(left[0], right[0])
    })
    .slice(0, effectiveLimit)
    .map(([documentId]) => documentId)
  const results = orderedIds.map((documentId) =>
    resultItem(db, byId.get(documentId)!, {
      keyword: keywordPositions.get(documentId) ?? null,
      vector: null,
      fusedScore: fused.get(documentId)!,
      queryTerms,
    }),
  )

  return {
    project_id: String(project.id),
    subject_id: subject === null ? null : String(subject.id),
    query: text,
    query_tokens: queryTerms,
    channel,
    limit: effectiveLimit,
    candidate_documents: documents.length,
    tokenizer_version: TOKENIZER_VERSION,
    fusion: channel === 'hybrid' ? { method: 'rrf', k: RRF_K } : null,
    channels: {
      keyword: {
        requested: keywordRequested,
        used: keywordRanked.length > 0,
        available: true,
        reason: queryTerms.length > 0 ? null : '查询为空或只包含标点，未产生检索词',
        documents_scored: documents.length,
        hits: keywordRanked.length,
        k1: BM25_K1,
        b: BM25_B,
      },
      vector: vectorStatus,
    },
    notes,
    results,
  }
}

/**
 * Rebuild the index of one project (optionally one subject) and count it.
 *
 * `indexed`/`excluded` partition every row this run wrote: excluded rows are drafts, withdrawn
 * versions, holdout families or out-of-project targets, and each one stores its reason. Excluded
 * rows are still written, so an exclusion is visible instead of being indistinguishable from
 * "never seen". `embeddings` is always 0 here and the reason says exactly why.
 */
export function reindexProject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string | null | undefined,
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const subject =
    subjectId === null || subjectId === undefined || subjectId === ''
      ? null
      : requireSubject(db, userId, String(project.id), String(subjectId))
  const targetSubject = subject === null ? null : String(subject.id)

  const versionIds: string[] = []
  for (const version of findRows(db, 'question_bank_question_version', {})) {
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
    if (question === null) continue
    const questionSubject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
    if (questionSubject === null || String(questionSubject.project_id) !== String(project.id)) continue
    if (targetSubject !== null && String(questionSubject.id) !== targetSubject) continue
    versionIds.push(String(version.id))
  }
  versionIds.sort(compareCodePoints)
  const nodeIds: string[] = []
  for (const node of findRows(db, 'knowledge_node', {})) {
    const syllabus = findOne(db, 'exams_syllabus_version', { id: String(node.syllabus_version_id) })
    if (syllabus === null) continue
    const nodeSubject = findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
    if (nodeSubject === null || String(nodeSubject.project_id) !== String(project.id)) continue
    if (targetSubject !== null && String(nodeSubject.id) !== targetSubject) continue
    nodeIds.push(String(node.id))
  }
  nodeIds.sort(compareCodePoints)

  let indexed = 0
  let excluded = 0
  for (const versionId of versionIds) {
    const document = indexQuestionVersion(db, versionId, now)
    if (document.is_searchable === true) indexed += 1
    else excluded += 1
  }
  for (const nodeId of nodeIds) {
    const document = indexKnowledgeNode(db, nodeId, now)
    if (document.is_searchable === true) indexed += 1
    else excluded += 1
  }

  const inIndex = findRows(db, 'search_document', { project_id: String(project.id) }).filter(
    (document) => targetSubject === null || String(document.subject_id) === targetSubject,
  )
  return {
    project_id: String(project.id),
    subject_id: subject === null ? null : String(subject.id),
    indexed,
    excluded,
    embeddings: 0,
    embedding_unavailable_reason: VECTOR_UNAVAILABLE_REASON,
    embedding_model: null,
    documents_total: versionIds.length + nodeIds.length,
    documents_in_index: inIndex.length,
    tokenizer_version: TOKENIZER_VERSION,
  }
}

/** Count helper kept next to the writer, so a report cannot disagree with the table. */
export function documentCount(db: DatabaseSync, projectId: string): number {
  return countRows(db, 'search_document', { project_id: projectId })
}
