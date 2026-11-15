import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TABLES, CREATE_INDEXES } from '../src/store/schema.generated.ts'
import { openStore, schemaVersionOf, tableNames, transaction } from '../src/store/db.ts'
import type { DatabaseSync } from 'node:sqlite'

function freshStore() {
  return openStore({ path: ':memory:' })
}

function tableDef(table: string) {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  return definition
}

function placeholderValue(column: { type: string; json: boolean }): unknown {
  if (column.json) return '{}'
  if (column.type === 'INTEGER') return 0
  if (column.type === 'REAL') return 0
  return ''
}

/**
 * Build one row, creating the rows its non-nullable foreign keys need.
 *
 * Hand-listing columns in every test would tie the tests to schema details that are not the point
 * of the test. Cycles are safe because every cycle in this schema runs through a nullable FK.
 */
function buildRow(
  db: DatabaseSync,
  table: string,
  overrides: Record<string, unknown> = {},
  pk = `pk-${table}`,
): Record<string, unknown> {
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
    row[column.name] = column.notNull ? placeholderValue(column) : null
  }
  Object.assign(row, overrides)
  return row
}

function insertRow(
  db: DatabaseSync,
  table: string,
  overrides: Record<string, unknown> = {},
  pk = `pk-${table}-${Math.random().toString(36).slice(2, 8)}`,
) {
  const row = buildRow(db, table, overrides, pk)
  const names = Object.keys(row)
  return db
    .prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...(Object.values(row) as never[]))
}

