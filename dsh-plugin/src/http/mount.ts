/**
 * Mount the AcePass HTTP surface on DSH's Web transport.
 *
 * Two host facts shape this module (03 §3, verified against the running Web app):
 *
 *  1. `connection.fetch` is an **exact-path** registry: `fetchRoutes.get(url.pathname)`. A pattern
 *     with `:param` can never match, and one path owns one method set.
 *  2. An out-of-tree plugin cannot call `connection.rpc.handle()`: that path reads `webServer` from
 *     the connection service's own Context, which only the root composition injects.
 *
 * So the parameterised REST surface travels through one exact route, `/api/acepass/rpc`: the client
 * posts `{method, path, query, headers, body, files}` and the host replays it against the *same*
 * `createFetchHandler` the static routes use. The wire contract, error envelope, status codes,
 * idempotency keys and request ids are therefore the router's, not a second implementation's.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Instant } from '../domain/instant.ts'
import { createFetchHandler, type Route } from './router.ts'
import { mountStreamRoute, type StreamOperation } from './stream.ts'

/** The exact path the client posts logical HTTP requests to. */
export const RPC_PATH = '/api/acepass/rpc'
/** The exact path that carries resumable streams (NDJSON frames). */
export const STREAM_PATH = '/api/acepass/stream'
/**
 * The exact path that serves private bytes for `<img src>` / download links.
 *
 * A browser element cannot POST an RPC envelope, and the real asset path carries two identifiers, so
 * it cannot be an exact Fetch route either. This route takes both as query parameters and replays the
 * request against the real parameterised handler, which keeps every download gate (internal review,
 * sealing, editorial purpose, answer exposure) exactly where it is.
 */
export const ASSET_PATH = '/api/acepass/asset'

/** A logical request as the browser serialises it. */
export interface RpcRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Django-era path (`/api/v1/...`) or an already-prefixed AcePass path. */
  path: string
  query?: Record<string, string | string[]>
  headers?: Record<string, string>
  body?: unknown
  /** Multipart text fields (Django read them from `request.POST`). */
  fields?: Record<string, string>
  /** Multipart file parts, base64. The host rebuilds a real `FormData` body. */
  files?: Array<{ field: string; filename: string; contentType: string; base64: string }>
}

/** A logical response: JSON/text inline, binary as base64. */
export interface RpcResponse {
  status: number
  headers: Record<string, string>
  /** `utf8` for JSON/text, `base64` for bytes (O02 private media). */
  encoding: 'utf8' | 'base64'
  body: string
}

const ACEPASS_PREFIX = '/api/acepass'
const DJANGO_PREFIX = '/api/v1'

/**
 * Translate the client's path onto the mounted router.
 *
 * The frontend's request code is kept verbatim from the Django build; only the prefix moves. A path
 * that is neither the Django base nor already prefixed is rejected instead of guessed, because a
 * silent rewrite could route a request to the wrong project scope.
 */
export function logicalPath(path: string): string {
  const clean = path.split('?')[0]
  if (clean.startsWith(DJANGO_PREFIX)) return ACEPASS_PREFIX + clean.slice(DJANGO_PREFIX.length)
  if (clean.startsWith(ACEPASS_PREFIX)) return clean
  throw new Error(`unsupported request path ${JSON.stringify(path)}`)
}

/** Serialise an `RpcRequest` into the Fetch request the router already speaks. */
export function toFetchRequest(payload: RpcRequest): Request {
  const path = logicalPath(payload.path)
  const url = new URL(`http://acepass.local${path}`)
  for (const [name, value] of Object.entries(payload.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, item)
  }
  const headers = new Headers(payload.headers ?? {})
  let body: BodyInit | undefined
  if (payload.files !== undefined || payload.fields !== undefined) {
    const form = new FormData()
    for (const [name, value] of Object.entries(payload.fields ?? {})) form.append(name, value)
    for (const file of payload.files ?? []) {
      form.append(
        file.field,
        new Blob([Buffer.from(file.base64, 'base64')], { type: file.contentType }),
        file.filename,
      )
    }
    body = form
    headers.delete('content-type') // the boundary belongs to FormData
  } else if (payload.body !== undefined && payload.method !== 'GET') {
    body = JSON.stringify(payload.body)
    headers.set('content-type', 'application/json')
  }
  return new Request(url, { method: payload.method, headers, body })
}

