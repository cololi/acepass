#!/usr/bin/env node
/**
 * B9 recon — one command from a live PostgreSQL database to a reconciled `.acepass` store.
 *
 * Pipeline (each stage is a separate process or a separate module, so a failure names itself):
 *
 *   PostgreSQL ──export_db.py──▶ archive (manifest + JSONL) ──importArchive──▶ node:sqlite
 *        │                              │                                      │
 *        │                        manifest digests                    reconcileArchive
 *        │                                                                     │
 *        └──── independent aggregate SQL (psycopg) ◀── compared ──▶ aggregate SQL (node:sqlite)
 *
 * Exit codes: `0` every check passed, `1` the archive/store does not reconcile or the statistics
 * disagree, `2` bad usage or a missing tool, `3` the source database cannot be exported (for
 * example: it is behind the code's migrations and `--migrate-copy` was not given).
 *
 * A source database that predates the current Django migrations cannot be exported by the
 * current schema spec — `export_db.py` would ask for columns the database does not have. The
 * driver detects that (introspection, not guessing) and:
 *  - without `--migrate-copy` it **fails**, naming every missing table and column; it never
 *    silently exports a subset, because "reconciled 51 of 59 tables" is not a migration;
 *  - with `--migrate-copy` it clones the database (`CREATE DATABASE ... TEMPLATE`, falling back
 *    to `pg_dump | psql` when a dev server holds a connection), applies Django's own migrations
 *    to the clone, and exports the clone. The named source database is only ever read.
 *
 * What is compared, and why these three:
 *   1. row counts per table        — the manifest says how many rows each table has;
 *   2. per-table row digests      — sha256 of the canonical JSON rows, computed on both sides;
 *   3. statistics                 — learner-visible aggregates recomputed independently from
 *      the source database and from the imported store (never from the archive), so a
 *      systematic value change that preserves counts and shapes is still caught.
 *
 * Usage:
 *   node --experimental-strip-types scripts/reconcile_db.mjs \
 *     --database acepass --out var/b9/recon-acepass [--migrate-copy] [--tables-json path] \
 *     [--archive dir] [--python path] [--copy-name name] [--quiet]
 *
 * `--archive` re-verifies an archive that already exists instead of exporting a new one (the
 * source database is still queried for the statistics); that is also how the failure modes are
 * tested without touching a real database.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { Decimal } from '../src/domain/decimal.ts'
import { parseInstant } from '../src/domain/instant.ts'
import { importArchive, readArchive, readManifest, reconcileArchive, tableDigest } from '../src/migrate/archive.ts'
import { openStore } from '../src/store/db.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(PLUGIN, '..')
const BACKEND = join(REPO, 'backend')
const DRIVER = join('scripts', 'reconcile_db.mjs')
const HELPERS = join('scripts', 'reconcile_stats.py')
const EXPORTER = join('scripts', 'export_db.py')

/** The importer needs a clock for `created_at`/`updated_at` fallbacks; every archive row has both. */
const IMPORT_CLOCK = parseInstant('2027-03-01T00:00:00+00:00')
const DEFAULT_SETTINGS = 'config.settings.dev'

/**
 * The statistics both sides compute, from **the same SQL**, against their own engine.
 *
 * The SQL is deliberately portable (plain `count`, an inner join, no engine-specific functions),
 * and every statement returns one column named `v`. `decimal_sum` is summed in decimal arithmetic
 * on each side and compared as a two-decimal string, because a float sum would hide cent-level
 * drift and a `SUM()` over SQLite's TEXT decimals would round through REAL.
 */
