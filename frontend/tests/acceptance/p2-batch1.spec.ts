import { expect, test, type Page } from '@playwright/test'
import { login, switchProject, switchSubject } from './helpers'
import { buildTextPdf } from './pdfFixture'
import { buildLayoutPdf } from './pdfLayoutFixture'

/**
 * Real-browser acceptance of P2 batch 1 (C01 layout review + C04 contamination).
 *
 * Evidence class: a real browser against the real API with the acceptance
 * fixture. The layout PDF is generated here as *real bytes* with explicit
 * per-fragment positions, so the server's deterministic layout detection —
 * not a mock — is what the assertions exercise. No model is involved anywhere:
 * a page the parser cannot read reliably must reach a human, and nothing may be
 * published before that human confirms.
 */

const PROJECT = '验收项目B·专业实务'
const IMPORT_SUBJECT = '验收科目三·专业实务'

// Mirror of the backend gold-set geometry (LEFT_X 60 / RIGHT_X 330 / step 30,
// four questions per column) so the page really is a two-column page: two bands
// that each span most of the sheet, with a gutter between them.
const LEFT_X = 60
const RIGHT_X = 330
const LINE_STEP = 30
const TOP_Y = 800

function question(number: number, prefix: string): string[] {
  return [
    `${number}．【题型】单选题`,
    `【题干】${prefix}第${number}题：下列说法正确的是？`,
    '【选项】',
    'A. 甲',
    'B. 乙',
  ]
}

const LEFT_COLUMN = [...question(1, '左栏'), ...question(2, '左栏'), ...question(3, '左栏'), ...question(4, '左栏')]
const RIGHT_COLUMN = [...question(5, '右栏'), ...question(6, '右栏'), ...question(7, '右栏'), ...question(8, '右栏')]
const ANSWER_PAGES = ['参考答案\n1. A\n2. A\n3. A\n4. A\n5. A\n6. A\n7. A\n8. A\n']

function runToken(): string {
  return `${test.info().project.name.replace(/[^a-z0-9]/gi, '')}${Date.now().toString(36).slice(-5)}`
}

/**
 * A real two-column PDF, emitted **row by row** — i.e. in the wrong reading
 * order, exactly like many real papers. Column-major extraction is therefore a
 * real assertion rather than a tautology.
 */
function twoColumnPaper(): Buffer {
  const fragments: Array<{ x: number; y: number; text: string }> = []
  const rows = Math.max(LEFT_COLUMN.length, RIGHT_COLUMN.length)
  for (let index = 0; index < rows; index += 1) {
    const y = TOP_Y - index * LINE_STEP
    if (index < LEFT_COLUMN.length) fragments.push({ x: LEFT_X, y, text: LEFT_COLUMN[index] })
    if (index < RIGHT_COLUMN.length) fragments.push({ x: RIGHT_X, y, text: RIGHT_COLUMN[index] })
  }
  return buildLayoutPdf([fragments])
}

async function importTwoColumnPdf(page: Page, cycleKey: string) {
  const toggle = page.getByTestId('pdf-import-toggle')
  if ((await toggle.innerText()).includes('展开')) await toggle.click()
  await page.getByTestId('pdf-paper-input').setInputFiles({
    name: 'acceptance-layout-paper.pdf',
    mimeType: 'application/pdf',
    buffer: twoColumnPaper(),
  })
  await page.getByTestId('pdf-answer-input').setInputFiles({
    name: 'acceptance-layout-answers.pdf',
    mimeType: 'application/pdf',
    buffer: buildTextPdf(ANSWER_PAGES),
  })
  await page.getByTestId('pdf-cycle-key').fill(cycleKey)
  await page.getByTestId('pdf-session-key').fill('上半年')
  await page.getByTestId('pdf-paper-code').fill('版面卷一')
  await page.getByTestId('pdf-title').fill(`${cycleKey} 年验收版面测试卷`)
  await page.getByTestId('pdf-expected-sessions').fill('1')
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/imports/pdf') && response.request().method() === 'POST',
  )
  await page.getByTestId('pdf-import-submit').click()
  const response = await responsePromise
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as { id: string; candidate_count: number }
}

async function candidatesOf(page: Page, projectId: string, jobId: string) {
  const response = await page.request.get(`/api/v1/projects/${projectId}/import-candidates?job_id=${jobId}`)
  expect(response.status()).toBe(200)
  return (await response.json()) as Array<{
    id: string
    source_position_key: string
    review_issues: Array<{ code: string; message?: string }>
    draft_payload: { content?: { blocks?: Array<{ text?: string }> } }
    layout_review_confirmed_at: string | null
  }>
}

async function currentProjectId(page: Page) {
  const value = await page.evaluate(() => window.localStorage.getItem('acepass.currentProject'))
  expect(value, '页面必须已选定项目').toBeTruthy()
  return value as string
}

