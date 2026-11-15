/**
 * Transactional outbox — port of `backend/apps/audit/services/outbox.py`.
 *
 * The semantics that matter, and why each exists (they are all bug fixes in the Python history):
 *
 * - A row is only "done" when a consumer *confirms* it (`processed_at`), never when a broker
 *   accepts the hand-off. A dispatcher killed after the hand-off therefore leaves a recoverable
 *   leased row rather than a silently lost message.
 * - A claim carries a token. Confirming or failing with the wrong token is refused, so a consumer
 *   whose lease expired cannot overwrite the takeover's committed outcome (the C04 double-write).
 * - A failure recorded against a row that already reached a terminal success is ignored (B05):
 *   otherwise a failure after a newer success flipped `processed` back to `pending` and produced a
 *   permanent retry loop.
 * - `attempts` is a cap, not a hint: a row that exhausted its budget is never handed off again.
 *
 * Postgres `SELECT ... FOR UPDATE SKIP LOCKED` has no SQLite equivalent. `BEGIN IMMEDIATE` gives the
 * same *outcome* for this design: writers are serialised, so the claim is atomic, and a consumer
 * that cannot take the lease returns `null` instead of blocking.
 */
import { randomUUID, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import { transaction } from './db.ts'

export const OUTBOX_STATUS = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
} as const

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS]

/** States that still need work: nothing here has been confirmed done. */
export const UNRESOLVED_STATUSES: readonly OutboxStatus[] = [
  OUTBOX_STATUS.PENDING,
  OUTBOX_STATUS.DISPATCHED,
  OUTBOX_STATUS.PROCESSING,
  OUTBOX_STATUS.FAILED,
]

/** States a scan may re-deliver. `failed` is deliberately absent: that is an operator decision. */
export const RECOVERABLE_STATUSES: readonly OutboxStatus[] = [
  OUTBOX_STATUS.PENDING,
  OUTBOX_STATUS.DISPATCHED,
  OUTBOX_STATUS.PROCESSING,
]

export const DEFAULT_LEASE_SECONDS = 300
export const DEFAULT_BACKOFF_SECONDS = 30
export const MAX_BACKOFF_SECONDS = 1800
export const DEFAULT_MAX_ATTEMPTS = 8

export interface OutboxEvent {
  id: string
  topic: string
  payload: unknown
  status: OutboxStatus
  attempts: number
  maxAttempts: number
  availableAt: Instant
  dispatchedAt: Instant | null
  claimedAt: Instant | null
  claimToken: string
  leaseExpiresAt: Instant | null
  processedAt: Instant | null
  lastError: string
  dedupeKey: string | null
}

interface RawRow {
  id: string
  topic: string
  payload: string
  status: string
  attempts: number
  max_attempts: number
  available_at: string
  dispatched_at: string | null
  claimed_at: string | null
  claim_token: string
  lease_expires_at: string | null
  processed_at: string | null
  last_error: string
  dedupe_key: string | null
}

const SELECT_COLUMNS =
  '"id", "topic", "payload", "status", "attempts", "max_attempts", "available_at", "dispatched_at", ' +
  '"claimed_at", "claim_token", "lease_expires_at", "processed_at", "last_error", "dedupe_key"'

function toInstant(value: string | null): Instant | null {
  return value === null ? null : parseInstant(value)
}

function fromRow(row: RawRow): OutboxEvent {
  return {
    id: row.id,
    topic: row.topic,
    payload: JSON.parse(row.payload),
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: parseInstant(row.available_at),
    dispatchedAt: toInstant(row.dispatched_at),
    claimedAt: toInstant(row.claimed_at),
    claimToken: row.claim_token,
    leaseExpiresAt: toInstant(row.lease_expires_at),
    processedAt: toInstant(row.processed_at),
    lastError: row.last_error,
    dedupeKey: row.dedupe_key,
  }
}

