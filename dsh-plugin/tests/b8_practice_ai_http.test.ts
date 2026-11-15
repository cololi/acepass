/**
 * HTTP black-box tests for the practice AI surface: transcription gate, AI estimate, AI diagnosis.
 *
 * Everything is driven through `Request → Response` against the real router, the real services and a
 * real (in-memory) SQLite store, exactly like `tests/study_routes.test.ts`. The assertions pin the
 * rules the B8 brief names:
 *
 *  * an unconfirmed photo blocks estimation with `409 transcription_required` **before** any
 *    provider is consulted (zero audit rows),
 *  * no vision model ⇒ `503 ai_not_configured` (never an invented transcription),
 *  * the manual path writes `origin=manual / status=confirmed / is_stub=false` and opens the gate,
 *  * an estimate is inert: no `current_grade_event` move, no evidence, no mastery state,
 *  * a diagnosis stores candidates only, and a follow-up is answered once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { countRows, findOne, findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import {
  createQuestionRevision,
  publishQuestionVersion,
  upsertRubricVersion,
} from '../src/services/questions.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { drain } from '../src/jobs/worker.ts'
import { configureStorage, resetStorageCache } from '../src/ingestion/storage.ts'
import type { LlmPort } from '../src/llm/contract.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2027-05-01T00:00:00+00:00')

/** The B8 serialization golden: field sets captured from the real Django endpoints. */
const GOLDEN = JSON.parse(
  readFileSync(new URL('./golden/b8_tutor.json', import.meta.url), 'utf8'),
) as { projections: Record<string, any> }
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

/** A provider that answers exactly one scripted text; `availability` is per-capability. */
function scriptedPort(
  text: string | Record<string, string>,
  options: { capabilities?: Record<string, boolean> } = {},
): LlmPort & { calls: number } {
  const capabilities = options.capabilities ?? {}
  const port = {
    calls: 0,
    async availability() {
      const table: Record<string, { available: boolean; reason?: string }> = {}
      for (const capability of [
        'extract_question',
        'transcribe_handwriting',
        'suggest_tags',
        'explain',
        'diagnose',
        'estimate_grade',
        'propose_variant',
        'embed',
      ]) {
        table[capability] = capabilities[capability]
          ? { available: true }
          : { available: false, reason: capability === 'embed' ? 'ai_capability_unsupported' : 'ai_not_configured' }
      }
      return table as Awaited<ReturnType<LlmPort['availability']>>
    },
    async run(request: Parameters<LlmPort['run']>[0]) {
      port.calls += 1
      // A per-capability script lets one fixture answer estimation and diagnosis with their own JSON.
      const script = typeof text === 'string' ? text : (text as Record<string, string>)[request.capability] ?? ''
      return {
        ok: true as const,
        text: script,
        route: { provider: 'test-provider', model: 'test-model' },
        promptVersion: request.promptVersion,
        capability: request.capability,
        usage: { inputTokens: 11, outputTokens: 22 },
        latencyMs: 3,
      }
    },
  }
  return port
}

const ESTIMATE_JSON = JSON.stringify({
  criteria: [
    { criterion_id: 'c1', estimated_score: '1.00', rationale: '列式正确', missing_evidence: [] },
    { criterion_id: 'c2', estimated_score: '0.50', rationale: '结论不完整', missing_evidence: ['缺少单位'] },
  ],
  overall_note: '参考估计：结论不完整',
  confidence: 0.6,
})

const DIAGNOSIS_JSON = JSON.stringify({
  causes: [
    { error_type: 'incomplete_reasoning', confidence: 0.5, evidence: ['只写了第一步'] },
  ],
  follow_up_questions: [
    { question: '你当时为什么停在第一步？', why: '确认推理是否中断', evidence_kind: 'process' },
  ],
  missing_information: ['草稿过程'],
})

interface Fixture {
  db: DatabaseSync
  close: () => void
  userId: string
  projectId: string
  otherProjectId: string
  itemId: string
  attemptId: string
  assetId: string
  call: (
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; key?: string },
  ) => Promise<{ status: number; body: any }>
}

