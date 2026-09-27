"""Practice API: sessions, presentation, drafts, submission, grading and reveal."""

from __future__ import annotations

from typing import Any

from ninja import Schema

from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.enums import SessionMode
from apps.common.errors import AlreadySubmitted, InvalidInput, ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.practice.models import Attempt, PracticeSession, SessionItem
from apps.practice.services import attempts as attempt_services
from apps.practice.services import exposure, verification_gate
from apps.practice.services import sessions as session_services

practice_router = project_scoped_router(tags=["practice"])

#: Inline (test/demo) runs execute outbox consumers right after the handler.
_dispatch = outbox.after_commit_dispatch


class SessionCreateIn(Schema):
    mode: str = SessionMode.PRACTICE
    subject_id: str
    question_ids: list[str] = []
    task_id: str | None = None
    exam_spec_version_id: str | None = None
    purpose: str = "practice"


class SessionOut(Schema):
    session_id: str
    project_id: str
    subject_id: str
    mode: str
    status: str
    policy_version: str
    grading_hidden: bool
    revealed_at: str | None
    created_at: str
    finished_at: str | None
    items: list[dict[str, Any]]
    #: ``None`` while grading is hidden: the totals are omitted, not just flagged.
    confirmed_score: str | None
    pending_max_score: str | None
    score_visible: bool
    score_hidden_reason: str | None = None


class DraftIn(Schema):
    draft: dict[str, Any]
    draft_revision: int | None = None


class DraftOut(Schema):
    session_item_id: str
    draft_revision: int
    draft_updated_at: str | None
    saved: bool


class SubmitIn(Schema):
    answer: dict[str, Any]
    steps: list[Any] = []
    asset_ids: list[str] = []
    confidence: str = ""
    client_active_ms: int | None = None


class SubmitOut(Schema):
    session_item_id: str
    attempt_id: str
    grading_revision: int
    submitted_at: str
    receipt_only: bool
    grade: dict[str, Any] | None


class ConfirmPartIn(Schema):
    part_id: str
    score: str | None = None
    decision: str = "award"
    comment: str = ""


class ConfirmGradeIn(Schema):
    expected_grading_revision: int
    parts: list[ConfirmPartIn]
    answer_key_version_id: str | None = None
    rubric_version_id: str | None = None
    comment: str = ""


class RevealOut(Schema):
    question_version_id: str
    answer_key_version_id: str | None
    answer_payload: dict[str, Any]
    answer_source_type: str | None
    answer_verification_status: str | None
    check_basis: str
    explanation_blocks: list[Any]
    rubric: dict[str, Any] | None
    confidence_note: str
    exposure_recorded: bool


class DiagnosisIn(Schema):
    error_type: str
    status: str = "confirmed"
    note: str = ""


class DiagnosisOut(Schema):
    id: str
    attempt_id: str
    error_type: str
    origin: str
    status: str
    note: str


def _item_scope(user, project, session_item_id: str) -> SessionItem:
    item = (
        SessionItem.objects.filter(
            id=session_item_id, session__user=user, session__project=project
        )
        .select_related("session", "question_version__question", "answer_key_version", "rubric_version")
        .first()
    )
    if item is None:
        raise ScopeViolation(message="题项不存在或不在当前权限范围")
    return item


def _session_scope(user, project, session_id: str) -> PracticeSession:
    session = PracticeSession.objects.filter(id=session_id, user=user, project=project).first()
    if session is None:
        raise ScopeViolation(message="会话不存在或不在当前权限范围")
    return session


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------
@practice_router.post("/projects/{project_id}/practice-sessions", auth=auth, response={201: SessionOut})
def create_session(request, project_id: str, payload: SessionCreateIn):
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id)
    if project.is_archived:
        raise InvalidInput(message="已归档项目不能新建练习会话")
    key = idempotency_key(request)
    scope = f"sessions.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    task = None
    if payload.task_id:
        from apps.learning.models import StudyTask

        task = StudyTask.objects.filter(id=payload.task_id, user=request.user, project=project).first()
        if task is None:
            raise ScopeViolation(message="学习任务不存在或不属于该项目")
    spec = None
    if payload.exam_spec_version_id:
        spec = subject.exam_spec_versions.filter(id=payload.exam_spec_version_id, status="published").first()
        if spec is None:
            raise ScopeViolation(message="考试规范版本不存在或未发布")
    session = session_services.create_session(
        user=request.user,
        project=project,
        subject=subject,
        mode=payload.mode,
        question_ids=payload.question_ids,
        task=task,
        spec_version=spec,
        purpose=payload.purpose,
    )
    result = session_services.session_state(session, user=request.user)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="practice_session",
        resource_id=session.id,
    )
    _dispatch()
    return 201, result


