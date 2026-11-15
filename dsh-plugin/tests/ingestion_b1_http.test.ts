import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { startTextImport } from '../src/services/ingestion_imports.ts'
import { StructureInvalid } from '../src/services/errors.ts'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'

/** One labelled template that parses to exactly one publishable candidate (type declared first). */
const ONE_QUESTION = '【题型】单选\n【题干】下列哪项是质数？\n【选项】\nA. 4\nB. 7\nC. 9\n【答案】B\n'
/** Stem first: Django closes the stem at `【题型】`, so this yields a draft + a ready candidate. */
const SPLIT_QUESTION =
  '【题干】下列哪项是质数？\n【题型】单选\n【选项】\nA. 4\nB. 7\nC. 9\n【答案】B\n'

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

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
  const projectId = String(createProject(db, userId, { name: '题库导入' }, NOW).id)
  const subjectId = String(
    createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id,
  )
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
  const rows = (table: string, where: Record<string, unknown> = {}): Record<string, unknown>[] =>
    findRows(db, table, where)
  const patch = (table: string, id: unknown, values: Record<string, unknown>): void => {
    updateRow(db, table, id, values, { now })
  }
  return {
    db,
    userId,
    projectId,
    subjectId,
    call,
    counts,
    rows,
    patch,
    setNow: (value: Instant) => {
      now = value
    },
    close: handle.close,
  }
}

function importJob(h: ReturnType<typeof harness>, key: string, text = ONE_QUESTION, extra: Record<string, unknown> = {}) {
  return h.call('POST', `/projects/${h.projectId}/imports`, { text, ...extra }, { 'idempotency-key': key })
}

function oneCandidateId(h: ReturnType<typeof harness>, jobId: string): string {
  const candidates = h.rows('ingestion_import_candidate', { job_id: jobId })
  assert.equal(candidates.length, 1)
  return String(candidates[0].id)
}

// --------------------------------------------------------------------------
// O03 / O04 — source documents
// --------------------------------------------------------------------------

test('ingestion B1: O04 stores the raw text, caps metadata and returns the document shape', async () => {
  const h = harness()
  try {
    const text = `  ${ONE_QUESTION}  `
    const response = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, {
      text,
      subject_id: h.subjectId,
      title: '题'.repeat(301),
      source_note: '注'.repeat(501),
      usage_scope: '用'.repeat(201),
    })
    assert.equal(response.status, 201)
    assert.deepEqual(Object.keys(response.body).sort(), [
      'asset_id',
      'checksum',
      'document_type',
      'id',
      'project_id',
      'raw_text_preview',
      'role',
      'sensitivity',
      'source_note',
      'source_type',
      'subject_id',
      'title',
      'usage_scope',
    ])
    assert.equal(response.body.project_id, h.projectId)
    assert.equal(response.body.subject_id, h.subjectId)
    assert.equal(response.body.document_type, 'text')
    assert.equal(response.body.role, 'past_paper_page')
    assert.equal(response.body.sensitivity, 'public_to_owner')
    assert.equal(response.body.source_type, 'user_paste')
    assert.equal(response.body.asset_id, null)
    assert.equal(response.body.checksum, sha256(text), 'checksum is sha256 of the UTF-8 bytes')
    assert.equal(response.body.title.length, 300, 'title is truncated to 300 code points')
    assert.equal(response.body.source_note.length, 500)
    assert.equal(response.body.usage_scope.length, 200)

    const stored = h.rows('ingestion_source_document', { id: response.body.id })[0]
    assert.equal(stored.raw_text, text, 'the raw original is stored unchanged')
    assert.equal((stored.page_texts as unknown[]).length, 0)
    assert.equal(stored.page_count, 1)
  } finally {
    h.close()
  }
})

test('ingestion B1: O04 rejects blank text and a subject outside the project', async () => {
  const h = harness()
  try {
    const blank = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, {
      text: ' \n\t　 ',
    })
    assert.equal(blank.status, 400)
    assert.equal(blank.body.error.code, 'invalid_input')
    assert.equal(blank.body.error.message, '文本内容不能为空')

    const foreign = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, {
      text: 'x',
      subject_id: 'no-such-subject',
    })
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error.message, '科目不存在或不属于该项目')

    assert.equal(h.counts()['ingestion_source_document'], 0)
  } finally {
    h.close()
  }
})

