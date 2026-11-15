#!/usr/bin/env node
/**
 * B9 residual check — "does the DSH plugin runtime still depend on Celery / Redis / AMQP /
 * PostgreSQL / Docker?"
 *
 * The Django backend runs on four external processes (Celery workers + beat, a Redis broker/cache, a
 * PostgreSQL server and a Docker/nginx deployment). The plugin must run with **none** of them: its
 * only state is a `node:sqlite` file and its only peer is the DSH host. This script is the executable
 * proof of that, and it is meant to be re-runnable after every batch so a stray `import Redis` or a
 * pasted `postgres://` fixture cannot silently re-introduce the dependency.
 *
 * What it looks at (the runtime surface only):
 *   - `src/**` TypeScript/TSX and any plain JS that ships next to it;
 *   - the built bundles `lib/index.js` / `lib/client.js` when present (they are what `package.json`
 *     `main`/`exports` actually publish, so a dependency could appear only after bundling);
 *   - `package.json` dependency buckets.
 *
 * How it decides (deliberately narrow, so prose cannot trip it):
 *   1. comments are stripped by a real lexical pass before anything is matched — the tree legitimately
 *      contains sentences like "Postgres `SELECT ... FOR UPDATE SKIP LOCKED` has no SQLite equivalent",
 *      and those must stay green;
 *   2. module specifiers are only matched where an `import`/`export ... from`/`require(...)`/
 *      `import(...)` actually appears outside a string literal (`'pg'` as text is not an import);
 *   3. URLs, broker ports, env-var names and container CLI invocations are only matched **inside**
 *      string literals / template literals, where a configuration value would live;
 *   4. relative specifiers (`./pg.ts`), `node:` builtins and scoped host packages are never flagged.
 *
 * Usage:
 *   node scripts/retirement-check.mjs                 # scan the plugin, human summary on stderr
 *   node scripts/retirement-check.mjs --list-files    # include the scanned file list in the report
 *   node scripts/retirement-check.mjs --out var/b9/retirement-check.json
 *   node scripts/retirement-check.mjs --root <dir>    # scan another tree (fixtures in the tests)
 *
 * Exit codes: 0 = clean, 1 = violations (or a coverage failure), 2 = usage / IO error.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 1

/** Extensions treated as runtime source. `.d.ts` is included on purpose: a declaration that types a
 * broker client is still a dependency claim even though it emits no code. */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/** Source roots, relative to the scanned root. */
export const SCAN_DIRECTORIES = ['src']

/** Built artifacts, scanned when they exist. Missing is not a violation: `npm run build` produces
 * them and the tests are allowed to run before a build. */
export const BUNDLE_FILES = ['lib/index.js', 'lib/client.js']

/** Files whose absence makes the result meaningless (a scan that sees nothing must not look green). */
export const REQUIRED_FILES = [
  'package.json',
  'src/index.ts',
  'src/http/routes.ts',
  'src/http/router.ts',
  'src/jobs/worker.ts',
  'src/store/outbox.ts',
  'src/store/db.ts',
  'src/services/practice.ts',
]

/** Evidence anchors: reported with byte sizes so "0 violations" is attributable to a real read. */
export const KEY_FILES = [...REQUIRED_FILES, 'lib/index.js', 'lib/client.js']

export const DEPENDENCY_BUCKETS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
]

/** Broker / queue clients. Any of these means a Celery-or-equivalent runtime came back. */
export const BROKER_MODULES = new Set([
  'celery',
  'celery-node',
  'node-celery',
  'redis',
  'redis-parser',
  'ioredis',
  '@redis/client',
  '@redis/bloom',
  '@redis/json',
  '@redis/search',
  '@redis/time-series',
  'bullmq',
  'bull',
  'bee-queue',
  'kue',
  'agenda',
  'amqplib',
  'amqp-connection-manager',
  'rhea',
  'rhea-promise',
  'kafkajs',
  'node-rdkafka',
])

/** Clients that require a database *server* (Django's PostgreSQL). `node:sqlite` is the supported
 * store, so SQLite drivers are never listed here. */
