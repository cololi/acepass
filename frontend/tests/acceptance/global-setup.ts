/**
 * Prepare an isolated acceptance environment.
 *
 * Refuses to run unless the database, Redis, media directory and ports are all
 * dedicated to this run — it must be impossible for a browser acceptance run to
 * touch the developer's database or their running 8000/5173 services.
 *
 * The fixture it builds is deliberately NOT the demo fixture: an empty account
 * plus the real setup path (two projects, three subjects, published specs and
 * syllabi, one published question per scorable type). A fixture that pre-loads a
 * complete demo question bank cannot prove a new user reaches the loop.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ACCEPTANCE_EMAIL = process.env.ACEPASS_BROWSER_EMAIL ?? 'acceptance@acepass.local'
export const ACCEPTANCE_PASSWORD = process.env.ACEPASS_BROWSER_PASSWORD ?? 'AcceptanceBrowser!2026'

const here = path.dirname(fileURLToPath(import.meta.url))
const backend = path.resolve(here, '../../../backend')
const python = path.join(backend, '.venv', 'bin', 'python')

function env() {
  return {
    ...process.env,
    DJANGO_SETTINGS_MODULE: 'config.settings.dev',
    POSTGRES_DB: process.env.POSTGRES_DB!,
    REDIS_URL: process.env.REDIS_URL!,
    ACEPASS_PRIVATE_MEDIA_ROOT: process.env.ACEPASS_PRIVATE_MEDIA_ROOT!,
    ACEPASS_INLINE_TASKS: 'false',
    ACEPASS_BROWSER_API_PORT: process.env.ACEPASS_BROWSER_API_PORT ?? '8011',
    ACEPASS_BROWSER_WEB_PORT: process.env.ACEPASS_BROWSER_WEB_PORT ?? '5181',
    DJANGO_CSRF_TRUSTED_ORIGINS: `http://127.0.0.1:${process.env.ACEPASS_BROWSER_WEB_PORT ?? '5181'},http://127.0.0.1:${process.env.ACEPASS_BROWSER_API_PORT ?? '8011'}`,
  }
}

function run(args: string[]) {
  execFileSync(python, args, { cwd: backend, env: env(), stdio: 'inherit' })
}

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
      `Refusing to bootstrap: media directory ${media} is not empty (${leftovers.length} entries). Use a fresh directory.`,
    )
  }

  run(['manage.py', 'migrate', '--noinput'])
  run(['manage.py', 'create_account', ACCEPTANCE_EMAIL, '--password', ACCEPTANCE_PASSWORD, '--display-name', '验收用户'])
  // `--allow` names the database explicitly so a typo cannot touch a real one.
  run(['manage.py', 'bootstrap_acceptance', '--email', ACCEPTANCE_EMAIL, '--password', ACCEPTANCE_PASSWORD, '--allow', database])
}
