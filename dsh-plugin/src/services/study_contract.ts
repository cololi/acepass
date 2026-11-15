/**
 * Wire and domain contract for the memory-driven learning session (M1).
 *
 * This module is **types only** so the pure domain layer, the services and the
 * client all speak the same shapes without importing each other's storage code.
 * Behaviour lives in `node_frequency.ts`, `node_memory.ts`, `node_cards.ts`,
 * `interaction.ts` and `coach.ts`; the HTTP surface is `http/studyflow_routes.ts`.
 *
 * Rule version: every payload that contains a derived number also carries the
 * rule version that produced it, because a threshold change must be visible in
 * old payloads instead of silently rewriting them.
 */

export const STUDY_RULE_VERSION = 'm1'

/* ------------------------------------------------------------------ frequency */

export type FrequencyStatus = 'ok' | 'insufficient_cycles' | 'no_real_data'

export interface FrequencyCycleRow {
  cycle_key: string
  /** Papers of this cycle that may be counted (complete, confirmed, official, non-demo). */
  countable: boolean
  /** Why the cycle cannot be used, when it cannot. */
  reasons: string[]
  /** Scored item appearances mapped to this node in this cycle. */
  appearances: number
  /** Marks attributed to this node (weight-normalised primary mapping shares). */
  marks: string
  /** Denominator actually used for the share of this cycle; null when zero. */
  denominator: string | null
  share: string | null
  question_types: Record<string, number>
}

export interface FrequencyProfile {
  node_id: string
  node_name: string
  path: string
  subject_id: string
  horizon: number
  status: FrequencyStatus
  counted_cycles: number
  used_cycles: string[]
  appearances: number
  cycles_present: number
  /** Mean mark share across cycles that had a denominator. */
  share_avg: string | null
  share_max: string | null
  marks_avg: string | null
  /** Recency-weighted presence in [0,1]; null when nothing was seen. */
  recency_index: string | null
  /** Least-squares slope of share over cycles; null with fewer than 3 data cycles. */
  trend: string | null
  /** Sorting value in [0,1]; null unless the sample is big enough to rank. */
  value_index: string | null
  question_types: Record<string, number>
  last_seen_cycle: string | null
  cycles: FrequencyCycleRow[]
  excluded_papers: Array<{ paper_id: string; reason: string }>
  notes: string[]
  rule_version: string
}

export interface SubjectFrequencyOut {
  subject_id: string
  subject_name: string
  horizon: number
  status: FrequencyStatus
  counted_cycles: number
  used_cycles: string[]
  nodes: FrequencyProfile[]
  coverage_gaps: Array<{ node_id: string; label: string; path: string; reason: string }>
  unclassified: { appearances: number; marks: string }
  notes: string[]
  rule_version: string
}

/** What the planner needs about one node; deliberately smaller than the full profile. */
export interface PlanningValue {
  node_id: string
  value_index: number | null
  status: FrequencyStatus
  appearances: number
  cycles_present: number
  counted_cycles: number
  last_seen_cycle: string | null
}

/* --------------------------------------------------------------- node memory */

export interface NodeMemoryOut {
  node_id: string
  node_name: string
  modality: string
  phase: string
  stability: number
  difficulty: number
  due_at: string | null
  last_recall_at: string | null
  reps: number
  lapses: number
  learning_step: number
  /** FSRS R(t, S) at read time; null means "never recalled here". */
  retrievability: number | null
  desired_retention: number
  is_suspended: boolean
  suspended_reason: string
  scheduler_version: string
  params_version: string
  /** Whether the node is due now (due_at <= read time). */
  is_due: boolean
}

export interface RecallCoverage {
  covered: string[]
  missing: string[]
  cannot_judge: string[]
  /** Fraction of required key points covered in [0,1]; null when there is no confirmed card. */
  coverage: number | null
}

export interface RecallEventOut {
  event_id: string
  node_id: string
  rating: string
  source: string
  kind: string
  is_spaced: boolean
  early_review: boolean
  /** False when this attempt was recorded but deliberately did not move the scheduler. */
  memory_updated: boolean
  coverage: RecallCoverage
  reviewed_at: string
  due_at: string | null
  interval_days: number
  stability: number
  difficulty: number
  retrievability: number
  memory: NodeMemoryOut | null
  notes: string[]
}

