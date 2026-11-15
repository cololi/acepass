/**
 * Native-text PDF extraction — the `pdfjs-dist` adapter for
 * `backend/apps/ingestion/services/pdf_text.py`.
 *
 * Only *born-digital* PDFs are supported: pages that already carry a text layer. That is a
 * deliberate boundary, not a limitation to hide:
 *
 * - no OCR, no vision model, no credentials — the import must work offline;
 * - a scanned page (an image without text) is reported as `no_text_layer` so the material goes to the
 *   manual/vision proofreading path instead of being silently imported as an empty question;
 * - every extracted page keeps its own index, which is what makes "来源页可追溯" a fact of the data
 *   model rather than a claim in the UI.
 *
 * **Why `pdfjs-dist` and what changes.** Python uses `pypdf`'s two visitors: `visitor_operand_before`
 * for the exact matrix of every show-text operator, and `visitor_text` as the fallback. `pdfjs` has a
 * single API, `page.getTextContent()`, which returns one item per run with a composed
 * `[a, b, c, d, e, f]` transform (current transformation matrix × text matrix), a `str`, a `hasEOL`
 * flag and font-dependent `width`/`height`. The adapter therefore:
 *
 * 1. takes `x = transform[4]`, `y = transform[5]` (the baseline, PDF points, y up) and derives the
 *    font size from the matrix's vertical scale — the same quantities pypdf reports to the visitor;
 * 2. **recomputes** the run width with the Python estimator (`estimateWidthPt`) instead of using
 *    `item.width`, which is the font's advance width and would make the same page classify
 *    differently under a different font;
 * 3. rebuilds the page text from `item.str` + `hasEOL` and then applies the *same* `normalise` /
 *    `orderPageText` pipeline, so the wording is the extractor's and the ordering is the port's.
 *
 * The two libraries do not have to agree on every PDF (glyph decoding, run merging and float boxes
 * are library-specific); what must agree is the *classification* on the same geometry, which is why
 * `pdf_layout.ts` is pure and checked by golden vectors, and why the real-PDF comparison in
 * `docs/dsh-migration/13-ingestion-b4.md` is per page, not per hash.
 *
 * `pdfjs-dist` is loaded through `createRequire` for the same two reasons as `sharp`: esbuild must
 * not bundle it, and this repository keeps `dsh-plugin/node_modules` as a symlink to
 * `frontend/node_modules`, so the development install lives in `dsh-plugin/.deps`. The **legacy**
 * build is used on purpose: the modern build needs `Uint8Array.prototype.toHex`, which Node 24 does
 * not have (verified: it throws `hashOriginal.toHex is not a function` at import time).
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { pyCodePointLen } from '../domain/ingestion/pystring.ts'
import {
  DEFAULT_FONT_SIZE_PT,
  LINE_Y_TOLERANCE_PT,
  MAX_FRAGMENTS_PER_PAGE,
  MIN_PAGE_CHARS,
  bboxForText,
  buildPage,
  classifyPage,
  diagnosticRow,
  estimateWidthPt,
  joinLine,
  joinedText,
  makeFragment,
  normalise,
  orderedPageText,
  pageBox,
  pageMap,
  pageNotes,
  pyStrip,
  suspiciousPages,
  type BBox,
  type PageDiagnosticRow,
  type PdfFragment,
  type PdfPage,
} from '../domain/ingestion/pdf_layout.ts'
import { DependencyUnavailable, InvalidInput } from '../services/errors.ts'

// --------------------------------------------------------------------------
// Limits (kept identical to `pdf_text.py`)
// --------------------------------------------------------------------------
/** Refuse absurd inputs before spending memory on them. */
export const MAX_PDF_BYTES = 40 * 1024 * 1024
export const MAX_PDF_PAGES = 200
export const MAX_TEXT_CHARS = 2_000_000

/** The message templates, exported so the service layer and the tests share one spelling. */
export const PDF_MESSAGES = {
  emptyFile: 'PDF 文件为空',
  tooLarge: `PDF 超过大小上限 ${MAX_PDF_BYTES / (1024 * 1024)} MiB`,
  notPdf: '文件不是 PDF（缺少 %PDF- 头）',
  damaged: 'PDF 结构损坏，无法解析',
  unparsable: 'PDF 无法解析',
  encrypted: 'PDF 已加密，请先提供未加密版本（本功能不支持解密）',
  pageCountUnreadable: 'PDF 页数无法读取',
  noPages: 'PDF 没有任何页面',
  noTextLayer:
    '未从该 PDF 中提取到文字层：它可能是扫描件/图片版。' +
    '原生文字 PDF 才能自动结构化；扫描件请走图片导入的人工校对路径。',
} as const

