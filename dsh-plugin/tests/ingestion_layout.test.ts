import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ISSUE_CROSS_PAGE,
  ISSUE_MESSAGES,
  ISSUE_MULTI_COLUMN,
  ISSUE_ORDER,
  ISSUE_SCANNED,
  ISSUE_TABLE_FORMULA,
  REASON_COLUMN_ORDER_AMBIGUOUS,
  REASON_FORMULA,
  REASON_GEOMETRY_UNAVAILABLE,
  REASON_MULTI_COLUMN,
  REASON_SCANNED,
  REASON_TABLE_GRID,
  REASON_TO_ISSUE,
  REASON_TOO_MANY_FRAGMENTS,
  issueCodesForReasons,
  issueForReason,
  layoutReviewIssues,
  needsReview,
  reasonsNeedingReview,
} from '../src/domain/ingestion/layout.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/ingestion_layout.json', import.meta.url), 'utf8'))

test('ingestion layout: reason/issue constants match the Python module', () => {
  assert.deepEqual(
    {
      reason_scanned: REASON_SCANNED,
      reason_multi_column: REASON_MULTI_COLUMN,
      reason_column_order_ambiguous: REASON_COLUMN_ORDER_AMBIGUOUS,
      reason_table_grid: REASON_TABLE_GRID,
      reason_formula: REASON_FORMULA,
      reason_geometry_unavailable: REASON_GEOMETRY_UNAVAILABLE,
      reason_too_many_fragments: REASON_TOO_MANY_FRAGMENTS,
      issue_multi_column: ISSUE_MULTI_COLUMN,
      issue_table_formula: ISSUE_TABLE_FORMULA,
      issue_scanned: ISSUE_SCANNED,
      issue_cross_page: ISSUE_CROSS_PAGE,
      reason_to_issue: REASON_TO_ISSUE,
      issue_order: ISSUE_ORDER,
      issue_messages: ISSUE_MESSAGES,
    },
    golden.constants,
  )
})

test(`ingestion layout: ${golden.issue_for_reason.length} reasons map to issues like the Python module`, () => {
  for (const entry of golden.issue_for_reason) {
    assert.deepEqual(issueForReason(entry.reason), entry.issue, JSON.stringify(entry.reason))
  }
})

test(`ingestion layout: ${golden.reasons_needing_review.length} reason lists filter like the Python module`, () => {
  for (const entry of golden.reasons_needing_review) {
    assert.deepEqual(
      reasonsNeedingReview(entry.reasons),
      entry.result,
      JSON.stringify(entry.reasons),
    )
  }
})

test(`ingestion layout: ${golden.needs_review.length} reason lists gate like the Python module`, () => {
  for (const entry of golden.needs_review) {
    assert.deepEqual(needsReview(entry.reasons), entry.result, JSON.stringify(entry.reasons))
  }
})

test(`ingestion layout: ${golden.issue_codes_for_reasons.length} reason lists map to codes like the Python module`, () => {
  for (const entry of golden.issue_codes_for_reasons) {
    assert.deepEqual(
      issueCodesForReasons(entry.reasons),
      entry.result,
      JSON.stringify(entry.reasons),
    )
  }
})

test(`ingestion layout: ${golden.layout_review_issues.length} candidates produce issues like the Python module`, () => {
  for (const entry of golden.layout_review_issues) {
    const actual = layoutReviewIssues({
      pageDiagnostics: entry.page_diagnostics,
      pages: entry.pages,
    })
    assert.deepEqual(actual, entry.result, entry.name)
  }
})

// ---------------------------------------------------------------- pinned rules
test('ingestion layout: a clean page in a suspicious file still imports', () => {
  const issues = layoutReviewIssues({
    pageDiagnostics: [
      { document_id: 'doc-a', page_index: 1, reasons: ['page_without_text_layer'] },
      { document_id: 'doc-a', page_index: 2, reasons: ['geometry_unavailable'] },
    ],
    pages: [['doc-a', 2]],
  })
  assert.deepEqual(issues, [])
})

test('ingestion layout: `geometry_unavailable` and `too_many_fragments` never block', () => {
  assert.equal(issueForReason(REASON_GEOMETRY_UNAVAILABLE), null)
  assert.equal(issueForReason(REASON_TOO_MANY_FRAGMENTS), null)
  assert.equal(needsReview([REASON_GEOMETRY_UNAVAILABLE, REASON_TOO_MANY_FRAGMENTS]), false)
  assert.deepEqual(issueCodesForReasons([REASON_GEOMETRY_UNAVAILABLE, REASON_TOO_MANY_FRAGMENTS]), [])
})

test('ingestion layout: issue order is stable regardless of reason order', () => {
  const issues = layoutReviewIssues({
    pageDiagnostics: [
      {
        document_id: 'doc-a',
        page_index: 1,
        reasons: [REASON_FORMULA, REASON_MULTI_COLUMN, REASON_SCANNED, REASON_TABLE_GRID],
      },
    ],
    pages: [['doc-a', 1]],
  })
  assert.deepEqual(
    issues.map((issue) => issue.code),
    [ISSUE_SCANNED, ISSUE_MULTI_COLUMN, ISSUE_TABLE_FORMULA],
  )
  assert.deepEqual(
    issues.map((issue) => issue.reasons),
    [[REASON_SCANNED], [REASON_MULTI_COLUMN], [REASON_FORMULA, REASON_TABLE_GRID]],
  )
})

test('ingestion layout: prototype names are not reason codes', () => {
  // A plain-object dictionary would answer `REASON_TO_ISSUE['constructor']` with a function; the
  // Python dict only ever answers for its own string keys.
  assert.equal(issueForReason('constructor'), null)
  assert.equal(issueForReason('toString'), null)
  assert.deepEqual(reasonsNeedingReview(['constructor', 'toString', '__proto__']), [])
})
