/**
 * Deterministic PDF layout classification — port of the layout half of
 * `backend/apps/ingestion/services/pdf_text.py`.
 *
 * This module is **pure**: it takes already-normalised fragments (fractions of the page, origin at
 * the top left) and the page's plain text, and returns the same page classification the Python
 * extractor produces. Nothing here opens a PDF, and nothing here needs `pdfjs`: that separation is
 * what lets the thresholds be checked against golden vectors built from synthetic geometry, while
 * the *library* differences (pypdf vs pdfjs) are audited separately, page by page.
 *
 * The whole "intelligence" of the extractor is the arithmetic below. Every threshold is expressed in
 * PDF points and divided by the real page size, so the same constants hold for A4, Letter or a
 * landscape scan. `tests/golden/ingestion_b4_pdf.json` pins every branch — including the boundary
 * cases (`<=` vs `<`) — against the real Python functions.
 *
 * Three behaviours are easy to get wrong and are therefore called out where they happen:
 *
 * 1. `lines()` groups by the **first** fragment of the open line, not by the previous one, so a
 *    slowly drifting baseline eventually starts a new line instead of dragging the whole page into
 *    one line.
 * 2. `detectColumns()` only reorders when *no* fragment reaches into the gutter; a full-width
 *    heading makes the order ambiguous, and an ambiguous page keeps the extractor's order.
 * 3. `orderedPageText()` only ever *reorders*: if the rebuilt text has fewer visible characters than
 *    the plain extraction, the plain text wins and the page is marked unreliable. Text is never lost
 *    to a layout guess.
 */
import {
  REASON_COLUMN_ORDER_AMBIGUOUS,
  REASON_FORMULA,
  REASON_GEOMETRY_UNAVAILABLE,
  REASON_MULTI_COLUMN,
  REASON_SCANNED,
  REASON_TABLE_GRID,
  REASON_TOO_MANY_FRAGMENTS,
  needsReview,
} from './layout.ts'
import { PY_SPACE_CLASS, pyCodePointLen } from './pystring.ts'

