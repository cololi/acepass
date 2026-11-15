/**
 * A small router that speaks the wire contract the Django API already published.
 *
 * DSH hands a plugin exact Fetch routes (`ctx.connection.fetch.register`), one path per route, and
 * expects a `Response`. This module is the transport only: it matches, parses JSON, maps domain
 * errors onto `{error:{code,message,details,request_id}}`, and never touches business rules.
 *
 * The envelope and status codes come from `services/errors.ts`, which is a port of
 * `apps/common/errors.py`, so a client that reads `error.code` keeps working.
 */
import type { DatabaseSync } from 'node:sqlite'

import { AcePassError, toErrorEnvelope } from '../services/errors.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { Decimal } from '../domain/decimal.ts'

export interface RouteContext {
  db: DatabaseSync
  /** The single workspace owner: the plugin runs single-user (03 §0 D-2). */
  userId: string
  now: Instant
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  /** Text fields of a `multipart/form-data` body; a repeated field keeps the last value. */
  form: Record<string, string>
  /** File parts of a `multipart/form-data` body, in the order the client sent them. */
  files: UploadedFile[]
  headers: Headers
  requestId: string
}

/** One file part of a multipart body, buffered in memory. */
export interface UploadedFile {
  /** The form field name (`file`, `files`, …). */
  field: string
  /** The client's filename, unsanitised: it is display metadata, never a path. */
  filename: string
  /** The part's declared content type, lower-cased; `''` when the client omitted it. */
  contentType: string
  bytes: Uint8Array
}

/**
 * A handler returns either a domain value (JSON 200), `{status, body}` (JSON with a status), or a
 * `Response` for the endpoints that do not speak JSON: O02 streams private bytes with its own
 * headers, and the envelope/`content-type` of that response are part of its contract.
 */
export type RouteResult = Response | { status?: number; body: unknown } | unknown


export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  /** `/api/acepass/projects/:project_id/subjects` — `:name` captures one segment. */
  pattern: string
  handler: (ctx: RouteContext) => RouteResult | Promise<RouteResult>
}

interface CompiledRoute extends Route {
  regex: RegExp
  paramNames: string[]
}

function compile(route: Route): CompiledRoute {
  const paramNames: string[] = []
  const source = route.pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      paramNames.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { ...route, regex: new RegExp(`^${source}$`), paramNames }
}

export interface HttpOptions {
  db: DatabaseSync
  /** Resolves the acting user for a request. Single-user mode returns the workspace owner. */
  actor: () => { userId: string; now: Instant }
  routes: readonly Route[]
  /** Injected so tests can make request ids deterministic. */
  newRequestId?: () => string
}

export type FetchHandler = (request: Request) => Promise<Response>

/**
 * Domain value → JSON.
 *
 * Services return domain values (`Instant`, `Decimal`), and `JSON.stringify` throws on the first and
 * would explode the second into its internal fields. The wire form is defined by the codec: an
 * instant is ISO-8601 text with an offset, a decimal is its string. A `BigInt` here is always an
 * `Instant` — identifiers are strings and counters are numbers — which is why formatting it as an
 * instant is safe rather than a guess.
 */
export function toWireJson(value: unknown): unknown {
  if (typeof value === 'bigint') return formatPythonIso(value as Instant)
  if (value instanceof Decimal) return value.toString()
  if (Array.isArray(value)) return value.map((item) => toWireJson(item))
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return [...value]
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toWireJson(item)
    return out
  }
  return value
}

function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(toWireJson(body)), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': requestId,
      // Django's SecurityMiddleware (`SECURE_CONTENT_TYPE_NOSNIFF`) adds this to **every** response,
      // including errors; probe P22/P24/P26 confirm it. A JSON body cannot be sniffed into HTML, but
      // the header is part of the observed contract and costs nothing.
      'x-content-type-options': 'nosniff',
    },
  })
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.trim() === '') return undefined
  return JSON.parse(text)
}

