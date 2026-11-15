/**
 * How a streaming finish translates into a failure — pure, so it can be tested without the SDK.
 *
 * The rule that matters: `aborted` and `error` are **never** a successful result. A model that was
 * cancelled or whose stream failed produced no usable answer, and treating the accumulated partial
 * text as success would put unvalidated content in front of a reviewer.
 */
import { mapFailureCode, type FailureCode } from './contract.ts'

export interface StreamFinish {
  kind?: string
  failure?: { code?: string; message?: string }
}

export interface FinishOptions {
  signalAborted: boolean
  timedOut: boolean
}

export interface FinishFailure {
  code: FailureCode
  message: string
}

export function finishFailure(finish: StreamFinish | undefined, options: FinishOptions): FinishFailure | null {
  if (finish?.kind === 'aborted' || options.signalAborted) {
    return options.timedOut
      ? { code: 'ai_timeout', message: '模型调用超时' }
      : { code: 'ai_cancelled', message: '已取消' }
  }
  if (finish?.kind === 'error') {
    return {
      code: mapFailureCode(finish.failure?.code),
      message: finish.failure?.message ?? 'model error',
    }
  }
  return null
}
