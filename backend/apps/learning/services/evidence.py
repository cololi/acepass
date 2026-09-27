"""Evidence projection: what one confirmed attempt actually proves.

Rules (docs/03 §5): evidence is derived from server-side facts, never from a
client claim. Each row keeps its exclusion reasons so the UI can state exactly
why an attempt did not count towards a stricter dimension.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.common.enums import (
    EvidenceDimension,
    ExposureKind,
    GradeMethod,
    GradeStatus,
    SessionMode,
    SessionStatus,
)
from apps.practice.models import Attempt, ExposureEvent, LearningEvidence

RULE_VERSION = "p0-1"

#: Dimensions that an attempt produces; the state summary consumes qualified rows.
ALL_DIMENSIONS = (
    EvidenceDimension.REPEAT_PRACTICE,
    EvidenceDimension.UNASSISTED_COMPLETION,
    EvidenceDimension.INDEPENDENT_CORRECT,
    EvidenceDimension.TEMPLATE_VARIANT,
    EvidenceDimension.UNSEEN_VARIANT,
    EvidenceDimension.DELAYED_VERIFICATION,
)


def _pre_submit_assistance(attempt: Attempt) -> tuple[bool, list[str]]:
    """Any answer-revealing exposure for this question before this submission."""
    reasons: list[str] = []
    delivered_at = attempt.session_item.first_delivered_at
    window_start = (delivered_at - timedelta(days=365)) if delivered_at else None
    exposures = ExposureEvent.objects.filter(
        user=attempt.user,
        question_version_id=attempt.session_item.question_version_id,
        reveals_answer=True,
        server_time__lt=attempt.submitted_at,
    )
    if window_start is not None:
        exposures = exposures.filter(server_time__gte=window_start)
    any_assistance = exposures.exists()
    if any_assistance:
        kinds = sorted({row.kind for row in exposures})
        reasons.append("提交前已获得辅助暴露：" + ", ".join(kinds))
    # Hints that are not answer-revealing still block the "unassisted" dimension.
    hint_exposures = ExposureEvent.objects.filter(
        user=attempt.user,
        question_version_id=attempt.session_item.question_version_id,
        kind__in=[ExposureKind.HINT_DELIVERED, ExposureKind.ANSWER_DELIVERED, ExposureKind.EXPLANATION_DELIVERED],
        server_time__lt=attempt.submitted_at,
    )
    if hint_exposures.exists() and not any_assistance:
        reasons.append("提交前获得过提示")
    return any_assistance, reasons


def _cross_project_lineage_seen(attempt: Attempt) -> list[str]:
    """Same content in another of this user's projects still counts as seen."""
    question = attempt.session_item.question_version.question
    if question.content_lineage_id is None:
        return []
    seen = (
        ExposureEvent.objects.filter(
            user=attempt.user,
            content_lineage_id=question.content_lineage_id,
            reveals_answer=True,
            server_time__lt=attempt.submitted_at,
        )
        .exclude(project_id=attempt.project_id)
        .exists()
    )
    if seen:
        return ["该题在本人其他项目中已看过答案（内容谱系跨项目暴露）"]
    return []


def _question_seen_before(attempt: Attempt) -> list[str]:
    """Did this user meet the *same question* before this item was presented?

    Deliberately exact: a systematic preview, an earlier practice item of the
    same question version, or an earlier answer/explanation delivery all count.
    This is what stops "repeated practice on one question" from ever being
    presented as several independent, first-contact successes.
    """
    reasons: list[str] = []
    delivered_at = attempt.session_item.first_delivered_at
    prior = ExposureEvent.objects.filter(
        user=attempt.user,
        question_version_id=attempt.session_item.question_version_id,
        server_time__lt=delivered_at or attempt.submitted_at,
    ).exclude(session_item_id=attempt.session_item_id)
    if prior.filter(kind=ExposureKind.EDITORIAL_PREVIEW).exists():
        reasons.append("本人校对/编辑过本题")
    elif prior.filter(kind__in=[ExposureKind.ANSWER_DELIVERED, ExposureKind.EXPLANATION_DELIVERED]).exists():
        reasons.append("本次呈现前已看过本题答案或解析")
    elif prior.filter(kind=ExposureKind.STEM_DELIVERED).exists():
        reasons.append(
            "本次呈现前已接触过同一道题（重复练习按重复统计，不作为首次接触或陌生变式证据）"
        )
    return reasons


