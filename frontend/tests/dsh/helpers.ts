import { expect, ensurePanelOpen, type Page } from './base'
import { readState } from './state'

/**
 * Helpers for the DSH acceptance suite.
 *
 * The assertions are the Django-era ones: every helper still checks a real
 * server response rather than a rendered string alone. Only the admission step
 * changed — DSH owns identity, so there is no account form and no CSRF.
 */

export const EMAIL = process.env.ACEPASS_BROWSER_EMAIL ?? 'acceptance@acepass.local'
export const PASSWORD = process.env.ACEPASS_BROWSER_PASSWORD ?? 'AcceptanceBrowser!2026'

export const PROJECT_A = '验收项目A·基础能力'
export const PROJECT_B = '验收项目B·专业实务'
/**
 * The delayed-verification chain lives in its own project.
 *
 * Its deadline moves whenever a *new* training or explanation happens on the
 * same knowledge point (correctly — that is the B04 rule), so any other scenario
 * revealing an answer on that point would un-do the fixture's "C is due" setup.
 */
export const PROJECT_C = '验收项目C·延迟验证'

/**
 * Admit the browser and open the AcePass panel.
 *
 * Django: fill the email/password form and wait for the project page. DSH: the
 * first navigation to the `?token=` URL sets the auth cookie, the shell owns the
 * session, and the panel is one click away. Idempotent, so a spec may call it
 * mid-test after a hard navigation.
 */
export async function login(page: Page) {
  if ((await page.locator('.context-strip').count()) > 0) {
    await ensurePanelOpen(page)
    return
  }
  await page.goto(readState().baseUrl)
  await ensurePanelOpen(page)
  // The honest equivalent of "登录 succeeded": the authenticated app shell is
  // mounted with the project selector it cannot render without an identity.
  await expect(page.getByLabel('选择考试项目')).toBeVisible({ timeout: 30_000 })
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
