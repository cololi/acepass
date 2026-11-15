/**
 * The B2 exit criterion, end to end: a proofread candidate becomes an immutable question version,
 * that version is frozen into a practice session, and a submission is graded deterministically.
 *
 * This is deliberately *not* a re-test of grading (that module has its own golden vectors). It
 * checks that the publication write-set is complete enough for the rest of the product to consume:
 * a checked answer the session can trust, a mapping revision the evidence rebuild can attribute,
 * and a paper item whose stats projection the worker can consume.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { drain } from '../src/jobs/worker.ts'
import { createProject, createSpecVersion, createSubject, publishSpecVersion } from '../src/services/exams.ts'
import { createCandidate, createImportJob, createSourceRegion, createTextDocument } from '../src/services/ingestion.ts'
import { publishCandidate } from '../src/services/ingestion_publish.ts'
import { startTextImport } from '../src/services/ingestion_imports.ts'
import { parsePaste } from '../src/domain/ingestion/text_parser.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const ONE_QUESTION = '【题型】单选\n【题干】下列哪项是质数？\n【选项】\nA. 4\nB. 7\nC. 9\n【答案】B\n'

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

function seeded() {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const userId = String(
    insertRow(
      db,
      'accounts_user',
      completeRow('accounts_user', { email: 'loop@example.com', date_joined: NOW }),
      { now: NOW },
    ).id,
  )
  const projectId = String(createProject(db, userId, { name: '闭环' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学' }, NOW).id)
  const specId = String(
    createSpecVersion(
      db,
      userId,
      projectId,
      {
        subject_id: subjectId,
        name: '规范',
        question_type_rules: {
          single_choice: { default_max_score: '2.00', wrong_score: '0.00', blank_score: '0.00' },
        },
      },
      NOW,
    ).id,
  )
  publishSpecVersion(db, userId, projectId, specId, NOW)
  const syllabus = insertRow(
    db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', { subject_id: subjectId, name: '大纲', version_label: 'v1' }),
    { now: NOW },
  )
  const node = insertRow(
    db,
    'knowledge_node',
    completeRow('knowledge_node', { syllabus_version_id: syllabus.id, canonical_name: '质数', code: 'P' }),
    { now: NOW },
  )
  return { db, close: handle.close, userId, projectId, subjectId, specId, nodeId: String(node.id) }
}

/** Import one question through the real text path, then publish it through O18's service. */
function publishOne(s: ReturnType<typeof seeded>): { candidateId: string; questionId: string; versionId: string } {
  const job = startTextImport(
    s.db,
    {
      ownerId: s.userId,
      projectId: s.projectId,
      subjectId: s.subjectId,
      text: ONE_QUESTION,
      title: '',
      sourceNote: '',
      usageScope: '',
      segments: parsePaste(ONE_QUESTION),
    },
    NOW,
  )
  const candidate = findRows(s.db, 'ingestion_import_candidate', { job_id: job.id })[0]
  assert.ok(candidate)
  const result = publishCandidate(
    s.db,
    s.userId,
    s.projectId,
    String(candidate.id),
    { examSpecVersion: findOne(s.db, 'exams_spec_version', { id: s.specId }), nodeIds: [s.nodeId] },
    NOW,
  )
  return {
    candidateId: String(candidate.id),
    questionId: String(result.question.id),
    versionId: String(result.candidate.publication_version_id),
  }
}

test('closed loop: published candidate -> frozen session -> deterministic grading', () => {
  const s = seeded()
  try {
    const { questionId, versionId } = publishOne(s)

    const session = createSession(s.db, s.userId, s.projectId, { subject_id: s.subjectId, question_ids: [questionId] }, NOW)
    const items = findRows(s.db, 'practice_session_item', { session_id: session.id })
    assert.equal(items.length, 1)
    const item = items[0]
    // Freezing: the item points at the exact published version and its checked answer.
    assert.equal(String(item.question_version_id), versionId)
    assert.ok(item.answer_key_version_id)
    assert.equal(String(item.max_score), '2.00')
    assert.equal(item.mapping_revision, 1)

    const presented = presentItem(s.db, s.userId, String(item.id), NOW)
    const stem = JSON.stringify(presented.stem)
    assert.equal(stem.includes('correct_option_id'), false, 'the stem never carries the answer')
    assert.equal(stem.includes('opt_b'), true, 'options are delivered without correctness markers')
    assert.equal(presented.first_delivery, true)
    assert.equal(presented.max_score, '2.00')

    const correct = submitAttempt(
      s.db,
      s.userId,
      String(item.id),
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_b' } },
      NOW + 60_000_000n,
    )
    assert.equal(correct.grade.status, 'confirmed')
    assert.equal(correct.grade.confirmed_score, '2.00')
    assert.equal(correct.grade.max_score, '2.00')
    assert.equal(correct.grade.is_fully_confirmed, true)

    // The submission enqueued the evidence rebuild; the worker (with its default handlers) drains
    // it and the six dimensions land against the node the publication mapped.
    const events = findRows(s.db, 'audit_outbox_event', { topic: 'evidence.rebuild_for_attempt' })
    assert.equal(events.length, 1)
    const drained = drain(s.db, NOW + 60_000_000n)
    assert.equal(drained.failed, 0)
    const evidence = findRows(s.db, 'practice_learning_evidence', { attempt_id: correct.attempt.id })
    assert.equal(evidence.length, 6, 'one row per dimension')
    assert.ok(evidence.every((row) => String(row.knowledge_node_id) === s.nodeId))
  } finally {
    s.close()
  }
})

