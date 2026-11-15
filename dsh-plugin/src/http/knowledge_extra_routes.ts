/**
 * Knowledge-domain routes the Web client calls but B3 never mounted.
 *
 * Adapters only: validate the query/body shape the way Ninja binds it, run Django's scope checks in
 * Django's order (before the idempotency claim), call the service, return the service value. The
 * services live in `services/knowledge_extra.ts`, `services/pairing.ts` and
 * `services/tag_suggestions.ts` so the HTTP surface and the acceptance fixture drive the same code.
 *
 * Idempotency scopes are part of the replay contract and are copied verbatim from
 * `apps/knowledge/api.py`:
 *
 *   pairings.create:{project_id}          relations.create:{project_id}
 *   tag_suggestions.create:{version_id}
 *
 * The other writes here are naturally idempotent and carry no key in Django either: a template is a
 * get-or-create per (subject, name), deactivating an edge twice is the same state, and accepting a
 * suggestion is refused once it has been decided.
 */
import type { Route, RouteContext } from './router.ts'
import { IdempotencyConflict as StoreIdempotencyConflict, claim, recordResult, release } from '../store/idempotency.ts'
import { transaction } from '../store/db.ts'
import { AiNotConfigured, DependencyUnavailable, IdempotencyConflictError, InvalidInput } from '../services/errors.ts'
import {
  createPairing,
  createRelation,
  createTemplate,
  deactivateRelation,
  getPairingDetail,
  knowledgeMap,
  listPairings,
  listRelations,
  listTemplates,
  nodePrerequisites,
} from '../services/knowledge_extra.ts'
import type { LlmPort } from '../llm/contract.ts'
import {
  TagSuggestionProviderFailure,
  acceptSuggestion,
  listTagSuggestions,
  proposeTags,
  rejectSuggestion,
  requireVersion,
  suggestionOut,
} from '../services/tag_suggestions.ts'

const PREFIX = '/api/acepass'

/** The LLM port is injected by the entry point; absent means "no model configured", not "no AI". */
export interface KnowledgeExtraRouteDeps {
  llm?: () => LlmPort
}

interface SchemaIssue {
  type: string
  loc: Array<string | number>
  msg: string
}

// ---------------------------------------------------------------- query args

function optional(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  return value
}

// -------------------------------------------------------------- body binding

/** Ninja binds the whole body before the handler runs, so the order `missing → type` is its order. */
class Body {
  private readonly map: Record<string, unknown>

  constructor(body: unknown) {
    this.map = isRecord(body) ? body : {}
  }

  private has(name: string): boolean {
    return Object.hasOwn(this.map, name)
  }

  private issue(issue: SchemaIssue): never {
    throw schemaError([issue])
  }

  requiredString(name: string): string {
    const value = this.map[name]
    if (value === undefined || value === null) this.issue(missing(['body', 'payload', name]))
    if (typeof value !== 'string') this.issue(stringType(['body', 'payload', name]))
    return value as string
  }

  optionalString(name: string, fallback: string | null = null): string | null {
    const value = this.map[name]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'string') this.issue(stringType(['body', 'payload', name]))
    return value as string
  }

  optionalInt(name: string, fallback: number): number {
    const value = this.map[name]
    if (value === undefined || value === null) return fallback
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed)
      this.issue(intParsing(['body', 'payload', name]))
    }
    this.issue(intType(['body', 'payload', name]))
    return fallback
  }

  optionalStringList(name: string, fallback: string[] | null = null): string[] | null {
    const value = this.map[name]
    if (!this.has(name) || value === undefined || value === null) return fallback
    if (!Array.isArray(value)) this.issue(listType(['body', 'payload', name]))
    return value.map((item, index) => {
      if (typeof item !== 'string') this.issue(stringType(['body', 'payload', name, index]))
      return item as string
    })
  }

  /** The wire body as Django's `model_dump(mode="json")` would normalise it, plus the given defaults. */
  normalised(names: readonly string[], defaults: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const name of names) {
      const value = this.map[name]
      out[name] = value === undefined ? (defaults[name] ?? null) : value
    }
    return out
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaError(issues: SchemaIssue[]): InvalidInput {
  return new InvalidInput('请求参数校验失败', { details: { errors: issues } })
}

