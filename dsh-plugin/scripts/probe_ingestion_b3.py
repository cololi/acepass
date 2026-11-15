#!/usr/bin/env python
"""Empirical HTTP probe for the four ingestion asset/image operations (B3).

Operations covered, all through the real Ninja router against a real PostgreSQL test database:

* O01 ``POST /api/v1/projects/{project_id}/assets``                   (single private asset)
* O02 ``GET  /api/v1/projects/{project_id}/assets/{asset_id}``        (gated private download)
* O05 ``POST /api/v1/projects/{project_id}/source-documents/image``   (image source document)
* O08 ``POST /api/v1/projects/{project_id}/imports/images``           (image batch import)

Nothing here asserts what the API *should* do. Every case records the request shape (method, path,
multipart field summary with file names / content types / byte sizes, idempotency key), the status,
the raw JSON payload, the four response headers that matter for a private file, the row deltas the
call left behind and, for downloads, the sha256 / byte count / first 16 bytes of the body.

Determinism rules (the JSON is generated twice and compared by sha256):

* every UUID that would reach the payload is replaced by a symbolic name; an unknown one is
  auto-named ``REF_nnn`` in first-appearance order and re-named later when its fixture gets a
  symbolic name;
* every timestamp is replaced by ``"<now>"`` (``created_at``, ``server_time``, ``detail.server_time``
  ...), because those are real clocks;
* object keys are reduced to a *shape* (namespace / token length / suffix), never the value;
* image fixtures are generated with Pillow from fixed pixels (the one big image uses a fixed seed),
  so the same bytes are produced on every run.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_ingestion_b3.py

Writes ``docs/dsh-migration/12-ingestion-b3-probe.json`` only; the markdown report is hand written
from that evidence.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import random
import re
import shutil
import sys
import uuid
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.core.files.uploadedfile import SimpleUploadedFile  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import Client  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from PIL import Image, PngImagePlugin  # noqa: E402

from apps.audit.models import ContentRevision, IdempotencyRecord, LLMRun, OutboxEvent  # noqa: E402
from apps.exams import services as exams_services  # noqa: E402
from apps.ingestion.models import (  # noqa: E402
    Asset,
    ImportCandidate,
    ImportJob,
    SourceDocument,
    SourceRegion,
)
from apps.ingestion.services import core as ingestion_core  # noqa: E402
from apps.ingestion.storage import get_storage, reset_storage_cache  # noqa: E402
from apps.practice.models import ExposureEvent, PracticeSession, SessionItem  # noqa: E402
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionSourceLink,
    QuestionVersion,
)
from apps.question_bank.services import sealing  # noqa: E402

OUT_JSON = ROOT / "docs" / "dsh-migration" / "12-ingestion-b3-probe.json"
TEST_DB_NAME = "test_acepass_b3_probe"
MEDIA_ROOT = Path("/tmp/acepass-b3-probe-media")

# Isolate from any parallel probe: the test database name is fixed *before* the database is created.
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

UNSET = object()
CASES: list[dict] = []
RAW_PAYLOADS: dict[str, object] = {}
SYMBOLS: dict[str, str] = {}
AUTO_NAMES: dict[str, str] = {}
EXPOSURES_SEEN: list[str] = []
CLIENT = Client()
ANON = Client()

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
REF_RE = re.compile(r"REF_\d{3}")
TIME_KEYS = {
    "created_at",
    "updated_at",
    "started_at",
    "finished_at",
    "reviewed_at",
    "published_at",
    "server_time",
    "revealed_at",
    "expired_at",
    "exam_started_at",
    "exam_deadline",
    "first_delivered_at",
    "draft_updated_at",
    "decided_at",
    "checked_at",
}


# ---------------------------------------------------------------------------
# Recording helpers
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


def name_unless_real(key: str, name: str) -> None:
    """Give a row a readable name unless it already has one; an auto ``REF_nnn`` does not count.

    ``REF_nnn`` was assigned when the id first reached the payload, before the fixture had a name,
    so overwriting it here is what lets the final ``remap`` turn every early ``REF_nnn`` into the
    real symbol.
    """
    current = SYMBOLS.get(key)
    if current is None or current.startswith("REF_"):
        SYMBOLS[key] = name


def sym(value) -> str | None:
    if value is None:
        return None
    return _auto_name(str(value))


def symbolize_text(text: str) -> str:
    """Replace every UUID inside a string by its symbolic name."""
    return UUID_RE.sub(lambda match: _auto_name(match.group(0)), text)


def scrub(value, key: str | None = None):
    """Recursively replace timestamps with ``<now>`` and UUIDs with symbols."""
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
    """Turn an early ``REF_nnn`` into the symbolic name the fixture received later."""
    if isinstance(value, dict):
        return {name: remap(item) for name, item in value.items()}
    if isinstance(value, list):
        return [remap(item) for item in value]
    if isinstance(value, str):
        return REF_RE.sub(
            lambda match: SYMBOLS.get(AUTO_NAMES.get(match.group(0), ""), match.group(0)), value
        )
    return value


def _key_repr(key) -> object:
    if key is UNSET:
        return None
    if len(key) > 30:
        return {"length": len(key), "prefix": key[:8]}
    return key


def _form_repr(value):
    """A multipart field summary: never the bytes, only names / types / sizes."""
    if isinstance(value, (list, tuple)):
        return [_form_repr(item) for item in value]
    if hasattr(value, "read") and hasattr(value, "name"):
        content = b""
        handle = getattr(value, "file", None)
        if handle is not None:
            position = handle.tell()
            handle.seek(0)
            content = handle.read()
            handle.seek(position)
        return {
            "filename": getattr(value, "name", ""),
            "content_type": getattr(value, "content_type", ""),
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    if isinstance(value, str):
        if len(value) > 40:
            return {"length": len(value), "prefix": value[:20]}
        return value
    return value


def call(
    case_id: str,
    op: str,
    title: str,
    *,
    method: str = "post",
    path: str,
    form: dict | None = None,
    query: dict | None = None,
    json_body=UNSET,
    key=UNSET,
    client: Client | None = None,
    download: bool = False,
    kind: str = "case",
) -> dict:
    headers: dict[str, str] = {}
    if key is not UNSET:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    http = client or CLIENT
    method_fn = getattr(http, method)
    if json_body is not UNSET:
        response = method_fn(path, data=json.dumps(json_body, ensure_ascii=False), content_type="application/json", **headers)
    elif form is not None:
        response = method_fn(path, form, **headers)
    elif query is not None:
        response = method_fn(path, data=query, **headers)
    else:
        response = method_fn(path, **headers)

    if getattr(response, "streaming", False):
        body = b"".join(response.streaming_content)
    else:
        body = response.content
    content_type = response.headers.get("Content-Type", "")
    payload = None
    if content_type.startswith("application/json") and body:
        try:
            payload = json.loads(body.decode("utf-8"))
        except ValueError:  # pragma: no cover - every JSON route round-trips
            payload = None

    # Kept unscrubbed so "is the replay byte-identical to the first answer" compares real bodies.
    RAW_PAYLOADS[case_id] = payload
    record = {
        "case": case_id,
        "op": op,
        "kind": kind,
        "title": title,
        "request": {
            "method": method.upper(),
            "path": symbolize_text(path),
            "query": scrub(query or {}),
            "form": scrub({name: _form_repr(value) for name, value in (form or {}).items()}),
            "json_body": None if json_body is UNSET else scrub(json_body),
            "idempotency_key": _key_repr(key),
        },
        "status": response.status_code,
        "response": scrub(payload),
        "response_field_order": list(payload) if isinstance(payload, dict) else None,
        "response_headers": {
            name: None if response.headers.get(name) is None else symbolize_text(response.headers.get(name))
            for name in ("Content-Type", "Content-Disposition", "X-Content-Type-Options", "Cache-Control")
        },
        "checks": {},
    }
    if payload is None and not download:
        record["response_raw"] = body.decode("utf-8", "replace")[:500]
    if isinstance(payload, dict) and "error" in payload:
        record["error_envelope"] = scrub(payload["error"])
    if download:
        record["body_sha256"] = hashlib.sha256(body).hexdigest()
        record["body_bytes"] = len(body)
        record["body_hex16"] = body[:16].hex()
    CASES.append(record)
    return record


def checks(record: dict, **values) -> dict:
    record["checks"].update(scrub(values))
    return record


def db_counts() -> dict:
    return {
        "audit_content_revision": ContentRevision.objects.count(),
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_llm_run": LLMRun.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "ingestion_asset": Asset.objects.count(),
        "ingestion_import_candidate": ImportCandidate.objects.count(),
        "ingestion_import_job": ImportJob.objects.count(),
        "ingestion_source_document": SourceDocument.objects.count(),
        "ingestion_source_region": SourceRegion.objects.count(),
        "practice_exposure_event": ExposureEvent.objects.count(),
        "question_bank_question": Question.objects.count(),
        "question_bank_question_version": QuestionVersion.objects.count(),
    }


def delta(before: dict, after: dict) -> dict:
    return {name: after[name] - before[name] for name in before if after[name] != before[name]}


def snapshot() -> dict:
    return {
        "exposure": set(ExposureEvent.objects.values_list("id", flat=True)),
        "asset": set(Asset.objects.values_list("id", flat=True)),
        "document": set(SourceDocument.objects.values_list("id", flat=True)),
    }


def new_rows(before: dict) -> dict:
    """The rows one call created: exposure events, assets and source documents (ids symbolised)."""
    now = snapshot()
    exposure_ids = sorted(now["exposure"] - before["exposure"])
    asset_ids = sorted(now["asset"] - before["asset"])
    document_ids = sorted(now["document"] - before["document"])
    for event_id in exposure_ids:
        EXPOSURES_SEEN.append(event_id)
        reg(f"EXPOSURE_{len(EXPOSURES_SEEN):02d}", event_id)
    return {
        "exposure_events": [
            exposure_row(event) for event in ExposureEvent.objects.filter(id__in=exposure_ids).order_by("created_at")
        ],
        "assets": [asset_row(asset) for asset in Asset.objects.filter(id__in=asset_ids).order_by("created_at")],
        "source_documents": [
            document_row(document)
            for document in SourceDocument.objects.filter(id__in=document_ids).order_by("created_at")
        ],
    }


def _d(value):
    return None if value is None else str(value)


# ---------------------------------------------------------------------------
# Row dumps
# ---------------------------------------------------------------------------
def key_shape(key: str) -> dict:
    """Shape of a server-generated object key; the key itself is never recorded."""
    parts = key.split("/")
    filename = parts[-1]
    stem, dot, suffix = filename.partition(".")
    return {
        "segments": len(parts),
        "namespace": parts[2] if len(parts) > 3 else "",
        "prefix_len": len(parts[-2]) if len(parts) > 2 else 0,
        "token_len": len(stem),
        "suffix": f".{suffix}" if dot else "",
    }


def asset_row(asset: Asset) -> dict:
    is_image = (asset.content_type or "").startswith("image/")
    return {
        "id": sym(asset.id),
        "project": sym(asset.project_id),
        "owner": sym(asset.owner_id),
        "role": asset.role,
        "sensitivity": asset.sensitivity,
        "content_type": asset.content_type,
        "size_bytes": asset.size_bytes,
        "width": asset.width,
        "height": asset.height,
        "checksum": "<reencoded>" if is_image else asset.checksum,
        "original_filename": asset.original_filename,
        "object_key_shape": key_shape(asset.object_key),
    }


def document_row(document: SourceDocument) -> dict:
    document_symbol = sym(document.id)
    if document.asset_id is not None:
        name_unless_real(str(document.asset_id), f"ASSET_OF_{document_symbol}")
    asset = document.asset
    is_image = document.document_type == "image"
    return {
        "id": document_symbol,
        "project": sym(document.project_id),
        "subject": sym(document.subject_id),
        "title": document.title,
        "document_type": document.document_type,
        "role": document.role,
        "sensitivity": document.sensitivity,
        "source_type": document.source_type,
        "source_note_length": len(document.source_note or ""),
        "usage_scope_length": len(document.usage_scope or ""),
        "checksum": "<reencoded>" if is_image else document.checksum,
        "checksum_matches_asset_checksum": asset is not None and document.checksum == asset.checksum,
        "asset": sym(document.asset_id),
        "raw_text_preview": (document.raw_text or "")[:40],
    }


def exposure_row(event: ExposureEvent) -> dict:
    return {
        "id": sym(event.id),
        "user": sym(event.user_id),
        "project": sym(event.project_id),
        "question": sym(event.question_id),
        "question_version": sym(event.question_version_id),
        "family": sym(event.family_id),
        "content_lineage": sym(event.content_lineage_id),
        "session_item": sym(event.session_item_id),
        "kind": event.kind,
        "purpose": event.purpose,
        "source": event.source,
        "server_time": "<now>",
        "detail": scrub(event.detail),
        "reveals_answer": event.reveals_answer,
    }


def job_row(job: ImportJob) -> dict:
    return {
        "id": sym(job.id),
        "status": job.status,
        "input_kind": job.input_kind,
        "extractor_version": job.extractor_version,
        "progress_percent": job.progress_percent,
        "subject": sym(job.subject_id),
        "duplicate_of": sym(job.duplicate_of_id),
        "document_ids": [sym(value) for value in job.documents.values_list("id", flat=True)],
        "candidate_count": job.candidates.count(),
        "candidate_statuses": sorted(job.candidates.values_list("status", flat=True)),
        "problems": job.problems,
    }


def candidate_row(candidate: ImportCandidate) -> dict:
    return {
        "id": sym(candidate.id),
        "job": sym(candidate.job_id),
        "status": candidate.status,
        "revision": candidate.revision,
        "is_stub_output": candidate.is_stub_output,
        "extractor_version": candidate.extractor_version,
        "draft_payload": candidate.draft_payload,
        "review_issues": [
            {"code": item.get("code"), "severity": item.get("severity")} for item in candidate.review_issues
        ],
        "source_regions": [
            {
                "role": region.role,
                "page_index": region.page_index,
                "x": region.x,
                "y": region.y,
                "width": region.width,
                "height": region.height,
                "document": sym(region.document_id),
                "crop_asset": sym(region.crop_asset_id),
            }
            for region in candidate.source_regions.all()
        ],
    }


def register_job_rows(case_id: str, job: ImportJob) -> None:
    """Give an import's job / documents / candidates stable names before they are dumped.

    Documents are reused across cases when the upload was a duplicate, so an existing name always
    wins (``setdefault``): the reused document keeps the name of the case that created it.
    """
    reg(f"JOB_{case_id}", job)
    documents = list(job.documents.order_by("created_at"))
    for index, document in enumerate(documents, start=1):
        suffix = "" if len(documents) == 1 else f"_{index}"
        name_unless_real(str(document.id), f"DOCUMENT_{case_id}{suffix}")
        if document.asset_id:
            name_unless_real(str(document.asset_id), f"ASSET_OF_DOCUMENT_{case_id}{suffix}")
    candidates = list(job.candidates.order_by("created_at"))
    for index, candidate in enumerate(candidates, start=1):
        suffix = "" if len(candidates) == 1 else f"_{index}"
        reg(f"CANDIDATE_{case_id}{suffix}", candidate)


def idempotency_row(key: str, scope: str) -> dict | None:
    record = IdempotencyRecord.objects.filter(idempotency_key=key, route_scope=scope).first()
    if record is None:
        return None
    return {
        "route_scope": record.route_scope,
        "idempotency_key": record.idempotency_key,
        "status_code": record.status_code,
        "resource_type": record.resource_type,
        "resource_id": sym(record.resource_id),
        "response_body_resource_id": sym((record.response_body or {}).get("id")),
        "response_body_keys": sorted(record.response_body or {}),
    }


def outbox_rows() -> list[dict]:
    return [
        {
            "topic": event.topic,
            "payload": event.payload,
            "dedupe_key": event.dedupe_key or "",
            "status": event.status,
            "attempts": event.attempts,
        }
        for event in OutboxEvent.objects.order_by("created_at")
    ]


def llm_run_rows() -> list[dict]:
    return [
        {
            "provider": run.provider,
            "capability": run.capability,
            "prompt_version": run.prompt_version,
            "status": run.status,
            "is_stub": run.is_stub,
            "project": sym(run.project_id),
            "user": sym(run.user_id),
            "request_summary_keys": sorted(run.request_summary or {}),
            "validation_result_keys": sorted(run.validation_result or {}),
        }
        for run in LLMRun.objects.order_by("created_at")
    ]


# ---------------------------------------------------------------------------
# Image fixtures (deterministic pixels; the only "random" source is a fixed seed)
# ---------------------------------------------------------------------------
def encode(image: Image.Image, fmt: str, **params) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **params)
    return buffer.getvalue()


def solid_png(tag: str) -> bytes:
    """A deterministic PNG that is unique per tag (so it never collides with another case)."""
    seed = zlib.crc32(tag.encode("utf-8"))
    size = (40 + seed % 17, 40 + (seed >> 5) % 13)
    color = (seed & 0xFF, (seed >> 8) & 0xFF, (seed >> 16) & 0xFF)
    return encode(Image.new("RGB", size, color), "PNG")


def tagged_png() -> bytes:
    """A PNG carrying a tEXt chunk: re-encoding drops it, so raw and stored bytes differ."""
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", "acepass-b3-probe")
    return encode(Image.new("RGB", (52, 44), (13, 21, 34)), "PNG", pnginfo=info)


def build_images() -> dict[str, bytes]:
    png = solid_png("shared-64x48")
    jpeg = encode(Image.new("RGB", (60, 40), (90, 90, 90)), "JPEG")
    exif = Image.Exif()
    exif[274] = 6  # Orientation = rotate 90 CW
    jpeg_exif = encode(Image.new("RGB", (120, 80), (210, 30, 30)), "JPEG", exif=exif.tobytes())
    # 1900x1900 RGB from a fixed seed: incompressible enough to exceed 10 MiB, identical every run.
    noise = random.Random(20260301).randbytes(1900 * 1900 * 3)
    return {
        "png": png,
        "jpeg_truncated": jpeg[: len(jpeg) // 2],
        "jpeg_exif6": jpeg_exif,
        "gif": encode(Image.new("P", (20, 20)), "GIF"),
        "bmp": encode(Image.new("RGB", (20, 20), (1, 2, 3)), "BMP"),
        "png_big": encode(Image.frombytes("RGB", (1900, 1900), noise), "PNG"),
        "png_huge": encode(Image.new("RGB", (6000, 5000), (5, 5, 5)), "PNG"),
        "text_bytes": b"not an image, just plain text",
    }


def upload(name: str, content: bytes, content_type: str) -> SimpleUploadedFile:
    return SimpleUploadedFile(name, content, content_type=content_type)


def stored_bytes(asset: Asset) -> bytes:
    with get_storage().open(asset.object_key) as handle:
        return handle.read()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
FIXED = {
    "QUESTION_PRACTICE": "11111111-1111-4111-8111-111111111111",
    "QUESTION_SEAL_A": "22222222-2222-4222-8222-222222222222",
    "QUESTION_SEAL_B": "33333333-3333-4333-8333-333333333333",
}


def make_question(subject, label: str, fixed_id: str) -> tuple[Question, QuestionVersion]:
    question = Question.objects.create(
        id=uuid.UUID(fixed_id),
        subject=subject,
        origin_type="user_authored",
        display_label=label,
        is_demo=False,
    )
    version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type="single_choice",
        content={"blocks": [{"kind": "text", "text": f"{label} 题干"}], "options": []},
        status="published",
    )
    return question, version


def make_session(user, project, subject, mode: str) -> PracticeSession:
    return PracticeSession.objects.create(user=user, project=project, subject=subject, mode=mode)


# ---------------------------------------------------------------------------
# Probe body
# ---------------------------------------------------------------------------
def build() -> dict:
    user_model = get_user_model()
    owner = user_model.objects.create_user(
        email="b3-probe-owner@example.test", password="ProbePass!2026", display_name="B3 探针"
    )
    other = user_model.objects.create_user(
        email="b3-probe-other@example.test", password="ProbePass!2026", display_name="另一位"
    )
    project_a = exams_services.create_project(owner, name="B3 探针项目A")
    project_b = exams_services.create_project(other, name="B3 探针项目B")
    subject_a1 = exams_services.create_subject(project_a, name="科目A1", total_score="100", pass_score="60")
    subject_b1 = exams_services.create_subject(project_b, name="科目B1", total_score="100", pass_score="60")

    for name, value in {
        "USER_OWNER": owner,
        "USER_OTHER": other,
        "PROJECT_A": project_a,
        "PROJECT_B": project_b,
        "SUBJECT_A1": subject_a1,
        "SUBJECT_B1": subject_b1,
    }.items():
        reg(name, value)

    images = build_images()
    CLIENT.force_login(owner)
    # O08 must first be observed on the manual path: this is the real capability switch, not a stub.
    settings.AI_PROVIDER = "none"

    p_a = f"/api/v1/projects/{project_a.id}"
    p_b = f"/api/v1/projects/{project_b.id}"
    assets_path = f"{p_a}/assets"
    image_source_path = f"{p_a}/source-documents/image"
    images_import_path = f"{p_a}/imports/images"

    # ================================================================== O01
    # ---------------------------------------------------------------- P01
    before, snap = db_counts(), snapshot()
    record = call(
        "P01",
        "O01",
        "默认 role 上传 PNG：201 与 AssetOut 全字段",
        path=assets_path,
        form={"file": upload("page-01.png", images["png"], "image/png")},
    )
    asset_p01 = Asset.objects.order_by("-created_at").first()
    reg("ASSET_P01", asset_p01)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        asset=asset_row(asset_p01),
        **new_rows(snap),
        response_size_bytes_equals_stored=asset_p01.size_bytes == record["response"]["size_bytes"],
        upload_sha256_equals_asset_checksum=hashlib.sha256(images["png"]).hexdigest() == asset_p01.checksum,
    )

    # ---------------------------------------------------------------- P02
    before, snap = db_counts(), snapshot()
    record = call(
        "P02",
        "O01",
        "role=answer_page：O01 仍写 public_to_owner",
        path=assets_path,
        form={"file": upload("answer-02.png", solid_png("P02"), "image/png"), "role": "answer_page"},
    )
    asset_p02 = Asset.objects.order_by("-created_at").first()
    reg("ASSET_P02", asset_p02)
    checks(record, row_delta=delta(before, db_counts()), asset=asset_row(asset_p02), **new_rows(snap))

    # ---------------------------------------------------------------- P03
    before, snap = db_counts(), snapshot()
    record = call(
        "P03",
        "O01",
        "role=stem_crop 的对象键命名空间",
        path=assets_path,
        form={"file": upload("crop-03.png", solid_png("P03"), "image/png"), "role": "stem_crop"},
    )
    asset_p03 = Asset.objects.order_by("-created_at").first()
    reg("ASSET_P03", asset_p03)
    checks(record, asset=asset_row(asset_p03), row_delta=delta(before, db_counts()), **new_rows(snap))

    # ---------------------------------------------------------------- P04
    record = call(
        "P04",
        "O01",
        "空文件",
        path=assets_path,
        form={"file": upload("empty.png", b"", "image/png")},
    )

    # ---------------------------------------------------------------- P05
    record = call(
        "P05",
        "O01",
        "role 不在枚举内",
        path=assets_path,
        form={"file": upload("bad-role.png", solid_png("P05"), "image/png"), "role": "bogus_role"},
    )

    # ---------------------------------------------------------------- P06
    record = call(
        "P06",
        "O01",
        "损坏字节（截断 JPEG）",
        path=assets_path,
        form={"file": upload("broken.jpg", images["jpeg_truncated"], "image/jpeg")},
    )

    # ---------------------------------------------------------------- P07
    record = call(
        "P07",
        "O01",
        "GIF：MIME 不在 allowlist",
        path=assets_path,
        form={"file": upload("anim.gif", images["gif"], "image/gif")},
    )

    # ---------------------------------------------------------------- P08
    record = call(
        "P08",
        "O01",
        "BMP：MIME 不在 allowlist",
        path=assets_path,
        form={"file": upload("plain.bmp", images["bmp"], "image/bmp")},
    )

    # ---------------------------------------------------------------- P09
    before, snap = db_counts(), snapshot()
    record = call(
        "P09",
        "O01",
        "PNG 字节声明为 image/jpeg：MIME 与真实格式不一致",
        path=assets_path,
        form={"file": upload("mismatch.jpg", solid_png("P09"), "image/jpeg")},
    )
    asset_p09 = Asset.objects.order_by("-created_at").first()
    reg("ASSET_P09", asset_p09)
    stored_p09 = stored_bytes(asset_p09)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        asset=asset_row(asset_p09),
        stored_magic_hex=stored_p09[:8].hex(),
        stored_is_png=stored_p09.startswith(b"\x89PNG\r\n\x1a\n"),
        stored_suffix_follows_declared_mime=asset_p09.object_key.endswith(".jpg"),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P10
    before, snap = db_counts(), snapshot()
    record = call(
        "P10",
        "O01",
        "text/plain 非图片字节",
        path=assets_path,
        form={"file": upload("note.txt", images["text_bytes"], "text/plain")},
    )
    asset_p10 = Asset.objects.order_by("-created_at").first()
    reg("ASSET_P10", asset_p10)
    checks(record, row_delta=delta(before, db_counts()), asset=asset_row(asset_p10), **new_rows(snap))

    # ---------------------------------------------------------------- P11
    record = call(
        "P11",
        "O01",
        "超过 10 MiB 的 PNG",
        path=assets_path,
        form={"file": upload("big.png", images["png_big"], "image/png")},
    )
    checks(record, uploaded_bytes=len(images["png_big"]))

    # ---------------------------------------------------------------- P12
    record = call(
        "P12",
        "O01",
        "6000×5000 超像素 PNG",
        path=assets_path,
        form={"file": upload("huge.png", images["png_huge"], "image/png")},
    )
    checks(record, uploaded_bytes=len(images["png_huge"]), pixels=6000 * 5000)

    # ---------------------------------------------------------------- P13
    long_name = "长" * 300 + ".png"
    record = call(
        "P13",
        "O01",
        "超长文件名截断到 255",
        path=assets_path,
        form={"file": upload(long_name, solid_png("P13"), "image/png")},
    )
    p13_asset = Asset.objects.order_by("-created_at").first()
    checks(
        record,
        requested_name_length=len(long_name),
        stored_name_length=len(p13_asset.original_filename),
        stored_name_prefix=p13_asset.original_filename[:12],
    )

    # ---------------------------------------------------------------- P14
    cn_name = '试卷 "第一页" 副本.png'
    record = call(
        "P14",
        "O01",
        "中文与引号文件名原样保留",
        path=assets_path,
        form={"file": upload(cn_name, solid_png("P14"), "image/png")},
    )
    p14_asset = Asset.objects.order_by("-created_at").first()
    checks(record, stored_name_equals_request=p14_asset.original_filename == cn_name)

    # ---------------------------------------------------------------- P15
    record = call("P15", "O01", "缺少 file 字段（Ninja 400 形状）", path=assets_path, form={})

    # ---------------------------------------------------------------- P16
    record = call("P16", "O01", "JSON body 打到 multipart 端点", path=assets_path, json_body={})

    # ---------------------------------------------------------------- P17
    record = call(
        "P17",
        "O01",
        "外来项目的 asset 上传",
        path=f"{p_b}/assets",
        form={"file": upload("foreign.png", solid_png("P17"), "image/png")},
    )

    # ---------------------------------------------------------------- P18
    record = call(
        "P18",
        "O01",
        "匿名上传",
        path=assets_path,
        form={"file": upload("anon.png", solid_png("P18"), "image/png")},
        client=ANON,
    )

    # ---------------------------------------------------------------- P19
    before = db_counts()
    record = call(
        "P19",
        "O01",
        "同一份字节第二次上传：不去重",
        path=assets_path,
        form={"file": upload("page-01-again.png", images["png"], "image/png")},
    )
    p19_asset = Asset.objects.order_by("-created_at").first()
    reg("ASSET_P19", p19_asset)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        asset=asset_row(p19_asset),
        checksum_equals_p01=p19_asset.checksum == asset_p01.checksum,
        object_key_equals_p01=p19_asset.object_key == asset_p01.object_key,
        assets_sharing_this_checksum=Asset.objects.filter(checksum=p19_asset.checksum).count(),
    )

    # ---------------------------------------------------------------- P20
    before, snap = db_counts(), snapshot()
    record = call(
        "P20",
        "O01",
        "带 EXIF Orientation=6 的 JPEG",
        path=assets_path,
        form={"file": upload("rotated.jpg", images["jpeg_exif6"], "image/jpeg")},
    )
    asset_p20 = Asset.objects.order_by("-created_at").first()
    reg("ASSET_P20", asset_p20)
    stored_p20 = stored_bytes(asset_p20)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        asset=asset_row(asset_p20),
        original_pixel_size=[120, 80],
        upload_sha256_equals_asset_checksum=hashlib.sha256(images["jpeg_exif6"]).hexdigest()
        == asset_p20.checksum,
        stored_has_exif_marker=b"Exif\x00\x00" in stored_p20,
        **new_rows(snap),
    )

    # ================================================================== O02
    # Download-gate fixtures. Assets go through the storage service (not O01) because O01 cannot set
    # `sensitivity`, and O05 (which can) is probed later in this file.
    def gated_asset(name: str, *, role: str = "answer_page", sensitivity: str = "contains_answers",
                    content: bytes | None = None, content_type: str = "image/png") -> Asset:
        created = ingestion_core.store_asset(
            owner=owner,
            project=project_a,
            content=content or solid_png(f"fixture-{name}"),
            content_type=content_type,
            role=role,
            sensitivity=sensitivity,
            original_filename=f"{name.lower()}.png",
        )
        reg(name, created)
        return created

    asset_answer = gated_asset("ASSET_ANSWER")
    asset_editorial = gated_asset("ASSET_EDITORIAL")
    asset_internal = gated_asset("ASSET_INTERNAL", role="user_attachment", sensitivity="internal_review")
    asset_unrelated = gated_asset("ASSET_UNRELATED", role="user_attachment", sensitivity="public_to_owner")
    asset_missing_bytes = gated_asset("ASSET_MISSING_BYTES", role="user_attachment", sensitivity="public_to_owner")

    question_practice, version_practice = make_question(subject_a1, "练习题", FIXED["QUESTION_PRACTICE"])
    reg("QUESTION_PRACTICE", question_practice)
    reg("VERSION_PRACTICE", version_practice)
    session_practice = make_session(owner, project_a, subject_a1, "practice")
    reg("SESSION_PRACTICE", session_practice)
    item_practice = SessionItem.objects.create(
        session=session_practice, ordinal=1, question_version=version_practice, max_score="2.00"
    )
    reg("ITEM_PRACTICE", item_practice)

    session_verification = make_session(owner, project_a, subject_a1, "verification")
    reg("SESSION_VERIFICATION", session_verification)
    item_verification = SessionItem.objects.create(
        session=session_verification, ordinal=1, question_version=version_practice, max_score="2.00"
    )
    reg("ITEM_VERIFICATION", item_verification)

    session_other = make_session(other, project_a, subject_a1, "practice")
    reg("SESSION_OTHER", session_other)
    item_other = SessionItem.objects.create(
        session=session_other, ordinal=1, question_version=version_practice, max_score="2.00"
    )
    reg("ITEM_OTHER", item_other)

    # ---------------------------------------------------------------- P21
    record = call(
        "P21",
        "O02",
        "public_to_owner 图片下载：200 与四个 header",
        method="get",
        path=f"{assets_path}/{asset_p01.id}",
        download=True,
    )
    checks(
        record,
        stored_sha256_matches_body=record["body_sha256"] == asset_p01.checksum,
        body_starts_with_png_magic=record["body_hex16"].startswith("89504e470d0a1a0a"),
        content_disposition_kind=(record["response_headers"]["Content-Disposition"] or "").split(";")[0],
    )

    # ---------------------------------------------------------------- P22
    record = call(
        "P22",
        "O02",
        "asset 不存在",
        method="get",
        path=f"{assets_path}/00000000-0000-4000-8000-000000000000",
    )

    # ---------------------------------------------------------------- P23
    record = call(
        "P23",
        "O02",
        "外来项目路径下载本人 asset",
        method="get",
        path=f"{p_b}/assets/{asset_p01.id}",
    )

    # ---------------------------------------------------------------- P24
    get_storage().delete(asset_missing_bytes.object_key)
    before, snap = db_counts(), snapshot()
    record = call(
        "P24",
        "O02",
        "磁盘缺字节（asset 行仍在）",
        method="get",
        path=f"{assets_path}/{asset_missing_bytes.id}",
    )
    checks(
        record,
        asset_exists_in_db=Asset.objects.filter(id=asset_missing_bytes.id).exists(),
        stored_bytes_present=get_storage().exists(asset_missing_bytes.object_key),
        row_delta=delta(before, db_counts()),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P25
    before, snap = db_counts(), snapshot()
    record = call(
        "P25",
        "O02",
        "contains_answers + practice session_item：200 且写 exposure",
        method="get",
        path=f"{assets_path}/{asset_answer.id}",
        query={"session_item_id": str(item_practice.id)},
        download=True,
    )
    checks(record, row_delta=delta(before, db_counts()), **new_rows(snap))

    # ---------------------------------------------------------------- P26
    before, snap = db_counts(), snapshot()
    record = call(
        "P26",
        "O02",
        "verification 活动会话的 session_item",
        method="get",
        path=f"{assets_path}/{asset_answer.id}",
        query={"session_item_id": str(item_verification.id)},
    )
    checks(record, row_delta=delta(before, db_counts()), **new_rows(snap))

    # ---------------------------------------------------------------- P27
    before, snap = db_counts(), snapshot()
    record = call(
        "P27",
        "O02",
        "无 session，但项目有未结束的 verification",
        method="get",
        path=f"{assets_path}/{asset_answer.id}",
    )
    checks(record, row_delta=delta(before, db_counts()), **new_rows(snap))

    # ---------------------------------------------------------------- P28
    before, snap = db_counts(), snapshot()
    record = call(
        "P28",
        "O02",
        "purpose=editorial 且有未结束 verification",
        method="get",
        path=f"{assets_path}/{asset_editorial.id}",
        query={"purpose": "editorial"},
    )
    checks(record, row_delta=delta(before, db_counts()), **new_rows(snap))

    # End the verification run; editorial and session-less downloads become reachable again.
    session_verification.status = "finished"
    session_verification.save(update_fields=["status", "updated_at"])

    # ---------------------------------------------------------------- P29
    before, snap = db_counts(), snapshot()
    record = call(
        "P29",
        "O02",
        "purpose=editorial 且无 verification：200",
        method="get",
        path=f"{assets_path}/{asset_editorial.id}",
        query={"purpose": "editorial"},
        download=True,
    )
    checks(record, row_delta=delta(before, db_counts()), **new_rows(snap))

    # ---------------------------------------------------------------- P30
    record = call(
        "P30",
        "O02",
        "session_item 属于别的用户",
        method="get",
        path=f"{assets_path}/{asset_answer.id}",
        query={"session_item_id": str(item_other.id)},
    )

    # ---------------------------------------------------------------- P31
    before, snap = db_counts(), snapshot()
    record = call(
        "P31",
        "O02",
        "purpose 非法值：exposure 回落到 practice",
        method="get",
        path=f"{assets_path}/{asset_answer.id}",
        query={"purpose": "bogus_purpose", "session_item_id": str(item_practice.id)},
        download=True,
    )
    checks(record, row_delta=delta(before, db_counts()), **new_rows(snap))

    # ---------------------------------------------------------------- P32
    record = call(
        "P32",
        "O02",
        "internal_review 资产 + 非 staff",
        method="get",
        path=f"{assets_path}/{asset_internal.id}",
    )

    # ---------------------------------------------------------------- sealing fixtures (needed by P33)
    document_sealed = SourceDocument.objects.create(
        owner=owner,
        project=project_a,
        subject=subject_a1,
        title="封存页",
        document_type="image",
        role="answer_page",
        sensitivity="contains_answers",
        asset=asset_answer,
        checksum=asset_answer.checksum,
        source_type="user_upload",
    )
    reg("DOCUMENT_SEALED_PAGE", document_sealed)
    question_seal_a, version_seal_a = make_question(subject_a1, "封存甲", FIXED["QUESTION_SEAL_A"])
    reg("QUESTION_SEAL_A", question_seal_a)
    reg("VERSION_SEAL_A", version_seal_a)
    question_seal_b, version_seal_b = make_question(subject_a1, "封存乙", FIXED["QUESTION_SEAL_B"])
    reg("QUESTION_SEAL_B", question_seal_b)
    reg("VERSION_SEAL_B", version_seal_b)

    asset_sealed_crop = gated_asset("ASSET_SEALED_CROP")
    asset_sealed_key = gated_asset("ASSET_SEALED_KEY", role="answer_crop")
    asset_sealed_block = gated_asset("ASSET_SEALED_BLOCK")
    asset_sealed_page = gated_asset("ASSET_SEALED_PAGE", role="past_paper_page", sensitivity="public_to_owner")
    asset_sealed_two = gated_asset("ASSET_SEALED_TWO")

    region_crop = SourceRegion.objects.create(
        document=document_sealed,
        page_index=1,
        x=0.0,
        y=0.0,
        width=0.5,
        height=0.5,
        crop_asset=asset_sealed_crop,
        role="stem_crop",
        text_span="封存题干",
    )
    reg("REGION_CROP", region_crop)
    QuestionSourceLink.objects.create(question_version=version_seal_a, region=region_crop, role="stem")
    sealing.seal_question(project=project_a, question=question_seal_a, actor=owner, reason="B3 探针封存甲")

    # ---------------------------------------------------------------- P33
    record = call(
        "P33",
        "O02",
        "封存关联①：crop region 的 crop_asset",
        method="get",
        path=f"{assets_path}/{asset_sealed_crop.id}",
    )

    # ---------------------------------------------------------------- P34
    document_whole_page = SourceDocument.objects.create(
        owner=owner,
        project=project_a,
        subject=subject_a1,
        title="整页封存",
        document_type="image",
        role="past_paper_page",
        sensitivity="public_to_owner",
        asset=asset_sealed_page,
        checksum=asset_sealed_page.checksum,
        source_type="user_upload",
    )
    reg("DOCUMENT_WHOLE_PAGE", document_whole_page)
    region_page = SourceRegion.objects.create(
        document=document_whole_page,
        page_index=1,
        x=0.0,
        y=0.0,
        width=1.0,
        height=1.0,
        role="stem_crop",
        text_span="整页题干",
    )
    QuestionSourceLink.objects.create(question_version=version_seal_a, region=region_page, role="stem")
    record = call(
        "P34",
        "O02",
        "封存关联②：整页 document.asset",
        method="get",
        path=f"{assets_path}/{asset_sealed_page.id}",
    )

    # ---------------------------------------------------------------- P35
    region_answer_key = SourceRegion.objects.create(
        document=document_sealed,
        page_index=1,
        x=0.1,
        y=0.1,
        width=0.3,
        height=0.3,
        crop_asset=asset_sealed_key,
        role="answer_crop",
        text_span="答案",
    )
    AnswerKeyVersion.objects.create(
        question_version=version_seal_a,
        version=1,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
        source_region=region_answer_key,
    )
    record = call(
        "P35",
        "O02",
        "封存关联③：AnswerKeyVersion.source_region 的 crop_asset",
        method="get",
        path=f"{assets_path}/{asset_sealed_key.id}",
    )

    # ---------------------------------------------------------------- P36
    version_seal_a.content = {"blocks": [{"kind": "image", "asset_id": str(asset_sealed_block.id)}]}
    version_seal_a.save(update_fields=["content", "updated_at"])
    record = call(
        "P36",
        "O02",
        "封存关联④：封存题版本的 image block",
        method="get",
        path=f"{assets_path}/{asset_sealed_block.id}",
    )

    # ---------------------------------------------------------------- P37
    region_two_a = SourceRegion.objects.create(
        document=document_sealed, page_index=1, x=0.0, y=0.6, width=0.2, height=0.2,
        crop_asset=asset_sealed_two, role="stem_crop", text_span="甲",
    )
    region_two_b = SourceRegion.objects.create(
        document=document_sealed, page_index=2, x=0.0, y=0.0, width=0.2, height=0.2,
        crop_asset=asset_sealed_two, role="stem_crop", text_span="乙",
    )
    QuestionSourceLink.objects.create(question_version=version_seal_a, region=region_two_a, role="stem")
    QuestionSourceLink.objects.create(question_version=version_seal_b, region=region_two_b, role="stem")
    sealing.seal_question(project=project_a, question=question_seal_b, actor=owner, reason="B3 探针封存乙")
    record = call(
        "P37",
        "O02",
        "多道封存题：报哪一道（按 question id 排序的第一道）",
        method="get",
        path=f"{assets_path}/{asset_sealed_two.id}",
    )
    checks(
        record,
        # The two sealed questions carry fixed uuids (2222... / 3333...), so "which one is reported"
        # is a stable fact: the resolver sorts question ids and takes the first.
        reported_question=(record.get("error_envelope") or {}).get("details", {}).get("question_id"),
        reported_question_is_the_lower_id=(
            (record.get("error_envelope") or {}).get("details", {}).get("question_id") == "QUESTION_SEAL_A"
        ),
    )

    # ---------------------------------------------------------------- P38
    record = call(
        "P38",
        "O02",
        "与封存题完全无关的用户附件：200",
        method="get",
        path=f"{assets_path}/{asset_unrelated.id}",
        download=True,
    )
    checks(record, content_disposition_kind=(record["response_headers"]["Content-Disposition"] or "").split(";")[0])

    # ---------------------------------------------------------------- P39
    record = call(
        "P39",
        "O02",
        "非图片 asset 的 disposition 是 attachment",
        method="get",
        path=f"{assets_path}/{asset_p10.id}",
        download=True,
    )
    checks(
        record,
        content_disposition_kind=(record["response_headers"]["Content-Disposition"] or "").split(";")[0],
        body_equals_uploaded_text=record["body_sha256"] == hashlib.sha256(images["text_bytes"]).hexdigest(),
    )

    # ================================================================== O05
    # ---------------------------------------------------------------- P40
    before, snap = db_counts(), snapshot()
    record = call(
        "P40",
        "O05",
        "正常图片来源：201 与 Document 全字段",
        path=image_source_path,
        form={
            "file": upload("source-40.png", solid_png("P40"), "image/png"),
            "title": "B3 来源标题",
            "source_note": "2025 真题扫描",
            "usage_scope": "内部校对",
            "subject_id": str(subject_a1.id),
        },
    )
    document_p40 = SourceDocument.objects.order_by("-created_at").first()
    reg("DOCUMENT_P40", document_p40)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        document=document_row(document_p40),
        asset=asset_row(document_p40.asset),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P41
    before, snap = db_counts(), snapshot()
    record = call(
        "P41",
        "O05",
        "role=answer_page 时 sensitivity=contains_answers",
        path=image_source_path,
        form={"file": upload("source-41.png", solid_png("P41"), "image/png"), "role": "answer_page"},
    )
    document_p41 = SourceDocument.objects.order_by("-created_at").first()
    reg("DOCUMENT_P41", document_p41)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        document=document_row(document_p41),
        asset=asset_row(document_p41.asset),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P42
    record = call(
        "P42",
        "O05",
        "role 非法：来源角色无效",
        path=image_source_path,
        form={"file": upload("source-42.png", solid_png("P42"), "image/png"), "role": "answer_crop_typo"},
    )

    # ---------------------------------------------------------------- P43
    record = call(
        "P43",
        "O05",
        "空文件",
        path=image_source_path,
        form={"file": upload("source-43.png", b"", "image/png")},
    )

    # ---------------------------------------------------------------- P44
    before, snap = db_counts(), snapshot()
    record = call(
        "P44",
        "O05",
        "非图片 MIME（text/plain）现状",
        path=image_source_path,
        form={"file": upload("source-44.txt", images["text_bytes"], "text/plain")},
    )
    document_p44 = SourceDocument.objects.order_by("-created_at").first()
    reg("DOCUMENT_P44", document_p44)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        document=document_row(document_p44),
        asset=asset_row(document_p44.asset),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P45
    record = call(
        "P45",
        "O05",
        "GIF：store_asset 的图片 MIME allowlist",
        path=image_source_path,
        form={"file": upload("source-45.gif", images["gif"], "image/gif")},
    )

    # ---------------------------------------------------------------- P46
    record = call(
        "P46",
        "O05",
        "title/source_note/usage_scope 的 300/500/200 截断",
        path=image_source_path,
        form={
            "file": upload("source-46.png", solid_png("P46"), "image/png"),
            "title": "题" * 400,
            "source_note": "注" * 600,
            "usage_scope": "用" * 300,
        },
    )
    document_p46 = SourceDocument.objects.order_by("-created_at").first()
    checks(
        record,
        requested_lengths={"title": 400, "source_note": 600, "usage_scope": 300},
        stored_lengths={
            "title": len(document_p46.title),
            "source_note": len(document_p46.source_note),
            "usage_scope": len(document_p46.usage_scope),
        },
    )

    # ---------------------------------------------------------------- P47
    record = call(
        "P47",
        "O05",
        "跨项目 subject_id",
        path=image_source_path,
        form={"file": upload("source-47.png", solid_png("P47"), "image/png"), "subject_id": str(subject_b1.id)},
    )

    # ---------------------------------------------------------------- P48
    record = call(
        "P48",
        "O05",
        "subject_id 为空串 → null",
        path=image_source_path,
        form={"file": upload("source-48.png", solid_png("P48"), "image/png"), "subject_id": ""},
    )

    # ---------------------------------------------------------------- P49
    record = call(
        "P49",
        "O05",
        "外来项目上传图片来源",
        path=f"{p_b}/source-documents/image",
        form={"file": upload("source-49.png", solid_png("P49"), "image/png")},
    )

    # ================================================================== O08
    # ---------------------------------------------------------------- P50
    before, snap = db_counts(), snapshot()
    record = call(
        "P50",
        "O08",
        "单张图片导入（AI_PROVIDER=none，manual 路径）",
        path=images_import_path,
        form={"files": upload("import-50.png", solid_png("P50"), "image/png")},
        key="b3-img-single",
    )
    job_p50 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P50", job_p50)
    candidate_p50 = job_p50.candidates.first()
    checks(
        record,
        row_delta=delta(before, db_counts()),
        job=job_row(job_p50),
        candidate=candidate_row(candidate_p50),
        document=document_row(job_p50.documents.first()),
        idempotency_record=idempotency_row("b3-img-single", f"imports.create_images:{project_a.id}"),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P51
    before, snap = db_counts(), snapshot()
    record = call(
        "P51",
        "O08",
        "两张图片导入",
        path=images_import_path,
        form={
            "files": [
                upload("import-51a.png", solid_png("P51a"), "image/png"),
                upload("import-51b.png", solid_png("P51b"), "image/png"),
            ]
        },
        key="b3-img-two",
    )
    job_p51 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P51", job_p51)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        job=job_row(job_p51),
        candidates=[candidate_row(candidate) for candidate in job_p51.candidates.order_by("created_at")],
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P52
    # "完全重复" means the raw upload checksum equals a stored Document.checksum, and the Document
    # stores the *re-encoded* bytes, so the stored object is uploaded back.
    duplicate_document = document_p41
    duplicate_bytes = stored_bytes(duplicate_document.asset)
    before, snap = db_counts(), snapshot()
    record = call(
        "P52",
        "O08",
        "与已有 document 完全重复：复用 duplicates，不新建 document",
        path=images_import_path,
        form={
            "files": upload("dup-52.png", duplicate_bytes, "image/png"),
            "role": "answer_page",
            "subject_id": str(subject_a1.id),
        },
        key="b3-img-duplicate",
    )
    job_p52 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P52", job_p52)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        job=job_row(job_p52),
        duplicate_document=document_row(SourceDocument.objects.get(id=duplicate_document.id)),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P53
    # The counterpart: the same *original* bytes do not hit the dedupe when re-encoding strips a
    # PNG tEXt chunk, because the Document stores the re-encoded checksum.
    tagged = tagged_png()
    tagged_document = ingestion_core.create_image_document(
        owner=owner,
        project=project_a,
        content=tagged,
        content_type="image/png",
        role="past_paper_page",
        title="带 tEXt 的图",
        original_filename="tagged-53.png",
    )
    reg("DOCUMENT_TAGGED", tagged_document)
    before = db_counts()
    record = call(
        "P53",
        "O08",
        "同一份原始字节再走 O08：未命中重复（document 存的是重编码 checksum）",
        path=images_import_path,
        form={"files": upload("tagged-53.png", tagged, "image/png")},
        key="b3-img-original-bytes",
    )
    job_p53 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P53", job_p53)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        job=job_row(job_p53),
        raw_sha256=hashlib.sha256(tagged).hexdigest(),
        tagged_document_raw_checksum_differs=tagged_document.checksum
        != hashlib.sha256(tagged).hexdigest(),
        imported_document_is_a_second_copy=job_p53.documents.count() == 1
        and job_p53.documents.first().id != tagged_document.id,
    )

    # ---------------------------------------------------------------- P54
    before = db_counts()
    record = call(
        "P54",
        "O08",
        "新旧混合：只导入新的",
        path=images_import_path,
        form={
            "files": [
                upload("mixed-new-54.png", solid_png("P54"), "image/png"),
                upload("mixed-old-54.png", duplicate_bytes, "image/png"),
            ]
        },
        key="b3-img-mixed",
    )
    job_p54 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P54", job_p54)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        job=job_row(job_p54),
        imported_document_is_new=all(
            document.checksum != duplicate_document.checksum for document in job_p54.documents.all()
        ),
    )

    # ---------------------------------------------------------------- P55
    before = db_counts()
    record = call(
        "P55",
        "O08",
        "files 为空列表",
        path=images_import_path,
        form={"files": []},
        key="b3-img-empty",
    )
    checks(record, row_delta=delta(before, db_counts()))

    # ---------------------------------------------------------------- P56
    before = db_counts()
    record = call(
        "P56",
        "O08",
        "其中一张损坏：claim 前校验，零写入",
        path=images_import_path,
        form={
            "files": [
                upload("good-56.png", solid_png("P56"), "image/png"),
                upload("broken-56.jpg", images["jpeg_truncated"], "image/jpeg"),
            ]
        },
        key="b3-img-broken",
    )
    checks(
        record,
        row_delta=delta(before, db_counts()),
        idempotency_record=idempotency_row("b3-img-broken", f"imports.create_images:{project_a.id}"),
    )

    # ---------------------------------------------------------------- P57
    before = db_counts()
    record = call(
        "P57",
        "O08",
        "缺少 Idempotency-Key",
        path=images_import_path,
        form={"files": upload("nokey-57.png", solid_png("P57"), "image/png")},
    )
    checks(record, row_delta=delta(before, db_counts()))

    # ---------------------------------------------------------------- P58
    replay_image = solid_png("P58")
    before = db_counts()
    first = call(
        "P58",
        "O08",
        "同键同载荷第一次",
        path=images_import_path,
        form={"files": upload("replay-58.png", replay_image, "image/png")},
        key="b3-img-replay",
    )
    job_p58 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P58", job_p58)
    checks(first, row_delta=delta(before, db_counts()))

    # ---------------------------------------------------------------- P59
    before = db_counts()
    record = call(
        "P59",
        "O08",
        "同键同载荷重放：返回存储结果，零写入",
        path=images_import_path,
        form={"files": upload("replay-58.png", replay_image, "image/png")},
        key="b3-img-replay",
    )
    checks(
        record,
        row_delta=delta(before, db_counts()),
        replay_body_equals_first=RAW_PAYLOADS["P59"] == RAW_PAYLOADS["P58"],
        job_id_in_replay=(record["response"] or {}).get("id"),
    )

    # ---------------------------------------------------------------- P60
    before = db_counts()
    record = call(
        "P60",
        "O08",
        "同键不同 checksums",
        path=images_import_path,
        form={"files": upload("other-60.png", solid_png("P60"), "image/png")},
        key="b3-img-replay",
    )
    checks(record, row_delta=delta(before, db_counts()))

    # ---------------------------------------------------------------- P61
    title_image = solid_png("P61")
    before = db_counts()
    first = call(
        "P61",
        "O08",
        "title 不参与指纹：换 title 前的第一次",
        path=images_import_path,
        form={"files": upload("title-61.png", title_image, "image/png"), "title": "标题甲"},
        key="b3-img-title",
    )
    job_p61 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P61", job_p61)
    checks(first, row_delta=delta(before, db_counts()))

    # ---------------------------------------------------------------- P62
    before = db_counts()
    record = call(
        "P62",
        "O08",
        "同键同图、仅 title 不同：仍然 replay",
        path=images_import_path,
        form={"files": upload("title-61.png", title_image, "image/png"), "title": "标题乙"},
        key="b3-img-title",
    )
    checks(
        record,
        row_delta=delta(before, db_counts()),
        replay_body_equals_first=RAW_PAYLOADS["P62"] == RAW_PAYLOADS["P61"],
    )

    # ---------------------------------------------------------------- P63
    before, snap = db_counts(), snapshot()
    record = call(
        "P63",
        "O08",
        "role=answer_page 的 sensitivity",
        path=images_import_path,
        form={
            "files": upload("answer-63.png", solid_png("P63"), "image/png"),
            "role": "answer_page",
            "subject_id": str(subject_a1.id),
        },
        key="b3-img-answer",
    )
    job_p63 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P63", job_p63)
    checks(
        record,
        row_delta=delta(before, db_counts()),
        job=job_row(job_p63),
        document=document_row(job_p63.documents.first()),
        **new_rows(snap),
    )

    # ---------------------------------------------------------------- P64
    # Vision branch: AI_PROVIDER="stub" is the test-settings default and supports extract_question.
    # Owned by B5; this batch only records what the current Django code does.
    settings.AI_PROVIDER = "stub"
    before, snap = db_counts(), snapshot()
    record = call(
        "P64",
        "O08",
        "stub 视觉分支（B5）：image_ai + 排队 + outbox + LLMRun",
        path=images_import_path,
        form={
            "files": upload("vision-64.png", solid_png("P64"), "image/png"),
            "title": "视觉导入",
        },
        key="b3-img-vision",
    )
    job_p64 = ImportJob.objects.order_by("-created_at").first()
    register_job_rows("P64", job_p64)
    candidate_p64 = job_p64.candidates.first()
    candidate_p64.refresh_from_db()
    job_p64.refresh_from_db()
    checks(
        record,
        row_delta=delta(before, db_counts()),
        job_after_dispatch=job_row(job_p64),
        candidate_after_dispatch=candidate_row(candidate_p64),
        outbox_after_dispatch=outbox_rows(),
        llm_runs_after_dispatch=llm_run_rows(),
        **new_rows(snap),
    )
    settings.AI_PROVIDER = "none"

    return {
        "cases": CASES,
        "fixtures": {
            "projects": {"PROJECT_A": "owner", "PROJECT_B": "other"},
            "subjects": ["SUBJECT_A1", "SUBJECT_B1"],
            "sessions": {
                "SESSION_PRACTICE": {"mode": "practice", "status": "active", "items": ["ITEM_PRACTICE"]},
                "SESSION_VERIFICATION": {
                    "mode": "verification",
                    "status": "active until P28, finished before P29",
                    "items": ["ITEM_VERIFICATION"],
                },
                "SESSION_OTHER": {"owner": "USER_OTHER", "mode": "practice", "items": ["ITEM_OTHER"]},
            },
            "fixed_question_ids": FIXED,
            "ai_provider": {"O08 manual cases": "none", "P64 vision case": "stub"},
            "image_fixtures": {
                "solid_png(tag)": "deterministic solid-colour PNG derived from zlib.crc32(tag)",
                "tagged_png()": "52x44 PNG with a tEXt chunk (re-encoding strips it)",
                "jpeg_truncated": "60x40 JPEG cut at 50% of its bytes",
                "jpeg_exif6": "120x80 JPEG with EXIF Orientation=6",
                "gif": "20x20 GIF87a",
                "bmp": "20x20 BMP",
                "png_big": "1900x1900 RGB from random.Random(20260301), >10 MiB",
                "png_huge": "6000x5000 solid PNG (30,000,000 pixels)",
                "text_bytes": "plain UTF-8 text",
            },
        },
        "symbol_names": sorted(set(SYMBOLS.values())),
        "symbol_count": len(set(SYMBOLS.values())),
    }


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        if MEDIA_ROOT.exists():
            shutil.rmtree(MEDIA_ROOT)
        MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
        settings.PRIVATE_MEDIA_ROOT = str(MEDIA_ROOT)
        settings.MEDIA_ROOT = str(MEDIA_ROOT)
        reset_storage_cache()
        payload = build()
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = remap(payload)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT_JSON} ({len(payload['cases'])} cases)")
    for case in payload["cases"]:
        print(f"  {case['case']:>4} {case['op']} {case['status']}  {case['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
