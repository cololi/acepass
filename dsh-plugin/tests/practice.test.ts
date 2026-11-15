import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { mergedRule, submitAttempt, trustBlocker, validateAnswerShape } from '../src/services/practice.ts'
import { AlreadySubmitted, InvalidInput, StructureInvalid, VersionConflict } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-09-01T00:00:00+00:00')
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

function seeded(options: { mode?: string; status?: string; deadline?: bigint | null; disputed?: boolean } = {}) {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'p@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)

  const question = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', { subject_id: subject.id, origin_type: 'import', is_demo: false, display_label: '' }),
    { now: NOW },
  )
  const version = insertRow(
    db,
    'question_bank_question_version',
    completeRow('question_bank_question_version', {
      question_id: question.id,
      version: 1,
      question_type: 'single_choice',
      status: 'published',
      content: CONTENT,
    }),
    { now: NOW },
  )
  const answer = insertRow(
    db,
    'question_bank_answer_key_version',
    completeRow('question_bank_answer_key_version', {
      question_version_id: version.id,
      version: 1,
      verification_status: 'checked',
      is_disputed: options.disputed === true,
      answer_payload: { kind: 'single_choice', correct_option_id: 'opt_b' },
      check_basis: '教材',
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
      mode: options.mode ?? 'practice',
      status: options.status ?? 'active',
      exam_deadline: options.deadline ?? null,
      note: 'purpose=practice',
    }),
    { now: NOW },
  )
  const item = insertRow(
    db,
    'practice_session_item',
    completeRow('practice_session_item', {
      session_id: session.id,
      question_version_id: version.id,
      answer_key_version_id: answer.id,
      spec_version_id: null,
      rubric_version_id: null,
      max_score: '2.00',
      ordinal: 1,
      first_delivered_at: NOW - 30_000_000n, // 30 seconds earlier
      purpose: 'practice',
      mapping_revision: 1,
    }),
    { now: NOW },
  )
  return { db, close: handle.close, userId, itemId: String(item.id), sessionId: String(session.id) }
}

test('practice: a correct answer is graded deterministically and stored with its rule snapshot', () => {
  const s = seeded()
  try {
    const result = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    assert.equal(result.grade.status, 'confirmed')
    assert.equal(result.grade.confirmed_score, '2.00')
    assert.equal(result.grade.is_fully_confirmed, true)
    assert.equal(result.attempt.grading_revision, 1)
    assert.equal(result.attempt.elapsed_ms, 30_000, 'elapsed time comes from the first presentation')
    const snapshot = result.grade.rule_snapshot as Record<string, unknown>
    assert.equal(snapshot.question_type, 'single_choice')
    assert.equal(snapshot.max_score, '2.00')
  } finally {
    s.close()
  }
})

test('practice: a wrong answer is a confirmed zero, not a pending review', () => {
  const s = seeded()
  try {
    const result = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_a' } },
      NOW,
    )
    assert.equal(result.grade.status, 'confirmed')
    assert.equal(result.grade.confirmed_score, '0.00')
    assert.equal(result.grade.is_fully_confirmed, true)
  } finally {
    s.close()
  }
})

test('practice: a second submission for the same item is refused, never overwritten', () => {
  const s = seeded()
  try {
    submitAttempt(s.db, s.userId, s.itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } }, NOW)
    assert.throws(
      () =>
        submitAttempt(s.db, s.userId, s.itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_a' } }, NOW),
      (error: unknown) => {
        assert.ok(error instanceof AlreadySubmitted)
        assert.equal(error.statusCode, 409)
        return true
      },
    )
    assert.equal(findRows(s.db, 'practice_attempt', {}).length, 1, 'the first answer stands')
  } finally {
    s.close()
  }
})

test('practice: a finished session refuses new submissions', () => {
  const s = seeded({ status: 'finished' })
  try {
    assert.throws(
      () => submitAttempt(s.db, s.userId, s.itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } }, NOW),
      (error: unknown) => error instanceof InvalidInput && error.message === '会话已结束，不能继续提交',
    )
  } finally {
    s.close()
  }
})

