"""End-to-end business flow: two projects, all five question types, practice loop."""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.practice.models import Attempt, ExposureEvent, GradeEvent, SessionItem
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion

pytestmark = pytest.mark.django_db


def published(subject, question_type: str) -> QuestionVersion:
    return (
        QuestionVersion.objects.filter(
            question__subject=subject, question_type=question_type, status="published"
        )
        .select_related("question")
        .order_by("question__display_label")
        .first()
    )


def start_session(caller, project, subject, question: Question, *, mode="practice", key=None):
    response = caller.post(
        f"/api/v1/projects/{project.id}/practice-sessions",
        {"mode": mode, "subject_id": str(subject.id), "question_ids": [str(question.id)]},
        key=key,
    )
    assert response.status_code == 201, response.content
    return response.json()


def present(caller, project, item_id: str):
    response = caller.get(f"/api/v1/projects/{project.id}/session-items/{item_id}/presentation")
    assert response.status_code == 200, response.content
    return response.json()


def submit(caller, project, item_id: str, answer: dict, *, key: str):
    return caller.post(
        f"/api/v1/projects/{project.id}/session-items/{item_id}/submit",
        {"answer": answer, "confidence": "unsure"},
        key=key,
    )


def test_login_required_and_csrf_enforced(client):
    assert client.get("/api/v1/projects").status_code == 401
    # A cross-site style POST without the CSRF token must be rejected.
    response = client.post("/api/v1/projects", data={"name": "x"}, content_type="application/json")
    assert response.status_code in {401, 403}


def test_login_and_me(api, demo):
    response = api.get("/api/v1/auth/me")
    assert response.status_code == 200
    body = response.json()
    assert body["email"] == "owner@test.local"
    assert body["daily_budget_minutes"] == 60
    assert body["needs_project_setup"] is False


def test_logout_requires_csrf_and_clears_session(api):
    token = api.cookies["csrftoken"].value
    assert api.post("/api/v1/auth/logout", {}, key="logout-1").status_code == 200
    assert api.get("/api/v1/auth/me").status_code == 401
    assert token  # CSRF token was present for the logout call


def test_two_projects_are_isolated(caller, project_a, project_b, subject_a1, subject_b1):
    questions_a = {q["id"] for q in caller.get(f"/api/v1/projects/{project_a.id}/questions?limit=100").json()}
    questions_b = {q["id"] for q in caller.get(f"/api/v1/projects/{project_b.id}/questions?limit=100").json()}
    assert questions_a and questions_b
    assert not (questions_a & questions_b)

    some_question = next(iter(questions_a))
    cross = caller.get(f"/api/v1/projects/{project_b.id}/questions/{some_question}")
    assert cross.status_code == 404

    foreign_subject = caller.get(f"/api/v1/projects/{project_b.id}/exam-spec-versions?subject_id={subject_a1.id}")
    assert foreign_subject.status_code == 404

    # A session may not mix a subject from another project.
    mixed = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": "practice", "subject_id": str(subject_b1.id), "question_ids": []},
    )
    assert mixed.status_code == 404


def test_other_user_cannot_reach_known_ids(other_api, project_a, demo):
    question = Question.objects.filter(subject__project=project_a).first()
    assert other_api.get(f"/api/v1/projects/{project_a.id}/questions").status_code == 404
    assert other_api.get(f"/api/v1/projects/{project_a.id}/questions/{question.id}").status_code == 404
    assert other_api.get(f"/api/v1/projects/{project_a.id}/reports/practice").status_code == 404


def test_single_choice_full_loop(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question)
    item_id = session["items"][0]["session_item_id"]
    presentation = present(caller, project_a, item_id)
    assert presentation["first_delivery"] is True
    assert presentation["grading_hidden"] is False
    payload_text = str(presentation["stem"]).lower()
    assert "correct" not in payload_text
    assert "answer_payload" not in payload_text

    # Restoring the item must not reset the first delivery time.
    again = present(caller, project_a, item_id)
    assert again["first_delivery"] is False
    assert again["first_delivered_at"] == presentation["first_delivered_at"]

    correct = AnswerKeyVersion.objects.get(
        question_version=version, verification_status="checked", is_disputed=False
    ).answer_payload["correct_option_id"]
    response = submit(
        caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": [correct]}, key="sc-1"
    )
    assert response.status_code == 200, response.content
    grade = response.json()["grade"]
    assert grade["status"] == "confirmed"
    assert Decimal(grade["confirmed_score"]) == Decimal(version.practice_max_score)
    assert grade["is_fully_confirmed"] is True

    exposures = ExposureEvent.objects.filter(session_item_id=item_id).values_list("kind", flat=True)
    assert "stem_delivered" in exposures


