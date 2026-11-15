// Human-readable API error helpers.

import { serverMessageOf } from './exposure'
import { problemsOf } from './imports'
import { ApiError } from './transport'

export const API_DETAIL_LABELS: Record<string, string> = {
  reason: '原因',
  exam_deadline: '服务器截止时间',
  deadline: '服务器截止时间',
  session_id: '会话',
  attempt_id: '作答',
  question_id: '题目',
  mode: '会话用途',
  purpose: '用途',
  duration_minutes: '时长（分钟）',
  expected: '期望版本',
  actual: '当前版本',
}

export const API_DETAIL_REASONS: Record<string, string> = {
  exam_deadline_passed: '已过服务器截止时间',
  grading_hidden: '判分仍在隐藏中',
  mock_exam_duration_unknown: '无法从已发布规范推导考试时长',
}

export function detailText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * The server's message plus the details that carry the actionable part.
 *
 * `ApiError.message` is always surfaced verbatim; for the statuses whose
 * `details` hold the only actionable information (a deadline or a version on a
 * 409, a rejected field on a 400/422, a `reason` code, a project's `problems`)
 * the relevant entries are appended — never summarised away and never replaced
 * by a client-side guess. Other statuses keep the plain message, exactly like
 * :func:`describeError`.
 */
export function describeApiError(error: unknown): string {
  const message = serverMessageOf(error)
  if (!(error instanceof ApiError)) return message
  if (error.status !== 400 && error.status !== 409 && error.status !== 422) return message
  const rows: string[] = []
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (key === 'problems') continue
    const text = detailText(value)
    if (!text) continue
    const label = key === 'errors' ? '字段错误' : (API_DETAIL_LABELS[key] ?? key)
    if (key === 'reason') {
      rows.push(`${label}：${text}（${API_DETAIL_REASONS[text] ?? '服务器给出的原因代码'}）`)
    } else {
      rows.push(`${label}：${text}`)
    }
  }
  for (const problem of problemsOf(error)) {
    if (problem.message) rows.push(`问题：${problem.message}`)
  }
  if (!rows.length) return message
  return `${message}（${rows.join('；')}）`
}

/** C06: treat a bucket as final only when the server says every mark is confirmed. */
