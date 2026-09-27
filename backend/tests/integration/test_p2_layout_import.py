"""P2 batch 1 (C01): layout-aware import — multi-column, cross-page, tables,
formulas and scanned pages.

Acceptance rule (docs/05 §3, C01): "多栏/跨页/共享材料/公式表格逐类金标回归；
原始区域可定位，错误无法自动发布".

The product rule every class below has to respect: **without a vision model there
is no OCR**. A scanned page is routed to human entry with an explicit reason and
is never guessed at, and layout a deterministic parser cannot read reliably has to
reach a human before anything is published.

One class per layout class, each driven by a **real generated PDF** (never a mocked
extractor) and each asserting the parse result *and* the guard:

1. :class:`TestMultiColumnLayout` — a two-column page parses in column-major order
   and cannot publish before ``layout-confirm``;
2. :class:`TestCrossPageContinuation` — one question split across two pages stays
   one candidate attributed to its starting page, with regions on both pages;
3. :class:`TestTableAndFormulaLayout` — an aligned grid plus formula tokens block
   publication, and the formula text survives verbatim;
4. :class:`TestScannedPageMixedWithNativePages` — an image-only page yields no
   candidates and is reported for manual entry while the native pages still import;
5. :class:`TestRegionGeometry` — a parsed candidate carries a normalised bbox
   inside [0,1] (and the documented whole-page fallback when there is none);
6. :class:`TestNormalPagePublishUnchanged` — a page with nothing suspicious still
   publishes exactly as it did in P1, with no layout confirmation.
"""

from __future__ import annotations

import re

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.common.errors import StructureInvalid
from apps.ingestion.models import ImportJob
from apps.ingestion.services import core as ingestion_services
from apps.ingestion.services import imports as import_services
from apps.ingestion.services import pdf_text
from apps.ingestion.services.imports import PdfUpload
from tests.support.pdf_builder import build_layout_pdf, build_scanned_pdf, build_text_pdf

pytestmark = pytest.mark.django_db

#: The two x bands of every two-column page: page margin and the second column.
LEFT_X = 60.0
RIGHT_X = 330.0
#: Line step that makes a column span most of an A4 page (595x842 pt).
LINE_STEP = 30.0
TOP_Y = 800.0


def _two_column_page(
    left_lines: list[str], right_lines: list[str], *, step: float = LINE_STEP
) -> list[dict]:
    """Interleave the columns in content-stream order.

    Real two-column PDFs are frequently emitted row by row, i.e. in the *wrong*
    reading order; laying the page out that way is what makes the column-major
    assertion meaningful instead of a tautology.
    """
    fragments: list[dict] = []
    for index in range(max(len(left_lines), len(right_lines))):
        y = TOP_Y - index * step
        if index < len(left_lines):
            fragments.append({"x": LEFT_X, "y": y, "text": left_lines[index]})
        if index < len(right_lines):
            fragments.append({"x": RIGHT_X, "y": y, "text": right_lines[index]})
    return fragments


def _question(number: int, prefix: str, *, stem: str | None = None, options: int = 2) -> list[str]:
    """One short single-choice question: label, stem, options."""
    letters = "ABCD"
    lines = [
        f"{number}．【题型】单选题",
        f"【题干】{prefix}第{number}题：{stem or '下列说法正确的是？'}",
        "【选项】",
    ]
    lines.extend(f"{letters[index]}. {'甲乙丙丁'[index]}" for index in range(options))
    return lines


def _pdf_upload(content: bytes, name: str = "paper.pdf") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, content, content_type="application/pdf")


def _post_pdf(caller, project, subject, content: bytes, *, key: str, **extra):
    payload = {
        "files": [_pdf_upload(content)],
        "subject_id": str(subject.id),
        "title": "C01 版式验收材料",
        "source_kind": "practice_set",
    }
    payload.update(extra)
    return caller.client.post(
        f"/api/v1/projects/{project.id}/imports/pdf",
        data=payload,
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
        HTTP_IDEMPOTENCY_KEY=key,
    )


def _candidates(caller, project, job_id: str) -> list[dict]:
    response = caller.get(f"/api/v1/projects/{project.id}/import-candidates?job_id={job_id}")
    assert response.status_code == 200, response.content
    return response.json()


def _codes(candidate: dict) -> set[str]:
    return {issue["code"] for issue in candidate["review_issues"]}


