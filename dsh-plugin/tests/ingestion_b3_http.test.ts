/**
 * O01 / O02 / O05 / O08 over HTTP: private assets, gated downloads and image imports.
 *
 * Every case mirrors a recorded request from `scripts/probe_ingestion_b3.py` (real Django, 64
 * cases): status code, error envelope, response projection and the row-level effect are pinned to
 * what the Django API returned, not to what this port would like to return.
 *
 * The multipart bodies are built with the platform `FormData`/`File`, i.e. a real
 * `multipart/form-data` body with a generated boundary — not a hand-rolled string. That is the point
 * of the batch: the Django endpoints take `UploadedFile`, so "the transport can decode a real upload"
 * is a claim that has to be exercised through the same parser a browser would hit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import { configureStorage, getStorage, resetStorageCache } from '../src/ingestion/storage.ts'
import { startImageImport } from '../src/services/ingestion_imports.ts'
import { createImageDocument, prepareAssetImage } from '../src/services/ingestion_sources.ts'
import { loadSharp } from '../src/ingestion/sharp.ts'

const NOW = parseInstant('2026-09-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'
const MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'acepass-b3-http-'))
configureStorage(MEDIA_ROOT)
process.on('exit', () => {
  resetStorageCache()
  rmSync(MEDIA_ROOT, { recursive: true, force: true })
})

const sharp = loadSharp() as unknown as (input: unknown, options?: Record<string, unknown>) => any

async function pngBytes(width = 32, height = 24, colour = { r: 20, g: 40, b: 60 }): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer(),
  )
}

async function jpegBytes(width = 32, height = 24): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: 90, g: 10, b: 10 } } }).jpeg().toBuffer())
}

const GIF_BYTES = new Uint8Array([
  ...Buffer.from('GIF87a'), 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
])
const TEXT_BYTES = new Uint8Array(Buffer.from('这是一段非图片的原始字节。'))

/** Fill every NOT NULL column a fixture does not care about; FK columns must be provided. */
function insertFixture(
  db: ReturnType<typeof openStore>['db'],
  table: string,
  overrides: Record<string, unknown>,
): Record<string, any> {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const row: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey || column.name in overrides) continue
    if (!column.notNull) continue
    if (foreignKeys.has(column.name)) throw new Error(`${table}.${column.name} needs a real id`)
    row[column.name] = column.json ? {} : column.kind === 'datetime' ? NOW : column.kind === 'int' || column.kind === 'bool' ? 0 : ''
  }
  Object.assign(row, overrides)
  return insertRow(db, table, row, { now: NOW })
}

interface Harness {
  db: ReturnType<typeof openStore>['db']
  userId: string
  projectId: string
  otherProjectId: string
  subjectId: string
  otherSubjectId: string
  send: (request: Request) => Promise<Response>
}

function harness(): Harness {
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
  const projectId = String(createProject(db, userId, { name: '私有素材' }, NOW).id)
  const otherProjectId = String(createProject(db, userId, { name: '别的项目' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id)
  const otherSubjectId = String(createSubject(db, userId, otherProjectId, { name: '物理', code: 'PHY' }, NOW).id)
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId, now: NOW }),
  })
  return { db, userId, projectId, otherProjectId, subjectId, otherSubjectId, send: handler }
}

interface UploadSpec {
  field?: string
  name: string
  type: string
  bytes: Uint8Array
}

