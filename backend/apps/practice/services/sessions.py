"""Practice session creation, presentation, drafts and finishing."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.audit.services.outbox import enqueue
from apps.common.enums import (
    QuestionType,
    SessionMode,
    SessionStatus,
)
from apps.common.errors import InvalidInput, PurposeNotAllowed, ScopeViolation, VersionConflict
from apps.ingestion.services.access import presentation_asset_ids
from apps.practice.models import Attempt, GradeEvent, PracticeSession, SessionItem
from apps.practice.services import exposure
from apps.question_bank.models import QuestionVersion


def _latest_mapping_revision(version: QuestionVersion) -> int:
    node = version.knowledge_mappings.order_by("-mapping_revision").first()
    return node.mapping_revision if node else 1


def resolve_max_score_for_version(version: QuestionVersion, spec_version) -> Decimal:
    """Practice score: explicit per-question value, else the spec default."""
    if version.practice_max_score is not None:
        return version.practice_max_score
    if spec_version is not None:
        default = spec_version.default_max_score(version.question_type)
        if default is not None:
            return default
    raise InvalidInput(
        message="无法确定该题分值：请填写题目练习分值，或选择已配置该题型默认分值的考试规范",
        details={"question_version_id": str(version.id), "question_type": version.question_type},
    )


def _resolve_versions(version: QuestionVersion):
    """Pick the trusted answer and rubric for a version, or refuse to build an item."""
    answer = (
        version.answer_keys.filter(verification_status="checked", is_disputed=False).order_by("-version").first()
    )
    rubric = getattr(answer, "rubric", None) if answer is not None else None
    return answer, rubric


#: Task kinds that are checks, not practice. The server fixes their session mode.
TASK_KIND_MODES = {
    "delayed_verification": SessionMode.VERIFICATION,
    "paired_immediate": SessionMode.VERIFICATION,
    "weakness_repair": SessionMode.PRACTICE,
    "undiagnosed_probe": SessionMode.PRACTICE,
    "general_practice": SessionMode.PRACTICE,
}


def resolve_task_mode(*, mode: str, task) -> str:
    """Decide the session mode from the *task's* purpose, not the client's wish.

    A delayed-verification or paired-immediate task is a check: letting the
    client downgrade it to ``practice`` would make the answer visible and the
    "delayed" evidence meaningless.
    """
    if task is not None:
        return TASK_KIND_MODES.get(task.task_kind, mode)
    return mode


@transaction.atomic
def create_session(
    *,
    user,
    project,
    subject,
    mode: str = SessionMode.PRACTICE,
    question_ids: list[str] | None = None,
    task=None,
    spec_version=None,
    purpose: str = "practice",
    pairing=None,
    tutoring_allowed: bool | None = None,
) -> PracticeSession:
    """Freeze the versions for every item at creation time.

    The response carries only item ids and version lists; the stem is delivered
    later through the presentation endpoint so first-contact timing is honest.
    """
    if mode not in SessionMode.values:
        raise InvalidInput(message="会话模式无效")
    if mode == SessionMode.MOCK_EXAM:
        raise InvalidInput(message="模拟考试属于 P2，当前版本不提供；请使用练习或验证模式")
    if subject.project_id != project.id:
        raise ScopeViolation(message="科目不属于该项目")
    if spec_version is None:
        spec_version = (
            subject.exam_spec_versions.filter(status="published").order_by("-version").first()
        )

    question_ids = [str(value) for value in (question_ids or [])]
    if not question_ids and task is None:
        raise InvalidInput(message="请提供题目或学习任务")
    if task is not None:
        if str(task.project_id) != str(project.id) or str(task.subject_id) != str(subject.id):
            raise ScopeViolation(message="学习任务不属于当前项目/科目")
        # Re-check the real interval here as well: the API may create a session
        # straight from a task id without going through /study-tasks/{id}/start.
        from apps.learning.services import pairing as pairing_service

        interval = pairing_service.delayed_interval_status(task=task)
        if not interval["satisfied"]:
            raise InvalidInput(
                message=interval["reason"] or "该验证任务尚未到期，不能开始",
                details={"not_before": interval.get("not_before"), "task_id": str(task.id)},
            )
        # The task decides the mode; the client cannot downgrade a check.
        mode = resolve_task_mode(mode=mode, task=task)
        purpose = task.task_kind
        if task.question_id:
            question_ids = [str(task.question_id)]
        task.status = "in_progress"
        task.started_at = task.started_at or timezone.now()
        task.save(update_fields=["status", "started_at", "updated_at"])
        pairing = pairing or task.pairing
    elif purpose not in {"practice", "paired_immediate"}:
        # A client must not be able to *claim* a purpose that unlocks a different
        # flow (for example "delayed_verification" for a task that does not exist).
        raise InvalidInput(
            message="不能由客户端指定该会话用途；请通过对应的学习任务开始",
            details={"purpose": purpose},
        )

    session = PracticeSession.objects.create(
        user=user,
        project=project,
        subject=subject,
        mode=mode,
        status=SessionStatus.ACTIVE,
        origin_task=task,
        note=f"purpose={purpose}",
    )
    ordinal = 0
    for question_id in question_ids:
        version = (
            QuestionVersion.objects.filter(question_id=question_id, status="published")
            .select_related("question")
            .order_by("-version")
            .first()
        )
        if version is None:
            raise InvalidInput(message="题目没有已发布版本，不能用于练习", details={"question_id": question_id})
        if str(version.question.subject_id) != str(subject.id):
            raise ScopeViolation(message="题目不属于当前科目", details={"question_id": question_id})
        if not version.is_scorable_leaf:
            # A material parent is never a submittable item; use its children.
            for child_id in version.material_child_version_ids or []:
                child = QuestionVersion.objects.filter(id=child_id, status="published").select_related("question").first()
                if child is not None:
                    question_ids.append(str(child.question_id))
            continue
        answer, rubric = _resolve_versions(version)
        if answer is None:
            raise InvalidInput(
                message="该题没有已核对且无争议的答案，不能进入计分练习",
                details={"question_id": question_id},
            )
        max_score = resolve_max_score_for_version(version, spec_version)
        if version.question_type == QuestionType.CONSTRUCTED_RESPONSE:
            if rubric is None:
                raise InvalidInput(message="大题缺少评分标准（rubric），不能建题项", details={"question_id": question_id})
            if rubric.total_score != max_score:
                raise InvalidInput(
                    message=f"rubric 总分 {rubric.total_score} 与本次计分满分 {max_score} 不一致；请提供匹配的答案/rubric 版本",
                    details={"question_id": question_id},
                )
        ordinal += 1
        allowed = tutoring_allowed
        if allowed is None:
            allowed = mode == SessionMode.PRACTICE and purpose != "delayed_verification"
        SessionItem.objects.create(
            session=session,
            ordinal=ordinal,
            question_version=version,
            answer_key_version=answer,
            rubric_version=rubric,
            spec_version=spec_version,
            mapping_revision=_latest_mapping_revision(version),
            max_score=max_score,
            purpose=purpose,
            pairing=pairing,
            tutoring_allowed=bool(allowed),
        )
    if ordinal == 0:
        raise InvalidInput(message="没有可用于本次会话的计分题项")
    return session


# --------------------------------------------------------------------------
# Presentation
# --------------------------------------------------------------------------
def _material_payload(version: QuestionVersion) -> dict[str, Any] | None:
    if version.question_type != QuestionType.MATERIAL:
        return None
    return {"blocks": (version.content or {}).get("blocks", []), "child_version_ids": version.material_child_version_ids}


def stem_payload(version: QuestionVersion) -> dict[str, Any]:
    """Stem and options only: no correct markers, no answer, no rubric."""
    from apps.common.content import blank_ids

    content = version.content or {}
    options = []
    for option in content.get("options") or []:
        if not isinstance(option, dict):
            continue
        options.append(
            {
                "id": option.get("id"),
                "label": option.get("label") or option.get("id"),
                "blocks": option.get("blocks") or [],
            }
        )
    material = None
    if version.parent_material_version_id:
        material = _material_payload(version.parent_material_version)
    return {
        "question_version_id": str(version.id),
        "question_type": version.question_type,
        "blocks": content.get("blocks") or [],
        "options": options,
        "blanks": [
            {"blank_id": blank.get("blank_id"), "label": blank.get("label") or blank.get("blank_id")}
            for blank in content.get("blanks") or []
            if isinstance(blank, dict)
        ],
        "blank_ids": blank_ids(content),
        "material": material,
    }


def deliverable_asset_ids(version: QuestionVersion) -> set[str]:
    allowed = presentation_asset_ids(version)
    if version.parent_material_version_id:
        allowed |= presentation_asset_ids(version.parent_material_version)
    return allowed


def presentation(*, item: SessionItem, user, now=None) -> dict[str, Any]:
    """Deliver the current item and record the first delivery exactly once."""
    session = item.session
    if str(session.user_id) != str(user.id):
        raise ScopeViolation(message="题项不存在或不在当前权限范围")
    moment = now or timezone.now()
    first_time = False
    if item.first_delivered_at is None:
        item.first_delivered_at = moment
        item.save(update_fields=["first_delivered_at", "updated_at"])
        first_time = True
        exposure.record(
            user=user,
            project=session.project,
            question=item.question_version.question,
            question_version=item.question_version,
            session_item=item,
            kind="stem_delivered",
            purpose=session.mode if session.mode != SessionMode.MOCK_EXAM else "verification",
            source="session_item_presentation",
            reveals_answer=False,
            detail={"first_delivery": True},
        )
    allowed_assets = deliverable_asset_ids(item.question_version)
    return {
        "session_item_id": str(item.id),
        "session_id": str(session.id),
        "mode": session.mode,
        "ordinal": item.ordinal,
        "max_score": str(item.max_score),
        "purpose": item.purpose,
        "tutoring_allowed": bool(item.tutoring_allowed and session.mode == SessionMode.PRACTICE),
        "first_delivered_at": item.first_delivered_at.isoformat(),
        "server_time": moment.isoformat(),
        "first_delivery": first_time,
        "draft": item.draft or {},
        "draft_revision": item.draft_revision,
        "stem": stem_payload(item.question_version),
        "assets": [str(value) for value in sorted(allowed_assets)],
        "grading_hidden": session.hides_grading,
        "exam_deadline": session.exam_deadline.isoformat() if session.exam_deadline else None,
    }


@transaction.atomic
def save_draft(*, item: SessionItem, user, draft: dict, draft_revision: int | None, now=None) -> SessionItem:
    """Draft save with optimistic locking; a stale tab gets 409."""
    locked = SessionItem.objects.select_for_update().select_related("session").get(id=item.id)
    session = locked.session
    if str(session.user_id) != str(user.id):
        raise ScopeViolation(message="题项不存在或不在当前权限范围")
    if session.status != SessionStatus.ACTIVE:
        raise InvalidInput(message="会话已结束，不能再保存草稿")
    if Attempt.objects.filter(session_item=locked).exists():
        raise InvalidInput(message="该题项已提交，作答不可编辑；如需重做请新建题项")
    if draft_revision is not None and int(draft_revision) != int(locked.draft_revision):
        raise VersionConflict(
            message="草稿已在其他标签页更新，请刷新后再编辑",
            details={"expected": draft_revision, "actual": locked.draft_revision},
        )
    if not isinstance(draft, dict):
        raise InvalidInput(message="草稿必须是对象")
    locked.draft = draft
    locked.draft_revision += 1
    locked.draft_updated_at = now or timezone.now()
    locked.save(update_fields=["draft", "draft_revision", "draft_updated_at", "updated_at"])
    return locked


@transaction.atomic
def finish_session(*, session: PracticeSession, user, now=None) -> PracticeSession:
    locked = PracticeSession.objects.select_for_update().get(id=session.id)
    if str(locked.user_id) != str(user.id):
        raise ScopeViolation(message="会话不存在或不在当前权限范围")
    if locked.status == SessionStatus.FINISHED:
        return locked
    locked.status = SessionStatus.FINISHED
    locked.finished_at = now or timezone.now()
    if locked.mode in {SessionMode.VERIFICATION, SessionMode.MOCK_EXAM}:
        locked.revealed_at = locked.finished_at
    locked.save(update_fields=["status", "finished_at", "revealed_at", "updated_at"])
    if locked.origin_task_id:
        from apps.learning.models import StudyTask

        StudyTask.objects.filter(id=locked.origin_task_id).update(
            status="completed", completed_at=locked.finished_at, updated_at=timezone.now()
        )
    enqueue(
        "learning.on_session_finished",
        {"session_id": str(locked.id)},
        dedupe_key=f"session-finished:{locked.id}",
    )
    return locked


def grade_payload(grade: GradeEvent | None, *, session: PracticeSession, hidden: bool | None = None) -> dict[str, Any] | None:
    """Serialise a grade event, respecting the session's reveal rules."""
    if grade is None:
        return None
    if hidden is None:
        hidden = session.hides_grading
    if hidden:
        return None
    return {
        "grade_event_id": str(grade.id),
        "status": grade.status,
        "method": grade.method,
        "grading_revision": grade.grading_revision,
        "confirmed_score": None if grade.confirmed_score is None else str(grade.confirmed_score),
        "max_score": str(grade.max_score),
        "pending_max_score": str(grade.pending_max_score),
        "estimated_score": None if grade.estimated_score is None else str(grade.estimated_score),
        # "已全部评分" and "本题完全正确" are different facts: a wrong answer is
        # fully graded and still incorrect.
        "is_fully_confirmed": grade.is_fully_confirmed,
        "is_correct": is_grade_correct(grade),
        "parts": grade.parts,
        "rule_version": grade.rule_version,
        "rule_snapshot": grade.rule_snapshot,
        "grader_is_self": grade.grader_is_self,
        "comment": grade.comment,
        "superseded": grade.is_superseded,
    }


