/**
 * The paired A/B/C verification chain, driven by real attempts.
 *
 * Port of `backend/apps/learning/services/pairing.py`. Django enqueues `learning.on_attempt_graded`
 * from `create_initial_grade`; this port calls the same service synchronously inside the submission
 * transaction (and the fixture calls it directly), so these cases exercise the production path:
 * submitting an attempt is what creates B, and grading B is what creates C. Calling `onAttemptGraded`
 * again afterwards must create nothing — that is the idempotency the outbox retry relies on.
 *
 * What is pinned here:
 *  * one B per graded A and one C per graded B — a repeated grading or a regrade creates nothing;
 *  * C's `not_before` is anchored on **B's own submission**, never on A's day-old event, which is
 *    what makes a 24-hour check actually 24 hours (R06);
 *  * a newer training event on the same node pushes a pending C later (reconcile);
 *  * a question that cannot be delivered produces an explicit `invalidated` task with the reason,
 *    never a task that will fail at start time and never a fabricated question.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import {
  TASK_KIND_DELAYED_VERIFICATION,
  TASK_KIND_PAIRED_IMMEDIATE,
  createVerificationPairing,
  delayedIntervalStatus,
  onAttemptGraded,
  onExplanationDelivered,
  reconcileDelayedTasks,
  resolvePairingTargets,
} from '../src/services/pairing.ts'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const HOUR = 3_600_000_000n
const BASE = 'http://host/api/acepass'
const CONTENT = {
  blocks: [{ kind: 'text', text: '3 + 4 等于几？' }],
  options: [
    { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '7' }] },
    { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '8' }] },
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
    row[column.name] = column.json
      ? {}
      : column.kind === 'datetime'
        ? NOW
        : column.kind === 'int' || column.kind === 'bool'
          ? 0
          : ''
  }
  Object.assign(row, overrides)
  return row
}

interface Harness {
  db: ReturnType<typeof openStore>['db']
  close: () => void
  userId: string
  projectId: string
  subjectId: string
  nodeId: string
  questions: string[]
  versions: string[]
  pairingId: string
  /** Deliver, present and submit one question; returns the attempt id and the session item id. */
  attempt: (questionIndex: number, options: { presentedAt: Instant; submittedAt: Instant }) => {
    attemptId: string
    itemId: string
    sessionId: string
  }
  call: (method: string, path: string, options?: { body?: unknown; key?: string }) => Promise<{ status: number; body: any }>
}

/**
 * Three published single-choice questions on one node, one reviewed pairing A/B/C.
 *
 * Two extra questions (`untrusted`, `draftless`) let a test pair a deliverable A with a B that has no
 * trusted answer.
 */
