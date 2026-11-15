import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as validators from '../src/ai/validators.ts'
import { parseModelJson, plain, stripCodeFence } from '../src/ai/pyvalue.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/ai_validators.json', import.meta.url), 'utf8'))

type Case = {
  name: string
  validator: string
  payload: string
  kwargs: Record<string, any>
  clean: unknown
  problems: unknown[]
}

const CALLERS: Record<string, (payload: unknown, kwargs: Record<string, any>) => readonly [unknown, unknown[]]> = {
  validate_extract_payload: (payload, kwargs) =>
    validators.validateExtractPayload(payload, {
      allowed_asset_ids: kwargs.allowed_asset_ids == null ? null : new Set(kwargs.allowed_asset_ids),
    }) as readonly [unknown, unknown[]],
  validate_explain_payload: (payload, kwargs) =>
    validators.validateExplainPayload(payload, {
      allowed_citation_ids: new Set(kwargs.allowed_citation_ids),
    }) as readonly [unknown, unknown[]],
  validate_tag_suggestions: (payload, kwargs) =>
    validators.validateTagSuggestions(payload, {
      allowed_node_names: new Set(kwargs.allowed_node_names),
    }) as readonly [unknown, unknown[]],
  validate_transcription: (payload) => validators.validateTranscription(payload) as readonly [unknown, unknown[]],
  validate_estimate: (payload, kwargs) =>
    validators.validateEstimate(payload, { criteria: kwargs.criteria }) as readonly [unknown, unknown[]],
  validate_diagnosis: (payload) => validators.validateDiagnosis(payload) as readonly [unknown, unknown[]],
  validate_variant_payload: (payload, kwargs) =>
    validators.validateVariantPayload(payload, {
      question_type: kwargs.question_type,
      avoid_stems: kwargs.avoid_stems ?? [],
    }) as readonly [unknown, unknown[]],
}

/** Strip `undefined` exactly like the JSON round-trip the Python generator performs. */
const jsonSafe = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

test(`validators: ${golden.cases.length} payloads match the Python validators`, () => {
  const failures: string[] = []
  for (const entry of golden.cases as Case[]) {
    const caller = CALLERS[entry.validator]
    assert.ok(caller, `unknown validator in golden: ${entry.validator}`)
    const [clean, problems] = caller(parseModelJson(entry.payload), entry.kwargs)
    try {
      assert.deepEqual(jsonSafe(clean), entry.clean)
      assert.deepEqual(jsonSafe(problems), entry.problems)
    } catch (error) {
      failures.push(`${entry.name}: ${(error as Error).message.split('\n').slice(0, 6).join(' | ')}`)
    }
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length}/${golden.cases.length} validator outputs differ`)
})

test('validators: every validator and every problem code in the corpus is exercised', () => {
  assert.deepEqual([...new Set((golden.cases as Case[]).map((entry) => entry.validator))].sort(), Object.keys(CALLERS).sort())
  const produced = new Set<string>()
  for (const entry of golden.cases as Case[]) {
    const caller = CALLERS[entry.validator]
    const [, problems] = caller(parseModelJson(entry.payload), entry.kwargs)
    for (const problem of problems as { code: string }[]) produced.add(problem.code)
  }
  assert.deepEqual([...produced].sort(), [...golden.coverage.problem_codes].sort())
})

test('validators: the tag/variant provider-payload quirk is preserved, not "fixed"', () => {
  // `knowledge.services.suggestions` and `question_bank.services.variants` pass `call.payload` to
  // the validator instead of parsing `raw_text`. The real provider's payload is `{text: ...}`, so a
  // successful model answer still yields zero tag proposals / a blocked variant. The migration keeps
  // this behaviour (inventory §4.3 flags it as a product decision, not a port decision).
  const tagCase = (golden.cases as Case[]).find((entry) => entry.name === 'tags/provider-payload-text-only')
  assert.ok(tagCase)
  const [tags, tagProblems] = validators.validateTagSuggestions(parseModelJson(tagCase.payload), {
    allowed_node_names: new Set(tagCase.kwargs.allowed_node_names),
  })
  assert.deepEqual(tags, [])
  assert.deepEqual(tagProblems, [])

  const variantCase = (golden.cases as Case[]).find((entry) => entry.name === 'variant/provider-payload-text-only')
  assert.ok(variantCase)
  const [clean, variantProblems] = validators.validateVariantPayload(parseModelJson(variantCase.payload), {
    question_type: 'single_choice',
    avoid_stems: variantCase.kwargs.avoid_stems,
  })
  const codes = (variantProblems as { code: string }[]).map((problem) => problem.code)
  assert.ok(codes.includes('content_not_object'))
  assert.ok(codes.includes('variant_answer_missing'))
  assert.equal((clean as { practice_max_score: string | null }).practice_max_score, null)
})

test('validators: never invent a formal score from unusable estimate output', () => {
  // R-AI-08: an empty estimate must not become a zero. The validator drops every row and reports
  // `empty_estimate`; the disposition layer (outcome.ts) is what turns that into a rejected run.
  const [clean, problems] = validators.validateEstimate(
    { criteria: [{ criterion_id: 'c1', estimated_score: 'nan' }] },
    { criteria: [{ criterion_id: 'c1', max_score: '2.00' }] },
  )
  assert.deepEqual((clean as { criteria: unknown[] }).criteria, [])
  assert.deepEqual((problems as { code: string }[]).map((p) => p.code), ['bad_score', 'empty_estimate'])
})

test('validators: over-cap scores are truncated but the problem stays visible', () => {
  const [clean, problems] = validators.validateEstimate(
    { criteria: [{ criterion_id: 'c1', estimated_score: '9.00' }] },
    { criteria: [{ criterion_id: 'c1', max_score: '2.00' }] },
  )
  assert.deepEqual(clean, { criteria: [{ criterion_id: 'c1', estimated_score: '2.00', rationale: '', missing_evidence: [] }], overall_note: '', confidence: null })
  assert.deepEqual((problems as { code: string }[]).map((p) => p.code), ['score_over_cap'])
})

test(`raw text: ${golden.parsing.length} code-fence/JSON cases match Python`, () => {
  const failures: string[] = []
  for (const entry of golden.parsing as { input: string; stripped: string; parsed: unknown; error: string | null }[]) {
    const stripped = stripCodeFence(entry.input)
    if (stripped !== entry.stripped) {
      failures.push(`${JSON.stringify(entry.input)}: stripped ${JSON.stringify(stripped)} != ${JSON.stringify(entry.stripped)}`)
      continue
    }
    if (entry.error === null) {
      try {
        assert.deepEqual(plain(parseModelJson(entry.input)), entry.parsed)
      } catch (error) {
        failures.push(`${JSON.stringify(entry.input)}: parsed value differs: ${(error as Error).message.split('\n')[0]}`)
      }
    } else {
      assert.throws(() => parseModelJson(entry.input), SyntaxError, `expected a parse error for ${JSON.stringify(entry.input)}`)
    }
  }
  assert.deepEqual(failures, [])
})
