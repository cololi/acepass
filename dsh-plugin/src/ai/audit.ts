/**
 * `llm_run` audit shape and status transitions, ported from `apps/audit/models.py::LLMRun` and the
 * recording helpers in the seven call sites.
 *
 * Two invariants live here:
 *  1. `is_stub` is always `false`. There is no stub provider in this package (the DSH port has none),
 *     so no code path may mark a row as a test/demo output — and nothing may be labelled as a real
 *     result while actually being a stub.
 *  2. Cost is never invented. dsh-llm reports no price, so `cost_known` stays `false` and
 *     `cost_cents` stays `null`; token counts are recorded only when the provider reported them.
 *
 * The record intentionally has no timestamps: the store assigns `id`/`created_at`/`updated_at`, and
 * this layer must not read a clock.
 */
import type { CoachPromptVersion } from './coach_prompts.ts'
import { pySlice } from './pyvalue.ts'
import { PROMPT_VERSIONS, type PromptVersion } from './prompts.ts'

export const LLM_RUN_TABLE = 'audit_llm_run'

/** `LlmRunStatus` (apps/common/enums.py). There is no queued/running: a call is born `failed`. */
export const LLM_RUN_STATUSES = ['succeeded', 'failed', 'rejected', 'unavailable', 'timeout'] as const
export type LlmRunStatus = (typeof LLM_RUN_STATUSES)[number]
export const LLM_RUN_STATUS_LABELS: Record<LlmRunStatus, string> = {
  succeeded: '成功',
  failed: '失败',
  rejected: '输出未通过校验',
  unavailable: '未配置或不可用',
  timeout: '超时',
}

export type AuditCapability = keyof typeof PROMPT_VERSIONS | 'memory_coach'
export type AuditPromptVersion = PromptVersion | CoachPromptVersion

/** `AUDIT_EXCERPT_LIMITS` mirrors the per-call-site slice of `call.raw_text`. */
export const AUDIT_EXCERPT_LIMITS: Record<AuditCapability, number> = {
  memory_coach: 4000,
  extract_question: 4000, // ingestion/services/extraction.py
  explain: 4000, // tutoring/services/core.py
  suggest_tags: 2000, // knowledge/services/suggestions.py
  transcribe_handwriting: 4000, // practice/services/transcription.py
  estimate_grade: 4000, // practice/services/estimation.py
  diagnose: 4000, // practice/services/diagnosis.py
  propose_variant: 2000, // question_bank/services/variants.py
}

export interface LlmRunFieldMeta {
  name: string
  kind: string
  nullable: boolean
  blank: boolean
  maxLength: number | null
  default: unknown
  generated: boolean
  choices?: readonly (readonly [string, string])[]
}

/**
 * Column metadata, in Django field-declaration order.
 *
 * Kept as data because the Postgres schema (Phase 2) must reproduce it: `raw_response_excerpt` is
 * TEXT, `cost_cents` is `Decimal(10,4)`, `error_message` is capped at 500, and the status column is
 * only 16 chars wide — a longer status would be rejected by the database, not silently truncated.
 */
