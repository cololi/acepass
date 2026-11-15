import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { insertRow, findRows } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import {
  archiveProject,
  createProject,
  createSubject,
  getProject,
  listProjects,
  listSubjects,
  requireProject,
  unarchiveProject,
  updateProject,
  createSpecVersion,
  publishSpecVersion,
  listSpecVersions,
  createSyllabusVersion,
  publishSyllabusVersion,
  listSyllabusVersions,
  registerPaper,
  getPaper,
  recordPaperCoverage,
  confirmPaperRevision,
  setEffectiveRevision,
} from '../src/services/exams.ts'
import { InvalidInput, ScopeViolation } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-03-01T00:00:00+00:00')

function storeWithUser() {
  const handle = openStore({ path: ':memory:' })
  const user = insertRow(
    handle.db,
    'accounts_user',
    {
      password: '!',
      email: 'a@example.com',
      display_name: '阿测',
      is_active: 1,
      is_staff: 0,
      is_superuser: 0,
      date_joined: NOW,
    },
    { now: NOW },
  )
  return { db: handle.db, close: handle.close, userId: String(user.id) }
}

test('projects: create trims the name, caps the description and appends the order', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const first = createProject(db, userId, { name: '  考研数学  ', description: 'x'.repeat(600) }, NOW)
    assert.equal(first.name, '考研数学', 'the stored name is trimmed')
    assert.equal(String(first.description).length, 500, 'description is capped at 500')
    assert.equal(first.display_order, 1)
    assert.equal(first.is_archived, false)
    assert.equal(first.subject_count, 0)
    assert.equal(first.question_count, 0)
    assert.equal(first.created_at, '2026-03-01T00:00:00+00:00')

    const second = createProject(db, userId, { name: '考研英语' }, NOW)
    assert.equal(second.display_order, 2, 'order follows the current maximum')
  } finally {
    close()
  }
})

test('projects: an empty or duplicate name is refused with the documented message', () => {
  const { db, close, userId } = storeWithUser()
  try {
    assert.throws(() => createProject(db, userId, { name: '   ' }, NOW), /项目名称不能为空/)
    createProject(db, userId, { name: '同名' }, NOW)
    assert.throws(
      () => createProject(db, userId, { name: ' 同名 ' }, NOW),
      (error: unknown) => error instanceof InvalidInput && error.message === '已存在同名项目',
      'the duplicate check runs on the trimmed name',
    )
    // The same name under a different owner is fine.
    const other = insertRow(
      db,
      'accounts_user',
      { password: '!', email: 'b@example.com', display_name: 'B', is_active: 1, is_staff: 0, is_superuser: 0, date_joined: NOW },
      { now: NOW },
    )
    assert.doesNotThrow(() => createProject(db, String(other.id), { name: '同名' }, NOW))
  } finally {
    close()
  }
})

test('projects: listing hides archived projects unless asked', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const kept = createProject(db, userId, { name: '保留' }, NOW)
    const gone = createProject(db, userId, { name: '归档' }, NOW)
    archiveProject(db, userId, String(gone.id), { now: NOW })

    assert.deepEqual(listProjects(db, userId).map((row) => row.name), ['保留'])
    assert.deepEqual(listProjects(db, userId, { includeArchived: true }).map((row) => row.name), ['保留', '归档'])
    assert.equal(getProject(db, userId, String(kept.id)).name, '保留')
  } finally {
    close()
  }
})

test('projects: another owner cannot reach a project, and the error hides existence', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: '私有' }, NOW)
    const other = insertRow(
      db,
      'accounts_user',
      { password: '!', email: 'c@example.com', display_name: 'C', is_active: 1, is_staff: 0, is_superuser: 0, date_joined: NOW },
      { now: NOW },
    )
    assert.throws(
      () => requireProject(db, String(other.id), String(project.id)),
      (error: unknown) => error instanceof ScopeViolation && error.statusCode === 404,
    )
  } finally {
    close()
  }
})

