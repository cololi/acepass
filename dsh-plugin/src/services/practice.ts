/**
 * Attempt submission: store the raw answer and its initial grade.
 *
 * Port of `backend/apps/practice/services/attempts.py` (submit + initial grade).
 *
 * The ordering here is the whole point of the module:
 *  1. the item is re-read (the frozen versions are what grading may use);
 *  2. the exam deadline is enforced *before* the status check, so a late answer is refused as
 *     "the deadline passed" rather than a vague "session over";
 *  3. a second submission for the same item is refused, not overwritten;
 *  4. the raw answer is stored even when grading must go to review, because the learner's answer is
 *     evidence and a disputed answer version must not lose it.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { parseInstant, formatPythonIso, type Instant } from '../domain/instant.ts'
import { grade as gradeAnswer, resultToDict, type GradeResult } from '../domain/grading.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { enqueue } from '../store/outbox.ts'
import { pyJsonCanonical } from '../store/pyjson.ts'
import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { AlreadySubmitted, InvalidInput, PurposeNotAllowed, ScopeViolation, StructureInvalid, VersionConflict } from './errors.ts'
import { expireSessionIfDue } from './sessions.ts'
import { onAttemptGraded } from './pairing.ts'

const SESSION_ACTIVE = 'active'
const SESSION_MODE_MOCK_EXAM = 'mock_exam'
const GRADE_KIND_INITIAL = 'initial'
const GRADE_METHOD_MIXED = 'mixed'
const GRADE_STATUS_PENDING_REVIEW = 'pending_review'
/** The grading rule set version, stored on every grade event (`GradeEvent.rule_version` default). */
const RULE_VERSION = 'p0-1'

const ANSWER_RULE_KEYS = ['policy', 'partial_score', 'wrong_score', 'blank_score', 'mismatch_policy'] as const

export interface SubmitPayload {
  raw_answer: Record<string, unknown>
  steps?: unknown[]
  confidence?: string
  client_active_ms?: number | null
  /** `asset_ids` on the wire: photos uploaded before submitting (Django `_validate_attachments`). */
  asset_ids?: string[]
}

/** Django settings: `ATTEMPT_MAX_ATTACHMENTS` / `ATTEMPT_MAX_ATTACHMENT_BYTES`. */
export const ATTEMPT_MAX_ATTACHMENTS = 6
export const ATTEMPT_MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024

/**
 * Validate the attachments a submission names (`attempts.py::_validate_attachments`).
 *
 * The assets must already belong to this project and this user: an id from another project is a
 * scope violation, not a silent drop. Returning the ids in request order is what the reviewer later
 * sees, so the order is preserved rather than sorted.
 */
export function validateAttachments(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  assetIds: string[],
): string[] {
  if (assetIds.length === 0) return []
  if (assetIds.length > ATTEMPT_MAX_ATTACHMENTS) {
    throw new InvalidInput(`每道作答最多上传 ${ATTEMPT_MAX_ATTACHMENTS} 张图片`)
  }
  const unique = new Set(assetIds.map((id) => String(id)))
  const found = [...unique]
    .map((id) => findOne(db, 'ingestion_asset', { id }))
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter((row) => String(row.project_id) === String(projectId) && String(row.owner_id) === String(userId))
  if (found.length !== unique.size) throw new ScopeViolation('附件不存在或不属于当前项目')
  const total = found.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0)
  if (total > ATTEMPT_MAX_ATTACHMENT_BYTES) throw new InvalidInput('附件总大小超过上限')
  return assetIds.map((id) => String(id))
}

function questionOf(db: DatabaseSync, questionVersionId: string): Record<string, unknown> {
  return findOne(db, 'question_bank_question_version', { id: questionVersionId }) ?? {}
}

/** `rule_for()` — the spec's rule for one question type, or `{}`. */
export function specRuleFor(spec: Record<string, unknown> | null, questionType: string): Record<string, unknown> {
  const rules = (spec?.question_type_rules ?? {}) as Record<string, unknown>
  const rule = rules[questionType]
  return typeof rule === 'object' && rule !== null && !Array.isArray(rule) ? { ...(rule as Record<string, unknown>) } : {}
}