function harness(options: { withDelayed?: boolean } = {}): Harness {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const userId = String(
    insertRow(
      db,
      'accounts_user',
      completeRow('accounts_user', {
        email: 'owner@acepass.local',
        display_name: '本机用户',
        date_joined: NOW,
        password: '!',
      }),
      { now: NOW },
    ).id,
  )
  const projectId = String(createProject(db, userId, { name: '配对项目' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id)
  const syllabusId = String(
    insertRow(
      db,
      'exams_syllabus_version',
      completeRow('exams_syllabus_version', {
        subject_id: subjectId,
        name: '大纲',
        version_label: 'v1',
        status: 'published',
        is_user_provisional: true,
      }),
      { now: NOW },
    ).id,
  )
  const nodeId = String(
    insertRow(
      db,
      'knowledge_node',
      completeRow('knowledge_node', {
        syllabus_version_id: syllabusId,
        canonical_name: 'alpha',
        kind: 'point',
        code: 'A1',
        aliases: [],
        is_unclassified: false,
        display_order: 0,
      }),
      { now: NOW },
    ).id,
  )

  const questions: string[] = []
  const versions: string[] = []
  const makeQuestion = (label: string, options2: { checked: boolean }) => {
    const question = insertRow(
      db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subjectId,
        origin_type: 'user_authored',
        is_demo: false,
        display_label: label,
      }),
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
        question_version_id: String(draft.id),
        version: 1,
        // A version can only be published with a checked answer; a dispute is what happens later.
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
        check_basis: '教材',
      }),
      { now: NOW },
    )
    publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })
    if (!options2.checked) {
      updateRow(db, 'question_bank_answer_key_version', answer.id, { is_disputed: true, check_basis: '答案进入争议' }, { now: NOW })
    }
    insertRow(
      db,
      'knowledge_question_mapping',
      completeRow('knowledge_question_mapping', {
        question_version_id: String(draft.id),
        mapping_revision: 1,
        node_id: nodeId,
        is_primary: true,
        score_weight: '1.0000',
        note: '',
      }),
      { now: NOW },
    )
    questions.push(String(question.id))
    versions.push(String(draft.id))
  }
  makeQuestion('Q-A', { checked: true })
  makeQuestion('Q-B', { checked: true })
  makeQuestion('Q-C', { checked: true })
  makeQuestion('Q-untrusted', { checked: false })

  const targets = resolvePairingTargets(db, userId, projectId, {
    subject_id: subjectId,
    node_id: nodeId,
    baseline_question_id: questions[0],
    immediate_question_id: questions[1],
    delayed_question_id: options.withDelayed === false ? null : questions[2],
    delay_hours: 24,
  })
  const pairing = createVerificationPairing(
    db,
    userId,
    projectId,
    targets,
    { delayHours: 24, note: '验收配对' },
    NOW,
  )

  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId, now }),
  })
  let counter = 0
  const call: Harness['call'] = async (method, path, callOptions = {}) => {
    counter += 1
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (callOptions.key !== undefined) headers['idempotency-key'] = callOptions.key
    const request = new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }

  const attempt: Harness['attempt'] = (questionIndex, times) => {
    const session = createSession(
      db,
      userId,
      projectId,
      { subject_id: subjectId, question_ids: [questions[questionIndex]], mode: 'practice' },
      times.presentedAt,
    )
    const item = findRows(db, 'practice_session_item', { session_id: String(session.id) })[0]
    presentItem(db, userId, String(item.id), times.presentedAt)
    const result = submitAttempt(
      db,
      userId,
      String(item.id),
      { raw_answer: { type: 'single_choice', selected_option_ids: ['opt_a'] }, steps: [], confidence: '' },
      times.submittedAt,
    )
    return { attemptId: String(result.attempt.id), itemId: String(item.id), sessionId: String(session.id) }
  }

  return {
    db,
    close: handle.close,
    userId,
    projectId,
    subjectId,
    nodeId,
    questions,
    versions,
    pairingId: String(pairing.id),
    attempt,
    call,
  }
}

function taskOf(db: ReturnType<typeof openStore>['db'], taskKind: string, questionId: string | null) {
  return findRows(db, 'learning_study_task', { task_kind: taskKind, question_id: questionId })[0] ?? null
}

/* ------------------------------------------------------------------------- */

