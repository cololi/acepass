// Reproduction harness only. Original setup resets demo data in the selected DB.
const path = require('node:path')
const root = path.resolve(__dirname, '../../..')
const { defineConfig, devices } = require(path.join(root, 'frontend/node_modules/@playwright/test'))
if (!/^(acepass_browser_audit_|acepass_acceptance_)[a-zA-Z0-9_]+$/.test(process.env.POSTGRES_DB || '')) {
  throw new Error('Set POSTGRES_DB to a newly created, dedicated acceptance database.')
}
if (process.env.REDIS_URL !== 'redis://127.0.0.1:6391/0' || !process.env.ACEPASS_PRIVATE_MEDIA_ROOT) {
  throw new Error('A private Redis on 6391 and a fresh ACEPASS_PRIVATE_MEDIA_ROOT are required.')
}
if (process.env.ACEPASS_INLINE_TASKS !== 'false') {
  throw new Error('Set ACEPASS_INLINE_TASKS=false and start a real isolated Worker.')
}
const original = process.env.ACEPASS_REVIEW_SUITE === 'original'
module.exports = defineConfig({
  testDir: original ? path.join(root, 'frontend/tests/e2e') : __dirname,
  testMatch: original ? '**/*.spec.ts' : 'ui-regressions.spec.ts',
  globalSetup: original ? path.join(root, 'frontend/tests/e2e/global-setup.ts') : undefined,
  timeout: 60000, expect: { timeout: original ? 10000 : 3000 },
  fullyParallel: false, workers: 1, retries: 0, reporter: [['list']],
  outputDir: path.join(root, 'var', original ? 'review-browser-original' : 'review-browser-regressions'),
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'zh-CN' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    ...(original ? [{ name: 'mobile', use: { ...devices['Pixel 7'] } }] : []),
  ],
  webServer: [
    { command: '.venv/bin/python manage.py runserver 127.0.0.1:8001 --noreload', cwd: path.join(root, 'backend'), url: 'http://127.0.0.1:8001/health/live', reuseExistingServer: false, timeout: 90000 },
    { command: 'node node_modules/vite/bin/vite.js --config ../docs/review/2026-09-27/vite.review.config.mjs --host 127.0.0.1', cwd: path.join(root, 'frontend'), url: 'http://127.0.0.1:5174', reuseExistingServer: false, timeout: 90000 },
  ],
})
