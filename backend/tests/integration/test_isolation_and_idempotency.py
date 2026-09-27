"""Idempotency, verification-mode isolation, exposure accounting and regrade."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.utils import timezone

from apps.practice.models import Attempt, ExposureEvent, GradeEvent, PracticeSession
from apps.question_bank.models import AnswerKeyVersion, QuestionVersion, VerificationStatus
from apps.question_bank.services import core as qb_services
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db


def test_submit_idempotency_same_key_replays_and_conflicts_otherwise(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-idem")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    body = {"type": "single_choice", "selected_option_ids": ["opt_a"]}

    first = submit(caller, project_a, item_id, body, key="idem-key")
    replay = submit(caller, project_a, item_id, body, key="idem-key")
    assert first.status_code == 200 and replay.status_code == 200
    assert first.json()["attempt_id"] == replay.json()["attempt_id"]
    assert Attempt.objects.filter(session_item_id=item_id).count() == 1
    assert GradeEvent.objects.filter(attempt__session_item_id=item_id).count() == 1

    conflicting = submit(
        caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_b"]}, key="idem-key"
    )
    assert conflicting.status_code == 409
    assert conflicting.json()["error"]["code"] == "idempotency_conflict"
    assert Attempt.objects.filter(session_item_id=item_id).count() == 1


def test_practice_session_creation_is_idempotent(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    payload = {"mode": "practice", "subject_id": str(subject_a1.id), "question_ids": [str(version.question_id)]}
    first = caller.post(f"/api/v1/projects/{project_a.id}/practice-sessions", payload, key="session-idem")
    second = caller.post(f"/api/v1/projects/{project_a.id}/practice-sessions", payload, key="session-idem")
    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["session_id"] == second.json()["session_id"]
    assert PracticeSession.objects.filter(project=project_a).count() == 1


def test_verification_hides_grading_and_blocks_every_parallel_entry(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, mode="verification", key="sess-verify")
    assert session["grading_hidden"] is True
    assert session["score_visible"] is False
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)

    attempt = submit(caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_a"]}, key="v-1")
    assert attempt.status_code == 200
    assert attempt.json()["receipt_only"] is True
    assert attempt.json()["grade"] is None

    attempt_id = attempt.json()["attempt_id"]
    detail = caller.get(f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}")
    assert detail.json()["grade"] is None

    tutor = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": item_id, "purpose": "explanation"},
        key="v-tutor",
    )
    assert tutor.status_code == 403
    reveal_item = caller.post(f"/api/v1/projects/{project_a.id}/session-items/{item_id}/reveal", key="v-reveal-item")
    assert reveal_item.status_code == 403
    reveal_attempt = caller.post(f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/reveal", key="v-reveal-attempt")
    assert reveal_attempt.status_code == 403

    session_view = caller.get(f"/api/v1/projects/{project_a.id}/practice-sessions/{session['session_id']}")
    assert session_view.json()["items"][0]["attempt"]["grade"] is None
    assert session_view.json()["items"][0]["attempt"]["receipt_only"] is True

    # An answer-bearing source file is refused while the run is open.
    from apps.ingestion.models import Asset

    asset = Asset.objects.create(
        owner=project_a.owner,
        project=project_a,
        role="answer_page",
        sensitivity="contains_answers",
        object_key="owner/answer-page",
        content_type="image/png",
        size_bytes=10,
        checksum="x" * 64,
        uploaded_by=project_a.owner,
    )
    blocked = caller.get(f"/api/v1/projects/{project_a.id}/assets/{asset.id}")
    assert blocked.status_code == 403

    finish = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions/{session['session_id']}/finish", {}, key="v-finish"
    )
    assert finish.status_code == 200
    finished = finish.json()
    assert finished["score_visible"] is True
    assert finished["items"][0]["attempt"]["grade"] is not None
    assert finished["items"][0]["attempt"]["grade"]["status"] == "confirmed"

    # Disclosure is allowed now, and it is recorded as an answer exposure.
    after = caller.post(f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/reveal", key="v-reveal-after")
    assert after.status_code == 200
    assert after.json()["answer_payload"]
    assert ExposureEvent.objects.filter(session_item_id=item_id, reveals_answer=True).exists()


def test_pre_submit_help_in_practice_blocks_strict_independent_evidence(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    correct = AnswerKeyVersion.objects.get(question_version=version).answer_payload["correct_option_id"]
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-assist")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)

    reveal = caller.post(f"/api/v1/projects/{project_a.id}/session-items/{item_id}/reveal", key="assist-reveal")
    assert reveal.status_code == 200
    assert reveal.json()["exposure_recorded"] is True
    assert reveal.json()["answer_payload"]

    # A hint delivered through the tutor also counts as assistance.
    from ai.providers import base as providers

    providers.set_provider_override(providers.StubProvider())
    tutor = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": item_id, "purpose": "hint"},
        key="assist-tutor",
    )
    assert tutor.status_code == 201
    message = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions/{tutor.json()['tutor_session_id']}/messages",
        {"user_question": "提示一下"},
        key="assist-message",
    )
    assert message.status_code == 201
    assert message.json()["status"] == "succeeded"
    assert message.json()["is_stub"] is True

    attempt = submit(
        caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": [correct]}, key="assist-submit"
    )
    assert attempt.status_code == 200
    grade = attempt.json()["grade"]
    assert grade["status"] == "confirmed"
    assert Decimal(grade["confirmed_score"]) == Decimal(version.practice_max_score)

    from apps.learning.services import evidence as evidence_service

    rows = evidence_service.evidence_summary_rows(user=project_a.owner, project=project_a)
    independent = [row for row in rows if row["dimension"] == "independent_correct" and row["attempt_id"] == attempt.json()["attempt_id"]]
    assert independent and independent[0]["qualifies"] is False
    assert any("辅助" in reason for reason in independent[0]["exclusion_reasons"])

    repeat = [row for row in rows if row["dimension"] == "repeat_practice" and row["attempt_id"] == attempt.json()["attempt_id"]]
    assert repeat and repeat[0]["qualifies"] is True


def test_self_confirmed_grade_never_counts_as_independent(caller, project_a, subject_a1):
    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-self")
    from apps.practice.models import SessionItem

    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project_a, str(item.id))
    attempt = submit(
        caller, project_a, str(item.id), {"type": "constructed_response", "text": "……"}, key="self-submit"
    ).json()
    criteria = item.rubric_version.criteria
    grade = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt['attempt_id']}/confirm-grade",
        {
            "expected_grading_revision": attempt["grading_revision"],
            "parts": [{"part_id": c["criterion_id"], "score": c["max_score"]} for c in criteria],
        },
        key="self-confirm",
    ).json()
    assert grade["method"] == "self_confirmed"

    from apps.learning.services import evidence as evidence_service

    rows = evidence_service.evidence_summary_rows(user=project_a.owner, project=project_a)
    independent = [
        row for row in rows if row["dimension"] == "independent_correct" and row["attempt_id"] == attempt["attempt_id"]
    ]
    assert independent and independent[0]["qualifies"] is False
    assert any("自评" in reason for reason in independent[0]["exclusion_reasons"])


def test_admin_grading_own_attempt_is_self_confirmed(caller, project_a, subject_a1, owner):
    owner.is_staff = True
    owner.save(update_fields=["is_staff"])
    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-admin-self")
    from apps.practice.models import SessionItem

    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project_a, str(item.id))
    attempt = submit(
        caller, project_a, str(item.id), {"type": "constructed_response", "text": "……"}, key="admin-self-submit"
    ).json()
    criteria = item.rubric_version.criteria
    grade = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt['attempt_id']}/confirm-grade",
        {
            "expected_grading_revision": attempt["grading_revision"],
            "parts": [{"part_id": c["criterion_id"], "score": c["max_score"]} for c in criteria],
        },
        key="admin-self-confirm",
    ).json()
    assert grade["method"] == "self_confirmed"
    assert grade["grader_is_self"] is True


def test_disputed_answer_sends_history_to_review_and_keeps_raw_answer(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    answer = AnswerKeyVersion.objects.get(question_version=version, is_disputed=False)
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-dispute")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    attempt = submit(
        caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_a"]}, key="dispute-submit"
    ).json()
    assert attempt["grade"]["status"] == "confirmed"

    qb_services.dispute_answer_key_version(answer, actor=project_a.owner, reason="标准答案有争议，需重新核对")

    refreshed = Attempt.objects.get(id=attempt["attempt_id"])
    assert refreshed.raw_answer == {"type": "single_choice", "selected_option_ids": ["opt_a"]}
    assert refreshed.current_grade_event.status == "pending_review"
    assert refreshed.current_grade_event.supersedes_id is not None
    original = GradeEvent.objects.get(attempt=refreshed, grading_revision=1)
    assert original.status == "confirmed"
    assert original.is_superseded is True


def test_regrade_creates_a_new_event_without_touching_history(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-regrade")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    attempt = submit(
        caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_b"]}, key="regrade-submit"
    ).json()
    assert attempt["grade"]["parts"][0]["detail"]["outcome"] == "wrong"

    # A reviewed corrected answer: opt_b becomes correct.
    corrected = qb_services.create_answer_key_version(
        version,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_b"},
        actor=project_a.owner,
        verification_status=VerificationStatus.CHECKED,
        check_basis="与来源第 12 题核对后修正",
    )
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/regrades",
        {
            "question_id": str(version.question_id),
            "target_answer_key_version_id": str(corrected.id),
            "reason": "标准答案修正为 opt_b",
        },
        key="regrade-create",
    )
    assert response.status_code == 201, response.content
    run_id = response.json()["regrade_run_id"]
    executed = caller.post(f"/api/v1/projects/{project_a.id}/regrades/{run_id}/run", {}, key="regrade-run")
    assert executed.status_code == 200
    assert executed.json()["regraded_attempts"] == 1

    refreshed = Attempt.objects.get(id=attempt["attempt_id"])
    assert refreshed.current_grade_event.kind == "regrade"
    assert refreshed.current_grade_event.confirmed_score == Decimal(version.practice_max_score)
    initial = GradeEvent.objects.get(attempt=refreshed, grading_revision=1)
    assert initial.is_superseded is True
    assert initial.confirmed_score == Decimal("0.00") or initial.confirmed_score == Decimal("0")

    # The regrade is executed idempotently and never double counts evidence.
    again = caller.post(f"/api/v1/projects/{project_a.id}/regrades/{run_id}/run", {}, key="regrade-run-again")
    assert again.status_code == 200
    assert GradeEvent.objects.filter(attempt=refreshed).count() == 2


def test_import_job_retry_and_duplicate_detection(caller, project_a, subject_a1):
    text = """【题型】单选题
