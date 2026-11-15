/**
 * Retrieval-attempt arithmetic (docs/26 §5.2, §6.3). Pure and deterministic.
 *
 * Two rules are deliberately encoded here rather than left to a service:
 *
 *  1. a rating is derived from an *observed* coverage (a confirmed key-point
 *     baseline) or from the learner's own report — never from a model's opinion
 *     alone. `source` records which of the three it was;
 *  2. a repeated recall inside the same short window is not spaced practice: it
 *     is recorded for audit but must not move the scheduler (`isSpaced`).
 */
import type { Instant } from './instant.ts'

export type RecallRating = 'again' | 'hard' | 'good' | 'easy'
export type RecallSource = 'self_report' | 'deterministic' | 'model_assisted_confirmed'

/** Same-window repeats do not count as spaced retrieval (docs/26 §5.2). */
export const SPACED_MIN_MINUTES = 10
/** Below this share of required points the attempt is a failure. */
export const COVERAGE_FAIL = 0.5
/** At or above this share the attempt is "known well enough for now". */
export const COVERAGE_GOOD = 0.8
/** `easy` requires a fast, complete recall. */
export const EASY_LATENCY_RATIO = 0.6
/** `Instant` is microseconds; a minute is 60_000_000 of them. */
const MINUTE_US = 60_000_000n

export interface KeyPoint {
  id: string
  text: string
  required: boolean
}

export interface CoverageResult {
  covered: string[]
  missing: string[]
  cannot_judge: string[]
  /** Fraction of judged required points covered; null when nothing could be judged. */
  coverage: number | null
  required_count: number
  unjudged_ratio: number
}

/**
 * Coverage of the *required* key points, given the sets a check produced.
 *
 * A point the check explicitly could not judge is removed from the denominator
 * (the system must not score itself as right or wrong on evidence it does not
 * have), but its share is reported so a caller can require human confirmation.
 * Unknown ids in either input are ignored — they cannot come from a confirmed
 * card, and inventing a point would fabricate the baseline.
 */
export function coverageFromPoints(
  points: readonly KeyPoint[],
  covered: readonly string[],
  cannotJudge: readonly string[],
): CoverageResult {
  const required = points.filter((point) => point.required)
  const requiredIds = new Set(required.map((point) => point.id))
  const coveredSet = new Set(covered.filter((id) => requiredIds.has(id)))
  const cannotSet = new Set(cannotJudge.filter((id) => requiredIds.has(id) && !coveredSet.has(id)))
  const missing = required.filter((point) => !coveredSet.has(point.id) && !cannotSet.has(point.id)).map((p) => p.id)
  const judged = required.length - cannotSet.size
  const coverage = judged <= 0 ? null : coveredSet.size / judged
  return {
    covered: [...coveredSet],
    missing,
    cannot_judge: [...cannotSet],
    coverage,
    required_count: required.length,
    unjudged_ratio: required.length === 0 ? 0 : cannotSet.size / required.length,
  }
}

export interface RecallEvaluationInput {
  coverage: number | null
  hintLevel: number
  latencyRatio: number | null
  /** Required when coverage is null (no confirmed baseline / no model check). */
  selfRating?: RecallRating | null
  earlyReview?: boolean
}

export interface RecallEvaluation {
  rating: RecallRating
  source: RecallSource
  notes: string[]
}

/** `null` means "the caller must ask the learner to rate it": no silent guess. */
function ratingFromCoverage(input: RecallEvaluationInput): RecallRating | null {
  const coverage = input.coverage
  if (coverage === null) return null
  if (coverage < COVERAGE_FAIL) return 'again'
  const hint = Math.max(0, Math.trunc(input.hintLevel))
  if (coverage < COVERAGE_GOOD || hint >= 1) return 'hard'
  if (coverage >= 1) {
    const fast = input.latencyRatio === null || input.latencyRatio <= EASY_LATENCY_RATIO
    return fast ? 'easy' : 'good'
  }
  return 'good'
}

/**
 * Derive one FSRS rating from one attempt. Returns `rating: null` only when the
 * attempt has no observed coverage and the learner gave no self rating — the
 * service then refuses the write instead of inventing a grade.
 */
