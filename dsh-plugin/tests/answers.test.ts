import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateAnswerPayload } from '../src/domain/answers.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/answers.json', import.meta.url), 'utf8'))

test(`answers: ${golden.cases.length} payloads produce the Python problem list`, () => {
  const failures: string[] = []
  for (const [index, entry] of golden.cases.entries()) {
    const got = validateAnswerPayload(entry.payload, entry.question_type, entry.content ?? null)
    try {
      assert.deepEqual(got, entry.expected)
    } catch {
      failures.push(
        `#${index} ${entry.question_type} ${JSON.stringify(entry.payload)}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(entry.expected)}`,
      )
    }
  }
  assert.deepEqual(failures, [], `answer-payload mismatches:\n${failures.join('\n')}`)
})

test('answers: every problem code in the golden set is exercised', () => {
  const codes = new Set<string>()
  for (const entry of golden.cases) for (const problem of entry.expected) codes.add(problem.code)
  assert.ok(codes.size >= 30, `expected at least 30 distinct problem codes, saw ${codes.size}`)
})

test('answers: a material parent may not carry an answer', () => {
  assert.deepEqual(validateAnswerPayload({}, 'material'), [])
  assert.deepEqual(validateAnswerPayload(null, 'material'), [])
  assert.equal(validateAnswerPayload({ kind: 'material' }, 'material')[0].code, 'material_has_answer')
})

test('answers: false is a valid true/false answer but "false" is not', () => {
  assert.deepEqual(validateAnswerPayload({ kind: 'true_false', value: false }, 'true_false'), [])
  assert.equal(
    validateAnswerPayload({ kind: 'true_false', value: 'false' }, 'true_false')[0].code,
    'tf_value_missing',
  )
})

test('answers: a partial score without the policy is refused as an implicit guess', () => {
  const payload = { kind: 'multiple_choice', correct_option_ids: ['a'], partial_score: '1' }
  assert.equal(validateAnswerPayload(payload, 'multiple_choice')[0].code, 'partial_score_without_policy')
  // "0" and "0.00" are treated as "not configured", so they pass.
  for (const zero of ['0', '0.00', '']) {
    const ok = { ...payload, partial_score: zero }
    assert.deepEqual(validateAnswerPayload(ok, 'multiple_choice'), [], zero)
  }
})
