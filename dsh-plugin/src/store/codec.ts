/**
 * Value encoding between the domain layer and SQLite.
 *
 * The column mapping was chosen in docs/dsh-migration/03 §2.12 and every choice here exists to stop
 * a silent loss of meaning:
 * - `Decimal` -> TEXT, because SQLite `REAL` is binary floating point and a stored score would stop
 *   round-tripping (`0.1 + 0.2` in a score column is a correctness bug, not a rounding nit).
 * - instants -> TEXT with an explicit offset and microseconds, matching `datetime.isoformat()`, so a
 *   value written by the Node store reads back identically in a Python dump and vice versa.
 * - `bool` -> INTEGER 0/1, since SQLite has no boolean type and `1`/`true` in JSON would diverge.
 * - JSON -> TEXT plus the `json_valid()` CHECK in the generated schema.
 */
import { Decimal } from '../domain/decimal.ts'
import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import type { ColumnKind } from './schema.generated.ts'
import { PyFloat, pyJsonCanonical } from './pyjson.ts'

export type SqlValue = string | number | bigint | null | Uint8Array

/** Encode one domain value for storage. `undefined` means NULL, as in the Python layer. */
export function encodeValue(kind: ColumnKind, value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  switch (kind) {
    case 'uuid':
    case 'text':
    case 'date':
    case 'time':
      return String(value)
    case 'decimal':
      if (value instanceof Decimal) return value.toString()
      return String(value)
    case 'datetime':
      return formatPythonIso(value as Instant)
    case 'bool':
      return value ? 1 : 0
    case 'int':
      return Number(value)
    case 'float':
      return Number(value)
    case 'duration':
      return Number(value)
    case 'json':
      // An imported archive row may contain `PyFloat` markers (a JSON field whose Python value was
      // `40.0`). `JSON.stringify` would print the wrapper object; the canonical serializer prints
      // `40.0`, which is what the archive digest and a later digest recomputation expect.
      return containsPyFloat(value) ? pyJsonCanonical(value) : JSON.stringify(value)
    case 'blob':
      if (value instanceof Uint8Array) return value
      throw new TypeError(`expected a Uint8Array for a blob column, got ${typeof value}`)
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled column kind ${String(exhaustive)}`)
    }
  }
}

function containsPyFloat(value: unknown): boolean {
  if (value instanceof PyFloat) return true
  if (Array.isArray(value)) return value.some(containsPyFloat)
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsPyFloat)
  return false
}

/** Decode one stored value back into the domain type. */
export function decodeValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (kind) {
    case 'uuid':
    case 'text':
    case 'date':
    case 'time':
      return String(value)
    case 'decimal':
      return Decimal.parse(String(value))
    case 'datetime':
      return parseInstant(String(value))
    case 'bool':
      return Number(value) !== 0
    case 'int':
    case 'float':
    case 'duration':
      return Number(value)
    case 'json':
      return JSON.parse(String(value))
    case 'blob':
      return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike)
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled column kind ${String(exhaustive)}`)
    }
  }
}

/** Encode a row given the column kinds of its table. */
export function encodeRow(
  kinds: ReadonlyMap<string, ColumnKind>,
  row: Record<string, unknown>,
): Record<string, SqlValue> {
  const encoded: Record<string, SqlValue> = {}
  for (const [column, value] of Object.entries(row)) {
    const kind = kinds.get(column)
    if (kind === undefined) throw new Error(`unknown column ${column}`)
    encoded[column] = encodeValue(kind, value)
  }
  return encoded
}

/** Decode a row returned by SQLite. */
export function decodeRow(
  kinds: ReadonlyMap<string, ColumnKind>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) {
    const kind = kinds.get(column)
    if (kind === undefined) throw new Error(`unknown column ${column}`)
    decoded[column] = decodeValue(kind, value)
  }
  return decoded
}
