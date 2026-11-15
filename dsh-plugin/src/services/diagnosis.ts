/**
 * AI-assisted error diagnosis and the follow-up questions it asks (B07).
 *
 * Port of `backend/apps/practice/services/diagnosis.py`. The rule (docs/05 B07): "诊断追问". A
 * diagnosis is a *candidate* explanation of a wrong answer, never a verdict:
 *
 *  * a cause is stored with `origin="model"` and `status="proposed"` — only a human confirm/reject
 *    path can settle it,
 *  * a cause without evidence is downgraded to `unknown` by the validator and is never reported as
 *    "careless" (the controlled error-type list has no such value),
 *  * if nothing survives validation, **nothing is stored**: returning an empty result with an
 *    explicit note is honest, while inventing a cause to look useful is not,
 *  * no score, no grade event, no `LearningEvidence` and no knowledge state is ever written here.
 *
 * A handwritten answer must be transcribed and confirmed first (the same gate as estimation): a
 * diagnosis built on text the model only guessed at would be a diagnosis of a different answer.
 */
import type { DatabaseSync } from 'node:sqlite'

import { markFailed, markSucceeded } from '../ai/audit.ts'
import { DIAGNOSIS_ERROR_TYPES, DIAGNOSE_PROMPT_VERSION, buildDiagnosePrompt } from '../ai/prompts.ts'
import { parseModelJson, pySlice, pyStr } from '../ai/pyvalue.ts'
import { validateDiagnosis } from '../ai/validators.ts'
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
  learnerAnswerText,
  promptDigest,
  raiseAiError,
  transcriptionNoteFor,
} from './transcription.ts'

/** The capability a provider must declare. Diagnosis is a text job: the answer arrives as text. */
export const DIAGNOSE_CAPABILITY = 'diagnose'

const NO_CAUSE_NOTE = '模型没有给出有证据支持的原因，系统没有替你猜一个原因；可补充解题过程后再试。'

/** The frozen answer, only while it is still trustworthy (checked and not disputed). */
export function checkedAnswer(db: DatabaseSync, item: Row): Row | null {
  if (item.answer_key_version_id === null || item.answer_key_version_id === undefined) return null
  const answer = findOne(db, 'question_bank_answer_key_version', { id: String(item.answer_key_version_id) })
  if (answer === null) return null
  const usable = String(answer.verification_status) === 'checked' && !Boolean(answer.is_disputed)
  return usable ? answer : null
}

/** What the diagnosis may compare the learner's work against. */
export function diagnosisAnswerSummary(db: DatabaseSync, item: Row, answer: Row | null): string {
  if (answer === null) return ''
  const payload = (answer.answer_payload ?? {}) as Record<string, unknown>
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  const questionType = version === null ? '' : String(version.question_type)
  if (questionType === 'single_choice') return `正确选项：${pyStr(payload['correct_option_id'] ?? '')}`
  if (questionType === 'multiple_choice') {
    const ids = Array.isArray(payload['correct_option_ids']) ? payload['correct_option_ids'] : []
    return `正确选项集合：${ids.map((id) => pyStr(id)).join(', ')}`
  }
  if (questionType === 'true_false') return `标准答案：${payload['value'] ? '正确' : '错误'}`
  if (questionType === 'fill_blank') {
    const blanks = (payload['blanks'] ?? {}) as Record<string, unknown>
    const rendered = Object.entries(blanks)
      .filter(([, spec]) => spec !== null && typeof spec === 'object')
      .map(([blankId, spec]) => {
        const accepted = (spec as Record<string, unknown>)['accepted_values']
        const values = Array.isArray(accepted) ? accepted.map((value) => pyStr(value)).join(' / ') : ''
        return `${blankId}: ${values || '（数值规则）'}`
      })
      .join('; ')
    return `各空答案：${rendered}`
  }
  if (questionType === 'constructed_response') {
    const text = pyStr(payload['text'] ?? payload['reference_answer'] ?? '').trim()
    if (text !== '') return `参考作答：${pySlice(text, 800)}`
    return '按评分标准逐点评分（请勿给出单一总分）'
  }
  return ''
}

/** The per-criterion scores the diagnosis should explain. */
function gradedParts(db: DatabaseSync, attempt: Row): Record<string, unknown>[] {
  if (attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined) return []
  const grade = findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
  if (grade === null) return []
  const parts = Array.isArray(grade.parts) ? (grade.parts as unknown[]) : []
  const out: Record<string, unknown>[] = []
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    out.push({
      criterion_id: record['part_id'] ?? null,
      score: record['score'] ?? null,
      max_score: record['max_score'] ?? null,
      status: record['status'] ?? null,
    })
  }
  return out
}

/** Wire shape of one candidate cause. */
export function diagnosisPayload(row: Row): Record<string, unknown> {
  return {
    diagnosis_id: String(row.id),
    attempt_id: String(row.attempt_id),
    error_type: String(row.error_type),
    origin: String(row.origin),
    status: String(row.status),
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    note: String(row.note ?? ''),
    llm_run_id: row.llm_run_id === null || row.llm_run_id === undefined ? null : String(row.llm_run_id),
    created_at: formatPythonIso(row.created_at as Instant),
  }
}

