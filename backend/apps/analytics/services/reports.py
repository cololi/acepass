"""Practice reports and regrade execution.

Reports are projections with explicit exclusions: pending grades, self-assessed
scores, AI estimates and assisted attempts are shown in separate columns and are
never merged into one "official" number.
"""

from __future__ import annotations

import logging
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.analytics.models import RecomputeRun, RegradeRun, ReportSnapshot
from apps.audit.services.outbox import enqueue
from apps.common.enums import (
    EvidenceDimension,
    GradeMethod,
    GradeStatus,
    RegradeStatus,
    SessionMode,
    SessionStatus,
)
from apps.common.errors import InvalidInput
from apps.practice.models import Attempt, GradeEvent, LearningEvidence
from apps.practice.services import attempts as attempt_services

logger = logging.getLogger("apps.analytics.reports")


def _bucket() -> dict:
    return {
        "attempts": 0,
        "confirmed_score": Decimal("0"),
        "max_score": Decimal("0"),
        "pending_max_score": Decimal("0"),
    }


def _accumulate(bucket: dict, grade: GradeEvent | None, max_score: Decimal) -> None:
    bucket["attempts"] += 1
    bucket["max_score"] += max_score
    if grade is None:
        bucket["pending_max_score"] += max_score
        return
    if grade.confirmed_score is not None:
        bucket["confirmed_score"] += grade.confirmed_score
    bucket["pending_max_score"] += grade.pending_max_score


def _fraction(bucket: dict) -> str | None:
    if bucket["max_score"] <= 0 or bucket["attempts"] == 0:
        return None
    return str((bucket["confirmed_score"] / bucket["max_score"]).quantize(Decimal("0.0001")))


