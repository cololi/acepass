/**
 * Learning read/write surface B7 never mounted: the today plan payload, the review queue and the
 * study-task lifecycle.
 *
 * Port of the parts of `backend/apps/learning/api.py` + `services/planner.py` + `services/pairing.py`
 * that the Web client calls but the phase-3 whitelist still held:
 *
 *  - `GET /study-plans/today` — the `TodayPlanOut` projection (`plan_payload` + backlog + notes);
 *  - `GET /projects/{id}/review-tasks` — delayed checks with their *recomputed* interval status;
 *  - `POST /study-tasks/{id}/start|defer|skip|complete` and `GET /study-tasks/{id}`.
 *
 * Two rules are the reason this is not a set of thin row reads:
 *
 *  1. **the stored `not_before` is not trusted on its own.** A later training event on the same
 *     knowledge node legitimately pushes a delayed check forward (B04), so `delayedIntervalStatus`
 *     re-derives the deadline from the same anchor the evidence projection uses, and a task can
 *     therefore be unstartable even though the stored timestamp has passed. A task with no anchor
 *     at all stays unstartable too: "we forgot to store a deadline" must not become "no delay".
 *  2. **a sealed question is never shown as part of today's plan**, and `start` refuses it after
 *     marking the task invalidated — the same single resolver (`services/sealing.ts`) every other
 *     path uses.
 *
 * The planner itself (`generatePlan`/`currentPlan`/`planTasks`) is reused verbatim; this module only
 * adds the wire projection and the task lifecycle that were missing.
 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import { latestLearningAnchor } from '../domain/anchors.ts'
import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { findOne, findRows, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { loadAnchorFacts } from './evidence_rebuild.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import { requireProject, requireSubject } from './exams.ts'
import { getStudySettings } from './accounts.ts'
import { delayedIntervalStatus, type DelayIntervalStatus } from './pairing.ts'
import { currentPlan, eligibility, localDateIn, planTasks } from './planner.ts'
import { sealedQuestionIds } from './sealing.ts'

/**
 * `delayed_interval_status` has exactly one implementation: `services/pairing.ts`. It owns the
 * pairing anchor math and the Python-exact `{remaining:.2f}` sentence, so duplicating it here only
 * risked the two copies drifting (the previous copy rounded with `toFixed`).
 *
 * Re-exported so this module's callers — the review-queue projection, the today payload and
 * `services/sessions.ts` — keep the import path they already use.
 */
export { delayedIntervalStatus }

const US_PER_HOUR = 3_600_000_000n

const TASK_PENDING = 'pending'
const TASK_DEFERRED = 'deferred'
const TASK_COMPLETED = 'completed'
const TASK_SKIPPED = 'skipped'
const TASK_INVALIDATED = 'invalidated'
const TASK_IN_PROGRESS = 'in_progress'
const TASK_KIND_DELAYED = 'delayed_verification'

/** `TASK_KIND_MODES`: task kinds that are checks, not practice. The server fixes their mode. */
const TASK_KIND_MODES: Readonly<Record<string, string>> = {
  delayed_verification: 'verification',
  paired_immediate: 'verification',
  weakness_repair: 'practice',
  undiagnosed_probe: 'practice',
  general_practice: 'practice',
}

/**
 * `resolve_task_mode`: the *task's* purpose decides the session mode, not the client's wish.
 *
 * Exported because the session-creation path needs the same decision; downgrading a delayed check to
 * `practice` would hand the learner the answer and make the "delayed" evidence meaningless.
 */
export function resolveTaskMode(taskKind: string | null | undefined, mode: string): string {
  if (taskKind === null || taskKind === undefined) return mode
  return TASK_KIND_MODES[taskKind] ?? mode
}

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : formatPythonIso(value as Instant)

function reviewOf(db: DatabaseSync, taskId: string): Record<string, unknown> | null {
  return findOne(db, 'learning_review_task', { study_task_id: taskId })
}

