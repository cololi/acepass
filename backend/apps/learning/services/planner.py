"""Daily planning under one global budget.

Order of work (docs/03 §6): due delayed verification/review -> confirmed weak
points -> undiagnosed knowledge points -> other practice. The global budget is
split across active projects with the largest-remainder method, and the split
snapshot (project set + rotation offset) is stored on the plan so a same-day
retry is deterministic.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from apps.common.enums import (
    AnswerSourceType,
    EvidenceDimension,
    KnowledgeStateSummary,
    QuestionVersionStatus,
    SessionStatus,
    TaskKind,
    TaskStatus,
)
from apps.common.errors import InvalidInput, ScopeViolation
from apps.exams.models import ExamProject
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge, VerificationPairing
from apps.knowledge.services import relations as relations_service
from apps.learning.models import LearnerKnowledgeState, StudyPlan, StudyTask
from apps.learning.services import pairing as pairing_service
from apps.memory.services import scheduler as memory_service
from apps.practice.models import LearningEvidence, PracticeSession
from apps.question_bank.models import Question
from apps.question_bank.services import sealing

RULE_VERSION = "p0-1"
DEFAULT_MINUTES_BY_TYPE = {"constructed_response": 15, "fill_blank": 3}


def active_projects(user):
    return list(ExamProject.objects.filter(owner=user, is_archived=False).order_by("display_order", "created_at"))


def allocate_budget(user, projects: list[ExamProject], budget_minutes: int, on_date: date) -> dict:
    """Split the integer budget across projects.

    Base order: target date, then creation time. The daily rotation shift is
    ``days_since_epoch % active_project_count`` so the same project is not always
    first. Remainders go out by largest fractional part, then by rotated order,
    which keeps a same-day retry identical.
    """
    if not projects:
        return {"projects": [], "notes": ["没有进行中的项目"], "rotation_offset": 0, "project_order": []}
    settings_obj = getattr(user, "settings", None)
    percentages = dict(getattr(settings_obj, "project_budget_percent", {}) or {})
    ordered = sorted(projects, key=lambda project: (project.target_date or date.max, project.created_at))
    offset = (on_date - date(1970, 1, 1)).days % len(ordered)
    rotated = ordered[offset:] + ordered[:offset]

    notes: list[str] = []
    if percentages:
        raw = [(project, float(percentages.get(str(project.id), 0.0))) for project in ordered]
        assigned_percent = sum(percent for _project, percent in raw)
        if assigned_percent < 100:
            notes.append(f"用户指定比例合计 {assigned_percent:g}%，其余 {100 - assigned_percent:g}% 不分配")
        if assigned_percent <= 0:
            notes.append("用户指定比例均为 0：本日不分配任何项目时间")
    else:
        raw = [(project, 100.0 / len(ordered)) for project in ordered]
        notes.append("未指定项目比例：按进行中项目等分")

    base: dict[str, int] = {}
    fractions: dict[str, tuple[float, int]] = {}
    for project, percent in raw:
        value = budget_minutes * percent / 100.0
        floor = int(value)
        base[str(project.id)] = floor
        fractions[str(project.id)] = (value - floor, _rotation_rank(rotated, project))
    remainder = budget_minutes - sum(base.values())
    for project_id, (_fraction, _rank) in sorted(fractions.items(), key=lambda pair: (-pair[1][0], pair[1][1])):
        if remainder <= 0:
            break
        base[project_id] += 1
        remainder -= 1

    allocations = [
        {
            "project_id": str(project.id),
            "project_name": project.name,
            "percent": round(percent, 4),
            "minutes": base[str(project.id)],
        }
        for project, percent in raw
    ]
    allocations.sort(key=lambda row: _rotation_rank(rotated, next(p for p in ordered if str(p.id) == row["project_id"])))
    return {
        "projects": allocations,
        "notes": notes,
        "rotation_offset": offset,
        "project_order": [str(project.id) for project in ordered],
    }


def _rotation_rank(rotated: list[ExamProject], project: ExamProject) -> int:
    for index, item in enumerate(rotated):
        if item.id == project.id:
            return index
    return len(rotated)


# --------------------------------------------------------------------------
# Candidate selection
# --------------------------------------------------------------------------
def _question_minutes(question: Question) -> int:
    version = question.current_published_version or question.versions.order_by("-version").first()
    if version is None:
        return 2
    if version.estimated_seconds:
        return max(1, round(version.estimated_seconds / 60))
    return DEFAULT_MINUTES_BY_TYPE.get(version.question_type, 2)


def _eligible_question(question: Question | None) -> tuple[bool, str]:
    if question is None:
        return False, "没有关联题目"
    version = question.current_published_version
    if version is None or version.status != QuestionVersionStatus.PUBLISHED:
        return False, "题目没有已发布版本"
    # C03: sealing is checked through the single resolver, on every candidate
    # category at once — a sealed question can never be scheduled, no matter
    # whether it arrived through a mapping, a pairing, a memory card or the
    # general pool (and `start_task` re-checks the same function).
    sealed, seal_code = sealing.is_sealed(question)
    if sealed:
        return False, sealing.reason_message(seal_code)
    answer = version.answer_keys.filter(verification_status="checked", is_disputed=False).first()
    if answer is None:
        return False, "题目缺少已核对且无争议的答案"
    if answer.source_type == AnswerSourceType.AI_DERIVED:
        return False, "AI 推导答案尚未通过独立验证"
    return True, ""


def delayed_task_candidates(*, user, project, now=None, limit: int = 20) -> list[dict]:
    """Due delayed verification tasks, earliest deadline first."""
    moment = now or timezone.now()
    queryset = (
        StudyTask.objects.filter(
            user=user,
            project=project,
            task_kind=TaskKind.DELAYED_VERIFICATION,
            status__in=[TaskStatus.PENDING, TaskStatus.DEFERRED],
        )
        .filter(not_before__lte=moment)
        .select_related("question", "knowledge_node")
        .order_by("not_before")
    )
    rows = []
    for task in queryset[: max(1, min(limit, 100))]:
        ok, _reason = _eligible_question(task.question)
        if not ok:
            continue
        status = pairing_service.delayed_interval_status(task=task, now=moment)
        if not status["satisfied"]:
            continue
        rows.append(_task_candidate(task, reason_codes=["due_delayed_verification"], status=status))
    return rows


def _task_candidate(task: StudyTask, *, reason_codes: list[str], status: dict | None = None) -> dict:
    return {
        "task_id": str(task.id),
        "task_kind": task.task_kind,
        "question_id": str(task.question_id) if task.question_id else None,
        "question_label": task.question.display_label if task.question_id else "",
        "knowledge_node_id": str(task.knowledge_node_id) if task.knowledge_node_id else None,
        "knowledge_node_name": task.knowledge_node.canonical_name if task.knowledge_node_id else "",
        "project_id": str(task.project_id),
        "subject_id": str(task.subject_id),
        "estimated_minutes": task.estimated_minutes,
        "reason_codes": reason_codes + list(task.reason_codes or []),
        "evidence_ids": list(task.evidence_ids or []),
        "pairing_version": task.pairing_version,
        "not_before": status.get("not_before") if status else None,
        "deficit_notice": task.deficit_notice,
    }


def _question_for_node(*, project, node_id) -> Question | None:
    """Best eligible question for one node: a reviewed pairing, else a mapping."""
    for pairing in VerificationPairing.objects.filter(
        project=project, node_id=node_id, is_active=True
    ).select_related("immediate_question"):
        ok, _reason = _eligible_question(pairing.immediate_question)
        if ok:
            return pairing.immediate_question
    mapping = (
        QuestionKnowledge.objects.filter(node_id=node_id, is_primary=True, question_version__status="published")
        .select_related("question_version__question")
        .first()
    )
    if mapping is None:
        return None
    question = mapping.question_version.question
    ok, _reason = _eligible_question(question)
    return question if ok else None


def memory_review_candidates(*, user, project, now=None, limit: int = 10) -> list[dict]:
    """Due FSRS cards, highest priority first, as explainable plan candidates.

    A card is only offered when its question still has a published version and a
    checked answer, exactly like every other task: a withdrawn question must not
    come back through the memory channel. Memory review is a *recall* exercise,
    so the task carries ``memory_card`` and never claims solving ability.
    """
    rows: list[dict] = []
    moment = now or timezone.now()
    for item in memory_service.review_candidates(user=user, project=project, now=moment, limit=limit):
        due_at = memory_service.parse_moment(item.get("due_at"))
        if due_at is not None and due_at > moment:
            # Only work that is actually due enters today's plan; a card that is
            # still waiting out its interval is not "reviewed early".
            continue
        question = Question.objects.filter(id=item["question_id"]).first()
        ok, _reason = _eligible_question(question)
        if not ok:
            continue
        rows.append(
            {
                "task_id": None,
                "task_kind": TaskKind.MEMORY_REVIEW,
                "question_id": str(question.id),
                "question_label": question.display_label,
                "knowledge_node_id": item.get("knowledge_node_id"),
                "knowledge_node_name": item.get("knowledge_node_name", ""),
                "project_id": str(project.id),
                "subject_id": item["subject_id"],
                # Recall is deliberately cheap: half of the solving estimate, at least a minute.
                "estimated_minutes": max(1, _question_minutes(question) // 2),
                "reason_codes": ["memory_due", *list(item.get("reason_codes") or [])],
                "evidence_ids": [],
                "pairing_version": None,
                "not_before": None,
                "deficit_notice": "",
                "memory_card_id": item["card_id"],
            }
        )
    return rows


def weakly_known_candidates(*, user, project, limit: int = 20) -> list[dict]:
    """Confirmed weak points, reordered by the prerequisite graph.

    A weak point whose foundation is not demonstrated yet is not practised
    directly: the prerequisite is scheduled first and the reason codes say so.
    When the prerequisite has no eligible question the weak point is still
    offered, but the missing foundation is reported instead of hidden.
    """
    rows: list[dict] = []
    states = list(
        LearnerKnowledgeState.objects.filter(user=user, project=project, needs_review=True)
        .select_related("node", "syllabus_version")
        .order_by("-needs_review", "as_of")[: max(1, min(limit, 50))]
    )
    state_by_node = {
        str(node_id): summary
        for node_id, summary in LearnerKnowledgeState.objects.filter(user=user, project=project).values_list(
            "node_id", "summary"
        )
    }
    scheduled_questions: set[str] = set()
    for state in states:
        unmet = relations_service.unmet_prerequisites(node=state.node, state_by_node=state_by_node)
        chosen = None
        target = state.node
        used_fallback = False
        reason_codes = ["weakness_repair", f"state_{state.summary}"]
        if unmet:
            for gap in unmet:
                question = _question_for_node(project=project, node_id=gap["node_id"])
                if question is None:
                    continue
                chosen = question
                target = KnowledgeNode.objects.get(id=gap["node_id"])
                reason_codes = [
                    "prerequisite_first",
                    gap["reason"],
                    f"unblocks:{state.node.canonical_name}"[:120],
                    f"blocked_state_{state.summary}",
                ]
                break
            if chosen is None:
                used_fallback = True
                reason_codes.append("prerequisite_missing_question")
        if chosen is None:
            chosen = _question_for_node(project=project, node_id=state.node_id)
            target = state.node
        if chosen is None or str(chosen.id) in scheduled_questions:
            continue
        scheduled_questions.add(str(chosen.id))
        deficit_notice = ""
        if unmet and used_fallback:
            deficit_notice = (
                f"前置考点「{unmet[0]['node_name']}」尚无可练习题目：先用可用题目练习，前置缺口已记录，不计入该考点的独立掌握证据"
            )
        rows.append(
            {
                "task_id": None,
                "task_kind": TaskKind.WEAKNESS_REPAIR,
                "question_id": str(chosen.id),
                "question_label": chosen.display_label,
                "knowledge_node_id": str(target.id),
                "knowledge_node_name": target.canonical_name,
                "project_id": str(project.id),
                "subject_id": str(chosen.subject_id),
                "estimated_minutes": _question_minutes(chosen),
                "reason_codes": reason_codes,
                "evidence_ids": list(state.source_evidence_ids or [])[:10],
                "pairing_version": None,
                "not_before": None,
                "deficit_notice": deficit_notice,
            }
        )
    return rows


def undiagnosed_candidates(*, user, project, limit: int = 20) -> list[dict]:
    """Nodes with no state yet, paired with an eligible question."""
    rows: list[dict] = []
    # The queryset yields UUID objects, while ``mapping.node_id`` is stringified below. Comparing a
    # UUID against a ``str`` is always False, which silently turned every node with an existing state
    # back into an "undiagnosed" candidate (B10 W3). Normalise once, on the way in.
    diagnosed = {
        str(node_id)
        for node_id in LearnerKnowledgeState.objects.filter(user=user, project=project).values_list(
            "node_id", flat=True
        )
    }
    mappings = (
        QuestionKnowledge.objects.filter(
            question_version__status="published",
            question_version__question__subject__project=project,
            is_primary=True,
        )
        .select_related("question_version__question", "node")
        .order_by("node__canonical_name")
    )
    seen_nodes: set[str] = set()
    for mapping in mappings:
        node_id = str(mapping.node_id)
        if node_id in diagnosed or node_id in seen_nodes:
            continue
        question = mapping.question_version.question
        ok, _reason = _eligible_question(question)
        if not ok:
            continue
        seen_nodes.add(node_id)
        rows.append(
            {
                "task_id": None,
                "task_kind": TaskKind.UNDIAGNOSED_PROBE,
                "question_id": str(question.id),
                "question_label": question.display_label,
                "knowledge_node_id": node_id,
                "knowledge_node_name": mapping.node.canonical_name,
                "project_id": str(project.id),
                "subject_id": str(question.subject_id),
                "estimated_minutes": _question_minutes(question),
                "reason_codes": ["undiagnosed_node"],
                "evidence_ids": [],
                "pairing_version": None,
                "not_before": None,
                "deficit_notice": "",
            }
        )
        if len(rows) >= limit:
            break
    return rows


def general_candidates(*, user, project, limit: int = 20) -> list[dict]:
    """Other eligible published questions, for filling remaining time."""
    rows: list[dict] = []
    questions = (
        Question.objects.filter(subject__project=project, current_published_version__status="published")
        .select_related("current_published_version")
        .order_by("display_label")[: max(1, min(limit, 50))]
    )
    for question in questions:
        ok, _reason = _eligible_question(question)
        if not ok:
            continue
        rows.append(
            {
                "task_id": None,
                "task_kind": TaskKind.GENERAL_PRACTICE,
                "question_id": str(question.id),
                "question_label": question.display_label,
                "knowledge_node_id": None,
                "knowledge_node_name": "",
                "project_id": str(project.id),
                "subject_id": str(question.subject_id),
                "estimated_minutes": _question_minutes(question),
                "reason_codes": ["general_practice"],
                "evidence_ids": [],
                "pairing_version": None,
                "not_before": None,
                "deficit_notice": "",
            }
        )
    return rows


# --------------------------------------------------------------------------
# Plan generation
# --------------------------------------------------------------------------
def current_plan(user, on_date: date | None = None, revision: int | None = None) -> StudyPlan | None:
    settings_obj = getattr(user, "settings", None)
    local_date = on_date or (settings_obj.local_date() if settings_obj else timezone.now().date())
    queryset = StudyPlan.objects.filter(user=user, plan_date=local_date).order_by("-revision")
    if revision is not None:
        queryset = queryset.filter(revision=revision)
    return queryset.first()


@transaction.atomic
def generate_plan(*, user, on_date: date | None = None, refresh: bool = False, now=None) -> StudyPlan:
    """Build (or refresh) today's plan.

    A refresh creates a new revision and only replaces tasks that have not
    started; completed or in-progress work is kept.
    """
    moment = now or timezone.now()
    settings_obj = getattr(user, "settings", None)
    local_date = on_date or (settings_obj.local_date(moment) if settings_obj else moment.date())
    budget = int(getattr(settings_obj, "daily_budget_minutes", settings.DEFAULT_DAILY_BUDGET_MINUTES))
    undiagnosed_share = int(
        getattr(settings_obj, "undiagnosed_time_share_percent", settings.UNDIAGNOSED_TIME_SHARE_PERCENT)
    )
    projects = active_projects(user)
    existing = current_plan(user, local_date)
    if existing is not None and not refresh:
        return existing

    allocation = allocate_budget(user, projects, budget, local_date)
    revision = (existing.revision + 1) if existing is not None else 1
    plan = StudyPlan.objects.create(
        user=user,
        plan_date=local_date,
        timezone=getattr(settings_obj, "timezone", "UTC"),
        revision=revision,
        daily_budget_minutes=budget,
        allocated_minutes=0,
        allocation=allocation["projects"],
        project_order=allocation.get("project_order", []),
        rotation_offset=allocation.get("rotation_offset", 0),
        rule_version=RULE_VERSION,
        notes=list(allocation.get("notes", [])),
        generated_at=moment,
    )
    if existing is not None:
        existing.tasks.filter(status__in=[TaskStatus.PENDING, TaskStatus.DEFERRED]).update(
            status=TaskStatus.SKIPPED,
            invalidated_reason="计划刷新后被新修订替换",
            updated_at=moment,
        )

    planned_minutes = 0
    notes: list[str] = []
    for project_allocation in allocation["projects"]:
        project = ExamProject.objects.get(id=project_allocation["project_id"])
        project_minutes = project_allocation["minutes"]
        if project_minutes <= 0:
            notes.append(f"{project.name}：本日分配 0 分钟，未安排任务（预算不足以容纳任何题目）")
            continue
        result = _plan_project(
            user=user,
            project=project,
            plan=plan,
            minutes=project_minutes,
            undiagnosed_share=undiagnosed_share,
            now=moment,
        )
        planned_minutes += result["planned_minutes"]
        notes.extend(result["notes"])

    plan.allocated_minutes = planned_minutes
    plan.notes = list(plan.notes) + notes
    plan.save(update_fields=["allocated_minutes", "notes", "updated_at"])
    enqueue_plan_event(plan)
    return plan


def _plan_project(*, user, project, plan, minutes: int, undiagnosed_share: int, now) -> dict:
    """Fill one project's share using the fixed category order."""
    remaining = minutes
    planned = 0
    notes: list[str] = []
    reserve = int(minutes * undiagnosed_share / 100)
    categories = [
        ("due_delayed_verification", delayed_task_candidates(user=user, project=project, now=now)),
        ("memory_review", memory_review_candidates(user=user, project=project, now=now)),
        ("weakness_repair", weakly_known_candidates(user=user, project=project)),
        ("undiagnosed_probe", undiagnosed_candidates(user=user, project=project)),
        ("general_practice", general_candidates(user=user, project=project)),
    ]
    reserve_used = 0
    for category, candidates in categories:
        for candidate in candidates:
            cost = max(1, int(candidate["estimated_minutes"]))
            if cost > remaining:
                continue
            task = _materialise_task(user=user, project=project, plan=plan, candidate=candidate)
            if task is None:
                continue
            remaining -= cost
            planned += cost
            if category == "undiagnosed_probe":
                reserve_used += cost
        if remaining <= 0:
            break
    if reserve > 0 and reserve_used < reserve:
        notes.append(
            f"{project.name}：未诊断内容预留 {reserve} 分钟，本日实际安排 {reserve_used} 分钟（无更多合格未诊断题）"
        )
    if remaining > 0:
        notes.append(f"{project.name}：仍有 {remaining} 分钟未分配（没有能完整容纳的合格题目）")
    return {"planned_minutes": planned, "notes": notes, "remaining": remaining}


