/**
 * HTTP surface for analytics and regrades: the nine operations of `backend/apps/analytics/api.py`.
 *
 * It lives beside `ingestion_routes.ts` rather than inside `routes.ts` because the two differ in a
 * way that matters: every regrade write carries Django's idempotency contract (trimmed key, 200
 * code-point limit, `IdempotencyConflict` with `details.route_scope/reason`), and the report paths
 * have query parameters whose parse errors must look like Ninja's `invalid_input` envelope.
 *
 * The paths keep the Django form after `/api/acepass`; they contain `:param` segments, which DSH's
 * exact-path Fetch registry cannot mount (03 §3), so the in-process `Request`→`Response` surface is
 * what the batch tests drive.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Route, RouteContext } from './router.ts'
import { transaction } from '../store/db.ts'
import { findOne } from '../store/repository.ts'
import { claim, recordResult } from '../store/idempotency.ts'
import { IdempotencyConflict as StoreIdempotencyConflict } from '../store/idempotency.ts'
import { pyCodePointLen } from '../domain/ingestion/pystring.ts'
import { pyStrip } from '../domain/pytext.ts'
import { IdempotencyConflictError, InvalidInput, ScopeViolation } from '../services/errors.ts'
import { requireProject, requireSubject } from '../services/exams.ts'
import {
  buildPracticeReport,
  coverageCompletion,
  listSnapshots,
  paperCoverage,
} from '../services/analytics.ts'
import { buildEffectCalibration } from '../services/calibration.ts'
import { cycleAnalysis } from '../services/cycles.ts'
import {
  executeRegradeRun,
  pendingAnswerReviews,
  regradePayload,
  requestRegrade,
} from '../services/regrade_runs.ts'

const PREFIX = '/api/acepass'

interface SchemaIssue {
  type: string
  loc: Array<string | number>
  msg: string
}

function schemaError(issues: SchemaIssue[]): InvalidInput {
  return new InvalidInput('请求参数校验失败', { details: { errors: issues } })
}

function missingField(loc: Array<string | number>): SchemaIssue {
  return { type: 'missing', loc, msg: 'Field required' }
}

function stringType(loc: Array<string | number>): SchemaIssue {
  return { type: 'string_type', loc, msg: 'Input should be a valid string' }
}

function intParsing(loc: Array<string | number>): SchemaIssue {
  return { type: 'int_parsing', loc, msg: 'Input should be a valid integer, unable to parse string as an integer' }
}

function boolParsing(loc: Array<string | number>): SchemaIssue {
  return {
    type: 'bool_parsing',
    loc,
    msg: 'Input should be a valid boolean, unable to interpret input',
  }
}

const TRUE_STRINGS = new Set(['true', '1', 'yes', 'on', 't', 'y'])
const FALSE_STRINGS = new Set(['false', '0', 'no', 'off', 'f', 'n'])

/** Pydantic's lax bool: the eight documented words in any case — whitespace is *not* stripped. */
function parseBoolQuery(raw: string, name: string): boolean {
  const value = raw.toLowerCase()
  if (TRUE_STRINGS.has(value)) return true
  if (FALSE_STRINGS.has(value)) return false
  throw schemaError([boolParsing(['query', name])])
}

/**
 * Pydantic's lax int from a query string.
 *
 * Measured against the installed pydantic: surrounding whitespace, a sign, single underscores
 * between digits (`1_000`) and an integral decimal string (`"1.0"`) are accepted; `"1.5"`,
 * `"1e3"` and `"0x10"` are not. Reproducing the accepted set matters because a rejected query is
 * a 400 with a `loc` the client may surface.
 */
function parseIntQuery(raw: string, name: string): number {
  const value = pyStrip(raw)
  if (/^[+-]?\d(?:_?\d)*$/.test(value)) return Number(value.replaceAll('_', ''))
  if (/^[+-]?\d+\.0+$/.test(value)) return Number(value.slice(0, value.indexOf('.')))
  throw schemaError([intParsing(['query', name])])
}

