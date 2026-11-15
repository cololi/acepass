#!/usr/bin/env node
/**
 * Boot an isolated DSH web instance for the B7 browser acceptance suite.
 *
 * The suite must never touch the developer's `~/.dsh`, the GUI on 59117, or the
 * workspace `.acepass` data. This script therefore builds a throw-away
 * `DSH_HOME` (a fresh temp directory), links the plugin into a private `web`
 * profile, points that profile at a private data root, seeds the acceptance
 * fixture, and only then starts the server.
 *
 * It prints one JSON object on stdout:
 *
 *   { url, token, baseUrl, dataRoot, port, pid, home, seed, log }
 *
 * `url` already carries the one-time `?token=`; the *first* browser navigation
 * to it sets the auth cookie, after which `/` and `/#/<route>` are admitted.
 *
 * Usage:
 *   node scripts/acceptance-server.mjs                boot (reuses a live instance)
 *   node scripts/acceptance-server.mjs --fresh        always rebuild the instance
 *   node scripts/acceptance-server.mjs --no-seed      boot without the fixture
 *   node scripts/acceptance-server.mjs --stop         stop the recorded instance
 *   node scripts/acceptance-server.mjs --state        print the recorded state
 *
 * Environment:
 *   ACEPASS_DSH_PORT     first port to try (default 59218; 59117 is the GUI and
 *                        59118 is taken by another service on this machine)
 *   ACEPASS_DSH_BIN      path to the DSH `bin.js` (default: the SDK checkout in
 *                        `dsh-plugin/.cache/dsh-sdk`)
 *   ACEPASS_SEED_SCRIPT  path to the fixture seeder (default
 *                        `scripts/acceptance-seed.mjs`, owned by the seed task)
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const REPO = path.resolve(PLUGIN, '..')

const STATE_DIR = path.join(PLUGIN, 'var', 'acceptance')
const STATE_FILE = path.join(STATE_DIR, 'server.json')
const RUNTIME = path.join(STATE_DIR, 'runtime')
const HOME = path.join(RUNTIME, 'home')
const DATA = path.join(RUNTIME, 'data')
const LOG = path.join(RUNTIME, 'dsh-web.log')
const PROFILE = path.join(HOME, 'profiles', 'web')
const SEED = process.env.ACEPASS_SEED_SCRIPT ?? path.join(HERE, 'acceptance-seed.mjs')

const DSH_BIN =
  process.env.ACEPASS_DSH_BIN ??
  path.join(PLUGIN, '.cache', 'dsh-sdk', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const DEFAULT_PORT = Number(process.env.ACEPASS_DSH_PORT ?? '59218')
const BOOT_TIMEOUT_MS = 180_000

function log(message) {
  process.stderr.write(`[acceptance-server] ${message}\n`)
}

function parseArgs(argv) {
  const flags = { fresh: false, stop: false, state: false, seed: true, keepData: false, port: DEFAULT_PORT, quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fresh') flags.fresh = true
    else if (arg === '--stop') flags.stop = true
    else if (arg === '--state') flags.state = true
    else if (arg === '--no-seed') flags.seed = false
    else if (arg === '--keep-data') flags.keepData = true
    else if (arg === '--quiet') flags.quiet = true
    else if (arg === '--port') flags.port = Number(argv[++index])
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: acceptance-server.mjs [--fresh] [--no-seed] [--keep-data] [--port N] [--stop] [--state]\n',
      )
      process.exit(0)
    } else {
      log(`ignoring unknown argument ${arg}`)
    }
  }
  return flags
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return undefined
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function pickPort(start) {
  for (let port = start; port < start + 40; port += 1) {
    if (await portFree(port)) return port
  }
  throw new Error(`no free port in ${start}..${start + 39}`)
}

function startDsh(port, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = fs.openSync(logFile, 'a')
  const child = spawn(
    process.execPath,
    [DSH_BIN, '--profile', 'web', '--port', String(port), '--no-open'],
    {
      env: { ...process.env, DSH_HOME: HOME, NO_COLOR: '1' },
      stdio: ['ignore', fd, fd],
      detached: true,
    },
  )
  child.unref()
  fs.closeSync(fd)
  return child.pid
}

function stopProcess(pid) {
  if (!alive(pid)) return
  try {
    // The instance is started detached, so its pid is also the process-group id:
    // killing the group also reaps the plugin's worker threads' child processes.
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

async function waitForUrl(pid, logFile, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let offset = 0
  while (Date.now() < deadline) {
    if (!alive(pid)) throw new Error(`dsh web exited during boot; see ${logFile}`)
    let text = ''
    try {
      const size = fs.statSync(logFile).size
      const length = Math.max(0, size - offset)
      if (length > 0) {
        const buffer = Buffer.alloc(length)
        const fd = fs.openSync(logFile, 'r')
        fs.readSync(fd, buffer, 0, length, offset)
        fs.closeSync(fd)
        offset = size
        text = buffer.toString('utf8')
      }
    } catch {
      /* log not created yet */
    }
    const match = /dsh web: (http:\/\/[^\s]+)/.exec(text)
    if (match !== null) return match[1]
    await sleep(150)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for "dsh web:" in ${logFile}`)
}

/** Scaffold a profile by booting once, which is how the CLI creates the tree. */
async function scaffoldProfile(port) {
  if (fs.existsSync(path.join(PROFILE, 'package.json'))) return
  log('creating a fresh DSH_HOME profile (first boot)')
  const pid = startDsh(port, LOG)
  try {
    await waitForUrl(pid, LOG)
  } finally {
    stopProcess(pid)
    await sleep(400)
  }
}

function patchProfile() {
  fs.mkdirSync(PROFILE, { recursive: true })
  fs.mkdirSync(path.join(PROFILE, 'node_modules', '@acepass'), { recursive: true })
  const link = path.join(PROFILE, 'node_modules', '@acepass', 'dsh-plugin')
  try {
    fs.rmSync(link, { force: true })
  } catch {
    /* nothing to remove */
  }
  fs.symlinkSync(PLUGIN, link, 'dir')

  const manifestPath = path.join(PROFILE, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = { ...(manifest.dependencies ?? {}), '@acepass/dsh-plugin': `link:${PLUGIN}` }
  const profile = (manifest.dsh ??= {})
  profile.profile ??= {}
  const bundles = (profile.profile.bundles ??= [])
  if (!bundles.includes('@acepass/dsh-plugin')) bundles.push('@acepass/dsh-plugin')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  // A fresh list: this profile belongs to one acceptance run, so the only
  // overlay is the plugin entry with the isolated data root.
  fs.writeFileSync(
    path.join(PROFILE, 'cordis.patch.yml'),
    [
      '# Written by dsh-plugin/scripts/acceptance-server.mjs for one acceptance run.',
      '- id: acepass',
      "  name: '@acepass/dsh-plugin'",
      '  config:',
      `    dataRoot: '${DATA}'`,
      "    provider: ''",
      "    model: ''",
      '',
    ].join('\n'),
  )
  log(`profile patched: plugin linked, dataRoot=${DATA}`)
}

function runSeed() {
  if (!fs.existsSync(SEED)) {
    log(`seeder not available at ${SEED}; starting without a fixture`)
    return { status: 'missing', script: SEED }
  }
  log(`seeding fixture: ${SEED} --data-root ${DATA}`)
  const result = spawnSync(process.execPath, [SEED, '--data-root', DATA], {
    cwd: PLUGIN,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 240_000,
  })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (result.status !== 0) {
    log(`seeder failed (exit ${result.status}); starting anyway so the run is recorded`)
    if (stderr !== '') log(stderr.split('\n').slice(-12).join('\n'))
    return { status: 'failed', script: SEED, exit: result.status, stderr }
  }
  let summary
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      summary = JSON.parse(lines[index])
      break
    } catch {
      /* keep looking for the JSON summary line */
    }
  }
  log('fixture seeded')
  return { status: 'seeded', script: SEED, summary }
}

/** One authenticated logical call, exactly as the browser client makes it. */
async function rpc(url, cookie, method, logicalPath) {
  const response = await fetch(new URL('/api/acepass/rpc', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ method, path: logicalPath, query: {} }),
  })
  const text = await response.text()
  return { http: response.status, text }
}

/**
 * Prove the instance is usable, not merely listening: the first navigation sets
 * the auth cookie, then one logical call must answer 200.
 */
async function verify(url) {
  const nav = await fetch(url, { redirect: 'manual' })
  const cookies = nav.headers.getSetCookie?.() ?? []
  const cookie = cookies.map((entry) => entry.split(';')[0]).join('; ')
  const me = await rpc(url, cookie, 'GET', '/api/v1/auth/me')
  if (me.http !== 200) throw new Error(`readiness failed: RPC HTTP ${me.http}: ${me.text.slice(0, 200)}`)
  let envelope
  try {
    envelope = JSON.parse(me.text)
  } catch {
    throw new Error(`readiness failed: RPC body is not JSON: ${me.text.slice(0, 200)}`)
  }
  if (envelope.status !== 200) throw new Error(`readiness failed: /auth/me status ${envelope.status}`)
  const user = JSON.parse(envelope.body)
  return { cookie: cookie !== '' ? cookie : undefined, user }
}

async function boot(flags) {
  if (!fs.existsSync(DSH_BIN)) throw new Error(`DSH bin not found at ${DSH_BIN}`)

  if (flags.fresh) {
    log(`--fresh: removing ${RUNTIME}`)
    fs.rmSync(RUNTIME, { recursive: true, force: true })
  } else {
    const state = readState()
    if (state !== undefined && alive(state.pid)) {
      // Three attempts: a busy server (SQLite write lock while a test saves) must
      // not be mistaken for a dead one, because "not usable" means rebuilding the
      // data root under a running suite.
      let lastError
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await verify(state.url)
          log(`reusing live instance pid=${state.pid} port=${state.port}`)
          return state
        } catch (error) {
          lastError = error
          await sleep(1_000)
        }
      }
      log(`live instance is not usable after 3 attempts (${lastError?.message}); rebuilding`)
      stopProcess(state.pid)
      await sleep(500)
    }
  }

  // A run always starts from a fresh fixture: the previous data root is
  // removed, exactly like the Django suite's dedicated database. `--keep-data`
  // exists only to inspect what a failed run left behind.
  if (flags.keepData !== true) {
    log(`clearing data root ${DATA}`)
    fs.rmSync(DATA, { recursive: true, force: true })
  }

  fs.mkdirSync(RUNTIME, { recursive: true })
  const port = await pickPort(flags.port)
  const url0 = `http://127.0.0.1:${port}/`

  await scaffoldProfile(port)
  patchProfile()

  const seed = flags.seed ? runSeed() : { status: 'skipped' }

  fs.rmSync(LOG, { force: true })
  const pid = startDsh(port, LOG)
  log(`dsh web starting on ${port} (pid ${pid})`)
  const url = await waitForUrl(pid, LOG)
  const ready = await verify(url)
  const token = new URL(url).searchParams.get('token') ?? ''

  const state = {
    url,
    token,
    baseUrl: url,
    port,
    pid,
    home: HOME,
    dataRoot: DATA,
    path: url0,
    log: LOG,
    seed,
    user: ready.user,
    startedAt: new Date().toISOString(),
  }
  writeState(state)
  return state
}

const flags = parseArgs(process.argv.slice(2))

if (flags.stop) {
  const state = readState()
  if (state === undefined) {
    process.stdout.write(`${JSON.stringify({ stopped: false, reason: 'no state file' })}\n`)
  } else {
    stopProcess(state.pid)
    await sleep(600)
    writeState({ ...state, stoppedAt: new Date().toISOString(), pid: -1 })
    process.stdout.write(`${JSON.stringify({ stopped: !alive(state.pid), pid: state.pid })}\n`)
  }
  process.exit(0)
}

if (flags.state) {
  const state = readState()
  process.stdout.write(`${JSON.stringify(state ?? { status: 'not-booted' }, null, 2)}\n`)
  process.exit(0)
}

try {
  const state = await boot(flags)
  // stdout carries exactly one JSON object: globalSetup parses it.
  process.stdout.write(
    `${JSON.stringify({
      url: state.url,
      token: state.token,
      baseUrl: state.baseUrl,
      dataRoot: state.dataRoot,
      port: state.port,
      pid: state.pid,
      home: state.home,
      seed: state.seed,
      log: state.log,
    })}\n`,
  )
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
