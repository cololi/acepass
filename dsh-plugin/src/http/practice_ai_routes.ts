/**
 * Practice AI surface — transcription, AI estimation, AI diagnosis, follow-ups.
 *
 * Port of the B07 half of `backend/apps/practice/api.py` (`apps/practice/api.py:813-843`,
 * `1038-1213`) plus `services/transcription.py`, `services/estimation.py`, `services/diagnosis.py`.
 *
 * The rules this file must not weaken (R-INV 3, R-INV 2):
 *
 *  * a photo answer cannot be estimated or diagnosed before the learner confirms a transcription —
 *    409 `transcription_required`, raised **before** any provider is consulted;
 *  * an estimate is inert: it never becomes the confirmed score, never moves
 *    `current_grade_event`, never writes evidence or a mastery state;
 *  * a diagnosis stores *candidate* causes (`origin=model`, `status=proposed`) and the follow-up
 *    questions that would settle them; a human decision is a separate route;
 *  * with no model every AI path answers `503 ai_not_configured` (or `dependency_unavailable` for a
 *    transport failure) and writes nothing but an audit row.
 *
 * Idempotency scopes are Django's, character for character:
 *
 *     attempts.transcribe:{attempt_id}
 *     attempts.ai-estimate:{attempt_id}
 *     attempts.ai-diagnosis:{attempt_id}
 */
import type { DatabaseSync } from 'node:sqlite'

import type { LlmPort } from '../llm/contract.ts'
import { IdempotencyConflictError, InvalidInput, PurposeNotAllowed, ScopeViolation } from '../services/errors.ts'
import { requireProject } from '../services/exams.ts'
import { deliveryHiddenForItem } from '../services/learning.ts'
import { claim, recordResult, release, IdempotencyConflict as StoreIdempotencyConflict } from '../store/idempotency.ts'
import { transaction } from '../store/db.ts'
import { findOne, insertRow, updateRow, type Row } from '../store/repository.ts'
import { answerFollowUp, followUpPayload, proposeDiagnosis, skipFollowUp } from '../services/diagnosis.ts'
import { assertDeliveryVisible, estimateGrade, estimatePayload, estimateState } from '../services/estimation.ts'
import {
  confirmTranscription,
  recordManualTranscription,
  rejectTranscription,
  requestTranscription,
  transcriptionList,
  transcriptionPayload,
} from '../services/transcription.ts'
import { portOf, type AiRouteDeps } from './tutor_routes.ts'
import type { Route, RouteContext } from './router.ts'

const PREFIX = '/api/acepass'

const DIAGNOSIS_STATUSES = new Set(['confirmed', 'rejected', 'proposed', 'unknown'])

interface SchemaIssue {
  type: string
  loc: Array<string | number>
  msg: string
}

function schemaError(issues: SchemaIssue[]): InvalidInput {
  return new InvalidInput('请求参数校验失败', { details: { errors: issues } })
}

function missingField(loc: Array<string | number>): SchemaIssue {
  return { type: 'missing', loc, msg: 'Field required' }
}

function stringType(loc: Array<string | number>): SchemaIssue {
  return { type: 'string_type', loc, msg: 'Input should be a valid string' }
}

function dictType(loc: Array<string | number>): SchemaIssue {
  return { type: 'dict_type', loc, msg: 'Input should be a valid dictionary' }
}

function bodyObject(ctx: RouteContext): Record<string, unknown> {
  const body = ctx.body
  if (body === null || body === undefined) throw schemaError([missingField(['body', 'payload'])])
  if (typeof body !== 'object' || Array.isArray(body)) throw schemaError([dictType(['body', 'payload'])])
  return body as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, name: string, issues: SchemaIssue[]): string {
  const value = record[name]
  if (value === undefined) {
    issues.push(missingField(['body', 'payload', name]))
    return ''
  }
  if (typeof value !== 'string') {
    issues.push(stringType(['body', 'payload', name]))
    return ''
  }
  return value
}

function defaultedString(record: Record<string, unknown>, name: string, fallback: string, issues: SchemaIssue[]): string {
  const value = record[name]
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    issues.push(stringType(['body', 'payload', name]))
    return fallback
  }
  return value
}

/** `str | None`: an explicit `null` and an absent field both mean "not given". */
function optionalString(record: Record<string, unknown>, name: string, issues: SchemaIssue[]): string | null {
  const value = record[name]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    issues.push(stringType(['body', 'payload', name]))
    return null
  }
  return value
}

function idempotencyKeyOf(ctx: RouteContext): string {
  const key = (ctx.headers.get('idempotency-key') ?? '').trim()
  if (key === '') throw new IdempotencyConflictError('缺少 Idempotency-Key 请求头')
  if (Array.from(key).length > 200) throw new IdempotencyConflictError('Idempotency-Key 过长')
  return key
}

function claimOrConflict(ctx: RouteContext, scope: string, key: string, payload: unknown) {
  try {
    return claim(ctx.db, { userId: ctx.userId, routeScope: scope, key, payload, now: ctx.now })
  } catch (error) {
    if (error instanceof StoreIdempotencyConflict) throw new IdempotencyConflictError(error.message)
    throw error
  }
}

