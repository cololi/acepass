/**
 * The HTTP surface: which services each route calls, and where idempotency applies.
 *
 * Paths are prefixed with `/api/acepass` because DSH only accepts exact Fetch routes under `/api`.
 * The Django paths are kept verbatim after that prefix so the web client's request code survives
 * the migration unchanged.
 *
 * Idempotency is applied exactly where the Django API applies it — the side-effecting POSTs that
 * carry an `Idempotency-Key` — and nowhere else, because claiming a key for a read would turn a
 * stale replay into a wrong answer.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Route, RouteContext } from './router.ts'
import { transaction } from '../store/db.ts'
import { findOne, findRows } from '../store/repository.ts'
import { IdempotencyConflict as StoreIdempotencyConflict, claim, recordResult } from '../store/idempotency.ts'
import { requireIdempotencyKey } from '../services/idempotency_key.ts'
import { getStudySettings, getUserOut, patchStudySettings } from '../services/accounts.ts'
import {
  archiveProject,
  createProject,
  createSubject,
  getProject,
  listProjects,
  listSubjects,
  unarchiveProject,
  updateProject,
} from '../services/exams.ts'
import {
  addQuestionToFamily,
  createFamily,
  familyPayload,
  listFamilies,
  mergeFamilies,
  mergeImpact,
  removeQuestionFromFamily,
  updateFamily,
} from '../services/families.ts'
import {
  createQuestionRevision,
  getQuestionPreview,
  getRubricVersion,
  listAnswerKeys,
  listQuestions,
  listSourceRegions,
  publishQuestionVersion,
  updateDraftVersion,
  versionPayload,
  withdrawQuestionVersion,
} from '../services/questions.ts'
import { listMappings, replaceKnowledgeMappings } from '../services/mappings.ts'
import {
  sealFamily,
  sealPayload,
  sealedContentReport,
  sealQuestion,
  unsealFamily,
  unsealQuestion,
} from '../services/sealing.ts'
import { createSession, finishSession, presentItem } from '../services/sessions.ts'
import { evidenceSummaryRows, getAttempt, getSession, listMistakes, listStates } from '../services/learning.ts'
import { generatePlan, planTasks } from '../services/planner.ts'
import { todayPayload } from '../services/learning_extra.ts'
import { IdempotencyConflictError, InvalidInput, ScopeViolation } from '../services/errors.ts'
import { ingestionRoutes, type IngestionRouteDeps } from './ingestion_routes.ts'
import { analyticsRoutes } from './analytics_routes.ts'
import { studyRoutes } from './study_routes.ts'
import { knowledgeExtraRoutes } from './knowledge_extra_routes.ts'
import { learningExtraRoutes } from './learning_extra_routes.ts'
import { memoryRoutes } from './memory_routes.ts'
import { searchRoutes } from './search_routes.ts'
import { tutorRoutes } from './tutor_routes.ts'
import { practiceAiRoutes } from './practice_ai_routes.ts'

const PREFIX = '/api/acepass'

function resource(
  scope: string,
  handler: (ctx: RouteContext) => { status: number; body: unknown },
  payloadOf: (ctx: RouteContext) => unknown = (ctx) => ctx.body ?? {},
): (ctx: RouteContext) => unknown {
  return (ctx) => {
    // Django requires the key for side-effecting requests; a missing key is a 409, not a 400.
    const key = requireIdempotencyKey(ctx.headers)
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
        // The store speaks in claim conflicts; the wire speaks `idempotency_conflict`.
        if (error instanceof StoreIdempotencyConflict) throw new IdempotencyConflictError(error.message)
        throw error
      }
      if (replay !== null) return { status: replay.statusCode, body: replay.body }
      // The claim and the effect share one transaction, so a failure rolls the claim back with it and
      // the retry with the same key is not blocked. (Python needs an explicit `release()` because its
      // claim is committed in its own savepoint; here the rollback is the release.)
      const result = handler(ctx)
      recordResult(ctx.db, {
        userId: ctx.userId,
        routeScope: scope,
        key,
        statusCode: result.status,
        responseBody: result.body,
        now: ctx.now,
      })
      return result
    })
  }
}

function numberOr(raw: string | null, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/** Query parameters are strings; an absent or malformed number falls back instead of becoming 0. */
function intQuery(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function findSessionsForProject(db: DatabaseSync, userId: string, projectId: string): unknown[] {
  return findRows(db, 'practice_session', { user_id: userId, project_id: projectId })
}

function bodyRecord(ctx: RouteContext): Record<string, any> {
  const body = ctx.body
  if (body === null || body === undefined) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw new InvalidInput('请求体必须是 JSON 对象')
  return body as Record<string, any>
}

/** `MappingIn` applies defaults in Django's schema; apply the same ones before the service sees it. */
function mappingItems(ctx: RouteContext): Record<string, unknown>[] {
  if (!Array.isArray(ctx.body)) throw new InvalidInput('映射必须是 JSON 数组')
  return ctx.body.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new InvalidInput('映射必须是 JSON 对象')
    }
    const record = item as Record<string, unknown>
    return {
      node_id: String(record.node_id ?? ''),
      is_primary: record.is_primary === undefined ? true : Boolean(record.is_primary),
      score_weight: record.score_weight === undefined ? '1' : String(record.score_weight),
      template_id: record.template_id === undefined ? null : record.template_id,
      note: record.note === undefined ? '' : String(record.note),
    }
  })
}

