/**
 * Isolated browser acceptance suite.
 *
 * Unlike the default `playwright.config.ts` (which reuses the developer API on
 * 8000/5173 and a demo fixture), this config refuses to start unless every
 * resource is dedicated to this run:
 *
 *   POSTGRES_DB                  a fresh database whose name starts with
 *                                `acepass_browser_audit_` or `acepass_acceptance_`
 *   REDIS_URL                    a private Redis (never the default 6379)
 *   ACEPASS_PRIVATE_MEDIA_ROOT   a fresh empty media directory
 *   ACEPASS_BROWSER_API_PORT     the API port for this run (never 8000)
 *
 * It never runs `reset_demo_progress` and never points at the development
 * database, so a browser run cannot destroy real work. The fixture it builds is
 * an **empty account plus real structure** (see `bootstrap_acceptance`), because
 * a fixture that pre-loads a complete demo question bank cannot prove that a new
 * user reaches the loop.
 */
import { defineConfig, devices } from '@playwright/test'

const DB = process.env.POSTGRES_DB ?? ''
if (!/^(acepass_browser_audit_|acepass_acceptance_)[a-zA-Z0-9_]+$/.test(DB)) {
  throw new Error(
    'Refusing to run: set POSTGRES_DB to a NEW dedicated database named acepass_browser_audit_* or acepass_acceptance_*.',
  )
}
const REDIS = process.env.REDIS_URL ?? ''
if (!REDIS || /:6379(\/|$)/.test(REDIS)) {
  throw new Error('Refusing to run: set REDIS_URL to a private Redis instance (not the default 6379).')
}
if (!process.env.ACEPASS_PRIVATE_MEDIA_ROOT) {
  throw new Error('Refusing to run: set ACEPASS_PRIVATE_MEDIA_ROOT to a fresh empty directory.')
}
if (process.env.ACEPASS_INLINE_TASKS !== 'false') {
  throw new Error(
    'Refusing to run: set ACEPASS_INLINE_TASKS=false so the suite exercises the real outbox/worker path.',
  )
}

const API_PORT = Number(process.env.ACEPASS_BROWSER_API_PORT ?? '8011')
if (API_PORT === 8000) {
  throw new Error('Refusing to run: ACEPASS_BROWSER_API_PORT must not be the development API port 8000.')
}
const WEB_PORT = Number(process.env.ACEPASS_BROWSER_WEB_PORT ?? '5181')
if (WEB_PORT === 5173) {
  throw new Error('Refusing to run: ACEPASS_BROWSER_WEB_PORT must not be the development Vite port 5173.')
}

const API = `http://127.0.0.1:${API_PORT}`
const WEB = `http://127.0.0.1:${WEB_PORT}`

export default defineConfig({
  testDir: './tests/acceptance',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './tests/acceptance/global-setup.ts',
  outputDir: '../var/browser-acceptance',
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
