"""P0.1 regression coverage for the independent review findings R01-R11.

These cases are the failing specifications from `docs/review/2026-09-27` migrated
into the normal test suite, with the assertions the review asked for:

* grading completeness and full marks are separate facts (R02)
* a disputed answer cannot grade a submission that already started (R05)
* an older regrade cannot overwrite a newer one (R04)
* an active verification never serialises a score, and no parallel entry point
  can reveal its answer (R03)
* the project-scoped learning routes the frontend actually calls exist (R01)
* the delayed anchor includes the just-completed B attempt, and a future task
  cannot be started directly (R06)
* image import accepts a real browser multipart upload and reaches the vision
  provider when one is configured (R07)
* the tutor prompt carries the student's own work (R08)
"""

from __future__ import annotations

import io
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.analytics.services.reports import execute_regrade_run, request_regrade
from apps.learning.models import ReviewTask, StudyTask
from apps.learning.services import pairing as pairing_services
from apps.practice.models import Attempt, GradeEvent, SessionItem
from apps.practice.services import attempts as attempt_services
from apps.practice.services import sessions as session_services
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from tests.integration.test_learning_loop import answer_for, make_pairing
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db


def make_attempt(caller, project, subject, kind="single_choice", mode="practice", *, answer=None, key="reg-submit"):
    version = published(subject, kind)
    session = start_session(caller, project, subject, version.question, mode=mode)
    item_id = session["items"][0]["session_item_id"]
    present(caller, project, item_id)
    response = submit(
        caller, project, item_id, answer if answer is not None else answer_for(version), key=key
    )
    assert response.status_code == 200, response.content
    return version, session, SessionItem.objects.get(id=item_id), response.json()


# ---------------------------------------------------------------- R02 grading
def test_wrong_objective_answer_is_fully_graded_but_not_correct(caller, project_a, subject_a1):
    """A 0-score mistake is *graded*, not "unscored"."""
    version = published(subject_a1, "true_false")
    correct = answer_for(version)
    wrong = {"type": "true_false", "value": not correct["value"]}
    _v, _s, _i, result = make_attempt(
        caller, project_a, subject_a1, "true_false", answer=wrong, key="r02-wrong"
    )
    grade = result["grade"]
    assert grade["status"] == "confirmed"
    assert Decimal(grade["confirmed_score"]) == Decimal("0")
    assert Decimal(grade["pending_max_score"]) == Decimal("0")
    assert grade["is_fully_confirmed"] is True, "0 分作答已经评完，不是待评"
    assert grade["is_correct"] is False, "0 分不能被当成完全正确"


def test_all_manual_parts_confirmed_with_partial_score_is_final(caller, project_a, subject_a1):
    """8/10 with every criterion decided must not stay pending_review."""
    _v, _s, item, result = make_attempt(
        caller, project_a, subject_a1, "constructed_response", key="r02-manual"
    )
    criteria = item.rubric_version.criteria
    parts = [{"part_id": c["criterion_id"], "score": str(Decimal(c["max_score"]))} for c in criteria]
    parts[0]["score"] = "0"
    confirmed = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{result['attempt_id']}/confirm-grade",
        {
            "expected_grading_revision": result["grading_revision"],
            "answer_key_version_id": str(item.answer_key_version_id),
            "rubric_version_id": str(item.rubric_version_id),
            "parts": parts,
        },
        key="r02-manual-confirm",
    )
    assert confirmed.status_code == 200, confirmed.content
    body = confirmed.json()
    expected_total = sum(Decimal(str(c["max_score"])) for c in criteria) - Decimal(
        str(criteria[0]["max_score"])
    )
    assert Decimal(body["confirmed_score"]) == expected_total
    assert Decimal(body["pending_max_score"]) == 0, "失分不是未评分"
    assert body["status"] == "confirmed"
    assert body["is_fully_confirmed"] is True
    assert body["is_correct"] is False
    assert all(part["status"] == "confirmed" for part in body["parts"])


