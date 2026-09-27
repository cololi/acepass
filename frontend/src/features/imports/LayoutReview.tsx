import type { ReactNode } from 'react'
import {
  isLayoutBlockingIssue,
  issuePageIndexes,
  type PageDiagnosticOut,
  type ReviewIssueOut,
} from '../../api/client'

/**
 * The layout review surface (P2 batch 1 / C01).
 *
 * The deterministic parser never guesses and never runs OCR: it *classifies*
 * each page and reports what it saw. This module is the one place that turns
 * that classification into Chinese wording, so the candidate review page and the
 * import job view cannot describe the same page differently.
 *
 * Two sentences are fixed by the acceptance criteria and must not be softened:
 * a page without a text layer says 「该页没有文字层：请对照原页人工录入」 (never
 * anything that implies recognition), and an unreliable reading order says
 * 「阅读顺序无法确定：已保留解析顺序，请对照原页核对」.
 */

/** Page reason codes → the short fact label. */
export const PAGE_REASON_LABELS: Record<string, string> = {
  page_without_text_layer: '无文字层（扫描页）',
  multi_column_layout: '多栏版式',
  column_reading_order_ambiguous: '栏内阅读顺序不确定',
  table_grid_detected: '检测到表格网格',
  formula_tokens_detected: '检测到公式符号',
  geometry_unavailable: '页面几何信息不可用',
  too_many_fragments: '文本片段过多（超出上限的部分被忽略）',
}

/** Candidate layout issue codes → the short title of the row. */
export const LAYOUT_ISSUE_LABELS: Record<string, string> = {
  page_without_text_layer_needs_manual_entry: '来源页没有文字层，需要人工录入',
  multi_column_needs_review: '多栏阅读顺序需要人工确认',
  table_or_formula_needs_review: '表格/公式版式需要人工确认',
  cross_page_question: '题目跨页接续（不阻止发布）',
}

/**
 * What a human has to actually check for each blocking code.
 *
 * The server's own `message` stays visible below this line; this is the concrete
 * instruction the proofreader acts on.
 */
export const LAYOUT_ISSUE_CHECKS: Record<string, string> = {
  page_without_text_layer_needs_manual_entry:
    '要检查：这一页没有文字层，系统没有做 OCR、也没有内容可校对。请对照原页逐字人工录入题干、选项、空位与答案，再确认版面。',
  multi_column_needs_review:
    '要检查：对照原页确认题干与选项的先后顺序（先左栏还是先右栏）、有没有把相邻栏的文字接进本题。顺序不对时请用原始 JSON 或结构化编辑改正后再确认。',
  table_or_formula_needs_review:
    '要检查：对照原页逐字核对表格的行列与公式的符号、上下标；公式按原样保留、不做“纠正”，只确认文本提取没有改变它的含义。',
  cross_page_question:
    '要检查：题干/选项在页面之间被自动接续，请对照两页确认没有漏字、缺行或重复。',
}

function isKnown<T>(table: Record<string, T>, code: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, code)
}

/** One page's facts, all from the payload — nothing is inferred. */
export function pageDiagnosticFacts(row: PageDiagnosticOut): string[] {
  return [
    `分栏：${row.columns > 1 ? `${row.columns} 栏` : '单栏'}`,
    `表格：${row.has_table_grid ? '检测到表格网格' : '未检测到表格网格'}`,
    `公式：${row.has_formula_tokens ? '检测到公式符号' : '未检测到公式符号'}`,
    `文字层：${row.is_scanned ? '无文字层（扫描页）' : `有文字层（${row.character_count} 字符）`}`,
    `阅读顺序：${row.reading_order_reliable ? '解析顺序可靠' : '不可靠（已保留解析顺序）'}`,
  ]
}

/** The honest sentences for the states that need a human. */
export function pageDiagnosticSentences(row: PageDiagnosticOut): string[] {
  const sentences: string[] = []
  if (row.is_scanned) {
    sentences.push('该页没有文字层：请对照原页人工录入')
    sentences.push('系统不做 OCR、不猜测内容：这一页的文字完全来自你的人工录入，不是识别结果。')
  }
  if (!row.reading_order_reliable && !row.is_scanned) {
    sentences.push('阅读顺序无法确定：已保留解析顺序，请对照原页核对')
  }
  if (row.has_table_grid) {
    sentences.push('检测到表格网格：表格的行列可能在文本提取中被改变，请对照原页逐字核对每个单元格。')
  }
  if (row.has_formula_tokens) {
    sentences.push('检测到公式符号：公式按原样保留、不做“纠正”，请对照原页核对符号与上下标。')
  }
  if (row.columns > 1) {
    sentences.push(`检测到多栏版式（${row.columns} 栏）：栏与栏之间的先后顺序无法完全确定，请对照原页确认。`)
  }
  const unexplained = (row.reasons ?? []).filter((reason) => !isKnown(PAGE_REASON_LABELS, reason))
  if (unexplained.length) {
    sentences.push(`解析器记录的其他原因：${unexplained.join('、')}`)
  }
  return sentences
}

/** A source page the candidate came from, and the diagnostic row for it (if any). */
export interface LayoutPageRef {
  document_id?: string | null
  document_title?: string
  page_index: number
}

function keyOf(documentId: string | null | undefined, pageIndex: number): string {
  return `${documentId ?? ''}#${pageIndex}`
}

