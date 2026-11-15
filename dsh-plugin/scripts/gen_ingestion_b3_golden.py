#!/usr/bin/env python
"""Golden vectors for B3: private storage, image re-encode, download gates and O01/O05/O08.

Oracle: the *real* `apps.ingestion.services.core` / `.storage` / `.access` /
`.imports` functions and the *real* Django views (`upload_asset`,
`create_image_source`, `download_asset`) driven through `django.test.Client`
against a throw-away PostgreSQL database. Nothing in this file re-implements a
rule: every `expected` block is what Django produced. Where a value is
inherently non-deterministic (a server-generated `object_key`, the bytes Pillow
emits for a re-encode, the wall clock) it is replaced by a stable placeholder and
the *properties* that a port must preserve are recorded next to it — the same
split the spec asks for in §5.1 ("properties, not byte equality").

Layout:

    {"images": {name: {content_type, base64, sha256, bytes, format, width, height}},
     "store": [...], "keys": [...], "dedupe": [...], "gates": [...],
     "downloads": [...], "assets": [...], "image_sources": [...], "image_imports": [...]}

`images[name]` carries the *input* bytes the Node test replays: `base64` is the
content, `bytes` is its length, `sha256` its digest. `oversize_bytes` is the one
exception — embedding 10 MiB in a golden file is pointless, so it is described by
`synthetic: {kind: "zeros", length: N}` instead of `base64` (its `sha256` is still
exact).

Row dumps are `model._meta.concrete_fields` keyed by `field.attname`, exactly like
`gen_ingestion_publish_golden.py`. **Only rows this generator creates** are dumped
(`uuid5` ids, `BASE + n minutes` timestamps): rows a service creates get a random
`uuid4` primary key, so they cannot be seeded from a fixture and would break the
"rerun is byte-identical" rule. Those rows are described instead by the real
projection (`_asset_out` / `_document_out` / `job_summary` / `candidate_summary`)
with their generated ids replaced by placeholders, numbered in creation order.

Placeholder vocabulary (both in `expected` and, via `symbols`, everywhere a seed
row id is mentioned):

    <asset:n> <document:n> <candidate:n> <region:n> <job> <exposure:n>  generated ids
    ASSET DOC PROJECT SUBJECT USER QUESTION V1 ...                      seed row ids (`symbols`)
    <object_key> <stored_sha256> <stored_size>                           non-deterministic storage facts
    <now>                                                               the wall clock inside a JSON column

For seeded `ingestion_asset` rows the object key is a real, reproducible
`build_key`-shaped key (fixed token), so the Node test can write the bytes at the
same path; only service-generated keys are masked. Downloads serve exactly the
fixture bytes, so their `body.sha256` is a real digest rather than a placeholder.

O08 is exercised through the manual-degradation path only:
`start_image_import(..., use_vision=False)`. The vision branch is B5 and is not
covered here; with a provider configured the same entry point would enqueue an
extraction task, which this fixture deliberately never does. The O08 wrapper
repeats the body of `apps.ingestion.api.create_image_import` (validate → checksum
→ duplicate lookup → create document → start import → duplicate problem) because
the HTTP handler cannot pass `use_vision`; every call inside it is the real
service function.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_ingestion_b3_golden.py
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.core.exceptions import ValidationError  # noqa: E402
from django.core.files.uploadedfile import SimpleUploadedFile  # noqa: E402
from django.db import connection  # noqa: E402
from django.http import Http404  # noqa: E402
from django.test import Client  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from PIL import Image  # noqa: E402
from PIL import ImageChops  # noqa: E402

from apps.audit.models import ContentRevision, OutboxEvent  # noqa: E402
from apps.common.errors import AcePassError  # noqa: E402
from apps.exams.models import ExamProject, Subject  # noqa: E402
from apps.ingestion.api import _asset_out, _document_out  # noqa: E402
from apps.ingestion.models import (  # noqa: E402
    Asset,
    CandidateRevision,
    ImportCandidate,
    ImportJob,
    SourceDocument,
    SourceRegion,
)
from apps.ingestion.services import access as asset_access  # noqa: E402
from apps.ingestion.services import imports as import_services  # noqa: E402
from apps.ingestion.services.core import (  # noqa: E402
    add_job_problem,
    create_image_document,
    file_checksum,
    find_duplicate_document,
    store_asset,
    validate_image,
)
from apps.ingestion.services.imports import candidate_summary, job_summary  # noqa: E402
from apps.ingestion.storage import build_key, get_storage, reset_storage_cache  # noqa: E402
from apps.practice.models import ExposureEvent, PracticeSession, SessionItem  # noqa: E402
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    ContentLineage,
    Question,
    QuestionFamily,
    QuestionPoolPolicy,
    QuestionSourceLink,
    QuestionVersion,
)

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "ingestion_b3.json"

#: Every timestamp in the fixture is derived from this instant, never from the wall clock.
BASE = datetime(2026, 4, 1, 0, 0, tzinfo=timezone.utc)

#: The throw-away private storage root (recreated on every run).
MEDIA_ROOT = Path("/tmp/acepass-b3-golden-media")

TEST_DB_NAME = "test_acepass_b3_golden"

PIN_NAMES = ("created_at", "updated_at", "date_joined")

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

STORE_PLACEHOLDER_SUM = "<stored_sha256>"
STORE_PLACEHOLDER_SIZE = "<stored_size>"
OBJECT_KEY_PLACEHOLDER = "<object_key>"
NOW_PLACEHOLDER = "<now>"


# --------------------------------------------------------------------------
# serialisation helpers
# --------------------------------------------------------------------------
def jsonable(value):
    """One model value as the JSON scalar the Node port will see."""
    if value is None:
        return None
    # bool before int: `bool` is an `int` subclass.
    if isinstance(value, bool):
        return value
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (int, float, str)):
        return value
    return str(value)


def dump_row(obj) -> dict:
    """Every concrete column of one row, keyed by `field.attname` (FKs as `<name>_id`)."""
    return {field.attname: jsonable(getattr(obj, field.attname)) for field in obj._meta.concrete_fields}


def deep_json(value):
    """Recursively convert UUID/Decimal/datetime so the payload is plain JSON."""
    if isinstance(value, dict):
        return {key: deep_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [deep_json(item) for item in value]
    return jsonable(value)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def err_record(exc: Exception) -> dict:
    """The wire-visible facts of a refusal (or of a Django validation error)."""
    if isinstance(exc, AcePassError):
        return {
            "ok": False,
            "error": {
                "kind": "acepass",
                "class": type(exc).__name__,
                "status": exc.status_code,
                "code": exc.code,
                "message": exc.message,
                "details": jsonable(exc.details),
            },
        }
    if isinstance(exc, ValidationError):
        return {
            "ok": False,
            "error": {
                "kind": "django_validation",
                "class": "ValidationError",
                "status": 422,
                "code": "structure_invalid",
                "message": "结构校验失败",
                "details": {
                    "errors": jsonable(exc.message_dict if hasattr(exc, "message_dict") else exc.messages)
                },
            },
        }
    if isinstance(exc, Http404):
        return {
            "ok": False,
            "error": {
                "kind": "http404",
                "class": "Http404",
                "status": 404,
                "code": "not_found",
                "message": "对象不存在或不在当前权限范围",
                "details": {},
            },
        }
    raise AssertionError(f"unexpected exception {type(exc).__name__}: {exc}")


def run(fn):
    """`(value, None)` or `(None, error_record)` for one service call."""
    try:
        return fn(), None
    except (AcePassError, ValidationError, Http404) as exc:
        return None, err_record(exc)


# --------------------------------------------------------------------------
# deterministic image fixtures
# --------------------------------------------------------------------------
def _png_bytes(image: Image.Image, **kwargs) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", **kwargs)
    return buf.getvalue()


def _gradient(mode: str, width: int = 40, height: int = 30) -> Image.Image:
    image = Image.new(mode, (width, height))
    if mode == "RGBA":
        image.putdata(
            [
                (x * 6 % 256, y * 8 % 256, (x * y + x) % 256, 255 if (x + y) % 3 else 96)
                for y in range(height)
                for x in range(width)
            ]
        )
    elif mode == "RGB":
        image.putdata(
            [
                (x * 6 % 256, y * 8 % 256, (x * y + x) % 256)
                for y in range(height)
                for x in range(width)
            ]
        )
    else:  # pragma: no cover - only the modes this file builds
        raise AssertionError(mode)
    return image


def build_images() -> dict:
    """Every input byte string the Node test replays, generated deterministically.

    The returned entries carry the length under ``bytes`` (that is the fixture
    contract); the raw content itself is kept in :data:`RAW`, because the
    generator needs the actual bytes to feed the services.
    """
    images: dict[str, dict] = {}

    def add(
        name: str,
        content: bytes,
        content_type: str,
        *,
        fmt: str | None,
        width: int | None,
        height: int | None,
        synthetic: dict | None = None,
    ) -> None:
        RAW[name] = content
        entry = {
            "content_type": content_type,
            "base64": None if synthetic else base64.b64encode(content).decode("ascii"),
            "sha256": sha256_hex(content),
            "bytes": len(content),
            "format": fmt,
            "width": width,
            "height": height,
        }
        if synthetic is not None:
            entry["synthetic"] = synthetic
        images[name] = entry

    # --- PNG ------------------------------------------------------------
    png_rgba = _png_bytes(_gradient("RGBA"))
    add("png_rgba", png_rgba, "image/png", fmt="png", width=40, height=30)

    png_rgb = _png_bytes(_gradient("RGB"))
    add("png_rgb", png_rgb, "image/png", fmt="png", width=40, height=30)

    palette = Image.new("P", (40, 30))
    palette.putpalette([value for index in range(256) for value in (index, (index * 3) % 256, (index * 7) % 256)])
    palette.putdata([(x * 3 + y) % 16 for y in range(30) for x in range(40)])
    png_palette = _png_bytes(palette)
    add("png_palette", png_palette, "image/png", fmt="png", width=40, height=30)

    la = Image.new("LA", (40, 30))
    la.putdata([(x * 6 % 256, 255 if x % 2 else 100) for y in range(30) for x in range(40)])
    png_la = _png_bytes(la)
    add("png_la", png_la, "image/png", fmt="png", width=40, height=30)

    # --- JPEG -----------------------------------------------------------
    def jpeg_of(image: Image.Image, **kwargs) -> bytes:
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=90, **kwargs)
        return buf.getvalue()

    jpeg_rgb = jpeg_of(_gradient("RGB"))
    add("jpeg_rgb", jpeg_rgb, "image/jpeg", fmt="jpeg", width=40, height=30)

    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation = rotate 90 CW
    jpeg_exif = jpeg_of(_gradient("RGB"), exif=exif.tobytes())
    add("jpeg_exif_orientation6", jpeg_exif, "image/jpeg", fmt="jpeg", width=40, height=30)

    cmyk = Image.new("CMYK", (40, 30))
    cmyk.putdata([(x * 6 % 256, y * 8 % 256, 40, 10) for y in range(30) for x in range(40)])
    jpeg_cmyk = jpeg_of(cmyk)
    add("jpeg_cmyk", jpeg_cmyk, "image/jpeg", fmt="jpeg", width=40, height=30)

    # --- WebP -----------------------------------------------------------
    def webp_of(image: Image.Image, **kwargs) -> bytes:
        buf = io.BytesIO()
        image.save(buf, format="WEBP", **kwargs)
        return buf.getvalue()

    webp_lossy = webp_of(_gradient("RGB"), quality=80)
    add("webp_lossy", webp_lossy, "image/webp", fmt="webp", width=40, height=30)

    webp_lossless = webp_of(_gradient("RGBA"), lossless=True)
    add("webp_lossless_alpha", webp_lossless, "image/webp", fmt="webp", width=40, height=30)

    # --- formats the allowlist rejects ----------------------------------
    gif = io.BytesIO()
    Image.new("P", (40, 30)).save(gif, format="GIF")
    gif_bytes = gif.getvalue()
    add("gif", gif_bytes, "image/gif", fmt="gif", width=40, height=30)

    bmp = io.BytesIO()
    _gradient("RGB").save(bmp, format="BMP")
    add("bmp", bmp.getvalue(), "image/bmp", fmt="bmp", width=40, height=30)

    # --- broken image ---------------------------------------------------
    add(
        "truncated_jpeg",
        jpeg_rgb[: len(jpeg_rgb) // 2],
        "image/jpeg",
        fmt="jpeg",
        width=40,
        height=30,
    )

    # --- non-image bytes ------------------------------------------------
    text_bytes = "B3 黄金向量 text/plain 内容\n".encode("utf-8")
    add("text_bytes", text_bytes, "text/plain", fmt=None, width=None, height=None)

    pdf_bytes = (
        b"%PDF-1.4\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF\n"
    )
    add("pdf_minimal", pdf_bytes, "application/pdf", fmt=None, width=None, height=None)

    bin_bytes = b"\x00\x01B3BIN\xff\x10"
    add("bin_bytes", bin_bytes, "application/octet-stream", fmt=None, width=None, height=None)

    # --- limits ---------------------------------------------------------
    huge = Image.new("RGB", (6000, 5000), (255, 255, 255))
    add("huge_pixels", _png_bytes(huge), "image/png", fmt="png", width=6000, height=5000)

    oversize_len = settings.IMAGE_MAX_BYTES + 1
    zeros = bytes(oversize_len)
    add(
        "oversize_bytes",
        zeros,
        "image/png",
        fmt=None,
        width=None,
        height=None,
        synthetic={"kind": "zeros", "length": oversize_len},
    )
    return images


def _exif_orientation(data: bytes) -> int | None:
    with Image.open(io.BytesIO(data)) as image:
        return image.getexif().get(0x0112)


def _image_facts(data: bytes) -> dict:
    """Format/mode/dimension facts of one stored byte string."""
    with Image.open(io.BytesIO(data)) as image:
        return {
            "format": (image.format or "").lower() or None,
            "mode": image.mode,
            "width": image.size[0],
            "height": image.size[1],
            "has_exif": bool(image.info.get("exif")),
            "exif_orientation": image.getexif().get(0x0112),
            "has_palette": image.mode == "P",
            "has_alpha": image.mode in {"RGBA", "LA"} or "transparency" in image.info,
            "has_icc_profile": bool(image.info.get("icc_profile")),
        }


def _pixel_compare(input_bytes: bytes, stored_bytes: bytes) -> dict:
    """Decode both sides to RGBA and compare sample by sample (Pillow side)."""
    with Image.open(io.BytesIO(input_bytes)) as raw:
        left = raw.convert("RGBA")
    with Image.open(io.BytesIO(stored_bytes)) as raw:
        right = raw.convert("RGBA")
    if left.size != right.size:
        return {"pixels_equal_to_input": False, "mean_abs_error": None, "max_abs_error": None, "channel_samples": 0}
    diff = ImageChops.difference(left, right)
    total = 0
    maximum = 0
    samples = 0
    for pixel in diff.getdata():
        for channel in pixel:
            total += channel
            samples += 1
            if channel > maximum:
                maximum = channel
    return {
        "pixels_equal_to_input": total == 0,
        "mean_abs_error": round(total / samples, 6) if samples else 0.0,
        "max_abs_error": maximum,
        "channel_samples": samples,
    }


# --------------------------------------------------------------------------
# storage keys
# --------------------------------------------------------------------------
def key_shape(key: str) -> dict:
    """The implementation-independent shape of a server-generated object key."""
    parent, _, tail = key.rpartition("/")
    namespace, _, _shard = parent.rpartition("/")
    token, _, suffix = tail.partition(".")
    return {
        "namespace": namespace,
        "shard_len": len(token[:2]),
        "token_len": len(token),
        "token_is_lower_hex": bool(re.fullmatch(r"[0-9a-f]{32}", token or "")),
        "has_extension": bool(suffix),
        "suffix": suffix or None,
        "key_contains_filename": False,
        "masked": f"{namespace}/<shard>/<token>{'.' + suffix if suffix else ''}",
    }


def deterministic_key(case_name: str, namespace: str, suffix: str) -> str:
    """A `build_key`-shaped key whose token is fixed, so the row can be seeded.

    The real service generates the token with `secrets.token_hex(16)`; seeding a
    fixture needs a stable value, and only the *shape* is contractual.
    """
    token = sha256_hex(f"acepass-b3-key:{case_name}".encode("utf-8"))[:32]
    return f"{namespace}/{token[:2]}/{token}.{suffix}" if suffix else f"{namespace}/{token[:2]}/{token}"


# --------------------------------------------------------------------------
# one isolated case world
# --------------------------------------------------------------------------
class Case:
    """Deterministic identities, fixed timestamps, and a placeholder registry."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.rows: dict[str, dict[str, dict]] = {}
        self.tracked: dict[str, object] = {}
        self.symbols: dict[str, str] = {}
        self.steps: list[dict] = []
        self.clock = BASE
        self._counters: dict[str, int] = {}
        self._placeholder_counters: dict[str, int] = {}
        self.leaks: list[str] = []

    # -- identity / timestamps ---------------------------------------------
    def uid(self, entity: str) -> uuid.UUID:
        n = self._counters.get(entity, 0) + 1
        self._counters[entity] = n
        return uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b3:{self.name}:{entity}:{n}")

    def now(self) -> datetime:
        self.clock = self.clock + timedelta(minutes=1)
        return self.clock

    def _pin(self, obj, *, created: bool) -> None:
        names = {field.name for field in obj._meta.concrete_fields}
        stamp = self.now()
        overrides = {}
        if created and "created_at" in names:
            overrides["created_at"] = stamp
        if "updated_at" in names:
            overrides["updated_at"] = stamp
        if created and "server_time" in names:
            overrides["server_time"] = stamp
        if created and "date_joined" in names:
            overrides["date_joined"] = stamp
        if "last_login" in names and getattr(obj, "last_login", None) is not None:
            # `Client.force_login` stamps the wall clock into `last_login`.
            overrides["last_login"] = BASE
        if overrides:
            type(obj)._base_manager.filter(pk=obj.pk).update(**overrides)
            obj.refresh_from_db()

    def create(self, model, entity: str, **kwargs):
        obj = model(id=self.uid(entity), **kwargs)
        obj.save(force_insert=True)
        self._pin(obj, created=True)
        self.tracked.setdefault(f"{model._meta.db_table}:{obj.pk}", obj)
        return obj

    def adopt(self, obj, name: str | None = None, *, pin_created: bool = True):
        """Take a service-created row into the fixture's bookkeeping.

        Its id is a random `uuid4`, so it is never dumped into `rows`; it gets a
        `<table:index>` placeholder and is described through real projections.
        """
        self._pin(obj, created=pin_created)
        if name is None:
            self.symbol(obj, self.placeholder(obj._meta.model_name))
        else:
            self.symbol(obj, name)
        return obj

    #: model_name -> the word used in `<word:n>` placeholders.
    PLACEHOLDER_NAMES = {
        "sourcedocument": "document",
        "source_document": "document",
        "importjob": "job",
        "importjobdocuments": "job_documents",
        "importcandidate": "candidate",
        "sourceregion": "region",
        "exposureevent": "exposure",
        "questionversion": "question_version",
        "answerkeyversion": "answer",
    }

    def placeholder(self, kind: str) -> str:
        kind = self.PLACEHOLDER_NAMES.get(kind, kind)
        n = self._placeholder_counters.get(kind, 0) + 1
        self._placeholder_counters[kind] = n
        return f"<{kind}:{n}>"

    def symbol(self, obj, name: str) -> str:
        key = str(getattr(obj, "pk", obj))
        self.symbols[key] = name
        return name

    def sym(self, value) -> str | None:
        if value is None:
            return None
        return self.symbols.get(str(value))

    # -- rendering ---------------------------------------------------------
    def symbolize(self, value):
        if isinstance(value, uuid.UUID):
            return self.symbols.get(str(value), str(value))
        if isinstance(value, str):
            return UUID_RE.sub(lambda match: self.symbols.get(match.group(0), match.group(0)), value)
        if isinstance(value, dict):
            return {key: self.symbolize(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.symbolize(item) for item in value]
        return value

    def finalize(self) -> None:
        """Re-pin `updated_at`/`server_time` in a deterministic order, then dump."""
        ordered = sorted(self.tracked.values(), key=lambda obj: (obj._meta.db_table, str(obj.pk)))
        for obj in ordered:
            self._pin(obj, created=False)
        for obj in ordered:
            self.rows.setdefault(obj._meta.db_table, {})[str(obj.pk)] = dump_row(obj)

    def Rowset(self) -> dict[str, list[dict]]:
        return {table: [rows[key] for key in sorted(rows)] for table, rows in self.rows.items() if rows}

    def exported_symbols(self) -> dict:
        ids = {
            str(entry.get("id"))
            for entries in self.rows.values()
            for entry in entries.values()
            if entry.get("id") is not None
        }
        return {key: value for key, value in self.symbols.items() if key in ids}

    def check_no_leaks(self, payload) -> list[str]:
        """Any uuid left after symbolisation is random and would break rerun equality."""
        found: list[str] = []

        def walk(value):
            if isinstance(value, str):
                for match in UUID_RE.findall(value):
                    if match not in self.symbols:
                        found.append(f"{self.name}: {match}")
            elif isinstance(value, dict):
                for item in value.values():
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(payload)
        return found


class World:
    """The scaffolding every case starts from: owner, project, subject."""

    def __init__(self, case: Case, *, staff: bool = False) -> None:
        self.case = case
        User = get_user_model()
        slug = uuid.uuid5(uuid.NAMESPACE_URL, f"b3-email:{case.name}").hex[:12]
        self.user = case.create(
            User,
            "user",
            email=f"b3-{slug}@example.invalid",
            # Pinned marker: `set_password` would salt with `get_random_string`
            # and the dump would differ on every run.
            password="!b3-golden-unusable-password-marker",
            display_name="B3 黄金",
            is_active=True,
            is_staff=staff,
            is_superuser=False,
        )
        case.symbol(self.user, "USER")
        self.project = case.create(ExamProject, "project", owner=self.user, name=f"项目-{case.name}")
        case.symbol(self.project, "PROJECT")
        self.subject = case.create(Subject, "subject", project=self.project, name=f"科目-{case.name}", code="MATH")
        case.symbol(self.subject, "SUBJECT")

    def extra_project(self, *, entity: str = "project_other") -> ExamProject:
        project = self.case.create(ExamProject, entity, owner=self.user, name=f"项目-{entity}")
        self.case.symbol(project, entity.upper())
        return project

    def extra_subject(self, project: ExamProject, *, entity: str = "subject_other") -> Subject:
        subject = self.case.create(Subject, entity, project=project, name=f"科目-{entity}", code="OTHER")
        self.case.symbol(subject, entity.upper())
        return subject

    def client(self) -> Client:
        client = Client()
        client.force_login(self.user)
        return client


# --------------------------------------------------------------------------
# projections (real ones, with placeholders for generated identities)
# --------------------------------------------------------------------------
def stored_bytes(asset: Asset) -> bytes:
    handle = get_storage().open(asset.object_key)
    try:
        return handle.read()
    finally:
        handle.close()


def describe_asset(case: Case, asset: Asset, *, deterministic_checksum: bool, name: str | None = None) -> dict:
    """`_asset_out` plus the row facts a projection does not expose."""
    case.adopt(asset, name)
    data = stored_bytes(asset)
    out = dict(_asset_out(asset))
    out["checksum"] = asset.checksum if deterministic_checksum else STORE_PLACEHOLDER_SUM
    out["size_bytes"] = asset.size_bytes if deterministic_checksum else STORE_PLACEHOLDER_SIZE
    out["object_key"] = OBJECT_KEY_PLACEHOLDER
    out["key_shape"] = key_shape(asset.object_key)
    out["subject_id"] = asset.subject_id
    out["source_document_id"] = asset.source_document_id
    out["uploaded_by_id"] = asset.uploaded_by_id
    out["is_retained"] = asset.is_retained
    out["bytes_on_disk"] = len(data)
    out["checksum_matches_bytes"] = asset.checksum == sha256_hex(data)
    out["size_matches_bytes"] = asset.size_bytes == len(data)
    return out


def stored_facts(asset: Asset, input_bytes: bytes) -> dict:
    """What the stored bytes *are*, independent of the encoder that made them."""
    data = stored_bytes(asset)
    facts = _image_facts(data)
    compare = _pixel_compare(input_bytes, data)
    return {
        "format": facts["format"],
        "width": facts["width"],
        "height": facts["height"],
        "mode": facts["mode"],
        "has_exif": facts["has_exif"],
        "exif_orientation": facts["exif_orientation"],
        "has_palette": facts["has_palette"],
        "has_alpha": facts["has_alpha"],
        "has_icc_profile": facts["has_icc_profile"],
        "decoded_pixel_count": facts["width"] * facts["height"],
        # `reencoded` = strip_metadata ran; `bytes_changed` = the encoder produced
        # different bytes (PNG of the same pixels round-trips byte-identically,
        # JPEG/WebP never do, a palette PNG loses its palette).
        "reencoded": True,
        "bytes_changed": data != input_bytes,
        "input_format": _image_facts(input_bytes)["format"],
        "input_exif_orientation": _exif_orientation(input_bytes),
        "pixels_equal_to_input": compare["pixels_equal_to_input"],
        "mean_abs_error": compare["mean_abs_error"],
        "max_abs_error": compare["max_abs_error"],
        "channel_samples": compare["channel_samples"],
        "stored_sha256": STORE_PLACEHOLDER_SUM,
        "stored_size": STORE_PLACEHOLDER_SIZE,
        "actual_stored_size": len(data),
        "checksum_matches_bytes": asset.checksum == sha256_hex(data),
    }


def passthrough_facts(asset: Asset, input_bytes: bytes) -> dict:
    """Non-image bytes are stored verbatim: their checksum *is* the raw sha256."""
    data = stored_bytes(asset)
    return {
        "reencoded": False,
        "bytes_changed": data != input_bytes,
        "format": None,
        "width": None,
        "height": None,
        "mode": None,
        "has_exif": False,
        "has_palette": False,
        "checksum_is_raw_sha256": asset.checksum == sha256_hex(input_bytes),
        "checksum_matches_bytes": asset.checksum == sha256_hex(data),
        "actual_stored_size": len(data),
    }


def describe_document(case: Case, document: SourceDocument) -> dict:
    case.adopt(document)
    out = dict(_document_out(document))
    out["checksum"] = STORE_PLACEHOLDER_SUM if document.document_type in {"image", "pdf", "pdf_answer"} else document.checksum
    out["checksum_matches_asset"] = (
        None if document.asset_id is None else document.checksum == Asset.objects.get(id=document.asset_id).checksum
    )
    out["raw_text"] = document.raw_text
    out["page_texts"] = document.page_texts
    out["page_count"] = document.page_count
    return out


def describe_job(case: Case, job: ImportJob) -> dict:
    """The real `job_summary`, with generated ids replaced by placeholders."""
    case.adopt(job, "<job>")
    return symbolize_summary(case, job_summary(job))


def describe_candidate(case: Case, candidate: ImportCandidate) -> dict:
    case.adopt(candidate)
    return symbolize_summary(case, candidate_summary(candidate))


def describe_region(case: Case, region: SourceRegion) -> dict:
    case.adopt(region)
    return {
        "id": str(region.id),
        "document_id": str(region.document_id),
        "page_index": region.page_index,
        "x": region.x,
        "y": region.y,
        "width": region.width,
        "height": region.height,
        "role": region.role,
        "text_span": region.text_span,
        "crop_asset_id": None if region.crop_asset_id is None else str(region.crop_asset_id),
        "char_start": region.char_start,
        "char_end": region.char_end,
    }


def symbolize_summary(case: Case, summary: dict) -> dict:
    """Summaries embed generated ids; give each one a stable placeholder first."""
    for key in ("document_ids",):
        for value in summary.get(key) or []:
            case.symbols.setdefault(str(value), case.placeholder("document"))
    for value in summary.get("child_candidate_ids") or []:
        case.symbols.setdefault(str(value), case.placeholder("candidate"))
    for region in summary.get("source_regions") or []:
        for field in ("id", "document_id", "document_asset_id", "crop_asset_id"):
            value = region.get(field)
            if value:
                kind = "asset" if field.endswith("asset_id") else ("region" if field == "id" else "document")
                case.symbols.setdefault(str(value), case.placeholder(kind))
    for key in ("id", "job_id", "publication_question_id", "publication_version_id", "publication_paper_item_id"):
        value = summary.get(key)
        if value:
            kind = {"id": "job", "job_id": "job"}.get(key, key.replace("publication_", "").replace("_id", ""))
            case.symbols.setdefault(str(value), case.placeholder(kind))
    for problem in summary.get("problems") or []:
        if problem.get("duplicate_job_id"):
            case.symbols.setdefault(str(problem["duplicate_job_id"]), case.placeholder("job"))
    return summary


def project_counts(project: ExamProject) -> dict:
    """How many rows of each kind the call actually wrote for this project."""
    return {
        "ingestion_asset": Asset.objects.filter(project=project).count(),
        "ingestion_source_document": SourceDocument.objects.filter(project=project).count(),
        "ingestion_source_region": SourceRegion.objects.filter(document__project=project).count(),
        "ingestion_import_job": ImportJob.objects.filter(project=project).count(),
        "ingestion_import_candidate": ImportCandidate.objects.filter(project=project).count(),
        "ingestion_candidate_revision": CandidateRevision.objects.filter(candidate__project=project).count(),
        "audit_content_revision": ContentRevision.objects.filter(project_id=project.id).count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "practice_exposure_event": ExposureEvent.objects.filter(project=project).count(),
    }


# --------------------------------------------------------------------------
# §A store_asset (validate_image / strip_metadata / namespace / suffix)
# --------------------------------------------------------------------------
def store_case(
    name: str,
    *,
    image: str,
    content_type: str | None = None,
    role: str = "past_paper_page",
    sensitivity: str = "public_to_owner",
    subject: str = "own",
    original_filename: str = "",
) -> dict:
    """One `store_asset` call; success records the asset + the stored-bytes facts."""
    case = Case(f"store:{name}")
    world = World(case)
    images = IMAGES
    payload = images[image]
    declared = content_type or payload["content_type"]
    chosen_subject = None
    if subject == "own":
        chosen_subject = world.subject
    elif subject == "cross":
        other_project = world.extra_project()
        chosen_subject = world.extra_subject(other_project)
    case.steps.append(
        {
            "op": "store_asset",
            "image": image,
            "content_type": declared,
            "role": role,
            "sensitivity": sensitivity,
            "subject": subject,
            "original_filename": original_filename or None,
        }
    )
    asset, error = run(
        lambda: store_asset(
            owner=world.user,
            project=world.project,
            content=RAW[image],
            content_type=declared,
            role=role,
            sensitivity=sensitivity,
            subject=chosen_subject,
            original_filename=original_filename,
        )
    )
    if error is not None:
        expected = dict(error)
        expected["row_counts"] = project_counts(world.project)
        case.finalize()
        return {"name": f"store: {name}", "rows": case.Rowset(), "symbols": case.exported_symbols(), "steps": case.steps, "expected": expected}
    is_image = declared.startswith("image/")
    expected = {
        "ok": True,
        "asset": describe_asset(case, asset, deterministic_checksum=not is_image),
        "stored": stored_facts(asset, RAW[image]) if is_image else passthrough_facts(asset, RAW[image]),
        "row_counts": project_counts(world.project),
    }
    case.finalize()
    return {
        "name": f"store: {name}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": case.symbolize(expected),
    }


def store_cases() -> list[dict]:
    long_name = "扫" * 300 + ".png"
    return [
        store_case(
            "jpeg_rgb → source 命名空间 + jpg 后缀",
            image="jpeg_rgb",
            role="past_paper_page",
            original_filename="2024真题.jpg",
        ),
        store_case("png_rgba → uploads 命名空间", image="png_rgba", role="other"),
        store_case("png_palette → 调色板被丢弃", image="png_palette", role="user_attachment"),
        store_case("png_la → 灰度 + alpha 保留", image="png_la", role="other"),
        store_case("webp_lossy → webp 后缀", image="webp_lossy", role="past_paper_page"),
        store_case("webp_lossless_alpha → 重编码变有损", image="webp_lossless_alpha", role="other"),
        store_case("jpeg_cmyk → RGB 转换", image="jpeg_cmyk", role="answer_page"),
        store_case("jpeg_exif_orientation6 → 去 EXIF 且不旋转", image="jpeg_exif_orientation6", role="other"),
        store_case(
            "text/plain 不重编码（O01 允许非图片字节）",
            image="text_bytes",
            role="other",
        ),
        store_case("application/pdf 不重编码", image="pdf_minimal", role="answer_page"),
        store_case("application/octet-stream → bin 后缀", image="bin_bytes", role="other"),
        store_case(
            "role=stem_crop → region 命名空间",
            image="png_rgb",
            role="stem_crop",
        ),
        store_case(
            "role=answer_crop + internal_review",
            image="png_rgb",
            role="answer_crop",
            sensitivity="internal_review",
        ),
        store_case(
            "original_filename 截断到 255",
            image="png_rgb",
            role="other",
            original_filename=long_name,
        ),
        # --- refusals ---------------------------------------------------
        store_case("MIME 拒绝：image/gif", image="gif", role="other"),
        _empty_store_case(),
        store_case("truncated jpeg", image="truncated_jpeg", role="other"),
        store_case("GIF 字节声明 png → detected 拒绝", image="gif", content_type="image/png", role="other"),
        store_case("BMP 字节声明 png → detected 拒绝", image="bmp", content_type="image/png", role="other"),
        store_case("原始字节 >10 MiB", image="oversize_bytes", role="other"),
        store_case("像素 >25,000,000", image="huge_pixels", role="other"),
        # --- deliberate mislabels / refusals ------------------------------
        store_case("jpeg 字节声明 png（不校验 MIME==detected）", image="jpeg_rgb", content_type="image/png", role="other"),
        store_case("role 非法", image="png_rgb", role="bogus_role"),
        store_case("sensitivity 非法", image="png_rgb", role="other", sensitivity="secret"),
        store_case("subject 跨项目", image="png_rgb", role="other", subject="cross"),
    ]


def _empty_store_case() -> dict:
    case = Case("store:空字节")
    world = World(case)
    case.steps.append({"op": "store_asset", "image": "<empty>", "content_type": "image/png", "role": "other"})
    asset, error = run(
        lambda: store_asset(
            owner=world.user,
            project=world.project,
            content=b"",
            content_type="image/png",
            role="other",
        )
    )
    expected = dict(error)
    expected["row_counts"] = project_counts(world.project)
    case.finalize()
    return {
        "name": "store: 空字节 image/png",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": expected,
    }


# --------------------------------------------------------------------------
# §B build_key / namespace mapping
# --------------------------------------------------------------------------
def key_role_case(role: str, content_type: str, image: str) -> dict:
    case = Case(f"key:{role}:{content_type}")
    world = World(case)
    payload = IMAGES[image]
    case.steps.append({"op": "store_asset", "role": role, "content_type": content_type, "image": image})
    asset, error = run(
        lambda: store_asset(
            owner=world.user,
            project=world.project,
            content=RAW[image],
            content_type=content_type,
            role=role,
        )
    )
    if error is not None:  # pragma: no cover - these calls are chosen to succeed
        raise AssertionError(f"{case.name}: {error['error']['message']}")
    expected = {"ok": True, "key_shape": key_shape(asset.object_key), "suffix": key_shape(asset.object_key)["suffix"]}
    expected = case.symbolize(expected)
    case.finalize()
    return {
        "name": f"keys: role={role} content_type={content_type}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": expected,
    }


def key_pure_case(name: str, namespace: str, suffix: str) -> dict:
    case = Case(f"key:{name}")
    world = World(case)
    key = build_key(namespace, suffix)
    case.steps.append({"op": "build_key", "namespace": namespace, "suffix": suffix})
    # The namespace is prefixed with this case's real owner/project ids so the
    # cropping rules operate on the same shape the service produces.
    expected = {"ok": True, "key_shape": key_shape(key)}
    case.finalize()
    return {
        "name": f"keys: {name}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": case.symbolize(expected),
    }


def key_cases() -> list[dict]:
    cases = [
        key_role_case("stem_crop", "image/png", "png_rgb"),
        key_role_case("material_crop", "image/png", "png_rgb"),
        key_role_case("answer_crop", "image/png", "png_rgb"),
        key_role_case("past_paper_page", "image/png", "png_rgb"),
        key_role_case("answer_page", "image/png", "png_rgb"),
        key_role_case("user_attachment", "image/png", "png_rgb"),
        key_role_case("other", "image/png", "png_rgb"),
        key_role_case("past_paper_page", "image/jpeg", "jpeg_rgb"),
        key_role_case("past_paper_page", "image/webp", "webp_lossy"),
        key_role_case("answer_page", "application/pdf", "pdf_minimal"),
        key_role_case("other", "application/octet-stream", "bin_bytes"),
    ]
    # `build_key` is the only place a namespace/suffix reaches storage; the
    # service always passes a clean one, so the cleaning rules need direct calls.
    for name, namespace, suffix in [
        ("namespace 含空白/星号/首尾斜杠", "own er/星*号//project_id/region/", "png"),
        ("namespace 全部非法字符", "...///", "png"),
        ("suffix 大写与小写化", "owner/project/uploads", "JPEG"),
        ("suffix 含分隔符", "owner/project/uploads", "t-ar.gz"),
        ("suffix 截断到 12", "owner/project/uploads", "abcdefghijklmnop"),
        ("suffix 为空 → 无扩展名", "owner/project/uploads", ".?!."),
        ("suffix 全非法字符 → 无扩展名", "owner/project/uploads", "???"),
    ]:
        cases.append(key_pure_case(name, namespace, suffix))
    return cases


# --------------------------------------------------------------------------
# §C find_duplicate_document (raw checksum vs stored checksum)
# --------------------------------------------------------------------------
def dedupe_cases() -> list[dict]:
    cases: list[dict] = []

    # 1. A PNG round-trips byte-identically through strip_metadata, so the stored
    #    checksum equals the raw one and a second upload is recognised.
    case = Case("dedupe:png 原始 checksum 命中")
    world = World(case)
    png = RAW["png_rgb"]
    document = create_image_document(
        owner=world.user,
        project=world.project,
        content=png,
        content_type="image/png",
        role="past_paper_page",
        title="扫描页",
        original_filename="scan.png",
    )
    raw = file_checksum(png)
    stored = document.asset.checksum
    found = find_duplicate_document(project=world.project, checksum=raw)
    case.steps.append({"op": "create_image_document", "image": "png_rgb"})
    case.steps.append({"op": "find_duplicate_document", "checksum": "raw_sha256(png_rgb)"})
    expected = {
        "ok": True,
        "raw_checksum": raw,
        "document_checksum": stored,
        "encoded_equals_raw": stored == raw,
        "found_is_document": found is not None and found.id == document.id,
        "found_checksum": None if found is None else found.checksum,
        "document": describe_document(case, document),
        "asset": describe_asset(case, document.asset, deterministic_checksum=False),
    }
    case.finalize()
    cases.append(
        {
            "name": "dedupe: PNG 原始 checksum 命中（重编码后字节不变）",
            "rows": case.Rowset(),
            "symbols": case.exported_symbols(),
            "steps": case.steps,
            "expected": case.symbolize(expected),
        }
    )

    # 2. JPEG never round-trips: the raw checksum misses, the encoded one hits.
    case = Case("dedupe:jpeg 原始 checksum 不命中")
    world = World(case)
    jpeg = RAW["jpeg_rgb"]
    document = create_image_document(
        owner=world.user,
        project=world.project,
        content=jpeg,
        content_type="image/jpeg",
        role="past_paper_page",
        title="扫描页",
        original_filename="scan.jpg",
    )
    raw = file_checksum(jpeg)
    stored = document.asset.checksum
    by_raw = find_duplicate_document(project=world.project, checksum=raw)
    by_stored = find_duplicate_document(project=world.project, checksum=stored)
    case.steps.append({"op": "create_image_document", "image": "jpeg_rgb"})
    case.steps.append({"op": "find_duplicate_document", "checksum": "raw_sha256(jpeg_rgb)"})
    case.steps.append({"op": "find_duplicate_document", "checksum": "document.checksum"})
    expected = {
        "ok": True,
        "raw_checksum": raw,
        "document_checksum": stored,
        "encoded_equals_raw": stored == raw,
        "found_by_raw_checksum": None if by_raw is None else str(by_raw.id),
        "found_by_stored_checksum": None if by_stored is None else str(by_stored.id),
        "document": describe_document(case, document),
        "asset": describe_asset(case, document.asset, deterministic_checksum=False),
    }
    case.finalize()
    cases.append(
        {
            "name": "dedupe: JPEG 原始 checksum 不命中、编码后 checksum 命中",
            "rows": case.Rowset(),
            "symbols": case.exported_symbols(),
            "steps": case.steps,
            "expected": case.symbolize(expected),
        }
    )

    # 3. created_at earliest wins; non-text documents only.
    case = Case("dedupe:created_at 最早优先")
    world = World(case)
    later = case.create(
        SourceDocument,
        "document_later",
        owner=world.user,
        project=world.project,
        subject=world.subject,
        title="后建的来源",
        document_type="image",
        role="past_paper_page",
        sensitivity="public_to_owner",
        raw_text="",
        checksum="d" * 64,
        source_type="user_upload",
        page_count=1,
    )
    earlier = case.create(
        SourceDocument,
        "document_earlier",
        owner=world.user,
        project=world.project,
        subject=world.subject,
        title="先建的来源",
        document_type="image",
        role="past_paper_page",
        sensitivity="public_to_owner",
        raw_text="",
        checksum="d" * 64,
        source_type="user_upload",
        page_count=1,
    )
    case.symbol(earlier, "DOC_EARLIER")
    case.symbol(later, "DOC_LATER")
    # `create()` stamps in call order; rebuild the intended order explicitly.
    type(earlier).objects.filter(pk=earlier.pk).update(
        created_at=BASE + timedelta(minutes=1), updated_at=BASE + timedelta(minutes=1)
    )
    type(later).objects.filter(pk=later.pk).update(
        created_at=BASE + timedelta(minutes=5), updated_at=BASE + timedelta(minutes=5)
    )
    earlier.refresh_from_db()
    later.refresh_from_db()
    found = find_duplicate_document(project=world.project, checksum="d" * 64)
    case.steps.append({"op": "find_duplicate_document", "checksum": "d" * 64})
    expected = {
        "ok": True,
        "found": None if found is None else str(found.id),
        "candidates": [
            {"id": str(earlier.id), "created_at": earlier.created_at.isoformat()},
            {"id": str(later.id), "created_at": later.created_at.isoformat()},
        ],
    }
    case.finalize()
    cases.append(
        {
            "name": "dedupe: 同 checksum 多行时取 created_at 最早",
            "rows": case.Rowset(),
            "symbols": case.exported_symbols(),
            "steps": case.steps,
            "expected": case.symbolize(expected),
        }
    )

    # 4. A `text` document never matches, even with the identical checksum.
    case = Case("dedupe:text 文档排除")
    world = World(case)
    text_document = case.create(
        SourceDocument,
        "document_text",
        owner=world.user,
        project=world.project,
        subject=world.subject,
        title="粘贴文本",
        document_type="text",
        role="past_paper_page",
        sensitivity="public_to_owner",
        raw_text="题干",
        checksum="e" * 64,
        source_type="user_paste",
        page_count=1,
    )
    image_document = case.create(
        SourceDocument,
        "document_image",
        owner=world.user,
        project=world.project,
        subject=world.subject,
        title="图片来源",
        document_type="image",
        role="past_paper_page",
        sensitivity="public_to_owner",
        raw_text="",
        checksum="e" * 64,
        source_type="user_upload",
        page_count=1,
    )
    case.symbol(text_document, "DOC_TEXT")
    case.symbol(image_document, "DOC_IMAGE")
    found = find_duplicate_document(project=world.project, checksum="e" * 64)
    case.steps.append({"op": "find_duplicate_document", "checksum": "e" * 64})
    expected = {
        "ok": True,
        "found": None if found is None else str(found.id),
        "found_is_image_document": found is not None and found.id == image_document.id,
        "text_document_id": str(text_document.id),
        "image_document_id": str(image_document.id),
    }
    case.finalize()
    cases.append(
        {
            "name": "dedupe: document_type=text 被排除",
            "rows": case.Rowset(),
            "symbols": case.exported_symbols(),
            "steps": case.steps,
            "expected": case.symbolize(expected),
        }
    )

    # 5. Only the same project is searched.
    case = Case("dedupe:跨项目不命中")
    world = World(case)
    other_project = world.extra_project()
    foreign = case.create(
        SourceDocument,
        "document_foreign",
        owner=world.user,
        project=other_project,
        subject=None,
        title="别的项目",
        document_type="image",
        role="past_paper_page",
        sensitivity="public_to_owner",
        raw_text="",
        checksum="f" * 64,
        source_type="user_upload",
        page_count=1,
    )
    case.symbol(foreign, "DOC_FOREIGN")
    found = find_duplicate_document(project=world.project, checksum="f" * 64)
    case.steps.append({"op": "find_duplicate_document", "checksum": "f" * 64})
    expected = {
        "ok": True,
        "found": None if found is None else str(found.id),
        "foreign_document_id": str(foreign.id),
    }
    case.finalize()
    cases.append(
        {
            "name": "dedupe: 只查同项目",
            "rows": case.Rowset(),
            "symbols": case.exported_symbols(),
            "steps": case.steps,
            "expected": case.symbolize(expected),
        }
    )
    return cases


# --------------------------------------------------------------------------
# §D download gates (assert_asset_download_allowed)
# --------------------------------------------------------------------------
def make_asset(case: Case, world: World, *, entity: str = "asset", **overrides) -> Asset:
    data = {
        "owner": world.user,
        "project": world.project,
        "subject": world.subject,
        "role": "past_paper_page",
        "sensitivity": "public_to_owner",
        "object_key": deterministic_key(case.name, f"{world.user.id}/{world.project.id}/source", "png"),
        "original_filename": "page.png",
        "content_type": "image/png",
        "size_bytes": 1024,
        "checksum": "a" * 64,
        "width": 40,
        "height": 30,
        "is_retained": True,
        "uploaded_by": world.user,
    }
    data.update(overrides)
    asset = case.create(Asset, entity, **data)
    case.symbol(asset, entity.upper())
    return asset


def make_question(case: Case, world: World, *, entity: str, label: str, sealed: bool = False,
                  content: dict | None = None, family: QuestionFamily | None = None,
                  lineage: ContentLineage | None = None) -> tuple[Question, QuestionVersion]:
    question = case.create(
        Question,
        entity,
        subject=world.subject,
        origin_type="official_past",
        family=family,
        content_lineage=lineage,
        is_demo=False,
        display_label=label,
    )
    version = case.create(
        QuestionVersion,
        f"{entity}_version",
        question=question,
        version=1,
        question_type="single_choice",
        content=content or {
            "blocks": [{"kind": "text", "text": f"{label} 题干"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        },
        practice_max_score=Decimal("2.00"),
        status="published",
        published_at=BASE,
    )
    question.current_published_version = version
    question.save(update_fields=["current_published_version", "updated_at"])
    case.symbol(question, entity.upper())
    case.symbol(version, f"{entity.upper()}_V1")
    if sealed:
        case.create(
            QuestionPoolPolicy,
            f"{entity}_policy",
            project=world.project,
            question=question,
            revision=1,
            is_holdout=True,
            change_reason="B3 封存向量",
            changed_by=world.user,
        )
    return question, version


def gate_case(name: str, build, *, purpose: str = "practice", session_from=None) -> dict:
    case = Case(f"gate:{name}")
    world = World(case)
    context = build(case, world)
    asset = context["asset"]
    session = context.get("session")
    case.steps.append({"op": "assert_asset_download_allowed", "purpose": purpose, "has_session": session is not None})
    _, error = run(
        lambda: asset_access.assert_asset_download_allowed(
            user=world.user, project=world.project, asset=asset, purpose=purpose, session=session
        )
    )
    expected = dict(error) if error is not None else {"ok": True}
    case.finalize()
    return {
        "name": f"gate: {name}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": case.symbolize(expected),
    }


def _region(case: Case, world: World, document, *, entity: str, crop_asset=None, page_index: int = 1):
    region = case.create(
        SourceRegion,
        entity,
        document=document,
        page_index=page_index,
        x=0.0,
        y=0.0,
        width=1.0,
        height=1.0,
        role="stem_crop",
        text_span="",
        crop_asset=crop_asset,
    )
    case.symbol(region, entity.upper())
    return region


def _document(case: Case, world: World, *, entity: str, asset: Asset | None = None):
    document = case.create(
        SourceDocument,
        entity,
        owner=world.user,
        project=world.project,
        subject=world.subject,
        title="来源页",
        document_type="image" if asset is not None else "text",
        role="past_paper_page",
        sensitivity="public_to_owner",
        asset=asset,
        raw_text="" if asset is not None else "题干文本",
        checksum="b" * 64,
        source_type="user_upload",
        page_count=1,
    )
    case.symbol(document, entity.upper())
    return document


def _link(case: Case, version: QuestionVersion, region: SourceRegion, *, entity: str) -> None:
    case.create(
        QuestionSourceLink,
        entity,
        question_version=version,
        region=region,
        role="stem",
        note="",
    )


def _answers(case: Case, version: QuestionVersion, *, entity: str, source_region=None) -> AnswerKeyVersion:
    answer = case.create(
        AnswerKeyVersion,
        entity,
        question_version=version,
        version=1,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
        source_type="official",
        verification_status="checked",
        checked_at=BASE,
        check_basis="与官方答案核对一致",
        source_region=source_region,
        explanation_blocks=[],
    )
    case.symbol(answer, entity.upper())
    return answer


def _session(case: Case, world: World, *, entity: str, mode: str, status: str = "active") -> PracticeSession:
    session = case.create(
        PracticeSession,
        entity,
        user=world.user,
        project=world.project,
        subject=world.subject,
        mode=mode,
        status=status,
        policy_version="p0-1",
    )
    case.symbol(session, entity.upper())
    return session


def _family(case: Case, world: World, *, entity: str = "family") -> QuestionFamily:
    family = case.create(
        QuestionFamily, entity, subject=world.subject, name=f"家族-{case.name}", relation_confirmed=True
    )
    case.symbol(family, entity.upper())
    return family


def _lineage(case: Case, world: World, *, entity: str = "lineage") -> ContentLineage:
    lineage = case.create(
        ContentLineage, entity, owner=world.user, basis="manual_confirmed", is_confirmed=True, note="同题"
    )
    case.symbol(lineage, entity.upper())
    return lineage


def _family_policy(case: Case, world: World, family: QuestionFamily, *, entity: str = "family_policy") -> None:
    case.create(
        QuestionPoolPolicy,
        entity,
        project=world.project,
        family=family,
        revision=1,
        is_holdout=True,
        change_reason="B3 家族封存",
        changed_by=world.user,
    )


def gate_cases() -> list[dict]:
    cases: list[dict] = []

    # --- internal_review before every other gate ------------------------
    def internal_non_staff(case, world):
        return {"asset": make_asset(case, world, sensitivity="internal_review")}

    cases.append(gate_case("internal_review 且非 staff → 403", internal_non_staff))

    def internal_staff(case, world):
        world.user.is_staff = True
        world.user.save(update_fields=["is_staff"])
        return {"asset": make_asset(case, world, sensitivity="internal_review")}

    cases.append(gate_case("internal_review 且 staff → 放行", internal_staff))

    # --- sealing: the four relations -----------------------------------
    def sealed_crop(case, world):
        asset = make_asset(case, world, entity="asset", role="stem_crop")
        document = _document(case, world, entity="document")
        region = _region(case, world, document, entity="region", crop_asset=asset)
        _, version = make_question(case, world, entity="question", label="Q-1", sealed=True)
        _link(case, version, region, entity="source_link")
        return {"asset": asset}

    cases.append(gate_case("封存：裁图 → SourceRegion → QuestionSourceLink", sealed_crop))

    def sealed_whole_page(case, world):
        asset = make_asset(case, world, entity="asset")
        document = _document(case, world, entity="document", asset=asset)
        region = _region(case, world, document, entity="region")
        _, version = make_question(case, world, entity="question", label="Q-2", sealed=True)
        _link(case, version, region, entity="source_link")
        return {"asset": asset}

    cases.append(gate_case("封存：整页 asset → SourceDocument → region → link", sealed_whole_page))

    def sealed_answer_key(case, world):
        asset = make_asset(case, world, entity="asset", role="answer_crop")
        document = _document(case, world, entity="document")
        region = _region(case, world, document, entity="region", crop_asset=asset, page_index=2)
        _, version = make_question(case, world, entity="question", label="Q-3", sealed=True)
        _answers(case, version, entity="answer", source_region=region)
        return {"asset": asset}

    cases.append(gate_case("封存：AnswerKeyVersion.source_region.crop_asset", sealed_answer_key))

    def sealed_answer_key_whole_page(case, world):
        """The answer-key branch only looks at `crop_asset`, never at `document.asset`."""
        asset = make_asset(case, world, entity="asset")
        document = _document(case, world, entity="document", asset=asset)
        region = _region(case, world, document, entity="region")
        _, version = make_question(case, world, entity="question", label="Q-4", sealed=True)
        _answers(case, version, entity="answer", source_region=region)
        return {"asset": asset}

    cases.append(gate_case("封存：答案区域只认 crop_asset，整页不连（无 link 时放行）", sealed_answer_key_whole_page))

    def sealed_inline_image(case, world):
        asset = make_asset(case, world, entity="asset", role="stem_crop")
        content = {
            "blocks": [{"kind": "image", "asset_id": str(asset.id)}],
            "options": [],
        }
        _, version = make_question(case, world, entity="question", label="Q-5", sealed=True, content=content)
        return {"asset": asset}

    cases.append(gate_case("封存：题干 image block 直接引用 asset", sealed_inline_image))

    def sealed_inline_image_unsealed(case, world):
        asset = make_asset(case, world, entity="asset", role="stem_crop")
        content = {"blocks": [{"kind": "image", "asset_id": str(asset.id)}], "options": []}
        make_question(case, world, entity="question", label="Q-6", sealed=False, content=content)
        return {"asset": asset}

    cases.append(gate_case("未封存：题干 image block 引用同一 asset → 放行", sealed_inline_image_unsealed))

    def sealed_family(case, world):
        asset = make_asset(case, world, entity="asset", role="stem_crop")
        document = _document(case, world, entity="document")
        region = _region(case, world, document, entity="region", crop_asset=asset)
        family = _family(case, world)
        _family_policy(case, world, family)
        _, version = make_question(case, world, entity="question", label="Q-7", family=family)
        _link(case, version, region, entity="source_link")
        return {"asset": asset}

    cases.append(gate_case("封存：家族策略（sealed_family_policy）", sealed_family))

    def unsealed_policy_cleared(case, world):
        asset = make_asset(case, world, entity="asset", role="stem_crop")
        document = _document(case, world, entity="document")
        region = _region(case, world, document, entity="region", crop_asset=asset)
        question, version = make_question(case, world, entity="question", label="Q-8")
        _link(case, version, region, entity="source_link")
        # revision 1 holds out, revision 2 clears it: only the latest decides.
        case.create(
            QuestionPoolPolicy,
            "policy_r1",
            project=world.project,
            question=question,
            revision=1,
            is_holdout=True,
            change_reason="先封存",
            changed_by=world.user,
        )
        case.create(
            QuestionPoolPolicy,
            "policy_r2",
            project=world.project,
            question=question,
            revision=2,
            is_holdout=False,
            change_reason="后解封",
            changed_by=world.user,
        )
        return {"asset": asset}

    cases.append(gate_case("未封存：较新的策略修订解除封存 → 放行", unsealed_policy_cleared))

    def unrelated_asset(case, world):
        make_question(case, world, entity="question", label="Q-9", sealed=True)
        return {"asset": make_asset(case, world, entity="asset", role="user_attachment")}

    cases.append(gate_case("封存无关的 asset（用户附件）→ 放行", unrelated_asset))

    def two_sealed(case, world):
        asset = make_asset(case, world, entity="asset", role="stem_crop")
        document = _document(case, world, entity="document")
        region_a = _region(case, world, document, entity="region_a", crop_asset=asset)
        region_b = _region(case, world, document, entity="region_b", crop_asset=asset)
        _, version_a = make_question(case, world, entity="question_a", label="Q-A", sealed=True)
        _, version_b = make_question(case, world, entity="question_b", label="Q-B", sealed=True)
        _link(case, version_a, region_a, entity="source_link_a")
        _link(case, version_b, region_b, entity="source_link_b")
        return {"asset": asset}

    cases.append(gate_case("多道封存题：按 question id 排序报第一道", two_sealed))

    def internal_beats_sealed(case, world):
        asset = make_asset(case, world, entity="asset", role="stem_crop", sensitivity="internal_review")
        document = _document(case, world, entity="document")
        region = _region(case, world, document, entity="region", crop_asset=asset)
        _, version = make_question(case, world, entity="question", label="Q-10", sealed=True)
        _link(case, version, region, entity="source_link")
        return {"asset": asset}

    cases.append(gate_case("internal_review 先于封存判定", internal_beats_sealed))

    # --- editorial purpose ---------------------------------------------
    def editorial_live_verification(case, world):
        _session(case, world, entity="session", mode="verification", status="active")
        return {"asset": make_asset(case, world)}

    cases.append(gate_case("editorial + 活动验证会话 → 403", editorial_live_verification, purpose="editorial"))

    def editorial_live_mock(case, world):
        _session(case, world, entity="session", mode="mock_exam", status="active")
        return {"asset": make_asset(case, world)}

    cases.append(gate_case("editorial + 活动模拟考试 → 403", editorial_live_mock, purpose="editorial"))

    def editorial_clean(case, world):
        _session(case, world, entity="session", mode="verification", status="finished")
        return {"asset": make_asset(case, world)}

    cases.append(gate_case("editorial + 已结束会话 → 放行", editorial_clean, purpose="editorial"))

    def editorial_clean_no_session(case, world):
        return {"asset": make_asset(case, world, sensitivity="contains_answers")}

    cases.append(gate_case("editorial + 无会话（即使 contains_answers）→ 放行", editorial_clean_no_session, purpose="editorial"))

    # --- contains_answers ----------------------------------------------
    def answers_practice_session(case, world):
        session = _session(case, world, entity="session", mode="practice", status="active")
        return {"asset": make_asset(case, world, sensitivity="contains_answers"), "session": session}

    cases.append(gate_case("contains_answers + practice active → 放行", answers_practice_session))

    def answers_verification_session(case, world):
        session = _session(case, world, entity="session", mode="verification", status="active")
        return {"asset": make_asset(case, world, sensitivity="contains_answers"), "session": session}

    cases.append(gate_case("contains_answers + verification active → 403", answers_verification_session))

    def answers_mock_session(case, world):
        session = _session(case, world, entity="session", mode="mock_exam", status="active")
        return {"asset": make_asset(case, world, sensitivity="contains_answers"), "session": session}

    cases.append(gate_case("contains_answers + mock_exam active → 403", answers_mock_session))

    def answers_finished_verification(case, world):
        """`allows_pre_submit_answers` only looks at the mode, not at the status."""
        session = _session(case, world, entity="session", mode="verification", status="finished")
        return {"asset": make_asset(case, world, sensitivity="contains_answers"), "session": session}

    cases.append(gate_case("contains_answers + 已结束的 verification 会话仍 403", answers_finished_verification))

    def answers_finished_practice(case, world):
        session = _session(case, world, entity="session", mode="practice", status="finished")
        return {"asset": make_asset(case, world, sensitivity="contains_answers"), "session": session}

    cases.append(gate_case("contains_answers + 已结束的 practice 会话 → 放行", answers_finished_practice))

    def answers_no_session_live(case, world):
        _session(case, world, entity="session", mode="verification", status="active")
        return {"asset": make_asset(case, world, sensitivity="contains_answers")}

    cases.append(gate_case("contains_answers + 无 session 但项目有活动验证 → 403", answers_no_session_live))

    def answers_no_session_clean(case, world):
        _session(case, world, entity="session", mode="verification", status="finished")
        return {"asset": make_asset(case, world, sensitivity="contains_answers")}

    cases.append(gate_case("contains_answers + 无 session 且无活动验证 → 放行", answers_no_session_clean))

    def public_with_session(case, world):
        session = _session(case, world, entity="session", mode="verification", status="active")
        return {"asset": make_asset(case, world), "session": session}

    cases.append(gate_case("public_to_owner + verification session → 放行（不是 contains_answers）", public_with_session))

    def answers_preview_purpose(case, world):
        session = _session(case, world, entity="session", mode="practice", status="active")
        return {"asset": make_asset(case, world, sensitivity="contains_answers"), "session": session}

    cases.append(gate_case("contains_answers + purpose=preview → 放行", answers_preview_purpose, purpose="preview"))

    return cases


# --------------------------------------------------------------------------
# §E downloads (real view through django.test.Client)
# --------------------------------------------------------------------------
DOWNLOAD_HEADERS = ("Content-Type", "Content-Disposition", "X-Content-Type-Options", "Cache-Control")


def download_headers(response) -> dict:
    return {header: response.headers.get(header) for header in DOWNLOAD_HEADERS}


def body_record(asset: Asset, body: bytes) -> dict:
    """The served bytes vs the bytes the asset row claims (always deterministic here)."""
    return {
        "bytes": len(body),
        "sha256": sha256_hex(body),
        "deterministic": True,
        "length_matches_asset_row": len(body) == asset.size_bytes,
        "sha256_matches_asset_row": sha256_hex(body) == asset.checksum,
    }


def exposure_summary(case: Case, project: ExamProject) -> list[dict]:
    rows = []
    for event in ExposureEvent.objects.filter(project=project).order_by("created_at", "id"):
        detail = dict(event.detail or {})
        detail_keys = sorted(detail)
        if "server_time" in detail:
            detail["server_time"] = NOW_PLACEHOLDER
        case.symbols.setdefault(str(event.id), case.placeholder("exposure"))
        for key in ("question_id", "question_version_id", "family_id", "content_lineage_id", "session_item_id"):
            value = getattr(event, key)
            if value:
                kind = "session_item" if key == "session_item_id" else key.replace("_id", "")
                case.symbols.setdefault(str(value), case.placeholder(kind))
        if detail.get("asset_id"):
            case.symbols.setdefault(str(detail["asset_id"]), case.placeholder("asset"))
        rows.append(
            {
                "kind": event.kind,
                "purpose": event.purpose,
                "source": event.source,
                "reveals_answer": event.reveals_answer,
                "question_id": event.question_id,
                "question_version_id": event.question_version_id,
                "family_id": event.family_id,
                "content_lineage_id": event.content_lineage_id,
                "session_item_id": event.session_item_id,
                "detail_keys": detail_keys,
                "detail": detail,
                # The server clock is never part of the contract; only its shape is.
                "detail_server_time_is_iso": bool(event.detail.get("server_time")),
            }
        )
    return rows


def store_bytes_for_download(case: Case, asset_plan: dict, content: bytes) -> Asset:
    """Write the bytes through the real storage adapter, then create the row."""
    world = asset_plan["world"]
    suffix = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf"}.get(
        asset_plan["content_type"], "bin"
    )
    namespace = f"{world.user.id}/{world.project.id}/{asset_plan['namespace']}"
    key = deterministic_key(case.name, namespace, suffix)
    stored = get_storage().save(key, content, content_type=asset_plan["content_type"])
    asset = case.create(
        Asset,
        "asset",
        owner=world.user,
        project=world.project,
        subject=world.subject,
        role=asset_plan["role"],
        sensitivity=asset_plan["sensitivity"],
        object_key=stored.key,
        original_filename=asset_plan.get("original_filename", "page.png"),
        content_type=asset_plan["content_type"],
        size_bytes=stored.size,
        checksum=stored.checksum,
        width=asset_plan.get("width"),
        height=asset_plan.get("height"),
        is_retained=True,
        uploaded_by=world.user,
    )
    case.symbol(asset, "ASSET")
    return asset


def download_case(
    name: str,
    *,
    image: str,
    role: str = "past_paper_page",
    sensitivity: str = "public_to_owner",
    namespace: str = "source",
    purpose: str = "practice",
    with_session_item: bool = False,
    session_mode: str = "practice",
    question: bool = False,
    remove_bytes: bool = False,
    foreign_asset: bool = False,
) -> dict:
    case = Case(f"download:{name}")
    world = World(case)
    payload = IMAGES[image]
    # The download path never re-encodes: the bytes on disk are exactly the
    # fixture bytes, so the served sha256 *is* `images[name].sha256` and the
    # Node test can verify the body without a Pillow-compatible encoder.
    content = RAW[image]
    plan = {
        "world": world,
        "content_type": payload["content_type"],
        "role": role,
        "sensitivity": sensitivity,
        "namespace": namespace,
        "original_filename": "page.png",
        "width": payload["width"],
        "height": payload["height"],
    }
    asset = store_bytes_for_download(case, plan, content)
    foreign_asset_holder: list[Asset] = []
    if foreign_asset:
        other_project = world.extra_project()
        other_asset = case.create(
            Asset,
            "asset_foreign",
            owner=world.user,
            project=other_project,
            subject=None,
            role="other",
            sensitivity="public_to_owner",
            object_key=deterministic_key(case.name, f"{world.user.id}/{other_project.id}/uploads", "bin"),
            original_filename="foreign.bin",
            content_type="application/octet-stream",
            size_bytes=1,
            checksum="c" * 64,
            is_retained=True,
            uploaded_by=world.user,
        )
        case.symbol(other_asset, "ASSET_FOREIGN")
        foreign_asset_holder.append(other_asset)

    session_item = None
    if with_session_item:
        session = _session(case, world, entity="session", mode=session_mode, status="active")
        if question:
            _, version = make_question(case, world, entity="question", label="Q-1")
            family = _family(case, world)
            lineage = _lineage(case, world)
            _, version2 = make_question(
                case, world, entity="question_linked", label="Q-2", family=family, lineage=lineage
            )
            version = version2
        else:
            _, version = make_question(case, world, entity="question", label="Q-1")
        session_item = case.create(
            SessionItem,
            "session_item",
            session=session,
            ordinal=1,
            question_version=version,
            answer_key_version=None,
            max_score=Decimal("2.00"),
            purpose="practice",
            tutoring_allowed=True,
        )
        case.symbol(session_item, "SESSION_ITEM")

    if remove_bytes:
        Path(settings.PRIVATE_MEDIA_ROOT, asset.object_key).unlink()

    client = world.client()
    # A foreign asset is requested *through this project's* URL: the scope check
    # must refuse it, not the URL builder.
    target_asset = foreign_asset_holder[0] if foreign_asset else asset
    url = f"/api/v1/projects/{world.project.id}/assets/{target_asset.id}"
    params = {"purpose": purpose}
    if session_item is not None:
        params["session_item_id"] = str(session_item.id)
    case.steps.append(
        {
            "op": "GET /projects/{project_id}/assets/{asset_id}",
            "asset": name,
            "purpose": purpose,
            "session_item": "own" if session_item is not None else None,
            "bytes_present": not remove_bytes,
        }
    )
    response = client.get(url, params)
    if response.status_code == 200:
        body = b"".join(response.streaming_content)
        expected = {
            "ok": True,
            "status": 200,
            "headers": download_headers(response),
            "body": body_record(asset, body),
            "exposure": exposure_summary(case, world.project),
            "counts": project_counts(world.project),
        }
    else:
        payload_body = json.loads(body_of(response))
        expected = {
            "ok": False,
            "status": response.status_code,
            "error": payload_body.get("error"),
            "exposure": exposure_summary(case, world.project),
            "counts": project_counts(world.project),
        }
    case.finalize()
    return {
        "name": f"downloads: {name}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": case.symbolize(expected),
    }


def body_of(response) -> bytes:
    if getattr(response, "streaming", False):
        response.streaming = False
        return b"".join(response.streaming_content)
    return response.content


def download_cases() -> list[dict]:
    return [
        download_case(
            "image/png 默认 role → inline + 四个 header",
            image="png_rgb",
            role="past_paper_page",
            namespace="source",
        ),
        download_case(
            "image/webp → inline",
            image="webp_lossy",
            role="other",
            namespace="uploads",
        ),
        download_case(
            "application/pdf → attachment",
            image="pdf_minimal",
            role="answer_page",
            namespace="source",
        ),
        download_case(
            "text/plain → attachment",
            image="text_bytes",
            role="other",
            namespace="uploads",
        ),
        download_case(
            "contains_answers + practice 会话 → 写 exposure",
            image="png_rgb",
            role="answer_page",
            sensitivity="contains_answers",
            namespace="source",
            with_session_item=True,
            session_mode="practice",
            question=True,
        ),
        download_case(
            "contains_answers + purpose=bogus → exposure 回落 practice",
            image="png_rgb",
            role="answer_page",
            sensitivity="contains_answers",
            namespace="source",
            purpose="bogus_purpose",
            with_session_item=True,
            session_mode="practice",
        ),
        download_case(
            "contains_answers 且无会话 → 200 + 仍写 exposure（question 为空）",
            image="png_rgb",
            role="answer_page",
            sensitivity="contains_answers",
            namespace="source",
        ),
        download_case(
            "磁盘缺字节 → 404 信封",
            image="png_rgb",
            role="other",
            namespace="uploads",
            remove_bytes=True,
        ),
        download_case(
            "asset 不属于该项目 → 404",
            image="png_rgb",
            role="other",
            namespace="uploads",
            foreign_asset=True,
        ),
    ]


# --------------------------------------------------------------------------
# §F O01 upload_asset (real HTTP)
# --------------------------------------------------------------------------
def o01_case(
    name: str,
    *,
    image: str | None = None,
    content_type: str | None = None,
    filename: str = "page.png",
    role: str | None = None,
    content: bytes | None = None,
    twice: bool = False,
) -> dict:
    case = Case(f"o01:{name}")
    world = World(case)
    payload = IMAGES[image] if image else None
    body = content if content is not None else RAW[image]
    ct = content_type or (payload["content_type"] if payload else "application/octet-stream")
    data = {"file": SimpleUploadedFile(filename, body, content_type=ct)}
    if role is not None:
        data["role"] = role
    case.steps.append(
        {
            "op": "POST /projects/{project_id}/assets",
            "image": image,
            "content_type": ct,
            "filename": filename,
            "role": role,
            "twice": twice,
        }
    )
    client = world.client()
    url = f"/api/v1/projects/{world.project.id}/assets"
    responses = [client.post(url, data=data)]
    if twice:
        responses.append(
            client.post(url, data={"file": SimpleUploadedFile(filename, body, content_type=ct), **({"role": role} if role else {})})
        )
    last = responses[-1]
    if last.status_code == 201:
        asset = Asset.objects.get(id=last.json()["id"])
        expected = {
            "ok": True,
            "status": last.status_code,
            "asset": describe_asset(
                case, asset, deterministic_checksum=not ct.startswith("image/"), name="ASSET"
            ),
            "row_counts": project_counts(world.project),
        }
        if twice:
            first = Asset.objects.get(id=responses[0].json()["id"])
            case.adopt(first, "<asset:first>")
            expected["duplicate_upload"] = {
                "two_rows": Asset.objects.filter(project=world.project).count() == 2,
                "ids_distinct": str(first.id) != str(asset.id),
                "checksums_equal": first.checksum == asset.checksum,
            }
    else:
        error = json.loads(body_of(last)).get("error")
        expected = {"ok": False, "status": last.status_code, "error": error, "row_counts": project_counts(world.project)}
    case.finalize()
    return {
        "name": f"assets: {name}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": case.symbolize(expected),
    }


def o01_cases() -> list[dict]:
    return [
        o01_case("默认 role/sensitivity（png）", image="png_rgb"),
        o01_case("role=answer_page 仍为 public_to_owner", image="png_rgb", role="answer_page"),
        o01_case("role=stem_crop → region 命名空间", image="png_rgb", role="stem_crop"),
        o01_case("空内容 → 400", image="png_rgb", content=b"", filename="empty.png"),
        o01_case("role 非法 → 400", image="png_rgb", role="not_a_role"),
        o01_case("两次相同上传产生两行（无去重）", image="png_rgb", twice=True),
        o01_case("application/pdf（无尺寸）", image="pdf_minimal", filename="paper.pdf"),
        o01_case("text/plain（O01 允许非图片字节）", image="text_bytes", filename="note.txt"),
        o01_case("jpeg 成功", image="jpeg_rgb", filename="scan.jpg"),
    ]


# --------------------------------------------------------------------------
# §G O05 create_image_source (real HTTP)
# --------------------------------------------------------------------------
def o05_case(
    name: str,
    *,
    image: str | None = None,
    content_type: str | None = None,
    filename: str = "page.png",
    role: str | None = None,
    title: str | None = None,
    source_note: str | None = None,
    usage_scope: str | None = None,
    subject: str = "none",
    content: bytes | None = None,
) -> dict:
    case = Case(f"o05:{name}")
    world = World(case)
    payload = IMAGES[image] if image else None
    body = content if content is not None else RAW[image]
    ct = content_type or (payload["content_type"] if payload else "application/octet-stream")
    data = {
        "file": SimpleUploadedFile(filename, body, content_type=ct),
        "role": role if role is not None else "past_paper_page",
        "title": title or "",
        "source_note": source_note or "",
        "usage_scope": usage_scope or "",
        "subject_id": "",
    }
    if subject == "own":
        data["subject_id"] = str(world.subject.id)
    elif subject == "cross":
        other_project = world.extra_project()
        data["subject_id"] = str(world.extra_subject(other_project).id)
    elif subject == "missing":
        data["subject_id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, f"b3-missing-subject:{case.name}"))
    case.steps.append(
        {
            "op": "POST /projects/{project_id}/source-documents/image",
            "image": image,
            "content_type": ct,
            "filename": filename,
            "role": data["role"],
            "subject": subject,
            "title": data["title"],
            "source_note": data["source_note"],
            "usage_scope": data["usage_scope"],
        }
    )
    client = world.client()
    response = client.post(f"/api/v1/projects/{world.project.id}/source-documents/image", data=data)
    if response.status_code == 201:
        document = SourceDocument.objects.get(id=response.json()["id"])
        asset = Asset.objects.get(id=document.asset_id)
        expected = {
            "ok": True,
            "status": response.status_code,
            "document": describe_document(case, document),
            "asset": describe_asset(case, asset, deterministic_checksum=not ct.startswith("image/"), name="ASSET"),
            "row_counts": project_counts(world.project),
        }
        if ct.startswith("image/"):
            expected["stored"] = stored_facts(asset, body)
        else:
            expected["stored"] = passthrough_facts(asset, body)
    else:
        expected = {
            "ok": False,
            "status": response.status_code,
            "error": json.loads(body_of(response)).get("error"),
            "row_counts": project_counts(world.project),
        }
    case.finalize()
    return {
        "name": f"image_sources: {name}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": case.symbolize(expected),
    }


def o05_cases() -> list[dict]:
    return [
        o05_case("正常 png", image="png_rgb"),
        o05_case("role=answer_page → contains_answers", image="png_rgb", role="answer_page"),
        o05_case("role=stem_crop 保持 public_to_owner", image="png_rgb", role="stem_crop"),
        o05_case("role 非法 → 400", image="png_rgb", role="bogus"),
        o05_case("空文件 → 400", image="png_rgb", content=b"", filename="empty.png"),
        o05_case("非图片 MIME 现状：text/plain 存入 image 文档", image="text_bytes", filename="note.txt"),
        o05_case("image/gif 被 MIME allowlist 拒绝", image="gif", filename="page.gif"),
        o05_case(
            "title/source_note/usage_scope 截断 300/500/200",
            image="png_rgb",
            title="题" * 320,
            source_note="注" * 520,
            usage_scope="用" * 220,
            subject="own",
        ),
        o05_case("subject 跨项目 → 404", image="png_rgb", subject="cross"),
        o05_case("subject 不存在 → 404", image="png_rgb", subject="missing"),
        o05_case("jpeg + EXIF 成功", image="jpeg_exif_orientation6", filename="scan.jpg", role="answer_page"),
    ]


# --------------------------------------------------------------------------
# §H O08 start_image_import (manual degradation, use_vision=False)
# --------------------------------------------------------------------------
def run_image_import(
    world: World,
    *,
    uploads: list[dict],
    subject=None,
    title: str = "",
    role: str = "past_paper_page",
) -> tuple[ImportJob, list[SourceDocument], list[SourceDocument]]:
    """Exactly the body of `apps.ingestion.api.create_image_import`, minus claim/HTTP.

    `use_vision=False` is forced so the manual path is the only one exercised.
    """
    project = world.project
    contents = []
    for upload in uploads:
        validate_image(content=RAW[upload["image"]], content_type=upload["content_type"])
        contents.append(RAW[upload["image"]])
    checksums = [file_checksum(content) for content in contents]
    documents: list[SourceDocument] = []
    duplicates: list[SourceDocument] = []
    for upload, content, checksum in zip(uploads, contents, checksums, strict=True):
        existing = find_duplicate_document(project=project, checksum=checksum)
        if existing is not None:
            duplicates.append(existing)
            continue
        documents.append(
            create_image_document(
                owner=world.user,
                project=project,
                content=content,
                content_type=upload["content_type"],
                role=role,
                title=title,
                subject=subject,
                sensitivity="contains_answers" if role == "answer_page" else "public_to_owner",
                original_filename=upload["filename"],
            )
        )
    job = import_services.start_image_import(
        owner=world.user,
        project=project,
        documents=documents or duplicates,
        subject=subject,
        title=title,
        use_vision=False,
    )
    if duplicates:
        add_job_problem(
            job,
            "duplicate_source_file",
            f"其中 {len(duplicates)} 张图片与已有来源文件完全相同，已复用原来源而未新增（避免同一试卷重复统计）。",
            severity="warning",
        )
    return job, documents, duplicates


def o08_case(
    name: str,
    *,
    images: list[str],
    title: str = "",
    role: str = "past_paper_page",
    subject: str = "none",
    pre_existing: list[str] | None = None,
) -> dict:
    case = Case(f"o08:{name}")
    world = World(case)
    chosen_subject = None
    if subject == "own":
        chosen_subject = world.subject

    reused: list[SourceDocument] = []
    for entry in pre_existing or []:
        payload = IMAGES[entry]
        document = create_image_document(
            owner=world.user,
            project=world.project,
            content=RAW[entry],
            content_type=payload["content_type"],
            # Uploaded earlier through the plain source-image route: the same
            # bytes, but a different role/sensitivity than this request asks for.
            role="past_paper_page",
            title="既有来源",
            subject=chosen_subject,
            sensitivity="public_to_owner",
            original_filename=f"existing-{entry}.png",
        )
        case.adopt(document)
        reused.append(document)

    uploads = [
        {
            "image": entry,
            "content_type": IMAGES[entry]["content_type"],
            "filename": f"{index + 1:02d}-{entry}.png",
        }
        for index, entry in enumerate(images)
    ]
    case.steps.append(
        {
            "op": "create_image_import(use_vision=False)",
            "images": images,
            "title": title,
            "role": role,
            "subject": subject,
            "pre_existing_images": pre_existing or [],
        }
    )
    job, documents, duplicates = run_image_import(
        world, uploads=uploads, subject=chosen_subject, title=title, role=role
    )
    candidates = list(ImportCandidate.objects.filter(job=job).order_by("created_at", "id"))
    regions = list(SourceRegion.objects.filter(document__project=world.project).order_by("created_at", "id"))
    expected = {
        "ok": True,
        "job": describe_job(case, job),
        "documents": [describe_document(case, document) for document in documents],
        "duplicates": [str(document.id) for document in duplicates],
        "candidates": [describe_candidate(case, candidate) for candidate in candidates],
        "regions": [describe_region(case, region) for region in regions],
        "row_counts": project_counts(world.project),
    }
    if reused:
        expected["pre_existing_documents"] = [
            {
                "id": str(document.id),
                "checksum": STORE_PLACEHOLDER_SUM,
                "checksum_equals_raw_image_sha256": document.checksum == IMAGES[entry]["sha256"],
                "role": document.role,
                "sensitivity": document.sensitivity,
                "document_type": document.document_type,
            }
            for document, entry in zip(reused, pre_existing or [])
        ]
    case.finalize()
    return {
        "name": f"image_imports: {name}",
        "rows": case.Rowset(),
        "symbols": case.exported_symbols(),
        "steps": case.steps,
        "expected": case.symbolize(expected),
    }


def o08_cases() -> list[dict]:
    return [
        o08_case("单张 png", images=["png_rgb"]),
        o08_case("两张 png", images=["png_rgb", "png_rgba"]),
        o08_case("全重复（已有同字节 png）", images=["png_rgb"], pre_existing=["png_rgb"]),
        o08_case(
            "新旧混合：只导入新文件",
            images=["png_rgb", "png_la"],
            pre_existing=["png_rgb"],
        ),
        o08_case("answer_page 的 sensitivity", images=["png_rgb"], role="answer_page", subject="own"),
        o08_case(
            "answer_page 全重复：复用文档的 role/sensitivity 不被覆盖",
            images=["png_rgb"],
            role="answer_page",
            pre_existing=["png_rgb"],
        ),
        o08_case("带 title 时写入 display_label", images=["png_rgb"], title="2024 真题"),
        o08_case("subject 传入", images=["png_rgb"], subject="own"),
    ]


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
IMAGES: dict[str, dict] = {}
RAW: dict[str, bytes] = {}


def main() -> int:
    global IMAGES

    if MEDIA_ROOT.exists():
        shutil.rmtree(MEDIA_ROOT)
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)

    setup_test_environment()
    connection.settings_dict["TEST"] = {
        **connection.settings_dict.get("TEST", {}),
        "NAME": TEST_DB_NAME,
    }
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        settings.PRIVATE_MEDIA_ROOT = str(MEDIA_ROOT)
        reset_storage_cache()

        IMAGES = build_images()

        sections = {
            "store": store_cases(),
            "keys": key_cases(),
            "dedupe": dedupe_cases(),
            "gates": gate_cases(),
            "downloads": download_cases(),
            "assets": o01_cases(),
            "image_sources": o05_cases(),
            "image_imports": o08_cases(),
        }
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)

    for entries in sections.values():
        for case in entries:
            case["expected"] = deep_json(case["expected"])
            case["steps"] = deep_json(case["steps"])

    leaks: list[str] = []
    for entries in sections.values():
        for case in entries:
            leaks.extend(_case_leaks(case))
    if leaks:
        raise SystemExit("non-deterministic identities leaked into the fixture:\n  " + "\n  ".join(leaks))

    payload = {"images": IMAGES, **sections}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    print(f"wrote {OUT}")
    for section, entries in sections.items():
        print(f"{section}: {len(entries)} cases")
        for case in entries:
            state = "ok" if case["expected"].get("ok") else f"refused({case['expected']['error']['code']})"
            print(f"  {section:<14} {case['name']}  {state}")
    print(f"images: {len(IMAGES)} fixtures")
    return 0


def _case_leaks(case: dict) -> list[str]:
    """A uuid that is not a seeded row id would be random and breaks rerun equality."""
    known = set(case["symbols"])
    found = []

    def walk(value, path):
        if isinstance(value, str):
            for match in UUID_RE.findall(value):
                if match not in known:
                    found.append(f"{case['name']} :: {path} :: {match}")
        elif isinstance(value, dict):
            for key, item in value.items():
                walk(item, f"{path}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, f"{path}[{index}]")

    walk(case["expected"], "expected")
    walk(case["steps"], "steps")
    return found


if __name__ == "__main__":
    raise SystemExit(main())
