import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateTypeRules } from '../src/services/type_rules.ts'
import { InvalidInput } from '../src/services/errors.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/type_rules.json', import.meta.url), 'utf8'))

test(`type rules: ${golden.cases.length} payloads match the Python validator`, () => {
  const failures: string[] = []
  for (const [index, entry] of golden.cases.entries()) {
    const input = 'raw_input' in entry ? entry.raw_input : entry.input
    try {
      validateTypeRules(input)
      if (!entry.ok) failures.push(`#${index} ${JSON.stringify(input)}: accepted, expected "${entry.message}"`)
    } catch (error) {
      if (!(error instanceof InvalidInput)) {
        failures.push(`#${index} ${JSON.stringify(input)}: wrong error type ${(error as Error).name}`)
        continue
      }
      if (entry.ok) {
        failures.push(`#${index} ${JSON.stringify(input)}: refused with "${error.message}", expected acceptance`)
        continue
      }
      if (error.message !== entry.message) {
        failures.push(`#${index} ${JSON.stringify(input)}: got "${error.message}", want "${entry.message}"`)
        continue
      }
      if (JSON.stringify(error.details) !== JSON.stringify(entry.details ?? {})) {
        failures.push(`#${index} ${JSON.stringify(input)}: details ${JSON.stringify(error.details)}`)
      }
    }
  }
  assert.deepEqual(failures, [], `type-rule mismatches:\n${failures.join('\n')}`)
})

test('type rules: a negative wrong_score is refused even though grading accepts one', () => {
  // The grading engine happily scores `wrong_score: "-1"`, but authoring one is rejected here.
  // This asymmetry exists in the Python implementation and is ported, not fixed.
  assert.throws(
    () => validateTypeRules({ single_choice: { default_max_score: '2', wrong_score: '-0.5' } }),
    /single_choice\.wrong_score 不能为负/,
  )
})

test('type rules: equality with the max score is allowed, one unit over is not', () => {
  assert.doesNotThrow(() => validateTypeRules({ single_choice: { default_max_score: '2', blank_score: '2' } }))
  assert.throws(
    () => validateTypeRules({ single_choice: { default_max_score: '2', blank_score: '2.0001' } }),
    /不能超过该题型满分/,
  )
})

test('type rules: an unknown type is named in the message and the details', () => {
  assert.throws(
    () => validateTypeRules({ bogus_type: {} }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidInput)
      assert.equal(error.message, '未知题型：bogus_type')
      assert.deepEqual(error.details, { type: 'bogus_type' })
      return true
    },
  )
})

test('type rules: the first failing type in key order decides the message', () => {
  // Python iterates the dict in insertion order; a port that reordered keys would report a
  // different problem than the original for the same payload.
  assert.throws(
    () =>
      validateTypeRules({
        single_choice: { default_max_score: '2' },
        multiple_choice: { default_max_score: '3', partial_score: '9' },
      }),
    /multiple_choice\.partial_score/,
  )
  assert.throws(
    () =>
      validateTypeRules({
        multiple_choice: { default_max_score: '3', partial_score: '9' },
        single_choice: { default_max_score: '-1' },
      }),
    /multiple_choice\.partial_score/,
    'the first key still decides',
  )
})
