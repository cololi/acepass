/**
 * Golden replay for analytics B6.
 *
 * `scripts/gen_analytics_b6_golden.py` seeds real PostgreSQL rows, calls the real analytics
 * services with a frozen clock and freezes every number. This file seeds the identical rows into
 * SQLite (fixture ids are already stable symbols such as `question_q14`) and replays the same calls;
 * a mismatch is a port defect, not a stale expectation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseInstant, formatPythonIso, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES, type ColumnKind } from '../src/store/schema.generated.ts'
import {
  buildPracticeReport,
  coverageCompletion,
  paperCoverage,
} from '../src/services/analytics.ts'
import { cycleAnalysis } from '../src/services/cycles.ts'
import { buildEffectCalibration } from '../src/services/calibration.ts'
import {
  executeRegradeRun,
  pendingAnswerReviews,
  regradePayload,
  requestRegrade,
} from '../src/services/regrade_runs.ts'

const GOLDEN = JSON.parse(readFileSync(new URL('./golden/analytics_b6.json', import.meta.url), 'utf8'))
const NOW = parseInstant(GOLDEN.now)
const SYMBOLS = GOLDEN.symbols as Record<string, string>
const ID_TO_SYMBOL = new Map(Object.entries(SYMBOLS).map(([symbol, id]) => [id, symbol]))
const ID = (symbol: string): string => {
  const id = SYMBOLS[symbol]
  assert.ok(id !== undefined, `fixture is missing symbol ${symbol}`)
  return id
}
const USER = ID('user_owner')
const PROJECT = ID('project_main')

const KIND_BY_TABLE = new Map(
  TABLES.map((table) => [table.name, new Map(table.columns.map((column) => [column.name, column.kind as ColumnKind]))]),
)

/**
 * Insertion order: referenced rows before the rows that point at them.
 *
 * Two references point *forward* (paper → effective revision, attempt → current grade); they are
 * cleared while seeding and written back afterwards, because SQLite enforces the foreign keys the
 * generated schema declares.
 */
const TABLE_ORDER = [
  'accounts_user',
  'exams_project',
  'exams_subject',
  'exams_syllabus_version',
  'knowledge_node',
  'exams_spec_version',
  'question_bank_question',
  'question_bank_question_version',
  'question_bank_answer_key_version',
  'question_bank_rubric_version',
  'knowledge_question_mapping',
  'practice_session',
  'practice_session_item',
  'practice_attempt',
  'practice_grade_event',
  'practice_learning_evidence',
  'exams_paper',
  'exams_paper_revision',
  'exams_paper_item',
  'analytics_report_snapshot',
  'analytics_regrade_run',
]

const FORWARD_REFERENCES: Record<string, Record<string, string | null>> = {
  exams_paper: { effective_revision_id: null },
  practice_attempt: { current_grade_event_id: null },
}

function decodeFixtureValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (kind === 'datetime') return parseInstant(String(value))
  return value
}

function seed(): ReturnType<typeof openStore> {
  const handle = openStore({ path: ':memory:' })
  const tables = GOLDEN.tables as Record<string, Array<Record<string, unknown>>>
  for (const table of TABLE_ORDER) {
    const entries = tables[table]
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
      Object.assign(values, FORWARD_REFERENCES[table] ?? {})
      insertRow(handle.db, table, values, { now: NOW })
    }
  }
  const unknown = Object.keys(tables).filter((table) => !TABLE_ORDER.includes(table))
  assert.deepEqual(unknown, [], 'fixture has tables the replay order does not cover')
  for (const [table, patch] of Object.entries(FORWARD_REFERENCES)) {
    for (const row of tables[table] ?? []) {
      const wanted = row
      for (const column of Object.keys(patch)) {
        if (wanted[column] !== null && wanted[column] !== undefined) {
          updateRow(handle.db, table, String(row.id), { [column]: wanted[column] }, { now: NOW })
        }
      }
    }
  }
  return handle
}

function rowId(row: Record<string, unknown>): string {
  return String(row.id)
}

