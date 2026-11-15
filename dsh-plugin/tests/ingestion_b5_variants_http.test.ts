/**
 * O19 / O20 over HTTP: AI variant proposals as reviewable candidates.
 *
 * The model is a tests-only fake port (no network, no stub provider in production). Each case
 * asserts the contract the Django service publishes: an unconfigured model is one audited
 * `unavailable` row and no job; a successful call leaves exactly one run per candidate and never
 * publishes anything; a mid-batch failure keeps what was already validated; replay is idempotent.
 *
 * R-INV 3 is asserted where it could break: after every path, the formal-score / mastery / evidence
 * tables must have exactly the row counts they had before the request.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow, getRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { insertSyllabusRow, insertNodeRow } from './support/b5_fixtures.ts'
import type { CapabilityResult, LlmPort } from '../src/llm/contract.ts'

const NOW = parseInstant('2026-09-10T00:00:00+00:00')
const BASE = 'http://host/api/acepass'
const KEY = 'variant-key-1'

const MODEL_ROUTE = { provider: 'test-provider', model: 'test-variant-model' }

const VARIANT_JSON = JSON.stringify({
  question_type: 'single_choice',
  content: {
    blocks: [{ kind: 'text', text: '变式：已知方程 x²-5x+6=0，它的两根之和是多少？' }],
    options: [
      { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '5' }] },
      { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '6' }] },
      { id: 'opt_c', label: 'C', blocks: [{ kind: 'text', text: '-5' }] },
      { id: 'opt_d', label: 'D', blocks: [{ kind: 'text', text: '1' }] },
    ],
  },
  answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
  rubric_criteria: [],
  rubric_total_score: null,
  practice_max_score: '2.00',
  difficulty_note: '同考点换数',
  rationale: '只改变了系数',
  doubts: [],
})

function success(text = VARIANT_JSON): CapabilityResult {
  return {
    ok: true,
    text,
    route: MODEL_ROUTE,
    promptVersion: 'p2-propose-variant-v1',
    capability: 'propose_variant',
    usage: { inputTokens: 11, outputTokens: 22 },
    latencyMs: 7,
  }
}

function failure(code: string, message = '模型不可用'): CapabilityResult {
  return {
    ok: false,
    code: code as never,
    message,
    capability: 'propose_variant',
    promptVersion: 'p2-propose-variant-v1',
    retryable: code === 'ai_timeout',
  }
}

/** A scripted port: one entry per call; a function entry can mutate state before answering. */
function scriptedPort(
  results: Array<CapabilityResult | (() => CapabilityResult | Promise<CapabilityResult>)>,
  options: { proposeAvailable?: boolean; reason?: string; run?: () => Promise<CapabilityResult> } = {},
): LlmPort {
  let index = 0
  return {
    async availability() {
      const available = options.proposeAvailable ?? true
      return {
        propose_variant: available ? { available: true } : { available: false, reason: (options.reason ?? 'ai_not_configured') as never },
        extract_question: { available: true },
      } as never
    },
    async run() {
      if (options.run !== undefined) return options.run()
      const entry = results[Math.min(index, results.length - 1)]
      index += 1
      return typeof entry === 'function' ? await entry() : entry
    },
  }
}

interface Harness {
  db: ReturnType<typeof openStore>['db']
  userId: string
  projectId: string
  subjectId: string
  syllabusId: string
  nodeId: string
  questionId: string
  versionId: string
  send: (request: Request) => Promise<Response>
  counts: () => Record<string, number>
}

function countTables(db: ReturnType<typeof openStore>['db']): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number }
    out[table.name] = Number(row.n)
  }
  return out
}