function missing(loc: Array<string | number>): SchemaIssue {
  return { type: 'missing', loc, msg: 'Field required' }
}

function stringType(loc: Array<string | number>): SchemaIssue {
  return { type: 'string_type', loc, msg: 'Input should be a valid string' }
}

function intParsing(loc: Array<string | number>): SchemaIssue {
  return { type: 'int_parsing', loc, msg: 'Input should be a valid integer, unable to parse string as an integer' }
}

function intType(loc: Array<string | number>): SchemaIssue {
  return { type: 'int_type', loc, msg: 'Input should be a valid integer' }
}

function listType(loc: Array<string | number>): SchemaIssue {
  return { type: 'list_type', loc, msg: 'Input should be a valid list' }
}

/** The Django idempotency key contract: trimmed, non-empty, at most 200 characters. */
function idempotencyKey(ctx: RouteContext): string {
  const key = (ctx.headers.get('idempotency-key') ?? '').trim()
  if (key === '') throw new IdempotencyConflictError('缺少 Idempotency-Key 请求头')
  if ([...key].length > 200) throw new IdempotencyConflictError('Idempotency-Key 过长')
  return key
}

function storeConflict(error: unknown): never {
  if (error instanceof StoreIdempotencyConflict) {
    throw new IdempotencyConflictError(
      error.reason === 'in_flight' ? '相同幂等键的请求正在处理中，请稍后重试' : '相同幂等键使用了不同请求内容',
      { details: { route_scope: error.routeScope, reason: error.reason } },
    )
  }
  throw error
}

/**
 * Claim → effect → record, in one transaction.
 *
 * The claim and the business write commit together, so a rejected request (a cycle, a 404, a missing
 * model) releases the key and can be retried — the Node equivalent of Django's middleware deleting
 * an unfulfilled claim on a 4xx/5xx response.
 */
function idempotentEffect(
  ctx: RouteContext,
  options: {
    scope: string
    payload: unknown
    status: number
    effect: () => { body: unknown }
  },
): { status: number; body: unknown } {
  const key = idempotencyKey(ctx)
  return transaction(ctx.db, () => {
    let replay: ReturnType<typeof claim>
    try {
      replay = claim(ctx.db, {
        userId: ctx.userId,
        routeScope: options.scope,
        key,
        payload: options.payload,
        now: ctx.now,
      })
    } catch (error) {
      storeConflict(error)
    }
    if (replay !== null) return { status: replay.statusCode, body: replay.body }
    const result = options.effect()
    recordResult(ctx.db, {
      userId: ctx.userId,
      routeScope: options.scope,
      key,
      statusCode: options.status,
      responseBody: result.body,
      now: ctx.now,
    })
    return { status: options.status, body: result.body }
  })
}

/** No host port at all is `ai_not_configured`, never a fake success. */
function unconfiguredPort(): LlmPort {
  return {
    async availability() {
      return {
        extract_question: { available: false, reason: 'ai_not_configured' },
        transcribe_handwriting: { available: false, reason: 'ai_not_configured' },
        suggest_tags: { available: false, reason: 'ai_not_configured' },
        explain: { available: false, reason: 'ai_not_configured' },
        diagnose: { available: false, reason: 'ai_not_configured' },
        estimate_grade: { available: false, reason: 'ai_not_configured' },
        propose_variant: { available: false, reason: 'ai_not_configured' },
        embed: { available: false, reason: 'ai_capability_unsupported' },
      }
    },
    async run(request) {
      return {
        ok: false,
        code: 'ai_not_configured',
        message: 'AI 未配置',
        capability: request.capability,
        promptVersion: request.promptVersion,
        retryable: false,
      }
    },
  }
}

// ------------------------------------------------------------------- routes