@transaction.atomic
def build_practice_report(*, user, project, subject=None, node=None, save_snapshot: bool = True) -> dict:
    """Practice evidence report: what is confirmed, what is not, and why.

    Attempts that belong to a run whose grading is still hidden (an active
    verification or mock exam) are excluded from every bucket. Their scores are
    not "pending": they are deliberately not disclosable yet, and an aggregate
    would leak them just as effectively as a direct field.

    B02 closed the same hole for *parallel* sessions: a practice attempt on the
    same content (or the same near-duplicate family / content lineage) would put
    the score of a question that is currently being verified into a bucket, which
    is again the answer by arithmetic. Those attempts are excluded by the same
    content gate the other entry points use, and the exclusion is reported.
    """
    from apps.practice.services import verification_gate

    blocked_versions = verification_gate.blocked_question_version_ids(user=user)
    attempts = (
        Attempt.objects.filter(project=project, user=user)
        .exclude(
            Q(session_item__session__status=SessionStatus.ACTIVE)
            & Q(session_item__session__mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM])
        )
        .select_related(
            "current_grade_event", "session_item__session", "session_item__question_version__question"
        )
        .order_by("-submitted_at")
    )
    content_hidden_count = 0
    if blocked_versions:
        content_hidden_count = (
            Attempt.objects.filter(
                project=project, user=user, session_item__question_version_id__in=blocked_versions
            )
            .exclude(
                Q(session_item__session__status=SessionStatus.ACTIVE)
                & Q(session_item__session__mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM])
            )
            .count()
        )
        attempts = attempts.exclude(session_item__question_version_id__in=blocked_versions)
    if subject is not None:
        attempts = attempts.filter(session_item__question_version__question__subject=subject)
    attempts = list(attempts[:1000])

    hidden_count = hidden_verification_attempt_count(user=user, project=project)
    fully_graded = _bucket()
    pending_review = _bucket()
    self_assessed = _bucket()
    assisted = _bucket()
    repeat_practice = _bucket()
    partially_graded = _bucket()
    ai_estimated = _bucket()
    first_contact = _bucket()
    by_type: dict[str, dict] = {}
    by_node: dict[str, dict] = {}
    notes: list[str] = []

    assisted_attempt_ids = set(
        LearningEvidence.objects.filter(
            user=user, project=project, dimension=EvidenceDimension.UNASSISTED_COMPLETION, qualifies=False
        ).values_list("attempt_id", flat=True)
    )
    independent_attempt_ids = set(
        LearningEvidence.objects.filter(
            user=user, project=project, dimension=EvidenceDimension.INDEPENDENT_CORRECT, qualifies=True
        ).values_list("attempt_id", flat=True)
    )

    for attempt in attempts:
        item = attempt.session_item
        grade = attempt.current_grade_event
        question_type = item.question_version.question_type

        _accumulate(repeat_practice, grade, item.max_score)
        type_bucket = by_type.setdefault(question_type, _bucket())
        _accumulate(type_bucket, grade, item.max_score)

        if grade is None or grade.status == GradeStatus.PENDING_REVIEW:
            _accumulate(pending_review, grade, item.max_score)
        elif grade.method == GradeMethod.AI_ESTIMATED:
            _accumulate(ai_estimated, grade, item.max_score)
        elif grade.method == GradeMethod.SELF_CONFIRMED or grade.grader_is_self:
            _accumulate(self_assessed, grade, item.max_score)
        elif grade.is_fully_confirmed:
            # Every scoring part is decided. This includes 0-score mistakes and
            # partial credit on a rubric; "完全正确" is a separate fact.
            _accumulate(fully_graded, grade, item.max_score)
        else:
            _accumulate(partially_graded, grade, item.max_score)

        if attempt.id in assisted_attempt_ids:
            _accumulate(assisted, grade, item.max_score)
        if attempt.id in independent_attempt_ids:
            _accumulate(first_contact, grade, item.max_score)

        for mapping in item.question_version.knowledge_mappings.filter(mapping_revision=item.mapping_revision):
            node_key = str(mapping.node_id)
            node_bucket = by_node.setdefault(
                node_key, {**_bucket(), "node_name": mapping.node.canonical_name, "weight": str(mapping.score_weight)}
            )
            weight = Decimal(str(mapping.score_weight))
            node_bucket["attempts"] += 1
            node_bucket["max_score"] += item.max_score * weight
            if grade is not None and grade.confirmed_score is not None:
                node_bucket["confirmed_score"] += grade.confirmed_score * weight
            if grade is None:
                node_bucket["pending_max_score"] += item.max_score * weight
            else:
                node_bucket["pending_max_score"] += grade.pending_max_score * weight
    if node is not None:
        by_node = {key: value for key, value in by_node.items() if key == str(node.id)}

    repeat_attempt_ids = set(
        LearningEvidence.objects.filter(
            user=user, project=project, dimension=EvidenceDimension.REPEAT_PRACTICE, qualifies=True
        ).values_list("attempt_id", flat=True)
    )
    if repeat_attempt_ids:
        notes.append(f"其中 {len(repeat_attempt_ids)} 次属于重复练习（同题多次作答单独统计）。")
    pending_attempts = pending_review["attempts"] + partially_graded["attempts"]
    if pending_attempts:
        notes.append(
            f"有 {pending_attempts} 次作答尚未完全确认（待人工评分或缺规则）：不计入完整正确率，也不当作错题或 0 分。"
        )
    if self_assessed["attempts"]:
        notes.append(f"有 {self_assessed['attempts']} 次为自评确认：单列展示，不作为独立能力证据。")
    if assisted["attempts"]:
        notes.append(f"有 {assisted['attempts']} 次为辅助作答：单独统计，不计入严格独立证据。")
    if ai_estimated["attempts"]:
        notes.append(f"有 {ai_estimated['attempts']} 次仅有 AI 估计分：不进入正式总分。")
    if hidden_count:
        notes.append(
            f"有 {hidden_count} 次作答属于尚未结束的验证/考试：在结束前不计入任何统计，也不会通过报告泄露分数。"
        )
    if content_hidden_count:
        notes.append(
            f"另有 {content_hidden_count} 次作答与正在进行的验证内容相同（同题、同题族或同源内容）："
            "在验证结束前同样不计入任何统计，避免用平行练习的分数反推答案。"
        )
    if not attempts:
        notes.append("本项目还没有作答记录：报告不显示任何推算数据。")

    # Evidence rows from a hidden run are excluded for the same reason.
    excluded = [
        {
            "attempt_id": str(row.attempt_id),
            "dimension": row.dimension,
            "reasons": row.exclusion_reasons,
            "node_id": str(row.knowledge_node_id) if row.knowledge_node_id else None,
        }
        for row in LearningEvidence.objects.filter(user=user, project=project, is_active=True, qualifies=False)
        .exclude(
            Q(attempt__session_item__session__status=SessionStatus.ACTIVE)
            & Q(attempt__session_item__session__mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM])
        )
        .select_related("knowledge_node")[:200]
    ]

    payload = {
        "report_kind": "practice",
        "calculation_version": "p0-2",
        "as_of": timezone.now().isoformat(),
        "project_id": str(project.id),
        "subject_id": str(subject.id) if subject is not None else None,
        "totals": {
            # Renamed from `fully_confirmed`: this bucket means "every scoring
            # part decided", which includes wrong answers and partial credit.
            "fully_graded": _bucket_out(fully_graded),
            "partially_graded": _bucket_out(partially_graded),
            # Kept as an alias so older clients and snapshots keep resolving;
            # both point at the same completeness-based bucket.
            "fully_confirmed": _bucket_out(fully_graded),
            "partially_pending": _bucket_out(partially_graded),
            "pending_review": _bucket_out(pending_review),
            "self_assessed": _bucket_out(self_assessed),
            "assisted": _bucket_out(assisted),
            "repeat_practice": _bucket_out(repeat_practice),
            "strict_independent": _bucket_out(first_contact),
            "ai_estimated": _bucket_out(ai_estimated),
        },
        "hidden_verification_attempts": hidden_count,
        "hidden_verification_content_attempts": content_hidden_count,
        "by_question_type": {key: _bucket_out(value) for key, value in by_type.items()},
        "by_knowledge_node": {
            key: {**_bucket_out(value), "node_name": value["node_name"], "weight": value["weight"]}
            for key, value in by_node.items()
        },
        "excluded_evidence": excluded,
        "notes": notes,
    }
    if save_snapshot:
        ReportSnapshot.objects.create(
            user=user,
            project=project,
            subject=subject,
            report_kind="practice",
            calculation_version="p0-2",
            input_watermark={
                "attempt_count": len(attempts),
                "hidden_verification_attempts": hidden_count,
                "latest_attempt_at": attempts[0].submitted_at.isoformat() if attempts else None,
                "evidence_count": LearningEvidence.objects.filter(user=user, project=project, is_active=True).count(),
            },
            filters={"subject_id": str(subject.id) if subject else None, "node_id": str(node.id) if node else None},
            as_of=timezone.now(),
            payload=payload,
            notes=notes,
        )
    return payload