test('projects: patch skips nulls, checks the renamed value and audits the change', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: '原名', description: 'old' }, NOW)
    const updated = updateProject(
      db,
      userId,
      String(project.id),
      { name: '新名', description: null, display_order: 7 },
      NOW,
    )
    assert.equal(updated.name, '新名')
    assert.equal(updated.description, 'old', 'an explicit null means "not provided", not "clear"')
    assert.equal(updated.display_order, 7)

    const revisions = findRows(db, 'audit_content_revision', { entity_id: String(project.id) })
    assert.equal(revisions.length, 1, 'the change is audited once')
    assert.equal(revisions[0].action, 'update')
    assert.deepEqual(revisions[0].detail, { name: '新名', display_order: '7' }, 'only changed fields are recorded')
  } finally {
    close()
  }
})

test('projects: renaming onto an existing name is refused, and the row is left alone', () => {
  const { db, close, userId } = storeWithUser()
  try {
    createProject(db, userId, { name: '占用' }, NOW)
    const project = createProject(db, userId, { name: '自己的' }, NOW)
    assert.throws(
      () => updateProject(db, userId, String(project.id), { name: '占用' }, NOW),
      /已存在同名项目/,
    )
    assert.equal(getProject(db, userId, String(project.id)).name, '自己的', 'a refused rename must not half-apply')
    // Renaming to its own name is not a conflict.
    assert.equal(updateProject(db, userId, String(project.id), { name: '自己的' }, NOW).name, '自己的')
  } finally {
    close()
  }
})

test('projects: an archived project refuses edits until it is restored', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    archiveProject(db, userId, String(project.id), { now: NOW })
    assert.throws(
      () => updateProject(db, userId, String(project.id), { name: 'Q' }, NOW),
      /已归档项目不能修改/,
    )
    unarchiveProject(db, userId, String(project.id), NOW)
    assert.equal(updateProject(db, userId, String(project.id), { name: 'Q' }, NOW).name, 'Q')
  } finally {
    close()
  }
})

test('projects: archiving is refused while a session is running, and is idempotent', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    insertRow(
      db,
      'practice_session',
      { user_id: userId, project_id: project.id, subject_id: subject.id, mode: 'practice', status: 'active', policy_version: 'v1', note: '' },
      { now: NOW },
    )
    assert.throws(
      () => archiveProject(db, userId, String(project.id), { now: NOW }),
      (error: unknown) => error instanceof InvalidInput && /进行中的练习会话/.test(error.message),
    )

    // Close the session, then archive twice: the second call must not error.
    db.prepare('UPDATE "practice_session" SET "status" = ? WHERE "project_id" = ?').run('finished', String(project.id))
    const first = archiveProject(db, userId, String(project.id), { now: NOW, reason: '换项目' })
    assert.equal(first.is_archived, true)
    const second = archiveProject(db, userId, String(project.id), { now: NOW })
    assert.equal(second.is_archived, true, 'a repeated archive is a no-op, not a failure')
    assert.equal(findRows(db, 'audit_content_revision', { action: 'archive' }).length, 1, 'and it is audited once')
  } finally {
    close()
  }
})

test('subjects: created under a project in order, refused when empty or archived', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const s1 = createSubject(db, userId, String(project.id), { name: ' 高数 ', code: 'x'.repeat(60) }, NOW)
    assert.equal(s1.name, '高数')
    assert.equal(String(s1.code).length, 40, 'code is capped at 40')
    assert.equal(s1.display_order, 1)
    assert.equal(s1.project_id, String(project.id))

    assert.throws(() => createSubject(db, userId, String(project.id), { name: '' }, NOW), /科目名称不能为空/)
    assert.throws(() => createSubject(db, userId, String(project.id), { name: '高数' }, NOW), /该项目下已存在同名科目/)

    assert.equal(listSubjects(db, userId, String(project.id)).length, 1)
    assert.equal(getProject(db, userId, String(project.id)).subject_count, 1)

    archiveProject(db, userId, String(project.id), { now: NOW })
    assert.throws(() => createSubject(db, userId, String(project.id), { name: '线代' }, NOW), /已归档项目不能新增科目/)
  } finally {
    close()
  }
})