function readEvent(db: DatabaseSync, eventId: string): OutboxEvent | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM "audit_outbox_event" WHERE "id" = ?`).get(eventId) as
    | RawRow
    | undefined
  return row === undefined ? null : fromRow(row)
}

/** Exponential backoff between delivery attempts, capped. */
export function backoffSeconds(attempts: number, base = DEFAULT_BACKOFF_SECONDS): number {
  return Math.min(base * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS)
}

/** True while this event still needs a consumer to confirm it. */
export function isRecoverable(event: OutboxEvent): boolean {
  return event.processedAt === null && event.status !== OUTBOX_STATUS.PROCESSED
}

/** Unleased, or leased but past its expiry. */
function isLeaseAvailable(event: OutboxEvent, now: Instant): boolean {
  return event.leaseExpiresAt === null || event.leaseExpiresAt <= now
}

/**
 * Persist an event in the caller's transaction.
 *
 * A dedupe hit on an event that never got processed re-arms the existing row instead of returning a
 * dead no-op: the caller's intent is "make sure this effect happens", and a row with no
 * `processed_at` has not happened yet.
 */
export function enqueue(
  db: DatabaseSync,
  options: {
    topic: string
    payload?: unknown
    dedupeKey?: string | null
    delaySeconds?: number
    now: Instant
    maxAttempts?: number
  },
): OutboxEvent {
  const { now, topic } = options
  const delay = Math.max(options.delaySeconds ?? 0, 0)
  const availableAt = now + BigInt(delay) * 1_000_000n
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const dedupeKey = options.dedupeKey ?? null

  if (dedupeKey !== null) {
    const existing = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM "audit_outbox_event" WHERE "dedupe_key" = ?`)
      .get(dedupeKey) as RawRow | undefined
    if (existing !== undefined) {
      const event = fromRow(existing)
      if (isRecoverable(event) && event.status === OUTBOX_STATUS.FAILED) {
        // A previous attempt exhausted its retries; a fresh enqueue from the same business action
        // is an explicit request to try again.
        db.prepare(
          `UPDATE "audit_outbox_event"
              SET "status" = ?, "available_at" = ?, "attempts" = 0, "last_error" = '', "updated_at" = ?
            WHERE "id" = ?`,
        ).run(OUTBOX_STATUS.PENDING, formatPythonIso(availableAt), formatPythonIso(now), event.id)
        return readEvent(db, event.id)!
      }
      return event
    }
  }

  const id = randomUUID()
  const stamp = formatPythonIso(now)
  db.prepare(
    `INSERT INTO "audit_outbox_event" ("id","created_at","updated_at","topic","payload","status","attempts",
       "max_attempts","available_at","dispatched_at","claimed_at","claim_token","lease_expires_at",
       "processed_at","last_error","dedupe_key")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    stamp,
    stamp,
    topic,
    JSON.stringify(options.payload ?? {}),
    OUTBOX_STATUS.PENDING,
    0,
    maxAttempts,
    formatPythonIso(availableAt),
    null,
    null,
    '',
    null,
    null,
    '',
    dedupeKey,
  )
  return readEvent(db, id)!
}

/**
 * Claim a row for one consumer. Returns `null` when someone else holds a live lease.
 *
 * The whole check-and-set runs inside one `BEGIN IMMEDIATE` transaction, so two consumers cannot
 * both observe the row as free.
 */
export function claimEvent(
  db: DatabaseSync,
  options: { eventId: string; leaseSeconds?: number; now: Instant },
): OutboxEvent | null {
  const { eventId, now } = options
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  return transaction(db, () => {
    const event = readEvent(db, eventId)
    if (event === null) return null
    if (event.processedAt !== null || event.status === OUTBOX_STATUS.PROCESSED) return null
    if (event.status === OUTBOX_STATUS.PROCESSING && event.leaseExpiresAt !== null && event.leaseExpiresAt > now) {
      return null
    }
    const token = randomBytes(16).toString('hex')
    db.prepare(
      `UPDATE "audit_outbox_event"
          SET "status" = ?, "claimed_at" = ?, "claim_token" = ?, "lease_expires_at" = ?, "updated_at" = ?
        WHERE "id" = ?`,
    ).run(
      OUTBOX_STATUS.PROCESSING,
      formatPythonIso(now),
      token,
      formatPythonIso(now + BigInt(leaseSeconds) * 1_000_000n),
      formatPythonIso(now),
      eventId,
    )
    return readEvent(db, eventId)
  })
}

/** Consumer-side confirmation. This is the only terminal success. */
export function markProcessed(
  db: DatabaseSync,
  options: { eventId: string; claimToken?: string; now: Instant },
): boolean {
  const { eventId, now } = options
  const stamp = formatPythonIso(now)
  const token = options.claimToken ?? ''
  const result =
    token === ''
      ? db
          .prepare(
            `UPDATE "audit_outbox_event"
                SET "status" = ?, "processed_at" = ?, "claimed_at" = NULL, "claim_token" = '',
                    "lease_expires_at" = NULL, "last_error" = '', "updated_at" = ?
              WHERE "id" = ?`,
          )
          .run(OUTBOX_STATUS.PROCESSED, stamp, stamp, eventId)
      : db
          .prepare(
            `UPDATE "audit_outbox_event"
                SET "status" = ?, "processed_at" = ?, "claimed_at" = NULL, "claim_token" = '',
                    "lease_expires_at" = NULL, "last_error" = '', "updated_at" = ?
              WHERE "id" = ? AND "claim_token" = ?`,
          )
          .run(OUTBOX_STATUS.PROCESSED, stamp, stamp, eventId, token)
  return Number(result.changes) > 0
}

/**
 * Re-read a claim, returning it only while *this* consumer owns it.
 *
 * A consumer that already lost the row (lease expired and a takeover re-claimed it, or the row was
 * confirmed) must not go on to write job results — otherwise the stale consumer overwrites the
 * takeover's committed outcome.
 */
export function holdClaim(
  db: DatabaseSync,
  options: { eventId: string; claimToken: string },
): OutboxEvent | null {
  const event = readEvent(db, options.eventId)
  if (event === null || event.processedAt !== null) return null
  if (!options.claimToken || event.claimToken !== options.claimToken) return null
  return event
}

/**
 * Record a failed attempt and schedule the next one.
 *
 * Refuses to touch a row that already reached a terminal success (B05), and only the holder of the
 * current claim may record a failure for a claim.
 */
export function markRetryableFailure(
  db: DatabaseSync,
  options: {
    eventId: string
    error: string
    recoverable?: boolean
    claimToken?: string
    now: Instant
  },
): boolean {
  const { eventId, now } = options
  const recoverable = options.recoverable ?? true
  const event = readEvent(db, eventId)
  if (event === null) return false
  const attempts = event.attempts + 1
  const exhausted = attempts >= (event.maxAttempts || DEFAULT_MAX_ATTEMPTS)
  const status =
    recoverable && !exhausted ? OUTBOX_STATUS.PENDING : OUTBOX_STATUS.FAILED
  const availableAt =
    recoverable && !exhausted
      ? now + BigInt(backoffSeconds(attempts)) * 1_000_000n
      : // Failed rows keep a recoverable slot so an operator scan can revisit them.
        now + BigInt(MAX_BACKOFF_SECONDS) * 1_000_000n
  const stamp = formatPythonIso(now)
  const token = options.claimToken ?? ''
  const sql = `UPDATE "audit_outbox_event"
      SET "status" = ?, "attempts" = ?, "last_error" = ?, "claimed_at" = NULL, "claim_token" = '',
          "lease_expires_at" = NULL, "available_at" = ?, "updated_at" = ?
    WHERE "id" = ? AND "processed_at" IS NULL${token === '' ? '' : ' AND "claim_token" = ?'}`
  const params: (string | number)[] = [
    status,
    attempts,
    String(options.error).slice(0, 500),
    formatPythonIso(availableAt),
    stamp,
    eventId,
  ]
  if (token !== '') params.push(token)
  const result = db.prepare(sql).run(...params)
  return Number(result.changes) > 0
}

/** Record a failure for the exact claim, never for a terminal row. */
export function failClaim(
  db: DatabaseSync,
  options: { eventId: string; claimToken: string; error: string; recoverable?: boolean; now: Instant },
): boolean {
  return markRetryableFailure(db, {
    eventId: options.eventId,
    error: options.error,
    recoverable: options.recoverable,
    claimToken: options.claimToken,
    now: options.now,
  })
}

/**
 * Select the events that are due and free, and mark them dispatched with a delivery lease.
 *
 * The lease is set *before* the caller hands the message anywhere: a dispatcher killed between the
 * two leaves a recoverable leased row, never a lost message and never a double hand-off.
 */
export function dispatchPending(
  db: DatabaseSync,
  options: { limit?: number; now: Instant; leaseSeconds?: number; countAttempt?: boolean },
): OutboxEvent[] {
  const { now } = options
  const limit = options.limit ?? 100
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const countAttempt = options.countAttempt ?? true

  return transaction(db, () => {
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM "audit_outbox_event"
          WHERE "status" IN ('pending','dispatched','processing')
            AND "available_at" <= ?
            AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ?)
          ORDER BY "available_at"
          LIMIT ?`,
      )
      .all(formatPythonIso(now), formatPythonIso(now), limit) as unknown as RawRow[]

    // A row that exhausted its budget is never handed off again: the counter is a cap (B05).
    const handoff = rows.map(fromRow).filter((event) => event.attempts < event.maxAttempts)
    if (handoff.length === 0) return []

    const stamp = formatPythonIso(now)
    const lease = formatPythonIso(now + BigInt(leaseSeconds) * 1_000_000n)
    for (const event of handoff) {
      db.prepare(
        `UPDATE "audit_outbox_event"
            SET "dispatched_at" = ?, "attempts" = ?, "updated_at" = ?,
                "status" = CASE WHEN "status" IN ('pending','dispatched') THEN ? ELSE "status" END,
                "lease_expires_at" = CASE WHEN "status" IN ('pending','dispatched') THEN ? ELSE "lease_expires_at" END
          WHERE "id" = ? AND "processed_at" IS NULL`,
      ).run(
        stamp,
        countAttempt ? event.attempts + 1 : event.attempts,
        stamp,
        OUTBOX_STATUS.DISPATCHED,
        lease,
        event.id,
      )
    }
    // Return the post-dispatch state so the caller sees the lease it must respect.
    return handoff.map((event) => readEvent(db, event.id)!)
  })
}

