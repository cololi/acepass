# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ui-regressions.spec.ts >> answer reveal survives reloading a submitted item
- Location: docs/review/2026-09-27/ui-regressions.spec.ts:20:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 422
```

# Page snapshot

```yaml
- generic [ref=f2e2]:
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
      - generic [ref=f2e17]: 浏览器验收
      - button "退出" [ref=f2e18] [cursor=pointer]
    - generic [ref=f2e19]:
      - generic [ref=f2e20]: 当前项目
      - combobox "选择考试项目" [ref=f2e21]:
        - option "演示项目A·综合能力" [selected]
        - option "演示项目B·专业实务"
      - generic [ref=f2e22]: 科目
      - combobox "选择科目" [ref=f2e23]:
        - option "演示科目A1·数量关系" [selected]
        - option "演示科目A2·判断推理"
      - generic [ref=f2e24]: 所有页面都在「项目 / 科目」上下文中：题库、评分、报告与辅导不跨项目共享。
    - main [ref=f2e25]:
      - generic [ref=f2e26]:
        - heading "刷题工作台" [level=1] [ref=f2e27]
        - generic [ref=f2e28]: 演示项目A·综合能力 · 演示科目A1·数量关系 · 练习模式 · 已完成 1/1
        - generic [ref=f2e29]: 已确认 3.00 分 · 待评 0.00 分
        - button "结束会话" [ref=f2e30] [cursor=pointer]
      - button "1✓" [ref=f2e33] [cursor=pointer]
      - generic [ref=f2e34]:
        - generic [ref=f2e35]:
          - heading "A1-材料-1-子1（已提交）" [level=2] [ref=f2e36]
          - generic [ref=f2e37]: 单选题
        - paragraph [ref=f2e38]: 提交时间 2026/9/27 00:12:05，用时 0 秒。
        - generic [ref=f2e39]:
          - generic [ref=f2e40]:
            - strong [ref=f2e41]: 已确认 · 确定性判分
            - generic [ref=f2e42]: 3.00 / 3.00
          - generic [ref=f2e43]:
            - generic [ref=f2e44]: choice · correct
            - generic [ref=f2e45]: 3.00 / 3.00
        - button "查看答案与解析" [active] [ref=f2e47] [cursor=pointer]
  - generic [ref=f2e48]: 结构校验失败（["“undefined”不是一个有效的UUID"]）
```

# Test source

```ts
  1  | // Run only against an isolated acceptance database; never use the default dev globalSetup.
  2  | import { test, expect } from '../../../frontend/node_modules/@playwright/test'
  3  | import { login } from '../../../frontend/tests/e2e/helpers'
  4  | 
  5  | test.beforeEach(async ({ page }) => { await login(page) })
  6  | async function start(page: any, label: string) {
  7  |   await page.goto('/questions')
  8  |   await page.locator('table.data tbody tr', {hasText: label}).first().getByRole('button', {name:'开始练习'}).click()
  9  |   await expect(page.getByRole('heading',{name:'刷题工作台'})).toBeVisible()
  10 | }
  11 | 
  12 | test('submitted practice still exposes tutoring entry', async ({page}) => {
  13 |   await start(page,'单选')
  14 |   await page.locator('.option').first().click()
  15 |   await page.getByRole('button',{name:'提交作答'}).click()
  16 |   await expect(page.getByText('提交时间',{exact:false}).first()).toBeVisible()
  17 |   await expect(page.getByRole('button',{name:'完整讲解',exact:true})).toBeVisible()
  18 | })
  19 | 
  20 | test('answer reveal survives reloading a submitted item', async ({page}) => {
  21 |   await start(page,'单选')
  22 |   await page.locator('.option').first().click()
  23 |   await page.getByRole('button',{name:'提交作答'}).click()
  24 |   await expect(page.getByText('提交时间',{exact:false}).first()).toBeVisible()
  25 |   await page.reload()
  26 |   await expect(page.getByText('提交时间',{exact:false}).first()).toBeVisible()
  27 |   const responsePromise=page.waitForResponse(r=>r.url().endsWith('/reveal'))
  28 |   await page.getByRole('button',{name:'查看答案与解析',exact:true}).click()
  29 |   const response=await responsePromise
  30 |   console.log('REVEAL_AFTER_RELOAD',response.url(),response.status())
> 31 |   expect(response.status()).toBe(200)
     |                             ^ Error: expect(received).toBe(expected) // Object.is equality
  32 | })
  33 | 
  34 | test('constructed response provides photo attachment input', async ({page}) => {
  35 |   await start(page,'大题')
  36 |   await expect(page.locator('.workbench input[type="file"]')).toHaveCount(1)
  37 | })
  38 | 
```