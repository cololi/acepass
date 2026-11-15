/**
 * Regrade runs: queue, execute, and never let an older request win.
 *
 * Port of `backend/apps/analytics/services/reports.py` (regrade section) and
 * `backend/apps/practice/services/attempts.py` (`start_regrade_run`, `regrade_attempt`,
 * `recheck_regrade_target`, `invalidate_for_untrusted_regrade_target`,
 * `invalidate_evidence_for_content_change`) plus the answer-review queue in `analytics/api.py`.
 *
 * Three properties are load-bearing and each has a test:
 *
 *  - **generation ordering**: every request carries a monotonic generation; every branch re-reads
 *    `applied_regrade_generation` under the write transaction and an older generation writes
 *    *nothing* — not a grade, not an evidence invalidation, not a refusal invalidation;
 *  - **trust re-checked at execution time**: a run queued against a reviewed answer can find that
 *    answer disputed when it executes. It must then refuse to confirm a score, and move the
 *    attempts it covers to human review — while still not touching attempts a newer generation
 *    has settled;
 *  - **no double-counted mastery**: the state projection is rebuilt once per attempt after the
 *    writes, never once per applied row.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { grade as gradeAnswer, resultToDict } from '../domain/grading.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { enqueue } from '../store/outbox.ts'
import { pyStrip } from '../domain/pytext.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import { mergedRule, ruleSnapshot } from './practice.ts'
import { refreshStatesForAttempt } from './evidence_rebuild.ts'

export const REGRADE_STATUS_QUEUED = 'queued'
export const REGRADE_STATUS_RUNNING = 'running'
export const REGRADE_STATUS_SUCCEEDED = 'succeeded'
export const REGRADE_STATUS_FAILED = 'failed'

const GRADE_KIND_REGRADE = 'regrade'
const GRADE_KIND_INVALIDATION = 'invalidation'
const CONTENT_CHANGED_REASON = '题干版本不同，无法用新答案重判；证据失效'

/** A queued target that is no longer trustworthy. Raised at execution time, not at request time. */
export class RegradeTargetUntrusted extends InvalidInput {
  constructor(message: string, options: { details?: Record<string, unknown> } = {}) {
    super(message, options)
    this.name = 'RegradeTargetUntrusted'
  }
}

export interface RegradeRunOptions {
  questionId: string
  targetAnswerKeyVersionId: string
  targetRubricVersionId?: string | null
  actorId: string | null
  reason: string
  scope?: string
  now: Instant
}

/** Every attempt of one question with the frozen relations a regrade reads. */
interface AttemptForRegrade {
  attempt: Record<string, unknown>
  item: Record<string, unknown>
  session: Record<string, unknown>
  version: Record<string, unknown>
  grade: Record<string, unknown> | null
}

function loadAttempt(db: DatabaseSync, attemptId: string): AttemptForRegrade | null {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null) return null
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) return null
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (session === null || version === null) return null
  const grade =
    attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined
      ? null
      : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
  return { attempt, item, session, version, grade }
}

function attemptsForQuestion(
  db: DatabaseSync,
  questionId: string,
  projectId: string,
): AttemptForRegrade[] {
  const out: AttemptForRegrade[] = []
  for (const attempt of findRows(db, 'practice_attempt', { project_id: projectId })) {
    const context = loadAttempt(db, String(attempt.id))
    if (context === null) continue
    if (String(context.version.question_id) !== questionId) continue
    out.push(context)
  }
  out.sort((left, right) => {
    const a = left.attempt.submitted_at as Instant
    const b = right.attempt.submitted_at as Instant
    if (a === b) return 0
    return a < b ? -1 : 1
  })
  return out
}

/**
 * The next generation number.
 *
 * PostgreSQL uses a real sequence, so a rolled-back request still consumes a number. SQLite has no
 * sequences and the generated schema must stay identical to Django's models, so this allocates
 * `MAX + 1` inside the caller's write transaction. Ordering is preserved (the only property the
 * guard relies on); after a rolled-back request the number is reused, which is recorded in
 * docs/dsh-migration/04-parity-findings.md.
 */
function allocateGeneration(db: DatabaseSync): number {
  let newest = 0
  for (const row of findRows(db, 'analytics_regrade_run', {})) {
    newest = Math.max(newest, Number(row.generation))
  }
  return newest + 1
}

