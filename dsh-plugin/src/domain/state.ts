/**
 * Knowledge state projection — port of `backend/apps/learning/services/state.py`.
 *
 * The summary is a rule function over qualified evidence, never an LLM output. Missing data is
 * reported as missing rather than as a precise-looking percentage, which is why the projection
 * carries `missing_evidence` alongside the summary.
 *
 * Kept pure: the caller supplies the evidence rows and the previously stored state; this module
 * decides the new one. Note the two behaviours that look like bugs and are deliberate ports (D28):
 * the "recent window" is over *all* `independent_correct` rows regardless of `qualifies`, and a row
 * whose `isCorrect` is null counts as a recent failure.
 */
import { type Instant, formatPythonIso } from './instant.ts'

/** Bumped when the summary rule changes; stored on every projected state row. */
export const RULE_VERSION = 'p0-1'

/** Strict verification thresholds (configurable product assumptions). */
export const REQUIRED_DISTINCT_QUESTIONS = 3
export const REQUIRED_DISTINCT_TEMPLATES = 2
export const REQUIRED_DELAYED_CORRECT = 1
export const RECENT_WINDOW = 3
export const RECENT_FAILURES_FOR_REVIEW = 2

export const SUMMARY = {
  UNDIAGNOSED: 'undiagnosed',
  NEEDS_FOUNDATION: 'needs_foundation',
  COMPLETES_WITH_HINTS: 'completes_with_hints',
  INDEPENDENT: 'independent',
  HANDLES_UNSEEN: 'handles_unseen',
  DELAYED_VERIFIED: 'delayed_verified',
  NEEDS_REVIEW: 'needs_review',
} as const

export type Summary = (typeof SUMMARY)[keyof typeof SUMMARY]

/** The progression order; `needs_review` is a flag on top of it and is deliberately absent. */
export const SUMMARY_ORDER: readonly Summary[] = [
  SUMMARY.UNDIAGNOSED,
  SUMMARY.NEEDS_FOUNDATION,
  SUMMARY.COMPLETES_WITH_HINTS,
  SUMMARY.INDEPENDENT,
  SUMMARY.HANDLES_UNSEEN,
  SUMMARY.DELAYED_VERIFIED,
]

const DIMENSION_INDEPENDENT_CORRECT = 'independent_correct'
const DIMENSION_DELAYED_VERIFICATION = 'delayed_verification'
const DIMENSION_UNASSISTED_COMPLETION = 'unassisted_completion'
const DIMENSION_REPEAT_PRACTICE = 'repeat_practice'

export interface SummaryCounts {
  independentCorrect: number
  distinctQuestions: number
  distinctTemplates: number
  hasDelayedCorrect: boolean
  assistedOnly: boolean
  confirmedGap: boolean
  needsReview: boolean
}

/**
 * The summary ladder. `needs_review` only wins when there is at least one independent correct — a
 * node that has never been solved independently stays at the bottom of the ladder rather than
 * being labelled as needing review.
 */
export function summaryFromCounts(counts: SummaryCounts): Summary {
  if (counts.needsReview && counts.independentCorrect > 0) return SUMMARY.NEEDS_REVIEW
  if (
    counts.independentCorrect >= REQUIRED_DISTINCT_QUESTIONS &&
    counts.distinctTemplates >= REQUIRED_DISTINCT_TEMPLATES &&
    counts.hasDelayedCorrect
  ) {
    return SUMMARY.DELAYED_VERIFIED
  }
  if (counts.independentCorrect >= 2 && counts.distinctTemplates >= 2) return SUMMARY.HANDLES_UNSEEN
  if (counts.independentCorrect >= 1) return SUMMARY.INDEPENDENT
  if (counts.assistedOnly) return SUMMARY.COMPLETES_WITH_HINTS
  if (counts.confirmedGap) return SUMMARY.NEEDS_FOUNDATION
  return SUMMARY.UNDIAGNOSED
}

/** What is still missing before a higher summary is reachable, in plain language. */
export function missingEvidence(counts: {
  independentCorrect: number
  distinctTemplates: number
  hasDelayedCorrect: boolean
}): string[] {
  const missing: string[] = []
  if (counts.independentCorrect < REQUIRED_DISTINCT_QUESTIONS) {
    missing.push(`还需要 ${REQUIRED_DISTINCT_QUESTIONS - counts.independentCorrect} 道不同题的严格独立正确`)
  }
  if (counts.distinctTemplates < REQUIRED_DISTINCT_TEMPLATES) {
    missing.push(`还需要覆盖 ${REQUIRED_DISTINCT_TEMPLATES - counts.distinctTemplates} 种已确认模板`)
  }
  if (!counts.hasDelayedCorrect) {
    missing.push('还缺一次在相关讲解/训练至少 24 小时后的独立正确')
  }
  return missing
}

/** One active evidence row, as the projection reads it. */
export interface StateEvidenceRow {
  id: string
  attemptId: string
  dimension: string
  qualifies: boolean
  /** `null` is possible: a row can predate a decision without being wrong. */
  isCorrect: boolean | null
  gradeEventId: string | null
  /** `detail.get('template_id')`; only its truthiness and its `str()` are used. */
  templateId: unknown
  questionId: string
  computedAt: Instant
  exclusionReasons: string[]
}

