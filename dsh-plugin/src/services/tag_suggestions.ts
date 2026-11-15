/**
 * Machine-proposed knowledge tags that only a human can make effective (acceptance B04).
 *
 * Port of `backend/apps/knowledge/services/suggestions.py`. The acceptance rule is strict in both
 * directions:
 *
 *  * **a suggestion never edits the controlled vocabulary.** Names are copied verbatim from the
 *    subject's own published syllabus; unknown names are reported, never created on the fly, and the
 *    node list is untouched by every path here;
 *  * **accepting only writes an auxiliary mapping.** The accepted names become a *new* mapping
 *    revision with weight 0 through the ordinary mapping service; the primary scoring mapping stays
 *    a human decision and earlier revisions stay readable.
 *
 * Without a configured model the call fails loudly (`ai_not_configured`, 503). There is no stub
 * provider in this package: a fabricated proposal would be indistinguishable from a real one in the
 * review UI, which is exactly the failure R-INV 4 forbids.
 */
import type { DatabaseSync } from 'node:sqlite'
import { SUGGEST_TAGS_PROMPT_VERSION, buildTagSuggestionPrompt } from '../ai/prompts.ts'
import { markSucceeded, newLlmRun } from '../ai/audit.ts'
import { validateTagSuggestions } from '../ai/validators.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import type { LlmPort } from '../llm/contract.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { persistRun, telemetryOf } from './ai_runs.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import { requireProject } from './exams.ts'
import { replaceKnowledgeMappings } from './mappings.ts'
import { compareText } from './knowledge_extra.ts'

type Row = Record<string, unknown>

const STATUS_PROPOSED = 'proposed'
const STATUS_ACCEPTED = 'accepted'
const STATUS_REJECTED = 'rejected'
const STATUS_SUPERSEDED = 'superseded'

/** The audit row's reason when the capability is simply not declared (Django's `error_message`). */
/** Python's canonical text when no model can serve the call; kept verbatim for the API. */
export const TAG_SUGGESTION_UNCONFIGURED = '未配置可用的文本模型，无法生成标签建议'

/** A provider failure the HTTP layer maps onto 503 (`providers.AiUnavailable`/`AiError`). */
export class TagSuggestionProviderFailure extends Error {
  readonly failureCode: string
  readonly unavailable: boolean
  constructor(message: string, options: { code: string; unavailable: boolean }) {
    super(message)
    this.name = 'TagSuggestionProviderFailure'
    this.failureCode = options.code
    this.unavailable = options.unavailable
  }
}

/* ------------------------------------------------------------------ texts */

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Python truthiness for the block payload. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0
  return true
}

/** Python `str(value)` for the block fields (a `null` text becomes `None`). */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  return String(value)
}

/**
 * `_blocks_text`: list blocks expand their items; otherwise the first of text/latex/value that is
 * truthy wins. Parts are stripped and empty ones disappear from the join.
 *
 * This is *not* the prompt builder's `blocks_text` (that one formats math), so it is kept local.
 */
export function suggestionBlocksText(blocks: unknown): string {
  const parts: string[] = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!isRecord(block)) continue
    if (block['kind'] === 'list') {
      const items = Array.isArray(block['items']) ? (block['items'] as unknown[]) : []
      parts.push(...items.map((item) => pyStr(item)))
      continue
    }
    for (const key of ['text', 'latex', 'value']) {
      if (pyTruthy(block[key])) {
        parts.push(pyStr(block[key]))
        break
      }
    }
  }
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')
}

export interface VersionTexts {
  stem: string
  options: string[]
  material: string
}

/** `version_texts`: stem, option texts and material text — never the answer or the rubric. */
export function versionTexts(db: DatabaseSync, version: Row): VersionTexts {
  const content = isRecord(version.content) ? version.content : {}
  const stem = suggestionBlocksText(content['blocks'])
  const optionRows = Array.isArray(content['options']) ? (content['options'] as unknown[]) : []
  const options = optionRows.filter(isRecord).map((option) => suggestionBlocksText(option['blocks']))
  let material = ''
  const parentId = version.parent_material_version_id
  if (parentId !== null && parentId !== undefined) {
    const parent = findOne(db, 'question_bank_question_version', { id: String(parentId) })
    if (parent !== null) {
      const parentContent = isRecord(parent.content) ? parent.content : {}
      material = suggestionBlocksText(parentContent['blocks'])
    }
  } else if (version.question_type === 'material') {
    material = stem
  }
  return { stem, options: options.filter((text) => text.length > 0), material }
}