export function evaluateRecall(input: RecallEvaluationInput): RecallEvaluation | null {
  const notes: string[] = []
  let rating: RecallRating | null
  let source: RecallSource
  if (input.coverage === null) {
    rating = input.selfRating ?? null
    source = 'self_report'
    notes.push('no_confirmed_baseline_self_report')
  } else {
    rating = ratingFromCoverage(input)
    source = 'deterministic'
    if (Math.max(0, Math.trunc(input.hintLevel)) >= 1) notes.push(`hint_level=${Math.max(0, Math.trunc(input.hintLevel))}`)
    if (input.coverage < COVERAGE_FAIL) notes.push('coverage_below_half')
    else if (input.coverage < COVERAGE_GOOD) notes.push('coverage_partial')
  }
  if (rating === null) return null
  if (input.earlyReview === true && (rating === 'easy' || rating === 'good')) {
    // Reviewing before the interval is due must not masquerade as spaced success.
    rating = 'hard'
    notes.push('early_review_capped_at_hard')
  }
  return { rating, source, notes }
}

/** Spaced practice: at least `SPACED_MIN_MINUTES` since the previous recall. */
export function isSpaced(lastRecallAt: Instant | null, now: Instant, minMinutes = SPACED_MIN_MINUTES): boolean {
  if (lastRecallAt === null) return true
  return now - lastRecallAt >= BigInt(Math.trunc(minMinutes)) * MINUTE_US
}

/* --------------------------------------------------------------- selection */

/** Ability gap used by the session score (docs/26 §6.3): 1 = nothing demonstrated. */
export const ABILITY_GAP_BY_SUMMARY: Readonly<Record<string, number>> = {
  undiagnosed: 1.0,
  needs_foundation: 0.8,
  needs_review: 0.8,
  completes_with_hints: 0.5,
  independent: 0.25,
  handles_unseen: 0.1,
  delayed_verified: 0.0,
}

export function abilityGap(summary: string | null | undefined): number {
  if (summary === null || summary === undefined) return 1.0
  const value = ABILITY_GAP_BY_SUMMARY[String(summary)]
  return value === undefined ? 1.0 : value
}

export interface SessionScoreInput {
  /** `null` = frequency not rankable yet; a neutral 0.5 is used and said so. */
  valueIndex: number | null
  forgettingRisk: number
  abilityGap: number
  prerequisiteUrgency: number
  novelty: boolean
  consecutiveSameNode: boolean
}

export interface SessionScore {
  score: number
  reason_codes: string[]
}

/**
 * The explainable candidate score (docs/26 §6.3). Constants are product
 * parameters of the `m1` rule version, not calibrated effect sizes.
 *
 *   score = 100·V·(1 + 0.8·risk + 0.5·gap) + 30·prereq + 15·novelty − 20·repeat
 */
export function sessionScore(input: SessionScoreInput): SessionScore {
  const value = input.valueIndex === null ? 0.5 : Math.max(0, Math.min(1, input.valueIndex))
  const risk = Math.max(0, Math.min(1, input.forgettingRisk))
  const gap = Math.max(0, Math.min(1, input.abilityGap))
  const prereq = Math.max(0, Math.min(1, input.prerequisiteUrgency))
  const reason: string[] = []
  if (input.valueIndex === null) reason.push('frequency_unknown')
  else if (value >= 0.6) reason.push('high_exam_value')
  if (risk >= 0.3) reason.push(`forgetting_risk_${risk.toFixed(2)}`)
  if (gap >= 0.8) reason.push('ability_gap')
  if (prereq > 0) reason.push('prereq_urgency')
  if (input.novelty) reason.push('novelty')
  if (input.consecutiveSameNode) reason.push('interleave_penalty')
  const score =
    100 * value * (1 + 0.8 * risk + 0.5 * gap) +
    30 * prereq +
    (input.novelty ? 15 : 0) -
    (input.consecutiveSameNode ? 20 : 0)
  return { score: Math.round(score * 1000) / 1000, reason_codes: reason }
}

/** The step outcome a recall rating implies; a rating is not a mastery claim. */
export function recallOutcome(rating: RecallRating): 'recalled' | 'partial' | 'not_recalled' {
  if (rating === 'again') return 'not_recalled'
  if (rating === 'hard') return 'partial'
  return 'recalled'
}
