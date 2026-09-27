"""Learning API: today's plan, tasks, evidence, states and review tasks."""

from __future__ import annotations

from typing import Any

from ninja import Router, Schema

from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key
from apps.common.enums import TaskStatus
from apps.common.errors import InvalidInput, ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.learning.models import LearnerKnowledgeState, StudyPlan, StudyTask
from apps.learning.services import evidence as evidence_service
from apps.learning.services import pairing as pairing_service
from apps.learning.services import planner as planner_service
from apps.learning.services import state as state_service

plan_tasks_router = Router(tags=["learning"])
learning_router = Router(tags=["learning"])


class PlanTaskOut(Schema):
    task_id: str
    task_kind: str
    status: str
    project_id: str
    subject_id: str
    question_id: str | None
    question_label: str
    knowledge_node_id: str | None
    knowledge_node_name: str
    estimated_minutes: int
    reason_codes: list[str]
    evidence_ids: list[str]
    not_before: str | None
    due_at: str | None
    delay_anchor_at: str | None
    delay_hours: int | None
    available_now: bool
    deficit_notice: str
    pairing_version: int | None


class TodayPlanOut(Schema):
    plan: dict[str, Any] | None
    tasks: list[PlanTaskOut]
    notes: list[str]
    backlog: list[dict[str, Any]] = []
    progress_notes: list[str] = []


class GeneratePlanIn(Schema):
    plan_date: str | None = None
    refresh: bool = False


class ReasonIn(Schema):
    reason: str = ""


def _today_payload(user) -> dict:
    plan = planner_service.current_plan(user)
    payload = planner_service.plan_payload(plan)
    payload["backlog"] = planner_service.backlog_summary(user=user)
    payload["progress_notes"] = planner_service.progress_notes(user=user)
    return payload


@plan_tasks_router.get("/study-plans/today", auth=auth, response=TodayPlanOut)
def get_today(request):
    """Today's plan. GET never changes the plan; an empty state is explicit."""
    return _today_payload(request.user)


@plan_tasks_router.post("/study-plans/today/generate", auth=auth, response=TodayPlanOut)
def generate_today(request, payload: GeneratePlanIn):
    """Create (or refresh) today's plan under the single global budget."""
    from datetime import date as date_cls

    key = idempotency_key(request)
    scope = "plans.generate"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    on_date = None
    if payload.plan_date:
        try:
            on_date = date_cls.fromisoformat(payload.plan_date)
        except ValueError as exc:
            raise InvalidInput(message="plan_date 必须是 YYYY-MM-DD") from exc
    plan = planner_service.generate_plan(user=request.user, on_date=on_date, refresh=payload.refresh)
    result = _today_payload(request.user)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="study_plan",
        resource_id=plan.id,
    )
    outbox.after_commit_dispatch()
    return result


@plan_tasks_router.post("/study-tasks/{task_id}/start", auth=auth)
def start_task(request, task_id: str):
    """Start a task; the question and the delay interval are re-checked."""
    key = idempotency_key(request)
    scope = f"tasks.start:{task_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    task, status = planner_service.start_task(user=request.user, task_id=task_id)
    result = {
        "task_id": str(task.id),
        "status": task.status,
        "project_id": str(task.project_id),
        "subject_id": str(task.subject_id),
        "question_id": str(task.question_id) if task.question_id else None,
        "delay_status": status,
        "create_session_hint": {
            "subject_id": str(task.subject_id),
            "question_ids": [str(task.question_id)] if task.question_id else [],
            "task_id": str(task.id),
            "purpose": task.task_kind,
        },
    }
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="study_task", resource_id=task.id
    )
    return result


@plan_tasks_router.post("/study-tasks/{task_id}/defer", auth=auth)
def defer_task(request, task_id: str, payload: ReasonIn):
    key = idempotency_key(request)
    scope = f"tasks.defer:{task_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    task = planner_service.defer_task(user=request.user, task_id=task_id, reason=payload.reason)
    result = {"task_id": str(task.id), "status": task.status, "reason_codes": task.reason_codes}
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="study_task", resource_id=task.id
    )
    return result


@plan_tasks_router.post("/study-tasks/{task_id}/skip", auth=auth)
def skip_task(request, task_id: str, payload: ReasonIn):
    key = idempotency_key(request)
    scope = f"tasks.skip:{task_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    task = planner_service.skip_task(user=request.user, task_id=task_id, reason=payload.reason)
    result = {"task_id": str(task.id), "status": task.status}
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="study_task", resource_id=task.id
    )
    return result


