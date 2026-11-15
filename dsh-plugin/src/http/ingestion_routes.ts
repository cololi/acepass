/**
 * Ingestion HTTP surface — port of `backend/apps/ingestion/api.py`.
 *
 * B0 registers the O06 preview; B1 adds O03/O04/O07/O10–O17; B2 adds O18; B3 adds O01/O02/O05/O08
 * (assets, multipart, images); B4 adds O09 (PDF). O19/O20 (variants) arrive with B5. The request
 * dictionaries and idempotency scopes are fixed in `docs/dsh-migration/06-ingestion-port-spec.md`
 * §2 and must not be invented here.
 *
 * Three transport details are specific to ingestion and are handled in this file rather than in the
 * shared router:
 *
 * - **Request validation runs before the handler**, exactly like Ninja: a request with a malformed
 *   body *and* a foreign project is a 400, not a 404. Every handler therefore validates the body
 *   and the declared query params first, then resolves the project.
 * - **Idempotency keys follow `apps/common/api.py`**: the header is trimmed, an empty key is a 409
 *   `idempotency_conflict` (not a 400), a key longer than 200 code points is a 409, and the conflict
 *   envelope carries `details={route_scope, reason}`. The generic `resource()` helper in
 *   `routes.ts` predates that rule and stays untouched for the routes already built on it.
 * - **Schema errors keep Ninja's shape**: 400 `invalid_input` + `请求参数校验失败` +
 *   `details.errors=[{type,loc,msg}]`, with `loc` starting at `body` (or `query`).
 *
 * Like every other project-scoped route these are registered in-process with `:param` segments, so
 * `src/index.ts` does not mount them on DSH's exact-path Fetch registry yet (spec §0.1). Only
 * in-process Request→Response reachability is claimed.
 */
import type { DatabaseSync } from 'node:sqlite'

import { parsePaste } from '../domain/ingestion/text_parser.ts'
import { pyCodePointLen, pyCodePointSlice, pyStrip } from '../domain/ingestion/pystring.ts'
import { claim, recordResult, release, IdempotencyConflict as StoreIdempotencyConflict } from '../store/idempotency.ts'
import { transaction } from '../store/db.ts'
import { findOne, findRows, getRow, type Row } from '../store/repository.ts'
import { requireProject, requireSubject, SOURCE_KINDS } from '../services/exams.ts'
import {
  AiNotConfigured,
  DependencyUnavailable,
  IdempotencyConflictError,
  InvalidInput,
  ScopeViolation,
} from '../services/errors.ts'
import {
  addJobProblem,
  candidateSummary,
  confirmLayoutReview,
  createTextDocument,
  fileChecksum,
  ignoreCandidate,
  jobSummary,
  requireCandidate,
  requireJob,
  updateCandidate,
} from '../services/ingestion.ts'
import {
  preparePdfUploads,
  retryJob,
  startImageImport,
  startPdfImportPrepared,
  startTextImport,
  type PdfUpload,
} from '../services/ingestion_imports.ts'
import { publishCandidate } from '../services/ingestion_publish.ts'
import {
  assertAssetDownloadAllowed,
  assetScope,
  recordCandidateEditorialPreview,
  recordDownloadExposure,
  sessionItemScope,
} from '../services/ingestion_access.ts'
import {
  ASSET_ROLES,
  assertAssetFields,
  createImageDocument,
  findDuplicateDocument,
  prepareAssetImage,
  storeAsset,
  type PreparedImage,
} from '../services/ingestion_sources.ts'
import { getStorage } from '../ingestion/storage.ts'
import { proposeVariants, VariantProviderFailure, variantJobs, VARIANT_UNCONFIGURED_REASON } from '../services/variants.ts'
import type { LlmPort } from '../llm/contract.ts'
import type { Route, RouteContext, UploadedFile } from './router.ts'

const PREFIX = '/api/acepass'

/** Injected in production (`index.ts`) and in tests: the AI port is a host capability, not a route. */
export interface IngestionRouteDeps {
  llm?: () => LlmPort
}

/** One pydantic-style error entry, as Ninja serializes it (`input` is removed before the wire). */
interface SchemaError {
  type: string
  loc: Array<string | number>
  msg: string
}

function schemaError(errors: SchemaError[]): InvalidInput {
  return new InvalidInput('请求参数校验失败', { details: { errors } })
}

function missing(loc: Array<string | number>): SchemaError {
  return { type: 'missing', loc, msg: 'Field required' }
}

function stringType(loc: Array<string | number>): SchemaError {
  return { type: 'string_type', loc, msg: 'Input should be a valid string' }
}

function boolType(loc: Array<string | number>): SchemaError {
  return { type: 'bool_type', loc, msg: 'Input should be a valid boolean' }
}

function boolParsing(loc: Array<string | number>): SchemaError {
  return { type: 'bool_parsing', loc, msg: 'Input should be a valid boolean, unable to interpret input' }
}

function dictType(loc: Array<string | number>): SchemaError {
  return { type: 'dict_type', loc, msg: 'Input should be a valid dictionary' }
}

function listType(loc: Array<string | number>): SchemaError {
  return { type: 'list_type', loc, msg: 'Input should be a valid list' }
}

function intParsing(loc: Array<string | number>): SchemaError {
  return { type: 'int_parsing', loc, msg: 'Input should be a valid integer, unable to parse string as an integer' }
}

function intType(loc: Array<string | number>): SchemaError {
  return { type: 'int_type', loc, msg: 'Input should be a valid integer' }
}

function intFromFloat(loc: Array<string | number>): SchemaError {
  return {
    type: 'int_from_float',
    loc,
    msg: 'Input should be a valid integer, got a number with a fractional part',
  }
}

/**
 * A required Ninja body model.
 *
 * The observed Django behaviour (probe cases S01/S02 and the body-level probe):
 * - no body at all → `missing` at `["body","payload"]` (the model itself is required);
 * - an array/scalar body is coerced to an empty object by Ninja's body handling, so a model with
 *   required fields reports those fields as missing and a model with only defaults succeeds;
 * - field errors carry the parameter name: `["body","payload","<field>"]`, not `["body","<field>"]`.
 * The last point is why this file does not reuse the B0 validator's older loc shape.
 */
function objectBody(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) throw schemaError([missing(['body', 'payload'])])
  if (typeof body !== 'object' || Array.isArray(body)) return {}
  return body as Record<string, unknown>
}

/**
 * Pydantic v2 lax-mode boolean coercion.
 *
 * Observed: `true`/`false`, 0/1 and 0.0/1.0, and the words
 * true/false/yes/no/on/off/1/0/y/n/t/f (case-insensitive) are accepted. Other numbers, arrays and
 * objects are `bool_type`; an unrecognised string is `bool_parsing`.
 */
function coerceBool(value: unknown): { value: boolean } | { error: 'bool_type' | 'bool_parsing' } {
  if (typeof value === 'boolean') return { value }
  if (typeof value === 'number') {
    if (value === 0) return { value: false }
    if (value === 1) return { value: true }
    return { error: 'bool_type' }
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === 'yes' || text === 'on' || text === '1' || text === 'y' || text === 't') {
      return { value: true }
    }
    if (text === 'false' || text === 'no' || text === 'off' || text === '0' || text === 'n' || text === 'f') {
      return { value: false }
    }
    return { error: 'bool_parsing' }
  }
  return { error: 'bool_type' }
}

