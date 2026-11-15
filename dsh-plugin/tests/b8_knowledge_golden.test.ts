/**
 * Golden replay for B8: the knowledge projections and the paired A/B/C task fields.
 *
 * `scripts/gen_b8_knowledge_golden.py` seeds real PostgreSQL rows, runs the real Django serializers
 * and one real A→B→C chain, and freezes every payload. This file seeds the identical rows into
 * SQLite (ids are the same deterministic `uuid5` values the fixture names as symbols) and replays the
 * same calls; a mismatch is a port defect, not a stale expectation.
 *
 * The paired-task rows are deliberately **not** part of `tables`: the replay has to create them by
 * calling `onAttemptGraded`, which is the behaviour under test. Their ids are random in both worlds,
 * so the comparison is on the fields the product reads (kind, status, question, node, pairing
 * version, trigger, anchor, deadline, reason codes, estimate, notices).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { formatPythonIso, parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES, type ColumnKind } from '../src/store/schema.generated.ts'
import {
  getPairingDetail,
  knowledgeMap,
  listPairings,
  listRelations,
  listTemplates,
  nodePrerequisites,
} from '../src/services/knowledge_extra.ts'
import { delayedIntervalStatus, onAttemptGraded } from '../src/services/pairing.ts'

const GOLDEN = JSON.parse(readFileSync(new URL('./golden/b8_knowledge.json', import.meta.url), 'utf8'))
const NOW = parseInstant(GOLDEN.now)
const SYMBOLS = GOLDEN.symbols as Record<string, string>
const ID = (symbol: string): string => {
  const id = SYMBOLS[symbol]
  assert.ok(id !== undefined, `fixture is missing symbol ${symbol}`)
  return id
}
const USER = ID('owner')
const PROJECT = ID('project')
const SUBJECT = ID('subject')

const KIND_BY_TABLE = new Map(
  TABLES.map((table) => [table.name, new Map(table.columns.map((column) => [column.name, column.kind as ColumnKind]))]),
)

/**
 * Insertion order: referenced rows before the rows that point at them.
 *
 * Two references point *forward* (a question's current published version, an attempt's current grade
 * event); they are cleared while seeding and written back afterwards, because SQLite enforces the
 * foreign keys the generated schema declares.
 */
const TABLE_ORDER = [
  'accounts_user',
  'exams_project',
  'exams_subject',
  'exams_syllabus_version',
  'knowledge_node',
  'knowledge_question_template',
  'question_bank_question',
  'question_bank_question_version',
  'question_bank_answer_key_version',
  'knowledge_question_mapping',
  'learning_knowledge_state',
  'knowledge_relation',
  'knowledge_verification_pairing',
  'practice_session',
  'practice_session_item',
  'practice_attempt',
  'practice_grade_event',
]

const FORWARD_REFERENCES: Record<string, Record<string, string | null>> = {
  question_bank_question: { current_published_version_id: null },
  practice_attempt: { current_grade_event_id: null },
}

function decodeFixtureValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (kind === 'datetime') return parseInstant(String(value))
  return value
}

function seed(): ReturnType<typeof openStore> {
  const handle = openStore({ path: ':memory:' })
  const tables = GOLDEN.tables as Record<string, Array<Record<string, unknown>>>
  for (const table of TABLE_ORDER) {
    const entries = tables[table]
    if (entries === undefined) continue
    const kinds = KIND_BY_TABLE.get(table)
    assert.ok(kinds, `fixture references unknown table ${table}`)
    for (const row of entries) {
      const values: Record<string, unknown> = {}
      for (const [column, value] of Object.entries(row)) {
        const kind = kinds!.get(column)
        assert.ok(kind !== undefined, `fixture references unknown column ${table}.${column}`)
        values[column] = decodeFixtureValue(kind!, value)
      }
      Object.assign(values, FORWARD_REFERENCES[table] ?? {})
      insertRow(handle.db, table, values, { now: NOW })
    }
  }
  const unknown = Object.keys(tables).filter((table) => !TABLE_ORDER.includes(table))
  assert.deepEqual(unknown, [], 'fixture has tables the replay order does not cover')
  for (const [table, patch] of Object.entries(FORWARD_REFERENCES)) {
    for (const row of tables[table] ?? []) {
      for (const column of Object.keys(patch)) {
        if (row[column] !== null && row[column] !== undefined) {
          updateRow(handle.db, table, String(row.id), { [column]: row[column] }, { now: NOW })
        }
      }
    }
  }
  return handle
}