// --------------------------------------------------------------------------
// The extraction result
// --------------------------------------------------------------------------
export interface PdfExtraction {
  pageCount: number
  pages: PdfPage[]
  characterCount: number
  emptyPages: number[]
  metadata: Record<string, string>
  pageDiagnostics: PageDiagnosticRow[]
  /** All pages joined in reading order (page indexes are recoverable through `pageMap`). */
  readonly text: string
  readonly hasTextLayer: boolean
  readonly suspiciousPages: number[]
  pageMap(): Array<[number, number, number]>
  fragmentsForPage(pageIndex: number): PdfFragment[]
}

function buildExtraction(input: {
  pageCount: number
  pages: PdfPage[]
  characterCount: number
  emptyPages: number[]
  metadata: Record<string, string>
}): PdfExtraction {
  const rows = input.pages.map(diagnosticRow)
  return {
    pageCount: input.pageCount,
    pages: input.pages,
    characterCount: input.characterCount,
    emptyPages: [...input.emptyPages],
    metadata: input.metadata,
    pageDiagnostics: rows,
    get text(): string {
      return joinedText(input.pages)
    },
    get hasTextLayer(): boolean {
      return input.characterCount >= MIN_PAGE_CHARS
    },
    get suspiciousPages(): number[] {
      return suspiciousPages(rows)
    },
    pageMap(): Array<[number, number, number]> {
      return pageMap(input.pages)
    },
    fragmentsForPage(pageIndex: number): PdfFragment[] {
      return input.pages.find((page) => page.pageIndex === pageIndex)?.fragments ?? []
    },
  }
}

// --------------------------------------------------------------------------
// pdfjs resolution
// --------------------------------------------------------------------------
/** The subset of the `pdfjs-dist` surface this adapter calls. */
interface PdfJsOperatorList {
  fnArray: number[]
  argsArray: unknown[][]
}

interface PdfJsPage {
  view: number[]
  getOperatorList(): Promise<PdfJsOperatorList>
}

interface PdfJsDocument {
  numPages: number
  getPage(index: number): Promise<PdfJsPage>
  getMetadata(): Promise<{ info?: Record<string, unknown> }>
  cleanup(): Promise<void> | boolean
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>
  destroy(): Promise<void>
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): PdfJsLoadingTask
  OPS: Record<string, number>
}

/** A document plus the only handle that can release it (`PDFDocumentProxy` has no `destroy` in v6). */
interface OpenedDocument {
  doc: PdfJsDocument
  release(): Promise<void>
}

let cachedModule: PdfJsModule | null = null
let cachedDirectory: string | null = null

/** Walk up from this module to the package root (works from `src/ingestion/` and from `lib/`). */
function pluginRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return process.cwd()
}

/**
 * Resolve the `pdfjs-dist` package directory.
 *
 * A packaged plugin resolves the bare specifier; a checkout resolves the vendored copy under
 * `.deps`. Both runtimes (system Node and the DSH Electron Node) load the same legacy ESM build —
 * verified in `npm run verify`.
 */
function resolvePdfjsDirectory(): string {
  const require = createRequire(import.meta.url)
  const failures: string[] = []
  const candidates: string[] = []
  try {
    candidates.push(dirname(require.resolve('pdfjs-dist/package.json')))
  } catch (error) {
    failures.push(`pdfjs-dist: ${(error as Error).message}`)
  }
  candidates.push(join(pluginRoot(), '.deps', 'node_modules', 'pdfjs-dist'))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'legacy', 'build', 'pdf.mjs'))) return candidate
    failures.push(`${candidate}: legacy/build/pdf.mjs is missing`)
  }
  throw new DependencyUnavailable('PDF 处理依赖不可用（pdfjs-dist 未能加载），无法解析原生文字 PDF', {
    details: { reason: 'dependency_unavailable', dependency: 'pdfjs-dist', attempts: failures },
  })
}