/** `_family_question_out` — the membership result plus the family's sealing decision. */
function familyQuestionOut(
  db: DatabaseSync,
  projectId: string,
  familyId: string,
  questionId: string,
  changed: boolean,
): Record<string, unknown> {
  const family = findOne(db, 'question_bank_family', { id: familyId })
  if (family === null) throw new ScopeViolation('题族不存在或不属于该项目')
  const payload = familyPayload(db, projectId, family)
  return {
    family_id: familyId,
    question_id: questionId,
    changed,
    member_count: payload.member_count,
    sealed: payload.sealed,
    sealed_reason: payload.sealed_reason,
  }
}

export function acepassRoutes(deps: IngestionRouteDeps = {}): Route[] {
  return [
    ...ingestionRoutes(deps),
    ...analyticsRoutes(),
    ...studyRoutes(),
    ...knowledgeExtraRoutes(deps),
    ...learningExtraRoutes(),
    ...memoryRoutes(),
    ...searchRoutes(),
    ...tutorRoutes(deps),
    ...practiceAiRoutes(deps),
    {
      method: 'GET',
      pattern: `${PREFIX}/auth/me`,
      handler: (ctx) => getUserOut(ctx.db, ctx.userId, ctx.now),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/me/study-settings`,
      handler: (ctx) => getStudySettings(ctx.db, ctx.userId, ctx.now),
    },
    {
      method: 'PATCH',
      pattern: `${PREFIX}/me/study-settings`,
      handler: (ctx) => patchStudySettings(ctx.db, ctx.userId, bodyRecord(ctx) as never, ctx.now),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects`,
      handler: (ctx) =>
        listProjects(ctx.db, ctx.userId, { includeArchived: ctx.query.get('include_archived') === 'true' }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects`,
      handler: resource('projects.create', (ctx) => ({
        status: 201,
        body: createProject(ctx.db, ctx.userId, bodyRecord(ctx) as never, ctx.now),
      })) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id`,
      handler: (ctx) => getProject(ctx.db, ctx.userId, ctx.params.project_id),
    },
    {
      method: 'PATCH',
      pattern: `${PREFIX}/projects/:project_id`,
      handler: (ctx) => updateProject(ctx.db, ctx.userId, ctx.params.project_id, bodyRecord(ctx) as never, ctx.now),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/archive`,
      handler: ((ctx) =>
        resource(`projects.archive:${ctx.params.project_id}`, (inner) => ({
          status: 200,
          body: archiveProject(inner.db, inner.userId, inner.params.project_id, {
            reason: String(bodyRecord(inner).reason ?? ''),
            now: inner.now,
          }),
        }))(ctx)) as Route['handler'],
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/unarchive`,
      handler: ((ctx) =>
        resource(`projects.unarchive:${ctx.params.project_id}`, (inner) => ({
          status: 200,
          body: unarchiveProject(inner.db, inner.userId, inner.params.project_id, inner.now),
        }))(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/subjects`,
      handler: (ctx) => listSubjects(ctx.db, ctx.userId, ctx.params.project_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/subjects`,
      handler: ((ctx) =>
        resource(`subjects.create:${ctx.params.project_id}`, (inner) => ({
          status: 201,
          body: createSubject(inner.db, inner.userId, inner.params.project_id, bodyRecord(inner) as never, inner.now),
        }))(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/question-families`,
      handler: (ctx) =>
        listFamilies(ctx.db, ctx.params.project_id, { subjectId: ctx.query.get('subject_id') }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-families`,
      handler: ((ctx) =>
        resource(`question_families.create:${ctx.params.project_id}`, (inner) => {
          const body = bodyRecord(inner)
          return {
            status: 201,
            body: createFamily(inner.db, {
              projectId: inner.params.project_id,
              actorId: inner.userId,
              subjectId: String(body.subject_id ?? ''),
              name: String(body.name ?? ''),
              note: String(body.note ?? ''),
              now: inner.now,
            }),
          }
        })(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/practice-sessions`,
      handler: (ctx) =>
        findSessionsForProject(ctx.db, ctx.userId, ctx.params.project_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/practice-sessions`,
      handler: ((ctx) =>
        resource(`practice_sessions.create:${ctx.params.project_id}`, (inner) => {
          const created = createSession(
            inner.db,
            inner.userId,
            inner.params.project_id,
            bodyRecord(inner) as never,
            inner.now,
          )
          // POST answers with the same `SessionOut` snapshot GET returns: the raw row carries `id`,
          // and a client that reads `session_id` would navigate to `/practice-sessions/undefined`.
          return {
            status: 201,
            body: getSession(inner.db, inner.userId, inner.params.project_id, String(created.id), inner.now),
          }
        })(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/practice-sessions/:session_id`,
      handler: (ctx) =>
        getSession(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.session_id, ctx.now),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/practice-sessions/:session_id/finish`,
      handler: (ctx) => {
        finishSession(ctx.db, ctx.userId, ctx.params.session_id, ctx.now)
        // Django answers the finished `SessionOut`, not the raw row: the exam page reads the
        // result out of the same snapshot it polls.
        return getSession(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.session_id, ctx.now)
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/session-items/:item_id/presentation`,
      handler: (ctx) => presentItem(ctx.db, ctx.userId, ctx.params.item_id, ctx.now),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id`,
      handler: (ctx) => getAttempt(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.attempt_id, ctx.now),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/evidence`,
      handler: (ctx) => ({
        rule_version: 'p2-c04',
        rows: evidenceSummaryRows(ctx.db, ctx.userId, ctx.params.project_id, {
          nodeId: ctx.query.get('node_id'),
          subjectId: ctx.query.get('subject_id'),
          dimension: ctx.query.get('dimension'),
          limit: numberOr(ctx.query.get('limit'), 100),
        }),
        count: 0,
      }),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/learning-states`,
      handler: (ctx) =>
        listStates(ctx.db, ctx.userId, ctx.params.project_id, { subjectId: ctx.query.get('subject_id') }),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/mistakes`,
      handler: (ctx) =>
        listMistakes(ctx.db, ctx.userId, ctx.params.project_id, {
          subjectId: ctx.query.get('subject_id'),
          limit: numberOr(ctx.query.get('limit'), 100),
        }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/study-plans/today/generate`,
      handler: ((ctx) =>
        resource('study_plans.generate', (inner) => {
          const body = bodyRecord(inner)
          generatePlan(inner.db, inner.userId, {
            // Django's schema field is `plan_date`; `on_date` stays accepted as the earlier alias.
            onDate: ((body.plan_date ?? body.on_date) as string | undefined) ?? null,
            refresh: bodyRecord(inner).refresh === true,
            now: inner.now,
          })
          // Django answers `TodayPlanOut` (the plan plus backlog and progress notes), not the raw
          // plan row: the today page reads `plan.daily_budget_minutes` out of this response.
          return { status: 200, body: todayPayload(inner.db, inner.userId, inner.now) }
        })(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/plans/:plan_id/tasks`,
      handler: (ctx) => planTasks(ctx.db, ctx.params.plan_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id/revisions`,
      handler: ((ctx) =>
        resource(`questions.revision:${ctx.params.question_id}`, (inner) => ({
          status: 201,
          body: versionPayload(
            createQuestionRevision(
              inner.db,
              inner.userId,
              inner.params.project_id,
              inner.params.question_id,
              bodyRecord(inner) as never,
              inner.now,
            ),
          ),
        }))(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/questions`,
      handler: (ctx) =>
        listQuestions(ctx.db, ctx.params.project_id, {
          subjectId: ctx.query.get('subject_id'),
          questionType: ctx.query.get('question_type'),
          status: ctx.query.get('status'),
          originType: ctx.query.get('origin_type'),
          search: ctx.query.get('search'),
          limit: intQuery(ctx.query.get('limit'), 20),
          offset: intQuery(ctx.query.get('offset'), 0),
        }),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id`,
      handler: (ctx) =>
        getQuestionPreview(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.question_id, ctx.now),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id/answer-keys`,
      handler: (ctx) => listAnswerKeys(ctx.db, ctx.params.project_id, ctx.params.question_id),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id/source-regions`,
      handler: (ctx) => listSourceRegions(ctx.db, ctx.params.project_id, ctx.params.question_id),
    },
    {
      method: 'PATCH',
      pattern: `${PREFIX}/projects/:project_id/question-versions/:version_id`,
      handler: (ctx) =>
        versionPayload(
          updateDraftVersion(
            ctx.db,
            ctx.userId,
            ctx.params.project_id,
            ctx.params.version_id,
            bodyRecord(ctx) as never,
            { now: ctx.now },
          ),
        ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-versions/:version_id/publish`,
      handler: ((ctx) =>
        resource(
          `versions.publish:${ctx.params.version_id}`,
          (inner) => ({
            status: 200,
            body: versionPayload(
              publishQuestionVersion(
                inner.db,
                inner.userId,
                inner.params.project_id,
                inner.params.version_id,
                { now: inner.now },
              ),
            ),
          }),
          () => ({}),
        )(ctx)) as Route['handler'],
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-versions/:version_id/withdraw`,
      handler: ((ctx) =>
        resource(
          `versions.withdraw:${ctx.params.version_id}`,
          (inner) => ({
            status: 200,
            body: versionPayload(
              withdrawQuestionVersion(
                inner.db,
                inner.userId,
                inner.params.project_id,
                inner.params.version_id,
                { reason: inner.query.get('reason') ?? '', now: inner.now },
              ),
            ),
          }),
          // Django's `reason` is a query parameter on this POST, so it is what the
          // idempotency fingerprint must cover — not the (empty) body.
          (inner) => ({ reason: inner.query.get('reason') ?? '' }),
        )(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/question-versions/:version_id/mappings`,
      handler: (ctx) => {
        const raw = ctx.query.get('revision')
        const revision = raw === null || raw.trim() === '' ? null : Number(raw)
        return listMappings(ctx.db, ctx.params.project_id, ctx.params.version_id, {
          revision: Number.isFinite(revision) ? revision : null,
        })
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-versions/:version_id/mappings`,
      handler: ((ctx) =>
        resource(`mappings.replace:${ctx.params.version_id}`, (inner) => ({
          status: 201,
          body: replaceKnowledgeMappings(
            inner.db,
            inner.params.project_id,
            inner.params.version_id,
            mappingItems(inner) as never,
            { actorId: inner.userId, now: inner.now },
          ),
        }))(ctx)) as Route['handler'],
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/rubric-versions/:rubric_id`,
      handler: (ctx) => getRubricVersion(ctx.db, ctx.params.project_id, ctx.params.rubric_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id/seal`,
      handler: (ctx) => ({
        status: 201,
        body: sealPayload(
          ctx.db,
          ctx.params.project_id,
          sealQuestion(ctx.db, {
            projectId: ctx.params.project_id,
            questionId: ctx.params.question_id,
            actorId: ctx.userId,
            reason: String(bodyRecord(ctx).reason ?? ''),
            now: ctx.now,
          }),
        ),
      }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/questions/:question_id/unseal`,
      handler: (ctx) => ({
        status: 201,
        body: sealPayload(
          ctx.db,
          ctx.params.project_id,
          unsealQuestion(ctx.db, {
            projectId: ctx.params.project_id,
            questionId: ctx.params.question_id,
            actorId: ctx.userId,
            reason: String(bodyRecord(ctx).reason ?? ''),
            now: ctx.now,
          }),
        ),
      }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-families/:family_id/seal`,
      handler: (ctx) => ({
        status: 201,
        body: sealPayload(
          ctx.db,
          ctx.params.project_id,
          sealFamily(ctx.db, {
            projectId: ctx.params.project_id,
            familyId: ctx.params.family_id,
            actorId: ctx.userId,
            reason: String(bodyRecord(ctx).reason ?? ''),
            now: ctx.now,
          }),
        ),
      }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-families/:family_id/unseal`,
      handler: (ctx) => ({
        status: 201,
        body: sealPayload(
          ctx.db,
          ctx.params.project_id,
          unsealFamily(ctx.db, {
            projectId: ctx.params.project_id,
            familyId: ctx.params.family_id,
            actorId: ctx.userId,
            reason: String(bodyRecord(ctx).reason ?? ''),
            now: ctx.now,
          }),
        ),
      }),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/sealed-content`,
      handler: (ctx) => sealedContentReport(ctx.db, ctx.params.project_id),
    },
    {
      method: 'PATCH',
      pattern: `${PREFIX}/projects/:project_id/question-families/:family_id`,
      handler: (ctx) => {
        const body = bodyRecord(ctx)
        return updateFamily(ctx.db, {
          projectId: ctx.params.project_id,
          actorId: ctx.userId,
          familyId: ctx.params.family_id,
          name: body.name === undefined ? null : String(body.name),
          relationConfirmed: body.relation_confirmed === undefined ? null : Boolean(body.relation_confirmed),
          note: body.note === undefined ? null : String(body.note),
          now: ctx.now,
        })
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-families/:family_id/questions`,
      handler: ((ctx) =>
        resource(`question_families.add:${ctx.params.family_id}`, (inner) => {
          const body = bodyRecord(inner)
          const result = addQuestionToFamily(inner.db, {
            projectId: inner.params.project_id,
            actorId: inner.userId,
            familyId: inner.params.family_id,
            questionId: String(body.question_id ?? ''),
            now: inner.now,
          })
          return {
            status: 201,
            body: familyQuestionOut(
              inner.db,
              inner.params.project_id,
              inner.params.family_id,
              String(body.question_id ?? ''),
              result.changed,
            ),
          }
        })(ctx)) as Route['handler'],
    },
    {
      method: 'DELETE',
      pattern: `${PREFIX}/projects/:project_id/question-families/:family_id/questions/:question_id`,
      handler: (ctx) => {
        const result = removeQuestionFromFamily(ctx.db, {
          projectId: ctx.params.project_id,
          actorId: ctx.userId,
          familyId: ctx.params.family_id,
          questionId: ctx.params.question_id,
          now: ctx.now,
        })
        return familyQuestionOut(
          ctx.db,
          ctx.params.project_id,
          ctx.params.family_id,
          ctx.params.question_id,
          result.changed,
        )
      },
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/question-families/:family_id/merge-impact`,
      handler: (ctx) => {
        const targetId = ctx.query.get('target_family_id')
        if (targetId === null || targetId.trim() === '') throw new InvalidInput('必须指定目标家族')
        return mergeImpact(ctx.db, ctx.params.project_id, ctx.params.family_id, targetId)
      },
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/question-families/:family_id/merge`,
      handler: ((ctx) =>
        resource(`question_families.merge:${ctx.params.family_id}`, (inner) => {
          const body = bodyRecord(inner)
          return {
            status: 201,
            body: mergeFamilies(
              inner.db,
              inner.userId,
              inner.params.project_id,
              inner.params.family_id,
              String(body.target_family_id ?? ''),
              { reason: String(body.reason ?? ''), now: inner.now },
            ),
          }
        })(ctx)) as Route['handler'],
    },
  ]
}
