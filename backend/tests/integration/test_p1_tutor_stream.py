"""P1 batch 3 / B08: validated-segment SSE streaming and honest reconnect.

Acceptance rule (docs/05 §3 B08): "SSE 断线重连不重复调用；只发送验证后的内容片段，
失效来源被拦截" — a dropped connection must never buy a second model call, only
content that already passed structured-output validation may leave the server,
and content whose frozen source has been invalidated is blocked outright.

The job is always produced through the real HTTP path (``POST .../messages``)
with the stub provider, so these tests exercise the same code a client would.
"""

from __future__ import annotations

import json

import pytest
from django.db import IntegrityError, transaction
from django.http import StreamingHttpResponse

from ai.providers import base as providers
from apps.audit.models import LLMRun, OutboxEvent
from apps.common.enums import AnswerSourceType, VerificationStatus
from apps.practice.models import SessionItem
from apps.question_bank.services import core as qb_services
from apps.tutoring.models import TutorJob, TutorSegment
from apps.tutoring.services import core as tutor_services
from apps.tutoring.services import streaming
from tests.integration.test_ai_providers import ask, tutor_session_for

pytestmark = pytest.mark.django_db


class CountingStub(providers.StubProvider):
    """The deterministic stub plus a call counter.

    Streaming is supposed to be a pure read of stored rows, so the counter must
    not move when a stream is opened, dropped or resumed.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.calls = 0

    def call(self, request):
        self.calls += 1
        return super().call(request)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def ask_job(caller, project, item, question: str = "请讲解"):
    """Drive one job through the real HTTP path and return its job payload."""
    session_id = tutor_session_for(caller, project, str(item.id))
    response = ask(caller, project, session_id, question)
    assert response.status_code == 201, response.content
    return response.json()


def job_created_by(caller, project, item) -> tuple[dict, CountingStub]:
    provider = CountingStub()
    providers.set_provider_override(provider)
    return ask_job(caller, project, item), provider


def stream_url(project, job_id, *, after=None, poll_seconds=None, max_seconds=None) -> str:
    query = []
    if after is not None:
        query.append(f"after={after}")
    if poll_seconds is not None:
        query.append(f"poll_seconds={poll_seconds}")
    if max_seconds is not None:
        query.append(f"max_seconds={max_seconds}")
    suffix = f"?{'&'.join(query)}" if query else ""
    return f"/api/v1/projects/{project.id}/tutor-jobs/{job_id}/stream{suffix}"


def segments_url(project, job_id) -> str:
    return f"/api/v1/projects/{project.id}/tutor-jobs/{job_id}/segments"


def open_stream(caller, project, job_id, *, last_event_id=None, **query):
    headers = {}
    if last_event_id is not None:
        headers["HTTP_LAST_EVENT_ID"] = str(last_event_id)
    response = caller.client.get(stream_url(project, job_id, **query), **headers)
    assert response.status_code == 200, response.status_code
    assert isinstance(response, StreamingHttpResponse)
    assert response["Content-Type"].startswith("text/event-stream")
    assert response["Cache-Control"] == "no-cache"
    assert response["X-Accel-Buffering"] == "no"
    return b"".join(response.streaming_content).decode("utf-8")


def parse_frames(text: str) -> list[dict]:
    """Decode SSE frames into ``{"event", "id", "data"}`` dicts."""
    frames: list[dict] = []
    for raw in text.split("\n\n"):
        if not raw.strip():
            continue
        if raw.lstrip().startswith(":"):
            frames.append({"event": ":keep-alive", "id": None, "data": None})
            continue
        event = None
        event_id = None
        data = None
        for line in raw.split("\n"):
            if line.startswith("id:"):
                event_id = int(line.split(":", 1)[1].strip())
            elif line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = json.loads(line.split(":", 1)[1].strip())
        frames.append({"event": event, "id": event_id, "data": data})
    return frames


def events(frames: list[dict]) -> list[str]:
    return [frame["event"] for frame in frames]


def content_frames(frames: list[dict]) -> list[dict]:
    return [frame for frame in frames if frame["event"] == "segment"]


# ---------------------------------------------------------------------------
# 1. validated content only: status -> segments -> done
# ---------------------------------------------------------------------------


def test_succeeded_job_streams_only_validated_segments(caller, project_a, practice_item):
    job, provider = job_created_by(caller, project_a, practice_item)
    assert job["status"] == "succeeded"
    blocks = job["result_blocks"]
    assert blocks, "the stub must produce a validated explanation"
    assert job["segment_count"] == len(blocks)

    frames = parse_frames(open_stream(caller, project_a, job["tutor_job_id"]))

    assert events(frames) == ["status", *["segment"] * len(blocks), "done"]
    status = frames[0]["data"]
    assert status["status"] == "succeeded"
    assert status["is_stale"] is False
    assert status["segment_count"] == len(blocks)
    assert status["finalized"] is True
    assert status["citation_count"] == len(job["citations"])

    streamed = content_frames(frames)
    # The SSE event id is the block index, and the payload mirrors the block the
    # validator accepted — nothing else was ever stored.
    assert [frame["id"] for frame in streamed] == list(range(len(blocks)))
    assert [frame["data"]["kind"] for frame in streamed] == [block["kind"] for block in blocks]
    assert [frame["data"]["text"] for frame in streamed] == [block.get("text", "") for block in blocks]
    assert all(frame["data"]["kind"] in streaming.VALID_SEGMENT_KINDS for frame in streamed)
    assert all(frame["data"]["digest"] for frame in streamed)

    done = frames[-1]["data"]
    assert done["status"] == "succeeded"
    assert done["citation_count"] == len(job["citations"])
    assert done["last_event_id"] == len(blocks) - 1

    # The non-SSE transcript endpoint returns the very same rows.
    response = caller.get(segments_url(project_a, job["tutor_job_id"]))
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "succeeded"
    assert body["is_stale"] is False
    assert body["segment_count"] == len(blocks)
    assert [row["index"] for row in body["segments"]] == list(range(len(blocks)))
    assert [row["text"] for row in body["segments"]] == [frame["data"]["text"] for frame in streamed]
    assert [row["digest"] for row in body["segments"]] == [frame["data"]["digest"] for frame in streamed]
    assert all(row["is_stale"] is False for row in body["segments"])

    # The job payload advertises the segment count too.
    payload = caller.get(f"/api/v1/projects/{project_a.id}/tutor-jobs/{job['tutor_job_id']}").json()
    assert payload["segment_count"] == len(blocks)


# ---------------------------------------------------------------------------
# 2. reconnect is free: no provider call, no duplicate segment
# ---------------------------------------------------------------------------


def test_reconnect_after_last_event_id_does_not_call_the_provider_again(caller, project_a, practice_item):
    job, provider = job_created_by(caller, project_a, practice_item)
    job_id = job["tutor_job_id"]
    block_count = len(job["result_blocks"])

    calls_after_generation = provider.calls
    runs_before = LLMRun.objects.count()
    outbox_before = OutboxEvent.objects.count()
    segments_before = TutorSegment.objects.filter(job_id=job_id).count()

    first = parse_frames(open_stream(caller, project_a, job_id))
    first_ids = [frame["id"] for frame in content_frames(first)]
    assert first_ids == list(range(block_count))

    # The client acknowledges the first segment and drops; the resumed stream
    # must continue strictly after it.
    resume_after = first_ids[0]
    second = parse_frames(open_stream(caller, project_a, job_id, last_event_id=resume_after))
    resumed_ids = [frame["id"] for frame in content_frames(second)]

    assert resumed_ids == first_ids[1:], "the resumed stream replayed or lost segments"
    assert resume_after not in resumed_ids, "the acknowledged segment was sent twice"
    assert len(resumed_ids) == len(set(resumed_ids)), "a segment was duplicated"
    if 1 in first_ids:
        assert resumed_ids.count(1) == 1
    assert events(second)[0] == "status"
    assert events(second)[-1] == "done"
    # Byte-identical frames: a resume replays stored content, not regenerated text.
    assert [frame["data"] for frame in content_frames(second)] == [
        frame["data"] for frame in content_frames(first) if frame["id"] > resume_after
    ]

    # Reconnect is free: no second model call, no audit row, no outbox event,
    # and no new segment row.
    assert provider.calls == calls_after_generation
    assert LLMRun.objects.count() == runs_before
    assert OutboxEvent.objects.count() == outbox_before
    assert TutorSegment.objects.filter(job_id=job_id).count() == segments_before


def test_explicit_after_query_parameter_resumes_the_same_way(caller, project_a, practice_item):
    job, provider = job_created_by(caller, project_a, practice_item)
    calls = provider.calls
    frames = parse_frames(open_stream(caller, project_a, job["tutor_job_id"], after=0))
    assert [frame["id"] for frame in content_frames(frames)] == list(range(1, len(job["result_blocks"])))
    assert provider.calls == calls


# ---------------------------------------------------------------------------
# 3. invalidated sources are blocked
# ---------------------------------------------------------------------------


def _republish_item_version(project, item: SessionItem) -> None:
    """Publish a new version of the item's content and point the item at it.

    This is the live-content drift the acceptance rule calls "失效来源": the
    job's frozen question version is no longer the one the learner would see.
    """
    old_version = item.question_version
    new_version = qb_services.create_question_version_draft(
        old_version.question,
        question_type=old_version.question_type,
        content=old_version.content,
        actor=project.owner,
        practice_max_score=old_version.practice_max_score,
        revision_reason="B08 staleness regression",
    )
    new_answer = qb_services.create_answer_key_version(
        new_version,
        answer_payload=item.answer_key_version.answer_payload,
        actor=project.owner,
        source_type=AnswerSourceType.USER,
        verification_status=VerificationStatus.CHECKED,
        check_basis="B08 测试人工核对",
        explanation_blocks=item.answer_key_version.explanation_blocks,
    )
    qb_services.publish_question_version(new_version, actor=project.owner)
    SessionItem.objects.filter(id=item.id).update(
        question_version=new_version, answer_key_version=new_answer
    )


def test_stale_source_emits_one_error_and_never_a_segment(caller, project_a, practice_item):
    job, provider = job_created_by(caller, project_a, practice_item)
    job_id = job["tutor_job_id"]
    stored = TutorJob.objects.get(id=job_id)
    assert stored.segments.count() == len(job["result_blocks"])
    assert streaming.source_is_stale(stored) == ""

    _republish_item_version(project_a, practice_item)

    stored.refresh_from_db()
    reason = streaming.source_is_stale(stored)
    assert reason, "a new question version must invalidate the frozen source"
    assert streaming.segments_payload(stored)["is_stale"] is True

    text = open_stream(caller, project_a, job_id)
    frames = parse_frames(text)
    assert events(frames) == ["error"], "a stale source must send nothing else"
    assert frames[0]["data"]["code"] == "stale_source"
    assert frames[0]["data"]["reason"] == reason
    assert "event: segment" not in text
    assert provider.calls == 1, "blocking a stale source must not buy a new call"

    body = caller.get(segments_url(project_a, job_id)).json()
    assert body["is_stale"] is True
    assert body["stale_reason"] == reason
    # The rows still exist for an operator, but every one of them is flagged and
    # none of them is offered as current content.
    assert body["segment_count"] == len(job["result_blocks"])
    assert all(row["is_stale"] is True for row in body["segments"])


def test_superseded_answer_key_makes_the_source_stale(caller, project_a, practice_item):
    """The second clause: the frozen answer is no longer the effective one."""
    job, _provider = job_created_by(caller, project_a, practice_item)
    stored = TutorJob.objects.get(id=job["tutor_job_id"])
    version = practice_item.question_version
    corrected = qb_services.create_answer_key_version(
        version,
        answer_payload=stored.tutor_session.answer_key_version.answer_payload,
        actor=project_a.owner,
        source_type=AnswerSourceType.USER,
        verification_status=VerificationStatus.CHECKED,
        check_basis="B08 更正后的答案",
    )
    assert corrected.id != stored.tutor_session.answer_key_version_id

    stored.refresh_from_db()
    reason = streaming.source_is_stale(stored)
    assert reason and "答案" in reason

    frames = parse_frames(open_stream(caller, project_a, stored.id))
    assert events(frames) == ["error"]
    assert frames[0]["data"]["code"] == "stale_source"
    assert caller.get(segments_url(project_a, stored.id)).json()["is_stale"] is True


# ---------------------------------------------------------------------------
# 4. unvalidated output leaves no trace
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("behaviour", ["invalid_json", "fabricated_reference"])
def test_failed_validation_has_zero_segments_and_streams_the_failure(
    caller, project_a, practice_item, behaviour
):
    providers.set_provider_override(providers.StubProvider(behaviour=behaviour))
    job = ask_job(caller, project_a, practice_item)
    job_id = job["tutor_job_id"]

    assert job["status"] == "failed"
    assert job["result_blocks"] == []
    assert job["segment_count"] == 0
    assert TutorSegment.objects.filter(job_id=job_id).count() == 0

    frames = parse_frames(open_stream(caller, project_a, job_id))
    assert events(frames) == ["status", "done"]
    assert frames[0]["data"]["segment_count"] == 0
    assert frames[0]["data"]["status"] == "failed"
    assert frames[-1]["data"]["status"] == "failed"
    assert content_frames(frames) == []

    body = caller.get(segments_url(project_a, job_id)).json()
    assert body["segments"] == []
    assert body["segment_count"] == 0
    assert body["status"] == "failed"


# ---------------------------------------------------------------------------
# 5. scope
# ---------------------------------------------------------------------------


def test_another_user_cannot_stream_or_read_the_segments(
    caller, other_caller, project_a, practice_item
):
    job, _provider = job_created_by(caller, project_a, practice_item)
    job_id = job["tutor_job_id"]

    foreign_stream = other_caller.client.get(stream_url(project_a, job_id))
    assert foreign_stream.status_code == 404
    assert foreign_stream.json()["error"]["code"] == "not_found"
    assert other_caller.get(segments_url(project_a, job_id)).status_code == 404
    # A missing job inside the owner's own project is the same honest 404.
    missing = "00000000-0000-0000-0000-000000000000"
    assert caller.client.get(stream_url(project_a, missing)).status_code == 404
    assert caller.get(segments_url(project_a, missing)).status_code == 404


# ---------------------------------------------------------------------------
# 6. the mirror is append-only and idempotent
# ---------------------------------------------------------------------------


def test_append_segments_is_idempotent(caller, project_a, practice_item):
    job, _provider = job_created_by(caller, project_a, practice_item)
    stored = TutorJob.objects.get(id=job["tutor_job_id"])
    block_count = len(job["result_blocks"])
    assert stored.segments.count() == block_count
    first_digests = list(stored.segments.order_by("index").values_list("digest", flat=True))

    assert streaming.append_segments(stored) == 0
    assert streaming.append_segments(stored) == 0
    assert stored.segments.count() == block_count
    assert list(stored.segments.order_by("index").values_list("index", flat=True)) == list(
        range(block_count)
    )
    assert list(stored.segments.order_by("index").values_list("digest", flat=True)) == first_digests

    # The uniqueness is a real database constraint, not only a Python check.
    with pytest.raises(IntegrityError), transaction.atomic():
        TutorSegment.objects.create(
            job=stored, index=0, kind="text", text="重复内容", digest="0" * 64
        )

    # A job without a validated result mirrors nothing, whatever it claims.
    failed = TutorJob.objects.create(
        tutor_session=stored.tutor_session,
        user=stored.user,
        project=stored.project,
        status="failed",
        result_blocks=[{"kind": "text", "text": "不该存在的片段"}],
    )
    assert streaming.append_segments(failed) == 0
    assert failed.segments.count() == 0


def test_mark_stale_flags_rows_once_and_refuses_unvalidated_kinds(caller, project_a, practice_item):
    job, _provider = job_created_by(caller, project_a, practice_item)
    stored = TutorJob.objects.get(id=job["tutor_job_id"])
    block_count = stored.segments.count()

    assert streaming.mark_stale(stored, "来源已失效") == block_count
    assert streaming.mark_stale(stored, "来源已失效") == 0
    assert set(stored.segments.values_list("is_stale", flat=True)) == {True}
    assert streaming.delivery_block_reason(stored) != ""
    assert streaming.segments_payload(stored)["is_stale"] is True

    # An unvalidated block shape never becomes a segment, even if the job row is
    # tampered with: only the shapes the validator emits are mirrored.
    tampered = TutorJob.objects.create(
        tutor_session=stored.tutor_session,
        user=stored.user,
        project=stored.project,
        status="succeeded",
        result_blocks=[{"kind": "html", "text": "<script>alert(1)</script>"}],
        finalized_at=stored.finalized_at,
    )
    assert streaming.append_segments(tampered) == 0
    assert tampered.segments.count() == 0


# ---------------------------------------------------------------------------
# 7. an in-flight job is polled, never generated
# ---------------------------------------------------------------------------


def test_in_flight_job_polls_the_database_and_times_out_honestly(caller, project_a, practice_item):
    provider = CountingStub()
    providers.set_provider_override(provider)
    session_id = tutor_session_for(caller, project_a, str(practice_item.id))
    session = tutor_services.session_scope(project_a.owner, project_a, session_id)
    # A queued job with its outbox event committed but no consumer yet: exactly
    # the state a worker-backed deployment shows while the model is running.
    queued = tutor_services.create_job(
        tutor_session=session, user=project_a.owner, user_question="在跑的任务"
    )
    assert queued.status == "queued"
    runs_before = LLMRun.objects.count()
    outbox_before = OutboxEvent.objects.count()
    calls_before = provider.calls

    text = open_stream(caller, project_a, queued.id, poll_seconds=0.1, max_seconds=0.3)
    frames = parse_frames(text)
    assert frames[0]["event"] == "status"
    assert frames[0]["data"]["status"] == "queued"
    assert frames[0]["data"]["finalized"] is False
    assert frames[0]["data"]["segment_count"] == 0
    assert frames[-1]["event"] == "timeout"
    assert frames[-1]["data"]["code"] == "timeout"
    assert frames[-1]["data"]["segment_count"] == 0
    assert ": keep-alive" in text, "an idle stream must keep proxies awake"
    assert content_frames(frames) == []

    # Polling is a database read: no provider call, no run, no event, no segment.
    assert provider.calls == calls_before
    assert LLMRun.objects.count() == runs_before
    assert OutboxEvent.objects.count() == outbox_before
    assert TutorSegment.objects.filter(job=queued).count() == 0

    # Once the job settles for real, a reconnect sees the validated content.
    from apps.tutoring.tasks import run_tutor_job_now

    assert run_tutor_job_now(queued) == "succeeded"
    calls_after_run = provider.calls
    settled = parse_frames(open_stream(caller, project_a, queued.id, last_event_id=0))
    assert events(settled) == ["status", *["segment"] * (len(queued.result_blocks) - 1), "done"]
    assert [frame["id"] for frame in content_frames(settled)] == list(range(1, len(queued.result_blocks)))
    assert provider.calls == calls_after_run
