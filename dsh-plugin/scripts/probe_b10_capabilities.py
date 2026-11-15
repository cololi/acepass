#!/usr/bin/env python
"""Empirical probe for B10 F4: answer dispute, evidence invalidation, session-finish projection.

Everything runs against the **real** Django services on a throw-away PostgreSQL test database:

  * ``question_bank.services.core.dispute_answer_key_version`` (answer -> disputed, attempts -> review,
    ``projection.rebuild_after_answer_change`` enqueued);
  * ``practice.services.attempts.handle_answer_dispute`` (the retry / already-pending branch);
  * ``learning.services.evidence.invalidate_for_answer_version`` (the task body, row counts + fields);
  * ``learning.services.state.refresh_session_states`` (the ``learning.on_session_finished`` body);
  * ``practice.services.sessions.finish_session`` / ``expire_session_if_due`` /
    ``_finish_locked`` (finished state, ``revealed_at``, origin task, one outbox event).

Django exposes **no HTTP route** for the dispute: ``grep -rn dispute_answer_key_version`` hits only the
service and integration tests. The probe therefore calls the services directly (the same objects the
Node port must match), and uses the real HTTP API only to build realistic sessions/attempts.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_b10_capabilities.py

Writes ``var/b10/f4-probe.json`` and ``var/b10/f4-probe.md``. Re-running against the same code
produces byte-identical output (UUIDs are aliased, instants are scrubbed, the clock is pinned for the
dispute cases).
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import Client  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.audit.models import ContentRevision, OutboxEvent  # noqa: E402
from apps.common.content import content_digest  # noqa: E402
from apps.exams.models import ExamProject, ExamSpecVersion, Subject, SyllabusVersion  # noqa: E402
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge  # noqa: E402
from apps.learning.models import StudyTask  # noqa: E402
from apps.learning.services import evidence as evidence_service  # noqa: E402
from apps.learning.services import state as state_service  # noqa: E402
from apps.practice.models import Attempt, GradeEvent, LearningEvidence, PracticeSession, SessionItem  # noqa: E402
from apps.practice.services import attempts as attempt_services  # noqa: E402
from apps.practice.services import sessions as session_services  # noqa: E402
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion  # noqa: E402
from apps.question_bank.services import core as content_services  # noqa: E402

OUT_DIR = PLUGIN / "var" / "b10"
OUT_JSON = OUT_DIR / "f4-probe.json"
OUT_MD = OUT_DIR / "f4-probe.md"
GOLDEN = PLUGIN / "tests" / "golden" / "b10_capabilities.json"
TEST_DB_NAME = "test_acepass_b10_capabilities"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

CASES: list[dict] = []
SYMBOLS: dict[str, str] = {}
CLIENT = Client()
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)")
EPOCH_RE = re.compile(r"^(answer-change:[0-9a-f-]{36}):\d+$")

#: The pinned clock for the dispute cases: the dedupe key embeds whole seconds, so a frozen clock is
#: what makes "same second dedupes, next second does not" reproducible.
PINNED = datetime(2026, 11, 1, 9, 0, 0, tzinfo=UTC)


def _auto_name(value: str) -> str:
    name = SYMBOLS.get(value)
    if name is None:
        name = f"REF_{len(SYMBOLS):03d}"
        SYMBOLS[value] = name
    return name


def reg(name: str, value) -> str:
    text = str(getattr(value, "id", value))
    SYMBOLS[text] = name
    return text


def scrub(value, key: str | None = None):
    """Alias identifiers, scrub instants and epoch suffixes, stringify decimals."""
    if isinstance(value, dict):
        return {name: scrub(item, name) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(item, key) for item in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        matched = EPOCH_RE.match(value)
        if matched:
            prefix, identifier = matched.group(1).split(":", 1)
            return f"{prefix}:{_auto_name(identifier)}:<epoch-seconds>"
        if UUID_RE.fullmatch(value):
            return _auto_name(value)
        return TIME_RE.sub("<time>", UUID_RE.sub(lambda m: _auto_name(m.group(0)), value))
    return value


def case(case_id: str, title: str, *, function: str, call: dict, result: dict, rows: dict | None = None, notes=None):
    CASES.append(
        {
            "id": case_id,
            "title": title,
            "function": function,
            "call": scrub(call),
            "result": scrub(result),
            "rows": scrub(rows or {}),
            "notes": notes,
        }
    )


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

SESSION_SEQ = 0
ATTEMPT_SEQ = 0


def make_question(subject, owner, label: str, node: KnowledgeNode, *, max_score: str = "2.00"):
    content = {
        "blocks": [{"kind": "text", "text": f"题目 {label}：1+1 等于几？"}],
        "options": [
            {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "1"}]},
            {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "2"}]},
        ],
    }
    question = Question.objects.create(subject=subject, origin_type="user_authored", display_label=label)
    version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type="single_choice",
        content=content,
        status="draft",
        content_digest=content_digest(content),
        practice_max_score=Decimal(max_score),
        revision_reason="probe",
        source_note="",
    )
    answer = AnswerKeyVersion.objects.create(
        question_version=version,
        version=1,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_b"},
        source_type="user_authored",
        verification_status="checked",
        checked_by=owner,
        checked_at=timezone.now(),
        check_basis="探针依据",
        explanation_blocks=[{"kind": "text", "text": "因为 1+1=2。"}],
        is_disputed=False,
    )
    QuestionKnowledge.objects.create(
        question_version=version,
        mapping_revision=1,
        node=node,
        is_primary=True,
        score_weight=Decimal("1.0000"),
        note="",
    )
    version.status = "published"
    version.published_at = timezone.now()
    version.save(update_fields=["status", "published_at"])
    question.current_published_version = version
    question.save(update_fields=["current_published_version"])
    return question, version, answer


def post(path: str, body: dict, key: str) -> dict:
    response = CLIENT.post(path, data=json.dumps(body, ensure_ascii=False), content_type="application/json",
                           HTTP_IDEMPOTENCY_KEY=key)
    payload = json.loads(response.content.decode("utf-8")) if response.content else None
    assert response.status_code in (200, 201), (path, response.status_code, payload)
    return payload


def build_session(project_id: str, subject_id: str, question_ids: list[str], mode: str = "practice", **extra) -> tuple[str, list[str]]:
    global SESSION_SEQ
    SESSION_SEQ += 1
    body = {"mode": mode, "subject_id": subject_id, "question_ids": question_ids, **extra}
    created = post(f"/api/v1/projects/{project_id}/practice-sessions", body, f"probe-session-{SESSION_SEQ}")
    session_id = str(created["session_id"])
    items = [str(item["session_item_id"]) for item in created["items"]]
    return session_id, items


def submit(item_id: str, project_id: str, correct: bool = True, *, delay_seconds: int = 60) -> str:
    """Present, wait (in the past), submit. Returns the attempt id."""
    global ATTEMPT_SEQ
    ATTEMPT_SEQ += 1
    CLIENT.get(f"/api/v1/projects/{project_id}/session-items/{item_id}/presentation")
    choice = "opt_b" if correct else "opt_a"
    submitted = post(
        f"/api/v1/projects/{project_id}/session-items/{item_id}/submit",
        {"answer": {"type": "single_choice", "selected_option_ids": [choice]}},
        f"probe-submit-{ATTEMPT_SEQ}",
    )
    attempt = Attempt.objects.get(id=submitted["attempt_id"])
    # The evidence rule refuses a "trusted timing" dimension when `elapsed_ms == 0`
    # (`缺少可信用时记录`), so the probe gives every attempt a real duration before re-projecting.
    SessionItem.objects.filter(id=item_id).update(first_delivered_at=attempt.submitted_at - timedelta(seconds=delay_seconds))
    Attempt.objects.filter(id=attempt.id).update(elapsed_ms=delay_seconds * 1000)
    evidence_service.rebuild_for_attempt(str(attempt.id))
    state_service.refresh_states_for_attempt(str(attempt.id))
    return str(attempt.id)


def drain_outbox() -> None:
    """Run the in-process consumers (test settings) so later measurements start from a clean queue."""
    from apps.audit.services import outbox

    outbox.dispatch_after_commit(horizon_seconds=3600)


def attempt_rows(attempt_id: str) -> dict:
    attempt = Attempt.objects.get(id=attempt_id)
    events = list(GradeEvent.objects.filter(attempt_id=attempt_id).order_by("grading_revision"))
    return {
        "attempt": {
            "raw_answer": attempt.raw_answer,
            "grading_revision": attempt.grading_revision,
            "current_grade_event_id": str(attempt.current_grade_event_id),
        },
        "grade_events": [
            {
                "id": str(event.id),
                "kind": event.kind,
                "status": event.status,
                "method": event.method,
                "grading_revision": event.grading_revision,
                "confirmed_score": event.confirmed_score,
                "max_score": event.max_score,
                "pending_max_score": event.pending_max_score,
                "is_fully_confirmed": event.is_fully_confirmed,
                "is_superseded": event.is_superseded,
                "supersedes_id": None if event.supersedes_id is None else str(event.supersedes_id),
                "answer_key_version_id": None if event.answer_key_version_id is None else str(event.answer_key_version_id),
                "rubric_version_id": None if event.rubric_version_id is None else str(event.rubric_version_id),
                "spec_version_id": None if event.spec_version_id is None else str(event.spec_version_id),
                "rule_version": event.rule_version,
                "rule_snapshot": event.rule_snapshot,
                "grader_id": None if event.grader_id is None else str(event.grader_id),
                "grader_is_self": event.grader_is_self,
                "comment": event.comment,
                "invalidation_reason": event.invalidation_reason,
                "parts": event.parts,
            }
            for event in events
        ],
    }


def outbox_rows(topic: str, session_id: str | None = None) -> list[dict]:
    events = list(OutboxEvent.objects.filter(topic=topic).order_by("created_at"))
    if session_id is not None:
        events = [event for event in events if str(event.payload.get("session_id")) == str(session_id)]
    return [
        {
            "topic": event.topic,
            "payload": event.payload,
            "dedupe_key": event.dedupe_key,
            "status": event.status,
            "processed_at": None if event.processed_at is None else event.processed_at.isoformat(),
        }
        for event in events
    ]


def evidence_rows(attempt_id: str) -> list[dict]:
    return [
        {
            "dimension": row.dimension,
            "is_active": row.is_active,
            "invalidated_reason": row.invalidated_reason,
            "invalidated_at_set": row.invalidated_at is not None,
            "qualifies": row.qualifies,
            "grade_revision": row.grade_revision,
        }
        for row in LearningEvidence.objects.filter(attempt_id=attempt_id).order_by("dimension")
    ]


def build() -> None:
    User = get_user_model()
    owner = User.objects.create_user(email="b10@example.invalid", password="probe-password-123", display_name="探针用户")
    project = ExamProject.objects.create(owner=owner, name="B10 能力探针")
    subject = Subject.objects.create(project=project, name="数学", code="MATH")
    spec = ExamSpecVersion.objects.create(
        subject=subject,
        version=1,
        name="探针规范",
        total_score=Decimal("100.00"),
        pass_score=Decimal("60.00"),
        question_type_rules={"single_choice": {"default_max_score": "2.00", "wrong_score": "0.00"}},
        time_rules={},
        status="published",
        published_at=timezone.now(),
        created_by=owner,
    )
    syllabus = SyllabusVersion.objects.create(
        subject=subject,
        name="探针大纲",
        version_label="2026",
        status="published",
        published_at=timezone.now(),
        created_by=owner,
    )
    node = KnowledgeNode.objects.create(
        syllabus_version=syllabus, kind="point", canonical_name="考点一", display_order=0
    )
    reg("OWNER", owner)
    reg("PROJECT", project)
    reg("SUBJECT", subject)
    reg("SPEC", spec)
    reg("SYLLABUS", syllabus)
    reg("NODE", node)

    CLIENT.force_login(owner)
    base = f"/api/v1/projects/{project.id}"

    # ---------------------------------------------------------------- 1. evidence invalidation
    q1, v1, a1 = make_question(subject, owner, "失效-1", node)
    reg("ANSWER_INVALIDATE", a1)
    s1, items1 = build_session(str(project.id), str(subject.id), [str(q1.id)])
    reg("SESSION_INVALIDATE", s1)
    attempt_inv = submit(items1[0], str(project.id))

    before = evidence_rows(attempt_inv)
    invalidated = evidence_service.invalidate_for_answer_version(str(a1.id))
    after = evidence_rows(attempt_inv)
    case(
        "B10-01",
        "invalidate_for_answer_version deactivates the evidence of the disputed answer version",
        function="apps.learning.services.evidence.invalidate_for_answer_version",
        call={"answer_key_version_id": str(a1.id)},
        result={
            "returned": invalidated,
            "active_before": sum(1 for row in before if row["is_active"]),
            "rows_before": len(before),
            "rows_after": len(after),
            "active_after": sum(1 for row in after if row["is_active"]),
            "second_call_returned": evidence_service.invalidate_for_answer_version(str(a1.id)),
        },
        rows={"evidence_before": before, "evidence_after": after},
    )

    # ---------------------------------------------------------------- 2. handle_answer_dispute
    q2, v2, a2 = make_question(subject, owner, "争议-2", node)
    reg("ANSWER_DISPUTE", a2)
    s2a, items2a = build_session(str(project.id), str(subject.id), [str(q2.id)])
    s2b, items2b = build_session(str(project.id), str(subject.id), [str(q2.id)])
    reg("SESSION_DISPUTE_A", s2a)
    reg("SESSION_DISPUTE_B", s2b)
    attempt_a = submit(items2a[0], str(project.id), True)
    attempt_b = submit(items2b[0], str(project.id), False)
    drain_outbox()

    before_a = attempt_rows(attempt_a)
    before_b = attempt_rows(attempt_b)
    affected = attempt_services.handle_answer_dispute(a2, actor=owner, reason="答案与来源不一致，需重新核对")
    case(
        "B10-02",
        "handle_answer_dispute creates one invalidation grade event per graded attempt",
        function="apps.practice.services.attempts.handle_answer_dispute",
        call={"answer_key_version_id": str(a2.id), "actor": "OWNER", "reason": "答案与来源不一致，需重新核对"},
        result={
            "affected": affected,
            "grade_events_before_a": len(before_a["grade_events"]),
            "grade_events_after_a": len(attempt_rows(attempt_a)["grade_events"]),
        },
        rows={"attempt_confirmed_after": attempt_rows(attempt_a), "attempt_wrong_after": attempt_rows(attempt_b)},
        notes="The attempts are graded differently (one correct, one wrong) so the copied score fields differ.",
    )

    # already-pending branch: a second dispute counts but writes nothing
    events_before = GradeEvent.objects.filter(attempt_id=attempt_a).count()
    affected_again = attempt_services.handle_answer_dispute(a2, actor=owner, reason="同一答案版本被再次质疑")
    case(
        "B10-03",
        "handle_answer_dispute counts an already-pending attempt without creating another event",
        function="apps.practice.services.attempts.handle_answer_dispute",
        call={"answer_key_version_id": str(a2.id), "actor": "OWNER", "reason": "同一答案版本被再次质疑"},
        result={
            "affected": affected_again,
            "grade_events_before": events_before,
            "grade_events_after": GradeEvent.objects.filter(attempt_id=attempt_a).count(),
        },
        notes="Django increments `affected` for a `pending_review` current event and continues.",
    )

    # ---------------------------------------------------------------- 3. dispute_answer_key_version
    q3, v3, a3 = make_question(subject, owner, "争议-3", node)
    reg("ANSWER_WRAPPER", a3)
    s3, items3 = build_session(str(project.id), str(subject.id), [str(q3.id)])
    reg("SESSION_WRAPPER", s3)
    attempt_c = submit(items3[0], str(project.id), True)
    drain_outbox()
    reg("ATTEMPT_WRAPPER", attempt_c)
    long_reason = "答案版本与官方来源不一致：" + "需人工复核。" * 100  # >500 chars on purpose
    with mock.patch("django.utils.timezone.now", return_value=PINNED):
        content_services.dispute_answer_key_version(a3, actor=owner, reason=long_reason)
    a3.refresh_from_db()
    revision = ContentRevision.objects.filter(entity_type="answer_key_version", entity_id=str(a3.id), action="dispute").first()
    case(
        "B10-04",
        "dispute_answer_key_version marks the answer, audits the action and enqueues the projection event",
        function="apps.question_bank.services.core.dispute_answer_key_version",
        call={"answer_key_version_id": str(a3.id), "actor": "OWNER", "reason_length": len(long_reason)},
        result={
            "verification_status": a3.verification_status,
            "is_disputed": a3.is_disputed,
            "dispute_reason_length": len(a3.dispute_reason),
            "dispute_reason_is_prefix_of_reason": long_reason.startswith(a3.dispute_reason),
            "content_revision": {
                "action": revision.action,
                "entity_type": revision.entity_type,
                "project_id": str(revision.project_id),
                "reason_length": len(revision.reason),
                "actor_id": str(revision.actor_id),
            },
            "outbox_events": outbox_rows("projection.rebuild_after_answer_change"),
            # The full event shape is pinned in B10-02; here only the truncation-sensitive fields.
            "attempt": {
                "grading_revision": attempt_rows(attempt_c)["attempt"]["grading_revision"],
                "current_grade_event": {
                    key: value
                    for key, value in attempt_rows(attempt_c)["grade_events"][-1].items()
                    if key in ("kind", "status", "grading_revision", "is_superseded", "supersedes_id")
                }
                | {"comment_length": len(attempt_rows(attempt_c)["grade_events"][-1]["comment"]),
                   "invalidation_reason_length": len(attempt_rows(attempt_c)["grade_events"][-1]["invalidation_reason"])},
            },
        },
        notes="reason[:500] on both the answer row and the audit row; the grade comment is reason[:400].",
    )

    # same second -> the dedupe key repeats, so no second event
    with mock.patch("django.utils.timezone.now", return_value=PINNED + timedelta(milliseconds=500)):
        content_services.dispute_answer_key_version(a3, actor=owner, reason="同一秒再次质疑")
    same_second = outbox_rows("projection.rebuild_after_answer_change")
    # next second -> a new key, hence a new event
    with mock.patch("django.utils.timezone.now", return_value=PINNED + timedelta(seconds=1)):
        content_services.dispute_answer_key_version(a3, actor=owner, reason="下一秒再次质疑")
    next_second = outbox_rows("projection.rebuild_after_answer_change")
    case(
        "B10-05",
        "the dispute dedupe key is second-granular: same second collapses, next second adds an event",
        function="apps.audit.services.outbox.enqueue (called by dispute_answer_key_version)",
        call={"answer_key_version_id": str(a3.id), "seconds": [0.0, 0.5, 1.0]},
        result={
            "events_after_first": 1,
            "events_after_same_second": len(same_second),
            "events_after_next_second": len(next_second),
            "dedupe_keys": [row["dedupe_key"] for row in next_second],
            "affected_attempts": [row["payload"]["affected_attempts"] for row in next_second],
        },
    )

    # ---------------------------------------------------------------- 4. refresh_session_states
    # A second node keeps the projection assertion about *this* session: a shared node would also
    # count the earlier attempts of this probe.
    node_b = KnowledgeNode.objects.create(
        syllabus_version=syllabus, kind="point", canonical_name="考点二", display_order=1
    )
    reg("NODE_FINISH", node_b)
    qs = [make_question(subject, owner, f"会话-{index}", node_b) for index in range(3)]
    task = StudyTask.objects.create(
        user=owner,
        project=project,
        subject=subject,
        task_kind="paired_immediate",
        status="pending",
        question=None,
        knowledge_node=node_b,
    )
    reg("TASK", task)
    session_id, item_ids = build_session(
        str(project.id), str(subject.id), [str(q.id) for q, _v, _a in qs], mode="practice", task_id=str(task.id)
    )
    reg("SESSION_FINISH", session_id)
    session = PracticeSession.objects.get(id=session_id)
    attempts = [submit(item_id, str(project.id)) for item_id in item_ids]
    for index, attempt_id in enumerate(attempts):
        reg(f"ATTEMPT_FINISH_{index}", attempt_id)

    finished_at = session.created_at + timedelta(minutes=30)
    finished = session_services.finish_session(session=session, user=owner, now=finished_at)
    session.refresh_from_db()
    task.refresh_from_db()
    finish_events = outbox_rows("learning.on_session_finished", session_id=session_id)
    case(
        "B10-06",
        "finish_session ends a verification at the submit moment, reveals grading, completes the task, enqueues once",
        function="apps.practice.services.sessions.finish_session / _finish_locked",
        call={"session_id": session_id, "now": "<finished_at>"},
        result={
            "mode": session.mode,
            "status": session.status,
            "finished_at": session.finished_at.isoformat(),
            "revealed_at": session.revealed_at.isoformat(),
            "expired_at": None if session.expired_at is None else session.expired_at.isoformat(),
            "revealed_equals_finished": session.revealed_at == session.finished_at,
            "finished_at_is_the_requested_moment": session.finished_at == finished_at,
            "origin_task_id": None if session.origin_task_id is None else str(session.origin_task_id),
            "task_status": task.status,
            "task_completed_at": None if task.completed_at is None else task.completed_at.isoformat(),
            "task_completed_at_equals_finished": task.completed_at == session.finished_at,
            "outbox_events": finish_events,
            "attempt_count": Attempt.objects.filter(session_item__session_id=session_id).count(),
        },
        notes="The session was created from a task with `question_id=None`, so the explicit 3-question list survives.",
    )

    refreshed = state_service.refresh_session_states(session_id)
    from apps.learning.models import LearnerKnowledgeState

    # Only the node this session's questions map to: the other node belongs to the earlier cases.
    states = list(
        LearnerKnowledgeState.objects.filter(user=owner, project=project, node=node_b).order_by(
            "node__canonical_name"
        )
    )
    case(
        "B10-07",
        "refresh_session_states rebuilds every attempt of the session and refreshes its nodes",
        function="apps.learning.services.state.refresh_session_states",
        call={"session_id": session_id},
        result={
            "returned": refreshed,
            "attempts_in_session": len(attempts),
            "evidence_rows_per_attempt": [len(evidence_rows(attempt_id)) for attempt_id in attempts],
            "active_evidence_per_attempt": [
                sum(1 for row in evidence_rows(attempt_id) if row["is_active"]) for attempt_id in attempts
            ],
            "state_rows": [
                {
                    "node_id": str(state.node_id),
                    "summary": state.summary,
                    "best_summary": state.best_summary,
                    "independent_correct_count": state.independent_correct_count,
                    "distinct_question_count": state.distinct_question_count,
                    "distinct_template_count": state.distinct_template_count,
                    "has_delayed_correct": state.has_delayed_correct,
                    "needs_review": state.needs_review,
                    "rule_version": state.rule_version,
                    "as_of": state.as_of.isoformat(),
                }
                for state in states
            ],
        },
    )

    # a repeated finish is a no-op and enqueues nothing
    before_events = len(outbox_rows("learning.on_session_finished", session_id=session_id))
    session_services.finish_session(session=PracticeSession.objects.get(id=session_id), user=owner, now=finished_at + timedelta(hours=1))
    session.refresh_from_db()
    case(
        "B10-08",
        "a repeated finish keeps the first end and writes no second event",
        function="apps.practice.services.sessions.finish_session",
        call={"session_id": session_id, "now": "<finished_at + 1h>"},
        result={
            "status": session.status,
            "finished_at_unchanged": session.finished_at == finished_at,
            "events_before": before_events,
            "events_after": len(outbox_rows("learning.on_session_finished", session_id=session_id)),
            "task_status": StudyTask.objects.get(id=task.id).status,
        },
    )

    # ---------------------------------------------------------------- 5. mock-exam expiry
    q5, v5, _a5 = make_question(subject, owner, "考试-1", node)
    exam_id, exam_items = build_session(
        str(project.id), str(subject.id), [str(q5.id)], mode="mock_exam", duration_minutes=30
    )
    reg("SESSION_EXAM", exam_id)
    submit(exam_items[0], str(project.id), True, delay_seconds=30)
    exam = PracticeSession.objects.get(id=exam_id)
    deadline = exam.exam_deadline
    early = session_services.expire_session_if_due(exam, now=deadline - timedelta(seconds=1))
    # `_finish_locked` mutates the row it locked; `expire_session_if_due` returns the same object it
    # was handed, so the pre-deadline verdict has to be read out before the next call.
    early_status = early.status
    noticed_at = deadline + timedelta(minutes=5)
    expired = session_services.expire_session_if_due(exam, now=noticed_at)
    exam.refresh_from_db()
    expired_events = outbox_rows("learning.on_session_finished", session_id=exam_id)
    case(
        "B10-09",
        "expire_session_if_due ends the exam at the stored deadline and records when it was noticed",
        function="apps.practice.services.sessions.expire_session_if_due / _finish_locked",
        call={"session_id": exam_id, "deadline": exam.exam_deadline.isoformat(), "now": "<deadline + 5m>"},
        result={
            "before_deadline_status": early_status,
            "status": exam.status,
            "finished_at_is_deadline": exam.finished_at == deadline,
            "revealed_at_is_deadline": exam.revealed_at == deadline,
            "expired_at_is_the_observed_moment": exam.expired_at == noticed_at,
            "outbox_events": expired_events,
            "second_sweep_status": session_services.expire_session_if_due(exam, now=noticed_at + timedelta(minutes=1)).status,
            "events_after_second_sweep": len(outbox_rows("learning.on_session_finished", session_id=exam_id)),
        },
    )

    # manual finish after the deadline records the deadline, not the submit moment
    q6, v6, _a6 = make_question(subject, owner, "考试-2", node)
    exam2_id, _items6 = build_session(str(project.id), str(subject.id), [str(q6.id)], mode="mock_exam", duration_minutes=40)
    reg("SESSION_EXAM_LATE", exam2_id)
    exam2 = PracticeSession.objects.get(id=exam2_id)
    late = exam2.exam_deadline + timedelta(minutes=10)
    session_services.finish_session(session=exam2, user=owner, now=late)
    exam2.refresh_from_db()
    case(
        "B10-10",
        "a manual finish after the deadline records the deadline end and the observation moment",
        function="apps.practice.services.sessions.finish_session",
        call={"session_id": exam2_id, "now": "<deadline + 10m>"},
        result={
            "finished_at_is_deadline": exam2.finished_at == exam2.exam_deadline,
            "revealed_at_is_deadline": exam2.revealed_at == exam2.exam_deadline,
            "expired_at_is_the_requested_moment": exam2.expired_at == late,
            "session_events": outbox_rows("learning.on_session_finished", session_id=exam2_id),
        },
    )

    # ---------------------------------------------------------------- 6. practice finish
    q7, v7, _a7 = make_question(subject, owner, "练习-1", node)
    practice_id, _items7 = build_session(str(project.id), str(subject.id), [str(q7.id)])
    reg("SESSION_PRACTICE", practice_id)
    practice = PracticeSession.objects.get(id=practice_id)
    moment = practice.created_at + timedelta(minutes=3)
    session_services.finish_session(session=practice, user=owner, now=moment)
    practice.refresh_from_db()
    case(
        "B10-11",
        "a practice session finishes without revealing anything",
        function="apps.practice.services.sessions.finish_session",
        call={"session_id": practice_id, "now": "<created_at + 3m>"},
        result={
            "status": practice.status,
            "finished_at_is_the_moment": practice.finished_at == moment,
            "revealed_at": None if practice.revealed_at is None else practice.revealed_at.isoformat(),
            "expired_at": None if practice.expired_at is None else practice.expired_at.isoformat(),
            "origin_task_id": None if practice.origin_task_id is None else str(practice.origin_task_id),
        },
    )

    # ---------------------------------------------------------------- totals
    case(
        "B10-12",
        "outbox totals for this probe run (topics the Node worker must handle)",
        function="apps.audit.models.OutboxEvent",
        call={},
        result={
            "by_topic": {
                topic: OutboxEvent.objects.filter(topic=topic).count()
                for topic in sorted(set(OutboxEvent.objects.values_list("topic", flat=True)))
            },
            "unresolved": OutboxEvent.objects.filter(processed_at__isnull=True).count(),
            "total": OutboxEvent.objects.count(),
        },
    )


def build_golden() -> dict:
    """The parity vector the Node test replays.

    Everything here is derived from the scrubbed cases, so re-running the probe regenerates the file
    byte for byte. Only fixture-independent facts are kept: ids, instants and the rule snapshot are
    left out on purpose (the Node fixture has its own rows).
    """
    by_id = {case["id"]: case for case in CASES}
    invalidate = by_id["B10-01"]
    dispute = by_id["B10-02"]
    repeat = by_id["B10-03"]
    dedupe = by_id["B10-05"]
    finish = by_id["B10-06"]
    refresh = by_id["B10-07"]
    expiry = by_id["B10-09"]
    practice = by_id["B10-11"]

    invalidated_row = invalidate["rows"]["evidence_after"][0]
    events = dispute["rows"]["attempt_wrong_after"]["grade_events"]
    previous, invalidation = events
    keep = (
        "kind",
        "status",
        "method",
        "confirmed_score",
        "max_score",
        "pending_max_score",
        "is_fully_confirmed",
        "is_superseded",
        "grader_is_self",
        "rule_version",
        "parts",
    )
    return {
        "generated_by": "scripts/probe_b10_capabilities.py",
        "source": "var/b10/f4-probe.json",
        "note": (
            "Django 真实函数在一张一次性 test DB 上产生的向量；ids/时间/规则快照已剔除。"
            "Node 侧用等价夹具重放同样的断言。"
        ),
        "evidence_invalidation": {
            "rows_per_attempt": invalidate["result"]["rows_before"],
            "returned": invalidate["result"]["returned"],
            "active_after": invalidate["result"]["active_after"],
            "second_call": invalidate["result"]["second_call_returned"],
            "invalidated_reason": invalidated_row["invalidated_reason"],
            "invalidated_at_set": invalidated_row["invalidated_at_set"],
        },
        "dispute": {
            "affected_for_two_attempts": dispute["result"]["affected"],
            "grading_revision_delta": invalidation["grading_revision"] - previous["grading_revision"],
            "previous_is_superseded": previous["is_superseded"],
            "event": {name: invalidation[name] for name in keep},
            "comment": invalidation["comment"],
            "invalidation_reason": invalidation["invalidation_reason"],
            "rule_snapshot_copied": invalidation["rule_snapshot"] == previous["rule_snapshot"],
            "part_keys": sorted(invalidation["parts"][0].keys()),
        },
        "repeat_dispute": {
            "affected": repeat["result"]["affected"],
            "events_added": repeat["result"]["grade_events_after"] - repeat["result"]["grade_events_before"],
        },
        "answer_change_dedupe": {
            "same_second_events": dedupe["result"]["events_after_same_second"],
            "next_second_events": dedupe["result"]["events_after_next_second"],
            "key_template": "answer-change:<answer_key_version_id>:<epoch-seconds>",
        },
        "session_finish": {
            "status": finish["result"]["status"],
            "revealed_equals_finished": finish["result"]["revealed_equals_finished"],
            "task_status": finish["result"]["task_status"],
            "task_completed_at_equals_finished": finish["result"]["task_completed_at_equals_finished"],
            "events": len(finish["result"]["outbox_events"]),
            "event_topic": finish["result"]["outbox_events"][0]["topic"],
            "dedupe_template": "session-finished:<session_id>",
            "payload_keys": sorted(finish["result"]["outbox_events"][0]["payload"].keys()),
        },
        "session_refresh": {
            "returned": refresh["result"]["returned"],
            "attempts": refresh["result"]["attempts_in_session"],
            "evidence_per_attempt": refresh["result"]["evidence_rows_per_attempt"],
            "state": {
                key: refresh["result"]["state_rows"][0][key]
                for key in (
                    "summary",
                    "best_summary",
                    "independent_correct_count",
                    "distinct_question_count",
                    "distinct_template_count",
                    "has_delayed_correct",
                    "needs_review",
                    "rule_version",
                )
            },
        },
        "mock_exam_expiry": {
            "before_deadline_status": expiry["result"]["before_deadline_status"],
            "finished_at_is_deadline": expiry["result"]["finished_at_is_deadline"],
            "revealed_at_is_deadline": expiry["result"]["revealed_at_is_deadline"],
            "expired_at_is_the_observed_moment": expiry["result"]["expired_at_is_the_observed_moment"],
            "events": len(expiry["result"]["outbox_events"]),
            "second_sweep_events": expiry["result"]["events_after_second_sweep"],
        },
        "practice_finish": {"revealed_at": practice["result"]["revealed_at"]},
    }


def render_markdown(payload: dict) -> str:
    lines = [
        "# B10 F4 真实 Django 探针（一次性 test DB）",
        "",
        f"- 数据库：{payload['database']}",
        f"- 用例数：{len(payload['cases'])}",
        "- 生成器：`dsh-plugin/scripts/probe_b10_capabilities.py`（重跑逐字节一致）",
        "- 需要本机 PostgreSQL（`config.settings.test`），探针自己建/删一张一次性 test 库，不触碰真实 `acepass` 库",
        "- Django 侧 **没有** dispute 的 HTTP 路由：只有 `question_bank/services/core.py::dispute_answer_key_version`,",
        "  由集成测试与 `attempts.py::handle_answer_dispute` 直接调用。本探针因此按服务层调用。",
        "",
    ]
    for case in payload["cases"]:
        lines.append(f"## {case['id']} {case['title']}")
        lines.append("")
        lines.append(f"- 函数：`{case['function']}`")
        lines.append(f"- 调用：`{json.dumps(case['call'], ensure_ascii=False, sort_keys=True)}`")
        if case.get("notes"):
            lines.append(f"- 备注：{case['notes']}")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(case["result"], ensure_ascii=False, indent=1, sort_keys=True))
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        build()
    finally:
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {"database": "postgresql (throw-away test database)", "cases": CASES}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    OUT_MD.write_text(render_markdown(payload), encoding="utf-8")
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(
        json.dumps(build_golden(), ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"cases={len(CASES)}")
    for item in CASES:
        print(item["id"], item["title"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
