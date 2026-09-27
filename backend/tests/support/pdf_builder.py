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
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass


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


def build_text_pdf(pages: list[str], *, title: str = "AcePass 测试材料（自动生成，非真题）") -> bytes:
    """Build a native-text PDF whose text layer contains ``pages`` verbatim."""
    builder = PdfBuilder(title=title)
    catalog = builder.reserve()
    pages_node = builder.reserve()
    info = builder.reserve()
    font = builder.reserve()
    descendant = builder.reserve()
    descriptor = builder.reserve()
    to_unicode = builder.reserve()

    characters: list[str] = []
    for page in pages:
        for character in page:
            if character not in characters and character not in "\n\r":
                characters.append(character)
    # Glyph id == code point keeps the ToUnicode map trivial and lossless.
    codes = {character: ord(character) for character in characters}
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

    page_refs = []
    for page_text in pages:
        content = _page_content(page_text, codes)
        content_ref = builder.stream(content)
        page = builder.add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] "
            b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
            % (pages_node, font, content_ref)
        )
        page_refs.append(page)

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
    builder.set(pages_node, b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % ref for ref in page_refs),
        len(page_refs),
    ))
    builder.set(catalog, b"<< /Type /Catalog /Pages %d 0 R >>" % pages_node)
    builder.set(
        info,
        b"<< /Title (%s) /Producer (AcePass test fixture builder) >>" % _escape_pdf_string(title).encode("utf-8"),
    )
    builder.set_document(root=catalog, info=info)
    return builder.build()


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
