/**
 * Render audit for the migrated Web client.
 *
 * Boots nothing by itself: point it at a running DSH Web instance with the plugin installed
 * (`DSH_URL=http://127.0.0.1:PORT/?token=... node scripts/page-audit.mjs`). For every AcePass route
 * it records whether the panel painted, which logical endpoints the page called, and every
 * console/page error. That is how a route that silently stopped mounting (missing import, provider
 * misorder) is caught without asserting on copy that will change.
 */
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), '../frontend/package.json'))
const { chromium } = require('@playwright/test')

const base = process.env.DSH_URL
if (!base) {
  console.error('DSH_URL is required (the authenticated URL printed by `dsh web`)')
  process.exit(2)
}
const routes = [
  ['/', '项目'],
  ['/today', '今日学习'],
  ['/practice', '刷题'],
  ['/questions', '题库'],
  ['/imports', '导入'],
  ['/knowledge', '考点地图'],
  ['/search', '检索'],
  ['/review', '错题与复习'],
  ['/memory', '记忆卡'],
  ['/grading', '人工评分'],
  ['/reports', '报告'],
  ['/settings', '设置'],
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const calls = []
page.on('response', async (response) => {
  const url = new URL(response.url())
  if (url.pathname !== '/api/acepass/rpc') return
  let logical = '?'
  try {
    const payload = JSON.parse(response.request().postData() ?? '{}')
    logical = `${payload.method} ${payload.path}`
  } catch { /* body unavailable */ }
  let status = response.status()
  try {
    // The carrier always answers 200 for a dispatched call; the logical status is in the envelope.
    const envelope = await response.json()
    if (typeof envelope.status === 'number') status = envelope.status
  } catch { /* malformed envelope: keep the transport status */ }
  calls.push({ logical, status })
})
const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 400))
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 400)}`))

async function dismissDialogs() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const dialog = page.locator('[role="dialog"]').first()
    if ((await dialog.count()) === 0) return
    const close = dialog.getByRole('button', { name: 'Close' })
    const cont = dialog.getByRole('button', { name: /Continue|继续/ })
    if ((await close.count()) > 0) await close.first().click({ force: true }).catch(() => {})
    else if ((await cont.count()) > 0) await cont.first().click({ force: true }).catch(() => {})
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
}

await page.goto(base)
await page.waitForTimeout(4000)
await dismissDialogs()
await page.getByText('AcePass', { exact: true }).first().click({ force: true })
await page.waitForTimeout(1500)
// Select a project when the fixture provides one: pages that need scope otherwise short-circuit
// with "请先选择项目", which would hide a broken request behind a legitimate empty state.
const projectSelect = page.getByLabel('选择考试项目')
const options = await projectSelect.locator('option').allTextContents().catch(() => [])
const firstProject = options.find((label) => !label.startsWith('（'))
if (firstProject !== undefined) {
  await projectSelect.selectOption({ label: firstProject }).catch(() => {})
  await page.waitForTimeout(1200)
  console.log(`project selected: ${firstProject}`)
} else {
  console.log('project selected: (none in fixture)')
}

const results = []
for (const [route, name] of routes) {
  calls.length = 0
  errors.length = 0
  await page.evaluate((next) => { window.location.hash = `#${next}` }, route)
  await page.waitForTimeout(1500)
  const panel = page.locator('.acepass-root, [data-acepass="panel"]')
  const boundary = page.locator('[data-acepass="error"]')
  const text = (await page.locator('body').innerText()).slice(0, 3000)
  results.push({
    route,
    name,
    mounted: (await panel.count()) > 0 || text.includes(name),
    boundary: (await boundary.count()) > 0 ? await boundary.first().innerText() : null,
    rendered: text.includes(name),
    calls: [...calls],
    failedCalls: calls.filter((call) => call.status >= 400),
    errors: [...new Set(errors)].slice(0, 5),
  })
  await page.screenshot({ path: `/tmp/acepass-audit${route.replaceAll('/', '-') || '-home'}.png` })
}

mkdirSync('var/audit', { recursive: true })
writeFileSync('var/audit/pages.json', JSON.stringify({ url: base, results }, null, 2))
for (const result of results) {
  console.log(
    `${result.route.padEnd(11)} mounted=${result.mounted ? 'yes' : 'no '} calls=${result.calls.length} failed=${result.failedCalls.length} errors=${result.errors.length}`,
  )
  if (result.boundary) console.log(`  boundary: ${result.boundary.slice(0, 160)}`)
  for (const call of result.failedCalls.slice(0, 6)) console.log(`  ${call.status} ${call.logical}`)
  for (const error of result.errors.slice(0, 3)) console.log(`  ! ${error.slice(0, 200)}`)
}
await browser.close()