function intQueryOr(ctx: RouteContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name)
  if (raw === null) return fallback
  return parseIntQuery(raw, name)
}

/** `payload: RegradeIn` — defaults applied exactly as `model_dump(mode="json")` would. */
function regradeBody(ctx: RouteContext): Record<string, unknown> {
  const body = ctx.body
  if (body === null || body === undefined) throw schemaError([missingField(['body', 'payload'])])
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw schemaError([{ type: 'dict_type', loc: ['body', 'payload'], msg: 'Input should be a valid dictionary' }])
  }
  const record = body as Record<string, unknown>
  const issues: SchemaIssue[] = []
  const required = (name: string): string => {
    const value = record[name]
    if (value === undefined) {
      issues.push(missingField(['body', 'payload', name]))
      return ''
    }
    if (typeof value !== 'string') {
      issues.push(stringType(['body', 'payload', name]))
      return ''
    }
    return value
  }
  const questionId = required('question_id')
  const answerId = required('target_answer_key_version_id')
  const reason = required('reason')
  let rubricId: string | null = null
  const rawRubric = record['target_rubric_version_id']
  if (rawRubric !== undefined && rawRubric !== null) {
    if (typeof rawRubric !== 'string') issues.push(stringType(['body', 'payload', 'target_rubric_version_id']))
    else rubricId = rawRubric
  }
  let scope = 'all_attempts'
  const rawScope = record['scope']
  if (rawScope !== undefined) {
    if (typeof rawScope !== 'string') issues.push(stringType(['body', 'payload', 'scope']))
    else scope = rawScope
  }
  if (issues.length > 0) throw schemaError(issues)
  return {
    question_id: questionId,
    target_answer_key_version_id: answerId,
    target_rubric_version_id: rubricId,
    reason,
    scope,
  }
}

/** Django's `idempotency_key`: trim, non-empty, at most 200 code points, 409 on violation. */
function idempotencyKey(ctx: RouteContext): string {
  const key = pyStrip(ctx.headers.get('idempotency-key') ?? '')
  if (key === '') throw new IdempotencyConflictError('缺少 Idempotency-Key 请求头')
  if (pyCodePointLen(key) > 200) throw new IdempotencyConflictError('Idempotency-Key 过长')
  return key
}

/**
 * Claim + effect + result in one transaction, with Django's conflict details.
 *
 * The claim and the side effect share the SQLite transaction, so a rejected request rolls its
 * claim back (the equivalent of Django's middleware `release()`), and a retry with the same key
 * behaves exactly like the original.
 */
