import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as prompts from '../src/ai/prompts.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/ai_prompts.json', import.meta.url), 'utf8'))

type Builder = (input: Record<string, unknown>) => string
const BUILDERS: Record<string, Builder> = {
  build_extract_prompt: prompts.buildExtractPrompt as unknown as Builder,
  build_explain_prompt: prompts.buildExplainPrompt as unknown as Builder,
  build_tag_suggestion_prompt: prompts.buildTagSuggestionPrompt as unknown as Builder,
  build_transcribe_prompt: prompts.buildTranscribePrompt as unknown as Builder,
  build_estimate_prompt: prompts.buildEstimatePrompt as unknown as Builder,
  build_diagnose_prompt: prompts.buildDiagnosePrompt as unknown as Builder,
  build_variant_prompt: prompts.buildVariantPrompt as unknown as Builder,
}

test('prompt versions match the Python registry', () => {
  assert.deepEqual(
    {
      extract_question: prompts.EXTRACT_PROMPT_VERSION,
      explain: prompts.EXPLAIN_PROMPT_VERSION,
      suggest_tags: prompts.SUGGEST_TAGS_PROMPT_VERSION,
      transcribe_handwriting: prompts.TRANSCRIBE_PROMPT_VERSION,
      estimate_grade: prompts.ESTIMATE_GRADE_PROMPT_VERSION,
      diagnose: prompts.DIAGNOSE_PROMPT_VERSION,
      propose_variant: prompts.PROPOSE_VARIANT_PROMPT_VERSION,
    },
    golden.versions,
  )
})

test('system instructions are byte-identical to the Python constants', () => {
  assert.deepEqual(
    {
      extract: prompts.EXTRACT_SYSTEM,
      explain: prompts.EXPLAIN_SYSTEM,
      suggest_tags: prompts.SUGGEST_TAGS_SYSTEM,
      transcribe: prompts.TRANSCRIBE_SYSTEM,
      estimate: prompts.ESTIMATE_SYSTEM,
      diagnose: prompts.DIAGNOSE_SYSTEM,
      propose_variant: prompts.VARIANT_SYSTEM,
    },
    golden.systems,
  )
})

test(`renderers: ${golden.cases.length} prompts match the Python builders character for character`, () => {
  const failures: string[] = []
  for (const entry of golden.cases) {
    const builder = BUILDERS[entry.builder]
    assert.ok(builder, `unknown builder in golden: ${entry.builder}`)
    const got = builder(entry.kwargs)
    if (got !== entry.expected) {
      // Report the first differing offset, so a stray space is diagnosable rather than "diff in 9 KB".
      let index = 0
      while (index < got.length && index < entry.expected.length && got[index] === entry.expected[index]) index++
      failures.push(
        `${entry.name}: differs at ${index}; got ${JSON.stringify(got.slice(Math.max(0, index - 20), index + 40))} ` +
        `expected ${JSON.stringify(entry.expected.slice(Math.max(0, index - 20), index + 40))} ` +
        `(lengths ${got.length} vs ${entry.expected.length})`,
      )
    }
  }
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length}/${golden.cases.length} prompts differ`)
})

test('renderers: every prompt version is exercised by at least one golden case', () => {
  const builders = new Set(golden.cases.map((entry: { builder: string }) => entry.builder))
  assert.deepEqual([...builders].sort(), Object.keys(BUILDERS).sort())
})

test('renderers: diagnose lists exactly the controlled error types', () => {
  const caseEntry = golden.cases.find((entry: { name: string }) => entry.name === 'diagnose/typical')
  const rendered = prompts.buildDiagnosePrompt(caseEntry.kwargs)
  assert.match(rendered, /允许的 error_type：concept_gap, misread_question, calculation_slip, unit_or_sign_error, incomplete_reasoning, method_misapplied, guessing, unknown\n/)
  assert.deepEqual([...prompts.DIAGNOSIS_ERROR_TYPES], [
    'concept_gap', 'misread_question', 'calculation_slip', 'unit_or_sign_error',
    'incomplete_reasoning', 'method_misapplied', 'guessing', 'unknown',
  ])
})

test('renderers: truncation is by code point, not UTF-16 unit', () => {
  // `pySlice` exists because `.slice()` would cut an astral character in half and return 3001
  // UTF-16 units where Python returns 3000 code points. This is the vector that catches that.
  const caseEntry = golden.cases.find((entry: { name: string }) => entry.name === 'tags/astral-boundary')
  const rendered = prompts.buildTagSuggestionPrompt(caseEntry.kwargs)
  const stemLine = rendered.split('\n').find((line: string) => line.startsWith('题干：'))
  assert.ok(stemLine)
  const stem = stemLine.slice('题干：'.length)
  assert.equal(Array.from(stem).length, 3000)
  assert.equal(stem, '😀'.repeat(3000))
})
