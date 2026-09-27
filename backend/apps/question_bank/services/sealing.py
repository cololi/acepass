"""Sealing (封存/holdout): the **single** place the product decides "sealed".

docs/05 §3 C03: 封存家族不进练习/检索/生成提示/导出/原页预览/缓存。A question is
sealed when the **latest** :class:`~apps.question_bank.models.QuestionPoolPolicy`
revision of its project says ``is_holdout`` either for the question itself or for
its family. "Latest" is per target (``question`` or ``family``), never global: an
older ``is_holdout=True`` row that was superseded by a later ``is_holdout=False``
row unseals the content again, and a later policy revision that clears the
holdout is exactly how :func:`unseal` works.

Why one resolver
----------------

Before this module the rule lived in one caller
(``apps/search/services/index.py``), which meant the search index and the
practice path could disagree — a sealed family could be invisible in retrieval
while still being handed out by a session, a tutor prompt, a plan or a file
read. Every entry point therefore calls this module and nothing else re-implements
the comparison against ``QuestionPoolPolicy``:

======================  ==================================================
entry point              call
======================  ==================================================
练习/验证会话创建         ``apps.practice.services.sessions.create_session``
检索（索引与可见性门禁）  ``apps.search.services.index``
生成提示 / 缓存投递       ``apps.tutoring.services.core`` (prompt + delivery)
计划与计划载荷            ``apps.learning.services.planner``
原页/答案资源读取         ``apps.ingestion.services.access``
题库题目预览              ``apps.question_bank.api.get_question``
导出（未来）              ``sealed_exclusions``
======================  ==================================================

The writers (:func:`seal_question`, :func:`seal_family`, :func:`unseal`) are
append-only: each one writes a *new* ``QuestionPoolPolicy`` revision (an older row
is never mutated) and one ``ContentRevision`` audit row naming the actor and the
reason, so "when did this become sealed, by whom and why" stays answerable.

Nothing here caches: the decision is re-derived from the live policy rows on every
call, so a seal takes effect immediately on every path and an unseal restores the
content without a rebuild step.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.audit.models import ContentRevision
from apps.common.errors import InvalidInput, PurposeNotAllowed, ScopeViolation
from apps.question_bank.models import Question, QuestionFamily, QuestionPoolPolicy

#: Stable reason codes. They are part of the wire contract (error ``details``,
#: ``/sealed-content`` rows), so they are never reworded in place.
SEALED_QUESTION = "sealed_question_policy"
SEALED_FAMILY = "sealed_family_policy"
SEALED_REASON_CODES = frozenset({SEALED_QUESTION, SEALED_FAMILY})

#: Human-readable form of each reason code, used by every refusal message.
REASON_MESSAGES: dict[str, str] = {
    SEALED_QUESTION: "该题已被保留策略（holdout）封存：不参与练习、检索、AI 生成提示、导出与原页预览",
    SEALED_FAMILY: "该题所属家族已被保留策略（holdout）封存：不参与练习、检索、AI 生成提示、导出与原页预览",
}

#: The retrieval/index exclusion wording. Kept byte-identical to the P1 text so
#: existing index rows and their recorded ``exclusion_reason`` stay comparable.
SEARCH_EXCLUSION_REASON = "题目或题族已标记为保留（holdout），不参与检索"

#: ``ContentRevision.action`` values written by this module.
ACTION_SEAL = "seal"
ACTION_UNSEAL = "unseal"


def reason_message(code: str) -> str:
    """The sentence for one reason code (never empty for a known code)."""
    return REASON_MESSAGES.get(code, "该内容已被保留策略封存")


def _project_id(project) -> str:
    """Accept a project instance or an id, so callers cannot pass the wrong one."""
    return str(getattr(project, "id", project))


def _latest_policies(
    *,
    project,
    question_ids: Iterable[str] | None = None,
    family_ids: Iterable[str] | None = None,
) -> tuple[dict[str, dict], dict[str, dict]]:
    """``(question_id -> latest policy row, family_id -> latest policy row)``.

    One query, ordered by ``-revision`` (then newest, then id) over the whole
    project. The *first* row seen for a target is therefore its latest revision,
    which is the only revision that may decide anything (C03). Rows with a lower
    revision are history and are never consulted.
    """
    policies = QuestionPoolPolicy.objects.filter(project=_project_id(project))
    if question_ids is not None or family_ids is not None:
        target = Q()
        if question_ids is not None:
            ids = [str(value) for value in question_ids]
            target |= Q(question_id__in=ids)
        if family_ids is not None:
            ids = [str(value) for value in family_ids]
            target |= Q(family_id__in=ids)
        policies = policies.filter(target)
    rows = policies.order_by("-revision", "-created_at", "-id").values(
        "id", "question_id", "family_id", "is_holdout", "revision", "change_reason", "created_at"
    )
    question_latest: dict[str, dict] = {}
    family_latest: dict[str, dict] = {}
    for row in rows:
        question_id = str(row["question_id"]) if row["question_id"] else None
        family_id = str(row["family_id"]) if row["family_id"] else None
        if question_id is not None and question_id not in question_latest:
            question_latest[question_id] = row
        if family_id is not None and family_id not in family_latest:
            family_latest[family_id] = row
    return question_latest, family_latest


def _seal_codes(*, project, targets: list[tuple[str, str | None]]) -> dict[str, str]:
    """``question_id -> reason code`` for the given ``(question_id, family_id)`` targets.

    Taking the ids instead of model instances is deliberate: a caller may hold a
    ``Question`` loaded before its family changed, and a stale ``family_id`` would
    answer "not sealed" for content that is. :func:`is_sealed` re-reads the
    relation from the database for exactly that reason.
    """
    if not targets:
        return {}
    family_ids = {family_id for _question_id, family_id in targets if family_id}
    question_latest, family_latest = _latest_policies(
        project=project,
        question_ids=[question_id for question_id, _family_id in targets],
        family_ids=family_ids,
    )
    decisions: dict[str, str] = {}
    for question_id, family_id in targets:
        question_policy = question_latest.get(question_id)
        if question_policy and question_policy["is_holdout"]:
            decisions[question_id] = SEALED_QUESTION
            continue
        if family_id:
            family_policy = family_latest.get(family_id)
            if family_policy and family_policy["is_holdout"]:
                decisions[question_id] = SEALED_FAMILY
    return decisions


def _targets_from_queryset(queryset) -> list[tuple[str, str | None]]:
    return [
        (str(row["id"]), str(row["family_id"]) if row["family_id"] else None)
        for row in queryset.values("id", "family_id")
    ]


# --------------------------------------------------------------------------
# The resolver
# --------------------------------------------------------------------------
def sealed_question_ids(*, project, question_ids: Iterable[str] | None = None) -> set[str]:
    """Every sealed question of one project (or the sealed subset of ``ids``).

    ``question_ids=None`` means "the whole project". A question of another
    project is never sealed here: the policy rows are project-scoped, so asking
    about foreign content returns "not sealed" rather than borrowing another
    project's decision.
    """
    questions = Question.objects.filter(subject__project=_project_id(project))
    if question_ids is not None:
        ids = {str(value) for value in question_ids}
        if not ids:
            return set()
        questions = questions.filter(id__in=ids)
    # No policy row for this project at all: nothing can be sealed. Checked first
    # so the common case (and every existing project) costs one cheap query.
    if not QuestionPoolPolicy.objects.filter(project=_project_id(project)).exists():
        return set()
    return set(_seal_codes(project=project, targets=_targets_from_queryset(questions)))


def is_sealed(question, *, project=None) -> tuple[bool, str]:
    """``(sealed, reason code)`` for one question.

    ``project`` defaults to the question's own project, which is what a caller
    holding just a question needs; pass it explicitly when the decision is being
    made *from* another project's context.

    The question's *current* family is re-read here instead of trusting the
    instance: a caller may hold a ``Question`` that was loaded before the question
    joined a family (or before the family was merged), and answering "not sealed"
    from a stale relation is exactly the leak this resolver exists to prevent.
    """
    if question is None:
        return False, ""
    if project is None:
        project = question.subject.project_id
    state = Question.objects.filter(id=question.id).values("id", "family_id").first()
    if state is None:
        return False, ""
    targets = [(str(state["id"]), str(state["family_id"]) if state["family_id"] else None)]
    code = _seal_codes(project=project, targets=targets).get(str(state["id"]), "")
    return bool(code), code


def assert_not_sealed(*, question, project=None, action: str) -> None:
    """Refuse ``action`` on sealed content, naming the sealing policy.

    Every caller uses this instead of hand-rolling the message, so a refusal is
    always traceable to ``sealed_question_policy`` / ``sealed_family_policy``.
    """
    sealed, code = is_sealed(question, project=project)
    if not sealed:
        return
    raise PurposeNotAllowed(
        message=f"封存内容不可{action}：{reason_message(code)}",
        details={"reason": code, "question_id": str(question.id), "action": action},
    )


def sealed_family_ids(*, project, family_ids: Iterable[str] | None = None) -> set[str]:
    """Families whose **latest** family policy revision says holdout.

    Used by the family API to report ``sealed`` without asking about a member
    question (an empty family can be sealed too).
    """
    ids = None if family_ids is None else [str(value) for value in family_ids]
    if ids is not None and not ids:
        return set()
    _question_latest, family_latest = _latest_policies(project=project, family_ids=ids)
    return {family_id for family_id, row in family_latest.items() if row["is_holdout"]}


def families_for_questions(
    *, project=None, question_ids: Iterable[str] | None = None
) -> dict[str, QuestionFamily]:
    """``question_id -> family`` for questions that belong to a family.

    The merge logic needs to group questions by family without re-deriving the
    relation itself; questions without a family are simply absent from the map.
    """
    queryset = Question.objects.select_related("family")
    if project is not None:
        queryset = queryset.filter(subject__project=_project_id(project))
    if question_ids is not None:
        ids = {str(value) for value in question_ids}
        if not ids:
            return {}
        queryset = queryset.filter(id__in=ids)
    return {
        str(question.id): question.family
        for question in queryset
        if question.family_id is not None
    }


# --------------------------------------------------------------------------
# Writers — append-only policy revisions
# --------------------------------------------------------------------------
def _policy_queryset(*, project, family=None, question=None):
    queryset = QuestionPoolPolicy.objects.filter(project=_project_id(project))
    if family is not None:
        return queryset.filter(family=family)
    return queryset.filter(question=question)


@transaction.atomic
def _append_policy(
    *,
    project,
    actor,
    reason: str,
    is_holdout: bool,
    family: QuestionFamily | None = None,
    question: Question | None = None,
) -> QuestionPoolPolicy:
    if (family is None) == (question is None):
        raise InvalidInput(message="封存策略必须且只能指定一个目标（题目或家族）")
    if question is not None and str(question.subject.project_id) != _project_id(project):
        raise ScopeViolation(message="题目不属于该项目")
    if family is not None and str(family.subject.project_id) != _project_id(project):
        raise ScopeViolation(message="题族不属于该项目")
    latest = (
        _policy_queryset(project=project, family=family, question=question)
        .order_by("-revision", "-created_at")
        .first()
    )
    revision = (latest.revision + 1) if latest is not None else 1
    policy = QuestionPoolPolicy.objects.create(
        project_id=_project_id(project),
        family=family,
        question=question,
        revision=revision,
        is_holdout=bool(is_holdout),
        change_reason=(reason or "")[:500],
        changed_by=actor,
    )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_family" if family is not None else "question",
        entity_id=str(family.id if family is not None else question.id),
        action=ACTION_SEAL if is_holdout else ACTION_UNSEAL,
        project_id=_project_id(project),
        reason=(reason or "")[:500],
        detail={
            "target": "family" if family is not None else "question",
            "policy_id": str(policy.id),
            "revision": revision,
            "is_holdout": bool(is_holdout),
            "family_id": str(family.id) if family is not None else None,
            "question_id": str(question.id) if question is not None else None,
        },
    )
    return policy


def seal_question(*, project, question, actor, reason: str = "") -> QuestionPoolPolicy:
    """Append a policy revision that seals one question."""
    return _append_policy(
        project=project, actor=actor, reason=reason, is_holdout=True, question=question
    )


def seal_family(*, project, family, actor, reason: str = "") -> QuestionPoolPolicy:
    """Append a policy revision that seals one family (and therefore its members)."""
    return _append_policy(
        project=project, actor=actor, reason=reason, is_holdout=True, family=family
    )


def unseal(
    *,
    project,
    actor,
    reason: str = "",
    family: QuestionFamily | None = None,
    question: Question | None = None,
) -> QuestionPoolPolicy:
    """Append a policy revision that clears the holdout for one target.

    Clearing is a *new* revision (never an edit of the older row), so the history
    of "this was sealed between revision n and n+1" stays intact.
    """
    return _append_policy(
        project=project,
        actor=actor,
        reason=reason,
        is_holdout=False,
        family=family,
        question=question,
    )


# --------------------------------------------------------------------------
# Export surface
# --------------------------------------------------------------------------
def sealed_exclusions(*, project, subject=None) -> dict[str, Any]:
    """Everything an exporter must drop, in one call.

    There is no export endpoint yet. When one is added it must call this function
    and filter both ``question_ids`` and ``question_version_ids`` out of its
    payload — a whole-family export that walks ``Question``/``QuestionVersion``
    directly would otherwise publish sealed content. ``reasons`` maps each
    question to the policy code that sealed it so the export can state *why* a
    row was omitted instead of silently shrinking.
    """
    questions = Question.objects.filter(subject__project=_project_id(project))
    if subject is not None:
        questions = questions.filter(subject=subject)
    codes = _seal_codes(project=project, targets=_targets_from_queryset(questions))
    if not codes:
        return {
            "project_id": _project_id(project),
            "subject_id": str(getattr(subject, "id", subject)) if subject is not None else None,
            "question_ids": [],
            "question_version_ids": [],
            "family_ids": [],
            "reasons": {},
            "counts": {"questions": 0, "question_versions": 0, "families": 0},
        }
    from apps.question_bank.models import QuestionVersion

    version_ids = [
        str(value)
        for value in QuestionVersion.objects.filter(question_id__in=sorted(codes)).values_list("id", flat=True)
    ]
    family_ids = sorted(
        {
            str(value)
            for value in Question.objects.filter(id__in=sorted(codes))
            .exclude(family__isnull=True)
            .values_list("family_id", flat=True)
        }
    )
    return {
        "project_id": _project_id(project),
        "subject_id": str(getattr(subject, "id", subject)) if subject is not None else None,
        "question_ids": sorted(codes),
        "question_version_ids": sorted(version_ids),
        "family_ids": family_ids,
        "reasons": dict(sorted(codes.items())),
        "counts": {
            "questions": len(codes),
            "question_versions": len(version_ids),
            "families": len(family_ids),
        },
    }


def sealed_content_report(*, project) -> dict[str, Any]:
    """The ``GET /sealed-content`` payload: what is sealed and why.

    Only the latest policy per target is reported, because only the latest policy
    decides anything: an older ``is_holdout=True`` row that a later revision
    cleared is history, and reporting it would claim content is sealed when the
    resolver says otherwise.
    """
    exclusions = sealed_exclusions(project=project)
    question_latest, family_latest = _latest_policies(project=project)
    sealed_families = sorted(
        {family_id for family_id, row in family_latest.items() if row["is_holdout"]}
    )
    questions = {
        str(question.id): question
        for question in Question.objects.filter(id__in=exclusions["question_ids"]).select_related("family")
    }
    rows = []
    for question_id in exclusions["question_ids"]:
        question = questions.get(question_id)
        if question is None:
            continue
        code = exclusions["reasons"][question_id]
        policy_target = "question" if code == SEALED_QUESTION else "family"
        policy = (
            question_latest.get(question_id)
            if policy_target == "question"
            else family_latest.get(str(question.family_id))
        )
        rows.append(
            {
                "question_id": question_id,
                "display_label": question.display_label,
                "subject_id": str(question.subject_id),
                "family_id": str(question.family_id) if question.family_id else None,
                "family_name": question.family.name if question.family_id else "",
                "reason_code": code,
                "reason_message": reason_message(code),
                "policy_id": str(policy["id"]) if policy else None,
                "policy_revision": policy["revision"] if policy else None,
                "policy_target": policy_target if policy else None,
                "change_reason": policy["change_reason"] if policy else "",
                "changed_at": policy["created_at"].isoformat() if policy and policy["created_at"] else None,
            }
        )
    family_rows = []
    for family_id in sealed_families:
        row = family_latest[family_id]
        family = QuestionFamily.objects.filter(id=family_id).select_related("subject").first()
        family_rows.append(
            {
                "family_id": family_id,
                "name": family.name if family else "",
                "subject_id": str(family.subject_id) if family else None,
                "reason_code": SEALED_FAMILY,
                "reason_message": reason_message(SEALED_FAMILY),
                "policy_id": str(row["id"]),
                "policy_revision": row["revision"],
                "change_reason": row["change_reason"],
                "changed_at": row["created_at"].isoformat() if row["created_at"] else None,
                "question_ids": [
                    question_id
                    for question_id, question in questions.items()
                    if question.family_id and str(question.family_id) == family_id
                ],
            }
        )
    return {
        "project_id": exclusions["project_id"],
        "questions": rows,
        "families": family_rows,
        "counts": exclusions["counts"],
        "reason_codes": sorted(SEALED_REASON_CODES),
        "generated_at": timezone.now().isoformat(),
    }


__all__ = [
    "ACTION_SEAL",
    "ACTION_UNSEAL",
    "REASON_MESSAGES",
    "SEALED_FAMILY",
    "SEALED_QUESTION",
    "SEALED_REASON_CODES",
    "SEARCH_EXCLUSION_REASON",
    "assert_not_sealed",
    "families_for_questions",
    "is_sealed",
    "reason_message",
    "seal_family",
    "seal_question",
    "sealed_content_report",
    "sealed_exclusions",
    "sealed_family_ids",
    "sealed_question_ids",
    "unseal",
]
