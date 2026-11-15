/**
 * The `node:sqlite` connection layer.
 *
 * Layout decided in docs/dsh-migration/03 §2.12: a single `.acepass` SQLite file per workspace,
 * WAL journalling, `BEGIN IMMEDIATE` for every write transaction, and the schema applied from the
 * generated definitions rather than from a migration chain.
 *
 * Why `BEGIN IMMEDIATE` rather than the default deferred transaction: a deferred transaction
 * upgrades to a write lock at the first write, and two writers that both read first then upgrade
 * deadlock into `SQLITE_BUSY` instead of queueing. Taking the write lock up front turns the
 * contention into a wait on `busy_timeout`, which is what the Django implementation got from
 * `select_for_update` + Postgres row locks.
 */
import { DatabaseSync } from 'node:sqlite'
import { CREATE_INDEXES, CREATE_TABLES, SCHEMA_VERSION } from './schema.generated.ts'

/** Schema bookkeeping lives beside the business tables, prefixed so it can never collide. */
const META_TABLE = '_acepass_meta'

export interface StoreOptions {
  /** `.acepass` file path, or `:memory:` for tests. */
  path: string
  /** Milliseconds to wait on a locked database before failing. */
  busyTimeoutMs?: number
}

export interface StoreHandle {
  db: DatabaseSync
  close(): void
}

/** Apply the generated schema. Idempotent: the DDL uses `IF NOT EXISTS` throughout. */
export function applySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const statement of CREATE_TABLES) db.exec(statement)
    for (const statement of CREATE_INDEXES) db.exec(statement)
    db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openStore(options: StoreOptions): StoreHandle {
  const db = new DatabaseSync(options.path)
  // Foreign keys are OFF by default in SQLite; every FK in the schema assumes they are on.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
  // WAL is meaningless (and rejected) for an in-memory database.
  if (options.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  applySchema(db)
  return { db, close: () => db.close() }
}

/**
 * Run `fn` inside a write transaction.
 *
 * `BEGIN IMMEDIATE` queues concurrent writers on `busy_timeout` instead of letting them deadlock
 * on a deferred upgrade. Nested calls join the outer transaction rather than opening a second one
 * (SQLite has no nested transactions, and a second BEGIN would throw).
 */
let depth = new WeakMap<DatabaseSync, number>()

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const current = depth.get(db) ?? 0
  if (current > 0) {
    depth.set(db, current + 1)
    try {
      return fn()
    } finally {
      depth.set(db, current)
    }
  }
  db.exec('BEGIN IMMEDIATE')
  depth.set(db, 1)
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    depth.set(db, 0)
  }
}

export function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  return row === undefined ? 0 : Number(row.value)
}

export function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}
