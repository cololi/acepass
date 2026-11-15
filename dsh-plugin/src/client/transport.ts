/**
 * The browser half of the Remote channel.
 *
 * The migrated pages keep their Django-era request code (`apiRequest('/projects/...')`); only the
 * transport underneath changes. `transportFetch` turns one logical request into one POST to
 * `/api/acepass/rpc`, where the host replays it against the same router that serves the static
 * routes. Status, headers, the `{error:{code,message,details,request_id}}` envelope and idempotency
 * keys therefore survive unchanged: the pages cannot tell which transport answered.
 *
 * Multipart bodies cannot cross a JSON carrier as-is, so text fields travel as `fields` and files as
 * base64 `files`; the host rebuilds a real `FormData`, and the router's multipart parser sees the
 * same shape it sees over plain HTTP.
 */

const RPC_PATH = '/api/acepass/rpc'

/**
 * Fault injection for the browser acceptance suite.
 *
 * One acceptance case proves that a failing learning endpoint shows an error instead of an empty
 * state. Over Django it did that with `page.route(...)`, which cannot intercept a logical request
 * inside the RPC envelope; this hook is the equivalent seam. It is inert unless a test installs an
 * entry, and entries match by path substring so a spec keeps its original URL predicate.
 */
export interface AcePassFault {
  /** Substring of the logical path (`/api/v1/projects/x/review-tasks`). */
  pathContains: string
  status: number
  body?: string
  contentType?: string
}

declare global {
  interface Window {
    __acepassFaults?: AcePassFault[]
  }
}

function injectedFault(path: string): Response | undefined {
  const faults = typeof window === 'undefined' ? undefined : window.__acepassFaults
  if (faults === undefined) return undefined
  const fault = faults.find((candidate) => path.includes(candidate.pathContains))
  if (fault === undefined) return undefined
  return new Response(fault.body ?? '{}', {
    status: fault.status,
    headers: { 'content-type': fault.contentType ?? 'application/json' },
  })
}

export interface RpcResponse {
  status: number
  headers: Record<string, string>
  encoding: 'utf8' | 'base64'
  body: string
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

interface Envelope {
  method: string
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  body?: unknown
  fields?: Record<string, string>
  files?: Array<{ field: string; filename: string; contentType: string; base64: string }>
}

async function toEnvelope(input: string, init: RequestInit): Promise<Envelope> {
  const url = new URL(input, window.location.origin)
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    query[key] = values.length === 1 ? values[0] : values
  }
  const headers: Record<string, string> = {}
  new Headers(init.headers ?? {}).forEach((value, key) => {
    headers[key] = value
  })
  const envelope: Envelope = {
    method: (init.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    query,
    headers,
  }
  const body = init.body
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields: Record<string, string> = {}
    const files: NonNullable<Envelope['files']> = []
    for (const [field, value] of body.entries()) {
      if (typeof value === 'string') {
        fields[field] = value
        continue
      }
      const bytes = new Uint8Array(await value.arrayBuffer())
      files.push({ field, filename: value.name, contentType: value.type, base64: toBase64(bytes) })
    }
    if (Object.keys(fields).length > 0) envelope.fields = fields
    if (files.length > 0) envelope.files = files
  } else if (typeof body === 'string') {
    try {
      envelope.body = JSON.parse(body)
    } catch {
      envelope.body = body
    }
  } else if (body !== undefined && body !== null) {
    envelope.body = body
  }
  return envelope
}

/**
 * A `fetch` replacement for the migrated API client.
 *
 * It returns a real `Response`, so the pages' status/JSON handling is untouched; a transport-level
 * failure throws (as `fetch` does) and the caller's existing error path reports it.
 */
export async function transportFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal
  if (signal?.aborted === true) throw new DOMException('Aborted', 'AbortError')
  const fault = injectedFault(input)
  if (fault !== undefined) return fault
  const envelope = await toEnvelope(input, init)
  const response = await fetch(RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
    credentials: 'same-origin',
    ...(signal === undefined || signal === null ? {} : { signal }),
  })
  if (!response.ok) {
    // The RPC route itself failed (auth, size, malformed envelope). Surface it as an HTTP response
    // with the same status so `apiRequest`'s existing error branch reports the real reason.
    const text = await response.text()
    return new Response(text, { status: response.status, headers: response.headers })
  }
  const result = (await response.json()) as RpcResponse
  const headers = new Headers(result.headers)
  const body = result.encoding === 'base64' ? new Blob([fromBase64(result.body)]) : result.body
  return new Response(body, { status: result.status, headers })
}
