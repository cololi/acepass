# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ui-regressions.spec.ts >> constructed response provides photo attachment input
- Location: docs/review/2026-09-27/ui-regressions.spec.ts:34:5

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  locator('.workbench input[type="file"]')
Expected: 1
Received: 0
Timeout:  3000ms

Call log:
  - Expect "toHaveCount" locator('.workbench input[type="file"]') with timeout 3000ms
  - waiting for locator('.workbench input[type="file"]')
    10 × locator resolved to 0 elements
       - unexpected value "0"

```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - banner [ref=f1e4]:
    - generic [ref=f1e5]: AcePass
    - button "菜单" [ref=f1e6] [cursor=pointer]
    - navigation [ref=f1e7]:
      - link "项目" [ref=f1e8] [cursor=pointer]:
        - /url: /
      - link "今日学习" [ref=f1e9] [cursor=pointer]:
        - /url: /today
      - link "刷题" [ref=f1e10] [cursor=pointer]:
        - /url: /practice
      - link "题库与导入" [ref=f1e11] [cursor=pointer]:
        - /url: /questions
      - link "考点地图" [ref=f1e12] [cursor=pointer]:
        - /url: /knowledge
      - link "错题与复习" [ref=f1e13] [cursor=pointer]:
        - /url: /review
      - link "人工评分" [ref=f1e14] [cursor=pointer]:
        - /url: /grading
      - link "报告" [ref=f1e15] [cursor=pointer]:
        - /url: /reports
      - link "设置" [ref=f1e16] [cursor=pointer]:
        - /url: /settings
    - generic [ref=f1e17]: 浏览器验收
    - button "退出" [ref=f1e18] [cursor=pointer]
  - generic [ref=f1e19]:
    - generic [ref=f1e20]: 当前项目
    - combobox "选择考试项目" [ref=f1e21]:
      - option "演示项目A·综合能力" [selected]
      - option "演示项目B·专业实务"
    - generic [ref=f1e22]: 科目
    - combobox "选择科目" [ref=f1e23]:
      - option "演示科目A1·数量关系" [selected]
      - option "演示科目A2·判断推理"
    - generic [ref=f1e24]: 所有页面都在「项目 / 科目」上下文中：题库、评分、报告与辅导不跨项目共享。
  - main [ref=f1e25]:
    - generic [ref=f1e26]:
      - heading "刷题工作台" [level=1] [ref=f1e27]
      - generic [ref=f1e28]: 演示项目A·综合能力 · 演示科目A1·数量关系 · 练习模式 · 已完成 0/1
      - generic [ref=f1e29]: 已确认 0 分 · 待评 0 分
      - button "结束会话" [ref=f1e30] [cursor=pointer]
    - button "1" [ref=f1e33] [cursor=pointer]
    - generic [ref=f1e34]:
      - generic [ref=f1e35]:
        - generic [ref=f1e36]:
          - generic [ref=f1e37]: 大题
          - generic [ref=f1e38]: 本题满分 7.00 · 第 1 题
        - generic [ref=f1e39]:
          - heading "共享材料" [level=3] [ref=f1e40]
          - paragraph [ref=f1e42]: 共享材料（演示）：下面是一段用于两道子题的材料，父子题分值 3 + 7。
        - paragraph [ref=f1e44]: 子题2（7 分）：结合材料写出你的分析过程。
        - generic [ref=f1e45]:
          - generic [ref=f1e46]:
            - generic [ref=f1e47]: 解答过程（可写步骤，提交后不可修改）
            - textbox "解答过程（可写步骤，提交后不可修改）" [ref=f1e48]:
              - /placeholder: 写下你的推导过程与结论
          - paragraph [ref=f1e49]: 大题在 P0 逐评分点人工确认，不会自动给分；未确认前保持待评，不记 0 分。
        - generic [ref=f1e50]:
          - generic [ref=f1e51]: 草稿：已保存
          - generic [ref=f1e52]:
            - button "查看答案与解析（会记录辅助暴露）" [ref=f1e53] [cursor=pointer]
            - button "提交作答" [ref=f1e54] [cursor=pointer]
      - generic [ref=f1e55]:
        - heading "按需辅导" [level=2] [ref=f1e56]
        - paragraph [ref=f1e57]: 提示与完整讲解由服务端记录暴露；讲解不会写入分数或掌握状态。
        - generic [ref=f1e58]:
          - button "只看提示" [ref=f1e59] [cursor=pointer]
          - button "完整讲解" [ref=f1e60] [cursor=pointer]
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
  31 |   expect(response.status()).toBe(200)
  32 | })
  33 | 
  34 | test('constructed response provides photo attachment input', async ({page}) => {
  35 |   await start(page,'大题')
> 36 |   await expect(page.locator('.workbench input[type="file"]')).toHaveCount(1)
     |                                                               ^ Error: expect(locator).toHaveCount(expected) failed
  37 | })
  38 | 
```