export const STATISTICS = Object.freeze([
  { name: 'users', kind: 'count', sql: 'SELECT count(*) AS v FROM "accounts_user"' },
  { name: 'projects', kind: 'count', sql: 'SELECT count(*) AS v FROM "exams_project"' },
  { name: 'subjects', kind: 'count', sql: 'SELECT count(*) AS v FROM "exams_subject"' },
  { name: 'questions', kind: 'count', sql: 'SELECT count(*) AS v FROM "question_bank_question"' },
  {
    name: 'published_question_versions',
    kind: 'count',
    sql: "SELECT count(*) AS v FROM \"question_bank_question_version\" WHERE \"status\" = 'published'",
  },
  { name: 'sessions', kind: 'count', sql: 'SELECT count(*) AS v FROM "practice_session"' },
  { name: 'attempts', kind: 'count', sql: 'SELECT count(*) AS v FROM "practice_attempt"' },
  {
    name: 'confirmed_attempts',
    kind: 'count',
    sql:
      'SELECT count(*) AS v FROM "practice_attempt" a ' +
      'JOIN "practice_grade_event" g ON g."id" = a."current_grade_event_id" ' +
      "WHERE g.\"status\" = 'confirmed'",
  },
  {
    name: 'confirmed_score_total',
    kind: 'decimal_sum',
    sql:
      'SELECT g."confirmed_score" AS v FROM "practice_attempt" a ' +
      'JOIN "practice_grade_event" g ON g."id" = a."current_grade_event_id" ' +
      "WHERE g.\"status\" = 'confirmed' AND g.\"confirmed_score\" IS NOT NULL",
  },
  { name: 'grade_events', kind: 'count', sql: 'SELECT count(*) AS v FROM "practice_grade_event"' },
  { name: 'study_tasks', kind: 'count', sql: 'SELECT count(*) AS v FROM "learning_study_task"' },
  { name: 'study_plans', kind: 'count', sql: 'SELECT count(*) AS v FROM "learning_study_plan"' },
  { name: 'exposure_events', kind: 'count', sql: 'SELECT count(*) AS v FROM "practice_exposure_event"' },
])

