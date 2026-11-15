// Practice session API: exam clock, published questions, mock exams.

import { ApiError, apiRequest, newIdempotencyKey } from './transport'
import { QuestionListItem, SessionOut } from './types/study'

export interface ExamClockPayload {
  mode?: string | null
  status?: string | null
  server_time?: string | null
  exam_started_at?: string | null
  exam_deadline?: string | null
  expired_at?: string | null
}

export interface ExamClock {
  /** `exam_deadline` in epoch ms, or null when the payload carries none. */
  deadlineMs: number | null
  /** `server_time` in epoch ms, or null when the payload carries none. */
  serverTimeMs: number | null
  /**
   * `server_time − device wall clock`, computed once when the payload arrived.
   * Displayed for transparency; the countdown does not depend on it.
   */
  offsetMs: number | null
  /** Server-anchored remaining ms, or null when the payload cannot support one. */
  remainingMs: () => number | null
  /** The server already recorded this run as over/expired. */
  serverExpired: boolean
}

export function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function createExamClock(
  payload: ExamClockPayload | null | undefined,
  monotonic: () => number = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
): ExamClock | null {
  if (!payload) return null
  const deadlineMs = parseInstant(payload.exam_deadline)
  const serverTimeMs = parseInstant(payload.server_time)
  const anchor = monotonic()
  const offsetMs = serverTimeMs === null ? null : serverTimeMs - Date.now()
  return {
    deadlineMs,
    serverTimeMs,
    offsetMs,
    remainingMs: () => {
      if (deadlineMs === null || serverTimeMs === null) return null
      return deadlineMs - serverTimeMs - (monotonic() - anchor)
    },
    serverExpired: Boolean(payload.expired_at) || payload.status === 'finished',
  }
}

/**
 * `mm:ss` (or `h:mm:ss` past an hour) for a millisecond count, clamped at zero.
 *
 * `withTenths` keeps one decimal place, which the exam countdown uses: the
 * sub-second digit makes it visible that the reading is anchored to the server's
 * deadline and the monotonic clock, not redrawn from a cached second.
 */
export function formatRemaining(ms: number | null, withTenths = false): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  const clamped = Math.max(0, ms)
  const total = Math.floor(clamped / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  const base = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
  if (!withTenths) return base
  return `${base}.${Math.floor((clamped % 1000) / 100)}`
}

/** The server's deadline as a local wall-clock label (display only). */
export function deadlineLabel(deadline: string | null | undefined): string | null {
  const parsed = parseInstant(deadline ?? null)
  if (parsed === null) return null
  return new Date(parsed).toLocaleString()
}

/** One page of published questions of a subject; the mock exam picks from these. */
export function fetchPublishedQuestions(projectId: string, subjectId: string) {
  const params = new URLSearchParams({ limit: '100', subject_id: subjectId })
  return apiRequest<QuestionListItem[]>(`/projects/${projectId}/questions?${params.toString()}`)
}

export interface MockExamCreateIn {
  subject_id: string
  question_ids: string[]
  /** 5–600, or omitted/null to let the server derive it from the published spec. */
  duration_minutes?: number | null
}

/**
 * Start a timed mock exam.
 *
 * `duration_minutes` is only sent when the learner gave one: the server refuses
 * the field on any other mode and derives the length from the published spec
 * when it is absent. One fresh `Idempotency-Key` per attempt.
 */
export function createMockExamSession(projectId: string, input: MockExamCreateIn) {
  const body: Record<string, unknown> = {
    mode: 'mock_exam',
    subject_id: input.subject_id,
    question_ids: input.question_ids,
    purpose: 'practice',
  }
  if (input.duration_minutes !== undefined && input.duration_minutes !== null) {
    body.duration_minutes = input.duration_minutes
  }
  return apiRequest<SessionOut>(`/projects/${projectId}/practice-sessions`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('mock-exam-create'),
    body,
  })
}

/** One-shot finish (交卷). The server refuses to extend an exam past its deadline. */
export function finishPracticeSession(projectId: string, sessionId: string) {
  return apiRequest<SessionOut>(`/projects/${projectId}/practice-sessions/${sessionId}/finish`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey('session-finish'),
  })
}

/**
 * The server refused an answer because the exam's deadline had passed (409).
 *
 * The message is the server's own sentence (it names the deadline in the
 * server's local time); `deadline` is the same instant in ISO form.
 */
export interface ExamDeadlineRefusal {
  message: string
  deadline: string | null
  sessionId: string | null
}

export function examDeadlineRefusalOf(error: unknown): ExamDeadlineRefusal | null {
  if (!(error instanceof ApiError)) return null
  if (error.status !== 409 || error.details?.reason !== 'exam_deadline_passed') return null
  const deadline = error.details?.exam_deadline
  const sessionId = error.details?.session_id
  return {
    message: error.message,
    deadline: typeof deadline === 'string' ? deadline : null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
  }
}

/** Chinese glosses for the detail codes this app can act on; unknown codes are
 *  shown verbatim rather than guessed at. */
