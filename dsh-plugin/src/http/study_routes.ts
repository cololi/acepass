/**
 * Study-structure routes the Web client calls but B3 never mounted.
 *
 * The services already existed (specs, syllabi, knowledge nodes, papers, revisions); only the HTTP
 * surface was missing, which is why the Settings/Knowledge/Reports pages answered 404 over both
 * transports. These handlers are pure adapters: validate the query shape, call the service, return
 * the service value. Idempotency scopes and payload fingerprints mirror `apps/exams/api.py` and
 * `apps/knowledge/api.py` exactly (the scope string is part of the replay contract).
 */
import type { Route } from './router.ts'
import { transaction } from '../store/db.ts'
import { IdempotencyConflict as StoreIdempotencyConflict, claim, recordResult } from '../store/idempotency.ts'
import { requireIdempotencyKey } from '../services/idempotency_key.ts'
import { IdempotencyConflictError, InvalidInput } from '../services/errors.ts'
import {
  confirmPaperRevision,
  createSpecVersion,
  createSyllabusVersion,
  getPaper,
  listPaperItems,
  listPapers,
  listSpecVersions,
  listSyllabusVersions,
  publishSpecVersion,
  publishSyllabusVersion,
  recordPaperCoverage,
  registerPaper,
  setEffectiveRevision,
} from '../services/exams.ts'
import { createNode, importOutline, listNodes, patchNode } from '../services/knowledge.ts'
import { confirmGrade, submitAttempt } from '../services/practice.ts'
import {
  assertItemNotInActiveVerification,
  deliveryHiddenForItem,
  gradeEventOf,
  gradePayload,
  verificationContentMap,
} from '../services/learning.ts'
import {
  assertRevealAllowed,
  expireDueMockExams,
  expireSessionIfDue,
  presentItem,
  recordRevealExposure,
  revealPayload,
  saveDraft,
} from '../services/sessions.ts'
import { formatPythonIso } from '../domain/instant.ts'
import { findOne, findRows } from '../store/repository.ts'
import { PurposeNotAllowed, ScopeViolation } from '../services/errors.ts'

const PREFIX = '/api/acepass'

function bodyRecord(ctx: { body: unknown }): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>
}

function optional(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  return value
}

/** One idempotent side effect, with the scope/payload contract Django records. */
function effect(
  scope: string | ((ctx: any) => string),
  handler: (ctx: any) => { status: number; body: unknown },
  payloadOf: (ctx: any) => unknown = (ctx) => ctx.body ?? {},
): (ctx: any) => unknown {
  return (ctx) => {
    const key = requireIdempotencyKey(ctx.headers)
    const routeScope = typeof scope === 'function' ? scope(ctx) : scope
    return transaction(ctx.db, () => {
      let replay: ReturnType<typeof claim>
      try {
        replay = claim(ctx.db, { userId: ctx.userId, routeScope, key, payload: payloadOf(ctx), now: ctx.now })
      } catch (error) {
        if (error instanceof StoreIdempotencyConflict) throw new IdempotencyConflictError(error.message)
        throw error
      }
      if (replay !== null) return { status: replay.statusCode, body: replay.body }
      const result = handler(ctx)
      recordResult(ctx.db, {
        userId: ctx.userId,
        routeScope,
        key,
        statusCode: result.status,
        responseBody: result.body,
        now: ctx.now,
      })
      return result
    })
  }
}

/**
 * `POST /session-items/{id}/submit` — the practice loop's write path.
 *
 * Django re-serialises a replay under the gate that applies *now* instead of returning the stored
 * body, so a practice attempt whose content has entered a verification answers a receipt rather
 * than the score it returned the first time. This handler does the same: the idempotency record
 * proves the effect happened once, but the response is always rebuilt from the stored attempt.
 */
