/**
 * Analytics reports: what is confirmed, what is not, and why.
 *
 * Port of `backend/apps/analytics/services/reports.py` (report + coverage part) and the snapshots
 * endpoint in `backend/apps/analytics/api.py`.
 *
 * Two properties are the whole point of the module and every branch preserves them:
 *
 *  - a report never merges unfinished work into one "official" number. Pending review, partial
 *    rubric confirmation, disputed content, invalidated grades and AI estimates are separated,
 *    counted, and make `final_result` null while anything in scope is unresolved;
 *  - a running verification (or mock exam) hides its content from every bucket. An aggregate over a
 *    parallel attempt leaks the same number a direct field would, so the attempts are excluded *by
 *    content* (same version, family or lineage), not only by session.
 *
 * The module is read-only except for the report snapshot the practice endpoint writes on purpose
 * (`save_snapshot=true`): the snapshot is the audit trail of what a report said at one instant.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { findOne, findRows, insertRow } from '../store/repository.ts'
import { coverageStatus, requireProject, requireSubject } from './exams.ts'
import { expireDueMockExams } from './sessions.ts'
import { verificationContentMap } from './learning.ts'

/** How many ids the incomplete-scope block lists per category. */
export const MAX_SCOPE_IDS = 200

/**
 * Every fact that makes a practice report partial, in presentation order.
 *
 * The codes are additive facts about one attempt (an attempt that is both disputed and waiting for
 * a human carries both), so per-code counts may overlap and `incomplete_attempts` is the distinct
 * number.
 */
export const INCOMPLETE_REASON_ORDER: readonly string[] = [
  'unscored',
  'pending_review',
  'partially_confirmed',
  'disputed_content',
  'invalidated_grade',
  'void_grade',
  'ai_estimated',
]

/** Reason code -> the sentence a human reads. It states what is missing, never "score = 0". */
export const INCOMPLETE_REASON_MESSAGES: Readonly<Record<string, string>> = {
  unscored: '尚未评分：这次作答没有有效判分记录，任何总分都不是最终结果',
  pending_review: '待人工评分：判分尚未确认，不能计入最终得分率或通过率',
  partially_confirmed: '部分评分点已确认、仍有未评分项：已确认分只是下界，不是最终得分',
  disputed_content: '答案或评分标准处于争议状态：争议解决前该题分数不作最终结果',
  invalidated_grade: '原判分已失效（答案争议/内容变更）：等待重新评分，旧分数不作最终结果',
  void_grade: '判分已作废（void）：无效分数不能作为最终结果',
  ai_estimated: '仅有 AI 估计分：估计分永不进入正式总分',
}

/** A bucket fraction is only a *final* rate when every mark in the bucket is confirmed. */
export const FRACTION_FINAL = 'final'
export const FRACTION_PARTIAL = 'partial_lower_bound'

type Row = Record<string, unknown>

/** One attempt with the frozen relations every report bucket reads. */
export interface AttemptContext {
  attempt: Row
  item: Row
  session: Row
  version: Row
  question: Row
  grade: Row | null
}

export interface ScopedAttempts {
  rows: AttemptContext[]
  hiddenRunCount: number
  hiddenContentCount: number
}

interface Bucket {
  attempts: number
  confirmedScore: Decimal
  maxScore: Decimal
  pendingMaxScore: Decimal
}

interface NodeBucket extends Bucket {
  nodeName: string
  weight: string
}

function emptyBucket(): Bucket {
  return {
    attempts: 0,
    confirmedScore: Decimal.zero(),
    maxScore: Decimal.zero(),
    pendingMaxScore: Decimal.zero(),
  }
}

