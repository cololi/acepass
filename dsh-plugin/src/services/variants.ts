/**
 * AI variant proposals — port of `backend/apps/question_bank/services/variants.py`.
 *
 * The product rules this module enforces (C02, R-INV 3):
 *
 * - **a model never publishes content.** `proposeVariants` writes an `ai_variant` import job plus
 *   one candidate per proposal; publication stays the ordinary human gate and there is deliberately
 *   no publish path here.
 * - **deterministic validation before a variant can be used.** Every payload goes through the
 *   shared variant validator *and* `independentChecks` (answer self-consistency, duplicate
 *   identity, syllabus ownership, and an explicit probe of the "AI content never joins a real
 *   paper" rule).
 * - **失败留候选.** A proposal that fails any check is still stored with every problem attached,
 *   never dropped and never auto-published.
 * - **no formal score / mastery state is ever written** — only `import_job`, `import_candidate` and
 *   `audit_llm_run` rows.
 *
 * Audit shape: one run row per model call, created `failed` before the call and updated in place
 * afterwards (never a second row to repair the status, 06 §6.1). The model identifier is
 * `result.route.model`; cost stays unknown because dsh-llm reports no price.
 */
import type { DatabaseSync } from 'node:sqlite'

import { SCORABLE_LEAF_TYPES, blankIds } from '../ai/content.ts'
import { PROPOSE_VARIANT_PROMPT_VERSION, buildVariantPrompt } from '../ai/prompts.ts'
import {
  formatPythonIso,
  type Instant,
} from '../domain/instant.ts'
import { Decimal } from '../domain/decimal.ts'
import { parseModelJson, pyJoin, pyOr, pySlice, pyStr, pyTruthy } from '../ai/pyvalue.ts'
import {
  answerConsistencyProblems,
  blocksText,
  normalizedText,
  variantDraftPayload,
  variantProblem,
  type VariantProblem,
} from '../domain/ingestion/variants.ts'
import { validateVariantPayload, type ValidationProblem } from '../ai/validators.ts'
import { markFailed, statusForFailureCode, withCallTelemetry } from '../ai/audit.ts'
import { beginAuditedRun, finishAuditedRun, telemetryOf } from './ai_runs.ts'
import { transaction } from '../store/db.ts'
import { findOne, findRows, getRow, updateRow, type Row } from '../store/repository.ts'
import { contentDigest } from './questions.ts'
import { paperItemRuleErrors } from './exams.ts'
import { isSealed, reasonMessage } from './sealing.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation } from './errors.ts'
import { addJobProblem, createCandidate, createImportJob, maybeCompleteJob } from './ingestion.ts'
import type { LlmPort } from '../llm/contract.ts'

export const AI_VARIANT_INPUT_KIND = 'ai_variant'
export const MAX_VARIANTS_PER_REQUEST = 3

const BLOCKING = 'blocking'
const WARNING = 'warning'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The shared validators leave `path`/`severity` optional; the stored variant issue always has both. */
function asVariantProblems(problems: readonly ValidationProblem[]): VariantProblem[] {
  return problems.map((problem) => ({
    code: problem.code,
    message: problem.message,
    path: problem.path ?? '',
    severity: problem.severity ?? BLOCKING,
  }))
}

/* ------------------------------------------------------------------ facts */

export interface VersionTexts {
  stem: string
  options: string[]
  material: string
}

/** `version_texts`: stem, option texts and material text of a source version — never answers. */
export function versionTexts(db: DatabaseSync, version: Row): VersionTexts {
  const content = isRecord(version.content) ? version.content : {}
  const stem = blocksText(content['blocks'])
  const optionRows = Array.isArray(content['options']) ? (content['options'] as unknown[]) : []
  const options = optionRows.filter(isRecord).map((option) => blocksText(option['blocks']))
  let material = ''
  if (version.parent_material_version_id !== null && version.parent_material_version_id !== undefined) {
    const parent = getRow(db, 'question_bank_question_version', version.parent_material_version_id)
    if (parent !== null) material = blocksText((isRecord(parent.content) ? parent.content : {})['blocks'])
  } else if (version.question_type === 'material') {
    material = stem
  }
  return { stem, options: options.filter((text) => text.length > 0), material }
}

export interface CheckedAnswer {
  answer: Row
  rubric: Row | null
}

/** `checked_answer`: newest undisputed answer, preferring one a human has checked. */
export function checkedAnswer(db: DatabaseSync, versionId: string): CheckedAnswer | null {
  const answers = findRows(
    db,
    'question_bank_answer_key_version',
    { question_version_id: versionId, is_disputed: false },
    { orderBy: [['version', 'desc']] },
  )
  if (answers.length === 0) return null
  const usable = answers.find((answer) => answer.verification_status === 'checked')
  const answer = usable ?? answers[0]
  return { answer, rubric: findOne(db, 'question_bank_rubric_version', { answer_key_version_id: answer.id }) }
}