/** Load (and cache) the legacy build. `require(esm)` works on Node 24; the import path is the fallback. */
export async function loadPdfjs(): Promise<PdfJsModule> {
  if (cachedModule !== null) return cachedModule
  const directory = resolvePdfjsDirectory()
  const entry = join(directory, 'legacy', 'build', 'pdf.mjs')
  const require = createRequire(import.meta.url)
  let loaded: unknown
  try {
    loaded = require(entry)
  } catch {
    // A computed specifier keeps esbuild from trying to bundle the module.
    loaded = await import(pathToFileURL(entry).href)
  }
  const module = loaded as PdfJsModule
  if (typeof module.getDocument !== 'function') {
    throw new DependencyUnavailable('PDF 处理依赖不可用（pdfjs-dist 未能加载），无法解析原生文字 PDF', {
      details: { reason: 'dependency_unavailable', dependency: 'pdfjs-dist', entry },
    })
  }
  cachedModule = module
  cachedDirectory = directory
  return module
}

/** Test hook: forget the resolved module (used by the dependency-missing test). */
export function resetPdfjsCache(): void {
  cachedModule = null
  cachedDirectory = null
}

function standardFontDataUrl(): string | undefined {
  if (cachedDirectory === null) return undefined
  return `${join(cachedDirectory, 'standard_fonts')}/`
}

function cMapUrl(): string | undefined {
  if (cachedDirectory === null) return undefined
  return `${join(cachedDirectory, 'cmaps')}/`
}

function wasmUrl(): string | undefined {
  if (cachedDirectory === null) return undefined
  return `${join(cachedDirectory, 'wasm')}/`
}

// --------------------------------------------------------------------------
// Extraction
// --------------------------------------------------------------------------
/**
 * `_open_reader`'s input checks, then the document open.
 *
 * The order is the observable contract: empty → too large → missing `%PDF-` header → damaged →
 * encrypted. An encrypted document whose **empty** user password unlocks is *not* an error; that is
 * a legitimate "no password" file and the extraction continues.
 */
async function openDocument(bytes: Uint8Array): Promise<OpenedDocument> {
  if (bytes.byteLength === 0) {
    throw new InvalidInput(PDF_MESSAGES.emptyFile, { details: { reason: 'empty_file' } })
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new InvalidInput(PDF_MESSAGES.tooLarge, { details: { reason: 'too_large', size: bytes.byteLength } })
  }
  // `content[:5].startswith(b"%PDF-")`
  const header = String.fromCharCode(...bytes.subarray(0, 5))
  if (header !== '%PDF-') {
    throw new InvalidInput(PDF_MESSAGES.notPdf, { details: { reason: 'not_pdf' } })
  }
  const pdfjs = await loadPdfjs()
  const loading = pdfjs.getDocument({
    // A copy: pdf.js may take ownership of the buffer, and the caller still needs the original bytes
    // for the checksum it stores on the asset.
    data: new Uint8Array(bytes),
    // An empty user password is the "no password" case; a required password rejects below.
    password: '',
    isEvalSupported: false,
    // Determinism: never reach for the host's fonts, and stay quiet in tests.
    useSystemFonts: false,
    verbosity: 0,
    standardFontDataUrl: standardFontDataUrl(),
    cMapUrl: cMapUrl(),
    cMapPacked: true,
    wasmUrl: wasmUrl(),
  })
  try {
    const doc = await loading.promise
    return {
      doc,
      release: async () => {
        // `destroy()` tears the loading task (and its worker/fake-worker) down; `cleanup()` only
        // drops caches. Both are best effort: a failure here must not mask a successful extraction.
        try {
          await loading.destroy()
        } catch {
          try {
            await doc.cleanup()
          } catch {
            // ignored
          }
        }
      },
    }
  } catch (error) {
    const name = (error as { name?: unknown })?.name
    if (name === 'PasswordException') {
      throw new InvalidInput(PDF_MESSAGES.encrypted, { details: { reason: 'encrypted' } })
    }
    if (name === 'InvalidPDFException') {
      throw new InvalidInput(PDF_MESSAGES.damaged, { details: { reason: 'damaged' } })
    }
    throw new InvalidInput(PDF_MESSAGES.unparsable, { details: { reason: 'damaged' } })
  }
}

