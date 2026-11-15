/**
 * B10: the runtime driver for the outbox.
 *
 * These tests are about the loop, not about the handlers (those have their own files). What has to
 * be true in a live plugin:
 *
 *  1. a submission's `evidence.rebuild_for_attempt` event is consumed **without a manual drain**;
 *  2. the loop is stoppable — after `stop()` nothing else is consumed, and `tick()` is inert;
 *  3. an unknown topic fails loudly and permanently instead of being confirmed;
 *  4. a legacy Django topic name (present in an imported archive) is resolved to its handler;
 *  5. `plan.generated` is consumed (F2) and a missing plan is a no-op, not a permanent failure;
 *  6. the D0 health gate reports unresolved/unknown work.
 *
 * The worker clock is injected (`now: () => NOW`) so the rebuild stamps `NOW`, exactly like the
 * fixture that seeded the rows. That is the acceptance-server contract: the seed drains with the
 * seed clock, so the server booting later cannot move `computed_at`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPythonIso, parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { generatePlan } from '../src/services/planner.ts'
import { drain } from '../src/jobs/worker.ts'
import { listStates } from '../src/services/learning.ts'
import { enqueue } from '../src/store/outbox.ts'
import {
  ASYNC_TOPICS,
  asyncHandlers,
  defaultHandlers,
  knownTopics,
  outboxHealth,
  startOutboxWorker,
  unknownTopics,
} from '../src/jobs/worker.ts'
import type { LlmPort } from '../src/llm/contract.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-10-01T00:00:00+00:00')
const CONTENT = {
  blocks: [{ kind: 'text', text: '1+1 等于几？' }],
  options: [
    { id: 'opt_a', text: '1' },
    { id: 'opt_b', text: '2' },
  ],
}
/**
 * A port with no model. These tests must not load `src/llm/port.ts`: it imports `@deepseek-ai/dsh-llm`,
 * which only exists inside the DSH installation, and the loop itself must be runnable without it.
 */
const PORT = (): LlmPort =>
  ({
    availability: async () => ({}) as Awaited<ReturnType<LlmPort['availability']>>,
    run: async (request) => ({
      ok: false as const,
      code: 'ai_not_configured' as const,
      message: 'AI 未配置',
      capability: request.capability,
      promptVersion: request.promptVersion,
      retryable: false,
    }),
  }) satisfies LlmPort

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

  // A real session/item pair: `createSession`/`presentItem` is how the product creates one, so the
  // submission path below exercises the same rows the HTTP surface would.
  const session = createSession(
    db,
    userId,
    projectId,
    { subject_id: String(subject.id), mode: 'practice', question_ids: [String(question.id)] },
    NOW,
  )
  const item = findRows(db, 'practice_session_item', { session_id: String(session.id) })[0]
  const presented = presentItem(db, userId, String(item.id), NOW - 60_000_000n)
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    nodeId: String(node.id),
    itemId: String(presented.session_item_id),
    sessionId: String(session.id),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the worker')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('worker lifecycle: a submission is projected without a manual drain', async () => {
  const s = seeded()
  const worker = startOutboxWorker(s.db, { llm: PORT, intervalMs: 10, now: () => NOW })
  try {
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    await waitFor(() => findRows(s.db, 'practice_learning_evidence', { attempt_id: String(submitted.attempt.id) }).length === 6)
    const states = findRows(s.db, 'learning_knowledge_state', { node_id: s.nodeId })
    assert.equal(states.length, 1)
    assert.equal(states[0].summary, 'independent')
    // The rebuild used the injected clock, not wall-clock time: the acceptance fixture relies on it.
    assert.equal(formatPythonIso(states[0].as_of as never), '2026-10-01T00:00:00+00:00')
    const event = findRows(s.db, 'audit_outbox_event', {})[0]
    assert.equal(event.status, 'processed')
  } finally {
    await worker.stop()
    s.close()
  }
})