@practice_router.get("/projects/{project_id}/practice-sessions/{session_id}", auth=auth, response=SessionOut)
def get_session(request, project_id: str, session_id: str):
    session = _session_scope(request.user, require_project(request.user, project_id), session_id)
    return session_services.session_state(session, user=request.user)


@practice_router.post("/projects/{project_id}/practice-sessions/{session_id}/finish", auth=auth, response=SessionOut)
def finish_session(request, project_id: str, session_id: str):
    project = require_project(request.user, project_id)
    session = _session_scope(request.user, project, session_id)
    key = idempotency_key(request)
    scope = f"sessions.finish:{session_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    session = session_services.finish_session(session=session, user=request.user)
    result = session_services.session_state(session, user=request.user)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="practice_session",
        resource_id=session.id,
    )
    _dispatch()
    return result


@practice_router.get("/projects/{project_id}/practice-sessions", auth=auth)
def list_sessions(request, project_id: str, subject_id: str | None = None, limit: int = 20):
    project = require_project(request.user, project_id)
    queryset = PracticeSession.objects.filter(project=project, user=request.user).order_by("-created_at")
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    return [
        {
            "session_id": str(session.id),
            "subject_id": str(session.subject_id),
            "mode": session.mode,
            "status": session.status,
            "created_at": session.created_at.isoformat(),
            "item_count": session.items.count(),
            "submitted_count": Attempt.objects.filter(session_item__session=session).count(),
            "grading_hidden": session.hides_grading,
        }
        for session in queryset[: max(1, min(limit, 50))]
    ]


# --------------------------------------------------------------------------
# Items
# --------------------------------------------------------------------------
@practice_router.get("/projects/{project_id}/session-items/{item_id}/presentation", auth=auth)
def get_presentation(request, project_id: str, item_id: str):
    project = require_project(request.user, project_id)
    item = _item_scope(request.user, project, item_id)
    return session_services.presentation(item=item, user=request.user)


@practice_router.put("/projects/{project_id}/session-items/{item_id}/draft", auth=auth, response=DraftOut)
def put_draft(request, project_id: str, item_id: str, payload: DraftIn):
    project = require_project(request.user, project_id)
    item = _item_scope(request.user, project, item_id)
    item = session_services.save_draft(
        item=item, user=request.user, draft=payload.draft, draft_revision=payload.draft_revision
    )
    return {
        "session_item_id": str(item.id),
        "draft_revision": item.draft_revision,
        "draft_updated_at": item.draft_updated_at.isoformat() if item.draft_updated_at else None,
        "saved": True,
    }


@practice_router.post("/projects/{project_id}/session-items/{item_id}/submit", auth=auth, response={200: SubmitOut})
def submit(request, project_id: str, item_id: str, payload: SubmitIn):
    """Idempotent submission: same key + same payload returns the same attempt."""
    project = require_project(request.user, project_id)
    item = _item_scope(request.user, project, item_id)
    key = idempotency_key(request)
    scope = f"items.submit:{item_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    try:
        attempt, grade = attempt_services.submit_attempt(
            session_item_id=str(item.id),
            user=request.user,
            raw_answer=payload.answer,
            steps=payload.steps,
            asset_ids=payload.asset_ids,
            confidence=payload.confidence,
            client_active_ms=payload.client_active_ms,
        )
    except AlreadySubmitted as exc:
        # A different key against an already-submitted item is still a conflict.
        raise AlreadySubmitted(details=exc.details) from exc
    session = item.session
    result = {
        "session_item_id": str(item.id),
        "attempt_id": str(attempt.id),
        "grading_revision": attempt.grading_revision,
        "submitted_at": attempt.submitted_at.isoformat(),
        "receipt_only": session.hides_grading,
        "grade": session_services.grade_payload(grade, session=session),
    }
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="attempt",
        resource_id=attempt.id,
    )
    _dispatch()
    return 200, result


