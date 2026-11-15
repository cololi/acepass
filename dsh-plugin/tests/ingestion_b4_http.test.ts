/**
 * O09 over HTTP: `POST /api/acepass/projects/{project_id}/imports/pdf`.
 *
 * Every assertion is either a recorded Django behaviour (the messages and `details` are the Python
 * ones, verbatim) or a property the batch's exit criteria demand: one transaction, a replayed
 * idempotency key, a paper revision that is **not** confirmed by uploading a file, and a layout block
 * that a human has to clear.
 *
 * The PDFs come from `tests/golden/ingestion_b4_pdf.json`, i.e. the exact bytes the Django extractor
 * was measured on. Sending those bytes through a real `multipart/form-data` body (platform
 * `FormData`/`File`) is what makes "the transport can carry a two-file PDF upload" a fact rather than
 * an in-process assumption.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow } from '../src/store/repository.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { configureStorage, resetStorageCache } from '../src/ingestion/storage.ts'

const NOW = parseInstant('2026-09-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'
const MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'acepass-b4-http-'))
configureStorage(MEDIA_ROOT)
process.on('exit', () => {
  resetStorageCache()
  rmSync(MEDIA_ROOT, { recursive: true, force: true })
})

const PDF_GOLDEN = JSON.parse(readFileSync(new URL('./golden/ingestion_b4_pdf.json', import.meta.url), 'utf8'))
const pdfBytes = (name: string): Uint8Array =>
  new Uint8Array(Buffer.from(PDF_GOLDEN.fixtures[name].base64, 'base64'))
/**
 * The answer sheet used by the matching test: `build_layout_pdf([[{"x":60,"y":780,"text":"1. A"},
 * {"x":60,"y":750,"text":"2. B"}]])` from `backend/tests/support/pdf_builder.py`, sha256
 * `3ea688d5…433f`. It is inlined rather than added to the extraction golden because the answer path
 * needs *answer* text, not a question-shaped page.
 */
