/**
 * The transport seam for the DSH-migrated acceptance suite.
 *
 * The nine spec files are copied from `frontend/tests/acceptance` unchanged
 * *except* for the mechanics that no longer exist: there is no login form, app
 * routes live in a hash (`#/questions`), and every logical API call now travels
 * as one `POST /api/acepass/rpc` envelope. This module adapts exactly those
 * mechanics:
 *
 *   page.goto('/x')            -> opens the AcePass panel, navigates `#/x`
 *   page.waitForResponse(p)    -> waits for the RPC whose *logical* call matches
 *                                 `p`, and resolves a response-shaped object whose
 *                                 `.status()`/`.json()` are the logical ones
 *   page.on('request'|'response')
 *                              -> same conversion, so `watchResponses` and the
 *                                 `subject_id=` request assertions keep working
 *   page.request.get/post/...  -> the same RPC carrier, so `page.request` keeps
 *                                 its shape
 *   reload()                   -> re-opens the panel and dismisses the first-run
 *                                 dialogs the shell shows again on every load
 *
 * No `expect(...)` is rewritten by this layer: an assertion that cannot hold on
 * the DSH transport fails and is reported, it is not bent to pass.
 */
import {
  test as base,
  expect,
  type APIResponse,
  type Page,
  type Request,
  type Response,
} from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { originOf, readState, REPO, type AcceptanceState } from './state'

export { expect }
export type { Page }

const RPC_PATH = '/api/acepass/rpc'

/**
 * Every logical call the page makes is appended here by the page fixture.
 *
 * The report grades failures from evidence (`POST /x -> 404`) instead of
 * guessing from an assertion message; the file is truncated by globalSetup.
 */
export const TRACE_RUN = process.env.ACEPASS_RUN ?? 'main'
export const TRACE_FILE = path.join(REPO, 'dsh-plugin', 'var', 'acceptance', `rpc-trace-${TRACE_RUN}.jsonl`)

interface TraceEntry {
  project: string
  file: string
  title: string
  method: string
  path: string
  status: number
}