/** Re-read and lock the target; refuse a disputed/unchecked revision (execution-time check). */
export function recheckRegradeTarget(
  db: DatabaseSync,
  targetAnswerKeyVersionId: string,
  targetRubricVersionId: string | null,
): { answer: Record<string, unknown>; rubric: Record<string, unknown> | null } {
  const answer = findOne(db, 'question_bank_answer_key_version', { id: targetAnswerKeyVersionId })
  if (answer === null) {
    throw new RegradeTargetUntrusted('重判目标的答案版本已不存在，重判已拒绝')
  }
  if (answer.is_disputed === true || answer.verification_status !== 'checked') {
    throw new RegradeTargetUntrusted(
      '重判目标的答案版本已进入争议或不再是已核对状态，不能据此确认评分',
      {
        details: {
          reason: 'regrade_target_untrusted',
          answer_key_version_id: String(answer.id),
          verification_status: answer.verification_status,
          is_disputed: answer.is_disputed === true,
        },
      },
    )
  }
  let rubric: Record<string, unknown> | null = null
  if (targetRubricVersionId !== null && targetRubricVersionId !== undefined) {
    rubric = findOne(db, 'question_bank_rubric_version', { id: targetRubricVersionId })
    if (rubric === null || rubric.is_disputed === true) {
      throw new RegradeTargetUntrusted('重判目标的评分标准已进入争议，不能据此确认评分', {
        details: { reason: 'regrade_rubric_untrusted', rubric_version_id: targetRubricVersionId },
      })
    }
  }
  return { answer, rubric }
}

/** Queue one regrade request with a unique, monotonic generation (`start_regrade_run`). */
export function startRegradeRun(db: DatabaseSync, options: RegradeRunOptions): Record<string, unknown> {
  const reason = options.reason
  if (pyStrip(reason) === '') throw new InvalidInput('重判必须说明原因')
  const question = findOne(db, 'question_bank_question', { id: options.questionId })
  if (question === null) throw new ScopeViolation('题目不存在或不属于该项目')
  const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (subject === null) throw new ScopeViolation('题目不存在或不属于该项目')
  const project = findOne(db, 'exams_project', { id: String(subject.project_id) })
  if (project === null) throw new ScopeViolation('题目不存在或不属于该项目')

  const answer = findOne(db, 'question_bank_answer_key_version', {
    id: options.targetAnswerKeyVersionId,
  })
  if (answer !== null) {
    const version = findOne(db, 'question_bank_question_version', { id: String(answer.question_version_id) })
    if (version === null || String(version.question_id) !== String(question.id)) {
      throw new InvalidInput('目标答案版本不属于该题目')
    }
  }
  // Fresh target re-read: the caller's copy may predate a dispute or a new revision.
  const fresh = findOne(db, 'question_bank_answer_key_version', {
    id: options.targetAnswerKeyVersionId,
  })
  if (fresh === null) throw new InvalidInput('目标答案版本不属于该题目')
  const freshVersion = findOne(db, 'question_bank_question_version', { id: String(fresh.question_version_id) })
  if (freshVersion === null || String(freshVersion.question_id) !== String(question.id)) {
    throw new InvalidInput('目标答案版本不属于该题目')
  }
  if (fresh.verification_status !== 'checked' || fresh.is_disputed === true) {
    throw new InvalidInput('重判目标必须是已核对且无争议的答案版本')
  }

  const generation = allocateGeneration(db)
  const affected = attemptsForQuestion(db, String(question.id), String(project.id)).length
  const run = insertRow(
    db,
    'analytics_regrade_run',
    {
      user_id: String(project.owner_id),
      project_id: project.id,
      subject_id: subject.id,
      question_id: question.id,
      target_answer_key_version_id: fresh.id,
      target_rubric_version_id: options.targetRubricVersionId ?? null,
      reason: reason.slice(0, 500),
      scope: options.scope ?? 'all_attempts',
      status: REGRADE_STATUS_QUEUED,
      generation,
      affected_attempts: affected,
      regraded_attempts: 0,
      stale_skipped_attempts: 0,
      invalidated_evidence: 0,
      error_message: '',
      started_at: null,
      finished_at: null,
      requested_by_id: options.actorId,
    },
    { now: options.now },
  )
  enqueue(db, {
    topic: 'projection.run_regrade',
    payload: { regrade_run_id: String(run.id) },
    dedupeKey: `regrade-run:${String(run.id)}`,
    now: options.now,
  })
  return run
}