test('ingestion B1: O03 lists newest first, filters by subject and clamps the limit', async () => {
  const h = harness()
  try {
    const first = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, {
      text: '第一份',
      subject_id: h.subjectId,
    })
    const second = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, { text: '第二份' })
    h.patch('ingestion_source_document', first.body.id, { created_at: NOW - 3_600_000_000n })
    h.patch('ingestion_source_document', second.body.id, { created_at: NOW })

    const all = await h.call('GET', `/projects/${h.projectId}/source-documents`)
    assert.equal(all.status, 200)
    assert.deepEqual(
      all.body.map((row: any) => row.id),
      [second.body.id, first.body.id],
      'created_at DESC',
    )

    const filtered = await h.call(
      'GET',
      `/projects/${h.projectId}/source-documents?subject_id=${h.subjectId}`,
    )
    assert.deepEqual(filtered.body.map((row: any) => row.id), [first.body.id])

    const one = await h.call('GET', `/projects/${h.projectId}/source-documents?limit=1`)
    assert.equal(one.body.length, 1)
    const zero = await h.call('GET', `/projects/${h.projectId}/source-documents?limit=0`)
    assert.equal(zero.body.length, 1, 'limit is clamped to at least 1')
    const negative = await h.call('GET', `/projects/${h.projectId}/source-documents?limit=-5`)
    assert.equal(negative.body.length, 1)
    const over = await h.call('GET', `/projects/${h.projectId}/source-documents?limit=101`)
    assert.equal(over.body.length, 2, 'limit is clamped to 100 but there are only two rows')

    const invalid = await h.call('GET', `/projects/${h.projectId}/source-documents?limit=abc`)
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.message, '请求参数校验失败')
    assert.deepEqual(invalid.body.error.details.errors, [
      {
        type: 'int_parsing',
        loc: ['query', 'limit'],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
      },
    ])

    const foreign = await h.call('GET', '/projects/no-such-project/source-documents')
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error.message, '项目不存在或无权访问')
  } finally {
    h.close()
  }
})

// --------------------------------------------------------------------------
// O07 — text import
// --------------------------------------------------------------------------