/** Pydantic v2 lax-mode int coercion, including the two distinct failure types. */
function coerceInt(value: unknown, loc: Array<string | number>): { value: number } | { error: SchemaError } {
  if (typeof value === 'boolean') return { value: value ? 1 : 0 }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { error: intParsing(loc) }
    if (!Number.isInteger(value)) return { error: intFromFloat(loc) }
    return { value }
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^[+-]?\d+$/.test(text)) return { value: Number(text) }
    return { error: intParsing(loc) }
  }
  // Arrays/objects: pydantic says `int_type`, not `int_parsing` (that one is for strings).
  return { error: intType(loc) }
}

interface TextImportBody {
  text: string
  subject_id: string | null
  title: string
  source_note: string
  usage_scope: string
  parse: boolean
}

/** `TextImportIn` (`backend/apps/ingestion/api.py:51`). Defaults are applied before the service. */
function textImportBody(body: unknown): TextImportBody {
  const record = objectBody(body)
  const errors: SchemaError[] = []
  let text: string | undefined
  if (!Object.hasOwn(record, 'text')) errors.push(missing(['body', 'payload', 'text']))
  else if (typeof record['text'] !== 'string') errors.push(stringType(['body', 'payload', 'text']))
  else text = record['text']

  let subjectId: string | null = null
  if (Object.hasOwn(record, 'subject_id') && record['subject_id'] !== null) {
    if (typeof record['subject_id'] !== 'string') errors.push(stringType(['body', 'payload', 'subject_id']))
    else subjectId = record['subject_id']
  }

  const stringDefaults: Array<['title' | 'source_note' | 'usage_scope', string]> = [
    ['title', ''],
    ['source_note', ''],
    ['usage_scope', ''],
  ]
  const strings: Record<string, string> = {}
  for (const [name, fallback] of stringDefaults) {
    if (!Object.hasOwn(record, name)) strings[name] = fallback
    else if (typeof record[name] !== 'string') errors.push(stringType(['body', 'payload', name]))
    else strings[name] = record[name]
  }

  let parse = true
  if (Object.hasOwn(record, 'parse')) {
    const coerced = coerceBool(record['parse'])
    if ('error' in coerced) {
      errors.push(
        coerced.error === 'bool_type'
          ? boolType(['body', 'payload', 'parse'])
          : boolParsing(['body', 'payload', 'parse']),
      )
    } else {
      parse = coerced.value
    }
  }
  if (errors.length > 0) throw schemaError(errors)
  return {
    text: text!,
    subject_id: subjectId,
    title: strings['title']!,
    source_note: strings['source_note']!,
    usage_scope: strings['usage_scope']!,
    parse,
  }
}

interface CandidatePatchBody {
  draft_payload: Record<string, unknown> | null
  subject_id: string | null
  expected_revision: number | null
  note: string
}

/** `CandidatePatch` (`:130`): full replacement of `draft_payload`; `null` means "do not change". */
function candidatePatchBody(body: unknown): CandidatePatchBody {
  const record = objectBody(body)
  const errors: SchemaError[] = []
  let draftPayload: Record<string, unknown> | null = null
  if (Object.hasOwn(record, 'draft_payload') && record['draft_payload'] !== null) {
    const value = record['draft_payload']
    if (typeof value !== 'object' || Array.isArray(value)) errors.push(dictType(['body', 'payload', 'draft_payload']))
    else draftPayload = value as Record<string, unknown>
  }
  let subjectId: string | null = null
  if (Object.hasOwn(record, 'subject_id') && record['subject_id'] !== null) {
    if (typeof record['subject_id'] !== 'string') errors.push(stringType(['body', 'payload', 'subject_id']))
    else subjectId = record['subject_id']
  }
  let expectedRevision: number | null = null
  if (Object.hasOwn(record, 'expected_revision') && record['expected_revision'] !== null) {
    const coerced = coerceInt(record['expected_revision'], ['body', 'payload', 'expected_revision'])
    if ('error' in coerced) errors.push(coerced.error)
    else expectedRevision = coerced.value
  }
  let note = ''
  if (Object.hasOwn(record, 'note')) {
    if (typeof record['note'] !== 'string') errors.push(stringType(['body', 'payload', 'note']))
    else note = record['note']
  }
  if (errors.length > 0) throw schemaError(errors)
  return { draft_payload: draftPayload, subject_id: subjectId, expected_revision: expectedRevision, note }
}

/** `CandidateLayoutConfirmIn` (`:137`). */
function layoutConfirmBody(body: unknown): { note: string } {
  const record = objectBody(body)
  if (!Object.hasOwn(record, 'note')) return { note: '' }
  if (typeof record['note'] !== 'string') throw schemaError([stringType(['body', 'payload', 'note'])])
  return { note: record['note'] }
}

interface CandidatePublishBody {
  exam_spec_version_id: string | null
  node_ids: string[]
  origin_type: string
  display_label: string
}

/**
 * `CandidatePublishIn` (`backend/apps/ingestion/api.py:143`).
 *
 * Every field has a default, so an empty body publishes with `user_authored` and no nodes. The
 * defaults are part of the idempotency fingerprint (Django hashes `model_dump(mode="json")`), which
 * is why this validator returns the *applied* values rather than the raw body.
 */
function candidatePublishBody(body: unknown): CandidatePublishBody {
  const record = objectBody(body)
  const errors: SchemaError[] = []
  let examSpecVersionId: string | null = null
  if (Object.hasOwn(record, 'exam_spec_version_id') && record['exam_spec_version_id'] !== null) {
    if (typeof record['exam_spec_version_id'] !== 'string') {
      errors.push(stringType(['body', 'payload', 'exam_spec_version_id']))
    } else {
      examSpecVersionId = record['exam_spec_version_id']
    }
  }
  let nodeIds: string[] = []
  if (Object.hasOwn(record, 'node_ids')) {
    if (!Array.isArray(record['node_ids'])) {
      errors.push(listType(['body', 'payload', 'node_ids']))
    } else {
      record['node_ids'].forEach((value, index) => {
        if (typeof value !== 'string') errors.push(stringType(['body', 'payload', 'node_ids', index]))
        else nodeIds.push(value)
      })
    }
  }
  let originType = 'user_authored'
  if (Object.hasOwn(record, 'origin_type')) {
    if (typeof record['origin_type'] !== 'string') errors.push(stringType(['body', 'payload', 'origin_type']))
    else originType = record['origin_type']
  }
  let displayLabel = ''
  if (Object.hasOwn(record, 'display_label')) {
    if (typeof record['display_label'] !== 'string') errors.push(stringType(['body', 'payload', 'display_label']))
    else displayLabel = record['display_label']
  }
  if (errors.length > 0) throw schemaError(errors)
  return {
    exam_spec_version_id: examSpecVersionId,
    node_ids: nodeIds,
    origin_type: originType,
    display_label: displayLabel,
  }
}

/** `extraction.vision_available()`: the port's honest answer, never a guess from configuration. */
async function visionAvailable(deps: IngestionRouteDeps): Promise<boolean> {
  if (deps.llm === undefined) return false
  const availability = await deps.llm().availability()
  return availability.extract_question?.available === true
}

