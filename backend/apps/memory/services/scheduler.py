"""FSRS card service: create, list, review, rebuild and rank active-recall cards.

The service owns every write to :class:`apps.memory.models.MemoryCard` and
:class:`apps.memory.models.MemoryReviewLog`. The scheduler itself lives in
:mod:`domain.memory.fsrs` and is pure; this module only supplies it with real
rows, a real clock and a transaction.

Honest scope rule — never weaken it
-----------------------------------
A memory card is a **memory projection only**. Reviewing a card must never
create ``LearningEvidence``, must never change ``LearnerKnowledgeState``, and
must never write a grade (``GradeEvent``/``Attempt``). Remembering a card is not
solving a question, so nothing here touches the practice, grading or learning
apps; the whole effect of a review is one immutable log row plus the card
projection. ``tests/integration/test_memory_cards.py`` asserts this by counting
every one of those tables before and after a review.

Clocks are injected, never read
-------------------------------
Every entry point accepts ``now``/``reviewed_at`` and falls back to the
module-level :func:`now` indirection, which tests monkeypatch. Nothing else in
this module reads the wall clock.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.common.enums import MemoryCardPhase, MemoryRating
from apps.common.errors import IdempotencyConflict, InvalidInput, ScopeViolation
from apps.common.scope import scoped_queryset
from apps.knowledge.models import QuestionKnowledge
from apps.memory.models import MemoryCard, MemoryReviewLog
from apps.question_bank.models import Question
from domain.memory import fsrs

#: Review logs are replayed in this order; ``created_at`` breaks same-instant ties.
LOG_ORDER = ("reviewed_at", "created_at")
#: Default and maximum page sizes, so one request can never scan the whole table.
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
#: At most this many of the earliest-due cards are scored by ``review_candidates``.
MAX_CANDIDATE_SCAN = 500
#: Priority weights, kept here so the number is explainable rather than opaque.
PRIORITY_FORGETTING_WEIGHT = 60.0
PRIORITY_OVERDUE_CAP_DAYS = 30.0
PRIORITY_LAPSE_WEIGHT = 0.5
PRIORITY_NEW_CARD_BONUS = 3.0
PRIORITY_RELEARNING_BONUS = 5.0


def now() -> datetime:
    """The single clock indirection of this module (tests inject a fixed time)."""
    return timezone.now()


def _moment(value: datetime | str | None) -> datetime:
    """Coerce an injected instant to an aware UTC datetime.

    Naive input is read as UTC (never as local time): the service must not turn a
    missing timezone into a silently different schedule. A ``+`` in a query
    string arrives decoded as a space unless the client encodes it, so
    ``...T09:00:00 00:00`` is accepted as the ``+00:00`` the caller meant; a
    date-only value is read as midnight UTC.
    """
    if value is None:
        return now()
    if isinstance(value, str):
        text = re.sub(r"\s(\d{2}:\d{2})$", r"+\1", value.strip())
        try:
            value = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError as exc:
            raise InvalidInput(message="时间必须是 ISO-8601 字符串") from exc
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def parse_moment(value: datetime | str | None) -> datetime | None:
    """Public coercion for query parameters; ``None`` stays ``None`` (no filter)."""
    if value is None:
        return None
    return _moment(value)


def _clamp_limit(limit: int | None, *, default: int = DEFAULT_LIMIT) -> int:
    if limit is None:
        return default
    return max(1, min(int(limit), MAX_LIMIT))


# --------------------------------------------------------------------- state
def card_state(card: MemoryCard) -> fsrs.CardState:
    """The scheduler state of one card row.

    ``scheduled_days`` is derived from ``due_at - last_reviewed_at`` instead of
    being stored twice: the interval a card is waiting out is already implied by
    its own two timestamps.
    """
    scheduled_days = 0.0
    if card.due_at is not None and card.last_reviewed_at is not None:
        scheduled_days = max(0.0, (card.due_at - card.last_reviewed_at).total_seconds() / 86400.0)
    return fsrs.CardState(
        stability=float(card.stability or 0.0),
        difficulty=float(card.difficulty or 0.0),
        phase=card.phase,
        reps=card.reps,
        lapses=card.lapses,
        learning_step=card.learning_step,
        last_reviewed_at=card.last_reviewed_at,
        due_at=card.due_at,
        scheduled_days=scheduled_days,
    )


def retrievability_now(card: MemoryCard, *, now: datetime | None = None) -> float | None:
    """Current ``R(t, S)``, or ``None`` when the card has no memory state yet.

    A ``new`` card is deliberately reported as ``None`` rather than as ``1.0``:
    the product must not present "never studied" as "perfectly remembered".
    """
    if card.last_reviewed_at is None or float(card.stability or 0.0) <= 0:
        return None
    moment = _moment(now)
    elapsed_days = max(0.0, (moment - card.last_reviewed_at).total_seconds() / 86400.0)
    return fsrs.retrievability(elapsed_days, float(card.stability))


def _primary_node(question: Question):
    """The primary knowledge node of the question's current version, if any."""
    version = question.current_published_version or question.versions.order_by("-version").first()
    if version is None:
        return None
    mapping = (
        QuestionKnowledge.objects.filter(question_version=version, is_primary=True)
        .select_related("node")
        .order_by("created_at")
        .first()
    )
    return mapping.node if mapping is not None else None


