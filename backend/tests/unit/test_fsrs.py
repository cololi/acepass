"""FSRS-4.5 scheduler: formulas, determinism and the refusal to read a clock."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from domain.memory import fsrs

MOMENT = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)


def review_state(**overrides) -> fsrs.CardState:
    """A card that graduated to the review phase and is due right now."""
    values = {
        "stability": 10.0,
        "difficulty": 5.0,
        "phase": fsrs.PHASE_REVIEW,
        "reps": 4,
        "lapses": 0,
        "learning_step": 0,
        "last_reviewed_at": MOMENT - timedelta(days=5),
        "due_at": MOMENT,
        "scheduled_days": 5.0,
    }
    values.update(overrides)
    return fsrs.CardState(**values)


# ------------------------------------------------------------------ constants
def test_published_weights_and_constants_are_the_fsrs_4_5_defaults():
    assert len(fsrs.DEFAULT_WEIGHTS) == 17
    assert all(isinstance(weight, float) for weight in fsrs.DEFAULT_WEIGHTS)
    assert fsrs.DECAY == -0.5
    assert fsrs.FACTOR == pytest.approx(19 / 81)
    assert fsrs.DEFAULT_DESIRED_RETENTION == 0.9
    assert fsrs.MAX_INTERVAL_DAYS == 36500
    assert fsrs.FSRS_VERSION == "fsrs-4.5-default-v1"


def test_weights_for_uses_the_recorded_version_and_refuses_an_unknown_one():
    assert fsrs.weights_for(fsrs.FSRS_VERSION) is fsrs.DEFAULT_WEIGHTS
    with pytest.raises(KeyError):
        fsrs.weights_for("fsrs-9.9-unknown")


def test_factor_and_decay_make_the_interval_equal_the_stability_at_default_retention():
    # This identity is the reason the published defaults pair 19/81 with -0.5.
    assert fsrs.next_interval_days(10.0) == 10.0
    assert fsrs.next_interval_days(37.0) == 37.0


# ------------------------------------------------------------------ pure math
def test_initial_stability_and_difficulty_follow_the_published_formulas():
    w = fsrs.DEFAULT_WEIGHTS
    assert fsrs.initial_stability("again") == pytest.approx(w[0])
    assert fsrs.initial_stability("hard") == pytest.approx(w[1])
    assert fsrs.initial_stability("good") == pytest.approx(w[2])
    assert fsrs.initial_stability("easy") == pytest.approx(w[3])

    assert fsrs.initial_difficulty("good") == pytest.approx(w[4])
    assert fsrs.initial_difficulty("again") == pytest.approx(w[4] + 2 * w[5])
    assert fsrs.initial_difficulty("easy") == pytest.approx(w[4] - w[5])
    for rating in fsrs.RATINGS:
        assert 1.0 <= fsrs.initial_difficulty(rating) <= 10.0


def test_retrievability_decreases_with_elapsed_time_and_stays_inside_the_unit_interval():
    values = [fsrs.retrievability(days, 10.0) for days in (0, 1, 5, 30, 365, 36500)]
    assert values[0] == 1.0
    assert all(0.0 < value <= 1.0 for value in values)
    assert values == sorted(values, reverse=True)
    assert values[0] > values[-1]
    # A card with no memory state has nothing to decay; the phase, not this
    # number, is what tells "never studied" apart from "just reviewed".
    assert fsrs.retrievability(10.0, 0.0) == 1.0


def test_interval_is_rounded_to_whole_days_and_clamped_to_the_maximum():
    assert fsrs.next_interval_days(0.4) == 1.0
    assert fsrs.next_interval_days(1e9) == float(fsrs.MAX_INTERVAL_DAYS)
    huge = review_state(stability=1e9)
    result = fsrs.schedule(huge, "easy", MOMENT)
    assert result.interval_days == float(fsrs.MAX_INTERVAL_DAYS)
    assert result.state.due_at == MOMENT + timedelta(days=fsrs.MAX_INTERVAL_DAYS)


def test_difficulty_stays_clamped_between_one_and_ten():
    hardest = review_state(difficulty=10.0)
    assert fsrs.next_difficulty(10.0, "again") == 10.0
    assert fsrs.next_difficulty(1.0, "easy") == 1.0
    # Repeated one-sided grading must not escape the published scale.
    result = fsrs.schedule(hardest, "again", MOMENT)
    assert 1.0 <= result.state.difficulty <= 10.0
    difficulty = 5.0
    for _ in range(50):
        difficulty = fsrs.next_difficulty(difficulty, "easy")
    assert difficulty == 1.0
    for _ in range(50):
        difficulty = fsrs.next_difficulty(difficulty, "again")
    assert difficulty == 10.0
    del hardest


def test_a_failed_review_loses_stability_while_a_successful_one_gains_it():
    state = review_state()
    forgotten = fsrs.schedule(state, "again", MOMENT)
    assert forgotten.state.stability < state.stability
    for rating in ("hard", "good", "easy"):
        grown = fsrs.schedule(state, rating, MOMENT)
        assert grown.state.stability >= state.stability


# ---------------------------------------------------------------- determinism
def test_schedule_is_deterministic_for_identical_inputs():
    state = review_state()
    first = fsrs.schedule(state, "good", MOMENT)
    second = fsrs.schedule(state, "good", MOMENT)
    assert first == second
    assert first.state == second.state
    # The input state is frozen and never mutated.
    assert state.stability == 10.0
    assert state.reps == 4


def test_schedule_never_reads_the_wall_clock(monkeypatch):
    class _FrozenClock(datetime):
        @classmethod
        def now(cls, tz=None):  # pragma: no cover - only reached on a real read
            raise AssertionError("schedule() read the wall clock")

        @classmethod
        def utcnow(cls):  # pragma: no cover - only reached on a real read
            raise AssertionError("schedule() read the wall clock")

        @classmethod
        def today(cls):  # pragma: no cover - only reached on a real read
            raise AssertionError("schedule() read the wall clock")

    monkeypatch.setattr(fsrs, "datetime", _FrozenClock)
    result = fsrs.schedule(review_state(), "good", MOMENT)
    # Every instant in the result derives from the argument that was passed in.
    assert result.state.last_reviewed_at == MOMENT
    assert result.state.due_at == MOMENT + timedelta(days=result.interval_days)
    assert result.elapsed_days == pytest.approx(5.0)


def test_schedule_rejects_an_unknown_rating_or_phase():
    with pytest.raises(ValueError):
        fsrs.schedule(review_state(), "perfect", MOMENT)
    with pytest.raises(ValueError):
        fsrs.schedule(review_state(phase="someday"), "good", MOMENT)


# ------------------------------------------------------------- learning steps
def test_new_card_uses_minute_scale_learning_steps():
    for rating, minutes in (("again", 1), ("hard", 5), ("good", 10)):
        result = fsrs.schedule(fsrs.CardState(), rating, MOMENT)
        assert result.phase_after == fsrs.PHASE_LEARNING
        assert result.state.due_at == MOMENT + timedelta(minutes=minutes)
        assert result.interval_days == pytest.approx(minutes / 1440.0)
        assert result.state.phase == fsrs.PHASE_LEARNING


def test_good_walks_the_steps_and_then_graduates_to_the_stability_interval():
    first = fsrs.schedule(fsrs.CardState(), "good", MOMENT)
    assert (first.phase_after, first.state.learning_step) == (fsrs.PHASE_LEARNING, 1)
    graduated = fsrs.schedule(first.state, "good", MOMENT + timedelta(minutes=10))
    assert graduated.phase_after == fsrs.PHASE_REVIEW
    assert graduated.state.learning_step == 0
    assert graduated.interval_days >= 1.0
    assert graduated.state.due_at == MOMENT + timedelta(minutes=10, days=graduated.interval_days)


def test_easy_graduates_immediately_with_the_stability_interval():
    result = fsrs.schedule(fsrs.CardState(), "easy", MOMENT)
    assert result.phase_after == fsrs.PHASE_REVIEW
    assert result.interval_days == pytest.approx(round(fsrs.DEFAULT_WEIGHTS[3]))
    assert result.state.due_at > MOMENT + timedelta(days=1)


def test_again_on_a_review_card_is_a_lapse_and_resets_to_relearning():
    state = review_state(lapses=1)
    result = fsrs.schedule(state, "again", MOMENT)
    assert result.is_lapse is True
    assert result.phase_after == fsrs.PHASE_RELEARNING
    assert result.state.phase == fsrs.PHASE_RELEARNING
    assert result.state.learning_step == 0
    assert result.state.lapses == state.lapses + 1
    # A lapse comes straight back: one minute, not one day.
    assert result.state.due_at == MOMENT + timedelta(minutes=1)
    assert result.state.reps == state.reps + 1


def test_again_while_still_learning_is_not_counted_as_a_lapse():
    learning = fsrs.schedule(fsrs.CardState(), "good", MOMENT).state
    result = fsrs.schedule(learning, "again", MOMENT + timedelta(minutes=10))
    assert result.is_lapse is False
    assert result.state.lapses == 0
    assert result.phase_after == fsrs.PHASE_LEARNING
    assert result.state.due_at == MOMENT + timedelta(minutes=11)


# ------------------------------------------------------------------- ordering
def test_interval_ordering_is_easy_greater_than_good_greater_than_hard():
    state = review_state()
    hard = fsrs.schedule(state, "hard", MOMENT)
    good = fsrs.schedule(state, "good", MOMENT)
    easy = fsrs.schedule(state, "easy", MOMENT)
    assert hard.interval_days < good.interval_days < easy.interval_days
    assert hard.state.stability < good.state.stability < easy.state.stability
    assert hard.state.due_at < good.state.due_at < easy.state.due_at
    assert all(result.phase_after == fsrs.PHASE_REVIEW for result in (hard, good, easy))


def test_schedule_result_exposes_the_scheduler_version_and_elapsed_days():
    result = fsrs.schedule(review_state(), "good", MOMENT)
    assert result.scheduler_version == fsrs.FSRS_VERSION
    assert result.next_state is result.state
    assert result.retrievability == pytest.approx(fsrs.retrievability(5.0, 10.0))
    assert result.elapsed_days == pytest.approx(5.0)


def test_naive_reviewed_at_is_read_as_utc_rather_than_local_time():
    naive = datetime(2026, 3, 1, 9, 0)  # noqa: DTZ001 - deliberately naive input
    aware = fsrs.schedule(review_state(), "good", MOMENT)
    as_utc = fsrs.schedule(review_state(), "good", naive)
    assert as_utc.state.due_at == aware.state.due_at
    assert as_utc.state.due_at.tzinfo is not None