interface VariantProposeBody {
  source_question_id: string | null
  source_version_id: string | null
  node_id: string
  count: number
  difficulty_note: string
}

/**
 * `VariantProposeIn` (`backend/apps/ingestion/api.py:158`).
 *
 * `node_id` is the only required field; `count` is a pydantic `int`, so 1.5 is `int_from_float` and
 * "2" is `int_parsing` (the same two shapes as `expected_revision`). The applied defaults are part
 * of the idempotency fingerprint.
 */
function variantProposeBody(body: unknown): VariantProposeBody {
  const record = objectBody(body)
  const errors: SchemaError[] = []
  let sourceQuestionId: string | null = null
  if (Object.hasOwn(record, 'source_question_id') && record['source_question_id'] !== null) {
    if (typeof record['source_question_id'] !== 'string') {
      errors.push(stringType(['body', 'payload', 'source_question_id']))
    } else {
      sourceQuestionId = record['source_question_id']
    }
  }
  let sourceVersionId: string | null = null
  if (Object.hasOwn(record, 'source_version_id') && record['source_version_id'] !== null) {
    if (typeof record['source_version_id'] !== 'string') {
      errors.push(stringType(['body', 'payload', 'source_version_id']))
    } else {
      sourceVersionId = record['source_version_id']
    }
  }
  let nodeId: string | undefined
  if (!Object.hasOwn(record, 'node_id')) errors.push(missing(['body', 'payload', 'node_id']))
  else if (typeof record['node_id'] !== 'string') errors.push(stringType(['body', 'payload', 'node_id']))
  else nodeId = record['node_id']
  let count = 1
  if (Object.hasOwn(record, 'count')) {
    const coerced = coerceInt(record['count'], ['body', 'payload', 'count'])
    if ('error' in coerced) errors.push(coerced.error)
    else count = coerced.value
  }
  let difficultyNote = ''
  if (Object.hasOwn(record, 'difficulty_note')) {
    if (typeof record['difficulty_note'] !== 'string') errors.push(stringType(['body', 'payload', 'difficulty_note']))
    else difficultyNote = record['difficulty_note']
  }
  if (errors.length > 0) throw schemaError(errors)
  return {
    source_question_id: sourceQuestionId,
    source_version_id: sourceVersionId,
    node_id: nodeId!,
    count,
    difficulty_note: difficultyNote,
  }
}

/** `_variant_source_version`: an owner-scoped source version; a foreign or unknown id is a 404. */
function resolveVariantSource(ctx: RouteContext, projectId: string, payload: VariantProposeBody): Row {
  const base = `SELECT v."id" AS id
                  FROM "question_bank_question_version" v
                  JOIN "question_bank_question" q ON q."id" = v."question_id"
                  JOIN "exams_subject" s ON s."id" = q."subject_id"
                 WHERE s."project_id" = ?`
  let hit: { id: string } | undefined
  if (payload.source_version_id !== null && payload.source_version_id !== '') {
    hit = ctx.db.prepare(`${base} AND v."id" = ? LIMIT 1`).get(projectId, payload.source_version_id) as
      | { id: string }
      | undefined
  } else {
    hit = ctx.db
      .prepare(`${base} AND v."question_id" = ? AND v."status" = 'published' ORDER BY v."version" DESC LIMIT 1`)
      .get(projectId, payload.source_question_id ?? '') as { id: string } | undefined
  }
  const version = hit === undefined ? null : getRow(ctx.db, 'question_bank_question_version', hit.id)
  if (version === null) throw new ScopeViolation('源题目版本不存在或不属于该项目')
  return version
}

/** The variant-batch list and its serializer live in `services/variants.ts` (`variant_jobs`). */
function listVariants(ctx: RouteContext): unknown {
  const limit = intQuery(ctx, 'limit', 20)
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const bounded = Math.max(1, Math.min(limit, 50))
  const jobs = variantJobs(ctx.db, String(project.id), ctx.userId, bounded)
  return { count: jobs.length, limit: bounded, jobs }
}

/**
 * O19: propose AI variants of one question as reviewable candidates.
 *
 * The async resource wrapper 06 §6.2 asks for: the claim commits before the model call, every run
 * and candidate is committed in its own short transaction (so a mid-batch failure keeps what was
 * already validated), the result is recorded afterwards, and a failed request releases the claim
 * so the same key can be retried. The provider failure is mapped by *code*, never by message.
 */
async function proposeVariantsRoute(
  ctx: RouteContext,
  deps: IngestionRouteDeps,
): Promise<{ status: number; body: unknown }> {
  // Body validation runs before the project lookup, exactly like Ninja's parameter binding.
  const payload = variantProposeBody(ctx.body)
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  if (
    (payload.source_question_id === null || payload.source_question_id === '') &&
    (payload.source_version_id === null || payload.source_version_id === '')
  ) {
    throw new InvalidInput('必须提供 source_question_id 或 source_version_id')
  }
  if (payload.count < 1) throw new InvalidInput('count 必须至少为 1')
  const sourceVersion = resolveVariantSource(ctx, String(project.id), payload)
  const nodeHit = ctx.db
    .prepare(
      `SELECT n."id" AS id FROM "knowledge_node" n
         JOIN "exams_syllabus_version" sv ON sv."id" = n."syllabus_version_id"
         JOIN "exams_subject" s ON s."id" = sv."subject_id"
        WHERE n."id" = ? AND s."project_id" = ? LIMIT 1`,
    )
    .get(payload.node_id, String(project.id)) as { id: string } | undefined
  const node = nodeHit === undefined ? null : getRow(ctx.db, 'knowledge_node', nodeHit.id)
  if (node === null) throw new ScopeViolation('考点不存在或不属于该项目')

  const key = idempotencyKey(ctx)
  const scope = `variants.propose:${String(project.id)}`
  const fingerprintPayload = {
    source_question_id: payload.source_question_id,
    source_version_id: payload.source_version_id,
    node_id: payload.node_id,
    count: payload.count,
    difficulty_note: payload.difficulty_note,
  }
  let replay: ReturnType<typeof claim>
  try {
    replay = transaction(ctx.db, () =>
      claim(ctx.db, { userId: ctx.userId, routeScope: scope, key, payload: fingerprintPayload, now: ctx.now }),
    )
  } catch (error) {
    if (error instanceof StoreIdempotencyConflict) {
      throw new IdempotencyConflictError(
        error.reason === 'in_flight' ? '相同幂等键的请求正在处理中，请稍后重试' : '相同幂等键使用了不同请求内容',
        { details: { route_scope: error.routeScope, reason: error.reason } },
      )
    }
    throw error
  }
  if (replay !== null) return { status: replay.statusCode, body: replay.body }

  const port = deps.llm === undefined ? unconfiguredPort() : deps.llm()
  try {
    const result = await proposeVariants(
      ctx.db,
      {
        projectId: String(project.id),
        ownerId: ctx.userId,
        sourceVersion,
        node,
        actorId: ctx.userId,
        count: payload.count,
        difficultyNote: payload.difficulty_note,
        port,
      },
      ctx.now,
    )
    transaction(ctx.db, () =>
      recordResult(ctx.db, {
        userId: ctx.userId,
        routeScope: scope,
        key,
        statusCode: 201,
        responseBody: result,
        resourceType: 'import_job',
        resourceId: String(result.job_id),
        now: ctx.now,
      }),
    )
    return { status: 201, body: result }
  } catch (error) {
    // Release the unfulfilled claim so a retry with the same key is not blocked; the run/job rows
    // that were already committed stay (失败留候选, 06 §6.2).
    transaction(ctx.db, () => release(ctx.db, ctx.userId, scope, key))
    if (error instanceof VariantProviderFailure) {
      if (error.unavailable) {
        throw new AiNotConfigured(`生成变式需要配置 AI 能力：${VARIANT_UNCONFIGURED_REASON}`, {
          details: { error_code: error.failureCode },
        })
      }
      throw new DependencyUnavailable(`生成变式失败：${error.message}`, {
        details: { error_code: error.failureCode },
      })
    }
    throw error
  }
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

/** A query `int` parameter, validated the way Ninja validates declared query params. */
function intQuery(ctx: RouteContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name)
  if (raw === null) return fallback
  const coerced = coerceInt(raw, ['query', name])
  if ('error' in coerced) throw schemaError([coerced.error])
  return coerced.value
}

