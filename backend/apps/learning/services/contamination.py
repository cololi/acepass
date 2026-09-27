"""Contamination: what makes a question impossible to call "strictly unseen".

docs/05 §3 C04: 校对过、外部标记见过、已展示未提交的题均不能重新标为严格未见 — a
proofread question, a question the learner declared they met outside the system,
and a question whose stem was presented but never submitted may never be
re-labelled "strictly unseen" (nor "陌生变式", which claims the same first
contact).

The rules live here and nowhere else. :func:`exposure_state` performs the single
evaluation and every entry point consumes it, so a new caller cannot skip a rule:

* ``external_seen`` — the learner declared the question as met outside the system
  (C04 source 2). Recorded by :func:`record_external_seen`.
* ``editorial_preview_seen`` — an editorial/proofreading preview exposed the
  question (and its answer) to this user (C04 source 1). Recorded by
  :func:`record_editorial_preview`.
* ``presented_without_submit`` — a session item on this question was delivered
  (``SessionItem.first_delivered_at`` set) and never submitted (C04 source 3).
* ``lineage_seen_in_other_project`` — the same *content* (``ContentLineage``) was
  already exposed in another of this owner's projects; exposure follows the
  lineage while learning state stays per project.
* ``stem_delivered`` / ``hint_delivered`` / ``explanation_delivered`` /
  ``answer_delivered`` / ``feedback_delivered`` — a delivery the server already
  logged for this user on this question.

Two kinds of reason are **absolute**: ``external_seen`` and
``editorial_preview_seen`` contaminate the question for good. A later correction
(``seen=false``) is appended to the ledger as a new row, but it never removes the
marker — there is no path from "has been exposed" back to "strictly unseen". The
delivery-caused reasons are judged *at an instant*: the evidence projection asks
the question as of the moment the item under judgement was presented, so a
genuinely fresh question — never presented, never proofread, never seen
elsewhere — still qualifies as first contact.

The module writes no evidence rows and keeps no cache: recomputing from the same
facts returns the same answer, and the ledger is append-only.
"""

from __future__ import annotations

from datetime import datetime
from typing import NamedTuple

from django.db.models import Q
from django.utils import timezone

from apps.common.enums import ExposureKind, ExposurePurpose
from apps.practice.models import ExposureEvent, SessionItem

#: Stable presentation order of the reason codes (also the recomputation order,
#: so the same facts always produce byte-identical ``exclusion_reasons``).
REASON_ORDER: tuple[str, ...] = (
    "external_seen",
    "editorial_preview_seen",
    "answer_delivered",
    "explanation_delivered",
    "hint_delivered",
    "feedback_delivered",
    "stem_delivered",
    "presented_without_submit",
    "lineage_seen_in_other_project",
)

#: Reasons that never expire: recorded once, they contaminate the question for
#: good (C04 "no path back to strictly unseen").
ABSOLUTE_REASON_CODES = frozenset({"external_seen", "editorial_preview_seen"})

#: Exposure kinds that map onto an absolute reason code.
_ABSOLUTE_KINDS = (ExposureKind.EXTERNAL_SEEN, ExposureKind.EDITORIAL_PREVIEW)

#: Exposure kind -> reason code. A kind that is not listed here is not a
#: contamination marker (the ledger may grow kinds the strict rules ignore).
_KIND_TO_REASON: dict[str, str] = {
    ExposureKind.STEM_DELIVERED: "stem_delivered",
    ExposureKind.HINT_DELIVERED: "hint_delivered",
    ExposureKind.EXPLANATION_DELIVERED: "explanation_delivered",
    ExposureKind.ANSWER_DELIVERED: "answer_delivered",
    ExposureKind.FEEDBACK_DELIVERED: "feedback_delivered",
    ExposureKind.EDITORIAL_PREVIEW: "editorial_preview_seen",
    ExposureKind.EXTERNAL_SEEN: "external_seen",
}

