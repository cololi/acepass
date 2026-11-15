/**
 * AI per-criterion grade estimation — deliberately inert (B07).
 *
 * Port of `backend/apps/practice/services/estimation.py`. The rule (docs/05 B07): "AI 大题评分逐点评估；
 * 人工确认前只有 estimated_score". So this module writes **one new** `practice_grade_event` row of
 * kind `ai_estimate` that carries `estimated_score` and nothing else:
 *
 *  * it never points `Attempt.current_grade_event` at it,
 *  * it never touches a human `manual_confirmation` (it only supersedes earlier `ai_estimate` rows),
 *  * it never writes `LearningEvidence` and never changes a `LearnerKnowledgeState` — no outbox event
 *    is enqueued at all,
 *  * `confirmed_score` stays `null` and `is_fully_confirmed` stays `False`.
 *
 * A learner whose grade is *already* fully confirmed can still ask for an estimate (a second
 * opinion), and the response says explicitly that the confirmed total is unaffected.
 */
import type { DatabaseSync } from 'node:sqlite'

import { markFailed, markSucceeded } from '../ai/audit.ts'
import {
  ESTIMATE_GRADE_PROMPT_VERSION,
  buildEstimatePrompt,
} from '../ai/prompts.ts'
import { parseModelJson, pySlice, pyStr, pyStrip } from '../ai/pyvalue.ts'
import { validateEstimate, type EstimateClean, type RubricCriterionInput } from '../ai/validators.ts'
import { Decimal } from '../domain/decimal.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import type { LlmPort } from '../llm/contract.ts'
import { transaction } from '../store/db.ts'
import { findOne, findRows, insertRow, updateRow, type Row } from '../store/repository.ts'
import { beginAuditedRun, finishAuditedRun, telemetryOf } from './ai_runs.ts'
import { DependencyUnavailable, InvalidInput, PurposeNotAllowed, ScopeViolation } from './errors.ts'
import { deliveryHiddenForItem } from './learning.ts'
import { assertGradingNotBlocked } from './tutoring.ts'
import {
  assertTranscriptionConfirmed,
  blocksText,
  capabilityMissingReason,
  confirmedTextFor,
  learnerAnswerText,
  promptDigest,
  raiseAiError,
  transcriptionNoteFor,
} from './transcription.ts'

/** The capability a provider must declare. A text model is never asked to score work it cannot read. */
export const ESTIMATE_CAPABILITY = 'estimate_grade'

export function asDecimal(value: unknown): Decimal {
  return value instanceof Decimal ? value : Decimal.parse(pyStr(value ?? '0'))
}

/**
 * The frozen rubric as validator/prompt criteria (`criterion_id`, cap, description).
 *
 * `description` comes from the rubric's reviewed `text`: the model is given the human wording, never
 * a rewritten one.
 */
export function rubricCriteria(rubric: Row | null): RubricCriterionInput[] {
  if (rubric === null) return []
  const criteria = Array.isArray(rubric.criteria) ? (rubric.criteria as unknown[]) : []
  const out: RubricCriterionInput[] = []
  for (const criterion of criteria) {
    if (criterion === null || typeof criterion !== 'object') continue
    const record = criterion as Record<string, unknown>
    if (record['criterion_id'] === undefined || record['criterion_id'] === null || record['criterion_id'] === '') continue
    out.push({
      criterion_id: pyStr(record['criterion_id']),
      max_score: pyStr(record['max_score'] ?? '0'),
      description: pyStr(record['text'] ?? record['description'] ?? ''),
    })
  }
  return out
}

function itemOf(db: DatabaseSync, attempt: Row): Row {
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  return item
}

/**
 * Estimate one attempt per rubric criterion. Never a confirmed score.
 *
 * `actorId` is recorded on the audit run (who asked); the estimate itself has no grader — it is a
 * model estimate, not a human decision.
 */