function PageRowBody({ row }: { row: PageDiagnosticOut }) {
  const sentences = pageDiagnosticSentences(row)
  return (
    <>
      <p className="small" style={{ margin: 0 }}>
        <strong>第 {row.page_index} 页</strong>
        {row.document_title ? `（${row.document_title}）` : ''}
        {row.needs_review ? (
          <span className="pill warn" style={{ marginLeft: 6 }}>
            需要人工确认
          </span>
        ) : null}
      </p>
      <p className="tiny muted" style={{ margin: '2px 0 0' }}>
        {pageDiagnosticFacts(row).join(' · ')}
      </p>
      {sentences.length ? (
        <ul className="small" style={{ margin: '4px 0 0 18px' }}>
          {sentences.map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/**
 * The 「版面检查」 panel: per source page, what the deterministic parser saw.
 *
 * `pages` restricts the panel to the pages a single candidate came from; without
 * it the panel lists the whole job. A page with no diagnostic row is rendered as
 * "no record", never as a clean page.
 */
export function LayoutDiagnostics({
  diagnostics,
  pages,
  loading = false,
  error = '',
  footer,
}: {
  diagnostics: PageDiagnosticOut[] | undefined
  pages?: LayoutPageRef[]
  loading?: boolean
  error?: string
  footer?: ReactNode
}) {
  const rows: PageDiagnosticOut[] = []
  const missing: LayoutPageRef[] = []

  if (pages) {
    const byKey = new Map<string, PageDiagnosticOut>()
    for (const row of diagnostics ?? []) byKey.set(keyOf(row.document_id, row.page_index), row)
    for (const page of pages) {
      const found = byKey.get(keyOf(page.document_id, page.page_index))
      if (found) {
        // Prefer the payload's own title; the source region is only a fallback.
        rows.push({ ...found, document_title: found.document_title || page.document_title })
      } else {
        missing.push(page)
      }
    }
    rows.sort((a, b) => a.page_index - b.page_index)
  } else {
    rows.push(...(diagnostics ?? []))
  }

  const hasAny = rows.length > 0 || missing.length > 0
  const noDiagnosisAtAll = (diagnostics ?? []).length === 0

  return (
    <div className="card" data-testid="layout-panel">
      <h2 style={{ marginTop: 0 }}>版面检查</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        以下是确定性解析器在来源页上<strong>实测</strong>到的东西，不是对内容的识别：
        没有文字层的页面不会被 OCR，阅读顺序无法确定时保留解析顺序。请以原页为准逐页核对。
      </p>
      {loading ? <div className="empty-state">正在读取版面诊断…</div> : null}
      {error ? <div className="notice danger">{error}</div> : null}
      {!loading && !error && noDiagnosisAtAll ? (
        <div className="empty-state" data-testid="layout-no-diagnostics">
          本次导入没有版面诊断记录
        </div>
      ) : null}
      {!loading && !error && hasAny ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((row) => (
            <li
              key={keyOf(row.document_id, row.page_index)}
              data-testid="layout-page-row"
              style={{ marginBottom: 10, borderTop: '1px solid #eef1f4', paddingTop: 8 }}
            >
              <PageRowBody row={row} />
            </li>
          ))}
          {missing.map((page) => (
            <li
              key={keyOf(page.document_id, page.page_index)}
              data-testid="layout-page-row"
              style={{ marginBottom: 10, borderTop: '1px solid #eef1f4', paddingTop: 8 }}
            >
              <p className="small" style={{ margin: 0 }}>
                <strong>第 {page.page_index} 页</strong>
                {page.document_title ? `（${page.document_title}）` : ''}
              </p>
              <p className="small muted" style={{ margin: '2px 0 0' }}>
                解析器没有为这一页留下版面诊断记录（例如图片导入不走 PDF 版面诊断），
                无法说明这一页的版式：请直接对照原页核对后再确认版面。
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {footer}
    </div>
  )
}

/**
 * One visible row per layout issue, with what to check and whether it blocks.
 *
 * Blocking rows carry their own marker element so a test (or a human reading the
 * diff) can count blockers without parsing text.
 */
export function LayoutIssueRows({
  issues,
  emptyText = '没有版面相关的待确认问题。',
}: {
  issues: ReviewIssueOut[]
  emptyText?: string
}) {
  if (!issues.length) return <p className="small muted">{emptyText}</p>
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {issues.map((issue) => {
        const blocking = isLayoutBlockingIssue(issue)
        const check = LAYOUT_ISSUE_CHECKS[issue.code]
        const pageIndexes = issuePageIndexes(issue)
        const reasonCodes = issue.reasons ?? []
        return (
          <li
            key={issue.code}
            data-testid="layout-issue"
            style={{ marginBottom: 10, borderTop: '1px solid #eef1f4', paddingTop: 8 }}
          >
            <p className="small" style={{ margin: 0 }}>
              <strong>{LAYOUT_ISSUE_LABELS[issue.code] ?? issue.message}</strong>（{issue.code}）
              {blocking ? (
                <span className="pill danger" style={{ marginLeft: 6 }} data-testid="layout-issue-blocking">
                  阻止发布
                </span>
              ) : (
                <span className="pill warn" style={{ marginLeft: 6 }}>
                  仅提醒
                </span>
              )}
            </p>
            <div className="small muted">{issue.message}</div>
            {check ? <div className="small">{check}</div> : null}
            {pageIndexes.length ? (
              <div className="tiny muted">涉及来源页：第 {pageIndexes.join('、')} 页</div>
            ) : null}
            {reasonCodes.length ? (
              <div className="tiny muted">
                解析器原因：
                {reasonCodes.map((reason) => PAGE_REASON_LABELS[reason] ?? reason).join('、')}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