def _issue(candidate: dict, code: str) -> dict:
    return next(issue for issue in candidate["review_issues"] if issue["code"] == code)


def _make_ready(caller, project, candidate: dict, *, score: str = "2") -> dict:
    """Clear everything *except* the layout guard: a proofreader's completed work."""
    payload = dict(candidate["draft_payload"])
    payload["practice_max_score"] = score
    payload["answer_status_known"] = True
    payload["answer_payload"] = {"kind": "single_choice", "correct_option_id": "opt_a"}
    payload["check_basis"] = "人工校对确认（C01 测试）"
    response = caller.patch(
        f"/api/v1/projects/{project.id}/import-candidates/{candidate['id']}",
        {"draft_payload": payload, "expected_revision": candidate["revision"]},
    )
    assert response.status_code == 200, response.content
    return response.json()


def _publish(caller, project, candidate_id: str, *, key: str):
    return caller.post(
        f"/api/v1/projects/{project.id}/import-candidates/{candidate_id}/publish", {}, key=key
    )


def _confirm_layout(caller, project, candidate_id: str, *, key: str, note: str):
    return caller.post(
        f"/api/v1/projects/{project.id}/import-candidates/{candidate_id}/layout-confirm",
        {"note": note},
        key=key,
    )


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


# --------------------------------------------------------------------------
# 1. Multi-column
# --------------------------------------------------------------------------
LEFT_COLUMN = [
    *_question(1, "左栏", stem="下列说法正确的是？"),
    *_question(2, "左栏", stem="下列判断错误的是？"),
    *_question(3, "左栏", stem="偶函数的图像对称吗？"),
    *_question(4, "左栏", stem="下列集合为空集的是？"),
]
RIGHT_COLUMN = [
    *_question(5, "右栏", stem="下列命题正确的是？"),
    *_question(6, "右栏", stem="下列函数递增的是？"),
    *_question(7, "右栏", stem="该数列收敛吗？"),
    *_question(8, "右栏", stem="下列不等式成立的是？"),
]
MULTI_COLUMN_PAGE = _two_column_page(LEFT_COLUMN, RIGHT_COLUMN)


class TestMultiColumnLayout:
    def test_two_columns_parse_in_column_major_order(self):
        extraction = pdf_text.extract_native_text(build_layout_pdf([MULTI_COLUMN_PAGE]))
        page = extraction.pages[0]

        assert page.columns == 2
        assert page.reading_order_reliable is True
        assert "multi_column_layout" in page.diagnostics
        assert extraction.suspicious_pages == [1]

        lines = [line for line in page.text.split("\n") if line.strip()]
        # The content stream is row-major; the page text must not be.
        row_major = [f"{left} {right}" for left, right in zip(LEFT_COLUMN, RIGHT_COLUMN, strict=True)]
        assert lines != row_major, "提取顺序与内容流相同，说明没有按栏重排"
        # Column by column, top-down inside each column.
        assert lines == [*LEFT_COLUMN, *RIGHT_COLUMN]

    def test_ambiguous_columns_are_flagged_not_silently_reordered(self):
        # A full-width heading reaches across the gutter: the order is no longer
        # derivable, so the page keeps the extractor's order and says so.
        page_fragments = [
            {"x": LEFT_X, "y": 830.0, "text": "2024 年示例试卷 卷一 本试卷共两大题 满分一百二十分"},
            *MULTI_COLUMN_PAGE,
        ]
        extraction = pdf_text.extract_native_text(build_layout_pdf([page_fragments]))
        page = extraction.pages[0]

        assert page.columns == 2
        assert page.reading_order_reliable is False
        assert "column_reading_order_ambiguous" in page.diagnostics
        lines = [line for line in page.text.split("\n") if line.strip()]
        assert lines[0].startswith("2024 年示例试卷")
        assert lines != [*LEFT_COLUMN, *RIGHT_COLUMN]

    def test_multi_column_candidate_cannot_publish_before_layout_confirm(
        self, caller, project_a, subject_a1
    ):
        response = _post_pdf(
            caller, project_a, subject_a1, build_layout_pdf([MULTI_COLUMN_PAGE]), key="c01-columns"
        )
        assert response.status_code == 201, response.content
        job = response.json()
        assert job["page_diagnostics"][0]["columns"] == 2

        candidates = _candidates(caller, project_a, job["id"])
        assert len(candidates) == 8
        assert [candidate["source_position_key"] for candidate in candidates] == [
            "1", "2", "3", "4", "5", "6", "7", "8",
        ]
        for candidate in candidates:
            assert "multi_column_needs_review" in _codes(candidate)
            assert _issue(candidate, "multi_column_needs_review")["severity"] == "blocking"

        first = _make_ready(caller, project_a, candidates[0])
        blocked = _publish(caller, project_a, first["id"], key="c01-columns-publish-1")
        assert blocked.status_code == 422
        assert blocked.json()["error"]["code"] == "structure_invalid"
        blocking = [
            issue
            for issue in blocked.json()["error"]["details"]["problems"]
            if issue["code"] == "multi_column_needs_review"
        ]
        assert blocking and blocking[0]["severity"] == "blocking"

        confirmed = _confirm_layout(
            caller,
            project_a,
            first["id"],
            key="c01-columns-confirm-1",
            note="已对照原页确认：左栏四题在前，右栏四题在后",
        )
        assert confirmed.status_code == 200, confirmed.content
        confirmed_body = confirmed.json()
        assert confirmed_body["layout_review_confirmed_at"]
        assert confirmed_body["layout_review_note"] == "已对照原页确认：左栏四题在前，右栏四题在后"
        assert "multi_column_needs_review" not in _codes(confirmed_body)
        assert confirmed_body["status"] == "ready"

        published = _publish(caller, project_a, first["id"], key="c01-columns-publish-2")
        assert published.status_code == 200, published.content
        assert published.json()["publication_version_id"]
        # The region is locatable: the first question came from the left band.
        region = published.json()["source_regions"][0]
        assert region["page_index"] == 1
        assert region["x"] < 0.2
        assert region["x"] + region["width"] <= 1.0

        # The confirmation clears that candidate only; its neighbours stay blocked.
        second = _make_ready(caller, project_a, candidates[1])
        still_blocked = _publish(caller, project_a, second["id"], key="c01-columns-publish-3")
        assert still_blocked.status_code == 422


