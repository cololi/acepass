"""FSRS-4.5 active-recall scheduling, implemented here in pure Python.

This module is the only place that decides when a memory card comes back. It is
deliberately dependency-free — no Django, no database, no third-party package —
so the scheduler can be unit-tested against fixed inputs and so a stored card
stays reproducible years later. Nothing here reads the wall clock, the settings
object or the database: every instant arrives through ``reviewed_at`` and every
number is derived from the published FSRS-4.5 formulas reproduced below.

Card memory is *not* problem-solving ability. This module estimates retention
for one card only; it never produces a score, a grade or a knowledge state.

FSRS-4.5 formulas (``G`` is the grade 1..4 = again/hard/good/easy, ``t`` is the
elapsed time in days, ``S`` the stability in days and ``D`` the difficulty on a
1..10 scale)::

    R(t, S) = (1 + FACTOR * t / S) ** DECAY
    I(S)    = S / FACTOR * (R_desired ** (1 / DECAY) - 1)
    S_0(G)  = w[G - 1]
    D_0(G)  = clamp(w4 - (G - 3) * w5, 1, 10)
    S'_s    = S * (1 + e^{w8} * (11 - D) * S^{-w9} * (e^{w10 * (1 - R)} - 1)
                   * hard_penalty * easy_bonus)
    S'_f    = w11 * D^{-w12} * ((S + 1)^{w13} - 1) * e^{w14 * (1 - R)}
    D'      = clamp(w7 * D_0(3) + (1 - w7) * (D - w6 * (G - 3)), 1, 10)

``hard_penalty`` is ``w15`` for a ``hard`` grade and ``easy_bonus`` is ``w16``
for ``easy``; both are ``1`` for every other grade. With ``FACTOR = 19/81`` and
a desired retention of ``0.9`` the interval equals the stability, which is why
the published defaults use exactly that pair.

Sub-day scheduling (the short learning steps) is *not* part of FSRS-4.5 — that
came with FSRS-5's ``w17``/``w18``. AcePass therefore applies the fixed steps
below while a card is still ``new``/``learning``/``relearning``, and switches to
the stability-based interval once the card graduates to ``review``:

* ``again`` -> 1 minute, back to step 0 (and to ``relearning`` after a lapse),
* ``hard``  -> 5 minutes, staying on the current step,
* ``good``  -> the next step (10 minutes); after the last step the card
  graduates to ``review`` with the stability-based interval,
* ``easy``  -> graduates immediately with the stability-based interval.

A review that happens minutes after the previous one has ``R = 1``, so the
FSRS-4.5 success formula leaves the stability untouched: learning steps cannot
inflate memory strength, which is exactly what the algorithm intends.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

#: Algorithm identity stored on every card and review log.
FSRS_VERSION = "fsrs-4.5-default-v1"

#: The published FSRS-4.5 default parameters (w0..w16).
DEFAULT_WEIGHTS: tuple[float, ...] = (
    0.4872,
    1.4003,
    3.7145,
    13.8206,
    5.1618,
    1.2298,
    0.8975,
    0.031,
    1.6474,
    0.1367,
    1.0461,
    2.1072,
    0.0793,
    0.3246,
    1.587,
    0.2272,
    2.8755,
)

#: ``params_version`` -> weights. Old versions stay registered so a card written
#: under an earlier parameter set remains reproducible by replaying its logs.
WEIGHTS_BY_VERSION: dict[str, tuple[float, ...]] = {FSRS_VERSION: DEFAULT_WEIGHTS}

DEFAULT_DESIRED_RETENTION = 0.9
DECAY = -0.5
#: 19/81 makes ``I(S) == S`` at ``DEFAULT_DESIRED_RETENTION``.
FACTOR = 19.0 / 81.0
MAX_INTERVAL_DAYS = 36500

RATING_AGAIN = "again"
RATING_HARD = "hard"
RATING_GOOD = "good"
RATING_EASY = "easy"
RATINGS: tuple[str, ...] = (RATING_AGAIN, RATING_HARD, RATING_GOOD, RATING_EASY)

#: Grade numbers used by the FSRS formulas (1..4).
_GRADE_BY_RATING = {RATING_AGAIN: 1, RATING_HARD: 2, RATING_GOOD: 3, RATING_EASY: 4}

PHASE_NEW = "new"
PHASE_LEARNING = "learning"
PHASE_REVIEW = "review"
PHASE_RELEARNING = "relearning"
PHASES: tuple[str, ...] = (PHASE_NEW, PHASE_LEARNING, PHASE_REVIEW, PHASE_RELEARNING)

#: ``good`` walks one step per review; the last step graduates the card.
LEARNING_STEP_MINUTES: tuple[int, ...] = (1, 10)
#: ``hard`` repeats the current step with the average of the surrounding steps.
HARD_STEP_MINUTES = 5
MINUTES_PER_DAY = 1440.0

__all__ = [
    "DECAY",
    "DEFAULT_DESIRED_RETENTION",
    "DEFAULT_WEIGHTS",
    "FACTOR",
    "FSRS_VERSION",
    "HARD_STEP_MINUTES",
    "LEARNING_STEP_MINUTES",
    "MAX_INTERVAL_DAYS",
    "PHASE_LEARNING",
    "PHASE_NEW",
    "PHASE_RELEARNING",
    "PHASE_REVIEW",
    "PHASES",
    "RATINGS",
    "RATING_AGAIN",
    "RATING_EASY",
    "RATING_GOOD",
    "RATING_HARD",
    "WEIGHTS_BY_VERSION",
    "CardState",
    "ScheduleResult",
    "initial_difficulty",
    "initial_stability",
    "next_difficulty",
    "next_interval_days",
    "recall_stability",
    "forget_stability",
    "retrievability",
    "schedule",
    "weights_for",
]


@dataclass(frozen=True)
class CardState:
    """Everything about one card the scheduler needs, and nothing else.

    ``scheduled_days`` is the interval the card is currently waiting out (the
    value set when it was last reviewed); ``elapsed_days`` records how long it
    actually waited before the review that produced this state. A brand-new card
    has no memory yet: stability and difficulty are ``0`` and ``phase`` is
    ``new``.
    """

    stability: float = 0.0
    difficulty: float = 0.0
    phase: str = PHASE_NEW
    reps: int = 0
    lapses: int = 0
    learning_step: int = 0
    last_reviewed_at: datetime | None = None
    due_at: datetime | None = None
    scheduled_days: float = 0.0
    elapsed_days: float = 0.0


@dataclass(frozen=True)
class ScheduleResult:
    """The scheduled outcome of exactly one review.

    ``state`` is the next :class:`CardState`; the remaining fields explain it:
    ``retrievability`` is ``R(t, S)`` measured with the *incoming* state,
    ``interval_days`` is the interval just scheduled, ``elapsed_days`` the time
    actually observed since the previous review, ``phase_after`` the phase the
    card moved to and ``is_lapse`` whether a ``review`` card was forgotten.
    """

    state: CardState
    retrievability: float
    interval_days: float
    elapsed_days: float
    phase_after: str
    is_lapse: bool
    scheduler_version: str = FSRS_VERSION

    @property
    def next_state(self) -> CardState:
        """Alias for :attr:`state`, so callers can read either name."""
        return self.state


# --------------------------------------------------------------------- helpers
def _normalize_rating(rating: str) -> str:
    value = getattr(rating, "value", rating)
    text = str(value).strip().lower()
    if text not in _GRADE_BY_RATING:
        raise ValueError(f"unknown memory rating: {rating!r}")
    return text


def _normalize_moment(moment: datetime) -> datetime:
    """Naive input is read as UTC; aware input is converted to UTC.

    The scheduler must never invent "now", so a missing timezone is an explicit
    assumption rather than an implicit local-time read.
    """
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def _validate_weights(weights: tuple[float, ...]) -> tuple[float, ...]:
    values = tuple(float(weight) for weight in weights)
    if len(values) != 17:
        raise ValueError(f"FSRS-4.5 needs exactly 17 weights, got {len(values)}")
    return values


def weights_for(params_version: str) -> tuple[float, ...]:
    """Weights registered for one ``params_version``.

    Replay must use the parameters a card was actually scheduled with, so an
    unknown version is an error rather than a silent fallback to today's
    defaults.
    """
    try:
        return WEIGHTS_BY_VERSION[params_version]
    except KeyError as exc:  # pragma: no cover - guarded by the registry above
        raise KeyError(f"unknown FSRS params_version: {params_version!r}") from exc


def retrievability(elapsed_days: float, stability: float) -> float:
    """``R(t, S)``: the probability of recall after ``elapsed_days`` days.

    A card without a memory state (``stability <= 0``) has nothing to decay, so
    the estimate is ``1.0``; callers must read the phase to tell "no memory yet"
    apart from "just reviewed".
    """
    if stability <= 0:
        return 1.0
    elapsed = max(0.0, float(elapsed_days))
    value = (1.0 + FACTOR * elapsed / stability) ** DECAY
    return min(1.0, max(0.0, value))


def initial_stability(rating: str, weights: tuple[float, ...] = DEFAULT_WEIGHTS) -> float:
    """``S_0(G) = w[G - 1]``."""
    values = _validate_weights(weights)
    return float(values[_GRADE_BY_RATING[_normalize_rating(rating)] - 1])


def initial_difficulty(rating: str, weights: tuple[float, ...] = DEFAULT_WEIGHTS) -> float:
    """``D_0(G) = clamp(w4 - (G - 3) * w5, 1, 10)``."""
    values = _validate_weights(weights)
    grade = _GRADE_BY_RATING[_normalize_rating(rating)]
    return clamp_difficulty(values[4] - (grade - 3) * values[5])


def clamp_difficulty(value: float) -> float:
    return min(10.0, max(1.0, float(value)))


def next_interval_days(stability: float, desired_retention: float = DEFAULT_DESIRED_RETENTION) -> float:
    """``I(S)`` rounded to whole days and clamped to ``[1, MAX_INTERVAL_DAYS]``.

    The rounding is ``floor(x + 0.5)`` rather than :func:`round` so a stored
    interval never depends on banker's rounding.
    """
    if stability <= 0:
        return 1.0
    retention = min(0.99, max(0.05, float(desired_retention)))
    raw = stability / FACTOR * (retention ** (1.0 / DECAY) - 1.0)
    return float(min(MAX_INTERVAL_DAYS, max(1, math.floor(raw + 0.5))))


def recall_stability(
    stability: float,
    difficulty: float,
    retrievability_value: float,
    rating: str,
    weights: tuple[float, ...] = DEFAULT_WEIGHTS,
) -> float:
    """``S'_s``: successful recall grows stability, harder ratings grow it less."""
    values = _validate_weights(weights)
    grade = _GRADE_BY_RATING[_normalize_rating(rating)]
    hard_penalty = values[15] if grade == 2 else 1.0
    easy_bonus = values[16] if grade == 4 else 1.0
    growth = (
        math.exp(values[8])
        * (11.0 - difficulty)
        * (stability ** -values[9])
        * (math.exp((1.0 - retrievability_value) * values[10]) - 1.0)
        * hard_penalty
        * easy_bonus
    )
    return max(0.01, stability * (1.0 + growth))


