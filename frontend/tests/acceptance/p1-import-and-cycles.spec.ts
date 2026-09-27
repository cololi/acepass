import { expect, test, type Page } from '@playwright/test'
import { buildTextPdf } from './pdfFixture'
import { PROJECT_B, login, switchProject, switchSubject } from './helpers'

/**
 * P1 browser acceptance: native-text PDF import and real cycle analysis.
 *
 * Everything here runs against the real API and the real database of the
 * isolated acceptance environment (dedicated database, dedicated Redis, real
 * worker). The PDFs are generated in-process by `pdfFixture.ts`, so the material
 * is honestly labelled test material — the suite verifies the *rules*, not a
 * claim about real exam papers.
 *
 * Assertion policy, matching the P0 suite:
 *
 * * the import request itself must answer 201 — an empty candidate list is not
 *   accepted as proof that the page works;
 * * the candidate must carry the page it came from, and the answer match must be
 *   presented as something a human still has to confirm;
 * * the paper item is asserted through the API after publication, so "published"
 *   means the score really entered the paper record;
 * * the cycle panel must show the insufficient state when there are fewer than
 *   five complete cycles, and the counted distribution only for confirmed cycles.
 */

// Project B's third subject is used on purpose: the P0 acceptance suite answers
// questions by clicking options in project A, and an imported two-option question
// appearing there would make that suite select the wrong row. Keeping the P1
// imports in a subject no other spec drives keeps both suites independent.
const IMPORT_SUBJECT = '验收科目三·专业实务'
const CYCLE_SUBJECT = '验收历年科目·周期统计'

const PAPER_PAGES = [
  [
    '2024 年验收测试卷（自动生成，非真题）',
    '1．【题型】单选题',
    '【题干】验收题一：下列说法正确的是？',
    '【选项】',
    'A. 甲',
    'B. 乙',
    '【材料一】验收材料：一段共享背景。',
    '【子题2】【题型】填空题',
    '【题干】验收子题：计算结果为 ____。',
  ].join('\n'),
]

const ANSWER_PAGES = ['参考答案\n1. A\n2. 42\n']

function pdfPage(): { paper: Buffer; answers: Buffer } {
  return {
    paper: buildTextPdf(PAPER_PAGES),
    answers: buildTextPdf(ANSWER_PAGES),
  }
}

/**
 * A token unique to one test *invocation*.
 *
 * The suite runs twice over the same database (desktop and mobile projects), and
 * a second run must not be judged by the first run's leftovers: a paper position
 * published by the desktop pass would legitimately block the mobile pass, and an
 * outline imported twice would merge instead of creating. Every test therefore
 * writes under its own cycle key / node names, which is also what a real second
 * import looks like from the server's point of view.
 */
function runToken(): string {
  const project = test.info().project.name.replace(/[^a-z0-9]/gi, '')
  return `${project}${Date.now().toString(36).slice(-5)}`
}

async function importPdf(page: Page, options: { cycleKey: string; expected?: string } ) {
  // The form is collapsed by default so the page keeps one obvious upload entry
  // for images; a real user opens it explicitly, and so does this suite.
  const toggle = page.getByTestId('pdf-import-toggle')
  if ((await toggle.innerText()).includes('展开')) await toggle.click()
  const { paper, answers } = pdfPage()
  await page.getByTestId('pdf-paper-input').setInputFiles({
    name: 'acceptance-paper.pdf',
    mimeType: 'application/pdf',
    buffer: paper,
  })
  await page.getByTestId('pdf-answer-input').setInputFiles({
    name: 'acceptance-answers.pdf',
    mimeType: 'application/pdf',
    buffer: answers,
  })
  await page.getByTestId('pdf-cycle-key').fill(options.cycleKey)
  await page.getByTestId('pdf-session-key').fill('上半年')
  await page.getByTestId('pdf-paper-code').fill('卷一')
  await page.getByTestId('pdf-title').fill(`${options.cycleKey} 年验收测试卷`)
  if (options.expected) await page.getByTestId('pdf-expected-sessions').fill(options.expected)
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/imports/pdf') && response.request().method() === 'POST',
  )
  await page.getByTestId('pdf-import-submit').click()
  const response = await responsePromise
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as { id: string; candidate_count: number }
}