function regradeResource<Prepared>(
  prepare: (ctx: RouteContext) => Prepared,
  scopeOf: (ctx: RouteContext, prepared: Prepared) => string,
  handler: (ctx: RouteContext, prepared: Prepared) => { status: number; body: unknown; resourceId?: string },
  payloadOf: (ctx: RouteContext, prepared: Prepared) => unknown,
): Route['handler'] {
  return (ctx) => {
    // Django resolves the path object and body *before* it reads the idempotency key, so an
    // unknown project is a 404 even when the key is missing.
    const prepared = prepare(ctx)
    const key = idempotencyKey(ctx)
    const scope = scopeOf(ctx, prepared)
    return transaction(ctx.db, () => {
      let replay: ReturnType<typeof claim>
      try {
        replay = claim(ctx.db, {
          userId: ctx.userId,
          routeScope: scope,
          key,
          payload: payloadOf(ctx, prepared),
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
      if (replay !== null) return { status: replay.statusCode, body: replay.body }
      const result = handler(ctx, prepared)
      recordResult(ctx.db, {
        userId: ctx.userId,
        routeScope: scope,
        key,
        statusCode: result.status,
        responseBody: result.body,
        resourceType: 'regrade_run',
        resourceId: result.resourceId,
        now: ctx.now,
      })
      return result
    })
  }
}

/** `ReportOut` field order; the wire shape is the schema, not the service dict's insertion order. */
function practiceReportOut(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    report_kind: payload['report_kind'],
    calculation_version: payload['calculation_version'],
    as_of: payload['as_of'],
    project_id: payload['project_id'],
    subject_id: payload['subject_id'],
    totals: payload['totals'],
    by_question_type: payload['by_question_type'],
    by_knowledge_node: payload['by_knowledge_node'],
    excluded_evidence: payload['excluded_evidence'],
    notes: payload['notes'],
    hidden_verification_attempts: payload['hidden_verification_attempts'],
    hidden_verification_content_attempts: payload['hidden_verification_content_attempts'],
    result_status: payload['result_status'],
    incomplete_scope: payload['incomplete_scope'],
    aggregate: payload['aggregate'],
    final_result: payload['final_result'],
  }
}

/** `RegradeOut` field order (the schema, not the service dict's insertion order). */
function regradeOut(run: Record<string, unknown>): Record<string, unknown> {
  return {
    regrade_run_id: run['regrade_run_id'],
    status: run['status'],
    question_id: run['question_id'],
    target_answer_key_version_id: run['target_answer_key_version_id'],
    target_rubric_version_id: run['target_rubric_version_id'],
    scope: run['scope'],
    reason: run['reason'],
    generation: run['generation'],
    affected_attempts: run['affected_attempts'],
    regraded_attempts: run['regraded_attempts'],
    stale_skipped_attempts: run['stale_skipped_attempts'],
    invalidated_evidence: run['invalidated_evidence'],
    error_message: run['error_message'],
    created_at: run['created_at'],
    finished_at: run['finished_at'],
  }
}

function runOf(db: DatabaseSync, projectId: string, runId: string): Record<string, unknown> {
  const run = findOne(db, 'analytics_regrade_run', { id: runId, project_id: projectId })
  if (run === null) throw new ScopeViolation('重判任务不存在或不属于该项目')
  return run
}

export function analyticsRoutes(): Route[] {
  return [
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/reports/practice`,
      handler: (ctx) => {
        const subjectId = ctx.query.get('subject_id')
        const rawSave = ctx.query.get('save_snapshot')
        const saveSnapshot = rawSave === null ? true : parseBoolQuery(rawSave, 'save_snapshot')
        const report = buildPracticeReport(ctx.db, ctx.userId, ctx.params.project_id!, {
          // `if subject_id:` — an empty query value is falsy in Python, so it means "all subjects".
          subjectId: subjectId === null || subjectId === '' ? null : subjectId,
          saveSnapshot,
          now: ctx.now,
        })
        return practiceReportOut(report)
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/reports/calibration`,
      handler: (ctx) => {
        const subjectId = ctx.query.get('subject_id')
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id!)
        if (subjectId !== null && subjectId !== '') requireSubject(ctx.db, ctx.userId, String(project.id), subjectId)
        return buildEffectCalibration(ctx.db, ctx.userId, String(project.id), {
          subjectId: subjectId === null || subjectId === '' ? null : subjectId,
          now: ctx.now,
        })
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/reports/snapshots`,
      handler: (ctx) => {
        const limit = intQueryOr(ctx, 'limit', 10)
        return listSnapshots(ctx.db, ctx.userId, ctx.params.project_id!, { limit })
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/papers/cycle-analysis`,
      handler: (ctx) => {
        const rawSubject = ctx.query.get('subject_id')
        if (rawSubject === null) throw schemaError([missingField(['query', 'subject_id'])])
        const rawMax = ctx.query.get('max_cycles')
        const maxCycles = rawMax === null ? 5 : parseIntQuery(rawMax, 'max_cycles')
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id!)
        const subject = requireSubject(ctx.db, ctx.userId, String(project.id), rawSubject)
        return cycleAnalysis(ctx.db, String(subject.id), { maxCycles: Math.max(1, Math.min(intOr(maxCycles, 5), 10)) })
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/papers/coverage`,
      handler: (ctx) => {
        const rawSubject = ctx.query.get('subject_id')
        if (rawSubject === null) throw schemaError([missingField(['query', 'subject_id'])])
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id!)
        const subject = requireSubject(ctx.db, ctx.userId, String(project.id), rawSubject)
        const papers = paperCoverage(ctx.db, String(subject.id))
        return {
          subject_id: String(subject.id),
          coverage_note:
            'P0 只登记真实发生记录与完整性标记，不做年度占比统计；' +
            '缺少预期场次时周期为 coverage_unknown，不冒充完整年度。',
          papers,
          completion: coverageCompletion(ctx.db, String(subject.id), papers),
        }
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/regrades`,
      handler: regradeResource(
        (ctx) => {
          const body = regradeBody(ctx)
          const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id!)
          const question = findOne(ctx.db, 'question_bank_question', {
            id: String(body['question_id']),
          })
          const questionSubject =
            question === null ? null : findOne(ctx.db, 'exams_subject', { id: String(question.subject_id) })
          if (question === null || questionSubject === null || String(questionSubject.project_id) !== String(project.id)) {
            throw new ScopeViolation('题目不存在或不属于该项目')
          }
          const answer = findOne(ctx.db, 'question_bank_answer_key_version', {
            id: String(body['target_answer_key_version_id']),
          })
          const answerVersion =
            answer === null ? null : findOne(ctx.db, 'question_bank_question_version', {
              id: String(answer.question_version_id),
            })
          if (answer === null || answerVersion === null || String(answerVersion.question_id) !== String(question.id)) {
            throw new ScopeViolation('目标答案版本不存在或不属于该题目')
          }
          if (body['target_rubric_version_id'] !== null) {
            const rubric = findOne(ctx.db, 'question_bank_rubric_version', {
              id: String(body['target_rubric_version_id']),
            })
            if (rubric === null || String(rubric.answer_key_version_id) !== String(answer.id)) {
              throw new ScopeViolation('目标 rubric 不存在或不属于该答案版本')
            }
          }
          if (pyStrip(String(body['reason'])) === '') throw new InvalidInput('重判必须说明原因')
          return { body, question, answer }
        },
        (ctx) => `regrades.create:${ctx.params.project_id}`,
        (ctx, prepared) => {
          const run = requestRegrade(ctx.db, {
            questionId: String(prepared.question.id),
            targetAnswerKeyVersionId: String(prepared.answer.id),
            targetRubricVersionId: prepared.body['target_rubric_version_id'] as string | null,
            actorId: ctx.userId,
            reason: String(prepared.body['reason']),
            scope: String(prepared.body['scope']),
            now: ctx.now,
          })
          return { status: 201, body: regradeOut(regradePayload(run)), resourceId: String(run.id) }
        },
        (_ctx, prepared) => prepared.body,
      ),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/regrades/:regrade_id`,
      handler: (ctx) => {
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id!)
        const run = runOf(ctx.db, String(project.id), ctx.params.regrade_id!)
        return regradeOut(regradePayload(run))
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/regrades/:regrade_id/run`,
      handler: regradeResource(
        (ctx) => {
          const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id!)
          return { project, run: runOf(ctx.db, String(project.id), ctx.params.regrade_id!) }
        },
        (ctx) => `regrades.run:${ctx.params.regrade_id}`,
        (ctx, prepared) => {
          executeRegradeRun(ctx.db, String(prepared.run.id), ctx.now)
          const refreshed = runOf(ctx.db, String(prepared.project.id), String(prepared.run.id))
          return { status: 200, body: regradeOut(regradePayload(refreshed)), resourceId: String(prepared.run.id) }
        },
        () => ({}),
      ),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/answer-reviews`,
      handler: (ctx) => {
        const project = requireProject(ctx.db, ctx.userId, ctx.params.project_id!)
        return pendingAnswerReviews(ctx.db, String(project.id))
      },
    },
  ]
}

/** Python `int(max_cycles or 5)`: zero is falsy and falls back to the default. */
function intOr(value: number, fallback: number): number {
  return value === 0 ? fallback : value
}
