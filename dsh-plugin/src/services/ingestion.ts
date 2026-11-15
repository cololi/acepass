/**
 * Ingestion core: source documents, import jobs, candidates and proofreading.
 *
 * Port of `backend/apps/ingestion/services/core.py` (the parts B1 needs) plus the two serializers
 * `job_summary` / `candidate_summary` from `services/imports.py`.
 *
 * The rules that are easy to "improve" and must not be:
 * - a candidate's `review_issues` are *replaced* on every refresh, never appended to the parser's
 *   `parse_issues`; the issue order is the Python emission order because the proofreading UI shows
 *   the first blocking problem;
 * - `maybe_complete_job` reports `awaiting_review` even for a job with zero candidates (an empty
 *   paste is a finished *review* task, not a completed import);
 * - `update_candidate` snapshots the **pre-refresh** issues into `CandidateRevision`, so "what the
 *   reviewer saw" stays reproducible after the draft changes.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { validateContent, type ContentIssue } from '../ai/content.ts'
import { pyOr, pyStr, pyTruthy } from '../ai/pyvalue.ts'
import { layoutReviewIssues } from '../domain/ingestion/layout.ts'
import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { pyStrip } from '../domain/pytext.ts'
import { transaction } from '../store/db.ts'
import { findOne, findRows, getRow, insertRow, updateRow, type Row } from '../store/repository.ts'
import { InvalidInput, ScopeViolation, StructureInvalid, VersionConflict } from './errors.ts'
import { variantReviewIssues } from './variants.ts'

export type Issue = ContentIssue | Record<string, unknown>

const STATUS_PUBLISHED = 'published'
const STATUS_IGNORED = 'ignored'
const STATUS_DRAFT = 'draft'
const STATUS_READY = 'ready'
const JOB_FAILED = 'failed'
const JOB_CANCELLED = 'cancelled'
const JOB_COMPLETED = 'completed'
const JOB_AWAITING_REVIEW = 'awaiting_review'

const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice'])
const MATERIAL = 'material'

/** `hashlib.sha256(bytes).hexdigest()`. */
export function fileChecksum(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Python truthiness for the JSON-shaped payload values this module reads. */
function truthy(value: unknown): boolean {
  return pyTruthy(value)
}

/**
 * Structural JSON equality, matching Postgres `jsonb` `=` (key order is irrelevant, array order is
 * not, `1` and `1.0` are the same number). The duplicate checks are exact-value lookups in Django;
 * comparing serialized text would make `{"a":1,"b":2}` differ from `{"b":2,"a":1}` and turn a
 * warning into silence.
 */
export function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b))
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonValueEqual(item, b[index]))
  }
  const left = asRecord(a)
  const right = asRecord(b)
  if (left === null || right === null) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false
    if (!jsonValueEqual(left[key], right[key])) return false
  }
  return true
}

/** `int(value)` for the small set of payload fields Python converts this way. */
function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^[+-]?\d+$/.test(text)) return Number(text)
  }
  throw new Error(`invalid literal for int(): ${String(value)}`)
}

// --------------------------------------------------------------------------
// Scope helpers
// --------------------------------------------------------------------------

/** `ImportJob.objects.filter(id=..., project=..., created_by=...).first()` → 404 when absent. */
export function requireJob(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  jobId: string,
): Row {
  const job = findOne(db, 'ingestion_import_job', { id: jobId, project_id: projectId, created_by_id: userId })
  if (job === null) throw new ScopeViolation('导入任务不存在或不属于该项目')
  return job
}

/** `ImportCandidate.objects.filter(id=..., project=..., job__created_by=...).first()` → 404. */
export function requireCandidate(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  candidateId: string,
): Row {
  const hit = db
    .prepare(
      `SELECT c."id" AS id FROM "ingestion_import_candidate" c
         JOIN "ingestion_import_job" j ON j."id" = c."job_id"
        WHERE c."id" = ? AND c."project_id" = ? AND j."created_by_id" = ?`,
    )
    .get(candidateId, projectId, userId) as { id: string } | undefined
  if (hit === undefined) throw new ScopeViolation('候选不存在或不属于该项目')
  return getRow(db, 'ingestion_import_candidate', hit.id)!
}

// --------------------------------------------------------------------------
// Source documents
// --------------------------------------------------------------------------

export interface TextDocumentInput {
  ownerId: string
  projectId: string
  subjectId: string | null
  text: string
  title?: string
  sourceNote?: string
  usageScope?: string
}

