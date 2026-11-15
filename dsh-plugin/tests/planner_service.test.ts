import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import {
  currentPlan,
  generatePlan,
  localDateIn,
  planTasks,
  undiagnosedCandidates,
  weaklyKnownCandidates,
} from '../src/services/planner.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2027-02-01T10:00:00+00:00')
const TODAY = '2027-02-01'
const CONTENT = { blocks: [{ kind: 'text', text: '题干' }], options: [{ id: 'a' }, { id: 'b' }] }

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
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'p@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  insertRow(
    db,
    'accounts_user_settings',
    completeRow('accounts_user_settings', {
      user_id: user.id,
      timezone: 'UTC',
      daily_budget_minutes: 60,
      project_budget_percent: {},
      undiagnosed_time_share_percent: 30,
      default_practice_tutoring: 'allowed',
    }),
    { now: NOW },
  )
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)

  const makeQuestion = (label: string) => {
    const question = insertRow(
      db,
      'question_bank_question',
      completeRow('question_bank_question', { subject_id: subject.id, origin_type: 'import', is_demo: false, display_label: label }),
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
    insertRow(
      db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: draft.id,
        version: 1,
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'b' },
        check_basis: '教材',
        source_type: 'textbook',
      }),
      { now: NOW },
    )
    publishQuestionVersion(db, userId, projectId, String(draft.id), { allowWithoutScore: true, now: NOW })
    return { questionId: String(question.id), versionId: String(draft.id) }
  }

  return { db, close: handle.close, userId, projectId, subjectId: String(subject.id), makeQuestion }
}

test('planner: localDateIn follows the learner timezone, not the server clock', () => {
  assert.equal(localDateIn('UTC', NOW), '2027-02-01')
  // 10:00Z is 02:00 in Los Angeles: still the 1st there.
  assert.equal(localDateIn('America/Los_Angeles', NOW), '2027-02-01')
  // 03:00Z is 19:00 the previous day in Los Angeles, so the learner's "today" is still January 31.
  assert.equal(localDateIn('America/Los_Angeles', parseInstant('2027-02-01T03:00:00+00:00')), '2027-01-31')
  assert.equal(localDateIn('Asia/Tokyo', NOW), '2027-02-01')
  assert.equal(localDateIn('Asia/Tokyo', parseInstant('2027-01-31T20:00:00+00:00')), '2027-02-01')
})

test('planner: a generated plan fills the budget with usable questions', () => {
  const s = seeded()
  try {
    s.makeQuestion('Q1')
    s.makeQuestion('Q2')
    const plan = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    assert.equal(plan.revision, 1)
    assert.equal(String(plan.plan_date), TODAY)
    assert.equal(plan.daily_budget_minutes, 60)

    const tasks = planTasks(s.db, String(plan.id))
    assert.ok(tasks.length > 0, 'a plan with usable questions must schedule something')
    assert.ok(Number(plan.allocated_minutes) > 0)
    for (const task of tasks) {
      assert.equal(task.status, 'pending')
      const kinds = ['undiagnosed_probe', 'general_practice', 'weakness_repair', 'memory_review', 'delayed_verification'] as string[]
    assert.ok(kinds.includes(String(task.task_kind)))
    }
  } finally {
    s.close()
  }
})

test('planner: asking twice returns the same plan; refresh creates a new revision', () => {
  const s = seeded()
  try {
    s.makeQuestion('Q1')
    const first = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    const again = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    assert.equal(String(again.id), String(first.id), 'a second call must not regenerate the day')

    const refreshed = generatePlan(s.db, s.userId, { onDate: TODAY, refresh: true, now: NOW })
    assert.equal(refreshed.revision, 2)
    // The previous revision's unstarted tasks are skipped, not deleted.
    const old = planTasks(s.db, String(first.id))
    assert.ok(old.every((task) => task.status === 'skipped'))
    assert.match(String(old[0].invalidated_reason), /计划刷新/)
  } finally {
    s.close()
  }
})