/** `merged_rule()` — spec defaults, overridden by explicit answer-level rules. */
export function mergedRule(
  spec: Record<string, unknown> | null,
  answerPayload: Record<string, unknown>,
  questionType: string,
): Record<string, unknown> {
  const rule: Record<string, unknown> = { ...specRuleFor(spec, questionType) }
  for (const key of ANSWER_RULE_KEYS) {
    if (answerPayload[key] !== null && answerPayload[key] !== undefined) rule[key] = answerPayload[key]
  }
  return rule
}

/** The rule snapshot frozen at submission time; it is persisted, so it must be reproducible. */
export function ruleSnapshot(input: {
  spec: Record<string, unknown> | null
  specVersionId: string | null
  questionType: string
  answerPayload: Record<string, unknown>
  maxScore: string
}): Record<string, unknown> {
  const answerRule: Record<string, unknown> = {}
  for (const key of ANSWER_RULE_KEYS) {
    if (input.answerPayload[key] !== null && input.answerPayload[key] !== undefined) {
      answerRule[key] = input.answerPayload[key]
    }
  }
  return {
    spec_version_id: input.specVersionId,
    question_type: input.questionType,
    spec_rule: specRuleFor(input.spec, input.questionType),
    answer_rule: answerRule,
    max_score: input.maxScore,
  }
}

/** The submitted answer must match the question actually presented. */
export function validateAnswerShape(
  questionType: string,
  content: Record<string, unknown>,
  rawAnswer: unknown,
): void {
  if (typeof rawAnswer !== 'object' || rawAnswer === null || Array.isArray(rawAnswer)) {
    throw new StructureInvalid('作答必须是对象')
  }
  const answer = rawAnswer as Record<string, unknown>
  const declared = answer['type']
  if (declared !== questionType) {
    throw new StructureInvalid('作答类型与题目类型不一致', {
      details: { expected: questionType, received: declared },
    })
  }

  if (questionType === 'single_choice' || questionType === 'multiple_choice') {
    const options = Array.isArray(content['options']) ? (content['options'] as unknown[]) : []
    const allowed = new Set(
      options
        .filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null)
        .map((option) => String(option['id'])),
    )
    let selected: unknown = answer['selected_option_ids']
    if (selected === undefined && answer['selected_option_id'] !== undefined && answer['selected_option_id'] !== null) {
      selected = [answer['selected_option_id']]
    }
    if (selected === undefined || selected === null) selected = []
    if (!Array.isArray(selected)) throw new StructureInvalid('选项作答必须是数组')
    const unknown = selected.map((value) => String(value)).filter((value) => !allowed.has(value))
    if (unknown.length > 0) {
      throw new StructureInvalid('提交了不属于该题的选项 ID', { details: { unknown_option_ids: unknown } })
    }
    if (new Set(selected.map((value) => String(value))).size !== selected.length) {
      throw new StructureInvalid('同一选项被重复提交')
    }
    if (questionType === 'single_choice' && selected.length > 1) {
      throw new StructureInvalid('单选题只能选择一个选项')
    }
  } else if (questionType === 'true_false') {
    const value = answer['value']
    if (value !== undefined && value !== null && typeof value !== 'boolean') {
      throw new StructureInvalid('判断题作答必须是 true/false，或留空表示未答')
    }
  } else if (questionType === 'fill_blank') {
    const blanks = answer['blanks']
    if (blanks !== undefined && blanks !== null && (typeof blanks !== 'object' || Array.isArray(blanks))) {
      throw new StructureInvalid('填空作答必须按空位 ID 给出对象')
    }
    const contentBlanks = Array.isArray(content['blanks']) ? (content['blanks'] as unknown[]) : []
    const allowedBlankIds = new Set(
      contentBlanks
        .filter((blank): blank is Record<string, unknown> => typeof blank === 'object' && blank !== null)
        .map((blank) => String(blank['blank_id'])),
    )
    for (const [blankId, value] of Object.entries((blanks ?? {}) as Record<string, unknown>)) {
      if (allowedBlankIds.size > 0 && !allowedBlankIds.has(String(blankId))) {
        throw new StructureInvalid(`提交了不属于该题的空位：${blankId}`)
      }
      if (value !== null && value !== undefined && typeof value !== 'string') {
        throw new StructureInvalid('空位作答必须是字符串原文')
      }
    }
  }
}

function answerKey(db: DatabaseSync, item: Record<string, unknown>): Record<string, unknown> | null {
  if (item.answer_key_version_id === null || item.answer_key_version_id === undefined) return null
  return findOne(db, 'question_bank_answer_key_version', { id: item.answer_key_version_id })
}