// --------------------------------------------------------------------------
// Thresholds (PDF points; converted with the real page size)
// --------------------------------------------------------------------------
/** Fragments whose baselines differ by less than this sit on the same line. */
export const LINE_Y_TOLERANCE_PT = 3.0
/** Left edges within this distance start the same column band. */
export const COLUMN_X_TOLERANCE_PT = 12.0
/** A band is only a column when it carries real content, not one stray fragment. */
export const COLUMN_MIN_FRAGMENTS_PER_CLUSTER = 3
/** ... and at least this share of the page's fragments. */
export const COLUMN_MIN_CLUSTER_SHARE = 0.15
/** Empty space between two bands must be at least this wide to be a gutter. */
export const COLUMN_GUTTER_MIN_WIDTH_PT = 12.0
/** The two bands must run side by side for at least this share of the page height. */
export const COLUMN_MIN_VERTICAL_OVERLAP = 0.5
/** At most this share of the two bands' fragments may reach into the gutter. */
export const COLUMN_MAX_GUTTER_CROSS_RATIO = 0.25
/** A table row needs at least this many cells sharing a baseline. */
export const GRID_ROW_MIN_FRAGMENTS = 3
/** ... and a grid needs at least this many such rows... */
export const GRID_MIN_ROWS = 3
/** ... with cells in one column aligned within this distance... */
export const GRID_X_TOLERANCE_PT = 6.0
/** ... across at least this many aligned columns/rows. */
export const GRID_MIN_ALIGNED_COLUMNS = 3
export const GRID_MIN_ALIGNED_ROWS = 2
/** Unambiguous math notation: one occurrence is enough to require review. */
export const FORMULA_STRONG_SYMBOLS = '∫∑∏√≤≥±≈≠∞∂∈∉∪∩⊂⊆⇒⇔∴'
/** Weaker constructs: a single `x^2` is ordinary wording, two mean real notation. */
export const FORMULA_CONSTRUCT_PATTERN = /\\[A-Za-z]{2,}|[\^_]\s*\{?\s*[0-9A-Za-z]|[×÷]/g
export const FORMULA_MIN_CONSTRUCTS = 2
/** `____` is a fill-in blank, not a subscript; it is removed before counting. */
export const BLANK_MARKER_RUN = /_{2,}/g
/** Geometry is only collected up to this many fragments per page. */
export const MAX_FRAGMENTS_PER_PAGE = 4000
/** Fallback font size when the extractor does not report one. */
export const DEFAULT_FONT_SIZE_PT = 12.0
/** Fallback page size when the media box cannot be read (A4 in points). */
export const DEFAULT_PAGE_BOX: readonly [number, number, number, number] = [0.0, 0.0, 595.0, 842.0]
/** A page with fewer visible characters than this is treated as "no text". */
export const MIN_PAGE_CHARS = 2
/** Smallest region a bounding box may describe. */
export const MIN_REGION_SIZE = 0.005


/** One text-showing operation with normalised, top-down geometry. */
export interface PdfFragment {
  /** Fraction of the page width, 0..1, origin at the left edge. */
  x: number
  /** Fraction of the page height, 0..1, origin at the **top** edge. */
  y: number
  width: number
  height: number
  text: string
}

/** What the extractor could not tell us, so the caller can record it. */
export interface PageNotes {
  widthPt: number
  heightPt: number
  truncated: boolean
}

/** One page's layout classification. */
export interface LayoutFacts {
  columns: number
  /** True when no fragment reaches across a detected gutter. */
  unambiguous: boolean
  hasTableGrid: boolean
  hasFormulaTokens: boolean
  isScanned: boolean
  readingOrderReliable: boolean
  reasons: string[]
}

/** A page as the rest of the import sees it. */
export interface PdfPage {
  /** 1-based, matching `SourceRegion.page_index`. */
  pageIndex: number
  text: string
  characterCount: number
  fragments: PdfFragment[]
  columns: number
  hasTableGrid: boolean
  hasFormulaTokens: boolean
  isScanned: boolean
  readingOrderReliable: boolean
  diagnostics: string[]
}

/** The `{x, y, width, height}` box a source region stores. */
export interface BBox {
  x: number
  y: number
  width: number
  height: number
}

/** The page box in PDF points, `[left, bottom, right, top]`. */
export type PageBox = readonly [number, number, number, number]

/** The diagnostic row persisted on `ImportJob.page_diagnostics`. */
export interface PageDiagnosticRow {
  page_index: number
  is_scanned: boolean
  columns: number
  has_table_grid: boolean
  has_formula_tokens: boolean
  reading_order_reliable: boolean
  fragment_count: number
  character_count: number
  reasons: string[]
  needs_review: boolean
  [field: string]: unknown
}

// --------------------------------------------------------------------------
// Python string semantics this module needs
// --------------------------------------------------------------------------
const PY_WHITESPACE_RUN = new RegExp(`[${PY_SPACE_CLASS}]+`, 'g')
const PY_LEADING_WS = new RegExp(`^[${PY_SPACE_CLASS}]+`)
const PY_TRAILING_WS = new RegExp(`[${PY_SPACE_CLASS}]+$`)

/** Python `str.strip()` (whitespace only, Unicode-aware). */
export function pyStrip(text: string): string {
  return text.replace(PY_LEADING_WS, '').replace(PY_TRAILING_WS, '')
}

/** Python `str.rstrip()` (whitespace only, Unicode-aware). */
export function pyRstrip(text: string): string {
  return text.replace(PY_TRAILING_WS, '')
}

/** Python `len(re.sub(r"\s+", "", text))` — the visible character count used by the reorder guard. */
export function visibleCharacters(text: string): number {
  return pyCodePointLen(text.replace(PY_WHITESPACE_RUN, ''))
}

// --------------------------------------------------------------------------
// Fragment construction
// --------------------------------------------------------------------------
/** CJK/fullwidth characters occupy roughly one em, Latin ones about half. */
function isWide(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return code >= 0x2e80
}

/**
 * `_estimate_width_pt`: the width of a run from its own characters.
 *
 * A PDF text-showing operator carries no box, so the width is an estimate. The rule is deliberately
 * the *character* rule rather than the font's advance widths: the classifier only needs stable,
 * comparable geometry, and a font-dependent width would make the same page classify differently
 * under a different extractor.
 */
export function estimateWidthPt(text: string, fontSize: number): number {
  let units = 0
  for (const character of text) units += isWide(character) ? 1.0 : 0.5
  return Math.max(units * fontSize, fontSize * 0.5)
}

/**
 * `_fragment`: normalise one run into page fractions.
 *
 * `xPt`/`yPt` are the device-space position of the run in PDF points (`yPt` is the **baseline**,
 * measured from the bottom of the page). The box starts about one em above the baseline, which is
 * why `y` subtracts `yPt + size`.
 */
export function makeFragment(text: string, xPt: number, yPt: number, fontSize: number | null | undefined, box: PageBox): PdfFragment {
  const left = box[0]
  const right = box[2]
  const bottom = box[1]
  const top = box[3]
  const widthPt = right - left
  const heightPt = top - bottom
  // Python `float(font_size) if font_size else DEFAULT_FONT_SIZE_PT`: a falsy size is "missing".
  let size = fontSize === null || fontSize === undefined || !Number.isFinite(fontSize) || fontSize === 0 ? DEFAULT_FONT_SIZE_PT : fontSize
  if (size <= 0) size = DEFAULT_FONT_SIZE_PT
  return {
    x: (xPt - left) / widthPt,
    y: (top - (yPt + size)) / heightPt,
    width: estimateWidthPt(text, size) / widthPt,
    height: (size * 1.2) / heightPt,
    text,
  }
}

/** `_page_box`: the media box, with the documented A4 fallback for a degenerate one. */
export function pageBox(view: readonly number[] | null | undefined): PageBox {
  if (view === null || view === undefined || view.length < 4) return DEFAULT_PAGE_BOX
  const left = Number(view[0])
  const bottom = Number(view[1])
  const right = Number(view[2])
  const top = Number(view[3])
  if (![left, bottom, right, top].every((value) => Number.isFinite(value))) return DEFAULT_PAGE_BOX
  if (right <= left || top <= bottom) return DEFAULT_PAGE_BOX
  return [left, bottom, right, top]
}

/** The tolerances in normalised units, derived from the real page size. */
export function pageNotes(box: PageBox, truncated = false): PageNotes & {
  xTolerance: number
  yTolerance: number
  gridXTolerance: number
  gutterWidth: number
} {
  const widthPt = box[2] - box[0]
  const heightPt = box[3] - box[1]
  return {
    widthPt,
    heightPt,
    truncated,
    xTolerance: COLUMN_X_TOLERANCE_PT / widthPt,
    yTolerance: LINE_Y_TOLERANCE_PT / heightPt,
    gridXTolerance: GRID_X_TOLERANCE_PT / widthPt,
    gutterWidth: COLUMN_GUTTER_MIN_WIDTH_PT / widthPt,
  }
}

// --------------------------------------------------------------------------
// Line and cluster helpers
// --------------------------------------------------------------------------
/**
 * `_lines`: group fragments into baselines.
 *
 * Sorting is `(y, x)` and the comparison is against the **first** fragment of the open line, which
 * is what makes a drifting baseline break a line instead of absorbing the rest of the page.
 */
export function lines(fragments: readonly PdfFragment[], yTolerance: number): PdfFragment[][] {
  const ordered = [...fragments].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
  const groups: PdfFragment[][] = []
  for (const fragment of ordered) {
    const current = groups[groups.length - 1]
    if (current !== undefined && Math.abs(fragment.y - current[0].y) <= yTolerance) current.push(fragment)
    else groups.push([fragment])
  }
  return groups
}

/** `_x_clusters`: greedy left-edge clustering; a cluster's first fragment stays the anchor. */
export function xClusters(fragments: readonly PdfFragment[], xTolerance: number): PdfFragment[][] {
  const ordered = [...fragments].sort((a, b) => a.x - b.x)
  const groups: PdfFragment[][] = []
  for (const fragment of ordered) {
    const current = groups[groups.length - 1]
    if (current !== undefined && fragment.x - current[0].x <= xTolerance) current.push(fragment)
    else groups.push([fragment])
  }
  return groups
}

function bboxOf(fragment: PdfFragment): [number, number, number, number] {
  return [fragment.x, fragment.y, fragment.x + fragment.width, fragment.y + fragment.height]
}

/** `_band_extent`: the vertical extent of a band, top and bottom. */
function bandExtent(fragments: readonly PdfFragment[]): [number, number] {
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const fragment of fragments) {
    const box = bboxOf(fragment)
    if (box[1] < top) top = box[1]
    if (box[3] > bottom) bottom = box[3]
  }
  return [top, bottom]
}

