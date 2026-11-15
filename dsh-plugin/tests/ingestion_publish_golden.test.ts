/**
 * Replay of the Django-generated O18 publication write-set.
 *
 * `scripts/gen_ingestion_publish_golden.py` publishes real candidates with the real
 * `publish_candidate` against PostgreSQL and dumps (a) the starting rows, (b) the ordered publish
 * steps and (c) a semantic snapshot of everything the publication created. This test rebuilds the
 * same world in SQLite, runs the same steps through the port, and compares the snapshot field by
 * field.
 *
 * The snapshot deliberately carries no timestamps and no random identifiers: new rows are named by
 * the role they play (`Q_TARGET`, `V_TARGET`, `A_TARGET`, ...), so a divergence in *which* rows were
 * written, in their order or in their values fails here rather than in review.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Decimal } from '../src/domain/decimal.ts'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, getRow, insertRow, type Row } from '../src/store/repository.ts'
import { TABLES, type ColumnKind } from '../src/store/schema.generated.ts'
import { AcePassError, StructureInvalid } from '../src/services/errors.ts'
import { publishCandidate, type PublishCandidateOptions } from '../src/services/ingestion_publish.ts'
import { publishProblems } from '../src/services/questions.ts'

const NOW = parseInstant('2026-04-01T00:00:00+00:00')

interface PublishStep {
  candidate_id: string
  label: string
  options: {
    exam_spec_version_id?: string | null
    node_ids?: string[]
    origin_type?: string
    display_label?: string
  }
}

interface ExpectedError {
  ok: false
  error: {
    kind: 'acepass' | 'django_validation'
    class: string
    code?: string
    status: number
    message: string
    details?: Record<string, unknown>
    errors?: Record<string, unknown>
  }
  row_delta: Record<string, number>
}

interface PublishCase {
  name: string
  rows: Record<string, Array<Record<string, unknown>>>
  symbols: Record<string, string>
  steps: PublishStep[]
  target_candidate_id: string
  options: PublishStep['options']
  expected:
    | {
        ok: true
        snapshot: Record<string, unknown>
        row_delta: Record<string, number>
        parent?: Record<string, unknown>
        child_items?: Array<Record<string, unknown>>
      }
    | ExpectedError
}

interface ProblemCase {
  name: string
  rows: Record<string, Array<Record<string, unknown>>>
  symbols: Record<string, string>
  version_id: string
  expected: unknown[]
}

const golden = JSON.parse(
  readFileSync(new URL('./golden/ingestion_publish.json', import.meta.url), 'utf8'),
) as { publish: PublishCase[]; problems: ProblemCase[] }

/** Referenced rows before the rows that point at them. */
const TABLE_ORDER = [
  'accounts_user',
  'exams_project',
  'exams_subject',
  'exams_spec_version',
  'exams_syllabus_version',
  'knowledge_node',
  'exams_paper',
  'exams_paper_revision',
  'ingestion_source_document',
  'ingestion_import_job',
  'ingestion_import_candidate',
  'ingestion_source_region',
  'ingestion_import_candidate_source_regions',
  'question_bank_question',
  'question_bank_question_version',
  'question_bank_answer_key_version',
  'question_bank_rubric_version',
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
  for (const table of Object.keys(rows)) assert.ok(known.has(table), `fixture references unknown table ${table}`)
  for (const table of TABLE_ORDER) {
    const entries = rows[table]
    if (entries === undefined) continue
    const kinds = KINDS.get(table)!
    for (const entry of entries) {
      const values: Row = {}
      for (const [column, value] of Object.entries(entry)) {
        const kind = kinds.get(column)
        assert.ok(kind !== undefined, `fixture references unknown column ${table}.${column}`)
        values[column] = decodeFixtureValue(kind, value)
      }
      insertRow(db, table, values, { now: NOW })
    }
  }
}

