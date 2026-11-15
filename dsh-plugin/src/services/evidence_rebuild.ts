/**
 * Evidence rebuild: turn one stored attempt into evidence rows and a refreshed knowledge state.
 *
 * This is the job behind the outbox topic `evidence.rebuild_for_attempt`. It is the seam between
 * storage and two modules that already have golden vectors (`domain/evidence.ts`,
 * `domain/state.ts`), so the only new work here is resolving the *facts* those modules ask for.
 * No rule is re-implemented: if a decision needs changing, it changes in `domain/`.
 */
import type { DatabaseSync } from 'node:sqlite'
import { type Instant, formatPythonIso as iso, parseInstant } from '../domain/instant.ts'
import { Decimal } from '../domain/decimal.ts'
import { computeDimensions, type AttemptFacts, type GradeFacts, type MappingFacts } from '../domain/evidence.ts'
import {
  attemptExclusionReasons,
  type ExposureFact,
  type ExposureFacts,
  type FamilyFact,
  type ItemFact,
  type QuestionFact,
} from '../domain/contamination.ts'
import { latestLearningAnchor, type AnchorEvent, type AnchorFacts } from '../domain/anchors.ts'
import { projectNodeState, type StateEvidenceRow, type Summary } from '../domain/state.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'

const EVIDENCE_RULE_VERSION = 'p2-c04'
const ANCHOR_WINDOW_DAYS = 365
const INVALIDATED_REASON = '判分修订后重建'
/** `evidence.py::invalidate_for_answer_version` — the reason string is part of the row. */
export const ANSWER_DISPUTED_INVALIDATION_REASON = '答案版本进入争议'

const isoOf = (value: unknown): string => (value === null || value === undefined ? '' : iso(value as Instant))

/** Everything the contamination resolver needs for one owner, loaded once. */
export function loadExposureFacts(db: DatabaseSync, userId: string): ExposureFacts {
  const questions = findRows(db, 'question_bank_question', {})
  const subjects = new Map(findRows(db, 'exams_subject', {}).map((subject) => [String(subject.id), subject]))
  const questionFacts: QuestionFact[] = questions.map((question) => {
    const subject = subjects.get(String(question.subject_id))
    return {
      id: String(question.id),
      content_lineage_id: question.content_lineage_id === null ? null : String(question.content_lineage_id),
      family_id: question.family_id === null ? null : String(question.family_id),
      subject_project_id: subject === undefined ? null : String(subject.project_id),
    }
  })
  const familyFacts: FamilyFact[] = findRows(db, 'question_bank_family', {}).map((family) => ({
    id: String(family.id),
    merged_into_id: family.merged_into_id === null ? null : String(family.merged_into_id),
    member_ids: questions
      .filter((question) => String(question.family_id) === String(family.id))
      .map((question) => String(question.id)),
  }))
  const versions = new Map(
    findRows(db, 'question_bank_question_version', {}).map((version) => [String(version.id), version]),
  )
  const exposures: ExposureFact[] = findRows(db, 'practice_exposure_event', { user_id: userId }).map((row) => {
    const version = row.question_version_id === null ? undefined : versions.get(String(row.question_version_id))
    return {
      id: String(row.id),
      question_id: row.question_id === null ? null : String(row.question_id),
      question_version_id: row.question_version_id === null ? null : String(row.question_version_id),
      question_version_question_id: version === undefined ? null : String(version.question_id),
      content_lineage_id: row.content_lineage_id === null ? null : String(row.content_lineage_id),
      project_id: row.project_id === null ? null : String(row.project_id),
      session_item_id: row.session_item_id === null ? null : String(row.session_item_id),
      kind: String(row.kind),
      server_time: isoOf(row.server_time),
    }
  })

  const items: ItemFact[] = []
  for (const item of findRows(db, 'practice_session_item', {})) {
    const session = findOne(db, 'practice_session', { id: String(item.session_id) })
    if (session === null || String(session.user_id) !== String(userId)) continue
    if (item.first_delivered_at === null) continue
    const version = versions.get(String(item.question_version_id))
    if (version === undefined) continue
    items.push({
      id: String(item.id),
      question_id: String(version.question_id),
      content_lineage_id: null,
      session_project_id: String(session.project_id),
      first_delivered_at: isoOf(item.first_delivered_at),
      has_attempt: findOne(db, 'practice_attempt', { session_item_id: String(item.id) }) !== null,
    })
  }
  return { questions: questionFacts, families: familyFacts, exposures, items }
}

