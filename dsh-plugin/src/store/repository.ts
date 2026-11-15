/**
 * Row-level access for the generated tables.
 *
 * Every service in phase 3 needs the same four operations, and they all have the same two hazards:
 * a value must go through the codec (or `Decimal`/instant columns silently change meaning), and a
 * column name must be checked against the generated schema (or a typo becomes a silent no-op in an
 * UPDATE). Both are handled here once, so services only deal in domain values.
 *
 * Rows are plain objects keyed by the *column* name (`attempt_id`, not `attempt.id`), which is what
 * the generated schema and the Python `attname` agree on.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { decodeValue, encodeValue, type SqlValue } from './codec.ts'
import { Decimal } from '../domain/decimal.ts'
import { TABLES, type ColumnDef, type ColumnKind, type TableDef } from './schema.generated.ts'

export type Row = Record<string, unknown>

const TABLES_BY_NAME: ReadonlyMap<string, TableDef> = new Map(TABLES.map((table) => [table.name, table]))

export function tableFor(table: string): TableDef {
  const definition = TABLES_BY_NAME.get(table)
  if (definition === undefined) throw new Error(`unknown table ${table}`)
  return definition
}

function columnsOf(table: string): Map<string, ColumnDef> {
  return new Map(tableFor(table).columns.map((column) => [column.name, column]))
}

/** `created_at` / `updated_at` exist on the 55 models that inherit the abstract base. */
function stamps(table: string): { created: string | null; updated: string | null } {
  const columns = columnsOf(table)
  return {
    created: columns.has('created_at') ? 'created_at' : null,
    updated: columns.has('updated_at') ? 'updated_at' : null,
  }
}

function primaryKeyOf(table: string): ColumnDef {
  const key = tableFor(table).columns.find((column) => column.primaryKey)
  if (key === undefined) throw new Error(`table ${table} has no primary key`)
  return key
}

/**
 * Django quantises a `DecimalField` to its `decimal_places` on save (`format_number`), so a weight
 * of `0.5` is stored as `0.5000` and reads back that way. Reproducing it here keeps the stored form
 * — which is what every later read and every Python dump sees — identical, instead of letting the
 * exponent of the value that happened to be assigned leak into the database.
 */
function quantise(definition: ColumnDef, value: unknown): unknown {
  if (definition.kind !== 'decimal' || definition.decimalPlaces === null) return value
  if (value === null || value === undefined) return value
  const decimal = value instanceof Decimal ? value : Decimal.parse(String(value))
  return decimal.quantize(-definition.decimalPlaces)
}

function encodeAll(table: string, values: Row): Record<string, SqlValue> {
  const columns = columnsOf(table)
  const encoded: Record<string, SqlValue> = {}
  for (const [column, value] of Object.entries(values)) {
    const definition = columns.get(column)
    if (definition === undefined) throw new Error(`unknown column ${table}.${column}`)
    encoded[column] = encodeValue(definition.kind, quantise(definition, value))
  }
  return encoded
}

function decodeAll(table: string, raw: Record<string, unknown>): Row {
  const columns = columnsOf(table)
  // node:sqlite hands back null-prototype rows; widen them and decode by column kind.
  const row: Row = {}
  for (const [column, value] of Object.entries({ ...raw })) {
    const definition = columns.get(column)
    row[column] = definition === undefined ? value : decodeValue(definition.kind, value)
  }
  return row
}

/** A fresh identifier for a UUID primary key. */
export function newId(): string {
  return randomUUID()
}

/**
 * Insert one row.
 *
 * `id`, `created_at` and `updated_at` are filled when the table has them and the caller did not, so
 * callers never invent timestamps of their own.
 */
