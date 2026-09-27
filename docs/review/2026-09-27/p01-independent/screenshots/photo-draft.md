# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: draft-regression.spec.ts >> unsubmitted photo draft survives refresh
- Location: ../../../../private/tmp/acepass-p01-independent.EuVSqr/draft-regression.spec.ts:4:5

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByTestId('attachment-editor').locator('img')
Expected: 1
Received: 0
Timeout:  4000ms

Call log:
  - Expect "toHaveCount" getByTestId('attachment-editor').locator('img') with timeout 4000ms
  - waiting for getByTestId('attachment-editor').locator('img')
    12 × locator resolved to 0 elements
       - unexpected value "0"

```

# Page snapshot

```yaml
- generic [ref=f2e3]:
  - banner [ref=f2e4]:
    - generic [ref=f2e5]: AcePass
    - button "菜单" [ref=f2e6] [cursor=pointer]
    - navigation [ref=f2e7]:
      - link "项目" [ref=f2e8] [cursor=pointer]:
        - /url: /
      - link "今日学习" [ref=f2e9] [cursor=pointer]:
        - /url: /today
      - link "刷题" [ref=f2e10] [cursor=pointer]:
        - /url: /practice
      - link "题库与导入" [ref=f2e11] [cursor=pointer]:
        - /url: /questions
      - link "考点地图" [ref=f2e12] [cursor=pointer]:
        - /url: /knowledge
      - link "错题与复习" [ref=f2e13] [cursor=pointer]:
        - /url: /review
      - link "人工评分" [ref=f2e14] [cursor=pointer]:
        - /url: /grading
      - link "报告" [ref=f2e15] [cursor=pointer]:
        - /url: /reports
      - link "设置" [ref=f2e16] [cursor=pointer]:
        - /url: /settings
    - generic [ref=f2e17]: 验收用户
    - button "退出" [ref=f2e18] [cursor=pointer]
  - generic [ref=f2e19]:
    - generic [ref=f2e20]: 当前项目
    - combobox "选择考试项目" [ref=f2e21]:
      - option "验收项目A·基础能力" [selected]
      - option "验收项目B·专业实务"
    - generic [ref=f2e22]: 科目
    - combobox "选择科目" [ref=f2e23]:
      - option "验收科目一·数量关系" [selected]
      - option "验收科目二·判断推理"
      - option "验收新科目-1790499127604"
      - option "验收新科目-1790499143530"
    - generic [ref=f2e24]: 所有页面都在「项目 / 科目」上下文中：题库、评分、报告与辅导不跨项目共享。
  - main [ref=f2e25]:
    - generic [ref=f2e26]:
      - heading "刷题工作台" [level=1] [ref=f2e27]
      - generic [ref=f2e28]: 验收项目A·基础能力 · 验收科目一·数量关系 · 练习模式 · 已完成 0/1
      - generic [ref=f2e29]: 已确认 0 分 · 待评 0 分
      - button "结束会话" [ref=f2e30] [cursor=pointer]
    - button "1" [ref=f2e33] [cursor=pointer]
    - generic [ref=f2e34]:
      - generic [ref=f2e35]:
        - generic [ref=f2e36]:
          - generic [ref=f2e37]: 大题
          - generic [ref=f2e38]: 本题满分 10.00 · 第 1 题
        - paragraph [ref=f2e40]: 验收大题：一箱有 5 袋，每袋 4 个，共多少个？请写出完整推导过程并给出结论。
        - generic [ref=f2e41]:
          - generic [ref=f2e42]:
            - generic [ref=f2e43]: 解答过程（可写步骤，提交后不可修改）
            - textbox "解答过程（可写步骤，提交后不可修改）" [ref=f2e44]:
              - /placeholder: 写下你的推导过程与结论
              - text: 独立复验：未提交照片草稿。
          - generic [ref=f2e45]:
            - generic [ref=f2e46]:
              - generic [ref=f2e47]: 作答照片（0/6）：提交后按追加保存，不能替换或删除
              - generic [ref=f2e48] [cursor=pointer]: 添加照片
            - paragraph [ref=f2e49]: 还没有照片。大题可以只写文字，也可以传照片；人工评分时会对照原图。
          - paragraph [ref=f2e50]: 大题在 P0 逐评分点人工确认，不会自动给分；未确认前保持待评，不记 0 分。
        - generic [ref=f2e51]:
          - generic [ref=f2e52]: 草稿：已保存
          - generic [ref=f2e53]:
            - button "查看答案与解析（会记录辅助暴露）" [ref=f2e54] [cursor=pointer]
            - button "提交作答" [ref=f2e55] [cursor=pointer]
      - generic [ref=f2e56]:
        - heading "按需辅导" [level=2] [ref=f2e57]
        - paragraph [ref=f2e58]: 提示与完整讲解由服务端记录暴露；讲解不会写入分数或掌握状态。
        - generic [ref=f2e59]:
          - button "只看提示" [ref=f2e60] [cursor=pointer]
          - button "完整讲解" [ref=f2e61] [cursor=pointer]