def test_rubric_partial_confirmation_keeps_only_undecided_value(caller, project_a, subject_a1):
    """A confirmed criterion that lost marks is a result, not unscored work."""
    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="r02-partial")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    # Add one *optional* criterion so "some parts decided, some not" is reachable
    # without violating the required-criteria rule (which is asserted below).
    from apps.question_bank.models import RubricVersion

    answer = AnswerKeyVersion.objects.get(question_version=version, is_disputed=False)
    criteria = [
        {"criterion_id": "c1", "text": "正确列出已知条件", "max_score": "2.00", "required": True},
        {"criterion_id": "c2", "text": "推导过程正确", "max_score": "3.00", "required": True},
        {"criterion_id": "c3", "text": "结论正确且单位完整", "max_score": "5.00", "required": True},
        {"criterion_id": "c4", "text": "书写规范（可选加分点，未评）", "max_score": "0.00", "required": False},
    ]
    RubricVersion.objects.filter(answer_key_version=answer).update(criteria=criteria, total_score=Decimal("10.00"))
    response = submit(
        caller,
        project_a,
        item_id,
        {"type": "constructed_response", "text": "部分确认测试"},
        key="r02-partial-submit",
    )
    body = response.json()
    # c4 is optional and undecided: 2 + 3 + 5 confirmed, c4 still pending.
    submitted = [
        {"part_id": "c1", "score": "2.00"},
        {"part_id": "c2", "score": "3.00"},
        {"part_id": "c3", "score": "5.00"},
    ]
    confirmed = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{body['attempt_id']}/confirm-grade",
        {"expected_grading_revision": body["grading_revision"], "parts": submitted},
        key="r02-partial-confirm",
    )
    assert confirmed.status_code == 200, confirmed.content
    result = confirmed.json()
    assert result["status"] == "pending_review"
    assert result["is_fully_confirmed"] is False
    assert Decimal(result["confirmed_score"]) == Decimal("10.00")
    assert Decimal(result["pending_max_score"]) == Decimal("0.00"), "已确认分项不产生待评分值"
    undecided = [part for part in result["parts"] if part["status"] != "confirmed"]
    assert [part["part_id"] for part in undecided] == ["c4"]


def test_required_rubric_criteria_cannot_be_left_unscored(caller, project_a, subject_a1):
    """A required criterion must be decided; partial submission is refused, not guessed."""
    _v, _s, item, result = make_attempt(
        caller, project_a, subject_a1, "constructed_response", key="r02-required"
    )
    criteria = item.rubric_version.criteria
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{result['attempt_id']}/confirm-grade",
        {
            "expected_grading_revision": result["grading_revision"],
            "parts": [{"part_id": criteria[0]["criterion_id"], "score": "0"}],
        },
        key="r02-required-confirm",
    )
    assert response.status_code == 400, response.content
    assert "必填" in response.json()["error"]["message"]


def test_zero_score_is_not_independent_correct_evidence(caller, project_a, subject_a1):
    from apps.learning.services.evidence import compute_dimensions

    version = published(subject_a1, "true_false")
    correct = answer_for(version)
    wrong = {"type": "true_false", "value": not correct["value"]}
    _v, _s, _i, result = make_attempt(
        caller, project_a, subject_a1, "true_false", answer=wrong, key="r02-evidence"
    )
    attempt = Attempt.objects.get(id=result["attempt_id"])
    row = next(x for x in compute_dimensions(attempt) if x["dimension"] == "independent_correct")
    assert Decimal(result["grade"]["confirmed_score"]) == 0
    assert row["qualifies"] is False and row["is_correct"] is False
    # The mistake is now visible as a *confirmed* lost mark, not as unscored work.
    from apps.practice.services.mistakes import mistake_rows

    rows = mistake_rows(user=project_a.owner, project=project_a)
    assert any(r["attempt_id"] == str(attempt.id) for r in rows)


def test_report_bucket_separates_completeness_from_perfection(caller, project_a, subject_a1):
    version = published(subject_a1, "true_false")
    correct = answer_for(version)
    wrong = {"type": "true_false", "value": not correct["value"]}
    make_attempt(caller, project_a, subject_a1, "true_false", answer=wrong, key="r02-report-wrong")
    report = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    totals = report["totals"]
    assert totals["fully_graded"]["attempts"] >= 1, "0 分错答属于已评完"
    assert totals["pending_review"]["attempts"] == 0
    assert Decimal(totals["fully_graded"]["pending_max_score"]) == 0
    assert totals["strict_independent"]["attempts"] == 0, "错答不构成严格独立正确"


