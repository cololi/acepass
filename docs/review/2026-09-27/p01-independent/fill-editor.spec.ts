import path from 'node:path'
import { test, expect } from '../../../../frontend/node_modules/@playwright/test'
import { login, switchProject, switchSubject, PROJECT_A } from '../../../../frontend/tests/acceptance/helpers'

test('visible fill-blank answers persist in the authoritative answer payload', async ({ page }) => {
  await login(page)
  await switchProject(page, PROJECT_A)
  await switchSubject(page, '验收科目一·数量关系')
  await page.goto('/imports')
  await expect(page.getByRole('heading', { name: '导入与校对', exact: true })).toBeVisible()
  const uploadWait = page.waitForResponse(r => r.url().endsWith('/imports/images') && r.request().method() === 'POST')
  await page.locator('input[type="file"]').setInputFiles(path.join(__dirname, 'fill-source.png'))
  const upload = await uploadWait
  expect(upload.status(), await upload.text()).toBe(201)
  await page.getByRole('link', { name: '校对/编辑', exact: true }).click()
  await expect(page.getByTestId('question-type-select')).toBeVisible()
  await page.getByTestId('question-type-select').selectOption('fill_blank')
  await page.getByTestId('stem-input').fill('独立验收填空：2 + 3 = ____。')
  await page.getByTestId('add-blank').click()
  await page.getByPlaceholder('可接受答案，用 | 分隔').first().fill('5')
  await page.getByPlaceholder('满分', { exact: true }).first().fill('2')
  const savedWait = page.waitForResponse(r => /\/import-candidates\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === 'PATCH')
  await page.getByTestId('save-candidate').click()
  const saved = await savedWait
  expect(saved.status(), await saved.text()).toBe(200)
  const body = await saved.json()
  console.log('persisted candidate', JSON.stringify({content:body.draft_payload.content,answer_payload:body.draft_payload.answer_payload}))
  expect(body.draft_payload.answer_payload.blanks.b1.accepted_values, '可视答案必须写入正式答案结构，不能只写入题干 content.blanks').toEqual(['5'])
})
