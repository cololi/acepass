/**
 * HTTP black box for B8's learning reads: today's plan, the review queue and the task lifecycle.
 *
 * The harness is the same one `tests/study_routes.test.ts` uses: an in-memory store, the real route
 * table plus the new one, and `Request`→`Response` driven directly. Nothing here reads the database to
 * *decide* an assertion the API already answers — the row checks exist only where the API deliberately
 * says less than the table holds (the review's `was_started` flag, the invalidated reason).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { countRows, findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import {
  createProject,
  createSpecVersion,
  createSubject,
  createSyllabusVersion,
  publishSpecVersion,
  publishSyllabusVersion,
} from '../src/services/exams.ts'
import { createNode } from '../src/services/knowledge.ts'
import {
  createAnswerKeyVersion,
  createQuestion,
  createQuestionVersionDraft,
  publishQuestionVersion,
} from '../src/services/questions.ts'
import { replaceKnowledgeMappings } from '../src/services/mappings.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'
const HOUR = 3_600_000_000n

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

function harness() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'b8@example.com', display_name: '学习读', date_joined: NOW }),
    { now: NOW },
  )
  const other = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'other@example.com', display_name: '别人', date_joined: NOW }),
    { now: NOW },
  )
  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId: String(user.id), now }),
  })
  let counter = 0
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; key?: string | null; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> => {
    counter += 1
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.headers ?? {}) }
    if (method !== 'GET') {
      const key = options.key === undefined ? `k-${counter}` : options.key
      if (key !== null) headers['idempotency-key'] = key
    }
    const request = new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  return {
    db,
    user: String(user.id),
    other: String(other.id),
    close: handle.close,
    call,
    setNow: (value: Instant) => {
      now = value
    },
  }
}

interface Seed {
  projectId: string
  subjectId: string
  syllabusId: string
  nodeId: string
  questionId: string
  versionId: string
}

/** One project with a published spec/syllabus, a node, and a published question mapped to that node. */
function seedSubject(
  db: DatabaseSync,
  userId: string,
  options: { projectName: string; now: Instant; nodeName: string; stem: string },
): Seed {
  const { now } = options
  const project = createProject(db, userId, { name: options.projectName }, now)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: '科目', total_score: '100', pass_score: '60' }, now)
  const subjectId = String(subject.id)
  const spec = createSpecVersion(
    db,
    userId,
    projectId,
    {
      subject_id: subjectId,
      name: '规范',
      total_score: '100',
      pass_score: '60',
      question_type_rules: { true_false: { max_score: '2', correct_score: '2', wrong_score: '0' } },
    },
    now,
  )
  publishSpecVersion(db, userId, projectId, String(spec.id), now)
  const syllabus = createSyllabusVersion(
    db,
    userId,
    projectId,
    { subject_id: subjectId, name: '大纲', version_label: '2026' },
    now,
  )
  publishSyllabusVersion(db, userId, projectId, String(syllabus.id), now)
  const node = createNode(
    db,
    userId,
    projectId,
    { syllabus_version_id: String(syllabus.id), canonical_name: options.nodeName, kind: 'point', display_order: 0 },
    now,
  )
  const question = createQuestion(db, userId, { subjectId, displayLabel: '判断-1' }, now)
  const questionId = String(question.id)
  const version = createQuestionVersionDraft(
    db,
    userId,
    projectId,
    questionId,
    {
      questionType: 'true_false',
      content: { blocks: [{ kind: 'text', text: options.stem }] },
      practiceMaxScore: '2',
      revisionReason: 'b8',
    },
    now,
  )
  const versionId = String(version.id)
  createAnswerKeyVersion(
    db,
    userId,
    projectId,
    versionId,
    {
      answerPayload: { kind: 'true_false', value: true },
      sourceType: 'user',
      verificationStatus: 'checked',
      checkBasis: 'b8 测试',
    },
    now,
  )
  replaceKnowledgeMappings(db, projectId, versionId, [{ node_id: String(node.id), is_primary: true, score_weight: '1' }], {
    actorId: userId,
    now,
  })
  publishQuestionVersion(db, userId, projectId, versionId, { now })
  return {
    projectId,
    subjectId,
    syllabusId: String(syllabus.id),
    nodeId: String(node.id),
    questionId,
    versionId,
  }
}