def _last_relevant_anchor(attempt: Attempt, node_id) -> tuple[object | None, str]:
    """Anchor for the delayed dimension: the latest related teaching/answer event.

    The anchor is the most recent relevant attempt or tutoring event *before*
    this item was presented; a mid-way explanation updates it.
    """
    from apps.practice.models import SessionItem

    delivered_at = attempt.session_item.first_delivered_at or attempt.submitted_at
    latest = None
    source = ""
    if node_id is not None:
        prior_items = (
            SessionItem.objects.filter(
                session__user=attempt.user,
                session__project=attempt.project_id,
                question_version__knowledge_mappings__node_id=node_id,
                first_delivered_at__lt=delivered_at,
            )
            .exclude(id=attempt.session_item_id)
            .values_list("first_delivered_at", flat=True)
        )
        for value in prior_items:
            if value and (latest is None or value > latest):
                latest = value
                source = "prior_attempt"
    if latest is None:
        prior_real = (
            Attempt.objects.filter(
                user=attempt.user,
                project_id=attempt.project_id,
                session_item__question_version__knowledge_mappings__node_id=node_id,
                submitted_at__lt=delivered_at,
            )
            .exclude(id=attempt.id)
            .values_list("submitted_at", flat=True)
        )
        for value in prior_real:
            if value and (latest is None or value > latest):
                latest = value
                source = "prior_attempt"
    return latest, source


def _tutoring_anchor(attempt: Attempt, node_id) -> object | None:
    from apps.tutoring.models import TutorJob

    delivered_at = attempt.session_item.first_delivered_at or attempt.submitted_at
    jobs = TutorJob.objects.filter(
        user=attempt.user,
        project_id=attempt.project_id,
        status="succeeded",
        delivered_at__isnull=False,
        delivered_at__lt=delivered_at,
        tutor_session__session_item__question_version__knowledge_mappings__node_id=node_id,
    ).values_list("delivered_at", flat=True)
    latest = None
    for value in jobs:
        if value and (latest is None or value > latest):
            latest = value
    return latest


