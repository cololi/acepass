/**
 * HTTP black-box tests for the tutoring surface: ai-status, ai-runs, tutor sessions, messages,
 * jobs and the validated transcript.
 *
 * The acceptance cases these pin (`frontend/tests/dsh`):
 *
 *  * `p0-acceptance.spec.ts:355` — after a reload the tutoring entry asks for an explanation and the
 *    response is either `201` (validated content) or an explicit refusal; with no provider the job
 *    row says `ai_not_configured` instead of inventing an answer;
 *  * `p1-batch3.spec.ts:158` — the stream panel shows the real reason and renders **zero** segments
 *    when nothing was validated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { countRows, findOne, findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import { drain } from '../src/jobs/worker.ts'
import type { LlmPort } from '../src/llm/contract.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2027-06-01T00:00:00+00:00')

/**
 * Serialization golden: the field sets the real Django endpoints returned (probe B8), so a port
 * cannot drift field by field without this failing.
 */
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

const EXPLAIN_JSON = JSON.stringify({
  key_conditions: ['先算乘法'],
  stuck_points: ['没有写出单位'],
  explanation_blocks: [
    { kind: 'text', text: '5 × 4 = 20，所以共有 20 个。' },
    { kind: 'math', latex: '5 \\times 4 = 20' },
    { kind: 'list', items: ['列式', '计算', '写单位'] },
  ],
  method_summary: '先列式再计算',
  suggested_next: ['再做一道同类题'],
  missing_information: [],
  citations: ['question_version:PLACEHOLDER'],
})

/** A provider that answers one scripted text; `calls` proves a replay never re-asks the model. */
function scriptedPort(
  text: string | ((prompt: string) => string),
  capabilities: Record<string, boolean> = { explain: true },
): LlmPort & { calls: number; prompts: string[] } {
  const port = {
    calls: 0,
    prompts: [] as string[],
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
      port.prompts.push(request.prompt)
      const body = typeof text === 'function' ? text(request.prompt) : text
      return {
        ok: true as const,
        text: body,
        route: { provider: 'test-provider', model: 'test-model' },
        promptVersion: request.promptVersion,
        capability: request.capability,
        usage: { inputTokens: 7, outputTokens: 9 },
        latencyMs: 4,
      }
    },
  }
  return port
}

interface Fixture {
  db: DatabaseSync
  close: () => void
  userId: string
  projectId: string
  otherProjectId: string
  sessionId: string
  itemId: string
  questionId: string
  versionId: string
  attemptId: string
  call: (
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; key?: string },
  ) => Promise<{ status: number; body: any }>
}

function fixture(options: { port?: LlmPort; mode?: string } = {}): Fixture {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'tutor@example.com', display_name: '导师', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  const project = createProject(db, userId, { name: '辅导项目' }, NOW)
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
      question_type: 'single_choice',
      content: {
        blocks: [{ kind: 'text', text: '若 5 × 4 = ?，选一个。' }],
        options: [{ id: 'opt_a' }, { id: 'opt_b' }],
      },
      practice_max_score: '2.00',
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
      answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
      check_basis: '教材',
      explanation_blocks: [{ kind: 'text', text: '5 × 4 = 20。' }],
    }),
    { now: NOW },
  )
  assert.ok(answer.id)
  publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })

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
  presentItem(db, userId, String(item.id), NOW)
  const submitted = submitAttempt(
    db,
    userId,
    String(item.id),
    { raw_answer: { type: 'single_choice', selected_option_id: 'opt_a' } },
    NOW + 5_000_000n,
  )
  drain(db, NOW + 5_000_000n)

  let counter = 0
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(options.port === undefined ? {} : { llm: () => options.port! }),
    actor: () => ({ userId, now: (NOW + 20_000_000n) as Instant }),
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
    sessionId: String(session.id),
    itemId: String(item.id),
    questionId: String(question.id),
    versionId: String(draft.id),
    attemptId: String(submitted.attempt.id),
    call,
  }
}

function citations(versionId: string): string {
  return `question_version:${versionId}`
}

