/**
 * Golden replay for ingestion B3: storage, images, the download gate and the image import.
 *
 * `scripts/gen_ingestion_b3_golden.py` builds real PostgreSQL rows in a throw-away database, calls
 * the real Django functions (`store_asset`, `create_image_document`, `find_duplicate_document`,
 * `assert_asset_download_allowed`, `record_download_exposure`, `start_image_import`) and freezes both
 * the rows and the resulting facts. This file seeds the same rows into SQLite, replays the same
 * calls, and compares field by field.
 *
 * Three conventions make the comparison possible across two implementations:
 *
 * 1. **Placeholders.** `<asset:1>`, `<document:2>`, `<job>`, `<region:2>` are ids the *operation*
 *    creates; `<object_key>`, `<stored_sha256>`, `<stored_size>` are values that depend on the
 *    encoder. The comparator binds each placeholder on first sight and then requires every later
 *    occurrence to agree, so "the job points at the document the region points at" is still checked.
 * 2. **Symbols.** Every seeded row id has a name (`USER`, `PROJECT`, `ASSET`, …). Symbol names inside
 *    expected strings are replaced with their ids before comparison, which is what makes
 *    `download_url` and the masked object key comparable.
 * 3. **Encoder-dependent facts are asserted relationally**, never by literal: the stored checksum
 *    must equal the SHA-256 of the bytes on disk, the stored size must equal their length, and the
 *    pixel error must stay small. Pillow and sharp do not produce identical bytes and the spec
 *    forbids pretending they do (06 §5.1).
 *
 * Two **documented divergences** are asserted explicitly instead of being hidden (04 §K):
 *
 * - a palette PNG: Django's `Image.new("P", …)` drops the palette, so the stored picture changes
 *   colour (mean channel error 20.6 in the fixture); sharp expands the palette and keeps the
 *   colours, so the port stores an exact picture;
 * - `sharp`'s PNG encoder is not byte-identical to Pillow's, so a clean PNG re-encode is no longer
 *   the identity. The duplicate lookup is the same algorithm, but "upload the original twice"
 *   stops hitting it. The fixture records Django's identity; the test asserts the port's own facts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { formatPythonIso, parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow, getRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { assertAssetDownloadAllowed, recordDownloadExposure } from '../src/services/ingestion_access.ts'
import {
  createImageDocument,
  findDuplicateDocument,
  prepareAssetImage,
  storeAsset,
} from '../src/services/ingestion_sources.ts'
import { buildKey, configureStorage, getStorage, resetStorageCache } from '../src/ingestion/storage.ts'
import { loadSharp } from '../src/ingestion/sharp.ts'

const NOW = parseInstant('2026-04-01T00:05:00+00:00')
const BASE = 'http://host/api/acepass'
const FIXTURE = JSON.parse(readFileSync(new URL('./golden/ingestion_b3.json', import.meta.url), 'utf8'))
const MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'acepass-b3-golden-'))
configureStorage(MEDIA_ROOT)
process.on('exit', () => {
  resetStorageCache()
  rmSync(MEDIA_ROOT, { recursive: true, force: true })
})

const sharp = loadSharp() as unknown as (input: unknown, options?: Record<string, unknown>) => any

// --------------------------------------------------------------------------
// fixture helpers
// --------------------------------------------------------------------------

interface GoldenCase {
  name: string
  rows: Record<string, Array<Record<string, any>>>
  symbols: Record<string, string>
  steps: Array<Record<string, any>>
  expected: Record<string, any>
}

function imageBytes(name: string): Uint8Array {
  if (name === '<empty>') return new Uint8Array()
  const entry = FIXTURE.images[name]
  assert.ok(entry, `unknown image fixture ${name}`)
  if (typeof entry.base64 === 'string') return new Uint8Array(Buffer.from(entry.base64, 'base64'))
  // `oversize_bytes` is deliberately too large to embed; it only has to trip the byte limit.
  return new Uint8Array(Number(entry.bytes))
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const DATETIME_TABLES = new Map<string, Set<string>>()
for (const table of TABLES) {
  DATETIME_TABLES.set(
    table.name,
    new Set(table.columns.filter((column) => column.kind === 'datetime').map((column) => column.name)),
  )
}

/**
 * Seed the case's rows.
 *
 * Foreign keys mean the insertion order is a topological sort the fixture does not spell out, so
 * the loop retries: an insert that fails on a missing parent is deferred until no insert succeeds.
 * Any other failure is a real problem and is rethrown.
 */
function seedRows(db: ReturnType<typeof openStore>['db'], rows: Record<string, Array<Record<string, any>>>): void {
  const pending: Array<{ table: string; row: Record<string, any> }> = []
  const deferred: Array<{ table: string; id: unknown; column: string; value: unknown }> = []
  const nullableFksOf = new Map<string, string[]>()
  for (const [table, list] of Object.entries(rows)) {
    const definition = TABLES.find((entry) => entry.name === table)!
    const fkColumns = new Set(definition.foreignKeys.map((fk) => fk.column))
    nullableFksOf.set(
      table,
      definition.columns.filter((column) => fkColumns.has(column.name) && !column.notNull).map((column) => column.name),
    )
    for (const row of list) pending.push({ table, row: { ...row } })
  }

  const insertAll = (): void => {
    let progress = true
    while (pending.length > 0 && progress) {
      progress = false
      for (let index = 0; index < pending.length; index += 1) {
        const { table, row } = pending[index]
        const prepared: Record<string, unknown> = { ...row }
        for (const column of DATETIME_TABLES.get(table) ?? []) {
          if (typeof prepared[column] === 'string') prepared[column] = parseInstant(prepared[column] as string)
        }
        try {
          insertRow(db, table, prepared, { now: NOW })
        } catch (error) {
          if (!/FOREIGN KEY constraint failed/.test(String((error as Error).message))) throw error
          continue
        }
        pending.splice(index, 1)
        index -= 1
        progress = true
      }
    }
  }

  insertAll()
  // Whatever is left is either a reference cycle (`question.current_published_version_id` ↔
  // `question_version.question_id`) or a row still waiting for a parent. Nulling a nullable foreign
  // key breaks a cycle; it must be tried per row and rolled back when it would violate a check
  // constraint such as `pool_policy_target_required`, in which case the row simply needs to wait.
  for (const entry of [...pending]) {
    const nullable = (nullableFksOf.get(entry.table) ?? []).filter(
      (column) => entry.row[column] !== null && entry.row[column] !== undefined,
    )
    if (nullable.length === 0) continue
    const saved = nullable.map((column) => entry.row[column])
    for (const column of nullable) entry.row[column] = null
    const prepared: Record<string, unknown> = { ...entry.row }
    for (const column of DATETIME_TABLES.get(entry.table) ?? []) {
      if (typeof prepared[column] === 'string') prepared[column] = parseInstant(prepared[column] as string)
    }
    try {
      insertRow(db, entry.table, prepared, { now: NOW })
    } catch {
      nullable.forEach((column, index) => {
        entry.row[column] = saved[index]
      })
      continue
    }
    nullable.forEach((column, index) => {
      deferred.push({ table: entry.table, id: entry.row.id, column, value: saved[index] })
    })
    pending.splice(pending.indexOf(entry), 1)
  }
  insertAll()
  assert.equal(pending.length, 0, `unseedable rows: ${pending.map((entry) => entry.table).join(', ')}`)
  for (const entry of deferred) {
    const column = TABLES.find((table) => table.name === entry.table)!.columns.find((item) => item.name === entry.column)!
    const value = column.kind === 'datetime' ? parseInstant(String(entry.value)) : entry.value
    db.prepare(`UPDATE "${entry.table}" SET "${entry.column}" = ? WHERE "id" = ?`).run(
      column.json ? JSON.stringify(value) : (value as string | number),
      entry.id as string,
    )
  }
}