@plan_tasks_router.post("/study-tasks/{task_id}/complete", auth=auth)
def complete_task(request, task_id: str):
    """Complete a task without an attempt (for example reading material only)."""
    task = StudyTask.objects.filter(id=task_id, user=request.user).first()
    if task is None:
        raise ScopeViolation(message="任务不存在或不在当前权限范围")
    if task.status == TaskStatus.COMPLETED:
        return {"task_id": str(task.id), "status": task.status}
    from django.utils import timezone

    task.status = TaskStatus.COMPLETED
    task.completed_at = timezone.now()
    task.save(update_fields=["status", "completed_at", "updated_at"])
    return {
        "task_id": str(task.id),
        "status": task.status,
        "note": "未产生作答，因此不计入任何能力证据",
    }


@plan_tasks_router.get("/study-tasks/{task_id}", auth=auth)
def get_task(request, task_id: str):
    task = (
        StudyTask.objects.filter(id=task_id, user=request.user)
        .select_related("question", "knowledge_node", "subject", "project")
        .first()
    )
    if task is None:
        raise ScopeViolation(message="任务不存在或不在当前权限范围")
    review = getattr(task, "review_task", None)
    return {
        "task_id": str(task.id),
        "task_kind": task.task_kind,
        "status": task.status,
        "project_id": str(task.project_id),
        "subject_id": str(task.subject_id),
        "question_id": str(task.question_id) if task.question_id else None,
        "question_label": task.question.display_label if task.question_id else "",
        "knowledge_node_name": task.knowledge_node.canonical_name if task.knowledge_node_id else "",
        "estimated_minutes": task.estimated_minutes,
        "reason_codes": task.reason_codes,
        "evidence_ids": task.evidence_ids,
        "trigger_event": task.trigger_event,
        "deficit_notice": task.deficit_notice,
        "not_before": task.not_before.isoformat() if task.not_before else None,
        "delay_hours": review.delay_hours if review else None,
        "delay_anchor_at": task.delay_anchor_at.isoformat() if task.delay_anchor_at else None,
        "pairing_id": str(task.pairing_id) if task.pairing_id else None,
        "pairing_version": task.pairing_version,
        "origin_session_item_id": str(task.origin_session_item_id) if task.origin_session_item_id else None,
    }


@learning_router.get("/projects/{project_id}/plans/{plan_id}", auth=auth)
def get_plan(request, project_id: str, plan_id: str):
    """A plan is user-wide, but the route is project-scoped.

    The project must therefore exist and be owned by the caller; the plan row
    itself is resolved by user so a plan spanning two projects is still readable
    from either project's context.
    """
    project = require_project(request.user, project_id)
    plan = StudyPlan.objects.filter(id=plan_id, user=request.user).first()
    if plan is None:
        raise ScopeViolation(message="计划不存在或不在当前权限范围")
    payload = planner_service.plan_payload(plan)
    plan_project_ids = {task["project_id"] for task in payload.get("tasks") or []}
    payload["requested_project_id"] = str(project.id)
    payload["covers_requested_project"] = str(project.id) in plan_project_ids
    return payload


@learning_router.get("/projects/{project_id}/learning-states", auth=auth)
def list_states(request, project_id: str, subject_id: str | None = None):
    """Knowledge state with its evidence and the exact missing pieces."""
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    states = state_service.states_for_project(user=request.user, project=project, subject=subject)
    evidence_rows = evidence_service.evidence_summary_rows(user=request.user, project=project, limit=200)
    by_node: dict[str, list[dict]] = {}
    for row in evidence_rows:
        if row["node_id"]:
            by_node.setdefault(row["node_id"], []).append(row)
    for state in states:
        state["evidence"] = by_node.get(state["node_id"], [])
    return {
        "thresholds": {
            "distinct_questions": state_service.REQUIRED_DISTINCT_QUESTIONS,
            "distinct_templates": state_service.REQUIRED_DISTINCT_TEMPLATES,
            "recent_window": state_service.RECENT_WINDOW,
        },
        "rule_version": state_service.RULE_VERSION,
        "states": states,
    }


@learning_router.get("/projects/{project_id}/evidence", auth=auth)
def list_evidence(
    request,
    project_id: str,
    node_id: str | None = None,
    subject_id: str | None = None,
    dimension: str | None = None,
    limit: int = 100,
):
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    node = None
    if node_id:
        from apps.knowledge.models import KnowledgeNode

        node = KnowledgeNode.objects.filter(id=node_id, syllabus_version__subject__project=project).first()
        if node is None:
            raise ScopeViolation(message="考点不存在或不属于该项目")
    rows = evidence_service.evidence_summary_rows(
        user=request.user, project=project, node=node, limit=limit, subject=subject, dimension=dimension
    )
    return {
        "rule_version": evidence_service.RULE_VERSION,
        "rows": rows,
        "count": len(rows),
    }


