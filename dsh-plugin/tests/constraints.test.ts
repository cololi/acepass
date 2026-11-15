import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHECK_CONSTRAINTS, TABLES, UNIQUE_CONSTRAINTS } from '../src/store/schema.generated.ts'
import { openStore } from '../src/store/db.ts'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Every constraint in the schema must be shown to actually reject its counter-example.
 *
 * The inventory (docs/dsh-migration/02 §2) counts 31 declared-model constraints; adding the two
 * implicit M2M through tables (Django creates a UNIQUE pair on each) makes 33. The 6 check
 * constraints are unchanged;
 * `scripts/gen_schema.py` emits that metadata so this file cannot silently stop covering one when a
 * model changes.
 */

function tableDef(table: string) {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  return definition
}

function placeholderValue(column: { name: string; type: string; json: boolean }, pk: string): unknown {
  if (column.json) return '{}'
  if (column.type === 'INTEGER') return 0
  if (column.type === 'REAL') return 0
  // Vary with the row id: two placeholder parent rows created for one test must not collide on
  // their own unique constraints just because they were filled with the same filler.
  return `${pk}-${column.name}`
}

/**
 * Per-table overrides needed to build a *valid* baseline row.
 *
 * Only tables whose own CHECK constraints reject all-null placeholders need an entry; each one is a
 * documented choice, not a silent skip.
 */
const BASELINE_OVERRIDES: Record<string, Record<string, unknown>> = {
  // pool_policy_target_required: at least one of family/question must be set.
  question_bank_pool_policy: { family_id: 'pk-question_bank_family' },
  // region_bbox_positive / region_bbox_inside_page
  ingestion_source_region: { x: 0, y: 0, width: 1, height: 1 },
  // knowledge_relation_no_self_loop
  knowledge_relation: { from_node_id: 'node-from', to_node_id: 'node-to' },
  // tag_suggestion_status_known
  knowledge_tag_suggestion: { status: 'proposed' },
  // mapping_weight_between_0_and_1
  knowledge_question_mapping: { score_weight: '0.5' },
}

function insertRow(
  db: DatabaseSync,
  table: string,
  overrides: Record<string, unknown>,
  pk: string,
): void {
  const definition = tableDef(table)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const row: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey) {
      row[column.name] = column.type === 'INTEGER' ? 1 : pk
      continue
    }
    if (column.name in overrides) {
      row[column.name] = overrides[column.name]
      continue
    }
    const fk = foreignKeys.get(column.name)
    if (fk) {
      row[column.name] = column.notNull ? ensureRow(db, fk.refTable) : null
      continue
    }
    row[column.name] = column.notNull ? placeholderValue(column, pk) : null
  }
  Object.assign(row, overrides)
  const names = Object.keys(row)
  db.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(
    ...(Object.values(row) as never[]),
  )
}

