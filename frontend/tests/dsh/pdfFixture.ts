import zlib from 'node:zlib'

/**
 * Build a *native text* PDF in the browser-acceptance process.
 *
 * The P1 import is about born-digital PDFs: pages that already carry a text
 * layer. Committing a binary fixture would hide how it was produced, so the
 * suite writes a real PDF from scratch instead:
 *
 * * a Type0 / CIDFontType2 font with `Identity-H` encoding, so the two-byte codes
 *   in the content stream are glyph ids;
 * * glyph ids equal to the Unicode code points plus a `/ToUnicode` CMap, so the
 *   server's extractor reads the original characters back (including Chinese)
 *   without any embedded font file;
 * * one PDF page per input page, one text-showing operator per line.
 *
 * Nothing here calls a server or produces a "scanned" page.
 */

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export class PdfBuilder {
  private objects = new Map<number, Buffer>()
  private next = 1
  private root = 0
  private info = 0

  reserve(): number {
    const number = this.next
    this.next += 1
    return number
  }

  set(number: number, body: Buffer): void {
    this.objects.set(number, body)
  }

  add(body: Buffer): number {
    const number = this.reserve()
    this.set(number, body)
    return number
  }

  stream(data: Buffer): number {
    const compressed = zlib.deflateSync(data)
    return this.add(
      Buffer.concat([
        Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        compressed,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    )
  }

  setDocument(root: number, info: number): void {
    this.root = root
    this.info = info
  }

  build(): Buffer {
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
    let offset = parts[0].length
    const offsets = new Map<number, number>()
    for (const number of [...this.objects.keys()].sort((a, b) => a - b)) {
      offsets.set(number, offset)
      const body = Buffer.concat([
        Buffer.from(`${number} 0 obj\n`, 'latin1'),
        this.objects.get(number) as Buffer,
        Buffer.from('\nendobj\n', 'latin1'),
      ])
      parts.push(body)
      offset += body.length
    }
    const xrefAt = offset
    const size = Math.max(...this.objects.keys()) + 1
    const xref: string[] = [`xref\n0 ${size}\n`, '0000000000 65535 f \n']
    for (let number = 1; number < size; number += 1) {
      const at = offsets.get(number)
      xref.push(at === undefined ? '0000000000 65535 f \n' : `${String(at).padStart(10, '0')} 00000 n \n`)
    }
    parts.push(
      Buffer.from(
        xref.join('') +
          `trailer\n<< /Size ${size} /Root ${this.root} 0 R /Info ${this.info} 0 R >>\n` +
          `startxref\n${xrefAt}\n%%EOF\n`,
        'latin1',
      ),
    )
    return Buffer.concat(parts)
  }
}

/** Build a native-text PDF whose text layer contains `pages` verbatim. */
export function buildTextPdf(pages: string[], title = 'AcePass 验收测试材料（自动生成，非真题）'): Buffer {
  const builder = new PdfBuilder()
  const catalog = builder.reserve()
  const pagesNode = builder.reserve()
  const info = builder.reserve()
  const font = builder.reserve()
  const descendant = builder.reserve()
  const descriptor = builder.reserve()
  const toUnicode = builder.reserve()

  const codes = new Map<string, number>()
  for (const page of pages) {
    for (const character of page) {
      if (character === '\n' || character === '\r') continue
      if (!codes.has(character)) codes.set(character, character.codePointAt(0) as number)
    }
  }
  const bfchar = [...codes.entries()].map(([character, code]) => {
    const unicode = (character.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')
    return `<${code.toString(16).toUpperCase().padStart(4, '0')}> <${unicode}>\n`
  })
  const cmap = Buffer.from(
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /AcePass-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      `${Math.min(codes.size, 100)} beginbfchar\n${bfchar.join('')}endbfchar\n` +
      'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend',
    'latin1',
  )
  builder.set(
    toUnicode,
    Buffer.concat([
      Buffer.from(`<< /Length ${cmap.length} >>\nstream\n`, 'latin1'),
      cmap,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  )

  const pageRefs: number[] = []
  for (const pageText of pages) {
    const lines = pageText.split('\n')
    const body: Buffer[] = [Buffer.from('BT\n/F1 12 Tf\n14 TL\n1 0 0 1 40 800 Tm\n', 'latin1')]
    lines.forEach((line, index) => {
      if (index) body.push(Buffer.from('T*\n', 'latin1'))
      const encoded = [...line]
        .map((character) => {
          const code = codes.get(character)
          return code === undefined ? '' : code.toString(16).toUpperCase().padStart(4, '0')
        })
        .join('')
      body.push(Buffer.from(`<${encoded}> Tj\n`, 'latin1'))
    })
    body.push(Buffer.from('ET\n', 'latin1'))
    const contentRef = builder.stream(Buffer.concat(body))
    pageRefs.push(
      builder.add(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesNode} 0 R /MediaBox [0 0 595 842] ` +
            `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentRef} 0 R >>`,
          'latin1',
        ),
      ),
    )
  }

  const fontFile = builder.add(Buffer.from('<< /Length 0 >>\nstream\n\nendstream', 'latin1'))
  builder.set(
    descriptor,
    Buffer.from(
      `<< /Type /FontDescriptor /FontName /AcePassTest /Flags 4 /FontBBox [0 -200 1000 900] ` +
        `/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${fontFile} 0 R >>`,
      'latin1',
    ),
  )
  builder.set(
    descendant,
    Buffer.from(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AcePassTest ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${descriptor} 0 R /DW 1000 /W [0 [1000 1000 1000]] >>`,
      'latin1',
    ),
  )
  builder.set(
    font,
    Buffer.from(
      `<< /Type /Font /Subtype /Type0 /BaseFont /AcePassTest /Encoding /Identity-H ` +
        `/DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
      'latin1',
    ),
  )
  builder.set(
    pagesNode,
    Buffer.from(
      `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`,
      'latin1',
    ),
  )
  builder.set(catalog, Buffer.from(`<< /Type /Catalog /Pages ${pagesNode} 0 R >>`, 'latin1'))
  builder.set(
    info,
    Buffer.from(
      `<< /Title (${escapePdfText(title)}) /Producer (AcePass acceptance PDF builder) >>`,
      'latin1',
    ),
  )
  builder.setDocument(catalog, info)
  return builder.build()
}