/**
 * One delayed-verification task with its review row and the learning event that anchors it.
 *
 * The anchor has to be a *real* related event: `delayedIntervalStatus` re-derives the deadline from
 * the same rows the evidence projection reads, and a task with no anchor at all can never be due.
 */
function seedDelayedTask(
  db: DatabaseSync,
  inputs: {
    userId: string
    seed: Seed
    anchorAt: Instant
    delayHours: number
    now: Instant
    status?: string
  },
): { taskId: string; reviewId: string; notBefore: Instant } {
  const { userId, seed, anchorAt, delayHours, now } = inputs
  insertRow(
    db,
    'practice_exposure_event',
    {
      user_id: userId,
      project_id: seed.projectId,
      question_id: seed.questionId,
      question_version_id: seed.versionId,
      family_id: null,
      content_lineage_id: null,
      session_item_id: null,
      kind: 'explanation_delivered',
      purpose: 'practice',
      source: 'b8-test-anchor',
      server_time: anchorAt,
      reveals_answer: true,
      detail: {},
    },
    { now },
  )
  const notBefore = anchorAt + BigInt(delayHours) * HOUR
  const task = insertRow(
    db,
    'learning_study_task',
    {
      user_id: userId,
      project_id: seed.projectId,
      subject_id: seed.subjectId,
      task_kind: 'delayed_verification',
      status: inputs.status ?? 'pending',
      plan_id: null,
      question_id: seed.questionId,
      knowledge_node_id: seed.nodeId,
      pairing_id: null,
      pairing_version: 1,
      origin_session_item_id: null,
      memory_card_id: null,
      trigger_event: 'attempt_graded',
      delay_anchor_at: anchorAt,
      not_before: notBefore,
      due_at: notBefore,
      estimated_minutes: 2,
      estimated_minutes_source: 'default_by_type',
      reason_codes: ['due_delayed_verification', `delay_${delayHours}h`],
      evidence_ids: [],
      rule_version: 'p0-1',
      invalidated_reason: '',
      started_at: null,
      completed_at: null,
      deficit_notice: '',
    },
    { now },
  )
  const review = insertRow(
    db,
    'learning_review_task',
    {
      user_id: userId,
      project_id: seed.projectId,
      study_task_id: String(task.id),
      knowledge_node_id: seed.nodeId,
      delay_hours: delayHours,
      delay_anchor_at: anchorAt,
      not_before: notBefore,
      anchor_source: 'teaching_exposure',
      was_started: false,
      missing_question_reason: '',
    },
    { now },
  )
  return { taskId: String(task.id), reviewId: String(review.id), notBefore }
}