def hidden_verification_attempt_count(*, user, project) -> int:
    """Attempts excluded from reports because their grading is still hidden."""
    return (
        Attempt.objects.filter(project=project, user=user, session_item__session__status=SessionStatus.ACTIVE)
        .filter(session_item__session__mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM])
        .count()
    )


def _bucket_out(bucket: dict) -> dict:
    return {
        "attempts": bucket["attempts"],
        "confirmed_score": str(bucket["confirmed_score"]),
        "max_score": str(bucket["max_score"]),
        "pending_max_score": str(bucket["pending_max_score"]),
        "confirmed_fraction": _fraction(bucket),
    }


def mark_project_stale_for_paper(paper_id: str) -> int:
    from apps.exams.models import Paper

    paper = Paper.objects.filter(id=paper_id).select_related("subject").first()
    if paper is None:
        return 0
    return ReportSnapshot.objects.filter(project=paper.subject.project).update(is_stale=True)


def paper_coverage(*, subject) -> list[dict]:
    """Per-cycle coverage, honestly reporting unknown or incomplete cycles."""
    from apps.exams.models import Paper

    rows = []
    for paper in Paper.objects.filter(subject=subject).prefetch_related("revisions").order_by("cycle_key"):
        revision = paper.effective_revision
        items = revision.items.filter(is_scored=True) if revision is not None else []
        rows.append(
            {
                "paper_id": str(paper.id),
                "cycle_key": paper.cycle_key,
                "session_key": paper.session_key,
                "paper_code": paper.paper_code,
                "source_kind": paper.source_kind,
                "is_demo": paper.is_demo,
                "effective_revision_id": str(revision.id) if revision is not None else None,
                "coverage_status": revision.coverage_status if revision is not None else "coverage_unknown",
                "scored_item_count": len(items) if revision is not None else 0,
                "total_score": str(sum((item.max_score for item in items), Decimal("0"))) if revision else "0",
            }
        )
    return rows


