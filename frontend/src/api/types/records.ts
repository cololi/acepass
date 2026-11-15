// Report, import, paper, grading-queue and knowledge DTOs.

import { PageDiagnosticOut, ReviewIssueOut } from '../imports'
import { GradePart } from './study'

export type ReportFractionStatus = 'final' | 'partial_lower_bound'

export interface ReportBucketOut {
  attempts: number
  confirmed_score: string
  max_score: string
  pending_max_score: string
  confirmed_fraction: string | null
  /** Every scoring mark in this bucket is confirmed (`pending_max_score <= 0`). */
  is_final: boolean
  fraction_status: ReportFractionStatus
}

/** One reason the report is not final, with its count and the affected ids. */
export interface ReportIncompleteReasonOut {
  code: string
  message: string
  attempt_count: number
  attempt_ids: string[]
  session_item_ids: string[]
  question_ids: string[]
  ids_truncated: boolean
}

export interface ReportIncompleteScopeOut {
  is_incomplete: boolean
  attempts_in_scope: number
  incomplete_attempts: number
  attempt_ids: string[]
  session_item_ids: string[]
  question_ids: string[]
  ids_truncated: boolean
  reasons: ReportIncompleteReasonOut[]
  missing_note: string | null
}

export interface ReportAggregateOut {
  status: 'final' | 'partial_lower_bound' | 'no_data'
  attempts_in_scope: number
  confirmed_score: string
  max_score: string
  unresolved_max_score: string
  unresolved_attempts: number
  /** Null unless every in-scope attempt is confirmed. */
  score_rate: string | null
  /** The confirmed part as a lower bound; present while partial too. */
  lower_bound: string | null
  includes_self_assessed_attempts: number
  label: string
  missing: {
    unresolved_max_score: string
    unresolved_attempts: number
    reason_codes: string[]
    note: string
  } | null
}

/** The final result; null whenever the report is not final. */
export interface ReportFinalResultOut {
  score_rate: string
  confirmed_score: string
  max_score: string
  attempts: number
  includes_self_assessed_attempts: number
  basis: string
}

export interface ReportOut {
  report_kind: string
  calculation_version: string
  as_of: string
  project_id: string
  subject_id: string | null
  totals: Record<string, ReportBucketOut>
  by_question_type: Record<string, ReportBucketOut>
  by_knowledge_node: Record<string, ReportBucketOut & { node_name: string; weight: string }>
  excluded_evidence: Array<{ attempt_id: string; dimension: string; reasons: string[]; node_id: string | null }>
  notes: string[]
  hidden_verification_attempts?: number
  hidden_verification_content_attempts?: number
  /** C06: `final` only when every in-scope attempt is fully confirmed. */
  result_status?: 'final' | 'incomplete' | 'no_data'
  incomplete_scope?: ReportIncompleteScopeOut
  aggregate?: ReportAggregateOut
  final_result?: ReportFinalResultOut | null
}

export interface ImportJobOut {
  id: string
  project_id: string
  subject_id: string | null
  status: string
  input_kind: string
  progress_percent: number
  problems: Array<{ code: string; message: string; severity: string }>
  attempts: number
  max_attempts: number
  last_error: string
  extractor_version: string
  duplicate_of_job_id: string | null
  document_ids: string[]
  candidate_count: number
  candidate_status_counts: Record<string, number>
  /** P2 batch 1: per-page layout diagnosis of every uploaded PDF (C01). */
  page_diagnostics: PageDiagnosticOut[]
  created_at: string
}

export interface CandidateOut {
  id: string
  job_id: string
  subject_id: string | null
  status: string
  revision: number
  review_issues: ReviewIssueOut[]
  is_stub_output: boolean
  extractor_version: string
  draft_payload: Record<string, unknown>
  machine_payload: Record<string, unknown>
  source_regions: Array<{
    id: string
    document_id: string
    page_index: number
    x: number
    y: number
    width: number
    height: number
    role: string
    text_span: string
    crop_asset_id: string | null
    document_asset_id: string | null
    document_title: string
    /** `image`, `text`, `pdf` or `pdf_answer`. */
    document_type: string
  }>
  publication_question_id: string | null
  publication_version_id: string | null
  /** The paper item this candidate occupies once published (P1-01). */
  publication_paper_item_id: string | null
  /** Material hierarchy parsed from the source; null for a top-level question. */
  parent_candidate_id: string | null
  child_candidate_ids: string[]
  /** 卷面题号 inside the paper revision, e.g. "12" or "三.2". */
  source_position_key: string
  paper_revision_id: string | null
  /** Answer-page match: a proposal a human still has to confirm. */
  answer_match: {
    matched?: boolean
    method?: string
    label?: string
    raw?: string
    source_page_index?: number
    document_id?: string
    document_title?: string
  }
  /**
   * P2 batch 1: the explicit layout confirmation that clears the blocking
   * issues a suspicious source page (multi-column / table / formula / scan)
   * raised. Until it is set those issues stay blocking.
   */
  layout_review_confirmed_at: string | null
  layout_review_note: string
  updated_at: string
}