def is_grade_correct(grade: GradeEvent | None) -> bool:
    """Fully confirmed *and* at full marks.

    Only this may be presented as "本题完全正确"; ``is_fully_confirmed`` alone
    means every scoring part has been decided.
    """
    if grade is None or not grade.is_fully_confirmed or grade.confirmed_score is None:
        return False
    if grade.max_score is None or grade.max_score <= 0:
        return False
    return grade.confirmed_score >= grade.max_score


def attempt_state(attempt: Attempt | None, *, session: PracticeSession, hidden: bool | None = None) -> dict[str, Any] | None:
    if attempt is None:
        return None
    if hidden is None:
        hidden = session.hides_grading
    return {
        "attempt_id": str(attempt.id),
        "submitted_at": attempt.submitted_at.isoformat(),
        "elapsed_ms": attempt.elapsed_ms,
        "grading_revision": attempt.grading_revision,
        "grade": grade_payload(attempt.current_grade_event, session=session, hidden=hidden),
        "receipt_only": bool(hidden),
    }


def delivery_hidden_for_item(*, item: SessionItem, user, content_map: dict[str, set[str]] | None = None) -> bool:
    """Must this item's grading be withheld from *this* delivery, right now?

    The single decision used by every result-delivering path (session snapshot,
    submit replay, confirm-grade replay, attempt read, reveal). Idempotency only
    guarantees "the same effect is not applied twice" — it never grants a
    permanent right to read a sensitive response, so replay paths re-serialise
    through this function instead of returning a stored body verbatim (C01).
    """
    from apps.practice.services import verification_gate

    if item.session.hides_grading:
        return True
    return verification_gate.content_gate_blocks_item(item=item, content_map=content_map, user=user)


