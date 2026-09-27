"""P1 batch 2: memory reviews enter the daily plan without touching ability.

Acceptance points covered here (B06):

* 全局预算仍受限 — memory reviews are ordinary plan candidates, so they are
  capped by the same per-project budget as every other category;
* 卡片记忆不升级解题能力 — scheduling and reviewing a card creates no learning
  evidence, no grade and no knowledge-state change;
* a refreshed plan does not queue the same card twice, and a question that is no
  longer eligible (withdrawn / missing checked answer) never comes back through
  the memory channel.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.common.enums import TaskKind, TaskStatus
from apps.learning.models import LearnerKnowledgeState, StudyPlan, StudyTask
from apps.learning.services import planner
from apps.memory.services import scheduler as memory_service
from apps.practice.models import LearningEvidence
from apps.question_bank.models import Question, QuestionVersion

pytestmark = pytest.mark.django_db


def _eligible_question(subject) -> Question:
    version = (
        QuestionVersion.objects.filter(question__subject=subject, status="published")
        .select_related("question")
        .order_by("question__display_label")
        .first()
    )
    assert version is not None
    return version.question


def test_due_card_is_scheduled_and_refresh_does_not_duplicate_it(owner, project_a, subject_a1):
    question = _eligible_question(subject_a1)
    card = memory_service.create_card(user=owner, question=question)
    candidates = planner.memory_review_candidates(user=owner, project=project_a)
    assert [row["memory_card_id"] for row in candidates] == [str(card.id)]
    assert "memory_due" in candidates[0]["reason_codes"]

    plan = planner.generate_plan(user=owner)
    tasks = StudyTask.objects.filter(user=owner, plan=plan, task_kind=TaskKind.MEMORY_REVIEW)
    assert tasks.count() == 1
    task = tasks.first()
    assert str(task.memory_card_id) == str(card.id)
    assert task.evidence_ids == []

    refreshed = planner.generate_plan(user=owner, refresh=True)
    assert refreshed.id != plan.id
    open_tasks = StudyTask.objects.filter(
        user=owner, task_kind=TaskKind.MEMORY_REVIEW, status__in=[TaskStatus.PENDING, TaskStatus.DEFERRED]
    )
    assert open_tasks.count() == 1
    assert str(open_tasks.first().memory_card_id) == str(card.id)


def test_review_schedules_the_card_forward_and_then_it_is_due_again(owner, project_a, subject_a1):
    question = _eligible_question(subject_a1)
    card = memory_service.create_card(user=owner, question=question)
    result = memory_service.review_card(card=card, rating="good", idempotency_key="plan-review-1")
    card.refresh_from_db()
    assert card.due_at is not None
    due_at = memory_service.parse_moment(result["due_at"])

    # Not due yet: the plan must not offer it early.
    assert planner.memory_review_candidates(user=owner, project=project_a, now=timezone.now()) == []
    # Once the interval has passed it is due again, still without any ability claim.
    later = due_at + timedelta(minutes=1)
    rows = planner.memory_review_candidates(user=owner, project=project_a, now=later)
    assert [row["memory_card_id"] for row in rows] == [str(card.id)]


def test_memory_review_never_creates_evidence_or_changes_knowledge_state(owner, project_a, subject_a1):
    question = _eligible_question(subject_a1)
    card = memory_service.create_card(user=owner, question=question)
    plan = planner.generate_plan(user=owner)
    task = StudyTask.objects.get(user=owner, plan=plan, task_kind=TaskKind.MEMORY_REVIEW)
    evidence_before = LearningEvidence.objects.count()
    states_before = {
        str(state.node_id): state.summary for state in LearnerKnowledgeState.objects.filter(user=owner)
    }

    memory_service.review_card(card=card, rating="easy", idempotency_key="plan-review-2")
    task.status = TaskStatus.COMPLETED
    task.completed_at = timezone.now()
    task.save(update_fields=["status", "completed_at", "updated_at"])

    assert LearningEvidence.objects.count() == evidence_before
    assert {
        str(state.node_id): state.summary for state in LearnerKnowledgeState.objects.filter(user=owner)
    } == states_before


def test_withdrawn_question_is_not_rescheduled_from_the_memory_channel(owner, project_a, subject_a1):
    question = _eligible_question(subject_a1)
    card = memory_service.create_card(user=owner, question=question)
    assert planner.memory_review_candidates(user=owner, project=project_a)
    # A brand-new card is immediately due: it has never been reviewed.
    assert card.due_at is not None and card.due_at <= timezone.now()

    QuestionVersion.objects.filter(question=question, status="published").update(status="withdrawn")
    assert planner.memory_review_candidates(user=owner, project=project_a) == []


def test_plan_budget_still_caps_memory_reviews(owner, project_a, subject_a1):
    """The global budget stays the only capacity limit, memory included."""
    from apps.accounts.models import UserSettings

    for question in Question.objects.filter(subject=subject_a1)[:5]:
        memory_service.create_card(user=owner, question=question)
    settings_obj, _ = UserSettings.objects.get_or_create(user=owner)
    settings_obj.daily_budget_minutes = 2
    settings_obj.save(update_fields=["daily_budget_minutes", "updated_at"])

    plan = planner.generate_plan(user=owner)
    planned = sum(
        task.estimated_minutes
        for task in StudyTask.objects.filter(user=owner, plan=plan, status=TaskStatus.PENDING)
    )
    assert planned <= 2
    assert StudyPlan.objects.get(id=plan.id).allocated_minutes <= 2
