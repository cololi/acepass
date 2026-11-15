#!/usr/bin/env python
"""Golden vectors for B4: native-text PDF extraction and layout diagnosis.

Oracle: the *real* ``apps.ingestion.services.pdf_text`` functions and the *real*
``backend/tests/support/pdf_builder.py`` generators. Nothing in this file
re-implements a rule — every ``expected`` block below is what the Python function
returned for the recorded input, so a vector that disagrees with the TypeScript
port is a port defect, not a stale expectation.

Why the vectors look the way they do
------------------------------------
The extractor is deliberately dumb: plain arithmetic on PDF coordinates, no OCR,
no model. The parts that are easy to transliterate *wrong* are therefore the
knife edges, and those are what this corpus pins:

* every threshold is compared with a specific operator — ``<`` for the fragment
  count and the gutter, ``<=`` for the line/x tolerances and the grid alignment,
  ``<`` again for the vertical overlap and the "is this page scanned" character
  count. A ``<=`` where the source has ``<`` flips half of these vectors.
* ``_detect_columns`` has three distinct "no columns" exits (fewer than six
  fragments, fewer than two big-enough clusters, no qualifying pair) and all of
  them return ``(1, True)`` — ``unambiguous`` stays *true* because there is
  nothing to be ambiguous about.
* ``needs_review`` is driven by ``REASON_TO_ISSUE`` only: ``geometry_unavailable``
  and ``too_many_fragments`` are recorded but never block.
* a page whose columns *could* be reordered is only reordered when the rebuild
  keeps every visible character; otherwise the extractor's own order wins and the
  page is downgraded. Text is never lost to a layout guess.

Determinism
-----------
Every byte is produced by the builder (which writes its own xref table and a
``ToUnicode`` CMap, so no font file is embedded) or by ``pypdf``'s deterministic
RC4-128 writer (its document id is a checksum of the structure, not a random
value). No clock, no randomness, no absolute path, and ``json.dumps`` with
``ensure_ascii=False, indent=1, sort_keys=True`` — a rerun is byte-identical and
the script prints the sha256 of what it wrote.

What is *not* portable, and is therefore flagged per fixture
------------------------------------------------------------
Every fixture records which builder produced it, because the three builders do not
have the same fidelity through pypdf:

* ``build_layout_pdf`` places each run with an explicit ``1 0 0 1 x y Tm``, so its
  baselines are comparable bit for bit (``fragment_y_comparable: true``);
* ``build_text_pdf`` / ``build_scanned_pdf`` break lines with ``T*`` + ``TL``, and
  ``pypdf/_page.py:1988`` multiplies the leading by the font size
  (``TL = float(operands[0]) * font_size * scale_x`` — the spec says TL is already
  in unscaled text space units). A 5-line page laid out at 800/786/772/758/744 is
  therefore reported at 800/632/464/296/128: a 168 pt step instead of 14 pt. The
  values are still recorded verbatim — pypdf is the oracle — but only their
  monotonicity survives a second extractor, so those fixtures are marked
  ``fragment_y_comparable: false``;
* ``metadata`` has the same problem on a smaller scale: ``/Title`` is written as
  UTF-8 bytes without a BOM, which is not valid PDFDocEncoding, so pypdf keeps it
  as a byte string and ``str()`` yields Python's ``bytes`` repr. Each fixture
  lists ``metadata_comparable`` (only ``/Producer``) so a second reader is never
  held to a repr it cannot reproduce.

Two things are described rather than embedded:

* ``errors.too_large`` — 40 MiB + 9 bytes of ``%PDF-1.7`` + zeros; ``synthetic``
  says exactly how to rebuild it, Node has to hash the reconstruction itself;
* the geometry *threshold* cases use a 512x512 media box instead of 595x842. That
  is not decoration: ``12/595`` is not representable in binary floating point, so
  a gutter of *exactly* 12 pt would land on whichever side of ``gutter_end -
  gutter_start < 12/595`` the rounding happens to fall (measured: it falls on the
  "not a gutter" side). With 512 every threshold in these vectors is an exact
  binary fraction and the comparison tests the operator, not the rounding.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/gen_ingestion_b4_pdf_golden.py

No database is touched: ``django.setup()`` is only needed to import the service
modules, and ``config.settings.test`` keeps that side-effect free.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from apps.common.errors import InvalidInput  # noqa: E402
from apps.ingestion.services import layout, pdf_text  # noqa: E402
from tests.support.pdf_builder import (  # noqa: E402
    build_layout_pdf,
    build_scanned_pdf,
    build_text_pdf,
)

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "ingestion_b4_pdf.json"

#: The media box the *fixtures* are built with (what `pdf_builder` defaults to).
PAGE_BOX = (0.0, 0.0, 595.0, 842.0)
#: The media box the *threshold* vectors are built with: every threshold constant
#: (3 pt, 12 pt, 6 pt, half a page) is an exact binary fraction of 512, so the
#: comparison under test is the operator rather than a rounding accident.
EXACT_BOX = (0.0, 0.0, 512.0, 512.0)

#: Two-column layout of the reference integration test (`test_p2_layout_import`).
LEFT_X = 60.0
RIGHT_X = 330.0
TOP_Y = 800.0
STEP = 30.0


# ==========================================================================
# fixtures: real PDFs, real extraction
# ==========================================================================
def _question(number: int, prefix: str, stem: str) -> list[str]:
    """One short single-choice question, exactly as the P2 test builds it."""
    return [
        f"{number}．【题型】单选题",
        f"【题干】{prefix}第{number}题：{stem}",
        "【选项】",
        "A. 甲",
        "B. 乙",
    ]


def _two_column_page(left_lines: list[str], right_lines: list[str], *, step: float = STEP) -> list[dict]:
    """Interleave the two columns in content-stream order (the *wrong* order)."""
    fragments: list[dict] = []
    for index in range(max(len(left_lines), len(right_lines))):
        y = TOP_Y - index * step
        if index < len(left_lines):
            fragments.append({"x": LEFT_X, "y": y, "text": left_lines[index]})
        if index < len(right_lines):
            fragments.append({"x": RIGHT_X, "y": y, "text": right_lines[index]})
    return fragments


PAGE_ONE_TEXT = "\n".join(
    [
        *_question(1, "卷一", "下列说法正确的是？"),
        *_question(2, "卷一", "下列判断错误的是？"),
    ]
)
PAGE_TWO_TEXT = "\n".join(
    [
        *_question(3, "卷二", "偶函数的图像对称吗？"),
        *_question(4, "卷二", "下列集合为空集的是？"),
    ]
)

LEFT_COLUMN = [
    *_question(1, "左栏", "下列说法正确的是？"),
    *_question(2, "左栏", "下列判断错误的是？"),
    *_question(3, "左栏", "偶函数的图像对称吗？"),
    *_question(4, "左栏", "下列集合为空集的是？"),
]
RIGHT_COLUMN = [
    *_question(5, "右栏", "下列命题正确的是？"),
    *_question(6, "右栏", "下列函数递增的是？"),
    *_question(7, "右栏", "该数列收敛吗？"),
    *_question(8, "右栏", "下列不等式成立的是？"),
]

TABLE_ROWS = [
    ("年份", "PM2.5", "优良天数"),
    ("2020", "35", "300"),
    ("2021", "31", "320"),
    ("2022", "28", "330"),
]

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
    {"x": LEFT_X, "y": 450.0, "text": "【材料一】某市连续三年的空气质量监测数据如上表所示。"},
    {"x": LEFT_X, "y": 420.0, "text": "【子题2】【题型】单选题"},
    {"x": LEFT_X, "y": 390.0, "text": "【题干】根据材料，下列说法正确的是？"},
    {"x": LEFT_X, "y": 360.0, "text": "【选项】"},
    {"x": LEFT_X, "y": 330.0, "text": "A. 甲"},
    {"x": LEFT_X, "y": 300.0, "text": "B. 乙"},
]

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

#: A page with a real text layer, used either side of an image-only page.
NATIVE_PAGE_TEXT = "\n".join(
    [
        "1．【题型】单选题",
        "【题干】原生页第一题：下列说法正确的是？",
        "【选项】",
        "A. 甲",
        "B. 乙",
    ]
)

#: The same one-page document the reference test publishes unchanged.
NORMAL_PAGE_TEXT = "\n".join(
    [
        "1．【题型】单选题",
        "【题干】普通页面第一题：下列说法正确的是？",
        "【选项】",
        "A. 甲",
        "B. 乙",
    ]
)


def _encrypt(pdf_bytes: bytes, *, user_password: str, owner_password: str = "owner") -> bytes:
    """Re-encrypt a fixture with the deterministic RC4-128 writer.

    ``PdfWriter.generate_file_identifiers`` derives ``/ID`` from a checksum of the
    document it just built (``pypdf`` documents "reproducibility is not required"
    for the *identifier*, but the value it produces here is structural, not
    random), and RC4-128's key derivation has no salt, so two runs of this
    function on the same input produce the same bytes. That is asserted by the
    sha256 recorded in the golden file: if a future pypdf starts salting the ID,
    the vector goes red instead of silently drifting.
    """
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes)))
    writer.encrypt(
        user_password=user_password,
        owner_password=owner_password,
        algorithm="RC4-128",
    )
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _zero_page_pdf() -> bytes:
    """Hand-built ``/Pages /Kids [] /Count 0`` — a structurally valid empty PDF."""
    out = bytearray(b"%PDF-1.7\n")
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [] /Count 0 >>",
    ]
    offsets: list[int] = []
    for number, body in enumerate(bodies, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 3\n0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % xref_at
    return bytes(out)


def _fragment_record(fragment: pdf_text.PdfFragment) -> dict:
    return {
        "x": fragment.x,
        "y": fragment.y,
        "width": fragment.width,
        "height": fragment.height,
        "text": fragment.text,
    }


def _page_record(page: pdf_text.PdfPage) -> dict:
    return {
        "page_index": page.page_index,
        "text": page.text,
        "character_count": page.character_count,
        "fragment_count": len(page.fragments),
        "fragments": [_fragment_record(fragment) for fragment in page.fragments],
        "columns": page.columns,
        "has_table_grid": page.has_table_grid,
        "has_formula_tokens": page.has_formula_tokens,
        "is_scanned": page.is_scanned,
        "reading_order_reliable": page.reading_order_reliable,
        "diagnostics": list(page.diagnostics),
        "diagnostic_row": page.diagnostic_row(),
    }


def _fixture_record(
    content: bytes,
    extraction: pdf_text.PdfExtraction,
    *,
    builder: str,
    metadata_comparable: list[str],
) -> dict:
    return {
        "builder": builder,
        # Only `build_layout_pdf` places every run with an explicit `1 0 0 1 x y Tm`,
        # so only its baselines survive the pypdf `TL` defect unchanged (see notes).
        "fragment_y_comparable": builder == "layout",
        "metadata_comparable": list(metadata_comparable),
        "base64": base64.b64encode(content).decode("ascii"),
        "sha256": hashlib.sha256(content).hexdigest(),
        "bytes": len(content),
        "page_count": extraction.page_count,
        "character_count": extraction.character_count,
        "empty_pages": list(extraction.empty_pages),
        "metadata": extraction.metadata,
        "text": extraction.text,
        "page_map": [list(entry) for entry in extraction.page_map()],
        "pages": [_page_record(page) for page in extraction.pages],
    }


def build_fixtures() -> dict:
    """Every accepted document: real bytes in, real extraction out."""
    #: name -> (builder kind, bytes factory)
    builders: dict[str, tuple[str, object]] = {
        "text_two_pages": ("text", lambda: build_text_pdf([PAGE_ONE_TEXT, PAGE_TWO_TEXT])),
        "two_columns": (
            "layout",
            lambda: build_layout_pdf([_two_column_page(LEFT_COLUMN, RIGHT_COLUMN)]),
        ),
        "table_formula": ("layout", lambda: build_layout_pdf([FORMULA_PAGE])),
        "cross_page": ("layout", lambda: build_layout_pdf([CROSS_PAGE_ONE, CROSS_PAGE_TWO])),
        "mixed_scanned": (
            "scanned",
            lambda: build_scanned_pdf([NATIVE_PAGE_TEXT, None, NATIVE_PAGE_TEXT]),
        ),
        "normal_page": ("text", lambda: build_text_pdf([NORMAL_PAGE_TEXT])),
        # An empty *user* password is still a document without a password: the
        # extractor unlocks it and continues instead of refusing (see `errors`
        # for the same file with a non-empty password).
        "encrypted_empty_user_password": (
            "text",
            lambda: _encrypt(build_text_pdf([NORMAL_PAGE_TEXT]), user_password=""),
        ),
    }
    fixtures: dict[str, dict] = {}
    for name in sorted(builders):
        builder, factory = builders[name]
        content = factory()
        extraction = pdf_text.extract_native_text(content)
        # Only /Producer is portable: /Title is a UTF-8 byte string pypdf hands
        # back as bytes (see notes), and no fixture carries /Creator.
        metadata_comparable = [key for key in ("producer",) if key in extraction.metadata]
        fixtures[name] = _fixture_record(
            content,
            extraction,
            builder=builder,
            metadata_comparable=metadata_comparable,
        )
    return fixtures


# ==========================================================================
# errors: every refusal the extractor can produce
# ==========================================================================
def _refusal(name: str, content: bytes) -> dict:
    """Run the extractor and record the refusal verbatim (message + details)."""
    record: dict = {
        "name": name,
        "base64": base64.b64encode(content).decode("ascii"),
        "sha256": hashlib.sha256(content).hexdigest(),
        "bytes": len(content),
    }
    try:
        pdf_text.extract_native_text(content)
    except InvalidInput as exc:
        record["error"] = {"message": exc.message, "details": exc.details}
    else:  # pragma: no cover - the corpus is chosen so this never fires
        raise SystemExit(f"{name}: expected the extractor to refuse, it did not")
    return record


def build_errors() -> list[dict]:
    too_large = b"%PDF-1.7\n" + b"0" * (pdf_text.MAX_PDF_BYTES)
    too_much_text = build_text_pdf(["甲" * (pdf_text.MAX_TEXT_CHARS + 10)])
    too_many_pages = build_text_pdf(
        [f"{index}．【题型】单选题\n【题干】第{index}题\n【选项】\nA. 甲\nB. 乙" for index in range(1, 202)]
    )

    cases = [
        ("empty_file", b""),
        ("not_pdf", b"not a pdf at all"),
        ("damaged", b"%PDF-1.7\n" + b"garbage..." * 40),
        (
            "encrypted",
            _encrypt(build_text_pdf([NORMAL_PAGE_TEXT]), user_password="secret"),
        ),
        ("no_pages", _zero_page_pdf()),
        ("too_many_pages", too_many_pages),
        ("too_much_text", too_much_text),
        ("no_text_layer", build_scanned_pdf([None])),
    ]

    records = [_refusal(name, content) for name, content in cases]

    # 40 MiB is not going into a golden file: describe it instead, keep the facts
    # (bytes, sha256) exact so the Node test can rebuild and verify it.
    record = {
        "name": "too_large",
        "sha256": hashlib.sha256(too_large).hexdigest(),
        "bytes": len(too_large),
        "synthetic": {
            "kind": "zeros",
            "length": pdf_text.MAX_PDF_BYTES,
            "prefix": "%PDF-1.7\n",
        },
    }
    try:
        pdf_text.extract_native_text(too_large)
    except InvalidInput as exc:
        record["error"] = {"message": exc.message, "details": exc.details}
    else:  # pragma: no cover
        raise SystemExit("too_large: expected the extractor to refuse, it did not")
    records.append(record)

    return sorted(records, key=lambda item: item["name"])


# ==========================================================================
# layout: standardised fragment input -> real thresholds
# ==========================================================================
def _item(text: str, x_pt: float, y_pt: float, size: float = 10.0) -> dict:
    return {"text": text, "x_pt": float(x_pt), "y_pt": float(y_pt), "size": float(size)}


def _band(x_pt: float, ys: list[float], text: str = "甲", size: float = 10.0) -> list[dict]:
    return [_item(text, x_pt, y, size) for y in ys]


def _column_page(left: list[dict], right: list[dict]) -> list[dict]:
    """Row-major interleave of two bands — the content-stream order of a real
    two-column page, i.e. the *wrong* reading order."""
    items: list[dict] = []
    for index in range(max(len(left), len(right))):
        if index < len(left):
            items.append(left[index])
        if index < len(right):
            items.append(right[index])
    return items


def _layout_expected(items: list[dict], text: str, box: tuple, truncated: bool) -> dict:
    """Everything one case asserts, produced by the extractor's own functions."""
    notes = pdf_text._PageNotes(
        width_pt=box[2] - box[0],
        height_pt=box[3] - box[1],
        truncated=truncated,
    )
    fragments = [
        pdf_text._fragment(str(item["text"]), item["x_pt"], item["y_pt"], item["size"], box)
        for item in items
    ]
    # `_lines` / `_x_clusters` sort, so map the objects back to their input index
    # by identity: two *equal* fragments are still two distinct objects here.
    index_of = {id(fragment): index for index, fragment in enumerate(fragments)}

    lines = [[index_of[id(fragment)] for fragment in line] for line in pdf_text._lines(fragments, notes.y_tolerance)]
    clusters = [
        [index_of[id(fragment)] for fragment in cluster]
        for cluster in pdf_text._x_clusters(fragments, notes.x_tolerance)
    ]
    join_lines = [
        pdf_text._join_line([fragments[index] for index in line]) for line in lines
    ]

    # The exact sequence of `extract_native_text` for one page: classify, then
    # reorder (which may append a reason), then build. `facts` is snapshotted
    # after the reorder because that is the state the stored row reflects.
    cleaned = pdf_text._normalise(text)
    facts = pdf_text._page_layout(cleaned, fragments, notes)
    ordered = pdf_text._ordered_page_text(cleaned, fragments, notes, facts)
    page = pdf_text._build_page(1, ordered, fragments, facts)

    columns, unambiguous = pdf_text._detect_columns(
        fragments, x_tolerance=notes.x_tolerance, gutter_width=notes.gutter_width
    )
    table_grid = pdf_text._detect_table_grid(
        fragments, y_tolerance=notes.y_tolerance, x_tolerance=notes.grid_x_tolerance
    )
    formula = pdf_text._detect_formula_tokens(cleaned)

    return {
        "fragments": [_fragment_record(fragment) for fragment in fragments],
        "lines": lines,
        "x_clusters": clusters,
        "join_lines": join_lines,
        "visible_characters": pdf_text._visible_characters(ordered),
        "columns": columns,
        "unambiguous": unambiguous,
        "table_grid": table_grid,
        "formula": formula,
        "facts": {
            "columns": facts.columns,
            "unambiguous": facts.unambiguous,
            "has_table_grid": facts.has_table_grid,
            "has_formula_tokens": facts.has_formula_tokens,
            "is_scanned": facts.is_scanned,
            "reading_order_reliable": facts.reading_order_reliable,
            "reasons": list(facts.reasons),
        },
        "ordered_text": ordered,
        "diagnostic_row": page.diagnostic_row(),
    }