function rubricOf(db: DatabaseSync, item: Record<string, unknown>): Record<string, unknown> | null {
  if (item.rubric_version_id === null || item.rubric_version_id === undefined) return null
  return findOne(db, 'question_bank_rubric_version', { id: item.rubric_version_id })
}

function specOf(db: DatabaseSync, item: Record<string, unknown>): Record<string, unknown> | null {
  if (item.spec_version_id === null || item.spec_version_id === undefined) return null
  return findOne(db, 'exams_spec_version', { id: item.spec_version_id })
}

/**
 * Why the frozen grading input may no longer be trusted.
 *
 * An answer that became disputed after the item was presented must not keep grading new
 * submissions: the raw answer is still stored, and the grading goes to a human.
 */
export function trustBlocker(db: DatabaseSync, item: Record<string, unknown>): string | null {
  const answer = answerKey(db, item)
  if (answer !== null && (answer.is_disputed === true || answer.verification_status !== 'checked')) {
    return '本题固定答案已进入争议或失去可信状态：本次原始作答已保存，判分转人工复核'
  }
  const rubric = rubricOf(db, item)
  if (rubric !== null && rubric.is_disputed === true) {
    return '本题固定评分标准已进入争议：本次原始作答已保存，判分转人工复核'
  }
  return null
}

/** Grade one submission deterministically, or mark it pending where the rules cannot decide. */
function gradeSubmission(
  db: DatabaseSync,
  item: Record<string, unknown>,
  questionType: string,
  rawAnswer: Record<string, unknown>,
  maxScore: Decimal,
): { result: GradeResult; snapshot: Record<string, unknown>; pending: boolean } {
  const answer = answerKey(db, item)
  const rubric = rubricOf(db, item)
  const spec = specOf(db, item)
  const answerPayload = (answer?.answer_payload ?? {}) as Record<string, unknown>
  const snapshot = ruleSnapshot({
    spec,
    specVersionId: item.spec_version_id === null || item.spec_version_id === undefined ? null : String(item.spec_version_id),
    questionType,
    answerPayload,
    maxScore: maxScore.toString(),
  })
  const rule = mergedRule(spec, answerPayload, questionType)
  const rubricPayload =
    rubric === null ? null : { criteria: rubric.criteria, total_score: String(rubric.total_score) }
  const result = gradeAnswer({
    question_type: questionType,
    raw_answer: rawAnswer,
    answer_payload: answerPayload,
    max_score: maxScore,
    rule,
    rubric: rubricPayload,
  })
  return { result, snapshot, pending: result.status === GRADE_STATUS_PENDING_REVIEW }
}

export interface SubmitResult {
  attempt: Record<string, unknown>
  grade: Record<string, unknown>
}

const DECIMAL_GRADE_FIELDS = ['confirmed_score', 'max_score', 'pending_max_score', 'estimated_score'] as const

/** Decimals leave the service as their wire format (`"2.00"`), never as objects. */
function gradeToWire(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const field of DECIMAL_GRADE_FIELDS) {
    const value = out[field]
    if (value !== null && value !== undefined && typeof value === 'object') out[field] = String(value)
  }
  return out
}