def forget_stability(
    stability: float,
    difficulty: float,
    retrievability_value: float,
    weights: tuple[float, ...] = DEFAULT_WEIGHTS,
) -> float:
    """``S'_f``: the stability left after forgetting a card."""
    values = _validate_weights(weights)
    value = (
        values[11]
        * (difficulty ** -values[12])
        * ((stability + 1.0) ** values[13] - 1.0)
        * math.exp((1.0 - retrievability_value) * values[14])
    )
    return max(0.01, value)


def next_difficulty(difficulty: float, rating: str, weights: tuple[float, ...] = DEFAULT_WEIGHTS) -> float:
    """``D'``: shift by the grade, then mean-revert towards ``D_0(good)``."""
    values = _validate_weights(weights)
    grade = _GRADE_BY_RATING[_normalize_rating(rating)]
    shifted = difficulty - values[6] * (grade - 3)
    reverted = values[7] * values[4] + (1.0 - values[7]) * shifted
    return clamp_difficulty(reverted)


def _step_minutes(learning_step: int) -> int:
    index = min(max(0, int(learning_step)), len(LEARNING_STEP_MINUTES) - 1)
    return LEARNING_STEP_MINUTES[index]


def _minutes(minutes: float) -> float:
    return float(minutes) / MINUTES_PER_DAY