/** The font size of one text run, from the matrix's vertical scale. */
function fontSizeFromTransform(transform: unknown): number {
  if (!Array.isArray(transform) || transform.length < 4) return 0
  const c = Number(transform[2])
  const d = Number(transform[3])
  const size = Math.hypot(Number.isFinite(c) ? c : 0, Number.isFinite(d) ? d : 0)
  return Number.isFinite(size) && size > 0 ? size : 0
}

/**
 * `_extract_page`: plain text plus per-run geometry; **never fails the whole document**.
 *
 * **Why the operator list and not `getTextContent()`.** pdf.js' text-content API is built for
 * rendering: it merges a run into chunks, splits one show-text operator at every visual gap wider
 * than 0.6 em (emitting the gap as a separate `" "` item), and — decisively — **drops every glyph
 * whose device x is outside the page's view box**. pypdf's operand visitor does none of those
 * things: one fragment per show-text operator, spaces kept inside the string, and out-of-box runs
 * kept (which is exactly why `bboxForText` clamps instead of rejecting). Measured against the
 * Python extractor, `getTextContent()` truncated the tail of a formula line that overflows the right
 * margin (`【题干】… ∫_0^1 f(x)dx 的值。` lost its last 12 characters) and split `A. 甲` into three
 * items, which in turn made the two-column fixture look like a table grid. Both are publish-gate
 * changes, not float noise, so the adapter reads `page.getOperatorList()` instead and rebuilds the
 * run list the way the oracle sees it:
 *
 * - `setFont` → the nominal font size (pypdf's `Tf` operand, *not* the composed matrix scale);
 * - `setTextMatrix` / `moveText` / `nextLine` → the text matrix, exactly like a content-stream
 *   interpreter (the same state machine `pypdf` uses for `tm`);
 * - `transform` / `save` / `restore` / `paintFormXObjectBegin` / `paintFormXObjectEnd` → the CTM
 *   stack, so a run inside a form XObject lands where the page actually draws it;
 * - `showText` → the glyph array, whose `unicode` values are the decoded text and whose position is
 *   the translation of `CTM × TM`.
 *
 * The page text is then rebuilt from those same runs in **stream order**, starting a new line when
 * the baseline moves by more than the line tolerance and joining runs on one line with the same
 * gap rule the column rebuild uses (`joinLine`). That is the plain-extraction behaviour the oracle
 * gets from `pypdf.extract_text()`, and it is verified character for character against it on every
 * fixture (`docs/dsh-migration/13-ingestion-b4.md`).
 *
 * A page whose operator list cannot be produced contributes an empty page rather than failing the
 * document (P1 behaviour). That is *less* capable than pypdf, which retries without geometry, and is
 * recorded in `04-parity-findings.md §L`.
 */
