import { PdfBuilder } from './pdfFixture'

/**
 * Layout-capable acceptance PDF fixture (P2 batch 1 / C01).
 *
 * `buildTextPdf` lays every line out at one x position, which cannot express a
 * two-column page, an aligned table row or a formula line. This builder gives
 * every text fragment its own `Tm`, so the browser suite can hand the server a
 * *real* multi-column / grid / formula PDF and check what the deterministic
 * parser reports about it.
 *
 * Same font machinery as the text fixture (Type0 / Identity-H with a ToUnicode
 * CMap, glyph id == code point), so Chinese round-trips without an embedded font.
 */

export interface LayoutFragment {
  /** Left edge in PDF points (origin bottom-left). */
  x: number
  /** Baseline y in PDF points, measured from the bottom. */
  y: number
  text: string
}

function collectCodes(fragments: LayoutFragment[]): Map<string, number> {
  const codes = new Map<string, number>()
  for (const fragment of fragments) {
    for (const character of fragment.text) {
      if (character === '\n' || character === '\r') continue
      if (!codes.has(character)) codes.set(character, character.codePointAt(0) as number)
    }
  }
  return codes
}

function layoutPageContent(fragments: LayoutFragment[], codes: Map<string, number>): Buffer {
  const body: Buffer[] = [Buffer.from('BT\n/F1 12 Tf\n', 'latin1')]
  for (const fragment of fragments) {
    const encoded = [...fragment.text]
      .map((character) => {
        const code = codes.get(character)
        return code === undefined ? '' : code.toString(16).toUpperCase().padStart(4, '0')
      })
      .join('')
    body.push(Buffer.from(`1 0 0 1 ${fragment.x} ${fragment.y} Tm\n<${encoded}> Tj\n`, 'latin1'))
  }
  body.push(Buffer.from('ET\n', 'latin1'))
  return Buffer.concat(body)
}

export function buildLayoutPdf(
  pages: LayoutFragment[][],
  title = 'AcePass 验收版面测试材料（自动生成，非真题）',
): Buffer {
  const builder = new PdfBuilder()
  const catalog = builder.reserve()
  const pagesNode = builder.reserve()
  const info = builder.reserve()
  const font = builder.reserve()
  const descendant = builder.reserve()
  const descriptor = builder.reserve()
  const toUnicode = builder.reserve()

  const codes = collectCodes(pages.flat())
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
  for (const fragments of pages) {
    const contentRef = builder.stream(layoutPageContent(fragments, codes))
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
      `<< /Title (${title.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) ` +
        `/Producer (AcePass acceptance layout PDF builder) >>`,
      'latin1',
    ),
  )
  builder.setDocument(catalog, info)
  return builder.build()
}