# -------------------------------------------------------------------- create
def get_or_create_card(*, user, question, actor=None) -> tuple[MemoryCard, bool]:
    """Idempotently ensure the (user, question) card exists.

    Returns ``(card, created)``.

    The question must be reachable through one of ``user``'s own projects, which
    is checked here rather than trusted from the caller. ``actor`` records who
    asked; it can never widen the scope, so the owner stays ``user``.
    """
    row = (
        Question.objects.select_related("subject__project", "current_published_version").filter(id=question.id).first()
    )
    if row is None:
        raise ScopeViolation(message="题目不存在或不在当前权限范围")
    project = row.subject.project
    if str(project.owner_id) != str(user.id):
        raise ScopeViolation(message="题目不存在或不在当前权限范围")

    existing = MemoryCard.objects.filter(user=user, question=row).first()
    if existing is not None:
        return existing, False

    moment = now()
    try:
        with transaction.atomic():
            card = MemoryCard.objects.create(
                user=user,
                project=project,
                subject=row.subject,
                question=row,
                knowledge_node=_primary_node(row),
                phase=MemoryCardPhase.NEW,
                stability=0.0,
                difficulty=0.0,
                # A brand-new card is immediately available for recall practice.
                due_at=moment,
                reps=0,
                lapses=0,
                learning_step=0,
                scheduler_version=fsrs.FSRS_VERSION,
                params_version=fsrs.FSRS_VERSION,
                desired_retention=fsrs.DEFAULT_DESIRED_RETENTION,
            )
    except IntegrityError:
        # A concurrent request created the same (user, question) card first.
        card = MemoryCard.objects.filter(user=user, question=row).first()
        if card is None:  # pragma: no cover - the unique constraint guarantees one
            raise
        return card, False
    return card, True


def create_card(*, user, question, actor=None) -> MemoryCard:
    """Create (or return the existing) card for ``user`` + ``question``."""
    card, _created = get_or_create_card(user=user, question=question, actor=actor)
    return card


# ------------------------------------------------------------------- reading
def card_queryset(*, user, project=None, include_suspended: bool = False):
    """Owner-scoped base queryset; suspension is opt-in, never implicit."""
    filters: dict[str, Any] = {} if include_suspended else {"is_suspended": False}
    return scoped_queryset(user, MemoryCard, project=project, **filters).select_related(
        "question", "question__current_published_version", "knowledge_node", "subject", "project"
    )


def due_cards(*, user, project=None, now: datetime | None = None, limit: int | None = None) -> list[MemoryCard]:
    """Cards that are due at ``now``, earliest deadline first.

    A card with no ``due_at`` counts as due: it has never been scheduled, so
    there is no reason to hide it.
    """
    moment = _moment(now)
    queryset = (
        card_queryset(user=user, project=project)
        .filter(Q(due_at__isnull=True) | Q(due_at__lte=moment))
        .order_by("due_at", "created_at")
    )
    return list(queryset[: _clamp_limit(limit)])


def list_cards(
    *,
    user,
    project=None,
    due_before: datetime | None = None,
    include_suspended: bool = False,
    limit: int | None = None,
) -> list[MemoryCard]:
    """Cards for the list endpoint: due first, suspended excluded by default."""
    queryset = card_queryset(user=user, project=project, include_suspended=include_suspended)
    if due_before is not None:
        queryset = queryset.filter(due_at__isnull=False, due_at__lte=due_before)
    return list(queryset.order_by("due_at", "created_at")[: _clamp_limit(limit)])