export async function estimateGrade(
  db: DatabaseSync,
  options: { attempt: Row; actorId: string; port: LlmPort; now: Instant },
): Promise<Row> {
  const { attempt, actorId, port, now } = options
  // 1. The gate first, before anything else can look at the answer: a model may not estimate text it
  //    only guessed at.
  assertTranscriptionConfirmed(db, attempt)
  const item = itemOf(db, attempt)
  const availability = await port.availability()
  const capability = availability.estimate_grade
  if (capability === undefined || !capability.available) {
    const reason = capability?.reason ?? 'ai_not_configured'
    const handle = beginAuditedRun(
      db,
      { capability: ESTIMATE_CAPABILITY, promptVersion: ESTIMATE_GRADE_PROMPT_VERSION, system: '', prompt: '' },
      {
        userId: String(attempt.user_id),
        projectId: String(attempt.project_id),
        requestSummary: { attempt_id: String(attempt.id), reason: 'provider_missing_capability' },
        inputSnapshot: { attempt_id: String(attempt.id) },
      },
      now,
    )
    const message = capabilityMissingReason(ESTIMATE_CAPABILITY, reason)
    finishAuditedRun(db, handle.rowId, markFailed(handle.record, { code: reason, message }), now)
    raiseAiError(reason, message, 'AI 估分')
  }
  const rubric =
    item.rubric_version_id === null || item.rubric_version_id === undefined
      ? null
      : findOne(db, 'question_bank_rubric_version', { id: String(item.rubric_version_id) })
  if (rubric === null) {
    throw new InvalidInput('该题没有固定的评分标准（rubric），不能逐点估分；请人工确认总分', {
      details: { attempt_id: String(attempt.id) },
    })
  }
  const criteria = rubricCriteria(rubric)
  if (criteria.length === 0) {
    throw new InvalidInput('该题的评分标准没有可用的评分点，不能逐点估分', {
      details: { rubric_version_id: String(rubric.id) },
    })
  }
  // An estimate is a score-shaped disclosure, so it follows the same content gate as every other
  // delivery path: never while this content is inside a running verification, and never while this
  // item's own grading is deliberately hidden.
  assertGradingNotBlocked(db, String(attempt.user_id), item, '请求 AI 逐点估分')
  assertDeliveryVisible(db, attempt, 'AI 估分')
  const rubricTotal = asDecimal(rubric.total_score)
  const learnerAnswer = learnerAnswerText(db, attempt)
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  const prompt = buildEstimatePrompt({
    question_type: version === null ? '' : version.question_type,
    stem_text: blocksText((version?.content as Record<string, unknown> | undefined)?.['blocks']),
    rubric_criteria: criteria.map((criterion) => ({
      criterion_id: criterion.criterion_id,
      max_score: criterion.max_score,
      description: criterion.description ?? '',
    })),
    learner_answer_text: learnerAnswer,
    transcription_note: transcriptionNoteFor(db, attempt),
    max_total: rubricTotal.toString(),
  })
  const handle = beginAuditedRun(
    db,
    { capability: ESTIMATE_CAPABILITY, promptVersion: ESTIMATE_GRADE_PROMPT_VERSION, system: '', prompt },
    {
      userId: String(attempt.user_id),
      projectId: String(attempt.project_id),
      requestSummary: {
        attempt_id: String(attempt.id),
        question_version_id: String(item.question_version_id),
        rubric_version_id: String(rubric.id),
        criterion_ids: criteria.map((criterion) => pyStr(criterion.criterion_id)),
        requested_by: actorId,
      },
      inputSnapshot: {
        attempt_id: String(attempt.id),
        question_version_id: String(item.question_version_id),
        rubric_version_id: String(rubric.id),
        prompt_version: ESTIMATE_GRADE_PROMPT_VERSION,
        has_confirmed_transcription: confirmedTextFor(db, attempt) !== '',
        prompt_digest: promptDigest(prompt),
        learner_answer_digest: promptDigest(learnerAnswer),
      },
    },
    now,
  )
  const result = await port.run({
    capability: ESTIMATE_CAPABILITY,
    promptVersion: ESTIMATE_GRADE_PROMPT_VERSION,
    system: '',
    prompt,
  })
  if (!result.ok) {
    finishAuditedRun(db, handle.rowId, markFailed(handle.record, { code: result.code, message: result.message }), now)
    raiseAiError(result.code, result.message, 'AI 估分')
  }
  let parsed: unknown
  try {
    parsed = parseModelJson(result.text)
  } catch {
    finishAuditedRun(
      db,
      handle.rowId,
      markFailed(handle.record, {
        code: 'ai_invalid_output',
        message: '模型输出不是合法 JSON，未写入任何估分',
      }, telemetryOf(result)),
      now,
    )
    throw new DependencyUnavailable('模型估分输出不是合法 JSON，未写入任何估分', {
      details: { error_code: 'ai_invalid_output' },
    })
  }
  const [clean, problems] = validateEstimate(parsed, { criteria })
  if (clean.criteria.length === 0) {
    // Nothing usable survived validation. Writing an event now would put a number (0) on the attempt
    // that no model ever produced.
    finishAuditedRun(
      db,
      handle.rowId,
      {
        ...markFailed(
          handle.record,
          { code: 'ai_invalid_output', message: '模型没有给出任何可用的评分点估计，未写入估分' },
          telemetryOf(result),
        ),
        validation_result: { problems, accepted: false, accepted_criterion_ids: [] },
      },
      now,
    )
    throw new DependencyUnavailable('模型没有给出任何可用的评分点估计，未写入估分', {
      details: { error_code: 'ai_invalid_output' },
    })
  }
  finishAuditedRun(
    db,
    handle.rowId,
    markSucceeded(handle.record, telemetryOf(result), {
      problems,
      accepted: problems.length === 0,
      accepted_criterion_ids: clean.criteria.map((row) => row.criterion_id),
    }),
    now,
  )
  return writeEstimate(db, {
    attempt,
    item,
    rubric,
    criteria,
    clean,
    runId: handle.rowId,
    rubricTotal,
    now,
  })
}

