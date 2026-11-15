import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore, transaction } from '../src/store/db.ts'
import { OUTBOX_STATUS, claimEvent, enqueue, markProcessed } from '../src/store/outbox.ts'

/**
 * A real file on disk, opened twice.
 *
 * The in-memory tests cannot show that the chosen journal mode survives a process that dies without
 * a clean shutdown, which is the actual failure mode this store has to tolerate (SIGKILL during a
 * delivery, phase 4's drill).
 */

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'acepass-store-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('store file: data survives a close and a reopen', () => {
  withTempDir((dir) => {
    const path = join(dir, '.acepass')
    const first = openStore({ path })
    enqueue(first.db, { topic: 'grade.attempt', payload: { attempt: 'a1' }, now: parseInstant('2026-02-01T00:00:00+00:00') })
    first.close()

    assert.ok(existsSync(path), 'the database file exists on disk')
    const second = openStore({ path })
    try {
      // node:sqlite returns null-prototype rows, so they are copied before a deep comparison.
      const rows = (second.db.prepare('SELECT "topic", "status" FROM "audit_outbox_event"').all() as {
        topic: string
        status: string
      }[]).map((row) => ({ ...row }))
      assert.deepEqual(rows, [{ topic: 'grade.attempt', status: OUTBOX_STATUS.PENDING }])
      // Re-opening must not duplicate the row either.
      const again = openStore({ path })
      try {
        const count = again.db.prepare('SELECT COUNT(*) AS n FROM "audit_outbox_event"').get() as { n: number }
        assert.equal(count.n, 1)
      } finally {
        again.close()
      }
    } finally {
      second.close()
    }
  })
})

test('store file: opening is idempotent and keeps the schema version', () => {
  withTempDir((dir) => {
    const path = join(dir, '.acepass')
    for (let i = 0; i < 3; i += 1) {
      const handle = openStore({ path })
      handle.close()
    }
    const handle = openStore({ path })
    try {
      const tables = handle.db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .get() as { n: number }
      assert.equal(tables.n, 66, '65 business tables + the schema-version table')
    } finally {
      handle.close()
    }
  })
})

test('store file: a lease survives a crash and can be taken over after expiry', () => {
  withTempDir((dir) => {
    const path = join(dir, '.acepass')
    const t0 = parseInstant('2026-02-01T00:00:00+00:00')

    // A consumer claims the row and then "dies" without confirming.
    const worker = openStore({ path })
    const event = enqueue(worker.db, { topic: 'grade.attempt', now: t0 })
    const claim = claimEvent(worker.db, { eventId: event.id, now: t0, leaseSeconds: 60 })!
    assert.ok(claim)
    worker.close()

    // A fresh process (the restart) sees the abandoned lease and must not consider it done.
    const restarted = openStore({ path })
    try {
      const row = restarted.db
        .prepare('SELECT "status", "claim_token", "processed_at" FROM "audit_outbox_event" WHERE "id" = ?')
        .get(event.id) as { status: string; claim_token: string; processed_at: string | null }
      assert.equal(row.status, OUTBOX_STATUS.PROCESSING)
      assert.equal(row.processed_at, null, 'a crash must never look like a confirmation')
      assert.equal(row.claim_token, claim.claimToken)

      const takeover = claimEvent(restarted.db, {
        eventId: event.id,
        now: t0 + 61n * 1_000_000n,
        leaseSeconds: 60,
      })
      assert.ok(takeover, 'the expired lease is claimable by the restarted process')
      assert.notEqual(takeover.claimToken, claim.claimToken)

      assert.equal(markProcessed(restarted.db, { eventId: event.id, claimToken: takeover.claimToken, now: t0 }), true)
    } finally {
      restarted.close()
    }
  })
})

test('store file: an interrupted transaction leaves no partial row', () => {
  withTempDir((dir) => {
    const path = join(dir, '.acepass')
    const handle = openStore({ path })
    const t0 = parseInstant('2026-02-01T00:00:00+00:00')
    try {
      assert.throws(() =>
        transaction(handle.db, () => {
          enqueue(handle.db, { topic: 'first', now: t0 })
          enqueue(handle.db, { topic: 'second', now: t0 })
          throw new Error('killed mid-transaction')
        }),
      )
      const count = handle.db.prepare('SELECT COUNT(*) AS n FROM "audit_outbox_event"').get() as { n: number }
      assert.equal(count.n, 0, 'both writes must roll back together')
    } finally {
      handle.close()
    }
  })
})
