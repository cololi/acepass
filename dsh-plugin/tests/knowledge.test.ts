import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject, publishSyllabusVersion } from '../src/services/exams.ts'
import { createNode, descendants, importOutline, listNodes, patchNode } from '../src/services/knowledge.ts'
import { InvalidInput, ScopeViolation } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2027-01-01T00:00:00+00:00')

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

function seeded(publish = true) {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'k@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)
  const syllabus = insertRow(
    db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', { subject_id: subject.id, name: '大纲', version_label: 'v1', status: 'draft' }),
    { now: NOW },
  )
  const syllabusId = String(syllabus.id)
  if (publish) publishSyllabusVersion(db, userId, projectId, syllabusId, NOW)
  return { db, close: handle.close, userId, projectId, subjectId: String(subject.id), syllabusId }
}

test('knowledge: a node can only be added to a published outline', () => {
  const draft = seeded(false)
  try {
    assert.throws(
      () =>
        createNode(draft.db, draft.userId, draft.projectId, {
          syllabus_version_id: draft.syllabusId,
          canonical_name: '导数',
        }, NOW),
      /只能向已发布的大纲版本添加考点/,
    )
  } finally {
    draft.close()
  }
})

test('knowledge: a duplicate name under the same parent is a business error, not a constraint crash', () => {
  const s = seeded()
  try {
    createNode(s.db, s.userId, s.projectId, { syllabus_version_id: s.syllabusId, canonical_name: '导数' }, NOW)
    assert.throws(
      () => createNode(s.db, s.userId, s.projectId, { syllabus_version_id: s.syllabusId, canonical_name: '导数' }, NOW),
      /同一父节点下已存在同名考点/,
    )
    // The same name under a different parent is a different point.
    const parent = createNode(s.db, s.userId, s.projectId, { syllabus_version_id: s.syllabusId, canonical_name: '第一章' }, NOW)
    assert.doesNotThrow(() =>
      createNode(
        s.db,
        s.userId,
        s.projectId,
        { syllabus_version_id: s.syllabusId, canonical_name: '导数', parent_id: String(parent.id) },
        NOW,
      ),
    )
  } finally {
    s.close()
  }
})

test('knowledge: a re-parent that would create a cycle is refused', () => {
  const s = seeded()
  try {
    const root = createNode(s.db, s.userId, s.projectId, { syllabus_version_id: s.syllabusId, canonical_name: '根' }, NOW)
    const child = createNode(s.db, s.userId, s.projectId, {
      syllabus_version_id: s.syllabusId,
      canonical_name: '子',
      parent_id: String(root.id),
    }, NOW)
    const grandchild = createNode(s.db, s.userId, s.projectId, {
      syllabus_version_id: s.syllabusId,
      canonical_name: '孙',
      parent_id: String(child.id),
    }, NOW)

    assert.deepEqual(descendants(s.db, String(root.id)).sort(), [String(child.id), String(grandchild.id)].sort())
    assert.throws(
      () => patchNode(s.db, s.userId, s.projectId, String(root.id), { parent_id: String(grandchild.id) }, NOW),
      /不能把考点移动到自己的子节点下：会形成环/,
    )
    assert.throws(
      () => patchNode(s.db, s.userId, s.projectId, String(root.id), { parent_id: String(root.id) }, NOW),
      /考点不能以自身为父（会形成环）/,
    )
    // A sibling move is fine.
    const other = createNode(s.db, s.userId, s.projectId, { syllabus_version_id: s.syllabusId, canonical_name: '另一根' }, NOW)
    assert.doesNotThrow(() =>
      patchNode(s.db, s.userId, s.projectId, String(child.id), { parent_id: String(other.id) }, NOW),
    )
  } finally {
    s.close()
  }
})

test('knowledge: importing a word list builds the tree and merges synonyms', () => {
  const s = seeded()
  try {
    // Merging is direction-dependent and pinned by the Python `_find_existing`: a later line merges
    // when *its* name or aliases match an existing node, so the alias-bearing line must come second.
    const report = importOutline(s.db, s.userId, s.projectId, s.syllabusId, {
      text: ['1 函数', '1.1 微分', '1.2 导数（微分）', '2 极限'].join('\n'),
    }, NOW)

    assert.equal(report.created, 3, 'the second mention of 微分 must not create a second point')
    assert.equal(report.merged, 1)
    assert.equal(report.merged + report.created, 4, 'four lines, three nodes')

    const nodes = listNodes(s.db, s.projectId, { syllabusVersionId: s.syllabusId })
    const byName = new Map(nodes.map((node) => [String(node.canonical_name), node]))
    assert.equal(byName.has('微分'), true, 'the first mention owns the point')
    assert.equal(byName.has('导数'), false, 'the synonym line merges into it instead of duplicating')
    assert.equal(byName.get('函数')!.kind, 'chapter', 'depth 0 is a chapter')
    assert.equal(byName.get('微分')!.kind, 'section', 'depth 1 is a section')
    assert.equal(String(byName.get('微分')!.parent_id), String(byName.get('函数')!.id))
  } finally {
    s.close()
  }
})

test('knowledge: importing twice is a merge, not a duplicate tree', () => {
  const s = seeded()
  try {
    const text = ['1 函数', '1.1 导数'].join('\n')
    const first = importOutline(s.db, s.userId, s.projectId, s.syllabusId, { text }, NOW)
    assert.equal(first.created, 2)

    const second = importOutline(s.db, s.userId, s.projectId, s.syllabusId, { text }, NOW)
    assert.equal(second.created, 0, 're-importing the same list must not duplicate anything')
    assert.equal(second.merged, 2)
    assert.equal(second.node_count, 2)
  } finally {
    s.close()
  }
})

test('knowledge: an empty word list is refused', () => {
  const s = seeded()
  try {
    assert.throws(
      () => importOutline(s.db, s.userId, s.projectId, s.syllabusId, { text: '   \n  ' }, NOW),
      /词表内容不能为空/,
    )
  } finally {
    s.close()
  }
})

test('knowledge: a node from another project is not reachable', () => {
  const a = seeded()
  try {
    const node = createNode(a.db, a.userId, a.projectId, { syllabus_version_id: a.syllabusId, canonical_name: 'X' }, NOW)
    const other = createProject(a.db, a.userId, { name: 'Other' }, NOW)
    assert.throws(
      () => patchNode(a.db, a.userId, String(other.id), String(node.id), { canonical_name: 'Y' }, NOW),
      ScopeViolation,
    )
  } finally {
    a.close()
  }
})

test('knowledge: listing filters by syllabus and subject', () => {
  const s = seeded()
  try {
    importOutline(s.db, s.userId, s.projectId, s.syllabusId, { text: '1 函数\n1.1 导数' }, NOW)
    assert.equal(listNodes(s.db, s.projectId).length, 2)
    assert.equal(listNodes(s.db, s.projectId, { subjectId: s.subjectId }).length, 2)
    assert.equal(listNodes(s.db, s.projectId, { syllabusVersionId: s.syllabusId }).length, 2)
    assert.equal(listNodes(s.db, s.projectId, { syllabusVersionId: 'nope' }).length, 0)
  } finally {
    s.close()
  }
})

void (InvalidInput as unknown)
void (findRows as unknown)
