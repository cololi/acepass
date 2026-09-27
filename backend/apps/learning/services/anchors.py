"""The one authoritative rule for "when did the latest related training happen".

Three places used to answer this question differently, which is how the same
business date ended up with three meanings (B04):

* task creation anchored on ``ExposureEvent``/``Attempt`` rows,
* ``delayed_interval_status`` trusted the ``not_before`` frozen at creation and
  never recomputed it, so a task whose deadline had already passed could be
  started after a brand-new training event on the same knowledge point,
* evidence projection anchored on ``SessionItem.first_delivered_at`` — the moment
  the question was *shown*. A learner who opened B 25 hours ago and submitted it
  1 hour ago counted as "25 hours of delay", even though the training finished an
  hour ago.

The rule is therefore defined once, here, and every caller uses it:

    the anchor is the most recent moment a related learning event *completed*
    (an attempt was submitted, an explanation/answer was delivered, a tutoring
    job was delivered) at or before the requested instant.

Nothing anchors on "the question was displayed": presenting a question is not
training, so it can never start the 24-hour clock.
"""

from __future__ import annotations


def latest_learning_anchor(*, user, project, node_id, before, exclude_attempt_id=None):
    """``(anchor, source)`` for the latest completed related learning event.

    Returns ``(None, "")`` when the learner has no related event at or before
    ``before`` — a delayed check with no anchor is not a delayed check, and
    callers must say so instead of inventing ``now`` as the anchor.

    ``node_id`` is required: an anchor without a knowledge point would mix
    unrelated material.
    """
    from apps.practice.models import Attempt, ExposureEvent
    from apps.tutoring.models import TutorJob

    if node_id is None or before is None:
        return None, ""

    latest = None
    source = ""

    def consider(value, candidate_source):
        nonlocal latest, source
        if value is not None and (latest is None or value > latest):
            latest, source = value, candidate_source

    attempts = Attempt.objects.filter(
        user=user,
        project_id=project,
        submitted_at__lte=before,
        session_item__question_version__knowledge_mappings__node_id=node_id,
    )
    if exclude_attempt_id is not None:
        attempts = attempts.exclude(id=exclude_attempt_id)
    consider(
        attempts.order_by("-submitted_at").values_list("submitted_at", flat=True).first(),
        "prior_attempt",
    )

    # A delivered answer or explanation is teaching: it resets the clock.
    consider(
        ExposureEvent.objects.filter(
            user=user,
            project_id=project,
            reveals_answer=True,
            server_time__lte=before,
            question_version__knowledge_mappings__node_id=node_id,
        )
        .order_by("-server_time")
        .values_list("server_time", flat=True)
        .first(),
        "teaching_exposure",
    )

    consider(
        TutorJob.objects.filter(
            user=user,
            project_id=project,
            status="succeeded",
            delivered_at__isnull=False,
            delivered_at__lte=before,
            tutor_session__session_item__question_version__knowledge_mappings__node_id=node_id,
        )
        .order_by("-delivered_at")
        .values_list("delivered_at", flat=True)
        .first(),
        "tutoring",
    )
    return latest, source


__all__ = ["latest_learning_anchor"]