const ANSWERS_PDF_BASE64 =
  'JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwg' +
  'L1R5cGUgL1BhZ2VzIC9LaWRzIFsxMCAwIFJdIC9Db3VudCAxID4+CmVuZG9iagozIDAgb2JqCjw8IC9UaXRsZSAoQWNlUGFzcyDn' +
  'iYjlvI/mtYvor5XmnZDmlpnvvIjoh6rliqjnlJ/miJDvvIzpnZ7nnJ/popjvvIkpIC9Qcm9kdWNlciAoQWNlUGFzcyB0ZXN0IGZp' +
  'eHR1cmUgYnVpbGRlcikgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUwIC9CYXNlRm9udCAv' +
  'QWNlUGFzc1Rlc3QgL0VuY29kaW5nIC9JZGVudGl0eS1IIC9EZXNjZW5kYW50Rm9udHMgWzUgMCBSXSAvVG9Vbmljb2RlIDcgMCBS' +
  'ID4+CmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9DSURGb250VHlwZTIgL0Jhc2VGb250IC9BY2VQYXNz' +
  'VGVzdCAvQ0lEU3lzdGVtSW5mbyA8PCAvUmVnaXN0cnkgKEFkb2JlKSAvT3JkZXJpbmcgKElkZW50aXR5KSAvU3VwcGxlbWVudCAw' +
  'ID4+IC9Gb250RGVzY3JpcHRvciA2IDAgUiAvRFcgMTAwMCAvVyBbMCBbMTAwMCAxMDAwIDEwMDBdXSA+PgplbmRvYmoKNiAwIG9i' +
  'ago8PCAvVHlwZSAvRm9udERlc2NyaXB0b3IgL0ZvbnROYW1lIC9BY2VQYXNzVGVzdCAvRmxhZ3MgNCAvRm9udEJCb3ggWzAgLTIw' +
  'MCAxMDAwIDkwMF0gL0l0YWxpY0FuZ2xlIDAgL0FzY2VudCA4MDAgL0Rlc2NlbnQgLTIwMCAvQ2FwSGVpZ2h0IDcwMCAvU3RlbVYg' +
  'ODAgL0ZvbnRGaWxlMiA4IDAgUiA+PgplbmRvYmoKNyAwIG9iago8PCAvTGVuZ3RoIDQwMCA+PgpzdHJlYW0KL0NJREluaXQgL1By' +
  'b2NTZXQgZmluZHJlc291cmNlIGJlZ2luCjEyIGRpY3QgYmVnaW4KYmVnaW5jbWFwCi9DSURTeXN0ZW1JbmZvIDw8IC9SZWdpc3Ry' +
  'eSAoQWRvYmUpIC9PcmRlcmluZyAoVUNTKSAvU3VwcGxlbWVudCAwID4+IGRlZgovQ01hcE5hbWUgL0FjZVBhc3MtVUNTIGRlZgov' +
  'Q01hcFR5cGUgMiBkZWYKMSBiZWdpbmNvZGVzcGFjZXJhbmdlCjwwMDAwPiA8RkZGRj4KZW5kY29kZXNwYWNlcmFuZ2UKNiBiZWdp' +
  'bmJmY2hhcgo8MDAzMT4gPDAwMzE+CjwwMDJFPiA8MDAyRT4KPDAwMjA+IDwwMDIwPgo8MDA0MT4gPDAwNDE+CjwwMDMyPiA8MDAz' +
  'Mj4KPDAwNDI+IDwwMDQyPgplbmRiZmNoYXIKZW5kY21hcApDTWFwTmFtZSBjdXJyZW50ZGljdCAvQ01hcCBkZWZpbmVyZXNvdXJj' +
  'ZSBwb3AKZW5kCmVuZAplbmRzdHJlYW0KZW5kb2JqCjggMCBvYmoKPDwgL0xlbmd0aCAwID4+CnN0cmVhbQoKZW5kc3RyZWFtCmVu' +
  'ZG9iago5IDAgb2JqCjw8IC9MZW5ndGggNzEgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCniccwrh0nczVDA0UghJ4zJU' +
  'MABCQwUzAwVzCwOFkFwuGwMDY0MDAyNXIDYwMDAxtFMIyUJRZwpXZ4SkzgiszjWECwCN5BL8CmVuZHN0cmVhbQplbmRvYmoKMTAg' +
  'MCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvUmVzb3VyY2VzIDw8IC9G' +
  'b250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgOSAwIFIgPj4KZW5kb2JqCnhyZWYKMCAxMQowMDAwMDAwMDAwIDY1NTM1' +
  'IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTIyIDAwMDAwIG4gCjAwMDAwMDAyNTAg' +
  'MDAwMDAgbiAKMDAwMDAwMDM4NiAwMDAwMCBuIAowMDAwMDAwNTk0IDAwMDAwIG4gCjAwMDAwMDA3ODAgMDAwMDAgbiAKMDAwMDAw' +
  'MTIzMSAwMDAwMCBuIAowMDAwMDAxMjgwIDAwMDAwIG4gCjAwMDAwMDE0MjIgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSAxMSAv' +
  'Um9vdCAxIDAgUiAvSW5mbyAzIDAgUiA+PgpzdGFydHhyZWYKMTU0OQolJUVPRgo='
const ANSWERS_PDF = new Uint8Array(Buffer.from(ANSWERS_PDF_BASE64, 'base64'))
/** `build_layout_pdf([[{"x":60,"y":780,"text":"10. A"}]])`, sha256 `e946ef76…d6d58`: a label that
 * cannot match any 卷面题号, which is what forces the position fallback. */