/** `answer_context`: `(answer_summary, rubric_criteria)` for the prompt. */
export function answerContext(
  checked: CheckedAnswer | null,
  questionType: string,
): { summary: string; criteria: Array<Record<string, unknown>> } {
  if (checked === null) return { summary: '（原题没有答案版本：只能依据题干条件生成）', criteria: [] }
  const { answer, rubric } = checked
  const payload = isRecord(answer.answer_payload) ? answer.answer_payload : {}
  let summary: string
  if (questionType === 'single_choice') {
    summary = `正确选项 ID：${pyStr(payload['correct_option_id'])}`
  } else if (questionType === 'multiple_choice') {
    const ids = Array.isArray(payload['correct_option_ids']) ? (payload['correct_option_ids'] as unknown[]) : []
    summary = `正确选项 ID：${pyJoin(', ', ids)}`
  } else if (questionType === 'true_false') {
    summary = `正确值：${pyStr(payload['value'])}`
  } else if (questionType === 'fill_blank') {
    const rows: string[] = []
    const blanks = isRecord(payload['blanks']) ? payload['blanks'] : {}
    for (const [blankId, spec] of Object.entries(blanks)) {
      if (!isRecord(spec)) continue
      const accepted = Array.isArray(spec['accepted_values']) ? (spec['accepted_values'] as unknown[]) : []
      const numeric = spec['numeric']
      // Python `f"{blank_id}={accepted or spec.get('numeric')}"`: a non-empty list is formatted with
      // `str(list)`, i.e. `['甲', '乙']`, not joined. It reaches the prompt verbatim, so keep it.
      rows.push(`${blankId}=${accepted.length > 0 ? pyStr(accepted) : pyStr(numeric)}`)
    }
    summary = '各空答案：' + rows.join('；')
  } else if (questionType === 'constructed_response') {
    summary = '按评分点给分（见下方评分标准），不提供可直接抄写的答案'
  } else {
    summary = ''
  }
  if (answer.verification_status !== 'checked') {
    summary += '（该答案尚未人工核对：仅供参考，不得当作标准答案）'
  }
  const criteriaRows = rubric !== null && Array.isArray(rubric.criteria) ? (rubric.criteria as unknown[]) : []
  const criteria = criteriaRows.filter(isRecord).map((criterion) => ({
    criterion_id: pyStr(criterion['criterion_id']),
    text: pyStr(pyOr(criterion['text'], '')),
    max_score: pyStr(criterion['max_score']),
  }))
  return { summary, criteria }
}

/* ------------------------------------------------------- independent checks */

export function officialPastRuleProblems(projectId: string): VariantProblem[] {
  // Run the very rule the paper writer runs, against an in-memory probe pair. Nothing is written:
  // if `PaperItem.clean()` were ever relaxed, this pipeline would fail loudly instead of quietly
  // producing content that could be counted as a real past occurrence.
  const errors = paperItemRuleErrors({
    revisionId: '__variant_origin_probe_revision__',
    paperSubjectId: '__variant_origin_probe_subject__',
    questionSubjectId: '__variant_origin_probe_subject__',
    questionOriginType: 'ai_generated',
    paperSourceKind: 'official_past',
    maxScore: Decimal.zero(),
  })
  if (Object.keys(errors).length > 0) return []
  return [
    {
      ...variantProblem(
        'official_past_rule_missing',
        '服务端未拒绝“AI 生成题挂到真实考试发生记录”：在规则恢复前不生成变式，避免生成内容进入真题统计',
        'origin_type',
      ),
    },
  ]
}

function publishedDigestHit(
  db: DatabaseSync,
  subjectId: string,
  digest: string,
): { questionId: string; versionId: string; displayLabel: string } | null {
  const row = db
    .prepare(
      `SELECT v."id" AS version_id, q."id" AS question_id, q."display_label" AS display_label
         FROM "question_bank_question_version" v
         JOIN "question_bank_question" q ON q."id" = v."question_id"
        WHERE q."subject_id" = ? AND v."status" = 'published' AND v."content_digest" = ?
        ORDER BY v."created_at" ASC
        LIMIT 1`,
    )
    .get(subjectId, digest) as { version_id: string; question_id: string; display_label: string } | undefined
  if (row === undefined) return null
  return { questionId: String(row.question_id), versionId: String(row.version_id), displayLabel: row.display_label }
}

