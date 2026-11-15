import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'

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

/** The study-structure surface, driven exactly like the Settings/Knowledge/Reports pages drive it. */
function harness() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 's@example.com', display_name: '结构', date_joined: NOW }),
    { now: NOW },
  )
  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId: String(user.id), now }),
  })
  let counter = 0
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> => {
    counter += 1
    const request = new Request(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(method === 'GET' ? {} : { 'idempotency-key': `k-${counter}` }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  return { db, close: handle.close, call, setNow: (value: Instant) => { now = value } }
}

test('study routes: a subject grows a published spec, a published syllabus and nodes', async () => {
  const h = harness()
  try {
    const project = await h.call('POST', '/projects', { body: { name: '结构项目' } })
    assert.equal(project.status, 201)
    const pid = project.body.id

    const subject = await h.call('POST', `/projects/${pid}/subjects`, {
      body: { name: '科目', total_score: 100, pass_score: 60 },
    })
    assert.equal(subject.status, 201)
    const sid = subject.body.id

    const spec = await h.call('POST', `/projects/${pid}/exam-spec-versions`, {
      body: {
        subject_id: sid,
        name: '规范',
        total_score: 100,
        pass_score: 60,
        question_type_rules: { single_choice: { max_score: 2, correct_score: 2, wrong_score: 0 } },
      },
    })
    assert.equal(spec.status, 201)
    // Publishing without any scoring rule is refused by the service, not by the route.
    const rulesless = await h.call('POST', `/projects/${pid}/exam-spec-versions`, {
      body: { subject_id: sid, name: '空规范', total_score: 100, pass_score: 60 },
    })
    const refused = await h.call('POST', `/projects/${pid}/exam-spec-versions/${rulesless.body.id}/publish`, {
      body: {},
    })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error.message, /至少一种题型/)
    const published = await h.call('POST', `/projects/${pid}/exam-spec-versions/${spec.body.id}/publish`, {
      body: {},
    })
    assert.equal(published.status, 200)
    assert.equal(published.body.status, 'published')

    const syllabus = await h.call('POST', `/projects/${pid}/syllabus-versions`, {
      body: { subject_id: sid, name: '大纲', version_label: '2026' },
    })
    assert.equal(syllabus.status, 201)
    const syllabusPublished = await h.call(
      'POST',
      `/projects/${pid}/syllabus-versions/${syllabus.body.id}/publish`,
      { body: {} },
    )
    assert.equal(syllabusPublished.status, 200)

    const node = await h.call('POST', `/projects/${pid}/knowledge-nodes`, {
      body: { syllabus_version_id: syllabus.body.id, canonical_name: '考点一' },
    })
    assert.equal(node.status, 201)
    const patched = await h.call('PATCH', `/projects/${pid}/knowledge-nodes/${node.body.id}`, {
      body: { aliases: ['考点甲'] },
    })
    assert.equal(patched.status, 200)
    const listed = await h.call(
      'GET',
      `/projects/${pid}/knowledge-nodes?syllabus_version_id=${syllabus.body.id}`,
      { headers: {} },
    )
    assert.equal(listed.status, 200)
    assert.equal(listed.body.length, 1)

    const specs = await h.call('GET', `/projects/${pid}/exam-spec-versions?subject_id=${sid}`)
    assert.equal(specs.status, 200)
    assert.equal(specs.body.length, 2)
    const syllabi = await h.call('GET', `/projects/${pid}/syllabus-versions?subject_id=${sid}`)
    assert.equal(syllabi.status, 200)
    assert.equal(syllabi.body.length, 1)
  } finally {
    h.close()
  }
})

test('study routes: a paper is registered once and revision routes refuse an unknown revision', async () => {
  const h = harness()
  try {
    const project = await h.call('POST', '/projects', { body: { name: '试卷项目' } })
    const pid = project.body.id
    const subject = await h.call('POST', `/projects/${pid}/subjects`, {
      body: { name: '科目', total_score: 100, pass_score: 60 },
    })
    const sid = subject.body.id
    const paper = await h.call('POST', `/projects/${pid}/papers`, {
      body: { subject_id: sid, cycle_key: '2026', session_key: 's1', paper_code: 'A', source_kind: 'official_past', title: '真题' },
    })
    assert.equal(paper.status, 201)
    const again = await h.call('POST', `/projects/${pid}/papers`, {
      body: { subject_id: sid, cycle_key: '2026', session_key: 's1', paper_code: 'A', source_kind: 'official_past', title: '真题' },
    })
    assert.equal(again.status, 200, 'a repeated upload reuses the record instead of duplicating it')
    assert.equal(again.body.paper?.id ?? again.body.id, paper.body.paper?.id ?? paper.body.id)

    const listed = await h.call('GET', `/projects/${pid}/papers?subject_id=${sid}`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.length, 1)

    // A registered paper has no revision yet: revisions come from an import. The coverage route
    // must therefore refuse an unknown revision at the service boundary instead of answering 200.
    const coverage = await h.call('POST', `/projects/${pid}/paper-revisions/unknown/coverage`, {
      body: { expected_session_count: 2, covered_session_count: 2, confirm: true },
    })
    assert.equal(coverage.status, 404)
    const confirm = await h.call('POST', `/projects/${pid}/paper-revisions/unknown/confirm`, { body: {} })
    assert.equal(confirm.status, 404)
  } finally {
    h.close()
  }
})