/**
 * The Django idempotency contract (`apps/common/api.py::idempotency_key`).
 *
 * The trim and the length limit are part of the contract: a client that retries with the same key
 * must hit the same record, and a key that only differs by whitespace is the same key.
 */
function idempotencyKey(ctx: RouteContext): string {
  const key = pyStrip(ctx.headers.get('idempotency-key') ?? '')
  if (key === '') throw new IdempotencyConflictError('缺少 Idempotency-Key 请求头')
  if (pyCodePointLen(key) > 200) throw new IdempotencyConflictError('Idempotency-Key 过长')
  return key
}

/**
 * Claim + effect + result in one transaction, with the ingestion error details.
 *
 * A failure rolls the claim back with the effect (the Node equivalent of Django's middleware
 * `release()` on a 4xx/5xx response), so the same key can be retried after a rejected request.
 */
function ingestionResource(
  scopeOf: (ctx: RouteContext) => string,
  handler: (ctx: RouteContext) => { status: number; body: unknown; resourceType?: string; resourceId?: string },
  payloadOf: (ctx: RouteContext) => unknown,
  /**
   * The wire projection applied to both a fresh response and a replay.
   *
   * O18 is the reason this exists: Django stores `candidate_summary(...) + question_id` as the
   * idempotent result but the declared `CandidateOut` response model drops `question_id`, so the
   * stored body and the HTTP body are deliberately different shapes.
   */
  project?: (body: unknown) => unknown,
): Route['handler'] {
  return (ctx) => {
    const key = idempotencyKey(ctx)
    const scope = scopeOf(ctx)
    return transaction(ctx.db, () => {
      let replay: ReturnType<typeof claim>
      try {
        replay = claim(ctx.db, {
          userId: ctx.userId,
          routeScope: scope,
          key,
          payload: payloadOf(ctx),
          now: ctx.now,
        })
      } catch (error) {
        if (error instanceof StoreIdempotencyConflict) {
          const message =
            error.reason === 'in_flight'
              ? '相同幂等键的请求正在处理中，请稍后重试'
              : '相同幂等键使用了不同请求内容'
          throw new IdempotencyConflictError(message, {
            details: { route_scope: error.routeScope, reason: error.reason },
          })
        }
        throw error
      }
      if (replay !== null) {
        return { status: replay.statusCode, body: project === undefined ? replay.body : project(replay.body) }
      }
      const result = handler(ctx)
      recordResult(ctx.db, {
        userId: ctx.userId,
        routeScope: scope,
        key,
        statusCode: result.status,
        responseBody: result.body,
        resourceType: result.resourceType,
        resourceId: result.resourceId,
        now: ctx.now,
      })
      return project === undefined ? result : { status: result.status, body: project(result.body) }
    })
  }
}

/** `_document_out()` (`backend/apps/ingestion/api.py:267`). */
function documentOut(document: Row): Record<string, unknown> {
  return {
    id: String(document.id),
    project_id: String(document.project_id),
    subject_id: document.subject_id === null ? null : String(document.subject_id),
    title: document.title,
    document_type: document.document_type,
    role: document.role,
    sensitivity: document.sensitivity,
    source_type: document.source_type,
    source_note: document.source_note,
    usage_scope: document.usage_scope,
    checksum: document.checksum,
    asset_id: document.asset_id === null ? null : String(document.asset_id),
    raw_text_preview: pyCodePointSlice(String(document.raw_text ?? ''), 0, 400),
  }
}

// --------------------------------------------------------------------------
// O03 / O04 — source documents
// --------------------------------------------------------------------------

function listSourceDocuments(ctx: RouteContext): unknown[] {
  // Query validation first: Ninja rejects `?limit=abc` before the view runs, even for a project
  // the caller does not own.
  const limit = intQuery(ctx, 'limit', 50)
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const subjectId = ctx.query.get('subject_id')
  const where: Record<string, unknown> = { project_id: project.id, owner_id: ctx.userId }
  if (subjectId !== null && subjectId !== '') {
    requireSubject(ctx.db, ctx.userId, ctx.params.project_id, subjectId)
    where.subject_id = subjectId
  }
  return findRows(ctx.db, 'ingestion_source_document', where, {
    orderBy: [['created_at', 'desc']],
    limit: Math.max(1, Math.min(limit, 100)),
  }).map(documentOut)
}

function createTextSource(ctx: RouteContext): { status: number; body: unknown } {
  const payload = textImportBody(ctx.body)
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const subject =
    payload.subject_id !== null && payload.subject_id !== ''
      ? requireSubject(ctx.db, ctx.userId, ctx.params.project_id, payload.subject_id)
      : null
  const document = createTextDocument(
    ctx.db,
    {
      ownerId: ctx.userId,
      projectId: String(project.id),
      subjectId: subject === null ? null : String(subject.id),
      text: payload.text,
      title: payload.title,
      sourceNote: payload.source_note,
      usageScope: payload.usage_scope,
    },
    ctx.now,
  )
  return { status: 201, body: documentOut(document) }
}

// --------------------------------------------------------------------------
// O07 / O10–O12 — import jobs
// --------------------------------------------------------------------------

function createTextImport(
  ctx: RouteContext,
  payload: TextImportBody,
  projectId: string,
  subjectId: string | null,
): { status: number; body: unknown } {
  const segments = payload.parse ? parsePaste(payload.text) : []
  const job = startTextImport(
    ctx.db,
    {
      ownerId: ctx.userId,
      projectId,
      subjectId,
      text: payload.text,
      title: payload.title,
      sourceNote: payload.source_note,
      usageScope: payload.usage_scope,
      segments,
    },
    ctx.now,
  )
  return { status: 201, body: jobSummary(ctx.db, job) }
}

function listImports(ctx: RouteContext): unknown[] {
  const limit = intQuery(ctx, 'limit', 20)
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const status = ctx.query.get('status')
  const where: Record<string, unknown> = { project_id: project.id, created_by_id: ctx.userId }
  if (status !== null && status !== '') where.status = status
  return findRows(ctx.db, 'ingestion_import_job', where, {
    orderBy: [['created_at', 'desc']],
    limit: Math.max(1, Math.min(limit, 100)),
  }).map((job) => jobSummary(ctx.db, job))
}