/**
 * The tag-suggestion POST, with the async resource shape: the claim commits before the model call,
 * the result is recorded afterwards, and a failed request releases the claim so the same key can be
 * retried. The provider failure is mapped by *code*, never by message.
 */
async function createTagSuggestionRoute(
  ctx: RouteContext,
  deps: KnowledgeExtraRouteDeps,
): Promise<{ status: number; body: unknown }> {
  const version = requireVersion(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.version_id)
  const scope = `tag_suggestions.create:${ctx.params.version_id}`
  const key = idempotencyKey(ctx)
  const payload = { version_id: ctx.params.version_id }
  let replay: ReturnType<typeof claim>
  try {
    replay = transaction(ctx.db, () =>
      claim(ctx.db, { userId: ctx.userId, routeScope: scope, key, payload, now: ctx.now }),
    )
  } catch (error) {
    storeConflict(error)
  }
  if (replay !== null) return { status: replay.statusCode, body: replay.body }

  const port = deps.llm === undefined ? unconfiguredPort() : deps.llm()
  try {
    const suggestion = await proposeTags(
      ctx.db,
      {
        projectId: ctx.params.project_id,
        version,
        actorId: ctx.userId,
        port,
      },
      ctx.now,
    )
    const body = suggestionOut(ctx.db, suggestion)
    transaction(ctx.db, () =>
      recordResult(ctx.db, {
        userId: ctx.userId,
        routeScope: scope,
        key,
        statusCode: 201,
        responseBody: body,
        resourceType: 'tag_suggestion',
        resourceId: String(suggestion.id),
        now: ctx.now,
      }),
    )
    return { status: 201, body }
  } catch (error) {
    // The unfulfilled claim is released so the same key is retryable; the audit run row stays
    // (失败留候选, 06 §6.2 — "we tried" is a fact worth keeping).
    transaction(ctx.db, () => release(ctx.db, ctx.userId, scope, key))
    if (error instanceof TagSuggestionProviderFailure) {
      if (error.unavailable) {
        throw new AiNotConfigured(`未配置可用的文本模型，无法生成标签建议`, {
          details: { error_code: error.failureCode },
        })
      }
      throw new DependencyUnavailable(`模型调用失败：${error.failureCode}`, {
        details: { ai_error: error.failureCode },
      })
    }
    throw error
  }
}