# --------------------------------------------------------------------------
# 2. Cross-page continuation
# --------------------------------------------------------------------------
CROSS_PAGE_ONE = [
    {"x": LEFT_X, "y": 780.0, "text": "1．【题型】单选题"},
    {"x": LEFT_X, "y": 750.0, "text": "【题干】已知函数 f(x) 在区间 [0,1] 上单调递增，"},
]
CROSS_PAGE_TWO = [
    {"x": LEFT_X, "y": 780.0, "text": "且对任意 x 都有 f(x) 大于等于零，则下列说法正确的是？"},
    {"x": LEFT_X, "y": 750.0, "text": "【选项】"},
    {"x": LEFT_X, "y": 720.0, "text": "A. 甲"},
    {"x": LEFT_X, "y": 690.0, "text": "B. 乙"},
    {"x": LEFT_X, "y": 660.0, "text": "2．【题型】单选题"},
    {"x": LEFT_X, "y": 630.0, "text": "【题干】第二题：下列说法正确的是？"},
    {"x": LEFT_X, "y": 600.0, "text": "【选项】"},
    {"x": LEFT_X, "y": 570.0, "text": "A. 丙"},
    {"x": LEFT_X, "y": 540.0, "text": "B. 丁"},
]


def _cross_page_import(project_a, subject_a1) -> ImportJob:
    return import_services.start_pdf_import(
        owner=project_a.owner,
        project=project_a,
        paper_files=[
            PdfUpload(filename="cross-page.pdf", content=build_layout_pdf([CROSS_PAGE_ONE, CROSS_PAGE_TWO]))
        ],
        subject=subject_a1,
        title="跨页题材料",
    )


