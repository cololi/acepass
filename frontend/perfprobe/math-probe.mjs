/**
 * W3 real-browser probe for the on-demand KaTeX path.
 *
 * The acceptance fixture contains no maths blocks, so the browser suite cannot
 * show that `await import('katex')` still renders a formula. This probe drives
 * perfprobe/math-harness (which imports the real src/components/Content.tsx) in
 * Chromium, twice: once on the Vite dev server (the mode the acceptance suite
 * runs) and once on a production build + `vite preview` (the shipped path).
 *
 * It asserts, in both modes:
 *   - nothing matching /katex/i is requested while the page only loads;
 *   - after the formula is rendered the renderer arrives on demand and KaTeX
 *     markup appears;
 *   - the KaTeX stylesheet was applied (computed font-family is KaTeX_Main),
 *     i.e. the formula is not painted unstyled.
 *
 * Usage: node perfprobe/math-probe.mjs     (expects to hold no other port use)
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const PORT = 5199
const VITE = path.join(frontend, 'node_modules', 'vite', 'bin', 'vite.js')
const CONFIG = path.join(here, 'math-harness', 'vite.config.mts')
const URL_BASE = `http://127.0.0.1:${PORT}/`

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VITE, ...args], { cwd: frontend, stdio: 'inherit', ...options })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite ${args[0]} exited ${code}`))))
  })
}

function start(args) {
  const child = spawn(process.execPath, [VITE, ...args], { cwd: frontend, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))
  return { child, log }
}

async function waitForServer(child, log) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log.join('')}`)
    try {
      const response = await fetch(URL_BASE)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`server did not answer on ${URL_BASE}`)
}

async function probe(mode) {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const katexRequests = []
  page.on('request', (request) => {
    if (/katex/i.test(request.url())) katexRequests.push(request.url())
  })

  await page.goto(URL_BASE, { waitUntil: 'load' })
  await page.waitForSelector('#ready')

  const requestsOnLoad = katexRequests.length
  await page.click('#show-math')
  await page.waitForSelector('.math .katex', { timeout: 20_000 })

  const rendered = await page.evaluate(() => {
    const node = document.querySelector('.math .katex')
    return {
      fontFamily: node ? getComputedStyle(node).fontFamily : '',
      text: node ? (node.textContent ?? '') : '',
      height: node ? node.getBoundingClientRect().height : 0,
    }
  })
  const requestsAfterRender = katexRequests.length
  await browser.close()

  const failures = []
  if (requestsOnLoad !== 0) failures.push(`KaTeX was fetched before any formula existed: ${katexRequests[0]}`)
  if (requestsAfterRender === 0) failures.push('rendering a formula did not fetch KaTeX at all')
  if (!rendered.fontFamily.includes('KaTeX_Main')) {
    failures.push(`KaTeX stylesheet not applied (font-family=${rendered.fontFamily || '<empty>'})`)
  }
  if (!rendered.text.includes('1') || !rendered.text.includes('2')) {
    failures.push(`fraction did not render (text=${JSON.stringify(rendered.text)})`)
  }
  if (!(rendered.height > 0)) failures.push('rendered formula has zero height')

  return { mode, requestsOnLoad, requestsAfterRender, rendered, failures, katexRequests }
}

const results = []
for (const mode of ['dev', 'preview']) {
  if (mode === 'preview') await run(['build', '--config', CONFIG])
  const server = start(mode === 'dev' ? ['--config', CONFIG] : ['preview', '--config', CONFIG])
  try {
    await waitForServer(server.child, server.log)
    results.push(await probe(mode))
  } finally {
    server.child.kill('SIGTERM')
    await sleep(500)
  }
}

let failed = false
for (const result of results) {
  const ok = result.failures.length === 0
  failed ||= !ok
  console.log(
    `${ok ? 'PASS' : 'FAIL'} [${result.mode}] katex requests: on load=${result.requestsOnLoad}, ` +
      `after rendering a formula=${result.requestsAfterRender}; font=${result.rendered.fontFamily.split(',')[0]}; ` +
      `height=${Math.round(result.rendered.height)}px`,
  )
  for (const failure of result.failures) console.log(`     - ${failure}`)
}
process.exit(failed ? 1 : 0)