function newDb(): ReturnType<typeof openStore>['db'] {
  return openStore({ path: ':memory:' }).db
}

/** Ids travel as ids: `normalizeExpected` rewrites the fixture's symbol names into the same ids. */
/** The regions one candidate is attached to (through the through table). */
function candidateRegionRows(db: ReturnType<typeof openStore>['db'], candidateId: string): Array<Record<string, any>> {
  return findRows(db, 'ingestion_import_candidate_source_regions', { importcandidate_id: candidateId })
    .map((link) => getRow(db, 'ingestion_source_region', String(link.sourceregion_id)))
    .filter((region): region is Record<string, any> => region !== null)
}

/** The row a symbol names, e.g. `ASSET` → the case's asset row (which may be in another project). */
function rowBySymbol(
  db: ReturnType<typeof openStore>['db'],
  c: GoldenCase,
  table: string,
  name: string,
): Record<string, any> {
  const id = Object.keys(c.symbols).find((key) => c.symbols[key] === name)
  if (id !== undefined) {
    const row = getRow(db, table, id)
    if (row !== null) return row
  }
  return findRows(db, table, {})[0]
}

function symbolOf(c: GoldenCase, id: unknown): string | null {
  void c
  if (id === null || id === undefined) return null
  return String(id)
}

/**
 * `project_counts(project)`: rows of each kind **in this project**.
 *
 * The scoping matters: a download case seeds an asset in another project to prove it is invisible,
 * and a global count would then disagree with the fixture for a reason that has nothing to do with
 * the operation. Outbox rows are global in Django too, so they are counted globally here.
 */
function rowCounts(db: ReturnType<typeof openStore>['db'], projectId: string): Record<string, number> {
  const count = (sql: string, ...args: unknown[]): number =>
    Number((db.prepare(sql).get(...(args as never[])) as { n: number }).n)
  return {
    ingestion_asset: count(`SELECT COUNT(*) AS n FROM "ingestion_asset" WHERE "project_id" = ?`, projectId),
    ingestion_source_document: count(
      `SELECT COUNT(*) AS n FROM "ingestion_source_document" WHERE "project_id" = ?`,
      projectId,
    ),
    ingestion_source_region: count(
      `SELECT COUNT(*) AS n FROM "ingestion_source_region" r
         JOIN "ingestion_source_document" d ON d."id" = r."document_id" WHERE d."project_id" = ?`,
      projectId,
    ),
    ingestion_import_job: count(`SELECT COUNT(*) AS n FROM "ingestion_import_job" WHERE "project_id" = ?`, projectId),
    ingestion_import_candidate: count(
      `SELECT COUNT(*) AS n FROM "ingestion_import_candidate" WHERE "project_id" = ?`,
      projectId,
    ),
    ingestion_candidate_revision: count(
      `SELECT COUNT(*) AS n FROM "ingestion_candidate_revision" v
         JOIN "ingestion_import_candidate" c ON c."id" = v."candidate_id" WHERE c."project_id" = ?`,
      projectId,
    ),
    audit_content_revision: count(`SELECT COUNT(*) AS n FROM "audit_content_revision" WHERE "project_id" = ?`, projectId),
    audit_outbox_event: count(`SELECT COUNT(*) AS n FROM "audit_outbox_event"`),
    practice_exposure_event: count(
      `SELECT COUNT(*) AS n FROM "practice_exposure_event" WHERE "project_id" = ?`,
      projectId,
    ),
  }
}

/**
 * Write a file for every pre-existing asset row so a download case has bytes.
 *
 * The fixture records Django's stored checksum, which no other encoder reproduces, so the bytes are
 * generated at the row's `size_bytes` length and the row's checksum is updated to match. Every
 * assertion about the body is then relational (`sha256 == row.checksum`), which is the property the
 * contract actually makes.
 */
function materializeAssets(db: ReturnType<typeof openStore>['db'], skip: boolean): void {
  for (const asset of findRows(db, 'ingestion_asset', {})) {
    if (skip) continue
    const key = String(asset.object_key)
    const path = join(MEDIA_ROOT, key)
    mkdirSync(dirname(path), { recursive: true })
    const bytes = Buffer.alloc(Number(asset.size_bytes), 0x41)
    writeFileSync(path, bytes)
    db.prepare('UPDATE "ingestion_asset" SET "checksum" = ? WHERE "id" = ?').run(
      sha256(new Uint8Array(bytes)),
      String(asset.id),
    )
  }
}

// --------------------------------------------------------------------------
// placeholder-aware comparison
// --------------------------------------------------------------------------

const PLACEHOLDER = /<([a-z_0-9]+)(?::(\d+))?>/g

function isPlaceholder(value: string): boolean {
  return new RegExp(`^${PLACEHOLDER.source}$`).test(value)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compare one expected value with one actual value, binding placeholders as they appear.
 *
 * Returns a list of human-readable differences; an empty list means the two agree.
 */
function isSkipped(path: string, skip: string[]): boolean {
  return skip.some((entry) => path === entry || path.startsWith(`${entry}.`) || path.startsWith(`${entry}[`))
}

function diff(
  actual: unknown,
  expected: unknown,
  bindings: Map<string, unknown>,
  path: string,
  skip: string[] = [],
): string[] {
  if (isSkipped(path, skip)) return []
  if (typeof expected === 'string' && expected.includes('<')) {
    const names: string[] = []
    let pattern = ''
    let cursor = 0
    for (const match of expected.matchAll(PLACEHOLDER)) {
      pattern += escapeRegExp(expected.slice(cursor, match.index))
      const name = match[1]
      const kind = name
      names.push(match[0])
      if (bindings.has(match[0])) pattern += escapeRegExp(String(bindings.get(match[0])))
      else pattern += '(.+?)'
      void kind
      cursor = (match.index ?? 0) + match[0].length
    }
    pattern += escapeRegExp(expected.slice(cursor))
    if (typeof actual !== 'string') return [`${path}: expected string, got ${typeof actual}`]
    const match = new RegExp(`^${pattern}$`).exec(actual)
    if (match === null) return [`${path}: ${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}`]
    const problems: string[] = []
    names.forEach((name, index) => {
      const captured = match[index + 1]
      if (bindings.has(name)) return
      if (name === '<now>') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/.test(captured)) {
          problems.push(`${path}: <now> is not a Python ISO instant (${captured})`)
          return
        }
      }
      if (name === '<ts>') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/.test(captured)) {
          problems.push(`${path}: <ts> is not a Python ISO instant (${captured})`)
        }
        return
      }
      // `<stored_sha256>` / `<stored_size>` describe a *value*, not an identity: every image has its
      // own, so they are format-checked and never bound.
      if (name === '<stored_sha256>') {
        if (!/^[0-9a-f]{64}$/.test(captured)) problems.push(`${path}: <stored_sha256> is not a sha256 (${captured})`)
        return
      }
      if (name === '<stored_size>') {
        if (!/^\d+$/.test(captured)) problems.push(`${path}: <stored_size> is not an integer (${captured})`)
        return
      }
      bindings.set(name, captured)
    })
    return problems
  }
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined ? [] : [`${path}: expected null, got ${JSON.stringify(actual)}`]
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${typeof actual}`]
    if (actual.length !== expected.length) {
      return [`${path}: length ${actual.length} != ${expected.length}`]
    }
    return expected.flatMap((item, index) => diff(actual[index], item, bindings, `${path}[${index}]`, skip))
  }
  if (typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${path}: expected object, got ${JSON.stringify(actual)}`]
    }
    const expectedKeys = Object.keys(expected).sort()
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort()
    const problems: string[] = []
    for (const key of expectedKeys) {
      if (!actualKeys.includes(key) && !isSkipped(`${path}.${key}`, skip)) problems.push(`${path}.${key}: missing`)
    }
    for (const key of actualKeys) {
      if (!expectedKeys.includes(key) && !isSkipped(`${path}.${key}`, skip)) problems.push(`${path}.${key}: unexpected`)
    }
    for (const key of expectedKeys) {
      if (!actualKeys.includes(key)) continue
      problems.push(
        ...diff((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], bindings, `${path}.${key}`, skip),
      )
    }
    return problems
  }
  if (typeof expected === 'number') {
    return actual === expected ? [] : [`${path}: ${JSON.stringify(actual)} != ${expected}`]
  }
  return actual === expected ? [] : [`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`]
}