/* -------------------------------------------------------------- vocabulary */

/** `allowed_nodes`: the subject's published syllabi, in outline order. */
export function allowedNodes(db: DatabaseSync, subjectId: string): Row[] {
  const publishedSyllabi = new Set(
    findRows(db, 'exams_syllabus_version', { subject_id: subjectId, status: 'published' }).map((syllabus) =>
      String(syllabus.id),
    ),
  )
  return findRows(db, 'knowledge_node', {})
    .filter((node) => publishedSyllabi.has(String(node.syllabus_version_id)))
    .sort((left, right) => {
      const bySyllabus = compareText(String(left.syllabus_version_id), String(right.syllabus_version_id))
      if (bySyllabus !== 0) return bySyllabus
      const byOrder = Number(left.display_order) - Number(right.display_order)
      return byOrder !== 0 ? byOrder : compareText(String(left.canonical_name), String(right.canonical_name))
    })
}

/**
 * `resolve_node_names`: map proposed names onto existing nodes; unknown names are returned as-is.
 *
 * Matching is deliberately literal (canonical name, an alias, or the node code) so a near-miss
 * cannot silently attach the wrong knowledge point.
 */
export function resolveNodeNames(
  db: DatabaseSync,
  subjectId: string,
  names: readonly string[],
): { resolved: Map<string, Row>; unresolved: string[] } {
  const nodes = allowedNodes(db, subjectId)
  const canonical = new Map<string, Row>()
  const byAlias = new Map<string, Row>()
  const byCode = new Map<string, Row>()
  for (const node of nodes) {
    canonical.set(String(node.canonical_name).trim(), node)
    const aliases = Array.isArray(node.aliases) ? (node.aliases as unknown[]) : []
    for (const alias of aliases) {
      const key = String(alias).trim()
      if (!byAlias.has(key)) byAlias.set(key, node)
    }
    const code = String(node.code ?? '')
    if (code !== '' && !byCode.has(code.trim())) byCode.set(code.trim(), node)
  }
  const resolved = new Map<string, Row>()
  const unresolved: string[] = []
  for (const raw of names) {
    const name = String(raw ?? '').trim()
    if (name === '') continue
    const node = canonical.get(name) ?? byAlias.get(name) ?? byCode.get(name)
    if (node === undefined) unresolved.push(name)
    else resolved.set(name, node)
  }
  return { resolved, unresolved }
}

/* -------------------------------------------------------------- projection */

/** `mapping_summary`: the latest mapping revision, for the review UI. */
export function mappingContext(db: DatabaseSync, versionId: string): Row[] {
  const rows = findRows(db, 'knowledge_question_mapping', { question_version_id: versionId })
  if (rows.length === 0) return []
  const latest = rows.reduce((highest, row) => Math.max(highest, Number(row.mapping_revision)), 0)
  return rows
    .filter((row) => Number(row.mapping_revision) === latest)
    .map((row) => {
      const node = findOne(db, 'knowledge_node', { id: String(row.node_id) })
      return {
        node_id: String(row.node_id),
        node_name: node === null ? '' : String(node.canonical_name),
        weight: String(row.score_weight),
        is_primary: Boolean(row.is_primary),
      }
    })
    .sort((left, right) => compareText(String(left.node_name), String(right.node_name)))
}