export function insertRow(
  db: DatabaseSync,
  table: string,
  values: Row,
  options: { now?: Instant } = {},
): Row {
  const row: Row = { ...values }
  const key = primaryKeyOf(table)
  if (row[key.name] === undefined && key.kind === 'uuid') row[key.name] = newId()

  const { created, updated } = stamps(table)
  if (created !== null && row[created] === undefined) {
    if (options.now === undefined) throw new Error(`${table}.${created} needs a clock: pass options.now`)
    row[created] = options.now
  } else if (created !== null && row[created] instanceof Date) {
    throw new Error(`${table}.${created} must be an Instant, not a Date`)
  }
  if (updated !== null && row[updated] === undefined) {
    // `created` is still nullable here: only the `updated` branch narrowed it away.
    row[updated] = (created !== null ? row[created] : undefined) ?? options.now
  }

  const encoded = encodeAll(table, row)
  const names = Object.keys(encoded)
  const result = db
    .prepare(
      `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...(Object.values(encoded) as never[]))
  // An INTEGER PRIMARY KEY is assigned by SQLite, so the new id is only known after the insert
  // (`accounts_user_settings` uses AUTOINCREMENT). A UUID key is known up front.
  const id = row[key.name] ?? result.lastInsertRowid
  return getRow(db, table, id)!
}

/** Read one row by primary key. */
export function getRow(db: DatabaseSync, table: string, id: unknown): Row | null {
  const key = primaryKeyOf(table)
  const raw = db
    .prepare(`SELECT * FROM "${table}" WHERE "${key.name}" = ?`)
    .get(encodeValue(key.kind, id) as never) as Record<string, unknown> | undefined
  return raw === undefined ? null : decodeAll(table, raw)
}

/**
 * Update one row by primary key.
 *
 * Returns the row as stored afterwards, or `null` when the row does not exist. `updated_at` is
 * stamped even when the caller forgets it, which is what `auto_now` did.
 */
export function updateRow(
  db: DatabaseSync,
  table: string,
  id: unknown,
  patch: Row,
  options: { now?: Instant } = {},
): Row | null {
  const key = primaryKeyOf(table)
  const values: Row = { ...patch }
  const { updated } = stamps(table)
  if (updated !== null && values[updated] === undefined && options.now !== undefined) values[updated] = options.now
  const encoded = encodeAll(table, values)
  const names = Object.keys(encoded)
  if (names.length === 0) return getRow(db, table, id)
  const assignments = names.map((name) => `"${name}" = ?`).join(', ')
  const result = db
    .prepare(`UPDATE "${table}" SET ${assignments} WHERE "${key.name}" = ?`)
    .run(...([...Object.values(encoded), encodeValue(key.kind, id)] as never[]))
  if (Number(result.changes) === 0) return null
  return getRow(db, table, id)
}

/** Delete one row by primary key. Returns whether a row was removed. */
export function deleteRow(db: DatabaseSync, table: string, id: unknown): boolean {
  const key = primaryKeyOf(table)
  const result = db
    .prepare(`DELETE FROM "${table}" WHERE "${key.name}" = ?`)
    .run(encodeValue(key.kind, id) as never)
  return Number(result.changes) > 0
}

export interface QueryOptions {
  orderBy?: readonly (readonly [column: string, direction?: 'asc' | 'desc'])[]
  limit?: number
  offset?: number
}

function orderClause(table: string, orderBy: QueryOptions['orderBy']): string {
  if (orderBy === undefined || orderBy.length === 0) return ''
  const columns = columnsOf(table)
  const parts = orderBy.map(([column, direction]) => {
    if (!columns.has(column)) throw new Error(`unknown column ${table}.${column}`)
    return `"${column}"${direction === 'desc' ? ' DESC' : ''}`
  })
  return ` ORDER BY ${parts.join(', ')}`
}

/**
 * Build a `WHERE` clause from an equality map.
 *
 * A `null` value becomes `IS NULL`, not `= NULL`: SQL equality with NULL is never true, so a filter
 * on a nullable column (a root node's `parent_id`, for example) would silently match nothing and a
 * caller would conclude "no such row exists".
 */
function whereClause(
  table: string,
  where: Row,
): { sql: string; params: SqlValue[] } {
  const encoded = encodeAll(table, where)
  const names = Object.keys(encoded)
  if (names.length === 0) return { sql: '', params: [] }
  const clauses: string[] = []
  const params: SqlValue[] = []
  for (const name of names) {
    const value = encoded[name]
    if (value === null) {
      clauses.push(`"${name}" IS NULL`)
      continue
    }
    clauses.push(`"${name}" = ?`)
    params.push(value)
  }
  return { sql: ` WHERE ${clauses.join(' AND ')}`, params }
}

/** Select the rows whose columns equal every given value (`null` means `IS NULL`). */
export function findRows(
  db: DatabaseSync,
  table: string,
  where: Row = {},
  options: QueryOptions = {},
): Row[] {
  const { sql: predicate, params } = whereClause(table, where)
  let sql = `SELECT * FROM "${table}"${predicate}${orderClause(table, options.orderBy)}`
  if (options.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.trunc(options.limit))}`
  if (options.offset !== undefined) sql += ` OFFSET ${Math.max(0, Math.trunc(options.offset))}`
  const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]
  return rows.map((row) => decodeAll(table, row))
}

/** The single row matching the predicate, or `null`. Throws when the predicate is not unique. */
export function findOne(db: DatabaseSync, table: string, where: Row): Row | null {
  const rows = findRows(db, table, where, { limit: 2 })
  if (rows.length > 1) throw new Error(`${table}: predicate matched more than one row`)
  return rows[0] ?? null
}

/** Count the rows matching the predicate. */
export function countRows(db: DatabaseSync, table: string, where: Row = {}): number {
  const { sql: predicate, params } = whereClause(table, where)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"${predicate}`).get(...(params as never[])) as {
    n: number
  }
  return row.n
}

/**
 * Compare-and-set on one column, for optimistic concurrency.
 *
 * Returns `false` when the row is gone or its value had already moved, so a caller can distinguish
 * "someone else won" from "it worked" without a second read.
 */
export function compareAndSet(
  db: DatabaseSync,
  table: string,
  id: unknown,
  column: string,
  expected: unknown,
  next: unknown,
  options: { now?: Instant } = {},
): boolean {
  const key = primaryKeyOf(table)
  const columns = columnsOf(table)
  const target = columns.get(column)
  if (target === undefined) throw new Error(`unknown column ${table}.${column}`)
  const values: Row = { [column]: next }
  const { updated } = stamps(table)
  if (updated !== null && options.now !== undefined) values[updated] = options.now
  const encoded = encodeAll(table, values)
  const names = Object.keys(encoded)
  const assignments = names.map((name) => `"${name}" = ?`).join(', ')
  const result = db
    .prepare(`UPDATE "${table}" SET ${assignments} WHERE "${key.name}" = ? AND "${column}" = ?`)
    .run(
      ...([
        ...Object.values(encoded),
        encodeValue(key.kind, id),
        encodeValue(target.kind, expected),
      ] as never[]),
    )
  return Number(result.changes) > 0
}
