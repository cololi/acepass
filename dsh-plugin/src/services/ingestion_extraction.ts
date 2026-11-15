/**
 * Vision extraction worker — port of `backend/apps/ingestion/services/extraction.py`.
 *
 * The rules here are the product rules, not plumbing:
 *
 * - the model never becomes the source of truth; its output is a *candidate* subject to the same
 *   publication validation as a typed one (`applyExtraction` still sets `needs_manual_structure`),
 * - a failed or unconfigured provider falls back to the manual path with an explicit problem on the
 *   job, never to a fabricated structure,
 * - every call is recorded as an `audit_llm_run` row with the exact prompt/input versions, and
 *   `is_stub` is always false: this package has no stub provider,
 * - a human proofreading while the model works wins: the write is conditional on the candidate
 *   revision captured *before* the call (B06). The late result is kept aside as the machine record.
 *
 * Two behaviours are deliberately exposed as separate steps because they carry different
 * transaction boundaries:
 *
 * - `prepareExtraction` reads the candidate/document/job facts (short transaction, no writes),
 * - `performExtraction` reads the bytes and calls the model (outside any SQLite transaction),
 *   persisting only the audit row afterwards,
 * - `applyExtraction` / `markExtractionFailed` are the business writes, run in a short transaction
 *   under the worker's claim token.
 */
import type { DatabaseSync } from 'node:sqlite'

import { EXTRACT_PROMPT_VERSION, buildExtractPrompt } from '../ai/prompts.ts'
import type { ExtractClean } from '../ai/validators.ts'
import { validateExtractPayload } from '../ai/validators.ts'
import { parseModelJson, pySlice, pyTruthy } from '../ai/pyvalue.ts'
import { statusForFailureCode, type LlmRunRecord, newLlmRun, withCallTelemetry } from '../ai/audit.ts'
import { persistRun } from './ai_runs.ts'
import { transaction } from '../store/db.ts'
import { getRow, updateRow, type Row } from '../store/repository.ts'
import { getStorage } from '../ingestion/storage.ts'
import { addJobProblem, maybeCompleteJob, refreshCandidateIssues } from './ingestion.ts'
import type { CapabilityResult, LlmPort } from '../llm/contract.ts'
import type { Instant } from '../domain/instant.ts'

/** `vision-v1`: the extractor version a successful extraction stamps on the candidate. */
export const VISION_EXTRACTOR_VERSION = 'vision-v1'
/** `_record_run` stores a 4000-character excerpt for the extraction capability. */
export const EXTRACT_EXCERPT_LIMIT = 4000
const AUDIT_PROVIDER = 'dsh-llm'

export interface ExtractionRequest {
  importJobId: string
  documentId: string
  candidateId: string
}

export interface ExtractionFacts {
  candidate: Row
  job: Row
  document: Row
  asset: Row | null
  projectName: string
  subjectName: string
  capturedRevision: number
}

export type ExtractionPreparation = ExtractionFacts | 'candidate_missing' | 'document_missing'

/** The data the model call and the audit row need, captured before the long call. */
export function prepareExtraction(db: DatabaseSync, request: ExtractionRequest): ExtractionPreparation {
  const candidate = getRow(db, 'ingestion_import_candidate', request.candidateId)
  if (candidate === null || String(candidate.job_id) !== String(request.importJobId)) return 'candidate_missing'
  const job = getRow(db, 'ingestion_import_job', candidate.job_id)
  if (job === null) return 'candidate_missing'
  const document = getRow(db, 'ingestion_source_document', request.documentId)
  // Django only constrains the project, not membership in `job.documents` (06 §6.3).
  if (document === null || String(document.project_id) !== String(job.project_id)) return 'document_missing'
  const asset = document.asset_id === null || document.asset_id === undefined
    ? null
    : getRow(db, 'ingestion_asset', document.asset_id)
  const project = getRow(db, 'exams_project', job.project_id)
  const subject = candidate.subject_id === null || candidate.subject_id === undefined
    ? null
    : getRow(db, 'exams_subject', candidate.subject_id)
  return {
    candidate,
    job,
    document,
    asset,
    projectName: project === null ? '' : String(project.name ?? ''),
    subjectName: subject === null ? '（未指定科目）' : String(subject.name ?? ''),
    capturedRevision: Number(candidate.revision),
  }
}

export interface ExtractionCallFacts {
  provider: string
  model: string
  promptVersion: string
  rawText: string
  promptTokens: number | null
  completionTokens: number | null
  latencyMs: number | null
  attempts: number
  isStub: false
}

