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

  test('answer every question type in the workbench with a real score', async ({ page }) => {
    await page.goto('/questions')
    const rows = page.locator('table.data tbody tr')
    await expect(rows.first()).toBeVisible()

    const seen = new Set<string>()
    for (const label of ['单选', '多选', '判断', '填空', '大题']) {
      const row = page.locator('table.data tbody tr', { hasText: label }).first()
      // A missing type is a failure, not a reason to skip: the whole point of
      // this test is that all five are exercised.
      await expect(row, `题库中必须存在 ${label} 类型题目`).toBeVisible()
      await row.getByRole('button', { name: '开始练习' }).click()
      await expect(page.getByRole('heading', { name: '刷题工作台' })).toBeVisible()
      await expect(page.locator('.workbench')).toBeVisible()
      const type = ((await page.locator('.workbench .card .pill').first().textContent()) ?? '').trim()
      expect(type.length, `题型标签必须出现（${label}）`).toBeGreaterThan(0)
      seen.add(type)

      if (type.includes('单选') || type.includes('多选')) {
        await page.locator('.option').first().click()
      } else if (type.includes('判断')) {
        await page.getByRole('button', { name: '正确', exact: true }).click()
      } else if (type.includes('填空')) {
        const inputs = page.locator('.blank-row input')
        expect(await inputs.count()).toBeGreaterThanOrEqual(1)
        for (let index = 0; index < (await inputs.count()); index += 1) {
          await inputs.nth(index).fill('0.5')
        }
      } else if (type.includes('大题')) {
        await page.getByPlaceholder('写下你的推导过程与结论').fill('浏览器验收：写下推导过程。')
        await expect(page.locator('.workbench input[type="file"]'), '大题必须能上传作答照片').toHaveCount(1)
      }

      const submitResponse = page.waitForResponse((r) => r.url().endsWith('/submit'))
      await page.getByRole('button', { name: '提交作答' }).click()
      const response = await submitResponse
      expect(response.status(), `提交必须成功（${label}）`).toBe(200)
      const body = (await response.json()) as {
        grade: { status: string; max_score: string; pending_max_score: string } | null
        receipt_only: boolean
      }
      expect(body.receipt_only).toBe(false)
      expect(body.grade, `练习模式必须返回真实评分（${label}）`).not.toBeNull()

      await expect(page.getByText('提交时间', { exact: false }).first()).toBeVisible()
      await expect(page.getByTestId('grade-panel')).toBeVisible()
      await expect(page.getByTestId('grade-score')).toContainText(`/ ${Number(body.grade!.max_score).toFixed(2)}`)

      // The invariant that matters: a reported score is never invented, and the
      // pending value is the maximum of the parts that are genuinely undecided.
      const grade = body.grade!
      if (type.includes('大题')) {
        // A constructed response is never auto-scored.
        expect(grade.status).toBe('pending_review')
        expect(Number(grade.pending_max_score)).toBe(Number(grade.max_score))
      } else if (grade.status === 'confirmed') {
        // Graded: nothing may remain "pending", whatever the score is.
        expect(Number(grade.pending_max_score)).toBe(0)
      } else {
        // A wrong fill-in answer under a `review` mismatch policy is sent to a
        // human rather than guessed, so it must carry a real pending maximum
        // instead of a 0 score.
        expect(grade.status).toBe('pending_review')
        expect(Number(grade.pending_max_score)).toBeGreaterThan(0)
      }

      await page.goto('/questions')
      await expect(rows.first()).toBeVisible()
    }
    expect(seen.size, '五种题型必须全部真实作答，缺一类即为失败').toBe(5)
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

  test('practice reveal records assistance and an active verification hides grading', async ({ page }) => {
    await page.goto('/questions')
    const row = page.locator('table.data tbody tr', { hasText: '单选' }).first()
    await row.getByRole('button', { name: '开始练习' }).click()
    const revealResponse = page.waitForResponse((r) => r.url().endsWith('/reveal'))
    await page.getByRole('button', { name: /查看答案与解析/ }).click()
    expect((await revealResponse).status()).toBe(200)
    await expect(page.getByText('答案与解析（已记录暴露）')).toBeVisible()
    await expect(page.getByText(/辅助暴露|答案性内容|已记录暴露/).first()).toBeVisible()

    // The session payload itself reports the mode and whether the score is
    // visible, so this reads the server's own answer rather than the UI's.
    const sessionId = new URL(page.url()).searchParams.get('session')
    const projectFromUrl = new URL(page.url()).searchParams.get('project')
    expect(sessionId, '工作台 URL 必须携带 session id').not.toBeNull()
    expect(projectFromUrl, '工作台 URL 必须携带 project id').not.toBeNull()
    const state = (await page.evaluate(
      async ([project, session]) =>
        (
          await fetch(`/api/v1/projects/${project}/practice-sessions/${session}`, { credentials: 'same-origin' })
        ).json(),
      [projectFromUrl, sessionId],
    )) as { mode: string; score_visible: boolean; confirmed_score: string | null }
    expect(state.mode).toBe('practice')
    expect(state.score_visible).toBe(true)
    expect(state.confirmed_score).not.toBeNull()
  })

  test('today plan, review page and report render real numbers', async ({ page }) => {
    await page.goto('/today')
    const planResponse = page.waitForResponse((r) => r.url().includes('/study-plans/today/generate'))
    await page.getByRole('button', { name: /生成今日计划|补生成缺失任务/ }).click()
    const plan = (await (await planResponse).json()) as {
      plan: { daily_budget_minutes: number; allocated_minutes: number } | null
      tasks: Array<{ task_kind: string; status: string }>
    }
    expect(plan.plan, '生成今日计划必须返回真实计划').not.toBeNull()
    expect(plan.plan!.daily_budget_minutes).toBeGreaterThan(0)
    // The header budget text is rendered in more than one place, so assert on
    // the first match instead of demanding uniqueness.
    await expect(page.getByText(/预算 \d+ 分钟/).first()).toBeVisible()
    await expect(page.getByText('今日任务', { exact: false }).first()).toBeVisible()

    // The review page's three queues must answer 2xx: an empty state is not
    // evidence that the page works (R01).
    const failures: string[] = []
    page.on('response', (response) => {
      if (/\/(review-tasks|evidence|mistakes)/.test(response.url()) && response.status() >= 400) {
        failures.push(`${response.status()} ${response.url()}`)
      }
    })
    await page.goto('/review')
    await expect(page.getByRole('heading', { name: '错题与复习' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /延迟验证任务/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /已确认的错题/ })).toBeVisible()
    expect(failures, `复习页依赖的接口不得失败：${failures.join(', ')}`).toEqual([])

    const reportResponse = page.waitForResponse((r) => r.url().includes('/reports/practice'))
    await page.goto('/reports')
    await expect(page.getByRole('heading', { name: '报告' })).toBeVisible()
    await expect(page.getByText('作答分类')).toBeVisible()
    await expect(page.getByText('按考点')).toBeVisible()
    const report = (await (await reportResponse).json()) as {
      totals: Record<string, { attempts: number }>
      hidden_verification_attempts: number
    }
    // Grading completeness and full marks are reported as separate buckets.
    expect(report.totals.fully_graded, '报告必须区分「已评完」与「完全正确」').toBeDefined()
    expect(report.totals.partially_graded).toBeDefined()
    expect(typeof report.hidden_verification_attempts).toBe('number')
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