export const DATABASE_MODULES = new Set([
  'pg',
  'pg-pool',
  'pg-native',
  'pg-cursor',
  'postgres',
  'slonik',
  'mysql',
  'mysql2',
  'mongodb',
  'mongoose',
  'oracledb',
  'mssql',
  'sequelize',
  'typeorm',
  '@prisma/client',
  'knex',
  'drizzle-kit',
])

/** Container-runtime clients. The plugin must never talk to a Docker daemon. */
export const CONTAINER_MODULES = new Set([
  'dockerode',
  'docker-modem',
  'docker-cli-js',
  'docker-compose',
  'node-docker-api',
  'dockerode-compose',
])

export const URL_PATTERNS = [
  { rule: 'url-broker', pattern: /\b(redis|rediss|amqp|amqps|kafka|rabbitmq):\/\//i },
  {
    rule: 'url-database',
    pattern: /\b(postgres|postgresql|psql|mysql|mongodb(\+srv)?|oracle|sqlserver):\/\//i,
  },
]

/** Default ports of the services Django needs. `:6379` in a string is a broker address. */
export const PORT_PATTERN = /:(6379|5432|5672|15672|2375|2376|9092|3306|27017|1433)(?![\d])/

export const ENV_BROKER = new Set([
  'REDIS_URL',
  'REDISS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'CELERY_BROKER_URL',
  'CELERY_RESULT_BACKEND',
  'BROKER_URL',
  'RESULT_BACKEND',
  'AMQP_URL',
  'RABBITMQ_URL',
  'CACHE_URL',
  'KAFKA_BROKERS',
  'DOCKER_HOST',
])

export const ENV_DATABASE = new Set([
  'POSTGRES_URL',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
])

/** Shelling out to the retired runtime is the other way the dependency can come back. */
export const COMMAND_PATTERNS = [
  { rule: 'broker-command', pattern: /(^|[\s;&|/])celery\s+(-A|worker|beat|inspect)\b/ },
  {
    rule: 'container-command',
    pattern: /(^|[\s;&|])docker\s+(compose|run|exec|ps|build|pull|logs)\b/,
  },
]

export const RULE_IDS = [
  'import-broker',
  'import-database',
  'import-container',
  'url-broker',
  'url-database',
  'network-port',
  'env-broker',
  'env-database',
  'broker-command',
  'container-command',
  'dependency',
  'coverage',
]

// ---------------------------------------------------------------------------
// Lexing: strip comments, collect string literals
// ---------------------------------------------------------------------------

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>'])
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof', 'new', 'do', 'else', 'yield', 'await'])

/**
 * Split a source file into comment spans and string literals.
 *
 * A single lexical pass with a small frame stack: `code` frames and `template` frames. Template
 * literals matter here because the store builds SQL with them, and a `'` inside one must not start a
 * string — otherwise the whole rest of the file could be swallowed and a real `import redis` hidden.
 */
export function lexSource(source) {
  /** @type {Array<[number, number]>} */
  const comments = []
  /** @type {Array<{start: number, end: number, value: string, quote: string}>} */
  const strings = []
  const n = source.length
  /** @type {Array<{type: 'code'|'template', depth?: number}>} */
  const stack = [{ type: 'code' }]
  let i = 0
  let lastChar = ''
  let lastToken = ''

  const readStringBody = (quote) => {
    // `i` points at the opening quote; returns the index just past the closing quote.
    const start = i
    i += 1
    while (i < n) {
      const ch = source[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) { i += 1; return { start, end: i, value: source.slice(start + 1, i - 1), quote } }
      if (ch === '\n' && quote !== '`') { return { start, end: i, value: source.slice(start + 1, i), quote } }
      i += 1
    }
    return { start, end: n, value: source.slice(start + 1, n), quote }
  }

  const readRegexLiteral = () => {
    // `i` points at `/`; only called when the heuristic says a regex may start here.
    const start = i
    i += 1
    let inClass = false
    while (i < n) {
      const ch = source[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') { inClass = true; i += 1; continue }
      if (ch === ']') { inClass = false; i += 1; continue }
      if (ch === '/' && !inClass) { i += 1; while (i < n && /[a-z]/i.test(source[i])) i += 1; return i }
      if (ch === '\n') return start // not a regex after all (division over a line break)
      i += 1
    }
    return start
  }

  while (i < n) {
    const frame = stack[stack.length - 1]

    if (frame.type === 'template') {
      const ch = source[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') {
        i += 1
        strings.push({ start: frame.start, end: i, value: source.slice(frame.start + 1, i - 1), quote: '`' })
        stack.pop()
        lastChar = 'str'
        lastToken = ''
        continue
      }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2
        stack.push({ type: 'code', depth: 0 })
        lastChar = '('
        lastToken = ''
        continue
      }
      i += 1
      continue
    }

    const ch = source[i]
    // Leaving a `${ ... }` expression: the closing brace belongs to the template.
    if (ch === '}' && frame.depth === 0 && stack.length > 1) {
      stack.pop()
      i += 1
      lastChar = '}'
      lastToken = ''
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') { i += 1; continue }

    if (ch === '/' && source[i + 1] === '/') {
      const start = i
      i += 2
      while (i < n && source[i] !== '\n') i += 1
      comments.push([start, i])
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i = Math.min(n, i + 2)
      comments.push([start, i])
      continue
    }
    if (ch === "'" || ch === '"') {
      const read = readStringBody(ch)
      strings.push(read)
      i = read.end
      lastChar = 'str'
      lastToken = ''
      continue
    }
    if (ch === '`') {
      stack.push({ type: 'template', start: i })
      i += 1
      lastChar = 'str'
      lastToken = ''
      continue
    }
    if (ch === '/' && (REGEX_PRECEDERS.has(lastChar) || lastToken === '' || REGEX_KEYWORDS.has(lastToken))) {
      const end = readRegexLiteral()
      if (end > i) { i = end; lastChar = 're'; lastToken = ''; continue }
    }
    if (ch === '{') { frame.depth = (frame.depth ?? 0) + 1; i += 1; lastChar = '{'; lastToken = ''; continue }
    if (ch === '}') { frame.depth = Math.max(0, (frame.depth ?? 0) - 1); i += 1; lastChar = '}'; lastToken = ''; continue }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$]/.test(source[i])) i += 1
      lastToken = source.slice(start, i)
      lastChar = 'id'
      continue
    }
    lastChar = ch
    lastToken = ''
    i += 1
  }

  // An unterminated template still yields its text: a truncated scan must not look like prose.
  for (const frame of stack) {
    if (frame.type === 'template') {
      strings.push({ start: frame.start, end: n, value: source.slice(frame.start + 1, n), quote: '`' })
    }
  }

  return { comments, strings }
}