/** `_assert_delivery_visible`: no score-shaped delivery while grading is hidden. */
export function assertDeliveryVisible(db: DatabaseSync, attempt: Row, action: string): void {
  const item = itemOf(db, attempt)
  if (deliveryHiddenForItem(db, String(attempt.user_id), String(item.id))) {
    throw new PurposeNotAllowed(`验证/考试进行中：为避免泄露答案，验证结束前不能${action}。`, {
      details: { reason: 'grading_hidden', attempt_id: String(attempt.id) },
    })
  }
}

/** Append the estimate event without ever becoming the effective grade. */
function writeEstimate(
  db: DatabaseSync,
  options: {
    attempt: Row
    item: Row
    rubric: Row
    criteria: RubricCriterionInput[]
    clean: EstimateClean
    runId: string
    rubricTotal: Decimal
    now: Instant
  },
): Row {
  const { attempt, item, rubric, criteria, clean, runId, rubricTotal, now } = options
  return transaction(db, () => {
    const locked = findOne(db, 'practice_attempt', { id: String(attempt.id) })
    if (locked === null) {
      throw new InvalidInput('作答不存在或不在当前权限范围', { details: { attempt_id: String(attempt.id) } })
    }
    const byCriterion = new Map(clean.criteria.map((row) => [row.criterion_id, row]))
    const caps = new Map(criteria.map((criterion) => [pyStr(criterion.criterion_id), asDecimal(criterion.max_score)]))
    const parts: Record<string, unknown>[] = []
    let estimatedTotal = Decimal.zero()
    for (const criterion of criteria) {
      const criterionId = pyStr(criterion.criterion_id)
      const row = byCriterion.get(criterionId)
      if (row === undefined) {
        // The model skipped this criterion. The row stays explicitly pending rather than silently
        // missing, so the estimate is never read as "everything was estimated".
        parts.push({
          part_id: criterionId,
          score: null,
          max_score: caps.get(criterionId)!.toString(),
          status: 'pending_review',
          method: null,
          rationale: '',
          missing_evidence: ['模型未给出该评分点的估计'],
          detail: { reason: 'model_omitted_criterion', text: criterion.description ?? '' },
        })
        continue
      }
      const score = asDecimal(row.estimated_score)
      estimatedTotal = estimatedTotal.add(score)
      parts.push({
        part_id: criterionId,
        score: score.toString(),
        max_score: caps.get(criterionId)!.toString(),
        status: 'estimated',
        method: 'ai_estimated',
        rationale: row.rationale,
        missing_evidence: row.missing_evidence,
        detail: { text: criterion.description ?? '' },
      })
    }
    const previous = findRows(db, 'practice_grade_event', {
      attempt_id: locked.id,
      kind: 'ai_estimate',
      is_superseded: false,
    }).sort((left, right) => Number(right.grading_revision) - Number(left.grading_revision))[0]
    const highest = findRows(db, 'practice_grade_event', { attempt_id: locked.id })
      .map((row) => Number(row.grading_revision))
      .reduce((max, value) => Math.max(max, value), 0)
    const revision = Math.max(Number(locked.grading_revision), highest) + 1
    const session = findOne(db, 'practice_session', { id: String(item.session_id) })
    const event = insertRow(
      db,
      'practice_grade_event',
      {
        attempt_id: locked.id,
        kind: 'ai_estimate',
        status: 'estimated',
        method: 'ai_estimated',
        grading_revision: revision,
        estimated_score: estimatedTotal,
        confirmed_score: null,
        max_score: asDecimal(item.max_score),
        pending_max_score: rubricTotal,
        is_fully_confirmed: false,
        parts,
        answer_key_version_id: item.answer_key_version_id,
        rubric_version_id: item.rubric_version_id,
        spec_version_id: item.spec_version_id,
        rule_snapshot: {
          inert: true,
          prompt_version: ESTIMATE_GRADE_PROMPT_VERSION,
          criteria_total: rubricTotal.toString(),
          criteria_count: criteria.length,
          rubric_version_id: String(rubric.id),
          estimated_criterion_ids: [...byCriterion.keys()].sort(),
        },
        rule_version: session === null ? 'p0-1' : String(session.policy_version),
        grader_id: null,
        grader_is_self: false,
        comment: pySlice(pyStr(clean.overall_note ?? ''), 1000),
        supersedes_id: previous === undefined ? null : previous.id,
        is_superseded: false,
        invalidation_reason: '',
        llm_run_id: runId,
      },
      { now },
    )
    if (previous !== undefined) {
      // Only earlier *estimates* are superseded. A human manual_confirmation is never touched, and
      // the effective-grade pointer is never moved.
      updateRow(db, 'practice_grade_event', previous.id, { is_superseded: true }, { now })
    }
    if (revision > Number(locked.grading_revision)) {
      updateRow(db, 'practice_attempt', locked.id, { grading_revision: revision }, { now })
    }
    return event
  })
}

