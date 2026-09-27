import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prepare a deterministic account and demo fixture for the browser run.
 *
 * The demo fixture is explicitly labelled as demo data everywhere it appears, so
 * a green browser run proves the UI works with clearly-marked fixtures — it does
 * not claim anything about a real exam.
 */
export default function globalSetup() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const backend = path.resolve(here, '../../../backend')
  const python = path.join(backend, '.venv', 'bin', 'python')
  const env = { ...process.env, DJANGO_SETTINGS_MODULE: 'config.settings.dev' }
  execFileSync(python, ['manage.py', 'migrate', '--noinput'], { cwd: backend, env, stdio: 'inherit' })
  execFileSync(
    python,
    ['manage.py', 'create_account', 'e2e@acepass.local', '--password', 'E2eBrowser!2026', '--display-name', '浏览器验收'],
    { cwd: backend, env, stdio: 'inherit' },
  )
  // A previous browser run leaves an active session behind, which correctly
  // blocks archiving; reset the demo progress (never a real project) first.
  execFileSync(python, ['manage.py', 'reset_demo_progress', '--email', 'e2e@acepass.local'], {
    cwd: backend,
    env,
    stdio: 'inherit',
  })
  execFileSync(python, ['manage.py', 'load_demo_fixture', '--email', 'e2e@acepass.local', '--rebuild'], {
    cwd: backend,
    env,
    stdio: 'inherit',
  })
}
