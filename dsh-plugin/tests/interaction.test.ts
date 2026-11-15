import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant } from '../src/domain/instant.ts'
import { findRows, updateRow } from '../src/store/repository.ts'
import {
  activateStep,
  confirmRecallStep,
  createInteractionSession,
  currentInteractionSession,
  finishInteractionSession,
  getInteractionSession,
  requestStepHint,
  skipStep,
  startInteractionSession,
  studyDesk,
  submitRecallStep,
  submitStepAnswer,
} from '../src/services/interaction.ts'
import * as nodeMemory from '../src/services/node_memory.ts'
import { addConfirmedCard, addKnowledgeState, studyStore, NOW } from './support/study_fixtures.ts'

const PAST = parseInstant('2027-01-30T10:00:00+00:00')

function dueMemory(fixture: ReturnType<typeof studyStore>, nodeId: string): string {
  const memory = nodeMemory.getOrCreateNodeMemory(
    fixture.db,
    fixture.userId,
    fixture.projectId,
    nodeId,
    PAST,
  )
  // Pretend the learner recalled it two days ago and it is now overdue.
  updateRow(
    fixture.db,
    'memory_node_state',
    memory.id,
    { due_at: PAST, last_recall_at: PAST, stability: 2.5, phase: 'review', reps: 2 },
    { now: NOW },
  )
  return String(memory.id)
}

function skipUntil(fixture: ReturnType<typeof studyStore>, sessionId: string, kind: string): void {
  const session = getInteractionSession(fixture.db, fixture.userId, fixture.projectId, sessionId, NOW)
  for (const step of session.steps) {
    if (step.kind === kind) return
    if (step.status === 'pending' || step.status === 'active') {
      skipStep(fixture.db, fixture.userId, fixture.projectId, sessionId, step.ordinal, { reason: '测试跳过' }, NOW)
    }
  }
}

test('session: due memory becomes the first warm-up step, deterministically', () => {
  const s = studyStore()
  try {
    dueMemory(s, s.nodeIds[0])
    const session = createInteractionSession(
      s.db,
      s.userId,
      s.projectId,
      { subject_id: s.subjectId, mode: 'daily', budget_minutes: 30 },
      NOW,
    )
    assert.equal(session.status, 'planned')
    assert.ok(session.steps.length > 0)
    const first = session.steps[0]
    assert.equal(first.stage, 'warmup')
    assert.equal(first.kind, 'recall')
    assert.equal(first.node_id, s.nodeIds[0])
    assert.ok(first.reason_codes.includes('due_memory'))
    assert.equal(session.current_step_ordinal, first.ordinal)
    assert.ok(session.estimated_minutes >= 5)
    // The plan is stored once: asking again returns the same open session.
    const again = createInteractionSession(
      s.db,
      s.userId,
      s.projectId,
      { subject_id: s.subjectId, mode: 'daily' },
      NOW,
    )
    assert.equal(again.session_id, session.session_id)
    // A second open-session read agrees on the step order.
    const current = currentInteractionSession(s.db, s.userId, s.projectId, s.subjectId, NOW)
    assert.equal(current?.session_id, session.session_id)
    assert.deepEqual(
      current?.steps.map((step) => step.kind),
      session.steps.map((step) => step.kind),
    )
  } finally {
    s.close()
  }
})