function recordTrace(entry: TraceEntry): void {
  try {
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify(entry)}\n`)
  } catch {
    /* the report is best-effort; never fail a test because the trace file is unwritable */
  }
}

interface Envelope {
  method: string
  path: string
  query?: Record<string, string | string[]>
  headers?: Record<string, string>
  body?: unknown
}

function envelopeOf(request: Request): Envelope | undefined {
  if (!request.url().endsWith(RPC_PATH)) return undefined
  const postData = request.postData()
  if (postData === null || postData === '') return undefined
  try {
    const parsed = JSON.parse(postData) as Envelope
    return typeof parsed.path === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function queryString(query: Record<string, string | string[]> | undefined): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else if (value !== undefined && value !== null) params.append(key, String(value))
  }
  return params.toString()
}

/** The URL the Django-era client would have requested: what every predicate means. */
function logicalUrl(envelope: Envelope): string {
  const search = queryString(envelope.query)
  return search === '' ? envelope.path : `${envelope.path}?${search}`
}

/** The request-shaped object handed to `predicate(response.request())`. */
function logicalRequest(envelope: Envelope) {
  const url = logicalUrl(envelope)
  return {
    url: () => url,
    method: () => envelope.method,
    headers: () => envelope.headers ?? {},
    allHeaders: async () => envelope.headers ?? {},
    postData: () => (envelope.body === undefined ? null : JSON.stringify(envelope.body)),
    postDataJSON: () => envelope.body,
    resourceType: () => 'fetch',
    isNavigationRequest: () => false,
  }
}

/** A `Response` facade over one RPC envelope: status and body are the logical ones. */
class LogicalResponse {
  readonly #status: number
  readonly #body: string
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #request: ReturnType<typeof logicalRequest>

  constructor(
    status: number,
    body: string,
    url: string,
    headers: Record<string, string>,
    request: ReturnType<typeof logicalRequest>,
  ) {
    this.#status = status
    this.#body = body
    this.#url = url
    this.#headers = headers
    this.#request = request
  }

  status(): number {
    return this.#status
  }

  ok(): boolean {
    return this.#status >= 200 && this.#status < 300
  }

  url(): string {
    return this.#url
  }

  headers(): Record<string, string> {
    return this.#headers
  }

  headerValue(name: string): string | null {
    const wanted = name.toLowerCase()
    for (const [key, value] of Object.entries(this.#headers)) {
      if (key.toLowerCase() === wanted) return value
    }
    return null
  }

  async text(): Promise<string> {
    return this.#body
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.#body)
  }

  async body(): Promise<Buffer> {
    return Buffer.from(this.#body, 'utf8')
  }

  request(): ReturnType<typeof logicalRequest> {
    return this.#request
  }

  async finished(): Promise<null> {
    return null
  }
}

/** Turn the RPC carrier response into the logical response the specs assert on. */
async function settleResponse(response: Response, envelope: Envelope): Promise<LogicalResponse> {
  const request = logicalRequest(envelope)
  const raw = await response.text().catch(() => '')
  let carrier: { status?: unknown; body?: unknown; headers?: Record<string, string> } | undefined
  try {
    carrier = JSON.parse(raw) as typeof carrier
  } catch {
    carrier = undefined
  }
  if (
    carrier !== undefined &&
    typeof carrier.status === 'number' &&
    typeof carrier.body === 'string'
  ) {
    return new LogicalResponse(carrier.status, carrier.body, logicalUrl(envelope), carrier.headers ?? {}, request)
  }
  // A transport-level failure (auth, size, malformed envelope) keeps its own status.
  return new LogicalResponse(response.status(), raw, logicalUrl(envelope), response.headers(), request)
}

type ResponsePredicate = (response: Response) => boolean

/**
 * The predicate sees a response-shaped facade: the Django-era predicates call
 * both `response.url()` and `response.request().method()`.
 */
function matches(predicate: ResponsePredicate, request: ReturnType<typeof logicalRequest>): boolean {
  const facade = {
    url: () => request.url(),
    request: () => request,
    status: () => 200,
    ok: () => true,
  }
  try {
    return predicate(facade as unknown as Response)
  } catch {
    return false
  }
}

export interface FaultInjection {
  /** Substring of the logical path, e.g. `/review-tasks`. */
  pathContains: string
  status: number
  body?: string
}

/**
 * Install one logical fault: the client's own `window.__acepassFaults` hook turns
 * the matching logical call into a real error `Response` *before* it reaches the
 * RPC carrier, which is the DSH equivalent of the old `page.route(...)` mock.
 */
export async function injectFault(page: Page, fault: FaultInjection): Promise<void> {
  await page.evaluate((entry) => {
    const existing = (window as { __acepassFaults?: unknown[] }).__acepassFaults ?? []
    ;(window as { __acepassFaults?: unknown[] }).__acepassFaults = [...existing, entry]
  }, fault)
}

export async function clearFaults(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as { __acepassFaults?: unknown[] }).__acepassFaults = undefined
  })
}

/**
 * Dismiss the shell's first-run dialogs.
 *
 * An isolated `DSH_HOME` has no model configured, so the shell shows the preview
 * notice (继续) on first load and "开始使用" (a close X) on **every** document
 * load; the latter's mask swallows pointer events until it is closed.
 */
export async function dismissDialogs(page: Page, budgetMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  let sawDialog = false
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    const count = await page.getByRole('dialog').count().catch(() => 0)
    if (count === 0) {
      if (Date.now() - quietSince > 500) return sawDialog
      await page.waitForTimeout(80)
      continue
    }
    sawDialog = true
    quietSince = Date.now()
    const dialog = page.getByRole('dialog').last()
    let clicked = false
    for (const label of ['继续', '关闭', 'Close', 'Continue', '知道了', '跳过']) {
      const button = dialog.getByRole('button', { name: label, exact: true })
      if ((await button.count().catch(() => 0)) > 0) {
        await button.first().click({ timeout: 3_000 }).catch(() => undefined)
        clicked = true
        break
      }
    }
    if (!clicked) await page.keyboard.press('Escape').catch(() => undefined)
    await page.waitForTimeout(200)
  }
  return sawDialog
}

/** Open the AcePass panel. Idempotent: a mounted panel is left alone. */
export async function ensurePanelOpen(page: Page): Promise<void> {
  if ((await page.locator('.context-strip').count()) > 0) return
  await dismissDialogs(page, 2_000)
  // On a narrow viewport the DSH shell collapses the sidebar behind a button.
  const entry = page.getByRole('button', { name: 'AcePass', exact: true }).first()
  if (!(await entry.isVisible().catch(() => false))) {
    const openSidebar = page.getByRole('button', { name: '打开侧边栏' }).first()
    if ((await openSidebar.count().catch(() => 0)) > 0) {
      await openSidebar.click({ timeout: 5_000 }).catch(() => undefined)
      await page.waitForTimeout(250)
    }
  }
  await expect(entry).toBeVisible({ timeout: 30_000 })
  await entry.click()
  await page.locator('.context-strip').first().waitFor({ state: 'visible', timeout: 30_000 })
  await dismissDialogs(page, 1_200)
}

function instrument(raw: Page, state: AcceptanceState): Page {
  const origin = originOf(state)

  async function ensurePanel(): Promise<void> {
    await ensurePanelOpen(raw)
  }

  async function afterDocumentLoad(): Promise<void> {
    // The shell is a SPA: wait until its sidebar exists before talking to it.
    await raw
      .getByRole('button', { name: 'AcePass', exact: true })
      .first()
      .waitFor({ state: 'attached', timeout: 30_000 })
      .catch(() => undefined)
    await dismissDialogs(raw, 3_000)
    await ensurePanelOpen(raw)
  }

  /* ------------------------------------------------------------ navigate */
  async function goto(target: string, options?: Parameters<Page['goto']>[1]) {
    if (/^https?:\/\//i.test(target)) {
      const response = await raw.goto(target, options)
      await afterDocumentLoad()
      return response
    }
    if (raw.url() === 'about:blank' || !raw.url().startsWith(origin)) {
      await raw.goto(state.url, options)
      await afterDocumentLoad()
    }
    await ensurePanel()
    const route = target.startsWith('/') ? target : `/${target}`
    const before = new URL(raw.url())
    const beforeRoute = before.hash.startsWith('#/') ? before.hash.slice(1) : null
    const response = await raw.goto(`${origin}/#${route}`, options)
    // A `#/` navigation to the route we are already on is same-document: React Router keeps the
    // page component (and its in-memory state) mounted, while Django's `page.goto` was a full
    // document load that always reset it. Force the load so a spec that re-enters the same route
    // sees a fresh page, exactly like the Django-era suite did.
    if (beforeRoute !== null && beforeRoute === route) {
      await raw.reload(options)
      await afterDocumentLoad()
    }
    // A `#/` navigation is same-document, so no dialog can have appeared; the
    // panel is only re-checked because a deep link can remount it.
    await ensurePanel()
    return response
  }

  async function reload(options?: Parameters<Page['reload']>[0]) {
    const response = await raw.reload(options)
    await afterDocumentLoad()
    return response
  }

  /* ------------------------------------------------------------ responses */
  function waitForResponse(
    predicate: ResponsePredicate | string | RegExp,
    options?: { timeout?: number },
  ): Promise<LogicalResponse> {
    const timeout = options?.timeout ?? 30_000
    const test =
      typeof predicate === 'function'
        ? predicate
        : (response: Response) => {
            const url = response.url()
            return typeof predicate === 'string' ? url.includes(predicate) : predicate.test(url)
          }
    return new Promise<LogicalResponse>((resolve, reject) => {
      const seen: string[] = []
      let done = false
      const finish = (action: () => void) => {
        if (done) return
        done = true
        clearTimeout(timer)
        raw.off('response', onResponse)
        action()
      }
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `waitForResponse: no matching logical call within ${timeout}ms; last calls: ${JSON.stringify(
                seen.slice(-8),
              )}`,
            ),
          ),
        )
      }, timeout)
      const onResponse = (response: Response) => {
        const envelope = envelopeOf(response.request())
        if (envelope === undefined) return
        const request = logicalRequest(envelope)
        seen.push(`${envelope.method} ${request.url()}`)
        if (!matches(test, request)) return
        settleResponse(response, envelope).then(
          (logical) => finish(() => resolve(logical)),
          (error: unknown) => finish(() => reject(error)),
        )
      }
      raw.on('response', onResponse)
    })
  }

  function on(event: string, handler: (...args: never[]) => void): Page {
    if (event === 'response') {
      raw.on('response', (response: Response) => {
        const envelope = envelopeOf(response.request())
        if (envelope === undefined) return
        settleResponse(response, envelope)
          .then((logical) => (handler as unknown as (r: LogicalResponse) => void)(logical))
          .catch(() => undefined)
      })
      return proxy
    }
    if (event === 'request') {
      raw.on('request', (request: Request) => {
        const envelope = envelopeOf(request)
        if (envelope === undefined) return
        ;(handler as unknown as (r: ReturnType<typeof logicalRequest>) => void)(logicalRequest(envelope))
      })
      return proxy
    }
    raw.on(event, handler as never)
    return proxy
  }

  /* -------------------------------------------------------- page.request */
  async function rpcCall(
    method: string,
    target: string,
    options?: { data?: unknown; headers?: Record<string, string> },
  ): Promise<APIResponse> {
    const url = new URL(target, origin)
    const query: Record<string, string | string[]> = {}
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key)
      query[key] = values.length === 1 ? values[0] : values
    }
    const result = await raw.evaluate(
      async (args: {
        rpcPath: string
        method: string
        path: string
        query: Record<string, string | string[]>
        headers: Record<string, string>
        body?: unknown
      }) => {
        const payload: Record<string, unknown> = {
          method: args.method,
          path: args.path,
          query: args.query,
          headers: args.headers,
        }
        if (args.body !== undefined) payload.body = args.body
        const response = await fetch(args.rpcPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
        })
        const text = await response.text()
        try {
          const carrier = JSON.parse(text) as { status?: number; body?: string; headers?: Record<string, string> }
          return {
            status: typeof carrier.status === 'number' ? carrier.status : response.status,
            body: typeof carrier.body === 'string' ? carrier.body : text,
            headers: carrier.headers ?? {},
          }
        } catch {
          return { status: response.status, body: text, headers: {} as Record<string, string> }
        }
      },
      {
        rpcPath: RPC_PATH,
        method,
        path: url.pathname,
        query,
        headers: { accept: 'application/json', ...(options?.headers ?? {}) },
        body: options?.data,
      },
    )
    const logical = logicalUrl({ method, path: url.pathname, query })
    return new LogicalResponse(
      result.status,
      result.body,
      logical,
      result.headers,
      logicalRequest({ method, path: url.pathname, query }),
    ) as unknown as APIResponse
  }

  const requestFacade = {
    get: (target: string, options?: { headers?: Record<string, string> }) => rpcCall('GET', target, options),
    post: (target: string, options?: { data?: unknown; headers?: Record<string, string> }) =>
      rpcCall('POST', target, options),
    patch: (target: string, options?: { data?: unknown; headers?: Record<string, string> }) =>
      rpcCall('PATCH', target, options),
    put: (target: string, options?: { data?: unknown; headers?: Record<string, string> }) =>
      rpcCall('PUT', target, options),
    delete: (target: string, options?: { data?: unknown; headers?: Record<string, string> }) =>
      rpcCall('DELETE', target, options),
    dispose: async () => undefined,
  }

  const overrides: Record<string, unknown> = {
    goto,
    reload,
    waitForResponse,
    on,
    request: requestFacade,
    ensurePanel,
    injectFault: (fault: FaultInjection) => injectFault(proxy, fault),
  }

  const proxy: Page = new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property === 'string' && Object.hasOwn(overrides, property)) return overrides[property]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value
    },
    has(target, property) {
      return (typeof property === 'string' && Object.hasOwn(overrides, property)) || Reflect.has(target, property)
    },
  })

  return proxy
}

