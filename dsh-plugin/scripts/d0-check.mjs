#!/usr/bin/env node
/**
 * B10 D0 gate — "is this `.acepass` database safe to own the async chain?"
 *
 * Retirement step D0 (18 §4.3) is not "stop Django"; it is "prove nothing is in flight". The two
 * conditions that make a switch safe are:
 *
 *   1. `audit_outbox_event` has **no unresolved rows** (`unresolved_summary() == {}`): every event
 *      the old implementation produced was confirmed by a consumer;
 *   2. every unresolved row that *does* exist names a topic this port actually consumes. A pending
 *      Django topic whose name changed would otherwise become a permanent "no handler" failure after
 *      import (18 §4.5 F3).
 *
 * The check is read-only on purpose: D0 runs against a live database and must not create a schema,
 * rewrite a row, or drain anything. It opens the file with `readOnly: true`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/d0-check.mjs --db /path/to/acepass.sqlite
 *   node --experimental-strip-types scripts/d0-check.mjs --data-root /path/to/.acepass
 *   ACEPASS_DATA_ROOT=/path/to/.acepass node --experimental-strip-types scripts/d0-check.mjs
 *   node --experimental-strip-types scripts/d0-check.mjs --db ... --out var/b10/d0.json
 *
 * Exit codes: 0 = safe (nothing unresolved and every topic is understood), 3 = not safe,
 *             2 = usage / missing file / not a database.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { outboxHealth } from '../src/jobs/worker.ts'

function usage() {
  return [
    'usage: node --experimental-strip-types scripts/d0-check.mjs (--db <file> | --data-root <dir>) [--out <file>]',
    '',
    '  --db <file>        path to acepass.sqlite',
    '  --data-root <dir>  directory containing acepass.sqlite',
    '  --out <file>       also write the JSON report to this path',
    '',
    'Exit codes: 0 safe, 3 not safe, 2 usage or unreadable database.',
  ].join('\n')
}

function parseArgs(argv) {
  const options = { db: null, dataRoot: null, out: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--db') options.db = argv[++index] ?? null
    else if (arg === '--data-root' || arg === '--dataRoot') options.dataRoot = argv[++index] ?? null
    else if (arg === '--out') options.out = argv[++index] ?? null
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--db=')) options.db = arg.slice('--db='.length)
    else if (arg.startsWith('--data-root=')) options.dataRoot = arg.slice('--data-root='.length)
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return options
}

/** Same resolution order as `db-backup`/`db-restore`: `--db` → `--data-root` → env → cwd. */
export function resolveDatabasePath(options, env = process.env, cwd = process.cwd()) {
  if (options.db) return resolve(options.db)
  const root = options.dataRoot ?? env.ACEPASS_DATA_ROOT
  if (root) return join(resolve(root), 'acepass.sqlite')
  if (env.ACEPASS_DB) return resolve(env.ACEPASS_DB)
  return join(cwd, '.acepass', 'acepass.sqlite')
}

/**
 * Inspect one database without writing to it.
 *
 * Returns the report object rather than exiting so the tests can drive it; `main` owns the exit codes.
 */
export function checkDatabase(dbPath, now = new Date()) {
  if (!existsSync(dbPath)) {
    throw Object.assign(new Error(`database not found: ${dbPath}`), { code: 'db_missing' })
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const health = outboxHealth(db)
    const total = Number(
      db.prepare('SELECT COUNT(*) AS n FROM "audit_outbox_event"').get()?.n ?? 0,
    )
    const processed = Number(
      db.prepare('SELECT COUNT(*) AS n FROM "audit_outbox_event" WHERE "processed_at" IS NOT NULL').get()?.n ?? 0,
    )
    return {
      schema_version: 1,
      checked_at: now.toISOString(),
      database: dbPath,
      outbox: { total, processed, unresolved: health.unresolved },
      unknown_topics: health.unknown_topics,
      ok: health.ok,
    }
  } finally {
    db.close()
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`d0-check: ${error instanceof Error ? error.message : String(error)}\n${usage()}`)
    process.exit(2)
  }
  if (options.help) {
    console.log(usage())
    process.exit(0)
  }

  const dbPath = resolveDatabasePath(options)
  let report
  try {
    report = checkDatabase(dbPath)
  } catch (error) {
    console.error(`d0-check: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const json = `${JSON.stringify(report, null, 2)}\n`
  if (options.out) {
    try {
      writeFileSync(options.out, json)
    } catch (error) {
      console.error(`d0-check: cannot write ${options.out}: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
  }
  process.stdout.write(json)

  const unresolved = Object.entries(report.outbox.unresolved)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ')
  console.error(
    `d0-check: ${report.outbox.processed}/${report.outbox.total} processed` +
      `${unresolved === '' ? '' : `; unresolved [${unresolved}]`}` +
      `; unknown topics ${JSON.stringify(report.unknown_topics)} → ${report.ok ? 'SAFE' : 'NOT SAFE'}`,
  )
  process.exit(report.ok ? 0 : 3)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
