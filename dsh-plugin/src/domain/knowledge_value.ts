/**
 * Exam-frequency arithmetic (docs/26 §4). Pure and deterministic.
 *
 * The product question is "how often was this knowledge point really examined, and
 * how much score did it carry?" — never "will it be examined next year". Every
 * number here is a description of counted papers, and the module refuses to rank
 * a node when the sample is too small to mean anything:
 *
 *   no_real_data        — no countable cycle at all;
 *   insufficient_cycles — the raw counts are shown but `value_index` is null;
 *   ok                  — at least two complete cycles back the value.
 *
 * The value index is a **sorting score**, not a probability:
 *
 *   coverage    = cycles_present / counted_cycles
 *   share_avg   = mean mark share over cycles with a denominator
 *   recency     = Σ w_c·seen_c / Σ w_c,  w_c = 0.5 ** (age_c / 2)
 *   value_index = 0.40·coverage + 0.40·min(1, share_avg / 0.15) + 0.20·recency
 *
 * All decimal arithmetic goes through `Decimal` so the reported strings are
 * reproducible on every platform (the same reason `cycles.ts` does it).
 */
import { Decimal } from './decimal.ts'

export const FREQUENCY_RULE_VERSION = 'm1-frequency'
/** Five complete cycles is the documented horizon; "近五年" is never five rows. */
export const DEFAULT_HORIZON = 5
/** Presence nearer than this half-life counts fully; two cycles back counts half. */
export const RECENCY_HALF_LIFE_CYCLES = 2
/** Mark share at which the share component of the value index is saturated. */
export const SHARE_REFERENCE = 0.15
/** Component weights; they sum to 1 and are part of the rule version. */
export const VALUE_WEIGHTS = { coverage: 0.4, share: 0.4, recency: 0.2 } as const
export const STATUS_OK = 'ok' as const
export const STATUS_INSUFFICIENT = 'insufficient_cycles' as const
export const STATUS_NO_DATA = 'no_real_data' as const

export type FrequencyStatus = typeof STATUS_OK | typeof STATUS_INSUFFICIENT | typeof STATUS_NO_DATA

export interface CycleObservation {
  cycle_key: string
  /** Stable chronological position, 0 = most recent used cycle. */
  age: number
  present: boolean
  appearances: number
  /** Marks attributed to the node in this cycle (Decimal string or number). */
  marks: Decimal | string | number
  /** Denominator actually used for this cycle's share; null when zero. */
  denominator: Decimal | string | number | null
  question_types: Record<string, number>
}

export interface FrequencyComputation {
  status: FrequencyStatus
  counted_cycles: number
  appearances: number
  cycles_present: number
  share_avg: string | null
  share_max: string | null
  marks_avg: string | null
  recency_index: string | null
  trend: string | null
  value_index: string | null
  question_types: Record<string, number>
  last_seen_cycle: string | null
  notes: string[]
}

function dec(value: Decimal | string | number): Decimal {
  if (value instanceof Decimal) return value
  return Decimal.parse(String(value))
}

function format(value: Decimal, places: number): string {
  return value.quantize(places).toString()
}

/** Mean of non-null fractions; null when nothing is left. */
function mean(values: Decimal[]): Decimal | null {
  if (values.length === 0) return null
  let total = Decimal.zero()
  for (const value of values) total = total.add(value)
  return total.div(Decimal.fromInt(values.length))
}

/**
 * Least-squares slope of share over cycle age (oldest → newest), or null when
 * there are fewer than three cycles with a real share. Fewer points cannot
 * separate a trend from noise, so no number is reported instead of a guess.
 */
export function shareTrend(observations: readonly CycleObservation[]): string | null {
  const points: Array<{ x: number; y: Decimal }> = []
  for (const observation of observations) {
    if (observation.denominator === null) continue
    const denominator = dec(observation.denominator)
    if (!denominator.gt(Decimal.zero())) continue
    points.push({ x: -observation.age, y: dec(observation.marks).div(denominator) })
  }
  if (points.length < 3) return null
  points.sort((left, right) => left.x - right.x)
  let sumX = 0
  let sumY = Decimal.zero()
  let sumXY = Decimal.zero()
  let sumXX = 0
  for (const point of points) {
    sumX += point.x
    sumY = sumY.add(point.y)
    sumXY = sumXY.add(point.y.mul(Decimal.fromInt(point.x)))
    sumXX += point.x * point.x
  }
  const n = points.length
  const denominator = n * sumXX - sumX * sumX
  if (denominator === 0) return null
  const slope = sumXY.mul(Decimal.fromInt(n)).sub(sumY.mul(Decimal.fromInt(sumX))).div(Decimal.fromInt(denominator))
  return format(slope, -4)
}

/** Recency-weighted presence in [0,1]; null when nothing was ever seen. */
export function recencyIndex(observations: readonly CycleObservation[]): string | null {
  let weightSum = 0
  let seenWeight = 0
  for (const observation of observations) {
    const weight = 0.5 ** (observation.age / RECENCY_HALF_LIFE_CYCLES)
    weightSum += weight
    if (observation.present) seenWeight += weight
  }
  if (weightSum === 0) return null
  return format(Decimal.parse(String(seenWeight / weightSum)), -4)
}

