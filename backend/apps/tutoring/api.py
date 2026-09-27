"""Tutoring API: gated explanations, validated results and AI status."""

from __future__ import annotations

from typing import Any

from ninja import Schema

from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.errors import ScopeViolation
from apps.common.scope import require_project
from apps.practice.models import SessionItem
from apps.tutoring.models import TutorJob, TutorSession
from apps.tutoring.services import core as tutor_services

tutor_router = project_scoped_router(tags=["tutoring"])


class TutorSessionIn(Schema):
    session_item_id: str
    purpose: str = "explanation"


class TutorSessionOut(Schema):
    tutor_session_id: str
    session_item_id: str
    purpose: str
    attempt_id: str | None
    prompt_version: str
    question_version_id: str | None
    answer_key_version_id: str | None
    created_at: str


class TutorMessageIn(Schema):
    user_question: str = ""
    purpose: str | None = None


class TutorJobOut(Schema):
    tutor_job_id: str
    tutor_session_id: str
    session_item_id: str
    purpose: str
    status: str
    reveals_answer: bool
    is_stale: bool
    is_stub: bool
    provider: str
    model: str
    prompt_version: str
    error_code: str
    error_message: str
    delivered_at: str | None
    result_blocks: list[Any]
    citations: list[str]
    missing_information: list[str]
    suggested_next: list[str]


def _session_out(session: TutorSession) -> dict:
    return {
        "tutor_session_id": str(session.id),
        "session_item_id": str(session.session_item_id),
        "purpose": session.purpose,
        "attempt_id": str(session.attempt_id) if session.attempt_id else None,
        "prompt_version": session.prompt_version,
        "question_version_id": str(session.question_version_id) if session.question_version_id else None,
        "answer_key_version_id": str(session.answer_key_version_id) if session.answer_key_version_id else None,
        "created_at": session.created_at.isoformat(),
    }


@tutor_router.get("/projects/{project_id}/ai-status", auth=auth)
def get_ai_status(request, project_id: str):
    """Whether AI is configured, and what it may be used for. Never fakes health."""
    require_project(request.user, project_id)
    return tutor_services.ai_status()


@tutor_router.get("/projects/{project_id}/ai-runs", auth=auth)
def list_ai_runs(request, project_id: str, limit: int = 20):
    project = require_project(request.user, project_id)
    return tutor_services.recent_runs(project_id=str(project.id), limit=limit)


@tutor_router.post("/projects/{project_id}/tutor-sessions", auth=auth, response={201: TutorSessionOut})
def create_tutor_session(request, project_id: str, payload: TutorSessionIn):
    """Open a tutoring thread for one session item (an attempt is optional)."""
    project = require_project(request.user, project_id)
    item = (
        SessionItem.objects.filter(
            id=payload.session_item_id, session__user=request.user, session__project=project
        )
        .select_related("session", "question_version", "answer_key_version")
        .first()
    )
    if item is None:
        raise ScopeViolation(message="题项不存在或不在当前权限范围")
    key = idempotency_key(request)
    scope = f"tutor_sessions.create:{payload.session_item_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    session = tutor_services.create_tutor_session(item=item, user=request.user, purpose=payload.purpose)
    result = _session_out(session)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="tutor_session",
        resource_id=session.id,
    )
    return 201, result


@tutor_router.post("/projects/{project_id}/tutor-sessions/{tutor_session_id}/messages", auth=auth, response={201: TutorJobOut})
def post_message(request, project_id: str, tutor_session_id: str, payload: TutorMessageIn):
    """Ask for a hint or a full explanation. Returns a job id to poll.

    A replayed message returns the same *job*, not a cached copy of its content:
    the stored explanation is re-serialised under the content gate that applies
    now, so a job asked before the verification started cannot be replayed to read
    the answer out of a run that is still open (C01/B02).
    """
    project = require_project(request.user, project_id)
    session = tutor_services.session_scope(request.user, project, tutor_session_id)
    key = idempotency_key(request)
    scope = f"tutor_messages.create:{tutor_session_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        job = TutorJob.objects.filter(id=replay.record.resource_id, user=request.user).first()
        if job is None:
            return replay.status_code, replay.body
        # Raises 403 when the content is part of a running verification; otherwise
        # re-serialises the job as it stands now (a retry may have changed it).
        tutor_services.assert_job_deliverable(job)
        return replay.status_code, tutor_services.job_payload(job)
    job = tutor_services.create_job(
        tutor_session=session,
        user=request.user,
        user_question=payload.user_question,
        purpose=payload.purpose,
    )
    # P0 runs the call inline and returns the validated result; the job row and
    # outbox event still exist so a worker retry is idempotent. The inline call
    # takes the *same* outbox lease a worker would, so the request and the worker
    # are two consumers of one job rather than two writers (C04).
    from apps.tutoring.tasks import run_tutor_job_now

    verdict = run_tutor_job_now(job)
    if verdict == "lease_not_acquired":
        # A worker already owns this job's event. This caller owns nothing, so it
        # must neither call the model nor write a result: it waits (no lock held)
        # for the owner to commit, then describes that committed outcome.
        job = tutor_services.wait_for_settlement(job)
    else:
        job.refresh_from_db()
    result = tutor_services.job_payload(job)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="tutor_job", resource_id=job.id
    )
    outbox.after_commit_dispatch()
    return 201, result


@tutor_router.get("/projects/{project_id}/tutor-jobs/{job_id}", auth=auth, response=TutorJobOut)
def get_job(request, project_id: str, job_id: str):
    project = require_project(request.user, project_id)
    job = TutorJob.objects.filter(id=job_id, project=project, user=request.user).select_related("llm_run").first()
    if job is None:
        raise ScopeViolation(message="辅导任务不存在或不在当前权限范围")
    # B02: a cached job still holds the answer. Reading it must obey the same
    # content gate as asking for a new one.
    tutor_services.assert_job_deliverable(job)
    return tutor_services.job_payload(job)


@tutor_router.get("/projects/{project_id}/tutor-sessions", auth=auth)
def list_tutor_sessions(request, project_id: str, session_item_id: str | None = None, limit: int = 20):
    project = require_project(request.user, project_id)
    queryset = TutorSession.objects.filter(project=project, user=request.user).order_by("-created_at")
    if session_item_id:
        queryset = queryset.filter(session_item_id=session_item_id)
    return [
        {
            **_session_out(session),
            "job_count": session.jobs.count(),
            "last_job_status": session.jobs.order_by("-created_at").first().status if session.jobs.exists() else None,
        }
        for session in queryset[: max(1, min(limit, 50))]
    ]