/** Code-point string comparison (the C collation PostgreSQL contains by default). */
function compareCodePoints(left: string, right: string): number {
  const a = [...left]
  const b = [...right]
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    const x = a[index].codePointAt(0) ?? 0
    const y = b[index].codePointAt(0) ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

function decimalOf(value: unknown): Decimal {
  if (value instanceof Decimal) return value
  if (value === null || value === undefined) return Decimal.zero()
  return Decimal.parse(String(value))
}

function accumulate(bucket: Bucket, grade: Row | null, maxScore: Decimal): void {
  bucket.attempts += 1
  bucket.maxScore = bucket.maxScore.add(maxScore)
  if (grade === null) {
    bucket.pendingMaxScore = bucket.pendingMaxScore.add(maxScore)
    return
  }
  if (grade.confirmed_score !== null && grade.confirmed_score !== undefined) {
    bucket.confirmedScore = bucket.confirmedScore.add(decimalOf(grade.confirmed_score))
  }
  bucket.pendingMaxScore = bucket.pendingMaxScore.add(decimalOf(grade.pending_max_score))
}

function fractionOf(bucket: Bucket): string | null {
  if (bucket.maxScore.le(Decimal.zero()) || bucket.attempts === 0) return null
  return bucket.confirmedScore.div(bucket.maxScore).quantize(-4).toString()
}

function bucketOut(bucket: Bucket): Record<string, unknown> {
  const isFinal = bucket.pendingMaxScore.le(Decimal.zero())
  return {
    attempts: bucket.attempts,
    confirmed_score: bucket.confirmedScore.toString(),
    max_score: bucket.maxScore.toString(),
    pending_max_score: bucket.pendingMaxScore.toString(),
    confirmed_fraction: fractionOf(bucket),
    is_final: isFinal,
    fraction_status: isFinal ? FRACTION_FINAL : FRACTION_PARTIAL,
  }
}

function attemptContext(db: DatabaseSync, attempt: Row): AttemptContext | null {
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) return null
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (session === null || version === null) return null
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  if (question === null) return null
  const grade =
    attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined
      ? null
      : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
  return { attempt, item, session, version, question, grade }
}

function isHiddenRun(context: AttemptContext): boolean {
  const mode = String(context.session.mode)
  return (
    context.session.status === 'active' && (mode === 'verification' || mode === 'mock_exam')
  )
}

/**
 * Attempts excluded from reports because their grading is still hidden.
 *
 * Deliberately project-wide: the count is a disclosure about the report scope, not a per-subject
 * statistic, and Django reports it without applying the subject filter.
 */
export function hiddenVerificationAttemptCount(
  db: DatabaseSync,
  userId: string,
  projectId: string,
): number {
  let count = 0
  for (const attempt of findRows(db, 'practice_attempt', { project_id: projectId, user_id: userId })) {
    const context = attemptContext(db, attempt)
    if (context !== null && isHiddenRun(context)) count += 1
  }
  return count
}

/**
 * Every question version whose answers a running gated run still hides.
 *
 * Before the sweep this reconciles overdue mock exams, exactly like Django's
 * `blocked_question_version_ids`: a run the server has already ended must not keep hiding its
 * results from the report. The map itself only covers items that were actually presented
 * (`first_delivered_at`), because an item nobody saw cannot have leaked an answer.
 */
export function blockedQuestionVersionIds(db: DatabaseSync, userId: string, now: Instant): Set<string> {
  expireDueMockExams(db, userId, now)
  return new Set(verificationContentMap(db, userId).keys())
}

/**
 * The attempts any report may aggregate, plus what was kept out of scope.
 *
 * One definition of the two gates, so a new report cannot forget one:
 *  - attempts whose run still hides its grading are excluded;
 *  - attempts on content covered by a running verification/mock exam are excluded by the same
 *    content gate the other entry points use.
 */
export function scopedAttempts(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null; now: Instant },
): ScopedAttempts {
  requireProject(db, userId, projectId)
  const subjectId = options.subjectId ?? null
  if (subjectId !== null) requireSubject(db, userId, projectId, subjectId)

  const blocked = blockedQuestionVersionIds(db, userId, options.now)
  const all = findRows(db, 'practice_attempt', { project_id: projectId, user_id: userId })

  let hiddenRunCount = 0
  let hiddenContentCount = 0
  const visible: AttemptContext[] = []
  for (const attempt of all) {
    const context = attemptContext(db, attempt)
    if (context === null) continue
    if (isHiddenRun(context)) {
      hiddenRunCount += 1
      continue
    }
    if (blocked.has(String(context.item.question_version_id))) {
      hiddenContentCount += 1
      continue
    }
    visible.push(context)
  }

  const filtered =
    subjectId === null
      ? visible
      : visible.filter((context) => String(context.question.subject_id) === subjectId)
  // `order_by("-submitted_at")[:1000]`; equal instants keep their stored (rowid) order, which is
  // what the Python heap scan returns for the same seed order.
  filtered.sort((left, right) => {
    const a = left.attempt.submitted_at as Instant
    const b = right.attempt.submitted_at as Instant
    if (a === b) return 0
    return a > b ? -1 : 1
  })
  return { rows: filtered.slice(0, 1000), hiddenRunCount, hiddenContentCount }
}