# --------------------------------------------------------------------------
# Regrade execution
# --------------------------------------------------------------------------
def execute_regrade_run(regrade_run_id: str) -> str:
    """Execute one queued regrade; all-or-nothing, and trust is re-checked.

    Two properties B01/B03 require:

    * **One transaction.** The previous version wrote ``running`` before doing
      the work and wrote the counters afterwards, so a crash (or an exception
      between the two writes) left a ``running`` row with no result — a
      half-finished run. Everything now happens inside one atomic block: the run
      either reaches a terminal state with consistent counters, or it rolls back
      to ``queued`` and stays recoverable.
    * **Trust re-checked at execution time.** A run is queued against a reviewed
      revision; that revision can be disputed before a worker picks the run up.
      The target is re-read under lock, and when it is disputed or no longer
      ``checked`` the run is refused: no confirmed score is written, and the
      attempts it covers are moved to human review instead of keeping a settled
      number for content under dispute.

    The run row is locked for the whole execution, so an inline "run now" and a
    worker redelivery cannot both apply the same run.
    """
    with transaction.atomic():
        # Lock first, then load the relations: PostgreSQL refuses ``FOR UPDATE``
        # on the nullable side of an outer join, and ``target_rubric_version`` is
        # nullable.
        run_row = RegradeRun.objects.select_for_update().filter(id=regrade_run_id).first()
        if run_row is None:
            return "missing"
        run = (
            RegradeRun.objects.select_related("question", "target_answer_key_version", "target_rubric_version")
            .filter(id=run_row.id)
            .first()
        )
        if run is None:  # pragma: no cover - the row existed a moment ago
            return "missing"
        if run.status == RegradeStatus.SUCCEEDED:
            return "already_done"
        attempts = list(
            Attempt.objects.filter(session_item__question_version__question=run.question, project=run.project)
            .select_related("session_item__question_version", "current_grade_event")
            .order_by("submitted_at")
        )

        def refuse_untrusted(reason: str, exc_details: dict | None = None) -> str:
            """Terminal refusal: no confirmed score, attempts go to human review."""
            refused = attempt_services.invalidate_for_untrusted_regrade_target(
                attempts=attempts, actor=run.requested_by, reason=reason
            )
            run.regraded_attempts = 0
            run.stale_skipped_attempts = 0
            run.invalidated_evidence = refused
            run.status = RegradeStatus.FAILED
            run.error_message = f"重判被拒绝：{reason}"[:500]
            run.started_at = run.started_at or timezone.now()
            run.finished_at = timezone.now()
            run.save(
                update_fields=[
                    "regraded_attempts",
                    "stale_skipped_attempts",
                    "invalidated_evidence",
                    "status",
                    "error_message",
                    "started_at",
                    "finished_at",
                    "updated_at",
                ]
            )
            _rebuild_after_regrade(attempts)
            logger.warning(
                "regrade run refused run=%s details=%s", run.id, exc_details or {"reason": "target_untrusted"}
            )
            return f"refused_target_untrusted={refused}"

        try:
            target_answer_key_version, target_rubric_version = attempt_services.recheck_regrade_target(
                run.target_answer_key_version, run.target_rubric_version
            )
        except attempt_services.RegradeTargetUntrusted as exc:
            return refuse_untrusted(str(getattr(exc, "message", exc)), getattr(exc, "details", None))

        run.status = RegradeStatus.RUNNING
        run.started_at = timezone.now()
        run.save(update_fields=["status", "started_at", "updated_at"])
        regraded = 0
        stale = 0
        invalidated = 0
        errors: list[str] = []
        try:
            # A savepoint around the loop: if the target is disputed mid-run the
            # partial writes are discarded, and the refusal path below records
            # one complete terminal state instead of a half-applied run.
            with transaction.atomic():
                for attempt in attempts:
                    if str(attempt.session_item.question_version_id) != str(
                        target_answer_key_version.question_version_id
                    ):
                        # A different content version: the old answer cannot
                        # mechanically re-grade it, so the evidence is invalidated.
                        invalidated += LearningEvidence.objects.filter(attempt=attempt, is_active=True).update(
                            is_active=False,
                            invalidated_at=timezone.now(),
                            invalidated_reason="题干版本不同，无法用新答案重判；证据失效",
                        )
                        continue
                    grade = attempt_services.regrade_attempt(
                        attempt=attempt,
                        target_answer_key_version=target_answer_key_version,
                        target_rubric_version=target_rubric_version,
                        actor=run.requested_by,
                        reason=run.reason,
                        regrade_generation=run.generation,
                    )
                    if grade is None:
                        stale += 1
                    else:
                        regraded += 1
        except attempt_services.RegradeTargetUntrusted as exc:
            # The target was disputed between the pre-check and this attempt.
            return refuse_untrusted(str(getattr(exc, "message", exc)), getattr(exc, "details", None))
        except InvalidInput as exc:
            errors.append(f"{getattr(exc, 'message', exc)}")
        run.regraded_attempts = regraded
        run.stale_skipped_attempts = stale
        run.invalidated_evidence = invalidated
        run.status = RegradeStatus.SUCCEEDED if not errors else RegradeStatus.FAILED
        run.error_message = "; ".join(errors)[:500]
        run.finished_at = timezone.now()
        run.save(
            update_fields=[
                "regraded_attempts",
                "stale_skipped_attempts",
                "invalidated_evidence",
                "status",
                "error_message",
                "finished_at",
                "updated_at",
            ]
        )
        _rebuild_after_regrade(attempts)
        enqueue(
            "projection.refresh_paper_stats",
            {"paper_id": str(run.subject_id)},
            dedupe_key=f"regrade-report-refresh:{run.id}",
        )
        return f"regraded={regraded} stale={stale} invalidated={invalidated}"


