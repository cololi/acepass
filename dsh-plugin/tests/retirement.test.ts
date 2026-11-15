/**
 * B9 — the residual check must stay honest.
 *
 * `scripts/retirement-check.mjs` is the executable claim that the plugin runs with no Celery, Redis,
 * AMQP, PostgreSQL or Docker. A check that always says "clean" would be worthless, so these tests pin
 * three things at once:
 *
 *   1. **the real tree is clean** — and the scan really covered the runtime entry points, not an
 *      empty directory;
 *   2. **prose is not a dependency** — the ported code legitimately explains PostgreSQL behaviour in
 *      comments, and those sentences must never turn the check red (a noisy gate gets disabled);
 *   3. **each rule still fires** — broker/database/container imports, URLs, broker ports, env names,
 *      shell-outs and manifest dependencies are detected on fixtures, so a future refactor of the
 *      scanner cannot quietly stop looking.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fromDate } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { enqueue, markProcessed } from '../src/store/outbox.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'retirement-check.mjs')

interface Violation {
  rule: string
  file: string
  line: number
  detail: string
  excerpt: string
}

interface Report {
  schema: number
  ok: boolean
  verdict: string
  generatedAt: string
  root: string
  coverage: {
    sourceFiles: number
    bundles: Array<{ path: string; present: boolean; bytes: number }>
    required: Array<{ path: string; present: boolean; bytes: number }>
    keyFiles: Array<{ path: string; present: boolean; bytes: number }>
    bytesScanned: number
    files?: Array<{ path: string; bytes: number; kind: string }>
  }
  package: { name: string | null; dependencies: Record<string, string[]> } | null
  counts: { violations: number; byRule: Record<string, number> }
  violations: Violation[]
}

interface CheckModule {
  scanTree: (root?: string, options?: { listFiles?: boolean }) => Report
  scanSource: (relPath: string, source: string) => Violation[]
  scanPackageJson: (relPath: string, text: string) => Violation[]
  RULE_IDS: string[]
  REQUIRED_FILES: string[]
  BUNDLE_FILES: string[]
  BROKER_MODULES: Set<string>
  DATABASE_MODULES: Set<string>
  CONTAINER_MODULES: Set<string>
}

const check = (await import(pathToFileURL(SCRIPT).href)) as CheckModule

/** A tree the scanner accepts as complete, so a fixture failure can only come from the injected line. */
function completeTree(overrides: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "fixture",\n  "dependencies": {}\n}\n',
  }
  for (const required of check.REQUIRED_FILES) {
    if (required === 'package.json') continue
    files[required] = 'export {}\n'
  }
  return { ...files, ...overrides }
}

function makeTree(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'acepass-retirement-'))
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = join(directory, relPath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return directory
}