test('ingestion B1: O07 creates the document, job, region and candidate in one transaction', async () => {
  const h = harness()
  try {
    const response = await importJob(h, 'k1', ONE_QUESTION, { subject_id: h.subjectId })
    assert.equal(response.status, 201)
    const job = response.body
    assert.equal(job.project_id, h.projectId)
    assert.equal(job.subject_id, h.subjectId)
    assert.equal(job.status, 'awaiting_review')
    assert.equal(job.input_kind, 'text')
    assert.equal(job.extractor_version, 'text-structure-v1')
    assert.equal(job.progress_percent, 0)
    assert.deepEqual(job.problems, [])
    assert.equal(job.attempts, 0)
    assert.equal(job.max_attempts, 3)
    assert.equal(job.last_error, '')
    assert.equal(job.duplicate_of_job_id, null)
    assert.equal(job.candidate_count, 1)
    assert.deepEqual(job.candidate_status_counts, { ready: 1 })
    assert.equal(job.document_ids.length, 1)
    assert.deepEqual(job.page_diagnostics, [])
    assert.match(job.created_at, /^2026-08-01T00:00:00\+00:00$/)

    const document = h.rows('ingestion_source_document', { id: job.document_ids[0] })[0]
    assert.equal(document.raw_text, ONE_QUESTION)
    assert.equal(document.document_type, 'text')

    const candidate = h.rows('ingestion_import_candidate', { job_id: job.id })[0]
    assert.equal(candidate.status, 'ready')
    assert.equal(candidate.revision, 1)
    assert.equal(candidate.subject_id, h.subjectId)
    assert.deepEqual(candidate.review_issues, [])
    assert.equal(candidate.extractor_version, 'text-structure-v1')
    assert.equal((candidate.machine_payload as Record<string, unknown>).question_type, 'single_choice')

    const detail = await h.call('GET', `/projects/${h.projectId}/import-candidates/${candidate.id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.source_regions.length, 1)
    const region = detail.body.source_regions[0]
    assert.equal(region.document_id, job.document_ids[0])
    assert.equal(region.document_title, '')
    assert.equal(region.document_type, 'text')
    assert.equal(region.document_asset_id, null)
    assert.equal(region.page_index, 1)
    assert.equal(region.x, 0)
    assert.equal(region.y, 0)
    assert.equal(region.width, 1)
    assert.equal(region.height, 0.05)
    assert.equal(region.role, 'stem_crop')
    assert.equal(region.text_span, '下列哪项是质数？')

    const storedRegion = h.rows('ingestion_source_region', { id: region.id })[0]
    const expectedStart = Array.from(ONE_QUESTION).indexOf('下')
    assert.equal(storedRegion.char_start, expectedStart)
    assert.equal(storedRegion.char_end, expectedStart + Array.from('下列哪项是质数？').length)
  } finally {
    h.close()
  }
})

test('ingestion B1: O07 is idempotent: replay, trimmed key, conflict and key validation', async () => {
  const h = harness()
  try {
    const first = await importJob(h, 'key-1')
    assert.equal(first.status, 201)

    const replay = await importJob(h, 'key-1')
    assert.equal(replay.status, 201)
    assert.deepEqual(replay.body, first.body, 'a replay returns the stored body, ids included')
    assert.equal(h.counts()['ingestion_import_job'], 1, 'the replay creates no second job')

    const trimmed = await h.call(
      'POST',
      `/projects/${h.projectId}/imports`,
      { text: ONE_QUESTION },
      { 'idempotency-key': '   key-1   ' },
    )
    assert.equal(trimmed.status, 201)
    assert.deepEqual(trimmed.body, first.body, 'the header is trimmed, so this is the same key')

    const conflict = await importJob(h, 'key-1', SPLIT_QUESTION)
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'idempotency_conflict')
    assert.equal(conflict.body.error.message, '相同幂等键使用了不同请求内容')
    assert.deepEqual(conflict.body.error.details, {
      route_scope: `imports.create:${h.projectId}`,
      reason: 'same_key_different_payload',
    })

    const missing = await h.call('POST', `/projects/${h.projectId}/imports`, { text: ONE_QUESTION })
    assert.equal(missing.status, 409)
    assert.equal(missing.body.error.code, 'idempotency_conflict')
    assert.equal(missing.body.error.message, '缺少 Idempotency-Key 请求头')

    const tooLong = await h.call(
      'POST',
      `/projects/${h.projectId}/imports`,
      { text: ONE_QUESTION },
      { 'idempotency-key': 'k'.repeat(201) },
    )
    assert.equal(tooLong.status, 409)
    assert.equal(tooLong.body.error.message, 'Idempotency-Key 过长')

    const exact = await h.call(
      'POST',
      `/projects/${h.projectId}/imports`,
      { text: ONE_QUESTION },
      { 'idempotency-key': 'k'.repeat(200) },
    )
    assert.equal(exact.status, 201, '200 code points is still accepted')
  } finally {
    h.close()
  }
})

test('ingestion B1: O07 recognises a duplicate input without reusing the job', async () => {
  const h = harness()
  try {
    const first = await importJob(h, 'dup-1')
    const second = await importJob(h, 'dup-2')
    assert.equal(second.status, 201)
    assert.equal(second.body.duplicate_of_job_id, first.body.id)
    assert.equal(second.body.problems.length, 1)
    assert.equal(second.body.problems[0].code, 'duplicate_input')
    assert.equal(second.body.problems[0].severity, 'warning')
    assert.equal(second.body.problems[0].duplicate_job_id, first.body.id)
    assert.equal(h.counts()['ingestion_import_job'], 2, 'a duplicate is recorded, not merged')
    assert.equal(h.counts()['ingestion_import_candidate'], 2)
  } finally {
    h.close()
  }
})

test('ingestion B1: O07 parse=false keeps the raw document and reports no recognised segment', async () => {
  const h = harness()
  try {
    const response = await importJob(h, 'noparse', ONE_QUESTION, { parse: false })
    assert.equal(response.status, 201)
    assert.equal(response.body.candidate_count, 0)
    assert.equal(response.body.status, 'awaiting_review')
    assert.deepEqual(
      response.body.problems.map((problem: any) => problem.code),
      ['no_recognised_segment'],
    )
    const document = h.rows('ingestion_source_document', { id: response.body.document_ids[0] })[0]
    assert.equal(document.raw_text, ONE_QUESTION, 'the original is still stored')

    // `parse` is coerced by pydantic before the idempotency fingerprint: the string "false" and the
    // boolean false are the same normalized payload, so the second call replays instead of conflicting.
    const stringFalse = await h.call(
      'POST',
      `/projects/${h.projectId}/imports`,
      { text: ONE_QUESTION, parse: 'false' },
      { 'idempotency-key': 'coerced-parse' },
    )
    assert.equal(stringFalse.status, 201)
    assert.equal(stringFalse.body.candidate_count, 0)
    const boolFalse = await h.call(
      'POST',
      `/projects/${h.projectId}/imports`,
      { text: ONE_QUESTION, parse: false },
      { 'idempotency-key': 'coerced-parse' },
    )
    assert.equal(boolFalse.status, 201)
    assert.deepEqual(boolFalse.body, stringFalse.body)
  } finally {
    h.close()
  }
})

test('ingestion B1: O07 rejects blank text and releases the idempotency claim', async () => {
  const h = harness()
  try {
    const rejected = await importJob(h, 'blank-key', '   ')
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error.message, '文本内容不能为空')
    assert.equal(h.counts()['audit_idempotency_record'], 0, 'a failed request leaves no claim behind')
    assert.equal(h.counts()['ingestion_import_job'], 0)
    assert.equal(h.counts()['ingestion_source_document'], 0)

    // The released key can be reused with a different, valid body — Django's middleware deletes the
    // unfulfilled claim on a 4xx, so this is not a `same_key_different_payload` conflict.
    const retried = await importJob(h, 'blank-key', ONE_QUESTION)
    assert.equal(retried.status, 201)
    assert.equal(h.counts()['ingestion_import_job'], 1)
  } finally {
    h.close()
  }
})

test('ingestion B1: O07 rolls back the whole batch when a region leaves the page', () => {
  const h = harness()
  try {
    // `y = min(.99, index * .05)` at index 20 gives .99 + .05 > 1.0001, so the 21st region fails
    // `full_clean` and the surrounding transaction must undo document/job/regions/candidates.
    const segments = Array.from({ length: 21 }, (_, index) => ({
      question_type: 'single_choice',
      display_label: String(index + 1),
      content: { blocks: [{ kind: 'text', text: `题目${index + 1}` }], options: [] },
      answer_payload: {},
      answer_status_known: false,
      explanation_blocks: [],
      source_excerpt: `题目${index + 1}`,
      parse_issues: [],
      practice_max_score: null,
    }))
    const text = segments.map((segment) => segment.source_excerpt).join('\n')
    const before = h.counts()
    assert.throws(
      () =>
        startTextImport(
          h.db,
          {
            ownerId: h.userId,
            projectId: h.projectId,
            subjectId: null,
            text,
            segments: segments as never,
          },
          NOW,
        ),
      (error: unknown) => {
        assert.ok(error instanceof StructureInvalid)
        assert.equal(error.statusCode, 422)
        assert.deepEqual(error.details, { errors: { width: ['区域超出页面范围'] } })
        return true
      },
    )
    assert.deepEqual(h.counts(), before, 'the failed batch writes nothing')
  } finally {
    h.close()
  }
})

// --------------------------------------------------------------------------
// O10–O13 — job reads and retry
// --------------------------------------------------------------------------

test('ingestion B1: O10 filters by the raw status value and clamps the limit', async () => {
  const h = harness()
  try {
    const first = await importJob(h, 'list-1')
    h.setNow(NOW + 60_000_000n)
    const second = await importJob(h, 'list-2', SPLIT_QUESTION)
    const listing = await h.call('GET', `/projects/${h.projectId}/imports`)
    assert.deepEqual(
      listing.body.map((job: any) => job.id),
      [second.body.id, first.body.id],
      'created_at DESC',
    )
    const filtered = await h.call('GET', `/projects/${h.projectId}/imports?status=awaiting_review`)
    assert.equal(filtered.body.length, 2)
    const nonsense = await h.call('GET', `/projects/${h.projectId}/imports?status=not-a-status`)
    assert.deepEqual(nonsense.body, [], 'the filter value is not validated against the enum')
    const zero = await h.call('GET', `/projects/${h.projectId}/imports?limit=0`)
    assert.equal(zero.body.length, 1)
    const invalid = await h.call('GET', `/projects/${h.projectId}/imports?limit=1.5`)
    assert.equal(invalid.status, 400)
    assert.deepEqual(invalid.body.error.details.errors[0].loc, ['query', 'limit'])
  } finally {
    h.close()
  }
})

test('ingestion B1: O11 hides a job from another project or an unknown id', async () => {
  const h = harness()
  try {
    const response = await h.call('GET', `/projects/${h.projectId}/imports/no-such-job`)
    assert.equal(response.status, 404)
    assert.deepEqual(response.body.error, {
      code: 'not_found',
      message: '导入任务不存在或不属于该项目',
      details: {},
      request_id: 'req-fixed',
    })
  } finally {
    h.close()
  }
})

test('ingestion B1: O12 retries only failed jobs, preserves finished_at and is idempotent', async () => {
  const h = harness()
  try {
    const created = await importJob(h, 'retry-source')
    const jobId = created.body.id
    const notFailed = await h.call('POST', `/projects/${h.projectId}/imports/${jobId}/retry`, undefined, {
      'idempotency-key': 'retry-1',
    })
    assert.equal(notFailed.status, 400)
    assert.equal(notFailed.body.error.message, '只有失败或已取消的任务可以重试')

    const finishedAt = NOW - 7_200_000_000n
    h.patch('ingestion_import_job', jobId, {
      status: 'failed',
      last_error: 'boom',
      attempts: 0,
      max_attempts: 3,
      started_at: NOW - 10_000_000_000n,
      finished_at: finishedAt,
    })
    const retried = await h.call('POST', `/projects/${h.projectId}/imports/${jobId}/retry`, undefined, {
      'idempotency-key': 'retry-2',
    })
    assert.equal(retried.status, 200)
    assert.equal(retried.body.attempts, 1)
    assert.equal(retried.body.status, 'awaiting_review')
    assert.equal(retried.body.last_error, '')
    assert.equal(retried.body.problems.at(-1).code, 'retried')
    assert.equal(retried.body.problems.at(-1).message, '任务已重试（第 1 次），复用原有来源与候选。')
    const stored = h.rows('ingestion_import_job', { id: jobId })[0]
    assert.equal(stored.finished_at, finishedAt, 'retry does not clear finished_at')
    assert.equal(h.rows('ingestion_import_candidate', { job_id: jobId }).length, 1, 'candidates are reused')
    assert.equal(h.rows('audit_content_revision', {}).length, 0, 'retry writes no ContentRevision')

    const replay = await h.call('POST', `/projects/${h.projectId}/imports/${jobId}/retry`, undefined, {
      'idempotency-key': 'retry-2',
    })
    assert.deepEqual(replay.body, retried.body)

    h.patch('ingestion_import_job', jobId, { status: 'failed', attempts: 3, max_attempts: 3 })
    const capped = await h.call('POST', `/projects/${h.projectId}/imports/${jobId}/retry`, undefined, {
      'idempotency-key': 'retry-3',
    })
    assert.equal(capped.status, 400)
    assert.equal(capped.body.error.message, '已重试 3 次，达到上限；请新建导入任务')
  } finally {
    h.close()
  }
})

test('ingestion B1: O13 lists candidates by job/status in created_at order', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'cand-list', SPLIT_QUESTION, { subject_id: h.subjectId })
    assert.equal(job.body.candidate_count, 2)
    const listing = await h.call('GET', `/projects/${h.projectId}/import-candidates`)
    assert.equal(listing.body.length, 2)
    assert.deepEqual(
      listing.body.map((candidate: any) => candidate.id),
      h
        .rows('ingestion_import_candidate', { job_id: job.body.id })
        .sort((a, b) => Number((a.created_at as bigint) - (b.created_at as bigint)))
        .map((candidate) => String(candidate.id)),
    )
    const byJob = await h.call(
      'GET',
      `/projects/${h.projectId}/import-candidates?job_id=${job.body.id}`,
    )
    assert.equal(byJob.body.length, 2)
    const drafts = await h.call('GET', `/projects/${h.projectId}/import-candidates?status=draft`)
    assert.equal(drafts.body.length, 1)
    assert.equal(drafts.body[0].status, 'draft')
    const foreignJob = await h.call(
      'GET',
      `/projects/${h.projectId}/import-candidates?job_id=no-such-job`,
    )
    assert.deepEqual(foreignJob.body, [], 'a foreign job id is only a filter, never a 404')
    const limited = await h.call('GET', `/projects/${h.projectId}/import-candidates?limit=1`)
    assert.equal(limited.body.length, 1)
  } finally {
    h.close()
  }
})

// --------------------------------------------------------------------------
// O14 / O15 — candidate detail and edit
// --------------------------------------------------------------------------

function publishQuestionFor(h: ReturnType<typeof harness>, label = 'Q1'): { questionId: string; versionId: string } {
  const questionId = String(
    insertRow(
      h.db,
      'question_bank_question',
      {
        subject_id: h.subjectId,
        origin_type: 'user_authored',
        current_published_version_id: null,
        family_id: null,
        content_lineage_id: null,
        created_by_id: h.userId,
        is_demo: false,
        display_label: label,
      },
      { now: NOW },
    ).id,
  )
  const versionId = String(
    insertRow(
      h.db,
      'question_bank_question_version',
      {
        question_id: questionId,
        version: 1,
        question_type: 'single_choice',
        content: { blocks: [{ kind: 'text', text: '旧题' }], options: [] },
        parent_material_version_id: null,
        material_child_version_ids: [],
        practice_max_score: null,
        estimated_seconds: null,
        status: 'published',
        revision_reason: '',
        source_note: '',
        created_by_id: h.userId,
        published_at: NOW,
        withdrawn_at: null,
        withdrawn_reason: '',
        content_digest: '',
      },
      { now: NOW },
    ).id,
  )
  h.patch('question_bank_question', questionId, { current_published_version_id: versionId })
  return { questionId, versionId }
}

test('ingestion B1: O14 records one editorial exposure per candidate/question pair', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'exposure', ONE_QUESTION, { subject_id: h.subjectId })
    const candidateId = oneCandidateId(h, job.body.id)
    const before = await h.call('GET', `/projects/${h.projectId}/import-candidates/${candidateId}`)
    assert.equal(before.status, 200)
    assert.equal(h.counts()['practice_exposure_event'], 0, 'nothing published has been looked at yet')

    const { questionId, versionId } = publishQuestionFor(h)
    h.patch('ingestion_import_candidate', candidateId, {
      publication_question_id: questionId,
      publication_version_id: versionId,
    })
    const opened = await h.call('GET', `/projects/${h.projectId}/import-candidates/${candidateId}`)
    assert.equal(opened.status, 200)
    const exposures = h.rows('practice_exposure_event', {})
    assert.equal(exposures.length, 1)
    const exposure = exposures[0]
    assert.equal(exposure.kind, 'editorial_preview')
    assert.equal(exposure.purpose, 'editorial')
    assert.equal(exposure.source, 'ingestion.candidate_detail')
    assert.equal(exposure.reveals_answer, true)
    assert.equal(exposure.question_id, questionId)
    assert.equal(exposure.question_version_id, versionId)
    const detail = exposure.detail as Record<string, unknown>
    assert.equal(detail.candidate_id, candidateId)
    assert.equal(detail.candidate_status, 'ready')
    assert.equal(detail.published_question, true)
    assert.equal(detail.note, '')

    await h.call('GET', `/projects/${h.projectId}/import-candidates/${candidateId}`)
    assert.equal(h.counts()['practice_exposure_event'], 1, 'reopening reuses the row')
  } finally {
    h.close()
  }
})

test('ingestion B1: O15 bumps the revision, snapshots the pre-refresh issues and audits the edit', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'patch', SPLIT_QUESTION)
    const candidates = await h.call('GET', `/projects/${h.projectId}/import-candidates`)
    const draft = candidates.body.find((candidate: any) => candidate.status === 'draft')
    assert.ok(draft)
    assert.ok(draft.review_issues.length > 0, 'the stem-only candidate starts blocked')

    const replacement = { ...draft.draft_payload, practice_max_score: '5' }
    const patched = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${draft.id}`,
      { draft_payload: replacement, expected_revision: 1, note: '补分值' },
    )
    assert.equal(patched.status, 200)
    assert.equal(patched.body.revision, 2)
    assert.deepEqual(patched.body.draft_payload, replacement, 'draft_payload is replaced, not merged')

    const revisions = h.rows('ingestion_candidate_revision', { candidate_id: draft.id })
    assert.equal(revisions.length, 1)
    assert.equal(revisions[0].revision, 2)
    assert.deepEqual(revisions[0].payload, replacement)
    assert.deepEqual(
      revisions[0].review_issues,
      draft.review_issues,
      'the snapshot keeps the issues the reviewer was looking at before the edit',
    )
    assert.equal(revisions[0].note, '补分值')

    const audits = h.rows('audit_content_revision', { entity_id: draft.id })
    assert.equal(audits.length, 1)
    assert.equal(audits[0].entity_type, 'import_candidate')
    assert.equal(audits[0].action, 'proofread')
    assert.deepEqual(audits[0].detail, { revision: 2 })

    const emptyPatch = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${draft.id}`,
      {},
    )
    assert.equal(emptyPatch.status, 200)
    assert.equal(emptyPatch.body.revision, 3, 'even an empty patch is a revision')
  } finally {
    h.close()
  }
})

test('ingestion B1: O15 rejects a stale revision, a published candidate and a foreign subject', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'patch-errors')
    const candidateId = oneCandidateId(h, job.body.id)

    const conflict = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${candidateId}`,
      { expected_revision: 9 },
    )
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'version_conflict')
    assert.deepEqual(conflict.body.error.details, { expected: 9, actual: 1 })

    h.patch('ingestion_import_candidate', candidateId, { status: 'published' })
    const published = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${candidateId}`,
      { draft_payload: {} },
    )
    assert.equal(published.status, 400)
    assert.equal(published.body.error.message, '已发布的候选不能继续修改；请为已发布题目创建新版本')

    h.patch('ingestion_import_candidate', candidateId, { status: 'draft' })
    const foreign = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${candidateId}`,
      { subject_id: 'no-such-subject' },
    )
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error.message, '科目不存在或不属于该项目')
  } finally {
    h.close()
  }
})

