# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fill-editor.spec.ts >> visible fill-blank answers persist in the authoritative answer payload
- Location: ../../../../private/tmp/acepass-p01-independent.EuVSqr/fill-editor.spec.ts:4:5

# Error details

```
Error: 可视答案必须写入正式答案结构，不能只写入题干 content.blanks

expect(received).toEqual(expected) // deep equality

- Expected  - 3
+ Received  + 1

- Array [
-   "5",
- ]
+ Array []
```

# Page snapshot

```yaml
- generic [ref=f1e2]:
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
      - generic [ref=f1e17]: 验收用户
      - button "退出" [ref=f1e18] [cursor=pointer]
    - generic [ref=f1e19]:
      - generic [ref=f1e20]: 当前项目
      - combobox "选择考试项目" [ref=f1e21]:
        - option "验收项目A·基础能力" [selected]
        - option "验收项目B·专业实务"
      - generic [ref=f1e22]: 科目
      - combobox "选择科目" [ref=f1e23]:
        - option "验收科目一·数量关系" [selected]
        - option "验收科目二·判断推理"
        - option "验收新科目-1790499127604"
        - option "验收新科目-1790499143530"
      - generic [ref=f1e24]: 所有页面都在「项目 / 科目」上下文中：题库、评分、报告与辅导不跨项目共享。
    - main [ref=f1e25]:
      - generic [ref=f1e26]:
        - heading "校对候选" [level=1] [ref=f1e27]
        - generic [ref=f1e28]: 任务 7902a000… · 第 2 次修订 · 状态 ready · 填空题
        - button "查看/编辑原始 JSON" [ref=f1e29] [cursor=pointer]
        - button "返回列表" [ref=f1e30] [cursor=pointer]
      - generic [ref=f1e31]:
        - generic [ref=f1e32]:
          - heading "来源对照" [level=2] [ref=f1e33]
          - generic [ref=f1e34]:
            - paragraph [ref=f1e35]: 第 1 页 · 角色 past_paper_page · 区域 (0.00, 0.00, 1.00, 1.00)
            - paragraph [ref=f1e36]: 该区域没有裁图。整页原图可能同时包含答案，因此不会作为练习资源直接下发。
        - generic [ref=f1e37]:
          - heading "结构编辑" [level=2] [ref=f1e38]
          - generic [ref=f1e39]:
            - generic [ref=f1e40]: 题号/标签
            - textbox "题号/标签" [ref=f1e41]: 图片导入
          - generic [ref=f1e42]:
            - generic [ref=f1e43]: 题型
            - combobox "题型" [ref=f1e44]:
              - option "单选题"
              - option "多选题"
              - option "判断题"
              - option "填空题" [selected]
              - option "大题"
              - option "共享材料"
          - generic [ref=f1e45]:
            - generic [ref=f1e46]: 题干文本（第一块）
            - textbox "题干文本（第一块）" [ref=f1e47]:
              - /placeholder: 从原图/原文抄录题干，保留负号、单位与上下标
              - text: 独立验收填空：2 + 3 = ____。
          - generic [ref=f1e48]:
            - generic [ref=f1e49]: 练习分值（留空则采用所选规范的题型默认分值）
            - textbox "练习分值（留空则采用所选规范的题型默认分值）" [ref=f1e50]
          - generic [ref=f1e51]:
            - heading "空位（按出现顺序，ID 为 b1、b2…）" [level=4] [ref=f1e52]
            - generic [ref=f1e53]:
              - generic [ref=f1e54]: b1
              - textbox "空位说明（可选）" [ref=f1e55]: 第 1 空
              - textbox "可接受答案，用 | 分隔" [ref=f1e56]: "5"
              - textbox "满分" [ref=f1e57]: "2"
              - button "删除空位" [ref=f1e58] [cursor=pointer]: ×
            - button "添加空位" [ref=f1e59] [cursor=pointer]
            - paragraph [ref=f1e60]: 没有登记可接受答案的空位在作答后会进入人工复核，不会直接判错；单位与数值规则请在答案 JSON 中补充。
          - generic [ref=f1e61]:
            - generic [ref=f1e62]: 答案 JSON（必须与题型匹配，且由你本人核对）
            - textbox "答案 JSON（必须与题型匹配，且由你本人核对）" [ref=f1e63]: "{ \"blanks\": { \"b1\": { \"accepted_values\": [], \"mismatch_policy\": \"review\" } } }"
          - paragraph [ref=f1e64]: "单个正确选项：{\"kind\": \"single_choice\", \"correct_option_id\": \"opt_a\"}；判断题用布尔值；填空题按 blank_id 给出 accepted_values 或 numeric 规则。"
          - button "保存校对" [ref=f1e66] [cursor=pointer]
      - generic [ref=f1e67]:
        - heading "发布" [level=2] [ref=f1e68]
        - paragraph [ref=f1e69]: 发布会在同一事务中创建题目身份、不可变版本、答案与 rubric，并写入审计。已发布内容不能原地修改，只能新建版本。
        - generic [ref=f1e70]:
          - generic [ref=f1e71]: 考点映射（主要考点权重之和必须为 1；多个考点将平均分配权重）
          - listbox "考点映射（主要考点权重之和必须为 1；多个考点将平均分配权重）" [ref=f1e72]:
            - option "验收考点一" [ref=f1e73]
            - option "验收考点二" [ref=f1e74]
            - option "验收考点三" [ref=f1e75]
        - paragraph [ref=f1e76]: 将使用已发布规范：验收规范 v1
        - button "发布题目版本" [ref=f1e78] [cursor=pointer]
      - generic [ref=f1e79]:
        - heading "解析预览（发布后学员看到的题干）" [level=2] [ref=f1e80]
        - paragraph [ref=f1e82]: 独立验收填空：2 + 3 = ____。
        - list [ref=f1e83]:
          - listitem [ref=f1e84]: b1：第 1 空（2 分）
  - generic [ref=f1e85]: 图片已作为私有来源保存，请在校对页对照原图录入结构
  - generic [ref=f1e86]: 校对已保存（保留修订记录）
```