test('today plan: an empty state is explicit, and a generated plan carries the full TodayPlanOut shape', async () => {
  const h = harness()
  try {
    const empty = await h.call('GET', '/study-plans/today')
    assert.equal(empty.status, 200)
    assert.equal(empty.body.plan, null)
    assert.deepEqual(empty.body.tasks, [])
    assert.deepEqual(empty.body.backlog, [])
    assert.deepEqual(empty.body.progress_notes, [])
    assert.deepEqual(empty.body.notes, ['今日还没有计划：可点击“生成今日计划”'])
    // A date-only project with no evidence: the undiagnosed count is real, not invented.
    assert.deepEqual(empty.body.progress_notes, [])

    const seedA = seedSubject(h.db, h.user, {
      projectName: '学习读项目',
      now: NOW,
      nodeName: '考点甲',
      stem: '验收判断：三角形内角和为 180 度。',
    })

    const generated = await h.call('POST', '/study-plans/today/generate', { body: { refresh: false } })
    assert.equal(generated.status, 200)

    const today = await h.call('GET', '/study-plans/today')
    assert.equal(today.status, 200)
    const plan = today.body.plan
    assert.ok(plan, 'the generated plan must be readable')
    for (const field of [
      'plan_id',
      'plan_date',
      'revision',
      'timezone',
      'daily_budget_minutes',
      'allocated_minutes',
      'allocation',
      'rotation_offset',
      'rule_version',
      'generated_at',
    ]) {
      assert.ok(field in plan, `plan.${field} must exist`)
    }
    assert.match(plan.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/)
    assert.equal(plan.revision, 1)

    assert.ok(today.body.tasks.length >= 1, 'the published question must be scheduled')
    const task = today.body.tasks[0]
    for (const field of [
      'task_id',
      'task_kind',
      'status',
      'project_id',
      'subject_id',
      'question_id',
      'question_label',
      'knowledge_node_id',
      'knowledge_node_name',
      'estimated_minutes',
      'reason_codes',
      'evidence_ids',
      'not_before',
      'due_at',
      'delay_anchor_at',
      'delay_hours',
      'available_now',
      'deficit_notice',
      'pairing_version',
    ]) {
      assert.ok(field in task, `task.${field} must exist`)
    }
    assert.equal(task.project_id, seedA.projectId)
    assert.equal(task.question_id, seedA.questionId)
    assert.equal(task.delay_hours, null)
    assert.equal(task.available_now, true)
    assert.equal(typeof task.estimated_minutes, 'number')
    // The budget is larger than the one published question: the shortfall is explained, not hidden.
    assert.ok(
      today.body.notes.some((note: string) => note.includes('仍有') && note.includes('分钟未分配')),
      `notes must explain the unused budget: ${JSON.stringify(today.body.notes)}`,
    )
  } finally {
    h.close()
  }
})

test('today plan: the plan writes its own reason code onto a reused delayed task', async () => {
  const h = harness()
  try {
    const seed = seedSubject(h.db, h.user, {
      projectName: '延迟计划项目',
      now: NOW,
      nodeName: '考点己',
      stem: '验收判断：延迟任务进入今日计划。',
    })
    const delayed = seedDelayedTask(h.db, {
      userId: h.user,
      seed,
      anchorAt: NOW - 30n * HOUR,
      delayHours: 24,
      now: NOW,
    })
    // The codes `on_attempt_graded` writes; the plan marker is what a plan generation adds.
    updateRow(
      h.db,
      'learning_study_task',
      delayed.taskId,
      { reason_codes: ['delayed_verification', 'delay_24h', 'teaching_exposure'] },
      { now: NOW },
    )

    assert.equal((await h.call('POST', '/study-plans/today/generate', { body: {} })).status, 200)
    const today = await h.call('GET', '/study-plans/today')
    const row = today.body.tasks.find((task: any) => task.task_id === delayed.taskId)
    assert.ok(row, 'the due delayed task is planned')
    assert.deepEqual(
      row.reason_codes,
      ['due_delayed_verification', 'delayed_verification', 'delay_24h', 'teaching_exposure'],
      'Django prefixes the plan reason to the task codes and writes the list back (planner.py:185, 528-533)',
    )
    // The client label map (TodayPage REASON_LABELS) resolves `due_delayed_verification` to 到期延迟验证.
    assert.equal(row.reason_codes[0], 'due_delayed_verification')
  } finally {
    h.close()
  }
})

