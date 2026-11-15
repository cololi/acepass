/**
 * HTTP black box for B8's memory cards: create, list, review, logs, rebuild, suspend/resume.
 *
 * The review endpoint is where the honesty rule is easiest to break, so the last test counts the
 * tables a review must *not* touch (`practice_attempt`, `practice_grade_event`,
 * `practice_learning_evidence`, `learning_knowledge_state`) before and after two real reviews. That
 * count is the executable form of "记住一张卡不是解题能力".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPythonIso, parseInstant, type Instant } from '../src/domain/instant.ts'
import { DEFAULT_DESIRED_RETENTION, FSRS_VERSION, schedule, weightsFor, type CardState } from '../src/domain/fsrs.ts'
import { readFileSync } from 'node:fs'
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
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'

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
    completeRow('accounts_user', { email: 'mem@example.com', display_name: '记忆', date_joined: NOW }),
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
    options: { body?: unknown; key?: string | null } = {},
  ): Promise<{ status: number; body: any }> => {
    counter += 1
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (method !== 'GET') {
      const key = options.key === undefined ? `m-${counter}` : options.key
      if (key !== null) headers['idempotency-key'] = key
    }
    const response = await handler(
      new Request(`${BASE}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    )
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

function seedQuestion(
  db: DatabaseSync,
  userId: string,
  options: { projectName: string; now: Instant; nodeName: string; stem: string },
): { projectId: string; subjectId: string; nodeId: string; questionId: string } {
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
  const question = createQuestion(db, userId, { subjectId, displayLabel: '记忆-1' }, now)
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
      revisionReason: 'b8-memory',
    },
    now,
  )
  createAnswerKeyVersion(
    db,
    userId,
    projectId,
    String(version.id),
    {
      answerPayload: { kind: 'true_false', value: true },
      sourceType: 'user',
      verificationStatus: 'checked',
      checkBasis: 'b8 memory 测试',
    },
    now,
  )
  replaceKnowledgeMappings(
    db,
    projectId,
    String(version.id),
    [{ node_id: String(node.id), is_primary: true, score_weight: '1' }],
    { actorId: userId, now },
  )
  publishQuestionVersion(db, userId, projectId, String(version.id), { now })
  return { projectId, subjectId, nodeId: String(node.id), questionId }
}

test('memory cards: create is idempotent per question and the payload is memory state only', async () => {
  const h = harness()
  try {
    const seed = seedQuestion(h.db, h.user, {
      projectName: '记忆项目',
      now: NOW,
      nodeName: '记忆考点',
      stem: '验收判断：记忆卡题干。',
    })

    const created = await h.call('POST', `/projects/${seed.projectId}/memory-cards`, {
      body: { question_id: seed.questionId },
    })
    assert.equal(created.status, 201)
    for (const field of [
      'card_id',
      'project_id',
      'subject_id',
      'question_id',
      'question_label',
      'stem_excerpt',
      'knowledge_node_id',
      'knowledge_node_name',
      'phase',
      'due_at',
      'last_reviewed_at',
      'stability',
      'difficulty',
      'retrievability',
      'reps',
      'lapses',
      'learning_step',
      'is_suspended',
      'suspended_reason',
      'scheduler_version',
      'params_version',
      'desired_retention',
    ]) {
      assert.ok(field in created.body, `card.${field} must exist`)
    }
    assert.equal(created.body.question_id, seed.questionId)
    assert.equal(created.body.phase, 'new')
    assert.equal(created.body.knowledge_node_name, '记忆考点')
    assert.equal(created.body.stem_excerpt, '验收判断：记忆卡题干。')
    assert.equal(created.body.reps, 0)
    // A brand-new card has no memory state: `null`, never a fabricated 1.0.
    assert.equal(created.body.retrievability, null)
    assert.equal(created.body.last_reviewed_at, null)
    assert.equal(created.body.due_at, '2026-08-01T00:00:00+00:00')

    // The same question again reuses the card (200, same id) instead of creating a second one.
    const again = await h.call('POST', `/projects/${seed.projectId}/memory-cards`, {
      body: { question_id: seed.questionId },
    })
    assert.equal(again.status, 200)
    assert.equal(again.body.card_id, created.body.card_id)
    assert.equal(countRows(h.db, 'memory_card', { question_id: seed.questionId }), 1)

    // A missing question_id is a validation error, and a foreign question is a 404.
    const missing = await h.call('POST', `/projects/${seed.projectId}/memory-cards`, { body: {} })
    assert.equal(missing.status, 400)
    const foreign = await h.call('POST', `/projects/${seed.projectId}/memory-cards`, {
      body: { question_id: 'not-a-question' },
    })
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error.message, '题目不存在或不属于该项目')

    const listed = await h.call('GET', `/projects/${seed.projectId}/memory-cards`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.length, 1)
    const unknownProject = await h.call('GET', '/projects/missing/memory-cards')
    assert.equal(unknownProject.status, 404)
  } finally {
    h.close()
  }
})

test('memory review: one log per key, a real FSRS schedule, and no solving evidence', async () => {
  const h = harness()
  try {
    const seed = seedQuestion(h.db, h.user, {
      projectName: '复习项目',
      now: NOW,
      nodeName: '复习考点',
      stem: '验收判断：复习题干。',
    })
    const created = await h.call('POST', `/projects/${seed.projectId}/memory-cards`, {
      body: { question_id: seed.questionId },
    })
    const cardId = created.body.card_id

    const before = {
      attempts: countRows(h.db, 'practice_attempt'),
      grades: countRows(h.db, 'practice_grade_event'),
      evidence: countRows(h.db, 'practice_learning_evidence'),
      states: countRows(h.db, 'learning_knowledge_state'),
    }

    const reviewed = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'good' },
      key: 'review-1',
    })
    assert.equal(reviewed.status, 200)
    for (const field of [
      'card_id',
      'log_id',
      'rating',
      'phase',
      'phase_before',
      'due_at',
      'reviewed_at',
      'interval_days',
      'elapsed_days',
      'scheduled_days',
      'retrievability',
      'stability',
      'difficulty',
      'is_lapse',
      'reps',
      'lapses',
      'scheduler_version',
      'params_version',
    ]) {
      assert.ok(field in reviewed.body, `review.${field} must exist`)
    }
    assert.equal(reviewed.body.rating, 'good')
    assert.equal(reviewed.body.phase_before, 'new')
    assert.equal(reviewed.body.reps, 1)
    assert.equal(reviewed.body.is_lapse, false)
    assert.equal(reviewed.body.idempotent_replay, false)
    // FSRS-4.5 short steps: `good` on a brand-new card advances one step (10 minutes), it does not
    // jump straight to a day-long interval. The exact seconds are pinned, not "approximately right".
    assert.equal(reviewed.body.phase, 'learning')
    assert.ok(Math.abs(reviewed.body.interval_days - 10 / 1440) < 1e-12, `interval=${reviewed.body.interval_days}`)
    assert.ok(reviewed.body.due_at > reviewed.body.reviewed_at)
    assert.equal(reviewed.body.scheduled_days, 0)

    // The card projection reads back through the same schedule: immediately after a review the
    // modelled recall is ~1, and the interval it is waiting out is the one that was just scheduled.
    const listedAfter = await h.call('GET', `/projects/${seed.projectId}/memory-cards`)
    assert.equal(listedAfter.status, 200)
    assert.ok(listedAfter.body[0].retrievability > 0.9, `retrievability=${listedAfter.body[0].retrievability}`)
    assert.equal(listedAfter.body[0].last_reviewed_at, reviewed.body.reviewed_at)

    // Replaying the key returns the stored log, not a second schedule.
    const replay = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'good' },
      key: 'review-1',
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.log_id, reviewed.body.log_id)
    assert.equal(replay.body.idempotent_replay, true)
    assert.equal(countRows(h.db, 'memory_review_log', { card_id: cardId }), 1)

    // Same key, different rating is a conflict that names the stored rating.
    const conflict = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'again' },
      key: 'review-1',
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'idempotency_conflict')
    assert.equal(conflict.body.error.message, '相同幂等键使用了不同的评级')
    assert.equal(conflict.body.error.details.stored_rating, 'good')

    // Missing key is Django's IdempotencyConflict (409); an unknown rating is a 400.
    const keyless = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'good' },
      key: null,
    })
    assert.equal(keyless.status, 409)
    assert.equal(keyless.body.error.code, 'idempotency_conflict')
    assert.equal(keyless.body.error.message, '缺少 Idempotency-Key 请求头')
    const badRating = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'perfect' },
    })
    assert.equal(badRating.status, 400)
    assert.match(badRating.body.error.message, /未知的记忆评级/)

    // A second review on a later day appends a log and moves the schedule.
    h.setNow(parseInstant('2026-08-05T00:00:00+00:00'))
    const second = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'again' },
      key: 'review-2',
    })
    assert.equal(second.status, 200)
    assert.ok(second.body.interval_days > 0)
    assert.equal(second.body.reps, 2)
    assert.equal(second.body.elapsed_days > 0, true)

    const logs = await h.call('GET', `/projects/${seed.projectId}/memory-cards/${cardId}/logs`)
    assert.equal(logs.status, 200)
    assert.equal(logs.body.length, 2)
    // Newest first, and every ledger field is present.
    assert.equal(logs.body[0].log_id, second.body.log_id)
    for (const field of [
      'log_id',
      'card_id',
      'rating',
      'reviewed_at',
      'elapsed_days',
      'scheduled_days',
      'interval_days',
      'retrievability',
      'is_lapse',
      'phase_before',
      'phase_after',
      'stability_before',
      'stability_after',
      'difficulty_before',
      'difficulty_after',
      'due_before',
      'due_after',
      'scheduler_version',
      'params_version',
      'source_session_item_id',
      'note',
    ]) {
      assert.ok(field in logs.body[0], `log.${field} must exist`)
    }
    const limited = await h.call('GET', `/projects/${seed.projectId}/memory-cards/${cardId}/logs?limit=1`)
    assert.equal(limited.body.length, 1)

    // The honesty rule, counted: reviewing a card writes no attempt, grade, evidence or state.
    assert.deepEqual(
      {
        attempts: countRows(h.db, 'practice_attempt'),
        grades: countRows(h.db, 'practice_grade_event'),
        evidence: countRows(h.db, 'practice_learning_evidence'),
        states: countRows(h.db, 'learning_knowledge_state'),
      },
      before,
    )
  } finally {
    h.close()
  }
})

test('memory rebuild: replaying the logs detects a hand-edited card', async () => {
  const h = harness()
  try {
    const seed = seedQuestion(h.db, h.user, {
      projectName: '重建项目',
      now: NOW,
      nodeName: '重建考点',
      stem: '验收判断：重建题干。',
    })
    const created = await h.call('POST', `/projects/${seed.projectId}/memory-cards`, {
      body: { question_id: seed.questionId },
    })
    const cardId = created.body.card_id
    await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'good' },
      key: 'rebuild-review',
    })

    const clean = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/rebuild`)
    assert.equal(clean.status, 200)
    assert.equal(clean.body.matches, true)
    assert.equal(clean.body.log_count, 1)
    assert.deepEqual(clean.body.differing_fields, [])
    assert.deepEqual(clean.body.unknown_params_versions, [])
    assert.ok(clean.body.compared_fields.includes('due_at'))
    assert.ok(clean.body.rebuilt)
    assert.ok(clean.body.stored)
    assert.equal(clean.body.rebuilt.due_at, clean.body.stored.due_at)

    // A row edited by hand must be *detected*, not trusted: the logs are the ledger.
    updateRow(h.db, 'memory_card', cardId, { due_at: parseInstant('2030-01-01T00:00:00+00:00') }, { now: NOW })
    const tampered = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/rebuild`)
    assert.equal(tampered.status, 200)
    assert.equal(tampered.body.matches, false)
    assert.deepEqual(tampered.body.differing_fields, ['due_at'])
    // Nothing was written by the check, so the edit is still there to be recovered from.
    assert.equal(
      findRows(h.db, 'memory_card', { id: cardId })[0].due_at,
      parseInstant('2030-01-01T00:00:00+00:00'),
    )
  } finally {
    h.close()
  }
})

test('memory suspend/resume: a paused card is hidden, un-reviewable and keeps its schedule', async () => {
  const h = harness()
  try {
    const seed = seedQuestion(h.db, h.user, {
      projectName: '暂停项目',
      now: NOW,
      nodeName: '暂停考点',
      stem: '验收判断：暂停题干。',
    })
    const created = await h.call('POST', `/projects/${seed.projectId}/memory-cards`, {
      body: { question_id: seed.questionId },
    })
    const cardId = created.body.card_id
    const reviewed = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'good' },
      key: 'suspend-review',
    })

    const suspended = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/suspend`, {
      body: { reason: '换教材，先停' },
    })
    assert.equal(suspended.status, 200)
    assert.equal(suspended.body.is_suspended, true)
    assert.equal(suspended.body.suspended_reason, '换教材，先停')
    // The schedule is untouched by suspension.
    assert.equal(suspended.body.due_at, reviewed.body.due_at)
    assert.equal(suspended.body.reps, 1)

    const hidden = await h.call('GET', `/projects/${seed.projectId}/memory-cards`)
    assert.deepEqual(hidden.body, [])
    const included = await h.call('GET', `/projects/${seed.projectId}/memory-cards?include_suspended=true`)
    assert.equal(included.body.length, 1)

    const refused = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/review`, {
      body: { rating: 'good' },
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.message, '卡片已暂停，恢复后才能复习')

    const resumed = await h.call('POST', `/projects/${seed.projectId}/memory-cards/${cardId}/resume`)
    assert.equal(resumed.status, 200)
    assert.equal(resumed.body.is_suspended, false)
    assert.equal(resumed.body.suspended_reason, '')
    // Resuming never re-dates an overdue card.
    assert.equal(resumed.body.due_at, reviewed.body.due_at)

    // A card from another project (or another account) is a 404, not a 403.
    const otherSeed = seedQuestion(h.db, h.user, {
      projectName: '另一个项目',
      now: NOW,
      nodeName: '别的考点',
      stem: '验收判断：另一个项目的题干。',
    })
    const crossProject = await h.call('GET', `/projects/${otherSeed.projectId}/memory-cards/${cardId}/logs`)
    assert.equal(crossProject.status, 404)
    assert.equal(crossProject.body.error.message, '记忆卡不存在或不属于该项目')
    const unknown = await h.call('POST', `/projects/${seed.projectId}/memory-cards/unknown/rebuild`)
    assert.equal(unknown.status, 404)

    const otherCard = insertRow(
      h.db,
      'memory_card',
      completeRow('memory_card', {
        user_id: h.other,
        project_id: otherSeed.projectId,
        subject_id: otherSeed.subjectId,
        question_id: otherSeed.questionId,
        phase: 'new',
        due_at: NOW,
        stability: 0,
        difficulty: 0,
        desired_retention: 0.9,
        scheduler_version: 'fsrs-4.5-default-v1',
        params_version: 'fsrs-4.5-default-v1',
      }),
      { now: NOW },
    )
    const foreign = await h.call('GET', `/projects/${otherSeed.projectId}/memory-cards/${String(otherCard.id)}/logs`)
    assert.equal(foreign.status, 404)
  } finally {
    h.close()
  }
})

/** Real Django output (`scripts/gen_b8_learning_golden.py`), regenerated per release. */
const GOLDEN = JSON.parse(readFileSync(new URL('./golden/b8_learning.json', import.meta.url), 'utf8'))

