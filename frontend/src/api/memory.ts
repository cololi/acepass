// FSRS memory-card API.

import { apiRequest, newIdempotencyKey } from './transport'

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