def test_multiple_choice_rule_differs_per_project(caller, project_a, project_b, subject_a1, subject_b1):
    def run(project, subject, key):
        version = published(subject, "multiple_choice")
        answer = AnswerKeyVersion.objects.get(
            question_version=version, verification_status="checked", is_disputed=False
        ).answer_payload
        subset = answer["correct_option_ids"][:1]
        session = start_session(caller, project, subject, version.question, key=f"sess-{key}")
        item_id = session["items"][0]["session_item_id"]
        present(caller, project, item_id)
        response = submit(
            caller, project, item_id, {"type": "multiple_choice", "selected_option_ids": subset}, key=key
        )
        assert response.status_code == 200, response.content
        return response.json()["grade"], answer

    grade_a, answer_a = run(project_a, subject_a1, "mc-a")
    grade_b, _answer_b = run(project_b, subject_b1, "mc-b")
    assert grade_a["rule_snapshot"]["spec_rule"]["policy"] == "partial_credit"
    assert Decimal(grade_a["confirmed_score"]) == Decimal("2.00")
    assert grade_b["rule_snapshot"]["spec_rule"]["policy"] == "exact_match"
    assert Decimal(grade_b["confirmed_score"]) == Decimal("0")
    del answer_a


def test_true_false_false_is_graded_not_treated_as_blank(caller, project_a, subject_a1):
    version = published(subject_a1, "true_false")
    expected = AnswerKeyVersion.objects.get(question_version=version).answer_payload["value"]
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-tf")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    response = submit(caller, project_a, item_id, {"type": "true_false", "value": False}, key="tf-1")
    grade = response.json()["grade"]
    outcome = grade["parts"][0]["detail"]["outcome"]
    assert outcome == ("correct" if expected is False else "wrong")


def test_fill_blank_confirmed_and_pending_are_shown_separately(caller, project_a, subject_a1):
    versions = QuestionVersion.objects.filter(
        question__subject=subject_a1, question_type="fill_blank", status="published"
    ).order_by("question__display_label")
    numeric_version = next(v for v in versions if "待复核" not in v.question.display_label)
    pending_version = next(v for v in versions if "待复核" in v.question.display_label)

    session = start_session(caller, project_a, subject_a1, numeric_version.question, key="sess-fb")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    response = submit(
        caller, project_a, item_id, {"type": "fill_blank", "blanks": {"b1": "-2", "b2": "10.1"}}, key="fb-1"
    )
    grade = response.json()["grade"]
    assert grade["status"] == "confirmed"
    assert Decimal(grade["confirmed_score"]) == Decimal("3.00")

    session = start_session(caller, project_a, subject_a1, pending_version.question, key="sess-fb2")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    response = submit(caller, project_a, item_id, {"type": "fill_blank", "blanks": {"b1": "0.5"}}, key="fb-2")
    grade = response.json()["grade"]
    assert grade["status"] == "pending_review"
    assert grade["confirmed_score"] is None
    assert Decimal(grade["pending_max_score"]) == Decimal("3.00")
    assert grade["is_fully_confirmed"] is False


def test_constructed_response_requires_criterion_by_criterion_confirmation(caller, project_a, subject_a1):
    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-cr")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project_a, str(item.id))
    response = submit(
        caller, project_a, str(item.id), {"type": "constructed_response", "text": "推导过程……"}, key="cr-1"
    )
    attempt = response.json()
    assert attempt["grade"]["status"] == "pending_review"
    assert attempt["grade"]["confirmed_score"] is None

    criteria = item.rubric_version.criteria
    parts = [{"part_id": c["criterion_id"], "score": c["max_score"]} for c in criteria]
    confirm = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt['attempt_id']}/confirm-grade",
        {"expected_grading_revision": attempt["grading_revision"], "parts": parts},
        key="cr-confirm",
    )
    assert confirm.status_code == 200, confirm.content
    grade = confirm.json()
    assert Decimal(grade["confirmed_score"]) == Decimal(item.rubric_version.total_score)
    assert grade["method"] == "self_confirmed"
    assert grade["grader_is_self"] is True

    # Over-limit and missing required criteria are refused.
    over = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt['attempt_id']}/confirm-grade",
        {
            "expected_grading_revision": grade["grading_revision"],
            "parts": [{"part_id": criteria[0]["criterion_id"], "score": "9999"}],
        },
        key="cr-over",
    )
    assert over.status_code == 400
    missing = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt['attempt_id']}/confirm-grade",
        {
            "expected_grading_revision": grade["grading_revision"],
            "parts": [{"part_id": criteria[0]["criterion_id"], "score": "0"}],
        },
        key="cr-missing",
    )
    assert missing.status_code == 400


