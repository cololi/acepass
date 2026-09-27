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
  const params = new URLSearchParams()
  if (after !== null && Number.isFinite(after)) params.set('after', String(after))
  const suffix = params.toString()
  return `${BASE}/projects/${projectId}/tutor-jobs/${jobId}/stream${suffix ? `?${suffix}` : ''}`
}
