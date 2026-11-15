// Archived UI counter-examples (2026-09-27 review), re-run against the DSH client.
//
// Body, titles and every assertion are byte-identical to
// docs/review/2026-09-27/ui-regressions.spec.ts. Only the import seam changed:
// the Django-era `login` helper and the direct `@playwright/test` import are
// replaced by the DSH transport seam (`../base`) and the migrated `login`
// (`../helpers`).
import { test, expect } from '../base'
import { login } from '../helpers'

test.beforeEach(async ({ page }) => { await login(page) })
async function start(page: any, label: string) {
  await page.goto('/questions')
  await page.locator('table.data tbody tr', {hasText: label}).first().getByRole('button', {name:'开始练习'}).click()
  await expect(page.getByRole('heading',{name:'刷题工作台'})).toBeVisible()
}

test('submitted practice still exposes tutoring entry', async ({page}) => {
  await start(page,'单选')
  await page.locator('.option').first().click()
  await page.getByRole('button',{name:'提交作答'}).click()
  await expect(page.getByText('提交时间',{exact:false}).first()).toBeVisible()
  await expect(page.getByRole('button',{name:'完整讲解',exact:true})).toBeVisible()
})

test('answer reveal survives reloading a submitted item', async ({page}) => {
  await start(page,'单选')
  await page.locator('.option').first().click()
  await page.getByRole('button',{name:'提交作答'}).click()
  await expect(page.getByText('提交时间',{exact:false}).first()).toBeVisible()
  await page.reload()
  await expect(page.getByText('提交时间',{exact:false}).first()).toBeVisible()
  const responsePromise=page.waitForResponse(r=>r.url().endsWith('/reveal'))
  await page.getByRole('button',{name:'查看答案与解析',exact:true}).click()
  const response=await responsePromise
  console.log('REVEAL_AFTER_RELOAD',response.url(),response.status())
  expect(response.status()).toBe(200)
})

test('constructed response provides photo attachment input', async ({page}) => {
  await start(page,'大题')
  await expect(page.locator('.workbench input[type="file"]')).toHaveCount(1)
})