class TestCrossPageContinuation:
    def test_a_question_split_across_pages_is_one_candidate_of_its_starting_page(
        self, project_a, subject_a1
    ):
        job = _cross_page_import(project_a, subject_a1)
        candidates = list(job.candidates.order_by("created_at"))
        assert len(candidates) == 2, [c.draft_payload.get("display_label") for c in candidates]

        spanning = candidates[0]
        payload = spanning.draft_payload
        # 跨页题目归属到起始页: the position key comes from the page the question
        # starts on, not from the page where it happens to end.
        assert spanning.source_position_key == "1"
        assert payload["continues_on_pages"] == [1, 2]
        assert "在区间" in payload["content"]["blocks"][0]["text"]
        assert "大于等于零" in payload["content"]["blocks"][0]["text"]

        regions = list(spanning.source_regions.order_by("page_index"))
        assert sorted(region.page_index for region in regions) == [1, 2]
        assert regions[0].page_index == 1
        assert regions[1].text_span.strip().startswith("且对任意 x")
        for region in regions:
            assert 0.0 <= region.x <= 1.0 and 0.0 <= region.y <= 1.0
            assert 0.0 < region.width <= 1.0 and 0.0 < region.height <= 1.0
            assert region.x + region.width <= 1.0 and region.y + region.height <= 1.0

        # Non-blocking: the proofreader is told, the queue is not stopped.
        issue = _issue(import_services.candidate_summary(spanning), "cross_page_question")
        assert issue["severity"] == "warning"
        assert issue["pages"] == [1, 2]

        second = candidates[1]
        assert second.source_position_key == "2"
        assert second.draft_payload.get("continues_on_pages") is None
        assert [region.page_index for region in second.source_regions.all()] == [2]

    def test_a_question_that_ends_a_page_is_not_joined(self, project_a, subject_a1):
        # The first question ends with "。" on page 1, so page 2 opens a new one:
        # nothing is joined and nothing is reported.
        page_one, page_two = CROSS_PAGE_ONE, CROSS_PAGE_TWO
        page_one = [
            *page_one[:-1],
            {"x": LEFT_X, "y": 750.0, "text": "【题干】以下说法中，正确的一项是（　）。"},
        ]
        job = import_services.start_pdf_import(
            owner=project_a.owner,
            project=project_a,
            paper_files=[
                PdfUpload(
                    filename="no-continuation.pdf",
                    content=build_layout_pdf([page_one, page_two]),
                )
            ],
            subject=subject_a1,
            title="未跨页材料",
        )
        boundaries = pdf_text.extract_native_text(
            build_layout_pdf([page_one, page_two])
        ).pages
        assert import_services.text_parser.detect_page_continuations(boundaries) == []
        for candidate in job.candidates.all():
            assert "cross_page_question" not in _codes(import_services.candidate_summary(candidate))


# --------------------------------------------------------------------------
# 3. Table grid and formula tokens
# --------------------------------------------------------------------------
TABLE_ROWS = [
    ("年份", "PM2.5", "优良天数"),
    ("2020", "35", "300"),
    ("2021", "31", "320"),
    ("2022", "28", "330"),
]
#: The formula has to come back character for character: no "correction" of
#: symbols, no LaTeX rewriting, no unicode normalisation.
FORMULA_STEM = r"【题干】已知 f(x)=\frac{1}{2}x^{2}+\sqrt{3}，求 ∫_0^1 f(x)dx 的值。"
FORMULA_PAGE = [
    *[
        {"x": 60.0 + column * 140.0, "y": 780.0 - row * 30.0, "text": cell}
        for row, cells in enumerate(TABLE_ROWS)
        for column, cell in enumerate(cells)
    ],
    {"x": LEFT_X, "y": 620.0, "text": "1．【题型】单选题"},
    {"x": LEFT_X, "y": 590.0, "text": FORMULA_STEM},
    {"x": LEFT_X, "y": 560.0, "text": "【选项】"},
    {"x": LEFT_X, "y": 530.0, "text": "A. 甲"},
    {"x": LEFT_X, "y": 500.0, "text": "B. 乙"},
    # Shared material on the same suspicious page: the guard must reach the
    # material parent and its sub-question without breaking the P1 relation.
    {"x": LEFT_X, "y": 450.0, "text": "【材料一】某市连续三年的空气质量监测数据如上表所示。"},
    {"x": LEFT_X, "y": 420.0, "text": "【子题2】【题型】单选题"},
    {"x": LEFT_X, "y": 390.0, "text": "【题干】根据材料，下列说法正确的是？"},
    {"x": LEFT_X, "y": 360.0, "text": "【选项】"},
    {"x": LEFT_X, "y": 330.0, "text": "A. 甲"},
    {"x": LEFT_X, "y": 300.0, "text": "B. 乙"},
]


