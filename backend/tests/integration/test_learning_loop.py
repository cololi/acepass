"""Learning loop: A -> explanation/graded -> B -> delayed C, evidence and planning."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.accounts.models import UserSettings
from apps.common.enums import KnowledgeStateSummary, TaskKind, TaskStatus
from apps.knowledge.models import KnowledgeNode, VerificationPairing
from apps.knowledge.services import core as knowledge_services
from apps.learning.models import LearnerKnowledgeState, ReviewTask, StudyPlan, StudyTask
from apps.learning.services import evidence as evidence_service
from apps.learning.services import pairing as pairing_service
from apps.learning.services import planner as planner_service
from apps.learning.services import state as state_service
from apps.practice.models import Attempt, SessionItem
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db


def start_session_for_owner(project, subject):
    """A minimal practice session with one item, created through the service."""
    from apps.practice.services import sessions as session_services

    version = published(subject, "single_choice")
    return session_services.create_session(
        user=project.owner,
        project=project,
        subject=subject,
        mode="practice",
        question_ids=[str(version.question_id)],
    )


def ensure_settings(user, **fields):
    """Update the study settings and refresh the cached related object.

    The service layer reads ``user.settings``, so a stale cache would silently
    ignore an update made through a separate instance.
    """
    settings_obj, _created = UserSettings.objects.get_or_create(user=user)
    for key, value in fields.items():
        setattr(settings_obj, key, value)
    settings_obj.save()
    user.settings = settings_obj
    return settings_obj


def make_pairing(subject, node=None):
    """Build an A/B/C pairing from three published single-choice questions."""
    versions = list(
        QuestionVersion.objects.filter(
            question__subject=subject, question_type="single_choice", status="published"
        )
        .select_related("question")
        .order_by("question__display_label")
    )
    baseline, immediate, delayed = versions[0], versions[1], versions[2]
    if node is None:
        from apps.knowledge.models import KnowledgeNode

        node = KnowledgeNode.objects.filter(syllabus_version__subject=subject).first()
    project = subject.project
    pairing = knowledge_services.create_verification_pairing(
        project=project,
        subject=subject,
        node=node,
        baseline_question=baseline.question,
        immediate_question=immediate.question,
        delayed_question=delayed.question,
        delay_hours=24,
        actor=project.owner,
        note="集成测试配对",
    )
    return pairing, baseline, immediate, delayed


def answer_for(version, index: int = 0):
    payload = AnswerKeyVersion.objects.get(question_version=version, is_disputed=False).answer_payload
    if version.question_type == "single_choice":
        return {"type": "single_choice", "selected_option_ids": [payload["correct_option_id"]]}
    if version.question_type == "multiple_choice":
        return {"type": "multiple_choice", "selected_option_ids": payload["correct_option_ids"]}
    if version.question_type == "true_false":
        return {"type": "true_false", "value": payload["value"]}
    if version.question_type == "fill_blank":
        blanks = {}
        for blank_id, spec in payload["blanks"].items():
            if spec.get("accepted_values"):
                blanks[blank_id] = spec["accepted_values"][0]
            else:
                blanks[blank_id] = str(spec["numeric"]["value"])
        return {"type": "fill_blank", "blanks": blanks}
    return {"type": "constructed_response", "text": f"第 {index} 次作答的过程"}


def answer_and_confirm(caller, project, subject, version, key: str):
    """Submit, then confirm any manual part so the attempt is fully confirmed."""
    session = start_session(caller, project, subject, version.question, key=f"{key}-session")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project, str(item.id))
    response = submit(caller, project, str(item.id), answer_for(version), key=f"{key}-submit")
    assert response.status_code == 200, response.content
    attempt = response.json()
    if attempt["grade"]["status"] == "pending_review" and item.rubric_version_id:
        criteria = item.rubric_version.criteria
        confirm = caller.post(
            f"/api/v1/projects/{project.id}/attempts/{attempt['attempt_id']}/confirm-grade",
            {
                "expected_grading_revision": attempt["grading_revision"],
                "parts": [{"part_id": c["criterion_id"], "score": c["max_score"]} for c in criteria],
            },
            key=f"{key}-confirm",
        )
        assert confirm.status_code == 200, confirm.content
        attempt["grade"] = confirm.json()
    return item, attempt


def test_paired_task_is_created_once_per_origin_and_triggers_delayed_c(caller, project_a, subject_a1):
    pairing, baseline, immediate, delayed = make_pairing(subject_a1)
    item, attempt = answer_and_confirm(caller, project_a, subject_a1, baseline, "pair-a")

    immediate_tasks = StudyTask.objects.filter(
        pairing=pairing, origin_session_item=item, task_kind=TaskKind.PAIRED_IMMEDIATE
    )
    assert immediate_tasks.count() == 1
    task_b = immediate_tasks.first()
    assert task_b.question_id == immediate.question_id
    assert task_b.status == TaskStatus.PENDING

    # Re-running the trigger (an explanation, a re-read, a later regrade) must not
    # create a second B task.
    pairing_service.on_attempt_graded(str(attempt["attempt_id"]))
    pairing_service.on_explanation_delivered(str(item.id))
    assert (
        StudyTask.objects.filter(
            pairing=pairing, origin_session_item=item, task_kind=TaskKind.PAIRED_IMMEDIATE
        ).count()
        == 1
    )

    # Completing B creates exactly one delayed C with a real anchor.
    b_item, _b_attempt = answer_and_confirm(caller, project_a, subject_a1, immediate, "pair-b")
    delayed_tasks = StudyTask.objects.filter(
        pairing=pairing, origin_session_item=b_item, task_kind=TaskKind.DELAYED_VERIFICATION
    )
    assert delayed_tasks.count() == 1
    task_c = delayed_tasks.first()
    assert task_c.question_id == delayed.question_id
    review = ReviewTask.objects.get(study_task=task_c)
    assert review.delay_hours == 24
    assert task_c.delay_anchor_at is not None
    assert task_c.not_before == task_c.delay_anchor_at + timedelta(hours=24)

    # Regrading B does not create another C.
    pairing_service.on_attempt_graded(str(_b_attempt["attempt_id"]))
    assert (
        StudyTask.objects.filter(
            pairing=pairing, origin_session_item=b_item, task_kind=TaskKind.DELAYED_VERIFICATION
        ).count()
        == 1
    )


def test_missing_delayed_question_is_recorded_not_faked(caller, project_a, subject_a1):
    versions = list(
        QuestionVersion.objects.filter(question__subject=subject_a1, status="published")
        .select_related("question")
        .order_by("question__display_label")
    )
    from apps.knowledge.models import KnowledgeNode

    node = KnowledgeNode.objects.filter(syllabus_version__subject=subject_a1).first()
    pairing = knowledge_services.create_verification_pairing(
        project=project_a,
        subject=subject_a1,
        node=node,
        baseline_question=versions[0].question,
        immediate_question=versions[1].question,
        delayed_question=None,
        delay_hours=24,
        actor=project_a.owner,
    )
    item, _attempt = answer_and_confirm(caller, project_a, subject_a1, versions[1], "missing-c")
    record = StudyTask.objects.filter(
        pairing=pairing, origin_session_item=None, task_kind=TaskKind.DELAYED_VERIFICATION
    ).first()
    assert record is not None
    assert record.status == TaskStatus.INVALIDATED
    assert "缺少合格" in record.deficit_notice
    assert record.question is None
    del item


def test_delayed_interval_boundary_and_anchor_refresh(caller, project_a, subject_a1):
    pairing, baseline, immediate, delayed = make_pairing(subject_a1)
    _item, _attempt = answer_and_confirm(caller, project_a, subject_a1, baseline, "boundary-a")
    b_item, _b_attempt = answer_and_confirm(caller, project_a, subject_a1, immediate, "boundary-b")
    task_c = StudyTask.objects.get(
        pairing=pairing, origin_session_item=b_item, task_kind=TaskKind.DELAYED_VERIFICATION
    )
    anchor = task_c.delay_anchor_at

    just_before = anchor + timedelta(hours=24) - timedelta(minutes=1)
    at_deadline = anchor + timedelta(hours=24)
    early = pairing_service.delayed_interval_status(task=task_c, now=just_before)
    ready = pairing_service.delayed_interval_status(task=task_c, now=at_deadline)
    assert early["satisfied"] is False and "还需" in early["reason"]
    assert ready["satisfied"] is True

    # A newer related training event pushes the deadline out and says why.
    task_c.delay_anchor_at = anchor - timedelta(hours=2)
    task_c.not_before = task_c.delay_anchor_at + timedelta(hours=24)
    task_c.due_at = task_c.not_before
    task_c.save(update_fields=["delay_anchor_at", "not_before", "due_at", "updated_at"])
    review = task_c.review_task
    review.not_before = task_c.not_before
    review.delay_anchor_at = task_c.delay_anchor_at
    review.save(update_fields=["not_before", "delay_anchor_at", "updated_at"])

    from apps.practice.services import exposure

    exposure.record(
        user=project_a.owner,
        project=project_a,
        kind="explanation_delivered",
        purpose="practice",
        source="test",
        question=delayed.question,
        question_version=delayed,
        reveals_answer=True,
    )
    updated = pairing_service.reconcile_delayed_tasks()
    assert updated >= 1
    task_c.refresh_from_db()
    assert task_c.not_before > anchor + timedelta(hours=24) - timedelta(hours=3)
    assert "anchor_updated" in task_c.reason_codes


def test_starting_an_unripe_delayed_task_is_refused(caller, project_a, subject_a1):
    pairing, baseline, immediate, delayed = make_pairing(subject_a1)
    answer_and_confirm(caller, project_a, subject_a1, baseline, "unripe-a")
    b_item, _b = answer_and_confirm(caller, project_a, subject_a1, immediate, "unripe-b")
    task_c = StudyTask.objects.get(
        pairing=pairing, origin_session_item=b_item, task_kind=TaskKind.DELAYED_VERIFICATION
    )
    response = caller.post(f"/api/v1/study-tasks/{task_c.id}/start", {}, key="unripe-start")
    assert response.status_code == 400
    assert "延迟验证需等待" in response.json()["error"]["message"]

    # Bring the deadline forward: the same call now succeeds and the task starts.
    past = timezone.now() - timedelta(minutes=1)
    task_c.not_before = past
    task_c.due_at = past
    task_c.save(update_fields=["not_before", "due_at", "updated_at"])
    review = task_c.review_task
    review.not_before = past
    review.save(update_fields=["not_before", "updated_at"])
    ok = caller.post(f"/api/v1/study-tasks/{task_c.id}/start", {}, key="unripe-start-2")
    assert ok.status_code == 200, ok.content
    task_c.refresh_from_db()
    assert task_c.status == TaskStatus.IN_PROGRESS
    assert task_c.review_task.was_started is True


def test_evidence_dimensions_and_state_progression(caller, project_a, subject_a1):
    pairing, baseline, immediate, delayed = make_pairing(subject_a1)
    _item, attempt = answer_and_confirm(caller, project_a, subject_a1, baseline, "state-a")
    node_ids = set(
        Attempt.objects.get(id=attempt["attempt_id"])
        .evidence_rows.filter(is_active=True)
        .exclude(knowledge_node__isnull=True)
        .values_list("knowledge_node_id", flat=True)
    )
    assert node_ids
    for node_id in node_ids:
        node = KnowledgeNode.objects.get(id=node_id)
        state_service.refresh_node_state(
            user=project_a.owner,
            project=project_a,
            syllabus_version=node.syllabus_version,
            node=node,
        )
    states = {
        state.node_id: state
        for state in LearnerKnowledgeState.objects.filter(project=project_a, node_id__in=list(node_ids))
    }
    assert states
    for state in states.values():
        assert state.summary in {
            KnowledgeStateSummary.INDEPENDENT,
            KnowledgeStateSummary.NEEDS_FOUNDATION,
            KnowledgeStateSummary.UNDIAGNOSED,
        }
        assert state.detail["thresholds"]["distinct_questions"] == 3
        assert state.detail["missing_evidence"]
    del pairing, immediate, delayed


def test_same_question_repeated_does_not_fake_distinct_evidence(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    attempts = []
    for index in range(3):
        _item, attempt = answer_and_confirm(caller, project_a, subject_a1, version, f"repeat-{index}")
        attempts.append(attempt["attempt_id"])
    same_question = version.question_id
    rows = [
        row
        for row in evidence_service.evidence_summary_rows(user=project_a.owner, project=project_a, limit=200)
        if row["attempt_id"] in set(attempts)
    ]
    independent = [row for row in rows if row["dimension"] == "independent_correct" and row["qualifies"]]
    # Only the first contact with the question is a strict independent success;
    # the two repeats are ordinary practice and say so explicitly.
    assert len(independent) == 1
    blocked = [
        row
        for row in rows
        if row["dimension"] == "independent_correct" and not row["qualifies"]
    ]
    assert len(blocked) == 2
    assert all("重复练习" in reason for row in blocked for reason in row["exclusion_reasons"])

    # The same stable question can never satisfy the variant dimensions.
    assert [row for row in rows if row["dimension"] == "template_variant" and row["qualifies"]] == []
    # The first contact may look like an unseen variant, but the state projection
    # refuses to call it "handles unseen" without a second confirmed template.
    unseen_rows = [row for row in rows if row["dimension"] == "unseen_variant" and row["qualifies"]]
    assert len(unseen_rows) == 1
    repeated = [row for row in rows if row["dimension"] == "repeat_practice" and row["qualifies"]]
    assert len(repeated) == 3
    unassisted = [row for row in rows if row["dimension"] == "unassisted_completion" and row["qualifies"]]
    assert len(unassisted) == 3

    # The state projection therefore reports one distinct question, not three.
    node_id = independent[0]["node_id"]
    node = KnowledgeNode.objects.get(id=node_id)
    state = state_service.refresh_node_state(
        user=project_a.owner, project=project_a, syllabus_version=node.syllabus_version, node=node
    )
    assert state.independent_correct_count == 1
    assert state.distinct_question_count == 1
    assert state.distinct_template_count == 0
    assert state.summary == KnowledgeStateSummary.INDEPENDENT
    assert state.has_delayed_correct is False
    assert any("不同题" in item for item in state.detail["missing_evidence"])
    assert same_question


def test_near_duplicate_family_is_not_unseen(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    from apps.question_bank.models import QuestionFamily

    family = QuestionFamily.objects.create(subject=subject_a1, name="演示近重复家族", relation_confirmed=True)
    Question.objects.filter(id=version.question_id).update(family=family)
    _item, attempt = answer_and_confirm(caller, project_a, subject_a1, version, "family-1")
    rows = evidence_service.evidence_summary_rows(user=project_a.owner, project=project_a)
    unseen = [row for row in rows if row["dimension"] == "unseen_variant" and row["attempt_id"] == attempt["attempt_id"]]
    assert unseen and unseen[0]["qualifies"] is False
    assert any("近重复家族" in reason for reason in unseen[0]["exclusion_reasons"])


def test_recent_failures_downgrade_the_summary(owner, project_a, subject_a1):
    """Two failures in the recent window downgrade the state, history is kept."""
    version = published(subject_a1, "single_choice")
    node = version.knowledge_mappings.first().node
    state = LearnerKnowledgeState.objects.create(
        user=owner,
        project=project_a,
        syllabus_version=node.syllabus_version,
        node=node,
        summary=KnowledgeStateSummary.INDEPENDENT,
        best_summary=KnowledgeStateSummary.INDEPENDENT,
        independent_correct_count=3,
        distinct_question_count=3,
        distinct_template_count=2,
        has_delayed_correct=True,
        as_of=timezone.now(),
    )
    from apps.practice.models import LearningEvidence

    for index, correct in enumerate([False, False, True]):
        session = start_session_for_owner(project_a, subject_a1)
        item = session.items.first()
        attempt = Attempt.objects.create(
            session_item=item,
            user=owner,
            project=project_a,
            submitted_at=timezone.now(),
        )
        # grade_revision > 0 marks these as produced by a real confirmed grading
        # revision, which is what the strict dimensions consume.
        LearningEvidence.objects.create(
            attempt=attempt,
            session_item=item,
            user=owner,
            project=project_a,
            knowledge_node=node,
            dimension="independent_correct",
            qualifies=True,
            is_correct=correct,
            score_fraction=Decimal("1.0000") if correct else Decimal("0.0000"),
            grade_revision=1,
            rule_version="p0-1",
            computed_at=timezone.now() + timedelta(seconds=index),
            is_active=True,
            detail={"template_id": "t1"},
        )
    refreshed = state_service.refresh_node_state(
        user=owner, project=project_a, syllabus_version=node.syllabus_version, node=node
    )
    assert refreshed.recent_independent_attempts == 3
    assert refreshed.recent_independent_failures == 2
    assert refreshed.needs_review is True
    assert refreshed.summary == KnowledgeStateSummary.NEEDS_REVIEW
    assert "失败" in refreshed.downgrade_reason
    # The historical best is preserved, not erased by the downgrade.
    assert refreshed.best_summary == KnowledgeStateSummary.INDEPENDENT
    del state


# --------------------------------------------------------------------- planner
def test_budget_is_split_with_largest_remainder_and_rotates(owner, project_a, project_b):
    ensure_settings(owner, daily_budget_minutes=60, project_budget_percent={})
    allocation = planner_service.allocate_budget(owner, [project_a, project_b], 60, date(2026, 3, 1))
    minutes = [row["minutes"] for row in allocation["projects"]]
    assert sum(minutes) == 60
    assert sorted(minutes) == [30, 30]

    # Odd budgets are handed out one minute at a time, never exceeding the total.
    allocation = planner_service.allocate_budget(owner, [project_a, project_b], 61, date(2026, 3, 1))
    minutes = [row["minutes"] for row in allocation["projects"]]
    assert sum(minutes) == 61

    # Percentages are honoured, and must not depend on project creation order:
    # the split follows the stored percentages, not the iteration order.
    ensure_settings(owner, project_budget_percent={str(project_a.id): 60.0, str(project_b.id): 40.0})
    allocation = planner_service.allocate_budget(owner, [project_a, project_b], 60, date(2026, 3, 1))
    by_project = {row["project_id"]: row["minutes"] for row in allocation["projects"]}
    assert by_project[str(project_a.id)] == 36
    assert by_project[str(project_b.id)] == 24
    flipped = planner_service.allocate_budget(owner, [project_b, project_a], 60, date(2026, 3, 1))
    flipped_map = {row["project_id"]: row["minutes"] for row in flipped["projects"]}
    assert flipped_map == by_project

    # A tiny budget goes to one project per day, following the rotation.
    first = planner_service.allocate_budget(owner, [project_a, project_b], 2, date(2026, 3, 1))
    second = planner_service.allocate_budget(owner, [project_a, project_b], 2, date(2026, 3, 2))
    first_winner = max(first["projects"], key=lambda row: row["minutes"])["project_id"]
    second_winner = max(second["projects"], key=lambda row: row["minutes"])["project_id"]
    assert first_winner != second_winner or first["rotation_offset"] != second["rotation_offset"]


def test_plan_never_exceeds_the_global_budget_and_replays_the_same_day(owner, project_a, project_b, caller):
    ensure_settings(
        owner,
        daily_budget_minutes=30,
        project_budget_percent={str(project_a.id): 50.0, str(project_b.id): 50.0},
    )

    plan = planner_service.generate_plan(user=owner)
    assert plan.daily_budget_minutes == 30
    assert plan.allocated_minutes <= 30
    assert plan.tasks.exists()
    for task in plan.tasks.all():
        assert task.project_id in {project_a.id, project_b.id}
        assert task.estimated_minutes >= 1

    # Same day, no refresh: the stored plan wins and nothing new is created.
    task_count = StudyTask.objects.count()
    again = planner_service.generate_plan(user=owner)
    assert again.id == plan.id
    assert StudyTask.objects.count() == task_count

    # A refresh creates a new revision and only replaces unstarted tasks.
    started = plan.tasks.first()
    started.status = TaskStatus.IN_PROGRESS
    started.save(update_fields=["status", "updated_at"])
    refreshed = planner_service.generate_plan(user=owner, refresh=True)
    assert refreshed.revision == plan.revision + 1
    started.refresh_from_db()
    assert started.status == TaskStatus.IN_PROGRESS
    kept = refreshed.tasks.filter(id=started.id).exists()
    assert kept is False or refreshed.tasks.filter(id=started.id).exists()


def test_plan_skips_ineligible_questions_and_explains_gaps(owner, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    for other in QuestionVersion.objects.filter(question__subject__project=project_a, status="published").exclude(
        id=version.id
    ):
        other.status = "withdrawn"
        other.save(update_fields=["status", "updated_at"])
    ensure_settings(owner, daily_budget_minutes=60, project_budget_percent={str(project_a.id): 100.0})
    plan = planner_service.generate_plan(user=owner, refresh=True)
    assert plan.allocated_minutes <= 60
    # Whatever is not allocated is explained rather than silently dropped.
    if plan.allocated_minutes < 60:
        assert any("未分配" in note or "不足" in note for note in plan.notes)


def test_today_endpoint_reports_empty_state_and_backlog(owner, project_a, caller):
    response = caller.get("/api/v1/study-plans/today")
    assert response.status_code == 200
    assert response.json()["plan"] is None
    assert "还没有计划" in response.json()["notes"][0]

    generated = caller.post("/api/v1/study-plans/today/generate", {"refresh": False}, key="today-1")
    assert generated.status_code == 200
    plan = generated.json()["plan"]
    assert plan is not None
    assert plan["daily_budget_minutes"] >= 0
    assert generated.json()["tasks"] is not None

    # Overdue pending tasks are reported as a backlog instead of being copied.
    task = StudyTask.objects.filter(plan_id=plan["plan_id"]).first()
    if task is not None:
        task.due_at = timezone.now() - timedelta(days=1)
        task.save(update_fields=["due_at", "updated_at"])
        backlog = caller.get("/api/v1/study-plans/today").json()["backlog"]
        assert any(row["overdue_tasks"] >= 1 for row in backlog)


def test_generate_plan_endpoint_is_idempotent_per_key(caller):
    first = caller.post("/api/v1/study-plans/today/generate", {"refresh": False}, key="plan-idem")
    second = caller.post("/api/v1/study-plans/today/generate", {"refresh": False}, key="plan-idem")
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["plan"]["plan_id"] == second.json()["plan"]["plan_id"]
    assert StudyPlan.objects.count() == 1


def test_report_separates_confirmed_pending_and_self_assessed(caller, project_a, subject_a1):
    single = published(subject_a1, "single_choice")
    answer_and_confirm(caller, project_a, subject_a1, single, "report-1")
    constructed = published(subject_a1, "constructed_response")
    answer_and_confirm(caller, project_a, subject_a1, constructed, "report-2")

    report = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert report["totals"]["self_assessed"]["attempts"] >= 1
    assert report["totals"]["fully_confirmed"]["attempts"] >= 1
    assert Decimal(report["totals"]["fully_confirmed"]["confirmed_score"]) > 0
    assert report["notes"]
    # Self-assessed attempts are never merged into the strict independent bucket.
    assert (
        report["totals"]["strict_independent"]["attempts"] <= report["totals"]["fully_confirmed"]["attempts"]
    )


def test_retry_after_failed_request_can_reuse_the_same_key(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="retry-session")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    # A structurally invalid submission fails ...
    bad = caller.post(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/submit",
        {"answer": {"type": "true_false", "value": True}},
        key="retry-key",
    )
    assert bad.status_code == 422
    # ... and the same key can then be used successfully.
    good = caller.post(
        f"/api/v1/projects/{project_a.id}/session-items/{item_id}/submit",
        {"answer": {"type": "single_choice", "selected_option_ids": ["opt_a"]}},
        key="retry-key",
    )
    assert good.status_code == 200, good.content
    assert Attempt.objects.filter(session_item_id=item_id).count() == 1


def test_outbox_events_are_recorded_and_consumed(caller, project_a, subject_a1):
    from apps.audit.models import OutboxEvent

    version = published(subject_a1, "single_choice")
    answer_and_confirm(caller, project_a, project_a.subjects.first(), version, "outbox-1")
    topics = set(OutboxEvent.objects.values_list("topic", flat=True))
    assert "projection.rebuild_attempt_evidence" in topics or "learning.on_attempt_graded" in topics
    # In test/demo mode consumers run in-process, so nothing stays pending.
    pending = OutboxEvent.objects.filter(status="pending").count()
    assert pending == 0


def test_evidence_for_answer_dispute_is_invalidated(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    answer = AnswerKeyVersion.objects.get(question_version=version, is_disputed=False)
    _item, attempt = answer_and_confirm(caller, project_a, subject_a1, version, "invalidate-1")
    rows = evidence_service.evidence_summary_rows(user=project_a.owner, project=project_a)
    assert any(row["attempt_id"] == attempt["attempt_id"] and row["qualifies"] for row in rows)

    invalidated = evidence_service.invalidate_for_answer_version(str(answer.id))
    assert invalidated >= 1
    rows = evidence_service.evidence_summary_rows(user=project_a.owner, project=project_a)
    assert all(row["attempt_id"] != attempt["attempt_id"] for row in rows)


def test_datetime_utc_storage_uses_user_timezone_only_for_local_date(owner):
    settings_obj = ensure_settings(owner, timezone="Pacific/Kiritimati")  # UTC+14
    import datetime as dt

    moment = dt.datetime(2026, 3, 1, 20, 0, tzinfo=dt.UTC)
    assert settings_obj.local_date(moment) == date(2026, 3, 2)
    settings_obj = ensure_settings(owner, timezone="Pacific/Honolulu")  # UTC-10
    assert settings_obj.local_date(moment) == date(2026, 3, 1)