export const LLM_RUN_FIELDS: readonly LlmRunFieldMeta[] = [
  { name: 'id', kind: 'uuid', nullable: false, blank: false, maxLength: 32, default: 'uuid4', generated: true },
  { name: 'created_at', kind: 'datetime', nullable: false, blank: true, maxLength: null, default: 'auto_now_add', generated: true },
  { name: 'updated_at', kind: 'datetime', nullable: false, blank: true, maxLength: null, default: 'auto_now', generated: true },
  { name: 'provider', kind: 'char', nullable: false, blank: false, maxLength: 60, default: null, generated: false },
  { name: 'model_identifier', kind: 'char', nullable: false, blank: true, maxLength: 120, default: null, generated: false },
  { name: 'capability', kind: 'char', nullable: false, blank: false, maxLength: 40, default: null, generated: false },
  { name: 'prompt_version', kind: 'char', nullable: false, blank: true, maxLength: 40, default: null, generated: false },
  {
    name: 'status', kind: 'char', nullable: false, blank: false, maxLength: 16, default: 'failed', generated: false,
    choices: LLM_RUN_STATUSES.map((status) => [status, LLM_RUN_STATUS_LABELS[status]] as const),
  },
  { name: 'request_summary', kind: 'json', nullable: false, blank: true, maxLength: null, default: {}, generated: false },
  { name: 'input_snapshot', kind: 'json', nullable: false, blank: true, maxLength: null, default: {}, generated: false },
  { name: 'retrieval_source_ids', kind: 'json', nullable: false, blank: true, maxLength: null, default: [], generated: false },
  { name: 'validation_result', kind: 'json', nullable: false, blank: true, maxLength: null, default: {}, generated: false },
  { name: 'raw_response_excerpt', kind: 'text', nullable: false, blank: true, maxLength: null, default: null, generated: false },
  { name: 'prompt_tokens', kind: 'positive_int', nullable: true, blank: true, maxLength: null, default: null, generated: false },
  { name: 'completion_tokens', kind: 'positive_int', nullable: true, blank: true, maxLength: null, default: null, generated: false },
  { name: 'cost_cents', kind: 'decimal', nullable: true, blank: true, maxLength: null, default: null, generated: false },
  { name: 'cost_known', kind: 'bool', nullable: false, blank: false, maxLength: null, default: false, generated: false },
  { name: 'latency_ms', kind: 'positive_int', nullable: true, blank: true, maxLength: null, default: null, generated: false },
  { name: 'attempts', kind: 'positive_small_int', nullable: false, blank: false, maxLength: null, default: 1, generated: false },
  { name: 'error_code', kind: 'char', nullable: false, blank: true, maxLength: 80, default: null, generated: false },
  { name: 'error_message', kind: 'char', nullable: false, blank: true, maxLength: 500, default: null, generated: false },
  { name: 'is_stub', kind: 'bool', nullable: false, blank: false, maxLength: null, default: false, generated: false },
  { name: 'user', kind: 'fk', nullable: true, blank: true, maxLength: null, default: null, generated: false },
  { name: 'project_id', kind: 'uuid', nullable: true, blank: true, maxLength: 32, default: null, generated: false },
]

export interface LlmRunRecord {
  provider: string
  model_identifier: string
  capability: AuditCapability
  prompt_version: AuditPromptVersion
  status: LlmRunStatus
  request_summary: Record<string, unknown>
  input_snapshot: Record<string, unknown>
  retrieval_source_ids: string[]
  validation_result: Record<string, unknown>
  raw_response_excerpt: string
  prompt_tokens: number | null
  completion_tokens: number | null
  /** Always `null` unless a provider actually reported a cost (`cost_known`). dsh-llm does not. */
  cost_cents: string | null
  cost_known: boolean
  latency_ms: number | null
  attempts: number
  error_code: string
  error_message: string
  /** Literal `false`: this package has no stub, and no row may claim/deny stub output by accident. */
  is_stub: false
  user_id: string | null
  project_id: string | null
}

export interface LlmRunSeed {
  provider: string
  model_identifier?: string
  capability: AuditCapability
  prompt_version: AuditPromptVersion
  request_summary?: Record<string, unknown>
  input_snapshot?: Record<string, unknown>
  retrieval_source_ids?: string[]
  user_id?: string | null
  project_id?: string | null
}

/**
 * A freshly created row. The Django code creates every run with `status=FAILED` before the call, so
 * an interrupted worker leaves an honest "we tried" row instead of no row at all.
 */
