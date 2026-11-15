/**
 * Regrade: re-score an attempt against a reviewed answer version, and never let an older run win.
 *
 * Port of `backend/apps/practice/services/attempts.py` (regrade part).
 *
 * The ordering rule is the whole point. A regrade run carries a generation number; an attempt records
 * the highest generation that has settled it in `applied_regrade_generation`. Every branch that would
 * modify a grade or invalidate evidence re-reads that high-water mark **under the write transaction**,
 * so a run that was queued earlier cannot touch an attempt a newer generation has already settled —
 * including the "content changed, so invalidate the evidence" branch, which used to erase evidence
 * produced by a newer generation while leaving that newer grade in place.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import type { Instant } from '../domain/instant.ts'
import { grade as gradeAnswer, resultToDict } from '../domain/grading.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { enqueue } from '../store/outbox.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import { mergedRule, ruleSnapshot } from './practice.ts'

const GRADE_KIND_REGRADE = 'regrade'
const INVALIDATED_REASON = '重判：内容版本变化'

export interface RegradeResult {
  stale: boolean
  grade: Record<string, unknown> | null
  invalidatedEvidence: number
}

/**
 * Decide whether this run may write, re-reading the high-water mark under the transaction.
 *
 * Returns `stale: true` when a newer generation already settled the attempt; a stale run writes
 * nothing at all.
 */
export function lockAttemptForRegrade(
  db: DatabaseSync,
  attemptId: string,
  generation: number | null,
): { attempt: Record<string, unknown>; stale: boolean } {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  if (generation !== null && Number(generation) <= Number(attempt.applied_regrade_generation)) {
    return { attempt, stale: true }
  }
  return { attempt, stale: false }
}

/** Re-grade one attempt; a stale generation writes nothing. */
export function regradeAttempt(
  db: DatabaseSync,
  options: {
    attemptId: string
    answerKeyVersionId: string
    rubricVersionId?: string | null
    generation?: number | null
    actorId?: string | null
    reason?: string
    now: Instant
  },
): RegradeResult {
  const { now } = options
  const generation = options.generation ?? null

  return transaction(db, () => {
    const { attempt, stale } = lockAttemptForRegrade(db, options.attemptId, generation)
    if (stale) return { stale: true, grade: null, invalidatedEvidence: 0 }

    const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
    if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
    const questionVersion = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
    const answer = findOne(db, 'question_bank_answer_key_version', { id: options.answerKeyVersionId })
    if (questionVersion === null || answer === null) throw new InvalidInput('目标答案版本不存在')

    // A different answer version for the same question is not a mechanical re-grade: the content
    // changed, so the evidence produced under the old version has to be invalidated instead.
    if (String(answer.question_version_id) !== String(item.question_version_id)) {
      const invalidated = findRows(db, 'practice_learning_evidence', { attempt_id: attempt.id, is_active: true })
      for (const row of invalidated) {
        updateRow(
          db,
          'practice_learning_evidence',
          row.id,
          { is_active: false, invalidated_at: now, invalidated_reason: INVALIDATED_REASON },
          { now },
        )
      }
      if (generation !== null) {
        updateRow(
          db,
          'practice_attempt',
          attempt.id,
          { applied_regrade_generation: Math.max(Number(attempt.applied_regrade_generation), generation) },
          { now },
        )
      }
      return { stale: false, grade: null, invalidatedEvidence: invalidated.length }
    }

    const previous =
      attempt.current_grade_event_id === null
        ? null
        : findOne(db, 'practice_grade_event', { id: attempt.current_grade_event_id })
    const revision = Number(previous?.grading_revision ?? 0) + 1
    const maxScore = Decimal.parse(String(item.max_score))
    const content = (questionVersion.content ?? {}) as Record<string, unknown>
    const questionType = String(questionVersion.question_type)
    const answerPayload = (answer.answer_payload ?? {}) as Record<string, unknown>
    const spec =
      item.spec_version_id === null ? null : findOne(db, 'exams_spec_version', { id: String(item.spec_version_id) })
    const rubric =
      options.rubricVersionId === null || options.rubricVersionId === undefined
        ? null
        : findOne(db, 'question_bank_rubric_version', { id: options.rubricVersionId })

    const result = gradeAnswer({
      question_type: questionType,
      raw_answer: attempt.raw_answer,
      answer_payload: answerPayload,
      max_score: maxScore,
      rule: mergedRule(spec, answerPayload, questionType),
      rubric: rubric === null ? null : { criteria: rubric.criteria, total_score: String(rubric.total_score) },
    })
    void content

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
        is_superseded: false,
        parts: resultToDict(result).parts,
        rule_snapshot: ruleSnapshot({
          spec,
          specVersionId: item.spec_version_id === null ? null : String(item.spec_version_id),
          questionType,
          answerPayload,
          maxScore: maxScore.toString(),
        }),
        rule_version: 'p0-1',
        grader_is_self: false,
        comment: String(options.reason ?? ''),
        invalidation_reason: '',
        answer_key_version_id: answer.id,
        rubric_version_id: options.rubricVersionId ?? null,
        spec_version_id: item.spec_version_id ?? null,
        grader_id: options.actorId ?? null,
        supersedes_id: previous?.id ?? null,
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
      {
        current_grade_event_id: grade.id,
        grading_revision: revision,
        applied_regrade_generation:
          generation === null
            ? Number(attempt.applied_regrade_generation)
            : Math.max(Number(attempt.applied_regrade_generation), generation),
      },
      { now },
    )

    // The rebuild runs at the new revision, so a later redelivery cannot restore the old judgement.
    enqueue(db, {
      topic: 'evidence.rebuild_for_attempt',
      payload: { attempt_id: String(attempt.id) },
      dedupeKey: `evidence:${attempt.id}:${revision}`,
      now,
    })

    return {
      stale: false,
      grade: { ...grade, confirmed_score: grade.confirmed_score === null ? null : String(grade.confirmed_score) },
      invalidatedEvidence: 0,
    }
  })
}
