"""Celery tasks.

Each task is idempotent, and each one *claims the outbox lease* before doing any
work: the lease is what makes "two consumers saw the same message" safe, and it
was previously only used by the inline path (B05). Completion and failure go back
through the same claim token, so a consumer can never confirm or reopen another
consumer's attempt, and a redelivery that finds the event already terminal is
skipped instead of re-applied.
"""

from __future__ import annotations

import logging

from celery import shared_task

from apps.audit.services import outbox

logger = logging.getLogger("apps.tasks")


def _mark_outbox(event_id: str | None, *, ok: bool, error: str = "", claim_token: str = "") -> None:
    """Confirm or re-queue one outbox row from the consumer side.

    Kept for callers that do not go through :func:`outbox.run_leased` (the tutor
    task already holds a claim). Success goes through ``outbox.mark_processed``,
    the only thing that sets ``processed_at``, and it is token-checked so a stale
    consumer cannot confirm a row another consumer now owns.
    """
    if not event_id:
        return
    from apps.audit.models import OutboxEvent

    if ok:
        outbox.mark_processed(event_id, claim_token=claim_token)
        return
    event = OutboxEvent.objects.filter(id=event_id).first()
    if event is None:
        return
    outbox.mark_retryable_failure(event, error, claim_token=claim_token or None)


@shared_task(name="projection.rebuild_attempt_evidence", ignore_result=True)
def rebuild_attempt_evidence(attempt_id: str, outbox_event_id: str | None = None) -> str:
    from apps.learning.services import evidence as evidence_service

    def action() -> int:
        return evidence_service.rebuild_for_attempt(attempt_id)

    executed, count = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return f"evidence_rows={count}"


@shared_task(name="projection.regrade_effects", ignore_result=True)
def regrade_effects(attempt_id: str, grade_event_id: str, outbox_event_id: str | None = None) -> str:
    from apps.learning.services import evidence as evidence_service
    from apps.learning.services import state as state_service

    def action() -> str:
        evidence_service.rebuild_for_attempt(attempt_id)
        state_service.refresh_states_for_attempt(attempt_id)
        return "ok"

    executed, result = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return result


@shared_task(name="projection.run_regrade", ignore_result=True)
def run_regrade(regrade_run_id: str, outbox_event_id: str | None = None) -> str:
    from apps.analytics.services import regrade as regrade_service

    def action() -> str:
        return regrade_service.execute_regrade_run(regrade_run_id)

    executed, result = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return result


@shared_task(name="projection.rebuild_after_answer_change", ignore_result=True)
def rebuild_after_answer_change(
    answer_key_version_id: str, affected_attempts: int = 0, outbox_event_id: str | None = None
) -> str:
    from apps.learning.services import evidence as evidence_service

    def action() -> int:
        return evidence_service.invalidate_for_answer_version(answer_key_version_id)

    executed, count = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return f"invalidated={count}"


@shared_task(name="projection.refresh_paper_stats", ignore_result=True)
def refresh_paper_stats(paper_id: str, outbox_event_id: str | None = None) -> str:
    from apps.analytics.services import reports as report_service

    def action() -> str:
        report_service.mark_project_stale_for_paper(paper_id)
        return "ok"

    executed, result = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return result


@shared_task(name="learning.on_attempt_graded", ignore_result=True)
def on_attempt_graded(attempt_id: str, grade_event_id: str, outbox_event_id: str | None = None) -> str:
    """Rebuild evidence, refresh the node state and plan the paired A/B/C tasks."""
    from apps.learning.services import evidence as evidence_service
    from apps.learning.services import pairing as pairing_service
    from apps.learning.services import state as state_service

    def action() -> int:
        evidence_service.rebuild_for_attempt(attempt_id)
        state_service.refresh_states_for_attempt(attempt_id)
        return pairing_service.on_attempt_graded(attempt_id)

    executed, created = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return f"paired_tasks={created}"


@shared_task(name="learning.on_session_finished", ignore_result=True)
def on_session_finished(session_id: str, outbox_event_id: str | None = None) -> str:
    from apps.learning.services import state as state_service

    def action() -> str:
        state_service.refresh_session_states(session_id)
        return "ok"

    executed, result = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return result


@shared_task(name="learning.refresh_delayed_tasks", ignore_result=True)
def refresh_delayed_tasks(outbox_event_id: str | None = None) -> str:
    """Re-anchor pending delayed tasks whose anchor moved, and expire overdue ones."""
    from apps.learning.services import pairing as pairing_service

    def action() -> int:
        return pairing_service.reconcile_delayed_tasks()

    executed, updated = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return f"updated={updated}"


@shared_task(name="learning.reconcile_plan", ignore_result=True)
def reconcile_plan(plan_id: str = "", outbox_event_id: str | None = None) -> str:
    """Re-derive a study plan from the current evidence.

    ``learning.reconcile_plan`` used to be enqueued on every plan generation with
    no registered consumer, so a real worker discarded the message and the outbox
    row stayed at ``dispatched`` forever. It is registered here so the topic the
    producers actually emit has a consumer.
    """
    from apps.learning.services import planner as planner_service

    def action() -> str:
        return planner_service.reconcile_plan(plan_id=plan_id)

    executed, result = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return result


@shared_task(name="ingestion.extract_candidate", ignore_result=True)
def extract_candidate(
    import_job_id: str,
    document_id: str,
    candidate_id: str,
    outbox_event_id: str | None = None,
) -> str:
    from apps.ingestion.services import extraction

    def action() -> str:
        return extraction.extract_image_candidate(
            import_job_id=import_job_id, document_id=document_id, candidate_id=candidate_id
        )

    executed, result = outbox.run_leased(outbox_event_id, action)
    if not executed:
        return "skipped_lease_not_held"
    return result


# `audit.scan_outbox` is defined once, in `config/celery.py`, so the beat entry
# and the worker resolve to the same implementation. A second `@shared_task` with
# the same name here silently shadowed it depending on import order.