/** `_join_line`: join one line's fragments, inserting a space for a visible gap. */
export function joinLine(line: readonly PdfFragment[]): string {
  let result = line[0].text
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1]
    const fragment = line[index]
    const gap = fragment.x - (previous.x + previous.width)
    const joiner = gap > 0.3 * Math.max(fragment.height, 1e-6) ? ' ' : ''
    result += joiner + fragment.text
  }
  return result
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------
/**
 * `_detect_columns`: `[columns, unambiguous]` from x bands and the gutters between them.
 *
 * A gutter is real when the empty space between two bands is wide enough, when the bands run side by
 * side for most of the page height, and when few fragments reach across it. `unambiguous` is only
 * true when *no* fragment of either band reaches into the gutter: that is the only case in which the
 * reading order can be derived, so it is the only case in which the page is reordered.
 */
export function detectColumns(
  fragments: readonly PdfFragment[],
  options: { xTolerance: number; gutterWidth: number },
): { columns: number; unambiguous: boolean } {
  if (fragments.length < COLUMN_MIN_FRAGMENTS_PER_CLUSTER * 2) return { columns: 1, unambiguous: true }
  const minimum = Math.max(COLUMN_MIN_FRAGMENTS_PER_CLUSTER, Math.trunc(fragments.length * COLUMN_MIN_CLUSTER_SHARE))
  const clusters = xClusters(fragments, options.xTolerance).filter((cluster) => cluster.length >= minimum)
  if (clusters.length < 2) return { columns: 1, unambiguous: true }

  let qualifying = 0
  let unambiguous = true
  for (let index = 0; index + 1 < clusters.length; index += 1) {
    const leftBand = clusters[index]
    const rightBand = clusters[index + 1]
    let rightStart = Number.POSITIVE_INFINITY
    for (const fragment of rightBand) if (fragment.x < rightStart) rightStart = fragment.x
    // The gutter is the empty space after the left band's ordinary runs: a full-width heading that
    // reaches into the next band does not remove the gutter, it becomes a crossing fragment.
    const contained = leftBand.filter((fragment) => fragment.x + fragment.width <= rightStart)
    if (contained.length === 0) continue
    let gutterStart = Number.NEGATIVE_INFINITY
    for (const fragment of contained) {
      const right = fragment.x + fragment.width
      if (right > gutterStart) gutterStart = right
    }
    const gutterEnd = rightStart
    if (gutterEnd - gutterStart < options.gutterWidth) continue
    const [leftTop, leftBottom] = bandExtent(leftBand)
    const [rightTop, rightBottom] = bandExtent(rightBand)
    const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop)
    if (overlap < COLUMN_MIN_VERTICAL_OVERLAP) continue
    const both = [...leftBand, ...rightBand]
    const crossing = both.filter((fragment) => fragment.x < gutterEnd && fragment.x + fragment.width > gutterStart)
    if (crossing.length / Math.max(both.length, 1) > COLUMN_MAX_GUTTER_CROSS_RATIO) continue
    qualifying += 1
    if (crossing.length > 0) unambiguous = false
  }
  if (qualifying === 0) return { columns: 1, unambiguous: true }
  return { columns: 1 + qualifying, unambiguous }
}