/** `TagSuggestionOut`: the whole review row, including what the mappings currently say. */
export function suggestionOut(db: DatabaseSync, suggestion: Row): Row {
  const version = findOne(db, 'question_bank_question_version', { id: String(suggestion.question_version_id) })
  const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
  return {
    id: String(suggestion.id),
    project_id: String(suggestion.project_id),
    question_version_id:
      version === null ? String(suggestion.question_version_id) : String(version.id),
    question_label: question === null ? '' : String(question.display_label),
    status: suggestion.status,
    proposals: suggestion.proposals ?? [],
    model_identifier: suggestion.model_identifier,
    prompt_version: suggestion.prompt_version,
    is_stub: Boolean(suggestion.is_stub),
    created_at: formatPythonIso(suggestion.created_at as Instant),
    decided_at: suggestion.decided_at === null ? null : formatPythonIso(suggestion.decided_at as Instant),
    accepted_mapping_revision: suggestion.accepted_mapping_revision,
    unresolved_names: suggestion.unresolved_names ?? [],
    decision_note: suggestion.decision_note,
    latest_mappings: mappingContext(db, String(suggestion.question_version_id)),
  }
}

/** `_require_version`: the version has to belong to the project the caller scoped to. */
export function requireVersion(db: DatabaseSync, userId: string, projectId: string, versionId: string): Row {
  const project = requireProject(db, userId, projectId)
  const version = findOne(db, 'question_bank_question_version', { id: versionId })
  const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (version === null || question === null || subject === null || String(subject.project_id) !== String(project.id)) {
    throw new ScopeViolation('题目版本不存在或不属于该项目')
  }
  return version
}

/** Every suggestion of one version, newest first, capped at 50 like `queryset[:50]`. */
export function listTagSuggestions(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  versionId: string,
): Row[] {
  const version = requireVersion(db, userId, projectId, versionId)
  return findRows(db, 'knowledge_tag_suggestion', { question_version_id: version.id })
    .sort((left, right) => {
      const byCreated = Number(right.created_at) - Number(left.created_at)
      return byCreated !== 0 ? byCreated : compareText(String(right.id), String(left.id))
    })
    .slice(0, 50)
    .map((suggestion) => suggestionOut(db, suggestion))
}

/* ------------------------------------------------------------------ create */

export interface ProposeTagsInput {
  projectId: string
  version: Row
  actorId: string
  port: LlmPort
}

/**
 * `propose_tags`: ask the configured provider for tag candidates for one version.
 *
 * The run row is created **before** the call (Django's `_start_run`), so an unavailable provider still
 * leaves an honest audit row — and the same row is updated afterwards, never a second one.
 */
export async function proposeTags(db: DatabaseSync, input: ProposeTagsInput, now: Instant): Promise<Row> {
  const version = input.version
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  if (question === null) throw new ScopeViolation('题目版本不存在或不属于该项目')
  const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (subject === null) throw new ScopeViolation('题目版本不存在或不属于该项目')

  // Python's `propose_tags` is one `@transaction.atomic` block, so a raised provider failure rolls
  // its `llm_run` row back: a *refused* suggestion leaves no audit row at all (probe A02 records
  // `row_delta: {}`). The run row is therefore written after the call, and no row exists for a call
  // that never produced an outcome — "we tried" is the response's `ai_not_configured`, not a claim.
  const runContext = {
    userId: input.actorId,
    projectId: input.projectId,
    requestSummary: {
      question_version_id: String(version.id),
      question_type: version.question_type,
      subject_id: String(question.subject_id),
    },
    inputSnapshot: { content_digest: version.content_digest },
  }

  const availability = await input.port.availability()
  const capability = availability.suggest_tags
  if (capability === undefined || !capability.available) {
    const reason = capability?.reason ?? 'ai_not_configured'
    throw new TagSuggestionProviderFailure(TAG_SUGGESTION_UNCONFIGURED, { code: reason, unavailable: true })
  }

  const nodes = allowedNodes(db, String(subject.id))
  const allowedNames = nodes.map((node) => String(node.canonical_name))
  const texts = versionTexts(db, version)
  const prompt = buildTagSuggestionPrompt({
    subject_name: subject.name,
    stem_text: texts.stem,
    option_texts: texts.options,
    allowed_node_names: allowedNames,
    material_text: texts.material,
  })
  const request = {
    capability: 'suggest_tags' as const,
    promptVersion: SUGGEST_TAGS_PROMPT_VERSION,
    system: '',
    prompt,
    timeoutMs: 90_000,
  }
  const result = await input.port.run(request)
  if (!result.ok) {
    throw new TagSuggestionProviderFailure(`模型调用失败：${result.code}`, {
      code: result.code,
      unavailable: false,
    })
  }

  const [clean, problems] = validateTagSuggestions(
    safeJson(result.text),
    { allowed_node_names: new Set(allowedNames) },
  )
  // A validator problem does not discard the proposal: Django stores `succeeded` with the problems
  // recorded, and only the clean names become proposals. The row is written after the call, in one
  // insert, so it carries the provider/model that actually answered and never a partial row.
  const record = markSucceeded(
    newLlmRun({
      provider: result.route.provider,
      model_identifier: result.route.model,
      capability: 'suggest_tags',
      prompt_version: SUGGEST_TAGS_PROMPT_VERSION,
      request_summary: runContext.requestSummary,
      input_snapshot: runContext.inputSnapshot,
      user_id: input.actorId,
      project_id: input.projectId,
    }),
    telemetryOf(result),
    { accepted: clean.length, problems },
  )
  const runRow = transaction(db, () => persistRun(db, record, now))

  return transaction(db, () => {
    // A new proposal supersedes older pending ones: only one is actionable.
    for (const stale of findRows(db, 'knowledge_tag_suggestion', {
      question_version_id: version.id,
      status: STATUS_PROPOSED,
    })) {
      updateRow(db, 'knowledge_tag_suggestion', stale.id, { status: STATUS_SUPERSEDED }, { now })
    }
    return insertRow(
      db,
      'knowledge_tag_suggestion',
      {
        project_id: input.projectId,
        question_version_id: version.id,
        run_id: runRow.id,
        status: STATUS_PROPOSED,
        proposals: clean,
        model_identifier: result.route.model,
        prompt_version: SUGGEST_TAGS_PROMPT_VERSION,
        is_stub: false,
        accepted_mapping_revision: null,
        unresolved_names: [],
        decided_by_id: null,
        decided_at: null,
        decision_note: '',
        created_by_id: input.actorId,
      },
      { now },
    )
  })
}

