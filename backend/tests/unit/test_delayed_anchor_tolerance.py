"""The one-second tolerance on "a new training event moved the anchor" (B04).

``delayed_interval_status`` re-derives the anchor instead of trusting the frozen
``not_before``, and pushes the deadline forward when a *later* learning event
exists. Two rows describe the same training action with two different clocks —
the attempt carries the request's instant, the answer-reveal exposure written
right after it carries the server clock — so on a slower machine they differ by
milliseconds. Reading that as "the learner trained again" pushed the deadline a
full interval forward and made the task unstartable (found by CI: 1 failed of
501, green locally).

These cases pin the boundary without touching the database or the wall clock:
``_anchor_for`` is the only thing that reads either, so it is replaced.
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.utils import timezone

from apps.common.enums import TaskKind
from apps.learning.services import pairing as pairing_services


def _delayed_task(anchor, *, not_before):
    """Only the attributes ``delayed_interval_status`` actually reads."""
    return SimpleNamespace(
        task_kind=TaskKind.DELAYED_VERIFICATION,
        not_before=not_before,
        delay_anchor_at=anchor,
        reason_codes=["delayed_verification", "delay_24h"],
        review_task=None,
        user=None,
        project=None,
        knowledge_node_id=None,
    )


def _status(monkeypatch, *, anchor, observed_anchor, now):
    task = _delayed_task(anchor, not_before=anchor + timedelta(hours=24))
    monkeypatch.setattr(pairing_services, "_anchor_for", lambda **kwargs: (observed_anchor, "prior_attempt"))
    return pairing_services.delayed_interval_status(task=task, now=now)


@pytest.mark.parametrize("skew_ms", [1, 50, 400, 999])
def test_millisecond_skew_is_not_a_new_event(monkeypatch, skew_ms):
    anchor = timezone.now() - timedelta(hours=30)
    now = anchor + timedelta(hours=24, minutes=2)

    status = _status(
        monkeypatch,
        anchor=anchor,
        observed_anchor=anchor + timedelta(milliseconds=skew_ms),
        now=now,
    )

    assert status["satisfied"] is True, status
    assert status["recomputed_not_before"] is None
    assert status["not_before"] == (anchor + timedelta(hours=24)).isoformat()


def test_exactly_the_tolerance_is_not_a_new_event(monkeypatch):
    # The comparison is strict (>): one second exactly still means "same action".
    anchor = timezone.now() - timedelta(hours=30)
    status = _status(
        monkeypatch,
        anchor=anchor,
        observed_anchor=anchor + pairing_services.ANCHOR_MOVE_TOLERANCE,
        now=anchor + timedelta(hours=24, minutes=2),
    )
    assert status["satisfied"] is True, status


def test_a_real_later_event_pushes_the_deadline(monkeypatch):
    anchor = timezone.now() - timedelta(hours=30)
    observed = anchor + timedelta(minutes=5)

    status = _status(monkeypatch, anchor=anchor, observed_anchor=observed, now=anchor + timedelta(hours=24, minutes=2))

    assert status["satisfied"] is False, status
    assert "延迟验证需等待" in status["reason"]
    assert status["recomputed_not_before"] == (observed + timedelta(hours=24)).isoformat()
