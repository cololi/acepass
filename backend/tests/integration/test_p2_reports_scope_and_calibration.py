"""P2 batch 3 acceptance: C06 (no fake final numbers) and C08 (calibration limits).

C06 — 大题未评分和争议题存在时报告显示未完成范围，不能输出虚假最终排名/通过率.

The report must keep showing numbers, but never as *final* ones while an
unscored, disputed, partially confirmed, invalidated, voided or AI-estimated
result is in scope. Both directions are asserted: with unresolved work
``incomplete_scope`` lists it and ``final_result`` is ``None``; after everything
is confirmed the block empties and ``final_result`` appears.

C08 — 学习效果对比按题型、难度、时限、暴露情况说明可比性和样本数；不从单人前后分数推断因果.

The calibration report groups attempts by type, difficulty proxy, server-measured
time condition and exposure state, withholds statistics below
``MIN_GROUP_SAMPLE``, names the groups that cannot be compared, and is asserted
to contain no causal/summary key anywhere in its serialized shape.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from apps.analytics.services import calibration as calibration_service
from apps.common.enums import GradeEventKind, GradeMethod, GradeStatus, VerificationStatus
from apps.practice.models import Attempt, GradeEvent, LearningEvidence, SessionItem
from apps.practice.services import attempts as attempt_services
from apps.question_bank.models import AnswerKeyVersion, QuestionVersion
from apps.question_bank.services import core as content_services
from tests.integration.test_learning_loop import answer_for
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db

#: Keys that would turn a within-person observation into a claim the data cannot
#: support. The service refuses to emit them (see
#: ``calibration.assert_no_causal_summary``); this test asserts the same thing
#: from the outside, on the serialized payload.
FORBIDDEN_PAYLOAD_KEYS = frozenset(
    {
        "improvement",
        "improvement_percent",
        "improvement_rate",
        "gain",
        "score_gain",
        "pass_probability",
        "pass_rate",
        "rank",
        "overall_delta",
        "total_delta",
        "causal_effect",
        "final_score_rate",
        "overall_score_rate",
        "final_percentage",
    }
)


def all_keys(value) -> set[str]:
    """Every dict key in a nested payload, at any depth."""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            found.add(key)
            found |= all_keys(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            found |= all_keys(child)
    return found


def deltas(value) -> list[dict]:
    """Every delta body in a nested payload (each must state n, spread and caveats)."""
    found: list[dict] = []
    if isinstance(value, dict):
        if "delta" in value:
            found.append(value["delta"] if isinstance(value["delta"], dict) else value)
        for child in value.values():
            found.extend(deltas(child))
    elif isinstance(value, (list, tuple)):
        for child in value:
            found.extend(deltas(child))
    return found


def practice_report(caller, project, **params) -> dict:
    response = caller.get(f"/api/v1/projects/{project.id}/reports/practice", **params)
    assert response.status_code == 200, response.content
    return response.json()


def calibration_report(caller, project, **params) -> dict:
    response = caller.get(f"/api/v1/projects/{project.id}/reports/calibration", **params)
    assert response.status_code == 200, response.content
    return response.json()


def coverage_report(caller, project, subject) -> dict:
    response = caller.get(
        f"/api/v1/projects/{project.id}/papers/coverage", subject_id=str(subject.id)
    )
    assert response.status_code == 200, response.content
    return response.json()


def second_published(subject, question_type: str) -> QuestionVersion:
    return (
        QuestionVersion.objects.filter(
            question__subject=subject, question_type=question_type, status="published"
        )
        .select_related("question")
        .order_by("question__display_label")[1]
    )


def make_attempt(caller, project, subject, version, *, key, answer=None, mode="practice") -> dict:
    """Present, answer and submit one item; returns the submission payload."""
    session = start_session(caller, project, subject, version.question, mode=mode, key=f"{key}-session")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project, item_id)
    response = submit(
        caller, project, item_id, answer if answer is not None else answer_for(version), key=f"{key}-submit"
    )
    assert response.status_code == 200, response.content
    return response.json()


def reason_codes(scope: dict) -> set[str]:
    return {row["code"] for row in scope["reasons"]}


def pin_elapsed_time(project, *, elapsed_ms: int = 1000) -> None:
    """Give every attempt of the project a deterministic server-measured elapsed time.

    ``elapsed_ms`` is the server's own measurement between first delivery and
    submission; the test pins it so the time-condition dimension (and with it the
    grouping) cannot depend on how fast the test client happens to be.
    """
    Attempt.objects.filter(project=project).update(elapsed_ms=elapsed_ms)


def publish_extra_single_choice(subject, index: int, *, max_score: str = "2.00") -> QuestionVersion:
    """A real published single-choice question, for building 5-sample groups.

    The demo subject only carries two questions per type, which is below the
    calibration threshold on purpose; groups that reach the threshold are built
    from genuinely published content created through the normal services.
    """
    owner = subject.project.owner
    question = content_services.create_question(
        subject=subject,
        origin_type="user_authored",
        actor=owner,
        display_label=f"C08 校准-单选-{index}",
    )
    version = content_services.create_question_version_draft(
        question,
        question_type="single_choice",
        content={
            "blocks": [{"kind": "text", "text": f"C08 校准题 {index}：下列哪一项正确？"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        },
        actor=owner,
        practice_max_score=Decimal(max_score),
        revision_reason="C08 校准测试夹具",
    )
    content_services.create_answer_key_version(
        version,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
        actor=owner,
        source_type="user",
        verification_status="checked",
        check_basis="C08 校准测试：人工核对",
    )
    return content_services.publish_question_version(version, actor=owner)


# ---------------------------------------------------------------------- C06
def test_unscored_constructed_response_is_listed_and_final_result_is_suppressed(
    caller, project_a, subject_a1
):
    """An unscored 大题: scope names it, no final rate appears; after confirm, it does."""
    version = published(subject_a1, "constructed_response")
    body = make_attempt(caller, project_a, subject_a1, version, key="c06-cr")
    attempt_id = body["attempt_id"]
    assert body["grade"]["status"] == "pending_review"
    assert body["grade"]["confirmed_score"] is None

    report = practice_report(caller, project_a)
    assert report["result_status"] == "incomplete"
    scope = report["incomplete_scope"]
    assert scope["is_incomplete"] is True
    assert scope["attempts_in_scope"] == 1
    assert scope["incomplete_attempts"] == 1
    assert "pending_review" in reason_codes(scope)
    pending_row = next(row for row in scope["reasons"] if row["code"] == "pending_review")
    assert pending_row["attempt_count"] == 1
    assert attempt_id in pending_row["attempt_ids"]
    assert attempt_id in scope["attempt_ids"]
    assert pending_row["session_item_ids"]
    assert str(version.question_id) in pending_row["question_ids"]
    assert scope["missing_note"] and "待人工评分" in scope["missing_note"]

    # No fake final result: the field is null and the aggregate is labelled.
    assert report["final_result"] is None
    assert report["aggregate"]["status"] == "partial_lower_bound"
    assert report["aggregate"]["score_rate"] is None
    assert report["aggregate"]["label"].startswith("未完成")
    assert Decimal(report["aggregate"]["unresolved_max_score"]) == Decimal("10.00")
    assert report["aggregate"]["missing"]["unresolved_attempts"] == 1
    # The number is still available, explicitly as a lower bound.
    assert report["aggregate"]["lower_bound"] == "0.0000"
    assert report["totals"]["pending_review"]["is_final"] is False
    assert report["totals"]["pending_review"]["fraction_status"] == "partial_lower_bound"

    keys = all_keys(report)
    assert not (keys & FORBIDDEN_PAYLOAD_KEYS), sorted(keys & FORBIDDEN_PAYLOAD_KEYS)
    assert "pass_rate" not in keys and "rank" not in keys

    # Every rubric part confirmed -> scope empties and the final result appears.
    item = SessionItem.objects.get(id=pending_row["session_item_ids"][0])
    parts = [
        {"part_id": criterion["criterion_id"], "score": str(Decimal(criterion["max_score"]))}
        for criterion in item.rubric_version.criteria
    ]
    confirmed = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt_id}/confirm-grade",
        {"expected_grading_revision": body["grading_revision"], "parts": parts},
        key="c06-cr-confirm",
    )
    assert confirmed.status_code == 200, confirmed.content
    assert confirmed.json()["is_fully_confirmed"] is True

    after = practice_report(caller, project_a)
    assert after["result_status"] == "final"
    assert after["incomplete_scope"]["is_incomplete"] is False
    assert after["incomplete_scope"]["incomplete_attempts"] == 0
    assert after["incomplete_scope"]["reasons"] == []
    assert after["incomplete_scope"]["missing_note"] is None
    assert after["final_result"] is not None
    assert after["final_result"]["score_rate"] == "1.0000"
    assert after["final_result"]["attempts"] == 1
    assert after["aggregate"]["status"] == "final"
    assert after["aggregate"]["score_rate"] == "1.0000"
    assert after["aggregate"]["missing"] is None
    # The owner's own confirmation is self-assessed: disclosed, not hidden.
    assert after["totals"]["self_assessed"]["attempts"] == 1
    assert after["final_result"]["includes_self_assessed_attempts"] == 1


def test_disputed_answer_void_and_invalidated_grades_each_have_their_own_reason(
    caller, project_a, subject_a1
):
    """A disputed key and an invalidated/voided grade are unresolved, each for its own reason."""
    # 1. A graded attempt whose answer key is then disputed (the R05 service path).
    version = published(subject_a1, "true_false")
    disputed_attempt = make_attempt(caller, project_a, subject_a1, version, key="c06-dispute")["attempt_id"]
    answer = AnswerKeyVersion.objects.get(question_version=version, is_disputed=False)
    content_services.dispute_answer_key_version(answer, actor=project_a.owner, reason="C06 验收：答案争议")
    answer.refresh_from_db()
    assert answer.verification_status == VerificationStatus.DISPUTED

    # 2. A grade withdrawn by the real refusal path (regrade target turned out disputed).
    other = second_published(subject_a1, "true_false")
    invalidated_attempt = make_attempt(caller, project_a, subject_a1, other, key="c06-invalidate")["attempt_id"]
    attempt = Attempt.objects.get(id=invalidated_attempt)
    invalidated, _stale = attempt_services.invalidate_for_untrusted_regrade_target(
        attempts=[attempt], actor=project_a.owner, reason="重判目标进入争议", refused_generation=None
    )
    assert invalidated >= 1
    attempt.refresh_from_db()
    assert attempt.current_grade_event.kind == GradeEventKind.INVALIDATION

    # 3. A voided grade. No current service writes ``void`` (the enum is the
    # contract), so the row an operator/manual void would produce is written here.
    third = published(subject_a1, "single_choice")
    voided_attempt = make_attempt(caller, project_a, subject_a1, third, key="c06-void")["attempt_id"]
    attempt = Attempt.objects.get(id=voided_attempt)
    previous = attempt.current_grade_event
    void = GradeEvent.objects.create(
        attempt=attempt,
        kind=GradeEventKind.MANUAL_CONFIRMATION,
        status=GradeStatus.VOID,
        method=previous.method,
        grading_revision=previous.grading_revision + 1,
        confirmed_score=None,
        max_score=previous.max_score,
        pending_max_score=previous.max_score,
        is_fully_confirmed=False,
        answer_key_version_id=previous.answer_key_version_id,
        comment="C06 验收：判分作废",
    )
    attempt.current_grade_event = void
    attempt.grading_revision = void.grading_revision
    attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])

    report = practice_report(caller, project_a)
    scope = report["incomplete_scope"]
    codes = reason_codes(scope)
    assert {"disputed_content", "invalidated_grade", "void_grade"} <= codes, codes
    by_code = {row["code"]: row for row in scope["reasons"]}
    assert disputed_attempt in by_code["disputed_content"]["attempt_ids"]
    assert "争议" in by_code["disputed_content"]["message"]
    assert invalidated_attempt in by_code["invalidated_grade"]["attempt_ids"]
    assert "失效" in by_code["invalidated_grade"]["message"]
    assert voided_attempt in by_code["void_grade"]["attempt_ids"]
    assert "作废" in by_code["void_grade"]["message"]
    assert scope["incomplete_attempts"] == 3
    assert report["result_status"] == "incomplete"
    assert report["final_result"] is None
    assert report["aggregate"]["score_rate"] is None


def test_partially_confirmed_rubric_and_ai_estimate_are_both_incomplete(caller, project_a, subject_a1):
    """A half-decided rubric and an AI-only estimate are unresolved for their own reasons."""
    from apps.question_bank.models import RubricVersion

    version = published(subject_a1, "constructed_response")
    session = start_session(caller, project_a, subject_a1, version.question, key="c06-partial-session")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    # One optional criterion stays undecided, so the event is pending overall
    # while the three required criteria are confirmed (the R02 shape).
    answer = AnswerKeyVersion.objects.get(question_version=version, is_disputed=False)
    RubricVersion.objects.filter(answer_key_version=answer).update(
        criteria=[
            {"criterion_id": "c1", "text": "条件", "max_score": "2.00", "required": True},
            {"criterion_id": "c2", "text": "推导", "max_score": "3.00", "required": True},
            {"criterion_id": "c3", "text": "结论", "max_score": "5.00", "required": True},
            {"criterion_id": "c4", "text": "书写（可选，未评）", "max_score": "0.00", "required": False},
        ],
        total_score=Decimal("10.00"),
    )
    submitted = submit(caller, project_a, item_id, answer_for(version), key="c06-partial-submit")
    assert submitted.status_code == 200, submitted.content
    body = submitted.json()
    confirmed = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{body['attempt_id']}/confirm-grade",
        {
            "expected_grading_revision": body["grading_revision"],
            "parts": [
                {"part_id": "c1", "score": "2.00"},
                {"part_id": "c2", "score": "3.00"},
                {"part_id": "c3", "score": "5.00"},
            ],
        },
        key="c06-partial-confirm",
    )
    assert confirmed.status_code == 200, confirmed.content
    assert confirmed.json()["status"] == "pending_review"
    assert confirmed.json()["is_fully_confirmed"] is False
    assert Decimal(confirmed.json()["confirmed_score"]) == Decimal("10.00")

    # A second attempt whose only score is an AI estimate. No estimator provider
    # is configured here, so the inert event the estimator writes is created
    # directly; it is exactly the contract of estimation._write_estimate
    # (estimated_score only, confirmed_score stays None, never fully confirmed).
    second = make_attempt(caller, project_a, subject_a1, version, key="c06-estimate")
    attempt = Attempt.objects.get(id=second["attempt_id"])
    previous = Attempt.objects.get(id=body["attempt_id"]).current_grade_event
    estimate = GradeEvent.objects.create(
        attempt=attempt,
        kind=GradeEventKind.AI_ESTIMATE,
        status=GradeStatus.ESTIMATED,
        method=GradeMethod.AI_ESTIMATED,
        grading_revision=previous.grading_revision + 1,
        estimated_score=Decimal("4.00"),
        confirmed_score=None,
        max_score=previous.max_score,
        pending_max_score=previous.max_score,
        is_fully_confirmed=False,
        parts=[{"part_id": "c1", "status": GradeStatus.ESTIMATED, "score": "4.00", "max_score": "10.00"}],
        answer_key_version_id=previous.answer_key_version_id,
        rubric_version_id=previous.rubric_version_id,
        spec_version_id=previous.spec_version_id,
        comment="C06 验收：仅 AI 估计",
    )
    attempt.current_grade_event = estimate
    attempt.grading_revision = estimate.grading_revision
    attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])

    report = practice_report(caller, project_a)
    codes = reason_codes(report["incomplete_scope"])
    assert {"partially_confirmed", "pending_review", "ai_estimated"} <= codes, codes
    by_code = {row["code"]: row for row in report["incomplete_scope"]["reasons"]}
    assert by_code["partially_confirmed"]["attempt_count"] >= 1
    assert "部分评分点" in by_code["partially_confirmed"]["message"]
    assert "AI 估计" in by_code["ai_estimated"]["message"]
    assert second["attempt_id"] in by_code["ai_estimated"]["attempt_ids"]
    # The estimate never becomes a confirmed number; the decided part still counts
    # as a labelled lower bound instead of being thrown away.
    assert Decimal(report["aggregate"]["confirmed_score"]) == Decimal("10.00")
    assert Decimal(report["aggregate"]["unresolved_max_score"]) == Decimal("10.00")
    assert report["aggregate"]["lower_bound"] == "0.5000"
    assert report["aggregate"]["score_rate"] is None
    assert report["final_result"] is None


def test_hidden_verification_attempts_are_excluded_and_not_pending_review(caller, project_a, subject_a1):
    """The B02/R03 exclusion still holds: hidden runs are out of scope, not pending."""
    version = published(subject_a1, "true_false")
    body = make_attempt(caller, project_a, subject_a1, version, key="c06-hidden", mode="verification")
    assert body["receipt_only"] is True and body["grade"] is None

    report = practice_report(caller, project_a)
    assert report["hidden_verification_attempts"] >= 1
    # The existing exclusion is unchanged ...
    assert report["totals"]["pending_review"]["attempts"] == 0
    assert report["totals"]["fully_graded"]["attempts"] == 0
    assert Decimal(report["totals"]["pending_review"]["confirmed_score"]) == 0
    # ... and the new block does not re-import it as "pending review".
    assert report["incomplete_scope"]["attempts_in_scope"] == 0
    assert report["incomplete_scope"]["incomplete_attempts"] == 0
    assert report["incomplete_scope"]["is_incomplete"] is False
    assert report["incomplete_scope"]["reasons"] == []
    assert report["result_status"] == "no_data"
    assert report["final_result"] is None


def test_coverage_view_withholds_completion_rate_until_coverage_is_confirmed(
    caller, project_a, subject_a1
):
    """The same rule for the paper/coverage view: a rate only while it is real."""
    from apps.exams.models import PaperRevision

    body = coverage_report(caller, project_a, subject_a1)
    assert body["papers"], "演示夹具应登记了试卷"
    # The demo fixture confirms coverage, so the rate is final here ...
    assert all(paper["coverage_status"] == "coverage_complete" for paper in body["papers"])
    assert body["completion"]["status"] == "final"
    assert body["completion"]["coverage_rate"] == "1.0000"
    assert body["completion"]["final_result"] is not None
    assert body["completion"]["incomplete_scope"]["is_incomplete"] is False
    for paper in body["papers"]:
        assert paper["unscored_item_count"] >= 0
        assert paper["total_item_count"] >= paper["scored_item_count"]
        assert paper["coverage_rate"] is not None

    # ... and as soon as one registered paper loses its confirmation, the rate is
    # withheld instead of being shown with a warning.
    revision = PaperRevision.objects.get(id=body["papers"][0]["effective_revision_id"])
    revision.coverage_confirmed_at = None
    revision.save(update_fields=["coverage_confirmed_at", "updated_at"])

    after = coverage_report(caller, project_a, subject_a1)
    completion = after["completion"]
    assert completion["status"] == "partial_lower_bound"
    assert completion["coverage_rate"] is None
    assert completion["final_result"] is None
    assert completion["incomplete_scope"]["is_incomplete"] is True
    assert completion["incomplete_scope"]["blocked_paper_count"] == 1
    codes = {row["code"] for row in completion["incomplete_scope"]["reasons"]}
    assert "coverage_incomplete" in codes
    assert any(paper["coverage_rate"] is None for paper in after["papers"])
    assert completion["lower_bound"] is not None, "原始计数仍是可读数字，只是不能当成完成率"


# ---------------------------------------------------------------------- C08
def test_calibration_withholds_below_minimum_sample_then_reports_a_full_group(
    caller, project_a, subject_a1
):
    version = published(subject_a1, "true_false")
    for index in range(2):
        make_attempt(caller, project_a, subject_a1, version, key=f"c08-small-{index}")
    pin_elapsed_time(project_a)

    payload = calibration_report(caller, project_a)
    assert payload["minimum_group_sample"] == calibration_service.MIN_GROUP_SAMPLE == 5
    assert payload["groups"], "即使样本不足也要列出分组，才能说明为什么没有数字"
    assert all(group["status"] == "insufficient_sample" for group in payload["groups"])
    assert all(group["statistics"] is None for group in payload["groups"])
    assert all("statistics" in group for group in payload["groups"])
    # No aggregate number leaks out of an insufficient group.
    assert "mean_confirmed_fraction" not in json.dumps(payload["groups"])
    assert "median_confirmed_fraction" not in json.dumps(payload["groups"])
    assert payload["comparable_pair_count"] == 0
    assert any(row["code"] == "insufficient_sample" for row in payload["not_comparable"])
    # The dimensions are stated rather than implied.
    dims = payload["groups"][0]["dimensions"]
    assert dims["difficulty_proxy"] == calibration_service.DIFFICULTY_PROXY
    assert dims["question_type"] == "true_false"
    assert dims["timing_state"] == "within_limit"
    assert dims["exposure_state"] in {"strictly_independent", "repeated"}

    # Enough confirmed attempts in one group: the repeated-exposure group reaches 5.
    for index in range(4):
        make_attempt(caller, project_a, subject_a1, version, key=f"c08-big-{index}")
    pin_elapsed_time(project_a)

    payload = calibration_report(caller, project_a)
    enough = [group for group in payload["groups"] if group["status"] == "ok"]
    assert len(enough) == 1, [group["group_key"] for group in payload["groups"]]
    group = enough[0]
    assert group["dimensions"]["exposure_state"] == "repeated"
    assert group["sample_size"] == 5 and group["confirmed_sample_size"] == 5
    statistics = group["statistics"]
    assert statistics["mean_confirmed_fraction"] == "1.0000"
    assert statistics["median_confirmed_fraction"] == "1.0000"
    assert statistics["spread_stdev"] == "0.0000"
    assert group["comparability"]
    # The strict-independent single attempt stays out of the statistics.
    insufficient = [item for item in payload["groups"] if item["status"] == "insufficient_sample"]
    assert insufficient and insufficient[0]["confirmed_sample_size"] == 1


def test_calibration_delta_is_per_comparable_group_with_n_spread_and_caveats(
    caller, project_a, subject_a1
):
    """A difference is emitted only between groups that hold difficulty and time equal."""
    versions = [publish_extra_single_choice(subject_a1, index) for index in range(5)]
    wrong = {"type": "single_choice", "selected_option_ids": ["opt_b"]}

    # Six attempts on one question: the first is strictly independent, the rest
    # are repeats. Three of the repeats are correct, two are wrong.
    make_attempt(caller, project_a, subject_a1, versions[0], key="c08-delta-r0")
    for index in range(3):
        make_attempt(caller, project_a, subject_a1, versions[0], key=f"c08-delta-correct-{index}")
    for index in range(2):
        make_attempt(
            caller, project_a, subject_a1, versions[0], answer=wrong, key=f"c08-delta-wrong-{index}"
        )
    # Four more independent first contacts on distinct questions, all correct.
    for index in range(1, 5):
        make_attempt(caller, project_a, subject_a1, versions[index], key=f"c08-delta-i{index}")
    pin_elapsed_time(project_a)

    payload = calibration_report(caller, project_a)
    eligible = {group["dimensions"]["exposure_state"]: group for group in payload["groups"] if group["status"] == "ok"}
    assert set(eligible) == {"repeated", "strictly_independent"}, sorted(eligible)
    assert eligible["repeated"]["confirmed_sample_size"] == 5
    assert eligible["strictly_independent"]["confirmed_sample_size"] == 5
    assert eligible["repeated"]["statistics"]["mean_confirmed_fraction"] == "0.6000"
    assert eligible["strictly_independent"]["statistics"]["mean_confirmed_fraction"] == "1.0000"
    # Same type, same declared difficulty band, same time condition: the only
    # difference is exposure, which is what the comparison is allowed to show.
    assert (
        eligible["repeated"]["dimensions"]["difficulty_band"]
        == eligible["strictly_independent"]["dimensions"]["difficulty_band"]
    )
    assert (
        eligible["repeated"]["dimensions"]["timing_state"]
        == eligible["strictly_independent"]["dimensions"]["timing_state"]
    )

    comparable = [row for row in payload["comparisons"] if row["comparable"]]
    assert len(comparable) == 1, payload["comparisons"]
    row = comparable[0]
    delta = row["delta"]
    assert Decimal(delta["delta"]) == Decimal("0.4000")
    assert delta["sample_size"] == {"group_a": 5, "group_b": 5}
    assert Decimal(delta["spread"]["group_a_stdev"]) > 0
    assert delta["spread"]["group_b_stdev"] == "0.0000"
    assert delta["caveats"] and any("因果" in caveat for caveat in delta["caveats"])
    assert delta["metric"] == "mean_confirmed_fraction"
    # Every delta in the payload carries its own n, spread and caveats.
    assert deltas(payload)
    for body in deltas(payload):
        assert {"sample_size", "spread", "caveats"} <= set(body)


def test_comparability_verdicts_name_the_blocking_dimension():
    """The four verdicts the UI needs to explain why two groups cannot be compared."""
    base_dimensions = {
        "question_type": "single_choice",
        "difficulty_band": "score_le_2",
        "timing_state": "within_limit",
        "exposure_state": "repeated",
    }

    def group(key: str, **changes) -> dict:
        return {
            "group_key": key,
            "status": "ok",
            "confirmed_sample_size": 5,
            "dimensions": {**base_dimensions, **changes},
        }

    same = calibration_service._comparability_between(group("a"), group("b"))
    assert same["comparable"] is True and same["code"] == "comparable_with_caveats"

    small = group("small", exposure_state="strictly_independent")
    small["status"] = "insufficient_sample"
    small["confirmed_sample_size"] = 2
    verdict = calibration_service._comparability_between(group("a"), small)
    assert verdict["comparable"] is False and verdict["code"] == "insufficient_sample"

    verdict = calibration_service._comparability_between(
        group("a"), group("b", difficulty_band="score_gt_5")
    )
    assert verdict["comparable"] is False and verdict["code"] == "different_content_difficulty"
    assert "难度" in verdict["message"]

    verdict = calibration_service._comparability_between(
        group("a"), group("b", timing_state="over_limit")
    )
    assert verdict["comparable"] is False and verdict["code"] == "different_time_condition"

    verdict = calibration_service._comparability_between(
        group("a"), group("b", exposure_state="assisted")
    )
    assert verdict["comparable"] is False and verdict["code"] == "different_exposure_state"


def test_calibration_payload_has_no_causal_summary_field_and_states_its_caveats(
    caller, project_a, subject_a1
):
    version = published(subject_a1, "true_false")
    for index in range(3):
        make_attempt(caller, project_a, subject_a1, version, key=f"c08-caveat-{index}")
    payload = calibration_report(caller, project_a)

    keys = all_keys(payload)
    assert not (keys & FORBIDDEN_PAYLOAD_KEYS), sorted(keys & FORBIDDEN_PAYLOAD_KEYS)
    # No key anywhere claims a percentage-style summary either.
    assert not [key for key in keys if key.lower().endswith(("percent", "percentage"))]
    for delta_row in deltas(payload):
        assert {"sample_size", "spread", "caveats"} <= set(delta_row), "差值必须带 n、离散度与说明"

    caveats = payload["caveats"]
    statements = caveats["statements"]
    assert statements and all(isinstance(statement, str) and statement.strip() for statement in statements)
    joined = " ".join(statements)
    assert "因果" in joined, "必须明确声明不推断因果"
    assert "提升" in joined, "必须明确声明不声称学习提升"
    assert any("个人" in statement or "同一个人" in statement for statement in statements)
    assert caveats["claims"]["causal_claim"] is False
    assert caveats["claims"]["improvement_claim"] is False

    # The rule is enforced by code, not only by this assertion: the service's own
    # guard rejects a payload that grew a causal summary.
    with pytest.raises(AssertionError):
        calibration_service.assert_no_causal_summary({"improvement_percent": "12"})
    with pytest.raises(AssertionError):
        calibration_service.assert_no_causal_summary({"groups": [{"pass_probability": 0.8}]})
    with pytest.raises(AssertionError):
        calibration_service.assert_no_causal_summary({"comparisons": [{"delta": "0.10"}]})
    # A delta with its n, spread and caveats is allowed.
    calibration_service.assert_no_causal_summary(
        {
            "comparisons": [
                {"delta": "0.10", "sample_size": {}, "spread": {}, "caveats": ["仅组内观察"]}
            ]
        }
    )


def test_exposure_grouping_separates_assisted_from_strictly_independent(caller, project_a, subject_a1):
    independent_version = published(subject_a1, "true_false")
    make_attempt(caller, project_a, subject_a1, independent_version, key="c08-independent")

    assisted_version = second_published(subject_a1, "true_false")
    session = start_session(
        caller, project_a, subject_a1, assisted_version.question, key="c08-assisted-session"
    )
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    revealed = caller.post(f"/api/v1/projects/{project_a.id}/session-items/{item_id}/reveal")
    assert revealed.status_code == 200, revealed.content
    submitted = submit(caller, project_a, item_id, answer_for(assisted_version), key="c08-assisted-submit")
    assert submitted.status_code == 200, submitted.content
    attempt = Attempt.objects.get(session_item_id=item_id)
    unassisted_rows = LearningEvidence.objects.filter(
        attempt=attempt, dimension="unassisted_completion", qualifies=False
    )
    assert unassisted_rows.exists(), "提交前查看答案必须被记为辅助作答"

    payload = calibration_report(caller, project_a)
    states = {group["dimensions"]["exposure_state"] for group in payload["groups"]}
    assert {"strictly_independent", "assisted"} <= states, states
    assisted = next(
        group for group in payload["groups"] if group["dimensions"]["exposure_state"] == "assisted"
    )
    independent = next(
        group
        for group in payload["groups"]
        if group["dimensions"]["exposure_state"] == "strictly_independent"
    )
    assert assisted["group_key"] != independent["group_key"]
    # Different exposure is exactly what makes them different groups.
    assert assisted["dimensions"]["question_type"] == independent["dimensions"]["question_type"]
    assert assisted["dimensions"]["exposure_state"] == "assisted"
    assert independent["dimensions"]["exposure_state"] == "strictly_independent"
    assert "暴露" in payload["grouping"]["exposure_note"]


def test_calibration_is_owner_scoped(caller, other_caller, project_a, subject_a1):
    assert calibration_report(caller, project_a)["project_id"] == str(project_a.id)
    denied = other_caller.get(f"/api/v1/projects/{project_a.id}/reports/calibration")
    assert denied.status_code == 404, denied.content
    denied_subject = other_caller.get(
        f"/api/v1/projects/{project_a.id}/reports/calibration?subject_id={subject_a1.id}"
    )
    assert denied_subject.status_code == 404