# --------------------------------------------------------------- R05 dispute
def test_dispute_before_submit_must_not_use_disputed_key(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    answer = answer_for(version)
    session = start_session(caller, project_a, subject_a1, version.question)
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    key = AnswerKeyVersion.objects.get(question_version=version, is_disputed=False)
    content_services.dispute_answer_key_version(
        key, actor=project_a.owner, reason="review dispute before submit"
    )
    result = submit(caller, project_a, item_id, answer, key="r05-after-dispute")
    assert result.status_code == 200, result.content
    grade = result.json()["grade"]
    assert grade["status"] == "pending_review"
    assert grade["confirmed_score"] is None
    assert grade["is_fully_confirmed"] is False
    # The raw answer is preserved for the human reviewer.
    attempt = Attempt.objects.get(session_item_id=item_id)
    assert attempt.raw_answer == answer
    assert GradeEvent.objects.filter(attempt=attempt).count() == 1


def test_confirm_grade_refuses_a_disputed_rubric(caller, project_a, subject_a1):
    _v, _s, item, result = make_attempt(
        caller, project_a, subject_a1, "constructed_response", key="r05-cr"
    )
    from apps.question_bank.models import RubricVersion

    criteria = item.rubric_version.criteria
    parts = [{"part_id": c["criterion_id"], "score": str(Decimal(c["max_score"]))} for c in criteria]
    RubricVersion.objects.filter(id=item.rubric_version_id).update(is_disputed=True)
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{result['attempt_id']}/confirm-grade",
        {"expected_grading_revision": result["grading_revision"], "parts": parts},
        key="r05-cr-confirm",
    )
    assert response.status_code == 403, response.content


# --------------------------------------------------------------- R04 regrade
def test_older_regrade_late_completion_cannot_override_newer(caller, project_a, subject_a1):
    version, _s, item, result = make_attempt(caller, project_a, subject_a1, key="r04-base")
    original = item.answer_key_version
    good = original.answer_payload["correct_option_id"]
    bad = next(o["id"] for o in version.content["options"] if o["id"] != good)
    key2 = AnswerKeyVersion.objects.create(
        question_version=version,
        version=2,
        answer_payload={"correct_option_id": bad},
        verification_status="checked",
        checked_by=project_a.owner,
    )
    key3 = AnswerKeyVersion.objects.create(
        question_version=version,
        version=3,
        answer_payload={"correct_option_id": good},
        verification_status="checked",
        checked_by=project_a.owner,
    )
    old = request_regrade(
        question=version.question, target_answer_key_version=key2, actor=project_a.owner, reason="older target"
    )
    new = request_regrade(
        question=version.question, target_answer_key_version=key3, actor=project_a.owner, reason="newer target"
    )
    assert new.generation > old.generation, "重判请求必须有单调递增的 generation"

    # Execute the newer run first, then the older one: the newer result stands.
    execute_regrade_run(str(new.id))
    execute_regrade_run(str(old.id))

    attempt = Attempt.objects.get(id=result["attempt_id"])
    assert attempt.current_grade_event.answer_key_version_id == key3.id
    assert Decimal(attempt.current_grade_event.confirmed_score) == item.max_score
    old.refresh_from_db()
    assert old.stale_skipped_attempts >= 1, "旧任务必须被记为过期跳过，而不是静默覆盖"


def test_regrade_history_is_preserved_and_replay_is_idempotent(caller, project_a, subject_a1):
    version, _s, item, result = make_attempt(caller, project_a, subject_a1, key="r04-history")
    good = item.answer_key_version.answer_payload["correct_option_id"]
    bad = next(o["id"] for o in version.content["options"] if o["id"] != good)
    key2 = AnswerKeyVersion.objects.create(
        question_version=version,
        version=2,
        answer_payload={"correct_option_id": bad},
        verification_status="checked",
        checked_by=project_a.owner,
    )
    run = request_regrade(
        question=version.question, target_answer_key_version=key2, actor=project_a.owner, reason="single run"
    )
    execute_regrade_run(str(run.id))
    attempt = Attempt.objects.get(id=result["attempt_id"])
    first_revision = attempt.grading_revision
    revisions = set(
        GradeEvent.objects.filter(attempt=attempt).values_list("grading_revision", flat=True)
    )
    # The original event and its answer version are still on record.
    original_event = GradeEvent.objects.get(attempt=attempt, grading_revision=1)
    assert original_event.answer_key_version_id == item.answer_key_version_id
    assert original_event.is_superseded is True
    # Replaying the same run writes nothing new.
    execute_regrade_run(str(run.id))
    attempt.refresh_from_db()
    assert attempt.grading_revision == first_revision
    assert set(
        GradeEvent.objects.filter(attempt=attempt).values_list("grading_revision", flat=True)
    ) == revisions


