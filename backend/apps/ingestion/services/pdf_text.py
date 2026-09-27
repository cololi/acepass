"""Native-text PDF extraction (P1-01) with deterministic layout diagnosis (C01).

Only *born-digital* PDFs are supported here: pages that already carry a text
layer. That is a deliberate boundary, not a limitation to hide:

* no OCR, no vision model, no credentials — the import must work offline;
* a scanned page (an image without text) is reported as ``no_text_layer`` so the
  material goes to the manual/vision proofreading path instead of being silently
  imported as an empty question;
* every extracted page keeps its own index, which is what makes "来源页可追溯"
  a fact of the data model rather than a claim in the UI.

P2 batch 1 (C01) adds *layout awareness* — still with no model anywhere:

* pypdf's visitors give the geometry of every text run, so a page can be classified
  as multi-column, grid-like or formula-bearing from real coordinates.
  ``visitor_operand_before`` supplies the exact matrix of each show-text operator
  (``visitor_text`` alone reports only the last position of a merged line, which
  cannot see a table cell), and ``visitor_text`` is the documented fallback when
  the operands cannot be decoded;
* a multi-column page is returned in **column-major** reading order, but only when
  the columns are unambiguous (no fragment spans the gutter); otherwise the
  extractor's order is kept and the page is marked
  ``reading_order_reliable=False`` — it never silently reorders what it cannot
  read;
* a page whose text layer is empty is marked ``is_scanned`` with the reason
  ``page_without_text_layer``. There is no OCR fallback, by design: such a page
  goes to a human.

The thresholds below are the whole "intelligence" of this module: plain arithmetic
on coordinates, documented so a reviewer can check them. They are expressed in
PDF points and converted with the real page size, so they do not depend on a
particular page format.

Failures raise :class:`apps.common.errors.InvalidInput` with a machine-readable
``details.reason`` so the API can explain exactly what to do next.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from apps.common.errors import InvalidInput
from apps.ingestion.services import layout

#: Refuse absurd inputs before spending memory on them.
MAX_PDF_BYTES = 40 * 1024 * 1024
MAX_PDF_PAGES = 200
MAX_TEXT_CHARS = 2_000_000
#: A page with fewer visible characters than this is treated as "no text".
MIN_PAGE_CHARS = 2

# --------------------------------------------------------------------------
# Layout thresholds (PDF points; converted with the real page size)
# --------------------------------------------------------------------------
#: Fragments whose baselines differ by less than this sit on the same line.
LINE_Y_TOLERANCE_PT = 3.0
#: Left edges within this distance start the same column band.
COLUMN_X_TOLERANCE_PT = 12.0
#: A band is only a column when it carries real content, not one stray fragment.
COLUMN_MIN_FRAGMENTS_PER_CLUSTER = 3
#: ... and at least this share of the page's fragments.
COLUMN_MIN_CLUSTER_SHARE = 0.15
#: Empty space between two bands must be at least this wide to be a gutter.
COLUMN_GUTTER_MIN_WIDTH_PT = 12.0
#: The two bands must run side by side for at least this share of the page height.
#: Half a page is the point where two bands stop looking like indentation levels
#: of one flow and start looking like parallel columns; a real two-column page
#: clears it by a wide margin even with generous margins.
COLUMN_MIN_VERTICAL_OVERLAP = 0.5
#: At most this share of the two bands' fragments may reach into the gutter before
#: the reading order is declared ambiguous.
COLUMN_MAX_GUTTER_CROSS_RATIO = 0.25
#: A table row needs at least this many cells sharing a baseline.
GRID_ROW_MIN_FRAGMENTS = 3
#: ... and a grid needs at least this many such rows...
GRID_MIN_ROWS = 3
#: ... with cells in one column aligned within this distance...
GRID_X_TOLERANCE_PT = 6.0
#: ... across at least this many aligned columns/rows.
GRID_MIN_ALIGNED_COLUMNS = 3
GRID_MIN_ALIGNED_ROWS = 2
#: Unambiguous math notation: one occurrence is enough to require review.
FORMULA_STRONG_SYMBOLS = "∫∑∏√≤≥±≈≠∞∂∈∉∪∩⊂⊆⇒⇔∴"
#: Weaker constructs. A single ``x^2`` inside an option is ordinary wording; two or
#: more sub/superscript/LaTeX-ish constructs (or ``×``/``÷``) mean real notation.
FORMULA_CONSTRUCT_PATTERN = re.compile(r"\\[A-Za-z]{2,}|[\^_]\s*\{?\s*[0-9A-Za-z]|[×÷]")
FORMULA_MIN_CONSTRUCTS = 2
#: ``____`` is a fill-in blank, not a subscript; it is removed before counting.
BLANK_MARKER_RUN = re.compile(r"_{2,}")
#: Geometry is only collected up to this many fragments per page.
MAX_FRAGMENTS_PER_PAGE = 4000
#: Fallback font size when the visitor does not report one.
DEFAULT_FONT_SIZE_PT = 12.0
#: Fallback page size when the media box cannot be read (A4 in points).
DEFAULT_PAGE_BOX = (0.0, 0.0, 595.0, 842.0)


@dataclass(frozen=True)
class PdfFragment:
    """One text-showing operation with normalised, top-down geometry.

    ``x``/``y`` are fractions of the page (0..1) with the origin at the *top*
    left, matching how a page crop is addressed by
    :class:`apps.ingestion.models.SourceRegion`; ``width``/``height`` are
    estimates derived from the reported font size, because a PDF text operator
    does not carry a box.
    """

    x: float
    y: float
    width: float
    height: float
    text: str

    def as_dict(self) -> dict:
        """The ``{x, y, text}`` shape used by tests and diagnostics."""
        return {"x": self.x, "y": self.y, "text": self.text}

    def bbox(self) -> tuple[float, float, float, float]:
        return (self.x, self.y, self.x + self.width, self.y + self.height)


@dataclass(frozen=True)
class PdfPage:
    page_index: int  # 1-based, matching SourceRegion.page_index
    text: str
    character_count: int
    #: Geometry of the text layer, empty when the visitor produced nothing.
    fragments: tuple[PdfFragment, ...] = ()
    #: Number of column bands detected on the page (1 = single flow).
    columns: int = 1
    has_table_grid: bool = False
    has_formula_tokens: bool = False
    #: No usable text layer: a scanned/image page. Never OCR'd.
    is_scanned: bool = False
    #: ``False`` when the reading order could not be established from geometry.
    reading_order_reliable: bool = True
    #: Machine-readable reason codes (see :mod:`apps.ingestion.services.layout`).
    diagnostics: tuple[str, ...] = ()

    def diagnostic_row(self) -> dict:
        reasons = list(self.diagnostics)
        return {
            "page_index": self.page_index,
            "is_scanned": self.is_scanned,
            "columns": self.columns,
            "has_table_grid": self.has_table_grid,
            "has_formula_tokens": self.has_formula_tokens,
            "reading_order_reliable": self.reading_order_reliable,
            "fragment_count": len(self.fragments),
            "character_count": self.character_count,
            "reasons": reasons,
            "needs_review": layout.needs_review(reasons),
        }


@dataclass(frozen=True)
class PdfExtraction:
    page_count: int
    pages: list[PdfPage]
    character_count: int
    empty_pages: list[int] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
    page_diagnostics: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.page_diagnostics:
            object.__setattr__(
                self, "page_diagnostics", [page.diagnostic_row() for page in self.pages]
            )

    @property
    def has_text_layer(self) -> bool:
        return self.character_count >= MIN_PAGE_CHARS

    @property
    def text(self) -> str:
        """All pages joined in reading order (page indexes are recoverable)."""
        return "\n".join(page.text for page in self.pages)

    @property
    def suspicious_pages(self) -> list[int]:
        """Pages a human has to review before anything from them is published."""
        return [
            int(row["page_index"]) for row in self.page_diagnostics if row.get("needs_review")
        ]

    def page_map(self) -> list[tuple[int, int, int]]:
        """``[(page_index, start, end)]`` offsets of :attr:`text` per page."""
        offsets: list[tuple[int, int, int]] = []
        cursor = 0
        for page in self.pages:
            end = cursor + len(page.text)
            offsets.append((page.page_index, cursor, end))
            cursor = end + 1  # the joining newline
        return offsets

    def fragments_for_page(self, page_index: int) -> tuple[PdfFragment, ...]:
        for page in self.pages:
            if page.page_index == page_index:
                return page.fragments
        return ()


def _open_reader(content: bytes):
    from io import BytesIO

    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    if not content:
        raise InvalidInput(message="PDF 文件为空", details={"reason": "empty_file"})
    if len(content) > MAX_PDF_BYTES:
        raise InvalidInput(
            message=f"PDF 超过大小上限 {MAX_PDF_BYTES // (1024 * 1024)} MiB",
            details={"reason": "too_large", "size": len(content)},
        )
    if not content[:5].startswith(b"%PDF-"):
        raise InvalidInput(message="文件不是 PDF（缺少 %PDF- 头）", details={"reason": "not_pdf"})
    try:
        reader = PdfReader(BytesIO(content))
    except PdfReadError as exc:
        raise InvalidInput(message="PDF 结构损坏，无法解析", details={"reason": "damaged"}) from exc
    except Exception as exc:  # pragma: no cover - defensive: pypdf raises many types
        raise InvalidInput(message="PDF 无法解析", details={"reason": "damaged"}) from exc
    if reader.is_encrypted:
        # An empty user password is still a legitimate "no password" document.
        try:
            unlocked = reader.decrypt("")
        except Exception:  # pragma: no cover - defensive
            unlocked = 0
        if not unlocked:
            raise InvalidInput(
                message="PDF 已加密，请先提供未加密版本（本功能不支持解密）",
                details={"reason": "encrypted"},
            )
    return reader


def extract_native_text(content: bytes) -> PdfExtraction:
    """Extract the text layer of a born-digital PDF, page by page."""
    reader = _open_reader(content)
    try:
        page_count = len(reader.pages)
    except Exception as exc:  # pragma: no cover - defensive
        raise InvalidInput(message="PDF 页数无法读取", details={"reason": "damaged"}) from exc
    if page_count == 0:
        raise InvalidInput(message="PDF 没有任何页面", details={"reason": "no_pages"})
    if page_count > MAX_PDF_PAGES:
        raise InvalidInput(
            message=f"PDF 页数 {page_count} 超过上限 {MAX_PDF_PAGES}，请拆分后分批导入",
            details={"reason": "too_many_pages", "pages": page_count},
        )

    pages: list[PdfPage] = []
    empty_pages: list[int] = []
    total = 0
    for index, page in enumerate(reader.pages, start=1):
        raw_text, fragments, notes = _extract_page(page)
        cleaned = _normalise(raw_text)
        facts = _page_layout(cleaned, fragments, notes)
        cleaned = _ordered_page_text(cleaned, fragments, notes, facts)
        if len(cleaned.strip()) < MIN_PAGE_CHARS:
            empty_pages.append(index)
        total += len(cleaned)
        if total > MAX_TEXT_CHARS:
            raise InvalidInput(
                message="PDF 文本量超过上限，请拆分后分批导入",
                details={"reason": "too_much_text", "characters": total},
            )
        pages.append(_build_page(index, cleaned, fragments, facts))

    extraction = PdfExtraction(
        page_count=page_count,
        pages=pages,
        character_count=total,
        empty_pages=empty_pages,
        metadata=_metadata(reader),
    )
    if not extraction.has_text_layer:
        raise InvalidInput(
            message=(
                "未从该 PDF 中提取到文字层：它可能是扫描件/图片版。"
                "原生文字 PDF 才能自动结构化；扫描件请走图片导入的人工校对路径。"
            ),
            details={"reason": "no_text_layer", "pages": page_count, "empty_pages": empty_pages},
        )
    return extraction


# --------------------------------------------------------------------------
# Geometry: fragments, columns, grid, formulas, scanned pages
# --------------------------------------------------------------------------
@dataclass
class _PageNotes:
    """What the visitor could not tell us, so the caller can record it."""

    width_pt: float = DEFAULT_PAGE_BOX[2]
    height_pt: float = DEFAULT_PAGE_BOX[3]
    truncated: bool = False

    #: Tolerances in normalised units, derived from the real page size so the
    #: point-based thresholds above stay page-format independent.
    @property
    def x_tolerance(self) -> float:
        return COLUMN_X_TOLERANCE_PT / self.width_pt

    @property
    def y_tolerance(self) -> float:
        return LINE_Y_TOLERANCE_PT / self.height_pt

    @property
    def grid_x_tolerance(self) -> float:
        return GRID_X_TOLERANCE_PT / self.width_pt

    @property
    def gutter_width(self) -> float:
        return COLUMN_GUTTER_MIN_WIDTH_PT / self.width_pt


@dataclass
class _LayoutFacts:
    columns: int = 1
    #: True when no fragment reaches across a detected gutter.
    unambiguous: bool = True
    has_table_grid: bool = False
    has_formula_tokens: bool = False
    is_scanned: bool = False
    reading_order_reliable: bool = True
    reasons: list[str] = field(default_factory=list)


def _page_box(page) -> tuple[float, float, float, float]:
    try:
        box = page.mediabox
        left, bottom = float(box.left), float(box.bottom)
        right, top = float(box.right), float(box.top)
    except Exception:  # pragma: no cover - defensive: damaged media box
        return DEFAULT_PAGE_BOX
    if right <= left or top <= bottom:  # pragma: no cover - degenerate media box
        return DEFAULT_PAGE_BOX
    return (left, bottom, right, top)


def _is_wide(character: str) -> bool:
    """CJK/fullwidth characters occupy roughly one em, Latin ones about half."""
    return ord(character) >= 0x2E80


def _estimate_width_pt(text: str, font_size: float) -> float:
    units = sum(1.0 if _is_wide(character) else 0.5 for character in text)
    return max(units * font_size, font_size * 0.5)


def _device_point(cm, tm) -> tuple[float, float]:
    """Compose the text matrix with the current transformation matrix.

    ``pypdf`` hands the visitor ``cm`` and ``tm`` separately; a text fragment's
    device position is the translation of ``cm × tm``.
    """
    cm_values = tuple(cm) if cm else (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    tm_values = tuple(tm) if tm else (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    try:
        a1, b1, c1, d1, e1, f1 = (float(value) for value in cm_values[:6])
        a2, b2, c2, d2, e2, f2 = (float(value) for value in tm_values[:6])
    except (TypeError, ValueError):  # pragma: no cover - defensive
        return (0.0, 0.0)
    del b2, d2
    return (a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1)


def _fragment(text: str, x_pt: float, y_pt: float, font_size, box) -> PdfFragment:
    left, _bottom, right, top = box
    width_pt = right - left
    height_pt = top - _bottom
    size = float(font_size) if font_size else DEFAULT_FONT_SIZE_PT
    if size <= 0:  # pragma: no cover - defensive: bogus font size
        size = DEFAULT_FONT_SIZE_PT
    return PdfFragment(
        x=(x_pt - left) / width_pt,
        # The visitor reports the baseline; the box starts about one em above it.
        y=(top - (y_pt + size)) / height_pt,
        width=_estimate_width_pt(text, size) / width_pt,
        height=(size * 1.2) / height_pt,
        text=text,
    )


#: Operators that show text. ``'`` and ``"`` are handled by the text visitor
#: fallback instead: the visitor sees the matrix *before* their implicit line
#: move, so a fragment built from it would be one line off.
SHOW_TEXT_OPERATORS = (b"Tj", b"TJ")


def _load_font_map(page, name: str) -> tuple | None:
    """One font's decoding table, built with pypdf's own CMap machinery.

    The operand visitor hands over the *raw* bytes of a show-text operator (for a
    CID font those are glyph codes). Reusing pypdf's char-map builder is what lets
    a fragment carry both its exact position and its readable text. It is built
    lazily per font actually used, so a page with many declared fonts pays only
    for the ones it draws with; a font that cannot be resolved simply yields no
    text, so a layout decision never depends on a font pypdf cannot read.
    """
    from pypdf._cmap import build_char_map

    try:
        return build_char_map(str(name), 200.0, page)
    except Exception:  # pragma: no cover - defensive: unreadable font
        return None


def _decode_show_text(pieces, char_map) -> str:
    """Decode the operands of one show-text operator into display text."""
    if char_map is None:
        return ""
    from pypdf._page import get_text_operands

    identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    cmap = (char_map[2], char_map[3], "fragment", char_map[4])
    decoded: list[str] = []
    for piece in pieces:
        if isinstance(piece, str):
            decoded.append(piece)
            continue
        if not isinstance(piece, (bytes, bytearray)):  # kerning numbers
            continue
        try:
            text, _rtl = get_text_operands([piece], identity, identity, cmap, (0, 90, 180, 270))
        except Exception:  # pragma: no cover - defensive: undecodable run
            continue
        decoded.append(text)
    return "".join(decoded)


def _append_fragment(
    fragments: list[PdfFragment], text: str, x_pt: float, y_pt: float, font_size, box
) -> None:
    """Add a run, merging pieces that share one exact position (``TJ`` arrays)."""
    fragment = _fragment(text, x_pt, y_pt, font_size, box)
    if fragments:
        previous = fragments[-1]
        if abs(previous.x - fragment.x) < 1e-9 and abs(previous.y - fragment.y) < 1e-9:
            merged = previous.text + fragment.text
            fragments[-1] = _fragment(merged, x_pt, y_pt, font_size, box)
            return
    fragments.append(fragment)


def _extract_page(page) -> tuple[str, list[PdfFragment], _PageNotes]:
    """Plain text plus per-text-run geometry; never fails the whole document.

    Two visitors are used in the same pass: ``visitor_operand_before`` gives the
    exact matrix of every show-text operator (pypdf's ``visitor_text`` only
    reports the *last* position of a merged line, which is not enough to see a
    column or a table cell), and ``visitor_text`` is the documented fallback when
    the operands cannot be decoded at all. The page text itself always comes from
    ``extract_text``'s return value, so geometry can never change the wording.
    """
    box = _page_box(page)
    runs: list[PdfFragment] = []
    chunks: list[PdfFragment] = []
    notes = _PageNotes(width_pt=box[2] - box[0], height_pt=box[3] - box[1])
    font_maps: dict[str, tuple | None] = {}
    state = {"font": "", "size": DEFAULT_FONT_SIZE_PT}

    def font_map(name: str) -> tuple | None:
        if name not in font_maps:
            font_maps[name] = _load_font_map(page, name)
        return font_maps[name]

    def operand_visitor(operator, operands, cm, tm) -> None:
        try:
            if operator == b"Tf":
                state["font"] = str(operands[0])
                try:
                    state["size"] = float(operands[1])
                except (TypeError, ValueError, IndexError):  # pragma: no cover - defensive
                    pass
                return
            if operator not in SHOW_TEXT_OPERATORS:
                return
            if len(runs) >= MAX_FRAGMENTS_PER_PAGE:
                notes.truncated = True
                return
            raw = operands[0] if operands else None
            pieces = raw if isinstance(raw, list) else [raw]
            text = _decode_show_text(pieces, font_map(state["font"]))
            if not text.strip():
                return
            x_pt, y_pt = _device_point(cm, tm)
            _append_fragment(runs, text.strip(), x_pt, y_pt, state["size"], box)
        except Exception:  # pragma: no cover - a geometry bug must not lose text
            return

    def text_visitor(text, cm, tm, font_dict, font_size) -> None:
        try:
            if not text or not text.strip():
                return
            if len(chunks) >= MAX_FRAGMENTS_PER_PAGE:
                notes.truncated = True
                return
            x_pt, y_pt = _device_point(cm, tm)
            chunks.append(_fragment(text.strip(), x_pt, y_pt, font_size, box))
        except Exception:  # pragma: no cover - defensive
            return

    try:
        plain = (
            page.extract_text(visitor_operand_before=operand_visitor, visitor_text=text_visitor)
            or ""
        )
    except Exception:
        # Keep the P1 behaviour: one unreadable page must not lose the document.
        # The geometry is dropped, the plain text is still taken if it can be.
        runs = []
        chunks = []
        try:
            plain = page.extract_text() or ""
        except Exception:
            plain = ""
    # Per-run geometry is the precise source; the text-visitor chunks are the
    # documented fallback when the operands could not be read at all.
    return plain, (runs or chunks), notes


def _lines(fragments: list[PdfFragment], y_tolerance: float) -> list[list[PdfFragment]]:
    ordered = sorted(fragments, key=lambda fragment: (fragment.y, fragment.x))
    lines: list[list[PdfFragment]] = []
    for fragment in ordered:
        if lines and abs(fragment.y - lines[-1][0].y) <= y_tolerance:
            lines[-1].append(fragment)
        else:
            lines.append([fragment])
    return lines


def _x_clusters(fragments: list[PdfFragment], x_tolerance: float) -> list[list[PdfFragment]]:
    """Greedy left-edge clustering; a cluster's first fragment stays the anchor."""
    ordered = sorted(fragments, key=lambda fragment: fragment.x)
    clusters: list[list[PdfFragment]] = []
    for fragment in ordered:
        if clusters and fragment.x - clusters[-1][0].x <= x_tolerance:
            clusters[-1].append(fragment)
        else:
            clusters.append([fragment])
    return clusters


