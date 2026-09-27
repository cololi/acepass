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


def active_verification_for_content(*, user, question_version):
    """A running verification item covering the same content as this version.

    Matches the exact version, the same stable question, the same near-duplicate
    family, or the same content lineage. Returns the offending ``SessionItem``
    or ``None``.
    """
    from django.db.models import Q

    question = question_version.question
    conditions = Q(question_version__question_id=question.id)
    if question.family_id is not None:
        conditions |= Q(question_version__question__family_id=question.family_id)
    if question.content_lineage_id is not None:
        conditions |= Q(question_version__question__content_lineage_id=question.content_lineage_id)
    return (
        _active_verification_items(user=user)
        .filter(conditions)
        .exclude(question_version_id=question_version.id)
        .order_by("first_delivered_at")
        .first()
    ) or active_verification_for_version(user=user, question_version=question_version)


def assert_content_not_in_active_verification(*, user, question_version, action: str) -> None:
    """Raise 403 when the requested content is part of a running verification."""
    blocking = active_verification_for_content(user=user, question_version=question_version)
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


def assert_item_not_in_active_verification(*, item: SessionItem, action: str) -> None:
    assert_content_not_in_active_verification(
        user=item.session.user, question_version=item.question_version, action=action
    )


__all__ = [
    "active_verification_for_content",
    "active_verification_for_version",
    "assert_content_not_in_active_verification",
    "assert_item_not_in_active_verification",
]