/**
 * `_column_major_text`: rebuild the page column by column, top-down inside each column.
 *
 * Every fragment keeps its cluster (the nearest band anchor), so a heading that starts at the page
 * margin is read with the column it belongs to instead of being lost.
 */
export function columnMajorText(fragments: readonly PdfFragment[], notes: { xTolerance: number; yTolerance: number }): string {
  const clusters = xClusters(fragments, notes.xTolerance)
  const anchors = clusters.map((cluster) => cluster[0].x)

  const clusterOf = (fragment: PdfFragment): number => {
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < anchors.length; index += 1) {
      const distance = Math.abs(anchors[index] - fragment.x)
      // Python `min(range(...), key=...)` keeps the first minimum, so the comparison is strict.
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  }

  const ordered = [...fragments].sort((a, b) => {
    const clusterA = clusterOf(a)
    const clusterB = clusterOf(b)
    if (clusterA !== clusterB) return clusterA - clusterB
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  })
  const grouped: PdfFragment[][] = []
  for (const fragment of ordered) {
    const current = grouped[grouped.length - 1]
    if (
      current !== undefined &&
      clusterOf(fragment) === clusterOf(current[current.length - 1]) &&
      Math.abs(fragment.y - current[current.length - 1].y) <= notes.yTolerance
    ) {
      current.push(fragment)
    } else {
      grouped.push([fragment])
    }
  }
  return grouped.map(joinLine).join('\n')
}