/** Answer versions under dispute: what C06 means by "争议题". */
export function disputedAnswerKeyIds(db: DatabaseSync, projectId: string): Set<string> {
  const ids = new Set<string>()
  for (const answer of findRows(db, 'question_bank_answer_key_version', {})) {
    const version = findOne(db, 'question_bank_question_version', { id: String(answer.question_version_id) })
    if (version === null) continue
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
    if (question === null) continue
    const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
    if (subject === null || String(subject.project_id) !== projectId) continue
    if (answer.is_disputed === true || answer.verification_status === 'disputed') {
      ids.add(String(answer.id))
    }
  }
  return ids
}

/** Rubrics under dispute. A disputed rubric keeps its attempts unresolved. */
export function disputedRubricIds(db: DatabaseSync, projectId: string): Set<string> {
  const ids = new Set<string>()
  for (const rubric of findRows(db, 'question_bank_rubric_version', {})) {
    if (rubric.is_disputed !== true) continue
    const answer = findOne(db, 'question_bank_answer_key_version', { id: String(rubric.answer_key_version_id) })
    if (answer === null) continue
    const version = findOne(db, 'question_bank_question_version', { id: String(answer.question_version_id) })
    if (version === null) continue
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
    if (question === null) continue
    const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
    if (subject !== null && String(subject.project_id) === projectId) ids.add(String(rubric.id))
  }
  return ids
}

/**
 * Some scoring parts decided, some not — a result with a missing range.
 *
 * Checked from the frozen part list first (that is what the reviewer saw); the event-level fields
 * are the fallback for events written before parts existed.
 */
export function partiallyConfirmed(grade: Row): boolean {
  const parts = Array.isArray(grade.parts) ? (grade.parts as unknown[]) : []
  const statuses = parts
    .filter((part): part is Row => typeof part === 'object' && part !== null)
    .map((part) => part.status)
  if (statuses.length > 0) {
    return statuses.includes('confirmed') && statuses.some((status) => status !== 'confirmed')
  }
  return (
    grade.confirmed_score !== null &&
    grade.confirmed_score !== undefined &&
    grade.is_fully_confirmed !== true &&
    decimalOf(grade.pending_max_score).gt(Decimal.zero())
  )
}

/** Why one attempt's result is not final, in {@link INCOMPLETE_REASON_ORDER}. */
export function incompleteReasonCodes(
  context: AttemptContext,
  disputedAnswers: ReadonlySet<string>,
  disputedRubrics: ReadonlySet<string>,
): string[] {
  const codes = new Set<string>()
  const grade = context.grade
  if (grade === null) {
    codes.add('unscored')
  } else {
    if (grade.kind === 'invalidation') codes.add('invalidated_grade')
    else if (grade.status === 'pending_review') codes.add('pending_review')
    if (grade.status === 'void') codes.add('void_grade')
    if (grade.method === 'ai_estimated' || grade.status === 'estimated') codes.add('ai_estimated')
    if (
      grade.status !== 'void' &&
      (partiallyConfirmed(grade) || (grade.status === 'confirmed' && grade.is_fully_confirmed !== true))
    ) {
      codes.add('partially_confirmed')
    }
  }
  const answerIds = new Set<string>([
    String(context.item.answer_key_version_id ?? ''),
    grade === null ? '' : String(grade.answer_key_version_id ?? ''),
  ])
  const rubricIds = new Set<string>([
    String(context.item.rubric_version_id ?? ''),
    grade === null ? '' : String(grade.rubric_version_id ?? ''),
  ])
  let disputed = false
  for (const id of answerIds) if (disputedAnswers.has(id)) disputed = true
  for (const id of rubricIds) if (disputedRubrics.has(id)) disputed = true
  if (disputed) codes.add('disputed_content')
  return INCOMPLETE_REASON_ORDER.filter((code) => codes.has(code))
}

function idsOf(contexts: readonly AttemptContext[], attribute: 'attempt' | 'item' | 'question'): string[] {
  return contexts.map((context) => {
    if (attribute === 'attempt') return String(context.attempt.id)
    if (attribute === 'item') return String(context.item.id)
    return String(context.version.question_id)
  })
}