/** The projection the generator emits: the fields the product reads, ids resolved to the fixture. */
function taskProjection(db: ReturnType<typeof openStore>['db']): Record<string, unknown>[] {
  return findRows(db, 'learning_study_task', {})
    .sort((left, right) => {
      const keys = (task: Record<string, unknown>): string[] => [
        String(task.task_kind),
        String(task.status),
        String(task.question_id ?? ''),
        String(task.origin_session_item_id ?? ''),
        String(task.pairing_version),
      ]
      const a = keys(left)
      const b = keys(right)
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
      }
      return 0
    })
    .map((task) => ({
      task_kind: task.task_kind,
      status: task.status,
      question_id: task.question_id === null ? null : String(task.question_id),
      knowledge_node_id: task.knowledge_node_id === null ? null : String(task.knowledge_node_id),
      pairing_version: task.pairing_version,
      origin_session_item_id:
        task.origin_session_item_id === null ? null : String(task.origin_session_item_id),
      trigger_event: task.trigger_event,
      delay_anchor_at: isoOrNull(task.delay_anchor_at),
      not_before: isoOrNull(task.not_before),
      due_at: isoOrNull(task.due_at),
      estimated_minutes: task.estimated_minutes,
      reason_codes: task.reason_codes,
      rule_version: task.rule_version,
      deficit_notice: task.deficit_notice,
      invalidated_reason: task.invalidated_reason,
    }))
}

function reviewProjection(db: ReturnType<typeof openStore>['db']): Record<string, unknown>[] {
  return findRows(db, 'learning_review_task', {}).map((review) => ({
    delay_hours: review.delay_hours,
    delay_anchor_at: isoOrNull(review.delay_anchor_at),
    not_before: isoOrNull(review.not_before),
    anchor_source: review.anchor_source,
    was_started: review.was_started,
    missing_question_reason: review.missing_question_reason,
  }))
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : formatPythonIso(value as Instant)
}

test('b8 golden: the knowledge map, prerequisites, graph and templates match Django', () => {
  const handle = seed()
  const db = handle.db
  try {
    assert.deepEqual(knowledgeMap(db, USER, PROJECT, { subjectId: SUBJECT }), GOLDEN.expect.knowledge_map)
    assert.deepEqual(
      nodePrerequisites(db, USER, PROJECT, ID('node_gamma')),
      GOLDEN.expect.prerequisites.gamma,
    )
    assert.deepEqual(
      nodePrerequisites(db, USER, PROJECT, ID('node_delta')),
      GOLDEN.expect.prerequisites.delta,
    )
    assert.deepEqual(
      listRelations(db, USER, PROJECT, { subjectId: SUBJECT }, NOW),
      GOLDEN.expect.relations,
    )
    assert.deepEqual(listTemplates(db, USER, PROJECT, {}), GOLDEN.expect.templates)
  } finally {
    handle.close()
  }
})

test('b8 golden: the pairing payloads and candidates match Django', () => {
  const handle = seed()
  const db = handle.db
  try {
    assert.deepEqual(listPairings(db, USER, PROJECT, {}), GOLDEN.expect.pairings)
    assert.deepEqual(
      getPairingDetail(db, USER, PROJECT, ID('pairing_alpha')),
      GOLDEN.expect.pairing_detail,
    )
  } finally {
    handle.close()
  }
})

test('b8 golden: the A/B/C chain produces the same task and review fields', () => {
  const handle = seed()
  const db = handle.db
  try {
    // The real trigger, twice: the same calls the generator made against PostgreSQL.
    assert.equal(onAttemptGraded(db, ID('attempt_a'), NOW), GOLDEN.created.from_a)
    assert.equal(onAttemptGraded(db, ID('attempt_b'), NOW), GOLDEN.created.from_b)
    assert.deepEqual(taskProjection(db), GOLDEN.expect.tasks)
    assert.deepEqual(reviewProjection(db), GOLDEN.expect.review_tasks)

    // The interval check has to agree with Django's, including the formatted remaining hours.
    const delayed = findRows(db, 'learning_study_task', {
      task_kind: 'delayed_verification',
      status: 'pending',
    })[0]
    assert.ok(delayed, 'the chain produced the delayed C task')
    assert.deepEqual(delayedIntervalStatus(db, delayed, NOW), GOLDEN.expect.delay_status_at_now)

    // Replaying the same gradings creates nothing: the chain is idempotent per attempt.
    assert.equal(onAttemptGraded(db, ID('attempt_a'), NOW), 0)
    assert.equal(onAttemptGraded(db, ID('attempt_b'), NOW), 0)
    assert.deepEqual(taskProjection(db), GOLDEN.expect.tasks)
  } finally {
    handle.close()
  }
})
