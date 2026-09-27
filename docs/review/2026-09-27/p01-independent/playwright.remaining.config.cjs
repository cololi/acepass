const path = require('node:path')
const root = path.resolve(__dirname, '../../../..')
const {defineConfig, devices} = require(path.join(root, 'frontend/node_modules/@playwright/test'))
if (!/^(acepass_browser_audit_|acepass_acceptance_)[a-zA-Z0-9_]+$/.test(process.env.POSTGRES_DB || '')) throw new Error('A dedicated acceptance database is required.')
if (process.env.REDIS_URL !== 'redis://127.0.0.1:6394/0' || !process.env.ACEPASS_PRIVATE_MEDIA_ROOT || process.env.ACEPASS_INLINE_TASKS !== 'false') throw new Error('Use a private Redis on 6394, private media and a real Worker.')
if (process.env.ACEPASS_BROWSER_API_PORT !== '8014' || process.env.ACEPASS_BROWSER_WEB_PORT !== '5184') throw new Error('This harness requires API 8014 and Vite 5184.')
module.exports = defineConfig({
  testDir: __dirname, testMatch: ['draft-regression.spec.ts','fill-editor.spec.ts'], timeout: 60000, expect: {timeout: 4000}, workers: 1, retries: 0, reporter: [['list']],
  outputDir: path.join(root,'var/p01-independent-browser'),
  use: {baseURL: 'http://127.0.0.1:5184', screenshot: 'only-on-failure'},
  projects: [{name: 'desktop', use: {...devices['Desktop Chrome']}}],
  webServer: [
    {command: '.venv/bin/python manage.py runserver 127.0.0.1:8014 --noreload', cwd: path.join(root,'backend'), url: 'http://127.0.0.1:8014/health/live', reuseExistingServer: false},
    {command: 'node node_modules/vite/bin/vite.js --config tests/acceptance/vite.acceptance.config.mjs --host 127.0.0.1', cwd: path.join(root,'frontend'), url: 'http://127.0.0.1:5184', reuseExistingServer: false}
  ]
})
