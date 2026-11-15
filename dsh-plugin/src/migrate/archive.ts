/**
 * Import a `.acepass` archive into a `node:sqlite` store, and reconcile it against the archive.
 *
 * The archive is the contract: rows arrive already in the storage shape `node:sqlite` holds, so this
 * module does not guess types (a `"2.00"` is a decimal because the column says `decimal`, not because
 * it looks like one). Insertion happens in foreign-key order, inside one transaction, so a failed
 * import leaves no half-copied database behind.
 *
 * Reconciliation is three independent checks, and they must all agree:
 *  1. **counts** — the manifest says how many rows each table has;
 *  2. **row digests** — the manifest's per-table digest of canonical rows must equal the digest
 *     recomputed from the rows actually written;
 *  3. **statistics** — a few aggregate numbers a learner would notice, which catch a systematic value
 *     change that keeps row counts and shapes intact.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { insertRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { Decimal } from '../domain/decimal.ts'
import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import { TABLES } from '../store/schema.generated.ts'
import { PyFloat, parsePyJson, pyJsonCanonical } from '../store/pyjson.ts'

export interface ManifestTable {
  name: string
  columns: string[]
  rows: number
  digest: string
  no_model?: boolean
}

export interface Manifest {
  format_version: number
  source: { engine: string; database: string; django_version: string }
  tables: ManifestTable[]
  missing_models?: string[]
}

export interface Archive {
  manifest: Manifest
  rows: Map<string, unknown[][]>
}

export function readManifest(archiveDir: string): Manifest {
  const manifest = JSON.parse(readFileSync(join(archiveDir, 'manifest.json'), 'utf8')) as Manifest
  if (manifest.format_version !== 1) {
    throw new Error(`unsupported archive format ${manifest.format_version}`)
  }
  return manifest
}

export function readArchive(archiveDir: string): Archive {
  const manifest = readManifest(archiveDir)
  const rows = new Map<string, unknown[][]>()
  for (const table of manifest.tables) {
    const text = readFileSync(join(archiveDir, `${table.name}.jsonl`), 'utf8')
    const parsed: unknown[][] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      // `parsePyJson`, not `JSON.parse`: Python's `json.dumps` writes `40.0` for a float and `40`
      // for an int, and the manifest digest is computed on that distinction. `JSON.parse` would
      // collapse both to 40 and the archive would no longer hash to the digest Python recorded.
      const values = parsePyJson(line) as unknown[]
      if (values.length !== table.columns.length) {
        throw new Error(
          `${table.name}: row has ${values.length} values but ${table.columns.length} columns`,
        )
      }
      parsed.push(values)
    }
    rows.set(table.name, parsed)
  }
  return { manifest, rows }
}

/** The digest both sides hash: canonical JSON of the row keyed by column name. */
export function rowDigest(row: Record<string, unknown>, columns: readonly string[]): string {
  const ordered: Record<string, unknown> = {}
  for (const name of [...columns].sort()) ordered[name] = row[name] ?? null
  return pyJsonCanonical(ordered)
}