def _materialise_task(*, user, project, plan, candidate: dict) -> StudyTask | None:
    if candidate.get("task_id"):
        task = StudyTask.objects.filter(
            id=candidate["task_id"], user=user, status__in=[TaskStatus.PENDING, TaskStatus.DEFERRED]
        ).first()
        if task is None:
            return None
        task.plan = plan
        task.reason_codes = list(candidate["reason_codes"])
        task.save(update_fields=["plan", "reason_codes", "updated_at"])
        return task
    question = Question.objects.filter(id=candidate["question_id"]).first()
    if question is None:
        return None
    memory_card_id = candidate.get("memory_card_id")
    if memory_card_id:
        # A refresh must not queue the same card twice: reuse the open task.
        existing = StudyTask.objects.filter(
            user=user,
            memory_card_id=memory_card_id,
            task_kind=TaskKind.MEMORY_REVIEW,
            status__in=[TaskStatus.PENDING, TaskStatus.DEFERRED],
        ).first()
        if existing is not None:
            existing.plan = plan
            existing.reason_codes = list(candidate["reason_codes"])
            existing.save(update_fields=["plan", "reason_codes", "updated_at"])
            return existing
    return StudyTask.objects.create(
        plan=plan,
        user=user,
        project=project,
        subject_id=candidate["subject_id"],
        task_kind=candidate["task_kind"],
        status=TaskStatus.PENDING,
        question=question,
        knowledge_node_id=candidate.get("knowledge_node_id"),
        memory_card_id=memory_card_id,
        estimated_minutes=max(1, int(candidate["estimated_minutes"])),
        reason_codes=list(candidate["reason_codes"]),
        evidence_ids=list(candidate.get("evidence_ids") or [])[:20],
        rule_version=RULE_VERSION,
    )