test('planner: a refresh keeps work that has already started', () => {
  const s = seeded()
  try {
    s.makeQuestion('Q1')
    const first = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    const tasks = planTasks(s.db, String(first.id))
    insertRow(s.db, 'audit_content_revision', completeRow('audit_content_revision', {
      entity_type: 'study_task',
      entity_id: String(tasks[0].id),
      action: 'start',
    }), { now: NOW })
    s.db.prepare('UPDATE "learning_study_task" SET "status" = ? WHERE "id" = ?').run('in_progress', String(tasks[0].id))

    generatePlan(s.db, s.userId, { onDate: TODAY, refresh: true, now: NOW })
    const kept = findRows(s.db, 'learning_study_task', { id: String(tasks[0].id) })[0]
    assert.equal(kept.status, 'in_progress', 'a refresh must not discard started work')
  } finally {
    s.close()
  }
})

test('planner: a sealed question is never scheduled', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('封存')
    sealQuestion(s.db, { projectId: s.projectId, questionId: q.questionId, actorId: s.userId, now: NOW })
    const plan = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    const tasks = planTasks(s.db, String(plan.id))
    assert.equal(tasks.length, 0, 'the only question is sealed, so nothing may be scheduled')
    assert.ok(Number(plan.allocated_minutes) === 0)
    assert.ok(
      (plan.notes as string[]).some((note) => /未分配/.test(note)),
      'the plan must say why it is empty',
    )
  } finally {
    s.close()
  }
})

test('planner: a question without a checked answer is never scheduled', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('待核')
    s.db.prepare('UPDATE "question_bank_answer_key_version" SET "verification_status" = ? WHERE "question_version_id" = ?')
      .run('pending', q.versionId)
    const plan = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    assert.equal(planTasks(s.db, String(plan.id)).length, 0)
  } finally {
    s.close()
  }
})

test('planner: an AI-derived answer is not trusted for scheduling', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('AI答案')
    s.db.prepare('UPDATE "question_bank_answer_key_version" SET "source_type" = ? WHERE "question_version_id" = ?')
      .run('ai_derived', q.versionId)
    assert.equal(planTasks(s.db, String(generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW }).id)).length, 0)
  } finally {
    s.close()
  }
})

test('planner: a due memory card becomes a cheap recall task', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('卡片题')
    insertRow(
      s.db,
      'memory_card',
      completeRow('memory_card', {
        user_id: s.userId,
        project_id: s.projectId,
        question_id: q.questionId,
        knowledge_node_id: null,
        subject_id: s.subjectId,
        due_at: NOW - 3_600_000_000n,
        phase: 'review',
        stability: '1.0',
        difficulty: '5.0',
        reps: 1,
        lapses: 0,
        learning_step: 0,
        scheduler_version: 'fsrs-5',
        params_version: 'default',
        desired_retention: '0.9',
        is_suspended: false,
        note: '',
      }),
      { now: NOW },
    )
    const plan = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    const tasks = planTasks(s.db, String(plan.id))
    const memory = tasks.find((task) => task.task_kind === 'memory_review')
    assert.ok(memory, 'a due card must enter the plan')
    assert.equal(String(memory.memory_card_id).length > 0, true)
  } finally {
    s.close()
  }
})

test('planner: currentPlan reads back what was generated', () => {
  const s = seeded()
  try {
    s.makeQuestion('Q1')
    assert.equal(currentPlan(s.db, s.userId, TODAY), null)
    const plan = generatePlan(s.db, s.userId, { onDate: TODAY, now: NOW })
    assert.equal(String(currentPlan(s.db, s.userId, TODAY)?.id), String(plan.id))
  } finally {
    s.close()
  }
})

/* --------------------------------------------------------------------------
 * Weak repair: the prerequisite graph and the plan's `trigger_event` (B10 W1/W2)
 *
 * The oracle is `backend/apps/learning/services/planner.py::weakly_known_candidates` +
 * `_question_for_node` + `_materialise_task`, frozen against real Django rows by
 * `scripts/probe_b10_planner.py` (`var/b10/parity-probe.json`).
 * ------------------------------------------------------------------------ */

