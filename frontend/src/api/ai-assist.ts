// AI assist API: transcription, estimation, diagnosis, tutor segments.

import { asNumberOrNull, asStringArray, decimalOrNull } from './normalize'
import { ApiError, BASE, apiRequest, newIdempotencyKey } from './transport'

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

export function normalizeTranscription(raw: unknown): TranscriptionOut {
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

export function normalizeEstimateCriterion(raw: unknown): AiEstimateCriterion {
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

export function normalizeFollowUp(raw: unknown): DiagnosisFollowUp {
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

/* ==================================================== P2 批次 1：版面（C01） */
/**
 * One page's deterministic layout diagnosis, exactly as the parser saw it.
 *
 * Nothing here is a recognition result: `is_scanned` means the page has no text
 * layer at all (no OCR was attempted), and `reading_order_reliable === false`
 * means the extractor kept the original order instead of guessing.
 */
