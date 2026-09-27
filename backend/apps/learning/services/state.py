"""Knowledge state projection.

The summary is a rule function over qualified evidence, never an LLM output
(docs/03 §5.2). Data that is missing is reported as missing rather than as a
precise-looking percentage.
"""

from __future__ import annotations

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.common.enums import EvidenceDimension, KnowledgeStateSummary
from apps.learning.models import LearnerKnowledgeState
from apps.practice.models import LearningEvidence

RULE_VERSION = "p0-1"

#: Strict verification thresholds (configurable product assumptions).
REQUIRED_DISTINCT_QUESTIONS = 3
REQUIRED_DISTINCT_TEMPLATES = 2
REQUIRED_DELAYED_CORRECT = 1
RECENT_WINDOW = 3
RECENT_FAILURES_FOR_REVIEW = 2


def _summary_from_counts(
    *,
    independent_correct: int,
    distinct_questions: int,
    distinct_templates: int,
    has_delayed_correct: bool,
    assisted_only: bool,
    confirmed_gap: bool,
    needs_review: bool,
) -> str:
    if needs_review and independent_correct > 0:
        return KnowledgeStateSummary.NEEDS_REVIEW
    if (
        independent_correct >= REQUIRED_DISTINCT_QUESTIONS
        and distinct_templates >= REQUIRED_DISTINCT_TEMPLATES
        and has_delayed_correct
    ):
        return KnowledgeStateSummary.DELAYED_VERIFIED
    if independent_correct >= 2 and distinct_templates >= 2:
        return KnowledgeStateSummary.HANDLES_UNSEEN
    if independent_correct >= 1:
        return KnowledgeStateSummary.INDEPENDENT
    if assisted_only:
        return KnowledgeStateSummary.COMPLETES_WITH_HINTS
    if confirmed_gap:
        return KnowledgeStateSummary.NEEDS_FOUNDATION
    return KnowledgeStateSummary.UNDIAGNOSED


@transaction.atomic
def refresh_node_state(*, user, project, syllabus_version, node) -> LearnerKnowledgeState:
    from apps.knowledge.models import KnowledgeNode

    if not isinstance(node, KnowledgeNode):
        node = KnowledgeNode.objects.get(id=node)
    rows = list(
        LearningEvidence.objects.filter(
            user=user,
            project=project,
            knowledge_node=node,
            is_active=True,
            grade_revision__gt=0,
        )
    )
    independent = [row for row in rows if row.dimension == EvidenceDimension.INDEPENDENT_CORRECT and row.qualifies]
    distinct_questions = {
        str(row.attempt.session_item.question_version.question_id): row for row in independent
    }
    templates = {
        str(row.detail.get("template_id"))
        for row in independent
        if row.detail.get("template_id")
    }
    delayed = [
        row for row in rows if row.dimension == EvidenceDimension.DELAYED_VERIFICATION and row.qualifies
    ]
    assisted_only = any(
        row.dimension == EvidenceDimension.UNASSISTED_COMPLETION and not row.qualifies and row.is_correct
        for row in rows
    ) and not independent
    confirmed_gap = any(
        row.is_correct is False
        and row.dimension
        in {
            EvidenceDimension.UNASSISTED_COMPLETION,
            EvidenceDimension.REPEAT_PRACTICE,
        }
        and row.grade_event_id is not None
        for row in rows
    )
    recent = sorted(
        [row for row in rows if row.dimension == EvidenceDimension.INDEPENDENT_CORRECT],
        key=lambda row: row.computed_at,
        reverse=True,
    )[:RECENT_WINDOW]
    recent_failures = sum(1 for row in recent if not row.is_correct)
    needs_review = len(recent) >= 2 and recent_failures >= RECENT_FAILURES_FOR_REVIEW

    summary = _summary_from_counts(
        independent_correct=len(independent),
        distinct_questions=len(distinct_questions),
        distinct_templates=len(templates),
        has_delayed_correct=bool(delayed),
        assisted_only=assisted_only,
        confirmed_gap=confirmed_gap,
        needs_review=needs_review,
    )
    state, _created = LearnerKnowledgeState.objects.get_or_create(
        user=user,
        project=project,
        syllabus_version=syllabus_version,
        node=node,
        defaults={"as_of": timezone.now()},
    )
    order = [
        KnowledgeStateSummary.UNDIAGNOSED,
        KnowledgeStateSummary.NEEDS_FOUNDATION,
        KnowledgeStateSummary.COMPLETES_WITH_HINTS,
        KnowledgeStateSummary.INDEPENDENT,
        KnowledgeStateSummary.HANDLES_UNSEEN,
        KnowledgeStateSummary.DELAYED_VERIFIED,
    ]
    if summary == KnowledgeStateSummary.NEEDS_REVIEW:
        effective_best = state.best_summary
    else:
        effective_best = max([state.best_summary, summary], key=lambda value: order.index(value))
    downgrade_reason = ""
    if needs_review and state.summary != KnowledgeStateSummary.NEEDS_REVIEW:
        downgrade_reason = f"最近 {RECENT_WINDOW} 次严格独立作答中有 {recent_failures} 次失败"
    state.summary = summary
    state.best_summary = effective_best
    state.independent_correct_count = len(independent)
    state.distinct_question_count = len(distinct_questions)
    state.distinct_template_count = len(templates)
    state.has_delayed_correct = bool(delayed)
    state.recent_independent_attempts = len(recent)
    state.recent_independent_failures = recent_failures
    state.needs_review = needs_review
    state.downgrade_reason = downgrade_reason
    state.rule_version = RULE_VERSION
    state.as_of = timezone.now()
    state.source_evidence_ids = [str(row.id) for row in independent + delayed][:200]
    state.detail = {
        "thresholds": {
            "distinct_questions": REQUIRED_DISTINCT_QUESTIONS,
            "distinct_templates": REQUIRED_DISTINCT_TEMPLATES,
            "delayed_correct": REQUIRED_DELAYED_CORRECT,
            "recent_window": RECENT_WINDOW,
        },
        "independent_attempts": [
            {
                "evidence_id": str(row.id),
                "attempt_id": str(row.attempt_id),
                "is_correct": row.is_correct,
                "computed_at": row.computed_at.isoformat(),
                "exclusions": row.exclusion_reasons,
            }
            for row in recent
        ],
        "missing_evidence": _missing_evidence(
            independent_correct=len(independent),
            distinct_templates=len(templates),
            has_delayed_correct=bool(delayed),
        ),
    }
    state.save()
    return state


