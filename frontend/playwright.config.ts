import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser acceptance for the P0 learning loop.
 *
 * The suite starts the real Django API and the Vite dev server (which proxies
 * /api to Django), drives a real browser, and asserts on what a learner actually
 * sees. It is a separate evidence class from the automated API suite: a green
 * API test does not prove the UI works, and vice versa.
 *
 * ISOLATION IS MANDATORY. `globalSetup` rebuilds the demo fixture, so this
 * config refuses to start unless every resource belongs to this run. A browser
 * run must never be able to reset the developer's database:
 *
 *   POSTGRES_DB                  a dedicated database whose name starts with
 *                                `acepass_browser_audit_` or `acepass_acceptance_`
 *   ACEPASS_PRIVATE_MEDIA_ROOT   a fresh empty media directory
 *   ACEPASS_BROWSER_API_PORT     never 8000 (the development API)
 *   ACEPASS_BROWSER_WEB_PORT     never 5173 (the development Vite server)
 */
const DB = process.env.POSTGRES_DB ?? ''
if (!/^(acepass_browser_audit_|acepass_acceptance_)[a-zA-Z0-9_]+$/.test(DB)) {
  throw new Error(
    'Refusing to run: set POSTGRES_DB to a NEW dedicated database named acepass_browser_audit_* or acepass_acceptance_*.',
  )
}
if (!process.env.ACEPASS_PRIVATE_MEDIA_ROOT) {
  throw new Error('Refusing to run: set ACEPASS_PRIVATE_MEDIA_ROOT to a fresh empty directory.')
}
const API_PORT = Number(process.env.ACEPASS_BROWSER_API_PORT ?? '8000')
if (API_PORT === 8000) {
  throw new Error('Refusing to run: ACEPASS_BROWSER_API_PORT must not be the development API port 8000.')
}
const WEB_PORT = Number(process.env.ACEPASS_BROWSER_WEB_PORT ?? '5173')
if (WEB_PORT === 5173) {
  throw new Error('Refusing to run: ACEPASS_BROWSER_WEB_PORT must not be the development Vite port 5173.')
}
const API = `http://127.0.0.1:${API_PORT}`
const WEB = `http://127.0.0.1:${WEB_PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: '../var/browser-e2e',
  reporter: [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: `DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py runserver 127.0.0.1:${API_PORT} --noreload`,
      cwd: '../backend',
      url: `${API}/health/live`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js --config tests/acceptance/vite.acceptance.config.mjs --host 127.0.0.1`,
      cwd: '.',
      url: WEB,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