export interface NodeStateProjection {
  summary: Summary
  best_summary: Summary
  independent_correct_count: number
  distinct_question_count: number
  distinct_template_count: number
  has_delayed_correct: boolean
  recent_independent_attempts: number
  recent_independent_failures: number
  needs_review: boolean
  downgrade_reason: string
  rule_version: string
  source_evidence_ids: string[]
  detail: {
    thresholds: {
      distinct_questions: number
      distinct_templates: number
      delayed_correct: number
      recent_window: number
    }
    independent_attempts: {
      evidence_id: string
      attempt_id: string
      is_correct: boolean | null
      computed_at: string
      exclusions: string[]
    }[]
    missing_evidence: string[]
  }
  as_of: Instant
}

/** `str()` of a scalar as Python writes it, for the values that can appear in `template_id`. */
function pyStrValue(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return String(value)
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'bigint') return value !== 0n
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

/**
 * Project one knowledge node's state from its evidence rows.
 *
 * `previous.summary` / `previous.bestSummary` are the stored values: `best_summary` never moves
 * backwards, so a node that once reached `delayed_verified` keeps that as its high-water mark even
 * after a review downgrade.
 */
export function projectNodeState(input: {
  rows: StateEvidenceRow[]
  previous: { summary: Summary; bestSummary: Summary }
  now: Instant
}): NodeStateProjection {
  const rows = input.rows
  const independent = rows.filter((row) => row.dimension === DIMENSION_INDEPENDENT_CORRECT && row.qualifies)
  const distinctQuestions = new Set(independent.map((row) => pyStrValue(row.questionId)))
  const templates = new Set<string>()
  for (const row of independent) {
    if (pyTruthy(row.templateId)) templates.add(pyStrValue(row.templateId))
  }
  const delayed = rows.filter((row) => row.dimension === DIMENSION_DELAYED_VERIFICATION && row.qualifies)

  const assistedOnly =
    rows.some(
      (row) =>
        row.dimension === DIMENSION_UNASSISTED_COMPLETION && !row.qualifies && row.isCorrect === true,
    ) && independent.length === 0

  const confirmedGap = rows.some(
    (row) =>
      row.isCorrect === false &&
      (row.dimension === DIMENSION_UNASSISTED_COMPLETION || row.dimension === DIMENSION_REPEAT_PRACTICE) &&
      row.gradeEventId !== null,
  )

  // Sorted newest first; Python's `sorted(..., reverse=True)` is stable, so equal instants keep
  // their stored order. Node's Array#sort is stable too, and a strict comparator preserves that.
  const recent = rows
    .filter((row) => row.dimension === DIMENSION_INDEPENDENT_CORRECT)
    .sort((a, b) => (a.computedAt > b.computedAt ? -1 : a.computedAt < b.computedAt ? 1 : 0))
    .slice(0, RECENT_WINDOW)
  const recentFailures = recent.filter((row) => !row.isCorrect).length
  const needsReview = recent.length >= 2 && recentFailures >= RECENT_FAILURES_FOR_REVIEW

  const summary = summaryFromCounts({
    independentCorrect: independent.length,
    distinctQuestions: distinctQuestions.size,
    distinctTemplates: templates.size,
    hasDelayedCorrect: delayed.length > 0,
    assistedOnly,
    confirmedGap,
    needsReview,
  })

  let bestSummary: Summary
  if (summary === SUMMARY.NEEDS_REVIEW) {
    bestSummary = input.previous.bestSummary
  } else {
    const previousIndex = SUMMARY_ORDER.indexOf(input.previous.bestSummary)
    if (previousIndex < 0) {
      // Python raises ValueError here (`order.index`); the store constrains the column, so a bad
      // value is a corrupt row, not something to paper over with a silent default.
      throw new Error(`unknown previous best summary: ${input.previous.bestSummary}`)
    }
    const summaryIndex = SUMMARY_ORDER.indexOf(summary as Summary)
    bestSummary = summaryIndex > previousIndex ? (summary as Summary) : input.previous.bestSummary
  }

  let downgradeReason = ''
  if (needsReview && input.previous.summary !== SUMMARY.NEEDS_REVIEW) {
    downgradeReason = `最近 ${RECENT_WINDOW} 次严格独立作答中有 ${recentFailures} 次失败`
  }

  return {
    summary,
    best_summary: bestSummary,
    independent_correct_count: independent.length,
    distinct_question_count: distinctQuestions.size,
    distinct_template_count: templates.size,
    has_delayed_correct: delayed.length > 0,
    recent_independent_attempts: recent.length,
    recent_independent_failures: recentFailures,
    needs_review: needsReview,
    downgrade_reason: downgradeReason,
    rule_version: RULE_VERSION,
    source_evidence_ids: [...independent, ...delayed].slice(0, 200).map((row) => pyStrValue(row.id)),
    detail: {
      thresholds: {
        distinct_questions: REQUIRED_DISTINCT_QUESTIONS,
        distinct_templates: REQUIRED_DISTINCT_TEMPLATES,
        delayed_correct: REQUIRED_DELAYED_CORRECT,
        recent_window: RECENT_WINDOW,
      },
      independent_attempts: recent.map((row) => ({
        evidence_id: pyStrValue(row.id),
        attempt_id: pyStrValue(row.attemptId),
        is_correct: row.isCorrect,
        computed_at: formatPythonIso(row.computedAt),
        exclusions: row.exclusionReasons,
      })),
      missing_evidence: missingEvidence({
        independentCorrect: independent.length,
        distinctTemplates: templates.size,
        hasDelayedCorrect: delayed.length > 0,
      }),
    },
    as_of: input.now,
  }
}
