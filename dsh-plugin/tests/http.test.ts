import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
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

/**
 * The whole HTTP stack, driven exactly like a client would drive it.
 *
 * This is the layer the migration's exit criterion is about: the assertions here are the black-box
 * ones (status codes, the error envelope, idempotent replay), not calls into service functions.
 */
function harness() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'h@example.com', display_name: '阿测', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
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
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> => {
    const request = new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text), headers: response.headers }
  }
  return { db, close: handle.close, userId, call, setNow: (value: Instant) => { now = value } }
}

test('http: /auth/me answers with the documented shape', async () => {
  const h = harness()
  try {
    const response = await h.call('GET', '/auth/me')
    assert.equal(response.status, 200)
    assert.equal(response.body.email, 'h@example.com')
    assert.equal(response.body.needs_project_setup, true)
    assert.equal(response.headers.get('x-request-id'), 'req-fixed')
    assert.match(String(response.headers.get('content-type')), /application\/json/)
  } finally {
    h.close()
  }
})

test('http: a side-effecting POST without an Idempotency-Key is refused', async () => {
  const h = harness()
  try {
    const response = await h.call('POST', '/projects', { body: { name: 'P' } })
    // Django's `idempotency_key()` raises IdempotencyConflict (409), not a 400.
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'idempotency_conflict')
    assert.equal(response.body.error.message, '缺少 Idempotency-Key 请求头')
  } finally {
    h.close()
  }
})

test('http: the same key and payload replays the stored response instead of creating twice', async () => {
  const h = harness()
  try {
    const headers = { 'idempotency-key': 'k1' }
    const first = await h.call('POST', '/projects', { body: { name: '项目一' }, headers })
    assert.equal(first.status, 201)
    assert.equal(first.body.name, '项目一')

    const second = await h.call('POST', '/projects', { body: { name: '项目一' }, headers })
    assert.equal(second.status, 201, 'a replay keeps the original status code')
    assert.equal(second.body.id, first.body.id, 'and the original body')

    const listed = await h.call('GET', '/projects')
    assert.equal(listed.body.length, 1, 'the effect happened exactly once')
  } finally {
    h.close()
  }
})

test('http: the same key with a different payload is a 409 conflict', async () => {
  const h = harness()
  try {
    const headers = { 'idempotency-key': 'k2' }
    await h.call('POST', '/projects', { body: { name: 'A' }, headers })
    const conflict = await h.call('POST', '/projects', { body: { name: 'B' }, headers })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'idempotency_conflict')
  } finally {
    h.close()
  }
})

test('http: a failed request releases its claim so the retry can succeed', async () => {
  const h = harness()
  try {
    const headers = { 'idempotency-key': 'k3' }
    const failed = await h.call('POST', '/projects', { body: { name: '   ' }, headers })
    assert.equal(failed.status, 400)
    assert.equal(failed.body.error.code, 'invalid_input')

    const retried = await h.call('POST', '/projects', { body: { name: '正式名字' }, headers })
    assert.equal(retried.status, 201, 'the key must not stay claimed by a request that failed')
  } finally {
    h.close()
  }
})

test('http: an unknown path and an unknown object are both 404 envelopes', async () => {
  const h = harness()
  try {
    const missingRoute = await h.call('GET', '/nope')
    assert.equal(missingRoute.status, 404)
    assert.equal(missingRoute.body.error.code, 'not_found')

    const missingObject = await h.call('GET', '/projects/does-not-exist')
    assert.equal(missingObject.status, 404, 'an unreachable object is not a 403')
    assert.equal(missingObject.body.error.code, 'not_found')
    assert.equal(missingObject.body.error.request_id, 'req-fixed')
  } finally {
    h.close()
  }
})

test('http: a malformed JSON body is a 400, not a crash', async () => {
  const h = harness()
  try {
    const handler = createFetchHandler({
      db: h.db,
      routes: acepassRoutes(),
      actor: () => ({ userId: h.userId, now: NOW }),
    })
    const response = await handler(
      new Request(`${BASE}/me/study-settings`, { method: 'PATCH', body: '{oops', headers: { 'content-type': 'application/json' } }),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'internal_error')
  } finally {
    h.close()
  }
})