test('b6 golden: practice report, snapshot write set and query variants', () => {
  const handle = seed()
  const db = handle.db
  try {
    const report = buildPracticeReport(db, USER, PROJECT, { subjectId: null, saveSnapshot: true, now: NOW })
    assert.deepEqual(report, GOLDEN.practice_report.expected)

    const snapshots = findRows(db, 'analytics_report_snapshot', {})
    assert.equal(snapshots.length, GOLDEN.practice_report.snapshot_count)
    const stored: Record<string, unknown> = { ...snapshots[0], id: '<snapshot:1>' }
    assert.equal(formatPythonIso(stored.created_at as Instant), GOLDEN.practice_report.snapshot.created_at)
    stored.created_at = formatPythonIso(stored.created_at as Instant)
    stored.updated_at = formatPythonIso(stored.updated_at as Instant)
    stored.as_of = formatPythonIso(stored.as_of as Instant)
    assert.deepEqual(stored, GOLDEN.practice_report.snapshot)

    // `save_snapshot=false` is the same report with no write.
    const withoutSnapshot = buildPracticeReport(db, USER, PROJECT, { subjectId: null, saveSnapshot: false, now: NOW })
    assert.deepEqual(withoutSnapshot, GOLDEN.practice_report_no_snapshot)
    assert.equal(findRows(db, 'analytics_report_snapshot', {}).length, GOLDEN.practice_report.snapshot_count)

    assert.deepEqual(
      buildPracticeReport(db, USER, PROJECT, { subjectId: ID('subject_math'), saveSnapshot: false, now: NOW }),
      GOLDEN.practice_report_subject,
    )
    assert.deepEqual(
      buildPracticeReport(db, USER, PROJECT, { subjectId: ID('subject_physics'), saveSnapshot: false, now: NOW }),
      GOLDEN.practice_report_other_subject,
    )
  } finally {
    handle.close()
  }
})

test('b6 golden: coverage and cycle analysis match the Python report', () => {
  const handle = seed()
  const db = handle.db
  try {
    const papers = paperCoverage(db, ID('subject_math'))
    assert.deepEqual(papers, GOLDEN.coverage.papers)
    assert.deepEqual(coverageCompletion(db, ID('subject_math'), papers), GOLDEN.coverage.completion)
    assert.deepEqual(cycleAnalysis(db, ID('subject_math'), { maxCycles: 5 }), GOLDEN.cycle_analysis.max_cycles_5)
    assert.deepEqual(cycleAnalysis(db, ID('subject_math'), { maxCycles: 1 }), GOLDEN.cycle_analysis.max_cycles_1)
  } finally {
    handle.close()
  }
})

test('b6 golden: effect calibration matches the Python groups and caveats', () => {
  const handle = seed()
  const db = handle.db
  try {
    assert.deepEqual(
      buildEffectCalibration(db, USER, PROJECT, { subjectId: null, now: NOW }),
      GOLDEN.calibration.project,
    )
    assert.deepEqual(
      buildEffectCalibration(db, USER, PROJECT, { subjectId: ID('subject_physics'), now: NOW }),
      GOLDEN.calibration.other_subject,
    )
  } finally {
    handle.close()
  }
})

test('b6 golden: answer-review queue projection', () => {
  const handle = seed()
  const db = handle.db
  try {
    assert.deepEqual(pendingAnswerReviews(db, PROJECT), GOLDEN.answer_reviews)
  } finally {
    handle.close()
  }
})

/* ------------------------------------------------------------ regrades */
interface NormalizedCase {
  run: Record<string, unknown>
  expected_payload: Record<string, unknown>
  grades: Array<Record<string, unknown>>
  attempts: Record<string, Record<string, unknown>>
  evidence: Record<string, Record<string, unknown>>
  states: Record<string, Record<string, unknown>>
  grade_id_delta?: number
}

function normalizeRun(db: ReturnType<typeof seed>['db'], runId: string): Record<string, unknown> {
  const run = findRows(db, 'analytics_regrade_run', { id: runId })[0]
  assert.ok(run)
  return {
    status: run.status,
    scope: run.scope,
    generation: run.generation,
    affected_attempts: run.affected_attempts,
    regraded_attempts: run.regraded_attempts,
    stale_skipped_attempts: run.stale_skipped_attempts,
    invalidated_evidence: run.invalidated_evidence,
    error_message: run.error_message,
    reason: run.reason,
    started: run.started_at !== null && run.started_at !== undefined,
    finished: run.finished_at !== null && run.finished_at !== undefined,
  }
}