export function knowledgeExtraRoutes(deps: KnowledgeExtraRouteDeps = {}): Route[] {
  return [
    // ---- question templates -------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/question-templates`,
      handler: (ctx) =>
        listTemplates(ctx.db, ctx.userId, ctx.params.project_id, {
          subjectId: optional(ctx.query.get('subject_id')),
        }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-templates`,
      handler: (ctx) => {
        const payload = new Body(ctx.body)
        // Ninja binds the schema first: a missing field is a 400 even for an unknown project.
        const body = {
          subject_id: payload.requiredString('subject_id'),
          name: payload.requiredString('name'),
          description: payload.optionalString('description', '') ?? '',
        }
        return {
          status: 201,
          body: createTemplate(ctx.db, ctx.userId, ctx.params.project_id, body, ctx.now),
        }
      },
    },
    // ---- verification pairings ---------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/verification-pairings`,
      handler: (ctx) =>
        listPairings(ctx.db, ctx.userId, ctx.params.project_id, {
          subjectId: optional(ctx.query.get('subject_id')),
          nodeId: optional(ctx.query.get('node_id')),
        }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/verification-pairings`,
      handler: (ctx) => {
        const payload = new Body(ctx.body)
        const body = {
          subject_id: payload.requiredString('subject_id'),
          node_id: payload.requiredString('node_id'),
          immediate_question_id: payload.requiredString('immediate_question_id'),
          delayed_question_id: payload.optionalString('delayed_question_id'),
          baseline_question_id: payload.optionalString('baseline_question_id'),
          delay_hours: payload.optionalInt('delay_hours', 24),
          note: payload.optionalString('note', '') ?? '',
        }
        return idempotentEffect(ctx, {
          scope: `pairings.create:${ctx.params.project_id}`,
          // Django fingerprints `payload.model_dump(mode="json")`: defaults applied, keys in
          // schema order, so two semantically equal bodies replay as one request.
          payload: payload.normalised(
            ['subject_id', 'node_id', 'immediate_question_id', 'delayed_question_id', 'baseline_question_id', 'delay_hours', 'note'],
            { delayed_question_id: null, baseline_question_id: null, delay_hours: 24, note: '' },
          ),
          status: 201,
          effect: () => ({ body: createPairing(ctx.db, ctx.userId, ctx.params.project_id, body, ctx.now) }),
        })
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/verification-pairings/:pairing_id`,
      handler: (ctx) =>
        getPairingDetail(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.pairing_id),
    },
    // ---- knowledge map -----------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/knowledge-map`,
      handler: (ctx) => {
        const subjectId = ctx.query.get('subject_id')
        // `knowledge_map(request, project_id, subject_id: str, ...)` — a required query parameter.
        if (subjectId === null || subjectId.trim() === '') {
          throw schemaError([missing(['query', 'subject_id'])])
        }
        return knowledgeMap(ctx.db, ctx.userId, ctx.params.project_id, {
          subjectId,
          syllabusVersionId: optional(ctx.query.get('syllabus_version_id')),
        })
      },
    },
    // ---- prerequisite graph ------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/knowledge-relations`,
      handler: (ctx) =>
        listRelations(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          {
            subjectId: optional(ctx.query.get('subject_id')),
            syllabusVersionId: optional(ctx.query.get('syllabus_version_id')),
          },
          ctx.now,
        ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/knowledge-relations`,
      handler: (ctx) => {
        const payload = new Body(ctx.body)
        const body = {
          syllabus_version_id: payload.requiredString('syllabus_version_id'),
          from_node_id: payload.requiredString('from_node_id'),
          to_node_id: payload.requiredString('to_node_id'),
          relation_type: payload.optionalString('relation_type', 'prerequisite') ?? 'prerequisite',
          note: payload.optionalString('note', '') ?? '',
        }
        return idempotentEffect(ctx, {
          scope: `relations.create:${ctx.params.project_id}`,
          payload: payload.normalised(
            ['syllabus_version_id', 'from_node_id', 'to_node_id', 'relation_type', 'note'],
            { relation_type: 'prerequisite', note: '' },
          ),
          status: 201,
          effect: () => ({ body: createRelation(ctx.db, ctx.userId, ctx.params.project_id, body, ctx.now) }),
        })
      },
    },
    {
      method: 'DELETE',
      pattern: `${PREFIX}/projects/:project_id/knowledge-relations/:relation_id`,
      handler: (ctx) =>
        deactivateRelation(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.relation_id,
          ctx.query.get('reason') ?? '',
          ctx.now,
        ),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/knowledge-nodes/:node_id/prerequisites`,
      handler: (ctx) =>
        nodePrerequisites(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.node_id),
    },
    // ---- tag suggestions ---------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/question-versions/:version_id/tag-suggestions`,
      handler: (ctx) =>
        listTagSuggestions(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.version_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-versions/:version_id/tag-suggestions`,
      handler: (ctx) => createTagSuggestionRoute(ctx, deps),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/tag-suggestions/:suggestion_id/accept`,
      handler: (ctx) => {
        const payload = new Body(ctx.body)
        const body = {
          node_names: payload.optionalStringList('node_names'),
          note: payload.optionalString('note', '') ?? '',
        }
        return acceptSuggestion(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.suggestion_id,
          body,
          ctx.now,
        )
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/tag-suggestions/:suggestion_id/reject`,
      handler: (ctx) => {
        const payload = new Body(ctx.body)
        const body = { note: payload.optionalString('note', '') ?? '' }
        return rejectSuggestion(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.suggestion_id,
          body,
          ctx.now,
        )
      },
    },
  ]
}