def _case(
    name: str,
    kind: str,
    items: list[dict],
    *,
    text: str | None = None,
    box: tuple = EXACT_BOX,
    truncated: bool = False,
) -> dict:
    """One layout vector: the input is what the Node test replays."""
    if text is None:
        text = "\n".join(item["text"] for item in items)
    recorded: dict = {"page_box": [float(value) for value in box], "text": text}
    if truncated:
        recorded["truncated"] = True
    recorded["items"] = [
        {
            "text": item["text"],
            "x_pt": item["x_pt"],
            "y_pt": item["y_pt"],
            "size": item["size"],
        }
        for item in items
    ]
    return {
        "name": name,
        "kind": kind,
        "input": recorded,
        "expected": _layout_expected(items, text, box, truncated),
    }


def _formula_case(name: str, text: str) -> dict:
    """One text-only formula vector; the single fragment keeps `lines` non-empty."""
    return _case(name, "formula", [_item(text, 40.0, 480.0)], text=text)


def column_cases() -> list[dict]:
    """`_detect_columns`: every exit and every threshold, both sides."""
    # 3 fragments at y=500/370/240 span 260+12 = 272 pt of a 512 pt page (0.531).
    tall = [500.0, 370.0, 240.0]
    # 3 fragments at step 122 span 244+12 = 256 pt = exactly half the page.
    exact_half = [500.0, 378.0, 256.0]
    under_half = [500.0, 381.0, 262.0]

    left_wide = _band(40.0, [500.0 - index * 28.0 for index in range(17)])
    left_18 = _band(40.0, [500.0 - index * 28.0 for index in range(18)])
    right_wide = _band(300.0, tall)
    right_pair = _band(300.0, [500.0, 240.0])

    # 34 + 6 = 40 fragments: int(40 * 0.15) == 6, so a 6-run band qualifies ...
    dense_left = _band(40.0, [500.0 - index * 15.0 for index in range(34)])
    dense_right_six = _band(300.0, [500.0 - index * 49.0 for index in range(6)])
    left_plus_one = _band(40.0, [500.0 - index * 14.0 for index in range(35)])
    # ... and a 5-run band is dropped before the geometry is even looked at.
    dense_right_five = _band(300.0, [500.0 - index * 61.0 for index in range(5)])

    # Crossing runs: a 4-CJK-character run at size 10 is 40 pt wide, so it starts
    # at the left band's x and reaches past the 12 pt gutter (50 -> 62).
    quarter_left = [
        _item("跨栏标题四字" if index % 2 else "甲", 40.0, 500.0 - index * 28.0)
        for index in range(10)
    ]
    quarter_right = _band(62.0, [500.0 - index * 28.0 for index in range(10)])
    just_over_left = [
        _item("跨栏标题四字" if index % 2 else "甲", 40.0, 500.0 - index * 10.0)
        for index in range(26)
    ]
    just_over_right = _band(62.0, [500.0 - index * 11.0 for index in range(24)])

    # Three bands, staggered by 5 pt so no baseline carries three cells (which
    # would also trip the table-grid detector) while every band still spans 0.7.
    three_bands = [
        *_band(40.0, [490.0, 317.0, 144.0]),
        *_band(150.0, [485.0, 312.0, 139.0]),
        *_band(260.0, [480.0, 307.0, 134.0]),
    ]

    return [
        _case(
            "columns_fewer_than_six_fragments_returns_single",
            "columns",
            [*_band(40.0, [500.0, 450.0, 400.0]), *_band(300.0, [500.0, 450.0])],
        ),
        _case(
            "columns_two_bands_no_crossing_is_unambiguous",
            "columns",
            _column_page(_band(40.0, tall), _band(300.0, tall)),
        ),
        _case(
            "columns_cluster_share_n20_three_fragments_qualifies",
            "columns",
            _column_page(left_wide, right_wide),
        ),
        _case(
            "columns_cluster_share_n20_two_fragments_dropped",
            "columns",
            _column_page(left_18, right_pair),
        ),
        _case(
            "columns_cluster_share_n40_six_fragments_qualifies",
            "columns",
            _column_page(dense_left, dense_right_six),
        ),
        _case(
            "columns_cluster_share_n40_five_fragments_dropped",
            "columns",
            _column_page(left_plus_one, dense_right_five),
        ),
        _case(
            "columns_gutter_exactly_12pt_qualifies",
            "columns",
            _column_page(_band(40.0, tall), _band(62.0, tall)),
        ),
        _case(
            "columns_gutter_11_9pt_does_not_qualify",
            "columns",
            _column_page(_band(40.0, tall), _band(61.9, tall)),
        ),
        _case(
            "columns_vertical_overlap_exactly_half_page_qualifies",
            "columns",
            _column_page(_band(40.0, exact_half), _band(300.0, exact_half)),
        ),
        _case(
            "columns_vertical_overlap_under_half_page_does_not_qualify",
            "columns",
            _column_page(_band(40.0, under_half), _band(300.0, under_half)),
        ),
        _case(
            "columns_crossing_ratio_exactly_quarter_is_ambiguous_not_rejected",
            "columns",
            _column_page(quarter_left, quarter_right),
        ),
        _case(
            "columns_crossing_ratio_0_26_is_rejected",
            "columns",
            _column_page(just_over_left, just_over_right),
        ),
        _case("columns_three_bands", "columns", three_bands),
    ]


