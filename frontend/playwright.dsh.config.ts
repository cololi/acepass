/**
 * Browser acceptance suite for the DSH Web client (B7).
 *
 * The Django-era config refused to run unless Postgres/Redis/media/ports were
 * dedicated to the run, and started `runserver` + Vite. On DSH the equivalent
 * isolation is a throw-away `DSH_HOME` with its own data root, and the server is
 * started by `globalSetup` (via `dsh-plugin/scripts/acceptance-server.mjs`)
 * rather than a `webServer`, because the URL is only known after the profile is
 * linked and the fixture is seeded.
 *
 * `use.baseURL` therefore carries the one-time `?token=` URL: the first
 * navigation sets the auth cookie, after which `/` and `/#/<route>` are admitted.
 * Specs never navigate by raw URL except through the `tests/dsh/base.ts` seam,
 * which also handles the panel, the hash routes and the RPC carrier.
 *
 * Projects:
 *   desktop / mobile  the migrated 9 spec files (43 bodies -> 86 collected,
 *                     78 main + 8 @stub; run them with `--grep-invert @stub`
 *                     and `--grep @stub` respectively)
 *   archive           the 2026-09-27 UI counter-examples, kept separate so the
 *                     main numbers stay comparable with the Django-era suite
 */
import { defineConfig, devices } from '@playwright/test'
import { ensureServer } from './tests/dsh/state'

// Boots once and is a cheap health probe afterwards; safe at config-load time.
const state = ensureServer()

const ARCHIVE = /archive\/.*\.spec\.ts/

export default defineConfig({
  testDir: './tests/dsh',
  // DSH's panel adds a shell boot per navigation; the migrated suite keeps Django's assertions but
  // needs a larger per-test budget on the mobile project (two reloads can exceed 90s there).
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './tests/dsh/global-setup.ts',
  globalTeardown: process.env.ACEPASS_KEEP_SERVER === '1' ? undefined : './tests/dsh/global-teardown.ts',
  outputDir: '../dsh-plugin/var/acceptance/artifacts',
  reporter: [
    ['list'],
    // One JSON per suite run: `PLAYWRIGHT_JSON_OUTPUT_NAME` does not override a
    // configured outputFile, so the path is an explicit env seam instead.
    ['json', { outputFile: process.env.ACEPASS_REPORT_JSON ?? '../dsh-plugin/var/acceptance/playwright-report.json' }],
  ],
  use: {
    baseURL: state.baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'desktop', testIgnore: ARCHIVE, use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', testIgnore: ARCHIVE, use: { ...devices['Pixel 7'] } },
    { name: 'archive', testMatch: ARCHIVE, use: { ...devices['Desktop Chrome'] } },
  ],
})
