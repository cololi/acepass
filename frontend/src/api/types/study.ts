// Account, project, question, attempt and plan DTOs.

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
