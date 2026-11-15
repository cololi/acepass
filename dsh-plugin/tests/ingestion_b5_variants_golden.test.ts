/**
 * Golden replay for ingestion B5: variant rules, independent checks, review issues, serializers.
 *
 * `scripts/gen_ingestion_b5_variants_golden.py` seeds real PostgreSQL rows, calls the real Python
 * functions and freezes the results. This file seeds the identical rows into SQLite and replays the
 * same calls; a mismatch is a port defect, not a stale expectation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { getRow, insertRow } from '../src/store/repository.ts'
import { TABLES, type ColumnKind } from '../src/store/schema.generated.ts'
import {
  answerConsistencyProblems,
  proposedScore,
  variantDraftPayload,
} from '../src/domain/ingestion/variants.ts'
import {
  answerContext,
  independentChecks,
  variantJobSummary,
  variantReviewIssues,
} from '../src/services/variants.ts'

const GOLDEN = JSON.parse(readFileSync(new URL('./golden/ingestion_b5_variants.json', import.meta.url), 'utf8'))
const NOW = parseInstant(GOLDEN.now)

interface GoldenCase {
  name: string
  rows?: Record<string, Array<Record<string, unknown>>>
  expected: unknown
}

const KIND_BY_TABLE = new Map(
  TABLES.map((table) => [table.name, new Map(table.columns.map((column) => [column.name, column.kind as ColumnKind]))]),
)

/** Golden rows carry ISO timestamps; the repository expects an `Instant` (microseconds). */
function decodeFixtureValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (kind === 'datetime') return parseInstant(String(value))
  return value
}

/** Insertion order: referenced rows before the rows that point at them. */
const TABLE_ORDER = [
  'accounts_user',
  'exams_project',
  'exams_subject',
  'exams_syllabus_version',
  'knowledge_node',
  'question_bank_family',
  'question_bank_question',
  'question_bank_question_version',
  'question_bank_answer_key_version',
  'question_bank_rubric_version',
  'ingestion_import_job',
  'ingestion_import_candidate',
]

function seed(rows: Record<string, Array<Record<string, unknown>>> | undefined, now = NOW): ReturnType<typeof openStore> {
  const handle = openStore({ path: ':memory:' })
  for (const table of TABLE_ORDER) {
    const entries = rows?.[table]
    if (entries === undefined) continue
    const kinds = KIND_BY_TABLE.get(table)
    assert.ok(kinds, `fixture references unknown table ${table}`)
    for (const row of entries) {
      const values: Record<string, unknown> = {}
      for (const [column, value] of Object.entries(row)) {
        const kind = kinds!.get(column)
        assert.ok(kind !== undefined, `fixture references unknown column ${table}.${column}`)
        values[column] = decodeFixtureValue(kind!, value)
      }
      insertRow(handle.db, table, values, { now })
    }
  }
  const unknown = Object.keys(rows ?? {}).filter((table) => !TABLE_ORDER.includes(table))
  assert.deepEqual(unknown, [], 'fixture has tables the replay order does not cover')
  return handle
}

/* --------------------------------------------------- pure rules */

test('b5 golden: answer consistency problems match the Python rule (`:165`)', () => {
  for (const entry of GOLDEN.answer_consistency as Array<{ name: string; input: Record<string, unknown>; expected: unknown }>) {
    const actual = answerConsistencyProblems({
      content: entry.input['content'] as Record<string, unknown>,
      answerPayload: entry.input['answer_payload'] as Record<string, unknown>,
      questionType: String(entry.input['question_type']),
      rubricCriteria: entry.input['rubric_criteria'],
      statedRubricTotal: entry.input['stated_rubric_total'],
    })
    assert.deepEqual(actual, entry.expected, entry.name)
  }
})

test('b5 golden: proposed score matches the Python rule (`:539`)', () => {
  for (const entry of GOLDEN.proposed_score as Array<{ name: string; input: Record<string, unknown>; expected: unknown }>) {
    const actual = proposedScore({
      clean: entry.input['clean'] as Record<string, unknown>,
      questionType: String(entry.input['question_type']),
      content: entry.input['content'] as Record<string, unknown>,
      answerPayload: entry.input['answer_payload'] as Record<string, unknown>,
    })
    assert.equal(actual, entry.expected, entry.name)
  }
})