test.describe('p1: native-text PDF import', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await switchProject(page, PROJECT_B)
    await switchSubject(page, IMPORT_SUBJECT)
  })

  test('a born-digital PDF becomes proofreadable candidates with their source page', async ({ page }) => {
    await page.goto('/imports')
    await expect(page.getByTestId('pdf-import-card')).toBeVisible()
    const job = await importPdf(page, { cycleKey: `2099${runToken()}`, expected: '1' })
    // Two questions plus the material parent: the material structure is parsed,
    // not reconstructed by hand.
    expect(job.candidate_count).toBe(3)

    await expect(page).toHaveURL(new RegExp(`/imports\\?job=${job.id}`))
    const candidates = await page.request.get(
      `/api/v1/projects/${await currentProjectId(page)}/import-candidates?job_id=${job.id}`,
    )
    expect(candidates.status()).toBe(200)
    const rows = (await candidates.json()) as CandidateRow[]
    expect(rows).toHaveLength(3)
    const question = rows.find((row) => row.source_position_key === '1')!
    expect(question.source_regions[0].page_index).toBe(1)
    expect(question.answer_match.matched).toBe(true)
    const material = rows.find(
      (row) => row.draft_payload.question_type === 'material' && row.parent_candidate_id === null,
    )!
    const child = rows.find((row) => row.parent_candidate_id === material.id)!
    expect(child.answer_match.matched).toBe(true)

    // The review page must show the paper position, the source page and the
    // "matched answer still needs confirmation" notice.
    await page.goto(`/imports/${job.id}/candidates/${question.id}`)
    await expect(page.getByTestId('candidate-source')).toContainText('卷面题号：1')
    await expect(page.getByTestId('candidate-source')).toContainText('第 1 页')
    await expect(page.getByTestId('source-region').first()).toContainText('第 1 页')
    await expect(page.getByTestId('candidate-answer-match')).toBeVisible()
    await expect(page.getByTestId('candidate-answer-match')).toContainText('人工确认')
    // The child knows its material parent.
    await page.goto(`/imports/${job.id}/candidates/${child.id}`)
    await expect(page.getByTestId('candidate-material')).toBeVisible()
  })

  test('a confirmed match publishes the question and its paper position', async ({ page }) => {
    await page.goto('/imports')
    const cycleKey = `2098${runToken()}`
    const job = await importPdf(page, { cycleKey, expected: '1' })
    const projectId = await currentProjectId(page)
    const rows = (await (
      await page.request.get(`/api/v1/projects/${projectId}/import-candidates?job_id=${job.id}`)
    ).json()) as Array<{ id: string; source_position_key: string; revision: number }>
    const question = rows.find((row) => row.source_position_key === '1')!

    await page.goto(`/imports/${job.id}/candidates/${question.id}`)
    await page.getByTestId('confirm-answer-match').check()
    await page.getByTestId('practice-max-score').fill('2')
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes(`/import-candidates/${question.id}`) && response.request().method() === 'PATCH',
    )
    await page.getByTestId('save-candidate').click()
    expect((await saved).status()).toBe(200)
    const publishWait = page.waitForResponse(
      (response) => response.url().endsWith('/publish') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '发布题目版本' }).click()
    const published = await publishWait
    expect(published.status(), await published.text()).toBe(200)

    // "Published" must mean the score really entered the paper record.
    const papers = (await (
      await page.request.get(`/api/v1/projects/${projectId}/papers?subject_id=${await currentSubjectId(page)}`)
    ).json()) as Array<{
      cycle_key: string
      revisions: Array<{ id: string; scored_item_count: number; item_count: number }>
    }>
    const paper = papers.find((row) => row.cycle_key === cycleKey)!
    const revision = paper.revisions[0]
    const items = (await (
      await page.request.get(`/api/v1/projects/${projectId}/paper-revisions/${revision.id}/items`)
    ).json()) as Array<{ position_key: string; max_score: string; is_scored: boolean }>
    const item = items.find((row) => row.position_key === '1')
    expect(item, '发布后必须生成对应的试卷题项').toBeTruthy()
    expect(item!.is_scored).toBe(true)
    expect(Number(item!.max_score)).toBeGreaterThan(0)
  })

  test('re-importing the same paper cannot publish the same position twice', async ({ page }) => {
    await page.goto('/imports')
    const cycleKey = `2097${runToken()}`
    const first = await importPdf(page, { cycleKey })
    const projectId = await currentProjectId(page)
    const subjectId = await currentSubjectId(page)
    const firstRows = (await (
      await page.request.get(`/api/v1/projects/${projectId}/import-candidates?job_id=${first.id}`)
    ).json()) as Array<{ id: string; source_position_key: string; revision: number; draft_payload: Record<string, unknown> }>
    const question = firstRows.find((row) => row.source_position_key === '1')!

    // Proofread and publish, exactly as the UI does.
    const payload = { ...question.draft_payload }
    payload.practice_max_score = '2'
    payload.answer_status_known = true
    payload.answer_confirmed_by_match_review = true
    payload.check_basis = '人工核对答案页匹配（浏览器验收）'
    const headers = await csrfHeaders(page, `browser-acceptance-${Date.now()}`)
    let response = await page.request.patch(
      `/api/v1/projects/${projectId}/import-candidates/${question.id}`,
      { data: { draft_payload: payload, expected_revision: question.revision }, headers },
    )
    expect(response.status(), await response.text()).toBe(200)
    response = await page.request.post(`/api/v1/projects/${projectId}/import-candidates/${question.id}/publish`, {
      data: {},
      headers,
    })
    expect(response.status(), await response.text()).toBe(200)

    // The same bytes again: the import is recognised as a duplicate and the
    // already-published position is blocked instead of published twice.
    const second = await importPdf(page, { cycleKey })
    const secondRows = (await (
      await page.request.get(`/api/v1/projects/${projectId}/import-candidates?job_id=${second.id}`)
    ).json()) as Array<{ id: string; source_position_key: string; review_issues: Array<{ code: string }> }>
    const duplicate = secondRows.find((row) => row.source_position_key === '1')!
    expect(duplicate.review_issues.map((issue) => issue.code)).toContain('duplicate_paper_position')
    response = await page.request.post(
      `/api/v1/projects/${projectId}/import-candidates/${duplicate.id}/publish`,
      { data: {}, headers },
    )
    expect(response.status()).toBeGreaterThanOrEqual(400)

    const published = (await (
      await page.request.get(`/api/v1/projects/${projectId}/papers?subject_id=${subjectId}`)
    ).json()) as Array<{ cycle_key: string; revisions: Array<{ id: string }> }>
    const paper = published.find((row) => row.cycle_key === cycleKey)!
    for (const revision of paper.revisions) {
      const items = (await (
        await page.request.get(`/api/v1/projects/${projectId}/paper-revisions/${revision.id}/items`)
      ).json()) as Array<{ position_key: string }>
      expect(items.filter((item) => item.position_key === '1').length).toBeLessThanOrEqual(1)
    }
  })
})