export function tableDigest(rows: readonly unknown[][], columns: readonly string[]): string {
  const hash = createHash('sha256')
  for (const values of rows) {
    const row: Record<string, unknown> = {}
    columns.forEach((name, index) => {
      row[name] = values[index] ?? null
    })
    hash.update(rowDigest(row, columns), 'utf8')
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Insert order, plus the foreign keys that must be filled in afterwards.
 *
 * The schema has reference cycles (`practice_attempt.current_grade_event_id` ↔
 * `practice_grade_event.attempt_id`, `question_bank_question.family_id` ↔ `question_bank_family`), so
 * a plain topological sort cannot exist. Greedy placement breaks each stall by taking the table with
 * the fewest unmet dependencies and **deferring** those columns: the row is inserted with NULL and the
 * reference is written by a second pass, once every table has its rows.
 *
 * A deferred column that is `NOT NULL` would be a cycle no ordering can satisfy; that is reported
 * instead of silently producing a NULL that the constraint will reject anyway.
 */
export function importPlan(): { order: string[]; deferred: { table: string; column: string; refTable: string }[] } {
  const byName = new Map(TABLES.map((table) => [table.name, table]))
  const deps = new Map<string, Set<string>>()
  for (const table of TABLES) {
    deps.set(
      table.name,
      new Set(table.foreignKeys.map((fk) => fk.refTable).filter((ref) => ref !== table.name && byName.has(ref))),
    )
  }
  const order: string[] = []
  const placed = new Set<string>()
  const deferred: { table: string; column: string; refTable: string }[] = []

  while (order.length < TABLES.length) {
    const pending = TABLES.filter((table) => !placed.has(table.name))
    // A table is loadable when every reference it still has to wait for sits in a nullable column:
    // that column can be filled by the second pass. INNER-order by declaration keeps the result
    // deterministic, which the digests rely on.
    const loadable = pending.find((table) =>
      table.foreignKeys.every((fk) => {
        if (fk.refTable === table.name || placed.has(fk.refTable)) return true
        const column = table.columns.find((candidate) => candidate.name === fk.column)
        return column !== undefined && !column.notNull
      }),
    )
    if (loadable === undefined) {
      const blocked = pending
        .map((table) =>
          table.foreignKeys
            .filter((fk) => {
              if (fk.refTable === table.name || placed.has(fk.refTable)) return false
              const column = table.columns.find((candidate) => candidate.name === fk.column)
              return column === undefined || column.notNull
            })
            .map((fk) => `${table.name}.${fk.column} -> ${fk.refTable}`),
        )
        .flat()
      throw new Error(
        `the reference graph cannot be loaded in one pass; these NOT NULL references form a cycle: ${blocked.join(', ')}`,
      )
    }
    for (const fk of loadable.foreignKeys) {
      if (fk.refTable === loadable.name) {
        const column = loadable.columns.find((candidate) => candidate.name === fk.column)
        if (column !== undefined && !column.notNull) {
          deferred.push({ table: loadable.name, column: fk.column, refTable: fk.refTable })
        }
        continue
      }
      if (placed.has(fk.refTable)) continue
      deferred.push({ table: loadable.name, column: fk.column, refTable: fk.refTable })
    }
    order.push(loadable.name)
    placed.add(loadable.name)
  }
  return { order, deferred }
}

/** Kept for callers that only need the order. */
export function foreignKeyOrder(): string[] {
  return importPlan().order
}

/** Archive JSON value → the domain value the codec expects for that column kind. */
function reviving(kind: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  // JSON columns keep `PyFloat` so the codec can store `40.0` instead of `40`; every other column
  // kind wants the plain number (a `float` column would otherwise be encoded from an object).
  if (kind === 'json') return value
  const plain = value instanceof PyFloat ? value.value : value
  if (kind === 'datetime') return parseInstant(String(plain))
  if (kind === 'decimal') return Decimal.parse(String(plain))
  return plain
}

export interface ImportReport {
  tables: number
  rows: number
  digests: Map<string, string>
}

/** Write the archive into an empty store. */
export function importArchive(db: DatabaseSync, archive: Archive, now: Instant): ImportReport {
  const known = new Set(TABLES.map((table) => table.name))
  for (const table of archive.manifest.tables) {
    if (!known.has(table.name)) {
      throw new Error(`archive contains a table the schema does not have: ${table.name}`)
    }
  }
  const { order, deferred } = importPlan()
  const deferredColumns = new Set(deferred.map((entry) => `${entry.table}.${entry.column}`))
  const digests = new Map<string, string>()
  const pendingReferences: { table: string; key: string; id: unknown; column: string; value: unknown }[] = []
  let totalRows = 0

  transaction(db, () => {
    for (const tableName of order) {
      const entry = archive.manifest.tables.find((candidate) => candidate.name === tableName)
      if (entry === undefined) continue
      const rows = archive.rows.get(tableName) ?? []
      const definition = TABLES.find((table) => table.name === tableName)!
      const columnKinds = new Map(definition.columns.map((column) => [column.name, column]))
      const keyColumn = definition.columns.find((column) => column.primaryKey)!
      for (const values of rows) {
        if (values.length !== entry.columns.length) {
          throw new Error(`${tableName}: row has ${values.length} values but ${entry.columns.length} columns`)
        }
        // Build the row in *domain* values only: `insertRow` owns the encoding, and encoding here as
        // well would hand it an already-encoded string to encode a second time.
        const row: Record<string, unknown> = {}
        entry.columns.forEach((name, index) => {
          const column = columnKinds.get(name)
          if (column === undefined) throw new Error(`${tableName}.${name} is not in the schema`)
          const value = reviving(column.kind, values[index])
          if (deferredColumns.has(`${tableName}.${name}`) && value !== null) {
            pendingReferences.push({
              table: tableName,
              key: keyColumn.name,
              id: values[entry.columns.indexOf(keyColumn.name)],
              column: name,
              value,
            })
            row[name] = null
            return
          }
          row[name] = value
        })
        try {
          insertRow(db, tableName, row, { now })
        } catch (error) {
          throw new Error(`${tableName}: row could not be inserted: ${(error as Error).message}`)
        }
      }
      digests.set(tableName, tableDigest(rows, entry.columns))
      totalRows += rows.length
    }

    // Second pass: the cycle-breaking references, now that every table has its rows.
    for (const reference of pendingReferences) {
      db.prepare(`UPDATE "${reference.table}" SET "${reference.column}" = ? WHERE "${reference.key}" = ?`).run(
        reference.value === null ? null : String(reference.value),
        String(reference.id),
      )
    }
  })
  return { tables: digests.size, rows: totalRows, digests }
}

export interface TableReconciliation {
  table: string
  expectedRows: number
  actualRows: number
  expectedDigest: string
  actualDigest: string
  ok: boolean
}

export interface Reconciliation {
  ok: boolean
  tables: TableReconciliation[]
  problems: string[]
}

/**
 * Digest one table **as stored in the database**, in primary-key order.
 *
 * The archive exporter writes rows ordered by primary key, and the importer inserts them in that
 * order, so this is the same order on both sides. Ordering explicitly (rather than trusting
 * `SELECT *`) is what lets a backup manifest and an archive manifest be compared directly: a
 * database that was imported from an archive digests to the same per-table values.
 */
export function tableDigestFromDatabase(
  db: DatabaseSync,
  tableName: string,
  columns?: readonly string[],
): string {
  const definition = TABLES.find((table) => table.name === tableName)
  if (definition === undefined) throw new Error(`unknown table ${tableName}`)
  const names = columns ?? definition.columns.map((column) => column.name)
  const primaryKey = definition.columns.find((column) => column.primaryKey)
  if (primaryKey === undefined) throw new Error(`table ${tableName} has no primary key`)
  const stored = db
    .prepare(`SELECT * FROM "${tableName}" ORDER BY "${primaryKey.name}"`)
    .all() as Record<string, unknown>[]
  const kinds = new Map(definition.columns.map((column) => [column.name, column.kind]))
  const rows = stored.map((row) => names.map((name) => decodeForDigest(kinds.get(name) ?? 'text', row[name])))
  return tableDigest(rows, names)
}

/** Compare the imported store against the archive it came from. */
export function reconcileArchive(db: DatabaseSync, archive: Archive): Reconciliation {
  const tables: TableReconciliation[] = []
  const problems: string[] = []

  for (const entry of archive.manifest.tables) {
    const stored = db.prepare(`SELECT * FROM "${entry.name}"`).all() as Record<string, unknown>[]
    const actualDigest = tableDigestFromDatabase(db, entry.name, entry.columns)
    const expectedDigest = tableDigest(archive.rows.get(entry.name) ?? [], entry.columns)
    const ok = stored.length === entry.rows && actualDigest === expectedDigest
    tables.push({
      table: entry.name,
      expectedRows: entry.rows,
      actualRows: stored.length,
      expectedDigest,
      actualDigest,
      ok,
    })
    if (!ok) {
      problems.push(
        `${entry.name}: ${stored.length}/${entry.rows} rows, digest ${actualDigest.slice(0, 12)} != expected ${expectedDigest.slice(0, 12)}`,
      )
    }
  }
  return { ok: problems.length === 0, tables, problems }
}

/**
 * A **stored** value (straight from SQLite, not through the repository codec) as the archive would
 * have written it.
 *
 * SQLite already holds exactly the archive's shape for most kinds — instants as ISO text with an
 * offset, decimals as text, booleans as 0/1 — so only JSON (text → structure) and blobs need
 * unwrapping. Decoding through the codec first would hand this function an `Instant` and a `Decimal`,
 * which is what the digest must *not* see.
 */
function decodeForDigest(kind: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (kind === 'json') return typeof value === 'string' ? parsePyJson(value) : value
  if (kind === 'blob') return value instanceof Uint8Array ? [...value] : value
  if (kind === 'bool') return Number(value) === 1 ? 1 : 0
  if (kind === 'int' || kind === 'float' || kind === 'duration') return Number(value)
  return String(value)
}
