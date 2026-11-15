import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { listMappings, replaceKnowledgeMappings } from '../src/services/mappings.ts'
import { InvalidInput, ScopeViolation } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-06-01T00:00:00+00:00')

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
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'm@example.com', date_joined: NOW }), {
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
  const node = (name: string, syllabusId: string) =>
    String(
      insertRow(
        db,
        'knowledge_node',
        completeRow('knowledge_node', { syllabus_version_id: syllabusId, canonical_name: name, code: name }),
        { now: NOW },
      ).id,
    )
  const nodeA = node('考点A', String(syllabus.id))
  const nodeB = node('考点B', String(syllabus.id))

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
  const version = insertRow(
    db,
    'question_bank_question_version',
    completeRow('question_bank_question_version', { question_id: question.id, version: 1 }),
    { now: NOW },
  )
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    subjectId: String(subject.id),
    syllabusId: String(syllabus.id),
    nodeA,
    nodeB,
    versionId: String(version.id),
    questionId: String(question.id),
  }
}

test('mappings: a new revision is written and the old one stays readable', () => {
  const { db, close, userId, projectId, versionId, nodeA } = seeded()
  try {
    const first = replaceKnowledgeMappings(
      db,
      projectId,
      versionId,
      [{ node_id: nodeA, score_weight: '1' }],
      { actorId: userId, now: NOW },
    )
    assert.equal(first.length, 1)
    assert.equal(first[0].mapping_revision, 1)
    // `score_weight` has decimal_places=4, so the stored form is `1.0000`.
    assert.equal(first[0].score_weight, '1.0000')

    const second = replaceKnowledgeMappings(
      db,
      projectId,
      versionId,
      [{ node_id: nodeA, score_weight: '1' }],
      { actorId: userId, now: NOW },
    )
    assert.equal(second[0].mapping_revision, 2, 'a replace creates a revision, it does not overwrite')

    assert.equal(listMappings(db, projectId, versionId).length, 2, 'both revisions are readable')
    assert.equal(listMappings(db, projectId, versionId, { revision: 1 }).length, 1)
    assert.equal(listMappings(db, projectId, versionId, { revision: 2 })[0].mapping_revision, 2)
  } finally {
    close()
  }
})

test('mappings: primary weights must sum to exactly one', () => {
  const { db, close, userId, projectId, versionId, nodeA, nodeB } = seeded()
  try {
    assert.doesNotThrow(() =>
      replaceKnowledgeMappings(
        db,
        projectId,
        versionId,
        [
          { node_id: nodeA, score_weight: '0.7' },
          { node_id: nodeB, score_weight: '0.3' },
        ],
        { actorId: userId, now: NOW },
      ),
    )
    assert.throws(
      () =>
        replaceKnowledgeMappings(db, projectId, versionId, [{ node_id: nodeA, score_weight: '0.5' }], {
          actorId: userId,
          now: NOW,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInput)
        assert.match(error.message, /主要考点权重合计必须为 1/)
        assert.deepEqual(error.details, { total: '0.5' })
        return true
      },
    )
  } finally {
    close()
  }
})

test('mappings: an auxiliary node must weigh zero so scoring cannot double count', () => {
  const { db, close, userId, projectId, versionId, nodeA, nodeB } = seeded()
  try {
    const ok = replaceKnowledgeMappings(
      db,
      projectId,
      versionId,
      [
        { node_id: nodeA, score_weight: '1', is_primary: true },
        { node_id: nodeB, score_weight: '0', is_primary: false },
      ],
      { actorId: userId, now: NOW },
    )
    assert.equal(ok.length, 2)

    assert.throws(
      () =>
        replaceKnowledgeMappings(
          db,
          projectId,
          versionId,
          [
            { node_id: nodeA, score_weight: '1', is_primary: true },
            { node_id: nodeB, score_weight: '0.2', is_primary: false },
          ],
          { actorId: userId, now: NOW },
        ),
      /辅助考点权重必须为 0，避免重复计分/,
    )
  } finally {
    close()
  }
})

test('mappings: an empty batch and duplicate nodes are refused', () => {
  const { db, close, userId, projectId, versionId, nodeA } = seeded()
  try {
    assert.throws(
      () => replaceKnowledgeMappings(db, projectId, versionId, [], { actorId: userId, now: NOW }),
      /映射不能为空/,
    )
    assert.throws(
      () =>
        replaceKnowledgeMappings(
          db,
          projectId,
          versionId,
          [
            { node_id: nodeA, score_weight: '0.5' },
            { node_id: nodeA, score_weight: '0.5' },
          ],
          { actorId: userId, now: NOW },
        ),
      /同一考点不能重复映射/,
    )
    assert.equal(findRows(db, 'knowledge_question_mapping', { question_version_id: versionId }).length, 0)
  } finally {
    close()
  }
})

test('mappings: a node from another subject is a scope violation, not a silent accept', () => {
  const { db, close, userId, projectId, versionId } = seeded()
  try {
    // A node that belongs to a syllabus of a different subject.
    const otherProject = createProject(db, userId, { name: 'Other' }, NOW)
    const otherSubject = createSubject(db, userId, String(otherProject.id), { name: 'OtherS' }, NOW)
    const foreignSyllabus = insertRow(
      db,
      'exams_syllabus_version',
      completeRow('exams_syllabus_version', { subject_id: otherSubject.id, name: '别的大纲', version_label: 'v1' }),
      { now: NOW },
    )
    const foreignNode = insertRow(
      db,
      'knowledge_node',
      completeRow('knowledge_node', { syllabus_version_id: foreignSyllabus.id, canonical_name: '外部考点', code: 'x' }),
      { now: NOW },
    )
    assert.throws(
      () =>
        replaceKnowledgeMappings(db, projectId, versionId, [{ node_id: String(foreignNode.id), score_weight: '1' }], {
          actorId: userId,
          now: NOW,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ScopeViolation)
        assert.equal(error.message, '考点大纲与题目科目不一致')
        return true
      },
    )
    assert.throws(
      () =>
        replaceKnowledgeMappings(db, projectId, versionId, [{ node_id: 'missing-node', score_weight: '1' }], {
          actorId: userId,
          now: NOW,
        }),
      /存在不属于可用大纲的考点/,
    )
  } finally {
    close()
  }
})

test('mappings: order is revision then node name, like the Django queryset', () => {
  const { db, close, userId, projectId, versionId, nodeA, nodeB } = seeded()
  try {
    replaceKnowledgeMappings(db, projectId, versionId, [{ node_id: nodeB, score_weight: '1' }], {
      actorId: userId,
      now: NOW,
    })
    replaceKnowledgeMappings(
      db,
      projectId,
      versionId,
      [
        { node_id: nodeB, score_weight: '0.5' },
        { node_id: nodeA, score_weight: '0.5' },
      ],
      { actorId: userId, now: NOW },
    )
    const rows = listMappings(db, projectId, versionId)
    assert.deepEqual(
      rows.map((row) => [row.mapping_revision, row.node_name]),
      [
        [1, '考点B'],
        [2, '考点A'],
        [2, '考点B'],
      ],
    )
  } finally {
    close()
  }
})
