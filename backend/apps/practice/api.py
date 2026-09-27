"""Practice API: sessions, presentation, drafts, submission, grading and reveal."""

from __future__ import annotations

from typing import Any

from ninja import Schema

from ai.providers import base as providers
from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.enums import SessionMode
from apps.common.errors import (
    AiNotConfigured,
    AlreadySubmitted,
    DependencyUnavailable,
    InvalidInput,
    PurposeNotAllowed,
    ScopeViolation,
)
from apps.common.scope import require_project, require_subject
from apps.practice.models import AnswerTranscription, Attempt, DiagnosisFollowUp, PracticeSession, SessionItem
from apps.practice.services import attempts as attempt_services
from apps.practice.services import diagnosis as diagnosis_services
from apps.practice.services import estimation as estimation_services
from apps.practice.services import exposure, verification_gate
from apps.practice.services import sessions as session_services
from apps.practice.services import transcription as transcription_services

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
    #: Items whose grading is withheld because a *different* running verification
    #: covers the same content (empty unless the content gate applies).
    grading_withheld_session_item_ids: list[str] = []


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


class ContaminationEvidenceOut(Schema):
    """Which ledger row proves one contamination reason."""

    evidence_id: str
    evidence_type: str
    exposure_kind: str | None = None
    question_id: str
    project_id: str | None = None
    session_item_id: str | None = None
    server_time: str | None = None


class ExclusionReasonOut(Schema):
    code: str
    message: str
    evidence: ContaminationEvidenceOut


class QuestionExposureOut(Schema):
    """Why (and whether) a question can no longer be called strictly unseen."""

    question_id: str
    seen: bool
    reasons: list[str]
    first_seen_at: str | None = None
    sources: list[str]
    strict_independent_eligible: bool
    exclusion_reasons: list[ExclusionReasonOut]


class ExternalSeenIn(Schema):
    seen: bool = True
    note: str = ""