/** `create_text_document`: pasted text always creates a document holding the raw original. */
export function createTextDocument(db: DatabaseSync, input: TextDocumentInput, now: Instant): Row {
  if (pyStrip(input.text) === '') throw new InvalidInput('文本内容不能为空')
  return insertRow(
    db,
    'ingestion_source_document',
    {
      owner_id: input.ownerId,
      project_id: input.projectId,
      subject_id: input.subjectId,
      title: pyCodePointSlice(input.title ?? '', 0, 300),
      document_type: 'text',
      role: 'past_paper_page',
      sensitivity: 'public_to_owner',
      asset_id: null,
      raw_text: input.text,
      page_texts: [],
      checksum: fileChecksum(Buffer.from(input.text, 'utf8')),
      source_type: 'user_paste',
      source_note: pyCodePointSlice(input.sourceNote ?? '', 0, 500),
      usage_scope: pyCodePointSlice(input.usageScope ?? '', 0, 200),
      page_count: 1,
    },
    { now },
  )
}

// --------------------------------------------------------------------------
// Import jobs
// --------------------------------------------------------------------------

export interface ImportJobInput {
  ownerId: string
  projectId: string
  subjectId: string | null
  inputKind: string
  inputText?: string
  documents?: Row[]
  extractorVersion?: string
}

/**
 * `create_import_job`: fingerprints the input, then records the earliest historical job with the
 * same fingerprint as `duplicate_of`. It never blocks or reuses the old job — the warning is a
 * proposal for the human, and "won't double count" is enforced later by the publish gate.
 */
export function createImportJob(db: DatabaseSync, input: ImportJobInput, now: Instant): Row {
  const documents = input.documents ?? []
  for (const document of documents) {
    if (String(document.project_id) !== String(input.projectId)) {
      throw new ScopeViolation('来源文档不属于该项目')
    }
  }
  const inputText = input.inputText ?? ''
  const fingerprintSource =
    inputText !== ''
      ? Buffer.from(inputText, 'utf8')
      : Buffer.concat(documents.map((document) => Buffer.from(String(document.checksum), 'utf8')))
  const fingerprint = fileChecksum(
    fingerprintSource.length > 0 ? fingerprintSource : Buffer.from(String(input.projectId), 'utf8'),
  )
  let job = insertRow(
    db,
    'ingestion_import_job',
    {
      project_id: input.projectId,
      subject_id: input.subjectId,
      created_by_id: input.ownerId,
      status: 'queued',
      input_kind: input.inputKind,
      input_text: inputText,
      extractor_version: input.extractorVersion ?? 'manual-v1',
      progress_percent: 0,
      problems: [],
      page_diagnostics: [],
      attempts: 0,
      max_attempts: 3,
      last_error: '',
      input_fingerprint: fingerprint,
      duplicate_of_id: null,
      started_at: null,
      finished_at: null,
    },
    { now },
  )
  // Django's `job.documents.set(documents)` collapses a repeated document to one M2M row, and the
  // table's unique constraint says the same. The *fingerprint* above deliberately still counts a
  // repeated checksum twice, because Python joins the list it was handed.
  const linked = new Set<string>()
  for (const document of documents) {
    const documentId = String(document.id)
    if (linked.has(documentId)) continue
    linked.add(documentId)
    insertRow(db, 'ingestion_import_job_documents', {
      importjob_id: job.id,
      sourcedocument_id: documentId,
    })
  }
  const previous = findRows(
    db,
    'ingestion_import_job',
    { project_id: input.projectId, input_fingerprint: fingerprint },
    { orderBy: [['created_at', 'asc']] },
  ).find((candidate) => String(candidate.id) !== String(job.id))
  if (previous !== undefined) {
    job = updateRow(
      db,
      'ingestion_import_job',
      job.id,
      {
        duplicate_of_id: previous.id,
        problems: [
          {
            code: 'duplicate_input',
            message: '检测到相同输入的历史导入任务，请确认是复用还是新建题库（不会自动重复计入真实试卷）',
            severity: 'warning',
            duplicate_job_id: String(previous.id),
          },
        ],
      },
      { now },
    )!
  }
  return job
}

// --------------------------------------------------------------------------
// Source regions
// --------------------------------------------------------------------------

export interface SourceRegionInput {
  documentId: string
  pageIndex?: number
  x: number
  y: number
  width: number
  height: number
  role?: string
  textSpan?: string
}

/**
 * `create_source_region` including the model's `full_clean`.
 *
 * The reachable failure in the text path is the bbox overflow at segment index ≥ 20:
 * `y = min(.99, index * .05)`, `height = .05` → `y + height > 1.0001` raises
 * `ValidationError({"width": "区域超出页面范围"})`, which the API maps to 422 `structure_invalid`
 * and which rolls the whole batch back. The port keeps that behaviour instead of clamping.
 */