function fixture(
  options: { port?: LlmPort; attachments?: boolean; mode?: string; questionType?: string } = {},
): Fixture {
  const questionType = options.questionType ?? 'constructed_response'
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'ai@example.com', display_name: 'AI', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'AI 项目' }, NOW)
  const projectId = String(project.id)
  const other = createProject(db, userId, { name: '别的项目' }, NOW)
  const subject = createSubject(db, userId, projectId, { name: '数学' }, NOW)

  const question = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', {
      subject_id: subject.id,
      origin_type: 'user_authored',
      is_demo: false,
      display_label: '大题1',
      family_id: null,
    }),
    { now: NOW },
  )
  const draft = createQuestionRevision(
    db,
    userId,
    projectId,
    String(question.id),
    {
      question_type: questionType,
      content: {
        blocks: [{ kind: 'text', text: '计算 5 × 4，并写出过程。' }],
        ...(questionType === 'single_choice' ? { options: [{ id: 'opt_a' }, { id: 'opt_b' }] } : {}),
      },
      practice_max_score: '2.00',
    },
    NOW,
  )
  const answerPayload =
    questionType === 'single_choice'
      ? { kind: 'single_choice', correct_option_id: 'opt_a' }
      : { kind: 'constructed_response', rubric_required: true }
  const answer = insertRow(
    db,
    'question_bank_answer_key_version',
    completeRow('question_bank_answer_key_version', {
      question_version_id: draft.id,
      version: 1,
      verification_status: 'checked',
      is_disputed: false,
      answer_payload: answerPayload,
      check_basis: '教材',
      explanation_blocks: [],
    }),
    { now: NOW },
  )
  if (questionType === 'constructed_response') {
    upsertRubricVersion(
      db,
      userId,
      projectId,
      String(answer.id),
      {
        criteria: [
          { criterion_id: 'c1', max_score: '1.00', text: '列式正确' },
          { criterion_id: 'c2', max_score: '1.00', text: '结论与单位正确' },
        ],
        totalScore: '2.00',
      },
      NOW,
    )
  }
  publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })

  const assetId = String(
    insertRow(
      db,
      'ingestion_asset',
      completeRow('ingestion_asset', {
        owner_id: user.id,
        project_id: project.id,
        subject_id: subject.id,
        role: 'user_attachment',
        sensitivity: 'public_to_owner',
        object_key: 'answer-photos/handwriting.png',
        original_filename: 'handwriting.png',
        content_type: 'image/png',
        size_bytes: 128,
        checksum: 'a'.repeat(64),
        is_retained: false,
      }),
      { now: NOW },
    ).id,
  )

  const session = createSession(
    db,
    userId,
    projectId,
    {
      subject_id: String(subject.id),
      question_ids: [String(question.id)],
      mode: options.mode ?? 'practice',
      duration_minutes: options.mode === 'mock_exam' ? 60 : null,
    },
    NOW,
  )
  const item = findRows(db, 'practice_session_item', { session_id: String(session.id) })[0]
  const itemId = String(item.id)
  presentItem(db, userId, itemId, NOW)
  const submitted = submitAttempt(
    db,
    userId,
    itemId,
    {
      raw_answer:
        questionType === 'single_choice'
          ? { type: 'single_choice', selected_option_id: 'opt_a' }
          : { type: 'constructed_response', text: '5 × 4 = 20。' },
      asset_ids: options.attachments === false ? [] : [assetId],
    },
    NOW + 5_000_000n,
  )
  drain(db, NOW + 5_000_000n)

  let counter = 0
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(options.port === undefined ? {} : { llm: () => options.port! }),
    actor: () => ({ userId, now: NOW + 10_000_000n as Instant }),
  })
  const call: Fixture['call'] = async (method, path, callOptions = {}) => {
    counter += 1
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'idempotency-key': callOptions.key ?? `k-${counter}` }),
      ...(callOptions.headers ?? {}),
    }
    if (callOptions.key === '') delete headers['idempotency-key']
    const request = new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    otherProjectId: String(other.id),
    itemId,
    attemptId: String(submitted.attempt.id),
    assetId,
    call,
  }
}