const COUNTED_TABLES = [
  'question_bank_question',
  'question_bank_question_version',
  'question_bank_answer_key_version',
  'question_bank_rubric_version',
  'question_bank_source_link',
  'knowledge_question_mapping',
  'exams_paper_item',
  'audit_content_revision',
  'audit_outbox_event',
] as const

function counts(db: ReturnType<typeof openStore>['db']): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of COUNTED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
    out[table] = row.n
  }
  return out
}

function delta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of Object.keys(before)) if (after[key] !== before[key]) out[key] = after[key] - before[key]
  return out
}

/** Every row with its created_at ordering made explicit (`rowid` is insertion order in SQLite). */
function orderedRows(db: ReturnType<typeof openStore>['db'], sql: string, ...params: unknown[]): Row[] {
  return (db.prepare(sql).all(...(params as never[])) as Row[]).map((row) => ({ ...row }))
}

function labelOf(symbols: Map<string, string>, id: unknown): string {
  const symbol = symbols.get(String(id)) ?? ''
  return symbol.startsWith('CAND_') ? symbol.slice('CAND_'.length) : symbol
}

/** Name the rows a publication created after the role they play in the expected snapshot. */
function afterPublish(
  db: ReturnType<typeof openStore>['db'],
  candidate: Row,
  label: string,
  symbols: Map<string, string>,
): void {
  if (candidate.publication_question_id) symbols.set(String(candidate.publication_question_id), `Q_${label}`)
  if (candidate.publication_version_id) symbols.set(String(candidate.publication_version_id), `V_${label}`)
  if (candidate.publication_paper_item_id) {
    symbols.set(String(candidate.publication_paper_item_id), `ITEM_${label}`)
  }
  if (candidate.publication_version_id) {
    const answers = findRows(db, 'question_bank_answer_key_version', {
      question_version_id: candidate.publication_version_id,
    }).sort((a, b) => Number(b.version) - Number(a.version))
    const answer = answers[0]
    if (answer !== undefined) {
      symbols.set(String(answer.id), `A_${label}`)
      const rubric = findOne(db, 'question_bank_rubric_version', { answer_key_version_id: answer.id })
      if (rubric !== null) symbols.set(String(rubric.id), `R_${label}`)
    }
  }
  if (candidate.parent_candidate_id) {
    const parent = getRow(db, 'ingestion_import_candidate', candidate.parent_candidate_id)
    if (parent !== null) {
      const parentLabel = labelOf(symbols, parent.id)
      if (parent.publication_question_id) {
        symbols.set(String(parent.publication_question_id), `Q_${parentLabel}`)
      }
      if (parent.publication_version_id) symbols.set(String(parent.publication_version_id), `V_${parentLabel}`)
    }
  }
}

/** Replace every known identifier inside a value with its symbolic name (recursively). */
function symbolise(value: unknown, symbols: Map<string, string>): unknown {
  if (typeof value === 'string') return symbols.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => symbolise(item, symbols))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = symbolise(item, symbols)
    return out
  }
  return value
}

function sym(symbols: Map<string, string>, value: unknown): string | null {
  if (value === null || value === undefined) return null
  return symbols.get(String(value)) ?? `<unknown:${String(value).slice(0, 8)}>`
}

