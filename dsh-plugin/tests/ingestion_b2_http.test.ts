/**
 * O18 over HTTP: publish a proofread candidate.
 *
 * The cases mirror `scripts/probe_ingestion_b2.py` (real Django, 40 recorded requests): the status
 * code, the error envelope, the response projection and the row-level effect are all pinned to what
 * the Django API returned, not to what this port would like to return.
 *
 * Two transport details are specific to O18 and are the reason for several cases:
 * - the stored idempotent body carries `question_id` but the declared `CandidateOut` response model
 *   drops it, so a replay must return the *projected* body while the store keeps the extra key;
 * - the spec is validated before the Idempotency-Key, so a bad spec is a 404/400 even when the key
 *   is missing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { parsePaste } from '../src/domain/ingestion/text_parser.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSpecVersion, createSubject, publishSpecVersion } from '../src/services/exams.ts'
import { createCandidate, createImportJob, createSourceRegion, createTextDocument } from '../src/services/ingestion.ts'
import { startTextImport } from '../src/services/ingestion_imports.ts'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')

/** Fill the NOT NULL columns a fixture does not care about with their model defaults. */
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
const BASE = 'http://host/api/acepass'
const ONE_QUESTION = '【题型】单选\n【题干】下列哪项是质数？\n【选项】\nA. 4\nB. 7\nC. 9\n【答案】B\n'

function harness() {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const userId = String(
    insertRow(
      db,
      'accounts_user',
      {
        password: '!',
        email: 'owner@acepass.local',
        display_name: '本机用户',
        is_active: true,
        is_staff: false,
        is_superuser: false,
        date_joined: NOW,
      },
      { now: NOW },
    ).id,
  )
  const projectId = String(createProject(db, userId, { name: '导入发布' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id)
  const specId = String(
    createSpecVersion(
      db,
      userId,
      projectId,
      {
        subject_id: subjectId,
        name: '数学规范',
        question_type_rules: {
          single_choice: { default_max_score: '2.00', wrong_score: '0.00', blank_score: '0.00' },
        },
      },
      NOW,
    ).id,
  )
  publishSpecVersion(db, userId, projectId, specId, NOW)
  const draftSpecId = String(
    createSpecVersion(
      db,
      userId,
      projectId,
      {
        subject_id: subjectId,
        name: '草稿规范',
        question_type_rules: { single_choice: { default_max_score: '2.00' } },
      },
      NOW,
    ).id,
  )
  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId, now }),
    newRequestId: () => 'req-fixed',
  })
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> => {
    const request = new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  const counts = (): Record<string, number> => {
    const tables = [
      'question_bank_question',
      'question_bank_question_version',
      'question_bank_answer_key_version',
      'question_bank_rubric_version',
      'question_bank_source_link',
      'knowledge_question_mapping',
      'exams_paper_item',
      'audit_content_revision',
      'audit_outbox_event',
      'audit_idempotency_record',
    ]
    const out: Record<string, number> = {}
    for (const table of tables) {
      out[table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n)
    }
    return out
  }
  return {
    db,
    userId,
    projectId,
    subjectId,
    specId,
    draftSpecId,
    call,
    counts,
    setNow: (value: Instant) => {
      now = value
    },
    close: handle.close,
  }
}

type Harness = ReturnType<typeof harness>

function publishPath(h: Harness, candidateId: string): string {
  return `/projects/${h.projectId}/import-candidates/${candidateId}/publish`
}

function importOne(h: Harness): string {
  const job = startTextImport(
    h.db,
    {
      ownerId: h.userId,
      projectId: h.projectId,
      subjectId: h.subjectId,
      text: ONE_QUESTION,
      title: '',
      sourceNote: '',
      usageScope: '',
      segments: parsePaste(ONE_QUESTION),
    },
    NOW,
  )
  return String(job.id)
}

/** A ready candidate built through the text import path (the parser produces the payload). */
function importedCandidate(h: Harness): string {
  const job = importOne(h)
  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: job })
  assert.equal(candidates.length, 1)
  return String(candidates[0].id)
}

