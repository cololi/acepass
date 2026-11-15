import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import {
  SEALED_FAMILY,
  SEALED_QUESTION,
  assertNotSealed,
  isSealed,
  latestPolicies,
  sealCodes,
  sealFamily,
  sealQuestion,
  sealedContentReport,
  sealedQuestionIds,
  unsealFamily,
  unsealQuestion,
} from '../src/services/sealing.ts'
import { InvalidInput, PurposeNotAllowed } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-05-01T00:00:00+00:00')

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
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 's@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)

  const family = insertRow(
    db,
    'question_bank_family',
    completeRow('question_bank_family', { subject_id: subject.id, name: ' família ' }),
    { now: NOW },
  )
  const makeQuestion = (label: string, familyId: string | null) =>
    String(
      insertRow(
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
      ).id,
    )
  const member = makeQuestion('家族成员', String(family.id))
  const lone = makeQuestion('独立题目', null)
  return { db, close: handle.close, userId, projectId, familyId: String(family.id), member, lone }
}

test('sealing: a sealed question reports the question policy code', () => {
  const { db, close, userId, projectId, lone } = seeded()
  try {
    assert.deepEqual(isSealed(db, projectId, lone), { sealed: false, code: '' })
    sealQuestion(db, { projectId, questionId: lone, actorId: userId, reason: '留作考试用', now: NOW })
    assert.deepEqual(isSealed(db, projectId, lone), { sealed: true, code: SEALED_QUESTION })
    assert.throws(
      () => assertNotSealed(db, projectId, lone),
      (error: unknown) => {
        assert.ok(error instanceof PurposeNotAllowed)
        assert.match(error.message, /该题已被保留策略/)
        assert.equal(error.details.reason_code, SEALED_QUESTION)
        return true
      },
    )
  } finally {
    close()
  }
})

test('sealing: unsealing appends a new revision instead of editing the old one', () => {
  const { db, close, userId, projectId, lone } = seeded()
  try {
    sealQuestion(db, { projectId, questionId: lone, actorId: userId, now: NOW })
    unsealQuestion(db, { projectId, questionId: lone, actorId: userId, reason: '可以用了', now: NOW })
    assert.deepEqual(isSealed(db, projectId, lone), { sealed: false, code: '' })

    const rows = findRows(db, 'question_bank_pool_policy', { question_id: lone }, {
      orderBy: [['revision', 'asc']],
    })
    assert.equal(rows.length, 2, 'history is preserved, not rewritten')
    assert.deepEqual(rows.map((row) => row.revision), [1, 2])
    assert.deepEqual(rows.map((row) => Boolean(row.is_holdout)), [true, false])
  } finally {
    close()
  }
})

test('sealing: a sealed family covers its members, and unsealing the family restores them', () => {
  const { db, close, userId, projectId, familyId, member, lone } = seeded()
  try {
    sealFamily(db, { projectId, familyId, actorId: userId, now: NOW })
    assert.deepEqual(isSealed(db, projectId, member), { sealed: true, code: SEALED_FAMILY })
    assert.deepEqual(isSealed(db, projectId, lone), { sealed: false, code: '' }, 'a non-member stays visible')
    assert.deepEqual([...sealedQuestionIds(db, projectId)], [member])

    unsealFamily(db, { projectId, familyId, actorId: userId, now: NOW })
    assert.deepEqual(isSealed(db, projectId, member), { sealed: false, code: '' })
  } finally {
    close()
  }
})

test('sealing: only the latest revision decides, per target', () => {
  const { db, close, userId, projectId, lone } = seeded()
  try {
    // revision 1 seals, revision 2 clears it: the content must be visible again.
    sealQuestion(db, { projectId, questionId: lone, actorId: userId, now: NOW })
    unsealQuestion(db, { projectId, questionId: lone, actorId: userId, now: NOW })
    const { questions } = latestPolicies(db, projectId, { questionIds: [lone] })
    assert.equal(questions.get(lone)?.revision, 2)
    assert.equal(Boolean(questions.get(lone)?.is_holdout), false)
    assert.equal(sealCodes(db, projectId, [[lone, null]]).get(lone), undefined)
  } finally {
    close()
  }
})

test('sealing: a question policy wins over a family policy in the reason code', () => {
  const { db, close, userId, projectId, familyId, member } = seeded()
  try {
    sealFamily(db, { projectId, familyId, actorId: userId, now: NOW })
    sealQuestion(db, { projectId, questionId: member, actorId: userId, now: NOW })
    assert.deepEqual(isSealed(db, projectId, member), { sealed: true, code: SEALED_QUESTION })
  } finally {
    close()
  }
})

test('sealing: the policy needs exactly one target and the target must be in the project', () => {
  const { db, close, userId, projectId } = seeded()
  try {
    assert.throws(
      () =>
        sealQuestion(db, { projectId, questionId: 'missing', actorId: userId, now: NOW }),
      (error: unknown) => error instanceof InvalidInput && error.message === '题目不属于该项目',
    )
    assert.throws(
      () => sealFamily(db, { projectId, familyId: 'missing', actorId: userId, now: NOW }),
      /题族不属于该项目/,
    )
    // A question id belonging to a different project is refused too.
    const other = createProject(db, userId, { name: 'Other' }, NOW)
    assert.throws(
      () => sealQuestion(db, { projectId: String(other.id), questionId: 'anything', actorId: userId, now: NOW }),
      /题目不属于该项目/,
    )
  } finally {
    close()
  }
})

test('sealing: the report lists what is sealed, with the deciding policy', () => {
  const { db, close, userId, projectId, familyId, member, lone } = seeded()
  try {
    sealQuestion(db, { projectId, questionId: lone, actorId: userId, reason: '期末卷', now: NOW })
    sealFamily(db, { projectId, familyId, actorId: userId, now: NOW })

    const report = sealedContentReport(db, projectId) as {
      question_ids: string[]
      questions: { question_id: string; reason_code: string; policy_target: string; change_reason: string }[]
      families: { family_id: string; reason_code: string }[]
      reasons: Record<string, string>
    }
    assert.deepEqual(report.question_ids, [lone, member].sort())
    assert.equal(report.reasons[lone], SEALED_QUESTION)
    assert.equal(report.reasons[member], SEALED_FAMILY)
    const loneRow = report.questions.find((row) => row.question_id === lone)!
    assert.equal(loneRow.policy_target, 'question')
    assert.equal(loneRow.change_reason, '期末卷')
    assert.deepEqual(
      report.families.map((row) => row.family_id),
      [familyId],
    )

    // An unsealed family disappears from the report even though its history remains.
    unsealFamily(db, { projectId, familyId, actorId: userId, now: NOW })
    const after = sealedContentReport(db, projectId) as { families: unknown[]; question_ids: string[] }
    assert.deepEqual(after.families, [])
    assert.deepEqual(after.question_ids, [lone])
  } finally {
    close()
  }
})

test('sealing: an unsealed question with no policy at all is not sealed', () => {
  const { db, close, projectId, lone } = seeded()
  try {
    const report = sealedContentReport(db, projectId) as { question_ids: unknown[] }
    assert.deepEqual(report.question_ids, [])
    assert.deepEqual(isSealed(db, projectId, lone), { sealed: false, code: '' })
  } finally {
    close()
  }
})