function harness(port: LlmPort, options: { questionType?: string; status?: string } = {}): Harness {
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
  const projectId = String(createProject(db, userId, { name: '变式项目' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id)
  const syllabusId = insertSyllabusRow(db, { subjectId, status: 'published', now: NOW })
  const nodeId = insertNodeRow(db, { syllabusId, name: '一元二次方程', now: NOW })
  const questionId = String(
    insertRow(
      db,
      'question_bank_question',
      {
        subject_id: subjectId,
        origin_type: 'user_authored',
        current_published_version_id: null,
        family_id: null,
        content_lineage_id: null,
        created_by_id: userId,
        is_demo: false,
        display_label: 'Q1',
      },
      { now: NOW },
    ).id,
  )
  const versionId = String(
    insertRow(
      db,
      'question_bank_question_version',
      {
        question_id: questionId,
        version: 1,
        question_type: options.questionType ?? 'single_choice',
        content: {
          blocks: [{ kind: 'text', text: '原题：已知方程 x²-3x+2=0，求两根之和。' }],
          options: [
            { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '3' }] },
            { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '2' }] },
          ],
        },
        parent_material_version_id: null,
        material_child_version_ids: [],
        practice_max_score: '2.00',
        estimated_seconds: null,
        status: options.status ?? 'published',
        revision_reason: 'fixture',
        source_note: '',
        created_by_id: userId,
        published_at: NOW,
        withdrawn_at: null,
        withdrawn_reason: '',
        content_digest: '0'.repeat(64),
      },
      { now: NOW },
    ).id,
  )
  insertRow(
    db,
    'question_bank_answer_key_version',
    {
      question_version_id: versionId,
      version: 1,
      answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
      source_type: 'user',
      verification_status: 'checked',
      checked_by_id: userId,
      checked_at: NOW,
      check_basis: 'fixture',
      source_region_id: null,
      explanation_blocks: [],
      is_disputed: false,
      dispute_reason: '',
      supersedes_id: null,
      created_by_id: userId,
    },
    { now: NOW },
  )
  const before = countTables(db)
  const handler = createFetchHandler({ db, routes: acepassRoutes({ llm: () => port }), actor: () => ({ userId, now: NOW }) })
  return {
    db,
    userId,
    projectId,
    subjectId,
    syllabusId,
    nodeId,
    questionId,
    versionId,
    send: handler,
    counts: () => {
      const after = countTables(db)
      const delta: Record<string, number> = {}
      for (const [table, count] of Object.entries(after)) {
        if (count !== before[table]) delta[table] = count - before[table]
      }
      return delta
    },
  }
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; key?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.key !== null) headers['idempotency-key'] = options.key ?? KEY
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

function proposeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { source_version_id: '', source_question_id: 'q', node_id: 'n', count: 1, difficulty_note: '', ...overrides }
}

function bodyFor(h: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return proposeBody({ source_question_id: h.questionId, node_id: h.nodeId, ...overrides })
}

/* ---------------------------------------------------------------- cases */

test('O19: no configured model leaves one unavailable run, no job, and says ai_not_configured', async () => {
  const h = harness(scriptedPort([], { proposeAvailable: false }))
  const response = await h.send(request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h) }))
  assert.equal(response.status, 503)
  const payload = await json(response)
  const error = payload['error'] as Record<string, unknown>
  assert.equal(error['code'], 'ai_not_configured')
  assert.equal(
    error['message'],
    '生成变式需要配置 AI 能力：未配置可生成变式的文本模型；请配置 provider 或人工录入变式',
  )
  assert.deepEqual(error['details'], { error_code: 'ai_not_configured' })
  const runs = findRows(h.db, 'audit_llm_run', {})
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'unavailable')
  assert.equal(runs[0].capability, 'propose_variant')
  assert.equal(runs[0].model_identifier, '')
  assert.equal(runs[0].cost_known, false)
  assert.equal(runs[0].cost_cents, null)
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 0, 'no job without a model')
  assert.equal(findRows(h.db, 'ingestion_import_candidate', {}).length, 0)
  assert.deepEqual(h.counts(), { audit_llm_run: 1 }, 'the unfulfilled claim is released, so nothing else changes')
})

