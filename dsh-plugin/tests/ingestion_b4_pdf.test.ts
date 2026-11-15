/**
 * Golden replay for ingestion B4, part 1: PDF extraction (`pdfjs`) and layout classification.
 *
 * `scripts/gen_ingestion_b4_pdf_golden.py` builds deterministic PDFs with the same builders the
 * Django test-suite uses, calls the **real** `pdf_text.extract_native_text` / `_page_layout` /
 * `_ordered_page_text` / `bbox_for_text` / `_clamp_bbox` / `_normalise`, and freezes the results. This
 * file replays them against the port.
 *
 * Three conventions make the comparison meaningful across two PDF libraries:
 *
 * 1. **Layout vectors are library-independent.** Every `layout.cases[i]` feeds normalised fragment
 *    geometry, so `classifyPage`, `orderedPageText`, `detectColumns`, `detectTableGrid`,
 *    `detectFormulaTokens`, `lines`, `xClusters`, `joinLine`, `clampBbox`, `bboxForText`, `normalise`,
 *    `estimateWidthPt` and `pageMap` are compared **exactly** (1e-12 on floats). That is the layer
 *    the publish gate depends on, and it is where "same thresholds" has to be provable.
 * 2. **Real PDFs are compared page by page**, never by a hash: page text, page index, character
 *    count, fragment count, columns, grid/formula flags, scanned flag, reading-order reliability and
 *    the diagnostic row must all agree.
 * 3. **Two documented library differences are asserted as such**, not excused:
 *    - `fragment_y_comparable: false` fixtures are the ones whose text is laid out with `T*` + `TL`.
 *      pypdf computes `TL = operands[0] * font_size` (`pypdf/_page.py:1988`), which multiplies every
 *      baseline after the first by the font size; the port uses the composed text matrix, which is
 *      what the PDF spec says and what a renderer draws. Those fixtures compare everything except
 *      `y`, and `y` is checked for monotone top-down order instead (04 §L, DIV-B4-1).
 *    - `metadata.title` is a Python `bytes` repr in pypdf and mojibake in pdfjs, so only the fields
 *      listed in `metadata_comparable` are compared (04 §L, DIV-B4-2).
 *
 * The extractor's *refusals* are part of the contract too: `errors[i]` asserts the exact message and
 * `details` of every `InvalidInput`, including the ordering (empty → too large → not a PDF → damaged
 * → encrypted → pages → text volume → no text layer).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { InvalidInput } from '../src/services/errors.ts'
import {
  BLANK_MARKER_RUN,
  COLUMN_GUTTER_MIN_WIDTH_PT,
  COLUMN_MAX_GUTTER_CROSS_RATIO,
  COLUMN_MIN_CLUSTER_SHARE,
  COLUMN_MIN_FRAGMENTS_PER_CLUSTER,
  COLUMN_MIN_VERTICAL_OVERLAP,
  COLUMN_X_TOLERANCE_PT,
  DEFAULT_FONT_SIZE_PT,
  DEFAULT_PAGE_BOX,
  FORMULA_CONSTRUCT_PATTERN,
  FORMULA_MIN_CONSTRUCTS,
  FORMULA_STRONG_SYMBOLS,
  GRID_MIN_ALIGNED_COLUMNS,
  GRID_MIN_ALIGNED_ROWS,
  GRID_MIN_ROWS,
  GRID_ROW_MIN_FRAGMENTS,
  GRID_X_TOLERANCE_PT,
  LINE_Y_TOLERANCE_PT,
  MAX_FRAGMENTS_PER_PAGE,
  MIN_PAGE_CHARS,
  MIN_REGION_SIZE,
  bboxForText,
  buildPage,
  clampBbox,
  classifyPage,
  detectColumns,
  detectFormulaTokens,
  detectTableGrid,
  diagnosticRow,
  estimateWidthPt,
  joinLine,
  lines,
  makeFragment,
  normalise,
  orderedPageText,
  pageMap,
  pageNotes,
  visibleCharacters,
  xClusters,
  type PdfFragment,
} from '../src/domain/ingestion/pdf_layout.ts'
import { extractNativeText } from '../src/ingestion/pdf.ts'

const FIXTURE = JSON.parse(readFileSync(new URL('./golden/ingestion_b4_pdf.json', import.meta.url), 'utf8'))

const TOL = 1e-12

function close(actual: number, expected: number, where: string): void {
  if (Number.isNaN(expected) && Number.isNaN(actual)) return
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `${where}: expected ${expected}, got ${actual} (Δ ${Math.abs(actual - expected)})`,
  )
}

// --------------------------------------------------------------------------
// 1. The thresholds themselves
// --------------------------------------------------------------------------
test('the layout thresholds are the Python constants', () => {
  const c = FIXTURE.constants
  const table: Array<[string, unknown, unknown]> = [
    ['line_y_tolerance_pt', LINE_Y_TOLERANCE_PT, c.line_y_tolerance_pt],
    ['column_x_tolerance_pt', COLUMN_X_TOLERANCE_PT, c.column_x_tolerance_pt],
    ['column_min_fragments_per_cluster', COLUMN_MIN_FRAGMENTS_PER_CLUSTER, c.column_min_fragments_per_cluster],
    ['column_min_cluster_share', COLUMN_MIN_CLUSTER_SHARE, c.column_min_cluster_share],
    ['column_gutter_min_width_pt', COLUMN_GUTTER_MIN_WIDTH_PT, c.column_gutter_min_width_pt],
    ['column_min_vertical_overlap', COLUMN_MIN_VERTICAL_OVERLAP, c.column_min_vertical_overlap],
    ['column_max_gutter_cross_ratio', COLUMN_MAX_GUTTER_CROSS_RATIO, c.column_max_gutter_cross_ratio],
    ['grid_row_min_fragments', GRID_ROW_MIN_FRAGMENTS, c.grid_row_min_fragments],
    ['grid_min_rows', GRID_MIN_ROWS, c.grid_min_rows],
    ['grid_x_tolerance_pt', GRID_X_TOLERANCE_PT, c.grid_x_tolerance_pt],
    ['grid_min_aligned_columns', GRID_MIN_ALIGNED_COLUMNS, c.grid_min_aligned_columns],
    ['grid_min_aligned_rows', GRID_MIN_ALIGNED_ROWS, c.grid_min_aligned_rows],
    ['formula_strong_symbols', FORMULA_STRONG_SYMBOLS, c.formula_strong_symbols],
    ['formula_construct_pattern', FORMULA_CONSTRUCT_PATTERN.source, c.formula_construct_pattern],
    ['formula_min_constructs', FORMULA_MIN_CONSTRUCTS, c.formula_min_constructs],
    ['blank_marker_run', BLANK_MARKER_RUN.source, c.blank_marker_run],
    ['max_fragments_per_page', MAX_FRAGMENTS_PER_PAGE, c.max_fragments_per_page],
    ['default_font_size_pt', DEFAULT_FONT_SIZE_PT, c.default_font_size_pt],
    ['min_page_chars', MIN_PAGE_CHARS, c.min_page_chars],
    ['min_region_size', MIN_REGION_SIZE, c.min_region_size],
  ]
  for (const [name, actual, expected] of table) assert.deepEqual(actual, expected, name)
  assert.deepEqual([...DEFAULT_PAGE_BOX], c.default_page_box)
})

// --------------------------------------------------------------------------
// 2. The pure layout functions, one synthetic fragment set per case
// --------------------------------------------------------------------------
interface LayoutItem {
  text: string
  x_pt: number
  y_pt: number
  size: number
}

function fragmentsFor(items: LayoutItem[], box: readonly number[]): { fragments: PdfFragment[]; indexOf: Map<PdfFragment, number> } {
  const pageBox = [box[0], box[1], box[2], box[3]] as const
  const fragments = items.map((item) => makeFragment(item.text, item.x_pt, item.y_pt, item.size, pageBox))
  const indexOf = new Map<PdfFragment, number>()
  fragments.forEach((fragment, index) => indexOf.set(fragment, index))
  return { fragments, indexOf }
}

function indicesOf(groups: PdfFragment[][], indexOf: Map<PdfFragment, number>): number[][] {
  return groups.map((group) => group.map((fragment) => indexOf.get(fragment)!))
}

function factsToWire(facts: ReturnType<typeof classifyPage>): Record<string, unknown> {
  return {
    columns: facts.columns,
    unambiguous: facts.unambiguous,
    has_table_grid: facts.hasTableGrid,
    has_formula_tokens: facts.hasFormulaTokens,
    is_scanned: facts.isScanned,
    reading_order_reliable: facts.readingOrderReliable,
    reasons: facts.reasons,
  }
}

test('every layout case matches the Python functions', () => {
  for (const testCase of FIXTURE.layout.cases as Array<Record<string, any>>) {
    const input = testCase.input as { items: LayoutItem[]; page_box: number[]; text: string; truncated?: boolean }
    const expected = testCase.expected as Record<string, any>
    const where = `layout.${testCase.name}`
    const box = [input.page_box[0], input.page_box[1], input.page_box[2], input.page_box[3]] as const
    const { fragments, indexOf } = fragmentsFor(input.items, box)
    const notes = pageNotes(box, input.truncated === true)
    // The extractor normalises the page text before it classifies it; the vectors were generated the
    // same way, so the raw `input.text` of a whitespace-only page becomes "" here too.
    const cleaned = normalise(input.text)

    // fragments: geometry and text, in input order
    assert.equal(fragments.length, expected.fragments.length, `${where}: fragment count`)
    fragments.forEach((fragment, index) => {
      const want = expected.fragments[index]
      close(fragment.x, want.x, `${where}: fragment[${index}].x`)
      close(fragment.y, want.y, `${where}: fragment[${index}].y`)
      close(fragment.width, want.width, `${where}: fragment[${index}].width`)
      close(fragment.height, want.height, `${where}: fragment[${index}].height`)
      assert.equal(fragment.text, want.text, `${where}: fragment[${index}].text`)
    })

    // line and cluster grouping, as indices into the input list
    assert.deepEqual(indicesOf(lines(fragments, notes.yTolerance), indexOf), expected.lines, `${where}: lines`)
    assert.deepEqual(
      indicesOf(xClusters(fragments, notes.xTolerance), indexOf),
      expected.x_clusters,
      `${where}: x_clusters`,
    )
    assert.deepEqual(
      lines(fragments, notes.yTolerance).map((line) => joinLine(line)),
      expected.join_lines,
      `${where}: join_lines`,
    )
    assert.equal(visibleCharacters(cleaned), expected.visible_characters, `${where}: visible_characters`)

    // classification
    const columns = detectColumns(fragments, { xTolerance: notes.xTolerance, gutterWidth: notes.gutterWidth })
    assert.equal(columns.columns, expected.columns, `${where}: columns`)
    assert.equal(columns.unambiguous, expected.unambiguous, `${where}: unambiguous`)
    assert.equal(
      detectTableGrid(fragments, { yTolerance: notes.yTolerance, xTolerance: notes.gridXTolerance }),
      expected.table_grid,
      `${where}: table_grid`,
    )
    assert.equal(detectFormulaTokens(cleaned), expected.formula, `${where}: formula`)

    // One page, in the same order the extractor uses it. `facts` is snapshotted **after** the
    // reorder: `_ordered_page_text` may downgrade `reading_order_reliable` when the rebuild loses a
    // character, and the stored diagnostic row reflects that downgraded state.
    const facts = classifyPage(cleaned, fragments, notes)
    const text = orderedPageText(cleaned, fragments, notes, facts)
    assert.deepEqual(factsToWire(facts), expected.facts, `${where}: facts`)
    assert.equal(text, expected.ordered_text, `${where}: ordered_text`)
    const page = buildPage(1, text, fragments, facts)
    assert.deepEqual(diagnosticRow(page), expected.diagnostic_row, `${where}: diagnostic_row`)
  }
})

test('normalise, clamp, bbox, page_map and estimate_width match the Python functions', () => {
  for (const testCase of FIXTURE.layout.normalise as Array<Record<string, any>>) {
    assert.equal(normalise(testCase.input), testCase.expected, `normalise.${testCase.name}`)
  }
  for (const testCase of FIXTURE.layout.clamp as Array<Record<string, any>>) {
    const got = clampBbox(testCase.input.x, testCase.input.y, testCase.input.width, testCase.input.height)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      close(got[key], testCase.expected[key], `clamp.${testCase.name}.${key}`)
    }
  }
  for (const testCase of FIXTURE.layout.bbox as Array<Record<string, any>>) {
    const box = [testCase.page_box[0], testCase.page_box[1], testCase.page_box[2], testCase.page_box[3]] as const
    const { fragments } = fragmentsFor(testCase.items as LayoutItem[], box)
    const got = bboxForText({ fragments }, testCase.needle)
    if (testCase.expected === null) {
      assert.equal(got, null, `bbox.${testCase.name}`)
      continue
    }
    assert.ok(got !== null, `bbox.${testCase.name}: expected a box`)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      close(got![key], testCase.expected[key], `bbox.${testCase.name}.${key}`)
    }
  }
  for (const testCase of FIXTURE.layout.page_map as Array<Record<string, any>>) {
    const pages = (testCase.pages as string[]).map((text, index) => ({ pageIndex: index + 1, text }))
    assert.deepEqual(
      pageMap(pages).map((row) => [...row]),
      testCase.expected,
      `page_map.${testCase.name}`,
    )
  }
  for (const testCase of FIXTURE.layout.estimate_width as Array<Record<string, any>>) {
    close(estimateWidthPt(testCase.text, testCase.size), testCase.expected, `estimate_width.${testCase.name}`)
  }
})

// --------------------------------------------------------------------------
// 3. Real PDFs, page by page
// --------------------------------------------------------------------------
function fixtureBytes(entry: Record<string, any>): Uint8Array {
  if (entry.synthetic !== undefined) {
    const prefix = new Uint8Array(Buffer.from(entry.synthetic.prefix, 'utf8'))
    const bytes = new Uint8Array(prefix.byteLength + entry.synthetic.length)
    bytes.set(prefix, 0)
    return bytes
  }
  return new Uint8Array(Buffer.from(entry.base64, 'base64'))
}

test('real PDFs: every page matches the Python extraction', async () => {
  for (const [name, entry] of Object.entries(FIXTURE.fixtures as Record<string, Record<string, any>>)) {
    const bytes = fixtureBytes(entry)
    const extraction = await extractNativeText(bytes)
    const where = `fixtures.${name}`
    assert.equal(extraction.pageCount, entry.page_count, `${where}: page_count`)
    assert.equal(extraction.characterCount, entry.character_count, `${where}: character_count`)
    assert.deepEqual(extraction.emptyPages, entry.empty_pages, `${where}: empty_pages`)
    assert.equal(extraction.text, entry.text, `${where}: text`)
    assert.deepEqual(
      extraction.pageMap().map((row) => [...row]),
      entry.page_map,
      `${where}: page_map`,
    )
    const comparable: string[] = entry.metadata_comparable ?? []
    for (const key of comparable) assert.equal(extraction.metadata[key], entry.metadata[key], `${where}: metadata.${key}`)

    assert.equal(extraction.pages.length, entry.pages.length, `${where}: page count`)
    extraction.pages.forEach((page, index) => {
      const want = entry.pages[index]
      const pageWhere = `${where}.page[${index}]`
      assert.equal(page.pageIndex, want.page_index, `${pageWhere}: page_index`)
      assert.equal(page.text, want.text, `${pageWhere}: text`)
      assert.equal(page.characterCount, want.character_count, `${pageWhere}: character_count`)
      assert.equal(page.fragments.length, want.fragment_count, `${pageWhere}: fragment_count`)
      assert.equal(page.columns, want.columns, `${pageWhere}: columns`)
      assert.equal(page.hasTableGrid, want.has_table_grid, `${pageWhere}: has_table_grid`)
      assert.equal(page.hasFormulaTokens, want.has_formula_tokens, `${pageWhere}: has_formula_tokens`)
      assert.equal(page.isScanned, want.is_scanned, `${pageWhere}: is_scanned`)
      assert.equal(page.readingOrderReliable, want.reading_order_reliable, `${pageWhere}: reading_order_reliable`)
      assert.deepEqual(page.diagnostics, want.diagnostics, `${pageWhere}: diagnostics`)
      assert.deepEqual(diagnosticRow(page), want.diagnostic_row, `${pageWhere}: diagnostic_row`)

      if (entry.fragment_y_comparable === true) {
        page.fragments.forEach((fragment, position) => {
          const expected = want.fragments[position]
          assert.equal(fragment.text, expected.text, `${pageWhere}: fragment[${position}].text`)
          close(fragment.x, expected.x, `${pageWhere}: fragment[${position}].x`)
          close(fragment.y, expected.y, `${pageWhere}: fragment[${position}].y`)
          close(fragment.width, expected.width, `${pageWhere}: fragment[${position}].width`)
          close(fragment.height, expected.height, `${pageWhere}: fragment[${position}].height`)
        })
      } else {
        // `T*`-based pages: pypdf's TL defect makes y incomparable (04 §L DIV-B4-1). The wording and
        // the *order* of the runs still have to agree, and the first baseline is exact because it
        // comes from an explicit `Tm`.
        assert.deepEqual(
          page.fragments.map((fragment) => fragment.text),
          (want.fragments as Array<{ text: string }>).map((fragment) => fragment.text),
          `${pageWhere}: fragment texts`,
        )
        if (page.fragments.length > 0) {
          close(page.fragments[0].y, want.fragments[0].y, `${pageWhere}: first baseline`)
          for (let position = 1; position < page.fragments.length; position += 1) {
            assert.ok(
              page.fragments[position].y > page.fragments[position - 1].y,
              `${pageWhere}: fragments must stay in top-down order at ${position}`,
            )
          }
        }
      }
    })
  }
})

test('real PDFs: every refusal matches the Python message and details', async () => {
  for (const entry of FIXTURE.errors as Array<Record<string, any>>) {
    const bytes = fixtureBytes(entry)
    await assert.rejects(
      () => extractNativeText(bytes),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInput, `${entry.name}: expected InvalidInput, got ${String(error)}`)
        assert.equal(error.message, entry.error.message, `${entry.name}: message`)
        assert.deepEqual(error.details, entry.error.details, `${entry.name}: details`)
        return true
      },
      entry.name,
    )
  }
})