def compute_dimensions(attempt: Attempt) -> list[dict]:
    """All evidence rows (one per dimension × knowledge node) for one attempt."""
    item = attempt.session_item
    grade = attempt.current_grade_event
    rows: list[dict] = []
    nodes = list(
        item.question_version.knowledge_mappings.filter(mapping_revision=item.mapping_revision)
        .select_related("node", "template")
        .order_by("node__canonical_name")
    )
    if not nodes:
        nodes = list(
            item.question_version.knowledge_mappings.select_related("node", "template").order_by(
                "node__canonical_name"
            )
        )
    assistance, assistance_reasons = _pre_submit_assistance(attempt)
    seen_reasons = _question_seen_before(attempt) + _cross_project_lineage_seen(attempt)

    trusted_question = bool(item.answer_key_version and item.answer_key_version.is_usable)
    confirmed_grade = grade is not None and grade.status == GradeStatus.CONFIRMED and grade.is_fully_confirmed
    self_graded = bool(grade and (grade.grader_is_self or grade.method == GradeMethod.SELF_CONFIRMED))
    estimated_only = bool(grade and grade.method == GradeMethod.AI_ESTIMATED)
    pending = grade is None or grade.status == GradeStatus.PENDING_REVIEW
    timing_ok = attempt.elapsed_ms > 0
    verification_mode = item.session.mode == SessionMode.VERIFICATION

    base_reasons: list[str] = []
    if not trusted_question:
        base_reasons.append("本题缺少已核对且无争议的答案")
    if pending:
        base_reasons.append("判分尚未完全确认")
    if estimated_only:
        base_reasons.append("仅有 AI 估计分，不作为正式分数")
    if self_graded:
        base_reasons.append("本次评分为自评确认，只产生自评证据")
    if not timing_ok:
        base_reasons.append("缺少可信用时记录")

    for mapping in nodes:
        node = mapping.node
        template = mapping.template
        node_id = node.id

        rows.append(
            {
                "dimension": EvidenceDimension.REPEAT_PRACTICE,
                "node": node,
                "qualifies": True,
                "is_correct": bool(grade and grade.is_fully_confirmed),
                "score_fraction": _fraction(grade),
                "exclusion_reasons": [],
                "detail": {"note": "原始提交存在即计入重复练习，即使看过答案也单列"},
            }
        )

        unassisted_reasons = list(assistance_reasons)
        unassisted = not assistance and not unassisted_reasons
        if not timing_ok:
            unassisted = False
            unassisted_reasons.append("缺少可信用时记录")
        rows.append(
            {
                "dimension": EvidenceDimension.UNASSISTED_COMPLETION,
                "node": node,
                "qualifies": unassisted,
                "is_correct": bool(grade and grade.is_fully_confirmed),
                "score_fraction": _fraction(grade),
                "exclusion_reasons": unassisted_reasons,
                "detail": {"note": "本次作答期间无辅助，不代表此前从未见过本题"},
            }
        )

        independent_reasons = list(base_reasons) + list(assistance_reasons) + seen_reasons
        if not confirmation_ok(item):
            independent_reasons.append("本次作答不足以作为独立能力证据（会话用途）")
        independent = (
            trusted_question
            and confirmed_grade
            and not assistance
            and not seen_reasons
            and not self_graded
            and not estimated_only
            and timing_ok
            and confirmation_ok(item)
        )
        rows.append(
            {
                "dimension": EvidenceDimension.INDEPENDENT_CORRECT,
                "node": node,
                "qualifies": independent,
                "is_correct": bool(confirmed_grade),
                "score_fraction": _fraction(grade),
                "exclusion_reasons": [] if independent else independent_reasons,
                "detail": {
                    "template_id": str(template.id) if template else None,
                    "verification_mode": verification_mode,
                },
            }
        )

        same_template_other_question = False
        if template is not None:
            same_template_other_question = (
                LearningEvidence.objects.filter(
                    user=attempt.user,
                    project_id=attempt.project_id,
                    knowledge_node=node,
                    dimension=EvidenceDimension.INDEPENDENT_CORRECT,
                    qualifies=True,
                )
                .exclude(attempt=attempt)
                .filter(detail__template_id=str(template.id))
                .exists()
            )
        template_variant = independent and same_template_other_question
        template_reasons = [] if template_variant else (
            independent_reasons
            if not independent
            else (["尚未在其他题目上以同一模板独立正确" if template is None else "尚无同模板的其他独立正确记录"])
        )
        rows.append(
            {
                "dimension": EvidenceDimension.TEMPLATE_VARIANT,
                "node": node,
                "qualifies": template_variant,
                "is_correct": bool(confirmed_grade),
                "score_fraction": _fraction(grade),
                "exclusion_reasons": template_reasons,
                "detail": {"template_id": str(template.id) if template else None},
            }
        )

        family = item.question_version.question.family
        near_duplicate = _is_near_duplicate(attempt, family)
        unseen_reasons: list[str] = []
        if not independent:
            unseen_reasons.extend(independent_reasons)
        if near_duplicate:
            unseen_reasons.append("本题目属于已知近重复家族，不能当作陌生变式")
        unseen = independent and not near_duplicate
        rows.append(
            {
                "dimension": EvidenceDimension.UNSEEN_VARIANT,
                "node": node,
                "qualifies": unseen,
                "is_correct": bool(confirmed_grade),
                "score_fraction": _fraction(grade),
                "exclusion_reasons": [] if unseen else unseen_reasons,
                "detail": {
                    "family_id": str(family.id) if family else None,
                    "family_confirmed": bool(family.relation_confirmed) if family else False,
                    "template_id": str(template.id) if template else None,
                },
            }
        )

        anchor, anchor_source = _last_relevant_anchor(attempt, node_id)
        tutoring_anchor = _tutoring_anchor(attempt, node_id)
        if tutoring_anchor and (anchor is None or tutoring_anchor > anchor):
            anchor, anchor_source = tutoring_anchor, "tutoring"
        delay_hours = getattr(settings, "DELAYED_VERIFICATION_HOURS", 24)
        delayed_reasons: list[str] = []
        if anchor is None:
            delayed_reasons.append("没有可用的延迟锚点（本题是该考点首次接触）")
        else:
            elapsed = (item.first_delivered_at or attempt.submitted_at) - anchor
            if elapsed < timedelta(hours=delay_hours):
                delayed_reasons.append(
                    f"距最近相关训练/教学仅 {elapsed.total_seconds() / 3600:.2f} 小时，未达到 {delay_hours} 小时"
                )
        if not independent:
            delayed_reasons.append("本次作答不是严格独立正确，不能作为延迟验证证据")
        if item.purpose != "delayed_verification" and item.session.origin_task_id:
            pass
        delayed = independent and anchor is not None and not delayed_reasons
        rows.append(
            {
                "dimension": EvidenceDimension.DELAYED_VERIFICATION,
                "node": node,
                "qualifies": delayed,
                "is_correct": bool(confirmed_grade),
                "score_fraction": _fraction(grade),
                "exclusion_reasons": [] if delayed else delayed_reasons,
                "detail": {
                    "delay_anchor_at": anchor.isoformat() if anchor else None,
                    "anchor_source": anchor_source,
                    "delay_hours_required": delay_hours,
                    "purpose": item.purpose,
                },
            }
        )
    return rows


