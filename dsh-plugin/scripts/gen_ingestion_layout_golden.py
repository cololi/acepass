"""Golden vectors for the ingestion layout-review policy (B1).

Driven against the real functions in `backend/apps/ingestion/services/layout.py`; nothing here
re-implements the mapping, so a vector that disagrees with the TypeScript port is a port defect,
not a stale expectation.

The corpus pins the parts of the policy that are easy to get subtly wrong when porting:

* `wanted` is a *set* of `(str(document_id) | None, int(page_index))`, built from the candidate's
  pages, so a job-level diagnosis only blocks the candidates that touch the suspicious page;
* `int(row.get("page_index") or 0)` — a missing/None/empty index reads as 0, a numeric string is
  parsed with Python `int()` semantics, while `pages` uses `int(page_index)` with no fallback;
* reasons are de-duplicated *per row*, in first-seen order, and a reason only blocks when it is a
  key of `REASON_TO_ISSUE` (`geometry_unavailable` / `too_many_fragments` never do);
* issues follow `ISSUE_ORDER`, page entries follow diagnostics order, `page_indexes` keeps repeats
  and `reasons` is `sorted(set(...))`.

The file is written through OUT (not stdout) so `npm run golden:ingestion-layout` has no shell
redirection in the loop; a printed summary reports the vector counts.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
import django  # noqa: E402

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
django.setup()

from apps.ingestion.services import layout  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "ingestion_layout.json"

R_SCANNED = layout.REASON_SCANNED
R_MULTI_COLUMN = layout.REASON_MULTI_COLUMN
R_COLUMN_ORDER_AMBIGUOUS = layout.REASON_COLUMN_ORDER_AMBIGUOUS
R_TABLE_GRID = layout.REASON_TABLE_GRID
R_FORMULA = layout.REASON_FORMULA
R_GEOMETRY_UNAVAILABLE = layout.REASON_GEOMETRY_UNAVAILABLE
R_TOO_MANY_FRAGMENTS = layout.REASON_TOO_MANY_FRAGMENTS

ALL_REASONS = [
    R_SCANNED,
    R_MULTI_COLUMN,
    R_COLUMN_ORDER_AMBIGUOUS,
    R_TABLE_GRID,
    R_FORMULA,
    R_GEOMETRY_UNAVAILABLE,
    R_TOO_MANY_FRAGMENTS,
]
BLOCKING_REASONS = [R_SCANNED, R_MULTI_COLUMN, R_COLUMN_ORDER_AMBIGUOUS, R_TABLE_GRID, R_FORMULA]
NON_BLOCKING_REASONS = [R_GEOMETRY_UNAVAILABLE, R_TOO_MANY_FRAGMENTS]
UNKNOWN_REASONS = ["", "unknown_reason", "PAGE_WITHOUT_TEXT_LAYER", "multi_column_needs_review"]


def diagnostic(document_id: object = "doc-a", page_index: object = 1, reasons: object = None,
               *, drop_page_index: bool = False, drop_document_id: bool = False) -> dict:
    """One page-diagnostics row as the extractor/import job stores it."""
    row: dict = {}
    if not drop_document_id:
        row["document_id"] = document_id
    if not drop_page_index:
        row["page_index"] = page_index
    row["reasons"] = reasons
    return row


LAYOUT_CASES = [
    {
        "name": "no_diagnostics_none",
        "page_diagnostics": None,
        "pages": [["doc-a", 1]],
    },
    {
        "name": "no_diagnostics_empty_list",
        "page_diagnostics": [],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "empty_candidate_pages",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_SCANNED])],
        "pages": [],
    },
    {
        "name": "empty_candidate_pages_and_no_diagnostics",
        "page_diagnostics": None,
        "pages": [],
    },
    {
        "name": "diagnosed_page_not_used_by_candidate",
        "page_diagnostics": [diagnostic("doc-a", 2, [R_SCANNED])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "same_page_other_document",
        "page_diagnostics": [diagnostic("doc-b", 1, [R_SCANNED])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "one_page_scanned",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_SCANNED])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "one_page_multi_column",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_MULTI_COLUMN])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "one_page_column_order_ambiguous",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_COLUMN_ORDER_AMBIGUOUS])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "one_page_table_grid",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_TABLE_GRID])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "one_page_formula",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_FORMULA])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "geometry_unavailable_does_not_block",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_GEOMETRY_UNAVAILABLE])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "too_many_fragments_does_not_block",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_TOO_MANY_FRAGMENTS])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "non_blocking_reasons_beside_blocking",
        "page_diagnostics": [
            diagnostic("doc-a", 1, [R_GEOMETRY_UNAVAILABLE, R_TOO_MANY_FRAGMENTS, R_MULTI_COLUMN]),
        ],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "same_code_two_documents",
        "page_diagnostics": [
            diagnostic("doc-b", 1, [R_MULTI_COLUMN]),
            diagnostic("doc-a", 2, [R_COLUMN_ORDER_AMBIGUOUS]),
            diagnostic("doc-b", 1, [R_MULTI_COLUMN]),
        ],
        "pages": [["doc-a", 2], ["doc-b", 1]],
    },
    {
        "name": "all_three_codes_one_page",
        "page_diagnostics": [
            diagnostic("doc-a", 4, [R_FORMULA, R_SCANNED, R_MULTI_COLUMN]),
        ],
        "pages": [["doc-a", 4]],
    },
    {
        "name": "duplicate_reason_values_same_row",
        "page_diagnostics": [
            diagnostic("doc-a", 1, [R_MULTI_COLUMN, R_MULTI_COLUMN, R_COLUMN_ORDER_AMBIGUOUS, R_MULTI_COLUMN]),
        ],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "duplicate_reason_values_across_rows",
        "page_diagnostics": [
            diagnostic("doc-a", 1, [R_TABLE_GRID]),
            diagnostic("doc-a", 1, [R_TABLE_GRID]),
        ],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "duplicate_candidate_pages_collapse",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_SCANNED])],
        "pages": [["doc-a", 1], ["doc-a", 1], ["doc-a", 1]],
    },
    {
        "name": "page_index_numeric_string_in_row",
        "page_diagnostics": [diagnostic("doc-a", "2", [R_SCANNED])],
        "pages": [["doc-a", 2]],
    },
    {
        "name": "page_index_numeric_string_in_pages",
        "page_diagnostics": [diagnostic("doc-a", 2, [R_SCANNED])],
        "pages": [["doc-a", "2"]],
    },
    {
        "name": "page_index_numeric_strings_on_both_sides",
        "page_diagnostics": [diagnostic("doc-a", " 2 ", [R_SCANNED])],
        "pages": [["doc-a", " 2 "]],
    },
    {
        "name": "page_index_plus_sign_string",
        "page_diagnostics": [diagnostic("doc-a", "+3", [R_SCANNED])],
        "pages": [["doc-a", 3]],
    },
    {
        "name": "page_index_float_truncates",
        "page_diagnostics": [diagnostic("doc-a", 2.9, [R_SCANNED])],
        "pages": [["doc-a", 2]],
    },
    {
        "name": "page_index_missing_reads_as_zero",
        "page_diagnostics": [diagnostic("doc-a", reasons=[R_SCANNED], drop_page_index=True)],
        "pages": [["doc-a", 0]],
    },
    {
        "name": "page_index_none_reads_as_zero",
        "page_diagnostics": [diagnostic("doc-a", None, [R_SCANNED])],
        "pages": [["doc-a", 0]],
    },
    {
        "name": "page_index_empty_string_reads_as_zero",
        "page_diagnostics": [diagnostic("doc-a", "", [R_SCANNED])],
        "pages": [["doc-a", 0]],
    },
    {
        "name": "page_index_zero_is_falsy_but_kept",
        "page_diagnostics": [diagnostic("doc-a", 0, [R_SCANNED])],
        "pages": [["doc-a", 0]],
    },
    {
        "name": "page_index_missing_does_not_match_page_one",
        "page_diagnostics": [diagnostic("doc-a", reasons=[R_SCANNED], drop_page_index=True)],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "document_id_none_matches_none",
        "page_diagnostics": [diagnostic(None, 1, [R_TABLE_GRID])],
        "pages": [[None, 1]],
    },
    {
        "name": "document_id_none_does_not_match_string",
        "page_diagnostics": [diagnostic(None, 1, [R_TABLE_GRID])],
        "pages": [["None", 1]],
    },
    {
        "name": "document_id_string_does_not_match_none",
        "page_diagnostics": [diagnostic("doc-a", 1, [R_TABLE_GRID])],
        "pages": [[None, 1]],
    },
    {
        "name": "document_id_int_is_stringified",
        "page_diagnostics": [diagnostic(7, 1, [R_FORMULA])],
        "pages": [["7", 1]],
    },
    {
        "name": "reasons_none_yields_nothing",
        "page_diagnostics": [diagnostic("doc-a", 1, None)],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "reasons_missing_yields_nothing",
        "page_diagnostics": [{"document_id": "doc-a", "page_index": 1}],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "reasons_empty_list_yields_nothing",
        "page_diagnostics": [diagnostic("doc-a", 1, [])],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "reasons_bare_string_is_iterated_by_character",
        "page_diagnostics": [diagnostic("doc-a", 1, R_SCANNED)],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "unknown_reasons_ignored",
        "page_diagnostics": [
            diagnostic("doc-a", 1, ["custom_reason", R_GEOMETRY_UNAVAILABLE, R_SCANNED, "PAGE_WITHOUT_TEXT_LAYER"]),
        ],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "two_codes_interleaved_across_documents",
        "page_diagnostics": [
            diagnostic("doc-1", 1, [R_FORMULA]),
            diagnostic("doc-2", 1, [R_MULTI_COLUMN]),
            diagnostic("doc-1", 1, [R_TABLE_GRID]),
        ],
        "pages": [["doc-1", 1], ["doc-2", 1]],
    },
    {
        "name": "first_seen_reason_order_within_code",
        "page_diagnostics": [
            diagnostic("doc-a", 1, [R_TABLE_GRID, R_FORMULA, R_TABLE_GRID]),
        ],
        "pages": [["doc-a", 1]],
    },
    {
        "name": "all_seven_reasons_on_one_page",
        "page_diagnostics": [
            diagnostic(
                "doc-a",
                1,
                [
                    R_SCANNED,
                    R_MULTI_COLUMN,
                    R_COLUMN_ORDER_AMBIGUOUS,
                    R_TABLE_GRID,
                    R_FORMULA,
                    R_GEOMETRY_UNAVAILABLE,
                    R_TOO_MANY_FRAGMENTS,
                ],
            ),
        ],
        "pages": [["doc-a", 1]],
    },
]

REVIEW_INPUTS = [
    [],
    [R_SCANNED],
    [R_MULTI_COLUMN],
    [R_COLUMN_ORDER_AMBIGUOUS],
    [R_TABLE_GRID],
    [R_FORMULA],
    [R_GEOMETRY_UNAVAILABLE],
    [R_TOO_MANY_FRAGMENTS],
    [R_SCANNED, R_MULTI_COLUMN, R_COLUMN_ORDER_AMBIGUOUS, R_TABLE_GRID, R_FORMULA],
    [R_FORMULA, R_TABLE_GRID, R_MULTI_COLUMN, R_SCANNED],
    [R_MULTI_COLUMN, R_SCANNED, R_MULTI_COLUMN, R_SCANNED],
    [R_GEOMETRY_UNAVAILABLE, R_TOO_MANY_FRAGMENTS, R_MULTI_COLUMN, R_GEOMETRY_UNAVAILABLE],
    ["unknown_reason", R_TABLE_GRID, ""],
    ALL_REASONS,
    None,
    "",
    R_MULTI_COLUMN,
]

CODE_INPUTS = [
    *REVIEW_INPUTS,
    [R_FORMULA, R_SCANNED],
    [R_TABLE_GRID, R_COLUMN_ORDER_AMBIGUOUS],
    [R_SCANNED, R_MULTI_COLUMN, R_TABLE_GRID, R_COLUMN_ORDER_AMBIGUOUS, R_FORMULA],
]


def build() -> dict:
    return {
        "note": (
            "Generated by scripts/gen_ingestion_layout_golden.py from the real "
            "apps.ingestion.services.layout functions. Do not hand-edit."
        ),
        "constants": {
            "reason_scanned": layout.REASON_SCANNED,
            "reason_multi_column": layout.REASON_MULTI_COLUMN,
            "reason_column_order_ambiguous": layout.REASON_COLUMN_ORDER_AMBIGUOUS,
            "reason_table_grid": layout.REASON_TABLE_GRID,
            "reason_formula": layout.REASON_FORMULA,
            "reason_geometry_unavailable": layout.REASON_GEOMETRY_UNAVAILABLE,
            "reason_too_many_fragments": layout.REASON_TOO_MANY_FRAGMENTS,
            "issue_multi_column": layout.ISSUE_MULTI_COLUMN,
            "issue_table_formula": layout.ISSUE_TABLE_FORMULA,
            "issue_scanned": layout.ISSUE_SCANNED,
            "issue_cross_page": layout.ISSUE_CROSS_PAGE,
            "reason_to_issue": dict(layout.REASON_TO_ISSUE),
            "issue_order": list(layout.ISSUE_ORDER),
            "issue_messages": dict(layout.ISSUE_MESSAGES),
        },
        "issue_for_reason": [
            {"reason": reason, "issue": layout.issue_for_reason(reason)}
            for reason in [*ALL_REASONS, *UNKNOWN_REASONS]
        ],
        "reasons_needing_review": [
            {"reasons": reasons, "result": layout.reasons_needing_review(reasons)}
            for reasons in REVIEW_INPUTS
        ],
        "needs_review": [
            {"reasons": reasons, "result": layout.needs_review(reasons)}
            for reasons in REVIEW_INPUTS
        ],
        "issue_codes_for_reasons": [
            {"reasons": reasons, "result": layout.issue_codes_for_reasons(reasons)}
            for reasons in CODE_INPUTS
        ],
        "layout_review_issues": [
            {
                "name": case["name"],
                "page_diagnostics": case["page_diagnostics"],
                "pages": case["pages"],
                "result": layout.layout_review_issues(
                    page_diagnostics=case["page_diagnostics"],
                    pages=[tuple(page) for page in case["pages"]],
                ),
            }
            for case in LAYOUT_CASES
        ],
    }


def main() -> int:
    payload = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT}: "
        f"{len(payload['layout_review_issues'])} layout cases, "
        f"{len(payload['issue_for_reason'])} issue_for_reason, "
        f"{len(payload['reasons_needing_review'])} reasons_needing_review, "
        f"{len(payload['needs_review'])} needs_review, "
        f"{len(payload['issue_codes_for_reasons'])} issue_codes_for_reasons"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