def enqueue_plan_event(plan: StudyPlan) -> None:
    from apps.audit.services.outbox import enqueue

    enqueue("learning.reconcile_plan", {"plan_id": str(plan.id)}, dedupe_key=f"plan:{plan.id}")


@transaction.atomic
def reconcile_plan(*, plan_id: str = "") -> str:
    """Bring a generated plan back in line with the current evidence.

    Registered consumer for ``learning.reconcile_plan``. It is idempotent by
    design: it re-anchors delayed tasks whose anchor moved, records what it did
    on the plan, and never creates a second copy of an existing task. A missing
    or already-superseded plan is reported, not treated as an error.
    """
    if not plan_id:
        updated = pairing_service.reconcile_delayed_tasks()
        return f"plan_missing delayed_updated={updated}"
    plan = StudyPlan.objects.filter(id=plan_id).first()
    if plan is None:
        return "plan_missing"
    moment = timezone.now()
    newer = StudyPlan.objects.filter(
        user_id=plan.user_id, plan_date=plan.plan_date, revision__gt=plan.revision
    ).exists()
    updated = pairing_service.reconcile_delayed_tasks()
    open_tasks = list(
        plan.tasks.filter(status__in=[TaskStatus.PENDING, TaskStatus.DEFERRED]).select_related("review_task")
    )
    for task in open_tasks:
        _refresh_task_due_date(task)
    plan.notes = list(plan.notes or []) + [
        f"计划核对：{moment.isoformat()}，未开始任务 {len(open_tasks)} 个，延迟锚点顺延 {updated} 个"
        + ("（该修订已被更新修订取代）" if newer else "")
    ]
    plan.save(update_fields=["notes", "updated_at"])
    return f"pending={len(open_tasks)} delayed_updated={updated} superseded={bool(newer)}"


