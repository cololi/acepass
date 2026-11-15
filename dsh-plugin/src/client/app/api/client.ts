/**
 * Typed API client (migrated verbatim from the Django frontend).
 *
 * DSH owns identity: there is no CSRF/LDAP/session exchange here, and the request layer posts through
 * the plugin's Remote channel (`transportFetch`) instead of a Django origin. Everything above the
 * transport — paths, idempotency keys, error envelope handling — is unchanged, which is what keeps
 * the browser acceptance suite meaningful.
 */
import { transportFetch } from '../../transport.ts'

export interface ApiErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
  request_id?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  readonly requestId?: string

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || '请求失败')
    this.name = 'ApiError'
    this.status = status
    this.code = body.code || 'unknown_error'
    this.details = body.details || {}
    this.requestId = body.request_id
  }

  get isPurposeBlocked(): boolean {
    return this.status === 403
  }

  get isAiUnavailable(): boolean {
    return this.code === 'ai_not_configured'
  }
}

const BASE = '/api/v1'

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`))
  return match ? decodeURIComponent(match[2]) : null
}

/**
 * DSH authenticates the browser itself, so there is no CSRF token to fetch. The call stays because
 * every mutating helper awaits it and the migration keeps the request flow unchanged.
 */
export async function ensureCsrf(): Promise<void> {
  return
}

/**
 * Private bytes for `<img src>` and download links.
 *
 * Elements cannot carry the RPC envelope, and the real path has two identifiers, so the plugin serves
 * one exact route with both as query parameters; the host replays it against the same download handler
 * (all four gates still apply). Paths are relative to the document, which is where DSH serves the app.
 */
export function assetUrl(
  projectId: string | null | undefined,
  assetId: string | null | undefined,
  purpose?: string,
): string {
  const params = new URLSearchParams({ project_id: projectId ?? '', asset_id: assetId ?? '' })
  if (purpose !== undefined && purpose !== '') params.set('purpose', purpose)
  return `/api/acepass/asset?${params.toString()}`
}

export function newIdempotencyKey(scope: string): string {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  return `${scope}:${random}`
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  formData?: FormData
  signal?: AbortSignal
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') {
    await ensureCsrf()
    const token = readCookie('csrftoken')
    if (token) headers['X-CSRFToken'] = token
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  let body: BodyInit | undefined
  if (options.formData) {
    body = options.formData
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await transportFetch(`${BASE}${path}`, {
    method,
    headers,
    body,
    credentials: 'same-origin',
    signal: options.signal,
  })
  const text = await response.text()
  const payload = text ? safeJson(text) : null
  if (!response.ok) {
    const envelope = (payload as { error?: ApiErrorBody } | null)?.error
    throw new ApiError(
      response.status,
      envelope || { code: 'http_error', message: `请求失败（HTTP ${response.status}）` },
    )
  }
  return payload as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Domain types (mirrors the server DTOs; answers are never part of a stem DTO)
// ---------------------------------------------------------------------------
export interface UserOut {
  id: string
  email: string
  display_name: string
  is_staff: boolean
  timezone: string
  daily_budget_minutes: number
  undiagnosed_time_share_percent: number
  needs_project_setup: boolean
  is_reviewer: boolean
}

export interface ProjectOut {
  id: string
  name: string
  description: string
  target_date: string | null
  target_score: string | null
  is_archived: boolean
  display_order: number
  subject_count: number
  question_count: number
  created_at: string
}

export interface SubjectOut {
  id: string
  project_id: string
  name: string
  code: string
  display_order: number
  total_score: string | null
  pass_score: string | null
}

export interface SpecOut {
  id: string
  subject_id: string
  version: number
  name: string
  total_score: string | null
  pass_score: string | null
  question_type_rules: Record<string, Record<string, unknown>>
  time_rules: Record<string, unknown>
  score_floor_at_zero: boolean
  rule_source_note: string
  is_demo: boolean
  status: string
  published_at: string | null
  is_usable: boolean
  rule_summary: Record<string, Record<string, unknown>>
}

export interface SyllabusOut {
  id: string
  subject_id: string
  name: string
  version_label: string
  is_user_provisional: boolean
  review_status: string
  status: string
  published_at: string | null
  node_count: number
}

export interface QuestionListItem {
  id: string
  subject_id: string
  display_label: string
  origin_type: string
  is_demo: boolean
  question_type: string | null
  published_version_id: string | null
  latest_version: number | null
  has_trusted_answer: boolean
  knowledge_nodes: string[]
}

export interface Block {
  kind: 'text' | 'math' | 'image' | 'table'
  text?: string
  latex?: string
  asset_id?: string
  alt?: string
  caption?: string
  rows?: Array<Array<{ text?: string } | string>>
}

export interface StemPayload {
  question_version_id: string
  question_type: string
  blocks: Block[]
  options: Array<{ id: string; label: string; blocks: Block[] }>
  blanks: Array<{ blank_id: string; label: string }>
  blank_ids: string[]
  material: { blocks: Block[]; child_version_ids: string[] } | null
}

export interface PresentationOut {
  session_item_id: string
  session_id: string
  mode: string
  status: string
  ordinal: number
  max_score: string
  purpose: string
  tutoring_allowed: boolean
  first_delivered_at: string
  server_time: string
  first_delivery: boolean
  draft: Record<string, unknown>
  draft_revision: number
  stem: StemPayload
  assets: string[]
  grading_hidden: boolean
  /** C05: the server-owned exam clock, echoed on every item delivery too. */
  exam_started_at: string | null
  exam_deadline: string | null
  expired_at: string | null
}

export interface GradePart {
  part_id: string
  score: string | null
  max_score: string
  status: string
  method: string | null
  detail?: Record<string, unknown>
}

export interface GradeOut {
  grade_event_id: string
  status: string
  method: string
  grading_revision: number
  confirmed_score: string | null
  max_score: string
  pending_max_score: string
  estimated_score: string | null
  /** Every scoring part has been decided. A wrong answer is fully confirmed. */
  is_fully_confirmed: boolean
  /** Fully confirmed *and* at full marks: the only reading of "完全正确". */
  is_correct: boolean
  parts: GradePart[]
  rule_version: string
  rule_snapshot: Record<string, unknown>
  grader_is_self: boolean
  comment: string
  superseded: boolean
}

export interface AttemptState {
  attempt_id: string
  submitted_at: string
  elapsed_ms: number
  grading_revision: number
  grade: GradeOut | null
  receipt_only: boolean
}

export interface AttemptDetail {
  attempt_id: string
  session_item_id: string
  submitted_at: string
  elapsed_ms: number
  raw_answer: Record<string, unknown>
  steps: unknown[]
  attachments: string[]
  confidence: string
  grading_revision: number
  receipt_only: boolean
  grade: GradeOut | null
}

export interface MistakeRow {
  attempt_id: string
  session_item_id: string
  session_id: string
  question_id: string
  question_version_id: string
  display_label: string
  question_type: string
  subject_id: string
  submitted_at: string
  grading_revision: number
  confirmed_score: string
  max_score: string
  lost_score: string
  method: string
  grader_is_self: boolean
  parts: GradePart[]
  raw_answer: Record<string, unknown>
  steps: unknown[]
  attachments: string[]
  can_tutor: boolean
}

export interface UploadedAsset {
  id: string
  role: string
  content_type: string
  size_bytes: number
  original_filename: string
}

export interface SessionItemState {
  session_item_id: string
  ordinal: number
  question_id: string
  question_type: string
  display_label: string
  max_score: string
  purpose: string
  first_delivered_at: string | null
  draft_revision: number
  has_draft: boolean
  tutoring_allowed: boolean
  /** Stable ids for reveal / tutoring after a reload or deep link. */
  attempt_id: string | null
  can_reveal: boolean
  /** C01: this item's grading is withheld by the shared content gate. */
  grading_withheld?: boolean
  attempt: AttemptState | null
}

export interface SessionOut {
  session_id: string
  project_id: string
  subject_id: string
  mode: string
  status: string
  policy_version: string
  grading_hidden: boolean
  revealed_at: string | null
  created_at: string
  finished_at: string | null
  /**
   * C05: the server-owned exam clock, part of every snapshot.
   *
   * `server_time` is the instant the payload was built from; the deadline never
   * moves, so the remaining time must be derived from these two fields instead
   * of the device clock.
   */
  server_time: string | null
  exam_started_at: string | null
  exam_deadline: string | null
  /** Set when the server finished the exam because the deadline had passed. */
  expired_at: string | null
  items: SessionItemState[]
  confirmed_score: string | null
  pending_max_score: string | null
  score_visible: boolean
  score_hidden_reason?: string | null
  grading_withheld_session_item_ids?: string[]
}

export interface RevealOut {
  question_version_id: string
  answer_key_version_id: string | null
  answer_payload: Record<string, unknown>
  answer_source_type: string | null
  answer_verification_status: string | null
  check_basis: string
  explanation_blocks: Block[]
  rubric: { rubric_version_id: string; criteria: Array<Record<string, unknown>>; total_score: string } | null
  confidence_note: string
  exposure_recorded: boolean
}

export interface AiStatus {
  provider: string
  configured: boolean
  is_stub: boolean
  capabilities: Record<string, boolean>
  message: string
  max_retries: number
  total_timeout_seconds: number
}

export interface TutorJobOut {
  tutor_job_id: string
  tutor_session_id: string
  session_item_id: string
  purpose: string
  status: string
  reveals_answer: boolean
  is_stale: boolean
  is_stub: boolean
  provider: string
  model: string
  prompt_version: string
  error_code: string
  error_message: string
  delivered_at: string | null
  /** Validated segments available for replay (SSE or `/segments`). */
  segment_count: number
  result_blocks: Block[]
  citations: string[]
  missing_information: string[]
  suggested_next: string[]
}

export interface PlanTaskOut {
  task_id: string
  task_kind: string
  status: string
  project_id: string
  subject_id: string
  question_id: string | null
  question_label: string
  knowledge_node_id: string | null
  knowledge_node_name: string
  estimated_minutes: number
  reason_codes: string[]
  evidence_ids: string[]
  not_before: string | null
  due_at: string | null
  delay_anchor_at: string | null
  delay_hours: number | null
  available_now: boolean
  deficit_notice: string
  pairing_version: number | null
}

export interface TodayPlanOut {
  plan: {
    plan_id: string
    plan_date: string
    revision: number
    timezone: string
    daily_budget_minutes: number
    allocated_minutes: number
    allocation: Array<{ project_id: string; project_name: string; minutes: number; percent: number }>
    rotation_offset: number
    rule_version: string
    generated_at: string
  } | null
  tasks: PlanTaskOut[]
  notes: string[]
  backlog: Array<{ project_id: string; project_name: string; overdue_tasks: number }>
  progress_notes: string[]
}

export interface EvidenceRow {
  id: string
  attempt_id: string
  node_id: string | null
  node_name: string | null
  dimension: string
  qualifies: boolean
  is_correct: boolean
  score_fraction: string | null
  exclusion_reasons: string[]
  rule_version: string
  computed_at: string
  grade_revision: number
  detail: Record<string, unknown>
}

export interface KnowledgeStateRow {
  node_id: string
  node_name: string
  subject_id: string
  summary: string
  best_summary: string
  independent_correct_count: number
  distinct_question_count: number
  distinct_template_count: number
  has_delayed_correct: boolean
  needs_review: boolean
  downgrade_reason: string
  missing_evidence: string[]
  independent_attempts: Array<Record<string, unknown>>
  thresholds: Record<string, number>
  rule_version: string
  as_of: string
  evidence?: EvidenceRow[]
}

/** C06: a bucket fraction is a final rate only when every mark in it is confirmed. */
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

/** Edge that would close a cycle is refused with the offending path names. */
export function cycleNamesOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return []
  const raw = error.details?.cycle_names
  if (!Array.isArray(raw)) return []
  return raw.map((value) => String(value)).filter((value) => value.length > 0)
}

export function fetchKnowledgeRelations(projectId: string, subjectId?: string | null) {
  const params = new URLSearchParams()
  if (subjectId) params.set('subject_id', subjectId)
  const suffix = params.toString()
  return apiRequest<KnowledgeRelationGraph>(
    `/projects/${projectId}/knowledge-relations${suffix ? `?${suffix}` : ''}`,
  )
}

export function createKnowledgeRelation(
  projectId: string,
  payload: {
    syllabus_version_id: string
    from_node_id: string
    to_node_id: string
    relation_type: string
    note: string
  },
) {
  return apiRequest<KnowledgeRelationEdge>(`/projects/${projectId}/knowledge-relations`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('knowledge-relation-create'),
    body: payload,
  })
}

export function deactivateKnowledgeRelation(projectId: string, relationId: string, reason: string) {
  const params = new URLSearchParams()
  if (reason) params.set('reason', reason)
  const suffix = params.toString()
  return apiRequest<KnowledgeRelationEdge>(
    `/projects/${projectId}/knowledge-relations/${relationId}${suffix ? `?${suffix}` : ''}`,
    { method: 'DELETE' },
  )
}

export function fetchNodePrerequisites(projectId: string, nodeId: string) {
  return apiRequest<NodePrerequisitesOut>(`/projects/${projectId}/knowledge-nodes/${nodeId}/prerequisites`)
}

/* --------------------------------------------------------------- P1: 标签建议 */
export interface TagProposal {
  name: string
  confidence: number
  rationale?: string
}

export interface TagMappingRow {
  node_id: string
  node_name: string
  /** Decimal string: the primary mapping sums to exactly 1, auxiliary rows are 0. */
  weight: string
  is_primary: boolean
}

export interface TagSuggestionOut {
  id: string
  project_id: string
  question_version_id: string
  question_label: string
  status: string
  proposals: TagProposal[]
  model_identifier: string
  prompt_version: string
  is_stub: boolean
  created_at: string
  decided_at: string | null
  accepted_mapping_revision: number | null
  unresolved_names: string[]
  decision_note: string
  latest_mappings: TagMappingRow[]
}

/** Result of accepting: a new auxiliary mapping revision, never a new node. */
export interface TagSuggestionDecisionOut {
  suggestion_id: string
  status: string
  mapping_revision: number | null
  added_node_names: string[]
  unresolved_names: string[]
}

export function fetchTagSuggestions(projectId: string, versionId: string) {
  return apiRequest<TagSuggestionOut[]>(
    `/projects/${projectId}/question-versions/${versionId}/tag-suggestions`,
  )
}

export function createTagSuggestion(projectId: string, versionId: string) {
  return apiRequest<TagSuggestionOut>(`/projects/${projectId}/question-versions/${versionId}/tag-suggestions`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('tag-suggestion-create'),
  })
}

export function acceptTagSuggestion(
  projectId: string,
  suggestionId: string,
  payload: { node_names: string[] | null; note: string },
) {
  return apiRequest<TagSuggestionDecisionOut>(`/projects/${projectId}/tag-suggestions/${suggestionId}/accept`, {
    method: 'POST',
    body: payload,
  })
}

export function rejectTagSuggestion(
  projectId: string,
  suggestionId: string,
  payload: { node_names: string[] | null; note: string },
) {
  return apiRequest<TagSuggestionOut>(`/projects/${projectId}/tag-suggestions/${suggestionId}/reject`, {
    method: 'POST',
    body: payload,
  })
}

/* ------------------------------------------------------------------ P1: 检索 */
export interface SearchResultRow {
  document_id: string
  /** `question` or `node`. */
  kind: string
  question_id: string | null
  question_version_id: string | null
  knowledge_node_id: string | null
  subject_id: string | null
  display_label: string
  excerpt: string
  keyword_score: number | null
  keyword_rank: number | null
  vector_score: number | null
  vector_rank: number | null
  fused_score: number
  channels: string[]
  matched_terms: string[]
}

export interface SearchChannelStatus {
  requested?: boolean
  used?: boolean
  available: boolean
  /** The server's own explanation; `available_reason` is accepted as an alias. */
  reason?: string | null
  available_reason?: string | null
  hits?: number
  documents_scored?: number
  documents_with_embeddings?: number
  model?: string | null
  is_stub?: boolean
}

export interface SearchResponseOut {
  project_id: string
  subject_id: string | null
  query: string
  query_tokens: string[]
  channel: string
  limit: number
  candidate_documents: number
  tokenizer_version: string
  fusion: { method: string; k: number } | null
  channels: { keyword: SearchChannelStatus; vector: SearchChannelStatus }
  notes: string[]
  results: SearchResultRow[]
}

export interface SearchReindexOut {
  project_id: string
  subject_id: string | null
  indexed: number
  excluded: number
  embeddings: number
  embedding_unavailable_reason: string
  embedding_model: string
  documents_total: number
  documents_in_index: number
  tokenizer_version: string
}

export function searchChannelReason(status: SearchChannelStatus | undefined | null): string {
  if (!status) return ''
  return (status.reason ?? status.available_reason ?? '').toString()
}

export function fetchSearchResults(
  projectId: string,
  params: { q: string; subjectId?: string | null; limit?: number; channel?: string },
) {
  const query = new URLSearchParams()
  query.set('q', params.q)
  if (params.subjectId) query.set('subject_id', params.subjectId)
  query.set('limit', String(params.limit ?? 10))
  if (params.channel) query.set('channel', params.channel)
  return apiRequest<SearchResponseOut>(`/projects/${projectId}/search?${query.toString()}`)
}

export function reindexSearch(projectId: string, body: { subject_id?: string }) {
  return apiRequest<SearchReindexOut>(`/projects/${projectId}/search/reindex`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('search-reindex'),
    body,
  })
}

/* ---------------------------------------------------------------- P1: 记忆卡 */
export type MemoryRating = 'again' | 'hard' | 'good' | 'easy'

export interface MemoryCardOut {
  card_id: string
  project_id: string
  subject_id: string
  question_id: string
  question_label: string
  stem_excerpt: string
  knowledge_node_id: string | null
  knowledge_node_name: string
  phase: string
  due_at: string | null
  last_reviewed_at: string | null
  stability: number
  difficulty: number
  /** `null` for a card that has never been reviewed. */
  retrievability: number | null
  reps: number
  lapses: number
  learning_step: number
  is_suspended: boolean
  suspended_reason: string
  scheduler_version: string
  params_version: string
  desired_retention: number
}

export interface MemoryReviewOut {
  card_id: string
  log_id: string
  rating: string
  phase: string
  phase_before: string
  due_at: string | null
  reviewed_at: string
  interval_days: number
  elapsed_days: number
  scheduled_days: number
  retrievability: number
  stability: number
  difficulty: number
  is_lapse: boolean
  reps: number
  lapses: number
  scheduler_version: string
  params_version: string
}

export interface MemoryReviewLogOut {
  log_id: string
  card_id: string
  rating: string
  reviewed_at: string
  elapsed_days: number
  scheduled_days: number
  interval_days: number
  retrievability: number
  is_lapse: boolean
  phase_before: string
  phase_after: string
  stability_before: number
  stability_after: number
  difficulty_before: number
  difficulty_after: number
  due_before: string | null
  due_after: string | null
  scheduler_version: string
  params_version: string
  source_session_item_id: string | null
  note: string
}

export interface MemoryRebuildOut {
  matches: boolean
  rebuilt: Record<string, unknown>
  stored: Record<string, unknown>
  log_count: number
  compared_fields: string[]
  differing_fields: string[]
  unknown_params_versions: string[]
}

export function fetchMemoryCards(
  projectId: string,
  options: { dueBefore?: string | null; includeSuspended?: boolean; limit?: number } = {},
) {
  const params = new URLSearchParams()
  if (options.dueBefore) params.set('due_before', options.dueBefore)
  params.set('include_suspended', options.includeSuspended ? 'true' : 'false')
  params.set('limit', String(options.limit ?? 50))
  return apiRequest<MemoryCardOut[]>(`/projects/${projectId}/memory-cards?${params.toString()}`)
}

export function createMemoryCard(projectId: string, questionId: string) {
  return apiRequest<MemoryCardOut>(`/projects/${projectId}/memory-cards`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('memory-card-create'),
    body: { question_id: questionId },
  })
}

/** One click = one fresh key: a repeat click can never review the same card twice. */
export function reviewMemoryCard(projectId: string, cardId: string, rating: MemoryRating) {
  return apiRequest<MemoryReviewOut>(`/projects/${projectId}/memory-cards/${cardId}/review`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('memory-review'),
    body: { rating },
  })
}

export function fetchMemoryCardLogs(projectId: string, cardId: string, limit = 50) {
  return apiRequest<MemoryReviewLogOut[]>(
    `/projects/${projectId}/memory-cards/${cardId}/logs?limit=${limit}`,
  )
}

export function rebuildMemoryCard(projectId: string, cardId: string) {
  return apiRequest<MemoryRebuildOut>(`/projects/${projectId}/memory-cards/${cardId}/rebuild`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('memory-card-rebuild'),
  })
}

export function suspendMemoryCard(projectId: string, cardId: string, reason: string) {
  return apiRequest<MemoryCardOut>(`/projects/${projectId}/memory-cards/${cardId}/suspend`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('memory-card-suspend'),
    body: { reason },
  })
}

export function resumeMemoryCard(projectId: string, cardId: string) {
  return apiRequest<MemoryCardOut>(`/projects/${projectId}/memory-cards/${cardId}/resume`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('memory-card-resume'),
  })
}

/* ------------------------------------------------------- P1 批次 3：手写转写 */
/** One transcription of one uploaded photo: a model proposal or a manual entry. */
export interface TranscriptionOut {
  id: string
  attempt_id: string
  asset_id: string
  /** `model` (a proposal) or `manual` (the learner's own words, already confirmed). */
  origin: string
  /** `proposed` | `confirmed` | `edited` | `rejected` (server vocabulary). */
  status: string
  /** What the model read; never a graded answer on its own. */
  raw_text: string
  /** The human-confirmed text; only this may be used for estimation. */
  confirmed_text: string
  confidence: number | null
  /** The model's own uncertainty notes; shown, never hidden. */
  doubts: string[]
  is_stub: boolean
  /** The server's own verdict, authoritative over the status string. */
  is_confirmed: boolean
  decided_at: string | null
  note: string
}

export interface TranscriptionListOut {
  transcriptions: TranscriptionOut[]
  /** Photos of this attempt whose transcription is still not confirmed. */
  pending_asset_ids: string[]
  /** Every photo of the attempt, as the server sees it. */
  attachment_asset_ids: string[]
  /** True while at least one photo blocks estimation and diagnosis. */
  transcription_required: boolean
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => String(value)).filter((value) => value.length > 0)
}

function asNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function normalizeTranscription(raw: unknown): TranscriptionOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    // The service names it `transcription_id`; `id` is accepted for parity.
    id: String(row.transcription_id ?? row.id ?? ''),
    attempt_id: String(row.attempt_id ?? ''),
    asset_id: String(row.asset_id ?? ''),
    // An older row without the field is treated as a model proposal, which is
    // what every pre-manual-path transcription was.
    origin: String(row.origin ?? 'model'),
    status: String(row.status ?? 'proposed'),
    raw_text: String(row.raw_text ?? ''),
    confirmed_text: String(row.confirmed_text ?? ''),
    confidence: asNumberOrNull(row.confidence),
    doubts: asStringArray(row.doubts),
    is_stub: Boolean(row.is_stub),
    is_confirmed:
      row.is_confirmed === undefined
        ? row.status === 'confirmed' || row.status === 'edited'
        : Boolean(row.is_confirmed),
    decided_at: row.decided_at ? String(row.decided_at) : null,
    note: String(row.note ?? ''),
  }
}

/**
 * The list endpoint answers "these proposals" **and** "which photos still need
 * confirmation"; the pending set is read from whichever key the server uses so
 * the panel never has to guess, and an empty list is never shown as "all clear"
 * when the server actually said nothing.
 */
export function normalizeTranscriptionList(payload: unknown): TranscriptionListOut {
  const rows = Array.isArray(payload)
    ? payload
    : ((payload as { transcriptions?: unknown[]; items?: unknown[]; results?: unknown[] } | null)
        ?.transcriptions ??
      (payload as { items?: unknown[] } | null)?.items ??
      (payload as { results?: unknown[] } | null)?.results ??
      [])
  const container = (payload && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>
  const transcriptions = Array.isArray(rows) ? rows.map(normalizeTranscription) : []
  const pending = asStringArray(
    container.pending_asset_ids ??
      container.unconfirmed_asset_ids ??
      container.missing_asset_ids ??
      container.needs_confirmation_asset_ids,
  )
  const effectivePending = pending.length
    ? pending
    : transcriptions.filter((row) => !row.is_confirmed).map((row) => row.asset_id)
  return {
    transcriptions,
    attachment_asset_ids: asStringArray(container.attachment_asset_ids),
    pending_asset_ids: effectivePending,
    transcription_required:
      container.transcription_required === undefined
        ? effectivePending.length > 0
        : Boolean(container.transcription_required),
  }
}

export function fetchTranscriptions(projectId: string, attemptId: string) {
  return apiRequest<unknown>(`/projects/${projectId}/attempts/${attemptId}/transcriptions`).then(
    normalizeTranscriptionList,
  )
}

/**
 * Request one transcription.
 *
 * Without `text` a vision model reads the photo and the answer is a proposal.
 * With `text` (even blank) no model is called by intent: the learner's own words
 * are recorded and already confirmed — this is the path that works when no
 * vision model is configured.
 */
export function requestTranscription(
  projectId: string,
  attemptId: string,
  assetId: string,
  text?: string,
) {
  return apiRequest<unknown>(`/projects/${projectId}/attempts/${attemptId}/transcriptions`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('transcription-request'),
    body: text === undefined ? { asset_id: assetId } : { asset_id: assetId, text },
  }).then(normalizeTranscription)
}

export function confirmTranscription(
  projectId: string,
  // Kept in the signature so callers stay attempt-scoped; the route itself is
  // project-scoped (`/projects/{p}/transcriptions/{id}/confirm`).
  _attemptId: string,
  transcriptionId: string,
  payload: { text: string; note?: string },
) {
  return apiRequest<unknown>(
    `/projects/${projectId}/transcriptions/${transcriptionId}/confirm`,
    {
      method: 'POST',
      idempotencyKey: newIdempotencyKey('transcription-confirm'),
      body: { text: payload.text, note: payload.note ?? '' },
    },
  ).then(normalizeTranscription)
}

export function rejectTranscription(
  projectId: string,
  // Same as confirm: the attempt id is only part of the caller's context.
  _attemptId: string,
  transcriptionId: string,
  note = '',
) {
  return apiRequest<unknown>(
    `/projects/${projectId}/transcriptions/${transcriptionId}/reject`,
    {
      method: 'POST',
      idempotencyKey: newIdempotencyKey('transcription-reject'),
      body: { note },
    },
  ).then(normalizeTranscription)
}

/**
 * A refused estimation/diagnosis names the photos that still need confirmation.
 * The ids are returned so the message can say **which** photos, not just "some".
 */
export function missingAssetIdsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return []
  const details = error.details as Record<string, unknown>
  for (const key of ['missing_asset_ids', 'pending_asset_ids', 'asset_ids', 'unconfirmed_asset_ids']) {
    const ids = asStringArray(details?.[key])
    if (ids.length) return ids
  }
  return []
}

/* --------------------------------------------- P1 批次 3：AI 逐点估分（B07） */
export interface AiEstimateCriterion {
  criterion_id: string
  /** Human rubric wording; empty when the payload does not carry it. */
  description: string
  max_score: string
  /** Decimal string; `null` when the model gave no estimate for this point. */
  estimated_score: string | null
  rationale: string
  missing_evidence: string[]
}

export interface AiEstimateOut {
  event_id: string
  status: string
  method: string
  /** Estimated total: `estimated_score` in the server payload. */
  estimated_total: string | null
  /** The estimate never touches the confirmed total. */
  confirmed_total_unchanged: boolean
  /** Inert until a human confirms: true means "not part of the real score". */
  is_inert: boolean
  rubric_revision: string | null
  criteria: AiEstimateCriterion[]
  overall_note: string
  confidence: number | null
  is_stub: boolean
  /** `model` in the server payload. */
  model_identifier: string
}

function decimalOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  return String(raw)
}

function normalizeEstimateCriterion(raw: unknown): AiEstimateCriterion {
  const row = (raw ?? {}) as Record<string, unknown>
  const detail = (row.detail ?? {}) as Record<string, unknown>
  return {
    criterion_id: String(row.criterion_id ?? row.part_id ?? ''),
    // The payload may describe the criterion only in `detail.text`.
    description: String(row.description ?? detail.text ?? ''),
    max_score: decimalOrNull(row.max_score) ?? '',
    estimated_score: decimalOrNull(row.estimated_score),
    rationale: String(row.rationale ?? ''),
    missing_evidence: asStringArray(row.missing_evidence),
  }
}

/**
 * Accepts both shapes the estimate endpoints use: the flat estimate payload and
 * the `{has_estimate, estimate, message}` wrapper of the GET.
 */
export function normalizeAiEstimate(payload: unknown): AiEstimateOut | null {
  if (!payload || typeof payload !== 'object') return null
  const outer = payload as Record<string, unknown>
  if (outer.has_estimate === false) return null
  const row = (outer.estimate && typeof outer.estimate === 'object' ? outer.estimate : outer) as Record<
    string,
    unknown
  >
  if (!Object.keys(row).length) return null
  const criteria = Array.isArray(row.criteria) ? row.criteria.map(normalizeEstimateCriterion) : []
  return {
    event_id: String(row.event_id ?? row.grade_event_id ?? ''),
    status: String(row.status ?? ''),
    method: String(row.method ?? ''),
    estimated_total: decimalOrNull(row.estimated_total ?? row.estimated_score),
    confirmed_total_unchanged: row.confirmed_total_unchanged !== false,
    // The server marks the estimate inert; `is_inert` is never assumed false.
    is_inert: row.is_inert !== false,
    rubric_revision: decimalOrNull(row.rubric_revision ?? row.rubric_version_id),
    criteria,
    overall_note: String(row.overall_note ?? ''),
    confidence: asNumberOrNull(row.confidence),
    is_stub: Boolean(row.is_stub),
    model_identifier: String(row.model_identifier ?? row.model ?? ''),
  }
}

/** The latest estimate for an attempt, or `null` when none was ever requested. */
export async function fetchAiEstimate(projectId: string, attemptId: string) {
  try {
    const payload = await apiRequest<unknown>(`/projects/${projectId}/attempts/${attemptId}/ai-estimate`)
    return normalizeAiEstimate(payload)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export function requestAiEstimate(projectId: string, attemptId: string) {
  return apiRequest<unknown>(`/projects/${projectId}/attempts/${attemptId}/ai-estimate`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('ai-estimate'),
  }).then(normalizeAiEstimate)
}

/* ------------------------------------------- P1 批次 3：AI 诊断追问（B07） */
export interface DiagnosisCause {
  error_type: string
  /** The service stores no numeric confidence with a cause: `null` if absent. */
  confidence: number | null
  evidence: string[]
  /** `proposed` for a fresh model candidate; a human decides it. */
  status: string
}

export interface DiagnosisFollowUp {
  id: string
  question: string
  why: string
  evidence_kind: string
  status: string
}

export interface AiDiagnosisOut {
  causes: DiagnosisCause[]
  follow_up_questions: DiagnosisFollowUp[]
  missing_information: string[]
  is_stub: boolean
  note: string
}

function normalizeFollowUp(raw: unknown): DiagnosisFollowUp {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    // The service names it `follow_up_id`; `id` is accepted for parity.
    id: String(row.follow_up_id ?? row.id ?? ''),
    question: String(row.question ?? ''),
    why: String(row.why ?? ''),
    evidence_kind: String(row.evidence_kind ?? ''),
    status: String(row.status ?? 'pending'),
  }
}

export function normalizeAiDiagnosis(payload: unknown): AiDiagnosisOut {
  const row = (payload ?? {}) as Record<string, unknown>
  const causes = Array.isArray(row.causes) ? row.causes : []
  return {
    causes: causes.map((raw) => {
      const cause = (raw ?? {}) as Record<string, unknown>
      return {
        error_type: String(cause.error_type ?? 'unknown'),
        confidence: asNumberOrNull(cause.confidence),
        evidence: asStringArray(cause.evidence),
        status: String(cause.status ?? 'proposed'),
      }
    }),
    follow_up_questions: Array.isArray(row.follow_up_questions)
      ? row.follow_up_questions.map(normalizeFollowUp)
      : [],
    missing_information: asStringArray(row.missing_information),
    is_stub: Boolean(row.is_stub),
    note: String(row.note ?? ''),
  }
}

export function requestAiDiagnosis(projectId: string, attemptId: string, learnerNote = '') {
  return apiRequest<unknown>(`/projects/${projectId}/attempts/${attemptId}/ai-diagnosis`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('ai-diagnosis'),
    body: { learner_note: learnerNote },
  }).then(normalizeAiDiagnosis)
}

/** The existing human decision path; it never changes a score or a state. */
export interface DiagnosisOut {
  id: string
  attempt_id: string
  error_type: string
  origin: string
  status: string
  note: string
}

export function normalizeDiagnosisOut(raw: unknown): DiagnosisOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    // `diagnosis_id` is the service name; `id` is accepted for parity.
    id: String(row.diagnosis_id ?? row.id ?? ''),
    attempt_id: String(row.attempt_id ?? ''),
    error_type: String(row.error_type ?? ''),
    origin: String(row.origin ?? 'user'),
    status: String(row.status ?? ''),
    note: String(row.note ?? ''),
  }
}

export function setAttemptDiagnosis(
  projectId: string,
  attemptId: string,
  payload: { error_type: string; status: 'confirmed' | 'rejected' | 'proposed' | 'unknown'; note?: string },
) {
  return apiRequest<unknown>(`/projects/${projectId}/attempts/${attemptId}/diagnosis`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('diagnosis'),
    body: { error_type: payload.error_type, status: payload.status, note: payload.note ?? '' },
  }).then(normalizeDiagnosisOut)
}

export function answerDiagnosisFollowUp(projectId: string, followUpId: string, text: string) {
  return apiRequest<unknown>(`/projects/${projectId}/diagnosis-follow-ups/${followUpId}/answer`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('diagnosis-follow-up-answer'),
    body: { text },
  }).then(normalizeFollowUp)
}

export function skipDiagnosisFollowUp(projectId: string, followUpId: string) {
  return apiRequest<unknown>(`/projects/${projectId}/diagnosis-follow-ups/${followUpId}/skip`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('diagnosis-follow-up-skip'),
  }).then(normalizeFollowUp)
}

/* ------------------------------------------ P1 批次 3：经校验分段 SSE（B08） */
export interface TutorSegmentOut {
  index: number
  /** `text` | `math` | `list`: the validated block kinds the server stores. */
  kind: string
  /** Plain text for `text`, the LaTeX source for `math`, empty for `list`. */
  text: string
  /** `list` items; empty for `text` and `math`. */
  items: string[]
  digest: string
  is_stale: boolean
}

export interface TutorSegmentsOut {
  status: string
  is_stale: boolean
  stale_reason: string
  segment_count: number
  segments: TutorSegmentOut[]
}

export function normalizeTutorSegment(raw: unknown): TutorSegmentOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    index: Number(row.index ?? 0),
    kind: String(row.kind ?? ''),
    text: String(row.text ?? ''),
    items: asStringArray(row.items),
    digest: String(row.digest ?? ''),
    is_stale: Boolean(row.is_stale),
  }
}

export function normalizeTutorSegments(payload: unknown): TutorSegmentsOut {
  const row = (payload ?? {}) as Record<string, unknown>
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(row.segments)
      ? row.segments
      : Array.isArray(row.items)
        ? row.items
        : []
  return {
    status: String(row.status ?? ''),
    is_stale: Boolean(row.is_stale),
    stale_reason: String(row.stale_reason ?? ''),
    segment_count: Number(row.segment_count ?? rows.length),
    segments: rows.map(normalizeTutorSegment),
  }
}

/** Stored, already validated segments: the transcript when SSE is unavailable. */
export function fetchTutorSegments(projectId: string, jobId: string) {
  return apiRequest<unknown>(`/projects/${projectId}/tutor-jobs/${jobId}/segments`).then(
    normalizeTutorSegments,
  )
}

/**
 * SSE cannot send an `Last-Event-ID` header, so the resume point travels in the
 * query string; the backend also accepts the header for other clients.
 */
export function tutorStreamUrl(projectId: string, jobId: string, after: number | null): string {
  const params = new URLSearchParams({ op: 'tutor.stream', project_id: projectId, job_id: jobId })
  if (after !== null && Number.isFinite(after)) params.set('after', String(after))
  return `/api/acepass/stream?${params.toString()}`
}

/* ==================================================== P2 批次 1：版面（C01） */
/**
 * One page's deterministic layout diagnosis, exactly as the parser saw it.
 *
 * Nothing here is a recognition result: `is_scanned` means the page has no text
 * layer at all (no OCR was attempted), and `reading_order_reliable === false`
 * means the extractor kept the original order instead of guessing.
 */
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
export interface ContaminationEvidenceOut {
  evidence_id: string
  /** `exposure_event` or `session_item`. */
  evidence_type: string
  exposure_kind: string | null
  question_id: string
  project_id: string | null
  session_item_id: string | null
  server_time: string | null
}

export interface ExclusionReasonOut {
  code: string
  message: string
  evidence: ContaminationEvidenceOut
}

/** Why (and whether) a question can still count as strictly independent. */
export interface QuestionExposureOut {
  question_id: string
  seen: boolean
  reasons: string[]
  first_seen_at: string | null
  /** e.g. `exposure_event:external_seen`, `session_item:presented_without_submit`. */
  sources: string[]
  strict_independent_eligible: boolean
  exclusion_reasons: ExclusionReasonOut[]
}

function normalizeEvidence(raw: unknown): ContaminationEvidenceOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    evidence_id: String(row.evidence_id ?? ''),
    evidence_type: String(row.evidence_type ?? ''),
    exposure_kind: row.exposure_kind === null || row.exposure_kind === undefined ? null : String(row.exposure_kind),
    question_id: String(row.question_id ?? ''),
    project_id: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    session_item_id:
      row.session_item_id === null || row.session_item_id === undefined ? null : String(row.session_item_id),
    server_time: row.server_time === null || row.server_time === undefined ? null : String(row.server_time),
  }
}

/**
 * `null` means the payload did not carry a usable state.
 *
 * The panel then says the server returned nothing rather than defaulting to
 * "未见": an unreadable answer must never be rendered as a clean bill of health.
 */
export function normalizeExposureState(payload: unknown): QuestionExposureOut | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as Record<string, unknown>
  if (typeof row.seen !== 'boolean' && typeof row.strict_independent_eligible !== 'boolean') return null
  const eligible =
    typeof row.strict_independent_eligible === 'boolean' ? row.strict_independent_eligible : !Boolean(row.seen)
  const reasons = asStringArray(row.reasons)
  return {
    question_id: String(row.question_id ?? ''),
    seen: typeof row.seen === 'boolean' ? row.seen : !eligible,
    reasons,
    first_seen_at:
      row.first_seen_at === null || row.first_seen_at === undefined ? null : String(row.first_seen_at),
    sources: asStringArray(row.sources),
    strict_independent_eligible: eligible,
    exclusion_reasons: Array.isArray(row.exclusion_reasons)
      ? row.exclusion_reasons.map((raw) => {
          const entry = (raw ?? {}) as Record<string, unknown>
          return {
            code: String(entry.code ?? ''),
            message: String(entry.message ?? ''),
            evidence: normalizeEvidence(entry.evidence),
          }
        })
      : [],
  }
}

export function fetchQuestionExposure(projectId: string, questionId: string) {
  return apiRequest<unknown>(`/projects/${projectId}/questions/${questionId}/exposure`).then(
    normalizeExposureState,
  )
}

/**
 * The learner's own declaration (append-only ledger).
 *
 * `seen: false` is recorded as a *correction row*; it never removes the
 * contamination marker, so the UI must not present it as a reset. One fresh key
 * per attempt keeps a double click from writing two rows in one intent.
 */
export function declareQuestionExternalSeen(
  projectId: string,
  questionId: string,
  payload: { seen: boolean; note: string },
) {
  return apiRequest<unknown>(`/projects/${projectId}/questions/${questionId}/external-seen`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey(
      payload.seen ? 'question-external-seen' : 'question-external-seen-correction',
    ),
    body: { seen: payload.seen, note: payload.note },
  }).then(normalizeExposureState)
}

/**
 * The server's own sentence for a failed call, verbatim.
 *
 * `describeError` replaces `ai_not_configured` with a generic hint; the C02/C03
 * surfaces must show the server's *own* explanation instead (which provider
 * capability is missing, which sealing policy refused, which problems a 422
 * carried), so nothing here is rewritten or summarised.
 */
export function serverMessageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return '请求失败'
}

/* ============================================ P2 批次 2：封存 holdout（C03） */
/**
 * 封存（holdout）：题目与家族的保留策略。
 *
 * The server is the only judge: what `GET /sealed-content` reports is what is
 * sealed *now*, and nothing here derives a state from a local guess. Sealing is
 * an **appended policy revision**, never an edit — so a repeated click is a new
 * revision, which is exactly what the audit trail wants.
 *
 * Every write sends one fresh `Idempotency-Key`; only the endpoints that claim
 * the key consume it (family create / membership / merge, variant proposal) and
 * the others ignore the header.
 */

/** One appended policy revision and what it means right now. */
export interface SealOut {
  policy_id: string
  /** `question` or `family`. */
  target: string
  question_id: string | null
  family_id: string | null
  revision: number
  is_holdout: boolean
  change_reason: string
  changed_at: string
  /**
   * Whether this revision leaves **any** question sealed, resolved through the
   * server's sealing service. A family with no members reports `false` here even
   * though the family itself is sealed — the family's own state comes from the
   * family list (`FamilyOut.sealed`), never from this field.
   */
  sealed: boolean
  sealed_reason: string
  sealed_question_ids: string[]
}

/** One sealed question with the policy revision that sealed it. */
export interface SealedContentQuestionRow {
  question_id: string
  display_label: string
  subject_id: string
  family_id: string | null
  family_name: string
  /** `sealed_question_policy` or `sealed_family_policy`. */
  reason_code: string
  /** The server's own sentence for that code. */
  reason_message: string
  policy_id: string | null
  policy_revision: number | null
  policy_target: string | null
  change_reason: string
  changed_at: string | null
}

/** One sealed family (an empty family can be sealed too). */
export interface SealedContentFamilyRow {
  family_id: string
  name: string
  subject_id: string | null
  reason_code: string
  reason_message: string
  policy_id: string
  policy_revision: number | null
  change_reason: string
  changed_at: string | null
  question_ids: string[]
}

export interface SealedContentOut {
  project_id: string
  questions: SealedContentQuestionRow[]
  families: SealedContentFamilyRow[]
  counts: { questions: number; question_versions: number; families: number }
  reason_codes: string[]
  generated_at: string
}

function normalizeSealedQuestionRow(raw: unknown): SealedContentQuestionRow {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    question_id: String(row.question_id ?? ''),
    display_label: String(row.display_label ?? ''),
    subject_id: String(row.subject_id ?? ''),
    family_id: row.family_id === null || row.family_id === undefined ? null : String(row.family_id),
    family_name: String(row.family_name ?? ''),
    reason_code: String(row.reason_code ?? ''),
    reason_message: String(row.reason_message ?? ''),
    policy_id: row.policy_id === null || row.policy_id === undefined ? null : String(row.policy_id),
    policy_revision: asNumberOrNull(row.policy_revision),
    policy_target: row.policy_target === null || row.policy_target === undefined ? null : String(row.policy_target),
    change_reason: String(row.change_reason ?? ''),
    changed_at: row.changed_at === null || row.changed_at === undefined ? null : String(row.changed_at),
  }
}

function normalizeSealedFamilyRow(raw: unknown): SealedContentFamilyRow {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    family_id: String(row.family_id ?? ''),
    name: String(row.name ?? ''),
    subject_id: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id),
    reason_code: String(row.reason_code ?? ''),
    reason_message: String(row.reason_message ?? ''),
    policy_id: String(row.policy_id ?? ''),
    policy_revision: asNumberOrNull(row.policy_revision),
    change_reason: String(row.change_reason ?? ''),
    changed_at: row.changed_at === null || row.changed_at === undefined ? null : String(row.changed_at),
    question_ids: asStringArray(row.question_ids),
  }
}

/** Normalized so a missing shape is visibly empty instead of `undefined` in the UI. */
export function normalizeSealedContent(payload: unknown): SealedContentOut | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as Record<string, unknown>
  const counts = (row.counts ?? {}) as Record<string, unknown>
  return {
    project_id: String(row.project_id ?? ''),
    questions: Array.isArray(row.questions) ? row.questions.map(normalizeSealedQuestionRow) : [],
    families: Array.isArray(row.families) ? row.families.map(normalizeSealedFamilyRow) : [],
    counts: {
      questions: asNumberOrNull(counts.questions) ?? 0,
      question_versions: asNumberOrNull(counts.question_versions) ?? 0,
      families: asNumberOrNull(counts.families) ?? 0,
    },
    reason_codes: asStringArray(row.reason_codes),
    generated_at: String(row.generated_at ?? ''),
  }
}

export function sealQuestion(projectId: string, questionId: string, reason: string) {
  return apiRequest<SealOut>(`/projects/${projectId}/questions/${questionId}/seal`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('question-seal'),
    body: { reason },
  })
}

export function unsealQuestion(projectId: string, questionId: string, reason: string) {
  return apiRequest<SealOut>(`/projects/${projectId}/questions/${questionId}/unseal`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('question-unseal'),
    body: { reason },
  })
}

export function sealQuestionFamily(projectId: string, familyId: string, reason: string) {
  return apiRequest<SealOut>(`/projects/${projectId}/question-families/${familyId}/seal`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('family-seal'),
    body: { reason },
  })
}

export function unsealQuestionFamily(projectId: string, familyId: string, reason: string) {
  return apiRequest<SealOut>(`/projects/${projectId}/question-families/${familyId}/unseal`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('family-unseal'),
    body: { reason },
  })
}

/**
 * What is sealed in this project and why.
 *
 * The endpoint is **project-scoped** (it takes no `subject_id`): the UI filters
 * the returned rows by subject for display instead of asking the server for a
 * narrower answer it cannot give.
 */
export function fetchSealedContent(projectId: string): Promise<SealedContentOut | null> {
  return apiRequest<unknown>(`/projects/${projectId}/sealed-content`).then(normalizeSealedContent)
}

/* ======================================== P2 批次 2：题目家族与合并（C03） */
/** One family as the server reports it (membership is a count, not a list). */
export interface QuestionFamilyOut {
  id: string
  subject_id: string
  name: string
  revision: number
  relation_confirmed: boolean
  note: string
  member_count: number
  /** The family's own latest policy revision says holdout. */
  sealed: boolean
  /** `sealed_family_policy` when `sealed`, otherwise empty. */
  sealed_reason: string
  /**
   * Members sealed by any policy (the family's or their own): a partially
   * sealed family stays visible instead of looking untouched.
   */
  sealed_member_count: number
  merged_into_id: string | null
  merged_at: string | null
}

export interface FamilyQuestionOut {
  family_id: string
  question_id: string
  changed: boolean
  member_count: number
  sealed: boolean
  sealed_reason: string
}

/** The merge preview: the counts a human compares with the outcome. */
export interface FamilyMergeImpactOut {
  project_id: string
  source_family_id: string
  target_family_id: string
  source_family_name: string
  target_family_name: string
  already_merged: boolean
  questions_to_move: number
  questions_in_target_after: number
  evidence_rows_to_invalidate: number
  affected_user_ids: string[]
  exposed_before_merge: number
  exposed_after_merge: number
  exposed_question_ids_before_merge: string[]
}

export interface FamilyMergeExposureChange {
  user_id: string
  question_id: string
  seen_before: boolean
  seen_after: boolean
  reasons: string[]
}

/** The performed merge, with the same counts the preview promised. */
export interface FamilyMergeOut {
  project_id: string
  source_family_id: string
  target_family_id: string
  merge_revision: number
  questions_moved: number
  questions_in_target_after: number
  evidence_invalidated: number
  states_recomputed: number
  exposed_before_merge: number
  exposed_after_merge: number
  exposure_changes: FamilyMergeExposureChange[]
  affected_user_ids: string[]
  /** True when the same merge had already happened: nothing was written. */
  noop: boolean
  content_revision_id: string | null
}

export function fetchQuestionFamilies(projectId: string, subjectId: string) {
  return apiRequest<QuestionFamilyOut[]>(
    `/projects/${projectId}/question-families?subject_id=${subjectId}`,
  )
}

export function createQuestionFamily(
  projectId: string,
  payload: { subject_id: string; name: string; note: string },
) {
  return apiRequest<QuestionFamilyOut>(`/projects/${projectId}/question-families`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('family-create'),
    body: payload,
  })
}

export function patchQuestionFamily(
  projectId: string,
  familyId: string,
  patch: { name?: string; relation_confirmed?: boolean; note?: string },
) {
  return apiRequest<QuestionFamilyOut>(`/projects/${projectId}/question-families/${familyId}`, {
    method: 'PATCH',
    idempotencyKey: newIdempotencyKey('family-patch'),
    body: patch,
  })
}

export function addQuestionToFamily(projectId: string, familyId: string, questionId: string) {
  return apiRequest<FamilyQuestionOut>(
    `/projects/${projectId}/question-families/${familyId}/questions`,
    {
      method: 'POST',
      idempotencyKey: newIdempotencyKey('family-member-add'),
      body: { question_id: questionId },
    },
  )
}

/** The one membership call the server does not guard with an idempotency key. */
export function removeQuestionFromFamily(projectId: string, familyId: string, questionId: string) {
  return apiRequest<FamilyQuestionOut>(
    `/projects/${projectId}/question-families/${familyId}/questions/${questionId}`,
    { method: 'DELETE', idempotencyKey: newIdempotencyKey('family-member-remove') },
  )
}

/** The preview a merge must show before anyone confirms it. */
export function fetchFamilyMergeImpact(projectId: string, familyId: string, targetFamilyId: string) {
  return apiRequest<FamilyMergeImpactOut>(
    `/projects/${projectId}/question-families/${familyId}/merge-impact?target_family_id=${targetFamilyId}`,
  )
}

export function mergeQuestionFamily(
  projectId: string,
  familyId: string,
  payload: { target_family_id: string; reason: string },
) {
  return apiRequest<FamilyMergeOut>(
    `/projects/${projectId}/question-families/${familyId}/merge`,
    {
      method: 'POST',
      idempotencyKey: newIdempotencyKey('family-merge'),
      body: payload,
    },
  )
}

/* ======================================= P2 批次 2：AI 变式候选（C02） */
/** One deterministic problem of a candidate (422 bodies carry the same shape). */
export interface VariantIssueOut {
  code: string
  message: string
  severity: string
  path: string
  [key: string]: unknown
}

function normalizeVariantIssue(raw: unknown): VariantIssueOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    ...row,
    code: String(row.code ?? ''),
    message: String(row.message ?? ''),
    // The server defaults to blocking when severity is absent; the UI must not
    // downgrade a problem it did not understand.
    severity: String(row.severity ?? 'blocking'),
    path: String(row.path ?? ''),
  }
}

/** One stored proposal: kept even when it failed validation (失败留候选). */
export interface VariantCandidateOut {
  candidate_id: string
  job_id: string
  status: string
  awaiting_human_review: boolean
  question_type: string | null
  review_issues: VariantIssueOut[]
  blocking_issues: VariantIssueOut[]
  /** The model's answer is a proposal: publishing still needs a human. */
  answer_needs_confirmation: boolean
  answer_source_type: string
  content_digest: string
  source_question_id: string
  source_version_id: string
  node_id: string
  llm_run_id: string
  is_stub_output: boolean
  publication_question_id: string | null
  publication_version_id: string | null
  created_at: string
}

export interface VariantValidationOut {
  requested_count: number
  count: number
  accepted: number
  rejected: number
  blocking_problem_count: number
  nothing_passed: boolean
}

export interface VariantProposeOut {
  job_id: string
  job_status: string
  project_id: string
  subject_id: string
  source_question_id: string
  source_version_id: string
  node_id: string
  node_name: string
  provider: string
  model: string
  is_stub: boolean
  prompt_version: string
  origin_type: string
  requested_count: number
  /** What the server actually generated (capped at 3). */
  count: number
  count_capped: boolean
  candidates: VariantCandidateOut[]
  validation: VariantValidationOut
  nothing_passed: boolean
  problems: VariantIssueOut[]
  /** The server's own sentences, e.g. the cap notice. Never reworded. */
  notes: string[]
}

export interface VariantJobOut {
  job_id: string
  project_id: string
  subject_id: string | null
  status: string
  input_kind: string
  extractor_version: string
  progress_percent: number
  problems: VariantIssueOut[]
  candidate_count: number
  candidate_status_counts: Record<string, number>
  candidates: VariantCandidateOut[]
  created_at: string
}

export interface VariantListOut {
  count: number
  limit: number
  jobs: VariantJobOut[]
}

function normalizeVariantCandidate(raw: unknown): VariantCandidateOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    candidate_id: String(row.candidate_id ?? ''),
    job_id: String(row.job_id ?? ''),
    status: String(row.status ?? ''),
    awaiting_human_review: row.awaiting_human_review === undefined ? true : Boolean(row.awaiting_human_review),
    question_type: row.question_type === null || row.question_type === undefined ? null : String(row.question_type),
    review_issues: Array.isArray(row.review_issues) ? row.review_issues.map(normalizeVariantIssue) : [],
    blocking_issues: Array.isArray(row.blocking_issues) ? row.blocking_issues.map(normalizeVariantIssue) : [],
    answer_needs_confirmation:
      row.answer_needs_confirmation === undefined ? true : Boolean(row.answer_needs_confirmation),
    answer_source_type: String(row.answer_source_type ?? ''),
    content_digest: String(row.content_digest ?? ''),
    source_question_id: String(row.source_question_id ?? ''),
    source_version_id: String(row.source_version_id ?? ''),
    node_id: String(row.node_id ?? ''),
    llm_run_id: String(row.llm_run_id ?? ''),
    is_stub_output: Boolean(row.is_stub_output),
    publication_question_id:
      row.publication_question_id === null || row.publication_question_id === undefined
        ? null
        : String(row.publication_question_id),
    publication_version_id:
      row.publication_version_id === null || row.publication_version_id === undefined
        ? null
        : String(row.publication_version_id),
    created_at: String(row.created_at ?? ''),
  }
}

function normalizeVariantJob(raw: unknown): VariantJobOut {
  const row = (raw ?? {}) as Record<string, unknown>
  const statuses = (row.candidate_status_counts ?? {}) as Record<string, unknown>
  return {
    job_id: String(row.job_id ?? ''),
    project_id: String(row.project_id ?? ''),
    subject_id: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id),
    status: String(row.status ?? ''),
    input_kind: String(row.input_kind ?? ''),
    extractor_version: String(row.extractor_version ?? ''),
    progress_percent: asNumberOrNull(row.progress_percent) ?? 0,
    problems: Array.isArray(row.problems) ? row.problems.map(normalizeVariantIssue) : [],
    candidate_count: asNumberOrNull(row.candidate_count) ?? 0,
    candidate_status_counts: Object.fromEntries(
      Object.entries(statuses).map(([status, count]) => [status, asNumberOrNull(count) ?? 0]),
    ),
    candidates: Array.isArray(row.candidates) ? row.candidates.map(normalizeVariantCandidate) : [],
    created_at: String(row.created_at ?? ''),
  }
}

/**
 * Ask the configured provider for variants of one question.
 *
 * `count` above the server's cap is not clipped here: the server performs the
 * cap, says so in `notes`, and the UI shows that sentence instead of pretending
 * it was asked for the same thing.
 */
export function proposeVariants(
  projectId: string,
  payload: {
    source_question_id?: string
    source_version_id?: string
    node_id: string
    count: number
    difficulty_note: string
  },
) {
  return apiRequest<unknown>(`/projects/${projectId}/variants/propose`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('variants-propose'),
    body: payload,
  }).then((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    const validation = (row.validation ?? {}) as Record<string, unknown>
    return {
      ...(row as unknown as VariantProposeOut),
      candidates: Array.isArray(row.candidates) ? row.candidates.map(normalizeVariantCandidate) : [],
      problems: Array.isArray(row.problems) ? row.problems.map(normalizeVariantIssue) : [],
      notes: asStringArray(row.notes),
      validation: {
        requested_count: asNumberOrNull(validation.requested_count) ?? 0,
        count: asNumberOrNull(validation.count) ?? 0,
        accepted: asNumberOrNull(validation.accepted) ?? 0,
        rejected: asNumberOrNull(validation.rejected) ?? 0,
        blocking_problem_count: asNumberOrNull(validation.blocking_problem_count) ?? 0,
        nothing_passed: Boolean(validation.nothing_passed),
      },
    } satisfies VariantProposeOut
  })
}

/** Variant batches of this project, newest first (payloaded as `{count, limit, jobs}`). */
export function fetchVariantJobs(projectId: string, limit = 20): Promise<VariantListOut> {
  return apiRequest<unknown>(`/projects/${projectId}/variants?limit=${limit}`).then((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    return {
      count: asNumberOrNull(row.count) ?? 0,
      limit: asNumberOrNull(row.limit) ?? limit,
      jobs: Array.isArray(row.jobs) ? row.jobs.map(normalizeVariantJob) : [],
    }
  })
}

/* ==================================== P2 批次 3：C05–C08 */
/**
 * 模拟考试的时钟（C05）。
 *
 * The server owns the exam clock: `exam_deadline` is written once at creation
 * and `server_time` is the instant the payload was built from. The remaining
 * time is therefore
 *
 *     deadline − server_time − (monotonic elapsed since the payload arrived)
 *
 * — the device's wall clock is read **once** (to record the offset between the
 * device and the server, for display) and never again, so moving the device
 * clock forward or backward cannot change, extend or shorten what is shown.
 * `performance.now()` is monotonic, so it is immune to wall-clock jumps.
 */
export interface ExamClockPayload {
  mode?: string | null
  status?: string | null
  server_time?: string | null
  exam_started_at?: string | null
  exam_deadline?: string | null
  expired_at?: string | null
}

export interface ExamClock {
  /** `exam_deadline` in epoch ms, or null when the payload carries none. */
  deadlineMs: number | null
  /** `server_time` in epoch ms, or null when the payload carries none. */
  serverTimeMs: number | null
  /**
   * `server_time − device wall clock`, computed once when the payload arrived.
   * Displayed for transparency; the countdown does not depend on it.
   */
  offsetMs: number | null
  /** Server-anchored remaining ms, or null when the payload cannot support one. */
  remainingMs: () => number | null
  /** The server already recorded this run as over/expired. */
  serverExpired: boolean
}

function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function createExamClock(
  payload: ExamClockPayload | null | undefined,
  monotonic: () => number = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
): ExamClock | null {
  if (!payload) return null
  const deadlineMs = parseInstant(payload.exam_deadline)
  const serverTimeMs = parseInstant(payload.server_time)
  const anchor = monotonic()
  const offsetMs = serverTimeMs === null ? null : serverTimeMs - Date.now()
  return {
    deadlineMs,
    serverTimeMs,
    offsetMs,
    remainingMs: () => {
      if (deadlineMs === null || serverTimeMs === null) return null
      return deadlineMs - serverTimeMs - (monotonic() - anchor)
    },
    serverExpired: Boolean(payload.expired_at) || payload.status === 'finished',
  }
}

/**
 * `mm:ss` (or `h:mm:ss` past an hour) for a millisecond count, clamped at zero.
 *
 * `withTenths` keeps one decimal place, which the exam countdown uses: the
 * sub-second digit makes it visible that the reading is anchored to the server's
 * deadline and the monotonic clock, not redrawn from a cached second.
 */
export function formatRemaining(ms: number | null, withTenths = false): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  const clamped = Math.max(0, ms)
  const total = Math.floor(clamped / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  const base = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
  if (!withTenths) return base
  return `${base}.${Math.floor((clamped % 1000) / 100)}`
}

/** The server's deadline as a local wall-clock label (display only). */
export function deadlineLabel(deadline: string | null | undefined): string | null {
  const parsed = parseInstant(deadline ?? null)
  if (parsed === null) return null
  return new Date(parsed).toLocaleString()
}

/** One page of published questions of a subject; the mock exam picks from these. */
export function fetchPublishedQuestions(projectId: string, subjectId: string) {
  const params = new URLSearchParams({ limit: '100', subject_id: subjectId })
  return apiRequest<QuestionListItem[]>(`/projects/${projectId}/questions?${params.toString()}`)
}

export interface MockExamCreateIn {
  subject_id: string
  question_ids: string[]
  /** 5–600, or omitted/null to let the server derive it from the published spec. */
  duration_minutes?: number | null
}

/**
 * Start a timed mock exam.
 *
 * `duration_minutes` is only sent when the learner gave one: the server refuses
 * the field on any other mode and derives the length from the published spec
 * when it is absent. One fresh `Idempotency-Key` per attempt.
 */
export function createMockExamSession(projectId: string, input: MockExamCreateIn) {
  const body: Record<string, unknown> = {
    mode: 'mock_exam',
    subject_id: input.subject_id,
    question_ids: input.question_ids,
    purpose: 'practice',
  }
  if (input.duration_minutes !== undefined && input.duration_minutes !== null) {
    body.duration_minutes = input.duration_minutes
  }
  return apiRequest<SessionOut>(`/projects/${projectId}/practice-sessions`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('mock-exam-create'),
    body,
  })
}

/** One-shot finish (交卷). The server refuses to extend an exam past its deadline. */
export function finishPracticeSession(projectId: string, sessionId: string) {
  return apiRequest<SessionOut>(`/projects/${projectId}/practice-sessions/${sessionId}/finish`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('session-finish'),
  })
}

/**
 * The server refused an answer because the exam's deadline had passed (409).
 *
 * The message is the server's own sentence (it names the deadline in the
 * server's local time); `deadline` is the same instant in ISO form.
 */
export interface ExamDeadlineRefusal {
  message: string
  deadline: string | null
  sessionId: string | null
}

export function examDeadlineRefusalOf(error: unknown): ExamDeadlineRefusal | null {
  if (!(error instanceof ApiError)) return null
  if (error.status !== 409 || error.details?.reason !== 'exam_deadline_passed') return null
  const deadline = error.details?.exam_deadline
  const sessionId = error.details?.session_id
  return {
    message: error.message,
    deadline: typeof deadline === 'string' ? deadline : null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
  }
}

/** Chinese glosses for the detail codes this app can act on; unknown codes are
 *  shown verbatim rather than guessed at. */
const API_DETAIL_LABELS: Record<string, string> = {
  reason: '原因',
  exam_deadline: '服务器截止时间',
  deadline: '服务器截止时间',
  session_id: '会话',
  attempt_id: '作答',
  question_id: '题目',
  mode: '会话用途',
  purpose: '用途',
  duration_minutes: '时长（分钟）',
  expected: '期望版本',
  actual: '当前版本',
}

const API_DETAIL_REASONS: Record<string, string> = {
  exam_deadline_passed: '已过服务器截止时间',
  grading_hidden: '判分仍在隐藏中',
  mock_exam_duration_unknown: '无法从已发布规范推导考试时长',
}

function detailText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * The server's message plus the details that carry the actionable part.
 *
 * `ApiError.message` is always surfaced verbatim; for the statuses whose
 * `details` hold the only actionable information (a deadline or a version on a
 * 409, a rejected field on a 400/422, a `reason` code, a project's `problems`)
 * the relevant entries are appended — never summarised away and never replaced
 * by a client-side guess. Other statuses keep the plain message, exactly like
 * :func:`describeError`.
 */
export function describeApiError(error: unknown): string {
  const message = serverMessageOf(error)
  if (!(error instanceof ApiError)) return message
  if (error.status !== 400 && error.status !== 409 && error.status !== 422) return message
  const rows: string[] = []
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (key === 'problems') continue
    const text = detailText(value)
    if (!text) continue
    const label = key === 'errors' ? '字段错误' : (API_DETAIL_LABELS[key] ?? key)
    if (key === 'reason') {
      rows.push(`${label}：${text}（${API_DETAIL_REASONS[text] ?? '服务器给出的原因代码'}）`)
    } else {
      rows.push(`${label}：${text}`)
    }
  }
  for (const problem of problemsOf(error)) {
    if (problem.message) rows.push(`问题：${problem.message}`)
  }
  if (!rows.length) return message
  return `${message}（${rows.join('；')}）`
}

/** C06: treat a bucket as final only when the server says every mark is confirmed. */
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

function isExpressionDetail(detail: Record<string, unknown> | undefined, reason: string): boolean {
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
