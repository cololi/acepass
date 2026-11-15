/**
 * DSH adapter for the AI capability contract (replaces backend/ai/providers).
 *
 * Contract carried over from docs/02 §6 and invariants R-INV-04/09:
 *  - no model available  -> `{ ok: false, code: 'ai_not_configured' }`, never a fabricated answer;
 *  - there is NO stub provider in this package: a stub must not be able to pass for a real model;
 *  - the caller receives text + audit facts and must validate/parse it; this port never writes
 *    scores, mastery state, plans or statistics.
 *
 * The types and the capability list live in `contract.ts` so pure callers do not pull in the SDK.
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { finishFailure } from './finish.ts'
import {
  CAPABILITIES,
  NEEDS_VISION,
  UNSUPPORTED_BY_DSH,
  failure,
  mapFailureCode,
  type Capability,
  type CapabilityRequest,
  type CapabilityResult,
  type FailureCode,
  type LlmPort,
  type ModelRoute,
} from './contract.ts'

export {
  CAPABILITIES,
  NEEDS_VISION,
  UNSUPPORTED_BY_DSH,
  mapFailureCode,
  type Capability,
  type CapabilityRequest,
  type CapabilityResult,
  type FailureCode,
  type LlmPort,
  type ModelRoute,
  type Usage,
} from './contract.ts'

const fail = failure

interface LlmService {
  stream(options: Record<string, unknown>): AsyncIterable<{ type: string; text?: string } & Record<string, unknown>>
  resolveCallConfig(config: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] } | undefined>
}

export function createLlmPort(deps: { llm: LlmService | undefined; route: () => ModelRoute | undefined; sessionId?: string }): LlmPort {
  const supportsVision = async (route: ModelRoute, signal?: AbortSignal): Promise<boolean> => {
    // Absence of modality info means "unknown": treat as not vision-capable (R-INV-09, never guess up).
    const info = await deps.llm?.resolveModelInfo?.(route.provider, route.model, signal).catch(() => undefined)
    return Boolean(info?.inputModalities?.includes('image'))
  }

  return {
    async availability(signal) {
      const route = deps.route()
      const vision = route && deps.llm ? await supportsVision(route, signal) : false
      const entries = CAPABILITIES.map((cap) => {
        if (UNSUPPORTED_BY_DSH.has(cap)) return [cap, { available: false, reason: 'ai_capability_unsupported' as FailureCode }] as const
        if (!deps.llm || !route) return [cap, { available: false, reason: 'ai_not_configured' as FailureCode }] as const
        if (NEEDS_VISION.has(cap) && !vision) return [cap, { available: false, reason: 'ai_capability_unsupported' as FailureCode }] as const
        return [cap, { available: true }] as const
      })
      return Object.fromEntries(entries) as Record<Capability, { available: boolean; reason?: FailureCode }>
    },

    async run(request) {
      const route = deps.route()
      if (UNSUPPORTED_BY_DSH.has(request.capability)) return fail(request, 'ai_capability_unsupported', 'DSH exposes no embedding endpoint')
      if (!deps.llm || !route) return fail(request, 'ai_not_configured', 'AI 未配置')
      const timeout = AbortSignal.timeout(request.timeoutMs ?? 120_000)
      const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout
      const started = performance.now()
      if (NEEDS_VISION.has(request.capability) && !(await supportsVision(route, signal)))
        return fail(request, 'ai_capability_unsupported', '当前模型不支持图片输入')
      try {
        const call = await deps.llm.resolveCallConfig({ provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }, signal)
        const content: unknown[] = [{ type: 'text', text: request.prompt }]
        for (const image of request.images ?? []) content.push({ type: 'image', mediaType: image.mediaType, data: image.dataBase64 })
        const assembler = new BlockAssembler()
        for await (const chunk of deps.llm.stream({
          ...call, system: request.system, messages: [createUserMessage({ content })], sessionId: deps.sessionId, signal,
        })) assembler.push(chunk as never)
        const finish = assembler.finish as { kind?: string; failure?: { code?: string; message?: string } } | undefined
        const finishError = finishFailure(finish, { signalAborted: signal.aborted, timedOut: timeout.aborted })
        if (finishError !== null) return fail(request, finishError.code, finishError.message)
        const text = (assembler.blocks() as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (!text.trim()) return fail(request, 'ai_empty', '模型没有返回文本')
        const usage = assembler.usage as { inputTokens?: number; outputTokens?: number } | undefined
        return { ok: true, text, route, promptVersion: request.promptVersion, capability: request.capability, ...(usage ? { usage } : {}), latencyMs: Math.round(performance.now() - started) }
      } catch (error) {
        const code = (error as { code?: string })?.code
        return fail(request, mapFailureCode(code), error instanceof Error ? error.message : String(error))
      }
    },
  }
}
