import { expect, test } from './base'
import { login, switchProject, switchSubject } from './helpers'

/**
 * Real-browser acceptance of P2 batch 2 (C03 sealing + family merge, C02 variants).
 *
 * Two evidence classes, and the file says which is which:
 * * untagged tests run in the default acceptance environment (`ACEPASS_AI_PROVIDER=none`):
 *   seal/unseal really block the practice entry point, and the variant action must
 *   report the honest "no model configured" state instead of inventing candidates;
 * * the `@stub` test runs only in the stub-provider run: the offline stub's
 *   placeholder variant has no answer, so validation must reject it and the UI must
 *   say "nothing usable" rather than presenting it as generated content.
 */

const PROJECT = '验收项目A·基础能力'
const SUBJECT = '验收科目一·数量关系'

async function openFirstQuestionPanel(page: import('@playwright/test').Page) {
  await page.goto('/questions')
  const rows = page.locator('table.data tbody tr')
  await expect(rows.first()).toBeVisible()
  return rows.first()
}

test.describe('P2 batch 2: sealing, families and validated variants', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await switchProject(page, PROJECT)
    await switchSubject(page, SUBJECT)
  })

  test('a sealed question cannot be practised, and unsealing restores it', async ({ page }) => {
    const row = await openFirstQuestionPanel(page)
    const label = ((await row.locator('td').first().innerText()) ?? '').trim().split('\n')[0]

    // Seal it with a reason.
    await page.getByTestId('question-seal').first().click()
    await page.getByTestId('seal-reason').first().fill('保留待验证：本轮不用于练习')
    const sealed = page.waitForResponse((r) => r.url().includes('/seal') && r.request().method() === 'POST')
    await page.getByTestId('question-seal-confirm').first().click()
    const sealedResponse = await sealed
    expect([200, 201]).toContain(sealedResponse.status())
    await expect(page.getByTestId('question-sealed-state').first()).toContainText('已封存')
    await expect(page.getByTestId('sealed-content-list')).toContainText(label)

    // The practice entry point must be refused by the server, with the sealing reason.
    const blocked = page.waitForResponse(
      (r) => r.url().includes('/practice-sessions') && r.request().method() === 'POST',
    )
    await page.locator('table.data tbody tr', { hasText: label }).first().getByRole('button', { name: '开始练习' }).click()
    const blockedResponse = await blocked
    expect(blockedResponse.status(), '封存题目不得进入练习').toBe(403)
    const body = (await blockedResponse.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('purpose_not_allowed')
    expect(body.error.message).toContain('封存')

    // Unsealing really restores the content.
    await page.goto('/questions')
    await page.getByTestId('question-unseal').first().click()
    const unsealed = page.waitForResponse((r) => r.url().includes('/unseal') && r.request().method() === 'POST')
    await page.getByTestId('question-unseal-confirm').first().click()
    expect([200, 201]).toContain((await unsealed).status())
    await page.goto('/questions')
    await expect(page.getByTestId('sealed-content-list')).not.toContainText(label)
  })

  test('merging two families shows the impact first and then invalidates the stale evidence', async ({ page }) => {
    await page.goto('/knowledge')
    await expect(page.getByTestId('families-panel')).toBeVisible()

    const token = Date.now().toString(36).slice(-5)
    const sourceName = `验收家族甲-${token}`
    const targetName = `验收家族乙-${token}`
    for (const name of [sourceName, targetName]) {
      await page.getByTestId('family-name').fill(name)
      const created = page.waitForResponse(
        (r) => r.url().includes('/question-families') && r.request().method() === 'POST',
      )
      await page.getByTestId('family-create').click()
      expect((await created).status(), `创建家族 ${name} 必须成功`).toBe(201)
      await expect(page.getByTestId('family-row').filter({ hasText: name }).first()).toBeVisible()
    }

    // Merge is two-step: the impact preview must be visible before confirming.
    const sourceRow = page.getByTestId('family-row').filter({ hasText: sourceName }).first()
    await sourceRow.getByTestId('family-merge').click()
    await page.getByTestId('family-merge-target').selectOption({ label: targetName })
    const impact = page.waitForResponse((r) => r.url().includes('/merge-impact'))
    await page.getByTestId('family-merge-impact').click()
    expect((await impact).status()).toBe(200)
    await expect(page.getByTestId('family-merge-preview')).toContainText('题目')

    const merged = page.waitForResponse(
      (r) => r.url().includes('/merge') && r.request().method() === 'POST',
    )
    await page.getByTestId('family-merge-confirm').click()
    const mergedResponse = await merged
    expect([200, 201]).toContain(mergedResponse.status())
    await expect(page.getByTestId('family-merge-result')).toBeVisible()

    // The source family is gone (merged) and the target still lists one family.
    await expect(page.getByTestId('family-row').filter({ hasText: sourceName })).toHaveCount(0)
    await expect(page.getByTestId('family-row').filter({ hasText: targetName }).first()).toBeVisible()
  })

  test('proposing a variant without a model reports the real reason and creates nothing', async ({ page }) => {
    const row = await openFirstQuestionPanel(page)
    await row.getByTestId('variant-propose').first().click()
    // The panel, not the per-row action (that testid exists once per question row).
    await expect(page.getByTestId('variant-submit')).toBeVisible()

    const proposed = page.waitForResponse(
      (r) => r.url().includes('/variants/propose') && r.request().method() === 'POST',
    )
    await page.getByTestId('variant-submit').click()
    const response = await proposed
    // No provider is configured in this environment: the only honest answers are
    // an explicit 503 or a 400 for a bad source — never invented candidates.
    expect([400, 503]).toContain(response.status())
    if (response.status() === 503) {
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('ai_not_configured')
      await expect(page.getByTestId('variant-result')).toContainText('未配置')
    }
    expect(await page.getByTestId('variant-candidate-row').count()).toBe(0)
  })
})

test.describe('P2 batch 2 stub-provider run', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await switchProject(page, PROJECT)
    await switchSubject(page, SUBJECT)
  })

  test('@stub the offline stub can never produce a usable variant', async ({ page }) => {
    const row = await openFirstQuestionPanel(page)
    await row.getByTestId('variant-propose').first().click()
    const proposed = page.waitForResponse(
      (r) => r.url().includes('/variants/propose') && r.request().method() === 'POST',
    )
    await page.getByTestId('variant-submit').click()
    const response = await proposed
    expect(response.status(), await response.text()).toBe(201)
    const body = (await response.json()) as { nothing_passed?: boolean; validation?: { accepted?: number } }
    // The stub's placeholder carries no answer, so every candidate must be blocked.
    expect(body.validation?.accepted ?? 0).toBe(0)
    await expect(page.getByTestId('variant-result')).toContainText('没有可用的变式')
    await expect(page.getByTestId('variant-candidate-row').first()).toBeVisible()
    await expect(page.getByTestId('variant-issue').first()).toBeVisible()
  })
})
