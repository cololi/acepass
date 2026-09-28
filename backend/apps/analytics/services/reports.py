"""Practice reports and regrade execution.

Reports are projections with explicit exclusions: pending grades, self-assessed
scores, AI estimates and assisted attempts are shown in separate columns and are
never merged into one "official" number.

C06 adds the missing half of that promise: a report must not only *separate* the
unfinished work, it must refuse to present the aggregate as a final result while
unfinished work is in scope. :func:`build_practice_report` therefore carries

* ``incomplete_scope`` — which attempts are still unresolved and exactly why
  (unscored, waiting for a human, partially confirmed rubric, disputed answer,
  invalidated grade, AI-only estimate), with the affected ids;
* ``aggregate`` — the honest lower bound plus the unresolved marks, always
  labelled, and ``score_rate`` only when nothing is unresolved;
* ``final_result`` — ``None`` whenever ``incomplete_scope`` is non-empty. No
  ranking, pass rate or single "final" score rate is emitted while scope is
  incomplete: the rule is "no fake final numbers", not "no numbers at all".
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
    GradeEventKind,
    GradeMethod,
    GradeStatus,
    RegradeStatus,
    SessionMode,
    SessionStatus,
    VerificationStatus,
)
from apps.common.errors import InvalidInput
from apps.practice.models import Attempt, GradeEvent, LearningEvidence
from apps.practice.services import attempts as attempt_services

logger = logging.getLogger("apps.analytics.reports")

#: How many ids the incomplete-scope block lists per category. Counts are always
#: exact; only the id lists are truncated, and ``ids_truncated`` says so.
MAX_SCOPE_IDS = 200

#: Every fact that makes a practice report partial, in presentation order. The
#: codes are additive facts about one attempt (an attempt that is both disputed
#: and waiting for a human carries both), so per-code counts may overlap and
#: ``incomplete_attempts`` is the distinct number.
INCOMPLETE_REASON_ORDER: tuple[str, ...] = (
    "unscored",
    "pending_review",
    "partially_confirmed",
    "disputed_content",
    "invalidated_grade",
    "void_grade",
    "ai_estimated",
)

#: Reason code -> the sentence a human reads. The wording states *what is
#: missing*, never "score = 0": an unresolved part is unknown, not lost.
INCOMPLETE_REASON_MESSAGES: dict[str, str] = {
    "unscored": "尚未评分：这次作答没有有效判分记录，任何总分都不是最终结果",
    "pending_review": "待人工评分：判分尚未确认，不能计入最终得分率或通过率",
    "partially_confirmed": "部分评分点已确认、仍有未评分项：已确认分只是下界，不是最终得分",
    "disputed_content": "答案或评分标准处于争议状态：争议解决前该题分数不作最终结果",
    "invalidated_grade": "原判分已失效（答案争议/内容变更）：等待重新评分，旧分数不作最终结果",
    "void_grade": "判分已作废（void）：无效分数不能作为最终结果",
    "ai_estimated": "仅有 AI 估计分：估计分永不进入正式总分",
}

#: The bucket fraction is only a *final* rate when every mark in the bucket is
#: confirmed; otherwise it is an explicitly labelled partial lower bound.
FRACTION_FINAL = "final"
FRACTION_PARTIAL = "partial_lower_bound"


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


def scoped_attempts(*, user, project, subject=None) -> tuple[list[Attempt], int, int]:
    """The attempts any report may aggregate, plus what was kept out of scope.

    One definition of the two gates, so a new report cannot forget one:

    * attempts whose run still hides its grading (an active verification or mock
      exam) are excluded — their scores are not "pending", they are deliberately
      not disclosable, and an aggregate would leak them by arithmetic;
    * attempts on content (same question, near-duplicate family or content
      lineage) that is part of a running verification are excluded by the same
      content gate the other entry points use.

    Returns ``(attempts, hidden_run_count, hidden_content_count)`` with the same
    ordering and 1000-row horizon the practice report always had.
    """
    from apps.practice.services import verification_gate

    hidden_runs = Q(session_item__session__status=SessionStatus.ACTIVE) & Q(
        session_item__session__mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM]
    )
    blocked_versions = verification_gate.blocked_question_version_ids(user=user)
    attempts = Attempt.objects.filter(project=project, user=user).exclude(hidden_runs)
    content_hidden_count = 0
    if blocked_versions:
        content_hidden_count = (
            Attempt.objects.filter(
                project=project, user=user, session_item__question_version_id__in=blocked_versions
            )
            .exclude(hidden_runs)
            .count()
        )
        attempts = attempts.exclude(session_item__question_version_id__in=blocked_versions)
    if subject is not None:
        attempts = attempts.filter(session_item__question_version__question__subject=subject)
    rows = list(
        attempts.select_related(
            "current_grade_event", "session_item__session", "session_item__question_version__question"
        ).order_by("-submitted_at")[:1000]
    )
    return rows, hidden_verification_attempt_count(user=user, project=project), content_hidden_count


def disputed_answer_key_ids(*, project) -> set[str]:
    """Answer versions under dispute: what C06 means by "争议题"."""
    from apps.question_bank.models import AnswerKeyVersion

    rows = AnswerKeyVersion.objects.filter(
        Q(is_disputed=True) | Q(verification_status=VerificationStatus.DISPUTED),
        question_version__question__subject__project=project,
    ).values_list("id", flat=True)
    return {str(row) for row in rows}


def disputed_rubric_ids(*, project) -> set[str]:
    """Rubrics under dispute. A disputed rubric keeps its attempts unresolved."""
    from apps.question_bank.models import RubricVersion

    rows = RubricVersion.objects.filter(
        is_disputed=True,
        answer_key_version__question_version__question__subject__project=project,
    ).values_list("id", flat=True)
    return {str(row) for row in rows}


def _partially_confirmed(grade: GradeEvent) -> bool:
    """Some scoring parts decided, some not — a result with a missing range.

    Checked from the frozen part list first (that is what the reviewer saw); the
    event-level fields are the fallback for events written before parts existed.
    """
    statuses = [part.get("status") for part in (grade.parts or []) if isinstance(part, dict)]
    if statuses:
        return GradeStatus.CONFIRMED in statuses and any(
            status != GradeStatus.CONFIRMED for status in statuses
        )
    return (
        grade.confirmed_score is not None
        and not grade.is_fully_confirmed
        and Decimal(grade.pending_max_score or 0) > 0
    )


def incomplete_reason_codes(
    *, attempt, grade, disputed_answers: set[str], disputed_rubrics: set[str]
) -> list[str]:
    """Why one attempt's result is not final, in :data:`INCOMPLETE_REASON_ORDER`.

    ``disputed_content`` is independent of the grade row: an answer can be
    disputed after this attempt was graded, and the old number must stop being
    presented as final from that moment on.
    """
    codes: set[str] = set()
    if grade is None:
        codes.add("unscored")
    else:
        if grade.kind == GradeEventKind.INVALIDATION:
            # The invalidation event is itself a pending row; its specific
            # reason (the old score was withdrawn) is the useful one.
            codes.add("invalidated_grade")
        elif grade.status == GradeStatus.PENDING_REVIEW:
            codes.add("pending_review")
        if grade.status == GradeStatus.VOID:
            codes.add("void_grade")
        if grade.method == GradeMethod.AI_ESTIMATED or grade.status == GradeStatus.ESTIMATED:
            codes.add("ai_estimated")
        if grade.status != GradeStatus.VOID and (
            _partially_confirmed(grade)
            or (grade.status == GradeStatus.CONFIRMED and not grade.is_fully_confirmed)
        ):
            codes.add("partially_confirmed")
    item = attempt.session_item
    answer_ids = {str(item.answer_key_version_id or ""), str(grade.answer_key_version_id or "") if grade else ""}
    rubric_ids = {str(item.rubric_version_id or ""), str(grade.rubric_version_id or "") if grade else ""}
    if (answer_ids & disputed_answers) or (rubric_ids & disputed_rubrics):
        codes.add("disputed_content")
    return [code for code in INCOMPLETE_REASON_ORDER if code in codes]


def _ids_of(attempts: list[Attempt], attribute: str) -> list[str]:
    values: list[str] = []
    for attempt in attempts:
        if attribute == "attempt":
            values.append(str(attempt.id))
        elif attribute == "item":
            values.append(str(attempt.session_item_id))
        else:
            values.append(str(attempt.session_item.question_version.question_id))
    return values


def incomplete_scope_payload(*, attempts: list[Attempt], codes_by_attempt: dict[str, list[str]]) -> dict:
    """The unresolved range of one report: counts, ids and human reasons."""
    unresolved = [attempt for attempt in attempts if codes_by_attempt.get(str(attempt.id))]
    reasons: list[dict] = []
    for code in INCOMPLETE_REASON_ORDER:
        rows = [attempt for attempt in unresolved if code in codes_by_attempt[str(attempt.id)]]
        if not rows:
            continue
        attempt_ids = _ids_of(rows, "attempt")
        reasons.append(
            {
                "code": code,
                "message": INCOMPLETE_REASON_MESSAGES[code],
                "attempt_count": len(rows),
                "attempt_ids": attempt_ids[:MAX_SCOPE_IDS],
                "session_item_ids": _ids_of(rows, "item")[:MAX_SCOPE_IDS],
                "question_ids": sorted(set(_ids_of(rows, "question")))[:MAX_SCOPE_IDS],
                "ids_truncated": len(rows) > MAX_SCOPE_IDS,
            }
        )
    attempt_ids = _ids_of(unresolved, "attempt")
    return {
        "is_incomplete": bool(unresolved),
        "attempts_in_scope": len(attempts),
        "incomplete_attempts": len(unresolved),
        "attempt_ids": attempt_ids[:MAX_SCOPE_IDS],
        "session_item_ids": _ids_of(unresolved, "item")[:MAX_SCOPE_IDS],
        "question_ids": sorted(set(_ids_of(unresolved, "question")))[:MAX_SCOPE_IDS],
        "ids_truncated": len(unresolved) > MAX_SCOPE_IDS,
        "reasons": reasons,
        "missing_note": "；".join(row["message"] for row in reasons) if reasons else None,
    }


def _report_aggregate(
    *, attempts: list[Attempt], codes_by_attempt: dict[str, list[str]], self_assessed_ids: set[str]
) -> tuple[dict, dict | None]:
    """Overall lower bound plus the final result, or ``None`` while partial.

    The numerator counts only *confirmed* marks that really exist: a decided
    rubric part contributes its confirmed subtotal even while the attempt is
    still pending overall (that is what makes the lower bound a bound rather than
    zero), and never an AI estimate, a voided grade or a disputed number —
    those carry no confirmed score at all.
    ``score_rate`` exists only when nothing is unresolved; while something is,
    the honest number is ``lower_bound`` with its unresolved marks spelled out.
    """
    max_total = sum((Decimal(attempt.session_item.max_score) for attempt in attempts), Decimal("0"))
    confirmed_total = Decimal("0")
    self_assessed_count = 0
    for attempt in attempts:
        grade = attempt.current_grade_event
        if (
            grade is not None
            and grade.status != GradeStatus.VOID
            and grade.confirmed_score is not None
        ):
            confirmed_total += Decimal(grade.confirmed_score)
        if str(attempt.id) in self_assessed_ids:
            self_assessed_count += 1
    unresolved_ids = {attempt_id for attempt_id, codes in codes_by_attempt.items() if codes}
    unresolved_total = max_total - confirmed_total
    rate = (
        str((confirmed_total / max_total).quantize(Decimal("0.0001"))) if max_total > 0 else None
    )
    if not attempts:
        status = "no_data"
    elif unresolved_ids:
        status = FRACTION_PARTIAL
    else:
        status = FRACTION_FINAL
    reason_codes = [code for code in INCOMPLETE_REASON_ORDER if any(code in codes for codes in codes_by_attempt.values())]
    aggregate = {
        "status": status,
        "attempts_in_scope": len(attempts),
        "confirmed_score": str(confirmed_total),
        "max_score": str(max_total),
        "unresolved_max_score": str(unresolved_total if status == FRACTION_PARTIAL else Decimal("0")),
        "unresolved_attempts": len(unresolved_ids),
        "score_rate": rate if status == FRACTION_FINAL else None,
        "lower_bound": rate if status in {FRACTION_FINAL, FRACTION_PARTIAL} else None,
        "includes_self_assessed_attempts": self_assessed_count,
        "label": {
            FRACTION_FINAL: "最终得分率：范围内每一次作答都已确认",
            FRACTION_PARTIAL: (
                "未完成：score_rate 已置空；lower_bound 只是已确认部分的下界，"
                f"仍有 {unresolved_total} 分未确认"
            ),
            "no_data": "没有可统计的作答：不显示任何推算数据",
        }[status],
        "missing": (
            {
                "unresolved_max_score": str(unresolved_total),
                "unresolved_attempts": len(unresolved_ids),
                "reason_codes": reason_codes,
                "note": "；".join(INCOMPLETE_REASON_MESSAGES[code] for code in reason_codes),
            }
            if status == FRACTION_PARTIAL
            else None
        ),
    }
    if status != FRACTION_FINAL:
        return aggregate, None
    final_result = {
        "score_rate": rate,
        "confirmed_score": str(confirmed_total),
        "max_score": str(max_total),
        "attempts": len(attempts),
        "includes_self_assessed_attempts": self_assessed_count,
        "basis": "范围内每一次作答都有已确认判分：无待评、无部分确认、无争议、无失效、无 AI 估计。",
    }
    return aggregate, final_result


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
    attempts, hidden_count, content_hidden_count = scoped_attempts(user=user, project=project, subject=subject)

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

    disputed_answers = disputed_answer_key_ids(project=project)
    disputed_rubrics = disputed_rubric_ids(project=project)
    self_assessed_attempt_ids: set[str] = set()
    codes_by_attempt: dict[str, list[str]] = {}

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
            self_assessed_attempt_ids.add(str(attempt.id))
        elif grade.is_fully_confirmed:
            # Every scoring part is decided. This includes 0-score mistakes and
            # partial credit on a rubric; "完全正确" is a separate fact.
            _accumulate(fully_graded, grade, item.max_score)
        else:
            _accumulate(partially_graded, grade, item.max_score)

        codes_by_attempt[str(attempt.id)] = incomplete_reason_codes(
            attempt=attempt,
            grade=grade,
            disputed_answers=disputed_answers,
            disputed_rubrics=disputed_rubrics,
        )

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

    incomplete_scope = incomplete_scope_payload(attempts=attempts, codes_by_attempt=codes_by_attempt)
    aggregate, final_result = _report_aggregate(
        attempts=attempts, codes_by_attempt=codes_by_attempt, self_assessed_ids=self_assessed_attempt_ids
    )
    if incomplete_scope["is_incomplete"]:
        reason_text = "；".join(row["message"] for row in incomplete_scope["reasons"])
        notes.append(
            f"报告未完成：{incomplete_scope['incomplete_attempts']} 次作答仍有未确认部分（{reason_text}）。"
            "此时不输出最终得分率/通过率/排名：final_result 为 null，"
            "aggregate.score_rate 也为 null，只保留标注为下界的 aggregate.lower_bound 与未确认分值。"
        )
    elif final_result is not None:
        notes.append(
            "范围内作答均已确认：final_result 可用（"
            f"{final_result['attempts']} 次作答，最终得分率 {final_result['score_rate']}）。"
        )

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
        "calculation_version": "p0-2-c06",
        "as_of": timezone.now().isoformat(),
        "project_id": str(project.id),
        "subject_id": str(subject.id) if subject is not None else None,
        "result_status": {
            "no_data": "no_data",
            FRACTION_FINAL: "final",
            FRACTION_PARTIAL: "incomplete",
        }[aggregate["status"]],
        "incomplete_scope": incomplete_scope,
        "aggregate": aggregate,
        "final_result": final_result,
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
            calculation_version="p0-2-c06",
            input_watermark={
                "attempt_count": len(attempts),
                "hidden_verification_attempts": hidden_count,
                "latest_attempt_at": attempts[0].submitted_at.isoformat() if attempts else None,
                "evidence_count": LearningEvidence.objects.filter(user=user, project=project, is_active=True).count(),
                "incomplete_attempts": incomplete_scope["incomplete_attempts"],
                "result_status": payload["result_status"],
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
    is_final = bucket["pending_max_score"] <= 0
    return {
        "attempts": bucket["attempts"],
        "confirmed_score": str(bucket["confirmed_score"]),
        "max_score": str(bucket["max_score"]),
        "pending_max_score": str(bucket["pending_max_score"]),
        "confirmed_fraction": _fraction(bucket),
        # C06: a bucket fraction is a *final* rate only when every mark in the
        # bucket is confirmed. Otherwise it is a partial lower bound and the
        # missing range is `pending_max_score`, so no client can present it as
        # the finished score rate by accident.
        "is_final": is_final,
        "fraction_status": FRACTION_FINAL if is_final else FRACTION_PARTIAL,
    }


def mark_project_stale_for_paper(paper_id: str) -> int:
    from apps.exams.models import Paper

    paper = Paper.objects.filter(id=paper_id).select_related("subject").first()
    if paper is None:
        return 0
    return ReportSnapshot.objects.filter(project=paper.subject.project).update(is_stale=True)


def paper_coverage(*, subject) -> list[dict]:
    """Per-cycle coverage, honestly reporting unknown or incomplete cycles.

    C06: the scored-item count is not a completion *rate*. A revision whose
    coverage was never confirmed complete (or that is unknown) may not emit one:
    ``coverage_rate`` stays ``None`` and ``coverage_rate_status`` says why, while
    the raw counts — including the items that carry no score at all — remain
    visible. "No fake final numbers" is not "no numbers".
    """
    from apps.exams.models import Paper

    rows = []
    for paper in Paper.objects.filter(subject=subject).prefetch_related("revisions").order_by("cycle_key"):
        revision = paper.effective_revision
        items = list(revision.items.filter(is_scored=True)) if revision is not None else []
        unscored_item_count = revision.items.filter(is_scored=False).count() if revision is not None else 0
        coverage_status = revision.coverage_status if revision is not None else "coverage_unknown"
        total_items = len(items) + unscored_item_count
        is_final = coverage_status == "coverage_complete"
        rows.append(
            {
                "paper_id": str(paper.id),
                "cycle_key": paper.cycle_key,
                "session_key": paper.session_key,
                "paper_code": paper.paper_code,
                "source_kind": paper.source_kind,
                "is_demo": paper.is_demo,
                "effective_revision_id": str(revision.id) if revision is not None else None,
                "coverage_status": coverage_status,
                "scored_item_count": len(items),
                # Items registered on the paper that carry no score (shared
                # material parents): they are why a raw count is not a rate.
                "unscored_item_count": unscored_item_count,
                "total_item_count": total_items,
                "total_score": str(sum((item.max_score for item in items), Decimal("0"))) if revision else "0",
                "coverage_rate": (
                    str((Decimal(len(items)) / Decimal(total_items)).quantize(Decimal("0.0001")))
                    if is_final and total_items
                    else None
                ),
                "coverage_rate_status": FRACTION_FINAL if is_final else FRACTION_PARTIAL,
                "coverage_rate_note": (
                    "覆盖完整性已人工确认：覆盖率可作为最终值。"
                    if is_final
                    else f"覆盖状态为 {coverage_status}：不给出覆盖率（未确认完整前任何比率都可能是假的）。"
                ),
            }
        )
    return rows


def coverage_completion(*, subject, papers: list[dict] | None = None) -> dict:
    """Whether one subject's coverage may be read as a completed whole.

    The subject-level rate exists only when *every* registered paper has a
    human-confirmed complete revision. While one paper is unknown or incomplete
    the rate is withheld (``None``) and ``incomplete_scope`` names the papers and
    the reasons, exactly like the practice report does for attempts.
    """
    rows = paper_coverage(subject=subject) if papers is None else papers

    def _block_code(row: dict) -> str:
        if row["effective_revision_id"] is None:
            return "no_effective_revision"
        return row["coverage_status"]

    blocked = [row for row in rows if row["coverage_rate_status"] != FRACTION_FINAL]
    reasons: list[dict] = []
    for code, message in (
        ("coverage_unknown", "未登记预期场次/卷别：不能判断该周期是否完整"),
        ("coverage_incomplete", "覆盖未完整或未经人工确认：不能给出完成率"),
        ("no_effective_revision", "没有有效版本：该试卷没有任何可计分题项"),
    ):
        selected = [row for row in blocked if _block_code(row) == code]
        if not selected:
            continue
        reasons.append(
            {
                "code": code,
                "message": message,
                "paper_count": len(selected),
                "paper_ids": [row["paper_id"] for row in selected][:MAX_SCOPE_IDS],
                "cycle_keys": sorted({row["cycle_key"] for row in selected}),
            }
        )
    scored_total = sum((row["scored_item_count"] for row in rows), 0)
    unscored_total = sum((row["unscored_item_count"] for row in rows), 0)
    is_final = bool(rows) and not blocked
    rate = (
        str((Decimal(len(rows) - len(blocked)) / Decimal(len(rows))).quantize(Decimal("0.0001")))
        if rows
        else None
    )
    return {
        "status": "no_data" if not rows else (FRACTION_FINAL if is_final else FRACTION_PARTIAL),
        "papers_total": len(rows),
        "papers_coverage_complete": len(rows) - len(blocked),
        "coverage_rate": rate if is_final else None,
        "lower_bound": rate,
        "items": {"scored_total": scored_total, "unscored_total": unscored_total},
        "incomplete_scope": {
            "is_incomplete": bool(blocked),
            "papers_total": len(rows),
            "blocked_paper_count": len(blocked),
            "blocked_paper_ids": [row["paper_id"] for row in blocked][:MAX_SCOPE_IDS],
            "reasons": reasons,
            "missing_note": "；".join(row["message"] for row in reasons) if reasons else None,
        },
        "final_result": (
            {
                "coverage_rate": rate,
                "papers_total": len(rows),
                "basis": "全部已登记试卷都有已人工确认覆盖完整的有效版本。",
            }
            if is_final
            else None
        ),
        "note": (
            "全部试卷覆盖完整：覆盖率可作为最终值。"
            if is_final
            else "覆盖不完整：不输出完成率，只列出未完整试卷与原因（final_result 为 null）。"
        ),
    }


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
            """Terminal refusal: no confirmed score, attempts go to human review.

            Only the attempts whose effective grade is *not* newer than this run
            are moved to review (C02). The normal regrade branch already refuses to
            overwrite a newer generation; the refusal branch must obey the same
            ordering, otherwise an older disputed run deletes a valid newer grade
            on its way out.
            """
            refused, skipped_newer = attempt_services.invalidate_for_untrusted_regrade_target(
                attempts=attempts,
                actor=run.requested_by,
                reason=reason,
                refused_generation=run.generation,
            )
            run.regraded_attempts = 0
            # Attempts a newer generation already re-graded: reported, not touched.
            run.stale_skipped_attempts = skipped_newer
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
                "regrade run refused run=%s generation=%s refused=%s newer_generation_kept=%s details=%s",
                run.id,
                run.generation,
                refused,
                skipped_newer,
                exc_details or {"reason": "target_untrusted"},
            )
            return f"refused_target_untrusted={refused} newer_generation_kept={skipped_newer}"

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
                        # mechanically re-grade it, so the evidence is invalidated —
                        # but only by the run that still owns this attempt. The
                        # attempt is locked, refreshed and checked against the run's
                        # generation *inside* the service (C02), so an old queued
                        # run can no longer delete evidence a newer generation just
                        # produced. Old runs are reported as skipped, never written.
                        rows, was_stale = attempt_services.invalidate_evidence_for_content_change(
                            attempt=attempt,
                            regrade_generation=run.generation,
                            reason="题干版本不同，无法用新答案重判；证据失效",
                        )
                        invalidated += rows
                        stale += 1 if was_stale else 0
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
