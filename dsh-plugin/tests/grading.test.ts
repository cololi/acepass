import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Decimal } from '../src/domain/decimal.ts'
import { grade, resultToDict, confirmedFraction } from '../src/domain/grading.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/grading.json', import.meta.url), 'utf8'))

test(`grade(): ${golden.cases.length} golden cases — status, scores, parts, detail, notes, rule_snapshot identical`, () => {
  const failures: string[] = []
  for (const [i, c] of golden.cases.entries()) {
    const got = grade({ question_type: c.question_type, raw_answer: c.raw_answer, answer_payload: c.answer_payload, max_score: Decimal.parse(c.max_score), rule: c.rule, rubric: c.rubric })
    const actual = { ...resultToDict(got), rule_snapshot: got.rule_snapshot, confirmed_fraction: confirmedFraction(got) }
    try { assert.deepEqual(JSON.parse(JSON.stringify(actual)), c.expected) }
    catch { failures.push(`#${i} ${c.question_type} raw=${JSON.stringify(c.raw_answer)} payload=${JSON.stringify(c.answer_payload)} rule=${JSON.stringify(c.rule)}`) }
    if (failures.length >= 8) break
  }
  assert.deepEqual(failures, [], `first mismatches:\n${failures.join('\n')}`)
})

test('invariant: a wrong answer is a confirmed zero; an undecidable one is pending, never 0', () => {
  const wrong = grade({ question_type: 'single_choice', raw_answer: { selected_option_id: 'b' }, answer_payload: { correct_option_id: 'a' }, max_score: Decimal.parse('2'), rule: {} })
  assert.equal(wrong.status, 'confirmed'); assert.equal(wrong.confirmed_score!.toString(), '0'); assert.equal(wrong.is_fully_confirmed, true)
  const undecidable = grade({ question_type: 'fill_blank', raw_answer: { blanks: { b1: 'zzz' } }, answer_payload: { blanks: { b1: { accepted_values: ['a'] } } }, max_score: Decimal.parse('2'), rule: {} })
  assert.equal(undecidable.status, 'pending_review'); assert.equal(undecidable.confirmed_score, null); assert.equal(undecidable.pending_max_score.toString(), '2')
})

test('invariant: a constructed response is never auto-scored', () => {
  const r = grade({ question_type: 'constructed_response', raw_answer: { text: 'anything' }, answer_payload: {}, max_score: Decimal.parse('5'), rule: {}, rubric: { criteria: [{ criterion_id: 'c1', max_score: '5' }] } })
  assert.equal(r.status, 'pending_review'); assert.equal(r.confirmed_score, null)
})

test('prototype-pollution shaped payloads cannot reach inherited properties', () => {
  const payload = JSON.parse('{"kind":"fill_blank","blanks":{"__proto__":{"accepted_values":["x"]},"constructor":{"accepted_values":["x"]},"b1":{"accepted_values":["x"]}}}')
  const r = grade({ question_type: 'fill_blank', raw_answer: JSON.parse('{"blanks":{"constructor":"x","b1":"x"}}'), answer_payload: payload, max_score: Decimal.parse('3'), rule: {} })
  assert.ok(r.parts.length >= 2)
  assert.equal(({} as Record<string, unknown>).accepted_values, undefined, 'Object.prototype was not polluted')
})