test('recall: submit, confirm, and the memory ledger moves exactly once', async () => {
  const s = studyStore()
  try {
    const memoryId = dueMemory(s, s.nodeIds[0])
    const session = createInteractionSession(
      s.db,
      s.userId,
      s.projectId,
      { subject_id: s.subjectId, mode: 'daily', budget_minutes: 30 },
      NOW,
    )
    startInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    const step = session.steps[0]
    activateStep(s.db, s.userId, s.projectId, session.session_id, step.ordinal, NOW)

    const submit = await submitRecallStep(
      s.db,
      s.userId,
      s.projectId,
      session.session_id,
      step.ordinal,
      { text: '极限的定义是……', confidence_before: 4 },
      NOW,
    )
    assert.equal(submit.recall.event, null, 'nothing is written before the learner confirms')
    assert.equal(submit.recall.coverage, null, 'no confirmed card means no model coverage claim')

    const confirmed = confirmRecallStep(
      s.db,
      s.userId,
      s.projectId,
      session.session_id,
      step.ordinal,
      { rating: 'good' },
      'recall-confirm-1',
      NOW,
    )
    assert.equal(confirmed.event.rating, 'good')
    assert.equal(confirmed.event.memory_updated, true)
    assert.equal(confirmed.step.status, 'completed')
    assert.equal(confirmed.event.coverage.coverage, null)

    const replay = confirmRecallStep(
      s.db,
      s.userId,
      s.projectId,
      session.session_id,
      step.ordinal,
      { rating: 'good' },
      'recall-confirm-1',
      NOW,
    )
    assert.equal(replay.event.event_id, confirmed.event.event_id, 'same key replays the stored event')
    assert.equal(findRows(s.db, 'memory_recall_event', { memory_state_id: memoryId }).length, 1)

    const next = getInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    assert.notEqual(next.current_step_ordinal, step.ordinal)
  } finally {
    s.close()
  }
})

test('recall: a repeat inside ten minutes is recorded but never moves the scheduler', async () => {
  const s = studyStore()
  try {
    dueMemory(s, s.nodeIds[0])
    const first = createInteractionSession(
      s.db,
      s.userId,
      s.projectId,
      { subject_id: s.subjectId, mode: 'daily', budget_minutes: 20 },
      NOW,
    )
    startInteractionSession(s.db, s.userId, s.projectId, first.session_id, NOW)
    const step = first.steps[0]
    activateStep(s.db, s.userId, s.projectId, first.session_id, step.ordinal, NOW)
    await submitRecallStep(s.db, s.userId, s.projectId, first.session_id, step.ordinal, { text: '记得', confidence_before: 3 }, NOW)
    const confirmed = confirmRecallStep(
      s.db, s.userId, s.projectId, first.session_id, step.ordinal, { rating: 'good' }, 'repeat-1', NOW,
    )
    const memoryBefore = nodeMemory.nodeMemoryView(s.db, s.userId, s.projectId, s.nodeIds[0], NOW).memory
    assert.ok(memoryBefore)
    const repeated = nodeMemory.recordRecall(
      s.db,
      s.userId,
      s.projectId,
      {
        nodeId: s.nodeIds[0],
        kind: 'free_recall',
        rating: 'good',
        source: 'self_report',
        coverage: { covered: [], missing: [], cannot_judge: [], coverage: null },
        idempotencyKey: 'repeat-2',
        reviewedAt: (NOW + 60_000_000n) as never,
      },
      (NOW + 60_000_000n) as never,
    )
    assert.equal(repeated.is_spaced, false)
    assert.equal(repeated.memory_updated, false)
    assert.equal(repeated.event_id !== confirmed.event.event_id, true)
    const memoryAfter = nodeMemory.nodeMemoryView(s.db, s.userId, s.projectId, s.nodeIds[0], NOW).memory
    assert.equal(memoryAfter?.reps, memoryBefore.reps)
    assert.equal(memoryAfter?.stability, memoryBefore.stability)
  } finally {
    s.close()
  }
})

test('practice: a deterministic wrong answer appends a repair brief and a retest', () => {
  const s = studyStore()
  try {
    addKnowledgeState(s, s.nodeIds[0], 'independent')
    const session = createInteractionSession(
      s.db,
      s.userId,
      s.projectId,
      { subject_id: s.subjectId, mode: 'daily', budget_minutes: 40 },
      NOW,
    )
    startInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    skipUntil(s, session.session_id, 'practice')
    const practice = getInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW).steps.find(
      (step) => step.kind === 'practice',
    )
    assert.ok(practice, 'the plan must contain practice work')
    const activated = activateStep(s.db, s.userId, s.projectId, session.session_id, practice.ordinal, NOW)
    assert.ok(activated.presentation, 'practice steps expose the presentation')
    const answer = submitStepAnswer(
      s.db,
      s.userId,
      s.projectId,
      session.session_id,
      practice.ordinal,
      { answer: { type: 'single_choice', selected_option_ids: ['opt_b'] }, confidence: 'sure' },
      NOW,
    )
    assert.equal(answer.grade?.is_correct, false)
    assert.equal(answer.step.outcome, 'incorrect')
    const after = getInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    const repair = after.steps.filter((step) => step.stage === 'repair')
    assert.ok(repair.some((step) => step.kind === 'repair_brief'))
    const retest = repair.find((step) => step.kind === 'repair_retest')
    assert.ok(retest, 'a different question of the same node should be scheduled')
    assert.ok(retest.session_item_id, 'the retest is backed by a real practice item')
  } finally {
    s.close()
  }
})

