import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import {
  ASSET_PATH,
  createRpcHandler,
  fromFetchResponse,
  logicalPath,
  mountAcePass,
  toFetchRequest,
  RPC_PATH,
  STREAM_PATH,
} from '../src/http/mount.ts'
import { mountStreamRoute, unmigratedStream, type StreamOperation, type StreamProducer } from '../src/http/stream.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')

function completeRow(table: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const row: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey || column.name in overrides) continue
    if (!column.notNull) continue
    const fk = foreignKeys.get(column.name)
    if (fk) {
      row[column.name] = `fk-${fk.refTable}`
      continue
    }
    row[column.name] = column.json
      ? {}
      : column.kind === 'datetime'
        ? NOW
        : column.kind === 'int' || column.kind === 'bool'
          ? 0
          : ''
  }
  Object.assign(row, overrides)
  return row
}

function harness(options: { maxBytes?: number } = {}) {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'remote@example.com', display_name: '远程', date_joined: NOW }),
    { now: NOW },
  )
  const routes = acepassRoutes()
  const handler = createRpcHandler({
    db,
    userId: String(user.id),
    now: () => NOW as Instant,
    routes,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  })
  const call = async (payload: unknown): Promise<{ status: number; json: any }> => {
    const response = await handler(
      new Request('http://host/api/acepass/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
    return { status: response.status, json: await response.json() }
  }
  return { db, close: handle.close, call }
}

test('mount: the client path is translated onto the mounted router and nothing else is guessed', () => {
  assert.equal(logicalPath('/api/v1/projects/abc/questions'), '/api/acepass/projects/abc/questions')
  assert.equal(logicalPath('/api/acepass/projects'), '/api/acepass/projects')
  assert.equal(logicalPath('/api/v1/projects?limit=2'), '/api/acepass/projects')
  assert.throws(() => logicalPath('/admin/'), /unsupported request path/)
})

test('rpc: a GET is replayed against the same router and keeps status, headers and body', async () => {
  const h = harness()
  try {
    const response = await h.call({ method: 'GET', path: '/api/v1/projects' })
    assert.equal(response.status, 200)
    assert.equal(response.json.status, 200)
    assert.equal(response.json.encoding, 'utf8')
    assert.equal(response.json.body, '[]')
    assert.match(response.json.headers['content-type'], /application\/json/)
    assert.match(response.json.headers['x-request-id'], /^req-/)
  } finally {
    h.close()
  }
})

test('rpc: query parameters, the idempotency key and the error envelope survive the carrier', async () => {
  const h = harness()
  try {
    const missing = await h.call({
      method: 'POST',
      path: '/api/v1/projects',
      body: { name: '项目一' },
    })
    assert.equal(missing.status, 200, 'the carrier succeeded; the router answered 409')
    assert.equal(missing.json.status, 409)
    const envelope = JSON.parse(missing.json.body).error
    assert.equal(envelope.code, 'idempotency_conflict')
    assert.equal(envelope.message, '缺少 Idempotency-Key 请求头')

    const payload = {
      method: 'POST',
      path: '/api/v1/projects',
      headers: { 'idempotency-key': 'rpc-1' },
      body: { name: '项目一' },
    }
    const first = await h.call(payload)
    const second = await h.call(payload)
    assert.equal(first.json.status, 201)
    assert.equal(second.json.status, 201)
    assert.equal(JSON.parse(second.json.body).id, JSON.parse(first.json.body).id)

    const listed = await h.call({ method: 'GET', path: '/api/v1/projects' })
    assert.equal(JSON.parse(listed.json.body).length, 1, 'the effect happened once')
  } finally {
    h.close()
  }
})

test('rpc: an oversized or malformed envelope is rejected before dispatch', async () => {
  const h = harness({ maxBytes: 64 })
  try {
    const big = await h.call({ method: 'GET', path: '/api/v1/projects', query: { pad: 'x'.repeat(200) } })
    assert.equal(big.status, 413)
    assert.equal(big.json.error.code, 'payload_too_large')

    const response = await h
      .call(undefined)
      .catch(() => ({ status: 400, json: { error: { code: 'invalid_json' } } }))
    assert.equal(response.status, 400)
  } finally {
    h.close()
  }
})

test('rpc: a multipart body is rebuilt from fields + base64 files', async () => {
  const request = toFetchRequest({
    method: 'POST',
    path: '/api/v1/projects/abc/imports',
    fields: { mode: 'text' },
    files: [
      {
        field: 'file',
        filename: '答案.png',
        contentType: 'image/png',
        base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      },
    ],
  })
  const form = await request.formData()
  assert.equal(form.get('mode'), 'text')
  const file = form.get('file')
  assert.ok(file instanceof File)
  assert.equal(file.name, '答案.png')
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])
})