【题干】演示重复导入题：正确选项是？
【选项】
A. 甲
B. 乙
【答案】A
"""
    first = caller.post(
        f"/api/v1/projects/{project_a.id}/imports",
        {"text": text, "subject_id": str(subject_a1.id), "title": "第一次"},
        key="import-1",
    )
    assert first.status_code == 201, first.content
    job = first.json()
    assert job["candidate_count"] == 1

    second = caller.post(
        f"/api/v1/projects/{project_a.id}/imports",
        {"text": text, "subject_id": str(subject_a1.id), "title": "第二次"},
        key="import-2",
    )
    assert second.status_code == 201
    assert second.json()["duplicate_of_job_id"] == job["id"]
    assert any(problem["code"] == "duplicate_input" for problem in second.json()["problems"])

    candidates = caller.get(f"/api/v1/projects/{project_a.id}/import-candidates?job_id={job['id']}").json()
    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate["status"] == "ready"
    spec = subject_a1.exam_spec_versions.filter(status="published").order_by("-version").first()
    publish = caller.post(
        f"/api/v1/projects/{project_a.id}/import-candidates/{candidate['id']}/publish",
        {"node_ids": [], "origin_type": "user_authored", "exam_spec_version_id": str(spec.id)},
        key="import-publish",
    )
    assert publish.status_code == 200, publish.content
    assert publish.json()["publication_question_id"]

    replay = caller.post(
        f"/api/v1/projects/{project_a.id}/import-candidates/{candidate['id']}/publish",
        {"node_ids": [], "origin_type": "user_authored", "exam_spec_version_id": str(spec.id)},
        key="import-publish",
    )
    assert replay.status_code == 200
    assert replay.json()["publication_question_id"] == publish.json()["publication_question_id"]
    # Re-publishing must not create a second question for the same candidate.
    from apps.question_bank.models import Question

    assert Question.objects.filter(display_label="演示重复导入题：正确选项是？").count() <= 1


def test_import_candidate_cannot_publish_with_blocking_problems(caller, project_a, subject_a1):
    text = """【题型】单选题