// --------------------------------------------------------------------------
// O16 / O17 — ignore and layout confirmation
// --------------------------------------------------------------------------

test('ingestion B1: O16 ignores without a revision bump, audits the reason and completes the job', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'ignore')
    const candidateId = oneCandidateId(h, job.body.id)
    const ignored = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidateId}/ignore?reason=重复录入`,
      undefined,
      { 'idempotency-key': 'ignore-1' },
    )
    assert.equal(ignored.status, 200)
    assert.equal(ignored.body.status, 'ignored')
    assert.equal(ignored.body.revision, 1, 'ignore is a decision, not an edit')
    assert.equal(h.rows('ingestion_import_candidate', { id: candidateId })[0].reviewed_at, null)

    const audits = h.rows('audit_content_revision', { entity_id: candidateId })
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'ignore')
    assert.equal(audits[0].reason, '重复录入')

    const storedJob = h.rows('ingestion_import_job', { id: job.body.id })[0]
    assert.equal(storedJob.status, 'completed', 'the only candidate is decided')
    assert.equal(storedJob.progress_percent, 100)
    assert.ok(storedJob.finished_at !== null)

    const replay = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidateId}/ignore?reason=重复录入`,
      undefined,
      { 'idempotency-key': 'ignore-1' },
    )
    assert.deepEqual(replay.body, ignored.body)
    assert.equal(h.rows('audit_content_revision', { entity_id: candidateId }).length, 1)

    const different = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidateId}/ignore?reason=别的理由`,
      undefined,
      { 'idempotency-key': 'ignore-1' },
    )
    assert.equal(different.status, 409)
    assert.deepEqual(different.body.error.details, {
      route_scope: `candidates.ignore:${candidateId}`,
      reason: 'same_key_different_payload',
    })
  } finally {
    h.close()
  }
})

test('ingestion B1: O16 refuses a published candidate', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'ignore-published')
    const candidateId = oneCandidateId(h, job.body.id)
    h.patch('ingestion_import_candidate', candidateId, { status: 'published' })
    const response = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidateId}/ignore`,
      undefined,
      { 'idempotency-key': 'ignore-pub' },
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.error.message, '已发布候选不能标记为忽略')
  } finally {
    h.close()
  }
})

