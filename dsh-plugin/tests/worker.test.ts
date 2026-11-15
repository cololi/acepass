import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { rebuildEvidenceForAttempt, refreshNodeState } from '../src/services/evidence_rebuild.ts'
import { drain, runOnce } from '../src/jobs/worker.ts'
import { enqueue } from '../src/store/outbox.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-10-01T00:00:00+00:00')
const CONTENT = {
  blocks: [{ kind: 'text', text: '1+1 等于几？' }],
  options: [
    { id: 'opt_a', text: '1' },
    { id: 'opt_b', text: '2' },
  ],
}

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

function seeded() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'e@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)

  const syllabus = insertRow(
    db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', { subject_id: subject.id, name: '大纲', version_label: 'v1' }),
    { now: NOW },
  )
  const node = insertRow(
    db,
    'knowledge_node',
    completeRow('knowledge_node', { syllabus_version_id: syllabus.id, canonical_name: '考点A', code: 'A' }),
    { now: NOW },
  )
  const question = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', { subject_id: subject.id, origin_type: 'import', is_demo: false, display_label: '' }),
    { now: NOW },
  )
  const draft = createQuestionRevision(
    db,
    userId,
    projectId,
    String(question.id),
    { question_type: 'single_choice', content: CONTENT, practice_max_score: '2.00' },
    NOW,
  )
  const answer = insertRow(
    db,
    'question_bank_answer_key_version',
    completeRow('question_bank_answer_key_version', {
      question_version_id: draft.id,
      version: 1,
      verification_status: 'checked',
      is_disputed: false,
      answer_payload: { kind: 'single_choice', correct_option_id: 'opt_b' },
      check_basis: '教材',
    }),
    { now: NOW },
  )
  publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })
  insertRow(
    db,
    'knowledge_question_mapping',
    completeRow('knowledge_question_mapping', {
      question_version_id: draft.id,
      mapping_revision: 1,
      node_id: node.id,
      is_primary: true,
      score_weight: '1.0000',
      note: '',
    }),
    { now: NOW },
  )

  const session = insertRow(
    db,
    'practice_session',
    completeRow('practice_session', {
      user_id: user.id,
      project_id: project.id,
      subject_id: subject.id,
      mode: 'practice',
      status: 'active',
      note: 'purpose=practice',
    }),
    { now: NOW },
  )
  const item = insertRow(
    db,
    'practice_session_item',
    completeRow('practice_session_item', {
      session_id: session.id,
      question_version_id: draft.id,
      answer_key_version_id: answer.id,
      max_score: '2.00',
      ordinal: 1,
      first_delivered_at: NOW - 60_000_000n,
      purpose: 'practice',
      mapping_revision: 1,
    }),
    { now: NOW },
  )
  return { db, close: handle.close, userId, projectId, nodeId: String(node.id), itemId: String(item.id) }
}

test('evidence rebuild: a correct independent answer produces all six dimensions', () => {
  const s = seeded()
  try {
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    const count = rebuildEvidenceForAttempt(s.db, String(submitted.attempt.id), NOW)
    assert.equal(count, 6, 'one row per dimension')

    const rows = findRows(s.db, 'practice_learning_evidence', { attempt_id: String(submitted.attempt.id) })
    assert.deepEqual(
      rows.map((row) => row.dimension).sort(),
      [
        'delayed_verification',
        'independent_correct',
        'repeat_practice',
        'template_variant',
        'unassisted_completion',
        'unseen_variant',
      ],
    )
    const independent = rows.find((row) => row.dimension === 'independent_correct')!
    assert.equal(independent.qualifies, true, 'a fresh, unassisted, correct answer is strict evidence')
    assert.deepEqual(independent.exclusion_reasons, [])
    assert.equal(independent.rule_version, 'p2-c04')
    assert.equal(independent.is_active, true)
    // No prior anchor, so the delayed dimension cannot qualify yet and says why.
    const delayed = rows.find((row) => row.dimension === 'delayed_verification')!
    assert.equal(delayed.qualifies, false)
    assert.ok((delayed.exclusion_reasons as string[]).some((reason) => /延迟锚点/.test(reason)))
  } finally {
    s.close()
  }
})

test('evidence rebuild: the node state is refreshed to "independent"', () => {
  const s = seeded()
  try {
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    rebuildEvidenceForAttempt(s.db, String(submitted.attempt.id), NOW)
    const states = findRows(s.db, 'learning_knowledge_state', { node_id: s.nodeId })
    assert.equal(states.length, 1)
    assert.equal(states[0].summary, 'independent')
    assert.equal(states[0].independent_correct_count, 1)
    assert.equal(states[0].has_delayed_correct, false)
    const detail = states[0].detail as Record<string, unknown>
    assert.ok(Array.isArray(detail.missing_evidence))
    assert.ok((detail.missing_evidence as string[]).length > 0, 'it says what is still missing')
  } finally {
    s.close()
  }
})