test('practice AI: an unconfirmed photo blocks estimation before any provider is consulted', async () => {
  const port = scriptedPort(ESTIMATE_JSON, { capabilities: { estimate_grade: true } })
  const f = fixture({ port })
  try {
    const list = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.pending_asset_ids, [f.assetId])
    assert.equal(list.body.transcription_required, true)
    assert.equal(list.body.gate_open, false)
    assert.deepEqual(list.body.transcriptions, [])

    const runsBefore = countRows(f.db, 'audit_llm_run', {})
    const blocked = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'transcription_required')
    assert.deepEqual(blocked.body.error.details.asset_ids, [f.assetId])
    assert.equal(countRows(f.db, 'audit_llm_run', {}), runsBefore, 'the gate runs before any run row')
    assert.equal(port.calls, 0, 'no provider call may happen for an unconfirmed photo')

    const diagnosis = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-diagnosis`, {
      body: { learner_note: '' },
    })
    assert.equal(diagnosis.status, 409)
    assert.equal(diagnosis.body.error.code, 'transcription_required')
  } finally {
    f.close()
  }
})

test('practice AI: without a vision model the transcription request is an explicit 503', async () => {
  const f = fixture()
  try {
    const before = countRows(f.db, 'practice_answer_transcription', {})
    const response = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId },
    })
    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'ai_not_configured')
    assert.equal(countRows(f.db, 'practice_answer_transcription', {}), before, 'nothing invented')
    const runs = findRows(f.db, 'audit_llm_run', { capability: 'transcribe_handwriting' })
    assert.equal(runs.length, 1, 'the refusal still leaves an audit row')
    assert.equal(runs[0].status, 'unavailable')
    assert.equal(runs[0].is_stub, false)
  } finally {
    f.close()
  }
})

test('practice AI: the manual transcription opens the gate and stays labelled as manual', async () => {
  const f = fixture()
  try {
    const recorded = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId, text: '我写的是：5 × 4 = 20，所以共有 20 个。' },
    })
    assert.equal(recorded.status, 201)
    assert.equal(recorded.body.origin, 'manual')
    assert.equal(recorded.body.status, 'confirmed')
    assert.equal(recorded.body.is_stub, false)
    assert.equal(recorded.body.is_confirmed, true)
    assert.equal(recorded.body.confirmed_text, '我写的是：5 × 4 = 20，所以共有 20 个。')
    assert.equal(recorded.body.confidence, null)
    assert.deepEqual(recorded.body.doubts, [])
    assert.equal(recorded.body.prompt_version, '', 'a manual row names no prompt version')

    const after = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`)
    assert.deepEqual(after.body.pending_asset_ids, [])
    assert.equal(after.body.transcription_required, false)
    assert.equal(after.body.gate_open, true)

    const revision = findOne(f.db, 'audit_content_revision', { entity_type: 'answer_transcription' })
    assert.ok(revision, 'the confirmation is audited')
    assert.equal(revision!.action, 'transcription_confirmed')
  } finally {
    f.close()
  }
})

test('practice AI: manual transcription rejects a foreign asset and a blank text', async () => {
  const f = fixture()
  try {
    const foreign = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: 'not-my-photo', text: '任意文本' },
    })
    assert.equal(foreign.status, 400)
    assert.equal(foreign.body.error.code, 'invalid_input')
    assert.equal(foreign.body.error.details.asset_id, 'not-my-photo')

    const blank = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId, text: '   ' },
    })
    assert.equal(blank.status, 400)
    assert.equal(blank.body.error.message, '人工录入的转写文本不能为空')
  } finally {
    f.close()
  }
})

test('practice AI: with no model the estimate is 503 and writes no score-shaped row', async () => {
  const f = fixture()
  try {
    await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId, text: '5 × 4 = 20。' },
    })
    const attemptBefore = findOne(f.db, 'practice_attempt', { id: f.attemptId })!
    const estimate = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(estimate.status, 503)
    assert.equal(estimate.body.error.code, 'ai_not_configured')
    assert.match(estimate.body.error.message, /未配置/)
    const attemptAfter = findOne(f.db, 'practice_attempt', { id: f.attemptId })!
    assert.equal(attemptAfter.current_grade_event_id, attemptBefore.current_grade_event_id)
    assert.equal(attemptAfter.grading_revision, attemptBefore.grading_revision)
    assert.equal(
      countRows(f.db, 'practice_grade_event', { attempt_id: f.attemptId, kind: 'ai_estimate' }),
      0,
      'no estimate event may be invented',
    )

    const state = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(state.status, 200)
    assert.equal(state.body.has_estimate, false)
    assert.equal(state.body.estimate, null)
    assert.equal(state.body.is_inert, true)
    assert.equal(state.body.confirmed_total_unchanged, true)
  } finally {
    f.close()
  }
})

