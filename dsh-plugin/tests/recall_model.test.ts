import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import {
  COVERAGE_FAIL,
  COVERAGE_GOOD,
  SPACED_MIN_MINUTES,
  abilityGap,
  coverageFromPoints,
  evaluateRecall,
  isSpaced,
  recallOutcome,
  sessionScore,
  type KeyPoint,
} from '../src/domain/recall.ts'

const POINTS: KeyPoint[] = [
  { id: 'kp1', text: '定义', required: true },
  { id: 'kp2', text: '条件', required: true },
  { id: 'kp3', text: '例子', required: false },
  { id: 'kp4', text: '边界', required: true },
]

test('coverage: only required points count, and unjudged points leave the denominator', () => {
  const full = coverageFromPoints(POINTS, ['kp1', 'kp2', 'kp4', 'kp3'], [])
  assert.equal(full.coverage, 1)
  assert.deepEqual(full.missing, [])
  assert.equal(full.required_count, 3)

  const partial = coverageFromPoints(POINTS, ['kp1'], ['kp4'])
  assert.equal(partial.coverage, 0.5)
  assert.deepEqual(partial.missing, ['kp2'])
  assert.deepEqual(partial.cannot_judge, ['kp4'])
  assert.ok(Math.abs(partial.unjudged_ratio - 1 / 3) < 1e-12)

  const unknown = coverageFromPoints(POINTS, ['nope'], ['nope'])
  assert.equal(unknown.coverage, 0)
  assert.deepEqual(unknown.covered, [])

  const nothingJudged = coverageFromPoints(POINTS, [], ['kp1', 'kp2', 'kp4'])
  assert.equal(nothingJudged.coverage, null)
})

test('recall: an unobserved attempt needs a self rating instead of a guessed one', () => {
  assert.equal(evaluateRecall({ coverage: null, hintLevel: 0, latencyRatio: null }), null)
  const self = evaluateRecall({ coverage: null, hintLevel: 0, latencyRatio: null, selfRating: 'good' })
  assert.ok(self)
  assert.equal(self.rating, 'good')
  assert.equal(self.source, 'self_report')
})

test('recall: thresholds follow the documented bands', () => {
  const rate = (coverage: number, hintLevel = 0, latencyRatio: number | null = null) =>
    evaluateRecall({ coverage, hintLevel, latencyRatio })!.rating
  assert.equal(rate(COVERAGE_FAIL - 0.01), 'again')
  assert.equal(rate(COVERAGE_FAIL), 'hard')
  assert.equal(rate(COVERAGE_GOOD - 0.01), 'hard')
  assert.equal(rate(COVERAGE_GOOD), 'good')
  assert.equal(rate(1, 0, 0.5), 'easy')
  assert.equal(rate(1, 0, 0.9), 'good')
  assert.equal(rate(1, 0, null), 'easy')
  assert.equal(rate(0.9, 1), 'hard')
  assert.equal(rate(0.9, 2), 'hard')
})

test('recall: an early review can never look like a spaced success', () => {
  const early = evaluateRecall({ coverage: 1, hintLevel: 0, latencyRatio: 0.4, earlyReview: true })
  assert.ok(early)
  assert.equal(early.rating, 'hard')
  assert.ok(early.notes.includes('early_review_capped_at_hard'))
  const failure = evaluateRecall({ coverage: 0.2, hintLevel: 0, latencyRatio: null, earlyReview: true })
  assert.equal(failure!.rating, 'again')
})

test('spacing: the same 10-minute window is not spaced practice', () => {
  const now = parseInstant('2027-02-01T10:00:00+00:00')
  assert.equal(isSpaced(null, now), true)
  const justInside = parseInstant('2027-02-01T09:50:01+00:00')
  const exactly = parseInstant(`2027-02-01T09:${String(60 - SPACED_MIN_MINUTES).padStart(2, '0')}:00+00:00`)
  // 9m59s has not reached the window yet; exactly 10m has.
  assert.equal(isSpaced(justInside, now), false)
  assert.equal(isSpaced(exactly, now), true)
  const tooSoon = parseInstant('2027-02-01T09:59:00+00:00')
  assert.equal(isSpaced(tooSoon, now), false)
})

test('selection: ability gap and the explainable session score', () => {
  assert.equal(abilityGap('undiagnosed'), 1)
  assert.equal(abilityGap('delayed_verified'), 0)
  assert.equal(abilityGap('needs_foundation'), 0.8)
  assert.equal(abilityGap('something_new'), 1)

  const strong = sessionScore({
    valueIndex: 0.8, forgettingRisk: 0.5, abilityGap: 1, prerequisiteUrgency: 0, novelty: false, consecutiveSameNode: false,
  })
  const weak = sessionScore({
    valueIndex: 0.2, forgettingRisk: 0, abilityGap: 0, prerequisiteUrgency: 0, novelty: false, consecutiveSameNode: false,
  })
  assert.ok(strong.score > weak.score)
  assert.ok(strong.reason_codes.includes('high_exam_value'))
  assert.ok(strong.reason_codes.some((code) => code.startsWith('forgetting_risk_')))
  assert.ok(strong.reason_codes.includes('ability_gap'))

  const neutral = sessionScore({
    valueIndex: null, forgettingRisk: 0, abilityGap: 0, prerequisiteUrgency: 0, novelty: false, consecutiveSameNode: false,
  })
  assert.ok(neutral.reason_codes.includes('frequency_unknown'))

  const repeated = sessionScore({
    valueIndex: 0.5, forgettingRisk: 0, abilityGap: 0, prerequisiteUrgency: 0, novelty: false, consecutiveSameNode: true,
  })
  const fresh = sessionScore({
    valueIndex: 0.5, forgettingRisk: 0, abilityGap: 0, prerequisiteUrgency: 0, novelty: false, consecutiveSameNode: false,
  })
  assert.equal(Math.round((fresh.score - repeated.score) * 1000) / 1000, 20)
  assert.ok(repeated.reason_codes.includes('interleave_penalty'))
})

test('recall: the outcome label never claims mastery', () => {
  assert.equal(recallOutcome('again'), 'not_recalled')
  assert.equal(recallOutcome('hard'), 'partial')
  assert.equal(recallOutcome('good'), 'recalled')
  assert.equal(recallOutcome('easy'), 'recalled')
})