/** A candidate in a controlled state, for paper/material cases the text path cannot express. */
function rawCandidate(
  h: Harness,
  options: {
    payload: Record<string, unknown>
    parentCandidateId?: string | null
    paperRevisionId?: string | null
    positionKey?: string
    inputKind?: string
    label?: string
  },
): string {
  const label = options.label ?? 'fixture'
  const document = createTextDocument(
    h.db,
    {
      ownerId: h.userId,
      projectId: h.projectId,
      subjectId: h.subjectId,
      text: `${label} 来源`,
      title: label,
    },
    NOW,
  )
  const job = createImportJob(
    h.db,
    {
      ownerId: h.userId,
      projectId: h.projectId,
      subjectId: h.subjectId,
      inputKind: options.inputKind ?? 'text',
      inputText: `fixture:${label}`,
    },
    NOW,
  )
  const region = createSourceRegion(h.db, { documentId: String(document.id), x: 0, y: 0, width: 1, height: 0.05 }, NOW)
  const candidate = createCandidate(
    h.db,
    {
      job,
      payload: options.payload,
      subjectId: h.subjectId,
      regionIds: [String(region.id)],
      parentCandidateId: options.parentCandidateId ?? null,
      paperRevisionId: options.paperRevisionId ?? null,
      sourcePositionKey: options.positionKey ?? '',
    },
    NOW,
  )
  return String(candidate.id)
}

function paperRevision(h: Harness, paperCode = '卷一'): string {
  const subject = findOne(h.db, 'exams_subject', { id: h.subjectId })!
  const paper = insertRow(
    h.db,
    'exams_paper',
    completeRow('exams_paper', {
      subject_id: subject.id,
      cycle_key: '2025',
      session_key: '',
      paper_code: paperCode,
      title: '',
      source_kind: 'official_past',
      is_demo: false,
      notes: '',
      effective_revision_id: null,
    }),
    { now: NOW },
  )
  return String(
    insertRow(
      h.db,
      'exams_paper_revision',
      completeRow('exams_paper_revision', {
        paper_id: paper.id,
        revision: 1,
        spec_version_id: h.specId,
        status: 'draft',
        note: '',
      }),
      { now: NOW },
    ).id,
  )
}

function singleChoicePayload(label: string, score = '2.00'): Record<string, unknown> {
  return {
    question_type: 'single_choice',
    display_label: '',
    content: {
      blocks: [{ kind: 'text', text: `${label} 题干` }],
      options: [
        { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '甲' }] },
        { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '乙' }] },
      ],
    },
    answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
    answer_status_known: true,
    explanation_blocks: [],
    practice_max_score: score,
  }
}

// --------------------------------------------------------------------------
// happy path, projection and idempotency
// --------------------------------------------------------------------------