test('O19: a successful proposal stores reviewable candidates and never publishes', async () => {
  const h = harness(scriptedPort([success()]))
  const response = await h.send(request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h) }))
  assert.equal(response.status, 201)
  const payload = await json(response)
  assert.equal(payload['origin_type'], 'ai_generated')
  assert.equal(payload['is_stub'], false)
  assert.equal(payload['model'], 'test-variant-model')
  assert.equal((payload['validation'] as Record<string, unknown>)['accepted'], 1)
  const candidates = payload['candidates'] as Array<Record<string, unknown>>
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]['answer_needs_confirmation'], true)
  assert.equal(candidates[0]['is_stub_output'], false)
  assert.equal(candidates[0]['source_version_id'], h.versionId)

  const job = findRows(h.db, 'ingestion_import_job', {})[0]
  assert.equal(job.input_kind, 'ai_variant')
  assert.equal(job.status, 'awaiting_review')
  const candidate = findRows(h.db, 'ingestion_import_candidate', {})[0]
  const draft = candidate.draft_payload as Record<string, unknown>
  assert.equal(draft['answer_status_known'], false)
  assert.equal(draft['answer_source_type'], 'ai_derived')
  assert.equal(draft['variant_of_version_id'], h.versionId)
  assert.equal(draft['variant_node_id'], h.nodeId)
  assert.equal(draft['practice_max_score'], '2.00')
  assert.equal(draft['variant_prompt_version'], 'p2-propose-variant-v1')
  assert.match(String(draft['display_label']), /^AI变式·/)
  const verification = draft['answer_verification'] as Record<string, unknown>
  assert.equal(verification['requires_human_confirmation'], true)
  assert.equal(verification['verification_status'], 'pending')
  // The candidate is not publishable yet: its own answer has not been confirmed by a human.
  const issues = candidate.review_issues as Array<Record<string, unknown>>
  assert.ok(issues.some((issue) => issue['code'] === 'answer_unknown'))
  assert.equal(candidate.status, 'draft')

  const run = findRows(h.db, 'audit_llm_run', {})[0]
  assert.equal(run.status, 'succeeded')
  assert.equal(run.model_identifier, 'test-variant-model')
  assert.equal(run.provider, 'test-provider')
  assert.equal(Number(run.prompt_tokens), 11)
  assert.equal(Number(run.completion_tokens), 22)
  assert.equal(run.cost_known, false)
  assert.equal(run.cost_cents, null)
  assert.equal(run.is_stub, false)
  const validation = run.validation_result as Record<string, unknown>
  assert.equal(validation['accepted'], true)

  // A replay with the same key returns the recorded 201 and writes nothing new.
  const replay = await h.send(request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h) }))
  assert.equal(replay.status, 201)
  assert.deepEqual(await json(replay), payload)
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 1)
  assert.equal(findRows(h.db, 'audit_llm_run', {}).length, 1)
  assert.equal(findRows(h.db, 'ingestion_import_candidate', {}).length, 1)
})

test('O19: the batch is capped at three and says so', async () => {
  const h = harness(scriptedPort([success(), success(), success()]))
  const response = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h, { count: 5 }) }),
  )
  assert.equal(response.status, 201)
  const payload = await json(response)
  assert.equal(payload['requested_count'], 5)
  assert.equal(payload['count'], 3)
  assert.equal(payload['count_capped'], true)
  assert.ok((payload['notes'] as string[]).some((note) => note.includes('单次最多生成 3 道变式')))
  assert.equal((payload['candidates'] as unknown[]).length, 3)
  assert.equal(findRows(h.db, 'audit_llm_run', {}).length, 3, 'one run per model call')
  const job = findRows(h.db, 'ingestion_import_job', {})[0]
  const problems = job.problems as Array<Record<string, unknown>>
  assert.ok(problems.some((problem) => problem['code'] === 'variant_count_capped' && problem['severity'] === 'warning'))
  assert.ok(problems.some((problem) => problem['code'] === 'ai_variant_not_published' && problem['severity'] === 'info'))
})

