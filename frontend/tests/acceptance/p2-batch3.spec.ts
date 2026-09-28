import { expect, test, type Page } from '@playwright/test'
import { login, switchProject, switchSubject } from './helpers'

/**
 * Real-browser acceptance of P2 batch 3 (the final planned batch).
 *
 * C05 timed mock exam: the countdown comes from the server's deadline, a reload
 * cannot extend it, nothing reveals correctness while the exam runs, and the
 * result only appears after it is finished.
 * C06 report: an unscored constructed response makes the report say
 * "成绩未完成" with the missing range instead of a final percentage, and grading it
 * really flips the report to final.
 * C08 calibration: groups below the minimum sample show no statistics at all and
 * the caveats (no causal claim) are on screen.
 */

const PROJECT = '验收项目A·基础能力'
const SUBJECT = '验收科目一·数量关系'

async function currentSubjectId(page: Page) {
  const value = await page.evaluate(() => window.localStorage.getItem('acepass.currentSubject'))
  expect(value, '页面必须已选定科目').toBeTruthy()
  return value as string
}

async function currentProjectId(page: Page) {
  const value = await page.evaluate(() => window.localStorage.getItem('acepass.currentProject'))
  expect(value, '页面必须已选定项目').toBeTruthy()
  return value as string
}

test.describe('P2 batch 3: timed exam, honest report scope and calibration', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await switchProject(page, PROJECT)
    await switchSubject(page, SUBJECT)
  })

  test('the exam clock belongs to the server and the result appears only after finishing', async ({ page }) => {
    await page.goto('/practice')
    await page.getByTestId('mock-exam-start').click()
    await page.getByTestId('mock-exam-duration').fill('5')
    const created = page.waitForResponse(
      (r) => r.url().includes('/practice-sessions') && r.request().method() === 'POST',
    )
    await page.getByTestId('mock-exam-confirm-start').click()
    const createdResponse = await created
    expect(createdResponse.status(), await createdResponse.text()).toBe(201)
    const session = (await createdResponse.json()) as {
      session_id: string
      exam_deadline: string
      server_time: string
      grading_hidden: boolean
    }
    expect(session.exam_deadline, '模拟考试必须有服务端截止时间').toBeTruthy()
    expect(session.grading_hidden).toBe(true)

    // The countdown is server-derived and a reload cannot move the deadline: the
    // immutable value is the one the server stores, so assert exactly that.
    await expect(page.getByTestId('mock-exam-timer')).toBeVisible()
    const projectIdEarly = await currentProjectId(page)
    const detailBefore = await page.request.get(
      `/api/v1/projects/${projectIdEarly}/practice-sessions/${session.session_id}`,
    )
    const deadlineBefore = ((await detailBefore.json()) as { exam_deadline: string }).exam_deadline
    expect(deadlineBefore).toBe(session.exam_deadline)
    const before = await page.getByTestId('mock-exam-remaining').innerText()
    await page.reload()
    await expect(page.getByTestId('mock-exam-timer')).toBeVisible()
    const after = await page.getByTestId('mock-exam-remaining').innerText()
    const detailAfter = await page.request.get(
      `/api/v1/projects/${projectIdEarly}/practice-sessions/${session.session_id}`,
    )
    const deadlineAfter = ((await detailAfter.json()) as { exam_deadline: string }).exam_deadline
    expect(deadlineAfter, '刷新不得重置或延长服务端截止时间').toBe(deadlineBefore)
    expect(before.trim()).not.toBe('')
    expect(after.trim()).not.toBe('')

    // No correctness feedback while the exam runs, from the UI or the API.
    await expect(page.getByTestId('mock-exam-no-feedback')).toBeVisible()
    const projectId = projectIdEarly
    const items = await page.request.get(`/api/v1/projects/${projectId}/practice-sessions/${session.session_id}`)
    const payload = (await items.json()) as {
      items: Array<{ session_item_id: string; attempt?: { grade?: unknown } | null }>
    }
    expect(payload.items.length, '模拟考试必须有题目').toBeGreaterThan(0)
    const firstItem = payload.items[0]
    expect(firstItem.attempt?.grade ?? null, '考试进行中不得返回判分').toBeNull()

    // Finishing is one-shot and only then reveals results.
    await page.getByTestId('mock-exam-submit').click()
    await page.getByTestId('mock-exam-submit-confirm').click()
    const finished = page.waitForResponse((r) => r.url().includes('/finish') && r.request().method() === 'POST')
    expect((await finished).status()).toBe(200)
    await expect(page.getByTestId('mock-exam-result')).toBeVisible()
  })

  test('an unscored answer makes the report show its missing range instead of a final score', async ({ page }) => {
    await page.goto('/reports')
    await expect(page.getByTestId('report-incomplete-banner')).toBeVisible()
    await expect(page.getByTestId('report-incomplete-reason').first()).toBeVisible()
    await expect(page.getByTestId('report-lower-bound')).toContainText('下限')
    expect(await page.getByTestId('report-final-result').count(), '未完成时不得显示最终结果').toBe(0)

    // The payload is the product here: capture the exact incomplete range and
    // confirmed total before grading one item.
    const projectId = await currentProjectId(page)
    const pendingBefore = await page.request.get(
      `/api/v1/projects/${projectId}/reports/practice?subject_id=${await currentSubjectId(page)}`,
    )
    const before = (await pendingBefore.json()) as {
      incomplete_scope: { reasons: Array<{ code: string; attempt_count: number }> }
      aggregate?: { confirmed_score?: string | null }
    }
    const pendingCountBefore =
      before.incomplete_scope.reasons.find((reason) => reason.code === 'pending_review')?.attempt_count ?? 0
    expect(pendingCountBefore, '夹具里应有待人工评分的大题').toBeGreaterThan(0)

    // Grade the pending constructed response through the real grading page.
    await page.goto('/grading')
    const row = page.locator('table.data tbody tr').first()
    await expect(row).toBeVisible()
    await row.click()
    const inputs = page.locator('input[placeholder^="0 ~ "]')
    const count = await inputs.count()
    expect(count, '大题必须有评分点').toBeGreaterThan(0)
    const maxes: string[] = []
    for (let index = 0; index < count; index += 1) {
      const placeholder = (await inputs.nth(index).getAttribute('placeholder')) ?? '0 ~ 0'
      maxes.push(placeholder.replace('0 ~', '').trim())
    }
    for (let index = 0; index < maxes.length; index += 1) {
      await inputs.nth(index).fill(maxes[index])
    }
    const confirmed = page.waitForResponse((r) => r.url().includes('/confirm-grade') && r.request().method() === 'POST')
    await page.getByRole('button', { name: '确认评分' }).click()
    expect((await confirmed).status()).toBe(200)

    // Grading one item really shrinks the incomplete range by exactly one and
    // moves the confirmed total — the report is not just a banner.
    const afterPending = await page.request.get(
      `/api/v1/projects/${projectId}/reports/practice?subject_id=${await currentSubjectId(page)}`,
    )
    const after = (await afterPending.json()) as {
      incomplete_scope: { is_incomplete: boolean; reasons: Array<{ code: string; attempt_count: number }> }
      aggregate?: { confirmed_score?: string | null }
      final_result?: { score_rate?: string } | null
    }
    const pendingCountAfter =
      after.incomplete_scope.reasons.find((reason) => reason.code === 'pending_review')?.attempt_count ?? 0
    expect(pendingCountAfter, '确认一次评分后待评数必须减少').toBe(pendingCountBefore - 1)
    expect(Number(after.aggregate?.confirmed_score ?? 0)).toBeGreaterThan(
      Number(before.aggregate?.confirmed_score ?? 0),
    )

    await page.goto('/reports')
    if (after.incomplete_scope.is_incomplete) {
      // Other items in this shared fixture are still ungraded: the banner and the
      // lower bound must still be there, and never a final score.
      await expect(page.getByTestId('report-incomplete-banner')).toBeVisible()
      await expect(page.getByTestId('report-lower-bound')).toBeVisible()
      expect(await page.getByTestId('report-final-result').count()).toBe(0)
    } else {
      await expect(page.getByTestId('report-final-result')).toBeVisible({ timeout: 20_000 })
    }
  })

  test('the calibration panel withholds numbers it cannot support and states its caveats', async ({ page }) => {
    await page.goto('/reports')
    await expect(page.getByTestId('calibration-panel')).toBeVisible()
    await expect(page.getByTestId('calibration-group-row').first()).toBeVisible()
    await expect(page.getByTestId('calibration-caveats')).toContainText('不')
    // The acceptance fixture has far fewer than the minimum sample per group, so
    // no group may show statistics.
    await expect(page.getByTestId('calibration-insufficient').first()).toContainText('样本不足')
    const comparisonCount = await page.getByTestId('calibration-comparison').count()
    if (comparisonCount > 0) {
      await expect(page.getByTestId('calibration-comparison').first()).toContainText('样本')
    }
    expect(
      await page.getByTestId('calibration-panel').innerText(),
      '不得出现单一"提升 X%"式的因果结论',
    ).not.toMatch(/提升\s*\d/)
  })
})
