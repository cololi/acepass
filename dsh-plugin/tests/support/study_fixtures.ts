/**
 * Shared fixtures for the M1 interaction tests.
 *
 * The same minimal but *valid* dataset is needed by the frequency, memory, card,
 * session and HTTP tests: a project with one published syllabus, three nodes,
 * two published single-choice questions with checked answers, and enough real
 * papers for the frequency profile to be rankable. Building it through the real
 * services would hide the exact rows the frequency math reads, so this module
 * writes rows directly and keeps every NOT NULL column filled.
 */
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'

import { parseInstant, type Instant } from '../../src/domain/instant.ts'
import { insertRow, updateRow } from '../../src/store/repository.ts'
import { TABLES } from '../../src/store/schema.generated.ts'
import { openStore } from '../../src/store/db.ts'
import { createProject, createSubject } from '../../src/services/exams.ts'

export const NOW = parseInstant('2027-02-01T10:00:00+00:00')

/** Every NOT NULL column the test does not set gets a value the schema accepts. */
export function completeRow(table: string, overrides: Record<string, unknown>, now: Instant = NOW): Record<string, unknown> {
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
    row[column.name] = column.json ? {} : column.kind === 'datetime' ? now : column.kind === 'int' || column.kind === 'bool' ? 0 : ''
  }
  Object.assign(row, overrides)
  return row
}

export interface StudyFixture {
  db: DatabaseSync
  close(): void
  userId: string
  projectId: string
  subjectId: string
  syllabusId: string
  nodeIds: [string, string, string]
  questionIds: [string, string]
  versionIds: [string, string]
  /** Cycle keys of the two countable real papers. */
  cycleKeys: [string, string]
}

const CONTENT = {
  blocks: [{ kind: 'text', text: '题干（测试）' }],
  options: [
    { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '选项 A' }] },
    { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '选项 B' }] },
  ],
}