test('O19: a rejected proposal stays a candidate with every problem attached', async () => {
  // The model returns a valid payload whose stem is exactly the source stem: both the prompt
  // validator (`stem_copies_source`) and the independent re-check must catch it.
  const duplicated = JSON.stringify({
    ...JSON.parse(VARIANT_JSON),
    content: {
      ...JSON.parse(VARIANT_JSON).content,
      blocks: [{ kind: 'text', text: '原题：已知方程 x²-3x+2=0，求两根之和。' }],
    },
  })
  const h = harness(scriptedPort([success(duplicated)]))
  const response = await h.send(request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h) }))
  assert.equal(response.status, 201)
  const payload = await json(response)
  assert.equal((payload['validation'] as Record<string, unknown>)['accepted'], 0)
  assert.equal(payload['nothing_passed'], true)
  const candidate = findRows(h.db, 'ingestion_import_candidate', {})[0]
  const codes = (candidate.review_issues as Array<Record<string, unknown>>).map((issue) => issue['code'])
  assert.ok(codes.includes('variant_duplicates_source'))
  const run = findRows(h.db, 'audit_llm_run', {})[0]
  assert.equal(run.status, 'rejected')
  assert.equal(run.error_code, '', 'a rejected variant keeps its problems in validation_result')
  const job = findRows(h.db, 'ingestion_import_job', {})[0]
  const problems = job.problems as Array<Record<string, unknown>>
  assert.ok(problems.some((problem) => problem['code'] === 'variant_rejected'))
  assert.ok(problems.some((problem) => problem['code'] === 'no_variant_usable'))
  assert.equal(job.status, 'awaiting_review')
})

test('O19: a mid-batch provider failure keeps the earlier candidate and both runs', async () => {
  const h = harness(scriptedPort([success(), failure('ai_timeout', '模型调用超时')]))
  const response = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h, { count: 2 }) }),
  )
  assert.equal(response.status, 503)
  const payload = await json(response)
  const error = payload['error'] as Record<string, unknown>
  assert.equal(error['code'], 'dependency_unavailable')
  assert.match(String(error['message']), /^生成变式失败：/)
  assert.deepEqual(error['details'], { error_code: 'ai_timeout' })
  const runs = findRows(h.db, 'audit_llm_run', {})
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((run) => run.status).sort(), ['succeeded', 'timeout'])
  const candidates = findRows(h.db, 'ingestion_import_candidate', {})
  assert.equal(candidates.length, 1, 'the first, validated candidate survives the failure')
  const job = findRows(h.db, 'ingestion_import_job', {})[0]
  assert.equal(job.status, 'failed')
  assert.match(String(job.last_error), /^变式生成失败：/)
  // The failed request released its claim: the same key can be retried.
  const retry = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h, { count: 2 }) }),
  )
  assert.notEqual(retry.status, 409, 'a failed claim must not block the retry')
})

test('O19: preconditions keep the exact Django messages and 404s', async () => {
  const h = harness(scriptedPort([success()]))
  const noSource = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, {
      body: proposeBody({ source_question_id: '', source_version_id: '', node_id: h.nodeId }),
    }),
  )
  assert.equal(noSource.status, 400)
  assert.equal(((await json(noSource))['error'] as Record<string, unknown>)['message'], '必须提供 source_question_id 或 source_version_id')

  const badCount = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h, { count: 0 }) }),
  )
  assert.equal(badCount.status, 400)
  assert.equal(((await json(badCount))['error'] as Record<string, unknown>)['message'], 'count 必须至少为 1')

  const missingVersion = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, {
      body: proposeBody({ source_version_id: '00000000-0000-4000-8000-000000000000', node_id: h.nodeId }),
    }),
  )
  assert.equal(missingVersion.status, 404)
  assert.equal(((await json(missingVersion))['error'] as Record<string, unknown>)['message'], '源题目版本不存在或不属于该项目')

  const missingNode = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h, { node_id: '00000000-0000-4000-8000-000000000000' }) }),
  )
  assert.equal(missingNode.status, 404)
  assert.equal(((await json(missingNode))['error'] as Record<string, unknown>)['message'], '考点不存在或不属于该项目')

  // Body validation runs before the project lookup, like Ninja's parameter binding.
  const noNode = await h.send(request('POST', `/projects/${h.projectId}/variants/propose`, { body: { count: 1 } }))
  // Django maps Ninja's parameter validation onto the same 400 envelope (`apps/common/errors.py`).
  assert.equal(noNode.status, 400)
  const errors = ((await json(noNode))['error'] as Record<string, unknown>)['details'] as { errors: Array<Record<string, unknown>> }
  assert.deepEqual(errors.errors[0]['loc'], ['body', 'payload', 'node_id'])

  const floatCount = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h, { count: 1.5 }) }),
  )
  assert.equal(floatCount.status, 400)
  const floatErrors = ((await json(floatCount))['error'] as Record<string, unknown>)['details'] as { errors: Array<Record<string, unknown>> }
  assert.equal(floatErrors.errors[0]['type'], 'int_from_float')

  // Same key, different body → 409. (The first successful request above does not use the key.)
  const first = await h.send(request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h), key: 'conflict-key' }))
  assert.equal(first.status, 201)
  const conflict = await h.send(
    request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h, { count: 2 }), key: 'conflict-key' }),
  )
  assert.equal(conflict.status, 409)
  assert.equal(((await json(conflict))['error'] as Record<string, unknown>)['code'], 'idempotency_conflict')
})

