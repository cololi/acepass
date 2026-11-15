import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openStore } from '../src/store/db.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject } from '../src/services/exams.ts'
import { insertRow } from '../src/store/repository.ts'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { TABLES } from '../src/store/schema.generated.ts'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'
const golden = JSON.parse(readFileSync(new URL('./golden/ingestion_text.json', import.meta.url), 'utf8'))

function harness() {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const userId = String(
    insertRow(
      db,
      'accounts_user',
      {
        password: '!',
        email: 'owner@acepass.local',
        display_name: '本机用户',
        is_active: true,
        is_staff: false,
        is_superuser: false,
        date_joined: NOW,
      },
      { now: NOW },
    ).id,
  )
  const project = createProject(db, userId, { name: '题库导入' }, NOW)
  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId, now }),
    newRequestId: () => 'req-fixed',
  })
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> => {
    const request = new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  const counts = (): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const table of TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number }
      out[table.name] = Number(row.n)
    }
    return out
  }
  return { db, userId, projectId: String(project.id), call, counts, close: handle.close }
}

test('ingestion http: O06 previews a template exactly like the Python parser', async () => {
  const h = harness()
  try {
    // Index 6 in the golden corpus is the labelled template (3 segments: stem, options, fill).
    const expected = golden.parse.find(
      (entry: any) => entry.structure_only === false && entry.text.startsWith('【题干】下列哪一项是质数？'),
    )
    assert.ok(expected, 'template vector missing from the golden corpus')
    const response = await h.call('POST', `/projects/${h.projectId}/imports/parse-text`, { text: expected.text })
    assert.equal(response.status, 200)
    assert.equal(response.body.count, expected.segments.length)
    assert.deepEqual(response.body.segments, expected.segments)
  } finally {
    h.close()
  }
})

test('ingestion http: O06 writes nothing', async () => {
  const h = harness()
  try {
    const before = h.counts()
    const response = await h.call('POST', `/projects/${h.projectId}/imports/parse-text`, {
      text: '【题干】只预览\n【答案】A\n',
    })
    assert.equal(response.status, 200)
    assert.deepEqual(h.counts(), before)
  } finally {
    h.close()
  }
})

test('ingestion http: O06 returns an empty result for empty text instead of guessing', async () => {
  const h = harness()
  try {
    const response = await h.call('POST', `/projects/${h.projectId}/imports/parse-text`, { text: '' })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { count: 0, segments: [] })
  } finally {
    h.close()
  }
})

test('ingestion http: O06 hides a project the caller does not own', async () => {
  const h = harness()
  try {
    const response = await h.call('POST', '/projects/no-such-project/imports/parse-text', { text: '【题干】x' })
    assert.equal(response.status, 404)
    assert.deepEqual(response.body.error, { code: 'not_found', message: '项目不存在或无权访问', details: {}, request_id: 'req-fixed' })
  } finally {
    h.close()
  }
})

test('ingestion http: O06 rejects a missing or non-string text with the Ninja error shape', async () => {
  const h = harness()
  try {
    const missing = await h.call('POST', `/projects/${h.projectId}/imports/parse-text`, {})
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'invalid_input')
    assert.equal(missing.body.error.message, '请求参数校验失败')
    assert.deepEqual(missing.body.error.details.errors, [
      { type: 'missing', loc: ['body', 'payload', 'text'], msg: 'Field required' },
    ])

    const wrongType = await h.call('POST', `/projects/${h.projectId}/imports/parse-text`, { text: 5 })
    assert.equal(wrongType.status, 400)
    assert.deepEqual(wrongType.body.error.details.errors, [
      { type: 'string_type', loc: ['body', 'payload', 'text'], msg: 'Input should be a valid string' },
    ])

    const notAnObject = await h.call('POST', `/projects/${h.projectId}/imports/parse-text`, ['x'])
    assert.equal(notAnObject.status, 400)
    assert.deepEqual(notAnObject.body.error.details.errors, [
      { type: 'missing', loc: ['body', 'payload', 'text'], msg: 'Field required' },
    ])

    const noBody = await h.call('POST', `/projects/${h.projectId}/imports/parse-text`)
    assert.equal(noBody.status, 400)
    assert.deepEqual(noBody.body.error.details.errors, [
      { type: 'missing', loc: ['body', 'payload'], msg: 'Field required' },
    ])
  } finally {
    h.close()
  }
})