/** `_detect_table_grid`: rows sharing a baseline with cells aligned across consecutive rows. */
export function detectTableGrid(
  fragments: readonly PdfFragment[],
  options: { yTolerance: number; xTolerance: number },
): boolean {
  const rows = lines(fragments, options.yTolerance).filter((line) => line.length >= GRID_ROW_MIN_FRAGMENTS)
  if (rows.length < GRID_MIN_ROWS) return false
  // Cluster cell positions across the rows; a column is a position shared by several rows.
  const columnRows = new Map<number, Set<number>>()
  rows.forEach((row, rowIndex) => {
    for (const fragment of [...row].sort((a, b) => a.x - b.x)) {
      let anchor: number | null = null
      for (const existing of columnRows.keys()) {
        if (Math.abs(existing - fragment.x) <= options.xTolerance) {
          anchor = existing
          break
        }
      }
      if (anchor === null) columnRows.set(fragment.x, new Set([rowIndex]))
      else columnRows.get(anchor)!.add(rowIndex)
    }
  })
  let aligned = 0
  for (const hits of columnRows.values()) if (hits.size >= GRID_MIN_ALIGNED_ROWS) aligned += 1
  return aligned >= GRID_MIN_ALIGNED_COLUMNS
}

/** `_detect_formula_tokens`: deterministic, no model — symbols or sub/superscript constructs. */
export function detectFormulaTokens(text: string): boolean {
  if (pyStrip(text) === '') return false
  const scrubbed = text.replace(BLANK_MARKER_RUN, ' ')
  for (const character of scrubbed) if (FORMULA_STRONG_SYMBOLS.includes(character)) return true
  const matches = scrubbed.match(FORMULA_CONSTRUCT_PATTERN)
  return (matches === null ? 0 : matches.length) >= FORMULA_MIN_CONSTRUCTS
}

/**
 * `_page_layout`: classify one page in one pass; no model, no heuristics beyond the constants.
 *
 * `geometry_unavailable` and `too_many_fragments` mark the reading order unreliable but are **not**
 * review blockers (`needsReview` ignores them), so such a page still imports and publishes normally.
 */
