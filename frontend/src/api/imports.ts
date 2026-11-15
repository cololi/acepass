// Import API: layout review, import jobs and candidates.

import { ApiError, apiRequest, newIdempotencyKey } from './transport'
import { CandidateOut, ImportJobOut } from './types/records'

export interface PageDiagnosticOut {
  /** Added by the job collector; the extractor's own rows carry no document id. */
  document_id?: string | null
  document_title?: string
  page_index: number
  reasons: string[]
  columns: number
  has_table_grid: boolean
  has_formula_tokens: boolean
  is_scanned: boolean
  reading_order_reliable: boolean
  character_count: number
  /** The server's own verdict: this page blocks until a human confirms it. */
  needs_review?: boolean
  fragment_count?: number
}

/** One proofreading issue; layout entries also name the pages that raised them. */
export interface ReviewIssueOut {
  code: string
  message: string
  severity: string
  /**
   * The three blocking layout codes carry `{document_id, page_index, reason}`;
   * the non-blocking `cross_page_question` carries plain page numbers. Both
   * shapes are accepted so the panel never prints `第 undefined 页`.
   */
  pages?: Array<{ document_id?: string | null; page_index: number; reason?: string } | number>
  page_indexes?: number[]
  reasons?: string[]
  [key: string]: unknown
}

/** Page numbers of a layout issue, from whichever shape the server sent. */
export function issuePageIndexes(issue: ReviewIssueOut): number[] {
  const raw: number[] = []
  for (const value of issue.page_indexes ?? []) {
    const index = Number(value)
    if (Number.isFinite(index)) raw.push(index)
  }
  for (const page of issue.pages ?? []) {
    const index = typeof page === 'number' ? Number(page) : Number((page as { page_index?: unknown }).page_index)
    if (Number.isFinite(index)) raw.push(index)
  }
  return raw.filter((value, position) => raw.indexOf(value) === position)
}

/** The page reasons that make a candidate unpublishable until a human confirms. */
export const LAYOUT_BLOCKING_ISSUE_CODES = [
  'page_without_text_layer_needs_manual_entry',
  'multi_column_needs_review',
  'table_or_formula_needs_review',
] as const

/** Non-blocking, but the proofreader still has to know the question spans pages. */
export const LAYOUT_WARNING_ISSUE_CODES = ['cross_page_question'] as const

export function isLayoutBlockingIssue(issue: { code: string; severity?: string }): boolean {
  return (
    issue.severity === 'blocking' &&
    (LAYOUT_BLOCKING_ISSUE_CODES as readonly string[]).includes(issue.code)
  )
}

export function isLayoutIssue(issue: { code: string }): boolean {
  return (
    (LAYOUT_BLOCKING_ISSUE_CODES as readonly string[]).includes(issue.code) ||
    (LAYOUT_WARNING_ISSUE_CODES as readonly string[]).includes(issue.code)
  )
}

/**
 * A 422 refusal carries the server's own problem rows.
 *
 * Publication is refused server-side, so the UI shows that list verbatim instead
 * of inventing a summary (and never claims a candidate is publishable when the
 * server just said otherwise).
 */
export interface ApiProblemRow {
  code: string
  message: string
  severity?: string
}

export function problemsOf(error: unknown): ApiProblemRow[] {
  if (!(error instanceof ApiError)) return []
  const raw = error.details?.problems
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .map((entry) => ({
      code: String(entry.code ?? ''),
      message: String(entry.message ?? ''),
      severity: entry.severity === undefined ? undefined : String(entry.severity),
    }))
    .filter((entry) => entry.code.length > 0 || entry.message.length > 0)
}

/** The job payload that carries `page_diagnostics` (the candidate payload does not). */
export function fetchImportJob(projectId: string, jobId: string) {
  return apiRequest<ImportJobOut>(`/projects/${projectId}/imports/${jobId}`)
}

/**
 * Confirm the layout of the pages a candidate came from.
 *
 * One fresh `Idempotency-Key` per attempt: a second click is a second attempt
 * with its own key, while a network retry of the same click reuses the row the
 * server already recorded.
 */
export function confirmCandidateLayout(projectId: string, candidateId: string, note: string) {
  return apiRequest<CandidateOut>(
    `/projects/${projectId}/import-candidates/${candidateId}/layout-confirm`,
    {
      method: 'POST',
      idempotencyKey: newIdempotencyKey('candidate-layout-confirm'),
      body: { note },
    },
  )
}

/* ============================================ P2 批次 1：曝光与已见（C04） */
/** Which ledger row proves one contamination reason. */