/**
 * `_anchor_for`: the latest completed related learning event, or the "current event" fallback.
 *
 * Falls back to `before` when nothing related ever happened — Django's behavior — which keeps a
 * task created without a derivable anchor from ever counting as "due".
 */
function anchorFor(
  db: DatabaseSync,
  task: Record<string, unknown>,
  moment: Instant,
): { anchor: Instant; source: string } {
  const facts = loadAnchorFacts(db, String(task.user_id))
  const result = latestLearningAnchor(facts, {
    project_id: String(task.project_id),
    node_id: task.knowledge_node_id === null ? '' : String(task.knowledge_node_id),
    before: formatPythonIso(moment),
  })
  if (result.anchor === null) return { anchor: moment, source: 'current_event' }
  return { anchor: parseInstant(result.anchor), source: result.source }
}

/**
 * The interval status Django returns for a delayed task.
 *
 * `services/pairing.ts` owns the single implementation (`delayed_interval_status`); this module only
 * re-exports it so the review-queue/today projection and `sessions.ts` keep their import path.
 */
export type IntervalStatus = DelayIntervalStatus

/** The task rows of one plan, in creation order (`StudyTask.Meta.ordering = ["created_at"]`). */
function orderedPlanTasks(db: DatabaseSync, planId: string): Record<string, unknown>[] {
  return planTasks(db, planId).sort((a, b) => {
    const left = Number(a.created_at as Instant)
    const right = Number(b.created_at as Instant)
    if (left !== right) return left - right
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  })
}

/**
 * `plan_payload`: the wire projection of one plan (or the explicit empty state).
 *
 * A task whose question has since been sealed is dropped from the payload and counted in a note: the
 * plan is the surface the learner reads, and a sealed question must not be shown as today's work.
 */
export function planPayload(
  db: DatabaseSync,
  plan: Record<string, unknown> | null,
  now: Instant,
): Record<string, unknown> {
  if (plan === null) {
    return { plan: null, tasks: [], notes: ['今日还没有计划：可点击“生成今日计划”'] }
  }
  const rows = orderedPlanTasks(db, String(plan.id))
  const byProject = new Map<string, string[]>()
  for (const task of rows) {
    if (task.question_id === null || task.question_id === undefined) continue
    const projectId = String(task.project_id)
    const bucket = byProject.get(projectId) ?? []
    bucket.push(String(task.question_id))
    byProject.set(projectId, bucket)
  }
  const sealed = new Set<string>()
  for (const [projectId, questionIds] of byProject) {
    for (const questionId of sealedQuestionIds(db, projectId, questionIds)) sealed.add(questionId)
  }

  const tasks: Record<string, unknown>[] = []
  let hiddenSealed = 0
  for (const task of rows) {
    const questionId = task.question_id === null || task.question_id === undefined ? null : String(task.question_id)
    const nodeId =
      task.knowledge_node_id === null || task.knowledge_node_id === undefined
        ? null
        : String(task.knowledge_node_id)
    const review = reviewOf(db, String(task.id))
    if (questionId !== null && sealed.has(questionId)) {
      hiddenSealed += 1
      continue
    }
    const question = questionId === null ? null : findOne(db, 'question_bank_question', { id: questionId })
    const node = nodeId === null ? null : findOne(db, 'knowledge_node', { id: nodeId })
    const notBefore = (task.not_before ?? null) as Instant | null
    tasks.push({
      task_id: String(task.id),
      task_kind: String(task.task_kind),
      status: String(task.status),
      project_id: String(task.project_id),
      subject_id: String(task.subject_id),
      question_id: questionId,
      question_label: question === null ? '' : String(question.display_label ?? ''),
      knowledge_node_id: nodeId,
      knowledge_node_name: node === null ? '' : String(node.canonical_name ?? ''),
      estimated_minutes: Number(task.estimated_minutes),
      reason_codes: (task.reason_codes ?? []) as string[],
      evidence_ids: (task.evidence_ids ?? []) as string[],
      not_before: iso(notBefore),
      due_at: iso(task.due_at ?? null),
      delay_anchor_at: iso(task.delay_anchor_at ?? null),
      delay_hours: review === null ? null : Number(review.delay_hours),
      available_now: notBefore === null || notBefore <= now,
      deficit_notice: String(task.deficit_notice ?? ''),
      pairing_version: task.pairing_version === null || task.pairing_version === undefined ? null : Number(task.pairing_version),
    })
  }
  const notes = [...((plan.notes ?? []) as string[])]
  if (hiddenSealed > 0) notes.push(`有 ${hiddenSealed} 个任务因题目已封存（holdout）未在本计划中展示。`)
  return {
    plan: {
      plan_id: String(plan.id),
      plan_date: String(plan.plan_date),
      revision: Number(plan.revision),
      timezone: String(plan.timezone),
      daily_budget_minutes: Number(plan.daily_budget_minutes),
      allocated_minutes: Number(plan.allocated_minutes),
      allocation: plan.allocation ?? [],
      rotation_offset: Number(plan.rotation_offset),
      rule_version: String(plan.rule_version),
      generated_at: formatPythonIso(plan.generated_at as Instant),
    },
    tasks,
    notes,
  }
}