test('practice AI: a model estimate is stored inert and never becomes the grade', async () => {
  const port = scriptedPort(ESTIMATE_JSON, { capabilities: { estimate_grade: true } })
  const f = fixture({ port })
  try {
    await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId, text: '5 × 4 = 20。' },
    })
    const attemptBefore = findOne(f.db, 'practice_attempt', { id: f.attemptId })!
    const evidenceBefore = countRows(f.db, 'practice_learning_evidence', {})
    const stateBefore = countRows(f.db, 'learning_knowledge_state', {})
    const outboxBefore = countRows(f.db, 'audit_outbox_event', {})
    const estimate = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(estimate.status, 200)
    assert.equal(estimate.body.is_inert, true)
    assert.equal(estimate.body.status, 'estimated')
    assert.equal(estimate.body.method, 'ai_estimated')
    assert.equal(estimate.body.estimated_score, '1.50')
    assert.equal(estimate.body.confirmed_score, null)
    assert.equal(estimate.body.confirmed_total_unchanged, true)
    assert.equal(estimate.body.is_fully_confirmed, false)
    assert.equal(estimate.body.pending_max_score, '2.00')
    assert.equal(estimate.body.prompt_version, 'p1-estimate-grade-v1')
    assert.equal(estimate.body.is_stub, false)
    assert.deepEqual(
      estimate.body.criteria.map((row: any) => [row.criterion_id, row.estimated_score, row.status]),
      [
        ['c1', '1.00', 'estimated'],
        ['c2', '0.50', 'estimated'],
      ],
    )

    const attemptAfter = findOne(f.db, 'practice_attempt', { id: f.attemptId })!
    assert.equal(
      attemptAfter.current_grade_event_id,
      attemptBefore.current_grade_event_id,
      'the effective grade pointer must not move',
    )
    assert.equal(Number(attemptAfter.grading_revision), Number(attemptBefore.grading_revision) + 1)
    assert.equal(
      countRows(f.db, 'practice_learning_evidence', {}),
      evidenceBefore,
      'AI must not write evidence',
    )
    assert.equal(
      countRows(f.db, 'learning_knowledge_state', {}),
      stateBefore,
      'AI must not write mastery state',
    )
    assert.equal(
      countRows(f.db, 'audit_outbox_event', {}),
      outboxBefore,
      'an estimate enqueues no consumer event',
    )

    const state = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(state.body.has_estimate, true)
    assert.equal(state.body.estimate.grade_event_id, estimate.body.grade_event_id)
    assert.match(state.body.message, /不计入正式分数|仅供参考/)

    // A second estimate supersedes the first and still never becomes the grade.
    const again = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(again.status, 200)
    const events = findRows(f.db, 'practice_grade_event', { attempt_id: f.attemptId, kind: 'ai_estimate' })
    assert.equal(events.length, 2, 'two estimates, both inert')
    assert.equal(countRows(f.db, 'practice_grade_event', { attempt_id: f.attemptId }), 3, 'the initial grade plus two estimates')
    const superseded = findOne(f.db, 'practice_grade_event', { id: estimate.body.grade_event_id })!
    assert.equal(superseded.is_superseded, true, 'only an earlier *estimate* is superseded')
    assert.equal(
      findOne(f.db, 'practice_attempt', { id: f.attemptId })!.current_grade_event_id,
      attemptBefore.current_grade_event_id,
      'the effective grade pointer still does not move',
    )
  } finally {
    f.close()
  }
})