class EditorialPreviewIn(Schema):
    note: str = ""


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
        # A replayed finish returns the *current* projection of the same session,
        # re-serialised under the gate that applies now — the same rule the detail
        # read and every other replay path already follow (C01). Returning the
        # stored body would hand back the score of a session whose content an
        # active verification covers right now, and would never restore it once
        # that verification closed. Finishing again stays idempotent: a finished
        # session is returned unchanged, so no second finish event is enqueued.
        session = session_services.finish_session(session=session, user=request.user)
        return replay.status_code, session_services.session_state(session, user=request.user)
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
    content_map = verification_gate.active_verification_content_map(user=request.user)
    rows = []
    for session in queryset[: max(1, min(limit, 50))]:
        # The list view must not disagree with the detail view about whether a
        # session's grading is currently deliverable.
        withheld = any(
            verification_gate.content_gate_blocks_item(item=item, content_map=content_map)
            for item in session.items.select_related("question_version").all()
        )
        rows.append(
            {
                "session_id": str(session.id),
                "subject_id": str(session.subject_id),
                "mode": session.mode,
                "status": session.status,
                "created_at": session.created_at.isoformat(),
                "item_count": session.items.count(),
                "submitted_count": Attempt.objects.filter(session_item__session=session).count(),
                "grading_hidden": session.hides_grading or withheld,
            }
        )
    return rows


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
    """Idempotent submission: same key + same payload returns the same attempt.

    The replay returns the same *resource*, never a cached copy of the sensitive
    payload: the grade is re-serialised under the gate that applies now, so a
    practice attempt whose content has since entered a verification returns a
    receipt instead of the score it returned the first time (C01).
    """
    project = require_project(request.user, project_id)
    item = _item_scope(request.user, project, item_id)
    key = idempotency_key(request)
    scope = f"items.submit:{item_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return _submission_receipt(item=item, user=request.user, fallback=replay)
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
    hidden = session_services.delivery_hidden_for_item(item=item, user=request.user)
    result = {
        "session_item_id": str(item.id),
        "attempt_id": str(attempt.id),
        "grading_revision": attempt.grading_revision,
        "submitted_at": attempt.submitted_at.isoformat(),
        "receipt_only": hidden,
        "grade": session_services.grade_payload(grade, session=session, hidden=hidden),
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


def _submission_receipt(*, item: SessionItem, user, fallback) -> tuple[int, dict[str, Any]]:
    """Re-serialise a replayed submission against the current visibility gate."""
    attempt = (
        Attempt.objects.filter(session_item=item).select_related("current_grade_event").first()
    )
    if attempt is None:  # the effect never landed; the stored body is all we have
        return fallback.status_code, fallback.body
    session = item.session
    hidden = session_services.delivery_hidden_for_item(item=item, user=user)
    return 200, {
        "session_item_id": str(item.id),
        "attempt_id": str(attempt.id),
        "grading_revision": attempt.grading_revision,
        "submitted_at": attempt.submitted_at.isoformat(),
        "receipt_only": hidden,
        "grade": session_services.grade_payload(attempt.current_grade_event, session=session, hidden=hidden),
    }


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
    # B02: an already stored grade is the same disclosure as a fresh one, so the
    # read path is gated too (a result written before the verification started
    # must not become a bypass).
    verification_gate.assert_grading_not_blocked(
        item=attempt.session_item, action="读取此题的有效评分"
    )
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
    """Manual confirmation; your own attempt is always self-confirmed.

    Guarded like every other delivery: while the same content is inside a running
    verification, writing a score is the same disclosure as reading one, and a
    replayed confirmation is re-serialised under the gate that applies now.
    """
    project = require_project(request.user, project_id)
    attempt = (
        Attempt.objects.filter(id=attempt_id, project=project)
        .select_related("session_item__session", "session_item__question_version")
        .first()
    )
    if attempt is None:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    item = attempt.session_item
    verification_gate.assert_grading_not_blocked(item=item, action="确认此题评分")
    key = idempotency_key(request)
    scope = f"attempts.confirm:{attempt_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        session = item.session
        hidden = session_services.delivery_hidden_for_item(item=item, user=request.user)
        if hidden:
            raise PurposeNotAllowed(
                message="该内容正在验证中：为避免泄露答案，验证结束前不能读取评分。",
                details={"reason": "active_verification_content_gate", "attempt_id": str(attempt.id)},
            )
        return replay.status_code, {
            "grade": session_services.grade_payload(
                attempt.current_grade_event, session=session, hidden=False
            )
        }
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


# --------------------------------------------------------------------------
# C04: why a question is no longer "strictly unseen" (read + the two writers)
# --------------------------------------------------------------------------
def _question_scope(user, project, question_id: str):
    """Owner-scoped question inside this project; a foreign id is a 404."""
    from apps.question_bank.models import Question

    question = (
        Question.objects.filter(id=question_id, subject__project=project)
        .select_related("subject", "current_published_version")
        .first()
    )
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    return question


def _exposure_payload(*, user, project, question) -> dict:
    """The question-level C04 state: seen or not, and the exact reason rows."""
    from apps.learning.services import contamination

    question_id = str(question.id)
    state = contamination.exposure_state(
        user=user, question_ids=[question_id], project=project
    )[question_id]
    return {"question_id": question_id, **state}


@practice_router.get(
    "/projects/{project_id}/questions/{question_id}/exposure", auth=auth, response=QuestionExposureOut
)
def get_question_exposure(request, project_id: str, question_id: str):
    """Read-only: everything that stops this question counting as strictly unseen.

    ``strict_independent_eligible`` is false once the question has been
    delivered, proofread, declared as seen outside or exposed in another project
    — and there is no reset path back (C04). The rows explain which ledger entry
    proves each reason, so the UI can answer "为什么这题不算严格独立".
    """
    project = require_project(request.user, project_id)
    question = _question_scope(request.user, project, question_id)
    return _exposure_payload(user=request.user, project=project, question=question)


@practice_router.post(
    "/projects/{project_id}/questions/{question_id}/external-seen",
    auth=auth,
    response={201: QuestionExposureOut},
)
def declare_external_seen(request, project_id: str, question_id: str, payload: ExternalSeenIn):
    """Record the learner's declaration that they met this question outside.

    The ledger is append-only: ``seen=false`` is stored as a correction row, but
    the conservative rule stands — once a question has ever been declared seen it
    can never produce strict-independent evidence again (C04: no path back to
    "strictly unseen"). Replaying the same Idempotency-Key reuses the same row.
    """
    from apps.learning.services import contamination

    project = require_project(request.user, project_id)
    question = _question_scope(request.user, project, question_id)
    key = idempotency_key(request)
    scope = f"questions.external-seen:{question_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    event = contamination.record_external_seen(
        question=question,
        actor=request.user,
        project=project,
        seen=payload.seen,
        note=payload.note,
    )
    result = _exposure_payload(user=request.user, project=project, question=question)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="exposure_event",
        resource_id=event.id,
    )
    return 201, result


