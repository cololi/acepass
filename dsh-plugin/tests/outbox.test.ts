import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore, transaction } from '../src/store/db.ts'
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_BACKOFF_SECONDS,
  OUTBOX_STATUS,
  backoffSeconds,
  claimEvent,
  dispatchPending,
  enqueue,
  failClaim,
  holdClaim,
  markProcessed,
  markRetryableFailure,
  recoverStale,
  unresolvedSummary,
} from '../src/store/outbox.ts'
import type { DatabaseSync } from 'node:sqlite'

const T0 = parseInstant('2026-02-01T00:00:00+00:00')
const at = (seconds: number): Instant => T0 + BigInt(Math.round(seconds * 1_000_000))

function store() {
  return openStore({ path: ':memory:' })
}

function only(db: DatabaseSync) {
  return db.prepare('SELECT COUNT(*) AS n FROM "audit_outbox_event"').get() as { n: number }
}

test('outbox: enqueue starts pending and due immediately', () => {
  const { db, close } = store()
  try {
    const event = enqueue(db, { topic: 'grade.attempt', payload: { id: 1 }, now: T0 })
    assert.equal(event.status, OUTBOX_STATUS.PENDING)
    assert.equal(event.attempts, 0)
    assert.equal(event.availableAt, T0)
    assert.deepEqual(event.payload, { id: 1 })
  } finally {
    close()
  }
})

test('outbox: a delay keeps the event out of the dispatch window', () => {
  const { db, close } = store()
  try {
    enqueue(db, { topic: 't', now: T0, delaySeconds: 60 })
    assert.equal(dispatchPending(db, { now: at(30) }).length, 0, 'not due yet')
    assert.equal(dispatchPending(db, { now: at(61) }).length, 1, 'due once the delay elapses')
  } finally {
    close()
  }
})

test('outbox: a dedupe key reuses one row, and re-arms a failed one', () => {
  const { db, close } = store()
  try {
    const first = enqueue(db, { topic: 't', dedupeKey: 'business-key', now: T0, maxAttempts: 1 })
    const second = enqueue(db, { topic: 't', dedupeKey: 'business-key', now: at(10) })
    assert.equal(first.id, second.id, 'the same business action must not create a second effect')
    assert.equal(only(db).n, 1)

    // Exhaust the retry budget, then enqueue again: the caller is asking for it to happen again.
    const claim = claimEvent(db, { eventId: first.id, now: T0 })!
    failClaim(db, { eventId: first.id, claimToken: claim.claimToken, error: 'boom', now: at(1) })
    const failed = db.prepare('SELECT "status" FROM "audit_outbox_event" WHERE "id" = ?').get(first.id) as {
      status: string
    }
    assert.equal(failed.status, OUTBOX_STATUS.FAILED)

    const rearmed = enqueue(db, { topic: 't', dedupeKey: 'business-key', now: at(20) })
    assert.equal(rearmed.status, OUTBOX_STATUS.PENDING)
    assert.equal(rearmed.attempts, 0)
    assert.equal(rearmed.lastError, '')
  } finally {
    close()
  }
})

test('outbox: a live lease blocks a second claim, an expired one does not', () => {
  const { db, close } = store()
  try {
    const event = enqueue(db, { topic: 't', now: T0 })
    const first = claimEvent(db, { eventId: event.id, now: T0, leaseSeconds: 60 })
    assert.ok(first)
    assert.equal(claimEvent(db, { eventId: event.id, now: at(30) }), null, 'lease still held')

    const takeover = claimEvent(db, { eventId: event.id, now: at(61) })
    assert.ok(takeover, 'an expired lease must be claimable')
    assert.notEqual(takeover.claimToken, first.claimToken)

    assert.equal(holdClaim(db, { eventId: event.id, claimToken: first.claimToken }), null, 'stale consumer lost it')
    assert.ok(holdClaim(db, { eventId: event.id, claimToken: takeover.claimToken }))
  } finally {
    close()
  }
})