#: Reason code -> the sentence stored in ``LearningEvidence.exclusion_reasons``.
#: The stem sentence deliberately keeps the "重复练习" wording: repeats of one
#: question are ordinary practice and are counted as such, never as first contact.
REASON_MESSAGES: dict[str, str] = {
    "external_seen": "本人已声明在系统外见过本题（声明不可撤销，不能重新标为严格未见）",
    "editorial_preview_seen": "本人校对/编辑预览过本题（校对已看过答案，不能重新标为严格未见）",
    "answer_delivered": "本题已下发过答案，不能作为严格独立首次接触证据",
    "explanation_delivered": "本题已下发过讲解，不能作为严格独立首次接触证据",
    "hint_delivered": "本题已下发过提示，不能作为严格独立首次接触证据",
    "feedback_delivered": "本题已下发过判分反馈，不能作为严格独立首次接触证据",
    "stem_delivered": "本题题干已下发过（重复练习按重复统计，不能作为首次接触或陌生变式证据）",
    "presented_without_submit": "本题曾展示但未提交（已展示未提交的题不能重新标为严格未见）",
    "lineage_seen_in_other_project": "同一内容在本人其他项目中已暴露（内容谱系跨项目计为已见，不能重新标为严格未见）",
}

#: ``ExposureEvent.source`` values written by this module.
EXTERNAL_SEEN_SOURCE = "question_external_seen_declaration"
EDITORIAL_PREVIEW_SOURCE = "question_editorial_preview"


class _Fact(NamedTuple):
    """One piece of proof that the question is contaminated."""

    code: str
    at: datetime | None
    evidence_id: str
    evidence_type: str  # "exposure_event" | "session_item"
    exposure_kind: str | None
    question_id: str
    project_id: str | None
    session_item_id: str | None
    cross_project: bool = False


def _fact_evidence(fact: _Fact) -> dict:
    """The audit trail of one reason: which row proves it."""
    return {
        "evidence_id": fact.evidence_id,
        "evidence_type": fact.evidence_type,
        "exposure_kind": fact.exposure_kind,
        "question_id": fact.question_id,
        "project_id": fact.project_id,
        "session_item_id": fact.session_item_id,
        "server_time": fact.at.isoformat() if fact.at is not None else None,
    }


def _source_label(fact: _Fact) -> str:
    if fact.evidence_type == "session_item":
        prefix = "lineage_session_item" if fact.cross_project else "session_item"
        return f"{prefix}:presented_without_submit"
    prefix = "lineage_exposure" if fact.cross_project else "exposure_event"
    return f"{prefix}:{fact.exposure_kind}"


def _home_project_id(question, project) -> str | None:
    """The project a question is asked *from*: the given one, else its own."""
    if project is not None:
        return str(project.id)
    if question.subject_id:
        return str(question.subject.project_id)
    return None


def _earlier(candidate: _Fact, current: _Fact) -> bool:
    if candidate.at is None:
        return False
    if current.at is None:
        return True
    return candidate.at < current.at


def _reason_rows(facts: list[_Fact]) -> tuple[list[dict], list[_Fact]]:
    """Collapse facts into one deterministic reason row per code."""
    best: dict[str, _Fact] = {}
    for fact in facts:
        current = best.get(fact.code)
        if current is None or _earlier(fact, current):
            best[fact.code] = fact
    rows: list[dict] = []
    chosen: list[_Fact] = []
    for code in REASON_ORDER:
        fact = best.get(code)
        if fact is None:
            continue
        rows.append(
            {
                "code": code,
                "message": REASON_MESSAGES[code],
                "evidence": _fact_evidence(fact),
            }
        )
        chosen.append(fact)
    return rows, chosen