```

# Test source

```ts
  1  | import {test, expect} from "/Users/cololi/Documents/AcePass/frontend/node_modules/@playwright/test"
  2  | import {login, openWorkbench} from "/Users/cololi/Documents/AcePass/frontend/tests/acceptance/helpers"
  3  | import zlib from 'node:zlib'
  4  | test('unsubmitted photo draft survives refresh', async ({page}) => {
  5  |   await login(page)
  6  |   await openWorkbench(page, '大题')
  7  |   await page.getByPlaceholder('写下你的推导过程与结论').fill('独立复验：未提交照片草稿。')
  8  |   const responsePromise = page.waitForResponse(r => r.url().endsWith('/assets'))
  9  |   await page.locator('.workbench input[type="file"]').setInputFiles({name:'draft-photo.png',mimeType:'image/png',buffer:makePng(8,8)})
  10 |   const response = await responsePromise
  11 |   expect(response.status()).toBe(201)
  12 |   await expect(page.getByTestId('attachment-editor').locator('img')).toHaveCount(1)
  13 |   await expect(page.getByText('已保存', {exact:false}).first()).toBeVisible()
  14 |   await page.reload()
  15 |   await expect(page.getByPlaceholder('写下你的推导过程与结论')).toHaveValue('独立复验：未提交照片草稿。')
  16 |   console.log('PHOTO_COUNT_AFTER_RELOAD',await page.getByTestId('attachment-editor').locator('img').count())
> 17 |   await expect(page.getByTestId('attachment-editor').locator('img')).toHaveCount(1)
     |                                                                      ^ Error: expect(locator).toHaveCount(expected) failed
  18 | })
  19 | function makePng(width: number, height: number): Buffer {
  20 |   const crcTable: number[] = []
  21 |   for (let n = 0; n < 256; n += 1) {
  22 |     let c = n
  23 |     for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  24 |     crcTable[n] = c >>> 0
  25 |   }
  26 |   const crc32 = (buf: Buffer) => {
  27 |     let c = 0xffffffff
  28 |     for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  29 |     return (c ^ 0xffffffff) >>> 0
  30 |   }
  31 |   const chunk = (type: string, data: Buffer) => {
  32 |     const length = Buffer.alloc(4)
  33 |     length.writeUInt32BE(data.length, 0)
  34 |     const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  35 |     const crc = Buffer.alloc(4)
  36 |     crc.writeUInt32BE(crc32(body), 0)
  37 |     return Buffer.concat([length, body, crc])
  38 |   }
  39 |   const ihdr = Buffer.alloc(13)
  40 |   ihdr.writeUInt32BE(width, 0)
  41 |   ihdr.writeUInt32BE(height, 4)
  42 |   ihdr[8] = 8 // bit depth
  43 |   ihdr[9] = 2 // truecolour
  44 |   const raw = Buffer.alloc(height * (1 + width * 3), 0xff)
  45 |   for (let row = 0; row < height; row += 1) raw[row * (1 + width * 3)] = 0 // filter: none
  46 |   return Buffer.concat([
  47 |     Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  48 |     chunk('IHDR', ihdr),
  49 |     chunk('IDAT', zlib.deflateSync(raw)),
  50 |     chunk('IEND', Buffer.alloc(0)),
  51 |   ])
  52 | }
  53 | 
```