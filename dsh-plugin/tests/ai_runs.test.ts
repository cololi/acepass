import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows } from '../src/store/repository.ts'
import { runCapability, capabilitiesOf } from '../src/services/ai_runs.ts'
import type { CapabilityRequest, CapabilityResult, LlmPort } from '../src/llm/contract.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2027-06-01T00:00:00+00:00')
const REQUEST: CapabilityRequest = {
  capability: 'explain',
  promptVersion: 'explain-v1',
  system: 's',
  prompt: 'p',
}

function store(): { db: DatabaseSync; close: () => void } {
  const handle = openStore({ path: ':memory:' })
  return { db: handle.db, close: handle.close }
}

function portReturning(result: CapabilityResult): LlmPort {
  return {
    availability: async () => ({}) as never,
    run: async () => result,
  }
}

test('ai runs: a successful call leaves one row with its tokens and no invented cost', async () => {
  const s = store()
  try {
    const outcome = await runCapability(
      s.db,
      portReturning({
        ok: true,
        text: '{"x":1}',
        route: { provider: 'p', model: 'm' },
        promptVersion: 'explain-v1',
        capability: 'explain',
        usage: { inputTokens: 12, outputTokens: 34 },
        latencyMs: 5,
      }),
      REQUEST,
      { userId: null, projectId: null, requestSummary: { question_id: 'q1' } },
      NOW,
      { validation: { ok: true } },
    )
    assert.equal(outcome.result.ok, true)
    const rows = findRows(s.db, 'audit_llm_run', {})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'succeeded')
    assert.equal(rows[0].capability, 'explain')
    assert.equal(rows[0].prompt_version, 'explain-v1')
    assert.equal(Number(rows[0].prompt_tokens), 12)
    assert.equal(Number(rows[0].completion_tokens), 34)
    assert.equal(rows[0].cost_known, false, 'dsh-llm reports no price, so no cost may be claimed')
    assert.equal(rows[0].cost_cents, null)
    assert.equal(rows[0].is_stub, false)
    assert.deepEqual(rows[0].validation_result, { ok: true })
    assert.deepEqual(rows[0].request_summary, { question_id: 'q1' })
  } finally {
    s.close()
  }
})

test('ai runs: an unconfigured model leaves an "unavailable" row, not silence', async () => {
  const s = store()
  try {
    const outcome = await runCapability(
      s.db,
      portReturning({
        ok: false,
        code: 'ai_not_configured',
        message: '未配置文本模型',
        capability: 'explain',
        promptVersion: 'explain-v1',
        retryable: false,
      }),
      REQUEST,
      { userId: null, projectId: null },
      NOW,
    )
    assert.equal(outcome.result.ok, false)
    const rows = findRows(s.db, 'audit_llm_run', {})
    assert.equal(rows.length, 1, '"we never asked" and "the model produced nothing" must be distinguishable')
    assert.equal(rows[0].status, 'unavailable')
    assert.equal(rows[0].error_code, 'ai_not_configured')
    assert.match(String(rows[0].error_message), /未配置文本模型/)
  } finally {
    s.close()
  }
})

test('ai runs: a transport failure is recorded as failed, a bad answer as rejected', async () => {
  const s = store()
  try {
    await runCapability(
      s.db,
      portReturning({
        ok: false,
        code: 'ai_timeout',
        message: '超时',
        capability: 'explain',
        promptVersion: 'explain-v1',
        retryable: true,
      }),
      REQUEST,
      { userId: null, projectId: null },
      NOW,
    )
    const failed = findRows(s.db, 'audit_llm_run', {})[0]
    assert.equal(failed.status, 'timeout')
    assert.equal(failed.error_code, 'ai_timeout')

    await runCapability(
      s.db,
      portReturning({
        ok: false,
        code: 'ai_schema_invalid' as never,
        message: 'JSON 结构不符',
        capability: 'explain',
        promptVersion: 'explain-v1',
        retryable: false,
      }),
      REQUEST,
      { userId: null, projectId: null },
      NOW,
      { validation: { ok: false, problem: 'missing keys' } },
    )
    const rows = findRows(s.db, 'audit_llm_run', {}).sort((a, b) => String(a.status).localeCompare(String(b.status)))
    assert.equal(rows.length, 2)
    const rejected = rows.find((row) => row.status === 'rejected')
    assert.ok(rejected, 'an unusable answer is a rejection with a reason, not a transport failure')
    assert.deepEqual(rejected!.validation_result, { ok: false, problem: 'missing keys' })
  } finally {
    s.close()
  }
})

test('ai runs: the same call twice writes two rows, one per attempt', async () => {
  const s = store()
  try {
    const port = portReturning({
      ok: true,
      text: 'x',
      route: { provider: 'p', model: 'm' },
      promptVersion: 'explain-v1',
      capability: 'explain',
      latencyMs: 1,
    })
    await runCapability(s.db, port, REQUEST, { userId: null, projectId: null }, NOW)
    await runCapability(s.db, port, REQUEST, { userId: null, projectId: null }, NOW)
    assert.equal(findRows(s.db, 'audit_llm_run', {}).length, 2, 'each attempt is auditable on its own')
  } finally {
    s.close()
  }
})

test('ai runs: a capability without a prompt version is refused before any row is written', async () => {
  const s = store()
  try {
    await assert.rejects(
      () =>
        runCapability(
          s.db,
          portReturning({ ok: true, text: '', route: { provider: 'p', model: 'm' }, promptVersion: 'x', capability: 'embed', latencyMs: 1 }),
          { ...REQUEST, capability: 'embed' },
          { userId: null, projectId: null },
          NOW,
        ),
      /cannot be audited/,
    )
    assert.equal(findRows(s.db, 'audit_llm_run', {}).length, 0, 'a row would claim a call that cannot happen')
  } finally {
    s.close()
  }
})

test('ai runs: availability is passed through untouched', async () => {
  const port: LlmPort = {
    availability: async () => ({ explain: { available: false, reason: 'ai_not_configured' } }) as never,
    run: async () => ({ ok: false, code: 'ai_not_configured', message: '', capability: 'explain', promptVersion: 'explain-v1', retryable: false }),
  }
  const capabilities = await capabilitiesOf(port)
  assert.deepEqual(capabilities, { explain: { available: false, reason: 'ai_not_configured' } })
})
