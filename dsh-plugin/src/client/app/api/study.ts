import { apiRequest, newIdempotencyKey, ApiError } from './client'
import type { PresentationOut, GradeOut } from './client'

export type RecallRating = 'again' | 'hard' | 'good' | 'easy'
export interface NodeMemoryOut {
  node_id: string; node_name: string; modality: string; phase: string
  stability: number; difficulty: number; due_at: string | null; last_recall_at: string | null
  reps: number; lapses: number; learning_step: number; retrievability: number | null
  desired_retention: number; is_suspended: boolean; suspended_reason: string
  scheduler_version: string; params_version: string; is_due: boolean
}
export interface RecallCoverage { covered: string[]; missing: string[]; cannot_judge: string[]; coverage: number | null }
export interface RecallEventOut {
  event_id: string; node_id: string; rating: string; source: string; kind: string
  is_spaced: boolean; early_review: boolean; memory_updated: boolean; coverage: RecallCoverage
  reviewed_at: string; due_at: string | null; interval_days: number; stability: number
  difficulty: number; retrievability: number | null; memory: NodeMemoryOut | null; notes: string[]
}
export interface KeyPoint { id: string; text: string; required: boolean }
export interface NodeCardOut {
  card_id: string; node_id: string; node_name: string; syllabus_version_id: string
  revision: number; is_current: boolean; status: string; origin: string
  blocks: Record<string, unknown>[]; key_points: KeyPoint[]; citations: string[]; source_note: string
  model_run_id: string | null; confirmed_at: string | null; created_at: string
}
export interface SessionStepOut {
  ordinal: number; stage: string; kind: string; status: string; node_id: string | null
  node_name: string; question_id: string | null; question_label: string; session_item_id: string | null
  estimated_minutes: number; hint_level: number; confidence_before: number | null
  outcome: string; reason_codes: string[]; deadline_at: string | null
  started_at: string | null; finished_at: string | null; payload: Record<string, unknown>
}
export interface SessionOut {
  session_id: string; project_id: string; subject_id: string; mode: string; status: string; stage: string
  budget_minutes: number; estimated_minutes: number; practice_session_id: string | null
  started_at: string | null; finished_at: string | null; steps: SessionStepOut[]
  current_step_ordinal: number | null; notes: string[]; summary: Record<string, unknown> | null
}
export interface StudyDeskOut {
  project_id: string; subject_id: string; subject_name: string; date: string; budget_minutes: number
  session: SessionOut | null
  due_memory: Array<{ node_id: string; node_name: string; value_index: number | null; retrievability: number | null; due_at: string | null; appearances: number; cycles_present: number; counted_cycles: number; reason_codes: string[] }>
  value_nodes: Array<{ node_id: string; node_name: string; path: string; value_index: number | null; status: string; appearances: number; cycles_present: number; counted_cycles: number; share_avg: string | null; last_seen_cycle: string | null; memory: NodeMemoryOut | null; ability_summary: string | null; card_status: string | null; reason_codes: string[] }>
  weak_nodes: Array<{ node_id: string; node_name: string; ability_summary: string; needs_review: boolean; value_index: number | null; reason_codes: string[] }>
  coverage: { nodes_total: number; nodes_with_memory: number; nodes_due: number; nodes_never_diagnosed: number }
  ai: { configured: boolean; coach_available: boolean; message: string }; notes: string[]; rule_version: string
}
export interface FrequencyProfile {
  node_id: string; node_name: string; path: string; subject_id: string; horizon: number; status: string
  counted_cycles: number; used_cycles: string[]; appearances: number; cycles_present: number
  share_avg: string | null; share_max: string | null; marks_avg: string | null; recency_index: string | null
  trend: string | null; value_index: string | null; question_types: Record<string, number>; last_seen_cycle: string | null
  cycles: Array<{ cycle_key: string; countable: boolean; reasons: string[]; appearances: number; marks: string; denominator: string | null; share: string | null; question_types: Record<string, number> }>
  excluded_papers: Array<{ paper_id: string; reason: string }>; notes: string[]; rule_version: string
}
export interface CoachTurnOut {
  turn_id: string; thread_key: string; node_id: string; purpose: string; role: string; ordinal: number
  status: string; text: string; structured: Record<string, unknown>; citations: string[]; missing_information: string[]
  prompt_version: string; error_code: string | null; error_message: string | null; llm_run_id: string | null; created_at: string
}
export interface RecallStepResult {
  step: SessionStepOut
  recall: { event: RecallEventOut | null; coverage: RecallCoverage; key_points: KeyPoint[]; suggested_rating: string | null; can_confirm: boolean }
  coach_turn: CoachTurnOut | null
}
export interface AnswerStepResult { step: SessionStepOut; attempt_id: string; grade: GradeOut | null; receipt_only: boolean }
export interface HintStepResult { step: SessionStepOut; blocks: unknown[]; reveals_answer: boolean; model_used: boolean; coach_turn: CoachTurnOut | null; fallback_note: string }
export interface SubjectFrequencyOut {
  subject_id: string; subject_name: string; horizon: number; status: string; counted_cycles: number
  used_cycles: string[]; nodes: FrequencyProfile[]; coverage_gaps: Array<{ node_id: string; label: string; path: string; reason: string }>; unclassified: { appearances: number; marks: string }; notes: string[]; rule_version: string
}
const enc = encodeURIComponent
const project = (p: string) => `/projects/${enc(p)}`
const session = (p: string, s: string) => `${project(p)}/learning-sessions/${enc(s)}`
const step = (p: string, s: string, n: number) => `${session(p, s)}/steps/${n}`
const node = (p: string, n: string) => `${project(p)}/knowledge-nodes/${enc(n)}`
function post<T>(path: string, scope: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey(scope) })
}
export const fetchStudyDesk = (p: string, subject: string) => apiRequest<StudyDeskOut>(`${project(p)}/study-desk?subject_id=${enc(subject)}`)
export const createLearningSession = (p: string, body: { subject_id: string; mode: string; budget_minutes: number }) => post<SessionOut>(`${project(p)}/learning-sessions`, 'learning-create', body)
export async function fetchCurrentLearningSession(p: string, subject: string): Promise<SessionOut | null> {
  try { return await apiRequest<SessionOut | null>(`${project(p)}/learning-sessions/current?subject_id=${enc(subject)}`) }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error }
}
export const fetchLearningSession = (p: string, s: string) => apiRequest<SessionOut>(session(p, s))
export const startLearningSession = (p: string, s: string) => post<SessionOut>(`${session(p, s)}/start`, 'learning-start')
export const activateLearningStep = (p: string, s: string, n: number) => post<{ step: SessionStepOut; presentation?: PresentationOut }>(`${step(p, s, n)}/activate`, 'learning-activate')
export const completeLearningStep = (p: string, s: string, n: number) => post<{ step: SessionStepOut }>(`${step(p, s, n)}/complete`, 'learning-complete')
export const recallLearningStep = (p: string, s: string, n: number, body: { text: string; confidence_before: number; latency_ms?: number }) => post<RecallStepResult>(`${step(p, s, n)}/recall`, 'learning-recall', body)
export const confirmLearningRecall = (p: string, s: string, n: number, body: { rating: RecallRating; coverage?: RecallCoverage }) => post<{ step: SessionStepOut; event: RecallEventOut }>(`${step(p, s, n)}/recall/confirm`, 'learning-recall-confirm', body)
export const answerLearningStep = (p: string, s: string, n: number, body: { answer: Record<string, unknown>; steps?: Array<{ text: string }>; confidence: string; client_active_ms?: number; asset_ids?: string[] }) => post<AnswerStepResult>(`${step(p, s, n)}/answer`, 'learning-answer', body)
export const hintLearningStep = (p: string, s: string, n: number, level: number) => post<HintStepResult>(`${step(p, s, n)}/hint`, 'learning-hint', { level })
export const skipLearningStep = (p: string, s: string, n: number, reason: string) => post<{ step: SessionStepOut }>(`${step(p, s, n)}/skip`, 'learning-skip', { reason })
export const finishLearningSession = (p: string, s: string) => post<{ session: SessionOut }>(`${session(p, s)}/finish`, 'learning-finish')
export const fetchNodeMemory = (p: string, n: string) => apiRequest<{ node_id: string; node_name: string; memory: NodeMemoryOut | null; events: RecallEventOut[]; is_due: boolean }>(`${node(p, n)}/memory`)
export const fetchNodeFrequency = (p: string, n: string, horizon = 5) => apiRequest<FrequencyProfile>(`${node(p, n)}/frequency?horizon=${horizon}`)
export const fetchNodeCard = (p: string, n: string) => apiRequest<{ card: NodeCardOut | null; revisions: NodeCardOut[] }>(`${node(p, n)}/card`)
export const createNodeCard = (p: string, n: string, body: Pick<NodeCardOut, 'blocks' | 'key_points' | 'citations' | 'source_note'>) => post<NodeCardOut>(`${node(p, n)}/card`, 'node-card-create', body)
export const confirmNodeCard = (p: string, n: string, card_id: string) => post<NodeCardOut>(`${node(p, n)}/card/confirm`, 'node-card-confirm', { card_id })
export const generateNodeCard = (p: string, n: string) => post<NodeCardOut>(`${node(p, n)}/card/generate`, 'node-card-generate')
export const fetchCoachTurns = (p: string, n: string, purpose: string) => apiRequest<CoachTurnOut[]>(`${node(p, n)}/coach?purpose=${enc(purpose)}`)
export const sendCoachTurn = (p: string, n: string, body: { purpose: string; message?: string; session_id?: string; step_ordinal?: number }) => post<{ turn: CoachTurnOut; model_used: boolean; availability_reason: string }>(`${node(p, n)}/coach`, 'coach-turn', body)
export const recallNode = (p: string, n: string, body: { text?: string; confidence_before?: number; rating?: RecallRating; kind?: string }) => post<RecallEventOut>(`${node(p, n)}/recall`, 'node-recall', body)
export const fetchSubjectFrequency = (p: string, subject: string) => apiRequest<SubjectFrequencyOut>(`${project(p)}/subjects/${enc(subject)}/frequency`)