/** `backlog_summary`: overdue tasks carried forward, per active project. */
export function backlogSummary(
  db: DatabaseSync,
  userId: string,
  now: Instant,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const projects = findRows(db, 'exams_project', { owner_id: userId })
    .filter((project) => project.is_archived !== true)
    .sort((a, b) => {
      const left = Number(a.display_order ?? 0)
      const right = Number(b.display_order ?? 0)
      if (left !== right) return left - right
      return Number(a.created_at as Instant) - Number(b.created_at as Instant)
    })
  for (const project of projects) {
    const overdue = findRows(db, 'learning_study_task', {
      user_id: userId,
      project_id: project.id,
    }).filter((task) => {
      if (task.status !== TASK_PENDING && task.status !== TASK_DEFERRED) return false
      const due = task.due_at as Instant | null
      return due !== null && due !== undefined && due < now
    }).length
    if (overdue > 0) {
      rows.push({ project_id: String(project.id), project_name: String(project.name), overdue_tasks: overdue })
    }
  }
  return rows
}

/**
 * `progress_notes`: the current state explained with real counts only.
 *
 * Each sentence names something the learner could act on — an unfinished verification, evidence
 * that did not count, undiagnosed points — never an aggregate score.
 */
export function progressNotes(db: DatabaseSync, userId: string, _now: Instant): string[] {
  const notes: string[] = []
  const unresolved = findRows(db, 'practice_session', { user_id: userId }).filter(
    (session) => session.status === 'active' && session.mode === 'verification',
  ).length
  if (unresolved > 0) {
    notes.push(`有 ${unresolved} 个验证会话尚未结束：结束前不显示分数，也不提供答案。`)
  }
  const excluded = findRows(db, 'practice_learning_evidence', { user_id: userId }).filter(
    (row) =>
      row.is_active === true &&
      row.dimension === 'independent_correct' &&
      row.qualifies === false,
  ).length
  if (excluded > 0) {
    notes.push(`有 ${excluded} 条作答未计入严格独立证据（可在证据列表查看排除原因）。`)
  }
  const undiagnosed = findRows(db, 'learning_knowledge_state', { user_id: userId }).filter(
    (state) => state.summary === 'undiagnosed',
  ).length
  if (undiagnosed > 0) {
    notes.push(`仍有 ${undiagnosed} 个考点未诊断。`)
  }
  return notes
}

/** `_today_payload`: GET never changes the plan; an empty state is explicit. */
export function todayPayload(db: DatabaseSync, userId: string, now: Instant): Record<string, unknown> {
  const settings = getStudySettings(db, userId, now)
  const localDate = localDateIn(String(settings.timezone ?? 'UTC'), now)
  const plan = currentPlan(db, userId, localDate)
  const payload = planPayload(db, plan, now)
  return {
    ...payload,
    backlog: backlogSummary(db, userId, now),
    progress_notes: progressNotes(db, userId, now),
  }
}

