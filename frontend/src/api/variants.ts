// AI variant proposal API.

import { asNumberOrNull, asStringArray } from './normalize'
import { apiRequest, newIdempotencyKey } from './transport'

export interface VariantIssueOut {
  code: string
  message: string
  severity: string
  path: string
  [key: string]: unknown
}

export function normalizeVariantIssue(raw: unknown): VariantIssueOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    ...row,
    code: String(row.code ?? ''),
    message: String(row.message ?? ''),
    // The server defaults to blocking when severity is absent; the UI must not
    // downgrade a problem it did not understand.
    severity: String(row.severity ?? 'blocking'),
    path: String(row.path ?? ''),
  }
}

/** One stored proposal: kept even when it failed validation (失败留候选). */
export interface VariantCandidateOut {
  candidate_id: string
  job_id: string
  status: string
  awaiting_human_review: boolean
  question_type: string | null
  review_issues: VariantIssueOut[]
  blocking_issues: VariantIssueOut[]
  /** The model's answer is a proposal: publishing still needs a human. */
  answer_needs_confirmation: boolean
  answer_source_type: string
  content_digest: string
  source_question_id: string
  source_version_id: string
  node_id: string
  llm_run_id: string
  is_stub_output: boolean
  publication_question_id: string | null
  publication_version_id: string | null
  created_at: string
}

export interface VariantValidationOut {
  requested_count: number
  count: number
  accepted: number
  rejected: number
  blocking_problem_count: number
  nothing_passed: boolean
}

export interface VariantProposeOut {
  job_id: string
  job_status: string
  project_id: string
  subject_id: string
  source_question_id: string
  source_version_id: string
  node_id: string
  node_name: string
  provider: string
  model: string
  is_stub: boolean
  prompt_version: string
  origin_type: string
  requested_count: number
  /** What the server actually generated (capped at 3). */
  count: number
  count_capped: boolean
  candidates: VariantCandidateOut[]
  validation: VariantValidationOut
  nothing_passed: boolean
  problems: VariantIssueOut[]
  /** The server's own sentences, e.g. the cap notice. Never reworded. */
  notes: string[]
}

export interface VariantJobOut {
  job_id: string
  project_id: string
  subject_id: string | null
  status: string
  input_kind: string
  extractor_version: string
  progress_percent: number
  problems: VariantIssueOut[]
  candidate_count: number
  candidate_status_counts: Record<string, number>
  candidates: VariantCandidateOut[]
  created_at: string
}

export interface VariantListOut {
  count: number
  limit: number
  jobs: VariantJobOut[]
}

export function normalizeVariantCandidate(raw: unknown): VariantCandidateOut {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    candidate_id: String(row.candidate_id ?? ''),
    job_id: String(row.job_id ?? ''),
    status: String(row.status ?? ''),
    awaiting_human_review: row.awaiting_human_review === undefined ? true : Boolean(row.awaiting_human_review),
    question_type: row.question_type === null || row.question_type === undefined ? null : String(row.question_type),
    review_issues: Array.isArray(row.review_issues) ? row.review_issues.map(normalizeVariantIssue) : [],
    blocking_issues: Array.isArray(row.blocking_issues) ? row.blocking_issues.map(normalizeVariantIssue) : [],
    answer_needs_confirmation:
      row.answer_needs_confirmation === undefined ? true : Boolean(row.answer_needs_confirmation),
    answer_source_type: String(row.answer_source_type ?? ''),
    content_digest: String(row.content_digest ?? ''),
    source_question_id: String(row.source_question_id ?? ''),
    source_version_id: String(row.source_version_id ?? ''),
    node_id: String(row.node_id ?? ''),
    llm_run_id: String(row.llm_run_id ?? ''),
    is_stub_output: Boolean(row.is_stub_output),
    publication_question_id:
      row.publication_question_id === null || row.publication_question_id === undefined
        ? null
        : String(row.publication_question_id),
    publication_version_id:
      row.publication_version_id === null || row.publication_version_id === undefined
        ? null
        : String(row.publication_version_id),
    created_at: String(row.created_at ?? ''),
  }
}