def session_state(session: PracticeSession, *, user, include_stems: bool = False) -> dict[str, Any]:
    """Session snapshot. Nothing here reveals answers or scores while hidden.

    "Hidden" has two independent sources and both must be applied on *every*
    delivery, not only on the direct attempt read:

    * the session hides its own grading (a running verification / mock exam);
    * the content is covered by *another* running verification (the parallel
      practice session of C01 — the score of a practice attempt is as good as the
      answer while the verification that contains the same content is open).

    The second rule is content-based and shared with reports, evidence and the
    grading queue (:mod:`apps.practice.services.verification_gate`), so hiding one
    entry point cannot be bypassed through another.
    """
    from apps.practice.services import verification_gate

    content_map = verification_gate.active_verification_content_map(user=user)
    items = []
    withheld_item_ids: list[str] = []
    for item in session.items.select_related(
        "question_version__question", "answer_key_version", "rubric_version"
    ).order_by("ordinal"):
        attempt = Attempt.objects.filter(session_item=item).first()
        # A verification item covers itself: only *another* covering item withholds
        # this row's grading, which is what `content_gate_blocks_item` checks.
        withheld = verification_gate.content_gate_blocks_item(item=item, content_map=content_map)
        if withheld:
            withheld_item_ids.append(str(item.id))
        row_hidden = session.hides_grading or withheld
        row: dict[str, Any] = {
            "session_item_id": str(item.id),
            "ordinal": item.ordinal,
            "question_id": str(item.question_version.question_id),
            "question_type": item.question_version.question_type,
            "display_label": item.question_version.question.display_label,
            "max_score": str(item.max_score),
            "purpose": item.purpose,
            "first_delivered_at": item.first_delivered_at.isoformat() if item.first_delivered_at else None,
            "draft_revision": item.draft_revision,
            "has_draft": bool(item.draft),
            "tutoring_allowed": bool(item.tutoring_allowed and session.mode == SessionMode.PRACTICE),
            # Stable ids the UI must use after a reload or a deep link: the
            # reveal and tutoring endpoints take the attempt / item id, so
            # neither may depend on a one-shot presentation response (R09).
            "attempt_id": str(attempt.id) if attempt is not None else None,
            "can_reveal": not row_hidden,
            "grading_withheld": withheld,
            "attempt": attempt_state(attempt, session=session, hidden=row_hidden),
        }
        if include_stems:
            row["stem"] = stem_payload(item.question_version)
        items.append(row)
    hidden = session.hides_grading
    # The session total mixes every item. While one of them is withheld the total
    # would leak it back as a number, so the totals are omitted as a whole rather
    # than silently summing a subset.
    totals_hidden = hidden or bool(withheld_item_ids)
    confirmed, pending = _session_score(session)
    if hidden:
        hidden_reason = "验证进行中：结束本次验证后才会显示分数与正误。"
    elif withheld_item_ids:
        hidden_reason = (
            "该会话包含正在验证中的同源内容：为避免泄露答案，验证结束前不显示本会话的分数。"
            "无关会话不受影响。"
        )
    else:
        hidden_reason = None
    return {
        "session_id": str(session.id),
        "project_id": str(session.project_id),
        "subject_id": str(session.subject_id),
        "mode": session.mode,
        "status": session.status,
        "policy_version": session.policy_version,
        "grading_hidden": hidden,
        "revealed_at": session.revealed_at.isoformat() if session.revealed_at else None,
        "created_at": session.created_at.isoformat(),
        "finished_at": session.finished_at.isoformat() if session.finished_at else None,
        "items": items,
        # While grading is hidden the totals are omitted, not merely flagged: a
        # client must not be able to derive the score from the payload at all.
        "confirmed_score": None if totals_hidden else str(confirmed),
        "pending_max_score": None if totals_hidden else str(pending),
        "score_visible": not totals_hidden,
        "score_hidden_reason": hidden_reason,
        "grading_withheld_session_item_ids": withheld_item_ids,
    }


