/**
 * Idempotency for requests with business side effects.
 *
 * Port of `backend/apps/audit/services/idempotency.py`. The rules are the same and they matter:
 *
 * - same key + same payload  -> replay the stored result, no second effect
 * - same key + other payload -> conflict (409)
 * - same key, still in flight -> conflict, never a guessed success
 * - a claim with no recorded result is released so the caller can retry
 *
 * The fingerprint is Python's `json.dumps` digest, not `JSON.stringify`'s, because a record written
 * before the migration must still replay afterwards (see `pyjson.ts`).
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { pyJsonCanonical } from './pyjson.ts'

export type IdempotencyConflictReason = 'same_key_different_payload' | 'in_flight'

export class IdempotencyConflict extends Error {
  reason: IdempotencyConflictReason
  routeScope: string
  constructor(reason: IdempotencyConflictReason, routeScope: string, message?: string) {
    super(
      message ??
        (reason === 'in_flight' ? '相同幂等键的请求正在处理中，请稍后重试' : '相同幂等键携带了不同的请求内容'),
    )
    this.name = 'IdempotencyConflict'
    this.reason = reason
    this.routeScope = routeScope
  }
}

export interface Replay {
  body: unknown
  statusCode: number
  recordId: string
}

interface RecordRow {
  id: string
  request_fingerprint: string
  status_code: number | null
  response_body: string | null
}

/** Stable digest of a JSON-serialisable request payload, identical to Python's `fingerprint()`. */
export function fingerprint(payload: unknown): string {
  return createHash('sha256').update(pyJsonCanonical(payload), 'utf8').digest('hex')
}

const COLUMNS =
  '"id", "user_id", "route_scope", "idempotency_key", "request_fingerprint", "status_code", ' +
  '"response_body", "resource_type", "resource_id", "created_at", "updated_at"'

function findRecord(db: DatabaseSync, userId: string, routeScope: string, key: string): RecordRow | undefined {
  return db
    .prepare(
      `SELECT "id", "request_fingerprint", "status_code", "response_body" FROM "audit_idempotency_record"
        WHERE "user_id" = ? AND "route_scope" = ? AND "idempotency_key" = ?`,
    )
    .get(userId, routeScope, key) as RecordRow | undefined
}

function replayOrConflict(existing: RecordRow, digest: string, routeScope: string): Replay {
  if (existing.request_fingerprint !== digest) {
    throw new IdempotencyConflict('same_key_different_payload', routeScope)
  }
  if (existing.response_body === null) {
    // The first attempt is still in flight (or died before recording a result). Reporting a conflict
    // is safer than guessing a success response.
    throw new IdempotencyConflict('in_flight', routeScope)
  }
  return {
    body: JSON.parse(existing.response_body),
    statusCode: existing.status_code ?? 200,
    recordId: existing.id,
  }
}

/**
 * Claim an idempotency key for this request.
 *
 * Returns a {@link Replay} when the caller must replay a stored result instead of executing the
 * effect, or `null` when the claim was granted.
 */
export function claim(
  db: DatabaseSync,
  options: { userId: string; routeScope: string; key: string; payload: unknown; now: Instant },
): Replay | null {
  const { userId, routeScope, key, now } = options
  if (!key) throw new Error('idempotency key is required for side-effecting requests')
  const digest = fingerprint(options.payload)

  const existing = findRecord(db, userId, routeScope, key)
  if (existing !== undefined) return replayOrConflict(existing, digest, routeScope)

  const stamp = formatPythonIso(now)
  try {
    db.prepare(`INSERT INTO "audit_idempotency_record" (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(),
      userId,
      routeScope,
      key,
      digest,
      null, // status_code: the claim is unfulfilled until a result is recorded
      null,
      '',
      '',
      stamp,
      stamp,
    )
  } catch (error) {
    // The unique constraint on (user, route_scope, key) is the arbiter, so a lost race simply
    // replays whatever the winner stored.
    const raced = findRecord(db, userId, routeScope, key)
    if (raced === undefined) throw error
    return replayOrConflict(raced, digest, routeScope)
  }
  return null
}

/** Drop an unfulfilled claim so a failed request does not block the retry with the same key. */
export function release(db: DatabaseSync, userId: string, routeScope: string, key: string): void {
  db.prepare(
    `DELETE FROM "audit_idempotency_record"
      WHERE "user_id" = ? AND "route_scope" = ? AND "idempotency_key" = ? AND "status_code" IS NULL`,
  ).run(userId, routeScope, key)
}

/**
 * Turn a response body into something the JSON column can store.
 *
 * A replayed response must equal the original one, so this is applied to the stored copy rather than
 * to the live response: decimals become strings (the wire format for Decimal in this API), and
 * instants/dates become ISO strings.
 */
export function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null
  // Tagged values must be handled before the generic object branch, or a Decimal would be
  // flattened into its internal fields instead of its wire-format string.
  if (value instanceof Decimal) return value.toString()
  if (typeof value === 'bigint') return formatPythonIso(value)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = jsonSafe(item)
    return out
  }
  return value
}

/** Record the result of a fulfilled request so the next same-key call can replay it. */
export function recordResult(
  db: DatabaseSync,
  options: {
    userId: string
    routeScope: string
    key: string
    statusCode: number
    responseBody: unknown
    resourceType?: string
    resourceId?: string
    now: Instant
  },
): void {
  db.prepare(
    `UPDATE "audit_idempotency_record"
        SET "status_code" = ?, "response_body" = ?, "resource_type" = ?, "resource_id" = ?, "updated_at" = ?
      WHERE "user_id" = ? AND "route_scope" = ? AND "idempotency_key" = ?`,
  ).run(
    options.statusCode,
    JSON.stringify(jsonSafe(options.responseBody)),
    options.resourceType ?? '',
    String(options.resourceId ?? ''),
    formatPythonIso(options.now),
    options.userId,
    options.routeScope,
    options.key,
  )
}
