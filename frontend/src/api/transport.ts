// Transport for the typed API client: request plumbing, errors, CSRF.

export interface ApiErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
  request_id?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  readonly requestId?: string

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || '请求失败')
    this.name = 'ApiError'
    this.status = status
    this.code = body.code || 'unknown_error'
    this.details = body.details || {}
    this.requestId = body.request_id
  }

  get isPurposeBlocked(): boolean {
    return this.status === 403
  }

  get isAiUnavailable(): boolean {
    return this.code === 'ai_not_configured'
  }
}

export const BASE = '/api/v1'

export function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`))
  return match ? decodeURIComponent(match[2]) : null
}

export let csrfReady: Promise<void> | null = null

export async function ensureCsrf(): Promise<void> {
  if (readCookie('csrftoken')) return
  if (!csrfReady) {
    csrfReady = fetch(`${BASE}/auth/csrf`, { credentials: 'same-origin' })
      .then(() => undefined)
      .finally(() => {
        csrfReady = null
      })
  }
  return csrfReady
}

export function newIdempotencyKey(scope: string): string {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  return `${scope}:${random}`
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  formData?: FormData
  signal?: AbortSignal
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') {
    await ensureCsrf()
    const token = readCookie('csrftoken')
    if (token) headers['X-CSRFToken'] = token
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  let body: BodyInit | undefined
  if (options.formData) {
    body = options.formData
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body,
    credentials: 'same-origin',
    signal: options.signal,
  })
  const text = await response.text()
  const payload = text ? safeJson(text) : null
  if (!response.ok) {
    const envelope = (payload as { error?: ApiErrorBody } | null)?.error
    throw new ApiError(
      response.status,
      envelope || { code: 'http_error', message: `请求失败（HTTP ${response.status}）` },
    )
  }
  return payload as T
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Domain types (mirrors the server DTOs; answers are never part of a stem DTO)
// ---------------------------------------------------------------------------