function normalizeCase(
  db: ReturnType<typeof seed>['db'],
  runId: string,
  options: { involved: string[]; beforeGradeIds: Set<string>; beforeGradeCount: number },
): NormalizedCase {
  const run = findRows(db, 'analytics_regrade_run', { id: runId })[0]
  assert.ok(run)
  const payload = regradePayload(run) as Record<string, unknown>
  payload.regrade_run_id = '<run>'
  const grades: Array<Record<string, unknown>> = []
  for (const grade of findRows(db, 'practice_grade_event', {})) {
    if (options.beforeGradeIds.has(String(grade.id))) continue
    const involvedIds = new Set(options.involved.map((name) => ID(`attempt_${name}`)))
    if (!involvedIds.has(String(grade.attempt_id))) continue
    grades.push({
      attempt: ID_TO_SYMBOL.get(String(grade.attempt_id)) ?? String(grade.attempt_id),
      kind: grade.kind,
      status: grade.status,
      method: grade.method,
      confirmed_score:
        grade.confirmed_score === null || grade.confirmed_score === undefined
          ? null
          : String(grade.confirmed_score),
      pending_max_score: String(grade.pending_max_score),
      is_fully_confirmed: grade.is_fully_confirmed,
      grading_revision: grade.grading_revision,
      answer_key_version: grade.answer_key_version_id === null ? null : String(grade.answer_key_version_id),
      rubric_version: grade.rubric_version_id === null ? null : String(grade.rubric_version_id),
      comment: grade.comment,
      invalidation_reason: grade.invalidation_reason,
      superseded: grade.is_superseded,
      rule_generation: (grade.rule_snapshot as Record<string, unknown> | null)?.regrade_generation ?? null,
    })
  }
  grades.sort((left, right) =>
    String(left.attempt) < String(right.attempt) ? -1 : String(left.attempt) > String(right.attempt) ? 1 : 0,
  )
  const attempts: Record<string, Record<string, unknown>> = {}
  for (const name of options.involved) {
    const attempt = findRows(db, 'practice_attempt', { id: ID(`attempt_${name}`) })[0]
    assert.ok(attempt, `missing attempt ${name}`)
    const current =
      attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined
        ? null
        : findRows(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })[0]
    attempts[name] = {
      applied_regrade_generation: attempt.applied_regrade_generation,
      grading_revision: attempt.grading_revision,
      current_kind: current === null ? null : current.kind,
      current_status: current === null ? null : current.status,
      current_grade: current === null ? null : (ID_TO_SYMBOL.get(String(current.id)) ?? 'new'),
    }
  }
  const evidence: Record<string, Record<string, unknown>> = {}
  for (const name of options.involved) {
    const rows = findRows(db, 'practice_learning_evidence', { attempt_id: ID(`attempt_${name}`) })
    evidence[name] = {
      active: rows.filter((row) => row.is_active === true).length,
      total: rows.length,
      reasons: [...new Set(rows.filter((row) => row.is_active !== true).map((row) => String(row.invalidated_reason)))].sort(),
    }
  }
  const states: Record<string, Record<string, unknown>> = {}
  for (const state of findRows(db, 'learning_knowledge_state', { user_id: USER, project_id: PROJECT })) {
    states[String(state.node_id)] = {
      summary: state.summary,
      best_summary: state.best_summary,
      independent_correct_count: state.independent_correct_count,
      distinct_question_count: state.distinct_question_count,
      recent_independent_attempts: state.recent_independent_attempts,
      recent_independent_failures: state.recent_independent_failures,
      needs_review: state.needs_review,
    }
  }
  return {
    run: normalizeRun(db, runId),
    expected_payload: payload,
    grades,
    attempts,
    evidence,
    states,
    grade_id_delta: findRows(db, 'practice_grade_event', {}).length - options.beforeGradeCount,
  }
}

function gradeSnapshot(db: ReturnType<typeof seed>['db']): { ids: Set<string>; count: number } {
  const rows = findRows(db, 'practice_grade_event', {})
  return { ids: new Set(rows.map((row) => String(row.id))), count: rows.length }
}