/** Owner-scoped attempt. A foreign attempt is a 404, never a hint that it exists. */
function attemptScope(db: DatabaseSync, userId: string, projectId: string, attemptId: string): Row {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null || String(attempt.project_id) !== projectId || String(attempt.user_id) !== userId) {
    throw new ScopeViolation('作答不存在或不在当前权限范围')
  }
  return attempt
}

function transcriptionScope(db: DatabaseSync, userId: string, projectId: string, transcriptionId: string): Row {
  const transcription = findOne(db, 'practice_answer_transcription', { id: transcriptionId })
  if (transcription === null) throw new ScopeViolation('转写不存在或不在当前权限范围')
  const attempt = findOne(db, 'practice_attempt', { id: String(transcription.attempt_id) })
  if (attempt === null || String(attempt.project_id) !== projectId || String(attempt.user_id) !== userId) {
    throw new ScopeViolation('转写不存在或不在当前权限范围')
  }
  return transcription
}

function followUpScope(db: DatabaseSync, userId: string, projectId: string, followUpId: string): Row {
  const followUp = findOne(db, 'practice_diagnosis_follow_up', { id: followUpId })
  if (followUp === null) throw new ScopeViolation('追问不存在或不在当前权限范围')
  const attempt = findOne(db, 'practice_attempt', { id: String(followUp.attempt_id) })
  if (attempt === null || String(attempt.project_id) !== projectId || String(attempt.user_id) !== userId) {
    throw new ScopeViolation('追问不存在或不在当前权限范围')
  }
  return followUp
}

/** The shared content gate: no score-shaped delivery while grading is hidden. */
function assertDeliveryNotHidden(db: DatabaseSync, userId: string, attempt: Row, action: string): void {
  if (deliveryHiddenForItem(db, userId, String(attempt.session_item_id))) {
    throw new PurposeNotAllowed(`验证/考试进行中：为避免泄露答案，验证结束前不能${action}。`, {
      details: { reason: 'grading_hidden', attempt_id: String(attempt.id) },
    })
  }
}