test.describe('p1: syllabus word list and manual mapping', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await switchProject(page, PROJECT_B)
  })

  test('a word list builds a node tree, merges synonyms and refuses a cycle', async ({ page }) => {
    const token = runToken()
    const ROOT = `第一章 验收解析${token}`
    const LEAF = `验收性质${token}`
    const outline = [
      ROOT,
      `  第一节 验收函数${token}`,
      `    验收定义${token}（验收映射${token}）`,
      `    ${LEAF}`,
      `  第二节 验收极限${token}`,
    ].join('\n')
    await page.goto('/knowledge')
    await page.getByTestId('outline-text').fill(outline)
    await page.getByTestId('outline-submit').click()
    await expect(page.getByTestId('outline-report')).toContainText('新建 5 个')
    // Re-importing the same list merges instead of duplicating (the form clears
    // itself after a successful import, exactly like a real user re-typing it).
    await page.getByTestId('outline-text').fill(outline)
    await page.getByTestId('outline-submit').click()
    await expect(page.getByTestId('outline-report')).toContainText('合并 5 个')

    const projectId = await currentProjectId(page)
    const nodes = await findNodesBySyllabus(page, projectId, ROOT)
    const root = nodes.find((node) => node.canonical_name === ROOT)!
    const leaf = nodes.find((node) => node.canonical_name === LEAF)!
    expect(root, '词表导入后必须能在该科目的考点列表中找到顶层章').toBeTruthy()
    expect(leaf, '词表导入后必须能在该科目的考点列表中找到叶子考点').toBeTruthy()
    expect(leaf.parent_id, '缩进层级必须变成真实的父子关系').toBeTruthy()

    // The UI must refuse moving a parent under its own descendant.
    await openNodeEditor(page, ROOT)
    await selectParentByName(page, LEAF)
    await page.getByTestId('node-save').click()
    await expect(page.getByTestId('node-error')).toContainText('环')

    // A legal move still works, and the tree is updated.
    await openNodeEditor(page, LEAF)
    await selectParentByName(page, ROOT)
    await page.getByTestId('node-save').click()
    await expect(page.getByTestId('node-error')).not.toContainText('环')
  })
})

