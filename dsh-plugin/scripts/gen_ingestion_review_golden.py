#!/usr/bin/env python
"""Golden vectors for the B1 ingestion proofreading gate.

Oracle: the *real* `apps.ingestion.services.core.refresh_candidate_issues` and
`apps.ingestion.services.imports.job_summary` / `candidate_summary`, executed against real
PostgreSQL rows in a throw-away test database. Nothing here re-implements the rules — every
`expected` block is whatever Django returned — so a disagreement with the TypeScript port is a
port defect, not a stale expectation.

Each case is a complete, self-contained world (own user / project / subject / job), dumped as
plain rows so the Node test can replay the same state in SQLite:

    {"cases": [{"name", "refresh", "rows": {table: [row, ...]}, "target_candidate_id",
               "expected": {"issues", "status", "job_summary", "candidate_summary"}}]}

Rows are dumped through `model._meta.concrete_fields` with `field.attname` as the column name, so
foreign keys arrive as their raw `<name>_id` value. Identities are `uuid5` of the case name (never
`uuid4`), and every `created_at` / `updated_at` is a fixed instant `BASE + n minutes`, so a rerun
is byte-identical. `json.dumps(..., sort_keys=True)` additionally normalises the one dict whose key
order is genuinely hash-randomised in Python (`job_summary` builds `candidate_status_counts` by
iterating a `set` of statuses).

`refresh=True` cases capture the rows *before* `refresh_candidate_issues()` runs (the refresh writes
`timezone.now()` into `updated_at`, which must not leak into the fixture) and record the returned
issues plus the candidate status afterwards. `refresh=False` cases never refresh: they record
`job_summary` / `candidate_summary` over the fixed rows.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_ingestion_review_golden.py
"""

from __future__ import annotations

import copy
import json
import os
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from apps.exams.models import ExamProject, Paper, PaperItem, PaperRevision, Subject  # noqa: E402
from apps.ingestion.models import ImportCandidate, ImportJob, SourceDocument, SourceRegion  # noqa: E402
from apps.ingestion.services.core import refresh_candidate_issues  # noqa: E402
from apps.ingestion.services.imports import candidate_summary, job_summary  # noqa: E402
from apps.question_bank.models import Question, QuestionVersion  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "ingestion_review.json"

#: Every timestamp in the fixture is derived from this instant, never from `timezone.now()`.
BASE = datetime(2026, 2, 1, 0, 0, tzinfo=timezone.utc)

_UNSET = object()


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
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def dump_row(obj) -> dict:
    """Every concrete column of one row, keyed by `field.attname` (so FKs are `<name>_id`)."""
    return {field.attname: jsonable(getattr(obj, field.attname)) for field in obj._meta.concrete_fields}


# --------------------------------------------------------------------------
# one isolated case world
# --------------------------------------------------------------------------
class Case:
    """A single golden case: deterministic identities, fixed timestamps, dumped rows."""

    def __init__(self, name: str, *, refresh: bool) -> None:
        self.name = name
        self.refresh = refresh
        self.objects: list = []
        self.target: ImportCandidate | None = None
        self.expected: dict = {}
        self._counters: dict[str, int] = {}

    def uid(self, entity: str) -> uuid.UUID:
        n = self._counters.get(entity, 0) + 1
        self._counters[entity] = n
        return uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b1:{self.name}:{entity}:{n}")

    def create(self, model, entity: str, **kwargs):
        obj = model(id=self.uid(entity), **kwargs)
        obj.save(force_insert=True)
        self.objects.append(obj)
        return obj

    def fix_timestamps(self) -> None:
        """Pin `created_at` / `updated_at`; `auto_now_add` would otherwise win."""
        for index, obj in enumerate(self.objects):
            value = BASE + timedelta(minutes=index)
            attnames = {field.attname for field in obj._meta.concrete_fields}
            if "created_at" in attnames:
                type(obj)._base_manager.filter(pk=obj.pk).update(created_at=value, updated_at=value)

    def collect_through_rows(self) -> None:
        """The M2M through rows created by `.add()` are part of the fixture too."""
        job_ids = [obj.pk for obj in self.objects if isinstance(obj, ImportJob)]
        candidate_ids = [obj.pk for obj in self.objects if isinstance(obj, ImportCandidate)]
        for row in ImportJob.documents.through.objects.filter(importjob_id__in=job_ids).order_by("id"):
            self.objects.append(row)
        for row in ImportCandidate.source_regions.through.objects.filter(
            importcandidate_id__in=candidate_ids
        ).order_by("id"):
            self.objects.append(row)

    def reload(self) -> None:
        for obj in self.objects:
            obj.refresh_from_db()

    def rows(self) -> dict[str, list[dict]]:
        tables: dict[str, list[dict]] = {}
        for obj in self.objects:
            tables.setdefault(obj._meta.db_table, []).append(dump_row(obj))
        return tables


