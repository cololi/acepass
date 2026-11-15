#!/usr/bin/env python
"""Empirical HTTP probe for the B1 ingestion operation set (O03/O04/O07/O10-O17).

Oracle: the real Django ingestion API driven through ``django.test.Client`` against
a throw-away PostgreSQL database.  Nothing in this script asserts what the API
*should* do: every case records the request it sent, the status code, the raw
JSON that came back, and (where it matters) the rows the call left behind.  The
same observations are written to ``docs/dsh-migration/09-ingestion-b1-probe.json``
so the Node port can compare against exact values instead of guesses.

Setup mirrors ``scripts/gen_evidence_golden.py``:
``setup_test_environment()`` + ``connection.creation.create_test_db(...)`` in a
try/finally with ``destroy_test_db(...)``.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_ingestion_b1.py

The script is read-only with respect to the repository's source: it only writes
the JSON evidence file under ``docs/dsh-migration/`` (the markdown report is
written by hand from that evidence).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import Client  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from django.utils import timezone as dj_timezone  # noqa: E402

from apps.audit.models import ContentRevision, IdempotencyRecord, OutboxEvent  # noqa: E402
from apps.exams import services as exams_services  # noqa: E402
from apps.exams.models import ExamProject, Subject  # noqa: E402
from apps.ingestion.models import (  # noqa: E402
    CandidateRevision,
    ImportCandidate,
    ImportJob,
    SourceDocument,
    SourceRegion,
)
from apps.ingestion.services import core as ingestion_core  # noqa: E402
from apps.ingestion.services import imports as import_services  # noqa: E402
from apps.ingestion.services import text_parser  # noqa: E402
from apps.practice.models import ExposureEvent  # noqa: E402
from apps.question_bank.models import Question, QuestionVersion  # noqa: E402

OUT_JSON = ROOT / "docs" / "dsh-migration" / "09-ingestion-b1-probe.json"

BASE = datetime(2026, 2, 1, 0, 0, tzinfo=timezone.utc)

UNSET = object()
CASES: list[dict] = []
SYMBOLS: dict[str, str] = {}
CLIENT = Client()


# ---------------------------------------------------------------------------
# Recording helpers
# ---------------------------------------------------------------------------
def reg(name: str, value) -> str:
    """Remember ``id -> symbolic name`` so the report never depends on a UUID."""
    text = str(getattr(value, "id", value))
    SYMBOLS[text] = name
    return text


def _key_repr(key) -> object:
    if key is UNSET:
        return None
    if len(key) > 30:
        return {"length": len(key), "prefix": key[:8]}
    return key


def _shrink(payload):
    """Large list responses are recorded as count plus first/last element."""
    if isinstance(payload, list) and len(payload) > 6:
        return {
            "_summary": "list",
            "_count": len(payload),
            "_first": payload[0] if payload else None,
            "_last": payload[-1] if payload else None,
        }
    return payload


def call(
    case_id: str,
    op: str,
    title: str,
    method: str,
    path: str,
    *,
    query: dict | None = None,
    body: object = None,
    key=UNSET,
    kind: str = "case",
    summarize: bool = False,
) -> dict:
    """Send one request and record exactly what happened."""
    url = f"{path}?{urlencode(query, doseq=True)}" if query else path
    headers: dict[str, str] = {}
    if key is not UNSET:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    data = json.dumps(body, ensure_ascii=False) if body is not None else None
    if data is not None:
        headers["content_type"] = "application/json"
    method_fn = getattr(CLIENT, method.lower())
    response = method_fn(url, data=data, **headers) if data is not None else method_fn(url, **headers)

    raw = response.content.decode("utf-8", "replace")
    try:
        payload = response.json()
    except Exception:  # pragma: no cover - every endpoint here returns JSON
        payload = None

    record = {
        "case": case_id,
        "op": op,
        "kind": kind,
        "title": title,
        "request": {
            "method": method.upper(),
            "path": path,
            "query": query or {},
            "body": body,
            "idempotency_key": _key_repr(key),
        },
        "status": response.status_code,
        "response": _shrink(payload) if summarize else payload,
        "response_field_order": list(payload) if isinstance(payload, dict) else None,
        "checks": {},
    }
    if payload is None:
        record["response_raw"] = raw[:500]
    if isinstance(payload, dict) and "error" in payload:
        record["error_envelope"] = payload["error"]
    CASES.append(record)
    return record


def checks(record: dict, **values) -> dict:
    record["checks"].update(values)
    return record


def error_shape(payload) -> dict:
    """Describe the envelope/error item shape without inventing fields."""
    if not isinstance(payload, dict) or "error" not in payload:
        return {"json": payload}
    error = payload["error"]
    details = error.get("details") or {}
    errors = details.get("errors")
    item_keys: list[str] = []
    if isinstance(errors, list):
        for item in errors:
            if isinstance(item, dict):
                item_keys.extend(item.keys())
    return {
        "error_keys": sorted(error.keys()),
        "request_id_present": "request_id" in error,
        "details_keys": sorted(details.keys()) if isinstance(details, dict) else None,
        "error_item_keys": sorted(set(item_keys)) if item_keys else None,
        "errors": errors,
    }


def db_counts() -> dict:
    return {
        "ingestion_source_document": SourceDocument.objects.count(),
        "ingestion_source_region": SourceRegion.objects.count(),
        "ingestion_import_job": ImportJob.objects.count(),
        "ingestion_import_candidate": ImportCandidate.objects.count(),
        "ingestion_candidate_revision": CandidateRevision.objects.count(),
        "audit_content_revision": ContentRevision.objects.count(),
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "practice_exposure_event": ExposureEvent.objects.count(),
        "question_bank_question": Question.objects.count(),
        "question_bank_question_version": QuestionVersion.objects.count(),
    }


def delta(before: dict, after: dict) -> dict:
    return {name: after[name] - before[name] for name in before if after[name] != before[name]}


def iso(value) -> str | None:
    return value.isoformat() if value is not None else None


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Fixtures (created through the real services / ORM; HTTP cases stay real)
# ---------------------------------------------------------------------------
def valid_payload(label: str) -> dict:
    return {
        "question_type": "single_choice",
        "display_label": "",
        "content": {
            "blocks": [{"kind": "text", "text": f"{label}的题干"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        },
        "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
        "answer_status_known": True,
        "explanation_blocks": [],
        "practice_max_score": None,
        "source_excerpt": f"{label}的题干",
        "parse_issues": [],
        "structure_signals": ["stem", "options", "answer"],
    }


def make_candidate(
    owner,
    project: ExamProject,
    subject: Subject,
    document: SourceDocument,
    label: str,
    *,
    forced_status: str | None = None,
) -> tuple[ImportJob, ImportCandidate, SourceRegion]:
    """A candidate fixture with real issues/region, built directly from rows.

    O14-O17 need controlled states (published link, ignored, revision) that no
    public HTTP operation can create before O18 exists.  The HTTP calls under
    test are still the real routes; only the starting state is persisted here.
    """
    job = ImportJob.objects.create(
        project=project,
        subject=subject,
        created_by=owner,
        status="awaiting_review",
        input_kind="text",
        input_text=f"fixture:{label}",
        extractor_version="text-structure-v1",
        input_fingerprint=hashlib.sha256(f"fixture:{label}".encode("utf-8")).hexdigest(),
    )
    payload = valid_payload(label)
    candidate = ImportCandidate.objects.create(
        job=job,
        project=project,
        subject=subject,
        status="draft",
        draft_payload=payload,
        machine_payload=payload,
        revision=1,
        extractor_version="text-structure-v1",
    )
    region = SourceRegion.objects.create(
        document=document,
        page_index=1,
        x=0.0,
        y=0.0,
        width=1.0,
        height=0.05,
        role="stem_crop",
        text_span=f"{label}的题干",
    )
    candidate.source_regions.add(region)
    ingestion_core.refresh_candidate_issues(candidate)
    candidate.refresh_from_db()
    if forced_status is not None:
        candidate.status = forced_status
        candidate.save(update_fields=["status", "updated_at"])
    return job, candidate, region


def make_import_job(
    owner,
    project: ExamProject,
    *,
    subject: Subject | None = None,
    label: str = "job",
    created_by=None,
    status: str = "awaiting_review",
) -> ImportJob:
    return ImportJob.objects.create(
        project=project,
        subject=subject,
        created_by=created_by or owner,
        status=status,
        input_kind="text",
        input_text=f"fixture:{label}",
        extractor_version="text-structure-v1",
        input_fingerprint=hashlib.sha256(f"fixture:{label}".encode("utf-8")).hexdigest(),
    )


# ---------------------------------------------------------------------------
# Probe body
# ---------------------------------------------------------------------------
LABELLED_TWO = (
    "【题型】单选题\n【题干】第一题题干内容？\n【选项】\nA. 甲\nB. 乙\nC. 丙\nD. 丁\n"
    "【答案】A\n【解析】第一题解析\n"
    "【题型】单选题\n【题干】第二题题干内容？\n【选项】\nA. 甲\nB. 乙\nC. 丙\nD. 丁\n"
    "【答案】B\n【解析】第二题解析"
)
LABELLED_ONE = "【题型】单选题\n【题干】默认字段题干？\n【选项】\nA. 甲\nB. 乙\n【答案】A\n"
NUMBERED_ONE = "1. 第1题 这是题干内容1，选项A 选项B 选项C 选项D"
PATHOLOGICAL_TEXT = "\n".join(f"{i}. 第{i}题 这是题干内容{i}，选项A 选项B 选项C 选项D" for i in range(1, 22))


def build() -> dict:
    notes: list[str] = []
    unobserved: list[str] = []

    # ---------------------------------------------------------------- fixtures
    user_model = get_user_model()
    owner = user_model.objects.create_user(
        email="b1-probe-owner@example.test", password="ProbePass!2026", display_name="B1 探针"
    )
    other = user_model.objects.create_user(
        email="b1-probe-other@example.test", password="ProbePass!2026", display_name="另一位"
    )
    project_a = exams_services.create_project(owner, name="B1 探针项目A")
    project_b = exams_services.create_project(other, name="B1 探针项目B")
    project_c = exams_services.create_project(owner, name="B1 探针项目C·列表夹具")
    project_e = exams_services.create_project(owner, name="B1 探针项目E·空列表")
    subject_a1 = exams_services.create_subject(project_a, name="科目A1", total_score="100", pass_score="60")
    subject_a2 = exams_services.create_subject(project_a, name="科目A2", total_score="100", pass_score="60")
    subject_b1 = exams_services.create_subject(project_b, name="科目B1", total_score="100", pass_score="60")
    subject_c1 = exams_services.create_subject(project_c, name="科目C1", total_score="100", pass_score="60")

    for name, value in {
        "USER_OWNER": owner,
        "USER_OTHER": other,
        "PROJECT_A": project_a,
        "PROJECT_B": project_b,
        "PROJECT_C": project_c,
        "PROJECT_E": project_e,
        "SUBJECT_A1": subject_a1,
        "SUBJECT_A2": subject_a2,
        "SUBJECT_B1": subject_b1,
        "SUBJECT_C1": subject_c1,
    }.items():
        reg(name, value)

    CLIENT.force_login(owner)
    p_a = f"/api/v1/projects/{project_a.id}"
    p_b = f"/api/v1/projects/{project_b.id}"
    p_c = f"/api/v1/projects/{project_c.id}"
    p_e = f"/api/v1/projects/{project_e.id}"

    # Published question/version used by the O14/O15 editorial-preview cases.
    question = Question.objects.create(
        subject=subject_a1,
        origin_type="user_authored",
        is_demo=False,
        display_label="B1 探针已发布题",
    )
    published_version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type="single_choice",
        content={"blocks": [{"kind": "text", "text": "已发布题干"}],
                 "options": [{"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                             {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]}]},
        status="published",
        published_at=dj_timezone.now(),
        practice_max_score=None,
    )
    question.current_published_version = published_version
    question.save(update_fields=["current_published_version", "updated_at"])
    reg("QUESTION_PUBLISHED", question)
    reg("VERSION_PUBLISHED", published_version)

    fixture_document = SourceDocument.objects.create(
        # Owned by the other user on purpose: O03/O10/O13 are owner-scoped, and a
        # second owner row in project A would pollute the ordering/clamp cases.
        owner=other,
        project=project_a,
        subject=subject_a1,
        title="候选夹具来源文档",
        document_type="text",
        role="past_paper_page",
        sensitivity="public_to_owner",
        raw_text="候选夹具来源原文",
        checksum=sha256_text("候选夹具来源原文"),
        source_type="user_paste",
        page_count=1,
    )
    reg("DOC_FIXTURE", fixture_document)

    # 101 documents / jobs / candidates for observing the 1..100 list clamps.
    bulk_docs = [
        SourceDocument(
            owner=owner,
            project=project_c,
            title=f"C-DOC-{index:03d}",
            document_type="text",
            role="past_paper_page",
            sensitivity="public_to_owner",
            raw_text=f"项目C文档{index}",
            checksum=sha256_text(f"项目C文档{index}"),
            source_type="user_paste",
            page_count=1,
        )
        for index in range(1, 102)
    ]
    SourceDocument.objects.bulk_create(bulk_docs)
    bulk_jobs = [
        ImportJob(
            project=project_c,
            created_by=owner,
            status="awaiting_review",
            input_kind="text",
            input_text=f"项目C任务{index}",
            extractor_version="text-structure-v1",
            input_fingerprint=hashlib.sha256(f"项目C任务{index}".encode("utf-8")).hexdigest(),
        )
        for index in range(1, 102)
    ]
    ImportJob.objects.bulk_create(bulk_jobs)
    ImportCandidate.objects.bulk_create(
        [
            ImportCandidate(
                job=bulk_jobs[0],
                project=project_c,
                status="draft",
                revision=1,
                draft_payload={},
                machine_payload={},
                extractor_version="text-structure-v1",
            )
            for _ in range(101)
        ]
    )

    # ---------------------------------------------------------------- O04
    rec = call(
        "O04-01",
        "O04",
        "空白文本创建来源文档",
        "post",
        f"{p_a}/source-documents/text",
        body={"text": "   \n\t  "},
    )
    checks(rec, db=db_counts())

    long_text = "L" * 450
    rec = call(
        "O04-02",
        "O04",
        "长标题/来源说明/使用范围截断 + 未知字段",
        "post",
        f"{p_c}/source-documents/text",
        body={
            "text": long_text,
            "subject_id": str(subject_c1.id),
            "title": "T" * 301,
            "source_note": "N" * 501,
            "usage_scope": "U" * 201,
            "raw_text": "不应被采用的原文",
            "checksum": "deadbeef",
            "document_type": "pdf",
            "role": "answer_page",
            "sensitivity": "contains_answers",
            "source_type": "user_upload",
            "parse": False,
        },
    )
    doc_long = SourceDocument.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if doc_long is not None:
        checks(
            rec,
            db={
                "title_len": len(doc_long.title),
                "source_note_len": len(doc_long.source_note),
                "usage_scope_len": len(doc_long.usage_scope),
                "raw_text_len": len(doc_long.raw_text),
                "raw_text_preview_len": len(rec["response"]["raw_text_preview"]),
                "raw_text_equals_request": doc_long.raw_text == long_text,
                "checksum_matches_sha256": doc_long.checksum == sha256_text(long_text),
                "document_type": doc_long.document_type,
                "role": doc_long.role,
                "sensitivity": doc_long.sensitivity,
                "source_type": doc_long.source_type,
                "asset_id": str(doc_long.asset_id) if doc_long.asset_id else None,
                "page_count": doc_long.page_count,
                "page_texts": doc_long.page_texts,
                "subject_id": str(doc_long.subject_id),
            },
        )
    reg("DOC_C_LONG", doc_long.id if doc_long else "missing")

    rec = call(
        "O04-03",
        "O04",
        "最小请求的默认值",
        "post",
        f"{p_a}/source-documents/text",
        body={"text": "无科目文档正文"},
    )
    doc_none = SourceDocument.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if doc_none is not None:
        reg("DOC_NONE", doc_none.id)
        checks(
            rec,
            row={
                "title": doc_none.title,
                "source_note": doc_none.source_note,
                "usage_scope": doc_none.usage_scope,
                "subject_id": str(doc_none.subject_id) if doc_none.subject_id else None,
                "raw_text": doc_none.raw_text,
                "checksum_matches": doc_none.checksum == sha256_text("无科目文档正文"),
                "document_type": doc_none.document_type,
                "role": doc_none.role,
                "sensitivity": doc_none.sensitivity,
                "source_type": doc_none.source_type,
            },
        )

    rec = call(
        "O04-04",
        "O04",
        "带科目A1的来源文档",
        "post",
        f"{p_a}/source-documents/text",
        body={"text": "科目A1文档正文", "subject_id": str(subject_a1.id), "title": "DOC-A1"},
    )
    doc_a1 = SourceDocument.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if doc_a1 is not None:
        reg("DOC_A1", doc_a1.id)

    rec = call(
        "O04-05",
        "O04",
        "带科目A2的来源文档",
        "post",
        f"{p_a}/source-documents/text",
        body={"text": "科目A2文档正文", "subject_id": str(subject_a2.id), "title": "DOC-A2"},
    )
    doc_a2 = SourceDocument.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if doc_a2 is not None:
        reg("DOC_A2", doc_a2.id)

    rec = call(
        "O04-06",
        "O04",
        "跨项目科目",
        "post",
        f"{p_a}/source-documents/text",
        body={"text": "跨项目科目正文", "subject_id": str(subject_b1.id)},
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O04-07",
        "O04",
        "外部项目路径",
        "post",
        f"{p_b}/source-documents/text",
        body={"text": "外部项目正文"},
    )
    checks(rec, error=error_shape(rec["response"]))

    # Fixed creation times so O03 ordering is observed, not inferred.
    if doc_a1 and doc_a2 and doc_none:
        SourceDocument.objects.filter(id=doc_a1.id).update(created_at=BASE + timedelta(minutes=1))
        SourceDocument.objects.filter(id=doc_a2.id).update(created_at=BASE + timedelta(minutes=2))
        SourceDocument.objects.filter(id=doc_none.id).update(created_at=BASE + timedelta(minutes=3))
        doc_a1.refresh_from_db()
        doc_a2.refresh_from_db()
        doc_none.refresh_from_db()
        notes.append(
            "O03/O10/O13 的 created_at 顺序用例先通过 ORM 写入固定时间戳（2026-02-01T00:01/00:02/00:03Z），"
            "以便把“desc/asc”观察成可复现的标题顺序。"
        )

    # ---------------------------------------------------------------- O03
    rec = call("O03-01", "O03", "空列表（独立项目E）", "get", f"{p_e}/source-documents")
    checks(rec, count=len(rec["response"]) if isinstance(rec["response"], list) else None)

    rec = call(
        "O03-02",
        "O03",
        "科目A1过滤（本项目的科目）",
        "get",
        f"{p_a}/source-documents",
        query={"subject_id": str(subject_a1.id)},
    )
    checks(
        rec,
        titles=[row["title"] for row in rec["response"]] if isinstance(rec["response"], list) else None,
    )

    rec = call(
        "O03-03",
        "O03",
        "其他项目的科目过滤",
        "get",
        f"{p_a}/source-documents",
        query={"subject_id": str(subject_b1.id)},
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call("O03-04", "O03", "外部项目路径", "get", f"{p_b}/source-documents")
    checks(rec, error=error_shape(rec["response"]))

    rec = call("O03-05", "O03", "limit=0", "get", f"{p_a}/source-documents", query={"limit": 0})
    checks(rec, count=len(rec["response"]), titles=[row["title"] for row in rec["response"]])

    rec = call("O03-06", "O03", "limit=1", "get", f"{p_a}/source-documents", query={"limit": 1})
    checks(rec, count=len(rec["response"]), titles=[row["title"] for row in rec["response"]])

    rec = call("O03-07", "O03", "limit=100", "get", f"{p_a}/source-documents", query={"limit": 100})
    checks(rec, count=len(rec["response"]), titles=[row["title"] for row in rec["response"]])

    rec = call(
        "O03-08",
        "O03",
        "limit=101（项目C共102条，观察上限100）",
        "get",
        f"{p_c}/source-documents",
        query={"limit": 101},
        summarize=True,
    )
    checks(
        rec,
        count=rec["response"]["_count"] if isinstance(rec["response"], dict) else None,
        db_total=SourceDocument.objects.filter(project=project_c, owner=owner).count(),
    )

    rec = call("O03-09", "O03", "limit=-5", "get", f"{p_a}/source-documents", query={"limit": -5})
    checks(rec, count=len(rec["response"]), titles=[row["title"] for row in rec["response"]])

    rec = call(
        "O03-10",
        "O03",
        "limit=abc 查询参数校验",
        "get",
        f"{p_a}/source-documents",
        query={"limit": "abc"},
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O03-11",
        "O03",
        "limit=1.5 查询参数校验",
        "get",
        f"{p_a}/source-documents",
        query={"limit": "1.5"},
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O03-12",
        "O03",
        "limit=100（项目C共102条）",
        "get",
        f"{p_c}/source-documents",
        query={"limit": 100},
        summarize=True,
    )
    checks(rec, count=rec["response"]["_count"] if isinstance(rec["response"], dict) else None)

    # ---------------------------------------------------------------- O07
    rec = call(
        "O07-01",
        "O07",
        "成功导入：两个模板题、带科目/标题/来源/范围",
        "post",
        f"{p_a}/imports",
        body={
            "text": LABELLED_TWO,
            "subject_id": str(subject_a1.id),
            "title": "导入标题",
            "source_note": "导入来源说明",
            "usage_scope": "仅练习",
        },
        key="o07-labelled-two",
    )
    notes.append(
        "O07 成功响应字段顺序来自 ImportJobOut 的声明顺序（Ninja 按响应模型重排，"
        "与 job_summary 的 dict 顺序不同）。"
    )
    job_labelled = ImportJob.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if job_labelled is not None:
        reg("JOB_LABELLED", job_labelled.id)
        candidates = list(ImportCandidate.objects.filter(job=job_labelled).order_by("created_at"))
        regions = list(SourceRegion.objects.filter(candidates__job=job_labelled).order_by("y"))
        document = job_labelled.documents.first()
        checks(
            rec,
            job={
                "status": job_labelled.status,
                "input_kind": job_labelled.input_kind,
                "extractor_version": job_labelled.extractor_version,
                "progress_percent": job_labelled.progress_percent,
                "attempts": job_labelled.attempts,
                "max_attempts": job_labelled.max_attempts,
                "last_error": job_labelled.last_error,
                "problems": job_labelled.problems,
                "duplicate_of_id": str(job_labelled.duplicate_of_id) if job_labelled.duplicate_of_id else None,
                "started_at_set": job_labelled.started_at is not None,
                "finished_at": iso(job_labelled.finished_at),
                "input_fingerprint_equals_sha256_text": job_labelled.input_fingerprint == sha256_text(LABELLED_TWO),
                "document_ids": [str(document.id)],
                "candidate_count": len(candidates),
                "candidate_statuses": [candidate.status for candidate in candidates],
                "candidate_issue_codes": [
                    [issue["code"] for issue in candidate.review_issues] for candidate in candidates
                ],
                "candidate_revisions": [candidate.revision for candidate in candidates],
                "candidate_is_stub_output": [candidate.is_stub_output for candidate in candidates],
                "machine_equals_draft": [candidate.machine_payload == candidate.draft_payload for candidate in candidates],
                "reviewed_at": [iso(candidate.reviewed_at) for candidate in candidates],
                "publication_question_id": [str(candidate.publication_question_id) if candidate.publication_question_id else None for candidate in candidates],
                "subjects": [str(candidate.subject_id) if candidate.subject_id else None for candidate in candidates],
            },
            document={
                "title": document.title,
                "source_note": document.source_note,
                "usage_scope": document.usage_scope,
                "subject_id": str(document.subject_id),
                "document_type": document.document_type,
                "role": document.role,
                "sensitivity": document.sensitivity,
                "source_type": document.source_type,
                "raw_text_equals_request": document.raw_text == LABELLED_TWO,
                "checksum_matches_sha256_text": document.checksum == sha256_text(LABELLED_TWO),
                "page_count": document.page_count,
                "page_texts": document.page_texts,
                "asset_id": str(document.asset_id) if document.asset_id else None,
            },
            regions=[
                {
                    "y": region.y,
                    "x": region.x,
                    "width": region.width,
                    "height": region.height,
                    "page_index": region.page_index,
                    "role": region.role,
                    "char_start": region.char_start,
                    "char_end": region.char_end,
                    "text_span": region.text_span,
                }
                for region in regions
            ],
        )

    rec = call(
        "O07-02",
        "O07",
        "默认值导入（无科目/标题/来源/范围）",
        "post",
        f"{p_a}/imports",
        body={"text": LABELLED_ONE},
        key="o07-defaults",
    )
    job_default = ImportJob.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if job_default is not None:
        reg("JOB_DEFAULT", job_default.id)
        candidate = ImportCandidate.objects.filter(job=job_default).first()
        checks(
            rec,
            job_subject_id=str(job_default.subject_id) if job_default.subject_id else None,
            document_title=job_default.documents.first().title if job_default.documents.first() else None,
            candidate_status=candidate.status if candidate else None,
            candidate_issue_codes=[issue["code"] for issue in candidate.review_issues] if candidate else None,
        )

    rec = call(
        "O07-03",
        "O07",
        "parse=false（唯一文本，避免 duplicate_input 干扰）",
        "post",
        f"{p_a}/imports",
        body={
            "text": "【题型】单选题\n【题干】parse关闭专用题干？\n【选项】\nA. 甲\nB. 乙\n【答案】A\n",
            "parse": False,
        },
        key="o07-parse-false",
    )
    job_parse_false = ImportJob.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if job_parse_false is not None:
        reg("JOB_PARSE_FALSE", job_parse_false.id)
        checks(
            rec,
            candidate_count=ImportCandidate.objects.filter(job=job_parse_false).count(),
            region_count=SourceRegion.objects.filter(candidates__job=job_parse_false).distinct().count(),
            document_count=job_parse_false.documents.count(),
            problem_codes=[problem["code"] for problem in job_parse_false.problems],
            status=job_parse_false.status,
        )

    rec = call(
        "O07-04",
        "O07",
        "空文本 400（并检查 claim 释放）",
        "post",
        f"{p_a}/imports",
        body={"text": "   \n\t"},
        key="o07-empty-then-retry",
    )
    checks(
        rec,
        idempotency_rows_after_400=IdempotencyRecord.objects.filter(
            user=owner, idempotency_key="o07-empty-then-retry"
        ).count(),
    )

    rec = call(
        "O07-05",
        "O07",
        "400 后同 key 换合法 body 重试",
        "post",
        f"{p_a}/imports",
        body={
            "text": "【题型】单选题\n【题干】claim释放专用题干？\n【选项】\nA. 甲\nB. 乙\n【答案】A\n"
        },
        key="o07-empty-then-retry",
    )
    checks(
        rec,
        idempotency_rows_after_201=IdempotencyRecord.objects.filter(
            user=owner, idempotency_key="o07-empty-then-retry"
        ).count(),
    )

    rec = call(
        "O07-06",
        "O07",
        "缺少 Idempotency-Key",
        "post",
        f"{p_a}/imports",
        body={"text": NUMBERED_ONE},
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O07-07",
        "O07",
        "请求头带前后空格（应 trim 后使用）",
        "post",
        f"{p_a}/imports",
        body={"text": "1. 空格键题目？\nA. 甲\nB. 乙\n答案：A"},
        key="  padded-key  ",
    )
    checks(
        rec,
        stored_key=[
            row.idempotency_key
            for row in IdempotencyRecord.objects.filter(
                user=owner, idempotency_key="padded-key"
            ).order_by("-created_at")
        ],
    )

    rec = call(
        "O07-08",
        "O07",
        "去掉空格后的同一 key 重放",
        "post",
        f"{p_a}/imports",
        body={"text": "1. 空格键题目？\nA. 甲\nB. 乙\n答案：A"},
        key="padded-key",
    )
    checks(rec, replayed=rec["status"] == 201)

    rec = call(
        "O07-09",
        "O07",
        "200 字符 key",
        "post",
        f"{p_a}/imports",
        body={"text": "1. 两百字符键题目？\nA. 甲\nB. 乙\n答案：A"},
        key="k" * 200,
    )

    rec = call(
        "O07-10",
        "O07",
        "201 字符 key",
        "post",
        f"{p_a}/imports",
        body={"text": "1. 二百零一字符键题目？\nA. 甲\nB. 乙\n答案：A"},
        key="k" * 201,
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O07-11",
        "O07",
        "同 key 同 body 重放",
        "post",
        f"{p_a}/imports",
        body={
            "text": LABELLED_TWO,
            "subject_id": str(subject_a1.id),
            "title": "导入标题",
            "source_note": "导入来源说明",
            "usage_scope": "仅练习",
        },
        key="o07-labelled-two",
    )
    original = next(item for item in CASES if item["case"] == "O07-01")
    checks(
        rec,
        identical_to_O07_01=json.dumps(rec["response"], sort_keys=True, ensure_ascii=False)
        == json.dumps(original["response"], sort_keys=True, ensure_ascii=False),
        replay_status=rec["status"],
    )

    rec = call(
        "O07-12",
        "O07",
        "同 key 不同 body 冲突",
        "post",
        f"{p_a}/imports",
        body={"text": "1. 另一个题目？\nA. 甲\nB. 乙\n答案：A"},
        key="o07-labelled-two",
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O07-13a",
        "O07",
        "首次相同输入",
        "post",
        f"{p_a}/imports",
        body={"text": "【题型】单选题\n【题干】重复输入题干？\n【选项】\nA. 甲\nB. 乙\n【答案】B\n"},
        key="o07-dup-first",
    )
    first_dup_job = ImportJob.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if first_dup_job is not None:
        reg("JOB_DUP_FIRST", first_dup_job.id)

    rec = call(
        "O07-13b",
        "O07",
        "相同输入的第二次导入（duplicate_input）",
        "post",
        f"{p_a}/imports",
        body={"text": "【题型】单选题\n【题干】重复输入题干？\n【选项】\nA. 甲\nB. 乙\n【答案】B\n"},
        key="o07-dup-second",
    )
    second_dup_job = ImportJob.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if second_dup_job is not None:
        reg("JOB_DUP_SECOND", second_dup_job.id)
        checks(
            rec,
            duplicate_of_job_id=str(second_dup_job.duplicate_of_id) if second_dup_job.duplicate_of_id else None,
            duplicate_of_is_first=second_dup_job.duplicate_of_id == first_dup_job.id if first_dup_job else None,
            problems=second_dup_job.problems,
            candidate_count=ImportCandidate.objects.filter(job=second_dup_job).count(),
        )

    rec = call(
        "O07-14",
        "O07",
        "无题号/无标签的非空文本（观察是否产生段落）",
        "post",
        f"{p_a}/imports",
        body={"text": "只有一句话，没有题号也没有标签。"},
        key="o07-no-segments",
    )
    job_no_seg = ImportJob.objects.get(id=rec["response"]["id"]) if rec["status"] == 201 else None
    if job_no_seg is not None:
        reg("JOB_NO_SEGMENT", job_no_seg.id)
        checks(
            rec,
            candidate_count=ImportCandidate.objects.filter(job=job_no_seg).count(),
            parsed_segment_count=len(text_parser.parse_paste("只有一句话，没有题号也没有标签。")),
            problem_codes=[problem["code"] for problem in job_no_seg.problems],
            status=job_no_seg.status,
            document_created=job_no_seg.documents.exists(),
        )

    before = db_counts()
    rec = call(
        "O07-15",
        "O07",
        "21 段文本：Region.clean 失败与整批回滚",
        "post",
        f"{p_a}/imports",
        body={"text": PATHOLOGICAL_TEXT},
        key="o07-pathological-21",
    )
    after = db_counts()
    checks(
        rec,
        parsed_segment_count=len(text_parser.parse_paste(PATHOLOGICAL_TEXT)),
        counts_delta=delta(before, after),
        idempotency_rows_for_key=IdempotencyRecord.objects.filter(
            user=owner, idempotency_key="o07-pathological-21"
        ).count(),
        error=error_shape(rec["response"]),
    )

    # Direct service call with 21 synthetic segments (not via HTTP) to see the
    # exception object itself and confirm the transaction rolls the whole batch back.
    synthetic_segments = [
        {
            "question_type": "single_choice",
            "display_label": f"S{index}",
            "content": {
                "blocks": [{"kind": "text", "text": f"直连题干{index}"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
                ],
            },
            "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
            "answer_status_known": True,
            "explanation_blocks": [],
            "source_excerpt": f"第{index}题 直连题干{index}",
            "parse_issues": [],
            "practice_max_score": None,
            "structure_signals": ["stem"],
        }
        for index in range(1, 22)
    ]
    synthetic_text = "\n".join(segment["source_excerpt"] for segment in synthetic_segments)
    before = db_counts()
    service_exception: dict | None = None
    try:
        import_services.start_text_import(
            owner=owner,
            project=project_a,
            text=synthetic_text,
            subject=subject_a1,
            segments=synthetic_segments,
        )
        service_outcome = "no_exception"
    except Exception as exc:  # noqa: BLE001 - the exception is the observation
        service_outcome = "exception"
        service_exception = {
            "type": type(exc).__name__,
            "str": str(exc),
            "message_dict": getattr(exc, "message_dict", None),
            "messages": getattr(exc, "messages", None),
        }
    after = db_counts()
    CASES.append(
        {
            "case": "O07-16",
            "op": "O07",
            "kind": "case",
            "title": "直连 start_text_import 21 段：异常对象与回滚",
            "request": {
                "method": "SERVICE",
                "path": "apps.ingestion.services.imports.start_text_import",
                "query": {},
                "body": {"segments": 21, "subject_id": str(subject_a1.id)},
                "idempotency_key": None,
            },
            "status": None,
            "response": None,
            "response_field_order": None,
            "checks": {
                "outcome": service_outcome,
                "exception": service_exception,
                "counts_delta": delta(before, after),
            },
        }
    )

    # ---------------------------------------------------------------- O10/O11
    # Project D: three API-created jobs with fixed creation times, plus one job
    # owned by another user to observe ownership filtering.
    project_d = exams_services.create_project(owner, name="B1 探针项目D·列表排序")
    reg("PROJECT_D", project_d)
    p_d = f"/api/v1/projects/{project_d.id}"
    job_ids = []
    for index in range(1, 4):
        rec = call(
            f"SETUP-D{index}",
            "setup",
            f"排序夹具任务{index}",
            "post",
            f"{p_d}/imports",
            body={"text": f"【题型】单选题\n【题干】排序夹具题干{index}？\n【选项】\nA. 甲\nB. 乙\n【答案】A\n"},
            key=f"setup-d-{index}",
            kind="setup",
        )
        job_ids.append(rec["response"]["id"])
    for index, job_id in enumerate(job_ids, start=1):
        ImportJob.objects.filter(id=job_id).update(created_at=BASE + timedelta(minutes=index))
    for index, job_id in enumerate(job_ids, start=1):
        reg(f"JOB_D{index}", job_id)
    job_d_foreign_owner = make_import_job(owner, project_d, label="job-d-foreign-owner", created_by=other)
    reg("JOB_D_FOREIGN_OWNER", job_d_foreign_owner.id)
    job_b = make_import_job(owner, project_b, label="job-b", created_by=other)
    reg("JOB_B", job_b.id)

    rec = call("O10-01", "O10", "未知 status 值", "get", f"{p_d}/imports", query={"status": "nope"})
    checks(rec, count=len(rec["response"]))

    rec = call("O10-02", "O10", "按 created_at 倒序", "get", f"{p_d}/imports")
    checks(
        rec,
        count=len(rec["response"]),
        ids=[row["id"] for row in rec["response"]],
        created_at_values=[row["created_at"] for row in rec["response"]],
        foreign_owner_job_visible=any(row["id"] == str(job_d_foreign_owner.id) for row in rec["response"]),
    )

    rec = call(
        "O10-03",
        "O10",
        "status=awaiting_review 过滤",
        "get",
        f"{p_d}/imports",
        query={"status": "awaiting_review"},
    )
    checks(rec, count=len(rec["response"]))

    rec = call("O10-04", "O10", "limit=0", "get", f"{p_d}/imports", query={"limit": 0})
    checks(rec, count=len(rec["response"]), ids=[row["id"] for row in rec["response"]])

    rec = call("O10-05", "O10", "limit=-5", "get", f"{p_d}/imports", query={"limit": -5})
    checks(rec, count=len(rec["response"]))

    rec = call(
        "O10-06",
        "O10",
        "limit=101（项目C共101条，观察上限100）",
        "get",
        f"{p_c}/imports",
        query={"limit": 101},
        summarize=True,
    )
    checks(
        rec,
        count=rec["response"]["_count"] if isinstance(rec["response"], dict) else None,
        db_total=ImportJob.objects.filter(project=project_c, created_by=owner).count(),
    )

    rec = call("O10-07", "O10", "limit=abc", "get", f"{p_d}/imports", query={"limit": "abc"})
    checks(rec, error=error_shape(rec["response"]))

    rec = call("O10-08", "O10", "limit=1.5", "get", f"{p_d}/imports", query={"limit": "1.5"})
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O10-09",
        "O10",
        "limit=100（项目C共101条）",
        "get",
        f"{p_c}/imports",
        query={"limit": 100},
        summarize=True,
    )
    checks(rec, count=rec["response"]["_count"] if isinstance(rec["response"], dict) else None)

    rec = call("O11-01", "O11", "自己的任务", "get", f"{p_d}/imports/{job_ids[1]}")
    checks(rec, id_matches=rec["response"]["id"] == job_ids[1])

    rec = call(
        "O11-02",
        "O11",
        "不存在/不属于该项目的任务 UUID",
        "get",
        f"{p_d}/imports/00000000-0000-0000-0000-000000000000",
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O11-03",
        "O11",
        "同项目但 created_by 是他人",
        "get",
        f"{p_d}/imports/{job_d_foreign_owner.id}",
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call("O11-04", "O11", "外部项目的任务 ID", "get", f"{p_d}/imports/{job_b.id}")
    checks(rec, error=error_shape(rec["response"]))

    rec = call("O11-05", "O11", "外部项目路径", "get", f"{p_b}/imports/{job_b.id}")
    checks(rec, error=error_shape(rec["response"]))

    # ---------------------------------------------------------------- O13
    rec = call(
        "O13-01",
        "O13",
        "job_id 过滤与 created_at 升序",
        "get",
        f"{p_a}/import-candidates",
        query={"job_id": job_labelled.id if job_labelled else ""},
    )
    candidate_ids = [row["id"] for row in rec["response"]]
    checks(
        rec,
        ids=candidate_ids,
        db_created_at_values=[
            iso(row.created_at)
            for row in ImportCandidate.objects.filter(id__in=candidate_ids).order_by("created_at")
        ],
        response_has_created_at=any("created_at" in row for row in rec["response"]),
        count=len(rec["response"]),
    )

    rec = call(
        "O13-02",
        "O13",
        "status=ready 过滤",
        "get",
        f"{p_a}/import-candidates",
        query={"job_id": job_labelled.id if job_labelled else "", "status": "ready"},
    )
    checks(rec, count=len(rec["response"]))

    rec = call(
        "O13-03",
        "O13",
        "status=draft 过滤",
        "get",
        f"{p_a}/import-candidates",
        query={"job_id": job_default.id if job_default else "", "status": "draft"},
    )
    checks(rec, count=len(rec["response"]))

    rec = call(
        "O13-04",
        "O13",
        "未知 status 值",
        "get",
        f"{p_a}/import-candidates",
        query={"status": "nope"},
    )
    checks(rec, count=len(rec["response"]))

    rec = call("O13-05", "O13", "limit=0", "get", f"{p_a}/import-candidates", query={"limit": 0})
    checks(rec, count=len(rec["response"]))

    rec = call("O13-06", "O13", "limit=-5", "get", f"{p_a}/import-candidates", query={"limit": -5})
    checks(rec, count=len(rec["response"]))

    rec = call(
        "O13-07",
        "O13",
        "limit=101（项目C共101条，观察上限100）",
        "get",
        f"{p_c}/import-candidates",
        query={"limit": 101},
        summarize=True,
    )
    checks(
        rec,
        count=rec["response"]["_count"] if isinstance(rec["response"], dict) else None,
        db_total=ImportCandidate.objects.filter(project=project_c).count(),
    )

    rec = call("O13-08", "O13", "limit=abc", "get", f"{p_a}/import-candidates", query={"limit": "abc"})
    checks(rec, error=error_shape(rec["response"]))

    rec = call("O13-09", "O13", "limit=1.5", "get", f"{p_a}/import-candidates", query={"limit": "1.5"})
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O13-13",
        "O13",
        "limit=100（项目C共101条）",
        "get",
        f"{p_c}/import-candidates",
        query={"limit": 100},
        summarize=True,
    )
    checks(rec, count=rec["response"]["_count"] if isinstance(rec["response"], dict) else None)

    rec = call(
        "O13-10",
        "O13",
        "外部项目的 job_id",
        "get",
        f"{p_a}/import-candidates",
        query={"job_id": str(job_b.id)},
    )
    checks(rec, count=len(rec["response"]))

    rec = call(
        "O13-11",
        "O13",
        "同项目但 job.created_by 是他人",
        "get",
        f"{p_a}/import-candidates",
        query={"job_id": str(job_d_foreign_owner.id)},
    )
    checks(rec, count=len(rec["response"]))

    foreign_candidate = ImportCandidate.objects.create(
        job=job_d_foreign_owner,
        project=project_d,
        status="draft",
        revision=1,
        draft_payload={},
        machine_payload={},
        extractor_version="text-structure-v1",
    )
    reg("CAND_FOREIGN_OWNER", foreign_candidate.id)
    rec = call("O13-12", "O13", "列表排除他人任务下的候选", "get", f"{p_d}/import-candidates")
    visible_ids = [row["id"] for row in rec["response"]] if isinstance(rec["response"], list) else []
    checks(
        rec,
        visible_count=len(visible_ids),
        db_total=ImportCandidate.objects.filter(project=project_d).count(),
        foreign_candidate_id=str(foreign_candidate.id),
        foreign_candidate_visible=str(foreign_candidate.id) in visible_ids,
    )

    # ---------------------------------------------------------------- O12
    rec = call(
        "O12-01",
        "O12",
        "非失败任务重试",
        "post",
        f"{p_d}/imports/{job_ids[0]}/retry",
        body=None,
        key="o12-not-failed",
    )
    checks(rec, error=error_shape(rec["response"]))

    if job_default is not None:
        fail_start = BASE + timedelta(hours=1)
        fail_finish = BASE + timedelta(hours=2)
        ImportJob.objects.filter(id=job_default.id).update(
            status="failed",
            last_error="合成失败原因",
            attempts=0,
            progress_percent=40,
            started_at=fail_start,
            finished_at=fail_finish,
        )
        before = db_counts()
        rec = call(
            "O12-02",
            "O12",
            "失败任务重试成功",
            "post",
            f"{p_a}/imports/{job_default.id}/retry",
            body=None,
            key="o12-failed-retry",
        )
        after = db_counts()
        job_default.refresh_from_db()
        checks(
            rec,
            status=job_default.status,
            attempts=job_default.attempts,
            last_error=job_default.last_error,
            started_at=iso(job_default.started_at),
            finished_at=iso(job_default.finished_at),
            finished_at_preserved=job_default.finished_at == fail_finish,
            finished_at_before_started_at=job_default.finished_at is not None
            and job_default.started_at is not None
            and job_default.finished_at < job_default.started_at,
            started_at_after_fail_finish=job_default.started_at is not None
            and job_default.started_at > fail_finish,
            non_terminal_status_with_finished_at=job_default.status == "awaiting_review"
            and job_default.finished_at is not None,
            problems=job_default.problems,
            progress_percent=job_default.progress_percent,
            content_revision_delta=after["audit_content_revision"] - before["audit_content_revision"],
            outbox_delta=after["audit_outbox_event"] - before["audit_outbox_event"],
        )

        rec = call(
            "O12-03",
            "O12",
            "同 key 同 body 重放",
            "post",
            f"{p_a}/imports/{job_default.id}/retry",
            body=None,
            key="o12-failed-retry",
        )
        previous = next(item for item in CASES if item["case"] == "O12-02")
        checks(
            rec,
            identical_to_O12_02=json.dumps(rec["response"], sort_keys=True, ensure_ascii=False)
            == json.dumps(previous["response"], sort_keys=True, ensure_ascii=False),
        )

    if job_parse_false is not None:
        ImportJob.objects.filter(id=job_parse_false.id).update(
            status="failed",
            attempts=3,
            max_attempts=3,
            last_error="达到上限前的错误",
        )
        rec = call(
            "O12-04",
            "O12",
            "attempts 达到 max_attempts",
            "post",
            f"{p_a}/imports/{job_parse_false.id}/retry",
            body=None,
            key="o12-max-attempts",
        )
        checks(rec, error=error_shape(rec["response"]))

    # ---------------------------------------------------------------- O14
    job_no_link, cand_no_link, _ = make_candidate(owner, project_a, subject_a1, fixture_document, "无发布链接")
    reg("CAND_NO_LINK", cand_no_link.id)
    reg("JOB_NO_LINK", job_no_link.id)
    before_exposure = ExposureEvent.objects.count()
    before_revision = ContentRevision.objects.count()
    rec = call("O14-01", "O14", "无 publication 链接：候选详情", "get", f"{p_a}/import-candidates/{cand_no_link.id}")
    checks(
        rec,
        exposure_delta=ExposureEvent.objects.count() - before_exposure,
        content_revision_delta=ContentRevision.objects.count() - before_revision,
        publication_question_id=rec["response"]["publication_question_id"],
    )

    job_linked, cand_linked, _ = make_candidate(owner, project_a, subject_a1, fixture_document, "已发布链接")
    cand_linked.publication_question_id = question.id
    cand_linked.publication_version_id = published_version.id
    cand_linked.save(update_fields=["publication_question_id", "publication_version_id", "updated_at"])
    reg("CAND_LINKED", cand_linked.id)
    reg("JOB_LINKED", job_linked.id)
    rec = call("O14-02", "O14", "已发布链接：候选详情写 exposure", "get", f"{p_a}/import-candidates/{cand_linked.id}")
    exposure = ExposureEvent.objects.filter(
        user=owner, question=question, kind="editorial_preview", detail__candidate_id=str(cand_linked.id)
    ).first()
    if exposure is not None:
        reg("EXPOSURE_LINKED", exposure.id)
        checks(
            rec,
            exposure_count=ExposureEvent.objects.filter(
                user=owner, question=question, kind="editorial_preview"
            ).count(),
            exposure={
                "kind": exposure.kind,
                "purpose": exposure.purpose,
                "source": exposure.source,
                "reveals_answer": exposure.reveals_answer,
                "project_id": str(exposure.project_id),
                "question_id": str(exposure.question_id) if exposure.question_id else None,
                "question_version_id": str(exposure.question_version_id) if exposure.question_version_id else None,
                "family_id": str(exposure.family_id) if exposure.family_id else None,
                "content_lineage_id": str(exposure.content_lineage_id) if exposure.content_lineage_id else None,
                "session_item_id": str(exposure.session_item_id) if exposure.session_item_id else None,
                "server_time": iso(exposure.server_time),
                "detail": exposure.detail,
                "detail_keys": list(exposure.detail.keys()),
            },
        )
    rec = call("O14-03", "O14", "重复 GET 复用同一 exposure 行", "get", f"{p_a}/import-candidates/{cand_linked.id}")
    checks(
        rec,
        exposure_count=ExposureEvent.objects.filter(user=owner, question=question, kind="editorial_preview").count(),
        exposure_ids=[
            str(row.id)
            for row in ExposureEvent.objects.filter(
                user=owner, question=question, kind="editorial_preview", detail__candidate_id=str(cand_linked.id)
            )
        ],
        response_equals_O14_02=False,
    )
    previous = next(item for item in CASES if item["case"] == "O14-02")
    checks(
        rec,
        response_equals_O14_02=json.dumps(rec["response"], sort_keys=True, ensure_ascii=False)
        == json.dumps(previous["response"], sort_keys=True, ensure_ascii=False),
    )

    rec = call(
        "O14-04",
        "O14",
        "不存在的候选 UUID",
        "get",
        f"{p_a}/import-candidates/00000000-0000-0000-0000-000000000000",
    )
    checks(rec, error=error_shape(rec["response"]))
    rec = call(
        "O14-05",
        "O14",
        "他人任务下的候选",
        "get",
        f"{p_d}/import-candidates/{foreign_candidate.id}",
    )
    checks(rec, error=error_shape(rec["response"]))

    # ---------------------------------------------------------------- O15
    job_edit, cand_edit, _ = make_candidate(owner, project_a, subject_a1, fixture_document, "修订编辑目标")
    reg("CAND_EDIT", cand_edit.id)
    reg("JOB_EDIT", job_edit.id)
    pre_issues = list(cand_edit.review_issues)
    pre_machine = json.loads(json.dumps(cand_edit.machine_payload, sort_keys=True))
    bad_payload = {
        "question_type": "single_choice",
        "content": {"blocks": [{"kind": "text", "text": "改后题干"}], "options": []},
        "answer_payload": {},
    }
    rec = call(
        "O15-01",
        "O15",
        "draft_payload 全替换 + 旧 issues 快照",
        "patch",
        f"{p_a}/import-candidates/{cand_edit.id}",
        body={"draft_payload": bad_payload, "expected_revision": 1, "note": "改后说明"},
    )
    cand_edit.refresh_from_db()
    revision_row = CandidateRevision.objects.filter(candidate=cand_edit).order_by("-revision").first()
    content_row = (
        ContentRevision.objects.filter(entity_type="import_candidate", entity_id=str(cand_edit.id))
        .order_by("-created_at")
        .first()
    )
    checks(
        rec,
        revision=cand_edit.revision,
        status=cand_edit.status,
        payload_is_exact_new_dict=cand_edit.draft_payload == bad_payload,
        payload_keys=sorted(cand_edit.draft_payload.keys()),
        machine_payload_unchanged=json.loads(json.dumps(cand_edit.machine_payload, sort_keys=True)) == pre_machine,
        new_issue_codes=[issue["code"] for issue in cand_edit.review_issues],
        candidate_revision={
            "revision": revision_row.revision,
            "payload_equals_new": revision_row.payload == bad_payload,
            "review_issues": revision_row.review_issues,
            "snapshot_equals_pre_refresh": revision_row.review_issues == pre_issues,
            "note": revision_row.note,
            "edited_by_id": str(revision_row.edited_by_id),
        },
        content_revision={
            "action": content_row.action,
            "entity_type": content_row.entity_type,
            "entity_id": content_row.entity_id,
            "project_id": str(content_row.project_id),
            "reason": content_row.reason,
            "detail": content_row.detail,
            "actor_id": str(content_row.actor_id),
            "before_digest": content_row.before_digest,
            "after_digest": content_row.after_digest,
        },
    )

    job_empty, cand_empty, _ = make_candidate(owner, project_a, subject_a1, fixture_document, "空补丁目标")
    reg("CAND_EMPTY", cand_empty.id)
    reg("JOB_EMPTY", job_empty.id)
    empty_pre_issues = list(cand_empty.review_issues)
    empty_pre_payload = json.loads(json.dumps(cand_empty.draft_payload, sort_keys=True))
    rec = call(
        "O15-02",
        "O15",
        "空 patch：revision+1、reviewed_at、快照",
        "patch",
        f"{p_a}/import-candidates/{cand_empty.id}",
        body={},
    )
    cand_empty.refresh_from_db()
    revision_row = CandidateRevision.objects.filter(candidate=cand_empty).order_by("-revision").first()
    checks(
        rec,
        revision=cand_empty.revision,
        reviewed_at=iso(cand_empty.reviewed_at),
        reviewed_at_set=cand_empty.reviewed_at is not None,
        payload_unchanged=json.loads(json.dumps(cand_empty.draft_payload, sort_keys=True)) == empty_pre_payload,
        snapshot_issues=revision_row.review_issues,
        snapshot_equals_pre_refresh=revision_row.review_issues == empty_pre_issues,
        content_revision_detail=ContentRevision.objects.filter(
            entity_type="import_candidate", entity_id=str(cand_empty.id)
        )
        .order_by("-created_at")
        .first()
        .detail,
    )

    rec = call(
        "O15-03",
        "O15",
        "subject_id 改为同项目科目 A2",
        "patch",
        f"{p_a}/import-candidates/{cand_empty.id}",
        body={"subject_id": str(subject_a2.id), "expected_revision": cand_empty.revision},
    )
    cand_empty.refresh_from_db()
    checks(rec, subject_id=str(cand_empty.subject_id), revision=cand_empty.revision)

    job_cross, cand_cross, _ = make_candidate(owner, project_a, subject_a1, fixture_document, "跨项目科目目标")
    reg("CAND_CROSS", cand_cross.id)
    rec = call(
        "O15-04",
        "O15",
        "subject_id 来自另一个项目",
        "patch",
        f"{p_a}/import-candidates/{cand_cross.id}",
        body={"subject_id": str(subject_b1.id)},
    )
    cand_cross.refresh_from_db()
    checks(rec, error=error_shape(rec["response"]), revision=cand_cross.revision)

    rec = call(
        "O15-05",
        "O15",
        "note=501 字符截断",
        "patch",
        f"{p_a}/import-candidates/{cand_empty.id}",
        body={"note": "n" * 501, "expected_revision": cand_empty.revision},
    )
    cand_empty.refresh_from_db()
    revision_row = CandidateRevision.objects.filter(candidate=cand_empty).order_by("-revision").first()
    checks(rec, revision=cand_empty.revision, stored_note_len=len(revision_row.note), stored_note=revision_row.note)

    job_published, cand_published, _ = make_candidate(
        owner, project_a, subject_a1, fixture_document, "已发布拒绝目标", forced_status="published"
    )
    reg("CAND_PUBLISHED", cand_published.id)
    published_revision_before = cand_published.revision
    rec = call(
        "O15-06",
        "O15",
        "已发布候选拒绝 PATCH",
        "patch",
        f"{p_a}/import-candidates/{cand_published.id}",
        body={"note": "不应写入"},
    )
    cand_published.refresh_from_db()
    checks(
        rec,
        error=error_shape(rec["response"]),
        revision_before=published_revision_before,
        revision=cand_published.revision,
        revision_unchanged=cand_published.revision == published_revision_before,
    )

    job_conflict, cand_conflict, _ = make_candidate(owner, project_a, subject_a1, fixture_document, "冲突预览目标")
    cand_conflict.publication_question_id = question.id
    cand_conflict.publication_version_id = published_version.id
    cand_conflict.save(update_fields=["publication_question_id", "publication_version_id", "updated_at"])
    reg("CAND_CONFLICT", cand_conflict.id)
    before_exposure = ExposureEvent.objects.count()
    rec = call(
        "O15-07",
        "O15",
        "expected_revision 冲突（并观察 preview 写入）",
        "patch",
        f"{p_a}/import-candidates/{cand_conflict.id}",
        body={"expected_revision": 99},
    )
    cand_conflict.refresh_from_db()
    exposure = ExposureEvent.objects.filter(
        user=owner, question=question, kind="editorial_preview", detail__candidate_id=str(cand_conflict.id)
    ).first()
    conflict_details = (rec["response"].get("error") or {}).get("details") or {}
    checks(
        rec,
        error=error_shape(rec["response"]),
        details_expected=conflict_details.get("expected"),
        details_actual=conflict_details.get("actual"),
        details_expected_type=type(conflict_details.get("expected")).__name__,
        details_actual_type=type(conflict_details.get("actual")).__name__,
        revision=cand_conflict.revision,
        exposure_delta=ExposureEvent.objects.count() - before_exposure,
        exposure_source=exposure.source if exposure is not None else None,
        exposure_detail=exposure.detail if exposure is not None else None,
    )

    # ---------------------------------------------------------------- O16
    job_ignore, cand_ignore, _ = make_candidate(owner, project_a, subject_a1, fixture_document, "忽略目标")
    reg("CAND_IGNORE", cand_ignore.id)
    reg("JOB_IGNORE", job_ignore.id)
    rec = call(
        "O16-01",
        "O16",
        "ignore 的 reason 走 query 参数（含空格）",
        "post",
        f"{p_a}/import-candidates/{cand_ignore.id}/ignore",
        query={"reason": "  理由X  "},
        body=None,
        key="o16-ignore-1",
    )
    cand_ignore.refresh_from_db()
    content_row = (
        ContentRevision.objects.filter(entity_type="import_candidate", entity_id=str(cand_ignore.id))
        .order_by("-created_at")
        .first()
    )
    checks(
        rec,
        status=cand_ignore.status,
        revision=cand_ignore.revision,
        reviewed_at=iso(cand_ignore.reviewed_at),
        content_revision={
            "action": content_row.action,
            "reason": content_row.reason,
            "reason_len": len(content_row.reason),
            "detail": content_row.detail,
            "before_digest": content_row.before_digest,
            "after_digest": content_row.after_digest,
        },
    )
    job_ignore.refresh_from_db()
    rec_job = call("O16-02", "O16", "最后一个候选忽略后任务状态", "get", f"{p_a}/imports/{job_ignore.id}")
    checks(
        rec_job,
        status=rec_job["response"]["status"],
        progress_percent=rec_job["response"]["progress_percent"],
        db_finished_at=iso(job_ignore.finished_at),
        db_finished_at_set=job_ignore.finished_at is not None,
    )

    job_ignore_replay, cand_ignore_replay, _ = make_candidate(
        owner, project_a, subject_a1, fixture_document, "忽略重放目标"
    )
    rec = call(
        "O16-03",
        "O16",
        "ignore 首次调用",
        "post",
        f"{p_a}/import-candidates/{cand_ignore_replay.id}/ignore",
        query={"reason": "重放理由"},
        body=None,
        key="o16-ignore-replay",
    )
    checks(rec, content_revision_count=ContentRevision.objects.filter(entity_id=str(cand_ignore_replay.id)).count())
    rec = call(
        "O16-04",
        "O16",
        "ignore 同 key 同 reason 重放",
        "post",
        f"{p_a}/import-candidates/{cand_ignore_replay.id}/ignore",
        query={"reason": "重放理由"},
        body=None,
        key="o16-ignore-replay",
    )
    previous = next(item for item in CASES if item["case"] == "O16-03")
    checks(
        rec,
        identical_to_O16_03=json.dumps(rec["response"], sort_keys=True, ensure_ascii=False)
        == json.dumps(previous["response"], sort_keys=True, ensure_ascii=False),
        content_revision_count=ContentRevision.objects.filter(entity_id=str(cand_ignore_replay.id)).count(),
    )

    job_ignore_conflict, cand_ignore_conflict, _ = make_candidate(
        owner, project_a, subject_a1, fixture_document, "忽略冲突目标"
    )
    rec = call(
        "O16-05",
        "O16",
        "ignore 首次（理由A）",
        "post",
        f"{p_a}/import-candidates/{cand_ignore_conflict.id}/ignore",
        query={"reason": "理由A"},
        body=None,
        key="o16-ignore-conflict",
    )
    rec = call(
        "O16-06",
        "O16",
        "ignore 同 key 不同 reason 冲突",
        "post",
        f"{p_a}/import-candidates/{cand_ignore_conflict.id}/ignore",
        query={"reason": "理由B"},
        body=None,
        key="o16-ignore-conflict",
    )
    checks(
        rec,
        error=error_shape(rec["response"]),
        content_revision_count=ContentRevision.objects.filter(entity_id=str(cand_ignore_conflict.id)).count(),
    )

    job_ignore_long, cand_ignore_long, _ = make_candidate(
        owner, project_a, subject_a1, fixture_document, "忽略长理由目标"
    )
    rec = call(
        "O16-07",
        "O16",
        "ignore 的 reason=501 字符截断",
        "post",
        f"{p_a}/import-candidates/{cand_ignore_long.id}/ignore",
        query={"reason": "r" * 501},
        body=None,
        key="o16-ignore-long",
    )
    cand_ignore_long.refresh_from_db()
    content_row = (
        ContentRevision.objects.filter(entity_id=str(cand_ignore_long.id)).order_by("-created_at").first()
    )
    checks(rec, stored_reason_len=len(content_row.reason), status=cand_ignore_long.status)

    job_ignore_published, cand_ignore_published, _ = make_candidate(
        owner, project_a, subject_a1, fixture_document, "忽略已发布目标", forced_status="published"
    )
    rec = call(
        "O16-08",
        "O16",
        "已发布候选拒绝 ignore",
        "post",
        f"{p_a}/import-candidates/{cand_ignore_published.id}/ignore",
        query={"reason": "不应写入"},
        body=None,
        key="o16-ignore-published",
    )
    checks(
        rec,
        error=error_shape(rec["response"]),
        content_revision_count=ContentRevision.objects.filter(entity_id=str(cand_ignore_published.id)).count(),
    )

    # ---------------------------------------------------------------- O17
    job_layout, cand_layout, region_layout = make_candidate(
        owner, project_a, subject_a1, fixture_document, "版式确认目标"
    )
    reg("CAND_LAYOUT", cand_layout.id)
    reg("REGION_LAYOUT", region_layout.id)
    layout_revision_before = cand_layout.revision
    rec = call(
        "O17-01",
        "O17",
        "layout-confirm note（含 pages/continues_on_pages）",
        "post",
        f"{p_a}/import-candidates/{cand_layout.id}/layout-confirm",
        body={"note": "已对照原页确认"},
        key="o17-layout-1",
    )
    cand_layout.refresh_from_db()
    content_row = (
        ContentRevision.objects.filter(entity_type="import_candidate", entity_id=str(cand_layout.id))
        .order_by("-created_at")
        .first()
    )
    checks(
        rec,
        layout_review_confirmed_at=iso(cand_layout.layout_review_confirmed_at),
        layout_review_note=cand_layout.layout_review_note,
        revision_before=layout_revision_before,
        revision=cand_layout.revision,
        revision_unchanged=cand_layout.revision == layout_revision_before,
        reviewed_at=iso(cand_layout.reviewed_at),
        content_revision={
            "action": content_row.action,
            "reason": content_row.reason,
            "detail": content_row.detail,
            "detail_keys": sorted(content_row.detail.keys()) if isinstance(content_row.detail, dict) else None,
        },
    )

    job_layout_cont, cand_layout_cont, region_layout_cont = make_candidate(
        owner, project_a, subject_a1, fixture_document, "跨页版式目标"
    )
    payload_with_continuation = dict(cand_layout_cont.draft_payload)
    payload_with_continuation["continues_on_pages"] = [1, 2]
    rec = call(
        "O17-02a",
        "O17",
        "先写入 continues_on_pages",
        "patch",
        f"{p_a}/import-candidates/{cand_layout_cont.id}",
        body={"draft_payload": payload_with_continuation, "expected_revision": 1},
    )
    rec = call(
        "O17-02b",
        "O17",
        "layout-confirm 记录 continues_on_pages",
        "post",
        f"{p_a}/import-candidates/{cand_layout_cont.id}/layout-confirm",
        body={"note": "跨页已确认"},
        key="o17-layout-cont",
    )
    cand_layout_cont.refresh_from_db()
    content_row = (
        ContentRevision.objects.filter(entity_type="import_candidate", entity_id=str(cand_layout_cont.id))
        .order_by("-created_at")
        .first()
    )
    checks(
        rec,
        revision=cand_layout_cont.revision,
        continues_on_pages_issue=[
            issue for issue in cand_layout_cont.review_issues if issue["code"] == "cross_page_question"
        ],
        content_revision_detail=content_row.detail,
    )

    job_layout_published, cand_layout_published, _ = make_candidate(
        owner, project_a, subject_a1, fixture_document, "版式已发布目标", forced_status="published"
    )
    rec = call(
        "O17-03",
        "O17",
        "已发布候选拒绝 layout-confirm",
        "post",
        f"{p_a}/import-candidates/{cand_layout_published.id}/layout-confirm",
        body={"note": "不应写入"},
        key="o17-layout-published",
    )
    checks(rec, error=error_shape(rec["response"]))

    rec = call(
        "O17-04",
        "O17",
        "已忽略候选允许 layout-confirm",
        "post",
        f"{p_a}/import-candidates/{cand_ignore.id}/layout-confirm",
        body={"note": "忽略后确认版式"},
        key="o17-layout-ignored",
    )
    cand_ignore.refresh_from_db()
    checks(
        rec,
        status=cand_ignore.status,
        layout_review_note=cand_ignore.layout_review_note,
        revision=cand_ignore.revision,
    )

    job_layout_replay, cand_layout_replay, _ = make_candidate(
        owner, project_a, subject_a1, fixture_document, "版式重放目标"
    )
    rec = call(
        "O17-05",
        "O17",
        "layout-confirm 首次",
        "post",
        f"{p_a}/import-candidates/{cand_layout_replay.id}/layout-confirm",
        body={"note": "重放确认"},
        key="o17-layout-replay",
    )
    rec = call(
        "O17-06",
        "O17",
        "layout-confirm 同 key 同 body 重放",
        "post",
        f"{p_a}/import-candidates/{cand_layout_replay.id}/layout-confirm",
        body={"note": "重放确认"},
        key="o17-layout-replay",
    )
    previous = next(item for item in CASES if item["case"] == "O17-05")
    checks(
        rec,
        identical_to_O17_05=json.dumps(rec["response"], sort_keys=True, ensure_ascii=False)
        == json.dumps(previous["response"], sort_keys=True, ensure_ascii=False),
        content_revision_count=ContentRevision.objects.filter(entity_id=str(cand_layout_replay.id)).count(),
    )

    # ---------------------------------------------------------------- schema validation
    schema_text_cases = [
        ("S01", "TextIn 缺 text", f"{p_a}/imports", {}, "o-s01"),
        ("S02", "text 类型错误", f"{p_a}/imports", {"text": 123}, "o-s02"),
        ("S03", "title 类型错误", f"{p_a}/imports", {"text": "有效文本", "title": 123}, "o-s03"),
        ("S04", "parse=null", f"{p_a}/imports", {"text": "有效文本", "parse": None}, "o-s04"),
        (
            "S05",
            "O04 text 类型错误",
            f"{p_a}/source-documents/text",
            {"text": 123},
            "o-s05",
        ),
        (
            "S06",
            "parse='false' 字符串强制转换（不是 400）",
            f"{p_a}/imports",
            {"text": NUMBERED_ONE, "parse": "false"},
            "o-s06",
        ),
    ]
    for case_id, title, path, body, key in schema_text_cases:
        rec = call(case_id, "SCHEMA", title, "post", path, body=body, key=key)
        if rec["status"] == 400:
            checks(rec, error=error_shape(rec["response"]))
        else:
            checks(
                rec,
                candidate_count=rec["response"].get("candidate_count") if isinstance(rec["response"], dict) else None,
                problem_codes=[
                    problem.get("code") for problem in rec["response"].get("problems", [])
                ]
                if isinstance(rec["response"], dict)
                else None,
                coercion_observed=True,
            )

    schema_patch_cases = [
        ("P01", "draft_payload 是数组", cand_edit.id, {"draft_payload": []}),
        ("P02", "expected_revision='3' 字符串", cand_edit.id, {"expected_revision": "3"}),
        ("P03", "expected_revision=3.7", cand_edit.id, {"expected_revision": 3.7}),
        ("P04", "note 是整数", cand_edit.id, {"note": 5}),
    ]
    for case_id, title, candidate_id, body in schema_patch_cases:
        rec = call(case_id, "SCHEMA", title, "patch", f"{p_a}/import-candidates/{candidate_id}", body=body)
        if rec["status"] == 400:
            checks(rec, error=error_shape(rec["response"]))
        else:
            checks(rec, note="Pydantic coerced the value; not a 400", error=error_shape(rec["response"]))

    rec = call(
        "S07",
        "SCHEMA",
        "LayoutIn note 是整数",
        "post",
        f"{p_a}/import-candidates/{cand_layout.id}/layout-confirm",
        body={"note": 5},
    )
    checks(rec, error=error_shape(rec["response"]))

    # ---------------------------------------------------------------- query validation
    query_cases = [
        ("Q01", "O03 limit=abc", f"{p_a}/source-documents", "abc"),
        ("Q02", "O03 limit=1.5", f"{p_a}/source-documents", "1.5"),
        ("Q03", "O10 limit=abc", f"{p_a}/imports", "abc"),
        ("Q04", "O10 limit=1.5", f"{p_a}/imports", "1.5"),
        ("Q05", "O13 limit=abc", f"{p_a}/import-candidates", "abc"),
        ("Q06", "O13 limit=1.5", f"{p_a}/import-candidates", "1.5"),
    ]
    for case_id, title, path, limit in query_cases:
        rec = call(case_id, "QUERY", title, "get", path, query={"limit": limit})
        checks(rec, error=error_shape(rec["response"]))

    # ---------------------------------------------------------------- wrap-up
    final_counts = db_counts()
    notes.extend(
        [
            "O14-O17 的候选/任务起点由 ORM 夹具创建（含 status=published 与 publication_* 链接），"
            "因为 O18 发布尚未实现；被观测的 GET/PATCH/POST 路由与 service 都是真实的。",
            "O12 的“失败任务”由 ORM 把 status 设为 failed 并写入 last_error/finished_at；"
            "没有 HTTP 操作能造成 failed 状态。",
            "O03/O10/O13 的 100 上限通过项目C的 101/102 行夹具观测，"
            "小项目里 limit=101 只返回现有行数，无法区分“被截断”与“本来就更少”。",
            "响应中的 ID/时间戳是真实值；报告用 SYMBOLS 中的符号名描述它们。",
        ]
    )
    unobserved.extend(
        [
            "O18（发布）不在本批次：O14/O15 的 publication_question_id/version_id 与 "
            "O15/O16/O17 的 published 状态均由 ORM 直接设置，没有走真实 publish 路由；"
            "因此“发布后再校对”的完整链路未观测。",
            "O12 只观测了 failed；cancelled 状态的重试未观测（代码在同一分支，但未实测）。",
            "并发同 key 的 in_flight 409 未观测：脚本串行执行，无法制造未完成 claim 的并发窗口。",
            "created_at 完全相同（并列）时的排序未观测；desc/asc 结论只覆盖严格递增的时间戳。",
            "O14 的去重只在同一 user+question+kind+detail.candidate_id 下重复 GET；"
            "换 source 或候选状态变化后的复用未单独实测。",
            "O17 的 layout_review_note 超过 500 字符的截断未实测（O15 note 与 O16 reason 已实测）。",
            "O01/O02/O05/O06/O08/O09/O18/O19/O20 不属于本次 B1 探针范围，未调用。",
            "exposure/audit/CandidateRevision 的字段只能从数据库行读取，HTTP 响应不包含这些对象；"
            "O14/O17 的 details 因此是 DB 侧观测。",
        ]
    )

    return {
        "probe": "09-ingestion-b1-probe",
        "oracle": "django.test.Client against a throw-away PostgreSQL test DB (config.settings.test)",
        "django_version": django.get_version(),
        "case_count": len(CASES),
        "operational_case_count": len([item for item in CASES if item["kind"] == "case"]),
        "symbols": {key: SYMBOLS[key] for key in sorted(SYMBOLS)},
        "notes": notes,
        "unobserved": unobserved,
        "final_counts": final_counts,
        "cases": CASES,
    }


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        payload = build()
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )

    for item in payload["cases"]:
        status = item["status"] if item["status"] is not None else "SVC"
        print(f"{item['case']:>9}  {str(status):>4}  {item['op']:<6}  {item['title']}")
    print(
        f"\n{payload['case_count']} cases "
        f"({payload['operational_case_count']} operational + "
        f"{payload['case_count'] - payload['operational_case_count']} setup) "
        f"written to {OUT_JSON}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
