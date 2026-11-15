#!/usr/bin/env python
"""Golden vectors for B5: AI variant rules, independent checks, review issues and serializers.

Oracle: the *real* functions in `backend/apps/question_bank/services/variants.py` executed against
**real PostgreSQL rows** in a throw-away test database:

* `_answer_consistency_problems` (`:165`)
* `_proposed_score` (`:539`)
* `_draft_payload` (`:580`)
* `independent_checks` (`:397`)
* `variant_review_issues` (`:482`)
* `variant_job_summary` / `variant_candidate_summary` (`:645`, `:673`)

Nothing here re-implements a rule: every `expected` block is what Django returned. Rows are seeded
with `uuid5` identities and `BASE + n minutes` timestamps, so a rerun is byte-identical; the Node
test seeds the same rows into SQLite and replays the same calls.

`propose_variants` (`:703`) is *not* in this fixture: it creates random `uuid4` job/candidate ids,
which would break the byte-identical rule. Its end-to-end behaviour is pinned by the Node HTTP
tests (with an injected fake LlmPort) and by `scripts/probe_ingestion_b5.py` against real Django.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_ingestion_b5_variants_golden.py
"""

from __future__ import annotations

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

from apps.common.content import content_digest  # noqa: E402
from apps.exams.models import ExamProject, Subject, SyllabusVersion  # noqa: E402
from apps.ingestion.models import ImportCandidate, ImportJob  # noqa: E402
from apps.knowledge.models import KnowledgeNode  # noqa: E402
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionFamily,
    QuestionVersion,
    RubricVersion,
)
from apps.question_bank.services import variants as variant_services  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "ingestion_b5_variants.json"

#: Every timestamp in the fixture derives from this instant, never from `timezone.now()`.
BASE = datetime(2026, 5, 1, 0, 0, tzinfo=timezone.utc)

_UNSET = object()


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
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def dump_row(obj) -> dict:
    return {field.attname: jsonable(getattr(obj, field.attname)) for field in obj._meta.concrete_fields}


# --------------------------------------------------------------------------
# deterministic world
# --------------------------------------------------------------------------
class World:
    def __init__(self, name: str) -> None:
        self.name = name
        self.objects: list = []
        self._counters: dict[str, int] = {}

    def uid(self, entity: str) -> uuid.UUID:
        n = self._counters.get(entity, 0) + 1
        self._counters[entity] = n
        return uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b5:{self.name}:{entity}:{n}")

    def create(self, model, entity: str, **kwargs):
        obj = model(id=self.uid(entity), **kwargs)
        obj.save(force_insert=True)
        self.objects.append(obj)
        return obj

    def fix_timestamps(self) -> None:
        for index, obj in enumerate(self.objects):
            value = BASE + timedelta(minutes=index)
            attnames = {field.attname for field in obj._meta.concrete_fields}
            if "created_at" in attnames:
                type(obj)._base_manager.filter(pk=obj.pk).update(created_at=value, updated_at=value)
                obj.refresh_from_db()

    def rows(self) -> dict[str, list[dict]]:
        tables: dict[str, list[dict]] = {}
        for obj in self.objects:
            tables.setdefault(obj._meta.db_table, []).append(dump_row(obj))
        return tables


def single_choice_content(stem: str) -> dict:
    return {
        "blocks": [{"kind": "text", "text": stem}],
        "options": [
            {"id": f"opt_{letter.lower()}", "label": letter, "blocks": [{"kind": "text", "text": f"选项{letter}"}]}
            for letter in "ABCD"
        ],
    }


def single_choice_answer(option_id: str = "opt_b") -> dict:
    return {"kind": "single_choice", "correct_option_id": option_id}


