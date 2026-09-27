"""Validated-segment SSE streaming for tutor jobs (P1 batch 3, acceptance B08).

The rule this module implements (docs/05 §3 B08):

    "SSE 断线重连不重复调用；只发送验证后的内容片段，失效来源被拦截"

    * *only validated content*: a segment mirrors one block of
      ``TutorJob.result_blocks``, which is written by ``services.core.run_job``
      **after** ``validate_explain_payload`` accepted the model output. Nothing
      that a model produced raw — a partial stream, an unparsable payload, a
      fabricated citation — has a block to mirror, so it cannot be delivered.
    * *reconnect does not re-call*: this module never calls a provider and never
      creates an ``LLMRun`` or an outbox event. A reconnect with
      ``Last-Event-ID: n`` only narrows one query (``index__gt n``); it does not
      resume, retry or re-run anything. Generation happened once, in the POST
      that created the job.
    * *invalidated sources are blocked*: :func:`source_is_stale` compares the
      job's frozen inputs with the live content, and a stale source yields one
      ``error`` frame and no segment frame at all — not even the segments that
      were already stored while the source was still current.

Frames are pre-formatted SSE text (``event:``/``data:``/``id:`` lines), so the
view can hand the generator straight to ``StreamingHttpResponse``. Only
``segment`` frames carry an ``id:``: the event id is the block index, which is
exactly the cursor the browser sends back in ``Last-Event-ID``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Iterator
from typing import Any

from django.utils import timezone

from apps.common.enums import TutorRequestStatus, VerificationStatus
from apps.tutoring.models import TutorJob, TutorSegment

logger = logging.getLogger("apps.tutoring")

#: Block kinds the structured-output validator accepts (nothing else is stored).
VALID_SEGMENT_KINDS = frozenset({"text", "math", "list"})

#: Poll cadence bounds for the in-flight path. The stream is a *database* poll:
#: it re-reads the job row and its segment rows, and touches no provider.
MIN_POLL_SECONDS = 0.05
MAX_POLL_SECONDS = 5.0
DEFAULT_POLL_SECONDS = 0.5
MIN_STREAM_SECONDS = 0.1
MAX_STREAM_SECONDS = 120.0
DEFAULT_STREAM_SECONDS = 30.0

#: Reason attached to segments when the job itself was finalized as stale.
STALE_FROZEN_INPUTS = "冻结输入在任务运行期间已变化：原讲解不再对应当前题目内容"
#: Reason for a job explicitly retired as stale: it delivers nothing, ever.
STALE_JOB_STATUS_REASON = "任务已被标记为失效：不再交付任何内容"

TERMINAL_STATUSES = frozenset(
    {TutorRequestStatus.FAILED, TutorRequestStatus.UNAVAILABLE, TutorRequestStatus.STALE}
)


# ---------------------------------------------------------------------------
# Writing the mirror
# ---------------------------------------------------------------------------


def _block_fields(index: int, block: dict[str, Any]) -> dict[str, Any] | None:
    """Map one validated block to segment columns, or ``None`` if unusable.

    The shapes handled here are exactly the ones ``validate_explain_payload``
    emits (``{"kind": "text", "text": ...}``, ``{"kind": "math", "latex": ...}``,
    ``{"kind": "list", "items": [...]}``). Anything else is refused rather than
    guessed, so an unvalidated block can never acquire a segment row.
    """
    kind = str(block.get("kind") or "text")
    if kind not in VALID_SEGMENT_KINDS:
        logger.warning("tutor segment: refused unvalidated block kind %r at index %s", kind, index)
        return None
    if kind == "list":
        items = [str(item) for item in (block.get("items") or []) if str(item).strip()]
        canonical: dict[str, Any] = {"kind": "list", "items": items}
        text = ""
    elif kind == "math":
        text = str(block.get("latex", ""))
        canonical = {"kind": "math", "latex": text}
        items = []
    else:
        text = str(block.get("text", ""))
        canonical = {"kind": "text", "text": text}
        items = []
    if kind != "list" and not text.strip():
        # The validator already rejects empty blocks; keep the mirror honest.
        logger.warning("tutor segment: refused empty %s block at index %s", kind, index)
        return None
    digest = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return {"index": index, "kind": kind, "text": text, "items": items, "digest": digest}


def append_segments(job: TutorJob) -> int:
    """Idempotently mirror ``job.result_blocks`` into ``TutorSegment`` rows.

    Called from the finalize path (``services.core._finalize_success``) in the
    same commit as the assistant turn, so "the explanation was delivered" and
    "the segments a reconnect can replay exist" are one fact.

    Returns the number of rows this call actually inserted. A no-op (0) when the
    job was not ``succeeded`` or holds no validated blocks; a re-run after a
    crash completes a missing mirror, and a re-run with a complete mirror adds
    nothing — ``(job, index)`` is unique, so a duplicate is impossible even with
    two consumers racing.
    """
    if job.status != TutorRequestStatus.SUCCEEDED:
        return 0
    blocks = job.result_blocks if isinstance(job.result_blocks, list) else []
    if not blocks:
        return 0
    existing = set(job.segments.values_list("index", flat=True))
    reason = STALE_FROZEN_INPUTS if job.is_stale else ""
    pending: list[TutorSegment] = []
    for index, block in enumerate(blocks):
        if index in existing or not isinstance(block, dict):
            continue
        fields = _block_fields(index, block)
        if fields is None:
            continue
        pending.append(
            TutorSegment(
                job=job,
                is_stale=bool(job.is_stale),
                stale_reason=reason if job.is_stale else "",
                **fields,
            )
        )
    created = 0
    if pending:
        TutorSegment.objects.bulk_create(pending, ignore_conflicts=True)
        created = max(0, TutorSegment.objects.filter(job=job).count() - len(existing))
    if job.is_stale:
        # The job already knows its frozen inputs drifted; keep the mirror and
        # the job row telling the same story.
        mark_stale(job, reason)
    return created


def mark_stale(job: TutorJob, reason: str) -> int:
    """Mark every not-yet-stale segment of ``job`` stale. Returns rows changed.

    Idempotent and bounded: one ``UPDATE`` that only touches rows still marked
    current. A stale segment is never delivered (see :func:`stream_events`).
    """
    return TutorSegment.objects.filter(job=job, is_stale=False).update(
        is_stale=True,
        stale_reason=str(reason or STALE_FROZEN_INPUTS)[:300],
        updated_at=timezone.now(),
    )


# ---------------------------------------------------------------------------
# Reading: is the frozen source still the live content?
# ---------------------------------------------------------------------------


def effective_answer_key_id(question_version_id) -> Any:
    """The answer a *new* session item for this content would freeze today.

    Same rule as ``practice.services.sessions._resolve_versions``: the latest
    checked, undisputed answer key of the question version.
    """
    from apps.question_bank.models import AnswerKeyVersion

    return (
        AnswerKeyVersion.objects.filter(
            question_version_id=question_version_id,
            verification_status=VerificationStatus.CHECKED,
            is_disputed=False,
        )
        .order_by("-version")
        .values_list("id", flat=True)
        .first()
    )


def source_is_stale(job: TutorJob) -> str:
    """Why the job's frozen inputs no longer match the live content ("" = current).

    Two independent facts are checked, both about the *session item* the tutor
    session froze its inputs from:

    1. the item's current question version is no longer the frozen one — the
       explanation describes content that is not what the learner would see; and
    2. the frozen answer key is no longer the checked/effective answer of that
       version — someone published a corrected answer, disputed the old one, or
       the answer is gone. Explaining against a superseded answer is exactly the
       "失效来源" the acceptance rule blocks.

    Read-only: two indexed reads, no write.
    """
    session = job.tutor_session
    item = session.session_item
    if str(session.question_version_id or "") != str(item.question_version_id or ""):
        return "题项已切换到新的题目版本：原讲解不再对应当前题目内容"
    frozen_answer_id = session.answer_key_version_id
    if frozen_answer_id is None:
        if item.answer_key_version_id is None:
            return ""
        return "题项已关联答案版本，而原讲解是在没有可用答案时生成的"
    frozen = session.answer_key_version
    if frozen is None:
        return "原讲解依据的答案版本已被删除"
    if str(frozen.question_version_id) != str(session.question_version_id or ""):
        return "原讲解依据的答案版本与冻结的题目版本不一致"
    effective_id = effective_answer_key_id(session.question_version_id)
    if effective_id is None:
        return "该题目版本当前没有已核对且无争议的答案版本"
    if str(effective_id) != str(frozen_answer_id):
        return "该题目版本的已核对答案已更新：原讲解依据的答案不再有效"
    return ""


def delivery_block_reason(job: TutorJob) -> str:
    """Non-empty when no segment of this job may be delivered.

    Three ways content becomes undeliverable, checked in order: the frozen source
    no longer matches the live content, the job itself was finalized as stale, or
    a segment row has been marked stale (``mark_stale``, e.g. by an answer
    correction). Content built from inputs that have drifted is never shown, even
    when the drift has since been reversed.
    """
    if job.status == TutorRequestStatus.STALE:
        return STALE_JOB_STATUS_REASON
    live = source_is_stale(job)
    if live:
        return live
    if job.is_stale:
        return STALE_FROZEN_INPUTS
    stale_row = job.segments.filter(is_stale=True).order_by("index").first()
    if stale_row is not None:
        return stale_row.stale_reason or STALE_FROZEN_INPUTS
    return ""


def segment_rows(job: TutorJob) -> list[TutorSegment]:
    return list(job.segments.order_by("index"))


def segments_payload(job: TutorJob) -> dict[str, Any]:
    """Transcript view for the UI that cannot or does not want to hold an SSE
    connection. Pure read; the same staleness rule as the stream applies, so the
    two surfaces can never disagree about what is deliverable."""
    reason = delivery_block_reason(job)
    rows = segment_rows(job)
    return {
        "tutor_job_id": str(job.id),
        "status": job.status,
        "is_stale": bool(reason),
        "stale_reason": reason,
        "segment_count": len(rows),
        "segments": [
            {
                "index": row.index,
                "kind": row.kind,
                "text": row.text,
                "items": row.items,
                "digest": row.digest,
                "is_stale": bool(row.is_stale or reason),
            }
            for row in rows
        ],
    }


# ---------------------------------------------------------------------------
# Frames
# ---------------------------------------------------------------------------


def _frame(event: str, data: dict[str, Any], *, event_id: int | None = None) -> str:
    lines: list[str] = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append("data: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines) + "\n\n"


def _keep_alive() -> str:
    """A comment frame: keeps proxies from buffering an idle stream."""
    return ": keep-alive\n\n"


def _segment_data(row: TutorSegment) -> dict[str, Any]:
    return {
        "index": row.index,
        "kind": row.kind,
        "text": row.text,
        "items": row.items,
        "digest": row.digest,
        "is_stale": bool(row.is_stale),
    }


def _status_data(job: TutorJob, last_event_id: int | None) -> dict[str, Any]:
    return {
        "tutor_job_id": str(job.id),
        "status": job.status,
        "is_stale": bool(job.is_stale),
        "segment_count": job.segments.count(),
        "citation_count": len(job.citations or []),
        "finalized": job.finalized_at is not None,
        "is_stub": bool(job.llm_run.is_stub) if job.llm_run_id else False,
        "last_event_id": last_event_id,
    }


def _is_final(job: TutorJob) -> bool:
    """Terminal *for streaming*: a failed job, or a succeeded job whose business
    commit landed. A succeeded-but-not-yet-finalized job is still being finished
    by its consumer, so the stream waits rather than showing a truncated
    transcript."""
    if job.status in TERMINAL_STATUSES:
        return True
    return job.status == TutorRequestStatus.SUCCEEDED and job.finalized_at is not None


def stream_events(
    *,
    job: TutorJob,
    last_event_id: int | None,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    max_seconds: float = DEFAULT_STREAM_SECONDS,
) -> Iterator[str]:
    """Yield pre-formatted SSE frames for one job, in this order:

        status -> segment(0..n | index > last_event_id) -> done

    A stale source (or a segment row already marked stale) short-circuits to a
    single ``error`` frame (``stale_source``) and nothing else. An in-flight job
    is polled with plain database reads every ``poll_seconds`` until it becomes
    terminal or ``max_seconds`` elapses, with a ``: keep-alive`` comment frame
    between polls; on timeout an ``event: timeout`` frame ends the stream.

    No provider call, no ``LLMRun`` and no outbox event happens on any path of
    this generator — reconnecting is free. ``last_event_id`` only filters rows
    (``index > last_event_id``), so a resumed stream never re-sends a segment the
    client already acknowledged and never re-generates anything.
    """
    poll = min(MAX_POLL_SECONDS, max(MIN_POLL_SECONDS, float(poll_seconds)))
    budget = min(MAX_STREAM_SECONDS, max(MIN_STREAM_SECONDS, float(max_seconds)))
    started = time.monotonic()
    deadline = started + budget
    cursor = last_event_id if (last_event_id is not None and last_event_id >= 0) else None

    job.refresh_from_db()

    reason = delivery_block_reason(job)
    if reason:
        # Nothing else: no status frame, no segment frame, not even for content
        # stored while the source was still current.
        yield _frame(
            "error",
            {
                "code": "stale_source",
                "reason": reason,
                "tutor_job_id": str(job.id),
                "status": job.status,
                "last_event_id": cursor,
            },
        )
        return

    yield _frame("status", _status_data(job, cursor))

    while True:
        rows = list(
            job.segments.filter(index__gt=cursor if cursor is not None else -1).order_by("index")
        )
        for row in rows:
            yield _frame("segment", _segment_data(row), event_id=row.index)
            cursor = row.index
        if _is_final(job):
            yield _frame(
                "done",
                {
                    "tutor_job_id": str(job.id),
                    "status": job.status,
                    "is_stale": bool(job.is_stale),
                    "segment_count": job.segments.count(),
                    "citation_count": len(job.citations or []),
                    "last_event_id": cursor,
                },
            )
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            yield _frame(
                "timeout",
                {
                    "code": "timeout",
                    "tutor_job_id": str(job.id),
                    "status": job.status,
                    "segment_count": job.segments.count(),
                    "last_event_id": cursor,
                    "waited_seconds": round(time.monotonic() - started, 3),
                },
            )
            return
        # Comment frame first: the client/proxy sees liveness while we sleep.
        yield _keep_alive()
        time.sleep(min(poll, remaining))
        job.refresh_from_db()