function familyDigestHit(
  db: DatabaseSync,
  subjectId: string,
  familyId: string,
  digest: string,
  excludeQuestionId: string,
): { questionId: string; familyId: string } | null {
  const row = db
    .prepare(
      `SELECT v."question_id" AS question_id
         FROM "question_bank_question_version" v
         JOIN "question_bank_question" q ON q."id" = v."question_id"
        WHERE q."family_id" = ? AND q."subject_id" = ? AND v."status" = 'published' AND v."content_digest" = ?
          AND q."id" != ?
        LIMIT 1`,
    )
    .get(familyId, subjectId, digest, excludeQuestionId) as { question_id: string } | undefined
  return row === undefined ? null : { questionId: String(row.question_id), familyId }
}

function pendingDuplicate(
  db: DatabaseSync,
  projectId: string,
  subjectId: string,
  digest: string,
  stem: string,
  excludeCandidateId: string | null,
): string | null {
  const rows = findRows(
    db,
    'ingestion_import_candidate',
    { project_id: projectId, subject_id: subjectId },
    { orderBy: [['created_at', 'desc']] },
  )
  let scanned = 0
  for (const candidate of rows) {
    if (candidate.status === 'ignored') continue
    if (excludeCandidateId !== null && String(candidate.id) === excludeCandidateId) continue
    scanned += 1
    if (scanned > 200) break
    const draft = isRecord(candidate.draft_payload) ? candidate.draft_payload : {}
    const other = draft['content']
    if (!isRecord(other)) continue
    if (contentDigest(other) !== digest) continue
    if (normalizedText(blocksText(other['blocks'])) === normalizedText(stem)) return String(candidate.id)
  }
  return null
}

export interface IndependentChecksInput {
  payload: Record<string, unknown>
  sourceVersion: Row
  node: Row | null
  projectId?: string | null
  excludeCandidateId?: string | null
}

export interface IndependentChecksResult {
  problems: VariantProblem[]
  content_digest: string
  origin_type: string
  source_version_id: string
}

/** The deterministic checks that do not trust the prompt or the model (`:397`). */
export function independentChecks(db: DatabaseSync, input: IndependentChecksInput): IndependentChecksResult {
  const { payload, sourceVersion, node } = input
  const question = getRow(db, 'question_bank_question', sourceVersion.question_id)
  if (question === null) throw new ScopeViolation('题目版本不存在或不属于该项目')
  const subject = getRow(db, 'exams_subject', question.subject_id)
  if (subject === null) throw new ScopeViolation('题目版本不存在或不属于该项目')
  const projectId = input.projectId ?? String(subject.project_id)
  const questionType = String(sourceVersion.question_type)
  const content = isRecord(payload['content']) ? payload['content'] : {}
  const answerPayload = isRecord(payload['answer_payload']) ? payload['answer_payload'] : {}
  const digest = contentDigest(content)
  const problems: VariantProblem[] = []

  problems.push(
    ...answerConsistencyProblems({
      content,
      answerPayload,
      questionType,
      rubricCriteria: payload['rubric_criteria'],
      statedRubricTotal: payload['rubric_total_score'],
    }),
  )

  const published = publishedDigestHit(db, String(subject.id), digest)
  if (published !== null) {
    problems.push(
      variantProblem(
        'duplicate_published_question',
        '变式内容与已发布题目版本完全相同：不能再次作为新变式发布',
        'content',
        BLOCKING,
        {
          question_id: published.questionId,
          question_version_id: published.versionId,
          display_label: published.displayLabel,
        },
      ),
    )
  }
  if (question.family_id !== null && question.family_id !== undefined) {
    const family = familyDigestHit(db, String(subject.id), String(question.family_id), digest, String(question.id))
    if (family !== null) {
      problems.push(
        variantProblem(
          'duplicate_family_question',
          '同一题目家族中已存在完全相同内容的已发布题目，不能重复生成',
          'content',
          BLOCKING,
          { question_id: family.questionId, family_id: family.familyId },
        ),
      )
    }
  }
  const duplicateCandidate = pendingDuplicate(
    db,
    projectId,
    String(subject.id),
    digest,
    blocksText(content['blocks']),
    input.excludeCandidateId ?? null,
  )
  if (duplicateCandidate !== null) {
    problems.push(
      variantProblem(
        'duplicate_pending_proposal',
        '同一批候选中已存在完全相同的变式：重复提案不会产生第二道题',
        'content',
        BLOCKING,
        { candidate_id: duplicateCandidate },
      ),
    )
  }

  if (node !== null) {
    const syllabus = getRow(db, 'exams_syllabus_version', node.syllabus_version_id)
    const nodeSubjectId = syllabus === null ? null : String(syllabus.subject_id)
    if (nodeSubjectId !== String(subject.id)) {
      problems.push(
        variantProblem(
          'node_subject_mismatch',
          '目标考点不属于该题目的科目大纲：变式不能挂到别的科目的考点上',
          'node_id',
          BLOCKING,
          { node_id: String(node.id) },
        ),
      )
    } else if (String(syllabus?.status ?? '') !== 'published') {
      problems.push(
        variantProblem(
          'node_syllabus_not_published',
          '目标考点所在大纲尚未发布：发布变式前需要先发布大纲',
          'node_id',
          WARNING,
          { node_id: String(node.id) },
        ),
      )
    }
  }

  problems.push(...officialPastRuleProblems(projectId))

  const sourceStem = versionTexts(db, sourceVersion).stem
  const variantStem = normalizedText(blocksText(content['blocks']))
  if (sourceStem !== '' && variantStem !== '' && normalizedText(sourceStem) === variantStem) {
    problems.push(
      variantProblem(
        'variant_duplicates_source',
        '变式题干与源题题干完全相同：它不是有效变式',
        'content.blocks',
        BLOCKING,
        { source_version_id: String(sourceVersion.id) },
      ),
    )
  }
  return {
    problems,
    content_digest: digest,
    origin_type: 'ai_generated',
    source_version_id: String(sourceVersion.id),
  }
}