test('worker lifecycle: stop() is final and tick() is inert afterwards', async () => {
  const s = seeded()
  const worker = startOutboxWorker(s.db, { llm: PORT, intervalMs: 10, now: () => NOW })
  try {
    await worker.stop()
    assert.equal(worker.running, false)
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    const idle = await worker.tick()
    assert.deepEqual(idle, { handled: 0, failed: 0, skipped: 0 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(
      findRows(s.db, 'practice_learning_evidence', { attempt_id: String(submitted.attempt.id) }).length,
      0,
      'nothing may be consumed after stop()',
    )
    assert.equal(findRows(s.db, 'audit_outbox_event', {})[0].status, 'pending')
  } finally {
    s.close()
  }
})

test('worker lifecycle: an unknown topic fails permanently and is reported', async () => {
  const s = seeded()
  const worker = startOutboxWorker(s.db, { llm: PORT, intervalMs: 10, now: () => NOW })
  try {
    // The producer path is `enqueue`; the worker must not confirm a topic nobody owns.
    const queued = enqueue(s.db, { topic: 'nobody.handles.this', payload: {}, now: NOW })
    await waitFor(() => findRows(s.db, 'audit_outbox_event', { id: queued.id })[0].status === 'failed')
    const event = findRows(s.db, 'audit_outbox_event', { id: queued.id })[0]
    assert.match(String(event.last_error), /no handler for topic/)
    assert.deepEqual(unknownTopics(s.db), { 'nobody.handles.this': 1 })
    assert.equal(outboxHealth(s.db).ok, false)
  } finally {
    await worker.stop()
    s.close()
  }
})

test('worker lifecycle: a legacy Django topic resolves to the canonical handler', async () => {
  const s = seeded()
  const worker = startOutboxWorker(s.db, { llm: PORT, intervalMs: 10, now: () => NOW })
  try {
    const submitted = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    // An archive imported from Django carries the old name; the submission's own event still uses
    // the canonical one, so both were queued above. Only the legacy one is left after a manual drain
    // of the canonical row would be wrong — instead replay the legacy name against the same attempt.
    drain(s.db, NOW)
    const legacy = enqueue(s.db, {
      topic: 'projection.rebuild_attempt_evidence',
      payload: { attempt_id: String(submitted.attempt.id) },
      now: NOW,
    })
    await waitFor(() => findRows(s.db, 'audit_outbox_event', { id: legacy.id })[0].status === 'processed')
    assert.equal(findRows(s.db, 'practice_learning_evidence', { attempt_id: String(submitted.attempt.id) }).length, 6)
    assert.equal(outboxHealth(s.db).ok, true, 'a consumed legacy event is resolved, not unknown')
  } finally {
    await worker.stop()
    s.close()
  }
})

test('worker lifecycle: plan.generated is consumed, and a missing plan is not a permanent failure', async () => {
  const s = seeded()
  const worker = startOutboxWorker(s.db, { llm: PORT, intervalMs: 10, now: () => NOW })
  try {
    // A real plan through the real service: its own `plan.generated` event must be drained.
    generatePlan(s.db, s.userId, { now: NOW })
    await waitFor(() => findRows(s.db, 'audit_outbox_event', { topic: 'plan.generated' }).every((row) => row.status === 'processed'))
    const plan = findRows(s.db, 'learning_study_plan', {})[0]
    const notes = plan.notes as string[]
    assert.ok(notes.some((note) => note.startsWith('计划核对：')), 'the consumer appends its audit note')

    // A payload naming a plan that does not exist is Django's `plan_missing`: processed, no throw.
    const missing = enqueue(s.db, {
      topic: 'plan.generated',
      payload: { plan_id: '00000000-0000-0000-0000-000000000000' },
      now: NOW,
    })
    await waitFor(() => findRows(s.db, 'audit_outbox_event', { id: missing.id })[0].status === 'processed')
  } finally {
    await worker.stop()
    s.close()
  }
})

test('worker lifecycle: the knowledge-state read keeps Django\'s top-level shape after a rebuild', async () => {
  const s = seeded()
  const worker = startOutboxWorker(s.db, { llm: PORT, intervalMs: 10, now: () => NOW })
  try {
    submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    await waitFor(() => findRows(s.db, 'learning_knowledge_state', {}).length === 1)
    const payload = listStates(s.db, s.userId, s.projectId, {})
    const state = payload.states[0] as unknown as Record<string, unknown>
    // `states_for_project` publishes these at the top level; the knowledge page reads
    // `missing_evidence` directly, so a state with only a `detail` object crashed the detail panel
    // once the worker produced the first real row (B10 F6).
    for (const field of [
      'node_id',
      'node_name',
      'subject_id',
      'syllabus_version_id',
      'summary',
      'best_summary',
      'independent_correct_count',
      'distinct_question_count',
      'distinct_template_count',
      'has_delayed_correct',
      'needs_review',
      'downgrade_reason',
      'missing_evidence',
      'independent_attempts',
      'thresholds',
      'rule_version',
      'as_of',
      'evidence',
    ]) {
      assert.ok(field in state, `the state row is missing ${field}`)
    }
    assert.ok(Array.isArray(state.missing_evidence))
    assert.ok((state.missing_evidence as unknown[]).length > 0, 'it still says what is missing')
    assert.equal(state.as_of, '2026-10-01T00:00:00+00:00', 'instants are Python ISO, not raw microseconds')
    const rows = state.evidence as Array<Record<string, unknown>>
    assert.ok(rows.length > 0)
    assert.equal(rows[0].computed_at, '2026-10-01T00:00:00+00:00')
  } finally {
    await worker.stop()
    s.close()
  }
})

test('worker topics: every async topic has a handler and the aliases are known', () => {
  const handlers = asyncHandlers(PORT)
  assert.deepEqual(Object.keys(handlers).sort(), [...ASYNC_TOPICS].sort())
  const known = knownTopics()
  for (const topic of Object.keys(defaultHandlers())) assert.ok(known.has(topic), topic)
  assert.ok(known.has('projection.rebuild_attempt_evidence'))
  assert.ok(known.has('learning.reconcile_plan'))
  assert.ok(known.has('plan.generated'))
  assert.equal(outboxHealth({ prepare: () => ({ all: () => [] }) } as unknown as DatabaseSync).ok, true)
})
