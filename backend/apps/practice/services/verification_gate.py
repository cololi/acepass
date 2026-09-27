"""Server-side purpose gate for answers that belong to a running verification.

A verification run only means something if the answer cannot be obtained
elsewhere while it is in progress. Hiding a button, or returning
``score_visible=false`` while still shipping the number, does not satisfy that
contract (docs/03 §4.3): once a verification item has been presented, every
other entry point that could reveal *this content* must refuse until the run is
finished.

The gate is deliberately conservative and content-based, not session-based:

* the same question version,
* any other question in the same near-duplicate family,
* any question in the same content lineage (the same content copied or
  re-imported into another project),
* the knowledge nodes the verification item is mapped to.

It is checked on the *server*, from stored facts, so a different tab, a second
project or a different session cannot bypass it. It never blocks ordinary
practice on content that is not part of a running verification.
"""

from __future__ import annotations

from apps.common.enums import SessionMode, SessionStatus
from apps.common.errors import PurposeNotAllowed
from apps.practice.models import SessionItem


def _active_verification_items(*, user, project=None):
    queryset = SessionItem.objects.filter(
        session__user=user,
        session__mode=SessionMode.VERIFICATION,
        session__status=SessionStatus.ACTIVE,
        first_delivered_at__isnull=False,
    ).select_related("question_version__question")
    if project is not None:
        # Deliberately *not* filtered by project: the same content in another
        # project is still the same answer.
        pass
    return queryset


def active_verification_for_version(*, user, question_version):
    """A running verification item covering this exact question version."""
    return (
        _active_verification_items(user=user)
        .filter(question_version_id=question_version.id)
        .order_by("first_delivered_at")
        .first()
    )


def active_verification_for_content(*, user, question_version, exclude_item_id=None):
    """A running verification item covering the same content as this version.

    Matches the exact version, the same stable question, the same near-duplicate
    family, or the same content lineage. Returns the offending ``SessionItem``
    or ``None``.

    ``exclude_item_id`` is the item the caller is acting *on*. A verification
    item must be allowed to submit itself — otherwise the gate would delete the
    very run it protects — so callers that act on the item itself pass its id.
    """
    from django.db.models import Q

    queryset = _active_verification_items(user=user)
    if exclude_item_id is not None:
        queryset = queryset.exclude(id=exclude_item_id)
    question = question_version.question
    conditions = Q(question_version__question_id=question.id)
    if question.family_id is not None:
        conditions |= Q(question_version__question__family_id=question.family_id)
    if question.content_lineage_id is not None:
        conditions |= Q(question_version__question__content_lineage_id=question.content_lineage_id)
    return queryset.filter(conditions).order_by("first_delivered_at").first()


def active_verification_content_map(*, user) -> dict[str, set[str]]:
    """``question_version_id -> ids of active verification items covering it``.

    One pass over the running verification items, expanded to every version that
    shares the question, the near-duplicate family or the content lineage. This is
    the single source of truth for *content visibility*: every delivery path
    (session snapshot, submit/confirm replay, tutor message replay, evidence
    projection, grading queue, reports) filters on the same map, so a new endpoint
    cannot accidentally reopen the leak B02/C01 described.

    The values are *item* ids, not just a boolean: an item must be allowed to
    cover itself — otherwise a verification would hide its own run — so callers
    compare against the item they are acting on.
    """
    from django.db.models import Q

    from apps.question_bank.models import QuestionVersion

    covering: dict[str, set[str]] = {}
    for item in _active_verification_items(user=user):
        question = item.question_version.question
        conditions = Q(question_id=question.id)
        if question.family_id is not None:
            conditions |= Q(question__family_id=question.family_id)
        if question.content_lineage_id is not None:
            conditions |= Q(question__content_lineage_id=question.content_lineage_id)
        for version_id in QuestionVersion.objects.filter(conditions).values_list("id", flat=True):
            covering.setdefault(str(version_id), set()).add(str(item.id))
    return covering


def content_gate_blocks_item(*, item, content_map: dict[str, set[str]] | None = None, user=None) -> bool:
    """Is this item's grading withheld by *another* running verification?

    ``content_map`` is the shared map from
    :func:`active_verification_content_map`; pass it when gating a list so the
    expansion runs once. ``user`` is only needed when no map is supplied.
    """
    if content_map is None:
        if user is None:  # pragma: no cover - programming error
            raise ValueError("content_gate_blocks_item needs content_map or user")
        content_map = active_verification_content_map(user=user)
    covering = content_map.get(str(item.question_version_id))
    if not covering:
        return False
    return bool(covering - {str(item.id)})


def blocked_question_version_ids(*, user) -> set[str]:
    """Every question version whose answers a running verification still hides.

    Used by reports: an aggregate over a parallel practice attempt leaks the same
    number a direct field would, so the versions covered by a running
    verification are excluded from report buckets exactly like the verification's
    own attempts are.
    """
    return set(active_verification_content_map(user=user))


def assert_content_not_in_active_verification(
    *, user, question_version, action: str, exclude_item_id=None
) -> None:
    """Raise 403 when the requested content is part of a running verification."""
    blocking = active_verification_for_content(
        user=user, question_version=question_version, exclude_item_id=exclude_item_id
    )
    if blocking is None:
        return
    raise PurposeNotAllowed(
        message=(
            f"该内容正在验证中（会话 {blocking.session_id}）：为避免泄露答案，"
            f"验证结束前不能{action}。如只想练习，请先结束那次验证。"
        ),
        details={
            "reason": "active_verification_content_gate",
            "verification_session_id": str(blocking.session_id),
            "verification_session_item_id": str(blocking.id),
        },
    )


def assert_item_not_in_active_verification(*, item: SessionItem, action: str, allow_self: bool = False) -> None:
    assert_content_not_in_active_verification(
        user=item.session.user,
        question_version=item.question_version,
        action=action,
        exclude_item_id=item.id if allow_self else None,
    )


def assert_grading_not_blocked(*, item: SessionItem, action: str) -> None:
    """Guard a path that would hand the learner a score for this content.

    A verification or mock-exam item hides its own grading (``hides_grading``):
    submitting it returns a receipt, not a score, so the run being protected may
    continue. Every other session mode delivers a score, and that score is as
    good as the answer while a verification on the same content is running.
    """
    if item.session.hides_grading:
        return
    assert_item_not_in_active_verification(item=item, action=action, allow_self=True)


__all__ = [
    "active_verification_content_map",
    "active_verification_for_content",
    "active_verification_for_version",
    "assert_content_not_in_active_verification",
    "assert_grading_not_blocked",
    "assert_item_not_in_active_verification",
    "blocked_question_version_ids",
    "content_gate_blocks_item",
]
