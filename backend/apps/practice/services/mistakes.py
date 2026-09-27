"""Confirmed lost marks — the reason a "错题本" can be trusted.

A mistake is a *result*, not a suspicion. A row only appears here when every
scoring part of the attempt has actually been decided and the confirmed score
fell short of the item's maximum. Attempts that are still partly unscored, are
self-assessed, are AI-estimated, or belong to a run whose grading is still
hidden are deliberately absent: showing them as "wrong" would invent a fact.
"""

from __future__ import annotations

from decimal import Decimal

from django.db.models import Q

from apps.common.enums import GradeMethod, GradeStatus, SessionMode, SessionStatus
from apps.practice.models import Attempt


def _is_confirmed_mistake(attempt: Attempt) -> bool:
    grade = attempt.current_grade_event
    if grade is None:
        return False
    if grade.status != GradeStatus.CONFIRMED or not grade.is_fully_confirmed:
        return False
    if grade.method == GradeMethod.AI_ESTIMATED:
        return False
    if grade.confirmed_score is None:
        return False
    if grade.max_score is None or grade.max_score <= 0:
        return False
    return grade.confirmed_score < grade.max_score


def mistake_candidates(*, user, project, subject=None):
    """Attempts eligible to be reported as a confirmed mistake."""
    queryset = (
        Attempt.objects.filter(project=project, user=user)
        .filter(current_grade_event__status=GradeStatus.CONFIRMED, current_grade_event__is_fully_confirmed=True)
        .exclude(
            Q(session_item__session__status=SessionStatus.ACTIVE)
            & Q(session_item__session__mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM])
        )
        .select_related(
            "current_grade_event",
            "session_item__question_version__question",
            "session_item__session",
        )
        .order_by("-submitted_at")
    )
    if subject is not None:
        queryset = queryset.filter(session_item__question_version__question__subject=subject)
    return queryset


def mistake_rows(*, user, project, subject=None, limit: int = 100) -> list[dict]:
    rows: list[dict] = []
    for attempt in mistake_candidates(user=user, project=project, subject=subject)[: max(1, min(limit, 200))]:
        if not _is_confirmed_mistake(attempt):
            continue
        grade = attempt.current_grade_event
        item = attempt.session_item
        question_version = item.question_version
        lost = Decimal(str(grade.max_score)) - Decimal(str(grade.confirmed_score))
        weak_parts = [
            {
                "part_id": part.get("part_id"),
                "score": part.get("score"),
                "max_score": part.get("max_score"),
                "status": part.get("status"),
                "text": (part.get("detail") or {}).get("text", ""),
            }
            for part in (grade.parts or [])
            if isinstance(part, dict) and part.get("score") is not None
        ]
        rows.append(
            {
                "attempt_id": str(attempt.id),
                "session_item_id": str(item.id),
                "session_id": str(item.session_id),
                "question_id": str(question_version.question_id),
                "question_version_id": str(question_version.id),
                "display_label": question_version.question.display_label,
                "question_type": question_version.question_type,
                "subject_id": str(question_version.question.subject_id),
                "submitted_at": attempt.submitted_at.isoformat(),
                "grading_revision": attempt.grading_revision,
                "confirmed_score": str(grade.confirmed_score),
                "max_score": str(grade.max_score),
                "lost_score": str(lost),
                "method": grade.method,
                "grader_is_self": grade.grader_is_self,
                "parts": weak_parts,
                "raw_answer": attempt.raw_answer,
                "steps": attempt.steps,
                "attachments": attempt.attachments,
                "can_tutor": bool(item.tutoring_allowed and item.session.mode == SessionMode.PRACTICE),
            }
        )
    return rows


__all__ = ["mistake_candidates", "mistake_rows"]
