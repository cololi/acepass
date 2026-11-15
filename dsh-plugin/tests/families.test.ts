import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { addQuestionToFamily, createFamily, listFamilies, removeQuestionFromFamily, updateFamily } from '../src/services/families.ts'
import { sealFamily, sealQuestion } from '../src/services/sealing.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-07-01T00:00:00+00:00')

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
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'f@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)
  const makeQuestion = (label: string) =>
    String(
      insertRow(
        db,
        'question_bank_question',
        completeRow('question_bank_question', {
          subject_id: subject.id,
          origin_type: 'import',
          is_demo: false,
          display_label: label,
          family_id: null,
        }),
        { now: NOW },
      ).id,
    )
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    subjectId: String(subject.id),
    q1: makeQuestion('题1'),
    q2: makeQuestion('题2'),
  }
}

test('families: a name is trimmed, unique per subject, and audited', () => {
  const { db, close, userId, projectId, subjectId } = seeded()
  try {
    const family = createFamily(db, { projectId, actorId: userId, subjectId, name: '  近重复家族  ', now: NOW })
    assert.equal(family.name, '近重复家族')
    assert.equal(family.member_count, 0)
    assert.equal(family.sealed, false)
    assert.equal(family.revision, 1)

    assert.throws(
      () => createFamily(db, { projectId, actorId: userId, subjectId, name: '近重复家族', now: NOW }),
      /同一科目下已存在同名家族/,
    )
    assert.throws(() => createFamily(db, { projectId, actorId: userId, subjectId, name: '  ', now: NOW }), /家族名称不能为空/)
    assert.equal(findRows(db, 'audit_content_revision', { action: 'create', entity_type: 'question_family' }).length, 1)
  } finally {
    close()
  }
})

test('families: adding a member is idempotent and bumps the payload', () => {
  const { db, close, userId, projectId, subjectId, q1 } = seeded()
  try {
    const family = createFamily(db, { projectId, actorId: userId, subjectId, name: 'F', now: NOW })
    const first = addQuestionToFamily(db, {
      projectId,
      actorId: userId,
      familyId: String(family.id),
      questionId: q1,
      now: NOW,
    })
    assert.equal(first.changed, true)
    assert.equal(first.family.member_count, 1)

    const again = addQuestionToFamily(db, {
      projectId,
      actorId: userId,
      familyId: String(family.id),
      questionId: q1,
      now: NOW,
    })
    assert.equal(again.changed, false, 'adding a member twice is a no-op success')
  } finally {
    close()
  }
})

test('families: a sealed family refuses new members and removals', () => {
  const { db, close, userId, projectId, subjectId, q1, q2 } = seeded()
  try {
    const family = createFamily(db, { projectId, actorId: userId, subjectId, name: 'F', now: NOW })
    addQuestionToFamily(db, { projectId, actorId: userId, familyId: String(family.id), questionId: q1, now: NOW })
    sealFamily(db, { projectId, familyId: String(family.id), actorId: userId, now: NOW })

    assert.throws(
      () =>
        addQuestionToFamily(db, { projectId, actorId: userId, familyId: String(family.id), questionId: q2, now: NOW }),
      (error: unknown) => error instanceof PurposeNotAllowed && /封存内容不可加入家族/.test(error.message),
    )
    assert.throws(
      () =>
        removeQuestionFromFamily(db, { projectId, actorId: userId, familyId: String(family.id), questionId: q1, now: NOW }),
      /封存内容不可移出家族/,
      'dropping the last member would silently unseal content',
    )
    const payload = listFamilies(db, projectId)[0]
    assert.equal(payload.sealed, true)
    assert.equal(payload.sealed_reason, 'sealed_family_policy')
    assert.equal(payload.sealed_member_count, 1)
  } finally {
    close()
  }
})

test('families: a question sealed by its own policy cannot be added', () => {
  const { db, close, userId, projectId, subjectId, q1 } = seeded()
  try {
    const family = createFamily(db, { projectId, actorId: userId, subjectId, name: 'F', now: NOW })
    sealQuestion(db, { projectId, questionId: q1, actorId: userId, now: NOW })
    assert.throws(
      () =>
        addQuestionToFamily(db, { projectId, actorId: userId, familyId: String(family.id), questionId: q1, now: NOW }),
      (error: unknown) => error instanceof PurposeNotAllowed && error.details.reason === 'sealed_question_policy',
    )
  } finally {
    close()
  }
})

test('families: a question from another subject cannot join', () => {
  const { db, close, userId, projectId, subjectId, q1 } = seeded()
  try {
    const otherProject = createProject(db, userId, { name: 'Other' }, NOW)
    const otherSubject = createSubject(db, userId, String(otherProject.id), { name: 'OtherS' }, NOW)
    const family = createFamily(db, {
      projectId: String(otherProject.id),
      actorId: userId,
      subjectId: String(otherSubject.id),
      name: 'F',
      now: NOW,
    })
    assert.throws(
      () =>
        addQuestionToFamily(db, {
          projectId: String(otherProject.id),
          actorId: userId,
          familyId: String(family.id),
          questionId: q1,
          now: NOW,
        }),
      (error: unknown) => error instanceof ScopeViolation,
    )
    // Same project, different subject: refused with the subject ids in the details.
    const s2 = createSubject(db, userId, projectId, { name: 'S2' }, NOW)
    const f2 = createFamily(db, { projectId, actorId: userId, subjectId: String(s2.id), name: 'F2', now: NOW })
    assert.throws(
      () =>
        addQuestionToFamily(db, { projectId, actorId: userId, familyId: String(f2.id), questionId: q1, now: NOW }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInput)
        assert.match(error.message, /不属于同一科目/)
        return true
      },
    )
    void subjectId
  } finally {
    close()
  }
})

test('families: update renames with the same uniqueness rule and bumps the revision', () => {
  const { db, close, userId, projectId, subjectId } = seeded()
  try {
    const a = createFamily(db, { projectId, actorId: userId, subjectId, name: 'A', now: NOW })
    createFamily(db, { projectId, actorId: userId, subjectId, name: 'B', now: NOW })
    assert.throws(
      () => updateFamily(db, { projectId, actorId: userId, familyId: String(a.id), name: 'B', now: NOW }),
      /同一科目下已存在同名家族/,
    )
    const renamed = updateFamily(db, { projectId, actorId: userId, familyId: String(a.id), name: 'A2', now: NOW })
    assert.equal(renamed.name, 'A2')
    assert.equal(renamed.revision, 2)
    assert.throws(
      () => updateFamily(db, { projectId, actorId: userId, familyId: String(a.id), name: '  ', now: NOW }),
      /家族名称不能为空/,
    )
  } finally {
    close()
  }
})

test('families: the list follows subject order then name, not a global name sort', () => {
  const { db, close, userId, projectId } = seeded()
  try {
    const second = createSubject(db, userId, projectId, { name: 'S2' }, NOW)
    const firstFamily = createFamily(db, {
      projectId,
      actorId: userId,
      subjectId: (findRows(db, 'exams_subject', { project_id: projectId })[0].id as string),
      name: 'Z 家族',
      now: NOW,
    })
    const secondFamily = createFamily(db, {
      projectId,
      actorId: userId,
      subjectId: String(second.id),
      name: 'A 家族',
      now: NOW,
    })
    const listed = listFamilies(db, projectId).map((family) => family.id)
    assert.deepEqual(listed, [String(firstFamily.id), String(secondFamily.id)])
  } finally {
    close()
  }
})