export function newLlmRun(seed: LlmRunSeed): LlmRunRecord {
  return {
    provider: seed.provider,
    model_identifier: seed.model_identifier ?? '',
    capability: seed.capability,
    prompt_version: seed.prompt_version,
    status: 'failed',
    request_summary: seed.request_summary ?? {},
    input_snapshot: seed.input_snapshot ?? {},
    retrieval_source_ids: seed.retrieval_source_ids ?? [],
    validation_result: {},
    raw_response_excerpt: '',
    prompt_tokens: null,
    completion_tokens: null,
    cost_cents: null,
    cost_known: false,
    latency_ms: null,
    attempts: 1,
    error_code: '',
    error_message: '',
    is_stub: false,
    user_id: seed.user_id ?? null,
    project_id: seed.project_id ?? null,
  }
}

/** Telemetry a provider call hands back to the audit layer. */
export interface CallTelemetry {
  provider?: string
  model?: string
  promptTokens?: number | null
  completionTokens?: number | null
  /** Only meaningful with `costKnown: true`; dsh-llm never reports a price. */
  costCents?: string | null
  costKnown?: boolean
  attempts?: number
  latencyMs?: number | null
  /** Raw model text; the excerpt is truncated per capability (2000 or 4000 code points). */
  rawText?: string
}

/** Copy a call's usage facts onto the row, refusing to invent a cost. */
export function withCallTelemetry(record: LlmRunRecord, call: CallTelemetry): LlmRunRecord {
  const costKnown = call.costKnown === true
  return {
    ...record,
    provider: call.provider || record.provider,
    model_identifier: call.model || record.model_identifier,
    prompt_tokens: call.promptTokens ?? null,
    completion_tokens: call.completionTokens ?? null,
    cost_known: costKnown,
    // A price without `cost_known` is a price nobody verified; it is dropped rather than stored.
    cost_cents: costKnown ? (call.costCents ?? null) : null,
    attempts: call.attempts ?? record.attempts,
    latency_ms: call.latencyMs ?? null,
    raw_response_excerpt: pySlice(call.rawText ?? '', AUDIT_EXCERPT_LIMITS[record.capability]),
  }
}

/** Python `status = SUCCEEDED` + raw excerpt + `validation_result` (all seven call sites). */
export function markSucceeded(
  record: LlmRunRecord,
  call: CallTelemetry,
  validationResult: Record<string, unknown>,
): LlmRunRecord {
  return { ...withCallTelemetry(record, call), status: 'succeeded', validation_result: validationResult, error_code: '', error_message: '' }
}

/**
 * Python `status = REJECTED` for invalid JSON or a validator that produced nothing usable. The
 * excerpt/tokens are still recorded: the call did happen and may have cost money.
 */
export function markRejected(
  record: LlmRunRecord,
  call: CallTelemetry,
  validationResult: Record<string, unknown>,
  message: string,
): LlmRunRecord {
  return {
    ...withCallTelemetry(record, call),
    status: 'rejected',
    validation_result: validationResult,
    error_code: 'ai_invalid_output',
    error_message: pySlice(message, 500),
  }
}

/** Python `_record_failure`: error code/message only, and `cost_known=False` when there is no call. */
export function markFailed(record: LlmRunRecord, failure: { code: string; message: string }, call?: CallTelemetry): LlmRunRecord {
  const base = call ? withCallTelemetry(record, call) : record
  return {
    ...base,
    status: statusForFailureCode(failure.code),
    error_code: failure.code,
    error_message: pySlice(failure.message, 500),
    ...(call ? {} : { cost_known: false, cost_cents: null }),
  }
}

/**
 * Failure code → run status.
 *
 * `ai_capability_unsupported` has no Python twin (Django collapses "no provider" and "provider does
 * not declare this capability" into `AiUnavailable.code == ai_not_configured`). It maps to
 * `unavailable`, which is the closest stored meaning and is what the UI labels "AI 未配置/不可用".
 */
export function statusForFailureCode(code: string): LlmRunStatus {
  switch (code) {
    case 'ai_not_configured':
    case 'ai_capability_unsupported':
      return 'unavailable'
    case 'ai_timeout':
      return 'timeout'
    case 'ai_invalid_output':
    case 'ai_empty':
      return 'rejected'
    default:
      return 'failed'
  }
}