def _band_extent(fragments: list[PdfFragment]) -> tuple[float, float]:
    boxes = [fragment.bbox() for fragment in fragments]
    return (min(box[1] for box in boxes), max(box[3] for box in boxes))


def _detect_columns(
    fragments: list[PdfFragment], *, x_tolerance: float, gutter_width: float
) -> tuple[int, bool]:
    """``(columns, unambiguous)`` from x bands and the gutters between them.

    A gutter is real when the empty space between two bands is wide enough, when
    the bands run side by side for most of the page height, and when few fragments
    reach across it. ``unambiguous`` is only true when *no* fragment of either band
    reaches into the gutter: that is the case in which the reading order can be
    derived, so that is the only case in which it is reordered.
    """
    if len(fragments) < COLUMN_MIN_FRAGMENTS_PER_CLUSTER * 2:
        return 1, True
    minimum = max(
        COLUMN_MIN_FRAGMENTS_PER_CLUSTER,
        int(len(fragments) * COLUMN_MIN_CLUSTER_SHARE),
    )
    clusters = [
        cluster for cluster in _x_clusters(fragments, x_tolerance) if len(cluster) >= minimum
    ]
    if len(clusters) < 2:
        return 1, True

    qualifying = 0
    unambiguous = True
    for left_band, right_band in zip(clusters, clusters[1:], strict=False):
        right_start = min(fragment.x for fragment in right_band)
        # The gutter is the empty space after the left band's ordinary runs: a
        # full-width heading that reaches into the next band does not remove the
        # gutter, it becomes a crossing fragment (and makes the order ambiguous).
        contained = [
            fragment for fragment in left_band if fragment.x + fragment.width <= right_start
        ]
        if not contained:
            continue
        gutter_start = max(fragment.x + fragment.width for fragment in contained)
        gutter_end = right_start
        if gutter_end - gutter_start < gutter_width:
            continue
        left_top, left_bottom = _band_extent(left_band)
        right_top, right_bottom = _band_extent(right_band)
        overlap = min(left_bottom, right_bottom) - max(left_top, right_top)
        if overlap < COLUMN_MIN_VERTICAL_OVERLAP:
            continue
        crossing = [
            fragment
            for fragment in (*left_band, *right_band)
            if fragment.x < gutter_end and fragment.x + fragment.width > gutter_start
        ]
        if len(crossing) / max(len(left_band) + len(right_band), 1) > COLUMN_MAX_GUTTER_CROSS_RATIO:
            continue
        qualifying += 1
        if crossing:
            unambiguous = False
    if not qualifying:
        return 1, True
    return 1 + qualifying, unambiguous