/* ------------------------------------------------------------------ node card */

export interface NodeCardKeyPoint {
  id: string
  text: string
  required: boolean
}

export interface NodeCardOut {
  card_id: string
  node_id: string
  node_name: string
  syllabus_version_id: string
  revision: number
  is_current: boolean
  status: string
  origin: string
  blocks: Array<Record<string, unknown>>
  key_points: NodeCardKeyPoint[]
  citations: string[]
  source_note: string
  model_run_id: string | null
  confirmed_at: string | null
  created_at: string
}

/* ------------------------------------------------------------------- session */

export type SessionModeName = 'daily' | 'new_learn' | 'repair' | 'exam_prep' | 'quick_recall'
export type SessionStageName = 'warmup' | 'encode' | 'practice' | 'repair' | 'transfer'
export type SessionStepKindName =
  | 'recall'
  | 'encode_read'
  | 'self_explain'
  | 'practice'
  | 'repair_brief'
  | 'repair_retest'
  | 'transfer'

export interface SessionStepOut {
  ordinal: number
  stage: SessionStageName
  kind: SessionStepKindName
  status: string
  node_id: string | null
  node_name: string
  question_id: string | null
  question_label: string
  session_item_id: string | null
  estimated_minutes: number
  hint_level: number
  confidence_before: number | null
  outcome: string
  reason_codes: string[]
  deadline_at: string | null
  started_at: string | null
  finished_at: string | null
  /** Kind-specific display data; never contains an answer. */
  payload: Record<string, unknown>
}

export interface SessionOut {
  session_id: string
  project_id: string
  subject_id: string
  mode: SessionModeName
  status: string
  stage: SessionStageName
  budget_minutes: number
  estimated_minutes: number
  practice_session_id: string | null
  started_at: string | null
  finished_at: string | null
  steps: SessionStepOut[]
  /** The step the learner should act on now, or null when the session needs finishing. */
  current_step_ordinal: number | null
  notes: string[]
  summary: Record<string, unknown> | null
}

export interface StudyDeskMemoryRow {
  node_id: string
  node_name: string
  value_index: number | null
  retrievability: number | null
  due_at: string | null
  appearances: number
  cycles_present: number
  counted_cycles: number
  reason_codes: string[]
}

export interface StudyDeskValueRow {
  node_id: string
  node_name: string
  path: string
  value_index: number | null
  status: FrequencyStatus
  appearances: number
  cycles_present: number
  counted_cycles: number
  share_avg: string | null
  last_seen_cycle: string | null
  memory: NodeMemoryOut | null
  ability_summary: string | null
  card_status: string | null
  reason_codes: string[]
}

export interface StudyDeskWeakRow {
  node_id: string
  node_name: string
  ability_summary: string
  needs_review: boolean
  value_index: number | null
  reason_codes: string[]
}

export interface StudyDeskOut {
  project_id: string
  subject_id: string
  subject_name: string
  date: string
  budget_minutes: number
  session: SessionOut | null
  due_memory: StudyDeskMemoryRow[]
  value_nodes: StudyDeskValueRow[]
  weak_nodes: StudyDeskWeakRow[]
  coverage: {
    nodes_total: number
    nodes_with_memory: number
    nodes_due: number
    nodes_never_diagnosed: number
  }
  ai: { configured: boolean; coach_available: boolean; message: string }
  notes: string[]
  rule_version: string
}

/* --------------------------------------------------------------------- coach */

export type CoachPurposeName =
  | 'recall_check'
  | 'self_explain_check'
  | 'hint'
  | 'misconception_probe'
  | 'encode_briefing'
  | 'session_reflection'

export interface CoachTurnOut {
  turn_id: string
  thread_key: string
  node_id: string
  purpose: CoachPurposeName
  role: string
  ordinal: number
  status: string
  text: string
  structured: Record<string, unknown>
  citations: string[]
  missing_information: string[]
  prompt_version: string
  error_code: string
  error_message: string
  /** The audit row of the model call, when this turn had one; null for an honest unavailable turn. */
  llm_run_id: string | null
  created_at: string
}

export interface CoachReplyOut {
  turn: CoachTurnOut
  /** Honest availability flag: false means the deterministic fallback was used. */
  model_used: boolean
  availability_reason: string
}