test('http: the full project lifecycle over HTTP', async () => {
  const h = harness()
  try {
    const headers = { 'idempotency-key': 'lifecycle' }
    const created = await h.call('POST', '/projects', { body: { name: '学期项目', description: 'd' }, headers })
    const projectId = created.body.id

    const patched = await h.call('PATCH', `/projects/${projectId}`, { body: { name: '改名后' } })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.name, '改名后')

    const subject = await h.call('POST', `/projects/${projectId}/subjects`, {
      body: { name: '科目一' },
      headers: { 'idempotency-key': 'subject-1' },
    })
    assert.equal(subject.status, 201)
    assert.equal(subject.body.project_id, projectId)

    const subjects = await h.call('GET', `/projects/${projectId}/subjects`)
    assert.equal(subjects.body.length, 1)

    const archived = await h.call('POST', `/projects/${projectId}/archive`, {
      body: { reason: '换项目' },
      headers: { 'idempotency-key': 'archive-1' },
    })
    assert.equal(archived.body.is_archived, true)

    const listed = await h.call('GET', '/projects')
    assert.deepEqual(listed.body, [], 'archived projects are hidden by default')
    const withArchived = await h.call('GET', '/projects?include_archived=true')
    assert.equal(withArchived.body.length, 1)

    const restored = await h.call('POST', `/projects/${projectId}/unarchive`, {
      headers: { 'idempotency-key': 'unarchive-1' },
    })
    assert.equal(restored.body.is_archived, false)
  } finally {
    h.close()
  }
})

test('http: the practice read path answers over HTTP', async () => {
  const h = harness()
  try {
    const project = await h.call('POST', '/projects', { body: { name: 'P' }, headers: { 'idempotency-key': 'p' } })
    const projectId = project.body.id

    const sessions = await h.call('GET', `/projects/${projectId}/practice-sessions`)
    assert.equal(sessions.status, 200)
    assert.deepEqual(sessions.body, [], 'an unreachable session list is empty, not a 404')

    const states = await h.call('GET', `/projects/${projectId}/learning-states`)
    assert.equal(states.status, 200)
    assert.deepEqual(states.body.states, [])
    assert.equal(states.body.thresholds.distinct_questions, 2)

    const evidence = await h.call('GET', `/projects/${projectId}/evidence?dimension=independent_correct`)
    assert.equal(evidence.status, 200)
    assert.equal(evidence.body.count, 0)

    const mistakes = await h.call('GET', `/projects/${projectId}/mistakes`)
    assert.equal(mistakes.status, 200)
    assert.equal(mistakes.body.count, 0)

    const missing = await h.call('GET', `/projects/${projectId}/attempts/no-such-attempt`)
    assert.equal(missing.status, 404)

    const plan = await h.call('POST', '/study-plans/today/generate', {
      body: { refresh: false },
      headers: { 'idempotency-key': 'plan-1' },
    })
    assert.equal(plan.status, 200)
    // Django answers `TodayPlanOut` (`{plan, tasks, notes, backlog, progress_notes}`), not the raw
    // plan row: the today page reads `plan.daily_budget_minutes` out of this envelope.
    assert.equal(plan.body.plan.revision, 1)
    assert.ok(Array.isArray(plan.body.tasks))
    // Instants and decimals must reach the client as text, never as BigInt or an object.
    assert.match(String(plan.body.plan.generated_at), /^\d{4}-\d{2}-\d{2}T/, 'instants go out as ISO text')
    const tasks = await h.call('GET', `/projects/${projectId}/plans/${plan.body.plan.id}/tasks`)
    assert.equal(tasks.status, 200)
    assert.ok(Array.isArray(tasks.body))
  } finally {
    h.close()
  }
})