/** Wire shape of one follow-up question. */
export function followUpPayload(row: Row): Record<string, unknown> {
  return {
    follow_up_id: String(row.id),
    attempt_id: String(row.attempt_id),
    question: String(row.question),
    why: String(row.why ?? ''),
    evidence_kind: String(row.evidence_kind ?? ''),
    status: String(row.status),
    answer_text: String(row.answer_text ?? ''),
    answered_at:
      row.answered_at === null || row.answered_at === undefined ? null : formatPythonIso(row.answered_at as Instant),
    llm_run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
  }
}

/**
 * Ask the model for candidate causes and the questions that would settle them.
 *
 * Returns the stored result; nothing is written when the model produced no acceptable cause.
 */
export async function proposeDiagnosis(
  db: DatabaseSync,
  options: { attempt: Row; actorId: string; learnerNote?: string; port: LlmPort; now: Instant },
): Promise<Record<string, unknown>> {
  const { attempt, actorId, port, now } = options
  const learnerNote = pyStr(options.learnerNote ?? '')
  // 1. The same gate as estimation: never diagnose text that was only guessed at.
  assertTranscriptionConfirmed(db, attempt)
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  const availability = await port.availability()
  const capability = availability.diagnose
  if (capability === undefined || !capability.available) {
    const reason = capability?.reason ?? 'ai_not_configured'
    const handle = beginAuditedRun(
      db,
      { capability: DIAGNOSE_CAPABILITY, promptVersion: DIAGNOSE_PROMPT_VERSION, system: '', prompt: '' },
      {
        userId: String(attempt.user_id),
        projectId: String(attempt.project_id),
        requestSummary: { attempt_id: String(attempt.id), reason: 'provider_missing_capability' },
        inputSnapshot: { attempt_id: String(attempt.id) },
      },
      now,
    )
    const message = capabilityMissingReason(DIAGNOSE_CAPABILITY, reason)
    finishAuditedRun(db, handle.rowId, markFailed(handle.record, { code: reason, message }), now)
    raiseAiError(reason, message, 'AI 诊断')
  }
  // A diagnosis paraphrases the learner's work and can hint at the answer, so it follows the same
  // content gate as every other delivery path.
  assertGradingNotBlocked(db, String(attempt.user_id), item, '请求 AI 错误诊断')
  if (deliveryHiddenForItem(db, String(attempt.user_id), String(item.id))) {
    throw new PurposeNotAllowed('验证/考试进行中：不提供 AI 诊断，请先结束本次验证', {
      details: { reason: 'grading_hidden', attempt_id: String(attempt.id) },
    })
  }
  const answer = checkedAnswer(db, item)
  const learnerAnswer = learnerAnswerText(db, attempt)
  const parts = gradedParts(db, attempt)
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  const prompt = buildDiagnosePrompt({
    question_type: version === null ? '' : version.question_type,
    stem_text: blocksText((version?.content as Record<string, unknown> | undefined)?.['blocks']),
    answer_summary: diagnosisAnswerSummary(db, item, answer),
    learner_answer_text: learnerAnswer + (learnerNote !== '' ? `\n学习者的补充说明：${learnerNote}` : ''),
    graded_parts: parts,
    transcription_note: transcriptionNoteFor(db, attempt),
  })
  const handle = beginAuditedRun(
    db,
    { capability: DIAGNOSE_CAPABILITY, promptVersion: DIAGNOSE_PROMPT_VERSION, system: '', prompt },
    {
      userId: String(attempt.user_id),
      projectId: String(attempt.project_id),
      requestSummary: {
        attempt_id: String(attempt.id),
        question_version_id: String(item.question_version_id),
        answer_key_version_id:
          item.answer_key_version_id === null || item.answer_key_version_id === undefined
            ? null
            : String(item.answer_key_version_id),
        answer_usable: answer !== null,
        criterion_ids: parts.map((part) => part['criterion_id'] ?? null),
        requested_by: actorId,
        has_learner_note: learnerNote !== '',
      },
      inputSnapshot: {
        attempt_id: String(attempt.id),
        question_version_id: String(item.question_version_id),
        prompt_version: DIAGNOSE_PROMPT_VERSION,
        allowed_error_types: [...DIAGNOSIS_ERROR_TYPES],
        prompt_digest: promptDigest(prompt),
        learner_answer_digest: promptDigest(learnerAnswer),
      },
    },
    now,
  )
  const result = await port.run({
    capability: DIAGNOSE_CAPABILITY,
    promptVersion: DIAGNOSE_PROMPT_VERSION,
    system: '',
    prompt,
  })
  if (!result.ok) {
    finishAuditedRun(db, handle.rowId, markFailed(handle.record, { code: result.code, message: result.message }), now)
    raiseAiError(result.code, result.message, 'AI 诊断')
  }
  let parsed: unknown
  try {
    parsed = parseModelJson(result.text)
  } catch {
    finishAuditedRun(
      db,
      handle.rowId,
      markFailed(
        handle.record,
        { code: 'ai_invalid_output', message: '模型输出不是合法 JSON，未记录任何诊断' },
        telemetryOf(result),
      ),
      now,
    )
    throw new DependencyUnavailable('模型诊断输出不是合法 JSON，未记录任何诊断', {
      details: { error_code: 'ai_invalid_output' },
    })
  }
  const [clean, problems] = validateDiagnosis(parsed)
  finishAuditedRun(
    db,
    handle.rowId,
    markSucceeded(handle.record, telemetryOf(result), {
      problems,
      accepted: problems.length === 0,
      accepted_error_types: clean.causes.map((cause) => cause.error_type),
      stored_causes: clean.causes.length,
      stored_questions: clean.follow_up_questions.length,
    }),
    now,
  )
  return storeDiagnosis(db, {
    attempt,
    clean,
    runId: handle.rowId,
    learnerNote,
    actorId,
    now,
  })
}