# ---------------------------------------------------------------------- public
def schedule(
    state: CardState,
    rating: str,
    reviewed_at: datetime,
    *,
    weights: tuple[float, ...] = DEFAULT_WEIGHTS,
    desired_retention: float = DEFAULT_DESIRED_RETENTION,
) -> ScheduleResult:
    """Schedule one review of ``state`` at ``reviewed_at``.

    Pure and deterministic: the same ``(state, rating, reviewed_at, weights,
    desired_retention)`` always yields the same :class:`ScheduleResult`, and the
    only clock the function knows about is the one the caller passed in.
    """
    values = _validate_weights(weights)
    grade_rating = _normalize_rating(rating)
    moment = _normalize_moment(reviewed_at)
    phase = str(getattr(state.phase, "value", state.phase) or PHASE_NEW)
    if phase not in PHASES:
        raise ValueError(f"unknown memory card phase: {state.phase!r}")

    previous_stability = float(state.stability or 0.0)
    previous_difficulty = float(state.difficulty or 0.0)
    elapsed_days = 0.0
    if state.last_reviewed_at is not None:
        previous_moment = _normalize_moment(state.last_reviewed_at)
        elapsed_days = max(0.0, (moment - previous_moment).total_seconds() / 86400.0)

    is_first_review = state.reps <= 0 or previous_stability <= 0
    observed_retrievability = retrievability(elapsed_days, previous_stability)

    if is_first_review:
        stability = initial_stability(grade_rating, values)
        difficulty = initial_difficulty(grade_rating, values)
        is_lapse = False
    else:
        difficulty = next_difficulty(previous_difficulty, grade_rating, values)
        if grade_rating == RATING_AGAIN:
            # Only forgetting a card that had graduated to `review` is a lapse.
            # A slip during the short learning steps is not a forgotten memory.
            is_lapse = phase == PHASE_REVIEW
            stability = (
                forget_stability(previous_stability, previous_difficulty, observed_retrievability, values)
                if is_lapse
                else previous_stability
            )
        else:
            is_lapse = False
            stability = recall_stability(
                previous_stability, previous_difficulty, observed_retrievability, grade_rating, values
            )

    if phase == PHASE_REVIEW and not is_first_review:
        # A graduated card always waits the stability-based interval.
        phase_after = PHASE_REVIEW if grade_rating != RATING_AGAIN else PHASE_RELEARNING
        learning_step = 0 if grade_rating == RATING_AGAIN else state.learning_step
        interval_days = next_interval_days(stability, desired_retention)
        if grade_rating == RATING_AGAIN:
            interval_days = _minutes(_step_minutes(0))
    else:
        phase_after, learning_step, interval_days = _schedule_short_step(
            phase=phase,
            rating=grade_rating,
            learning_step=state.learning_step,
            stability=stability,
            is_lapse=is_lapse,
            desired_retention=desired_retention,
        )

    next_state = CardState(
        stability=stability,
        difficulty=difficulty,
        phase=phase_after,
        reps=state.reps + 1,
        lapses=state.lapses + (1 if is_lapse else 0),
        learning_step=learning_step,
        last_reviewed_at=moment,
        due_at=moment + timedelta(days=interval_days),
        scheduled_days=interval_days,
        elapsed_days=elapsed_days,
    )
    return ScheduleResult(
        state=next_state,
        retrievability=observed_retrievability,
        interval_days=interval_days,
        elapsed_days=elapsed_days,
        phase_after=phase_after,
        is_lapse=is_lapse,
    )


def _schedule_short_step(
    *,
    phase: str,
    rating: str,
    learning_step: int,
    stability: float,
    is_lapse: bool,
    desired_retention: float,
) -> tuple[str, int, float]:
    """Move a still-learning card through the fixed sub-day steps.

    ``relearning`` is sticky: a card relearning after a lapse stays there until
    it answers ``good``/``easy`` again, so the page keeps saying "重学中".
    """
    stay_phase = PHASE_RELEARNING if (phase == PHASE_RELEARNING or is_lapse) else PHASE_LEARNING
    if rating == RATING_AGAIN:
        return stay_phase, 0, _minutes(_step_minutes(0))
    if rating == RATING_HARD:
        return stay_phase, int(learning_step), _minutes(HARD_STEP_MINUTES)
    if rating == RATING_EASY:
        return PHASE_REVIEW, 0, next_interval_days(stability, desired_retention)
    completed = int(learning_step) + 1
    if completed >= len(LEARNING_STEP_MINUTES):
        return PHASE_REVIEW, 0, next_interval_days(stability, desired_retention)
    return stay_phase, completed, _minutes(_step_minutes(completed))