function withTree<T>(files: Record<string, string>, body: (directory: string) => T): T {
  const directory = makeTree(files)
  try {
    return body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const rulesOf = (violations: Violation[]): string[] => violations.map((violation) => violation.rule)

// ---------------------------------------------------------------------------
// 1. The real tree
// ---------------------------------------------------------------------------

test('the plugin runtime carries zero Celery/Redis/Postgres/Docker references', () => {
  const report = check.scanTree(PLUGIN_ROOT, { listFiles: true })
  assert.deepEqual(report.violations, [], 'a violation means the runtime can reach a retired service')
  assert.equal(report.counts.violations, 0)
  assert.equal(report.verdict, 'clean')
  assert.equal(report.ok, true)
})

test('the scan covers the entry points, the store and the built bundles', () => {
  const report = check.scanTree(PLUGIN_ROOT, { listFiles: true })
  const scanned = new Set((report.coverage.files ?? []).map((entry) => entry.path))

  // Every file the runtime cannot work without must have been read; otherwise "0 violations" is
  // just an empty directory being green.
  for (const required of check.REQUIRED_FILES) {
    assert.ok(scanned.has(required), `${required} was not scanned`)
  }
  for (const anchor of ['src/jobs/worker.ts', 'src/store/outbox.ts', 'src/store/db.ts', 'src/services/practice.ts', 'src/http/mount.ts']) {
    assert.ok(scanned.has(anchor), `${anchor} was not scanned`)
  }
  assert.ok(scanned.has('package.json'), 'the manifest is part of the runtime surface')

  // A built bundle leaks a dependency that the sources do not show, so it is scanned when present.
  for (const bundle of report.coverage.bundles) {
    if (!bundle.present) continue
    assert.ok(scanned.has(bundle.path), `${bundle.path} exists but was not scanned`)
    assert.ok(bundle.bytes > 100_000, `${bundle.path} looks truncated (${bundle.bytes} bytes)`)
  }

  assert.ok(report.coverage.sourceFiles >= 100, `expected the whole src tree, saw ${report.coverage.sourceFiles} files`)
  assert.ok(report.coverage.bytesScanned > 1_000_000, 'the scan read suspiciously few bytes')
})

test('the manifest declares no broker, database-server or container dependency', () => {
  const report = check.scanTree(PLUGIN_ROOT)
  assert.equal(report.counts.byRule['dependency'], 0, 'a retired client was added to package.json')

  const declared = new Set(Object.values(report.package?.dependencies ?? {}).flat())
  for (const forbidden of ['redis', 'ioredis', 'celery', 'amqplib', 'bullmq', 'pg', 'postgres', 'dockerode']) {
    assert.ok(!declared.has(forbidden), `package.json still declares ${forbidden}`)
  }

  // The two runtime dependencies that do ship are in-process libraries (image and PDF decoding):
  // no socket, no daemon. If this set changes, the new entry has to pass the same test.
  assert.ok(declared.has('sharp'), 'sharp (in-process image decoding) is expected to remain a runtime dependency')
  assert.ok(declared.has('pdfjs-dist'), 'pdfjs-dist (in-process PDF parsing) is expected to remain a runtime dependency')
})

// ---------------------------------------------------------------------------
// 2. Prose is not a dependency
// ---------------------------------------------------------------------------

test('comments that describe Postgres, Redis or the old deployment are not violations', () => {
  const source = [
    "// import Redis from 'redis' — the Django broker, retired in B9",
    '/* redis://127.0.0.1:6379/0 and amqp://guest:guest@127.0.0.1:5672 were the dev defaults */',
    '/**',
    ' * Postgres `SELECT ... FOR UPDATE SKIP LOCKED` has no SQLite equivalent, so the store uses',
    ' * `BEGIN IMMEDIATE`. Deployment used `docker compose` with CELERY_BROKER_URL on port 6379.',
    ' */',
    'export const ok = 1',
    '',
  ].join('\n')
  assert.deepEqual(check.scanSource('fixture/prose.ts', source), [])
})

test('a template literal full of SQL quotes does not hide the next import', () => {
  // The lexer has to know that `'` inside a template is text: otherwise the template swallows the
  // rest of the file and a real dependency becomes invisible.
  const source = [
    'const sql = `SELECT * FROM "audit_outbox_event" WHERE topic = \'x\' -- not a comment`',
    "import { createClient } from 'redis'",
    '',
  ].join('\n')
  const violations = check.scanSource('fixture/template.ts', source)
  assert.equal(violations.length, 1, JSON.stringify(violations))
  assert.equal(violations[0].rule, 'import-broker')
  assert.equal(violations[0].line, 2)
})

test('lookalike specifiers and identifiers stay clean', () => {
  const source = [
    "import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'",
    "import { join } from 'node:path'",
    "import sharp from 'sharp'",
    "import { readStore } from './pg.ts'",
    "import type { Context } from '@deepseek-ai/cordis'",
    'const pg = 1',
    "const png = 'png'",
    "const note = 'PostgreSQL sorts NULLs last'",
    '',
  ].join('\n')
  assert.deepEqual(check.scanSource('fixture/lookalike.ts', source), [])
})

// ---------------------------------------------------------------------------
// 3. Every rule still fires
// ---------------------------------------------------------------------------

test('broker clients are detected in every import form', () => {
  const source = [
    "import { createClient } from 'ioredis'",
    "const amqp = require('amqplib')",
    "const queue = await import('bullmq')",
    "export * from 'redis'",
    '',
  ].join('\n')
  const violations = check.scanSource('fixture/imports.ts', source)
  assert.deepEqual(rulesOf(violations), ['import-broker', 'import-broker', 'import-broker', 'import-broker'])
  assert.deepEqual(violations.map((violation) => violation.line), [1, 2, 3, 4])
  assert.match(violations[0].detail, /ioredis/)
})

test('a database server client and a container client are detected', () => {
  const source = [
    "const pg = require('pg')",
    "import Docker from 'dockerode'",
    "import { Pool } from 'pg-pool'",
    '',
  ].join('\n')
  assert.deepEqual(rulesOf(check.scanSource('fixture/db.ts', source)), [
    'import-database',
    'import-container',
    'import-database',
  ])
})

test('URLs, broker ports and configuration env names are detected', () => {
  const source = [
    "const broker = 'redis://127.0.0.1:6379/0'",
    "const dsn = 'postgresql://acepass@db:5432/acepass'",
    'const key = process.env.CELERY_BROKER_URL',
    "const name = 'REDIS_URL'",
    '',
  ].join('\n')
  const violations = check.scanSource('fixture/config.ts', source)
  assert.deepEqual(rulesOf(violations).slice().sort(), [
    'env-broker',
    'env-broker',
    'network-port',
    'network-port',
    'url-broker',
    'url-database',
  ].sort())
  assert.deepEqual(Array.from(new Set(violations.map((violation) => violation.line))), [1, 2, 3, 4])
})

test('shelling out to the retired runtime is detected', () => {
  const source = [
    "const up = 'docker compose -f infra/docker/docker-compose.yml up -d'",
    "const beat = 'celery -A config beat -l INFO'",
    '',
  ].join('\n')
  assert.deepEqual(rulesOf(check.scanSource('fixture/shell.ts', source)), ['container-command', 'broker-command'])
})

test('a forbidden package in any dependency bucket is detected', () => {
  const text = JSON.stringify(
    {
      name: 'fixture',
      dependencies: { redis: '^4.6.0' },
      devDependencies: { pg: '^8.11.0' },
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.2.0' },
    },
    null,
    2,
  )
  const violations = check.scanPackageJson('package.json', text)
  assert.equal(violations.length, 2, JSON.stringify(violations))
  assert.deepEqual(rulesOf(violations), ['dependency', 'dependency'])
  assert.match(violations[0].excerpt, /"redis"/)
  assert.match(violations[1].excerpt, /"pg"/)
})

test('an unreadable manifest is a coverage failure, never a silent pass', () => {
  const violations = check.scanPackageJson('package.json', '{ not json')
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'coverage')
})

// ---------------------------------------------------------------------------
// 4. The CLI contract: JSON on stdout, exit 1 on violations
// ---------------------------------------------------------------------------

test('the CLI exits 0 on the real tree and prints a parseable report', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: PLUGIN_ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as Report
  assert.equal(report.ok, true)
  assert.equal(report.root, PLUGIN_ROOT)
  assert.equal(report.counts.violations, 0)
  assert.match(result.stderr, /0 violation\(s\) \[clean\]/)
})