test('http: a sealed family is reported as sealed through the API', async () => {
  const h = harness()
  try {
    const created = await h.call('POST', '/projects', { body: { name: 'P' }, headers: { 'idempotency-key': 'p' } })
    const projectId = created.body.id
    const subject = await h.call('POST', `/projects/${projectId}/subjects`, {
      body: { name: 'S' },
      headers: { 'idempotency-key': 's' },
    })
    const family = await h.call('POST', `/projects/${projectId}/question-families`, {
      body: { subject_id: subject.body.id, name: '家族' },
      headers: { 'idempotency-key': 'f' },
    })
    assert.equal(family.status, 201)
    assert.equal(family.body.sealed, false)

    const listed = await h.call('GET', `/projects/${projectId}/question-families?subject_id=${subject.body.id}`)
    assert.equal(listed.body.length, 1)
    assert.equal(listed.body[0].sealed_member_count, 0)
  } finally {
    h.close()
  }
})

test('http: the question bank reads, publishes and seals over the wire', async () => {
  const h = harness()
  try {
    const project = await h.call('POST', '/projects', { body: { name: 'P' }, headers: { 'idempotency-key': 'p' } })
    const projectId = project.body.id
    const subject = await h.call('POST', `/projects/${projectId}/subjects`, {
      body: { name: 'S' },
      headers: { 'idempotency-key': 's' },
    })
    const subjectId = subject.body.id
    const question = insertRow(
      h.db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subjectId,
        display_label: '第一题',
        origin_type: 'import',
        is_demo: false,
        created_at: NOW,
        updated_at: NOW,
      }),
      { now: NOW },
    )
    const questionId = String(question.id)

    const revisionBody = {
      question_type: 'single_choice',
      content: {
        blocks: [{ kind: 'text', text: '1+1=?' }],
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      practice_max_score: '2.00',
      estimated_seconds: 45,
    }
    const noKey = await h.call('POST', `/projects/${projectId}/questions/${questionId}/revisions`, {
      body: revisionBody,
    })
    assert.equal(noKey.status, 409, 'the Django contract raises IdempotencyConflict here')
    assert.equal(noKey.body.error.code, 'idempotency_conflict')

    const revision = await h.call('POST', `/projects/${projectId}/questions/${questionId}/revisions`, {
      body: revisionBody,
      headers: { 'idempotency-key': 'rev-1' },
    })
    assert.equal(revision.status, 201)
    const versionId = revision.body.id
    assert.equal(revision.body.status, 'draft')
    assert.equal(revision.body.published_at, null)

    insertRow(
      h.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: versionId,
        version: 1,
        answer_payload: { kind: 'single_choice', correct_option_id: 'b' },
        source_type: 'manual',
        verification_status: 'checked',
        check_basis: '对照教材',
        is_disputed: false,
      }),
      { now: NOW },
    )

    const publishWithoutKey = await h.call('POST', `/projects/${projectId}/question-versions/${versionId}/publish`, {})
    assert.equal(publishWithoutKey.status, 409)
    const published = await h.call('POST', `/projects/${projectId}/question-versions/${versionId}/publish`, {
      headers: { 'idempotency-key': 'publish-1' },
    })
    assert.equal(published.status, 200)
    assert.equal(published.body.status, 'published')
    assert.match(String(published.body.published_at), /^\d{4}-\d{2}-\d{2}T/, 'instants travel as ISO text')
    const replay = await h.call('POST', `/projects/${projectId}/question-versions/${versionId}/publish`, {
      headers: { 'idempotency-key': 'publish-1' },
    })
    assert.equal(replay.body.id, published.body.id, 'a replay does not publish a second time')

    const list = await h.call('GET', `/projects/${projectId}/questions?status=published`)
    assert.equal(list.body.length, 1)
    assert.equal(list.body[0].id, questionId)
    assert.equal(list.body[0].published_version_id, versionId)
    assert.equal(list.body[0].has_trusted_answer, true)
    assert.equal(list.body[0].latest_version, 1)

    const preview = await h.call('GET', `/projects/${projectId}/questions/${questionId}`)
    assert.equal(preview.status, 200)
    assert.equal(preview.body.version_id, versionId)
    assert.equal(preview.body.practice_max_score, '2.00')
    assert.equal(JSON.stringify(preview.body).includes('correct_option_id'), false)
    assert.equal(findRows(h.db, 'practice_exposure_event', { question_id: questionId }).length, 1)

    const keys = await h.call('GET', `/projects/${projectId}/questions/${questionId}/answer-keys`)
    assert.equal(keys.body.length, 1)
    assert.equal(keys.body[0].is_usable, true)

    const sealed = await h.call('POST', `/projects/${projectId}/questions/${questionId}/seal`, {
      body: { reason: '模拟卷保留' },
    })
    assert.equal(sealed.status, 201)
    assert.equal(sealed.body.target, 'question')
    assert.equal(sealed.body.sealed, true)
    assert.equal(sealed.body.sealed_reason, 'sealed_question_policy')
    assert.deepEqual(sealed.body.sealed_question_ids, [questionId])

    const refused = await h.call('GET', `/projects/${projectId}/questions/${questionId}`)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'purpose_not_allowed')

    const sealedContent = await h.call('GET', `/projects/${projectId}/sealed-content`)
    assert.equal(sealedContent.status, 200)
    assert.ok(sealedContent.body.question_ids.includes(questionId))

    const unsealed = await h.call('POST', `/projects/${projectId}/questions/${questionId}/unseal`, {
      body: { reason: '解除保留' },
    })
    assert.equal(unsealed.status, 201)
    assert.equal(unsealed.body.sealed, false)
    const readable = await h.call('GET', `/projects/${projectId}/questions/${questionId}`)
    assert.equal(readable.status, 200)
  } finally {
    h.close()
  }
})

