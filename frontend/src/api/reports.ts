// Reports API: coverage, calibration, expression review notices.

import { detailText } from './errors'
import { apiRequest } from './transport'
import { GradeOut, GradePart } from './types/study'

export function bucketIsFinal(bucket: {
  fraction_status?: string | null
  is_final?: boolean | null
  pending_max_score?: string | number | null
}): boolean {
  if (bucket.fraction_status != null) return bucket.fraction_status === 'final'
  if (typeof bucket.is_final === 'boolean') return bucket.is_final
  return Number(bucket.pending_max_score ?? 0) <= 0
}

/** A server fraction (`0.625`) as a percentage label; null stays a dash. */
export function percentOfFraction(value: string | null | undefined, digits = 1): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return `${(number * 100).toFixed(digits)}%`
}

/* ---- C06 coverage completion ---- */
export interface CoverageCompletionReasonOut {
  code: string
  message: string
  paper_count: number
  paper_ids: string[]
  cycle_keys: string[]
}

export interface CoverageCompletionOut {
  status: 'final' | 'partial_lower_bound' | 'no_data'
  papers_total: number
  papers_coverage_complete: number
  /** Null unless every registered paper has a confirmed complete revision. */
  coverage_rate: string | null
  lower_bound: string | null
  items: { scored_total: number; unscored_total: number }
  incomplete_scope: {
    is_incomplete: boolean
    papers_total: number
    blocked_paper_count: number
    blocked_paper_ids: string[]
    reasons: CoverageCompletionReasonOut[]
    missing_note: string | null
  }
  final_result: { coverage_rate: string; papers_total: number; basis: string } | null
  note: string
}

/* ---- C08 effect calibration ---- */
export type CalibrationStatus = 'ok' | 'insufficient_sample'

export interface CalibrationDimensionsOut {
  question_type: string
  question_type_label: string
  difficulty_band: string
  difficulty_proxy: string
  timing_state: string
  exposure_state: string
}

export interface CalibrationStatisticsOut {
  mean_confirmed_fraction: string
  median_confirmed_fraction: string
  spread_stdev: string
  min_confirmed_fraction: string
  max_confirmed_fraction: string
  metric: string
}

export interface CalibrationExclusionReasonOut {
  code: string
  message: string
  attempt_count: number
}

export interface CalibrationGroupOut {
  group_key: string
  dimensions: CalibrationDimensionsOut
  sample_size: number
  confirmed_sample_size: number
  status: CalibrationStatus
  /** Withheld (null) below the minimum sample: never shown with a warning instead. */
  statistics: CalibrationStatisticsOut | null
  exclusions: {
    attempts_without_confirmed_score: number
    reasons: CalibrationExclusionReasonOut[]
  }
  /** What this group's numbers may be used for, stated by the server. */
  comparability: string
}

export interface CalibrationDeltaOut {
  metric: string
  group_a_mean: string
  group_b_mean: string
  delta: string
  sample_size: { group_a: number; group_b: number }
  spread: { group_a_stdev: string; group_b_stdev: string }
  caveats: string[]
}

export interface CalibrationComparisonOut {
  group_a: string
  group_b: string
  comparable: boolean
  code: string
  message: string | null
  /** Present only for comparable pairs; a bare delta is never emitted. */
  delta: CalibrationDeltaOut | null
}

export interface CalibrationOut {
  report_kind: string
  calculation_version: string
  as_of: string
  project_id: string
  subject_id: string | null
  minimum_group_sample: number
  grouping: {
    dimensions: string[]
    difficulty_proxy: string
    difficulty_proxy_note: string
    timing_note: string
    exposure_note: string
    attempts_in_scope: number
    hidden_verification_attempts: number
    hidden_verification_content_attempts: number
  }
  groups: CalibrationGroupOut[]
  group_count: number
  comparable_group_count: number
  /** Every eligible pair; only `comparable: true` rows carry a delta. */
  comparisons: CalibrationComparisonOut[]
  comparable_pair_count: number
  not_comparable: Array<{ group_key: string; code: string; message: string | null }>
  exclusions: { attempts_in_scope: number; reasons: CalibrationExclusionReasonOut[] }
  caveats: {
    statements: string[]
    claims: { causal_claim: boolean; improvement_claim: boolean }
    minimum_group_sample: number
  }
}