export function createSourceRegion(db: DatabaseSync, input: SourceRegionInput, now: Instant): Row {
  const pageIndex = input.pageIndex ?? 1
  const errors: Record<string, string[]> = {}
  // Django's zh-hans validator messages; `full_clean` collects field errors before `clean()`.
  const rangeError = (value: number): string[] =>
    value < 0 ? ['确保这个值大于或等于 0。'] : ['确保这个值小于或等于 1。']
  if (!(input.x >= 0 && input.x <= 1)) errors.x = rangeError(input.x)
  if (!(input.y >= 0 && input.y <= 1)) errors.y = rangeError(input.y)
  if (!(input.width >= 0 && input.width <= 1)) errors.width = rangeError(input.width)
  if (!(input.height >= 0 && input.height <= 1)) errors.height = rangeError(input.height)
  if (pageIndex < 1) errors.page_index = ['确保这个值大于或等于 1。']
  if (Object.keys(errors).length === 0 && input.x + input.width > 1.0001) errors.width = ['区域超出页面范围']
  if (Object.keys(errors).length === 0 && input.y + input.height > 1.0001) errors.width = ['区域超出页面范围']
  if (Object.keys(errors).length > 0) {
    throw new StructureInvalid('结构校验失败', { details: { errors } })
  }
  return insertRow(
    db,
    'ingestion_source_region',
    {
      document_id: input.documentId,
      page_index: pageIndex,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      crop_asset_id: null,
      role: input.role ?? 'stem_crop',
      text_span: input.textSpan ?? '',
      char_start: null,
      char_end: null,
    },
    { now },
  )
}

// --------------------------------------------------------------------------
// Candidates
// --------------------------------------------------------------------------

export interface CandidateInput {
  job: Row
  payload: Record<string, unknown>
  subjectId?: string | null
  machinePayload?: Record<string, unknown> | null
  regionIds?: string[]
  isStubOutput?: boolean
  extractorVersion?: string
  parentCandidateId?: string | null
  sourcePositionKey?: string
  paperRevisionId?: string | null
  answerMatch?: Record<string, unknown> | null
}

export function createCandidate(db: DatabaseSync, input: CandidateInput, now: Instant): Row {
  const job = input.job
  // Python `subject = subject or job.subject`: a falsy subject falls back to the job's subject.
  const subjectId = truthy(input.subjectId)
    ? String(input.subjectId)
    : job.subject_id === null
      ? null
      : String(job.subject_id)
  let candidate = insertRow(
    db,
    'ingestion_import_candidate',
    {
      job_id: job.id,
      project_id: job.project_id,
      subject_id: subjectId,
      parent_candidate_id: input.parentCandidateId ?? null,
      source_position_key: pyCodePointSlice(input.sourcePositionKey ?? '', 0, 40),
      paper_revision_id: input.paperRevisionId ?? null,
      answer_match: input.answerMatch ?? {},
      status: STATUS_DRAFT,
      revision: 1,
      draft_payload: input.payload,
      // Python `machine_payload or payload`: an empty machine payload falls back to the draft.
      machine_payload: truthy(input.machinePayload) ? input.machinePayload : input.payload,
      review_issues: [],
      extractor_version: input.extractorVersion || String(job.extractor_version ?? ''),
      is_stub_output: input.isStubOutput ?? false,
      duplicate_of_candidate_id: null,
      reviewed_by_id: null,
      reviewed_at: null,
      layout_review_confirmed_at: null,
      layout_review_note: '',
      publication_question_id: null,
      publication_version_id: null,
      publication_paper_item_id: null,
    },
    { now },
  )
  for (const regionId of input.regionIds ?? []) {
    const region = getRow(db, 'ingestion_source_region', regionId)
    if (region === null) throw new ScopeViolation('来源区域不属于该项目')
    const document = getRow(db, 'ingestion_source_document', region.document_id)
    if (document === null || String(document.project_id) !== String(job.project_id)) {
      throw new ScopeViolation('来源区域不属于该项目')
    }
    insertRow(db, 'ingestion_import_candidate_source_regions', {
      importcandidate_id: candidate.id,
      sourceregion_id: region.id,
    })
  }
  refreshCandidateIssues(db, candidate, now)
  return getRow(db, 'ingestion_import_candidate', candidate.id)!
}

// --------------------------------------------------------------------------
// Issue refresh (the shared publish gate)
// --------------------------------------------------------------------------