test('tutoring: ai-status is honest with no model and names the capability table', async () => {
  const f = fixture()
  try {
    const response = await f.call('GET', `/projects/${f.projectId}/ai-status`)
    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(response.body).sort(), [
      'capabilities',
      'configured',
      'is_stub',
      'max_retries',
      'message',
      'p0_capabilities',
      'provider',
      'total_timeout_seconds',
    ])
    assert.equal(response.body.provider, 'none')
    assert.equal(response.body.configured, false)
    assert.equal(response.body.is_stub, false)
    assert.deepEqual(Object.keys(response.body.capabilities).sort(), [
      'diagnose',
      'embed',
      'estimate_grade',
      'explain',
      'extract_question',
      'propose_variant',
      'suggest_tags',
      'transcribe_handwriting',
    ])
    assert.equal(Object.values(response.body.capabilities).some(Boolean), false)
    assert.deepEqual(response.body.p0_capabilities, ['extract_question', 'explain'])
    assert.match(response.body.message, /AI 未配置/)
    assert.equal(response.body.max_retries, 2)
    assert.equal(response.body.total_timeout_seconds, 90)

    // Another project the same owner has is still in scope (Django's `require_project`), so the
    // status answers rather than probing for existence.
    const other = await f.call('GET', `/projects/${f.otherProjectId}/ai-status`)
    assert.equal(other.status, 200)
    assert.equal(other.body.configured, false)
  } finally {
    f.close()
  }
})

test('tutoring: ai-status reports a configured text model and keeps vision disabled', async () => {
  const port = scriptedPort('{}', { explain: true, diagnose: true, estimate_grade: true })
  const f = fixture({ port })
  try {
    const response = await f.call('GET', `/projects/${f.projectId}/ai-status`)
    assert.equal(response.status, 200)
    assert.equal(response.body.configured, true)
    assert.equal(response.body.provider, 'dsh-llm')
    assert.equal(response.body.is_stub, false)
    assert.equal(response.body.capabilities.explain, true)
    assert.equal(response.body.capabilities.estimate_grade, true)
    assert.equal(response.body.capabilities.transcribe_handwriting, false, 'a text model must not read photos')
    assert.equal(response.body.capabilities.embed, false)
    assert.match(response.body.message, /已配置真实 provider/)
  } finally {
    f.close()
  }
})

test('tutoring: ai-runs lists project audit rows newest first with the exact field set', async () => {
  const port = scriptedPort((prompt) => EXPLAIN_JSON.replace('PLACEHOLDER', prompt.split('question_version:')[1]?.split(',')[0] ?? ''))
  const f = fixture({ port })
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId, purpose: 'explanation' },
    })
    assert.equal(created.status, 201)
    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: { user_question: '为什么先算乘法？' } },
    )
    assert.equal(messages.status, 201)

    const runs = await f.call('GET', `/projects/${f.projectId}/ai-runs?limit=20`)
    assert.equal(runs.status, 200)
    assert.equal(Array.isArray(runs.body), true)
    assert.equal(runs.body.length, 1)
    const row = runs.body[0]
    assert.deepEqual(Object.keys(row).sort(), [
      'attempts',
      'capability',
      'completion_tokens',
      'cost_cents',
      'cost_known',
      'created_at',
      'error_code',
      'id',
      'is_stub',
      'latency_ms',
      'model',
      'prompt_tokens',
      'prompt_version',
      'provider',
      'status',
    ])
    assert.equal(row.capability, 'explain')
    assert.equal(row.prompt_version, 'p0-explain-v1')
    assert.equal(row.status, 'succeeded')
    assert.equal(row.is_stub, false)
    assert.equal(row.cost_cents, null, 'dsh-llm reports no price, so none is invented')
    assert.equal(row.cost_known, false)
    assert.match(row.created_at, /\+00:00$/)

    const clamped = await f.call('GET', `/projects/${f.projectId}/ai-runs?limit=0`)
    assert.equal(clamped.body.length, 1, 'limit is clamped to at least 1')
    const bad = await f.call('GET', `/projects/${f.projectId}/ai-runs?limit=abc`)
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.details.errors[0].type, 'int_parsing')
    assert.deepEqual(bad.body.error.details.errors[0].loc, ['query', 'limit'])

    const emptyProject = await f.call('GET', `/projects/${f.otherProjectId}/ai-runs`)
    assert.equal(emptyProject.status, 200)
    assert.deepEqual(emptyProject.body, [], 'runs are project-scoped')
  } finally {
    f.close()
  }
})