export function studyStore(options: { withPapers?: boolean; withSettings?: boolean } = {}): StudyFixture {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: `study-${Math.random().toString(36).slice(2, 8)}@example.com`, date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  if (options.withSettings !== false) {
    insertRow(
      db,
      'accounts_user_settings',
      completeRow('accounts_user_settings', {
        user_id: user.id,
        timezone: 'UTC',
        daily_budget_minutes: 60,
        project_budget_percent: {},
        undiagnosed_time_share_percent: 20,
      }),
      { now: NOW },
    )
  }
  const project = createProject(db, userId, { name: '考研（测试）' }, NOW)
  const subject = createSubject(db, userId, String(project.id), { name: '数学（测试）' }, NOW)
  const projectId = String(project.id)
  const subjectId = String(subject.id)
  const syllabus = insertRow(
    db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', {
      subject_id: subjectId,
      name: '测试大纲',
      version_label: 'v1',
      status: 'published',
      review_status: 'approved',
    }),
    { now: NOW },
  )
  const syllabusId = String(syllabus.id)
  const nodeIds = ['极限', '导数', '积分'].map((name, index) =>
    String(
      insertRow(
        db,
        'knowledge_node',
        completeRow('knowledge_node', {
          syllabus_version_id: syllabusId,
          parent_id: null,
          canonical_name: name,
          code: name,
          is_unclassified: false,
          display_order: index + 1,
        }),
        { now: NOW },
      ).id,
    ),
  ) as [string, string, string]

  function addQuestion(nodeId: string, label: string, score = '10.00'): { questionId: string; versionId: string } {
    const question = insertRow(
      db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subjectId,
        origin_type: 'import',
        is_demo: false,
        display_label: label,
      }),
      { now: NOW },
    )
    const version = insertRow(
      db,
      'question_bank_question_version',
      completeRow('question_bank_question_version', {
        question_id: question.id,
        version: 1,
        status: 'published',
        question_type: 'single_choice',
        content: CONTENT,
        practice_max_score: score,
        published_at: NOW,
      }),
      { now: NOW },
    )
    updateRow(db, 'question_bank_question', question.id, { current_published_version_id: version.id }, { now: NOW })
    insertRow(
      db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: version.id,
        version: 1,
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
        check_basis: '测试答案依据',
        source_type: 'textbook_or_bank',
        checked_by_id: user.id,
        checked_at: NOW,
      }),
      { now: NOW },
    )
    insertRow(
      db,
      'knowledge_question_mapping',
      completeRow('knowledge_question_mapping', {
        question_version_id: version.id,
        mapping_revision: 1,
        node_id: nodeId,
        is_primary: true,
        score_weight: '1.0000',
        note: '',
      }),
      { now: NOW },
    )
    return { questionId: String(question.id), versionId: String(version.id) }
  }

  const q1 = addQuestion(nodeIds[0], 'Q1')
  const q2 = addQuestion(nodeIds[1], 'Q2')

  const cycleKeys: [string, string] = ['2026', '2025']
  if (options.withPapers !== false) {
    // Newest cycle: Q1 carries 10 of 10 marks. Older cycle: Q1 carries 4 of 10 and Q2 6 of 10.
    for (const [index, cycleKey] of cycleKeys.entries()) {
      const paper = insertRow(
        db,
        'exams_paper',
        completeRow('exams_paper', {
          subject_id: subjectId,
          cycle_key: cycleKey,
          session_key: '',
          paper_code: `P-${cycleKey}`,
          title: '',
          source_kind: 'official_past',
          is_demo: false,
          notes: '',
        }),
        { now: NOW },
      )
      const revision = insertRow(
        db,
        'exams_paper_revision',
        completeRow('exams_paper_revision', {
          paper_id: paper.id,
          revision: 1,
          expected_session_count: 1,
          covered_session_count: 1,
          coverage_confirmed_at: NOW,
          status: 'confirmed',
          note: '',
        }),
        { now: NOW },
      )
      const items =
        index === 0
          ? [{ versionId: q1.versionId, score: '10.00', position: '1' }]
          : [
              { versionId: q1.versionId, score: '4.00', position: '1' },
              { versionId: q2.versionId, score: '6.00', position: '2' },
            ]
      for (const item of items) {
        insertRow(
          db,
          'exams_paper_item',
          completeRow('exams_paper_item', {
            revision_id: revision.id,
            position_key: item.position,
            question_version_id: item.versionId,
            max_score: item.score,
            is_scored: true,
            is_demo: false,
          }),
          { now: NOW },
        )
      }
      updateRow(db, 'exams_paper', paper.id, { effective_revision_id: revision.id }, { now: NOW })
    }
  }

  return {
    db,
    close: handle.close,
    userId,
    projectId,
    subjectId,
    syllabusId,
    nodeIds,
    questionIds: [q1.questionId, q2.questionId],
    versionIds: [q1.versionId, q2.versionId],
    cycleKeys,
  }
}

/** One knowledge state row, so ability-dependent planning is exercised for real. */
export function addKnowledgeState(fixture: StudyFixture, nodeId: string, summary: string): string {
  const row = insertRow(
    fixture.db,
    'learning_knowledge_state',
    completeRow('learning_knowledge_state', {
      user_id: fixture.userId,
      project_id: fixture.projectId,
      syllabus_version_id: fixture.syllabusId,
      node_id: nodeId,
      summary,
      best_summary: summary,
      needs_review: summary === 'needs_review' || summary === 'needs_foundation',
      as_of: NOW,
      detail: {},
      source_evidence_ids: [],
    }),
    { now: NOW },
  )
  return String(row.id)
}

/** A confirmed node card written directly (the card service is tested separately). */
export function addConfirmedCard(
  fixture: StudyFixture,
  nodeId: string,
  keyPoints: Array<{ id: string; text: string; required?: boolean }>,
): string {
  const row = insertRow(
    fixture.db,
    'knowledge_node_card',
    completeRow('knowledge_node_card', {
      node_id: nodeId,
      syllabus_version_id: fixture.syllabusId,
      revision: 1,
      is_current: true,
      status: 'confirmed',
      origin: 'manual',
      blocks: [{ kind: 'text', text: '考点内容（测试）' }],
      key_points: keyPoints.map((point) => ({ id: point.id, text: point.text, required: point.required !== false })),
      citations: [`knowledge_node:${nodeId}`],
      source_note: '测试',
      confirmed_at: NOW,
      confirmed_by_id: fixture.userId,
    }),
    { now: NOW },
  )
  return String(row.id)
}
