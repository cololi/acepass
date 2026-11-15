/**
 * HTTP black-box tests for the M1 learning flow.
 *
 * Everything is driven through the real router (`createFetchHandler`) and a real
 * in-memory SQLite store; only the model port is scripted. The assertions are
 * about the wire facts a client depends on: status codes, the error envelope,
 * idempotent replay, the honest AI-unavailable path, and the shape of a recall /
 * practice step.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { LlmPort } from '../src/llm/contract.ts'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { findRows, updateRow } from '../src/store/repository.ts'
import { addConfirmedCard, studyStore, NOW } from './support/study_fixtures.ts'
import { getOrCreateNodeMemory } from '../src/services/node_memory.ts'

type Json = Record<string, unknown>

function scriptedPort(text: string | ((prompt: string) => string), available = true): LlmPort & {
  calls: number
  prompts: string[]
} {
  const port = {
    calls: 0,
    prompts: [] as string[],
    async availability() {
      return {
        explain: { available, ...(available ? {} : { reason: 'ai_not_configured' }) },
      } as unknown as Record<string, { available: boolean; reason?: string }>
    },
    async run(request: { capability: string; promptVersion: string; prompt: string }) {
      port.calls += 1
      port.prompts.push(request.prompt)
      if (!available) {
        return {
          ok: false as const,
          code: 'ai_not_configured' as const,
          message: 'AI 未配置',
          capability: request.capability as never,
          promptVersion: request.promptVersion,
          retryable: false,
        }
      }
      return {
        ok: true as const,
        text: typeof text === 'function' ? text(request.prompt) : text,
        route: { provider: 'test', model: 'test' },
        promptVersion: request.promptVersion,
        capability: request.capability as never,
        latencyMs: 1,
      }
    },
  }
  return port as unknown as LlmPort & { calls: number; prompts: string[] }
}

function fixture(options: { port?: LlmPort } = {}) {
  const store = studyStore()
  const handler = createFetchHandler({
    db: store.db,
    routes: acepassRoutes(options.port === undefined ? {} : { llm: () => options.port! }),
    actor: () => ({ userId: store.userId, now: NOW as Instant }),
  })
  let counter = 0
  async function call(
    method: string,
    path: string,
    options: { body?: unknown; key?: string } = {},
  ): Promise<{ status: number; body: Json }> {
    const headers = new Headers()
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.key !== undefined) headers.set('idempotency-key', options.key)
    else if (method !== 'GET') headers.set('idempotency-key', `test-${++counter}`)
    const response = await handler(
      new Request(`http://acepass.local${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    )
    const text = await response.text()
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Json) }
  }
  return { ...store, handler, call }
}

function uiPath(f: ReturnType<typeof fixture>, suffix: string): string {
  return `/api/acepass/projects/${f.projectId}${suffix}`
}

test('http: study desk exposes due memory, value nodes and honest AI state', async () => {
  const f = fixture()
  try {
    const memory = getOrCreateNodeMemory(f.db, f.userId, f.projectId, f.nodeIds[0], NOW)
    updateRow(
      f.db,
      'memory_node_state',
      memory.id,
      { due_at: parseInstant('2027-01-30T10:00:00+00:00'), last_recall_at: parseInstant('2027-01-30T10:00:00+00:00'), stability: 2, phase: 'review', reps: 1 },
      { now: NOW },
    )
    const response = await f.call('GET', `${uiPath(f, '/study-desk')}?subject_id=${f.subjectId}`)
    assert.equal(response.status, 200)
    assert.equal(response.body.subject_id, f.subjectId)
    const due = response.body.due_memory as Json[]
    assert.ok(due.some((row) => row.node_id === f.nodeIds[0]))
    const value = (response.body.value_nodes as Json[]).find((row) => row.node_id === f.nodeIds[0])
    assert.ok(value)
    assert.ok(Number(value.value_index) > 0.3)
    const ai = response.body.ai as Json
    assert.equal(ai.configured, false)
    assert.match(String(ai.message), /未配置|AI/)
    assert.equal((response.body.coverage as Json).nodes_total, 3)
  } finally {
    f.close()
  }
})

test('http: session creation is idempotent and the replay returns the stored body', async () => {
  const f = fixture()
  try {
    const first = await f.call('POST', uiPath(f, '/learning-sessions'), {
      body: { subject_id: f.subjectId, mode: 'daily', budget_minutes: 30 },
      key: 'create-1',
    })
    assert.equal(first.status, 201)
    assert.ok(String(first.body.session_id ?? '').length > 0)
    const replay = await f.call('POST', uiPath(f, '/learning-sessions'), {
      body: { subject_id: f.subjectId, mode: 'daily', budget_minutes: 30 },
      key: 'create-1',
    })
    assert.equal(replay.status, 201)
    assert.equal(replay.body.session_id, first.body.session_id)
    assert.deepEqual(replay.body.steps, first.body.steps)
    const conflict = await f.call('POST', uiPath(f, '/learning-sessions'), {
      body: { subject_id: f.subjectId, mode: 'daily', budget_minutes: 60 },
      key: 'create-1',
    })
    assert.equal(conflict.status, 409)
    assert.equal((conflict.body.error as Json).code, 'idempotency_conflict')
    const noKey = await f.handler(
      new Request(`http://acepass.local${uiPath(f, '/learning-sessions')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject_id: f.subjectId }),
      }),
    )
    assert.equal(noKey.status, 409)
  } finally {
    f.close()
  }
})

test('http: recall and confirm move the memory ledger through the wire', async () => {
  const f = fixture()
  try {
    const created = await f.call('POST', uiPath(f, '/learning-sessions'), {
      body: { subject_id: f.subjectId, mode: 'daily', budget_minutes: 20 },
    })
    const sessionId = String(created.body.session_id)
    const started = await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/start`))
    assert.equal(started.status, 200)
    let step: Json | undefined
    for (const candidate of created.body.steps as Json[]) {
      if (candidate.kind === 'recall') {
        step = candidate
        break
      }
      await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(candidate.ordinal)}/skip`), {
        body: { reason: '测试先做回忆' },
      })
    }
    assert.ok(step)
    const ordinal = Number(step.ordinal)
    const activated = await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${ordinal}/activate`))
    assert.equal(activated.status, 200)
    const recalled = await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${ordinal}/recall`), {
      body: { text: '只记得定义', confidence_before: 3 },
    })
    assert.equal(recalled.status, 200)
    const recall = recalled.body.recall as Json
    assert.equal(recall.coverage, null)
    const confirmed = await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${ordinal}/recall/confirm`), {
      body: { rating: 'good' },
      key: 'confirm-1',
    })
    assert.equal(confirmed.status, 200)
    const event = confirmed.body.event as Json
    assert.equal(event.rating, 'good')
    assert.equal(event.memory_updated, true)
    const replay = await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${ordinal}/recall/confirm`), {
      body: { rating: 'good' },
      key: 'confirm-1',
    })
    assert.equal((replay.body.event as Json).event_id, event.event_id)
    assert.equal(findRows(f.db, 'memory_recall_event', {}).length, 1)
  } finally {
    f.close()
  }
})

test('http: a wrong practice answer is graded and a repair is appended', async () => {
  const f = fixture()
  try {
    const created = await f.call('POST', uiPath(f, '/learning-sessions'), {
      body: { subject_id: f.subjectId, mode: 'daily', budget_minutes: 40 },
    })
    const sessionId = String(created.body.session_id)
    await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/start`))
    const steps = created.body.steps as Json[]
    let practice: Json | undefined
    for (const step of steps) {
      if (step.kind === 'practice') {
        practice = step
        break
      }
      await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(step.ordinal)}/skip`), {
        body: { reason: '测试跳过' },
      })
    }
    assert.ok(practice)
    const activated = await f.call(
      'POST',
      uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(practice.ordinal)}/activate`),
    )
    assert.equal(activated.status, 200)
    assert.ok(activated.body.presentation)
    const answered = await f.call(
      'POST',
      uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(practice.ordinal)}/answer`),
      { body: { answer: { type: 'single_choice', selected_option_ids: ['opt_b'] }, confidence: 'sure' } },
    )
    assert.equal(answered.status, 200)
    const grade = answered.body.grade as Json
    assert.equal(grade.is_correct, false)
    assert.equal((answered.body.step as Json).outcome, 'incorrect')
    const session = await f.call('GET', uiPath(f, `/learning-sessions/${sessionId}`))
    const repairKinds = (session.body.steps as Json[])
      .filter((step) => step.stage === 'repair')
      .map((step) => step.kind)
    assert.ok(repairKinds.includes('repair_brief'))
    assert.ok(repairKinds.includes('repair_retest'))
  } finally {
    f.close()
  }
})

test('http: without a model the hint is deterministic and a coach turn is honestly unavailable', async () => {
  const f = fixture()
  try {
    addConfirmedCard(f, f.nodeIds[0], [
      { id: 'kp1', text: '极限的 ε-δ 定义', required: true },
      { id: 'kp2', text: '去心邻域条件', required: true },
    ])
    const created = await f.call('POST', uiPath(f, '/learning-sessions'), {
      body: { subject_id: f.subjectId, mode: 'daily', budget_minutes: 40 },
    })
    const sessionId = String(created.body.session_id)
    await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/start`))
    for (const step of created.body.steps as Json[]) {
      if (step.kind === 'practice') break
      await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(step.ordinal)}/skip`), {
        body: { reason: '测试跳过' },
      })
    }
    const practice = ((await f.call('GET', uiPath(f, `/learning-sessions/${sessionId}`))).body.steps as Json[]).find(
      (step) => step.kind === 'practice',
    )
    assert.ok(practice)
    await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(practice.ordinal)}/activate`))
    const hint = await f.call(
      'POST',
      uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(practice.ordinal)}/hint`),
      { body: { level: 2 } },
    )
    assert.equal(hint.status, 200)
    assert.equal(hint.body.model_used, false)
    assert.ok((hint.body.blocks as unknown[]).length > 0)
    assert.match(String(hint.body.fallback_note), /AI 未配置/)

    const coach = await f.call('POST', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/coach`), {
      body: { purpose: 'recall_check', message: '我写了一些回忆' },
    })
    assert.equal(coach.status, 200)
    assert.equal(coach.body.model_used, false)
    const turn = coach.body.turn as Json
    assert.equal(turn.status, 'unavailable')
    assert.equal(turn.error_code, 'ai_not_configured')
    assert.equal(String(turn.text ?? ''), '')
  } finally {
    f.close()
  }
})

test('http: cards can be drafted and confirmed; AI card generation degrades honestly', async () => {
  const f = fixture()
  try {
    const created = await f.call('POST', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/card`), {
      body: {
        blocks: [{ kind: 'text', text: '极限的定义' }],
        key_points: [{ id: 'kp1', text: '定义', required: true }],
        citations: [`knowledge_node:${f.nodeIds[0]}`],
      },
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.status, 'draft')
    const confirmed = await f.call('POST', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/card/confirm`), {
      body: { card_id: created.body.card_id },
    })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.status, 'confirmed')
    const read = await f.call('GET', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/card`))
    assert.equal((read.body.card as Json).status, 'confirmed')
    assert.equal((read.body.revisions as Json[]).length, 1)
    const generate = await f.call('POST', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/card/generate`))
    assert.equal(generate.status, 503)
    assert.equal((generate.body.error as Json).code, 'ai_not_configured')
  } finally {
    f.close()
  }
})

test('http: frequency and node memory reads answer with their own shapes', async () => {
  const f = fixture()
  try {
    const frequency = await f.call('GET', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/frequency`))
    assert.equal(frequency.status, 200)
    assert.equal(frequency.body.status, 'ok')
    assert.equal(frequency.body.counted_cycles, 2)
    assert.ok(Number(frequency.body.value_index) > 0)
    const memory = await f.call('GET', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/memory`))
    assert.equal(memory.status, 200)
    assert.equal(memory.body.memory, null)
    assert.equal(memory.body.is_due, false)
    const subjectFrequency = await f.call('GET', uiPath(f, `/subjects/${f.subjectId}/frequency`))
    assert.equal(subjectFrequency.status, 200)
    assert.ok(Array.isArray(subjectFrequency.body.nodes))
    const adHoc = await f.call('POST', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/recall`), {
      body: { rating: 'hard', text: '只记得一点' },
    })
    assert.equal(adHoc.status, 201)
    assert.equal(adHoc.body.memory_updated, true)
    const after = await f.call('GET', uiPath(f, `/knowledge-nodes/${f.nodeIds[0]}/memory`))
    assert.equal((after.body.memory as Json).reps, 1)
  } finally {
    f.close()
  }
})

test('http: with a model the recall check can propose coverage and the learner confirms it', async () => {
  const port = scriptedPort(
    JSON.stringify({
      coach_message: '覆盖了定义，但缺少适用条件。',
      key_points_covered: ['kp1'],
      key_points_missing: ['kp2'],
      cannot_judge: [],
      next_question: '适用条件是什么？',
      citations: [],
      missing_information: [],
    }),
  )
  const f = fixture({ port })
  try {
    addConfirmedCard(f, f.nodeIds[0], [
      { id: 'kp1', text: '极限的 ε-δ 定义', required: true },
      { id: 'kp2', text: '去心邻域条件', required: true },
    ])
    const created = await f.call('POST', uiPath(f, '/learning-sessions'), {
      body: { subject_id: f.subjectId, mode: 'daily', budget_minutes: 20 },
    })
    const sessionId = String(created.body.session_id)
    await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/start`))
    let step: Json | undefined
    for (const candidate of created.body.steps as Json[]) {
      if (candidate.kind === 'recall') {
        step = candidate
        break
      }
      await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(candidate.ordinal)}/skip`), {
        body: { reason: '测试先做回忆' },
      })
    }
    assert.ok(step)
    await f.call('POST', uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(step.ordinal)}/activate`))
    const recalled = await f.call(
      'POST',
      uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(step.ordinal)}/recall`),
      { body: { text: '极限是无限接近', confidence_before: 5 } },
    )
    assert.equal(recalled.status, 200)
    assert.equal(port.calls, 1)
    const recall = recalled.body.recall as Json
    const coverage = recall.coverage as Json
    assert.deepEqual(coverage.covered, ['kp1'])
    assert.deepEqual(coverage.missing, ['kp2'])
    assert.equal(coverage.coverage, 0.5)
    assert.equal(recall.suggested_rating, 'hard')
    assert.ok(recalled.body.coach_turn, 'the validated coach turn is returned but nothing is stored as a score')
    const confirmed = await f.call(
      'POST',
      uiPath(f, `/learning-sessions/${sessionId}/steps/${Number(step.ordinal)}/recall/confirm`),
      { body: { rating: 'hard' }, key: 'model-confirm' },
    )
    assert.equal(confirmed.status, 200)
    const event = confirmed.body.event as Json
    assert.equal(event.source, 'model_assisted_confirmed')
    assert.equal((event.coverage as Json).coverage, 0.5)
  } finally {
    f.close()
  }
})