/** The unresolved range of one report: counts, ids and human reasons. */
export function incompleteScopePayload(
  contexts: readonly AttemptContext[],
  codesByAttempt: ReadonlyMap<string, readonly string[]>,
): Record<string, unknown> {
  const unresolved = contexts.filter((context) => (codesByAttempt.get(String(context.attempt.id)) ?? []).length > 0)
  const reasons: Record<string, unknown>[] = []
  for (const code of INCOMPLETE_REASON_ORDER) {
    const rows = unresolved.filter((context) =>
      (codesByAttempt.get(String(context.attempt.id)) ?? []).includes(code),
    )
    if (rows.length === 0) continue
    const attemptIds = idsOf(rows, 'attempt')
    reasons.push({
      code,
      message: INCOMPLETE_REASON_MESSAGES[code],
      attempt_count: rows.length,
      attempt_ids: attemptIds.slice(0, MAX_SCOPE_IDS),
      session_item_ids: idsOf(rows, 'item').slice(0, MAX_SCOPE_IDS),
      question_ids: [...new Set(idsOf(rows, 'question'))].sort().slice(0, MAX_SCOPE_IDS),
      ids_truncated: rows.length > MAX_SCOPE_IDS,
    })
  }
  const attemptIds = idsOf(unresolved, 'attempt')
  return {
    is_incomplete: unresolved.length > 0,
    attempts_in_scope: contexts.length,
    incomplete_attempts: unresolved.length,
    attempt_ids: attemptIds.slice(0, MAX_SCOPE_IDS),
    session_item_ids: idsOf(unresolved, 'item').slice(0, MAX_SCOPE_IDS),
    question_ids: [...new Set(idsOf(unresolved, 'question'))].sort().slice(0, MAX_SCOPE_IDS),
    ids_truncated: unresolved.length > MAX_SCOPE_IDS,
    reasons,
    missing_note: reasons.length > 0 ? reasons.map((row) => row.message as string).join('；') : null,
  }
}

/** Overall lower bound plus the final result, or `None` while partial. */
export function reportAggregate(
  contexts: readonly AttemptContext[],
  codesByAttempt: ReadonlyMap<string, readonly string[]>,
  selfAssessedIds: ReadonlySet<string>,
): { aggregate: Record<string, unknown>; finalResult: Record<string, unknown> | null } {
  let maxTotal = Decimal.zero()
  for (const context of contexts) maxTotal = maxTotal.add(decimalOf(context.item.max_score))
  let confirmedTotal = Decimal.zero()
  let selfAssessedCount = 0
  for (const context of contexts) {
    const grade = context.grade
    if (grade !== null && grade.status !== 'void' && grade.confirmed_score !== null && grade.confirmed_score !== undefined) {
      confirmedTotal = confirmedTotal.add(decimalOf(grade.confirmed_score))
    }
    if (selfAssessedIds.has(String(context.attempt.id))) selfAssessedCount += 1
  }
  const unresolvedIds = new Set<string>()
  for (const [attemptId, codes] of codesByAttempt) if (codes.length > 0) unresolvedIds.add(attemptId)
  const unresolvedTotal = maxTotal.sub(confirmedTotal)
  const rate = maxTotal.gt(Decimal.zero()) ? confirmedTotal.div(maxTotal).quantize(-4).toString() : null
  let status: string
  if (contexts.length === 0) status = 'no_data'
  else if (unresolvedIds.size > 0) status = FRACTION_PARTIAL
  else status = FRACTION_FINAL
  const reasonCodes = INCOMPLETE_REASON_ORDER.filter((code) =>
    [...codesByAttempt.values()].some((codes) => codes.includes(code)),
  )
  const aggregate: Record<string, unknown> = {
    status,
    attempts_in_scope: contexts.length,
    confirmed_score: confirmedTotal.toString(),
    max_score: maxTotal.toString(),
    unresolved_max_score: (status === FRACTION_PARTIAL ? unresolvedTotal : Decimal.zero()).toString(),
    unresolved_attempts: unresolvedIds.size,
    score_rate: status === FRACTION_FINAL ? rate : null,
    lower_bound: status === FRACTION_FINAL || status === FRACTION_PARTIAL ? rate : null,
    includes_self_assessed_attempts: selfAssessedCount,
    label:
      status === FRACTION_FINAL
        ? '最终得分率：范围内每一次作答都已确认'
        : status === FRACTION_PARTIAL
          ? `未完成：score_rate 已置空；lower_bound 只是已确认部分的下界，仍有 ${unresolvedTotal.toString()} 分未确认`
          : '没有可统计的作答：不显示任何推算数据',
    missing:
      status === FRACTION_PARTIAL
        ? {
            unresolved_max_score: unresolvedTotal.toString(),
            unresolved_attempts: unresolvedIds.size,
            reason_codes: reasonCodes,
            note: reasonCodes.map((code) => INCOMPLETE_REASON_MESSAGES[code]).join('；'),
          }
        : null,
  }
  if (status !== FRACTION_FINAL) return { aggregate, finalResult: null }
  return {
    aggregate,
    finalResult: {
      score_rate: rate,
      confirmed_score: confirmedTotal.toString(),
      max_score: maxTotal.toString(),
      attempts: contexts.length,
      includes_self_assessed_attempts: selfAssessedCount,
      basis: '范围内每一次作答都有已确认判分：无待评、无部分确认、无争议、无失效、无 AI 估计。',
    },
  }
}