/**
 * Read a multipart body into text fields + buffered file parts.
 *
 * Why this exists at all: four ingestion operations (O01/O05/O08 and later O09) take
 * `UploadedFile`, and the Django baseline reads `request.FILES`/`request.POST`. DSH hands the plugin
 * a Fetch `Request`, so the transport has to decode the same body shape. `request.formData()` is the
 * platform parser (it validates the boundary and the part headers), and each part is copied into
 * memory because every downstream consumer needs the bytes twice: once for the SHA-256 fingerprint
 * and once for the re-encode/store step.
 *
 * A repeated text field keeps the **last** value, matching Django's `request.POST.get()`.
 */
export async function readMultipartBody(
  request: Request,
): Promise<{ form: Record<string, string>; files: UploadedFile[] }> {
  const parsed = await request.formData()
  const form: Record<string, string> = {}
  const files: UploadedFile[] = []
  for (const [field, value] of parsed.entries()) {
    if (typeof value === 'string') {
      form[field] = value
      continue
    }
    const bytes = new Uint8Array(await value.arrayBuffer())
    files.push({
      field,
      filename: value.name,
      contentType: (value.type ?? '').toLowerCase(),
      bytes,
    })
  }
  return { form, files }
}

/** Attach the request id to a `Response` a handler built itself, without touching its body. */
function withRequestId(response: Response, requestId: string): Response {
  if (response.headers.has('x-request-id')) return response
  const headers = new Headers(response.headers)
  headers.set('x-request-id', requestId)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}


export function createFetchHandler(options: HttpOptions): FetchHandler {
  const compiled = options.routes.map(compile)
  let counter = 0
  const nextRequestId = options.newRequestId ?? (() => `req-${++counter}`)

  return async (request: Request): Promise<Response> => {
    const requestId = nextRequestId()
    const url = new URL(request.url)
    const route = compiled.find(
      (candidate) => candidate.method === request.method && candidate.regex.test(url.pathname),
    )
    if (route === undefined) {
      const envelope = toErrorEnvelope(new AcePassError('路径不存在'), requestId)
      return jsonResponse({ ...envelope.body, error: { ...envelope.body.error, code: 'not_found', message: '路径不存在' } }, 404, requestId)
    }

    const match = route.regex.exec(url.pathname)!
    const params: Record<string, string> = {}
    route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1])
    })

    let body: unknown
    let form: Record<string, string> = {}
    let files: UploadedFile[] = []
    const contentType = (request.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.startsWith('multipart/form-data')) {
      try {
        const multipart = await readMultipartBody(request)
        form = multipart.form
        files = multipart.files
      } catch {
        return jsonResponse(
          toErrorEnvelope(new AcePassError('请求体不是合法的 multipart 表单'), requestId).body,
          400,
          requestId,
        )
      }
    } else {
      try {
        body = await readJsonBody(request)
      } catch {
        return jsonResponse(
          toErrorEnvelope(new AcePassError('请求体不是合法 JSON'), requestId).body,
          400,
          requestId,
        )
      }
    }

    const actor = options.actor()
    try {
      const result = await route.handler({
        db: options.db,
        userId: actor.userId,
        now: actor.now,
        params,
        query: url.searchParams,
        body,
        form,
        files,
        headers: request.headers,
        requestId,
      })
      // A handler that built its own response (O02's byte stream) keeps every header it set.
      if (result instanceof Response) return withRequestId(result, requestId)
      const wrapped = result as { status?: number; body?: unknown }
      if (wrapped !== null && typeof wrapped === 'object' && 'body' in wrapped && 'status' in wrapped) {
        return jsonResponse(wrapped.body, wrapped.status ?? 200, requestId)
      }
      return jsonResponse(result, 200, requestId)
    } catch (error) {
      const envelope = toErrorEnvelope(error, requestId)
      // The wire never carries a stack, but a bare "internal_error" is undebuggable from the server
      // side alone. `details.cause` is only present for unexpected errors, and only in development.
      if (envelope.status >= 500 && process.env.ACEPASS_DEBUG_ERRORS === '1') {
        return jsonResponse(
          { ...envelope.body, error: { ...envelope.body.error, details: { cause: String((error as Error)?.stack ?? error) } } },
          envelope.status,
          requestId,
        )
      }
      return jsonResponse(envelope.body, envelope.status, requestId)
    }
  }
}