export function candidateSourceRegionRows(db: DatabaseSync, candidateId: string): Row[] {
  const ids = db
    .prepare(
      `SELECT r."id" AS id FROM "ingestion_import_candidate_source_regions" m
         JOIN "ingestion_source_region" r ON r."id" = m."sourceregion_id"
        WHERE m."importcandidate_id" = ?
        ORDER BY r."document_id" ASC, r."page_index" ASC, r."y" ASC, r."x" ASC`,
    )
    .all(candidateId) as { id: string }[]
  return ids.map((row) => getRow(db, 'ingestion_source_region', row.id)!)
}

function childCandidateRows(db: DatabaseSync, candidateId: string): Row[] {
  return findRows(
    db,
    'ingestion_import_candidate',
    { parent_candidate_id: candidateId },
    { orderBy: [['created_at', 'asc']] },
  )
}

/** The already-published version sitting at one paper position (`published_paper_position`). */
function publishedPaperPosition(db: DatabaseSync, paperId: string, positionKey: string): Row | null {
  const hit = db
    .prepare(
      `SELECT v."id" AS id FROM "exams_paper_item" i
         JOIN "exams_paper_revision" r ON r."id" = i."revision_id"
         JOIN "question_bank_question_version" v ON v."id" = i."question_version_id"
        WHERE r."paper_id" = ? AND i."position_key" = ? AND v."status" = 'published'
        ORDER BY i."created_at" ASC
        LIMIT 1`,
    )
    .get(paperId, positionKey) as { id: string } | undefined
  return hit === undefined ? null : getRow(db, 'question_bank_question_version', hit.id)
}

/**
 * `refresh_candidate_issues`: recompute and **replace** the proofreading issues, then move the
 * candidate between draft/ready without ever un-publishing or un-ignoring a decided candidate.
 */
