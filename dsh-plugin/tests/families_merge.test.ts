import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createFamily } from '../src/services/families.ts'
import {
  DISTINCTNESS_DIMENSIONS,
  MERGE_INVALIDATION_REASON,
  mergeFamilies,
  mergeImpact,
} from '../src/services/families.ts'
import { InvalidInput } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-06-01T00:00:00+00:00')

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
    row[column.name] = column.json
      ? {}
      : column.kind === 'datetime'
        ? NOW
        : column.kind === 'int' || column.kind === 'bool'
          ? 0
          : ''
  }
  Object.assign(row, overrides)
  return row
}

function seeded() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'merge@example.com', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'P' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: 'S' }, NOW)
  const subjectId = String(subject.id)

  const familyA = createFamily(db, { projectId, actorId: userId, subjectId, name: '家族 A', now: NOW })
  const familyB = createFamily(db, { projectId, actorId: userId, subjectId, name: '家族 B', now: NOW })

  const q1 = addQuestionWithVersion(db, subjectId, String(familyA.id), 'A1')
  const q2 = addQuestionWithVersion(db, subjectId, String(familyB.id), 'B1')

  // q2 was delivered once; q1 never.
  insertRow(
    db,
    'practice_exposure_event',
    completeRow('practice_exposure_event', {
      user_id: userId,
      project_id: projectId,
      question_id: q2.questionId,
      question_version_id: q2.versionId,
      family_id: String(familyB.id),
      content_lineage_id: null,
      session_item_id: null,
      kind: 'stem_delivered',
      purpose: 'practice',
      source: 'session',
      server_time: NOW,
      detail: {},
      reveals_answer: false,
    }),
    { now: NOW },
  )

  // One active `unseen_variant` row for q1, i.e. proof that only existed because
  // the two questions were considered different families.
  const session = insertRow(
    db,
    'practice_session',
    completeRow('practice_session', {
      user_id: userId,
      project_id: projectId,
      subject_id: subjectId,
      mode: 'practice',
      status: 'active',
      note: '',
    }),
    { now: NOW },
  )
  const item = insertRow(
    db,
    'practice_session_item',
    completeRow('practice_session_item', {
      session_id: session.id,
      ordinal: 1,
      question_version_id: q1.versionId,
      answer_key_version_id: null,
      rubric_version_id: null,
      spec_version_id: null,
      max_score: '2.00',
      purpose: 'practice',
      draft: {},
      draft_revision: 0,
    }),
    { now: NOW },
  )
  const attempt = insertRow(
    db,
    'practice_attempt',
    completeRow('practice_attempt', {
      session_item_id: item.id,
      user_id: userId,
      project_id: projectId,
      raw_answer: {},
      steps: [],
      attachments: [],
      submitted_at: NOW,
      request_digest: '',
      idempotency_key: 'k1',
    }),
    { now: NOW },
  )
  const evidence = insertRow(
    db,
    'practice_learning_evidence',
    completeRow('practice_learning_evidence', {
      attempt_id: attempt.id,
      session_item_id: item.id,
      user_id: userId,
      project_id: projectId,
      grade_event_id: null,
      grade_revision: 0,
      knowledge_node_id: null,
      dimension: DISTINCTNESS_DIMENSIONS[0],
      qualifies: true,
      is_correct: true,
      score_fraction: null,
      exclusion_reasons: [],
      rule_version: 'p0-1',
      computed_at: NOW,
      is_active: true,
      invalidated_at: null,
      invalidated_reason: '',
      detail: { family_id: String(familyB.id), sibling_question_id: q2.questionId },
    }),
    { now: NOW },
  )
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    subjectId,
    familyA: String(familyA.id),
    familyB: String(familyB.id),
    q1,
    q2,
    evidenceId: String(evidence.id),
  }
}

function addQuestionWithVersion(
  db: DatabaseSync,
  subjectId: string,
  familyId: string,
  label: string,
): { questionId: string; versionId: string } {
  const question = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', {
      subject_id: subjectId,
      family_id: familyId,
      display_label: label,
      origin_type: 'import',
      is_demo: false,
      created_at: NOW,
      updated_at: NOW,
    }),
    { now: NOW },
  )
  const version = insertRow(
    db,
    'question_bank_question_version',
    completeRow('question_bank_question_version', {
      question_id: question.id,
      version: 1,
      question_type: 'single_choice',
      content: { blocks: [{ kind: 'text', text: label }], options: [{ id: 'a', label: 'A' }] },
      material_child_version_ids: [],
      practice_max_score: '2.00',
      estimated_seconds: 60,
      status: 'draft',
      revision_reason: '',
      source_note: '',
      published_at: null,
      withdrawn_at: null,
      withdrawn_reason: '',
      content_digest: '',
    }),
    { now: NOW },
  )
  updateRow(db, 'question_bank_question', question.id, { current_published_version_id: null }, { now: NOW })
  return { questionId: String(question.id), versionId: String(version.id) }
}

test('merge impact: the numbers the merge will produce, before anyone confirms', () => {
  const s = seeded()
  try {
    const impact = mergeImpact(s.db, s.projectId, s.familyA, s.familyB)
    assert.equal(impact.already_merged, false)
    assert.equal(impact.questions_to_move, 1)
    assert.equal(impact.questions_in_target_after, 2)
    assert.equal(impact.evidence_rows_to_invalidate, 1)
    assert.equal(impact.exposed_before_merge, 1, 'only the delivered question is seen before the merge')
    assert.equal(impact.exposed_after_merge, 2, 'after merging, one seen member contaminates both')
    assert.deepEqual(impact.exposed_question_ids_before_merge, [s.q2.questionId])
    assert.deepEqual(impact.affected_user_ids, [s.userId])
  } finally {
    s.close()
  }
})