test.describe('p1: real cycle analysis', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await switchProject(page, PROJECT_B)
    await switchSubject(page, CYCLE_SUBJECT)
  })

  test('five complete real cycles are counted and the demo cycle is excluded', async ({ page }) => {
    await page.goto('/reports')
    const panel = page.getByTestId('cycle-analysis')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('cycle-status')).toContainText('完整周期充足')
    await expect(page.getByTestId('cycle-status')).toContainText('5 / 5')

    const rows = page.getByTestId('cycle-table').locator('tbody tr')
    await expect(rows).toHaveCount(5)
    // Each counted cycle has its own denominator and the weights add up to 1.
    for (const cycle of ['2019', '2020', '2021', '2022', '2023']) {
      const row = page.getByTestId('cycle-table').locator('tbody tr', { hasText: cycle }).first()
      await expect(row).toContainText('20.000')
      // The weights of one cycle add up to the whole denominator (100%): the
      // check is that nothing is counted twice, not that a number looks nice.
      await expect(row).toContainText('100.0%')
      await expect(row).toContainText('验收周期考点')
    }
    // The demo paper (2025) and the unfinished cycle (2024) are listed as
    // excluded, with the reason, and never inside the counted table.
    await expect(page.getByTestId('cycle-incomplete')).toContainText('2024')
    await expect(page.getByTestId('cycle-incomplete')).toContainText('2025')
    await expect(page.getByTestId('cycle-incomplete')).toContainText('演示')
    await expect(page.getByTestId('cycle-table')).not.toContainText('2025')
    await expect(page.getByTestId('cycle-gaps')).toBeVisible()
  })

  test('a subject without complete cycles shows the insufficient state', async ({ page }) => {
    await switchSubject(page, '验收科目三·专业实务')
    await page.goto('/reports')
    await expect(page.getByTestId('cycle-status')).toContainText('完整周期不足')
    await expect(page.getByTestId('cycle-status')).toContainText('0 / 5')
    await expect(page.getByTestId('cycle-analysis')).toContainText('不给出“近五年”结论')
  })
})

type CandidateRow = {
  id: string
  source_position_key: string
  parent_candidate_id: string | null
  draft_payload: { question_type?: string; [key: string]: unknown }
  answer_match: { matched?: boolean; method?: string; source_page_index?: number }
  source_regions: Array<{ page_index: number; text_span: string }>
}

/**
 * CSRF header for API calls made through `page.request`.
 *
 * `page.request` shares the browser context cookies but does not add the
 * `X-CSRFToken` header that the SPA sends, so a mutating call without it is
 * rejected by Django — which is the correct behaviour, not a test annoyance.
 */
async function csrfHeaders(page: Page, idempotencyKey?: string): Promise<Record<string, string>> {
  const cookies = await page.context().cookies()
  const token = cookies.find((cookie) => cookie.name === 'csrftoken')?.value ?? ''
  const headers: Record<string, string> = { 'X-CSRFToken': token, Referer: page.url() }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  return headers
}

/**
 * Open the inline editor of one node row.
 *
 * The editor is an extra `<tr>` in the same table, so the row must be picked by
 * "has an 编辑 button" as well as by name — otherwise the open editor's own
 * option list would match the name.
 */
async function openNodeEditor(page: Page, name: string): Promise<void> {
  const row = page
    .locator('table.data tbody tr')
    .filter({ hasText: name })
    .filter({ has: page.getByRole('button', { name: '编辑' }) })
    .first()
  await row.getByRole('button', { name: '编辑' }).click()
}

/** Nodes of the subject whose syllabus contains `probeName` (import target). */
async function findNodesBySyllabus(
  page: Page,
  projectId: string,
  probeName: string,
): Promise<Array<{ id: string; canonical_name: string; parent_id: string | null; aliases: string[] }>> {
  type Node = { id: string; canonical_name: string; parent_id: string | null; aliases: string[] }
  const subjects = (await (
    await page.request.get(`/api/v1/projects/${projectId}/subjects`)
  ).json()) as Array<{ id: string }>
  for (const subject of subjects) {
    const rows = (await (
      await page.request.get(`/api/v1/projects/${projectId}/knowledge-nodes?subject_id=${subject.id}`)
    ).json()) as Node[]
    if (rows.some((row) => row.canonical_name === probeName)) return rows
  }
  return []
}

/** Choose the parent option whose path label contains `name`. */
async function selectParentByName(page: Page, name: string): Promise<void> {
  const select = page.getByTestId('node-parent')
  const options = select.locator('option')
  const count = await options.count()
  for (let index = 0; index < count; index += 1) {
    const label = (await options.nth(index).innerText()).trim()
    if (label.includes(name)) {
      await select.selectOption({ index })
      return
    }
  }
  throw new Error(`parent option containing ${name} not found`)
}

/** The project currently selected in the app shell (its select value is the id). */
async function currentProjectId(page: Page): Promise<string> {
  const selected = await page.getByLabel('选择考试项目').inputValue()
  if (!selected) throw new Error('no project selected in the app shell')
  return selected
}

/** The subject currently selected in the app shell. */
async function currentSubjectId(page: Page): Promise<string> {
  const selected = await page.getByLabel('选择科目').inputValue()
  if (!selected) throw new Error('no subject selected in the app shell')
  return selected
}