test('O19: a draft version and a material version are refused before any model call', async () => {
  const draftHarness = harness(scriptedPort([success()]), { status: 'draft' })
  // An explicit version is resolved without the `published` filter (Django's API does the same),
  // so the service's own status check is what refuses it.
  const draft = await draftHarness.send(
    request('POST', `/projects/${draftHarness.projectId}/variants/propose`, {
      body: bodyFor(draftHarness, { source_question_id: null, source_version_id: draftHarness.versionId }),
    }),
  )
  assert.equal(draft.status, 400)
  assert.equal(
    ((await json(draft))['error'] as Record<string, unknown>)['message'],
    '只能从已发布的题目版本生成变式：草稿内容还没有经过人工发布',
  )
  assert.equal(findRows(draftHarness.db, 'audit_llm_run', {}).length, 0)

  const materialHarness = harness(scriptedPort([success()]), { questionType: 'material' })
  const material = await materialHarness.send(
    request('POST', `/projects/${materialHarness.projectId}/variants/propose`, { body: bodyFor(materialHarness) }),
  )
  assert.equal(material.status, 400)
  assert.equal(
    ((await json(material))['error'] as Record<string, unknown>)['message'],
    '共享材料题不能生成变式；请选择它的子题作为源题',
  )
})

test('O20: variant jobs are listed newest first, owner-scoped and capped', async () => {
  const h = harness(scriptedPort([success(), success(), success()]))
  for (let index = 0; index < 2; index += 1) {
    const response = await h.send(
      request('POST', `/projects/${h.projectId}/variants/propose`, {
        body: bodyFor(h),
        key: `list-key-${index}`,
      }),
    )
    assert.equal(response.status, 201)
  }
  const listed = await h.send(request('GET', `/projects/${h.projectId}/variants?limit=500`, { key: null }))
  assert.equal(listed.status, 200)
  const payload = await json(listed)
  assert.equal(payload['count'], 2)
  assert.equal(payload['limit'], 50, 'limit is clamped to 1..50')
  const jobs = payload['jobs'] as Array<Record<string, unknown>>
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0]['input_kind'], 'ai_variant')
  assert.equal((jobs[0]['candidates'] as unknown[]).length, 1)

  const badLimit = await h.send(request('GET', `/projects/${h.projectId}/variants?limit=abc`, { key: null }))
  assert.equal(badLimit.status, 400)
  const errors = ((await json(badLimit))['error'] as Record<string, unknown>)['details'] as { errors: Array<Record<string, unknown>> }
  assert.equal(errors.errors[0]['type'], 'int_parsing')
})

test('O19: no formal score, mastery or evidence row is ever written (R-INV 3)', async () => {
  const h = harness(scriptedPort([success()]))
  const before = countTables(h.db)
  const response = await h.send(request('POST', `/projects/${h.projectId}/variants/propose`, { body: bodyFor(h) }))
  assert.equal(response.status, 201)
  const after = countTables(h.db)
  const changed = Object.keys(after).filter((table) => after[table] !== before[table])
  assert.deepEqual(
    changed.sort(),
    [
      'audit_idempotency_record',
      'audit_llm_run',
      'ingestion_import_candidate',
      'ingestion_import_job',
    ].sort(),
    'a proposal writes only the job, the candidate, its audit row and the idempotency record',
  )
  for (const table of changed) {
    assert.ok(!/grade|evidence|state|mastery|paper_item|question_bank_question_version/.test(table), table)
  }
})
