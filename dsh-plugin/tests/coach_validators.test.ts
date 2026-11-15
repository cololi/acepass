import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCoachReply } from '../src/ai/coach_validators.ts'
import { COACH_PURPOSES } from '../src/ai/coach_prompts.ts'
import { parseModelJson } from '../src/ai/pyvalue.ts'

const common = { coach_message: '信息不足，需要原始作答。', citations: ['knowledge_node:n'], missing_information: ['缺少作答'] }
const checks = { ...common, key_points_covered: [], key_points_missing: [], cannot_judge: ['缺少作答'], next_question: '' }
const valid: Record<string, Record<string, unknown>> = {
  recall_check: checks, self_explain_check: checks,
  hint: { ...common, hint_level: 1, hint_blocks: [{ kind: 'text', text: '检查条件' }], reveals_answer: false, next_question: '' },
  misconception_probe: { ...common, error_type: 'unknown', evidence: [], cannot_judge: ['缺少作答'], next_question: '' },
  encode_briefing: { ...common, blocks: [{ kind: 'math', latex: 'a+b' }], key_points: [{ id: 'kp', text: '加法', required: true }] },
  session_reflection: { ...common, highlights: [], next_focus: ['补充作答'], step_ids: ['session_step:1'] },
}
const options = { allowed_citations: new Set(['knowledge_node:n']), allowed_key_point_ids: new Set(['kp']), allowed_step_ids: new Set(['session_step:1']), max_hint_level: 2 }
for (const purpose of COACH_PURPOSES) {
  test(`${purpose}: accepts clean output and honest missing information`, () => {
    const [clean, problems] = validateCoachReply(purpose, parseModelJson(JSON.stringify(valid[purpose])), options)
    assert.deepEqual(problems, [])
    assert.deepEqual(clean.missing_information, ['缺少作答'])
  })
  for (const [label, patch] of Object.entries({ citation: { citations: ['invented'] }, score: { score: 1 }, nestedMastery: { extra: { mastery: true } }, message: { coach_message: '' } })) test(`${purpose}: rejects ${label}`, () => {
    const [, problems] = validateCoachReply(purpose, { ...valid[purpose], ...patch }, options)
    assert.ok(problems.length)
    assert.ok(problems.every(p => p.severity === 'blocking'))
  })
}
for (const purpose of ['recall_check', 'self_explain_check']) for (const [label, patch] of Object.entries({ unknown: { key_points_covered: ['alien'] }, overlap: { key_points_covered: ['kp'], key_points_missing: ['kp'] } })) test(`${purpose}: rejects ${label} key points`, () => {
  assert.ok(validateCoachReply(purpose, { ...valid[purpose], ...patch }, options)[1].length)
})
for (const level of [-1, 1.5, 3, 4, '2']) test(`hint rejects invalid level ${JSON.stringify(level)}`, () => {
  assert.ok(validateCoachReply('hint', { ...valid.hint, hint_level: level }, options)[1].length)
})
test('hint rejects answer disclosure and malformed/empty blocks', () => {
  for (const patch of [{ reveals_answer: true }, { hint_blocks: [] }, { hint_blocks: [{ kind: 'image', src: 'x' }] }, { hint_blocks: [{ kind: 'list', items: [] }] }]) assert.ok(validateCoachReply('hint', { ...valid.hint, ...patch }, options)[1].length)
})
test('encode briefing requires unique nonempty allowed draft key points', () => {
  for (const points of [[], [{ id: 'alien', text: 'x', required: true }], [{ id: 'kp', text: 'x', required: true }, { id: 'kp', text: 'y', required: false }]]) assert.ok(validateCoachReply('encode_briefing', { ...valid.encode_briefing, key_points: points }, options)[1].length)
  assert.deepEqual(validateCoachReply('encode_briefing', valid.encode_briefing, options)[1], [])
})
test('reflection rejects unknown steps; unknown fields are not persisted', () => {
  assert.ok(validateCoachReply('session_reflection', { ...valid.session_reflection, step_ids: ['session_step:2'] }, options)[1].length)
  const [clean, problems] = validateCoachReply('recall_check', { ...checks, injected: 'discard' }, options)
  assert.deepEqual(problems, []); assert.equal(clean.injected, undefined)
})
test('objects, strings, arrays and nested forbidden fields have strict bounds', () => {
  for (const payload of [null, [], 'x', { ...checks, coach_message: 'a'.repeat(4001) }, { ...checks, citations: Array(41).fill('knowledge_node:n') }]) assert.ok(validateCoachReply('recall_check', payload, options)[1].length)
  for (const name of ['scores', 'mastered', 'probability', 'pass_rate', 'confirmed_score', 'grade', 'passed']) assert.ok(validateCoachReply('recall_check', { ...checks, [name]: null }, options)[1].length)
})

test('memory coach disposition rejects every validation problem without a candidate', async () => {
  const { validationDisposition } = await import('../src/ai/outcome.ts')
  const accepted = validationDisposition('memory_coach', {}, [])
  assert.equal(accepted.status, 'succeeded'); assert.deepEqual(accepted.writes, ['llm_run', 'coach_turn'])
  const rejected = validationDisposition('memory_coach', {}, [{ code: 'warning', message: 'invalid', severity: 'warning' }])
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.keepCandidate, false); assert.deepEqual(rejected.writes, ['llm_run'])
})
