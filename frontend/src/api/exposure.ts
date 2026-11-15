// Question exposure API: contamination evidence and declarations.

import { asStringArray } from './normalize'
import { ApiError, apiRequest, newIdempotencyKey } from './transport'

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

export function normalizeEvidence(raw: unknown): ContaminationEvidenceOut {
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