test('http: family membership and merge speak the documented envelope', async () => {
  const h = harness()
  try {
    const project = await h.call('POST', '/projects', { body: { name: 'P' }, headers: { 'idempotency-key': 'p' } })
    const projectId = project.body.id
    const subject = await h.call('POST', `/projects/${projectId}/subjects`, {
      body: { name: 'S' },
      headers: { 'idempotency-key': 's' },
    })
    const subjectId = subject.body.id
    const familyA = await h.call('POST', `/projects/${projectId}/question-families`, {
      body: { subject_id: subjectId, name: 'A' },
      headers: { 'idempotency-key': 'fa' },
    })
    const familyB = await h.call('POST', `/projects/${projectId}/question-families`, {
      body: { subject_id: subjectId, name: 'B' },
      headers: { 'idempotency-key': 'fb' },
    })
    const question = insertRow(
      h.db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subjectId,
        display_label: 'Q',
        origin_type: 'import',
        is_demo: false,
        created_at: NOW,
        updated_at: NOW,
      }),
      { now: NOW },
    )

    const added = await h.call('POST', `/projects/${projectId}/question-families/${familyA.body.id}/questions`, {
      body: { question_id: String(question.id) },
      headers: { 'idempotency-key': 'add-1' },
    })
    assert.equal(added.status, 201)
    assert.equal(added.body.changed, true)
    assert.equal(added.body.member_count, 1)

    const patched = await h.call('PATCH', `/projects/${projectId}/question-families/${familyA.body.id}`, {
      body: { name: 'A 改名', note: '备注' },
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.name, 'A 改名')

    const impact = await h.call(
      'GET',
      `/projects/${projectId}/question-families/${familyA.body.id}/merge-impact?target_family_id=${familyB.body.id}`,
    )
    assert.equal(impact.status, 200)
    assert.equal(impact.body.questions_to_move, 1)
    assert.equal(impact.body.already_merged, false)

    const merged = await h.call('POST', `/projects/${projectId}/question-families/${familyA.body.id}/merge`, {
      body: { target_family_id: familyB.body.id, reason: '同源' },
      headers: { 'idempotency-key': 'merge-1' },
    })
    assert.equal(merged.status, 201)
    assert.equal(merged.body.questions_moved, 1)
    assert.equal(merged.body.noop, false)

    const again = await h.call('POST', `/projects/${projectId}/question-families/${familyA.body.id}/merge`, {
      body: { target_family_id: familyB.body.id, reason: '同源' },
      headers: { 'idempotency-key': 'merge-2' },
    })
    assert.equal(again.status, 201)
    assert.equal(again.body.noop, true)

    const impactAfter = await h.call(
      'GET',
      `/projects/${projectId}/question-families/${familyA.body.id}/merge-impact?target_family_id=${familyB.body.id}`,
    )
    assert.equal(impactAfter.body.already_merged, true)
    assert.equal(impactAfter.body.evidence_rows_to_invalidate, 0)

    const removed = await h.call(
      'DELETE',
      `/projects/${projectId}/question-families/${familyB.body.id}/questions/${String(question.id)}`,
    )
    assert.equal(removed.status, 200)
    assert.equal(removed.body.changed, true)
    assert.equal(removed.body.member_count, 0)
  } finally {
    h.close()
  }
})