function ensureRow(db: DatabaseSync, table: string, pk = `pk-${table}`): string {
  const existing = db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE "id" = ?`).get(pk)
  if (existing) return pk
  insertRow(db, table, BASELINE_OVERRIDES[table] ?? {}, pk)
  return pk
}

/** A non-null value that satisfies `kind`, for a column that participates in a unique key. */
function uniqueValue(definition: { type: string; json: boolean; kind: string }, table: string, column: string) {
  const fk = tableDef(table).foreignKeys.find((entry) => entry.column === column)
  // A unique key column that is also a foreign key must point at a real row — and two FK columns in
  // the same key must not point at the *same* row (that is what tripped the self-loop check).
  if (fk) return `pk-${fk.refTable}-${column}`
  if (definition.kind === 'int') return 1
  if (definition.kind === 'float') return 1
  if (definition.json) return '{}'
  // Distinct per column: a composite key whose parts were identical would trip unrelated checks
  // (knowledge_relation_no_self_loop, for one).
  return `unique-${column}`
}

test('constraints: the schema carries the same constraint counts as the inventory', () => {
  // 31 declared-model constraints + 2 auto-created M2M pair constraints.
  assert.equal(UNIQUE_CONSTRAINTS.length, 33, '31 declared + 2 through-table pairs')
  assert.equal(UNIQUE_CONSTRAINTS.filter((entry) => entry.partial).length, 3, 'inventory: 3 conditional')
  assert.equal(CHECK_CONSTRAINTS.length, 6, 'inventory: 6 check constraints')
})

test('constraints: every unique constraint rejects a duplicate', () => {
  const failures: string[] = []
  for (const constraint of UNIQUE_CONSTRAINTS) {
    const store = openStore({ path: ':memory:' })
    try {
      const definition = tableDef(constraint.table)
      const overrides: Record<string, unknown> = { ...(BASELINE_OVERRIDES[constraint.table] ?? {}) }
      for (const column of constraint.columns) {
        const columnDef = definition.columns.find((entry) => entry.name === column)
        assert.ok(columnDef, `unknown column ${constraint.table}.${column}`)
        const value = uniqueValue(columnDef, constraint.table, column)
        overrides[column] = value
        // Parent rows for FK columns inside the key must exist with exactly this id.
        const fk = definition.foreignKeys.find((entry) => entry.column === column)
        if (fk) ensureRow(store.db, fk.refTable, String(value))
      }
      try {
        insertRow(store.db, constraint.table, overrides, 'row-1')
      } catch (error) {
        failures.push(`${constraint.name}: baseline row rejected (${(error as Error).message})`)
        continue
      }
      try {
        insertRow(store.db, constraint.table, overrides, 'row-2')
        failures.push(`${constraint.name}: duplicate row was accepted`)
      } catch (error) {
        const message = (error as Error).message
        if (!/UNIQUE constraint failed/.test(message)) {
          failures.push(`${constraint.name}: rejected for the wrong reason (${message})`)
        }
      }
    } finally {
      store.close()
    }
  }
  assert.deepEqual(failures, [], `unique-constraint counter-examples:\n${failures.join('\n')}`)
})

test('constraints: every check constraint rejects its counter-example', () => {
  // Each entry is the counter-example for one named constraint; the test asserts the set matches
  // CHECK_CONSTRAINTS exactly, so a new constraint without a counter-example fails the build.
  const counterExamples: Record<string, (db: DatabaseSync) => void> = {
    mapping_weight_between_0_and_1: (db) => {
      const node = ensureRow(db, 'knowledge_node')
      const version = ensureRow(db, 'question_bank_question_version')
      insertRow(
        db,
        'knowledge_question_mapping',
        { node_id: node, question_version_id: version, score_weight: '1.5', mapping_revision: 9 },
        'mapping-out-of-range',
      )
    },
    knowledge_relation_no_self_loop: (db) => {
      insertRow(db, 'knowledge_relation', { from_node_id: 'node-a', to_node_id: 'node-a' }, 'relation-self-loop')
    },
    region_bbox_positive: (db) => {
      insertRow(
        db,
        'ingestion_source_region',
        { document_id: ensureRow(db, 'ingestion_source_document'), x: 0, y: 0, width: 0, height: 1 },
        'region-zero-width',
      )
    },
    region_bbox_inside_page: (db) => {
      insertRow(
        db,
        'ingestion_source_region',
        { document_id: ensureRow(db, 'ingestion_source_document'), x: 1.5, y: 0, width: 1, height: 1 },
        'region-outside-page',
      )
    },
    tag_suggestion_status_known: (db) => {
      insertRow(
        db,
        'knowledge_tag_suggestion',
        { project_id: ensureRow(db, 'exams_project'), question_version_id: ensureRow(db, 'question_bank_question_version'), status: 'bogus' },
        'tag-bogus-status',
      )
    },
    pool_policy_target_required: (db) => {
      // Neither family nor question: the constraint requires exactly this not to happen.
      insertRow(db, 'question_bank_pool_policy', { family_id: null, question_id: null }, 'pool-no-target')
    },
  }

  const named = new Map(CHECK_CONSTRAINTS.map((entry) => [entry.name, entry]))
  assert.deepEqual(
    [...named.keys()].sort(),
    Object.keys(counterExamples).sort(),
    'every check constraint needs exactly one counter-example in this test',
  )

  const failures: string[] = []
  for (const [name, build] of Object.entries(counterExamples)) {
    const constraint = named.get(name)!
    const store = openStore({ path: ':memory:' })
    try {
      build(store.db)
      failures.push(`${constraint.table}.${name}: counter-example was accepted`)
    } catch (error) {
      const message = (error as Error).message
      if (!/CHECK constraint failed/.test(message)) {
        failures.push(`${constraint.table}.${name}: rejected for the wrong reason (${message})`)
      }
    } finally {
      store.close()
    }
  }
  assert.deepEqual(failures, [], `check-constraint counter-examples:\n${failures.join('\n')}`)
})