function snapshot(
  db: ReturnType<typeof openStore>['db'],
  candidate: Row,
  symbols: Map<string, string>,
): Record<string, unknown> {
  const question =
    candidate.publication_question_id === null
      ? null
      : getRow(db, 'question_bank_question', candidate.publication_question_id)
  const version =
    candidate.publication_version_id === null
      ? null
      : getRow(db, 'question_bank_question_version', candidate.publication_version_id)
  const answers =
    version === null
      ? []
      : findRows(db, 'question_bank_answer_key_version', { question_version_id: version.id }).sort(
          (a, b) => Number(b.version) - Number(a.version),
        )
  const answer = answers[0] ?? null
  const rubric =
    answer === null ? null : findOne(db, 'question_bank_rubric_version', { answer_key_version_id: answer.id })
  const links =
    version === null
      ? []
      : orderedRows(
          db,
          'SELECT * FROM "question_bank_source_link" WHERE "question_version_id" = ? ORDER BY "created_at" ASC, "rowid" ASC',
          version.id,
        )
  const mappings =
    version === null
      ? []
      : findRows(db, 'knowledge_question_mapping', { question_version_id: version.id })
          .map((row) => {
            const node = findOne(db, 'knowledge_node', { id: row.node_id })
            return { row, node }
          })
          .sort((left, right) => {
            const revision = Number(left.row.mapping_revision) - Number(right.row.mapping_revision)
            if (revision !== 0) return revision
            const a = String(left.node?.canonical_name ?? '')
            const b = String(right.node?.canonical_name ?? '')
            return a < b ? -1 : a > b ? 1 : 0
          })
          .map(({ row }) => ({
            mapping_revision: row.mapping_revision,
            node: sym(symbols, row.node_id),
            is_primary: Boolean(row.is_primary),
            score_weight: String(row.score_weight),
            note: row.note,
          }))
  const items =
    version === null
      ? []
      : findRows(db, 'exams_paper_item', { question_version_id: version.id })
          .sort((a, b) => String(a.position_key).localeCompare(String(b.position_key)))
          .map((item) => {
            const parent =
              item.parent_item_id === null ? null : getRow(db, 'exams_paper_item', item.parent_item_id)
            return {
              position_key: item.position_key,
              parent_position: parent === null ? null : parent.position_key,
              answer_key: sym(symbols, item.answer_key_version_id),
              max_score: String(item.max_score),
              is_scored: Boolean(item.is_scored),
              is_demo: Boolean(item.is_demo),
            }
          })
  const entityIds = [version?.id, answer?.id].filter((value) => value !== null && value !== undefined)
  const audit =
    entityIds.length === 0
      ? []
      : orderedRows(
          db,
          `SELECT * FROM "audit_content_revision" WHERE "entity_id" IN (${entityIds.map(() => '?').join(',')})
             ORDER BY "created_at" ASC, "rowid" ASC`,
          ...entityIds,
        ).map((row) => ({ entity_type: row.entity_type, action: row.action }))
  const paperId = db.prepare('SELECT "id" FROM "exams_paper" LIMIT 1').get() as { id: string } | undefined
  const outbox =
    paperId === undefined
      ? []
      : findRows(db, 'audit_outbox_event', {}).filter((event) => {
          const payload = event.payload as Record<string, unknown>
          return String(payload?.['paper_id'] ?? '') === String(paperId.id)
        }).map((event) => ({
          topic: event.topic,
          payload: event.payload,
          dedupe_key: event.dedupe_key,
          status_is_pending: event.processed_at === null,
        }))
  return {
    candidate: {
      status: candidate.status,
      revision: candidate.revision,
      publication_question_id: sym(symbols, candidate.publication_question_id),
      publication_version_id: sym(symbols, candidate.publication_version_id),
      publication_paper_item_id: sym(symbols, candidate.publication_paper_item_id),
      reviewed_at_is_null: candidate.reviewed_at === null,
    },
    question:
      question === null
        ? null
        : {
            origin_type: question.origin_type,
            is_demo: Boolean(question.is_demo),
            display_label: question.display_label,
            current_published_version: sym(symbols, question.current_published_version_id),
            family_id: sym(symbols, question.family_id),
            content_lineage_id: sym(symbols, question.content_lineage_id),
          },
    version:
      version === null
        ? null
        : {
            version: version.version,
            question_type: version.question_type,
            status: version.status,
            practice_max_score:
              version.practice_max_score === null ? null : String(version.practice_max_score),
            estimated_seconds: version.estimated_seconds,
            revision_reason: version.revision_reason,
            source_note: version.source_note,
            parent_material_version: sym(symbols, version.parent_material_version_id),
            material_child_version_ids: ((version.material_child_version_ids ?? []) as unknown[]).map((value) =>
              sym(symbols, value),
            ),
            content: version.content,
            content_digest: version.content_digest,
          },
    answer:
      answer === null
        ? null
        : {
            version: answer.version,
            answer_payload: answer.answer_payload,
            source_type: answer.source_type,
            verification_status: answer.verification_status,
            check_basis: answer.check_basis,
            checked_at_is_set: answer.checked_at !== null,
            checked_by_is_actor: answer.checked_by_id !== null,
            source_region: sym(symbols, answer.source_region_id),
            explanation_blocks: answer.explanation_blocks,
            supersedes: sym(symbols, answer.supersedes_id),
            is_disputed: Boolean(answer.is_disputed),
          },
    rubric:
      rubric === null
        ? null
        : {
            version: rubric.version,
            criteria: rubric.criteria,
            total_score: String(rubric.total_score),
            usage_note: rubric.usage_note,
            checked_at_is_set: rubric.checked_at !== null,
          },
    source_links: links.map((link) => ({
      role: link.role,
      region: sym(symbols, link.region_id),
      note: link.note,
    })),
    mappings,
    paper_items: items,
    audit,
    outbox,
  }
}