test('subjects: scores are decimal strings, not floats', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(
      db,
      userId,
      String(project.id),
      { name: 'S', total_score: '150.00', pass_score: '90' },
      NOW,
    )
    assert.equal(subject.total_score, '150.00', 'the scale is preserved')
    // Django stores a DecimalField quantised to its `decimal_places` (2 here).
    assert.equal(subject.pass_score, '90.00')
  } finally {
    close()
  }
})

// ---------------------------------------------------------------------------
// Exam spec versions and syllabus versions
// ---------------------------------------------------------------------------

test('specs: a version number increments and rules are validated before writing', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)

    const first = createSpecVersion(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), name: '2026 规则', question_type_rules: { single_choice: { default_max_score: '2' } } },
      NOW,
    )
    assert.equal(first.version, 1)
    assert.equal(first.status, 'draft')
    assert.equal(first.is_usable, false, 'a draft spec is not usable')
    assert.deepEqual(first.rule_summary, {
      single_choice: {
        default_max_score: '2',
        wrong_score: '0.00',
        blank_score: '0.00',
        policy: 'exact_match',
        partial_score: null,
        mismatch_policy: 'review',
      },
    })

    const second = createSpecVersion(db, userId, String(project.id), { subject_id: String(subject.id) }, NOW)
    assert.equal(second.version, 2)

    // A rejected rule set must not leave a row behind.
    assert.throws(
      () =>
        createSpecVersion(
          db,
          userId,
          String(project.id),
          { subject_id: String(subject.id), question_type_rules: { bogus: {} } },
          NOW,
        ),
      /未知题型：bogus/,
    )
    assert.equal(listSpecVersions(db, userId, String(project.id)).length, 2, 'no row from the refused spec')
  } finally {
    close()
  }
})

test('specs: publishing needs at least one rule and is idempotent', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)

    const empty = createSpecVersion(db, userId, String(project.id), { subject_id: String(subject.id) }, NOW)
    assert.throws(
      () => publishSpecVersion(db, userId, String(project.id), String(empty.id), NOW),
      /发布规范前必须配置至少一种题型的计分规则/,
    )

    const ready = createSpecVersion(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), question_type_rules: { true_false: { default_max_score: '1' } } },
      NOW,
    )
    const published = publishSpecVersion(db, userId, String(project.id), String(ready.id), NOW)
    assert.equal(published.status, 'published')
    assert.equal(published.is_usable, true)
    assert.equal(published.published_at, '2026-03-01T00:00:00+00:00')

    // Publishing again is a no-op and does not write a second audit row.
    const again = publishSpecVersion(db, userId, String(project.id), String(ready.id), NOW)
    assert.equal(again.status, 'published')
    assert.equal(findRows(db, 'audit_content_revision', { action: 'publish', entity_id: String(ready.id) }).length, 1)
  } finally {
    close()
  }
})

test('specs: a spec from another project is not reachable', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const mine = createProject(db, userId, { name: 'Mine' }, NOW)
    const other = createProject(db, userId, { name: 'Other' }, NOW)
    const otherSubject = createSubject(db, userId, String(other.id), { name: 'S' }, NOW)
    const spec = createSpecVersion(db, userId, String(other.id), { subject_id: String(otherSubject.id) }, NOW)
    assert.throws(
      () => publishSpecVersion(db, userId, String(mine.id), String(spec.id), NOW),
      /规范版本不存在或不属于该项目/,
    )
  } finally {
    close()
  }
})

test('syllabus: name is required and publishing keeps the honest provisional flag', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    assert.throws(
      () => createSyllabusVersion(db, userId, String(project.id), { subject_id: String(subject.id), name: '  ' }, NOW),
      /大纲名称不能为空/,
    )

    const syllabus = createSyllabusVersion(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), name: ' 高数大纲 ', version_label: 'v1', is_user_provisional: true },
      NOW,
    )
    assert.equal(syllabus.name, '高数大纲', 'the name is trimmed')
    assert.equal(syllabus.status, 'draft')
    assert.equal(syllabus.node_count, 0)

    const published = publishSyllabusVersion(db, userId, String(project.id), String(syllabus.id), NOW)
    assert.equal(published.status, 'published')
    assert.equal(published.review_status, 'approved')
    assert.equal(published.is_user_provisional, true, 'a user outline is never relabelled official')

    assert.equal(publishSyllabusVersion(db, userId, String(project.id), String(syllabus.id), NOW).status, 'published')
    assert.equal(listSyllabusVersions(db, userId, String(project.id)).length, 1)
  } finally {
    close()
  }
})

