import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import * as ai from '../src/ai/index.ts'
import { pyLen } from '../src/ai/pyvalue.ts'
import { GradeMethod, GradeStatus } from '../src/domain/grading.ts'

const runtime = JSON.parse(readFileSync(new URL('./golden/ai_runtime.json', import.meta.url), 'utf8'))
const promptGolden = JSON.parse(readFileSync(new URL('./golden/ai_prompts.json', import.meta.url), 'utf8'))

/* --------------------------------------------------------------- llm_run shape */

test('llm_run: column metadata matches the Django model introspection', () => {
  const fields = ai.LLM_RUN_FIELDS.map((field) => ({ ...field, choices: field.choices ?? null }))
  assert.deepEqual(fields, runtime.llm_run.fields)
})

test('llm_run: table name, statuses and index columns match', () => {
  assert.equal(ai.LLM_RUN_TABLE, runtime.llm_run.table)
  assert.deepEqual(
    ai.LLM_RUN_STATUSES.map((status) => [status, ai.LLM_RUN_STATUS_LABELS[status]]),
    runtime.llm_run.statuses,
  )
  assert.deepEqual(
    runtime.llm_run.indexes.map((index: { fields: string[] }) => index.fields),
    [['provider', '-created_at'], ['capability', 'status']],
  )
})

test('llm_run: a fresh row is born failed, un-priced and never a stub', () => {
  const record = ai.newLlmRun({
    provider: 'deepseek',
    model_identifier: 'deepseek-chat',
    capability: 'explain',
    prompt_version: ai.EXPLAIN_PROMPT_VERSION,
  })
  assert.equal(record.status, 'failed')
  assert.equal(record.cost_known, false)
  assert.equal(record.cost_cents, null)
  assert.equal(record.is_stub, false)
  assert.equal(record.attempts, 1)
  assert.deepEqual(record.request_summary, {})
  assert.deepEqual(record.retrieval_source_ids, [])
  // The Python dataclass defaults the same way for the fields the contract depends on.
  const defaults = Object.fromEntries(
    runtime.ai_call_result.fields.map((field: { name: string; default: unknown }) => [field.name, field.default]),
  )
  assert.equal(defaults.cost_known, record.cost_known)
  assert.equal(defaults.is_stub, record.is_stub)
  assert.equal(defaults.attempts, record.attempts)
})

test('llm_run: success records tokens but never invents a cost', () => {
  const base = ai.newLlmRun({ provider: 'p', capability: 'suggest_tags', prompt_version: ai.SUGGEST_TAGS_PROMPT_VERSION })
  const withUsage = ai.markSucceeded(base, { promptTokens: 12, completionTokens: 34, latencyMs: 90, rawText: '{"tags": []}' }, { accepted: 0, problems: [] })
  assert.equal(withUsage.status, 'succeeded')
  assert.equal(withUsage.prompt_tokens, 12)
  assert.equal(withUsage.completion_tokens, 34)
  assert.equal(withUsage.latency_ms, 90)
  assert.equal(withUsage.cost_known, false)
  assert.equal(withUsage.cost_cents, null)

  // A price that arrives without `cost_known` is unverified: it is dropped, not stored.
  const unverified = ai.markSucceeded(base, { costCents: '1.2345', costKnown: false }, {})
  assert.equal(unverified.cost_cents, null)
  assert.equal(unverified.cost_known, false)
  // A price that the provider actually declared is kept.
  const verified = ai.markSucceeded(base, { costCents: '1.2345', costKnown: true }, {})
  assert.equal(verified.cost_cents, '1.2345')
  assert.equal(verified.cost_known, true)
})

test('llm_run: the raw excerpt is truncated per capability, by code point', () => {
  const raw = '😀'.repeat(3000)
  const tags = ai.markSucceeded(
    ai.newLlmRun({ provider: 'p', capability: 'suggest_tags', prompt_version: ai.SUGGEST_TAGS_PROMPT_VERSION }),
    { rawText: raw },
    {},
  )
  const explain = ai.markSucceeded(
    ai.newLlmRun({ provider: 'p', capability: 'explain', prompt_version: ai.EXPLAIN_PROMPT_VERSION }),
    { rawText: raw },
    {},
  )
  assert.equal(pyLen(tags.raw_response_excerpt), 2000)
  assert.equal(pyLen(explain.raw_response_excerpt), 3000)
  assert.equal(tags.raw_response_excerpt, '😀'.repeat(2000))
})

