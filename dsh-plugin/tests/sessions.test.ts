import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import { createSession, finishSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-12-15T00:00:00+00:00')
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

function bank() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 's@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)

  const makeQuestion = (label: string, withAnswer = true) => {
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
    if (withAnswer) {
      insertRow(
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
    }
    publishQuestionVersion(db, userId, projectId, String(draft.id), { allowWithoutScore: true, now: NOW })
    return { questionId: String(question.id), versionId: String(draft.id) }
  }

  return { db, close: handle.close, userId, projectId, subjectId: String(subject.id), makeQuestion }
}

test('sessions: creation freezes the versions and the score on every item', () => {
  const b = bank()
  try {
    const qa = b.makeQuestion('A')
    const session = createSession(b.db, b.userId, b.projectId, {
      subject_id: b.subjectId,
      question_ids: [qa.questionId],
    }, NOW)
    assert.equal(session.status, 'active')
    assert.equal(session.item_count, 1)

    const items = findRows(b.db, 'practice_session_item', { session_id: String(session.id) })
    assert.equal(items.length, 1)
    assert.equal(String(items[0].question_version_id), qa.versionId, 'the version is frozen at creation')
    assert.equal(String(items[0].max_score), '2.00')
    assert.notEqual(items[0].answer_key_version_id, null, 'the answer version is frozen too')
    assert.equal(items[0].first_delivered_at, null, 'the clock starts at presentation, not creation')
  } finally {
    b.close()
  }
})

test('sessions: a question whose answer became disputed cannot enter a new scored session', () => {
  const b = bank()
  try {
    // Publishing requires a checked answer, so the realistic path to "no trusted answer" is an
    // answer that was disputed *after* publication.
    const qa = b.makeQuestion('争议题')
    const answers = findRows(b.db, 'question_bank_answer_key_version', { question_version_id: qa.versionId })
    insertRow(
      b.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: qa.versionId,
        version: 2,
        verification_status: 'checked',
        is_disputed: false,
      }),
      { now: NOW },
    )
    // Dispute every answer version of this question.
    for (const answer of [...answers, ...findRows(b.db, 'question_bank_answer_key_version', { question_version_id: qa.versionId })]) {
      insertRow(b.db, 'audit_content_revision', completeRow('audit_content_revision', {
        entity_type: 'answer_key_version',
        entity_id: String(answer.id),
        action: 'dispute',
      }), { now: NOW })
      b.db.prepare('UPDATE "question_bank_answer_key_version" SET "is_disputed" = 1 WHERE "question_version_id" = ?').run(qa.versionId)
    }
    assert.throws(
      () =>
        createSession(b.db, b.userId, b.projectId, { subject_id: b.subjectId, question_ids: [qa.questionId] }, NOW),
      (error: unknown) => error instanceof InvalidInput && /没有已核对且无争议的答案/.test(error.message),
    )
    assert.equal(findRows(b.db, 'practice_session_item', {}).length, 0, 'a refused session creates no items')
  } finally {
    b.close()
  }
})

test('sessions: a sealed question cannot enter a session', () => {
  const b = bank()
  try {
    const qa = b.makeQuestion('封存题')
    sealQuestion(b.db, { projectId: b.projectId, questionId: qa.questionId, actorId: b.userId, now: NOW })
    assert.throws(
      () =>
        createSession(b.db, b.userId, b.projectId, { subject_id: b.subjectId, question_ids: [qa.questionId] }, NOW),
      (error: unknown) => error instanceof PurposeNotAllowed && /保留策略/.test(error.message),
    )
  } finally {
    b.close()
  }
})

test('sessions: duration_minutes outside a mock exam is refused, and a mock exam needs one', () => {
  const b = bank()
  try {
    const qa = b.makeQuestion('A')
    assert.throws(
      () =>
        createSession(b.db, b.userId, b.projectId, {
          subject_id: b.subjectId,
          question_ids: [qa.questionId],
          duration_minutes: 60,
        }, NOW),
      /只有模拟考试（mock_exam）支持 duration_minutes/,
    )
    assert.throws(
      () =>
        createSession(b.db, b.userId, b.projectId, {
          subject_id: b.subjectId,
          question_ids: [qa.questionId],
          mode: 'mock_exam',
        }, NOW),
      /模拟考试必须显式给出时长/,
    )
    const exam = createSession(b.db, b.userId, b.projectId, {
      subject_id: b.subjectId,
      question_ids: [qa.questionId],
      mode: 'mock_exam',
      duration_minutes: 90,
    }, NOW)
    assert.equal(exam.exam_deadline, NOW + 90n * 60_000_000n, 'the deadline comes from the server clock')
  } finally {
    b.close()
  }
})