export function refreshCandidateIssues(db: DatabaseSync, candidate: Row, now: Instant): Issue[] {
  const issues: Issue[] = []
  const payload = asRecord(candidate.draft_payload) ?? {}
  const questionType = payload['question_type']
  const content = pyOr(payload['content'], {})
  if (!truthy(questionType)) {
    issues.push({ code: 'missing_question_type', message: '缺少题型', severity: 'blocking' })
  } else {
    for (const problem of validateContent(content, questionType as string)) {
      issues.push({ ...problem, severity: 'blocking' })
    }
    if (CHOICE_TYPES.has(questionType as string)) {
      const contentRecord = asRecord(content)
      const options = contentRecord !== null && Array.isArray(contentRecord['options']) ? contentRecord['options'] : []
      if (options.length < 2) {
        issues.push({ code: 'too_few_options', message: '选项少于两个，疑似识别缺失', severity: 'blocking' })
      }
    }
  }
  const answerPayload = pyOr(payload['answer_payload'], {})
  const isMaterial = questionType === MATERIAL
  // `payload.get("answer_status_known", True)`: an absent key means "known", an explicit
  // null/false/empty means the proofreader has not confirmed an answer.
  const answerStatusKnown = payload['answer_status_known'] === undefined ? true : payload['answer_status_known']
  if (isMaterial) {
    // A material is a shared stem, not a scoring unit: its completeness is defined by its
    // published sub-questions, never by an answer of its own.
    const children = childCandidateRows(db, String(candidate.id))
    if (children.length === 0) {
      issues.push({
        code: 'material_without_children',
        message: '材料题没有任何子题；请先校对并发布子题，再发布材料题',
        severity: 'blocking',
      })
    } else {
      const unpublished = children.filter((child) => child.status !== STATUS_PUBLISHED)
      if (unpublished.length > 0) {
        issues.push({
          code: 'material_children_unpublished',
          message: `仍有 ${unpublished.length} 个子题未发布，材料题的子题关系尚不完整`,
          severity: 'blocking',
          candidate_ids: unpublished.map((child) => String(child.id)),
        })
      }
    }
  } else if (!truthy(answerStatusKnown)) {
    issues.push({ code: 'answer_unknown', message: '答案缺失或不确定，不能发布为计分题', severity: 'blocking' })
  } else if (!truthy(answerPayload)) {
    issues.push({ code: 'answer_missing', message: '尚未填写答案', severity: 'blocking' })
  }
  const match = asRecord(candidate.answer_match) ?? {}
  if (truthy(match['matched']) && !truthy(payload['answer_confirmed_by_match_review'])) {
    // Mechanical matching is a proposal. Until a human confirms it the candidate is not publishable.
    issues.push({
      code: 'answer_match_pending_confirmation',
      message:
        `答案由答案页匹配产生（方式：${match['method'] === 'label' ? '题号' : '顺序'}，` +
        `原文：${pyCodePointSlice(match['raw'] === undefined ? '' : pyStr(match['raw']), 0, 40)}），请核对后确认`,
      severity: 'blocking',
      method: match['method'] ?? null,
      source_page_index: match['source_page_index'] ?? null,
    })
  }
  if (candidate.subject_id === null || candidate.subject_id === undefined || candidate.subject_id === '') {
    issues.push({ code: 'subject_missing', message: '尚未选择科目', severity: 'blocking' })
  }
  if (candidate.paper_revision_id !== null && candidate.paper_revision_id !== undefined && !isMaterial) {
    const rawScore = payload['practice_max_score']
    if (rawScore === null || rawScore === undefined || rawScore === '') {
      issues.push({
        code: 'paper_item_score_missing',
        message: '该题属于真实试卷记录：发布前必须填写分值，否则周期分值的分母不完整',
        severity: 'blocking',
      })
    }
  }
  if (candidate.paper_revision_id !== null && candidate.paper_revision_id !== undefined && truthy(candidate.source_position_key)) {
    const revision = getRow(db, 'exams_paper_revision', candidate.paper_revision_id)
    if (revision === null) throw new Error(`paper revision ${String(candidate.paper_revision_id)} is missing`)
    const published = publishedPaperPosition(db, String(revision.paper_id), String(candidate.source_position_key))
    if (published !== null && String(published.id) !== String(candidate.publication_version_id ?? '')) {
      // Re-importing a paper must not publish the same paper position twice.
      issues.push({
        code: 'duplicate_paper_position',
        message:
          `该试卷的题号 ${String(candidate.source_position_key)} 已发布过版本；` +
          '重复导入不能再次发布（如需修订请在题库中创建新版本）',
        severity: 'blocking',
        question_id: String(published.question_id),
        question_version_id: String(published.id),
      })
    }
  }
  const regions = candidateSourceRegionRows(db, String(candidate.id))
  if (regions.length === 0) {
    issues.push({ code: 'no_source_region', message: '缺少来源区域；题目必须可追溯到原文或原图', severity: 'warning' })
  }
  if (candidate.layout_review_confirmed_at === null || candidate.layout_review_confirmed_at === undefined) {
    const job = getRow(db, 'ingestion_import_job', candidate.job_id)
    if (job === null) throw new Error(`import job ${String(candidate.job_id)} is missing`)
    issues.push(
      ...(layoutReviewIssues({
        pageDiagnostics: (job.page_diagnostics as Record<string, unknown>[]) ?? [],
        pages: regions.map((region) => [String(region.document_id), Number(region.page_index)] as [string, number]),
      }) as Issue[]),
    )
  }
  const continuesOnPages = (pyOr(payload['continues_on_pages'], []) as unknown[]).map((page) => pyInt(page))
  if (continuesOnPages.length > 1) {
    issues.push({
      code: 'cross_page_question',
      message:
        '该题跨页（第 ' +
        continuesOnPages.map((page) => String(page)).join('、') +
        ' 页）：题干/选项在页面之间被自动接续，请对照原页确认没有漏字或缺行',
      severity: 'warning',
      pages: continuesOnPages,
    })
  }
  // P2 batch 2 (C02): an AI-generated variant is re-checked here, inside the single publish gate,
  // against its *stored* payload. That is what makes a rejection durable: an unrelated edit cannot
  // clear it, and a variant cannot publish while it still duplicates content, has an unverifiable
  // answer, or targets a node outside the question's syllabus (06 §6.2).
  if (candidate.job_id !== null && candidate.job_id !== undefined) {
    const job = getRow(db, 'ingestion_import_job', candidate.job_id)
    if (job !== null && job.input_kind === 'ai_variant') {
      issues.push(...(variantReviewIssues(db, candidate) as unknown as Issue[]))
    }
  }
  if (truthy(questionType) && truthy(content)) {
    const existing = db
      .prepare(
        `SELECT "id" AS id, "draft_payload" AS draft_payload FROM "ingestion_import_candidate"
          WHERE "project_id" = ? AND "status" != 'ignored' AND "id" != ?
          ORDER BY "job_id" ASC, "created_at" ASC`,
      )
      .all(String(candidate.project_id), String(candidate.id)) as { id: string; draft_payload: string }[]
    const duplicate = existing.find((row) => {
      const draft = asRecord(JSON.parse(row.draft_payload))
      return draft !== null && jsonValueEqual(draft['content'], content)
    })
    if (duplicate !== undefined) {
      issues.push({
        code: 'duplicate_candidate',
        message: '题库中疑似已有相同结构的候选，请确认是否为重复录入',
        severity: 'warning',
        candidate_id: String(duplicate.id),
      })
    }
    if (truthy(candidate.subject_id)) {
      const versions = db
        .prepare(
          `SELECT v."id" AS id, v."question_id" AS question_id, v."content" AS content
             FROM "question_bank_question_version" v
             JOIN "question_bank_question" q ON q."id" = v."question_id"
            WHERE q."subject_id" = ? AND v."status" = 'published'
            ORDER BY v."question_id" ASC, v."version" DESC`,
        )
        .all(String(candidate.subject_id)) as { id: string; question_id: string; content: string }[]
      const near = versions.find((row) => jsonValueEqual(JSON.parse(row.content), content))
      if (near !== undefined) {
        issues.push({
          code: 'duplicate_published',
          message: '已存在内容完全相同的已发布版本，导入前请确认不要重复统计',
          severity: 'warning',
          question_id: String(near.question_id),
        })
      }
      const similarLabel = payload['display_label']
      if (truthy(similarLabel)) {
        const sameLabel = findRows(
          db,
          'question_bank_question',
          { subject_id: candidate.subject_id, display_label: similarLabel },
          { orderBy: [['created_at', 'desc']], limit: 1 },
        )[0]
        if (sameLabel !== undefined) {
          issues.push({
            code: 'duplicate_label',
            message: `该科目已存在相同题号/标签：${String(similarLabel)}`,
            severity: 'warning',
            question_id: String(sameLabel.id),
          })
        }
      }
    }
  }

  const status = String(candidate.status)
  if (status === STATUS_PUBLISHED || status === STATUS_IGNORED) {
    // Recomputing issues must never un-publish or un-ignore a decided candidate.
    updateRow(db, 'ingestion_import_candidate', candidate.id, { review_issues: issues }, { now })
    return issues
  }
  const blocking = issues.filter((issue) => (issue as Record<string, unknown>)['severity'] === 'blocking')
  let nextStatus = status
  if (blocking.length === 0 && status === STATUS_DRAFT) nextStatus = STATUS_READY
  else if (blocking.length > 0) nextStatus = STATUS_DRAFT
  updateRow(
    db,
    'ingestion_import_candidate',
    candidate.id,
    { review_issues: issues, status: nextStatus },
    { now },
  )
  return issues
}

