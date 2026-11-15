"""A sub-second clock skew is not "a new training event".

``delayed_interval_status`` moves a delayed task's deadline forward when a
learning event on the same knowledge point is *later* than the anchor frozen at
creation (B04). The attempt row and the answer-reveal exposure written right
after it describe the same training action, but their timestamps come from two
different clocks: the attempt carries the request's ``moment``, the exposure
carries ``timezone.now()`` inside the grading path. On a fast local machine the
two are equal; on a slower runner the exposure lands milliseconds later, the
guard read that as "the learner trained again", pushed the deadline 24 hours
forward and refused to start a task that had just been brought forward.

CI caught it (1 failed / 500 passed, `test_task_purpose_fixes_verification_mode_server_side`).
These two cases pin the boundary: same-action skew must change nothing, a real
later event must still move the deadline.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.common.enums import ExposureKind, ExposurePurpose
from apps.learning.models import StudyTask
from apps.learning.services import pairing as pairing_services
from apps.learning.services.anchors import latest_learning_anchor
from apps.practice.models import Attempt, ExposureEvent
from tests.integration.test_learning_loop import answer_for, make_pairing
from tests.integration.test_practice_flow import present, start_session, submit

pytestmark = pytest.mark.django_db


def _due_task(caller, project, subject, key: str):
    """A delayed-verification task whose deadline was just brought forward."""
    pair, _a, b, _c = make_pairing(subject)
    session = start_session(caller, project, subject, b.question, key=f"{key}-start")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project, item_id)
    submitted = submit(caller, project, item_id, answer_for(b), key=f"{key}-submit")
    assert submitted.status_code == 200, submitted.content
    task = StudyTask.objects.get(
        pairing=pair, origin_session_item_id=item_id, task_kind="delayed_verification"
    )
    anchor = task.review_task.delay_anchor_at
    assert anchor is not None
    # An operator bringing the check forward: the stored deadline is now past.
    StudyTask.objects.filter(id=task.id).update(not_before=timezone.now() - timedelta(minutes=1))
    task.refresh_from_db()
    return task, Attempt.objects.get(session_item_id=item_id), anchor


def _reveal_at(project, attempt, moment) -> None:
    """The answer-reveal row the grading path writes for this attempt."""
    ExposureEvent.objects.create(
        user=attempt.user,
        project=project,
        question=attempt.session_item.question_version.question,
        question_version=attempt.session_item.question_version,
        session_item=attempt.session_item,
        kind=ExposureKind.ANSWER_DELIVERED,
        purpose=ExposurePurpose.PRACTICE,
        source="test-reveal",
        server_time=moment,
        reveals_answer=True,
    )


def test_same_action_skew_does_not_move_the_deadline(caller, project_a, subject_a1):
    task, attempt, anchor = _due_task(caller, project_a, subject_a1, key="skew")
    stored_deadline = task.not_before

    # Same training action, seen 400 ms later through the reveal row. The check
    # happens ten minutes later, so the reveal is in the past and really is a
    # candidate anchor — the point is that it must not count as a new event.
    _reveal_at(project_a, attempt, anchor + timedelta(milliseconds=400))

    moment = max(anchor + timedelta(minutes=10), timezone.now())
    probe, probe_source = latest_learning_anchor(
        user=attempt.user, project=project_a, node_id=task.knowledge_node_id, before=moment
    )
    assert probe is not None, {
        "why": "the fixture must leave a learning event the task's node can anchor on",
        "probe_source": probe_source,
        "node_id": str(task.knowledge_node_id),
        "stored_anchor": anchor.isoformat(),
        "attempt_submitted_at": attempt.submitted_at.isoformat(),
        "moment": moment.isoformat(),
        "attempts_on_node": Attempt.objects.filter(
            user=attempt.user,
            project_id=project_a,
            submitted_at__lte=moment,
            session_item__question_version__knowledge_mappings__node_id=task.knowledge_node_id,
        ).count(),
        "attempts": [
            (row.submitted_at.isoformat(), str(row.id))
            for row in Attempt.objects.filter(user=attempt.user, project_id=project_a)
        ],
        "mapped_nodes": [
            str(row)
            for row in attempt.session_item.question_version.knowledge_mappings.values_list(
                "node_id", flat=True
            )
        ],
    }

    status = pairing_services.delayed_interval_status(task=task, now=moment)
    assert status["satisfied"] is True, status
    assert status["reason"] == ""
    assert status["recomputed_not_before"] is None, "同一动作的毫秒级偏差不得顺延截止时间"
    assert status["not_before"] == stored_deadline.isoformat()


def test_a_genuinely_later_event_still_moves_the_deadline(caller, project_a, subject_a1):
    task, attempt, anchor = _due_task(caller, project_a, subject_a1, key="moved")
    original = task.not_before

    # A real training event five minutes after the anchor, observed ten minutes
    # later: the anchor is in the past and the new event is not in the future.
    _reveal_at(project_a, attempt, anchor + timedelta(minutes=5))

    status = pairing_services.delayed_interval_status(task=task, now=anchor + timedelta(minutes=10))
    assert status["satisfied"] is False, status
    assert "延迟验证需等待" in status["reason"]
    assert status["recomputed_not_before"] is not None
    assert status["not_before"] != original.isoformat()
