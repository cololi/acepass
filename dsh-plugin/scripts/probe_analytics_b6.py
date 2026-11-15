#!/usr/bin/env python
"""Empirical probe for B6: the nine analytics / regrade HTTP operations.

Everything runs against a **real Django** on a throw-away PostgreSQL test
database and through the real Ninja router (``django.test.Client`` on
``/api/v1/...``): authentication, query-string parsing, the unified error
envelope, idempotency headers, and every write each operation performs.

The seed world is built from real model rows (one project, two subjects, all
five scored question types, papers for four cycle shapes, sessions for practice /
verification / an expired mock exam, and attempts covering every grading state).
No service is called to *answer* an operation: the probe's point is the HTTP
contract.

Two deliberate controls, both recorded in the JSON:

* the outbox dispatcher is **suppressed** for the run-ordering scenarios
  (``"dispatcher": "suppressed"``), because ``config.settings.test`` has
  ``ACEPASS_INLINE_TASKS=True`` and the very first regrade case proves that a
  ``POST /regrades`` otherwise executes the run inline before the response is
  even returned. Without the control a queued run cannot be observed at all.
* the expired mock exam is *not* reconciled by the probe: the first practice
  report is expected to finish it (``blocked_question_version_ids`` calls
  ``expire_due_mock_exams``), and the case records the status change.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_analytics_b6.py

Writes ``docs/dsh-migration/15-analytics-b6-probe.json`` only; the markdown
report is written from that evidence.
"""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone
from decimal import Decimal
from pathlib import Path

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

from apps.analytics.models import RegradeRun, ReportSnapshot  # noqa: E402
from apps.analytics.services.calibration import assert_no_causal_summary  # noqa: E402
from apps.audit.models import IdempotencyRecord, OutboxEvent  # noqa: E402
from apps.common.enums import EvidenceDimension, GradeEventKind, GradeMethod, GradeStatus  # noqa: E402
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

OUT_JSON = ROOT / "docs" / "dsh-migration" / "15-analytics-b6-probe.json"
TEST_DB_NAME = "test_acepass_b6_probe"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

#: Every seeded instant derives from this fixed base; nothing is "now"-relative
#: except the two rows the operations themselves write.
BASE = datetime(2026, 1, 5, 9, 0, tzinfo=dt_timezone.utc)
SEEDED_AS_OF = [BASE - timedelta(days=2), BASE - timedelta(days=1), BASE]

UNSET = object()
CASES: list[dict] = []
#: Raw (unscrubbed) response bodies by case id: the probe needs real ids to keep
#: driving the next request, while the JSON only ever stores symbols.
RAW: dict[str, dict] = {}
SYMBOLS: dict[str, str] = {}
AUTO_NAMES: dict[str, str] = {}
CLIENT = Client()
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
REF_RE = re.compile(r"REF_\d{3}")
#: Values only an operation can produce (server clock, audit timestamps) are
#: frozen to ``<now>``; every seeded timestamp is literal and deterministic.
TIME_KEYS = {
    "as_of", "created_at", "updated_at", "started_at", "finished_at", "submitted_at",
    "published_at", "checked_at", "confirmed_at", "coverage_confirmed_at", "invalidated_at",
    "computed_at", "decided_at", "first_delivered_at", "exam_deadline", "exam_started_at",
    "expired_at", "server_time", "available_at", "dispatched_at", "claimed_at",
    "lease_expires_at", "processed_at",
}


# ---------------------------------------------------------------------------
# recording helpers (same shape as probe_ingestion_b5.py)
# ---------------------------------------------------------------------------
def _auto_name(value: str) -> str:
    name = SYMBOLS.get(value)
    if name is None:
        name = f"REF_{len(SYMBOLS):03d}"
        AUTO_NAMES[name] = value
        SYMBOLS[value] = name
    return name


def reg(name: str, value) -> str:
    text = str(getattr(value, "id", value))
    SYMBOLS[text] = name
    AUTO_NAMES[name] = text
    return text


def sym(value) -> str | None:
    return None if value is None else _auto_name(str(value))


def symbolize_text(text: str) -> str:
    return UUID_RE.sub(lambda match: _auto_name(match.group(0)), text)


def scrub(value, key: str | None = None):
    if isinstance(value, datetime):
        return "<now>" if key in TIME_KEYS else value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {
            (symbolize_text(name) if isinstance(name, str) else name): scrub(item, name)
            for name, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [scrub(item, key) for item in value]
    if isinstance(value, str):
        if key in TIME_KEYS:
            return "<now>"
        return symbolize_text(value)
    return value


def remap(value):
    if isinstance(value, dict):
        return {
            (REF_RE.sub(lambda match: SYMBOLS.get(AUTO_NAMES.get(match.group(0), ""), match.group(0)), name)
             if isinstance(name, str) else name): remap(item)
            for name, item in value.items()
        }
    if isinstance(value, list):
        return [remap(item) for item in value]
    if isinstance(value, str):
        return REF_RE.sub(lambda match: SYMBOLS.get(AUTO_NAMES.get(match.group(0), ""), match.group(0)), value)
    return value


#: Lists the services emit in raw-UUID order (``sorted(set(...))`` over ids).
#: Their *order* is a server-side accident, so the probe sorts them by symbol
#: before writing: the JSON must be byte-identical on a rerun against fresh UUIDs.
SORTED_ID_KEYS = {"attempt_ids", "session_item_ids", "question_ids", "paper_ids", "blocked_paper_ids"}


def normalize(value, key: str | None = None):
    if isinstance(value, dict):
        return {name: normalize(item, name) for name, item in value.items()}
    if isinstance(value, list):
        items = [normalize(item, key) for item in value]
        if key in SORTED_ID_KEYS and items and all(isinstance(item, str) for item in items):
            return sorted(items)
        return items
    return value


def db_counts() -> dict:
    return {
        "analytics_report_snapshot": ReportSnapshot.objects.count(),
        "analytics_regrade_run": RegradeRun.objects.count(),
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "practice_attempt": Attempt.objects.count(),
        "practice_grade_event": GradeEvent.objects.count(),
        "practice_learning_evidence": LearningEvidence.objects.count(),
        "practice_session": PracticeSession.objects.count(),
        "exams_paper": Paper.objects.count(),
        "question_bank_answer_key_version": AnswerKeyVersion.objects.count(),
    }


def record(
    case_id: str,
    op: str,
    title: str,
    *,
    request: dict,
    status: int,
    payload,
    before: dict,
    after: dict,
) -> dict:
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
        raise RuntimeError(
            f"{case_id} {method.upper()} {path} -> {response.status_code}: {response.content[:800]!r}"
        ) from None
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


def fail(entry: dict, message: str) -> None:
    entry.setdefault("assertions", []).append(f"FAILED: {message}")


def expect(entry: dict, condition: bool, message: str) -> None:
    entry.setdefault("assertions", []).append(("ok: " if condition else "FAILED: ") + message)
    if not condition:
        raise SystemExit(f"assertion failed in {entry['case']}: {message}\nresponse={entry.get('response')}")


# ---------------------------------------------------------------------------
# seed helpers
# ---------------------------------------------------------------------------
def make_question(
    subject,
    label: str,
    *,
    qtype: str = "single_choice",
    max_score: str | None = "2.00",
    status: str = "published",
    answer_payload: dict | None = None,
    verification: str = "checked",
    disputed: bool = False,
    rubric: list | None = None,
    rubric_total: str | None = None,
    rubric_disputed: bool = False,
    mappings: list | None = None,
    estimated_seconds: int | None = None,
    origin: str = "user_authored",
    question=None,
    version: int = 1,
):
    question = question or Question.objects.create(subject=subject, origin_type=origin, display_label=label)
    version_row = QuestionVersion.objects.create(
        question=question,
        version=version,
        question_type=qtype,
        content={"blocks": [{"kind": "text", "text": f"B6 探针题 {label}：请作答。"}]},
        practice_max_score=Decimal(max_score) if max_score is not None and qtype != "material" else None,
        estimated_seconds=estimated_seconds,
        status=status,
        revision_reason="B6 探针",
    )
    answer = None
    rubric_row = None
    if answer_payload is not None:
        answer = AnswerKeyVersion.objects.create(
            question_version=version_row,
            version=1,
            answer_payload=answer_payload,
            source_type="user",
            verification_status=verification,
            check_basis="B6 探针人工核对",
            is_disputed=disputed,
            dispute_reason="B6 探针：答案处于争议" if disputed else "",
        )
        if rubric is not None:
            rubric_row = RubricVersion.objects.create(
                answer_key_version=answer,
                version=1,
                criteria=rubric,
                total_score=Decimal(rubric_total),
                is_disputed=rubric_disputed,
            )
    for index, mapping in enumerate(mappings or [], start=1):
        QuestionKnowledge.objects.create(
            question_version=version_row,
            mapping_revision=1,
            node=mapping["node"],
            is_primary=mapping.get("is_primary", True),
            score_weight=Decimal(mapping["weight"]),
            note=f"B6 探针映射 {index}",
        )
    return question, version_row, answer, rubric_row


def style_for(qtype: str) -> dict:
    if qtype == "multiple_choice":
        return {"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_c"]}
    if qtype == "true_false":
        return {"kind": "true_false", "correct": True}
    if qtype == "fill_blank":
        return {"kind": "fill_blank", "blanks": [{"accepted": ["42"]}]}
    if qtype == "constructed_response":
        return {"kind": "constructed_response", "rubric_required": True}
    return {"kind": "single_choice", "correct_option_id": "opt_a"}


def raw_for(qtype: str) -> dict:
    if qtype == "multiple_choice":
        return {"type": "multiple_choice", "selected_option_ids": ["opt_a", "opt_c"]}
    if qtype == "true_false":
        return {"type": "true_false", "value": True}
    if qtype == "fill_blank":
        return {"type": "fill_blank", "blanks": ["42"]}
    if qtype == "constructed_response":
        return {"type": "constructed_response", "text": "B6 探针作答过程。"}
    return {"type": "single_choice", "selected_option_ids": ["opt_a"]}