export function normalizeVariantJob(raw: unknown): VariantJobOut {
  const row = (raw ?? {}) as Record<string, unknown>
  const statuses = (row.candidate_status_counts ?? {}) as Record<string, unknown>
  return {
    job_id: String(row.job_id ?? ''),
    project_id: String(row.project_id ?? ''),
    subject_id: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id),
    status: String(row.status ?? ''),
    input_kind: String(row.input_kind ?? ''),
    extractor_version: String(row.extractor_version ?? ''),
    progress_percent: asNumberOrNull(row.progress_percent) ?? 0,
    problems: Array.isArray(row.problems) ? row.problems.map(normalizeVariantIssue) : [],
    candidate_count: asNumberOrNull(row.candidate_count) ?? 0,
    candidate_status_counts: Object.fromEntries(
      Object.entries(statuses).map(([status, count]) => [status, asNumberOrNull(count) ?? 0]),
    ),
    candidates: Array.isArray(row.candidates) ? row.candidates.map(normalizeVariantCandidate) : [],
    created_at: String(row.created_at ?? ''),
  }
}

/**
 * Ask the configured provider for variants of one question.
 *
 * `count` above the server's cap is not clipped here: the server performs the
 * cap, says so in `notes`, and the UI shows that sentence instead of pretending
 * it was asked for the same thing.
 */
export function proposeVariants(
  projectId: string,
  payload: {
    source_question_id?: string
    source_version_id?: string
    node_id: string
    count: number
    difficulty_note: string
  },
) {
  return apiRequest<unknown>(`/projects/${projectId}/variants/propose`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('variants-propose'),
    body: payload,
  }).then((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    const validation = (row.validation ?? {}) as Record<string, unknown>
    return {
      ...(row as unknown as VariantProposeOut),
      candidates: Array.isArray(row.candidates) ? row.candidates.map(normalizeVariantCandidate) : [],
      problems: Array.isArray(row.problems) ? row.problems.map(normalizeVariantIssue) : [],
      notes: asStringArray(row.notes),
      validation: {
        requested_count: asNumberOrNull(validation.requested_count) ?? 0,
        count: asNumberOrNull(validation.count) ?? 0,
        accepted: asNumberOrNull(validation.accepted) ?? 0,
        rejected: asNumberOrNull(validation.rejected) ?? 0,
        blocking_problem_count: asNumberOrNull(validation.blocking_problem_count) ?? 0,
        nothing_passed: Boolean(validation.nothing_passed),
      },
    } satisfies VariantProposeOut
  })
}

/** Variant batches of this project, newest first (payloaded as `{count, limit, jobs}`). */
export function fetchVariantJobs(projectId: string, limit = 20): Promise<VariantListOut> {
  return apiRequest<unknown>(`/projects/${projectId}/variants?limit=${limit}`).then((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    return {
      count: asNumberOrNull(row.count) ?? 0,
      limit: asNumberOrNull(row.limit) ?? limit,
      jobs: Array.isArray(row.jobs) ? row.jobs.map(normalizeVariantJob) : [],
    }
  })
}

/* ==================================== P2 批次 3：C05–C08 */
/**
 * 模拟考试的时钟（C05）。
 *
 * The server owns the exam clock: `exam_deadline` is written once at creation
 * and `server_time` is the instant the payload was built from. The remaining
 * time is therefore
 *
 *     deadline − server_time − (monotonic elapsed since the payload arrived)
 *
 * — the device's wall clock is read **once** (to record the offset between the
 * device and the server, for display) and never again, so moving the device
 * clock forward or backward cannot change, extend or shorten what is shown.
 * `performance.now()` is monotonic, so it is immune to wall-clock jumps.
 */