export function practiceAiRoutes(deps: AiRouteDeps = {}): Route[] {
  const port = (): LlmPort => portOf(deps)
  return [
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id/transcriptions`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const attempt = attemptScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.attempt_id)
        return transcriptionList(ctx.db, attempt)
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id/transcriptions`,
      handler: async (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const attempt = attemptScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.attempt_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const assetId = requiredString(record, 'asset_id', issues)
        const text = optionalString(record, 'text', issues)
        if (issues.length > 0) throw schemaError(issues)
        const attemptId = ctx.params.attempt_id
        const key = idempotencyKeyOf(ctx)
        const scope = `attempts.transcribe:${attemptId}`
        const replay = transaction(ctx.db, () => claimOrConflict(ctx, scope, key, ctx.body ?? {}))
        if (replay !== null) return { status: replay.statusCode, body: replay.body }
        try {
          // An explicit (even blank) `text` means "this is what I wrote": a blank one is a client
          // mistake the learner must see, not a silent fallback into a model call.
          const row =
            text !== null
              ? recordManualTranscription(ctx.db, { attempt, assetId, text, actorId: ctx.userId }, ctx.now)
              : await requestTranscription(
                  ctx.db,
                  { attempt, assetId, actorId: ctx.userId, port: port() },
                  ctx.now,
                )
          const result = transcriptionPayload(row)
          transaction(ctx.db, () =>
            recordResult(ctx.db, {
              userId: ctx.userId,
              routeScope: scope,
              key,
              statusCode: 201,
              responseBody: result,
              resourceType: 'answer_transcription',
              resourceId: String(row.id),
              now: ctx.now,
            }),
          )
          return { status: 201, body: result }
        } catch (error) {
          transaction(ctx.db, () => release(ctx.db, ctx.userId, scope, key))
          throw error
        }
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/transcriptions/:transcription_id/confirm`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const transcription = transcriptionScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.transcription_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const text = optionalString(record, 'text', issues)
        const note = defaultedString(record, 'note', '', issues)
        if (issues.length > 0) throw schemaError(issues)
        const confirmed = confirmTranscription(ctx.db, { transcription, actorId: ctx.userId, text }, ctx.now)
        if (note !== '') {
          // Django saves the note after the state transition; it is learner metadata, not a decision.
          transaction(ctx.db, () =>
            updateRow(
              ctx.db,
              'practice_answer_transcription',
              confirmed.id,
              { note: Array.from(note).slice(0, 500).join('') },
              { now: ctx.now },
            ),
          )
        }
        const row = findOne(ctx.db, 'practice_answer_transcription', { id: String(confirmed.id) }) ?? confirmed
        return transcriptionPayload(row)
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/transcriptions/:transcription_id/reject`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const transcription = transcriptionScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.transcription_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const note = defaultedString(record, 'note', '', issues)
        if (issues.length > 0) throw schemaError(issues)
        const row = rejectTranscription(ctx.db, { transcription, actorId: ctx.userId, note }, ctx.now)
        return transcriptionPayload(row)
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id/ai-estimate`,
      handler: async (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const attempt = attemptScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.attempt_id)
        const attemptId = ctx.params.attempt_id
        const key = idempotencyKeyOf(ctx)
        const scope = `attempts.ai-estimate:${attemptId}`
        // `create_ai_estimate` claims an empty payload: the request has no body to fingerprint.
        const replay = transaction(ctx.db, () => claimOrConflict(ctx, scope, key, {}))
        if (replay !== null) {
          // A stored estimate is still a score-shaped disclosure: re-check the gate instead of
          // handing back a body that may now be hidden (C01).
          assertDeliveryVisible(ctx.db, attempt, '读取 AI 估分')
          return { status: replay.statusCode, body: replay.body }
        }
        try {
          const event = await estimateGrade(ctx.db, {
            attempt,
            actorId: ctx.userId,
            port: port(),
            now: ctx.now,
          })
          const result = estimatePayload(ctx.db, event)
          transaction(ctx.db, () =>
            recordResult(ctx.db, {
              userId: ctx.userId,
              routeScope: scope,
              key,
              statusCode: 200,
              responseBody: result,
              resourceType: 'grade_event',
              resourceId: String(event.id),
              now: ctx.now,
            }),
          )
          return result
        } catch (error) {
          transaction(ctx.db, () => release(ctx.db, ctx.userId, scope, key))
          throw error
        }
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id/ai-estimate`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const attempt = attemptScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.attempt_id)
        assertDeliveryVisible(ctx.db, attempt, '读取 AI 估分')
        return estimateState(ctx.db, attempt)
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id/ai-diagnosis`,
      handler: async (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const attempt = attemptScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.attempt_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const learnerNote = defaultedString(record, 'learner_note', '', issues)
        if (issues.length > 0) throw schemaError(issues)
        const attemptId = ctx.params.attempt_id
        const key = idempotencyKeyOf(ctx)
        const scope = `attempts.ai-diagnosis:${attemptId}`
        const replay = transaction(ctx.db, () => claimOrConflict(ctx, scope, key, ctx.body ?? {}))
        if (replay !== null) {
          assertDeliveryNotHidden(ctx.db, ctx.userId, attempt, '读取 AI 诊断')
          return { status: replay.statusCode, body: replay.body }
        }
        try {
          const result = await proposeDiagnosis(ctx.db, {
            attempt,
            actorId: ctx.userId,
            learnerNote,
            port: port(),
            now: ctx.now,
          })
          transaction(ctx.db, () =>
            recordResult(ctx.db, {
              userId: ctx.userId,
              routeScope: scope,
              key,
              statusCode: 200,
              responseBody: result,
              resourceType: 'error_diagnosis',
              resourceId: String(result['llm_run_id'] ?? ''),
              now: ctx.now,
            }),
          )
          return result
        } catch (error) {
          transaction(ctx.db, () => release(ctx.db, ctx.userId, scope, key))
          throw error
        }
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id/diagnosis`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const attempt = attemptScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.attempt_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const errorType = requiredString(record, 'error_type', issues)
        const status = defaultedString(record, 'status', 'confirmed', issues)
        const note = defaultedString(record, 'note', '', issues)
        if (issues.length > 0) throw schemaError(issues)
        if (!DIAGNOSIS_STATUSES.has(status)) throw new InvalidInput('诊断状态无效')
        // A human decision: it never changes a score or a state, and it is not idempotent in Django
        // either (each call appends one decision row).
        const diagnosis = transaction(ctx.db, () =>
          insertRow(
            ctx.db,
            'practice_error_diagnosis',
            {
              attempt_id: attempt.id,
              error_type: Array.from(errorType).slice(0, 40).join(''),
              evidence: [],
              origin: 'user',
              llm_run_id: null,
              status,
              note: Array.from(note).slice(0, 500).join(''),
              decided_by_id: ctx.userId,
              decided_at: null,
            },
            { now: ctx.now },
          ),
        )
        return {
          id: String(diagnosis.id),
          attempt_id: String(attempt.id),
          error_type: String(diagnosis.error_type),
          origin: String(diagnosis.origin),
          status: String(diagnosis.status),
          note: String(diagnosis.note),
        }
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/diagnosis-follow-ups/:follow_up_id/answer`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const followUp = followUpScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.follow_up_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const text = requiredString(record, 'text', issues)
        if (issues.length > 0) throw schemaError(issues)
        const row = answerFollowUp(ctx.db, { followUp, text, now: ctx.now })
        return followUpPayload(row)
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/diagnosis-follow-ups/:follow_up_id/skip`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const followUp = followUpScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.follow_up_id)
        const row = skipFollowUp(ctx.db, { followUp, now: ctx.now })
        return followUpPayload(row)
      },
    },
  ]
}