// ---------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------

/** Fill every NOT NULL column the schema declares, so a fixture cannot drift with the model. */
function completeRow(db: DatabaseSync, table: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const row: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey) continue
    if (column.name in overrides) {
      row[column.name] = overrides[column.name]
      continue
    }
    if (!column.notNull) continue
    const fk = foreignKeys.get(column.name)
    if (fk) {
      row[column.name] = String(overrides[`__fk_${column.name}`] ?? `fk-${fk.refTable}`)
      continue
    }
    row[column.name] = column.json ? {} : column.kind === 'datetime' ? NOW : column.kind === 'int' ? 0 : column.kind === 'bool' ? 0 : column.kind === 'decimal' ? null : ''
  }
  Object.assign(row, overrides)
  return row
}

test('papers: re-registering the same natural key reuses the occurrence', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    const key = { subject_id: String(subject.id), cycle_key: '2025', paper_code: 'A' }

    const first = registerPaper(db, userId, String(project.id), key, NOW)
    assert.equal(first.created, true)
    assert.equal(first.paper.is_demo, true, 'the default source kind is demo')

    const again = registerPaper(db, userId, String(project.id), { ...key, cycle_key: ' 2025 ' }, NOW)
    assert.equal(again.created, false, 'the same paper must not be counted twice')
    assert.equal(again.paper.id, first.paper.id)
    assert.equal(findRows(db, 'exams_paper', {}).length, 1)
  } finally {
    close()
  }
})

test('papers: an official past paper is not marked as demo', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    const official = registerPaper(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), cycle_key: '2024', paper_code: 'B', source_kind: 'official_past' },
      NOW,
    )
    assert.equal(official.paper.is_demo, false, 'a real past paper must not be labelled demo')
    const mock = registerPaper(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), cycle_key: '2024', paper_code: 'C', source_kind: 'mock' },
      NOW,
    )
    assert.equal(mock.paper.is_demo, true, 'a mock is not a real paper')
  } finally {
    close()
  }
})

test('papers: empty keys and unknown source kinds are refused', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    const base = { subject_id: String(subject.id), cycle_key: '2025', paper_code: 'A' }
    assert.throws(() => registerPaper(db, userId, String(project.id), { ...base, cycle_key: '  ' }, NOW), /年份\/周期与卷别代码不能为空/)
    assert.throws(() => registerPaper(db, userId, String(project.id), { ...base, paper_code: ' ' }, NOW), /年份\/周期与卷别代码不能为空/)
    assert.throws(
      () => registerPaper(db, userId, String(project.id), { ...base, source_kind: 'leaked' }, NOW),
      /试卷来源类型无效/,
    )
    assert.equal(findRows(db, 'exams_paper', {}).length, 0, 'a refused registration writes nothing')
  } finally {
    close()
  }
})

test('coverage: unknown until both counts are typed, incomplete until a human confirms', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    const paper = registerPaper(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), cycle_key: '2025', paper_code: 'A' },
      NOW,
    ).paper
    const revision = insertRow(
      db,
      'exams_paper_revision',
      { paper_id: paper.id, revision: 1, status: 'draft', expected_session_count: null, covered_session_count: null, note: '' },
      { now: NOW },
    )

    const unknown = recordPaperCoverage(db, userId, String(project.id), String(revision.id), {}, NOW)
    assert.equal(unknown.coverage_status, 'coverage_unknown')
    assert.match(String(unknown.coverage_status), /^coverage_/)

    // Counts alone are an intention, not a confirmation.
    const typed = recordPaperCoverage(
      db,
      userId,
      String(project.id),
      String(revision.id),
      { expected_session_count: 2, covered_session_count: 2 },
      NOW,
    )
    assert.equal(typed.coverage_status, 'coverage_incomplete', 'typing the counts is not confirmation')

    const confirmed = recordPaperCoverage(
      db,
      userId,
      String(project.id),
      String(revision.id),
      { expected_session_count: 2, covered_session_count: 2, confirm: true },
      NOW,
    )
    assert.equal(confirmed.coverage_status, 'coverage_complete')
    assert.equal(confirmed.coverage_confirmed_by, userId)
  } finally {
    close()
  }
})