def _session_score(session: PracticeSession) -> tuple[Decimal, Decimal]:
    confirmed = Decimal("0")
    pending = Decimal("0")
    attempts = Attempt.objects.filter(session_item__session=session).select_related("current_grade_event")
    for attempt in attempts:
        grade = attempt.current_grade_event
        if grade is None:
            continue
        if grade.confirmed_score is not None:
            confirmed += grade.confirmed_score
        pending += grade.pending_max_score
    return confirmed, pending


# --------------------------------------------------------------------------
# Reveal
# --------------------------------------------------------------------------
def reveal_payload(*, item: SessionItem, session: PracticeSession) -> dict[str, Any]:
    """Trusted answer and reviewed explanation for one item."""
    answer = item.answer_key_version
    payload: dict[str, Any] = {
        "question_version_id": str(item.question_version_id),
        "answer_key_version_id": str(answer.id) if answer else None,
        "answer_payload": answer.answer_payload if answer else {},
        "answer_source_type": answer.source_type if answer else None,
        "answer_verification_status": answer.verification_status if answer else None,
        "check_basis": answer.check_basis if answer else "",
        "explanation_blocks": answer.explanation_blocks if answer else [],
        "rubric": None,
        "confidence_note": "",
    }
    if answer is None:
        payload["confidence_note"] = "该题没有可用答案，仅能提供已审核的人工解析（若有）。"
    elif not answer.is_usable:
        payload["confidence_note"] = "该题答案尚未核对或存在争议；此处内容不作为判分依据。"
    if item.rubric_version_id:
        payload["rubric"] = {
            "rubric_version_id": str(item.rubric_version_id),
            "criteria": item.rubric_version.criteria,
            "total_score": str(item.rubric_version.total_score),
        }
    return payload


def assert_reveal_allowed(*, item: SessionItem, session: PracticeSession, before_submit: bool) -> None:
    if session.mode == SessionMode.PRACTICE:
        return
    if before_submit:
        raise PurposeNotAllowed(message="验证/考试模式在提交前不提供答案或完整讲解")
    if session.hides_grading:
        raise PurposeNotAllowed(message="验证尚未结束：请先结束本次验证，再查看答案与讲解")