class World:
    """The scaffolding every case starts from: one user, project, subject and import job."""

    def __init__(
        self, case: Case, *, subject: bool = True, input_kind: str = "text", job_extra: dict | None = None
    ) -> None:
        self.case = case
        User = get_user_model()
        self.user = User(
            id=case.uid("user"),
            email=f"b1-{case.name}@example.invalid",
            display_name="校对员",
            date_joined=BASE,
            # `set_unusable_password()` salts with `get_random_string`, which would make the dump
            # differ on every run; the fixture never authenticates, so pin the unusable marker.
            password="!b1-golden-unusable-password-marker",
        )
        self.user.save(force_insert=True)
        case.objects.append(self.user)
        self.project = case.create(ExamProject, "project", owner=self.user, name=f"项目-{case.name}")
        self.subject = None
        if subject:
            self.subject = case.create(Subject, "subject", project=self.project, name=f"科目-{case.name}", code="MATH")
        fields = {
            "status": "awaiting_review",
            "input_kind": input_kind,
            "input_text": "【题干】下列哪一项是质数？\n【选项】A. 4\nB. 7\nC. 9\n【答案】B",
            "extractor_version": "pdf-text-v2",
            "progress_percent": 100,
            "problems": [],
            "page_diagnostics": [],
            "attempts": 1,
            "max_attempts": 3,
            "last_error": "",
            "input_fingerprint": f"fingerprint-{case.name}",
        }
        fields.update(job_extra or {})
        self.job = case.create(
            ImportJob, "job", project=self.project, subject=self.subject, created_by=self.user, **fields
        )

    # -- entities ---------------------------------------------------------
    def document(self, *, title: str | None = None, document_type: str = "pdf", page_count: int = 4) -> SourceDocument:
        return self.case.create(
            SourceDocument,
            "document",
            owner=self.user,
            project=self.project,
            subject=self.subject,
            title=title if title is not None else f"2024 真题-{self.case.name}",
            document_type=document_type,
            role="past_paper_page",
            sensitivity="public_to_owner",
            raw_text="",
            page_texts=["第一页文本", "第二页文本"],
            checksum="c" * 64,
            source_type="user_upload",
            source_note="2024 年真题扫描件",
            usage_scope="私有学习使用",
            page_count=page_count,
        )

    def region(
        self,
        document: SourceDocument,
        *,
        page_index: int = 1,
        x: float = 0.1,
        y: float = 0.1,
        width: float = 0.5,
        height: float = 0.2,
        text_span: str = "题干区域",
    ) -> SourceRegion:
        return self.case.create(
            SourceRegion,
            "region",
            document=document,
            page_index=page_index,
            x=x,
            y=y,
            width=width,
            height=height,
            role="stem_crop",
            text_span=text_span,
        )

    def candidate(
        self,
        payload: dict,
        *,
        status: str = "draft",
        regions: tuple = (),
        subject=_UNSET,
        job: ImportJob | None = None,
        **kwargs,
    ) -> ImportCandidate:
        data = {
            "job": job if job is not None else self.job,
            "project": self.project,
            "subject": self.subject if subject is _UNSET else subject,
            "parent_candidate": None,
            "status": status,
            "revision": 1,
            "draft_payload": payload,
            "machine_payload": copy.deepcopy(payload),
            "review_issues": [],
            "extractor_version": "pdf-text-v2",
            "is_stub_output": False,
            "source_position_key": "",
            "answer_match": {},
            "layout_review_note": "",
        }
        data.update(kwargs)
        candidate = self.case.create(ImportCandidate, "candidate", **data)
        if regions:
            candidate.source_regions.add(*regions)
        return candidate

    def child(self, parent: ImportCandidate, label: str, stem: str, *, status: str = "draft", regions: tuple = ()):
        """A sub-question of a material candidate."""
        return self.candidate(
            single_choice_payload(stem, label=label), status=status, regions=regions, parent_candidate=parent
        )

    def paper(self) -> tuple[Paper, PaperRevision]:
        paper = self.case.create(
            Paper,
            "paper",
            subject=self.subject,
            cycle_key="2024",
            session_key="上半年",
            paper_code="卷一",
            title=f"2024 年上半年 卷一-{self.case.name}",
            source_kind="official_past",
            is_demo=False,
        )
        revision = self.case.create(PaperRevision, "paper_revision", paper=paper, revision=1, status="draft")
        return paper, revision

    def extra_job(self, entity: str = "second_job", **overrides) -> ImportJob:
        fields = {
            "status": "queued",
            "input_kind": "text",
            "input_text": "另一个导入任务",
            "extractor_version": "manual-v1",
            "progress_percent": 0,
            "problems": [],
            "page_diagnostics": [],
            "attempts": 0,
            "max_attempts": 3,
            "last_error": "",
            "input_fingerprint": f"fingerprint-{self.case.name}-{entity}",
        }
        fields.update(overrides)
        return self.case.create(
            ImportJob, entity, project=self.project, subject=self.subject, created_by=self.user, **fields
        )


# --------------------------------------------------------------------------
# payload builders (the shapes the text parser really produces)
# --------------------------------------------------------------------------
STEM = "下列哪一项是质数？"


