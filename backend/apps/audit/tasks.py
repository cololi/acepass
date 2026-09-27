"""Celery tasks.

Each task is idempotent and takes an ``outbox_event_id`` so a redelivery cannot
double-apply an effect. Business state lives in PostgreSQL; Redis only carries
the trigger.
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger("apps.tasks")


def _mark_outbox(event_id: str | None, *, ok: bool, error: str = "") -> None:
    """Confirm or re-queue one outbox row from the consumer side.

    Success goes through :func:`outbox.mark_processed`, which is the only thing
    that sets ``processed_at``. Failure is scheduled with backoff and an attempt
    cap instead of being retried forever with no bound.
    """
    if not event_id:
        return
    from apps.audit.models import OutboxEvent
    from apps.audit.services import outbox

    if ok:
        outbox.mark_processed(event_id)
        return
    event = OutboxEvent.objects.filter(id=event_id).first()
    if event is None:
        return
    outbox.mark_retryable_failure(event, error)


@shared_task(name="projection.rebuild_attempt_evidence", ignore_result=True)
def rebuild_attempt_evidence(attempt_id: str, outbox_event_id: str | None = None) -> str:
    from apps.learning.services import evidence as evidence_service

    try:
        count = evidence_service.rebuild_for_attempt(attempt_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("evidence rebuild failed attempt=%s", attempt_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return f"evidence_rows={count}"


@shared_task(name="projection.regrade_effects", ignore_result=True)
def regrade_effects(attempt_id: str, grade_event_id: str, outbox_event_id: str | None = None) -> str:
    from apps.learning.services import evidence as evidence_service
    from apps.learning.services import state as state_service

    try:
        evidence_service.rebuild_for_attempt(attempt_id)
        state_service.refresh_states_for_attempt(attempt_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("regrade effects failed attempt=%s", attempt_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return "ok"


@shared_task(name="projection.run_regrade", ignore_result=True)
def run_regrade(regrade_run_id: str, outbox_event_id: str | None = None) -> str:
    from apps.analytics.services import regrade as regrade_service

    try:
        result = regrade_service.execute_regrade_run(regrade_run_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("regrade run failed run=%s", regrade_run_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return result


@shared_task(name="projection.rebuild_after_answer_change", ignore_result=True)
def rebuild_after_answer_change(
    answer_key_version_id: str, affected_attempts: int = 0, outbox_event_id: str | None = None
) -> str:
    from apps.learning.services import evidence as evidence_service

    try:
        count = evidence_service.invalidate_for_answer_version(answer_key_version_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("answer-change rebuild failed answer=%s", answer_key_version_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return f"invalidated={count}"


@shared_task(name="projection.refresh_paper_stats", ignore_result=True)
def refresh_paper_stats(paper_id: str, outbox_event_id: str | None = None) -> str:
    from apps.analytics.services import reports as report_service

    try:
        report_service.mark_project_stale_for_paper(paper_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("paper stats refresh failed paper=%s", paper_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return "ok"


@shared_task(name="learning.on_attempt_graded", ignore_result=True)
def on_attempt_graded(attempt_id: str, grade_event_id: str, outbox_event_id: str | None = None) -> str:
    """Rebuild evidence, refresh the node state and plan the paired A/B/C tasks."""
    from apps.learning.services import evidence as evidence_service
    from apps.learning.services import pairing as pairing_service
    from apps.learning.services import state as state_service

    try:
        evidence_service.rebuild_for_attempt(attempt_id)
        state_service.refresh_states_for_attempt(attempt_id)
        created = pairing_service.on_attempt_graded(attempt_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("on_attempt_graded failed attempt=%s", attempt_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return f"paired_tasks={created}"


@shared_task(name="learning.on_session_finished", ignore_result=True)
def on_session_finished(session_id: str, outbox_event_id: str | None = None) -> str:
    from apps.learning.services import state as state_service

    try:
        state_service.refresh_session_states(session_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("session finish handling failed session=%s", session_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return "ok"


@shared_task(name="learning.refresh_delayed_tasks", ignore_result=True)
def refresh_delayed_tasks(outbox_event_id: str | None = None) -> str:
    """Re-anchor pending delayed tasks whose anchor moved, and expire overdue ones."""
    from apps.learning.services import pairing as pairing_service

    try:
        updated = pairing_service.reconcile_delayed_tasks()
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("delayed task reconciliation failed")
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
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

    try:
        result = planner_service.reconcile_plan(plan_id=plan_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("plan reconciliation failed plan=%s", plan_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return result


@shared_task(name="ingestion.extract_candidate", ignore_result=True)
def extract_candidate(
    import_job_id: str,
    document_id: str,
    candidate_id: str,
    outbox_event_id: str | None = None,
) -> str:
    from apps.ingestion.services import extraction

    try:
        result = extraction.extract_image_candidate(
            import_job_id=import_job_id, document_id=document_id, candidate_id=candidate_id
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("image extraction failed candidate=%s", candidate_id)
        _mark_outbox(outbox_event_id, ok=False, error=str(exc))
        raise
    _mark_outbox(outbox_event_id, ok=True)
    return result


# `audit.scan_outbox` is defined once, in `config/celery.py`, so the beat entry
# and the worker resolve to the same implementation. A second `@shared_task` with
# the same name here silently shadowed it depending on import order.