test('practice: an overdue exam is refused as a deadline (409), not as "session over"', () => {
  const s = seeded({ mode: 'mock_exam', deadline: NOW - 1_000_000n })
  try {
    assert.throws(
      () => submitAttempt(s.db, s.userId, s.itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } }, NOW),
      (error: unknown) => {
        assert.ok(error instanceof VersionConflict)
        assert.equal(error.details.reason, 'exam_deadline_passed')
        assert.equal(error.details.session_id, s.sessionId)
        return true
      },
    )
  } finally {
    s.close()
  }
})

test('practice: a disputed answer version sends the submission to review but keeps the answer', () => {
  const s = seeded({ disputed: true })
  try {
    const result = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    assert.equal(result.grade.status, 'pending_review', 'a disputed answer must not award a score')
    assert.equal(result.grade.confirmed_score, null)
    assert.equal((result.attempt.raw_answer as Record<string, unknown>).selected_option_id, 'opt_b', 'the raw answer is still stored')
    assert.match(String((result.grade.rule_snapshot as Record<string, unknown>).reason), /转人工复核/)
  } finally {
    s.close()
  }
})

test('practice: the submission enqueues exactly one evidence rebuild', () => {
  const s = seeded()
  try {
    const result = submitAttempt(
      s.db,
      s.userId,
      s.itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW,
    )
    const events = findRows(s.db, 'audit_outbox_event', { topic: 'evidence.rebuild_for_attempt' })
    assert.equal(events.length, 1)
    assert.deepEqual(events[0].payload, { attempt_id: String(result.attempt.id) })
    assert.equal(events[0].status, 'pending')
  } finally {
    s.close()
  }
})

test('practice: shape validation matches the presented question', () => {
  assert.throws(() => validateAnswerShape('single_choice', CONTENT, 'not an object'), StructureInvalid)
  assert.throws(
    () => validateAnswerShape('single_choice', CONTENT, { type: 'true_false', value: true }),
    /作答类型与题目类型不一致/,
  )
  assert.throws(
    () => validateAnswerShape('single_choice', CONTENT, { type: 'single_choice', selected_option_id: 'opt_z' }),
    /提交了不属于该题的选项 ID/,
  )
  assert.throws(
    () => validateAnswerShape('single_choice', CONTENT, { type: 'single_choice', selected_option_ids: ['opt_a', 'opt_b'] }),
    /单选题只能选择一个选项/,
  )
  assert.throws(
    () => validateAnswerShape('single_choice', CONTENT, { type: 'single_choice', selected_option_ids: ['opt_a', 'opt_a'] }),
    /同一选项被重复提交/,
  )
  assert.throws(
    () => validateAnswerShape('true_false', {}, { type: 'true_false', value: 'false' }),
    /判断题作答必须是 true\/false/,
  )
  // An empty answer is allowed everywhere: "not answered" is a state, not an error.
  assert.doesNotThrow(() => validateAnswerShape('single_choice', CONTENT, { type: 'single_choice' }))
})

test('practice: mergedRule lets the answer override the spec, and only for known keys', () => {
  const spec = { question_type_rules: { multiple_choice: { policy: 'exact_match', wrong_score: '-1' } } }
  const merged = mergedRule(spec, { policy: 'partial_credit', partial_score: '1.5', junk: 'ignored' }, 'multiple_choice')
  assert.equal(merged.policy, 'partial_credit', 'the answer-level rule wins')
  assert.equal(merged.wrong_score, '-1', 'spec defaults survive')
  assert.equal(merged.junk, undefined, 'unknown keys are not copied')
})

test('practice: trustBlocker names the reason and clears when the answer is repaired', () => {
  const s = seeded()
  try {
    const item = findRows(s.db, 'practice_session_item', {})[0]
    assert.equal(trustBlocker(s.db, item), null)
    const answerId = String(item.answer_key_version_id)
    updateRow(s.db, 'question_bank_answer_key_version', answerId, { is_disputed: true }, { now: NOW })
    assert.match(String(trustBlocker(s.db, item)), /固定答案已进入争议/)
    updateRow(s.db, 'question_bank_answer_key_version', answerId, { is_disputed: false, verification_status: 'pending' }, { now: NOW })
    assert.match(String(trustBlocker(s.db, item)), /失去可信状态/)
  } finally {
    s.close()
  }
})