test('today plan: a question sealed after planning is hidden with an explicit note', async () => {
  const h = harness()
  try {
    const seed = seedSubject(h.db, h.user, {
      projectName: '封存项目',
      now: NOW,
      nodeName: '考点乙',
      stem: '验收判断：封存题不可展示。',
    })
    assert.equal((await h.call('POST', '/study-plans/today/generate', { body: {} })).status, 200)
    const before = await h.call('GET', '/study-plans/today')
    // With the fixed `undiagnosed_candidates` (B10 W3) the single question is planned twice: once as
    // the undiagnosed probe and once in the general pool. That is Django's behaviour — `_plan_project`
    // has no question-level dedupe across categories — and the real-Django oracle in
    // `scripts/probe_b10_planner.py` pins it. The point of this test is that sealing hides both.
    assert.equal(before.body.tasks.length, 2)
    assert.deepEqual(
      before.body.tasks.map((task: any) => task.task_kind).sort(),
      ['general_practice', 'undiagnosed_probe'],
    )

    sealQuestion(h.db, {
      projectId: seed.projectId,
      questionId: seed.questionId,
      actorId: h.user,
      reason: '考前封存',
      now: NOW,
    })
    const after = await h.call('GET', '/study-plans/today')
    assert.equal(after.status, 200)
    assert.deepEqual(after.body.tasks, [])
    assert.ok(
      after.body.notes.includes('有 2 个任务因题目已封存（holdout）未在本计划中展示。'),
      `notes must explain the removal: ${JSON.stringify(after.body.notes)}`,
    )
  } finally {
    h.close()
  }
})

test('review tasks: due_now is the recomputed interval, never the stored timestamp', async () => {
  const h = harness()
  try {
    const dueSeed = seedSubject(h.db, h.user, {
      projectName: '复习项目',
      now: NOW,
      nodeName: '考点丙',
      stem: '验收判断：到期题。',
    })
    // 30 hours ago trained, 24h interval -> due 6 hours ago.
    const due = seedDelayedTask(h.db, {
      userId: h.user,
      seed: dueSeed,
      anchorAt: NOW - 30n * HOUR,
      delayHours: 24,
      now: NOW,
    })
    const waitingSeed = seedSubject(h.db, h.user, {
      projectName: '复习项目二',
      now: NOW,
      nodeName: '考点丁',
      stem: '验收判断：未到期题。',
    })
    // 1 hour ago trained, 24h interval -> due in 23 hours.
    const waiting = seedDelayedTask(h.db, {
      userId: h.user,
      seed: waitingSeed,
      anchorAt: NOW - 1n * HOUR,
      delayHours: 24,
      now: NOW,
    })

    const listed = await h.call('GET', `/projects/${dueSeed.projectId}/review-tasks`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.now, '2026-08-01T00:00:00+00:00')
    assert.equal(listed.body.rows.length, 1)
    const row = listed.body.rows[0]
    for (const field of [
      'task_id',
      'status',
      'subject_id',
      'question_id',
      'question_label',
      'knowledge_node_name',
      'delay_hours',
      'delay_anchor_at',
      'not_before',
      'due_now',
      'interval_reason',
      'anchor_source',
      'was_started',
      'deficit_notice',
      'reason_codes',
    ]) {
      assert.ok(field in row, `review row.${field} must exist`)
    }
    assert.equal(row.task_id, due.taskId)
    assert.equal(row.due_now, true)
    assert.equal(row.interval_reason, '')
    assert.equal(row.delay_hours, 24)
    assert.equal(row.anchor_source, 'teaching_exposure')
    assert.equal(row.question_label, '判断-1')
    assert.equal(row.knowledge_node_name, '考点丙')
    assert.equal(row.was_started, false)
    assert.equal(row.not_before, '2026-07-31T18:00:00+00:00')
    assert.equal(row.delay_anchor_at, '2026-07-30T18:00:00+00:00')

    // The not-yet-due task lives in its own project and reports *why* it is not startable.
    const waitingList = await h.call('GET', `/projects/${waitingSeed.projectId}/review-tasks?only_due=true`)
    assert.equal(waitingList.status, 200)
    assert.deepEqual(waitingList.body.rows, [])
    const waitingAll = await h.call('GET', `/projects/${waitingSeed.projectId}/review-tasks`)
    assert.equal(waitingAll.body.rows.length, 1)
    assert.equal(waitingAll.body.rows[0].task_id, waiting.taskId)
    assert.equal(waitingAll.body.rows[0].due_now, false)
    assert.match(waitingAll.body.rows[0].interval_reason, /延迟验证需等待：还需约 23\.00 小时/)

    // A subject filter must match, and a foreign subject must be a 404.
    const scoped = await h.call(
      'GET',
      `/projects/${dueSeed.projectId}/review-tasks?subject_id=${dueSeed.subjectId}`,
    )
    assert.equal(scoped.status, 200)
    assert.equal(scoped.body.rows.length, 1)
    const foreignSubject = await h.call(
      'GET',
      `/projects/${dueSeed.projectId}/review-tasks?subject_id=${waitingSeed.subjectId}`,
    )
    assert.equal(foreignSubject.status, 404)
    const unknownProject = await h.call('GET', '/projects/not-a-project/review-tasks')
    assert.equal(unknownProject.status, 404)
    assert.equal(unknownProject.body.error.code, 'not_found')
  } finally {
    h.close()
  }
})