test('ingestion B1: O17 confirms layout, audits the pages and does not bump the revision', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'layout', SPLIT_QUESTION)
    const candidates = await h.call('GET', `/projects/${h.projectId}/import-candidates`)
    const candidate = candidates.body[0]
    const confirmed = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidate.id}/layout-confirm`,
      { note: '对照原页确认' },
      { 'idempotency-key': 'layout-1' },
    )
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.revision, candidate.revision, 'confirmation is not an edit')
    assert.match(confirmed.body.layout_review_confirmed_at, /^2026-08-01T00:00:00\+00:00$/)
    assert.equal(confirmed.body.layout_review_note, '对照原页确认')

    const audits = h.rows('audit_content_revision', { entity_id: candidate.id })
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'layout_confirm')
    assert.equal(audits[0].reason, '对照原页确认')
    const auditDetail = audits[0].detail as Record<string, unknown>
    assert.deepEqual(auditDetail.pages, [
      { document_id: confirmed.body.source_regions[0].document_id, page_index: 1 },
    ])
    assert.deepEqual(auditDetail.continues_on_pages, [])

    const replay = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidate.id}/layout-confirm`,
      { note: '对照原页确认' },
      { 'idempotency-key': 'layout-1' },
    )
    assert.deepEqual(replay.body, confirmed.body)

    h.patch('ingestion_import_candidate', candidate.id, { status: 'ignored' })
    const ignoredConfirm = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidate.id}/layout-confirm`,
      { note: 'x' },
      { 'idempotency-key': 'layout-2' },
    )
    assert.equal(ignoredConfirm.status, 200, 'an ignored candidate may still be confirmed')

    h.patch('ingestion_import_candidate', candidate.id, { status: 'published' })
    const published = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidate.id}/layout-confirm`,
      { note: 'x' },
      { 'idempotency-key': 'layout-3' },
    )
    assert.equal(published.status, 400)
    assert.equal(published.body.error.message, '已发布的候选无需再确认版式')
  } finally {
    h.close()
  }
})