def _evaluate(
    *,
    user,
    question_ids: list[str],
    project=None,
    before: datetime | None = None,
    exclude_session_item_ids=(),
) -> dict[str, list[_Fact]]:
    """Per-question contamination facts, narrowed by the optional window.

    ``before`` bounds the non-absolute reasons to what was already knowable at
    that instant (the evidence projection passes the presentation moment of the
    item being judged). Absolute reasons ignore the window: a declaration or a
    proofreading preview is permanent.
    """
    from apps.question_bank.models import Question

    ids = [str(question_id) for question_id in question_ids]
    if not ids:
        return {}
    questions = {
        str(question.id): question
        for question in Question.objects.filter(id__in=ids).select_related("subject")
    }
    excluded_items = [str(item_id) for item_id in (exclude_session_item_ids or [])]
    facts: dict[str, list[_Fact]] = {question_id: [] for question_id in ids}

    if not questions:
        return facts

    # ---- 1. exposures the server already logged for this user on this question.
    direct = ExposureEvent.objects.filter(user=user).filter(
        Q(question_version__question_id__in=ids) | Q(question_id__in=ids)
    )
    if excluded_items:
        direct = direct.exclude(session_item_id__in=excluded_items)
    if before is not None:
        direct = direct.filter(Q(kind__in=_ABSOLUTE_KINDS) | Q(server_time__lt=before))
    for row in direct.select_related("question_version"):
        code = _KIND_TO_REASON.get(row.kind)
        if code is None:
            continue
        question_id = str(row.question_id) if row.question_id else (
            str(row.question_version.question_id) if row.question_version_id else ""
        )
        if question_id not in facts:
            continue
        facts[question_id].append(
            _Fact(
                code=code,
                at=row.server_time,
                evidence_id=str(row.id),
                evidence_type="exposure_event",
                exposure_kind=row.kind,
                question_id=question_id,
                project_id=str(row.project_id) if row.project_id else None,
                session_item_id=str(row.session_item_id) if row.session_item_id else None,
            )
        )

    # ---- 2. items delivered but never submitted (C04 source 3).
    items = SessionItem.objects.filter(
        session__user=user,
        question_version__question_id__in=ids,
        first_delivered_at__isnull=False,
        attempt__isnull=True,
    ).select_related("session", "question_version")
    if excluded_items:
        items = items.exclude(id__in=excluded_items)
    if before is not None:
        items = items.filter(first_delivered_at__lt=before)
    for item in items:
        question_id = str(item.question_version.question_id)
        if question_id not in facts:
            continue
        facts[question_id].append(
            _Fact(
                code="presented_without_submit",
                at=item.first_delivered_at,
                evidence_id=str(item.id),
                evidence_type="session_item",
                exposure_kind=None,
                question_id=question_id,
                project_id=str(item.session.project_id),
                session_item_id=str(item.id),
            )
        )

    # ---- 3. the same content in another project (exposure follows the lineage).
    lineage_homes: dict[str, set[str]] = {}
    for question in questions.values():
        if question.content_lineage_id is None:
            continue
        home = _home_project_id(question, project)
        if home is not None:
            lineage_homes.setdefault(str(question.content_lineage_id), set()).add(home)
    if lineage_homes:
        lineage_rows = ExposureEvent.objects.filter(
            user=user, content_lineage_id__in=sorted(lineage_homes)
        ).select_related("question_version")
        if excluded_items:
            lineage_rows = lineage_rows.exclude(session_item_id__in=excluded_items)
        if before is not None:
            lineage_rows = lineage_rows.filter(
                Q(kind__in=_ABSOLUTE_KINDS) | Q(server_time__lt=before)
            )
        for row in lineage_rows:
            code = _KIND_TO_REASON.get(row.kind)
            if code is None:
                continue
            homes = lineage_homes.get(str(row.content_lineage_id), set())
            if str(row.project_id) in homes:
                # Same project: this is the direct rule above, not a lineage fact.
                continue
            target_ids = [
                question_id
                for question_id, question in questions.items()
                if str(question.content_lineage_id or "") == str(row.content_lineage_id)
            ]
            for question_id in target_ids:
                facts[question_id].append(
                    _Fact(
                        code="lineage_seen_in_other_project",
                        at=row.server_time,
                        evidence_id=str(row.id),
                        evidence_type="exposure_event",
                        exposure_kind=row.kind,
                        question_id=question_id,
                        project_id=str(row.project_id) if row.project_id else None,
                        session_item_id=str(row.session_item_id) if row.session_item_id else None,
                        cross_project=True,
                    )
                )
                # A declaration or a proofreading preview is a property of the
                # content, so it stays absolute across the lineage too.
                if code in ABSOLUTE_REASON_CODES:
                    facts[question_id].append(
                        _Fact(
                            code=code,
                            at=row.server_time,
                            evidence_id=str(row.id),
                            evidence_type="exposure_event",
                            exposure_kind=row.kind,
                            question_id=question_id,
                            project_id=str(row.project_id) if row.project_id else None,
                            session_item_id=str(row.session_item_id) if row.session_item_id else None,
                            cross_project=True,
                        )
                    )
        lineage_items = SessionItem.objects.filter(
            session__user=user,
            question_version__question__content_lineage_id__in=sorted(lineage_homes),
            first_delivered_at__isnull=False,
            attempt__isnull=True,
        ).select_related("session", "question_version__question")
        if excluded_items:
            lineage_items = lineage_items.exclude(id__in=excluded_items)
        if before is not None:
            lineage_items = lineage_items.filter(first_delivered_at__lt=before)
        for item in lineage_items:
            lineage_id = str(item.question_version.question.content_lineage_id or "")
            homes = lineage_homes.get(lineage_id, set())
            if str(item.session.project_id) in homes:
                continue
            for question_id, question in questions.items():
                if str(question.content_lineage_id or "") != lineage_id:
                    continue
                facts[question_id].append(
                    _Fact(
                        code="lineage_seen_in_other_project",
                        at=item.first_delivered_at,
                        evidence_id=str(item.id),
                        evidence_type="session_item",
                        exposure_kind=None,
                        question_id=question_id,
                        project_id=str(item.session.project_id),
                        session_item_id=str(item.id),
                        cross_project=True,
                    )
                )

    return facts