class TestTableAndFormulaLayout:
    def test_grid_and_formula_are_detected_and_the_formula_is_kept_verbatim(self):
        extraction = pdf_text.extract_native_text(build_layout_pdf([FORMULA_PAGE]))
        page = extraction.pages[0]

        assert page.has_table_grid is True
        assert page.has_formula_tokens is True
        assert "table_grid_detected" in page.diagnostics
        assert "formula_tokens_detected" in page.diagnostics
        # Verbatim: the backslashes, the braces, the superscript and the integral
        # sign are exactly the characters the source carried.
        assert r"\frac{1}{2}x^{2}+\sqrt{3}" in page.text
        assert "∫_0^1 f(x)dx" in page.text

    def test_table_or_formula_candidate_cannot_publish_unconfirmed(
        self, caller, project_a, subject_a1
    ):
        response = _post_pdf(
            caller, project_a, subject_a1, build_layout_pdf([FORMULA_PAGE]), key="c01-formula"
        )
        assert response.status_code == 201, response.content
        job = response.json()
        page_row = job["page_diagnostics"][0]
        assert page_row["has_table_grid"] is True and page_row["has_formula_tokens"] is True
        assert any(
            problem["code"] == "table_or_formula_needs_review" for problem in job["problems"]
        )

        candidates = _candidates(caller, project_a, job["id"])
        # The table rows are not questions: only the labelled questions and the
        # shared material with its sub-question are imported.
        assert len(candidates) == 3
        by_label = {candidate["draft_payload"]["display_label"]: candidate for candidate in candidates}
        candidate = by_label["1"]
        assert "table_or_formula_needs_review" in _codes(candidate)
        assert _issue(candidate, "table_or_formula_needs_review")["severity"] == "blocking"
        stem = candidate["draft_payload"]["content"]["blocks"][0]["text"]
        assert r"\frac{1}{2}x^{2}+\sqrt{3}" in stem
        assert "∫_0^1 f(x)dx" in stem

        # 共享材料: the parent/child relation survives, and the layout guard reaches
        # both rows of the pair.
        material = next(c for c in candidates if c["draft_payload"]["question_type"] == "material")
        child = next(c for c in candidates if c["parent_candidate_id"] == material["id"])
        assert material["child_candidate_ids"] == [child["id"]]
        assert "table_or_formula_needs_review" in _codes(material)
        assert "table_or_formula_needs_review" in _codes(child)

        ready = _make_ready(caller, project_a, candidate)
        blocked = _publish(caller, project_a, ready["id"], key="c01-formula-publish-1")
        assert blocked.status_code == 422
        assert any(
            issue["code"] == "table_or_formula_needs_review"
            for issue in blocked.json()["error"]["details"]["problems"]
        )

        confirmed = _confirm_layout(
            caller,
            project_a,
            ready["id"],
            key="c01-formula-confirm",
            note="已对照原页逐字核对公式与表格文字",
        )
        assert confirmed.status_code == 200, confirmed.content
        assert "table_or_formula_needs_review" not in _codes(confirmed.json())
        published = _publish(caller, project_a, ready["id"], key="c01-formula-publish-2")
        assert published.status_code == 200, published.content


# --------------------------------------------------------------------------
# 4. A scanned page mixed with native pages
# --------------------------------------------------------------------------
NATIVE_PAGE_TEXT = "\n".join(
    [
        "1．【题型】单选题",
        "【题干】原生页第一题：下列说法正确的是？",
        "【选项】",
        "A. 甲",
        "B. 乙",
    ]
)


def _mixed_import(project_a, subject_a1) -> ImportJob:
    return import_services.start_pdf_import(
        owner=project_a.owner,
        project=project_a,
        paper_files=[
            PdfUpload(
                filename="mixed.pdf",
                content=build_scanned_pdf([NATIVE_PAGE_TEXT, None]),
            )
        ],
        subject=subject_a1,
        title="扫描页混排材料",
    )