def block(text: str) -> dict:
    return {"kind": "text", "text": text}


def option(option_id: str, label: str, text: str) -> dict:
    return {"id": option_id, "label": label, "blocks": [block(text)]}


OPTIONS = [option("opt_a", "A", "4"), option("opt_b", "B", "7"), option("opt_c", "C", "9")]


def single_choice_payload(
    stem: str = STEM,
    options: list[dict] | None = None,
    *,
    correct: str = "opt_b",
    label: str = "1",
    known: bool = True,
    max_score: str | None = None,
    extra: dict | None = None,
) -> dict:
    data = {
        "question_type": "single_choice",
        "display_label": label,
        "structure_signals": ["题干", "选项", "答案"],
        "content": {
            "blocks": [block(stem)],
            "options": copy.deepcopy(OPTIONS) if options is None else copy.deepcopy(options),
        },
        "answer_payload": {"kind": "single_choice", "correct_option_id": correct},
        "answer_status_known": known,
        "explanation_blocks": [block("7 只有 1 和 7 两个正因数。")],
        "source_excerpt": stem,
        "parse_issues": [],
        "practice_max_score": max_score,
    }
    if extra:
        data.update(extra)
    return data


def material_payload(stem: str = "阅读下面的材料，回答问题。", *, label: str = "10") -> dict:
    return {
        "question_type": "material",
        "display_label": label,
        "structure_signals": ["材料"],
        "content": {"blocks": [block(stem)]},
        "answer_payload": {},
        "answer_status_known": True,
        "explanation_blocks": [],
        "source_excerpt": stem,
        "parse_issues": [],
        "practice_max_score": None,
    }


def published_question(case: Case, subject: Subject, *, content: dict) -> tuple[Question, QuestionVersion]:
    """A published `Question` + v1 `QuestionVersion` already sitting in the subject."""
    question = case.create(
        Question, "published_question", subject=subject, origin_type="official_past", display_label="", is_demo=False
    )
    version = case.create(
        QuestionVersion,
        "published_version",
        question=question,
        version=1,
        question_type="single_choice",
        content=content,
        status="published",
        published_at=BASE + timedelta(days=1),
        practice_max_score=Decimal("5.00"),
    )
    return question, version


def label_question(case: Case, subject: Subject, display_label: str) -> Question:
    """A `Question` that already owns that display label (the duplicate-label source)."""
    return case.create(
        Question,
        "label_question",
        subject=subject,
        origin_type="user_authored",
        display_label=display_label,
        is_demo=False,
    )


def leaf_world(
    name: str, *, payload: dict | None = None, refresh: bool = True, **candidate_kwargs
) -> tuple[Case, World, ImportCandidate]:
    """The default world: valid payload, one document, one region, one target candidate."""
    case = Case(name, refresh=refresh)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    payload = payload if payload is not None else single_choice_payload()
    case.target = world.candidate(payload, regions=[region], **candidate_kwargs)
    return case, world, region


# --------------------------------------------------------------------------
# required issue cases (1-23)
# --------------------------------------------------------------------------
def case_01_missing_question_type() -> Case:
    """(1) No `question_type`: the missing-type issue is emitted before subject/region checks."""
    case = Case("missing_question_type", refresh=True)
    world = World(case)
    world.job.documents.add(world.document())
    payload = single_choice_payload()
    del payload["question_type"]
    case.target = world.candidate(payload, subject=None)
    return case


def case_02_single_choice_empty_options() -> Case:
    """(2) `options: []` → content `options_empty`, then the `too_few_options` gate."""
    case, _world, _region = leaf_world("single_choice_empty_options", payload=single_choice_payload(options=[]))
    return case


def case_03_single_choice_one_option() -> Case:
    """(3) One option → `too_few_options` only; the answer itself is valid."""
    payload = single_choice_payload(options=[OPTIONS[1]], correct="opt_b")
    case, _world, _region = leaf_world("single_choice_one_option", payload=payload)
    return case


def case_04_material_without_children() -> Case:
    """(4) Material with no sub-questions."""
    case, _world, _region = leaf_world("material_without_children", payload=material_payload(label="4"))
    return case