/**
 * `GET /projects/{id}/review-tasks`: delayed checks with their real anchor and interval status.
 *
 * `due_now` is the recomputed status, not `not_before <= now`: a task whose deadline moved forward
 * because of a newer training event must show "未到期" even if the stored timestamp is in the past.
 */
export function listReviewTasks(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null; onlyDue?: boolean },
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  if (options.subjectId !== null && options.subjectId !== undefined) {
    requireSubject(db, userId, String(project.id), options.subjectId)
  }
  const tasks = findRows(db, 'learning_study_task', {
    user_id: userId,
    project_id: projectId,
    task_kind: TASK_KIND_DELAYED,
  })
    .filter(
      (task) => options.subjectId === null || options.subjectId === undefined || String(task.subject_id) === options.subjectId,
    )
    .sort((a, b) => {
      // PostgreSQL sorts `ASC` with NULLs last, which is what Django's `order_by("not_before")` means.
      const left =
        a.not_before === null || a.not_before === undefined ? Number.POSITIVE_INFINITY : Number(a.not_before as Instant)
      const right =
        b.not_before === null || b.not_before === undefined ? Number.POSITIVE_INFINITY : Number(b.not_before as Instant)
      return left - right
    })

  const rows: Record<string, unknown>[] = []
  for (const task of tasks) {
    const review = reviewOf(db, String(task.id))
    const status = delayedIntervalStatus(db, task, now)
    if (options.onlyDue === true && !status.satisfied) continue
    const questionId =
      task.question_id === null || task.question_id === undefined ? null : String(task.question_id)
    const nodeId =
      task.knowledge_node_id === null || task.knowledge_node_id === undefined
        ? null
        : String(task.knowledge_node_id)
    const question = questionId === null ? null : findOne(db, 'question_bank_question', { id: questionId })
    const node = nodeId === null ? null : findOne(db, 'knowledge_node', { id: nodeId })
    rows.push({
      task_id: String(task.id),
      status: String(task.status),
      subject_id: String(task.subject_id),
      question_id: questionId,
      question_label: question === null ? '' : String(question.display_label ?? ''),
      knowledge_node_name: node === null ? '' : String(node.canonical_name ?? ''),
      delay_hours: review === null ? null : Number(review.delay_hours),
      delay_anchor_at: iso(task.delay_anchor_at ?? null),
      not_before: iso(task.not_before ?? null),
      due_now: status.satisfied,
      interval_reason: status.reason,
      anchor_source: review === null ? '' : String(review.anchor_source ?? ''),
      was_started: review === null ? false : review.was_started === true,
      deficit_notice: String(task.deficit_notice ?? ''),
      reason_codes: (task.reason_codes ?? []) as string[],
    })
  }
  return { now: formatPythonIso(now), rows }
}

function taskOr404(db: DatabaseSync, userId: string, taskId: string): Record<string, unknown> {
  const task = findOne(db, 'learning_study_task', { id: taskId, user_id: userId })
  if (task === null) throw new ScopeViolation('任务不存在或不在当前权限范围')
  return task
}

/**
 * `start_task`: start a task after re-validating that the question is still usable.
 *
 * An unusable question invalidates the task (it will never become startable again) and refuses the
 * start in the same call; an interval that is not satisfied refuses *without* invalidating, because
 * waiting is the correct action.
 */