test('study tasks: start enforces the interval, fixes the mode and replays one idempotent result', async () => {
  const h = harness()
  try {
    const seed = seedSubject(h.db, h.user, {
      projectName: '开始项目',
      now: NOW,
      nodeName: '考点戊',
      stem: '验收判断：开始验证。',
    })
    const due = seedDelayedTask(h.db, {
      userId: h.user,
      seed,
      anchorAt: NOW - 30n * HOUR,
      delayHours: 24,
      now: NOW,
    })

    // A missing key is Django's `IdempotencyConflict`, not a 400.
    const keyless = await h.call('POST', `/study-tasks/${due.taskId}/start`, { key: null })
    assert.equal(keyless.status, 409)
    assert.equal(keyless.body.error.code, 'idempotency_conflict')
    assert.equal(keyless.body.error.message, '缺少 Idempotency-Key 请求头')

    const started = await h.call('POST', `/study-tasks/${due.taskId}/start`, { key: 'start-1' })
    assert.equal(started.status, 200)
    assert.equal(started.body.task_id, due.taskId)
    assert.equal(started.body.status, 'in_progress')
    assert.equal(started.body.project_id, seed.projectId)
    assert.equal(started.body.delay_status.satisfied, true)
    assert.deepEqual(started.body.create_session_hint, {
      subject_id: seed.subjectId,
      question_ids: [seed.questionId],
      task_id: due.taskId,
      purpose: 'delayed_verification',
    })
    // The interval checker records that the review was actually begun.
    const review = findRows(h.db, 'learning_review_task', { id: due.reviewId })[0]
    assert.equal(review.was_started, true)

    // Replay: same key, same body, and the task does not move again.
    const replay = await h.call('POST', `/study-tasks/${due.taskId}/start`, { key: 'start-1' })
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.body, started.body)

    const task = await h.call('GET', `/study-tasks/${due.taskId}`)
    assert.equal(task.status, 200)
    assert.equal(task.body.task_kind, 'delayed_verification')
    assert.equal(task.body.delay_hours, 24)
    assert.equal(task.body.question_id, seed.questionId)
    assert.equal(task.body.knowledge_node_name, '考点戊')
    assert.equal(task.body.origin_session_item_id, null)
    assert.equal(task.body.memory_card_id, null)
    assert.equal(task.body.pairing_version, 1)
    assert.equal(task.body.trigger_event, 'attempt_graded')
    assert.equal(task.body.delay_anchor_at, '2026-07-30T18:00:00+00:00')

    // Django allows re-starting an in-progress task (only completed/skipped/invalidated are final);
    // the interval is still re-checked on every call.
    const again = await h.call('POST', `/study-tasks/${due.taskId}/start`)
    assert.equal(again.status, 200)
    assert.equal(again.body.status, 'in_progress')
    assert.equal(again.body.delay_status.satisfied, true)

    // Another account's task is a 404 (never a 403 that would confirm it exists).
    const foreignSeed = seedSubject(h.db, h.other, {
      projectName: '别人的项目',
      now: NOW,
      nodeName: '考点他',
      stem: '验收判断：别人的题。',
    })
    const foreignRow = insertRow(
      h.db,
      'learning_study_task',
      completeRow('learning_study_task', {
        user_id: h.other,
        project_id: foreignSeed.projectId,
        subject_id: foreignSeed.subjectId,
        task_kind: 'delayed_verification',
        status: 'pending',
        question_id: foreignSeed.questionId,
        knowledge_node_id: foreignSeed.nodeId,
      }),
      { now: NOW },
    )
    const foreign = await h.call('GET', `/study-tasks/${String(foreignRow.id)}`)
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error.message, '任务不存在或不在当前权限范围')
    const unknown = await h.call('GET', '/study-tasks/missing')
    assert.equal(unknown.status, 404)
  } finally {
    h.close()
  }
})

