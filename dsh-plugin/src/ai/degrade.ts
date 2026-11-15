/**
 * Honest degradation, ported from `backend/ai/providers/base.py` (`provider_status`, `NullProvider`)
 * and adapted to the DSH port's failure codes.
 *
 * The rule is the same one `docs/02 §6` states: without a model the product keeps working (manual
 * import, deterministic grading, manual scoring, manual transcription, review, plans, reports), and
 * the AI surface says "AI 未配置" instead of producing content. Here that is expressed as data: a
 * capability table computed from what the host actually has, plus the failure code a caller must use.
 *
 * Python collapses "no provider" and "provider does not declare this capability" into one
 * `AiUnavailable.code == ai_not_configured`. This port keeps them distinct
 * (`ai_not_configured` vs `ai_capability_unsupported`) because the caller's next step differs:
 * configure a provider, or use a model that supports the modality. The capability *table* is still
 * pinned to the real Django `provider_status()` output (see tests/golden/ai_runtime.json).
 */
import { PROMPT_VERSIONS } from './prompts.ts'

/** `CAPABILITIES` from the provider contract; `embed` is included even though DSH cannot run it. */
export const CAPABILITIES = [
  'extract_question',
  'transcribe_handwriting',
  'suggest_tags',
  'explain',
  'diagnose',
  'estimate_grade',
  'propose_variant',
  'embed',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** The prompt-backed subset (everything except the embedding endpoint). */
export const PROMPT_CAPABILITIES = Object.keys(PROMPT_VERSIONS) as (keyof typeof PROMPT_VERSIONS)[]

/** P0 only wires extract/explain; the rest stay registered but may be unavailable. */
export const P0_CAPABILITIES = ['extract_question', 'explain'] as const

/** Capabilities that need image input. A text-only model must never be asked to read a photo. */
export const VISION_CAPABILITIES: ReadonlySet<Capability> = new Set(['extract_question', 'transcribe_handwriting'])

/** dsh-llm exposes no embedding endpoint, so vector search can only degrade to keyword search. */
export const UNSUPPORTED_BY_DSH: ReadonlySet<Capability> = new Set(['embed'])

export type FailureCode =
  | 'ai_not_configured'
  | 'ai_capability_unsupported'
  | 'ai_timeout'
  | 'ai_rate_limited'
  | 'ai_quota'
  | 'ai_auth'
  | 'ai_error'
  | 'ai_cancelled'
  | 'ai_empty'

/** Only these are worth retrying; everything else is a configuration/content decision. */
export const RETRYABLE_FAILURES: ReadonlySet<FailureCode> = new Set(['ai_timeout', 'ai_rate_limited'])

export interface CapabilityState {
  available: boolean
  reason?: FailureCode
}

/** What the host currently offers. `hasModel` covers "a route is configured"; `vision` is per-model. */
export interface HostCapabilityFacts {
  hasModel: boolean
  vision: boolean
}

export type CapabilityTable = Record<Capability, CapabilityState>

/**
 * The availability table the UI shows. Never optimistically true: an unknown modality is treated as
 * "no vision", because guessing upwards would send a photo to a text-only model.
 */
export function capabilityAvailability(host: HostCapabilityFacts): CapabilityTable {
  const table = {} as CapabilityTable
  for (const capability of CAPABILITIES) {
    if (UNSUPPORTED_BY_DSH.has(capability)) {
      table[capability] = { available: false, reason: 'ai_capability_unsupported' }
    } else if (!host.hasModel) {
      table[capability] = { available: false, reason: 'ai_not_configured' }
    } else if (VISION_CAPABILITIES.has(capability) && !host.vision) {
      table[capability] = { available: false, reason: 'ai_capability_unsupported' }
    } else {
      table[capability] = { available: true }
    }
  }
  return table
}

/** The failure a call must return before it ever reaches the model, or `null` when it may run. */
export function preflightFailure(host: HostCapabilityFacts, capability: Capability): { code: FailureCode; message: string } | null {
  const state = capabilityAvailability(host)[capability]
  if (state.available) return null
  const code = state.reason ?? 'ai_not_configured'
  return { code, message: reasonMessage(code, capability) }
}

export function reasonMessage(code: FailureCode, capability: Capability): string {
  if (code === 'ai_capability_unsupported') {
    if (UNSUPPORTED_BY_DSH.has(capability)) return 'DSH 不提供 embedding 端点：向量检索必须降级为关键词检索'
    return '当前模型不支持图片输入：无法执行图片识别或手写转写'
  }
  return UNCONFIGURED_MESSAGE
}

export interface AiFailure {
  ok: false
  code: FailureCode
  message: string
  retryable: boolean
}

export function failure(code: FailureCode, message: string): AiFailure {
  return { ok: false, code, message, retryable: RETRYABLE_FAILURES.has(code) }
}

/* The two provider_status() messages for the states this package can actually be in. */
export const UNCONFIGURED_MESSAGE =
  'AI 未配置：可正常使用手动录题、作答、判分与复习；图片识别和按需讲解需配置 provider。'
export const CONFIGURED_MESSAGE = '已配置真实 provider；模型输出仍需人工核对后才能进入正式内容。'

/** `provider_status()["message"]`, with `is_stub` pinned to false (this package has no stub). */
export function availabilityMessage(configured: boolean): string {
  return configured ? CONFIGURED_MESSAGE : UNCONFIGURED_MESSAGE
}
