/**
 * Persist model calls: every attempt leaves one `audit_llm_run` row, always.
 *
 * Port of the recording half of the Python services that build an `LLMRun`.
 *
 * The rule this module enforces is an audit rule, not a logging nicety: a call that is refused
 * because no provider is configured still leaves a row saying so. Otherwise "the model produced
 * nothing" and "we never asked" become indistinguishable in the record, and a later reviewer cannot
 * tell a missing feature from a failure.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Instant } from '../domain/instant.ts'
import type { CapabilityRequest, CapabilityResult, LlmPort } from '../llm/contract.ts'
import {
  markFailed,
  markRejected,
  markSucceeded,
  newLlmRun,
  type AuditCapability,
  type LlmRunRecord,
} from '../ai/audit.ts'
import { insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'

export interface RunContext {
  userId: string | null
  projectId: string | null
  /** The prompt's own summary of what was asked, before any model output exists. */
  requestSummary?: Record<string, unknown>
  inputSnapshot?: Record<string, unknown>
  retrievalSourceIds?: string[]
}

/** The columns `audit_llm_run` actually has; the record is copied field by field so a rename in the
 *  pure layer fails loudly here instead of silently writing a blank audit row. */
const PERSISTED_FIELDS = [
  'provider',
  'model_identifier',
  'capability',
  'prompt_version',
  'status',
  'request_summary',
  'input_snapshot',
  'retrieval_source_ids',
  'validation_result',
  'raw_response_excerpt',
  'prompt_tokens',
  'completion_tokens',
  'cost_cents',
  'cost_known',
  'latency_ms',
  'attempts',
  'error_code',
  'error_message',
  'is_stub',
  'user_id',
  'project_id',
] as const

export function persistRun(db: DatabaseSync, record: LlmRunRecord, now: Instant): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of PERSISTED_FIELDS) {
    if (!(field in record)) throw new Error(`llm run record is missing ${field}`)
    values[field] = (record as unknown as Record<string, unknown>)[field]
  }
  return insertRow(db, 'audit_llm_run', values, { now })
}

export interface RunResult {
  result: CapabilityResult
  run: LlmRunRecord
  rowId: string | null
}

export interface AuditedRunHandle {
  rowId: string
  record: LlmRunRecord
}

/**
 * Create the run row **before** the model call.
 *
 * The O19 proposal loop needs this shape because Django's `_start_run()` creates a `failed` row
 * before every `call_with_deadline`: an interrupted proposal therefore leaves an honest "we tried"
 * row, and the post-call facts must update **that same row** rather than insert a second one
 * (`06 §6.1`: never a second run to repair the status).
 */
export function beginAuditedRun(
  db: DatabaseSync,
  request: CapabilityRequest,
  context: RunContext,
  now: Instant,
): AuditedRunHandle {
  const capability = request.capability as AuditCapability
  if (!AUDIT_CAPABILITIES.has(capability)) {
    throw new Error(`capability ${capability} has no prompt version and cannot be audited`)
  }
  const record = newLlmRun({
    provider: 'dsh-llm',
    capability,
    prompt_version: request.promptVersion as LlmRunRecord['prompt_version'],
    request_summary: context.requestSummary ?? {},
    input_snapshot: context.inputSnapshot ?? {},
    retrieval_source_ids: context.retrievalSourceIds ?? [],
    user_id: context.userId,
    project_id: context.projectId,
  })
  const row = transaction(db, () => persistRun(db, record, now))
  return { rowId: String(row.id), record }
}

/** Update the row created by {@link beginAuditedRun}; the primary key is the identity. */
export function finishAuditedRun(db: DatabaseSync, rowId: string, record: LlmRunRecord, now: Instant): void {
  const values: Record<string, unknown> = {}
  for (const field of PERSISTED_FIELDS) {
    if (!(field in record)) throw new Error(`llm run record is missing ${field}`)
    values[field] = (record as unknown as Record<string, unknown>)[field]
  }
  transaction(db, () => {
    const updated = updateRow(db, 'audit_llm_run', rowId, values, { now })
    if (updated === null) throw new Error(`llm run ${rowId} disappeared before it could be completed`)
  })
}