export class ReconError extends Error {
  constructor(code, message, exitCode = 2, details = {}) {
    super(message)
    this.name = 'ReconError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

const log = (options, message) => {
  if (!options.quiet) process.stderr.write(`[reconcile] ${message}\n`)
}

/** `--key value` / `--flag`; unknown arguments are a usage error rather than silently ignored. */
export function parseArgs(argv) {
  const options = {
    database: null,
    out: null,
    tablesJson: null,
    archive: null,
    migrateCopy: false,
    python: null,
    copyName: null,
    quiet: false,
  }
  const valued = new Map([
    ['--database', 'database'],
    ['--out', 'out'],
    ['--tables-json', 'tablesJson'],
    ['--archive', 'archive'],
    ['--python', 'python'],
    ['--copy-name', 'copyName'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (valued.has(argument)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new ReconError('usage', `${argument} needs a value`)
      }
      options[valued.get(argument)] = value
      index += 1
    } else if (argument === '--migrate-copy') {
      options.migrateCopy = true
    } else if (argument === '--quiet') {
      options.quiet = true
    } else if (argument === '--help' || argument === '-h') {
      throw new ReconError('usage', 'see the header of scripts/reconcile_db.mjs for usage')
    } else {
      throw new ReconError('usage', `unknown argument ${argument}`)
    }
  }
  if (options.database === null) throw new ReconError('usage', '--database is required')
  if (options.out === null) throw new ReconError('usage', '--out is required')
  return options
}

/** Schema spec vs what the database actually has: the difference is reported, never guessed away. */
export function schemaCoverage(spec, introspection) {
  const present = new Set(introspection.tables ?? [])
  const columnsByTable = introspection.columns ?? {}
  const missingTables = []
  const missingColumns = []
  for (const table of spec.tables ?? []) {
    if (!present.has(table.name)) {
      missingTables.push(table.name)
      continue
    }
    const available = new Set(columnsByTable[table.name] ?? [])
    const lacking = (table.columns ?? []).map((column) => column.name).filter((name) => !available.has(name))
    if (lacking.length > 0) missingColumns.push({ table: table.name, columns: lacking })
  }
  return {
    complete: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    presentTables: (spec.tables ?? []).length - missingTables.length,
    schemaTables: (spec.tables ?? []).length,
  }
}

/** The same SQL as `reconcile_stats.py`, evaluated on the imported store. */
export function statisticsForStore(db) {
  const values = {}
  for (const statistic of STATISTICS) {
    const rows = db.prepare(statistic.sql).all()
    if (statistic.kind === 'count') {
      values[statistic.name] = Number(rows[0]?.v ?? 0)
      continue
    }
    let total = Decimal.zero()
    for (const row of rows) {
      if (row.v === null || row.v === undefined) continue
      total = total.add(Decimal.parse(String(row.v)))
    }
    values[statistic.name] = total.quantize(-2).toString()
  }
  return values
}

/** Compare two statistic maps; `differ` names every statistic whose value is not identical. */
export function compareStatistics(expected, actual) {
  const items = STATISTICS.map((statistic) => {
    const source = expected?.[statistic.name]
    const store = actual?.[statistic.name]
    return {
      name: statistic.name,
      kind: statistic.kind,
      sql: statistic.sql,
      expected: source ?? null,
      actual: store ?? null,
      ok: source !== undefined && source !== null && String(source) === String(store),
    }
  })
  return {
    ok: items.every((item) => item.ok),
    total: items.length,
    equal: items.filter((item) => item.ok).length,
    differ: items.filter((item) => !item.ok).map((item) => item.name),
    items,
  }
}

/**
 * The archive's own provenance: does every row file still hash to the digest the manifest
 * recorded?
 *
 * `reconcileArchive` compares the imported store against the rows in the JSONL files, which proves
 * the importer wrote what it read — but not that the files still match what the Python exporter
 * measured in PostgreSQL (`reconcileArchive` recomputes the expected digest from those same files,
 * so a corrupted archive would agree with itself). The manifest digest is the cross-language
 * contract, so it is checked here, before the import, and a mismatch is a hard failure.
 */
export function checkManifestDigests(archive) {
  const entries = archive.manifest.tables.map((table) => {
    const recomputed = tableDigest(archive.rows.get(table.name) ?? [], table.columns)
    return {
      table: table.name,
      rows: (archive.rows.get(table.name) ?? []).length,
      recorded: table.digest,
      recomputed,
      ok: table.digest === recomputed && table.rows === (archive.rows.get(table.name) ?? []).length,
    }
  })
  return {
    ok: entries.every((entry) => entry.ok),
    total: entries.length,
    equal: entries.filter((entry) => entry.ok).length,
    mismatches: entries.filter((entry) => !entry.ok),
  }
}

function resolvePython(options) {
  const candidate = options.python ?? process.env.ACEPASS_PYTHON ?? join(BACKEND, '.venv', 'bin', 'python')
  const path = resolve(candidate)
  if (!existsSync(path)) {
    throw new ReconError(
      'python_missing',
      `the Django virtualenv python was not found at ${path} (pass --python or set ACEPASS_PYTHON)`,
      2,
    )
  }
  return path
}

/** Run a child process and fail with the child's own error text. */
function run(command, args, { env = {}, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: PLUGIN,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error !== undefined && result.error !== null) {
    throw new ReconError('process_failed', `${command} could not start: ${result.error.message}`, 3)
  }
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (!quiet && stderr !== '') process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`)
  if (result.status !== 0) {
    let detail = stderr
    const lines = stderr.split('\n').filter((line) => line.trim() !== '')
    const last = lines.at(-1)
    if (last !== undefined) {
      try {
        const parsed = JSON.parse(last)
        if (typeof parsed?.error?.message === 'string') detail = parsed.error.message
      } catch {
        /* plain text error, keep it */
      }
    }
    throw new ReconError('command_failed', `${command} ${args.slice(0, 2).join(' ')} failed (exit ${result.status}): ${detail}`, 3, {
      stdout,
      stderr,
    })
  }
  return stdout
}

function pythonJson(python, args, options = {}) {
  const stdout = run(python, [HELPERS, ...args], options)
  const last = stdout.split('\n').filter((line) => line.trim() !== '').at(-1)
  if (last === undefined) throw new ReconError('bad_output', `${args[0]} printed nothing`, 3)
  return JSON.parse(last)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

/** Build the one-line summary the caller parses; the full evidence lives in `report.json`. */
function summarise(report) {
  return {
    ok: report.ok,
    dataOk: report.data_ok ?? report.ok,
    database: report.source.database,
    exportDatabase: report.source.export_database,
    tables: {
      schema: report.archive.schema_tables,
      declaredModels: report.archive.declared_models,
      autoCreated: (report.archive.auto_created_tables ?? []).length,
      exported: report.archive.tables,
      rows: report.archive.rows,
      nonEmpty: report.archive.non_empty_tables,
      rowsEqual: report.reconciliation.rows_equal,
      digestEqual: report.reconciliation.digest_equal,
      manifestDigestEqual: report.archive.digest_check?.equal ?? 0,
    },
    statistics: {
      total: report.statistics.total,
      equal: report.statistics.equal,
      differ: report.statistics.differ,
    },
    manifestSha256: report.archive.manifest_sha256,
    contentSha256: report.archive.content_sha256,
    durationMs: report.duration_ms,
    ...(report.error === undefined ? {} : { error: report.error }),
    ...(report.problems.length === 0 ? {} : { problems: report.problems }),
  }
}

/**
 * The pipeline. Synchronous on purpose: every stage is a child process or a synchronous
 * `node:sqlite` call, so a promise would only add failure modes.
 */
export function reconcileSync(options) {
  const startedAt = Date.now()
  const outDir = resolve(options.out)
  mkdirSync(outDir, { recursive: true })
  const archiveDir = options.archive === null ? join(outDir, 'archive') : resolve(options.archive)
  const tablesPath = options.tablesJson === null ? join(outDir, 'tables.json') : resolve(options.tablesJson)
  const statisticsPath = join(outDir, 'statistics-spec.json')
  const python = resolvePython(options)

  const state = { copyDatabase: null, store: null, workDir: null }
  const timings = {}
  let report = null

  try {
    // 1. The schema spec the exporter exports and the archive stores.
    if (options.tablesJson === null) {
      const stdout = run(process.execPath, ['--experimental-strip-types', join('scripts', 'schema_tables.mjs'), tablesPath])
      log(options, stdout)
    }
    const spec = JSON.parse(readFileSync(tablesPath, 'utf8'))
    writeFileSync(
      statisticsPath,
      JSON.stringify({ statistics: STATISTICS.map(({ name, kind, sql }) => ({ name, kind, sql })) }, null, 2),
      'utf8',
    )

    // 2. What does the source actually have, and what do its own aggregates say?
    const introspection = pythonJson(python, ['introspect', '--database', options.database])
    writeFileSync(join(outDir, 'source-introspection.json'), JSON.stringify(introspection, null, 2), 'utf8')
    const coverage = schemaCoverage(spec, introspection)
    // 57 declared models + 2 auto-created M2M through tables = 59 schema tables. Read from
    // Django's registry rather than hard-coded, and check the arithmetic against the spec.
    const models = pythonJson(python, ['models'])
    const modelSplit = {
      declared_models: models.declared_models,
      model_tables: models.model_tables,
      auto_created_tables: models.auto_created_tables,
      schema_tables: spec.tables.length,
      consistent:
        models.model_tables === spec.tables.length &&
        models.auto_created_tables.every((name) => spec.tables.some((table) => table.name === name)),
    }
    if (!modelSplit.consistent) {
      throw new ReconError(
        'schema_spec_mismatch',
        `the schema spec (${spec.tables.length} tables) and Django's model registry ` +
          `(${models.model_tables} tables, ${models.auto_created_tables.length} auto-created) disagree`,
        3,
        modelSplit,
      )
    }

    let baseline = null
    let baselineError = null
    try {
      baseline = pythonJson(python, ['stats', '--database', options.database, '--spec', statisticsPath]).statistics
    } catch (error) {
      baselineError = error.message
      log(options, `source statistics unavailable on ${options.database}: ${error.message}`)
    }

    // 3. Pick the database to export. A source behind the schema is a hard failure unless the
    //    caller explicitly asked for a migrated clone (the real database is never written).
    let exportDatabase = options.database
    let migratedCopy = false
    let copyMethod = null
    let exportInfo = null
    if (options.archive === null) {
      if (!coverage.complete) {
        if (!options.migrateCopy) {
          throw new ReconError(
            'source_schema_mismatch',
            `the source database ${options.database} is behind the current schema: ` +
              `${coverage.missingTables.length} table(s) and ${coverage.missingColumns.length} table(s) with ` +
              'missing columns; pass --migrate-copy to export a migrated clone instead',
            3,
            coverage,
          )
        }
        const copyName = options.copyName ?? `acepass_recon_${stamp()}_${process.pid}`
        state.copyDatabase = copyName
        log(options, `cloning ${options.database} → ${copyName} and applying Django migrations`)
        const copyInfo = pythonJson(python, ['copy', '--source', options.database, '--target', copyName])
        copyMethod = copyInfo.method ?? null
        log(options, `clone method: ${copyMethod}`)
        pythonJson(python, ['migrate', '--database', copyName])
        const copyIntrospection = pythonJson(python, ['introspect', '--database', copyName])
        writeFileSync(join(outDir, 'export-db-introspection.json'), JSON.stringify(copyIntrospection, null, 2), 'utf8')
        const copyCoverage = schemaCoverage(spec, copyIntrospection)
        if (!copyCoverage.complete) {
          throw new ReconError(
            'source_schema_mismatch',
            `the migrated clone ${copyName} still does not match the schema spec`,
            3,
            copyCoverage,
          )
        }
        exportDatabase = copyName
        migratedCopy = true
      }

      log(options, `exporting ${exportDatabase} with scripts/export_db.py`)
      const exportStarted = Date.now()
      const stdout = run(
        python,
        [EXPORTER, '--out', archiveDir, '--tables-json', tablesPath],
        {
          env: {
            DJANGO_SETTINGS_MODULE: process.env.ACEPASS_DJANGO_SETTINGS ?? DEFAULT_SETTINGS,
            POSTGRES_DB: exportDatabase,
            PYTHONPATH: BACKEND,
          },
        },
      )
      timings.export_ms = Date.now() - exportStarted
      const last = stdout.split('\n').filter((line) => line.trim() !== '').at(-1)
      exportInfo = JSON.parse(last)
    }

    // 4. The archive is the contract: read it once, digest the manifest, then import it.
    const manifest = readManifest(archiveDir)
    const manifestSha256 = sha256(readFileSync(join(archiveDir, 'manifest.json')))
    // A byte-level manifest hash changes between runs only because the scratch clone's name is in
    // `source.database`; this content hash covers what the reconciliation actually asserts, so two
    // runs over the same data can be compared for equality.
    const contentSha256 = sha256(
      JSON.stringify(
        manifest.tables
          .map((table) => ({ table: table.name, rows: table.rows, digest: table.digest }))
          .sort((left, right) => left.table.localeCompare(right.table)),
      ),
    )
    const archive = readArchive(archiveDir)
    const manifestCheck = checkManifestDigests(archive)

    state.workDir = mkdtempSync(join(tmpdir(), 'acepass-recon-'))
    const storePath = join(state.workDir, 'acepass.sqlite')
    state.store = openStore({ path: storePath })

    log(options, `importing ${manifest.tables.length} tables into a fresh SQLite store`)
    const importStarted = Date.now()
    const importReport = importArchive(state.store.db, archive, IMPORT_CLOCK)
    timings.import_ms = Date.now() - importStarted

    const reconcileStarted = Date.now()
    const reconciliation = reconcileArchive(state.store.db, archive)
    timings.reconcile_ms = Date.now() - reconcileStarted

    // 5. Independent aggregates: source engine vs SQLite, same SQL, no archive involved.
    const statisticsStarted = Date.now()
    const storeStatistics = statisticsForStore(state.store.db)
    const exportStatistics =
      exportDatabase === options.database && baseline !== null
        ? baseline
        : pythonJson(python, ['stats', '--database', exportDatabase, '--spec', statisticsPath]).statistics
    const comparison = compareStatistics(exportStatistics, storeStatistics)
    timings.statistics_ms = Date.now() - statisticsStarted

    // A migrated clone is expected to keep every row; a delta here means a migration rewrote data.
    const baselineDelta =
      migratedCopy && baseline !== null ? compareStatistics(baseline, exportStatistics) : null

    const problems = [...reconciliation.problems]
    for (const entry of manifestCheck.mismatches) {
      problems.push(
        `archive digest mismatch: ${entry.table} (manifest ${entry.recorded.slice(0, 12)} != rows ${entry.recomputed.slice(0, 12)}, ${entry.rows} rows)`,
      )
    }
    for (const item of comparison.items.filter((entry) => !entry.ok)) {
      problems.push(`statistic ${item.name}: source ${String(item.expected)} != store ${String(item.actual)}`)
    }
    const dataOk = reconciliation.ok && comparison.ok
    const ok = dataOk && manifestCheck.ok

    report = {
      ok,
      data_ok: dataOk,
      generated_at: new Date().toISOString(),
      duration_ms: 0,
      timings,
      source: {
        database: options.database,
        export_database: exportDatabase,
        export_mode: options.archive === null ? (migratedCopy ? 'migrated-copy' : 'direct') : 'existing-archive',
        copy_method: copyMethod,
        backend: BACKEND,
        django_version: manifest.source.django_version,
        server_version: introspection.server_version,
        schema: {
          complete: coverage.complete,
          schema_tables: coverage.schemaTables,
          present_tables: coverage.presentTables,
          missing_tables: coverage.missingTables,
          missing_columns: coverage.missingColumns,
          declared_models: modelSplit.declared_models,
          model_tables: modelSplit.model_tables,
          auto_created_tables: modelSplit.auto_created_tables,
          consistent: modelSplit.consistent,
        },
        baseline_statistics: baseline,
        baseline_error: baselineError,
        baseline_delta: baselineDelta,
      },
      archive: {
        dir: archiveDir,
        manifest_sha256: manifestSha256,
        content_sha256: contentSha256,
        format_version: manifest.format_version,
        source: manifest.source,
        schema_tables: spec.tables.length,
        declared_models: modelSplit.declared_models,
        auto_created_tables: modelSplit.auto_created_tables,
        tables: manifest.tables.length,
        rows: manifest.tables.reduce((sum, table) => sum + table.rows, 0),
        non_empty_tables: manifest.tables.filter((table) => table.rows > 0).length,
        empty_tables: manifest.tables.filter((table) => table.rows === 0).map((table) => table.name),
        exported: exportInfo,
        missing_models: manifest.missing_models ?? [],
        digest_check: {
          ok: manifestCheck.ok,
          total: manifestCheck.total,
          equal: manifestCheck.equal,
          mismatches: manifestCheck.mismatches,
        },
        tables_detail: manifest.tables.map((table) => ({
          table: table.name,
          rows: table.rows,
          digest: table.digest,
          ...(table.no_model === true ? { no_model: true } : {}),
        })),
      },
      import: {
        tables: importReport.tables,
        rows: importReport.rows,
        sqlite_path: storePath,
        ephemeral: true,
      },
      reconciliation: {
        ok: reconciliation.ok,
        tables: reconciliation.tables.length,
        rows_equal: reconciliation.tables.filter((table) => table.expectedRows === table.actualRows).length,
        digest_equal: reconciliation.tables.filter((table) => table.expectedDigest === table.actualDigest).length,
        mismatches: reconciliation.tables
          .filter((table) => !table.ok)
          .map((table) => ({
            table: table.table,
            expected_rows: table.expectedRows,
            actual_rows: table.actualRows,
            expected_digest: table.expectedDigest,
            actual_digest: table.actualDigest,
          })),
      },
      statistics: {
        ok: comparison.ok,
        total: comparison.total,
        equal: comparison.equal,
        differ: comparison.differ,
        items: comparison.items,
      },
      problems,
    }
    report.duration_ms = Date.now() - startedAt
    report.summary = summarise(report)
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return report
  } catch (error) {
    const failure = {
      ok: false,
      data_ok: false,
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      timings,
      source: { database: options.database, export_database: state.copyDatabase ?? options.database },
      archive: {
        dir: archiveDir,
        tables: 0,
        rows: 0,
        schema_tables: 0,
        declared_models: 0,
        auto_created_tables: [],
        non_empty_tables: 0,
        empty_tables: [],
        manifest_sha256: null,
        content_sha256: null,
      },
      reconciliation: { ok: false, tables: 0, rows_equal: 0, digest_equal: 0, mismatches: [] },
      statistics: { ok: false, total: STATISTICS.length, equal: 0, differ: [], items: [] },
      problems: [error instanceof ReconError ? error.message : String(error)],
      error: {
        code: error instanceof ReconError ? error.code : 'internal_error',
        message: error instanceof ReconError ? error.message : String(error),
        details: error instanceof ReconError ? error.details : {},
      },
    }
    failure.summary = summarise(failure)
    try {
      writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8')
    } catch {
      /* the directory may be unwritable; the summary on stdout is still the contract */
    }
    throw Object.assign(error instanceof ReconError ? error : new ReconError('internal_error', failure.problems[0], 3), {
      report: failure,
    })
  } finally {
    if (state.store !== null) {
      try {
        state.store.close()
      } catch {
        /* closing twice is harmless */
      }
    }
    if (state.workDir !== null) rmSync(state.workDir, { recursive: true, force: true })
    if (state.copyDatabase !== null) {
      try {
        pythonJson(python, ['drop', '--database', state.copyDatabase])
        log(options, `dropped scratch database ${state.copyDatabase}`)
      } catch (error) {
        process.stderr.write(`[reconcile] WARNING: could not drop ${state.copyDatabase}: ${error.message}\n`)
      }
    }
  }
}

function main() {
  const startedAt = Date.now()
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    const failure = {
      ok: false,
      error: { code: error.code ?? 'usage', message: error.message },
      durationMs: Date.now() - startedAt,
    }
    process.stdout.write(`${JSON.stringify(failure)}\n`)
    process.exitCode = 2
    return
  }
  try {
    const report = reconcileSync(options)
    process.stdout.write(`${JSON.stringify(report.summary)}\n`)
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    const summary =
      error.report?.summary ?? {
        ok: false,
        database: options.database,
        error: { code: error.code ?? 'internal_error', message: error.message },
        durationMs: Date.now() - startedAt,
      }
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    process.exitCode = error.exitCode ?? 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) main()

export { DRIVER }
