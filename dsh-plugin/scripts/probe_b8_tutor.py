#!/usr/bin/env python
"""Empirical probe for B8: the AI read surface, tutoring, transcription and AI estimation.

Everything runs against the **real** Django services and the real Ninja router on a throw-away
PostgreSQL test database:

* ``GET  /api/v1/projects/{id}/ai-status`` and ``…/ai-runs`` through ``django.test.Client``;
* ``POST /projects/{id}/tutor-sessions`` / ``…/messages`` / ``GET …/tutor-jobs/{id}`` /
  ``…/segments`` and the SSE ``…/stream`` (chunks collected from the real generator);
* the practice AI surface: ``transcriptions`` (list/request/manual/confirm/reject),
  ``ai-estimate`` (gate then estimate), ``ai-diagnosis`` and the follow-up answer/skip routes.

Two provider configurations are exercised without any network:

* **none** — the shipped ``NullProvider`` (``ACEPASS_AI_PROVIDER=none``): every AI path must refuse
  with ``ai_not_configured`` and store only an audit row;
* a **scripted test double** (``is_stub=True``, recorded as such) for the success branches, so the
  wire shape of a validated explanation / estimate / diagnosis can be captured. It is a test double,
  not a shipped stub — R-INV 4 forbids a stub in the product.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_b8_tutor.py

Writes ``docs/dsh-migration/17-b8-tutor-probe.json`` only; the markdown report is written from that
evidence.
"""

from __future__ import annotations

import json
import os
import re
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import Client  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

import ai.providers.base as providers  # noqa: E402
from apps.audit.models import IdempotencyRecord, LLMRun, OutboxEvent  # noqa: E402
from apps.common.content import content_digest  # noqa: E402
from apps.exams.models import ExamProject, Subject  # noqa: E402
from apps.ingestion.models import Asset  # noqa: E402
from apps.practice.models import (  # noqa: E402
    AnswerTranscription,
    Attempt,
    DiagnosisFollowUp,
    ErrorDiagnosis,
    GradeEvent,
    PracticeSession,
    SessionItem,
)
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionVersion,
    RubricVersion,
)
from apps.tutoring.models import TutorJob, TutorSegment, TutorSession, TutorTurn  # noqa: E402

OUT_JSON = ROOT / "docs" / "dsh-migration" / "17-b8-tutor-probe.json"
TEST_DB_NAME = "test_acepass_b8_tutor"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

UNSET = object()
CASES: list[dict] = []
SYMBOLS: dict[str, str] = {}
AUTO_NAMES: dict[str, str] = {}
CLIENT = Client()
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
REF_RE = re.compile(r"REF_\d{3}")
TIME_KEYS = {
    "created_at",
    "updated_at",
    "submitted_at",
    "delivered_at",
    "finalized_at",
    "decided_at",
    "answered_at",
    "server_time",
}

# ---------------------------------------------------------------------------
# recording helpers (same scrubbing discipline as probe_ingestion_b5.py)
# ---------------------------------------------------------------------------


def _auto_name(value: str) -> str:
    name = SYMBOLS.get(value)
    if name is None:
        name = f"REF_{len(SYMBOLS):03d}"
        AUTO_NAMES[name] = value
        SYMBOLS[value] = name
    return name


def reg(name: str, value) -> str:
    text = str(getattr(value, "id", value))
    SYMBOLS[text] = name
    return text


def symbolize_text(text: str) -> str:
    return UUID_RE.sub(lambda match: _auto_name(match.group(0)), text)


def scrub(value, key: str | None = None):
    if isinstance(value, dict):
        return {name: scrub(item, name) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(item, key) for item in value]
    if isinstance(value, str):
        if key in TIME_KEYS:
            return "<now>"
        return symbolize_text(value)
    if isinstance(value, Decimal):
        return str(value)
    return value


def remap(value):
    if isinstance(value, dict):
        return {name: remap(item) for name, item in value.items()}
    if isinstance(value, list):
        return [remap(item) for item in value]
    if isinstance(value, str):
        return REF_RE.sub(lambda match: SYMBOLS.get(AUTO_NAMES.get(match.group(0), ""), match.group(0)), value)
    return value