test('http: withdraw reads its reason from the query string and fingerprints it', async () => {
  const h = harness()
  try {
    const project = await h.call('POST', '/projects', { body: { name: 'P' }, headers: { 'idempotency-key': 'p' } })
    const projectId = project.body.id
    const subject = await h.call('POST', `/projects/${projectId}/subjects`, {
      body: { name: 'S' },
      headers: { 'idempotency-key': 's' },
    })
    const question = insertRow(
      h.db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subject.body.id,
        display_label: 'Q',
        origin_type: 'import',
        is_demo: false,
        created_at: NOW,
        updated_at: NOW,
      }),
      { now: NOW },
    )
    const version = insertRow(
      h.db,
      'question_bank_question_version',
      completeRow('question_bank_question_version', {
        question_id: question.id,
        version: 1,
        question_type: 'single_choice',
        content: { blocks: [{ kind: 'text', text: '题' }], options: [{ id: 'a', label: 'A' }] },
        material_child_version_ids: [],
        practice_max_score: '2.00',
        estimated_seconds: 30,
        status: 'draft',
        published_at: null,
        content_digest: '',
      }),
      { now: NOW },
    )
    insertRow(
      h.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: version.id,
        version: 1,
        answer_payload: { kind: 'single_choice', correct_option_id: 'a' },
        source_type: 'manual',
        verification_status: 'checked',
        check_basis: '对照教材',
        is_disputed: false,
      }),
      { now: NOW },
    )
    const published = await h.call('POST', `/projects/${projectId}/question-versions/${String(version.id)}/publish`, {
      headers: { 'idempotency-key': 'pub' },
    })
    assert.equal(published.status, 200)

    const withdrawn = await h.call(
      'POST',
      `/projects/${projectId}/question-versions/${String(version.id)}/withdraw?reason=${encodeURIComponent('录错了')}`,
      { headers: { 'idempotency-key': 'wd-1' } },
    )
    assert.equal(withdrawn.status, 200)
    assert.equal(withdrawn.body.status, 'withdrawn')

    const replay = await h.call(
      'POST',
      `/projects/${projectId}/question-versions/${String(version.id)}/withdraw?reason=${encodeURIComponent('录错了')}`,
      { headers: { 'idempotency-key': 'wd-1' } },
    )
    assert.equal(replay.status, 200)
    assert.equal(replay.body.id, withdrawn.body.id)

    const conflict = await h.call(
      'POST',
      `/projects/${projectId}/question-versions/${String(version.id)}/withdraw?reason=${encodeURIComponent('另一个原因')}`,
      { headers: { 'idempotency-key': 'wd-1' } },
    )
    assert.equal(conflict.status, 409, 'the reason is part of the fingerprint, so a different one conflicts')
    assert.equal(conflict.body.error.code, 'idempotency_conflict')
  } finally {
    h.close()
  }
})
