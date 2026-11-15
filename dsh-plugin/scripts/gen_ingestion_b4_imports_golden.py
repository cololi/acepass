#!/usr/bin/env python
"""Golden vectors for B4: the native-text PDF *import write set*.

Oracle: the real ``apps.ingestion.services.imports.start_pdf_import`` on a
throw-away PostgreSQL database, fed with real PDF bytes produced by
``backend/tests/support/pdf_builder.py``. Nothing here re-implements a rule:
every ``expected`` block is a projection of what Django actually wrote
(document/asset/candidate/region rows, the job's ``problems`` and
``page_diagnostics`` JSON, the ``refresh_candidate_issues`` list, the paper
revision and the audit rows). Where a value is inherently non-deterministic (a
service-generated ``uuid4`` primary key, the random object-key token, the wall
clock) it is replaced by a stable placeholder and the *property* a port must
preserve is recorded next to it — the split the spec asks for in §5.1
("properties, not byte equality").

Layout::

    {"now": "<the instant the Node side must pass as its clock>",
     "fixtures": {name: {base64, sha256, bytes, extraction_pages, [extraction_error]}},
     "cases":  [{name, geometry_comparable, seed, input, expected}],
     "errors": [{name, geometry_comparable, seed, input, error,
                 row_counts_before, row_counts_after}],
     "notes":  [ ... what this fixture does *not* assert, and why ... ]}

``fixtures`` carries the input bytes *and* the page-by-page extraction the
Django extractor produced from them, so a Node test can check its own text layer
(``text``/``character_count``/``fragment_count``/``columns``/scan flags) before
it compares the write set. A fixture the extractor rejects (non-PDF, broken,
encrypted, all-scanned) carries ``extraction_pages: []`` plus the
``extraction_error`` it raises.

Placeholder vocabulary (``expected`` only; seeded rows use ``symbols``):

    <document:n> <candidate:n> <region:n> <asset:n>   service-created ids, by insertion order
    <job> [<job:n>]                                   the reported import job
    <paper:n> <revision>                              paper occurrence / paper revision
    <stored_sha256:n>                                 sha256 of the stored bytes
    <owner>/<project>/source/<2hex>/<32hex>.pdf       shape of the object key
    PROJECT SUBJECT USER JOB_PREVIOUS PAPER ...       seeded row ids

Determinism. Seeded rows use ``uuid5`` ids and a fixed clock (``BASE + n
minutes``); the reported import runs last, and every service-created id is
turned into a placeholder *in the order the rows were inserted* (a ``post_save``
receiver records that order). Two consecutive runs produce a byte-identical
file; the script prints its sha256 at the end.

Why every paper fixture is built with ``build_layout_pdf``: pypdf 5.1.0
computes the ``TL`` text lead as ``operand * font_size``, so any page that
advances with ``T*`` reports a baseline inflated by the font size. Explicit
``Tm`` placement has no such distortion, so fragment geometry — and therefore
``source_spans[].bbox`` and every region's ``y``/``height`` — is comparable
between pypdf and pdfjs. The one fixture that cannot avoid ``T*`` (a scanned
page mixed with native pages inside one file, ``build_scanned_pdf``) is marked
``geometry_comparable: false`` at the case level; see ``notes``.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/gen_ingestion_b4_imports_golden.py
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
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

from apps.audit.models import ContentRevision  # noqa: E402
from apps.common.errors import AcePassError  # noqa: E402
from apps.exams.models import (  # noqa: E402
    ExamProject,
    Paper,
    PaperItem,
    PaperRevision,
    Subject,
)
from apps.ingestion.models import (  # noqa: E402
    Asset,
    CandidateRevision,
    ImportCandidate,
    ImportJob,
    SourceDocument,
    SourceRegion,
)
from apps.ingestion.services import imports as import_services  # noqa: E402
from apps.ingestion.services.imports import (  # noqa: E402
    MAX_JOB_PAGE_DIAGNOSTICS,
    PDF_EXTRACTOR_VERSION,
    PdfUpload,
)
from apps.ingestion.services.pdf_text import (  # noqa: E402
    MAX_PDF_PAGES,
    extract_native_text,
)
from apps.ingestion.storage import get_storage, reset_storage_cache  # noqa: E402
from apps.question_bank.models import Question, QuestionVersion  # noqa: E402
from django.conf import settings  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.db.models.signals import post_save  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from tests.support.pdf_builder import build_layout_pdf, build_scanned_pdf  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "ingestion_b4_imports.json"

#: Every seeded timestamp is derived from this instant, never from the wall clock.
BASE = datetime(2026, 4, 1, 0, 0, tzinfo=timezone.utc)

#: The instant the Node side passes as "now". It is later than every seeded row,
#: so a lookup ordered by ``created_at`` sees the fixture rows before the rows the
#: import writes — the same ordering the Django run produced.
NOW = "2026-04-01T00:05:00+00:00"

#: The throw-away private storage root (recreated on every run).
MEDIA_ROOT = Path("/tmp/acepass-b4-golden-media")

TEST_DB_NAME = "test_acepass_b4_golden"

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

#: Shape of the key ``store_asset`` generates for a PDF upload: the server picks
#: the token, and the key never contains the original filename.
OBJECT_KEY_SHAPE = "<owner>/<project>/source/<2hex>/<32hex>.pdf"
OBJECT_KEY_PATTERN = re.compile(r"[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+/[0-9a-f]{2}/[0-9a-f]{32}\.pdf$")

#: pypdf logs "EOF marker not found" for the deliberately corrupt fixture.
logging.getLogger("pypdf").setLevel(logging.ERROR)


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


def stored_bytes(asset: Asset) -> bytes:
    handle = get_storage().open(asset.object_key)
    try:
        return handle.read()
    finally:
        handle.close()


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------
#: One labelled question, one explicit `Tm` per line. The layout builder places
#: every line by coordinate, so the extractor sees exactly these positions and
#: pypdf's `TL` lead computation never comes into play.
QUESTION_LINES = (
    "{label}．【题型】单选题",
    "【题干】{side}第{label}题的题干内容。",
    "【选项】A. 甲",
    "B. 乙",
    "C. 丙",
    "D. 丁",
    "【答案】{answer}",
    "【解析】{side}第{label}题的解析。",
    "【考点】{side}考点{label}",
)


def question_fragments(
    label: str, *, answer: str, side: str = "", x: float = 60, top: float = 780, step: float = 40
) -> list[dict]:
    """Nine fragments: one labelled question, top-down, at explicit coordinates."""
    lines = [template.format(label=label, answer=answer, side=side) for template in QUESTION_LINES]
    return [{"x": x, "y": top - step * index, "text": text} for index, text in enumerate(lines)]


def build_paper_two_pages() -> bytes:
    """Two native pages, two questions each (labels 1-4)."""
    page_one = question_fragments("1", answer="A", top=780) + question_fragments("2", answer="B", top=420)
    page_two = question_fragments("3", answer="C", top=780) + question_fragments("4", answer="D", top=420)
    return build_layout_pdf([page_one, page_two], title="2026 春季模拟卷一")


def build_paper_second() -> bytes:
    """A second, different paper: labels 5-6, so the position keys continue."""
    return build_layout_pdf(
        [question_fragments("5", answer="A", top=780) + question_fragments("6", answer="B", top=420)],
        title="2026 春季模拟卷二",
    )


def build_paper_answers() -> bytes:
    """An answer page the parser can match by printed question number."""
    return build_layout_pdf(
        [
            [
                {"x": 60, "y": 780, "text": "1. A"},
                {"x": 60, "y": 740, "text": "2. B"},
                {"x": 60, "y": 700, "text": "3. C"},
            ]
        ],
        title="2026 春季模拟卷一（答案）",
    )


def build_paper_cross_page() -> bytes:
    """One question whose stem is split by a page break.

    Page 1 ends without terminal punctuation and page 2 opens with a plain
    sentence fragment — exactly the pair ``detect_page_continuations`` accepts.
    """
    return build_layout_pdf(
        [
            [
                {"x": 60, "y": 780, "text": "1．【题型】单选题"},
                {"x": 60, "y": 720, "text": "【题干】跨页题目在上一页的题干，句子还没有结束"},
            ],
            [
                {"x": 60, "y": 780, "text": "并且这一行是接续上一页的题干内容。"},
                {"x": 60, "y": 720, "text": "【选项】A. 甲"},
                {"x": 60, "y": 660, "text": "B. 乙"},
                {"x": 60, "y": 600, "text": "C. 丙"},
                {"x": 60, "y": 540, "text": "D. 丁"},
                {"x": 60, "y": 480, "text": "【答案】A"},
            ],
        ],
        title="跨页题目材料",
    )


def build_paper_two_columns() -> bytes:
    """Two x bands separated by a wide gutter, side by side for >50% of the page.

    The 60pt lead is deliberate: ``_detect_columns`` requires the two bands to
    overlap vertically for at least half the page height, and nine lines at 40pt
    only cover ~0.40 of it.
    """
    left = question_fragments("1", answer="A", side="左栏", x=60, step=60)
    right = question_fragments("2", answer="B", side="右栏", x=330, step=60)
    return build_layout_pdf([left + right], title="双栏排版材料")


def build_paper_scanned_mixed() -> bytes:
    """Page 2 is image-only; pages 1 and 3 carry native text.

    This is the only way to exercise "a scanned page inside a *successful*
    import": a file whose every page is scanned is rejected with
    ``no_text_layer``. Each question's stem is the **first** line of its page,
    the one baseline ``build_scanned_pdf``'s ``T*`` lead does not distort, so the
    regions still land on a comparable box; see ``notes``.
    """
    page_one = "1．【题干】扫描件混合文档中的第一题。\n【选项】A. 甲\nB. 乙\nC. 丙\nD. 丁\n【答案】A"
    page_three = "2．【题干】扫描件混合文档中的第二题。\n【选项】A. 甲\nB. 乙\nC. 丙\nD. 丁\n【答案】B"
    return build_scanned_pdf([page_one, None, page_three], title="扫描件混排材料")


def build_paper_scanned_only() -> bytes:
    """One image-only page: a real PDF with no text layer at all."""
    return build_scanned_pdf([None], title="纯扫描件")


def build_paper_no_segments() -> bytes:
    """A real text layer with no question structure at all."""
    return build_layout_pdf(
        [[{"x": 60, "y": 780, "text": "本页无题目，只有说明文字。"}]], title="无题目说明页"
    )


def build_paper_encrypted() -> bytes:
    """A real PDF with a user password, so opening it without one fails."""
    from pypdf import PdfReader, PdfWriter

    source = build_layout_pdf([question_fragments("1", answer="A")], title="加密材料")
    reader = PdfReader(io.BytesIO(source))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt("acepass-b4-secret", algorithm="RC4-128")
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def build_paper_corrupt() -> bytes:
    """The first 55% of a real PDF: still starts with %PDF-, no longer parses."""
    good = build_paper_two_pages()
    return good[: int(len(good) * 0.55)]


def build_truncation_pages(index: int) -> bytes:
    """MAX_PDF_PAGES native pages with no question structure (page-diagnostics fuel)."""
    pages = [
        [{"x": 60, "y": 780, "text": f"第 {index}-{page} 页 版式诊断用页，无题目结构。"}]
        for page in range(1, MAX_PDF_PAGES + 1)
    ]
    return build_layout_pdf(pages, title=f"诊断分册{index}")


def build_fixtures() -> dict[str, bytes]:
    """Every fixture, built from the real builders (never from a content stream)."""
    return {
        "paper_two_pages": build_paper_two_pages(),
        "paper_second": build_paper_second(),
        "paper_answers": build_paper_answers(),
        "paper_cross_page": build_paper_cross_page(),
        "paper_two_columns": build_paper_two_columns(),
        "paper_scanned_mixed": build_paper_scanned_mixed(),
        "paper_scanned_only": build_paper_scanned_only(),
        "paper_no_segments": build_paper_no_segments(),
        "paper_encrypted": build_paper_encrypted(),
        "paper_corrupt": build_paper_corrupt(),
        "paper_trunc_a": build_truncation_pages(1),
        "paper_trunc_b": build_truncation_pages(2),
        "paper_trunc_c": build_truncation_pages(3),
        "notes_txt": "这不是 PDF，只是一段普通文本。\n".encode(),
    }


def extraction_row(page) -> dict:
    """One page of the real extractor output, as the Node side will see it."""
    return {
        "page_index": page.page_index,
        "text": page.text,
        "character_count": page.character_count,
        "fragment_count": len(page.fragments),
        "columns": page.columns,
        "has_table_grid": page.has_table_grid,
        "has_formula_tokens": page.has_formula_tokens,
        "is_scanned": page.is_scanned,
        "reading_order_reliable": page.reading_order_reliable,
        "diagnostics": list(page.diagnostics),
    }


#: How each fixture was produced. Only the encrypted and corrupt ones post-process
#: what ``pdf_builder`` wrote (pypdf encryption / truncation); nothing hand-writes a
#: content stream.
FIXTURE_BUILDERS = {
    "paper_two_pages": "build_layout_pdf: 2 pages, 2 labelled questions per page",
    "paper_second": "build_layout_pdf: 1 page, labels 5-6",
    "paper_answers": "build_layout_pdf: 1 page, '1. A / 2. B / 3. C'",
    "paper_cross_page": "build_layout_pdf: 2 pages, one stem split by the page break",
    "paper_two_columns": "build_layout_pdf: 1 page, two x bands 60pt apart by 270pt, 60pt lead",
    "paper_scanned_mixed": "build_scanned_pdf([text, None, text])",
    "paper_scanned_only": "build_scanned_pdf([None])",
    "paper_no_segments": "build_layout_pdf: 1 page, one plain sentence",
    "paper_encrypted": "build_layout_pdf + pypdf PdfWriter.encrypt(user_password, RC4-128)",
    "paper_corrupt": "build_layout_pdf truncated to 55% of its bytes",
    "paper_trunc_a": "build_layout_pdf: 200 pages, no question structure",
    "paper_trunc_b": "build_layout_pdf: 200 pages, no question structure",
    "paper_trunc_c": "build_layout_pdf: 200 pages, no question structure",
    "notes_txt": "raw UTF-8 bytes (not a PDF)",
}


def describe_fixtures(raw: dict[str, bytes]) -> dict[str, dict]:
    described: dict[str, dict] = {}
    for name, content in raw.items():
        entry: dict = {
            "base64": base64.b64encode(content).decode("ascii"),
            "sha256": sha256_hex(content),
            "bytes": len(content),
            "builder": FIXTURE_BUILDERS[name],
        }
        try:
            extraction = extract_native_text(content)
        except AcePassError as exc:
            # The rejection is part of the vector: a non-PDF, a broken file, an
            # encrypted file or an all-scanned file never reaches the write set.
            entry["extraction_pages"] = []
            entry["extraction_error"] = {
                "kind": "acepass",
                "class": type(exc).__name__,
                "status": exc.status_code,
                "code": exc.code,
                "message": exc.message,
                "details": deep_json(exc.details),
            }
        else:
            entry["extraction_pages"] = [extraction_row(page) for page in extraction.pages]
        described[name] = entry
    return described


# --------------------------------------------------------------------------
# creation log: placeholders numbered by insertion order
# --------------------------------------------------------------------------
_CREATION_LOG: list[tuple[type, object]] | None = None

#: model -> the word used in its `<word:n>` placeholder. `ContentRevision` is
#: absent on purpose: its `entity_id` is the id of the row it audits, so it is
#: rendered through that row's placeholder instead.
PLACEHOLDER_KINDS = {
    Asset: "asset",
    SourceDocument: "document",
    SourceRegion: "region",
    ImportCandidate: "candidate",
    ImportJob: "job",
    Paper: "paper",
    PaperRevision: "revision",
}


def _record_creation(sender, instance, created, **kwargs) -> None:
    if created and _CREATION_LOG is not None:
        _CREATION_LOG.append((sender, instance.pk))


for _model in (*PLACEHOLDER_KINDS, ContentRevision):
    post_save.connect(
        _record_creation,
        sender=_model,
        dispatch_uid=f"acepass-b4-golden:{_model._meta.label_lower}",
        weak=False,
    )


class Case:
    """Deterministic identities, fixed timestamps and a placeholder registry."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.rows: dict[str, list[dict]] = {}
        self.symbols: dict[str, str] = {}
        self.placeholders: dict[str, str] = {}
        self.placeholder_numbers: dict[str, int] = {}
        self.creation_index: dict[str, int] = {}
        self.clock = BASE
        self._counters: dict[str, int] = {}
        self._placeholder_counters: dict[str, int] = {}

    # -- identity / timestamps ---------------------------------------------
    def uid(self, entity: str) -> uuid.UUID:
        n = self._counters.get(entity, 0) + 1
        self._counters[entity] = n
        return uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b4:{self.name}:{entity}:{n}")

    def now(self) -> datetime:
        self.clock = self.clock + timedelta(minutes=1)
        return self.clock

    def _pin(self, obj) -> None:
        names = {field.name for field in obj._meta.concrete_fields}
        stamp = self.now()
        overrides = {}
        if "created_at" in names:
            overrides["created_at"] = stamp
        if "updated_at" in names:
            overrides["updated_at"] = stamp
        if "date_joined" in names:
            overrides["date_joined"] = stamp
        if overrides:
            type(obj)._base_manager.filter(pk=obj.pk).update(**overrides)
            obj.refresh_from_db()

    def create(self, model, entity: str, symbol: str | None = None, **kwargs):
        """Insert one *seeded* row: fixed uuid5 id, fixed timestamps, dumped into `rows`."""
        obj = model(id=self.uid(entity), **kwargs)
        obj.save(force_insert=True)
        self._pin(obj)
        self.rows.setdefault(model._meta.db_table, []).append(dump_row(obj))
        if symbol is not None:
            self.symbols[str(obj.pk)] = symbol
        return obj

    # -- placeholders ------------------------------------------------------
    def placeholder(self, value, kind: str) -> str:
        key = str(value)
        if key in self.placeholders:
            return self.placeholders[key]
        n = self._placeholder_counters.get(kind, 0) + 1
        self._placeholder_counters[kind] = n
        if kind == "job":
            text = "<job>" if n == 1 else f"<job:{n}>"
        elif kind == "revision":
            text = "<revision>" if n == 1 else f"<revision:{n}>"
        else:
            text = f"<{kind}:{n}>"
        self.placeholders[key] = text
        self.placeholder_numbers[key] = n
        self.creation_index.setdefault(key, len(self.creation_index) + 1)
        return text

    def adopt_created(self, entries: list[tuple[type, object]]) -> None:
        """Name every row the call inserted, in the order it was inserted."""
        for model, pk in entries:
            if model is ContentRevision:
                continue
            kind = PLACEHOLDER_KINDS.get(model)
            if kind is not None:
                self.placeholder(pk, kind)

    def render(self, value):
        """Replace ids with their symbol / placeholder, everywhere they appear."""
        if isinstance(value, uuid.UUID):
            value = str(value)
        if isinstance(value, str):
            return UUID_RE.sub(lambda match: self.label(match.group(0)), value)
        if isinstance(value, dict):
            return {key: self.render(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.render(item) for item in value]
        return value

    def label(self, raw: str) -> str:
        if raw in self.symbols:
            return self.symbols[raw]
        if raw in self.placeholders:
            return self.placeholders[raw]
        return raw

    # -- ordered access ----------------------------------------------------
    def order_key(self, value) -> int:
        return self.creation_index.get(str(value), 1 << 30)

    def document_number(self, value) -> int:
        return self.placeholder_numbers.get(str(value), 0)

    def seed_payload(self) -> dict:
        """The rows a Node test has to seed, and the names for their ids."""
        return {"rows": self.rows, "symbols": dict(self.symbols)}


class World:
    """The scaffolding every case starts from: owner, project, subject."""

    def __init__(self, case: Case, *, with_other_project: bool = False) -> None:
        self.case = case
        User = get_user_model()
        slug = re.sub(r"[^a-z0-9]+", "-", case.name.lower()).strip("-")
        self.user = case.create(
            User,
            "user",
            "USER",
            email=f"b4-{slug}@example.invalid",
            # Pinned marker: `set_password` would salt with `get_random_string`,
            # so the dumped row would differ on every run.
            password="!b4-golden-unusable-password-marker",
            display_name="B4 黄金",
            is_active=True,
            is_staff=False,
            is_superuser=False,
        )
        self.project = case.create(ExamProject, "project", "PROJECT", owner=self.user, name=f"项目-{slug}")
        self.subject = case.create(
            Subject, "subject", "SUBJECT", project=self.project, name=f"科目-{slug}", code="MATH"
        )
        self.other_project = None
        self.other_subject = None
        if with_other_project:
            self.other_project = case.create(
                ExamProject, "project_other", "PROJECT_OTHER", owner=self.user, name=f"别的项目-{slug}"
            )
            self.other_subject = case.create(
                Subject,
                "subject_other",
                "SUBJECT_OTHER",
                project=self.other_project,
                name=f"别的科目-{slug}",
                code="CHN",
            )


# --------------------------------------------------------------------------
# row counts
# --------------------------------------------------------------------------
JOB_DOCUMENTS = ImportJob.documents.through
CANDIDATE_REGIONS = ImportCandidate.source_regions.through


def row_counts(project: ExamProject) -> dict:
    """Rows that belong to this project, for the tables the import can touch."""
    return {
        "ingestion_asset": Asset.objects.filter(project=project).count(),
        "ingestion_source_document": SourceDocument.objects.filter(project=project).count(),
        "ingestion_import_job": ImportJob.objects.filter(project=project).count(),
        "ingestion_import_job_documents": JOB_DOCUMENTS.objects.filter(importjob__project=project).count(),
        "ingestion_source_region": SourceRegion.objects.filter(document__project=project).count(),
        "ingestion_import_candidate": ImportCandidate.objects.filter(project=project).count(),
        "ingestion_import_candidate_source_regions": CANDIDATE_REGIONS.objects.filter(
            importcandidate__project=project
        ).count(),
        "ingestion_candidate_revision": CandidateRevision.objects.filter(candidate__project=project).count(),
        "exams_paper": Paper.objects.filter(subject__project=project).count(),
        "exams_paper_revision": PaperRevision.objects.filter(paper__subject__project=project).count(),
        "exams_paper_item": PaperItem.objects.filter(revision__paper__subject__project=project).count(),
        "audit_content_revision": ContentRevision.objects.filter(project_id=project.id).count(),
    }


def row_deltas(before: dict, after: dict) -> dict:
    return {table: after[table] - before[table] for table in before}


# --------------------------------------------------------------------------
# call helper: run the real service and adopt whatever it inserted
# --------------------------------------------------------------------------
def call_start_pdf_import(case: Case, **kwargs) -> tuple[ImportJob, list]:
    """One real `start_pdf_import` call; the inserted rows are named on success.

    On failure nothing survives the rollback, so the log is dropped instead of
    being turned into placeholders.
    """
    global _CREATION_LOG
    _CREATION_LOG = []
    try:
        job = import_services.start_pdf_import(**kwargs)
    except Exception:
        _CREATION_LOG = None
        raise
    entries = _CREATION_LOG
    _CREATION_LOG = None
    case.adopt_created(entries)
    return job, entries


# --------------------------------------------------------------------------
# projections (real values, with placeholders for generated identities)
# --------------------------------------------------------------------------
def project_job(case: Case, job: ImportJob) -> dict:
    return {
        "input_kind": job.input_kind,
        "extractor_version": job.extractor_version,
        "status": job.status,
        "progress_percent": job.progress_percent,
        "input_fingerprint": job.input_fingerprint,
        "duplicate_of": None if job.duplicate_of_id is None else case.render(job.duplicate_of_id),
        "problems": case.render(job.problems or []),
        "page_diagnostics": case.render(job.page_diagnostics or []),
    }


def project_document(case: Case, document: SourceDocument) -> dict:
    asset = document.asset
    data = stored_bytes(asset)
    if not OBJECT_KEY_PATTERN.search(asset.object_key):
        raise SystemExit(f"unexpected object key shape: {asset.object_key}")
    if asset.size_bytes != len(data):
        raise SystemExit("asset size does not match the stored bytes")
    if not document.page_texts:
        raise SystemExit("a PDF document always carries its per-page text")
    return {
        "document_type": document.document_type,
        "role": document.role,
        "sensitivity": document.sensitivity,
        "title": document.title,
        "page_count": document.page_count,
        "page_texts": list(document.page_texts),
        "raw_text": document.raw_text,
        "source_type": document.source_type,
        "source_note": document.source_note,
        "usage_scope": document.usage_scope,
        "checksum": f"<stored_sha256:{case.document_number(document.id)}>",
        "checksum_is_stored_bytes_sha256": document.checksum == sha256_hex(data),
        "asset": {
            "role": asset.role,
            "sensitivity": asset.sensitivity,
            "content_type": asset.content_type,
            "size_bytes": asset.size_bytes,
            "original_filename": asset.original_filename,
            "object_key_shape": OBJECT_KEY_SHAPE,
        },
    }


def project_region(case: Case, region: SourceRegion) -> dict:
    return {
        "document": case.render(region.document_id),
        "page_index": region.page_index,
        "x": region.x,
        "y": region.y,
        "width": region.width,
        "height": region.height,
        "role": region.role,
        "text_span": (region.text_span or "")[:2000],
        "char_start": region.char_start,
        "char_end": region.char_end,
    }


def project_candidate(case: Case, candidate: ImportCandidate) -> dict:
    payload = candidate.draft_payload or {}
    regions = sorted(
        candidate.source_regions.all(),
        key=lambda region: (
            case.document_number(region.document_id),
            region.page_index,
            region.y,
            region.x,
        ),
    )
    return {
        "source_position_key": candidate.source_position_key,
        "display_label": payload.get("display_label", ""),
        "status": candidate.status,
        "revision": candidate.revision,
        "extractor_version": candidate.extractor_version,
        "is_stub_output": candidate.is_stub_output,
        "paper_revision": None
        if candidate.paper_revision_id is None
        else case.render(candidate.paper_revision_id),
        "answer_match": case.render(candidate.answer_match or {}),
        "parent": None if candidate.parent_candidate_id is None else case.render(candidate.parent_candidate_id),
        "draft_payload": case.render(payload),
        "machine_payload_equals_draft": candidate.machine_payload == candidate.draft_payload,
        "review_issues": case.render(candidate.review_issues or []),
        "regions": [project_region(case, region) for region in regions],
    }


def project_paper(case: Case, paper: Paper) -> dict:
    return {
        "cycle_key": paper.cycle_key,
        "session_key": paper.session_key,
        "paper_code": paper.paper_code,
        "source_kind": paper.source_kind,
        "title": paper.title,
        "subject": case.render(paper.subject_id),
    }


def project_revision(case: Case, revision: PaperRevision) -> dict:
    paper = revision.paper
    return {
        "paper": case.render(revision.paper_id),
        "revision": revision.revision,
        "status": revision.status,
        "expected_session_count": revision.expected_session_count,
        "covered_session_count": revision.covered_session_count,
        "note": case.render(revision.note),
        "coverage_confirmed_at_is_null": revision.coverage_confirmed_at is None,
        "is_effective": str(paper.effective_revision_id) == str(revision.id),
        "effective_revision_is_null": paper.effective_revision_id is None,
    }


def project_audit(case: Case, row: ContentRevision) -> dict:
    """One audit row. ``ContentRevision`` has no ``summary`` column: its free text
    is ``reason`` and its structured summary is ``detail``; both are verbatim."""
    return {
        "entity_type": row.entity_type,
        "action": row.action,
        "entity_id": case.render(row.entity_id),
        "reason": row.reason,
        "detail": deep_json(row.detail),
    }


# --------------------------------------------------------------------------
# case runner
# --------------------------------------------------------------------------
def make_uploads(names: list[str], overrides: dict[str, dict]) -> list[PdfUpload]:
    uploads = []
    for name in names:
        meta = overrides.get(name, {})
        uploads.append(
            PdfUpload(
                filename=meta.get("filename", f"{name}.pdf"),
                content=FIXTURES[name],
                content_type=meta.get("content_type", "application/pdf"),
            )
        )
    return uploads


def import_kwargs(world: World, spec: dict, *, subject=None) -> dict:
    overrides = spec.get("file_overrides", {})
    return {
        "owner": world.user,
        "project": world.project,
        "paper_files": make_uploads(spec["paper_files"], overrides),
        "answer_files": make_uploads(spec.get("answer_files", []), overrides),
        "subject": world.subject if subject is None else subject,
        "title": spec.get("title", ""),
        "source_note": spec.get("source_note", ""),
        "usage_scope": spec.get("usage_scope", ""),
        "cycle_key": spec.get("cycle_key", ""),
        "session_key": spec.get("session_key", ""),
        "paper_code": spec.get("paper_code", ""),
        "source_kind": spec.get("source_kind", "practice_set"),
        "expected_session_count": spec.get("expected_session_count"),
        "paper_title": spec.get("paper_title", ""),
    }


def input_payload(spec: dict) -> dict:
    """The arguments a Node test has to replay, with fixture names instead of bytes."""
    return {
        "project": spec.get("project", "PROJECT"),
        "paper_files": list(spec["paper_files"]),
        "answer_files": list(spec.get("answer_files", [])),
        "subject": spec.get("subject_symbol", "SUBJECT"),
        "title": spec.get("title", ""),
        "source_note": spec.get("source_note", ""),
        "usage_scope": spec.get("usage_scope", ""),
        "cycle_key": spec.get("cycle_key", ""),
        "session_key": spec.get("session_key", ""),
        "paper_code": spec.get("paper_code", ""),
        "source_kind": spec.get("source_kind", "practice_set"),
        "expected_session_count": spec.get("expected_session_count"),
        "paper_title": spec.get("paper_title", ""),
        "file_overrides": spec.get("file_overrides", {}),
        "previous_imports": spec.get("previous_imports", 0),
    }


def success_case(name: str, *, spec: dict, prepare=None, geometry_comparable: bool = True) -> dict:
    """Seed a world, run the import once (after any documented pre-imports), project it."""
    case = Case(name)
    world = World(case, with_other_project=spec.get("with_other_project", False))
    if prepare is not None:
        prepare(case, world)
    for _ in range(spec.get("previous_imports", 0)):
        call_start_pdf_import(case, **import_kwargs(world, spec))
    before = row_counts(world.project)
    job, created = call_start_pdf_import(case, **import_kwargs(world, spec))
    after = row_counts(world.project)
    job.refresh_from_db()

    documents = sorted(job.documents.all(), key=lambda document: case.order_key(document.id))
    candidates = sorted(job.candidates.all(), key=lambda candidate: case.order_key(candidate.id))
    revisions = [row for model, pk in created if model is PaperRevision for row in [PaperRevision.objects.get(pk=pk)]]
    audits = [row for model, pk in created if model is ContentRevision for row in [ContentRevision.objects.get(pk=pk)]]
    papers: list[Paper] = []
    for revision in revisions:
        if all(paper.pk != revision.paper.pk for paper in papers):
            papers.append(revision.paper)

    expected = {
        "job": project_job(case, job),
        "documents": [project_document(case, document) for document in documents],
        "candidates": [project_candidate(case, candidate) for candidate in candidates],
        "papers": [project_paper(case, paper) for paper in papers],
        "revisions": [project_revision(case, revision) for revision in revisions],
        "content_revisions": [project_audit(case, row) for row in audits],
        "row_counts": row_deltas(before, after),
    }
    return {
        "name": name,
        "geometry_comparable": geometry_comparable,
        "seed": case.seed_payload(),
        "input": input_payload(spec),
        "expected": expected,
    }


def error_case(name: str, *, spec: dict, prepare=None, geometry_comparable: bool = True) -> dict:
    """Seed a world, call the import, record the refusal and the untouched row counts."""
    case = Case(name)
    world = World(case, with_other_project=spec.get("with_other_project", False))
    if prepare is not None:
        prepare(case, world)
    subject = world.other_subject if spec.get("subject_symbol") == "SUBJECT_OTHER" else world.subject
    before = row_counts(world.project)
    try:
        call_start_pdf_import(case, **import_kwargs(world, spec, subject=subject))
    except AcePassError as exc:
        error = {
            "kind": "acepass",
            "class": type(exc).__name__,
            "status": exc.status_code,
            "code": exc.code,
            "message": exc.message,
            "details": deep_json(exc.details),
        }
    else:  # pragma: no cover - every error case must be refused
        raise SystemExit(f"{name}: the import did not fail")
    after = row_counts(world.project)
    if before != after:
        raise SystemExit(f"{name}: the failed import wrote rows: {row_deltas(before, after)}")
    return {
        "name": name,
        "geometry_comparable": geometry_comparable,
        "seed": case.seed_payload(),
        "input": input_payload(spec),
        "error": error,
        "row_counts_before": before,
        "row_counts_after": after,
    }


# --------------------------------------------------------------------------
# seeds used by one case each
# --------------------------------------------------------------------------
def seed_published_position(case: Case, world: World) -> None:
    """A paper occurrence whose position ``1`` was published by an earlier revision.

    Seeded (not published through the service) so the ids are fixed: the point of
    the case is the *import's* reaction to an already published paper position,
    not the publication flow, which the B2 fixture already pins.
    """
    paper = case.create(
        Paper,
        "paper",
        "PAPER",
        subject=world.subject,
        cycle_key="2024",
        session_key="",
        paper_code="卷一",
        title="2024 年 卷一",
        source_kind="official_past",
        is_demo=False,
    )
    revision = case.create(
        PaperRevision,
        "paper_revision",
        "PAPER_REVISION",
        paper=paper,
        revision=1,
        status="published",
        expected_session_count=2,
        covered_session_count=2,
        note="历史已发布版本",
    )
    question = case.create(
        Question,
        "question",
        "QUESTION",
        subject=world.subject,
        origin_type="user_authored",
        # Empty on purpose: the warning this case is about is the *paper position*
        # duplicate, not ``duplicate_label``.
        display_label="",
        is_demo=False,
        created_by=world.user,
    )
    version = case.create(
        QuestionVersion,
        "question_version",
        "QUESTION_VERSION",
        question=question,
        version=1,
        question_type="single_choice",
        content={
            "blocks": [{"kind": "text", "text": "历史版本题干"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        },
        practice_max_score=Decimal("2.00"),
        status="published",
        created_by=world.user,
        published_at=case.now(),
    )
    case.create(
        PaperItem,
        "paper_item",
        "PAPER_ITEM",
        revision=revision,
        position_key="1",
        question_version=version,
        max_score=Decimal("2.00"),
        is_scored=True,
        is_demo=False,
    )


def seed_previous_job(case: Case, world: World) -> None:
    """A job whose input fingerprint equals the one this import will compute.

    ``create_import_job`` fingerprints the *document checksums*, so the value is
    derivable before the document exists and the duplicate can be a seeded row
    with a stable id instead of the previous call's random one.
    """
    fingerprint = sha256_hex(sha256_hex(FIXTURES["paper_two_pages"]).encode("utf-8"))
    case.create(
        ImportJob,
        "job_previous",
        "JOB_PREVIOUS",
        project=world.project,
        subject=world.subject,
        created_by=world.user,
        status="awaiting_review",
        input_kind="pdf_text",
        extractor_version=PDF_EXTRACTOR_VERSION,
        input_fingerprint=fingerprint,
    )


# --------------------------------------------------------------------------
# success cases
# --------------------------------------------------------------------------
def single_paper_spec() -> dict:
    return {
        "paper_files": ["paper_two_pages"],
        "subject_symbol": "SUBJECT",
        "title": "2026 春季模拟卷一",
        "source_note": "教研组内部使用",
        "usage_scope": "仅限本项目",
        "source_kind": "practice_set",
    }


def official_paper_spec() -> dict:
    return {
        "paper_files": ["paper_two_pages", "paper_second"],
        "subject_symbol": "SUBJECT",
        "title": "2024 上半年 卷一",
        "source_note": "公开真题，仅内部教研",
        "usage_scope": "本项目",
        "cycle_key": "2024",
        "session_key": "上半年",
        "paper_code": "卷一",
        "source_kind": "official_past",
        "expected_session_count": 2,
        "paper_title": "2024 年上半年 卷一",
    }


def success_cases() -> list[dict]:
    return [
        # 1. the base write set: 2 pages, 4 questions, no paper record
        success_case("single_paper", spec=single_paper_spec()),
        # 2. two files, two documents: order, continuous position keys, two M2M links
        success_case(
            "two_papers",
            spec={**single_paper_spec(), "paper_files": ["paper_two_pages", "paper_second"]},
        ),
        # 3. an answer PDF: the match is a proposal, never a published answer key
        success_case(
            "paper_and_answers",
            spec={
                **single_paper_spec(),
                "paper_files": ["paper_two_pages"],
                "answer_files": ["paper_answers"],
            },
        ),
        # 4. the same bytes twice: the source document is reused, not copied
        success_case(
            "duplicate_bytes",
            spec={**single_paper_spec(), "previous_imports": 1},
            prepare=seed_previous_job,
        ),
        # 5. official past paper: Paper + PaperRevision, coverage unconfirmed
        success_case("official_past_with_paper", spec=official_paper_spec()),
        # 6. no paper_code: no Paper, no revision, candidates stay paper-less
        success_case(
            "practice_set_no_paper",
            spec={
                **single_paper_spec(),
                "cycle_key": "2024",
                "paper_code": "",
                "expected_session_count": 2,
            },
        ),
        # 7. a scanned page inside a successful import
        success_case(
            "scanned_mixed",
            spec={
                **single_paper_spec(),
                "paper_files": ["paper_scanned_mixed"],
                "title": "扫描件混排材料",
            },
            geometry_comparable=False,
        ),
        # 8. two columns: column-major reading order, every candidate blocked
        success_case(
            "two_columns",
            spec={
                **single_paper_spec(),
                "paper_files": ["paper_two_columns"],
                "title": "双栏排版材料",
            },
        ),
        # 9. one question over a page break: two regions, one candidate
        success_case(
            "cross_page",
            spec={
                **single_paper_spec(),
                "paper_files": ["paper_cross_page"],
                "title": "跨页题目材料",
            },
        ),
        # 10. re-importing a paper position that was already published
        success_case(
            "duplicate_paper_position",
            spec={
                "paper_files": ["paper_two_pages"],
                "subject_symbol": "SUBJECT",
                "title": "2024 年 卷一",
                "source_kind": "official_past",
                "cycle_key": "2024",
                "paper_code": "卷一",
                "expected_session_count": 2,
            },
            prepare=seed_published_position,
        ),
        # 11. a text layer without any question structure
        success_case(
            "no_segments",
            spec={
                **single_paper_spec(),
                "paper_files": ["paper_no_segments"],
                "title": "无题目说明页",
            },
        ),
        # 12. three MAX_PDF_PAGES files: the job keeps exactly MAX_JOB_PAGE_DIAGNOSTICS rows
        success_case(
            "diagnostics_truncation",
            spec={
                **single_paper_spec(),
                "paper_files": ["paper_trunc_a", "paper_trunc_b", "paper_trunc_c"],
                "title": "诊断分册",
            },
        ),
    ]


# --------------------------------------------------------------------------
# error cases
# --------------------------------------------------------------------------
def error_cases() -> list[dict]:
    base = single_paper_spec()
    return [
        # 1. no file at all
        error_case("error_empty_files", spec={**base, "paper_files": []}),
        # 2. a subject that belongs to another project
        error_case(
            "error_subject_other_project",
            spec={**base, "subject_symbol": "SUBJECT_OTHER", "with_other_project": True},
        ),
        # 3. a non-PDF upload *after* a valid one: the stored document must roll back
        error_case(
            "error_mime_not_pdf",
            spec={
                **base,
                "paper_files": ["paper_two_pages", "notes_txt"],
                "file_overrides": {"notes_txt": {"filename": "notes.txt", "content_type": "text/plain"}},
            },
        ),
        # 4. the second file is broken: the whole import rolls back
        error_case(
            "error_second_file_corrupt",
            spec={**base, "paper_files": ["paper_two_pages", "paper_corrupt"]},
        ),
        # 5. every page is a scan: no text layer, no import
        error_case("error_scanned_only", spec={**base, "paper_files": ["paper_scanned_only"]}),
        # 6. an encrypted PDF
        error_case("error_encrypted", spec={**base, "paper_files": ["paper_encrypted"]}),
    ]


# --------------------------------------------------------------------------
# notes: what the fixture does not assert, and why
# --------------------------------------------------------------------------
NOTES = [
    "`now` is the instant the Node side must pass as its clock (2026-04-01T00:05:00+00:00). Seeded rows are pinned to BASE+n minutes starting at 2026-04-01T00:00:00+00:00, so a lookup ordered by created_at sees fixture rows before rows the import writes.",
    "Placeholders are allocated in insertion order, recorded by a post_save receiver: `<document:n>`, `<candidate:n>`, `<region:n>` and `<asset:n>` number the rows the import created (across pre-imports too, so `duplicate_bytes` starts at `<candidate:5>`). `<job>` is the reported job; `<paper:n>`/`<revision>` are service-created paper rows. Seeded ids keep their `symbols` name.",
    "`ContentRevision` has no `summary` column. The audit projection therefore carries `reason` (free text, empty here) and `detail` (the structured summary) verbatim, plus the `entity_type`, `action` and `entity_id` the brief asked for.",
    "`regions[].y`/`height` (and `draft_payload.source_spans[].bbox`) come from fragment geometry. Every paper/answer fixture is built with `build_layout_pdf` (explicit `Tm`), because pypdf 5.1.0 computes `TL = operand * font_size` and inflates the baseline of every `T*`-advanced line by the font size; only `build_scanned_pdf` still writes `T*`-based text pages.",
    "`scanned_mixed` is the one case marked `geometry_comparable: false`: a scanned page can only occur in a *successful* import inside a file that also carries native pages, and `build_scanned_pdf` lays those out with `T*`. Both candidates' regions come from the first line of their page (the baseline the bug does not touch), so the recorded values are exact, but the case must not be used as a geometry vector: compare page_index, text_span, char_start, char_end, x and width there, not y/height.",
    "No candidate ever originates on a page without a text layer: a candidate exists only where the extractor produced characters, so the scanned page in `scanned_mixed` cannot carry a `page_without_text_layer_needs_manual_entry` *candidate* issue. Django reports that code as a job-level problem over the scanned page (in `job.problems`), and the case records it there. The candidate-level blocking code is exercised by `two_columns` (`multi_column_needs_review`).",
    "`answer_match` keeps three fields that Django leaves null even on a hit: `document_id`, `document_title` and `source_page_index`. `text_parser.apply_answer_matches` builds its results from the answer entry alone and `_create_candidates` copies those keys from the match, so all three are null. The fixture records the real nulls instead of inventing the ids.",
    "`duplicate_bytes` seeds `JOB_PREVIOUS` with the input fingerprint the import will compute (sha256 of the document checksum) so `duplicate_of` resolves to a symbol rather than to the previous call's random job id. Its `row_counts` are the *second* call's delta (document and asset stay at 0); `previous_imports: 1` names the silent first call.",
    "`duplicate_paper_position` seeds the published paper/revision/question/version/paper-item rows directly (fixed uuid5 ids) instead of driving `publish_candidate`: the case is about the *import* reacting to an existing published position, and the publication flow itself is pinned by the B2 fixture. The seeded question deliberately has an empty `display_label` so the case does not also raise `duplicate_label`.",
    "`diagnostics_truncation` imports three files of MAX_PDF_PAGES (200) pages each. The job keeps exactly MAX_JOB_PAGE_DIAGNOSTICS (500) rows: 200 from the first file, 200 from the second and 100 from the third, in upload order.",
    "`row_counts` are deltas measured around the reported call, restricted to the case's own project. `ingestion_import_job_documents` and `ingestion_import_candidate_source_regions` are the M2M through tables.",
    "`fixtures[name].builder` says how the bytes were made. Every paper/answer fixture comes from `backend/tests/support/pdf_builder.py`; only `paper_encrypted` and `paper_corrupt` post-process that output (pypdf encryption, truncation), and no fixture contains a hand-written content stream.",
    "One candidate per page boundary quirk: `attach_cross_page_continua` ends a segment's char range at the *next* segment's `source_excerpt` start, so the next question's printed label prefix belongs to the previous segment. When that prefix sits on the following page, the previous candidate gets a second region there: `single_paper` has 4 candidates and 5 regions, and Q2's second region is the `3．【题型】单选题\n【题干】` prefix on page 2. This is Django's real output and must be reproduced as-is.",
    "`error_subject_other_project` raises `InvalidInput` (code `invalid_input`, status 400), not `ScopeViolation`: `start_pdf_import` checks the subject's project itself. The fixture records the exception that was actually raised.",
    "`paper_and_answers`: a matched answer overwrites the answer printed on the paper and sets `answer_status_known` to false, so the match has to be confirmed. Question 4 has no entry on the answer page, keeps its printed option D and is therefore the only `ready` candidate.",
    "`reused` is not a stored column: a reused upload is observable only through the `duplicate_source_file` problem and through the zero `ingestion_source_document`/`ingestion_asset` delta in `row_counts`.",
    "`two_papers` gives both documents the same title because `title` is a job-level field applied to every paper upload; `asset.original_filename` is what distinguishes them.",
    "`geometry_comparable` is true for every case except `scanned_mixed`; it tells the Node test whether region `y`/`height` (and `source_spans[].bbox`) may be compared at all.",
]


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
FIXTURES: dict[str, bytes] = {}


def main() -> int:
    global FIXTURES

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

        FIXTURES = build_fixtures()
        fixtures = describe_fixtures(FIXTURES)
        cases = success_cases()
        errors = error_cases()
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)

    payload = {
        "now": NOW,
        "fixtures": fixtures,
        "cases": [deep_json(case) for case in cases],
        "errors": [deep_json(case) for case in errors],
        "notes": NOTES,
    }

    truncation = next(case for case in payload["cases"] if case["name"] == "diagnostics_truncation")
    kept = len(truncation["expected"]["job"]["page_diagnostics"])
    if kept != MAX_JOB_PAGE_DIAGNOSTICS:
        raise SystemExit(f"page_diagnostics kept {kept} rows, expected {MAX_JOB_PAGE_DIAGNOSTICS}")
    if len(fixtures["paper_trunc_a"]["extraction_pages"]) != MAX_PDF_PAGES:
        raise SystemExit("the truncation fixture lost pages")

    leaks: list[str] = []
    for case in payload["cases"]:
        leaks.extend(case_leaks(case))
    for case in payload["errors"]:
        leaks.extend(case_leaks(case))
    if leaks:
        raise SystemExit("non-deterministic identities leaked into the fixture:\n  " + "\n  ".join(leaks))

    text = json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")

    digest = sha256_hex(text.encode("utf-8"))
    print(f"wrote {OUT}")
    print(f"fixtures: {len(fixtures)}")
    print(f"cases: {len(payload['cases'])}  errors: {len(payload['errors'])}")
    for case in payload["cases"]:
        expected = case["expected"]
        print(
            f"  case  {case['name']:<28} docs={len(expected['documents'])} "
            f"cands={len(expected['candidates'])} job={expected['job']['status']} "
            f"problems={[row['code'] for row in expected['job']['problems']]}"
        )
    for case in payload["errors"]:
        print(f"  error {case['name']:<28} {case['error']['class']} {case['error']['message'][:40]}")
    print(f"page diagnostics kept: {kept}")
    print(f"sha256: {digest}")
    return 0


def case_leaks(case: dict) -> list[str]:
    """A uuid that is neither a seeded id nor a placeholder would be random."""
    known = set(case["seed"]["symbols"])
    found: list[str] = []

    def walk(value, path: str) -> None:
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

    for key in ("expected", "error"):
        if key in case:
            walk(case[key], key)
    return found


if __name__ == "__main__":
    raise SystemExit(main())
