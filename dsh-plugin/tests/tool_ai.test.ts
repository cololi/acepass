import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAction } from '../src/actions/run.ts'
import type { CapabilityResult, LlmPort } from '../src/llm/port.ts'
import { FORMAL_WRITE_TARGETS, AI_WRITE_TARGETS } from '../src/ai/outcome.ts'

/**
 * End-to-end for the `ai_explain` action: prompt -> model -> parse -> validate -> disposition.
 *
 * The point of these tests is the *invariant*, not the plumbing: with no model configured the tool
 * must say so instead of inventing a result, and no path may report a score or a mastery state as
 * something it wrote.
 */

function toolWith(answer: CapabilityResult | (() => Promise<CapabilityResult>)) {
  const llm: LlmPort = {
    availability: async () => ({ explain: { available: true } } as never),
    run: typeof answer === 'function' ? (answer as () => Promise<CapabilityResult>) : async () => answer,
  }
  // The action layer is pure: no DSH, so it can be driven directly.
  return {
    execute: (args: {action: string; payload_json?: string}, _exec: unknown) => {
      let payload: Record<string, unknown> = {}
      if (args.payload_json) {
        try { payload = JSON.parse(args.payload_json) } catch { return { ok: false, error: { code: 'bad_payload', message: 'payload_json is not valid JSON' } } }
      }
      return runAction(args.action, payload, { llm: () => llm })
    },
  }
}

const REQUEST = {
  action: 'ai_explain',
  payload_json: JSON.stringify({
    question_type: 'single_choice',
    stem_text: '求 1+1',
    options: [],
    answer_summary: '2',
    explanation_blocks: [],
    allowed_citation_ids: ['cite-1'],
  }),
}

const ok = (text: string): CapabilityResult => ({
  ok: true,
  text,
  route: { provider: 'test', model: 'fake' },
  promptVersion: 'p0-explain-v1',
  capability: 'explain',
  latencyMs: 5,
})

const VALID_EXPLANATION = JSON.stringify({
  key_conditions: ['整数加法'],
  stuck_points: [],
  explanation_blocks: [{ kind: 'text', text: '把两个数相加得到 2。' }, { kind: 'math', latex: '1+1=2' }],
  method_summary: '直接相加',
  suggested_next: [],
  missing_information: [],
  citations: ['cite-1'],
})

test('ai_explain: with no model configured it says so and fabricates nothing', async () => {
  const tool = toolWith({
    ok: false,
    code: 'ai_not_configured',
    message: 'no model configured',
    capability: 'explain',
    promptVersion: 'p0-explain-v1',
    retryable: false,
  })
  const result = (await tool.execute(REQUEST, {})) as Record<string, any>
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ai_not_configured')
  assert.equal(result.disposition, undefined, 'a missing model must not produce a disposition')
  assert.equal(result.explanation, undefined, 'nothing may be claimed as produced')
})

test('ai_explain: a valid explanation succeeds and the writable targets exclude formal facts', async () => {
  const tool = toolWith(ok(VALID_EXPLANATION))
  const result = (await tool.execute(REQUEST, {})) as Record<string, any>
  assert.equal(result.ok, true)
  assert.equal(result.disposition.status, 'succeeded')
  assert.deepEqual(result.problems, [])
  assert.equal(result.explanation.method_summary, '直接相加')

  for (const target of result.disposition.writes) {
    assert.ok((AI_WRITE_TARGETS as readonly string[]).includes(target), `unknown write target ${target}`)
    assert.ok(
      !(FORMAL_WRITE_TARGETS as readonly string[]).includes(target),
      `an AI job result must never write ${target}`,
    )
  }
})

test('ai_explain: model output that is not JSON is refused, never half-read', async () => {
  const tool = toolWith(ok('这不是 JSON'))
  const result = (await tool.execute(REQUEST, {})) as Record<string, any>
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ai_invalid_output')
  assert.equal(result.disposition.status, 'rejected')
  assert.equal(result.disposition.keepCandidate, false)
})

test('ai_explain: a citation outside the retrieval scope rejects the answer', async () => {
  const tool = toolWith(
    ok(JSON.stringify({ ...JSON.parse(VALID_EXPLANATION), citations: ['cite-unknown'] })),
  )
  const result = (await tool.execute(REQUEST, {})) as Record<string, any>
  assert.equal(result.ok, true)
  assert.equal(result.disposition.status, 'rejected')
  assert.equal(result.disposition.keepCandidate, false)
  assert.ok(
    result.problems.some((problem: { code: string }) => problem.code === 'unknown_citation'),
    'the reason must name the rejected citation',
  )
})

test('ai_explain: an explanation with no usable content never reaches a reader', async () => {
  // The Python rule is `blocks empty AND key_conditions empty` — an answer with no blocks but a
  // recorded key condition is still a usable explanation, so both have to be empty here.
  const tool = toolWith(
    ok(JSON.stringify({ ...JSON.parse(VALID_EXPLANATION), explanation_blocks: [], key_conditions: [] })),
  )
  const result = (await tool.execute(REQUEST, {})) as Record<string, any>
  assert.equal(result.disposition.status, 'rejected')
  assert.ok(result.problems.some((problem: { code: string }) => problem.code === 'empty_explanation'))
})

test('ai_explain: a rate limit is reported as retryable and writes nothing', async () => {
  const tool = toolWith((async () => ({
    ok: false,
    code: 'ai_rate_limited',
    message: 'slow down',
    capability: 'explain',
    promptVersion: 'p0-explain-v1',
    retryable: true,
  })) as never)
  const result = (await tool.execute(REQUEST, {})) as Record<string, any>
  assert.equal(result.ok, false)
  assert.equal(result.error.retryable, true)
  assert.equal(result.disposition, undefined)
})

test('ai_explain: a malformed payload_json is refused before any model call', async () => {
  let called = false
  const tool = toolWith((async () => {
    called = true
    return ok(VALID_EXPLANATION)
  }) as never)
  const result = (await tool.execute({ action: 'ai_explain', payload_json: '{oops' }, {})) as Record<string, any>
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad_payload')
  assert.equal(called, false, 'no model call may happen for an unusable payload')
})
