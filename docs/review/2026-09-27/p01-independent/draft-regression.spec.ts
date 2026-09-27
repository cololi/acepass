import {test, expect} from "../../../../frontend/node_modules/@playwright/test"
import {login, openWorkbench} from "../../../../frontend/tests/acceptance/helpers"
import zlib from 'node:zlib'
test('unsubmitted photo draft survives refresh', async ({page}) => {
  await login(page)
  await openWorkbench(page, '大题')
  await page.getByPlaceholder('写下你的推导过程与结论').fill('独立复验：未提交照片草稿。')
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/assets'))
  await page.locator('.workbench input[type="file"]').setInputFiles({name:'draft-photo.png',mimeType:'image/png',buffer:makePng(8,8)})
  const response = await responsePromise
  expect(response.status()).toBe(201)
  await expect(page.getByTestId('attachment-editor').locator('img')).toHaveCount(1)
  await expect(page.getByText('已保存', {exact:false}).first()).toBeVisible()
  await page.reload()
  await expect(page.getByPlaceholder('写下你的推导过程与结论')).toHaveValue('独立复验：未提交照片草稿。')
  console.log('PHOTO_COUNT_AFTER_RELOAD',await page.getByTestId('attachment-editor').locator('img').count())
  await expect(page.getByTestId('attachment-editor').locator('img')).toHaveCount(1)
})
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