test('study tasks: an unstartable interval and an unusable question are refused with the reason', async () => {
  const h = harness()
  try {
    const waitingSeed = seedSubject(h.db, h.user, {
      projectName: '等待项目',
      now: NOW,
      nodeName: '考点己',
      stem: '验收判断：还没到期。',
    })
    const waiting = seedDelayedTask(h.db, {
      userId: h.user,
      seed: waitingSeed,
      anchorAt: NOW - 1n * HOUR,
      delayHours: 24,
      now: NOW,
    })
    const refused = await h.call('POST', `/study-tasks/${waiting.taskId}/start`)
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'invalid_input')
    assert.match(refused.body.error.message, /延迟验证需等待：还需约 23\.00 小时/)
    assert.equal(refused.body.error.details.not_before, '2026-08-01T23:00:00+00:00')
    // A refused start does not invalidate the task: waiting is the correct action.
    const still = await h.call('GET', `/study-tasks/${waiting.taskId}`)
    assert.equal(still.body.status, 'pending')

    // A sealed question invalidates the task and says why; the row keeps the reason for the UI.
    const sealedSeed = seedSubject(h.db, h.user, {
      projectName: '封存开始项目',
      now: NOW,
      nodeName: '考点庚',
      stem: '验收判断：封存后不可开始。',
    })
    const opened = seedDelayedTask(h.db, {
      userId: h.user,
      seed: sealedSeed,
      anchorAt: NOW - 30n * HOUR,
      delayHours: 24,
      now: NOW,
    })
    sealQuestion(h.db, {
      projectId: sealedSeed.projectId,
      questionId: sealedSeed.questionId,
      actorId: h.user,
      reason: '考前封存',
      now: NOW,
    })
    const invalidated = await h.call('POST', `/study-tasks/${opened.taskId}/start`)
    assert.equal(invalidated.status, 400)
    assert.match(invalidated.body.error.message, /^题目当前不可用：/)
    assert.match(invalidated.body.error.message, /封存/)
    const row = findRows(h.db, 'learning_study_task', { id: opened.taskId })[0]
    assert.equal(row.status, 'invalidated')
    assert.match(String(row.invalidated_reason), /封存/)
  } finally {
    h.close()
  }
})