const ANSWERS_LABEL_MISMATCH_BASE64 =
  'JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwg' +
  'L1R5cGUgL1BhZ2VzIC9LaWRzIFsxMCAwIFJdIC9Db3VudCAxID4+CmVuZG9iagozIDAgb2JqCjw8IC9UaXRsZSAoQWNlUGFzcyDn' +
  'iYjlvI/mtYvor5XmnZDmlpnvvIjoh6rliqjnlJ/miJDvvIzpnZ7nnJ/popjvvIkpIC9Qcm9kdWNlciAoQWNlUGFzcyB0ZXN0IGZp' +
  'eHR1cmUgYnVpbGRlcikgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUwIC9CYXNlRm9udCAv' +
  'QWNlUGFzc1Rlc3QgL0VuY29kaW5nIC9JZGVudGl0eS1IIC9EZXNjZW5kYW50Rm9udHMgWzUgMCBSXSAvVG9Vbmljb2RlIDcgMCBS' +
  'ID4+CmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9DSURGb250VHlwZTIgL0Jhc2VGb250IC9BY2VQYXNz' +
  'VGVzdCAvQ0lEU3lzdGVtSW5mbyA8PCAvUmVnaXN0cnkgKEFkb2JlKSAvT3JkZXJpbmcgKElkZW50aXR5KSAvU3VwcGxlbWVudCAw' +
  'ID4+IC9Gb250RGVzY3JpcHRvciA2IDAgUiAvRFcgMTAwMCAvVyBbMCBbMTAwMCAxMDAwIDEwMDBdXSA+PgplbmRvYmoKNiAwIG9i' +
  'ago8PCAvVHlwZSAvRm9udERlc2NyaXB0b3IgL0ZvbnROYW1lIC9BY2VQYXNzVGVzdCAvRmxhZ3MgNCAvRm9udEJCb3ggWzAgLTIw' +
  'MCAxMDAwIDkwMF0gL0l0YWxpY0FuZ2xlIDAgL0FzY2VudCA4MDAgL0Rlc2NlbnQgLTIwMCAvQ2FwSGVpZ2h0IDcwMCAvU3RlbVYg' +
  'ODAgL0ZvbnRGaWxlMiA4IDAgUiA+PgplbmRvYmoKNyAwIG9iago8PCAvTGVuZ3RoIDM4NiA+PgpzdHJlYW0KL0NJREluaXQgL1By' +
  'b2NTZXQgZmluZHJlc291cmNlIGJlZ2luCjEyIGRpY3QgYmVnaW4KYmVnaW5jbWFwCi9DSURTeXN0ZW1JbmZvIDw8IC9SZWdpc3Ry' +
  'eSAoQWRvYmUpIC9PcmRlcmluZyAoVUNTKSAvU3VwcGxlbWVudCAwID4+IGRlZgovQ01hcE5hbWUgL0FjZVBhc3MtVUNTIGRlZgov' +
  'Q01hcFR5cGUgMiBkZWYKMSBiZWdpbmNvZGVzcGFjZXJhbmdlCjwwMDAwPiA8RkZGRj4KZW5kY29kZXNwYWNlcmFuZ2UKNSBiZWdp' +
  'bmJmY2hhcgo8MDAzMT4gPDAwMzE+CjwwMDMwPiA8MDAzMD4KPDAwMkU+IDwwMDJFPgo8MDAyMD4gPDAwMjA+CjwwMDQxPiA8MDA0' +
  'MT4KZW5kYmZjaGFyCmVuZGNtYXAKQ01hcE5hbWUgY3VycmVudGRpY3QgL0NNYXAgZGVmaW5lcmVzb3VyY2UgcG9wCmVuZAplbmQK' +
  'ZW5kc3RyZWFtCmVuZG9iago4IDAgb2JqCjw8IC9MZW5ndGggMCA+PgpzdHJlYW0KCmVuZHN0cmVhbQplbmRvYmoKOSAwIG9iago8' +
  'PCAvTGVuZ3RoIDYyIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQp4nHMK4dJ3M1QwNFIISeMyVDAAQkMFMwMFcwsDhZBc' +
  'LhsDA2NDIDYwMDByBWIgbWJopxCSxeUawgUAZa8L6gplbmRzdHJlYW0KZW5kb2JqCjEwIDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9Q' +
  'YXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNTk1IDg0Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNCAwIFIgPj4gPj4g' +
  'L0NvbnRlbnRzIDkgMCBSID4+CmVuZG9iagp4cmVmCjAgMTEKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4g' +
  'CjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMiAwMDAwMCBuIAowMDAwMDAwMjUwIDAwMDAwIG4gCjAwMDAwMDAzODYgMDAw' +
  'MDAgbiAKMDAwMDAwMDU5NCAwMDAwMCBuIAowMDAwMDAwNzgwIDAwMDAwIG4gCjAwMDAwMDEyMTcgMDAwMDAgbiAKMDAwMDAwMTI2' +
  'NiAwMDAwMCBuIAowMDAwMDAxMzk5IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgMTEgL1Jvb3QgMSAwIFIgL0luZm8gMyAwIFIg' +
  'Pj4Kc3RhcnR4cmVmCjE1MjYKJSVFT0YK'