/**
 * Validate and queue one regrade (`request_regrade`).
 *
 * The request-time trust checks are not redundant with the execution-time re-check: this one gives
 * the operator an immediate 400, the other protects against a dispute that lands before the worker
 * picks the run up.
 */
export function requestRegrade(
  db: DatabaseSync,
  options: Omit<RegradeRunOptions, 'scope'> & { scope?: string },
): Record<string, unknown> {
  const answer = findOne(db, 'question_bank_answer_key_version', {
    id: options.targetAnswerKeyVersionId,
  })
  if (answer === null) throw new ScopeViolation('目标答案版本不存在或不属于该题目')
  if (answer.verification_status !== 'checked' || answer.is_disputed === true) {
    throw new InvalidInput('重判目标必须是已核对且无争议的答案版本')
  }
  if (options.targetRubricVersionId !== null && options.targetRubricVersionId !== undefined) {
    const rubric = findOne(db, 'question_bank_rubric_version', { id: options.targetRubricVersionId })
    if (rubric === null || rubric.is_disputed === true) {
      throw new InvalidInput('重判目标 rubric 处于争议状态')
    }
  }
  return startRegradeRun(db, options)
}

/** The wire projection of one run (`regrade_payload`). */
export function regradePayload(run: Record<string, unknown>): Record<string, unknown> {
  return {
    regrade_run_id: String(run.id),
    status: run.status,
    question_id: String(run.question_id),
    target_answer_key_version_id: String(run.target_answer_key_version_id),
    target_rubric_version_id:
      run.target_rubric_version_id === null || run.target_rubric_version_id === undefined
        ? null
        : String(run.target_rubric_version_id),
    scope: run.scope,
    generation: run.generation,
    reason: run.reason,
    affected_attempts: run.affected_attempts,
    regraded_attempts: run.regraded_attempts,
    stale_skipped_attempts: run.stale_skipped_attempts,
    invalidated_evidence: run.invalidated_evidence,
    error_message: run.error_message,
    created_at: formatPythonIso(run.created_at as Instant),
    finished_at:
      run.finished_at === null || run.finished_at === undefined
        ? null
        : formatPythonIso(run.finished_at as Instant),
  }
}

/**
 * Content-version branch of a regrade: check the generation *before* writing.
 *
 * A target answer on a different content version cannot mechanically re-grade the attempt, so the
 * evidence is invalidated instead. Only the newest generation may do that; an older run returns
 * `stale` and touches nothing.
 */