// --------------------------------------------------------------------------
// Proofreading writes
// --------------------------------------------------------------------------

function writeContentRevision(
  db: DatabaseSync,
  options: {
    actorId: string
    entityType: string
    entityId: string
    action: string
    projectId: string
    detail?: Record<string, unknown>
    reason?: string
    now: Instant
  },
): void {
  insertRow(
    db,
    'audit_content_revision',
    {
      actor_id: options.actorId,
      entity_type: options.entityType,
      entity_id: options.entityId,
      action: options.action,
      project_id: options.projectId,
      reason: options.reason ?? '',
      before_digest: '',
      after_digest: '',
      detail: options.detail ?? {},
    },
    { now: options.now },
  )
}

export interface CandidatePatchInput {
  draftPayload: Record<string, unknown> | null
  subjectId: string | null
  expectedRevision: number | null
  note: string
}

/**
 * `update_candidate`: full replacement of the draft (never a deep merge), one revision bump even
 * for an empty patch, a snapshot of the pre-refresh issues, and an audit row.
 */
export function updateCandidate(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  candidateId: string,
  input: CandidatePatchInput,
  now: Instant,
): Row {
  return transaction(db, () => {
    const locked = getRow(db, 'ingestion_import_candidate', candidateId)
    if (locked === null || String(locked.project_id) !== String(projectId)) {
      throw new ScopeViolation('候选不存在或不属于该项目')
    }
    if (input.expectedRevision !== null && Number(input.expectedRevision) !== Number(locked.revision)) {
      throw new VersionConflict(undefined, {
        details: { expected: input.expectedRevision, actual: locked.revision },
      })
    }
    if (locked.status === STATUS_PUBLISHED) {
      throw new InvalidInput('已发布的候选不能继续修改；请为已发布题目创建新版本')
    }
    let subjectId = locked.subject_id as string | null
    if (input.subjectId !== null) {
      const subject = getRow(db, 'exams_subject', input.subjectId)
      if (subject === null) throw new ScopeViolation('科目不属于该项目')
      if (String(subject.project_id) !== String(locked.project_id)) {
        throw new ScopeViolation('科目不属于该项目')
      }
      subjectId = String(subject.id)
    }
    const draftPayload = input.draftPayload === null ? locked.draft_payload : input.draftPayload
    const revision = Number(locked.revision) + 1
    let updated = updateRow(
      db,
      'ingestion_import_candidate',
      locked.id,
      {
        subject_id: subjectId,
        draft_payload: draftPayload,
        revision,
        reviewed_by_id: userId,
        reviewed_at: now,
      },
      { now },
    )!
    insertRow(
      db,
      'ingestion_candidate_revision',
      {
        candidate_id: locked.id,
        revision,
        payload: draftPayload,
        // The issues the reviewer was looking at *before* this edit.
        review_issues: locked.review_issues,
        edited_by_id: userId,
        note: pyCodePointSlice(input.note, 0, 500),
      },
      { now },
    )
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'import_candidate',
      entityId: String(locked.id),
      action: 'proofread',
      projectId: String(locked.project_id),
      detail: { revision },
      now,
    })
    refreshCandidateIssues(db, updated, now)
    return getRow(db, 'ingestion_import_candidate', locked.id)!
  })
}