test('ingestion B2: O18 publishes a candidate, and the wire body drops the stored question_id', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const before = h.counts()
    const response = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-ok' },
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.status, 'published')
    assert.ok(response.body.publication_question_id)
    assert.ok(response.body.publication_version_id)
    // `CandidateOut` does not declare `question_id`; Ninja filters it out of the wire response.
    assert.equal('question_id' in response.body, false)
    assert.equal(response.body.revision, 1, 'publication does not bump the candidate revision')

    const stored = findOne(h.db, 'audit_idempotency_record', { idempotency_key: 'publish-ok' })!
    const storedBody = stored.response_body as Record<string, unknown>
    assert.ok('question_id' in storedBody, 'the idempotent result keeps question_id')
    assert.equal(storedBody['id'], candidateId)
    assert.equal(stored.resource_type, 'import_candidate')

    const question = findOne(h.db, 'question_bank_question', { id: response.body.publication_question_id })!
    const version = findOne(h.db, 'question_bank_question_version', { id: response.body.publication_version_id })!
    assert.equal(question.current_published_version_id, version.id)
    assert.equal(version.status, 'published')
    assert.equal(String(version.practice_max_score), '2.00')
    assert.equal(version.revision_reason, `由导入候选 ${candidateId} 发布`)
    const answers = findRows(h.db, 'question_bank_answer_key_version', { question_version_id: version.id })
    assert.equal(answers.length, 1)
    assert.equal(answers[0].verification_status, 'checked')
    assert.equal(answers[0].check_basis, '人工校对确认（导入流程）')
    assert.equal(findRows(h.db, 'question_bank_source_link', { question_version_id: version.id }).length, 1)

    const job = findOne(h.db, 'ingestion_import_job', { id: findOne(h.db, 'ingestion_import_candidate', { id: candidateId })!.job_id })!
    assert.equal(job.status, 'completed')
    assert.equal(job.progress_percent, 100)

    const after = h.counts()
    assert.equal(after['question_bank_question'] - before['question_bank_question'], 1)
    assert.equal(after['question_bank_question_version'] - before['question_bank_question_version'], 1)
    assert.equal(after['question_bank_answer_key_version'] - before['question_bank_answer_key_version'], 1)
    assert.equal(after['audit_outbox_event'] - before['audit_outbox_event'], 0, 'no paper, no outbox event')
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 replay returns the original body and writes nothing', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const first = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-replay' },
    )
    assert.equal(first.status, 200)
    const before = h.counts()
    const replay = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-replay' },
    )
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.body, first.body)
    assert.deepEqual(h.counts(), before)
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 same key with a different body is a 409 and changes nothing', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-conflict' },
    )
    const before = h.counts()
    const response = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId, origin_type: 'demo' },
      { 'idempotency-key': 'publish-conflict' },
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'idempotency_conflict')
    assert.deepEqual(response.body.error.details, {
      route_scope: `candidates.publish:${candidateId}`,
      reason: 'same_key_different_payload',
    })
    assert.deepEqual(h.counts(), before)
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 without an Idempotency-Key is a 409 after the scope checks', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const response = await h.call('POST', publishPath(h, candidateId), {})
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'idempotency_conflict')
    assert.equal(response.body.error.message, '缺少 Idempotency-Key 请求头')
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 publishes an already-published candidate without creating a second version', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const first = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-once' },
    )
    assert.equal(first.status, 200)
    const before = h.counts()
    const second = await h.call(
      'POST',
      publishPath(h, candidateId),
      {},
      { 'idempotency-key': 'publish-twice' },
    )
    assert.equal(second.status, 200)
    assert.equal(second.body.publication_version_id, first.body.publication_version_id)
    const after = h.counts()
    assert.equal(after['question_bank_question_version'], before['question_bank_question_version'])
    assert.equal(after['audit_idempotency_record'], before['audit_idempotency_record'] + 1)
  } finally {
    h.close()
  }
})

// --------------------------------------------------------------------------
// scope and spec validation
// --------------------------------------------------------------------------