async function upload(
  url: string,
  options: { files?: UploadSpec[]; form?: Record<string, string | string[]>; key?: string },
): Promise<Request> {
  const body = new FormData()
  for (const [field, value] of Object.entries(options.form ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(field, item)
  }
  for (const file of options.files ?? []) {
    // A `Uint8Array` is a valid `BlobPart` at run time; the DOM lib's `ArrayBufferView` generic
    // does not accept the `ArrayBufferLike` backing store, hence the cast.
    body.append(file.field ?? 'file', new File([file.bytes as unknown as BlobPart], file.name, { type: file.type }))
  }
  const headers = new Headers()
  if (options.key !== undefined) headers.set('idempotency-key', options.key)
  return new Request(`${BASE}${url}`, { method: 'POST', body, headers })
}

function get(url: string): Request {
  return new Request(`${BASE}${url}`, { method: 'GET' })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The asset row's stored bytes, read from the private root (never through the HTTP surface). */
function storedBytes(asset: Record<string, any>): Buffer {
  return getStorage().open(String(asset.object_key))
}

/** `{namespace, token length, suffix, segment count}` — the key's shape without the random token. */
function keyShape(key: string): Record<string, unknown> {
  const parts = key.split('/')
  const file = parts[parts.length - 1]
  const token = file.split('.')[0]
  return {
    namespace: parts[parts.length - 3],
    segments: parts.length,
    token_len: token.length,
    prefix_len: parts[parts.length - 2].length,
    suffix: file.includes('.') ? `.${file.split('.').slice(1).join('.')}` : '',
  }
}

// ==========================================================================
// O01 — private asset upload
// ==========================================================================

test('O01 default role: 201 AssetOut, stored bytes match the row checksum, no audit rows', async () => {
  const h = harness()
  const png = await pngBytes(64, 48)
  const response = await h.send(
    await upload(`/projects/${h.projectId}/assets`, {
      files: [{ name: 'page-01.png', type: 'image/png', bytes: png }],
    }),
  )
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  assert.deepEqual(Object.keys(body), [
    'id', 'project_id', 'role', 'sensitivity', 'content_type', 'size_bytes',
    'width', 'height', 'checksum', 'original_filename', 'download_url',
  ])
  assert.equal(body.project_id, h.projectId)
  assert.equal(body.role, 'past_paper_page')
  assert.equal(body.sensitivity, 'public_to_owner')
  assert.equal(body.content_type, 'image/png')
  assert.equal(body.width, 64)
  assert.equal(body.height, 48)
  assert.equal(body.original_filename, 'page-01.png')
  assert.equal(body.download_url, `/api/acepass/projects/${h.projectId}/assets/${body.id}`)

  const asset = findOne(h.db, 'ingestion_asset', { id: body.id })!
  const bytes = storedBytes(asset)
  assert.equal(sha256(new Uint8Array(bytes)), asset.checksum, 'checksum must describe the stored bytes')
  assert.equal(bytes.byteLength, Number(asset.size_bytes))
  assert.deepEqual(keyShape(String(asset.object_key)), {
    namespace: 'source', segments: 5, token_len: 32, prefix_len: 2, suffix: '.png',
  })
  // The stored object is the re-encoded one, not the upload: the PNG upload is 1-pixel-uniform and
  // sharp re-encodes it, so the bytes differ while the checksum still matches what was written.
  assert.equal(findRows(h.db, 'audit_content_revision', {}).length, 0)
  assert.equal(findRows(h.db, 'audit_outbox_event', {}).length, 0)
})

test('O01 role=stem_crop uses the region namespace and role=answer_page stays public', async () => {
  const h = harness()
  const png = await pngBytes(41, 41)
  const crop = await h.send(
    await upload(`/projects/${h.projectId}/assets`, {
      files: [{ name: 'crop-03.png', type: 'image/png', bytes: png }],
      form: { role: 'stem_crop' },
    }),
  )
  assert.equal(crop.status, 201)
  const cropBody = (await crop.json()) as Record<string, any>
  assert.equal(cropBody.role, 'stem_crop')
  assert.equal(keyShape(String(findOne(h.db, 'ingestion_asset', { id: cropBody.id })!.object_key)).namespace, 'region')

  const answer = await h.send(
    await upload(`/projects/${h.projectId}/assets`, {
      files: [{ name: 'answers.png', type: 'image/png', bytes: await pngBytes(20, 20) }],
      form: { role: 'answer_page' },
    }),
  )
  assert.equal(answer.status, 201)
  // O01 has no sensitivity parameter and never infers one from the role (06 §3.1).
  assert.equal(((await answer.json()) as Record<string, any>).sensitivity, 'public_to_owner')
})

test('O01 rejects an empty upload, a bad role and a corrupt image with the Python messages', async () => {
  const h = harness()
  const empty = await h.send(
    await upload(`/projects/${h.projectId}/assets`, { files: [{ name: 'empty.png', type: 'image/png', bytes: new Uint8Array() }] }),
  )
  assert.equal(empty.status, 400)
  assert.deepEqual(((await empty.json()) as any).error, {
    code: 'invalid_input', message: '上传内容为空', details: {}, request_id: 'req-1',
  })

  const badRole = await h.send(
    await upload(`/projects/${h.projectId}/assets`, {
      files: [{ name: 'a.png', type: 'image/png', bytes: await pngBytes() }],
      form: { role: 'bogus_role' },
    }),
  )
  assert.equal(badRole.status, 400)
  assert.deepEqual(((await badRole.json()) as any).error.details, { role: 'bogus_role' })
  assert.equal(((await (await h.send(
    await upload(`/projects/${h.projectId}/assets`, {
      files: [{ name: 'b.png', type: 'image/png', bytes: new Uint8Array(Buffer.from('definitely not a png')) }],
    }),
  )).json()) as any).error.message, '图片内容无法解析，文件可能损坏或不是真实图片')
})

test('O01 refuses a declared MIME outside the allowlist but accepts a mismatched real format', async () => {
  const h = harness()
  const gif = await h.send(
    await upload(`/projects/${h.projectId}/assets`, { files: [{ name: 'a.gif', type: 'image/gif', bytes: GIF_BYTES }] }),
  )
  assert.equal(gif.status, 400)
  assert.deepEqual(((await gif.json()) as any).error.details, { content_type: 'image/gif' })

  // PNG bytes declared as JPEG: Django stores them with the declared type and the detected format's
  // container (probe P09). The row therefore lies about `content_type` but not about the bytes.
  const png = await pngBytes(30, 20)
  const mismatch = await h.send(
    await upload(`/projects/${h.projectId}/assets`, { files: [{ name: 'mismatch.jpg', type: 'image/jpeg', bytes: png }] }),
  )
  assert.equal(mismatch.status, 201)
  const body = (await mismatch.json()) as Record<string, any>
  assert.equal(body.content_type, 'image/jpeg')
  const asset = findOne(h.db, 'ingestion_asset', { id: body.id })!
  assert.equal(keyShape(String(asset.object_key)).suffix, '.jpg')
  const metadata = await sharp(storedBytes(asset)).metadata()
  assert.equal(metadata.format, 'png', 'the stored container follows the detected format')
})

test('O01 stores a non-image upload as .bin with null dimensions', async () => {
  const h = harness()
  const response = await h.send(
    await upload(`/projects/${h.projectId}/assets`, { files: [{ name: 'note.txt', type: 'text/plain', bytes: TEXT_BYTES }] }),
  )
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.width, null)
  assert.equal(body.height, null)
  assert.equal(body.size_bytes, TEXT_BYTES.byteLength)
  const asset = findOne(h.db, 'ingestion_asset', { id: body.id })!
  assert.equal(asset.checksum, sha256(TEXT_BYTES), 'non-image bytes are stored verbatim')
  assert.equal(keyShape(String(asset.object_key)).suffix, '.bin')
})

test('O01 rejects a missing file part with Ninja file-parameter loc', async () => {
  const h = harness()
  const response = await h.send(await upload(`/projects/${h.projectId}/assets`, { form: { role: 'other' } }))
  assert.equal(response.status, 400)
  const error = ((await response.json()) as any).error
  assert.equal(error.message, '请求参数校验失败')
  assert.deepEqual(error.details.errors, [{ type: 'missing', loc: ['file', 'file'], msg: 'Field required' }])
})

test('O01 is scoped to the project and never de-duplicates', async () => {
  const h = harness()
  const png = await pngBytes(10, 10)
  const foreign = await h.send(
    await upload(`/projects/${h.otherProjectId}/assets`, {
      files: [{ name: 'x.png', type: 'image/png', bytes: png }],
      form: { subject_id: h.subjectId },
    }),
  )
  // O01 has no subject field at all, so `subject_id` is ignored rather than rejected.
  assert.equal(foreign.status, 201)

  const missingProject = await h.send(
    await upload(`/projects/00000000-0000-4000-8000-000000000000/assets`, {
      files: [{ name: 'x.png', type: 'image/png', bytes: png }],
    }),
  )
  assert.equal(missingProject.status, 404)

  const first = await h.send(
    await upload(`/projects/${h.projectId}/assets`, { files: [{ name: 'same.png', type: 'image/png', bytes: png }] }),
  )
  const second = await h.send(
    await upload(`/projects/${h.projectId}/assets`, { files: [{ name: 'same.png', type: 'image/png', bytes: png }] }),
  )
  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.equal(findRows(h.db, 'ingestion_asset', { project_id: h.projectId }).length, 2)
  assert.equal(findRows(h.db, 'ingestion_source_document', {}).length, 0, 'O01 creates no document')
})

// ==========================================================================
// O02 — gated download
// ==========================================================================

/** Create an asset through the real O01 endpoint so the row and the file agree. */
async function uploadAsset(
  h: Harness,
  options: { bytes?: Uint8Array; type?: string; name?: string; role?: string; sensitivity?: string },
): Promise<Record<string, any>> {
  const response = await h.send(
    await upload(`/projects/${h.projectId}/assets`, {
      files: [{ name: options.name ?? 'a.png', type: options.type ?? 'image/png', bytes: options.bytes ?? (await pngBytes()) }],
      form: options.role === undefined ? {} : { role: options.role },
    }),
  )
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  if (options.sensitivity !== undefined) {
    h.db.prepare('UPDATE "ingestion_asset" SET "sensitivity" = ? WHERE "id" = ?').run(options.sensitivity, body.id)
    body.sensitivity = options.sensitivity
  }
  return body
}

test('O02 delivers the stored bytes with the four contract headers', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { bytes: await pngBytes(24, 18) })
  const response = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('content-disposition'), `inline; filename="${asset.id}"`)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const delivered = new Uint8Array(await response.arrayBuffer())
  assert.equal(sha256(delivered), asset.checksum)
  assert.equal(findRows(h.db, 'practice_exposure_event', {}).length, 0, 'a public page is not an exposure')
})