test('b6 golden: regrade execution, idempotent counters and generation ordering', () => {
  const handle = seed()
  const db = handle.db
  try {
    // 1. Successful run: two attempts re-graded, one already settled by a newer generation.
    let before = gradeSnapshot(db)
    const successRun = requestRegrade(db, {
      questionId: ID('question_q14'),
      targetAnswerKeyVersionId: ID('answer_q14'),
      targetRubricVersionId: null,
      actorId: USER,
      reason: '答案勘误后重判',
      now: NOW,
    })
    const successQueued = normalizeCase(db, rowId(successRun), {
      involved: ['r14a', 'r14b', 'r14settled'],
      beforeGradeIds: before.ids,
      beforeGradeCount: before.count,
    })
    assert.deepEqual(successQueued, expectedCase('success'))
    executeRegradeRun(db, rowId(successRun), NOW)
    const successExecuted = normalizeCase(db, rowId(successRun), {
      involved: ['r14a', 'r14b', 'r14settled'],
      beforeGradeIds: before.ids,
      beforeGradeCount: before.count,
    })
    assert.deepEqual(successExecuted.run, gcase('success')['executed_run'])
    assert.equal(successExecuted.grades.filter((row) => row.kind === 'regrade').length, 2)

    // 2. Content-version branch: evidence invalidated, no grade written.
    before = gradeSnapshot(db)
    const contentRun = requestRegrade(db, {
      questionId: ID('question_q18'),
      targetAnswerKeyVersionId: ID('answer_q18'),
      targetRubricVersionId: null,
      actorId: USER,
      reason: '内容已改版，证据失效',
      now: NOW,
    })
    executeRegradeRun(db, rowId(contentRun), NOW)
    assert.deepEqual(
      normalizeCase(db, rowId(contentRun), {
        involved: ['r_content'],
        beforeGradeIds: before.ids,
        beforeGradeCount: before.count,
      }),
      expectedCase('content_change'),
    )

    // 3. Old generation after new: the older run writes nothing.
    before = gradeSnapshot(db)
    const oldRun = requestRegrade(db, {
      questionId: ID('question_q15'),
      targetAnswerKeyVersionId: ID('answer_q15'),
      targetRubricVersionId: null,
      actorId: USER,
      reason: '旧代次请求',
      now: NOW,
    })
    const newRun = requestRegrade(db, {
      questionId: ID('question_q15'),
      targetAnswerKeyVersionId: ID('answer_q15'),
      targetRubricVersionId: null,
      actorId: USER,
      reason: '新代次请求',
      now: NOW,
    })
    executeRegradeRun(db, rowId(newRun), NOW)
    executeRegradeRun(db, rowId(oldRun), NOW)
    const oldCase = normalizeCase(db, rowId(oldRun), {
      involved: ['r15a'],
      beforeGradeIds: before.ids,
      beforeGradeCount: before.count,
    })
    assert.deepEqual(oldCase, expectedCase('old_generation_after_new'))
    assert.equal(oldCase.run['regraded_attempts'], 0)
    assert.equal(oldCase.run['stale_skipped_attempts'], 1)

    // 4. Target disputed between request and execution: refuse, never confirm a score.
    before = gradeSnapshot(db)
    const disputeRun = requestRegrade(db, {
      questionId: ID('question_q14'),
      targetAnswerKeyVersionId: ID('answer_q14'),
      targetRubricVersionId: null,
      actorId: USER,
      reason: '目标随后进入争议',
      now: NOW,
    })
    updateRow(
      db,
      'question_bank_answer_key_version',
      ID('answer_q14'),
      { is_disputed: true, dispute_reason: '执行前发生争议' },
      { now: NOW },
    )
    executeRegradeRun(db, rowId(disputeRun), NOW)
    const refused = normalizeCase(db, rowId(disputeRun), {
      involved: ['r14a', 'r14b', 'r14settled'],
      beforeGradeIds: before.ids,
      beforeGradeCount: before.count,
    })
    assert.deepEqual(refused, expectedCase('refused_untrusted_target'))
  } finally {
    handle.close()
  }
})

function gcase(name: string): Record<string, any> {
  return (GOLDEN.regrades as Record<string, Record<string, any>>)[name]
}

/** The fixture also carries the case name and (for the success case) the executed run. */
function expectedCase(name: string): Record<string, any> {
  const { name: _name, executed_run: _executed, newer_run: _newer, ...rest } = gcase(name)
  return rest
}