/** `seeded()` plus the rows the weak branch reads: syllabus, nodes, mappings, states, edges, pairings. */
function weakFixture() {
  const base = seeded()
  const { db, userId, projectId } = base
  const syllabus = insertRow(
    db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', {
      subject_id: base.subjectId,
      name: 'S 大纲',
      version_label: 'v1',
      status: 'published',
      is_user_provisional: 1,
      review_status: 'draft',
      published_at: NOW,
    }),
    { now: NOW },
  )
  const makeNode = (name: string) =>
    insertRow(
      db,
      'knowledge_node',
      completeRow('knowledge_node', {
        syllabus_version_id: syllabus.id,
        canonical_name: name,
        kind: 'point',
        aliases: [],
        is_unclassified: 0,
        display_order: 0,
      }),
      { now: NOW },
    )
  const map = (node: Record<string, unknown>, question: { versionId: string }, primary = true) =>
    insertRow(
      db,
      'knowledge_question_mapping',
      completeRow('knowledge_question_mapping', {
        question_version_id: question.versionId,
        node_id: node.id,
        mapping_revision: 1,
        is_primary: primary ? 1 : 0,
        score_weight: primary ? '1.0000' : '0.0000',
        note: '',
      }),
      { now: NOW },
    )
  const state = (
    node: Record<string, unknown>,
    summary: string,
    options: { needsReview: boolean; at?: bigint; evidence?: string[] },
  ) =>
    insertRow(
      db,
      'learning_knowledge_state',
      completeRow('learning_knowledge_state', {
        user_id: userId,
        project_id: projectId,
        syllabus_version_id: syllabus.id,
        node_id: node.id,
        summary,
        best_summary: summary,
        needs_review: options.needsReview ? 1 : 0,
        independent_correct_count: 0,
        as_of: options.at ?? NOW,
        source_evidence_ids: options.evidence ?? [],
        detail: {},
      }),
      { now: NOW },
    )
  const relate = (from: Record<string, unknown>, to: Record<string, unknown>) =>
    insertRow(
      db,
      'knowledge_relation',
      completeRow('knowledge_relation', {
        syllabus_version_id: syllabus.id,
        from_node_id: from.id,
        to_node_id: to.id,
        relation_type: 'prerequisite',
        is_active: 1,
        note: '',
      }),
      { now: NOW },
    )
  const pair = (node: Record<string, unknown>, question: { questionId: string }, active = true) =>
    insertRow(
      db,
      'knowledge_verification_pairing',
      completeRow('knowledge_verification_pairing', {
        project_id: projectId,
        subject_id: base.subjectId,
        node_id: node.id,
        immediate_question_id: question.questionId,
        pairing_version: 1,
        delay_hours: 24,
        is_active: active ? 1 : 0,
        note: '',
      }),
      { now: NOW },
    )
  return { ...base, syllabus, makeNode, map, state, relate, pair }
}

test('planner: a confirmed weak point practises its unmet prerequisite first', () => {
  const f = weakFixture()
  try {
    const baseQuestion = f.makeQuestion('基础题')
    const weakQuestion = f.makeQuestion('薄弱题')
    const baseNode = f.makeNode('基础考点')
    const weakNode = f.makeNode('薄弱考点')
    f.map(baseNode, baseQuestion)
    f.map(weakNode, weakQuestion)
    f.relate(baseNode, weakNode)
    f.state(weakNode, 'needs_review', { needsReview: true })

    const rows = weaklyKnownCandidates(f.db, f.projectId)
    assert.equal(rows.length, 1)
    // The prerequisite's question is offered, and the row points at the *prerequisite* node.
    assert.equal(rows[0].question_id, baseQuestion.questionId)
    assert.equal(rows[0].knowledge_node_id, String(baseNode.id))
    assert.equal(rows[0].knowledge_node_name, '基础考点')
    assert.deepEqual(rows[0].reason_codes, [
      'prerequisite_first',
      'prerequisite_undiagnosed',
      'unblocks:薄弱考点',
      'blocked_state_needs_review',
    ])
    assert.equal(rows[0].deficit_notice, '')
  } finally {
    f.close()
  }
})