# ------------------------------------------------------------ R03 verification
def test_active_verification_never_serializes_score(caller, project_a, subject_a1):
    _v, session, _i, result = make_attempt(
        caller, project_a, subject_a1, "true_false", mode="verification", key="r03-submit"
    )
    assert result["receipt_only"] is True and result["grade"] is None
    state = caller.get(
        f"/api/v1/projects/{project_a.id}/practice-sessions/{session['session_id']}"
    ).json()
    assert state["score_visible"] is False
    assert state.get("confirmed_score") is None, "活动验证不得在会话汇总里泄露分数"
    assert state.get("pending_max_score") is None
    assert state["items"][0]["attempt"]["grade"] is None

    attempt = caller.get(f"/api/v1/projects/{project_a.id}/attempts/{result['attempt_id']}").json()
    assert attempt["grade"] is None
    assert attempt["receipt_only"] is True

    report = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert report["totals"]["fully_graded"]["attempts"] == 0
    assert report["totals"]["pending_review"]["attempts"] == 0
    assert Decimal(report["totals"]["fully_graded"]["confirmed_score"]) == 0
    assert report["hidden_verification_attempts"] >= 1

    queue = caller.get(f"/api/v1/projects/{project_a.id}/grading-queue").json()
    assert all(row["attempt_id"] != result["attempt_id"] for row in queue), "评分队列不得泄露活动验证"

    evidence = caller.get(f"/api/v1/projects/{project_a.id}/evidence").json()
    assert all(
        row["attempt_id"] != result["attempt_id"] for row in evidence["rows"]
    ), "证据接口不得泄露活动验证"

    mistakes = caller.get(f"/api/v1/projects/{project_a.id}/mistakes").json()
    assert all(row["attempt_id"] != result["attempt_id"] for row in mistakes["rows"])


def test_confirm_grade_is_blocked_while_verification_is_active(caller, project_a, subject_a1):
    _v, _s, item, result = make_attempt(
        caller, project_a, subject_a1, "constructed_response", mode="verification", key="r03-cr"
    )
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{result['attempt_id']}/confirm-grade",
        {"expected_grading_revision": result["grading_revision"], "parts": []},
        key="r03-confirm",
    )
    assert response.status_code == 403, response.content


def test_parallel_practice_cannot_reveal_active_verification(caller, project_a, subject_a1):
    version = published(subject_a1, "true_false")
    verify = start_session(
        caller, project_a, subject_a1, version.question, mode="verification", key="r03-active"
    )
    present(caller, project_a, verify["items"][0]["session_item_id"])
    practice = start_session(
        caller, project_a, subject_a1, version.question, mode="practice", key="r03-parallel"
    )
    item_id = practice["items"][0]["session_item_id"]
    result = caller.post(f"/api/v1/projects/{project_a.id}/session-items/{item_id}/reveal")
    assert result.status_code == 403, result.content
    assert result.json()["error"]["code"] == "purpose_not_allowed"


def test_verification_gate_is_content_based_not_a_blanket_ban(
    caller, project_a, project_b, subject_a1, subject_b1
):
    """A running verification blocks its own content, not unrelated content."""
    from apps.question_bank.models import QuestionVersion

    version_a = published(subject_a1, "single_choice")
    verify = start_session(
        caller, project_a, subject_a1, version_a.question, mode="verification", key="r03-fam-active"
    )
    present(caller, project_a, verify["items"][0]["session_item_id"])
    # Unrelated content in the same project is still allowed to practise/reveal.
    other_version = (
        QuestionVersion.objects.filter(
            question__subject=subject_a1, question_type="single_choice", status="published"
        )
        .exclude(question_id=version_a.question_id)
        .first()
    )
    assert other_version is not None
    practice = start_session(
        caller, project_a, subject_a1, other_version.question, mode="practice", key="r03-other-parallel"
    )
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/session-items/{practice['items'][0]['session_item_id']}/reveal"
    )
    assert response.status_code == 200, "无关内容不应被验证门禁误伤"