test('the CLI exits 1 on a tree that re-introduces a broker', () => {
  withTree(completeTree({ 'src/jobs/worker.ts': "const queue = require('bullmq')\n" }), (directory) => {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', directory], { encoding: 'utf8' })
    assert.equal(result.status, 1, `expected a failing exit, got ${result.status}: ${result.stderr}`)
    const report = JSON.parse(result.stdout) as Report
    assert.equal(report.ok, false)
    assert.equal(report.verdict, 'violations')
    assert.ok(
      report.violations.some((violation) => violation.rule === 'import-broker' && violation.file === 'src/jobs/worker.ts'),
      JSON.stringify(report.violations),
    )
    assert.match(result.stderr, /import-broker/)
  })
})

test('a missing entry point fails the check instead of shrinking it', () => {
  withTree({ 'src/only.ts': 'export {}\n' }, (directory) => {
    const report = check.scanTree(directory)
    assert.equal(report.ok, false)
    const coverage = report.violations.filter((violation) => violation.rule === 'coverage')
    assert.ok(coverage.length >= check.REQUIRED_FILES.length - 1, JSON.stringify(report.violations))
    assert.ok(coverage.some((violation) => violation.file === 'src/index.ts'))
  })
})

test('an empty source tree can never report clean', () => {
  withTree({}, (directory) => {
    const report = check.scanTree(directory)
    assert.equal(report.ok, false)
    assert.ok(report.violations.some((violation) => violation.detail.includes('no source files found')))
  })
})