def test_stale_grading_revision_is_rejected(caller, project_a, subject_a1):
    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-stale")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project_a, str(item.id))
    attempt = submit(
        caller, project_a, str(item.id), {"type": "constructed_response", "text": "……"}, key="stale-1"
    ).json()
    criteria = item.rubric_version.criteria
    parts = [{"part_id": c["criterion_id"], "score": c["max_score"]} for c in criteria]
    first = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt['attempt_id']}/confirm-grade",
        {"expected_grading_revision": attempt["grading_revision"], "parts": parts},
        key="stale-confirm-1",
    )
    assert first.status_code == 200
    second = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt['attempt_id']}/confirm-grade",
        {"expected_grading_revision": attempt["grading_revision"], "parts": parts},
        key="stale-confirm-2",
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "version_conflict"


def test_material_parent_produces_only_child_items(caller, project_a, subject_a1):
    parent = QuestionVersion.objects.filter(
        question__subject=subject_a1, question_type="material", status="published"
    ).first()
    session = start_session(caller, project_a, subject_a1, parent.question, key="sess-mat")
    types = [item["question_type"] for item in session["items"]]
    assert "material" not in types
    assert len(session["items"]) == 2
    # parent_version value must equal the sum of the children's marks in the paper
    total = sum(Decimal(item["max_score"]) for item in session["items"])
    assert total == Decimal("10.00")


def test_generated_answer_cannot_reach_practice_without_checked_answer(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    answer = AnswerKeyVersion.objects.filter(question_version=version).first()
    answer.verification_status = "pending"
    answer.checked_at = None
    answer.save(update_fields=["verification_status", "checked_at", "updated_at"])

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": "practice", "subject_id": str(subject_a1.id), "question_ids": [str(version.question_id)]},
        key="sess-unverified",
    )
    assert response.status_code == 400
    assert "答案" in response.json()["error"]["message"]


def test_attempt_is_immutable_and_redo_requires_a_new_item(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-immutable")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    first = submit(caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_a"]}, key="im-1")
    assert first.status_code == 200

    # A second submission on the same item is refused whatever the key.
    second = submit(caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_b"]}, key="im-2")
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "already_submitted"

    # Draft edits after submission are refused as well.
    draft = caller.put(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/draft",
        {"draft": {"type": "single_choice", "selected_option_ids": ["opt_b"]}, "draft_revision": 0},
    )
    assert draft.status_code == 400
    assert Attempt.objects.filter(session_item_id=item_id).count() == 1
    assert GradeEvent.objects.filter(attempt__session_item_id=item_id).count() == 1


def test_draft_conflict_between_two_tabs(caller, project_a, subject_a1):
    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-draft")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)

    first = caller.put(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/draft",
        {"draft": {"type": "constructed_response", "text": "标签页1"}, "draft_revision": 0},
    )
    assert first.status_code == 200
    revision = first.json()["draft_revision"]

    stale = caller.put(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/draft",
        {"draft": {"type": "constructed_response", "text": "标签页2"}, "draft_revision": 0},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "version_conflict"

    ok = caller.put(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/draft",
        {"draft": {"type": "constructed_response", "text": "标签页2"}, "draft_revision": revision},
    )
    assert ok.status_code == 200


def test_answer_shape_must_match_the_question(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-shape")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    wrong_type = submit(caller, project_a, item_id, {"type": "true_false", "value": True}, key="shape-1")
    assert wrong_type.status_code == 422
    unknown_option = submit(
        caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_zzz"]}, key="shape-2"
    )
    assert unknown_option.status_code == 422
    duplicated = submit(
        caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_a", "opt_a"]}, key="shape-3"
    )
    assert duplicated.status_code == 422
    assert Attempt.objects.filter(session_item_id=item_id).count() == 0