function resolveOptions(
  db: ReturnType<typeof openStore>['db'],
  options: PublishStep['options'],
): PublishCandidateOptions {
  const specId = options.exam_spec_version_id ?? null
  return {
    examSpecVersion: specId === null ? null : findOne(db, 'exams_spec_version', { id: specId }),
    nodeIds: options.node_ids ?? [],
    originType: options.origin_type ?? 'user_authored',
    displayLabel: options.display_label ?? '',
  }
}

function publishAll(
  db: ReturnType<typeof openStore>['db'],
  fixture: PublishCase,
): { symbols: Map<string, string>; deltas: Array<Record<string, number>> } {
  const symbols = new Map<string, string>(Object.entries(fixture.symbols))
  const candidate = getRow(db, 'ingestion_import_candidate', fixture.target_candidate_id)
  assert.ok(candidate !== null)
  // The acting user is the job's creator, exactly as the API scopes the candidate.
  const job = getRow(db, 'ingestion_import_job', candidate.job_id)
  assert.ok(job !== null)
  const projectId = String(job.project_id)
  const actorId = String(job.created_by_id)
  const deltas: Array<Record<string, number>> = []
  for (const step of fixture.steps) {
    const before = counts(db)
    const result = publishCandidate(db, actorId, projectId, step.candidate_id, resolveOptions(db, step.options), NOW)
    afterPublish(db, result.candidate, step.label, symbols)
    deltas.push(delta(before, counts(db)))
  }
  return { symbols, deltas }
}