/* --------------------------------------------------------- review issues */

/** Every deterministic problem of one stored variant candidate (`variant_review_issues`, `:482`). */
export function variantReviewIssues(db: DatabaseSync, candidate: Row): VariantProblem[] {
  const job = getRow(db, 'ingestion_import_job', candidate.job_id)
  if (job === null || job.input_kind !== AI_VARIANT_INPUT_KIND) return []
  if (candidate.status === 'published' || candidate.status === 'ignored') return []
  const payload = isRecord(candidate.draft_payload) ? candidate.draft_payload : {}
  const stored = isRecord(candidate.machine_payload) ? candidate.machine_payload : {}
  const sourceVersionId = pyTruthy(stored['variant_of_version_id'])
    ? stored['variant_of_version_id']
    : payload['variant_of_version_id']
  const sourceVersion =
    pyTruthy(sourceVersionId) ? getRow(db, 'question_bank_question_version', sourceVersionId) : null
  if (sourceVersion === null) {
    return [
      variantProblem(
        'variant_source_missing',
        '找不到变式的源题版本：无法验证它是否构成有效变式',
        'variant_of_version_id',
      ),
    ]
  }
  const nodeId = pyTruthy(stored['variant_node_id']) ? stored['variant_node_id'] : payload['variant_node_id']
  const node = pyTruthy(nodeId) ? getRow(db, 'knowledge_node', nodeId) : null
  const problems: VariantProblem[] = []
  if (node === null) {
    problems.push(
      variantProblem('variant_node_missing', '变式没有可核对的考点：无法验证它属于该科目大纲', 'variant_node_id'),
    )
  }
  const sourceStem = versionTexts(db, sourceVersion).stem
  const [, validationProblems] = validateVariantPayload(payload, {
    question_type: String(sourceVersion.question_type),
    avoid_stems: [sourceStem],
  })
  problems.push(...asVariantProblems(validationProblems))
  problems.push(
    ...independentChecks(db, {
      payload,
      sourceVersion,
      node,
      projectId: String(candidate.project_id),
      excludeCandidateId: String(candidate.id),
    }).problems,
  )
  return problems
}

/* ------------------------------------------------------------ serializers */