def confirmation_ok(item) -> bool:
    """A verification item only counts once that verification run is finished."""
    session = item.session
    if session.mode == SessionMode.VERIFICATION and session.status == SessionStatus.ACTIVE:
        return False
    return True


def _fraction(grade) -> Decimal | None:
    if grade is None or grade.confirmed_score is None or grade.max_score in (None, 0):
        return None
    return (grade.confirmed_score / grade.max_score).quantize(Decimal("0.0001"))


def _is_near_duplicate(attempt: Attempt, family) -> bool:
    """Same family + different stable question = near duplicate, not unseen."""
    if family is None:
        return False
    question_id = attempt.session_item.question_version.question_id
    return (
        family.questions.exclude(id=question_id).exists()
        or attempt.session_item.question_version.question.family_id is not None
    )


@transaction.atomic
def rebuild_for_attempt(attempt_id: str) -> int:
    """Rebuild the evidence rows for one attempt at its current revision."""
    attempt = (
        Attempt.objects.select_related(
            "session_item__session", "session_item__question_version__question", "current_grade_event"
        )
        .filter(id=attempt_id)
        .first()
    )
    if attempt is None:
        return 0
    grade = attempt.current_grade_event
    revision = grade.grading_revision if grade else 0
    rows = compute_dimensions(attempt)
    created = 0
    for row in rows:
        payload = {
            "attempt": attempt,
            "session_item": attempt.session_item,
            "user": attempt.user,
            "project": attempt.project,
            "grade_event": grade,
            "grade_revision": revision,
            "knowledge_node": row["node"],
            "dimension": row["dimension"],
            "qualifies": row["qualifies"],
            "is_correct": row["is_correct"],
            "score_fraction": row["score_fraction"],
            "exclusion_reasons": row["exclusion_reasons"],
            "rule_version": RULE_VERSION,
            "computed_at": timezone.now(),
            "is_active": True,
            "detail": row["detail"],
        }
        LearningEvidence.objects.update_or_create(
            attempt=attempt,
            dimension=row["dimension"],
            knowledge_node=row["node"],
            grade_revision=revision,
            defaults=payload,
        )
        created += 1
    # Rows from a different grading revision describe an older judgement, so they
    # stay visible but stop counting. The filter is explicit about the revision
    # so a row written by another revision is never silently left active.
    LearningEvidence.objects.filter(attempt=attempt).exclude(grade_revision=revision).update(
        is_active=False, invalidated_at=timezone.now(), invalidated_reason="判分修订后重建"
    )
    return created


def rebuild_for_attempts(attempt_ids: list[str]) -> int:
    total = 0
    for attempt_id in attempt_ids:
        total += rebuild_for_attempt(str(attempt_id))
    return total


def invalidate_for_answer_version(answer_key_version_id: str) -> int:
    """Invalidate evidence that relied on an answer version now disputed."""
    rows = LearningEvidence.objects.filter(
        attempt__session_item__answer_key_version_id=answer_key_version_id, is_active=True
    )
    count = rows.count()
    rows.update(is_active=False, invalidated_at=timezone.now(), invalidated_reason="答案版本进入争议")
    return count


def evidence_summary_rows(*, user, project, node=None, limit: int = 100) -> list[dict]:
    queryset = (
        LearningEvidence.objects.filter(user=user, project=project, is_active=True)
        .select_related("knowledge_node", "attempt")
        .order_by("-computed_at")
    )
    if node is not None:
        queryset = queryset.filter(knowledge_node=node)
    return [
        {
            "id": str(row.id),
            "attempt_id": str(row.attempt_id),
            "node_id": str(row.knowledge_node_id) if row.knowledge_node_id else None,
            "node_name": row.knowledge_node.canonical_name if row.knowledge_node_id else None,
            "dimension": row.dimension,
            "qualifies": row.qualifies,
            "is_correct": row.is_correct,
            "score_fraction": str(row.score_fraction) if row.score_fraction is not None else None,
            "exclusion_reasons": row.exclusion_reasons,
            "rule_version": row.rule_version,
            "computed_at": row.computed_at.isoformat(),
            "grade_revision": row.grade_revision,
            "detail": row.detail,
        }
        for row in queryset[: max(1, min(limit, 200))]
    ]


def evidence_digest(attempt: Attempt) -> str:
    payload = f"{attempt.id}:{attempt.grading_revision}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


__all__ = [
    "ALL_DIMENSIONS",
    "RULE_VERSION",
    "compute_dimensions",
    "evidence_summary_rows",
    "invalidate_for_answer_version",
    "rebuild_for_attempt",
    "rebuild_for_attempts",
]