export function invalidateEvidenceForContentChange(
  db: DatabaseSync,
  options: { attemptId: string; generation: number; reason: string; now: Instant },
): { invalidated: number; stale: boolean } {
  const attempt = findOne(db, 'practice_attempt', { id: options.attemptId })
  if (attempt === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  if (options.generation <= Number(attempt.applied_regrade_generation)) {
    return { invalidated: 0, stale: true }
  }
  const active = findRows(db, 'practice_learning_evidence', { attempt_id: options.attemptId, is_active: true })
  for (const row of active) {
    updateRow(
      db,
      'practice_learning_evidence',
      row.id,
      { is_active: false, invalidated_at: options.now, invalidated_reason: options.reason },
      { now: options.now },
    )
  }
  return { invalidated: active.length, stale: false }
}

/** Re-grade one attempt; a stale generation writes nothing at all (`regrade_attempt`). */
export function regradeAttemptForRun(
  db: DatabaseSync,
  options: {
    attemptId: string
    targetAnswerKeyVersionId: string
    targetRubricVersionId: string | null
    generation: number
    actorId: string | null
    reason: string
    now: Instant
  },
): Record<string, unknown> | null {
  const attempt = findOne(db, 'practice_attempt', { id: options.attemptId })
  if (attempt === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  if (options.generation <= Number(attempt.applied_regrade_generation)) return null
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) throw new InvalidInput('目标答案版本不存在')
  const { answer, rubric } = recheckRegradeTarget(
    db,
    options.targetAnswerKeyVersionId,
    options.targetRubricVersionId,
  )
  if (String(answer.question_version_id) !== String(item.question_version_id)) {
    throw new InvalidInput('目标答案版本不属于该题项固定的题目版本，不能机械重判')
  }
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  const spec =
    item.spec_version_id === null || item.spec_version_id === undefined
      ? null
      : findOne(db, 'exams_spec_version', { id: String(item.spec_version_id) })
  const answerPayload = (answer.answer_payload ?? {}) as Record<string, unknown>
  const questionType = String(version.question_type)
  const maxScore = Decimal.parse(String(item.max_score))
  const result = gradeAnswer({
    question_type: questionType,
    raw_answer: attempt.raw_answer,
    answer_payload: answerPayload,
    max_score: maxScore,
    rule: mergedRule(spec, answerPayload, questionType),
    rubric: rubric === null ? null : { criteria: rubric.criteria, total_score: String(rubric.total_score) },
  })

  const previous =
    attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined
      ? null
      : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
  const revision = Number(attempt.grading_revision) + 1
  const grade = insertRow(
    db,
    'practice_grade_event',
    {
      attempt_id: attempt.id,
      kind: GRADE_KIND_REGRADE,
      status: result.status,
      method: result.method,
      grading_revision: revision,
      confirmed_score: result.confirmed_score,
      max_score: maxScore,
      pending_max_score: result.pending_max_score,
      estimated_score: null,
      is_fully_confirmed: result.is_fully_confirmed,
      parts: resultToDict(result).parts,
      answer_key_version_id: answer.id,
      rubric_version_id: rubric === null ? null : rubric.id,
      spec_version_id: item.spec_version_id ?? null,
      rule_snapshot: {
        ...ruleSnapshot({
          spec,
          specVersionId: item.spec_version_id === null || item.spec_version_id === undefined ? null : String(item.spec_version_id),
          questionType,
          answerPayload,
          maxScore: maxScore.toString(),
        }),
        regrade_reason: options.reason.slice(0, 500),
        regrade_generation: options.generation,
      },
      rule_version: String(session?.policy_version ?? 'p0-1'),
      grader_id: options.actorId,
      grader_is_self: false,
      comment: options.reason.slice(0, 1000),
      supersedes_id: previous === null ? null : previous.id,
      is_superseded: false,
      invalidation_reason: '',
      llm_run_id: null,
    },
    { now: options.now },
  )
  if (previous !== null) {
    updateRow(db, 'practice_grade_event', previous.id, { is_superseded: true }, { now: options.now })
  }
  updateRow(
    db,
    'practice_attempt',
    attempt.id,
    {
      current_grade_event_id: grade.id,
      grading_revision: revision,
      applied_regrade_generation: Math.max(Number(attempt.applied_regrade_generation), options.generation),
    },
    { now: options.now },
  )
  insertRow(
    db,
    'audit_content_revision',
    {
      actor_id: options.actorId,
      entity_type: 'grade_event',
      entity_id: String(grade.id),
      action: 'regrade',
      project_id: attempt.project_id,
      reason: options.reason.slice(0, 500),
      before_digest: '',
      after_digest: '',
      detail: { answer_key_version_id: String(answer.id), revision },
    },
    { now: options.now },
  )
  enqueue(db, {
    topic: 'evidence.rebuild_for_attempt',
    payload: { attempt_id: String(attempt.id) },
    dedupeKey: `evidence:${String(attempt.id)}:${revision}`,
    now: options.now,
  })
  return grade
}

/**
 * Move attempts covered by a refused regrade to human review (`invalidate_for_untrusted_regrade_target`).
 *
 * The generation guard is re-read from the stored row before every write. Django reads the value
 * from the list loaded when the run started; re-reading is strictly safer and keeps the invariant
 * "an older generation writes nothing" true even when a newer run settled the attempt after this
 * run loaded its rows (recorded in 04 §N).
 */
export function invalidateForUntrustedRegradeTarget(
  db: DatabaseSync,
  options: {
    attemptIds: readonly string[]
    actorId: string | null
    reason: string
    refusedGeneration: number
    now: Instant
  },
): { invalidated: number; skippedNewer: number } {
  let affected = 0
  let skippedNewer = 0
  for (const attemptId of options.attemptIds) {
    const attempt = findOne(db, 'practice_attempt', { id: attemptId })
    if (attempt === null) continue
    if (Number(attempt.applied_regrade_generation) > options.refusedGeneration) {
      skippedNewer += 1
      continue
    }
    const previous =
      attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined
        ? null
        : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
    if (previous === null) continue
    if (previous.status === 'pending_review') {
      affected += 1
      continue
    }
    const parts = (Array.isArray(previous.parts) ? previous.parts : [])
      .filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null)
      .map((part) => ({
        part_id: part.part_id,
        score: null,
        max_score: part.max_score,
        status: 'pending_review',
        method: null,
        detail: { reason: options.reason.slice(0, 300) },
      }))
    const revision = Number(attempt.grading_revision) + 1
    const grade = insertRow(
      db,
      'practice_grade_event',
      {
        attempt_id: attempt.id,
        kind: GRADE_KIND_INVALIDATION,
        status: 'pending_review',
        method: 'mixed',
        grading_revision: revision,
        confirmed_score: null,
        max_score: previous.max_score,
        pending_max_score: previous.max_score,
        estimated_score: null,
        is_fully_confirmed: false,
        parts,
        answer_key_version_id: previous.answer_key_version_id ?? null,
        rubric_version_id: previous.rubric_version_id ?? null,
        spec_version_id: previous.spec_version_id ?? null,
        rule_snapshot: previous.rule_snapshot ?? {},
        rule_version: previous.rule_version,
        grader_id: options.actorId,
        grader_is_self: false,
        comment: options.reason.slice(0, 1000),
        supersedes_id: previous.id,
        is_superseded: false,
        invalidation_reason: options.reason.slice(0, 500),
        llm_run_id: null,
      },
      { now: options.now },
    )
    updateRow(db, 'practice_grade_event', previous.id, { is_superseded: true }, { now: options.now })
    updateRow(
      db,
      'practice_attempt',
      attempt.id,
      { current_grade_event_id: grade.id, grading_revision: revision },
      { now: options.now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'grade_event',
        entity_id: String(grade.id),
        action: 'regrade_refused_target_untrusted',
        project_id: attempt.project_id,
        reason: options.reason.slice(0, 500),
        before_digest: '',
        after_digest: '',
        detail: {
          superseded_grade_event_id: String(previous.id),
          refused_generation: options.refusedGeneration,
        },
      },
      { now: options.now },
    )
    affected += 1
  }
  return { invalidated: affected, skippedNewer }
}

