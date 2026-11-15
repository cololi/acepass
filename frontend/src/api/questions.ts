// Sealing and question-family API.

import { asNumberOrNull, asStringArray } from './normalize'
import { apiRequest, newIdempotencyKey } from './transport'

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

export function normalizeSealedQuestionRow(raw: unknown): SealedContentQuestionRow {
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

export function normalizeSealedFamilyRow(raw: unknown): SealedContentFamilyRow {
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