@practice_router.get("/projects/{project_id}/attempts/{attempt_id}", auth=auth)
def get_attempt(request, project_id: str, attempt_id: str):
    project = require_project(request.user, project_id)
    attempt = (
        Attempt.objects.filter(id=attempt_id, project=project, user=request.user)
        .select_related("session_item__session", "current_grade_event")
        .first()
    )
    if attempt is None:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    session = attempt.session_item.session
    return {
        "attempt_id": str(attempt.id),
        "session_item_id": str(attempt.session_item_id),
        "submitted_at": attempt.submitted_at.isoformat(),
        "elapsed_ms": attempt.elapsed_ms,
        "raw_answer": attempt.raw_answer,
        "steps": attempt.steps,
        "attachments": attempt.attachments,
        "confidence": attempt.confidence,
        "grading_revision": attempt.grading_revision,
        "receipt_only": session.hides_grading,
        "grade": session_services.grade_payload(attempt.current_grade_event, session=session),
    }


@practice_router.post("/projects/{project_id}/attempts/{attempt_id}/confirm-grade", auth=auth)
def confirm_grade(request, project_id: str, attempt_id: str, payload: ConfirmGradeIn):
    """Manual confirmation; your own attempt is always self-confirmed."""
    project = require_project(request.user, project_id)
    attempt = Attempt.objects.filter(id=attempt_id, project=project).select_related("session_item__session").first()
    if attempt is None:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    key = idempotency_key(request)
    scope = f"attempts.confirm:{attempt_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    grade = attempt_services.confirm_grade(
        attempt_id=str(attempt.id),
        user=request.user,
        parts=[part.model_dump(mode="json") for part in payload.parts],
        expected_grading_revision=payload.expected_grading_revision,
        answer_key_version_id=payload.answer_key_version_id,
        rubric_version_id=payload.rubric_version_id,
        comment=payload.comment,
    )
    session = attempt.session_item.session
    result = session_services.grade_payload(grade, session=session)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="grade_event",
        resource_id=grade.id,
    )
    _dispatch()
    return result


# --------------------------------------------------------------------------
# Reveal (practice before submit, anyone after finishing)
# --------------------------------------------------------------------------
@practice_router.post("/projects/{project_id}/session-items/{item_id}/reveal", auth=auth, response=RevealOut)
def reveal_item(request, project_id: str, item_id: str):
    project = require_project(request.user, project_id)
    item = _item_scope(request.user, project, item_id)
    session = item.session
    already_submitted = Attempt.objects.filter(session_item=item).exists()
    session_services.assert_reveal_allowed(item=item, session=session, before_submit=not already_submitted)
    # The same content may be part of a *different* running verification (another
    # tab, another project, a second session). That run's integrity does not
    # depend on which endpoint is used to ask.
    verification_gate.assert_item_not_in_active_verification(item=item, action="查看答案与解析")
    payload = session_services.reveal_payload(item=item, session=session)
    exposure.record(
        user=request.user,
        project=project,
        question=item.question_version.question,
        question_version=item.question_version,
        session_item=item,
        kind="answer_delivered",
        purpose=session.mode if session.mode == SessionMode.PRACTICE else "verification",
        source="session_item_reveal",
        reveals_answer=True,
        detail={"before_submit": not already_submitted},
    )
    payload["exposure_recorded"] = True
    return payload


@practice_router.post("/projects/{project_id}/attempts/{attempt_id}/reveal", auth=auth, response=RevealOut)
def reveal_attempt(request, project_id: str, attempt_id: str):
    project = require_project(request.user, project_id)
    attempt = (
        Attempt.objects.filter(id=attempt_id, project=project, user=request.user)
        .select_related("session_item__session", "session_item__question_version__question")
        .first()
    )
    if attempt is None:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    item = attempt.session_item
    session = item.session
    session_services.assert_reveal_allowed(item=item, session=session, before_submit=False)
    verification_gate.assert_item_not_in_active_verification(item=item, action="查看答案与解析")
    payload = session_services.reveal_payload(item=item, session=session)
    exposure.record(
        user=request.user,
        project=project,
        question=item.question_version.question,
        question_version=item.question_version,
        session_item=item,
        kind="answer_delivered",
        purpose="practice" if session.mode == SessionMode.PRACTICE else "verification",
        source="attempt_reveal",
        reveals_answer=True,
        detail={"after_submit": True},
    )
    payload["exposure_recorded"] = True
    return payload


