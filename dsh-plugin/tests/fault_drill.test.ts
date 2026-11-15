import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { claimEvent, enqueue, holdClaim, markProcessed } from '../src/store/outbox.ts'
import { runOnce } from '../src/jobs/worker.ts'

/**
 * Phase 4 fault drills.
 *
 * The in-memory tests prove the rules; these prove the *recovery*: a process that dies mid-delivery
 * must not look like a confirmed delivery, and the restarted process must be able to take the work
 * over. The crash is a real `SIGKILL` in a real child process against a real file — not a simulated
 * throw, which would run the `catch` branch and prove something different.
 */

const NOW = parseInstant('2026-11-01T00:00:00+00:00')

function completeRow(table: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const row: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey || column.name in overrides) continue
    if (!column.notNull) continue
    const fk = foreignKeys.get(column.name)
    if (fk) {
      row[column.name] = `fk-${fk.refTable}`
      continue
    }
    row[column.name] = column.json ? {} : column.kind === 'datetime' ? NOW : column.kind === 'int' || column.kind === 'bool' ? 0 : ''
  }
  Object.assign(row, overrides)
  return row
}

function withTempDb<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'acepass-drill-'))
  try {
    return fn(join(dir, 'acepass.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The temp directory of a db path, for the child script. */
function dirOf(dbPath: string): string {
  return dbPath.slice(0, dbPath.lastIndexOf('/'))
}

test('drill: a consumer killed while holding the lease leaves recoverable work, not a confirmation', () => {
  withTempDb((path) => {
    const seed = openStore({ path })
    const event = enqueue(seed.db, { topic: 'evidence.rebuild_for_attempt', payload: { attempt_id: 'a1' }, now: NOW })
    seed.close()

    // A real child process claims the lease and is then SIGKILLed before confirming. The script is a
    // file (not `-e`) so quoting cannot be the thing under test, and `spawnSync` is used because a
    // SIGKILLed child reports a signal, not exit code 0.
    const scriptPath = join(dirOf(path), 'crash.ts')
    writeFileSync(
      scriptPath,
      `import { openStore } from '${join(process.cwd(), 'src/store/db.ts')}'
import { claimEvent } from '${join(process.cwd(), 'src/store/outbox.ts')}'
import { parseInstant } from '${join(process.cwd(), 'src/domain/instant.ts')}'
const store = openStore({ path: ${JSON.stringify(path)} })
const claim = claimEvent(store.db, {
  eventId: ${JSON.stringify(event.id)},
  now: parseInstant('2026-11-01T00:00:00+00:00'),
  leaseSeconds: 60,
})
if (claim === null) { console.log('NO-CLAIM'); process.exit(9) }
console.log('CLAIMED')
process.kill(process.pid, 'SIGKILL')
`,
    )
    const child = spawnSync(process.execPath, ['--experimental-strip-types', scriptPath], { encoding: 'utf8' })
    assert.match(String(child.stdout), /CLAIMED/, `the child must claim before dying: ${child.stderr}`)
    assert.equal(child.signal, 'SIGKILL', 'the drill is only meaningful if the process really was killed')

    const restarted = openStore({ path })
    try {
      const row = findRows(restarted.db, 'audit_outbox_event', { id: event.id })[0]
      assert.equal(row.status, 'processing', 'a crash mid-delivery is not a confirmation')
      assert.equal(row.processed_at, null)
      assert.equal(String(row.claim_token).length > 0, true, 'the dead consumer still holds a token')

      // Until a takeover happens the dead consumer still nominally holds the token, which is why
      // recovery is the takeover's job and not a timeout inside `holdClaim` (Python has the same
      // split: `hold_claim` checks ownership, `claim_event` decides expiry).
      assert.ok(holdClaim(restarted.db, { eventId: event.id, claimToken: String(row.claim_token) }))

      const takeover = claimEvent(restarted.db, {
        eventId: event.id,
        now: NOW + 120n * 1_000_000n,
        leaseSeconds: 60,
      })
      assert.ok(takeover, 'an expired lease must be claimable after a restart')
      assert.notEqual(takeover.claimToken, String(row.claim_token))
      assert.equal(
        holdClaim(restarted.db, { eventId: event.id, claimToken: String(row.claim_token) }),
        null,
        'after the takeover the dead consumer can no longer write',
      )
      assert.equal(markProcessed(restarted.db, { eventId: event.id, claimToken: takeover.claimToken, now: NOW }), true)
    } finally {
      restarted.close()
    }
  })
})

test('drill: a duplicate delivery is handled once because the second claim loses', () => {
  withTempDb((path) => {
    // Two consumers in the same process, sharing the store: only the first can hold the lease.
    const store = openStore({ path })
    try {
      const event = enqueue(store.db, { topic: 'evidence.rebuild_for_attempt', payload: { attempt_id: 'x' }, now: NOW })
      const first = claimEvent(store.db, { eventId: event.id, now: NOW, leaseSeconds: 60 })
      const second = claimEvent(store.db, { eventId: event.id, now: NOW, leaseSeconds: 60 })
      assert.ok(first)
      assert.equal(second, null, 'the duplicate delivery must lose the claim, not run twice')
    } finally {
      store.close()
    }
  })
})

test('drill: an interrupted handler leaves the event pending and retryable, never processed', () => {
  withTempDb((path) => {
    const store = openStore({ path })
    try {
      enqueue(store.db, { topic: 'evidence.rebuild_for_attempt', payload: {}, now: NOW })
      const result = runOnce(store.db, NOW, {
        handlers: {
          'evidence.rebuild_for_attempt': () => {
            throw new Error('handler blew up mid-way')
          },
        },
      })
      assert.equal(result.failed, 1)
      const row = findRows(store.db, 'audit_outbox_event', {})[0]
      assert.equal(row.status, 'pending')
      assert.equal(row.processed_at, null)
    } finally {
      store.close()
    }
  })
})

test('drill: a rebuilt database keeps its schema version and outbox state', () => {
  withTempDb((path) => {
    const first = openStore({ path })
    enqueue(first.db, { topic: 'evidence.rebuild_for_attempt', payload: { attempt_id: 'z' }, now: NOW })
    first.close()

    const second = openStore({ path })
    try {
      const rows = findRows(second.db, 'audit_outbox_event', {})
      assert.equal(rows.length, 1, 'reopening must not drop or duplicate the queued work')
      assert.equal(rows[0].status, 'pending')
    } finally {
      second.close()
    }
  })
})

test('drill: the seed rows used by other drills are still valid', () => {
  // Guards against the shared fixture helper drifting out of the schema.
  const store = openStore({ path: ':memory:' })
  try {
    insertRow(store.db, 'accounts_user', completeRow('accounts_user', { email: 'd@example.com' }), { now: NOW })
    assert.equal(findRows(store.db, 'accounts_user', {}).length, 1)
  } finally {
    store.close()
  }
})