test('llm_run: failures map to the same statuses the Django call sites store', () => {
  const base = ai.newLlmRun({ provider: 'p', capability: 'explain', prompt_version: ai.EXPLAIN_PROMPT_VERSION })
  const failed = ai.markFailed(base, { code: 'ai_not_configured', message: '未配置' })
  assert.equal(failed.status, 'unavailable')
  assert.equal(failed.error_code, 'ai_not_configured')
  assert.equal(failed.cost_known, false)
  assert.equal(failed.cost_cents, null)
  assert.equal(ai.markFailed(base, { code: 'ai_timeout', message: '超时' }).status, 'timeout')
  assert.equal(ai.markFailed(base, { code: 'ai_invalid_output', message: 'bad' }).status, 'rejected')
  assert.equal(ai.markFailed(base, { code: 'ai_empty', message: 'empty' }).status, 'rejected')
  assert.equal(ai.markFailed(base, { code: 'ai_rate_limited', message: '429' }).status, 'failed')
  assert.equal(ai.markFailed(base, { code: 'ai_error', message: 'x'.repeat(900) }).error_message.length, 500)

  const rejected = ai.markRejected(
    base,
    { promptTokens: 1, completionTokens: 2, rawText: 'not json' },
    { problems: [{ code: 'not_object', message: '模型输出不是对象' }] },
    '模型输出不是合法 JSON',
  )
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error_code, 'ai_invalid_output')
  assert.equal(rejected.prompt_tokens, 1)
  assert.equal(rejected.raw_response_excerpt, 'not json')
})

test('llm_run: Python collapses unsupported capability into ai_not_configured; the port splits it', () => {
  // The deviation is deliberate and visible in the report: callers need to tell "configure a
  // provider" apart from "this model cannot read images". This test locks both facts so neither
  // side drifts silently.
  assert.equal(runtime.failure_paths.capability_not_declared.code, 'ai_not_configured')
  assert.equal(runtime.failure_paths.vision_model_missing.code, 'ai_not_configured')
  assert.equal(ai.preflightFailure({ hasModel: false, vision: false }, 'extract_question')?.code, 'ai_not_configured')
  assert.equal(ai.statusForFailureCode('ai_capability_unsupported'), 'unavailable')
})

/* --------------------------------------------------------------- degradation */

const STATUS_CONFIGS: Record<string, { hasModel: boolean; vision: boolean }> = {
  none: { hasModel: false, vision: false },
  openai_missing_key: { hasModel: false, vision: false },
  openai_missing_base_url: { hasModel: false, vision: false },
  unknown_provider: { hasModel: false, vision: false },
  stub_refused: { hasModel: false, vision: false },
  openai_text_only: { hasModel: true, vision: false },
  openai_text_vision: { hasModel: true, vision: true },
}

test('degradation: the availability table matches provider_status() for every provider configuration', () => {
  assert.deepEqual([...ai.CAPABILITIES].sort(), [...runtime.providers.capabilities].sort())
  assert.deepEqual([...ai.P0_CAPABILITIES], runtime.providers.p0_capabilities)
  for (const [name, facts] of Object.entries(STATUS_CONFIGS)) {
    const pythonStatus = runtime.provider_status[name]
    const table = ai.capabilityAvailability(facts)
    const available = Object.fromEntries(ai.CAPABILITIES.map((capability) => [capability, table[capability].available]))
    assert.deepEqual(available, pythonStatus.capabilities, `${name}: availability table differs`)
    assert.equal(pythonStatus.is_stub, false)
  }
})

test('degradation: messages are the provider_status() strings, and stub is never claimed', () => {
  assert.equal(runtime.provider_status.none.message, ai.UNCONFIGURED_MESSAGE)
  assert.equal(runtime.provider_status.openai_text_vision.message, ai.CONFIGURED_MESSAGE)
  assert.equal(ai.availabilityMessage(false), ai.UNCONFIGURED_MESSAGE)
  assert.equal(ai.availabilityMessage(true), ai.CONFIGURED_MESSAGE)
  assert.equal(ai.failure('ai_not_configured', 'x').retryable, false)
  assert.equal(ai.failure('ai_timeout', 'x').retryable, true)
  assert.equal(ai.failure('ai_rate_limited', 'x').retryable, true)
})

test('degradation: the reason for each unavailable capability is explicit', () => {
  const noModel = ai.capabilityAvailability({ hasModel: false, vision: false })
  assert.equal(noModel.embed.reason, 'ai_capability_unsupported')
  assert.equal(noModel.explain.reason, 'ai_not_configured')
  const textOnly = ai.capabilityAvailability({ hasModel: true, vision: false })
  assert.equal(textOnly.extract_question.reason, 'ai_capability_unsupported')
  assert.equal(textOnly.transcribe_handwriting.reason, 'ai_capability_unsupported')
  assert.equal(textOnly.suggest_tags.available, true)
  assert.equal(textOnly.embed.available, false)
  // `embed` has no prompt version: a capability without an instruction cannot be rendered.
  assert.deepEqual([...ai.PROMPT_CAPABILITIES].sort(), Object.keys(promptGolden.versions).sort())
  for (const [capability, version] of Object.entries(ai.PROMPT_VERSIONS)) {
    assert.equal(promptGolden.versions[capability], version)
  }
})