test('b8 pairing: a graded A creates B, a graded B creates C anchored on B', () => {
  const h = harness()
  try {
    const a = h.attempt(0, { presentedAt: NOW - 31n * HOUR, submittedAt: NOW - 30n * HOUR })
    assert.equal(
      findRows(h.db, 'learning_study_task', { task_kind: TASK_KIND_PAIRED_IMMEDIATE }).length,
      1,
      'grading A creates exactly one B',
    )

    const b = taskOf(h.db, TASK_KIND_PAIRED_IMMEDIATE, h.questions[1])!
    assert.ok(b, 'the B task points at the paired immediate question')
    assert.equal(b.status, 'pending')
    assert.equal(b.pairing_id, h.pairingId)
    assert.equal(b.pairing_version, 1)
    assert.equal(b.origin_session_item_id, a.itemId)
    assert.equal(b.trigger_event, 'confirmed_grade')
    assert.deepEqual(b.reason_codes, ['paired_immediate', 'same_knowledge_node'])
    assert.equal(b.not_before, null, 'an immediate check has no deadline')
    assert.equal(b.due_at, null)
    assert.equal(b.estimated_minutes, 2)
    assert.equal(b.knowledge_node_id, h.nodeId)

    // A repeated grading (or a regrade of the same attempt) must not mint a second B.
    assert.equal(onAttemptGraded(h.db, a.attemptId, NOW), 0)
    assert.equal(findRows(h.db, 'learning_study_task', { task_kind: TASK_KIND_PAIRED_IMMEDIATE }).length, 1)

    // The learner answers B; grading it creates C, anchored on *B's* submission.
    const bAttempt = h.attempt(1, { presentedAt: NOW - 35n * 60_000_000n, submittedAt: NOW - 30n * 60_000_000n })
    assert.equal(
      findRows(h.db, 'learning_study_task', { task_kind: TASK_KIND_DELAYED_VERIFICATION }).length,
      1,
      'grading B creates exactly one C',
    )

    const c = taskOf(h.db, TASK_KIND_DELAYED_VERIFICATION, h.questions[2])!
    assert.ok(c)
    assert.equal(c.status, 'pending')
    assert.equal(c.origin_session_item_id, bAttempt.itemId)
    assert.equal(c.trigger_event, 'paired_immediate_graded')
    const anchor = NOW - 30n * 60_000_000n
    assert.equal(c.delay_anchor_at, anchor, 'the anchor is the B submission, not A')
    assert.equal(c.not_before, anchor + 24n * HOUR, 'the delay starts when B was completed')
    assert.equal(c.due_at, c.not_before)
    assert.deepEqual(c.reason_codes, ['delayed_verification', 'delay_24h', 'trigger_event'])

    const review = findRows(h.db, 'learning_review_task', { study_task_id: c.id })[0]!
    assert.ok(review, 'a delayed task always has its ReviewTask record')
    assert.equal(review.delay_hours, 24)
    assert.equal(review.delay_anchor_at, anchor)
    assert.equal(review.not_before, c.not_before)
    assert.equal(review.anchor_source, 'trigger_event')
    assert.equal(review.was_started, false)

    assert.equal(onAttemptGraded(h.db, bAttempt.attemptId, NOW), 0, 'a replayed grading creates nothing')
    assert.equal(findRows(h.db, 'learning_review_task', {}).length, 1)

    // Before the deadline the task is not startable, and it says why.
    const early = delayedIntervalStatus(h.db, c, NOW)
    assert.equal(early.required, true)
    assert.equal(early.satisfied, false)
    assert.equal(early.not_before, '2026-08-01T23:30:00+00:00')
    assert.equal(early.stored_not_before, '2026-08-01T23:30:00+00:00')
    assert.equal(early.recomputed_not_before, null)
    // The status re-derives the anchor *now*, so it reports the newest related event it finds
    // (`prior_attempt`), not the creation-time label (`trigger_event`) — exactly what Django's
    // `source or anchor_source` returns when the anchor is resolved again.
    assert.equal(early.anchor_source, 'prior_attempt')
    assert.match(early.reason, /延迟验证需等待：还需约 23\.50 小时（锚点 prior_attempt）/)

    // Moving the deadline into the past — what the acceptance fixture does — makes it startable
    // without changing the anchor: the recorded interval is a snapshot, the engine recomputes it.
    const due = NOW - 60_000_000n
    updateRow(h.db, 'learning_study_task', c.id, { not_before: due, due_at: due }, { now: NOW })
    updateRow(h.db, 'learning_review_task', review.id, { not_before: due }, { now: NOW })
    const startable = delayedIntervalStatus(h.db, findOne(h.db, 'learning_study_task', { id: c.id })!, NOW)
    assert.equal(startable.satisfied, true)
    assert.equal(startable.reason, '')
    assert.equal(startable.stored_not_before, '2026-07-31T23:59:00+00:00')
  } finally {
    h.close()
  }
})

test('b8 pairing: a newer attempt on the node pushes a pending C later', () => {
  const h = harness()
  try {
    h.attempt(0, { presentedAt: NOW - 31n * HOUR, submittedAt: NOW - 30n * HOUR })
    h.attempt(1, { presentedAt: NOW - 35n * 60_000_000n, submittedAt: NOW - 30n * 60_000_000n })
    const firstC = taskOf(h.db, TASK_KIND_DELAYED_VERIFICATION, h.questions[2])!
    assert.ok(firstC, 'the first B produced a C')

    // A second B attempt on the same node is a *new* training event: another C, later deadline.
    h.attempt(1, { presentedAt: NOW - 12n * 60_000_000n, submittedAt: NOW - 10n * 60_000_000n })
    const tasks = findRows(h.db, 'learning_study_task', { task_kind: TASK_KIND_DELAYED_VERIFICATION })
    assert.equal(tasks.length, 2)

    // Reconcile re-anchors the *first* C on the newest related event at or before now.
    const updated = reconcileDelayedTasks(h.db, NOW)
    assert.equal(updated, 1, 'the older C re-anchors; the newest one already sits on that anchor')
    const moved = findOne(h.db, 'learning_study_task', { id: firstC.id })!
    assert.equal(moved.not_before, NOW - 10n * 60_000_000n + 24n * HOUR)
    assert.equal(moved.due_at, moved.not_before)
    assert.equal(moved.delay_anchor_at, NOW - 10n * 60_000_000n)
    assert.deepEqual((moved.reason_codes as string[]).slice(-1), ['anchor_updated'])
    assert.equal(
      findRows(h.db, 'learning_review_task', { study_task_id: firstC.id })[0]!.not_before,
      moved.not_before,
      'the ReviewTask deadline moves with the task, or the page would disagree with the engine',
    )

    // Nothing moved after the anchor: a second sweep is a no-op.
    assert.equal(reconcileDelayedTasks(h.db, NOW), 0)
  } finally {
    h.close()
  }
})

