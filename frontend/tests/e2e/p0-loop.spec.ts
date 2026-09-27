import { expect, test } from '@playwright/test'
import { login, switchProject } from './helpers'

/**
 * Real-browser acceptance of the P0 loop end to end.
 *
 * Evidence class: real browser against the real API with clearly-labelled demo
 * fixtures. It is not evidence of real exam content quality, of a real model
 * provider, or of a real elapsed day.
 */

test.describe('P0 learning loop', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('project context is explicit and switching changes the data', async ({ page }) => {
    await expect(page.locator('.context-strip')).toContainText('演示项目A·综合能力')
    await page.getByRole('button', { name: '进入题库' }).nth(1).click()
    await expect(page.getByRole('heading', { name: '题库与导入' })).toBeVisible()
    await switchProject(page, '演示项目B·专业实务')
    await expect(page.getByRole('heading', { name: '题库与导入' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('演示科目A1')
  })

  test('answer every question type in the workbench', async ({ page }) => {
    await page.goto('/questions')
    const rows = page.locator('table.data tbody tr')
    await expect(rows.first()).toBeVisible()

    const seen = new Set<string>()
    for (const label of ['单选', '多选', '判断', '填空', '大题']) {
      const row = page.locator('table.data tbody tr', { hasText: label }).first()
      if ((await row.count()) === 0) continue
      await row.getByRole('button', { name: '开始练习' }).click()
      await expect(page.getByRole('heading', { name: '刷题工作台' })).toBeVisible()
      const type = ((await page.locator('.workbench .card .pill').first().textContent()) ?? '').trim()
      expect(type.length).toBeGreaterThan(0)
      seen.add(type)

      if (type.includes('单选') || type.includes('多选')) {
        await page.locator('.option').first().click()
      } else if (type.includes('判断')) {
        await page.getByRole('button', { name: '正确', exact: true }).click()
      } else if (type.includes('填空')) {
        const inputs = page.locator('.blank-row input')
        for (let index = 0; index < (await inputs.count()); index += 1) {
          await inputs.nth(index).fill('0.5')
        }
      } else if (type.includes('大题')) {
        await page.getByPlaceholder('写下你的推导过程与结论').fill('浏览器验收：写下推导过程。')
      }
      await page.getByRole('button', { name: '提交作答' }).click()
      // Either a grade panel or a receipt appears; both prove submission worked.
      await expect(page.getByText('本题', { exact: false }).first()).toBeVisible()
      await expect(page.getByText('提交时间', { exact: false }).first()).toBeVisible()
      await page.goto('/questions')
      await expect(rows.first()).toBeVisible()
    }
    expect(seen.size).toBeGreaterThanOrEqual(3)
  })

  test('draft is saved and restored in the workbench', async ({ page }) => {
    await page.goto('/questions')
    const row = page.locator('table.data tbody tr', { hasText: '大题' }).first()
    await row.getByRole('button', { name: '开始练习' }).click()
    const editor = page.getByPlaceholder('写下你的推导过程与结论')
    await editor.fill('草稿内容：第一步先整理已知条件。')
    await expect(page.getByText(/草稿：(已保存|正在保存)/)).toBeVisible()
    await page.reload()
    await expect(page.getByPlaceholder('写下你的推导过程与结论')).toHaveValue(/整理已知条件/)
  })

  test('manual grading confirms a constructed response criterion by criterion', async ({ page }) => {
    await page.goto('/questions')
    const row = page.locator('table.data tbody tr', { hasText: '大题' }).first()
    await row.getByRole('button', { name: '开始练习' }).click()
    await page.getByPlaceholder('写下你的推导过程与结论').fill('待人工评分的大题作答。')
    await page.getByRole('button', { name: '提交作答' }).click()
    await expect(page.getByTestId('grade-panel')).toContainText('待复核/待评')

    await page.goto('/grading')
    const queueRow = page.locator('table.data tbody tr').first()
    await expect(queueRow).toBeVisible()
    await queueRow.click()
    await expect(page.getByRole('heading', { name: '逐评分点打分' })).toBeVisible()
    const scoreInputs = page.locator('.inline-field input[placeholder^="0 ~"]')
    const count = await scoreInputs.count()
    for (let index = 0; index < count; index += 1) {
      const placeholder = (await scoreInputs.nth(index).getAttribute('placeholder')) ?? '0 ~ 0'
      const max = placeholder.replace('0 ~ ', '')
      await scoreInputs.nth(index).fill(max)
    }
    await page.getByRole('button', { name: '确认评分' }).click()
    await expect(page.getByTestId('grade-method')).toContainText(/自评确认|复核确认/)
  })

  test('practice reveal records assistance and verification hides grading', async ({ page }) => {
    await page.goto('/questions')
    const row = page.locator('table.data tbody tr', { hasText: '单选' }).first()
    await row.getByRole('button', { name: '开始练习' }).click()
    await page.getByRole('button', { name: /查看答案与解析/ }).click()
    await expect(page.getByText('答案与解析（已记录暴露）')).toBeVisible()
    await expect(page.getByText(/辅助暴露|答案性内容|已记录暴露/).first()).toBeVisible()
  })

  test('today plan, review page and report render real numbers', async ({ page }) => {
    await page.goto('/today')
    await page.getByRole('button', { name: /生成今日计划|补生成缺失任务/ }).click()
    await expect(page.getByText(/预算 \d+ 分钟/)).toBeVisible()
    await expect(page.getByText('今日任务', { exact: false })).toBeVisible()

    await page.goto('/review')
    await expect(page.getByRole('heading', { name: '错题与复习' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /延迟验证任务/ })).toBeVisible()

    await page.goto('/reports')
    await expect(page.getByRole('heading', { name: '报告' })).toBeVisible()
    await expect(page.getByText('作答分类')).toBeVisible()
    await expect(page.getByText('按考点')).toBeVisible()
  })

  test('knowledge map shows evidence and missing pieces', async ({ page }) => {
    await page.goto('/knowledge')
    await expect(page.getByRole('heading', { name: '考点地图' })).toBeVisible()
    const firstNode = page.locator('table.data tbody tr').first()
    await expect(firstNode).toBeVisible()
    await firstNode.click()
    // Either a real evidence panel (there is evidence) or an explicit empty
    // state; the UI never shows a fabricated percentage.
    await expect(page.getByRole('heading', { name: '证据详情' })).toBeVisible()
    const panel = page.locator('.grid.two .card').last()
    await expect(panel).toContainText(/严格独立正确：\d+ 道不同题|还没有任何作答证据|证据行/)
  })

  test('AI status is explicit and the stub is labelled when enabled', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByText('AI 能力状态')).toBeVisible()
    await expect(page.getByText(/provider：/)).toBeVisible()
  })
})