const ANSWERS_LABEL_MISMATCH = new Uint8Array(Buffer.from(ANSWERS_LABEL_MISMATCH_BASE64, 'base64'))
const NOT_PDF = new Uint8Array(Buffer.from('这不是 PDF 文件，只是一段普通字节。', 'utf8'))
const DAMAGED = new Uint8Array(Buffer.from('%PDF-1.7\n' + 'garbage line\n'.repeat(60), 'utf8'))

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

type Part = [field: string, filename: string, type: string, bytes: Uint8Array]

async function postPdf(
  h: Harness,
  fields: Record<string, string>,
  parts: Part[],
  key = 'k-pdf',
  projectId = h.projectId,
): Promise<Response> {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  for (const [field, filename, type, bytes] of parts) {
    form.append(field, new File([bytes as unknown as BlobPart], filename, { type }))
  }
  return h.send(
    new Request(`${BASE}/projects/${projectId}/imports/pdf`, {
      method: 'POST',
      body: form,
      headers: { 'idempotency-key': key },
    }),
  )
}

const practice = (h: Harness): Record<string, string> => ({ subject_id: h.subjectId, source_kind: 'practice_set' })

// --------------------------------------------------------------------------
// Happy path
// --------------------------------------------------------------------------
test('O09 imports a two-page paper as proofreading candidates', async () => {
  const h = harness()
  const response = await postPdf(h, { ...practice(h), title: '月考卷一' }, [
    ['files', 'paper.pdf', 'application/pdf', pdfBytes('text_two_pages')],
  ])
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.input_kind, 'pdf_text')
  assert.equal(body.extractor_version, 'pdf-text-v2')
  assert.equal(body.status, 'awaiting_review')
  assert.equal(body.candidate_count, 4)
  assert.equal(body.document_ids.length, 1)
  // The diagnosis is per page and names the document it belongs to.
  assert.equal(body.page_diagnostics.length, 2)
  assert.equal(body.page_diagnostics[0].page_index, 1)
  assert.equal(body.page_diagnostics[0].document_id, body.document_ids[0])
  assert.equal(body.page_diagnostics[0].document_title, '月考卷一')
  assert.equal(body.page_diagnostics[0].is_scanned, false)
  assert.equal(body.page_diagnostics[0].needs_review, false)
  assert.deepEqual(body.problems, [])

  const documents = findRows(h.db, 'ingestion_source_document', { project_id: h.projectId })
  assert.equal(documents.length, 1)
  assert.equal(documents[0].document_type, 'pdf')
  assert.equal(documents[0].role, 'past_paper_page')
  assert.equal(documents[0].sensitivity, 'public_to_owner')
  assert.equal(documents[0].page_count, 2)
  assert.equal((documents[0].page_texts as string[]).length, 2)
  assert.equal(documents[0].raw_text, (documents[0].page_texts as string[]).join('\n'))

  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id }, {
    orderBy: [['created_at', 'asc']],
  })
  assert.deepEqual(
    candidates.map((candidate) => candidate.source_position_key),
    ['1', '2', '3', '4'],
  )
  const regions = findRows(h.db, 'ingestion_source_region', {})
  assert.ok(regions.length >= 4)
  for (const region of regions) {
    assert.equal(region.role, 'past_paper_page')
    assert.ok(Number(region.x) >= 0 && Number(region.x) <= 1)
    assert.ok(Number(region.y) >= 0 && Number(region.y) <= 1)
    assert.ok(Number(region.width) > 0 && Number(region.height) > 0)
  }
})

