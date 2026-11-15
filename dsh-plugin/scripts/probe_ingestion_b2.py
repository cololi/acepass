#!/usr/bin/env python
"""Empirical HTTP probe for O18 (`POST .../import-candidates/{id}/publish`).

Oracle: the real Django ingestion API driven through ``django.test.Client`` against a throw-away
PostgreSQL database. Nothing here asserts what the API *should* do; every case records the request,
the status code, the raw JSON, and the row deltas the call left behind.

The published write-set (question / version / answer / rubric / mappings / source links / paper
items) is dumped field by field, with generated identifiers replaced by symbolic names and the
publish instant replaced by ``"<now>"`` so the same facts can be replayed in SQLite.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_ingestion_b2.py

Writes ``docs/dsh-migration/11-ingestion-b2-probe.json`` only; the markdown report is written by
hand from that evidence.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
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
from django.utils import timezone as dj_timezone  # noqa: E402

from apps.audit.models import ContentRevision, IdempotencyRecord, OutboxEvent  # noqa: E402
from apps.exams import services as exams_services  # noqa: E402
from apps.exams.models import ExamProject, ExamSpecVersion, Paper, PaperItem, PaperRevision, Subject  # noqa: E402
from apps.ingestion.models import ImportCandidate, ImportJob, SourceDocument, SourceRegion  # noqa: E402
from apps.ingestion.services import core as ingestion_core  # noqa: E402
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge  # noqa: E402
from apps.exams.models import SyllabusVersion  # noqa: E402
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionSourceLink,
    QuestionVersion,
    RubricVersion,
)

OUT_JSON = ROOT / "docs" / "dsh-migration" / "11-ingestion-b2-probe.json"

BASE = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)

UNSET = object()
CASES: list[dict] = []
SYMBOLS: dict[str, str] = {}
CLIENT = Client()


# ---------------------------------------------------------------------------
# Recording helpers
# ---------------------------------------------------------------------------
def reg(name: str, value) -> str:
    text = str(getattr(value, "id", value))
    SYMBOLS[text] = name
    return text


def sym(value) -> str | None:
    if value is None:
        return None
    return SYMBOLS.get(str(value), f"<unknown:{str(value)[:8]}>")


def _key_repr(key) -> object:
    if key is UNSET:
        return None
    if len(key) > 30:
        return {"length": len(key), "prefix": key[:8]}
    return key


def call(
    case_id: str,
    title: str,
    *,
    body: object = None,
    key=UNSET,
    method: str = "post",
    path: str,
    kind: str = "case",
) -> dict:
    headers: dict[str, str] = {}
    if key is not UNSET:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    data = json.dumps(body, ensure_ascii=False) if body is not None else None
    if data is not None:
        headers["content_type"] = "application/json"
    method_fn = getattr(CLIENT, method)
    response = method_fn(path, data=data, **headers) if data is not None else method_fn(path, **headers)
    raw = response.content.decode("utf-8", "replace")
    try:
        payload = response.json()
    except Exception:  # pragma: no cover - every endpoint here returns JSON
        payload = None
    record = {
        "case": case_id,
        "op": "O18",
        "kind": kind,
        "title": title,
        "request": {
            "method": method.upper(),
            "path": path,
            "body": body,
            "idempotency_key": _key_repr(key),
        },
        "status": response.status_code,
        "response": payload,
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


def db_counts() -> dict:
    return {
        "audit_content_revision": ContentRevision.objects.count(),
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "question_bank_question": Question.objects.count(),
        "question_bank_question_version": QuestionVersion.objects.count(),
        "question_bank_answer_key_version": AnswerKeyVersion.objects.count(),
        "question_bank_rubric_version": RubricVersion.objects.count(),
        "question_bank_source_link": QuestionSourceLink.objects.count(),
        "knowledge_question_mapping": QuestionKnowledge.objects.count(),
        "exams_paper_item": PaperItem.objects.count(),
        "ingestion_import_candidate": ImportCandidate.objects.count(),
    }


def delta(before: dict, after: dict) -> dict:
    return {name: after[name] - before[name] for name in before if after[name] != before[name]}


def _d(value):
    return None if value is None else str(value)


def _iso(value):
    return None if value is None else value.isoformat()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def valid_payload(
    label: str,
    *,
    question_type: str = "single_choice",
    practice_max_score="2.00",
    answer_payload: dict | None = None,
    content: dict | None = None,
    display_label: str = "",
    estimated_seconds=None,
    rubric_criteria=None,
    rubric_total_score=None,
    check_basis: str | None = None,
    answer_source_type: str | None = None,
    explanation_blocks=None,
) -> dict:
    if content is None:
        content = {
            "blocks": [{"kind": "text", "text": f"{label}的题干"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        }
    if answer_payload is None:
        answer_payload = {"kind": "single_choice", "correct_option_id": "opt_a"}
    payload = {
        "question_type": question_type,
        "display_label": display_label,
        "content": content,
        "answer_payload": answer_payload,
        "answer_status_known": True,
        "explanation_blocks": explanation_blocks or [],
        "practice_max_score": practice_max_score,
        "source_excerpt": f"{label}的题干",
        "parse_issues": [],
        "structure_signals": ["stem", "options", "answer"],
    }
    if estimated_seconds is not None:
        payload["estimated_seconds"] = estimated_seconds
    if rubric_criteria is not None:
        payload["rubric_criteria"] = rubric_criteria
    if rubric_total_score is not None:
        payload["rubric_total_score"] = rubric_total_score
    if check_basis is not None:
        payload["check_basis"] = check_basis
    if answer_source_type is not None:
        payload["answer_source_type"] = answer_source_type
    return payload


def make_job(owner, project: ExamProject, subject: Subject | None, label: str, *, input_kind: str = "text") -> ImportJob:
    job = ImportJob.objects.create(
        project=project,
        subject=subject,
        created_by=owner,
        status="awaiting_review",
        input_kind=input_kind,
        input_text=f"fixture:{label}",
        extractor_version="text-structure-v1",
        input_fingerprint=hashlib.sha256(f"fixture:{label}".encode("utf-8")).hexdigest(),
    )
    reg(f"JOB_{label}", job)
    return job


def make_candidate(
    owner,
    project: ExamProject,
    subject: Subject | None,
    label: str,
    *,
    payload: dict | None = None,
    parent: ImportCandidate | None = None,
    paper_revision: PaperRevision | None = None,
    position_key: str = "",
    document: SourceDocument | None = None,
    with_region: bool = True,
    job: ImportJob | None = None,
) -> ImportCandidate:
    job = job or make_job(owner, project, subject, label)
    payload = payload if payload is not None else valid_payload(label)
    candidate = ImportCandidate.objects.create(
        job=job,
        project=project,
        subject=subject,
        parent_candidate=parent,
        source_position_key=position_key,
        paper_revision=paper_revision,
        status="draft",
        draft_payload=payload,
        machine_payload=payload,
        revision=1,
        extractor_version="text-structure-v1",
    )
    reg(f"CAND_{label}", candidate)
    if with_region:
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
        reg(f"REGION_{label}", region)
    ingestion_core.refresh_candidate_issues(candidate)
    candidate.refresh_from_db()
    return candidate


def publish_path(project: ExamProject, candidate: ImportCandidate) -> str:
    return f"/api/v1/projects/{project.id}/import-candidates/{candidate.id}/publish"


def write_set(candidate: ImportCandidate) -> dict:
    """The rows one publication left behind, with ids replaced by symbolic names."""
    candidate.refresh_from_db()
    question = None
    version = None
    if candidate.publication_question_id:
        question = Question.objects.filter(id=candidate.publication_question_id).first()
    if candidate.publication_version_id:
        version = QuestionVersion.objects.filter(id=candidate.publication_version_id).first()
    answer = None
    rubric = None
    links: list[dict] = []
    mappings: list[dict] = []
    items: list[dict] = []
    if version is not None:
        answer = AnswerKeyVersion.objects.filter(question_version=version).order_by("-version").first()
    # Stable symbolic names for the rows this publication created, so the write-set dump does not
    # depend on random UUIDs.
    label = SYMBOLS.get(str(candidate.id), str(candidate.id)[:8])
    if question is not None:
        SYMBOLS.setdefault(str(question.id), f"QUESTION_OF_{label}")
    if version is not None:
        SYMBOLS.setdefault(str(version.id), f"VERSION_OF_{label}")
    if answer is not None:
        SYMBOLS.setdefault(str(answer.id), f"ANSWER_OF_{label}")
    if candidate.publication_paper_item_id:
        SYMBOLS.setdefault(str(candidate.publication_paper_item_id), f"PAPER_ITEM_OF_{label}")
    if version is not None and version.parent_material_version_id and candidate.parent_candidate_id:
        parent_label = SYMBOLS.get(str(candidate.parent_candidate_id), str(candidate.parent_candidate_id)[:8])
        SYMBOLS.setdefault(str(version.parent_material_version_id), f"VERSION_OF_{parent_label}")
    if version is not None:
        rubric = RubricVersion.objects.filter(answer_key_version=answer).first() if answer else None
        links = [
            {
                "role": link.role,
                "region": SYMBOLS.get(str(link.region_id), "<region:this-candidate>"),
                "note": link.note,
            }
            for link in QuestionSourceLink.objects.filter(question_version=version).order_by("created_at")
        ]
        mappings = [
            {
                "mapping_revision": row.mapping_revision,
                "node": sym(row.node_id),
                "is_primary": row.is_primary,
                "score_weight": str(row.score_weight),
                "template_id": sym(row.template_id),
                "note": row.note,
            }
            for row in QuestionKnowledge.objects.filter(question_version=version).order_by(
                "mapping_revision", "node__canonical_name"
            )
        ]
        items = [
            {
                "position_key": item.position_key,
                "parent_item_position": None if item.parent_item_id is None else item.parent_item.position_key,
                "question_version_is_self": str(item.question_version_id) == str(version.id),
                "answer_key_version": sym(item.answer_key_version_id),
                "max_score": str(item.max_score),
                "is_scored": item.is_scored,
                "is_demo": item.is_demo,
                "revision_is_candidate_paper": item.revision_id == candidate.paper_revision_id,
            }
            for item in PaperItem.objects.filter(question_version=version).order_by("position_key")
        ]
    return {
        "candidate": {
            "status": candidate.status,
            "revision": candidate.revision,
            "publication_question_id": sym(candidate.publication_question_id),
            "publication_version_id": sym(candidate.publication_version_id),
            "publication_paper_item_id": sym(candidate.publication_paper_item_id),
            "reviewed_at": _iso(candidate.reviewed_at),
        },
        "question": None
        if question is None
        else {
            "origin_type": question.origin_type,
            "is_demo": question.is_demo,
            "display_label": question.display_label,
            "current_published_version_is_self": str(question.current_published_version_id) == str(version.id)
            if version is not None
            else False,
            "family_id": sym(question.family_id),
            "content_lineage_id": sym(question.content_lineage_id),
        },
        "version": None
        if version is None
        else {
            "version": version.version,
            "question_type": version.question_type,
            "status": version.status,
            "practice_max_score": _d(version.practice_max_score),
            "estimated_seconds": version.estimated_seconds,
            "revision_reason": version.revision_reason,
            "source_note": version.source_note,
            "parent_material_version": sym(version.parent_material_version_id),
            "material_child_version_ids": [sym(value) for value in (version.material_child_version_ids or [])],
            "content": version.content,
            "content_digest_length": len(version.content_digest or ""),
            "published_at_is_now": version.published_at is not None,
        },
        "answer": None
        if answer is None
        else {
            "version": answer.version,
            "answer_payload": answer.answer_payload,
            "source_type": answer.source_type,
            "verification_status": answer.verification_status,
            "check_basis": answer.check_basis,
            "checked": answer.checked_at is not None,
            "checked_by_is_actor": answer.checked_by_id is not None,
            "source_region": sym(answer.source_region_id),
            "explanation_blocks": answer.explanation_blocks,
            "supersedes": sym(answer.supersedes_id),
            "is_disputed": answer.is_disputed,
        },
        "rubric": None
        if rubric is None
        else {
            "version": rubric.version,
            "criteria": rubric.criteria,
            "total_score": str(rubric.total_score),
            "usage_note": rubric.usage_note,
            "checked": rubric.checked_at is not None,
        },
        "source_links": links,
        "mappings": mappings,
        "paper_items": items,
        "audit_actions": [
            {"entity_type": row.entity_type, "action": row.action}
            for row in ContentRevision.objects.filter(
                entity_id__in=[str(value) for value in (version.id if version else None, answer.id if answer else None) if value]
            ).order_by("created_at")
        ],
    }


def outbox_rows() -> list[dict]:
    return [
        {
            "topic": event.topic,
            "payload": event.payload,
            "dedupe_key": event.dedupe_key,
            "status": event.status,
        }
        for event in OutboxEvent.objects.order_by("created_at")
    ]


# ---------------------------------------------------------------------------
# Probe body
# ---------------------------------------------------------------------------
def build() -> dict:
    user_model = get_user_model()
    owner = user_model.objects.create_user(
        email="b2-probe-owner@example.test", password="ProbePass!2026", display_name="B2 探针"
    )
    other = user_model.objects.create_user(
        email="b2-probe-other@example.test", password="ProbePass!2026", display_name="另一位"
    )
    project_a = exams_services.create_project(owner, name="B2 探针项目A")
    project_b = exams_services.create_project(other, name="B2 探针项目B")
    subject_a1 = exams_services.create_subject(project_a, name="科目A1", total_score="100", pass_score="60")
    subject_a2 = exams_services.create_subject(project_a, name="科目A2", total_score="100", pass_score="60")
    subject_b1 = exams_services.create_subject(project_b, name="科目B1", total_score="100", pass_score="60")

    spec_rules = {
        "single_choice": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
        "multiple_choice": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
        "true_false": {"default_max_score": "1.00", "wrong_score": "0.00", "blank_score": "0.00"},
        "fill_blank": {"default_max_score": "4.00", "wrong_score": "0.00", "blank_score": "0.00"},
        "constructed_response": {"default_max_score": "6.00", "wrong_score": "0.00", "blank_score": "0.00"},
    }
    spec = exams_services.create_exam_spec_version(
        subject_a1,
        created_by=owner,
        name="A1 规范",
        question_type_rules=spec_rules,
        status="published",
        published_at=dj_timezone.now(),
    )
    draft_spec = exams_services.create_exam_spec_version(
        subject_a1,
        created_by=owner,
        name="A1 草稿规范",
        question_type_rules={"single_choice": {"default_max_score": "2.00"}},
        status="draft",
    )
    spec_a2 = exams_services.create_exam_spec_version(
        subject_a2,
        created_by=owner,
        name="A2 规范",
        question_type_rules={"single_choice": {"default_max_score": "2.00"}},
        status="published",
        published_at=dj_timezone.now(),
    )

    syllabus = SyllabusVersion.objects.create(subject=subject_a1, name="A1 大纲", version_label="v1")
    node1 = KnowledgeNode.objects.create(syllabus_version=syllabus, canonical_name="考点一")
    node2 = KnowledgeNode.objects.create(syllabus_version=syllabus, canonical_name="考点二")
    node3 = KnowledgeNode.objects.create(syllabus_version=syllabus, canonical_name="考点三")
    syllabus_a2 = SyllabusVersion.objects.create(subject=subject_a2, name="A2 大纲", version_label="v1")
    node_a2 = KnowledgeNode.objects.create(syllabus_version=syllabus_a2, canonical_name="A2 考点")

    document = SourceDocument.objects.create(
        owner=owner,
        project=project_a,
        subject=subject_a1,
        title="B2 探针来源文档",
        document_type="text",
        role="past_paper_page",
        sensitivity="public_to_owner",
        raw_text="B2 探针来源文本",
        checksum=hashlib.sha256(b"b2-probe").hexdigest(),
        source_type="user_paste",
        page_count=1,
    )

    paper = Paper.objects.create(
        subject=subject_a1,
        cycle_key="2025",
        session_key="上半年",
        paper_code="卷一",
        title="B2 探针试卷",
        source_kind="official_past",
        is_demo=False,
    )
    paper_revision = exams_services.create_paper_revision(paper, actor=owner)
    paper2 = Paper.objects.create(
        subject=subject_a1,
        cycle_key="2025",
        session_key="下半年",
        paper_code="卷二",
        title="B2 探针试卷二",
        source_kind="official_past",
        is_demo=False,
    )
    paper_revision2 = exams_services.create_paper_revision(paper2, actor=owner)

    for name, value in {
        "USER_OWNER": owner,
        "USER_OTHER": other,
        "PROJECT_A": project_a,
        "PROJECT_B": project_b,
        "SUBJECT_A1": subject_a1,
        "SUBJECT_A2": subject_a2,
        "SUBJECT_B1": subject_b1,
        "SPEC_A1": spec,
        "SPEC_A1_DRAFT": draft_spec,
        "SPEC_A2": spec_a2,
        "SYLLABUS_A1": syllabus,
        "NODE_1": node1,
        "NODE_2": node2,
        "NODE_3": node3,
        "NODE_A2": node_a2,
        "DOCUMENT": document,
        "PAPER": paper,
        "PAPER_REVISION": paper_revision,
        "PAPER2": paper2,
        "PAPER_REVISION2": paper_revision2,
    }.items():
        reg(name, value)

    CLIENT.force_login(owner)
    p_a = f"/api/v1/projects/{project_a.id}"
    p_b = f"/api/v1/projects/{project_b.id}"

    # ------------------------------------------------------------------ P01
    candidate = make_candidate(
        owner, project_a, subject_a1, "P01", payload=valid_payload("P01"), document=document
    )
    reg("CAND_P01", candidate)
    before = db_counts()
    record = call("P01", "发布一个已校对完成的单选候选", body={}, key="b2-publish-ok", path=publish_path(project_a, candidate))
    stored = IdempotencyRecord.objects.filter(idempotency_key="b2-publish-ok").first()
    checks(
        record,
        response_has_question_id="question_id" in (record["response"] or {}),
        stored_body_has_question_id=bool(stored and "question_id" in (stored.response_body or {})),
        stored_body_keys=sorted(stored.response_body) if stored else None,
        stored_resource_type=None if stored is None else stored.resource_type,
        write_set=write_set(candidate),
        outbox=outbox_rows(),
        row_delta=delta(before, db_counts()),
    )

    # ------------------------------------------------------------------ P02 replay
    before = db_counts()
    record = call(
        "P02", "相同幂等键与相同 body 重放", body={}, key="b2-publish-ok", path=publish_path(project_a, candidate)
    )
    checks(record, same_body_as_P01=record["response"] == CASES[0]["response"], row_delta=delta(before, db_counts()))

    # ------------------------------------------------------------------ P03 same key, different body
    before = db_counts()
    record = call(
        "P03",
        "相同幂等键但 body 不同",
        body={"origin_type": "demo"},
        key="b2-publish-ok",
        path=publish_path(project_a, candidate),
    )
    checks(record, row_delta=delta(before, db_counts()))

    # ------------------------------------------------------------------ P04 publish again, fresh key
    before = db_counts()
    record = call(
        "P04",
        "已发布候选再用新键发布",
        body={},
        key="b2-publish-again",
        path=publish_path(project_a, candidate),
    )
    checks(record, write_set=write_set(candidate), row_delta=delta(before, db_counts()))

    # ------------------------------------------------------------------ P05 ignored
    ignored = make_candidate(owner, project_a, subject_a1, "P05", document=document)
    ignored.status = "ignored"
    ignored.save(update_fields=["status", "updated_at"])
    record = call("P05", "已忽略候选不能发布", body={}, key="b2-publish-ignored", path=publish_path(project_a, ignored))

    # ------------------------------------------------------------------ P06 blocked
    blocked = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P06",
        payload=valid_payload("P06", answer_payload={}, practice_max_score="2.00"),
        document=document,
    )
    blocked.refresh_from_db()
    record = call("P06", "仍有 blocking issue 的候选", body={}, key="b2-publish-blocked", path=publish_path(project_a, blocked))

    # ------------------------------------------------------------------ P07 foreign candidate
    foreign = make_candidate(other, project_b, subject_b1, "P07", with_region=False)
    record = call("P07", "别的项目的候选", body={}, key="b2-publish-foreign", path=publish_path(project_a, foreign))

    # ------------------------------------------------------------------ P08 unknown spec
    candidate08 = make_candidate(owner, project_a, subject_a1, "P08", document=document)
    record = call(
        "P08",
        "不存在的考试规范版本",
        body={"exam_spec_version_id": "00000000-0000-0000-0000-000000000000"},
        key="b2-publish-spec-missing",
        path=publish_path(project_a, candidate08),
    )
    # ------------------------------------------------------------------ P09 draft spec
    candidate09 = make_candidate(owner, project_a, subject_a1, "P09", document=document)
    record = call(
        "P09",
        "未发布的考试规范版本",
        body={"exam_spec_version_id": str(draft_spec.id)},
        key="b2-publish-spec-draft",
        path=publish_path(project_a, candidate09),
    )
    # ------------------------------------------------------------------ P10 spec from another project
    candidate10 = make_candidate(owner, project_a, subject_a1, "P10", document=document)
    record = call(
        "P10",
        "同项目另一科目的已发布规范（不校验同科目）",
        body={"exam_spec_version_id": str(spec_a2.id)},
        key="b2-publish-spec-other-subject",
        path=publish_path(project_a, candidate10),
    )
    # ------------------------------------------------------------------ P11 invalid origin
    candidate11 = make_candidate(owner, project_a, subject_a1, "P11", document=document)
    before = db_counts()
    record = call(
        "P11",
        "非法题目来源类型",
        body={"origin_type": "bogus_origin"},
        key="b2-publish-bad-origin",
        path=publish_path(project_a, candidate11),
    )
    checks(record, row_delta=delta(before, db_counts()), write_set=write_set(candidate11))
    # ------------------------------------------------------------------ P12 spec default adopted
    candidate12 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P12",
        payload=valid_payload("P12", practice_max_score=None),
        document=document,
    )
    record = call(
        "P12",
        "未声明分值时采用规范默认分值",
        body={"exam_spec_version_id": str(spec.id)},
        key="b2-publish-spec-default",
        path=publish_path(project_a, candidate12),
    )
    checks(record, write_set=write_set(candidate12))

    # ------------------------------------------------------------------ P13 one node
    candidate13 = make_candidate(owner, project_a, subject_a1, "P13", document=document)
    record = call(
        "P13",
        "映射到一个考点",
        body={"node_ids": [str(node1.id)]},
        key="b2-publish-one-node",
        path=publish_path(project_a, candidate13),
    )
    checks(record, write_set=write_set(candidate13))

    # ------------------------------------------------------------------ P14 two nodes
    candidate14 = make_candidate(owner, project_a, subject_a1, "P14", document=document)
    record = call(
        "P14",
        "映射到两个考点（等分）",
        body={"node_ids": [str(node1.id), str(node2.id)]},
        key="b2-publish-two-nodes",
        path=publish_path(project_a, candidate14),
    )
    checks(record, write_set=write_set(candidate14))

    # ------------------------------------------------------------------ P15 three nodes (Decimal 1/3)
    candidate15 = make_candidate(owner, project_a, subject_a1, "P15", document=document)
    before = db_counts()
    record = call(
        "P15",
        "映射到三个考点（Decimal 1/3 权重和）",
        body={"node_ids": [str(node1.id), str(node2.id), str(node3.id)]},
        key="b2-publish-three-nodes",
        path=publish_path(project_a, candidate15),
    )
    checks(record, row_delta=delta(before, db_counts()), write_set=write_set(candidate15))

    # ------------------------------------------------------------------ P16 node from another subject
    candidate16 = make_candidate(owner, project_a, subject_a1, "P16", document=document)
    before = db_counts()
    record = call(
        "P16",
        "考点属于别的科目大纲",
        body={"node_ids": [str(node_a2.id)]},
        key="b2-publish-node-scope",
        path=publish_path(project_a, candidate16),
    )
    checks(record, row_delta=delta(before, db_counts()), write_set=write_set(candidate16))

    # ------------------------------------------------------------------ P17 constructed response
    criteria = [
        {"criterion_id": "c1", "text": "要点一", "max_score": "4.00"},
        {"criterion_id": "c2", "text": "要点二", "max_score": "2.00", "depends_on": ["c1"]},
    ]
    candidate17 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P17",
        payload=valid_payload(
            "P17",
            question_type="constructed_response",
            practice_max_score="6.00",
            answer_payload={
                "kind": "constructed_response",
                "reference_answer": "参考答案",
                "rubric_required": True,
            },
            rubric_criteria=criteria,
            rubric_total_score="6.00",
            check_basis="与官方答案核对一致",
            answer_source_type="official",
            explanation_blocks=[{"kind": "text", "text": "解析"}],
        ),
        document=document,
    )
    record = call("P17", "大题：答案+rubric 一并写入", body={}, key="b2-publish-constructed", path=publish_path(project_a, candidate17))
    checks(record, write_set=write_set(candidate17))

    # ------------------------------------------------------------------ P18 rubric total mismatch
    candidate18 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P18",
        payload=valid_payload(
            "P18",
            question_type="constructed_response",
            practice_max_score="6.00",
            answer_payload={
                "kind": "constructed_response",
                "reference_answer": "参考答案",
                "rubric_required": True,
            },
            rubric_criteria=[{"criterion_id": "c1", "text": "要点一", "max_score": "3.00"}],
            rubric_total_score="6.00",
        ),
        document=document,
    )
    before = db_counts()
    record = call("P18", "rubric 合计与总分不一致", body={}, key="b2-publish-rubric-invalid", path=publish_path(project_a, candidate18))
    checks(record, row_delta=delta(before, db_counts()))

    # ------------------------------------------------------------------ P19 fill blank mismatch
    candidate19 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P19",
        payload=valid_payload(
            "P19",
            question_type="fill_blank",
            practice_max_score="4.00",
            content={
                "blocks": [{"kind": "text", "text": "P19 填空"}],
                "blanks": [
                    {"blank_id": "b1", "max_score": "1.00"},
                    {"blank_id": "b2", "max_score": "1.00"},
                ],
            },
            answer_payload={
                "kind": "fill_blank",
                "blanks": {
                    "b1": {"accepted_values": ["甲"], "max_score": "1.00"},
                    "b2": {"accepted_values": ["乙"], "max_score": "1.00"},
                },
            },
        ),
        document=document,
    )
    record = call("P19", "填空各空分值与题目分值不一致", body={}, key="b2-publish-blank-total", path=publish_path(project_a, candidate19))

    # ------------------------------------------------------------------ P20 paper candidate
    candidate20 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P20",
        payload=valid_payload("P20", practice_max_score="2.00"),
        paper_revision=paper_revision,
        position_key="1",
        document=document,
    )
    before = db_counts()
    record = call("P20", "真实试卷候选：写 PaperItem", body={}, key="b2-publish-paper-item", path=publish_path(project_a, candidate20))
    checks(record, write_set=write_set(candidate20), outbox=outbox_rows(), row_delta=delta(before, db_counts()))

    # ------------------------------------------------------------------ P21 duplicate paper position
    candidate21 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P21",
        payload=valid_payload("P21", practice_max_score="2.00"),
        paper_revision=paper_revision,
        position_key="1",
        document=document,
    )
    record = call("P21", "同一试卷版本重复卷面号", body={}, key="b2-publish-duplicate-position", path=publish_path(project_a, candidate21))

    # ------------------------------------------------------------------ P22 subject mismatch on paper
    candidate22 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P22",
        payload=valid_payload("P22", practice_max_score="2.00"),
        paper_revision=paper_revision,
        position_key="2",
        document=document,
    )
    candidate22.subject = subject_a2
    candidate22.save(update_fields=["subject", "updated_at"])
    before = db_counts()
    record = call("P22", "候选科目与试卷科目不一致（整事务回滚）", body={}, key="b2-publish-subject-mismatch", path=publish_path(project_a, candidate22))
    checks(record, row_delta=delta(before, db_counts()), write_set=write_set(candidate22))

    # ------------------------------------------------------------------ P23/P24 material children first, then material
    parent_payload = valid_payload(
        "P23M",
        question_type="material",
        content={"blocks": [{"kind": "text", "text": "共享材料"}], "options": []},
        answer_payload={},
    )
    material = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P23M",
        payload=parent_payload,
        paper_revision=paper_revision,
        position_key="3",
        document=document,
    )
    child1 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P23C1",
        payload=valid_payload("P23C1", practice_max_score="2.00"),
        parent=material,
        paper_revision=paper_revision,
        position_key="3.1",
        document=document,
    )
    child2 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P23C2",
        payload=valid_payload("P23C2", practice_max_score="2.00"),
        parent=material,
        paper_revision=paper_revision,
        position_key="3.2",
        document=document,
    )
    reg("CAND_MATERIAL", material)
    reg("CAND_CHILD1", child1)
    reg("CAND_CHILD2", child2)

    # Material before its children: must be refused and leave nothing behind.
    before = db_counts()
    record = call("P23", "材料题先于子题发布", body={}, key="b2-publish-material-early", path=publish_path(project_a, material))
    checks(record, row_delta=delta(before, db_counts()))

    before = db_counts()
    record = call("P24", "先发布材料题的第一个子题", body={}, key="b2-publish-child1", path=publish_path(project_a, child1))
    checks(record, write_set=write_set(child1), row_delta=delta(before, db_counts()))

    record = call("P25", "发布第二个子题", body={}, key="b2-publish-child2", path=publish_path(project_a, child2))
    checks(record, write_set=write_set(child2))

    before = db_counts()
    record = call("P26", "子题都发布后发布材料题", body={}, key="b2-publish-material", path=publish_path(project_a, material))
    checks(record, write_set=write_set(material), row_delta=delta(before, db_counts()))

    # ------------------------------------------------------------------ P27 ai_variant forced origin
    variant_job = make_job(owner, project_a, subject_a1, "P27", input_kind="ai_variant")
    variant = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P27",
        payload=valid_payload("P27", practice_max_score="2.00"),
        document=document,
        job=variant_job,
    )
    record = call(
        "P27",
        "ai_variant 任务强制 ai_generated 来源",
        body={"origin_type": "user_authored"},
        key="b2-publish-ai-variant",
        path=publish_path(project_a, variant),
    )
    checks(record, write_set=write_set(variant))

    # ------------------------------------------------------------------ P28 display label & estimated seconds
    candidate28 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P28",
        payload=valid_payload("P28", practice_max_score="2.00", display_label="payload 标签", estimated_seconds=90),
        document=document,
    )
    record = call(
        "P28",
        "请求 display_label 优先于 payload；estimated_seconds 落库",
        body={"display_label": "请求标签"},
        key="b2-publish-label",
        path=publish_path(project_a, candidate28),
    )
    checks(record, write_set=write_set(candidate28))

    # ------------------------------------------------------------------ P29 empty body / no idempotency key
    candidate29 = make_candidate(owner, project_a, subject_a1, "P29", document=document)
    record = call("P29", "缺少 Idempotency-Key", body={}, path=publish_path(project_a, candidate29))

    # ------------------------------------------------------------------ P30 spec validation before key
    record = call(
        "P30",
        "规范不存在且缺少幂等键：先报 404",
        body={"exam_spec_version_id": "00000000-0000-0000-0000-000000000000"},
        path=publish_path(project_a, candidate29),
    )

    # ------------------------------------------------------------------ P31 payload not an object
    record = call("P31", "body 是数组", body=[1, 2], key="b2-publish-array-body", path=publish_path(project_a, candidate29))

    # ------------------------------------------------------------------ P32 estimated_seconds null
    candidate32 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P32",
        payload=valid_payload("P32", practice_max_score="2.00"),
        document=document,
    )
    record = call("P32", "estimated_seconds 缺省为 null", body={}, key="b2-publish-estimated-null", path=publish_path(project_a, candidate32))
    checks(record, write_set=write_set(candidate32))

    # ------------------------------------------------------------------ P33 second paper, position fallback
    candidate33 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P33",
        payload=valid_payload("P33", practice_max_score="2.00", display_label="卷面标签"),
        paper_revision=paper_revision2,
        position_key="",
        document=document,
    )
    record = call("P33", "无 source_position_key 时用 payload.display_label", body={}, key="b2-publish-position-fallback", path=publish_path(project_a, candidate33))
    checks(record, write_set=write_set(candidate33))

    # ------------------------------------------------------------------ P34 demo origin
    candidate34 = make_candidate(owner, project_a, subject_a1, "P34", document=document)
    record = call(
        "P34",
        "origin_type=demo 时 is_demo=true",
        body={"origin_type": "demo"},
        key="b2-publish-demo-origin",
        path=publish_path(project_a, candidate34),
    )
    checks(record, write_set=write_set(candidate34))

    # ------------------------------------------------------------------ P35 label truncation
    candidate35 = make_candidate(
        owner,
        project_a,
        subject_a1,
        "P35",
        payload=valid_payload("P35", display_label="长" * 250),
        document=document,
    )
    record = call("P35", "display_label 超过 200 字符被截断", body={}, key="b2-publish-long-label", path=publish_path(project_a, candidate35))
    candidate35.refresh_from_db()
    published_label = (
        Question.objects.get(id=candidate35.publication_question_id).display_label
        if candidate35.publication_question_id
        else ""
    )
    checks(record, write_set=write_set(candidate35), published_label_length=len(published_label))

    # ------------------------------------------------------------------ P36-P40 schema shapes
    candidate36 = make_candidate(owner, project_a, subject_a1, "P36", document=document)
    record = call("P36", "node_ids 是字符串", body={"node_ids": "abc"}, key="b2-schema-node-ids", path=publish_path(project_a, candidate36))
    record = call("P37", "node_ids 里有非字符串", body={"node_ids": [1]}, key="b2-schema-node-item", path=publish_path(project_a, candidate36))
    record = call("P38", "origin_type 不是字符串", body={"origin_type": 123}, key="b2-schema-origin", path=publish_path(project_a, candidate36))
    record = call("P39", "display_label 是 null", body={"display_label": None}, key="b2-schema-label", path=publish_path(project_a, candidate36))
    record = call(
        "P40",
        "exam_spec_version_id 不是字符串",
        body={"exam_spec_version_id": 123},
        key="b2-schema-spec",
        path=publish_path(project_a, candidate36),
    )

    return {
        "cases": CASES,
        "symbols": SYMBOLS,
        "fixtures": {
            "paper_item_count": PaperItem.objects.count(),
            "paper_items": [
                {
                    "paper": sym(item.revision.paper_id),
                    "revision": item.revision.revision,
                    "position_key": item.position_key,
                    "parent_position": None if item.parent_item_id is None else item.parent_item.position_key,
                    "is_scored": item.is_scored,
                    "max_score": str(item.max_score),
                }
                for item in PaperItem.objects.order_by("revision_id", "position_key")
            ],
            "jobs": [
                {"job": sym(job.id), "status": job.status, "candidate_statuses": list(job.candidates.values_list("status", flat=True))}
                for job in ImportJob.objects.order_by("created_at")
            ],
        },
    }


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        payload = build()
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT_JSON} ({len(payload['cases'])} cases)")
    for case in payload["cases"]:
        print(f"  {case['case']:>4} {case['status']}  {case['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
