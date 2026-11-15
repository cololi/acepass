/**
 * The nine analytics/regrade operations through the real HTTP surface (`Request`→`Response`).
 *
 * These tests pin the things the golden replay cannot see: status codes, the error envelope, query
 * parameter parsing, the idempotency claim/replay/conflict contract, scope 404s, and the closed
 * loop (publish → attempt → evidence → report → regrade → report).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { drain } from '../src/jobs/worker.ts'
import { rebuildEvidenceForAttempt } from '../src/services/evidence_rebuild.ts'

const NOW = parseInstant('2026-09-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'
const CONTENT = {
  blocks: [{ kind: 'text', text: '1+1 等于几？' }],
  options: [
    { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '1' }] },
    { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '2' }] },
  ],
}

function completeRow(table: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const row: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey || column.name in overrides) continue
    if (!column.notNull) continue
    const fk = foreignKeys.get(column.name)
    if (fk) {
      row[column.name] = `fk-${fk.refTable}`
      continue
    }
    row[column.name] = column.json ? {} : column.kind === 'datetime' ? NOW : column.kind === 'int' || column.kind === 'bool' ? 0 : ''
  }
  Object.assign(row, overrides)
  return row
}

interface Harness {
  db: ReturnType<typeof openStore>['db']
  userId: string
  otherUserId: string
  projectId: string
  otherProjectId: string
  subjectId: string
  questionId: string
  versionId: string
  answerA: string
  answerB: string
  itemId: string
  send: (request: Request) => Promise<Response>
}

function harness(): Harness {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const userId = String(
    insertRow(
      db,
      'accounts_user',
      completeRow('accounts_user', {
        email: 'owner@acepass.local',
        display_name: '本机用户',
        date_joined: NOW,
        password: '!',
      }),
      { now: NOW },
    ).id,
  )
  const otherUserId = String(
    insertRow(
      db,
      'accounts_user',
      completeRow('accounts_user', {
        email: 'other@acepass.local',
        display_name: '他人',
        date_joined: NOW,
        password: '!',
      }),
      { now: NOW },
    ).id,
  )
  const projectId = String(createProject(db, userId, { name: '分析项目' }, NOW).id)
  const otherProjectId = String(createProject(db, otherUserId, { name: '他人项目' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id)
  const question = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', {
      subject_id: subjectId,
      origin_type: 'import',
      is_demo: false,
      display_label: 'Q1',
    }),
    { now: NOW },
  )
  const questionId = String(question.id)
  const draft = createQuestionRevision(
    db,
    userId,
    projectId,
    questionId,
    { question_type: 'single_choice', content: CONTENT, practice_max_score: '2.00' },
    NOW,
  )
  const versionId = String(draft.id)
  const answerA = String(
    insertRow(
      db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: versionId,
        version: 1,
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
        check_basis: '教材',
      }),
      { now: NOW },
    ).id,
  )
  const answerB = String(
    insertRow(
      db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: versionId,
        version: 2,
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_b' },
        check_basis: '勘误',
      }),
      { now: NOW },
    ).id,
  )
  publishQuestionVersion(db, userId, projectId, versionId, { now: NOW })
  // A mapped knowledge node is what turns an attempt into mastery evidence; without it the
  // projection has nothing to attach a row to and the closed-loop assertion would be vacuous.
  const syllabus = insertRow(
    db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', {
      subject_id: subjectId,
      name: '数学大纲',
      version_label: 'v1',
      status: 'published',
      is_user_provisional: false,
    }),
    { now: NOW },
  )
  const node = insertRow(
    db,
    'knowledge_node',
    completeRow('knowledge_node', {
      syllabus_version_id: String(syllabus.id),
      canonical_name: '考点A',
      code: 'A',
      is_unclassified: false,
    }),
    { now: NOW },
  )
  insertRow(
    db,
    'knowledge_question_mapping',
    completeRow('knowledge_question_mapping', {
      question_version_id: versionId,
      mapping_revision: 1,
      node_id: String(node.id),
      is_primary: true,
      score_weight: '1.0000',
      note: '',
    }),
    { now: NOW },
  )
  const session = createSession(db, userId, projectId, { subject_id: subjectId, question_ids: [questionId], mode: 'practice' }, NOW)
  const items = findRows(db, 'practice_session_item', { session_id: String(session.id) })
  assert.equal(items.length, 1)
  const itemId = String(items[0].id)
  // Present one minute before the submit: the evidence projection needs a trustworthy elapsed
  // time (`elapsed_ms = 0` is reported as "缺少可信用时记录" and would make the mastery rows vacuous).
  presentItem(db, userId, itemId, NOW - 60_000_000n)
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId, now: NOW }),
  })
  return {
    db,
    userId,
    otherUserId,
    projectId,
    otherProjectId,
    subjectId,
    questionId,
    versionId,
    answerA,
    answerB,
    itemId,
    send: handler,
  }
}

function get(url: string): Request {
  return new Request(`${BASE}${url}`, { method: 'GET' })
}

function post(url: string, body: unknown, key?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (key !== undefined) headers.set('idempotency-key', key)
  return new Request(`${BASE}${url}`, { method: 'POST', body: JSON.stringify(body), headers })
}

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as Record<string, any>).error as Record<string, any>
}

test('analytics HTTP: practice report writes a snapshot by default and never on save_snapshot=false', async () => {
  const h = harness()
  const first = await h.send(get(`/projects/${h.projectId}/reports/practice`))
  assert.equal(first.status, 200)
  const report = (await first.json()) as Record<string, any>
  assert.equal(report.report_kind, 'practice')
  assert.equal(report.calculation_version, 'p0-2-c06')
  assert.equal(report.result_status, 'no_data')
  assert.equal(findRows(h.db, 'analytics_report_snapshot', {}).length, 1)

  const second = await h.send(get(`/projects/${h.projectId}/reports/practice?save_snapshot=false`))
  assert.equal(second.status, 200)
  const body = (await second.json()) as Record<string, any>
  assert.equal(body.result_status, 'no_data')
  assert.equal(findRows(h.db, 'analytics_report_snapshot', {}).length, 1, 'no second snapshot')

  for (const value of ['0', 'no', 'off', 'False', 'N']) {
    const response = await h.send(get(`/projects/${h.projectId}/reports/practice?save_snapshot=${value}`))
    assert.equal(response.status, 200, value)
    assert.equal(findRows(h.db, 'analytics_report_snapshot', {}).length, 1, value)
  }
  for (const value of ['2', 'abc', '', '%20false%20']) {
    const response = await h.send(get(`/projects/${h.projectId}/reports/practice?save_snapshot=${value}`))
    assert.equal(response.status, 400, `save_snapshot=${value}`)
    const error = await errorOf(response)
    assert.equal(error.code, 'invalid_input')
    assert.equal(error.message, '请求参数校验失败')
    assert.equal(error.details.errors[0].type, 'bool_parsing')
    assert.deepEqual(error.details.errors[0].loc, ['query', 'save_snapshot'])
  }
})

test('analytics HTTP: snapshots list parses `limit` and clamps it like Django', async () => {
  const h = harness()
  await h.send(get(`/projects/${h.projectId}/reports/practice`))
  await h.send(get(`/projects/${h.projectId}/reports/practice`))

  const all = await h.send(get(`/projects/${h.projectId}/reports/snapshots`))
  assert.equal(all.status, 200)
  const rows = (await all.json()) as Record<string, any>[]
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]), [
    'snapshot_id', 'report_kind', 'as_of', 'calculation_version', 'is_stale', 'input_watermark', 'notes', 'payload',
  ])
  assert.ok(rows[0].as_of >= rows[1].as_of)

  const one = (await (await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=1`))).json()) as unknown[]
  assert.equal(one.length, 1)
  const zero = (await (await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=0`))).json()) as unknown[]
  assert.equal(zero.length, 1, 'max(1, limit)')
  const negative = (await (await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=-3`))).json()) as unknown[]
  assert.equal(negative.length, 1)
  const huge = (await (await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=100`))).json()) as unknown[]
  assert.equal(huge.length, 2)

  // Pydantic's lax int: "1.0" and "1_0" parse, surrounding whitespace is trimmed.
  const floatForm = (await (await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=1.0`))).json()) as unknown[]
  assert.equal(floatForm.length, 1)
  const underscored = (await (await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=1_0`))).json()) as unknown[]
  assert.equal(underscored.length, 2)
  const padded = (await (await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=%201%20`))).json()) as unknown[]
  assert.equal(padded.length, 1)

  const invalid = await h.send(get(`/projects/${h.projectId}/reports/snapshots?limit=abc`))
  assert.equal(invalid.status, 400)
  const error = await errorOf(invalid)
  assert.equal(error.details.errors[0].type, 'int_parsing')
  assert.deepEqual(error.details.errors[0].loc, ['query', 'limit'])
})

test('analytics HTTP: cycle-analysis requires subject_id and reproduces the `max_cycles or 5` rule', async () => {
  const h = harness()
  const missing = await h.send(get(`/projects/${h.projectId}/papers/cycle-analysis`))
  assert.equal(missing.status, 400)
  const error = await errorOf(missing)
  assert.equal(error.details.errors[0].type, 'missing')
  assert.deepEqual(error.details.errors[0].loc, ['query', 'subject_id'])

  for (const [value, horizon] of [
    ['0', 5],
    ['1', 1],
    ['99', 10],
    ['-2', 1],
  ] as const) {
    const response = await h.send(
      get(`/projects/${h.projectId}/papers/cycle-analysis?subject_id=${h.subjectId}&max_cycles=${value}`),
    )
    assert.equal(response.status, 200, value)
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.cycle_horizon, horizon, value)
  }
  const invalid = await h.send(get(`/projects/${h.projectId}/papers/cycle-analysis?subject_id=${h.subjectId}&max_cycles=abc`))
  assert.equal(invalid.status, 400)
  assert.equal((await errorOf(invalid)).details.errors[0].type, 'int_parsing')
})

test('analytics HTTP: calibration returns grouped samples without a causal summary', async () => {
  const h = harness()
  await submitAttempt(h.db, h.userId, h.itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } }, NOW)
  drain(h.db, NOW)
  const response = await h.send(get(`/projects/${h.projectId}/reports/calibration`))
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.report_kind, 'effect_calibration')
  assert.equal(body.calculation_version, 'p2-c08')
  assert.equal(body.minimum_group_sample, 5)
  assert.equal(body.group_count, 1)
  assert.equal(body.groups[0].status, 'insufficient_sample')
  assert.equal(body.groups[0].statistics, null)
  assert.equal(body.comparable_pair_count, 0)
  assert.equal(body.caveats.claims.causal_claim, false)
  assert.equal(body.caveats.claims.improvement_claim, false)
  // `?subject_id=` is falsy in Python, so it means "all subjects" rather than a 404.
  const emptySubject = await h.send(get(`/projects/${h.projectId}/reports/calibration?subject_id=`))
  assert.equal(emptySubject.status, 200)
  assert.equal(((await emptySubject.json()) as Record<string, any>).subject_id, null)
})

test('analytics HTTP: coverage and answer-reviews are scoped projections', async () => {
  const h = harness()
  const coverage = await h.send(get(`/projects/${h.projectId}/papers/coverage?subject_id=${h.subjectId}`))
  assert.equal(coverage.status, 200)
  const body = (await coverage.json()) as Record<string, any>
  assert.equal(body.subject_id, h.subjectId)
  assert.deepEqual(body.papers, [])
  assert.equal(body.completion.status, 'no_data')
  assert.equal(body.completion.final_result, null)

  const reviews = await h.send(get(`/projects/${h.projectId}/answer-reviews`))
  assert.equal(reviews.status, 200)
  const rows = (await reviews.json()) as Record<string, any>[]
  assert.deepEqual(rows.map((row) => row.answer_key_version_id).sort(), [h.answerA, h.answerB].sort())
  for (const row of rows) {
    assert.equal(row.can_regrade, true)
    assert.equal(row.is_usable, true)
    assert.equal(row.question_id, h.questionId)
    assert.equal(row.question_version_id, h.versionId)
  }

  // Someone else's project is a 404 on every path, not an empty result.
  for (const path of [
    `/projects/${h.otherProjectId}/reports/practice`,
    `/projects/${h.otherProjectId}/reports/calibration`,
    `/projects/${h.otherProjectId}/reports/snapshots`,
    `/projects/${h.otherProjectId}/papers/cycle-analysis?subject_id=${h.subjectId}`,
    `/projects/${h.otherProjectId}/papers/coverage?subject_id=${h.subjectId}`,
    `/projects/${h.otherProjectId}/answer-reviews`,
  ]) {
    const response = await h.send(get(path))
    assert.equal(response.status, 404, path)
    assert.equal((await errorOf(response)).message, '项目不存在或无权访问')
  }
})

test('analytics HTTP: regrade idempotency, replay and conflict', async () => {
  const h = harness()
  await submitAttempt(h.db, h.userId, h.itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_a' } }, NOW)
  const path = `/projects/${h.projectId}/regrades`
  const payload = {
    question_id: h.questionId,
    target_answer_key_version_id: h.answerB,
    reason: '答案勘误',
  }
  const missingKey = await h.send(post(path, payload))
  assert.equal(missingKey.status, 409)
  assert.equal((await errorOf(missingKey)).message, '缺少 Idempotency-Key 请求头')

  const created = await h.send(post(path, payload, 'regrade-1'))
  assert.equal(created.status, 201)
  const run = (await created.json()) as Record<string, any>
  assert.deepEqual(Object.keys(run), [
    'regrade_run_id', 'status', 'question_id', 'target_answer_key_version_id', 'target_rubric_version_id',
    'scope', 'reason', 'generation', 'affected_attempts', 'regraded_attempts', 'stale_skipped_attempts',
    'invalidated_evidence', 'error_message', 'created_at', 'finished_at',
  ])
  assert.equal(run.status, 'queued')
  assert.equal(run.question_id, h.questionId)
  assert.equal(run.target_answer_key_version_id, h.answerB)
  assert.equal(run.generation, 1)
  assert.equal(run.affected_attempts, 1)
  assert.equal(findRows(h.db, 'analytics_regrade_run', {}).length, 1)

  const replay = await h.send(post(path, payload, 'regrade-1'))
  assert.equal(replay.status, 201)
  assert.deepEqual(await replay.json(), run)
  assert.equal(findRows(h.db, 'analytics_regrade_run', {}).length, 1)

  const conflict = await h.send(post(path, { ...payload, reason: '不同原因' }, 'regrade-1'))
  assert.equal(conflict.status, 409)
  const conflictError = await errorOf(conflict)
  assert.equal(conflictError.code, 'idempotency_conflict')
  assert.equal(conflictError.details.reason, 'same_key_different_payload')
  assert.equal(conflictError.details.route_scope, `regrades.create:${h.projectId}`)

  const badQuestion = await h.send(post(path, { ...payload, question_id: 'missing' }, 'regrade-bad'))
  assert.equal(badQuestion.status, 404)

  const blankReason = await h.send(post(path, { ...payload, reason: '   ' }, 'regrade-blank'))
  assert.equal(blankReason.status, 400)
  assert.equal((await errorOf(blankReason)).message, '重判必须说明原因')

  const getRun = await h.send(get(`/projects/${h.projectId}/regrades/${run.regrade_run_id}`))
  assert.equal(getRun.status, 200)
  assert.deepEqual(await getRun.json(), run)

  const executed = await h.send(post(`/projects/${h.projectId}/regrades/${run.regrade_run_id}/run`, {}, 'run-1'))
  assert.equal(executed.status, 200)
  const done = (await executed.json()) as Record<string, any>
  assert.equal(done.status, 'succeeded')
  assert.equal(done.regraded_attempts, 1)
  assert.equal(done.stale_skipped_attempts, 0)
  assert.equal(findRows(h.db, 'practice_grade_event', {}).length, 2, 'initial + regrade')

  const runReplay = await h.send(post(`/projects/${h.projectId}/regrades/${run.regrade_run_id}/run`, {}, 'run-1'))
  assert.equal(runReplay.status, 200)
  assert.deepEqual(await runReplay.json(), done)
  assert.equal(findRows(h.db, 'practice_grade_event', {}).length, 2, 'replay is not a second regrade')

  const secondRunKey = await h.send(post(`/projects/${h.projectId}/regrades/${run.regrade_run_id}/run`, {}, 'run-2'))
  assert.equal(secondRunKey.status, 200)
  assert.deepEqual(await secondRunKey.json(), done)
  assert.equal(findRows(h.db, 'practice_grade_event', {}).length, 2, 'already_done writes nothing')
})

test('analytics HTTP: closed loop report → regrade → report reflects the new answer, mastery is not double-counted', async () => {
  const h = harness()
  await submitAttempt(h.db, h.userId, h.itemId, { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } }, NOW)
  let drained = drain(h.db, NOW)
  assert.equal(drained.failed, 0)

  const beforeReport = (await (await h.send(get(`/projects/${h.projectId}/reports/practice`))).json()) as Record<string, any>
  assert.equal(beforeReport.result_status, 'final')
  assert.equal(beforeReport.aggregate.score_rate, '1.0000')
  assert.equal(beforeReport.totals.fully_graded.attempts, 1)
  const evidenceBefore = findRows(h.db, 'practice_learning_evidence', { attempt_id: findRows(h.db, 'practice_attempt', {})[0].id })
  const independentBefore = evidenceBefore.filter((row) => row.dimension === 'independent_correct' && row.qualifies === true)
  assert.equal(independentBefore.length, 1)

  const create = await h.send(
    post(
      `/projects/${h.projectId}/regrades`,
      { question_id: h.questionId, target_answer_key_version_id: h.answerA, reason: '答案勘误' },
      'loop-create',
    ),
  )
  assert.equal(create.status, 201)
  const run = (await create.json()) as Record<string, any>
  const execute = await h.send(post(`/projects/${h.projectId}/regrades/${run.regrade_run_id}/run`, {}, 'loop-run'))
  assert.equal(execute.status, 200)
  assert.equal(((await execute.json()) as Record<string, any>).regraded_attempts, 1)
  drained = drain(h.db, NOW)
  assert.equal(drained.failed, 0)

  // A regrade enqueues `projection.refresh_paper_stats` with the *subject* id as `paper_id`
  // (KNOWN-B6-1), so the existing snapshot is never marked stale. The report still recomputes:
  // "stale" is an optimisation flag, not the source of truth.
  const snapshots = findRows(h.db, 'analytics_report_snapshot', {})
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].is_stale, false)

  const afterReport = (await (await h.send(get(`/projects/${h.projectId}/reports/practice?save_snapshot=false`))).json()) as Record<string, any>
  assert.equal(afterReport.result_status, 'final')
  assert.equal(afterReport.aggregate.score_rate, '0.0000', 'the regraded answer is now wrong')
  assert.equal(afterReport.totals.fully_graded.attempts, 1)
  assert.equal(findRows(h.db, 'practice_grade_event', {}).length, 2, 'initial + regrade, no third event')

  const attemptRow = findRows(h.db, 'practice_attempt', {})[0]
  const gradeRow = findOne(h.db, 'practice_grade_event', { id: String(attemptRow.current_grade_event_id) })!
  const states = findRows(h.db, 'learning_knowledge_state', { node_id: findRows(h.db, 'knowledge_node', {})[0].id })
  assert.equal(states.length, 1)
  assert.equal(states[0].independent_correct_count, 0, 'the regraded answer is wrong: mastery must be recomputed, not accumulated')
  const evidenceAfter = findRows(h.db, 'practice_learning_evidence', {
    attempt_id: findRows(h.db, 'practice_attempt', {})[0].id,
    is_active: true,
  })
  const independentAfter = evidenceAfter.filter((row) => row.dimension === 'independent_correct' && row.qualifies === true)
  assert.equal(independentAfter.length, 0, 'no active qualified independent evidence after the flip')
  const allEvidence = findRows(h.db, 'practice_learning_evidence', { attempt_id: findRows(h.db, 'practice_attempt', {})[0].id })
  const activeEvidence = allEvidence.filter((row) => row.is_active === true)
  assert.ok(activeEvidence.length <= 6, `one live revision of rows, got ${activeEvidence.length}`)
  assert.equal(allEvidence.length - activeEvidence.length, 6, 'the superseded revision is kept as history')
})