test('b8 pairing: an undeliverable question becomes an explicit invalidated task', () => {
  const h = harness()
  try {
    // Point the pairing's B at the question with no checked answer.
    const pairing = findOne(h.db, 'knowledge_verification_pairing', { id: h.pairingId })!
    updateRow(h.db, 'knowledge_verification_pairing', pairing.id, { immediate_question_id: h.questions[3] }, { now: NOW })

    const a = h.attempt(0, { presentedAt: NOW - 2n * HOUR, submittedAt: NOW - 1n * HOUR })

    const invalidated = findRows(h.db, 'learning_study_task', { task_kind: TASK_KIND_PAIRED_IMMEDIATE })[0]!
    assert.ok(invalidated, 'the missing B is recorded instead of silently skipped')
    assert.equal(invalidated.status, 'invalidated')
    assert.equal(invalidated.question_id, null)
    assert.equal(invalidated.trigger_event, 'missing_paired_question')
    assert.deepEqual(invalidated.reason_codes, ['missing_paired_question', 'missing_immediate'])
    assert.match(String(invalidated.deficit_notice), /缺少合格的B题/)
    assert.equal(invalidated.estimated_minutes, 0)
    assert.equal(findRows(h.db, 'learning_review_task', {}).length, 0, 'nothing startable was invented')

    // A repeated grading reuses the same record: one missing-pair fact, not one per request.
    assert.equal(onAttemptGraded(h.db, a.attemptId, NOW), 0)
    assert.equal(findRows(h.db, 'learning_study_task', { task_kind: TASK_KIND_PAIRED_IMMEDIATE }).length, 1)
  } finally {
    h.close()
  }
})

test('b8 pairing: a pairing without a C question blocks the delayed task explicitly', async () => {
  const h = harness({ withDelayed: false })
  try {
    h.attempt(0, { presentedAt: NOW - 2n * HOUR, submittedAt: NOW - 1n * HOUR })
    const b = taskOf(h.db, TASK_KIND_PAIRED_IMMEDIATE, h.questions[1])!
    assert.ok(b)

    h.attempt(1, { presentedAt: NOW - 10n * 60_000_000n, submittedAt: NOW - 5n * 60_000_000n })
    const invalidated = findRows(h.db, 'learning_study_task', { task_kind: TASK_KIND_DELAYED_VERIFICATION })[0]!
    assert.equal(invalidated.status, 'invalidated')
    assert.deepEqual(invalidated.reason_codes, ['missing_paired_question', 'missing_delayed'])
    assert.match(String(invalidated.deficit_notice), /缺少合格的C题/)
    // The pairing itself already told the reviewer this would happen.
    const listed = await h.call('GET', `/projects/${h.projectId}/verification-pairings`)
    assert.equal(listed.status, 200)
    assert.match(listed.body[0].gap, /缺少延迟验证题/)
  } finally {
    h.close()
  }
})

test('b8 pairing: a review through HTTP versions the pairing and lists real candidates', async () => {
  const h = harness()
  try {
    const listed = await h.call('GET', `/projects/${h.projectId}/verification-pairings`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.length, 1)
    assert.equal(listed.body[0].pairing_version, 1)
    assert.equal(listed.body[0].immediate_question_id, h.questions[1])

    // A second review of the same node is a new version, not a replacement.
    const created = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'review-2',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodeId,
        baseline_question_id: h.questions[0],
        immediate_question_id: h.questions[1],
        delayed_question_id: h.questions[2],
        delay_hours: 24,
        note: '重新确认',
      },
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.pairing_version, 2)

    const detail = await h.call('GET', `/projects/${h.projectId}/verification-pairings/${h.pairingId}`)
    assert.equal(detail.status, 200)
    assert.deepEqual(
      detail.body.candidates.map((row: any) => row.display_label),
      ['Q-A', 'Q-B', 'Q-C', 'Q-untrusted'],
      'every question primary-mapped to the node is a candidate',
    )
  } finally {
    h.close()
  }
})