test('planner: the weak branch follows needs_review, not the needs_foundation summary', () => {
  const f = weakFixture()
  try {
    const confirmedQuestion = f.makeQuestion('确认薄弱')
    const gapQuestion = f.makeQuestion('基础缺口')
    const confirmed = f.makeNode('确认薄弱考点')
    const gap = f.makeNode('基础缺口考点')
    f.map(confirmed, confirmedQuestion)
    f.map(gap, gapQuestion)
    // A summary of `needs_review` plus the flag is what the planner repairs.
    f.state(confirmed, 'needs_review', { needsReview: true })
    // A bare `needs_foundation` state is *not* weak-repair work for the planner (Django's
    // `weakly_known_candidates` filters `needs_review=True`; `needs_foundation` only appears here as
    // the reason a prerequisite is unmet).
    f.state(gap, 'needs_foundation', { needsReview: false })

    const rows = weaklyKnownCandidates(f.db, f.projectId)
    assert.equal(rows.length, 1, 'only the needs_review state may become a weak candidate')
    assert.equal(rows[0].question_id, confirmedQuestion.questionId)
    assert.deepEqual(rows[0].reason_codes, ['weakness_repair', 'state_needs_review'])
  } finally {
    f.close()
  }
})

test('planner: an unmet prerequisite without a usable question reports the gap instead of hiding it', () => {
  const f = weakFixture()
  try {
    const weakQuestion = f.makeQuestion('薄弱题')
    const weakNode = f.makeNode('薄弱考点')
    const lonely = f.makeNode('空白前置')
    f.map(weakNode, weakQuestion)
    f.relate(lonely, weakNode)
    f.state(weakNode, 'needs_review', { needsReview: true })

    const rows = weaklyKnownCandidates(f.db, f.projectId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].question_id, weakQuestion.questionId)
    assert.equal(rows[0].knowledge_node_id, String(weakNode.id))
    assert.deepEqual(rows[0].reason_codes, [
      'weakness_repair',
      'state_needs_review',
      'prerequisite_missing_question',
    ])
    assert.match(rows[0].deficit_notice, /前置考点「空白前置」尚无可练习题目/)
  } finally {
    f.close()
  }
})

test('planner: a demonstrated prerequisite keeps the weak point itself', () => {
  const f = weakFixture()
  try {
    const baseQuestion = f.makeQuestion('基础题')
    const weakQuestion = f.makeQuestion('薄弱题')
    const baseNode = f.makeNode('基础考点')
    const weakNode = f.makeNode('薄弱考点')
    f.map(baseNode, baseQuestion)
    f.map(weakNode, weakQuestion)
    f.relate(baseNode, weakNode)
    f.state(baseNode, 'independent', { needsReview: false })
    f.state(weakNode, 'needs_review', { needsReview: true })

    const rows = weaklyKnownCandidates(f.db, f.projectId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].question_id, weakQuestion.questionId)
    assert.equal(rows[0].knowledge_node_id, String(weakNode.id))
    assert.deepEqual(rows[0].reason_codes, ['weakness_repair', 'state_needs_review'])
  } finally {
    f.close()
  }
})

test('planner: one question is scheduled at most once, so a shared prerequisite drops the later point', () => {
  const f = weakFixture()
  try {
    const baseQuestion = f.makeQuestion('共用基础题')
    const firstQuestion = f.makeQuestion('第一个薄弱题')
    const secondQuestion = f.makeQuestion('第二个薄弱题')
    const baseNode = f.makeNode('共用基础')
    const firstNode = f.makeNode('薄弱甲')
    const secondNode = f.makeNode('薄弱乙')
    f.map(baseNode, baseQuestion)
    f.map(firstNode, firstQuestion)
    f.map(secondNode, secondQuestion)
    f.relate(baseNode, firstNode)
    f.relate(baseNode, secondNode)
    f.state(firstNode, 'needs_review', { needsReview: true })
    f.state(secondNode, 'needs_review', { needsReview: true, at: NOW + 3_600_000_000n })

    const rows = weaklyKnownCandidates(f.db, f.projectId)
    assert.equal(rows.length, 1, 'the second point must be dropped, not re-pointed at its own question')
    assert.equal(rows[0].question_id, baseQuestion.questionId)
    assert.ok(rows.every((row) => row.question_id !== secondQuestion.questionId))
  } finally {
    f.close()
  }
})