def _refresh_task_due_date(task: StudyTask) -> None:
    """Recompute a task's due date from its own stored rule, without inventing one."""
    review = getattr(task, "review_task", None)
    if review is None:
        return
    expected = review.not_before
    if task.not_before != expected or task.due_at != expected:
        task.not_before = expected
        task.due_at = expected
        task.delay_anchor_at = review.delay_anchor_at
        task.save(update_fields=["not_before", "due_at", "delay_anchor_at", "updated_at"])


def plan_payload(plan: StudyPlan | None, *, now=None) -> dict:
    if plan is None:
        return {"plan": None, "tasks": [], "notes": ["今日还没有计划：可点击“生成今日计划”"]}
    moment = now or timezone.now()
    rows = list(
        plan.tasks.select_related("question", "knowledge_node", "subject", "review_task").order_by("created_at")
    )
    # C03: a task created before its question was sealed must not be *shown* as
    # part of today's plan either — the plan payload is the surface the learner
    # reads, so the resolver decides here too (the candidates above never build
    # such a task in the first place).
    sealed_ids: set[str] = set()
    questions_by_project: dict[str, list[str]] = {}
    for task in rows:
        if task.question_id:
            questions_by_project.setdefault(str(task.project_id), []).append(str(task.question_id))
    for project_id, question_ids in questions_by_project.items():
        sealed_ids |= sealing.sealed_question_ids(project=project_id, question_ids=question_ids)
    tasks = []
    hidden_sealed = 0
    for task in rows:
        review = getattr(task, "review_task", None)
        if task.question_id and str(task.question_id) in sealed_ids:
            hidden_sealed += 1
            continue
        tasks.append(
            {
                "task_id": str(task.id),
                "task_kind": task.task_kind,
                "status": task.status,
                "project_id": str(task.project_id),
                "subject_id": str(task.subject_id),
                "question_id": str(task.question_id) if task.question_id else None,
                "question_label": task.question.display_label if task.question_id else "",
                "knowledge_node_id": str(task.knowledge_node_id) if task.knowledge_node_id else None,
                "knowledge_node_name": task.knowledge_node.canonical_name if task.knowledge_node_id else "",
                "estimated_minutes": task.estimated_minutes,
                "reason_codes": task.reason_codes,
                "evidence_ids": task.evidence_ids,
                "not_before": task.not_before.isoformat() if task.not_before else None,
                "due_at": task.due_at.isoformat() if task.due_at else None,
                "delay_anchor_at": task.delay_anchor_at.isoformat() if task.delay_anchor_at else None,
                "delay_hours": review.delay_hours if review else None,
                "available_now": (task.not_before is None or task.not_before <= moment),
                "deficit_notice": task.deficit_notice,
                "pairing_version": task.pairing_version,
            }
        )
    return {
        "plan": {
            "plan_id": str(plan.id),
            "plan_date": plan.plan_date.isoformat(),
            "revision": plan.revision,
            "timezone": plan.timezone,
            "daily_budget_minutes": plan.daily_budget_minutes,
            "allocated_minutes": plan.allocated_minutes,
            "allocation": plan.allocation,
            "rotation_offset": plan.rotation_offset,
            "rule_version": plan.rule_version,
            "generated_at": plan.generated_at.isoformat(),
        },
        "tasks": tasks,
        "notes": list(plan.notes or [])
        + ([f"有 {hidden_sealed} 个任务因题目已封存（holdout）未在本计划中展示。"] if hidden_sealed else []),
    }