/**
 * Re-arm rows whose lease expired, then re-deliver.
 *
 * An abandoned claim is cleared, so a dead worker's lease cannot block the next delivery.
 * `includeFailed` additionally resets rows that exhausted their budget — an operator decision,
 * never automatic.
 */
export function recoverStale(
  db: DatabaseSync,
  options: { limit?: number; includeFailed?: boolean; now: Instant; leaseSeconds?: number },
): number {
  const { now } = options
  const stamp = formatPythonIso(now)
  return transaction(db, () => {
    const released = Number(
      db
        .prepare(
          `UPDATE "audit_outbox_event"
              SET "status" = ?, "claimed_at" = NULL, "claim_token" = '', "lease_expires_at" = NULL,
                  "last_error" = '消费者租约过期，任务已重新排队', "updated_at" = ?
            WHERE "status" = ? AND "lease_expires_at" IS NOT NULL AND "lease_expires_at" <= ?
              AND "processed_at" IS NULL`,
        )
        .run(OUTBOX_STATUS.PENDING, stamp, OUTBOX_STATUS.PROCESSING, formatPythonIso(now)).changes,
    )
    let failed = 0
    if (options.includeFailed === true) {
      failed = Number(
        db
          .prepare(
            `UPDATE "audit_outbox_event"
                SET "status" = ?, "attempts" = 0, "available_at" = ?, "lease_expires_at" = NULL,
                    "last_error" = '', "updated_at" = ?
              WHERE "status" = ? AND "processed_at" IS NULL`,
          )
          .run(OUTBOX_STATUS.PENDING, stamp, stamp, OUTBOX_STATUS.FAILED).changes,
      )
    }
    return released + failed
  })
}

/** Operational view of what still has not been confirmed done. */
export function unresolvedSummary(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare('SELECT "status", COUNT(*) AS n FROM "audit_outbox_event" WHERE "processed_at" IS NULL GROUP BY "status"')
    .all() as { status: string; n: number }[]
  const summary: Record<string, number> = {}
  for (const row of rows) summary[row.status] = row.n
  return summary
}

export { isLeaseAvailable }
