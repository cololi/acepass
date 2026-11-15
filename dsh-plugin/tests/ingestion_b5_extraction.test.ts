/**
 * The `ingestion.extract_candidate` worker (B5): success, rejection, unconfigured, late revision.
 *
 * The port is a tests-only fake: no network, no stub provider in the shipped package. Every case
 * asserts both the business outcome and the audit row (`audit_llm_run`), because "the model did
 * nothing" and "we never asked" must stay distinguishable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, getRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { insertRow } from '../src/store/repository.ts'
import { prepareAssetImage, createImageDocument } from '../src/services/ingestion_sources.ts'
import { startImageImport } from '../src/services/ingestion_imports.ts'
import { updateCandidate } from '../src/services/ingestion.ts'
import { extractImageCandidate } from '../src/services/ingestion_extraction.ts'
import { configureStorage, resetStorageCache } from '../src/ingestion/storage.ts'
import { loadSharp } from '../src/ingestion/sharp.ts'
import { runOnceAsync } from '../src/jobs/worker.ts'
import type { CapabilityResult, LlmPort } from '../src/llm/contract.ts'

const NOW = parseInstant('2026-09-12T00:00:00+00:00')
const MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'acepass-b5-extraction-'))
configureStorage(MEDIA_ROOT)
process.on('exit', () => {
  resetStorageCache()
  rmSync(MEDIA_ROOT, { recursive: true, force: true })
})

const sharp = loadSharp() as unknown as (input: unknown, options?: Record<string, unknown>) => any

const EXTRACT_JSON = JSON.stringify({
  question_type: 'single_choice',
  display_label: '识别题1',
  content: {
    blocks: [{ kind: 'text', text: '视觉模型识别出的题干。' }],
    options: [
      { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '甲' }] },
      { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '乙' }] },
    ],
  },
  answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
  answer_status_known: true,
  source_hint: {},
  doubts: [],
})

function success(text = EXTRACT_JSON): CapabilityResult {
  return {
    ok: true,
    text,
    route: { provider: 'test-provider', model: 'test-vision-model' },
    promptVersion: 'p0-extract-v1',
    capability: 'extract_question',
    usage: { inputTokens: 31, outputTokens: 12 },
    latencyMs: 9,
  }
}

function failure(code: string, message: string): CapabilityResult {
  return {
    ok: false,
    code: code as never,
    message,
    capability: 'extract_question',
    promptVersion: 'p0-extract-v1',
    retryable: code === 'ai_timeout',
  }
}

function portReturning(
  result: CapabilityResult | (() => Promise<CapabilityResult>),
): LlmPort {
  return {
    async availability() {
      return {
        extract_question: { available: true },
      } as never
    },
    async run() {
      return typeof result === 'function' ? await result() : result
    },
  }
}

interface ImageWorld {
  db: ReturnType<typeof openStore>['db']
  userId: string
  projectId: string
  subjectId: string
  job: Record<string, unknown>
  document: Record<string, unknown>
  candidate: Record<string, unknown>
  event: Record<string, unknown>
}

async function imageWorld(): Promise<ImageWorld> {
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
  const projectId = String(createProject(db, userId, { name: '图片导入' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id)
  const bytes = new Uint8Array(
    await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 15, g: 25, b: 35 } } }).png().toBuffer(),
  )
  const prepared = await prepareAssetImage({ bytes, contentType: 'image/png', reencode: true })
  const document = createImageDocument(
    db,
    {
      ownerId: userId,
      projectId,
      subjectId,
      prepared,
      content: bytes,
      contentType: 'image/png',
      role: 'past_paper_page',
      title: '第一页',
      sourceNote: '2026 年真题扫描件',
      originalFilename: 'page-1.png',
    },
    NOW,
  )
  const job = startImageImport(
    db,
    { ownerId: userId, projectId, subjectId, documents: [document], title: '图片导入', useVision: true },
    NOW,
  )
  const candidate = findRows(db, 'ingestion_import_candidate', { job_id: job.id })[0]
  const event = findRows(db, 'audit_outbox_event', {})[0]
  return { db, userId, projectId, subjectId, job, document, candidate, event }
}

function countTables(db: ReturnType<typeof openStore>['db']): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number }
    out[table.name] = Number(row.n)
  }
  return out
}

test('extraction: a successful vision result opens the manual proofreading step (one audit row)', async () => {
  const w = await imageWorld()
  const before = countTables(w.db)
  const result = await runOnceAsync(w.db, NOW, { llm: () => portReturning(success()) })
  assert.deepEqual(result, { handled: 1, failed: 0, skipped: 0 })

  const candidate = getRow(w.db, 'ingestion_import_candidate', String(w.candidate.id))!
  assert.equal(Number(candidate.revision), 2)
  assert.equal(candidate.extractor_version, 'vision-v1')
  assert.equal(candidate.is_stub_output, false)
  const draft = candidate.draft_payload as Record<string, unknown>
  assert.equal(draft['question_type'], 'single_choice')
  assert.equal(draft['display_label'], '识别题1')
  assert.deepEqual(draft['answer_payload'], { kind: 'single_choice', correct_option_id: 'opt_a' })
  assert.equal(draft['answer_status_known'], true)
  assert.equal(draft['needs_manual_structure'], true, 'the model never asserts a structure is finished')
  const machine = candidate.machine_payload as Record<string, unknown>
  assert.equal(machine['extractor'], 'vision')
  assert.equal(machine['is_stub_output'], false)
  assert.equal(machine['provider'], 'test-provider')
  assert.equal(machine['model'], 'test-vision-model')
  assert.equal(machine['prompt_version'], 'p0-extract-v1')
  assert.equal(machine['raw_excerpt'], EXTRACT_JSON)

  const job = getRow(w.db, 'ingestion_import_job', String(w.job.id))!
  const problems = job.problems as Array<Record<string, unknown>>
  assert.ok(problems.some((problem) => problem['code'] === 'vision_extraction_queued'))
  assert.ok(problems.some((problem) => problem['code'] === 'vision_extracted' && problem['severity'] === 'warning'))
  assert.equal(findRows(w.db, 'audit_llm_run', {}).length, 1)
  const run = findRows(w.db, 'audit_llm_run', {})[0]
  assert.equal(run.capability, 'extract_question')
  assert.equal(run.status, 'succeeded')
  assert.equal(run.model_identifier, 'test-vision-model')
  assert.equal(run.provider, 'test-provider')
  assert.equal(Number(run.prompt_tokens), 31)
  assert.equal(Number(run.completion_tokens), 12)
  assert.equal(run.cost_known, false)
  assert.equal(run.cost_cents, null)
  assert.equal(run.is_stub, false)
  assert.deepEqual(run.validation_result, { problems: [], accepted: true })
  const event = getRow(w.db, 'audit_outbox_event', String(w.event.id))!
  assert.equal(event.status, 'processed')
  assert.ok(event.processed_at !== null)

  const after = countTables(w.db)
  const changed = Object.keys(after).filter((table) => after[table] !== before[table]).sort()
  assert.deepEqual(changed, ['audit_llm_run'], 'the outbox row keeps its count; the candidate is updated in place')
  for (const table of changed) {
    assert.ok(!/grade|evidence|state|mastery/.test(table), table)
  }
})

test('extraction: a validation failure keeps the manual candidate and records a rejected run', async () => {
  const w = await imageWorld()
  const broken = JSON.stringify({ question_type: 'single_choice', content: { blocks: [] } })
  const result = await runOnceAsync(w.db, NOW, { llm: () => portReturning(success(broken)) })
  assert.deepEqual(result, { handled: 1, failed: 0, skipped: 0 })
  const candidate = getRow(w.db, 'ingestion_import_candidate', String(w.candidate.id))!
  assert.equal(Number(candidate.revision), 1, 'a rejected result never touches the human draft')
  const draft = candidate.draft_payload as Record<string, unknown>
  assert.equal(draft['needs_manual_structure'], true)
  assert.equal(draft['display_label'], '图片导入', 'the manual draft (created from the title) is untouched')
  const job = getRow(w.db, 'ingestion_import_job', String(w.job.id))!
  const problems = job.problems as Array<Record<string, unknown>>
  const failed = problems.find((problem) => problem['code'] === 'vision_extraction_failed')
  assert.ok(failed)
  assert.match(String(failed!['message']), /^视觉识别结果未通过校验，已保留人工录入路径：/)
  const run = findRows(w.db, 'audit_llm_run', {})[0]
  assert.equal(run.status, 'rejected')
  assert.equal(run.error_code, 'ai_invalid_output')
  assert.ok(String(run.error_message).length > 0, 'the joined validator messages are stored as the reason')
  assert.equal((run.validation_result as Record<string, unknown>)['accepted'], false)
})

test('extraction: invalid JSON is a rejected run, not a crash', async () => {
  const w = await imageWorld()
  const result = await runOnceAsync(w.db, NOW, { llm: () => portReturning(success('not json at all')) })
  assert.deepEqual(result, { handled: 1, failed: 0, skipped: 0 })
  const run = findRows(w.db, 'audit_llm_run', {})[0]
  assert.equal(run.status, 'rejected')
  assert.equal(run.error_code, 'ai_invalid_output')
  assert.equal(run.error_message, '模型返回的不是有效 JSON')
  const job = getRow(w.db, 'ingestion_import_job', String(w.job.id))!
  assert.ok(
    (job.problems as Array<Record<string, unknown>>).some(
      (problem) => problem['code'] === 'vision_extraction_failed' && problem['message'] === '视觉模型输出不是有效 JSON，请人工录入',
    ),
  )
})

test('extraction: a capability that disappears after queueing is an audited manual degradation', async () => {
  const w = await imageWorld()
  const result = await runOnceAsync(w.db, NOW, {
    llm: () => portReturning(failure('ai_not_configured', 'AI 未配置')),
  })
  assert.deepEqual(result, { handled: 1, failed: 0, skipped: 0 })
  const run = findRows(w.db, 'audit_llm_run', {})[0]
  assert.equal(run.status, 'unavailable')
  assert.equal(run.error_code, 'ai_not_configured')
  assert.equal(run.model_identifier, '')
  const candidate = getRow(w.db, 'ingestion_import_candidate', String(w.candidate.id))!
  assert.equal(Number(candidate.revision), 1)
  const job = getRow(w.db, 'ingestion_import_job', String(w.job.id))!
  assert.ok(
    (job.problems as Array<Record<string, unknown>>).some(
      (problem) =>
        problem['code'] === 'vision_extraction_failed' &&
        problem['message'] === '视觉模型未配置或不可用，已保留人工录入路径',
    ),
  )
  const event = getRow(w.db, 'audit_outbox_event', String(w.event.id))!
  assert.equal(event.status, 'processed', 'an unconfigured provider is not retried forever')
})

test('extraction: a human edit during the call wins; the late result is kept aside (B06)', async () => {
  const w = await imageWorld()
  const port: LlmPort = {
    async availability() {
      return { extract_question: { available: true } } as never
    },
    async run() {
      // The reviewer proofreads while the model is working: revision 1 → 2.
      updateCandidate(
        w.db,
        w.userId,
        w.projectId,
        String(w.candidate.id),
        {
          draftPayload: {
            question_type: 'single_choice',
            display_label: '人工改过的标题',
            content: { blocks: [{ kind: 'text', text: '人工录入的题干' }] },
            answer_payload: {},
            answer_status_known: false,
            needs_manual_structure: true,
          },
          subjectId: null,
          expectedRevision: 1,
          note: '人工校对',
        },
        NOW,
      )
      return success()
    },
  }
  const result = await runOnceAsync(w.db, NOW, { llm: () => port })
  assert.deepEqual(result, { handled: 1, failed: 0, skipped: 0 })
  const candidate = getRow(w.db, 'ingestion_import_candidate', String(w.candidate.id))!
  assert.equal(Number(candidate.revision), 2)
  const draft = candidate.draft_payload as Record<string, unknown>
  assert.equal(draft['display_label'], '人工改过的标题', 'the human draft is untouched')
  assert.deepEqual(draft['content'], { blocks: [{ kind: 'text', text: '人工录入的题干' }] })
  const machine = candidate.machine_payload as Record<string, unknown>
  assert.equal(machine['stale_revision'], true)
  assert.equal(machine['extraction_started_revision'], 1)
  assert.equal(machine['applied_revision'], 2)
  assert.ok(machine['pending_clean_payload'] !== undefined)
  assert.equal(machine['extractor'], 'vision')
  const job = getRow(w.db, 'ingestion_import_job', String(w.job.id))!
  assert.ok(
    (job.problems as Array<Record<string, unknown>>).some(
      (problem) => problem['code'] === 'vision_extracted_stale',
    ),
  )
  const run = findRows(w.db, 'audit_llm_run', {})[0]
  assert.equal(run.status, 'succeeded', 'the call itself succeeded; only its application was stale')
  assert.equal(findRows(w.db, 'audit_outbox_event', {})[0].status, 'processed')
})

test('extraction: a transport failure is retried by the outbox, not confirmed', async () => {
  const w = await imageWorld()
  const port: LlmPort = {
    async availability() {
      return { extract_question: { available: true } } as never
    },
    async run() {
      throw new Error('socket hang up')
    },
  }
  const result = await runOnceAsync(w.db, NOW, { llm: () => port })
  assert.deepEqual(result, { handled: 0, failed: 1, skipped: 0 })
  const event = getRow(w.db, 'audit_outbox_event', String(w.event.id))!
  assert.notEqual(event.status, 'processed')
  assert.match(String(event.last_error), /socket hang up/)
  assert.equal(findRows(w.db, 'audit_llm_run', {}).length, 0, 'a crash before the call leaves no false audit row')
  const candidate = getRow(w.db, 'ingestion_import_candidate', String(w.candidate.id))!
  assert.equal(Number(candidate.revision), 1)
})

test('extraction: a missing candidate or document is a no-op, not a failure', async () => {
  const w = await imageWorld()
  const port = portReturning(success())
  assert.equal(
    await extractImageCandidate(
      w.db,
      port,
      { importJobId: String(w.job.id), documentId: String(w.document.id), candidateId: '00000000-0000-4000-8000-000000000000' },
      NOW,
    ),
    'candidate_missing',
  )
  assert.equal(
    await extractImageCandidate(
      w.db,
      port,
      { importJobId: String(w.job.id), documentId: '00000000-0000-4000-8000-000000000000', candidateId: String(w.candidate.id) },
      NOW,
    ),
    'document_missing',
  )
  assert.equal(findRows(w.db, 'audit_llm_run', {}).length, 0)
  assert.equal(Number(getRow(w.db, 'ingestion_import_candidate', String(w.candidate.id))!.revision), 1)
})