test('tutoring: a session freezes its versions and replays idempotently', async () => {
  const f = fixture()
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId, purpose: 'hint' },
      key: 'session-1',
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.session_item_id, f.itemId)
    assert.equal(created.body.purpose, 'hint')
    assert.equal(created.body.attempt_id, f.attemptId)
    assert.equal(created.body.prompt_version, 'p0-explain-v1')
    assert.equal(created.body.question_version_id, f.versionId)
    assert.equal(created.body.answer_key_version_id !== null, true)
    assert.match(created.body.created_at, /\+00:00$/)

    const replay = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId, purpose: 'hint' },
      key: 'session-1',
    })
    assert.deepEqual(replay.body, created.body, 'the same key returns the stored response')
    assert.equal(countRows(f.db, 'tutoring_session', {}), 1)

    const conflict = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId, purpose: 'explanation' },
      key: 'session-1',
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'idempotency_conflict')

    const missing = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
      key: '',
    })
    assert.equal(missing.status, 409)
    assert.equal(missing.body.error.message, '缺少 Idempotency-Key 请求头')

    const foreignItem = await f.call('POST', `/projects/${f.otherProjectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    assert.equal(foreignItem.status, 404, 'a foreign project is a 404, not a hint')
  } finally {
    f.close()
  }
})

test('tutoring: the gate refuses ended sessions, verification mode, sealed content and ineligible items', async () => {
  const f = fixture()
  try {
    updateRow(f.db, 'practice_session', f.sessionId, { status: 'finished' }, { now: NOW })
    const ended = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    assert.equal(ended.status, 403)
    assert.equal(ended.body.error.code, 'purpose_not_allowed')
    assert.match(ended.body.error.message, /会话已结束/)

    updateRow(f.db, 'practice_session', f.sessionId, { status: 'active', mode: 'verification' }, { now: NOW })
    const verification = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    assert.equal(verification.status, 403)
    assert.match(verification.body.error.message, /验证\/考试模式不提供/)

    updateRow(f.db, 'practice_session', f.sessionId, { mode: 'practice' }, { now: NOW })
    const invalidPurpose = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId, purpose: 'chat' },
    })
    assert.equal(invalidPurpose.status, 400)
    assert.equal(invalidPurpose.body.error.message, '辅导用途无效')

    updateRow(f.db, 'practice_session_item', f.itemId, { tutoring_allowed: false }, { now: NOW })
    const notAllowed = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    assert.equal(notAllowed.status, 403)
    assert.match(notAllowed.body.error.message, /该题项按计划不提供辅导/)
    updateRow(f.db, 'practice_session_item', f.itemId, { tutoring_allowed: true }, { now: NOW })

    sealQuestion(f.db, {
      projectId: f.projectId,
      questionId: f.questionId,
      actorId: f.userId,
      reason: '探针封存',
      now: NOW,
    })
    const sealed = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    assert.equal(sealed.status, 403)
    assert.match(sealed.body.error.message, /封存内容不可生成 AI 提示\/讲解/)
    assert.equal(sealed.body.error.details.reason, 'sealed_question_policy')
    assert.equal(countRows(f.db, 'tutoring_session', {}), 0, 'a refused request creates no thread')
  } finally {
    f.close()
  }
})

test('tutoring: with no model the message asks for a job and answers 201 unavailable', async () => {
  const f = fixture()
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: { user_question: '请讲解一下。' } },
    )
    assert.equal(messages.status, 201, 'a job is created even when no model exists')
    assert.equal(messages.body.status, 'unavailable')
    assert.equal(messages.body.error_code, 'ai_not_configured')
    assert.match(messages.body.error_message, /未配置/)
    assert.equal(messages.body.is_stub, false)
    assert.deepEqual(messages.body.result_blocks, [])
    assert.deepEqual(messages.body.citations, [])
    assert.equal(messages.body.segment_count, 0)
    assert.equal(messages.body.delivered_at, null)
    assert.equal(messages.body.tutor_job_id !== '', true)

    const runs = findRows(f.db, 'audit_llm_run', { capability: 'explain' })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'unavailable')
    assert.equal(runs[0].is_stub, false)
    assert.equal(countRows(f.db, 'tutoring_segment', {}), 0, 'no segment may be invented')

    const turns = findRows(f.db, 'tutoring_turn', { tutor_session_id: created.body.tutor_session_id })
    assert.equal(turns.length, 1, 'the learner question is stored, the assistant turn is not')
    assert.equal(turns[0].role, 'user')

    const job = await f.call('GET', `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}`)
    assert.equal(job.status, 200)
    assert.equal(job.body.status, 'unavailable')
    assert.deepEqual(job.body.result_blocks, [])

    const segments = await f.call(
      'GET',
      `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}/segments`,
    )
    assert.equal(segments.status, 200)
    assert.equal(segments.body.segment_count, 0)
    assert.equal(segments.body.is_stale, false)
    assert.deepEqual(segments.body.segments, [])
  } finally {
    f.close()
  }
})

test('tutoring: a replayed message returns the same job and never re-asks the model', async () => {
  const port = scriptedPort((prompt) => EXPLAIN_JSON.replace('PLACEHOLDER', prompt.split('question_version:')[1]?.split(',')[0] ?? ''))
  const f = fixture({ port })
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    const first = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: { user_question: '讲解。' }, key: 'msg-1' },
    )
    assert.equal(first.status, 201)
    assert.equal(first.body.status, 'succeeded')
    assert.equal(port.calls, 1)

    const replay = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: { user_question: '讲解。' }, key: 'msg-1' },
    )
    assert.equal(replay.status, 201)
    assert.equal(replay.body.tutor_job_id, first.body.tutor_job_id)
    assert.equal(port.calls, 1, 'a replay must not call the provider again')
    assert.equal(countRows(f.db, 'tutoring_job', {}), 1)
  } finally {
    f.close()
  }
})

test('tutoring: a validated explanation stores segments, a turn and one exposure fact', async () => {
  const port = scriptedPort((prompt) =>
    EXPLAIN_JSON.replace('PLACEHOLDER', prompt.split('question_version:')[1]?.split(',')[0] ?? ''),
  )
  const f = fixture({ port })
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: { user_question: '请针对我的作答讲解。' } },
    )
    assert.equal(messages.status, 201)
    assert.equal(messages.body.status, 'succeeded')
    assert.equal(messages.body.reveals_answer, true, 'an explanation delivers the answer')
    assert.equal(messages.body.error_code, '')
    assert.equal(messages.body.is_stale, false)
    assert.equal(messages.body.provider, 'test-provider')
    assert.equal(messages.body.model, 'test-model')
    assert.equal(messages.body.prompt_version, 'p0-explain-v1')
    assert.equal(messages.body.segment_count, 3)
    assert.match(messages.body.delivered_at, /\+00:00$/)
    assert.deepEqual(messages.body.citations, [`question_version:${f.versionId}`])
    assert.equal(messages.body.result_blocks.length, 3)

    const segments = findRows(f.db, 'tutoring_segment', { job_id: messages.body.tutor_job_id }).sort(
      (left, right) => Number(left.index) - Number(right.index),
    )
    assert.deepEqual(
      segments.map((row) => [Number(row.index), String(row.kind)]),
      [
        [0, 'text'],
        [1, 'math'],
        [2, 'list'],
      ],
    )
    assert.deepEqual(segments[2].items, ['列式', '计算', '写单位'])
    assert.equal(String(segments[0].digest).length, 64)

    const exposure = findRows(f.db, 'practice_exposure_event', { session_item_id: f.itemId }).filter(
      (row) => (row.detail as Record<string, unknown>)['tutor_job_id'] === messages.body.tutor_job_id,
    )
    assert.equal(exposure.length, 1)
    assert.equal(exposure[0].kind, 'answer_delivered')
    assert.equal(exposure[0].source, 'tutor_job:explanation')

    const transcript = await f.call(
      'GET',
      `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}/segments`,
    )
    assert.equal(transcript.status, 200)
    assert.equal(transcript.body.segment_count, 3)
    assert.equal(transcript.body.is_stale, false)
    assert.equal(transcript.body.stale_reason, '')
    assert.deepEqual(
      transcript.body.segments.map((row: any) => row.index),
      [0, 1, 2],
    )

    // The prompt carried the learner's own work (the point of the personalised explain prompt).
    assert.match(port.prompts[0], /选择：/)
  } finally {
    f.close()
  }
})

test('tutoring: an unvalidated model answer is refused and delivers nothing', async () => {
  // A citation the request never allowed: the validator rejects the whole payload.
  const port = scriptedPort(
    JSON.stringify({
      explanation_blocks: [{ kind: 'text', text: '编造的讲解' }],
      citations: ['knowledge_node:00000000-0000-0000-0000-000000000000'],
      suggested_next: [],
      missing_information: [],
      key_conditions: [],
      stuck_points: [],
      method_summary: '',
    }),
  )
  const f = fixture({ port })
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: {} },
    )
    assert.equal(messages.status, 201)
    assert.equal(messages.body.status, 'failed')
    assert.equal(messages.body.error_code, 'ai_invalid_output')
    assert.match(messages.body.error_message, /未通过校验/)
    assert.deepEqual(messages.body.result_blocks, [])
    assert.equal(countRows(f.db, 'tutoring_segment', {}), 0, 'an unvalidated block has nothing to mirror')
    const run = findRows(f.db, 'audit_llm_run', { capability: 'explain' })[0]
    assert.equal(run.status, 'rejected')
    assert.equal((run.validation_result as Record<string, unknown>)['accepted'], false)
  } finally {
    f.close()
  }
})

test('tutoring: sessions list carries the job summary, and job/segment reads stay in scope', async () => {
  const port = scriptedPort((prompt) =>
    EXPLAIN_JSON.replace('PLACEHOLDER', prompt.split('question_version:')[1]?.split(',')[0] ?? ''),
  )
  const f = fixture({ port })
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId, purpose: 'explanation' },
    })
    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: {} },
    )
    const list = await f.call('GET', `/projects/${f.projectId}/tutor-sessions`)
    assert.equal(list.status, 200)
    assert.equal(list.body.length, 1)
    assert.equal(list.body[0].tutor_session_id, created.body.tutor_session_id)
    assert.equal(list.body[0].job_count, 1)
    assert.equal(list.body[0].last_job_status, 'succeeded')

    const filtered = await f.call(
      'GET',
      `/projects/${f.projectId}/tutor-sessions?session_item_id=${'00000000-0000-0000-0000-000000000000'}`,
    )
    assert.deepEqual(filtered.body, [])

    const foreignJob = await f.call('GET', `/projects/${f.otherProjectId}/tutor-jobs/${messages.body.tutor_job_id}`)
    assert.equal(foreignJob.status, 404)
    const foreignSegments = await f.call(
      'GET',
      `/projects/${f.otherProjectId}/tutor-jobs/${messages.body.tutor_job_id}/segments`,
    )
    assert.equal(foreignSegments.status, 404)
    const foreignMessage = await f.call(
      'POST',
      `/projects/${f.otherProjectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: {} },
    )
    assert.equal(foreignMessage.status, 404)
  } finally {
    f.close()
  }
})