test('O09 with a separate answer PDF matches answers as proposals only', async () => {
  const h = harness()
  const response = await postPdf(h, practice(h), [
    ['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')],
    ['answer_files', 'answers.pdf', 'application/pdf', ANSWERS_PDF],
  ])
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  const codes = (body.problems as Array<Record<string, unknown>>).map((problem) => problem.code)
  assert.ok(codes.includes('answers_matched'), JSON.stringify(codes))
  const matched = (body.problems as Array<Record<string, any>>).find((problem) => problem.code === 'answers_matched')!
  assert.equal(matched.matched, 1)
  assert.equal(matched.position_matched, 0)
  assert.equal(matched.severity, 'info')
  assert.deepEqual(matched.unmatched_labels, ['2'])

  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id })
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  const answerMatch = candidate.answer_match as Record<string, unknown>
  assert.equal(answerMatch.matched, true)
  assert.equal(answerMatch.method, 'label')
  // Django's `apply_answer_matches` success dict drops the entry's provenance, so these stay null.
  assert.equal(answerMatch.source_page_index, null)
  assert.equal(answerMatch.document_id, null)
  assert.equal(answerMatch.document_title, null)
  assert.equal((candidate.draft_payload as Record<string, unknown>).answer_status_known, false)
  const issues = (candidate.review_issues as Array<Record<string, unknown>>).map((issue) => issue.code)
  assert.ok(issues.includes('answer_match_pending_confirmation'), JSON.stringify(issues))
})

// --------------------------------------------------------------------------
// Validation order and refusals
// --------------------------------------------------------------------------
test('O09 falls back to position matching and raises the severity to warning', async () => {
  const h = harness()
  // Probe P38: the answer sheet's label (`10`) matches no question, so the answer is attached by
  // order — and an order match is a weaker proposal, which is why the problem is a warning.
  const response = await postPdf(h, practice(h), [
    ['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')],
    ['answer_files', 'answers.pdf', 'application/pdf', ANSWERS_LABEL_MISMATCH],
  ], 'k-position')
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  const matched = (body.problems as Array<Record<string, any>>).find((problem) => problem.code === 'answers_matched')!
  assert.equal(matched.matched, 1)
  assert.equal(matched.position_matched, 1)
  assert.equal(matched.severity, 'warning')
  assert.match(matched.message, /其中 1 条按顺序匹配/)
  const candidate = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id })[0]
  const answerMatch = candidate.answer_match as Record<string, unknown>
  assert.equal(answerMatch.method, 'position')
  assert.equal(answerMatch.label, '10')
  assert.equal(answerMatch.raw, 'A')
  const issues = candidate.review_issues as Array<Record<string, unknown>>
  const pending = issues.find((issue) => issue.code === 'answer_match_pending_confirmation')!
  assert.match(String(pending.message), /方式：顺序/)
})

test('O09 validation order: files required, then source_kind, then cycle_key', async () => {
  const h = harness()
  const missing = await postPdf(h, { ...practice(h) }, [], 'k-missing')
  assert.equal(missing.status, 400)
  const missingBody = (await missing.json()) as Record<string, any>
  assert.deepEqual(missingBody.error.details.errors, [
    { type: 'missing', loc: ['file', 'files'], msg: 'Field required' },
  ])

  const badKind = await postPdf(h, { subject_id: h.subjectId, source_kind: 'nope' }, [
    ['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')],
  ], 'k-kind')
  assert.equal(badKind.status, 400)
  const badKindBody = (await badKind.json()) as Record<string, any>
  assert.equal(badKindBody.error.message, '试卷来源类型无效')
  assert.deepEqual(badKindBody.error.details, { source_kind: 'nope' })

  const noCycle = await postPdf(h, { subject_id: h.subjectId, source_kind: 'official_past' }, [
    ['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')],
  ], 'k-cycle')
  assert.equal(noCycle.status, 400)
  const noCycleBody = (await noCycle.json()) as Record<string, any>
  assert.equal(
    noCycleBody.error.message,
    '真实考试试卷必须填写年份/周期与卷别代码，否则无法进入历年统计',
  )
  // Nothing was claimed, so the same key is still usable for a valid request.
  const retried = await postPdf(
    h,
    { subject_id: h.subjectId, source_kind: 'official_past', cycle_key: '2024-06', paper_code: 'A' },
    [['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')]],
    'k-cycle',
  )
  assert.equal(retried.status, 201)
})