/* --------------------------------------------------------------- write invariant */

test('outcome: AI may only write candidates and audit rows', () => {
  for (const target of ai.FORMAL_WRITE_TARGETS) {
    assert.equal(ai.isAiWritableTarget(target), false, `${target} must not be AI-writable`)
    assert.throws(() => ai.assertAiWritableTarget(target), /不得写入/)
  }
  for (const target of ai.AI_WRITE_TARGETS) {
    assert.equal(ai.isAiWritableTarget(target), true)
    assert.doesNotThrow(() => ai.assertAiWritableTarget(target))
  }
})

test('outcome: dispositions follow the seven call sites, including "problems but still stored"', () => {
  const problem = { code: 'unknown_tag_name', message: 'x' }
  assert.deepEqual(ai.validationDisposition('extract_question', {}, [problem]), {
    status: 'rejected', keepCandidate: true, reason: 'validation_problems', writes: ['llm_run', 'import_candidate'],
  })
  assert.deepEqual(ai.validationDisposition('explain', {}, [problem]), {
    status: 'rejected', keepCandidate: false, reason: 'validation_problems', writes: ['llm_run'],
  })
  assert.equal(ai.validationDisposition('suggest_tags', [], [problem]).status, 'succeeded')
  assert.equal(ai.validationDisposition('transcribe_handwriting', {}, [problem]).status, 'succeeded')
  assert.equal(ai.validationDisposition('diagnose', {}, [problem]).status, 'succeeded')
  assert.deepEqual(ai.validationDisposition('estimate_grade', { criteria: [] }, [problem]), {
    status: 'rejected', keepCandidate: false, reason: 'no_usable_criteria', writes: ['llm_run'],
  })
  assert.deepEqual(ai.validationDisposition('estimate_grade', { criteria: [{}] }, []), {
    status: 'succeeded', keepCandidate: true, reason: 'estimated_event_stored', writes: ['llm_run', 'ai_estimate_event'],
  })
  assert.equal(ai.validationDisposition('propose_variant', {}, [problem]).status, 'rejected')
  assert.equal(ai.validationDisposition('propose_variant', {}, [{ ...problem, severity: 'warning' }]).status, 'succeeded')
  assert.deepEqual(ai.validationDisposition('propose_variant', {}, []), {
    status: 'succeeded', keepCandidate: true, reason: 'candidate_stored', writes: ['llm_run', 'import_candidate'],
  })
})

test('outcome: an estimate is estimated, never confirmed', () => {
  assert.equal(ai.AI_GRADE_EVENT.status, GradeStatus.ESTIMATED)
  assert.equal(ai.AI_GRADE_EVENT.method, GradeMethod.AI_ESTIMATED)
  assert.equal(ai.isConfirmedGradeStatus(ai.AI_GRADE_EVENT.status), false)
  assert.equal(ai.isConfirmedGradeStatus(GradeStatus.CONFIRMED), true)
  assert.doesNotThrow(() => ai.assertNotConfirmedGrade(GradeStatus.ESTIMATED, GradeMethod.AI_ESTIMATED))
  assert.throws(() => ai.assertNotConfirmedGrade(GradeStatus.CONFIRMED, GradeMethod.AI_ESTIMATED))
  assert.throws(() => ai.assertNotConfirmedGrade(GradeStatus.ESTIMATED, GradeMethod.REVIEWER_CONFIRMED))
  // A rejected estimate never writes an event at all.
  assert.ok(!ai.validationDisposition('estimate_grade', { criteria: [] }, []).writes.includes('ai_estimate_event'))
})

/* --------------------------------------------------------------- purity */

test('purity: src/ai has no clock, randomness, storage, network or DSH import', () => {
  const directory = new URL('../src/ai/', import.meta.url)
  const files = readdirSync(directory).filter((name) => name.endsWith('.ts'))
  assert.ok(files.length >= 6)
  const forbidden: [RegExp, string][] = [
    [/Date\.now|new Date\(/, 'clock'],
    [/performance\.now/, 'clock'],
    [/Math\.random/, 'randomness'],
    [/from 'node:/, 'Node API'],
    [/@deepseek-ai/, 'DSH import'],
    [/process\.env/, 'environment'],
    [/setTimeout|setInterval/, 'timer'],
    [/fetch\(|XMLHttpRequest/, 'network'],
    [/is_stub:\s*true/, 'stub output'],
    [/StubProvider/, 'stub provider'],
    [/TODO|FIXME/, 'unfinished marker'],
  ]
  const offences: string[] = []
  for (const file of files) {
    const source = readFileSync(new URL(file, directory), 'utf8')
    for (const [pattern, label] of forbidden) {
      if (pattern.test(source)) offences.push(`${file}: ${label} (${pattern})`)
    }
  }
  assert.deepEqual(offences, [])
})
