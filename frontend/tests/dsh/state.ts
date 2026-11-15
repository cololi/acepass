/**
 * Where the isolated DSH instance lives.
 *
 * `dsh-plugin/scripts/acceptance-server.mjs` boots it and records the state file;
 * this module is the only thing the Playwright side reads. The instance is
 * started by the config's `globalSetup` (and re-used if it is already healthy),
 * so `npx playwright test -c playwright.dsh.config.ts` is the whole command.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** `<repo>` — three levels up from `frontend/tests/dsh`. */
export const REPO = path.resolve(HERE, '../../..')
export const STATE_FILE = path.join(REPO, 'dsh-plugin', 'var', 'acceptance', 'server.json')
export const SERVER_SCRIPT = path.join(REPO, 'dsh-plugin', 'scripts', 'acceptance-server.mjs')

export interface AcceptanceSeedState {
  status: 'seeded' | 'missing' | 'failed' | 'skipped'
  script?: string
  summary?: unknown
  stderr?: string
}

export interface AcceptanceState {
  /** The one-time `?token=` URL: the first navigation authenticates the browser. */
  url: string
  token: string
  baseUrl: string
  port: number
  pid: number
  dataRoot: string
  home: string
  log: string
  seed?: AcceptanceSeedState
  user?: { id: string; email: string; display_name: string }
}

let cache: AcceptanceState | undefined

export function readState(): AcceptanceState {
  if (cache !== undefined) return cache
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(
      `No acceptance server state at ${STATE_FILE}. Run "node dsh-plugin/scripts/acceptance-server.mjs" first.`,
    )
  }
  cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as AcceptanceState
  return cache
}

/**
 * Start (or re-use) the isolated instance.
 *
 * Only the main process may boot: Playwright loads the config in every worker
 * too, and a worker that re-ran the bootstrapper could decide mid-run that the
 * instance is unhealthy and rebuild (i.e. wipe) the data root underneath a test.
 * Workers therefore just read the state the main process wrote.
 */
export function ensureServer(): AcceptanceState {
  if (cache !== undefined) return cache
  if (process.env.TEST_WORKER_INDEX !== undefined) return readState()
  const result = spawnSync(process.execPath, [SERVER_SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, NO_COLOR: '1' },
  })
  const stdout = (result.stdout ?? '').trim()
  if (result.status !== 0) {
    throw new Error(
      `acceptance-server.mjs exited ${result.status}\nstdout:\n${stdout}\nstderr:\n${result.stderr ?? ''}`,
    )
  }
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as AcceptanceState
      if (typeof parsed.url === 'string') {
        cache = parsed
        return parsed
      }
    } catch {
      /* not the JSON line */
    }
  }
  throw new Error(`acceptance-server.mjs printed no state JSON:\n${stdout}`)
}

export function originOf(state: AcceptanceState): string {
  return new URL(state.url).origin
}