test('practice AI: the estimate replay re-checks the gate instead of handing back a hidden body', async () => {
  const port = scriptedPort(ESTIMATE_JSON, { capabilities: { estimate_grade: true } })
  const f = fixture({ port })
  try {
    await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId, text: '5 × 4 = 20。' },
    })
    const first = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`, { key: 'estimate-1' })
    assert.equal(first.status, 200)

    // The session becomes a running verification: the same key must not return the stored estimate.
    updateRow(f.db, 'practice_session', String(findOne(f.db, 'practice_session_item', { id: f.itemId })!.session_id), {
      mode: 'verification',
      status: 'active',
    }, { now: NOW })
    const replay = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`, { key: 'estimate-1' })
    assert.equal(replay.status, 403)
    assert.equal(replay.body.error.code, 'purpose_not_allowed')
    assert.equal(replay.body.error.details.reason, 'grading_hidden')

    const read = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(read.status, 403)
    assert.equal(read.body.error.code, 'purpose_not_allowed')
  } finally {
    f.close()
  }
})

test('practice AI: a question without a rubric refuses per-criterion estimation', async () => {
  const port = scriptedPort(ESTIMATE_JSON, { capabilities: { estimate_grade: true } })
  const f = fixture({ port, attachments: false, questionType: 'single_choice' })
  try {
    const response = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'invalid_input')
    assert.match(response.body.error.message, /评分标准/)
    assert.equal(port.calls, 0, 'no provider is asked to score work without criteria')
  } finally {
    f.close()
  }
})

test('practice AI: transcription confirm edits the text, reject closes the gate again', async () => {
  const f = fixture()
  try {
    // A model-shaped proposal is written directly: the vision path needs object storage, which is
    // not what this case is about (its own refusal is covered above).
    const proposed = insertRow(
      f.db,
      'practice_answer_transcription',
      {
        attempt_id: f.attemptId,
        asset_id: f.assetId,
        origin: 'model',
        status: 'proposed',
        raw_text: '5 × 4 = 2O（模型读错）',
        confirmed_text: '',
        confidence: 0.4,
        doubts: ['末位字符不确定'],
        is_stub: false,
        run_id: null,
        decided_by_id: null,
        decided_at: null,
        note: '',
      },
      { now: NOW },
    )
    const confirmed = await f.call('POST', `/projects/${f.projectId}/transcriptions/${String(proposed.id)}/confirm`, {
      body: { text: '5 × 4 = 20', note: '按原笔迹修正' },
    })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.status, 'edited')
    assert.equal(confirmed.body.confirmed_text, '5 × 4 = 20')
    assert.equal(confirmed.body.note, '按原笔迹修正')
    assert.equal(confirmed.body.prompt_version, 'p1-transcribe-v1')

    const again = await f.call('POST', `/projects/${f.projectId}/transcriptions/${String(proposed.id)}/confirm`, {
      body: {},
    })
    assert.equal(again.status, 400)
    assert.match(again.body.error.message, /只有待确认的转写可以确认/)

    const second = insertRow(
      f.db,
      'practice_answer_transcription',
      {
        attempt_id: f.attemptId,
        asset_id: 'another-photo',
        origin: 'model',
        status: 'proposed',
        raw_text: '草稿',
        confirmed_text: '',
        confidence: null,
        doubts: [],
        is_stub: false,
        run_id: null,
        decided_by_id: null,
        decided_at: null,
        note: '',
      },
      { now: NOW },
    )
    const rejected = await f.call('POST', `/projects/${f.projectId}/transcriptions/${String(second.id)}/reject`, {
      body: { note: '字迹无法辨认' },
    })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.status, 'rejected')
    assert.equal(rejected.body.confirmed_text, '')
    assert.equal(rejected.body.is_confirmed, false)
  } finally {
    f.close()
  }
})