test('hint: no model means a deterministic card hint that is recorded as exposure', async () => {
  const s = studyStore()
  try {
    addConfirmedCard(s, s.nodeIds[0], [
      { id: 'kp1', text: '极限的 ε-δ 定义', required: true },
      { id: 'kp2', text: '适用条件：函数在去心邻域有定义', required: true },
    ])
    addKnowledgeState(s, s.nodeIds[0], 'independent')
    const session = createInteractionSession(
      s.db,
      s.userId,
      s.projectId,
      { subject_id: s.subjectId, mode: 'daily', budget_minutes: 40 },
      NOW,
    )
    startInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    skipUntil(s, session.session_id, 'practice')
    const practice = getInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW).steps.find(
      (step) => step.kind === 'practice',
    )
    assert.ok(practice)
    activateStep(s.db, s.userId, s.projectId, session.session_id, practice.ordinal, NOW)
    const hint = await requestStepHint(
      s.db,
      s.userId,
      s.projectId,
      session.session_id,
      practice.ordinal,
      { level: 2 },
      NOW,
    )
    assert.equal(hint.model_used, false)
    assert.ok(hint.blocks.length > 0)
    assert.equal(hint.reveals_answer, false)
    assert.match(hint.fallback_note, /AI 未配置/)
    const exposure = findRows(s.db, 'practice_exposure_event', { question_id: practice.question_id }).filter(
      (row) => String(row.kind) === 'hint_delivered',
    )
    assert.equal(exposure.length, 1)
    assert.equal(exposure[0].reveals_answer, false)
    const refreshed = getInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    assert.equal(refreshed.steps.find((step) => step.ordinal === practice.ordinal)?.hint_level, 2)
  } finally {
    s.close()
  }
})

test('finish: open steps must be resolved and the summary reports real facts', () => {
  const s = studyStore()
  try {
    dueMemory(s, s.nodeIds[0])
    const session = createInteractionSession(
      s.db,
      s.userId,
      s.projectId,
      { subject_id: s.subjectId, mode: 'daily', budget_minutes: 30 },
      NOW,
    )
    startInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    for (const step of session.steps) {
      skipStep(s.db, s.userId, s.projectId, session.session_id, step.ordinal, { reason: '测试结束' }, NOW)
    }
    const finished = finishInteractionSession(s.db, s.userId, s.projectId, session.session_id, NOW)
    assert.equal(finished.status, 'completed')
    assert.ok(finished.summary)
    assert.equal(finished.summary?.steps_total, session.steps.length)
    assert.equal(finished.summary?.steps_skipped, session.steps.length)
    assert.ok(Array.isArray(finished.summary?.calibration === undefined ? [] : [finished.summary?.calibration]))
  } finally {
    s.close()
  }
})

test('desk: due memory, value nodes and honest coverage numbers', () => {
  const s = studyStore()
  try {
    dueMemory(s, s.nodeIds[0])
    addKnowledgeState(s, s.nodeIds[1], 'independent')
    const desk = studyDesk(s.db, s.userId, s.projectId, s.subjectId, NOW)
    assert.equal(desk.project_id, s.projectId)
    assert.equal(desk.subject_id, s.subjectId)
    assert.ok(desk.due_memory.some((row) => row.node_id === s.nodeIds[0]))
    const value = desk.value_nodes.find((row) => row.node_id === s.nodeIds[0])
    assert.ok(value)
    assert.ok(value.value_index !== null && value.value_index > 0.3)
    assert.equal(desk.coverage.nodes_total, 3)
    assert.ok(desk.coverage.nodes_with_memory >= 1)
    assert.equal(desk.coverage.nodes_due, 1)
    assert.ok(desk.notes.length > 0)
  } finally {
    s.close()
  }
})