test('O09 refusals carry the Python message and details, and write nothing', async () => {
  const h = harness()
  const cases: Array<[string, Part, number, string, Record<string, unknown>]> = [
    ['mime', ['files', 'paper.pdf', 'text/plain', pdfBytes('normal_page')], 400, '仅支持 PDF 文件（原生文字版）', {
      content_type: 'text/plain',
      filename: 'paper.pdf',
    }],
    ['not_pdf', ['files', 'x.pdf', 'application/pdf', NOT_PDF], 400, '文件不是 PDF（缺少 %PDF- 头）', { reason: 'not_pdf' }],
    ['damaged', ['files', 'x.pdf', 'application/pdf', DAMAGED], 400, 'PDF 结构损坏，无法解析', { reason: 'damaged' }],
    [
      'scanned',
      ['files', 'scan.pdf', 'application/pdf', pdfBytes('mixed_scanned')],
      201,
      '',
      {},
    ],
  ]
  for (const [name, part, status, message, details] of cases) {
    const response = await postPdf(h, practice(h), [part], `k-refuse-${name}`)
    assert.equal(response.status, status, name)
    if (status !== 201) {
      const body = (await response.json()) as Record<string, any>
      assert.equal(body.error.message, message, name)
      assert.deepEqual(body.error.details, details, name)
    }
  }
  // Only the mixed file produced rows; the three refusals left the tables untouched.
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 1)
  assert.equal(findRows(h.db, 'ingestion_source_document', {}).length, 1)
})

test('O09 refuses a fully scanned PDF with no text layer', async () => {
  const h = harness()
  // `mixed_scanned` has native pages, so a *fully* scanned document comes from the golden's
  // `no_text_layer` error vector: the extractor refuses it before any row is written.
  const entry = (PDF_GOLDEN.errors as Array<Record<string, any>>).find((item) => item.name === 'no_text_layer')!
  const bytes = new Uint8Array(Buffer.from(entry.base64, 'base64'))
  const response = await postPdf(h, practice(h), [['files', 'scan.pdf', 'application/pdf', bytes]], 'k-scan')
  assert.equal(response.status, 400)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.error.message, entry.error.message)
  assert.deepEqual(body.error.details, entry.error.details)
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 0)
  assert.equal(findRows(h.db, 'ingestion_source_document', {}).length, 0)
})

test('O09 reports scanned pages without blocking the clean pages of the same file', async () => {
  const h = harness()
  const response = await postPdf(h, practice(h), [
    ['files', 'mixed.pdf', 'application/pdf', pdfBytes('mixed_scanned')],
  ], 'k-mixed')
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  const codes = (body.problems as Array<Record<string, unknown>>).map((problem) => problem.code)
  assert.ok(codes.includes('pdf_pages_without_text'), JSON.stringify(codes))
  assert.ok(codes.includes('page_without_text_layer_needs_manual_entry'), JSON.stringify(codes))
  const pages = body.page_diagnostics as Array<Record<string, any>>
  assert.equal(pages.length, 3)
  assert.deepEqual(pages.map((page) => page.is_scanned), [false, true, false])
  assert.deepEqual(pages[1].reasons, ['page_without_text_layer'])
  // The candidates come from the native pages only, and none of them is blocked by page 2.
  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id })
  assert.ok(candidates.length > 0)
  for (const candidate of candidates) {
    const issues = (candidate.review_issues as Array<Record<string, unknown>>).map((issue) => issue.code)
    assert.ok(!issues.includes('page_without_text_layer_needs_manual_entry'), JSON.stringify(issues))
  }
})