def _excerpt(version) -> str:
    """First text block of the stem, trimmed; never options or answers."""
    content = (getattr(version, "content", None) or {}) if version is not None else {}
    for block in content.get("blocks") or []:
        if isinstance(block, dict) and block.get("kind") == "text" and block.get("text"):
            return str(block["text"]).strip()[:160]
    for block in content.get("blocks") or []:
        if isinstance(block, dict) and block.get("text"):
            return str(block["text"]).strip()[:160]
    return ""


def card_payload(card: MemoryCard, *, now: datetime | None = None) -> dict:
    """Wire payload for one card. Memory state only — no grade, no ability."""
    question = card.question
    return {
        "card_id": str(card.id),
        "project_id": str(card.project_id),
        "subject_id": str(card.subject_id),
        "question_id": str(card.question_id),
        "question_label": question.display_label if question is not None else "",
        "stem_excerpt": _excerpt(getattr(question, "current_published_version", None)),
        "knowledge_node_id": str(card.knowledge_node_id) if card.knowledge_node_id else None,
        "knowledge_node_name": card.knowledge_node.canonical_name if card.knowledge_node_id else "",
        "phase": card.phase,
        "due_at": card.due_at.isoformat() if card.due_at else None,
        "last_reviewed_at": card.last_reviewed_at.isoformat() if card.last_reviewed_at else None,
        "stability": round(float(card.stability or 0.0), 6),
        "difficulty": round(float(card.difficulty or 0.0), 6),
        "retrievability": (None if (value := retrievability_now(card, now=now)) is None else round(value, 6)),
        "reps": card.reps,
        "lapses": card.lapses,
        "learning_step": card.learning_step,
        "is_suspended": card.is_suspended,
        "suspended_reason": card.suspended_reason,
        "scheduler_version": card.scheduler_version,
        "params_version": card.params_version,
        "desired_retention": card.desired_retention,
    }


def log_payload(log: MemoryReviewLog) -> dict:
    return {
        "log_id": str(log.id),
        "card_id": str(log.card_id),
        "rating": log.rating,
        "reviewed_at": log.reviewed_at.isoformat(),
        "elapsed_days": log.elapsed_days,
        "scheduled_days": log.scheduled_days,
        "interval_days": log.interval_days,
        "retrievability": log.retrievability,
        "is_lapse": log.is_lapse,
        "phase_before": log.phase_before,
        "phase_after": log.phase_after,
        "stability_before": log.stability_before,
        "stability_after": log.stability_after,
        "difficulty_before": log.difficulty_before,
        "difficulty_after": log.difficulty_after,
        "due_before": log.due_before.isoformat() if log.due_before else None,
        "due_after": log.due_after.isoformat() if log.due_after else None,
        "scheduler_version": log.scheduler_version,
        "params_version": log.params_version,
        "source_session_item_id": str(log.source_session_item_id) if log.source_session_item_id else None,
        "note": log.note,
    }


def recent_logs(card: MemoryCard, *, limit: int | None = None) -> list[MemoryReviewLog]:
    """Newest first, capped: the ledger is append-only, so this is a real window."""
    return list(card.logs.order_by("-reviewed_at", "-created_at")[: _clamp_limit(limit)])


# -------------------------------------------------------------------- review
def _normalize_rating(rating) -> str:
    value = str(getattr(rating, "value", rating) or "").strip().lower()
    if value not in MemoryRating.values:
        raise InvalidInput(
            message=f"未知的记忆评级：{rating!r}",
            details={"allowed": list(MemoryRating.values)},
        )
    return value


def _validate_key(idempotency_key: str) -> str:
    key = (idempotency_key or "").strip()
    if not key:
        raise InvalidInput(message="复习记忆卡必须携带 Idempotency-Key 请求头")
    if len(key) > 200:
        raise InvalidInput(message="Idempotency-Key 过长（最多 200 字符）")
    return key


