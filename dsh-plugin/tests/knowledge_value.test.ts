import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HORIZON,
  STATUS_INSUFFICIENT,
  STATUS_NO_DATA,
  STATUS_OK,
  computeFrequency,
  desiredRetentionForValue,
  recencyIndex,
  shareTrend,
  type CycleObservation,
} from '../src/domain/knowledge_value.ts'

function obs(overrides: Partial<CycleObservation> & { age: number }): CycleObservation {
  return {
    cycle_key: `c${overrides.age}`,
    present: false,
    appearances: 0,
    marks: '0',
    denominator: '100',
    question_types: {},
    ...overrides,
  }
}

test('frequency: no countable cycle never ranks and says why', () => {
  const result = computeFrequency([])
  assert.equal(result.status, STATUS_NO_DATA)
  assert.equal(result.counted_cycles, 0)
  assert.equal(result.value_index, null)
  assert.equal(result.share_avg, null)
  assert.match(result.notes[0], /没有任何可计数的完整周期/)
})

test('frequency: one cycle is raw counts only, no ranking value', () => {
  const result = computeFrequency([obs({ age: 0, present: true, appearances: 2, marks: '12', denominator: '100' })])
  assert.equal(result.status, STATUS_INSUFFICIENT)
  assert.equal(result.appearances, 2)
  assert.equal(result.cycles_present, 1)
  assert.equal(result.share_avg, '0.1200')
  assert.equal(result.value_index, null)
  assert.ok(result.notes.some((line) => line.includes('不足 2 个')))
})

test('frequency: two complete cycles produce the documented value index', () => {
  const result = computeFrequency([
    obs({ age: 0, present: true, appearances: 3, marks: '10', denominator: '100', question_types: { single_choice: 1 } }),
    obs({ age: 1, present: false, appearances: 0, marks: '0', denominator: '100' }),
  ])
  assert.equal(result.status, STATUS_OK)
  assert.equal(result.counted_cycles, 2)
  assert.equal(result.appearances, 3)
  assert.equal(result.cycles_present, 1)
  // The absent cycle still has a denominator, so the mean share is (0.10 + 0) / 2 = 0.05.
  assert.equal(result.share_avg, '0.0500')
  assert.equal(result.share_max, '0.1000')
  assert.equal(result.last_seen_cycle, 'c0')
  // coverage 0.5, share 0.05/0.15 = 0.3333, recency = 1/(1+0.7071) = 0.5858
  assert.equal(result.value_index, '0.4505')
  assert.deepEqual(result.question_types, { single_choice: 1 })
})

test('frequency: recency weight halves every two cycles', () => {
  const rows = [
    obs({ age: 0, present: false }),
    obs({ age: 1, present: false }),
    obs({ age: 2, present: true }),
  ]
  // weight of age 2 is 0.5; total weight 1 + 0.7071 + 0.5 = 2.2071 -> 0.2265
  assert.equal(recencyIndex(rows), '0.2265')
})

test('frequency: trend needs three data cycles and reports the slope', () => {
  assert.equal(shareTrend([obs({ age: 0, marks: '10' }), obs({ age: 1, marks: '5' })]), null)
  // shares 0.05 (old) -> 0.10 -> 0.15 (new): x = -2,-1,0; slope = 0.05
  const trend = shareTrend([
    obs({ age: 0, marks: '15' }),
    obs({ age: 1, marks: '10' }),
    obs({ age: 2, marks: '5' }),
  ])
  assert.equal(trend, '0.0500')
})

test('frequency: horizon note is stated without pretending five years exist', () => {
  const result = computeFrequency([obs({ age: 0 }), obs({ age: 1 })], { horizon: DEFAULT_HORIZON })
  assert.ok(result.notes.some((line) => line.includes('近 5 个完整周期')))
  assert.ok(result.notes.some((line) => line.includes('不是出题概率')))
})

test('frequency: a node that never appeared still gets countable raw numbers', () => {
  const result = computeFrequency([
    obs({ age: 0, present: false }),
    obs({ age: 1, present: false }),
  ])
  assert.equal(result.status, STATUS_OK)
  assert.equal(result.appearances, 0)
  assert.equal(result.cycles_present, 0)
  assert.equal(result.share_avg, '0.0000')
  assert.equal(result.recency_index, '0.0000')
  assert.equal(result.last_seen_cycle, null)
})

test('retention: frequency value maps into the documented 0.85-0.95 band', () => {
  assert.equal(desiredRetentionForValue(null), 0.85)
  assert.equal(desiredRetentionForValue(0), 0.85)
  assert.equal(desiredRetentionForValue(1), 0.95)
  assert.equal(desiredRetentionForValue(0.5), 0.9)
  assert.equal(desiredRetentionForValue(2), 0.95)
})