export function variantCandidateSummary(candidate: Row): Record<string, unknown> {
  const payload = isRecord(candidate.draft_payload) ? candidate.draft_payload : {}
  const machine = isRecord(candidate.machine_payload) ? candidate.machine_payload : {}
  const issues = Array.isArray(candidate.review_issues) ? (candidate.review_issues as Record<string, unknown>[]) : []
  const blocking = issues.filter((issue) => issue['severity'] === BLOCKING)
  return {
    candidate_id: String(candidate.id),
    job_id: String(candidate.job_id),
    status: candidate.status,
    awaiting_human_review: candidate.status !== 'published' && candidate.status !== 'ignored',
    question_type: payload['question_type'] ?? null,
    review_issues: issues,
    blocking_issues: blocking,
    answer_needs_confirmation: !pyTruthy(payload['answer_status_known']),
    answer_source_type: pyTruthy(payload['answer_source_type']) ? payload['answer_source_type'] : 'ai_derived',
    content_digest: pyTruthy(payload['variant_content_digest'])
      ? payload['variant_content_digest']
      : pyTruthy(machine['content_digest'])
        ? machine['content_digest']
        : '',
    source_question_id: pyTruthy(payload['variant_of_question_id']) ? payload['variant_of_question_id'] : '',
    source_version_id: pyTruthy(payload['variant_of_version_id'])
      ? payload['variant_of_version_id']
      : pyTruthy(machine['variant_of_version_id'])
        ? machine['variant_of_version_id']
        : '',
    node_id: pyTruthy(payload['variant_node_id'])
      ? payload['variant_node_id']
      : pyTruthy(machine['variant_node_id'])
        ? machine['variant_node_id']
        : '',
    llm_run_id: pyTruthy(payload['variant_llm_run_id'])
      ? payload['variant_llm_run_id']
      : pyTruthy(machine['llm_run_id'])
        ? machine['llm_run_id']
        : '',
    is_stub_output: candidate.is_stub_output,
    publication_question_id:
      candidate.publication_question_id === null || candidate.publication_question_id === undefined
        ? null
        : String(candidate.publication_question_id),
    publication_version_id:
      candidate.publication_version_id === null || candidate.publication_version_id === undefined
        ? null
        : String(candidate.publication_version_id),
    created_at: formatPythonIso(candidate.created_at as Instant),
  }
}

export function variantJobSummary(db: DatabaseSync, job: Row): Record<string, unknown> {
  const candidates = findRows(db, 'ingestion_import_candidate', { job_id: job.id }, { orderBy: [['created_at', 'asc']] })
  const counts: Record<string, number> = {}
  for (const candidate of candidates) {
    const status = String(candidate.status)
    counts[status] = (counts[status] ?? 0) + 1
  }
  return {
    job_id: String(job.id),
    project_id: String(job.project_id),
    subject_id: job.subject_id === null || job.subject_id === undefined ? null : String(job.subject_id),
    status: job.status,
    input_kind: job.input_kind,
    extractor_version: job.extractor_version,
    progress_percent: Number(job.progress_percent),
    problems: job.problems ?? [],
    candidate_count: candidates.length,
    candidate_status_counts: counts,
    candidates: candidates.map(variantCandidateSummary),
    created_at: formatPythonIso(job.created_at as Instant),
  }
}

/** Variant batches of one project, newest first, capped (`variant_jobs`, `:694`). */
export function variantJobs(db: DatabaseSync, projectId: string, userId: string | null, limit = 20): Array<Record<string, unknown>> {
  const bounded = Math.max(1, Math.min(Math.trunc(limit), 50))
  const where: Row = { project_id: projectId, input_kind: AI_VARIANT_INPUT_KIND }
  if (userId !== null) where.created_by_id = userId
  return findRows(db, 'ingestion_import_job', where, {
    orderBy: [['created_at', 'desc']],
    limit: bounded,
  }).map((job) => variantJobSummary(db, job))
}

/* -------------------------------------------------------------- proposal */

/** A provider failure the HTTP layer has to map onto 503 (Python raises `providers.AiError`). */
export class VariantProviderFailure extends Error {
  readonly failureCode: string
  readonly unavailable: boolean
  constructor(message: string, options: { code: string; unavailable: boolean }) {
    super(message)
    this.name = 'VariantProviderFailure'
    this.failureCode = options.code
    this.unavailable = options.unavailable
  }
}

/** Python's canonical "provider cannot generate variants" text, kept verbatim for the API. */
export const VARIANT_UNCONFIGURED_REASON = '未配置可生成变式的文本模型；请配置 provider 或人工录入变式'
/** The audit row reason (Django `error_message` when the capability is not declared). */
const VARIANT_CAPABILITY_MISSING = '当前 provider 不声明 propose_variant 能力（未配置文本模型）'

export interface ProposeVariantsInput {
  projectId: string
  ownerId: string
  sourceVersion: Row
  node: Row | null
  actorId: string
  count?: number
  difficultyNote?: string
  port: LlmPort
}

/**
 * Ask the configured provider for variant candidates; never publish one.
 *
 * Writes are committed step by step like Django's autocommit service: the job and every completed
 * candidate survive a later provider failure, and the failed run is updated in place. The caller
 * (the HTTP resource wrapper) owns the idempotency claim and releases it on failure.
 */