test('ingestion B2: O18 refuses a candidate from another project with 404', async () => {
  const h = harness()
  try {
    const otherProject = createProject(h.db, h.userId, { name: '另一个项目' }, NOW)
    const otherSubject = createSubject(h.db, h.userId, String(otherProject.id), { name: '语文' }, NOW)
    const document = createTextDocument(
      h.db,
      { ownerId: h.userId, projectId: String(otherProject.id), subjectId: String(otherSubject.id), text: '别的项目' },
      NOW,
    )
    const job = createImportJob(
      h.db,
      {
        ownerId: h.userId,
        projectId: String(otherProject.id),
        subjectId: String(otherSubject.id),
        inputKind: 'text',
        inputText: 'foreign',
      },
      NOW,
    )
    const candidate = createCandidate(
      h.db,
      { job, payload: singleChoicePayload('foreign'), subjectId: String(otherSubject.id) },
      NOW,
    )
    void document
    const response = await h.call(
      'POST',
      publishPath(h, String(candidate.id)),
      {},
      { 'idempotency-key': 'publish-foreign' },
    )
    assert.equal(response.status, 404)
    assert.equal(response.body.error.code, 'not_found')
    assert.equal(response.body.error.message, '候选不存在或不属于该项目')
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 validates the spec before the key and refuses unknown or draft specs', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const unknown = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: '00000000-0000-0000-0000-000000000000' },
    )
    assert.equal(unknown.status, 404, 'spec check runs before the missing key')
    assert.equal(unknown.body.error.message, '考试规范版本不存在或不属于该项目')
    const draft = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.draftSpecId },
      { 'idempotency-key': 'publish-draft-spec' },
    )
    assert.equal(draft.status, 400)
    assert.equal(draft.body.error.message, '只能使用已发布的考试规范版本')
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 refuses a candidate with blocking issues with the problem list', async () => {
  const h = harness()
  try {
    // No score declared and no spec: the publish gate refuses with practice_max_score_missing.
    const candidateId = importedCandidate(h)
    const response = await h.call('POST', publishPath(h, candidateId), {}, { 'idempotency-key': 'publish-no-score' })
    assert.equal(response.status, 422)
    assert.equal(response.body.error.code, 'structure_invalid')
    assert.equal(response.body.error.message, '发布前校验未通过')
    assert.deepEqual(response.body.error.details.problems, [
      {
        code: 'practice_max_score_missing',
        message: '未填写练习分值，且未显式采用所选考试规范的题型默认分值',
        path: 'practice_max_score',
      },
    ])
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 refuses an ignored candidate', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const ignored = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidateId}/ignore?reason=duplicate`,
      {},
      { 'idempotency-key': 'ignore-before-publish' },
    )
    assert.equal(ignored.status, 200)
    const response = await h.call('POST', publishPath(h, candidateId), {}, { 'idempotency-key': 'publish-ignored' })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.message, '已忽略的候选不能发布')
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 request-body validation keeps the Ninja loc shape', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const listShape = await h.call(
      'POST',
      publishPath(h, candidateId),
      { node_ids: 'abc' },
      { 'idempotency-key': 'shape-1' },
    )
    assert.equal(listShape.status, 400)
    assert.deepEqual(listShape.body.error.details.errors, [
      { type: 'list_type', loc: ['body', 'payload', 'node_ids'], msg: 'Input should be a valid list' },
    ])
    const itemShape = await h.call(
      'POST',
      publishPath(h, candidateId),
      { node_ids: [1] },
      { 'idempotency-key': 'shape-2' },
    )
    assert.equal(itemShape.status, 400)
    assert.deepEqual(itemShape.body.error.details.errors, [
      { type: 'string_type', loc: ['body', 'payload', 'node_ids', 0], msg: 'Input should be a valid string' },
    ])
    const labelShape = await h.call(
      'POST',
      publishPath(h, candidateId),
      { display_label: null },
      { 'idempotency-key': 'shape-3' },
    )
    assert.equal(labelShape.status, 400)
    assert.deepEqual(labelShape.body.error.details.errors, [
      { type: 'string_type', loc: ['body', 'payload', 'display_label'], msg: 'Input should be a valid string' },
    ])
  } finally {
    h.close()
  }
})

// --------------------------------------------------------------------------
// paper items and materials
// --------------------------------------------------------------------------

test('ingestion B2: O18 writes a scored PaperItem and enqueues the stats projection', async () => {
  const h = harness()
  try {
    const revisionId = paperRevision(h)
    const candidateId = rawCandidate(h, {
      payload: singleChoicePayload('paper'),
      paperRevisionId: revisionId,
      positionKey: '12',
    })
    const response = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-paper' },
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const item = findOne(h.db, 'exams_paper_item', { revision_id: revisionId, position_key: '12' })!
    assert.equal(String(item.max_score), '2.00')
    assert.equal(item.is_scored, true)
    assert.equal(item.answer_key_version_id !== null, true)
    assert.equal(response.body.publication_paper_item_id, item.id)
    const events = findRows(h.db, 'audit_outbox_event', { topic: 'projection.refresh_paper_stats' })
    assert.equal(events.length, 1)
    const paperId = String(findOne(h.db, 'exams_paper_revision', { id: revisionId })!.paper_id)
    assert.equal(events[0].dedupe_key, `paper-stats:${paperId}:${revisionId}`)
    const payload = events[0].payload as Record<string, unknown>
    assert.equal(String(payload['paper_id']), paperId)
  } finally {
    h.close()
  }
})