export function classifyPage(
  text: string,
  fragments: readonly PdfFragment[],
  notes: PageNotes & { xTolerance: number; yTolerance: number; gridXTolerance: number; gutterWidth: number },
): LayoutFacts {
  const facts: LayoutFacts = {
    columns: 1,
    unambiguous: true,
    hasTableGrid: false,
    hasFormulaTokens: false,
    isScanned: false,
    readingOrderReliable: true,
    reasons: [],
  }
  facts.isScanned = pyCodePointLen(pyStrip(text)) < MIN_PAGE_CHARS
  if (facts.isScanned) facts.reasons.push(REASON_SCANNED)
  if (fragments.length > 0) {
    const columns = detectColumns(fragments, { xTolerance: notes.xTolerance, gutterWidth: notes.gutterWidth })
    facts.columns = columns.columns
    facts.unambiguous = columns.unambiguous
    if (facts.columns > 1) {
      facts.reasons.push(REASON_MULTI_COLUMN)
      if (!facts.unambiguous) {
        facts.readingOrderReliable = false
        facts.reasons.push(REASON_COLUMN_ORDER_AMBIGUOUS)
      }
    }
    facts.hasTableGrid = detectTableGrid(fragments, { yTolerance: notes.yTolerance, xTolerance: notes.gridXTolerance })
    if (facts.hasTableGrid) facts.reasons.push(REASON_TABLE_GRID)
    if (notes.truncated) {
      // Half a page of geometry cannot be trusted to describe the page.
      facts.readingOrderReliable = false
      facts.reasons.push(REASON_TOO_MANY_FRAGMENTS)
    }
  } else {
    facts.readingOrderReliable = false
    if (pyStrip(text) !== '') facts.reasons.push(REASON_GEOMETRY_UNAVAILABLE)
  }
  if (detectFormulaTokens(text)) {
    facts.hasFormulaTokens = true
    facts.reasons.push(REASON_FORMULA)
  }
  return facts
}

/**
 * `_ordered_page_text`: column-major text when the columns are unambiguous, otherwise unchanged.
 *
 * The rebuild only ever *reorders*: if it does not keep every visible character of the plain
 * extraction, the plain text wins and the page is marked unreliable instead.
 */
export function orderedPageText(
  text: string,
  fragments: readonly PdfFragment[],
  notes: { xTolerance: number; yTolerance: number },
  facts: LayoutFacts,
): string {
  if (facts.columns <= 1 || !facts.unambiguous || fragments.length === 0) return text
  const rebuilt = columnMajorText(fragments, notes)
  if (visibleCharacters(rebuilt) < visibleCharacters(text)) {
    facts.readingOrderReliable = false
    if (!facts.reasons.includes(REASON_COLUMN_ORDER_AMBIGUOUS)) facts.reasons.push(REASON_COLUMN_ORDER_AMBIGUOUS)
    return text
  }
  return normalise(rebuilt)
}

/** `_build_page`: the immutable page the import consumes. */
export function buildPage(pageIndex: number, text: string, fragments: readonly PdfFragment[], facts: LayoutFacts): PdfPage {
  return {
    pageIndex,
    text,
    characterCount: pyCodePointLen(text),
    fragments: [...fragments],
    columns: facts.columns,
    hasTableGrid: facts.hasTableGrid,
    hasFormulaTokens: facts.hasFormulaTokens,
    isScanned: facts.isScanned,
    readingOrderReliable: facts.readingOrderReliable,
    diagnostics: [...facts.reasons],
  }
}

/** `PdfPage.diagnostic_row()`. */
export function diagnosticRow(page: PdfPage): PageDiagnosticRow {
  const reasons = [...page.diagnostics]
  return {
    page_index: page.pageIndex,
    is_scanned: page.isScanned,
    columns: page.columns,
    has_table_grid: page.hasTableGrid,
    has_formula_tokens: page.hasFormulaTokens,
    reading_order_reliable: page.readingOrderReliable,
    fragment_count: page.fragments.length,
    character_count: page.characterCount,
    reasons,
    needs_review: needsReview(reasons),
  }
}

