"""Family merge and family membership: absorb one near-duplicate family into another.

docs/05 §3 C03: 合并家族后检查旧暴露并使证据失效 — after two families are merged,
the questions that used to be "different families" are no longer distinct, so

1. the merge re-checks the learner-facing exposure of **every** question in the
   merged family through :mod:`apps.learning.services.contamination` and records
   what changed, and
2. evidence that claimed distinctness (``unseen_variant`` / ``template_variant``,
   plus any row naming the old family) is *invalidated* — never deleted — with the
   reason 家族合并后不再构成不同家族证据, and the affected knowledge states are
   recomputed through the existing state service.

A merged family is contaminated as a whole: a question counts as seen if *any*
member of the merged family was seen. That rule lives in
:mod:`apps.learning.services.contamination` (next to the other C04 rules), driven
by the ``QuestionFamily.merged_into`` / ``merged_at`` audit pair written here, so
every recomputation — not just this one — agrees with it.

The merge is append-only and idempotent: the questions move, the surviving
family's ``revision`` is bumped, one ``ContentRevision`` names both families, and
repeating the same merge is a no-op that writes nothing.

This module also owns the plain membership operations the family API needs
(:func:`create_family`, :func:`update_family`, :func:`add_question_to_family`,
:func:`remove_question_from_family`). Every one of them refuses sealed content
through the sealing resolver and writes its own ``ContentRevision``, so "who put
this question into this family, and when" is answerable without reading the
merge path.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q, TextField
from django.db.models.functions import Cast
from django.utils import timezone

from apps.audit.models import ContentRevision
from apps.common.enums import EvidenceDimension
from apps.common.errors import InvalidInput, PurposeNotAllowed, ScopeViolation
from apps.exams.models import ExamProject
from apps.learning.services import contamination
from apps.learning.services import state as state_service
from apps.practice.models import ExposureEvent, LearningEvidence
from apps.question_bank.models import Question, QuestionFamily
from apps.question_bank.services import sealing

#: The exact ``invalidated_reason`` C03 requires on stale evidence rows.
MERGE_INVALIDATION_REASON = "家族合并后不再构成不同家族证据"

#: Dimensions that exist because two questions were *different* families.
DISTINCTNESS_DIMENSIONS = (
    EvidenceDimension.UNSEEN_VARIANT,
    EvidenceDimension.TEMPLATE_VARIANT,
)


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
def _validate_merge(*, project, source_family, target_family) -> None:
    if source_family is None or target_family is None:
        raise ScopeViolation(message="题族不存在或不属于该项目")
    if str(source_family.id) == str(target_family.id):
        raise InvalidInput(message="不能把一个家族合并到它自身")
    if str(source_family.subject.project_id) != str(project.id) or str(target_family.subject.project_id) != str(
        project.id
    ):
        raise ScopeViolation(message="题族不存在或不属于该项目")
    if str(source_family.subject_id) != str(target_family.subject_id):
        raise InvalidInput(
            message="跨科目的家族不能合并：近重复关系只在同一科目内有意义",
            details={
                "source_subject_id": str(source_family.subject_id),
                "target_subject_id": str(target_family.subject_id),
            },
        )
    if Question.objects.filter(family=source_family).exclude(subject_id=target_family.subject_id).exists():
        raise InvalidInput(message="源家族存在不属于目标科目的问题，不能合并；请先修正家族归属")
    if source_family.merged_into_id is not None and str(source_family.merged_into_id) != str(target_family.id):
        raise InvalidInput(
            message="该家族已合并到其他家族，不能再次合并",
            details={"merged_into": str(source_family.merged_into_id)},
        )


def _merged_question_ids(*, source_family, target_family) -> list[str]:
    return [
        str(value)
        for value in Question.objects.filter(family_id__in=[source_family.id, target_family.id]).values_list(
            "id", flat=True
        )
    ]


# --------------------------------------------------------------------------
# Affected rows
# --------------------------------------------------------------------------
def _evidence_queryset(*, source_family, merged_question_ids: Iterable[str]):
    """Active evidence that the merge makes stale.

    Two independent claims are caught, exactly as C03 requires:

    * a ``unseen_variant`` / ``template_variant`` row for a question of the merged
      family — those dimensions only exist because the questions were treated as
      different families; and
    * any row whose stored ``detail`` or ``exclusion_reasons`` names the old
      family id, whatever its dimension.
    """
    ids = [str(value) for value in merged_question_ids]
    dimensions = Q(
        dimension__in=list(DISTINCTNESS_DIMENSIONS),
        attempt__session_item__question_version__question_id__in=ids,
    )
    references = Q(detail_text__icontains=str(source_family.id)) | Q(
        reasons_text__icontains=str(source_family.id)
    )
    return (
        LearningEvidence.objects.filter(is_active=True)
        .annotate(detail_text=Cast("detail", TextField()), reasons_text=Cast("exclusion_reasons", TextField()))
        .filter(dimensions | references)
    )


def _affected_users(*, project, question_ids: Iterable[str]) -> list:
    """Who has to be re-checked: the owner plus anyone with facts on these questions."""
    ids = [str(value) for value in question_ids]
    user_ids = {str(project.owner_id)}
    user_ids.update(
        str(value)
        for value in LearningEvidence.objects.filter(
            attempt__session_item__question_version__question_id__in=ids
        ).values_list("user_id", flat=True)
    )
    user_ids.update(
        str(value)
        for value in ExposureEvent.objects.filter(question_id__in=ids).values_list("user_id", flat=True)
    )
    return list(get_user_model().objects.filter(id__in=sorted(user_ids)).order_by("date_joined", "id"))


def _exposure_states(*, users: list, project, question_ids: list[str]) -> dict[str, dict[str, dict]]:
    """``user_id -> question_id -> exposure_state`` for the merged family."""
    if not question_ids:
        return {}
    return {
        str(user.id): contamination.exposure_state(user=user, question_ids=question_ids, project=project)
        for user in users
    }


def _seen(states: dict[str, dict], question_id: str) -> bool:
    return bool((states.get(question_id) or {}).get("seen"))


def _seen_count(states: dict[str, dict], question_ids: list[str]) -> int:
    return sum(1 for question_id in question_ids if _seen(states, question_id))


def _predicted_exposure_after(*, before: dict[str, dict[str, dict]], question_ids: list[str]) -> dict[str, int]:
    """Post-merge seen counts per user, using the merged-family rule.

    The rule (implemented in ``contamination``): in a merged family a question is
    seen as soon as any member is seen. Predicting it here is what lets
    :func:`merge_impact` report the same numbers the merge will actually produce.
    """
    predicted: dict[str, int] = {}
    for user_id, states in before.items():
        any_member_seen = any(_seen(states, question_id) for question_id in question_ids)
        predicted[user_id] = len(question_ids) if any_member_seen else _seen_count(states, question_ids)
    return predicted


def _exposure_changes(*, before: dict[str, dict[str, dict]], after: dict[str, dict[str, dict]]) -> list[dict]:
    changed: list[dict] = []
    for user_id, states_before in before.items():
        states_after = after.get(user_id, {})
        for question_id, state_after in states_after.items():
            if state_after.get("seen") and not _seen(states_before, question_id):
                changed.append(
                    {
                        "user_id": user_id,
                        "question_id": question_id,
                        "seen_before": False,
                        "seen_after": True,
                        "reasons": list(state_after.get("reasons") or []),
                    }
                )
    return changed


# --------------------------------------------------------------------------
# Family CRUD (the API behind /question-families)
# --------------------------------------------------------------------------
def _require_family_in_project(*, project, family) -> QuestionFamily:
    if family is None or str(family.subject.project_id) != str(project.id):
        raise ScopeViolation(message="题族不存在或不属于该项目")
    return family


def family_payload(*, project, family: QuestionFamily) -> dict[str, Any]:
    """One family as the API reports it: membership plus the sealing decision.

    ``sealed`` comes from the resolver, never from a local reading of
    ``QuestionPoolPolicy``; ``sealed_member_count`` counts members sealed by any
    policy (family *or* their own), so a partially sealed family is visible
    instead of looking untouched.
    """
    member_ids = [str(value) for value in Question.objects.filter(family=family).values_list("id", flat=True)]
    family_sealed = str(family.id) in sealing.sealed_family_ids(project=project, family_ids=[family.id])
    sealed_members = sealing.sealed_question_ids(project=project, question_ids=member_ids)
    return {
        "id": str(family.id),
        "subject_id": str(family.subject_id),
        "name": family.name,
        "revision": family.revision,
        "relation_confirmed": family.relation_confirmed,
        "note": family.note,
        "member_count": len(member_ids),
        "sealed": family_sealed,
        "sealed_reason": sealing.SEALED_FAMILY if family_sealed else "",
        "sealed_member_count": len(sealed_members),
        "merged_into_id": str(family.merged_into_id) if family.merged_into_id else None,
        "merged_at": family.merged_at.isoformat() if family.merged_at else None,
    }


@transaction.atomic
def create_family(*, project, subject, name: str, actor, note: str = "", reason: str = "") -> QuestionFamily:
    """Create one family. Names are unique per subject (the DB constraint owns it)."""
    if subject is None:
        raise InvalidInput(message="必须指定科目")
    if str(subject.project_id) != str(project.id):
        raise ScopeViolation(message="科目不属于该项目")
    clean_name = (name or "").strip()
    if not clean_name:
        raise InvalidInput(message="家族名称不能为空")
    if QuestionFamily.objects.filter(subject=subject, name=clean_name).exists():
        raise InvalidInput(message="同一科目下已存在同名家族", details={"name": clean_name})
    family = QuestionFamily.objects.create(
        subject=subject, name=clean_name[:200], note=(note or "")[:500], relation_confirmed=False
    )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_family",
        entity_id=str(family.id),
        action="create",
        project_id=project.id,
        reason=(reason or "")[:500],
        detail={"subject_id": str(subject.id), "name": family.name},
    )
    return family


@transaction.atomic
def update_family(
    *,
    project,
    family: QuestionFamily,
    actor,
    name: str | None = None,
    relation_confirmed: bool | None = None,
    note: str | None = None,
    reason: str = "",
) -> QuestionFamily:
    """Rename / confirm / annotate a family. Membership changes go through the
    add/remove functions (or :func:`merge_families`) so every change is audited."""
    family = _require_family_in_project(project=project, family=family)
    locked = QuestionFamily.objects.select_for_update().get(id=family.id)
    changed: dict[str, Any] = {}
    if name is not None:
        clean_name = name.strip()
        if not clean_name:
            raise InvalidInput(message="家族名称不能为空")
        if clean_name != locked.name and QuestionFamily.objects.filter(
            subject_id=locked.subject_id, name=clean_name
        ).exists():
            raise InvalidInput(message="同一科目下已存在同名家族", details={"name": clean_name})
        changed["name"] = clean_name[:200]
    if relation_confirmed is not None:
        changed["relation_confirmed"] = bool(relation_confirmed)
    if note is not None:
        changed["note"] = note[:500]
    if not changed:
        return locked
    before = {key: getattr(locked, key) for key in changed}
    for key, value in changed.items():
        setattr(locked, key, value)
    locked.save(update_fields=[*changed, "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_family",
        entity_id=str(locked.id),
        action="update",
        project_id=project.id,
        reason=(reason or "")[:500],
        detail={"before": before, "after": changed},
    )
    return locked


@transaction.atomic
def add_question_to_family(
    *, project, family: QuestionFamily, question: Question, actor, reason: str = ""
) -> tuple[Question, bool]:
    """Put one question into a family. Returns ``(question, changed)``.

    Refusals, in the order they are checked:

    * a question of another project/subject — a family is subject-scoped;
    * a **sealed** question (C03: adding it would silently change what a seal
      covers) or a **sealed family** (the new member would become sealed without
      anyone deciding it), each with the sealing reason code on the error;
    * an already-member question is a no-op success, so the POST is idempotent
      even without replaying the idempotency key.
    """
    family = _require_family_in_project(project=project, family=family)
    if question is None or str(question.subject.project_id) != str(project.id):
        raise ScopeViolation(message="题目不存在或不属于该项目")
    if str(question.subject_id) != str(family.subject_id):
        raise InvalidInput(
            message="题目与家族不属于同一科目，不能加入",
            details={"question_subject_id": str(question.subject_id), "family_subject_id": str(family.subject_id)},
        )
    sealing.assert_not_sealed(question=question, project=project, action="加入家族")
    if str(family.id) in sealing.sealed_family_ids(project=project, family_ids=[family.id]):
        raise PurposeNotAllowed(
            message=f"封存内容不可加入家族：{sealing.reason_message(sealing.SEALED_FAMILY)}",
            details={"reason": sealing.SEALED_FAMILY, "family_id": str(family.id), "action": "加入家族"},
        )
    if str(question.family_id or "") == str(family.id):
        return question, False
    previous_family_id = str(question.family_id) if question.family_id else None
    question.family = family
    question.save(update_fields=["family", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_family",
        entity_id=str(family.id),
        action="add_question",
        project_id=project.id,
        reason=(reason or "")[:500],
        detail={"question_id": str(question.id), "previous_family_id": previous_family_id},
    )
    return question, True


@transaction.atomic
def remove_question_from_family(
    *, project, family: QuestionFamily, question: Question, actor, reason: str = ""
) -> tuple[Question, bool]:
    """Move one question out of a family (back to "no family"). Returns ``(question, changed)``.

    Removing from a *sealed family* is refused: dropping the last member would
    unseal content that a policy explicitly sealed, which must be an explicit
    ``unseal`` instead. A question sealed by its own policy may be moved out — it
    stays sealed either way.
    """
    family = _require_family_in_project(project=project, family=family)
    if question is None or str(question.subject.project_id) != str(project.id):
        raise ScopeViolation(message="题目不存在或不属于该项目")
    if str(question.family_id or "") != str(family.id):
        raise InvalidInput(message="该题不在这个家族中", details={"question_id": str(question.id)})
    if str(family.id) in sealing.sealed_family_ids(project=project, family_ids=[family.id]):
        raise PurposeNotAllowed(
            message=f"封存内容不可移出家族：{sealing.reason_message(sealing.SEALED_FAMILY)}请先解除家族封存。",
            details={"reason": sealing.SEALED_FAMILY, "family_id": str(family.id), "action": "移出家族"},
        )
    question.family = None
    question.save(update_fields=["family", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_family",
        entity_id=str(family.id),
        action="remove_question",
        project_id=project.id,
        reason=(reason or "")[:500],
        detail={"question_id": str(question.id)},
    )
    return question, True


# --------------------------------------------------------------------------
# Preview
# --------------------------------------------------------------------------
def merge_impact(*, project, source_family, target_family) -> dict[str, Any]:
    """What a merge would do, before anyone confirms it.

    The counts are computed with the *same* helpers the merge uses, so a human can
    compare the preview with the outcome: ``questions_to_move`` is the number of
    questions that will change family, ``evidence_rows_to_invalidate`` is the
    number of active evidence rows that will be invalidated (never deleted), and
    ``exposed_before_merge`` / ``exposed_after_merge`` are the seen-question counts
    of the merged family before and after the family rule applies.
    """
    _validate_merge(project=project, source_family=source_family, target_family=target_family)
    source_ids = [str(v) for v in Question.objects.filter(family=source_family).values_list("id", flat=True)]
    target_ids = [str(v) for v in Question.objects.filter(family=target_family).values_list("id", flat=True)]
    merged_ids = sorted(set(source_ids) | set(target_ids))
    users = _affected_users(project=project, question_ids=merged_ids)
    before = _exposure_states(users=users, project=project, question_ids=merged_ids)
    predicted = _predicted_exposure_after(before=before, question_ids=merged_ids)
    evidence_queryset = _evidence_queryset(source_family=source_family, merged_question_ids=merged_ids)
    already_merged = source_family.merged_into_id is not None and str(source_family.merged_into_id) == str(
        target_family.id
    )
    return {
        "project_id": str(project.id),
        "source_family_id": str(source_family.id),
        "target_family_id": str(target_family.id),
        "source_family_name": source_family.name,
        "target_family_name": target_family.name,
        "already_merged": already_merged,
        "questions_to_move": len(source_ids),
        "questions_in_target_after": len(merged_ids),
        "evidence_rows_to_invalidate": 0 if already_merged else evidence_queryset.count(),
        "affected_user_ids": sorted(str(user.id) for user in users),
        "exposed_before_merge": _seen_count(before.get(str(project.owner_id), {}), merged_ids),
        "exposed_after_merge": predicted.get(str(project.owner_id), 0),
        "exposed_question_ids_before_merge": [
            question_id for question_id in merged_ids if _seen(before.get(str(project.owner_id), {}), question_id)
        ],
    }


# --------------------------------------------------------------------------
# Merge
# --------------------------------------------------------------------------
@transaction.atomic
def merge_families(*, project, source_family, target_family, actor, reason: str = "") -> dict[str, Any]:
    """Absorb ``source_family`` into ``target_family`` and invalidate stale proof.

    Returns the outcome, including the counts :func:`merge_impact` predicted. A
    repeated merge of the same pair writes nothing and reports ``noop=True``.
    """
    _validate_merge(project=project, source_family=source_family, target_family=target_family)
    moment = timezone.now()
    target_locked = QuestionFamily.objects.select_for_update().get(id=target_family.id)
    source_locked = QuestionFamily.objects.select_for_update().get(id=source_family.id)

    if source_locked.merged_into_id is not None and str(source_locked.merged_into_id) == str(target_locked.id):
        merged_ids = _merged_question_ids(source_family=source_locked, target_family=target_locked)
        users = _affected_users(project=project, question_ids=merged_ids)
        states = _exposure_states(users=users, project=project, question_ids=merged_ids)
        return {
            "project_id": str(project.id),
            "source_family_id": str(source_locked.id),
            "target_family_id": str(target_locked.id),
            "merge_revision": target_locked.revision,
            "questions_moved": 0,
            "questions_in_target_after": len(merged_ids),
            "evidence_invalidated": 0,
            "states_recomputed": 0,
            "exposed_before_merge": _seen_count(states.get(str(project.owner_id), {}), merged_ids),
            "exposed_after_merge": _seen_count(states.get(str(project.owner_id), {}), merged_ids),
            "exposure_changes": [],
            "affected_user_ids": sorted(str(user.id) for user in users),
            "noop": True,
            "content_revision_id": None,
        }

    merged_ids = _merged_question_ids(source_family=source_locked, target_family=target_locked)
    users = _affected_users(project=project, question_ids=merged_ids)

    # 1. Re-check old exposure *before* the move, so the change can be recorded.
    before = _exposure_states(users=users, project=project, question_ids=merged_ids)

    # 2. Move the questions and record the merge itself (audit pair + revision).
    moved = Question.objects.filter(family=source_locked).update(family=target_locked, updated_at=moment)
    target_locked.revision = target_locked.revision + 1
    target_locked.save(update_fields=["revision", "updated_at"])
    source_locked.merged_into = target_locked
    source_locked.merged_at = moment
    source_locked.save(update_fields=["merged_into", "merged_at", "updated_at"])

    # 3. Recompute exposure through the C04 rule; the merged family now
    #    contaminates every member as soon as one member was seen.
    after = _exposure_states(users=users, project=project, question_ids=merged_ids)
    changes = _exposure_changes(before=before, after=after)

    # 4. Invalidate (never delete) the evidence that claimed family distinctness,
    #    then recompute the knowledge states that consumed it.
    stale_rows = list(
        _evidence_queryset(source_family=source_locked, merged_question_ids=merged_ids).values_list(
            "id", "user_id", "project_id", "knowledge_node_id", "dimension"
        )
    )
    stale_ids = [str(row[0]) for row in stale_rows]
    if stale_ids:
        LearningEvidence.objects.filter(id__in=stale_ids).update(
            is_active=False, invalidated_at=moment, invalidated_reason=MERGE_INVALIDATION_REASON
        )
    states_recomputed = _refresh_states(rows=stale_rows)

    revision = ContentRevision.objects.create(
        actor=actor,
        entity_type="question_family",
        entity_id=str(target_locked.id),
        action="merge",
        project_id=project.id,
        reason=(reason or "")[:500],
        detail={
            "source_family_id": str(source_locked.id),
            "source_family_name": source_locked.name,
            "target_family_id": str(target_locked.id),
            "target_family_name": target_locked.name,
            "target_revision": target_locked.revision,
            "questions_moved": moved,
            "merged_question_ids": merged_ids,
            "evidence_invalidated": len(stale_ids),
            "invalidated_evidence_ids": stale_ids,
            "invalidated_reason": MERGE_INVALIDATION_REASON,
            "states_recomputed": states_recomputed,
            "exposure_changes": changes,
        },
    )
    return {
        "project_id": str(project.id),
        "source_family_id": str(source_locked.id),
        "target_family_id": str(target_locked.id),
        "merge_revision": target_locked.revision,
        "questions_moved": moved,
        "questions_in_target_after": len(merged_ids),
        "evidence_invalidated": len(stale_ids),
        "states_recomputed": states_recomputed,
        "exposed_before_merge": _seen_count(before.get(str(project.owner_id), {}), merged_ids),
        "exposed_after_merge": _seen_count(after.get(str(project.owner_id), {}), merged_ids),
        "exposure_changes": changes,
        "affected_user_ids": sorted(str(user.id) for user in users),
        "noop": False,
        "content_revision_id": str(revision.id),
    }


def _refresh_states(*, rows: list[tuple]) -> int:
    """Recompute the knowledge state of every node whose evidence was invalidated."""
    from apps.knowledge.models import KnowledgeNode

    targets: set[tuple[str, str, str]] = set()
    for _evidence_id, user_id, project_id, node_id, _dimension in rows:
        if node_id is None:
            continue
        targets.add((str(user_id), str(project_id), str(node_id)))
    if not targets:
        return 0
    nodes = {
        str(node.id): node
        for node in KnowledgeNode.objects.filter(id__in=sorted({node_id for _u, _p, node_id in targets})).select_related(
            "syllabus_version"
        )
    }
    users = {str(user.id): user for user in get_user_model().objects.filter(id__in=sorted({u for u, _p, _n in targets}))}
    projects = {
        str(project.id): project
        for project in ExamProject.objects.filter(id__in=sorted({p for _u, p, _n in targets}))
    }
    refreshed = 0
    for user_id, project_id, node_id in sorted(targets):
        node = nodes.get(node_id)
        user = users.get(user_id)
        project = projects.get(project_id)
        if node is None or user is None or project is None:
            continue
        state_service.refresh_node_state(
            user=user, project=project, syllabus_version=node.syllabus_version, node=node
        )
        refreshed += 1
    return refreshed


__all__ = [
    "DISTINCTNESS_DIMENSIONS",
    "MERGE_INVALIDATION_REASON",
    "add_question_to_family",
    "create_family",
    "family_payload",
    "merge_families",
    "merge_impact",
    "remove_question_from_family",
    "update_family",
]