test('practice AI: a model diagnosis stores candidates and asks a follow-up that is answered once', async () => {
  const port = scriptedPort(DIAGNOSIS_JSON, { capabilities: { diagnose: true } })
  const f = fixture({ port, attachments: false })
  try {
    const response = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-diagnosis`, {
      body: { learner_note: '我当时先算乘法。' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.origin, 'model')
    assert.equal(response.body.status, 'proposed')
    assert.equal(response.body.recorded, true)
    assert.equal(response.body.scores_changed, false)
    assert.equal(response.body.knowledge_state_changed, false)
    assert.equal(response.body.is_stub, false)
    assert.equal(response.body.causes.length, 1)
    assert.equal(response.body.causes[0].error_type, 'incomplete_reasoning')
    assert.equal(response.body.causes[0].status, 'proposed')
    assert.equal(response.body.follow_up_questions.length, 1)
    assert.equal(response.body.follow_up_questions[0].status, 'pending')

    const followUpId = response.body.follow_up_questions[0].follow_up_id
    const answered = await f.call('POST', `/projects/${f.projectId}/diagnosis-follow-ups/${followUpId}/answer`, {
      body: { text: '因为我以为只要写出算式。' },
    })
    assert.equal(answered.status, 200)
    assert.equal(answered.body.status, 'answered')
    assert.equal(answered.body.answer_text, '因为我以为只要写出算式。')

    const twice = await f.call('POST', `/projects/${f.projectId}/diagnosis-follow-ups/${followUpId}/answer`, {
      body: { text: '再答一次' },
    })
    assert.equal(twice.status, 400)
    assert.match(twice.body.error.message, /已经处理过/)

    const skipped = await f.call('POST', `/projects/${f.projectId}/diagnosis-follow-ups/${followUpId}/skip`, {
      body: {},
    })
    assert.equal(skipped.status, 400, 'an answered follow-up cannot be skipped afterwards')
  } finally {
    f.close()
  }
})

test('practice AI: with no model the diagnosis is 503 and stores nothing', async () => {
  const f = fixture({ attachments: false })
  try {
    const response = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-diagnosis`, {
      body: { learner_note: '' },
    })
    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'ai_not_configured')
    assert.equal(countRows(f.db, 'practice_error_diagnosis', {}), 0)
    assert.equal(countRows(f.db, 'practice_diagnosis_follow_up', {}), 0)
  } finally {
    f.close()
  }
})

test('practice AI: the human diagnosis route appends a decision without touching scores', async () => {
  const f = fixture({ attachments: false })
  try {
    const response = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/diagnosis`, {
      body: { error_type: 'concept_gap', status: 'confirmed', note: '概念没掌握' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.origin, 'user')
    assert.equal(response.body.status, 'confirmed')
    assert.equal(response.body.error_type, 'concept_gap')
    assert.equal(response.body.note, '概念没掌握')

    const invalid = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/diagnosis`, {
      body: { error_type: 'concept_gap', status: 'maybe' },
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.message, '诊断状态无效')
  } finally {
    f.close()
  }
})

test('practice AI: another project cannot read or write these surfaces', async () => {
  const f = fixture({ attachments: false })
  try {
    const list = await f.call('GET', `/projects/${f.otherProjectId}/attempts/${f.attemptId}/transcriptions`)
    assert.equal(list.status, 404)
    assert.equal(list.body.error.code, 'not_found')

    const estimate = await f.call('POST', `/projects/${f.otherProjectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(estimate.status, 404)
    assert.equal(estimate.body.error.code, 'not_found')

    const missingBody = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`, {
      key: '',
    })
    assert.equal(missingBody.status, 409)
    assert.equal(missingBody.body.error.code, 'idempotency_conflict')
    assert.equal(missingBody.body.error.message, '缺少 Idempotency-Key 请求头')
  } finally {
    f.close()
  }
})

test('golden: transcription, estimate, diagnosis and follow-up shapes are Django\'s', async () => {
  const port = scriptedPort(
    { estimate_grade: ESTIMATE_JSON, diagnose: DIAGNOSIS_JSON },
    { capabilities: { estimate_grade: true, diagnose: true } },
  )
  const f = fixture({ port })
  try {
    const list = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`)
    assert.deepEqual(Object.keys(list.body).sort(), GOLDEN.projections.transcription_list.keys)

    const manual = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId, text: '5 × 4 = 20。' },
    })
    assert.deepEqual(Object.keys(manual.body).sort(), GOLDEN.projections.transcription.keys)

    const estimate = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(estimate.status, 200)
    assert.deepEqual(Object.keys(estimate.body).sort(), GOLDEN.projections.estimate.keys)
    assert.deepEqual(
      Object.keys(estimate.body.criteria[0]).sort(),
      GOLDEN.projections.estimate.criteria_keys,
    )
    const state = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.deepEqual(Object.keys(state.body).sort(), GOLDEN.projections.estimate.state_keys)

    const diagnosis = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-diagnosis`, {
      body: { learner_note: '' },
    })
    assert.equal(diagnosis.status, 200)
    assert.deepEqual(Object.keys(diagnosis.body).sort(), GOLDEN.projections.diagnosis.keys)
    assert.deepEqual(
      Object.keys(diagnosis.body.causes[0]).sort(),
      GOLDEN.projections.diagnosis.cause_keys,
    )
    assert.deepEqual(
      Object.keys(diagnosis.body.follow_up_questions[0]).sort(),
      GOLDEN.projections.diagnosis.follow_up_keys,
    )
    const answered = await f.call(
      'POST',
      `/projects/${f.projectId}/diagnosis-follow-ups/${diagnosis.body.follow_up_questions[0].follow_up_id}/answer`,
      { body: { text: '因为只写了第一步。' } },
    )
    assert.deepEqual(Object.keys(answered.body).sort(), GOLDEN.projections.diagnosis_follow_up.keys)
  } finally {
    f.close()
  }
})