/** The newest, not-yet-superseded AI estimate for this attempt. */
export function latestEstimate(db: DatabaseSync, attemptId: string): Row | null {
  const rows = findRows(db, 'practice_grade_event', {
    attempt_id: attemptId,
    kind: 'ai_estimate',
    is_superseded: false,
  }).sort((left, right) => Number(right.grading_revision) - Number(left.grading_revision))
  return rows[0] ?? null
}

/** Wire shape of one estimate: inert, per-criterion, explicitly not a score. */
export function estimatePayload(db: DatabaseSync, event: Row): Record<string, unknown> {
  const run =
    event.llm_run_id === null || event.llm_run_id === undefined
      ? null
      : findOne(db, 'audit_llm_run', { id: String(event.llm_run_id) })
  const snapshot = (event.rule_snapshot ?? {}) as Record<string, unknown>
  const rubricRevision =
    event.rubric_version_id === null || event.rubric_version_id === undefined
      ? null
      : String(event.rubric_version_id)
  const parts = Array.isArray(event.parts) ? (event.parts as Record<string, unknown>[]) : []
  return {
    grade_event_id: String(event.id),
    attempt_id: String(event.attempt_id),
    kind: String(event.kind),
    status: String(event.status),
    method: String(event.method),
    is_inert: true,
    estimated_score:
      event.estimated_score === null || event.estimated_score === undefined ? null : String(event.estimated_score),
    confirmed_score:
      event.confirmed_score === null || event.confirmed_score === undefined ? null : String(event.confirmed_score),
    confirmed_total_unchanged: true,
    max_score: String(event.max_score),
    pending_max_score: String(event.pending_max_score),
    is_fully_confirmed: false,
    rubric_version_id: rubricRevision,
    rubric_revision: rubricRevision,
    prompt_version: snapshot['prompt_version'] ?? null,
    criteria: parts.map((part) => ({
      criterion_id: part['part_id'] ?? null,
      estimated_score: part['score'] ?? null,
      max_score: part['max_score'] ?? null,
      status: part['status'] ?? null,
      method: part['method'] ?? null,
      rationale: part['rationale'] ?? '',
      missing_evidence: part['missing_evidence'] ?? [],
    })),
    overall_note: String(event.comment ?? ''),
    is_stub: run === null ? false : Boolean(run.is_stub),
    provider: run === null ? '' : String(run.provider),
    model: run === null ? '' : String(run.model_identifier ?? ''),
    created_at: formatPythonIso(event.created_at as Instant),
  }
}

/** `GET` shape: the latest estimate, or an explicit empty state. */
export function estimateState(db: DatabaseSync, attempt: Row): Record<string, unknown> {
  const event = latestEstimate(db, String(attempt.id))
  if (event === null) {
    return {
      attempt_id: String(attempt.id),
      has_estimate: false,
      is_inert: true,
      confirmed_total_unchanged: true,
      estimate: null,
      message: '还没有 AI 估分：正式分数只由人工确认产生，估分不会自动成为成绩。',
    }
  }
  return {
    attempt_id: String(attempt.id),
    has_estimate: true,
    is_inert: true,
    confirmed_total_unchanged: true,
    estimate: estimatePayload(db, event),
    message: 'AI 估分仅供参考，未进入正式分数；正式分数以人工确认为准。',
  }
}