export function startTask(
  db: DatabaseSync,
  userId: string,
  taskId: string,
  now: Instant,
): { task: Record<string, unknown>; status: IntervalStatus } {
  const task = taskOr404(db, userId, taskId)
  const project = findOne(db, 'exams_project', { id: String(task.project_id) })
  if (project !== null && project.is_archived === true) {
    throw new InvalidInput('项目已归档，任务不可开始')
  }
  const status = String(task.status)
  if (status === TASK_COMPLETED || status === TASK_SKIPPED || status === TASK_INVALIDATED) {
    throw new InvalidInput(`任务状态为 ${status}，不能开始`, { details: { status } })
  }
  const questionId =
    task.question_id === null || task.question_id === undefined ? null : String(task.question_id)
  const check = eligibility(db, String(task.project_id), questionId)
  if (!check.ok) {
    // The caller records the invalidation once its transaction has rolled back (see `UnusableQuestion`):
    // an unusable question must never look startable again, and the refusal must not erase the record.
    throw new UnusableQuestion(check.reason)
  }
  const interval = delayedIntervalStatus(db, task, now)
  if (!interval.satisfied) {
    throw new InvalidInput(interval.reason, { details: { not_before: interval.not_before ?? null } })
  }
  return transaction(db, () => {
    const review = reviewOf(db, String(task.id))
    if (review !== null && review.was_started !== true) {
      updateRow(db, 'learning_review_task', review.id, { was_started: true }, { now })
    }
    const started = updateRow(db, 'learning_study_task', task.id, {
      status: TASK_IN_PROGRESS,
      started_at: task.started_at ?? now,
    }, { now })!
    return { task: started, status: interval }
  })
}

/**
 * A task whose question can no longer be scheduled. Carries the reason so the caller can record the
 * invalidation *after* its own transaction has rolled back (Django saves the row and then raises,
 * with no request-level transaction to undo it).
 */
export class UnusableQuestion extends InvalidInput {
  reason: string

  constructor(reason: string) {
    super(`题目当前不可用：${reason}`)
    this.reason = reason
  }
}

/** `start_task`'s invalidation branch, as its own committed write. */
export function invalidateTask(
  db: DatabaseSync,
  userId: string,
  taskId: string,
  reason: string,
  now: Instant,
): void {
  const task = findOne(db, 'learning_study_task', { id: taskId, user_id: userId })
  if (task === null) return
  transaction(db, () => {
    updateRow(db, 'learning_study_task', task.id, {
      status: TASK_INVALIDATED,
      invalidated_reason: reason,
    }, { now })
  })
}

/** The `create_session_hint` Django answers after a start (the client builds the workbench from it). */
export function createSessionHint(task: Record<string, unknown>): Record<string, unknown> {
  const questionId = task.question_id === null || task.question_id === undefined ? null : String(task.question_id)
  return {
    subject_id: String(task.subject_id),
    question_ids: questionId === null ? [] : [questionId],
    task_id: String(task.id),
    purpose: String(task.task_kind),
  }
}

export function deferTask(
  db: DatabaseSync,
  userId: string,
  taskId: string,
  reason: string,
  now: Instant,
): Record<string, unknown> {
  return transaction(db, () => {
    const task = taskOr404(db, userId, taskId)
    if (String(task.status) === TASK_COMPLETED) throw new InvalidInput('已完成任务不能顺延')
    const codes = [...((task.reason_codes ?? []) as string[]), `deferred:${pyCodePointSlice(reason, 0, 60) || 'user'}`]
    return updateRow(db, 'learning_study_task', task.id, {
      status: TASK_DEFERRED,
      reason_codes: codes,
    }, { now })!
  })
}

export function skipTask(
  db: DatabaseSync,
  userId: string,
  taskId: string,
  reason: string,
  now: Instant,
): Record<string, unknown> {
  return transaction(db, () => {
    const task = taskOr404(db, userId, taskId)
    return updateRow(db, 'learning_study_task', task.id, {
      status: TASK_SKIPPED,
      invalidated_reason: pyCodePointSlice(reason, 0, 300),
    }, { now })!
  })
}

/**
 * `complete_task`: finish a task without an attempt (reading material only).
 *
 * The note is part of the contract: no attempt means no ability evidence, and the response says so
 * instead of letting "completed" read as "demonstrated".
 */
export function completeTask(
  db: DatabaseSync,
  userId: string,
  taskId: string,
  now: Instant,
): Record<string, unknown> {
  return transaction(db, () => {
    const task = taskOr404(db, userId, taskId)
    if (String(task.status) === TASK_COMPLETED) {
      return { task_id: String(task.id), status: String(task.status) }
    }
    const updated = updateRow(db, 'learning_study_task', task.id, {
      status: TASK_COMPLETED,
      completed_at: now,
    }, { now })!
    return {
      task_id: String(updated.id),
      status: String(updated.status),
      note: '未产生作答，因此不计入任何能力证据',
    }
  })
}