test('O09 blocks a multi-column candidate until the layout is confirmed', async () => {
  const h = harness()
  const response = await postPdf(h, practice(h), [
    ['files', 'columns.pdf', 'application/pdf', pdfBytes('two_columns')],
  ], 'k-columns')
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.page_diagnostics[0].columns, 2)
  const codes = (body.problems as Array<Record<string, unknown>>).map((problem) => problem.code)
  assert.ok(codes.includes('multi_column_needs_review'))

  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id }, {
    orderBy: [['created_at', 'asc']],
  })
  assert.deepEqual(
    candidates.map((candidate) => candidate.source_position_key),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
  )
  const issue = (candidates[0].review_issues as Array<Record<string, any>>).find(
    (entry) => entry.code === 'multi_column_needs_review',
  )!
  assert.equal(issue.severity, 'blocking')
  assert.deepEqual(issue.page_indexes, [1])
  assert.deepEqual(issue.reasons, ['multi_column_layout'])

  const confirmed = await h.send(
    new Request(`${BASE}/projects/${h.projectId}/import-candidates/${String(candidates[0].id)}/layout-confirm`, {
      method: 'POST',
      body: JSON.stringify({ note: '已对照原页确认：左栏四题在前，右栏四题在后' }),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-columns-confirm' },
    }),
  )
  assert.equal(confirmed.status, 200)
  const confirmedBody = (await confirmed.json()) as Record<string, any>
  assert.equal(confirmedBody.layout_review_note, '已对照原页确认：左栏四题在前，右栏四题在后')
  assert.ok(confirmedBody.layout_review_confirmed_at)
  assert.ok(!(confirmedBody.review_issues as Array<Record<string, unknown>>).some(
    (entry) => entry.code === 'multi_column_needs_review',
  ))
  // The confirmation clears that candidate only.
  const second = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id, source_position_key: '2' })[0]
  assert.ok(
    (second.review_issues as Array<Record<string, unknown>>).some(
      (entry) => entry.code === 'multi_column_needs_review',
    ),
  )
})

// --------------------------------------------------------------------------
// Idempotency, duplicates and the paper record
// --------------------------------------------------------------------------
test('O09 replays an identical request and conflicts on different bytes', async () => {
  const h = harness()
  const fields = { ...practice(h), title: '重放' }
  const first = await postPdf(h, fields, [['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')]], 'k-replay')
  assert.equal(first.status, 201)
  const firstBody = (await first.json()) as Record<string, any>

  const second = await postPdf(h, fields, [['files', 'renamed.pdf', 'application/pdf', pdfBytes('normal_page')]], 'k-replay')
  assert.equal(second.status, 201)
  const secondBody = (await second.json()) as Record<string, any>
  assert.equal(secondBody.id, firstBody.id)
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 1)

  // The same key with *different* bytes is a conflict, not a replay.
  const conflict = await postPdf(h, fields, [['files', 'other.pdf', 'application/pdf', pdfBytes('text_two_pages')]], 'k-replay')
  assert.equal(conflict.status, 409)
  const conflictBody = (await conflict.json()) as Record<string, any>
  assert.equal(conflictBody.error.code, 'idempotency_conflict')
})

test('O09 reuses an identical document instead of storing a second copy', async () => {
  const h = harness()
  const first = await postPdf(h, practice(h), [['files', 'a.pdf', 'application/pdf', pdfBytes('normal_page')]], 'k-dup-1')
  assert.equal(first.status, 201)
  const second = await postPdf(h, practice(h), [['files', 'b.pdf', 'application/pdf', pdfBytes('normal_page')]], 'k-dup-2')
  assert.equal(second.status, 201)
  const body = (await second.json()) as Record<string, any>
  const duplicate = (body.problems as Array<Record<string, any>>).find(
    (problem) => problem.code === 'duplicate_source_file',
  )!
  assert.equal(duplicate.severity, 'warning')
  assert.match(duplicate.message, /其中 1 份 PDF 与已有来源文件完全相同/)
  assert.equal(findRows(h.db, 'ingestion_source_document', {}).length, 1)
  assert.equal(findRows(h.db, 'ingestion_asset', {}).length, 1)
})

test('O09 keeps the position keys unique when one request repeats the same bytes', async () => {
  const h = harness()
  // Probe P04: the same bytes twice in one multipart body. The second file reuses the document, and
  // the parser runs over both entries, so the second copy's questions collide on the 卷面题号 and get
  // the `#2` suffix (Django's `_unique_position_key`).
  const response = await postPdf(h, practice(h), [
    ['files', 'a.pdf', 'application/pdf', pdfBytes('normal_page')],
    ['files', 'b.pdf', 'application/pdf', pdfBytes('normal_page')],
  ], 'k-repeat')
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.document_ids.length, 1)
  assert.equal(findRows(h.db, 'ingestion_source_document', {}).length, 1)
  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id }, {
    orderBy: [['created_at', 'asc']],
  })
  assert.deepEqual(
    candidates.map((candidate) => candidate.source_position_key),
    ['1', '1#2'],
  )
  const duplicated = candidates[1].review_issues as Array<Record<string, unknown>>
  assert.ok(duplicated.some((issue) => issue.code === 'duplicate_candidate'))
  const problems = (body.problems as Array<Record<string, unknown>>).map((problem) => problem.code)
  assert.ok(problems.includes('duplicate_source_file'), JSON.stringify(problems))
})