function evidenceIds(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  dimension: string,
  qualifies: boolean,
): Set<string> {
  const ids = new Set<string>()
  for (const row of findRows(db, 'practice_learning_evidence', {
    user_id: userId,
    project_id: projectId,
    dimension,
    qualifies,
  })) {
    ids.add(String(row.attempt_id))
  }
  return ids
}

function mappingsForVersionRevision(db: DatabaseSync, versionId: string, revision: number): Row[] {
  // Django's `knowledge_mappings.filter(mapping_revision=...)` keeps the model ordering
  // (`question_version, mapping_revision, node`), which for one revision is node order.
  const rows = findRows(db, 'knowledge_question_mapping', {
    question_version_id: versionId,
    mapping_revision: revision,
  })
  rows.sort((left, right) => String(left.node_id).localeCompare(String(right.node_id)))
  return rows
}

/**
 * Practice evidence report: what is confirmed, what is not, and why.
 *
 * Attempts that belong to a run whose grading is still hidden are excluded from every bucket, and
 * so are attempts on content a running verification covers. Both exclusions are reported, because
 * a silently smaller denominator is its own kind of lie.
 */
export function buildPracticeReport(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null; saveSnapshot?: boolean; now: Instant },
): Record<string, unknown> {
  const now = options.now
  const saveSnapshot = options.saveSnapshot ?? true
  const project = requireProject(db, userId, projectId)
  const subject = options.subjectId === null || options.subjectId === undefined
    ? null
    : requireSubject(db, userId, projectId, options.subjectId)

  const scoped = scopedAttempts(db, userId, projectId, { subjectId: subject === null ? null : String(subject.id), now })
  const contexts = scoped.rows

  let fullyGraded = emptyBucket()
  let pendingReview = emptyBucket()
  let selfAssessed = emptyBucket()
  let assisted = emptyBucket()
  let repeatPractice = emptyBucket()
  let partiallyGraded = emptyBucket()
  let aiEstimated = emptyBucket()
  let firstContact = emptyBucket()
  const byType = new Map<string, Bucket>()
  const byNode = new Map<string, NodeBucket>()
  const notes: string[] = []

  const assistedIds = evidenceIds(db, userId, projectId, 'unassisted_completion', false)
  const independentIds = evidenceIds(db, userId, projectId, 'independent_correct', true)
  const disputedAnswers = disputedAnswerKeyIds(db, projectId)
  const disputedRubrics = disputedRubricIds(db, projectId)
  const selfAssessedIds = new Set<string>()
  const codesByAttempt = new Map<string, string[]>()

  for (const context of contexts) {
    const item = context.item
    const grade = context.grade
    const maxScore = decimalOf(item.max_score)
    const questionType = String(context.version.question_type)

    accumulate(repeatPractice, grade, maxScore)
    let typeBucket = byType.get(questionType)
    if (typeBucket === undefined) {
      typeBucket = emptyBucket()
      byType.set(questionType, typeBucket)
    }
    accumulate(typeBucket, grade, maxScore)

    if (grade === null || grade.status === 'pending_review') {
      accumulate(pendingReview, grade, maxScore)
    } else if (grade.method === 'ai_estimated') {
      accumulate(aiEstimated, grade, maxScore)
    } else if (grade.method === 'self_confirmed' || grade.grader_is_self === true) {
      accumulate(selfAssessed, grade, maxScore)
      selfAssessedIds.add(String(context.attempt.id))
    } else if (grade.is_fully_confirmed === true) {
      accumulate(fullyGraded, grade, maxScore)
    } else {
      accumulate(partiallyGraded, grade, maxScore)
    }

    codesByAttempt.set(
      String(context.attempt.id),
      incompleteReasonCodes(context, disputedAnswers, disputedRubrics),
    )

    if (assistedIds.has(String(context.attempt.id))) accumulate(assisted, grade, maxScore)
    if (independentIds.has(String(context.attempt.id))) accumulate(firstContact, grade, maxScore)

    for (const mapping of mappingsForVersionRevision(db, String(context.version.id), Number(item.mapping_revision))) {
      const nodeKey = String(mapping.node_id)
      let nodeBucket = byNode.get(nodeKey)
      if (nodeBucket === undefined) {
        const node = findOne(db, 'knowledge_node', { id: nodeKey })
        nodeBucket = {
          ...emptyBucket(),
          nodeName: node === null ? '' : String(node.canonical_name),
          weight: decimalOf(mapping.score_weight).toString(),
        }
        byNode.set(nodeKey, nodeBucket)
      }
      const weight = decimalOf(mapping.score_weight)
      nodeBucket.attempts += 1
      nodeBucket.maxScore = nodeBucket.maxScore.add(maxScore.mul(weight))
      if (grade !== null && grade.confirmed_score !== null && grade.confirmed_score !== undefined) {
        nodeBucket.confirmedScore = nodeBucket.confirmedScore.add(decimalOf(grade.confirmed_score).mul(weight))
      }
      if (grade === null) {
        nodeBucket.pendingMaxScore = nodeBucket.pendingMaxScore.add(maxScore.mul(weight))
      } else {
        nodeBucket.pendingMaxScore = nodeBucket.pendingMaxScore.add(decimalOf(grade.pending_max_score).mul(weight))
      }
    }
  }

  const repeatIds = evidenceIds(db, userId, projectId, 'repeat_practice', true)
  if (repeatIds.size > 0) {
    notes.push(`其中 ${repeatIds.size} 次属于重复练习（同题多次作答单独统计）。`)
  }
  const pendingAttempts = pendingReview.attempts + partiallyGraded.attempts
  if (pendingAttempts) {
    notes.push(
      `有 ${pendingAttempts} 次作答尚未完全确认（待人工评分或缺规则）：不计入完整正确率，也不当作错题或 0 分。`,
    )
  }
  if (selfAssessed.attempts) {
    notes.push(`有 ${selfAssessed.attempts} 次为自评确认：单列展示，不作为独立能力证据。`)
  }
  if (assisted.attempts) {
    notes.push(`有 ${assisted.attempts} 次为辅助作答：单独统计，不计入严格独立证据。`)
  }
  if (aiEstimated.attempts) {
    notes.push(`有 ${aiEstimated.attempts} 次仅有 AI 估计分：不进入正式总分。`)
  }
  if (scoped.hiddenRunCount) {
    notes.push(
      `有 ${scoped.hiddenRunCount} 次作答属于尚未结束的验证/考试：在结束前不计入任何统计，也不会通过报告泄露分数。`,
    )
  }
  if (scoped.hiddenContentCount) {
    notes.push(
      `另有 ${scoped.hiddenContentCount} 次作答与正在进行的验证内容相同（同题、同题族或同源内容）：` +
        '在验证结束前同样不计入任何统计，避免用平行练习的分数反推答案。',
    )
  }
  if (contexts.length === 0) {
    notes.push('本项目还没有作答记录：报告不显示任何推算数据。')
  }

  const incompleteScope = incompleteScopePayload(contexts, codesByAttempt)
  const { aggregate, finalResult } = reportAggregate(contexts, codesByAttempt, selfAssessedIds)
  if (incompleteScope['is_incomplete'] === true) {
    const reasonText = (incompleteScope['reasons'] as Record<string, unknown>[])
      .map((row) => row.message as string)
      .join('；')
    notes.push(
      `报告未完成：${incompleteScope['incomplete_attempts'] as number} 次作答仍有未确认部分（${reasonText}）。` +
        '此时不输出最终得分率/通过率/排名：final_result 为 null，' +
        'aggregate.score_rate 也为 null，只保留标注为下界的 aggregate.lower_bound 与未确认分值。',
    )
  } else if (finalResult !== null) {
    notes.push(
      '范围内作答均已确认：final_result 可用（' +
        `${finalResult['attempts'] as number} 次作答，最终得分率 ${finalResult['score_rate'] as string}）。`,
    )
  }

  const excluded: Record<string, unknown>[] = []
  for (const row of findRows(db, 'practice_learning_evidence', {
    user_id: userId,
    project_id: projectId,
    is_active: true,
    qualifies: false,
  })) {
    const attempt = findOne(db, 'practice_attempt', { id: String(row.attempt_id) })
    if (attempt !== null) {
      const context = attemptContext(db, attempt)
      if (context !== null && isHiddenRun(context)) continue
    }
    if (excluded.length >= 200) break
    excluded.push({
      attempt_id: String(row.attempt_id),
      dimension: row.dimension,
      reasons: row.exclusion_reasons,
      node_id: row.knowledge_node_id === null || row.knowledge_node_id === undefined
        ? null
        : String(row.knowledge_node_id),
    })
  }

  const payload: Record<string, unknown> = {
    report_kind: 'practice',
    calculation_version: 'p0-2-c06',
    as_of: formatPythonIso(now),
    project_id: String(project.id),
    subject_id: subject === null ? null : String(subject.id),
    result_status: {
      no_data: 'no_data',
      [FRACTION_FINAL]: 'final',
      [FRACTION_PARTIAL]: 'incomplete',
    }[aggregate['status'] as string],
    incomplete_scope: incompleteScope,
    aggregate,
    final_result: finalResult,
    totals: {
      fully_graded: bucketOut(fullyGraded),
      partially_graded: bucketOut(partiallyGraded),
      fully_confirmed: bucketOut(fullyGraded),
      partially_pending: bucketOut(partiallyGraded),
      pending_review: bucketOut(pendingReview),
      self_assessed: bucketOut(selfAssessed),
      assisted: bucketOut(assisted),
      repeat_practice: bucketOut(repeatPractice),
      strict_independent: bucketOut(firstContact),
      ai_estimated: bucketOut(aiEstimated),
    },
    hidden_verification_attempts: scoped.hiddenRunCount,
    hidden_verification_content_attempts: scoped.hiddenContentCount,
    by_question_type: Object.fromEntries([...byType].map(([key, value]) => [key, bucketOut(value)])),
    by_knowledge_node: Object.fromEntries(
      [...byNode].map(([key, value]) => [
        key,
        { ...bucketOut(value), node_name: value.nodeName, weight: value.weight },
      ]),
    ),
    excluded_evidence: excluded,
    notes,
  }

  if (saveSnapshot) {
    insertRow(
      db,
      'analytics_report_snapshot',
      {
        user_id: userId,
        project_id: projectId,
        subject_id: subject === null ? null : subject.id,
        report_kind: 'practice',
        calculation_version: 'p0-2-c06',
        input_watermark: {
          attempt_count: contexts.length,
          hidden_verification_attempts: scoped.hiddenRunCount,
          latest_attempt_at:
            contexts.length > 0 ? formatPythonIso(contexts[0].attempt.submitted_at as Instant) : null,
          evidence_count: findRows(db, 'practice_learning_evidence', {
            user_id: userId,
            project_id: projectId,
            is_active: true,
          }).length,
          incomplete_attempts: incompleteScope['incomplete_attempts'],
          result_status: payload['result_status'],
        },
        filters: {
          subject_id: subject === null ? null : String(subject.id),
          node_id: null,
        },
        as_of: now,
        payload,
        notes,
      },
      { now },
    )
  }
  return payload
}