/**
 * Execute one queued regrade; all-or-nothing, and trust is re-checked.
 *
 * Everything happens inside one transaction: the run either reaches a terminal state with
 * consistent counters, or it rolls back to `queued` and stays recoverable. The run row is read
 * under the write transaction, so an inline "run now" and a worker redelivery cannot both apply
 * the same run.
 */
export function executeRegradeRun(db: DatabaseSync, regradeRunId: string, now: Instant): string {
  return transaction(db, () => {
    const run = findOne(db, 'analytics_regrade_run', { id: regradeRunId })
    if (run === null) return 'missing'
    if (run.status === REGRADE_STATUS_SUCCEEDED) return 'already_done'
    const contexts = attemptsForQuestion(db, String(run.question_id), String(run.project_id))
    const attemptIds = contexts.map((context) => String(context.attempt.id))

    const rebuild = (): void => {
      for (const attemptId of attemptIds) refreshStatesForAttempt(db, attemptId, now)
    }

    const refuseUntrusted = (reason: string): string => {
      const { invalidated, skippedNewer } = invalidateForUntrustedRegradeTarget(db, {
        attemptIds,
        actorId: run.requested_by_id === null || run.requested_by_id === undefined ? null : String(run.requested_by_id),
        reason,
        refusedGeneration: Number(run.generation),
        now,
      })
      // A newer generation already settled these attempts: report, never touch.
      updateRow(
        db,
        'analytics_regrade_run',
        run.id,
        {
          regraded_attempts: 0,
          stale_skipped_attempts: skippedNewer,
          invalidated_evidence: invalidated,
          status: REGRADE_STATUS_FAILED,
          error_message: `重判被拒绝：${reason}`.slice(0, 500),
          started_at: run.started_at ?? now,
          finished_at: now,
        },
        { now },
      )
      rebuild()
      return `refused_target_untrusted=${invalidated} newer_generation_kept=${skippedNewer}`
    }

    let targetQuestionVersionId: string
    try {
      const checked = recheckRegradeTarget(
        db,
        String(run.target_answer_key_version_id),
        run.target_rubric_version_id === null || run.target_rubric_version_id === undefined
          ? null
          : String(run.target_rubric_version_id),
      )
      targetQuestionVersionId = String(checked.answer.question_version_id)
    } catch (error) {
      if (error instanceof RegradeTargetUntrusted) return refuseUntrusted(error.message)
      throw error
    }

    updateRow(
      db,
      'analytics_regrade_run',
      run.id,
      { status: REGRADE_STATUS_RUNNING, started_at: now },
      { now },
    )

    let regraded = 0
    let stale = 0
    let invalidated = 0
    const errors: string[] = []
    try {
      for (const context of contexts) {
        const attemptId = String(context.attempt.id)
        if (String(context.item.question_version_id) !== targetQuestionVersionId) {
          const result = invalidateEvidenceForContentChange(db, {
            attemptId,
            generation: Number(run.generation),
            reason: CONTENT_CHANGED_REASON,
            now,
          })
          invalidated += result.invalidated
          stale += result.stale ? 1 : 0
          continue
        }
        const grade = regradeAttemptForRun(db, {
          attemptId,
          targetAnswerKeyVersionId: String(run.target_answer_key_version_id),
          targetRubricVersionId:
            run.target_rubric_version_id === null || run.target_rubric_version_id === undefined
              ? null
              : String(run.target_rubric_version_id),
          generation: Number(run.generation),
          actorId: run.requested_by_id === null || run.requested_by_id === undefined ? null : String(run.requested_by_id),
          reason: String(run.reason),
          now,
        })
        if (grade === null) stale += 1
        else regraded += 1
      }
    } catch (error) {
      if (error instanceof RegradeTargetUntrusted) return refuseUntrusted(error.message)
      if (error instanceof InvalidInput) errors.push(error.message)
      else throw error
    }

    updateRow(
      db,
      'analytics_regrade_run',
      run.id,
      {
        regraded_attempts: regraded,
        stale_skipped_attempts: stale,
        invalidated_evidence: invalidated,
        status: errors.length === 0 ? REGRADE_STATUS_SUCCEEDED : REGRADE_STATUS_FAILED,
        error_message: errors.join('; ').slice(0, 500),
        finished_at: now,
      },
      { now },
    )
    rebuild()
    // Django enqueues `projection.refresh_paper_stats` with `paper_id = str(run.subject_id)`, which
    // no paper lookup can match — the snapshot is therefore never marked stale by a regrade. The
    // port reproduces that payload verbatim; see 04 §N (KNOWN-B6-1).
    enqueue(db, {
      topic: 'projection.refresh_paper_stats',
      payload: { paper_id: String(run.subject_id) },
      dedupeKey: `regrade-report-refresh:${String(run.id)}`,
      now,
    })
    return `regraded=${regraded} stale=${stale} invalidated=${invalidated}`
  })
}