// --------------------------------------------------------------------------
// Schema validation
// --------------------------------------------------------------------------

test('ingestion B1: body schemas reject with the Ninja error shape', async () => {
  const h = harness()
  try {
    const job = await importJob(h, 'validation')
    const candidateId = oneCandidateId(h, job.body.id)

    const missingText = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, {})
    assert.equal(missingText.status, 400)
    assert.equal(missingText.body.error.message, '请求参数校验失败')
    assert.deepEqual(missingText.body.error.details.errors, [
      { type: 'missing', loc: ['body', 'payload', 'text'], msg: 'Field required' },
    ])

    const wrongText = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, { text: 5 })
    assert.deepEqual(wrongText.body.error.details.errors, [
      { type: 'string_type', loc: ['body', 'payload', 'text'], msg: 'Input should be a valid string' },
    ])

    const arrayBody = await h.call('POST', `/projects/${h.projectId}/source-documents/text`, [1])
    assert.deepEqual(
      arrayBody.body.error.details.errors,
      [{ type: 'missing', loc: ['body', 'payload', 'text'], msg: 'Field required' }],
      'Ninja coerces a non-object body to an empty object, so the required field is missing',
    )

    const noBody = await h.call('POST', `/projects/${h.projectId}/source-documents/text`)
    assert.deepEqual(noBody.body.error.details.errors, [
      { type: 'missing', loc: ['body', 'payload'], msg: 'Field required' },
    ])

    const draftArray = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${candidateId}`,
      { draft_payload: [1] },
    )
    assert.equal(draftArray.status, 400)
    assert.deepEqual(draftArray.body.error.details.errors, [
      { type: 'dict_type', loc: ['body', 'payload', 'draft_payload'], msg: 'Input should be a valid dictionary' },
    ])

    const fractional = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${candidateId}`,
      { expected_revision: 1.5 },
    )
    assert.deepEqual(fractional.body.error.details.errors, [
      {
        type: 'int_from_float',
        loc: ['body', 'payload', 'expected_revision'],
        msg: 'Input should be a valid integer, got a number with a fractional part',
      },
    ])

    const arrayRevision = await h.call(
      'PATCH',
      `/projects/${h.projectId}/import-candidates/${candidateId}`,
      { expected_revision: [] },
    )
    assert.deepEqual(arrayRevision.body.error.details.errors, [
      { type: 'int_type', loc: ['body', 'payload', 'expected_revision'], msg: 'Input should be a valid integer' },
    ])

    const noteInt = await h.call(
      'POST',
      `/projects/${h.projectId}/import-candidates/${candidateId}/layout-confirm`,
      { note: 5 },
      { 'idempotency-key': 'layout-validation' },
    )
    assert.equal(noteInt.status, 400)
    assert.deepEqual(noteInt.body.error.details.errors, [
      { type: 'string_type', loc: ['body', 'payload', 'note'], msg: 'Input should be a valid string' },
    ])
  } finally {
    h.close()
  }
})

test('ingestion B1: a malformed body wins over a foreign project, like Ninja validation', async () => {
  const h = harness()
  try {
    const response = await h.call('POST', '/projects/no-such-project/imports', { text: 5 }, {
      'idempotency-key': 'x',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(response.body.error.details.errors, [
      { type: 'string_type', loc: ['body', 'payload', 'text'], msg: 'Input should be a valid string' },
    ])
  } finally {
    h.close()
  }
})
