"""Layout review policy (P2 batch 1, C01).

The deterministic PDF parser in :mod:`apps.ingestion.services.pdf_text` never
guesses a reading order and never performs OCR. Instead it *classifies* each page
and reports what it saw, and this module turns that classification into the one
thing that matters for the product rule "错误无法自动发布": a **blocking**
review issue on every candidate that came from a page a human still has to look
at.

Keeping the mapping here (instead of inside the extractor or the API layer) means
there is exactly one place that decides which page reasons block publication, and
exactly one vocabulary shared by the job payload, the candidate issues and the
proofreading UI:

* ``page_without_text_layer`` → ``page_without_text_layer_needs_manual_entry``
* ``multi_column_layout`` / ``column_reading_order_ambiguous`` →
  ``multi_column_needs_review``
* ``table_grid_detected`` / ``formula_tokens_detected`` →
  ``table_or_formula_needs_review``

A blocking issue is cleared by one explicit human act
(``confirm_layout_review``), which is what makes the guard a review gate rather
than a dead end.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

# --------------------------------------------------------------------------
# Page-level reason codes produced by the extractor
# --------------------------------------------------------------------------
#: No usable text layer on this page: a scanned/image page. Never OCR'd.
REASON_SCANNED = "page_without_text_layer"
#: Two or more column bands separated by a gutter.
REASON_MULTI_COLUMN = "multi_column_layout"
#: Columns were detected but their geometry is ambiguous, so the extractor kept
#: the original order instead of silently reordering the page.
REASON_COLUMN_ORDER_AMBIGUOUS = "column_reading_order_ambiguous"
#: Rows sharing a baseline with aligned x positions across consecutive rows.
REASON_TABLE_GRID = "table_grid_detected"
#: Math symbols or sub/superscript constructs on the page.
REASON_FORMULA = "formula_tokens_detected"
#: The text visitor produced nothing, so no geometry exists for this page. This
#: is *not* a review blocker: the wording is still imported with character
#: offsets, only the bounding box falls back to the whole page.
REASON_GEOMETRY_UNAVAILABLE = "geometry_unavailable"
#: More fragments than the deterministic cap; the surplus was ignored.
REASON_TOO_MANY_FRAGMENTS = "too_many_fragments"

# --------------------------------------------------------------------------
# Candidate-level issue codes (what the proofreader sees)
# --------------------------------------------------------------------------
ISSUE_MULTI_COLUMN = "multi_column_needs_review"
ISSUE_TABLE_FORMULA = "table_or_formula_needs_review"
ISSUE_SCANNED = "page_without_text_layer_needs_manual_entry"
#: Non-blocking: the question was joined across a page break.
ISSUE_CROSS_PAGE = "cross_page_question"

#: Which page reason blocks which candidate issue.
REASON_TO_ISSUE = {
    REASON_SCANNED: ISSUE_SCANNED,
    REASON_MULTI_COLUMN: ISSUE_MULTI_COLUMN,
    REASON_COLUMN_ORDER_AMBIGUOUS: ISSUE_MULTI_COLUMN,
    REASON_TABLE_GRID: ISSUE_TABLE_FORMULA,
    REASON_FORMULA: ISSUE_TABLE_FORMULA,
}

#: Stable presentation order, so two identical imports report identically.
ISSUE_ORDER = (ISSUE_SCANNED, ISSUE_MULTI_COLUMN, ISSUE_TABLE_FORMULA)

ISSUE_MESSAGES = {
    ISSUE_SCANNED: (
        "该题来自没有文字层的页面（扫描件/图片页）：系统不做 OCR、不猜测内容，"
        "必须按原页人工录入或改走图片导入的人工校对路径后才能发布"
    ),
    ISSUE_MULTI_COLUMN: (
        "该题来自多栏页面：多栏的阅读顺序无法完全确定，请对照原页确认题干、选项的先后顺序后再发布"
    ),
    ISSUE_TABLE_FORMULA: (
        "该题所在页面包含表格网格或公式符号：表格与公式的版式可能被文本提取改变，"
        "请对照原页逐字确认（公式按原样保留，不做“纠正”）后再发布"
    ),
}


def issue_for_reason(reason: str) -> str | None:
    """The blocking issue code a page reason implies, if any."""
    return REASON_TO_ISSUE.get(reason)


def reasons_needing_review(reasons: Iterable[str]) -> list[str]:
    """Page reasons that require a human layout confirmation."""
    seen: list[str] = []
    for reason in reasons or []:
        if reason in REASON_TO_ISSUE and reason not in seen:
            seen.append(reason)
    return seen


def needs_review(reasons: Iterable[str]) -> bool:
    return bool(reasons_needing_review(reasons))


def issue_codes_for_reasons(reasons: Iterable[str]) -> list[str]:
    codes: list[str] = []
    for reason in reasons_needing_review(reasons):
        code = REASON_TO_ISSUE[reason]
        if code not in codes:
            codes.append(code)
    return codes


def layout_review_issues(
    *,
    page_diagnostics: Iterable[dict] | None,
    pages: Iterable[tuple[str | None, int]],
) -> list[dict[str, Any]]:
    """Blocking issues for a candidate whose source pages need layout review.

    ``pages`` is the set of ``(document_id, page_index)`` the candidate actually
    came from, so a job-level diagnosis only blocks the candidates that touch the
    suspicious page — a clean page in the same file still imports and publishes
    normally.
    """
    wanted = {(str(document_id) if document_id is not None else None, int(page_index)) for document_id, page_index in pages}
    if not wanted:
        return []
    hits: dict[str, list[dict[str, Any]]] = {}
    for row in page_diagnostics or []:
        row_key = (
            str(row.get("document_id")) if row.get("document_id") is not None else None,
            int(row.get("page_index") or 0),
        )
        if row_key not in wanted:
            continue
        for reason in reasons_needing_review(row.get("reasons") or []):
            code = REASON_TO_ISSUE[reason]
            hits.setdefault(code, []).append(
                {
                    "document_id": row_key[0],
                    "page_index": row_key[1],
                    "reason": reason,
                }
            )
    issues: list[dict[str, Any]] = []
    for code in ISSUE_ORDER:
        entries = hits.get(code)
        if not entries:
            continue
        issues.append(
            {
                "code": code,
                "message": ISSUE_MESSAGES[code],
                "severity": "blocking",
                "pages": entries,
                "page_indexes": [entry["page_index"] for entry in entries],
                "reasons": sorted({entry["reason"] for entry in entries}),
            }
        )
    return issues
