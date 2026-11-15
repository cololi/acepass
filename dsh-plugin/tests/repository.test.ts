import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { Decimal } from '../src/domain/decimal.ts'
import { openStore } from '../src/store/db.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import {
  compareAndSet,
  countRows,
  deleteRow,
  findOne,
  findRows,
  getRow,
  insertRow,
  tableFor,
  updateRow,
} from '../src/store/repository.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW: Instant = parseInstant('2026-02-01T12:00:00.123456+00:00')

function placeholder(
  column: { name: string; type: string; json: boolean; kind: string },
  pk: string,
): unknown {
  if (column.json) return '{}'
  // A datetime column is encoded from an Instant, so a placeholder string would be a type error.
  if (column.kind === 'datetime') return NOW
  if (column.kind === 'date') return '2026-02-01'
  if (column.type === 'INTEGER') return 0
  if (column.type === 'REAL') return 0
  return `${pk}-${column.name}`
}

/** Create the rows a table's non-nullable foreign keys require. */
function seed(db: DatabaseSync, table: string, pk = `pk-${table}`): string {
  if (db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE "id" = ?`).get(pk)) return pk
  const definition = tableFor(table)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const values: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey) {
      values[column.name] = column.type === 'INTEGER' ? 1 : pk
      continue
    }
    const fk = foreignKeys.get(column.name)
    if (fk) {
      values[column.name] = column.notNull ? seed(db, fk.refTable) : null
      continue
    }
    values[column.name] = column.notNull ? placeholder(column, pk) : null
  }
  insertRow(db, table, values, { now: NOW })
  return pk
}

/** The columns `audit_outbox_event` requires; the repository does not invent model values. */
function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: 't',
    payload: {},
    status: 'pending',
    attempts: 0,
    max_attempts: 8,
    available_at: NOW,
    claim_token: '',
    last_error: '',
    ...overrides,
  }
}

test('repository: insert fills the id and the timestamps', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    const row = insertRow(db, 'audit_outbox_event', eventRow({ topic: 'grade.attempt' }), { now: NOW })
    assert.ok(row.id)
    assert.equal(row.created_at, NOW)
    assert.equal(row.updated_at, NOW)
  } finally {
    close()
  }
})

test('repository: Decimal, instant, boolean and JSON round-trip', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    const event = insertRow(
      db,
      'audit_outbox_event',
      eventRow({ payload: { nested: [1, 'two', null], flag: true }, dedupe_key: 'k1' }),
      { now: NOW },
    )
    assert.deepEqual(event.payload, { nested: [1, 'two', null], flag: true }, 'JSON survives the TEXT column')
    assert.equal(event.available_at, NOW, 'instants survive with microsecond precision')
    assert.equal(event.dedupe_key, 'k1')

    const reread = getRow(db, 'audit_outbox_event', event.id)!
    assert.deepEqual(reread.payload, event.payload)
    assert.equal(reread.available_at, NOW)

    // A Decimal column is TEXT on disk but a Decimal in the domain layer.
    const version = seed(db, 'question_bank_question_version')
    const node = seed(db, 'knowledge_node')
    const mapping = insertRow(
      db,
      'knowledge_question_mapping',
      { question_version_id: version, node_id: node, score_weight: Decimal.parse('0.7500'), note: '' },
      { now: NOW },
    )
    const weight = mapping.score_weight
    assert.ok(weight instanceof Decimal, 'a decimal column must not come back as a string')
    assert.equal(weight.toString(), '0.7500', 'and it must keep its scale')
  } finally {
    close()
  }
})

test('repository: unknown columns and missing clocks are refused, not ignored', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    assert.throws(() => insertRow(db, 'audit_outbox_event', eventRow({ nope: 1 }), { now: NOW }), /unknown column/)
    assert.throws(() => insertRow(db, 'audit_outbox_event', eventRow()), /needs a clock/)
    assert.throws(() => getRow(db, 'no_such_table', 'x'), /unknown table/)
  } finally {
    close()
  }
})

test('repository: update stamps updated_at and reports a missing row', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    const event = insertRow(db, 'audit_outbox_event', eventRow(), { now: NOW })
    const later = NOW + 1_000_000n
    const updated = updateRow(db, 'audit_outbox_event', event.id, { status: 'processed' }, { now: later })!
    assert.equal(updated.status, 'processed')
    assert.equal(updated.updated_at, later)
    assert.equal(updated.created_at, NOW, 'created_at is never touched by an update')

    assert.equal(updateRow(db, 'audit_outbox_event', 'missing-id', { status: 'x' }), null)
    assert.equal(updateRow(db, 'audit_outbox_event', event.id, {}, { now: later })?.id, event.id, 'an empty patch is a read')
  } finally {
    close()
  }
})

test('repository: findRows filters, orders and limits', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    const base = Date.parse('2026-02-01T00:00:00Z')
    for (let i = 0; i < 5; i += 1) {
      insertRow(
        db,
        'audit_outbox_event',
        eventRow({
          topic: i % 2 === 0 ? 'even' : 'odd',
          available_at: parseInstant(new Date(base + i * 1000).toISOString()),
        }),
        { now: NOW },
      )
    }
    assert.equal(findRows(db, 'audit_outbox_event', { topic: 'even' }).length, 3)
    assert.equal(countRows(db, 'audit_outbox_event'), 5)
    assert.equal(countRows(db, 'audit_outbox_event', { topic: 'odd' }), 2)

    const at = (row: Record<string, unknown>): Instant => row.available_at as Instant
    const ordered = findRows(db, 'audit_outbox_event', {}, { orderBy: [['available_at', 'desc']], limit: 2 })
    assert.equal(ordered.length, 2)
    assert.ok(at(ordered[0]) > at(ordered[1]), 'descending order is honoured')

    const page = findRows(db, 'audit_outbox_event', {}, { orderBy: [['available_at', 'asc']], limit: 2, offset: 2 })
    // Ascending from offset 2 starts at the third-oldest, i.e. before the second-newest.
    assert.ok(at(page[0]) < at(ordered[1]))
    assert.equal(at(page[1]), at(ordered[1]))
    assert.throws(() => findRows(db, 'audit_outbox_event', {}, { orderBy: [['nope']] }), /unknown column/)
  } finally {
    close()
  }
})

test('repository: findOne refuses an ambiguous predicate', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    insertRow(db, 'audit_outbox_event', eventRow({ topic: 'same' }), { now: NOW })
    insertRow(db, 'audit_outbox_event', eventRow({ topic: 'same' }), { now: NOW })
    assert.equal(findOne(db, 'audit_outbox_event', { topic: 'only-one' }), null)
    assert.throws(() => findOne(db, 'audit_outbox_event', { topic: 'same' }), /more than one row/)
  } finally {
    close()
  }
})

test('repository: compareAndSet loses the race instead of overwriting', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    const event = insertRow(db, 'audit_outbox_event', eventRow(), { now: NOW })
    assert.equal(compareAndSet(db, 'audit_outbox_event', event.id, 'status', 'pending', 'processing', { now: NOW }), true)
    assert.equal(
      compareAndSet(db, 'audit_outbox_event', event.id, 'status', 'pending', 'processing', { now: NOW }),
      false,
      'a second writer with the stale expectation must lose',
    )
    assert.equal(getRow(db, 'audit_outbox_event', event.id)!.status, 'processing')
  } finally {
    close()
  }
})

test('repository: delete removes exactly one row', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    const a = insertRow(db, 'audit_outbox_event', eventRow({ topic: 'a' }), { now: NOW })
    insertRow(db, 'audit_outbox_event', eventRow({ topic: 'b' }), { now: NOW })
    assert.equal(deleteRow(db, 'audit_outbox_event', a.id), true)
    assert.equal(deleteRow(db, 'audit_outbox_event', a.id), false)
    assert.equal(countRows(db, 'audit_outbox_event'), 1)
  } finally {
    close()
  }
})

test('repository: the generated schema is the only source of column names', () => {
  const { db, close } = openStore({ path: ':memory:' })
  try {
    // Every declared column of a representative table can be written and read back.
    const definition = TABLES.find((table) => table.name === 'audit_outbox_event')!
    const values: Record<string, unknown> = {}
    for (const column of definition.columns) {
      if (column.primaryKey) continue
      if (column.json) values[column.name] = {}
      else if (column.kind === 'int') values[column.name] = 0
      else if (column.kind === 'datetime') values[column.name] = NOW
      else if (column.notNull) values[column.name] = 'x'
    }
    const row = insertRow(db, 'audit_outbox_event', values, { now: NOW })
    assert.equal(Object.keys(row).length, definition.columns.length)
  } finally {
    close()
  }
})