test('planner: an active pairing outranks the node mapping, an inactive one does not', () => {
  const f = weakFixture()
  try {
    const mappedQuestion = f.makeQuestion('映射题')
    const pairedQuestion = f.makeQuestion('配对题')
    const node = f.makeNode('配对考点')
    f.map(node, mappedQuestion)
    f.pair(node, pairedQuestion, false)
    f.state(node, 'needs_review', { needsReview: true })

    const withoutPairing = weaklyKnownCandidates(f.db, f.projectId)
    assert.equal(withoutPairing[0].question_id, mappedQuestion.questionId)

    // Activate the pairing: `_question_for_node` prefers the reviewed A/B question.
    f.db.prepare('UPDATE "knowledge_verification_pairing" SET "is_active" = 1').run()
    const withPairing = weaklyKnownCandidates(f.db, f.projectId)
    assert.equal(withPairing[0].question_id, pairedQuestion.questionId)
  } finally {
    f.close()
  }
})

test('planner: weak states are ordered by as_of and capped at the limit', () => {
  const f = weakFixture()
  try {
    const first = f.makeQuestion('最早')
    const second = f.makeQuestion('其次')
    const third = f.makeQuestion('最晚')
    const firstNode = f.makeNode('考点甲')
    const secondNode = f.makeNode('考点乙')
    const thirdNode = f.makeNode('考点丙')
    f.map(firstNode, first)
    f.map(secondNode, second)
    f.map(thirdNode, third)
    f.state(firstNode, 'needs_review', { needsReview: true, at: NOW })
    f.state(secondNode, 'needs_review', { needsReview: true, at: NOW + 3_600_000_000n })
    f.state(thirdNode, 'needs_review', { needsReview: true, at: NOW + 7_200_000_000n })

    const rows = weaklyKnownCandidates(f.db, f.projectId, 2)
    assert.deepEqual(
      rows.map((row) => row.question_id),
      [first.questionId, second.questionId],
      'Django orders by `-needs_review, as_of` and slices to `max(1, min(limit, 50))`',
    )
    // `max(1, ...)`: a zero limit still reads one state, exactly like Django's clamp.
    assert.equal(weaklyKnownCandidates(f.db, f.projectId, 0).length, 1)
  } finally {
    f.close()
  }
})

test('planner: the weak candidate keeps only ten evidence ids', () => {
  const f = weakFixture()
  try {
    const question = f.makeQuestion('证据题')
    const node = f.makeNode('证据考点')
    const evidence = Array.from({ length: 12 }, (_value, index) => `ev-${index + 1}`)
    f.map(node, question)
    f.state(node, 'needs_review', { needsReview: true, evidence })

    const rows = weaklyKnownCandidates(f.db, f.projectId)
    assert.deepEqual(rows[0].evidence_ids, evidence.slice(0, 10))
  } finally {
    f.close()
  }
})

test('planner: a plan-created task carries no trigger_event and Django row defaults', () => {
  const f = weakFixture()
  try {
    const weakQuestion = f.makeQuestion('薄弱题')
    const weakNode = f.makeNode('薄弱考点')
    const lonely = f.makeNode('空白前置')
    f.map(weakNode, weakQuestion)
    f.relate(lonely, weakNode)
    f.state(weakNode, 'needs_review', { needsReview: true })
    // The candidate carries the fallback notice ...
    assert.match(weaklyKnownCandidates(f.db, f.projectId)[0].deficit_notice, /空白前置/)

    const plan = generatePlan(f.db, f.userId, { onDate: TODAY, now: NOW })
    const tasks = planTasks(f.db, String(plan.id))
    assert.ok(tasks.length > 0)
    for (const task of tasks) {
      // ... but Django's `_materialise_task` passes neither `trigger_event` nor `deficit_notice`, and
      // leaves `estimated_minutes_source` at the model default (`planner.py:558-572`, models.py:129).
      assert.equal(task.trigger_event, '', `task ${String(task.id)} must not invent a trigger event`)
      assert.equal(task.deficit_notice, '')
      assert.equal(task.estimated_minutes_source, 'default_by_type')
    }
  } finally {
    f.close()
  }
})