def make_session(mode: str = "practice", *, subject=None, status: str = "active", deadline=None, started=None):
    return PracticeSession.objects.create(
        user=OWNER,
        project=PROJECT,
        subject=subject or SUBJECT,
        mode=mode,
        status=status,
        exam_started_at=started,
        exam_deadline=deadline,
    )


def add_item(session, version, answer, max_score: str, ordinal: int, *, rubric=None, delivered=None):
    return SessionItem.objects.create(
        session=session,
        ordinal=ordinal,
        question_version=version,
        answer_key_version=answer,
        rubric_version=rubric,
        spec_version=SPEC,
        mapping_revision=1,
        max_score=Decimal(max_score),
        first_delivered_at=delivered,
    )


def add_attempt(item, *, submitted: datetime, elapsed_ms: int = 5000, raw=None):
    return Attempt.objects.create(
        session_item=item,
        user=OWNER,
        project=PROJECT,
        raw_answer=raw if raw is not None else raw_for(item.question_version.question_type),
        submitted_at=submitted,
        elapsed_ms=elapsed_ms,
    )


def add_grade(
    attempt,
    *,
    status: str = "confirmed",
    kind: str = "initial",
    method: str = "deterministic",
    score: str | None = None,
    pending: str = "0.00",
    fully: bool = True,
    parts: list | None = None,
    answer=None,
    rubric=None,
    revision: int = 1,
    grader_is_self: bool = False,
    invalidation_reason: str = "",
    estimated: str | None = None,
):
    item = attempt.session_item
    grade = GradeEvent.objects.create(
        attempt=attempt,
        kind=kind,
        status=status,
        method=method,
        grading_revision=revision,
        confirmed_score=None if score is None else Decimal(score),
        max_score=item.max_score,
        pending_max_score=Decimal(pending),
        estimated_score=None if estimated is None else Decimal(estimated),
        is_fully_confirmed=fully,
        parts=parts or [],
        answer_key_version=answer or item.answer_key_version,
        rubric_version=rubric if rubric is not None else item.rubric_version,
        spec_version=SPEC,
        rule_version="p0-1",
        grader_is_self=grader_is_self,
        invalidation_reason=invalidation_reason,
    )
    attempt.current_grade_event = grade
    attempt.grading_revision = revision
    attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])
    return grade


def add_evidence(attempt, dimension: str, *, qualifies: bool, reasons: list | None = None,
                 node=None, active: bool = True, revision: int = 1):
    return LearningEvidence.objects.create(
        attempt=attempt,
        session_item=attempt.session_item,
        user=OWNER,
        project=PROJECT,
        grade_event=attempt.current_grade_event,
        grade_revision=revision,
        knowledge_node=node,
        dimension=dimension,
        qualifies=qualifies,
        is_correct=qualifies,
        score_fraction=Decimal("1.0000") if qualifies else Decimal("0.0000"),
        exclusion_reasons=reasons or [],
        rule_version="p0-1",
        computed_at=BASE,
        is_active=active,
        detail={},
    )


def make_paper(cycle: str, code: str, *, source_kind: str = "official_past", is_demo: bool = False,
               revision_status: str | None = "confirmed", expected: int | None = 1,
               covered: int | None = 1, confirmed_at: datetime | None = None, session_key: str = "上半年"):
    paper = Paper.objects.create(
        subject=SUBJECT,
        cycle_key=cycle,
        session_key=session_key,
        paper_code=code,
        title=f"B6 探针卷 {cycle}{code}",
        source_kind=source_kind,
        is_demo=is_demo,
    )
    revision = None
    if revision_status is not None:
        revision = PaperRevision.objects.create(
            paper=paper,
            revision=1,
            spec_version=SPEC,
            expected_session_count=expected,
            covered_session_count=covered,
            coverage_confirmed_by=OWNER if confirmed_at is not None else None,
            coverage_confirmed_at=confirmed_at,
            status=revision_status,
            note="B6 探针",
        )
        paper.effective_revision = revision
        paper.save(update_fields=["effective_revision", "updated_at"])
    return paper, revision


def add_paper_item(revision, position: str, version, answer, max_score: str, *, is_scored: bool = True):
    return PaperItem.objects.create(
        revision=revision,
        position_key=position,
        question_version=version,
        answer_key_version=answer,
        max_score=Decimal(max_score),
        is_scored=is_scored,
        is_demo=revision.paper.is_demo,
    )


def attempt_state(attempt_id) -> dict:
    attempt = Attempt.objects.get(id=attempt_id)
    grade = attempt.current_grade_event
    return {
        "attempt": sym(attempt.id),
        "applied_regrade_generation": attempt.applied_regrade_generation,
        "grading_revision": attempt.grading_revision,
        "current_grade_event_id": sym(attempt.current_grade_event_id),
        "current_grade_kind": grade.kind if grade else None,
        "current_grade_status": grade.status if grade else None,
        "current_grade_confirmed_score": None if grade is None or grade.confirmed_score is None else str(grade.confirmed_score),
        "evidence_total": LearningEvidence.objects.filter(attempt=attempt).count(),
        "evidence_active": LearningEvidence.objects.filter(attempt=attempt, is_active=True).count(),
    }


# ---------------------------------------------------------------------------
# seed world
# ---------------------------------------------------------------------------
OWNER = None
PROJECT = None
SUBJECT = None
SUBJECT_2 = None
SPEC = None
NODE_PARENT = None
NODE_CHILD = None
NODE_AUX = None
OTHER_PROJECT = None
SESSION_EXPIRED_EXAM = None
ATTEMPT_EXAM = None
RUN_1_ID = None