function getImport(ctx: RouteContext): unknown {
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const job = requireJob(ctx.db, ctx.userId, String(project.id), ctx.params.job_id)
  return jobSummary(ctx.db, job)
}

// --------------------------------------------------------------------------
// O13–O17 — candidates
// --------------------------------------------------------------------------

function listCandidates(ctx: RouteContext): unknown[] {
  const limit = intQuery(ctx, 'limit', 50)
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const jobId = ctx.query.get('job_id')
  const status = ctx.query.get('status')
  const clauses = ['c."project_id" = ?', 'j."created_by_id" = ?']
  const params: unknown[] = [project.id, ctx.userId]
  if (jobId !== null && jobId !== '') {
    clauses.push('c."job_id" = ?')
    params.push(jobId)
  }
  if (status !== null && status !== '') {
    clauses.push('c."status" = ?')
    params.push(status)
  }
  const ids = ctx.db
    .prepare(
      `SELECT c."id" AS id FROM "ingestion_import_candidate" c
         JOIN "ingestion_import_job" j ON j."id" = c."job_id"
        WHERE ${clauses.join(' AND ')}
        ORDER BY c."created_at" ASC
        LIMIT ?`,
    )
    .all(...([...params, Math.max(1, Math.min(limit, 100))] as never[])) as { id: string }[]
  return ids.map((row) => candidateSummary(ctx.db, getRow(ctx.db, 'ingestion_import_candidate', row.id)!))
}

function getCandidate(ctx: RouteContext): unknown {
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const candidate = requireCandidate(ctx.db, ctx.userId, String(project.id), ctx.params.candidate_id)
  recordCandidateEditorialPreview(
    ctx.db,
    { candidate, actorId: ctx.userId, source: 'ingestion.candidate_detail' },
    ctx.now,
  )
  return candidateSummary(ctx.db, candidate)
}

function patchCandidate(ctx: RouteContext): unknown {
  const payload = candidatePatchBody(ctx.body)
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const candidate = requireCandidate(ctx.db, ctx.userId, String(project.id), ctx.params.candidate_id)
  const subject =
    payload.subject_id !== null && payload.subject_id !== ''
      ? requireSubject(ctx.db, ctx.userId, ctx.params.project_id, payload.subject_id)
      : null
  // Django records the editorial preview *before* `update_candidate`'s transaction, so a revision
  // conflict still leaves the exposure behind. Keeping the same order matters: the exposure is a
  // fact about what was shown, not about whether the edit succeeded.
  recordCandidateEditorialPreview(
    ctx.db,
    { candidate, actorId: ctx.userId, source: 'ingestion.candidate_edit' },
    ctx.now,
  )
  const updated = updateCandidate(
    ctx.db,
    ctx.userId,
    String(project.id),
    String(candidate.id),
    {
      draftPayload: payload.draft_payload,
      subjectId: subject === null ? null : String(subject.id),
      expectedRevision: payload.expected_revision,
      note: payload.note,
    },
    ctx.now,
  )
  return candidateSummary(ctx.db, updated)
}

function ignoreCandidateRoute(ctx: RouteContext): { status: number; body: unknown } {
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const reason = ctx.query.get('reason') ?? ''
  const candidate = ignoreCandidate(
    ctx.db,
    ctx.userId,
    String(project.id),
    ctx.params.candidate_id,
    reason,
    ctx.now,
  )
  return { status: 200, body: candidateSummary(ctx.db, candidate) }
}

function layoutConfirmRoute(ctx: RouteContext): { status: number; body: unknown } {
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const payload = layoutConfirmBody(ctx.body)
  const candidate = confirmLayoutReview(
    ctx.db,
    ctx.userId,
    String(project.id),
    ctx.params.candidate_id,
    payload.note,
    ctx.now,
  )
  return { status: 200, body: candidateSummary(ctx.db, candidate) }
}

/** `CandidateOut` — the declared response model. `question_id` is deliberately absent. */
function candidateOut(body: unknown): Record<string, unknown> {
  const summary = (body ?? {}) as Record<string, unknown>
  return {
    id: summary['id'],
    job_id: summary['job_id'],
    subject_id: summary['subject_id'] ?? null,
    status: summary['status'],
    revision: summary['revision'],
    review_issues: summary['review_issues'] ?? [],
    is_stub_output: summary['is_stub_output'] ?? false,
    extractor_version: summary['extractor_version'] ?? '',
    draft_payload: summary['draft_payload'] ?? {},
    machine_payload: summary['machine_payload'] ?? {},
    source_regions: summary['source_regions'] ?? [],
    publication_question_id: summary['publication_question_id'] ?? null,
    publication_version_id: summary['publication_version_id'] ?? null,
    publication_paper_item_id: summary['publication_paper_item_id'] ?? null,
    parent_candidate_id: summary['parent_candidate_id'] ?? null,
    child_candidate_ids: summary['child_candidate_ids'] ?? [],
    source_position_key: summary['source_position_key'] ?? '',
    paper_revision_id: summary['paper_revision_id'] ?? null,
    answer_match: summary['answer_match'] ?? {},
    layout_review_confirmed_at: summary['layout_review_confirmed_at'] ?? null,
    layout_review_note: summary['layout_review_note'] ?? '',
    updated_at: summary['updated_at'],
  }
}

/** `_asset_out()` (`backend/apps/ingestion/api.py:251`). */
function assetOut(asset: Row): Record<string, unknown> {
  return {
    id: String(asset.id),
    project_id: String(asset.project_id),
    role: asset.role,
    sensitivity: asset.sensitivity,
    content_type: asset.content_type,
    size_bytes: Number(asset.size_bytes),
    width: asset.width === null || asset.width === undefined ? null : Number(asset.width),
    height: asset.height === null || asset.height === undefined ? null : Number(asset.height),
    checksum: asset.checksum,
    original_filename: asset.original_filename,
    download_url: `${PREFIX}/projects/${String(asset.project_id)}/assets/${String(asset.id)}`,
  }
}

/**
 * A required file part, as Ninja rejects a missing one.
 *
 * `File(...)` is a required parameter, so the parameter validation runs before the view body: a
 * request with no file is a 400 even for a project the caller does not own. The `loc` starts at
 * `body` for the same reason every other schema error in this file does (04 §I).
 */
function requireFilePart(ctx: RouteContext, field: string): UploadedFile {
  const found = ctx.files.find((file) => file.field === field)
  // Ninja's file parameter errors are located under `["file", <param>]`, not `["body", …]`
  // (probe P15/P16/P54). A JSON body sent to a multipart endpoint therefore produces the same
  // "Field required" shape, because `request.FILES` is simply empty.
  if (found === undefined) throw schemaError([missing(['file', field])])
  return found
}

/** The parts of one multipart field, in upload order (`files` is a list field in O08). */
function fileParts(ctx: RouteContext, field: string): UploadedFile[] {
  return ctx.files.filter((file) => file.field === field)
}

// --------------------------------------------------------------------------
// O01 / O02 — private assets
// --------------------------------------------------------------------------

