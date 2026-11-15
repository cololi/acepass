#!/usr/bin/env python
"""Golden vectors for the O18 publication write-set.

Oracle: the real `apps.ingestion.services.core.publish_candidate` executed against real PostgreSQL
rows, plus the real `apps.question_bank.services.core.publish_problems` for the validation matrix.
Nothing here re-implements a rule: each `expected` block is what Django produced.

Two shapes are emitted:

    {"publish": [{"name", "rows", "target_candidate_id", "options", "expected"}],
     "problems": [{"name", "rows", "version_id", "expected"}]}

`publish` cases record the semantic write-set: candidate pointers, the created question / version /
answer / rubric / source links / mappings / paper items, the audit rows and the outbox event. New
identifiers are replaced by role names (`Q_<candidate>`, `V_<candidate>`, ...) and pre-existing rows
keep their deterministic `uuid5` ids, so the same fixture can be replayed in SQLite and compared
field by field. Error cases record the exception the service raised (class, code, message, details)
and assert that no row was written.

Every id is `uuid5` of the case name and every timestamp is `BASE + n minutes`, so a rerun is
byte-identical apart from the service-internal `now` values, which the snapshot never records.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_ingestion_publish_golden.py
"""

from __future__ import annotations

import json
import os
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

from django.contrib.auth import get_user_model  # noqa: E402
from django.core.exceptions import ValidationError  # noqa: E402
from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from apps.audit.models import ContentRevision, OutboxEvent  # noqa: E402
from apps.common.errors import AcePassError  # noqa: E402
from apps.exams.models import (  # noqa: E402
    ExamProject,
    ExamSpecVersion,
    Paper,
    PaperItem,
    PaperRevision,
    Subject,
    SyllabusVersion,
)
from apps.ingestion.models import ImportCandidate, ImportJob, SourceDocument, SourceRegion  # noqa: E402
from apps.ingestion.services.core import publish_candidate, refresh_candidate_issues  # noqa: E402
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge  # noqa: E402
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionSourceLink,
    QuestionVersion,
    RubricVersion,
)
from apps.question_bank.services.core import publish_problems  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "ingestion_publish.json"

