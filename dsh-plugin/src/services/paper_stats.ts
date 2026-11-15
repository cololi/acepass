/**
 * Paper statistics staleness — port of `apps.analytics.services.reports.mark_project_stale_for_paper`
 * and the `projection.refresh_paper_stats` consumer.
 *
 * Publishing a paper item changes what a cycle report would say, but recomputing every report inside
 * the publish transaction would make a single publication write a project's whole analytics. Django
 * therefore marks the project's snapshots stale and lets the next read recompute. The row update is
 * deliberately a plain `UPDATE`: Django's `QuerySet.update()` bypasses `auto_now`, so `updated_at`
 * does not move here either — the snapshot's own `as_of` is what says when it was computed.
 */
import type { DatabaseSync } from 'node:sqlite'

/** Returns the number of snapshots marked stale (Django's `update()` row count). */
export function markProjectStaleForPaper(db: DatabaseSync, paperId: string): number {
  const paper = db.prepare('SELECT "subject_id" AS subject_id FROM "exams_paper" WHERE "id" = ?').get(paperId) as
    | { subject_id: string }
    | undefined
  if (paper === undefined) return 0
  const subject = db
    .prepare('SELECT "project_id" AS project_id FROM "exams_subject" WHERE "id" = ?')
    .get(paper.subject_id) as { project_id: string } | undefined
  if (subject === undefined) return 0
  const result = db
    .prepare('UPDATE "analytics_report_snapshot" SET "is_stale" = 1 WHERE "project_id" = ?')
    .run(subject.project_id)
  return Number(result.changes)
}