async function uploadAsset(ctx: RouteContext): Promise<{ status: number; body: unknown }> {
  // Ninja's parameter validation first, then the view: project → empty check → role/type checks →
  // decode. `store_asset` runs the role check before the image work, so it is run here before the
  // async decode as well (see `assertAssetFields`).
  const file = requireFilePart(ctx, 'file')
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  if (file.bytes.byteLength === 0) throw new InvalidInput('上传内容为空')
  const contentType = file.contentType
  const role = ctx.form['role'] ?? 'past_paper_page'
  assertAssetFields(ctx.db, { projectId: String(project.id), role, sensitivity: 'public_to_owner', subjectId: null })
  const prepared = contentType.startsWith('image/')
    ? await prepareAssetImage({ bytes: file.bytes, contentType, reencode: true })
    : null
  const asset = transaction(ctx.db, () =>
    storeAsset(
      ctx.db,
      {
        ownerId: ctx.userId,
        projectId: String(project.id),
        content: file.bytes,
        contentType,
        role,
        originalFilename: file.filename,
        prepared,
      },
      ctx.now,
    ),
  )
  return { status: 201, body: assetOut(asset) }
}

/**
 * O02: authenticated byte delivery.
 *
 * The order is the security contract, not an implementation detail: asset scope → session item
 * scope → gate → `exists` → exposure → open. `exists` is checked *before* the exposure row is
 * written and the stream is opened after it, so a delivery that fails to open still leaves the
 * ledger entry (the safe direction: an unlogged delivery would let a question keep counting as
 * "never seen").
 */