def test_practice_reveal_still_works_when_nothing_is_in_verification(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="r03-plain")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    response = caller.post(f"/api/v1/projects/{project_a.id}/session-items/{item_id}/reveal")
    assert response.status_code == 200, response.content


# --------------------------------------------------------------- R01 routing
@pytest.mark.parametrize(
    "endpoint",
    [
        "learning-states",
        "evidence",
        "review-tasks",
        "mistakes",
    ],
)
def test_project_learning_routes_match_frontend(caller, project_a, endpoint):
    response = caller.get(f"/api/v1/projects/{project_a.id}/{endpoint}")
    assert response.status_code == 200, response.content


def test_project_learning_routes_require_the_owning_project(caller, other_caller, project_a):
    for endpoint in ("learning-states", "evidence", "review-tasks", "mistakes"):
        assert other_caller.get(f"/api/v1/projects/{project_a.id}/{endpoint}").status_code == 404


def test_project_scoped_plan_route_is_reachable(caller, project_a):
    plan = caller.post(
        "/api/v1/study-plans/today/generate", {"refresh": False}, key="r01-plan"
    ).json()["plan"]
    response = caller.get(f"/api/v1/projects/{project_a.id}/plans/{plan['plan_id']}")
    assert response.status_code == 200, response.content
    assert response.json()["plan"]["plan_id"] == plan["plan_id"]


def test_plan_route_rejects_a_project_the_user_does_not_own(other_caller, project_a):
    from apps.accounts.services.demo_fixture import load_demo_fixture

    load_demo_fixture("other@test.local")
    response = other_caller.get(f"/api/v1/projects/{project_a.id}/plans/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def test_evidence_route_accepts_subject_and_dimension_filters(caller, project_a, subject_a1):
    response = caller.get(
        f"/api/v1/projects/{project_a.id}/evidence",
        subject_id=str(subject_a1.id),
        dimension="repeat_practice",
    )
    assert response.status_code == 200
    assert all(row["dimension"] == "repeat_practice" for row in response.json()["rows"])


# ------------------------------------------------------------------ R06 delay
def test_pairing_c_waits_24h_from_b_submission(caller, project_a, subject_a1):
    pair, a, b, _c = make_pairing(subject_a1)
    t_b = timezone.now()
    t_a = t_b - timedelta(hours=25)

    session_a = session_services.create_session(
        user=project_a.owner, project=project_a, subject=subject_a1, question_ids=[str(a.question_id)]
    )
    item_a = session_a.items.get()
    session_services.presentation(item=item_a, user=project_a.owner, now=t_a - timedelta(minutes=1))
    attempt_services.submit_attempt(
        session_item_id=str(item_a.id), user=project_a.owner, raw_answer=answer_for(a), now=t_a
    )

    session_b = session_services.create_session(
        user=project_a.owner, project=project_a, subject=subject_a1, question_ids=[str(b.question_id)]
    )
    item_b = session_b.items.get()
    session_services.presentation(item=item_b, user=project_a.owner, now=t_b - timedelta(minutes=1))
    attempt_b, _grade = attempt_services.submit_attempt(
        session_item_id=str(item_b.id), user=project_a.owner, raw_answer=answer_for(b), now=t_b
    )
    pairing_services.on_attempt_graded(str(attempt_b.id))

    task = StudyTask.objects.get(
        pairing=pair, origin_session_item=item_b, task_kind="delayed_verification"
    )
    assert task.delay_anchor_at >= t_b, "锚点必须包含刚完成的 B 作答"
    assert task.not_before >= t_b + timedelta(hours=24)
    review = ReviewTask.objects.get(study_task=task)
    assert review.not_before == task.not_before


def test_delayed_task_cannot_be_started_before_its_deadline(caller, project_a, subject_a1):
    pair, _a, b, _c = make_pairing(subject_a1)
    session = start_session(caller, project_a, subject_a1, b.question, key="r06-b")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    submitted = submit(caller, project_a, item_id, answer_for(b), key="r06-b-submit")
    assert submitted.status_code == 200
    task = StudyTask.objects.get(
        pairing=pair, origin_session_item_id=item_id, task_kind="delayed_verification"
    )
    assert task.not_before > timezone.now() + timedelta(hours=23)

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": "verification", "subject_id": str(subject_a1.id), "task_id": str(task.id)},
        key="r06-bypass",
    )
    task.refresh_from_db()
    assert response.status_code in (400, 403, 409), response.content
    assert task.status == "pending", "未到期的任务不能被创建会话改写成进行中"