test('coverage: confirming an under-covered cycle is refused', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    const paper = registerPaper(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), cycle_key: '2025', paper_code: 'A' },
      NOW,
    ).paper
    const revision = insertRow(
      db,
      'exams_paper_revision',
      { paper_id: paper.id, revision: 1, status: 'draft', expected_session_count: null, covered_session_count: null, note: '' },
      { now: NOW },
    )
    // Neither count given: nothing to confirm.
    assert.throws(
      () => recordPaperCoverage(db, userId, String(project.id), String(revision.id), { confirm: true }, NOW),
      /确认覆盖前必须填写/,
    )
    assert.throws(
      () =>
        recordPaperCoverage(
          db,
          userId,
          String(project.id),
          String(revision.id),
          { expected_session_count: 2, covered_session_count: 1, confirm: true },
          NOW,
        ),
      /已覆盖场次少于预期场次，不能标记为完整周期/,
    )
    assert.throws(
      () =>
        recordPaperCoverage(db, userId, String(project.id), String(revision.id), { expected_session_count: 0 }, NOW),
      /预期场次必须是正整数/,
    )
  } finally {
    close()
  }
})

test('papers: confirming a revision needs a scored item and then becomes effective', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    const paper = registerPaper(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), cycle_key: '2025', paper_code: 'A' },
      NOW,
    ).paper
    const revision = insertRow(
      db,
      'exams_paper_revision',
      { paper_id: paper.id, revision: 1, status: 'draft', expected_session_count: null, covered_session_count: null, note: '' },
      { now: NOW },
    )
    assert.throws(
      () => confirmPaperRevision(db, userId, String(project.id), String(revision.id), NOW),
      /该版本还没有任何计分题项/,
    )

    const question = insertRow(
      db,
      'question_bank_question',
      { subject_id: subject.id, origin_type: 'import', is_demo: false, display_label: '' },
      { now: NOW },
    )
    const version = insertRow(
      db,
      'question_bank_question_version',
      completeRow(db, 'question_bank_question_version', { question_id: question.id, version: 1 }),
      { now: NOW },
    )
    insertRow(
      db,
      'exams_paper_item',
      { revision_id: revision.id, position_key: '1', question_version_id: version.id, answer_key_version_id: null, max_score: '2.00', is_scored: true, is_demo: false },
      { now: NOW },
    )

    const confirmed = confirmPaperRevision(db, userId, String(project.id), String(revision.id), NOW)
    assert.equal(confirmed.status, 'confirmed')
    assert.equal(confirmed.item_count, 1)
    assert.equal(confirmed.scored_item_count, 1)
    assert.equal(getPaper(db, userId, String(project.id), String(paper.id)).effective_revision_id, String(revision.id))
  } finally {
    close()
  }
})

test('papers: a withdrawn revision cannot be made effective', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const project = createProject(db, userId, { name: 'P' }, NOW)
    const subject = createSubject(db, userId, String(project.id), { name: 'S' }, NOW)
    const paper = registerPaper(
      db,
      userId,
      String(project.id),
      { subject_id: String(subject.id), cycle_key: '2025', paper_code: 'A' },
      NOW,
    ).paper
    const revision = insertRow(
      db,
      'exams_paper_revision',
      { paper_id: paper.id, revision: 1, status: 'withdrawn', expected_session_count: null, covered_session_count: null, note: '' },
      { now: NOW },
    )
    assert.throws(
      () => setEffectiveRevision(db, userId, String(project.id), String(paper.id), String(revision.id), NOW),
      /已撤回版本不能设为有效版本/,
    )
    assert.throws(
      () => recordPaperCoverage(db, userId, String(project.id), String(revision.id), {}, NOW),
      /已撤回的试卷版本不能登记覆盖情况/,
    )
  } finally {
    close()
  }
})
