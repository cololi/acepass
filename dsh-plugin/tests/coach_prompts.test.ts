import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as coach from '../src/ai/coach_prompts.ts'

const builders = [coach.buildRecallCheckPrompt, coach.buildSelfExplainCheckPrompt, coach.buildHintPrompt, coach.buildMisconceptionProbePrompt, coach.buildEncodeBriefingPrompt, coach.buildSessionReflectionPrompt]
for (const [i, builder] of builders.entries()) test(`coach prompt: ${coach.COACH_PURPOSES[i]} is deterministic and declares its schema`, () => {
  const input = { node_name: '乘法', key_points: [{ id: 'kp1', text: '相同加数' }], learner_text: '我的解释', allowed_citations: ['knowledge_node:n1', 'node_card:c1:1'] }
  const prompt = builder(input)
  assert.equal(prompt, builder(input))
  for (const key of Object.keys(coach.COACH_SCHEMAS[coach.COACH_PURPOSES[i]])) assert.ok(prompt.includes(`"${key}"`))
  for (const id of input.allowed_citations) assert.ok(prompt.includes(id))
  assert.doesNotMatch(prompt, /"(?:score|mastery|probability|grade)"/)
  assert.match(prompt, /不得输出分数/)
})
test('coach prompt bounds strings and lists without breaking the input JSON', () => {
  const prompt = coach.buildHintPrompt({ node_name: '😀'.repeat(9000), allowed_citations: Array.from({ length: 100 }, (_, i) => `node:${i}`), learner_text: 'x'.repeat(20000) })
  const input = JSON.parse(prompt.split('输入材料：\n')[1])
  assert.equal(Array.from(input.node_name).length, 4000)
  assert.equal(input.allowed_citations.length, 40)
  assert.equal(input.learner_text.length, 4000)
  assert.ok(prompt.length < 15000)
})
test('rendered transcript contains only supplied validated content', () => {
  assert.equal(coach.renderCoachText('hint', { coach_message: '看看条件', hint_blocks: [{ kind: 'text', text: '先列式' }, { kind: 'math', latex: 'a+b' }, { kind: 'list', items: ['检查单位'] }], next_question: '为什么？' }), '看看条件\n先列式\na+b\n检查单位\n为什么？')
})
