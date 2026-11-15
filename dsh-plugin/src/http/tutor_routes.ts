/**
 * Tutoring HTTP surface — port of `backend/apps/tutoring/api.py`.
 *
 * Handlers are thin adapters: validate the Ninja-shaped body/query, call the service, return the
 * service value. The idempotency scopes are Django's, character for character, because the scope
 * string is part of the replay contract:
 *
 *     tutor_sessions.create:{session_item_id}
 *     tutor_messages.create:{tutor_session_id}
 *
 * `POST …/messages` runs the provider **inline** (Django's `run_tutor_job_now`). With no model it
 * still answers `201` and the job carries `status=unavailable` + `error_code=ai_not_configured`,
 * which is exactly the honest state Django returns and what the UI branches on. The SSE surface is
 * `GET /api/acepass/stream?op=tutor.stream` (`tutor_stream.ts`), not this router: DSH cannot mount a
 * parameterised Fetch route.
 */
import type { DatabaseSync } from 'node:sqlite'

import { CAPABILITIES } from '../llm/contract.ts'
import type { CapabilityRequest, CapabilityResult, LlmPort } from '../llm/contract.ts'
import { InvalidInput, IdempotencyConflictError, ScopeViolation } from '../services/errors.ts'
import { requireProject } from '../services/exams.ts'
import { claim, recordResult, release, IdempotencyConflict as StoreIdempotencyConflict } from '../store/idempotency.ts'
import { transaction } from '../store/db.ts'
import { findOne, type Row } from '../store/repository.ts'
import {
  aiStatus,
  assertJobDeliverable,
  createTutorJob,
  createTutorSession,
  jobPayload,
  listTutorSessions,
  recentRuns,
  runTutorJob,
  segmentsPayload,
  sessionScope,
  tutorSessionPayload,
  TUTOR_PURPOSES,
} from '../services/tutoring.ts'
import type { Route, RouteContext } from './router.ts'

const PREFIX = '/api/acepass'

/** Injected in production (`index.ts`) and in tests: the AI port is a host capability, not a route. */
export interface AiRouteDeps {
  llm?: () => LlmPort
}

/** What a host with no model service reports: every capability unavailable, honestly. */
export function unavailablePort(): LlmPort {
  const table = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      capability === 'embed'
        ? { available: false, reason: 'ai_capability_unsupported' as const }
        : { available: false, reason: 'ai_not_configured' as const },
    ]),
  ) as Awaited<ReturnType<LlmPort['availability']>>
  return {
    async availability() {
      return table
    },
    async run(request: CapabilityRequest): Promise<CapabilityResult> {
      return {
        ok: false,
        code: 'ai_not_configured',
        message: 'AI 未配置',
        capability: request.capability,
        promptVersion: request.promptVersion,
        retryable: false,
      }
    },
  }
}

export function portOf(deps: AiRouteDeps): LlmPort {
  return deps.llm === undefined ? unavailablePort() : deps.llm()
}

/* ------------------------------------------------------------------ Ninja-shaped validation */

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

function intParsingIssue(loc: Array<string | number>): SchemaIssue {
  return { type: 'int_parsing', loc, msg: 'Input should be a valid integer, unable to parse string as an integer' }
}

function dictType(loc: Array<string | number>): SchemaIssue {
  return { type: 'dict_type', loc, msg: 'Input should be a valid dictionary' }
}

/** A required Ninja body model: no body is `missing` at `["body","payload"]`. */
function bodyObject(ctx: RouteContext): Record<string, unknown> {
  const body = ctx.body
  if (body === null || body === undefined) throw schemaError([missingField(['body', 'payload'])])
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw schemaError([dictType(['body', 'payload'])])
  }
  return body as Record<string, unknown>
}

function optionalString(
  record: Record<string, unknown>,
  name: string,
  issues: SchemaIssue[],
): string | null {
  const value = record[name]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    issues.push(stringType(['body', 'payload', name]))
    return null
  }
  return value
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

/** Pydantic's lax int from a query string (`intQueryOr` in analytics_routes has the full rationale). */
function intQuery(ctx: RouteContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name)
  if (raw === null) return fallback
  const value = raw.trim()
  if (/^[+-]?\d(?:_?\d)*$/.test(value)) return Number(value.replaceAll('_', ''))
  if (/^[+-]?\d+\.0+$/.test(value)) return Number(value.slice(0, value.indexOf('.')))
  throw schemaError([intParsingIssue(['query', name])])
}

/**
 * `idempotency_key(request)`: trimmed, and a missing/over-long key is a 409, not a 400.
 *
 * Django's helper raises `IdempotencyConflict` for both, so a retry without the header is a retry
 * problem rather than a validation problem.
 */
function idempotencyKeyOf(ctx: RouteContext): string {
  const key = (ctx.headers.get('idempotency-key') ?? '').trim()
  if (key === '') throw new IdempotencyConflictError('缺少 Idempotency-Key 请求头')
  if (Array.from(key).length > 200) throw new IdempotencyConflictError('Idempotency-Key 过长')
  return key
}

function claimOrConflict(
  ctx: RouteContext,
  scope: string,
  key: string,
  payload: unknown,
): ReturnType<typeof claim> {
  try {
    return claim(ctx.db, { userId: ctx.userId, routeScope: scope, key, payload, now: ctx.now })
  } catch (error) {
    if (error instanceof StoreIdempotencyConflict) throw new IdempotencyConflictError(error.message)
    throw error
  }
}

