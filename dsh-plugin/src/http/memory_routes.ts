/**
 * HTTP surface for FSRS memory cards: list, create, review, logs, rebuild, suspend, resume.
 *
 * Port of `backend/apps/memory/api.py`. Two things differ from the other write routes on purpose:
 *
 *  - **create has no generic idempotency journal.** Django does not claim a key here either: the
 *    `(user, question)` unique constraint makes a repeat answer `200` with the existing card, which
 *    is a better answer than replaying a stored body.
 *  - **review idempotency lives in the memory ledger** (`(card, idempotency_key)` is unique). The same
 *    key replays the stored log and recomputes the counters from the ledger, so the replay is
 *    identical to the original even when the card has moved on. Wrapping it in the request journal
 *    would return an older body and hide that property.
 *
 * Every handler is owner-scoped through the service layer: another user's project or card is a 404,
 * never a 403, so an outsider cannot probe for existence.
 */
import type { Route, RouteContext } from './router.ts'
import { InvalidInput } from '../services/errors.ts'
import {
  cardPayload,
  getOrCreateCard,
  listCards,
  listLogs,
  rebuildCardFromLogs,
  resumeCard,
  reviewCard,
  suspendCard,
} from '../services/memory.ts'

const PREFIX = '/api/acepass'

function bodyRecord(ctx: RouteContext): Record<string, unknown> {
  const body = ctx.body
  if (body === null || body === undefined) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw new InvalidInput('请求体必须是 JSON 对象')
  return body as Record<string, unknown>
}

/**
 * `include_suspended` as Ninja parses it (pydantic bool).
 *
 * The page always sends `true`/`false`; anything else is a client bug and is refused rather than
 * silently read as `false` — that direction would hide suspended cards without saying so.
 */
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
  if (!Number.isFinite(parsed)) throw new InvalidInput('查询参数必须是整数', { details: { value: raw } })
  return Math.trunc(parsed)
}

export function memoryRoutes(): Route[] {
  return [
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/memory-cards`,
      handler: (ctx) =>
        listCards(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          {
            dueBefore: ctx.query.get('due_before'),
            includeSuspended: boolQuery(ctx.query.get('include_suspended'), false),
            limit: intQuery(ctx.query.get('limit'), 50),
          },
          ctx.now,
        ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/memory-cards`,
      handler: (ctx) => {
        const questionId = String(bodyRecord(ctx).question_id ?? '')
        if (questionId.trim() === '') {
          throw new InvalidInput('请求参数校验失败', {
            details: { errors: [{ type: 'missing', loc: ['body', 'payload', 'question_id'], msg: 'Field required' }] },
          })
        }
        const { card, created } = getOrCreateCard(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          questionId,
          ctx.now,
        )
        return {
          status: created ? 201 : 200,
          body: cardPayload(ctx.db, card, ctx.now),
        }
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/memory-cards/:card_id/review`,
      handler: (ctx) => {
        const body = bodyRecord(ctx)
        if (body.rating === undefined || body.rating === null) {
          throw new InvalidInput('请求参数校验失败', {
            details: { errors: [{ type: 'missing', loc: ['body', 'payload', 'rating'], msg: 'Field required' }] },
          })
        }
        return reviewCard(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.card_id,
          {
            rating: body.rating,
            source_session_item_id:
              body.source_session_item_id === undefined || body.source_session_item_id === null
                ? null
                : String(body.source_session_item_id),
          },
          ctx.headers.get('idempotency-key') ?? '',
          ctx.now,
        )
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/memory-cards/:card_id/logs`,
      handler: (ctx) =>
        listLogs(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.card_id,
          intQuery(ctx.query.get('limit'), 200),
        ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/memory-cards/:card_id/rebuild`,
      handler: (ctx) =>
        rebuildCardFromLogs(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.card_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/memory-cards/:card_id/suspend`,
      handler: (ctx) => {
        const reason = bodyRecord(ctx).reason
        return suspendCard(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.card_id,
          reason === null || reason === undefined ? '' : String(reason),
          ctx.now,
        )
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/memory-cards/:card_id/resume`,
      handler: (ctx) =>
        resumeCard(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.card_id, ctx.now),
    },
  ]
}