/** `ignore_candidate`: a decision, not an edit — no revision bump, no `reviewed_at` change. */
export function ignoreCandidate(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  candidateId: string,
  reason: string,
  now: Instant,
): Row {
  return transaction(db, () => {
    const locked = getRow(db, 'ingestion_import_candidate', candidateId)
    if (locked === null || String(locked.project_id) !== String(projectId)) {
      throw new ScopeViolation('候选不存在或不属于该项目')
    }
    if (locked.status === STATUS_PUBLISHED) throw new InvalidInput('已发布候选不能标记为忽略')
    updateRow(db, 'ingestion_import_candidate', locked.id, { status: STATUS_IGNORED }, { now })
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'import_candidate',
      entityId: String(locked.id),
      action: 'ignore',
      projectId: String(locked.project_id),
      reason: pyCodePointSlice(reason, 0, 500),
      now,
    })
    maybeCompleteJob(db, getRow(db, 'ingestion_import_job', locked.job_id)!, now)
    return getRow(db, 'ingestion_import_candidate', locked.id)!
  })
}

/**
 * `confirm_layout_review`: the only way to clear blocking layout issues. It records which pages the
 * human confirmed and does not touch the draft or the revision.
 */
export function confirmLayoutReview(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  candidateId: string,
  note: string,
  now: Instant,
): Row {
  return transaction(db, () => {
    const locked = getRow(db, 'ingestion_import_candidate', candidateId)
    if (locked === null || String(locked.project_id) !== String(projectId)) {
      throw new ScopeViolation('候选不存在或不属于该项目')
    }
    if (locked.status === STATUS_PUBLISHED) throw new InvalidInput('已发布的候选无需再确认版式')
    const trimmedNote = pyCodePointSlice(note ?? '', 0, 500)
    let updated = updateRow(
      db,
      'ingestion_import_candidate',
      locked.id,
      {
        layout_review_confirmed_at: now,
        layout_review_note: trimmedNote,
        reviewed_by_id: userId,
        reviewed_at: now,
      },
      { now },
    )!
    const regions = candidateSourceRegionRows(db, String(locked.id))
    const payload = asRecord(locked.draft_payload) ?? {}
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'import_candidate',
      entityId: String(locked.id),
      action: 'layout_confirm',
      projectId: String(locked.project_id),
      reason: trimmedNote,
      detail: {
        pages: regions.map((region) => ({
          document_id: String(region.document_id),
          page_index: Number(region.page_index),
        })),
        continues_on_pages: pyOr(payload['continues_on_pages'], []),
      },
      now,
    })
    refreshCandidateIssues(db, updated, now)
    return getRow(db, 'ingestion_import_candidate', locked.id)!
  })
}

// --------------------------------------------------------------------------
// Job lifecycle
// --------------------------------------------------------------------------

/**
 * `maybe_complete_job`: `completed` means every candidate is published or ignored — and a job with
 * **no** candidates is not complete, it is awaiting review (an empty paste still needs a human).
 */
export function maybeCompleteJob(db: DatabaseSync, job: Row, now: Instant): Row {
  if (job.status === JOB_FAILED || job.status === JOB_CANCELLED) return job
  const candidates = findRows(db, 'ingestion_import_candidate', { job_id: job.id })
  const pending = candidates.filter(
    (candidate) => candidate.status !== STATUS_PUBLISHED && candidate.status !== STATUS_IGNORED,
  ).length
  if (pending === 0 && candidates.length > 0) {
    return updateRow(
      db,
      'ingestion_import_job',
      job.id,
      { status: JOB_COMPLETED, progress_percent: 100, finished_at: now },
      { now },
    )!
  }
  return updateRow(db, 'ingestion_import_job', job.id, { status: JOB_AWAITING_REVIEW }, { now })!
}