test('outbox: only the owning token may confirm', () => {
  const { db, close } = store()
  try {
    const event = enqueue(db, { topic: 't', now: T0 })
    const claim = claimEvent(db, { eventId: event.id, now: T0 })!
    assert.equal(markProcessed(db, { eventId: event.id, claimToken: 'someone-else', now: T0 }), false)
    assert.equal(markProcessed(db, { eventId: event.id, claimToken: claim.claimToken, now: T0 }), true)

    const row = db.prepare('SELECT "status", "processed_at" FROM "audit_outbox_event" WHERE "id" = ?').get(event.id) as {
      status: string
      processed_at: string | null
    }
    assert.equal(row.status, OUTBOX_STATUS.PROCESSED)
    assert.notEqual(row.processed_at, null)
    assert.equal(claimEvent(db, { eventId: event.id, now: at(9999) }), null, 'a processed row is never re-claimed')
  } finally {
    close()
  }
})

test('outbox: a failure after a terminal success is ignored (B05)', () => {
  const { db, close } = store()
  try {
    const event = enqueue(db, { topic: 't', now: T0 })
    const claim = claimEvent(db, { eventId: event.id, now: T0 })!
    markProcessed(db, { eventId: event.id, claimToken: claim.claimToken, now: at(1) })

    const recorded = failClaim(db, {
      eventId: event.id,
      claimToken: claim.claimToken,
      error: 'late failure',
      now: at(2),
    })
    assert.equal(recorded, false, 'a completed effect must not be flipped back to pending')
    // ... and without a token either: the `processed_at IS NULL` guard, not the token check, is what
    // protects a terminal row. A token-free caller must not be able to resurrect it.
    assert.equal(
      markRetryableFailure(db, { eventId: event.id, error: 'late failure, no token', now: at(3) }),
      false,
    )
    const row = db.prepare('SELECT "status" FROM "audit_outbox_event" WHERE "id" = ?').get(event.id) as {
      status: string
    }
    assert.equal(row.status, OUTBOX_STATUS.PROCESSED)
  } finally {
    close()
  }
})

test('outbox: retryable failures back off exponentially and then exhaust', () => {
  const { db, close } = store()
  try {
    assert.equal(backoffSeconds(1), 30)
    assert.equal(backoffSeconds(2), 60)
    assert.equal(backoffSeconds(3), 120)
    assert.equal(backoffSeconds(20), MAX_BACKOFF_SECONDS, 'the backoff is capped')

    const event = enqueue(db, { topic: 't', now: T0, maxAttempts: 3 })
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const claim = claimEvent(db, { eventId: event.id, now: T0 })!
      assert.equal(failClaim(db, { eventId: event.id, claimToken: claim.claimToken, error: `e${attempt}`, now: T0 }), true)
      const row = db
        .prepare('SELECT "status", "attempts", "available_at" FROM "audit_outbox_event" WHERE "id" = ?')
        .get(event.id) as { status: string; attempts: number; available_at: string }
      assert.equal(row.status, OUTBOX_STATUS.PENDING)
      assert.equal(row.attempts, attempt)
      assert.equal(parseInstant(row.available_at), T0 + BigInt(backoffSeconds(attempt)) * 1_000_000n)
    }

    const finalClaim = claimEvent(db, { eventId: event.id, now: T0 })!
    failClaim(db, { eventId: event.id, claimToken: finalClaim.claimToken, error: 'last', now: T0 })
    const exhausted = db.prepare('SELECT "status", "attempts" FROM "audit_outbox_event" WHERE "id" = ?').get(event.id) as {
      status: string
      attempts: number
    }
    assert.equal(exhausted.status, OUTBOX_STATUS.FAILED)
    assert.equal(exhausted.attempts, 3)
  } finally {
    close()
  }
})