/** One snapshot row as the list endpoint projects it (`list_snapshots`). */
export function listSnapshots(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { limit?: number } = {},
): Record<string, unknown>[] {
  requireProject(db, userId, projectId)
  const raw = options.limit ?? 10
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? Math.trunc(raw) : 10, 50))
  const rows = findRows(db, 'analytics_report_snapshot', { user_id: userId, project_id: projectId })
  rows.sort((left, right) => {
    const a = left.as_of as Instant
    const b = right.as_of as Instant
    if (a === b) return 0
    return a > b ? -1 : 1
  })
  return rows.slice(0, limit).map((row) => ({
    snapshot_id: String(row.id),
    report_kind: row.report_kind,
    as_of: formatPythonIso(row.as_of as Instant),
    calculation_version: row.calculation_version,
    is_stale: row.is_stale,
    input_watermark: row.input_watermark,
    notes: row.notes,
    payload: row.payload,
  }))
}

/** Per-cycle coverage, honestly reporting unknown or incomplete cycles. */
export function paperCoverage(db: DatabaseSync, subjectId: string): Record<string, unknown>[] {
  const subject = findOne(db, 'exams_subject', { id: subjectId })
  if (subject === null) return []
  const papers = findRows(db, 'exams_paper', { subject_id: subjectId })
  // Django orders by `cycle_key` with the database collation (C in the test database); comparing
  // code points matches that and avoids `localeCompare`'s locale-specific case ordering.
  papers.sort((left, right) => compareCodePoints(String(left.cycle_key), String(right.cycle_key)))
  const rows: Record<string, unknown>[] = []
  for (const paper of papers) {
    const revision =
      paper.effective_revision_id === null || paper.effective_revision_id === undefined
        ? null
        : findOne(db, 'exams_paper_revision', { id: String(paper.effective_revision_id) })
    const items = revision === null
      ? []
      : findRows(db, 'exams_paper_item', { revision_id: revision.id, is_scored: true }, {
          orderBy: [['revision_id', 'asc'], ['position_key', 'asc']],
        })
    const unscoredItemCount = revision === null
      ? 0
      : findRows(db, 'exams_paper_item', { revision_id: revision.id, is_scored: false }).length
    const status = revision === null ? 'coverage_unknown' : coverageStatus(revision)
    const totalItems = items.length + unscoredItemCount
    const isFinal = status === 'coverage_complete'
    let totalScore = Decimal.zero()
    for (const item of items) totalScore = totalScore.add(decimalOf(item.max_score))
    rows.push({
      paper_id: String(paper.id),
      cycle_key: paper.cycle_key,
      session_key: paper.session_key,
      paper_code: paper.paper_code,
      source_kind: paper.source_kind,
      is_demo: paper.is_demo,
      effective_revision_id: revision === null ? null : String(revision.id),
      coverage_status: status,
      scored_item_count: items.length,
      unscored_item_count: unscoredItemCount,
      total_item_count: totalItems,
      total_score: revision === null ? '0' : totalScore.toString(),
      coverage_rate:
        isFinal && totalItems > 0
          ? Decimal.fromInt(items.length).div(Decimal.fromInt(totalItems)).quantize(-4).toString()
          : null,
      coverage_rate_status: isFinal ? FRACTION_FINAL : FRACTION_PARTIAL,
      coverage_rate_note: isFinal
        ? '覆盖完整性已人工确认：覆盖率可作为最终值。'
        : `覆盖状态为 ${status}：不给出覆盖率（未确认完整前任何比率都可能是假的）。`,
    })
  }
  return rows
}

