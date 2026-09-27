"""Attempt submission and grade events.

Submission is idempotent and single-shot per session item:

1. lock the session item
2. check the session is still submittable and the idempotency key
3. store the attempt (raw answer only, never overwriting an earlier one)
4. produce the initial grade event (deterministic, or pending review)
5. point the attempt at the effective grade event and enqueue evidence rebuild

A retry with the same key and payload returns the same result; a different
payload on the same key, or a second submission for the same item, is a 409.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.analytics.models import RegradeRun
from apps.audit.models import ContentRevision
from apps.audit.services.outbox import enqueue
from apps.common.enums import (
    GradeEventKind,
    GradeMethod,
    GradeStatus,
    QuestionType,
    SessionStatus,
)
from apps.common.errors import (
    AlreadySubmitted,
    InvalidInput,
    PurposeNotAllowed,
    ScopeViolation,
    StructureInvalid,
    VersionConflict,
)
from apps.practice.models import Attempt, GradeEvent, SessionItem
from domain.grading import adapters

logger = logging.getLogger("apps.practice.attempts")


def rule_snapshot_for(item: SessionItem) -> dict[str, Any]:
    """Freeze the awarding rule at submission time."""
    spec_rule: dict[str, Any] = {}
    if item.spec_version_id:
        spec_rule = item.spec_version.rule_for(item.question_version.question_type)
    answer_payload = item.answer_key_version.answer_payload if item.answer_key_version_id else {}
    return {
        "spec_version_id": str(item.spec_version_id) if item.spec_version_id else None,
        "question_type": item.question_version.question_type,
        "spec_rule": spec_rule,
        "answer_rule": {
            key: answer_payload.get(key)
            for key in ("policy", "partial_score", "wrong_score", "blank_score", "mismatch_policy")
            if answer_payload.get(key) is not None
        },
        "max_score": str(item.max_score),
    }


def merged_rule(item: SessionItem) -> dict[str, Any]:
    """Spec defaults, overridden by explicit answer-level rules."""
    rule: dict[str, Any] = dict(rule_snapshot_for(item).get("spec_rule") or {})
    answer_payload = item.answer_key_version.answer_payload if item.answer_key_version_id else {}
    for key in ("policy", "partial_score", "wrong_score", "blank_score", "mismatch_policy"):
        if answer_payload.get(key) is not None:
            rule[key] = answer_payload.get(key)
    return rule


def validate_answer_shape(item: SessionItem, raw_answer: dict) -> None:
    """The submitted answer must match the question actually presented."""
    if not isinstance(raw_answer, dict):
        raise StructureInvalid(message="作答必须是对象")
    declared = raw_answer.get("type")
    expected = item.question_version.question_type
    if declared != expected:
        raise StructureInvalid(
            message="作答类型与题目类型不一致",
            details={"expected": expected, "received": declared},
        )
    content = item.question_version.content or {}
    if expected in {QuestionType.SINGLE_CHOICE, QuestionType.MULTIPLE_CHOICE}:
        allowed = {str(option.get("id")) for option in content.get("options") or [] if isinstance(option, dict)}
        selected = raw_answer.get("selected_option_ids")
        if selected is None and raw_answer.get("selected_option_id") is not None:
            selected = [raw_answer.get("selected_option_id")]
        if selected is None:
            selected = []
        if not isinstance(selected, list):
            raise StructureInvalid(message="选项作答必须是数组")
        unknown = [str(value) for value in selected if str(value) not in allowed]
        if unknown:
            raise StructureInvalid(message="提交了不属于该题的选项 ID", details={"unknown_option_ids": unknown})
        if len({str(value) for value in selected}) != len(selected):
            raise StructureInvalid(message="同一选项被重复提交")
        if expected == QuestionType.SINGLE_CHOICE and len(selected) > 1:
            raise StructureInvalid(message="单选题只能选择一个选项")
    elif expected == QuestionType.TRUE_FALSE:
        value = raw_answer.get("value", None)
        if value is not None and not isinstance(value, bool):
            raise StructureInvalid(message="判断题作答必须是 true/false，或留空表示未答")
    elif expected == QuestionType.FILL_BLANK:
        blanks = raw_answer.get("blanks")
        if blanks is not None and not isinstance(blanks, dict):
            raise StructureInvalid(message="填空作答必须按空位 ID 给出对象")
        allowed_blank_ids = {
            str(blank.get("blank_id")) for blank in content.get("blanks") or [] if isinstance(blank, dict)
        }
        for blank_id, value in (blanks or {}).items():
            if allowed_blank_ids and str(blank_id) not in allowed_blank_ids:
                raise StructureInvalid(message=f"提交了不属于该题的空位：{blank_id}")
            if value is not None and not isinstance(value, str):
                raise StructureInvalid(message="空位作答必须是字符串原文")
    elif expected == QuestionType.CONSTRUCTED_RESPONSE:
        text = raw_answer.get("text", "")
        if text is None or not isinstance(text, str):
            raise StructureInvalid(message="大题作答文本必须是字符串")


def _locked_session_item(session_item_id: str) -> SessionItem | None:
    """Lock a session item row, then load related objects without the lock.

    PostgreSQL refuses ``FOR UPDATE`` on the nullable side of an outer join, so
    locking and joining are always two separate statements in this module.
    """
    row = SessionItem.objects.select_for_update().filter(id=session_item_id).first()
    if row is None:
        return None
    return (
        SessionItem.objects.select_related(
            "session", "question_version__question", "answer_key_version", "rubric_version", "spec_version"
        )
        .filter(id=row.id)
        .first()
    )


def _locked_attempt(attempt_id: str) -> Attempt | None:
    """Lock an attempt row, then load its related objects without the lock.

    Splitting the two steps avoids "FOR UPDATE cannot be applied to the nullable
    side of an outer join" when a related FK is nullable.
    """
    row = Attempt.objects.select_for_update().filter(id=attempt_id).first()
    if row is None:
        return None
    return (
        Attempt.objects.select_related(
            "session_item__session",
            "session_item__question_version__question",
            "session_item__answer_key_version",
            "session_item__rubric_version",
            "current_grade_event",
        )
        .filter(id=row.id)
        .first()
    )


def _validate_attachments(project, user, asset_ids: list[str]) -> list[str]:
    from django.conf import settings

    from apps.ingestion.models import Asset

    if not asset_ids:
        return []
    max_count = getattr(settings, "ATTEMPT_MAX_ATTACHMENTS", 6)
    if len(asset_ids) > max_count:
        raise InvalidInput(message=f"每道作答最多上传 {max_count} 张图片")
    assets = list(Asset.objects.filter(id__in=asset_ids, project=project, owner=user))
    if len(assets) != len(set(map(str, asset_ids))):
        raise ScopeViolation(message="附件不存在或不属于当前项目")
    total = sum(asset.size_bytes for asset in assets)
    max_bytes = getattr(settings, "ATTEMPT_MAX_ATTACHMENT_BYTES", 30 * 1024 * 1024)
    if total > max_bytes:
        raise InvalidInput(message="附件总大小超过上限")
    return [str(asset.id) for asset in assets]


@transaction.atomic
def submit_attempt(
    *,
    session_item_id: str,
    user,
    raw_answer: dict,
    steps: list | None = None,
    asset_ids: list | None = None,
    confidence: str = "",
    client_active_ms: int | None = None,
    now=None,
) -> tuple[Attempt, GradeEvent]:
    """Store the attempt and its initial grade event."""
    item = _locked_session_item(session_item_id)
    if item is None:
        raise ScopeViolation(message="题项不存在或不在当前权限范围")
    session = item.session
    if str(session.user_id) != str(user.id):
        raise ScopeViolation(message="题项不存在或不在当前权限范围")
    if session.status != SessionStatus.ACTIVE:
        raise InvalidInput(message="会话已结束，不能继续提交")
    existing = Attempt.objects.filter(session_item=item).first()
    if existing is not None:
        raise AlreadySubmitted(details={"attempt_id": str(existing.id)})

    # B02: grading is an answer-delivery path. While the same content is under a
    # running verification, a parallel practice attempt may not be scored — the
    # score is the answer. Placed in the service so every entry point (API,
    # retry, future callers) is covered, not just the one endpoint that was
    # reported.
    from apps.practice.services import verification_gate

    verification_gate.assert_grading_not_blocked(item=item, action="提交普通练习并取得评分")

    validate_answer_shape(item, raw_answer)
    attachment_ids = _validate_attachments(session.project, user, list(asset_ids or []))
    moment = now or timezone.now()
    elapsed_ms = 0
    if item.first_delivered_at:
        elapsed_ms = max(0, int((moment - item.first_delivered_at).total_seconds() * 1000))
    attempt = Attempt.objects.create(
        session_item=item,
        user=user,
        project=session.project,
        raw_answer=raw_answer,
        steps=steps or [],
        attachments=attachment_ids,
        confidence=confidence[:16],
        submitted_at=moment,
        elapsed_ms=elapsed_ms,
        client_active_ms=client_active_ms,
    )
    grade = create_initial_grade(attempt, item=item, now=moment)
    return attempt, grade


def create_initial_grade(attempt: Attempt, *, item: SessionItem, now=None) -> GradeEvent:
    """Deterministic grade, or pending_review where the rules cannot decide.

    The frozen answer/rubric versions on the item are re-checked against their
    *current* trust state first: an answer disputed after this item was
    presented must not keep grading new submissions. The raw answer is always
    stored, and the disputed submission goes to human review instead.
    """
    moment = now or timezone.now()
    distrust = _content_trust_blocker(item)
    if distrust is not None:
        return _create_pending_grade(
            attempt,
            item=item,
            reason=distrust,
            method=GradeMethod.MIXED,
            kind=GradeEventKind.INITIAL,
            now=moment,
        )
    answer_payload = item.answer_key_version.answer_payload if item.answer_key_version_id else {}
    rubric_payload = None
    if item.rubric_version_id:
        rubric_payload = {
            "criteria": item.rubric_version.criteria,
            "total_score": str(item.rubric_version.total_score),
        }
    result = adapters.grade(
        question_type=item.question_version.question_type,
        raw_answer=attempt.raw_answer,
        answer_payload=answer_payload,
        max_score=item.max_score,
        rule=merged_rule(item),
        rubric=rubric_payload,
    )
    grade = GradeEvent.objects.create(
        attempt=attempt,
        kind=GradeEventKind.INITIAL,
        status=result.status,
        method=result.method,
        grading_revision=1,
        confirmed_score=result.confirmed_score,
        max_score=item.max_score,
        pending_max_score=result.pending_max_score,
        is_fully_confirmed=result.is_fully_confirmed,
        parts=result.as_dict()["parts"],
        answer_key_version_id=item.answer_key_version_id,
        rubric_version_id=item.rubric_version_id,
        spec_version_id=item.spec_version_id,
        rule_snapshot=rule_snapshot_for(item),
        rule_version=item.session.policy_version,
        comment="; ".join(result.notes)[:1000],
    )
    attempt.current_grade_event = grade
    attempt.grading_revision = grade.grading_revision
    attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])
    if item.first_delivered_at is None:
        # Submitting without an explicit presentation still counts as delivered.
        item.first_delivered_at = moment
        item.save(update_fields=["first_delivered_at", "updated_at"])
    enqueue(
        "projection.rebuild_attempt_evidence",
        {"attempt_id": str(attempt.id)},
        dedupe_key=f"evidence:{attempt.id}:{grade.grading_revision}",
    )
    enqueue(
        "learning.on_attempt_graded",
        {"attempt_id": str(attempt.id), "grade_event_id": str(grade.id)},
        dedupe_key=f"graded:{attempt.id}:{grade.grading_revision}",
    )
    return grade


def _content_trust_blocker(item: SessionItem) -> str | None:
    """Why the frozen grading input may no longer be used for new grading."""
    answer = item.answer_key_version
    if answer is not None and not answer.is_usable:
        return "本题固定答案已进入争议或失去可信状态：本次原始作答已保存，判分转人工复核"
    rubric = item.rubric_version
    if rubric is not None and getattr(rubric, "is_disputed", False):
        return "本题固定评分标准已进入争议：本次原始作答已保存，判分转人工复核"
    return None


def _create_pending_grade(
    attempt: Attempt,
    *,
    item: SessionItem,
    reason: str,
    method: str,
    kind: str = GradeEventKind.INVALIDATION,
    now=None,
) -> GradeEvent:
    """Persist a fully-pending grade event without inventing a score."""
    parts = [
        {
            "part_id": str(criterion.get("criterion_id")) if isinstance(criterion, dict) else "part",
            "score": None,
            "max_score": str(criterion.get("max_score", "0")) if isinstance(criterion, dict) else str(item.max_score),
            "status": GradeStatus.PENDING_REVIEW,
            "method": None,
            "detail": {"reason": reason},
        }
        for criterion in (item.rubric_version.criteria if item.rubric_version_id else [])
    ] or [
        {
            "part_id": "item",
            "score": None,
            "max_score": str(item.max_score),
            "status": GradeStatus.PENDING_REVIEW,
            "method": None,
            "detail": {"reason": reason},
        }
    ]
    # Everything is still undecided, so the whole maximum is the pending value.
    pending_total = sum((Decimal(str(part["max_score"])) for part in parts), Decimal("0"))
    grade = GradeEvent.objects.create(
        attempt=attempt,
        kind=kind,
        status=GradeStatus.PENDING_REVIEW,
        method=method,
        grading_revision=1,
        confirmed_score=None,
        max_score=item.max_score,
        pending_max_score=pending_total,
        is_fully_confirmed=False,
        parts=parts,
        answer_key_version_id=item.answer_key_version_id,
        rubric_version_id=item.rubric_version_id,
        spec_version_id=item.spec_version_id,
        rule_snapshot=rule_snapshot_for(item),
        rule_version=item.session.policy_version,
        comment=reason[:1000],
        invalidation_reason=reason[:500] if kind == GradeEventKind.INVALIDATION else "",
    )
    attempt.current_grade_event = grade
    attempt.grading_revision = grade.grading_revision
    attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])
    if item.first_delivered_at is None:
        item.first_delivered_at = now or timezone.now()
        item.save(update_fields=["first_delivered_at", "updated_at"])
    enqueue(
        "projection.rebuild_attempt_evidence",
        {"attempt_id": str(attempt.id)},
        dedupe_key=f"evidence:{attempt.id}:{grade.grading_revision}",
    )
    return grade


# --------------------------------------------------------------------------
# Manual confirmation (constructed responses and review fallbacks)
# --------------------------------------------------------------------------
@transaction.atomic
def confirm_grade(
    *,
    attempt_id: str,
    user,
    parts: list[dict],
    expected_grading_revision: int,
    answer_key_version_id: str | None = None,
    rubric_version_id: str | None = None,
    comment: str = "",
) -> GradeEvent:
    """Human confirmation of a manual rubric or of a pending blank review."""
    attempt = _locked_attempt(attempt_id)
    if attempt is None:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    item = attempt.session_item
    session = item.session
    if str(attempt.user_id) != str(user.id) and not user.is_staff:
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    # The hidden-run gate applies to the *mutation*, not only to the response:
    # re-scoring a live verification attempt would leak its result through later
    # reads even if this call returned nothing.
    if session.hides_grading:
        raise PurposeNotAllowed(message="验证/考试进行中：不能对本次作答确认评分，请先结束该次验证")
    if expected_grading_revision is None:
        raise VersionConflict(message="缺少 expected_grading_revision，请重新加载评分页")
    if int(expected_grading_revision) != int(attempt.grading_revision):
        raise VersionConflict(details={"expected": expected_grading_revision, "actual": attempt.grading_revision})
    if answer_key_version_id and str(answer_key_version_id) != str(item.answer_key_version_id or ""):
        raise VersionConflict(message="评分依据的答案版本已变化，请重新加载")
    if rubric_version_id and str(rubric_version_id) != str(item.rubric_version_id or ""):
        raise VersionConflict(message="评分依据的 rubric 版本已变化，请重新加载")
    distrust = _content_trust_blocker(item)
    if distrust is not None:
        raise PurposeNotAllowed(message=f"{distrust}；请先处理答案争议")

    is_self = str(user.id) == str(attempt.user_id)
    method = GradeMethod.SELF_CONFIRMED if is_self else GradeMethod.REVIEWER_CONFIRMED
    previous = attempt.current_grade_event
    max_score = item.max_score

    if item.question_version.question_type == QuestionType.CONSTRUCTED_RESPONSE:
        confirmed_parts, total = _confirm_rubric_parts(item, parts)
    else:
        confirmed_parts, total = _confirm_pending_parts(item, parts, previous)
    # Only the parts that are still undecided count as pending. Lost marks on a
    # part that has been decided are a result, not unscored work.
    pending_total = sum(
        (Decimal(str(part.get("max_score") or "0")) for part in confirmed_parts if part.get("status") != GradeStatus.CONFIRMED),
        Decimal("0"),
    )
    fully_confirmed = pending_total == 0 and all(
        part.get("status") == GradeStatus.CONFIRMED for part in confirmed_parts
    )
    # Each decided part records *how* it was decided; the event-level method
    # stays `mixed` when a part was scored by the model and another by a human.
    for part in confirmed_parts:
        if part.get("status") == GradeStatus.CONFIRMED and not part.get("method"):
            part["method"] = method
    grade = GradeEvent.objects.create(
        attempt=attempt,
        kind=GradeEventKind.MANUAL_CONFIRMATION,
        status=GradeStatus.CONFIRMED if fully_confirmed else GradeStatus.PENDING_REVIEW,
        method=method,
        grading_revision=attempt.grading_revision + 1,
        confirmed_score=total,
        max_score=max_score,
        pending_max_score=pending_total,
        is_fully_confirmed=fully_confirmed,
        parts=confirmed_parts,
        answer_key_version_id=item.answer_key_version_id,
        rubric_version_id=item.rubric_version_id,
        spec_version_id=item.spec_version_id,
        rule_snapshot=rule_snapshot_for(item),
        rule_version=session.policy_version,
        grader=user,
        grader_is_self=is_self,
        comment=comment[:1000],
        supersedes=previous,
    )
    if previous is not None:
        previous.is_superseded = True
        previous.save(update_fields=["is_superseded", "updated_at"])
    attempt.current_grade_event = grade
    attempt.grading_revision = grade.grading_revision
    attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])
    ContentRevision.objects.create(
        actor=user,
        entity_type="grade_event",
        entity_id=str(grade.id),
        action="manual_confirmation",
        project_id=attempt.project_id,
        detail={"method": method, "is_self": is_self, "score": str(total)},
    )
    enqueue(
        "projection.rebuild_attempt_evidence",
        {"attempt_id": str(attempt.id)},
        dedupe_key=f"evidence:{attempt.id}:{grade.grading_revision}",
    )
    enqueue(
        "learning.on_attempt_graded",
        {"attempt_id": str(attempt.id), "grade_event_id": str(grade.id)},
        dedupe_key=f"graded:{attempt.id}:{grade.grading_revision}",
    )
    return grade


def _confirm_rubric_parts(item: SessionItem, parts: list[dict]) -> tuple[list[dict], Decimal]:
    rubric = item.rubric_version
    if rubric is None:
        raise InvalidInput(message="该题缺少 rubric，无法逐评分点确认")
    criteria = {str(c.get("criterion_id")): c for c in rubric.criteria if isinstance(c, dict)}
    submitted = {str(part.get("part_id")): part for part in parts if isinstance(part, dict)}
    missing_required = [
        criterion_id
        for criterion_id, criterion in criteria.items()
        if criterion.get("required") and criterion_id not in submitted
    ]
    if missing_required:
        raise InvalidInput(message="存在未确认的必填评分点", details={"missing_criteria": missing_required})
    unknown = [part_id for part_id in submitted if part_id not in criteria]
    if unknown:
        raise InvalidInput(message="提交了不属于该 rubric 的评分点", details={"unknown_criteria": unknown})

    confirmed_parts: list[dict] = []
    total = Decimal("0")
    for criterion_id, criterion in criteria.items():
        criterion_max = Decimal(str(criterion.get("max_score", "0")))
        part = submitted.get(criterion_id)
        if part is None:
            confirmed_parts.append(
                {
                    "part_id": criterion_id,
                    "score": None,
                    "max_score": str(criterion_max),
                    "status": GradeStatus.PENDING_REVIEW,
                    "method": None,
                    "detail": {"text": criterion.get("text", "")},
                }
            )
            continue
        raw_score = part.get("score")
        if raw_score in (None, ""):
            raise InvalidInput(message=f"评分点 {criterion_id} 缺少分值")
        try:
            score = Decimal(str(raw_score))
        except Exception as exc:
            raise InvalidInput(message=f"评分点 {criterion_id} 的分值必须是十进制数") from exc
        if score < 0 or score > criterion_max:
            raise InvalidInput(
                message=f"评分点 {criterion_id} 的分值必须在 0 到 {criterion_max} 之间",
                details={"criterion_id": criterion_id, "max_score": str(criterion_max)},
            )
        scale = criterion.get("scale")
        if scale:
            step = Decimal(str(scale))
            if step > 0 and (score % step) != 0:
                raise InvalidInput(
                    message=f"评分点 {criterion_id} 必须按 {step} 的刻度给分",
                    details={"criterion_id": criterion_id, "scale": str(step)},
                )
        confirmed_parts.append(
            {
                "part_id": criterion_id,
                "score": str(score),
                "max_score": str(criterion_max),
                "status": GradeStatus.CONFIRMED,
                "method": None,  # set by the caller to the event-level method
                "detail": {
                    "text": criterion.get("text", ""),
                    "comment": str(part.get("comment", ""))[:300],
                },
            }
        )
        total += score
    return confirmed_parts, total


def _confirm_pending_parts(
    item: SessionItem, parts: list[dict], previous: GradeEvent | None
) -> tuple[list[dict], Decimal]:
    """Confirm previously pending blanks, keeping already-confirmed parts."""
    prior_parts = {
        str(part.get("part_id")): part for part in (previous.parts if previous else []) if isinstance(part, dict)
    }
    submitted = {str(part.get("part_id")): part for part in parts if isinstance(part, dict)}
    if not submitted:
        raise InvalidInput(message="请给出至少一个评分点的确认结果")
    confirmed_parts: list[dict] = []
    total = Decimal("0")
    for part_id, prior in prior_parts.items():
        part_max = Decimal(str(prior.get("max_score", "0")))
        override = submitted.get(part_id)
        if override is None:
            if prior.get("status") == GradeStatus.CONFIRMED and prior.get("score") is not None:
                total += Decimal(str(prior["score"]))
            confirmed_parts.append(prior)
            continue
        decision = str(override.get("decision") or "award")
        if decision == "keep_pending":
            confirmed_parts.append({**prior, "status": GradeStatus.PENDING_REVIEW, "score": None, "method": None})
            continue
        raw_score = override.get("score")
        if raw_score in (None, ""):
            raise InvalidInput(message=f"评分点 {part_id} 缺少分值")
        score = Decimal(str(raw_score))
        if score < 0 or score > part_max:
            raise InvalidInput(message=f"评分点 {part_id} 的分值必须在 0 到 {part_max} 之间")
        confirmed_parts.append(
            {
                **prior,
                "score": str(score),
                "status": GradeStatus.CONFIRMED,
                "detail": {**(prior.get("detail") or {}), "comment": str(override.get("comment", ""))[:300]},
            }
        )
        total += score
    for part_id in submitted:
        if part_id not in prior_parts:
            raise InvalidInput(message=f"评分点 {part_id} 不属于该题", details={"part_id": part_id})
    return confirmed_parts, total


# --------------------------------------------------------------------------
# Regrade and dispute handling
# --------------------------------------------------------------------------
@transaction.atomic
def regrade_attempt(
    *,
    attempt: Attempt,
    target_answer_key_version,
    target_rubric_version=None,
    actor=None,
    reason: str = "",
    regrade_generation: int | None = None,
) -> GradeEvent | None:
    """Re-grade one attempt against a reviewed new answer version.

    The original attempt and its initial grade event are preserved. Each regrade
    request carries a monotonic *generation* captured when the run was created.
    The attempt stores the newest generation that actually wrote a result, so a
    request issued earlier can never overwrite one issued later - even when the
    older task is executed last, and even when both target the same revision.

    Returns ``None`` when the request is stale and nothing was written.
    """
    locked = _locked_attempt(attempt.id)
    if locked is None:  # pragma: no cover - the attempt existed a moment ago
        raise ScopeViolation(message="作答不存在或不在当前权限范围")
    item = locked.session_item
    if str(target_answer_key_version.question_version_id) != str(item.question_version_id):
        raise InvalidInput(message="目标答案版本不属于该题项固定的题目版本，不能机械重判")
    target_answer_key_version, target_rubric_version = recheck_regrade_target(
        target_answer_key_version, target_rubric_version
    )
    if regrade_generation is not None and int(regrade_generation) <= int(locked.applied_regrade_generation):
        logger.info(
            "stale regrade skipped attempt=%s generation=%s already_applied=%s",
            locked.id,
            regrade_generation,
            locked.applied_regrade_generation,
        )
        return None
    rule: dict[str, Any] = dict(
        item.spec_version.rule_for(item.question_version.question_type) if item.spec_version_id else {}
    )
    for key in ("policy", "partial_score", "wrong_score", "blank_score", "mismatch_policy"):
        if target_answer_key_version.answer_payload.get(key) is not None:
            rule[key] = target_answer_key_version.answer_payload.get(key)
    result = adapters.grade(
        question_type=item.question_version.question_type,
        raw_answer=locked.raw_answer,
        answer_payload=target_answer_key_version.answer_payload,
        max_score=item.max_score,
        rule=rule,
        rubric={"criteria": target_rubric_version.criteria, "total_score": str(target_rubric_version.total_score)}
        if target_rubric_version is not None
        else None,
    )
    previous = locked.current_grade_event
    target = int(locked.grading_revision) + 1
    grade = GradeEvent.objects.create(
        attempt=locked,
        kind=GradeEventKind.REGRADE,
        status=result.status,
        method=result.method,
        grading_revision=target,
        confirmed_score=result.confirmed_score,
        max_score=item.max_score,
        pending_max_score=result.pending_max_score,
        is_fully_confirmed=result.is_fully_confirmed,
        parts=result.as_dict()["parts"],
        answer_key_version=target_answer_key_version,
        rubric_version=target_rubric_version,
        spec_version_id=item.spec_version_id,
        rule_snapshot={
            **rule_snapshot_for(item),
            "regrade_reason": reason[:500],
            "regrade_generation": regrade_generation,
        },
        rule_version=item.session.policy_version,
        grader=actor,
        comment=reason[:1000],
        supersedes=previous,
    )
    if previous is not None:
        previous.is_superseded = True
        previous.save(update_fields=["is_superseded", "updated_at"])
    locked.current_grade_event = grade
    locked.grading_revision = grade.grading_revision
    if regrade_generation is not None:
        # High-water mark: only ever moves forward.
        locked.applied_regrade_generation = max(int(locked.applied_regrade_generation), int(regrade_generation))
    locked.save(update_fields=["current_grade_event", "grading_revision", "applied_regrade_generation", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="grade_event",
        entity_id=str(grade.id),
        action="regrade",
        project_id=locked.project_id,
        reason=reason[:500],
        detail={"answer_key_version_id": str(target_answer_key_version.id), "revision": grade.grading_revision},
    )
    enqueue(
        "projection.rebuild_attempt_evidence",
        {"attempt_id": str(locked.id)},
        dedupe_key=f"evidence:{locked.id}:{grade.grading_revision}",
    )
    enqueue(
        "projection.regrade_effects",
        {"attempt_id": str(locked.id), "grade_event_id": str(grade.id)},
        dedupe_key=f"regrade-effects:{locked.id}:{grade.grading_revision}",
    )
    return grade


def handle_answer_dispute(answer_key_version, *, actor, reason: str) -> int:
    """Move affected attempts to human review; raw answers stay untouched."""
    attempts = Attempt.objects.filter(
        session_item__answer_key_version=answer_key_version, current_grade_event__isnull=False
    ).select_related("current_grade_event")
    affected = 0
    for attempt in attempts:
        previous = attempt.current_grade_event
        if previous is None:
            continue
        if previous.status == GradeStatus.PENDING_REVIEW:
            affected += 1
            continue
        grade = GradeEvent.objects.create(
            attempt=attempt,
            kind=GradeEventKind.INVALIDATION,
            status=GradeStatus.PENDING_REVIEW,
            method=GradeMethod.MIXED,
            grading_revision=attempt.grading_revision + 1,
            confirmed_score=None,
            max_score=previous.max_score,
            pending_max_score=previous.max_score,
            is_fully_confirmed=False,
            parts=[
                {
                    "part_id": part.get("part_id"),
                    "score": None,
                    "max_score": part.get("max_score"),
                    "status": GradeStatus.PENDING_REVIEW,
                    "method": None,
                    "detail": {"reason": "答案进入争议，原判分不再作为正式分数"},
                }
                for part in (previous.parts or [])
            ],
            answer_key_version=answer_key_version,
            rubric_version_id=previous.rubric_version_id,
            spec_version_id=previous.spec_version_id,
            rule_snapshot=previous.rule_snapshot,
            rule_version=previous.rule_version,
            grader=actor,
            comment=f"答案争议：{reason[:400]}",
            supersedes=previous,
            invalidation_reason=reason[:500],
        )
        previous.is_superseded = True
        previous.save(update_fields=["is_superseded", "updated_at"])
        attempt.current_grade_event = grade
        attempt.grading_revision = grade.grading_revision
        attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])
        affected += 1
    return affected


@transaction.atomic
def start_regrade_run(
    *,
    question,
    target_answer_key_version,
    target_rubric_version=None,
    actor,
    reason: str,
    scope: str = "all_attempts",
) -> RegradeRun:
    """Queue one regrade request with a unique, monotonic generation.

    B01: the previous version read ``MAX(generation) + 1`` from "the newest run
    of this question" while holding a lock on *that run*. Two concurrent
    requests therefore read the same maximum and both inserted the same number,
    and the lock was useless because the locked row was not the row the number
    belongs to.

    The number now comes from the database sequence, which is atomic, monotonic
    and never blocks, and ``uniq_regrade_question_generation`` makes a duplicate
    impossible even if this code regresses. Locking the stable question row for the
    whole request instead would serialise unrelated regrade requests of the same
    question and couple two independent business actions to one lock scope; that
    is a scope/coupling problem, not a claim that a row lock "inherently
    deadlocks" — the earlier concurrency counter-example used a barrier a
    correctly serialised implementation cannot cross either, so it never
    demonstrated a liveness defect (see docs/12 §2).
    """
    if not reason.strip():
        raise InvalidInput(message="重判必须说明原因")
    if str(target_answer_key_version.question_version.question_id) != str(question.id):
        raise InvalidInput(message="目标答案版本不属于该题目")
    # Re-read the target inside this transaction: the caller's object may be a
    # stale copy from before a dispute landed.
    target = _fresh_regrade_target(question, target_answer_key_version)
    if target.verification_status != "checked" or target.is_disputed:
        raise InvalidInput(message="重判目标必须是已核对且无争议的答案版本")
    run = RegradeRun.objects.create(
        user=question.subject.project.owner,
        project=question.subject.project,
        subject=question.subject,
        question=question,
        target_answer_key_version=target,
        target_rubric_version=target_rubric_version,
        reason=reason[:500],
        scope=scope,
        requested_by=actor,
        generation=RegradeRun.allocate_generation(),
        affected_attempts=Attempt.objects.filter(
            session_item__question_version__question=question, project=question.subject.project
        ).count(),
    )
    enqueue("projection.run_regrade", {"regrade_run_id": str(run.id)}, dedupe_key=f"regrade-run:{run.id}")
    return run


def _fresh_regrade_target(question, target_answer_key_version):
    """Fresh copy of the regrade target, owned by ``question``.

    The caller may hold an object read before a dispute or a new revision
    landed; the request must be validated against what is stored now.
    """
    from apps.question_bank.models import AnswerKeyVersion

    target = AnswerKeyVersion.objects.filter(
        id=target_answer_key_version.id, question_version__question=question
    ).first()
    if target is None:
        raise InvalidInput(message="目标答案版本不属于该题目")
    return target


class RegradeTargetUntrusted(InvalidInput):
    """The queued regrade's target answer/rubric is no longer trustworthy.

    Raised at *execution* time (B03), not at request time: a run is queued
    against a reviewed revision and that revision can be disputed before a worker
    picks the run up. Confirming a score against a disputed revision would make
    ``current_grade_event.answer_key_version.is_disputed`` true on a confirmed
    grade, which is exactly the state the product forbids.
    """


def recheck_regrade_target(target_answer_key_version, target_rubric_version=None):
    """Re-read and lock the regrade target; refuse a disputed/unchecked revision.

    Called inside the execution transaction so the decision is made on locked
    rows: a dispute that lands while a regrade is running either happens before
    this check (and the run is refused) or after the regrade committed (where the
    ordinary dispute path invalidates the new grade).
    """
    from apps.question_bank.models import AnswerKeyVersion, RubricVersion

    target = (
        AnswerKeyVersion.objects.select_for_update().filter(id=target_answer_key_version.id).first()
    )
    if target is None:
        raise RegradeTargetUntrusted(message="重判目标的答案版本已不存在，重判已拒绝")
    if target.is_disputed or target.verification_status != "checked":
        raise RegradeTargetUntrusted(
            message="重判目标的答案版本已进入争议或不再是已核对状态，不能据此确认评分",
            details={
                "reason": "regrade_target_untrusted",
                "answer_key_version_id": str(target.id),
                "verification_status": target.verification_status,
                "is_disputed": bool(target.is_disputed),
            },
        )
    if target_rubric_version is not None:
        rubric = RubricVersion.objects.select_for_update().filter(id=target_rubric_version.id).first()
        if rubric is None or rubric.is_disputed:
            raise RegradeTargetUntrusted(
                message="重判目标的评分标准已进入争议，不能据此确认评分",
                details={"reason": "regrade_rubric_untrusted", "rubric_version_id": str(target_rubric_version.id)},
            )
        target_rubric_version = rubric
    return target, target_rubric_version


def invalidate_for_untrusted_regrade_target(
    *, attempts, actor, reason: str, refused_generation: int | None = None
) -> tuple[int, int]:
    """Move attempts covered by a refused regrade to human review.

    A queued regrade means the official score of these attempts is under review.
    If its target turns out to be disputed, silently keeping the old confirmed
    number would present a settled score for content the project has just called
    into question. The raw answers and the earlier grade events are preserved;
    only the *effective* grade becomes pending review, with the reason recorded.

    **Generation guard (C02).** "This run was refused" does not mean "this
    attempt's effective grade is wrong": the attempt may already carry the result
    of a *newer* regrade that was requested after the refused one. An older
    disputed run must therefore not revoke a newer valid grade — the same
    high-water rule the normal regrade branch already applies. ``refused_generation``
    is compared against ``applied_regrade_generation`` per attempt; attempts above
    the watermark are skipped and counted, never rewritten.

    Returns ``(invalidated, skipped_newer)``.
    """
    affected = 0
    skipped_newer = 0
    for attempt in attempts:
        if refused_generation is not None and int(attempt.applied_regrade_generation) > int(
            refused_generation
        ):
            # A newer regrade produced this attempt's effective grade. The older
            # refused run has no authority over it; revoking it here would delete a
            # valid result and destroy the ordering the high-water mark provides.
            logger.info(
                "refused regrade generation=%s cannot revoke attempt=%s applied_generation=%s",
                refused_generation,
                attempt.id,
                attempt.applied_regrade_generation,
            )
            skipped_newer += 1
            continue
        previous = attempt.current_grade_event
        if previous is None or previous.status == GradeStatus.PENDING_REVIEW:
            affected += 1 if previous is not None else 0
            continue
        grade = GradeEvent.objects.create(
            attempt=attempt,
            kind=GradeEventKind.INVALIDATION,
            status=GradeStatus.PENDING_REVIEW,
            method=GradeMethod.MIXED,
            grading_revision=attempt.grading_revision + 1,
            confirmed_score=None,
            max_score=previous.max_score,
            pending_max_score=previous.max_score,
            is_fully_confirmed=False,
            parts=[
                {
                    "part_id": part.get("part_id"),
                    "score": None,
                    "max_score": part.get("max_score"),
                    "status": GradeStatus.PENDING_REVIEW,
                    "method": None,
                    "detail": {"reason": reason[:300]},
                }
                for part in (previous.parts or [])
            ],
            answer_key_version_id=previous.answer_key_version_id,
            rubric_version_id=previous.rubric_version_id,
            spec_version_id=previous.spec_version_id,
            rule_snapshot=previous.rule_snapshot,
            rule_version=previous.rule_version,
            grader=actor,
            comment=reason[:1000],
            supersedes=previous,
            invalidation_reason=reason[:500],
        )
        previous.is_superseded = True
        previous.save(update_fields=["is_superseded", "updated_at"])
        attempt.current_grade_event = grade
        attempt.grading_revision = grade.grading_revision
        attempt.save(update_fields=["current_grade_event", "grading_revision", "updated_at"])
        ContentRevision.objects.create(
            actor=actor,
            entity_type="grade_event",
            entity_id=str(grade.id),
            action="regrade_refused_target_untrusted",
            project_id=attempt.project_id,
            reason=reason[:500],
            detail={
                "superseded_grade_event_id": str(previous.id),
                "refused_generation": refused_generation,
            },
        )
        affected += 1
    return affected, skipped_newer

