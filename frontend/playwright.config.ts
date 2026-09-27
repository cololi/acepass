import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser acceptance for the P0 learning loop.
 *
 * The suite starts the real Django API and the Vite dev server (which proxies
 * /api to Django), drives a real browser, and asserts on what a learner actually
 * sees. It is a separate evidence class from the automated API suite: a green
 * API test does not prove the UI works, and vice versa.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './tests/e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
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
      command:
        'cd ../backend && DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py runserver 127.0.0.1:8000 --noreload',
      url: 'http://127.0.0.1:8000/health/live',
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
})
