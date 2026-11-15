/**
 * B8 practice write paths: reveal, draft, confirm-grade, grading queue, attachment submission.
 *
 * Every case drives the real router (`createFetchHandler` over `acepassRoutes()`), so what is pinned
 * here is the HTTP contract the browser pages already speak — not a service call in isolation.
 * Django parity source: `apps/practice/api.py:369-700, 843-915` and
 * `apps/practice/services/{sessions,attempts}.py`.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-12-15T00:00:00+00:00')
const BASE = 'http://host/api/acepass'

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

const SINGLE_CONTENT = {
  blocks: [{ kind: 'text', text: '1+1 等于几？' }],
  options: [
    { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '1' }] },
    { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '2' }] },
  ],
}

const RUBRIC = [
  { criterion_id: 'c1', text: '正确列出已知条件', max_score: '4', required: true },
  { criterion_id: 'c2', text: '推导过程正确', max_score: '3', required: true },
  { criterion_id: 'c3', text: '结论正确', max_score: '3', required: true },
]

function harness() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 's@example.com', date_joined: NOW }), {
    now: NOW,
  })
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)
  const subjectId = String(subject.id)
  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId, now }),
  })
  let counter = 0
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    let body: string | undefined
    if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && headers['idempotency-key'] === undefined) {
      headers['idempotency-key'] = `k-${++counter}`
    }
    const response = await handler(
      new Request(`${BASE}${path}`, { method, headers, body }),
    )
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }

  const makeQuestion = (options: {
    label: string
    type?: string
    content?: Record<string, unknown>
    answer?: Record<string, unknown>
    maxScore?: string
    rubric?: boolean
    rubricTotal?: string
  }) => {
    const type = options.type ?? 'single_choice'
    const question = insertRow(
      db,
      'question_bank_question',
      completeRow('question_bank_question', { subject_id: subject.id, origin_type: 'import', is_demo: false, display_label: options.label }),
      { now: NOW },
    )
    const maxScore = options.maxScore ?? '2.00'
    const draft = createQuestionRevision(
      db,
      userId,
      projectId,
      String(question.id),
      {
        question_type: type,
        content: options.content ?? SINGLE_CONTENT,
        practice_max_score: maxScore,
      },
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
        answer_payload: options.answer ?? { kind: 'single_choice', correct_option_id: 'opt_b' },
        check_basis: '教材',
        explanation_blocks: [{ kind: 'text', text: '因为 1+1=2。' }],
      }),
      { now: NOW },
    )
    if (options.rubric === true) {
      insertRow(
        db,
        'question_bank_rubric_version',
        completeRow('question_bank_rubric_version', {
          answer_key_version_id: answer.id,
          version: 1,
          criteria: RUBRIC,
          total_score: options.rubricTotal ?? maxScore,
          is_disputed: false,
        }),
        { now: NOW },
      )
    }
    publishQuestionVersion(db, userId, projectId, String(draft.id), { allowWithoutScore: true, now: NOW })
    return { questionId: String(question.id), versionId: String(draft.id), answerKeyId: String(answer.id) }
  }

  const startSession = async (
    questionIds: string[],
    mode = 'practice',
    extra: Record<string, unknown> = {},
  ): Promise<{ sessionId: string; itemIds: string[] }> => {
    const created = await call('POST', `/projects/${projectId}/practice-sessions`, {
      body: { subject_id: subjectId, mode, question_ids: questionIds, ...extra },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const items = findRows(db, 'practice_session_item', { session_id: created.body.session_id })
    return { sessionId: String(created.body.session_id), itemIds: items.map((row) => String(row.id)) }
  }

  return { db, close: handle.close, userId, projectId, subjectId, call, makeQuestion, startSession, setNow: (value: Instant) => { now = value } }
}

const IMAGE_CONTENT = {
  blocks: [
    { kind: 'text', text: '看图作答' },
    { kind: 'image', asset_id: '3f6f2b1e-0b7a-4c4e-9f0e-6d6f2a1b3c4d' },
  ],
  options: [
    { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '1' }] },
    { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '2' }] },
  ],
}

test('b8 practice: reveal before submit returns the trusted answer and records the exposure', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'R1' })
    const { itemIds } = await h.startSession([q.questionId])
    const presented = await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    assert.equal(presented.status, 200)

    const reveal = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/reveal`)
    assert.equal(reveal.status, 200)
    assert.equal(reveal.body.answer_payload.correct_option_id, 'opt_b')
    assert.equal(reveal.body.answer_verification_status, 'checked')
    assert.equal(reveal.body.exposure_recorded, true)

    const exposures = findRows(h.db, 'practice_exposure_event', { session_item_id: itemIds[0] })
    const revealed = exposures.filter((row) => row.kind === 'answer_delivered')
    assert.equal(revealed.length, 1)
    assert.equal(revealed[0].source, 'session_item_reveal')
    assert.equal(revealed[0].purpose, 'practice')
    assert.equal((revealed[0].detail as Record<string, unknown>).before_submit, true)
  } finally {
    h.close()
  }
})

test('b8 practice: reveal on a running verification item is refused with purpose_not_allowed', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'V1' })
    const { itemIds } = await h.startSession([q.questionId], 'verification')
    await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    const reveal = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/reveal`)
    assert.equal(reveal.status, 403)
    assert.equal(reveal.body.error.code, 'purpose_not_allowed')
  } finally {
    h.close()
  }
})

test('b8 practice: after submitting, reveal uses the stable attempt route and marks after_submit', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'A1' })
    const { itemIds } = await h.startSession([q.questionId])
    await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    const submitted = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/submit`, {
      body: { answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
    })
    assert.equal(submitted.status, 200)
    const attemptId = submitted.body.attempt_id as string

    const reveal = await h.call('POST', `/projects/${h.projectId}/attempts/${attemptId}/reveal`)
    assert.equal(reveal.status, 200)
    assert.equal(reveal.body.answer_payload.correct_option_id, 'opt_b')
    const exposure = findRows(h.db, 'practice_exposure_event', { session_item_id: itemIds[0] }).find(
      (row) => row.source === 'attempt_reveal',
    )
    assert.ok(exposure, 'attempt reveal must be recorded')
    assert.equal((exposure!.detail as Record<string, unknown>).after_submit, true)
  } finally {
    h.close()
  }
})

test('b8 practice: a practice item whose content is inside a running verification cannot be revealed', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'X1' })
    const verification = await h.startSession([q.questionId], 'verification')
    await h.call('GET', `/projects/${h.projectId}/session-items/${verification.itemIds[0]}/presentation`)
    const practice = await h.startSession([q.questionId])
    await h.call('GET', `/projects/${h.projectId}/session-items/${practice.itemIds[0]}/presentation`)
    const reveal = await h.call('POST', `/projects/${h.projectId}/session-items/${practice.itemIds[0]}/reveal`)
    assert.equal(reveal.status, 403)
    assert.equal(reveal.body.error.code, 'purpose_not_allowed')
    assert.equal(reveal.body.error.details.reason, 'active_verification_content_gate')
  } finally {
    h.close()
  }
})

test('b8 practice: draft autosave enforces the revision and refuses an answered item', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'D1' })
    const { itemIds } = await h.startSession([q.questionId])
    await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)

    const first = await h.call('PUT', `/projects/${h.projectId}/session-items/${itemIds[0]}/draft`, {
      body: { draft: { draft_version: 2, answer: { selected_option_id: 'opt_b' }, asset_ids: [] }, draft_revision: 0 },
    })
    assert.equal(first.status, 200)
    assert.equal(first.body.draft_revision, 1)
    assert.equal(first.body.saved, true)

    const stale = await h.call('PUT', `/projects/${h.projectId}/session-items/${itemIds[0]}/draft`, {
      body: { draft: { draft_version: 2, answer: {}, asset_ids: [] }, draft_revision: 0 },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'version_conflict')

    const second = await h.call('PUT', `/projects/${h.projectId}/session-items/${itemIds[0]}/draft`, {
      body: { draft: { draft_version: 2, answer: { selected_option_id: 'opt_b' }, asset_ids: [] }, draft_revision: 1 },
    })
    assert.equal(second.status, 200)
    assert.equal(second.body.draft_revision, 2)

    await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/submit`, {
      body: { answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
    })
    const afterSubmit = await h.call('PUT', `/projects/${h.projectId}/session-items/${itemIds[0]}/draft`, {
      body: { draft: { draft_version: 2, answer: {}, asset_ids: [] }, draft_revision: 2 },
    })
    assert.equal(afterSubmit.status, 400)
    assert.equal(afterSubmit.body.error.code, 'invalid_input')
  } finally {
    h.close()
  }
})

test('b8 practice: a constructed response is confirmed criterion by criterion to a real partial score', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({
      label: 'CR1',
      type: 'constructed_response',
      maxScore: '10.00',
      rubric: true,
      content: { blocks: [{ kind: 'text', text: '写出推导过程' }] },
      answer: { kind: 'constructed_response', rubric_required: true, reference_answer: '20 个' },
    })
    const { itemIds } = await h.startSession([q.questionId])
    await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    const submitted = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/submit`, {
      body: { answer: { type: 'constructed_response', text: '5 × 4 = 20' } },
    })
    assert.equal(submitted.status, 200)
    assert.equal(submitted.body.grade.status, 'pending_review')
    const attemptId = submitted.body.attempt_id as string

    const queue = await h.call('GET', `/projects/${h.projectId}/grading-queue`)
    assert.equal(queue.status, 200)
    const row = queue.body.find((entry: any) => entry.attempt_id === attemptId)
    assert.ok(row, 'the pending attempt must be in the grading queue')
    assert.equal(row.raw_answer.text, '5 × 4 = 20')
    assert.equal(row.rubric.criteria.length, 3)

    const confirmed = await h.call('POST', `/projects/${h.projectId}/attempts/${attemptId}/confirm-grade`, {
      body: {
        parts: [
          { part_id: 'c1', score: '0' },
          { part_id: 'c2', score: '3' },
          { part_id: 'c3', score: '3' },
        ],
        expected_grading_revision: 1,
        rubric_version_id: row.rubric.rubric_version_id,
      },
    })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    // Django answers the grade payload directly on the first call (no `{grade}` wrapper).
    assert.equal(confirmed.body.status, 'confirmed')
    assert.equal(confirmed.body.confirmed_score, '6')
    assert.equal(confirmed.body.pending_max_score, '0')
    assert.equal(confirmed.body.max_score, '10.00')
    assert.equal(confirmed.body.is_fully_confirmed, true)
    assert.equal(confirmed.body.is_correct, false)

    const stale = await h.call('POST', `/projects/${h.projectId}/attempts/${attemptId}/confirm-grade`, {
      body: { parts: [{ part_id: 'c1', score: '4' }], expected_grading_revision: 1 },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'version_conflict')
  } finally {
    h.close()
  }
})

test('b8 practice: a live verification attempt is not in the grading queue', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({
      label: 'VQ',
      type: 'constructed_response',
      maxScore: '10.00',
      rubric: true,
      content: { blocks: [{ kind: 'text', text: '写出推导过程' }] },
      answer: { kind: 'constructed_response', rubric_required: true, reference_answer: '20 个' },
    })
    const { itemIds } = await h.startSession([q.questionId], 'verification')
    await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    const submitted = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/submit`, {
      body: { answer: { type: 'constructed_response', text: '5 × 4 = 20' } },
    })
    assert.equal(submitted.status, 200)
    assert.equal(submitted.body.receipt_only, true)
    assert.equal(submitted.body.grade, null)
    const queue = await h.call('GET', `/projects/${h.projectId}/grading-queue`)
    assert.equal(queue.status, 200)
    assert.equal(queue.body.length, 0)
  } finally {
    h.close()
  }
})

test('b8 practice: submitting photos validates ownership and stores them on the attempt', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'P1', content: IMAGE_CONTENT })
    const { itemIds } = await h.startSession([q.questionId])
    await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)

    const asset = insertRow(
      h.db,
      'ingestion_asset',
      completeRow('ingestion_asset', {
        owner_id: h.userId,
        project_id: h.projectId,
        subject_id: h.subjectId,
        role: 'user_attachment',
        object_key: 'k/photo.png',
        original_filename: 'photo.png',
        content_type: 'image/png',
        size_bytes: 1024,
        checksum: 'x',
      }),
      { now: NOW },
    )
    const submitted = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/submit`, {
      body: {
        answer: { type: 'single_choice', selected_option_id: 'opt_b' },
        asset_ids: [String(asset.id)],
      },
    })
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    const attempt = findRows(h.db, 'practice_attempt', { session_item_id: itemIds[0] })[0]
    assert.deepEqual(attempt.attachments, [String(asset.id)])

    const detail = await h.call('GET', `/projects/${h.projectId}/attempts/${submitted.body.attempt_id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.attempt_id, submitted.body.attempt_id)
    assert.deepEqual(detail.body.attachments, [String(asset.id)])
    assert.equal(detail.body.receipt_only, false)

    const otherProject = createProject(h.db, h.userId, { name: 'Other' }, NOW)
    const other = insertRow(
      h.db,
      'ingestion_asset',
      completeRow('ingestion_asset', {
        owner_id: h.userId,
        project_id: String(otherProject.id),
        subject_id: h.subjectId,
        role: 'user_attachment',
        object_key: 'k/other.png',
        original_filename: 'other.png',
        content_type: 'image/png',
        size_bytes: 10,
        checksum: 'y',
      }),
      { now: NOW },
    )
    const q2 = h.makeQuestion({ label: 'P2', content: IMAGE_CONTENT })
    const second = await h.startSession([q2.questionId])
    const rejected = await h.call('POST', `/projects/${h.projectId}/session-items/${second.itemIds[0]}/submit`, {
      body: {
        answer: { type: 'single_choice', selected_option_id: 'opt_b' },
        asset_ids: [String(other.id)],
      },
    })
    assert.equal(rejected.status, 404)
    assert.equal(rejected.body.error.code, 'not_found')
  } finally {
    h.close()
  }
})

test('b8 practice: presentation carries the draft, exam clock and tutoring gate', async () => {
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'PR1' })
    const { itemIds } = await h.startSession([q.questionId])
    const first = await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    assert.equal(first.status, 200)
    assert.equal(first.body.first_delivery, true)
    assert.equal(first.body.tutoring_allowed, true)
    assert.equal(first.body.grading_hidden, false)
    assert.deepEqual(first.body.draft, {})
    assert.equal(first.body.draft_revision, 0)
    assert.equal(first.body.ordinal, 1)
    assert.equal(typeof first.body.server_time, 'string')
    assert.equal(first.body.exam_deadline, null)

    const second = await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    assert.equal(second.body.first_delivery, false)
    assert.equal(second.body.first_delivered_at, first.body.first_delivered_at)
  } finally {
    h.close()
  }
})

/**
 * Cross-implementation shape check against the real Django probe.
 *
 * `scripts/probe_b8_practice.py` recorded what Django actually answered for the same projections.
 * Comparing values would need identical UUIDs and clocks; comparing the **shape** (key sets and
 * value kinds, recursively) is what catches the B7 class of bug — a port that silently drops a field
 * the client reads. Value parity is pinned by the HTTP cases above and by the probe JSON itself.
 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])]
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      // Django only adds `request_id` when its request-id middleware ran; the DSH router always
      // does. The client never reads it, so the envelope shape ignores it (04 §F).
      if (key === 'request_id') continue
      out[key] = shapeOf((value as Record<string, unknown>)[key])
    }
    return out
  }
  return typeof value
}

test('b8 practice: projections keep the exact field shape Django published', async () => {
  const probePath = new URL('../../docs/dsh-migration/17-b8-practice-probe.json', import.meta.url)
  const probe = JSON.parse(readFileSync(probePath, 'utf8')) as { cases: Array<{ id: string; status: number; payload: any }> }
  const byId = new Map(probe.cases.map((entry) => [entry.id, entry]))
  const h = harness()
  try {
    const q = h.makeQuestion({ label: 'S1' })
    const { itemIds } = await h.startSession([q.questionId])
    const presented = await h.call('GET', `/projects/${h.projectId}/session-items/${itemIds[0]}/presentation`)
    assert.deepEqual(shapeOf(presented.body), shapeOf(byId.get('P01')!.payload), 'presentation')

    const reveal = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/reveal`)
    assert.deepEqual(shapeOf(reveal.body), shapeOf(byId.get('P02')!.payload), 'reveal')

    const photo = insertRow(
      h.db,
      'ingestion_asset',
      completeRow('ingestion_asset', {
        owner_id: h.userId,
        project_id: h.projectId,
        subject_id: h.subjectId,
        role: 'user_attachment',
        object_key: 'shape/photo.png',
        original_filename: 'photo.png',
        content_type: 'image/png',
        size_bytes: 1024,
        checksum: 'z',
      }),
      { now: NOW },
    )
    const submitted = await h.call('POST', `/projects/${h.projectId}/session-items/${itemIds[0]}/submit`, {
      body: {
        answer: { type: 'single_choice', selected_option_id: 'opt_b' },
        asset_ids: [String(photo.id)],
      },
    })
    const attempt = await h.call('GET', `/projects/${h.projectId}/attempts/${submitted.body.attempt_id}`)
    assert.deepEqual(shapeOf(attempt.body), shapeOf(byId.get('P09')!.payload), 'attempt detail')

    const cr = h.makeQuestion({
      label: 'SC1',
      type: 'constructed_response',
      maxScore: '10.00',
      rubric: true,
      content: { blocks: [{ kind: 'text', text: '写出推导过程' }] },
      answer: { kind: 'constructed_response', rubric_required: true, reference_answer: '20 个' },
    })
    const crSession = await h.startSession([cr.questionId])
    await h.call('GET', `/projects/${h.projectId}/session-items/${crSession.itemIds[0]}/presentation`)
    const crSubmit = await h.call('POST', `/projects/${h.projectId}/session-items/${crSession.itemIds[0]}/submit`, {
      body: { answer: { type: 'constructed_response', text: '5 × 4 = 20' } },
    })
    const queue = await h.call('GET', `/projects/${h.projectId}/grading-queue`)
    const row = queue.body.find((entry: any) => entry.attempt_id === crSubmit.body.attempt_id)
    assert.ok(row, 'queue row')
    assert.deepEqual(shapeOf(row), shapeOf(byId.get('P15')!.payload[0]), 'grading queue row')

    const confirmed = await h.call('POST', `/projects/${h.projectId}/attempts/${crSubmit.body.attempt_id}/confirm-grade`, {
      body: {
        parts: [
          { part_id: 'c1', score: '0' },
          { part_id: 'c2', score: '3' },
          { part_id: 'c3', score: '3' },
        ],
        expected_grading_revision: 1,
        rubric_version_id: row.rubric.rubric_version_id,
      },
    })
    assert.equal(confirmed.status, 200)
    assert.deepEqual(shapeOf(confirmed.body), shapeOf(byId.get('P16')!.payload), 'confirm-grade')

    // Error envelopes are part of the contract too: the browser reads `error.code`.
    const verification = await h.startSession([q.questionId], 'verification')
    await h.call('GET', `/projects/${h.projectId}/session-items/${verification.itemIds[0]}/presentation`)
    const refused = await h.call('POST', `/projects/${h.projectId}/session-items/${verification.itemIds[0]}/reveal`)
    assert.equal(refused.status, 403)
    assert.deepEqual(shapeOf(refused.body), shapeOf(byId.get('P04')!.payload), 'purpose_not_allowed envelope')
  } finally {
    h.close()
  }
})