def test_task_purpose_fixes_verification_mode_server_side(caller, project_a, subject_a1):
    """A client cannot downgrade a delayed-verification task to plain practice."""
    pair, _a, b, _c = make_pairing(subject_a1)
    session = start_session(caller, project_a, subject_a1, b.question, key="r06-mode-b")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    submit(caller, project_a, item_id, answer_for(b), key="r06-mode-submit")
    task = StudyTask.objects.get(
        pairing=pair, origin_session_item_id=item_id, task_kind="delayed_verification"
    )
    # Make it due, then try to start it as practice.
    StudyTask.objects.filter(id=task.id).update(not_before=timezone.now() - timedelta(minutes=1))
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {
            "mode": "practice",
            "subject_id": str(subject_a1.id),
            "question_ids": [str(task.question_id)],
            "task_id": str(task.id),
        },
        key="r06-mode-downgrade",
    )
    assert response.status_code == 201, response.content
    assert response.json()["mode"] == "verification", "服务端必须按任务用途固定验证模式"


def test_delayed_purpose_cannot_be_forged_through_the_api(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {
            "mode": "verification",
            "subject_id": str(subject_a1.id),
            "question_ids": [str(version.question_id)],
            "purpose": "delayed_verification",
        },
        key="r06-forge-purpose",
    )
    assert response.status_code in (400, 403), response.content


# ---------------------------------------------------------------- R07 vision
def test_image_import_accepts_browser_multipart(caller, project_a, subject_a1, monkeypatch):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from PIL import Image

    from ai.providers import base as providers
    from apps.audit.models import LLMRun

    seen: list[str] = []
    provider = providers.StubProvider()
    original_call = provider.call

    def record(request):
        seen.append(request.capability)
        if request.capability == "extract_question":
            assert request.images, "视觉提取必须携带真实图片字节"
        return original_call(request)

    monkeypatch.setattr(provider, "call", record)
    providers.set_provider_override(provider)

    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(buffer, format="PNG")
    response = caller.client.post(
        f"/api/v1/projects/{project_a.id}/imports/images",
        data={
            "subject_id": str(subject_a1.id),
            "files": [SimpleUploadedFile("review.png", buffer.getvalue(), content_type="image/png")],
        },
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
        HTTP_IDEMPOTENCY_KEY="r07-vision-import",
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["input_kind"] == "image_ai", "配置了视觉能力时必须走提取链，而不是固定人工"
    assert "extract_question" in seen, "配置视觉 provider 后必须真正调用提取"
    assert LLMRun.objects.filter(capability="extract_question").count() >= 1


def test_image_import_falls_back_to_manual_without_a_vision_provider(caller, project_a, subject_a1):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from PIL import Image

    from ai.providers import base as providers

    providers.set_provider_override(providers.NullProvider())
    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(buffer, format="PNG")
    response = caller.client.post(
        f"/api/v1/projects/{project_a.id}/imports/images",
        data={
            "subject_id": str(subject_a1.id),
            "files": [SimpleUploadedFile("manual.png", buffer.getvalue(), content_type="image/png")],
        },
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
        HTTP_IDEMPOTENCY_KEY="r07-manual-import",
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["input_kind"] == "image_manual"
    assert body["candidate_count"] >= 1, "人工路径必须留下可校对的候选"
    from apps.ingestion.models import ImportJob

    job = ImportJob.objects.get(id=body["id"])
    candidate = job.candidates.first()
    assert candidate is not None and candidate.draft_payload.get("needs_manual_structure") is True
    # Nothing was invented on the model's behalf.
    assert candidate.machine_payload == {} or not candidate.machine_payload.get("extractor")


def test_image_service_invokes_configured_vision_provider(project_a, subject_a1, monkeypatch):
    from PIL import Image

    from ai.providers import base as providers
    from apps.audit.models import LLMRun
    from apps.ingestion.services.core import create_image_document
    from apps.ingestion.services.imports import start_image_import

    seen: list[str] = []
    provider = providers.StubProvider()
    original = provider.call

    def record(request):
        seen.append(request.capability)
        return original(request)

    monkeypatch.setattr(provider, "call", record)
    providers.set_provider_override(provider)

    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(buffer, format="PNG")
    document = create_image_document(
        owner=project_a.owner,
        project=project_a,
        content=buffer.getvalue(),
        content_type="image/png",
        subject=subject_a1,
    )
    job = start_image_import(
        owner=project_a.owner, project=project_a, documents=[document], subject=subject_a1
    )
    from apps.audit.services.outbox import after_commit_dispatch

    after_commit_dispatch()
    assert "extract_question" in seen
    assert job.input_kind == "image_ai"
    assert LLMRun.objects.filter(capability="extract_question").count() >= 1


# --------------------------------------------------------------- R08 tutoring
def test_personalized_prompt_contains_actual_answer_and_steps(caller, project_a, subject_a1):
    from apps.tutoring.services.core import build_prompt

    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="r08-session")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    raw_marker = "REVIEW_ORIGINAL_ANSWER_5_times_4_equals_20"
    step_marker = "REVIEW_STUDENT_STEP_counted_order_twice"
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/submit",
        {
            "answer": {"type": "constructed_response", "text": raw_marker},
            "steps": [{"text": step_marker}],
            "confidence": "unsure",
        },
        key="r08-submit",
    )
    assert response.status_code == 200, response.content
    prompt = build_prompt(item=SessionItem.objects.get(id=item_id))
    assert raw_marker in prompt, "prompt 必须包含学生自己的作答"
    assert step_marker in prompt, "prompt 必须包含学生的解题步骤"


