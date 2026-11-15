/**
 * HTTP surface for retrieval: the hybrid search read and the explicit project reindex.
 *
 * Port of `backend/apps/search/api.py`.
 *
 * Both operations are owner-scoped through `require_project`, so another user's project is a 404
 * (never a 403 that would confirm it exists). The retrieval response is the hybrid service payload
 * verbatim — including the channel availability block — because a caller must be able to see *why*
 * the vector channel did or did not take part. In DSH it never does: `channels.vector.code` is
 * `vector_not_configured` and `notes` says so in words.
 *
 * `POST …/search/reindex` carries Django's idempotency contract: scope `search.reindex:{project_id}`
 * and payload `{"subject_id": <id|null>}`, so a retry with the same key replays the recorded report
 * instead of re-indexing.
 */
import type { Route, RouteContext } from './router.ts'
import { transaction } from '../store/db.ts'
import { claim, recordResult } from '../store/idempotency.ts'
import { IdempotencyConflict as StoreIdempotencyConflict } from '../store/idempotency.ts'
import { pyCodePointLen } from '../domain/ingestion/pystring.ts'
import { pyStrip } from '../domain/pytext.ts'
import { IdempotencyConflictError, InvalidInput } from '../services/errors.ts'
import { requireProject, requireSubject } from '../services/exams.ts'
import { reindexProject, search } from '../services/search.ts'

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

/**
 * `limit: int = Query(10, ge=1, le=50)` — Ninja refuses an out-of-range or unparsable value.
 *
 * The service clamps too (`hybrid.search` does), but a client bug that silently becomes "10 results"
 * is harder to notice than an explicit refusal, so the boundary is checked here as well.
 */
function limitQuery(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 10
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new InvalidInput('请求参数校验失败', {
      details: {
        errors: [{ type: 'greater_than_equal', loc: ['query', 'limit'], msg: 'Input should be between 1 and 50' }],
      },
    })
  }
  return parsed
}

export function searchRoutes(): Route[] {
  return [
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/search`,
      handler: (ctx) =>
        search(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          {
            q: ctx.query.get('q') ?? '',
            subjectId: optional(ctx.query.get('subject_id')),
            limit: limitQuery(ctx.query.get('limit')),
            channel: ctx.query.get('channel') ?? 'hybrid',
          },
          ctx.now,
        ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/search/reindex`,
      handler: (ctx) => {
        // Django resolves the project and the subject *before* it reads the idempotency key, so an
        // unknown project (or a subject from another project) is a 404 even when the key is missing.
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const rawSubject = bodyRecord(ctx).subject_id
        const subjectId = rawSubject === null || rawSubject === undefined ? null : String(rawSubject)
        const subject = subjectId === null ? null : requireSubject(ctx.db, ctx.userId, String(project.id), subjectId)
        const key = idempotencyKey(ctx)
        const scope = `search.reindex:${ctx.params.project_id}`
        const payload = { subject_id: subject === null ? null : String(subject.id) }
        return transaction(ctx.db, () => {
          let replay: ReturnType<typeof claim>
          try {
            replay = claim(ctx.db, {
              userId: ctx.userId,
              routeScope: scope,
              key,
              payload,
              now: ctx.now,
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
          const body = reindexProject(
            ctx.db,
            ctx.userId,
            ctx.params.project_id,
            subject === null ? null : String(subject.id),
            ctx.now,
          )
          recordResult(ctx.db, {
            userId: ctx.userId,
            routeScope: scope,
            key,
            statusCode: 200,
            responseBody: body,
            now: ctx.now,
          })
          return { status: 200, body }
        })
      },
    },
  ]
}
