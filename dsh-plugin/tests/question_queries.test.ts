import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import {
  createQuestionRevision,
  getQuestionPreview,
  getRubricVersion,
  listAnswerKeys,
  listQuestions,
  listSourceRegions,
  publishQuestionVersion,
} from '../src/services/questions.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import { toWireJson } from '../src/http/router.ts'
import { ScopeViolation } from '../src/services/errors.ts'
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
  blocks: [{ kind: 'text', text: '2+2 等于几？' }],
  options: [
    { id: 'opt_a', label: 'A', text: '3' },
    { id: 'opt_b', label: 'B', text: '4' },
  ],
}

function seeded() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'queries@example.com', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)
  const subjectId = String(subject.id)
  const syllabus = insertRow(
    db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', {
      subject_id: subjectId,
      name: '大纲',
      version_label: 'v1',
      status: 'published',
    }),
    { now: NOW },
  )
  const node = insertRow(
    db,
    'knowledge_node',
    completeRow('knowledge_node', {
      syllabus_version_id: syllabus.id,
      canonical_name: '导数',
      aliases: [],
      code: 'K1',
    }),
    { now: NOW },
  )
  return { db, close: handle.close, userId, projectId, subjectId, nodeId: String(node.id) }
}

function addQuestion(
  db: DatabaseSync,
  subjectId: string,
  overrides: Record<string, unknown> = {},
  now = NOW,
): string {
  const row = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', {
      subject_id: subjectId,
      display_label: '题目',
      origin_type: 'demo',
      is_demo: true,
      created_at: now,
      updated_at: now,
      ...overrides,
    }),
    { now },
  )
  return String(row.id)
}

function publish(
  s: ReturnType<typeof seeded>,
  questionId: string,
  options: { content?: Record<string, unknown>; score?: string; now?: typeof NOW } = {},
): { versionId: string; answerId: string } {
  const now = options.now ?? NOW
  const draft = createQuestionRevision(
    s.db,
    s.userId,
    s.projectId,
    questionId,
    {
      question_type: 'single_choice',
      content: options.content ?? CONTENT,
      practice_max_score: options.score ?? '2.00',
      estimated_seconds: 60,
    },
    now,
  )
  const answer = insertRow(
    s.db,
    'question_bank_answer_key_version',
    completeRow('question_bank_answer_key_version', {
      question_version_id: draft.id,
      version: 1,
      source_type: 'manual',
      verification_status: 'checked',
      check_basis: '对照教材',
      is_disputed: false,
      answer_payload: { kind: 'single_choice', correct_option_id: 'opt_b' },
    }),
    { now },
  )
  publishQuestionVersion(s.db, s.userId, s.projectId, String(draft.id), { now })
  return { versionId: String(draft.id), answerId: String(answer.id) }
}

test('questions list: metadata only, newest first, with the published version facts', () => {
  const s = seeded()
  try {
    const older = addQuestion(s.db, s.subjectId, { display_label: '旧题' }, NOW)
    const newer = addQuestion(
      s.db,
      s.subjectId,
      { display_label: '新题', origin_type: 'import', is_demo: false },
      parseInstant('2026-05-02T00:00:00+00:00'),
    )
    const { versionId } = publish(s, newer)
    insertRow(
      s.db,
      'knowledge_question_mapping',
      completeRow('knowledge_question_mapping', {
        question_version_id: versionId,
        node_id: s.nodeId,
        is_primary: true,
        score_weight: '1',
        mapping_revision: 1,
        template_id: null,
        note: '',
      }),
      { now: NOW },
    )

    const rows = listQuestions(s.db, s.projectId)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].id, newer, 'the newest question is first (-created_at)')
    assert.equal(rows[1].id, older)
    const published = rows[0]
    assert.equal(published.display_label, '新题')
    assert.equal(published.origin_type, 'import')
    assert.equal(published.is_demo, false)
    assert.equal(published.question_type, 'single_choice')
    assert.equal(published.published_version_id, versionId)
    assert.equal(published.latest_version, 1)
    assert.equal(published.has_trusted_answer, true)
    assert.deepEqual(published.knowledge_nodes, ['导数'])
    assert.equal(rows[1].published_version_id, null)
    assert.equal(rows[1].has_trusted_answer, false)
    assert.deepEqual(rows[1].knowledge_nodes, [])
  } finally {
    s.close()
  }
})