function storedResourceId(db: DatabaseSync, recordId: string): string {
  const record = findOne(db, 'audit_idempotency_record', { id: recordId })
  return record === null ? '' : String(record.resource_id ?? '')
}

function itemInScope(db: DatabaseSync, userId: string, projectId: string, sessionItemId: string): Row {
  const item = findOne(db, 'practice_session_item', { id: sessionItemId })
  if (item === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null || String(session.user_id) !== userId || String(session.project_id) !== projectId) {
    throw new ScopeViolation('题项不存在或不在当前权限范围')
  }
  return item
}

/* ------------------------------------------------------------------ routes */

export function tutorRoutes(deps: AiRouteDeps = {}): Route[] {
  return [
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/ai-status`,
      handler: async (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        return aiStatus(await portOf(deps).availability())
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/ai-runs`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        return recentRuns(ctx.db, ctx.params.project_id, intQuery(ctx, 'limit', 20))
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/tutor-sessions`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const sessionItemId = requiredString(record, 'session_item_id', issues)
        const purpose = defaultedString(record, 'purpose', 'explanation', issues)
        if (issues.length > 0) throw schemaError(issues)
        const item = itemInScope(ctx.db, ctx.userId, ctx.params.project_id, sessionItemId)
        const key = idempotencyKeyOf(ctx)
        const scope = `tutor_sessions.create:${sessionItemId}`
        return transaction(ctx.db, () => {
          const replay = claimOrConflict(ctx, scope, key, ctx.body ?? {})
          if (replay !== null) return { status: replay.statusCode, body: replay.body }
          const session = createTutorSession(ctx.db, ctx.userId, item, purpose, ctx.now)
          const result = tutorSessionPayload(session)
          recordResult(ctx.db, {
            userId: ctx.userId,
            routeScope: scope,
            key,
            statusCode: 201,
            responseBody: result,
            resourceType: 'tutor_session',
            resourceId: String(session.id),
            now: ctx.now,
          })
          return { status: 201, body: result }
        })
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/tutor-sessions`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        return listTutorSessions(ctx.db, ctx.userId, ctx.params.project_id, {
          sessionItemId: ctx.query.get('session_item_id'),
          limit: intQuery(ctx, 'limit', 20),
        })
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/tutor-sessions/:tutor_session_id/messages`,
      handler: async (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const record = bodyObject(ctx)
        const issues: SchemaIssue[] = []
        const userQuestion = defaultedString(record, 'user_question', '', issues)
        const purpose = optionalString(record, 'purpose', issues)
        if (issues.length > 0) throw schemaError(issues)
        const tutorSessionId = ctx.params.tutor_session_id
        const session = sessionScope(ctx.db, ctx.userId, ctx.params.project_id, tutorSessionId)
        const key = idempotencyKeyOf(ctx)
        const scope = `tutor_messages.create:${tutorSessionId}`
        const replay = transaction(ctx.db, () => claimOrConflict(ctx, scope, key, ctx.body ?? {}))
        if (replay !== null) {
          const jobId = storedResourceId(ctx.db, replay.recordId)
          const job = jobId === '' ? null : findOne(ctx.db, 'tutoring_job', { id: jobId })
          if (job === null) return { status: replay.statusCode, body: replay.body }
          // A cached job still holds the answer: re-serialise it under the gate that applies *now*.
          assertJobDeliverable(ctx.db, job)
          return { status: replay.statusCode, body: jobPayload(ctx.db, job) }
        }
        try {
          const created = createTutorJob(ctx.db, {
            tutorSession: session,
            userId: ctx.userId,
            userQuestion,
            purpose,
            now: ctx.now,
          })
          const finished = await runTutorJob(ctx.db, created.job, { port: portOf(deps), now: ctx.now })
          const result = jobPayload(ctx.db, finished)
          transaction(ctx.db, () =>
            recordResult(ctx.db, {
              userId: ctx.userId,
              routeScope: scope,
              key,
              statusCode: 201,
              responseBody: result,
              resourceType: 'tutor_job',
              resourceId: String(finished.id),
              now: ctx.now,
            }),
          )
          return { status: 201, body: result }
        } catch (error) {
          // A failed request must not block the retry with the same key (Django's rollback does the
          // same: the claim only exists if the effect committed).
          transaction(ctx.db, () => release(ctx.db, ctx.userId, scope, key))
          throw error
        }
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/tutor-jobs/:job_id`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const job = jobInScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.job_id)
        // B02: a cached job still holds the answer. Reading it obeys the same content gate.
        assertJobDeliverable(ctx.db, job)
        return jobPayload(ctx.db, job)
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/tutor-jobs/:job_id/segments`,
      handler: (ctx) => {
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const job = jobInScope(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.job_id)
        // Same rows, same staleness rule as the stream, so both surfaces agree.
        assertJobDeliverable(ctx.db, job)
        return segmentsPayload(ctx.db, job)
      },
    },
  ]
}

function jobInScope(db: DatabaseSync, userId: string, projectId: string, jobId: string): Row {
  const job = findOne(db, 'tutoring_job', { id: jobId })
  if (job === null || String(job.user_id) !== userId || String(job.project_id) !== projectId) {
    throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
  }
  return job
}

/** The purposes this API accepts, re-exported so a client can name them from one place. */
export const TUTOR_PURPOSE_VALUES = TUTOR_PURPOSES
