/**
 * HTTP surface for the learning reads and the study-task lifecycle (B8).
 *
 * Every handler here is an adapter: parse the query/body into the shape the service expects, call it,
 * return the service value. The patterns keep Django's form after `/api/acepass`; they contain
 * `:param` segments, which DSH's exact-path Fetch registry cannot mount (04 §O1), so the browser
 * reaches them through the `/api/acepass/rpc` envelope — the same `createFetchHandler` replays them.
 *
 * Idempotency scopes are copied **verbatim** from `apps/learning/api.py`, because the scope string is
 * part of the replay contract: `tasks.start:{task_id}`, `tasks.defer:{task_id}`, `tasks.skip:{task_id}`.
 * `POST /study-tasks/{id}/complete` has no scope in Django either — it is naturally idempotent by
 * status, and inventing a journal entry for it would make a second attempt answer a stale body.
 */
import type { Route, RouteContext } from './router.ts'
import { transaction } from '../store/db.ts'
import { claim, recordResult } from '../store/idempotency.ts'
import { IdempotencyConflict as StoreIdempotencyConflict } from '../store/idempotency.ts'
import { pyCodePointLen, pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { pyStrip } from '../domain/pytext.ts'
import { IdempotencyConflictError, InvalidInput, ScopeViolation } from '../services/errors.ts'
import {
  completeTask,
  createSessionHint,
  deferTask,
  delayedIntervalStatus,
  getTask,
  invalidateTask,
  listReviewTasks,
  reconcileDelayedTasks,
  skipTask,
  startTask,
  todayPayload,
  UnusableQuestion,
} from '../services/learning_extra.ts'
import { findOne } from '../store/repository.ts'
import { requireProject } from '../services/exams.ts'
import { getQuestionExposure, recordExternalSeen } from '../services/exposure.ts'

const PREFIX = '/api/acepass'

function bodyRecord(ctx: RouteContext): Record<string, unknown> {
  const body = ctx.body
  if (body === null || body === undefined) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw new InvalidInput('请求体必须是 JSON 对象')
  return body as Record<string, unknown>
}

function optional(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  return value
}

/** Django's `idempotency_key`: trim, non-empty, at most 200 code points, 409 on violation. */
function idempotencyKey(ctx: RouteContext): string {
  const key = pyStrip(ctx.headers.get('idempotency-key') ?? '')
  if (key === '') throw new IdempotencyConflictError('缺少 Idempotency-Key 请求头')
  if (pyCodePointLen(key) > 200) throw new IdempotencyConflictError('Idempotency-Key 过长')
  return key
}

/** `ReasonIn`: `reason` defaults to `""`, and Django fingerprints `{"reason": ...}`. */
function reasonOf(ctx: RouteContext): string {
  const raw = bodyRecord(ctx).reason
  return raw === null || raw === undefined ? '' : String(raw)
}

/**
 * `ExternalSeenIn`: `seen` defaults to `true`, `note` to `""`.
 *
 * The defaults are applied *before* the idempotency fingerprint, which is what makes a retry of
 * "mark as seen" with the same key and no body replay the first declaration instead of conflicting.
 */
function externalSeenInput(ctx: RouteContext): { seen: boolean; note: string } {
  const body = bodyRecord(ctx)
  const rawSeen = body.seen
  let seen = true
  if (rawSeen !== undefined && rawSeen !== null) {
    if (typeof rawSeen !== 'boolean') {
      throw new InvalidInput('请求参数校验失败', {
        details: { errors: [{ type: 'bool_type', loc: ['body', 'payload', 'seen'], msg: 'Input should be a valid boolean' }] },
      })
    }
    seen = rawSeen
  }
  const rawNote = body.note
  return { seen, note: rawNote === undefined || rawNote === null ? '' : pyCodePointSlice(String(rawNote), 0, 300) }
}

/** Ninja's bool query parsing (pydantic): the accepted spellings of "true" and "false". */
function boolQuery(raw: string | null, fallback = false): boolean {
  if (raw === null || raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on', 't'].includes(value)) return true
  if (['false', '0', 'no', 'off', 'f'].includes(value)) return false
  throw new InvalidInput('查询参数必须是布尔值', { details: { value: raw } })
}

function intQuery(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new InvalidInput('查询参数必须是整数', { details: { value: raw } })
  }
  return Math.trunc(parsed)
}

/**
 * Claim + effect + result in one transaction, with Django's conflict details.
 *
 * The claim and the side effect share the SQLite transaction, so a rejected request rolls its claim
 * back and a retry with the same key behaves exactly like the original.
 */
function resource(
  scopeOf: (ctx: RouteContext) => string,
  handler: (ctx: RouteContext) => { status: number; body: unknown },
  payloadOf: (ctx: RouteContext) => unknown = (ctx) => ctx.body ?? {},
  onRefused: (ctx: RouteContext, error: unknown) => void = () => undefined,
): Route['handler'] {
  return (ctx) => {
    const key = idempotencyKey(ctx)
    const scope = scopeOf(ctx)
    try {
      return claimAndRun(ctx)
    } catch (error) {
      // The claim and the effect share a transaction, so a refusal rolls both back. Django's
      // `start_task` saves the invalidation *before* raising and has no request transaction to undo
      // it, so a refusal that recorded a fact has to write it again here — outside the rollback.
      onRefused(ctx, error)
      throw error
    }

    function claimAndRun(inner: RouteContext): { status: number; body: unknown } {
      return transaction(inner.db, () => {
        let replay: ReturnType<typeof claim>
        try {
          replay = claim(inner.db, {
            userId: inner.userId,
            routeScope: scope,
            key,
            payload: payloadOf(inner),
            now: inner.now,
          })
        } catch (error) {
          if (error instanceof StoreIdempotencyConflict) {
            const message =
              error.reason === 'in_flight'
                ? '相同幂等键的请求正在处理中，请稍后重试'
                : '相同幂等键使用了不同请求内容'
            throw new IdempotencyConflictError(message, {
              details: { route_scope: error.routeScope, reason: error.reason },
            })
          }
          throw error
        }
        if (replay !== null) return { status: replay.statusCode, body: replay.body }
        const result = handler(inner)
        recordResult(inner.db, {
          userId: inner.userId,
          routeScope: scope,
          key,
          statusCode: result.status,
          responseBody: result.body,
          now: inner.now,
        })
        return result
      })
    }
  }
}

export function learningExtraRoutes(): Route[] {
  return [
    // ---- today plan ---------------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/study-plans/today`,
      handler: (ctx) => todayPayload(ctx.db, ctx.userId, ctx.now),
    },
    // ---- review queue -------------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/review-tasks`,
      handler: (ctx) =>
        listReviewTasks(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          {
            subjectId: optional(ctx.query.get('subject_id')),
            onlyDue: boolQuery(ctx.query.get('only_due'), false),
          },
          ctx.now,
        ),
    },
    // ---- study tasks --------------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/study-tasks/:task_id`,
      handler: (ctx) => getTask(ctx.db, ctx.userId, ctx.params.task_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/study-tasks/:task_id/start`,
      handler: resource(
        (ctx) => `tasks.start:${ctx.params.task_id}`,
        (ctx) => {
          const { task, status } = startTask(ctx.db, ctx.userId, ctx.params.task_id, ctx.now)
          return {
            status: 200,
            body: {
              task_id: String(task.id),
              status: String(task.status),
              project_id: String(task.project_id),
              subject_id: String(task.subject_id),
              question_id:
                task.question_id === null || task.question_id === undefined ? null : String(task.question_id),
              delay_status: status,
              create_session_hint: createSessionHint(task),
            },
          }
        },
        // Django claims the start with an empty payload: the task id and the key are the whole
        // request, so a repeated key must replay rather than re-validate the interval (which may have
        // moved on since).
        () => ({}),
        (inner, error) => {
          if (error instanceof UnusableQuestion) {
            invalidateTask(inner.db, inner.userId, inner.params.task_id, error.reason, inner.now)
          }
        },
      ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/study-tasks/:task_id/defer`,
      handler: resource(
        (ctx) => `tasks.defer:${ctx.params.task_id}`,
        (ctx) => {
          const task = deferTask(ctx.db, ctx.userId, ctx.params.task_id, reasonOf(ctx), ctx.now)
          return {
            status: 200,
            body: { task_id: String(task.id), status: String(task.status), reason_codes: task.reason_codes ?? [] },
          }
        },
        (ctx) => ({ reason: reasonOf(ctx) }),
      ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/study-tasks/:task_id/skip`,
      handler: resource(
        (ctx) => `tasks.skip:${ctx.params.task_id}`,
        (ctx) => {
          const task = skipTask(ctx.db, ctx.userId, ctx.params.task_id, reasonOf(ctx), ctx.now)
          return { status: 200, body: { task_id: String(task.id), status: String(task.status) } }
        },
        (ctx) => ({ reason: reasonOf(ctx) }),
      ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/study-tasks/:task_id/complete`,
      handler: (ctx) => completeTask(ctx.db, ctx.userId, ctx.params.task_id, ctx.now),
    },
    // ---- exposure ledger (C04): the read path and the learner's own declaration ---------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id/exposure`,
      handler: (ctx) =>
        getQuestionExposure(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.question_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id/external-seen`,
      handler: resource(
        (ctx) => `questions.external-seen:${ctx.params.question_id}`,
        (ctx) => {
          const input = externalSeenInput(ctx)
          const { result } = recordExternalSeen(
            ctx.db,
            ctx.userId,
            ctx.params.project_id,
            ctx.params.question_id,
            { seen: input.seen, note: input.note },
            ctx.now,
          )
          return { status: 201, body: result }
        },
        // Django fingerprints `ExternalSeenIn.model_dump()`, i.e. the *defaulted* body: a request
        // with no body and one carrying `{seen: true, note: ""}` are the same declaration.
        (ctx) => externalSeenInput(ctx),
      ),
    },
    // ---- delayed-interval reconciliation ------------------------------------------------------
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/study-tasks/:task_id/reconcile-delay`,
      handler: (ctx) => {
        // Django resolves the project and the task before doing anything, so a foreign id is a 404
        // even when nothing would have been reconciled.
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const task = findOne(ctx.db, 'learning_study_task', {
          id: ctx.params.task_id,
          user_id: ctx.userId,
          project_id: String(project.id),
        })
        if (task === null) throw new ScopeViolation('任务不存在或不在当前权限范围')
        const updated = reconcileDelayedTasks(ctx.db, ctx.now)
        return {
          reconciled_tasks: updated,
          task_id: String(task.id),
          delay_status: delayedIntervalStatus(ctx.db, task, ctx.now),
        }
      },
    },
  ]
}