def build() -> None:
    global OWNER, PROJECT, SUBJECT, SUBJECT_2, SPEC, NODE_PARENT, NODE_CHILD, NODE_AUX
    global OTHER_PROJECT, SESSION_EXPIRED_EXAM, ATTEMPT_EXAM
    User = get_user_model()
    OWNER = User.objects.create_user(
        email="b6-probe@example.invalid", password="probe-password-123", display_name="B6 探针用户"
    )
    other = User.objects.create_user(
        email="b6-other@example.invalid", password="probe-password-123", display_name="另一位用户"
    )
    PROJECT = ExamProject.objects.create(owner=OWNER, name="B6 探针项目")
    SUBJECT = Subject.objects.create(project=PROJECT, name="数学", code="MATH")
    SUBJECT_2 = Subject.objects.create(project=PROJECT, name="物理", code="PHY")
    other_project = ExamProject.objects.create(owner=other, name="B6 他人项目")
    OTHER_PROJECT = other_project
    other_subject = Subject.objects.create(project=other_project, name="化学", code="CHEM")

    syllabus = SyllabusVersion.objects.create(
        subject=SUBJECT, name="数学大纲", version_label="2026", status="published", is_user_provisional=False
    )
    NODE_PARENT = KnowledgeNode.objects.create(
        syllabus_version=syllabus, canonical_name="代数", kind="chapter", display_order=1
    )
    NODE_CHILD = KnowledgeNode.objects.create(
        syllabus_version=syllabus, canonical_name="一元二次方程", kind="point",
        parent=NODE_PARENT, display_order=2,
    )
    NODE_AUX = KnowledgeNode.objects.create(
        syllabus_version=syllabus, canonical_name="辅助标签：计算", kind="point", display_order=3
    )
    unpublished = SyllabusVersion.objects.create(
        subject=SUBJECT, name="数学大纲（草稿）", version_label="2027", status="draft", is_user_provisional=True
    )
    node_unpublished = KnowledgeNode.objects.create(
        syllabus_version=unpublished, canonical_name="草稿考点", kind="point"
    )
    syllabus_2 = SyllabusVersion.objects.create(
        subject=SUBJECT_2, name="物理大纲", version_label="2026", status="published", is_user_provisional=False
    )
    node_2 = KnowledgeNode.objects.create(syllabus_version=syllabus_2, canonical_name="力学", kind="point")

    SPEC = ExamSpecVersion.objects.create(
        subject=SUBJECT,
        version=1,
        name="B6 探针规范",
        status="published",
        published_at=BASE,
        time_rules={
            "choice_seconds": 60,
            "fill_blank_seconds": 90,
            "constructed_response_seconds": 600,
        },
        question_type_rules={
            "single_choice": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
            "multiple_choice": {"default_max_score": "3.00", "policy": "exact_match", "wrong_score": "0.00"},
            "true_false": {"default_max_score": "1.00", "wrong_score": "0.00"},
            "fill_blank": {"default_max_score": "2.00", "mismatch_policy": "review"},
            "constructed_response": {"default_max_score": "10.00"},
        },
        created_by=OWNER,
    )

    # ---- questions ----------------------------------------------------
    q_sc, v_sc, a_sc, _ = make_question(
        SUBJECT, "B6-单选-1", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[
            {"node": NODE_CHILD, "weight": "0.6000"},
            {"node": NODE_PARENT, "weight": "0.4000"},
            {"node": NODE_AUX, "weight": "0.0000", "is_primary": False},
        ],
    )
    q_mc, v_mc, a_mc, _ = make_question(
        SUBJECT, "B6-多选-1", max_score="3.00", qtype="multiple_choice", answer_payload=style_for("multiple_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_cr, v_cr, a_cr, r_cr = make_question(
        SUBJECT, "B6-大题-1", max_score="10.00", qtype="constructed_response",
        answer_payload=style_for("constructed_response"), rubric_total="10.00",
        rubric=[
            {"criterion_id": "c1", "text": "列出条件", "max_score": "3.00", "required": True},
            {"criterion_id": "c2", "text": "完成推导", "max_score": "7.00", "required": True},
        ],
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_tf, v_tf, a_tf, _ = make_question(
        SUBJECT, "B6-判断-1", max_score="1.00", qtype="true_false", answer_payload=style_for("true_false"),
        mappings=[{"node": NODE_PARENT, "weight": "1.0000"}],
    )
    q_fb, v_fb, a_fb, _ = make_question(
        SUBJECT, "B6-填空-1", max_score="2.00", qtype="fill_blank", answer_payload=style_for("fill_blank"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_cr2, v_cr2, a_cr2, r_cr2 = make_question(
        SUBJECT, "B6-大题-2", max_score="10.00", qtype="constructed_response",
        answer_payload=style_for("constructed_response"), rubric_total="10.00",
        rubric=[{"criterion_id": "c1", "text": "整体", "max_score": "10.00", "required": True}],
        mappings=[{"node": NODE_PARENT, "weight": "1.0000"}],
    )
    q_sc2, v_sc2, a_sc2, _ = make_question(
        SUBJECT, "B6-单选-2", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_disputed, v_disputed, a_disputed, _ = make_question(
        SUBJECT, "B6-争议答案", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        verification="disputed", disputed=True,
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_cr3, v_cr3, a_cr3, r_cr3 = make_question(
        SUBJECT, "B6-争议rubric", max_score="10.00", qtype="constructed_response",
        answer_payload=style_for("constructed_response"), rubric_total="10.00",
        rubric=[{"criterion_id": "c1", "text": "争议评分点", "max_score": "10.00", "required": True}],
        rubric_disputed=True,
        mappings=[{"node": NODE_PARENT, "weight": "1.0000"}],
    )
    q_gate, v_gate, a_gate, _ = make_question(
        SUBJECT, "B6-内容门禁", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_exam, v_exam, a_exam, _ = make_question(
        SUBJECT, "B6-模拟考", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_nomap, v_nomap, a_nomap, _ = make_question(
        SUBJECT, "B6-无映射", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
    )
    q_s2, v_s2, a_s2, _ = make_question(
        SUBJECT_2, "B6-物理-1", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[{"node": node_2, "weight": "1.0000"}],
    )
    q_other, v_other, a_other, _ = make_question(
        other_subject, "B6-他人-1", max_score="2.00", qtype="single_choice",
        answer_payload=style_for("single_choice"),
    )
    calibration = []
    for index in range(1, 6):
        calibration.append(
            make_question(
                SUBJECT, f"B6-校准-{index}", max_score="2.00", qtype="single_choice",
                answer_payload=style_for("single_choice"),
                mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
            )
        )
    q_pending, v_pending, a_pending, _ = make_question(
        SUBJECT, "B6-待核对答案", max_score="2.00", qtype="single_choice",
        answer_payload=style_for("single_choice"), verification="pending",
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_regrade, v_regrade, a_regrade, _ = make_question(
        SUBJECT, "B6-重判目标", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_old, v_old, a_old, _ = make_question(
        SUBJECT, "B6-代次", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_dispute_target, v_dispute_target, a_dispute_target, _ = make_question(
        SUBJECT, "B6-执行时争议", max_score="2.00", qtype="single_choice",
        answer_payload=style_for("single_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    q_multiv, v_multiv_1, a_multiv_1, _ = make_question(
        SUBJECT, "B6-多版本", max_score="2.00", qtype="single_choice", answer_payload=style_for("single_choice"),
        mappings=[{"node": NODE_CHILD, "weight": "1.0000"}],
    )
    _, v_multiv_2, a_multiv_2, _ = make_question(
        SUBJECT, "B6-多版本v2", max_score="2.00", qtype="single_choice",
        answer_payload=style_for("single_choice"), question=q_multiv, version=2,
    )

    for name, value in [
        ("OWNER", OWNER), ("OTHER_USER", other),
        ("PROJECT", PROJECT), ("SUBJECT", SUBJECT), ("SUBJECT_2", SUBJECT_2),
        ("OTHER_PROJECT", other_project), ("OTHER_SUBJECT", other_subject), ("SPEC", SPEC),
        ("SYLLABUS", syllabus), ("SYLLABUS_UNPUBLISHED", unpublished), ("SYLLABUS_2", syllabus_2),
        ("NODE_PARENT", NODE_PARENT), ("NODE_CHILD", NODE_CHILD), ("NODE_AUX", NODE_AUX),
        ("NODE_UNPUBLISHED", node_unpublished), ("NODE_2", node_2),
        ("Q_SC", q_sc), ("V_SC", v_sc), ("A_SC", a_sc),
        ("Q_MC", q_mc), ("V_MC", v_mc), ("A_MC", a_mc),
        ("Q_CR", q_cr), ("V_CR", v_cr), ("A_CR", a_cr), ("R_CR", r_cr),
        ("Q_TF", q_tf), ("V_TF", v_tf), ("A_TF", a_tf),
        ("Q_FB", q_fb), ("V_FB", v_fb), ("A_FB", a_fb),
        ("Q_CR2", q_cr2), ("V_CR2", v_cr2), ("A_CR2", a_cr2), ("R_CR2", r_cr2),
        ("Q_SC2", q_sc2), ("V_SC2", v_sc2), ("A_SC2", a_sc2),
        ("Q_DISPUTED", q_disputed), ("V_DISPUTED", v_disputed), ("A_DISPUTED", a_disputed),
        ("Q_CR3", q_cr3), ("V_CR3", v_cr3), ("A_CR3", a_cr3), ("R_CR3", r_cr3),
        ("Q_GATE", q_gate), ("V_GATE", v_gate), ("A_GATE", a_gate),
        ("Q_EXAM", q_exam), ("V_EXAM", v_exam), ("A_EXAM", a_exam),
        ("Q_NOMAP", q_nomap), ("V_NOMAP", v_nomap), ("A_NOMAP", a_nomap),
        ("Q_S2", q_s2), ("V_S2", v_s2), ("A_S2", a_s2),
        ("Q_OTHER", q_other), ("V_OTHER", v_other), ("A_OTHER", a_other),
        ("Q_PENDING", q_pending), ("V_PENDING", v_pending), ("A_PENDING", a_pending),
        ("Q_REGRADE", q_regrade), ("V_REGRADE", v_regrade), ("A_REGRADE", a_regrade),
        ("Q_OLD", q_old), ("V_OLD", v_old), ("A_OLD", a_old),
        ("Q_DISPUTE_TARGET", q_dispute_target), ("V_DISPUTE_TARGET", v_dispute_target),
        ("A_DISPUTE_TARGET", a_dispute_target),
        ("Q_MULTIV", q_multiv), ("V_MULTIV_1", v_multiv_1), ("A_MULTIV_1", a_multiv_1),
        ("V_MULTIV_2", v_multiv_2), ("A_MULTIV_2", a_multiv_2),
    ]:
        reg(name, value)
    for index, (question, version, answer, _rubric) in enumerate(calibration, start=1):
        reg(f"Q_CAL_{index}", question)
        reg(f"V_CAL_{index}", version)
        reg(f"A_CAL_{index}", answer)

    # ---- sessions, items, attempts, grades ----------------------------
    practice = make_session("practice")
    reg("SESSION_PRACTICE", practice)
    minute = 0

    def next_time() -> datetime:
        nonlocal minute
        minute += 1
        return BASE + timedelta(minutes=minute)

    item = add_item(practice, v_sc, a_sc, "2.00", 1)
    attempt_full = add_attempt(item, submitted=next_time())
    add_grade(attempt_full, score="2.00", fully=True)
    add_evidence(attempt_full, EvidenceDimension.INDEPENDENT_CORRECT, qualifies=True, node=NODE_CHILD)
    add_evidence(attempt_full, EvidenceDimension.REPEAT_PRACTICE, qualifies=True, node=NODE_CHILD)
    add_evidence(
        attempt_full, EvidenceDimension.UNASSISTED_COMPLETION, qualifies=False,
        reasons=["exposure_hint_delivered"], node=NODE_CHILD, active=False,
    )

    item = add_item(practice, v_mc, a_mc, "3.00", 2)
    attempt_pending = add_attempt(item, submitted=next_time())
    add_grade(attempt_pending, status="pending_review", score=None, pending="3.00", fully=False)

    item = add_item(practice, v_cr, a_cr, "10.00", 3, rubric=r_cr)
    attempt_partial = add_attempt(item, submitted=next_time(), raw=raw_for("constructed_response"))
    add_grade(
        attempt_partial, status="pending_review", score="3.00", pending="7.00", fully=False,
        parts=[
            {"part_id": "c1", "status": "confirmed", "score": "3.00", "max_score": "3.00"},
            {"part_id": "c2", "status": "pending_review", "score": None, "max_score": "7.00"},
        ],
    )

    item = add_item(practice, v_tf, a_tf, "1.00", 4)
    attempt_void = add_attempt(item, submitted=next_time(), raw=raw_for("true_false"))
    add_grade(attempt_void, status="void", score=None, pending="1.00", fully=False)

    item = add_item(practice, v_fb, a_fb, "2.00", 5)
    attempt_ai = add_attempt(item, submitted=next_time(), raw=raw_for("fill_blank"))
    add_grade(
        attempt_ai, status="estimated", kind="ai_estimate", method="ai_estimated",
        score=None, pending="2.00", fully=False, estimated="1.00",
        parts=[{"part_id": "p1", "status": "estimated", "score": "1.00", "max_score": "2.00"}],
    )

    item = add_item(practice, v_cr2, a_cr2, "10.00", 6, rubric=r_cr2)
    attempt_self = add_attempt(item, submitted=next_time(), raw=raw_for("constructed_response"))
    add_grade(
        attempt_self, method="self_confirmed", score="10.00", fully=True, grader_is_self=True,
        parts=[{"part_id": "c1", "status": "confirmed", "score": "10.00", "max_score": "10.00"}],
    )

    item = add_item(practice, v_sc2, a_sc2, "2.00", 7)
    attempt_invalid = add_attempt(item, submitted=next_time())
    add_grade(
        attempt_invalid, kind="invalidation", status="pending_review", method="mixed",
        score=None, pending="2.00", fully=False, invalidation_reason="答案争议后原判分失效",
    )
    add_evidence(
        attempt_invalid, EvidenceDimension.UNASSISTED_COMPLETION, qualifies=False,
        reasons=["hint_before_submit"], node=NODE_CHILD,
    )

    item = add_item(practice, v_disputed, a_disputed, "2.00", 8)
    attempt_disputed = add_attempt(item, submitted=next_time())
    add_grade(attempt_disputed, score="2.00", fully=True, answer=a_disputed)

    item = add_item(practice, v_cr3, a_cr3, "10.00", 9, rubric=r_cr3)
    attempt_disputed_rubric = add_attempt(item, submitted=next_time(), raw=raw_for("constructed_response"))
    add_grade(
        attempt_disputed_rubric, score="10.00", fully=True, rubric=r_cr3,
        parts=[{"part_id": "c1", "status": "confirmed", "score": "10.00", "max_score": "10.00"}],
    )

    for index, (_question, version, answer, _rubric) in enumerate(calibration, start=1):
        item = add_item(practice, version, answer, "2.00", 9 + index)
        attempt = add_attempt(item, submitted=next_time(), elapsed_ms=5000)
        add_grade(attempt, score="2.00", fully=True)

    item = add_item(practice, v_gate, a_gate, "2.00", 15)
    attempt_gate = add_attempt(item, submitted=next_time())
    add_grade(attempt_gate, score="2.00", fully=True)

    item = add_item(practice, v_regrade, a_regrade, "2.00", 16)
    attempt_regrade_yes = add_attempt(item, submitted=next_time())
    add_grade(attempt_regrade_yes, score="2.00", fully=True)
    item = add_item(practice, v_regrade, a_regrade, "2.00", 17)
    attempt_regrade_no = add_attempt(
        item, submitted=next_time(), raw={"type": "single_choice", "selected_option_ids": ["opt_b"]}
    )
    add_grade(attempt_regrade_no, score="0.00", fully=True)

    item = add_item(practice, v_old, a_old, "2.00", 18)
    attempt_old_1 = add_attempt(item, submitted=next_time())
    add_grade(attempt_old_1, score="2.00", fully=True)
    add_evidence(attempt_old_1, EvidenceDimension.UNASSISTED_COMPLETION, qualifies=True, node=NODE_CHILD)
    item = add_item(practice, v_old, a_old, "2.00", 19)
    attempt_old_2 = add_attempt(item, submitted=next_time())
    add_grade(attempt_old_2, score="2.00", fully=True)
    add_evidence(attempt_old_2, EvidenceDimension.UNASSISTED_COMPLETION, qualifies=True, node=NODE_CHILD)

    item = add_item(practice, v_dispute_target, a_dispute_target, "2.00", 20)
    attempt_dispute_newer = add_attempt(item, submitted=next_time())
    grade = add_grade(attempt_dispute_newer, score="2.00", fully=True)
    attempt_dispute_newer.applied_regrade_generation = 999
    attempt_dispute_newer.save(update_fields=["applied_regrade_generation", "updated_at"])
    item = add_item(practice, v_dispute_target, a_dispute_target, "2.00", 21)
    attempt_dispute_old = add_attempt(item, submitted=next_time())
    add_grade(attempt_dispute_old, score="0.00", fully=True)

    item = add_item(practice, v_multiv_1, a_multiv_1, "2.00", 22)
    attempt_multiv_1 = add_attempt(item, submitted=next_time())
    add_grade(attempt_multiv_1, score="2.00", fully=True)
    add_evidence(attempt_multiv_1, EvidenceDimension.UNASSISTED_COMPLETION, qualifies=True, node=NODE_CHILD)
    add_evidence(attempt_multiv_1, EvidenceDimension.INDEPENDENT_CORRECT, qualifies=True, node=NODE_CHILD)
    item = add_item(practice, v_multiv_2, a_multiv_2, "2.00", 23)
    attempt_multiv_2 = add_attempt(item, submitted=next_time())
    add_grade(attempt_multiv_2, score="2.00", fully=True)

    # No grade event at all: the `unscored` branch of the report.
    item = add_item(practice, v_nomap, a_nomap, "2.00", 24)
    attempt_unscored = add_attempt(item, submitted=next_time())

    practice_2 = make_session("practice", subject=SUBJECT_2)
    reg("SESSION_SUBJECT_2", practice_2)
    item = add_item(practice_2, v_s2, a_s2, "2.00", 1)
    attempt_subject_2 = add_attempt(item, submitted=next_time())
    add_grade(attempt_subject_2, score="2.00", fully=True)

    verification = make_session("verification")
    reg("SESSION_VERIFICATION", verification)
    item = add_item(verification, v_gate, a_gate, "2.00", 1, delivered=BASE)
    reg("ITEM_VERIFICATION", item)
    attempt_hidden = add_attempt(item, submitted=next_time())
    add_grade(attempt_hidden, status="pending_review", score=None, pending="2.00", fully=False)

    verification_undelivered = make_session("verification")
    reg("SESSION_VERIFICATION_UNDELIVERED", verification_undelivered)
    item = add_item(verification_undelivered, v_mc, a_mc, "3.00", 1, delivered=None)
    reg("ITEM_VERIFICATION_UNDELIVERED", item)

    exam = make_session(
        "mock_exam", status="active",
        started=BASE - timedelta(hours=2), deadline=BASE - timedelta(hours=1),
    )
    SESSION_EXPIRED_EXAM = exam
    reg("SESSION_EXPIRED_EXAM", exam)
    item = add_item(exam, v_exam, a_exam, "2.00", 1, delivered=BASE - timedelta(hours=2))
    reg("ITEM_EXPIRED_EXAM", item)
    attempt_exam = add_attempt(item, submitted=next_time())
    add_grade(attempt_exam, status="pending_review", score=None, pending="2.00", fully=False)
    ATTEMPT_EXAM = attempt_exam

    for name, value in [
        ("ATTEMPT_FULL", attempt_full), ("ATTEMPT_PENDING", attempt_pending),
        ("ATTEMPT_PARTIAL", attempt_partial), ("ATTEMPT_VOID", attempt_void),
        ("ATTEMPT_AI", attempt_ai), ("ATTEMPT_SELF", attempt_self),
        ("ATTEMPT_INVALID", attempt_invalid), ("ATTEMPT_DISPUTED", attempt_disputed),
        ("ATTEMPT_DISPUTED_RUBRIC", attempt_disputed_rubric), ("ATTEMPT_GATE", attempt_gate),
        ("ATTEMPT_REGRADE_YES", attempt_regrade_yes), ("ATTEMPT_REGRADE_NO", attempt_regrade_no),
        ("ATTEMPT_OLD_1", attempt_old_1), ("ATTEMPT_OLD_2", attempt_old_2),
        ("ATTEMPT_DISPUTE_NEWER", attempt_dispute_newer), ("ATTEMPT_DISPUTE_OLD", attempt_dispute_old),
        ("ATTEMPT_MULTIV_1", attempt_multiv_1), ("ATTEMPT_MULTIV_2", attempt_multiv_2),
        ("ATTEMPT_UNSCORED", attempt_unscored),
        ("ATTEMPT_SUBJECT_2", attempt_subject_2), ("ATTEMPT_HIDDEN", attempt_hidden),
        ("ATTEMPT_EXAM", attempt_exam),
    ]:
        reg(name, value)

    # ---- papers -------------------------------------------------------
    paper_2024, revision_2024 = make_paper(
        "2024", "卷一", expected=2, covered=2, confirmed_at=BASE - timedelta(days=400)
    )
    add_paper_item(revision_2024, "1", v_sc, a_sc, "2.00")
    add_paper_item(revision_2024, "2", v_nomap, a_nomap, "2.00")
    add_paper_item(revision_2024, "材料", v_cr, a_cr, "10.00", is_scored=False)
    paper_2023, revision_2023 = make_paper(
        "2023", "卷一", expected=1, covered=1, confirmed_at=BASE - timedelta(days=700)
    )
    add_paper_item(revision_2023, "1", v_tf, a_tf, "1.00")
    paper_demo, revision_demo = make_paper(
        "2022", "演示卷", source_kind="demo", is_demo=True, confirmed_at=BASE - timedelta(days=1000)
    )
    add_paper_item(revision_demo, "1", v_fb, a_fb, "2.00")
    paper_incomplete, revision_incomplete = make_paper(
        "2021", "卷一", expected=2, covered=1, confirmed_at=None
    )
    add_paper_item(revision_incomplete, "1", v_sc2, a_sc2, "2.00")
    paper_no_revision, _ = make_paper("2020", "卷一", revision_status=None)
    paper_2025a, revision_2025a = make_paper(
        "2025", "卷一", session_key="上半年", expected=1, covered=1, confirmed_at=BASE - timedelta(days=100)
    )
    add_paper_item(revision_2025a, "1", v_sc, a_sc, "2.00")
    paper_2025b, revision_2025b = make_paper(
        "2025", "卷二", session_key="下半年", revision_status="draft", expected=1, covered=1,
        confirmed_at=BASE - timedelta(days=90),
    )
    add_paper_item(revision_2025b, "1", v_cr2, a_cr2, "10.00")

    for name, value in [
        ("PAPER_2024", paper_2024), ("PAPER_REV_2024", revision_2024),
        ("PAPER_2023", paper_2023), ("PAPER_REV_2023", revision_2023),
        ("PAPER_DEMO", paper_demo), ("PAPER_REV_DEMO", revision_demo),
        ("PAPER_INCOMPLETE", paper_incomplete), ("PAPER_REV_INCOMPLETE", revision_incomplete),
        ("PAPER_NO_REVISION", paper_no_revision),
        ("PAPER_2025A", paper_2025a), ("PAPER_REV_2025A", revision_2025a),
        ("PAPER_2025B", paper_2025b), ("PAPER_REV_2025B", revision_2025b),
    ]:
        reg(name, value)

    # ---- seeded report snapshots (listed before any report runs) ------
    for index, as_of in enumerate(SEEDED_AS_OF, start=1):
        snapshot = ReportSnapshot.objects.create(
            user=OWNER,
            project=PROJECT,
            subject=None,
            report_kind="practice",
            calculation_version=f"seed-{index}",
            input_watermark={"attempt_count": index},
            filters={"subject_id": None},
            as_of=as_of,
            status="succeeded",
            payload={"seed": index, "as_of": as_of.isoformat()},
            notes=[f"种子快照 {index}"],
        )
        reg(f"SNAPSHOT_SEED_{index}", snapshot)

    globals().update(
        {
            "Q_REGRADE": q_regrade, "A_REGRADE": a_regrade,
            "Q_OTHER": q_other, "A_OTHER": a_other, "A_SC": a_sc,
            "Q_CR": q_cr, "A_CR": a_cr, "R_CR2": r_cr2,
            "Q_PENDING": q_pending, "A_PENDING": a_pending,
            "Q_DISPUTED": q_disputed, "A_DISPUTED": a_disputed,
            "Q_CR3": q_cr3, "A_CR3": a_cr3, "R_CR3": r_cr3,
            "Q_DISPUTE_TARGET": q_dispute_target, "A_DISPUTE_TARGET": a_dispute_target,
            "Q_MULTIV": q_multiv, "A_MULTIV_2": a_multiv_2,
            "ATTEMPT_REGRADE_YES": attempt_regrade_yes, "ATTEMPT_REGRADE_NO": attempt_regrade_no,
            "ATTEMPT_DISPUTE_NEWER": attempt_dispute_newer, "ATTEMPT_DISPUTE_OLD": attempt_dispute_old,
            "ATTEMPT_MULTIV_1": attempt_multiv_1, "ATTEMPT_MULTIV_2": attempt_multiv_2,
        }
    )

    # ---- deterministic answer-review order ----------------------------
    # `created_at` is auto_now_add; rewrite it in creation order so the
    # `-created_at` listing is byte-stable across reruns.
    for index, answer in enumerate(AnswerKeyVersion.objects.order_by("created_at", "id"), start=1):
        AnswerKeyVersion.objects.filter(id=answer.id).update(created_at=BASE + timedelta(minutes=index))
        answer.refresh_from_db()


# ---------------------------------------------------------------------------
# scenarios
# ---------------------------------------------------------------------------
def run_cases() -> None:
    base = f"/api/v1/projects/{PROJECT.id}"
    other_base = f"/api/v1/projects/{OTHER_PROJECT.id}"
    practice_url = f"{base}/reports/practice"
    calibration_url = f"{base}/reports/calibration"
    snapshots_url = f"{base}/reports/snapshots"
    cycle_url = f"{base}/papers/cycle-analysis"
    coverage_url = f"{base}/papers/coverage"
    regrades_url = f"{base}/regrades"
    answer_reviews_url = f"{base}/answer-reviews"

    # ---------------------------------------------------------- snapshots
    entry = call("S01", "snapshots", "three seeded snapshots, newest as_of first", "get", snapshots_url)
    expect(entry, entry["status"] == 200, "200")
    rows = entry["response"]
    seeded = list(ReportSnapshot.objects.filter(project=PROJECT, calculation_version__startswith="seed")
                  .order_by("-as_of"))
    expect(entry, [row["snapshot_id"] for row in rows] == [sym(s.id) for s in seeded], "ordering is -as_of")
    entry["seeded_snapshots"] = [
        {"snapshot_id": sym(row.id), "calculation_version": row.calculation_version,
         "as_of": row.as_of.isoformat(), "is_stale": row.is_stale}
        for row in seeded
    ]
    entry["projection_keys"] = sorted(rows[0].keys())
    entry["snapshot_order"] = [
        {"snapshot_id": row["snapshot_id"], "calculation_version": row["calculation_version"],
         "is_stale": row["is_stale"]}
        for row in rows
    ]

    entry = call("S02", "snapshots", "limit=1 keeps the newest row only", "get", f"{snapshots_url}?limit=1")
    expect(entry, entry["status"] == 200 and len(entry["response"]) == 1, "one row")
    call("S03", "snapshots", "limit=0 is clamped to 1 (max(1, ...))", "get", f"{snapshots_url}?limit=0")
    entry = call("S04", "snapshots", "limit=100 is clamped to 50 (all three rows)", "get", f"{snapshots_url}?limit=100")
    expect(entry, entry["status"] == 200 and len(entry["response"]) == 3, "three rows")
    call("S05", "snapshots", "limit=-3 is clamped to 1", "get", f"{snapshots_url}?limit=-3")
    entry = call("S06", "snapshots", "a non-integer limit is a 400 schema error", "get", f"{snapshots_url}?limit=abc")
    expect(entry, entry["status"] == 400 and entry["error_envelope"]["code"] == "invalid_input", "400 invalid_input")

    # ------------------------------------------------------ practice report
    session_before = PracticeSession.objects.get(id=SESSION_EXPIRED_EXAM.id)
    entry = call("R01", "practice_report", "default request writes one snapshot and reconciles the expired exam",
                 "get", practice_url)
    expect(entry, entry["status"] == 200, "200")
    expect(entry, entry["row_delta"].get("analytics_report_snapshot") == 1, "one snapshot row")
    payload_default = entry["response"]
    snapshot = (
        ReportSnapshot.objects.filter(user=OWNER, project=PROJECT, calculation_version="p0-2-c06")
        .order_by("-as_of")
        .first()
    )
    entry["snapshot_row"] = scrub({
        "report_kind": snapshot.report_kind,
        "calculation_version": snapshot.calculation_version,
        "input_watermark": snapshot.input_watermark,
        "filters": snapshot.filters,
        "as_of": snapshot.as_of,
        "status": snapshot.status,
        "payload": snapshot.payload,
        "notes": snapshot.notes,
        "is_stale": snapshot.is_stale,
        "subject_id": snapshot.subject_id,
    })
    session_after = PracticeSession.objects.get(id=SESSION_EXPIRED_EXAM.id)
    entry["expired_exam"] = {
        "session": sym(session_after.id),
        "status_before": session_before.status,
        "status_after": session_after.status,
        "exam_deadline": session_after.exam_deadline.isoformat(),
        "finished_at": session_after.finished_at.isoformat() if session_after.finished_at else None,
        "expired_at_set": session_after.expired_at is not None,
        "attempt": sym(ATTEMPT_EXAM.id),
        "attempt_in_incomplete_scope": str(ATTEMPT_EXAM.id)
        in RAW["R01"]["incomplete_scope"]["attempt_ids"],
        "attempt_code_in_payload": "pending_review" in [
            row["code"] for row in payload_default["incomplete_scope"]["reasons"]
        ],
        "pending_review_attempts": payload_default["totals"]["pending_review"]["attempts"],
        "hidden_verification_attempts": payload_default["hidden_verification_attempts"],
        "hidden_verification_content_attempts": payload_default["hidden_verification_content_attempts"],
    }
    entry["hidden_counts"] = {
        "hidden_verification_attempts": payload_default["hidden_verification_attempts"],
        "hidden_verification_content_attempts": payload_default["hidden_verification_content_attempts"],
    }

    entry = call("R02", "practice_report", "save_snapshot=false writes nothing; payload equals R01 except as_of",
                 "get", f"{practice_url}?save_snapshot=false")
    expect(entry, entry["status"] == 200, "200")
    expect(entry, entry["row_delta"].get("analytics_report_snapshot", 0) == 0, "zero snapshot writes")
    first = {k: v for k, v in payload_default.items() if k != "as_of"}
    second = {k: v for k, v in entry["response"].items() if k != "as_of"}
    entry["payload_identical_except_as_of"] = first == second
    entry["differing_keys"] = sorted(
        key for key in set(first) | set(second) if first.get(key) != second.get(key)
    )
    entry["as_of"] = {"default": payload_default["as_of"], "save_snapshot_false": entry["response"]["as_of"]}
    expect(entry, first == second, "identical payloads")

    entry = call("R03", "practice_report", "subject_id scopes the report to one subject of the same project",
                 "get", f"{practice_url}?subject_id={SUBJECT_2.id}&save_snapshot=false")
    expect(entry, entry["status"] == 200, "200")
    entry["scope"] = {
        "subject_id": entry["response"]["subject_id"],
        "attempts_in_scope": entry["response"]["incomplete_scope"]["attempts_in_scope"],
        "hidden_verification_attempts": entry["response"]["hidden_verification_attempts"],
        "hidden_verification_content_attempts": entry["response"]["hidden_verification_content_attempts"],
        "hidden_counts_are_project_wide": (
            entry["response"]["hidden_verification_attempts"]
            == payload_default["hidden_verification_attempts"]
            and entry["response"]["hidden_verification_content_attempts"]
            == payload_default["hidden_verification_content_attempts"]
        ),
        "by_question_type": sorted(entry["response"]["by_question_type"]),
        "by_knowledge_node": sorted(entry["response"]["by_knowledge_node"]),
    }
    expect(entry, entry["response"]["subject_id"] == sym(SUBJECT_2.id), "scoped subject id")
    expect(entry, entry["response"]["incomplete_scope"]["attempts_in_scope"] == 1, "one S2 attempt")
    expect(entry, entry["scope"]["hidden_counts_are_project_wide"], "hidden counts are project-wide")

    entry = call("R04", "practice_report", "incomplete scope: every reason code, null final_result, lower bound",
                 "get", f"{practice_url}?save_snapshot=false")
    scope = entry["response"]["incomplete_scope"]
    aggregate = entry["response"]["aggregate"]
    entry["evidence"] = {
        "result_status": entry["response"]["result_status"],
        "final_result": entry["response"]["final_result"],
        "aggregate_status": aggregate["status"],
        "aggregate_score_rate": aggregate["score_rate"],
        "aggregate_lower_bound": aggregate["lower_bound"],
        "unresolved_max_score": aggregate["unresolved_max_score"],
        "reason_codes": [row["code"] for row in scope["reasons"]],
        "reason_counts": {row["code"]: row["attempt_count"] for row in scope["reasons"]},
        "incomplete_attempts": scope["incomplete_attempts"],
        "attempts_in_scope": scope["attempts_in_scope"],
        "ids_truncated": scope["ids_truncated"],
        "missing_note": scope["missing_note"],
        "by_knowledge_node": entry["response"]["by_knowledge_node"],
        "excluded_evidence": entry["response"]["excluded_evidence"],
        "notes": entry["response"]["notes"],
    }
    expect(entry, entry["response"]["final_result"] is None, "final_result null")
    expect(entry, aggregate["score_rate"] is None and aggregate["lower_bound"] is not None, "null score_rate, lower bound set")
    for code in ("unscored", "pending_review", "partially_confirmed", "disputed_content",
                 "invalidated_grade", "void_grade", "ai_estimated"):
        expect(entry, code in [row["code"] for row in scope["reasons"]], f"reason code {code}")

    # ------------------------------------------------- query parsing table
    for case_id, value, expected in [
        ("P01", "0", 200), ("P02", "no", 200), ("P03", "off", 200),
        ("P04", "2", 400), ("P05", "abc", 400), ("P06", "true", 200),
    ]:
        entry = call(
            case_id, "practice_report", f"save_snapshot={value}", "get",
            f"{practice_url}?save_snapshot={value}",
        )
        entry["parsed"] = {
            "value": value,
            "expected": expected,
            "observed_status": entry["status"],
            "snapshot_writes": entry["row_delta"].get("analytics_report_snapshot", 0),
        }
        expect(entry, entry["status"] == expected, f"status {expected}")

    # ---------------------------------------------------------- calibration
    entry = call("C01", "calibration", "full calibration payload, groups withheld below 5 confirmed",
                 "get", f"{calibration_url}?subject_id={SUBJECT.id}")
    expect(entry, entry["status"] == 200, "200")
    payload = entry["response"]
    try:
        assert_no_causal_summary(payload)
        causal = {"passes": True, "error": None}
    except AssertionError as exc:  # pragma: no cover - would be the finding
        causal = {"passes": False, "error": str(exc)}
    entry["assert_no_causal_summary"] = causal
    entry["evidence"] = {
        "group_count": payload["group_count"],
        "comparable_group_count": payload["comparable_group_count"],
        "attempts_in_scope": payload["grouping"]["attempts_in_scope"],
        "hidden_verification_attempts": payload["grouping"]["hidden_verification_attempts"],
        "hidden_verification_content_attempts": payload["grouping"]["hidden_verification_content_attempts"],
        "groups": [
            {
                "group_key": row["group_key"],
                "sample_size": row["sample_size"],
                "confirmed_sample_size": row["confirmed_sample_size"],
                "status": row["status"],
                "statistics": row["statistics"],
                "exclusion_codes": [item["code"] for item in row["exclusions"]["reasons"]],
            }
            for row in payload["groups"]
        ],
        "not_comparable": payload["not_comparable"],
        "caveats": payload["caveats"],
        "exclusions": payload["exclusions"],
        "as_of": payload["as_of"],
    }
    expect(entry, causal["passes"], "assert_no_causal_summary passes")
    expect(entry, any(row["status"] == "insufficient_sample" for row in payload["groups"]), "an insufficient group")
    expect(entry, any(row["status"] == "ok" and row["statistics"] for row in payload["groups"]),
           "one group with statistics")

    entry = call("C02", "calibration", "subject_id filter narrows the same report", "get",
                 f"{calibration_url}?subject_id={SUBJECT_2.id}")
    expect(entry, entry["status"] == 200, "200")
    entry["evidence"] = {
        "subject_id": entry["response"]["subject_id"],
        "attempts_in_scope": entry["response"]["grouping"]["attempts_in_scope"],
        "groups": [
            {"group_key": row["group_key"], "status": row["status"],
             "confirmed_sample_size": row["confirmed_sample_size"], "statistics": row["statistics"]}
            for row in entry["response"]["groups"]
        ],
    }
    expect(entry, entry["response"]["grouping"]["attempts_in_scope"] == 1, "one S2 attempt in scope")

    # ------------------------------------------------------ cycle analysis
    entry = call("Y01", "cycle_analysis", "default horizon 5: two complete cycles, insufficient_cycles",
                 "get", f"{cycle_url}?subject_id={SUBJECT.id}")
    expect(entry, entry["status"] == 200, "200")
    payload = entry["response"]
    entry["evidence"] = {
        "cycle_horizon": payload["cycle_horizon"],
        "status": payload["status"],
        "complete_cycle_count": payload["complete_cycle_count"],
        "used_cycle_count": payload["used_cycle_count"],
        "missing_complete_cycles": payload["missing_complete_cycles"],
        "used_cycles": payload["used_cycles"],
        "cycles": payload["cycles"],
        "incomplete_cycles": payload["incomplete_cycles"],
        "nodes": payload["nodes"],
        "coverage_gaps": payload["coverage_gaps"],
        "notes": payload["notes"],
    }
    expect(entry, payload["used_cycles"] == ["2024", "2023"], "newest complete cycles first")
    expect(entry, payload["status"] == "insufficient_cycles", "insufficient_cycles")

    for case_id, value, expected_horizon in [
        ("Y02", "1", 1), ("Y03", "0", 5), ("Y04", "99", 10),
    ]:
        entry = call(case_id, "cycle_analysis", f"max_cycles={value}", "get",
                     f"{cycle_url}?subject_id={SUBJECT.id}&max_cycles={value}")
        entry["parsed"] = {
            "value": value,
            "cycle_horizon": entry["response"]["cycle_horizon"],
            "used_cycle_count": entry["response"]["used_cycle_count"],
            "missing_complete_cycles": entry["response"]["missing_complete_cycles"],
            "status": entry["response"]["status"],
        }
        expect(entry, entry["response"]["cycle_horizon"] == expected_horizon, f"horizon {expected_horizon}")

    entry = call("Y05", "cycle_analysis", "max_cycles=abc", "get",
                 f"{cycle_url}?subject_id={SUBJECT.id}&max_cycles=abc")
    expect(entry, entry["status"] == 400 and entry["error_envelope"]["code"] == "invalid_input", "400 invalid_input")

    entry = call("Y06", "cycle_analysis", "subject_id is required (no default)", "get", cycle_url)
    expect(entry, entry["status"] == 400, "400")
    entry["evidence"] = {"errors": entry["error_envelope"]["details"]["errors"]}

    # ----------------------------------------------------------- coverage
    entry = call("V01", "coverage", "per-paper coverage rows and the subject-level completion block",
                 "get", f"{coverage_url}?subject_id={SUBJECT.id}")
    expect(entry, entry["status"] == 200, "200")
    payload = entry["response"]
    entry["evidence"] = {
        "coverage_note": payload["coverage_note"],
        "papers": payload["papers"],
        "completion": payload["completion"],
    }
    statuses = {row["paper_code"] + "@" + row["cycle_key"]: row["coverage_status"] for row in payload["papers"]}
    entry["coverage_status_by_paper"] = statuses
    for expected in ("coverage_complete", "coverage_incomplete", "coverage_unknown"):
        expect(entry, expected in statuses.values(), f"a paper with {expected}")

    # ----------------------------------------------------- answer reviews
    entry = call("A01", "answer_reviews", "queue lists checked, pending and disputed answers", "get", answer_reviews_url)
    expect(entry, entry["status"] == 200, "200")
    rows = entry["response"]
    entry["evidence"] = {
        "count": len(rows),
        "verification_statuses": sorted({row["verification_status"] for row in rows}),
        "can_regrade_true": sum(1 for row in rows if row["can_regrade"]),
        "can_regrade_false": sum(1 for row in rows if not row["can_regrade"]),
        "disputed_rows": [
            {"answer_key_version_id": row["answer_key_version_id"],
             "display_label": row["display_label"], "can_regrade": row["can_regrade"],
             "dispute_reason": row["dispute_reason"]}
            for row in rows if row["is_disputed"]
        ],
        "rubric_rows": [
            {"display_label": row["display_label"],
             "rubric_version_id": row["rubric_version_id"]}
            for row in rows if row["rubric_version_id"]
        ],
        "order": [row["display_label"] for row in rows],
        "limit": 200,
        "seeded_over_200": False,
        "limit_note": "未构造 >200 行；服务端硬编码 [:200]，因此未实测截断（见 B6 报告）。",
        "projection_keys": sorted(rows[0].keys()) if rows else [],
    }
    expect(entry, any(row["verification_status"] == "pending" for row in rows), "a pending answer")
    expect(entry, any(row["is_disputed"] for row in rows), "a disputed answer")
    expect(entry, any(row["can_regrade"] for row in rows), "a regradable answer")

    # ----------------------------------------------------------- scoping
    for case_id, op, title, path in [
        ("X01", "practice_report", "another owner's project", f"{other_base}/reports/practice"),
        ("X02", "calibration", "another owner's project", f"{other_base}/reports/calibration"),
        ("X03", "snapshots", "another owner's project", f"{other_base}/reports/snapshots"),
        ("X04", "cycle_analysis", "another owner's project",
         f"{other_base}/papers/cycle-analysis?subject_id={SUBJECT.id}"),
        ("X05", "coverage", "another owner's project", f"{other_base}/papers/coverage?subject_id={SUBJECT.id}"),
        ("X06", "regrades", "another owner's project",
         f"{other_base}/regrades/00000000-0000-4000-8000-000000000000"),
        ("X07", "answer_reviews", "another owner's project", f"{other_base}/answer-reviews"),
    ]:
        entry = call(case_id, op, title, "get", path)
        expect(entry, entry["status"] == 404, "404")
        expect(entry, entry["error_envelope"]["message"] == "项目不存在或无权访问", "exact scope message")

    # ----------------------------------------------------------- regrades
    regrade_body = {
        "question_id": str(Q_REGRADE.id),
        "target_answer_key_version_id": str(A_REGRADE.id),
        "reason": "B6 探针：标准答案复核后重判",
    }
    entry = call("G01", "regrades", "create: 201 queued, idempotency row + outbox row", "post",
                 regrades_url, json_body=regrade_body, key="b6-regrade-1")
    expect(entry, entry["status"] == 201, "201")
    run_id = RAW["G01"]["regrade_run_id"]
    run = RegradeRun.objects.get(id=run_id)
    reg("REGRADE_1", run)
    global RUN_1_ID
    RUN_1_ID = run.id
    entry["run_row"] = {
        "regrade_run_id": sym(run.id),
        "status": run.status,
        "generation": run.generation,
        "affected_attempts": run.affected_attempts,
        "regraded_attempts": run.regraded_attempts,
        "scope": run.scope,
        "reason": run.reason,
        "requested_by": sym(run.requested_by_id),
        "status_in_201_body": entry["response"]["status"],
    }
    outbox_row = OutboxEvent.objects.filter(dedupe_key=f"regrade-run:{run.id}").first()
    entry["outbox_row"] = {
        "topic": outbox_row.topic,
        "dedupe_key": symbolize_text(outbox_row.dedupe_key),
        "payload": scrub(outbox_row.payload),
        "status": outbox_row.status,
    }
    entry["inline_dispatch"] = {
        "note": "config.settings.test 的 ACEPASS_INLINE_TASKS=True：201 返回后同一请求内 outbox 消费者已执行该 run",
        "status_after_response": run.status,
        "regraded_attempts_after_response": run.regraded_attempts,
    }
    exam_evidence = list(
        LearningEvidence.objects.filter(attempt_id=ATTEMPT_EXAM.id).order_by("dimension")
    )
    entry["evidence_for_expired_exam_attempt"] = {
        "count": len(exam_evidence),
        "dimensions": [row.dimension for row in exam_evidence],
        "note": (
            "R01 的 GET 把过期模拟考置为 finished 并入队 learning.on_session_finished；"
            "该事件在本请求的 inline dispatch 中被消费，重建了这次作答的证据行"
        ),
    }
    entry["outbox_topics_after"] = sorted(set(OutboxEvent.objects.values_list("topic", flat=True)))
    expect(entry, run.status == "succeeded", "inline execution finished the run")

    entry = call("G02", "regrades", "same key + same body replays the stored 201 body", "post",
                 regrades_url, json_body=regrade_body, key="b6-regrade-1")
    expect(entry, entry["status"] == 201, "201 replay")
    entry["replay_matches_first_body"] = RAW["G02"] == RAW["G01"]
    entry["run_count"] = RegradeRun.objects.count()
    expect(entry, RegradeRun.objects.count() == 1, "no second run row")
    expect(entry, entry["response"]["status"] == "queued", "replayed body is the stored (stale) queued snapshot")

    entry = call("G03", "regrades", "same key + different body is a 409 conflict", "post",
                 regrades_url, json_body={**regrade_body, "reason": "不同的原因"}, key="b6-regrade-1")
    expect(entry, entry["status"] == 409 and entry["error_envelope"]["code"] == "idempotency_conflict", "409")

    entry = call("G04", "regrades", "missing Idempotency-Key is a 409", "post", regrades_url, json_body=regrade_body)
    expect(entry, entry["status"] == 409, "409")
    expect(entry, entry["error_envelope"]["message"] == "缺少 Idempotency-Key 请求头", "exact message")

    entry = call("G05", "regrades", "a >200-char key is rejected", "post", regrades_url,
                 json_body={**regrade_body, "reason": "过长键"}, key="b6-" + "x" * 198)
    expect(entry, entry["status"] == 409, "409")
    expect(entry, entry["error_envelope"]["message"] == "Idempotency-Key 过长", "exact message")

    entry = call("G06", "regrades", "surrounding spaces in the key are trimmed (same key replays)", "post",
                 regrades_url, json_body={**regrade_body, "reason": "空格键"}, key="   b6-regrade-spaces   ")
    first_body = entry["response"]
    expect(entry, entry["status"] == 201, "201 first")
    replay = call("G07", "regrades", "the trimmed key replays the stored result", "post",
                  regrades_url, json_body={**regrade_body, "reason": "空格键"}, key="b6-regrade-spaces")
    replay["replay_matches_first_body"] = RAW["G07"] == RAW["G06"]
    expect(replay, replay["status"] == 201 and replay["replay_matches_first_body"], "replay with trimmed key")

    invalid_cases = [
        ("G08", "question not in the project", {
            "question_id": str(Q_OTHER.id), "target_answer_key_version_id": str(A_OTHER.id),
            "reason": "跨项目题目"}, {}, 404, "题目不存在或不属于该项目"),
        ("G09", "answer belongs to another question", {
            "question_id": str(Q_REGRADE.id), "target_answer_key_version_id": str(A_SC.id),
            "reason": "答案不属于该题"}, {}, 404, "目标答案版本不存在或不属于该题目"),
        ("G10", "rubric belongs to another answer", {
            "question_id": str(Q_CR.id), "target_answer_key_version_id": str(A_CR.id),
            "target_rubric_version_id": str(R_CR2.id), "reason": "rubric 不属于该答案"},
         {}, 404, "目标 rubric 不存在或不属于该答案版本"),
        ("G11", "blank reason", {
            "question_id": str(Q_REGRADE.id), "target_answer_key_version_id": str(A_REGRADE.id),
            "reason": "   "}, {}, 400, "重判必须说明原因"),
        ("G12", "pending answer", {
            "question_id": str(Q_PENDING.id), "target_answer_key_version_id": str(A_PENDING.id),
            "reason": "待核对答案"}, {}, 400, "重判目标必须是已核对且无争议的答案版本"),
        ("G13", "disputed answer", {
            "question_id": str(Q_DISPUTED.id), "target_answer_key_version_id": str(A_DISPUTED.id),
            "reason": "争议答案"}, {}, 400, "重判目标必须是已核对且无争议的答案版本"),
        ("G14", "disputed rubric", {
            "question_id": str(Q_CR3.id), "target_answer_key_version_id": str(A_CR3.id),
            "target_rubric_version_id": str(R_CR3.id), "reason": "争议 rubric"},
         {}, 400, "重判目标 rubric 处于争议状态"),
    ]
    for case_id, title, body, _extra, expected, message in invalid_cases:
        entry = call(case_id, "regrades", title, "post", regrades_url, json_body=body, key=f"b6-{case_id}")
        expect(entry, entry["status"] == expected, f"status {expected}")
        expect(entry, entry["error_envelope"]["message"] == message, f"message {message}")
        entry["message"] = entry["error_envelope"]["message"]

    run_id = RUN_1_ID
    entry = call("G15", "regrades", "GET regrade by id", "get", f"{regrades_url}/{run_id}")
    expect(entry, entry["status"] == 200 and entry["response"]["status"] == "succeeded", "200 succeeded")
    entry["body"] = scrub(entry["response"])

    entry = call("G16", "regrades", "GET regrade under another owner's project is a 404", "get",
                 f"{other_base}/regrades/{run_id}")
    expect(entry, entry["status"] == 404, "404")
    expect(entry, entry["error_envelope"]["message"] == "项目不存在或无权访问", "project scope message")

    entry = call("G17", "regrades", "GET an unknown regrade id is a 404", "get",
                 f"{regrades_url}/00000000-0000-4000-8000-000000000000")
    expect(entry, entry["status"] == 404, "404")
    expect(entry, entry["error_envelope"]["message"] == "重判任务不存在或不属于该项目", "regrade scope message")

    before_events = GradeEvent.objects.filter(
        attempt__session_item__question_version__question=Q_REGRADE
    ).count()
    entry = call("G18", "regrades", "run now: 200 succeeded, counters unchanged (already executed inline)",
                 "post", f"{regrades_url}/{run_id}/run", json_body={}, key="b6-run-1")
    expect(entry, entry["status"] == 200, "200")
    expect(entry, entry["response"]["regraded_attempts"] == 2, "two attempts re-graded")
    after_events = GradeEvent.objects.filter(
        attempt__session_item__question_version__question=Q_REGRADE
    ).count()
    entry["grade_events"] = {"before": before_events, "after": after_events, "delta": after_events - before_events}

    entry = call("G18R", "regrades", "run replay with the same key returns the stored body, no new write", "post",
                 f"{regrades_url}/{run_id}/run", json_body={}, key="b6-run-1")
    expect(entry, entry["status"] == 200, "200")
    entry["replay_matches_G18"] = RAW["G18R"] == RAW["G18"]
    entry["grade_events_after"] = GradeEvent.objects.filter(
        attempt__session_item__question_version__question=Q_REGRADE
    ).count()
    expect(entry, entry["replay_matches_G18"], "replayed body equals G18")

    entry = call("G19", "regrades", "a second run with a new key is already_done, no extra writes", "post",
                 f"{regrades_url}/{run_id}/run", json_body={}, key="b6-run-2")
    expect(entry, entry["status"] == 200, "200")
    entry["grade_events_after"] = GradeEvent.objects.filter(
        attempt__session_item__question_version__question=Q_REGRADE
    ).count()
    entry["same_body_as_G18"] = RAW["G19"] == RAW["G18"]

    # -------------------------------------- controlled execution (worker off)
    dispatcher = _suppress_dispatch()
    try:
        entry = call("G20", "regrades", "create a queued run with the worker suppressed", "post", regrades_url,
                     json_body={**regrade_body, "reason": "代次 A"}, key="b6-old-a")
        run_a_id = RAW["G20"]["regrade_run_id"]
        run_a = RegradeRun.objects.get(id=run_a_id)
        reg("REGRADE_A", run_a)
        entry = call("G21", "regrades", "create a newer run (higher generation), still queued", "post", regrades_url,
                     json_body={**regrade_body, "reason": "代次 B"}, key="b6-old-b")
        run_b_id = RAW["G21"]["regrade_run_id"]
        run_b = RegradeRun.objects.get(id=run_b_id)
        reg("REGRADE_B", run_b)
        expect(entry, run_b.generation > run_a.generation, "B has the newer generation")
        entry["generations"] = {"run_a": run_a.generation, "run_b": run_b.generation}
        entry["statuses_queued"] = {"run_a": run_a.status, "run_b": run_b.status}

        targets = [ATTEMPT_REGRADE_YES, ATTEMPT_REGRADE_NO]
        g20 = CASES[-2]  # the run-A creation case
        g20["generations"] = {"run_a": run_a.generation}
        g20["status_after_create"] = run_a.status
        g21 = CASES[-1]  # the run-B creation case
        g21["generation"] = run_b.generation
        g21["status_after_create"] = run_b.status
        g21["generations"] = {"run_a": run_a.generation, "run_b": run_b.generation}

        state_before = [attempt_state(a.id) for a in targets]
        grade_before = GradeEvent.objects.filter(attempt__in=targets).count()
        evidence_before = LearningEvidence.objects.filter(attempt__in=targets).count()

        outbox_before = set(OutboxEvent.objects.values_list("id", flat=True))
        entry = call("G22", "regrades", "execute the newer run B first", "post",
                     f"{regrades_url}/{run_b_id}/run", json_body={}, key="b6-old-run-b")
        entry["enqueued_outbox"] = [
            {"topic": row.topic, "payload": scrub(row.payload), "dedupe_key": symbolize_text(row.dedupe_key)}
            for row in OutboxEvent.objects.exclude(id__in=outbox_before).order_by("created_at")
        ]
        expect(entry, entry["status"] == 200 and entry["response"]["regraded_attempts"] == 2, "B regrades both")
        entry["attempts_after_b"] = [attempt_state(a.id) for a in targets]
        grade_after_b = GradeEvent.objects.filter(attempt__in=targets).count()
        entry["grade_event_rows"] = {"before": grade_before, "after_b": grade_after_b}

        entry = call("G23", "regrades", "executing the older run A writes nothing (stale generations skipped)",
                     "post", f"{regrades_url}/{run_a_id}/run", json_body={}, key="b6-old-run-a")
        expect(entry, entry["status"] == 200, "200")
        expect(entry, entry["response"]["regraded_attempts"] == 0, "zero regraded")
        expect(entry, entry["response"]["stale_skipped_attempts"] == 2, "two stale skips")
        entry["generations"] = {"run_a": run_a.generation, "run_b": run_b.generation}
        entry["attempts_before"] = state_before
        entry["attempts_after_a"] = [attempt_state(a.id) for a in targets]
        entry["grade_event_rows"] = {
            "before": grade_before,
            "after_b": grade_after_b,
            "after_a": GradeEvent.objects.filter(attempt__in=targets).count(),
        }
        entry["evidence_rows"] = {
            "before": evidence_before,
            "after_a": LearningEvidence.objects.filter(attempt__in=targets).count(),
        }
        expect(entry, entry["grade_event_rows"]["after_a"] == grade_after_b, "A wrote no grade event")
        expect(entry, entry["evidence_rows"]["after_a"] == evidence_before, "A wrote no evidence row")
        for state in entry["attempts_after_a"]:
            expect(entry, state["applied_regrade_generation"] == run_b.generation, "applied generation is B's")

        # ---- disputed target discovered at execution time
        entry = call("G24", "regrades", "create a run, then dispute its target before execution", "post",
                     regrades_url, json_body={
                         "question_id": str(Q_DISPUTE_TARGET.id),
                         "target_answer_key_version_id": str(A_DISPUTE_TARGET.id),
                         "reason": "执行前目标进入争议",
                     }, key="b6-dispute-create")
        disputed_run_id = RAW["G24"]["regrade_run_id"]
        disputed_run = RegradeRun.objects.get(id=disputed_run_id)
        reg("REGRADE_DISPUTED", disputed_run)
        AnswerKeyVersion.objects.filter(id=A_DISPUTE_TARGET.id).update(
            is_disputed=True, verification_status="disputed", dispute_reason="B6 探针：执行前争议"
        )
        newer_before = attempt_state(ATTEMPT_DISPUTE_NEWER.id)
        older_before = attempt_state(ATTEMPT_DISPUTE_OLD.id)
        entry["target"] = {"answer": sym(A_DISPUTE_TARGET.id), "is_disputed_after": True}
        entry = call("G25", "regrades", "run refuses a now-disputed target and moves attempts to review", "post",
                     f"{regrades_url}/{disputed_run_id}/run", json_body={}, key="b6-dispute-run")
        expect(entry, entry["status"] == 200, "200")
        expect(entry, entry["response"]["status"] == "failed", "status failed")
        expect(entry, entry["response"]["error_message"].startswith("重判被拒绝："), "error_message prefix")
        expect(entry, entry["response"]["regraded_attempts"] == 0, "zero regraded")
        entry["response_summary"] = {
            "status": entry["response"]["status"],
            "error_message": entry["response"]["error_message"],
            "regraded_attempts": entry["response"]["regraded_attempts"],
            "stale_skipped_attempts": entry["response"]["stale_skipped_attempts"],
            "invalidated_evidence": entry["response"]["invalidated_evidence"],
        }
        entry["attempts"] = {
            "older_generation_before": older_before,
            "older_generation_after": attempt_state(ATTEMPT_DISPUTE_OLD.id),
            "newer_generation_before": newer_before,
            "newer_generation_after": attempt_state(ATTEMPT_DISPUTE_NEWER.id),
        }
        expect(entry, entry["response"]["stale_skipped_attempts"] == 1, "newer generation attempt skipped")
        expect(entry, attempt_state(ATTEMPT_DISPUTE_OLD.id)["current_grade_status"] == "pending_review",
               "older attempt moved to pending_review")
        expect(entry, attempt_state(ATTEMPT_DISPUTE_NEWER.id) == newer_before, "newer attempt untouched")

        # ---- evidence invalidation on a content-version mismatch
        entry = call("G26", "regrades", "regrade across a question version invalidates evidence", "post",
                     regrades_url, json_body={
                         "question_id": str(Q_MULTIV.id),
                         "target_answer_key_version_id": str(A_MULTIV_2.id),
                         "reason": "v2 答案重判 v1 作答",
                     }, key="b6-multiv-create")
        multiv_run_id = RAW["G26"]["regrade_run_id"]
        reg("REGRADE_MULTIV", RegradeRun.objects.get(id=multiv_run_id))
        v1_before = {
            "evidence": [
                {"id": sym(row.id), "dimension": row.dimension, "is_active": row.is_active}
                for row in LearningEvidence.objects.filter(attempt_id=ATTEMPT_MULTIV_1.id).order_by("dimension")
            ],
            "attempt": attempt_state(ATTEMPT_MULTIV_1.id),
        }
        entry = call("G27", "regrades", "run: one attempt regraded, the other's evidence invalidated", "post",
                     f"{regrades_url}/{multiv_run_id}/run", json_body={}, key="b6-multiv-run")
        expect(entry, entry["status"] == 200, "200")
        v1_rows = list(LearningEvidence.objects.filter(attempt_id=ATTEMPT_MULTIV_1.id).order_by("dimension"))
        entry["response_summary"] = {
            "status": entry["response"]["status"],
            "regraded_attempts": entry["response"]["regraded_attempts"],
            "stale_skipped_attempts": entry["response"]["stale_skipped_attempts"],
            "invalidated_evidence": entry["response"]["invalidated_evidence"],
        }
        entry["evidence"] = {
            "before": v1_before,
            "after": [
                {"id": sym(row.id), "dimension": row.dimension, "is_active": row.is_active,
                 "invalidated_reason": row.invalidated_reason, "invalidated_at_set": row.invalidated_at is not None}
                for row in v1_rows
            ],
            "target_attempt_after": attempt_state(ATTEMPT_MULTIV_2.id),
        }
        expect(entry, entry["response"]["invalidated_evidence"] == 2, "two evidence rows invalidated")
        expect(entry, all(not row.is_active for row in v1_rows), "evidence inactive")
        expect(entry, all(row.invalidated_reason == "题干版本不同，无法用新答案重判；证据失效" for row in v1_rows),
               "reason text")
    finally:
        _restore_dispatch(dispatcher)


def _suppress_dispatch():
    """A documented test double for the Celery worker (see the module docstring)."""
    from apps.audit.services import outbox

    original = outbox.dispatch_after_commit

    def _noop(horizon_seconds: int = 0, limit: int = 500) -> int:
        return 0

    outbox.dispatch_after_commit = _noop
    return original


def _restore_dispatch(original) -> None:
    from apps.audit.services import outbox

    outbox.dispatch_after_commit = original


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        build()
        CLIENT.force_login(OWNER)
        run_cases()
    finally:
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {
        "generated_by": "dsh-plugin/scripts/probe_analytics_b6.py",
        "schema_version": 1,
        "environment": {
            "database": "postgresql (throw-away test database)",
            "django_settings": "config.settings.test",
            "routes": "real Ninja router via django.test.Client",
            "clock": "seeded timestamps derive from 2026-01-05T09:00:00Z; only operation-written "
                     "timestamps are scrubbed to <now>",
        },
        "cases": normalize(remap(CASES)),
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



if __name__ == "__main__":
    raise SystemExit(main())