export type ExtractionEffect =
  | { kind: 'apply'; clean: ExtractClean; call: ExtractionCallFacts }
  | { kind: 'failed'; message: string }

export interface PerformedExtraction {
  effect: ExtractionEffect
  runId: string
  run: LlmRunRecord
}

function firstDocumentId(db: DatabaseSync, jobId: string): string | null {
  const row = db
    .prepare(
      `SELECT "sourcedocument_id" AS id FROM "ingestion_import_job_documents"
        WHERE "importjob_id" = ? ORDER BY "id" ASC LIMIT 1`,
    )
    .get(jobId) as { id: string } | undefined
  return row === undefined ? null : String(row.id)
}

function baseRun(
  db: DatabaseSync,
  facts: ExtractionFacts,
  requestSummary: Record<string, unknown>,
  status: LlmRunRecord['status'],
): LlmRunRecord {
  return {
    ...newLlmRun({
      provider: AUDIT_PROVIDER,
      capability: 'extract_question',
      prompt_version: EXTRACT_PROMPT_VERSION,
      request_summary: requestSummary,
      input_snapshot: {
        candidate_id: String(facts.candidate.id),
        // Django records the *first* document of the job, which is not necessarily this document.
        document_id: firstDocumentId(db, String(facts.job.id)),
        extractor_version: facts.candidate.extractor_version,
      },
      user_id: facts.job.created_by_id === null || facts.job.created_by_id === undefined ? null : String(facts.job.created_by_id),
      project_id: String(facts.job.project_id),
    }),
    status,
  }
}

function failedRun(
  db: DatabaseSync,
  facts: ExtractionFacts,
  requestSummary: Record<string, unknown>,
  code: string,
  message: string,
): LlmRunRecord {
  const base = baseRun(db, facts, requestSummary, statusForFailureCode(code))
  return { ...base, error_code: code, error_message: pySlice(message, 500), cost_known: false, cost_cents: null }
}

function callFacts(result: Extract<CapabilityResult, { ok: true }>): ExtractionCallFacts {
  return {
    provider: result.route.provider,
    model: result.route.model,
    promptVersion: result.promptVersion,
    rawText: result.text,
    promptTokens: result.usage?.inputTokens ?? null,
    completionTokens: result.usage?.outputTokens ?? null,
    latencyMs: result.latencyMs ?? null,
    attempts: 1,
    isStub: false,
  }
}

/**
 * Read the image, call the model and record exactly one audit row.
 *
 * Never writes a job/candidate row: callers apply `effect` under their own transaction and claim
 * (the direct service wrapper applies immediately, the worker re-checks its lease first).
 */