/**
 * In-page logical RPC helper.
 *
 * One acceptance case asks the server directly *from inside the authenticated
 * page*; over Django that was `fetch('/api/v1/...')`. The logical path cannot be
 * an HTTP URL on DSH, so the page gets the same call through the RPC carrier.
 */
function installRpcHelper(page: Page): Promise<unknown> {
  return page.addInitScript((rpcPath: string) => {
    const toQuery = (query: Record<string, string | string[]>): Record<string, string | string[]> => query ?? {}
    const call = async (
      method: string,
      logicalPath: string,
      query: Record<string, string | string[]> = {},
      headers: Record<string, string> = {},
      body?: unknown,
    ) => {
      const payload: Record<string, unknown> = { method, path: logicalPath, query: toQuery(query), headers }
      if (body !== undefined) payload.body = body
      const response = await fetch(rpcPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      })
      const text = await response.text()
      let status = response.status
      let bodyText = text
      try {
        const carrier = JSON.parse(text) as { status?: number; body?: string }
        if (typeof carrier.status === 'number') status = carrier.status
        if (typeof carrier.body === 'string') bodyText = carrier.body
      } catch {
        /* transport-level failure keeps the HTTP body */
      }
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => bodyText,
        json: async () => JSON.parse(bodyText),
      }
    }
    ;(window as unknown as { __acepassRpc: typeof call }).__acepassRpc = call
  }, RPC_PATH)
}

export const test = base.extend<{ acceptanceState: AcceptanceState }>({
  acceptanceState: async ({}, use) => {
    await use(readState())
  },
  page: async ({ page }, use, testInfo) => {
    const state = readState()
    const instrumented = instrument(page, state)
    await installRpcHelper(page)
    const meta = {
      project: testInfo.project.name,
      file: path.basename(testInfo.file),
      title: testInfo.title,
    }
    page.on('response', (response) => {
      const envelope = envelopeOf(response.request())
      if (envelope === undefined) return
      settleResponse(response, envelope)
        .then((logical) =>
          recordTrace({ ...meta, method: envelope.method, path: logicalUrl(envelope), status: logical.status() }),
        )
        .catch(() => recordTrace({ ...meta, method: envelope.method, path: logicalUrl(envelope), status: -1 }))
    })
    await use(instrumented)
  },
})