/** Saturation curve of the mark share; exposed so a report can explain the number. */
export function shareComponent(share: string | null): string | null {
  if (share === null) return null
  const value = dec(share).div(Decimal.parse(String(SHARE_REFERENCE)))
  return format(value.gt(Decimal.fromInt(1)) ? Decimal.fromInt(1) : value, -4)
}

/**
 * Compute the frequency profile of one node over the used cycles (newest first).
 *
 * `observations` must already describe the *used* complete cycles; the caller
 * decides countability (docs/26 §4.1) and passes the rest as excluded papers.
 */
export function computeFrequency(
  observations: readonly CycleObservation[],
  options: { horizon?: number } = {},
): FrequencyComputation {
  const horizon = options.horizon ?? DEFAULT_HORIZON
  const counted = observations.length
  const notes: string[] = []
  if (counted === 0) {
    return {
      status: STATUS_NO_DATA,
      counted_cycles: 0,
      appearances: 0,
      cycles_present: 0,
      share_avg: null,
      share_max: null,
      marks_avg: null,
      recency_index: null,
      trend: null,
      value_index: null,
      question_types: {},
      last_seen_cycle: null,
      notes: [`没有任何可计数的完整周期（需要真实试卷且覆盖完整），因此不给出考频排序。`],
    }
  }

  let appearances = 0
  let cyclesPresent = 0
  const shares: Decimal[] = []
  const marks: Decimal[] = []
  const questionTypes: Record<string, number> = {}
  let lastSeen: string | null = null
  for (const observation of observations) {
    appearances += Math.max(0, Math.trunc(observation.appearances))
    if (observation.present) {
      cyclesPresent += 1
      // observations arrive newest first: the first present one is the recent one.
      if (lastSeen === null) lastSeen = observation.cycle_key
      for (const [type, count] of Object.entries(observation.question_types)) {
        questionTypes[type] = (questionTypes[type] ?? 0) + Math.max(0, Math.trunc(count))
      }
    }
    const nodeMarks = dec(observation.marks)
    marks.push(nodeMarks)
    if (observation.denominator !== null) {
      const denominator = dec(observation.denominator)
      if (denominator.gt(Decimal.zero())) shares.push(nodeMarks.div(denominator))
    }
  }

  const shareAvgValue = mean(shares)
  let shareMaxValue: Decimal | null = null
  for (const share of shares) {
    if (shareMaxValue === null || share.gt(shareMaxValue)) shareMaxValue = share
  }
  const marksAvgValue = mean(marks)
  const recency = recencyIndex(observations)
  const trend = shareTrend(observations)

  const enough = counted >= 2
  let valueIndex: string | null = null
  if (enough) {
    const coverage = Decimal.parse(String(cyclesPresent / counted))
    const share = shareAvgValue === null ? Decimal.zero() : shareAvgValue
    const saturated = share.div(Decimal.parse(String(SHARE_REFERENCE)))
    const sharePart = saturated.gt(Decimal.fromInt(1)) ? Decimal.fromInt(1) : saturated
    const recencyPart = Decimal.parse(recency ?? '0')
    valueIndex = format(
      coverage.mul(Decimal.parse(String(VALUE_WEIGHTS.coverage)))
        .add(sharePart.mul(Decimal.parse(String(VALUE_WEIGHTS.share))))
        .add(recencyPart.mul(Decimal.parse(String(VALUE_WEIGHTS.recency)))),
      -4,
    )
  }

  if (!enough) {
    notes.push(`只有 ${counted} 个完整周期，不足 2 个：给出原始出现次数与分值份额，但不给出考频排序值。`)
  }
  if (counted < 3) {
    notes.push(`少于 3 个有数据的周期：不给出趋势结论。`)
  }
  if (counted < horizon) {
    notes.push(`统计口径为近 ${horizon} 个完整周期，目前只有 ${counted} 个：不使用“近五年”这类表述。`)
  }
  notes.push(`只统计真实考试发生记录（official_past 且非演示数据）中覆盖完整的周期；演示、模拟与练习集不计入。`)
  notes.push(`value_index 是排序分值，不是出题概率，也不是预计得分。`)

  return {
    status: enough ? STATUS_OK : STATUS_INSUFFICIENT,
    counted_cycles: counted,
    appearances,
    cycles_present: cyclesPresent,
    share_avg: shareAvgValue === null ? null : format(shareAvgValue, -4),
    share_max: shareMaxValue === null ? null : format(shareMaxValue, -4),
    marks_avg: marksAvgValue === null ? null : format(marksAvgValue, -3),
    recency_index: recency,
    trend,
    value_index: valueIndex,
    question_types: questionTypes,
    last_seen_cycle: lastSeen,
    notes,
  }
}

/**
 * Target retention derived from the exam value (docs/26 §4.3).
 *
 * A high-value node is reviewed at a higher probability-of-recall target; the
 * number is fixed when the memory state is created so replaying the ledger stays
 * reproducible. `null` value (insufficient sample) uses the low end.
 */
export function desiredRetentionForValue(valueIndex: string | number | null): number {
  const value = valueIndex === null ? 0 : Number(valueIndex)
  const raw = 0.85 + 0.1 * Math.max(0, Math.min(1, value))
  return Math.round(raw * 10_000) / 10_000
}