def db_counts() -> dict:
    return {
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_llm_run": LLMRun.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "tutoring_session": TutorSession.objects.count(),
        "tutoring_job": TutorJob.objects.count(),
        "tutoring_segment": TutorSegment.objects.count(),
        "tutoring_turn": TutorTurn.objects.count(),
        "practice_answer_transcription": AnswerTranscription.objects.count(),
        "practice_error_diagnosis": ErrorDiagnosis.objects.count(),
        "practice_diagnosis_follow_up": DiagnosisFollowUp.objects.count(),
        "practice_grade_event": GradeEvent.objects.count(),
    }


def record(case_id: str, op: str, title: str, *, request: dict, status: int, payload, before: dict, after: dict) -> dict:
    entry = {
        "case": case_id,
        "op": op,
        "title": title,
        "request": scrub(request),
        "status": status,
        "response": scrub(payload),
        "row_delta": {name: after[name] - before[name] for name in before if after[name] != before[name]},
    }
    if isinstance(payload, dict) and "error" in payload:
        entry["error_envelope"] = scrub(payload["error"])
    CASES.append(entry)
    return entry


def call(case_id: str, op: str, title: str, method: str, path: str, *, json_body=UNSET, key=UNSET) -> dict:
    headers = {}
    if key is not UNSET:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    before = db_counts()
    if json_body is not UNSET:
        response = getattr(CLIENT, method)(
            path, data=json.dumps(json_body, ensure_ascii=False), content_type="application/json", **headers
        )
    else:
        response = getattr(CLIENT, method)(path, **headers)
    after = db_counts()
    payload = json.loads(response.content.decode("utf-8")) if response.content else None
    return record(
        case_id,
        op,
        title,
        request={
            "method": method.upper(),
            "path": path,
            "json_body": None if json_body is UNSET else json_body,
            "idempotency_key": None if key is UNSET else key,
        },
        status=response.status_code,
        payload=payload,
        before=before,
        after=after,
    )


def call_stream(case_id: str, op: str, title: str, path: str) -> dict:
    """The SSE endpoint, read chunk by chunk from the real generator."""
    before = db_counts()
    response = CLIENT.get(path)
    chunks = [chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk) for chunk in response.streaming_content]
    after = db_counts()
    text = "".join(chunks)
    events = re.findall(r"^event: (\w+)$", text, flags=re.MULTILINE)
    payloads = [json.loads(raw) for raw in re.findall(r"^data: (.*)$", text, flags=re.MULTILINE)]
    return record(
        case_id,
        op,
        title,
        request={"method": "GET", "path": path},
        status=response.status_code,
        payload={
            "content_type": response["Content-Type"],
            "cache_control": response.get("Cache-Control"),
            "events": events,
            "data": payloads,
            "raw_frame_count": text.count("\n\n"),
        },
        before=before,
        after=after,
    )


# ---------------------------------------------------------------------------
# scripted provider (test double: `is_stub=True` is recorded in every audit row)
# ---------------------------------------------------------------------------


class ScriptedProvider(providers.BaseProvider):
    name = "probe-scripted"
    is_stub = True
    capabilities = ("explain", "transcribe_handwriting", "estimate_grade", "diagnose")
    text_model = "probe-text-model"
    vision_model = "probe-vision-model"

    def __init__(self, payloads: list[dict], *, error: Exception | None = None):
        self.payloads = list(payloads)
        self.error = error
        self.calls = 0

    def call(self, request: providers.AiRequest) -> providers.AiCallResult:
        self.calls += 1
        if self.error is not None:
            raise self.error
        payload = self.payloads[min(self.calls - 1, len(self.payloads) - 1)]
        return providers.AiCallResult(
            payload=payload,
            raw_text=payload.get("__raw__", json.dumps(payload, ensure_ascii=False)),
            prompt_tokens=11,
            completion_tokens=22,
            cost_cents="0.0000",
            cost_known=True,
            attempts=1,
            latency_ms=3,
            is_stub=True,
            provider=self.name,
            model=self.vision_model if request.capability == "transcribe_handwriting" else self.text_model,
            prompt_version=request.prompt_version,
        )


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------
OWNER = None
OTHER = None
PROJECT = None
OTHER_PROJECT = None
SUBJECT = None
VERSION = None
ANSWER = None
RUBRIC = None
ASSET = None
SESSION = None
ITEM = None
ATTEMPT = None