def _column_major_text(fragments: list[PdfFragment], notes: _PageNotes) -> str:
    """Rebuild the page in column-major order: column by column, top-down.

    Every fragment keeps its cluster (the nearest band anchor), so a heading that
    starts at the page margin is read with the column it belongs to instead of
    being lost.
    """
    clusters = _x_clusters(fragments, notes.x_tolerance)
    anchors = [cluster[0].x for cluster in clusters]

    def cluster_of(fragment: PdfFragment) -> int:
        return min(range(len(anchors)), key=lambda index: abs(anchors[index] - fragment.x))

    ordered = sorted(fragments, key=lambda fragment: (cluster_of(fragment), fragment.y, fragment.x))
    lines: list[list[PdfFragment]] = []
    for fragment in ordered:
        if (
            lines
            and cluster_of(fragment) == cluster_of(lines[-1][-1])
            and abs(fragment.y - lines[-1][-1].y) <= notes.y_tolerance
        ):
            lines[-1].append(fragment)
        else:
            lines.append([fragment])
    return "\n".join(_join_line(line) for line in lines)


def _join_line(line: list[PdfFragment]) -> str:
    parts = [line[0].text]
    for previous, fragment in zip(line, line[1:], strict=False):
        gap = fragment.x - (previous.x + previous.width)
        joiner = " " if gap > 0.3 * max(fragment.height, 1e-6) else ""
        parts.append(joiner + fragment.text)
    return "".join(parts)