@practice_router.get("/projects/{project_id}/session-items/{item_id}/exposures", auth=auth)
def list_exposures(request, project_id: str, item_id: str):
    project = require_project(request.user, project_id)
    item = _item_scope(request.user, project, item_id)
    from apps.practice.models import ExposureEvent

    rows = ExposureEvent.objects.filter(
        user=request.user, question_version=item.question_version
    ).order_by("-server_time")[:50]
    return [
        {
            "kind": row.kind,
            "purpose": row.purpose,
            "source": row.source,
            "reveals_answer": row.reveals_answer,
            "server_time": row.server_time.isoformat(),
            "session_item_id": str(row.session_item_id) if row.session_item_id else None,
        }
        for row in rows
    ]


@practice_router.post("/projects/{project_id}/attempts/{attempt_id}/diagnosis", auth=auth, response=DiagnosisOut)
def set_diagnosis(request, project_id: str, attempt_id: str, payload: DiagnosisIn):
    """Confirm or reject an error cause. Never changes a score or a state."""
    project = require_project(request.user, project_id)
    attempt = Attempt.objects.filter(id=attempt_id, project=project, user=request.user).first()
    if attempt is None:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    if payload.status not in {"confirmed", "rejected", "proposed", "unknown"}:
        raise InvalidInput(message="诊断状态无效")
    from apps.practice.models import ErrorDiagnosis

    diagnosis = ErrorDiagnosis.objects.create(
        attempt=attempt,
        error_type=payload.error_type[:40],
        origin="user",
        status=payload.status,
        note=payload.note[:500],
        decided_by=request.user,
        decided_at=None,
    )
    return {
        "id": str(diagnosis.id),
        "attempt_id": str(attempt.id),
        "error_type": diagnosis.error_type,
        "origin": diagnosis.origin,
        "status": diagnosis.status,
        "note": diagnosis.note,
    }


@practice_router.get("/projects/{project_id}/grading-queue", auth=auth)
def grading_queue(request, project_id: str, subject_id: str | None = None, limit: int = 30):
    """Attempts waiting for human confirmation (own attempts or, for staff, others').

    Attempts belonging to a run whose grading is still hidden are excluded: the
    queue must not become a back door to the score of a live verification.
    """
    from django.db.models import Q

    from apps.common.enums import GradeStatus, SessionMode, SessionStatus
    from apps.common.scope import is_reviewer_of

    project = require_project(request.user, project_id)
    queryset = (
        Attempt.objects.filter(project=project)
        .filter(current_grade_event__status=GradeStatus.PENDING_REVIEW)
        .exclude(
            Q(session_item__session__status=SessionStatus.ACTIVE)
            & Q(session_item__session__mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM])
        )
        .select_related("session_item__question_version__question", "current_grade_event", "user")
        # Newest first: a reviewer who has just graded a submission expects it at
        # the top, not buried under older pending work.
        .order_by("-submitted_at")
    )
    if not request.user.is_staff:
        queryset = queryset.filter(user=request.user)
    elif subject_id:
        queryset = queryset.filter(session_item__question_version__question__subject_id=subject_id)
    rows = []
    for attempt in queryset[: max(1, min(limit, 100))]:
        grade = attempt.current_grade_event
        rows.append(
            {
                "attempt_id": str(attempt.id),
                "session_item_id": str(attempt.session_item_id),
                "question_id": str(attempt.session_item.question_version.question_id),
                "display_label": attempt.session_item.question_version.question.display_label,
                "question_type": attempt.session_item.question_version.question_type,
                "subject_id": str(attempt.session_item.question_version.question.subject_id),
                "submitted_at": attempt.submitted_at.isoformat(),
                "grading_revision": attempt.grading_revision,
                "pending_max_score": str(grade.pending_max_score) if grade else "0",
                "confirmed_score": str(grade.confirmed_score) if grade and grade.confirmed_score is not None else None,
                "is_own_attempt": str(attempt.user_id) == str(request.user.id),
                "can_review_as_other": is_reviewer_of(request.user, attempt),
                "parts": grade.parts if grade else [],
                # The reviewer must be able to check the original work, not
                # remember it (R10).
                "raw_answer": attempt.raw_answer,
                "steps": attempt.steps,
                "attachments": attempt.attachments,
                "confidence": attempt.confidence,
                "elapsed_ms": attempt.elapsed_ms,
                "rubric": _rubric_payload(attempt.session_item),
            }
        )
    return rows


def _rubric_payload(item: SessionItem) -> dict | None:
    if not item.rubric_version_id:
        return None
    rubric = item.rubric_version
    return {
        "rubric_version_id": str(rubric.id),
        "criteria": rubric.criteria,
        "total_score": str(rubric.total_score),
    }