for (const fixture of golden.publish) {
  test(`ingestion publish golden: ${fixture.name}`, () => {
    const handle = openStore({ path: ':memory:' })
    try {
      loadCase(handle.db, fixture.rows)
      if (fixture.expected.ok) {
        const { symbols, deltas } = publishAll(handle.db, fixture)
        const candidate = getRow(handle.db, 'ingestion_import_candidate', fixture.target_candidate_id)!
        const expected = fixture.expected
        assert.deepEqual(snapshot(handle.db, candidate, symbols), expected.snapshot)
        assert.deepEqual(deltas[deltas.length - 1] ?? {}, expected.row_delta)
        if (expected.parent !== undefined) {
          const parentId = candidate.parent_candidate_id
          const parent = getRow(handle.db, 'ingestion_import_candidate', parentId!)!
          const parentVersion = getRow(handle.db, 'question_bank_question_version', parent.publication_version_id!)!
          assert.deepEqual(
            {
              status: parent.status,
              publication_question_id: symbols.get(String(parent.publication_question_id)) ?? null,
              publication_version_id: symbols.get(String(parent.publication_version_id)) ?? null,
              version_status: parentVersion.status,
              version_type: parentVersion.question_type,
              version_reason: parentVersion.revision_reason,
              practice_max_score:
                parentVersion.practice_max_score === null ? null : String(parentVersion.practice_max_score),
              children: (parentVersion.material_child_version_ids as unknown[]).map(
                (value) => symbols.get(String(value)) ?? String(value),
              ),
            },
            expected.parent,
          )
        }
        if (expected.child_items !== undefined) {
          const paperId = (handle.db.prepare('SELECT "id" FROM "exams_paper" LIMIT 1').get() as { id: string }).id
          const revision = findOne(handle.db, 'exams_paper_revision', { paper_id: paperId })!
          const items = findRows(handle.db, 'exams_paper_item', { revision_id: revision.id })
            .sort((a, b) => String(a.position_key).localeCompare(String(b.position_key)))
            .map((item) => {
              const parent = item.parent_item_id === null ? null : getRow(handle.db, 'exams_paper_item', item.parent_item_id)
              return {
                position_key: item.position_key,
                parent_position: parent === null ? null : parent.position_key,
                is_scored: Boolean(item.is_scored),
              }
            })
          assert.deepEqual(items, expected.child_items)
        }
      } else {
        const expected = fixture.expected
        const candidate = getRow(handle.db, 'ingestion_import_candidate', fixture.target_candidate_id)!
        const job = getRow(handle.db, 'ingestion_import_job', candidate.job_id)!
        // Some refusals only exist after a setup publication (e.g. the same paper position is
        // already published); those steps are recorded in the fixture and replayed first.
        const symbols = new Map<string, string>(Object.entries(fixture.symbols))
        for (const step of fixture.steps) {
          const result = publishCandidate(
            handle.db,
            String(job.created_by_id),
            String(job.project_id),
            step.candidate_id,
            resolveOptions(handle.db, step.options),
            NOW,
          )
          afterPublish(handle.db, result.candidate, step.label, symbols)
        }
        const options = fixture.options
        const beforeAttempt = counts(handle.db)
        let thrown: unknown = null
        try {
          publishCandidate(
            handle.db,
            String(job.created_by_id),
            String(job.project_id),
            fixture.target_candidate_id,
            resolveOptions(handle.db, options),
            NOW,
          )
        } catch (error) {
          thrown = error
        }
        assert.ok(thrown !== null, 'the publication must be refused')
        if (expected.error.kind === 'acepass') {
          assert.ok(thrown instanceof AcePassError, `expected AcePassError, got ${String(thrown)}`)
          assert.equal(thrown.code, expected.error.code)
          assert.equal(thrown.statusCode, expected.error.status)
          assert.equal(thrown.message, expected.error.message)
          assert.deepEqual(
            symbolise(thrown.details, symbols),
            symbolise(expected.error.details ?? {}, symbols),
          )
        } else {
          assert.ok(thrown instanceof StructureInvalid)
          assert.equal(thrown.message, '结构校验失败')
          assert.deepEqual((thrown.details as Record<string, unknown>)['errors'], expected.error.errors)
        }
        assert.deepEqual(delta(beforeAttempt, counts(handle.db)), expected.row_delta)
      }
    } finally {
      handle.close()
    }
  })
}

for (const fixture of golden.problems) {
  test(`ingestion publish problems: ${fixture.name}`, () => {
    const handle = openStore({ path: ':memory:' })
    try {
      loadCase(handle.db, fixture.rows)
      const version = getRow(handle.db, 'question_bank_question_version', fixture.version_id)
      assert.ok(version !== null)
      assert.deepEqual(publishProblems(handle.db, version), fixture.expected)
    } finally {
      handle.close()
    }
  })
}

test('ingestion publish golden: 三个考点等分权重是 Decimal 语义', () => {
  // Pinned separately from the fixture so a change in Decimal precision is visible by name.
  const weight = Decimal.parse('1').div(Decimal.fromInt(3))
  const total = weight.add(weight).add(weight)
  assert.equal(weight.toString(), '0.3333333333333333333333333333')
  assert.equal(total.toString(), '0.9999999999999999999999999999')
  assert.equal(total.eq(Decimal.parse('1')), false)
})