/** Read a router response into the RPC envelope without re-encoding JSON twice. */
export async function fromFetchResponse(response: Response): Promise<RpcResponse> {
  const headers: Record<string, string> = {}
  for (const [name, value] of response.headers) headers[name] = value
  const contentType = (headers['content-type'] ?? '').toLowerCase()
  if (contentType.startsWith('application/json') || contentType.startsWith('text/')) {
    return { status: response.status, headers, encoding: 'utf8', body: await response.text() }
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { status: response.status, headers, encoding: 'base64', body: Buffer.from(bytes).toString('base64') }
}

export interface MountOptions {
  db: DatabaseSync
  userId: string
  now: () => Instant
  routes: readonly Route[]
  streams?: readonly StreamOperation[]
  /** Rejects bodies above this size; the browser never sends large JSON, uploads use base64. */
  maxBytes?: number
}

/** Build the `POST /api/acepass/rpc` handler. */
export function createRpcHandler(options: MountOptions): (request: Request) => Promise<Response> {
  const dispatch = createFetchHandler({
    db: options.db,
    routes: options.routes,
    actor: () => ({ userId: options.userId, now: options.now() }),
  })
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  return async (request: Request): Promise<Response> => {
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return Response.json(
        { error: { code: 'payload_too_large', message: '请求体超过上限', details: { max_bytes: maxBytes } } },
        { status: 413 },
      )
    }
    let payload: RpcRequest
    try {
      payload = JSON.parse(text) as RpcRequest
    } catch {
      return Response.json(
        { error: { code: 'invalid_json', message: '请求体不是合法 JSON', details: {} } },
        { status: 400 },
      )
    }
    try {
      const response = await dispatch(toFetchRequest(payload))
      return Response.json(await fromFetchResponse(response))
    } catch (error) {
      // A malformed envelope (unsupported path, bad base64) is the caller's fault, not a 500.
      return Response.json(
        {
          error: {
            code: 'invalid_request',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
        },
        { status: 400 },
      )
    }
  }
}

/**
 * Mount every exact route plus the RPC and stream routes on one connection service.
 *
 * Returns the disposers so the caller can withdraw them with the plugin fiber.
 */
export function mountAcePass(
  connection: {
    fetch: { register: (route: unknown) => () => void }
  },
  options: MountOptions,
): Array<() => void> {
  const disposers: Array<() => void> = []
  const byPath = new Map<string, Route[]>()
  for (const route of options.routes) {
    if (route.pattern.includes(':')) continue // never matchable in an exact-path registry
    if (route.pattern === RPC_PATH || route.pattern === STREAM_PATH) continue
    const list = byPath.get(route.pattern)
    if (list === undefined) byPath.set(route.pattern, [route])
    else list.push(route)
  }
  for (const [path, routes] of byPath) {
    const dispatch = createFetchHandler({
      db: options.db,
      routes,
      actor: () => ({ userId: options.userId, now: options.now() }),
    })
    disposers.push(
      connection.fetch.register({
        path,
        methods: routes.map((route) => route.method),
        requestBody: 'buffered',
        fetch: (request: Request) => dispatch(request),
      }),
    )
  }
  disposers.push(
    connection.fetch.register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createRpcHandler(options),
    }),
  )
  const assetRoutes = options.routes.filter((route) => route.pattern.endsWith('/assets/:asset_id'))
  if (assetRoutes.length > 0) {
    const assetDispatch = createFetchHandler({
      db: options.db,
      routes: assetRoutes,
      actor: () => ({ userId: options.userId, now: options.now() }),
    })
    disposers.push(
      connection.fetch.register({
        path: ASSET_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request: Request) => {
          const url = new URL(request.url)
          const projectId = url.searchParams.get('project_id') ?? ''
          const assetId = url.searchParams.get('asset_id') ?? ''
          const purpose = url.searchParams.get('purpose')
          const target = new URL(
            `http://acepass.local/api/acepass/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
          )
          if (purpose !== null) target.searchParams.set('purpose', purpose)
          const headers = new Headers(request.headers)
          headers.delete('host')
          return assetDispatch(new Request(target, { method: 'GET', headers, signal: request.signal }))
        },
      }),
    )
  }
  disposers.push(
    connection.fetch.register({
      path: STREAM_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request: Request) => mountStreamRoute(request, options.streams ?? []),
    }),
  )
  return disposers
}
