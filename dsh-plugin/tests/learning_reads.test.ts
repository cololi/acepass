import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { drain } from '../src/jobs/worker.ts'
import {
  evidenceSummaryRows,
  getAttempt,
  getSession,
  listMistakes,
  listStates,
  verificationContentMap,
} from '../src/services/learning.ts'
import { ScopeViolation } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2027-04-01T00:00:00+00:00')
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
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'l@example.com', date_joined: NOW }), {
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

  const makeQuestion = (label: string, correct = 'b', familyId: string | null = null) => {
    const question = insertRow(
      db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subject.id,
        origin_type: 'import',
        is_demo: false,
        display_label: label,
        family_id: familyId,
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
    insertRow(
      db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: draft.id,
        version: 1,
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: correct },
        check_basis: '教材',
      }),
      { now: NOW },
    )
    publishQuestionVersion(db, userId, projectId, String(draft.id), { allowWithoutScore: true, now: NOW })
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
    return { questionId: String(question.id), versionId: String(draft.id) }
  }

  /** Present, answer and grade one question through the real path. */
  const answer = (questionId: string, selected: string, mode = 'practice') => {
    const session = createSession(db, userId, projectId, {
      subject_id: String(subject.id),
      question_ids: [questionId],
      mode,
      duration_minutes: mode === 'mock_exam' ? 60 : null,
    }, NOW)
    const item = findRows(db, 'practice_session_item', { session_id: String(session.id) })[0]
    presentItem(db, userId, String(item.id), NOW)
    const submitted = submitAttempt(db, userId, String(item.id), {
      raw_answer: { type: 'single_choice', selected_option_id: selected },
    }, NOW + 5_000_000n)
    drain(db, NOW + 5_000_000n)
    return { sessionId: String(session.id), itemId: String(item.id), attemptId: String(submitted.attempt.id) }
  }

  return { db, close: handle.close, userId, projectId, subjectId: String(subject.id), nodeId: String(node.id), makeQuestion, answer }
}

test('learning reads: evidence and state come back with their missing pieces', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    s.answer(q.questionId, 'b')

    const evidence = evidenceSummaryRows(s.db, s.userId, s.projectId)
    assert.equal(evidence.length, 6, 'six dimensions per attempt')
    assert.ok(evidence.every((row) => row.node_id === s.nodeId))
    assert.equal(evidence.find((row) => row.dimension === 'independent_correct')?.qualifies, true)

    const states = listStates(s.db, s.userId, s.projectId)
    assert.equal(states.states.length, 1)
    assert.equal(states.states[0].summary, 'independent')
    assert.equal(states.states[0].evidence.length, 6, 'the state carries the evidence that produced it')
    assert.equal(states.thresholds.distinct_questions, 2)
    assert.ok((states.states[0].detail.missing_evidence as string[]).length > 0)
  } finally {
    s.close()
  }
})

test('learning reads: a wrong answer becomes a confirmed mistake', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    s.answer(q.questionId, 'a')
    const mistakes = listMistakes(s.db, s.userId, s.projectId)
    assert.equal(mistakes.count, 1)
    assert.equal(mistakes.rows[0].confirmed_score, '0.00')
    assert.equal(mistakes.rows[0].max_score, '2.00')
    assert.deepEqual(mistakes.rows[0].node_ids, [s.nodeId])
  } finally {
    s.close()
  }
})

test('learning reads: a correct answer is not a mistake', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    s.answer(q.questionId, 'b')
    assert.equal(listMistakes(s.db, s.userId, s.projectId).count, 0)
  } finally {
    s.close()
  }
})

test('learning reads: a running verification hides its content from evidence and mistakes', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    s.answer(q.questionId, 'a')
    assert.equal(listMistakes(s.db, s.userId, s.projectId).count, 1)

    const evidenceBefore = evidenceSummaryRows(s.db, s.userId, s.projectId)
    assert.equal(evidenceBefore.length, 6, 'the practice attempt has its evidence before the check')

    // A verification on the same question starts: its content must vanish from every projection.
    s.answer(q.questionId, 'a', 'verification')
    assert.equal(verificationContentMap(s.db, s.userId).size > 0, true)
    const evidenceAfter = evidenceSummaryRows(s.db, s.userId, s.projectId)
    // Only the verification item keeps rows: six, not twelve.
    assert.equal(evidenceAfter.length, 6, 'the practice evidence must be hidden while the check runs')
    assert.equal(
      evidenceAfter.every((row) => row.attempt_id !== evidenceBefore[0].attempt_id),
      true,
      'not one hidden practice row may survive',
    )
    assert.equal(
      listMistakes(s.db, s.userId, s.projectId).count,
      1,
      'only the verification own item stays visible; the practice answer is hidden',
    )
  } finally {
    s.close()
  }
})