def build() -> None:
    global OWNER, OTHER, PROJECT, OTHER_PROJECT, SUBJECT, VERSION, ANSWER, RUBRIC, ASSET, SESSION, ITEM, ATTEMPT
    User = get_user_model()
    OWNER = User.objects.create_user(
        email="b8-probe@example.invalid", password="probe-password-123", display_name="探针用户"
    )
    OTHER = User.objects.create_user(
        email="b8-other@example.invalid", password="probe-password-123", display_name="旁路用户"
    )
    PROJECT = ExamProject.objects.create(owner=OWNER, name="B8 辅导探针项目")
    OTHER_PROJECT = ExamProject.objects.create(owner=OWNER, name="B8 别的项目")
    SUBJECT = Subject.objects.create(project=PROJECT, name="数学", code="MATH")
    question = Question.objects.create(subject=SUBJECT, origin_type="user_authored", display_label="B8 大题")
    content = {"blocks": [{"kind": "text", "text": "计算 5 × 4，并写出过程。"}]}
    VERSION = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type="constructed_response",
        content=content,
        status="published",
        content_digest=content_digest(content),
        revision_reason="probe",
        source_note="",
    )
    ANSWER = AnswerKeyVersion.objects.create(
        question_version=VERSION,
        version=1,
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        source_type="user",
        verification_status="checked",
        check_basis="探针教材",
        explanation_blocks=[{"kind": "text", "text": "5 × 4 = 20。"}],
    )
    RUBRIC = RubricVersion.objects.create(
        answer_key_version=ANSWER,
        version=1,
        criteria=[
            {"criterion_id": "c1", "max_score": "1.00", "text": "列式正确"},
            {"criterion_id": "c2", "max_score": "1.00", "text": "结论与单位正确"},
        ],
        total_score=Decimal("2.00"),
        usage_note="探针评分标准",
    )
    ASSET = Asset.objects.create(
        owner=OWNER,
        project=PROJECT,
        subject=SUBJECT,
        role="user_attachment",
        sensitivity="public_to_owner",
        object_key="probe/b8/handwriting.png",
        original_filename="handwriting.png",
        content_type="image/png",
        size_bytes=128,
        checksum="a" * 64,
    )
    SESSION = PracticeSession.objects.create(user=OWNER, project=PROJECT, subject=SUBJECT, mode="practice")
    ITEM = SessionItem.objects.create(
        session=SESSION,
        ordinal=1,
        question_version=VERSION,
        answer_key_version=ANSWER,
        rubric_version=RUBRIC,
        mapping_revision=1,
        max_score=Decimal("2.00"),
        first_delivered_at="2026-05-01T00:00:00Z",
    )
    ATTEMPT = Attempt.objects.create(
        session_item=ITEM,
        user=OWNER,
        project=PROJECT,
        raw_answer={"type": "constructed_response", "text": "5 × 4 = 20。"},
        attachments=[str(ASSET.id)],
        submitted_at="2026-05-01T00:05:00Z",
        elapsed_ms=30_000,
    )
    reg("OWNER", OWNER)
    reg("OTHER", OTHER)
    reg("PROJECT", PROJECT)
    reg("OTHER_PROJECT", OTHER_PROJECT)
    reg("SUBJECT", SUBJECT)
    reg("QUESTION", question)
    reg("VERSION", VERSION)
    reg("ANSWER", ANSWER)
    reg("RUBRIC", RUBRIC)
    reg("ASSET", ASSET)
    reg("SESSION", SESSION)
    reg("ITEM", ITEM)
    reg("ATTEMPT", ATTEMPT)


def tutor_session(body=None, *, purpose: str = "explanation") -> TutorSession:
    return TutorSession.objects.create(
        user=OWNER,
        project=PROJECT,
        practice_session=SESSION,
        session_item=ITEM,
        attempt=ATTEMPT,
        purpose=purpose,
        question_version=VERSION,
        answer_key_version=ANSWER,
        rubric_version=RUBRIC,
        prompt_version="p0-explain-v1",
    )


