# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ui-regressions.spec.ts >> submitted practice still exposes tutoring entry
- Location: docs/review/2026-09-27/ui-regressions.spec.ts:12:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: '完整讲解', exact: true })
Expected: visible
Timeout: 3000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('button', { name: '完整讲解', exact: true }) with timeout 3000ms
  - waiting for getByRole('button', { name: '完整讲解', exact: true })

```

```yaml
- banner:
  - text: AcePass
  - button "菜单"
  - navigation:
    - link "项目":
      - /url: /
    - link "今日学习":
      - /url: /today
    - link "刷题":
      - /url: /practice
    - link "题库与导入":
      - /url: /questions
    - link "考点地图":
      - /url: /knowledge
    - link "错题与复习":
      - /url: /review
    - link "人工评分":
      - /url: /grading
    - link "报告":
      - /url: /reports
    - link "设置":
      - /url: /settings
  - text: 浏览器验收
  - button "退出"
- text: 当前项目
- combobox "选择考试项目":
  - option "演示项目A·综合能力" [selected]
  - option "演示项目B·专业实务"
- text: 科目
- combobox "选择科目":
  - option "演示科目A1·数量关系" [selected]
  - option "演示科目A2·判断推理"
- text: 所有页面都在「项目 / 科目」上下文中：题库、评分、报告与辅导不跨项目共享。
- main:
  - heading "刷题工作台" [level=1]
  - text: 演示项目A·综合能力 · 演示科目A1·数量关系 · 练习模式 · 已完成 1/1 已确认 3.00 分 · 待评 0.00 分
  - button "结束会话"
  - button "1✓"
  - heading "A1-材料-1-子1（已提交）" [level=2]
  - text: 单选题
  - paragraph: 提交时间 2026/9/27 00:12:01，用时 0 秒。
  - strong: 已确认 · 确定性判分
  - text: 3.00 / 3.00 choice · correct 3.00 / 3.00
  - button "查看答案与解析"
- text: 已提交（提交后不可修改，如需重做请新建题项）
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
> 17 |   await expect(page.getByRole('button',{name:'完整讲解',exact:true})).toBeVisible()
     |                                                                   ^ Error: expect(locator).toBeVisible() failed
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
  36 |   await expect(page.locator('.workbench input[type="file"]')).toHaveCount(1)
  37 | })
  38 | 
```