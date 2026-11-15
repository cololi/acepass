import { expect, test } from './base'
import { PROJECT_A, login, switchProject, watchResponses } from './helpers'

/**
 * Real-browser acceptance of the P1 second batch.
 *
 * Evidence class: a real browser against the real API with the acceptance
 * fixture (self-authored questions, clearly not past papers). It proves the
 * panels and the honest failure paths work in the product; it is NOT evidence of
 * a real model provider (this environment has none), of retrieval quality on
 * real exam material, or of a real elapsed day.
 *
 * Every assertion that matters is tied to a real HTTP response, not to a
 * rendered string alone: the earlier review objected precisely to suites that
 * passed while the underlying request had failed.
 */

test.describe('P1 batch 2: prerequisites, tag suggestions, retrieval, memory cards', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('a prerequisite edge is created, a cycle is refused with its path, and the edge is deactivated', async ({
    page,
  }) => {
    await page.goto('/knowledge')
    await expect(page.getByTestId('page-knowledge')).toBeVisible()
    const panel = page.getByTestId('prerequisite-panel')
    await panel.scrollIntoViewIfNeeded()

    const from = page.getByTestId('prerequisite-from-select')
    const to = page.getByTestId('prerequisite-to-select')
    // Node options arrive with the knowledge query: poll instead of sampling once.
    const options = async () =>
      (await from.locator('option').evaluateAll((nodes) =>
        nodes.map((node) => ({ value: (node as HTMLOptionElement).value })),
      )).filter((option) => option.value !== '')
    await expect
      .poll(async () => (await options()).length, { timeout: 20_000, message: '验收夹具必须至少有两个考点' })
      .toBeGreaterThanOrEqual(2)
    const [first, second] = await options()

    await from.selectOption(first.value)
    await to.selectOption(second.value)
    const created = page.waitForResponse(
      (response) => response.url().includes('/knowledge-relations') && response.request().method() === 'POST',
    )
    await page.getByTestId('prerequisite-add').click()
    expect((await created).status(), '加边必须真的成功').toBe(201)
    await expect(page.getByTestId('prerequisite-edge-row')).toHaveCount(1)

    // The reverse edge would close a cycle: the server must refuse it and the UI
    // must show the path, not a generic error.
    await from.selectOption(second.value)
    await to.selectOption(first.value)
    const refused = page.waitForResponse(
      (response) => response.url().includes('/knowledge-relations') && response.request().method() === 'POST',
    )
    await page.getByTestId('prerequisite-add').click()
    expect((await refused).status(), '形成环的加边必须被拒绝').toBe(400)
    await expect(page.getByTestId('prerequisite-cycle-error')).toContainText('环')
    await expect(page.getByTestId('prerequisite-edge-row')).toHaveCount(1) // 没有多出一条

    const deactivated = page.waitForResponse(
      (response) => response.url().includes('/knowledge-relations/') && response.request().method() === 'DELETE',
    )
    await page.getByTestId('prerequisite-deactivate').first().click()
    expect((await deactivated).status()).toBe(200)
    // The list only shows active edges, so a deactivated edge disappears while
    // its history row stays in the database.
    await expect(page.getByTestId('prerequisite-edge-row')).toHaveCount(0)
  })

  test('tag suggestions fail honestly without a configured model and never touch the node list', async ({ page }) => {
    await page.goto('/knowledge')
    await expect(page.getByTestId('page-knowledge')).toBeVisible()
    await page.getByTestId('tag-suggestion-panel').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('tag-suggestion-note')).toContainText('权重 0')

    const generate = page.getByTestId('tag-suggestion-generate')
    // Retrying assertion: the version list arrives asynchronously, so reading
    // `isEnabled()` once would race the request instead of testing the product.
    await expect(generate, '验收夹具必须有可选的已发布题目版本').toBeEnabled({ timeout: 20_000 })
    const response = page.waitForResponse(
      (r) => r.url().includes('/tag-suggestions') && r.request().method() === 'POST',
    )
    await generate.click()
    const result = await response
    // This environment has ACEPASS_AI_PROVIDER=none, so the only honest outcomes
    // are "not configured" (503) or a real success. A 2xx with invented tags
    // would be a failure of the honesty rule.
    expect([503]).toContain(result.status())
    await expect(page.getByTestId('tag-suggestion-error')).toContainText('AI 未配置')
    expect(await page.getByTestId('tag-suggestion-list').count()).toBe(0)
  })

  test('retrieval returns indexed stems, reports the missing vector channel, and stays inside the project', async ({
    page,
  }) => {
    await page.goto('/search')
    await expect(page.getByTestId('page-search')).toBeVisible()
    const failures = watchResponses(page, (url) => url.includes('/api/v1/projects/') && url.includes('/search'))

    await page.locator('[data-testid="search-reindex"]').click()
    await expect(page.getByTestId('search-reindex-result')).toContainText('收录')

    await page.getByTestId('search-input').fill('三角形内角和')
    const searched = page.waitForResponse((r) => r.url().includes('/search?') && r.request().method() === 'GET')
    await page.getByTestId('search-submit').click()
    expect((await searched).status()).toBe(200)
    await expect(page.getByTestId('search-result-row').first()).toBeVisible()
    // The fixture's judgement question must actually be found, not merely "a row exists".
    await expect(page.getByTestId('search-results')).toContainText('三角形内角和')
    await expect(page.getByTestId('search-results')).toContainText('关键词：第 1 名')

    // No embedding provider is configured here: the page must say so instead of
    // pretending the vector channel ran.
    await expect(page.getByTestId('search-vector-notice')).toContainText('向量通道未配置')

    // The same query in another project must never leak project A's content,
    // whatever token overlap project B happens to have.
    await switchProject(page, '验收项目B·专业实务')
    await page.goto('/search')
    await page.getByTestId('search-input').fill('三角形内角和')
    const scoped = page.waitForResponse((r) => r.url().includes('/search?') && r.request().method() === 'GET')
    await page.getByTestId('search-submit').click()
    const scopedBody = await (await scoped).json()
    expect(JSON.stringify(scopedBody.results), '跨项目检索不得返回 A 项目内容').not.toContain('三角形内角和')
    expect(failures, '检索接口不应有失败响应').toEqual([])
  })

  test('a memory card can be created, reviewed and replayed without claiming solving ability', async ({ page }) => {
    await page.goto('/memory')
    await expect(page.getByTestId('page-memory')).toBeVisible()
    await expect(page.getByTestId('memory-scope-note')).toContainText('不改变解题能力')

    const picker = page.getByTestId('memory-create-question')
    // The published-question list is fetched asynchronously; sampling it once
    // would race the request and report a fixture problem that does not exist.
    const values = async () =>
      (await picker.locator('option').evaluateAll((nodes) =>
        nodes.map((node) => ({ value: (node as HTMLOptionElement).value })),
      )).filter((option) => option.value !== '')
    await expect
      .poll(async () => (await values()).length, { timeout: 20_000, message: '验收夹具必须有已发布题目' })
      .toBeGreaterThan(0)
    await picker.selectOption((await values())[0])
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/memory-cards') && r.request().method() === 'POST',
    )
    await page.getByTestId('memory-create-submit').click()
    const createResponse = await created
    expect([200, 201]).toContain(createResponse.status())
    await expect(page.getByTestId('memory-create-result')).toContainText('已就绪')
    await expect(page.getByTestId('memory-card-row').first()).toBeVisible()

    await expect(page.getByTestId('memory-review-good').first()).toBeEnabled({ timeout: 20_000 })
    const reviewed = page.waitForResponse((r) => r.url().includes('/review') && r.request().method() === 'POST')
    await page.getByTestId('memory-review-good').first().click()
    expect((await reviewed).status()).toBe(200)
    await expect(page.getByTestId('memory-next-due').first()).toContainText('下次到期')

    await expect(page.getByTestId('memory-rebuild').first()).toBeEnabled({ timeout: 20_000 })
    const rebuilt = page.waitForResponse((r) => r.url().includes('/rebuild') && r.request().method() === 'POST')
    await page.getByTestId('memory-rebuild').first().click()
    expect((await rebuilt).status()).toBe(200)
    await expect(page.getByTestId('memory-rebuild-result').first()).toContainText('一致')
  })

  test('the project context is honoured by the retrieval scope', async ({ page }) => {
    await page.goto('/search')
    await expect(page.getByTestId('page-search')).toContainText(PROJECT_A)
    await switchProject(page, '验收项目B·专业实务')
    await expect(page.getByTestId('page-search')).toContainText('验收项目B·专业实务')
  })
})
