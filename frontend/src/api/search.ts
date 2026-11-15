// Search API: hybrid search and reindexing.

import { apiRequest, newIdempotencyKey } from './transport'

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