async function extractPage(
  page: PdfJsPage,
  ops: Record<string, number>,
): Promise<{ text: string; fragments: PdfFragment[]; truncated: boolean }> {
  const box = pageBox(page.view)
  const pageHeight = box[3] - box[1]
  const yTolerance = LINE_Y_TOLERANCE_PT / pageHeight

  let list: PdfJsOperatorList = { fnArray: [], argsArray: [] }
  try {
    list = await page.getOperatorList()
  } catch {
    list = { fnArray: [], argsArray: [] }
  }
  let ctm: Matrix = IDENTITY
  let tm: Matrix = IDENTITY
  let tlm: Matrix = IDENTITY
  let leading = 0
  let fontSize = DEFAULT_FONT_SIZE_PT
  const stack: Matrix[] = []
  const fragments: PdfFragment[] = []
  let truncated = false

  for (let index = 0; index < list.fnArray.length; index += 1) {
    const fn = list.fnArray[index]
    const args = list.argsArray[index] ?? []
    if (fn === ops['save']) {
      stack.push(ctm)
    } else if (fn === ops['restore']) {
      ctm = stack.pop() ?? ctm
    } else if (fn === ops['transform']) {
      const matrix = matrixOf(args)
      if (matrix !== null) ctm = multiply(ctm, matrix)
    } else if (fn === ops['paintFormXObjectBegin']) {
      stack.push(ctm)
      const matrix = args.length > 0 ? matrixOf([args[0]]) : null
      if (matrix !== null) ctm = multiply(ctm, matrix)
    } else if (fn === ops['paintFormXObjectEnd']) {
      ctm = stack.pop() ?? ctm
    } else if (fn === ops['beginText']) {
      tm = IDENTITY
      tlm = IDENTITY
    } else if (fn === ops['setFont']) {
      const size = Number(args[1])
      if (Number.isFinite(size) && size > 0) fontSize = size
    } else if (fn === ops['setLeading']) {
      const value = Number(args[0])
      if (Number.isFinite(value)) leading = value
    } else if (fn === ops['setTextMatrix']) {
      const matrix = matrixOf(args)
      if (matrix !== null) {
        tlm = matrix
        tm = matrix
      }
    } else if (fn === ops['moveText']) {
      const tx = Number(args[0])
      const ty = Number(args[1])
      if (Number.isFinite(tx) && Number.isFinite(ty)) {
        tlm = multiply([1, 0, 0, 1, tx, ty], tlm)
        tm = tlm
      }
    } else if (fn === ops['nextLine']) {
      tlm = multiply([1, 0, 0, 1, 0, -leading], tlm)
      tm = tlm
    } else if (fn === ops['showText']) {
      const glyphs = args[0]
      if (!Array.isArray(glyphs)) continue
      let text = ''
      for (const glyph of glyphs) {
        const unicode = (glyph as { unicode?: unknown })?.unicode
        if (typeof unicode === 'string') text += unicode
      }
      const trimmed = pyStrip(text)
      if (trimmed === '') continue
      if (fragments.length >= MAX_FRAGMENTS_PER_PAGE) {
        truncated = true
        continue
      }
      const device = multiply(ctm, tm)
      const fragment = makeFragment(trimmed, device[4], device[5], fontSize, box)
      appendFragment(fragments, fragment, fontSize, box)
    }
  }

  // Plain text: stream order, a new line per baseline, runs on one line joined like the oracle's.
  const lines: PdfFragment[][] = []
  for (const fragment of fragments) {
    const current = lines[lines.length - 1]
    if (current !== undefined && Math.abs(fragment.y - current[0].y) <= yTolerance) current.push(fragment)
    else lines.push([fragment])
  }
  return { text: lines.map(joinLine).join('\n'), fragments, truncated }
}

/** A 2×3 affine matrix, row-major as PDF writes it: `[a, b, c, d, e, f]`. */
type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/**
 * Read an affine matrix out of an operator argument.
 *
 * pdf.js wraps a single matrix argument in an array of one (`[[a, b, c, d, e, f]]` for
 * `setTextMatrix`), and sometimes hands over a plain six-number array. Both shapes appear in the
 * operator list, so the reader accepts either and returns `null` for anything else.
 */
function matrixOf(args: readonly unknown[]): Matrix | null {
  // `setTextMatrix` arrives as `[matrixLike]`, `transform` as the six numbers directly.
  const candidate =
    args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? (args[0] as unknown as readonly unknown[]) : args
  if (candidate === null || candidate === undefined || candidate.length < 6) return null
  const values = [candidate[0], candidate[1], candidate[2], candidate[3], candidate[4], candidate[5]].map(Number)
  if (!values.every((value) => Number.isFinite(value))) return null
  return values as Matrix
}

/** `m × n` for two affine matrices. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/**
 * `_append_fragment`: merge runs that share one exact position.
 *
 * Two show-text operators can land on the same point (a `TJ` array split into several `Tj` by the
 * producer, with zero kerning); pypdf's visitor merges them and so does this port. The width is
 * recomputed from the merged text at the *current* run's size, exactly like the oracle.
 */
function appendFragment(
  fragments: PdfFragment[],
  fragment: PdfFragment,
  fontSize: number,
  box: readonly [number, number, number, number],
): void {
  const previous = fragments[fragments.length - 1]
  if (previous !== undefined && Math.abs(previous.x - fragment.x) < 1e-9 && Math.abs(previous.y - fragment.y) < 1e-9) {
    const merged = previous.text + fragment.text
    const size = fontSize > 0 ? fontSize : DEFAULT_FONT_SIZE_PT
    fragments[fragments.length - 1] = {
      x: previous.x,
      y: previous.y,
      width: estimateWidthPt(merged, size) / (box[2] - box[0]),
      height: (size * 1.2) / (box[3] - box[1]),
      text: merged,
    }
    return
  }
  fragments.push(fragment)
}

