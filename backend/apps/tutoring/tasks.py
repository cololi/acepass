"""Tutoring tasks: run one provider call for a queued job.

The task claims the outbox lease before it does anything (B05): the previous
version executed the provider call first and only then told the outbox, so a real
worker ignored an existing live lease and two consumers could run the same job.
Completion and failure carry the claim token, so a stale consumer cannot confirm
or reopen a row another consumer owns.

The inline HTTP path (``run_tutor_job_now``) goes through the very same claim, so
"worker" and "synchronous request" are two consumers of one lease rather than two
independent writers (C04).
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


def run_tutor_job_now(job) -> str:
    """P0 executes the call inline — under the *same* outbox lease a worker uses.

    The job's outbox row is committed before this runs and is therefore claimable
    by a real worker. Production HTTP used to call the provider with ``claim=None``
    anyway: two consumers ran the same job concurrently, the late writer won the
    job row and the HTTP response, while the assistant message kept the worker's
    text (C04). Ownership is now a single decision on that one row, so exactly one
    consumer may call the model and commit the result; a worker that arrives during
    the inline call sees a live lease and skips.

    Rebuilding the prompt from frozen inputs is deterministic, so a worker retry
    sends exactly the same request instead of a re-invented one. The model call
    still happens outside every transaction, and the lease is never held across a
    database lock.

    Returns the stored job status, or ``"lease_not_acquired"`` when another
    consumer already owns the event: the caller then owns nothing and must deliver
    whatever that consumer commits rather than run its own call.
    """
    from apps.audit.models import OutboxEvent
    from apps.audit.services import outbox
    from apps.tutoring.services import core as tutor_service

    if job.status != "queued":
        return job.status
    prompt = tutor_service.build_prompt(
        item=job.tutor_session.session_item, user_question=job.request_text
    )
    citations, _context = tutor_service._allowed_citation_ids(job.tutor_session.session_item)
    event = OutboxEvent.objects.filter(dedupe_key=f"tutor-job:{job.id}").first()
    if event is None:
        # Defensive: with no row there is nothing to serialise on. ``create_job``
        # always enqueues one, so this is only reachable for a hand-built fixture.
        tutor_service.run_job(job=job, prompt=prompt, citations=citations, purpose=job.purpose)
        return job.status
    claim = outbox.claim_event(str(event.id))
    if claim is None:
        return "lease_not_acquired"
    try:
        tutor_service.run_job(
            job=job,
            prompt=prompt,
            citations=citations,
            purpose=job.purpose,
            claim=claim,
        )
    except Exception as exc:
        outbox.fail_claim(claim, str(exc))
        raise
    # A successful business commit confirms the claim inside ``_finalize_success``.
    # This token-checked call only covers the terminal paths that produce no
    # business facts (a model failure) and is a no-op when already confirmed.
    outbox.confirm_claim(claim)
    return job.status