/* ------------------------------------------- explanation-delivered B trigger */

/**
 * A presented-but-unsubmitted A item: the state "the learner read the explanation and has not
 * attempted anything yet", which is the only situation `on_explanation_delivered` is meant for.
 */
function deliveredItem(h: Harness, questionIndex: number): string {
  const session = createSession(
    h.db,
    h.userId,
    h.projectId,
    { subject_id: h.subjectId, question_ids: [h.questions[questionIndex]], mode: 'practice' },
    NOW,
  )
  const item = findRows(h.db, 'practice_session_item', { session_id: String(session.id) })[0]!
  presentItem(h.db, h.userId, String(item.id), NOW)
  return String(item.id)
}

function pairedImmediateTasks(db: Harness['db']): Record<string, unknown>[] {
  return findRows(db, 'learning_study_task', { task_kind: TASK_KIND_PAIRED_IMMEDIATE })
}

test('b8 pairing: an explanation delivered on A creates the immediate B without an attempt', () => {
  const h = harness()
  try {
    const itemId = deliveredItem(h, 0)
    assert.equal(pairedImmediateTasks(h.db).length, 0, 'delivering A creates no task by itself')

    assert.equal(onExplanationDelivered(h.db, itemId, NOW), 1)
    const b = pairedImmediateTasks(h.db)[0]!
    assert.equal(b.question_id, h.questions[1], 'B is the pairing immediate question')
    assert.equal(b.pairing_id, h.pairingId)
    assert.equal(b.pairing_version, 1)
    assert.equal(b.origin_session_item_id, itemId, 'the origin is the delivered item, not an attempt')
    assert.equal(b.trigger_event, 'explanation_delivered')
    assert.deepEqual(b.reason_codes, ['paired_immediate', 'explanation_first'])
    assert.equal(b.status, 'pending')
    assert.equal(b.not_before, null, 'an immediate check has no deadline')
    assert.equal(b.due_at, null)
    assert.equal(b.delay_anchor_at, null)
    assert.equal(b.estimated_minutes, 2)
    assert.equal(b.knowledge_node_id, h.nodeId)
    assert.equal(
      findRows(h.db, 'learning_review_task', {}).length,
      0,
      'only grading B freezes a delayed interval',
    )

    // A repeated explanation delivery is the outbox/retry case: exactly one B.
    assert.equal(onExplanationDelivered(h.db, itemId, NOW), 0)
    assert.equal(pairedImmediateTasks(h.db).length, 1)

    // Grading the same A item later reuses that B: the natural key is
    // (user, pairing, origin session item, task kind), not the trigger event.
    submitAttempt(
      h.db,
      h.userId,
      itemId,
      { raw_answer: { type: 'single_choice', selected_option_ids: ['opt_a'] }, steps: [], confidence: '' },
      NOW + 60_000_000n,
    )
    assert.equal(pairedImmediateTasks(h.db).length, 1, 'the graded A does not mint a second B')
    assert.equal(pairedImmediateTasks(h.db)[0]!.trigger_event, 'explanation_delivered')
  } finally {
    h.close()
  }
})

test('b8 pairing: an explanation never fabricates a B whose question has no trusted answer', () => {
  const h = harness()
  try {
    // The reviewed pairing now points at Q-untrusted (answer in dispute), the state in which
    // `_create_task` refuses to build a deliverable task.
    updateRow(h.db, 'knowledge_verification_pairing', h.pairingId, { immediate_question_id: h.questions[3] }, { now: NOW })
    const itemId = deliveredItem(h, 0)
    assert.equal(onExplanationDelivered(h.db, itemId, NOW), 0)
    assert.equal(pairedImmediateTasks(h.db).length, 0, 'no task is invented')
    assert.equal(
      findRows(h.db, 'learning_study_task', { status: 'invalidated' }).length,
      0,
      'Django records no deficit marker on the explanation path — nothing was graded',
    )
  } finally {
    h.close()
  }
})

test('b8 pairing: an explanation delivered on an unknown item is a no-op', () => {
  const h = harness()
  try {
    assert.equal(onExplanationDelivered(h.db, 'no-such-item', NOW), 0)
    assert.equal(pairedImmediateTasks(h.db).length, 0)
  } finally {
    h.close()
  }
})