def grid_cases() -> list[dict]:
    """`_detect_table_grid`: row count, row width and the 6 pt alignment edge."""
    def rows(offsets: list[float], *, columns: int = 3, step: float = 30.0, top: float = 400.0) -> list[dict]:
        items: list[dict] = []
        for index, offset in enumerate(offsets):
            for column in range(columns):
                items.append(_item("元", 60.0 + column * 60.0 + offset, top - index * step))
        return items

    def stray_third_column() -> list[dict]:
        items: list[dict] = []
        for index, x in enumerate([200.0, 220.0, 240.0]):
            for column in range(2):
                items.append(_item("元", 60.0 + column * 60.0, 400.0 - index * 30.0))
            items.append(_item("元", x, 400.0 - index * 30.0))
        return items

    return [
        _case("grid_three_rows_three_columns", "grid", rows([0.0, 0.0, 0.0])),
        _case("grid_two_rows_is_not_a_grid", "grid", rows([0.0, 0.0])),
        _case("grid_two_cells_per_row_is_not_a_grid", "grid", rows([0.0, 0.0, 0.0], columns=2)),
        _case("grid_column_offset_6pt_still_aligned", "grid", rows([0.0, 6.0, 6.0])),
        # A single bad row is not enough: with offsets 0/6.1/0 rows 0 and 2 still
        # share three columns, so the grid is detected anyway. Only a *drift*
        # (no two rows share a column) exercises the 6 pt tolerance as a refusal.
        _case("grid_each_row_drifts_6_1pt_is_misaligned", "grid", rows([0.0, 6.1, 12.2])),
        _case("grid_only_two_columns_line_up", "grid", stray_third_column()),
    ]


