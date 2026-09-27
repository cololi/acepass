import { expect, type Page } from '@playwright/test'

/**
 * Helpers for the isolated acceptance suite.
 *
 * Every helper asserts on a real server response rather than on a rendered
 * string alone: the review specifically objected that the earlier suite passed
 * while the underlying requests were 404 or while a section was simply empty.
 */

export const EMAIL = process.env.ACEPASS_BROWSER_EMAIL ?? 'acceptance@acepass.local'
export const PASSWORD = process.env.ACEPASS_BROWSER_PASSWORD ?? 'AcceptanceBrowser!2026'

export const PROJECT_A = '验收项目A·基础能力'
export const PROJECT_B = '验收项目B·专业实务'

export async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('邮箱').fill(EMAIL)
  await page.getByLabel('密码').fill(PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByText('我的备考项目')).toBeVisible()
}

export async function switchProject(page: Page, name: string) {
  await page.getByLabel('选择考试项目').selectOption({ label: name })
  await expect(page.locator('.context-strip')).toContainText(name)
}

export async function switchSubject(page: Page, name: string) {
  await page.getByLabel('选择科目').selectOption({ label: name })
}

/** Fail the test if any response to this URL predicate is an error status. */
export function watchResponses(page: Page, predicate: (url: string) => boolean) {
  const failures: string[] = []
  page.on('response', (response) => {
    if (predicate(response.url()) && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`)
    }
  })
  return failures
}

/** Open the workbench for one question type from the question bank. */
export async function openWorkbench(page: Page, label: string) {
  await page.goto('/questions')
  const row = page.locator('table.data tbody tr', { hasText: label }).first()
  await expect(row, `题库中应存在 ${label}`).toBeVisible()
  await row.getByRole('button', { name: '开始练习' }).click()
  await expect(page.getByRole('heading', { name: '刷题工作台' })).toBeVisible()
  await expect(page.locator('.workbench')).toBeVisible()
}

export const TYPE_LABELS = ['单选', '多选', '判断', '填空', '大题'] as const