def _missing_evidence(*, independent_correct: int, distinct_templates: int, has_delayed_correct: bool) -> list[str]:
    missing: list[str] = []
    if independent_correct < REQUIRED_DISTINCT_QUESTIONS:
        missing.append(
            f"还需要 {REQUIRED_DISTINCT_QUESTIONS - independent_correct} 道不同题的严格独立正确"
        )
    if distinct_templates < REQUIRED_DISTINCT_TEMPLATES:
        missing.append(f"还需要覆盖 {REQUIRED_DISTINCT_TEMPLATES - distinct_templates} 种已确认模板")
    if not has_delayed_correct:
        missing.append("还缺一次在相关讲解/训练至少 24 小时后的独立正确")
    return missing


def refresh_states_for_attempt(attempt_id: str) -> int:
    """Refresh every knowledge node touched by one attempt."""
    from apps.practice.models import Attempt

    attempt = (
        Attempt.objects.select_related("session_item__question_version__question__subject").filter(id=attempt_id).first()
    )
    if attempt is None:
        return 0
    nodes = {
        row.knowledge_node
        for row in LearningEvidence.objects.filter(attempt=attempt, is_active=True).select_related(
            "knowledge_node__syllabus_version"
        )
        if row.knowledge_node is not None
    }
    count = 0
    for node in nodes:
        refresh_node_state(
            user=attempt.user,
            project=attempt.project,
            syllabus_version=node.syllabus_version,
            node=node,
        )
        count += 1
    return count


def refresh_session_states(session_id: str) -> int:
    """After a verification finishes, its evidence becomes eligible."""
    from apps.practice.models import Attempt

    attempts = Attempt.objects.filter(session_item__session_id=session_id).values_list("id", flat=True)
    total = 0
    from apps.learning.services import evidence as evidence_service

    for attempt_id in attempts:
        evidence_service.rebuild_for_attempt(str(attempt_id))
        total += refresh_states_for_attempt(str(attempt_id))
    return total


def states_for_project(*, user, project, subject=None) -> list[dict]:
    queryset = (
        LearnerKnowledgeState.objects.filter(user=user, project=project)
        .select_related("node", "syllabus_version", "syllabus_version__subject")
        .order_by("node__canonical_name")
    )
    if subject is not None:
        queryset = queryset.filter(syllabus_version__subject=subject)
    return [
        {
            "node_id": str(state.node_id),
            "node_name": state.node.canonical_name,
            "subject_id": str(state.syllabus_version.subject_id),
            "syllabus_version_id": str(state.syllabus_version_id),
            "syllabus_is_user_provisional": state.syllabus_version.is_user_provisional,
            "summary": state.summary,
            "best_summary": state.best_summary,
            "independent_correct_count": state.independent_correct_count,
            "distinct_question_count": state.distinct_question_count,
            "distinct_template_count": state.distinct_template_count,
            "has_delayed_correct": state.has_delayed_correct,
            "needs_review": state.needs_review,
            "downgrade_reason": state.downgrade_reason,
            "missing_evidence": (state.detail or {}).get("missing_evidence", []),
            "independent_attempts": (state.detail or {}).get("independent_attempts", []),
            "thresholds": (state.detail or {}).get("thresholds", {}),
            "rule_version": state.rule_version,
            "as_of": state.as_of.isoformat(),
        }
        for state in queryset
    ]


def weak_nodes(*, user, project, limit: int = 10):
    """Nodes whose current summary calls for repair work (used by the planner)."""
    queryset = (
        LearnerKnowledgeState.objects.filter(user=user, project=project)
        .filter(
            Q(needs_review=True)
            | Q(summary__in=[KnowledgeStateSummary.NEEDS_FOUNDATION, KnowledgeStateSummary.COMPLETES_WITH_HINTS])
        )
        .select_related("node")
        .order_by("-needs_review", "as_of")
    )
    return list(queryset[: max(1, min(limit, 50))])
