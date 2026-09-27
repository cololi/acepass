import { expect, type Page } from '@playwright/test'

export const EMAIL = 'e2e@acepass.local'
export const PASSWORD = 'E2eBrowser!2026'

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
