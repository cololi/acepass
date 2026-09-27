"""Memory cards over HTTP: creation, due order, reviews, replay and scope.

These tests also pin the product's honesty rule: reviewing a recall card is a
memory-projection write only. It must never create ``LearningEvidence``, never
change ``LearnerKnowledgeState`` and never write a grade or an attempt.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from apps.common.enums import MemoryCardPhase
from apps.exams.services import core as exams_services
from apps.learning.models import LearnerKnowledgeState
from apps.memory.models import MemoryCard, MemoryReviewLog
from apps.memory.services import scheduler as scheduler_service
from apps.practice.models import Attempt, GradeEvent, LearningEvidence
from apps.question_bank.models import Question
from domain.memory.fsrs import FSRS_VERSION

pytestmark = pytest.mark.django_db

START = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)


class Clock:
    """A fixed, advanceable clock injected into the memory service layer."""

    def __init__(self, moment: datetime = START):
        self.moment = moment

    def advance(self, **kwargs) -> datetime:
        self.moment = self.moment + timedelta(**kwargs)
        return self.moment


@pytest.fixture
def clock(monkeypatch) -> Clock:
    value = Clock()
    monkeypatch.setattr(scheduler_service, "now", lambda: value.moment)
    return value


def questions_for(subject, limit: int = 4) -> list[Question]:
    return list(
        Question.objects.filter(subject=subject, current_published_version__status="published").order_by(
            "display_label"
        )[:limit]
    )


def cards_url(project, suffix: str = "") -> str:
    return f"/api/v1/projects/{project.id}/memory-cards{suffix}"


def create_card(caller, project, question, *, key: str | None = None):
    return caller.post(cards_url(project), {"question_id": str(question.id)}, key=key)


def review(caller, project, card_id: str, rating: str, *, key: str):
    return caller.post(cards_url(project, f"/{card_id}/review"), {"rating": rating}, key=key)


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value)


# ------------------------------------------------------------------- creation
def test_card_creation_is_idempotent_per_question(caller, project_a, subject_a1):
    question = questions_for(subject_a1, 1)[0]
    created = create_card(caller, project_a, question, key="card-create-1")
    assert created.status_code == 201, created.content
    body = created.json()
    assert body["phase"] == MemoryCardPhase.NEW
    assert body["question_id"] == str(question.id)
    assert body["subject_id"] == str(subject_a1.id)
    assert body["stem_excerpt"]
    # A card that was never reviewed has no memory state to report.
    assert body["retrievability"] is None
    assert body["stability"] == 0.0 and body["reps"] == 0

    again = create_card(caller, project_a, question, key="card-create-2")
    assert again.status_code == 200, again.content
    assert again.json()["card_id"] == body["card_id"]
    assert MemoryCard.objects.filter(user=project_a.owner, question=question).count() == 1

    listed = caller.get(cards_url(project_a))
    assert listed.status_code == 200
    assert [row["card_id"] for row in listed.json()] == [body["card_id"]]


def test_card_creation_rejects_another_projects_question(other_caller, other_user, project_a, subject_a1):
    question = questions_for(subject_a1, 1)[0]
    own_project = exams_services.create_project(other_user, name="他人项目")
    response = other_caller.post(cards_url(own_project), {"question_id": str(question.id)}, key="foreign-question")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert MemoryCard.objects.count() == 0


# ----------------------------------------------------------------- due listing
def test_due_list_is_ordered_by_due_at(caller, project_a, subject_a1, clock):
    first, second, third = questions_for(subject_a1, 3)
    card_ids = []
    for index, question in enumerate((first, second, third)):
        created = create_card(caller, project_a, question, key=f"order-create-{index}")
        assert created.status_code == 201, created.content
        card_ids.append(created.json()["card_id"])

    # easy pushes the first card two weeks out; good stays on a 10 minute step;
    # again comes straight back in one minute.
    assert review(caller, project_a, card_ids[0], "easy", key="order-easy").status_code == 200
    assert review(caller, project_a, card_ids[1], "good", key="order-good").status_code == 200
    assert review(caller, project_a, card_ids[2], "again", key="order-again").status_code == 200

    ordered = caller.get(cards_url(project_a)).json()
    assert [row["card_id"] for row in ordered] == [card_ids[2], card_ids[1], card_ids[0]]
    dues = [parse(row["due_at"]) for row in ordered]
    assert dues == sorted(dues)

    # The `+00:00` offset is sent unencoded on purpose: a client that forgets to
    # percent-encode it must not get a different window.
    tomorrow = (clock.moment + timedelta(days=1)).isoformat()
    due_now = caller.get(cards_url(project_a), due_before=tomorrow)
    assert due_now.status_code == 200, due_now.content
    assert [row["card_id"] for row in due_now.json()] == [card_ids[2], card_ids[1]]
    zulu = caller.get(cards_url(project_a), due_before=tomorrow.replace("+00:00", "Z"))
    assert [row["card_id"] for row in zulu.json()] == [card_ids[2], card_ids[1]]

    # The service-level due list agrees with the endpoint and stays project-scoped.
    # At this instant only the "again" card is already due: the other two are
    # waiting out their 10 minute and 14 day intervals.
    now_due = scheduler_service.due_cards(user=project_a.owner, project=project_a, now=clock.moment, limit=10)
    assert [str(card.id) for card in now_due] == []
    later = scheduler_service.due_cards(
        user=project_a.owner, project=project_a, now=clock.moment + timedelta(days=1), limit=10
    )
    assert [str(card.id) for card in later] == [card_ids[2], card_ids[1]]


# -------------------------------------------------------------------- reviews
def test_review_writes_exactly_one_log_and_moves_the_due_date_forward(caller, project_a, subject_a1, clock):
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="review-create").json()["card_id"]
    card = MemoryCard.objects.get(id=card_id)
    assert card.due_at == clock.moment

    response = review(caller, project_a, card_id, "good", key="review-1")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["log_id"]
    assert body["phase"] == MemoryCardPhase.LEARNING
    assert body["is_lapse"] is False
    assert parse(body["due_at"]) == clock.moment + timedelta(minutes=10)
    assert body["interval_days"] == pytest.approx(10 / 1440)

    logs = MemoryReviewLog.objects.filter(card_id=card_id)
    assert logs.count() == 1
    log = logs.get()
    assert log.rating == "good"
    assert log.reviewed_at == clock.moment
    assert log.due_after == parse(body["due_at"])
    assert log.interval_days == pytest.approx(body["interval_days"])
    assert log.phase_before == MemoryCardPhase.NEW
    assert log.phase_after == MemoryCardPhase.LEARNING
    assert log.scheduler_version == FSRS_VERSION

    card.refresh_from_db()
    assert card.due_at > clock.moment
    assert card.reps == 1
    assert card.phase == MemoryCardPhase.LEARNING
    assert card.last_reviewed_at == clock.moment

    # The ledger is what the API returns, newest first.
    listed = caller.get(cards_url(project_a, f"/{card_id}/logs"))
    assert listed.status_code == 200
    assert [row["log_id"] for row in listed.json()] == [str(log.id)]


def test_repeated_idempotency_key_replays_without_a_second_log(caller, project_a, subject_a1, clock):
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="replay-create").json()["card_id"]

    first = review(caller, project_a, card_id, "good", key="replay-key")
    assert first.status_code == 200, first.content
    clock.advance(minutes=30)  # a genuine retry may arrive much later
    second = review(caller, project_a, card_id, "good", key="replay-key")

    assert second.status_code == 200, second.content
    assert second.json() == first.json()
    assert MemoryReviewLog.objects.filter(card_id=card_id).count() == 1
    card = MemoryCard.objects.get(id=card_id)
    assert card.reps == 1
    assert card.last_reviewed_at == START


def test_same_key_with_a_different_rating_conflicts_and_a_new_key_writes_again(caller, project_a, subject_a1, clock):
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="conflict-create").json()["card_id"]
    first = review(caller, project_a, card_id, "good", key="conflict-key")
    assert first.status_code == 200

    conflict = review(caller, project_a, card_id, "again", key="conflict-key")
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"
    assert MemoryReviewLog.objects.filter(card_id=card_id).count() == 1

    # A different key with the same rating is a new review, not a replay.
    clock.advance(minutes=10)
    fresh = review(caller, project_a, card_id, "good", key="conflict-key-2")
    assert fresh.status_code == 200, fresh.content
    assert fresh.json()["log_id"] != first.json()["log_id"]
    assert MemoryReviewLog.objects.filter(card_id=card_id).count() == 2
    card = MemoryCard.objects.get(id=card_id)
    assert card.reps == 2
    assert card.phase == MemoryCardPhase.REVIEW


def test_review_without_an_idempotency_key_is_refused(caller, project_a, subject_a1):
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="nokey-create").json()["card_id"]
    response = caller.client.post(
        cards_url(project_a, f"/{card_id}/review"),
        data={"rating": "good"},
        content_type="application/json",
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"
    assert MemoryReviewLog.objects.count() == 0


def test_review_rejects_an_unknown_rating(caller, project_a, subject_a1):
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="badrating-create").json()["card_id"]
    response = review(caller, project_a, card_id, "perfect", key="badrating")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_input"
    assert MemoryReviewLog.objects.count() == 0


# -------------------------------------------------------------------- rebuild
def _three_reviews(caller, project_a, subject_a1, clock) -> tuple[str, list[MemoryReviewLog]]:
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="rebuild-create").json()["card_id"]
    assert review(caller, project_a, card_id, "good", key="rebuild-1").status_code == 200
    clock.advance(minutes=10)
    assert review(caller, project_a, card_id, "good", key="rebuild-2").status_code == 200
    clock.advance(days=4)
    assert review(caller, project_a, card_id, "hard", key="rebuild-3").status_code == 200
    logs = list(MemoryReviewLog.objects.filter(card_id=card_id).order_by("reviewed_at", "created_at"))
    return card_id, logs


def test_rebuild_matches_the_stored_card_after_three_reviews(caller, project_a, subject_a1, clock):
    card_id, logs = _three_reviews(caller, project_a, subject_a1, clock)
    assert len(logs) == 3

    response = caller.post(cards_url(project_a, f"/{card_id}/rebuild"), {}, key="rebuild-call")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["matches"] is True
    assert body["log_count"] == 3
    assert body["differing_fields"] == []
    assert body["rebuilt"]["phase"] == MemoryCardPhase.REVIEW
    assert body["rebuilt"]["reps"] == 3
    assert body["rebuilt"]["stability"] == pytest.approx(logs[-1].stability_after)
    assert body["rebuilt"]["due_at"] == logs[-1].due_after.isoformat()


def test_a_corrupted_card_is_detected_and_rebuild_reports_the_replayed_truth(caller, project_a, subject_a1, clock):
    card_id, logs = _three_reviews(caller, project_a, subject_a1, clock)
    truth = logs[-1].stability_after
    MemoryCard.objects.filter(id=card_id).update(stability=999.0, phase=MemoryCardPhase.NEW)

    response = caller.post(cards_url(project_a, f"/{card_id}/rebuild"), {}, key="rebuild-corrupt")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["matches"] is False
    assert set(body["differing_fields"]) >= {"stability", "phase"}
    assert body["rebuilt"]["stability"] == pytest.approx(truth)
    assert body["rebuilt"]["phase"] == MemoryCardPhase.REVIEW
    assert body["stored"]["stability"] == 999.0
    assert body["stored"]["phase"] == MemoryCardPhase.NEW

    # Reporting is not repairing: the rebuild endpoint never writes the card.
    card = MemoryCard.objects.get(id=card_id)
    assert card.stability == 999.0


# ---------------------------------------------------------------------- scope
def test_owner_isolation_returns_not_found(other_user, other_caller, project_a, subject_a1, caller):
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="scope-create").json()["card_id"]

    assert other_caller.get(cards_url(project_a)).status_code == 404
    assert other_caller.post(cards_url(project_a), {"question_id": str(question.id)}, key="x").status_code == 404
    assert review(other_caller, project_a, card_id, "good", key="x").status_code == 404
    assert other_caller.get(cards_url(project_a, f"/{card_id}/logs")).status_code == 404
    assert other_caller.post(cards_url(project_a, f"/{card_id}/rebuild"), {}, key="x").status_code == 404
    assert other_caller.post(cards_url(project_a, f"/{card_id}/suspend"), {"reason": "x"}, key="x").status_code == 404

    # A card id is not a capability either: the same id under the other user's
    # own project is simply not part of that project.
    own_project = exams_services.create_project(other_user, name="他人项目")
    assert review(other_caller, own_project, card_id, "good", key="x").status_code == 404
    assert other_caller.get(cards_url(own_project)).json() == []
    assert MemoryReviewLog.objects.count() == 0


def test_owner_isolation_of_the_other_users_project_returns_not_found(caller, other_user):
    own_project = exams_services.create_project(other_user, name="他人项目")
    response = caller.get(cards_url(own_project))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


# ------------------------------------------------------------- honest scope
def test_reviewing_cards_writes_no_learning_evidence_and_no_grade(caller, project_a, subject_a1, clock):
    before = {
        "evidence": LearningEvidence.objects.count(),
        "states": LearnerKnowledgeState.objects.count(),
        "grades": GradeEvent.objects.count(),
        "attempts": Attempt.objects.count(),
    }
    first, second = questions_for(subject_a1, 2)
    card_ids = [
        create_card(caller, project_a, first, key="honest-create-1").json()["card_id"],
        create_card(caller, project_a, second, key="honest-create-2").json()["card_id"],
    ]
    ratings = ("good", "good", "hard")
    for card_id in card_ids:
        for index, rating in enumerate(ratings):
            response = review(caller, project_a, card_id, rating, key=f"honest-{card_id}-{index}")
            assert response.status_code == 200, response.content
            clock.advance(days=2)

    # Six memory reviews happened, and the card projection moved ...
    assert MemoryReviewLog.objects.count() == len(card_ids) * len(ratings)
    assert MemoryCard.objects.get(id=card_ids[0]).reps == len(ratings)
    # ... while nothing outside the memory projection changed.
    assert LearningEvidence.objects.count() == before["evidence"]
    assert LearnerKnowledgeState.objects.count() == before["states"]
    assert GradeEvent.objects.count() == before["grades"]
    assert Attempt.objects.count() == before["attempts"]


# ------------------------------------------------------------------ lifecycle
def test_suspend_hides_the_card_and_resume_restores_it_unchanged(caller, project_a, subject_a1, clock):
    question = questions_for(subject_a1, 1)[0]
    card_id = create_card(caller, project_a, question, key="suspend-create").json()["card_id"]
    assert review(caller, project_a, card_id, "good", key="suspend-review").status_code == 200
    due_before_pause = MemoryCard.objects.get(id=card_id).due_at

    paused = caller.post(cards_url(project_a, f"/{card_id}/suspend"), {"reason": "出差一周"}, key="suspend-1")
    assert paused.status_code == 200, paused.content
    assert paused.json()["is_suspended"] is True
    assert paused.json()["suspended_reason"] == "出差一周"
    assert caller.get(cards_url(project_a)).json() == []
    with_suspended = caller.get(cards_url(project_a), include_suspended="true").json()
    assert [row["card_id"] for row in with_suspended] == [card_id]

    refused = review(caller, project_a, card_id, "good", key="suspend-review-2")
    assert refused.status_code == 400
    assert MemoryReviewLog.objects.filter(card_id=card_id).count() == 1

    resumed = caller.post(cards_url(project_a, f"/{card_id}/resume"), {}, key="resume-1")
    assert resumed.status_code == 200, resumed.content
    assert resumed.json()["is_suspended"] is False
    # Resuming never re-dates the card: an overdue card stays overdue.
    assert MemoryCard.objects.get(id=card_id).due_at == due_before_pause
    assert [row["card_id"] for row in caller.get(cards_url(project_a)).json()] == [card_id]


# ---------------------------------------------------------------- candidates
def test_review_candidates_explain_their_priority(owner, project_a, project_b, subject_a1, clock):
    question = questions_for(subject_a1, 1)[0]
    card = scheduler_service.create_card(user=owner, question=question)
    # Walk the card to the review phase, then let it go overdue: after ten days
    # its recall estimate is below the desired retention of 0.9.
    scheduler_service.review_card(card=card, rating="good", idempotency_key="cand-1")
    clock.advance(minutes=10)
    scheduler_service.review_card(card=card, rating="good", idempotency_key="cand-2")
    clock.advance(days=10)

    candidates = scheduler_service.review_candidates(user=owner, project=project_a, now=clock.moment)
    assert len(candidates) == 1
    row = candidates[0]
    assert row["card_id"] == str(card.id)
    assert set(row) >= {
        "card_id",
        "question_id",
        "knowledge_node_id",
        "subject_id",
        "due_at",
        "overdue_days",
        "retrievability",
        "priority",
        "reason_codes",
    }
    assert row["overdue_days"] > 5
    assert 0.0 < row["retrievability"] < 0.9
    assert {"due", "overdue", "low_retrievability"} <= set(row["reason_codes"])
    assert row["priority"] > 0

    # A brand-new card is explained as new rather than as "all but forgotten".
    other = questions_for(subject_a1, 2)[1]
    fresh = scheduler_service.create_card(user=owner, question=other)
    rows = scheduler_service.review_candidates(user=owner, project=project_a, now=clock.moment)
    fresh_row = next(item for item in rows if item["card_id"] == str(fresh.id))
    assert fresh_row["retrievability"] is None
    assert "new_card" in fresh_row["reason_codes"]
    assert [item["priority"] for item in rows] == sorted((item["priority"] for item in rows), reverse=True)
    # Another project never sees these cards.
    assert scheduler_service.review_candidates(user=owner, project=project_b, now=clock.moment) == []