test('study tasks: defer, skip, complete and reconcile-delay keep their Django contracts', async () => {
  const h = harness()
  try {
    const seed = seedSubject(h.db, h.user, {
      projectName: '生命周期项目',
      now: NOW,
      nodeName: '考点辛',
      stem: '验收判断：生命周期。',
    })
    const first = seedDelayedTask(h.db, {
      userId: h.user,
      seed,
      anchorAt: NOW - 30n * HOUR,
      delayHours: 24,
      now: NOW,
    })
    const second = seedDelayedTask(h.db, {
      userId: h.user,
      seed,
      anchorAt: NOW - 30n * HOUR,
      delayHours: 24,
      now: NOW,
    })

    const deferred = await h.call('POST', `/study-tasks/${first.taskId}/defer`, { body: { reason: 'user' } })
    assert.equal(deferred.status, 200)
    assert.equal(deferred.body.status, 'deferred')
    assert.deepEqual(deferred.body.reason_codes.slice(-1), ['deferred:user'])
    const deferredReplay = await h.call('POST', `/study-tasks/${first.taskId}/defer`, {
      body: { reason: 'user' },
      key: 'same-defer',
    })
    assert.equal(deferredReplay.status, 200)
    // Same key with a different reason is a payload conflict, not a second defer.
    const conflict = await h.call('POST', `/study-tasks/${first.taskId}/defer`, {
      body: { reason: 'later' },
      key: 'same-defer',
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'idempotency_conflict')

    const skipped = await h.call('POST', `/study-tasks/${second.taskId}/skip`, { body: { reason: '不做了' } })
    assert.equal(skipped.status, 200)
    assert.equal(skipped.body.status, 'skipped')
    const skippedAgain = await h.call('POST', `/study-tasks/${second.taskId}/skip`, { body: {} })
    assert.equal(skippedAgain.status, 200, 'skipping is idempotent by status')

    const completed = await h.call('POST', `/study-tasks/${second.taskId}/complete`, { body: {} })
    assert.equal(completed.status, 200)
    assert.equal(completed.body.status, 'completed')
    assert.equal(completed.body.note, '未产生作答，因此不计入任何能力证据')
    const completedAgain = await h.call('POST', `/study-tasks/${second.taskId}/complete`, { body: {} })
    assert.equal(completedAgain.status, 200)
    assert.equal(completedAgain.body.status, 'completed')
    assert.equal(completedAgain.body.note, undefined, 'a repeated complete does not re-claim evidence')
    const deferCompleted = await h.call('POST', `/study-tasks/${second.taskId}/defer`, { body: {} })
    assert.equal(deferCompleted.status, 400)
    assert.equal(deferCompleted.body.error.message, '已完成任务不能顺延')

    const reconciled = await h.call('POST', `/projects/${seed.projectId}/study-tasks/${first.taskId}/reconcile-delay`)
    assert.equal(reconciled.status, 200)
    assert.equal(reconciled.body.task_id, first.taskId)
    assert.equal(typeof reconciled.body.reconciled_tasks, 'number')
    assert.equal(reconciled.body.delay_status.satisfied, true)

    const foreignTask = await h.call('POST', `/projects/unknown/study-tasks/${first.taskId}/reconcile-delay`)
    assert.equal(foreignTask.status, 404)
  } finally {
    h.close()
  }
})

test('exposure ledger: a declaration is 201, replays one row, and there is no way back', async () => {
  const h = harness()
  try {
    const seed = seedSubject(h.db, h.user, {
      projectName: '暴露项目',
      now: NOW,
      nodeName: '暴露考点',
      stem: '验收判断：暴露台账题干。',
    })

    const unseen = await h.call('GET', `/projects/${seed.projectId}/questions/${seed.questionId}/exposure`)
    assert.equal(unseen.status, 200)
    assert.equal(unseen.body.question_id, seed.questionId)
    assert.equal(unseen.body.seen, false)
    assert.deepEqual(unseen.body.reasons, [])
    assert.deepEqual(unseen.body.sources, [])
    assert.equal(unseen.body.first_seen_at, null)
    assert.equal(unseen.body.strict_independent_eligible, true)
    assert.deepEqual(unseen.body.exclusion_reasons, [])

    // A missing key is Django's `IdempotencyConflict` (409), and nothing is written.
    const keyless = await h.call(
      'POST',
      `/projects/${seed.projectId}/questions/${seed.questionId}/external-seen`,
      { body: { seen: true, note: '我在别处做过这张卷子' }, key: null },
    )
    assert.equal(keyless.status, 409)
    assert.equal(keyless.body.error.code, 'idempotency_conflict')
    assert.equal(keyless.body.error.message, '缺少 Idempotency-Key 请求头')

    const marked = await h.call(
      'POST',
      `/projects/${seed.projectId}/questions/${seed.questionId}/external-seen`,
      { body: { seen: true, note: '我在别处做过这张卷子' }, key: 'seen-1' },
    )
    assert.equal(marked.status, 201)
    assert.equal(marked.body.seen, true)
    assert.ok(marked.body.reasons.includes('external_seen'))
    assert.equal(marked.body.strict_independent_eligible, false)
    assert.equal(marked.body.exclusion_reasons[0].code, 'external_seen')
    assert.equal(marked.body.exclusion_reasons[0].evidence.evidence_type, 'exposure_event')
    assert.match(marked.body.exclusion_reasons[0].message, /声明不可撤销/)
    assert.equal(typeof marked.body.first_seen_at, 'string')

    // The ledger is append-only: replaying the key reuses the same row and the same response.
    const replay = await h.call(
      'POST',
      `/projects/${seed.projectId}/questions/${seed.questionId}/external-seen`,
      { body: { seen: true, note: '我在别处做过这张卷子' }, key: 'seen-1' },
    )
    assert.equal(replay.status, 201)
    assert.deepEqual(replay.body, marked.body)
    assert.equal(
      countRows(h.db, 'practice_exposure_event', { question_id: seed.questionId, kind: 'external_seen' }),
      1,
      'a replay must not append a second declaration',
    )

    // Same key with different content is a payload conflict naming the route scope.
    const conflict = await h.call(
      'POST',
      `/projects/${seed.projectId}/questions/${seed.questionId}/external-seen`,
      { body: { seen: false, note: '改主意' }, key: 'seen-1' },
    )
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.message, '相同幂等键使用了不同请求内容')
    assert.equal(conflict.body.error.details.route_scope, `questions.external-seen:${seed.questionId}`)

    // A correction row is kept, but it does not reset the decision (C04: no path back).
    const corrected = await h.call(
      'POST',
      `/projects/${seed.projectId}/questions/${seed.questionId}/external-seen`,
      { body: { seen: false, note: '其实没做过' }, key: 'seen-2' },
    )
    assert.equal(corrected.status, 201)
    assert.ok(corrected.body.reasons.includes('external_seen'))
    assert.equal(corrected.body.strict_independent_eligible, false)
    assert.equal(
      countRows(h.db, 'practice_exposure_event', { question_id: seed.questionId, kind: 'external_seen' }),
      2,
    )

    // The read path is stable afterwards: the declaration is history, not a toggle.
    const after = await h.call('GET', `/projects/${seed.projectId}/questions/${seed.questionId}/exposure`)
    assert.equal(after.body.seen, true)
    assert.equal(after.body.strict_independent_eligible, false)

    // Scope: an unknown question, or a question from another project, is a 404.
    const unknown = await h.call('GET', `/projects/${seed.projectId}/questions/missing/exposure`)
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.message, '题目不存在或不属于该项目')
    const otherSeed = seedSubject(h.db, h.user, {
      projectName: '暴露项目二',
      now: NOW,
      nodeName: '别人的考点',
      stem: '验收判断：另一个项目的题干。',
    })
    const crossProject = await h.call(
      'GET',
      `/projects/${seed.projectId}/questions/${otherSeed.questionId}/exposure`,
    )
    assert.equal(crossProject.status, 404)
    const stillUnseen = await h.call(
      'GET',
      `/projects/${otherSeed.projectId}/questions/${otherSeed.questionId}/exposure`,
    )
    assert.equal(stillUnseen.body.seen, false)
    assert.equal(stillUnseen.body.strict_independent_eligible, true)
  } finally {
    h.close()
  }
})
