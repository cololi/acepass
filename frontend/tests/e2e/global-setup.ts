import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prepare a deterministic account and demo fixture for the browser run.
 *
 * The demo fixture is explicitly labelled as demo data everywhere it appears, so
 * a green browser run proves the UI works with clearly-marked fixtures — it does
 * not claim anything about a real exam.
 *
 * This setup RESETS the demo fixture, so it refuses to touch anything that is
 * not demonstrably a dedicated acceptance database with its own media directory
 * and ports. The development database can never be reached from here.
 */
export default function globalSetup() {
  const database = process.env.POSTGRES_DB ?? ''
  if (!/^(acepass_browser_audit_|acepass_acceptance_)[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error(
      `Refusing to bootstrap: POSTGRES_DB=${database} is not a dedicated acceptance database.`,
    )
  }
  const media = process.env.ACEPASS_PRIVATE_MEDIA_ROOT
  if (!media) throw new Error('Refusing to bootstrap: ACEPASS_PRIVATE_MEDIA_ROOT is not set.')
  if (!fs.existsSync(media)) fs.mkdirSync(media, { recursive: true })
  const leftovers = fs.readdirSync(media)
  if (leftovers.length > 0) {
    throw new Error(
      `Refusing to bootstrap: media directory ${media} is not empty (${leftovers.length} entries).`,
    )
  }

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