def _counters_at(card: MemoryCard, log: MemoryReviewLog) -> tuple[int, int]:
    """``(reps, lapses)`` after this log, recomputed from the ledger.

    Recomputing keeps a replayed response identical to the original one even
    when the card row has already moved on to a later review.
    """
    prefix = MemoryReviewLog.objects.filter(card_id=card.id).filter(
        Q(reviewed_at__lt=log.reviewed_at) | Q(reviewed_at=log.reviewed_at, created_at__lte=log.created_at)
    )
    rows = list(prefix.order_by(*LOG_ORDER).values_list("is_lapse", flat=True))
    return len(rows), sum(1 for is_lapse in rows if is_lapse)


def _result_from_log(card: MemoryCard, log: MemoryReviewLog, *, replayed: bool) -> dict:
    reps, lapses = _counters_at(card, log)
    return {
        "card_id": str(card.id),
        "log_id": str(log.id),
        "rating": log.rating,
        "phase": log.phase_after,
        "phase_before": log.phase_before,
        "due_at": log.due_after.isoformat() if log.due_after else None,
        "reviewed_at": log.reviewed_at.isoformat(),
        "interval_days": log.interval_days,
        "elapsed_days": log.elapsed_days,
        "scheduled_days": log.scheduled_days,
        "retrievability": log.retrievability,
        "stability": log.stability_after,
        "difficulty": log.difficulty_after,
        "is_lapse": log.is_lapse,
        "reps": reps,
        "lapses": lapses,
        "scheduler_version": log.scheduler_version,
        "params_version": log.params_version,
        "idempotent_replay": replayed,
    }


@transaction.atomic
def review_card(
    *,
    card: MemoryCard,
    rating,
    idempotency_key: str,
    reviewed_at: datetime | str | None = None,
    source_session_item=None,
) -> dict:
    """Record exactly one review of ``card`` and reschedule it.

    The card row is locked with ``select_for_update`` for the whole decision, so
    two concurrent reviews of the same card can never both start from the same
    state. ``idempotency_key`` is unique per card:

    * same key + same rating   -> the stored log is replayed, no second write,
    * same key + other rating  -> :class:`IdempotencyConflict` (409),
    * blank key                -> :class:`InvalidInput` (400).

    This write is confined to the memory projection. It creates **no**
    ``LearningEvidence``, leaves ``LearnerKnowledgeState`` untouched and writes
    no grade or attempt: card recall is not problem-solving evidence.

    ``card`` must already be owner-scoped by the caller (the API resolves it
    through ``scoped_queryset``); this function re-reads it under the lock and
    never widens that scope.
    """
    grade = _normalize_rating(rating)
    key = _validate_key(idempotency_key)

    locked = MemoryCard.objects.select_for_update().filter(id=card.id).first()
    if locked is None:
        raise ScopeViolation(message="记忆卡不存在或不在当前权限范围")
    # Reload related rows without the lock: PostgreSQL cannot apply FOR UPDATE to
    # the nullable side of an outer join (the knowledge node is nullable).
    locked = MemoryCard.objects.select_related("question", "knowledge_node", "project").filter(id=locked.id).first()
    if locked.is_suspended:
        raise InvalidInput(message="卡片已暂停，恢复后才能复习")

    existing = MemoryReviewLog.objects.filter(card=locked, idempotency_key=key).first()
    if existing is not None:
        if existing.rating != grade:
            raise IdempotencyConflict(
                message="相同幂等键使用了不同的评级",
                details={"card_id": str(locked.id), "stored_rating": existing.rating, "rating": grade},
            )
        return _result_from_log(locked, existing, replayed=True)

    if source_session_item is not None:
        from apps.practice.models import SessionItem

        item_id = getattr(source_session_item, "id", source_session_item)
        item = (
            SessionItem.objects.select_related("session")
            .filter(
                id=item_id,
                session__user=locked.user,
                session__project_id=locked.project_id,
            )
            .first()
        )
        if item is None:
            raise ScopeViolation(message="题项不存在或不属于该项目的当前用户")
        source_session_item = item

    moment = _moment(reviewed_at)
    state_before = card_state(locked)
    result = fsrs.schedule(
        state_before,
        grade,
        moment,
        weights=fsrs.weights_for(locked.params_version),
        desired_retention=locked.desired_retention,
    )

    log = MemoryReviewLog.objects.create(
        card=locked,
        user=locked.user,
        rating=grade,
        reviewed_at=moment,
        elapsed_days=result.elapsed_days,
        scheduled_days=state_before.scheduled_days,
        interval_days=result.interval_days,
        retrievability=result.retrievability,
        is_lapse=result.is_lapse,
        phase_before=state_before.phase,
        phase_after=result.phase_after,
        stability_before=state_before.stability,
        stability_after=result.state.stability,
        difficulty_before=state_before.difficulty,
        difficulty_after=result.state.difficulty,
        due_before=state_before.due_at,
        due_after=result.state.due_at,
        scheduler_version=result.scheduler_version,
        params_version=locked.params_version,
        idempotency_key=key,
        source_session_item=source_session_item,
    )

    locked.phase = result.state.phase
    locked.stability = result.state.stability
    locked.difficulty = result.state.difficulty
    locked.due_at = result.state.due_at
    locked.last_reviewed_at = result.state.last_reviewed_at
    locked.reps = result.state.reps
    locked.lapses = result.state.lapses
    locked.learning_step = result.state.learning_step
    locked.scheduler_version = result.scheduler_version
    locked.save(
        update_fields=[
            "phase",
            "stability",
            "difficulty",
            "due_at",
            "last_reviewed_at",
            "reps",
            "lapses",
            "learning_step",
            "scheduler_version",
            "updated_at",
        ]
    )
    return _result_from_log(locked, log, replayed=False)


