/**
 * The AI capability contract, with no DSH dependency.
 *
 * Split out of `port.ts` so that pure callers (the action layer, the AI layer's degradation tables)
 * can use the types and the capability list without loading the Cordis SDK — and so there is exactly
 * one definition of `CAPABILITIES` instead of one here and another in `ai/degrade.ts`.
 */
export const CAPABILITIES = [
  'extract_question', 'transcribe_handwriting', 'suggest_tags', 'explain',
  'diagnose', 'estimate_grade', 'propose_variant', 'embed',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Capabilities that need image input; a text-only model must never be used for them. */
export const NEEDS_VISION: ReadonlySet<Capability> = new Set(['extract_question', 'transcribe_handwriting'])
/** dsh-llm exposes no embedding endpoint (see docs/dsh-migration/03). Hybrid search must degrade. */
export const UNSUPPORTED_BY_DSH: ReadonlySet<Capability> = new Set(['embed'])

export type FailureCode =
  | 'ai_not_configured' | 'ai_capability_unsupported' | 'ai_timeout' | 'ai_rate_limited'
  | 'ai_quota' | 'ai_auth' | 'ai_error' | 'ai_cancelled' | 'ai_empty'

export interface ModelRoute { provider: string; model: string; reasoningEffort?: string }
export interface Usage { inputTokens?: number; outputTokens?: number }
export interface CapabilityRequest {
  capability: Capability
  promptVersion: string
  system: string
  prompt: string
  /** Optional image data for vision capabilities, as DSH image blocks. */
  images?: readonly { mediaType: string; dataBase64: string }[]
  timeoutMs?: number
  signal?: AbortSignal
}
export type CapabilityResult =
  | { ok: true; text: string; route: ModelRoute; promptVersion: string; capability: Capability; usage?: Usage; latencyMs: number }
  | { ok: false; code: FailureCode; message: string; capability: Capability; promptVersion: string; retryable: boolean }

export const RETRYABLE_FAILURES: ReadonlySet<FailureCode> = new Set(['ai_timeout', 'ai_rate_limited'])

export const failure = (request: CapabilityRequest, code: FailureCode, message: string): CapabilityResult => ({
  ok: false,
  code,
  message,
  capability: request.capability,
  promptVersion: request.promptVersion,
  retryable: RETRYABLE_FAILURES.has(code),
})

/** Map dsh-llm's stable failure codes (route on code, never on message text). */
export function mapFailureCode(code: string | undefined): FailureCode {
  switch (code) {
    case 'NO_ADAPTER': case 'MISSING_CREDENTIAL': case 'INVALID_CREDENTIAL': return 'ai_not_configured'
    case 'AUTH': return 'ai_auth'
    case 'RATE_LIMIT': return 'ai_rate_limited'
    case 'QUOTA': case 'ACCOUNT_QUOTA': return 'ai_quota'
    case 'TIMEOUT': return 'ai_timeout'
    default: return 'ai_error'
  }
}

export interface LlmPort {
  /** What this session can do right now — drives the UI's honest "AI 未配置" state. */
  availability(signal?: AbortSignal): Promise<Record<Capability, { available: boolean; reason?: FailureCode }>>
  run(request: CapabilityRequest): Promise<CapabilityResult>
}