test('outbox: the attempt counter is a cap, not a hint', () => {
  const { db, close } = store()
  try {
    const event = enqueue(db, { topic: 't', now: T0, maxAttempts: 1 })
    // Already at the cap and still pending: it must not be handed off.
    db.prepare('UPDATE "audit_outbox_event" SET "attempts" = 1 WHERE "id" = ?').run(event.id)
    assert.equal(dispatchPending(db, { now: T0 }).length, 0)
    assert.equal(DEFAULT_MAX_ATTEMPTS, 8)
  } finally {
    close()
  }
})

test('outbox: dispatching leases the row before any hand-off', () => {
  const { db, close } = store()
  try {
    enqueue(db, { topic: 't', now: T0 })
    const dispatched = dispatchPending(db, { now: T0, leaseSeconds: 60 })
    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0].status, OUTBOX_STATUS.DISPATCHED)
    assert.equal(dispatched[0].attempts, 1, 'the hand-off counts as an attempt')
    assert.equal(dispatched[0].leaseExpiresAt, at(60))

    // While the delivery lease is live the scan must not hand the same event out again.
    assert.equal(dispatchPending(db, { now: at(30) }).length, 0)
    // After it expires the dead-worker case is recoverable.
    assert.equal(dispatchPending(db, { now: at(61) }).length, 1)
  } finally {
    close()
  }
})

test('outbox: recoverStale clears an abandoned claim and requeues', () => {
  const { db, close } = store()
  try {
    const event = enqueue(db, { topic: 't', now: T0 })
    claimEvent(db, { eventId: event.id, now: T0, leaseSeconds: 60 })
    assert.equal(recoverStale(db, { now: at(30) }), 0, 'the lease is still live')

    assert.equal(recoverStale(db, { now: at(61) }), 1)
    const row = db
      .prepare('SELECT "status", "claim_token", "lease_expires_at", "last_error" FROM "audit_outbox_event" WHERE "id" = ?')
      .get(event.id) as { status: string; claim_token: string; lease_expires_at: string | null; last_error: string }
    assert.equal(row.status, OUTBOX_STATUS.PENDING)
    assert.equal(row.claim_token, '')
    assert.equal(row.lease_expires_at, null)
    assert.match(row.last_error, /租约过期/)

    assert.equal(claimEvent(db, { eventId: event.id, now: at(62) }) !== null, true, 'claimable again')
  } finally {
    close()
  }
})

test('outbox: failed rows are only recovered when an operator asks', () => {
  const { db, close } = store()
  try {
    const event = enqueue(db, { topic: 't', now: T0, maxAttempts: 1 })
    const claim = claimEvent(db, { eventId: event.id, now: T0 })!
    failClaim(db, { eventId: event.id, claimToken: claim.claimToken, error: 'nope', now: T0 })

    assert.equal(recoverStale(db, { now: at(10) }), 0, 'a terminal failure is not automatic')
    assert.equal(recoverStale(db, { now: at(10), includeFailed: true }), 1)
    const row = db.prepare('SELECT "status", "attempts" FROM "audit_outbox_event" WHERE "id" = ?').get(event.id) as {
      status: string
      attempts: number
    }
    assert.equal(row.status, OUTBOX_STATUS.PENDING)
    assert.equal(row.attempts, 0)
  } finally {
    close()
  }
})

test('outbox: the summary counts everything not yet confirmed done', () => {
  const { db, close } = store()
  try {
    const a = enqueue(db, { topic: 'a', now: T0 })
    enqueue(db, { topic: 'b', now: T0 })
    const claim = claimEvent(db, { eventId: a.id, now: T0 })!
    markProcessed(db, { eventId: a.id, claimToken: claim.claimToken, now: T0 })

    assert.deepEqual(unresolvedSummary(db), { pending: 1 }, 'the processed row is not unresolved')
  } finally {
    close()
  }
})

test('outbox: the event is written in the caller transaction', () => {
  const { db, close } = store()
  try {
    assert.throws(() =>
      transaction(db, () => {
        enqueue(db, { topic: 't', now: T0 })
        throw new Error('boom')
      }),
    )
    assert.equal(only(db).n, 0, 'an aborted business action must not leave an outbox row behind')
  } finally {
    close()
  }
})
