"""Paired A/B/C verification tasks.

Human-reviewed pairings (``VerificationPairing``) drive this: A is the baseline
question, B an immediate check on the same knowledge point, C a delayed check at
least `delay_hours` later. Generation is idempotent per
``(user, pairing_version, origin_session_item, task_kind)`` so a repeated
explanation, re-read, later grading or regrade still yields exactly one B (and
one C per B).
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.common.enums import TaskKind, TaskStatus
from apps.knowledge.models import VerificationPairing
from apps.learning.models import ReviewTask, StudyTask
from apps.practice.models import Attempt, SessionItem
from apps.question_bank.models import Question

logger = logging.getLogger("apps.learning.pairing")


def _published_version(question: Question):
    if question.current_published_version_id:
        return question.current_published_version
    return question.versions.filter(status="published").order_by("-version").first()


def _anchor_for(*, user, project, node_id, before, include_moment=None) -> tuple[object, str]:
    """Most recent completed related learning event, at or before ``before``.

    Delegates to :mod:`apps.learning.services.anchors`, which is the single
    definition shared by task creation, task start and evidence projection (B04).

    ``include_moment`` is the event that *triggered* this task. For the delayed
    C task that is the just-graded B attempt, and it must always be able to be
    the anchor: A's teaching event can be a day old, so anchoring on it made C
    due immediately (the review's R06). The anchor is the latest related learning
    event, which for "B was just completed" is B itself.
    """
    from apps.learning.services.anchors import latest_learning_anchor

    anchor, source = latest_learning_anchor(user=user, project=project, node_id=node_id, before=before)
    if include_moment is not None and (anchor is None or include_moment >= anchor):
        anchor, source = include_moment, "trigger_event"
    if anchor is None:
        # No related event at all: the triggering event itself is the anchor.
        anchor, source = before, "current_event"
    return anchor, source


def _create_task(
    *,
    user,
    project,
    subject,
    task_kind: str,
    question: Question,
    node_id,
    pairing: VerificationPairing,
    origin_item: SessionItem,
    trigger_event: str,
    reason_codes: list[str],
    not_before=None,
    delay_anchor_at=None,
    estimated_minutes: int = 2,
    deficit_notice: str = "",
) -> tuple[StudyTask | None, bool]:
    version = _published_version(question)
    if version is None or not version.is_scorable_leaf:
        return None, False
    if version.answer_keys.filter(verification_status="checked", is_disputed=False).first() is None:
        return None, False
    try:
        with transaction.atomic():
            task = StudyTask.objects.create(
                user=user,
                project=project,
                subject=subject,
                task_kind=task_kind,
                status=TaskStatus.PENDING,
                question=question,
                knowledge_node_id=node_id,
                pairing=pairing,
                pairing_version=pairing.pairing_version,
                origin_session_item=origin_item,
                trigger_event=trigger_event,
                delay_anchor_at=delay_anchor_at,
                not_before=not_before,
                due_at=not_before,
                estimated_minutes=estimated_minutes,
                reason_codes=reason_codes,
                rule_version="p0-1",
                deficit_notice=deficit_notice,
            )
    except IntegrityError:
        return StudyTask.objects.filter(
            user=user,
            pairing=pairing,
            origin_session_item=origin_item,
            task_kind=task_kind,
        ).first(), False
    return task, True


def on_attempt_graded(attempt_id: str) -> int:
    """Trigger paired tasks from a confirmed grade on a baseline or B question."""
    attempt = (
        Attempt.objects.select_related(
            "session_item__question_version__question", "session_item__session", "current_grade_event"
        )
        .filter(id=attempt_id)
        .first()
    )
    if attempt is None or attempt.current_grade_event is None:
        return 0
    question = attempt.session_item.question_version.question
    created = 0
    pairings = VerificationPairing.objects.filter(
        project_id=attempt.project_id, is_active=True
    ).filter(baseline_question=question)
    for pairing in pairings.select_related("immediate_question", "subject", "node"):
        task, was_created = _create_task(
            user=attempt.user,
            project=attempt.project,
            subject=pairing.subject,
            task_kind=TaskKind.PAIRED_IMMEDIATE,
            question=pairing.immediate_question,
            node_id=pairing.node_id,
            pairing=pairing,
            origin_item=attempt.session_item,
            trigger_event="confirmed_grade",
            reason_codes=["paired_immediate", "same_knowledge_node"],
            estimated_minutes=_estimate_minutes(pairing.immediate_question),
        )
        if task is None:
            _record_missing_pair_question(attempt, pairing, "immediate")
            continue
        created += int(was_created)

    immediate_pairings = VerificationPairing.objects.filter(
        project_id=attempt.project_id, is_active=True, immediate_question=question
    )
    for pairing in immediate_pairings.select_related("delayed_question", "subject", "node"):
        if pairing.delayed_question_id is None:
            _record_missing_pair_question(attempt, pairing, "delayed")
            continue
        delay_hours = pairing.delay_hours or getattr(settings, "DELAYED_VERIFICATION_HOURS", 24)
        # The delay is measured from B's completion (or any later related
        # learning event), never from an older exposure that would make the
        # "delayed" check due immediately.
        anchor, source = _anchor_for(
            user=attempt.user,
            project=attempt.project,
            node_id=pairing.node_id,
            before=attempt.submitted_at,
            include_moment=attempt.submitted_at,
        )
        not_before = anchor + timedelta(hours=delay_hours)
        task, was_created = _create_task(
            user=attempt.user,
            project=attempt.project,
            subject=pairing.subject,
            task_kind=TaskKind.DELAYED_VERIFICATION,
            question=pairing.delayed_question,
            node_id=pairing.node_id,
            pairing=pairing,
            origin_item=attempt.session_item,
            trigger_event="paired_immediate_graded",
            reason_codes=["delayed_verification", f"delay_{delay_hours}h", source],
            not_before=not_before,
            delay_anchor_at=anchor,
            estimated_minutes=_estimate_minutes(pairing.delayed_question),
        )
        if task is None:
            _record_missing_pair_question(attempt, pairing, "delayed")
            continue
        if was_created:
            ReviewTask.objects.create(
                user=attempt.user,
                project=attempt.project,
                study_task=task,
                knowledge_node_id=pairing.node_id,
                delay_hours=delay_hours,
                delay_anchor_at=anchor,
                not_before=not_before,
                anchor_source=source,
            )
            created += 1
    return created


def on_explanation_delivered(item_id: str) -> int:
    """Trigger the immediate B task when an explanation is delivered on A.

    This covers "learned from the explanation, no attempt yet": the task is
    created without inventing an attempt.
    """
    item = (
        SessionItem.objects.select_related("question_version__question", "session")
        .filter(id=item_id)
        .first()
    )
    if item is None:
        return 0
    question = item.question_version.question
    created = 0
    pairings = VerificationPairing.objects.filter(
        project_id=item.session.project_id, is_active=True, baseline_question=question
    ).select_related("immediate_question", "subject", "node")
    for pairing in pairings:
        _task, was_created = _create_task(
            user=item.session.user,
            project=item.session.project,
            subject=pairing.subject,
            task_kind=TaskKind.PAIRED_IMMEDIATE,
            question=pairing.immediate_question,
            node_id=pairing.node_id,
            pairing=pairing,
            origin_item=item,
            trigger_event="explanation_delivered",
            reason_codes=["paired_immediate", "explanation_first"],
            estimated_minutes=_estimate_minutes(pairing.immediate_question),
        )
        created += int(was_created)
    return created


def _record_missing_pair_question(attempt: Attempt, pairing: VerificationPairing, kind: str) -> None:
    """No eligible question: keep an explicit record and never fake one."""
    label = "B" if kind == "immediate" else "C"
    StudyTask.objects.get_or_create(
        user=attempt.user,
        project=attempt.project,
        subject=pairing.subject,
        task_kind=TaskKind.DELAYED_VERIFICATION if kind == "delayed" else TaskKind.PAIRED_IMMEDIATE,
        origin_session_item=None,
        question=None,
        defaults={
            "status": TaskStatus.INVALIDATED,
            "knowledge_node_id": pairing.node_id,
            "pairing": pairing,
            "pairing_version": pairing.pairing_version,
            "trigger_event": "missing_paired_question",
            "reason_codes": ["missing_paired_question", f"missing_{kind}"],
            "estimated_minutes": 0,
            "deficit_notice": f"缺少合格的{label}题：配对 {pairing.id} 未关联可用{label}题，"
            "到期后只能用原题重复练习，不计入延迟验证证据。",
            "invalidated_reason": f"缺少合格的{label}题",
        },
    )


def _estimate_minutes(question: Question | None) -> int:
    if question is None:
        return 2
    version = _published_version(question)
    if version is None:
        return 2
    if version.estimated_seconds:
        return max(1, round(version.estimated_seconds / 60))
    return {"constructed_response": 15, "fill_blank": 3}.get(version.question_type, 2)


def reconcile_delayed_tasks() -> int:
    """Push `not_before` later when a newer related training event appears.

    Runs periodically and before starting a delayed task; the real interval is
    always re-checked at start time.
    """
    updated = 0
    pending = ReviewTask.objects.filter(was_started=False).select_related("study_task")
    for review in pending:
        task = review.study_task
        if task is None or task.status not in {TaskStatus.PENDING, TaskStatus.DEFERRED}:
            continue
        anchor, source = _anchor_for(
            user=review.user,
            project=review.project,
            node_id=review.knowledge_node_id,
            before=timezone.now(),
        )
        expected = anchor + timedelta(hours=review.delay_hours)
        if expected > review.not_before:
            review.not_before = expected
            review.delay_anchor_at = anchor
            review.anchor_source = source
            review.save(update_fields=["not_before", "delay_anchor_at", "anchor_source", "updated_at"])
            task.delay_anchor_at = anchor
            task.not_before = expected
            task.due_at = expected
            task.reason_codes = list(task.reason_codes or []) + ["anchor_updated"]
            task.save(update_fields=["delay_anchor_at", "not_before", "due_at", "reason_codes", "updated_at"])
            updated += 1
    return updated


def _delay_hours_for(task: StudyTask, review: ReviewTask | None) -> int:
    """The interval this delayed task was created with.

    Read from the ``ReviewTask`` when it exists, then from the frozen reason
    codes, then from settings — never silently defaulted to "no delay".
    """
    if review is not None and review.delay_hours:
        return int(review.delay_hours)
    for code in task.reason_codes or []:
        if isinstance(code, str) and code.startswith("delay_") and code.endswith("h"):
            try:
                return int(code[len("delay_") : -1])
            except ValueError:
                continue
    return int(getattr(settings, "DELAYED_VERIFICATION_HOURS", 24))


def delayed_interval_status(*, task: StudyTask, now=None) -> dict:
    """Re-check the real interval before starting a delayed task.

    The stored ``not_before`` is not trusted on its own (B04). It is a snapshot
    taken when the task was created, and a *new* training event on the same
    knowledge point — a fresh B attempt, a new explanation — moves the real
    deadline forward. A task whose stored deadline has passed may therefore not
    be startable any more, so the interval is recomputed here from the same
    authoritative anchor the evidence projection uses.

    A task with no stored deadline at all stays unstartable: "we forgot to freeze
    a deadline" must not silently become "no delay required".
    """
    moment = now or timezone.now()
    review = getattr(task, "review_task", None)
    if task.task_kind != TaskKind.DELAYED_VERIFICATION:
        return {"required": False, "satisfied": True, "reason": ""}
    anchor_source = review.anchor_source if review else (task.reason_codes or ["unknown"])[-1]
    if not task.not_before:
        # A delayed task that never got a deadline cannot be verified as delayed.
        return {
            "required": True,
            "satisfied": False,
            "reason": "延迟验证任务缺少可开始的截止时间，需重新核对锚点后再开始",
            "not_before": None,
        }
    delay_hours = _delay_hours_for(task, review)
    stored_anchor = (review.delay_anchor_at if review else None) or task.delay_anchor_at
    anchor, source = _anchor_for(
        user=task.user,
        project=task.project,
        node_id=task.knowledge_node_id,
        before=moment,
    )
    # Only a learning event that happened *after the task was created* moves the
    # deadline. The stored anchor is the creation-time anchor, so re-deriving it
    # from the same rows the task was built from changes nothing — while a manual
    # correction of ``not_before`` (an operator bringing a check forward) must stay
    # a correction rather than being silently undone on the next request.
    recomputed = None
    if anchor is not None and (stored_anchor is None or anchor > stored_anchor):
        recomputed = anchor + timedelta(hours=delay_hours)
    required_at = max(value for value in (task.not_before, recomputed) if value is not None)
    if moment < required_at:
        remaining = (required_at - moment).total_seconds() / 3600
        moved = recomputed is not None and recomputed > task.not_before
        return {
            "required": True,
            "satisfied": False,
            "reason": (
                f"延迟验证需等待：还需约 {remaining:.2f} 小时（锚点 {source or anchor_source or 'unknown'}"
                f"{'，期间有新的训练/讲解，截止时间已顺延' if moved else ''}）"
            ),
            "not_before": required_at.isoformat(),
            "stored_not_before": task.not_before.isoformat(),
            "recomputed_not_before": recomputed.isoformat() if recomputed else None,
            "anchor_source": source or anchor_source,
        }
    return {
        "required": True,
        "satisfied": True,
        "reason": "",
        "not_before": required_at.isoformat(),
        "stored_not_before": task.not_before.isoformat(),
        "recomputed_not_before": recomputed.isoformat() if recomputed else None,
        "anchor_source": source or anchor_source,
    }