test.describe('P2 batch 1: layout review and contamination', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('a multi-column page is read in column order and cannot publish before a human confirms the layout', async ({
    page,
  }) => {
    await switchProject(page, PROJECT)
    await switchSubject(page, IMPORT_SUBJECT)
    await page.goto('/imports')
    const cycleKey = `2097${runToken()}`
    const job = await importTwoColumnPdf(page, cycleKey)
    const projectId = await currentProjectId(page)
    const rows = await candidatesOf(page, projectId, job.id)

    // Column-major reading order: positions 1-4 are the LEFT column (even though
    // the content stream interleaves both columns row by row), so position 5 is
    // the right column's first question.
    expect(rows.length, '两栏各四题').toBe(8)
    const first = rows.find((row) => row.source_position_key === '1')
    const second = rows.find((row) => row.source_position_key === '2')
    const fifth = rows.find((row) => row.source_position_key === '5')
    expect(first, '两栏页面必须解析出第 1 题').toBeTruthy()
    expect(second, '两栏页面必须解析出第 2 题').toBeTruthy()
    expect(fifth, '两栏页面必须解析出第 5 题').toBeTruthy()
    expect(JSON.stringify(first!.draft_payload), '第 1 题必须来自左栏').toContain('左栏第1题')
    expect(JSON.stringify(second!.draft_payload), '第 2 题仍是左栏').toContain('左栏第2题')
    expect(JSON.stringify(fifth!.draft_payload), '第 5 题必须是右栏第一题（按栏重排）').toContain('右栏第5题')

    // The parser reports the multi-column page instead of silently trusting its order.
    const issues = first!.review_issues.map((issue) => issue.code)
    expect(issues, `候选必须带分栏复核问题，实际 ${issues.join(',')}`).toContain('multi_column_needs_review')

    await page.goto(`/imports/${job.id}/candidates/${first!.id}`)
    await expect(page.getByTestId('layout-panel')).toBeVisible()
    await expect(page.getByTestId('layout-page-row').first()).toContainText('分栏')
    await expect(page.getByTestId('layout-issue-blocking').first()).toBeVisible()
    await expect(page.getByTestId('layout-blocked-notice')).toBeVisible()

    // Publishing before the confirmation is refused by the server (422), and the
    // page shows the server's own reason.
    const blocked = page.waitForResponse((r) => r.url().endsWith('/publish') && r.request().method() === 'POST')
    await page.getByRole('button', { name: '发布题目版本' }).click()
    const blockedResponse = await blocked
    expect(blockedResponse.status(), '未确认版面前不得发布').toBe(422)
    expect(JSON.stringify(await blockedResponse.json())).toContain('multi_column_needs_review')

    // One explicit human act clears the blockers.
    await page.getByTestId('layout-confirm-note').fill('已对照原页核对两栏顺序')
    const confirmed = page.waitForResponse(
      (r) => r.url().includes('/layout-confirm') && r.request().method() === 'POST',
    )
    await page.getByTestId('layout-confirm').click()
    expect((await confirmed).status()).toBe(200)
    await expect(page.getByTestId('layout-confirmed-note')).toContainText('已确认版面')

    const afterRows = await candidatesOf(page, projectId, job.id)
    const afterFirst = afterRows.find((row) => row.id === first!.id)!
    expect(afterFirst.layout_review_confirmed_at).toBeTruthy()
    expect(afterFirst.review_issues.map((issue) => issue.code)).not.toContain('multi_column_needs_review')

    // The layout gate is not the only review gate: a matched answer key still
    // needs the human's confirmation and a paper position still needs its score,
    // exactly as in the P1 flow. Publishing only succeeds once all of them are
    // answered — the layout confirmation does not silently clear the others.
    await page.getByTestId('confirm-answer-match').check()
    await page.getByTestId('practice-max-score').fill('2')
    const savedAgain = page.waitForResponse(
      (r) => r.url().includes(`/import-candidates/${first!.id}`) && r.request().method() === 'PATCH',
    )
    await page.getByTestId('save-candidate').click()
    expect((await savedAgain).status()).toBe(200)

    // Now publishing really publishes.
    const published = page.waitForResponse((r) => r.url().endsWith('/publish') && r.request().method() === 'POST')
    await page.getByRole('button', { name: '发布题目版本' }).click()
    const publishedResponse = await published
    const publishedBody = await publishedResponse.text()
    expect(publishedResponse.status(), publishedBody).toBe(200)
  })

  test('a question marked as seen outside the system can never be strictly independent again', async ({ page }) => {
    await switchProject(page, PROJECT)
    await switchSubject(page, IMPORT_SUBJECT)
    await page.goto('/questions')
    const rows = page.locator('table.data tbody tr')
    await expect(rows.first()).toBeVisible()

    // Open the exposure panel for the first question of this subject.
    await page.getByTestId('exposure-open').first().click()
    await expect(page.getByTestId('exposure-panel')).toBeVisible()
    const projectId = await currentProjectId(page)

    const marked = page.waitForResponse(
      (r) => r.url().includes('/external-seen') && r.request().method() === 'POST',
    )
    await page.getByTestId('exposure-note').fill('我在别处做过这张卷子')
    await page.getByTestId('exposure-mark-seen').click()
    const markedResponse = await marked
    expect(markedResponse.status(), '外部已见声明必须写入').toBe(201)
    const state = (await markedResponse.json()) as {
      seen: boolean
      reasons: string[]
      strict_independent_eligible: boolean
    }
    expect(state.seen).toBe(true)
    expect(state.reasons).toContain('external_seen')
    expect(state.strict_independent_eligible).toBe(false)

    await expect(page.getByTestId('exposure-state')).toContainText('不会计入严格独立证据')
    await expect(page.getByTestId('exposure-reason').first()).toContainText('系统外')

    // A correction is recorded but never launders the question back to "unseen".
    const corrected = page.waitForResponse(
      (r) => r.url().includes('/external-seen') && r.request().method() === 'POST',
    )
    await page.getByTestId('exposure-correct').click()
    expect((await corrected).status()).toBe(201)
    await expect(page.getByTestId('exposure-state')).toContainText('不会计入严格独立证据')

    const questionId = (await page.getByTestId('exposure-panel').getAttribute('data-question-id')) ?? ''
    if (questionId) {
      const fetched = await page.request.get(`/api/v1/projects/${projectId}/questions/${questionId}/exposure`)
      expect(fetched.status()).toBe(200)
      const fetchedState = (await fetched.json()) as { seen: boolean; strict_independent_eligible: boolean }
      expect(fetchedState.seen).toBe(true)
      expect(fetchedState.strict_independent_eligible).toBe(false)
    }
  })
})
