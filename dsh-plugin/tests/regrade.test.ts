import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { regradeAttempt } from '../src/services/regrade.ts'
import { drain } from '../src/jobs/worker.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-12-01T00:00:00+00:00')
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

function seeded(correctOption = 'opt_a') {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'r@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)
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
      answer_payload: { kind: 'single_choice', correct_option_id: correctOption },
      check_basis: '教材',
    }),
    { now: NOW },
  )
  publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })
  // Evidence rows are per knowledge node, so the question needs a mapping for the drills to have
  // anything to rebuild or invalidate.
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
  const submitted = submitAttempt(
    db,
    userId,
    String(item.id),
    { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
    NOW,
  )
  // Materialise the evidence at revision 1 so the drills have something to invalidate.
  drain(db, NOW)
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    attemptId: String(submitted.attempt.id),
    answerId: String(answer.id),
    questionVersionId: String(draft.id),
  }
}

test('regrade: a newer generation re-scores and supersedes the previous grade event', () => {
  const s = seeded('opt_b')
  try {
    // The learner answered opt_b, which was wrong; a reviewed answer version now says opt_b is right.
    const result = regradeAttempt(s.db, {
      attemptId: s.attemptId,
      answerKeyVersionId: s.answerId,
      generation: 2,
      now: NOW,
    })
    assert.equal(result.stale, false)
    assert.ok(result.grade)

    // Nothing changed in the payload here, so the score is unchanged; the revision must still move.
    const attempt = findRows(s.db, 'practice_attempt', { id: s.attemptId })[0]
    assert.equal(attempt.grading_revision, 2)
    assert.equal(attempt.applied_regrade_generation, 2)
    const grades = findRows(s.db, 'practice_grade_event', { attempt_id: s.attemptId })
    assert.equal(grades.length, 2)
    const superseded = grades.filter((grade) => grade.is_superseded === true)
    assert.equal(superseded.length, 1, 'the previous revision is marked superseded, not deleted')
  } finally {
    s.close()
  }
})

test('regrade: an older generation writes nothing at all', () => {
  const s = seeded('opt_b')
  try {
    regradeAttempt(s.db, { attemptId: s.attemptId, answerKeyVersionId: s.answerId, generation: 2, now: NOW })
    const before = findRows(s.db, 'practice_grade_event', { attempt_id: s.attemptId }).length

    const stale = regradeAttempt(s.db, {
      attemptId: s.attemptId,
      answerKeyVersionId: s.answerId,
      generation: 1,
      now: NOW,
    })
    assert.equal(stale.stale, true, 'a run queued earlier must not touch a settled attempt')
    assert.equal(stale.grade, null)
    assert.equal(findRows(s.db, 'practice_grade_event', { attempt_id: s.attemptId }).length, before, 'no new grade row')
    assert.equal(findRows(s.db, 'practice_attempt', { id: s.attemptId })[0].grading_revision, 2, 'the newer revision stands')
  } finally {
    s.close()
  }
})

test('regrade: the same generation twice is stale the second time', () => {
  const s = seeded('opt_b')
  try {
    const first = regradeAttempt(s.db, { attemptId: s.attemptId, answerKeyVersionId: s.answerId, generation: 3, now: NOW })
    assert.equal(first.stale, false)
    const second = regradeAttempt(s.db, { attemptId: s.attemptId, answerKeyVersionId: s.answerId, generation: 3, now: NOW })
    assert.equal(second.stale, true, 'a generation settles an attempt exactly once')
  } finally {
    s.close()
  }
})

test('regrade: a content-version change invalidates evidence instead of rescoring', () => {
  const s = seeded('opt_b')
  try {
    // An answer version that belongs to a *different* question version cannot mechanically re-grade.
    const otherQuestion = insertRow(
      s.db,
      'question_bank_question',
      completeRow('question_bank_question', { subject_id: findRows(s.db, 'exams_subject', {})[0].id, origin_type: 'import', is_demo: false, display_label: '' }),
      { now: NOW },
    )
    const otherVersion = insertRow(
      s.db,
      'question_bank_question_version',
      completeRow('question_bank_question_version', { question_id: otherQuestion.id, version: 1, question_type: 'single_choice' }),
      { now: NOW },
    )
    const otherAnswer = insertRow(
      s.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: otherVersion.id,
        version: 1,
        verification_status: 'checked',
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
      }),
      { now: NOW },
    )

    const result = regradeAttempt(s.db, {
      attemptId: s.attemptId,
      answerKeyVersionId: String(otherAnswer.id),
      generation: 5,
      now: NOW,
    })
    assert.equal(result.stale, false)
    assert.equal(result.grade, null, 'a content change is not a re-score')
    assert.ok(result.invalidatedEvidence > 0, 'the evidence produced under the old version is invalidated')
    const active = findRows(s.db, 'practice_learning_evidence', { attempt_id: s.attemptId, is_active: true })
    assert.equal(active.length, 0)
  } finally {
    s.close()
  }
})

test('regrade: stale content-change runs invalidate no evidence', () => {
  const s = seeded('opt_b')
  try {
    const otherQuestion = insertRow(
      s.db,
      'question_bank_question',
      completeRow('question_bank_question', { subject_id: findRows(s.db, 'exams_subject', {})[0].id, origin_type: 'import', is_demo: false, display_label: '' }),
      { now: NOW },
    )
    const otherVersion = insertRow(
      s.db,
      'question_bank_question_version',
      completeRow('question_bank_question_version', { question_id: otherQuestion.id, version: 1, question_type: 'single_choice' }),
      { now: NOW },
    )
    const otherAnswer = insertRow(
      s.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: otherVersion.id,
        version: 1,
        verification_status: 'checked',
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
      }),
      { now: NOW },
    )
    // Settle the attempt at a newer generation first.
    regradeAttempt(s.db, { attemptId: s.attemptId, answerKeyVersionId: s.answerId, generation: 9, now: NOW })
    const activeBefore = findRows(s.db, 'practice_learning_evidence', { attempt_id: s.attemptId, is_active: true }).length

    const stale = regradeAttempt(s.db, {
      attemptId: s.attemptId,
      answerKeyVersionId: String(otherAnswer.id),
      generation: 4,
      now: NOW,
    })
    assert.equal(stale.stale, true)
    assert.equal(stale.invalidatedEvidence, 0, 'an old run must not erase a newer generation’s evidence')
    assert.equal(
      findRows(s.db, 'practice_learning_evidence', { attempt_id: s.attemptId, is_active: true }).length,
      activeBefore,
    )
  } finally {
    s.close()
  }
})