test('sessions: presenting an item starts the clock exactly once', () => {
  const b = bank()
  try {
    const qa = b.makeQuestion('A')
    const session = createSession(b.db, b.userId, b.projectId, { subject_id: b.subjectId, question_ids: [qa.questionId] }, NOW)
    const items = findRows(b.db, 'practice_session_item', { session_id: String(session.id) })
    const itemId = String(items[0].id)

    const first = presentItem(b.db, b.userId, itemId, NOW)
    assert.equal(first.first_delivery, true)
    assert.equal(first.status, 'active')
    assert.equal((first.stem.blank_ids as unknown[]).length, 0)
    // The stem carries no answer: options are id/label/blocks only.
    const options = first.stem.options as { id: string; label: string }[]
    assert.deepEqual(options.map((option) => option.id), ['opt_a', 'opt_b'])
    assert.equal(JSON.stringify(first.stem).includes('correct_option'), false, 'the stem must not leak the answer')

    const later = NOW + 5_000_000n
    const second = presentItem(b.db, b.userId, itemId, later)
    assert.equal(second.first_delivery, false, 'a refresh must not re-start the clock')
    assert.equal(second.first_delivered_at, first.first_delivered_at)

    const exposures = findRows(b.db, 'practice_exposure_event', { session_item_id: itemId })
    assert.equal(exposures.length, 1, 'the delivery ledger records the presentation exactly once')
    assert.equal(exposures[0].kind, 'stem_delivered')
    assert.equal(exposures[0].reveals_answer, false)
  } finally {
    b.close()
  }
})

test('sessions: presentation then submission works end to end', () => {
  const b = bank()
  try {
    const qa = b.makeQuestion('A')
    const session = createSession(b.db, b.userId, b.projectId, { subject_id: b.subjectId, question_ids: [qa.questionId] }, NOW)
    const itemId = String(findRows(b.db, 'practice_session_item', { session_id: String(session.id) })[0].id)
    presentItem(b.db, b.userId, itemId, NOW)

    const submitted = submitAttempt(
      b.db,
      b.userId,
      itemId,
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW + 20_000_000n,
    )
    assert.equal(submitted.grade.status, 'confirmed')
    assert.equal(submitted.attempt.elapsed_ms, 20_000, 'elapsed time is measured from the first presentation')
  } finally {
    b.close()
  }
})

test('sessions: another user cannot present or finish the session', () => {
  const b = bank()
  try {
    const qa = b.makeQuestion('A')
    const session = createSession(b.db, b.userId, b.projectId, { subject_id: b.subjectId, question_ids: [qa.questionId] }, NOW)
    const itemId = String(findRows(b.db, 'practice_session_item', { session_id: String(session.id) })[0].id)
    const other = insertRow(
      b.db,
      'accounts_user',
      completeRow('accounts_user', { email: 'other@example.com', date_joined: NOW }),
      { now: NOW },
    )
    assert.throws(() => presentItem(b.db, String(other.id), itemId, NOW), ScopeViolation)
    assert.throws(() => finishSession(b.db, String(other.id), String(session.id), NOW), ScopeViolation)
  } finally {
    b.close()
  }
})

test('sessions: finishing is idempotent and blocks further submissions', () => {
  const b = bank()
  try {
    const qa = b.makeQuestion('A')
    const session = createSession(b.db, b.userId, b.projectId, { subject_id: b.subjectId, question_ids: [qa.questionId] }, NOW)
    const itemId = String(findRows(b.db, 'practice_session_item', { session_id: String(session.id) })[0].id)
    presentItem(b.db, b.userId, itemId, NOW)

    const finished = finishSession(b.db, b.userId, String(session.id), NOW)
    assert.equal(finished.status, 'finished')
    const again = finishSession(b.db, b.userId, String(session.id), NOW)
    assert.equal(again.status, 'finished', 'finishing twice is a no-op, not an error')

    assert.throws(
      () =>
        submitAttempt(b.db, b.userId, itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } }, NOW),
      /会话已结束，不能继续提交/,
    )
  } finally {
    b.close()
  }
})