/** Whether one subject's coverage may be read as a completed whole. */
export function coverageCompletion(
  db: DatabaseSync,
  subjectId: string,
  papers?: Record<string, unknown>[],
): Record<string, unknown> {
  const rows = papers ?? paperCoverage(db, subjectId)
  const blockCode = (row: Record<string, unknown>): string => {
    if (row['effective_revision_id'] === null || row['effective_revision_id'] === undefined) {
      return 'no_effective_revision'
    }
    return String(row['coverage_status'])
  }
  const blocked = rows.filter((row) => row['coverage_rate_status'] !== FRACTION_FINAL)
  const reasons: Record<string, unknown>[] = []
  for (const [code, message] of [
    ['coverage_unknown', '未登记预期场次/卷别：不能判断该周期是否完整'],
    ['coverage_incomplete', '覆盖未完整或未经人工确认：不能给出完成率'],
    ['no_effective_revision', '没有有效版本：该试卷没有任何可计分题项'],
  ] as const) {
    const selected = blocked.filter((row) => blockCode(row) === code)
    if (selected.length === 0) continue
    reasons.push({
      code,
      message,
      paper_count: selected.length,
      paper_ids: selected.map((row) => row.paper_id).slice(0, MAX_SCOPE_IDS),
      cycle_keys: [...new Set(selected.map((row) => String(row.cycle_key)))].sort(),
    })
  }
  let scoredTotal = 0
  let unscoredTotal = 0
  for (const row of rows) {
    scoredTotal += Number(row['scored_item_count'])
    unscoredTotal += Number(row['unscored_item_count'])
  }
  const isFinal = rows.length > 0 && blocked.length === 0
  const rate =
    rows.length > 0
      ? Decimal.fromInt(rows.length - blocked.length).div(Decimal.fromInt(rows.length)).quantize(-4).toString()
      : null
  return {
    status: rows.length === 0 ? 'no_data' : isFinal ? FRACTION_FINAL : FRACTION_PARTIAL,
    papers_total: rows.length,
    papers_coverage_complete: rows.length - blocked.length,
    coverage_rate: isFinal ? rate : null,
    lower_bound: rate,
    items: { scored_total: scoredTotal, unscored_total: unscoredTotal },
    incomplete_scope: {
      is_incomplete: blocked.length > 0,
      papers_total: rows.length,
      blocked_paper_count: blocked.length,
      blocked_paper_ids: blocked.map((row) => row.paper_id).slice(0, MAX_SCOPE_IDS),
      reasons,
      missing_note: reasons.length > 0 ? reasons.map((row) => row.message as string).join('；') : null,
    },
    final_result: isFinal
      ? {
          coverage_rate: rate,
          papers_total: rows.length,
          basis: '全部已登记试卷都有已人工确认覆盖完整的有效版本。',
        }
      : null,
    note: isFinal
      ? '全部试卷覆盖完整：覆盖率可作为最终值。'
      : '覆盖不完整：不输出完成率，只列出未完整试卷与原因（final_result 为 null）。',
  }
}