function nodeIdsForQuestion(db: DatabaseSync, questionId: unknown): string[] {
  if (questionId === null || questionId === undefined) return []
  const ids = new Set<string>()
  for (const version of findRows(db, 'question_bank_question_version', { question_id: String(questionId) })) {
    for (const mapping of findRows(db, 'knowledge_question_mapping', { question_version_id: String(version.id) })) {
      ids.add(String(mapping.node_id))
    }
  }
  return [...ids]
}

/** Prior submissions and answer-revealing deliveries, which are the only delay anchors. */
export function loadAnchorFacts(db: DatabaseSync, userId: string): AnchorFacts {
  const attempts: AnchorEvent[] = []
  for (const attempt of findRows(db, 'practice_attempt', { user_id: userId })) {
    const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
    const version = item === null ? null : findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
    const nodeIds = version === null ? [] : nodeIdsForQuestion(db, version.question_id)
    if (nodeIds.length === 0) continue
    attempts.push({
      id: String(attempt.id),
      project_id: String(attempt.project_id),
      at: isoOf(attempt.submitted_at),
      node_ids: nodeIds,
    })
  }
  const teaching: AnchorEvent[] = []
  for (const exposure of findRows(db, 'practice_exposure_event', { user_id: userId })) {
    if (exposure.reveals_answer !== true) continue
    const nodeIds = nodeIdsForQuestion(db, exposure.question_id)
    if (nodeIds.length === 0) continue
    teaching.push({
      project_id: String(exposure.project_id),
      at: isoOf(exposure.server_time),
      node_ids: nodeIds,
    })
  }
  return { attempts, teaching_exposures: teaching, tutoring: [] }
}

function gradeFactsOf(row: Record<string, unknown> | null): GradeFacts | null {
  if (row === null) return null
  return {
    status: String(row.status),
    isFullyConfirmed: Boolean(row.is_fully_confirmed),
    confirmedScore: row.confirmed_score === null ? null : (row.confirmed_score as Decimal),
    maxScore: row.max_score === null ? null : (row.max_score as Decimal),
    graderIsSelf: Boolean(row.grader_is_self),
    method: String(row.method),
  }
}