/** Answers that need attention, with their regrade eligibility (`pending_answer_reviews`). */
export function pendingAnswerReviews(db: DatabaseSync, projectId: string): Record<string, unknown>[] {
  const rows: { answer: Record<string, unknown>; version: Record<string, unknown>; question: Record<string, unknown> }[] = []
  for (const answer of findRows(db, 'question_bank_answer_key_version', {})) {
    const version = findOne(db, 'question_bank_question_version', { id: String(answer.question_version_id) })
    if (version === null) continue
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
    if (question === null) continue
    const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
    if (subject === null || String(subject.project_id) !== projectId) continue
    const eligible =
      answer.verification_status === 'pending' ||
      answer.verification_status === 'checked' ||
      answer.is_disputed === true
    if (!eligible) continue
    rows.push({ answer, version, question })
  }
  rows.sort((left, right) => {
    const a = left.answer.created_at as Instant
    const b = right.answer.created_at as Instant
    if (a === b) return 0
    return a > b ? -1 : 1
  })
  const out: Record<string, unknown>[] = []
  for (const { answer, version, question } of rows.slice(0, 200)) {
    const rubric = findOne(db, 'question_bank_rubric_version', {
      answer_key_version_id: String(answer.id),
    })
    const usable = answer.verification_status === 'checked' && answer.is_disputed !== true
    out.push({
      answer_key_version_id: String(answer.id),
      question_id: String(version.question_id),
      display_label: question.display_label,
      question_version_id: String(version.id),
      answer_version: answer.version,
      verification_status: answer.verification_status,
      source_type: answer.source_type,
      check_basis: answer.check_basis,
      is_disputed: answer.is_disputed,
      dispute_reason: answer.dispute_reason,
      is_usable: usable,
      can_regrade: usable,
      rubric_version_id: rubric === null ? null : String(rubric.id),
    })
  }
  return out
}