【题干】缺少选项的题
【答案】A
"""
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/imports",
        {"text": text, "subject_id": str(subject_a1.id)},
        key="import-blocking",
    )
    job = response.json()
    candidates = caller.get(f"/api/v1/projects/{project_a.id}/import-candidates?job_id={job['id']}").json()
    blocking = [issue for issue in candidates[0]["review_issues"] if issue["severity"] == "blocking"]
    assert blocking
    publish = caller.post(
        f"/api/v1/projects/{project_a.id}/import-candidates/{candidates[0]['id']}/publish",
        {"node_ids": []},
        key="import-blocking-publish",
    )
    assert publish.status_code == 422
    assert publish.json()["error"]["code"] == "structure_invalid"


def test_published_version_is_not_editable_in_place(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    patch = caller.patch(
        f"/api/v1/projects/{project_a.id}/question-versions/{version.id}",
        {
            "question_type": version.question_type,
            "content": {"blocks": [{"kind": "text", "text": "试图原地修改已发布正文"}]},
        },
    )
    assert patch.status_code == 400
    version.refresh_from_db()
    assert version.content["blocks"][0]["text"] != "试图原地修改已发布正文"

    # Creating a new draft revision is the supported path.
    revision = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{version.question_id}/revisions",
        {"question_type": version.question_type, "content": version.content, "revision_reason": "修订"},
        key="revision-create",
    )
    assert revision.status_code == 201
    assert revision.json()["status"] == "draft"
    assert revision.json()["version"] == version.version + 1


def test_same_paper_reupload_does_not_double_count(caller, project_a, subject_a1):
    from apps.exams.models import Paper, PaperItem

    paper_count = Paper.objects.filter(subject=subject_a1).count()
    item_count = PaperItem.objects.count()
    for key in ("paper-1", "paper-2"):
        response = caller.post(
            f"/api/v1/projects/{project_a.id}/papers",
            {
                "subject_id": str(subject_a1.id),
                "cycle_key": "2024",
                "session_key": "上半年",
                "paper_code": "卷一",
                "source_kind": "demo",
            },
            key=key,
        )
        assert response.status_code in {200, 201}, response.content
    assert Paper.objects.filter(subject=subject_a1).count() == paper_count + 1
    assert PaperItem.objects.count() == item_count


def test_archived_project_refuses_new_work_but_keeps_history(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-archive")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    submit(caller, project_a, item_id, {"type": "single_choice", "selected_option_ids": ["opt_a"]}, key="archive-submit")

    blocked = caller.post(
        f"/api/v1/projects/{project_a.id}/archive", {"reason": "test"}, key="archive-1"
    )
    assert blocked.status_code == 400
    assert "进行中" in blocked.json()["error"]["message"]

    caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions/{session['session_id']}/finish", {}, key="archive-finish"
    )
    archived = caller.post(f"/api/v1/projects/{project_a.id}/archive", {"reason": "备考结束"}, key="archive-2")
    assert archived.status_code == 200
    assert archived.json()["is_archived"] is True

    new_session = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": "practice", "subject_id": str(subject_a1.id), "question_ids": [str(version.question_id)]},
        key="archive-new-session",
    )
    assert new_session.status_code == 400
    # History stays readable.
    assert caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").status_code == 200


def test_server_time_not_client_time_decides_elapsed(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="sess-clock")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)

    from apps.practice.models import SessionItem

    item = SessionItem.objects.get(id=item_id)
    item.first_delivered_at = timezone.now() - timezone.timedelta(seconds=42)
    item.save(update_fields=["first_delivered_at", "updated_at"])
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/submit",
        {
            "answer": {"type": "single_choice", "selected_option_ids": ["opt_a"]},
            "client_active_ms": 999_999_999,
        },
        key="clock-1",
    )
    assert response.status_code == 200
    attempt = Attempt.objects.get(session_item_id=item_id)
    assert 40_000 <= attempt.elapsed_ms <= 60_000
    assert attempt.client_active_ms == 999_999_999