def start_task(*, user, task_id: str, now=None) -> tuple[StudyTask, dict]:
    """Start a task after re-validating that the question is still usable."""
    task = (
        StudyTask.objects.filter(id=task_id, user=user).select_related("question", "subject", "project").first()
    )
    if task is None:
        raise ScopeViolation(message="任务不存在或不在当前权限范围")
    if task.project.is_archived:
        raise InvalidInput(message="项目已归档，任务不可开始")
    if task.status in {TaskStatus.COMPLETED, TaskStatus.SKIPPED, TaskStatus.INVALIDATED}:
        raise InvalidInput(message=f"任务状态为 {task.status}，不能开始", details={"status": task.status})
    ok, reason = _eligible_question(task.question)
    if not ok:
        task.status = TaskStatus.INVALIDATED
        task.invalidated_reason = reason
        task.save(update_fields=["status", "invalidated_reason", "updated_at"])
        raise InvalidInput(message=f"题目当前不可用：{reason}")
    status = pairing_service.delayed_interval_status(task=task, now=now)
    if not status["satisfied"]:
        raise InvalidInput(message=status["reason"], details={"not_before": status.get("not_before")})
    review = getattr(task, "review_task", None)
    if review is not None and not review.was_started:
        review.was_started = True
        review.save(update_fields=["was_started", "updated_at"])
    task.status = TaskStatus.IN_PROGRESS
    task.started_at = task.started_at or (now or timezone.now())
    task.save(update_fields=["status", "started_at", "updated_at"])
    return task, status