/**
 * Effect calibration for the current project/subject.
 *
 * Read-only: nothing is written and no snapshot is produced. The payload is
 * rendered as it arrives — no single headline number is derived from it.
 */
export function fetchEffectCalibration(projectId: string, subjectId?: string | null) {
  const params = new URLSearchParams()
  if (subjectId) params.set('subject_id', subjectId)
  const query = params.toString()
  return apiRequest<CalibrationOut>(
    `/projects/${projectId}/reports/calibration${query ? `?${query}` : ''}`,
  )
}

/* ---- C07 expression blanks sent to review ---- */
/** Engine error types a restricted expression comparison can end in. */
/**
 * The engine error type -> the short parenthetical in 「表达式无法确认（超时）：…」.
 * The server's own sentence always follows it, so nothing here replaces the
 * reason — it only names the category the server already put in `detail.error`.
 */
export const EXPRESSION_REVIEW_CODE_LABELS: Record<string, string> = {
  syntax: '语法非法',
  limit: '超出受限计算上限',
  domain: '采样点无定义',
  timeout: '超时',
  unknown_symbol: '未知符号',
}

export interface ExpressionReviewNotice {
  partId: string
  /** The server's own sentence for this part. */
  reason: string
  /** Engine error type when the server named one (`syntax`/`limit`/`domain`/`timeout`). */
  errorType: string | null
  /** The engine's own note, when present. */
  engineMessage: string | null
  unknownSymbols: string[]
  submitted: string | null
  /** Human label for the error type; falls back to "需人工复核". */
  codeLabel: string
}

export function isExpressionDetail(detail: Record<string, unknown> | undefined, reason: string): boolean {
  if (detail?.equivalence === 'expression') return true
  if (detail?.error !== undefined && detail?.error !== null) return true
  if (Array.isArray(detail?.unknown_symbols) && detail.unknown_symbols.length > 0) return true
  // The engine's review sentences all name the blank as an expression.
  return reason.includes('表达式')
}

/**
 * Why an expression blank went to human review, from the grade the server sent.
 *
 * Only `pending_review` parts with an expression detail are returned: an unknown
 * verdict is never rendered as a correctness verdict, it is rendered as the
 * server's own reason plus who reviews it.
 */
export function expressionReviewNoticesFromParts(
  parts: GradePart[] | null | undefined,
): ExpressionReviewNotice[] {
  const rows: ExpressionReviewNotice[] = []
  for (const part of parts ?? []) {
    if (part.status !== 'pending_review') continue
    const detail = (part.detail ?? {}) as Record<string, unknown>
    const reason = detailText(detail.reason)
    if (!isExpressionDetail(detail, reason)) continue
    const errorType = detailText(detail.error) || null
    const symbols = Array.isArray(detail.unknown_symbols) ? detail.unknown_symbols.map(String) : []
    rows.push({
      partId: part.part_id,
      reason: reason || '表达式无法确认，已转人工复核',
      errorType,
      engineMessage: detailText(detail.message) || null,
      unknownSymbols: symbols,
      submitted: detailText(detail.submitted) || null,
      codeLabel:
        (errorType ? EXPRESSION_REVIEW_CODE_LABELS[errorType] : undefined) ??
        (symbols.length ? EXPRESSION_REVIEW_CODE_LABELS.unknown_symbol : '需人工复核'),
    })
  }
  return rows
}

export function expressionReviewNotices(grade: GradeOut | null | undefined): ExpressionReviewNotice[] {
  return expressionReviewNoticesFromParts(grade?.parts ?? null)
}