export async function performExtraction(
  db: DatabaseSync,
  port: LlmPort,
  facts: ExtractionFacts,
  now: Instant,
): Promise<PerformedExtraction> {
  let imageBytes: Uint8Array
  let contentType: string
  try {
    if (facts.asset === null) throw new MissingSourceImage('来源文档没有保存原始图片')
    imageBytes = getStorage().open(String(facts.asset.object_key))
    contentType = pyTruthy(facts.asset.content_type) ? String(facts.asset.content_type) : 'image/png'
  } catch (error) {
    if (error instanceof MissingSourceImage) {
      // Django catches only `FileNotFoundError` here; a missing *object* raises `StorageError`,
      // which is not caught (06 §6.3). The distinction is preserved: only a missing asset row is
      // downgraded to a job warning, a missing file propagates to the worker's retry path.
      const run = failedRun(db, facts, { reason: 'missing_source_image' }, 'missing_source_image', error.message)
      const row = transaction(db, () => persistRun(db, run, now))
      return {
        effect: { kind: 'failed', message: '来源图片不可读取，无法识别' },
        runId: String(row.id),
        run,
      }
    }
    throw error
  }

  const prompt = buildExtractPrompt({
    project_name: facts.projectName,
    subject_name: facts.subjectName,
    source_note: pyTruthy(facts.document.source_note) ? facts.document.source_note : facts.document.title,
  })
  const result = await port.run({
    capability: 'extract_question',
    promptVersion: EXTRACT_PROMPT_VERSION,
    system: '',
    prompt,
    images: [
      {
        mediaType: contentType,
        dataBase64: Buffer.from(imageBytes).toString('base64'),
      },
    ],
  })

  if (!result.ok) {
    const run = failedRun(
      db,
      facts,
      { capability: 'extract_question' },
      result.code,
      result.message,
    )
    const row = transaction(db, () => persistRun(db, run, now))
    if (result.code === 'ai_not_configured' || result.code === 'ai_capability_unsupported') {
      return {
        effect: { kind: 'failed', message: '视觉模型未配置或不可用，已保留人工录入路径' },
        runId: String(row.id),
        run,
      }
    }
    return {
      effect: { kind: 'failed', message: `视觉识别失败：${result.message}` },
      runId: String(row.id),
      run,
    }
  }

  const call = callFacts(result)
  let parsed: unknown
  try {
    parsed = parseModelJson(call.rawText)
  } catch {
    const base = baseRun(db, facts, { capability: 'extract_question' }, 'rejected')
    const run: LlmRunRecord = {
      ...withCallTelemetry(base, {
        provider: call.provider,
        model: call.model,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        latencyMs: call.latencyMs,
        attempts: call.attempts,
        costKnown: false,
        costCents: null,
        rawText: call.rawText,
      }),
      error_code: 'ai_invalid_output',
      error_message: '模型返回的不是有效 JSON',
    }
    const row = transaction(db, () => persistRun(db, run, now))
    return {
      effect: { kind: 'failed', message: '视觉模型输出不是有效 JSON，请人工录入' },
      runId: String(row.id),
      run,
    }
  }

  const allowed = facts.asset === null ? null : new Set([String(facts.asset.id)])
  const [clean, problems] = validateExtractPayload(parsed, { allowed_asset_ids: allowed })
  const accepted = problems.length === 0
  const base = baseRun(
    db,
    facts,
    { capability: 'extract_question', document_id: String(facts.document.id) },
    accepted ? 'succeeded' : 'rejected',
  )
  const run: LlmRunRecord = {
    ...withCallTelemetry(base, {
      provider: call.provider,
      model: call.model,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      latencyMs: call.latencyMs,
      attempts: call.attempts,
      costKnown: false,
      costCents: null,
      rawText: call.rawText,
    }),
    validation_result: { problems, accepted },
    error_code: accepted ? '' : 'ai_invalid_output',
    error_message: accepted ? '' : pySlice(problems.map((problem) => problem.message).join('; '), 500),
  }
  const row = transaction(db, () => persistRun(db, run, now))
  if (!accepted) {
    return {
      effect: {
        kind: 'failed',
        message:
          '视觉识别结果未通过校验，已保留人工录入路径：' +
          problems.map((problem) => problem.message).join('；'),
      },
      runId: String(row.id),
      run,
    }
  }
  return { effect: { kind: 'apply', clean: clean as ExtractClean, call }, runId: String(row.id), run }
}