test('golden vectors: replaying one card through FSRS matches the real Django schedule', () => {
  const expected = GOLDEN.memory
  assert.equal(expected.card.params_version, FSRS_VERSION)
  assert.equal(expected.card.desired_retention, DEFAULT_DESIRED_RETENTION)

  let state: CardState = {
    stability: 0,
    difficulty: 0,
    phase: 'new',
    reps: 0,
    lapses: 0,
    learningStep: 0,
    lastReviewedAt: null,
    dueAt: parseInstant('2026-03-01T09:00:00+00:00'),
    scheduledDays: 0,
    elapsedDays: 0,
  }
  for (const review of expected.reviews as Array<Record<string, any>>) {
    // `card_state` re-derives `scheduled_days` from `due_at - last_reviewed_at` before each review.
    if (state.dueAt !== null && state.lastReviewedAt !== null) {
      state = { ...state, scheduledDays: Math.max(0, Number(state.dueAt - state.lastReviewedAt) / 86_400_000_000) }
    }
    const result = schedule(state, review.rating, parseInstant(review.reviewed_at), {
      weights: weightsFor(expected.card.params_version),
      desiredRetention: expected.card.desired_retention,
    })
    assert.equal(review.phase_before, state.phase)
    assert.equal(review.phase, result.phaseAfter)
    assert.equal(review.due_at, formatPythonIso(result.state.dueAt!))
    assert.equal(review.reviewed_at, formatPythonIso(result.state.lastReviewedAt!))
    assert.equal(review.interval_days, result.intervalDays)
    assert.equal(review.elapsed_days, result.elapsedDays)
    assert.equal(review.scheduled_days, state.scheduledDays)
    assert.equal(review.retrievability, result.retrievability)
    assert.equal(review.stability, result.state.stability)
    assert.equal(review.difficulty, result.state.difficulty)
    assert.equal(review.is_lapse, result.isLapse)
    assert.equal(review.reps, result.state.reps)
    assert.equal(review.lapses, result.state.lapses)
    state = result.state
  }

  // The card row after the three reviews, and the rebuild report that replays the same logs.
  assert.equal(expected.card.phase, state.phase)
  assert.equal(expected.card.reps, state.reps)
  assert.equal(expected.card.lapses, state.lapses)
  assert.equal(expected.card.learning_step, state.learningStep)
  assert.equal(expected.rebuild.matches, true)
  assert.equal(expected.rebuild.log_count, expected.reviews.length)
  assert.deepEqual(expected.rebuild.differing_fields, [])
  assert.equal(expected.rebuild.rebuilt.phase, state.phase)
  assert.equal(expected.rebuild.rebuilt.reps, state.reps)
  assert.equal(expected.rebuild.rebuilt.learning_step, state.learningStep)
  assert.equal(expected.rebuild.rebuilt.due_at, formatPythonIso(state.dueAt!))
  assert.equal(expected.rebuild.rebuilt.last_reviewed_at, formatPythonIso(state.lastReviewedAt!))
  assert.equal(expected.rebuild.rebuilt.stability, state.stability)
  assert.equal(expected.rebuild.rebuilt.difficulty, state.difficulty)
})