/** Store the attempt and its initial grade event. */
export function submitAttempt(
  db: DatabaseSync,
  userId: string,
  sessionItemId: string,
  payload: SubmitPayload,
  now: Instant,
): SubmitResult {
  return transaction(db, () => {
    const item = findOne(db, 'practice_session_item', { id: sessionItemId })
    if (item === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
    const session = findOne(db, 'practice_session', { id: String(item.session_id) })
    if (session === null || String(session.user_id) !== String(userId)) {
      throw new ScopeViolation('题项不存在或不在当前权限范围')
    }

    // Deadline first: an overdue exam is refused as "the deadline passed" (409), not "session over".
    if (session.mode === SESSION_MODE_MOCK_EXAM && session.exam_deadline !== null) {
      const deadline = session.exam_deadline as Instant
      if (now >= deadline) {
        throw new VersionConflict(
          `模拟考试已于 ${formatPythonIso(deadline)} 结束，服务器已自动交卷并对已提交的作答判分；不能再提交新的作答。`,
          {
            details: {
              reason: 'exam_deadline_passed',
              exam_deadline: formatPythonIso(deadline),
              session_id: String(session.id),
            },
          },
        )
      }
    }
    if (session.status !== SESSION_ACTIVE) {
      throw new InvalidInput('会话已结束，不能继续提交')
    }

    const existing = findOne(db, 'practice_attempt', { session_item_id: sessionItemId })
    if (existing !== null) {
      throw new AlreadySubmitted('该题项已提交，请新建题项重做', {
        details: { attempt_id: String(existing.id) },
      })
    }

    const questionVersion = questionOf(db, String(item.question_version_id))
    const questionType = String(questionVersion.question_type)
    const attachments = validateAttachments(
      db,
      userId,
      String(session.project_id),
      Array.isArray(payload.asset_ids) ? payload.asset_ids.map(String) : [],
    )
    const content = (questionVersion.content ?? {}) as Record<string, unknown>
    validateAnswerShape(questionType, content, payload.raw_answer)

    const elapsedMs =
      item.first_delivered_at === null || item.first_delivered_at === undefined
        ? 0
        : Math.max(0, Math.trunc(Number(now - (item.first_delivered_at as Instant)) / 1000))

    const attempt = insertRow(
      db,
      'practice_attempt',
      {
        session_item_id: item.id,
        user_id: userId,
        project_id: session.project_id,
        raw_answer: payload.raw_answer,
        steps: payload.steps ?? [],
        attachments: attachments,
        confidence: String(payload.confidence ?? '').slice(0, 16),
        submitted_at: now,
        elapsed_ms: elapsedMs,
        client_active_ms: payload.client_active_ms ?? null,
        // A digest of the submitted request, so a replay can be recognised without re-grading.
        request_digest: createHash('sha256').update(pyJsonCanonical(payload.raw_answer), 'utf8').digest('hex'),
        idempotency_key: '',
        current_grade_event_id: null,
        grading_revision: 0,
        applied_regrade_generation: 0,
      },
      { now },
    )

    const maxScore = Decimal.parse(String(item.max_score))
    const blocker = trustBlocker(db, item)
    let gradeRow: Record<string, unknown>
    if (blocker !== null) {
      // The raw answer is stored; grading goes to a human with the reason attached.
      gradeRow = insertRow(
        db,
        'practice_grade_event',
        {
          attempt_id: attempt.id,
          kind: GRADE_KIND_INITIAL,
          status: GRADE_STATUS_PENDING_REVIEW,
          method: GRADE_METHOD_MIXED,
          grading_revision: 1,
          confirmed_score: null,
          max_score: maxScore,
          pending_max_score: maxScore,
          estimated_score: null,
          is_fully_confirmed: false,
          is_superseded: false,
          parts: [],
          rule_snapshot: { reason: blocker },
          rule_version: RULE_VERSION,
          grader_is_self: false,
          comment: '',
          invalidation_reason: '',
          answer_key_version_id: item.answer_key_version_id ?? null,
          rubric_version_id: item.rubric_version_id ?? null,
          spec_version_id: item.spec_version_id ?? null,
          grader_id: null,
          supersedes_id: null,
          llm_run_id: null,
        },
        { now },
      )
    } else {
      const { result, snapshot } = gradeSubmission(db, item, questionType, payload.raw_answer, maxScore)
      gradeRow = insertRow(
        db,
        'practice_grade_event',
        {
          attempt_id: attempt.id,
          kind: GRADE_KIND_INITIAL,
          status: result.status,
          method: result.method,
          grading_revision: 1,
          confirmed_score: result.confirmed_score,
          max_score: maxScore,
          pending_max_score: result.pending_max_score,
          estimated_score: null,
          is_fully_confirmed: result.is_fully_confirmed,
          is_superseded: false,
          // `parts` is the per-item breakdown the reviewer confirms; it comes from the same
          // serialisation the grading golden vectors pin.
          parts: resultToDict(result).parts,
          rule_snapshot: snapshot,
          rule_version: RULE_VERSION,
          grader_is_self: false,
          comment: '',
          invalidation_reason: '',
          answer_key_version_id: item.answer_key_version_id ?? null,
          rubric_version_id: item.rubric_version_id ?? null,
          spec_version_id: item.spec_version_id ?? null,
          grader_id: null,
          supersedes_id: null,
          llm_run_id: null,
        },
        { now },
      )
    }

    const updatedAttempt = updateRow(
      db,
      'practice_attempt',
      attempt.id,
      { current_grade_event_id: gradeRow.id, grading_revision: 1 },
      { now },
    )!

    // Evidence and state projection are driven from the outbox, so the commit above is the only
    // thing a crash can lose, and a redelivery recomputes from the stored grade.
    enqueue(db, {
      topic: 'evidence.rebuild_for_attempt',
      payload: { attempt_id: String(attempt.id) },
      dedupeKey: `evidence:${attempt.id}:1`,
      now,
    })
    // Django enqueues `learning.on_attempt_graded`; the pairing service is synchronous here, and
    // idempotent per attempt (a replay creates no second task). It runs inside the same transaction
    // so a failure rolls the submission back instead of leaving a graded attempt with no B task.
    onAttemptGraded(db, String(attempt.id), now)

    return { attempt: updatedAttempt, grade: gradeToWire(gradeRow) }
  })
}

/** The attempts of one session item, newest first (0 or 1 row in practice). */
export function listAttempts(db: DatabaseSync, sessionItemId: string): Record<string, unknown>[] {
  return findRows(db, 'practice_attempt', { session_item_id: sessionItemId })
}

// ---------------------------------------------------------------------------
// Answer dispute (`attempts.py::handle_answer_dispute`)
// ---------------------------------------------------------------------------

const GRADE_KIND_INVALIDATION = 'invalidation'
const DISPUTED_PART_REASON = '答案进入争议，原判分不再作为正式分数'

/**
 * Send every graded attempt that relied on a disputed answer version to human review.
 *
 * Port of `attempts.py::handle_answer_dispute`. The raw answer is never touched: it is the record of
 * what the learner actually submitted, and a dispute about the *answer key* must not erase it.
 *
 * Three details are load-bearing and easy to lose:
 *  - only attempts with a current grade event are considered (`current_grade_event__isnull=False`);
 *  - an attempt already `pending_review` is *counted* but gets no second invalidation event, so
 *    repeating a dispute cannot pile up revisions;
 *  - the new event copies the previous event's rule snapshot / rubric / spec / rule version, because
 *    the reviewer has to see the judgement that is being replaced, with its frozen inputs.
 *
 * Returns the number of affected attempts (not the number of created events).
 */
export function handleAnswerDispute(
  db: DatabaseSync,
  answerKeyVersionId: string,
  actorId: string,
  reason: string,
  now: Instant,
): number {
  return transaction(db, () => {
    const attempts: Record<string, unknown>[] = []
    for (const item of findRows(db, 'practice_session_item', { answer_key_version_id: answerKeyVersionId })) {
      for (const attempt of findRows(db, 'practice_attempt', { session_item_id: String(item.id) })) {
        if (attempt.current_grade_event_id !== null && attempt.current_grade_event_id !== undefined) {
          attempts.push(attempt)
        }
      }
    }

    let affected = 0
    for (const attempt of attempts) {
      const previous = findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
      if (previous === null) continue
      if (String(previous.status) === GRADE_STATUS_PENDING_REVIEW) {
        // Already waiting for a human: the new dispute adds no information, only the count moves.
        affected += 1
        continue
      }
      const previousParts = Array.isArray(previous.parts) ? (previous.parts as Record<string, unknown>[]) : []
      const parts = previousParts
        .filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null)
        .map((part) => ({
          part_id: part['part_id'] ?? null,
          score: null,
          max_score: part['max_score'] ?? null,
          status: GRADE_STATUS_PENDING_REVIEW,
          method: null,
          detail: { reason: DISPUTED_PART_REASON },
        }))
      const grade = insertRow(
        db,
        'practice_grade_event',
        {
          attempt_id: attempt.id,
          kind: GRADE_KIND_INVALIDATION,
          status: GRADE_STATUS_PENDING_REVIEW,
          method: GRADE_METHOD_MIXED,
          grading_revision: Number(attempt.grading_revision) + 1,
          confirmed_score: null,
          max_score: previous.max_score,
          pending_max_score: previous.max_score,
          estimated_score: null,
          is_fully_confirmed: false,
          is_superseded: false,
          parts,
          answer_key_version_id: answerKeyVersionId,
          rubric_version_id: previous.rubric_version_id ?? null,
          spec_version_id: previous.spec_version_id ?? null,
          rule_snapshot: previous.rule_snapshot ?? {},
          rule_version: previous.rule_version,
          grader_id: actorId,
          grader_is_self: false,
          comment: `答案争议：${pyCodePointSlice(reason, 0, 400)}`,
          supersedes_id: previous.id,
          invalidation_reason: pyCodePointSlice(reason, 0, 500),
          llm_run_id: null,
        },
        { now },
      )
      updateRow(db, 'practice_grade_event', previous.id, { is_superseded: true }, { now })
      updateRow(
        db,
        'practice_attempt',
        attempt.id,
        { current_grade_event_id: grade.id, grading_revision: Number(grade.grading_revision) },
        { now },
      )
      affected += 1
    }
    return affected
  })
}