test('b5 golden: the draft payload matches `_draft_payload` (`:580`)', () => {
  for (const entry of GOLDEN.draft_payload as Array<{
    name: string
    input: {
      clean: Record<string, unknown>
      source: { question_id: string; question_type: string; display_label: string; version_id: string }
      node_id: string | null
      content_digest: string
      run_id: string
    }
    expected: unknown
  }>) {
    const actual = variantDraftPayload({
      clean: entry.input.clean,
      sourceVersion: {
        questionId: entry.input.source.question_id,
        questionType: entry.input.source.question_type,
        displayLabel: entry.input.source.display_label,
        versionId: entry.input.source.version_id,
      },
      nodeId: entry.input.node_id,
      digest: entry.input.content_digest,
      runId: entry.input.run_id,
    })
    assert.deepEqual(actual, entry.expected, entry.name)
  }
})

/* --------------------------------------------------- DB-backed rules */

test('b5 golden: the fill-blank prompt context uses Python list repr, not a join (`:118`)', () => {
  const { summary, criteria } = answerContext(
    {
      answer: {
        verification_status: 'checked',
        answer_payload: {
          kind: 'fill_blank',
          blanks: { b1: { accepted_values: ['甲', '乙'] }, b2: { accepted_values: [], numeric: '3' } },
        },
      },
      rubric: null,
    },
    'fill_blank',
  )
  assert.equal(summary, "各空答案：b1=['甲', '乙']；b2=3")
  assert.deepEqual(criteria, [])
  assert.equal(
    answerContext(
      {
        answer: { verification_status: 'pending', answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' } },
        rubric: { criteria: [{ criterion_id: 'c1', text: '步骤', max_score: '2.00' }] },
      },
      'single_choice',
    ).summary,
    '正确选项 ID：opt_a（该答案尚未人工核对：仅供参考，不得当作标准答案）',
  )
})

test('b5 golden: independent checks match the real function (`:397`)', () => {
  for (const entry of GOLDEN.checks as Array<{
    name: string
    rows: Record<string, Array<Record<string, unknown>>>
    source_version_id: string
    node_id: string | null
    project_id: string
    payload: Record<string, unknown>
    exclude_candidate_id: string | null
    expected: unknown
  }>) {
    const store = seed(entry.rows)
    try {
      const actual = independentChecks(store.db, {
        payload: entry.payload,
        sourceVersion: requireRow(store.db, 'question_bank_question_version', entry.source_version_id),
        node: entry.node_id === null ? null : requireRow(store.db, 'knowledge_node', entry.node_id),
        projectId: entry.project_id,
        excludeCandidateId: entry.exclude_candidate_id,
      })
      assert.deepEqual(actual, entry.expected, entry.name)
    } finally {
      store.close()
    }
  }
})

test('b5 golden: review issues are recomputed from the stored payload (`:482`)', () => {
  for (const entry of GOLDEN.review as Array<{
    name: string
    rows: Record<string, Array<Record<string, unknown>>>
    candidate_id: string
    expected: unknown
  }>) {
    const store = seed(entry.rows)
    try {
      const candidate = requireRow(store.db, 'ingestion_import_candidate', entry.candidate_id)
      assert.deepEqual(variantReviewIssues(store.db, candidate), entry.expected, entry.name)
    } finally {
      store.close()
    }
  }
})

test('b5 golden: the variant job summary matches the Python serializer (`:673`)', () => {
  for (const entry of GOLDEN.summaries as Array<{
    name: string
    rows: Record<string, Array<Record<string, unknown>>>
    job_id: string
    expected: unknown
  }>) {
    const store = seed(entry.rows)
    try {
      const job = requireRow(store.db, 'ingestion_import_job', entry.job_id)
      assert.deepEqual(variantJobSummary(store.db, job), entry.expected, entry.name)
    } finally {
      store.close()
    }
  }
})

function requireRow(
  db: ReturnType<typeof openStore>['db'],
  table: string,
  id: string,
): Record<string, unknown> {
  const row = getRow(db, table, id)
  assert.ok(row, `${table} ${id} was not seeded`)
  return row
}
