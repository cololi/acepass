/**
 * Typed business errors and the wire-stable error envelope.
 *
 * Port of `backend/apps/common/errors.py`. The envelope is part of the contract the web client
 * already depends on:
 *
 *     {"error": {"code": "...", "message": "...", "details": {}, "request_id": "..."}}
 *
 * Codes map onto the documented HTTP statuses, so a client that only reads `error.code` keeps
 * working after the migration.
 */

export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    details: Record<string, unknown>
    request_id?: string
  }
}

export class AcePassError extends Error {
  code = 'internal_error'
  statusCode = 500
  details: Record<string, unknown>

  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '服务器内部错误')
    this.name = new.target.name
    this.details = options.details ?? {}
  }
}

export class InvalidInput extends AcePassError {
  code = 'invalid_input'
  statusCode = 400
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '请求参数无效', options)
  }
}

/**
 * The object exists but is not reachable through the requested scope.
 *
 * Deliberately 404 so an outsider cannot probe for existence.
 */
export class ScopeViolation extends AcePassError {
  code = 'not_found'
  statusCode = 404
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '对象不存在或不在当前权限范围', options)
  }
}

/** Known object, but the current session mode forbids this use. */
export class PurposeNotAllowed extends AcePassError {
  code = 'purpose_not_allowed'
  statusCode = 403
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '当前会话用途不允许该操作', options)
  }
}

export class VersionConflict extends AcePassError {
  code = 'version_conflict'
  statusCode = 409
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '版本已过期，请重新加载', options)
  }
}

/** Same idempotency key, different request content. */
export class IdempotencyConflictError extends AcePassError {
  code = 'idempotency_conflict'
  statusCode = 409
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '相同幂等键使用了不同请求内容', options)
  }
}

export class AlreadySubmitted extends AcePassError {
  code = 'already_submitted'
  statusCode = 409
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '该题项已提交，请新建题项重做', options)
  }
}

export class StructureInvalid extends AcePassError {
  code = 'structure_invalid'
  statusCode = 422
}

/**
 * A host capability the port needs is not present (B3: the image codec).
 *
 * Django has no equivalent — Pillow is a hard dependency of its requirements — so this is an
 * adaptation, and it exists to avoid the worst possible failure: without it, a missing `sharp`
 * would surface as "your image is corrupt", which blames the user's file for a packaging problem.
 */
export class DependencyUnavailable extends AcePassError {
  code = 'dependency_unavailable'
  statusCode = 503
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '依赖能力不可用', options)
  }
}

export class RateLimited extends AcePassError {
  code = 'rate_limited'
  statusCode = 429
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '请求过于频繁，请稍后再试', options)
  }
}

/**
 * No configured provider can perform the requested capability (`apps/common/errors.py`).
 *
 * Still a 503, not a 500: the product keeps working without AI (manual entry), and the client has
 * to be able to tell "configure a provider" apart from a bug.
 */
export class AiNotConfigured extends AcePassError {
  code = 'ai_not_configured'
  statusCode = 503
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? 'AI 能力未配置', options)
  }
}

export class AuthenticationRequired extends AcePassError {
  code = 'unauthenticated'
  statusCode = 401
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '需要登录', options)
  }
}

/** Turn any thrown value into the envelope, keeping unknown failures opaque. */
export function toErrorEnvelope(error: unknown, requestId?: string): { status: number; body: ErrorEnvelope } {
  if (error instanceof AcePassError) {
    return {
      status: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          ...(requestId === undefined ? {} : { request_id: requestId }),
        },
      },
    }
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: '服务器内部错误',
        details: {},
        ...(requestId === undefined ? {} : { request_id: requestId }),
      },
    },
  }
}