def exposure_state(
    *,
    user,
    question_ids: list[str],
    project=None,
    before: datetime | None = None,
    exclude_session_item_ids=(),
) -> dict[str, dict]:
    """Per question id: has this question been exposed, and why it is no longer unseen.

    Returns, for every requested id::

        {
          "seen": bool,                        # any contamination fact exists
          "reasons": [reason code, ...],       # stable order, see REASON_ORDER
          "first_seen_at": iso | None,
          "sources": ["exposure_event:stem_delivered", ...],
          "strict_independent_eligible": bool, # == not seen
          "exclusion_reasons": [               # code + 中文 message + evidence
              {"code": ..., "message": ..., "evidence": {id/kind/...}},
          ],
        }

    ``project`` is the project the caller asks *from*: the lineage rule counts an
    exposure in any *other* project of the same owner. ``before`` and
    ``exclude_session_item_ids`` are the attempt-scoped narrowing used by the
    evidence projection (see :func:`attempt_exposure_state`): they never add
    reasons, they only limit the delivery-caused ones to what had happened before
    the item under judgement was presented.

    Without a window the answer is question-level: ``strict_independent_eligible``
    means "this question can still serve as first-contact evidence". A question
    the learner has already practised has necessarily been delivered, so it is
    ``seen`` from then on — which is exactly why a repeat of it can never be
    first contact again.
    """
    evaluated = _evaluate(
        user=user,
        question_ids=question_ids,
        project=project,
        before=before,
        exclude_session_item_ids=exclude_session_item_ids,
    )
    result: dict[str, dict] = {}
    for question_id, question_facts in evaluated.items():
        rows, chosen = _reason_rows(question_facts)
        instants = [fact.at for fact in chosen if fact.at is not None]
        result[question_id] = {
            "seen": bool(rows),
            "reasons": [row["code"] for row in rows],
            "first_seen_at": min(instants).isoformat() if instants else None,
            "sources": sorted({_source_label(fact) for fact in chosen}),
            "strict_independent_eligible": not rows,
            "exclusion_reasons": rows,
        }
    return result


def exclusion_reasons(
    *,
    user,
    question_ids: list[str],
    project=None,
    before: datetime | None = None,
    exclude_session_item_ids=(),
) -> dict[str, list[dict]]:
    """``question id -> [{"code", "message", "evidence"}, ...]`` (same rules)."""
    states = exposure_state(
        user=user,
        question_ids=question_ids,
        project=project,
        before=before,
        exclude_session_item_ids=exclude_session_item_ids,
    )
    return {question_id: row["exclusion_reasons"] for question_id, row in states.items()}


def attempt_reference_instant(attempt):
    """The instant an attempt's contamination is judged at.

    The same boundary the evidence projection always used: the first
    presentation of the item (falling back to the submission for a server-side
    submission path), never "now" — so recomputation of an old attempt cannot
    invent a later exposure as if it had come first.
    """
    item = attempt.session_item
    if item.first_delivered_at is not None:
        return item.first_delivered_at
    return attempt.submitted_at


