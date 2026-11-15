// Knowledge API: relations, prerequisites, tag suggestions.

import { ApiError, apiRequest, newIdempotencyKey } from './transport'
import { KnowledgeRelationEdge, KnowledgeRelationGraph, NodePrerequisitesOut } from './types/records'

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