def formula_cases() -> list[dict]:
    """`_detect_formula_tokens`: strong symbols, scrubbed blanks, construct count."""
    return [
        _formula_case("formula_single_strong_symbol", "已知 ∫ 的值是（　）。"),
        _formula_case("formula_blank_run_is_not_a_subscript", "请在 ____ 处填写答案。"),
        _formula_case("formula_single_superscript_is_not_enough", "关于 x^2 与 y 的关系，正确的是？"),
        _formula_case("formula_two_constructs_are_enough", "比较 x^2 与 y^2 的大小。"),
        _formula_case(
            "formula_latex_frac_and_superscript",
            r"已知 f(x)=\frac{1}{2}x^{2}+\sqrt{3}，求值。",
        ),
        _formula_case("formula_single_times_is_not_enough", "3×4 的积是多少？"),
        _formula_case("formula_times_and_divide_are_enough", "计算 3×4÷2。"),
        _formula_case("formula_two_subscripts_are_enough", "数列 a_1 与 a_2 的大小关系？"),
        _formula_case("formula_empty_text", ""),
    ]


def ordering_cases() -> list[dict]:
    """`_page_layout` + `_ordered_page_text`: what is reordered and what is not."""
    single_column = [
        _item("1．【题型】单选题", 40.0, 480.0),
        _item("【题干】下列说法正确的是？", 40.0, 450.0),
        _item("【选项】", 40.0, 420.0),
        _item("A. 甲", 40.0, 390.0),
        _item("B. 乙", 40.0, 360.0),
    ]
    rows = [500.0 - index * 49.0 for index in range(6)]
    left = _band(40.0, rows)
    right = _band(300.0, rows)
    row_major = "\n".join(text for pair in zip(left, right, strict=True) for text in (pair[0]["text"], pair[1]["text"]))

    # The same page with a 12 pt gutter and a full-width heading that reaches
    # across it: the gutter survives (a crossing run is not "contained"), the
    # page becomes ambiguous and the source order is kept.
    crossing_rows = [470.0 - index * 49.0 for index in range(6)]
    crossing_left = _band(40.0, crossing_rows)
    crossing_right = _band(62.0, crossing_rows)
    headline = _item("跨栏标题", 40.0, 500.0)
    ambiguous_items = [headline, *_column_page(crossing_left, crossing_right)]
    ambiguous_text = "\n".join(
        [headline["text"]]
        + [
            text
            for pair in zip(crossing_left, crossing_right, strict=True)
            for text in (pair[0]["text"], pair[1]["text"])
        ]
    )

    dense = [
        _item("行", 40.0 + (index % 10) * 14.0, 400.0 - (index // 10) * 20.0)
        for index in range(20)
    ]

    return [
        _case(
            "ordering_single_column_keeps_text",
            "ordering",
            single_column,
            text="1．【题型】单选题\n【题干】下列说法正确的是？\n【选项】\nA. 甲\nB. 乙",
        ),
        _case(
            "ordering_two_columns_rebuilt_column_major",
            "ordering",
            _column_page(left, right),
            text=row_major,
        ),
        _case(
            "ordering_two_columns_with_crossing_keep_source_order",
            "ordering",
            ambiguous_items,
            text=ambiguous_text,
        ),
        # Unambiguous columns, but the text layer carries a line no fragment
        # describes: the rebuild would drop it, so the source text wins and the
        # page is downgraded *even though* the geometry was unambiguous.
        _case(
            "ordering_rebuild_losing_characters_falls_back_to_source_text",
            "ordering",
            _column_page(left, right),
            text=row_major + "\n只在文本层里的一行",
        ),
        _case(
            "ordering_geometry_unavailable_is_not_blocking",
            "ordering",
            [],
            text="1．【题型】单选题\n【题干】没有几何信息的一页",
        ),
        _case(
            "ordering_truncated_marks_reading_order_unreliable",
            "ordering",
            dense,
            text="行\n行\n行",
            truncated=True,
        ),
    ]


def scanned_cases() -> list[dict]:
    return [
        _case("scanned_page_without_text_layer", "scanned", [], text=""),
        _case("scanned_page_whitespace_only", "scanned", [], text="   \n\n"),
    ]


def misc_cases() -> list[dict]:
    """`_lines`, `_x_clusters` and `_join_line` at their own tolerances."""
    return [
        _case(
            "lines_exactly_3pt_apart_share_a_line",
            "misc",
            [_item("甲", 40.0, 400.0), _item("乙", 100.0, 397.0)],
            text="甲 乙",
        ),
        _case(
            "lines_4pt_apart_are_two_lines",
            "misc",
            [_item("甲", 40.0, 400.0), _item("乙", 100.0, 396.0)],
            text="甲\n乙",
        ),
        _case(
            "lines_compare_against_the_line_anchor_not_the_previous_run",
            "misc",
            [_item("甲", 40.0, 400.0), _item("乙", 40.0, 397.0), _item("丙", 40.0, 394.0)],
            text="甲\n乙\n丙",
        ),
        _case(
            "x_clusters_exactly_12pt_apart_share_a_cluster",
            "misc",
            [_item("甲", 100.0, 400.0), _item("乙", 112.0, 380.0)],
            text="甲\n乙",
        ),
        _case(
            "x_clusters_12_5pt_apart_split",
            "misc",
            [_item("甲", 100.0, 400.0), _item("乙", 112.5, 380.0)],
            text="甲\n乙",
        ),
        _case(
            "x_clusters_do_not_chain_from_the_previous_member",
            "misc",
            [_item("甲", 100.0, 400.0), _item("乙", 112.0, 380.0), _item("丙", 124.0, 360.0)],
            text="甲\n乙\n丙",
        ),
        _case(
            "join_line_gap_over_threshold_inserts_space",
            "misc",
            [_item("甲", 40.0, 400.0), _item("乙", 55.0, 400.0)],
            text="甲 乙",
        ),
        _case(
            "join_line_gap_under_threshold_stays_tight",
            "misc",
            [_item("甲", 40.0, 400.0), _item("乙", 53.0, 400.0)],
            text="甲乙",
        ),
    ]


def normalise_cases() -> list[dict]:
    inputs = [
        ("normalise_carriage_return", "第一行\r\n第二行"),
        ("normalise_trailing_line_spaces", "行尾空格   \n第二行"),
        ("normalise_trailing_blank_lines", "正文\n\n\n"),
        ("normalise_trailing_whitespace_lines", "正文\n \n\t\n"),
        ("normalise_negative_sign_and_unit_untouched", "-3.5 m/s，保持不变\n"),
        ("normalise_leading_indent_preserved", "  缩进保留\n"),
        ("normalise_empty_string", ""),
        ("normalise_only_blank_lines", "\n\n"),
    ]
    return [
        {"name": name, "input": text, "expected": pdf_text._normalise(text)} for name, text in inputs
    ]


def clamp_cases() -> list[dict]:
    inputs = [
        ("clamp_negative_origin", -0.2, 0.1, 0.5, 0.2),
        ("clamp_past_bottom_right", 0.5, 0.5, 0.9, 0.9),
        ("clamp_zero_size_gets_minimum", 0.3, 0.4, 0.0, 0.0),
        ("clamp_origin_past_right_edge", 1.2, 0.5, 0.1, 0.1),
        ("clamp_negative_size_gets_minimum", 0.5, 0.5, -0.2, -0.2),
        ("clamp_origin_past_bottom_edge", 0.5, 1.4, 0.2, 0.2),
        ("clamp_inside_box_is_untouched", 0.1, 0.2, 0.3, 0.4),
    ]
    return [
        {
            "name": name,
            "input": {"x": x, "y": y, "width": width, "height": height},
            "expected": pdf_text._clamp_bbox(x, y, width, height),
        }
        for name, x, y, width, height in inputs
    ]


def _page_with_fragments(items: list[dict], box: tuple = EXACT_BOX) -> pdf_text.PdfPage:
    fragments = tuple(
        pdf_text._fragment(str(item["text"]), item["x_pt"], item["y_pt"], item["size"], box)
        for item in items
    )
    return pdf_text.PdfPage(page_index=1, text="", character_count=0, fragments=fragments)


def bbox_cases() -> list[dict]:
    """`bbox_for_text`: both match arms, both refusal arms, and the clamp."""
    page_items = [
        _item("1．【题型】单选题", 40.0, 480.0),
        _item("【题干】已知函数 f(x) 在区间上单调递增", 40.0, 450.0),
        _item("A. 甲", 40.0, 420.0),
        _item("B. 乙", 40.0, 390.0),
    ]
    #: (name, the items the page is built from, needle) — `items` is emitted from
    #: this list, so a page with no geometry is recorded with no items.
    cases = [
        ("bbox_fragment_text_contained_in_needle", page_items, "1．【题型】单选题\nA. 甲"),
        (
            "bbox_needle_first_line_contained_in_fragment",
            page_items,
            "已知函数 f(x) 在区间上单调递增",
        ),
        ("bbox_no_fragment_matches", page_items, "完全不相干的题干内容"),
        ("bbox_empty_needle", page_items, ""),
        ("bbox_whitespace_needle", page_items, "   \n  "),
        ("bbox_page_without_fragments", [], "1．【题型】单选题"),
        ("bbox_single_fragment_matches_both_arms", [_item("A. 甲", 40.0, 420.0)], "A. 甲"),
    ]
    return [
        {
            "name": name,
            "items": [
                {"text": item["text"], "x_pt": item["x_pt"], "y_pt": item["y_pt"], "size": item["size"]}
                for item in items
            ],
            "page_box": [float(value) for value in EXACT_BOX],
            "needle": needle,
            "expected": pdf_text.bbox_for_text(_page_with_fragments(items), needle),
        }
        for name, items, needle in cases
    ]


def page_map_cases() -> list[dict]:
    inputs = [
        ("page_map_three_pages", ["a", "bb", "ccc"]),
        ("page_map_single_page", ["abc"]),
        ("page_map_empty_middle_page", ["aa", "", "bb"]),
        ("page_map_cjk_counts_code_points", ["甲乙", "丙"]),
        # An astral character is one code point in Python and two UTF-16 units in
        # JavaScript: the offsets pin the code-point reading.
        ("page_map_astral_character_is_one_code_point", ["𝄞x", "y"]),
    ]
    records = []
    for name, texts in inputs:
        pages = [
            pdf_text.PdfPage(page_index=index, text=text, character_count=len(text))
            for index, text in enumerate(texts, start=1)
        ]
        extraction = pdf_text.PdfExtraction(
            page_count=len(pages),
            pages=pages,
            character_count=sum(len(text) for text in texts),
        )
        records.append(
            {
                "name": name,
                "pages": texts,
                "expected": [list(entry) for entry in extraction.page_map()],
                "text": extraction.text,
            }
        )
    return records


def estimate_width_cases() -> list[dict]:
    inputs = [
        ("estimate_width_cjk_is_one_em", "甲", 12.0),
        ("estimate_width_latin_is_half_em", "abc", 12.0),
        ("estimate_width_mixed_matches_the_contract_example", "A. 甲", 12.0),
        ("estimate_width_empty_text_gets_minimum", "", 12.0),
        ("estimate_width_space_only_gets_minimum", " ", 12.0),
        ("estimate_width_em_dash_is_not_wide", "——", 12.0),
        ("estimate_width_fullwidth_punctuation_is_wide", "，。", 12.0),
        ("estimate_width_zero_size_degenerates", "甲", 0.0),
    ]
    return [
        {
            "name": name,
            "text": text,
            "size": size,
            "expected": pdf_text._estimate_width_pt(text, size),
        }
        for name, text, size in inputs
    ]


def build_layout() -> dict:
    return {
        "cases": [
            *column_cases(),
            *grid_cases(),
            *formula_cases(),
            *ordering_cases(),
            *scanned_cases(),
            *misc_cases(),
        ],
        "normalise": normalise_cases(),
        "clamp": clamp_cases(),
        "bbox": bbox_cases(),
        "page_map": page_map_cases(),
        "estimate_width": estimate_width_cases(),
    }


# ==========================================================================
# constants / definitions / notes
# ==========================================================================
def build_constants() -> dict:
    return {
        "max_pdf_bytes": pdf_text.MAX_PDF_BYTES,
        "max_pdf_pages": pdf_text.MAX_PDF_PAGES,
        "max_text_chars": pdf_text.MAX_TEXT_CHARS,
        "min_page_chars": pdf_text.MIN_PAGE_CHARS,
        "line_y_tolerance_pt": pdf_text.LINE_Y_TOLERANCE_PT,
        "column_x_tolerance_pt": pdf_text.COLUMN_X_TOLERANCE_PT,
        "column_min_fragments_per_cluster": pdf_text.COLUMN_MIN_FRAGMENTS_PER_CLUSTER,
        "column_min_cluster_share": pdf_text.COLUMN_MIN_CLUSTER_SHARE,
        "column_gutter_min_width_pt": pdf_text.COLUMN_GUTTER_MIN_WIDTH_PT,
        "column_min_vertical_overlap": pdf_text.COLUMN_MIN_VERTICAL_OVERLAP,
        "column_max_gutter_cross_ratio": pdf_text.COLUMN_MAX_GUTTER_CROSS_RATIO,
        "grid_row_min_fragments": pdf_text.GRID_ROW_MIN_FRAGMENTS,
        "grid_min_rows": pdf_text.GRID_MIN_ROWS,
        "grid_x_tolerance_pt": pdf_text.GRID_X_TOLERANCE_PT,
        "grid_min_aligned_columns": pdf_text.GRID_MIN_ALIGNED_COLUMNS,
        "grid_min_aligned_rows": pdf_text.GRID_MIN_ALIGNED_ROWS,
        "formula_strong_symbols": pdf_text.FORMULA_STRONG_SYMBOLS,
        "formula_construct_pattern": pdf_text.FORMULA_CONSTRUCT_PATTERN.pattern,
        "formula_min_constructs": pdf_text.FORMULA_MIN_CONSTRUCTS,
        "blank_marker_run": pdf_text.BLANK_MARKER_RUN.pattern,
        "max_fragments_per_page": pdf_text.MAX_FRAGMENTS_PER_PAGE,
        "default_font_size_pt": pdf_text.DEFAULT_FONT_SIZE_PT,
        "default_page_box": list(pdf_text.DEFAULT_PAGE_BOX),
        "min_region_size": pdf_text.MIN_REGION_SIZE,
        "show_text_operators": [operator.decode("ascii") for operator in pdf_text.SHOW_TEXT_OPERATORS],
        "reason_scanned": layout.REASON_SCANNED,
        "reason_multi_column": layout.REASON_MULTI_COLUMN,
        "reason_column_order_ambiguous": layout.REASON_COLUMN_ORDER_AMBIGUOUS,
        "reason_table_grid": layout.REASON_TABLE_GRID,
        "reason_formula": layout.REASON_FORMULA,
        "reason_geometry_unavailable": layout.REASON_GEOMETRY_UNAVAILABLE,
        "reason_too_many_fragments": layout.REASON_TOO_MANY_FRAGMENTS,
        "reason_to_issue": dict(layout.REASON_TO_ISSUE),
    }


DEFINITIONS = {
    "fixtures[name]": (
        "base64 is the exact PDF the Node test feeds to the extractor; sha256/bytes describe "
        "it; page_count/character_count/empty_pages/metadata/text/page_map/pages are the real "
        "PdfExtraction fields. pages[i].fragments carry (x, y, width, height, text) unrounded "
        "(compare with a 1e-9 tolerance); diagnostic_row is PdfPage.diagnostic_row()."
    ),
    "fixtures[name].builder": (
        "'text' = build_text_pdf, 'layout' = build_layout_pdf, 'scanned' = build_scanned_pdf."
    ),
    "fixtures[name].fragment_y_comparable": (
        "true only for the 'layout' builder, whose runs are placed with an explicit "
        "'1 0 0 1 x y Tm' per fragment so the baseline survives pypdf's TL defect unchanged. "
        "false for 'text'/'scanned': those pages break lines with 'T*' + 'TL', and pypdf "
        "multiplies the leading by the font size (pypdf/_page.py:1988), so the reported "
        "baseline of every line after the first is off by a constant factor — the value is "
        "still recorded verbatim, but only its monotonicity is portable."
    ),
    "fixtures[name].metadata_comparable": (
        "The metadata keys a second extractor can be held to. /Title is a UTF-8 byte string "
        "that pypdf keeps as bytes (str() then yields Python's bytes repr), which no other "
        "reader reproduces, so it is excluded; /Producer is plain ASCII and compares exactly."
    ),
    "fixtures[name].metadata": (
        "Exactly the keys the extractor emits (pdf_text._metadata): the builder writes /Title "
        "and /Producer and no /Creator, so 'creator' is absent rather than empty. Compare only "
        "the keys listed in metadata_comparable."
    ),
    "errors[]": (
        "The extractor was run on the bytes and refused: {message, details} are InvalidInput's "
        "own attributes. 'synthetic' replaces base64 for the 40 MiB case and says how to rebuild "
        "it; sha256/bytes still describe the rebuilt buffer."
    ),
    "layout.cases[].input": (
        "items are (text, x_pt, y_pt, size): PDF user space, origin bottom-left, y_pt is the "
        "baseline, exactly the convention tests/support/pdf_builder.py uses. page_box is the "
        "mediabox [left, bottom, right, top]. text is the page text the extractor would have got "
        "(row-major, i.e. the content-stream order). 'truncated' mirrors "
        "_PageNotes.truncated (the per-page fragment cap was hit)."
    ),
    "layout.cases[].expected.lines": (
        "python _lines(input fragments, LINE_Y_TOLERANCE_PT / page height) with every fragment "
        "mapped back to its index in input.items; -1 would mean a fragment the input never had."
    ),
    "layout.cases[].expected.x_clusters": "same mapping for _x_clusters(..., COLUMN_X_TOLERANCE_PT / page width).",
    "layout.cases[].expected.join_lines": "one _join_line() result per line, in _lines order.",
    "layout.cases[].expected.visible_characters": "_visible_characters(ordered_text) — every character except whitespace.",
    "layout.cases[].expected.columns": "a direct _detect_columns() call with the page's own tolerances.",
    "layout.cases[].expected.table_grid": "a direct _detect_table_grid() call with the page's own tolerances.",
    "layout.cases[].expected.formula": "a direct _detect_formula_tokens() call on the normalised text.",
    "layout.cases[].expected.facts": (
        "_LayoutFacts after the extractor's own sequence (_page_layout → _ordered_page_text), "
        "i.e. including any reason the rebuild appended."
    ),
    "layout.cases[].expected.ordered_text": "_ordered_page_text() result — the text a page stores.",
    "layout.cases[].expected.diagnostic_row": "_build_page(1, ordered_text, ...).diagnostic_row(), i.e. the stored row.",
    "layout.normalise": "_normalise(input) -> expected.",
    "layout.clamp": "_clamp_bbox(**input) -> expected.",
    "layout.bbox": "bbox_for_text(PdfPage built from items+page_box, needle) -> expected (null when there is nothing to match).",
    "layout.page_map": "PdfExtraction(page texts).page_map() -> [(page_index, start, end)] code-point offsets.",
    "layout.estimate_width": "_estimate_width_pt(text, size) -> expected.",
}


NOTES = [
    (
        "pypdf TL defect (fixtures with fragment_y_comparable=false): pypdf/_page.py:1988 "
        "computes `TL = float(operands[0]) * font_size * scale_x`, but per the PDF spec TL is "
        "already in unscaled text space units. Any page that breaks lines with T* + TL — which "
        "is how build_text_pdf and build_scanned_pdf place their text — therefore gets every "
        "baseline after the first multiplied by the font size: a 5-line build_text_pdf page "
        "lays out at 800/786/772/758/744 (14 pt apart) but pypdf reports "
        "800/632/464/296/128 (168 pt = 14 x 12). The fragments below still record pypdf's "
        "values verbatim (it is the oracle), so the Node side compares x/y only for "
        "builder='layout' and otherwise checks monotonicity of y plus the non-geometric facts."
    ),
    (
        "No `no_geometry` fixture: a page that yields text but no geometry is not reachable "
        "from bytes built by tests/support/pdf_builder.py. The builder always emits Tj/TJ runs, "
        "so both visitors fire; the only way _extract_page returns text with an empty fragment "
        "list is a visitor exception, which cannot be provoked deterministically from a valid "
        "PDF. Rather than invent one, the behaviour is pinned on the real function in "
        "layout.cases: ordering_geometry_unavailable_is_not_blocking (empty items + text) and, "
        "on the document side, by the scanned-only refusal in errors.no_text_layer."
    ),
    (
        "The layout threshold vectors use page_box [0, 0, 512, 512]. 12/595 is not exactly "
        "representable, so a 12 pt gutter on a 595 pt page lands on the 'not a gutter' side of "
        "`gutter_end - gutter_start < gutter_width` by a fraction of an ulp (measured). 512 "
        "makes 12/512, 3/512, 6/512 and 256/512 exact binary fractions, so those vectors test "
        "the comparison operators (< vs <=) rather than float rounding."
    ),
    (
        "fixtures[*].metadata.title is Python's repr of the raw byte string (\"b'AcePass "
        "\\\\xe6...'\"), not decoded text: a /Title written as UTF-8 bytes without a BOM is not "
        "valid PDFDocEncoding, so pypdf keeps it as a ByteStringObject and _metadata does "
        "str(value). pdfjs decodes the same bytes as mojibake, so the two are not comparable; "
        "that is why each fixture lists metadata_comparable (only /Producer) and the title is "
        "recorded for documentation, not for equality."
    ),
    (
        "The encrypted fixtures are deterministic because pypdf derives /ID from a checksum of "
        "the document structure and RC4-128 key derivation has no salt. The sha256 values are "
        "the proof: if a future pypdf salts either, the vectors fail loudly."
    ),
    (
        "errors.too_large carries 'synthetic' instead of base64 (40 MiB of zeros): "
        "prefix + '0' * length, sha256 recorded over the reconstruction."
    ),
    (
        "There is no fixture for MAX_FRAGMENTS_PER_PAGE truncation on a real document: it needs "
        "4005 fragments, which would put a ~0.5 MB fragment dump in this file. The flag is "
        "pinned through layout.cases ordering_truncated_marks_reading_order_unreliable, which "
        "sets _PageNotes.truncated exactly as the visitor does."
    ),
    (
        "Mixed-column ordering uses short one-character runs so the gutter arithmetic stays "
        "readable; that is why several column vectors share the same expected ordered_text "
        "pattern of 甲 lines."
    ),
]


# ==========================================================================
# main
# ==========================================================================
def build() -> dict:
    return {
        "note": (
            "Generated by scripts/gen_ingestion_b4_pdf_golden.py from the real "
            "apps.ingestion.services.pdf_text functions and the real "
            "tests/support/pdf_builder.py generators. Do not hand-edit."
        ),
        "constants": build_constants(),
        "definitions": DEFINITIONS,
        "fixtures": build_fixtures(),
        "errors": build_errors(),
        "layout": build_layout(),
        "notes": NOTES,
    }


def main() -> int:
    payload = build()
    text = json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    layout_section = payload["layout"]
    print(f"wrote {OUT}")
    print(f"bytes: {len(text.encode('utf-8'))}  sha256: {digest}")
    print(f"fixtures: {len(payload['fixtures'])} -> {', '.join(sorted(payload['fixtures']))}")
    print(f"errors: {len(payload['errors'])} -> {', '.join(item['name'] for item in payload['errors'])}")
    print(
        "layout: "
        f"{len(layout_section['cases'])} cases, "
        f"{len(layout_section['normalise'])} normalise, "
        f"{len(layout_section['clamp'])} clamp, "
        f"{len(layout_section['bbox'])} bbox, "
        f"{len(layout_section['page_map'])} page_map, "
        f"{len(layout_section['estimate_width'])} estimate_width"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