@learning_router.get("/projects/{project_id}/mistakes", auth=auth)
def list_mistakes(request, project_id: str, subject_id: str | None = None, limit: int = 100):
    """Confirmed lost marks: fully graded attempts that did not reach full marks.

    A mistake is only listed once every scoring part is decided (so a partly
    human-graded answer is never shown as "wrong"), and never for a run whose
    grading is still hidden.
    """
    from apps.practice.services.mistakes import mistake_rows

    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    return {
        "rows": mistake_rows(user=request.user, project=project, subject=subject, limit=limit),
    }


@learning_router.get("/projects/{project_id}/review-tasks", auth=auth)
def list_review_tasks(request, project_id: str, subject_id: str | None = None, only_due: bool = False):
    """Delayed verification tasks with their real anchor and interval status."""
    from django.utils import timezone

    project = require_project(request.user, project_id)
    if subject_id:
        require_subject(request.user, project, subject_id)
    queryset = (
        StudyTask.objects.filter(user=request.user, project=project, task_kind="delayed_verification")
        .select_related("question", "knowledge_node", "review_task")
        .order_by("not_before")
    )
    if subject_id:
        queryset = queryset.filter(subject_id=subject_id)
    moment = timezone.now()
    rows = []
    for task in queryset:
        review = getattr(task, "review_task", None)
        status = pairing_service.delayed_interval_status(task=task, now=moment)
        if only_due and not status["satisfied"]:
            continue
        rows.append(
            {
                "task_id": str(task.id),
                "status": task.status,
                "subject_id": str(task.subject_id),
                "question_id": str(task.question_id) if task.question_id else None,
                "question_label": task.question.display_label if task.question_id else "",
                "knowledge_node_name": task.knowledge_node.canonical_name if task.knowledge_node_id else "",
                "delay_hours": review.delay_hours if review else None,
                "delay_anchor_at": task.delay_anchor_at.isoformat() if task.delay_anchor_at else None,
                "not_before": task.not_before.isoformat() if task.not_before else None,
                "due_now": status["satisfied"],
                "interval_reason": status["reason"],
                "anchor_source": review.anchor_source if review else "",
                "was_started": review.was_started if review else False,
                "deficit_notice": task.deficit_notice,
                "reason_codes": task.reason_codes,
            }
        )
    return {"now": moment.isoformat(), "rows": rows}


@learning_router.post("/projects/{project_id}/study-tasks/{task_id}/reconcile-delay", auth=auth)
def reconcile_delay(request, project_id: str, task_id: str):
    """Push a pending delayed task's deadline when a newer anchor appeared."""
    project = require_project(request.user, project_id)
    task = StudyTask.objects.filter(id=task_id, user=request.user, project=project).first()
    if task is None:
        raise ScopeViolation(message="任务不存在或不在当前权限范围")
    updated = pairing_service.reconcile_delayed_tasks()
    status = pairing_service.delayed_interval_status(task=task)
    return {"reconciled_tasks": updated, "task_id": str(task.id), "delay_status": status}


@learning_router.get("/projects/{project_id}/knowledge-states/{node_id}/evidence", auth=auth)
def node_evidence(request, project_id: str, node_id: str):
    project = require_project(request.user, project_id)
    from apps.knowledge.models import KnowledgeNode

    node = KnowledgeNode.objects.filter(id=node_id, syllabus_version__subject__project=project).first()
    if node is None:
        raise ScopeViolation(message="考点不存在或不属于该项目")
    state = LearnerKnowledgeState.objects.filter(user=request.user, project=project, node=node).first()
    return {
        "node_id": str(node.id),
        "node_name": node.canonical_name,
        "state": {
            "summary": state.summary,
            "best_summary": state.best_summary,
            "missing_evidence": (state.detail or {}).get("missing_evidence", []),
            "thresholds": (state.detail or {}).get("thresholds", {}),
            "rule_version": state.rule_version,
            "as_of": state.as_of.isoformat(),
        }
        if state
        else None,
        "evidence": evidence_service.evidence_summary_rows(user=request.user, project=project, node=node, limit=200),
        "exposures": _exposure_rows(request.user, node),
    }


def _exposure_rows(user, node) -> list[dict]:
    from apps.practice.models import ExposureEvent

    rows = (
        ExposureEvent.objects.filter(user=user, question_version__knowledge_mappings__node=node)
        .order_by("-server_time")
        .distinct()[:50]
    )
    return [
        {
            "kind": row.kind,
            "purpose": row.purpose,
            "source": row.source,
            "reveals_answer": row.reveals_answer,
            "server_time": row.server_time.isoformat(),
        }
        for row in rows
    ]