def test_prompt_carries_rubric_and_math_and_material_context(caller, project_a, subject_a1):
    from apps.tutoring.services.core import build_prompt

    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="r08-ctx")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    submit(
        caller,
        project_a,
        item_id,
        {"type": "constructed_response", "text": "R08_RUBRIC_CONTEXT_MARKER"},
        key="r08-ctx-submit",
    )
    item = SessionItem.objects.get(id=item_id)
    prompt = build_prompt(item=item)
    for criterion in item.rubric_version.criteria:
        assert str(criterion.get("text", "")) in prompt, "评分标准必须进入 prompt"


def test_tutoring_is_refused_while_a_verification_is_active(caller, project_a, subject_a1):
    version = published(subject_a1, "constructed_response")
    session = start_session(
        caller, project_a, subject_a1, version.question, mode="verification", key="r08-verify"
    )
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": item_id, "purpose": "explanation"},
        key="r08-tutor",
    )
    assert response.status_code == 403, response.content


# ------------------------------------------------------------- R09 frontend
def test_submitted_item_can_still_be_revealed_by_attempt(caller, project_a, subject_a1):
    """The reload path uses the attempt id, not a stale presentation cache."""
    _v, _s, _i, result = make_attempt(caller, project_a, subject_a1, key="r09-submit")
    presentation = caller.get(
        f"/api/v1/projects/{project_a.id}/session-items/{result['session_item_id']}/presentation"
    )
    assert presentation.status_code == 200
    reveal = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{result['attempt_id']}/reveal"
    )
    assert reveal.status_code == 200, reveal.content
    assert reveal.json()["answer_payload"]


def test_get_attempt_returns_the_submitted_work_for_restore(caller, project_a, subject_a1):
    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="r09-restore")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    submit(
        caller,
        project_a,
        item_id,
        {"type": "constructed_response", "text": "R09_RESTORE_MARKER"},
        key="r09-restore-submit",
    )
    state = caller.get(
        f"/api/v1/projects/{project_a.id}/practice-sessions/{session['session_id']}"
    ).json()
    attempt_id = state["items"][0]["attempt"]["attempt_id"]
    attempt = caller.get(f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}").json()
    assert attempt["raw_answer"]["text"] == "R09_RESTORE_MARKER"
    assert attempt["session_item_id"] == item_id