def _visible_characters(text: str) -> int:
    return len(re.sub(r"\s+", "", text or ""))


def _detect_table_grid(
    fragments: list[PdfFragment], *, y_tolerance: float, x_tolerance: float
) -> bool:
    """Rows sharing a baseline with cells aligned across consecutive rows."""
    rows = [
        line for line in _lines(fragments, y_tolerance) if len(line) >= GRID_ROW_MIN_FRAGMENTS
    ]
    if len(rows) < GRID_MIN_ROWS:
        return False
    # Cluster cell positions across the rows; a column is a position shared by
    # several rows, which is what "aligned" means here.
    column_rows: dict[float, set[int]] = {}
    for row_index, row in enumerate(rows):
        for fragment in sorted(row, key=lambda item: item.x):
            anchor = next(
                (existing for existing in column_rows if abs(existing - fragment.x) <= x_tolerance),
                None,
            )
            if anchor is None:
                column_rows[fragment.x] = {row_index}
            else:
                column_rows[anchor].add(row_index)
    aligned = [anchor for anchor, hits in column_rows.items() if len(hits) >= GRID_MIN_ALIGNED_ROWS]
    return len(aligned) >= GRID_MIN_ALIGNED_COLUMNS


def _detect_formula_tokens(text: str) -> bool:
    """Deterministic, no model: symbols or sub/superscript constructs."""
    if not text.strip():
        return False
    scrubbed = BLANK_MARKER_RUN.sub(" ", text)
    if any(character in FORMULA_STRONG_SYMBOLS for character in scrubbed):
        return True
    return len(FORMULA_CONSTRUCT_PATTERN.findall(scrubbed)) >= FORMULA_MIN_CONSTRUCTS