test('questions list: filters, search and paging behave like the Django queryset', () => {
  const s = seeded()
  try {
    const alpha = addQuestion(s.db, s.subjectId, { display_label: '导数应用' }, NOW)
    const beta = addQuestion(
      s.db,
      s.subjectId,
      { display_label: '积分应用', origin_type: 'import' },
      parseInstant('2026-05-02T00:00:00+00:00'),
    )
    publish(s, alpha)
    createQuestionRevision(
      s.db,
      s.userId,
      s.projectId,
      beta,
      { question_type: 'fill_blank', content: { blocks: [{ kind: 'text', text: '空' }], blanks: [{ blank_id: 'b1' }] } },
      NOW,
    )

    assert.deepEqual(listQuestions(s.db, s.projectId, { search: '积分' }).map((row) => row.id), [beta])
    assert.deepEqual(listQuestions(s.db, s.projectId, { originType: 'import' }).map((row) => row.id), [beta])
    assert.deepEqual(listQuestions(s.db, s.projectId, { status: 'published' }).map((row) => row.id), [alpha])
    assert.deepEqual(listQuestions(s.db, s.projectId, { questionType: 'fill_blank' }).map((row) => row.id), [beta])
    assert.deepEqual(listQuestions(s.db, s.projectId, { limit: 1 }).map((row) => row.id), [beta])
    assert.deepEqual(listQuestions(s.db, s.projectId, { limit: 1, offset: 1 }).map((row) => row.id), [alpha])
    assert.throws(() => listQuestions(s.db, s.projectId, { subjectId: 'nope' }), ScopeViolation)
  } finally {
    s.close()
  }
})

test('question preview: delivers the stem without answers and writes a stem_delivered exposure', () => {
  const s = seeded()
  try {
    const questionId = addQuestion(s.db, s.subjectId, { display_label: '预览题' })
    const { versionId } = publish(s, questionId)
    const preview = getQuestionPreview(s.db, s.userId, s.projectId, questionId, NOW)

    assert.equal(preview.id, questionId)
    assert.equal(preview.version_id, versionId)
    assert.equal(preview.question_type, 'single_choice')
    assert.deepEqual(preview.blank_ids, [])
    assert.deepEqual(preview.options, [
      { id: 'opt_a', label: 'A' },
      { id: 'opt_b', label: 'B' },
    ])
    const serialised = JSON.stringify(toWireJson(preview))
    assert.equal(serialised.includes('opt_b'), true, 'the option id is part of the stem payload')
    assert.equal(serialised.includes('correct_option_id'), false, 'never the answer')
    assert.equal(serialised.includes('answer_payload'), false)

    const exposures = findRows(s.db, 'practice_exposure_event', { question_id: questionId })
    assert.equal(exposures.length, 1)
    assert.equal(exposures[0].kind, 'stem_delivered')
    assert.equal(exposures[0].purpose, 'preview')
    assert.equal(exposures[0].source, 'question_detail')
    assert.equal(exposures[0].reveals_answer, false)
  } finally {
    s.close()
  }
})

test('question preview: sealed content is refused instead of delivered', () => {
  const s = seeded()
  try {
    const questionId = addQuestion(s.db, s.subjectId, {})
    publish(s, questionId)
    sealQuestion(s.db, { projectId: s.projectId, questionId, actorId: s.userId, reason: '模拟卷', now: NOW })
    assert.throws(() => getQuestionPreview(s.db, s.userId, s.projectId, questionId, NOW), /封存|保留/)
    assert.equal(findRows(s.db, 'practice_exposure_event', { question_id: questionId }).length, 0)
  } finally {
    s.close()
  }
})

test('question preview: a question without versions is a scope error', () => {
  const s = seeded()
  try {
    const questionId = addQuestion(s.db, s.subjectId, {})
    assert.throws(() => getQuestionPreview(s.db, s.userId, s.projectId, questionId, NOW), ScopeViolation)
  } finally {
    s.close()
  }
})