test('O02 uses attachment for non-image bytes', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { bytes: TEXT_BYTES, type: 'text/plain', name: 'note.txt' })
  const response = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${asset.id}"`)
  assert.equal(response.headers.get('content-type'), 'text/plain')
})

test('O02 answers 404 for a foreign project, a missing asset and missing bytes on disk', async () => {
  const h = harness()
  const asset = await uploadAsset(h, {})

  const foreign = await h.send(get(`/projects/${h.otherProjectId}/assets/${asset.id}`))
  assert.equal(foreign.status, 404)
  assert.equal(((await foreign.json()) as any).error.message, '文件不存在或不属于当前项目')

  const missing = await h.send(get(`/projects/${h.projectId}/assets/00000000-0000-4000-8000-000000000000`))
  assert.equal(missing.status, 404)

  const row = findOne(h.db, 'ingestion_asset', { id: asset.id })!
  unlinkSync(getStorage().absolutePath(String(row.object_key))!)
  const gone = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}`))
  assert.equal(gone.status, 404)
  assert.deepEqual(((await gone.json()) as any).error, {
    code: 'not_found', message: '对象不存在或不在当前权限范围', details: {}, request_id: 'req-4',
  })
  assert.equal(findRows(h.db, 'practice_exposure_event', {}).length, 0, 'a failed delivery writes no exposure')
})

/** A practice session (and optionally an item) for the owner, used by the answer-bearing gate. */
function practiceSession(
  h: Harness,
  options: { mode: string; status?: string; withItem?: boolean },
): { sessionId: string; itemId: string | null; versionId: string } {
  const sessionId = String(
    insertFixture(h.db, 'practice_session', {
      user_id: h.userId,
      project_id: h.projectId,
      subject_id: h.subjectId,
      mode: options.mode,
      status: options.status ?? 'active',
    }).id,
  )
  const questionId = String(
    insertFixture(h.db, 'question_bank_question', {
      subject_id: h.subjectId,
      origin_type: 'user_authored',
      is_demo: false,
      display_label: `题目-${sessionId.slice(0, 4)}`,
      created_by_id: h.userId,
    }).id,
  )
  const versionId = String(
    insertFixture(h.db, 'question_bank_question_version', {
      question_id: questionId,
      version: 1,
      question_type: 'single_choice',
      content: { blocks: [{ kind: 'text', text: '题干' }] },
      material_child_version_ids: [],
      status: 'published',
      revision_reason: '',
      source_note: '',
      withdrawn_reason: '',
      content_digest: 'digest',
      created_by_id: h.userId,
    }).id,
  )
  let itemId: string | null = null
  if (options.withItem === true) {
    itemId = String(
      insertFixture(h.db, 'practice_session_item', {
        session_id: sessionId,
        ordinal: 1,
        question_version_id: versionId,
        mapping_revision: 1,
        max_score: '2.00',
        purpose: 'practice',
        tutoring_allowed: true,
        draft: {},
        draft_revision: 0,
      }).id,
    )
  }
  return { sessionId, itemId, versionId }
}

test('O02 logs an exposure for an answer page opened inside a practice item', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { role: 'answer_page', sensitivity: 'contains_answers' })
  const session = practiceSession(h, { mode: 'practice', withItem: true })
  const response = await h.send(
    get(`/projects/${h.projectId}/assets/${asset.id}?session_item_id=${session.itemId}`),
  )
  assert.equal(response.status, 200)
  const exposures = findRows(h.db, 'practice_exposure_event', {})
  assert.equal(exposures.length, 1)
  const exposure = exposures[0]
  assert.equal(exposure.kind, 'answer_delivered')
  assert.equal(exposure.purpose, 'practice')
  assert.equal(exposure.source, 'asset_download')
  assert.equal(Boolean(exposure.reveals_answer), true)
  assert.equal(String(exposure.session_item_id), session.itemId)
  assert.equal(String(exposure.question_version_id), session.versionId)
  assert.deepEqual(exposure.detail, {
    asset_id: asset.id,
    role: 'answer_page',
    server_time: '2026-09-01T00:00:00+00:00',
  })
})

test('O02 refuses an answer page in a verification session, and without a session during one', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { role: 'answer_page', sensitivity: 'contains_answers' })
  const verification = practiceSession(h, { mode: 'verification', withItem: true })
  const withItem = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}?session_item_id=${verification.itemId}`))
  assert.equal(withItem.status, 403)
  assert.equal(((await withItem.json()) as any).error.message, '当前会话模式在提交前不允许查看含答案的来源文件')

  const withoutItem = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}`))
  assert.equal(withoutItem.status, 403)
  assert.equal(((await withoutItem.json()) as any).error.message, '存在未结束的验证/考试会话，暂不能查看含答案的来源文件')
  assert.equal(findRows(h.db, 'practice_exposure_event', {}).length, 0)
})

test('O02 editorial purpose is refused while a verification run is open, and logged otherwise', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { role: 'answer_page', sensitivity: 'contains_answers' })
  practiceSession(h, { mode: 'mock_exam' })
  const blocked = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}?purpose=editorial`))
  assert.equal(blocked.status, 403)
  assert.equal(
    ((await blocked.json()) as any).error.message,
    '存在未结束的验证/考试会话，暂不能查看可能包含答案的来源文件；请先结束验证',
  )

  // Finish the run: the editorial preview is then allowed and the exposure says `editorial`.
  h.db.prepare(`UPDATE "practice_session" SET "status" = 'finished'`).run()
  const allowed = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}?purpose=editorial`))
  assert.equal(allowed.status, 200)
  const exposure = findRows(h.db, 'practice_exposure_event', {})[0]
  assert.equal(exposure.purpose, 'editorial')
  assert.equal(exposure.question_id, null)
  assert.equal(exposure.question_version_id, null)
})

test('O02 falls back to the practice purpose for an unknown value and rejects a foreign item', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { role: 'answer_page', sensitivity: 'contains_answers' })
  const session = practiceSession(h, { mode: 'practice', withItem: true })
  const odd = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}?purpose=whatever&session_item_id=${session.itemId}`))
  assert.equal(odd.status, 200)
  assert.equal(findRows(h.db, 'practice_exposure_event', {})[0].purpose, 'practice')

  const foreignItem = await h.send(
    get(`/projects/${h.projectId}/assets/${asset.id}?session_item_id=00000000-0000-4000-8000-000000000000`),
  )
  assert.equal(foreignItem.status, 404)
  assert.equal(((await foreignItem.json()) as any).error.message, '题项不存在或不属于该项目')
})

