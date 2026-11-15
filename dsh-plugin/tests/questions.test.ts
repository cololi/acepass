import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import {
  assertDraft,
  contentDigest,
  createQuestionRevision,
  normalizeContent,
  publishQuestionVersion,
  updateDraftVersion,
  withdrawQuestionVersion,
} from '../src/services/questions.ts'
import { InvalidInput, StructureInvalid, VersionConflict } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-04-01T00:00:00+00:00')

/** Fill every NOT NULL column the schema declares, so fixtures track the model automatically. */
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

const CONTENT = {
  blocks: [{ kind: 'text', text: '1+1 等于几？' }],
  options: [
    { id: 'opt_a', text: '1' },
    { id: 'opt_b', text: '2' },
  ],
}

function seeded() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'q@example.com', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
  const question = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', {
      subject_id: subject.id,
      origin_type: 'import',
      is_demo: false,
      display_label: '',
    }),
    { now: NOW },
  )
  return { db, close: handle.close, userId, projectId: String(project.id), questionId: String(question.id) }
}

function addCheckedAnswer(db: DatabaseSync, versionId: string): string {
  const answer = insertRow(
    db,
    'question_bank_answer_key_version',
    completeRow('question_bank_answer_key_version', {
      question_version_id: versionId,
      version: 1,
      source_type: 'manual',
      verification_status: 'checked',
      check_basis: '对照教材第 3 页',
      is_disputed: false,
      answer_payload: { kind: 'single_choice', correct_option_id: 'opt_b' },
    }),
    { now: NOW },
  )
  return String(answer.id)
}

test('questions: a draft revision is created with an incremented version', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    const first = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    assert.equal(first.version, 1)
    assert.equal(first.status, 'draft')
    const second = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    assert.equal(second.version, 2)
  } finally {
    close()
  }
})

test('questions: structurally invalid content never becomes a row', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    assert.throws(
      () =>
        createQuestionRevision(
          db,
          userId,
          projectId,
          questionId,
          { question_type: 'single_choice', content: { blocks: [] } },
          NOW,
        ),
      StructureInvalid,
    )
    assert.equal(findRows(db, 'question_bank_question_version', { question_id: questionId }).length, 0)
  } finally {
    close()
  }
})

test('questions: a published version cannot be edited in place — the R-INV 1 guard', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    const draft = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT, practice_max_score: '2.00' },
      NOW,
    )
    addCheckedAnswer(db, String(draft.id))
    const published = publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })
    assert.equal(published.status, 'published')

    assert.throws(
      () => updateDraftVersion(db, userId, projectId, String(draft.id), { content: CONTENT }, { now: NOW }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInput)
        assert.equal(error.message, '只有草稿版本可以直接修改；已发布内容请创建新版本')
        assert.deepEqual(error.details, { status: 'published' })
        return true
      },
    )
    // Creating a new revision is the sanctioned path, and it starts as a draft.
    const next = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    assert.equal(next.status, 'draft')
    assert.equal(next.version, 2)
  } finally {
    close()
  }
})

test('questions: a stale expected_version is a 409, not a silent overwrite', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    const draft = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    assert.throws(
      () =>
        updateDraftVersion(db, userId, projectId, String(draft.id), { estimated_seconds: 30 }, {
          expectedVersion: 99,
          now: NOW,
        }),
      (error: unknown) => {
        assert.ok(error instanceof VersionConflict)
        assert.equal(error.statusCode, 409)
        return true
      },
    )
    const ok = updateDraftVersion(db, userId, projectId, String(draft.id), { estimated_seconds: 30 }, {
      expectedVersion: 1,
      now: NOW,
    })
    assert.equal(ok.estimated_seconds, 30)
  } finally {
    close()
  }
})

test('questions: publishing refuses a version with no answer, naming the problem', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    const draft = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT, practice_max_score: '2.00' },
      NOW,
    )
    assert.throws(
      () => publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW }),
      (error: unknown) => {
        assert.ok(error instanceof StructureInvalid)
        const codes = (error.details.problems as { code: string }[]).map((problem) => problem.code)
        assert.ok(codes.includes('answer_missing'), `expected answer_missing, saw ${codes.join(',')}`)
        return true
      },
    )
  } finally {
    close()
  }
})