@practice_router.post(
    "/projects/{project_id}/import-candidates/{candidate_id}/editorial-preview",
    auth=auth,
    response={201: QuestionExposureOut},
)
def record_candidate_editorial_preview(
    request, project_id: str, candidate_id: str, payload: EditorialPreviewIn
):
    """Log that an already-published question was opened for proofreading.

    This is the write path for ``EDITORIAL_PREVIEW`` (C04 source 1): the
    proofreader sees the answer, so the question can never again be presented as
    strictly unseen. It is deliberately gated on a re-import candidate linked to
    a published question (``ImportCandidate.publication_question_id``), which is
    the only case the product can attest honestly today; the ingestion endpoints
    (``get_candidate`` / ``patch_candidate`` in ``apps/ingestion/api.py``) should
    call ``contamination.record_editorial_preview`` with their own ``source`` so
    the ledger names the real entry point. Re-opening the same candidate reuses
    the existing row instead of stacking duplicates.
    """
    from apps.ingestion.models import ImportCandidate
    from apps.learning.services import contamination
    from apps.question_bank.models import QuestionVersion

    project = require_project(request.user, project_id)
    candidate = ImportCandidate.objects.filter(
        id=candidate_id, project=project, job__created_by=request.user
    ).first()
    if candidate is None:
        raise ScopeViolation(message="导入候选不存在或不在当前权限范围")
    if not candidate.publication_question_id:
        raise InvalidInput(message="该候选尚未关联已发布题目：只有对已发布内容的再次校对才记录编辑预览")
    question = _question_scope(request.user, project, str(candidate.publication_question_id))
    key = idempotency_key(request)
    scope = f"candidates.editorial-preview:{candidate_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    version = None
    if candidate.publication_version_id:
        version = QuestionVersion.objects.filter(id=candidate.publication_version_id).first()
    event = contamination.record_editorial_preview(
        question=question,
        actor=request.user,
        source="ingestion_candidate_proofread",
        candidate=candidate,
        project=project,
        version=version,
        note=payload.note,
    )
    result = _exposure_payload(user=request.user, project=project, question=question)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="exposure_event",
        resource_id=event.id,
    )
    return 201, result


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

    Attempts belonging to a run whose grading is still hidden are excluded, and so
    are attempts on content covered by *another* running verification: the queue
    must not become a back door to the score (or the rubric, which implies the
    answer) of a live verification. Both rules come from the shared content gate.
    """
    from django.db.models import Q

    from apps.common.enums import GradeStatus, SessionMode, SessionStatus
    from apps.common.scope import is_reviewer_of

    project = require_project(request.user, project_id)
    content_map = verification_gate.active_verification_content_map(user=request.user)
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
    if content_map:
        # A verification item covers itself, so `cover` must stay reviewable: keep
        # the row when the item *is* the covering verification item, and drop it
        # when the same content is only covered by a different running run.
        covering_item_ids = sorted({item_id for ids in content_map.values() for item_id in ids})
        queryset = queryset.exclude(
            Q(session_item__question_version_id__in=list(content_map))
            & ~Q(session_item_id__in=covering_item_ids)
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


# --------------------------------------------------------------------------
# P1 batch 3 (B07): transcription confirmation, AI estimation, AI diagnosis
# --------------------------------------------------------------------------
class TranscriptionRequestIn(Schema):
    asset_id: str
    #: The learner's own transcription text. When present, no model is called and
    #: the row is recorded as ``origin="manual"`` and already confirmed.
    text: str | None = None


class TranscriptionOut(Schema):
    transcription_id: str
    attempt_id: str
    asset_id: str
    origin: str
    status: str
    raw_text: str
    confirmed_text: str
    confidence: float | None
    doubts: list[Any]
    is_stub: bool
    note: str
    is_confirmed: bool
    decided_at: str | None
    llm_run_id: str | None
    prompt_version: str


class TranscriptionConfirmIn(Schema):
    #: ``None`` accepts the model text as-is; a string is the learner's own text.
    text: str | None = None
    note: str = ""


class TranscriptionRejectIn(Schema):
    note: str = ""


class DiagnosisRequestIn(Schema):
    learner_note: str = ""


class FollowUpAnswerIn(Schema):
    text: str


def _attempt_scope(user, project, attempt_id: str) -> Attempt:
    """Owner-scoped attempt. A foreign attempt is a 404, never a hint that it exists."""
    attempt = (
        Attempt.objects.filter(id=attempt_id, project=project, user=user)
        .select_related(
            "session_item__session",
            "session_item__question_version__question",
            "session_item__rubric_version",
            "current_grade_event",
        )
        .first()
    )
    if attempt is None:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    return attempt


def _transcription_scope(user, project, transcription_id: str) -> AnswerTranscription:
    transcription = (
        AnswerTranscription.objects.filter(
            id=transcription_id, attempt__project=project, attempt__user=user
        )
        .select_related("attempt")
        .first()
    )
    if transcription is None:
        raise ScopeViolation(message="转写不存在或不在当前权限范围")
    return transcription


def _follow_up_scope(user, project, follow_up_id: str) -> DiagnosisFollowUp:
    follow_up = DiagnosisFollowUp.objects.filter(
        id=follow_up_id, attempt__project=project, attempt__user=user
    ).first()
    if follow_up is None:
        raise ScopeViolation(message="追问不存在或不在当前权限范围")
    return follow_up


def _raise_ai_error(exc: providers.AiError, *, action: str) -> None:
    """Map provider failures the way the rest of the product does.

    A missing capability is "AI not configured" (503), anything else the provider
    raised is a dependency failure (503) — never a fabricated result.
    """
    if isinstance(exc, providers.AiUnavailable):
        raise AiNotConfigured(
            message=f"{action}需要配置 AI 能力：{exc}", details={"error_code": exc.code}
        ) from exc
    raise DependencyUnavailable(
        message=f"{action}失败：{exc}", details={"error_code": exc.code}
    ) from exc


def _assert_delivery_visible(*, attempt: Attempt, action: str) -> None:
    """The shared content gate: no score-shaped delivery while grading is hidden."""
    if session_services.delivery_hidden_for_item(item=attempt.session_item, user=attempt.user):
        raise PurposeNotAllowed(
            message=f"验证/考试进行中：为避免泄露答案，验证结束前不能{action}。",
            details={"reason": "grading_hidden", "attempt_id": str(attempt.id)},
        )


@practice_router.get("/projects/{project_id}/attempts/{attempt_id}/transcriptions", auth=auth)
def list_transcriptions(request, project_id: str, attempt_id: str):
    """Transcriptions of one attempt, including which photos still block grading."""
    project = require_project(request.user, project_id)
    attempt = _attempt_scope(request.user, project, attempt_id)
    pending = transcription_services.handwriting_assets(attempt)
    rows = AnswerTranscription.objects.filter(attempt=attempt).order_by("created_at")
    return {
        "attempt_id": str(attempt.id),
        "attachment_asset_ids": [str(asset_id) for asset_id in (attempt.attachments or [])],
        "pending_asset_ids": pending,
        "transcription_required": bool(pending),
        "gate_open": not pending,
        "transcriptions": [transcription_services.transcription_payload(row) for row in rows],
    }


@practice_router.post(
    "/projects/{project_id}/attempts/{attempt_id}/transcriptions", auth=auth, response={201: TranscriptionOut}
)
def create_transcription(request, project_id: str, attempt_id: str, payload: TranscriptionRequestIn):
    """Request one handwriting transcription, or record the learner's own text.

    With ``text`` the learner is telling the system what they wrote (the only path
    when no vision model is configured, and always available as a correction);
    without it a vision provider reads the photo and the result stays a proposal.
    """
    project = require_project(request.user, project_id)
    attempt = _attempt_scope(request.user, project, attempt_id)
    key = idempotency_key(request)
    scope = f"attempts.transcribe:{attempt_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    if payload.text is not None:
        # An explicit (even blank) ``text`` means "this is what I wrote": a blank
        # one is a client mistake the learner must see, not a silent fallback into
        # a model call.
        transcription = transcription_services.record_manual_transcription(
            attempt=attempt, asset_id=payload.asset_id, text=payload.text, actor=request.user
        )
    else:
        try:
            transcription = transcription_services.request_transcription(
                attempt=attempt, asset_id=payload.asset_id, actor=request.user
            )
        except providers.AiError as exc:
            _raise_ai_error(exc, action="手写转写")
    result = transcription_services.transcription_payload(transcription)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="answer_transcription",
        resource_id=transcription.id,
    )
    return 201, result


@practice_router.post(
    "/projects/{project_id}/transcriptions/{transcription_id}/confirm", auth=auth, response=TranscriptionOut
)
def confirm_transcription(request, project_id: str, transcription_id: str, payload: TranscriptionConfirmIn):
    """Confirm (or correct) what the learner actually wrote. This opens the gate."""
    project = require_project(request.user, project_id)
    transcription = _transcription_scope(request.user, project, transcription_id)
    transcription = transcription_services.confirm_transcription(
        transcription=transcription, actor=request.user, text=payload.text
    )
    if payload.note:
        transcription.note = payload.note[:500]
        transcription.save(update_fields=["note", "updated_at"])
    return transcription_services.transcription_payload(transcription)


@practice_router.post(
    "/projects/{project_id}/transcriptions/{transcription_id}/reject", auth=auth, response=TranscriptionOut
)
def reject_transcription(request, project_id: str, transcription_id: str, payload: TranscriptionRejectIn):
    """Reject the proposal: the photo stays unconfirmed and grading stays blocked."""
    project = require_project(request.user, project_id)
    transcription = _transcription_scope(request.user, project, transcription_id)
    transcription = transcription_services.reject_transcription(
        transcription=transcription, actor=request.user, note=payload.note
    )
    return transcription_services.transcription_payload(transcription)


@practice_router.post("/projects/{project_id}/attempts/{attempt_id}/ai-estimate", auth=auth)
def create_ai_estimate(request, project_id: str, attempt_id: str):
    """Per-criterion reference estimate. Never a confirmed score."""
    project = require_project(request.user, project_id)
    attempt = _attempt_scope(request.user, project, attempt_id)
    key = idempotency_key(request)
    scope = f"attempts.ai-estimate:{attempt_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        # A stored estimate is still a score-shaped disclosure: re-check the gate
        # instead of handing back a body that may now be hidden (C01).
        _assert_delivery_visible(attempt=attempt, action="读取 AI 估分")
        return replay.status_code, replay.body
    try:
        event = estimation_services.estimate_grade(attempt=attempt, actor=request.user)
    except providers.AiError as exc:
        _raise_ai_error(exc, action="AI 估分")
    result = estimation_services.estimate_payload(event)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="grade_event",
        resource_id=event.id,
    )
    return result


@practice_router.get("/projects/{project_id}/attempts/{attempt_id}/ai-estimate", auth=auth)
def get_ai_estimate(request, project_id: str, attempt_id: str):
    """The latest estimate, or an explicit "no estimate yet" state."""
    project = require_project(request.user, project_id)
    attempt = _attempt_scope(request.user, project, attempt_id)
    _assert_delivery_visible(attempt=attempt, action="读取 AI 估分")
    return estimation_services.estimate_state(attempt)


@practice_router.post("/projects/{project_id}/attempts/{attempt_id}/ai-diagnosis", auth=auth)
def create_ai_diagnosis(request, project_id: str, attempt_id: str, payload: DiagnosisRequestIn):
    """Candidate error causes plus the follow-up questions that would settle them."""
    project = require_project(request.user, project_id)
    attempt = _attempt_scope(request.user, project, attempt_id)
    key = idempotency_key(request)
    scope = f"attempts.ai-diagnosis:{attempt_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        _assert_delivery_visible(attempt=attempt, action="读取 AI 诊断")
        return replay.status_code, replay.body
    try:
        result = diagnosis_services.propose_diagnosis(
            attempt=attempt, actor=request.user, learner_note=payload.learner_note
        )
    except providers.AiError as exc:
        _raise_ai_error(exc, action="AI 诊断")
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="error_diagnosis",
        resource_id=result["llm_run_id"],
    )
    return result


@practice_router.post("/projects/{project_id}/diagnosis-follow-ups/{follow_up_id}/answer", auth=auth)
def answer_diagnosis_follow_up(request, project_id: str, follow_up_id: str, payload: FollowUpAnswerIn):
    project = require_project(request.user, project_id)
    follow_up = _follow_up_scope(request.user, project, follow_up_id)
    follow_up = diagnosis_services.answer_follow_up(
        follow_up=follow_up, actor=request.user, text=payload.text
    )
    return diagnosis_services.follow_up_payload(follow_up)


@practice_router.post("/projects/{project_id}/diagnosis-follow-ups/{follow_up_id}/skip", auth=auth)
def skip_diagnosis_follow_up(request, project_id: str, follow_up_id: str):
    project = require_project(request.user, project_id)
    follow_up = _follow_up_scope(request.user, project, follow_up_id)
    follow_up = diagnosis_services.skip_follow_up(follow_up=follow_up, actor=request.user)
    return diagnosis_services.follow_up_payload(follow_up)
