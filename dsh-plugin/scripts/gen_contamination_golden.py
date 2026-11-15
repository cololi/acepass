#!/usr/bin/env python
"""Generate golden vectors for the pure contamination port.

The oracle is Django's real `contamination.exposure_state`, evaluated against a
throw-away PostgreSQL database that this script creates, fills and destroys. The
facts it dumps are the *raw* ledger rows (no filtering applied in Python), so the
Node port has to reproduce the selection rules as well as the messages: if the
port reads a rule differently from the original, the comparison fails.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_contamination_golden.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from apps.learning.services import contamination  # noqa: E402
from apps.exams.models import ExamProject, Subject  # noqa: E402
from apps.practice.models import Attempt, ExposureEvent, PracticeSession, SessionItem  # noqa: E402
from apps.question_bank.models import (  # noqa: E402
    ContentLineage,
    Question,
    QuestionFamily,
    QuestionVersion,
)

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "contamination.json"


def at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 1, 1, hour, minute, tzinfo=timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def build() -> tuple[dict, list[dict]]:
    User = get_user_model()
    user = User.objects.create_user(email="owner@example.invalid")

    p1 = ExamProject.objects.create(owner=user, name="P1")
    p2 = ExamProject.objects.create(owner=user, name="P2")
    s1 = Subject.objects.create(project=p1, name="S1")
    s2 = Subject.objects.create(project=p2, name="S2")

    lineage = ContentLineage.objects.create(owner=user, basis="manual")

    f1 = QuestionFamily.objects.create(subject=s1, name="F1", relation_confirmed=True)
    QuestionFamily.objects.create(subject=s1, name="F2", merged_into=f1, merged_at=at(0))
    f3 = QuestionFamily.objects.create(subject=s1, name="F3")

    def question(subject, name, *, family=None, content_lineage=None):
        q = Question.objects.create(
            subject=subject,
            family=family,
            content_lineage=content_lineage,
            origin_type="provided",
            is_demo=False,
        )
        version = QuestionVersion.objects.create(
            question=q,
            version=1,
            question_type="single_choice",
            content={"stem": name},
            status="published",
            published_at=at(0),
        )
        q.current_published_version = version
        q.save(update_fields=["current_published_version"])
        return q, version

    q1, v1 = question(s1, "Q1", content_lineage=lineage)
    q2, _v2 = question(s2, "Q2", content_lineage=lineage)
    q3, v3 = question(s1, "Q3", family=f1)
    q4, _v4 = question(s1, "Q4", family=f1)
    q5, v5 = question(s1, "Q5", family=f3)
    q6, v6 = question(s1, "Q6")

    session_a = PracticeSession.objects.create(user=user, project=p1, subject=s1)
    session_b = PracticeSession.objects.create(user=user, project=p2, subject=s2)

    i1 = SessionItem.objects.create(session=session_a, ordinal=1, question_version=v1, first_delivered_at=at(17))
    i2 = SessionItem.objects.create(session=session_a, ordinal=2, question_version=v1, first_delivered_at=at(18))
    i3 = SessionItem.objects.create(session=session_a, ordinal=3, question_version=v3, first_delivered_at=at(19))
    i4 = SessionItem.objects.create(session=session_b, ordinal=1, question_version=_v2, first_delivered_at=at(20))
    # A second item on Q1 that *was* submitted: it must not count as "presented without submit".
    i5 = SessionItem.objects.create(session=session_a, ordinal=4, question_version=v1, first_delivered_at=at(21))
    Attempt.objects.create(session_item=i5, user=user, project=p1, submitted_at=at(22), elapsed_ms=1000)

    def exposure(question, *, kind, moment, project=None, version=None, session_item=None, lineage_row=None):
        return ExposureEvent.objects.create(
            user=user,
            project=project or question.subject.project,
            question=question,
            question_version=version,
            content_lineage=lineage_row,
            session_item=session_item,
            kind=kind,
            server_time=moment,
        )

    # Q1: two stems (the earlier one wins) + a hint addressed by question id only.
    exposure(q1, kind="stem_delivered", moment=at(10), version=v1)
    exposure(q1, kind="stem_delivered", moment=at(9, 30), version=v1)
    exposure(q1, kind="hint_delivered", moment=at(11))
    # A kind the strict rules ignore entirely.
    exposure(q1, kind="question_previewed", moment=at(9, 15), version=v1)

    # Q2 (same content lineage, other project): an answer plus an absolute declaration.
    exposure(q2, kind="answer_delivered", moment=at(12), lineage_row=lineage)
    exposure(q2, kind="external_seen", moment=at(12, 30), lineage_row=lineage)
    # ... and one from the *same* project as the asking project: not a lineage fact.
    exposure(q2, kind="answer_delivered", moment=at(13), project=p1, lineage_row=lineage)

    # Absolute editorial preview on Q6.
    exposure(q6, kind="editorial_preview", moment=at(14), version=v6)

    # Merged family F1: Q3 <-> Q4 contaminate each other.
    exposure(q3, kind="explanation_delivered", moment=at(15), version=v3)
    exposure(q4, kind="hint_delivered", moment=at(15, 30))

    # Q5: an exposure tied to a session item, so excluding the item must drop it.
    exposure(q5, kind="stem_delivered", moment=at(16), version=v5, session_item=i3)

    facts = {
        "questions": [
            {
                "id": str(q.id),
                "content_lineage_id": str(q.content_lineage_id) if q.content_lineage_id else None,
                "family_id": str(q.family_id) if q.family_id else None,
                "subject_project_id": str(q.subject.project_id),
            }
            for q in (q1, q2, q3, q4, q5, q6)
        ],
        "families": [],
        "exposures": [],
        "items": [],
    }
    families = {}
    for family in QuestionFamily.objects.select_related("subject"):
        families[str(family.id)] = {
            "id": str(family.id),
            "merged_into_id": str(family.merged_into_id) if family.merged_into_id else None,
            "member_ids": [],
        }
    for q in Question.objects.all():
        if q.family_id:
            families[str(q.family_id)]["member_ids"].append(str(q.id))
    facts["families"] = [families[key] for key in sorted(families)]

    for row in ExposureEvent.objects.all():
        facts["exposures"].append(
            {
                "id": str(row.id),
                "question_id": str(row.question_id) if row.question_id else None,
                "question_version_id": str(row.question_version_id) if row.question_version_id else None,
                "question_version_question_id": (
                    str(row.question_version.question_id) if row.question_version_id else None
                ),
                "content_lineage_id": str(row.content_lineage_id) if row.content_lineage_id else None,
                "project_id": str(row.project_id) if row.project_id else None,
                "session_item_id": str(row.session_item_id) if row.session_item_id else None,
                "kind": row.kind,
                "server_time": iso(row.server_time),
            }
        )
    for item in SessionItem.objects.select_related("session", "question_version").all():
        facts["items"].append(
            {
                "id": str(item.id),
                "question_id": str(item.question_version.question_id),
                "content_lineage_id": (
                    str(item.question_version.question.content_lineage_id)
                    if item.question_version.question.content_lineage_id
                    else None
                ),
                "session_project_id": str(item.session.project_id),
                "first_delivered_at": iso(item.first_delivered_at),
                "has_attempt": Attempt.objects.filter(session_item=item).exists(),
            }
        )

    queries = [
        ("all-questions-from-p1", [q1, q2, q3, q4, q5, q6], p1, None, ()),
        ("all-questions-no-project", [q1, q2, q3, q4, q5, q6], None, None, ()),
        ("window-between-15h-and-1530", [q1, q2, q3, q4, q5, q6], p1, at(15, 20), ()),
        ("window-exactly-at-editorial", [q1, q2, q3, q4, q5, q6], p1, at(14), ()),
        ("exclude-presented-item", [q5], p1, None, (i3,)),
        ("lineage-asked-from-p2", [q1], p2, None, ()),
        ("merged-family", [q3, q4], p1, None, ()),
        ("empty-question-set", [], p1, None, ()),
        ("absolute-after-window", [q2], p2, at(12, 15), ()),
        ("editorial-preview-no-project", [q6], None, None, ()),
        ("attempt-window", [q1], p1, at(17), (i1,)),
    ]

    cases = []
    for name, questions, project, before, excluded in queries:
        question_ids = [str(q.id) for q in questions]
        result = contamination.exposure_state(
            user=user,
            question_ids=question_ids,
            project=project,
            before=before,
            exclude_session_item_ids=[str(item.id) for item in excluded],
        )
        cases.append(
            {
                "name": name,
                "query": {
                    "question_ids": question_ids,
                    "project_id": str(project.id) if project is not None else None,
                    "before": iso(before),
                    "exclude_session_item_ids": [str(item.id) for item in excluded],
                },
                "expected": {question_id: result[question_id] for question_id in question_ids},
            }
        )
    return facts, cases


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        facts, cases = build()
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {
        "note": "Generated by scripts/gen_contamination_golden.py from Django's contamination rules.",
        "facts": facts,
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(cases)} cases, {len(facts['exposures'])} exposures, {len(facts['items'])} items)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
