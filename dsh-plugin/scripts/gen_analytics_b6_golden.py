#!/usr/bin/env python
"""Golden vectors for B6: practice report, coverage, cycle analysis, calibration, regrades.

Oracle: the *real* functions in `backend/apps/analytics/services/` executed against **real
PostgreSQL rows** in a throw-away test database:

* `reports.build_practice_report` (with and without the snapshot write),
* `reports.paper_coverage` / `reports.coverage_completion`,
* `cycles.cycle_analysis`,
* `calibration.build_effect_calibration`,
* `reports.request_regrade` / `reports.execute_regrade_run` (generation ordering, trust refusal,
  content-version invalidation),
* the answer-review projection in `apps/analytics/api.py` (same query, evaluated here).

Rows are seeded with `uuid5` identities and `BASE + n minutes` timestamps, and `timezone.now` is
patched to `BASE`, so a rerun is byte-identical. Randomly created ids (a run id, grade-event ids)
are replaced by stable symbols (`<run>`, `ATTEMPT`/`ANSWER` names) before they enter the fixture;
the Node replay produces the same normalized projection.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/gen_analytics_b6_golden.py
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from apps.analytics.models import RegradeRun, ReportSnapshot  # noqa: E402
from apps.analytics.services import calibration as calibration_service  # noqa: E402
from apps.analytics.services import cycles as cycle_service  # noqa: E402
from apps.analytics.services import reports as report_service  # noqa: E402
from apps.common.content import content_digest  # noqa: E402
from apps.exams.models import (  # noqa: E402
    ExamProject,
    ExamSpecVersion,
    Paper,
    PaperItem,
    PaperRevision,
    Subject,
    SyllabusVersion,
)
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge  # noqa: E402
from apps.learning.models import LearnerKnowledgeState  # noqa: E402
from apps.practice.models import (  # noqa: E402
    Attempt,
    GradeEvent,
    LearningEvidence,
    PracticeSession,
    SessionItem,
)
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionVersion,
    RubricVersion,
)

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "analytics_b6.json"
TEST_DB_NAME = "test_acepass_b6_golden"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}
#: Every timestamp in the fixture derives from this instant, never from `timezone.now()`.
BASE = datetime(2026, 8, 1, 0, 0, tzinfo=timezone.utc)
NOW = BASE

NAMES: dict[str, str] = {}
IDS: dict[str, str] = {}
SYMBOLS: dict[str, str] = {}


def uid(name: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b6:{name}")


def jsonable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    return str(value)


def dump_row(obj) -> dict:
    return {field.attname: jsonable(getattr(obj, field.attname)) for field in obj._meta.concrete_fields}


def symbolize(value):
    """Replace seeded UUIDs with their stable names, recursively."""
    if isinstance(value, dict):
        # Dict *keys* can be seeded ids too (`by_knowledge_node` is keyed by node id), so the
        # symbolization has to cover them or the fixture carries random-looking UUIDs.
        return {NAMES.get(key, key): symbolize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [symbolize(item) for item in value]
    if isinstance(value, str):
        return NAMES.get(value, value)
    return value


class World:
    def __init__(self, name: str) -> None:
        self.name = name
        self.objects: list = []
        self._counters: dict[str, int] = {}

    def create(self, model, entity: str, symbol: str, **kwargs):
        n = self._counters.get(entity, 0) + 1
        self._counters[entity] = n
        obj = model(id=uid(f"{self.name}:{entity}:{n}"), **kwargs)
        obj.save(force_insert=True)
        NAMES[str(obj.pk)] = symbol
        IDS[symbol] = str(obj.pk)
        SYMBOLS[symbol] = str(obj.pk)
        self.objects.append(obj)
        return obj

    def fix_timestamps(self) -> None:
        for index, obj in enumerate(self.objects):
            value = BASE + timedelta(minutes=index + 1)
            attnames = {field.attname for field in obj._meta.concrete_fields}
            if "created_at" in attnames:
                type(obj)._base_manager.filter(pk=obj.pk).update(created_at=value, updated_at=value)
                obj.refresh_from_db()

    def rows(self) -> dict[str, list[dict]]:
        tables: dict[str, list[dict]] = {}
        for obj in self.objects:
            tables.setdefault(obj._meta.db_table, []).append(dump_row(obj))
        return tables


def choice_content(stem: str) -> dict:
    return {
        "blocks": [{"kind": "text", "text": stem}],
        "options": [
            {"id": f"opt_{letter.lower()}", "label": letter, "blocks": [{"kind": "text", "text": f"选项{letter}"}]}
            for letter in "ABCD"
        ],
    }


def choice_answer(option_id: str = "opt_b") -> dict:
    return {"kind": "single_choice", "correct_option_id": option_id}


# ---------------------------------------------------------------------------
# seed
# ---------------------------------------------------------------------------
def seed_world():
    w = World("b6")
    user = w.create(
        get_user_model(),
        "user",
        "user_owner",
        email="b6-golden@example.invalid",
        display_name="报告用户",
        date_joined=BASE,
        password="!b6-golden-unusable-password-marker",
    )
    other_user = w.create(
        get_user_model(),
        "user",
        "user_other",
        email="b6-other@example.invalid",
        display_name="他人",
        date_joined=BASE,
        password="!b6-golden-unusable-password-marker",
    )
    project = w.create(ExamProject, "project", "project_main", owner=user, name="B6 项目")
    other_project = w.create(ExamProject, "project", "project_other", owner=other_user, name="他人的项目")
    subject = w.create(Subject, "subject", "subject_math", project=project, name="数学", code="MATH")
    other_subject = w.create(Subject, "subject", "subject_physics", project=project, name="物理", code="PHY")
    foreign_subject = w.create(Subject, "subject", "subject_foreign", project=other_project, name="数学", code="M2")

    syllabus = w.create(
        SyllabusVersion,
        "syllabus",
        "syllabus_math",
        subject=subject,
        name="数学大纲",
        version_label="2026",
        status="published",
        is_user_provisional=False,
    )
    draft_syllabus = w.create(
        SyllabusVersion,
        "syllabus",
        "syllabus_draft",
        subject=subject,
        name="草稿大纲",
        version_label="2027",
        status="draft",
        is_user_provisional=False,
    )
    other_syllabus = w.create(
        SyllabusVersion,
        "syllabus",
        "syllabus_physics",
        subject=other_subject,
        name="物理大纲",
        version_label="2026",
        status="published",
        is_user_provisional=False,
    )
    root = w.create(
        KnowledgeNode, "node", "node_root", syllabus_version=syllabus, canonical_name="代数", kind="chapter", display_order=1
    )
    child = w.create(
        KnowledgeNode,
        "node",
        "node_child",
        syllabus_version=syllabus,
        parent=root,
        canonical_name="一元二次方程",
        kind="point",
        display_order=2,
    )
    other_node = w.create(
        KnowledgeNode, "node", "node_other", syllabus_version=syllabus, canonical_name="几何", kind="point", display_order=3
    )
    unclassified = w.create(
        KnowledgeNode,
        "node",
        "node_unclassified",
        syllabus_version=syllabus,
        canonical_name="未分类",
        kind="point",
        is_unclassified=True,
        display_order=9,
    )
    draft_node = w.create(
        KnowledgeNode, "node", "node_draft", syllabus_version=draft_syllabus, canonical_name="草稿考点", kind="point"
    )
    physics_node = w.create(
        KnowledgeNode, "node", "node_physics", syllabus_version=other_syllabus, canonical_name="力学", kind="point"
    )

    spec = w.create(
        ExamSpecVersion,
        "spec",
        "spec_math",
        subject=subject,
        version=1,
        name="数学规范",
        total_score=Decimal("100.00"),
        pass_score=Decimal("60.00"),
        question_type_rules={
            "single_choice": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
            "multiple_choice": {"default_max_score": "3.00", "policy": "partial_credit", "partial_score": "1.50"},
            "true_false": {"default_max_score": "1.00"},
            "fill_blank": {"default_max_score": "2.00"},
            "constructed_response": {"default_max_score": "10.00"},
        },
        time_rules={
            "single_choice_seconds": 60,
            "multiple_choice_seconds": 90,
            "true_false_seconds": 30,
            "fill_blank_seconds": 120,
            "constructed_response_seconds": 600,
        },
        status="published",
        published_at=BASE,
    )
    physics_spec = w.create(
        ExamSpecVersion,
        "spec",
        "spec_physics",
        subject=other_subject,
        version=1,
        name="物理规范",
        question_type_rules={"single_choice": {"default_max_score": "2.00"}},
        time_rules={"single_choice_seconds": 60},
        status="published",
        published_at=BASE,
    )

    questions: dict[str, dict] = {}

    def add_question(
        key: str,
        *,
        question_type: str = "single_choice",
        subject_row=subject,
        spec_row=spec,
        content: dict | None = None,
        answer: dict | None = None,
        answer_status: str = "checked",
        disputed_answer: bool = False,
        rubric: dict | None = None,
        disputed_rubric: bool = False,
        origin_type: str = "user_authored",
        is_demo: bool = False,
        label: str = "",
    ) -> dict:
        content = content if content is not None else choice_content(f"{key} 题干")
        question = w.create(
            Question,
            "question",
            f"question_{key}",
            subject=subject_row,
            origin_type=origin_type,
            is_demo=is_demo,
            display_label=label or key,
        )
        version = w.create(
            QuestionVersion,
            "version",
            f"version_{key}",
            question=question,
            version=1,
            question_type=question_type,
            content=content,
            status="published",
            content_digest=content_digest(content),
            revision_reason="fixture",
            source_note="",
            published_at=BASE,
        )
        answer_row = None
        if answer is not None:
            answer_row = w.create(
                AnswerKeyVersion,
                "answer",
                f"answer_{key}",
                question_version=version,
                version=1,
                answer_payload=answer,
                source_type="user",
                verification_status=answer_status,
                is_disputed=disputed_answer,
                dispute_reason="fixture dispute" if disputed_answer else "",
                check_basis="fixture",
            )
            if rubric is not None:
                w.create(
                    RubricVersion,
                    "rubric",
                    f"rubric_{key}",
                    answer_key_version=answer_row,
                    version=1,
                    criteria=rubric["criteria"],
                    total_score=Decimal(rubric["total"]),
                    usage_note="",
                    is_disputed=disputed_rubric,
                )
        questions[key] = {
            "question": question,
            "version": version,
            "answer": answer_row,
            "spec": spec_row,
            "subject": subject_row,
        }
        return questions[key]

    # Report questions ------------------------------------------------------
    add_question("q1", content=choice_content("一加一等于几？"), answer=choice_answer("opt_b"))
    add_question("q2", question_type="multiple_choice", answer={"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_b"]})
    add_question("q3", question_type="true_false", answer={"kind": "true_false", "correct": True})
    add_question("q4", question_type="fill_blank", content={"blocks": [{"kind": "text", "text": "填空"}], "blanks": []}, answer={"kind": "fill_blank", "answers": {"b1": ["答案"]}})
    add_question(
        "q5",
        question_type="constructed_response",
        content={"blocks": [{"kind": "text", "text": "大题"}]},
        answer={"kind": "constructed_response"},
        rubric={
            "criteria": [
                {"criterion_id": "c1", "text": "第一步", "max_score": "2.00"},
                {"criterion_id": "c2", "text": "第二步", "max_score": "4.00"},
            ],
            "total": "6.00",
        },
    )
    add_question("q6", answer=choice_answer("opt_a"))
    add_question("q7", answer=choice_answer("opt_c"))
    add_question("q8", answer=choice_answer("opt_d"))
    add_question("q9", answer=choice_answer("opt_a"))
    add_question("q10", answer=choice_answer("opt_b"))
    add_question("q11", answer=choice_answer("opt_c"))
    add_question("q12", answer=choice_answer("opt_d"), disputed_answer=True)
    add_question(
        "q13",
        question_type="constructed_response",
        content={"blocks": [{"kind": "text", "text": "争议 rubric 大题"}]},
        answer={"kind": "constructed_response"},
        rubric={
            "criteria": [{"criterion_id": "c1", "text": "唯一评分点", "max_score": "6.00"}],
            "total": "6.00",
        },
        disputed_rubric=True,
    )
    add_question("q14", answer=choice_answer("opt_a"))
    add_question("q15", answer=choice_answer("opt_a"))
    add_question("q16", subject_row=other_subject, spec_row=physics_spec, answer=choice_answer("opt_b"))
    add_question("q17", origin_type="ai_generated", is_demo=False, answer=choice_answer("opt_b"))

    # Dedicated question for the content-change regrade branch: one attempt on v1, target answer v2.
    add_question("q18", answer=choice_answer("opt_a"))
    q18_alt = w.create(
        QuestionVersion,
        "version",
        "version_q18_alt",
        question=questions["q18"]["question"],
        version=2,
        question_type="single_choice",
        content=choice_content("内容改版后的题干"),
        status="published",
        content_digest=content_digest(choice_content("内容改版后的题干")),
        revision_reason="fixture alt",
        source_note="",
        published_at=BASE,
    )
    q18_alt_answer = w.create(
        AnswerKeyVersion,
        "answer",
        "answer_q18_alt",
        question_version=q18_alt,
        version=1,
        answer_payload=choice_answer("opt_a"),
        source_type="user",
        verification_status="checked",
        is_disputed=False,
        check_basis="fixture",
    )

    # Extra version of Q1 for the report's invalidation branch.
    q1_alt = w.create(
        QuestionVersion,
        "version",
        "version_q1_alt",
        question=questions["q1"]["question"],
        version=2,
        question_type="single_choice",
        content=choice_content("一加一等于几？（修订版）"),
        status="published",
        content_digest=content_digest(choice_content("一加一等于几？（修订版）")),
        revision_reason="fixture alt",
        source_note="",
        published_at=BASE,
    )
    q1_alt_answer = w.create(
        AnswerKeyVersion,
        "answer",
        "answer_q1_alt",
        question_version=q1_alt,
        version=1,
        answer_payload=choice_answer("opt_a"),
        source_type="user",
        verification_status="checked",
        is_disputed=False,
        check_basis="fixture",
    )
    q1_alt_item_extra = {"version": q1_alt, "answer": q1_alt_answer}

    # Mappings: V1 has two mapping revisions so the latest one is what cycles count.
    w.create(
        QuestionKnowledge,
        "mapping",
        "mapping_q1_rev1",
        question_version=questions["q1"]["version"],
        mapping_revision=1,
        node=other_node,
        is_primary=True,
        score_weight=Decimal("1.0000"),
    )
    w.create(
        QuestionKnowledge,
        "mapping",
        "mapping_q1_rev2_primary",
        question_version=questions["q1"]["version"],
        mapping_revision=2,
        node=root,
        is_primary=True,
        score_weight=Decimal("0.6000"),
    )
    w.create(
        QuestionKnowledge,
        "mapping",
        "mapping_q1_rev2_child",
        question_version=questions["q1"]["version"],
        mapping_revision=2,
        node=child,
        is_primary=True,
        score_weight=Decimal("0.4000"),
    )
    w.create(
        QuestionKnowledge,
        "mapping",
        "mapping_q1_rev2_aux",
        question_version=questions["q1"]["version"],
        mapping_revision=2,
        node=other_node,
        is_primary=False,
        score_weight=Decimal("0.0000"),
    )
    w.create(
        QuestionKnowledge,
        "mapping",
        "mapping_q5",
        question_version=questions["q5"]["version"],
        mapping_revision=1,
        node=root,
        is_primary=True,
        score_weight=Decimal("1.0000"),
    )
    w.create(
        QuestionKnowledge,
        "mapping",
        "mapping_q14",
        question_version=questions["q14"]["version"],
        mapping_revision=1,
        node=child,
        is_primary=True,
        score_weight=Decimal("1.0000"),
    )
    w.create(
        QuestionKnowledge,
        "mapping",
        "mapping_q15",
        question_version=questions["q15"]["version"],
        mapping_revision=1,
        node=child,
        is_primary=True,
        score_weight=Decimal("1.0000"),
    )

    # Sessions + items ------------------------------------------------------
    main_session = w.create(
        PracticeSession,
        "session",
        "session_main",
        user=user,
        project=project,
        subject=subject,
        mode="practice",
        status="finished",
        finished_at=BASE,
        revealed_at=BASE,
        policy_version="p0-1",
        note="purpose=practice",
    )
    verification_session = w.create(
        PracticeSession,
        "session",
        "session_verification",
        user=user,
        project=project,
        subject=subject,
        mode="verification",
        status="active",
        policy_version="p0-1",
        note="purpose=verification",
    )
    mock_session = w.create(
        PracticeSession,
        "session",
        "session_mock_expired",
        user=user,
        project=project,
        subject=subject,
        mode="mock_exam",
        status="active",
        policy_version="p0-1",
        exam_started_at=BASE - timedelta(hours=3),
        exam_deadline=BASE - timedelta(hours=1),
        note="purpose=mock",
    )
    regrade_session = w.create(
        PracticeSession,
        "session",
        "session_regrade",
        user=user,
        project=project,
        subject=subject,
        mode="practice",
        status="finished",
        finished_at=BASE,
        revealed_at=BASE,
        policy_version="p0-1",
        note="purpose=practice",
    )

    item_counter: dict[str, int] = {}

    def add_item(session, key: str, *, max_score: str, version=None, answer=None, rubric=None, spec_row=None, first_delivered=None, purpose="practice", mapping_revision=1):
        session_key = str(session.id)
        item_counter[session_key] = item_counter.get(session_key, 0) + 1
        ordinal = item_counter[session_key]
        base_key = key.split("_", 1)[0]
        return w.create(
            SessionItem,
            "item",
            f"item_{key}",
            session=session,
            ordinal=ordinal,
            question_version=version or questions[base_key]["version"],
            answer_key_version=answer if answer is not None else questions[key[:2]]["answer"],
            rubric_version=rubric,
            spec_version=spec_row or spec,
            mapping_revision=mapping_revision,
            max_score=Decimal(max_score),
            purpose=purpose,
            tutoring_allowed=True,
            first_delivered_at=first_delivered,
        )

    def add_attempt(name: str, item, *, submitted_minutes: int, grade: dict | None, elapsed_ms=30_000, applied_generation=0):
        attempt = w.create(
            Attempt,
            "attempt",
            f"attempt_{name}",
            session_item=item,
            user=user,
            project=project,
            raw_answer={"type": item.question_version.question_type, "selected_option_id": "opt_b"},
            submitted_at=BASE - timedelta(minutes=submitted_minutes),
            elapsed_ms=elapsed_ms,
            grading_revision=1 if grade is not None else 0,
            applied_regrade_generation=applied_generation,
        )
        if grade is not None:
            event = w.create(
                GradeEvent,
                "grade",
                f"grade_{name}",
                attempt=attempt,
                kind=grade.get("kind", "initial"),
                status=grade.get("status", "confirmed"),
                method=grade.get("method", "deterministic"),
                grading_revision=1,
                confirmed_score=grade.get("confirmed_score"),
                max_score=Decimal(grade.get("max_score", "2.00")),
                pending_max_score=Decimal(grade.get("pending_max_score", "0.00")),
                is_fully_confirmed=grade.get("is_fully_confirmed", True),
                parts=grade.get("parts", []),
                answer_key_version=item.answer_key_version,
                rubric_version=item.rubric_version,
                spec_version=item.spec_version,
                rule_snapshot={"fixture": True},
                rule_version="p0-1",
                grader=user if grade.get("grader_is_self") else None,
                grader_is_self=grade.get("grader_is_self", False),
                supersedes=None,
                is_superseded=False,
                invalidation_reason=grade.get("invalidation_reason", ""),
            )
            attempt.current_grade_event = event
            attempt.save(update_fields=["current_grade_event"])
        return attempt

    # Main-session attempts: every incompleteness branch.
    item_a1 = add_item(main_session, "q1_a", max_score="2.00", version=questions["q1"]["version"], answer=questions["q1"]["answer"])
    attempt_a1 = add_attempt("a1", item_a1, submitted_minutes=50, grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"})
    # Four more clean attempts on the same content: one calibration group with n>=5.
    for index in range(2, 6):
        item = add_item(
            main_session,
            f"q1_extra{index}",
            max_score="2.00",
            version=questions["q1"]["version"],
            answer=questions["q1"]["answer"],
        )
        add_attempt(f"a1_extra{index}", item, submitted_minutes=50 - index, grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"})

    item_pending = add_item(main_session, "q2_a", max_score="3.00", version=questions["q2"]["version"], answer=questions["q2"]["answer"])
    add_attempt(
        "pending",
        item_pending,
        submitted_minutes=40,
        grade={
            "status": "pending_review",
            "method": "mixed",
            "confirmed_score": None,
            "max_score": "3.00",
            "pending_max_score": "3.00",
            "is_fully_confirmed": False,
            "parts": [{"part_id": "choice", "score": None, "max_score": "3.00", "status": "pending_review", "method": None, "detail": {"reason": "待人工"}}],
        },
    )
    rubric_q5 = next(
        obj for obj in w.objects if isinstance(obj, RubricVersion) and obj.answer_key_version_id == questions["q5"]["answer"].id
    )
    item_partial = add_item(
        main_session,
        "q5_a",
        max_score="6.00",
        version=questions["q5"]["version"],
        answer=questions["q5"]["answer"],
        rubric=rubric_q5,
    )
    attempt_partial = add_attempt(
        "partial",
        item_partial,
        submitted_minutes=39,
        grade={
            "status": "pending_review",
            "method": "mixed",
            "confirmed_score": Decimal("2.00"),
            "max_score": "6.00",
            "pending_max_score": "4.00",
            "is_fully_confirmed": False,
            "parts": [
                {"part_id": "c1", "score": "2.00", "max_score": "2.00", "status": "confirmed", "method": "deterministic", "detail": {}},
                {"part_id": "c2", "score": None, "max_score": "4.00", "status": "pending_review", "method": None, "detail": {"reason": "待人工"}},
            ],
        },
    )
    item_void = add_item(main_session, "q6_a", max_score="2.00", version=questions["q6"]["version"], answer=questions["q6"]["answer"])
    add_attempt(
        "void",
        item_void,
        submitted_minutes=38,
        grade={
            "status": "void",
            "method": "mixed",
            "confirmed_score": None,
            "max_score": "2.00",
            "pending_max_score": "2.00",
            "is_fully_confirmed": False,
            "parts": [{"part_id": "choice", "score": None, "max_score": "2.00", "status": "void", "method": None, "detail": {"reason": "作废"}}],
        },
    )
    item_ai = add_item(main_session, "q3_a", max_score="1.00", version=questions["q3"]["version"], answer=questions["q3"]["answer"])
    add_attempt(
        "ai",
        item_ai,
        submitted_minutes=37,
        grade={
            "status": "estimated",
            "method": "ai_estimated",
            "confirmed_score": None,
            "max_score": "1.00",
            "pending_max_score": "1.00",
            "is_fully_confirmed": False,
        },
    )
    item_self = add_item(main_session, "q4_a", max_score="2.00", version=questions["q4"]["version"], answer=questions["q4"]["answer"])
    add_attempt(
        "self",
        item_self,
        submitted_minutes=36,
        grade={
            "status": "confirmed",
            "method": "self_confirmed",
            "confirmed_score": Decimal("2.00"),
            "max_score": "2.00",
            "grader_is_self": True,
        },
    )
    item_invalidation = add_item(
        main_session,
        "q1_alt_a",
        max_score="2.00",
        version=q1_alt_item_extra["version"],
        answer=q1_alt_item_extra["answer"],
    )
    add_attempt(
        "invalidation",
        item_invalidation,
        submitted_minutes=35,
        grade={
            "kind": "invalidation",
            "status": "pending_review",
            "method": "mixed",
            "confirmed_score": None,
            "max_score": "2.00",
            "pending_max_score": "2.00",
            "is_fully_confirmed": False,
        },
    )
    item_disputed_answer = add_item(
        main_session,
        "q12_a",
        max_score="2.00",
        version=questions["q12"]["version"],
        answer=questions["q12"]["answer"],
    )
    attempt_disputed_answer = add_attempt(
        "disputed_answer",
        item_disputed_answer,
        submitted_minutes=34,
        grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"},
    )
    rubric_q13 = next(obj for obj in w.objects if isinstance(obj, RubricVersion) and obj.answer_key_version_id == questions["q13"]["answer"].id)
    item_disputed_rubric = add_item(
        main_session,
        "q13_a",
        max_score="6.00",
        version=questions["q13"]["version"],
        answer=questions["q13"]["answer"],
        rubric=rubric_q13,
    )
    add_attempt(
        "disputed_rubric",
        item_disputed_rubric,
        submitted_minutes=33,
        grade={"confirmed_score": Decimal("6.00"), "max_score": "6.00"},
    )
    item_unscored = add_item(main_session, "q9_a", max_score="2.00", version=questions["q9"]["version"], answer=questions["q9"]["answer"])
    add_attempt("unscored", item_unscored, submitted_minutes=32, grade=None)
    item_assisted = add_item(main_session, "q10_a", max_score="2.00", version=questions["q10"]["version"], answer=questions["q10"]["answer"])
    attempt_assisted = add_attempt(
        "assisted",
        item_assisted,
        submitted_minutes=31,
        grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"},
    )
    item_independent = add_item(main_session, "q11_a", max_score="2.00", version=questions["q11"]["version"], answer=questions["q11"]["answer"])
    attempt_independent = add_attempt(
        "independent",
        item_independent,
        submitted_minutes=30,
        grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"},
    )
    item_repeat = add_item(main_session, "q1_repeat", max_score="2.00", version=questions["q1"]["version"], answer=questions["q1"]["answer"])
    attempt_repeat = add_attempt(
        "repeat",
        item_repeat,
        submitted_minutes=29,
        grade={"confirmed_score": Decimal("0.00"), "max_score": "2.00"},
    )

    # Verification content gate: presented item on q7 hides the parallel practice attempt.
    verification_item = add_item(
        verification_session,
        "q7_verification",
        max_score="2.00",
        version=questions["q7"]["version"],
        answer=questions["q7"]["answer"],
        first_delivered=BASE - timedelta(minutes=20),
        purpose="verification",
    )
    item_q7_practice = add_item(main_session, "q7_a", max_score="2.00", version=questions["q7"]["version"], answer=questions["q7"]["answer"])
    add_attempt("hidden_content", item_q7_practice, submitted_minutes=28, grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"})
    add_item(
        verification_session,
        "q8_verification_unpresented",
        max_score="2.00",
        version=questions["q8"]["version"],
        answer=questions["q8"]["answer"],
        first_delivered=None,
        purpose="verification",
    )
    item_q8_practice = add_item(main_session, "q8_a", max_score="2.00", version=questions["q8"]["version"], answer=questions["q8"]["answer"])
    add_attempt("unpresented_visible", item_q8_practice, submitted_minutes=27, grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"})

    # Expired mock exam: the report must reconcile it and count the attempt.
    mock_item = add_item(
        mock_session,
        "q9_mock",
        max_score="2.00",
        version=questions["q9"]["version"],
        answer=questions["q9"]["answer"],
        first_delivered=BASE - timedelta(hours=2),
        purpose="mock",
    )
    add_attempt("mock_expired", mock_item, submitted_minutes=120, grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"})

    # Evidence rows used by the report/calibration.
    def add_evidence(name: str, attempt, *, dimension: str, qualifies: bool, node=None, is_active=True, reasons=None):
        w.create(
            LearningEvidence,
            "evidence",
            f"evidence_{name}",
            attempt=attempt,
            session_item=attempt.session_item,
            user=user,
            project=project,
            grade_event=attempt.current_grade_event,
            grade_revision=1,
            knowledge_node=node,
            dimension=dimension,
            qualifies=qualifies,
            is_correct=qualifies,
            score_fraction=Decimal("1.0000") if qualifies else Decimal("0.0000"),
            exclusion_reasons=reasons or [],
            rule_version="p2-c04",
            computed_at=BASE,
            is_active=is_active,
        )

    add_evidence("assisted", attempt_assisted, dimension="unassisted_completion", qualifies=False, node=root, reasons=["active_verification_content_gate"])
    add_evidence("assisted_independent", attempt_assisted, dimension="independent_correct", qualifies=True, node=root)
    add_evidence("independent", attempt_independent, dimension="independent_correct", qualifies=True, node=child)
    add_evidence("repeat", attempt_repeat, dimension="repeat_practice", qualifies=True, node=root)
    add_evidence("a1", attempt_a1, dimension="independent_correct", qualifies=True, node=root)
    add_evidence("a1_inactive", attempt_a1, dimension="unassisted_completion", qualifies=False, node=root, is_active=False)
    add_evidence("disputed_answer", attempt_disputed_answer, dimension="unassisted_completion", qualifies=False, node=child)
    add_evidence("partial", attempt_partial, dimension="independent_correct", qualifies=True, node=root)

    # Papers for coverage and cycle analysis.
    def add_paper(name, cycle_key, *, source_kind="official_past", is_demo=False, coverage=None, items=None, effective=True, revision_status="confirmed"):
        paper = w.create(
            Paper,
            "paper",
            f"paper_{name}",
            subject=subject,
            cycle_key=cycle_key,
            session_key="",
            paper_code=name,
            title=f"{cycle_key}{name}",
            source_kind=source_kind,
            is_demo=is_demo,
        )
        revision = w.create(
            PaperRevision,
            "revision",
            f"revision_{name}",
            paper=paper,
            revision=1,
            spec_version=spec,
            expected_session_count=coverage[0] if coverage else None,
            covered_session_count=coverage[1] if coverage else None,
            coverage_confirmed_at=(BASE if coverage and coverage[2] else None),
            coverage_confirmed_by=user if coverage and coverage[2] else None,
            status=revision_status,
            note="fixture",
        )
        if effective:
            paper.effective_revision = revision
            paper.save(update_fields=["effective_revision"])
        for position, item in enumerate(items or []):
            version = item["version"]
            w.create(
                PaperItem,
                "paper_item",
                f"paper_item_{name}_{position}",
                revision=revision,
                position_key=item.get("position", str(position + 1)),
                question_version=version,
                answer_key_version=item.get("answer"),
                max_score=Decimal(item.get("max_score", "2.00")),
                is_scored=item.get("is_scored", True),
            )
        return paper, revision

    add_paper(
        "2025A",
        "2025",
        coverage=(2, 2, True),
        items=[
            {"version": questions["q1"]["version"], "answer": questions["q1"]["answer"], "max_score": "2.00", "position": "1"},
            {"version": questions["q2"]["version"], "answer": questions["q2"]["answer"], "max_score": "3.00", "position": "2"},
            {"version": questions["q5"]["version"], "answer": questions["q5"]["answer"], "max_score": "0.00", "position": "3", "is_scored": False},
        ],
    )
    add_paper(
        "2025B",
        "2025",
        coverage=(2, 2, True),
        items=[
            {"version": questions["q5"]["version"], "answer": questions["q5"]["answer"], "max_score": "10.00", "position": "1"},
        ],
    )
    add_paper(
        "2024A",
        "2024",
        coverage=(2, 1, False),
        items=[{"version": questions["q1"]["version"], "answer": questions["q1"]["answer"], "max_score": "2.00"}],
    )
    add_paper("2023demo", "2023", source_kind="demo", is_demo=True, coverage=(1, 1, True), items=[{"version": questions["q1"]["version"], "answer": questions["q1"]["answer"]}])
    add_paper("2023none", "2023", coverage=None, items=[], effective=False)
    add_paper("2022empty", "2022", coverage=(1, 1, True), items=[])

    # Regrade questions: q14 (two attempts + one settled by a newer generation), q15 (old-vs-new), q1_alt (content change).
    regrade_attempts = {}
    for name in ("r14a", "r14b", "r14settled"):
        item = add_item(
            regrade_session,
            f"q14_{name}",
            max_score="2.00",
            version=questions["q14"]["version"],
            answer=questions["q14"]["answer"],
        )
        grade_confirmed = 0 if name != "r14settled" else 2
        attempt = add_attempt(
            name,
            item,
            submitted_minutes=10 + len(regrade_attempts),
            grade={"confirmed_score": Decimal(str(grade_confirmed)), "max_score": "2.00"},
            applied_generation=6 if name == "r14settled" else 0,
        )
        regrade_attempts[name] = attempt
        add_evidence(f"regrade_{name}", attempt, dimension="independent_correct", qualifies=True, node=child)
    item_r15 = add_item(
        regrade_session,
        "q15_attempt",
        max_score="2.00",
        version=questions["q15"]["version"],
        answer=questions["q15"]["answer"],
    )
    attempt_r15 = add_attempt(
        "r15a",
        item_r15,
        submitted_minutes=20,
        grade={"confirmed_score": Decimal("0.00"), "max_score": "2.00"},
    )
    add_evidence("regrade_r15", attempt_r15, dimension="independent_correct", qualifies=True, node=child)
    item_content = add_item(
        regrade_session,
        "q18_alt_attempt",
        max_score="2.00",
        version=q18_alt,
        answer=q18_alt_answer,
    )
    attempt_content = add_attempt(
        "r_content",
        item_content,
        submitted_minutes=21,
        grade={"confirmed_score": Decimal("2.00"), "max_score": "2.00"},
    )
    add_evidence("regrade_content", attempt_content, dimension="independent_correct", qualifies=True, node=root)

    w.fix_timestamps()
    return {
        "world": w,
        "user": user,
        "other_user": other_user,
        "project": project,
        "other_project": other_project,
        "subject": subject,
        "other_subject": other_subject,
        "foreign_subject": foreign_subject,
        "syllabus": syllabus,
        "draft_syllabus": draft_syllabus,
        "other_syllabus": other_syllabus,
        "root": root,
        "child": child,
        "other_node": other_node,
        "unclassified": unclassified,
        "draft_node": draft_node,
        "physics_node": physics_node,
        "spec": spec,
        "questions": questions,
        "regrade_attempts": regrade_attempts,
        "attempt_r15": attempt_r15,
        "attempt_content": attempt_content,
        "main_session": main_session,
        "regrade_session": regrade_session,
    }


# ---------------------------------------------------------------------------
# captures
# ---------------------------------------------------------------------------
def snapshot_rows(user, project, limit=10):
    rows = list(ReportSnapshot.objects.filter(user=user, project=project).order_by("-as_of")[:limit])
    return [jsonable(dump_row(row)) for row in rows]


def answer_review_rows(user, project):
    from django.db.models import Q

    from apps.common.enums import VerificationStatus
    from apps.question_bank.models import AnswerKeyVersion

    queryset = (
        AnswerKeyVersion.objects.filter(question_version__question__subject__project=project)
        .filter(Q(verification_status__in=[VerificationStatus.PENDING, VerificationStatus.CHECKED]) | Q(is_disputed=True))
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


def normalize_regrade_case(world: dict, run, *, name: str, involved: list[str], before_grade_ids: set[str]):
    payload = report_service.regrade_payload(run)
    payload["regrade_run_id"] = "<run>"
    payload = jsonable(payload)
    new_grades = [grade for grade in GradeEvent.objects.all() if str(grade.id) not in before_grade_ids]
    new_grades.sort(key=lambda grade: (grade.created_at, NAMES.get(str(grade.attempt_id), ""), str(grade.id)))
    grade_rows = []
    for grade in new_grades:
        if NAMES.get(str(grade.attempt_id)) not in {f"attempt_{name}" for name in involved}:
            continue
        grade_rows.append(
            {
                "attempt": NAMES.get(str(grade.attempt_id), str(grade.attempt_id)),
                "kind": grade.kind,
                "status": grade.status,
                "method": grade.method,
                "confirmed_score": None if grade.confirmed_score is None else str(grade.confirmed_score),
                "pending_max_score": str(grade.pending_max_score),
                "is_fully_confirmed": grade.is_fully_confirmed,
                "grading_revision": grade.grading_revision,
                "answer_key_version": None if not grade.answer_key_version_id else str(grade.answer_key_version_id),
                "rubric_version": None if not grade.rubric_version_id else str(grade.rubric_version_id),
                "comment": grade.comment,
                "invalidation_reason": grade.invalidation_reason,
                "superseded": grade.is_superseded,
                "rule_generation": (grade.rule_snapshot or {}).get("regrade_generation"),
            }
        )
    attempts = {}
    for attempt_name in involved:
        attempt_id = IDS[f"attempt_{attempt_name}"]
        attempt = Attempt.objects.get(id=attempt_id)
        current = attempt.current_grade_event
        attempts[attempt_name] = {
            "applied_regrade_generation": attempt.applied_regrade_generation,
            "grading_revision": attempt.grading_revision,
            "current_kind": None if current is None else current.kind,
            "current_status": None if current is None else current.status,
            "current_grade": None if current is None else str(current.id),
        }
    # Symbolize the current grade ids against names only when they were seeded.
    for row in attempts.values():
        if row["current_grade"] is not None:
            row["current_grade"] = "new" if row["current_grade"] not in NAMES else NAMES[row["current_grade"]]
    evidence = {}
    for attempt_name in involved:
        attempt_id = IDS[f"attempt_{attempt_name}"]
        rows = list(LearningEvidence.objects.filter(attempt_id=attempt_id))
        evidence[attempt_name] = {
            "active": sum(1 for row in rows if row.is_active),
            "total": len(rows),
            "reasons": sorted({row.invalidated_reason for row in rows if not row.is_active}),
        }
    states = {}
    for state in LearnerKnowledgeState.objects.filter(user_id=world["user"].id, project_id=world["project"].id).order_by("node__canonical_name"):
        states[str(state.node_id)] = {
            "summary": state.summary,
            "best_summary": state.best_summary,
            "independent_correct_count": state.independent_correct_count,
            "distinct_question_count": state.distinct_question_count,
            "recent_independent_attempts": state.recent_independent_attempts,
            "recent_independent_failures": state.recent_independent_failures,
            "needs_review": state.needs_review,
        }
    run_row = {
        "status": run.status,
        "scope": run.scope,
        "generation": run.generation,
        "affected_attempts": run.affected_attempts,
        "regraded_attempts": run.regraded_attempts,
        "stale_skipped_attempts": run.stale_skipped_attempts,
        "invalidated_evidence": run.invalidated_evidence,
        "error_message": run.error_message,
        "reason": run.reason,
        "started": run.started_at is not None,
        "finished": run.finished_at is not None,
    }
    return {
        "name": name,
        "run": run_row,
        "expected_payload": payload,
        "grades": grade_rows,
        "attempts": attempts,
        "evidence": evidence,
        "states": states,
        "grade_id_delta": len([g for g in GradeEvent.objects.all() if str(g.id) not in before_grade_ids]),
    }


def main() -> None:
    world = seed_world()
    w = world["world"]
    user = world["user"]
    project = world["project"]
    subject = world["subject"]
    other_subject = world["other_subject"]

    # Captured before the report runs: its read path reconciles the overdue mock exam, and the
    # replay must exercise that transition rather than seed its result.
    tables = w.rows()

    with mock.patch("django.utils.timezone.now", return_value=NOW):
        report_with = report_service.build_practice_report(user=user, project=project, subject=None, save_snapshot=True)
        snapshots = snapshot_rows(user, project)
        report_without = report_service.build_practice_report(user=user, project=project, subject=None, save_snapshot=False)
        report_subject = report_service.build_practice_report(user=user, project=project, subject=subject, save_snapshot=False)
        report_other_subject = report_service.build_practice_report(
            user=user, project=project, subject=other_subject, save_snapshot=False
        )
        papers = report_service.paper_coverage(subject=subject)
        completion = report_service.coverage_completion(subject=subject, papers=papers)
        from apps.analytics.services import cycles as cycle_service

        cycle_full = cycle_service.cycle_analysis(subject=subject, max_cycles=5)
        cycle_one = cycle_service.cycle_analysis(subject=subject, max_cycles=1)
        calibration = calibration_service.build_effect_calibration(user=user, project=project, subject=None)
        calibration_subject = calibration_service.build_effect_calibration(
            user=user, project=project, subject=other_subject
        )
        answers = answer_review_rows(user, project)

        # Regrades ---------------------------------------------------------
        before_grade_ids = {str(grade.id) for grade in GradeEvent.objects.all()}
        case_ok_run = report_service.request_regrade(
            question=world["questions"]["q14"]["question"],
            target_answer_key_version=world["questions"]["q14"]["answer"],
            target_rubric_version=None,
            actor=user,
            reason="答案勘误后重判",
        )
        case_ok = normalize_regrade_case(
            world, case_ok_run, name="execute_success", involved=["r14a", "r14b", "r14settled"], before_grade_ids=before_grade_ids
        )
        before_grade_ids = {str(grade.id) for grade in GradeEvent.objects.all()}
        # Execution is deliberately separate from the request above so the golden captures the
        # queued counter state and the executed state under the same frozen clock.
        report_service.execute_regrade_run(str(case_ok_run.id))
        case_ok_run.refresh_from_db()
        case_ok["executed_run"] = normalize_regrade_case(
            world, case_ok_run, name="execute_success_executed", involved=["r14a", "r14b", "r14settled"], before_grade_ids=before_grade_ids
        )["run"]

        # Content-version branch: the target answer belongs to Q1 v1, the attempt froze v2.
        before_grade_ids = {str(grade.id) for grade in GradeEvent.objects.all()}
        content_run = report_service.request_regrade(
            question=world["questions"]["q18"]["question"],
            target_answer_key_version=world["questions"]["q18"]["answer"],
            target_rubric_version=None,
            actor=user,
            reason="内容已改版，证据失效",
        )
        report_service.execute_regrade_run(str(content_run.id))
        content_run.refresh_from_db()
        case_content = normalize_regrade_case(
            world, content_run, name="content_change", involved=["r_content"], before_grade_ids=before_grade_ids
        )

        # Old generation ordering: request A, request B, execute B, then A.
        before_grade_ids = {str(grade.id) for grade in GradeEvent.objects.all()}
        old_run = report_service.request_regrade(
            question=world["questions"]["q15"]["question"],
            target_answer_key_version=world["questions"]["q15"]["answer"],
            target_rubric_version=None,
            actor=user,
            reason="旧代次请求",
        )
        new_run = report_service.request_regrade(
            question=world["questions"]["q15"]["question"],
            target_answer_key_version=world["questions"]["q15"]["answer"],
            target_rubric_version=None,
            actor=user,
            reason="新代次请求",
        )
        report_service.execute_regrade_run(str(new_run.id))
        report_service.execute_regrade_run(str(old_run.id))
        old_run.refresh_from_db()
        new_run.refresh_from_db()
        case_old = normalize_regrade_case(
            world, old_run, name="old_generation_after_new", involved=["r15a"], before_grade_ids=before_grade_ids
        )
        case_new_run = normalize_regrade_case(
            world, new_run, name="new_generation", involved=["r15a"], before_grade_ids=before_grade_ids
        )
        case_old["newer_run"] = case_new_run["run"]

        # Trust refusal: request, then dispute the target, then execute.
        before_grade_ids = {str(grade.id) for grade in GradeEvent.objects.all()}
        dispute_run = report_service.request_regrade(
            question=world["questions"]["q14"]["question"],
            target_answer_key_version=world["questions"]["q14"]["answer"],
            target_rubric_version=None,
            actor=user,
            reason="目标随后进入争议",
        )
        answer = world["questions"]["q14"]["answer"]
        answer.is_disputed = True
        answer.dispute_reason = "执行前发生争议"
        answer.save(update_fields=["is_disputed", "dispute_reason", "updated_at"])
        report_service.execute_regrade_run(str(dispute_run.id))
        dispute_run.refresh_from_db()
        case_refused = normalize_regrade_case(
            world, dispute_run, name="refused_untrusted_target", involved=["r14a", "r14b", "r14settled"], before_grade_ids=before_grade_ids
        )

    payload = {
        "generated_by": "scripts/gen_analytics_b6_golden.py",
        "symbols": SYMBOLS,
        "now": NOW.isoformat(),
        "tables": tables,
        "practice_report": {
            "expected": jsonable(report_with),
            "snapshot": {**jsonable(snapshots[0]), "id": "<snapshot:1>"},
            "snapshot_count": len(snapshots),
            "snapshots": [
                {**jsonable(row), "id": f"<snapshot:{index + 1}>"} for index, row in enumerate(snapshots)
            ],
        },
        "practice_report_no_snapshot": jsonable(report_without),
        "practice_report_subject": jsonable(report_subject),
        "practice_report_other_subject": jsonable(report_other_subject),
        "coverage": {
            "subject_id": str(subject.id),
            "papers": jsonable(papers),
            "completion": jsonable(completion),
        },
        "cycle_analysis": {
            "max_cycles_5": jsonable(cycle_full),
            "max_cycles_1": jsonable(cycle_one),
        },
        "calibration": {
            "project": jsonable(calibration),
            "other_subject": jsonable(calibration_subject),
        },
        "answer_reviews": jsonable(answers),
        "regrades": {
            "success": case_ok,
            "content_change": case_content,
            "old_generation_after_new": case_old,
            "refused_untrusted_target": case_refused,
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(text)} bytes)")


if __name__ == "__main__":
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        main()
    finally:
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