/** Persist only the validated causes and questions. Nothing else is written. */
function storeDiagnosis(
  db: DatabaseSync,
  options: {
    attempt: Row
    clean: ReturnType<typeof validateDiagnosis>[0]
    runId: string
    learnerNote: string
    actorId: string
    now: Instant
  },
): Record<string, unknown> {
  const { attempt, clean, runId, learnerNote, actorId, now } = options
  return transaction(db, () => {
    for (const cause of clean.causes) {
      insertRow(
        db,
        'practice_error_diagnosis',
        {
          attempt_id: attempt.id,
          error_type: pySlice(pyStr(cause.error_type), 40),
          evidence: cause.evidence,
          origin: 'model',
          llm_run_id: runId,
          status: 'proposed',
          note: pySlice(learnerNote, 500),
          // ``origin=model`` rows are proposals: a human decides them through the existing
          // /diagnosis endpoint, so no decision is pre-filled.
          decided_by_id: null,
          decided_at: null,
        },
        { now },
      )
    }
    const followUps: Row[] = []
    if (clean.causes.length > 0) {
      for (const question of clean.follow_up_questions) {
        followUps.push(
          insertRow(
            db,
            'practice_diagnosis_follow_up',
            {
              attempt_id: attempt.id,
              question: pySlice(pyStr(question.question), 500),
              why: pySlice(pyStr(question.why ?? ''), 300),
              evidence_kind: pySlice(pyStr(question.evidence_kind ?? ''), 60),
              status: 'pending',
              answer_text: '',
              run_id: runId,
              answered_at: null,
            },
            { now },
          ),
        )
      }
    }
    const stored = findRows(db, 'practice_error_diagnosis', { attempt_id: attempt.id, llm_run_id: runId }).sort(
      (left, right) => {
        const a = left.created_at as Instant
        const b = right.created_at as Instant
        return a < b ? -1 : a > b ? 1 : 0
      },
    )
    return {
      attempt_id: String(attempt.id),
      origin: 'model',
      status: 'proposed',
      causes: stored.map(diagnosisPayload),
      follow_up_questions: followUps.map(followUpPayload),
      missing_information: clean.missing_information,
      note: clean.causes.length === 0 ? NO_CAUSE_NOTE : '',
      recorded: clean.causes.length > 0,
      is_stub: false,
      prompt_version: DIAGNOSE_PROMPT_VERSION,
      llm_run_id: runId,
      requested_by: actorId,
      // Explicit, so a client cannot read this as a grading action.
      scores_changed: false,
      knowledge_state_changed: false,
    }
  })
}

/** Record the learner's process evidence (never a score, never a state). */
export function answerFollowUp(
  db: DatabaseSync,
  options: { followUp: Row; text: string; now: Instant },
): Row {
  return transaction(db, () => {
    const locked = findOne(db, 'practice_diagnosis_follow_up', { id: String(options.followUp.id) })
    if (locked === null) throw new ScopeViolation('追问不存在或不在当前权限范围')
    if (String(locked.status) !== 'pending') {
      throw new InvalidInput('该追问已经处理过', { details: { status: String(locked.status) } })
    }
    const answer = pyStr(options.text ?? '').trim()
    if (answer === '') throw new InvalidInput('追问回答不能为空；不想回答请选择跳过')
    return (
      updateRow(
        db,
        'practice_diagnosis_follow_up',
        locked.id,
        { answer_text: pySlice(answer, 8000), status: 'answered', answered_at: options.now },
        { now: options.now },
      ) ?? locked
    )
  })
}

/** Mark one follow-up skipped; the question stays visible with its honest state. */
export function skipFollowUp(db: DatabaseSync, options: { followUp: Row; now: Instant }): Row {
  return transaction(db, () => {
    const locked = findOne(db, 'practice_diagnosis_follow_up', { id: String(options.followUp.id) })
    if (locked === null) throw new ScopeViolation('追问不存在或不在当前权限范围')
    if (String(locked.status) !== 'pending') {
      throw new InvalidInput('该追问已经处理过', { details: { status: String(locked.status) } })
    }
    return (
      updateRow(
        db,
        'practice_diagnosis_follow_up',
        locked.id,
        { status: 'skipped', answered_at: options.now },
        { now: options.now },
      ) ?? locked
    )
  })
}
