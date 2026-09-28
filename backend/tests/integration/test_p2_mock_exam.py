"""P2 batch 3 / acceptance C05: a timed mock exam with a server-owned deadline.

The rule (docs/05 §3 C05): refreshing the page, losing the connection or moving
the client clock never extends the server deadline; submitting is one-shot; and an
active exam gives no correctness feedback anywhere.

Every assertion below is made against the real HTTP payloads and rows of the
running system. "Time passing" is always a server-side clock (the services' own
``now=`` argument or a patched ``timezone.now``), never a client claim — which is
exactly the property the acceptance rule is about.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta
from decimal import Decimal
from io import StringIO

import pytest
from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.test import Client
from django.utils import timezone

from apps.audit.models import OutboxEvent
from apps.common.enums import AssetSensitivity, SessionMode, SessionStatus
from apps.common.errors import InvalidInput
from apps.exams.models import ExamSpecVersion
from apps.exams.services import core as exams_services
from apps.ingestion.models import Asset
from apps.learning.models import StudyTask
from apps.practice.models import Attempt, PracticeSession
from apps.practice.services import sessions as session_services
from apps.question_bank.models import AnswerKeyVersion, QuestionVersion
from tests.conftest import OWNER_EMAIL, OWNER_PASSWORD, login

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def versions_of(subject, question_type: str) -> list[QuestionVersion]:
    """Every published version of one type, in a stable order."""
    return list(
        QuestionVersion.objects.filter(
            question__subject=subject, question_type=question_type, status="published"
        )
        .select_related("question")
        .order_by("question__display_label")
    )


def publish_spec(subject, *, time_rules: dict, name: str = "C05 计时规范") -> ExamSpecVersion:
    """Publish a spec whose per-type seconds drive the derived exam length."""
    spec = exams_services.create_exam_spec_version(
        subject,
        created_by=subject.project.owner,
        name=name,
        question_type_rules={
            "single_choice": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
            "multiple_choice": {"default_max_score": "4.00", "wrong_score": "0.00", "blank_score": "0.00"},
            "true_false": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
            "fill_blank": {"default_max_score": "3.00"},
            "constructed_response": {"default_max_score": "10.00"},
        },
        time_rules=time_rules,
        total_score=subject.total_score,
        pass_score=subject.pass_score,
        rule_source_note="C05 测试规范（非官方规则）",
    )
    return exams_services.publish_exam_spec_version(spec, actor=subject.project.owner)


def exam_body(subject, versions, *, duration_minutes=None, spec=None, **extra) -> dict:
    """A mock-exam request body; ``extra`` carries the fields a client must not win with."""
    body = {
        "mode": SessionMode.MOCK_EXAM,
        "subject_id": str(subject.id),
        "question_ids": [str(version.question_id) for version in versions],
        **extra,
    }
    if duration_minutes is not None:
        body["duration_minutes"] = duration_minutes
    if spec is not None:
        body["exam_spec_version_id"] = str(spec.id)
    return body


def start_mock(caller, project, subject, versions, *, duration_minutes=None, spec=None, key=None, **extra):
    return caller.post(
        f"/api/v1/projects/{project.id}/practice-sessions",
        exam_body(subject, versions, duration_minutes=duration_minutes, spec=spec, **extra),
        key=key,
    )


def session_row(session_id) -> PracticeSession:
    return PracticeSession.objects.get(id=session_id)


def detail(caller, project, session_id: str) -> dict:
    response = caller.get(f"/api/v1/projects/{project.id}/practice-sessions/{session_id}")
    assert response.status_code == 200, response.content
    return response.json()


def present(caller, project, item_id: str) -> dict:
    response = caller.get(f"/api/v1/projects/{project.id}/session-items/{item_id}/presentation")
    assert response.status_code == 200, response.content
    return response.json()


def submit(caller, project, item_id: str, answer: dict, *, key: str):
    return caller.post(
        f"/api/v1/projects/{project.id}/session-items/{item_id}/submit",
        {"answer": answer, "confidence": "unsure"},
        key=key,
    )


def finish(caller, project, session_id: str, *, key: str):
    return caller.post(
        f"/api/v1/projects/{project.id}/practice-sessions/{session_id}/finish", {}, key=key
    )


def correct_answer(version: QuestionVersion) -> dict:
    """The reviewed answer, shaped the way the submit endpoint expects it."""
    payload = AnswerKeyVersion.objects.get(
        question_version=version, verification_status="checked", is_disputed=False
    ).answer_payload
    return {"type": version.question_type, "selected_option_ids": [payload["correct_option_id"]]}


def events_for(session_id) -> list[OutboxEvent]:
    """Every "session finished" event for this session.

    Found by *payload*, not by the dedupe key: the count then proves that the
    finish happened once, instead of proving that the dedupe key collapsed two
    finishes into one row.
    """
    return list(
        OutboxEvent.objects.filter(
            topic="learning.on_session_finished", payload__session_id=str(session_id)
        )
    )


def row_for(state: dict, item_id: str) -> dict:
    return next(row for row in state["items"] if row["session_item_id"] == str(item_id))


@pytest.fixture
def clock(monkeypatch):
    """A controllable server clock.

    The services read ``timezone.now()``; patching it is how a test says "the
    server's clock moved", which is the only way time is allowed to move here.
    """
    from django.utils import timezone as django_timezone

    state = {"now": django_timezone.now()}
    monkeypatch.setattr(django_timezone, "now", lambda: state["now"])
    return state


# --------------------------------------------------------------------------
# 1. Creation: a server-owned deadline derived from trusted inputs
# --------------------------------------------------------------------------
def test_mock_exam_deadline_is_derived_from_the_spec_on_the_server(
    caller, clock, project_a, subject_a1
):
    versions = versions_of(subject_a1, "single_choice")
    assert len(versions) >= 2
    chosen = versions[:2]
    spec = publish_spec(subject_a1, time_rules={"single_choice_seconds": 300})
    started = clock["now"]

    response = start_mock(caller, project_a, subject_a1, chosen, spec=spec, key="c05-spec-deadline")
    assert response.status_code == 201, response.content
    body = response.json()

    assert body["mode"] == SessionMode.MOCK_EXAM
    assert body["status"] == SessionStatus.ACTIVE
    assert body["grading_hidden"] is True
    assert body["expired_at"] is None
    assert all(item["tutoring_allowed"] is False for item in body["items"])
    assert len(body["items"]) == 2

    session = session_row(body["session_id"])
    # 2 questions × 300 s = 10 minutes, summed from the spec and computed here.
    assert session.exam_started_at == started
    assert session.exam_deadline == started + timedelta(minutes=10)
    assert body["exam_started_at"] == session.exam_started_at.isoformat()
    assert body["exam_deadline"] == session.exam_deadline.isoformat()
    # Every item froze the spec version the length was derived from.
    assert {str(item.spec_version_id) for item in session.items.all()} == {str(spec.id)}


def test_explicit_duration_is_bounded_and_an_unknown_duration_is_refused(
    caller, clock, owner, project_a, subject_a1
):
    version = versions_of(subject_a1, "single_choice")[0]
    started = clock["now"]

    explicit = start_mock(caller, project_a, subject_a1, [version], duration_minutes=30, key="c05-dur-ok")
    assert explicit.status_code == 201, explicit.content
    session = session_row(explicit.json()["session_id"])
    assert session.exam_started_at == started
    assert session.exam_deadline == started + timedelta(minutes=30)

    for bad in (0, 1, 4, 601, 60 * 24):
        response = start_mock(
            caller, project_a, subject_a1, [version], duration_minutes=bad, key=f"c05-dur-bad-{bad}"
        )
        assert response.status_code == 400, (bad, response.content)
        assert response.json()["error"]["code"] == "invalid_input"
        assert "分钟" in response.json()["error"]["message"]

    # No duration and a spec that says nothing about time: refused, and the
    # refusal names the missing question type instead of guessing a length.
    timeless = publish_spec(subject_a1, time_rules={}, name="无时长规范")
    missing = start_mock(caller, project_a, subject_a1, [version], spec=timeless, key="c05-dur-missing")
    assert missing.status_code == 400, missing.content
    error = missing.json()["error"]
    assert error["code"] == "invalid_input"
    assert "single_choice" in error["message"]
    assert error["details"]["missing_question_types"] == ["single_choice"]

    # No spec at all is the same refusal at the service layer.
    with pytest.raises(InvalidInput) as excinfo:
        session_services.resolve_mock_exam_minutes(duration_minutes=None, items=[], spec_version=None)
    assert "duration_minutes" in excinfo.value.message

    # A duration on a non-exam mode is a client mistake, not a silent no-op.
    practice = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {
            "mode": SessionMode.PRACTICE,
            "subject_id": str(subject_a1.id),
            "question_ids": [str(version.question_id)],
            "duration_minutes": 30,
        },
        key="c05-dur-practice",
    )
    assert practice.status_code == 400, practice.content
    assert practice.json()["error"]["code"] == "invalid_input"

    # Nothing above left an exam without a deadline behind.
    exams = PracticeSession.objects.filter(mode=SessionMode.MOCK_EXAM)
    assert exams.count() == 1
    assert not exams.filter(exam_deadline__isnull=True).exists()


def test_client_supplied_deadline_and_clock_are_ignored(caller, clock, project_a, subject_a1):
    version = versions_of(subject_a1, "single_choice")[0]
    started = clock["now"]
    forged = (started + timedelta(days=365)).isoformat()
    past = (started - timedelta(days=2)).isoformat()

    response = start_mock(
        caller,
        project_a,
        subject_a1,
        [version],
        duration_minutes=30,
        key="c05-ignore-client-clock",
        exam_deadline=forged,
        deadline=forged,
        now=past,
        started_at=past,
    )
    assert response.status_code == 201, response.content
    body = response.json()
    session = session_row(body["session_id"])

    # The server clock and the bounded duration decided; the request's own values
    # were dropped by the schema and never reached the row.
    assert session.exam_started_at == started
    assert session.exam_deadline == started + timedelta(minutes=30)
    assert session.exam_deadline.isoformat() != forged
    assert body["exam_deadline"] == session.exam_deadline.isoformat()
    assert body["exam_started_at"] != past


# --------------------------------------------------------------------------
# 2. Nothing a client does moves the deadline
# --------------------------------------------------------------------------
def test_repeated_reads_presentations_and_reconnects_never_move_the_deadline(
    caller, clock, project_a, subject_a1
):
    versions = versions_of(subject_a1, "single_choice")[:2]
    created = start_mock(
        caller, project_a, subject_a1, versions, duration_minutes=45, key="c05-stable-deadline"
    ).json()
    session_id = created["session_id"]
    stored_before = PracticeSession.objects.values("exam_started_at", "exam_deadline").get(id=session_id)
    deadline_text = created["exam_deadline"]
    started_text = created["exam_started_at"]

    # A couple of "minutes" of wall clock pass on the client, and the tab
    # refreshes, reconnects and re-presents items many times.
    clock["now"] = clock["now"] + timedelta(minutes=7)
    for _ in range(3):
        state = detail(caller, project_a, session_id)
        assert state["exam_deadline"] == deadline_text
        assert state["exam_started_at"] == started_text
        assert state["server_time"] == clock["now"].isoformat()
    for item in created["items"]:
        for _ in range(2):
            payload = present(caller, project_a, item["session_item_id"])
            assert payload["exam_deadline"] == deadline_text
            assert payload["exam_started_at"] == started_text
            assert payload["status"] == SessionStatus.ACTIVE
    listed = caller.get(f"/api/v1/projects/{project_a.id}/practice-sessions").json()
    assert [row for row in listed if row["session_id"] == session_id][0]["exam_deadline"] == deadline_text
    assert caller.get(f"/api/v1/projects/{project_a.id}/grading-queue").status_code == 200
    assert caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").status_code == 200

    # A fresh login is a reconnected client: same stored deadline, same start.
    reconnect = login(Client(), OWNER_EMAIL, OWNER_PASSWORD)
    reconnected = reconnect.get(f"/api/v1/projects/{project_a.id}/practice-sessions/{session_id}").json()
    assert reconnected["exam_deadline"] == deadline_text
    assert reconnected["exam_started_at"] == started_text

    stored_after = PracticeSession.objects.values("exam_started_at", "exam_deadline").get(id=session_id)
    assert stored_after == stored_before


# --------------------------------------------------------------------------
# 3. One-shot submit: the first finish ends it, a second is a no-op
# --------------------------------------------------------------------------
def test_finish_is_one_shot_and_nothing_reopens_the_exam(caller, clock, project_a, subject_a1):
    versions = versions_of(subject_a1, "single_choice")[:2]
    created = start_mock(
        caller, project_a, subject_a1, versions, duration_minutes=30, key="c05-one-shot"
    ).json()
    session_id = created["session_id"]
    item_id = created["items"][0]["session_item_id"]
    other_item_id = created["items"][1]["session_item_id"]
    present(caller, project_a, item_id)
    assert submit(caller, project_a, item_id, correct_answer(versions[0]), key="c05-one-shot-submit").status_code == 200

    clock["now"] = clock["now"] + timedelta(minutes=5)
    first = finish(caller, project_a, session_id, key="c05-one-shot-finish")
    assert first.status_code == 200, first.content
    assert first.json()["status"] == SessionStatus.FINISHED
    session = session_row(session_id)
    assert session.finished_at is not None
    finished_at = session.finished_at
    revealed_at = session.revealed_at
    assert session.expired_at is None  # a manual finish inside the window, not an expiry
    assert len(events_for(session_id)) == 1

    # A second finish with a new key is a no-op, not an error and not a new event.
    clock["now"] = clock["now"] + timedelta(minutes=3)
    again = finish(caller, project_a, session_id, key="c05-one-shot-finish-again")
    assert again.status_code == 200, again.content
    assert again.json()["status"] == SessionStatus.FINISHED
    assert again.json()["finished_at"] == finished_at.isoformat()
    session.refresh_from_db()
    assert (session.finished_at, session.revealed_at) == (finished_at, revealed_at)
    assert len(events_for(session_id)) == 1

    # Nothing submits into a finished exam, and the recorded answers do not change.
    assert Attempt.objects.filter(session_item__session_id=session_id).count() == 1
    late = submit(caller, project_a, other_item_id, correct_answer(versions[1]), key="c05-one-shot-late")
    assert late.status_code == 400, late.content
    assert Attempt.objects.filter(session_item__session_id=session_id).count() == 1

    # The row itself refuses to be reopened or extended, even for a future caller.
    session.refresh_from_db()
    session.exam_deadline = session.exam_deadline + timedelta(hours=1)
    with pytest.raises(ValidationError):
        session.save(update_fields=["exam_deadline", "updated_at"])
    session.refresh_from_db()
    session.status = SessionStatus.ACTIVE
    with pytest.raises(ValidationError):
        session.save(update_fields=["status", "updated_at"])
    session.refresh_from_db()
    assert session.status == SessionStatus.FINISHED
    # The end of the exam is the deadline the server wrote, never the finish time.
    assert session.exam_deadline == finished_at + timedelta(minutes=25)


# --------------------------------------------------------------------------
# 4. Expiry: the exam ends at the deadline, exactly once, and reveals results
# --------------------------------------------------------------------------
def test_expiry_finishes_at_the_deadline_with_one_event_and_reveals_results(
    caller, clock, owner, project_a, subject_a1
):
    versions = versions_of(subject_a1, "single_choice")[:2]
    task = StudyTask.objects.create(
        user=owner,
        project=project_a,
        subject=subject_a1,
        task_kind="memory_review",
        status="pending",
    )
    session = session_services.create_session(
        user=owner,
        project=project_a,
        subject=subject_a1,
        mode=SessionMode.MOCK_EXAM,
        question_ids=[str(version.question_id) for version in versions],
        task=task,
        duration_minutes=30,
    )
    deadline = session.exam_deadline
    assert deadline == session.exam_started_at + timedelta(minutes=30)
    items = list(session.items.order_by("ordinal"))
    answer_key = AnswerKeyVersion.objects.get(
        question_version=versions[0], verification_status="checked", is_disputed=False
    )
    present(caller, project_a, items[0].id)
    in_time = submit(caller, project_a, items[0].id, correct_answer(versions[0]), key="c05-expiry-submit")
    assert in_time.status_code == 200, in_time.content
    attempt_id = in_time.json()["attempt_id"]

    # The connection "drops" and the tab comes back well after the deadline.
    clock["now"] = deadline + timedelta(minutes=3)
    state = detail(caller, project_a, session.id)

    assert state["status"] == SessionStatus.FINISHED
    assert state["grading_hidden"] is False
    assert state["score_visible"] is True
    assert state["finished_at"] == deadline.isoformat()
    assert state["revealed_at"] == deadline.isoformat()
    assert state["expired_at"] == (deadline + timedelta(minutes=3)).isoformat()
    assert Decimal(state["confirmed_score"]) == items[0].max_score
    row = row_for(state, items[0].id)
    assert row["attempt"]["grade"]["is_correct"] is True
    assert row["attempt"]["receipt_only"] is False
    assert Decimal(row["attempt"]["grade"]["confirmed_score"]) == items[0].max_score
    assert row_for(state, items[1].id)["attempt"] is None  # never answered, never invented

    session.refresh_from_db()
    assert session.finished_at == deadline  # the deadline, not "now"
    assert session.revealed_at == deadline
    assert session.expired_at == clock["now"]
    assert len(events_for(session.id)) == 1
    assert events_for(session.id)[0].topic == "learning.on_session_finished"

    # The origin task is completed at the deadline, not at the moment of noticing.
    task.refresh_from_db()
    assert task.status == "completed"
    assert task.completed_at == deadline

    # Results are readable: the answered item reveals its trusted answer.
    reveal = caller.post(f"/api/v1/projects/{project_a.id}/session-items/{items[0].id}/reveal")
    assert reveal.status_code == 200, reveal.content
    assert reveal.json()["answer_key_version_id"] == str(answer_key.id)
    assert reveal.json()["answer_payload"] == answer_key.answer_payload

    # More reads and more sweeps change nothing and add no second event.
    clock["now"] = deadline + timedelta(hours=2)
    assert detail(caller, project_a, session.id)["finished_at"] == deadline.isoformat()
    assert session_services.expire_due_mock_exams(user=owner, now=clock["now"]) == 0
    assert len(events_for(session.id)) == 1
    assert Attempt.objects.filter(session_item__session=session).count() == 1
    assert Attempt.objects.get(id=attempt_id).session_item_id == items[0].id


def test_effective_deadline_falls_back_to_exam_started_at(caller, clock, owner, project_a, subject_a1):
    versions = versions_of(subject_a1, "single_choice")[:2]
    spec = publish_spec(subject_a1, time_rules={"single_choice_seconds": 300})
    session = session_services.create_session(
        user=owner,
        project=project_a,
        subject=subject_a1,
        mode=SessionMode.MOCK_EXAM,
        question_ids=[str(version.question_id) for version in versions],
        spec_version=spec,
        duration_minutes=30,
    )
    expected = session.exam_started_at + timedelta(minutes=30)
    assert session_services.effective_deadline(session) == expected

    # Only `exam_started_at` survives (a partially written / legacy row): the
    # length is re-derived from the frozen spec, so the exam stays bounded.
    PracticeSession.objects.filter(id=session.id).update(exam_deadline=None)
    session.refresh_from_db()
    assert session.exam_deadline is None
    assert session_services.effective_deadline(session) == session.exam_started_at + timedelta(minutes=10)

    clock["now"] = session.exam_started_at + timedelta(minutes=11)
    state = detail(caller, project_a, session.id)
    assert state["status"] == SessionStatus.FINISHED
    assert state["finished_at"] == (session.exam_started_at + timedelta(minutes=10)).isoformat()

    # A row that cannot be derived at all is NOT given an invented deadline: the
    # create path refuses such an exam, and this helper never guesses one.
    spec_without_time = publish_spec(subject_a1, time_rules={}, name="无时长规范")
    undecidable = session_services.create_session(
        user=owner,
        project=project_a,
        subject=subject_a1,
        mode=SessionMode.MOCK_EXAM,
        question_ids=[str(version.question_id) for version in versions[:1]],
        duration_minutes=15,
    )
    PracticeSession.objects.filter(id=undecidable.id).update(
        exam_deadline=None, exam_started_at=clock["now"] - timedelta(hours=1)
    )
    undecidable.refresh_from_db()
    undecidable.items.update(spec_version=spec_without_time)
    assert session_services.effective_deadline(undecidable) is None


# --------------------------------------------------------------------------
# 5. Submissions after the deadline
# --------------------------------------------------------------------------
def test_submission_after_the_deadline_is_refused_and_in_time_submission_succeeds(
    caller, clock, project_a, subject_a1
):
    versions = versions_of(subject_a1, "single_choice")[:2]
    created = start_mock(
        caller, project_a, subject_a1, versions, duration_minutes=30, key="c05-late-submit"
    ).json()
    session_id = created["session_id"]
    deadline = datetime.fromisoformat(created["exam_deadline"])
    item_ok, item_late = created["items"][0]["session_item_id"], created["items"][1]["session_item_id"]

    # One second before the deadline the server still accepts the answer.
    clock["now"] = deadline - timedelta(seconds=1)
    just_in_time = submit(caller, project_a, item_ok, correct_answer(versions[0]), key="c05-just-in-time")
    assert just_in_time.status_code == 200, just_in_time.content
    assert just_in_time.json()["receipt_only"] is True  # still a running exam
    assert just_in_time.json()["grade"] is None
    attempt_id = just_in_time.json()["attempt_id"]

    # One second after it, the answer is refused with the deadline named.
    clock["now"] = deadline + timedelta(seconds=1)
    late = submit(caller, project_a, item_late, correct_answer(versions[1]), key="c05-too-late")
    assert late.status_code == 409, late.content
    error = late.json()["error"]
    assert error["code"] == "version_conflict"
    named = timezone.localtime(deadline).strftime("%Y-%m-%d %H:%M:%S")
    assert named in error["message"]
    assert error["details"]["reason"] == "exam_deadline_passed"
    assert error["details"]["exam_deadline"] == created["exam_deadline"]

    # The refused answer left no trace, and the in-time one is untouched.
    assert Attempt.objects.filter(session_item__session_id=session_id).count() == 1
    assert not Attempt.objects.filter(session_item_id=item_late).exists()
    assert str(Attempt.objects.get(id=attempt_id).session_item_id) == item_ok

    # The refusal was also the reconciliation: the exam is over at the deadline.
    session = session_row(session_id)
    assert session.status == SessionStatus.FINISHED
    assert session.finished_at == deadline
    assert session.expired_at == clock["now"]

    # A draft is not an answer, but the run it belongs to already reads as over.
    draft = caller.put(
        f"/api/v1/projects/{project_a.id}/session-items/{item_late}/draft",
        {"draft": {"note": "late"}, "draft_revision": 0},
    )
    assert draft.status_code == 400, draft.content

    # Retrying the in-time submission (same key) now returns the graded result —
    # the auto-finish graded what was submitted in time.
    replay = submit(caller, project_a, item_ok, correct_answer(versions[0]), key="c05-just-in-time")
    assert replay.status_code == 200, replay.content
    assert replay.json()["attempt_id"] == attempt_id
    assert replay.json()["receipt_only"] is False
    assert replay.json()["grade"]["is_correct"] is True


# --------------------------------------------------------------------------
# 6. No mid-exam correctness feedback, and the results afterwards
# --------------------------------------------------------------------------
def test_active_mock_exam_hides_every_feedback_surface(caller, clock, project_a, subject_a1):
    versions = versions_of(subject_a1, "single_choice")[:2]
    created = start_mock(
        caller, project_a, subject_a1, versions, duration_minutes=60, key="c05-no-feedback"
    ).json()
    session_id = created["session_id"]
    item_id = created["items"][0]["session_item_id"]
    unanswered_id = created["items"][1]["session_item_id"]

    # 1) presentation: the stem only, no answer, no tutoring, the deadline echoed.
    presentation = present(caller, project_a, item_id)
    assert presentation["grading_hidden"] is True
    assert presentation["tutoring_allowed"] is False
    assert presentation["exam_deadline"] == created["exam_deadline"]
    rendered = json.dumps(presentation, ensure_ascii=False)
    assert "answer_payload" not in rendered
    assert "correct_option_id" not in rendered
    assert "explanation_blocks" not in rendered
    assert "rubric" not in rendered

    # 2) submit: a receipt, never a score.
    submitted = submit(caller, project_a, item_id, correct_answer(versions[0]), key="c05-no-feedback-submit")
    assert submitted.status_code == 200, submitted.content
    receipt = submitted.json()
    assert receipt["receipt_only"] is True
    assert receipt["grade"] is None
    attempt_id = receipt["attempt_id"]

    # 3) session detail: the totals are omitted, not merely flagged.
    state = detail(caller, project_a, session_id)
    assert state["grading_hidden"] is True
    assert state["score_visible"] is False
    assert state["confirmed_score"] is None
    assert state["pending_max_score"] is None
    assert "模拟考试" in state["score_hidden_reason"]
    row = row_for(state, item_id)
    assert row["attempt"]["grade"] is None
    assert row["attempt"]["receipt_only"] is True
    assert row["can_reveal"] is False
    assert row_for(state, unanswered_id)["attempt"] is None
    assert state["confirmed_score"] is None

    # 4) attempt read: the same gate on the stored grade.
    attempt_read = caller.get(f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}")
    assert attempt_read.status_code == 200, attempt_read.content
    assert attempt_read.json()["grade"] is None
    assert attempt_read.json()["receipt_only"] is True

    # 5) confirming a grade would write the result, so it is refused outright.
    confirm = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/confirm-grade",
        {"expected_grading_revision": receipt["grading_revision"], "parts": []},
        key="c05-no-feedback-confirm",
    )
    assert confirm.status_code == 403, confirm.content
    assert confirm.json()["error"]["code"] == "purpose_not_allowed"

    # 6) reveal, both by item and by attempt.
    for path, key in (
        (f"/api/v1/projects/{project_a.id}/session-items/{item_id}/reveal", "c05-no-feedback-reveal-item"),
        (f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/reveal", "c05-no-feedback-reveal-attempt"),
    ):
        reveal = caller.post(path, {}, key=key)
        assert reveal.status_code == 403, (path, reveal.content)
        assert reveal.json()["error"]["code"] == "purpose_not_allowed"

    # 7) tutor / hint / explanation are refused for the running exam.
    for purpose in ("hint", "explanation", "clarify"):
        tutor = caller.post(
            f"/api/v1/projects/{project_a.id}/tutor-sessions",
            {"session_item_id": item_id, "purpose": purpose},
            key=f"c05-no-feedback-tutor-{purpose}",
        )
        assert tutor.status_code == 403, (purpose, tutor.content)
        assert tutor.json()["error"]["code"] == "purpose_not_allowed"

    # 8) the grading queue excludes the running exam.
    queue = caller.get(f"/api/v1/projects/{project_a.id}/grading-queue")
    assert queue.status_code == 200, queue.content
    assert all(row["attempt_id"] != attempt_id for row in queue.json())

    # 9) reports: sums are the same disclosure, so the attempt is excluded.
    report = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert report["totals"]["fully_graded"]["attempts"] == 0
    assert report["totals"]["pending_review"]["attempts"] == 0
    assert Decimal(report["totals"]["fully_graded"]["confirmed_score"]) == 0
    assert report["hidden_verification_attempts"] >= 1

    # 10) the wrong-answer book and the evidence projection agree.
    mistakes = caller.get(f"/api/v1/projects/{project_a.id}/mistakes").json()
    assert all(row["attempt_id"] != attempt_id for row in mistakes["rows"])
    evidence = caller.get(f"/api/v1/projects/{project_a.id}/evidence").json()
    assert all(row["attempt_id"] != attempt_id for row in evidence["rows"])

    # 11) score-shaped AI surfaces are refused.
    assert caller.get(f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/ai-estimate").status_code == 403

    # 12) answer-bearing assets cannot be fetched for the exam.
    asset = Asset.objects.create(
        owner=project_a.owner,
        project=project_a,
        subject=subject_a1,
        sensitivity=AssetSensitivity.CONTAINS_ANSWERS,
        object_key="c05/answer-page.png",
        original_filename="answer-page.png",
        content_type="image/png",
        size_bytes=32,
        checksum="c05answerpage",
    )
    with_item = caller.get(
        f"/api/v1/projects/{project_a.id}/assets/{asset.id}?session_item_id={item_id}"
    )
    assert with_item.status_code == 403, with_item.content
    without_item = caller.get(f"/api/v1/projects/{project_a.id}/assets/{asset.id}")
    assert without_item.status_code == 403, without_item.content

    # ---------------- the exam ends: the same surfaces now deliver ----------
    ended = finish(caller, project_a, session_id, key="c05-no-feedback-finish")
    assert ended.status_code == 200, ended.content
    final = ended.json()
    assert final["status"] == SessionStatus.FINISHED
    assert final["grading_hidden"] is False
    assert final["score_visible"] is True
    assert Decimal(final["confirmed_score"]) == Decimal(created["items"][0]["max_score"])
    answered = row_for(final, item_id)
    assert answered["can_reveal"] is True
    assert answered["attempt"]["receipt_only"] is False
    assert answered["attempt"]["grade"]["is_correct"] is True
    assert Decimal(answered["attempt"]["grade"]["confirmed_score"]) == Decimal(created["items"][0]["max_score"])

    revealed = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/reveal", {}, key="c05-reveal-after-finish"
    )
    assert revealed.status_code == 200, revealed.content
    expected_answer = AnswerKeyVersion.objects.get(
        question_version=versions[0], verification_status="checked", is_disputed=False
    ).answer_payload
    assert revealed.json()["answer_payload"] == expected_answer
    assert revealed.json()["exposure_recorded"] is True
    # Reading the result again returns the same result, not a second effect.
    again = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/reveal", {}, key="c05-reveal-after-finish-2"
    )
    assert again.status_code == 200
    assert again.json()["answer_payload"] == revealed.json()["answer_payload"]
    report_after = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert report_after["totals"]["fully_graded"]["attempts"] == 1
    assert report_after["hidden_verification_attempts"] == 0
    assert len(events_for(session_id)) == 1


def test_active_mock_exam_content_is_gated_in_parallel_sessions(caller, clock, project_a, subject_a1):
    """A running exam's answers must not be obtainable through another session.

    This is the leak C05 shares with B02/C01: the exam itself hides its scores,
    but a *parallel* practice session on the same question would hand the learner
    the score — which is the answer. The content gate covers the exam while it
    runs, and the exam is bounded by its deadline, so the coverage cannot last.
    """
    version = versions_of(subject_a1, "single_choice")[0]
    created = start_mock(
        caller, project_a, subject_a1, [version], duration_minutes=30, key="c05-cover-exam"
    ).json()
    exam_item = created["items"][0]["session_item_id"]
    present(caller, project_a, exam_item)  # the content is now in the running exam

    practice = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {
            "mode": SessionMode.PRACTICE,
            "subject_id": str(subject_a1.id),
            "question_ids": [str(version.question_id)],
        },
        key="c05-cover-practice",
    )
    assert practice.status_code == 201, practice.content
    practice_item = practice.json()["items"][0]["session_item_id"]

    reveal = caller.post(
        f"/api/v1/projects/{project_a.id}/session-items/{practice_item}/reveal", {}, key="c05-cover-reveal"
    )
    assert reveal.status_code == 403, reveal.content
    assert reveal.json()["error"]["details"]["reason"] == "active_verification_content_gate"
    assert "模拟考试" in reveal.json()["error"]["message"]

    denied = submit(caller, project_a, practice_item, correct_answer(version), key="c05-cover-submit")
    assert denied.status_code == 403, denied.content
    assert denied.json()["error"]["details"]["reason"] == "active_verification_content_gate"
    assert not Attempt.objects.filter(session_item_id=practice_item).exists()

    tutor = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": practice_item, "purpose": "explanation"},
        key="c05-cover-tutor",
    )
    assert tutor.status_code == 403, tutor.content

    # When the exam ends, the same practice session is usable again: the coverage
    # lasts exactly as long as the timed run.
    deadline = datetime.fromisoformat(created["exam_deadline"])
    clock["now"] = deadline + timedelta(seconds=1)
    assert detail(caller, project_a, created["session_id"])["status"] == SessionStatus.FINISHED
    allowed = submit(caller, project_a, practice_item, correct_answer(version), key="c05-cover-submit-after")
    assert allowed.status_code == 200, allowed.content
    assert allowed.json()["grade"] is not None
    assert allowed.json()["grade"]["is_correct"] is True


# --------------------------------------------------------------------------
# 7. The worker entry point
# --------------------------------------------------------------------------
def test_expire_due_mock_exams_sweeps_overdue_runs_once(caller, clock, owner, project_a, subject_a1):
    versions = versions_of(subject_a1, "single_choice")[:2]
    first = start_mock(
        caller, project_a, subject_a1, [versions[0]], duration_minutes=30, key="c05-sweep-1"
    ).json()
    second = start_mock(
        caller, project_a, subject_a1, [versions[1]], duration_minutes=45, key="c05-sweep-2"
    ).json()
    practice = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {
            "mode": SessionMode.PRACTICE,
            "subject_id": str(subject_a1.id),
            "question_ids": [str(versions[0].question_id)],
        },
        key="c05-sweep-practice",
    ).json()

    far_future = clock["now"] + timedelta(days=1)
    # Nothing is due yet, so the sweep changes nothing.
    assert session_services.expire_due_mock_exams(user=owner, now=clock["now"]) == 0
    assert session_row(first["session_id"]).status == SessionStatus.ACTIVE

    clock["now"] = far_future
    assert session_services.expire_due_mock_exams(user=owner, now=far_future) == 2
    for created, minutes in ((first, 30), (second, 45)):
        session = session_row(created["session_id"])
        deadline = datetime.fromisoformat(created["exam_deadline"])
        assert session.status == SessionStatus.FINISHED
        assert session.finished_at == deadline
        assert session.finished_at == session.exam_started_at + timedelta(minutes=minutes)
        assert session.expired_at == far_future
        assert len(events_for(session.id)) == 1
    # A non-exam session is never touched by the sweep.
    practice_row = session_row(practice["session_id"])
    assert practice_row.mode == SessionMode.PRACTICE
    assert practice_row.status == SessionStatus.ACTIVE
    assert practice_row.expired_at is None

    # Running it again is a no-op, not a second finish and not a second event.
    assert session_services.expire_due_mock_exams(user=owner, now=far_future) == 0

    # The same reconciliation is available to a worker through the command.
    assert len(events_for(first["session_id"])) == 1
    out = StringIO()
    call_command("expire_mock_exams", "--project-id", str(project_a.id), stdout=out)
    assert out.getvalue().strip() == "expired=0"

    third = start_mock(
        caller, project_a, subject_a1, [versions[0]], duration_minutes=20, key="c05-sweep-3"
    ).json()
    clock["now"] = far_future + timedelta(hours=1)
    out = StringIO()
    call_command("expire_mock_exams", "--project-id", str(project_a.id), "--limit", "10", stdout=out)
    assert out.getvalue().strip() == "expired=1"
    third_row = session_row(third["session_id"])
    assert third_row.status == SessionStatus.FINISHED
    assert third_row.finished_at == third_row.exam_deadline
    assert third_row.expired_at is not None
    assert len(events_for(third["session_id"])) == 1


def test_report_reads_reconcile_an_overdue_exam_and_hide_a_running_one(
    caller, clock, project_a, subject_a1
):
    """The report is a read path that touches exams, so it must reconcile first."""
    versions = versions_of(subject_a1, "single_choice")[:2]
    overdue = start_mock(
        caller, project_a, subject_a1, [versions[0]], duration_minutes=30, key="c05-report-overdue"
    ).json()
    running = start_mock(
        caller, project_a, subject_a1, [versions[1]], duration_minutes=90, key="c05-report-running"
    ).json()
    for created, version in ((overdue, versions[0]), (running, versions[1])):
        item = created["items"][0]["session_item_id"]
        present(caller, project_a, item)
        submitted = submit(
            caller, project_a, item, correct_answer(version), key=f"c05-report-submit-{created['session_id']}"
        )
        assert submitted.status_code == 200, submitted.content

    # Inside their windows neither score reaches the report.
    report = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert report["totals"]["fully_graded"]["attempts"] == 0
    assert report["hidden_verification_attempts"] == 2

    # Only the first exam is overdue: the report read itself finishes it at the
    # deadline and counts its in-time answer, while the running one stays hidden.
    deadline = datetime.fromisoformat(overdue["exam_deadline"])
    clock["now"] = deadline + timedelta(seconds=1)
    report = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert report["hidden_verification_attempts"] == 1
    assert report["totals"]["fully_graded"]["attempts"] == 1
    finished = session_row(overdue["session_id"])
    assert finished.status == SessionStatus.FINISHED
    assert finished.finished_at == deadline
    assert session_row(running["session_id"]).status == SessionStatus.ACTIVE


@pytest.mark.django_db(transaction=True)
def test_two_concurrent_expiries_finish_the_exam_exactly_once(caller, clock, project_a, subject_a1):
    """Two callers racing on one overdue exam: one finish, one outbox event."""
    version = versions_of(subject_a1, "single_choice")[0]
    created = start_mock(
        caller, project_a, subject_a1, [version], duration_minutes=30, key="c05-race"
    ).json()
    session_id = created["session_id"]
    session = session_row(session_id)
    later = session.exam_deadline + timedelta(minutes=1)

    results: list[PracticeSession] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(2, timeout=10)

    def expire_from_its_own_connection() -> None:
        from django.db import connection

        try:
            barrier.wait()
            expired = session_services.expire_session_if_due(session_row(session_id), now=later)
            results.append(expired)
        except BaseException as exc:  # pragma: no cover - surfaced by the assertion
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=expire_from_its_own_connection) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not any(thread.is_alive() for thread in threads)
    assert errors == []
    assert {result.status for result in results} == {SessionStatus.FINISHED}

    refreshed = session_row(session_id)
    assert refreshed.status == SessionStatus.FINISHED
    assert refreshed.finished_at == refreshed.exam_deadline
    assert refreshed.expired_at == later
    assert len(events_for(session_id)) == 1


# --------------------------------------------------------------------------
# 8. The refusal paths name the deadline, and the API contract stays additive
# --------------------------------------------------------------------------
def test_mock_exam_creation_contract_is_additive_and_explicit(caller, project_a, subject_a1):
    """An unknown mode is still refused; only ``mock_exam`` gained a length."""
    version = versions_of(subject_a1, "single_choice")[0]
    unknown = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": "final_exam", "subject_id": str(subject_a1.id), "question_ids": [str(version.question_id)]},
        key="c05-unknown-mode",
    )
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "invalid_input"

    # A mock exam refuses an out-of-scope subject like every other mode.
    other = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": SessionMode.MOCK_EXAM, "subject_id": "00000000-0000-0000-0000-000000000000"},
        key="c05-scope",
    )
    assert other.status_code == 404
    assert not PracticeSession.objects.filter(mode=SessionMode.MOCK_EXAM).exists()