export interface PaperRevisionOut {
  id: string
  revision: number
  status: string
  coverage_status: string
  expected_session_count: number | null
  covered_session_count: number | null
  item_count: number
  scored_item_count: number
  note: string
  coverage_confirmed_by?: string | null
  coverage_confirmed_at?: string | null
}

export interface PaperOut {
  id: string
  subject_id: string
  cycle_key: string
  session_key: string
  paper_code: string
  source_kind: string
  title: string
  is_demo: boolean
  effective_revision_id: string | null
  revisions: PaperRevisionOut[]
  coverage_note: string
}

export interface OutlineImportOut {
  created: number
  merged: number
  aliases_added: Array<{ node_id: string; aliases: string[] }>
  skipped: Array<{ line: number; text: string; reason: string; node_id?: string }>
  node_count: number
}

export interface CycleAnalysisOut {
  subject_id: string
  cycle_horizon: number
  status: 'ok' | 'insufficient_cycles'
  complete_cycle_count: number
  used_cycle_count: number
  missing_complete_cycles: number
  used_cycles: string[]
  cycles: Array<{
    cycle_key: string
    paper_count: number
    scored_item_count: number
    denominator_total_score: string
    share_total: string
    nodes: Array<{
      node_id: string | null
      label: string
      path: string
      unclassified: boolean
      score: string
      share: string | null
    }>
  }>
  incomplete_cycles: Array<{
    cycle_key: string
    paper_count: number
    blocking_reasons: Array<{ paper_id: string; reason: string }>
    papers: Array<{
      paper_id: string
      paper_code: string
      session_key: string
      /** Sent by the backend in addition to the documented shape. */
      source_kind?: string
      coverage_status: string
      expected_session_count: number | null
      covered_session_count: number | null
      countable: boolean
      reason: string
    }>
  }>
  nodes: Array<{
    node_id: string | null
    label: string
    path: string
    unclassified: boolean
    cycle_count: number
    average_share: string | null
    average_score: string | null
  }>
  coverage_gaps: Array<{ node_id: string; label: string; path: string; reason: string }>
  notes: string[]
}

export interface GradingQueueRow {
  attempt_id: string
  session_item_id: string
  question_id: string
  display_label: string
  question_type: string
  subject_id: string
  submitted_at: string
  grading_revision: number
  pending_max_score: string
  confirmed_score: string | null
  is_own_attempt: boolean
  can_review_as_other: boolean
  parts: GradePart[]
  /** The reviewer must be able to read the original work, not recall it. */
  raw_answer: Record<string, unknown>
  steps: unknown[]
  attachments: string[]
  confidence: string
  elapsed_ms: number
  rubric: { rubric_version_id: string; criteria: Array<Record<string, unknown>>; total_score: string } | null
}

export interface KnowledgeNode {
  id: string
  syllabus_version_id: string
  parent_id: string | null
  kind: string
  canonical_name: string
  code: string
  aliases: string[]
  is_unclassified: boolean
  display_order: number
  question_count: number
}

export interface VerificationPairingOut {
  id: string
  project_id: string
  subject_id: string
  node_id: string
  node_name: string
  baseline_question_id: string | null
  immediate_question_id: string
  delayed_question_id: string | null
  pairing_version: number
  delay_hours: number
  is_active: boolean
  reviewed_at: string | null
  note: string
  gap: string
}

export interface ReviewTaskRow {
  task_id: string
  status: string
  project_id: string
  subject_id: string
  question_id: string | null
  question_label: string
  knowledge_node_name: string
  delay_hours: number | null
  delay_anchor_at: string | null
  not_before: string | null
  due_now: boolean
  interval_reason: string
  anchor_source: string
  was_started: boolean
  deficit_notice: string
  reason_codes: string[]
}

export interface AiRunRow {
  id: string
  provider: string
  model: string
  capability: string
  prompt_version: string
  status: string
  is_stub: boolean
  attempts: number
  latency_ms: number | null
  cost_cents: string | null
  cost_known: boolean
  prompt_tokens: number | null
  completion_tokens: number | null
  error_code: string
  created_at: string
}

/* ------------------------------------------------------------------ P1: 前置关系 */
export interface KnowledgeRelationEdge {
  id: string
  syllabus_version_id: string
  from_node_id: string
  from_node_name: string
  to_node_id: string
  to_node_name: string
  relation_type: string
  is_active: boolean
  note: string
}

export interface KnowledgeRelationGraph {
  edges: KnowledgeRelationEdge[]
  node_count: number
  edge_count: number
  generated_at: string
  /** Present in the server payload; the UI does not need it yet. */
  unmet_prerequisites?: Array<Record<string, unknown>>
}

export interface NodePrerequisiteRow {
  node_id: string
  node_name: string
  state: string
  reason?: string
}

export interface NodePrerequisitesOut {
  node_id: string
  node_name: string
  prerequisites: NodePrerequisiteRow[]
  unmet: NodePrerequisiteRow[]
}

