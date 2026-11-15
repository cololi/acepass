/**
 * Replay of the Django-generated proofreading golden vectors.
 *
 * `scripts/gen_ingestion_review_golden.py` builds real rows in PostgreSQL, calls the real
 * `refresh_candidate_issues` / `job_summary` / `candidate_summary`, and dumps both the rows and the
 * observed output. This test inserts the same rows into SQLite and asserts the port returns the
 * same issues, the same status transition and the same serializers — so a divergence in issue order,
 * a missed duplicate check or a wrong timestamp shape fails here instead of in review.
 *
 * The fixture is loaded with foreign keys off: every referenced row is present (it comes from
 * Django's own constraint-checked database), and the point of this file is the logic replay, not a
 * second FK test. The HTTP tests exercise real writes with foreign keys on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { getRow, insertRow } from '../src/store/repository.ts'
import { TABLES, type ColumnKind } from '../src/store/schema.generated.ts'
import { candidateSummary, jobSummary, refreshCandidateIssues } from '../src/services/ingestion.ts'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const golden = JSON.parse(
  readFileSync(new URL('./golden/ingestion_review.json', import.meta.url), 'utf8'),
) as {
  cases: Array<{
    name: string
    refresh: boolean
    rows: Record<string, Array<Record<string, unknown>>>
    target_candidate_id: string
    expected: {
      issues: unknown[] | null
      status: string | null
      job_summary: Record<string, unknown> | null
      candidate_summary: Record<string, unknown> | null
    }
  }>
}

/** Insertion order: referenced rows before the rows that point at them. */
const TABLE_ORDER = [
  'accounts_user',
  'exams_project',
  'exams_subject',
  'ingestion_source_document',
  'ingestion_import_job',
  'ingestion_source_region',
  'ingestion_import_candidate',
  'ingestion_import_job_documents',
  'ingestion_import_candidate_source_regions',
  'question_bank_question',
  'question_bank_question_version',
  'exams_paper',
  'exams_paper_revision',
  'exams_paper_item',
]

const KINDS: ReadonlyMap<string, Map<string, ColumnKind>> = new Map(
  TABLES.map((table) => [table.name, new Map(table.columns.map((column) => [column.name, column.kind]))]),
)

function decodeFixtureValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (kind === 'datetime') return parseInstant(String(value))
  return value
}

function loadCase(db: ReturnType<typeof openStore>['db'], rows: Record<string, Array<Record<string, unknown>>>): void {
  db.exec('PRAGMA foreign_keys = OFF')
  const known = new Set(TABLES.map((table) => table.name))
  for (const table of Object.keys(rows)) {
    assert.ok(known.has(table), `fixture references unknown table ${table}`)
  }
  for (const table of TABLE_ORDER) {
    const entries = rows[table]
    if (entries === undefined) continue
    const kinds = KINDS.get(table)!
    for (const entry of entries) {
      const values: Record<string, unknown> = {}
      for (const [column, value] of Object.entries(entry)) {
        const kind = kinds.get(column)
        assert.ok(kind !== undefined, `fixture references unknown column ${table}.${column}`)
        values[column] = decodeFixtureValue(kind, value)
      }
      insertRow(db, table, values, { now: NOW })
    }
  }
}

for (const fixture of golden.cases) {
  test(`ingestion review golden: ${fixture.name}`, () => {
    const handle = openStore({ path: ':memory:' })
    try {
      loadCase(handle.db, fixture.rows)
      const candidate = getRow(handle.db, 'ingestion_import_candidate', fixture.target_candidate_id)
      assert.ok(candidate !== null, 'the target candidate must exist in the fixture')
      if (fixture.refresh) {
        const issues = refreshCandidateIssues(handle.db, candidate, NOW)
        assert.deepEqual(issues, fixture.expected.issues)
        const after = getRow(handle.db, 'ingestion_import_candidate', fixture.target_candidate_id)!
        assert.equal(after.status, fixture.expected.status, 'the status transition after refresh')
      }
      if (fixture.expected.job_summary !== null) {
        const job = getRow(handle.db, 'ingestion_import_job', candidate.job_id)!
        // `job.documents.all()` has no ORDER BY in Django and the probe confirmed the physical
        // order is not the insertion order; the contract is the set of documents, not a sequence.
        const actual = jobSummary(handle.db, job) as Record<string, unknown>
        const expected = fixture.expected.job_summary as Record<string, unknown>
        assert.deepEqual(
          { ...actual, document_ids: [...(actual.document_ids as string[])].sort() },
          { ...expected, document_ids: [...(expected.document_ids as string[])].sort() },
        )
      }
      if (fixture.expected.candidate_summary !== null) {
        const current = getRow(handle.db, 'ingestion_import_candidate', fixture.target_candidate_id)!
        assert.deepEqual(candidateSummary(handle.db, current), fixture.expected.candidate_summary)
      }
    } finally {
      handle.close()
    }
  })
}