def defer_task(*, user, task_id: str, reason: str = "") -> StudyTask:
    task = StudyTask.objects.filter(id=task_id, user=user).first()
    if task is None:
        raise ScopeViolation(message="任务不存在或不在当前权限范围")
    if task.status == TaskStatus.COMPLETED:
        raise InvalidInput(message="已完成任务不能顺延")
    task.status = TaskStatus.DEFERRED
    task.reason_codes = list(task.reason_codes or []) + [f"deferred:{reason[:60] or 'user'}"]
    task.save(update_fields=["status", "reason_codes", "updated_at"])
    return task


def skip_task(*, user, task_id: str, reason: str = "") -> StudyTask:
    task = StudyTask.objects.filter(id=task_id, user=user).first()
    if task is None:
        raise ScopeViolation(message="任务不存在或不在当前权限范围")
    task.status = TaskStatus.SKIPPED
    task.invalidated_reason = reason[:300]
    task.save(update_fields=["status", "invalidated_reason", "updated_at"])
    return task


def backlog_summary(*, user, now=None) -> list[dict]:
    """Overdue tasks carried forward, reported as a backlog count."""
    moment = now or timezone.now()
    rows: list[dict] = []
    for project in active_projects(user):
        overdue = StudyTask.objects.filter(
            user=user,
            project=project,
            status__in=[TaskStatus.PENDING, TaskStatus.DEFERRED],
            due_at__lt=moment,
        ).count()
        if overdue:
            rows.append({"project_id": str(project.id), "project_name": project.name, "overdue_tasks": overdue})
    return rows