// --------------------------------------------------------------------------
// Geometry for source regions
// --------------------------------------------------------------------------
/**
 * `_clamp_bbox`: fit a normalised box inside the page, whatever the extractor reported.
 *
 * Fragment positions come from a text matrix and can legitimately sit outside the media box
 * (clipped or rotated text); a region that cannot be stored is useless, so the box is clamped rather
 * than rejected.
 */
export function clampBbox(x: number, y: number, width: number, height: number): BBox {
  let left = Math.min(Math.max(x, 0.0), 1.0)
  let top = Math.min(Math.max(y, 0.0), 1.0)
  const right = Math.min(Math.max(x + Math.max(width, 0.0), 0.0), 1.0)
  const bottom = Math.min(Math.max(y + Math.max(height, 0.0), 0.0), 1.0)
  const boxWidth = Math.max(right - left, MIN_REGION_SIZE)
  const boxHeight = Math.max(bottom - top, MIN_REGION_SIZE)
  if (left + boxWidth > 1.0) left = Math.max(1.0 - boxWidth, 0.0)
  if (top + boxHeight > 1.0) top = Math.max(1.0 - boxHeight, 0.0)
  return { x: left, y: top, width: boxWidth, height: boxHeight }
}

/**
 * `bbox_for_text`: the normalised union box of the fragments whose text appears in `text`.
 *
 * A fragment counts when it is part of the given text, or when it *carries* the text's first line —
 * the common case being a `【题干】` line whose fragment includes the label while the stem does not.
 * `null` means there is no geometry to match, and the caller keeps its whole-page fallback.
 */
export function bboxForText(page: Pick<PdfPage, 'fragments'>, text: string): BBox | null {
  const needle = pyStrip(text ?? '')
  if (needle === '' || page.fragments.length === 0) return null
  const anchor = pyStrip(needle.split('\n', 1)[0]).slice(0, 40)
  const matched = page.fragments.filter(
    (fragment) => fragment.text !== '' && (needle.includes(fragment.text) || (anchor !== '' && fragment.text.includes(anchor))),
  )
  if (matched.length === 0) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const fragment of matched) {
    const box = bboxOf(fragment)
    if (box[0] < left) left = box[0]
    if (box[1] < top) top = box[1]
    if (box[2] > right) right = box[2]
    if (box[3] > bottom) bottom = box[3]
  }
  return clampBbox(left, top, right - left, bottom - top)
}

// --------------------------------------------------------------------------
// Text normalisation and page offsets
// --------------------------------------------------------------------------
/**
 * `_normalise`: drop the soft artefacts of PDF text extraction without altering wording.
 *
 * Only line-level noise is removed: a stray carriage return, and the trailing spaces PDF extractors
 * emit at line ends. The wording itself is never changed, because the proofreader compares against
 * the original page — no NFKC, no dash/unit rewriting, no formula "correction".
 */
export function normalise(text: string): string {
  const out = text.split('\n').map((line) => pyRstrip(line.replace(/\r/g, '')))
  while (out.length > 0 && pyStrip(out[out.length - 1]) === '') out.pop()
  return out.join('\n')
}

/** `PdfExtraction.page_map()`: `[[page_index, start, end]]` offsets of the joined text. */
export function pageMap(pages: readonly Pick<PdfPage, 'pageIndex' | 'text'>[]): Array<[number, number, number]> {
  const offsets: Array<[number, number, number]> = []
  let cursor = 0
  for (const page of pages) {
    const end = cursor + pyCodePointLen(page.text)
    offsets.push([page.pageIndex, cursor, end])
    cursor = end + 1 // the joining newline
  }
  return offsets
}

/** `PdfExtraction.text`: all pages joined in reading order. */
export function joinedText(pages: readonly Pick<PdfPage, 'text'>[]): string {
  return pages.map((page) => page.text).join('\n')
}

/** `PdfExtraction.suspicious_pages`. */
export function suspiciousPages(rows: readonly PageDiagnosticRow[]): number[] {
  return rows.filter((row) => row.needs_review).map((row) => Number(row.page_index))
}