test('two scans of the same tree produce the same findings', () => {
  const first = check.scanTree(PLUGIN_ROOT)
  const second = check.scanTree(PLUGIN_ROOT)
  assert.deepEqual(second.violations, first.violations)
  assert.deepEqual(second.counts, first.counts)
  assert.deepEqual(
    second.coverage.bundles.map((bundle) => bundle.path),
    first.coverage.bundles.map((bundle) => bundle.path),
  )
})

// ---------------------------------------------------------------------------
// 5. D0: the pre-switch gate (`scripts/d0-check.mjs`)
// ---------------------------------------------------------------------------
//
// D0 is not "stop Django"; it is "prove nothing is in flight" (18 §4.3). The gate answers two
// questions and both must be "no":
//
//   a. is every produced `audit_outbox_event` row confirmed (`unresolved_summary() == {}`)?
//   b. does every row that *is* still unresolved name a topic this port can consume — including the
//      Django spellings that were renamed on import?
//
// The gate is driven through real `.acepass` files rather than `:memory:`, because `checkDatabase`
// opens the path with `readOnly: true` (a live switch runs against a file, and the read-only path is
// what these tests must exercise). Exit codes 0 / 3 / 2 are part of the contract, so the CLI is run
// as a child process as well as in-process.

interface D0Report {
  schema_version: number
  checked_at: string
  database: string
  outbox: { total: number; processed: number; unresolved: Record<string, number> }
  unknown_topics: Record<string, number>
  ok: boolean
}

interface D0Module {
  checkDatabase: (dbPath: string, now?: Date) => D0Report
  resolveDatabasePath: (
    options: { db?: string | null; dataRoot?: string | null },
    env?: Record<string, string | undefined>,
    cwd?: string,
  ) => string
}

const D0_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'd0-check.mjs')
const d0 = (await import(pathToFileURL(D0_SCRIPT).href)) as D0Module

interface OutboxRow {
  topic: string
  processed?: boolean
}

/**
 * Build one throwaway `.acepass` file, run the body against it, delete it.
 *
 * Rows are written through the real `enqueue`/`markProcessed`, so the fixture has the same column
 * semantics (status, processed_at, JSON payload) as an imported archive.
 */