BASE = datetime(2026, 4, 1, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# serialisation helpers
# --------------------------------------------------------------------------
def jsonable(value):
    if value is None:
        return None
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
    return {field.attname: jsonable(getattr(obj, field.attname)) for field in obj._meta.concrete_fields}


def delta(before: dict, after: dict) -> dict:
    return {name: after[name] - before[name] for name in before if after[name] != before[name]}


# --------------------------------------------------------------------------
# one isolated world
# --------------------------------------------------------------------------
class World:
    def __init__(self, name: str) -> None:
        self.name = name
        self.rows: dict[str, list[dict]] = {}
        self.symbols: dict[str, str] = {}
        self._counters: dict[str, int] = {}
        self.owner = None
        self.project = None
        self.subject = None
        self.spec = None
        self.document = None
        self.paper = None
        self.paper_revision = None
        self.candidate = None
        self.steps: list[dict] = []
        self.clock = BASE

    # -- identity / timestamps -------------------------------------------------
    def uid(self, entity: str) -> uuid.UUID:
        n = self._counters.get(entity, 0) + 1
        self._counters[entity] = n
        return uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b2:{self.name}:{entity}:{n}")

    def now(self) -> datetime:
        self.clock = self.clock + timedelta(minutes=1)
        return self.clock

    def create(self, model, entity: str, **kwargs):
        obj = model(id=self.uid(entity), **kwargs)
        obj.save(force_insert=True)
        # `auto_now_add` / `auto_now` write the wall clock; overwrite them with the fixture clock so
        # a rerun is byte-identical. `QuerySet.update()` bypasses `auto_now`, `save()` does not.
        stamp = self.now()
        names = {field.name for field in model._meta.concrete_fields}
        overrides = {
            name: stamp
            for name in ("created_at", "updated_at", "date_joined")
            if name in names
        }
        if overrides:
            model.objects.filter(pk=obj.pk).update(**overrides)
            obj.refresh_from_db()
        self.rows.setdefault(model._meta.db_table, []).append(dump_row(obj))
        return obj

    def exported_symbols(self) -> dict:
        """Only names for rows the fixture actually contains.

        Symbols for rows a publication created point at random UUIDs; they would make the fixture
        differ on every run and the Node test names those rows itself.
        """
        ids = {
            str(entry["id"])
            for entries in self.rows.values()
            for entry in entries
            if entry.get("id") is not None
        }
        return {key: value for key, value in self.symbols.items() if key in ids}

    def refresh(self, obj) -> None:
        """Replace the captured row after a mutation, so the fixture holds the final state."""
        names = {field.name for field in obj._meta.concrete_fields}
        overrides = {name: self.now() for name in ("updated_at", "date_joined") if name in names}
        if overrides:
            type(obj).objects.filter(pk=obj.pk).update(**overrides)
            obj.refresh_from_db()
        table = obj._meta.db_table
        entries = self.rows.get(table, [])
        for index, entry in enumerate(entries):
            if str(entry.get("id")) == str(obj.id):
                entries[index] = dump_row(obj)
                return
        entries.append(dump_row(obj))
        self.rows[table] = entries

    def symbol(self, obj, name: str) -> str:
        self.symbols[str(getattr(obj, "id", obj))] = name
        return name

    # -- fixtures --------------------------------------------------------------
    def base(self, *, with_paper: bool = False) -> None:
        user_model = get_user_model()
        self.owner = self.create(
            user_model,
            "user",
            email=f"{self.name}@example.test",
            password="GoldenPass!2026",
            display_name="B2 黄金",
            is_active=True,
        )
        self.project = self.create(ExamProject, "project", owner=self.owner, name=f"项目-{self.name}")
        self.subject = self.create(
            Subject, "subject", project=self.project, name="科目", total_score=Decimal("100"), pass_score=Decimal("60")
        )
        self.spec = self.create(
            ExamSpecVersion,
            "spec",
            subject=self.subject,
            version=1,
            name="规范",
            question_type_rules={
                "single_choice": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
                "fill_blank": {"default_max_score": "4.00", "wrong_score": "0.00", "blank_score": "0.00"},
                "constructed_response": {"default_max_score": "6.00", "wrong_score": "0.00", "blank_score": "0.00"},
            },
            status="published",
            published_at=self.now(),
        )
        self.document = self.create(
            SourceDocument,
            "document",
            owner=self.owner,
            project=self.project,
            subject=self.subject,
            title="来源",
            document_type="text",
            role="past_paper_page",
            sensitivity="public_to_owner",
            raw_text="来源文本",
            checksum="0" * 64,
            source_type="user_paste",
            page_count=1,
        )
        if with_paper:
            self.paper = self.create(
                Paper,
                "paper",
                subject=self.subject,
                cycle_key="2025",
                session_key="",
                paper_code="卷一",
                title="试卷",
                source_kind="official_past",
                is_demo=False,
            )
            self.paper_revision = self.create(
                PaperRevision, "paper_revision", paper=self.paper, revision=1, status="draft"
            )
            self.symbol(self.paper, "PAPER")
            self.symbol(self.paper_revision, "PAPER_REV")

    def syllabus(self, names: list[str], *, subject=None) -> list[KnowledgeNode]:
        subject = subject or self.subject
        syllabus = self.create(SyllabusVersion, "syllabus", subject=subject, name="大纲", version_label="v1")
        nodes = []
        for index, name in enumerate(names):
            node = self.create(
                KnowledgeNode, f"node{index}", syllabus_version=syllabus, canonical_name=name
            )
            self.symbol(node, f"NODE_{index + 1}")
            nodes.append(node)
        return nodes

    def job(self, *, input_kind: str = "text", subject=None) -> ImportJob:
        job = self.create(
            ImportJob,
            "job",
            project=self.project,
            subject=subject or self.subject,
            created_by=self.owner,
            status="awaiting_review",
            input_kind=input_kind,
            input_text=f"golden:{self.name}",
            extractor_version="text-structure-v1",
            input_fingerprint="1" * 64,
        )
        self.symbol(job, "JOB")
        return job

    def make_candidate(
        self,
        label: str,
        *,
        payload: dict,
        subject=None,
        job: ImportJob | None = None,
        parent: ImportCandidate | None = None,
        paper: bool = False,
        position_key: str = "",
        regions: int = 1,
    ) -> ImportCandidate:
        job = job or self.job(subject=subject)
        candidate = self.create(
            ImportCandidate,
            f"candidate_{label}",
            job=job,
            project=self.project,
            subject=subject if subject is not None else self.subject,
            parent_candidate=parent,
            source_position_key=position_key,
            paper_revision=self.paper_revision if paper else None,
            status="draft",
            draft_payload=payload,
            machine_payload=payload,
            revision=1,
            extractor_version="text-structure-v1",
        )
        self.symbol(candidate, f"CAND_{label}")
        for index in range(regions):
            region = self.create(
                SourceRegion,
                f"region_{label}_{index}",
                document=self.document,
                page_index=1,
                x=0.0,
                y=0.05 * index,
                width=1.0,
                height=0.05,
                role="stem_crop",
                text_span=f"{label} 题干",
            )
            candidate.source_regions.add(region)
            self.symbol(region, f"REGION_{label}_{index + 1}")
            through = ImportCandidate.source_regions.through.objects.get(
                importcandidate_id=candidate.id, sourceregion_id=region.id
            )
            self.rows.setdefault("ingestion_import_candidate_source_regions", []).append(dump_row(through))
        refresh_candidate_issues(candidate)
        candidate.refresh_from_db()
        if label == "TARGET":
            self.candidate = candidate
        return candidate

    # -- snapshot --------------------------------------------------------------
    def after_publish(self, candidate: ImportCandidate, label: str) -> None:
        candidate.refresh_from_db()
        if candidate.publication_question_id:
            self.symbols[str(candidate.publication_question_id)] = f"Q_{label}"
        if candidate.publication_version_id:
            self.symbols[str(candidate.publication_version_id)] = f"V_{label}"
        if candidate.publication_paper_item_id:
            self.symbols[str(candidate.publication_paper_item_id)] = f"ITEM_{label}"
        if candidate.publication_version_id:
            answer = AnswerKeyVersion.objects.filter(question_version_id=candidate.publication_version_id).first()
            if answer is not None:
                self.symbols[str(answer.id)] = f"A_{label}"
                rubric = RubricVersion.objects.filter(answer_key_version=answer).first()
                if rubric is not None:
                    self.symbols[str(rubric.id)] = f"R_{label}"

    def sym(self, value) -> str | None:
        if value is None:
            return None
        text = str(value)
        return self.symbols.get(text, f"<unknown:{text[:8]}>")

    def snapshot(self, candidate: ImportCandidate) -> dict:
        candidate.refresh_from_db()
        question = (
            Question.objects.filter(id=candidate.publication_question_id).first()
            if candidate.publication_question_id
            else None
        )
        version = (
            QuestionVersion.objects.filter(id=candidate.publication_version_id).first()
            if candidate.publication_version_id
            else None
        )
        answer = (
            AnswerKeyVersion.objects.filter(question_version=version).order_by("-version").first()
            if version is not None
            else None
        )
        rubric = (
            RubricVersion.objects.filter(answer_key_version=answer).first() if answer is not None else None
        )
        links = []
        mappings = []
        items = []
        audit = []
        if version is not None:
            links = [
                {"role": link.role, "region": self.sym(link.region_id), "note": link.note}
                for link in QuestionSourceLink.objects.filter(question_version=version).order_by("created_at")
            ]
            mappings = [
                {
                    "mapping_revision": row.mapping_revision,
                    "node": self.sym(row.node_id),
                    "is_primary": row.is_primary,
                    "score_weight": str(row.score_weight),
                    "note": row.note,
                }
                for row in QuestionKnowledge.objects.filter(question_version=version).order_by(
                    "mapping_revision", "node__canonical_name"
                )
            ]
            items = [
                {
                    "position_key": item.position_key,
                    "parent_position": None if item.parent_item_id is None else item.parent_item.position_key,
                    "answer_key": self.sym(item.answer_key_version_id),
                    "max_score": str(item.max_score),
                    "is_scored": item.is_scored,
                    "is_demo": item.is_demo,
                }
                for item in PaperItem.objects.filter(question_version=version).order_by("position_key")
            ]
            audit = [
                {"entity_type": row.entity_type, "action": row.action}
                for row in ContentRevision.objects.filter(
                    entity_id__in=[
                        str(value)
                        for value in (version.id, answer.id if answer is not None else None)
                        if value is not None
                    ]
                ).order_by("created_at")
            ]
        paper_ids = [str(self.paper.id)] if self.paper is not None else []
        outbox = [
            {
                "topic": event.topic,
                "payload": event.payload,
                "dedupe_key": event.dedupe_key,
                "status_is_pending": event.processed_at is None,
            }
            for event in OutboxEvent.objects.filter(payload__paper_id__in=paper_ids).order_by("created_at")
        ]
        return {
            "candidate": {
                "status": candidate.status,
                "revision": candidate.revision,
                "publication_question_id": self.sym(candidate.publication_question_id),
                "publication_version_id": self.sym(candidate.publication_version_id),
                "publication_paper_item_id": self.sym(candidate.publication_paper_item_id),
                "reviewed_at_is_null": candidate.reviewed_at is None,
            },
            "question": None
            if question is None
            else {
                "origin_type": question.origin_type,
                "is_demo": question.is_demo,
                "display_label": question.display_label,
                "current_published_version": self.sym(question.current_published_version_id),
                "family_id": self.sym(question.family_id),
                "content_lineage_id": self.sym(question.content_lineage_id),
            },
            "version": None
            if version is None
            else {
                "version": version.version,
                "question_type": version.question_type,
                "status": version.status,
                "practice_max_score": None
                if version.practice_max_score is None
                else str(version.practice_max_score),
                "estimated_seconds": version.estimated_seconds,
                "revision_reason": version.revision_reason,
                "source_note": version.source_note,
                "parent_material_version": self.sym(version.parent_material_version_id),
                "material_child_version_ids": [
                    self.sym(value) for value in (version.material_child_version_ids or [])
                ],
                "content": version.content,
                "content_digest": version.content_digest,
            },
            "answer": None
            if answer is None
            else {
                "version": answer.version,
                "answer_payload": answer.answer_payload,
                "source_type": answer.source_type,
                "verification_status": answer.verification_status,
                "check_basis": answer.check_basis,
                "checked_at_is_set": answer.checked_at is not None,
                "checked_by_is_actor": answer.checked_by_id is not None,
                "source_region": self.sym(answer.source_region_id),
                "explanation_blocks": answer.explanation_blocks,
                "supersedes": self.sym(answer.supersedes_id),
                "is_disputed": answer.is_disputed,
            },
            "rubric": None
            if rubric is None
            else {
                "version": rubric.version,
                "criteria": rubric.criteria,
                "total_score": str(rubric.total_score),
                "usage_note": rubric.usage_note,
                "checked_at_is_set": rubric.checked_at is not None,
            },
            "source_links": links,
            "mappings": mappings,
            "paper_items": items,
            "audit": audit,
            "outbox": outbox,
        }

    def publish(self, candidate: ImportCandidate, label: str, **options) -> dict:
        """Publish one candidate and return the rows this call added."""
        recorded: dict = {}
        if "exam_spec_version" in options:
            spec = options["exam_spec_version"]
            recorded["exam_spec_version_id"] = None if spec is None else str(spec.id)
        if options.get("node_ids") is not None:
            recorded["node_ids"] = [str(value) for value in options["node_ids"]]
        if "origin_type" in options:
            recorded["origin_type"] = options["origin_type"]
        if "display_label" in options:
            recorded["display_label"] = options["display_label"]
        self.steps.append({"candidate_id": str(candidate.id), "label": label, "options": recorded})
        before = self.counts()
        publish_candidate(candidate, actor=self.owner, **options)
        self.after_publish(candidate, label)
        return delta(before, self.counts())

    def counts(self) -> dict:
        return {
            "question_bank_question": Question.objects.count(),
            "question_bank_question_version": QuestionVersion.objects.count(),
            "question_bank_answer_key_version": AnswerKeyVersion.objects.count(),
            "question_bank_rubric_version": RubricVersion.objects.count(),
            "question_bank_source_link": QuestionSourceLink.objects.count(),
            "knowledge_question_mapping": QuestionKnowledge.objects.count(),
            "exams_paper_item": PaperItem.objects.count(),
            "audit_content_revision": ContentRevision.objects.count(),
            "audit_outbox_event": OutboxEvent.objects.count(),
        }


# --------------------------------------------------------------------------
# payload helpers
# --------------------------------------------------------------------------
def single_choice(label: str, *, score="2.00", display_label="", estimated_seconds=None) -> dict:
    payload = {
        "question_type": "single_choice",
        "display_label": display_label,
        "content": {
            "blocks": [{"kind": "text", "text": f"{label} 题干"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        },
        "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
        "answer_status_known": True,
        "explanation_blocks": [],
        "practice_max_score": score,
    }
    if estimated_seconds is not None:
        payload["estimated_seconds"] = estimated_seconds
    return payload


def constructed_response(label: str, criteria, *, total="6.00", score="6.00") -> dict:
    return {
        "question_type": "constructed_response",
        "display_label": "",
        "content": {"blocks": [{"kind": "text", "text": f"{label} 题干"}]},
        "answer_payload": {
            "kind": "constructed_response",
            "reference_answer": "参考答案",
            "rubric_required": True,
        },
        "answer_status_known": True,
        "explanation_blocks": [{"kind": "text", "text": "解析"}],
        "practice_max_score": score,
        "rubric_criteria": criteria,
        "rubric_total_score": total,
        "check_basis": "与官方答案核对一致",
        "answer_source_type": "official",
    }


def fill_blank(label: str, *, score="4.00", blank_scores=("2.00", "2.00")) -> dict:
    return {
        "question_type": "fill_blank",
        "display_label": "",
        "content": {
            "blocks": [{"kind": "text", "text": f"{label} 填空"}],
            "blanks": [
                {"blank_id": "b1", "max_score": blank_scores[0]},
                {"blank_id": "b2", "max_score": blank_scores[1]},
            ],
        },
        "answer_payload": {
            "kind": "fill_blank",
            "blanks": {
                "b1": {"accepted_values": ["甲"], "max_score": blank_scores[0]},
                "b2": {"accepted_values": ["乙"], "max_score": blank_scores[1]},
            },
        },
        "answer_status_known": True,
        "explanation_blocks": [],
        "practice_max_score": score,
    }


def material_payload(label: str) -> dict:
    return {
        "question_type": "material",
        "display_label": "",
        "content": {"blocks": [{"kind": "text", "text": f"{label} 共享材料"}], "options": []},
        "answer_payload": {},
        "answer_status_known": True,
        "explanation_blocks": [],
        "practice_max_score": None,
    }


# --------------------------------------------------------------------------
# publish cases
# --------------------------------------------------------------------------
def case_leaf() -> dict:
    world = World("leaf")
    world.base()
    nodes = world.syllabus(["考点一"])
    candidate = world.make_candidate("TARGET", payload=single_choice("L1"))
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=[str(nodes[0].id)])
    return {
        "name": "leaf: 单选 + 一个考点 + 一个来源区域",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {"node_ids": [str(nodes[0].id)]},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_two_nodes() -> dict:
    world = World("two_nodes")
    world.base()
    nodes = world.syllabus(["考点一", "考点二"])
    candidate = world.make_candidate("TARGET", payload=single_choice("L2"))
    row_delta = world.publish(
        candidate, "TARGET", exam_spec_version=None, node_ids=[str(n.id) for n in nodes]
    )
    return {
        "name": "leaf: 两个考点等分权重",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {"node_ids": [str(n.id) for n in nodes]},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_constructed() -> dict:
    world = World("constructed")
    world.base()
    criteria = [
        {"criterion_id": "c1", "text": "要点一", "max_score": "4.00"},
        {"criterion_id": "c2", "text": "要点二", "max_score": "2.00", "depends_on": ["c1"]},
    ]
    candidate = world.make_candidate("TARGET", payload=constructed_response("C1", criteria))
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=None)
    return {
        "name": "leaf: 大题写答案与 rubric",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_fill_blank() -> dict:
    world = World("fill_blank")
    world.base()
    candidate = world.make_candidate("TARGET", payload=fill_blank("F1"))
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=None)
    return {
        "name": "leaf: 填空各空分值合计等于题目分值",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_spec_default() -> dict:
    world = World("spec_default")
    world.base()
    payload = single_choice("S1", score=None)
    candidate = world.make_candidate("TARGET", payload=payload)
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=world.spec, node_ids=None)
    return {
        "name": "leaf: 未声明分值时采用规范默认分值",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {"exam_spec_version_id": str(world.spec.id)},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_display_label() -> dict:
    world = World("display_label")
    world.base()
    candidate = world.make_candidate(
        "TARGET", payload=single_choice("D1", display_label="payload 标签", estimated_seconds=90)
    )
    row_delta = world.publish(
        candidate, "TARGET", exam_spec_version=None, node_ids=None, display_label="请求标签"
    )
    return {
        "name": "leaf: 请求 display_label 优先，estimated_seconds 落库",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {"display_label": "请求标签"},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_long_label() -> dict:
    world = World("long_label")
    world.base()
    candidate = world.make_candidate("TARGET", payload=single_choice("D2", display_label="长" * 250))
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=None)
    return {
        "name": "leaf: display_label 截断到 200 字符",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_demo_origin() -> dict:
    world = World("demo_origin")
    world.base()
    candidate = world.make_candidate("TARGET", payload=single_choice("O1"))
    row_delta = world.publish(
        candidate, "TARGET", exam_spec_version=None, node_ids=None, origin_type="demo"
    )
    return {
        "name": "leaf: demo 来源的 is_demo",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {"origin_type": "demo"},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_already_published() -> dict:
    world = World("already_published")
    world.base()
    candidate = world.make_candidate("TARGET", payload=single_choice("A1"))
    world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=None)
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=None)
    return {
        "name": "leaf: 重复发布返回原题目，不再建版本",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_paper_item() -> dict:
    world = World("paper_item")
    world.base(with_paper=True)
    candidate = world.make_candidate("TARGET", payload=single_choice("P1"), paper=True, position_key="12")
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=None)
    return {
        "name": "paper: 发布写入计分 PaperItem 与 outbox",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_paper_fallback_position() -> dict:
    world = World("paper_fallback")
    world.base(with_paper=True)
    candidate = world.make_candidate(
        "TARGET", payload=single_choice("P2", display_label="卷面标签"), paper=True, position_key=""
    )
    row_delta = world.publish(candidate, "TARGET", exam_spec_version=None, node_ids=None)
    return {
        "name": "paper: 无 source_position_key 时用 payload.display_label",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": {},
        "expected": {"ok": True, "snapshot": world.snapshot(candidate), "row_delta": row_delta},
    }


def case_material() -> dict:
    world = World("material")
    world.base(with_paper=True)
    parent = world.make_candidate("MATERIAL", payload=material_payload("M1"), paper=True, position_key="3")
    child1 = world.make_candidate(
        "CHILD1", payload=single_choice("M1.1"), parent=parent, paper=True, position_key="3.1"
    )
    child2 = world.make_candidate(
        "CHILD2", payload=single_choice("M1.2"), parent=parent, paper=True, position_key="3.2"
    )
    world.publish(child1, "CHILD1", exam_spec_version=None, node_ids=None)
    world.publish(child2, "CHILD2", exam_spec_version=None, node_ids=None)
    row_delta = world.publish(parent, "MATERIAL", exam_spec_version=None, node_ids=None)
    return {
        "name": "material: 子题先发布，材料后发布并回连子 item",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(parent.id),
        "options": {},
        "expected": {
            "ok": True,
            "snapshot": world.snapshot(parent),
            "row_delta": row_delta,
            "child_items": [
                {
                    "position_key": item.position_key,
                    "parent_position": None if item.parent_item_id is None else item.parent_item.position_key,
                    "is_scored": item.is_scored,
                }
                for item in PaperItem.objects.filter(revision=world.paper_revision).order_by("position_key")
            ],
        },
    }


def case_material_child_publish() -> dict:
    """Publishing the first child creates the material's draft version and points the parent at it."""
    world = World("material_child")
    world.base(with_paper=True)
    parent = world.make_candidate("MATERIAL", payload=material_payload("M2"), paper=True, position_key="4")
    child = world.make_candidate(
        "CHILD", payload=single_choice("M2.1"), parent=parent, paper=True, position_key="4.1"
    )
    row_delta = world.publish(child, "CHILD", exam_spec_version=None, node_ids=None)
    parent.refresh_from_db()
    parent_version = QuestionVersion.objects.get(id=parent.publication_version_id)
    world.symbols[str(parent_version.id)] = "V_MATERIAL"
    world.symbols[str(parent.publication_question_id)] = "Q_MATERIAL"
    return {
        "name": "material: 发布子题时预建材料草稿版本",
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(child.id),
        "options": {},
        "expected": {
            "ok": True,
            "snapshot": world.snapshot(child),
            "row_delta": row_delta,
            "parent": {
                "status": parent.status,
                "publication_question_id": world.sym(parent.publication_question_id),
                "publication_version_id": world.sym(parent.publication_version_id),
                "version_status": parent_version.status,
                "version_type": parent_version.question_type,
                "version_reason": parent_version.revision_reason,
                "practice_max_score": None
                if parent_version.practice_max_score is None
                else str(parent_version.practice_max_score),
                "children": [world.sym(value) for value in parent_version.material_child_version_ids],
            },
        },
    }


def _error_case(world: World, candidate: ImportCandidate, call, *, name: str, options: dict) -> dict:
    before = world.counts()
    try:
        call()
    except AcePassError as exc:
        expected = {
            "ok": False,
            "error": {
                "kind": "acepass",
                "class": type(exc).__name__,
                "code": exc.code,
                "status": exc.status_code,
                "message": exc.message,
                "details": jsonable(exc.details),
            },
            "row_delta": delta(before, world.counts()),
        }
    except ValidationError as exc:
        expected = {
            "ok": False,
            "error": {
                "kind": "django_validation",
                "class": type(exc).__name__,
                "status": 422,
                "message": "结构校验失败",
                "errors": jsonable(exc.message_dict if hasattr(exc, "message_dict") else exc.messages),
            },
            "row_delta": delta(before, world.counts()),
        }
    else:  # pragma: no cover - the case is chosen to fail
        raise AssertionError(f"{name}: expected the publication to be refused")
    return {
        "name": name,
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "target_candidate_id": str(candidate.id),
        "options": options,
        "expected": expected,
    }


def case_blocked() -> dict:
    world = World("blocked")
    world.base()
    payload = single_choice("B1", score="2.00")
    payload["answer_payload"] = {}
    candidate = world.make_candidate("TARGET", payload=payload)
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(candidate, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: 候选仍有 blocking issue",
        options={},
    )


def case_ignored() -> dict:
    world = World("ignored")
    world.base()
    candidate = world.make_candidate("TARGET", payload=single_choice("I1"))
    candidate.status = "ignored"
    candidate.save(update_fields=["status", "updated_at"])
    world.refresh(candidate)
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(candidate, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: 已忽略候选",
        options={},
    )


def case_bad_origin() -> dict:
    world = World("bad_origin")
    world.base()
    candidate = world.make_candidate("TARGET", payload=single_choice("B2"))
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(
            candidate, actor=world.owner, exam_spec_version=None, node_ids=None, origin_type="bogus"
        ),
        name="error: 非法来源类型",
        options={"origin_type": "bogus"},
    )


def case_three_nodes() -> dict:
    world = World("three_nodes")
    world.base()
    nodes = world.syllabus(["考点一", "考点二", "考点三"])
    candidate = world.make_candidate("TARGET", payload=single_choice("B3"))
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(
            candidate, actor=world.owner, exam_spec_version=None, node_ids=[str(n.id) for n in nodes]
        ),
        name="error: 三个考点等分权重合计不为 1",
        options={"node_ids": [str(n.id) for n in nodes]},
    )


def case_node_scope() -> dict:
    world = World("node_scope")
    world.base()
    other_subject = world.create(Subject, "subject_other", project=world.project, name="科目二")
    other_syllabus = world.create(
        SyllabusVersion, "syllabus_other", subject=other_subject, name="大纲二", version_label="v1"
    )
    other_node = world.create(
        KnowledgeNode, "node_other", syllabus_version=other_syllabus, canonical_name="别的考点"
    )
    candidate = world.make_candidate("TARGET", payload=single_choice("B4"))
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(
            candidate, actor=world.owner, exam_spec_version=None, node_ids=[str(other_node.id)]
        ),
        name="error: 考点属于别的科目",
        options={"node_ids": [str(other_node.id)]},
    )


def case_rubric_invalid() -> dict:
    world = World("rubric_invalid")
    world.base()
    criteria = [{"criterion_id": "c1", "text": "要点", "max_score": "3.00"}]
    candidate = world.make_candidate("TARGET", payload=constructed_response("B5", criteria, total="6.00"))
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(candidate, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: rubric 合计与总分不一致",
        options={},
    )


def case_blank_total() -> dict:
    world = World("blank_total")
    world.base()
    candidate = world.make_candidate("TARGET", payload=fill_blank("B6", score="4.00", blank_scores=("1.00", "1.00")))
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(candidate, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: 填空各空合计与题目分值不一致",
        options={},
    )


def case_no_score() -> dict:
    world = World("no_score")
    world.base()
    candidate = world.make_candidate("TARGET", payload=single_choice("B7", score=None))
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(candidate, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: 没有分值且没有规范默认值",
        options={},
    )


def case_paper_subject_mismatch() -> dict:
    world = World("paper_subject_mismatch")
    world.base(with_paper=True)
    other_subject = world.create(Subject, "subject_other", project=world.project, name="科目二")
    candidate = world.make_candidate(
        "TARGET", payload=single_choice("B8"), subject=other_subject, paper=True, position_key="9"
    )
    return _error_case(
        world,
        candidate,
        lambda: publish_candidate(candidate, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: 候选科目与试卷科目不一致（整事务回滚）",
        options={},
    )


def case_material_early() -> dict:
    world = World("material_early")
    world.base(with_paper=True)
    parent = world.make_candidate("MATERIAL", payload=material_payload("M3"), paper=True, position_key="5")
    world.make_candidate("CHILD", payload=single_choice("M3.1"), parent=parent, paper=True, position_key="5.1")
    return _error_case(
        world,
        parent,
        lambda: publish_candidate(parent, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: 材料题先于子题发布",
        options={},
    )


def case_duplicate_position() -> dict:
    world = World("duplicate_position")
    world.base(with_paper=True)
    first = world.make_candidate("FIRST", payload=single_choice("P3"), paper=True, position_key="7")
    world.publish(first, "FIRST", exam_spec_version=None, node_ids=None)
    second = world.make_candidate("TARGET", payload=single_choice("P4"), paper=True, position_key="7")
    case = _error_case(
        world,
        second,
        lambda: publish_candidate(second, actor=world.owner, exam_spec_version=None, node_ids=None),
        name="error: 同卷同号已有已发布版本",
        options={},
    )
    for problem in case["expected"]["error"]["details"]["problems"]:
        problem["question_id"] = world.sym(problem["question_id"])
        problem["question_version_id"] = world.sym(problem["question_version_id"])
    return case


# --------------------------------------------------------------------------
# publish_problems vectors
# --------------------------------------------------------------------------
def problem_case(name: str, build) -> dict:
    world = World(name)
    world.base(with_paper=True)
    version = build(world)
    return {
        "name": name,
        "rows": world.rows,
        "symbols": world.exported_symbols(),
        "steps": world.steps,
        "version_id": str(version.id),
        "expected": jsonable(publish_problems(version)),
    }


def _draft_version(world: World, question_type: str, content: dict, *, score="2.00", parent=None):
    question = world.create(
        Question, "question", subject=world.subject, origin_type="user_authored", is_demo=False, display_label=""
    )
    return world.create(
        QuestionVersion,
        "version",
        question=question,
        version=1,
        question_type=question_type,
        content=content,
        practice_max_score=Decimal(score) if score is not None else None,
        parent_material_version=parent,
        status="draft",
    )


def _answer(world: World, version, payload, *, checked=True, basis="人工校对确认（导入流程）"):
    return world.create(
        AnswerKeyVersion,
        "answer",
        question_version=version,
        version=1,
        answer_payload=payload,
        source_type="user",
        verification_status="checked" if checked else "pending",
        check_basis=basis,
        checked_at=world.now() if checked else None,
        explanation_blocks=[],
    )


SC_CONTENT = {
    "blocks": [{"kind": "text", "text": "题干"}],
    "options": [
        {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
        {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
    ],
}


def problems_matrix() -> list[dict]:
    cases: list[dict] = []

    def p_answer_missing(world):
        version = _draft_version(world, "single_choice", SC_CONTENT)
        return version

    def p_answer_pending(world):
        version = _draft_version(world, "single_choice", SC_CONTENT)
        _answer(world, version, {"kind": "single_choice", "correct_option_id": "opt_a"}, checked=False)
        return version

    def p_basis_missing(world):
        version = _draft_version(world, "single_choice", SC_CONTENT)
        _answer(world, version, {"kind": "single_choice", "correct_option_id": "opt_a"}, basis="")
        return version

    def p_answer_invalid(world):
        version = _draft_version(world, "single_choice", SC_CONTENT)
        _answer(world, version, {"kind": "single_choice", "correct_option_id": "opt_z"})
        return version

    def p_rubric_missing(world):
        version = _draft_version(world, "constructed_response", {"blocks": [{"kind": "text", "text": "题干"}]}, score="6.00")
        _answer(
            world,
            version,
            {"kind": "constructed_response", "reference_answer": "参考", "rubric_required": True},
        )
        return version

    def p_rubric_total(world):
        version = _draft_version(world, "constructed_response", {"blocks": [{"kind": "text", "text": "题干"}]}, score="6.00")
        answer = _answer(
            world,
            version,
            {"kind": "constructed_response", "reference_answer": "参考", "rubric_required": True},
        )
        world.create(
            RubricVersion,
            "rubric",
            answer_key_version=answer,
            version=1,
            criteria=[{"criterion_id": "c1", "text": "要点", "max_score": "3.00"}],
            total_score=Decimal("3.00"),
            checked_at=world.now(),
        )
        return version

    def p_rubric_invalid(world):
        version = _draft_version(world, "constructed_response", {"blocks": [{"kind": "text", "text": "题干"}]}, score="6.00")
        answer = _answer(
            world,
            version,
            {"kind": "constructed_response", "reference_answer": "参考", "rubric_required": True},
        )
        world.create(
            RubricVersion,
            "rubric",
            answer_key_version=answer,
            version=1,
            criteria=[{"criterion_id": "c1", "text": "要点", "max_score": "3.00"}],
            total_score=Decimal("6.00"),
            checked_at=world.now(),
        )
        return version

    def p_blank_total(world):
        version = _draft_version(
            world,
            "fill_blank",
            {
                "blocks": [{"kind": "text", "text": "填空"}],
                "blanks": [
                    {"blank_id": "b1", "max_score": "1.00"},
                    {"blank_id": "b2", "max_score": "1.00"},
                ],
            },
            score="4.00",
        )
        _answer(
            world,
            version,
            {
                "kind": "fill_blank",
                "blanks": {
                    "b1": {"accepted_values": ["甲"], "max_score": "1.00"},
                    "b2": {"accepted_values": ["乙"], "max_score": "1.00"},
                },
            },
        )
        return version

    def p_material_without_children(world):
        return _draft_version(world, "material", {"blocks": [{"kind": "text", "text": "材料"}], "options": []}, score=None)

    def p_material_mismatch(world):
        parent = _draft_version(
            world, "material", {"blocks": [{"kind": "text", "text": "材料"}], "options": []}, score=None
        )
        parent.material_child_version_ids = ["00000000-0000-0000-0000-000000000000"]
        parent.save(update_fields=["material_child_version_ids", "updated_at"])
        world.refresh(parent)
        return parent

    def p_material_child_scope(world):
        parent = _draft_version(
            world, "material", {"blocks": [{"kind": "text", "text": "材料"}], "options": []}, score=None
        )
        other_subject = world.create(Subject, "subject_other", project=world.project, name="科目二")
        child_question = world.create(
            Question, "child_question", subject=other_subject, origin_type="user_authored", is_demo=False, display_label=""
        )
        child = world.create(
            QuestionVersion,
            "child_version",
            question=child_question,
            version=1,
            question_type="single_choice",
            content=SC_CONTENT,
            practice_max_score=Decimal("2.00"),
            parent_material_version=parent,
            status="published",
        )
        parent.material_child_version_ids = [str(child.id)]
        parent.save(update_fields=["material_child_version_ids", "updated_at"])
        world.refresh(parent)
        world.refresh(child)
        return parent

    def p_ok_material(world):
        parent = _draft_version(
            world, "material", {"blocks": [{"kind": "text", "text": "材料"}], "options": []}, score=None
        )
        child = _draft_version(world, "single_choice", SC_CONTENT, parent=parent)
        child.status = "published"
        child.save(update_fields=["status", "updated_at"])
        parent.material_child_version_ids = [str(child.id)]
        parent.save(update_fields=["material_child_version_ids", "updated_at"])
        world.refresh(parent)
        world.refresh(child)
        return parent

    def p_ok_leaf(world):
        version = _draft_version(world, "single_choice", SC_CONTENT)
        _answer(world, version, {"kind": "single_choice", "correct_option_id": "opt_a"})
        return version

    for name, build in [
        ("problems: 缺少答案", p_answer_missing),
        ("problems: 答案未核对", p_answer_pending),
        ("problems: 核对依据为空", p_basis_missing),
        ("problems: 答案结构非法", p_answer_invalid),
        ("problems: 大题缺 rubric", p_rubric_missing),
        ("problems: rubric 总分不一致", p_rubric_total),
        ("problems: rubric 自身非法", p_rubric_invalid),
        ("problems: 填空分值合计不一致", p_blank_total),
        ("problems: 材料无子题", p_material_without_children),
        ("problems: 材料子题清单不一致", p_material_mismatch),
        ("problems: 材料子题跨科目", p_material_child_scope),
        ("problems: 材料完整", p_ok_material),
        ("problems: 叶子完整", p_ok_leaf),
    ]:
        cases.append(problem_case(name, build))
    return cases


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        publish_cases = [
            case_leaf(),
            case_two_nodes(),
            case_constructed(),
            case_fill_blank(),
            case_spec_default(),
            case_display_label(),
            case_long_label(),
            case_demo_origin(),
            case_already_published(),
            case_paper_item(),
            case_paper_fallback_position(),
            case_material(),
            case_material_child_publish(),
            case_blocked(),
            case_ignored(),
            case_bad_origin(),
            case_three_nodes(),
            case_node_scope(),
            case_rubric_invalid(),
            case_blank_total(),
            case_no_score(),
            case_paper_subject_mismatch(),
            case_material_early(),
            case_duplicate_position(),
        ]
        problems = problems_matrix()
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {"publish": publish_cases, "problems": problems}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT}: {len(publish_cases)} publish cases, {len(problems)} problem cases")
    for case in publish_cases:
        print(f"  publish  {case['name']}  ok={case['expected']['ok']}")
    for case in problems:
        print(f"  problems {case['name']}  n={len(case['expected'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
