"""Tutoring tasks: run one provider call for a queued job.

The task claims the outbox lease before it does anything (B05): the previous
version executed the provider call first and only then told the outbox, so a real
worker ignored an existing live lease and two consumers could run the same job.
Completion and failure carry the claim token, so a stale consumer cannot confirm
or reopen a row another consumer owns.
"""

from __future__ import annotations

from celery import shared_task

from apps.audit.services import outbox


@shared_task(name="tutoring.run_job", ignore_result=True)
def run_tutor_job(
    tutor_job_id: str, prompt: str, citations: list[str], purpose: str, outbox_event_id: str | None = None
) -> str:
    from apps.tutoring.models import TutorJob
    from apps.tutoring.services import core as tutor_service

    claim = outbox.claim_event(str(outbox_event_id)) if outbox_event_id else None
    if outbox_event_id and claim is None:
        # Another consumer holds a live lease, or the event is already terminal.
        return "skipped_lease_not_held"
    job = TutorJob.objects.filter(id=tutor_job_id).first()
    if job is None:
        if claim is not None:
            # A consumer verdict, not a success: the row stays recoverable and is
            # bounded by max_attempts, so a job that never appears cannot be
            # mistaken for an effect that happened.
            outbox.fail_claim(claim, "tutor job missing")
        return "missing"
    try:
        tutor_service.run_job(
            job=job, prompt=prompt, citations=list(citations), purpose=purpose, claim=claim
        )
    except Exception as exc:
        if claim is not None:
            outbox.fail_claim(claim, str(exc))
        raise
    if claim is not None:
        # Business writes confirm the claim inside their own transaction
        # (``_finalize_success``). This call only covers the paths that produce no
        # business facts — a terminal model failure — and is a token-checked no-op
        # when the row was already confirmed or taken over.
        outbox.confirm_claim(claim)
    return job.status


def run_tutor_job_now(job) -> None:
    """P0 executes the call inline; the outbox event remains for retry and audit.

    Rebuilding the prompt from frozen inputs is deterministic, so a worker retry
    sends exactly the same request instead of a re-invented one. The outbox row is
    confirmed by whichever consumer claims it, never here: the inline call does
    not hold the lease.
    """
    from apps.tutoring.services import core as tutor_service

    if job.status != "queued":
        return
    prompt = tutor_service.build_prompt(
        item=job.tutor_session.session_item, user_question=job.request_text
    )
    citations, _context = tutor_service._allowed_citation_ids(job.tutor_session.session_item)
    tutor_service.run_job(job=job, prompt=prompt, citations=citations, purpose=job.purpose)