/** The model's text as JSON, or `null` (the validator turns that into a problem, not a crash). */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ decide */

/** `require_suggestion`: the suggestion has to belong to the scoped project. */
export function requireSuggestion(db: DatabaseSync, userId: string, projectId: string, suggestionId: string): Row {
  const project = requireProject(db, userId, projectId)
  const suggestion = findOne(db, 'knowledge_tag_suggestion', { id: suggestionId, project_id: project.id })
  if (suggestion === null) throw new ScopeViolation('标签建议不存在或不属于该项目')
  return suggestion
}

/**
 * `accept_suggestion`: turn accepted names into a **new auxiliary mapping revision**.
 *
 * Every refusal below protects the same invariant: an accepted tag may add weight-0 context, but it
 * may never invent a knowledge point, re-point the primary scoring mapping, or rewrite an earlier
 * revision.
 */
export function acceptSuggestion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  suggestionId: string,
  payload: { node_names?: string[] | null; note?: string },
  now: Instant,
): Row {
  const suggestion = requireSuggestion(db, userId, projectId, suggestionId)
  if (suggestion.status !== STATUS_PROPOSED) {
    throw new InvalidInput('该建议已被处理，不能重复采纳', { details: { status: suggestion.status } })
  }
  const version = findOne(db, 'question_bank_question_version', { id: String(suggestion.question_version_id) })
  if (version === null) throw new ScopeViolation('题目版本不存在或不属于该项目')
  if (version.status !== 'published') {
    throw new InvalidInput('只能为已发布版本采纳标签建议；请先发布题目版本')
  }
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  if (question === null) throw new ScopeViolation('题目版本不存在或不属于该项目')
  const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (subject === null) throw new ScopeViolation('题目版本不存在或不属于该项目')

  const requestedRaw = payload.node_names ?? ((suggestion.proposals ?? []) as Row[]).map((row) => row['name'])
  const requested = (requestedRaw as unknown[])
    .map((name) => String(name ?? ''))
    .filter((name) => name.trim() !== '')
  if (requested.length === 0) {
    throw new InvalidInput('没有可采纳的标签：建议为空或未选择任何名称')
  }
  const { resolved, unresolved } = resolveNodeNames(db, String(subject.id), requested)
  if (resolved.size === 0) {
    throw new InvalidInput('没有名称能匹配当前大纲中的考点；标签建议不能创建新考点，请人工建立映射', {
      details: { unresolved_names: unresolved },
    })
  }

  const mappingRows = findRows(db, 'knowledge_question_mapping', { question_version_id: version.id })
  const latestRevision =
    mappingRows.length === 0 ? null : mappingRows.reduce((highest, row) => Math.max(highest, Number(row.mapping_revision)), 0)
  const currentRows =
    latestRevision === null
      ? []
      : mappingRows
          .filter((row) => Number(row.mapping_revision) === latestRevision)
          .map((row) => ({ row, node: findOne(db, 'knowledge_node', { id: String(row.node_id) }) }))
          .sort((left, right) =>
            compareText(
              left.node === null ? '' : String(left.node.canonical_name),
              right.node === null ? '' : String(right.node.canonical_name),
            ),
          )
  if (!currentRows.some((entry) => entry.row.is_primary === true)) {
    throw new InvalidInput(
      '该题目还没有主要考点映射：标签建议只作为辅助标签，请先人工建立权重合计为 1 的主考点',
      { details: { latest_revision: latestRevision } },
    )
  }

  const existingNodeIds = new Set(currentRows.map((entry) => String(entry.row.node_id)))
  const mappings: { node_id: string; is_primary: boolean; score_weight: string; template_id: string | null; note: string }[] =
    currentRows.map((entry) => ({
      node_id: String(entry.row.node_id),
      is_primary: Boolean(entry.row.is_primary),
      score_weight: String(entry.row.score_weight),
      template_id: entry.row.template_id === null ? null : String(entry.row.template_id),
      note: String(entry.row.note ?? ''),
    }))
  const added: string[] = []
  for (const [name, node] of resolved) {
    if (existingNodeIds.has(String(node.id))) {
      unresolved.push(`${name}（已映射，未重复添加）`)
      continue
    }
    mappings.push({
      node_id: String(node.id),
      is_primary: false,
      score_weight: '0',
      template_id: null,
      note: `标签建议采纳（${suggestion.prompt_version || 'unknown'}）`.slice(0, 300),
    })
    added.push(name)
  }
  if (added.length === 0) {
    throw new InvalidInput('所有建议的考点都已映射，没有新增内容', { details: { duplicates: unresolved } })
  }

  return transaction(db, () => {
    const rows = replaceKnowledgeMappings(db, projectId, String(version.id), mappings, { actorId: userId, now })
    const revision = rows.length === 0 ? null : Number(rows[0].mapping_revision)
    const updated = updateRow(
      db,
      'knowledge_tag_suggestion',
      suggestion.id,
      {
        status: STATUS_ACCEPTED,
        accepted_mapping_revision: revision,
        unresolved_names: unresolved,
        decided_by_id: userId,
        decided_at: now,
        decision_note: String(payload.note ?? '').slice(0, 500),
      },
      { now },
    )!
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'tag_suggestion',
        entity_id: String(suggestion.id),
        action: 'accepted',
        project_id: projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: {
          question_version_id: String(version.id),
          mapping_revision: revision,
          added,
          unresolved,
        },
      },
      { now },
    )
    return {
      suggestion_id: String(updated.id),
      status: updated.status,
      mapping_revision: revision,
      added_node_names: added,
      unresolved_names: unresolved,
    }
  })
}

/** `reject_suggestion`: record the decision; no mapping is written. */
export function rejectSuggestion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  suggestionId: string,
  payload: { note?: string },
  now: Instant,
): Row {
  const suggestion = requireSuggestion(db, userId, projectId, suggestionId)
  if (suggestion.status !== STATUS_PROPOSED) {
    throw new InvalidInput('该建议已被处理，不能重复否决', { details: { status: suggestion.status } })
  }
  const updated = updateRow(
    db,
    'knowledge_tag_suggestion',
    suggestion.id,
    {
      status: STATUS_REJECTED,
      decided_by_id: userId,
      decided_at: now,
      decision_note: String(payload.note ?? '').slice(0, 500),
    },
    { now },
  )!
  return suggestionOut(db, updated)
}
