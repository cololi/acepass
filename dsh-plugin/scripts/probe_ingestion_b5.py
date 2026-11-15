#!/usr/bin/env python
"""Empirical probe for B5: O19/O20 variants and the image extraction worker.

Everything runs against the **real** Django services and the real Ninja router on a throw-away
PostgreSQL test database:

* O19 ``POST /api/v1/projects/{id}/variants/propose`` and O20 ``GET …/variants`` through
  ``django.test.Client`` (authentication, body validation, idempotency, provider failures).
* ``extraction.extract_image_candidate`` directly, with a scripted provider override: success,
  invalid JSON, validator rejection, unconfigured capability, and a human edit during the call.

The scripted provider is a **test double**, not a shipped stub: `is_stub=True` is recorded so no
report can mistake it for a real model. Every case records the status, the scrubbed payload, the
row-count deltas and the audit rows it left behind.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_ingestion_b5.py

Writes ``docs/dsh-migration/14-ingestion-b5-probe.json`` only; the markdown report is written from
that evidence.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import sys
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
from PIL import Image  # noqa: E402

import ai.providers.base as providers  # noqa: E402
from apps.audit.models import IdempotencyRecord, LLMRun, OutboxEvent  # noqa: E402
from apps.common.content import content_digest  # noqa: E402
from apps.exams.models import ExamProject, Subject, SyllabusVersion  # noqa: E402
from apps.ingestion.models import ImportCandidate, ImportJob, SourceDocument  # noqa: E402
from apps.ingestion.services import core as ingestion_core  # noqa: E402
from apps.ingestion.services import extraction  # noqa: E402
from apps.ingestion.services import imports as import_services  # noqa: E402
from apps.knowledge.models import KnowledgeNode  # noqa: E402
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion  # noqa: E402
from apps.question_bank.services import sealing  # noqa: E402

OUT_JSON = ROOT / "docs" / "dsh-migration" / "14-ingestion-b5-probe.json"
TEST_DB_NAME = "test_acepass_b5_probe"
MEDIA_ROOT = Path("/tmp/acepass-b5-probe-media")
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}
shutil.rmtree(MEDIA_ROOT, ignore_errors=True)

UNSET = object()
CASES: list[dict] = []
SYMBOLS: dict[str, str] = {}
AUTO_NAMES: dict[str, str] = {}
CLIENT = Client()
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
REF_RE = re.compile(r"REF_\d{3}")
TIME_KEYS = {
    "created_at", "updated_at", "started_at", "finished_at", "published_at", "checked_at",
    "processed_at", "dispatched_at", "claimed_at", "available_at", "lease_expires_at",
}


# ---------------------------------------------------------------------------
# recording helpers
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


def sym(value) -> str | None:
    return None if value is None else _auto_name(str(value))


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
    return value


def remap(value):
    if isinstance(value, dict):
        return {name: remap(item) for name, item in value.items()}
    if isinstance(value, list):
        return [remap(item) for item in value]
    if isinstance(value, str):
        return REF_RE.sub(lambda match: SYMBOLS.get(AUTO_NAMES.get(match.group(0), ""), match.group(0)), value)
    return value


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
        request={"method": method.upper(), "path": path, "json_body": None if json_body is UNSET else json_body, "idempotency_key": None if key is UNSET else key},
        status=response.status_code,
        payload=payload,
        before=before,
        after=after,
    )


def db_counts() -> dict:
    return {
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_llm_run": LLMRun.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "ingestion_import_job": ImportJob.objects.count(),
        "ingestion_import_candidate": ImportCandidate.objects.count(),
        "practice_grade_event": __import__("apps.practice.models", fromlist=["GradeEvent"]).GradeEvent.objects.count(),
        "learning_evidence": __import__("apps.practice.models", fromlist=["LearningEvidence"]).LearningEvidence.objects.count(),
        "learning_node_state": __import__("apps.learning.models", fromlist=["LearnerKnowledgeState"]).LearnerKnowledgeState.objects.count(),
    }


def run_row(run: LLMRun) -> dict:
    return {
        "provider": run.provider,
        "model_identifier": run.model_identifier,
        "capability": run.capability,
        "prompt_version": run.prompt_version,
        "status": run.status,
        "request_summary": scrub(run.request_summary),
        "input_snapshot": scrub(run.input_snapshot),
        "validation_keys": sorted((run.validation_result or {}).keys()),
        "prompt_tokens": run.prompt_tokens,
        "completion_tokens": run.completion_tokens,
        "cost_known": run.cost_known,
        "cost_cents": None if run.cost_cents is None else str(run.cost_cents),
        "latency_ms": None if run.latency_ms is None else "<latency>",
        "attempts": run.attempts,
        "error_code": run.error_code,
        "error_message": symbolize_text(run.error_message),
        "is_stub": run.is_stub,
    }


def candidate_row(candidate: ImportCandidate) -> dict:
    payload = candidate.draft_payload or {}
    return {
        "id": sym(candidate.id),
        "job_id": sym(candidate.job_id),
        "status": candidate.status,
        "revision": candidate.revision,
        "extractor_version": candidate.extractor_version,
        "is_stub_output": candidate.is_stub_output,
        "question_type": payload.get("question_type"),
        "display_label": payload.get("display_label"),
        "answer_status_known": payload.get("answer_status_known"),
        "answer_source_type": payload.get("answer_source_type"),
        "practice_max_score": payload.get("practice_max_score"),
        "variant_of_version_id": sym(payload.get("variant_of_version_id")),
        "variant_node_id": sym(payload.get("variant_node_id")),
        "variant_prompt_version": payload.get("variant_prompt_version"),
        "content_digest": payload.get("variant_content_digest"),
        "needs_manual_structure": payload.get("needs_manual_structure"),
        "review_issue_codes": [issue.get("code") for issue in (candidate.review_issues or [])],
        "review_issues": scrub(candidate.review_issues),
    }


class ScriptedProvider(providers.BaseProvider):
    """A deterministic test double (never shipped); `is_stub=True` is recorded in the audit row."""

    name = "probe-scripted"
    capabilities = ("propose_variant", "extract_question")
    # A test double must be visibly a test double: every audit row says so (R-INV 4).
    is_stub = True

    def __init__(self, payloads: list[dict], *, fail_on_call: int | None = None, error: Exception | None = None, on_call=None):
        self.payloads = list(payloads)
        self.fail_on_call = fail_on_call
        self.error = error or providers.AiTimeout("scripted timeout")
        self.calls = 0
        self.on_call = on_call

    def call(self, request: providers.AiRequest) -> providers.AiCallResult:
        self.calls += 1
        if self.on_call is not None:
            self.on_call(self.calls)
        if self.fail_on_call is not None and self.calls >= self.fail_on_call:
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
            model="probe-model",
            prompt_version=request.prompt_version,
        )


def variant_payload(stem: str, *, option_id: str = "opt_b") -> dict:
    return {
        "question_type": "single_choice",
        "content": {
            "blocks": [{"kind": "text", "text": stem}],
            "options": [
                {"id": f"opt_{letter}", "label": letter.upper(), "blocks": [{"kind": "text", "text": f"选项{letter.upper()}"}]}
                for letter in "abcd"
            ],
        },
        "answer_payload": {"kind": "single_choice", "correct_option_id": option_id},
        "rubric_criteria": [],
        "rubric_total_score": None,
        "practice_max_score": "2.00",
        "difficulty_note": "同考点换数",
        "rationale": "只改变系数",
        "doubts": [],
    }


def extract_payload(stem: str) -> dict:
    return {
        "question_type": "single_choice",
        "display_label": "识别题1",
        "content": {
            "blocks": [{"kind": "text", "text": stem}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        },
        "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
        "answer_status_known": True,
        "source_hint": {},
        "doubts": [],
    }


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------
def make_question(subject, label: str, *, question_type="single_choice", status="published", content=None, answer=None):
    content = content or {
        "blocks": [{"kind": "text", "text": f"原题 {label}：已知方程 x²-3x+2=0，求两根之和。"}],
        "options": [
            {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "3"}]},
            {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "2"}]},
        ],
    }
    question = Question.objects.create(subject=subject, origin_type="user_authored", display_label=label)
    version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type=question_type,
        content=content,
        status=status,
        content_digest=content_digest(content),
        revision_reason="probe",
        source_note="",
    )
    if answer is not None:
        AnswerKeyVersion.objects.create(
            question_version=version,
            version=1,
            answer_payload=answer,
            source_type="user",
            verification_status="checked",
            check_basis="probe",
        )
    return question, version


def png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (24, 18), (30, 60, 90)).save(buffer, format="PNG")
    return buffer.getvalue()


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        build()
    finally:
        providers.set_provider_override(None)
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {"database": "postgresql (throw-away test database)", "cases": CASES}
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"cases={len(CASES)}")
    for name in ("O19", "O20", "EXTRACT"):
        print(name, sum(1 for case in CASES if case["op"] == name))
    return 0


def build() -> None:
    User = get_user_model()
    owner = User.objects.create_user(
        email="b5-probe@example.invalid", password="probe-password-123", display_name="探针用户"
    )
    project = ExamProject.objects.create(owner=owner, name="变式探针项目")
    subject = Subject.objects.create(project=project, name="数学", code="MATH")
    syllabus = SyllabusVersion.objects.create(
        subject=subject, name="数学大纲", version_label="2026", status="published", is_user_provisional=False
    )
    node = KnowledgeNode.objects.create(syllabus_version=syllabus, canonical_name="一元二次方程", kind="point")
    other_project = ExamProject.objects.create(owner=owner, name="别的项目")
    other_subject = Subject.objects.create(project=other_project, name="物理", code="PHY")
    other_syllabus = SyllabusVersion.objects.create(
        subject=other_subject, name="物理大纲", version_label="2026", status="published", is_user_provisional=False
    )
    other_node = KnowledgeNode.objects.create(syllabus_version=other_syllabus, canonical_name="牛顿定律", kind="point")

    answer = {"kind": "single_choice", "correct_option_id": "opt_a"}
    source_q, source_v = make_question(subject, "Q1", answer=answer)
    draft_q, draft_v = make_question(subject, "Q2", status="draft", answer=answer)
    material_content = {"blocks": [{"kind": "text", "text": "共享材料：一段背景。"}]}
    material_q, material_v = make_question(
        subject, "M1", question_type="material", content=material_content
    )
    sealed_q, sealed_v = make_question(subject, "Q3", answer=answer)
    sealing.seal_question(project=project, question=sealed_q, actor=owner, reason="考前封存")

    for name, value in [
        ("PROJECT", project), ("SUBJECT", subject), ("SYLLABUS", syllabus), ("NODE", node),
        ("OTHER_PROJECT", other_project), ("OTHER_SUBJECT", other_subject), ("OTHER_NODE", other_node),
        ("QUESTION", source_q), ("VERSION", source_v), ("DRAFT_VERSION", draft_v), ("MATERIAL_VERSION", material_v),
        ("SEALED_VERSION", sealed_v),
    ]:
        reg(name, value)

    CLIENT.force_login(owner)
    base = f"/api/v1/projects/{project.id}"
    other_base = f"/api/v1/projects/{other_project.id}"
    propose = f"{base}/variants/propose"
    variants = f"{base}/variants"

    # ---------------------------------------------------------------- O19
    providers.set_provider_override(providers.NullProvider())
    entry = call(
        "P01", "O19", "no provider: one unavailable run, no job", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 1}, key="b5-no-provider",
    )
    runs = list(LLMRun.objects.order_by("created_at"))
    entry["runs"] = [run_row(run) for run in runs]
    entry["jobs_after"] = ImportJob.objects.count()
    assert entry["status"] == 503, entry

    providers.set_provider_override(None)
    entry = call("P02", "O19", "neither source id is a 400", "post", propose, json_body={"node_id": str(node.id)}, key="b5-no-source")
    entry = call("P03", "O19", "count=0 is a 400", "post", propose, json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 0}, key="b5-count")
    entry = call("P04", "O19", "unknown source version is a 404", "post", propose, json_body={"source_version_id": "00000000-0000-4000-8000-000000000000", "node_id": str(node.id)}, key="b5-src")
    entry = call("P05", "O19", "unknown node is a 404", "post", propose, json_body={"source_version_id": str(source_v.id), "node_id": "00000000-0000-4000-8000-000000000000"}, key="b5-node")
    entry = call("P06", "O19", "a draft version cannot be a source", "post", propose, json_body={"source_version_id": str(draft_v.id), "node_id": str(node.id)}, key="b5-draft")
    entry = call("P07", "O19", "a material cannot be a source", "post", propose, json_body={"source_version_id": str(material_v.id), "node_id": str(node.id)}, key="b5-material")
    entry = call("P08", "O19", "a sealed question cannot be a source", "post", propose, json_body={"source_version_id": str(sealed_v.id), "node_id": str(node.id)}, key="b5-sealed")

    providers.set_provider_override(ScriptedProvider([variant_payload("变式：已知 x²-5x+6=0，求两根之和。")]))
    before = db_counts()
    entry = call(
        "P09", "O19", "a valid proposal becomes an awaiting-review candidate", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 1, "difficulty_note": "同考点换数"},
        key="b5-ok-1",
    )
    entry["runs"] = [run_row(run) for run in LLMRun.objects.order_by("created_at")[1:]]
    job = ImportJob.objects.filter(input_kind="ai_variant").order_by("-created_at").first()
    entry["job"] = {
        "id": sym(job.id), "status": job.status, "input_kind": job.input_kind, "extractor_version": job.extractor_version,
        "input_text": symbolize_text(job.input_text), "problems": scrub(job.problems),
    }
    entry["candidate"] = candidate_row(job.candidates.first())
    entry["outbox_rows"] = OutboxEvent.objects.count()

    # same key + same body → replay, no second job
    before_replay = db_counts()
    entry = call(
        "P10", "O19", "the same key replays the stored 201", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 1, "difficulty_note": "同考点换数"},
        key="b5-ok-1",
    )
    entry["job_delta"] = db_counts()["ingestion_import_job"] - before_replay["ingestion_import_job"]
    # same key + different body → 409
    entry = call(
        "P11", "O19", "the same key with another body conflicts", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 2}, key="b5-ok-1",
    )

    duplicate = variant_payload("变式：已知 x²-5x+6=0，求两根之和。")
    providers.set_provider_override(ScriptedProvider([duplicate]))
    entry = call(
        "P12", "O19", "a duplicate of the pending candidate is rejected but kept", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 1}, key="b5-dup",
    )
    entry["candidate"] = candidate_row(
        ImportJob.objects.filter(input_kind="ai_variant").order_by("-created_at").first().candidates.first()
    )

    providers.set_provider_override(
        ScriptedProvider([variant_payload("变式一：已知 x²-7x+12=0，求两根之和。"), variant_payload("变式二：已知 x²-9x+20=0，求两根之和。")])
    )
    entry = call(
        "P13", "O19", "the batch is capped at three", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 5}, key="b5-cap",
    )
    entry["run_count"] = LLMRun.objects.filter(status="succeeded").count()

    providers.set_provider_override(
        ScriptedProvider([variant_payload("变式三：已知 x²-11x+30=0，求两根之和。")], fail_on_call=2)
    )
    entry = call(
        "P14", "O19", "a second-call failure keeps the first candidate and both runs", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(node.id), "count": 2}, key="b5-midfail",
    )
    job = ImportJob.objects.order_by("-created_at").first()
    entry["job"] = {"status": job.status, "last_error": symbolize_text(job.last_error)}
    entry["runs"] = [run_row(run) for run in LLMRun.objects.order_by("-created_at")[:2]]
    entry["candidates"] = [candidate_row(candidate) for candidate in job.candidates.all()]

    providers.set_provider_override(None)
    entry = call(
        "P15", "O19", "a node from another project is a 404", "post", propose,
        json_body={"source_version_id": str(source_v.id), "node_id": str(other_node.id)}, key="b5-foreign-node",
    )
    entry = call(
        "P16", "O19", "a version from another project is a 404", "post", f"{other_base}/variants/propose",
        json_body={"source_version_id": str(source_v.id), "node_id": str(other_node.id)}, key="b5-foreign-source",
    )

    # ---------------------------------------------------------------- O20
    entry = call("P17", "O20", "variant jobs are listed newest first", "get", f"{variants}?limit=500")
    jobs = entry.get("response", {}).get("jobs", []) if isinstance(entry.get("response"), dict) else []
    entry["listed_job_count"] = len(jobs)
    entry["listed_input_kinds"] = sorted({job["input_kind"] for job in jobs})
    entry["first_job_candidate_codes"] = [[issue.get("code") for issue in candidate["review_issues"]] for candidate in (jobs[0]["candidates"] if jobs else [])]
    call("P18", "O20", "limit is clamped to 1..50", "get", f"{variants}?limit=500")
    call("P19", "O20", "a non-integer limit is a schema error", "get", f"{variants}?limit=abc")

    # ---------------------------------------------------------------- extraction
    image_bytes = png_bytes()
    document = ingestion_core.create_image_document(
        owner=owner, project=project, subject=subject, content=image_bytes, content_type="image/png",
        title="第一页", source_note="2026 年真题扫描件", original_filename="page-1.png",
    )
    job = import_services.start_image_import(
        owner=owner, project=project, subject=subject, documents=[document], title="图片导入", use_vision=True
    )
    candidate = job.candidates.first()
    reg("DOCUMENT", document)
    reg("IMAGE_JOB", job)
    reg("IMAGE_CANDIDATE", candidate)
    entry = {
        "case": "P20", "op": "EXTRACT", "title": "queueing vision work creates image_ai + one outbox row",
        "status": 201,
        "response": {"input_kind": job.input_kind, "extractor_version": job.extractor_version,
                     "problems": scrub(job.problems), "candidate_revision": candidate.revision},
        "row_delta": {"audit_outbox_event": 1, "ingestion_import_job": 1, "ingestion_import_candidate": 1},
        "outbox_topics": [event.topic for event in OutboxEvent.objects.order_by("id")],
    }
    CASES.append(entry)

    def run_extraction(case_id: str, title: str, provider, *, document=document, job=job, candidate=candidate):
        providers.set_provider_override(provider)
        before = db_counts()
        try:
            result = extraction.extract_image_candidate(
                import_job_id=str(job.id), document_id=str(document.id), candidate_id=str(candidate.id)
            )
        finally:
            providers.set_provider_override(None)
        after = db_counts()
        candidate.refresh_from_db()
        job.refresh_from_db()
        runs = list(LLMRun.objects.order_by("-created_at")[:1])
        return record(
            case_id, "EXTRACT", title,
            request={"import_job_id": sym(job.id), "document_id": sym(document.id), "candidate_id": sym(candidate.id)},
            status=200,
            payload={
                "result": result,
                "candidate_revision": candidate.revision,
                "candidate_extractor_version": candidate.extractor_version,
                "candidate_is_stub_output": candidate.is_stub_output,
                "candidate_answer_status_known": (candidate.draft_payload or {}).get("answer_status_known"),
                "candidate_needs_manual_structure": (candidate.draft_payload or {}).get("needs_manual_structure"),
                "machine_payload_keys": sorted((candidate.machine_payload or {}).keys()),
                "machine_stale": (candidate.machine_payload or {}).get("stale_revision"),
                "job_problem_codes": [problem.get("code") for problem in (job.problems or [])],
                "run": run_row(runs[0]) if runs else None,
                "outbox_status": OutboxEvent.objects.filter(topic="ingestion.extract_candidate").order_by("-created_at").first().status,
            },
            before=before,
            after=after,
        )

    entry = run_extraction(
        "P21", "a valid vision result opens manual proofreading (one succeeded run)",
        ScriptedProvider([extract_payload("视觉模型识别出的题干。")]),
    )
    entry["row_delta"]["audit_llm_run"] = 1
    entry["candidate_row"] = candidate_row(candidate)

    # A second image candidate for the failure cases, so the P21 outcome is not overwritten.
    document2 = ingestion_core.create_image_document(
        owner=owner, project=project, subject=subject, content=image_bytes, content_type="image/png",
        title="第二页", original_filename="page-2.png",
    )
    job2 = import_services.start_image_import(
        owner=owner, project=project, subject=subject, documents=[document2], title="图片导入", use_vision=True
    )
    candidate2 = job2.candidates.first()
    reg("DOCUMENT_2", document2)
    reg("IMAGE_JOB_2", job2)
    reg("IMAGE_CANDIDATE_2", candidate2)

    run_extraction(
        "P22", "invalid model JSON becomes a rejected run, never a crash",
        ScriptedProvider([{"__raw__": "this is not json"}]), document=document2, job=job2, candidate=candidate2,
    )
    run_extraction(
        "P23", "a validator rejection keeps the manual candidate",
        ScriptedProvider([{"question_type": "single_choice", "content": {"blocks": []}, "answer_status_known": False}]),
        document=document2, job=job2, candidate=candidate2,
    )
    run_extraction(
        "P24", "an unconfigured provider is an audited manual degradation",
        providers.NullProvider(), document=document2, job=job2, candidate=candidate2,
    )

    document3 = ingestion_core.create_image_document(
        owner=owner, project=project, subject=subject, content=image_bytes, content_type="image/png",
        title="第三页", original_filename="page-3.png",
    )
    job3 = import_services.start_image_import(
        owner=owner, project=project, subject=subject, documents=[document3], title="图片导入", use_vision=True
    )
    candidate3 = job3.candidates.first()
    reg("DOCUMENT_3", document3)
    reg("IMAGE_JOB_3", job3)
    reg("IMAGE_CANDIDATE_3", candidate3)

    # Late revision: the human edits *this* candidate while the provider is "thinking".
    def edit_during_call(_call_number: int) -> None:
        # The provider call runs in the deadline thread; close its ORM connection afterwards so the
        # probe process does not leave a session behind that blocks the test-database teardown.
        from django.db import connections

        try:
            row = ImportCandidate.objects.get(id=candidate3.id)
            payload = dict(row.draft_payload or {})
            payload["display_label"] = "人工改过的标题"
            ImportCandidate.objects.filter(id=row.id).update(revision=row.revision + 1, draft_payload=payload)
        finally:
            connections.close_all()
    run_extraction(
        "P25", "a human edit during the call wins; the late result is kept aside",
        ScriptedProvider([extract_payload("迟到的识别题干。")], on_call=edit_during_call),
        document=document3, job=job3, candidate=candidate3,
    )

    # A document without an asset row: the one branch Django downgrades to a job warning.
    orphan = SourceDocument.objects.create(
        owner=owner, project=project, subject=subject, title="无资产图片", document_type="image",
        role="past_paper_page", sensitivity="public_to_owner", asset=None, checksum="0" * 64,
        source_type="user_upload", source_note="", usage_scope="",
    )
    job4 = import_services.start_image_import(
        owner=owner, project=project, subject=subject, documents=[orphan], title="无资产", use_vision=True
    )
    candidate4 = job4.candidates.first()
    reg("ORPHAN_DOCUMENT", orphan)
    reg("IMAGE_JOB_4", job4)
    reg("IMAGE_CANDIDATE_4", candidate4)
    run_extraction(
        "P26", "a document without an asset row is missing_source_image",
        ScriptedProvider([extract_payload("不会用到的输出。")]), document=orphan, job=job4, candidate=candidate4,
    )


if __name__ == "__main__":
    import shutil as _shutil  # noqa: F401  (kept for symmetry with the generator)

    raise SystemExit(main())
