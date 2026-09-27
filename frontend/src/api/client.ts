/**
 * Typed API client.
 *
 * Same-origin session auth: the CSRF token is fetched once and echoed in the
 * `X-CSRFToken` header for every mutating request. Business errors keep the
 * server's `{error:{code,message,details,request_id}}` envelope so the UI can
 * show the real reason instead of a generic failure.
 */

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

let csrfReady: Promise<void> | null = null

export async function ensureCsrf(): Promise<void> {
  if (readCookie('csrftoken')) return
  if (!csrfReady) {
    csrfReady = fetch(`${BASE}/auth/csrf`, { credentials: 'same-origin' })
      .then(() => undefined)
      .finally(() => {
        csrfReady = null
      })
  }
  return csrfReady
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
  const response = await fetch(`${BASE}${path}`, {
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
  exam_deadline: string | null
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
  items: SessionItemState[]
  confirmed_score: string | null
  pending_max_score: string | null
  score_visible: boolean
  score_hidden_reason?: string | null
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

export interface ReportOut {
  report_kind: string
  calculation_version: string
  as_of: string
  project_id: string
  subject_id: string | null
  totals: Record<string, { attempts: number; confirmed_score: string; max_score: string; pending_max_score: string; confirmed_fraction: string | null }>
  by_question_type: Record<string, { attempts: number; confirmed_score: string; max_score: string; pending_max_score: string; confirmed_fraction: string | null }>
  by_knowledge_node: Record<string, { attempts: number; confirmed_score: string; max_score: string; confirmed_fraction: string | null; node_name: string; weight: string }>
  excluded_evidence: Array<{ attempt_id: string; dimension: string; reasons: string[]; node_id: string | null }>
  notes: string[]
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
  created_at: string
}

export interface CandidateOut {
  id: string
  job_id: string
  subject_id: string | null
  status: string
  revision: number
  review_issues: Array<{ code: string; message: string; severity: string }>
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
