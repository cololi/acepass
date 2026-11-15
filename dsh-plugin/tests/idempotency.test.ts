import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { Decimal } from '../src/domain/decimal.ts'
import { openStore, transaction } from '../src/store/db.ts'
import {
  IdempotencyConflict,
  claim,
  fingerprint,
  jsonSafe,
  recordResult,
  release,
} from '../src/store/idempotency.ts'
import type { DatabaseSync } from 'node:sqlite'
import { TABLES } from '../src/store/schema.generated.ts'

const NOW = parseInstant('2026-02-01T00:00:00+00:00')

function store() {
  const handle = openStore({ path: ':memory:' })
  // A user row is required: the record's foreign key is real.
  const user = TABLES.find((t) => t.name === 'accounts_user')!
  const columns = user.columns.filter((c) => c.notNull && !c.primaryKey).map((c) => c.name)
  handle.db
    .prepare(
      `INSERT INTO "accounts_user" ("id", ${columns.map((c) => `"${c}"`).join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
    )
    .run('user-1', ...columns.map((c) => (c === 'email' ? 'a@example.com' : user.columns.find((x) => x.name === c)!.type === 'INTEGER' ? 0 : 'x')))
  return handle
}

function rowCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM "audit_idempotency_record"').get() as { n: number }).n
}

test('idempotency: the first claim is granted and a second one replays', () => {
  const { db, close } = store()
  try {
    const payload = { a: 1 }
    assert.equal(claim(db, { userId: 'user-1', routeScope: 'POST /practice/sessions', key: 'k1', payload, now: NOW }), null)

    recordResult(db, {
      userId: 'user-1',
      routeScope: 'POST /practice/sessions',
      key: 'k1',
      statusCode: 201,
      responseBody: { id: 'session-1', score: Decimal.parse('1.5000') },
      resourceType: 'practice_session',
      resourceId: 'session-1',
      now: NOW,
    })

    const replay = claim(db, { userId: 'user-1', routeScope: 'POST /practice/sessions', key: 'k1', payload, now: NOW })
    assert.ok(replay)
    assert.equal(replay.statusCode, 201)
    assert.deepEqual(replay.body, { id: 'session-1', score: '1.5000' }, 'decimals replay as their wire format')
    assert.equal(rowCount(db), 1, 'a replay must not create a second record')
  } finally {
    close()
  }
})

test('idempotency: the same key with a different payload conflicts', () => {
  const { db, close } = store()
  try {
    claim(db, { userId: 'user-1', routeScope: 'POST /x', key: 'k2', payload: { a: 1 }, now: NOW })
    assert.throws(
      () => claim(db, { userId: 'user-1', routeScope: 'POST /x', key: 'k2', payload: { a: 2 }, now: NOW }),
      (error: unknown) => error instanceof IdempotencyConflict && error.reason === 'same_key_different_payload',
    )
  } finally {
    close()
  }
})

test('idempotency: an in-flight claim conflicts rather than guessing a success', () => {
  const { db, close } = store()
  try {
    claim(db, { userId: 'user-1', routeScope: 'POST /y', key: 'k3', payload: {}, now: NOW })
    assert.throws(
      () => claim(db, { userId: 'user-1', routeScope: 'POST /y', key: 'k3', payload: {}, now: NOW }),
      (error: unknown) => error instanceof IdempotencyConflict && error.reason === 'in_flight',
    )
  } finally {
    close()
  }
})

test('idempotency: release drops an unfulfilled claim but not a recorded result', () => {
  const { db, close } = store()
  try {
    claim(db, { userId: 'user-1', routeScope: 'POST /z', key: 'k4', payload: { p: 1 }, now: NOW })
    release(db, 'user-1', 'POST /z', 'k4')
    assert.equal(
      claim(db, { userId: 'user-1', routeScope: 'POST /z', key: 'k4', payload: { p: 1 }, now: NOW }),
      null,
      'a released key can be claimed again',
    )

    recordResult(db, { userId: 'user-1', routeScope: 'POST /z', key: 'k4', statusCode: 200, responseBody: { ok: true }, now: NOW })
    release(db, 'user-1', 'POST /z', 'k4')
    assert.equal(rowCount(db), 1, 'release must not delete a completed record')
    const replay = claim(db, { userId: 'user-1', routeScope: 'POST /z', key: 'k4', payload: { p: 1 }, now: NOW })
    assert.deepEqual(replay?.body, { ok: true })
  } finally {
    close()
  }
})

test('idempotency: keys are scoped per user and per route', () => {
  const { db, close } = store()
  try {
    const payload = { same: true }
    assert.equal(claim(db, { userId: 'user-1', routeScope: 'POST /a', key: 'shared', payload, now: NOW }), null)
    // The same key on a different scope is a different request.
    assert.equal(claim(db, { userId: 'user-1', routeScope: 'POST /b', key: 'shared', payload, now: NOW }), null)
    assert.equal(rowCount(db), 2)
  } finally {
    close()
  }
})

test('idempotency: an empty key is refused', () => {
  const { db, close } = store()
  try {
    assert.throws(
      () => claim(db, { userId: 'user-1', routeScope: 'POST /a', key: '', payload: {}, now: NOW }),
      /idempotency key is required/,
    )
  } finally {
    close()
  }
})

test('idempotency: the fingerprint matches the Python digest', () => {
  // Pinned from `apps.audit.services.idempotency.fingerprint` — if these move, stored records stop
  // replaying after the migration.
  assert.equal(fingerprint({ b: 1, a: 2 }), 'd3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772')
  assert.equal(fingerprint({ a: 1 }), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862')
})

test('idempotency: jsonSafe converts tagged values the way the API writes them', () => {
  assert.deepEqual(jsonSafe(Decimal.parse('12.50')), '12.50')
  assert.deepEqual(jsonSafe(parseInstant('2026-01-01T00:00:00.000500+00:00')), '2026-01-01T00:00:00.000500+00:00')
  assert.deepEqual(jsonSafe({ a: [Decimal.parse('0.0001'), null] }), { a: ['0.0001', null] })
})

test('idempotency: a claim and its result commit together or not at all', () => {
  const { db, close } = store()
  try {
    assert.throws(() =>
      transaction(db, () => {
        claim(db, { userId: 'user-1', routeScope: 'POST /t', key: 'k9', payload: {}, now: NOW })
        throw new Error('boom')
      }),
    )
    assert.equal(rowCount(db), 0, 'an aborted request must not leave a claim blocking the retry')
  } finally {
    close()
  }
})