def seed_world(name: str) -> dict:
    """One project / subject / published syllabus with one math node, plus a foreign subject."""
    w = World(name)
    user = w.create(
        get_user_model(),
        "user",
        email=f"b5-{name}@example.invalid",
        display_name="变式作者",
        date_joined=BASE,
        password="!b5-golden-unusable-password-marker",
    )
    project = w.create(ExamProject, "project", owner=user, name=f"项目-{name}")
    subject = w.create(Subject, "subject", project=project, name="数学", code="MATH")
    other_subject = w.create(Subject, "other_subject", project=project, name="物理", code="PHY")
    syllabus = w.create(
        SyllabusVersion,
        "syllabus",
        subject=subject,
        name="数学大纲",
        version_label="2026",
        status="published",
        is_user_provisional=False,
    )
    other_syllabus = w.create(
        SyllabusVersion,
        "other_syllabus",
        subject=other_subject,
        name="物理大纲",
        version_label="2026",
        status="published",
        is_user_provisional=False,
    )
    node = w.create(
        KnowledgeNode,
        "node",
        syllabus_version=syllabus,
        canonical_name="一元二次方程",
        kind="point",
    )
    other_node = w.create(
        KnowledgeNode,
        "other_node",
        syllabus_version=other_syllabus,
        canonical_name="牛顿第二定律",
        kind="point",
    )
    return {
        "world": w,
        "user": user,
        "project": project,
        "subject": subject,
        "other_subject": other_subject,
        "syllabus": syllabus,
        "other_syllabus": other_syllabus,
        "node": node,
        "other_node": other_node,
    }


def add_question(
    ctx: dict,
    *,
    stem: str,
    question_type: str = "single_choice",
    content: dict | None = None,
    answer: dict | None = None,
    status: str = "published",
    family=None,
    rubric: dict | None = None,
    answer_checked: bool = True,
    display_label: str = "Q1",
) -> dict:
    w: World = ctx["world"]
    content = content if content is not None else single_choice_content(stem)
    question = w.create(
        Question,
        "question",
        subject=ctx["subject"],
        origin_type="user_authored",
        display_label=display_label,
        family=family,
    )
    version = w.create(
        QuestionVersion,
        "version",
        question=question,
        version=1,
        question_type=question_type,
        content=content,
        status=status,
        content_digest=content_digest(content),
        revision_reason="fixture",
        source_note="",
        published_at=BASE if status == "published" else None,
    )
    answer_row = None
    if answer is not None:
        answer_row = w.create(
            AnswerKeyVersion,
            "answer",
            question_version=version,
            version=1,
            answer_payload=answer,
            source_type="user",
            verification_status="checked" if answer_checked else "pending",
            check_basis="fixture",
        )
        if rubric is not None:
            w.create(
                RubricVersion,
                "rubric",
                answer_key_version=answer_row,
                version=1,
                criteria=rubric["criteria"],
                total_score=Decimal(rubric["total"]),
                usage_note="",
            )
    return {
        "question": question,
        "version": version,
        "answer": answer_row,
        "content": content,
        "answer_payload": answer,
    }


def variant_payload(stem: str, *, option_id: str = "opt_b") -> dict:
    return {
        "question_type": "single_choice",
        "content": single_choice_content(stem),
        "answer_payload": single_choice_answer(option_id),
        "rubric_criteria": [],
        "rubric_total_score": None,
        "practice_max_score": None,
        "difficulty_note": "提高一档",
        "rationale": "换了情境但考点相同",
        "doubts": [],
    }


def draft_for(ctx: dict, source: dict, payload: dict | None = None) -> dict:
    """Recompute the real `_draft_payload` for a stored source question."""
    source_payload = payload or variant_payload("一个全新的变式题干。")
    clean = source_payload
    digest = content_digest(clean["content"])
    return variant_services._draft_payload(
        clean=clean,
        source_version=source["version"],
        node=ctx["node"],
        digest=digest,
        run_id=uuid.uuid5(uuid.NAMESPACE_URL, f"acepass-b5:{ctx['world'].name}:run"),
    )


