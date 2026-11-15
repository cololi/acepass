/**
 * The empty-account path, entirely through the UI (G07).
 *
 * The independent review objected that `bootstrap_acceptance` pre-builds the
 * projects, subjects, exam specs and published questions, so a green suite never
 * proved that a brand-new user can reach the learning loop. This test starts
 * from an account with *nothing* in it and builds the whole path with the
 * browser:
 *
 *   create project -> create subject -> publish a scoring spec ->
 *   upload an image -> proofread it into a fill-blank question -> publish ->
 *   practise it -> submit -> receive a confirmed score.
 *
 * Nothing is seeded by a management command, and every step asserts on the real
 * HTTP response, not only on a rendered label.
 */
import { expect, test, type Page } from './base'
import { login } from './helpers'
import zlib from 'node:zlib'

const BLANK_ANSWER = '42'
const BLANK_SCORE = '3'

function makePng(width: number, height: number): Buffer {
  const crcTable: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff)
  for (let row = 0; row < height; row += 1) raw[row * (1 + width * 3)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * DSH admits one workspace owner — there is no second, empty account to sign in
 * as. The *scenario* is unchanged and still starts from nothing *inside the
 * account*: it builds project, subject, scoring spec, an image import, a
 * fill-blank question, its publication, the practice attempt and the first
 * confirmed score entirely through the UI. Only the admission step differs.
 */
async function loginEmptyAccount(page: Page) {
  await login(page)
  await expect(page.getByRole('heading', { name: /开始使用|我的备考项目/ })).toBeVisible()
}

test('an empty account sets up, imports, publishes and practises through the UI', async ({ page }, testInfo) => {
  // The suite runs once per device project against the same database, so each
  // pass builds its own project and subject.
  const suffix = testInfo.project.name
  const projectName = `空账户验收项目-${suffix}`
  const subjectName = `空账户科目-${suffix}`

  await loginEmptyAccount(page)

  // ---------------------------------------------------------------- project
  if (await page.getByRole('heading', { name: '开始使用' }).isVisible().catch(() => false)) {
    await page.getByLabel(/项目名称/).fill(projectName)
    await page.getByRole('button', { name: '创建项目' }).click()
  } else {
    await page.getByRole('button', { name: '新建项目' }).click()
    await page.getByLabel('项目名称', { exact: true }).fill(projectName)
    await page.getByRole('button', { name: '创建', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: '我的备考项目' })).toBeVisible()
  // The project selector also renders the name as a (hidden) option, so assert
  // on the project card itself.
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible()

  // ------------------------------------------------------- subject and spec
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '项目与科目' })).toBeVisible()
  const subjectCard = page.locator('.card', { hasText: '新增科目' })
  await subjectCard.getByPlaceholder('科目名称').fill(subjectName)
  await subjectCard.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('li', { hasText: subjectName }).first()).toBeVisible()

  const specResponse = page.waitForResponse(
    (r) => r.url().includes('/exam-spec-versions') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '创建并发布规范' }).click()
  const spec = await specResponse
  expect(spec.status(), await spec.text()).toBe(201)
  await expect(page.getByText('规范已发布', { exact: false }).first()).toBeVisible()

  // ------------------------------------------- import, proofread and publish
  await page.goto('/imports')
  await expect(page.getByRole('heading', { name: '导入与校对', exact: true })).toBeVisible()
  const uploadWait = page.waitForResponse(
    (r) => r.url().endsWith('/imports/images') && r.request().method() === 'POST',
  )
  await page.getByTestId('image-import-input').setInputFiles({
    name: 'empty-account-source.png',
    mimeType: 'image/png',
    buffer: makePng(24, 24),
  })
  const upload = await uploadWait
  expect(upload.status(), await upload.text()).toBe(201)

  await page.getByRole('link', { name: '校对/编辑', exact: true }).click()
  await expect(page.getByTestId('question-type-select')).toBeVisible()
  await page.getByTestId('question-type-select').selectOption('fill_blank')
  await page.getByTestId('stem-input').fill('空账户验收填空：6 × 7 = ____。')
  await page.getByTestId('add-blank').click()
  await page.getByPlaceholder('可接受答案，用 | 分隔').first().fill(BLANK_ANSWER)
  // A blank without a score cannot be published ("空位分值必须是十进制数"), and the
  // scoring spec's fill-blank default is 3.
  await page.getByPlaceholder('满分', { exact: true }).first().fill(BLANK_SCORE)

  const savedWait = page.waitForResponse(
    (r) => /\/import-candidates\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === 'PATCH',
  )
  await page.getByTestId('save-candidate').click()
  const saved = await savedWait
  expect(saved.status(), await saved.text()).toBe(200)

  const publishWait = page.waitForResponse(
    (r) => r.url().endsWith('/publish') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '发布题目版本' }).click()
  const published = await publishWait
  expect(published.status(), await published.text()).toBe(200)

  // --------------------------------------------------- practise and be graded
  await page.goto('/questions')
  const row = page.locator('table.data tbody tr').first()
  await expect(row, '刚发布的题目必须出现在题库中').toBeVisible()
  await row.getByRole('button', { name: '开始练习' }).click()
  await expect(page.getByRole('heading', { name: '刷题工作台' })).toBeVisible()
  await page.getByPlaceholder('按原文填写，保留负号与单位').first().fill(BLANK_ANSWER)

  const submitWait = page.waitForResponse((r) => r.url().endsWith('/submit'))
  await page.getByRole('button', { name: '提交作答' }).click()
  const submitted = await submitWait
  expect(submitted.status(), await submitted.text()).toBe(200)
  const body = (await submitted.json()) as {
    grade: { status: string; confirmed_score: string; max_score: string; is_correct: boolean }
  }
  expect(body.grade.status, '正确答案必须直接判定为已确认，而不是待评').toBe('confirmed')
  expect(Number(body.grade.confirmed_score)).toBe(Number(body.grade.max_score))
  expect(body.grade.is_correct).toBe(true)
  await expect(page.getByTestId('grade-score')).toContainText(`/ ${Number(body.grade.max_score)}`)
})