def _page_layout(
    text: str, fragments: list[PdfFragment], notes: _PageNotes
) -> _LayoutFacts:
    """Classify one page in one pass; no model, no heuristics beyond the constants."""
    facts = _LayoutFacts()
    facts.is_scanned = len(text.strip()) < MIN_PAGE_CHARS
    if facts.is_scanned:
        facts.reasons.append(layout.REASON_SCANNED)
    if fragments:
        facts.columns, facts.unambiguous = _detect_columns(
            fragments, x_tolerance=notes.x_tolerance, gutter_width=notes.gutter_width
        )
        if facts.columns > 1:
            facts.reasons.append(layout.REASON_MULTI_COLUMN)
            if not facts.unambiguous:
                facts.reading_order_reliable = False
                facts.reasons.append(layout.REASON_COLUMN_ORDER_AMBIGUOUS)
        facts.has_table_grid = _detect_table_grid(
            fragments, y_tolerance=notes.y_tolerance, x_tolerance=notes.grid_x_tolerance
        )
        if facts.has_table_grid:
            facts.reasons.append(layout.REASON_TABLE_GRID)
        if notes.truncated:
            # Half a page of geometry cannot be trusted to describe the page.
            facts.reading_order_reliable = False
            facts.reasons.append(layout.REASON_TOO_MANY_FRAGMENTS)
    else:
        facts.reading_order_reliable = False
        if text.strip():
            facts.reasons.append(layout.REASON_GEOMETRY_UNAVAILABLE)
    if _detect_formula_tokens(text):
        facts.has_formula_tokens = True
        facts.reasons.append(layout.REASON_FORMULA)
    return facts