/** `_metadata`: only the three fields the extractor reports, truncated to 300 characters. */
function readMetadata(doc: PdfJsDocument, info: Record<string, unknown> | undefined): Record<string, string> {
  void doc
  const out: Record<string, string> = {}
  if (info === undefined || info === null) return out
  for (const key of ['Title', 'Producer', 'Creator'] as const) {
    const value = info[key]
    if (value === null || value === undefined || value === '') continue
    out[key.toLowerCase()] = pySlice(String(value), 0, 300)
  }
  return out
}

function pySlice(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join('')
}

/**
 * `extract_native_text`: extract the text layer of a born-digital PDF, page by page.
 *
 * Failures raise `InvalidInput` with a machine-readable `details.reason` so the API can explain
 * exactly what to do next — the messages are the Python ones, verbatim.
 */
export async function extractNativeText(bytes: Uint8Array): Promise<PdfExtraction> {
  const pdfjs = await loadPdfjs()
  const ops = pdfjs.OPS
  const opened = await openDocument(bytes)
  const doc = opened.doc
  try {
    let pageCount: number
    try {
      pageCount = doc.numPages
    } catch {
      throw new InvalidInput(PDF_MESSAGES.pageCountUnreadable, { details: { reason: 'damaged' } })
    }
    if (!Number.isFinite(pageCount)) {
      throw new InvalidInput(PDF_MESSAGES.pageCountUnreadable, { details: { reason: 'damaged' } })
    }
    if (pageCount === 0) {
      throw new InvalidInput(PDF_MESSAGES.noPages, { details: { reason: 'no_pages' } })
    }
    if (pageCount > MAX_PDF_PAGES) {
      throw new InvalidInput(`PDF 页数 ${pageCount} 超过上限 ${MAX_PDF_PAGES}，请拆分后分批导入`, {
        details: { reason: 'too_many_pages', pages: pageCount },
      })
    }

    const pages: PdfPage[] = []
    const emptyPages: number[] = []
    let total = 0
    for (let index = 1; index <= pageCount; index += 1) {
      let page: PdfJsPage
      try {
        page = await doc.getPage(index)
      } catch {
        // A page that cannot be read contributes an empty page rather than failing the document.
        page = { view: [0, 0, 595, 842], getOperatorList: async () => ({ fnArray: [], argsArray: [] }) }
      }
      const extracted = await extractPage(page, ops)
      const box = pageBox(page.view)
      const notes = pageNotes(box, extracted.truncated)
      let cleaned = normalise(extracted.text)
      const facts = classifyPage(cleaned, extracted.fragments, notes)
      cleaned = orderedPageText(cleaned, extracted.fragments, notes, facts)
      if (pyCodePointLen(pyStrip(cleaned)) < MIN_PAGE_CHARS) emptyPages.push(index)
      total += pyCodePointLen(cleaned)
      if (total > MAX_TEXT_CHARS) {
        throw new InvalidInput('PDF 文本量超过上限，请拆分后分批导入', {
          details: { reason: 'too_much_text', characters: total },
        })
      }
      pages.push(buildPage(index, cleaned, extracted.fragments, facts))
    }

    let info: Record<string, unknown> | undefined
    try {
      const metadata = await doc.getMetadata()
      info = metadata?.info
    } catch {
      info = undefined
    }
    const extraction = buildExtraction({
      pageCount,
      pages,
      characterCount: total,
      emptyPages,
      metadata: readMetadata(doc, info),
    })
    if (!extraction.hasTextLayer) {
      throw new InvalidInput(PDF_MESSAGES.noTextLayer, {
        details: { reason: 'no_text_layer', pages: pageCount, empty_pages: emptyPages },
      })
    }
    return extraction
  } finally {
    // Release pdf.js' caches; without this a long test run keeps every parsed page alive.
    await opened.release()
  }
}

/** `bbox_for_text` for one page of an extraction (the service's geometry step). */
export function pageBbox(extraction: PdfExtraction, pageIndex: number, needle: string): BBox | null {
  const page = extraction.pages.find((candidate) => candidate.pageIndex === pageIndex)
  if (page === undefined) return null
  return bboxForText(page, needle)
}