test('ingestion B2: re-importing the same paper position cannot publish twice', async () => {
  const h = harness()
  try {
    const revisionId = paperRevision(h)
    const firstId = rawCandidate(h, {
      payload: singleChoicePayload('paper-a'),
      paperRevisionId: revisionId,
      positionKey: '7',
    })
    const first = await h.call(
      'POST',
      publishPath(h, firstId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-pos-1' },
    )
    assert.equal(first.status, 200)
    const secondId = rawCandidate(h, {
      payload: singleChoicePayload('paper-b'),
      paperRevisionId: revisionId,
      positionKey: '7',
    })
    const before = h.counts()
    const second = await h.call(
      'POST',
      publishPath(h, secondId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-pos-2' },
    )
    assert.equal(second.status, 422)
    assert.equal(second.body.error.message, '候选仍有未解决的问题，不能发布')
    const codes = second.body.error.details.problems.map((problem: { code: string }) => problem.code)
    assert.deepEqual(codes, ['duplicate_paper_position'])
    assert.deepEqual(h.counts(), before, 'the refused publication wrote nothing')
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 publishes material children first and links their paper items to the parent', async () => {
  const h = harness()
  try {
    const revisionId = paperRevision(h)
    const materialPayload = {
      question_type: 'material',
      display_label: '',
      content: { blocks: [{ kind: 'text', text: '共享材料' }], options: [] },
      answer_payload: {},
      answer_status_known: true,
      explanation_blocks: [],
      practice_max_score: null,
    }
    const materialId = rawCandidate(h, {
      payload: materialPayload,
      paperRevisionId: revisionId,
      positionKey: '3',
    })
    const child1 = rawCandidate(h, {
      payload: singleChoicePayload('child-1'),
      parentCandidateId: materialId,
      paperRevisionId: revisionId,
      positionKey: '3.1',
    })
    const child2 = rawCandidate(h, {
      payload: singleChoicePayload('child-2'),
      parentCandidateId: materialId,
      paperRevisionId: revisionId,
      positionKey: '3.2',
    })

    // The material cannot be published before its children.
    const early = await h.call(
      'POST',
      publishPath(h, materialId),
      {},
      { 'idempotency-key': 'publish-material-early' },
    )
    assert.equal(early.status, 422)
    assert.ok(
      early.body.error.details.problems.some(
        (problem: { code: string }) => problem.code === 'material_children_unpublished',
      ),
    )

    for (const [id, key] of [
      [child1, 'publish-child-1'],
      [child2, 'publish-child-2'],
    ] as const) {
      const response = await h.call('POST', publishPath(h, id), {}, { 'idempotency-key': key })
      assert.equal(response.status, 200, JSON.stringify(response.body))
    }
    const parentBefore = findOne(h.db, 'ingestion_import_candidate', { id: materialId })!
    assert.ok(parentBefore.publication_version_id, 'publishing a child pre-creates the material version')
    const draft = findOne(h.db, 'question_bank_question_version', { id: parentBefore.publication_version_id })!
    assert.equal(draft.status, 'draft')

    const material = await h.call(
      'POST',
      publishPath(h, materialId),
      {},
      { 'idempotency-key': 'publish-material' },
    )
    assert.equal(material.status, 200, JSON.stringify(material.body))
    const materialVersion = findOne(h.db, 'question_bank_question_version', {
      id: material.body.publication_version_id,
    })!
    assert.equal(materialVersion.status, 'published')
    const children = findRows(h.db, 'ingestion_import_candidate', { parent_candidate_id: materialId })
    assert.deepEqual(
      (materialVersion.material_child_version_ids as string[]).map(String).sort(),
      children.map((child) => String(child.publication_version_id)).sort(),
    )
    const parentItem = findOne(h.db, 'exams_paper_item', {
      revision_id: revisionId,
      position_key: '3',
    })!
    assert.equal(parentItem.is_scored, false)
    assert.equal(String(parentItem.max_score), '0.00')
    for (const child of children) {
      const item = findOne(h.db, 'exams_paper_item', { question_version_id: child.publication_version_id })!
      assert.equal(item.parent_item_id, parentItem.id, 'the child item is linked to the material item')
    }
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 writes the mapping revision with equal Decimal weights', async () => {
  const h = harness()
  try {
    const syllabus = insertRow(
      h.db,
      'exams_syllabus_version',
      completeRow('exams_syllabus_version', {
        subject_id: h.subjectId,
        name: '大纲',
        version_label: 'v1',
        status: 'published',
        is_user_provisional: false,
      }),
      { now: NOW },
    )
    const node = insertRow(
      h.db,
      'knowledge_node',
      completeRow('knowledge_node', {
        syllabus_version_id: syllabus.id,
        canonical_name: '考点一',
        parent_id: null,
      }),
      { now: NOW },
    )
    const candidateId = importedCandidate(h)
    const response = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId, node_ids: [String(node.id)] },
      { 'idempotency-key': 'publish-mapping' },
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const mappings = findRows(h.db, 'knowledge_question_mapping', {
      question_version_id: response.body.publication_version_id,
    })
    assert.equal(mappings.length, 1)
    assert.equal(String(mappings[0].score_weight), '1.0000')
    assert.equal(mappings[0].mapping_revision, 1)
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 refuses three equally weighted nodes (Decimal sum is not exactly 1)', async () => {
  const h = harness()
  try {
    const syllabus = insertRow(
      h.db,
      'exams_syllabus_version',
      completeRow('exams_syllabus_version', {
        subject_id: h.subjectId,
        name: '大纲',
        version_label: 'v1',
        status: 'published',
        is_user_provisional: false,
      }),
      { now: NOW },
    )
    const nodes = ['一', '二', '三'].map((name) =>
      insertRow(
        h.db,
        'knowledge_node',
        completeRow('knowledge_node', {
          syllabus_version_id: syllabus.id,
          canonical_name: `考点${name}`,
          parent_id: null,
        }),
        { now: NOW },
      ),
    )
    const candidateId = importedCandidate(h)
    const before = h.counts()
    const response = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId, node_ids: nodes.map((node) => String(node.id)) },
      { 'idempotency-key': 'publish-three-nodes' },
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.error.details.total, '0.9999999999999999999999999999')
    assert.deepEqual(h.counts(), before, 'the failed publication rolled back every row')
  } finally {
    h.close()
  }
})

test('ingestion B2: O18 rolls the whole write-set back when the paper subject disagrees', async () => {
  const h = harness()
  try {
    const revisionId = paperRevision(h)
    const otherSubject = createSubject(h.db, h.userId, h.projectId, { name: '语文' }, NOW)
    const candidateId = rawCandidate(h, {
      payload: singleChoicePayload('mismatch'),
      paperRevisionId: revisionId,
      positionKey: '9',
    })
    // Move the candidate to another subject after the import: publishing must fail at the paper
    // item, and the question/version/answer created before it must disappear with the rollback.
    h.db
      .prepare('UPDATE "ingestion_import_candidate" SET "subject_id" = ? WHERE "id" = ?')
      .run(String(otherSubject.id), candidateId)
    const before = h.counts()
    const response = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-subject-mismatch' },
    )
    assert.equal(response.status, 404)
    assert.equal(response.body.error.message, '题目科目与试卷科目不一致')
    assert.deepEqual(h.counts(), before)
  } finally {
    h.close()
  }
})

test('ingestion B2: the publish fingerprint applies CandidatePublishIn defaults', async () => {
  const h = harness()
  try {
    const candidateId = importedCandidate(h)
    const first = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId },
      { 'idempotency-key': 'publish-defaults' },
    )
    assert.equal(first.status, 200)
    // The same request with the defaults spelled out is the same fingerprint, so it replays.
    const replay = await h.call(
      'POST',
      publishPath(h, candidateId),
      { exam_spec_version_id: h.specId, node_ids: [], origin_type: 'user_authored', display_label: '' },
      { 'idempotency-key': 'publish-defaults' },
    )
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.body, first.body)
  } finally {
    h.close()
  }
})