test('O09 opens a draft paper revision without confirming coverage', async () => {
  const h = harness()
  const response = await postPdf(
    h,
    {
      subject_id: h.subjectId,
      source_kind: 'official_past',
      cycle_key: '2024-06',
      session_key: 's1',
      paper_code: 'A',
      expected_session_count: '2',
      title: '真题',
    },
    [['files', 'paper.pdf', 'application/pdf', pdfBytes('text_two_pages')]],
    'k-paper',
  )
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, any>

  const papers = findRows(h.db, 'exams_paper', {})
  assert.equal(papers.length, 1)
  assert.equal(papers[0].cycle_key, '2024-06')
  assert.equal(papers[0].session_key, 's1')
  assert.equal(papers[0].paper_code, 'A')
  assert.equal(papers[0].source_kind, 'official_past')
  assert.equal(papers[0].is_demo, false)
  assert.equal(papers[0].effective_revision_id, null)

  const revisions = findRows(h.db, 'exams_paper_revision', { paper_id: papers[0].id })
  assert.equal(revisions.length, 1)
  assert.equal(revisions[0].revision, 1)
  assert.equal(revisions[0].status, 'draft')
  assert.equal(revisions[0].expected_session_count, 2)
  assert.equal(revisions[0].covered_session_count, 1)
  assert.equal(revisions[0].coverage_confirmed_at, null)
  assert.equal(revisions[0].coverage_confirmed_by_id, null)
  assert.equal(revisions[0].note, `由原生文字 PDF 导入创建（导入任务 ${body.id}）`)

  // The candidates point at that revision, which is what makes the paper-position gate reachable.
  const candidates = findRows(h.db, 'ingestion_import_candidate', { job_id: body.id })
  assert.ok(candidates.every((candidate) => candidate.paper_revision_id === revisions[0].id))
  // A paper position without a score cannot publish.
  const issues = candidates[0].review_issues as Array<Record<string, unknown>>
  assert.ok(issues.some((issue) => issue.code === 'paper_item_score_missing'))

  // A second import opens revision 2 and does not touch the effective revision.
  const again = await postPdf(
    h,
    {
      subject_id: h.subjectId,
      source_kind: 'official_past',
      cycle_key: '2024-06',
      session_key: 's1',
      paper_code: 'A',
      expected_session_count: '2',
      title: '真题',
    },
    [['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')]],
    'k-paper-2',
  )
  assert.equal(again.status, 201)
  const revisions2 = findRows(h.db, 'exams_paper_revision', { paper_id: papers[0].id }, {
    orderBy: [['revision', 'asc']],
  })
  assert.deepEqual(revisions2.map((revision) => revision.revision), [1, 2])
  assert.equal(findRows(h.db, 'exams_paper', {}).length, 1)
  assert.equal(findRows(h.db, 'exams_paper', {})[0].effective_revision_id, null)
})

test('O09 rejects a subject that belongs to another project', async () => {
  const h = harness()
  const response = await postPdf(
    h,
    { subject_id: h.otherSubjectId, source_kind: 'practice_set' },
    [['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')]],
    'k-scope',
  )
  assert.equal(response.status, 404)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.error.code, 'not_found')
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 0)
})

test('O09 rejects a non-integer expected_session_count before it writes anything', async () => {
  const h = harness()
  const response = await postPdf(
    h,
    { subject_id: h.subjectId, source_kind: 'official_past', cycle_key: '2024-06', paper_code: 'A', expected_session_count: 'two' },
    [['files', 'paper.pdf', 'application/pdf', pdfBytes('normal_page')]],
    'k-int',
  )
  assert.equal(response.status, 400)
  const body = (await response.json()) as Record<string, any>
  assert.deepEqual(body.error.details.errors, [
    {
      type: 'int_parsing',
      loc: ['body', 'payload', 'expected_session_count'],
      msg: 'Input should be a valid integer, unable to parse string as an integer',
    },
  ])
  assert.equal(findRows(h.db, 'ingestion_import_job', {}).length, 0)
})