function downloadAsset(ctx: RouteContext): Response {
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const asset = assetScope(ctx.db, ctx.userId, String(project.id), ctx.params.asset_id)
  const purpose = ctx.query.get('purpose') ?? 'practice'
  const rawItemId = ctx.query.get('session_item_id')
  const sessionItem =
    rawItemId === null || rawItemId === '' ? null : sessionItemScope(ctx.db, ctx.userId, String(project.id), rawItemId)
  const session = sessionItem === null ? null : getRow(ctx.db, 'practice_session', sessionItem.session_id)
  assertAssetDownloadAllowed(ctx.db, { userId: ctx.userId, projectId: String(project.id), asset, purpose, session })
  const storage = getStorage()
  const key = String(asset.object_key)
  if (!storage.exists(key)) {
    // Django raises `Http404("asset bytes are missing")`; the common handler maps it to the same
    // 404 envelope an out-of-scope object gets, so the path never leaks.
    throw new ScopeViolation()
  }
  recordDownloadExposure(ctx.db, { userId: ctx.userId, projectId: String(project.id), asset, purpose, sessionItem }, ctx.now)
  const bytes = storage.open(key)
  const contentType = String(asset.content_type)
  const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment'
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `${disposition}; filename="${String(asset.id)}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}

// --------------------------------------------------------------------------
// O05 / O08 — image sources and image imports
// --------------------------------------------------------------------------

async function createImageSource(ctx: RouteContext): Promise<{ status: number; body: unknown }> {
  const file = requireFilePart(ctx, 'file')
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const subjectId = ctx.form['subject_id'] ?? ''
  const subject = subjectId !== '' ? requireSubject(ctx.db, ctx.userId, ctx.params.project_id, subjectId) : null
  if (file.bytes.byteLength === 0) throw new InvalidInput('上传内容为空')
  const role = ctx.form['role'] ?? 'past_paper_page'
  // The view's own message, which differs from `store_asset`'s "资产角色无效" on purpose.
  if (!ASSET_ROLES.includes(role)) throw new InvalidInput('来源角色无效')
  const sensitivity = role === 'answer_page' ? 'contains_answers' : 'public_to_owner'
  const contentType = file.contentType
  // `create_image_document` only validates/re-encodes when the declared type is an image; a
  // non-image type is stored as-is under `document_type=image` (Django's current behaviour, kept).
  const prepared = contentType.startsWith('image/')
    ? await prepareAssetImage({ bytes: file.bytes, contentType, reencode: true })
    : null
  const document = transaction(ctx.db, () =>
    createImageDocument(
      ctx.db,
      {
        ownerId: ctx.userId,
        projectId: String(project.id),
        subjectId: subject === null ? null : String(subject.id),
        prepared,
        content: file.bytes,
        contentType,
        role,
        title: ctx.form['title'] ?? '',
        sourceNote: ctx.form['source_note'] ?? '',
        usageScope: ctx.form['usage_scope'] ?? '',
        sensitivity,
        originalFilename: file.filename,
      },
      ctx.now,
    ),
  )
  return { status: 201, body: documentOut(document) }
}

/**
 * O08: store the pages and open one proofreading candidate per page.
 *
 * The expensive, asynchronous part (decode + re-encode) is done **before** the idempotency claim, so
 * the claim and the database writes stay inside one synchronous transaction. Django validates every
 * image before the claim too; the re-encode is pure, so moving it earlier cannot change the write
 * set — a rejected image still creates no claim, no document and no job.
 *
 * `title`, the filenames and the MIME types are **not** part of the fingerprint (06 §2), so a retry
 * that only renames the file replays the first job instead of conflicting.
 */
async function createImageImport(ctx: RouteContext, deps: IngestionRouteDeps = {}): Promise<{ status: number; body: unknown }> {
  const files = fileParts(ctx, 'files')
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const subjectId = ctx.form['subject_id'] ?? ''
  const subject = subjectId !== '' ? requireSubject(ctx.db, ctx.userId, ctx.params.project_id, subjectId) : null
  // Django's own `if not files: raise InvalidInput("请至少上传一张图片")` is **unreachable**: the
  // `list[UploadedFile] = File(...)` parameter is required, so an empty/missing `files` is rejected
  // by Ninja before the view runs (probe P54). Reproducing the reachable behaviour means the same
  // validation error, not the view's message.
  if (files.length === 0) throw schemaError([missing(['file', 'files'])])
  const prepared: PreparedImage[] = []
  for (const file of files) {
    prepared.push(await prepareAssetImage({ bytes: file.bytes, contentType: file.contentType, reencode: true }))
  }
  const checksums = files.map((file) => fileChecksum(file.bytes))
  // `extraction.vision_available()`: the branch is chosen by capability, not by hope. A model that
  // does not declare image input (or no model at all) keeps the manual path and its explicit
  // warning; the request is still a 201 either way (06 §6.1).
  const useVision = await visionAvailable(deps)
  const key = idempotencyKey(ctx)
  const scope = `imports.create_images:${String(project.id)}`
  const role = ctx.form['role'] ?? 'past_paper_page'
  const title = ctx.form['title'] ?? ''

  return transaction(ctx.db, () => {
    let replay: ReturnType<typeof claim>
    try {
      replay = claim(ctx.db, {
        userId: ctx.userId,
        routeScope: scope,
        key,
        // The fingerprint uses the raw form values, not the resolved subject row (06 §2).
        payload: { checksums, subject_id: subjectId, role },
        now: ctx.now,
      })
    } catch (error) {
      if (error instanceof StoreIdempotencyConflict) {
        throw new IdempotencyConflictError(
          error.reason === 'in_flight' ? '相同幂等键的请求正在处理中，请稍后重试' : '相同幂等键使用了不同请求内容',
          { details: { route_scope: error.routeScope, reason: error.reason } },
        )
      }
      throw error
    }
    if (replay !== null) return { status: replay.statusCode, body: replay.body }

    const documents: Row[] = []
    const duplicates: Row[] = []
    files.forEach((file, index) => {
      const existing = findDuplicateDocument(ctx.db, { projectId: String(project.id), checksum: checksums[index] })
      if (existing !== null) {
        // Reuse the original source: its subject/role/sensitivity are **not** overwritten by this
        // request's parameters, so a later import cannot silently reclassify an existing page.
        duplicates.push(existing)
        return
      }
      documents.push(
        createImageDocument(
          ctx.db,
          {
            ownerId: ctx.userId,
            projectId: String(project.id),
            subjectId: subject === null ? null : String(subject.id),
            prepared: prepared[index],
            content: file.bytes,
            contentType: file.contentType,
            role,
            title,
            sensitivity: role === 'answer_page' ? 'contains_answers' : 'public_to_owner',
            originalFilename: file.filename,
          },
          ctx.now,
        ),
      )
    })
    let job = startImageImport(
      ctx.db,
      {
        ownerId: ctx.userId,
        projectId: String(project.id),
        subjectId: subject === null ? null : String(subject.id),
        // A mixed upload imports the new documents only; a fully duplicate upload reuses the
        // originals so the proofreader still gets a job (06 §3.4).
        documents: documents.length > 0 ? documents : duplicates,
        title,
        // B5: a configured vision model is used; otherwise the manual path stays the honest one.
        useVision,
        // There is no stub provider in this package, so a queued extraction is never labelled one.
        visionIsStub: false,
      },
      ctx.now,
    )
    if (duplicates.length > 0) {
      job = addJobProblem(
        ctx.db,
        job,
        {
          code: 'duplicate_source_file',
          message: `其中 ${duplicates.length} 张图片与已有来源文件完全相同，已复用原来源而未新增（避免同一试卷重复统计）。`,
          severity: 'warning',
        },
        ctx.now,
      )
    }
    const body = jobSummary(ctx.db, job)
    recordResult(ctx.db, {
      userId: ctx.userId,
      routeScope: scope,
      key,
      statusCode: 201,
      responseBody: body,
      resourceType: 'import_job',
      resourceId: String(job.id),
      now: ctx.now,
    })
    return { status: 201, body }
  })
}

/**
 * O09: batch-import born-digital paper PDFs (plus optional answer PDFs).
 *
 * The text layer is extracted deterministically — no model, no credentials. Each parsed question
 * becomes a proofreading candidate that knows its source page, and answers printed on a separate PDF
 * are matched onto those candidates as proposals only.
 *
 * Order of checks (Django's view, and Ninja's parameter validation before it): project → subject →
 * `files` required → `source_kind` enum → read the uploads → `official_past` needs a `cycle_key` →
 * idempotency claim → service. The extraction itself is asynchronous and therefore runs **before**
 * the claim, exactly like O08's image decode: a rejected PDF must leave no claim, no document and no
 * job behind, and the claim must share the transaction with the writes so a failed import releases
 * its key.
 *
 * `title`, the filenames and the MIME types are **not** part of the fingerprint (06 §2), so a retry
 * that only renames the file replays the first job instead of conflicting.
 */
async function createPdfImport(ctx: RouteContext): Promise<{ status: number; body: unknown }> {
  const files = fileParts(ctx, 'files')
  const answerFiles = fileParts(ctx, 'answer_files')
  const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
  const subjectId = ctx.form['subject_id'] ?? ''
  const subject = subjectId !== '' ? requireSubject(ctx.db, ctx.userId, ctx.params.project_id, subjectId) : null
  // `files: list[UploadedFile] = File(...)` is a required Ninja parameter, so an empty upload is
  // rejected by the framework before the view's own "请至少上传一份试卷 PDF" can run (probe P54).
  if (files.length === 0) throw schemaError([missing(['file', 'files'])])
  const sourceKind = ctx.form['source_kind'] ?? 'official_past'
  if (!(SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    throw new InvalidInput('试卷来源类型无效', { details: { source_kind: sourceKind } })
  }
  const cycleKey = ctx.form['cycle_key'] ?? ''
  const sessionKey = ctx.form['session_key'] ?? ''
  const paperCode = ctx.form['paper_code'] ?? ''
  const title = ctx.form['title'] ?? ''
  if (sourceKind === 'official_past' && cycleKey.trim() === '') {
    throw new InvalidInput('真实考试试卷必须填写年份/周期与卷别代码，否则无法进入历年统计')
  }
  const uploads = (list: UploadedFile[]): PdfUpload[] =>
    list.map((file) => ({ filename: file.filename, bytes: file.bytes, contentType: file.contentType }))
  const paperUploads = uploads(files)
  const answerUploads = uploads(answerFiles)
  const prepared = await preparePdfUploads({ paperFiles: paperUploads, answerFiles: answerUploads })
  const checksums = prepared.map((entry) => entry.checksum)
  const key = idempotencyKey(ctx)
  const scope = `imports.create_pdf:${String(project.id)}`
  // Ninja coerces `expected_session_count: int | None = Form(None)` before the view runs, so a
  // non-integer is a 422 schema error rather than a silently dropped count.
  const expectedRaw = ctx.form['expected_session_count'] ?? ''
  let expectedSessionCount: number | null = null
  if (expectedRaw !== '') {
    if (!/^[+-]?\d+$/.test(expectedRaw.trim())) {
      throw schemaError([
        {
          type: 'int_parsing',
          loc: ['body', 'payload', 'expected_session_count'],
          msg: 'Input should be a valid integer, unable to parse string as an integer',
        },
      ])
    }
    expectedSessionCount = Number(expectedRaw.trim())
  }

  return transaction(ctx.db, () => {
    let replay: ReturnType<typeof claim>
    try {
      replay = claim(ctx.db, {
        userId: ctx.userId,
        routeScope: scope,
        key,
        // The fingerprint uses the raw form values, not the resolved subject row (06 §2).
        payload: {
          checksums,
          subject_id: subjectId,
          cycle_key: cycleKey,
          session_key: sessionKey,
          paper_code: paperCode,
          source_kind: sourceKind,
        },
        now: ctx.now,
      })
    } catch (error) {
      if (error instanceof StoreIdempotencyConflict) {
        throw new IdempotencyConflictError(
          error.reason === 'in_flight' ? '相同幂等键的请求正在处理中，请稍后重试' : '相同幂等键使用了不同请求内容',
          { details: { route_scope: error.routeScope, reason: error.reason } },
        )
      }
      throw error
    }
    if (replay !== null) return { status: replay.statusCode, body: replay.body }

    const job = startPdfImportPrepared(
      ctx.db,
      {
        ownerId: ctx.userId,
        projectId: String(project.id),
        subjectId: subject === null ? null : String(subject.id),
        paperFiles: paperUploads,
        answerFiles: answerUploads,
        prepared,
        title,
        sourceNote: ctx.form['source_note'] ?? '',
        usageScope: ctx.form['usage_scope'] ?? '',
        cycleKey,
        sessionKey,
        paperCode,
        sourceKind,
        expectedSessionCount,
        paperTitle: title,
      },
      ctx.now,
    )
    const body = jobSummary(ctx.db, job)
    recordResult(ctx.db, {
      userId: ctx.userId,
      routeScope: scope,
      key,
      statusCode: 201,
      responseBody: body,
      resourceType: 'import_job',
      resourceId: String(job.id),
      now: ctx.now,
    })
    return { status: 201, body }
  })
}

export function ingestionRoutes(deps: IngestionRouteDeps = {}): Route[] {
  return [
    // O01
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/assets`,
      handler: (ctx) => uploadAsset(ctx),
    },
    // O02
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/assets/:asset_id`,
      handler: (ctx) => downloadAsset(ctx),
    },
    // O03
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/source-documents`,
      handler: (ctx) => listSourceDocuments(ctx),
    },
    // O04
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/source-documents/text`,
      handler: (ctx) => createTextSource(ctx),
    },
    // O05
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/source-documents/image`,
      handler: (ctx) => createImageSource(ctx),
    },
    // O06 (B0)
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/imports/parse-text`,
      handler: (ctx) => {
        const record = objectBody(ctx.body)
        if (!Object.hasOwn(record, 'text')) throw schemaError([missing(['body', 'payload', 'text'])])
        if (typeof record['text'] !== 'string') throw schemaError([stringType(['body', 'payload', 'text'])])
        requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const segments = parsePaste(record['text'])
        return { count: segments.length, segments }
      },
    },
    // O07
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/imports`,
      handler: (ctx) => {
        // Ninja validates the body before the view runs, then the view checks project/subject,
        // and only then reads the Idempotency-Key. Keeping that order matters for a request that
        // is wrong in more than one way: the first failing check is the one the client sees.
        const payload = textImportBody(ctx.body)
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const subject =
          payload.subject_id !== null && payload.subject_id !== ''
            ? requireSubject(ctx.db, ctx.userId, ctx.params.project_id, payload.subject_id)
            : null
        const scoped = ingestionResource(
          (inner) => `imports.create:${inner.params.project_id}`,
          (inner) => {
            const result = createTextImport(inner, payload, String(project.id), subject === null ? null : String(subject.id))
            return { ...result, resourceType: 'import_job', resourceId: String((result.body as Record<string, unknown>)['id']) }
          },
          () => payload,
        ) as (inner: RouteContext) => unknown
        return scoped(ctx)
      },
    },
    // O08
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/imports/images`,
      handler: (ctx) => createImageImport(ctx, deps),
    },
    // O09
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/imports/pdf`,
      handler: (ctx) => createPdfImport(ctx),
    },
    // O10
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/imports`,
      handler: (ctx) => listImports(ctx),
    },
    // O11
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/imports/:job_id`,
      handler: (ctx) => getImport(ctx),
    },
    // O12
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/imports/:job_id/retry`,
      handler: (ctx) => {
        // Scope checks happen before the claim, like Django: a foreign job is a 404 even when the
        // request also lacks an Idempotency-Key.
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const job = requireJob(ctx.db, ctx.userId, String(project.id), ctx.params.job_id)
        const scoped = ingestionResource(
          (inner) => `imports.retry:${inner.params.job_id}`,
          (inner) => ({
            status: 200,
            body: jobSummary(inner.db, retryJob(inner.db, job, inner.now)),
            resourceType: 'import_job',
            resourceId: String(job.id),
          }),
          () => ({}),
        ) as (inner: RouteContext) => unknown
        return scoped(ctx)
      },
    },
    // O13
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/import-candidates`,
      handler: (ctx) => listCandidates(ctx),
    },
    // O14
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/import-candidates/:candidate_id`,
      handler: (ctx) => getCandidate(ctx),
    },
    // O15
    {
      method: 'PATCH',
      pattern: `${PREFIX}/projects/:project_id/import-candidates/:candidate_id`,
      handler: (ctx) => patchCandidate(ctx),
    },
    // O16
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/import-candidates/:candidate_id/ignore`,
      handler: (ctx) => {
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        requireCandidate(ctx.db, ctx.userId, String(project.id), ctx.params.candidate_id)
        const scoped = ingestionResource(
          (inner) => `candidates.ignore:${inner.params.candidate_id}`,
          (inner) => ({ ...(ignoreCandidateRoute(inner) as { status: number; body: unknown }), resourceType: 'import_candidate', resourceId: inner.params.candidate_id }),
          (inner) => ({ reason: inner.query.get('reason') ?? '' }),
        ) as (inner: RouteContext) => unknown
        return scoped(ctx)
      },
    },
    // O17
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/import-candidates/:candidate_id/layout-confirm`,
      handler: (ctx) => {
        const payload = layoutConfirmBody(ctx.body)
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        requireCandidate(ctx.db, ctx.userId, String(project.id), ctx.params.candidate_id)
        const scoped = ingestionResource(
          (inner) => `candidates.layout_confirm:${inner.params.candidate_id}`,
          (inner) => ({ ...(layoutConfirmRoute(inner) as { status: number; body: unknown }), resourceType: 'import_candidate', resourceId: inner.params.candidate_id }),
          () => payload,
        ) as (inner: RouteContext) => unknown
        return scoped(ctx)
      },
    },
    // O18
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/import-candidates/:candidate_id/publish`,
      handler: (ctx) => {
        // The order is the Django view's: body → project → candidate → spec → Idempotency-Key.
        // A request that is wrong in several ways therefore reports the first check, and a spec
        // problem is visible even when the client forgot the key.
        const payload = candidatePublishBody(ctx.body)
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id)
        const candidate = requireCandidate(ctx.db, ctx.userId, String(project.id), ctx.params.candidate_id)
        let spec: Row | null = null
        if (payload.exam_spec_version_id !== null) {
          spec = findOne(ctx.db, 'exams_spec_version', { id: payload.exam_spec_version_id })
          const specSubject =
            spec === null ? null : findOne(ctx.db, 'exams_subject', { id: String(spec.subject_id) })
          if (spec === null || specSubject === null || String(specSubject.project_id) !== String(project.id)) {
            throw new ScopeViolation('考试规范版本不存在或不属于该项目')
          }
          if (spec.status !== 'published') {
            throw new InvalidInput('只能使用已发布的考试规范版本')
          }
        }
        const scoped = ingestionResource(
          (inner) => `candidates.publish:${inner.params.candidate_id}`,
          (inner) => {
            const result = publishCandidate(
              inner.db,
              inner.userId,
              String(project.id),
              String(candidate.id),
              {
                examSpecVersion: spec,
                nodeIds: payload.node_ids,
                originType: payload.origin_type,
                displayLabel: payload.display_label,
              },
              inner.now,
            )
            // Stored with `question_id` (Django's idempotent result body); the wire projection
            // below drops it because `CandidateOut` does not declare it.
            const stored = {
              ...candidateSummary(inner.db, result.candidate),
              question_id: String(result.question.id),
            }
            return {
              status: 200,
              body: stored,
              resourceType: 'import_candidate',
              resourceId: String(candidate.id),
            }
          },
          () => payload,
          candidateOut,
        ) as (inner: RouteContext) => unknown
        return scoped(ctx)
      },
    },
    // O19
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/variants/propose`,
      handler: (ctx) => proposeVariantsRoute(ctx, deps),
    },
    // O20
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/variants`,
      handler: (ctx) => listVariants(ctx),
    },
  ]
}