/** Parse a stored instant, for callers that read raw rows. */
export { parseInstant }

// ---------------------------------------------------------------------------
// Manual confirmation (`attempts.py::confirm_grade`)
// ---------------------------------------------------------------------------

export interface ConfirmGradeIn {
  parts: Record<string, unknown>[]
  expected_grading_revision: number
  answer_key_version_id?: string | null
  rubric_version_id?: string | null
  comment?: string
}

const GRADE_KIND_MANUAL = 'manual_confirmation'
const GRADE_METHOD_SELF = 'self_confirmed'
const GRADE_METHOD_REVIEWER = 'reviewer_confirmed'
const GRADE_STATUS_CONFIRMED = 'confirmed'

function decimalOf(value: unknown): Decimal {
  return Decimal.parse(String(value ?? '0'))
}

/** `attempts.py::_confirm_rubric_parts` — criterion-by-criterion confirmation. */
function confirmRubricParts(
  db: DatabaseSync,
  item: Record<string, unknown>,
  parts: Record<string, unknown>[],
): { parts: Record<string, unknown>[]; total: Decimal } {
  const rubricId = item.rubric_version_id
  const rubric = rubricId === null || rubricId === undefined
    ? null
    : findOne(db, 'question_bank_rubric_version', { id: String(rubricId) })
  if (rubric === null) throw new InvalidInput('该题缺少 rubric，无法逐评分点确认')
  const criteriaRows = Array.isArray(rubric.criteria) ? (rubric.criteria as Record<string, unknown>[]) : []
  const criteria = new Map<string, Record<string, unknown>>()
  for (const criterion of criteriaRows) criteria.set(String(criterion.criterion_id), criterion)
  const submitted = new Map<string, Record<string, unknown>>()
  for (const part of parts) if (part !== null && typeof part === 'object') submitted.set(String(part.part_id), part)
  const missing = [...criteria.entries()]
    .filter(([id, criterion]) => criterion.required === true && !submitted.has(id))
    .map(([id]) => id)
  if (missing.length > 0) throw new InvalidInput('存在未确认的必填评分点', { details: { missing_criteria: missing } })
  const unknown = [...submitted.keys()].filter((id) => !criteria.has(id))
  if (unknown.length > 0) throw new InvalidInput('提交了不属于该 rubric 的评分点', { details: { unknown_criteria: unknown } })

  const confirmed: Record<string, unknown>[] = []
  let total = Decimal.zero()
  for (const [criterionId, criterion] of criteria) {
    const criterionMax = decimalOf(criterion.max_score)
    const part = submitted.get(criterionId)
    if (part === undefined) {
      confirmed.push({
        part_id: criterionId,
        score: null,
        max_score: criterionMax.toString(),
        status: GRADE_STATUS_PENDING_REVIEW,
        method: null,
        detail: { text: criterion.text ?? '' },
      })
      continue
    }
    const rawScore = part.score
    if (rawScore === null || rawScore === undefined || rawScore === '') {
      throw new InvalidInput(`评分点 ${criterionId} 缺少分值`)
    }
    const score = decimalOf(rawScore)
    if (score.lt(Decimal.zero()) || score.gt(criterionMax)) {
      throw new InvalidInput(`评分点 ${criterionId} 的分值必须在 0 到 ${criterionMax.toString()} 之间`, {
        details: { criterion_id: criterionId, max_score: criterionMax.toString() },
      })
    }
    const scale = criterion.scale
    if (scale !== null && scale !== undefined && scale !== '') {
      const step = decimalOf(scale)
      const quotient = score.div(step)
      if (step.gt(Decimal.zero()) && !quotient.eq(quotient.quantize(0))) {
        throw new InvalidInput(`评分点 ${criterionId} 必须按 ${step.toString()} 的刻度给分`, {
          details: { criterion_id: criterionId, scale: step.toString() },
        })
      }
    }
    confirmed.push({
      part_id: criterionId,
      score: score.toString(),
      max_score: criterionMax.toString(),
      status: GRADE_STATUS_CONFIRMED,
      method: null,
      detail: { text: criterion.text ?? '', comment: String(part.comment ?? '').slice(0, 300) },
    })
    total = total.add(score)
  }
  return { parts: confirmed, total }
}