/** Replace each comment span with spaces, keeping newlines so line numbers stay exact. */
export function maskComments(source, comments) {
  if (comments.length === 0) return source
  const parts = []
  let cursor = 0
  for (const [start, end] of comments) {
    if (start < cursor) continue
    parts.push(source.slice(cursor, start))
    parts.push(source.slice(start, end).replace(/[^\n]/g, ' '))
    cursor = end
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

function lineIndex(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1)
  return (index) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (starts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const SPECIFIER_PATTERNS = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g, // import x from 'y' / export ... from 'y'
  /\bimport\s*(['"])([^'"\n]+)\1/g, // import 'y'
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g, // await import('y')
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g, // require('y')
]

/** The package name of a specifier, or `null` when it is relative / a Node builtin / a host package. */
export function barePackageName(specifier) {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('node:')) return null
  if (specifier.startsWith('@deepseek-ai/')) return null
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return name === undefined ? scope : `${scope}/${name}`
  }
  return specifier.split('/')[0]
}

function insideAny(index, spans) {
  for (const span of spans) {
    if (index >= span.start && index < span.end) return true
    if (span.start > index) break
  }
  return false
}

const MODULE_SETS = [
  { rule: 'import-broker', names: BROKER_MODULES },
  { rule: 'import-database', names: DATABASE_MODULES },
  { rule: 'import-container', names: CONTAINER_MODULES },
]

function excerptOf(text, start, end) {
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw
}

/**
 * Scan one source file. Exported so a test can pin the semantics on a fixture without a tree.
 *
 * @param {string} relPath path used in the report
 * @param {string} source file text
 * @returns {Array<{rule: string, file: string, line: number, detail: string, excerpt: string}>}
 */
export function scanSource(relPath, source) {
  const violations = []
  const { comments, strings } = lexSource(source)
  const masked = maskComments(source, comments)
  const lineOf = lineIndex(masked)
  const push = (rule, index, length, detail) => {
    violations.push({ rule, file: relPath, line: lineOf(index), detail, excerpt: excerptOf(masked, index, index + length) })
  }

  // 1. Module specifiers — only where an import form starts outside a string literal.
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(masked)) !== null) {
      if (insideAny(match.index, strings)) continue
      const specifier = match[2]
      const bare = barePackageName(specifier)
      if (bare === null) continue
      for (const { rule, names } of MODULE_SETS) {
        if (names.has(bare)) {
          push(rule, match.index, match[0].length, `${bare} (specifier ${JSON.stringify(specifier)})`)
          break
        }
      }
    }
  }

  // 2. String contents: URLs, broker ports, env-var names, container/broker CLI invocations.
  for (const literal of strings) {
    const value = literal.value
    if (value === '') continue
    for (const { rule, pattern } of URL_PATTERNS) {
      const match = pattern.exec(value)
      if (match !== null) push(rule, literal.start, literal.end - literal.start, `URL scheme ${match[1]}://`)
    }
    const port = PORT_PATTERN.exec(value)
    if (port !== null) push('network-port', literal.start, literal.end - literal.start, `port ${port[1]}`)
    const normalized = value.trim()
    if (ENV_BROKER.has(normalized)) push('env-broker', literal.start, literal.end - literal.start, `env ${normalized}`)
    else if (ENV_DATABASE.has(normalized)) push('env-database', literal.start, literal.end - literal.start, `env ${normalized}`)
    for (const { rule, pattern } of COMMAND_PATTERNS) {
      if (pattern.test(normalized)) push(rule, literal.start, literal.end - literal.start, `command ${normalized.slice(0, 60)}`)
    }
  }

  // 3. `process.env.X` / `process.env['X']` reads on real code (outside comments and string bodies).
  const envRead = /process\s*\.\s*env\s*(?:\.\s*([A-Z][A-Z0-9_]*)|\[\s*(['"])([A-Z][A-Z0-9_]*)\2\s*\])/g
  let envMatch
  while ((envMatch = envRead.exec(masked)) !== null) {
    if (insideAny(envMatch.index, strings)) continue
    const name = envMatch[1] ?? envMatch[3]
    if (ENV_BROKER.has(name)) push('env-broker', envMatch.index, envMatch[0].length, `env ${name}`)
    else if (ENV_DATABASE.has(name)) push('env-database', envMatch.index, envMatch[0].length, `env ${name}`)
  }

  // One finding per (rule, line, subject): `process.env['CELERY_BROKER_URL']` is reached both as a
  // bracket read and as a string literal, and reporting it twice would imply two defects.
  const seen = new Set()
  const unique = violations.filter((violation) => {
    const key = `${violation.rule}\u0000${violation.line}\u0000${violation.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Deterministic order: by line, then rule. A file read once must produce the same report twice.
  unique.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
  return unique
}

/**
 * Scan one `package.json`. Only dependency buckets are checked — `scripts` are build-time tooling and
 * are deliberately out of scope (the published tarball is `files: lib, locale, cordis.patch.yml`).
 *
 * @returns {Array<{rule: string, file: string, line: number, detail: string, excerpt: string}>}
 */
export function scanPackageJson(relPath, text) {
  const violations = []
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    return [{
      rule: 'coverage',
      file: relPath,
      line: 1,
      detail: `unreadable package.json: ${error instanceof Error ? error.message : String(error)}`,
      excerpt: 'package.json',
    }]
  }
  const lines = text.split('\n')
  const lineOfKey = (name) => {
    const index = lines.findIndex((line) => line.includes(`"${name}"`))
    return index === -1 ? 1 : index + 1
  }
  for (const bucket of DEPENDENCY_BUCKETS) {
    const entries = manifest[bucket]
    if (entries === undefined || entries === null || typeof entries !== 'object') continue
    for (const [name, version] of Object.entries(entries)) {
      const bare = barePackageName(name)
      if (bare === null) continue
      const hit = MODULE_SETS.find((entry) => entry.names.has(bare) || entry.names.has(name))
      if (hit !== undefined) {
        violations.push({
          rule: 'dependency',
          file: relPath,
          line: lineOfKey(name),
          detail: `${bucket}: ${name}@${String(version)}`,
          excerpt: `"${name}": "${String(version)}"`,
        })
        continue
      }
      if (name === 'docker' || name.startsWith('docker-')) {
        violations.push({ rule: 'dependency', file: relPath, line: lineOfKey(name), detail: `${bucket}: ${name}@${String(version)}`, excerpt: `"${name}": "${String(version)}"` })
      }
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

function walk(directory, base) {
  /** @type {string[]} */
  const files = []
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(absolute, base))
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(extensionOf(entry.name))) {
      files.push(relative(base, absolute).split(sep).join('/'))
    }
  }
  return files
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot)
}

const NOT_SCANNED = [
  { glob: 'scripts/**', reason: 'migration-time tooling (golden generators call ../backend/.venv/bin/python); not in package.files' },
  { glob: 'tests/**', reason: 'fixtures and assertions legitimately name Django, Redis and PostgreSQL' },
  { glob: 'docs/**, var/**', reason: 'prose and evidence' },
  { glob: 'backend/**, infra/**, .github/**', reason: 'the Django stack being retired, outside the plugin runtime' },
]

/**
 * Build the full report for one tree.
 *
 * @param {string} [root] plugin root; defaults to the directory above `scripts/`
 * @param {{listFiles?: boolean}} [options]
 */
export function scanTree(root = defaultRoot(), options = {}) {
  const absoluteRoot = resolve(root)
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`not a directory: ${absoluteRoot}`)
  }
  const files = []
  for (const directory of SCAN_DIRECTORIES) {
    const absolute = join(absoluteRoot, directory)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue
    files.push(...walk(absolute, absoluteRoot).sort())
  }

  const violations = []
  const scanned = []
  let bytes = 0
  for (const relPath of files) {
    const source = readFileSync(join(absoluteRoot, relPath), 'utf8')
    bytes += Buffer.byteLength(source, 'utf8')
    scanned.push({ path: relPath, bytes: Buffer.byteLength(source, 'utf8'), kind: 'source' })
    violations.push(...scanSource(relPath, source))
  }

  const bundles = []
  for (const relPath of BUNDLE_FILES) {
    const absolute = join(absoluteRoot, relPath)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      bundles.push({ path: relPath, present: false, bytes: 0 })
      continue
    }
    const source = readFileSync(absolute, 'utf8')
    const size = Buffer.byteLength(source, 'utf8')
    bytes += size
    bundles.push({ path: relPath, present: true, bytes: size })
    scanned.push({ path: relPath, bytes: size, kind: 'bundle' })
    violations.push(...scanSource(relPath, source))
  }

  const required = REQUIRED_FILES.map((relPath) => {
    const absolute = join(absoluteRoot, relPath)
    const present = existsSync(absolute) && statSync(absolute).isFile()
    return { path: relPath, present, bytes: present ? statSync(absolute).size : 0 }
  })
  for (const entry of required) {
    if (!entry.present) {
      violations.push({
        rule: 'coverage',
        file: entry.path,
        line: 1,
        detail: 'required runtime file missing: the scan would not cover the entry point',
        excerpt: entry.path,
      })
    }
  }

  const manifestPath = join(absoluteRoot, 'package.json')
  let manifest = null
  if (existsSync(manifestPath)) {
    const text = readFileSync(manifestPath, 'utf8')
    bytes += Buffer.byteLength(text, 'utf8')
    scanned.push({ path: 'package.json', bytes: Buffer.byteLength(text, 'utf8'), kind: 'manifest' })
    violations.push(...scanPackageJson('package.json', text))
    try {
      manifest = JSON.parse(text)
    } catch {
      manifest = null
    }
  } else {
    violations.push({ rule: 'coverage', file: 'package.json', line: 1, detail: 'package.json missing', excerpt: 'package.json' })
  }

  if (files.length === 0) {
    violations.push({
      rule: 'coverage',
      file: 'src',
      line: 1,
      detail: 'no source files found under src: an empty scan must not report clean',
      excerpt: 'src/**',
    })
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))

  const byRule = {}
  for (const rule of RULE_IDS) byRule[rule] = 0
  for (const violation of violations) byRule[violation.rule] = (byRule[violation.rule] ?? 0) + 1

  const keyFiles = KEY_FILES.map((relPath) => {
    const absolute = join(absoluteRoot, relPath)
    const present = existsSync(absolute) && statSync(absolute).isFile()
    return { path: relPath, present, bytes: present ? statSync(absolute).size : 0 }
  })

  const dependencyNames = {}
  for (const bucket of DEPENDENCY_BUCKETS) {
    const entries = manifest?.[bucket]
    dependencyNames[bucket] = entries !== undefined && entries !== null && typeof entries === 'object' ? Object.keys(entries).sort() : []
  }

  return {
    schema: SCHEMA_VERSION,
    ok: violations.length === 0,
    verdict: violations.length === 0 ? 'clean' : 'violations',
    generatedAt: new Date().toISOString(),
    root: absoluteRoot,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    scope: {
      sourceDirectories: SCAN_DIRECTORIES,
      sourceExtensions: SOURCE_EXTENSIONS,
      bundleFiles: BUNDLE_FILES,
      dependencyBuckets: DEPENDENCY_BUCKETS,
      rules: RULE_IDS,
      notScanned: NOT_SCANNED,
    },
    coverage: {
      sourceFiles: files.length,
      bundles,
      required,
      keyFiles,
      bytesScanned: bytes,
      ...(options.listFiles === true ? { files: scanned } : {}),
    },
    package: manifest === null
      ? null
      : {
          name: manifest.name ?? null,
          version: manifest.version ?? null,
          main: manifest.main ?? null,
          files: manifest.files ?? null,
          dependencies: dependencyNames,
        },
    counts: { violations: violations.length, byRule },
    violations,
  }
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { root: defaultRoot(), out: null, listFiles: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--root needs a directory')
      options.root = resolve(value)
      i += 1
    } else if (arg === '--out') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--out needs a file path')
      options.out = resolve(value)
      i += 1
    } else if (arg === '--list-files') {
      options.listFiles = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`retirement-check: ${error instanceof Error ? error.message : String(error)}`)
    console.error('usage: node scripts/retirement-check.mjs [--root <dir>] [--out <file>] [--list-files]')
    process.exit(2)
  }
  if (options.help) {
    console.log('usage: node scripts/retirement-check.mjs [--root <dir>] [--out <file>] [--list-files]')
    process.exit(0)
  }

  let report
  try {
    report = scanTree(options.root, { listFiles: options.listFiles })
  } catch (error) {
    console.error(`retirement-check: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const json = `${JSON.stringify(report, null, 2)}\n`
  if (options.out !== null) writeFileSync(options.out, json)
  process.stdout.write(json)

  const bundleNote = report.coverage.bundles.filter((entry) => entry.present).map((entry) => entry.path).join(', ') || 'none'
  console.error(
    `retirement-check: ${report.coverage.sourceFiles} source files + bundles [${bundleNote}] + package.json, ` +
      `${report.coverage.bytesScanned} bytes → ${report.counts.violations} violation(s) [${report.verdict}]`,
  )
  for (const violation of report.violations) {
    console.error(`  ${violation.file}:${violation.line} ${violation.rule}: ${violation.detail}`)
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