test('ingestion B2: an empty body is a valid publish request (all fields have defaults)', async () => {
  const h = harness()
  try {
    const candidateId = rawCandidate(h, { payload: singleChoicePayload('empty-body') })
    const response = await h.call(
      'POST',
      publishPath(h, candidateId),
      [],
      { 'idempotency-key': 'publish-array-body' },
    )
    // Ninja coerces a non-object body to an empty object; every field then takes its default.
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.status, 'published')
  } finally {
    h.close()
  }
})

test('ingestion B2: publishing a candidate without a source region still writes the version', async () => {
  const h = harness()
  try {
    const job = createImportJob(
      h.db,
      {
        ownerId: h.userId,
        projectId: h.projectId,
        subjectId: h.subjectId,
        inputKind: 'text',
        inputText: 'no-region',
      },
      NOW,
    )
    const candidate = createCandidate(
      h.db,
      { job, payload: singleChoicePayload('no-region'), subjectId: h.subjectId },
      NOW,
    )
    const response = await h.call(
      'POST',
      publishPath(h, String(candidate.id)),
      {},
      { 'idempotency-key': 'publish-no-region' },
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(
      findRows(h.db, 'question_bank_source_link', { question_version_id: response.body.publication_version_id }).length,
      0,
    )
  } finally {
    h.close()
  }
})