/** The telemetry a `CapabilityResult` carries. The model identifier comes from `route.model`. */
export function telemetryOf(result: CapabilityResult): {
  provider: string
  model: string
  promptTokens: number | null
  completionTokens: number | null
  latencyMs: number | null
  rawText: string
} {
  if (!result.ok) {
    return { provider: 'dsh-llm', model: '', promptTokens: null, completionTokens: null, latencyMs: null, rawText: '' }
  }
  return {
    provider: result.route.provider,
    model: result.route.model,
    promptTokens: result.usage?.inputTokens ?? null,
    completionTokens: result.usage?.outputTokens ?? null,
    latencyMs: result.latencyMs ?? null,
    rawText: result.text,
  }
}

/**
 * Run one capability and record it.
 *
 * The row is written **after** the call in a single insert, which is deliberate: a partial row would
 * claim a latency or a token count that never happened. A crash during the call therefore leaves no
 * row at all — honest, and the outbox retry will produce exactly one row for the retry.
 */
export async function runCapability(
  db: DatabaseSync,
  port: LlmPort,
  request: CapabilityRequest,
  context: RunContext,
  now: Instant,
  options: { signal?: AbortSignal; validation?: Record<string, unknown> } = {},
): Promise<RunResult> {
  const signal = options.signal
  // What the caller's validator decided about the text, recorded with the run either way.
  const validation = options.validation ?? {}
  const capability = request.capability as AuditCapability
  if (!AUDIT_CAPABILITIES.has(capability)) {
    // `embed` is not an audited prompt capability: DSH has no embedding endpoint at all, and a run
    // row for it would claim a call that can never be made.
    throw new Error(`capability ${capability} has no prompt version and cannot be audited`)
  }
  const run = newLlmRun({
    provider: 'dsh-llm',
    capability,
    // The prompt version must be one this package actually ships, or the audit row would name a
    // prompt nobody can reproduce.
    prompt_version: request.promptVersion as LlmRunRecord['prompt_version'],
    request_summary: context.requestSummary ?? {},
    input_snapshot: context.inputSnapshot ?? {},
    retrieval_source_ids: context.retrievalSourceIds ?? [],
    user_id: context.userId,
    project_id: context.projectId,
  })

  const startedAt = Date.now()
  // The request carries its own signal, so the port's single-argument contract is enough.
  const result = await port.run(signal === undefined ? request : { ...request, signal })
  const telemetry = {
    // The route is the only place the answering provider/model is known; `dsh-llm` is the adapter.
    provider: result.ok ? result.route.provider : 'dsh-llm',
    model: result.ok ? result.route.model : '',
    promptTokens: result.ok ? (result.usage?.inputTokens ?? null) : null,
    completionTokens: result.ok ? (result.usage?.outputTokens ?? null) : null,
    latencyMs: Date.now() - startedAt,
    attempts: 1,
    // dsh-llm reports no price, so a cost is never invented.
    costKnown: false,
    costCents: null,
    rawText: result.ok ? result.text : '',
  }

  const telemetryFull = telemetry
  let record: LlmRunRecord
  if (result.ok) {
    record = markSucceeded(run, telemetryFull, validation)
  } else if ((result.code as string) === 'ai_schema_invalid' || (result.code as string) === 'ai_unsupported') {
    // The provider answered, but the answer cannot be used: that is a rejection with a reason, not a
    // transport failure, and the reason belongs in `validation_result`.
    record = markRejected(run, telemetryFull, validation, result.message)
  } else {
    record = markFailed(run, { code: result.code, message: result.message }, telemetryFull)
  }

  const row = transaction(db, () => persistRun(db, record, now))
  return { result, run: record, rowId: String(row.id) }
}

const AUDIT_CAPABILITIES: ReadonlySet<string> = new Set([
  'extract_question',
  'transcribe_handwriting',
  'suggest_tags',
  'explain',
  'diagnose',
  'estimate_grade',
  'propose_variant',
])

/** The honest state of every capability, for the "AI 未配置" screen. */
export async function capabilitiesOf(
  port: LlmPort,
  signal?: AbortSignal,
): Promise<Record<string, { available: boolean; reason?: string }>> {
  return port.availability(signal)
}