/** Build the pure-facts input `computeDimensions` needs, from the stored rows. */
export function buildAttemptFacts(db: DatabaseSync, attemptId: string): AttemptFacts | null {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null) return null
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) return null
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (session === null || version === null) return null
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  const grade =
    attempt.current_grade_event_id === null
      ? (findRows(db, 'practice_grade_event', { attempt_id: attempt.id }, {
          orderBy: [['grading_revision', 'desc']],
        })[0] ?? null)
      : findOne(db, 'practice_grade_event', { id: attempt.current_grade_event_id })

  const submittedAt = attempt.submitted_at as Instant
  const delivered = (item.first_delivered_at ?? null) as Instant | null
  const windowStart = delivered === null ? null : delivered - BigInt(ANCHOR_WINDOW_DAYS) * 86_400_000_000n
  const exposures = findRows(db, 'practice_exposure_event', {
    user_id: attempt.user_id,
    question_version_id: item.question_version_id,
  }).filter((row) => {
    const at = row.server_time as Instant
    return at < submittedAt && (windowStart === null || at >= windowStart)
  })

  const contaminationFacts = loadExposureFacts(db, String(attempt.user_id))
  const contamination = attemptExclusionReasons(contaminationFacts, {
    question_id: String(version.question_id),
    project_id: String(attempt.project_id),
    first_delivered_at: delivered === null ? null : iso(delivered),
    submitted_at: iso(submittedAt),
    session_item_id: String(item.id),
  }).map((row) => ({ code: row.code, message: row.message }))

  const mappings: MappingFacts[] = []
  for (const mapping of findRows(db, 'knowledge_question_mapping', { question_version_id: item.question_version_id })) {
    const node = findOne(db, 'knowledge_node', { id: String(mapping.node_id) })
    mappings.push({
      nodeId: String(mapping.node_id),
      nodeName: node === null ? '' : String(node.canonical_name),
      templateId: mapping.template_id === null ? null : String(mapping.template_id),
      mappingRevision: String(mapping.mapping_revision),
    })
  }

  const anchorFacts = loadAnchorFacts(db, String(attempt.user_id))
  const evaluated = delivered ?? submittedAt
  const familyId = question?.family_id === null || question?.family_id === undefined ? null : String(question.family_id)
  const family = familyId === null ? null : findOne(db, 'question_bank_family', { id: familyId })

  const latestPerNode = new Map<string, { templateId: string | null; qualifies: boolean }>()
  for (const mapping of mappings) {
    const others = findRows(db, 'practice_learning_evidence', {
      user_id: attempt.user_id,
      project_id: attempt.project_id,
      knowledge_node_id: mapping.nodeId,
      dimension: 'independent_correct',
      qualifies: true,
    }).filter((row) => String(row.attempt_id) !== String(attempt.id))
    const sameTemplate = others.some((row) => {
      const detail = (row.detail ?? {}) as Record<string, unknown>
      return mapping.templateId !== null && String(detail.template_id) === String(mapping.templateId)
    })
    latestPerNode.set(mapping.nodeId, { templateId: mapping.templateId, qualifies: sameTemplate })
  }

  return {
    elapsedMs: Number(attempt.elapsed_ms),
    firstDeliveredAt: delivered,
    submittedAt,
    // The item froze the answer version; trust is re-checked by the caller before grading.
    answerKeyUsable: Boolean(
      item.answer_key_version_id === null
        ? false
        : findOne(db, 'question_bank_answer_key_version', { id: item.answer_key_version_id })?.verification_status ===
            'checked',
    ),
    session: { mode: String(session.mode), status: String(session.status) },
    purpose: String(item.purpose),
    grade: gradeFactsOf(grade),
    mappings,
    assistance: {
      answerRevealingKinds: exposures.filter((row) => row.reveals_answer === true).map((row) => String(row.kind)),
      hintBeforeSubmit: exposures.some((row) =>
        ['hint_delivered', 'answer_delivered', 'explanation_delivered'].includes(String(row.kind)),
      ),
    },
    contamination,
    sameTemplateOtherQuestion: [...latestPerNode.values()].some((value) => value.qualifies),
    familyId,
    familyRelationConfirmed: family === null ? false : Boolean(family.relation_confirmed),
    familyHasOtherQuestions:
      familyId === null
        ? false
        : findRows(db, 'question_bank_question', { family_id: familyId }).some(
            (row) => String(row.id) !== String(question?.id),
          ),
    anchor: null,
    // Python resolves the anchor per node inside the dimension loop; a question mapped to two nodes
    // can legitimately have two different anchors.
    anchorFor: (nodeId: string) => {
      const result = latestLearningAnchor(anchorFacts, {
        project_id: String(attempt.project_id),
        node_id: nodeId,
        before: iso(evaluated),
        exclude_attempt_id: String(attempt.id),
      })
      return result.anchor === null
        ? { at: null, source: result.source }
        : { at: parseInstant(result.anchor), source: result.source }
    },
    delayHours: 24,
  }
}

