#!/usr/bin/env python
"""B10 W1/W2 oracle: freeze what Django's planner really does for the weak branch and `trigger_event`.

The migration's behaviour source of truth is `backend/apps/learning/services/planner.py`. This probe
builds one dedicated fixture inside a **throwaway PostgreSQL test database** (created here, dropped in
`finally`, never the `acepass` database), calls the *real* Django functions, and runs the Node port on
the *same* fixture rows so the two traces can be compared field by field:

* **W1** — `weakly_known_candidates` (`planner.py:256-329`): which knowledge states enter the weak
  branch, the prerequisite reordering (`prerequisite_first` / `unblocks:` / `blocked_state_*`), the
  fallback when the prerequisite has no question (`prerequisite_missing_question` + `deficit_notice`),
  the question choice (`_question_for_node`: an active `VerificationPairing` first, then the primary
  mapping) and the per-question dedupe (`scheduled_questions`).
* **W2** — `_materialise_task` (`planner.py:530-572`): a task the planner creates carries
  `trigger_event = ''` (the model default, `models.py:129`), plus the two other row fields Django
  leaves at their defaults (`estimated_minutes_source`, `deficit_notice`).

The daily budget is set to exactly the minutes this weak branch plans, so undiagnosed/general
practice never runs and the W2 task comparison stays about the tasks the weak branch materialises
(the undiagnosed category has its own, pre-existing divergence — see the informational section).

The fixture is deliberately adversarial: a weak point with an undiagnosed prerequisite, one with a
needs-review prerequisite, one with a not-independent prerequisite, one whose prerequisite has no
question, a satisfied prerequisite, two question-dedupe collisions, a 120-character `unblocks:`
truncation, a `needs_foundation` state that Django's `needs_review=True` filter must *exclude*, a node
with no question, and an auxiliary (non-primary) mapping that `_question_for_node` must ignore.

Run from `dsh-plugin/` (the Node half needs Node 24 with `--experimental-strip-types`):

    ../backend/.venv/bin/python scripts/probe_b10_planner.py
    ../backend/.venv/bin/python scripts/probe_b10_planner.py --out var/b10/parity-before.json

Exit codes: 0 all compared sections equal, 3 a difference was found, 1 the probe itself failed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
ROOT = PLUGIN.parent

sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

NOW = datetime(2027, 2, 1, 10, 0, 0, tzinfo=timezone.utc)
PLAN_DATE = date(2027, 2, 1)
#: A name of our own so the probe never clobbers a test database another task is using.
TEST_DB_NAME = "test_b10_parity_planner"

#: The 120-character cut Django applies to `f"unblocks:{name}"[:120]`.
LONG_NAME = "B10 长名" + "很" * 130


def moment(second: int) -> str:
    """A distinct, deterministic `as_of` (2027-01-01T00:00:SS+00:00)."""
    return (datetime(2027, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=second)).isoformat()


def _state(
    summary: str,
    *,
    needs_review: bool,
    as_of: int,
    evidence: list[str] | None = None,
    independent_correct_count: int = 0,
) -> dict:
    return {
        "summary": summary,
        "best_summary": summary,
        "needs_review": needs_review,
        "as_of": moment(as_of),
        "independent_correct_count": independent_correct_count,
        "evidence": evidence if evidence is not None else [f"ev-{summary}-{as_of}"],
    }


def fixture() -> dict:
    """One fixture, used verbatim by both implementations (Django builds it with the ORM)."""
    questions = [
        {"label": "B10-Q01-A", "seconds": 600},  # prerequisite question, 10 minutes
        {"label": "B10-Q02-B", "seconds": 300},
        {"label": "B10-Q03-C", "seconds": 300},  # mapped to 薄弱C but never chosen (pairing wins)
        {"label": "B10-Q04-C2", "seconds": 300},  # 薄弱C's pairing question
        {"label": "B10-Q05-D", "seconds": 300},
        {"label": "B10-Q06-F", "seconds": 300},
        {"label": "B10-Q07-G", "seconds": 300},  # primary mapping of 已满足G
        {"label": "B10-Q08-G2", "seconds": 300},  # auxiliary (weight 0) mapping, must be ignored
        {"label": "B10-Q09-I", "seconds": 300},
        {"label": "B10-Q10-K", "seconds": 300},
        {"label": "B10-Q11-L", "seconds": 90},  # 1.5 minutes -> 2
        {"label": "B10-Q12-M", "seconds": 300},
        {"label": "B10-Q13-O", "seconds": 300},
        {"label": "B10-Q14-P", "seconds": 300},
        {"label": "B10-Q15-长名", "seconds": 300},
        {"label": "B10-Q16-前置2", "seconds": 300},
        {"label": "B10-Q17-前置3", "seconds": 300},
        # W3: no state + a primary mapping -> an undiagnosed candidate on both sides.
        {"label": "B10-Q18-R", "seconds": 300},
        # W3: no state + a primary mapping, but its answer is not checked -> not a candidate.
        {"label": "B10-Q19-S", "seconds": 300, "verification": "pending"},
    ]
    nodes = [
        # No state, no primary mapping: only a pairing, so `_question_for_node` reaches its question
        # through the pairing branch and the *undiagnosed* pool (which reads primary mappings) stays
        # empty on both sides.
        {"name": "B10 基础A", "pairing": "B10-Q01-A", "state": None},
        # needs_review + undiagnosed prerequisite -> prerequisite_first, question taken from 基础A.
        {
            "name": "B10 薄弱B",
            "mappings": [{"question": "B10-Q02-B", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=10, evidence=[f"ev-B-{i:02d}" for i in range(1, 13)]),
        },
        # A pairing wins over the primary mapping.
        {
            "name": "B10 薄弱C",
            "mappings": [{"question": "B10-Q03-C", "primary": True}],
            "pairing": "B10-Q04-C2",
            "state": _state("needs_review", needs_review=True, as_of=20),
        },
        # The prerequisite exists but owns no question -> fallback + deficit_notice.
        {
            "name": "B10 薄弱D",
            "mappings": [{"question": "B10-Q05-D", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=30),
        },
        {"name": "B10 空白前置E", "state": None},
        # A satisfied prerequisite keeps the weak point itself.
        {
            "name": "B10 已满足G",
            "mappings": [
                {"question": "B10-Q08-G2", "primary": False},  # auxiliary inserted first
                {"question": "B10-Q07-G", "primary": True},
            ],
            "state": _state("needs_review", needs_review=True, as_of=40),
        },
        {"name": "B10 已掌握H", "state": _state("independent", needs_review=False, as_of=5, independent_correct_count=2)},
        # Same prerequisite question as 薄弱B -> the second state is dropped entirely.
        {
            "name": "B10 薄弱I",
            "mappings": [{"question": "B10-Q09-I", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=50),
        },
        # needs_review prerequisite -> prerequisite_needs_review; the prerequisite's own row is then
        # deduped by question id.
        {
            "name": "B10 薄弱K",
            "mappings": [{"question": "B10-Q10-K", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=60),
        },
        {
            "name": "B10 复习中L",
            "mappings": [{"question": "B10-Q11-L", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=70),
        },
        # needs_foundation prerequisite -> prerequisite_not_independent.
        {
            "name": "B10 来源O",
            "mappings": [{"question": "B10-Q13-O", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=80),
        },
        {"name": "B10 基础M", "pairing": "B10-Q12-M", "state": _state("needs_foundation", needs_review=False, as_of=6)},
        # Two unmet prerequisites: the first by name has no question, the second does.
        {
            "name": "B10 薄弱P",
            "mappings": [{"question": "B10-Q14-P", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=90),
        },
        {"name": "B10 前置1-无题", "state": None},
        {"name": "B10 前置2-有题", "pairing": "B10-Q16-前置2", "state": None},
        # needs_review=False with summary needs_foundation: Django's filter must exclude it.
        {
            "name": "B10 未固定F",
            "mappings": [{"question": "B10-Q06-F", "primary": True}],
            "state": _state("needs_foundation", needs_review=False, as_of=7),
        },
        # No question and no prerequisite: no candidate at all.
        {"name": "B10 无题Q", "state": _state("needs_review", needs_review=True, as_of=100)},
        # `unblocks:` is cut at 120 characters.
        {
            "name": LONG_NAME,
            "mappings": [{"question": "B10-Q15-长名", "primary": True}],
            "state": _state("needs_review", needs_review=True, as_of=110),
        },
        {"name": "B10 前置3-长名", "pairing": "B10-Q17-前置3", "state": None},
        # W3 positives/negatives: the first is the only undiagnosed candidate; the second is
        # excluded by `_eligible_question` (unchecked answer); existing-state nodes never appear.
        {"name": "B10 未诊断R", "mappings": [{"question": "B10-Q18-R", "primary": True}], "state": None},
        {"name": "B10 未诊断S", "mappings": [{"question": "B10-Q19-S", "primary": True}], "state": None},
    ]
    relations = [
        {"from": "B10 基础A", "to": "B10 薄弱B"},
        {"from": "B10 空白前置E", "to": "B10 薄弱D"},
        {"from": "B10 已掌握H", "to": "B10 已满足G"},
        {"from": "B10 基础A", "to": "B10 薄弱I"},
        {"from": "B10 复习中L", "to": "B10 薄弱K"},
        {"from": "B10 基础M", "to": "B10 来源O"},
        {"from": "B10 前置1-无题", "to": "B10 薄弱P"},
        {"from": "B10 前置2-有题", "to": "B10 薄弱P"},
        {"from": "B10 前置3-长名", "to": LONG_NAME},
    ]
    return {
        "now": NOW.isoformat(),
        "plan_date": PLAN_DATE.isoformat(),
        "user": {"email": "b10-parity@example.com", "display_name": "B10 探针"},
        "settings": {
            "timezone": "UTC",
            "daily_budget_minutes": 42,
            "project_budget_percent": {},
            "undiagnosed_time_share_percent": 0,
        },
        "project": "B10 计划项目",
        "subject": "B10 科目",
        "syllabus": "B10 大纲 v1",
        "questions": questions,
        "nodes": nodes,
        "relations": relations,
    }


# --------------------------------------------------------------------------
# Django side
# --------------------------------------------------------------------------
def build_django_fixture(spec: dict):
    """Create the fixture rows with the real ORM (no JSON import, no fixture files)."""
    from decimal import Decimal

    from apps.accounts.models import User, UserSettings
    from apps.exams.models import ExamProject, Subject, SyllabusVersion
    from apps.knowledge.models import (
        KnowledgeNode,
        KnowledgeRelation,
        QuestionKnowledge,
        VerificationPairing,
    )
    from apps.learning.models import LearnerKnowledgeState
    from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion

    user = User.objects.create_user(
        email=spec["user"]["email"], password="b10-probe-pass", display_name=spec["user"]["display_name"]
    )
    settings = spec["settings"]
    UserSettings.objects.create(
        user=user,
        timezone=settings["timezone"],
        daily_budget_minutes=settings["daily_budget_minutes"],
        project_budget_percent=settings["project_budget_percent"],
        undiagnosed_time_share_percent=settings["undiagnosed_time_share_percent"],
    )
    project = ExamProject.objects.create(owner=user, name=spec["project"])
    subject = Subject.objects.create(project=project, name=spec["subject"])
    syllabus = SyllabusVersion.objects.create(
        subject=subject,
        name=spec["syllabus"],
        version_label="v1",
        status="published",
        is_user_provisional=True,
        published_at=NOW,
    )

    questions: dict[str, Question] = {}
    for entry in spec["questions"]:
        question = Question.objects.create(
            subject=subject,
            origin_type="import",
            is_demo=False,
            display_label=entry["label"],
            created_by=user,
        )
        version = QuestionVersion.objects.create(
            question=question,
            version=1,
            question_type="single_choice",
            content={"blocks": [{"kind": "text", "text": entry["label"]}], "options": [{"id": "a"}, {"id": "b"}]},
            practice_max_score=Decimal("2.00"),
            estimated_seconds=entry["seconds"],
            status="published",
            published_at=NOW,
            created_by=user,
        )
        AnswerKeyVersion.objects.create(
            question_version=version,
            version=1,
            answer_payload={"kind": "single_choice", "correct_option_id": "b"},
            source_type="textbook",
            verification_status=entry.get("verification", "checked"),
            checked_by=user,
            checked_at=NOW,
            check_basis="B10 探针",
        )
        question.current_published_version = version
        question.save(update_fields=["current_published_version"])
        questions[entry["label"]] = question

    nodes: dict[str, KnowledgeNode] = {}
    for entry in spec["nodes"]:
        node = KnowledgeNode.objects.create(syllabus_version=syllabus, kind="point", canonical_name=entry["name"])
        nodes[entry["name"]] = node
        for mapping in entry.get("mappings", []):
            question = questions[mapping["question"]]
            QuestionKnowledge.objects.create(
                question_version=question.current_published_version,
                node=node,
                mapping_revision=1,
                is_primary=mapping["primary"],
                score_weight=Decimal("1.0000") if mapping["primary"] else Decimal("0.0000"),
                note="",
            )
        if entry.get("pairing"):
            VerificationPairing.objects.create(
                project=project,
                subject=subject,
                node=node,
                immediate_question=questions[entry["pairing"]],
                pairing_version=1,
                delay_hours=24,
                is_active=True,
                reviewer=user,
                reviewed_at=NOW,
            )

    for entry in spec["nodes"]:
        state = entry.get("state")
        if state is None:
            continue
        LearnerKnowledgeState.objects.create(
            user=user,
            project=project,
            syllabus_version=syllabus,
            node=nodes[entry["name"]],
            summary=state["summary"],
            best_summary=state["best_summary"],
            needs_review=state["needs_review"],
            independent_correct_count=state["independent_correct_count"],
            as_of=datetime.fromisoformat(state["as_of"]),
            source_evidence_ids=state["evidence"],
            detail={},
        )

    for relation in spec["relations"]:
        KnowledgeRelation.objects.create(
            syllabus_version=syllabus,
            from_node=nodes[relation["from"]],
            to_node=nodes[relation["to"]],
            relation_type="prerequisite",
            is_active=True,
            created_by=user,
        )
    return user, project


def _weak_row(row: dict) -> dict:
    return {
        "task_kind": row["task_kind"],
        "question_label": row["question_label"],
        "node_name": row["knowledge_node_name"],
        "estimated_minutes": row["estimated_minutes"],
        "reason_codes": list(row["reason_codes"]),
        "evidence_ids": list(row["evidence_ids"]),
        "deficit_notice": row["deficit_notice"],
    }


def _task_row(task) -> dict:
    return {
        "task_kind": task.task_kind,
        "question_label": task.question.display_label if task.question_id else "",
        "node_name": task.knowledge_node.canonical_name if task.knowledge_node_id else "",
        "estimated_minutes": task.estimated_minutes,
        "estimated_minutes_source": task.estimated_minutes_source,
        "reason_codes": list(task.reason_codes or []),
        "evidence_ids": list(task.evidence_ids or []),
        "deficit_notice": task.deficit_notice,
        "trigger_event": task.trigger_event,
    }


def _undiagnosed_row(row: dict) -> dict:
    """Label-only row: the two databases have different UUIDs by construction."""
    return {
        "task_kind": row["task_kind"],
        "question_label": row["question_label"],
        "knowledge_node_name": row["knowledge_node_name"],
        "estimated_minutes": row["estimated_minutes"],
        "reason_codes": list(row["reason_codes"]),
        "deficit_notice": row["deficit_notice"],
    }


def django_trace(user, project) -> dict:
    from apps.learning.services import planner

    candidates = planner.weakly_known_candidates(user=user, project=project, limit=50)
    # The selection order the function itself reads: filter needs_review=True, then `-needs_review, as_of`.
    states = (
        planner.LearnerKnowledgeState.objects.filter(user=user, project=project, needs_review=True)
        .select_related("node")
        .order_by("-needs_review", "as_of")
    )
    undiagnosed = planner.undiagnosed_candidates(user=user, project=project, limit=50)
    plan = planner.generate_plan(user=user, on_date=PLAN_DATE, now=NOW)
    tasks = plan.tasks.select_related("question", "knowledge_node").order_by("task_kind", "question__display_label")
    return {
        "weak_candidates": [_weak_row(row) for row in candidates],
        "undiagnosed_candidates": [_undiagnosed_row(row) for row in undiagnosed],
        "state_selection": [
            {"node_name": state.node.canonical_name, "summary": state.summary, "needs_review": state.needs_review}
            for state in states
        ],
        "plan_tasks": [_task_row(task) for task in tasks],
        "plan_allocated_minutes": plan.allocated_minutes,
    }


# --------------------------------------------------------------------------
# Node side
# --------------------------------------------------------------------------
def run_node_probe(spec: dict) -> dict:
    node = shutil.which("node")
    if node is None:
        # The harness keeps Node out of the default PATH; the pin is documented in B10-BRIEF §2.
        fallback = Path("/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin/node")
        if not fallback.exists():
            raise SystemExit("node not found: export PATH with the Node 24 installation first")
        node = str(fallback)
    script = PLUGIN / "var" / "b10" / "parity-probe-node.ts"
    completed = subprocess.run(
        [node, "--experimental-strip-types", str(script)],
        input=json.dumps(spec, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=str(PLUGIN),
        check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(f"node probe failed ({completed.returncode}):\n{completed.stderr}")
    return json.loads(completed.stdout)


# --------------------------------------------------------------------------
# Comparison
# --------------------------------------------------------------------------
def compare_lists(django_rows: list[dict], node_rows: list[dict]) -> dict:
    differences: list[dict] = []
    for index in range(max(len(django_rows), len(node_rows))):
        left = django_rows[index] if index < len(django_rows) else None
        right = node_rows[index] if index < len(node_rows) else None
        if left is None or right is None:
            differences.append({"index": index, "field": "<row>", "django": left, "node": right})
            continue
        for field in sorted(set(left) | set(right)):
            if left.get(field) != right.get(field):
                differences.append(
                    {"index": index, "field": field, "django": left.get(field), "node": right.get(field)}
                )
    return {"equal": not differences, "differences": differences}


def build_record(spec: dict, django_trace_result: dict, node_trace: dict) -> dict:
    weak_comparison = compare_lists(django_trace_result["weak_candidates"], node_trace["weak_candidates"])
    undiagnosed_comparison = compare_lists(
        django_trace_result["undiagnosed_candidates"], node_trace["undiagnosed_candidates"]
    )
    task_comparison = compare_lists(django_trace_result["plan_tasks"], node_trace["plan_tasks"])
    allocated = {
        "django": django_trace_result["plan_allocated_minutes"],
        "node": node_trace["plan_allocated_minutes"],
    }
    allocated["equal"] = allocated["django"] == allocated["node"]
    trigger_event = {
        "django": sorted({str(row["trigger_event"]) for row in django_trace_result["plan_tasks"]}),
        "node": sorted({str(row["trigger_event"]) for row in node_trace["plan_tasks"]}),
    }
    trigger_event["equal"] = trigger_event["django"] == trigger_event["node"]
    return {
        "batch": "B10",
        "probe": "b10-planner-parity",
        "generated_by": "scripts/probe_b10_planner.py (Django half) + var/b10/parity-probe-node.ts (Node half)",
        "oracle": {
            "implementation": (
                "backend/apps/learning/services/planner.py::weakly_known_candidates / _question_for_node / "
                "_materialise_task / undiagnosed_candidates; "
                "backend/apps/knowledge/services/relations.py::unmet_prerequisites"
            ),
            "database": (
                f"throwaway PostgreSQL database {TEST_DB_NAME!r} created by this script and dropped in "
                "finally; the real acepass database is never opened"
            ),
            "node": "dsh-plugin/src/services/planner.ts::weaklyKnownCandidates + generatePlan",
        },
        "fixture": spec,
        "django": django_trace_result,
        "node": node_trace,
        "comparison": {
            "weak_candidates": weak_comparison,
            "undiagnosed_candidates": undiagnosed_comparison,
            "plan_tasks": task_comparison,
            "plan_allocated_minutes": allocated,
            "trigger_event": trigger_event,
            "equal": (
                weak_comparison["equal"]
                and undiagnosed_comparison["equal"]
                and task_comparison["equal"]
                and allocated["equal"]
                and trigger_event["equal"]
            ),
            "not_compared": [
                "state_selection (Django oracle only)",
            ],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default=str(PLUGIN / "var" / "b10" / "parity-probe.json"),
        help="path of the JSON evidence file (default var/b10/parity-probe.json)",
    )
    args = parser.parse_args()

    spec = fixture()
    setup_test_environment()
    connection.settings_dict.setdefault("TEST", {})
    connection.settings_dict["TEST"]["NAME"] = TEST_DB_NAME
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        user, project = build_django_fixture(spec)
        django_trace_result = django_trace(user, project)
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)

    node_trace = run_node_probe(spec)
    record = build_record(spec, django_trace_result, node_trace)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")

    summary = {
        "out": str(out),
        "django_weak_candidates": len(django_trace_result["weak_candidates"]),
        "node_weak_candidates": len(node_trace["weak_candidates"]),
        "django_plan_tasks": len(django_trace_result["plan_tasks"]),
        "node_plan_tasks": len(node_trace["plan_tasks"]),
        "weak_candidates_equal": record["comparison"]["weak_candidates"]["equal"],
        "plan_tasks_equal": record["comparison"]["plan_tasks"]["equal"],
        "trigger_event_equal": record["comparison"]["trigger_event"]["equal"],
        "equal": record["comparison"]["equal"],
    }
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0 if record["comparison"]["equal"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