def progress_notes(*, user, now=None) -> list[str]:
    """Explain the current state with real counts only."""
    notes: list[str] = []
    unresolved = PracticeSession.objects.filter(
        user=user, status=SessionStatus.ACTIVE, mode="verification"
    ).count()
    if unresolved:
        notes.append(f"有 {unresolved} 个验证会话尚未结束：结束前不显示分数，也不提供答案。")
    excluded = (
        LearningEvidence.objects.filter(user=user, is_active=True)
        .filter(dimension=EvidenceDimension.INDEPENDENT_CORRECT, qualifies=False)
        .count()
    )
    if excluded:
        notes.append(f"有 {excluded} 条作答未计入严格独立证据（可在证据列表查看排除原因）。")
    undiagnosed = LearnerKnowledgeState.objects.filter(
        user=user, summary=KnowledgeStateSummary.UNDIAGNOSED
    ).count()
    if undiagnosed:
        notes.append(f"仍有 {undiagnosed} 个考点未诊断。")
    return notes


def unclassified_weight_warning(*, project) -> list[str]:
    """Node weights must account for the whole score; unclassified is explicit."""
    total = (
        QuestionKnowledge.objects.filter(
            question_version__status="published",
            question_version__question__subject__project=project,
            is_primary=True,
        ).aggregate(value=Sum("score_weight"))["value"]
        or Decimal("0")
    )
    if total == 0:
        return ["该项目尚无已发布题目的考点权重，考点地图与报告暂无可归属分值。"]
    return []


def plan_delta_minutes(plan: StudyPlan) -> int:
    return plan.daily_budget_minutes - plan.allocated_minutes


def next_day(on_date: date) -> date:
    return on_date + timedelta(days=1)