/** Persist the evidence rows for one attempt at its current grading revision. */
export function rebuildEvidenceForAttempt(
  db: DatabaseSync,
  attemptId: string,
  now: Instant,
): number {
  return transaction(db, () => {
    const attempt = findOne(db, 'practice_attempt', { id: attemptId })
    if (attempt === null) return 0
    const facts = buildAttemptFacts(db, attemptId)
    if (facts === null) return 0
    const revision = Number(attempt.grading_revision)
    const rows = computeDimensions(facts)

    for (const row of rows) {
      const payload = {
        attempt_id: attempt.id,
        session_item_id: attempt.session_item_id,
        user_id: attempt.user_id,
        project_id: attempt.project_id,
        grade_event_id: attempt.current_grade_event_id,
        grade_revision: revision,
        knowledge_node_id: row.nodeId,
        dimension: row.dimension,
        qualifies: row.qualifies,
        is_correct: row.isCorrect,
        score_fraction: row.scoreFraction,
        exclusion_reasons: row.exclusionReasons,
        rule_version: EVIDENCE_RULE_VERSION,
        computed_at: now,
        is_active: true,
        invalidated_at: null,
        invalidated_reason: '',
        detail: row.detail,
      }
      const existing = findRows(db, 'practice_learning_evidence', {
        attempt_id: attempt.id,
        dimension: row.dimension,
        knowledge_node_id: row.nodeId,
        grade_revision: revision,
      })
      if (existing.length === 0) insertRow(db, 'practice_learning_evidence', payload, { now })
      else updateRow(db, 'practice_learning_evidence', existing[0].id, payload, { now })
    }

    // Rows from another revision describe an older judgement: still visible, no longer counted.
    for (const stale of findRows(db, 'practice_learning_evidence', { attempt_id: attempt.id })) {
      if (Number(stale.grade_revision) !== revision) {
        updateRow(
          db,
          'practice_learning_evidence',
          stale.id,
          { is_active: false, invalidated_at: now, invalidated_reason: INVALIDATED_REASON },
          { now },
        )
      }
    }

    for (const nodeId of new Set(rows.map((row) => row.nodeId))) {
      refreshNodeState(db, String(attempt.user_id), String(attempt.project_id), nodeId, now)
    }
    return rows.length
  })
}

/**
 * Invalidate the evidence of every attempt that froze a now-disputed answer version.
 *
 * Port of `evidence.py::invalidate_for_answer_version`. Django filters
 * `attempt__session_item__answer_key_version_id=<id>, is_active=True` and updates those rows to
 * `is_active=False, invalidated_at=now, invalidated_reason='答案版本进入争议'`, returning the count.
 *
 * Two things are deliberately *not* done here, because the Django task
 * (`projection.rebuild_after_answer_change`) does not do them either: the evidence is not rebuilt and
 * the node states are not refreshed in the same step. The state refresh in Django comes from the
 * separate `learning.on_attempt_graded` / `regrade_effects` paths; doing it here would make the port
 * look "better" than the truth source and hide a real difference (recorded as a known boundary).
 */
export function invalidateEvidenceForAnswerVersion(
  db: DatabaseSync,
  answerKeyVersionId: string,
  now: Instant,
): number {
  return transaction(db, () => {
    const attemptIds = new Set<string>()
    for (const item of findRows(db, 'practice_session_item', { answer_key_version_id: answerKeyVersionId })) {
      for (const attempt of findRows(db, 'practice_attempt', { session_item_id: String(item.id) })) {
        attemptIds.add(String(attempt.id))
      }
    }
    let affected = 0
    for (const attemptId of attemptIds) {
      for (const row of findRows(db, 'practice_learning_evidence', { attempt_id: attemptId, is_active: true })) {
        updateRow(
          db,
          'practice_learning_evidence',
          row.id,
          {
            is_active: false,
            invalidated_at: now,
            invalidated_reason: ANSWER_DISPUTED_INVALIDATION_REASON,
          },
          { now },
        )
        affected += 1
      }
    }
    return affected
  })
}

/**
 * Rebuild the evidence of every attempt in a session and refresh the states it touches.
 *
 * Port of `state.py::refresh_session_states` (the consumer of `learning.on_session_finished`):
 * for each attempt it runs `rebuild_for_attempt` **then** `refresh_states_for_attempt`, and returns
 * the accumulated refresh count (not the number of attempts, and not the evidence row count).
 */
export function refreshSessionStates(db: DatabaseSync, sessionId: string, now: Instant): number {
  const attemptIds: string[] = []
  for (const item of findRows(db, 'practice_session_item', { session_id: sessionId })) {
    for (const attempt of findRows(db, 'practice_attempt', { session_item_id: String(item.id) })) {
      attemptIds.push(String(attempt.id))
    }
  }
  let total = 0
  for (const attemptId of attemptIds) {
    rebuildEvidenceForAttempt(db, attemptId, now)
    total += refreshStatesForAttempt(db, attemptId, now)
  }
  return total
}