class TestScannedPageMixedWithNativePages:
    def test_a_scanned_page_is_reported_for_manual_entry_and_nothing_is_dropped(
        self, project_a, subject_a1
    ):
        job = _mixed_import(project_a, subject_a1)

        extraction = job.documents.first()
        assert extraction.page_count == 2
        assert extraction.page_texts[1] == ""
        rows = {row["page_index"]: row for row in job.page_diagnostics}
        assert rows[2]["is_scanned"] is True
        assert rows[2]["reasons"] == ["page_without_text_layer"]
        assert rows[2]["needs_review"] is True
        assert rows[1]["needs_review"] is False

        scanned_problem = next(
            problem
            for problem in job.problems
            if problem["code"] == "page_without_text_layer_needs_manual_entry"
        )
        assert "人工" in scanned_problem["message"]
        assert scanned_problem["pages"][0]["page_index"] == 2
        # The P1 problem is kept as well: nothing was renamed or removed.
        assert any(problem["code"] == "pdf_pages_without_text" for problem in job.problems)

        # The scanned page produced no candidate at all (no OCR, no guess)...
        candidates = list(job.candidates.all())
        assert len(candidates) == 1
        assert [region.page_index for region in candidates[0].source_regions.all()] == [1]
        assert "page_without_text_layer_needs_manual_entry" not in _codes(
            import_services.candidate_summary(candidates[0])
        )
        # ...and the native page still imports and publishes normally.
        candidate = candidates[0]
        payload = dict(candidate.draft_payload)
        payload.update(
            {
                "practice_max_score": "2",
                "answer_status_known": True,
                "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
            }
        )
        candidate.draft_payload = payload
        candidate.save(update_fields=["draft_payload", "updated_at"])
        published, _question = ingestion_services.publish_candidate(
            candidate, actor=project_a.owner
        )
        assert published.status.value == "published"

    def test_a_candidate_located_on_the_scanned_page_is_blocked(self, project_a, subject_a1):
        """If a candidate ever ends up on a scanned page, publish must refuse it."""
        job = _mixed_import(project_a, subject_a1)
        document = job.documents.first()
        region = ingestion_services.create_source_region(
            document=document,
            page_index=2,
            x=0.0,
            y=0.0,
            width=1.0,
            height=1.0,
            text_span="（扫描页，未做 OCR）",
        )
        candidate = ingestion_services.create_candidate(
            job=job,
            payload={
                "question_type": "single_choice",
                "display_label": "扫描页候选",
                "content": {
                    "blocks": [{"kind": "text", "text": "扫描页上的题目"}],
                    "options": [
                        {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                        {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
                    ],
                },
                "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
                "answer_status_known": True,
            },
            subject=subject_a1,
            regions=[region],
            extractor_version=import_services.PDF_EXTRACTOR_VERSION,
        )
        codes = {issue["code"] for issue in candidate.review_issues}
        assert "page_without_text_layer_needs_manual_entry" in codes
        issue = next(
            issue
            for issue in candidate.review_issues
            if issue["code"] == "page_without_text_layer_needs_manual_entry"
        )
        assert issue["severity"] == "blocking"
        assert issue["page_indexes"] == [2]

        with pytest.raises(StructureInvalid) as excinfo:
            ingestion_services.publish_candidate(candidate, actor=project_a.owner)
        assert any(
            problem["code"] == "page_without_text_layer_needs_manual_entry"
            for problem in excinfo.value.details["problems"]
        )

        confirmed = ingestion_services.confirm_layout_review(
            candidate, actor=project_a.owner, note="已按原页人工录入并核对"
        )
        assert confirmed.layout_review_confirmed_at is not None
        assert "page_without_text_layer_needs_manual_entry" not in {
            issue["code"] for issue in confirmed.review_issues
        }


# --------------------------------------------------------------------------
# 5. Region geometry
# --------------------------------------------------------------------------
GEOMETRY_PAGE = [
    {"x": LEFT_X, "y": 760.0, "text": "1．【题型】单选题"},
    {"x": LEFT_X, "y": 730.0, "text": "【题干】几何定位题：下列说法正确的是？"},
    {"x": LEFT_X, "y": 700.0, "text": "【选项】"},
    {"x": LEFT_X, "y": 670.0, "text": "A. 甲"},
    {"x": LEFT_X, "y": 640.0, "text": "B. 乙"},
]


class TestRegionGeometry:
    def test_extracted_pages_carry_xy_text_fragments(self):
        # The `{x, y, text}` shape the geometry is built from, on a real PDF.
        page = pdf_text.extract_native_text(build_layout_pdf([GEOMETRY_PAGE])).pages[0]
        fragments = [fragment.as_dict() for fragment in page.fragments]
        assert len(fragments) == len(GEOMETRY_PAGE)
        assert [fragment["text"] for fragment in fragments] == [
            item["text"] for item in GEOMETRY_PAGE
        ]
        for fragment in fragments:
            assert 0.0 <= fragment["x"] <= 1.0
            # Top-down: the first line of the page is above the last one.
            assert 0.0 <= fragment["y"] <= 1.0
        assert fragments[0]["y"] < fragments[-1]["y"]
        assert abs(fragments[0]["x"] - LEFT_X / 595.0) < 0.01

    def test_a_parsed_candidate_carries_a_normalised_bbox_inside_the_page(
        self, project_a, subject_a1
    ):
        job = import_services.start_pdf_import(
            owner=project_a.owner,
            project=project_a,
            paper_files=[PdfUpload(filename="geometry.pdf", content=build_layout_pdf([GEOMETRY_PAGE]))],
            subject=subject_a1,
            title="几何定位材料",
        )
        candidate = job.candidates.get()
        region = candidate.source_regions.get()

        assert region.page_index == 1
        for value in (region.x, region.y, region.width, region.height):
            assert 0.0 <= value <= 1.0
        assert region.width > 0 and region.height > 0
        assert region.x + region.width <= 1.0
        assert region.y + region.height <= 1.0

        # The box is the stem's own area, not the whole page: the stem was printed
        # at x=60pt, y=730pt on a 595x842pt page (x≈0.101, y≈0.119, w≈0.38).
        assert 0.08 <= region.x <= 0.15
        assert 0.05 <= region.y <= 0.20
        assert 0.25 <= region.width <= 0.50
        assert region.height <= 0.05
        assert region.x + region.width <= 0.5

        # The character offsets are kept beside the box (P1 behaviour).
        assert region.char_start is not None and region.char_start >= 0
        assert region.char_end > region.char_start
        assert region.text_span == candidate.draft_payload["source_excerpt"]

    def test_region_falls_back_to_the_whole_page_when_geometry_is_unavailable(
        self, monkeypatch, project_a, subject_a1
    ):
        """Documented fallback, asserted directly.

        The fixture builder always produces real text geometry, so a page whose
        visitor yields *nothing* cannot be synthesised from bytes here; the
        extractor is made to behave that way (it is the contract under test, not
        the extractor). The wording, the page and the character offsets must still
        be imported — only the box degrades to the whole page.
        """
        real = pdf_text.extract_native_text

        def without_geometry(content: bytes) -> pdf_text.PdfExtraction:
            extraction = real(content)
            stripped = [
                pdf_text.PdfPage(
                    page_index=page.page_index,
                    text=page.text,
                    character_count=page.character_count,
                    reading_order_reliable=False,
                )
                for page in extraction.pages
            ]
            return pdf_text.PdfExtraction(
                page_count=extraction.page_count,
                pages=stripped,
                character_count=extraction.character_count,
                empty_pages=extraction.empty_pages,
                metadata=extraction.metadata,
            )

        monkeypatch.setattr(import_services.pdf_text, "extract_native_text", without_geometry)
        job = import_services.start_pdf_import(
            owner=project_a.owner,
            project=project_a,
            paper_files=[PdfUpload(filename="geometry.pdf", content=build_layout_pdf([GEOMETRY_PAGE]))],
            subject=subject_a1,
            title="无几何信息材料",
        )
        candidate = job.candidates.get()
        region = candidate.source_regions.get()
        assert (region.x, region.y, region.width, region.height) == (0.0, 0.0, 1.0, 1.0)
        assert region.char_start is not None
        assert region.text_span == candidate.draft_payload["source_excerpt"]
        assert "下列说法正确的是？" in candidate.draft_payload["content"]["blocks"][0]["text"]


# --------------------------------------------------------------------------
# Extra: the deterministic fragment cap is reported, never silently ignored
# --------------------------------------------------------------------------
class TestFragmentCapDiagnostics:
    def test_a_page_with_too_many_runs_is_marked_unreliable(self):
        """The cap is part of the contract: beyond it the page cannot be trusted."""
        cap = pdf_text.MAX_FRAGMENTS_PER_PAGE
        fragments = [
            # Enough distinct positions to defeat the same-position merge.
            {"x": 20.0 + (index % 40) * 14.0, "y": 820.0 - (index // 40) * 6.0, "text": f"行{index}"}
            for index in range(cap + 5)
        ]
        page = pdf_text.extract_native_text(build_layout_pdf([fragments])).pages[0]
        assert len(page.fragments) == cap
        assert page.reading_order_reliable is False
        assert "too_many_fragments" in page.diagnostics
        # Text is never lost to a geometry cap: the page text still carries every
        # run, including the ones beyond the cap.
        assert "行0" in page.text and f"行{cap + 4}" in page.text


# --------------------------------------------------------------------------
# 6. Nothing changed for a page with no layout doubt
# --------------------------------------------------------------------------
NORMAL_PAGE = "\n".join(
    [
        "1．【题型】单选题",
        "【题干】普通页面第一题：下列说法正确的是？",
        "【选项】",
        "A. 甲",
        "B. 乙",
    ]
)


class TestNormalPagePublishUnchanged:
    def test_a_normal_page_publishes_without_any_layout_confirmation(
        self, caller, project_a, subject_a1
    ):
        response = _post_pdf(
            caller,
            project_a,
            subject_a1,
            build_text_pdf([NORMAL_PAGE]),
            key="c01-normal",
            cycle_key="2024",
            session_key="上半年",
            paper_code="卷一",
            source_kind="official_past",
        )
        assert response.status_code == 201, response.content
        job = response.json()
        assert job["candidate_count"] == 1
        rows = job["page_diagnostics"]
        assert len(rows) == 1
        assert rows[0]["reasons"] == [] and rows[0]["needs_review"] is False
        assert rows[0]["columns"] == 1 and rows[0]["is_scanned"] is False
        assert not any(
            problem["code"].endswith("_needs_review") for problem in job["problems"]
        )

        candidate = _candidates(caller, project_a, job["id"])[0]
        assert _codes(candidate) & {
            "multi_column_needs_review",
            "table_or_formula_needs_review",
            "page_without_text_layer_needs_manual_entry",
            "cross_page_question",
        } == set()
        assert candidate["layout_review_confirmed_at"] is None
        assert candidate["layout_review_note"] == ""
        # P1 payload fields are still there, unchanged.
        assert candidate["machine_payload"]["question_type"] == "single_choice"
        assert candidate["source_regions"][0]["document_type"] == "pdf"
        assert candidate["source_regions"][0]["text_span"].strip()
        assert job["extractor_version"].startswith("pdf-text")

        ready = _make_ready(caller, project_a, candidate)
        published = _publish(caller, project_a, ready["id"], key="c01-normal-publish")
        assert published.status_code == 200, published.content
        body = published.json()
        assert body["publication_question_id"]
        assert body["publication_version_id"]
        assert body["source_position_key"] == "1"
        assert body["layout_review_confirmed_at"] is None
        # The paper item was written exactly as in P1 (real-paper accounting).
        assert body["publication_paper_item_id"]

    def test_layout_confirm_is_idempotent_and_recorded_once(
        self, caller, project_a, subject_a1
    ):
        response = _post_pdf(
            caller, project_a, subject_a1, build_layout_pdf([MULTI_COLUMN_PAGE]), key="c01-idem"
        )
        job = response.json()
        candidate = _candidates(caller, project_a, job["id"])[0]
        first = _confirm_layout(
            caller, project_a, candidate["id"], key="c01-idem-confirm", note="第一次确认"
        )
        assert first.status_code == 200, first.content
        replay = _confirm_layout(
            caller, project_a, candidate["id"], key="c01-idem-confirm", note="第一次确认"
        )
        assert replay.status_code == 200
        assert replay.json()["layout_review_confirmed_at"] == first.json()["layout_review_confirmed_at"]
        second = _confirm_layout(
            caller, project_a, candidate["id"], key="c01-idem-confirm-2", note="再次确认"
        )
        assert second.status_code == 200
        assert second.json()["layout_review_note"] == "再次确认"

    def test_layout_confirm_requires_an_idempotency_key(self, caller, project_a, subject_a1):
        response = _post_pdf(
            caller, project_a, subject_a1, build_layout_pdf([MULTI_COLUMN_PAGE]), key="c01-nokey"
        )
        candidate = _candidates(caller, project_a, response.json()["id"])[0]
        without_key = caller.client.post(
            f"/api/v1/projects/{project_a.id}/import-candidates/{candidate['id']}/layout-confirm",
            data={"note": "无幂等键"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
        )
        assert without_key.status_code == 409
        assert without_key.json()["error"]["code"] == "idempotency_conflict"
