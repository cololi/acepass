"""Analytics API: practice reports, coverage and auditable regrades."""

from __future__ import annotations

from typing import Any

from ninja import Router, Schema

from apps.analytics.models import RegradeRun, ReportSnapshot
from apps.analytics.services import reports as report_service
from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.errors import ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.question_bank.models import AnswerKeyVersion, Question, RubricVersion

analytics_router = project_scoped_router(tags=["analytics"])
regrade_router = Router(tags=["analytics"])


class ReportOut(Schema):
    report_kind: str
    calculation_version: str
    as_of: str
    project_id: str
    subject_id: str | None
    totals: dict[str, Any]
    by_question_type: dict[str, Any]
    by_knowledge_node: dict[str, Any]
    excluded_evidence: list[dict[str, Any]]
    notes: list[str]
    #: Attempts excluded from every bucket because their run is still hidden.
    hidden_verification_attempts: int = 0


class RegradeIn(Schema):
    question_id: str
    target_answer_key_version_id: str
    target_rubric_version_id: str | None = None
    reason: str
    scope: str = "all_attempts"


class RegradeOut(Schema):
    regrade_run_id: str
    status: str
    question_id: str
    target_answer_key_version_id: str
    target_rubric_version_id: str | None
    scope: str
    reason: str
    generation: int = 0
    affected_attempts: int
    regraded_attempts: int
    stale_skipped_attempts: int = 0
    invalidated_evidence: int
    error_message: str
    created_at: str
    finished_at: str | None


@analytics_router.get("/projects/{project_id}/reports/practice", auth=auth, response=ReportOut)
def practice_report(request, project_id: str, subject_id: str | None = None, save_snapshot: bool = True):
    """Practice report with explicit exclusions and sample sizes."""
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    return report_service.build_practice_report(
        user=request.user, project=project, subject=subject, save_snapshot=save_snapshot
    )


@analytics_router.get("/projects/{project_id}/reports/snapshots", auth=auth)
def list_snapshots(request, project_id: str, limit: int = 10):
    project = require_project(request.user, project_id)
    rows = ReportSnapshot.objects.filter(user=request.user, project=project).order_by("-as_of")[
        : max(1, min(limit, 50))
    ]
    return [
        {
            "snapshot_id": str(row.id),
            "report_kind": row.report_kind,
            "as_of": row.as_of.isoformat(),
            "calculation_version": row.calculation_version,
            "is_stale": row.is_stale,
            "input_watermark": row.input_watermark,
            "notes": row.notes,
            "payload": row.payload,
        }
        for row in rows
    ]


@analytics_router.get("/projects/{project_id}/papers/coverage", auth=auth)
def paper_coverage(request, project_id: str, subject_id: str):
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id)
    return {
        "subject_id": str(subject.id),
        "coverage_note": (
            "P0 只登记真实发生记录与完整性标记，不做年度占比统计；"
            "缺少预期场次时周期为 coverage_unknown，不冒充完整年度。"
        ),
        "papers": report_service.paper_coverage(subject=subject),
    }


@regrade_router.post("/projects/{project_id}/regrades", auth=auth, response={201: RegradeOut})
def create_regrade(request, project_id: str, payload: RegradeIn):
    """Start a regrade against a reviewed answer version."""
    project = require_project(request.user, project_id)
    question = Question.objects.filter(id=payload.question_id, subject__project=project).first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    answer = AnswerKeyVersion.objects.filter(
        id=payload.target_answer_key_version_id, question_version__question=question
    ).first()
    if answer is None:
        raise ScopeViolation(message="目标答案版本不存在或不属于该题目")
    rubric = None
    if payload.target_rubric_version_id:
        rubric = RubricVersion.objects.filter(id=payload.target_rubric_version_id).first()
        if rubric is None or rubric.answer_key_version_id != answer.id:
            raise ScopeViolation(message="目标 rubric 不存在或不属于该答案版本")
    if not payload.reason.strip():
        from apps.common.errors import InvalidInput

        raise InvalidInput(message="重判必须说明原因")
    key = idempotency_key(request)
    scope = f"regrades.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    run = report_service.request_regrade(
        question=question,
        target_answer_key_version=answer,
        target_rubric_version=rubric,
        actor=request.user,
        reason=payload.reason,
        scope=payload.scope,
    )
    result = report_service.regrade_payload(run)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="regrade_run",
        resource_id=run.id,
    )
    outbox.after_commit_dispatch()
    return 201, result


@regrade_router.get("/projects/{project_id}/regrades/{regrade_id}", auth=auth, response=RegradeOut)
def get_regrade(request, project_id: str, regrade_id: str):
    project = require_project(request.user, project_id)
    run = RegradeRun.objects.filter(id=regrade_id, project=project).first()
    if run is None:
        raise ScopeViolation(message="重判任务不存在或不属于该项目")
    return report_service.regrade_payload(run)


@regrade_router.post("/projects/{project_id}/regrades/{regrade_id}/run", auth=auth, response=RegradeOut)
def run_regrade_now(request, project_id: str, regrade_id: str):
    """Run a queued regrade inline (idempotent; a worker may also pick it up)."""
    project = require_project(request.user, project_id)
    run = RegradeRun.objects.filter(id=regrade_id, project=project).first()
    if run is None:
        raise ScopeViolation(message="重判任务不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"regrades.run:{regrade_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    report_service.execute_regrade_run(str(run.id))
    run.refresh_from_db()
    result = report_service.regrade_payload(run)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="regrade_run",
        resource_id=run.id,
    )
    return result


@regrade_router.get("/projects/{project_id}/answer-reviews", auth=auth)
def pending_answer_reviews(request, project_id: str):
    """Answers that need attention, with their regrade eligibility.

    This queue deliberately includes *trusted* (``checked`` and undisputed)
    answers as well: those are the only ones a regrade may target, so excluding
    them made the regrade action unreachable from the UI. Disputed answers are
    listed too, marked ineligible.
    """
    from django.db.models import Q as _Q

    from apps.common.enums import VerificationStatus

    project = require_project(request.user, project_id)
    queryset = (
        AnswerKeyVersion.objects.filter(question_version__question__subject__project=project)
        .filter(
            _Q(verification_status__in=[VerificationStatus.PENDING, VerificationStatus.CHECKED])
            | _Q(is_disputed=True)
        )
        .select_related("question_version__question", "rubric")
    )
    rows = []
    for answer in queryset.order_by("-created_at")[:200]:
        rubric = getattr(answer, "rubric", None)
        rows.append(
            {
                "answer_key_version_id": str(answer.id),
                "question_id": str(answer.question_version.question_id),
                "display_label": answer.question_version.question.display_label,
                "question_version_id": str(answer.question_version_id),
                "answer_version": answer.version,
                "verification_status": answer.verification_status,
                "source_type": answer.source_type,
                "check_basis": answer.check_basis,
                "is_disputed": answer.is_disputed,
                "dispute_reason": answer.dispute_reason,
                "is_usable": answer.is_usable,
                "can_regrade": bool(answer.is_usable),
                "rubric_version_id": str(rubric.id) if rubric is not None else None,
            }
        )
    return rows