export async function proposeVariants(
  db: DatabaseSync,
  input: ProposeVariantsInput,
  now: Instant,
): Promise<Record<string, unknown>> {
  const sourceVersion = input.sourceVersion
  const question = getRow(db, 'question_bank_question', sourceVersion.question_id)
  if (question === null) throw new ScopeViolation('源题目版本不存在或不属于该项目')
  const subject = getRow(db, 'exams_subject', question.subject_id)
  if (subject === null) throw new ScopeViolation('源题目版本不存在或不属于该项目')
  if (String(subject.project_id) !== String(input.projectId)) {
    throw new ScopeViolation('源题目不属于该项目')
  }
  if (!SCORABLE_LEAF_TYPES.includes(String(sourceVersion.question_type) as never)) {
    throw new InvalidInput('共享材料题不能生成变式；请选择它的子题作为源题')
  }
  if (sourceVersion.status !== 'published') {
    throw new InvalidInput('只能从已发布的题目版本生成变式：草稿内容还没有经过人工发布')
  }
  const sealed = isSealed(db, input.projectId, String(question.id))
  if (sealed.sealed) {
    throw new PurposeNotAllowed(`封存内容不可用于生成变式：${reasonMessage(sealed.code)}`, {
      details: { reason: sealed.code, question_id: String(question.id), action: '用于生成变式' },
    })
  }

  const requested = Math.max(1, Math.trunc(Number(input.count ?? 1) || 1))
  const effective = Math.min(requested, MAX_VARIANTS_PER_REQUEST)
  const difficultyNote = String(input.difficultyNote ?? '')

  const runContext = {
    userId: input.actorId,
    projectId: input.projectId,
  }
  const startRun = (index: number) => {
    const request = {
      capability: 'propose_variant' as const,
      promptVersion: PROPOSE_VARIANT_PROMPT_VERSION,
      system: '',
      prompt: '',
    }
    return beginAuditedRun(
      db,
      request,
      {
        ...runContext,
        requestSummary: {
          source_question_version_id: String(sourceVersion.id),
          question_type: sourceVersion.question_type,
          subject_id: String(subject.id),
          node_id: input.node === null ? '' : String(input.node.id),
          requested_count: requested,
          difficulty_note: pySlice(difficultyNote, 200),
        },
        inputSnapshot: {
          content_digest: sourceVersion.content_digest,
          avoid_stem_count: 1,
          engine: PROPOSE_VARIANT_PROMPT_VERSION,
        },
      },
      now,
    )
  }

  // Python `provider.supports("propose_variant")`: same question, asked of the port before any
  // job or prompt exists. An unavailable capability still leaves an audit row.
  const availability = await input.port.availability()
  const capability = availability.propose_variant
  if (capability === undefined || !capability.available) {
    const reason = capability?.reason ?? 'ai_not_configured'
    const handle = startRun(0)
    finishAuditedRun(
      db,
      handle.rowId,
      markFailed(handle.record, { code: reason, message: VARIANT_CAPABILITY_MISSING }),
      now,
    )
    throw new VariantProviderFailure(VARIANT_UNCONFIGURED_REASON, {
      code: reason,
      unavailable: true,
    })
  }

  const texts = versionTexts(db, sourceVersion)
  const context = answerContext(checkedAnswer(db, String(sourceVersion.id)), String(sourceVersion.question_type))
  const optionRows = Array.isArray((isRecord(sourceVersion.content) ? sourceVersion.content : {})['options'])
    ? (((isRecord(sourceVersion.content) ? sourceVersion.content : {})['options'] as unknown[]).filter(isRecord))
    : []

  let job = transaction(db, () =>
    createImportJob(
      db,
      {
        ownerId: input.actorId,
        projectId: input.projectId,
        subjectId: String(subject.id),
        inputKind: AI_VARIANT_INPUT_KIND,
        inputText:
          `ai-variant:${String(sourceVersion.id)}:${input.node === null ? 'no-node' : String(input.node.id)}:` +
          `${difficultyNote.trim()}:${effective}`,
        extractorVersion: PROPOSE_VARIANT_PROMPT_VERSION,
      },
      now,
    ),
  )
  job = transaction(db, () => {
    const processing = updateJob(db, job, { status: 'processing', started_at: now }, now)
    const withInfo = addJobProblem(
      db,
      processing,
      {
        code: 'ai_variant_not_published',
        message:
          '变式由模型生成，只会成为待校对候选：必须通过确定性校验并由人工核对答案后，才能走原有发布流程。',
        severity: 'info',
        extra: { source_version_id: String(sourceVersion.id), prompt_version: PROPOSE_VARIANT_PROMPT_VERSION },
      },
      now,
    )
    return withInfo
  })

  const notes: string[] = []
  if (effective < requested) {
    const note =
      `单次最多生成 ${MAX_VARIANTS_PER_REQUEST} 道变式：请求 ${requested} 道，` +
      `已按上限执行 ${effective} 道（如需更多请分批提出）。`
    notes.push(note)
    job = transaction(db, () =>
      addJobProblem(db, job, { code: 'variant_count_capped', message: note, severity: 'warning' }, now),
    )
  }

  const candidates: Array<Record<string, unknown>> = []
  let accepted = 0
  let blockingTotal = 0
  let modelIdentifier = ''
  let lastProvider = 'dsh-llm'

  for (let index = 0; index < effective; index += 1) {
    const handle = startRun(index)
    const prompt = buildVariantPrompt({
      question_type: sourceVersion.question_type,
      stem_text: texts.stem,
      options: optionRows,
      answer_summary: context.summary,
      node_name: input.node === null ? '' : String(input.node.canonical_name ?? ''),
      difficulty_note: difficultyNote,
      avoid_stems: [texts.stem],
      rubric_criteria: context.criteria,
      material_text: texts.material,
    })
    let result
    try {
      result = await input.port.run({
        capability: 'propose_variant',
        promptVersion: PROPOSE_VARIANT_PROMPT_VERSION,
        system: '',
        prompt,
      })
    } catch (error) {
      // A port that throws instead of returning a failure result is a programming error; record it
      // as a failed call rather than losing the audit row.
      const message = error instanceof Error ? error.message : String(error)
      finishAuditedRun(db, handle.rowId, markFailed(handle.record, { code: 'ai_error', message }), now)
      job = transaction(db, () =>
        markJobFailed(db, job, `变式生成失败：${message}`, now),
      )
      throw new VariantProviderFailure(message, { code: 'ai_error', unavailable: false })
    }
    if (!result.ok) {
      finishAuditedRun(
        db,
        handle.rowId,
        markFailed(handle.record, { code: result.code, message: result.message }),
        now,
      )
      job = transaction(db, () => markJobFailed(db, job, `变式生成失败：${result.message}`, now))
      throw new VariantProviderFailure(result.message, {
        code: result.code,
        unavailable: result.code === 'ai_not_configured' || result.code === 'ai_capability_unsupported',
      })
    }

    lastProvider = result.route.provider
    let parsed: unknown
    try {
      parsed = parseModelJsonText(result.text)
    } catch {
      const message = '模型返回的不是有效 JSON'
      finishAuditedRun(
        db,
        handle.rowId,
        markFailed(handle.record, { code: 'ai_invalid_output', message }),
        now,
      )
      job = transaction(db, () => markJobFailed(db, job, `变式生成失败：${message}`, now))
      throw new VariantProviderFailure(message, { code: 'ai_invalid_output', unavailable: false })
    }

    const [clean, validationProblems] = validateVariantPayload(parsed, {
      question_type: String(sourceVersion.question_type),
      avoid_stems: [texts.stem],
    })
    const cleanRecord = isRecord(clean) ? (clean as Record<string, unknown>) : {}
    const digest = contentDigest(isRecord(cleanRecord['content']) ? (cleanRecord['content'] as Record<string, unknown>) : {})
    const draft = variantDraftPayload({
      clean: cleanRecord,
      sourceVersion: {
        questionId: String(question.id),
        questionType: String(sourceVersion.question_type),
        displayLabel: pyTruthy(question.display_label) ? String(question.display_label) : '',
        versionId: String(sourceVersion.id),
      },
      nodeId: input.node === null ? null : String(input.node.id),
      digest,
      runId: handle.rowId,
    })
    const checks = independentChecks(db, {
      payload: draft,
      sourceVersion,
      node: input.node,
      projectId: input.projectId,
    })
    const problems: VariantProblem[] = [...asVariantProblems(validationProblems), ...checks.problems]
    const blocking = problems.filter((problem) => (problem.severity ?? BLOCKING) === BLOCKING)
    blockingTotal += blocking.length
    if (blocking.length === 0) accepted += 1
    modelIdentifier = result.route.model
    const telemetry = telemetryOf(result)
    const runRecord = withCallTelemetry(handle.record, {
      provider: telemetry.provider,
      model: telemetry.model,
      promptTokens: telemetry.promptTokens,
      completionTokens: telemetry.completionTokens,
      latencyMs: telemetry.latencyMs,
      attempts: 1,
      costKnown: false,
      costCents: null,
      rawText: telemetry.rawText,
    })
    finishAuditedRun(
      db,
      handle.rowId,
      {
        ...runRecord,
        status: blocking.length > 0 ? 'rejected' : 'succeeded',
        // Django's proposal path leaves `error_code`/`error_message` empty for a rejected variant:
        // the problems are in `validation_result`, not in the transport error columns.
        error_code: '',
        error_message: '',
        validation_result: {
          accepted: blocking.length === 0,
          problems,
          validation_problems: validationProblems,
          independent_problems: checks.problems,
          content_digest: checks.content_digest,
          index,
        },
      },
      now,
    )

    const machinePayload = {
      producer: 'ai_variant',
      provider: result.route.provider,
      model: result.route.model,
      prompt_version: PROPOSE_VARIANT_PROMPT_VERSION,
      llm_run_id: handle.rowId,
      is_stub: false,
      variant_of_version_id: String(sourceVersion.id),
      variant_node_id: input.node === null ? '' : String(input.node.id),
      content_digest: digest,
      raw_response_excerpt: pySlice(result.text, 2000),
      model_output: {
        question_type: cleanRecord['question_type'] ?? null,
        difficulty_note: pyTruthy(cleanRecord['difficulty_note']) ? cleanRecord['difficulty_note'] : '',
        rationale: pyTruthy(cleanRecord['rationale']) ? cleanRecord['rationale'] : '',
        doubts: pyTruthy(cleanRecord['doubts']) ? cleanRecord['doubts'] : [],
      },
    }
    const created = transaction(db, () =>
      createCandidate(
        db,
        {
          job,
          payload: draft,
          subjectId: String(subject.id),
          machinePayload,
          isStubOutput: false,
          extractorVersion: PROPOSE_VARIANT_PROMPT_VERSION,
        },
        now,
      ),
    )
    const summary = variantCandidateSummary(created)
    candidates.push(summary)
    if (blocking.length > 0) {
      const message =
        `第 ${index + 1} 个候选未通过独立校验，已保留为待校对候选：` +
        blocking
          .slice(0, 5)
          .map((problem) => String(problem.message))
          .join('；')
      job = transaction(db, () =>
        addJobProblem(
          db,
          job,
          {
            code: 'variant_rejected',
            message,
            severity: 'warning',
            extra: { candidate_id: String(created.id), codes: problems.map((problem) => problem.code) },
          },
          now,
        ),
      )
    }
  }

  if (accepted === 0) {
    const message =
      `${effective} 个候选全部未通过校验，已全部保留在候选中等待人工处理：` +
      '没有任何内容通过校验，因此本次不会发布任何变式。'
    notes.push(message)
    job = transaction(db, () =>
      addJobProblem(db, job, { code: 'no_variant_usable', message, severity: 'warning' }, now),
    )
  }
  job = transaction(db, () => maybeCompleteJob(db, job, now))
  const finalJob = getRow(db, 'ingestion_import_job', job.id) ?? job
  return {
    job_id: String(finalJob.id),
    job_status: finalJob.status,
    project_id: String(finalJob.project_id),
    subject_id: String(subject.id),
    source_question_id: String(question.id),
    source_version_id: String(sourceVersion.id),
    node_id: input.node === null ? '' : String(input.node.id),
    node_name: input.node === null ? '' : String(input.node.canonical_name ?? ''),
    provider: lastProvider,
    model: modelIdentifier,
    is_stub: false,
    prompt_version: PROPOSE_VARIANT_PROMPT_VERSION,
    origin_type: 'ai_generated',
    requested_count: requested,
    count: effective,
    count_capped: effective < requested,
    candidates,
    validation: {
      requested_count: requested,
      count: effective,
      accepted,
      rejected: effective - accepted,
      blocking_problem_count: blockingTotal,
      nothing_passed: accepted === 0,
    },
    nothing_passed: accepted === 0,
    problems: candidates.flatMap((candidate) => candidate['review_issues'] as VariantProblem[]),
    notes,
  }
}

/* --------------------------------------------------------------- helpers */

function updateJob(
  db: DatabaseSync,
  job: Row,
  values: Record<string, unknown>,
  now: Instant,
): Row {
  const updated = updateRow(db, 'ingestion_import_job', job.id, values, { now })
  if (updated === null) throw new Error(`import job ${String(job.id)} is missing`)
  return updated
}

function markJobFailed(db: DatabaseSync, job: Row, error: string, now: Instant): Row {
  const locked = getRow(db, 'ingestion_import_job', job.id)
  if (locked === null) throw new Error(`import job ${String(job.id)} is missing`)
  const updated = updateRow(
    db,
    'ingestion_import_job',
    locked.id,
    { status: 'failed', last_error: pySlice(error, 500), finished_at: now },
    { now },
  )
  if (updated === null) throw new Error(`import job ${String(job.id)} is missing`)
  return updated
}

function parseModelJsonText(text: string): unknown {
  return parseModelJson(text)
}