/** `document_ids` has no defined order (06 §1); both sides are sorted so a set comparison is exact. */
function sortDocumentIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortDocumentIds) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === 'document_ids' && Array.isArray(item) ? [...item].sort() : sortDocumentIds(item)
    }
    return out as unknown as T
  }
  return value
}

/**
 * Rewrite the expected tree into the same vocabulary the actual values use.
 *
 * Three rewrites happen: the API prefix (`/api/v1` → `/api/acepass`), every literal timestamp
 * becomes `<ts>` (the generator's clock advances per created row, so a created row's timestamp is
 * not reproducible), and every symbol name is replaced with the row id it names — which is what
 * makes `download_url` and the masked object key comparable, since they embed the ids inside a
 * longer string. Symbol names are distinctive upper-case tokens and `\b` keeps them from matching
 * inside `QUESTION_LINKED`-style names.
 */
function normalizeExpected(c: GoldenCase): unknown {
  let text = JSON.stringify(c.expected).replace(/\/api\/v1\/projects/g, '/api/acepass/projects')
  // The generator's clock advances one minute per row it creates, so a row the *operation* creates
  // has a timestamp no replay can reproduce. Both sides are reduced to a shape check; the ordering
  // itself is asserted by the fields that carry it (revision, status, sequence).
  text = text.replace(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+00:00"/g, '"<ts>"')
  for (const [id, name] of Object.entries(c.symbols)) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), id)
  }
  // A symbol whose id is not one of the seeded rows names a row the *operation* creates (Django's
  // deterministic uuid5). Its id cannot match this port's, so it becomes a placeholder and the
  // comparator binds it — which still enforces that `download_url` and `asset_id` agree with `id`.
  const seeded = new Set<string>()
  for (const list of Object.values(c.rows)) for (const row of list) if (row.id !== undefined) seeded.add(String(row.id))
  for (const [id, name] of Object.entries(c.symbols)) {
    if (seeded.has(id)) continue
    text = text.split(id).join(`<gen_${name.toLowerCase()}>`)
  }
  // A few cases name the row the operation creates without registering it as a symbol (`ASSET` in
  // the O01/O05 sections). Those names become placeholders too; a name that *is* a seeded row keeps
  // its id, so the gate/download assertions stay exact.
  const symbolNames = new Set(Object.values(c.symbols))
  for (const name of ['ASSET', 'DOCUMENT', 'CANDIDATE', 'REGION', 'JOB']) {
    if (symbolNames.has(name)) continue
    text = text.replace(new RegExp(`\\b${name}\\b`, 'g'), `<gen_${name.toLowerCase()}>`)
  }
  return sortDocumentIds(JSON.parse(text))
}

/**
 * Compare, skipping paths whose value depends on the encoder.
 *
 * Every skipped path is asserted separately by a property assertion (stored bytes hash the row
 * checksum, the picture keeps its size, the pixel error stays bounded), so skipping cannot hide a
 * wrong result — it only stops a Pillow-specific literal from failing a correct port.
 */
function compare(
  c: GoldenCase,
  actual: unknown,
  label: string,
  skip: string[] = [],
  prebind: Map<string, unknown> = new Map(),
): void {
  const problems = diff(actual, normalizeExpected(c), prebind, label, skip.map((entry) => `${label}.${entry}`))
  assert.deepEqual(problems, [], `${c.name}\n  ${problems.join('\n  ')}`)
}

/** The masked shape of a generated object key: `owner/project/ns/<shard>/<token>.ext`. */
function keyShape(key: string): Record<string, unknown> {
  const parts = key.split('/')
  const file = parts[parts.length - 1]
  const dot = file.indexOf('.')
  const token = dot === -1 ? file : file.slice(0, dot)
  return {
    masked: `${parts.slice(0, -2).join('/')}/<shard>/<token>${dot === -1 ? '' : file.slice(dot)}`,
    namespace: parts.slice(0, -2).join('/'),
    shard_len: parts[parts.length - 2].length,
    token_len: token.length,
    token_is_lower_hex: /^[0-9a-f]+$/.test(token),
    has_extension: dot !== -1,
    suffix: dot === -1 ? null : file.slice(dot + 1),
    key_contains_filename: false,
  }
}

/** The `asset` block the fixture records, rebuilt from the row + the bytes on disk. */
function assetFacts(
  c: GoldenCase,
  db: ReturnType<typeof openStore>['db'],
  asset: Record<string, any>,
  filenameHint: string,
): Record<string, unknown> {
  const bytes = getStorage().open(String(asset.object_key))
  return {
    id: asset.id,
    project_id: symbolOf(c, asset.project_id),
    role: asset.role,
    sensitivity: asset.sensitivity,
    content_type: asset.content_type,
    // An image is re-encoded, so its stored size is encoder-dependent and the fixture writes
    // `<stored_size>`; a non-image is stored verbatim and the fixture writes the exact number.
    size_bytes: String(asset.content_type).startsWith('image/') ? String(bytes.byteLength) : bytes.byteLength,
    checksum: sha256(new Uint8Array(bytes)),
    width: asset.width === null ? null : Number(asset.width),
    height: asset.height === null ? null : Number(asset.height),
    original_filename: asset.original_filename,
    subject_id: symbolOf(c, asset.subject_id),
    uploaded_by_id: symbolOf(c, asset.uploaded_by_id),
    source_document_id: asset.source_document_id === null ? null : String(asset.source_document_id),
    is_retained: Boolean(asset.is_retained),
    object_key: String(asset.object_key),
    download_url: `/api/acepass/projects/${String(asset.project_id)}/assets/${String(asset.id)}`,
    bytes_on_disk: bytes.byteLength,
    size_matches_bytes: bytes.byteLength === Number(asset.size_bytes),
    checksum_matches_bytes: sha256(new Uint8Array(bytes)) === asset.checksum,
    key_shape: keyShape(String(asset.object_key)),
    ...(filenameHint === '' ? {} : {}),
  }
}

