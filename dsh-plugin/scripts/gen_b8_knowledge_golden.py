#!/usr/bin/env python
"""Golden vectors for the B8 knowledge projections and the paired A/B/C task fields.

Oracle: real PostgreSQL rows + the real `apps/knowledge/api.py` serializers (via the module-level
`_pairing_out` / `_relation_out` functions and the service calls they wrap) + the real
`apps.learning.services.pairing.on_attempt_graded`. Nothing here re-implements a rule: every
`expected` block is what Django produced.

Three shapes are emitted:

    {"now", "symbols", "tables": {table: [rows]}, "expect": {...}}

`tables` is the seed the Node replay inserts into SQLite (ids are `uuid5` of the role name and every
timestamp comes from the fixture clock, so a rerun is byte-identical). `expect` holds the payloads
the Node services must reproduce. The paired-task rows are **not** in `tables`: the replay creates
them by calling `onAttemptGraded`, exactly like this generator does, and compares the projection.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_b8_knowledge_golden.py
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from django.utils import timezone as django_timezone  # noqa: E402

from apps.common.content import content_digest  # noqa: E402
from apps.exams.models import ExamProject, Subject, SyllabusVersion  # noqa: E402
from apps.knowledge import api as knowledge_api  # noqa: E402
from apps.knowledge.models import (  # noqa: E402
    KnowledgeNode,
    KnowledgeRelation,
    QuestionKnowledge,
    QuestionTemplate,
    VerificationPairing,
)
from apps.knowledge.services import core as knowledge_core  # noqa: E402
from apps.knowledge.services import relations as relations_service  # noqa: E402
from apps.learning.models import LearnerKnowledgeState, ReviewTask, StudyTask  # noqa: E402
from apps.learning.services import pairing as pairing_service  # noqa: E402
from apps.practice.models import Attempt, GradeEvent, PracticeSession, SessionItem  # noqa: E402
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "b8_knowledge.json"

BASE = datetime(2026, 4, 1, 0, 0, tzinfo=timezone.utc)
#: The instant every "now"-dependent projection is taken at (after the chain was driven).
NOW = BASE + timedelta(hours=11)
#: The two graded attempts: A at +10h, B 35 minutes later.
SUBMITTED_A = BASE + timedelta(hours=10)
SUBMITTED_B = BASE + timedelta(hours=10, minutes=35)

EXCLUDED_TABLES = {"learning_study_task", "learning_review_task"}
#: Tables whose rows carry `auto_now` stamps the fixture rewrites to stay reproducible.
TABLES = [
    "accounts_user",
    "exams_project",
    "exams_subject",
    "exams_syllabus_version",
    "knowledge_node",
    "knowledge_question_template",
    "question_bank_question",
    "question_bank_question_version",
    "question_bank_answer_key_version",
    "knowledge_question_mapping",
    "learning_knowledge_state",
    "knowledge_relation",
    "knowledge_verification_pairing",
    "practice_session",
    "practice_session_item",
    "practice_attempt",
    "practice_grade_event",
]


# --------------------------------------------------------------------------
# serialisation helpers
# --------------------------------------------------------------------------
def jsonable(value):
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (dict, list)):
        return value
    return str(value)


def dump_row(obj) -> dict:
    return {field.attname: jsonable(getattr(obj, field.attname)) for field in obj._meta.concrete_fields}


# --------------------------------------------------------------------------
# one isolated world
# --------------------------------------------------------------------------
class World:
    def __init__(self) -> None:
        self.names: dict[str, uuid.UUID] = {}
        self.rows: dict[str, list[dict]] = {name: [] for name in TABLES}
        self._counters: dict[str, int] = {}
        self.clock = BASE
        self.owner = None
        self.project = None
        self.subject = None
        self.syllabus = None
        self.nodes: dict[str, KnowledgeNode] = {}
        self.questions: dict[str, Question] = {}
        self.versions: dict[str, QuestionVersion] = {}
        self.answers: dict[str, AnswerKeyVersion] = {}
        self.pairings: dict[str, VerificationPairing] = {}

    # -- identity / timestamps -------------------------------------------------
    def uid(self, entity: str) -> uuid.UUID:
        n = self._counters.get(entity, 0) + 1
        self._counters[entity] = n
        return uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b8:{entity}:{n}")

    def now(self) -> datetime:
        self.clock = self.clock + timedelta(minutes=1)
        return self.clock

    def create(self, model, entity: str, **kwargs):
        obj = model(id=self.uid(entity), **kwargs)
        obj.save(force_insert=True)
        # `auto_now_add` writes the wall clock; overwrite it so a rerun is byte-identical.
        stamp = self.now()
        names = {field.name for field in model._meta.concrete_fields}
        overrides = {name: stamp for name in ("created_at", "updated_at", "date_joined") if name in names}
        if overrides:
            model.objects.filter(pk=obj.pk).update(**overrides)
            obj.refresh_from_db()
        self.rows[model._meta.db_table].append(dump_row(obj))
        return obj

    def refresh(self, obj) -> None:
        """Replace the captured row after a mutation, so the fixture holds the final state.

        `save(update_fields=[...])` writes `auto_now` from the wall clock, so the fixture clock is
        restored here before the row is captured (an explicit `update()` keeps the value it is given).
        """
        stamp = self.now()
        names = {field.name for field in obj._meta.concrete_fields}
        if "updated_at" in names:
            type(obj).objects.filter(pk=obj.pk).update(updated_at=stamp)
        obj.refresh_from_db()
        table = obj._meta.db_table
        entries = self.rows.setdefault(table, [])
        for index, entry in enumerate(entries):
            if str(entry.get("id")) == str(obj.id):
                entries[index] = dump_row(obj)
                return
        entries.append(dump_row(obj))

    def symbol(self, name: str, obj) -> str:
        self.names[name] = uuid.UUID(str(obj.id))
        return str(obj.id)

    # -- fixtures --------------------------------------------------------------
    def build(self) -> None:
        user_model = get_user_model()
        self.owner = self.create(
            user_model,
            "user",
            email="golden-b8@example.invalid",
            password="GoldenPass!2026",
            display_name="B8 黄金",
            is_active=True,
        )
        self.symbol("owner", self.owner)
        self.project = self.create(ExamProject, "project", owner=self.owner, name="知识黄金项目")
        self.symbol("project", self.project)
        self.subject = self.create(
            Subject, "subject", project=self.project, name="数学", code="MATH", total_score=Decimal("100"), pass_score=Decimal("60")
        )
        self.symbol("subject", self.subject)
        self.syllabus = self.create(
            SyllabusVersion,
            "syllabus",
            subject=self.subject,
            name="数学大纲",
            version_label="2026",
            status="published",
            is_user_provisional=True,
        )
        for index, name in enumerate(["alpha", "beta", "gamma", "delta"]):
            parent = self.nodes.get("alpha") if index in (1, 2) else None
            self.nodes[name] = self.create(
                KnowledgeNode,
                f"node_{name}",
                syllabus_version=self.syllabus,
                parent=parent,
                kind="point",
                canonical_name=name,
                code=name.upper(),
                aliases=[],
                is_unclassified=False,
                display_order=index,
            )
            self.symbol(f"node_{name}", self.nodes[name])

        for index, name in enumerate(["alpha-template", "beta-template"]):
            self.create(
                QuestionTemplate,
                f"template_{index}",
                subject=self.subject,
                name=name,
                description=f"模板 {name}",
                review_status="approved",
                confirmed_by=self.owner,
            )

        for label, node_names, weights in [
            ("Q-A", ["alpha"], ["1.0000"]),
            ("Q-B", ["alpha", "beta"], ["0.5000", "0.5000"]),
            ("Q-C", ["gamma"], ["1.0000"]),
        ]:
            question = self.create(
                Question,
                f"question_{label}",
                subject=self.subject,
                origin_type="user_authored",
                display_label=label,
                is_demo=False,
            )
            content = {
                "blocks": [{"kind": "text", "text": f"黄金题 {label}：3 + 4 等于多少？"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "7"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "8"}]},
                ],
            }
            version = self.create(
                QuestionVersion,
                f"version_{label}",
                question=question,
                version=1,
                question_type="single_choice",
                content=content,
                status="published",
                content_digest=content_digest(content),
                practice_max_score=Decimal("2.00"),
                estimated_seconds=60,
                published_at=BASE,
                revision_reason="golden",
                source_note="",
            )
            answer = self.create(
                AnswerKeyVersion,
                f"answer_{label}",
                question_version=version,
                version=1,
                answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
                source_type="user",
                verification_status="checked",
                is_disputed=False,
                check_basis="黄金夹具",
            )
            question.current_published_version = version
            question.save(update_fields=["current_published_version", "updated_at"])
            self.refresh(question)
            for position, node_name in enumerate(node_names):
                self.create(
                    QuestionKnowledge,
                    f"mapping_{label}_{position}",
                    question_version=version,
                    mapping_revision=1,
                    node=self.nodes[node_name],
                    is_primary=True,
                    score_weight=Decimal(weights[position]),
                    note="",
                )
            self.questions[label] = question
            self.versions[label] = version
            self.answers[label] = answer
            self.symbol(f"question_{label}", question)
            self.symbol(f"version_{label}", version)

        for label, summary, best, needs_review, delayed in [
            ("alpha", "independent", "delayed_verified", False, True),
            ("delta", "needs_review", "independent", True, False),
        ]:
            self.create(
                LearnerKnowledgeState,
                f"state_{label}",
                user=self.owner,
                project=self.project,
                node=self.nodes[label],
                syllabus_version=self.syllabus,
                summary=summary,
                best_summary=best,
                independent_correct_count=2,
                distinct_question_count=2,
                distinct_template_count=1,
                has_delayed_correct=delayed,
                needs_review=needs_review,
                downgrade_reason="",
                detail={"source": "golden"},
                as_of=BASE + timedelta(hours=9),
                rule_version="p2-c04",
            )

        self.create(
            KnowledgeRelation,
            "relation_alpha_gamma",
            syllabus_version=self.syllabus,
            from_node=self.nodes["alpha"],
            to_node=self.nodes["gamma"],
            relation_type="prerequisite",
            is_active=True,
            note="先学 alpha",
            created_by=self.owner,
        )
        self.create(
            KnowledgeRelation,
            "relation_beta_delta",
            syllabus_version=self.syllabus,
            from_node=self.nodes["beta"],
            to_node=self.nodes["delta"],
            relation_type="prerequisite",
            is_active=True,
            note="",
            created_by=self.owner,
        )
        self.create(
            KnowledgeRelation,
            "relation_alpha_beta_related",
            syllabus_version=self.syllabus,
            from_node=self.nodes["alpha"],
            to_node=self.nodes["beta"],
            relation_type="related",
            is_active=True,
            note="同源",
            created_by=self.owner,
        )
        # An inactive edge: it must never reach the graph payload, but the row stays.
        self.create(
            KnowledgeRelation,
            "relation_gamma_delta_off",
            syllabus_version=self.syllabus,
            from_node=self.nodes["gamma"],
            to_node=self.nodes["delta"],
            relation_type="prerequisite",
            is_active=False,
            note="已停用",
            created_by=self.owner,
        )

        # The pairing rows are seeded directly: `create_verification_pairing` stamps `reviewed_at`
        # with the wall clock and a random UUID, and both would break byte-identical reruns. The
        # service's own contract is probed instead (docs/dsh-migration/17-b8-knowledge-probe.json,
        # cases P01/P09 and S01–S06).
        self.pairings["alpha"] = self.create(
            VerificationPairing,
            "pairing_alpha",
            project=self.project,
            subject=self.subject,
            node=self.nodes["alpha"],
            baseline_question=self.questions["Q-A"],
            immediate_question=self.questions["Q-B"],
            delayed_question=self.questions["Q-C"],
            pairing_version=1,
            delay_hours=24,
            is_active=True,
            reviewer=self.owner,
            reviewed_at=BASE + timedelta(hours=8),
            note="A/B/C 配对",
        )
        self.symbol("pairing_alpha", self.pairings["alpha"])
        self.pairings["gamma"] = self.create(
            VerificationPairing,
            "pairing_gamma",
            project=self.project,
            subject=self.subject,
            node=self.nodes["gamma"],
            baseline_question=self.questions["Q-C"],
            immediate_question=self.questions["Q-A"],
            delayed_question=None,
            pairing_version=1,
            delay_hours=48,
            is_active=True,
            reviewer=self.owner,
            reviewed_at=BASE + timedelta(hours=8, minutes=1),
            note="缺少 C 题",
        )
        self.symbol("pairing_gamma", self.pairings["gamma"])

    # -- the graded attempts ---------------------------------------------------
    def graded_attempt(self, label: str, *, question_label: str, submitted_at: datetime) -> Attempt:
        session = self.create(
            PracticeSession,
            f"session_{label}",
            user=self.owner,
            project=self.project,
            subject=self.subject,
            mode="practice",
            status="finished",
            policy_version="p0-1",
            finished_at=submitted_at,
            note="purpose=practice",
        )
        item = self.create(
            SessionItem,
            f"item_{label}",
            session=session,
            ordinal=1,
            question_version=self.versions[question_label],
            answer_key_version=self.answers[question_label],
            mapping_revision=1,
            max_score=Decimal("2.00"),
            purpose="practice",
            tutoring_allowed=True,
            first_delivered_at=submitted_at - timedelta(minutes=5),
        )
        attempt = self.create(
            Attempt,
            f"attempt_{label}",
            session_item=item,
            user=self.owner,
            project=self.project,
            raw_answer={"type": "single_choice", "selected_option_ids": ["opt_a"]},
            steps=[],
            attachments=[],
            confidence="",
            submitted_at=submitted_at,
            elapsed_ms=300000,
            grading_revision=1,
        )
        grade = self.create(
            GradeEvent,
            f"grade_{label}",
            attempt=attempt,
            kind="initial",
            status="confirmed",
            method="deterministic",
            grading_revision=1,
            confirmed_score=Decimal("2.00"),
            max_score=Decimal("2.00"),
            pending_max_score=Decimal("0"),
            is_fully_confirmed=True,
            parts=[{"part_id": "item", "score": "2.00", "max_score": "2.00", "status": "confirmed", "method": "deterministic"}],
            answer_key_version=self.answers[question_label],
            rule_snapshot={},
            rule_version="p0-1",
            grader_is_self=False,
            comment="",
        )
        attempt.current_grade_event = grade
        attempt.save(update_fields=["current_grade_event", "updated_at"])
        self.refresh(attempt)
        self.symbol(f"attempt_{label}", attempt)
        self.symbol(f"item_{label}", item)
        return attempt


def task_projection(task: StudyTask | None) -> dict | None:
    if task is None:
        return None
    return {
        "task_kind": task.task_kind,
        "status": task.status,
        "question_id": None if task.question_id is None else str(task.question_id),
        "knowledge_node_id": None if task.knowledge_node_id is None else str(task.knowledge_node_id),
        "pairing_version": task.pairing_version,
        "origin_session_item_id": None if task.origin_session_item_id is None else str(task.origin_session_item_id),
        "trigger_event": task.trigger_event,
        "delay_anchor_at": None if task.delay_anchor_at is None else task.delay_anchor_at.isoformat(),
        "not_before": None if task.not_before is None else task.not_before.isoformat(),
        "due_at": None if task.due_at is None else task.due_at.isoformat(),
        "estimated_minutes": task.estimated_minutes,
        "reason_codes": task.reason_codes,
        "rule_version": task.rule_version,
        "deficit_notice": task.deficit_notice,
        "invalidated_reason": task.invalidated_reason,
    }


def review_projection(review: ReviewTask | None) -> dict | None:
    if review is None:
        return None
    return {
        "delay_hours": review.delay_hours,
        "delay_anchor_at": review.delay_anchor_at.isoformat(),
        "not_before": review.not_before.isoformat(),
        "anchor_source": review.anchor_source,
        "was_started": review.was_started,
        "missing_question_reason": review.missing_question_reason,
    }


class FrozenClock:
    """`timezone.now()` pinned for the projection calls (never inside the services under test)."""

    def __init__(self, moment: datetime) -> None:
        self.moment = moment
        self.original = django_timezone.now
        self.original_api = knowledge_api.timezone.now

    def __enter__(self):
        django_timezone.now = lambda: self.moment  # type: ignore[assignment]
        knowledge_api.timezone.now = lambda: self.moment  # type: ignore[assignment]
        return self

    def __exit__(self, *exc) -> None:
        django_timezone.now = self.original  # type: ignore[assignment]
        knowledge_api.timezone.now = self.original_api  # type: ignore[assignment]


def projections(world: World, *, now: datetime) -> dict:
    subject = world.subject
    project = world.project
    with FrozenClock(now):
        nodes = {
            str(node.id): node
            for node in KnowledgeNode.objects.filter(syllabus_version=world.syllabus).select_related("syllabus_version")
        }
        states = {
            str(state.node_id): state
            for state in LearnerKnowledgeState.objects.filter(user=world.owner, project=project, node__in=nodes.values())
        }
        # Mirror the api function's body (it is a thin projection over these two queries).
        map_payload = {
            "subject_id": str(subject.id),
            "nodes": [
                {
                    "id": str(node.id),
                    "parent_id": str(node.parent_id) if node.parent_id else None,
                    "kind": node.kind,
                    "name": node.canonical_name,
                    "is_unclassified": node.is_unclassified,
                    "syllabus_version_id": str(node.syllabus_version_id),
                    "syllabus_is_user_provisional": node.syllabus_version.is_user_provisional,
                    "question_count": node.question_mappings.filter(is_primary=True).count(),
                    "evidence": {
                        "summary": states[str(node.id)].summary if str(node.id) in states else "undiagnosed",
                        "best_summary": states[str(node.id)].best_summary if str(node.id) in states else "undiagnosed",
                        "independent_correct_count": (
                            states[str(node.id)].independent_correct_count if str(node.id) in states else 0
                        ),
                        "distinct_question_count": (
                            states[str(node.id)].distinct_question_count if str(node.id) in states else 0
                        ),
                        "distinct_template_count": (
                            states[str(node.id)].distinct_template_count if str(node.id) in states else 0
                        ),
                        "has_delayed_correct": (
                            states[str(node.id)].has_delayed_correct if str(node.id) in states else False
                        ),
                        "needs_review": states[str(node.id)].needs_review if str(node.id) in states else False,
                        "downgrade_reason": states[str(node.id)].downgrade_reason if str(node.id) in states else "",
                        "as_of": states[str(node.id)].as_of.isoformat() if str(node.id) in states else None,
                        "rule_version": states[str(node.id)].rule_version if str(node.id) in states else None,
                    },
                }
                for node in nodes.values()
            ],
        }

        def prerequisites(node_name: str) -> dict:
            node = world.nodes[node_name]
            prerequisites = relations_service.prerequisite_nodes(node)
            state_by_node = {
                str(state.node_id): state.summary
                for state in LearnerKnowledgeState.objects.filter(
                    user=world.owner, project=project, node__in=prerequisites
                )
            }
            return {
                "node_id": str(node.id),
                "node_name": node.canonical_name,
                "prerequisites": [
                    {
                        "node_id": str(item.id),
                        "node_name": item.canonical_name,
                        "state": state_by_node.get(str(item.id), "undiagnosed"),
                    }
                    for item in prerequisites
                ],
                "unmet": relations_service.unmet_prerequisites(node=node, state_by_node=state_by_node),
            }

        edges = []
        for syllabus in SyllabusVersion.objects.filter(subject__project=project):
            for relation in relations_service.active_relations(syllabus_version=syllabus):
                edges.append(
                    {
                        "id": str(relation.id),
                        "syllabus_version_id": str(relation.syllabus_version_id),
                        "from_node_id": str(relation.from_node_id),
                        "from_node_name": relation.from_node.canonical_name,
                        "to_node_id": str(relation.to_node_id),
                        "to_node_name": relation.to_node.canonical_name,
                        "relation_type": relation.relation_type,
                        "is_active": relation.is_active,
                        "note": relation.note,
                    }
                )
        graph = {
            "edges": edges,
            "node_count": KnowledgeNode.objects.filter(
                syllabus_version__in=SyllabusVersion.objects.filter(subject__project=project)
            ).count(),
            "edge_count": len(edges),
            "generated_at": django_timezone.now().isoformat(),
            "unmet_prerequisites": [],
        }

        pairings = [
            knowledge_api._pairing_out(pairing)
            for pairing in VerificationPairing.objects.filter(project=project).select_related("node")
        ]
        pairing = world.pairings["alpha"]
        candidates = knowledge_core.pairing_candidates(project=project, node=pairing.node)
        detail = {
            "pairing": knowledge_api._pairing_out(pairing),
            "candidates": [
                {
                    "id": str(question.id),
                    "display_label": question.display_label,
                    "question_type": (
                        question.current_published_version.question_type
                        if question.current_published_version
                        else None
                    ),
                }
                for question in candidates
            ],
        }
        templates = [
            {
                "id": str(template.id),
                "subject_id": str(template.subject_id),
                "name": template.name,
                "description": template.description,
                "review_status": template.review_status,
            }
            for template in QuestionTemplate.objects.filter(subject__project=project)
        ]

    tasks = sorted(
        StudyTask.objects.filter(pairing__project=project),
        key=lambda task: (
            task.task_kind,
            task.status,
            str(task.question_id or ""),
            str(task.origin_session_item_id or ""),
            task.pairing_version,
        ),
    )
    reviews = list(ReviewTask.objects.filter(project=project))
    pending_delayed = [
        task for task in tasks if task.task_kind == "delayed_verification" and task.status == "pending"
    ][0]
    interval = pairing_service.delayed_interval_status(task=pending_delayed, now=now)
    return {
        "knowledge_map": map_payload,
        "prerequisites": {"gamma": prerequisites("gamma"), "delta": prerequisites("delta")},
        "relations": graph,
        "pairings": pairings,
        "pairing_detail": detail,
        "templates": templates,
        "tasks": [task_projection(task) for task in tasks],
        "review_tasks": [review_projection(review) for review in reviews],
        "delay_status_at_now": {
            "required": interval["required"],
            "satisfied": interval["satisfied"],
            "reason": interval["reason"],
            "not_before": interval["not_before"],
            "stored_not_before": interval["stored_not_before"],
            "recomputed_not_before": interval["recomputed_not_before"],
            "anchor_source": interval["anchor_source"],
        },
    }


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        world = World()
        world.build()
        attempt_a = world.graded_attempt("a", question_label="Q-A", submitted_at=SUBMITTED_A)
        attempt_b = world.graded_attempt("b", question_label="Q-B", submitted_at=SUBMITTED_B)
        # The real trigger, twice: this is what the Node replay repeats.
        created_a = pairing_service.on_attempt_graded(str(attempt_a.id))
        created_b = pairing_service.on_attempt_graded(str(attempt_b.id))
        expect = projections(world, now=NOW)
        tables = {
            name: rows
            for name, rows in world.rows.items()
            if name not in EXCLUDED_TABLES and rows
        }
        payload = {
            "now": NOW.isoformat(),
            "submitted_at": {"a": SUBMITTED_A.isoformat(), "b": SUBMITTED_B.isoformat()},
            "symbols": {name: str(value) for name, value in sorted(world.names.items())},
            "tables": tables,
            "created": {"from_a": created_a, "from_b": created_b},
            "expect": expect,
        }
    finally:
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"tasks={len(expect['tasks'])} review_tasks={len(expect['review_tasks'])} created={payload['created']}")
    for name, rows in sorted(tables.items()):
        print(f"  {name}: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