def attempt_exposure_state(*, attempt) -> dict:
    """The question-level state of one attempt, as of its own presentation.

    Thin named wrapper over :func:`exposure_state`: the rules are not re-stated
    here, only the attempt's window (its question, its project, the instant the
    item was presented, and the exclusion of its own item's deliveries).
    """
    question_id = str(attempt.session_item.question_version.question_id)
    return exposure_state(
        user=attempt.user,
        question_ids=[question_id],
        project=attempt.project,
        before=attempt_reference_instant(attempt),
        exclude_session_item_ids=[str(attempt.session_item_id)],
    )[question_id]


def attempt_exclusion_reasons(*, attempt) -> list[dict]:
    """The precise reasons one attempt cannot be strictly independent."""
    return attempt_exposure_state(attempt=attempt)["exclusion_reasons"]


# --------------------------------------------------------------------------
# Writers (C04 sources 1 and 2). Both are append-only: a correction is a new row.
# --------------------------------------------------------------------------
def _published_version(question, version=None):
    if version is not None:
        return version
    return question.current_published_version or question.versions.order_by("-version").first()


def record_external_seen(
    *, question, actor, project, seen: bool = True, note: str = "", version=None
) -> ExposureEvent:
    """Append the learner's own declaration that they met this question outside.

    The ledger is append-only: ``seen=false`` records a *correction row* (kept,
    with ``note``) and ``seen=true`` records the declaration. Neither changes the
    contamination decision — once a question has ever been declared seen it can
    never produce strict-independent evidence again (C04), so a correction is
    history, not a reset.

    Nothing was delivered by the server here, so the row is written with
    ``reveals_answer=False`` and ``purpose="report"`` (the learner reports an
    out-of-system fact); the decision does not depend on ``reveals_answer``.
    """
    from apps.practice.services import exposure as exposure_service

    moment = timezone.now()
    return exposure_service.record(
        user=actor,
        project=project,
        question=question,
        question_version=_published_version(question, version),
        kind=ExposureKind.EXTERNAL_SEEN,
        purpose=ExposurePurpose.REPORT,
        source=EXTERNAL_SEEN_SOURCE,
        reveals_answer=False,
        detail={
            "seen": bool(seen),
            "note": (note or "")[:300],
            "declared_at": moment.isoformat(),
            "declared_by": str(getattr(actor, "id", "") or ""),
        },
    )


def record_editorial_preview(
    *,
    question,
    actor,
    source: str = EDITORIAL_PREVIEW_SOURCE,
    candidate=None,
    project=None,
    version=None,
    note: str = "",
) -> ExposureEvent:
    """Record that this user proofread/edited the question and so saw its answer.

    Proofreading is a real exposure (C04 source 1), so the row is written with
    ``reveals_answer=True``. The only honest trigger today is a re-import
    candidate linked to an already-published question
    (``ImportCandidate.publication_question_id``): opening it means the
    proofreader is looking at the answer of published content. The ingestion
    workstream can call this helper from its candidate read/edit endpoints
    without importing evidence internals; when ``candidate`` is given, repeating
    the same open reuses the existing row instead of stacking duplicates.
    """
    from apps.practice.services import exposure as exposure_service

    if candidate is not None:
        existing = ExposureEvent.objects.filter(
            user=actor,
            question=question,
            kind=ExposureKind.EDITORIAL_PREVIEW,
            detail__candidate_id=str(candidate.id),
        ).first()
        if existing is not None:
            return existing
    detail = {
        "proofread_at": timezone.now().isoformat(),
        "note": (note or "")[:300],
        "published_question": bool(getattr(question, "current_published_version_id", None)),
    }
    if candidate is not None:
        detail["candidate_id"] = str(candidate.id)
        detail["candidate_status"] = candidate.status
    return exposure_service.record(
        user=actor,
        project=project or question.subject.project,
        question=question,
        question_version=_published_version(question, version),
        kind=ExposureKind.EDITORIAL_PREVIEW,
        purpose=ExposurePurpose.EDITORIAL,
        source=source,
        reveals_answer=True,
        detail=detail,
    )


__all__ = [
    "ABSOLUTE_REASON_CODES",
    "EDITORIAL_PREVIEW_SOURCE",
    "EXTERNAL_SEEN_SOURCE",
    "REASON_MESSAGES",
    "REASON_ORDER",
    "attempt_exclusion_reasons",
    "attempt_exposure_state",
    "attempt_reference_instant",
    "exclusion_reasons",
    "exposure_state",
    "record_editorial_preview",
    "record_external_seen",
]
