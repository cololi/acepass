#!/usr/bin/env python
"""Empirical probe for B8's learning-read surface, against a real Django.

Everything runs on a **throw-away PostgreSQL test database** through the real Ninja router
(``django.test.Client`` on ``/api/v1/...``): authentication, query-string parsing, the unified error
envelope, ``Idempotency-Key`` handling, and every row each operation writes.

Covered operations:

* ``GET /study-plans/today`` and ``POST /study-plans/today/generate`` (the ``TodayPlanOut`` shape);
* ``GET /projects/{id}/review-tasks`` (``due_now`` recomputed from the anchor, not from ``not_before``);
* ``GET /study-tasks/{id}``, ``POST /study-tasks/{id}/start|defer|skip|complete``,
  ``POST /projects/{id}/study-tasks/{tid}/reconcile-delay``;
* ``GET/POST /projects/{id}/memory-cards`` + ``review|logs|rebuild|suspend|resume``;
* ``GET /projects/{id}/search`` + ``POST /search/reindex`` (keyword ranking, the unconfigured vector
  channel, project isolation, idempotency);
* ``GET /projects/{id}/questions/{qid}/exposure`` + ``POST …/external-seen`` (201 + replay + conflict).

The seed world is built from real model rows and the real services the product uses. UUIDs are
replaced by symbols (``REF_000``) and service-written timestamps by ``<now>``, so a rerun against
fresh ids is byte-identical.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_b8_learning.py

Writes ``docs/dsh-migration/17-b8-learning-probe.json`` only.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import Client  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.accounts.models import UserSettings  # noqa: E402
from apps.audit.models import IdempotencyRecord, OutboxEvent  # noqa: E402
from apps.common.content import content_digest  # noqa: E402
from apps.common.enums import ExposureKind, ExposurePurpose  # noqa: E402
from apps.exams.models import ExamProject, Subject, SyllabusVersion  # noqa: E402
from apps.exams.services import core as exams_services  # noqa: E402
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge  # noqa: E402
from apps.learning.models import ReviewTask, StudyPlan, StudyTask  # noqa: E402
from apps.memory.models import MemoryCard, MemoryReviewLog  # noqa: E402
from apps.practice.models import Attempt, ExposureEvent, GradeEvent, LearningEvidence  # noqa: E402
from apps.practice.services import exposure as exposure_service  # noqa: E402
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion  # noqa: E402
from apps.search.models import SearchDocument  # noqa: E402
from domain.memory import fsrs  # noqa: E402

OUT_JSON = ROOT / "docs" / "dsh-migration" / "17-b8-learning-probe.json"
TEST_DB_NAME = "test_acepass_b8_learning"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

UNSET = object()
CASES: list[dict] = []
RAW: dict[str, object] = {}
SYMBOLS: dict[str, str] = {}
AUTO_NAMES: dict[str, str] = {}
CLIENT = Client()
OWNER = None  # set in build()

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
#: Service-written instants also appear inside free text (for example the plan's reconcile note).
ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")
REF_RE = re.compile(r"REF_\d{3}")
TIME_KEYS = {
    "now", "generated_at", "created_at", "updated_at", "started_at", "completed_at", "due_at",
    "last_reviewed_at", "not_before", "delay_anchor_at", "reviewed_at", "due_before", "due_after",
    "server_time", "first_seen_at", "embedding_updated_at", "plan_date",
    "stored_not_before", "recomputed_not_before",
}


# ---------------------------------------------------------------------------
# recording helpers (same shape as probe_ingestion_b5.py / probe_analytics_b6.py)
# ---------------------------------------------------------------------------
def _auto_name(value: str) -> str:
    name = SYMBOLS.get(value)
    if name is None:
        name = f"REF_{len(SYMBOLS):03d}"
        AUTO_NAMES[name] = value
        SYMBOLS[value] = name
    return name


def reg(name: str, value) -> None:
    SYMBOLS[str(getattr(value, "id", value))] = name


def sym(value) -> str | None:
    return None if value is None else _auto_name(str(value))


def symbolize_text(text: str) -> str:
    return UUID_RE.sub(lambda match: _auto_name(match.group(0)), ISO_RE.sub("<now>", text))


def scrub(value, key: str | None = None):
    if isinstance(value, datetime):
        return "<now>" if key in TIME_KEYS else value.isoformat()
    if isinstance(value, dict):
        return {name: scrub(item, name) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(item, key) for item in value]
    if isinstance(value, str):
        if key in TIME_KEYS:
            return "<now>"
        return symbolize_text(value)
    return value


def remap(value):
    if isinstance(value, dict):
        return {name: remap(item) for name, item in value.items()}
    if isinstance(value, list):
        return [remap(item) for item in value]
    if isinstance(value, str):
        return REF_RE.sub(lambda match: SYMBOLS.get(AUTO_NAMES.get(match.group(0), ""), match.group(0)), value)
    return value


def db_counts() -> dict:
    return {
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "exams_project": ExamProject.objects.count(),
        "learning_study_plan": StudyPlan.objects.count(),
        "learning_study_task": StudyTask.objects.count(),
        "learning_review_task": ReviewTask.objects.count(),
        "memory_card": MemoryCard.objects.count(),
        "memory_review_log": MemoryReviewLog.objects.count(),
        "practice_attempt": Attempt.objects.count(),
        "practice_exposure_event": ExposureEvent.objects.count(),
        "practice_grade_event": GradeEvent.objects.count(),
        "practice_learning_evidence": LearningEvidence.objects.count(),
        "search_document": SearchDocument.objects.count(),
    }


def record(case_id: str, op: str, title: str, *, request: dict, status: int, payload, before: dict, after: dict) -> dict:
    entry = {
        "case": case_id,
        "op": op,
        "title": title,
        "request": scrub(request),
        "status": status,
        "response": scrub(payload),
        "row_delta": {name: after[name] - before[name] for name in before if after[name] != before[name]},
    }
    if isinstance(payload, dict):
        RAW[case_id] = payload
    if isinstance(payload, dict) and "error" in payload:
        entry["error_envelope"] = scrub(payload["error"])
    CASES.append(entry)
    return entry


def call(case_id: str, op: str, title: str, method: str, path: str, *, json_body=UNSET, key=UNSET) -> dict:
    headers = {}
    if key is not UNSET:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    before = db_counts()
    if json_body is not UNSET:
        response = getattr(CLIENT, method)(
            path, data=json.dumps(json_body, ensure_ascii=False), content_type="application/json", **headers
        )
    else:
        response = getattr(CLIENT, method)(path, **headers)
    after = db_counts()
    try:
        payload = json.loads(response.content.decode("utf-8")) if response.content else None
    except json.JSONDecodeError:
        raise RuntimeError(f"{case_id} {method.upper()} {path} -> {response.status_code}: {response.content[:800]!r}") from None
    return record(
        case_id,
        op,
        title,
        request={
            "method": method.upper(),
            "path": path,
            "json_body": None if json_body is UNSET else json_body,
            "idempotency_key": None if key is UNSET else key,
        },
        status=response.status_code,
        payload=payload,
        before=before,
        after=after,
    )


# ---------------------------------------------------------------------------
# fixtures (real services / real model rows, never a hand-written response)
# ---------------------------------------------------------------------------
def make_published_question(subject: Subject, label: str, stem: str, node: KnowledgeNode) -> Question:
    content = {"blocks": [{"kind": "text", "text": stem}]}
    question = Question.objects.create(subject=subject, origin_type="user_authored", display_label=label)
    version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type="true_false",
        content=content,
        status="draft",
        content_digest=content_digest(content),
        practice_max_score=2,
        revision_reason="b8 probe",
        source_note="",
    )
    AnswerKeyVersion.objects.create(
        question_version=version,
        version=1,
        answer_payload={"kind": "true_false", "value": True},
        source_type="user",
        verification_status="checked",
        check_basis="b8 probe：自编验收题，不是历年真题",
    )
    QuestionKnowledge.objects.create(
        question_version=version,
        node=node,
        is_primary=True,
        score_weight=1,
        mapping_revision=1,
    )
    # Publishing through the service sets `Question.current_published_version` — writing
    # `status="published"` on the row alone leaves that pointer null, and every eligibility check
    # (`_eligible_question`, the memory-card excerpt, the search index) then sees "no published
    # version". The probe must build the same world the product builds.
    from apps.question_bank.services import core as question_services  # noqa: PLC0415

    question_services.publish_question_version(version, actor=OWNER)
    question.refresh_from_db()
    return question


def build_world():
    global OWNER
    User = get_user_model()
    OWNER = User.objects.create_user(email="b8-probe@example.invalid", password="probe-password-123", display_name="B8 探针")
    settings_obj, _ = UserSettings.objects.get_or_create(user=OWNER)
    settings_obj.daily_budget_minutes = 90
    settings_obj.timezone = "Asia/Shanghai"
    settings_obj.save()

    project_a = exams_services.create_project(OWNER, name="B8 探针项目A")
    project_b = exams_services.create_project(OWNER, name="B8 探针项目B")
    reg("PROJECT_A", project_a)
    reg("PROJECT_B", project_b)

    subject_a = exams_services.create_subject(project_a, name="数学", total_score=100, pass_score=60)
    subject_b = exams_services.create_subject(project_b, name="专业实务", total_score=100, pass_score=60)
    reg("SUBJECT_A", subject_a)
    reg("SUBJECT_B", subject_b)

    spec_a = exams_services.create_exam_spec_version(
        subject_a,
        created_by=OWNER,
        name="规范",
        total_score=100,
        pass_score=60,
        question_type_rules={"true_false": {"default_max_score": 2, "correct_score": 2, "wrong_score": 0}},
    )
    exams_services.publish_exam_spec_version(spec_a, actor=OWNER)
    spec_b = exams_services.create_exam_spec_version(
        subject_b,
        created_by=OWNER,
        name="规范",
        total_score=100,
        pass_score=60,
        question_type_rules={"true_false": {"default_max_score": 2, "correct_score": 2, "wrong_score": 0}},
    )
    exams_services.publish_exam_spec_version(spec_b, actor=OWNER)

    syllabus_a = exams_services.create_syllabus_version(
        subject_a, created_by=OWNER, name="大纲", version_label="2026", is_user_provisional=True
    )
    exams_services.publish_syllabus_version(syllabus_a, actor=OWNER)
    syllabus_b = exams_services.create_syllabus_version(
        subject_b, created_by=OWNER, name="大纲", version_label="2026", is_user_provisional=True
    )
    exams_services.publish_syllabus_version(syllabus_b, actor=OWNER)

    node_a = KnowledgeNode.objects.create(
        syllabus_version=syllabus_a, canonical_name="三角形考点", kind="point", display_order=0
    )
    node_b = KnowledgeNode.objects.create(
        syllabus_version=syllabus_b, canonical_name="专业考点", kind="point", display_order=0
    )
    reg("NODE_A", node_a)
    reg("NODE_B", node_b)

    # The same stem in both projects: project isolation must not rely on B lacking documents.
    question_a = make_published_question(subject_a, "判断A", "验收判断：三角形内角和为 180 度。", node_a)
    question_b = make_published_question(subject_b, "判断B", "验收判断：三角形内角和为 180 度。", node_b)
    reg("QUESTION_A", question_a)
    reg("QUESTION_B", question_b)
    return project_a, project_b, subject_a, subject_b, node_a, node_b, question_a, question_b


def build_delayed_tasks(project_a, subject_a, node_a, question_a):
    """A due C task and a not-yet-due C task, each anchored by a real learning event."""
    now = timezone.now()
    version = question_a.current_published_version
    due_anchor = now - timedelta(hours=30)
    exposure_service.record(
        user=OWNER,
        project=project_a,
        question=question_a,
        question_version=version,
        kind=ExposureKind.EXPLANATION_DELIVERED,
        purpose=ExposurePurpose.PRACTICE,
        source="b8_probe_anchor",
        reveals_answer=True,
        detail={"probe": True},
    )
    # The recorded row uses `timezone.now()`; move it back so the derived interval is honest.
    ExposureEvent.objects.filter(user=OWNER, source="b8_probe_anchor").update(server_time=due_anchor)

    due_not_before = due_anchor + timedelta(hours=24)
    due_task = StudyTask.objects.create(
        user=OWNER,
        project=project_a,
        subject=subject_a,
        task_kind="delayed_verification",
        status="pending",
        question=question_a,
        knowledge_node=node_a,
        pairing_version=1,
        trigger_event="attempt_graded",
        delay_anchor_at=due_anchor,
        not_before=due_not_before,
        due_at=due_not_before,
        estimated_minutes=2,
        reason_codes=["due_delayed_verification", "delay_24h"],
        rule_version="p0-1",
    )
    ReviewTask.objects.create(
        user=OWNER,
        project=project_a,
        study_task=due_task,
        knowledge_node=node_a,
        delay_hours=24,
        delay_anchor_at=due_anchor,
        not_before=due_not_before,
        anchor_source="teaching_exposure",
    )
    reg("TASK_DUE", due_task)

    waiting_task = StudyTask.objects.create(
        user=OWNER,
        project=project_a,
        subject=subject_a,
        task_kind="delayed_verification",
        status="pending",
        question=question_a,
        knowledge_node=node_a,
        pairing_version=1,
        trigger_event="attempt_graded",
        # A deadline far in the future with no newer anchor: the stored value is authoritative.
        delay_anchor_at=now,
        not_before=now + timedelta(hours=24),
        due_at=now + timedelta(hours=24),
        estimated_minutes=2,
        reason_codes=["due_delayed_verification", "delay_24h"],
        rule_version="p0-1",
    )
    ReviewTask.objects.create(
        user=OWNER,
        project=project_a,
        study_task=waiting_task,
        knowledge_node=node_a,
        delay_hours=24,
        delay_anchor_at=now,
        not_before=now + timedelta(hours=24),
        anchor_source="teaching_exposure",
    )
    reg("TASK_WAITING", waiting_task)
    return due_task, waiting_task


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------
def run_plan_cases(project_a: ExamProject):
    call("PLAN-01", "PLAN", "今日计划：还没有计划时是显式空状态", "get", "/api/v1/study-plans/today")
    call(
        "PLAN-02",
        "PLAN",
        "今日计划：生成（幂等键）",
        "post",
        "/api/v1/study-plans/today/generate",
        json_body={"refresh": False},
        key="plan-generate-1",
    )
    entry = call("PLAN-03", "PLAN", "今日计划：GET 形状（plan/tasks/notes/backlog/progress_notes）", "get", "/api/v1/study-plans/today")
    payload = RAW.get("PLAN-03") or {}
    plan = payload.get("plan") or {}
    entry["plan_keys"] = sorted(plan.keys())
    tasks = payload.get("tasks") or []
    entry["task_keys"] = sorted(tasks[0].keys()) if tasks else []
    entry["task_count"] = len(tasks)
    # A GET never writes: the second read must produce the same plan id and the same row counts.
    call(
        "PLAN-04",
        "PLAN",
        "今日计划：GET 不改变计划（重复读取）",
        "get",
        "/api/v1/study-plans/today",
    )
    return entry


def run_plan_refresh_case(project_a: ExamProject):
    """Run last: a refresh replaces pending tasks, which would spoil the task-lifecycle cases."""
    call(
        "PLAN-05",
        "PLAN",
        "今日计划：刷新生成新修订（未开始任务被新修订替换）",
        "post",
        "/api/v1/study-plans/today/generate",
        json_body={"refresh": True},
        key="plan-generate-2",
    )


def run_task_cases(project_a, due_task, waiting_task):
    entry = call("TASK-01", "TASKS", "复习队列：到期与未到期的真实间隔状态", "get",
                 f"/api/v1/projects/{project_a.id}/review-tasks")
    rows = (RAW.get("TASK-01") or {}).get("rows") or []
    entry["row_keys"] = sorted(rows[0].keys()) if rows else []
    entry["rows_due"] = [row["due_now"] for row in rows]
    call("TASK-02", "TASKS", "复习队列：only_due=true 只返回可开始的", "get",
         f"/api/v1/projects/{project_a.id}/review-tasks?only_due=true")
    call("TASK-03", "TASKS", "复习队列：未知项目是 404", "get", "/api/v1/projects/00000000-0000-0000-0000-000000000000/review-tasks")
    call("TASK-04", "TASKS", "任务详情：完整字段", "get", f"/api/v1/study-tasks/{due_task.id}")
    call("TASK-05", "TASKS", "开始任务：缺少幂等键 409", "post", f"/api/v1/study-tasks/{due_task.id}/start")
    entry2 = call("TASK-06", "TASKS", "开始任务：到期任务 200 + create_session_hint", "post",
                  f"/api/v1/study-tasks/{due_task.id}/start", key="start-1")
    entry2["hint_keys"] = sorted(((RAW.get("TASK-06") or {}).get("create_session_hint") or {}).keys())
    call("TASK-07", "TASKS", "开始任务：同键重放同一响应", "post",
         f"/api/v1/study-tasks/{due_task.id}/start", key="start-1")
    call("TASK-08", "TASKS", "开始任务：未到期 400 并给出还差多久", "post",
         f"/api/v1/study-tasks/{waiting_task.id}/start", key="start-waiting")
    call("TASK-09", "TASKS", "顺延任务：写入 deferred:reason", "post",
         f"/api/v1/study-tasks/{waiting_task.id}/defer", json_body={"reason": "user"}, key="defer-1")
    call("TASK-10", "TASKS", "顺延任务：同键不同载荷 409", "post",
         f"/api/v1/study-tasks/{waiting_task.id}/defer", json_body={"reason": "later"}, key="defer-1")
    call("TASK-11", "TASKS", "跳过任务：status=skipped", "post",
         f"/api/v1/study-tasks/{waiting_task.id}/skip", json_body={"reason": "不做了"}, key="skip-1")
    call("TASK-12", "TASKS", "完成任务：未产生作答的显式说明", "post",
         f"/api/v1/study-tasks/{waiting_task.id}/complete", key="complete-1")
    call("TASK-13", "TASKS", "完成任务：重复调用不重复写入", "post",
         f"/api/v1/study-tasks/{waiting_task.id}/complete", key="complete-2")
    call("TASK-14", "TASKS", "重算间隔：只影响未开始的到期任务", "post",
         f"/api/v1/projects/{project_a.id}/study-tasks/{due_task.id}/reconcile-delay", key="reconcile-1")
    call("TASK-15", "TASKS", "任务详情：未知任务是 404", "get", "/api/v1/study-tasks/00000000-0000-0000-0000-000000000000")


def run_memory_cases(project_a, question_a):
    created = call("MEM-01", "MEMORY", "记忆卡：首次创建 201", "post",
                   f"/api/v1/projects/{project_a.id}/memory-cards",
                   json_body={"question_id": str(question_a.id)}, key="card-create-1")
    card_id = (RAW.get("MEM-01") or {}).get("card_id")
    created["card_keys"] = sorted((RAW.get("MEM-01") or {}).keys())
    call("MEM-02", "MEMORY", "记忆卡：重复创建返回同一张卡（200）", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards",
         json_body={"question_id": str(question_a.id)}, key="card-create-2")
    call("MEM-03", "MEMORY", "记忆卡：列表（到期优先）", "get", f"/api/v1/projects/{project_a.id}/memory-cards")
    reviewed = call("MEM-04", "MEMORY", "复习记忆卡：good 排期并写一条日志", "post",
                    f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/review",
                    json_body={"rating": "good"}, key="review-1")
    reviewed["review_keys"] = sorted((RAW.get("MEM-04") or {}).keys())
    call("MEM-05", "MEMORY", "复习记忆卡：同键重放同一条日志", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/review",
         json_body={"rating": "good"}, key="review-1")
    call("MEM-06", "MEMORY", "复习记忆卡：同键不同评级 409", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/review",
         json_body={"rating": "again"}, key="review-1")
    call("MEM-07", "MEMORY", "复习记忆卡：缺少幂等键 400", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/review",
         json_body={"rating": "good"})
    call("MEM-08", "MEMORY", "复习记忆卡：未知评级 400", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/review",
         json_body={"rating": "perfect"}, key="review-bad")
    entry = call("MEM-09", "MEMORY", "复习日志：最新在前", "get",
                 f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/logs")
    entry["log_keys"] = sorted(((RAW.get("MEM-09") or [{}])[0]).keys())
    call("MEM-10", "MEMORY", "重放校验：一致", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/rebuild", key="rebuild-1")

    card = MemoryCard.objects.get(id=card_id)
    card.due_at = timezone.now() + timedelta(days=3650)
    card.save(update_fields=["due_at", "updated_at"])
    call("MEM-11", "MEMORY", "重放校验：手改卡片行被检出不一致", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/rebuild", key="rebuild-2")
    # Restore so the suspend case measures suspension only.
    card.due_at = (RAW.get("MEM-04") or {}).get("due_at") and datetime.fromisoformat(RAW["MEM-04"]["due_at"])
    card.save(update_fields=["due_at", "updated_at"])

    call("MEM-12", "MEMORY", "暂停记忆卡：排期保留", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/suspend",
         json_body={"reason": "换教材，先停"}, key="suspend-1")
    call("MEM-13", "MEMORY", "暂停后列表默认不返回", "get", f"/api/v1/projects/{project_a.id}/memory-cards")
    call("MEM-14", "MEMORY", "暂停后复习 400", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/review",
         json_body={"rating": "good"}, key="review-suspended")
    call("MEM-15", "MEMORY", "恢复记忆卡：不重设到期", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/{card_id}/resume", key="resume-1")
    call("MEM-16", "MEMORY", "记忆卡：未知卡 404", "post",
         f"/api/v1/projects/{project_a.id}/memory-cards/00000000-0000-0000-0000-000000000000/resume",
         key="resume-missing")
    return card_id


def run_search_cases(project_a, project_b, subject_a, subject_b, question_a, question_b):
    reindexed = call("SEARCH-01", "SEARCH", "重建索引：收录题目版本与考点", "post",
                     f"/api/v1/projects/{project_a.id}/search/reindex",
                     json_body={"subject_id": str(subject_a.id)}, key="reindex-1")
    reindexed["reindex_keys"] = sorted((RAW.get("SEARCH-01") or {}).keys())
    call("SEARCH-02", "SEARCH", "重建索引：同键重放同一报告", "post",
         f"/api/v1/projects/{project_a.id}/search/reindex",
         json_body={"subject_id": str(subject_a.id)}, key="reindex-1")
    call("SEARCH-03", "SEARCH", "重建索引：同键不同科目 409", "post",
         f"/api/v1/projects/{project_a.id}/search/reindex", json_body={}, key="reindex-1")
    call("SEARCH-04", "SEARCH", "重建索引：缺少幂等键 409", "post",
         f"/api/v1/projects/{project_a.id}/search/reindex", json_body={})

    query = quote("三角形内角和")
    hybrid = call("SEARCH-05", "SEARCH", "检索：混合通道命中题干，向量通道明示未配置", "get",
                  f"/api/v1/projects/{project_a.id}/search?q={query}&limit=10&channel=hybrid")
    payload = RAW.get("SEARCH-05") or {}
    results = payload.get("results") or []
    hybrid["result_keys"] = sorted(results[0].keys()) if results else []
    hybrid["top"] = {
        "kind": results[0]["kind"] if results else None,
        "keyword_rank": results[0]["keyword_rank"] if results else None,
        "vector_rank": results[0]["vector_rank"] if results else None,
        "display_label": results[0]["display_label"] if results else None,
        "matched_terms": results[0]["matched_terms"] if results else [],
    }
    hybrid["channels"] = {
        "keyword": (payload.get("channels") or {}).get("keyword"),
        "vector": (payload.get("channels") or {}).get("vector"),
    }
    call("SEARCH-06", "SEARCH", "检索：关键词通道单独可用", "get",
         f"/api/v1/projects/{project_a.id}/search?q={query}&channel=keyword")
    call("SEARCH-07", "SEARCH", "检索：仅向量通道 200 且结果为空", "get",
         f"/api/v1/projects/{project_a.id}/search?q={query}&channel=vector")
    call("SEARCH-08", "SEARCH", "检索：空查询 200 并说明没有检索词", "get",
         f"/api/v1/projects/{project_a.id}/search?q=&limit=10&channel=hybrid")
    call("SEARCH-09", "SEARCH", "检索：无效通道 400", "get",
         f"/api/v1/projects/{project_a.id}/search?q={query}&channel=fuzzy")

    call("SEARCH-10", "SEARCH", "重建索引：项目B", "post",
         f"/api/v1/projects/{project_b.id}/search/reindex",
         json_body={"subject_id": str(subject_b.id)}, key="reindex-b")
    isolated = call("SEARCH-11", "SEARCH", "检索：项目B同样题干只返回B自己的文档", "get",
                    f"/api/v1/projects/{project_b.id}/search?q={query}&limit=10")
    rows = (RAW.get("SEARCH-11") or {}).get("results") or []
    isolated["question_ids"] = sorted(sym(row["question_id"]) for row in rows if row.get("question_id"))
    isolated["contains_project_a_question"] = any(
        row["question_id"] == str(question_a.id) for row in rows
    )
    isolated["contains_project_b_question"] = any(
        row["question_id"] == str(question_b.id) for row in rows
    )
    call("SEARCH-12", "SEARCH", "检索：跨项目科目 404", "get",
         f"/api/v1/projects/{project_a.id}/search?q={query}&subject_id={subject_b.id}")
    call("SEARCH-13", "SEARCH", "检索：未知项目 404", "get", "/api/v1/projects/00000000-0000-0000-0000-000000000000/search?q=x")
    return hybrid


def run_exposure_cases(project_a, project_b, question_a, question_b):
    entry = call("EXP-01", "EXPOSURE", "暴露台账：未暴露的题目", "get",
                 f"/api/v1/projects/{project_a.id}/questions/{question_a.id}/exposure")
    entry["payload_keys"] = sorted((RAW.get("EXP-01") or {}).keys())
    call("EXP-02", "EXPOSURE", "暴露台账：外部已见声明 201", "post",
         f"/api/v1/projects/{project_a.id}/questions/{question_a.id}/external-seen",
         json_body={"seen": True, "note": "我在别处做过这张卷子"}, key="external-seen-1")
    call("EXP-03", "EXPOSURE", "暴露台账：同键重放同一声明", "post",
         f"/api/v1/projects/{project_a.id}/questions/{question_a.id}/external-seen",
         json_body={"seen": True, "note": "我在别处做过这张卷子"}, key="external-seen-1")
    call("EXP-04", "EXPOSURE", "暴露台账：同键不同载荷 409", "post",
         f"/api/v1/projects/{project_a.id}/questions/{question_a.id}/external-seen",
         json_body={"seen": False, "note": "改主意"}, key="external-seen-1")
    call("EXP-05", "EXPOSURE", "暴露台账：声明后读取 seen=true 且不再是严格独立", "get",
         f"/api/v1/projects/{project_a.id}/questions/{question_a.id}/exposure")
    call("EXP-06", "EXPOSURE", "暴露台账：未知题目 404", "get",
         f"/api/v1/projects/{project_a.id}/questions/00000000-0000-0000-0000-000000000000/exposure")
    call("EXP-07", "EXPOSURE", "暴露台账：别项目的题目 404", "get",
         f"/api/v1/projects/{project_a.id}/questions/{question_b.id}/exposure")
    call("EXP-08", "EXPOSURE", "暴露台账：未声明过的题目仍是严格独立", "get",
         f"/api/v1/projects/{project_b.id}/questions/{question_b.id}/exposure")


def run_cases():
    project_a, project_b, subject_a, subject_b, node_a, node_b, question_a, question_b = WORLD
    due_task, waiting_task = TASKS
    run_plan_cases(project_a)
    run_task_cases(project_a, due_task, waiting_task)
    run_memory_cases(project_a, question_a)
    run_search_cases(project_a, project_b, subject_a, subject_b, question_a, question_b)
    run_exposure_cases(project_a, project_b, question_a, question_b)
    run_plan_refresh_case(project_a)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def main() -> int:
    global WORLD, TASKS
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        WORLD = build_world()
        TASKS = build_delayed_tasks(WORLD[0], WORLD[2], WORLD[4], WORLD[6])
        CLIENT.force_login(OWNER)
        run_cases()
    finally:
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {
        "generated_by": "dsh-plugin/scripts/probe_b8_learning.py",
        "schema_version": 1,
        "environment": {
            "database": "postgresql (throw-away test database)",
            "django_settings": "config.settings.test",
            "routes": "real Ninja router via django.test.Client",
            "vector_channel": "no embedding provider configured (AI_PROVIDER=stub has no embeddings)",
            "clock": "seed timestamps derive from build time; service-written instants are scrubbed to <now>",
        },
        "cases": remap(CASES),
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"cases={len(CASES)}")
    ops: dict[str, int] = {}
    for case in CASES:
        ops[case["op"]] = ops.get(case["op"], 0) + 1
    for name in sorted(ops):
        print(name, ops[name])
    return 0


WORLD = ()
TASKS = ()

if __name__ == "__main__":
    raise SystemExit(main())