test('closed loop: a wrong answer on the published version is a confirmed zero', () => {
  const s = seeded()
  try {
    const { questionId } = publishOne(s)
    const session = createSession(s.db, s.userId, s.projectId, { subject_id: s.subjectId, question_ids: [questionId] }, NOW)
    const item = findRows(s.db, 'practice_session_item', { session_id: session.id })[0]
    presentItem(s.db, s.userId, String(item.id), NOW)
    const wrong = submitAttempt(
      s.db,
      s.userId,
      String(item.id),
      { raw_answer: { type: 'single_choice', selected_option_id: 'opt_a' } },
      NOW + 60_000_000n,
    )
    assert.equal(wrong.grade.status, 'confirmed')
    assert.equal(wrong.grade.confirmed_score, '0.00')
    assert.equal(wrong.grade.is_fully_confirmed, true)
  } finally {
    s.close()
  }
})

test('closed loop: publishing twice cannot produce a second question or version', () => {
  const s = seeded()
  try {
    const { candidateId, questionId, versionId } = publishOne(s)
    const before = {
      questions: findRows(s.db, 'question_bank_question', {}).length,
      versions: findRows(s.db, 'question_bank_question_version', {}).length,
      answers: findRows(s.db, 'question_bank_answer_key_version', {}).length,
    }
    const again = publishCandidate(
      s.db,
      s.userId,
      s.projectId,
      candidateId,
      { examSpecVersion: findOne(s.db, 'exams_spec_version', { id: s.specId }), nodeIds: [s.nodeId] },
      NOW + 1_000_000n,
    )
    assert.equal(String(again.question.id), questionId)
    assert.equal(String(again.candidate.publication_version_id), versionId)
    assert.equal(findRows(s.db, 'question_bank_question', {}).length, before.questions)
    assert.equal(findRows(s.db, 'question_bank_question_version', {}).length, before.versions)
    assert.equal(findRows(s.db, 'question_bank_answer_key_version', {}).length, before.answers)
  } finally {
    s.close()
  }
})

test('closed loop: the paper stats projection marks report snapshots stale', () => {
  const s = seeded()
  try {
    const subject = findOne(s.db, 'exams_subject', { id: s.subjectId })!
    const paper = insertRow(
      s.db,
      'exams_paper',
      completeRow('exams_paper', {
        subject_id: subject.id,
        cycle_key: '2025',
        session_key: '',
        paper_code: '卷一',
        title: '',
        source_kind: 'official_past',
        is_demo: false,
        notes: '',
      }),
      { now: NOW },
    )
    const revision = insertRow(
      s.db,
      'exams_paper_revision',
      completeRow('exams_paper_revision', { paper_id: paper.id, revision: 1, spec_version_id: s.specId, status: 'draft' }),
      { now: NOW },
    )
    const document = createTextDocument(
      s.db,
      { ownerId: s.userId, projectId: s.projectId, subjectId: s.subjectId, text: '试卷来源', title: '' },
      NOW,
    )
    const job = createImportJob(
      s.db,
      { ownerId: s.userId, projectId: s.projectId, subjectId: s.subjectId, inputKind: 'text', inputText: 'paper-candidate' },
      NOW,
    )
    const region = createSourceRegion(
      s.db,
      { documentId: String(document.id), x: 0, y: 0, width: 1, height: 0.05 },
      NOW,
    )
    const candidate = createCandidate(
      s.db,
      {
        job,
        payload: {
          question_type: 'single_choice',
          display_label: '',
          content: {
            blocks: [{ kind: 'text', text: '试卷题干' }],
            options: [
              { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '甲' }] },
              { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '乙' }] },
            ],
          },
          answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
          answer_status_known: true,
          explanation_blocks: [],
          practice_max_score: '2.00',
        },
        subjectId: s.subjectId,
        regionIds: [String(region.id)],
        paperRevisionId: String(revision.id),
        sourcePositionKey: '1',
      },
      NOW,
    )
    const snapshot = insertRow(
      s.db,
      'analytics_report_snapshot',
      completeRow('analytics_report_snapshot', {
        user_id: s.userId,
        project_id: s.projectId,
        subject_id: s.subjectId,
        report_kind: 'practice',
        calculation_version: 'p0-1',
        input_watermark: {},
        filters: {},
        as_of: NOW,
        status: 'succeeded',
        payload: {},
        notes: {},
        is_stale: false,
      }),
      { now: NOW },
    )
    publishCandidate(
      s.db,
      s.userId,
      s.projectId,
      String(candidate.id),
      { examSpecVersion: findOne(s.db, 'exams_spec_version', { id: s.specId }), nodeIds: [] },
      NOW,
    )
    assert.equal(Boolean(findOne(s.db, 'analytics_report_snapshot', { id: snapshot.id })!.is_stale), false)
    const result = drain(s.db, NOW)
    assert.equal(result.handled >= 1, true)
    assert.equal(Boolean(findOne(s.db, 'analytics_report_snapshot', { id: snapshot.id })!.is_stale), true)
    const events = findRows(s.db, 'audit_outbox_event', { topic: 'projection.refresh_paper_stats' })
    assert.equal(events.length, 1)
    assert.ok(events[0].processed_at)
  } finally {
    s.close()
  }
})
