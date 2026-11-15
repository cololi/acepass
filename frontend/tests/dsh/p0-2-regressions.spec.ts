/**
 * P0.2 browser regressions (B06).
 *
 * These are the two failing browser counter-examples from
 * `docs/review/2026-09-27/p01-independent/` migrated into the normal acceptance
 * suite. They are real-browser cases on purpose: both defects were invisible to
 * the API suite because the client was dropping user input the server never saw.
 *
 * 1. an uploaded answer photo must survive a refresh as part of the draft;
 * 2. an answer typed in the visible fill-blank editor must reach the
 *    authoritative `answer_payload`, not only the stem's `content.blanks`.
 */
import { expect, test } from './base'
import zlib from 'node:zlib'
import { PROJECT_A, login, openWorkbench, switchProject, switchSubject } from './helpers'

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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff)
  for (let row = 0; row < height; row += 1) raw[row * (1 + width * 3)] = 0 // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test.describe('p0.2: drafts keep every kind of user input', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('an unsubmitted answer photo survives a refresh', async ({ page }) => {
    await openWorkbench(page, '大题')
    await page.getByPlaceholder('写下你的推导过程与结论').fill('独立复验：未提交照片草稿。')
    const responsePromise = page.waitForResponse((r) => r.url().endsWith('/assets'))
    await page.locator('.workbench input[type="file"]').setInputFiles({
      name: 'draft-photo.png',
      mimeType: 'image/png',
      buffer: makePng(8, 8),
    })
    const response = await responsePromise
    expect(response.status(), await response.text()).toBe(201)
    await expect(page.getByTestId('attachment-editor').locator('img')).toHaveCount(1)
    // The photo is only safe once the draft that carries it has been stored.
    await expect(page.getByText('已保存', { exact: false }).first()).toBeVisible()

    await page.reload()
    await expect(page.getByPlaceholder('写下你的推导过程与结论')).toHaveValue('独立复验：未提交照片草稿。')
    await expect(
      page.getByTestId('attachment-editor').locator('img'),
      '刷新后必须恢复草稿里的作答照片，而不是清空',
    ).toHaveCount(1)
  })

  test('the visible fill-blank answer reaches the authoritative answer payload', async ({ page }) => {
    await switchProject(page, PROJECT_A)
    await switchSubject(page, '验收科目一·数量关系')
    await page.goto('/imports')
    await expect(page.getByRole('heading', { name: '导入与校对', exact: true })).toBeVisible()
    const uploadWait = page.waitForResponse((r) => r.url().endsWith('/imports/images') && r.request().method() === 'POST')
    await page.getByTestId('image-import-input').setInputFiles({
      name: 'fill-source.png',
      mimeType: 'image/png',
      buffer: makePng(24, 24),
    })
    const upload = await uploadWait
    expect(upload.status(), await upload.text()).toBe(201)
    await page.getByRole('link', { name: '校对/编辑', exact: true }).click()
    await expect(page.getByTestId('question-type-select')).toBeVisible()
    await page.getByTestId('question-type-select').selectOption('fill_blank')
    await page.getByTestId('stem-input').fill('独立验收填空：2 + 3 = ____。')
    await page.getByTestId('add-blank').click()
    await page.getByPlaceholder('可接受答案，用 | 分隔').first().fill('5')
    await page.getByPlaceholder('满分', { exact: true }).first().fill('2')
    const savedWait = page.waitForResponse(
      (r) => /\/import-candidates\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === 'PATCH',
    )
    await page.getByTestId('save-candidate').click()
    const saved = await savedWait
    expect(saved.status(), await saved.text()).toBe(200)
    const body = (await saved.json()) as {
      draft_payload: { answer_payload: { blanks: Record<string, { accepted_values: string[]; max_score?: string }> } }
    }
    expect(
      body.draft_payload.answer_payload.blanks.b1.accepted_values,
      '可视答案必须写入正式答案结构，不能只写入题干 content.blanks',
    ).toEqual(['5'])
    expect(body.draft_payload.answer_payload.blanks.b1.max_score).toBe('2')
  })
})