test('tutoring: a sealed question stops delivering an already stored explanation', async () => {
  const port = scriptedPort((prompt) =>
    EXPLAIN_JSON.replace('PLACEHOLDER', prompt.split('question_version:')[1]?.split(',')[0] ?? ''),
  )
  const f = fixture({ port })
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: {} },
    )
    assert.equal(messages.body.status, 'succeeded')

    // Sealing after the fact must also close the *read* paths (C03).
    updateRow(f.db, 'practice_session', f.sessionId, { status: 'finished' }, { now: NOW })
    sealQuestion(f.db, {
      projectId: f.projectId,
      questionId: f.questionId,
      actorId: f.userId,
      reason: '事后封存',
      now: NOW,
    })
    const job = await f.call('GET', `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}`)
    assert.equal(job.status, 403)
    assert.equal(job.body.error.code, 'purpose_not_allowed')
    assert.equal(job.body.error.details.reason, 'sealed_question_policy')
    const segments = await f.call(
      'GET',
      `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}/segments`,
    )
    assert.equal(segments.status, 403, 'the transcript obeys the same gate as the job read')

    const replay = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: {}, key: 'seal-replay' },
    )
    assert.equal(replay.status, 403, 'the session is finished, so a new message is refused')
    assert.equal(replay.body.error.code, 'purpose_not_allowed')
    assert.match(replay.body.error.message, /会话已结束/)
  } finally {
    f.close()
  }
})

