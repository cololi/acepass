/**
 * `learning.reconcile_plan` / `plan.generated` consumer.
 *
 * Port of `backend/apps/learning/services/planner.py::reconcile_plan` and its helper
 * `_refresh_task_due_date`. Django enqueues this topic once per generated plan with the plan id, and
 * the Celery consumer re-derives what it can from stored rows: it never re-plans (that would mint a
 * second plan for the same day) and never creates a task. What it does do is:
 *
 *  1. move every delayed review whose anchor has been pushed later (`reconcile_delayed_tasks`);
 *  2. copy the review's stored `not_before` back onto the study task it belongs to;
 *  3. append a human-readable reconciliation note to the plan, including whether a newer revision
 *     of the same day's plan exists.
 *
 * It is deliberately idempotent in the sense that matters: running it twice appends two notes, but
 * creates no rows and changes no due date the second time (the stored date already matches). That is
 * also Django's behaviour, and the note is the audit trail that a consumer actually ran.
 *
 * It lives outside `planner.ts` so the candidate-generation rules and this reconciliation write path
 * can be changed independently; both are still the same Django module being ported.
 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { findOne, findRows, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { reconcileDelayedTasks } from './pairing.ts'

/** `TaskStatus.PENDING` / `TaskStatus.DEFERRED`: the tasks a refresh may still touch. */
const OPEN_TASK_STATUSES = new Set(['pending', 'deferred'])

export interface PlanReconcileResult {
  /** `plan_missing` when the event names no plan (or a plan that no longer exists). */
  status: 'plan_missing' | 'reconciled'
  /** Open (`pending`/`deferred`) tasks the plan currently has. */
  pending: number
  /** Delayed reviews whose `not_before` moved forward. */
  delayed_updated: number
  /** True when a newer revision of the same user/date already exists. */
  superseded: boolean
  /** The note appended to `learning_study_plan.notes`; `''` for `plan_missing`. */
  note: string
}

/**
 * The reconciliation itself.
 *
 * `planId === ''` is Django's "no plan named" shape: it still re-anchors delayed tasks and reports
 * `plan_missing`, because the delayed-task correction is global and must not be skipped just because
 * the producer sent an empty payload.
 */
export function reconcilePlan(db: DatabaseSync, planId: string, now: Instant): PlanReconcileResult {
  return transaction(db, () => {
    if (planId === '') {
      const updated = reconcileDelayedTasks(db, now)
      return { status: 'plan_missing', pending: 0, delayed_updated: updated, superseded: false, note: '' }
    }
    const plan = findOne(db, 'learning_study_plan', { id: planId })
    if (plan === null) {
      return { status: 'plan_missing', pending: 0, delayed_updated: 0, superseded: false, note: '' }
    }
    const newer = findRows(db, 'learning_study_plan', {
      user_id: plan.user_id,
      plan_date: plan.plan_date,
    }).some((row) => row.id !== plan.id && Number(row.revision) > Number(plan.revision))

    const updated = reconcileDelayedTasks(db, now)
    const openTasks = findRows(db, 'learning_study_task', { plan_id: planId }).filter((task) =>
      OPEN_TASK_STATUSES.has(String(task.status)),
    )
    for (const task of openTasks) refreshTaskDueDate(db, task, now)

    const note =
      `计划核对：${formatPythonIso(now)}，未开始任务 ${openTasks.length} 个，延迟锚点顺延 ${updated} 个` +
      (newer ? '（该修订已被更新修订取代）' : '')
    const notes = Array.isArray(plan.notes) ? (plan.notes as unknown[]) : []
    updateRow(db, 'learning_study_plan', plan.id, { notes: [...notes, note] }, { now })
    return {
      status: 'reconciled',
      pending: openTasks.length,
      delayed_updated: updated,
      superseded: newer,
      note,
    }
  })
}

/** `_refresh_task_due_date`: recompute a task's due date from its own stored review rule. */
function refreshTaskDueDate(db: DatabaseSync, task: Record<string, unknown>, now: Instant): void {
  const review = findOne(db, 'learning_review_task', { study_task_id: String(task.id) })
  if (review === null) return
  const expected = review.not_before
  if (expected === null || expected === undefined) return
  if (task.not_before === expected && task.due_at === expected) return
  updateRow(
    db,
    'learning_study_task',
    task.id,
    { not_before: expected, due_at: expected, delay_anchor_at: review.delay_anchor_at ?? null },
    { now },
  )
}