def _rebuild_after_regrade(attempts) -> None:
    """Rebuild projections once, so counts are not double-applied per attempt."""
    from apps.learning.services import state as state_service

    for attempt in attempts:
        state_service.refresh_states_for_attempt(str(attempt.id))


def request_regrade(
    *,
    question,
    target_answer_key_version,
    target_rubric_version=None,
    actor,
    reason: str,
    scope: str = "all_attempts",
) -> RegradeRun:
    if target_answer_key_version.verification_status != "checked" or target_answer_key_version.is_disputed:
        raise InvalidInput(message="重判目标必须是已核对且无争议的答案版本")
    if target_rubric_version is not None and target_rubric_version.is_disputed:
        raise InvalidInput(message="重判目标 rubric 处于争议状态")
    return attempt_services.start_regrade_run(
        question=question,
        target_answer_key_version=target_answer_key_version,
        target_rubric_version=target_rubric_version,
        actor=actor,
        reason=reason,
        scope=scope,
    )


def regrade_payload(run: RegradeRun) -> dict:
    return {
        "regrade_run_id": str(run.id),
        "status": run.status,
        "question_id": str(run.question_id),
        "target_answer_key_version_id": str(run.target_answer_key_version_id),
        "target_rubric_version_id": str(run.target_rubric_version_id) if run.target_rubric_version_id else None,
        "scope": run.scope,
        "generation": run.generation,
        "reason": run.reason,
        "affected_attempts": run.affected_attempts,
        "regraded_attempts": run.regraded_attempts,
        "stale_skipped_attempts": run.stale_skipped_attempts,
        "invalidated_evidence": run.invalidated_evidence,
        "error_message": run.error_message,
        "created_at": run.created_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


def record_recompute_run(*, user, project, reason: str, scope: dict, affected_evidence: int) -> RecomputeRun:
    return RecomputeRun.objects.create(
        user=user,
        project=project,
        reason=reason[:200],
        scope=scope,
        status="succeeded",
        started_at=timezone.now(),
        finished_at=timezone.now(),
        affected_evidence=affected_evidence,
    )