test('merge: moves the questions, invalidates distinctness proof and reports the new exposure', () => {
  const s = seeded()
  try {
    const result = mergeFamilies(s.db, s.userId, s.projectId, s.familyA, s.familyB, {
      reason: '同源变式',
      now: NOW,
    })
    assert.equal(result.noop, false)
    assert.equal(result.questions_moved, 1)
    assert.equal(result.questions_in_target_after, 2)
    assert.equal(result.evidence_invalidated, 1)
    assert.equal(result.states_recomputed, 0, 'evidence without a node recomputes no state')
    assert.equal(result.exposed_before_merge, 1)
    assert.equal(result.exposed_after_merge, 2)
    assert.equal(result.merge_revision, 2)
    assert.equal((result.exposure_changes as unknown[]).length, 1)
    const change = (result.exposure_changes as Record<string, unknown>[])[0]
    assert.equal(change.question_id, s.q1.questionId)
    assert.deepEqual(change.reasons, ['family_variant_seen'])

    const moved = findOne(s.db, 'question_bank_question', { id: s.q1.questionId })!
    assert.equal(String(moved.family_id), s.familyB, 'the question really moved')
    const source = findOne(s.db, 'question_bank_family', { id: s.familyA })!
    assert.equal(String(source.merged_into_id), s.familyB)
    assert.notEqual(source.merged_at, null)
    const target = findOne(s.db, 'question_bank_family', { id: s.familyB })!
    assert.equal(target.revision, 2)

    const evidence = findOne(s.db, 'practice_learning_evidence', { id: s.evidenceId })!
    assert.equal(evidence.is_active, false, 'stale proof is invalidated, never deleted')
    assert.equal(evidence.invalidated_reason, MERGE_INVALIDATION_REASON)
    assert.notEqual(evidence.invalidated_at, null)

    const audit = findRows(s.db, 'audit_content_revision', { entity_id: s.familyB, action: 'merge' })
    assert.equal(audit.length, 1)
    const detail = audit[0].detail as Record<string, unknown>
    assert.equal(detail.source_family_id, s.familyA)
    assert.deepEqual(detail.invalidated_evidence_ids, [s.evidenceId])
    assert.equal(detail.evidence_invalidated, 1)
    assert.equal(result.content_revision_id, String(audit[0].id))
  } finally {
    s.close()
  }
})

test('merge: repeating the same merge is a no-op that writes nothing', () => {
  const s = seeded()
  try {
    mergeFamilies(s.db, s.userId, s.projectId, s.familyA, s.familyB, { now: NOW })
    const auditsBefore = findRows(s.db, 'audit_content_revision', {}).length
    const again = mergeFamilies(s.db, s.userId, s.projectId, s.familyA, s.familyB, { now: NOW })
    assert.equal(again.noop, true)
    assert.equal(again.questions_moved, 0)
    assert.equal(again.evidence_invalidated, 0)
    assert.equal(again.states_recomputed, 0)
    assert.equal(again.content_revision_id, null)
    assert.equal(findRows(s.db, 'audit_content_revision', {}).length, auditsBefore, 'no second audit row')
    const target = findOne(s.db, 'question_bank_family', { id: s.familyB })!
    assert.equal(target.revision, 2, 'the surviving family does not get a second revision bump')
  } finally {
    s.close()
  }
})

test('merge: refuses self-merge, cross-subject merges and a family already merged elsewhere', () => {
  const s = seeded()
  try {
    assert.throws(
      () => mergeFamilies(s.db, s.userId, s.projectId, s.familyA, s.familyA, { now: NOW }),
      InvalidInput,
    )
    const otherSubject = createSubject(s.db, s.userId, s.projectId, { name: 'S2' }, NOW)
    const foreign = createFamily(s.db, {
      projectId: s.projectId,
      actorId: s.userId,
      subjectId: String(otherSubject.id),
      name: '跨科目',
      now: NOW,
    })
    assert.throws(
      () => mergeImpact(s.db, s.projectId, s.familyA, String(foreign.id)),
      InvalidInput,
    )

    mergeFamilies(s.db, s.userId, s.projectId, s.familyA, s.familyB, { now: NOW })
    const third = createFamily(s.db, {
      projectId: s.projectId,
      actorId: s.userId,
      subjectId: s.subjectId,
      name: '第三个',
      now: NOW,
    })
    assert.throws(
      () => mergeFamilies(s.db, s.userId, s.projectId, s.familyA, String(third.id), { now: NOW }),
      InvalidInput,
    )
  } finally {
    s.close()
  }
})

test('merge: unmerged families keep the plain family rule (no free contamination)', () => {
  const s = seeded()
  try {
    const impact = mergeImpact(s.db, s.projectId, s.familyB, s.familyA)
    assert.equal(impact.questions_to_move, 1)
    assert.equal(impact.exposed_before_merge, 1)
    assert.equal(impact.exposed_after_merge, 2)
    // Nothing is written by a preview.
    assert.equal(findRows(s.db, 'question_bank_family', { id: s.familyA })[0].revision, 1)
    assert.equal(findRows(s.db, 'practice_learning_evidence', { id: s.evidenceId })[0].is_active, true)
  } finally {
    s.close()
  }
})