test('golden: the refusal envelope is the shared {code, message, details} shape', async () => {
  const f = fixture()
  try {
    const refused = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(refused.status, 409)
    assert.deepEqual(
      Object.keys(refused.body.error).sort().filter((key) => key !== 'request_id'),
      GOLDEN.projections.error_envelope.keys,
    )
  } finally {
    f.close()
  }
})

test('practice AI: a vision model proposal stays a proposal until the learner confirms it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acepass-b8-transcribe-'))
  const port = scriptedPort(
    JSON.stringify({ text: '5 × 4 = 2O', confidence: 0.55, doubts: ['末位字符不确定'], illegible: false }),
    { capabilities: { transcribe_handwriting: true } },
  )
  const f = fixture({ port })
  try {
    configureStorage(root)
    // The asset row exists (the submit validated it); the stored bytes are what the model reads.
    const asset = findOne(f.db, 'ingestion_asset', { id: f.assetId })!
    const objectPath = join(root, String(asset.object_key))
    mkdirSync(dirname(objectPath), { recursive: true })
    writeFileSync(objectPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const proposed = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId },
    })
    assert.equal(proposed.status, 201)
    assert.equal(proposed.body.origin, 'model')
    assert.equal(proposed.body.status, 'proposed')
    assert.equal(proposed.body.is_confirmed, false)
    assert.equal(proposed.body.confirmed_text, '', 'raw text is never the answer')
    assert.equal(proposed.body.raw_text, '5 × 4 = 2O')
    assert.equal(proposed.body.prompt_version, 'p1-transcribe-v1')
    assert.equal(proposed.body.is_stub, false)
    assert.deepEqual(proposed.body.doubts, ['末位字符不确定'])
    assert.equal(proposed.body.llm_run_id !== null, true)
    const run = findRows(f.db, 'audit_llm_run', { capability: 'transcribe_handwriting' })[0]
    assert.equal(run.status, 'succeeded')
    assert.equal(run.is_stub, false)
    assert.equal(String((run.input_snapshot as Record<string, unknown>)['prompt_version']), 'p1-transcribe-v1')

    // The gate stays closed until a human decides (the proposal is not the learner's answer).
    const stillBlocked = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/ai-estimate`)
    assert.equal(stillBlocked.status, 409)
    assert.equal(stillBlocked.body.error.code, 'transcription_required')

    const confirmed = await f.call('POST', `/projects/${f.projectId}/transcriptions/${proposed.body.transcription_id}/confirm`, {
      body: { text: '5 × 4 = 20' },
    })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.status, 'edited')
    assert.equal(confirmed.body.confirmed_text, '5 × 4 = 20')
    const list = await f.call('GET', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`)
    assert.equal(list.body.gate_open, true)

    // Re-running would overwrite a confirmed proposal, so the service refuses.
    const rerun = await f.call('POST', `/projects/${f.projectId}/attempts/${f.attemptId}/transcriptions`, {
      body: { asset_id: f.assetId },
    })
    assert.equal(rerun.status, 400)
    assert.match(rerun.body.error.message, /已由学习者确认/)
    assert.equal(port.calls, 1)
  } finally {
    resetStorageCache()
    rmSync(root, { recursive: true, force: true })
    f.close()
  }
})