function stateRowsOf(db: DatabaseSync, nodeId: string, userId: string, projectId: string): StateEvidenceRow[] {
  // Python filters `is_active=True, grade_revision__gt=0`: a superseded revision is history, not a
  // vote. Without both filters a regrade would keep counting the previous revision's qualified row
  // (and revision 0 evidence, which has no grade event behind it at all).
  const rows = findRows(db, 'practice_learning_evidence', {
    user_id: userId,
    project_id: projectId,
    knowledge_node_id: nodeId,
    is_active: true,
  }).filter((row) => Number(row.grade_revision) > 0)
  const out: StateEvidenceRow[] = []
  for (const row of rows) {
    const item = findOne(db, 'practice_session_item', { id: String(row.session_item_id) })
    const version = item === null ? null : findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
    const detail = (row.detail ?? {}) as Record<string, unknown>
    out.push({
      id: String(row.id),
      attemptId: String(row.attempt_id),
      dimension: String(row.dimension),
      qualifies: Boolean(row.qualifies),
      isCorrect: row.is_correct === null ? null : Boolean(row.is_correct),
      gradeEventId: row.grade_event_id === null ? null : String(row.grade_event_id),
      templateId: detail.template_id ?? null,
      questionId: version === null ? '' : String(version.question_id),
      computedAt: row.computed_at as Instant,
      exclusionReasons: (row.exclusion_reasons ?? []) as string[],
    })
  }
  return out
}

/** Recompute one node's projection from its active evidence rows. */
export function refreshNodeState(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  nodeId: string,
  now: Instant,
): void {
  const node = findOne(db, 'knowledge_node', { id: nodeId })
  if (node === null) return
  const existing = findOne(db, 'learning_knowledge_state', {
    user_id: userId,
    project_id: projectId,
    syllabus_version_id: node.syllabus_version_id,
    node_id: nodeId,
  })
  const projection = projectNodeState({
    rows: stateRowsOf(db, nodeId, userId, projectId),
    previous: {
      summary: (existing?.summary ?? 'undiagnosed') as Summary,
      bestSummary: (existing?.best_summary ?? 'undiagnosed') as Summary,
    },
    now,
  })
  const payload = {
    user_id: userId,
    project_id: projectId,
    syllabus_version_id: node.syllabus_version_id,
    node_id: nodeId,
    summary: projection.summary,
    best_summary: projection.best_summary,
    independent_correct_count: projection.independent_correct_count,
    distinct_question_count: projection.distinct_question_count,
    distinct_template_count: projection.distinct_template_count,
    has_delayed_correct: projection.has_delayed_correct,
    recent_independent_attempts: projection.recent_independent_attempts,
    recent_independent_failures: projection.recent_independent_failures,
    needs_review: projection.needs_review,
    downgrade_reason: projection.downgrade_reason,
    rule_version: projection.rule_version,
    as_of: now,
    detail: projection.detail,
    source_evidence_ids: projection.source_evidence_ids,
    projection_version: 1,
  }
  if (existing === null) insertRow(db, 'learning_knowledge_state', payload, { now })
  else updateRow(db, 'learning_knowledge_state', existing.id, payload, { now })
}

/**
 * Refresh every knowledge node touched by one attempt (`refresh_states_for_attempt`).
 *
 * The regrade path calls this once per affected attempt after the writes, *not* once per evidence
 * row: refreshing per row would apply the projection repeatedly and is exactly the double-apply
 * the Python service's docstring warns about.
 */
export function refreshStatesForAttempt(db: DatabaseSync, attemptId: string, now: Instant): number {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null) return 0
  const nodeIds = new Set<string>()
  for (const row of findRows(db, 'practice_learning_evidence', { attempt_id: attemptId, is_active: true })) {
    if (row.knowledge_node_id !== null && row.knowledge_node_id !== undefined) {
      nodeIds.add(String(row.knowledge_node_id))
    }
  }
  for (const nodeId of nodeIds) {
    refreshNodeState(db, String(attempt.user_id), String(attempt.project_id), nodeId, now)
  }
  return nodeIds.size
}
