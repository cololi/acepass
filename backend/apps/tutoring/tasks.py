"""Tutoring tasks: run one provider call for a queued job."""

from __future__ import annotations

from celery import shared_task


@shared_task(name="tutoring.run_job", ignore_result=True)
def run_tutor_job(
    tutor_job_id: str, prompt: str, citations: list[str], purpose: str, outbox_event_id: str | None = None
) -> str:
    from apps.audit.tasks import _mark_outbox
    from apps.tutoring.models import TutorJob
    from apps.tutoring.services import core as tutor_service

    job = TutorJob.objects.filter(id=tutor_job_id).first()
    if job is None:
        _mark_outbox(outbox_event_id, ok=False, error="tutor job missing")
        return "missing"
    tutor_service.run_job(job=job, prompt=prompt, citations=list(citations), purpose=purpose)
    _mark_outbox(outbox_event_id, ok=True)
    return job.status


def run_tutor_job_now(job) -> None:
    """P0 executes the call inline; the outbox event remains for retry and audit.

    Rebuilding the prompt from frozen inputs is deterministic, so a worker retry
    sends exactly the same request instead of a re-invented one.
    """
    from apps.tutoring.services import core as tutor_service

    if job.status != "queued":
        return
    prompt = tutor_service.build_prompt(
        item=job.tutor_session.session_item, user_question=job.request_text
    )
    citations, _context = tutor_service._allowed_citation_ids(job.tutor_session.session_item)
    tutor_service.run_job(job=job, prompt=prompt, citations=citations, purpose=job.purpose)