/** `GET /study-tasks/{id}` — one task with its frozen delay facts and memory-card link. */
export function getTask(
  db: DatabaseSync,
  userId: string,
  taskId: string,
): Record<string, unknown> {
  const task = taskOr404(db, userId, taskId)
  const review = reviewOf(db, String(task.id))
  const questionId =
    task.question_id === null || task.question_id === undefined ? null : String(task.question_id)
  const nodeId =
    task.knowledge_node_id === null || task.knowledge_node_id === undefined
      ? null
      : String(task.knowledge_node_id)
  const question = questionId === null ? null : findOne(db, 'question_bank_question', { id: questionId })
  const node = nodeId === null ? null : findOne(db, 'knowledge_node', { id: nodeId })
  return {
    task_id: String(task.id),
    task_kind: String(task.task_kind),
    status: String(task.status),
    project_id: String(task.project_id),
    subject_id: String(task.subject_id),
    question_id: questionId,
    question_label: question === null ? '' : String(question.display_label ?? ''),
    knowledge_node_name: node === null ? '' : String(node.canonical_name ?? ''),
    estimated_minutes: Number(task.estimated_minutes),
    reason_codes: (task.reason_codes ?? []) as string[],
    evidence_ids: (task.evidence_ids ?? []) as string[],
    trigger_event: String(task.trigger_event ?? ''),
    deficit_notice: String(task.deficit_notice ?? ''),
    not_before: iso(task.not_before ?? null),
    delay_hours: review === null ? null : Number(review.delay_hours),
    delay_anchor_at: iso(task.delay_anchor_at ?? null),
    pairing_id:
      task.pairing_id === null || task.pairing_id === undefined ? null : String(task.pairing_id),
    pairing_version:
      task.pairing_version === null || task.pairing_version === undefined
        ? null
        : Number(task.pairing_version),
    origin_session_item_id:
      task.origin_session_item_id === null || task.origin_session_item_id === undefined
        ? null
        : String(task.origin_session_item_id),
    // Memory review is a recall exercise: the link is explicit so the UI can say "记忆卡复习"
    // instead of presenting it as solving practice.
    memory_card_id:
      task.memory_card_id === null || task.memory_card_id === undefined ? null : String(task.memory_card_id),
  }
}

/**
 * `POST /projects/{id}/study-tasks/{task_id}/reconcile-delay`.
 *
 * `pairing.reconcile_delayed_tasks`: push a pending delayed task's deadline when a newer related
 * training event appeared. Only tasks whose review has not been started and whose status is still
 * open are moved; everything else is history and is left alone.
 *
 * Kept here (rather than in `pairing.ts`) because the port of the pairing service belongs to another
 * workstream; when it lands, this function should delegate there instead of duplicating the rule.
 */
export function reconcileDelayedTasks(db: DatabaseSync, now: Instant): number {
  let updated = 0
  const reviews = findRows(db, 'learning_review_task', {}).filter((review) => review.was_started !== true)
  for (const review of reviews) {
    const task = findOne(db, 'learning_study_task', { id: String(review.study_task_id) })
    if (task === null) continue
    if (task.status !== TASK_PENDING && task.status !== TASK_DEFERRED) continue
    const { anchor, source } = anchorFor(db, task, now)
    const expected = anchor + BigInt(Number(review.delay_hours)) * US_PER_HOUR
    if (expected <= (review.not_before as Instant)) continue
    updateRow(db, 'learning_review_task', review.id, {
      not_before: expected,
      delay_anchor_at: anchor,
      anchor_source: source,
    }, { now })
    updateRow(db, 'learning_study_task', task.id, {
      delay_anchor_at: anchor,
      not_before: expected,
      due_at: expected,
      reason_codes: [...((task.reason_codes ?? []) as string[]), 'anchor_updated'],
    }, { now })
    updated += 1
  }
  return updated
}