def _ordered_page_text(
    text: str, fragments: list[PdfFragment], notes: _PageNotes, facts: _LayoutFacts
) -> str:
    """Column-major text when the columns are unambiguous, otherwise unchanged.

    The rebuild only ever *reorders*: if it does not keep every visible character
    of the plain extraction, the plain text wins and the page is marked
    unreliable instead. Text is never lost to a layout guess.
    """
    if facts.columns <= 1 or not facts.unambiguous or not fragments:
        return text
    rebuilt = _column_major_text(fragments, notes)
    if _visible_characters(rebuilt) < _visible_characters(text):
        facts.reading_order_reliable = False
        if layout.REASON_COLUMN_ORDER_AMBIGUOUS not in facts.reasons:
            facts.reasons.append(layout.REASON_COLUMN_ORDER_AMBIGUOUS)
        return text
    return _normalise(rebuilt)


def _build_page(
    page_index: int,
    text: str,
    fragments: list[PdfFragment],
    facts: _LayoutFacts,
) -> PdfPage:
    return PdfPage(
        page_index=page_index,
        text=text,
        character_count=len(text),
        fragments=tuple(fragments),
        columns=facts.columns,
        has_table_grid=facts.has_table_grid,
        has_formula_tokens=facts.has_formula_tokens,
        is_scanned=facts.is_scanned,
        reading_order_reliable=facts.reading_order_reliable,
        diagnostics=tuple(facts.reasons),
    )