test('O02 refuses an internal_review asset to a non-staff owner', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { sensitivity: 'internal_review' })
  const response = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}`))
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as any).error.message, '该文件仅限内部审核使用')
})

test('O02 refuses a page that a sealed question was cut from', async () => {
  const h = harness()
  const asset = await uploadAsset(h, { role: 'stem_crop' })
  const questionId = String(
    insertFixture(h.db, 'question_bank_question', {
      subject_id: h.subjectId,
      origin_type: 'user_authored',
      is_demo: false,
      display_label: '封存甲',
      created_by_id: h.userId,
    }).id,
  )
  const versionId = String(
    insertFixture(h.db, 'question_bank_question_version', {
      question_id: questionId,
      version: 1,
      question_type: 'single_choice',
      content: { blocks: [{ kind: 'text', text: '题干' }] },
      material_child_version_ids: [],
      status: 'published',
      revision_reason: '',
      source_note: '',
      withdrawn_reason: '',
      content_digest: 'digest',
      created_by_id: h.userId,
    }).id,
  )
  const documentId = String(
    insertFixture(h.db, 'ingestion_source_document', {
      owner_id: h.userId,
      project_id: h.projectId,
      subject_id: h.subjectId,
      title: '封存页',
      document_type: 'image',
      role: 'answer_page',
      sensitivity: 'contains_answers',
      asset_id: asset.id,
      checksum: 'checksum',
      source_type: 'user_upload',
      source_note: '',
      usage_scope: '',
    }).id,
  )
  const regionId = String(
    insertFixture(h.db, 'ingestion_source_region', {
      document_id: documentId,
      page_index: 1,
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.5,
      crop_asset_id: asset.id,
      role: 'stem_crop',
      text_span: '封存题干',
    }).id,
  )
  insertFixture(h.db, 'question_bank_source_link', {
    question_version_id: versionId,
    region_id: regionId,
    role: 'stem',
    note: '',
  })
  sealQuestion(h.db, { projectId: h.projectId, questionId, actorId: h.userId, reason: 'B3 测试封存', now: NOW })

  const response = await h.send(get(`/projects/${h.projectId}/assets/${asset.id}`))
  assert.equal(response.status, 403)
  const error = ((await response.json()) as any).error
  assert.equal(error.code, 'purpose_not_allowed')
  assert.equal(
    error.message,
    '该文件包含已封存题目的原始内容（题目 封存甲）：该题已被保留策略（holdout）封存：不参与练习、检索、AI 生成提示、导出与原页预览，因此不能读取原页或答案文件。',
  )
  assert.deepEqual(error.details, {
    reason: 'sealed_question_policy',
    question_id: questionId,
    asset_id: asset.id,
    action: '读取原页/答案文件',
  })
})

// ==========================================================================
// O05 — image source document
// ==========================================================================

test('O05 stores the page as an image document whose checksum is the stored asset checksum', async () => {
  const h = harness()
  const png = await pngBytes(64, 48)
  const response = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'source-40.png', type: 'image/png', bytes: png }],
      form: { title: 'B3 来源标题', source_note: '2025 真题扫描', usage_scope: '内部校对', subject_id: h.subjectId },
    }),
  )
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.document_type, 'image')
  assert.equal(body.role, 'past_paper_page')
  assert.equal(body.sensitivity, 'public_to_owner')
  assert.equal(body.source_type, 'user_upload')
  assert.equal(body.title, 'B3 来源标题')
  assert.equal(body.subject_id, h.subjectId)
  assert.equal(body.raw_text_preview, '')
  const asset = findOne(h.db, 'ingestion_asset', { id: body.asset_id })!
  assert.equal(body.checksum, asset.checksum)
  assert.equal(asset.width, 64)
})

test('O05 marks an answer page as contains_answers and refuses a bad role', async () => {
  const h = harness()
  const answer = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'source-41.png', type: 'image/png', bytes: await pngBytes(80, 60) }],
      form: { role: 'answer_page' },
    }),
  )
  assert.equal(answer.status, 201)
  assert.equal(((await answer.json()) as Record<string, any>).sensitivity, 'contains_answers')

  const badRole = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'x.png', type: 'image/png', bytes: await pngBytes() }],
      form: { role: 'bogus' },
    }),
  )
  assert.equal(badRole.status, 400)
  assert.equal(((await badRole.json()) as any).error.message, '来源角色无效')

  const empty = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'x.png', type: 'image/png', bytes: new Uint8Array() }],
    }),
  )
  assert.equal(empty.status, 400)
  assert.equal(((await empty.json()) as any).error.message, '上传内容为空')
})

test('O05 keeps the current behaviour for a non-image MIME and truncates the three text fields', async () => {
  const h = harness()
  const text = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'source-44.txt', type: 'text/plain', bytes: TEXT_BYTES }],
    }),
  )
  assert.equal(text.status, 201)
  const textBody = (await text.json()) as Record<string, any>
  assert.equal(textBody.document_type, 'image', 'a non-image MIME still becomes an image document')
  assert.equal(findOne(h.db, 'ingestion_asset', { id: textBody.asset_id })!.content_type, 'text/plain')

  const long = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'source-46.png', type: 'image/png', bytes: await pngBytes(20, 20) }],
      form: { title: '题'.repeat(320), source_note: '注'.repeat(520), usage_scope: '范'.repeat(220) },
    }),
  )
  assert.equal(long.status, 201)
  const document = findOne(h.db, 'ingestion_source_document', { id: ((await long.json()) as any).id })!
  assert.deepEqual(
    { title: [...String(document.title)].length, source_note: [...String(document.source_note)].length, usage_scope: [...String(document.usage_scope)].length },
    { title: 300, source_note: 500, usage_scope: 200 },
  )
})

test('O05 refuses a subject from another project and maps an empty subject to null', async () => {
  const h = harness()
  const foreign = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'x.png', type: 'image/png', bytes: await pngBytes() }],
      form: { subject_id: h.otherSubjectId },
    }),
  )
  assert.equal(foreign.status, 404)
  assert.equal(((await foreign.json()) as any).error.message, '科目不存在或不属于该项目')

  const empty = await h.send(
    await upload(`/projects/${h.projectId}/source-documents/image`, {
      files: [{ name: 'y.png', type: 'image/png', bytes: await pngBytes() }],
      form: { subject_id: '' },
    }),
  )
  assert.equal(empty.status, 201)
  assert.equal(((await empty.json()) as Record<string, any>).subject_id, null)
})

// ==========================================================================
// O08 — image import
// ==========================================================================

test('O08 opens one manual candidate per page with the full-page region', async () => {
  const h = harness()
  const response = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'page.png', type: 'image/png', bytes: await pngBytes(40, 30) }],
      form: { title: 'B3 来源标题', subject_id: h.subjectId },
      key: 'b3-img-one',
    }),
  )
  assert.equal(response.status, 201)
  const job = (await response.json()) as Record<string, any>
  assert.equal(job.input_kind, 'image_manual')
  assert.equal(job.extractor_version, 'manual-image-v1')
  assert.equal(job.status, 'awaiting_review')
  assert.equal(job.candidate_count, 1)
  assert.deepEqual(job.candidate_status_counts, { draft: 1 })
  assert.equal(job.document_ids.length, 1)
  assert.deepEqual(job.problems.map((problem: any) => [problem.code, problem.severity]), [
    ['manual_structure_required', 'warning'],
  ])
  assert.equal(
    job.problems[0].message,
    '图片已保存为私有来源；未配置视觉模型，请在校对页对照原图录入题干与答案。配置可用的视觉 provider 后，同一入口会自动改为模型识别 + 人工校对。',
  )

  const candidate = findOne(h.db, 'ingestion_import_candidate', { job_id: job.id })!
  assert.deepEqual(candidate.draft_payload, {
    question_type: 'single_choice',
    display_label: 'B3 来源标题',
    content: { blocks: [{ kind: 'text', text: '' }] },
    answer_payload: {},
    answer_status_known: false,
    needs_manual_structure: true,
  })
  const region = findOne(h.db, 'ingestion_source_region', { document_id: job.document_ids[0] })!
  assert.deepEqual(
    { page: region.page_index, x: region.x, y: region.y, w: region.width, h: region.height, role: region.role },
    { page: 1, x: 0, y: 0, w: 1, h: 1, role: 'past_paper_page' },
  )
})

test('O08 imports two pages and reuses an existing document for a byte-identical upload', async () => {
  const h = harness()
  const two = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [
        { field: 'files', name: 'a.png', type: 'image/png', bytes: await pngBytes(20, 20, { r: 1, g: 2, b: 3 }) },
        { field: 'files', name: 'b.png', type: 'image/png', bytes: await pngBytes(21, 21, { r: 4, g: 5, b: 6 }) },
      ],
      key: 'b3-img-two',
    }),
  )
  assert.equal(two.status, 201)
  const job = (await two.json()) as Record<string, any>
  assert.equal(job.candidate_count, 2)
  assert.equal(job.document_ids.length, 2)

  // "Fully duplicate" means the *stored* bytes are uploaded back: a Document stores the re-encoded
  // checksum, so the original file would not match (the asymmetry is pinned in the golden vectors).
  const firstDocument = findOne(h.db, 'ingestion_source_document', { id: job.document_ids[0] })!
  const stored = storedBytes(findOne(h.db, 'ingestion_asset', { id: String(firstDocument.asset_id) })!)
  const duplicate = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'dup.png', type: 'image/png', bytes: new Uint8Array(stored) }],
      form: { role: 'answer_page', subject_id: h.subjectId },
      key: 'b3-img-duplicate',
    }),
  )
  assert.equal(duplicate.status, 201)
  const duplicateJob = (await duplicate.json()) as Record<string, any>
  assert.deepEqual(duplicateJob.document_ids, [String(firstDocument.id)], 'the original document is reused')
  assert.deepEqual(duplicateJob.problems.map((problem: any) => problem.code), [
    'manual_structure_required',
    'duplicate_source_file',
  ])
  assert.equal(
    duplicateJob.problems[1].message,
    '其中 1 张图片与已有来源文件完全相同，已复用原来源而未新增（避免同一试卷重复统计）。',
  )
  const reused = findOne(h.db, 'ingestion_source_document', { id: String(firstDocument.id) })!
  assert.equal(reused.subject_id, null, 'the reuse must not overwrite the existing subject')
  assert.equal(reused.role, 'past_paper_page', 'nor the existing role')
})

test('O08 imports only the new page of a mixed upload', async () => {
  const h = harness()
  const first = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'old.png', type: 'image/png', bytes: await pngBytes(22, 22, { r: 7, g: 8, b: 9 }) }],
      key: 'b3-img-mixed-old',
    }),
  )
  const firstJob = (await first.json()) as Record<string, any>
  const stored = storedBytes(
    findOne(h.db, 'ingestion_asset', {
      id: String(findOne(h.db, 'ingestion_source_document', { id: firstJob.document_ids[0] })!.asset_id),
    })!,
  )
  const mixed = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [
        { field: 'files', name: 'new.png', type: 'image/png', bytes: await pngBytes(23, 23, { r: 11, g: 22, b: 33 }) },
        { field: 'files', name: 'old.png', type: 'image/png', bytes: new Uint8Array(stored) },
      ],
      key: 'b3-img-mixed',
    }),
  )
  assert.equal(mixed.status, 201)
  const job = (await mixed.json()) as Record<string, any>
  assert.equal(job.document_ids.length, 1)
  assert.notEqual(job.document_ids[0], firstJob.document_ids[0])
  assert.ok(job.problems.some((problem: any) => problem.code === 'duplicate_source_file'))
})

test('O08 rejects an empty file list with the Ninja file-parameter loc', async () => {
  const h = harness()
  const response = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, { form: { title: 'x' }, key: 'b3-img-none' }),
  )
  assert.equal(response.status, 400)
  const error = ((await response.json()) as any).error
  assert.deepEqual(error.details.errors, [{ type: 'missing', loc: ['file', 'files'], msg: 'Field required' }])
  // Django's own "请至少上传一张图片" is unreachable: the required file parameter fails first.
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 0)
})

test('O08 validates every image before claiming the idempotency key', async () => {
  const h = harness()
  const response = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [
        { field: 'files', name: 'ok.png', type: 'image/png', bytes: await pngBytes(20, 20) },
        { field: 'files', name: 'broken.png', type: 'image/png', bytes: new Uint8Array(Buffer.from('broken')) },
      ],
      key: 'b3-img-broken',
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as any).error.message, '图片内容无法解析，文件可能损坏或不是真实图片')
  assert.equal(findRows(h.db, 'audit_idempotency_record', {}).length, 0, 'a rejected upload creates no claim')
  assert.equal(findRows(h.db, 'ingestion_asset', {}).length, 0)
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 0)
})

test('O08 requires an Idempotency-Key, replays the first result and conflicts on new bytes', async () => {
  const h = harness()
  const png = await pngBytes(30, 30, { r: 40, g: 50, b: 60 })
  const noKey = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, { files: [{ field: 'files', name: 'a.png', type: 'image/png', bytes: png }] }),
  )
  assert.equal(noKey.status, 409)
  assert.equal(((await noKey.json()) as any).error.message, '缺少 Idempotency-Key 请求头')

  const first = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'a.png', type: 'image/png', bytes: png }],
      key: 'b3-img-replay',
    }),
  )
  assert.equal(first.status, 201)
  const firstBody = await first.json()

  const replay = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'a.png', type: 'image/png', bytes: png }],
      key: 'b3-img-replay',
    }),
  )
  assert.equal(replay.status, 201)
  assert.deepEqual(await replay.json(), firstBody)
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 1, 'the replay writes nothing')

  // `title` is not part of the fingerprint (06 §2), so a renamed retry still replays.
  const renamed = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'a.png', type: 'image/png', bytes: png }],
      form: { title: '另一个标题' },
      key: 'b3-img-replay',
    }),
  )
  assert.equal(renamed.status, 201)
  assert.deepEqual(await renamed.json(), firstBody)

  const conflict = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'b.png', type: 'image/png', bytes: await pngBytes(31, 31, { r: 1, g: 1, b: 1 }) }],
      key: 'b3-img-replay',
    }),
  )
  assert.equal(conflict.status, 409)
  const error = ((await conflict.json()) as any).error
  assert.equal(error.message, '相同幂等键使用了不同请求内容')
  assert.deepEqual(error.details, {
    route_scope: `imports.create_images:${h.projectId}`,
    reason: 'same_key_different_payload',
  })
})

test('O08 keeps an answer page private through the document sensitivity', async () => {
  const h = harness()
  const response = await h.send(
    await upload(`/projects/${h.projectId}/imports/images`, {
      files: [{ field: 'files', name: 'answer.png', type: 'image/png', bytes: await pngBytes(37, 37, { r: 200, g: 0, b: 0 }) }],
      form: { role: 'answer_page', subject_id: h.subjectId },
      key: 'b3-img-answer',
    }),
  )
  assert.equal(response.status, 201)
  const job = (await response.json()) as Record<string, any>
  const document = findOne(h.db, 'ingestion_source_document', { id: job.document_ids[0] })!
  assert.equal(document.sensitivity, 'contains_answers')
  assert.equal(document.role, 'answer_page')
  const asset = findOne(h.db, 'ingestion_asset', { id: String(document.asset_id) })!
  assert.equal(asset.sensitivity, 'contains_answers')
  assert.equal(findRows(h.db, 'practice_exposure_event', {}).length, 0, 'an import is not a delivery')
})

test('O08 vision branch: implemented, write-set pinned, unreachable from this HTTP surface', async () => {
  // The HTTP endpoint passes `useVision: false` because no vision provider is wired into B3, so the
  // `image_ai` branch is not reachable there. It is still implemented, and this test pins its write
  // set with an injected `true` so the branch cannot rot before B5 wires the extraction worker.
  const h = harness()
  const documents = []
  for (const [index, bytes] of [await pngBytes(20, 20, { r: 9, g: 9, b: 9 }), await pngBytes(21, 21, { r: 8, g: 8, b: 8 })].entries()) {
    const prepared = await prepareAssetImage({ bytes, contentType: 'image/png', reencode: true })
    documents.push(
      createImageDocument(
        h.db,
        {
          ownerId: h.userId,
          projectId: h.projectId,
          subjectId: null,
          prepared,
          content: bytes,
          contentType: 'image/png',
          role: 'past_paper_page',
          title: `vision-${index}`,
        },
        NOW,
      ),
    )
  }
  const job = startImageImport(
    h.db,
    { ownerId: h.userId, projectId: h.projectId, subjectId: null, documents, title: '视觉', useVision: true },
    NOW,
  )
  assert.equal(job.input_kind, 'image_ai')
  assert.equal(job.extractor_version, 'vision-v1')
  assert.deepEqual((job.problems as any[]).map((problem) => [problem.code, problem.severity]), [
    ['vision_extraction_queued', 'info'],
  ])
  assert.equal(
    (job.problems as any[])[0].message,
    '图片已保存为私有来源，已排入视觉识别任务；识别结果仍需人工对照原图校对后才能发布。',
  )
  const events = findRows(h.db, 'audit_outbox_event', {})
  assert.equal(events.length, 2, 'one extraction task per candidate')
  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: job.id })
  assert.equal(candidates.length, 2)
  for (const event of events) {
    assert.equal(event.topic, 'ingestion.extract_candidate')
    const payload = event.payload as Record<string, string>
    assert.ok(candidates.some((candidate) => String(candidate.id) === payload.candidate_id))
    assert.equal(String(event.dedupe_key), `extract-candidate:${payload.candidate_id}`)
  }

  // A stub provider is labelled as a stub — never silently passed off as a real model result.
  const stubJob = startImageImport(
    h.db,
    { ownerId: h.userId, projectId: h.projectId, subjectId: null, documents: [], title: 'stub', useVision: true, visionIsStub: true },
    NOW,
  )
  assert.deepEqual((stubJob.problems as any[]).map((problem) => [problem.code, problem.severity]), [
    ['vision_extraction_queued', 'warning'],
  ])
  assert.match(String((stubJob.problems as any[])[0].message), /当前为测试\/演示 stub/)
})