# ------------------------------------------------------------------- rebuild
def _state_payload(state: fsrs.CardState, *, scheduler_version: str, params_version: str) -> dict:
    return {
        "phase": state.phase,
        "stability": state.stability,
        "difficulty": state.difficulty,
        "reps": state.reps,
        "lapses": state.lapses,
        "learning_step": state.learning_step,
        "due_at": state.due_at.isoformat() if state.due_at else None,
        "last_reviewed_at": state.last_reviewed_at.isoformat() if state.last_reviewed_at else None,
        "scheduler_version": scheduler_version,
        "params_version": params_version,
    }


def rebuild_card_from_logs(card: MemoryCard) -> dict:
    """Recompute a card by replaying its logs; report whether it still matches.

    Recovery evidence (acceptance B06): the logs are the ledger, the card row is
    only a projection. Each log is replayed with the ``params_version`` it
    recorded, in ``reviewed_at`` order, so a card whose row was edited by hand —
    or written by an older parameter set — is detected instead of trusted.

    ``matches`` is a strict equality on the scheduled facts. When it is
    ``False``, ``rebuilt`` is the replayed truth and ``stored`` is what the row
    currently says; nothing is written by this function, so the caller decides
    how to recover. Note that replay uses the card's *current*
    ``desired_retention`` (a per-card setting, not logged per review), so
    changing that setting on a reviewed card legitimately reports a mismatch.
    """
    logs = list(MemoryReviewLog.objects.filter(card=card).order_by(*LOG_ORDER))
    state = fsrs.CardState()
    params_version = card.params_version
    scheduler_version = card.scheduler_version
    unknown_versions: list[str] = []
    for log in logs:
        try:
            weights = fsrs.weights_for(log.params_version)
        except KeyError:
            unknown_versions.append(log.params_version)
            weights = fsrs.DEFAULT_WEIGHTS
        result = fsrs.schedule(
            state,
            log.rating,
            log.reviewed_at,
            weights=weights,
            desired_retention=card.desired_retention,
        )
        state = result.state
        params_version = log.params_version
        scheduler_version = log.scheduler_version

    rebuilt = _state_payload(state, scheduler_version=scheduler_version, params_version=params_version)
    stored = _state_payload(
        card_state(card), scheduler_version=card.scheduler_version, params_version=card.params_version
    )
    # A card with no logs has never been scheduled, so its creation default for
    # `due_at` is not replayable and must not be reported as a mismatch.
    compared = [key for key in rebuilt if logs or key not in ("due_at", "last_reviewed_at")]
    differing = [key for key in compared if rebuilt[key] != stored[key]]
    return {
        "matches": not differing,
        "rebuilt": rebuilt,
        "stored": stored,
        "log_count": len(logs),
        "compared_fields": compared,
        "differing_fields": differing,
        "unknown_params_versions": sorted(set(unknown_versions)),
    }