#: Smallest region a bounding box may describe, so a one-character fragment still
#: produces a region a proofreader can see.
MIN_REGION_SIZE = 0.005


def _clamp_bbox(x: float, y: float, width: float, height: float) -> dict:
    """Fit a normalised box inside the page, whatever the extractor reported.

    Fragment positions come from a text matrix and can legitimately sit outside
    the media box (clipped or rotated text); a region that cannot be stored is
    useless, so the box is clamped rather than rejected.
    """
    left = min(max(x, 0.0), 1.0)
    top = min(max(y, 0.0), 1.0)
    right = min(max(x + max(width, 0.0), 0.0), 1.0)
    bottom = min(max(y + max(height, 0.0), 0.0), 1.0)
    box_width = max(right - left, MIN_REGION_SIZE)
    box_height = max(bottom - top, MIN_REGION_SIZE)
    if left + box_width > 1.0:
        left = max(1.0 - box_width, 0.0)
    if top + box_height > 1.0:
        top = max(1.0 - box_height, 0.0)
    return {"x": left, "y": top, "width": box_width, "height": box_height}


def bbox_for_text(page: PdfPage, text: str) -> dict | None:
    """Normalised union box of the fragments whose text appears in ``text``.

    This is what turns "the question came from page 3" into "the question came
    from *this area* of page 3". A fragment counts when it is part of the given
    text, or when it *carries* the text's first line — the common case being a
    ``【题干】`` line whose fragment includes the label while the stem does not.
    ``None`` means there is no geometry to match and the caller must keep its
    whole-page fallback instead of inventing a box.
    """
    needle = (text or "").strip()
    if not needle or not page.fragments:
        return None
    anchor = needle.split("\n", 1)[0].strip()[:40]
    matched = [
        fragment
        for fragment in page.fragments
        if fragment.text
        and (fragment.text in needle or (anchor and anchor in fragment.text))
    ]
    if not matched:
        return None
    boxes = [fragment.bbox() for fragment in matched]
    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    return _clamp_bbox(left, top, right - left, bottom - top)