/** `attempts.py::_confirm_pending_parts` — confirm the blanks a deterministic grade left pending. */
function confirmPendingParts(
  item: Record<string, unknown>,
  parts: Record<string, unknown>[],
  previous: Record<string, unknown> | null,
): { parts: Record<string, unknown>[]; total: Decimal } {
  const priorParts = new Map<string, Record<string, unknown>>()
  const previousParts = Array.isArray(previous?.parts) ? (previous!.parts as Record<string, unknown>[]) : []
  for (const part of previousParts) if (part !== null && typeof part === 'object') priorParts.set(String(part.part_id), part)
  const submitted = new Map<string, Record<string, unknown>>()
  for (const part of parts) if (part !== null && typeof part === 'object') submitted.set(String(part.part_id), part)
  if (submitted.size === 0) throw new InvalidInput('请给出至少一个评分点的确认结果')

  const confirmed: Record<string, unknown>[] = []
  let total = Decimal.zero()
  for (const [partId, prior] of priorParts) {
    const partMax = decimalOf(prior.max_score)
    const override = submitted.get(partId)
    if (override === undefined) {
      if (prior.status === GRADE_STATUS_CONFIRMED && prior.score !== null && prior.score !== undefined) {
        total = total.add(decimalOf(prior.score))
      }
      confirmed.push(prior)
      continue
    }
    const decision = String(override.decision ?? 'award')
    if (decision === 'keep_pending') {
      confirmed.push({ ...prior, status: GRADE_STATUS_PENDING_REVIEW, score: null, method: null })
      continue
    }
    const rawScore = override.score
    if (rawScore === null || rawScore === undefined || rawScore === '') {
      throw new InvalidInput(`评分点 ${partId} 缺少分值`)
    }
    const score = decimalOf(rawScore)
    if (score.lt(Decimal.zero()) || score.gt(partMax)) {
      throw new InvalidInput(`评分点 ${partId} 的分值必须在 0 到 ${partMax.toString()} 之间`)
    }
    confirmed.push({
      ...prior,
      score: score.toString(),
      status: GRADE_STATUS_CONFIRMED,
      detail: { ...((prior.detail as Record<string, unknown>) ?? {}), comment: String(override.comment ?? '').slice(0, 300) },
    })
    total = total.add(score)
  }
  for (const partId of submitted.keys()) {
    if (!priorParts.has(partId)) {
      throw new InvalidInput(`评分点 ${partId} 不属于该题`, { details: { part_id: partId } })
    }
  }
  return { parts: confirmed, total }
}