/** `_apply_extraction`: conditional on the revision captured before the model call. */
export function applyExtraction(
  db: DatabaseSync,
  input: { candidateId: string; clean: ExtractClean; call: ExtractionCallFacts; expectedRevision: number },
  now: Instant,
): 'applied' | 'stale_skipped' {
  return transaction(db, () => {
    const locked = getRow(db, 'ingestion_import_candidate', input.candidateId)
    if (locked === null) throw new Error(`import candidate ${input.candidateId} is missing`)
    const machinePayload = {
      extractor: 'vision',
      is_stub_output: input.call.isStub,
      provider: input.call.provider,
      model: input.call.model,
      prompt_version: input.call.promptVersion,
      raw_excerpt: pySlice(input.call.rawText, EXTRACT_EXCERPT_LIMIT),
    }
    if (Number(locked.revision) !== Number(input.expectedRevision)) {
      const stale = updateRow(
        db,
        'ingestion_import_candidate',
        locked.id,
        {
          machine_payload: {
            ...machinePayload,
            stale_revision: true,
            extraction_started_revision: Number(input.expectedRevision),
            applied_revision: Number(locked.revision),
            pending_clean_payload: input.clean,
          },
        },
        { now },
      )
      if (stale === null) throw new Error(`import candidate ${input.candidateId} is missing`)
      const job = getRow(db, 'ingestion_import_job', stale.job_id)
      if (job === null) throw new Error(`import job ${String(stale.job_id)} is missing`)
      addJobProblem(
        db,
        job,
        {
          code: 'vision_extracted_stale',
          message:
            '视觉识别完成时该候选已被人工修改：模型结果只作为机器记录保留，未覆盖人工内容。' +
            '如需要模型版本，请在机器记录中对比后手工采用。',
          severity: 'warning',
        },
        now,
      )
      return 'stale_skipped'
    }
    const draft = (locked.draft_payload !== null && typeof locked.draft_payload === 'object' && !Array.isArray(locked.draft_payload)
      ? (locked.draft_payload as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const payload = {
      question_type: pyTruthy(input.clean.question_type) ? input.clean.question_type : 'single_choice',
      display_label: pyTruthy(input.clean.display_label) ? input.clean.display_label : (draft['display_label'] ?? ''),
      content: pyTruthy(input.clean.content) ? input.clean.content : { blocks: [{ kind: 'text', text: '' }] },
      answer_payload: pyTruthy(input.clean.answer_payload) ? input.clean.answer_payload : {},
      answer_status_known: Boolean(input.clean.answer_status_known),
      // The model never asserts a structure is finished; a human confirms it.
      needs_manual_structure: true,
      doubts: pyTruthy(input.clean.doubts) ? input.clean.doubts : [],
    }
    const updated = updateRow(
      db,
      'ingestion_import_candidate',
      locked.id,
      {
        machine_payload: machinePayload,
        draft_payload: payload,
        is_stub_output: false,
        extractor_version: VISION_EXTRACTOR_VERSION,
        revision: Number(locked.revision) + 1,
      },
      { now },
    )
    if (updated === null) throw new Error(`import candidate ${input.candidateId} is missing`)
    refreshCandidateIssues(db, updated, now)
    const job = getRow(db, 'ingestion_import_job', updated.job_id)
    if (job === null) throw new Error(`import job ${String(updated.job_id)} is missing`)
    const refreshedJob = addJobProblem(
      db,
      job,
      {
        code: 'vision_extracted',
        message: '已用视觉模型生成候选结构；仍需人工对照原图核对题干、选项与答案后才能发布。',
        severity: 'warning',
      },
      now,
    )
    if (refreshedJob.status === 'processing') maybeCompleteJob(db, refreshedJob, now)
    return 'applied'
  })
}

/** `_mark_extraction_failed`: keep the manual path open and finish the job if it can. */
export function markExtractionFailed(db: DatabaseSync, candidateId: string, message: string, now: Instant): void {
  transaction(db, () => {
    const candidate = getRow(db, 'ingestion_import_candidate', candidateId)
    if (candidate === null) throw new Error(`import candidate ${candidateId} is missing`)
    const job = getRow(db, 'ingestion_import_job', candidate.job_id)
    if (job === null) throw new Error(`import job ${String(candidate.job_id)} is missing`)
    const withProblem = addJobProblem(
      db,
      job,
      { code: 'vision_extraction_failed', message, severity: 'warning' },
      now,
    )
    const draft = candidate.draft_payload !== null && typeof candidate.draft_payload === 'object' && !Array.isArray(candidate.draft_payload)
      ? (candidate.draft_payload as Record<string, unknown>)
      : {}
    if (!pyTruthy(draft['needs_manual_structure'])) {
      updateRow(db, 'ingestion_import_candidate', candidate.id, {
        draft_payload: { ...draft, needs_manual_structure: true },
      }, { now })
    }
    if (withProblem.status === 'processing') maybeCompleteJob(db, withProblem, now)
  })
}

/** `extract_image_candidate`: the whole service in one call (used by tests and direct callers). */
export async function extractImageCandidate(
  db: DatabaseSync,
  port: LlmPort,
  request: ExtractionRequest,
  now: Instant,
): Promise<string> {
  const prepared = prepareExtraction(db, request)
  if (prepared === 'candidate_missing') return 'candidate_missing'
  if (prepared === 'document_missing') return 'document_missing'
  const performed = await performExtraction(db, port, prepared, now)
  if (performed.effect.kind === 'apply') {
    applyExtraction(
      db,
      {
        candidateId: String(prepared.candidate.id),
        clean: performed.effect.clean,
        call: performed.effect.call,
        expectedRevision: prepared.capturedRevision,
      },
      now,
    )
    // Django's outer `extract_image_candidate` returns "ok" even when `_apply_extraction` reports
    // `stale_skipped`: the late result is recorded, nothing was overwritten.
    return 'ok'
  }
  markExtractionFailed(db, String(prepared.candidate.id), performed.effect.message, now)
  return extractionStatusOf(performed.run)
}

function extractionStatusOf(run: LlmRunRecord): string {
  if (run.status === 'rejected') return run.error_message.startsWith('模型返回的不是有效 JSON') ? 'invalid_output' : 'rejected'
  if (run.status === 'unavailable') return 'unavailable'
  if (run.status === 'timeout' || run.status === 'failed') {
    return run.error_code === 'missing_source_image' ? 'missing_source_image' : 'failed'
  }
  return 'failed'
}

export class MissingSourceImage extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingSourceImage'
  }
}