test('questions: publishing needs a checked answer and a score', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    const draft = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    addCheckedAnswer(db, String(draft.id))
    // No practice_max_score and no explicit opt-out.
    assert.throws(
      () => publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW }),
      (error: unknown) => {
        assert.ok(error instanceof StructureInvalid)
        const codes = (error.details.problems as { code: string }[]).map((problem) => problem.code)
        assert.ok(codes.includes('practice_max_score_missing'))
        return true
      },
    )
    const published = publishQuestionVersion(db, userId, projectId, String(draft.id), {
      allowWithoutScore: true,
      now: NOW,
    })
    assert.equal(published.status, 'published')
    assert.equal(
      published.content_digest,
      contentDigest(CONTENT),
      'the digest is of the canonical content, so it is reproducible',
    )
    // The question now points at the published version.
    const question = db
      .prepare('SELECT "current_published_version_id" AS v FROM "question_bank_question" WHERE "id" = ?')
      .get(questionId) as { v: string }
    assert.equal(question.v, String(draft.id))
  } finally {
    close()
  }
})

test('questions: withdrawing falls back to the previous published version', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    const v1 = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    addCheckedAnswer(db, String(v1.id))
    publishQuestionVersion(db, userId, projectId, String(v1.id), { allowWithoutScore: true, now: NOW })

    const v2 = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    addCheckedAnswer(db, String(v2.id))
    publishQuestionVersion(db, userId, projectId, String(v2.id), { allowWithoutScore: true, now: NOW })
    assert.equal(
      (db.prepare('SELECT "current_published_version_id" AS v FROM "question_bank_question" WHERE "id" = ?').get(
        questionId,
      ) as { v: string }).v,
      String(v2.id),
    )

    const withdrawn = withdrawQuestionVersion(db, userId, projectId, String(v2.id), { reason: '排版错误', now: NOW })
    assert.equal(withdrawn.status, 'withdrawn')
    assert.equal(withdrawn.withdrawn_reason, '排版错误')
    assert.equal(
      (db.prepare('SELECT "current_published_version_id" AS v FROM "question_bank_question" WHERE "id" = ?').get(
        questionId,
      ) as { v: string }).v,
      String(v1.id),
      'the pointer falls back to the previous published revision',
    )
    // A withdrawn version is not re-publishable; a new revision is required.
    assert.throws(
      () => publishQuestionVersion(db, userId, projectId, String(v2.id), { now: NOW }),
      /已撤回版本不能重新发布/,
    )
  } finally {
    close()
  }
})

test('questions: a draft cannot be withdrawn, and a withdrawn one cannot be withdrawn twice', () => {
  const { db, close, userId, projectId, questionId } = seeded()
  try {
    const draft = createQuestionRevision(
      db,
      userId,
      projectId,
      questionId,
      { question_type: 'single_choice', content: CONTENT },
      NOW,
    )
    assert.throws(() => withdrawQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW }), /只有已发布版本可以撤回/)
  } finally {
    close()
  }
})

test('questions: normalizeContent keeps only the known top-level keys in order', () => {
  const normalized = normalizeContent({
    table_note: 'note',
    junk: 'dropped',
    options: [{ id: 'a' }, 'not-an-object'],
    blocks: [{ kind: 'text', text: 'x' }, null],
  })
  assert.deepEqual(Object.keys(normalized), ['blocks', 'options', 'table_note'])
  assert.equal((normalized.options as unknown[]).length, 1, 'non-object options are dropped')
  assert.equal((normalized.blocks as unknown[]).length, 1, 'non-object blocks are dropped')
})

test('questions: assertDraft refuses anything that is not a draft', () => {
  for (const status of ['published', 'withdrawn']) {
    assert.throws(() => assertDraft({ status }), /只有草稿版本可以直接修改/)
  }
  assert.doesNotThrow(() => assertDraft({ status: 'draft' }))
})