export function addJobProblem(
  db: DatabaseSync,
  job: Row,
  problem: { code: string; message: string; severity?: string; extra?: Record<string, unknown> },
  now: Instant,
): Row {
  const problems = Array.isArray(job.problems) ? [...(job.problems as unknown[])] : []
  problems.push({
    code: problem.code,
    message: problem.message,
    severity: problem.severity ?? 'warning',
    ...(problem.extra ?? {}),
  })
  return updateRow(db, 'ingestion_import_job', job.id, { problems }, { now })!
}

// --------------------------------------------------------------------------
// Serializers (`job_summary` / `candidate_summary`)
// --------------------------------------------------------------------------

/** `job_summary`: every field the proofreading list needs, including the derived counts. */
export function jobSummary(db: DatabaseSync, job: Row): Record<string, unknown> {
  const candidates = findRows(
    db,
    'ingestion_import_candidate',
    { job_id: job.id },
    { orderBy: [['created_at', 'asc']] },
  )
  const counts: Record<string, number> = {}
  for (const candidate of candidates) {
    const status = String(candidate.status)
    counts[status] = (counts[status] ?? 0) + 1
  }
  const documentIds = (
    db
      .prepare(
        `SELECT "sourcedocument_id" AS id FROM "ingestion_import_job_documents"
          WHERE "importjob_id" = ? ORDER BY "id" ASC`,
      )
      .all(String(job.id)) as { id: string }[]
  ).map((row) => String(row.id))
  return {
    id: String(job.id),
    project_id: String(job.project_id),
    subject_id: job.subject_id === null ? null : String(job.subject_id),
    status: job.status,
    input_kind: job.input_kind,
    progress_percent: Number(job.progress_percent),
    problems: job.problems ?? [],
    attempts: Number(job.attempts),
    max_attempts: Number(job.max_attempts),
    last_error: job.last_error,
    extractor_version: job.extractor_version,
    duplicate_of_job_id: job.duplicate_of_id === null ? null : String(job.duplicate_of_id),
    document_ids: documentIds,
    page_diagnostics: job.page_diagnostics ?? [],
    candidate_count: candidates.length,
    candidate_status_counts: counts,
    created_at: formatPythonIso(job.created_at as Instant),
  }
}

/**
 * `candidate_summary`: regions ordered by the model's `ordering = [document, page_index, y, x]`,
 * each carrying the whole page's asset/title so a proofreader can compare against the original even
 * when no crop exists.
 */
export function candidateSummary(db: DatabaseSync, candidate: Row): Record<string, unknown> {
  const regions = candidateSourceRegionRows(db, String(candidate.id)).map((region) => {
    const document = getRow(db, 'ingestion_source_document', region.document_id)
    if (document === null) throw new Error(`source document ${String(region.document_id)} is missing`)
    return {
      id: String(region.id),
      document_id: String(region.document_id),
      page_index: Number(region.page_index),
      x: Number(region.x),
      y: Number(region.y),
      width: Number(region.width),
      height: Number(region.height),
      role: region.role,
      text_span: region.text_span,
      crop_asset_id: region.crop_asset_id === null ? null : String(region.crop_asset_id),
      document_asset_id: document.asset_id === null ? null : String(document.asset_id),
      document_title: document.title,
      document_type: document.document_type,
    }
  })
  const children = childCandidateRows(db, String(candidate.id))
  return {
    id: String(candidate.id),
    job_id: String(candidate.job_id),
    subject_id: candidate.subject_id === null ? null : String(candidate.subject_id),
    status: candidate.status,
    revision: Number(candidate.revision),
    review_issues: candidate.review_issues ?? [],
    is_stub_output: Boolean(candidate.is_stub_output),
    extractor_version: candidate.extractor_version,
    draft_payload: candidate.draft_payload ?? {},
    machine_payload: candidate.machine_payload ?? {},
    source_regions: regions,
    publication_question_id:
      candidate.publication_question_id === null ? null : String(candidate.publication_question_id),
    publication_version_id:
      candidate.publication_version_id === null ? null : String(candidate.publication_version_id),
    publication_paper_item_id:
      candidate.publication_paper_item_id === null ? null : String(candidate.publication_paper_item_id),
    parent_candidate_id:
      candidate.parent_candidate_id === null ? null : String(candidate.parent_candidate_id),
    child_candidate_ids: children.map((child) => String(child.id)),
    source_position_key: candidate.source_position_key,
    paper_revision_id: candidate.paper_revision_id === null ? null : String(candidate.paper_revision_id),
    answer_match: candidate.answer_match ?? {},
    layout_review_confirmed_at:
      candidate.layout_review_confirmed_at === null
        ? null
        : formatPythonIso(candidate.layout_review_confirmed_at as Instant),
    layout_review_note: candidate.layout_review_note,
    updated_at: formatPythonIso(candidate.updated_at as Instant),
  }
}