test('evidence rebuild: a wrong answer is repeat practice + a confirmed gap, never independent', () => {
  const s = seeded()
  try {
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_a' } },
      NOW,
    )
    rebuildEvidenceForAttempt(s.db, String(submitted.attempt.id), NOW)
    const rows = findRows(s.db, 'practice_learning_evidence', { attempt_id: String(submitted.attempt.id) })
    const independent = rows.find((row) => row.dimension === 'independent_correct')!
    assert.equal(independent.qualifies, false)
    assert.equal(independent.is_correct, false, 'wrong is a decided false, not a pending null')

    const states = findRows(s.db, 'learning_knowledge_state', { node_id: s.nodeId })
    assert.equal(states[0].summary, 'needs_foundation', 'a wrong answer with a grade event is a confirmed gap')
  } finally {
    s.close()
  }
})

test('evidence rebuild: recomputing does not duplicate rows', () => {
  const s = seeded()
  try {
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    rebuildEvidenceForAttempt(s.db, String(submitted.attempt.id), NOW)
    rebuildEvidenceForAttempt(s.db, String(submitted.attempt.id), NOW)
    const rows = findRows(s.db, 'practice_learning_evidence', { attempt_id: String(submitted.attempt.id) })
    assert.equal(rows.length, 6, 'an idempotent rebuild must not double the rows')
    assert.equal(findRows(s.db, 'learning_knowledge_state', { node_id: s.nodeId }).length, 1)
  } finally {
    s.close()
  }
})

test('worker: the evidence event is claimed, handled and confirmed exactly once', () => {
  const s = seeded()
  try {
    submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    const first = runOnce(s.db, NOW)
    assert.deepEqual(first, { handled: 1, failed: 0, skipped: 0 })
    assert.equal(findRows(s.db, 'practice_learning_evidence', {}).length, 6)

    // Nothing is due any more: the row is processed, so a second pass is a no-op.
    assert.deepEqual(runOnce(s.db, NOW), { handled: 0, failed: 0, skipped: 0 })
    const events = findRows(s.db, 'audit_outbox_event', {})
    assert.equal(events.length, 1)
    assert.equal(events[0].status, 'processed')
  } finally {
    s.close()
  }
})

test('worker: a failing handler records a retryable failure instead of confirming', () => {
  const s = seeded()
  try {
    enqueue(s.db, { topic: 'evidence.rebuild_for_attempt', payload: {}, now: NOW })
    const result = runOnce(s.db, NOW, {
      handlers: {
        'evidence.rebuild_for_attempt': () => {
          throw new Error('boom')
        },
      },
    })
    assert.equal(result.failed, 1)
    const events = findRows(s.db, 'audit_outbox_event', {})
    assert.equal(events[0].status, 'pending', 'a retryable failure goes back to pending')
    assert.equal(events[0].attempts, 2, 'the delivery attempt and the failure are both counted')
    assert.match(String(events[0].last_error), /boom/)
  } finally {
    s.close()
  }
})

test('worker: an unhandled topic fails permanently instead of being confirmed', () => {
  const s = seeded()
  try {
    enqueue(s.db, { topic: 'nobody.handles.this', payload: {}, now: NOW })
    const result = runOnce(s.db, NOW)
    assert.equal(result.failed, 1)
    const event = findRows(s.db, 'audit_outbox_event', {})[0]
    assert.equal(event.status, 'failed')
    assert.match(String(event.last_error), /no handler for topic/)
  } finally {
    s.close()
  }
})

test('worker: drain empties the queue and stops when nothing is due', () => {
  const s = seeded()
  try {
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    const totals = drain(s.db, NOW)
    assert.equal(totals.handled, 1)
    assert.equal(findRows(s.db, 'practice_learning_evidence', { attempt_id: String(submitted.attempt.id) }).length, 6)
  } finally {
    s.close()
  }
})

test('evidence rebuild: refreshing a node without evidence leaves it undiagnosed', () => {
  const s = seeded()
  try {
    refreshNodeState(s.db, s.userId, s.projectId, s.nodeId, NOW)
    const states = findRows(s.db, 'learning_knowledge_state', { node_id: s.nodeId })
    assert.equal(states.length, 1)
    assert.equal(states[0].summary, 'undiagnosed', 'no evidence must not be reported as a percentage')
  } finally {
    s.close()
  }
})

