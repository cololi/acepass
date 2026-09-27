"""P1-01: native-text PDF batch import and human proofreading.

Acceptance points covered here, each with the *positive* path as well as the
guard:

* 来源页可追溯 — every candidate carries the page it was parsed from;
* 五题型、材料子题关系完整 — all five types plus a material parent with linked
  sub-questions survive into publication;
* 答案匹配只产生候选 — a matched answer page never publishes an answer key until
  a human confirms it;
* 重试/重复导入不重复发布 — re-importing the same file, or retrying a job, cannot
  produce a second published version for the same paper position;
* 不依赖模型密钥 — the whole path is deterministic text extraction.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.common.enums import ImportCandidateStatus, ImportJobStatus
from apps.common.errors import InvalidInput, StructureInvalid
from apps.exams.models import Paper, PaperItem
from apps.ingestion.models import SourceDocument
from apps.ingestion.services import imports as import_services
from apps.ingestion.services import pdf_text
from apps.ingestion.services.imports import PdfUpload
from apps.question_bank.models import Question, QuestionVersion
from tests.support.pdf_builder import build_text_pdf

pytestmark = pytest.mark.django_db

PAPER_PAGES = [
    "\n".join(
        [
            "2024 年示例试卷 卷一",
            "一、单项选择题",
            "【题型】单选题",
            "【题干】下列关于函数的说法正确的是？",
            "【选项】",
            "A. 甲",
            "B. 乙",
            "C. 丙",
            "",
            "【题型】多选题",
            "【题干】下列属于偶函数的有？",
            "【选项】",
            "A. y=x^2",
            "B. y=x",
            "C. y=cos x",
        ]
    ),
    "\n".join(
        [
            "【题型】判断题",
            "【题干】奇函数的图像关于原点对称。",
            "",
            "【题型】填空题",
            "【题干】函数 y=x^2 的最小值是 ____。",
            "",
            "【题型】大题",
            "【题干】请说明该结论的推导过程。",
            "【评分标准】",
            "写出定义域 2 分",
            "得出单调区间 4 分",
        ]
    ),
    "\n".join(
        [
            "【材料一】某市连续五年的空气质量监测数据如下表所示。",
            "【子题6】【题型】单选题",
            "【题干】根据材料，下列说法正确的是？",
            "【选项】",
            "A. 甲",
            "B. 乙",
            "【子题7】【题型】填空题",
            "【题干】五年平均值为 ____。",
        ]
    ),
]

ANSWER_PAGES = [
    "\n".join(
        [
            "参考答案",
            "1. A",
            "2. AC",
            "3. 对",
            "4. 0",
            "5. 略",
            "6. B",
            "7. 42",
        ]
    )
]


def _uploads() -> tuple[list[PdfUpload], list[PdfUpload]]:
    paper = PdfUpload(filename="paper-2024-a.pdf", content=build_text_pdf(PAPER_PAGES))
    answer = PdfUpload(filename="paper-2024-a-answers.pdf", content=build_text_pdf(ANSWER_PAGES))
    return [paper], [answer]


def _import(project_a, subject_a1, **overrides):
    paper, answer = _uploads()
    kwargs = {
        "owner": project_a.owner,
        "project": project_a,
        "paper_files": paper,
        "answer_files": answer,
        "subject": subject_a1,
        "cycle_key": "2024",
        "session_key": "上半年",
        "paper_code": "卷一",
        "title": "2024 年示例试卷",
        "source_note": "P1 验收用自动生成材料（非真题）",
    }
    kwargs.update(overrides)
    return import_services.start_pdf_import(**kwargs)


def test_pdf_import_extracts_text_layer_without_any_provider(project_a, subject_a1):
    extraction = pdf_text.extract_native_text(build_text_pdf(["第一页文字", "第二页文字"]))
    assert extraction.page_count == 2
    assert extraction.pages[0].text == "第一页文字"
    assert extraction.text == "第一页文字\n第二页文字"


def test_pdf_import_reports_a_scan_without_a_text_layer(project_a, subject_a1):
    # A PDF whose pages carry no text at all must not be silently imported.
    blank = build_text_pdf(["", ""])
    with pytest.raises(InvalidInput) as excinfo:
        pdf_text.extract_native_text(blank)
    assert excinfo.value.details.get("reason") == "no_text_layer"


def test_pdf_import_creates_candidates_with_source_pages_and_paper_link(project_a, subject_a1):
    job = _import(project_a, subject_a1)
    candidates = list(job.candidates.order_by("created_at"))
    assert job.input_kind == "pdf_text"
    assert job.status == ImportJobStatus.AWAITING_REVIEW
    assert len(candidates) == 8  # 7 questions + 1 material parent

    material = next(c for c in candidates if c.draft_payload["question_type"] == "material")
    children = list(material.child_candidates.order_by("created_at"))
    assert len(children) == 2
    assert [child.source_position_key for child in children] == ["6", "7"]
    assert all(child.parent_candidate_id == material.id for child in children)

    # Every candidate knows the page it came from (来源页可追溯).
    for candidate in candidates:
        regions = list(candidate.source_regions.all())
        assert regions, candidate.draft_payload
        assert regions[0].page_index >= 1
        assert regions[0].text_span.strip()

    pages = {c.source_position_key: c.source_regions.first().page_index for c in candidates}
    assert pages["1"] == 1 and pages["3"] == 2

    paper = Paper.objects.get(subject=subject_a1, cycle_key="2024")
    assert paper.source_kind == "official_past" and paper.is_demo is False
    assert all(c.paper_revision_id == paper.revisions.get().id for c in candidates)


# --------------------------------------------------------------------------
# Publication: five types, material children, paper items
# --------------------------------------------------------------------------
def _publish(candidate, actor, **kwargs):
    from apps.ingestion.services import core as ingestion

    return ingestion.publish_candidate(candidate, actor=actor, **kwargs)


def _fill_missing_scores(job, score: str = "2"):
    """Give every scored candidate a score, the way a proofreader would.

    A fill-blank question also needs its blanks' scores to add up to the question
    score; the review page asks for that explicitly instead of guessing, and this
    helper does the same split for the tests.
    """
    for candidate in job.candidates.all():
        payload = dict(candidate.draft_payload)
        if payload.get("question_type") == "material":
            continue
        criteria = list(payload.get("rubric_criteria") or [])
        if criteria:
            # A constructed response is worth what its rubric parts are worth.
            payload["practice_max_score"] = str(
                sum((Decimal(str(item.get("max_score") or "0")) for item in criteria), Decimal("0"))
            )
        elif not payload.get("practice_max_score"):
            payload["practice_max_score"] = score
        content = dict(payload.get("content") or {})
        blanks = list(content.get("blanks") or [])
        if blanks:
            share = str(Decimal(score) / len(blanks))
            content["blanks"] = [{**blank, "max_score": share} for blank in blanks]
            payload["content"] = content
            answer = dict(payload.get("answer_payload") or {})
            answer_blanks = dict(answer.get("blanks") or {})
            for blank in content["blanks"]:
                key = blank.get("blank_id")
                if key in answer_blanks:
                    answer_blanks[key] = {**answer_blanks[key], "max_score": share}
            if answer_blanks:
                answer["blanks"] = answer_blanks
                payload["answer_payload"] = answer
        candidate.draft_payload = payload
        candidate.save(update_fields=["draft_payload", "updated_at"])


def _confirm_answers(job):
    """A human confirms the mechanically matched answers."""
    for candidate in job.candidates.all():
        payload = dict(candidate.draft_payload)
        if candidate.answer_match.get("matched"):
            payload["answer_status_known"] = True
            payload["answer_confirmed_by_match_review"] = True
            payload["check_basis"] = "人工核对答案页匹配结果"
            candidate.draft_payload = payload
            candidate.save(update_fields=["draft_payload", "updated_at"])
        from apps.ingestion.services import core as ingestion

        ingestion.refresh_candidate_issues(candidate)


def test_matched_answers_stay_candidates_until_a_human_confirms(project_a, subject_a1):
    job = _import(project_a, subject_a1)
    scored = [c for c in job.candidates.all() if c.draft_payload["question_type"] != "material"]
    assert all(c.answer_match.get("matched") for c in scored)
    # Nothing was published by the matching itself.
    assert Question.objects.filter(subject=subject_a1, display_label__startswith="2024").count() == 0
    for candidate in scored:
        codes = {issue["code"] for issue in candidate.review_issues}
        assert "answer_match_pending_confirmation" in codes
        assert candidate.status == ImportCandidateStatus.DRAFT
    # A published answer key can only exist after the confirmation.
    _confirm_answers(job)
    for candidate in job.candidates.all():
        codes = {issue["code"] for issue in candidate.review_issues}
        assert "answer_match_pending_confirmation" not in codes
        assert "answer_unknown" not in codes


def test_all_five_types_and_material_children_survive_publication(project_a, subject_a1):
    job = _import(project_a, subject_a1)
    _fill_missing_scores(job)
    _confirm_answers(job)
    candidates = list(job.candidates.order_by("created_at"))
    material = next(c for c in candidates if c.draft_payload["question_type"] == "material")
    children = list(material.child_candidates.order_by("created_at"))

    # Children first: a material can only be published once its sub-questions are.
    for child in children:
        published_child, _question = _publish(child, project_a.owner)
        assert published_child.status == ImportCandidateStatus.PUBLISHED

    published_material, _question = _publish(material, project_a.owner)
    material_version = QuestionVersion.objects.get(id=published_material.publication_version_id)
    assert material_version.question_type == "material"
    published_children = list(material.child_candidates.order_by("created_at"))
    assert sorted(material_version.material_child_version_ids) == sorted(
        str(child.publication_version_id) for child in published_children
    )
    assert material_version.child_versions.count() == len(published_children)

    for candidate in candidates:
        if candidate.draft_payload["question_type"] == "material":
            continue
        published, _question = _publish(candidate, project_a.owner)
        version = QuestionVersion.objects.get(id=published.publication_version_id)
        assert version.status == "published"
    types = set(
        QuestionVersion.objects.filter(
            question__subject=subject_a1, question__display_label__startswith=""
        ).values_list("question_type", flat=True)
    )
    assert {"single_choice", "multiple_choice", "true_false", "fill_blank", "constructed_response"} <= types

    # Paper items: the material is unscored, its children are scored and linked.
    revision = material.paper_revision
    items = {item.position_key: item for item in PaperItem.objects.filter(revision=revision)}
    assert items[material.source_position_key].is_scored is False
    for child in published_children:
        item = items[child.source_position_key]
        assert item.is_scored is True
        assert item.parent_item_id == items[material.source_position_key].id
        assert item.max_score > 0
    assert PaperItem.objects.filter(revision=revision, is_scored=True).count() == 7
    # The rubric's own total is what a constructed response is scored against.
    constructed = items["5"]
    assert constructed.max_score == Decimal("6")


def test_material_cannot_be_published_before_its_children(project_a, subject_a1):
    job = _import(project_a, subject_a1)
    _fill_missing_scores(job)
    _confirm_answers(job)
    material = next(c for c in job.candidates.all() if c.draft_payload["question_type"] == "material")
    from apps.ingestion.services import core as ingestion

    ingestion.refresh_candidate_issues(material)
    material.refresh_from_db()
    codes = {issue["code"] for issue in material.review_issues}
    assert "material_without_children" in codes or "material_children_unpublished" in codes

    with pytest.raises(StructureInvalid):
        _publish(material, project_a.owner)
    material.refresh_from_db()
    assert material.status == ImportCandidateStatus.DRAFT


def test_reimporting_the_same_pdf_cannot_publish_the_same_position_twice(project_a, subject_a1):
    first = _import(project_a, subject_a1)
    _fill_missing_scores(first)
    _confirm_answers(first)
    for candidate in first.candidates.all():
        if candidate.draft_payload["question_type"] == "material":
            continue
        _publish(candidate, project_a.owner)

    # The very same bytes again: source documents are reused, not duplicated.
    second = _import(project_a, subject_a1)
    assert second.duplicate_of_id == first.id
    assert second.documents.count() == first.documents.count()
    assert SourceDocument.objects.filter(project=project_a, checksum__in=[
        document.checksum for document in second.documents.all()
    ]).count() == second.documents.count()

    _fill_missing_scores(second)
    _confirm_answers(second)
    blocked = 0
    for candidate in second.candidates.all():
        if candidate.draft_payload["question_type"] == "material":
            continue
        codes = {issue["code"] for issue in candidate.review_issues}
        assert "duplicate_paper_position" in codes, codes
        blocked += 1
        with pytest.raises(StructureInvalid):
            _publish(candidate, project_a.owner)
    assert blocked == 7
    # No second version was created for any of those positions.
    assert (
        QuestionVersion.objects.filter(
            question__subject=subject_a1,
            revision_reason__startswith="由导入候选",
            status="published",
        ).count()
        == 7
    ), "重复导入不得为任何题号创建第二个已发布版本"


def test_retrying_a_failed_import_reuses_the_candidates(project_a, subject_a1):
    from apps.ingestion.services import core as ingestion

    job = _import(project_a, subject_a1)
    before = job.candidates.count()
    ingestion.mark_job_failed(job, error="模拟失败")
    job.refresh_from_db()
    retried = import_services.retry_job(job, actor=project_a.owner)
    assert retried.candidates.count() == before
    assert retried.attempts == 1
    assert any(problem.get("code") == "retried" for problem in retried.problems)


def test_import_without_a_paper_identity_still_works(project_a, subject_a1):
    paper, answer = _uploads()
    job = import_services.start_pdf_import(
        owner=project_a.owner,
        project=project_a,
        paper_files=paper,
        answer_files=answer,
        subject=subject_a1,
        title="未登记试卷身份的练习材料",
    )
    assert job.candidates.exists()
    assert all(candidate.paper_revision_id is None for candidate in job.candidates.all())
    assert Paper.objects.filter(subject=subject_a1, cycle_key="2024").count() == 0