function withOutbox(rows: OutboxRow[], body: (file: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'acepass-d0-'))
  const file = join(directory, 'acepass.sqlite')
  const store = openStore({ path: file })
  try {
    const now = fromDate(new Date('2026-01-01T00:00:00Z'))
    for (const row of rows) {
      const event = enqueue(store.db, { topic: row.topic, payload: {}, now })
      if (row.processed === true) {
        assert.equal(markProcessed(store.db, { eventId: event.id, now }), true, `could not confirm ${row.topic}`)
      }
    }
  } finally {
    store.close()
  }
  try {
    body(file)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const runD0 = (...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', D0_SCRIPT, ...args], { encoding: 'utf8' })

const digestOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

test('D0: an empty outbox is a safe switch', () => {
  withOutbox([], (file) => {
    const report = d0.checkDatabase(file)
    assert.equal(report.ok, true)
    assert.deepEqual(report.outbox, { total: 0, processed: 0, unresolved: {} })
    assert.deepEqual(report.unknown_topics, {})
  })
})

test('D0: a confirmed event is resolved, a pending one is not', () => {
  withOutbox(
    [
      { topic: 'evidence.rebuild_for_attempt', processed: true },
      { topic: 'evidence.rebuild_for_attempt' },
    ],
    (file) => {
      const report = d0.checkDatabase(file)
      assert.equal(report.ok, false, 'one pending row is enough to block the switch')
      assert.deepEqual(report.outbox, {
        total: 2,
        processed: 1,
        unresolved: { pending: 1 },
      })
      assert.deepEqual(report.unknown_topics, {}, 'a known topic is unresolved, not unknown')
    },
  )
})

test('D0: an unhandled topic is named instead of counted as safe', () => {
  withOutbox([{ topic: 'nobody.handles.this' }], (file) => {
    const report = d0.checkDatabase(file)
    assert.equal(report.ok, false)
    // The name has to survive: an operator needs to know *which* import would be stranded.
    assert.deepEqual(report.unknown_topics, { 'nobody.handles.this': 1 })
    assert.deepEqual(report.outbox.unresolved, { pending: 1 })
  })
})

test('D0: the Django spellings and ported topics are understood', () => {
  withOutbox(
    [
      // Renamed on import (`TOPIC_ALIASES` in src/jobs/worker.ts).
      { topic: 'projection.rebuild_attempt_evidence' },
      // Django producer, consumer ported in B10 (F4).
      { topic: 'learning.on_session_finished' },
      { topic: 'projection.rebuild_after_answer_change' },
      // This port's spelling and Django's spelling of the same work.
      { topic: 'plan.generated' },
      { topic: 'learning.reconcile_plan' },
    ],
    (file) => {
      const report = d0.checkDatabase(file)
      assert.deepEqual(report.unknown_topics, {}, 'each of these topics has a handler or an alias')
      // Understanding the topic does not resolve it: D0 needs both halves, so this is still unsafe.
      assert.equal(report.ok, false)
      assert.deepEqual(report.outbox.unresolved, { pending: 5 })
    },
  )
})

test('D0 CLI: 0 when safe, 3 when not, 2 when the database cannot be read', () => {
  withOutbox([], (file) => {
    const safe = runD0('--db', file)
    assert.equal(safe.status, 0, safe.stderr)
    const report = JSON.parse(safe.stdout) as D0Report
    assert.equal(report.ok, true)
    assert.equal(report.database, file)
    assert.match(safe.stderr, /0\/0 processed/)
    assert.match(safe.stderr, /SAFE/)
  })

  withOutbox([{ topic: 'evidence.rebuild_for_attempt' }], (file) => {
    const blocked = runD0('--db', file)
    assert.equal(blocked.status, 3, blocked.stderr)
    const report = JSON.parse(blocked.stdout) as D0Report
    assert.equal(report.ok, false)
    assert.deepEqual(report.outbox.unresolved, { pending: 1 })
    assert.match(blocked.stderr, /NOT SAFE/)
  })

  withOutbox([{ topic: 'nobody.handles.this' }], (file) => {
    const blocked = runD0('--db', file)
    assert.equal(blocked.status, 3, blocked.stderr)
    assert.match(blocked.stderr, /unknown topics \{"nobody\.handles\.this":1\}/)
  })

  const missing = runD0('--db', join(tmpdir(), 'acepass-d0-missing', 'acepass.sqlite'))
  assert.equal(missing.status, 2, missing.stderr)
  assert.match(missing.stderr, /database not found/)
})

test('D0 inspects the database without changing a byte or a row', () => {
  withOutbox(
    [
      { topic: 'evidence.rebuild_for_attempt' },
      { topic: 'learning.on_session_finished', processed: true },
    ],
    (file) => {
      const before = digestOf(file)
      const first = d0.checkDatabase(file)
      const second = d0.checkDatabase(file)
      assert.equal(digestOf(file), before, 'the gate must not rewrite the database it is judging')
      assert.deepEqual(second.outbox, first.outbox, 'the second read sees the same rows')
      assert.deepEqual(second.unknown_topics, first.unknown_topics)
      // SQLite still materialises a write-ahead log beside a read-only WAL database. An empty file is
      // a side effect of opening, not a committed frame; a non-empty one would mean a real write.
      const wal = `${file}-wal`
      if (existsSync(wal)) assert.equal(statSync(wal).size, 0, 'a read-only check wrote frames')
    },
  )
})

test('D0 resolves the database path in the documented order', () => {
  const env = { ACEPASS_DATA_ROOT: '/tmp/env-root', ACEPASS_DB: '/tmp/env-db.sqlite' }
  assert.equal(d0.resolveDatabasePath({ db: '/x.sqlite', dataRoot: '/y' }, env, '/cwd'), '/x.sqlite')
  assert.equal(d0.resolveDatabasePath({ dataRoot: '/y' }, env, '/cwd'), '/y/acepass.sqlite')
  assert.equal(d0.resolveDatabasePath({}, env, '/cwd'), '/tmp/env-root/acepass.sqlite')
  assert.equal(d0.resolveDatabasePath({}, { ACEPASS_DB: '/tmp/env-db.sqlite' }, '/cwd'), '/tmp/env-db.sqlite')
  assert.equal(d0.resolveDatabasePath({}, {}, '/cwd'), '/cwd/.acepass/acepass.sqlite')
})
