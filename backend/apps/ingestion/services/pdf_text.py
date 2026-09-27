"""Native-text PDF extraction (P1-01).

Only *born-digital* PDFs are supported here: pages that already carry a text
layer. That is a deliberate boundary, not a limitation to hide:

* no OCR, no vision model, no credentials — the import must work offline;
* a scanned page (an image without text) is reported as ``no_text_layer`` so the
  material goes to the manual/vision proofreading path instead of being silently
  imported as an empty question;
* every extracted page keeps its own index, which is what makes "来源页可追溯"
  a fact of the data model rather than a claim in the UI.

Failures raise :class:`apps.common.errors.InvalidInput` with a machine-readable
``details.reason`` so the API can explain exactly what to do next.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from apps.common.errors import InvalidInput

#: Refuse absurd inputs before spending memory on them.
MAX_PDF_BYTES = 40 * 1024 * 1024
MAX_PDF_PAGES = 200
MAX_TEXT_CHARS = 2_000_000
#: A page with fewer visible characters than this is treated as "no text".
MIN_PAGE_CHARS = 2


@dataclass(frozen=True)
class PdfPage:
    page_index: int  # 1-based, matching SourceRegion.page_index
    text: str
    character_count: int


@dataclass(frozen=True)
class PdfExtraction:
    page_count: int
    pages: list[PdfPage]
    character_count: int
    empty_pages: list[int] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)

    @property
    def has_text_layer(self) -> bool:
        return self.character_count >= MIN_PAGE_CHARS

    @property
    def text(self) -> str:
        """All pages joined in reading order (page indexes are recoverable)."""
        return "\n".join(page.text for page in self.pages)

    def page_map(self) -> list[tuple[int, int, int]]:
        """``[(page_index, start, end)]`` offsets of :attr:`text` per page."""
        offsets: list[tuple[int, int, int]] = []
        cursor = 0
        for page in self.pages:
            end = cursor + len(page.text)
            offsets.append((page.page_index, cursor, end))
            cursor = end + 1  # the joining newline
        return offsets


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
        try:
            text = page.extract_text() or ""
        except Exception:
            # One unreadable page must not lose the whole document; it is
            # reported so the proofreader knows which page needs manual work.
            text = ""
        cleaned = _normalise(text)
        if len(cleaned.strip()) < MIN_PAGE_CHARS:
            empty_pages.append(index)
        total += len(cleaned)
        if total > MAX_TEXT_CHARS:
            raise InvalidInput(
                message="PDF 文本量超过上限，请拆分后分批导入",
                details={"reason": "too_much_text", "characters": total},
            )
        pages.append(PdfPage(page_index=index, text=cleaned, character_count=len(cleaned)))

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


def page_for_offset(page_map: list[tuple[int, int, int]], offset: int) -> int:
    """Which page does a character offset of the joined text belong to?"""
    for page_index, start, end in page_map:
        if start <= offset <= end:
            return page_index
    return page_map[-1][0] if page_map else 1


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
    import re

    short_numbered = sum(1 for line in lines if re.match(r"^\s*\d{1,3}\s*[.、)）:：]\s*\S{1,12}$", line))
    return short_numbered / len(lines) >= 0.6