# ---------------------------------------------------------------- candidates
def _candidate(card: MemoryCard, moment: datetime) -> dict:
    """One explainable review candidate for the daily planner.

    A card with no memory state yet counts as the highest forgetting risk (it has
    never been recalled in this system) and is labelled ``new_card`` rather than
    being given a fabricated retrievability.
    """
    due_at = card.due_at
    overdue_days = 0.0
    if due_at is not None:
        overdue_days = max(0.0, (moment - due_at).total_seconds() / 86400.0)
    value = retrievability_now(card, now=moment)
    reason_codes: list[str] = []
    if card.phase == MemoryCardPhase.NEW:
        reason_codes.append("new_card")
    if due_at is None or due_at <= moment:
        reason_codes.append("due")
    if overdue_days >= 1.0:
        reason_codes.append("overdue")
    if card.lapses > 0:
        reason_codes.append("lapsed")
    if card.phase == MemoryCardPhase.RELEARNING:
        reason_codes.append("relearning")
    if value is not None and value < float(card.desired_retention or fsrs.DEFAULT_DESIRED_RETENTION):
        reason_codes.append("low_retrievability")

    priority = PRIORITY_FORGETTING_WEIGHT * (1.0 - (value if value is not None else 0.0))
    priority += min(overdue_days, PRIORITY_OVERDUE_CAP_DAYS)
    priority += PRIORITY_LAPSE_WEIGHT * min(card.lapses, 10)
    if card.phase == MemoryCardPhase.NEW:
        priority += PRIORITY_NEW_CARD_BONUS
    if card.phase == MemoryCardPhase.RELEARNING:
        priority += PRIORITY_RELEARNING_BONUS

    return {
        "card_id": str(card.id),
        "question_id": str(card.question_id),
        "question_label": card.question.display_label if card.question_id else "",
        "knowledge_node_id": str(card.knowledge_node_id) if card.knowledge_node_id else None,
        "knowledge_node_name": card.knowledge_node.canonical_name if card.knowledge_node_id else "",
        "subject_id": str(card.subject_id),
        "phase": card.phase,
        "due_at": due_at.isoformat() if due_at else None,
        "overdue_days": round(overdue_days, 4),
        "retrievability": None if value is None else round(value, 6),
        "priority": round(priority, 4),
        "lapses": card.lapses,
        "reps": card.reps,
        "reason_codes": reason_codes,
    }


def review_candidates(*, user, project, now: datetime | None = None, limit: int | None = None) -> list[dict]:
    """Explainable memory-review priorities for one project, highest first.

    Every number is derived from the card's own row: how overdue it is, what the
    FSRS estimate of recall is right now, and how often it has been forgotten.
    ``reason_codes`` says which of those applied, so the planner can show why a
    card was suggested instead of presenting an opaque score.

    This function only *ranks*; it never creates a ``StudyTask`` and never
    touches learning state. Another workstream wires it into the planner.
    """
    moment = _moment(now)
    cards = card_queryset(user=user, project=project).order_by("due_at", "created_at")[:MAX_CANDIDATE_SCAN]
    rows = [_candidate(card, moment) for card in cards]
    rows.sort(key=lambda row: (-row["priority"], row["due_at"] or "", row["card_id"]))
    return rows[: _clamp_limit(limit, default=20)]


# ------------------------------------------------------------------ lifecycle
@transaction.atomic
def suspend_card(*, card: MemoryCard, reason: str = "") -> MemoryCard:
    """Pause a card without touching its schedule.

    Suspension never deletes the card and never rewrites the FSRS state: the
    card simply stops being offered until it is resumed. ``card`` must already be
    owner-scoped by the caller.
    """
    locked = MemoryCard.objects.select_for_update().filter(id=card.id).first()
    if locked is None:
        raise ScopeViolation(message="记忆卡不存在或不在当前权限范围")
    locked.is_suspended = True
    locked.suspended_reason = (reason or "")[:300]
    locked.save(update_fields=["is_suspended", "suspended_reason", "updated_at"])
    return locked


@transaction.atomic
def resume_card(*, card: MemoryCard) -> MemoryCard:
    """Resume a card; an overdue card stays overdue instead of being re-dated."""
    locked = MemoryCard.objects.select_for_update().filter(id=card.id).first()
    if locked is None:
        raise ScopeViolation(message="记忆卡不存在或不在当前权限范围")
    locked.is_suspended = False
    locked.suspended_reason = ""
    locked.save(update_fields=["is_suspended", "suspended_reason", "updated_at"])
    return locked