function ensureRow(db: DatabaseSync, table: string, pk = `pk-${table}`): string {
  const existing = db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE "id" = ?`).get(pk)
  if (existing) return pk
  insertRow(db, table, {}, pk)
  return pk
}

test('schema: every Django model has a table', () => {
  const store = freshStore()
  try {
    const created = new Set(tableNames(store.db))
    // 57 declared models + 2 Django auto-created M2M through tables (docs/dsh-migration/08 §6).
    assert.equal(TABLES.length, 59, '57 declared models + 2 through tables')
    for (const table of TABLES) assert.ok(created.has(table.name), `missing table ${table.name}`)
    assert.equal(schemaVersionOf(store.db), 1)
  } finally {
    store.close()
  }
})

test('schema: the generated file matches the Django models (drift guard)', () => {
  const script = fileURLToPath(new URL('../scripts/gen_schema.py', import.meta.url))
  const python = fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url))
  const committed = fileURLToPath(new URL('../src/store/schema.generated.ts', import.meta.url))
  const regenerated = execFileSync(python, [script], { encoding: 'utf8' })
  assert.equal(
    readFileSync(committed, 'utf8'),
    regenerated,
    'schema.generated.ts drifted from the models — run `npm run schema`',
  )
})

test('schema: a missing parent row is rejected', () => {
  const store = freshStore()
  try {
    assert.throws(
      () => insertRow(store.db, 'accounts_user_settings', { user_id: 'missing-user' }),
      /FOREIGN KEY constraint failed/,
    )
    assert.throws(
      () => insertRow(store.db, 'knowledge_question_mapping', { node_id: 'missing-node' }),
      /FOREIGN KEY constraint failed/,
    )
  } finally {
    store.close()
  }
})

test('schema: ON DELETE CASCADE and PROTECT->RESTRICT behave like the Django declaration', () => {
  const store = freshStore()
  try {
    const { db } = store
    const user = ensureRow(db, 'accounts_user')
    insertRow(db, 'accounts_user_settings', { user_id: user })
    db.prepare('DELETE FROM "accounts_user" WHERE "id" = ?').run(user)
    const settings = db.prepare('SELECT COUNT(*) AS n FROM "accounts_user_settings"').get() as { n: number }
    assert.equal(settings.n, 0, 'settings are removed with their user (CASCADE)')

    // knowledge_question_mapping.node_id is PROTECT: the node cannot be deleted while referenced.
    const node = ensureRow(db, 'knowledge_node')
    insertRow(db, 'knowledge_question_mapping', { node_id: node, question_version_id: ensureRow(db, 'question_bank_question_version') })
    assert.throws(() => db.prepare('DELETE FROM "knowledge_node" WHERE "id" = ?').run(node), /FOREIGN KEY constraint failed/)
  } finally {
    store.close()
  }
})

test('schema: NOT NULL is enforced', () => {
  const store = freshStore()
  try {
    assert.throws(
      () => store.db.prepare('INSERT INTO "accounts_user_settings" ("user_id") VALUES (NULL)').run(),
      /NOT NULL constraint failed/,
    )
  } finally {
    store.close()
  }
})

test('schema: json columns reject malformed text and accept valid json', () => {
  const store = freshStore()
  try {
    const { db } = store
    const user = ensureRow(db, 'accounts_user')
    assert.throws(
      () => insertRow(db, 'accounts_user_settings', { user_id: user, project_budget_percent: 'not json' }),
      /CHECK constraint failed/,
    )
    insertRow(db, 'accounts_user_settings', { user_id: user, project_budget_percent: '{"a": 1}' })
  } finally {
    store.close()
  }
})

test('schema: the decimal range CHECK compares numerically, not as text', () => {
  const store = freshStore()
  try {
    const { db } = store
    const node = ensureRow(db, 'knowledge_node')
    const questionVersion = ensureRow(db, 'question_bank_question_version')
    let revision = 0
    const insert = (weight: string) =>
      insertRow(db, 'knowledge_question_mapping', {
        node_id: node,
        question_version_id: questionVersion,
        score_weight: weight,
        mapping_revision: ++revision,
      })
    // A decimal column is TEXT, so `1.0 <= 1` would be false under text comparison — the generated
    // CHECK casts to NUMERIC, which is what makes a weight of exactly 1.0 acceptable.
    insert('1.0')
    insert('0.0')
    assert.throws(() => insert('1.5'), /CHECK constraint failed/)
    assert.throws(() => insert('-0.5'), /CHECK constraint failed/)
  } finally {
    store.close()
  }
})

test('schema: the remaining check constraints reject their counter-examples', () => {
  const store = freshStore()
  try {
    const { db } = store
    assert.throws(
      () =>
        insertRow(db, 'knowledge_relation', {
          syllabus_version_id: ensureRow(db, 'exams_syllabus_version'),
          from_node_id: 'same',
          to_node_id: 'same',
        }),
      /CHECK constraint failed/,
    )
    assert.throws(
      () =>
        insertRow(db, 'ingestion_source_region', {
          document_id: ensureRow(db, 'ingestion_source_document'),
          x: 0,
          y: 0,
          width: 0,
          height: 1,
        }),
      /CHECK constraint failed/,
    )
    assert.throws(
      () =>
        insertRow(db, 'knowledge_tag_suggestion', {
          project_id: ensureRow(db, 'exams_project'),
          question_version_id: ensureRow(db, 'question_bank_question_version'),
          status: 'bogus',
        }),
      /CHECK constraint failed/,
    )
  } finally {
    store.close()
  }
})

test('schema: partial unique indexes only constrain rows that match the predicate', () => {
  const store = freshStore()
  try {
    const { db } = store
    const base = {
      user_id: ensureRow(db, 'accounts_user'),
      project_id: ensureRow(db, 'exams_project'),
      subject_id: ensureRow(db, 'exams_subject'),
      task_kind: 'warmup',
      status: 'planned',
    }
    // origin_session_item_id IS NULL rows fall outside the index, so they may repeat.
    insertRow(db, 'learning_study_task', { ...base })
    insertRow(db, 'learning_study_task', { ...base })

    const origin = ensureRow(db, 'practice_session_item')
    const pairing = ensureRow(db, 'knowledge_verification_pairing')
    insertRow(db, 'learning_study_task', { ...base, origin_session_item_id: origin, pairing_id: pairing })
    assert.throws(
      () => insertRow(db, 'learning_study_task', { ...base, origin_session_item_id: origin, pairing_id: pairing }),
      /UNIQUE constraint failed/,
    )
    assert.ok(CREATE_INDEXES.some((statement) => statement.includes('WHERE')), 'partial predicates must survive')
  } finally {
    store.close()
  }
})

test('store: transactions roll back on throw and nest', () => {
  const store = freshStore()
  try {
    const { db } = store
    const base = {
      user_id: ensureRow(db, 'accounts_user'),
      project_id: ensureRow(db, 'exams_project'),
      subject_id: ensureRow(db, 'exams_subject'),
      task_kind: 'warmup',
      status: 'planned',
    }
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM "learning_study_task"').get() as { n: number }).n

    assert.throws(() =>
      transaction(db, () => {
        insertRow(db, 'learning_study_task', base)
        throw new Error('boom')
      }),
    )
    assert.equal(count(), 0, 'the failed transaction must leave no row behind')

    transaction(db, () => {
      insertRow(db, 'learning_study_task', base)
      transaction(db, () => insertRow(db, 'learning_study_task', base))
    })
    assert.equal(count(), 2, 'a nested transaction joins the outer one')
  } finally {
    store.close()
  }
})