def _metadata(reader) -> dict:
    try:
        info = reader.metadata or {}
    except Exception:  # pragma: no cover - defensive
        return {}
    out: dict[str, str] = {}
    for key in ("/Title", "/Producer", "/Creator"):
        value = info.get(key)
        if value:
            out[key.lstrip("/").lower()] = str(value)[:300]
    return out


def _normalise(text: str) -> str:
    """Drop the soft artefacts of PDF text extraction without altering wording.

    Only line-level noise is removed: a stray carriage return, and the trailing
    spaces PDF extractors emit at line ends. The wording itself is never changed,
    because the proofreader compares against the original page.
    """
    lines = [line.replace("\r", "").rstrip() for line in text.split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


#: Headings that mark an answer section/page rather than question material.
ANSWER_SECTION_MARKERS = (
    "参考答案",
    "答案与解析",
    "答案及解析",
    "答案：",
    "答案:",
    "评分标准",
    "答案页",
    "试题答案",
)


def looks_like_answer_text(text: str) -> bool:
    """Heuristic used only to *suggest* a role; the caller still decides."""
    head = "\n".join(text.split("\n")[:40])
    if any(marker in head for marker in ANSWER_SECTION_MARKERS):
        return True
    # "1. A  2. B  3. C" style pages: mostly short numbered entries.
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    if len(lines) < 5:
        return False
    import re as _re

    short_numbered = sum(1 for line in lines if _re.match(r"^\s*\d{1,3}\s*[.、)）:：]\s*\S{1,12}$", line))
    return short_numbered / len(lines) >= 0.6
