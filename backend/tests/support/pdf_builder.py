"""Test-only builder for *native text* PDFs (a real text layer, no scanning).

The P1 PDF import must be exercised against genuine PDF bytes produced by a
generator, not against a mocked extractor. Committing binary fixtures would hide
how they were made and would rot; instead this module writes a minimal but real
PDF from scratch:

* a Type0 / CIDFontType2 font with ``Identity-H`` encoding, so the two-byte codes
  in the content stream are glyph ids;
* glyph ids chosen to equal the Unicode code point, plus a ``/ToUnicode`` CMap, so
  every extractor (including ``pypdf``) reads the original characters back — this
  is what makes Chinese text round-trip without embedding a font file;
* one PDF page per input page, with the text positioned by explicit ``Td`` moves.

Nothing here is production code and nothing here calls a model: the acceptance
point for P1-A is that a *native* PDF's text layer can be imported without any AI
key.

P2 batch 1 (C01) adds two more generators, because layout has to be exercised
against real geometry rather than against a mocked reader:

* :func:`build_layout_pdf` — every fragment is placed by an explicit ``Tm``, so a
  test can lay out two columns, a table grid or a formula line at chosen
  coordinates and the extractor sees exactly those positions;
* :func:`build_scanned_pdf` — an *image-only* page (a real ``/Image`` XObject and
  no text-showing operator at all), which is what a scanned page actually is.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass

#: US Letter/A4-ish page in PDF points; the geometry thresholds in
#: ``apps.ingestion.services.pdf_text`` are expressed in points and converted
#: with the page size, so tests and production agree on this default.
DEFAULT_MEDIA_BOX = (595.0, 842.0)


@dataclass
class _Object:
    number: int
    body: bytes


def _escape_pdf_string(value: str) -> str:
    return value.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


class PdfBuilder:
    """Accumulate objects and serialise them into a valid PDF byte string."""

    def __init__(self, *, title: str = "AcePass test material") -> None:
        self.objects: dict[int, bytes] = {}
        self._next = 1
        self._title = title

    def reserve(self) -> int:
        number = self._next
        self._next += 1
        return number

    def set(self, number: int, body: bytes) -> None:
        self.objects[number] = body

    def add(self, body: bytes) -> int:
        number = self.reserve()
        self.set(number, body)
        return number

    def stream(self, data: bytes) -> int:
        compressed = zlib.compress(data)
        return self.add(
            b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(compressed) + compressed + b"\nendstream"
        )

    def raw_stream(self, data: bytes, *, extra: bytes = b"") -> int:
        """An uncompressed stream; image XObjects must not be flate-wrapped here."""
        return self.add(
            b"<< /Length %d %s>>\nstream\n" % (len(data), extra) + data + b"\nendstream"
        )

    def build(self) -> bytes:
        header = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
        out = bytearray(header)
        offsets: dict[int, int] = {}
        for number in sorted(self.objects):
            offsets[number] = len(out)
            out += b"%d 0 obj\n" % number + self.objects[number] + b"\nendobj\n"
        xref_at = len(out)
        size = max(self.objects) + 1
        out += b"xref\n0 %d\n" % size
        out += b"0000000000 65535 f \n"
        for number in range(1, size):
            if number in offsets:
                out += b"%010d 00000 n \n" % offsets[number]
            else:  # pragma: no cover - builders always write every reserved object
                out += b"0000000000 65535 f \n"
        out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\n" % (size, self._root, self._info)
        out += b"startxref\n%d\n%%%%EOF\n" % xref_at
        return bytes(out)

    # -- high level ---------------------------------------------------------
    def set_document(self, *, root: int, info: int) -> None:
        self._root = root
        self._info = info


def _collect_characters(pages: list[str]) -> list[str]:
    characters: list[str] = []
    for page in pages:
        for character in page:
            if character not in characters and character not in "\n\r":
                characters.append(character)
    return characters


def _font_codes(characters: list[str]) -> dict[str, int]:
    # Glyph id == code point keeps the ToUnicode map trivial and lossless.
    return {character: ord(character) for character in characters}


def _write_font(
    builder: PdfBuilder,
    codes: dict[str, int],
    *,
    font: int,
    descendant: int,
    descriptor: int,
    to_unicode: int,
) -> None:
    bfchar = "".join(f"<{code:04X}> <{ord(character):04X}>\n" for character, code in codes.items())
    cmap = (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /AcePass-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
        f"{min(len(codes), 100)} beginbfchar\n{bfchar}endbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"
    ).encode()
    builder.set(to_unicode, b"<< /Length %d >>\nstream\n" % len(cmap) + cmap + b"\nendstream")
    font_file = builder.add(b"<< /Length 0 >>\nstream\n\nendstream")
    builder.set(
        descriptor,
        b"<< /Type /FontDescriptor /FontName /AcePassTest /Flags 4 /FontBBox [0 -200 1000 900] "
        b"/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 %d 0 R >>" % font_file,
    )
    builder.set(
        descendant,
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AcePassTest "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        b"/FontDescriptor %d 0 R /DW 1000 /W [0 [1000 1000 1000]] >>" % descriptor,
    )
    builder.set(
        font,
        b"<< /Type /Font /Subtype /Type0 /BaseFont /AcePassTest /Encoding /Identity-H "
        b"/DescendantFonts [%d 0 R] /ToUnicode %d 0 R >>" % (descendant, to_unicode),
    )


def _image_xobject(builder: PdfBuilder) -> int:
    """A tiny real greyscale image: the *content* of a scanned-looking page."""
    return builder.raw_stream(
        bytes([0x00, 0x40, 0x80, 0xFF]),
        extra=b"/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 ",
    )


def _assemble(
    *,
    title: str,
    characters: list[str],
    page_contents: list[bytes],
    scanned_pages: list[bool] | None = None,
    media_box: tuple[float, float] = DEFAULT_MEDIA_BOX,
) -> bytes:
    """Write the shared font/page objects around already-built page contents.

    ``scanned_pages[i]`` marks a page that must carry a full-page image and no
    text layer; the image XObject is created here so the page dictionary and the
    object it points at always belong to the same builder.
    """
    builder = PdfBuilder(title=title)
    catalog = builder.reserve()
    pages_node = builder.reserve()
    info = builder.reserve()
    font = builder.reserve()
    descendant = builder.reserve()
    descriptor = builder.reserve()
    to_unicode = builder.reserve()
    codes = _font_codes(characters)
    _write_font(builder, codes, font=font, descendant=descendant, descriptor=descriptor, to_unicode=to_unicode)

    scanned_pages = scanned_pages or [False] * len(page_contents)
    image: int | None = None
    if any(scanned_pages):
        image = _image_xobject(builder)

    box = b"[0 0 %g %g]" % media_box
    page_refs = []
    for index, content in enumerate(page_contents):
        content_ref = builder.stream(content)
        resources = b"/Font << /F1 %d 0 R >>" % font
        if scanned_pages[index]:
            resources += b" /XObject << /Im0 %d 0 R >>" % image
        page = builder.add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox %s /Resources << %s >> /Contents %d 0 R >>"
            % (pages_node, box, resources, content_ref)
        )
        page_refs.append(page)

    builder.set(
        pages_node,
        b"<< /Type /Pages /Kids [%s] /Count %d >>"
        % (b" ".join(b"%d 0 R" % ref for ref in page_refs), len(page_refs)),
    )
    builder.set(catalog, b"<< /Type /Catalog /Pages %d 0 R >>" % pages_node)
    builder.set(
        info,
        b"<< /Title (%s) /Producer (AcePass test fixture builder) >>" % _escape_pdf_string(title).encode("utf-8"),
    )
    builder.set_document(root=catalog, info=info)
    return builder.build()


def build_text_pdf(pages: list[str], *, title: str = "AcePass 测试材料（自动生成，非真题）") -> bytes:
    """Build a native-text PDF whose text layer contains ``pages`` verbatim."""
    characters = _collect_characters(pages)
    codes = _font_codes(characters)
    contents = [_page_content(page_text, codes) for page_text in pages]
    return _assemble(title=title, characters=characters, page_contents=contents)


def _page_content(page_text: str, codes: dict[str, int]) -> bytes:
    """One text-showing operator per line, positioned top-down with ``Td``."""
    lines = page_text.split("\n")
    parts: list[bytes] = [b"BT\n/F1 12 Tf\n14 TL\n1 0 0 1 40 800 Tm\n"]
    for index, line in enumerate(lines):
        if index:
            parts.append(b"T*\n")
        encoded = "".join(f"{codes[character]:04X}" for character in line if character in codes)
        parts.append(b"<" + encoded.encode("ascii") + b"> Tj\n")
    parts.append(b"ET\n")
    return b"".join(parts)


# --------------------------------------------------------------------------
# P2 batch 1 (C01): explicit geometry and image-only ("scanned") pages
# --------------------------------------------------------------------------
def _fragment_content(fragments: list[dict], codes: dict[str, int]) -> bytes:
    """Place every fragment with ``1 0 0 1 x y Tm`` (no ``T*`` leading maths).

    ``y`` is the PDF baseline measured **from the bottom** of the page, exactly
    what ``pypdf`` reports as ``tm.f``, so a test that lays out a fragment at
    ``y=700`` can assert the extractor saw 700.
    """
    parts: list[bytes] = [b"BT\n"]
    current_size: float | None = None
    for fragment in fragments:
        size = float(fragment.get("size") or 12.0)
        if size != current_size:
            parts.append(b"/F1 %g Tf\n" % size)
            current_size = size
        x = float(fragment.get("x") or 0.0)
        y = float(fragment.get("y") or 0.0)
        parts.append(b"1 0 0 1 %g %g Tm\n" % (x, y))
        text = str(fragment.get("text") or "")
        encoded = "".join(f"{codes[character]:04X}" for character in text if character in codes)
        parts.append(b"<" + encoded.encode("ascii") + b"> Tj\n")
    parts.append(b"ET\n")
    return b"".join(parts)


def build_layout_pdf(
    pages: list[list[dict]],
    *,
    title: str = "AcePass 版式测试材料（自动生成，非真题）",
    media_box: tuple[float, float] = DEFAULT_MEDIA_BOX,
) -> bytes:
    """Build a real PDF from ``{"x", "y", "text"}`` fragments placed per page.

    Each page is a list of fragments; ``x``/``y`` are PDF user-space points with
    the origin at the bottom-left (``y`` grows upwards), optionally with a
    ``size`` key for the font size. A two-column page is two x bands, a table is
    a set of aligned rows, and a formula is simply a fragment whose text contains
    the symbols — the extractor has to work the positions out for itself.
    """
    flat: list[str] = []
    for page in pages:
        flat.extend(str(fragment.get("text") or "") for fragment in page)
    characters = _collect_characters(flat)
    codes = _font_codes(characters)
    contents = [_fragment_content(page, codes) for page in pages]
    return _assemble(title=title, characters=characters, page_contents=contents, media_box=media_box)


def build_scanned_pdf(
    pages: list[str | None],
    *,
    title: str = "AcePass 扫描件测试材料（自动生成，非真题）",
    media_box: tuple[float, float] = DEFAULT_MEDIA_BOX,
) -> bytes:
    """Build a PDF where ``None`` pages are image-only, without a text layer.

    The point is to exercise "scanned page" detection against real bytes rather
    than a flag: a scanned page carries a full-page ``/Image`` XObject and *no*
    text-showing operator, so any extractor finds zero characters on it. A ``str``
    page keeps the P1 behaviour (that page's text is laid out as one fragment per
    line), which is what makes a "scanned page mixed with native pages" document
    expressible in one file.
    """
    needles = [page for page in pages if page is not None]
    characters = _collect_characters(needles)
    codes = _font_codes(characters)
    contents = [
        _page_content(page, codes)
        if page is not None
        else b"%% scanned page: image only, no text layer\nq\n%g 0 0 %g 0 0 cm\n/Im0 Do\nQ\n" % media_box
        for page in pages
    ]
    return _assemble(
        title=title,
        characters=characters,
        page_contents=contents,
        scanned_pages=[page is None for page in pages],
        media_box=media_box,
    )