def case_05_material_child_unpublished() -> Case:
    """(5) One published + one draft child → `material_children_unpublished` lists the draft."""
    case = Case("material_child_unpublished", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    material = world.candidate(material_payload(label="5"), regions=[region])
    world.child(material, "5(1)", "第(1)小问：求 n 的值。", status="published", regions=[region])
    world.child(material, "5(2)", "第(2)小问：说明理由。", regions=[region])
    case.target = material
    return case


def case_06_material_all_children_published() -> Case:
    """(6) Every child published → no material issue at all."""
    case = Case("material_all_children_published", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    material = world.candidate(material_payload(label="6"), regions=[region])
    world.child(material, "6(1)", "第(1)小问：求 n 的值。", status="published", regions=[region])
    world.child(material, "6(2)", "第(2)小问：说明理由。", status="published", regions=[region])
    case.target = material
    return case


def case_07_answer_status_unknown() -> Case:
    """(7) `answer_status_known=False` → `answer_unknown`, never `answer_missing`."""
    payload = single_choice_payload(known=False)
    case, _world, _region = leaf_world("answer_status_unknown_leaf", payload=payload)
    return case


def case_08_answer_payload_empty() -> Case:
    """(8) Known answer status but an empty `answer_payload` → `answer_missing`."""
    payload = single_choice_payload()
    payload["answer_payload"] = {}
    case, _world, _region = leaf_world("answer_payload_missing_leaf", payload=payload)
    return case


ANSWER_PAGE_RAW = "12．B。由题意可知，n=7 时原式成立，故选择 B。本题考点为质数的判定，解析见教师用书第 18 页。"


def case_09_answer_match_pending() -> Case:
    """(9) A mechanical `label` match that no human confirmed yet blocks publication."""
    case = Case("answer_match_pending_label", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    payload = single_choice_payload(extra={"answer_confirmed_by_match_review": False})
    case.target = world.candidate(
        payload,
        regions=[region],
        answer_match={"matched": True, "method": "label", "raw": ANSWER_PAGE_RAW, "source_page_index": 3},
    )
    return case


def case_10_answer_match_confirmed() -> Case:
    """(10) Same match, but confirmed by the proofreader → no `answer_match` issue."""
    case = Case("answer_match_confirmed_by_review", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    payload = single_choice_payload(extra={"answer_confirmed_by_match_review": True})
    case.target = world.candidate(
        payload,
        regions=[region],
        answer_match={"matched": True, "method": "label", "raw": ANSWER_PAGE_RAW, "source_page_index": 3},
    )
    return case


def case_11_paper_item_score_missing() -> Case:
    """(11) A paper candidate with no score → `paper_item_score_missing`."""
    case = Case("paper_item_score_missing", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    _paper, revision = world.paper()
    case.target = world.candidate(single_choice_payload(max_score=None), regions=[region], paper_revision=revision)
    return case


def case_12_duplicate_paper_position() -> Case:
    """(12) The paper position already holds a published version → `duplicate_paper_position`."""
    case = Case("duplicate_paper_position", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    _paper, revision = world.paper()
    # deliberately different wording: this case pins the paper position, not the content duplicate
    other_content = single_choice_payload("已经在题库中的第 12 题", label="")["content"]
    _question, version = published_question(case, world.subject, content=other_content)
    case.create(
        PaperItem,
        "paper_item",
        revision=revision,
        position_key="12",
        question_version=version,
        max_score=Decimal("5.00"),
        is_scored=True,
    )
    case.target = world.candidate(
        single_choice_payload(max_score="5"),
        regions=[region],
        paper_revision=revision,
        source_position_key="12",
    )
    return case


def case_13_no_source_region() -> Case:
    """(13) No source regions → a `no_source_region` warning (warning-only ⇒ ready)."""
    case = Case("candidate_without_source_region", refresh=True)
    world = World(case)
    world.job.documents.add(world.document())
    case.target = world.candidate(single_choice_payload())
    return case


def case_14_multi_column_needs_review() -> Case:
    """(14) A diagnosed multi-column page the candidate sits on blocks until confirmed."""
    case = Case("multi_column_page_needs_review", refresh=True)
    world = World(case)
    document = world.document(title="2024 真题 正文（多栏）")
    other_document = world.document(title="另一份文档")
    world.job.documents.add(document, other_document)
    region = world.region(document, page_index=2, x=0.2, y=0.7, text_span="第二页题干")
    diagnostics = [
        {
            "document_id": str(document.id),
            "page_index": 2,
            "reasons": ["multi_column_layout", "column_reading_order_ambiguous"],
        },
        # decoys: same document, another page; and another document, same page number
        {"document_id": str(document.id), "page_index": 5, "reasons": ["table_grid_detected"]},
        {"document_id": str(other_document.id), "page_index": 2, "reasons": ["formula_tokens_detected"]},
    ]
    ImportJob.objects.filter(pk=world.job.pk).update(page_diagnostics=diagnostics)
    world.job.page_diagnostics = diagnostics
    case.target = world.candidate(single_choice_payload(), regions=[region])
    return case


def case_15_multi_column_confirmed() -> Case:
    """(15) Same diagnosis, layout confirmed by a human → no layout issue."""
    case = Case("multi_column_page_confirmed", refresh=True)
    world = World(case)
    document = world.document(title="2024 真题 正文（多栏）")
    world.job.documents.add(document)
    region = world.region(document, page_index=2, x=0.2, y=0.7, text_span="第二页题干")
    diagnostics = [
        {
            "document_id": str(document.id),
            "page_index": 2,
            "reasons": ["multi_column_layout", "column_reading_order_ambiguous"],
        },
    ]
    ImportJob.objects.filter(pk=world.job.pk).update(page_diagnostics=diagnostics)
    world.job.page_diagnostics = diagnostics
    case.target = world.candidate(
        single_choice_payload(),
        regions=[region],
        layout_review_confirmed_at=BASE + timedelta(days=1, hours=3),
        layout_review_note="已对照原页确认版式",
    )
    return case


def case_16_cross_page() -> Case:
    """(16) `continues_on_pages=[2, 3]` → a non-blocking `cross_page_question`."""
    payload = single_choice_payload(extra={"continues_on_pages": [2, 3]})
    case, _world, _region = leaf_world("cross_page_continues_on_pages", payload=payload)
    return case


def case_17_duplicate_candidate() -> Case:
    """(17) Identical content elsewhere in the project → `duplicate_candidate` (ignored rows skipped)."""
    case = Case("duplicate_candidate_in_project", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    payload = single_choice_payload()
    case.target = world.candidate(payload, regions=[region])
    ignored_job = world.extra_job("ignored_job")
    world.candidate(copy.deepcopy(payload), status="ignored", job=ignored_job, subject=world.subject)
    live_job = world.extra_job("other_job")
    world.candidate(copy.deepcopy(payload), status="draft", job=live_job, subject=world.subject)
    return case


def case_18_duplicate_published_and_label() -> Case:
    """(18) Same content already published + same display label → two warnings."""
    case = Case("duplicate_published_and_label", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    payload = single_choice_payload(label="7")
    published_question(case, world.subject, content=copy.deepcopy(payload["content"]))
    label_question(case, world.subject, "7")
    case.target = world.candidate(payload, regions=[region])
    return case


def case_19_published_keeps_status() -> Case:
    """(19) A published candidate keeps its status even when a blocking issue is found."""
    payload = single_choice_payload(known=False)
    case, _world, _region = leaf_world("published_candidate_keeps_status", payload=payload, status="published")
    return case


def case_20_ignored_keeps_status() -> Case:
    """(20) An ignored candidate also keeps its status."""
    payload = single_choice_payload()
    payload["answer_payload"] = {}
    case, _world, _region = leaf_world("ignored_candidate_keeps_status", payload=payload, status="ignored")
    return case


def case_21_ready_downgraded() -> Case:
    """(21) A ready candidate that now has a blocking issue falls back to draft."""
    payload = single_choice_payload(known=False)
    case, _world, _region = leaf_world("ready_candidate_downgraded", payload=payload, status="ready")
    return case


def case_22_draft_becomes_ready() -> Case:
    """(22) A clean draft is promoted to ready."""
    case, _world, _region = leaf_world("draft_candidate_becomes_ready", payload=single_choice_payload(), status="draft")
    return case


def case_23_issue_emission_order() -> Case:
    """(23) One candidate carrying content, answer, region, cross-page and duplicate issues at once."""
    case = Case("issue_emission_order", refresh=True)
    world = World(case)
    world.job.documents.add(world.document(title="2024 真题 正文（无来源区域）"))
    payload = single_choice_payload(options=[], label="23", extra={"continues_on_pages": [1, 2]})
    payload["answer_payload"] = {}
    published_question(case, world.subject, content=copy.deepcopy(payload["content"]))
    label_question(case, world.subject, "23")
    other_job = world.extra_job("other_job")
    world.candidate(copy.deepcopy(payload), status="draft", job=other_job, subject=world.subject)
    case.target = world.candidate(payload)
    return case


def case_24_material_children_order() -> Case:
    """Extra: `material_children_unpublished.candidate_ids` follows child `created_at`, not input order."""
    case = Case("material_children_order", refresh=True)
    world = World(case)
    document = world.document()
    world.job.documents.add(document)
    region = world.region(document)
    material = world.candidate(material_payload(label="11"), regions=[region])
    # published child first, then two drafts: only the drafts are listed, in created_at order.
    # The higher label is created *first*, so `candidate_ids` cannot be a by-label sort.
    world.child(material, "11(1)", "第(1)小问：已发布。", status="published", regions=[region])
    world.child(material, "11(3)", "第(3)小问：草稿，先创建。", regions=[region])
    world.child(material, "11(2)", "第(2)小问：草稿，后创建。", regions=[region])
    case.target = material
    return case


# --------------------------------------------------------------------------
# B1 never produces `ai_variant` issues: pin three non-variant input kinds
# --------------------------------------------------------------------------
def case_25_input_kind_text() -> Case:
    """(25) `input_kind='text'` is never treated as an AI variant."""
    case, _world, _region = leaf_world("input_kind_text_no_variant_issue", payload=single_choice_payload())
    return case


def case_26_input_kind_image_ai() -> Case:
    """(26) `input_kind='image_ai'` too."""
    case = Case("input_kind_image_ai_no_variant_issue", refresh=True)
    world = World(case, input_kind="image_ai")
    document = world.document(title="拍照导入的整页", document_type="image")
    world.job.documents.add(document)
    region = world.region(document)
    case.target = world.candidate(single_choice_payload(), regions=[region])
    return case


def case_27_input_kind_manual_blocking() -> Case:
    """(27) `input_kind='manual'` keeps the ordinary blocking answer rule."""
    case = Case("input_kind_manual_blocking_issue", refresh=True)
    world = World(case, input_kind="manual")
    document = world.document(title="手工录入", document_type="text")
    world.job.documents.add(document)
    region = world.region(document)
    payload = single_choice_payload()
    payload["answer_payload"] = {}
    case.target = world.candidate(payload, regions=[region])
    return case


# --------------------------------------------------------------------------
# summary cases (refresh=False)
# --------------------------------------------------------------------------
def case_s1_job_summary() -> Case:
    """(S1) job_summary over 3 candidates in 3 states, 2 documents, problems and page rows."""
    case = Case("job_summary_mixed_candidates", refresh=False)
    world = World(
        case,
        input_kind="pdf",
        job_extra={
            "status": "failed",
            "attempts": 2,
            "progress_percent": 40,
            "last_error": "第 3 页没有文字层，已跳过",
            "extractor_version": "pdf-text-v2",
        },
    )
    document_one = world.document(title="2024 上半年 卷一", document_type="pdf")
    document_two = world.document(title="2024 上半年 答案页", document_type="pdf_answer")
    world.job.documents.add(document_one, document_two)
    original = world.extra_job("original_job", status="completed", progress_percent=100, attempts=1)
    world.job.duplicate_of = original
    world.job.save(update_fields=["duplicate_of"])
    problems = [
        {
            "code": "pdf_page_skipped",
            "message": "第 3 页没有文字层，已跳过",
            "severity": "warning",
            "page_index": 3,
            "detail": {"retryable": True, "engine": "pdfminer"},
        }
    ]
    page_diagnostics = [
        {"document_id": str(document_one.id), "page_index": 2, "reasons": ["multi_column_layout"]},
        {"document_id": str(document_one.id), "page_index": 3, "reasons": ["page_without_text_layer"]},
    ]
    ImportJob.objects.filter(pk=world.job.pk).update(problems=problems, page_diagnostics=page_diagnostics)
    world.job.problems = problems
    world.job.page_diagnostics = page_diagnostics
    world.candidate(single_choice_payload("草稿题", label="1"), status="draft")
    ready = world.candidate(single_choice_payload("待发布题", label="2"), status="ready")
    world.candidate(single_choice_payload("已忽略题", label="3"), status="ignored")
    case.target = ready
    return case


def case_s2_candidate_summary() -> Case:
    """(S2) candidate_summary with regions, parent/children, publication ids and layout review."""
    case = Case("candidate_summary_full", refresh=False)
    world = World(case)
    document_a = world.document(title="2024 真题 正文", document_type="pdf")
    document_b = world.document(title="2024 真题 续页", document_type="pdf")
    world.job.documents.add(document_a, document_b)
    # inserted in an order the (document, page_index, y, x) ordering must undo
    region_a2 = world.region(document_a, page_index=2, x=0.2, y=0.7, text_span="第二页题干")
    region_b1 = world.region(document_b, page_index=1, x=0.1, y=0.1, text_span="续页题干")
    region_a1 = world.region(document_a, page_index=1, x=0.4, y=0.2, text_span="第一页题干")
    _paper, revision = world.paper()
    material = world.candidate(material_payload(label="三"), regions=[region_a1])
    payload = single_choice_payload("某材料题的第 2 小问", label="三.2", max_score="6")
    machine_payload = copy.deepcopy(payload)
    machine_payload["raw_label"] = "（三）2"
    machine_payload["parse_issues"] = [{"code": "label_from_header", "message": "题号来自版头", "severity": "warning"}]
    target = world.candidate(
        payload,
        status="ready",
        revision=2,
        regions=[region_a2, region_b1, region_a1],
        subject=world.subject,
        machine_payload=machine_payload,
        parent_candidate=material,
        source_position_key="三.2",
        paper_revision=revision,
        answer_match={"matched": True, "method": "order", "raw": "B", "source_page_index": 4},
        publication_question_id=case.uid("publication_question"),
        publication_version_id=case.uid("publication_version"),
        publication_paper_item_id=case.uid("publication_paper_item"),
        layout_review_confirmed_at=BASE + timedelta(days=1, hours=3),
        layout_review_note="已对照原页确认版式",
        review_issues=[{"code": "cross_page_question", "message": "该题跨页", "severity": "warning", "pages": [1, 2]}],
    )
    world.candidate(single_choice_payload("第一小问", label="三.2(1)"), regions=[region_a1], parent_candidate=target)
    world.candidate(single_choice_payload("第二小问", label="三.2(2)"), regions=[region_a2], parent_candidate=target)
    case.target = target
    return case


def case_s3_minimal_candidate_summary() -> Case:
    """(S3) The emptiest candidate: no subject, no regions, no publication ids."""
    case = Case("candidate_summary_minimal", refresh=False)
    world = World(case, subject=False)
    world.job.documents.add(world.document())
    case.target = world.candidate({}, subject=None, extractor_version="")
    return case


BUILDERS = [
    case_01_missing_question_type,
    case_02_single_choice_empty_options,
    case_03_single_choice_one_option,
    case_04_material_without_children,
    case_05_material_child_unpublished,
    case_06_material_all_children_published,
    case_07_answer_status_unknown,
    case_08_answer_payload_empty,
    case_09_answer_match_pending,
    case_10_answer_match_confirmed,
    case_11_paper_item_score_missing,
    case_12_duplicate_paper_position,
    case_13_no_source_region,
    case_14_multi_column_needs_review,
    case_15_multi_column_confirmed,
    case_16_cross_page,
    case_17_duplicate_candidate,
    case_18_duplicate_published_and_label,
    case_19_published_keeps_status,
    case_20_ignored_keeps_status,
    case_21_ready_downgraded,
    case_22_draft_becomes_ready,
    case_23_issue_emission_order,
    case_24_material_children_order,
    case_25_input_kind_text,
    case_26_input_kind_image_ai,
    case_27_input_kind_manual_blocking,
    case_s1_job_summary,
    case_s2_candidate_summary,
    case_s3_minimal_candidate_summary,
]

#: What each refresh case must observe — the generator fails loudly if a branch stopped firing.
EXPECTED_CODES: dict[str, list[str]] = {
    "missing_question_type": ["missing_question_type", "subject_missing", "no_source_region"],
    "single_choice_empty_options": ["options_empty", "too_few_options"],
    "single_choice_one_option": ["too_few_options"],
    "material_without_children": ["material_without_children"],
    "material_child_unpublished": ["material_children_unpublished"],
    "material_all_children_published": [],
    "answer_status_unknown_leaf": ["answer_unknown"],
    "answer_payload_missing_leaf": ["answer_missing"],
    "answer_match_pending_label": ["answer_match_pending_confirmation"],
    "answer_match_confirmed_by_review": [],
    "paper_item_score_missing": ["paper_item_score_missing"],
    "duplicate_paper_position": ["duplicate_paper_position"],
    "candidate_without_source_region": ["no_source_region"],
    "multi_column_page_needs_review": ["multi_column_needs_review"],
    "multi_column_page_confirmed": [],
    "cross_page_continues_on_pages": ["cross_page_question"],
    "duplicate_candidate_in_project": ["duplicate_candidate"],
    "duplicate_published_and_label": ["duplicate_published", "duplicate_label"],
    "published_candidate_keeps_status": ["answer_unknown"],
    "ignored_candidate_keeps_status": ["answer_missing"],
    "ready_candidate_downgraded": ["answer_unknown"],
    "draft_candidate_becomes_ready": [],
    "issue_emission_order": [
        "options_empty",
        "too_few_options",
        "answer_missing",
        "no_source_region",
        "cross_page_question",
        "duplicate_candidate",
        "duplicate_published",
        "duplicate_label",
    ],
    "material_children_order": ["material_children_unpublished"],
    "input_kind_text_no_variant_issue": [],
    "input_kind_image_ai_no_variant_issue": [],
    "input_kind_manual_blocking_issue": ["answer_missing"],
}

EXPECTED_STATUS: dict[str, str] = {
    "missing_question_type": "draft",
    "single_choice_empty_options": "draft",
    "single_choice_one_option": "draft",
    "material_without_children": "draft",
    "material_child_unpublished": "draft",
    "material_all_children_published": "ready",
    "answer_status_unknown_leaf": "draft",
    "answer_payload_missing_leaf": "draft",
    "answer_match_pending_label": "draft",
    "answer_match_confirmed_by_review": "ready",
    "paper_item_score_missing": "draft",
    "duplicate_paper_position": "draft",
    # warning-only candidates are promoted, exactly like `draft_candidate_becomes_ready`
    "candidate_without_source_region": "ready",
    "multi_column_page_needs_review": "draft",
    "multi_column_page_confirmed": "ready",
    "cross_page_continues_on_pages": "ready",
    "duplicate_candidate_in_project": "ready",
    "duplicate_published_and_label": "ready",
    "published_candidate_keeps_status": "published",
    "ignored_candidate_keeps_status": "ignored",
    "ready_candidate_downgraded": "draft",
    "draft_candidate_becomes_ready": "ready",
    "issue_emission_order": "draft",
    "material_children_order": "draft",
    "input_kind_text_no_variant_issue": "ready",
    "input_kind_image_ai_no_variant_issue": "ready",
    "input_kind_manual_blocking_issue": "draft",
}


def issue_codes(entry: dict) -> list[str]:
    issues = entry["expected"]["issues"]
    return [issue["code"] for issue in issues] if issues else []


def verify(cases: list[dict]) -> None:
    """Fail the generation (not the Node test) when a fixture stopped exercising its branch."""
    names = [entry["name"] for entry in cases]
    if len(names) != len(set(names)):
        raise AssertionError(f"duplicate case names: {names}")
    observed: dict[str, dict] = {entry["name"]: entry for entry in cases}
    for name, expected in EXPECTED_CODES.items():
        entry = observed[name]
        actual = issue_codes(entry)
        if actual != expected:
            raise AssertionError(f"{name}: expected issues {expected}, got {actual}")
        if entry["expected"]["status"] != EXPECTED_STATUS[name]:
            raise AssertionError(
                f"{name}: expected status {EXPECTED_STATUS[name]!r}, got {entry['expected']['status']!r}"
            )
        if entry["expected"]["job_summary"] is not None or entry["expected"]["candidate_summary"] is not None:
            raise AssertionError(f"{name}: a refresh case must not carry summaries")
    for name, entry in observed.items():
        if name in EXPECTED_CODES:
            continue
        if entry["expected"]["issues"] is not None or entry["expected"]["status"] is not None:
            raise AssertionError(f"{name}: a summary case must not carry issues/status")
        if entry["expected"]["job_summary"] is None or entry["expected"]["candidate_summary"] is None:
            raise AssertionError(f"{name}: a summary case must carry both summaries")
    for entry in cases:
        for issue in entry["expected"]["issues"] or []:
            if str(issue.get("code", "")).startswith("variant_"):
                raise AssertionError(f"{entry['name']}: B1 must never emit a variant issue ({issue['code']})")
    # (9) pins the message wording, including the 40-code-point truncation of the raw answer text.
    pending = [
        issue
        for issue in observed["answer_match_pending_label"]["expected"]["issues"]
        if issue["code"] == "answer_match_pending_confirmation"
    ]
    if len(pending) != 1:
        raise AssertionError("answer_match_pending_label: missing the pending-confirmation issue")
    message = pending[0]["message"]
    if "方式：题号" not in message or ANSWER_PAGE_RAW[:40] not in message:
        raise AssertionError(f"answer_match_pending_label: unexpected message {message!r}")
    # (24) only the two draft children are listed, in created_at order.
    listed = observed["material_children_order"]["expected"]["issues"][0]["candidate_ids"]
    if len(listed) != 2:
        raise AssertionError(f"material_children_order: expected 2 unpublished children, got {listed}")
    rows = observed["material_children_order"]["rows"]["ingestion_import_candidate"]
    created = {row["id"]: row["created_at"] for row in rows}
    order = [created[candidate_id] for candidate_id in listed]
    if order != sorted(order):
        raise AssertionError(f"material_children_order: candidate_ids are not in created_at order: {listed}")
    # (14) keeps repeats in `page_indexes` but de-duplicates `reasons` per row.
    layout_issue = observed["multi_column_page_needs_review"]["expected"]["issues"][0]
    if layout_issue["page_indexes"] != [2, 2] or layout_issue["reasons"] != [
        "column_reading_order_ambiguous",
        "multi_column_layout",
    ]:
        raise AssertionError(f"multi_column_page_needs_review: unexpected layout issue {layout_issue!r}")


def build() -> list[dict]:
    cases: list[dict] = []
    for builder in BUILDERS:
        case = builder()
        if case.target is None:
            raise AssertionError(f"{case.name}: no target candidate")
        case.fix_timestamps()
        case.collect_through_rows()
        case.reload()
        # Snapshot the rows *before* the refresh mutates `review_issues` / `status` / `updated_at`.
        rows = case.rows()
        if case.refresh:
            issues = refresh_candidate_issues(case.target)
            expected = {
                "issues": issues,
                "status": case.target.status,
                "job_summary": None,
                "candidate_summary": None,
            }
        else:
            expected = {
                "issues": None,
                "status": None,
                "job_summary": job_summary(case.target.job),
                "candidate_summary": candidate_summary(case.target),
            }
        cases.append(
            {
                "name": case.name,
                "refresh": case.refresh,
                "rows": rows,
                "target_candidate_id": str(case.target.id),
                "expected": expected,
            }
        )
    return cases


def summarise(cases: list[dict]) -> None:
    refresh_count = sum(1 for entry in cases if entry["refresh"])
    summary_count = sum(
        1
        for entry in cases
        if entry["expected"]["job_summary"] is not None or entry["expected"]["candidate_summary"] is not None
    )
    print(f"wrote {OUT}: {len(cases)} cases ({refresh_count} issue-refresh vectors, {summary_count} summary cases)")
    for entry in cases:
        if entry["refresh"]:
            codes = ", ".join(issue_codes(entry)) or "(none)"
            print(f"  {entry['name']:<34} refresh  status={entry['expected']['status']:<9} {codes}")
        else:
            print(f"  {entry['name']:<34} summary  job_summary + candidate_summary")
    print("spot-check (expected issues, verbatim from Django):")
    for name in ("single_choice_empty_options", "answer_match_pending_label", "issue_emission_order"):
        entry = next(item for item in cases if item["name"] == name)
        print(f"  {name}: {json.dumps(entry['expected']['issues'], ensure_ascii=False, sort_keys=True)}")
    material = next(item for item in cases if item["name"] == "material_children_order")
    printed = json.dumps(material["expected"]["issues"], ensure_ascii=False, sort_keys=True)
    print(f"  material_children_order: {printed}")


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        cases = build()
        verify(cases)
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {"cases": cases}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    summarise(cases)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