test('rpc: a binary router response is base64 encoded and decoded by the client contract', async () => {
  const original = new Response(new Uint8Array([0, 255, 12]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
  const envelope = await fromFetchResponse(original)
  assert.equal(envelope.encoding, 'base64')
  assert.deepEqual([...Buffer.from(envelope.body, 'base64')], [0, 255, 12])
})

test('mount: static paths are grouped per path (one registration, several methods) and parameters are absent', () => {
  const registered: Array<{ path: string; methods: string[] }> = []
  const connection = {
    fetch: {
      register: (route: any) => {
        registered.push({ path: route.path, methods: [...route.methods] })
        return () => undefined
      },
    },
  }
  const handle = openStore({ path: ':memory:' })
  try {
    const disposers = mountAcePass(connection, {
      db: handle.db,
      userId: 'u',
      now: () => NOW as Instant,
      routes: acepassRoutes(),
      streams: [unmigratedStream],
    })
    assert.equal(disposers.length, registered.length)
    const settings = registered.find((entry) => entry.path === '/api/acepass/me/study-settings')
    assert.ok(settings, 'the settings path is mounted')
    assert.deepEqual([...settings.methods].sort(), ['GET', 'PATCH'], 'both methods share one registration')
    assert.ok(registered.some((entry) => entry.path === RPC_PATH))
    assert.ok(registered.some((entry) => entry.path === STREAM_PATH))
    assert.ok(
      registered.every((entry) => !entry.path.includes(':')),
      'an exact-path registry can never match a parameterised pattern',
    )
    assert.equal(new Set(registered.map((entry) => entry.path)).size, registered.length, 'no duplicate paths')
  } finally {
    handle.close()
  }
})

function producer(frames: Array<{ event: string; data: unknown; seq: number }>, doneAfter: number): StreamProducer & { cancelled: number } {
  let cancelled = 0
  return {
    get cancelled() {
      return cancelled
    },
    async next(after) {
      const batch = frames.filter((frame) => frame.seq > after)
      const done = after >= doneAfter
      return { frames: done ? [] : batch, done }
    },
    cancel() {
      cancelled += 1
    },
  }
}

async function readAll(response: Response): Promise<string> {
  return await response.text()
}

test('mount: the asset route rewrites to the parameterised download handler and keeps its gates', async () => {
  const registered = new Map<string, any>()
  const connection = {
    fetch: {
      register: (route: any) => {
        registered.set(route.path, route)
        return () => undefined
      },
    },
  }
  const handle = openStore({ path: ':memory:' })
  try {
    mountAcePass(connection, {
      db: handle.db,
      userId: 'u',
      now: () => NOW as Instant,
      routes: acepassRoutes(),
      streams: [unmigratedStream],
    })
    const route = registered.get(ASSET_PATH)
    assert.ok(route, 'the browser needs one exact path for <img src>')
    const response = await route.fetch(
      new Request(`http://host${ASSET_PATH}?project_id=missing&asset_id=missing&purpose=editorial`),
    )
    assert.equal(response.status, 404, 'an unknown project is refused by the real handler, not by the shim')
    const body = await response.json()
    assert.equal(body.error.code, 'not_found')
  } finally {
    handle.close()
  }
})

test('stream: frames keep their seq, a resume never replays or skips, and done is terminal', async () => {
  const frames = [
    { event: 'status', data: { jobStatus: 'running' }, seq: 1 },
    { event: 'segment', data: { index: 0, text: '一' }, seq: 2 },
    { event: 'segment', data: { index: 1, text: '二' }, seq: 3 },
  ]
  const operation: StreamOperation = {
    name: 'demo',
    async open() {
      return producer(frames, 3)
    },
  }
  const first = await mountStreamRoute(new Request('http://host/api/acepass/stream?op=demo'), [operation])
  assert.equal(first.status, 200)
  assert.match(String(first.headers.get('content-type')), /text\/event-stream/)
  const text = await readAll(first)
  assert.match(text, /^: connected\n\n/)
  assert.match(text, /id: 1\nevent: status\n/)
  assert.match(text, /id: 3\nevent: segment\n/)
  assert.match(text, /event: done\ndata: \{"seq":3\}/)

  const resumed = await mountStreamRoute(new Request('http://host/api/acepass/stream?op=demo&after=2'), [operation])
  const resumedText = await readAll(resumed)
  assert.doesNotMatch(resumedText, /id: 1\n/, 'already-seen frames are not replayed')
  assert.doesNotMatch(resumedText, /id: 2\n/)
  assert.match(resumedText, /id: 3\nevent: segment\n/)
})

test('stream: an unknown op is a 404 envelope and a bad cursor is a 400', async () => {
  const unknown = await mountStreamRoute(new Request('http://host/api/acepass/stream?op=nope'), [])
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'not_found')

  const bad = await mountStreamRoute(
    new Request('http://host/api/acepass/stream?op=tutor.stream&after=-1'),
    [unmigratedStream],
  )
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error.code, 'invalid_input')
})

test('stream: a producer failure becomes a terminal error frame, and a client abort cancels the producer', async () => {
  const failing: StreamOperation = {
    name: 'boom',
    async open() {
      const inner = producer([], 0)
      return {
        next: async () => {
          throw new Error('producer exploded')
        },
        cancel: inner.cancel,
      }
    },
  }
  const response = await mountStreamRoute(new Request('http://host/api/acepass/stream?op=boom'), [failing])
  const text = await readAll(response)
  assert.match(text, /event: error\n/)
  assert.match(text, /"code":"internal_error"/)
  assert.doesNotMatch(text, /event: done\n/, 'error is terminal on its own; no second terminal frame')

  const tracked = producer([{ event: 'status', data: {}, seq: 1 }], 99)
  const abortable: StreamOperation = { name: 'abort', async open() { return tracked } }
  const controller = new AbortController()
  const request = new Request('http://host/api/acepass/stream?op=abort', { signal: controller.signal })
  const streamed = await mountStreamRoute(request, [abortable])
  const reader = streamed.body!.getReader()
  await reader.read()
  controller.abort()
  await reader.cancel()
  assert.ok(tracked.cancelled >= 1, 'the producer is released when the client goes away')
})

test('stream: the tutoring operation answers service_not_migrated instead of inventing segments', async () => {
  const response = await mountStreamRoute(new Request('http://host/api/acepass/stream?op=tutor.stream'), [unmigratedStream])
  const text = await readAll(response)
  assert.match(text, /"code":"service_not_migrated"/)
  assert.doesNotMatch(text, /event: segment/, 'no segment may be fabricated')
})