test('answer keys: metadata only, trusted and undisputed is usable', () => {
  const s = seeded()
  try {
    const questionId = addQuestion(s.db, s.subjectId, {})
    const { versionId } = publish(s, questionId)
    const pending = insertRow(
      s.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: versionId,
        version: 2,
        source_type: 'user',
        verification_status: 'pending',
        check_basis: '',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
      }),
      { now: NOW },
    )
    insertRow(
      s.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: versionId,
        version: 3,
        source_type: 'manual',
        verification_status: 'checked',
        check_basis: '有争议',
        is_disputed: true,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
      }),
      { now: NOW },
    )

    const rows = listAnswerKeys(s.db, s.projectId, questionId)
    assert.deepEqual(rows.map((row) => row.version), [3, 2, 1])
    assert.equal(rows[0].is_usable, false, 'a disputed key is never usable')
    assert.equal(rows[1].is_usable, false, 'a pending key is never usable')
    assert.equal(rows[2].is_usable, true)
    assert.equal(rows[1].id, String(pending.id))
    assert.equal(rows[2].check_basis, '对照教材')
    assert.equal(JSON.stringify(rows).includes('correct_option_id'), false, 'the payload is not exposed here')
  } finally {
    s.close()
  }
})

test('source regions: links join through to the region geometry and role', () => {
  const s = seeded()
  try {
    const questionId = addQuestion(s.db, s.subjectId, {})
    const { versionId } = publish(s, questionId)
    const document = insertRow(
      s.db,
      'ingestion_source_document',
      completeRow('ingestion_source_document', {
        owner_id: s.userId,
        project_id: s.projectId,
        subject_id: s.subjectId,
        title: 'paper.pdf',
      }),
      { now: NOW },
    )
    const region = insertRow(
      s.db,
      'ingestion_source_region',
      completeRow('ingestion_source_region', {
        document_id: document.id,
        page_index: 3,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        role: 'stem_crop',
      }),
      { now: NOW },
    )
    insertRow(
      s.db,
      'question_bank_source_link',
      completeRow('question_bank_source_link', {
        question_version_id: versionId,
        region_id: region.id,
        role: 'stem',
        note: '',
      }),
      { now: NOW },
    )
    const rows = listSourceRegions(s.db, s.projectId, questionId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, String(region.id))
    assert.equal(rows[0].document_id, String(document.id))
    assert.equal(rows[0].page_index, 3)
    assert.equal(rows[0].role, 'stem')
    assert.equal(rows[0].crop_asset_id, null)
  } finally {
    s.close()
  }
})

test('rubric: the total score is a decimal string and the project scope is enforced', () => {
  const s = seeded()
  try {
    const questionId = addQuestion(s.db, s.subjectId, {})
    const { answerId } = publish(s, questionId)
    const rubric = insertRow(
      s.db,
      'question_bank_rubric_version',
      completeRow('question_bank_rubric_version', {
        answer_key_version_id: answerId,
        version: 1,
        criteria: { items: [{ id: 'p1', max_score: '2.00' }] },
        total_score: '2.00',
        usage_note: '按步骤给分',
        is_disputed: false,
      }),
      { now: NOW },
    )
    const payload = getRubricVersion(s.db, s.projectId, String(rubric.id))
    assert.equal(payload.usage_note, '按步骤给分')
    assert.equal(String(payload.total_score), '2.00')
    assert.deepEqual(payload.criteria, { items: [{ id: 'p1', max_score: '2.00' }] })
    assert.throws(() => getRubricVersion(s.db, 'other-project', String(rubric.id)), ScopeViolation)
    assert.throws(() => getRubricVersion(s.db, s.projectId, 'missing'), ScopeViolation)
  } finally {
    s.close()
  }
})

test('questions list: a forged subject from another project is not readable', () => {
  const s = seeded()
  try {
    const other = createProject(s.db, s.userId, { name: 'P2' }, NOW)
    addQuestion(s.db, s.subjectId, {})
    assert.equal(listQuestions(s.db, String(other.id)).length, 0)
  } finally {
    s.close()
  }
})