function submitRoute(): Route {
  return {
    method: 'POST',
    pattern: `${PREFIX}/projects/:project_id/session-items/:item_id/submit`,
    handler: (ctx) => {
      const key = requireIdempotencyKey(ctx.headers)
      const itemId = ctx.params.item_id
      const scope = `items.submit:${itemId}`
      const serialise = (attemptId: string): { status: number; body: unknown } => {
        const attempt = findOne(ctx.db, 'practice_attempt', { id: attemptId })
        if (attempt === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
        const hidden = deliveryHiddenForItem(ctx.db, ctx.userId, itemId)
        const grade = attempt.current_grade_event_id === null ? null : gradeEventOf(ctx.db, String(attempt.current_grade_event_id))
        return {
          status: 200,
          body: {
            session_item_id: itemId,
            attempt_id: attemptId,
            grading_revision: Number(attempt.grading_revision),
            submitted_at: String(attempt.submitted_at),
            receipt_only: hidden,
            grade: hidden ? null : gradePayload(grade),
          },
        }
      }
      return transaction(ctx.db, () => {
        let replay: ReturnType<typeof claim>
        try {
          replay = claim(ctx.db, { userId: ctx.userId, routeScope: scope, key, payload: ctx.body ?? {}, now: ctx.now })
        } catch (error) {
          if (error instanceof StoreIdempotencyConflict) throw new IdempotencyConflictError(error.message)
          throw error
        }
        if (replay !== null) {
          const existing = findOne(ctx.db, 'practice_attempt', { session_item_id: itemId })
          if (existing === null) return { status: replay.statusCode, body: replay.body }
          return serialise(String(existing.id))
        }
        // Django's wire body names the answer `answer`; the service's internal payload names it
        // `raw_answer` (the grading engine's vocabulary). This is the one adapter point.
        const body = (ctx.body ?? {}) as Record<string, unknown>
        const rawAnswer = (body.answer ?? body.raw_answer) as Record<string, unknown> | undefined
        if (rawAnswer === undefined || typeof rawAnswer !== 'object' || rawAnswer === null) {
          throw new InvalidInput('作答必须是对象', { details: { loc: ['body', 'payload', 'answer'] } })
        }
        const result = submitAttempt(
          ctx.db,
          ctx.userId,
          itemId,
          {
            raw_answer: rawAnswer,
            steps: Array.isArray(body.steps) ? body.steps : [],
            confidence: typeof body.confidence === 'string' ? body.confidence : '',
            client_active_ms: typeof body.client_active_ms === 'number' ? body.client_active_ms : null,
            // Photos uploaded before submitting travel as `asset_ids`; the service validates
            // ownership/size and stores them on the attempt (Django `_validate_attachments`).
            asset_ids: Array.isArray(body.asset_ids) ? body.asset_ids.map(String) : [],
          },
          ctx.now,
        )
        const response = serialise(String(result.attempt.id))
        recordResult(ctx.db, {
          userId: ctx.userId,
          routeScope: scope,
          key,
          statusCode: response.status,
          responseBody: response.body,
          now: ctx.now,
        })
        return response
      })
    },
  }
}

/**
 * Owner-scoped item lookup for the practice write paths.
 *
 * Django's `_item_scope` answers 404 for an item of another user or another project; the distinction
 * matters because a 403 would confirm the id exists.
 */
function itemScope(ctx: { db: any; userId: string }, projectId: string, itemId: string): Record<string, unknown> {
  const item = findOne(ctx.db, 'practice_session_item', { id: itemId })
  if (item === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  const session = findOne(ctx.db, 'practice_session', { id: String(item.session_id) })
  if (session === null || String(session.user_id) !== String(ctx.userId) || String(session.project_id) !== String(projectId)) {
    throw new ScopeViolation('题项不存在或不在当前权限范围')
  }
  return item
}

/** `reveal` — the answer and explanation, gated exactly like Django's two reveal endpoints. */
function revealRoute(kind: 'item' | 'attempt'): Route {
  const pattern =
    kind === 'item'
      ? `${PREFIX}/projects/:project_id/session-items/:item_id/reveal`
      : `${PREFIX}/projects/:project_id/attempts/:attempt_id/reveal`
  return {
    method: 'POST',
    pattern,
    handler: (ctx) => {
      const projectId = ctx.params.project_id
      let item: Record<string, unknown>
      let beforeSubmit: boolean
      if (kind === 'item') {
        item = itemScope(ctx, projectId, ctx.params.item_id)
        const session = findOne(ctx.db, 'practice_session', { id: String(item.session_id) })!
        const reconciled = expireSessionIfDue(ctx.db, session, ctx.now)
        // C05: after the deadline the exam is over and its answers become readable.
        const attempt = findOne(ctx.db, 'practice_attempt', { session_item_id: String(item.id) })
        beforeSubmit = attempt === null
        assertRevealAllowed(reconciled, beforeSubmit)
      } else {
        const attempt = findOne(ctx.db, 'practice_attempt', { id: ctx.params.attempt_id })
        if (
          attempt === null ||
          String(attempt.project_id) !== String(projectId) ||
          String(attempt.user_id) !== String(ctx.userId)
        ) {
          throw new ScopeViolation('作答不存在或不在当前权限范围')
        }
        item = findOne(ctx.db, 'practice_session_item', { id: String(attempt.session_item_id) })!
        const session = findOne(ctx.db, 'practice_session', { id: String(item.session_id) })!
        const reconciled = expireSessionIfDue(ctx.db, session, ctx.now)
        beforeSubmit = false
        assertRevealAllowed(reconciled, false)
      }
      const session = findOne(ctx.db, 'practice_session', { id: String(item.session_id) })!
      // The same content may be part of a *different* running verification (another tab, another
      // project, a second session); that run's integrity does not depend on which endpoint asks.
      assertItemNotInActiveVerification(ctx.db, ctx.userId, item, '查看答案与解析')
      const payload = revealPayload(ctx.db, item)
      recordRevealExposure(
        ctx.db,
        ctx.userId,
        item,
        session,
        kind === 'item' ? 'session_item_reveal' : 'attempt_reveal',
        kind === 'item' ? { before_submit: beforeSubmit } : { after_submit: true },
        ctx.now,
      )
      return { ...payload, exposure_recorded: true }
    },
  }
}

/** `PUT /session-items/{id}/draft` — autosave with the revision the tab last saw. */
function draftRoute(): Route {
  return {
    method: 'PUT',
    pattern: `${PREFIX}/projects/:project_id/session-items/:item_id/draft`,
    handler: (ctx) => {
      const item = itemScope(ctx, ctx.params.project_id, ctx.params.item_id)
      // C05: reconcile outside the draft write. The service refuses a draft on a finished session by
      // raising, and that raise must not roll back the exam's own expiry.
      const session = findOne(ctx.db, 'practice_session', { id: String(item.session_id) })!
      expireSessionIfDue(ctx.db, session, ctx.now)
      const body = bodyRecord(ctx)
      const draft = body.draft
      if (draft === undefined || draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
        throw new InvalidInput('草稿必须是对象', { details: { loc: ['body', 'payload', 'draft'] } })
      }
      const revision = body.draft_revision
      if (revision !== undefined && revision !== null && typeof revision !== 'number') {
        throw new InvalidInput('draft_revision 必须是整数', { details: { loc: ['body', 'payload', 'draft_revision'] } })
      }
      return saveDraft(
        ctx.db,
        ctx.userId,
        ctx.params.item_id,
        draft as Record<string, unknown>,
        revision === undefined || revision === null ? null : Number(revision),
        ctx.now,
      )
    },
  }
}

/** `POST /attempts/{id}/confirm-grade` — manual confirmation, re-serialised under the current gate. */
function confirmGradeRoute(): Route {
  return {
    method: 'POST',
    pattern: `${PREFIX}/projects/:project_id/attempts/:attempt_id/confirm-grade`,
    handler: (ctx) => {
      const key = requireIdempotencyKey(ctx.headers)
      const attemptId = ctx.params.attempt_id
      const scope = `attempts.confirm:${attemptId}`
      const serialise = (): { status: number; body: unknown } => {
        const attempt = findOne(ctx.db, 'practice_attempt', { id: attemptId })
        if (attempt === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
        const item = findOne(ctx.db, 'practice_session_item', { id: String(attempt.session_item_id) })
        if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
        const session = findOne(ctx.db, 'practice_session', { id: String(item.session_id) })
        if (session === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
        const reconciled = expireSessionIfDue(ctx.db, session, ctx.now)
        const hidden =
          (reconciled.mode === 'verification' || reconciled.mode === 'mock_exam') && reconciled.status === 'active'
        if (hidden) {
          throw new PurposeNotAllowed('该内容正在验证中：为避免泄露答案，验证结束前不能读取评分。', {
            details: { reason: 'active_verification_content_gate', attempt_id: attemptId },
          })
        }
        const grade =
          attempt.current_grade_event_id === null
            ? null
            : gradeEventOf(ctx.db, String(attempt.current_grade_event_id))
        return { status: 200, body: { grade: gradePayload(grade) } }
      }
      return transaction(ctx.db, () => {
        let replay: ReturnType<typeof claim>
        try {
          replay = claim(ctx.db, { userId: ctx.userId, routeScope: scope, key, payload: ctx.body ?? {}, now: ctx.now })
        } catch (error) {
          if (error instanceof StoreIdempotencyConflict) throw new IdempotencyConflictError(error.message)
          throw error
        }
        // The replay re-serialises under the current gate and wraps it, exactly like Django.
        if (replay !== null) {
          const serialised = serialise()
          return { status: serialised.status, body: { grade: serialised.body } }
        }
        const body = bodyRecord(ctx)
        const parts = Array.isArray(body.parts) ? (body.parts as Record<string, unknown>[]) : []
        const confirmed = confirmGrade(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          attemptId,
          {
            parts,
            expected_grading_revision: Number(body.expected_grading_revision),
            answer_key_version_id:
              body.answer_key_version_id === undefined || body.answer_key_version_id === null
                ? null
                : String(body.answer_key_version_id),
            rubric_version_id:
              body.rubric_version_id === undefined || body.rubric_version_id === null
                ? null
                : String(body.rubric_version_id),
            comment: String(body.comment ?? ''),
          },
          ctx.now,
        )
        // Django answers `grade_payload(...)`, not the raw row: the client reads `is_correct`,
        // `superseded` and the decimal strings from that projection. The two score strings come from
        // the in-memory Decimal, so the first answer reads "6" exactly like Django's.
        const payload = gradePayload(confirmed.grade)!
        // Django answers the grade payload **directly** on the first call (the client reads
        // `confirmed.status`), but wraps it as `{grade: ...}` on an idempotent replay. That
        // inconsistency is the observed contract; 04 §P records it.
        const response = {
          status: 200,
          body: {
            ...payload,
            confirmed_score: confirmed.confirmedScore,
            pending_max_score: confirmed.pendingMaxScore,
          },
        }
        recordResult(ctx.db, {
          userId: ctx.userId,
          routeScope: scope,
          key,
          statusCode: response.status,
          responseBody: response.body,
          now: ctx.now,
        })
        return response
      })
    },
  }
}

/** `GET /grading-queue` — pending human confirmation, never a back door to a live verification. */
function gradingQueueRoute(): Route {
  return {
    method: 'GET',
    pattern: `${PREFIX}/projects/:project_id/grading-queue`,
    handler: (ctx) => {
      const projectId = ctx.params.project_id
      // C05: an exam the server has already closed must not keep its attempts out of the queue.
      expireDueMockExams(ctx.db, ctx.userId, ctx.now)
      const contentMap = verificationContentMap(ctx.db, ctx.userId)
      const coveringItemIds = new Set<string>()
      for (const ids of contentMap.values()) for (const id of ids) coveringItemIds.add(id)
      const subjectId = optional(ctx.query.get('subject_id'))
      const rawLimit = Number(ctx.query.get('limit') ?? '30')
      const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 30, 100))
      const rows = findRows(ctx.db, 'practice_attempt', { project_id: projectId })
        .map((attempt) => ({ attempt, grade: findOne(ctx.db, 'practice_grade_event', { id: String(attempt.current_grade_event_id ?? '') }) }))
        .filter(({ grade }) => grade !== null && grade.status === 'pending_review')
        .filter(({ attempt }) => {
          const item = findOne(ctx.db, 'practice_session_item', { id: String(attempt.session_item_id) })
          if (item === null) return false
          const session = findOne(ctx.db, 'practice_session', { id: String(item.session_id) })
          if (
            session !== null &&
            session.status === 'active' &&
            (session.mode === 'verification' || session.mode === 'mock_exam')
          ) {
            return false
          }
          const covering = contentMap.get(String(item.question_version_id))
          if (covering !== undefined && !coveringItemIds.has(String(item.id))) {
            // The same content is only covered by a *different* running run: keep it out.
            if ([...covering].every((id) => id !== String(item.id))) return false
          }
          if (subjectId !== null) {
            const version = findOne(ctx.db, 'question_bank_question_version', { id: String(item.question_version_id) })
            const question = version === null ? null : findOne(ctx.db, 'question_bank_question', { id: String(version.question_id) })
            if (question === null || String(question.subject_id) !== subjectId) return false
          }
          return true
        })
        .sort((a, b) => Number(b.attempt.submitted_at) - Number(a.attempt.submitted_at))
        .slice(0, limit)

      return rows.map(({ attempt, grade }) => {
        const item = findOne(ctx.db, 'practice_session_item', { id: String(attempt.session_item_id) })!
        const version = findOne(ctx.db, 'question_bank_question_version', { id: String(item.question_version_id) })!
        const question = findOne(ctx.db, 'question_bank_question', { id: String(version.question_id) })!
        let rubric: Record<string, unknown> | null = null
        if (item.rubric_version_id !== null && item.rubric_version_id !== undefined) {
          const rubricRow = findOne(ctx.db, 'question_bank_rubric_version', { id: String(item.rubric_version_id) })
          if (rubricRow !== null) {
            rubric = {
              rubric_version_id: String(rubricRow.id),
              criteria: rubricRow.criteria ?? [],
              total_score: String(rubricRow.total_score),
            }
          }
        }
        return {
          attempt_id: String(attempt.id),
          session_item_id: String(attempt.session_item_id),
          question_id: String(question.id),
          display_label: String(question.display_label ?? ''),
          question_type: String(version.question_type),
          subject_id: String(question.subject_id),
          submitted_at: formatPythonIso(attempt.submitted_at as any),
          grading_revision: Number(attempt.grading_revision),
          pending_max_score: grade!.pending_max_score === null ? '0' : String(grade!.pending_max_score),
          confirmed_score: grade!.confirmed_score === null ? null : String(grade!.confirmed_score),
          is_own_attempt: String(attempt.user_id) === String(ctx.userId),
          can_review_as_other: false,
          parts: grade!.parts ?? [],
          raw_answer: attempt.raw_answer ?? {},
          steps: attempt.steps ?? [],
          attachments: attempt.attachments ?? [],
          confidence: attempt.confidence,
          elapsed_ms: Number(attempt.elapsed_ms),
          rubric,
        }
      })
    },
  }
}

function practiceWriteRoutes(): Route[] {
  return [revealRoute('item'), revealRoute('attempt'), draftRoute(), confirmGradeRoute(), gradingQueueRoute()]
}

export function studyRoutes(): Route[] {
  return [
    submitRoute(),
    ...practiceWriteRoutes(),
    // ---- exam spec versions -------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/exam-spec-versions`,
      handler: (ctx) =>
        listSpecVersions(ctx.db, ctx.userId, ctx.params.project_id, {
          subjectId: optional(ctx.query.get('subject_id')),
        }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/exam-spec-versions`,
      handler: effect((ctx) => `specs.create:${ctx.params.project_id}`, (ctx) => ({
        status: 201,
        body: createSpecVersion(ctx.db, ctx.userId, ctx.params.project_id, bodyRecord(ctx) as never, ctx.now),
      })),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/exam-spec-versions/:spec_id/publish`,
      handler: effect(
        (ctx) => `specs.publish:${ctx.params.spec_id}`,
        (ctx) => ({
          status: 200,
          body: publishSpecVersion(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.spec_id, ctx.now),
        }),
        () => ({}),
      ),
    },
    // ---- syllabus versions --------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/syllabus-versions`,
      handler: (ctx) =>
        listSyllabusVersions(ctx.db, ctx.userId, ctx.params.project_id, {
          subjectId: optional(ctx.query.get('subject_id')),
        }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/syllabus-versions`,
      handler: effect((ctx) => `syllabus.create:${ctx.params.project_id}`, (ctx) => ({
        status: 201,
        body: createSyllabusVersion(ctx.db, ctx.userId, ctx.params.project_id, bodyRecord(ctx) as never, ctx.now),
      })),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/syllabus-versions/:syllabus_id/publish`,
      handler: effect(
        (ctx) => `syllabus.publish:${ctx.params.syllabus_id}`,
        (ctx) => ({
          status: 200,
          body: publishSyllabusVersion(
            ctx.db,
            ctx.userId,
            ctx.params.project_id,
            ctx.params.syllabus_id,
            ctx.now,
          ),
        }),
        () => ({}),
      ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/syllabus-versions/:syllabus_id/nodes/import`,
      handler: effect((ctx) => `nodes.import:${ctx.params.syllabus_id}`, (ctx) => ({
        status: 200,
        body: importOutline(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.syllabus_id,
          bodyRecord(ctx) as never,
          ctx.now,
        ),
      })),
    },
    // ---- knowledge nodes ----------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/knowledge-nodes`,
      handler: (ctx) =>
        listNodes(ctx.db, ctx.params.project_id, {
          syllabusVersionId: optional(ctx.query.get('syllabus_version_id')),
          subjectId: optional(ctx.query.get('subject_id')),
        }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/knowledge-nodes`,
      handler: effect((ctx) => `nodes.create:${ctx.params.project_id}`, (ctx) => ({
        status: 201,
        body: createNode(ctx.db, ctx.userId, ctx.params.project_id, bodyRecord(ctx) as never, ctx.now),
      })),
    },
    {
      method: 'PATCH',
      pattern: `${PREFIX}/projects/:project_id/knowledge-nodes/:node_id`,
      handler: (ctx) =>
        patchNode(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.node_id, bodyRecord(ctx) as never, ctx.now),
    },
    // ---- papers / revisions -------------------------------------------------------------------
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/papers`,
      handler: (ctx) =>
        listPapers(ctx.db, ctx.userId, ctx.params.project_id, {
          subjectId: optional(ctx.query.get('subject_id')),
        }),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/papers`,
      handler: effect((ctx) => `papers.register:${ctx.params.project_id}`, (ctx) => {
        const result = registerPaper(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          bodyRecord(ctx) as never,
          ctx.now,
        ) as { paper?: unknown; created?: boolean }
        // The service reports reuse explicitly; Django answers 201 only when the row was created.
        return { status: result.created === false ? 200 : 201, body: result.paper ?? result }
      }),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/papers/:paper_id`,
      handler: (ctx) => getPaper(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.paper_id),
    },
    {
      method: 'GET',
      pattern: `${PREFIX}/projects/:project_id/paper-revisions/:revision_id/items`,
      handler: (ctx) =>
        listPaperItems(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.revision_id),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/paper-revisions/:revision_id/coverage`,
      handler: (ctx) =>
        recordPaperCoverage(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.revision_id,
          bodyRecord(ctx) as never,
          ctx.now,
        ),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/paper-revisions/:revision_id/confirm`,
      handler: (ctx) =>
        confirmPaperRevision(ctx.db, ctx.userId, ctx.params.project_id, ctx.params.revision_id, ctx.now),
    },
    {
      method: 'POST',
      pattern: `${PREFIX}/projects/:project_id/papers/:paper_id/effective-revision`,
      handler: (ctx) => {
        const revisionId = ctx.query.get('revision_id') ?? ''
        if (revisionId.trim() === '') throw new InvalidInput('缺少 revision_id')
        return setEffectiveRevision(
          ctx.db,
          ctx.userId,
          ctx.params.project_id,
          ctx.params.paper_id,
          revisionId,
          ctx.now,
        )
      },
    },
  ]
}
