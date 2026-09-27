"""Memory API: FSRS active-recall cards, reviews, logs and recovery evidence.

Every operation is owner-scoped through ``project_scoped_router`` +
``require_project``: another user's project or card is reported as 404, never as
403, so an outsider cannot probe for existence (docs/03 §8).

The review endpoint is where the product's honesty rule is easiest to break, so
it is stated here as well: a review writes exactly one ``MemoryReviewLog`` row
and updates the card projection. It never creates ``LearningEvidence``, never
changes ``LearnerKnowledgeState`` and never writes a grade or an attempt.
Reviewing a card is recall practice, not proof of solving ability.

Review idempotency lives in the memory ledger itself (``(card,
idempotency_key)`` is unique), not in the generic request journal: the same key
replays the stored log, which is also the evidence used by ``/rebuild``.
"""

from __future__ import annotations

from ninja import Schema

from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.errors import ScopeViolation
from apps.common.scope import require_project, scoped_queryset
from apps.memory.models import MemoryCard
from apps.memory.services import scheduler as scheduler_service
from apps.question_bank.models import Question

memory_router = project_scoped_router(tags=["memory"])

#: Hard cap of the log window, so the ledger can never be dumped in one request.
MAX_LOG_LIMIT = 200


class MemoryCardOut(Schema):
    card_id: str
    project_id: str
    subject_id: str
    question_id: str
    question_label: str
    stem_excerpt: str
    knowledge_node_id: str | None = None
    knowledge_node_name: str
    phase: str
    due_at: str | None = None
    last_reviewed_at: str | None = None
    stability: float
    difficulty: float
    #: ``None`` for a card that has never been reviewed: no memory state exists.
    retrievability: float | None = None
    reps: int
    lapses: int
    learning_step: int
    is_suspended: bool
    suspended_reason: str
    scheduler_version: str
    params_version: str
    desired_retention: float


class MemoryCardCreateIn(Schema):
    question_id: str


class MemoryReviewIn(Schema):
    rating: str
    source_session_item_id: str | None = None


class MemoryReviewOut(Schema):
    card_id: str
    log_id: str
    rating: str
    phase: str
    phase_before: str
    due_at: str | None = None
    reviewed_at: str
    interval_days: float
    elapsed_days: float
    scheduled_days: float
    retrievability: float
    stability: float
    difficulty: float
    is_lapse: bool
    reps: int
    lapses: int
    scheduler_version: str
    params_version: str


class MemoryReviewLogOut(Schema):
    log_id: str
    card_id: str
    rating: str
    reviewed_at: str
    elapsed_days: float
    scheduled_days: float
    interval_days: float
    retrievability: float
    is_lapse: bool
    phase_before: str
    phase_after: str
    stability_before: float
    stability_after: float
    difficulty_before: float
    difficulty_after: float
    due_before: str | None = None
    due_after: str | None = None
    scheduler_version: str
    params_version: str
    source_session_item_id: str | None = None
    note: str


class MemoryRebuildOut(Schema):
    matches: bool
    rebuilt: dict
    stored: dict
    log_count: int
    compared_fields: list[str]
    differing_fields: list[str]
    unknown_params_versions: list[str]


class SuspendIn(Schema):
    reason: str = ""


def _card_or_404(user, project, card_id: str) -> MemoryCard:
    """Owner-scoped card lookup; a card outside the scope is simply not there."""
    card = (
        scoped_queryset(user, MemoryCard, project=project)
        .select_related("question", "question__current_published_version", "knowledge_node", "subject", "project")
        .filter(id=card_id)
        .first()
    )
    if card is None:
        raise ScopeViolation(message="记忆卡不存在或不属于该项目")
    return card


@memory_router.get("/projects/{project_id}/memory-cards", auth=auth, response=list[MemoryCardOut])
def list_memory_cards(
    request,
    project_id: str,
    due_before: str | None = None,
    include_suspended: bool = False,
    limit: int = 50,
):
    """Due-first card list; suspended cards are excluded unless asked for."""
    project = require_project(request.user, project_id)
    cards = scheduler_service.list_cards(
        user=request.user,
        project=project,
        due_before=scheduler_service.parse_moment(due_before),
        include_suspended=include_suspended,
        limit=limit,
    )
    return [scheduler_service.card_payload(card) for card in cards]


@memory_router.post("/projects/{project_id}/memory-cards", auth=auth, response={200: MemoryCardOut, 201: MemoryCardOut})
def create_memory_card(request, project_id: str, payload: MemoryCardCreateIn):
    """Ensure one card per (user, question); 201 when created, 200 when it exists."""
    project = require_project(request.user, project_id)
    question = Question.objects.filter(id=payload.question_id, subject__project=project).first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    card, created = scheduler_service.get_or_create_card(user=request.user, question=question, actor=request.user)
    return (201 if created else 200), scheduler_service.card_payload(card)


@memory_router.post("/projects/{project_id}/memory-cards/{card_id}/review", auth=auth, response=MemoryReviewOut)
def review_memory_card(request, project_id: str, card_id: str, payload: MemoryReviewIn):
    """Record one recall review; a repeated Idempotency-Key replays the same log."""
    project = require_project(request.user, project_id)
    card = _card_or_404(request.user, project, card_id)
    key = idempotency_key(request)
    return scheduler_service.review_card(
        card=card,
        rating=payload.rating,
        idempotency_key=key,
        source_session_item=payload.source_session_item_id,
    )


@memory_router.get("/projects/{project_id}/memory-cards/{card_id}/logs", auth=auth, response=list[MemoryReviewLogOut])
def list_memory_card_logs(request, project_id: str, card_id: str, limit: int = MAX_LOG_LIMIT):
    """The append-only ledger, newest first, capped at :data:`MAX_LOG_LIMIT`."""
    project = require_project(request.user, project_id)
    card = _card_or_404(request.user, project, card_id)
    return [
        scheduler_service.log_payload(log)
        for log in scheduler_service.recent_logs(card, limit=min(max(1, limit), MAX_LOG_LIMIT))
    ]


@memory_router.post("/projects/{project_id}/memory-cards/{card_id}/rebuild", auth=auth, response=MemoryRebuildOut)
def rebuild_memory_card(request, project_id: str, card_id: str):
    """Replay the logs and report whether the stored card still matches them."""
    project = require_project(request.user, project_id)
    card = _card_or_404(request.user, project, card_id)
    return scheduler_service.rebuild_card_from_logs(card)


@memory_router.post("/projects/{project_id}/memory-cards/{card_id}/suspend", auth=auth, response=MemoryCardOut)
def suspend_memory_card(request, project_id: str, card_id: str, payload: SuspendIn):
    """Pause a card; its schedule is kept, it is only no longer offered."""
    project = require_project(request.user, project_id)
    card = _card_or_404(request.user, project, card_id)
    suspended = scheduler_service.suspend_card(card=card, reason=payload.reason)
    return scheduler_service.card_payload(suspended)


@memory_router.post("/projects/{project_id}/memory-cards/{card_id}/resume", auth=auth, response=MemoryCardOut)
def resume_memory_card(request, project_id: str, card_id: str):
    """Resume a card without re-dating it: overdue stays overdue."""
    project = require_project(request.user, project_id)
    card = _card_or_404(request.user, project, card_id)
    resumed = scheduler_service.resume_card(card=card)
    return scheduler_service.card_payload(resumed)