test('planner: reusing a due delayed task keeps its original trigger_event', () => {
  const f = weakFixture()
  try {
    const question = f.makeQuestion('延迟题')
    const dueAt = NOW - 3_600_000_000n
    const delayed = insertRow(
      f.db,
      'learning_study_task',
      completeRow('learning_study_task', {
        user_id: f.userId,
        project_id: f.projectId,
        subject_id: f.subjectId,
        question_id: question.questionId,
        task_kind: 'delayed_verification',
        status: 'pending',
        trigger_event: 'paired_immediate_graded',
        due_at: dueAt,
        not_before: dueAt,
        estimated_minutes: 5,
        estimated_minutes_source: 'default_by_type',
        reason_codes: ['delayed_verification', 'delay_24h'],
        evidence_ids: [],
        rule_version: 'p0-1',
        invalidated_reason: '',
        deficit_notice: '',
      }),
      { now: NOW },
    )

    const plan = generatePlan(f.db, f.userId, { onDate: TODAY, now: NOW })
    const reused = findRows(f.db, 'learning_study_task', { id: String(delayed.id) })[0]
    assert.equal(String(reused.plan_id), String(plan.id))
    assert.equal(reused.trigger_event, 'paired_immediate_graded', 'reuse must not rewrite the trigger event')
    assert.deepEqual(reused.reason_codes, ['due_delayed_verification', 'delayed_verification', 'delay_24h'])
  } finally {
    f.close()
  }
})

test('planner: undiagnosed candidates skip any stated node and require a primary eligible mapping', () => {
  // Oracle: fixed `planner.py::undiagnosed_candidates` (B10 W3; the UUID/str comparison used to
  // make the exclusion always False). `scripts/probe_b10_planner.py` compares this branch against
  // real Django rows too.
  const s = weakFixture()
  try {
    const stated = s.makeNode('已诊断A')
    s.map(stated, s.makeQuestion('Q1'))
    s.state(stated, 'needs_review', { needsReview: true })

    const undiagnosedB = s.makeNode('未诊断B')
    s.map(undiagnosedB, s.makeQuestion('Q2'))

    const pendingNode = s.makeNode('答案未核对C')
    const pendingQuestion = s.makeQuestion('Q3')
    const answer = findRows(s.db, 'question_bank_answer_key_version', { question_version_id: pendingQuestion.versionId })[0]
    updateRow(s.db, 'question_bank_answer_key_version', answer.id, { verification_status: 'pending' }, { now: NOW })
    s.map(pendingNode, pendingQuestion)

    const auxiliaryOnly = s.makeNode('只有辅助映射D')
    s.map(auxiliaryOnly, s.makeQuestion('Q4'), false)

    const undiagnosedE = s.makeNode('未诊断E')
    s.map(undiagnosedE, s.makeQuestion('Q5'))

    const rows = undiagnosedCandidates(s.db, s.projectId, 50)
    assert.deepEqual(
      rows.map((row) => row.knowledge_node_name),
      ['未诊断B', '未诊断E'],
      'only nodes without a state, with a primary mapping to an eligible question, in node-name order',
    )
    assert.deepEqual(rows.map((row) => row.reason_codes), [['undiagnosed_node'], ['undiagnosed_node']])
    assert.equal(undiagnosedCandidates(s.db, s.projectId, 1).length, 1, 'the limit caps the candidates')
  } finally {
    s.close()
  }
})