# Test source

```ts
  1  | import { test, expect } from '/Users/cololi/Documents/AcePass/frontend/node_modules/@playwright/test'
  2  | import { login, switchProject, switchSubject, PROJECT_A } from '/Users/cololi/Documents/AcePass/frontend/tests/acceptance/helpers'
  3  | 
  4  | test('visible fill-blank answers persist in the authoritative answer payload', async ({ page }) => {
  5  |   await login(page)
  6  |   await switchProject(page, PROJECT_A)
  7  |   await switchSubject(page, '验收科目一·数量关系')
  8  |   await page.goto('/imports')
  9  |   await expect(page.getByRole('heading', { name: '导入与校对', exact: true })).toBeVisible()
  10 |   const uploadWait = page.waitForResponse(r => r.url().endsWith('/imports/images') && r.request().method() === 'POST')
  11 |   await page.locator('input[type="file"]').setInputFiles('/tmp/acepass-ui-audit-20260927/fill-source.png')
  12 |   const upload = await uploadWait
  13 |   expect(upload.status(), await upload.text()).toBe(201)
  14 |   await page.getByRole('link', { name: '校对/编辑', exact: true }).click()
  15 |   await expect(page.getByTestId('question-type-select')).toBeVisible()
  16 |   await page.getByTestId('question-type-select').selectOption('fill_blank')
  17 |   await page.getByTestId('stem-input').fill('独立验收填空：2 + 3 = ____。')
  18 |   await page.getByTestId('add-blank').click()
  19 |   await page.getByPlaceholder('可接受答案，用 | 分隔').first().fill('5')
  20 |   await page.getByPlaceholder('满分', { exact: true }).first().fill('2')
  21 |   const savedWait = page.waitForResponse(r => /\/import-candidates\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === 'PATCH')
  22 |   await page.getByTestId('save-candidate').click()
  23 |   const saved = await savedWait
  24 |   expect(saved.status(), await saved.text()).toBe(200)
  25 |   const body = await saved.json()
  26 |   console.log('persisted candidate', JSON.stringify({content:body.draft_payload.content,answer_payload:body.draft_payload.answer_payload}))
> 27 |   expect(body.draft_payload.answer_payload.blanks.b1.accepted_values, '可视答案必须写入正式答案结构，不能只写入题干 content.blanks').toEqual(['5'])
     |                                                                                                                ^ Error: 可视答案必须写入正式答案结构，不能只写入题干 content.blanks
  28 | })
  29 | 
```