test('learning reads: the verification content gate covers twins, not just the same question', () => {
  const s = seeded()
  try {
    const family = insertRow(
      s.db,
      'question_bank_family',
      completeRow('question_bank_family', { subject_id: s.subjectId, name: '家族', note: '', relation_confirmed: true, revision: 1 }),
      { now: NOW },
    )
    const original = s.makeQuestion('原题', 'b', String(family.id))
    const twin = s.makeQuestion('孪生题', 'b', String(family.id))
    s.answer(twin.questionId, 'a', 'verification')

    const map = verificationContentMap(s.db, s.userId)
    assert.equal(map.has(original.versionId), true, 'a family twin must be covered too, or the check leaks')
    // The twin's own practice answer is hidden, but the verification keeps its own item visible —
    // the gate must never hide a check from the person taking it.
    const mistakes = listMistakes(s.db, s.userId, s.projectId)
    assert.equal(mistakes.count, 1)
    assert.equal(mistakes.rows[0].question_label, '孪生题', 'only the verification item remains')
  } finally {
    s.close()
  }
})

test('learning reads: session detail reports delivery and submission per item', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    const answered = s.answer(q.questionId, 'b')
    const session = getSession(s.db, s.userId, s.projectId, answered.sessionId, NOW)
    const items = session.items as Record<string, unknown>[]
    assert.equal(items.length, 1)
    // Django's SessionItemOut has no derived `delivered`/`submitted` booleans: delivery is the
    // first_delivered_at stamp and submission is the stable attempt id.
    assert.notEqual(items[0].first_delivered_at, null)
    assert.notEqual(items[0].attempt_id, null)
    assert.equal(items[0].attempt_id, answered.attemptId)

    const q2 = s.makeQuestion('Q2')
    const session2 = createSession(s.db, s.userId, s.projectId, {
      subject_id: s.subjectId,
      question_ids: [q2.questionId],
    }, NOW)
    const fresh = getSession(s.db, s.userId, s.projectId, String(session2.id), NOW)
    assert.equal(
      (fresh.items as Record<string, unknown>[])[0].first_delivered_at,
      null,
      'nothing delivered yet',
    )
  } finally {
    s.close()
  }
})

test('learning reads: attempt detail carries the grade and its rule snapshot', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    const answered = s.answer(q.questionId, 'b')
    const detail = getAttempt(s.db, s.userId, s.projectId, answered.attemptId, NOW)
    const grade = detail.grade as Record<string, unknown>
    assert.equal(grade.status, 'confirmed')
    assert.equal(grade.confirmed_score, '2.00')
    assert.equal(grade.superseded, false)
    assert.equal((detail.raw_answer as Record<string, unknown>).selected_option_id, 'b')
    assert.equal(detail.elapsed_ms, 5000)
  } finally {
    s.close()
  }
})

test('learning reads: another project cannot read the session or the attempt', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    const answered = s.answer(q.questionId, 'b')
    const other = createProject(s.db, s.userId, { name: 'Other' }, NOW)
    assert.throws(
      () => getSession(s.db, s.userId, String(other.id), answered.sessionId, NOW),
      ScopeViolation,
    )
    assert.throws(
      () => getAttempt(s.db, s.userId, String(other.id), answered.attemptId, NOW),
      ScopeViolation,
    )
  } finally {
    s.close()
  }
})

test('learning reads: a pending review is not reported as a mistake', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    const answered = s.answer(q.questionId, 'a')
    updateRow(s.db, 'practice_grade_event', String(findRows(s.db, 'practice_grade_event', { attempt_id: answered.attemptId })[0].id), {
      is_fully_confirmed: false,
      status: 'pending_review',
    }, { now: NOW })
    assert.equal(listMistakes(s.db, s.userId, s.projectId).count, 0, 'only a decided grade can be a lost mark')
  } finally {
    s.close()
  }
})

test('learning reads: the session snapshot is the Django SessionOut, not the raw row', () => {
  const s = seeded()
  try {
    const q = s.makeQuestion('Q1')
    const answered = s.answer(q.questionId, 'b')
    const session = getSession(s.db, s.userId, s.projectId, answered.sessionId, NOW)
    // The create-session route answers with this same serializer. A raw row would carry `id`
    // instead of `session_id`, and the client would navigate to `/practice-sessions/undefined`.
    assert.equal(session.session_id, answered.sessionId)
    assert.equal(session.id, undefined)
    assert.equal(typeof session.server_time, 'string')
    assert.equal(typeof session.policy_version, 'string')
    assert.equal(session.score_visible, true)
    assert.equal(session.confirmed_score, '2.00')
    const items = session.items as Record<string, unknown>[]
    assert.equal(items[0].session_item_id, answered.itemId ?? items[0].session_item_id)
    assert.equal(items[0].question_type, 'single_choice')
    const attempt = items[0].attempt as Record<string, unknown>
    const grade = attempt.grade as Record<string, unknown>
    assert.equal(grade.confirmed_score, '2.00')
    assert.equal(grade.is_correct, true)
    assert.equal(attempt.receipt_only, false)
  } finally {
    s.close()
  }
})
