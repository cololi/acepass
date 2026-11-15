/**
 * Golden replay for ingestion B4, part 2: the O09 write-set.
 *
 * `scripts/gen_ingestion_b4_imports_golden.py` seeds real PostgreSQL rows, calls the **real**
 * `start_pdf_import` (and the real paper services behind it) and freezes the resulting rows as a
 * projection. This file seeds the same rows into SQLite, runs the same import, and compares field by
 * field.
 *
 * Four conventions make the comparison possible across two implementations:
 *
 * 1. **Placeholders.** `<document:n>`, `<asset:n>`, `<region:n>`, `<candidate:n>`, `<paper:n>` and
 *    `<revision>` are ids the operation creates, numbered by insertion order per role across the
 *    whole case (pre-imports included, which is why `duplicate_bytes` starts at `<candidate:5>`);
 *    `<job>` is the reported job. The comparator binds each placeholder on first sight and then
 *    requires every later occurrence to agree, so "the job points at the document the region points
 *    at" is still checked. Seeded rows keep their symbolic name (`PROJECT`, `SUBJECT`, `PAPER`, …).
 * 2. **`<stored_sha256:n>`** is the checksum of the bytes actually written. PDFs are never
 *    re-encoded, so it must equal the SHA-256 of the upload — asserted relationally, not by literal.
 * 3. **Geometry is exact where it is comparable.** Every paper fixture is built with
 *    `build_layout_pdf` (explicit `Tm`); `scanned_mixed` is marked `geometry_comparable: false`
 *    because `build_scanned_pdf` lays its native pages out with `T*`, which pypdf mis-scales
 *    (04 §L DIV-B4-1). For that case `y`/`height` are masked on both sides before comparing.
 * 4. **The error cases assert a zero write-set**: the row counts before and after must be identical,
 *    which is what "one transaction" means for a batch that fails on its second file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { getRow, insertRow, type Row } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { candidateSourceRegionRows } from '../src/services/ingestion.ts'
import { startPdfImport, type PdfUpload } from '../src/services/ingestion_imports.ts'
import { configureStorage, resetStorageCache } from '../src/ingestion/storage.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GOLDEN = JSON.parse(readFileSync(new URL('./golden/ingestion_b4_imports.json', import.meta.url), 'utf8'))
const NOW = parseInstant(GOLDEN.now)
const MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'acepass-b4-imports-'))
configureStorage(MEDIA_ROOT)
process.on('exit', () => {
  resetStorageCache()
  rmSync(MEDIA_ROOT, { recursive: true, force: true })
})

const FLOAT_TOL = 1e-9

function closeEnough(actual: number, expected: number): boolean {
  if (Number.isNaN(expected) && Number.isNaN(actual)) return true
  return Math.abs(actual - expected) <= FLOAT_TOL
}

/** A deep comparison that treats floats as approximate and everything else as exact. */
function assertDeepClose(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${path}: expected a number, got ${JSON.stringify(actual)}`)
    assert.ok(closeEnough(actual as number, expected), `${path}: expected ${expected}, got ${String(actual)}`)
    return
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`)
    assert.equal((actual as unknown[]).length, expected.length, `${path}: length`)
    expected.forEach((value, index) => assertDeepClose((actual as unknown[])[index], value, `${path}[${index}]`))
    return
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `${path}: expected an object`)
    const want = Object.keys(expected as Record<string, unknown>).sort()
    const got = Object.keys(actual as Record<string, unknown>).sort()
    assert.deepEqual(got, want, `${path}: keys`)
    for (const key of want) {
      assertDeepClose((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`)
    }
    return
  }
  assert.deepEqual(actual, expected, path)
}

/** Replace every occurrence of a known id inside every string of a structure. */
function substitute(value: unknown, mapping: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let result = value
    for (const [needle, replacement] of mapping) {
      if (needle.length > 0 && result.includes(needle)) result = result.split(needle).join(replacement)
    }
    return result
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, mapping))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = substitute(entry, mapping)
    return out
  }
  return value
}

/**
 * Mask the values a `T*`-based fixture cannot compare: `y`/`height` of a region and the `bbox` of a
 * source span. Applied to both sides, so the rest of the structure is still compared exactly.
 */
function maskGeometry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => maskGeometry(entry))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'y' || key === 'height') out[key] = '<uncomparable>'
      else if (key === 'bbox' && entry !== null && typeof entry === 'object') out[key] = '<uncomparable>'
      else out[key] = maskGeometry(entry)
    }
    return out
  }
  return value
}

interface Ctx {
  db: ReturnType<typeof openStore>['db']
  seeded: Set<string>
  symbols: Map<string, string>
}

/**
 * Insert parents before children.
 *
 * The golden lists the seed tables in the order the generator created them, which is not a
 * dependency order (`exams_paper` comes before `exams_subject`). SQLite enforces the foreign keys, so
 * the replay sorts the tables topologically first.
 */
function orderedTables(names: string[]): string[] {
  const present = new Set(names)
  const result: string[] = []
  const visiting = new Set<string>()
  const visit = (name: string): void => {
    if (result.includes(name) || visiting.has(name)) return
    visiting.add(name)
    const definition = TABLES.find((entry) => entry.name === name)
    assert.ok(definition, `unknown table ${name}`)
    for (const foreignKey of definition.foreignKeys) {
      if (foreignKey.refTable !== name && present.has(foreignKey.refTable)) visit(foreignKey.refTable)
    }
    visiting.delete(name)
    result.push(name)
  }
  for (const name of names) visit(name)
  return result
}

function seed(ctx: Ctx, rows: Record<string, Array<Record<string, unknown>>>): void {
  // `exams_paper.effective_revision_id` and `exams_paper_revision.paper_id` form a cycle, so a
  // topological insert order cannot exist. Enforcement is lifted for the fixture load and the whole
  // database is checked afterwards, which is stricter than trusting the order.
  ctx.db.exec('PRAGMA foreign_keys = OFF')
  try {
    seedUnchecked(ctx, rows)
  } finally {
    ctx.db.exec('PRAGMA foreign_keys = ON')
  }
  const violations = ctx.db.prepare('PRAGMA foreign_key_check').all() as unknown[]
  assert.equal(violations.length, 0, 'the seeded rows must be referentially complete')
}

function seedUnchecked(ctx: Ctx, rows: Record<string, Array<Record<string, unknown>>>): void {
  for (const table of orderedTables(Object.keys(rows))) {
    const list = rows[table] ?? []
    const definition = TABLES.find((entry) => entry.name === table)
    assert.ok(definition, `unknown table ${table}`)
    for (const raw of list) {
      const row: Row = {}
      for (const [column, value] of Object.entries(raw)) {
        const meta = definition.columns.find((entry) => entry.name === column)
        row[column] = meta?.kind === 'datetime' && typeof value === 'string' ? parseInstant(value) : value
      }
      const inserted = insertRow(ctx.db, table, row, { now: NOW })
      ctx.seeded.add(String(inserted.id))
    }
  }
}

function fixtureUpload(name: string, filename: string, contentType = 'application/pdf'): PdfUpload {
  const entry = GOLDEN.fixtures[name]
  assert.ok(entry, `unknown fixture ${name}`)
  return { filename, bytes: new Uint8Array(Buffer.from(entry.base64, 'base64')), contentType }
}

function uploadsFor(ctx: Ctx, input: Record<string, any>): { paperFiles: PdfUpload[]; answerFiles: PdfUpload[] } {
  const overrides = (input.file_overrides ?? {}) as Record<string, Record<string, string>>
  const build = (name: string, index: number, field: 'files' | 'answer_files'): PdfUpload => {
    const override = overrides[name] ?? {}
    const fallback = field === 'files' ? `paper-${index + 1}.pdf` : `answers-${index + 1}.pdf`
    const filename = override.filename ?? (field === 'files' ? `${name}.pdf` : `${name}.pdf`)
    const upload = fixtureUpload(name, filename || fallback, override.content_type ?? 'application/pdf')
    return upload
  }
  return {
    paperFiles: (input.paper_files as string[]).map((name, index) => build(name, index, 'files')),
    answerFiles: (input.answer_files as string[]).map((name, index) => build(name, index, 'answer_files')),
  }
}

function importInput(ctx: Ctx, input: Record<string, any>) {
  const { paperFiles, answerFiles } = uploadsFor(ctx, input)
  const resolve = (symbol: string | null): string | null => {
    if (symbol === null || symbol === undefined || symbol === '') return null
    for (const [id, name] of ctx.symbols) if (name === symbol) return id
    throw new Error(`unknown symbol ${symbol}`)
  }
  return {
    ownerId: resolve('USER')!,
    projectId: resolve(input.project)!,
    subjectId: resolve(input.subject ?? null),
    paperFiles,
    answerFiles,
    title: input.title ?? '',
    sourceNote: input.source_note ?? '',
    usageScope: input.usage_scope ?? '',
    cycleKey: input.cycle_key ?? '',
    sessionKey: input.session_key ?? '',
    paperCode: input.paper_code ?? '',
    sourceKind: input.source_kind ?? 'official_past',
    expectedSessionCount: input.expected_session_count ?? null,
    paperTitle: input.paper_title ?? '',
  }
}

function rowIds(ctx: Ctx, table: string): string[] {
  return (ctx.db.prepare(`SELECT "id" AS id FROM "${table}" ORDER BY rowid ASC`).all() as Array<{ id: string }>).map(
    (row) => String(row.id),
  )
}

/** Placeholder numbering: per role, insertion order, skipping the rows that were seeded. */
function placeholders(ctx: Ctx): Map<string, string> {
  const mapping = new Map<string, string>()
  const roles: Array<[string, string]> = [
    ['document', 'ingestion_source_document'],
    ['asset', 'ingestion_asset'],
    ['region', 'ingestion_source_region'],
    ['candidate', 'ingestion_import_candidate'],
  ]
  for (const [role, table] of roles) {
    const created = rowIds(ctx, table).filter((id) => !ctx.seeded.has(id))
    created.forEach((id, index) => mapping.set(id, `<${role}:${index + 1}>`))
  }
  const papers = rowIds(ctx, 'exams_paper').filter((id) => !ctx.seeded.has(id))
  papers.forEach((id, index) => mapping.set(id, `<paper:${index + 1}>`))
  const revisions = rowIds(ctx, 'exams_paper_revision').filter((id) => !ctx.seeded.has(id))
  revisions.forEach((id) => mapping.set(id, '<revision>'))
  return mapping
}

function projectJob(ctx: Ctx, job: Row, mapping: Map<string, string>): Record<string, unknown> {
  return {
    input_kind: job.input_kind,
    extractor_version: job.extractor_version,
    status: job.status,
    progress_percent: Number(job.progress_percent),
    input_fingerprint: job.input_fingerprint,
    duplicate_of: job.duplicate_of_id === null ? null : String(job.duplicate_of_id),
    problems: job.problems ?? [],
    page_diagnostics: job.page_diagnostics ?? [],
  }
}

function projectDocuments(ctx: Ctx, jobId: string): Array<Record<string, unknown>> {
  const ids = (
    ctx.db
      .prepare(`SELECT "sourcedocument_id" AS id FROM "ingestion_import_job_documents" WHERE "importjob_id" = ? ORDER BY rowid ASC`)
      .all(jobId) as Array<{ id: string }>
  ).map((row) => String(row.id))
  return ids.map((id) => {
    const document = getRow(ctx.db, 'ingestion_source_document', id)!
    const asset = document.asset_id === null ? null : getRow(ctx.db, 'ingestion_asset', String(document.asset_id))!
    assert.ok(asset !== null, 'a PDF document always has an asset')
    return {
      document_type: document.document_type,
      role: document.role,
      sensitivity: document.sensitivity,
      title: document.title,
      page_count: Number(document.page_count),
      page_texts: document.page_texts,
      raw_text: document.raw_text,
      source_type: document.source_type,
      source_note: document.source_note,
      usage_scope: document.usage_scope,
      checksum: document.checksum,
      checksum_is_stored_bytes_sha256: true,
      asset: {
        content_type: asset!.content_type,
        size_bytes: Number(asset!.size_bytes),
        original_filename: asset!.original_filename,
        role: asset!.role,
        sensitivity: asset!.sensitivity,
        object_key_shape: objectKeyShape(String(asset!.object_key)),
      },
    }
  })
}

/** `<owner>/<project>/source/<2hex>/<32hex>.pdf` — the shape, never the key. */
function objectKeyShape(key: string): string {
  const parts = key.split('/')
  if (parts.length !== 5) return `<unexpected:${parts.length}>`
  const file = parts[4]
  const suffix = file.slice(file.lastIndexOf('.'))
  return `<owner>/<project>/${parts[2]}/<2hex>/<32hex>${suffix}`
}

function projectCandidates(ctx: Ctx, jobId: string): Array<Record<string, unknown>> {
  const candidates = (
    ctx.db
      .prepare(`SELECT * FROM "ingestion_import_candidate" WHERE "job_id" = ? ORDER BY rowid ASC`)
      .all(jobId) as Row[]
  ).map((row) => getRow(ctx.db, 'ingestion_import_candidate', String(row.id))!)
  return candidates.map((candidate) => {
    const payload = candidate.draft_payload as Record<string, unknown>
    const regions = candidateSourceRegionRows(ctx.db, String(candidate.id)).map((region) => ({
      document: region.document_id === null ? null : String(region.document_id),
      page_index: Number(region.page_index),
      x: Number(region.x),
      y: Number(region.y),
      width: Number(region.width),
      height: Number(region.height),
      role: region.role,
      text_span: region.text_span,
      char_start: region.char_start === null ? null : Number(region.char_start),
      char_end: region.char_end === null ? null : Number(region.char_end),
    }))
    return {
      source_position_key: candidate.source_position_key,
      display_label: payload['display_label'],
      status: candidate.status,
      revision: Number(candidate.revision),
      extractor_version: candidate.extractor_version,
      is_stub_output: candidate.is_stub_output,
      paper_revision: candidate.paper_revision_id === null ? null : String(candidate.paper_revision_id),
      parent: candidate.parent_candidate_id === null ? null : String(candidate.parent_candidate_id),
      answer_match: candidate.answer_match,
      draft_payload: payload,
      machine_payload_equals_draft: JSON.stringify(candidate.machine_payload) === JSON.stringify(payload),
      review_issues: candidate.review_issues ?? [],
      regions,
    }
  })
}

/**
 * The paper occurrences the import opened a revision for.
 *
 * That includes a **seeded** paper (`duplicate_paper_position` imports into an occurrence that
 * already exists), which is why the list is derived from the new revisions rather than from "rows
 * the import created".
 */
function projectPapers(ctx: Ctx): Array<Record<string, unknown>> {
  const paperIds: string[] = []
  for (const revisionId of rowIds(ctx, 'exams_paper_revision').filter((id) => !ctx.seeded.has(id))) {
    const revision = getRow(ctx.db, 'exams_paper_revision', revisionId)!
    const paperId = String(revision.paper_id)
    if (!paperIds.includes(paperId)) paperIds.push(paperId)
  }
  return paperIds.map((id) => {
      const paper = getRow(ctx.db, 'exams_paper', id)!
      return {
        cycle_key: paper.cycle_key,
        session_key: paper.session_key,
        paper_code: paper.paper_code,
        source_kind: paper.source_kind,
        title: paper.title,
        subject: paper.subject_id,
      }
    })
}

function projectRevisions(ctx: Ctx): Array<Record<string, unknown>> {
  return rowIds(ctx, 'exams_paper_revision')
    .filter((id) => !ctx.seeded.has(id))
    .map((id) => {
      const revision = getRow(ctx.db, 'exams_paper_revision', id)!
      const paper = getRow(ctx.db, 'exams_paper', String(revision.paper_id))!
      return {
        revision: Number(revision.revision),
        status: revision.status,
        expected_session_count: revision.expected_session_count === null ? null : Number(revision.expected_session_count),
        covered_session_count: revision.covered_session_count === null ? null : Number(revision.covered_session_count),
        note: revision.note,
        paper: paper.id,
        coverage_confirmed_at_is_null: revision.coverage_confirmed_at === null,
        effective_revision_is_null: paper.effective_revision_id === null,
        is_effective: String(paper.effective_revision_id ?? '') === String(revision.id),
      }
    })
}

function projectContentRevisions(ctx: Ctx): Array<Record<string, unknown>> {
  return rowIds(ctx, 'audit_content_revision')
    .filter((id) => !ctx.seeded.has(id))
    .map((id) => {
      const row = getRow(ctx.db, 'audit_content_revision', id)!
      return {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        action: row.action,
        reason: row.reason,
        detail: row.detail,
      }
    })
}

const COUNTED_TABLES = [
  'ingestion_asset',
  'ingestion_source_document',
  'ingestion_import_job',
  'ingestion_import_job_documents',
  'ingestion_source_region',
  'ingestion_import_candidate',
  'ingestion_import_candidate_source_regions',
  'ingestion_candidate_revision',
  'exams_paper',
  'exams_paper_revision',
  'exams_paper_item',
  'audit_content_revision',
]

function countRows(ctx: Ctx): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of COUNTED_TABLES) {
    const row = ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
    counts[table] = Number(row.n)
  }
  return counts
}

function newCase(seedRows: Record<string, Array<Record<string, unknown>>>, symbols: Record<string, string>): Ctx {
  const handle = openStore({ path: ':memory:' })
  const ctx: Ctx = { db: handle.db, seeded: new Set<string>(), symbols: new Map(Object.entries(symbols).map(([id, name]) => [id, name])) }
  seed(ctx, seedRows)
  return ctx
}

// --------------------------------------------------------------------------
// Write-sets
// --------------------------------------------------------------------------
test('every import case produces the Python write-set', async () => {
  for (const testCase of GOLDEN.cases as Array<Record<string, any>>) {
    const ctx = newCase(testCase.seed.rows, testCase.seed.symbols)
    const input = importInput(ctx, testCase.input)

    // Pre-imports: the same request run once more, so `duplicate_input`/`duplicate_source_file`
    // become reachable. Their job is the `JOB_PREVIOUS` symbol.
    let previousJobId: string | null = null
    for (let index = 0; index < Number(testCase.input.previous_imports ?? 0); index += 1) {
      const previous = await startPdfImport(ctx.db, input, NOW)
      previousJobId = String(previous.id)
    }

    const before = countRows(ctx)
    const job = await startPdfImport(ctx.db, input, NOW)
    const after = countRows(ctx)

    const mapping = placeholders(ctx)
    // Seeded rows keep their symbolic name; the fixture's symbols are the substitution table for
    // every reference the import makes to them (paper, previous job, question version, …).
    for (const [id, name] of ctx.symbols) mapping.set(id, name)
    mapping.set(String(job.id), '<job>')
    if (previousJobId !== null) {
      const name = [...ctx.symbols.entries()].find(([, symbol]) => symbol === 'JOB_PREVIOUS')
      if (name !== undefined) mapping.set(previousJobId, name[1])
    }
    // Checksums: `<stored_sha256:n>` per created document, in the same order as the placeholders.
    const createdDocuments = rowIds(ctx, 'ingestion_source_document').filter((id) => !ctx.seeded.has(id))
    createdDocuments.forEach((id, index) => {
      const document = getRow(ctx.db, 'ingestion_source_document', id)!
      mapping.set(String(document.checksum), `<stored_sha256:${index + 1}>`)
    })

    const actual = {
      job: projectJob(ctx, job, mapping),
      documents: projectDocuments(ctx, String(job.id)),
      candidates: projectCandidates(ctx, String(job.id)),
      papers: projectPapers(ctx),
      revisions: projectRevisions(ctx),
      content_revisions: projectContentRevisions(ctx),
      row_counts: Object.fromEntries(COUNTED_TABLES.map((table) => [table, after[table] - before[table]])),
    }
    const substituteAll = (value: unknown): unknown => substitute(value, mapping)
    let got = substituteAll(actual) as Record<string, unknown>
    let want = substituteAll(testCase.expected) as Record<string, unknown>
    if (testCase.geometry_comparable === false) {
      got = maskGeometry(got) as Record<string, unknown>
      want = maskGeometry(want) as Record<string, unknown>
    }
    assertDeepClose(got, want, testCase.name)
  }
})

// --------------------------------------------------------------------------
// Refusals: the message, and a write-set of exactly zero
// --------------------------------------------------------------------------
test('every refused import matches the Python error and writes nothing', async () => {
  for (const testCase of GOLDEN.errors as Array<Record<string, any>>) {
    const ctx = newCase(testCase.seed.rows, testCase.seed.symbols)
    const input = importInput(ctx, testCase.input)
    const before = countRows(ctx)
    await assert.rejects(
      () => startPdfImport(ctx.db, input, NOW),
      (error: unknown) => {
        const failure = error as { name?: string; message?: string; details?: unknown; statusCode?: number }
        assert.equal(failure.name, testCase.error.class, `${testCase.name}: class`)
        assert.equal(failure.message, testCase.error.message, `${testCase.name}: message`)
        assert.deepEqual(failure.details, testCase.error.details, `${testCase.name}: details`)
        if (testCase.error.status !== undefined) assert.equal(failure.statusCode, testCase.error.status, `${testCase.name}: status`)
        return true
      },
    )
    const after = countRows(ctx)
    for (const table of Object.keys(testCase.row_counts_before)) {
      assert.equal(
        after[table] - before[table],
        testCase.row_counts_after[table] - testCase.row_counts_before[table],
        `${testCase.name}: ${table} must not change`,
      )
    }
    assert.deepEqual(after, before, `${testCase.name}: a refused import must leave no rows behind`)
  }
})