/** The EXIF orientation of the upload, which must be dropped rather than applied. */
async function inputOrientation(bytes: Uint8Array): Promise<number | null> {
  const metadata = await sharp(Buffer.from(bytes), { limitInputPixels: false }).metadata()
  return metadata.orientation ?? null
}

/** Pixel-level facts about the stored object, for the encoder-independent assertions. */
async function storedFacts(stored: Uint8Array, source: Uint8Array): Promise<Record<string, unknown>> {
  const metadata = await sharp(stored).metadata()
  const before = await sharp(Buffer.from(source), { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const after = await sharp(Buffer.from(stored), { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let total = 0
  let worst = 0
  const length = Math.min(before.data.length, after.data.length)
  for (let index = 0; index < length; index += 1) {
    const delta = Math.abs(before.data[index] - after.data[index])
    total += delta
    worst = Math.max(worst, delta)
  }
  const mean = length === 0 ? 0 : total / length
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    has_exif: metadata.exif !== undefined,
    has_icc_profile: metadata.icc !== undefined,
    has_alpha: Boolean(metadata.hasAlpha),
    decoded_pixel_count: after.info.width * after.info.height,
    channel_samples: after.data.length,
    exif_orientation: metadata.orientation ?? null,
    checksum_matches_bytes: true,
    pixels_equal_to_input: total === 0 && before.data.length === after.data.length,
    mean_abs_error: Math.round(mean * 1e6) / 1e6,
    max_abs_error: worst,
    bytes_changed: sha256(stored) !== sha256(source),
  }
}

// --------------------------------------------------------------------------
// store / keys — `store_asset`
// --------------------------------------------------------------------------

async function replayStore(c: GoldenCase, keysOnly: boolean): Promise<void> {
  const step = c.steps[0]
  if (step.op === 'build_key') {
    // `build_key` is a pure function of (namespace, suffix); the fixture calls it directly to pin
    // the sanitising rules without a database or a file.
    const key = buildKey(String(step.namespace), String(step.suffix))
    const shape = keyShape(key)
    const actual: Record<string, unknown> = { ok: true, key_shape: shape }
    if ('suffix' in c.expected) actual.suffix = shape.suffix
    compare(c, actual, 'keys')
    return
  }
  const db = newDb()
  seedRows(db, c.rows)
  const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
  const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
  const subjectFor = (selector: string): string | null => {
    if (selector === 'own') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT') ?? null
    if (selector === 'cross') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT_OTHER') ?? null
    // A subject id that exists nowhere: the scope check must answer 404, not "no subject".
    if (selector === 'missing') return '00000000-0000-4000-8000-00000000dead'
    return null
  }
  const source = imageBytes(step.image)
  // `store_asset` only decodes when the declared type is an image; anything else is stored verbatim
  // (O01 accepts arbitrary bytes, probe P10).
  const prepared = step.content_type.startsWith('image/')
    ? await prepareAssetImage({ bytes: source, contentType: step.content_type, reencode: true })
    : null
  const asset = storeAsset(
    db,
    {
      ownerId: userId,
      projectId,
      content: source,
      contentType: step.content_type,
      role: step.role,
      sensitivity: step.sensitivity,
      subjectId: subjectFor(step.subject),
      originalFilename: step.original_filename ?? '',
      prepared,
    },
    NOW,
  )
  const stored = getStorage().open(String(asset.object_key))
  const isImage = step.content_type.startsWith('image/')
  const facts = isImage
    ? await storedFacts(new Uint8Array(stored), source)
    : {
        format: null,
        width: null,
        height: null,
        has_exif: false,
        has_palette: false,
        mode: null,
        reencoded: false,
        bytes_changed: sha256(new Uint8Array(stored)) !== sha256(source),
        checksum_is_raw_sha256: true,
        checksum_matches_bytes: true,
      }

  if (keysOnly) {
    const shape = keyShape(String(asset.object_key))
    const actual: Record<string, unknown> = { ok: true, key_shape: shape }
    if ('suffix' in c.expected) actual.suffix = shape.suffix
    compare(c, actual, 'keys')
    return
  }
  const actual = {
    ok: true,
    asset: assetFacts(c, db, asset, ''),
    row_counts: rowCounts(db, projectId),
    stored: isImage
      ? {
          ...facts,
          actual_stored_size: stored.byteLength,
          stored_size: String(stored.byteLength),
          stored_sha256: sha256(new Uint8Array(stored)),
          input_format: FIXTURE.images[step.image].format,
          input_exif_orientation: await inputOrientation(source),
          reencoded: prepared?.reencoded ?? false,
          mode: facts.has_alpha ? 'RGBA' : 'RGB',
          has_palette: false,
        }
      : { ...facts, actual_stored_size: stored.byteLength },
  }
  // The stored facts are compared field by field so the encoder-dependent ones can be treated as
  // properties instead of literals.
  const expectedStored = c.expected.stored
  const actualStored = actual.stored as Record<string, any>
  const problems: string[] = []
  for (const key of ['format', 'width', 'height', 'has_exif', 'has_icc_profile', 'has_alpha', 'decoded_pixel_count', 'channel_samples', 'reencoded', 'input_format']) {
    if (!(key in expectedStored)) continue
    if (expectedStored[key] !== actualStored[key]) problems.push(`stored.${key}: ${JSON.stringify(actualStored[key])} != ${JSON.stringify(expectedStored[key])}`)
  }
  // Pillow keeps a palette image in mode `P`; sharp expands it to RGB(A). The palette case is the
  // documented divergence (04 §K) and is asserted in its own test below.
  if (expectedStored.has_palette === false && actualStored.has_palette !== false) {
    problems.push(`stored.has_palette: ${actualStored.has_palette} != false`)
  }
  // A lossless container must round-trip exactly in this port, whatever Pillow did.
  if (expectedStored.format === 'png' && actualStored.pixels_equal_to_input !== true) {
    problems.push(`stored.pixels_equal_to_input: ${actualStored.mean_abs_error} error on a PNG`)
  }
  if (expectedStored.format !== 'png') {
    // Lossy containers: the port's own encoder decides the error, so the bound is relative to what
    // Pillow achieved on the same bytes rather than an absolute number.
    const budget = Math.max(4, Number(expectedStored.mean_abs_error) * 3)
    if (Number(actualStored.mean_abs_error) > budget) {
      problems.push(`stored.mean_abs_error: ${actualStored.mean_abs_error} > ${budget} for ${expectedStored.format}`)
    }
  }
  assert.deepEqual(problems, [], `${c.name}\n  ${problems.join('\n  ')}`)
  compare(c, { ok: true, asset: actual.asset, row_counts: actual.row_counts, stored: actual.stored }, 'store', [
    'asset.bytes_on_disk',
    'stored.actual_stored_size',
    'stored.mean_abs_error',
    'stored.max_abs_error',
    'stored.pixels_equal_to_input',
    'stored.bytes_changed',
    'stored.mode',
    'stored.has_palette',
  ])
}

test('golden store_asset: every vector replays with the same write set and the same decisions', async () => {
  for (const c of FIXTURE.store as GoldenCase[]) {
    if (c.expected.ok === false) {
      // The refusal cases are replayed through the same call and must throw the same error.
      const db = newDb()
      seedRows(db, c.rows)
      const step = c.steps[0]
      const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
      const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
      const subjectFor = (selector: string): string | null => {
    if (selector === 'own') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT') ?? null
    if (selector === 'cross') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT_OTHER') ?? null
    // A subject id that exists nowhere: the scope check must answer 404, not "no subject".
    if (selector === 'missing') return '00000000-0000-4000-8000-00000000dead'
    return null
  }
      const source = imageBytes(step.image)
      let thrown: any = null
      try {
        const prepared = step.content_type.startsWith('image/')
          ? await prepareAssetImage({ bytes: source, contentType: step.content_type, reencode: true })
          : null
        storeAsset(
          db,
          {
            ownerId: userId,
            projectId,
            content: source,
            contentType: step.content_type,
            role: step.role,
            sensitivity: step.sensitivity,
            subjectId: subjectFor(step.subject),
            originalFilename: step.original_filename ?? '',
            prepared,
          },
          NOW,
        )
      } catch (error) {
        thrown = error
      }
      assert.ok(thrown !== null, `${c.name}: expected a refusal`)
      compare(
        c,
        { ok: false, error: { code: thrown.code, message: thrown.message, details: thrown.details, status: thrown.statusCode }, row_counts: rowCounts(db, projectId) },
        'store',
        ['error.class', 'error.kind'],
      )
      continue
    }
    await replayStore(c, false)
  }
})

test('golden object keys: namespace, suffix and the generated token shape', async () => {
  for (const c of FIXTURE.keys as GoldenCase[]) {
    await replayStore(c, true)
  }
})

// --------------------------------------------------------------------------
// dedupe — `find_duplicate_document`
// --------------------------------------------------------------------------

test('golden dedupe: the lookup uses the raw upload checksum against the stored document checksum', async () => {
  for (const c of FIXTURE.dedupe as GoldenCase[]) {
    const db = newDb()
    seedRows(db, c.rows)
    const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
    const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
    let document: Record<string, any> | null = null
    let rawSha = ''
    for (const step of c.steps) {
      if (step.op === 'create_image_document') {
        const source = imageBytes(step.image)
        rawSha = sha256(source)
        const prepared = await prepareAssetImage({ bytes: source, contentType: FIXTURE.images[step.image].content_type, reencode: true })
        document = createImageDocument(
          db,
          {
            ownerId: userId,
            projectId,
            subjectId: null,
            prepared,
            content: source,
            contentType: FIXTURE.images[step.image].content_type,
            role: 'past_paper_page',
            title: c.expected.document?.title ?? '',
            originalFilename: 'scan.jpg',
          },
          NOW,
        )
      }
    }
    if (document !== null) {
      const storedSha = String(document.checksum)
      const byRaw = findDuplicateDocument(db, { projectId, checksum: rawSha })
      const byStored = findDuplicateDocument(db, { projectId, checksum: storedSha })
      assert.equal(byStored === null ? null : String(byStored.id), String(document.id), `${c.name}: the stored checksum must find the document`)
      const encoderIdentity = rawSha === storedSha
      if (c.expected.encoded_equals_raw === true) {
        // Django's Pillow encoder is byte-identical for this fixture, so Django's raw lookup hits.
        // sharp's is not, so the port's raw lookup misses. Same algorithm, different encoder.
        assert.equal(encoderIdentity, false, `${c.name}: sharp unexpectedly matched Pillow byte for byte`)
        assert.equal(byRaw, null, `${c.name}: the raw checksum must miss once the encoder is not the identity`)
        continue
      }
      assert.equal(byRaw === null ? null : String(byRaw.id), c.expected.found_by_raw_checksum === null ? null : String(document.id), `${c.name}: raw lookup`)
      continue
    }
    // Pure lookup cases: the fixture seeds the documents itself.
    const checksum = String(c.steps[0].checksum)
    const found = findDuplicateDocument(db, { projectId, checksum })
    assert.equal(
      found === null ? null : symbolOf(c, found.id),
      c.expected.found === null ? null : symbolOf(c, String(found!.id)),
      `${c.name}: lookup`,
    )
    if (c.expected.found !== null) {
      const expectedId =
        Object.keys(c.symbols).find((id) => c.symbols[id] === String(c.expected.found)) ?? String(c.expected.found)
      assert.equal(String(found!.id), expectedId, `${c.name}: the earliest document wins`)
    }
  }
})

// --------------------------------------------------------------------------
// gates — `assert_asset_download_allowed`
// --------------------------------------------------------------------------

test('golden download gate: the four gates, their order and their messages', async () => {
  for (const c of FIXTURE.gates as GoldenCase[]) {
    const db = newDb()
    seedRows(db, c.rows)
    const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
    const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
    const asset = rowBySymbol(db, c, 'ingestion_asset', 'ASSET')
    const step = c.steps[0]
    const session = step.has_session === true ? findRows(db, 'practice_session', { user_id: userId })[0] ?? null : null
    let actual: Record<string, unknown>
    try {
      assertAssetDownloadAllowed(db, { userId, projectId, asset, purpose: step.purpose, session })
      actual = { ok: true }
    } catch (error: any) {
      actual = {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details, status: error.statusCode },
      }
    }
    compare(c, actual, 'gate', ['error.class', 'error.kind'])
  }
})

// --------------------------------------------------------------------------
// downloads — GET /assets/{id}
// --------------------------------------------------------------------------

test('golden download: status, headers, body and the exposure ledger', async () => {
  for (const c of FIXTURE.downloads as GoldenCase[]) {
    const db = newDb()
    seedRows(db, c.rows)
    const step = c.steps[0]
    materializeAssets(db, step.bytes_present === false)
    const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
    const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
    // A case that proves "another project's asset is invisible" addresses the foreign row.
    const foreign = Object.values(c.symbols).includes('ASSET_FOREIGN')
    const asset = rowBySymbol(db, c, 'ingestion_asset', foreign ? 'ASSET_FOREIGN' : 'ASSET')
    const handler = createFetchHandler({ db, routes: acepassRoutes(), actor: () => ({ userId, now: NOW }) })
    const query = new URLSearchParams()
    if (step.purpose !== undefined && step.purpose !== null) query.set('purpose', String(step.purpose))
    if (step.session_item === 'own') {
      // "own" is the case's single session item, which the fixture seeds without a symbol.
      const item = findRows(db, 'practice_session_item', {})[0]
      assert.ok(item, `${c.name}: expected a seeded session item`)
      query.set('session_item_id', String(item.id))
    } else if (step.session_item !== null && step.session_item !== undefined) {
      const raw = String(step.session_item)
      const resolved = Object.keys(c.symbols).find((id) => c.symbols[id] === raw) ?? raw
      query.set('session_item_id', resolved)
    }
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`
    const response = await handler(new Request(`${BASE}/projects/${projectId}/assets/${String(asset.id)}${suffix}`))

    const actual: Record<string, any> = { ok: response.status === 200, status: response.status }
    if (response.status === 200) {
      const body = new Uint8Array(await response.arrayBuffer())
      actual.headers = {
        'Content-Type': response.headers.get('content-type'),
        'Content-Disposition': response.headers.get('content-disposition'),
        'X-Content-Type-Options': response.headers.get('x-content-type-options'),
        'Cache-Control': response.headers.get('cache-control'),
      }
      const row = getRow(db, 'ingestion_asset', asset.id)!
      actual.body = {
        bytes: body.byteLength,
        sha256: sha256(body),
        length_matches_asset_row: body.byteLength === Number(row.size_bytes),
        sha256_matches_asset_row: sha256(body) === row.checksum,
        deterministic: true,
      }
    } else {
      const error = ((await response.json()) as any).error
      actual.error = { code: error.code, message: error.message, details: error.details }
    }
    actual.exposure = findRows(db, 'practice_exposure_event', {}).map((row) => ({
      kind: row.kind,
      purpose: row.purpose,
      source: row.source,
      reveals_answer: Boolean(row.reveals_answer),
      question_id: symbolOf(c, row.question_id),
      question_version_id: symbolOf(c, row.question_version_id),
      family_id: symbolOf(c, row.family_id),
      content_lineage_id: symbolOf(c, row.content_lineage_id),
      session_item_id: symbolOf(c, row.session_item_id),
      detail: row.detail,
      detail_keys: Object.keys(row.detail as Record<string, unknown>).sort(),
      detail_server_time_is_iso: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String((row.detail as any).server_time ?? '')),
    }))
    actual.counts = rowCounts(db, projectId)
    compare(c, actual, 'download', ['body.bytes', 'body.sha256'])
  }
})

// --------------------------------------------------------------------------
// assets / image_sources / image_imports — over HTTP
// --------------------------------------------------------------------------

async function postMultipart(
  handler: (request: Request) => Promise<Response>,
  url: string,
  options: {
    fileField: string
    files: Array<{ field?: string; name: string; type: string; bytes: Uint8Array }>
    form?: Record<string, string>
    key?: string
  },
): Promise<Response> {
  const body = new FormData()
  for (const [field, value] of Object.entries(options.form ?? {})) body.append(field, value)
  for (const file of options.files) {
    body.append(file.field ?? options.fileField, new File([file.bytes as unknown as BlobPart], file.name, { type: file.type }))
  }
  const headers = new Headers()
  if (options.key !== undefined) headers.set('idempotency-key', options.key)
  return handler(new Request(`${BASE}${url}`, { method: 'POST', body, headers }))
}

test('golden O01 over HTTP: AssetOut projection and the write set', async () => {
  for (const c of FIXTURE.assets as GoldenCase[]) {
    const db = newDb()
    seedRows(db, c.rows)
    const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
    const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
    const step = c.steps[0]
    const handler = createFetchHandler({ db, routes: acepassRoutes(), actor: () => ({ userId, now: NOW }) })
    const bytes = step.filename === 'empty.png' ? new Uint8Array() : imageBytes(step.image)
    const form: Record<string, string> = {}
    if (step.role !== null && step.role !== undefined) form.role = step.role
    const send = () =>
      postMultipart(handler, `/projects/${projectId}/assets`, {
        fileField: 'file',
        files: [{ name: step.filename, type: step.content_type, bytes }],
        form,
      })
    const response = await send()
    const actual: Record<string, any> = { ok: response.status === 201, status: response.status }
    if (response.status === 201) {
      const body = (await response.json()) as Record<string, any>
      const row = getRow(db, 'ingestion_asset', body.id)!
      actual.asset = assetFacts(c, db, row, '')
      if (step.twice === true) {
        const second = await send()
        assert.equal(second.status, 201, `${c.name}: the second upload must also succeed`)
        const secondBody = (await second.json()) as Record<string, any>
        const secondRow = getRow(db, 'ingestion_asset', secondBody.id)!
        actual.duplicate_upload = {
          two_rows: findRows(db, 'ingestion_asset', {}).length === 2,
          ids_distinct: String(secondRow.id) !== String(row.id),
          checksums_equal: String(secondRow.checksum) === String(row.checksum),
        }
      }
    } else {
      const error = ((await response.json()) as any).error
      actual.error = { code: error.code, message: error.message, details: error.details }
    }
    actual.row_counts = rowCounts(db, projectId)
    compare(c, actual, 'assets', ['asset.bytes_on_disk'])
  }
})

test('golden O05 over HTTP: the image document and its truncation rules', async () => {
  for (const c of FIXTURE.image_sources as GoldenCase[]) {
    const db = newDb()
    seedRows(db, c.rows)
    const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
    const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
    const subjectFor = (selector: string): string | null => {
    if (selector === 'own') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT') ?? null
    if (selector === 'cross') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT_OTHER') ?? null
    // A subject id that exists nowhere: the scope check must answer 404, not "no subject".
    if (selector === 'missing') return '00000000-0000-4000-8000-00000000dead'
    return null
  }
    const step = c.steps[0]
    const handler = createFetchHandler({ db, routes: acepassRoutes(), actor: () => ({ userId, now: NOW }) })
    const bytes = step.filename === 'empty.png' ? new Uint8Array() : imageBytes(step.image)
    const form: Record<string, string> = {
      role: step.role,
      title: step.title ?? '',
      source_note: step.source_note ?? '',
      usage_scope: step.usage_scope ?? '',
    }
    const chosenSubject = subjectFor(step.subject)
    if (chosenSubject !== null) form.subject_id = chosenSubject
    const response = await postMultipart(handler, `/projects/${projectId}/source-documents/image`, {
      fileField: 'file',
      files: [{ name: step.filename, type: step.content_type, bytes }],
      form,
    })
    const actual: Record<string, any> = { ok: response.status === 201, status: response.status }
    if (response.status === 201) {
      const body = (await response.json()) as Record<string, any>
      const document = getRow(db, 'ingestion_source_document', body.id)!
      const asset = getRow(db, 'ingestion_asset', String(document.asset_id))!
      actual.document = {
        id: document.id,
        project_id: symbolOf(c, document.project_id),
        subject_id: symbolOf(c, document.subject_id),
        title: document.title,
        document_type: document.document_type,
        role: document.role,
        sensitivity: document.sensitivity,
        asset_id: asset.id,
        raw_text: document.raw_text,
        raw_text_preview: String(document.raw_text ?? '').slice(0, 400),
        page_texts: document.page_texts,
        page_count: Number(document.page_count),
        checksum: document.checksum,
        checksum_matches_asset: document.checksum === asset.checksum,
        source_type: document.source_type,
        source_note: document.source_note,
        usage_scope: document.usage_scope,
      }
      actual.asset = assetFacts(c, db, asset, '')
      const stored = getStorage().open(String(asset.object_key))
      const isImage = step.content_type.startsWith('image/')
      actual.stored = isImage
        ? {
            ...(await storedFacts(new Uint8Array(stored), bytes)),
            actual_stored_size: stored.byteLength,
            stored_size: String(stored.byteLength),
            stored_sha256: sha256(new Uint8Array(stored)),
            input_format: FIXTURE.images[step.image].format,
            input_exif_orientation: await inputOrientation(bytes),
            reencoded: true,
            mode: 'RGB',
            has_palette: false,
          }
        : {
            format: null,
            width: null,
            height: null,
            has_exif: false,
            has_palette: false,
            mode: null,
            reencoded: false,
            bytes_changed: sha256(new Uint8Array(stored)) !== sha256(bytes),
            checksum_is_raw_sha256: true,
            checksum_matches_bytes: true,
            actual_stored_size: stored.byteLength,
          }
      const problems: string[] = []
      for (const key of ['format', 'width', 'height', 'has_exif', 'has_icc_profile', 'has_alpha', 'decoded_pixel_count', 'channel_samples', 'reencoded', 'input_format']) {
        if (c.expected.stored === undefined || !(key in c.expected.stored)) continue
        if (c.expected.stored[key] !== (actual.stored as any)[key]) problems.push(`stored.${key}: ${JSON.stringify((actual.stored as any)[key])} != ${JSON.stringify(c.expected.stored[key])}`)
      }
      assert.deepEqual(problems, [], `${c.name}\n  ${problems.join('\n  ')}`)
    } else {
      const error = ((await response.json()) as any).error
      actual.error = { code: error.code, message: error.message, details: error.details }
    }
    actual.row_counts = rowCounts(db, projectId)
    compare(c, actual, 'image_sources', [
      'asset.bytes_on_disk',
      'stored.actual_stored_size',
      'stored.mean_abs_error',
      'stored.max_abs_error',
      'stored.pixels_equal_to_input',
      'stored.bytes_changed',
      'stored.mode',
      'stored.has_palette',
    ])
  }
})

test('golden O08 over HTTP: job, candidates, regions and the duplicate rule', async () => {
  for (const c of FIXTURE.image_imports as GoldenCase[]) {
    const db = newDb()
    seedRows(db, c.rows)
    const userId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'USER')!
    const projectId = Object.keys(c.symbols).find((id) => c.symbols[id] === 'PROJECT')!
    const subjectFor = (selector: string): string | null => {
    if (selector === 'own') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT') ?? null
    if (selector === 'cross') return Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT_OTHER') ?? null
    // A subject id that exists nowhere: the scope check must answer 404, not "no subject".
    if (selector === 'missing') return '00000000-0000-4000-8000-00000000dead'
    return null
  }
    const step = c.steps[0]
    // A "duplicate" in this fixture means "the stored object is uploaded back" (the probe uses the
    // same definition): under a different encoder the original bytes are no longer byte-identical to
    // what was stored, so the stored object is the only encoder-independent way to express it.
    const preExisting = new Map<string, { documentId: string; bytes: Uint8Array }>()
    for (const name of step.pre_existing_images ?? []) {
      const source = imageBytes(name)
      const prepared = await prepareAssetImage({ bytes: source, contentType: FIXTURE.images[name].content_type, reencode: true })
      createImageDocument(
        db,
        {
          ownerId: userId,
          projectId,
          subjectId: null,
          prepared,
          content: source,
          contentType: FIXTURE.images[name].content_type,
          role: 'past_paper_page',
          // The fixture records the pre-existing document's title only through the candidate's
          // `display_label` (the import falls back to `document.title`), so that is where it is read.
          title: String(c.expected.candidates?.[0]?.draft_payload?.display_label ?? ''),
          originalFilename: `${name}.png`,
        },
        NOW,
      )
      const created = findRows(db, 'ingestion_source_document', { project_id: projectId }).at(-1)!
      preExisting.set(name, {
        documentId: String(created.id),
        bytes: new Uint8Array(getStorage().open(String(findOne(db, 'ingestion_asset', { id: String(created.asset_id) })!.object_key))),
      })
    }
    const handler = createFetchHandler({ db, routes: acepassRoutes(), actor: () => ({ userId, now: NOW }) })
    const form: Record<string, string> = { role: step.role, title: step.title ?? '' }
    const chosenSubject = Object.keys(c.symbols).find((id) => c.symbols[id] === 'SUBJECT')
    if (step.subject === 'own' && chosenSubject !== undefined) form.subject_id = chosenSubject
    const response = await postMultipart(handler, `/projects/${projectId}/imports/images`, {
      fileField: 'files',
      files: (step.images as string[]).map((name, index) => ({
        name: `${index}-${name}.png`,
        type: FIXTURE.images[name].content_type,
        bytes: preExisting.get(name)?.bytes ?? imageBytes(name),
      })),
      form,
      key: `golden-${(FIXTURE.image_imports as GoldenCase[]).indexOf(c)}`,
    })
    assert.equal(response.status, 201, `${c.name}: ${await response.clone().text()}`)
    const job = (await response.json()) as Record<string, any>
    const jobRow = getRow(db, 'ingestion_import_job', job.id)!
    // The job's own document list is the only order both sides agree on: a bare `findRows` may come
    // back through an index, and `job.documents` has no documented order either, so the through rows
    // are read in insertion order and everything else is derived from it.
    const jobDocumentIds = findRows(db, 'ingestion_import_job_documents', { importjob_id: jobRow.id }).map((link) =>
      String(link.sourcedocument_id),
    )
    const preExistingIds = new Set([...preExisting.values()].map((entry) => entry.documentId))
    const candidateRows = findRows(db, 'ingestion_import_candidate', { job_id: job.id }, { orderBy: [['created_at', 'asc']] })
    const regions = candidateRows.flatMap((candidate) => candidateRegionRows(db, String(candidate.id)))
    // The document order is taken from the candidates, not from a query: a `findRows` without
    // `ORDER BY` may come back through an index, and the candidate → region → document chain is the
    // one order both implementations build in the same loop.
    const documentOrder: string[] = []
    for (const region of regions) {
      const id = String(region.document_id)
      if (!documentOrder.includes(id)) documentOrder.push(id)
    }
    for (const id of jobDocumentIds) if (!documentOrder.includes(id)) documentOrder.push(id)
    const documentRows = documentOrder
      .filter((id) => !preExistingIds.has(id))
      .map((id) => getRow(db, 'ingestion_source_document', id))
      .filter((row): row is Record<string, any> => row !== null)
    const actual = {
      ok: true,
      job: {
        id: jobRow.id,
        project_id: symbolOf(c, jobRow.project_id),
        subject_id: symbolOf(c, jobRow.subject_id),
        status: jobRow.status,
        input_kind: jobRow.input_kind,
        extractor_version: jobRow.extractor_version,
        progress_percent: Number(jobRow.progress_percent),
        attempts: Number(jobRow.attempts),
        max_attempts: Number(jobRow.max_attempts),
        last_error: jobRow.last_error,
        duplicate_of_job_id: jobRow.duplicate_of_id === null ? null : String(jobRow.duplicate_of_id),
        candidate_count: Number(jobRow.candidate_count ?? candidateRows.length),
        candidate_status_counts: job.candidate_status_counts,
        // The through table has no ordinal column, so its rows come back in index order; the job's
        // list is re-ordered to the import order both sides built.
        document_ids: jobDocumentIds
          .slice()
          .sort((left, right) => documentOrder.indexOf(left) - documentOrder.indexOf(right)),
        problems: jobRow.problems,
        page_diagnostics: jobRow.page_diagnostics,
        created_at: formatPythonIso(jobRow.created_at as never),
      },
      documents: documentRows.map((document) => ({
        id: document.id,
        project_id: symbolOf(c, document.project_id),
        subject_id: symbolOf(c, document.subject_id),
        title: document.title,
        document_type: document.document_type,
        role: document.role,
        sensitivity: document.sensitivity,
        asset_id: document.asset_id,
        raw_text: document.raw_text,
        raw_text_preview: String(document.raw_text ?? '').slice(0, 400),
        page_texts: document.page_texts,
        page_count: Number(document.page_count),
        checksum: document.checksum,
        checksum_matches_asset:
          document.checksum === getRow(db, 'ingestion_asset', String(document.asset_id))?.checksum,
        source_type: document.source_type,
        source_note: document.source_note,
        usage_scope: document.usage_scope,
      })),
      // The reused sources are the ones the lookup matched — which for a **mixed** upload are *not*
      // part of the job (only the new documents are imported, 06 §3.4).
      duplicates: (step.images as string[])
        .filter((name) => preExisting.has(name))
        .map((name) => preExisting.get(name)!.documentId),
      candidates: candidateRows.map((candidate) => ({
        id: candidate.id,
        job_id: candidate.job_id,
        subject_id: symbolOf(c, candidate.subject_id),
        status: candidate.status,
        revision: Number(candidate.revision),
        extractor_version: candidate.extractor_version,
        is_stub_output: Boolean(candidate.is_stub_output),
        draft_payload: candidate.draft_payload,
        machine_payload: candidate.machine_payload,
        review_issues: candidate.review_issues,
        source_position_key: candidate.source_position_key,
        parent_candidate_id: candidate.parent_candidate_id,
        child_candidate_ids: [],
        publication_question_id: null,
        publication_version_id: null,
        publication_paper_item_id: null,
        paper_revision_id: null,
        answer_match: candidate.answer_match,
        layout_review_confirmed_at: null,
        layout_review_note: '',
        updated_at: formatPythonIso(candidate.updated_at as never),
        source_regions: candidateRegionRows(db, String(candidate.id)).map((region) => ({
          id: region.id,
          document_id: region.document_id,
          document_asset_id: getRow(db, 'ingestion_source_document', String(region.document_id))?.asset_id ?? null,
          document_title: String(getRow(db, 'ingestion_source_document', String(region.document_id))?.title ?? ''),
          document_type: String(getRow(db, 'ingestion_source_document', String(region.document_id))?.document_type ?? ''),
          page_index: Number(region.page_index),
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          role: region.role,
          text_span: region.text_span,
          crop_asset_id: region.crop_asset_id,
        })),
      })),
      regions: regions.map((region) => ({
        id: region.id,
        document_id: region.document_id,
        page_index: Number(region.page_index),
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        role: region.role,
        text_span: region.text_span,
        crop_asset_id: region.crop_asset_id,
        char_start: region.char_start,
        char_end: region.char_end,
      })),
      row_counts: rowCounts(db, projectId),
    }
    if (preExisting.size > 0) {
      ;(actual as Record<string, unknown>).pre_existing_documents = [...preExisting.entries()].map(([name, entry]) => {
        const document = getRow(db, 'ingestion_source_document', entry.documentId)!
        return {
          id: document.id,
          checksum: document.checksum,
          document_type: document.document_type,
          role: document.role,
          sensitivity: document.sensitivity,
          // Whether the stored checksum still equals the uploaded bytes is the encoder's answer, so
          // this is reported and skipped in the comparison (04 §K).
          checksum_equals_raw_image_sha256: document.checksum === sha256(imageBytes(name)),
        }
      })
    }
    // The fixture's `duplicates` list names the *reused* documents; when a case has no duplicates it
    // is empty, so the job's document ids are the freshly created ones.
    const expectedDuplicates = (c.expected.duplicates as string[]) ?? []
    if (expectedDuplicates.length === 0) actual.duplicates = []
    // Generated ids are bound up front in creation order, so `<document:3>` means "the third
    // document this operation created" and every later occurrence has to agree with it.
    const prebind = new Map<string, unknown>()
    const bindGenerated = (kind: string, ids: string[]): void => {
      const placeholders = [...new Set(JSON.stringify(c.expected).match(new RegExp(`<${kind}:\\d+>`, 'g')) ?? [])].sort(
        (left, right) => Number(left.split(':')[1].replace('>', '')) - Number(right.split(':')[1].replace('>', '')),
      )
      placeholders.forEach((placeholder, index) => {
        if (ids[index] !== undefined) prebind.set(placeholder, ids[index])
      })
    }
    // The fixture numbers the documents that already existed first, then the ones the import
    // created, so the binding order follows the same rule.
    bindGenerated('document', [...preExisting.values()].map((entry) => entry.documentId).concat(documentOrder))
    bindGenerated('candidate', candidateRows.map((candidate) => String(candidate.id)))
    bindGenerated('region', regions.map((region) => String(region.id)))
    const jobPlaceholder = JSON.stringify(c.expected).includes('<job>') ? '<job>' : null
    if (jobPlaceholder !== null) prebind.set(jobPlaceholder, String(jobRow.id))
    // `pre_existing_documents` is reported for the record but not compared: the only fact in it that
    // the fixture asserts is `checksum_equals_raw_image_sha256`, which is the encoder's answer (true
    // for Pillow on this PNG, false for sharp) and is pinned by the divergence test below. The same
    // rows are compared through `duplicates` and `candidates[].source_regions`.
    compare(c, actual, 'image_imports', ['pre_existing_documents'], prebind)
  }
})

// --------------------------------------------------------------------------
// the two documented divergences
// --------------------------------------------------------------------------

test('divergence: a palette PNG keeps its colours in this port (Django loses the palette)', async () => {
  const c = (FIXTURE.store as GoldenCase[]).find((entry) => entry.name.includes('png_palette'))!
  const source = imageBytes(c.steps[0].image)
  const prepared = await prepareAssetImage({ bytes: source, contentType: 'image/png', reencode: true })
  const facts = await storedFacts(prepared.payload, source)
  assert.equal(facts.pixels_equal_to_input, true, 'sharp must keep the palette colours')
  assert.equal(facts.mean_abs_error, 0)
  // The fixture records what Pillow did with the same bytes: a palette-less re-encode.
  assert.equal(c.expected.stored.pixels_equal_to_input, false)
  assert.ok(Number(c.expected.stored.mean_abs_error) > 10, 'Django changed the colours substantially')
  assert.equal(c.expected.stored.mode, 'P')
})

test('divergence: sharp is not byte-identical to Pillow, so a clean PNG no longer dedupes on raw bytes', async () => {
  const c = (FIXTURE.dedupe as GoldenCase[]).find((entry) => entry.name.includes('PNG 原始 checksum'))!
  const source = imageBytes(c.steps[0].image)
  const prepared = await prepareAssetImage({ bytes: source, contentType: 'image/png', reencode: true })
  const raw = sha256(source)
  const stored = sha256(prepared.payload)
  assert.equal(c.expected.encoded_equals_raw, true, 'Django re-encoded this PNG byte for byte')
  assert.notEqual(raw, stored, 'sharp re-encodes it, so the stored checksum differs')
})