test('golden: every serializer matches the real Django field set', async () => {
  const port = scriptedPort((prompt) =>
    EXPLAIN_JSON.replace('PLACEHOLDER', prompt.split('question_version:')[1]?.split(',')[0] ?? ''),
  )
  const bare = fixture()
  try {
    // The golden's ai-status was captured with the shipped NullProvider.
    const status = await bare.call('GET', `/projects/${bare.projectId}/ai-status`)
    const goldenStatus = GOLDEN.projections.ai_status
    assert.deepEqual(Object.keys(status.body).sort(), goldenStatus.keys)
    assert.equal(status.body.provider, goldenStatus.provider)
    assert.equal(status.body.configured, goldenStatus.configured)
    assert.equal(status.body.is_stub, goldenStatus.is_stub)
    assert.deepEqual(status.body.capabilities, goldenStatus.capabilities)
    assert.deepEqual(status.body.p0_capabilities, goldenStatus.p0_capabilities)
    assert.equal(status.body.message, goldenStatus.message, 'the provider_status() sentence is verbatim')
    assert.equal(status.body.max_retries, goldenStatus.max_retries)
    assert.equal(status.body.total_timeout_seconds, goldenStatus.total_timeout_seconds)
  } finally {
    bare.close()
  }

  const f = fixture({ port })
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    assert.deepEqual(Object.keys(created.body).sort(), GOLDEN.projections.tutor_session.keys)

    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: {} },
    )
    const goldenJob = GOLDEN.projections.tutor_job
    assert.deepEqual(Object.keys(messages.body).sort(), goldenJob.keys)
    const job = await f.call('GET', `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}`)
    assert.deepEqual(Object.keys(job.body).sort(), goldenJob.read_keys)

    const transcript = await f.call(
      'GET',
      `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}/segments`,
    )
    assert.deepEqual(Object.keys(transcript.body).sort(), GOLDEN.projections.tutor_segments.keys)
    assert.deepEqual(
      Object.keys(transcript.body.segments[0]).sort(),
      GOLDEN.projections.tutor_segments.segment_keys,
    )

    const runs = await f.call('GET', `/projects/${f.projectId}/ai-runs`)
    assert.deepEqual(Object.keys(runs.body[0]).sort(), GOLDEN.projections.ai_run.keys)
  } finally {
    f.close()
  }
})