def run_cases() -> None:
    # `config.settings.test` turns the demo stub on; the "no provider" half of this probe must run
    # against the shipped NullProvider, so it is pinned explicitly (R-INV 4: nothing is invented).
    providers.set_provider_override(providers.NullProvider())
    project = str(PROJECT.id)
    other_project = str(OTHER_PROJECT.id)
    item = str(ITEM.id)
    attempt = str(ATTEMPT.id)
    asset = str(ASSET.id)

    # ---------------------------------------------------------------- AI read surface
    call("A01", "AI_STATUS", "no provider: configured=false and the honest message", "get",
         f"/api/v1/projects/{project}/ai-status")
    call("A02", "AI_RUNS", "no runs yet: an empty list", "get", f"/api/v1/projects/{project}/ai-runs?limit=20")
    call("A03", "AI_STATUS", "another project of the same owner is still in scope", "get",
         f"/api/v1/projects/{other_project}/ai-status")
    call("A04", "AI_STATUS", "a foreign project id is a 404", "get",
         f"/api/v1/projects/{OTHER_PROJECT.id}/ai-status", key=UNSET)
    # a project the caller does not own
    CALLER_OTHER = ExamProject.objects.create(owner=OTHER, name="别人的项目")
    reg("FOREIGN_PROJECT", CALLER_OTHER)
    call("A05", "AI_STATUS", "a project owned by someone else is a 404", "get",
         f"/api/v1/projects/{CALLER_OTHER.id}/ai-status")

    # ---------------------------------------------------------------- tutoring: no provider
    call("T01", "TUTOR_SESSIONS", "open a tutoring thread for one item", "post",
         f"/api/v1/projects/{project}/tutor-sessions",
         json_body={"session_item_id": item, "purpose": "explanation"}, key="probe-tutor-session-1")
    session = TutorSession.objects.filter(user=OWNER).order_by("-created_at").first()
    reg("TUTOR_SESSION_1", session)
    call("T02", "TUTOR_SESSIONS", "the same key replays the stored response", "post",
         f"/api/v1/projects/{project}/tutor-sessions",
         json_body={"session_item_id": item, "purpose": "explanation"}, key="probe-tutor-session-1")
    call("T03", "TUTOR_SESSIONS", "a different body with the same key is a conflict", "post",
         f"/api/v1/projects/{project}/tutor-sessions",
         json_body={"session_item_id": item, "purpose": "hint"}, key="probe-tutor-session-1")
    call("T04", "TUTOR_SESSIONS", "no Idempotency-Key at all", "post",
         f"/api/v1/projects/{project}/tutor-sessions", json_body={"session_item_id": item}, key=UNSET)
    call("T05", "TUTOR_SESSIONS", "an item outside the project is a 404", "post",
         f"/api/v1/projects/{other_project}/tutor-sessions", json_body={"session_item_id": item})

    call("T06", "TUTOR_MESSAGES", "no provider: 201 with an unavailable job and ai_not_configured", "post",
         f"/api/v1/projects/{project}/tutor-sessions/{session.id}/messages",
         json_body={"user_question": "请针对我的作答讲解。"}, key="probe-tutor-message-1")
    job = TutorJob.objects.filter(tutor_session=session).order_by("-created_at").first()
    reg("TUTOR_JOB_UNAVAILABLE", job)
    call("T07", "TUTOR_MESSAGES", "a replay returns the same job", "post",
         f"/api/v1/projects/{project}/tutor-sessions/{session.id}/messages",
         json_body={"user_question": "请针对我的作答讲解。"}, key="probe-tutor-message-1")
    call("T08", "TUTOR_JOBS", "the job read answers the same state", "get",
         f"/api/v1/projects/{project}/tutor-jobs/{job.id}")
    call("T09", "TUTOR_SEGMENTS", "an unavailable job has an empty transcript", "get",
         f"/api/v1/projects/{project}/tutor-jobs/{job.id}/segments")
    call_stream("T10", "TUTOR_STREAM", "the SSE for an unavailable job: no segment is invented",
                f"/api/v1/projects/{project}/tutor-jobs/{job.id}/stream")
    call("T11", "TUTOR_JOBS", "a job outside the project is a 404", "get",
         f"/api/v1/projects/{other_project}/tutor-jobs/{job.id}")

    # ---------------------------------------------------------------- practice AI: the gate
    call("P01", "TRANSCRIPTIONS", "the photo still blocks grading", "get",
         f"/api/v1/projects/{project}/attempts/{attempt}/transcriptions")
    call("P02", "AI_ESTIMATE", "estimation is refused before any provider call", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-estimate", key="probe-estimate-gate")
    call("P03", "AI_DIAGNOSIS", "diagnosis is refused by the same gate", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-diagnosis",
         json_body={"learner_note": ""}, key="probe-diagnosis-gate")
    call("P04", "TRANSCRIPTIONS", "no vision model: an explicit 503", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/transcriptions",
         json_body={"asset_id": asset}, key="probe-transcribe-novision")
    call("P05", "TRANSCRIPTIONS", "a foreign asset id is a 400", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/transcriptions",
         json_body={"asset_id": "00000000-0000-0000-0000-000000000000", "text": "任意"},
         key="probe-transcribe-foreign-asset")
    call("P06", "TRANSCRIPTIONS", "the manual path records what the learner wrote", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/transcriptions",
         json_body={"asset_id": asset, "text": "我写的是：5 × 4 = 20，所以共有 20 个。"},
         key="probe-transcribe-manual")
    transcription = AnswerTranscription.objects.filter(attempt=ATTEMPT).first()
    reg("TRANSCRIPTION_MANUAL", transcription)
    call("P07", "TRANSCRIPTIONS", "the gate is open now", "get",
         f"/api/v1/projects/{project}/attempts/{attempt}/transcriptions")
    call("P08", "AI_ESTIMATE", "no provider: the estimate is an explicit 503, no event", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-estimate", key="probe-estimate-nomodel")
    call("P09", "AI_ESTIMATE", "the estimate state is an explicit empty state", "get",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-estimate")
    call("P10", "AI_DIAGNOSIS", "no provider: the diagnosis is an explicit 503", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-diagnosis",
         json_body={"learner_note": "我直接写了答案。"}, key="probe-diagnosis-nomodel")

    # ---------------------------------------------------------------- scripted provider
    providers.set_provider_override(
        ScriptedProvider(
            [
                {
                    "key_conditions": ["先列式"],
                    "stuck_points": ["没有写单位"],
                    "explanation_blocks": [
                        {"kind": "text", "text": "5 × 4 = 20，所以共有 20 个。"},
                        {"kind": "math", "latex": "5 \\times 4 = 20"},
                    ],
                    "method_summary": "先列式再计算",
                    "suggested_next": ["再做一道同类题"],
                    "missing_information": [],
                    "citations": [f"question_version:{VERSION.id}"],
                }
            ]
        )
    )
    call("T12", "TUTOR_MESSAGES", "a validated explanation is stored and delivered", "post",
         f"/api/v1/projects/{project}/tutor-sessions/{session.id}/messages",
         json_body={"user_question": "请讲解。"}, key="probe-tutor-message-2")
    success_job = TutorJob.objects.filter(tutor_session=session).order_by("-created_at").first()
    reg("TUTOR_JOB_SUCCEEDED", success_job)
    call("T13", "TUTOR_SEGMENTS", "the transcript mirrors the validated blocks", "get",
         f"/api/v1/projects/{project}/tutor-jobs/{success_job.id}/segments")
    call_stream("T14", "TUTOR_STREAM", "the SSE replays the validated segments",
                f"/api/v1/projects/{project}/tutor-jobs/{success_job.id}/stream")
    call_stream("T15", "TUTOR_STREAM", "a reconnect with after=1 resumes after that index",
                f"/api/v1/projects/{project}/tutor-jobs/{success_job.id}/stream?after=1")

    providers.set_provider_override(
        ScriptedProvider(
            [
                {
                    "criteria": [
                        {"criterion_id": "c1", "estimated_score": "1.00", "rationale": "列式正确", "missing_evidence": []},
                        {"criterion_id": "c2", "estimated_score": "0.50", "rationale": "结论不完整", "missing_evidence": ["缺少单位"]},
                    ],
                    "overall_note": "参考估计：结论不完整",
                    "confidence": 0.6,
                }
            ]
        )
    )
    call("P11", "AI_ESTIMATE", "a validated estimate is stored inert", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-estimate", key="probe-estimate-ok")
    call("P12", "AI_ESTIMATE", "the estimate state exposes the latest one", "get",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-estimate")

    providers.set_provider_override(
        ScriptedProvider(
            [
                {
                    "causes": [
                        {"error_type": "incomplete_reasoning", "confidence": 0.5, "evidence": ["只写了第一步"]}
                    ],
                    "follow_up_questions": [
                        {"question": "你当时为什么停在第一步？", "why": "确认推理是否中断", "evidence_kind": "process"}
                    ],
                    "missing_information": ["草稿过程"],
                }
            ]
        )
    )
    call("P13", "AI_DIAGNOSIS", "a validated diagnosis stores candidates and a follow-up", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/ai-diagnosis",
         json_body={"learner_note": "我当时先算乘法。"}, key="probe-diagnosis-ok")
    follow_up = DiagnosisFollowUp.objects.filter(attempt=ATTEMPT).first()
    reg("FOLLOW_UP", follow_up)
    call("P14", "DIAGNOSIS_FOLLOW_UP", "answering the follow-up records process evidence", "post",
         f"/api/v1/projects/{project}/diagnosis-follow-ups/{follow_up.id}/answer",
         json_body={"text": "因为我以为只要写算式。"}, key="probe-follow-up-answer")
    call("P15", "DIAGNOSIS_FOLLOW_UP", "a second answer is refused", "post",
         f"/api/v1/projects/{project}/diagnosis-follow-ups/{follow_up.id}/answer",
         json_body={"text": "再答一次"}, key="probe-follow-up-answer-2")
    call("P16", "DIAGNOSIS_FOLLOW_UP", "a settled follow-up cannot be skipped", "post",
         f"/api/v1/projects/{project}/diagnosis-follow-ups/{follow_up.id}/skip", key="probe-follow-up-skip")
    second_session = tutor_session(purpose="explanation")
    reg("TUTOR_SESSION_2", second_session)
    call("P17", "DIAGNOSIS_HUMAN", "the human decision route appends a cause", "post",
         f"/api/v1/projects/{project}/attempts/{attempt}/diagnosis",
         json_body={"error_type": "concept_gap", "status": "confirmed", "note": "概念没掌握"},
         key="probe-diagnosis-human")

    providers.set_provider_override(None)

    # ---------------------------------------------------------------- ai-runs after activity
    call("A06", "AI_RUNS", "the run rows of every capability, newest first", "get",
         f"/api/v1/projects/{project}/ai-runs?limit=50")

    # ---------------------------------------------------------------- the tutoring gate
    # The session is finished: every tutoring entry point must refuse with 403.
    fresh = tutor_session()
    reg("TUTOR_SESSION_3", fresh)
    PracticeSession.objects.filter(id=SESSION.id).update(status="finished")
    SESSION.refresh_from_db()
    call("G01", "TUTOR_SESSIONS", "a finished session refuses tutoring", "post",
         f"/api/v1/projects/{project}/tutor-sessions", json_body={"session_item_id": item},
         key="probe-gate-finished")
    PracticeSession.objects.filter(id=SESSION.id).update(status="active", mode="verification")
    SESSION.refresh_from_db()
    call("G02", "TUTOR_SESSIONS", "a verification session refuses tutoring", "post",
         f"/api/v1/projects/{project}/tutor-sessions", json_body={"session_item_id": item},
         key="probe-gate-verification")
    PracticeSession.objects.filter(id=SESSION.id).update(mode="practice")
    SESSION.refresh_from_db()
    call("G03", "TUTOR_SESSIONS", "an invalid purpose is a 400", "post",
         f"/api/v1/projects/{project}/tutor-sessions",
         json_body={"session_item_id": item, "purpose": "chat"}, key="probe-gate-purpose")
    ITEM.tutoring_allowed = False
    ITEM.save(update_fields=["tutoring_allowed", "updated_at"])
    call("G04", "TUTOR_SESSIONS", "an item planned without tutoring is refused", "post",
         f"/api/v1/projects/{project}/tutor-sessions", json_body={"session_item_id": item},
         key="probe-gate-not-allowed")
    ITEM.tutoring_allowed = True
    ITEM.save(update_fields=["tutoring_allowed", "updated_at"])

    call("G05", "AI_ESTIMATE", "a foreign project cannot read the estimate", "get",
         f"/api/v1/projects/{other_project}/attempts/{attempt}/ai-estimate")


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        build()
        CLIENT.force_login(OWNER)
        run_cases()
    finally:
        providers.set_provider_override(None)
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {
        "generated_by": "dsh-plugin/scripts/probe_b8_tutor.py",
        "schema_version": 1,
        "environment": {
            "database": "postgresql (throw-away test database)",
            "django_settings": "config.settings.test",
            "routes": "real Ninja router via django.test.Client",
            "providers": (
                "none = the shipped NullProvider; scripted = an in-process test double with "
                "is_stub=True (never shipped, R-INV 4)"
            ),
        },
        "cases": normalize(remap(CASES)),
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"cases={len(CASES)}")
    ops: dict[str, int] = {}
    for case in CASES:
        ops[case["op"]] = ops.get(case["op"], 0) + 1
    for name in sorted(ops):
        print(f"  {name}: {ops[name]}")
    return 0


def normalize(value):
    return value


if __name__ == "__main__":
    raise SystemExit(main())