/**
 * Human confirmation of a manual rubric or of a pending blank review.
 *
 * The write is gated exactly like the reads: while the run still hides its grading, re-scoring would
 * leak the result through every later read even if this response said nothing (B02). A stale
 * `expected_grading_revision` is a 409 rather than a silent overwrite — two reviewers must not
 * confirm the same attempt twice from two tabs.
 */
export function confirmGrade(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  attemptId: string,
  input: ConfirmGradeIn,
  now: Instant,
): { grade: Record<string, unknown>; confirmedScore: string; pendingMaxScore: string } {
  return transaction(db, () => {
    const attempt = findOne(db, 'practice_attempt', { id: attemptId })
    if (attempt === null || String(attempt.project_id) !== String(projectId)) {
      throw new ScopeViolation('作答不存在或不在当前权限范围')
    }
    const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
    if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
    const session = findOne(db, 'practice_session', { id: String(item.session_id) })
    if (session === null) throw new ScopeViolation('作答不存在或不在当前权限范围')

    // C05: once the deadline has passed the exam is over, so its grades may be decided.
    const reconciled = expireSessionIfDue(db, session, now)
    const hidden =
      (reconciled.mode === 'verification' || reconciled.mode === 'mock_exam') && reconciled.status === 'active'
    if (hidden) {
      throw new PurposeNotAllowed('验证/考试进行中：不能对本次作答确认评分，请先结束该次验证')
    }
    if (input.expected_grading_revision === null || input.expected_grading_revision === undefined) {
      throw new VersionConflict('缺少 expected_grading_revision，请重新加载评分页')
    }
    const actualRevision = Number(attempt.grading_revision)
    if (Number(input.expected_grading_revision) !== actualRevision) {
      throw new VersionConflict('评分已在其他标签页更新，请重新加载评分页', {
        details: { expected: input.expected_grading_revision, actual: actualRevision },
      })
    }
    if (input.answer_key_version_id && String(input.answer_key_version_id) !== String(item.answer_key_version_id ?? '')) {
      throw new VersionConflict('评分依据的答案版本已变化，请重新加载')
    }
    if (input.rubric_version_id && String(input.rubric_version_id) !== String(item.rubric_version_id ?? '')) {
      throw new VersionConflict('评分依据的 rubric 版本已变化，请重新加载')
    }
    const distrust = trustBlocker(db, item)
    if (distrust !== null) throw new PurposeNotAllowed(`${distrust}；请先处理答案争议`)

    const isSelf = String(userId) === String(attempt.user_id)
    const method = isSelf ? GRADE_METHOD_SELF : GRADE_METHOD_REVIEWER
    const previous =
      attempt.current_grade_event_id === null
        ? null
        : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
    const questionVersion = questionOf(db, String(item.question_version_id))
    const questionType = String(questionVersion.question_type)
    const { parts: confirmedParts, total } =
      questionType === 'constructed_response'
        ? confirmRubricParts(db, item, input.parts)
        : confirmPendingParts(item, input.parts, previous)

    let pendingTotal = Decimal.zero()
    for (const part of confirmedParts) {
      if (part.status !== GRADE_STATUS_CONFIRMED) pendingTotal = pendingTotal.add(decimalOf(part.max_score))
    }
    const fullyConfirmed =
      pendingTotal.eq(Decimal.zero()) && confirmedParts.every((part) => part.status === GRADE_STATUS_CONFIRMED)
    for (const part of confirmedParts) {
      if (part.status === GRADE_STATUS_CONFIRMED && (part.method === null || part.method === undefined)) {
        part.method = method
      }
    }

    const grade = insertRow(
      db,
      'practice_grade_event',
      {
        attempt_id: attempt.id,
        kind: GRADE_KIND_MANUAL,
        status: fullyConfirmed ? GRADE_STATUS_CONFIRMED : GRADE_STATUS_PENDING_REVIEW,
        method,
        grading_revision: actualRevision + 1,
        confirmed_score: total,
        max_score: decimalOf(item.max_score),
        pending_max_score: pendingTotal,
        estimated_score: null,
        is_fully_confirmed: fullyConfirmed,
        is_superseded: false,
        parts: confirmedParts,
        answer_key_version_id: item.answer_key_version_id ?? null,
        rubric_version_id: item.rubric_version_id ?? null,
        spec_version_id: item.spec_version_id ?? null,
        rule_snapshot: ruleSnapshot({
          spec: specOf(db, item),
          specVersionId: item.spec_version_id === null || item.spec_version_id === undefined ? null : String(item.spec_version_id),
          questionType,
          answerPayload: (answerKey(db, item)?.answer_payload ?? {}) as Record<string, unknown>,
          maxScore: String(item.max_score),
        }),
        rule_version: String(reconciled.policy_version ?? RULE_VERSION),
        grader_id: userId,
        grader_is_self: isSelf,
        comment: String(input.comment ?? '').slice(0, 1000),
        supersedes_id: previous === null ? null : previous.id,
        invalidation_reason: '',
        llm_run_id: null,
      },
      { now },
    )
    if (previous !== null) {
      updateRow(db, 'practice_grade_event', previous.id, { is_superseded: true }, { now })
    }
    updateRow(
      db,
      'practice_attempt',
      attempt.id,
      { current_grade_event_id: grade.id, grading_revision: Number(grade.grading_revision) },
      { now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'grade_event',
        entity_id: String(grade.id),
        action: 'manual_confirmation',
        project_id: projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { method, is_self: isSelf, score: total.toString() },
      },
      { now },
    )
    enqueue(db, {
      topic: 'evidence.rebuild_for_attempt',
      payload: { attempt_id: String(attempt.id) },
      dedupeKey: `evidence:${attempt.id}:${grade.grading_revision}`,
      now,
    })
    // Django serialises the freshly created object, whose Decimal fields still carry the arithmetic
    // result ("6"), while a later read returns the column value ("6.00"). Both are pinned here.
    return { grade, confirmedScore: total.toString(), pendingMaxScore: pendingTotal.toString() }
  })
}