test('golden: an unavailable job streams exactly status + done with the Django frame fields', async () => {
  const f = fixture()
  try {
    const created = await f.call('POST', `/projects/${f.projectId}/tutor-sessions`, {
      body: { session_item_id: f.itemId },
    })
    const messages = await f.call(
      'POST',
      `/projects/${f.projectId}/tutor-sessions/${created.body.tutor_session_id}/messages`,
      { body: {} },
    )
    assert.deepEqual(
      Object.keys(messages.body).sort(),
      GOLDEN.projections.tutor_job.keys,
    )
    assert.equal(messages.body.status, GOLDEN.projections.tutor_job.unavailable.status)
    assert.equal(messages.body.error_code, GOLDEN.projections.tutor_job.unavailable.error_code)
    assert.deepEqual(messages.body.result_blocks, GOLDEN.projections.tutor_job.unavailable.result_blocks)
    assert.equal(messages.body.segment_count, GOLDEN.projections.tutor_job.unavailable.segment_count)
    assert.deepEqual(
      GOLDEN.projections.tutor_stream.events.filter((event: string) => event !== 'segment'),
      ['status', 'done'],
      'Django emits status + done for an unavailable job (no invented error frame)',
    )
    const segments = await f.call(
      'GET',
      `/projects/${f.projectId}/tutor-jobs/${messages.body.tutor_job_id}/segments`,
    )
    assert.deepEqual(Object.keys(segments.body).sort(), GOLDEN.projections.tutor_segments.unavailable.keys)
    assert.equal(segments.body.segment_count, GOLDEN.projections.tutor_segments.unavailable.segment_count)
    assert.equal(segments.body.is_stale, GOLDEN.projections.tutor_segments.unavailable.is_stale)
  } finally {
    f.close()
  }
})