# --------------------------------------------------------------------------
# cases
# --------------------------------------------------------------------------
def build() -> dict:
    answer_consistency = []
    proposed_score = []
    drafts = []
    checks = []
    review = []
    summaries = []

    # -- pure answer consistency -------------------------------------------------
    def ac_case(name: str, **kwargs) -> None:
        expected = variant_services._answer_consistency_problems(**kwargs)
        answer_consistency.append({"name": name, "input": kwargs, "expected": expected})

    ac_case(
        name="single_choice_ok",
        content=single_choice_content("下列哪个是二次方程？"),
        answer_payload=single_choice_answer(),
        question_type="single_choice",
        rubric_criteria=None,
        stated_rubric_total=None,
    )
    ac_case(
        name="single_choice_unknown_option",
        content=single_choice_content("下列哪个是二次方程？"),
        answer_payload=single_choice_answer("opt_z"),
        question_type="single_choice",
        rubric_criteria=None,
        stated_rubric_total=None,
    )
    ac_case(
        name="multiple_choice_duplicate_correct",
        content=single_choice_content("以下哪些成立？"),
        answer_payload={"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_a"]},
        question_type="multiple_choice",
        rubric_criteria=None,
        stated_rubric_total=None,
    )
    ac_case(
        name="true_false_wrong_value_type",
        content={"blocks": [{"kind": "text", "text": "该命题成立。"}]},
        answer_payload={"kind": "true_false", "value": "true"},
        question_type="true_false",
        rubric_criteria=None,
        stated_rubric_total=None,
    )
    ac_case(
        name="fill_blank_accepted_values_missing",
        content={
            "blocks": [{"kind": "text", "text": "方程的解是 ____。"}],
            "blanks": [{"blank_id": "b1", "label": "解"}],
        },
        answer_payload={"kind": "fill_blank", "blanks": {"b1": {"accepted_values": [" ", ""]}}},
        question_type="fill_blank",
        rubric_criteria=None,
        stated_rubric_total=None,
    )
    ac_case(
        name="fill_blank_answer_missing",
        content={
            "blocks": [{"kind": "text", "text": "方程的解是 ____。"}],
            "blanks": [{"blank_id": "b1", "label": "解"}],
        },
        answer_payload={"kind": "fill_blank", "blanks": {}},
        question_type="fill_blank",
        rubric_criteria=None,
        stated_rubric_total=None,
    )
    ac_case(
        name="constructed_response_total_mismatch",
        content={"blocks": [{"kind": "text", "text": "证明该命题。"}]},
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        question_type="constructed_response",
        rubric_criteria=[
            {"criterion_id": "c1", "text": "关键步骤", "max_score": "2.00"},
            {"criterion_id": "c2", "text": "结论", "max_score": "1.00"},
        ],
        stated_rubric_total="4.00",
    )
    ac_case(
        name="constructed_response_total_missing",
        content={"blocks": [{"kind": "text", "text": "证明该命题。"}]},
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        question_type="constructed_response",
        rubric_criteria=[{"criterion_id": "c1", "text": "关键步骤", "max_score": "2.00"}],
        stated_rubric_total=None,
    )
    ac_case(
        name="constructed_response_total_invalid",
        content={"blocks": [{"kind": "text", "text": "证明该命题。"}]},
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        question_type="constructed_response",
        rubric_criteria=[{"criterion_id": "c1", "text": "关键步骤", "max_score": "2.00"}],
        stated_rubric_total="两分",
    )
    ac_case(
        name="material_is_never_scorable",
        content={"blocks": [{"kind": "text", "text": "共享材料"}]},
        answer_payload={},
        question_type="material",
        rubric_criteria=None,
        stated_rubric_total=None,
    )

    # -- proposed score ---------------------------------------------------------
    def ps_case(name: str, **kwargs) -> None:
        proposed_score.append(
            {"name": name, "input": kwargs, "expected": variant_services._proposed_score(**kwargs)}
        )

    ps_case(
        name="constructed_response_sum",
        clean={"rubric_criteria": [{"max_score": "2.00"}, {"max_score": "1.50"}]},
        question_type="constructed_response",
        content={"blocks": []},
        answer_payload={},
    )
    ps_case(
        name="constructed_response_stated_fallback",
        clean={"rubric_criteria": [], "rubric_total_score": "5.00"},
        question_type="constructed_response",
        content={"blocks": []},
        answer_payload={},
    )
    ps_case(
        name="declared_score_wins",
        clean={"practice_max_score": "3.00", "rubric_criteria": []},
        question_type="single_choice",
        content=single_choice_content("题干"),
        answer_payload=single_choice_answer(),
    )
    ps_case(
        name="fill_blank_answer_sum",
        clean={},
        question_type="fill_blank",
        content={"blocks": [], "blanks": []},
        answer_payload={"kind": "fill_blank", "blanks": {"b1": {"max_score": "1.00"}, "b2": {"max_score": "2.00"}}},
    )
    ps_case(
        name="fill_blank_declared_sum",
        clean={},
        question_type="fill_blank",
        content={
            "blocks": [],
            "blanks": [
                {"blank_id": "b1", "max_score": "1.00"},
                {"blank_id": "b2", "max_score": "2.50"},
            ],
        },
        answer_payload={"kind": "fill_blank", "blanks": {}},
    )
    ps_case(
        name="nothing_declared",
        clean={},
        question_type="single_choice",
        content=single_choice_content("题干"),
        answer_payload=single_choice_answer(),
    )

    # -- draft payload (needs a real source version) ----------------------------
    ctx = seed_world("draft")
    source = add_question(ctx, stem="原题：求方程的根。", answer=single_choice_answer())
    for name, node, payload in [
        ("with_node", ctx["node"], variant_payload("变式题干一。")),
        ("without_node", None, variant_payload("变式题干二。")),
    ]:
        clean = payload
        digest = content_digest(clean["content"])
        drafts.append(
            {
                "name": name,
                "input": {
                    "clean": clean,
                    "source": {
                        "question_id": str(source["question"].id),
                        "question_type": "single_choice",
                        "display_label": source["question"].display_label,
                        "version_id": str(source["version"].id),
                    },
                    "node_id": None if node is None else str(node.id),
                    "content_digest": digest,
                    "run_id": "00000000-0000-4000-8000-000000000001",
                },
                "expected": variant_services._draft_payload(
                    clean=clean,
                    source_version=source["version"],
                    node=node,
                    digest=digest,
                    run_id=uuid.UUID("00000000-0000-4000-8000-000000000001"),
                ),
            }
        )
    # A constructed response draft, where the score is derived from the rubric.
    cr_clean = {
        "question_type": "constructed_response",
        "content": {"blocks": [{"kind": "text", "text": "说明该结论的证明思路。"}]},
        "answer_payload": {"kind": "constructed_response", "rubric_required": True},
        "rubric_criteria": [
            {"criterion_id": "c1", "text": "思路", "max_score": "2.00", "required": True},
            {"criterion_id": "c2", "text": "结论", "max_score": "3.00", "required": True},
        ],
        "rubric_total_score": "5.00",
        "practice_max_score": None,
        "difficulty_note": "同类换数",
        "rationale": "只改数值",
        "doubts": ["符号约定可能需要说明"],
    }
    cr_digest = content_digest(cr_clean["content"])
    drafts.append(
        {
            "name": "constructed_response_rubric_score",
            "input": {
                "clean": cr_clean,
                "source": {
                    "question_id": str(source["question"].id),
                    "question_type": "constructed_response",
                    "display_label": source["question"].display_label,
                    "version_id": str(source["version"].id),
                },
                "node_id": str(ctx["node"].id),
                "content_digest": cr_digest,
                "run_id": "00000000-0000-4000-8000-000000000002",
            },
            "expected": variant_services._draft_payload(
                clean=cr_clean,
                source_version=source["version"],
                node=ctx["node"],
                digest=cr_digest,
                run_id=uuid.UUID("00000000-0000-4000-8000-000000000002"),
            ),
        }
    )

    # -- independent checks -----------------------------------------------------
    def checks_case(name: str, ctx: dict, source: dict, payload: dict, *, node=_UNSET, project= None, exclude_candidate=None) -> None:
        if node is _UNSET:
            node = ctx["node"]
        if project is None:
            project = ctx["project"]
        result = variant_services.independent_checks(
            payload=payload,
            source_version=source["version"],
            node=node,
            project=project,
            exclude_candidate_id=exclude_candidate,
        )
        ctx["world"].fix_timestamps()
        checks.append(
            {
                "name": name,
                "rows": ctx["world"].rows(),
                "source_version_id": str(source["version"].id),
                "node_id": None if node is None else str(node.id),
                "project_id": str(project.id),
                "payload": payload,
                "exclude_candidate_id": exclude_candidate,
                "expected": result,
            }
        )

    clean_world = seed_world("checks_clean")
    clean_source = add_question(clean_world, stem="原题：求方程的根。", answer=single_choice_answer())
    checks_case("clean_variant", clean_world, clean_source, variant_payload("一个全新的变式题干。"))

    stem_world = seed_world("checks_source_stem")
    stem_source = add_question(stem_world, stem="原题题干完全相同。", answer=single_choice_answer())
    checks_case(
        "variant_duplicates_source_stem",
        stem_world,
        stem_source,
        variant_payload("原题题干完全相同。"),
    )

    published_world = seed_world("checks_published")
    published_source = add_question(published_world, stem="原题一：求方程的根。", answer=single_choice_answer())
    duplicate_payload = variant_payload("已发布过的变式题干。")
    add_question(
        published_world,
        stem="已发布过的变式题干。",
        content=duplicate_payload["content"],
        answer=single_choice_answer(),
        display_label="已发布变式",
    )
    checks_case("duplicate_published", published_world, published_source, duplicate_payload)

    family_world = seed_world("checks_family")
    family = family_world["world"].create(QuestionFamily, "family", subject=family_world["subject"], name="二次方程族")
    family_source = add_question(
        family_world, stem="族内原题：求方程的根。", answer=single_choice_answer(), family=family
    )
    family_payload = variant_payload("家族里已经出现过的题干。")
    add_question(
        family_world,
        stem="家族里已经出现过的题干。",
        content=family_payload["content"],
        answer=single_choice_answer(),
        family=family,
        display_label="族内已发布",
    )
    checks_case("duplicate_family", family_world, family_source, family_payload)

    pending_world = seed_world("checks_pending")
    pending_source = add_question(pending_world, stem="原题三：求方程的根。", answer=single_choice_answer())
    pending_payload = variant_payload("同一批里重复出现的变式。")
    job = pending_world["world"].create(
        ImportJob,
        "job",
        project=pending_world["project"],
        subject=pending_world["subject"],
        created_by=pending_world["user"],
        status="awaiting_review",
        input_kind="ai_variant",
        input_text="ai-variant:pending:no-node::1",
        extractor_version="p2-propose-variant-v1",
        progress_percent=0,
        problems=[],
        page_diagnostics=[],
        attempts=0,
        max_attempts=3,
        last_error="",
        input_fingerprint="pending-fingerprint",
    )
    pending_candidate = pending_world["world"].create(
        ImportCandidate,
        "candidate",
        job=job,
        project=pending_world["project"],
        subject=pending_world["subject"],
        status="draft",
        revision=1,
        draft_payload={
            "question_type": "single_choice",
            "content": pending_payload["content"],
            "answer_payload": pending_payload["answer_payload"],
            "variant_of_version_id": str(pending_source["version"].id),
            "variant_of_question_id": str(pending_source["question"].id),
            "variant_node_id": str(pending_world["node"].id),
        },
        machine_payload={},
        review_issues=[],
        extractor_version="p2-propose-variant-v1",
        is_stub_output=False,
        source_position_key="",
        answer_match={},
        layout_review_note="",
    )
    checks_case(
        "duplicate_pending_proposal",
        pending_world,
        pending_source,
        pending_payload,
        exclude_candidate=str(uuid.uuid5(uuid.NAMESPACE_URL, "some-other-candidate")),
    )

    node_world = seed_world("checks_node")
    node_source = add_question(node_world, stem="原题四：求方程的根。", answer=single_choice_answer())
    checks_case(
        "node_subject_mismatch",
        node_world,
        node_source,
        variant_payload("跨科目考点的变式题干。"),
        node=node_world["other_node"],
    )

    draft_syllabus_world = seed_world("checks_syllabus")
    draft_syllabus_world["syllabus"].status = "draft"
    draft_syllabus_world["syllabus"].save(force_update=True)
    draft_node_source = add_question(draft_syllabus_world, stem="原题五：求方程的根。", answer=single_choice_answer())
    checks_case(
        "node_syllabus_not_published",
        draft_syllabus_world,
        draft_node_source,
        variant_payload("大纲尚未发布时的变式题干。"),
    )

    bad_answer_world = seed_world("checks_answer")
    bad_answer_source = add_question(
        bad_answer_world, stem="原题六：求方程的根。", answer=single_choice_answer()
    )
    broken_payload = variant_payload("答案指向不存在选项的变式。", option_id="opt_z")
    checks_case("answer_unknown_option", bad_answer_world, bad_answer_source, broken_payload)

    # -- review issues ----------------------------------------------------------
    def review_case(name: str, ctx: dict, *, candidate: ImportCandidate, expected=None) -> None:
        ctx["world"].fix_timestamps()
        result = expected if expected is not None else variant_services.variant_review_issues(candidate)
        review.append(
            {
                "name": name,
                "rows": ctx["world"].rows(),
                "candidate_id": str(candidate.id),
                "expected": result,
            }
        )

    review_world = seed_world("review")
    review_source = add_question(review_world, stem="原题七：求方程的根。", answer=single_choice_answer())
    review_job = review_world["world"].create(
        ImportJob,
        "job",
        project=review_world["project"],
        subject=review_world["subject"],
        created_by=review_world["user"],
        status="awaiting_review",
        input_kind="ai_variant",
        input_text="ai-variant:review:no-node::1",
        extractor_version="p2-propose-variant-v1",
        progress_percent=0,
        problems=[],
        page_diagnostics=[],
        attempts=0,
        max_attempts=3,
        last_error="",
        input_fingerprint="review-fingerprint",
    )
    good_draft = draft_for(review_world, review_source, variant_payload("待复核的变式题干。"))
    review_candidate = review_world["world"].create(
        ImportCandidate,
        "candidate",
        job=review_job,
        project=review_world["project"],
        subject=review_world["subject"],
        status="draft",
        revision=1,
        draft_payload=good_draft,
        machine_payload={
            "producer": "ai_variant",
            "variant_of_version_id": str(review_source["version"].id),
            "variant_node_id": str(review_world["node"].id),
            "content_digest": good_draft["variant_content_digest"],
            "llm_run_id": "run-1",
        },
        review_issues=[],
        extractor_version="p2-propose-variant-v1",
        is_stub_output=False,
        source_position_key="",
        answer_match={},
        layout_review_note="",
    )
    review_case("stored_candidate_revalidated", review_world, candidate=review_candidate)

    missing_world = seed_world("review_source_missing")
    missing_job = missing_world["world"].create(
        ImportJob,
        "job",
        project=missing_world["project"],
        subject=missing_world["subject"],
        created_by=missing_world["user"],
        status="awaiting_review",
        input_kind="ai_variant",
        input_text="ai-variant:missing:no-node::1",
        extractor_version="p2-propose-variant-v1",
        progress_percent=0,
        problems=[],
        page_diagnostics=[],
        attempts=0,
        max_attempts=3,
        last_error="",
        input_fingerprint="missing-fingerprint",
    )
    missing_candidate = missing_world["world"].create(
        ImportCandidate,
        "candidate",
        job=missing_job,
        project=missing_world["project"],
        subject=missing_world["subject"],
        status="draft",
        revision=1,
        draft_payload={"question_type": "single_choice", "content": {}, "answer_payload": {}},
        machine_payload={},
        review_issues=[],
        extractor_version="p2-propose-variant-v1",
        is_stub_output=False,
        source_position_key="",
        answer_match={},
        layout_review_note="",
    )
    review_case("variant_source_missing", missing_world, candidate=missing_candidate)

    # -- serializers ------------------------------------------------------------
    summary_world = seed_world("summary")
    summary_source = add_question(summary_world, stem="原题八：求方程的根。", answer=single_choice_answer())
    summary_job = summary_world["world"].create(
        ImportJob,
        "job",
        project=summary_world["project"],
        subject=summary_world["subject"],
        created_by=summary_world["user"],
        status="awaiting_review",
        input_kind="ai_variant",
        input_text="ai-variant:summary:no-node::2",
        extractor_version="p2-propose-variant-v1",
        progress_percent=0,
        problems=[
            {
                "code": "ai_variant_not_published",
                "message": "变式由模型生成，只会成为待校对候选。",
                "severity": "info",
                "source_version_id": str(summary_source["version"].id),
                "prompt_version": "p2-propose-variant-v1",
            }
        ],
        page_diagnostics=[],
        attempts=0,
        max_attempts=3,
        last_error="",
        input_fingerprint="summary-fingerprint",
    )
    summary_drafts = [
        draft_for(summary_world, summary_source, variant_payload("汇总变式题干一。")),
        draft_for(summary_world, summary_source, variant_payload("汇总变式题干二。")),
    ]
    for index, (draft, status) in enumerate(zip(summary_drafts, ["draft", "ready"])):
        summary_world["world"].create(
            ImportCandidate,
            "candidate",
            job=summary_job,
            project=summary_world["project"],
            subject=summary_world["subject"],
            status=status,
            revision=1,
            draft_payload=draft,
            machine_payload={
                "producer": "ai_variant",
                "variant_of_version_id": str(summary_source["version"].id),
                "variant_node_id": str(summary_world["node"].id),
                "content_digest": draft["variant_content_digest"],
                "llm_run_id": f"run-{index + 1}",
            },
            review_issues=[],
            extractor_version="p2-propose-variant-v1",
            is_stub_output=False,
            source_position_key="",
            answer_match={},
            layout_review_note="",
        )
    summary_world["world"].fix_timestamps()
    summaries.append(
        {
            "name": "variant_job_summary",
            "rows": summary_world["world"].rows(),
            "job_id": str(summary_job.id),
            "expected": variant_services.variant_job_summary(summary_job),
        }
    )

    return {
        "now": BASE.isoformat(),
        "answer_consistency": answer_consistency,
        "proposed_score": proposed_score,
        "draft_payload": drafts,
        "checks": checks,
        "review": review,
        "summaries": summaries,
        "notes": [
            "Rows are seeded with uuid5 identities and fixed timestamps; replay them in SQLite.",
            "`checks[].payload` is a raw proposed payload (not the stored draft) like the Python call.",
            "`review` expects the problems recomputed from the stored row, not the stored review_issues.",
        ],
    }


def verify(payload: dict) -> None:
    """Two properties the replay depends on: unique ids and no wall-clock timestamps."""
    cases = [*payload["checks"], *payload["review"], *payload["summaries"]]
    for case in cases:
        for table, rows in case["rows"].items():
            ids = [row["id"] for row in rows if "id" in row]
            assert len(ids) == len(set(ids)), f"duplicate ids in {case['name']}/{table}"
            for row in rows:
                for key in ("created_at", "updated_at"):
                    value = row.get(key)
                    if value:
                        assert value.startswith("2026-05-01T00:"), f"wall clock in {case['name']}/{table}.{key}"


def summarise(payload: dict) -> None:
    print(
        f"answer_consistency={len(payload['answer_consistency'])} "
        f"proposed_score={len(payload['proposed_score'])} "
        f"draft_payload={len(payload['draft_payload'])} "
        f"checks={len(payload['checks'])} review={len(payload['review'])} "
        f"summaries={len(payload['summaries'])}"
    )


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        payload = build()
        verify(payload)
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    summarise(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
