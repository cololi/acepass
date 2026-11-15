/**
 * Read paths for learning: evidence, knowledge state, mistakes — and the verification content gate.
 *
 * Port of `backend/apps/learning/services/evidence.py` and the read half of `state.py`.
 *
 * The gate in `verificationContentMap` is the reason this module exists as its own layer. While a
 * verification is running, the learner must not be able to read the answer through *any* projection —
 * not the attempt, not the evidence row, not a report. The map is content-scoped rather than
 * item-scoped: a near-duplicate or a second version of the same question is covered too, otherwise
 * "practise the twin question" would leak the check.
 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { Decimal } from '../domain/decimal.ts'
import { findOne, findRows } from '../store/repository.ts'
import { PurposeNotAllowed, ScopeViolation } from './errors.ts'
import { requireProject, requireSubject } from './exams.ts'
import { expireSessionIfDue } from './sessions.ts'

const EVIDENCE_RULE_VERSION = 'p2-c04'

/**
 * `question_version_id → ids of the active verification items covering it`.
 *
 * The values are item ids, not a boolean: a verification item has to be allowed to cover *itself*, or
 * the run would hide its own questions from the person taking it.
 */
export function verificationContentMap(db: DatabaseSync, userId: string): Map<string, Set<string>> {
  const covering = new Map<string, Set<string>>()
  const activeSessions = findRows(db, 'practice_session', { user_id: userId }).filter(
    (session) =>
      session.status === 'active' && (session.mode === 'verification' || session.mode === 'mock_exam'),
  )
  for (const session of activeSessions) {
    for (const item of findRows(db, 'practice_session_item', { session_id: session.id })) {
      // Only a *presented* item can have leaked an answer. Django's `_active_verification_items`
      // filters `first_delivered_at__isnull=False`, so an item created but never shown must not
      // hide its content from reports or evidence.
      if (item.first_delivered_at === null || item.first_delivered_at === undefined) continue
      const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
      if (version === null) continue
      const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
      if (question === null) continue
      const related = findRows(db, 'question_bank_question_version', {}).filter((candidate) => {
        if (String(candidate.question_id) === String(question.id)) return true
        const other = findOne(db, 'question_bank_question', { id: String(candidate.question_id) })
        if (other === null) return false
        if (question.family_id !== null && question.family_id !== undefined) {
          if (String(other.family_id) === String(question.family_id)) return true
        }
        if (question.content_lineage_id !== null && question.content_lineage_id !== undefined) {
          if (String(other.content_lineage_id) === String(question.content_lineage_id)) return true
        }
        return false
      })
      for (const candidate of related) {
        const key = String(candidate.id)
        const bucket = covering.get(key) ?? new Set<string>()
        bucket.add(String(item.id))
        covering.set(key, bucket)
      }
    }
  }
  return covering
}

export interface EvidenceRow {
  id: string
  attempt_id: string
  node_id: string | null
  node_name: string | null
  dimension: string
  qualifies: boolean
  is_correct: boolean | null
  score_fraction: string | null
  exclusion_reasons: string[]
  computed_at: string
  grade_revision: number
  question_id: string | null
  question_label: string
}

function attemptOf(db: DatabaseSync, attemptId: string): {
  itemId: string
  sessionId: string
  questionVersionId: string
} | null {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null) return null
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) return null
  return {
    itemId: String(item.id),
    sessionId: String(item.session_id),
    questionVersionId: String(item.question_version_id),
  }
}

/** Active evidence rows, newest first, with the verification door closed. */
export function evidenceSummaryRows(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: {
    nodeId?: string | null
    subjectId?: string | null
    dimension?: string | null
    limit?: number
  } = {},
): EvidenceRow[] {
  const contentMap = verificationContentMap(db, userId)
  const rows: EvidenceRow[] = []
  const limit = options.limit ?? 100
  const evidence = findRows(db, 'practice_learning_evidence', { user_id: userId, project_id: projectId })
    .filter((row) => row.is_active === true)
    .sort((a, b) => Number(b.computed_at) - Number(a.computed_at))

  for (const row of evidence) {
    if (rows.length >= limit) break
    if (options.nodeId !== null && options.nodeId !== undefined && String(row.knowledge_node_id) !== options.nodeId) {
      continue
    }
    if (options.dimension !== null && options.dimension !== undefined && String(row.dimension) !== options.dimension) {
      continue
    }
    const attempt = attemptOf(db, String(row.attempt_id))
    if (attempt === null) continue
    const session = findOne(db, 'practice_session', { id: attempt.sessionId })
    if (session === null) continue
    if (options.subjectId !== null && options.subjectId !== undefined) {
      const version = findOne(db, 'question_bank_question_version', { id: attempt.questionVersionId })
      const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
      if (question === null || String(question.subject_id) !== options.subjectId) continue
    }
    // A running verification hides its own content from every projection — except its own items.
    const coverers = contentMap.get(attempt.questionVersionId)
    if (coverers !== undefined && !coverers.has(attempt.itemId)) continue

    const version = findOne(db, 'question_bank_question_version', { id: attempt.questionVersionId })
    const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
    const node = row.knowledge_node_id === null ? null : findOne(db, 'knowledge_node', { id: String(row.knowledge_node_id) })
    rows.push({
      id: String(row.id),
      attempt_id: String(row.attempt_id),
      node_id: row.knowledge_node_id === null ? null : String(row.knowledge_node_id),
      node_name: node === null ? null : String(node.canonical_name),
      dimension: String(row.dimension),
      qualifies: Boolean(row.qualifies),
      is_correct: row.is_correct === null ? null : Boolean(row.is_correct),
      score_fraction: row.score_fraction === null ? null : String(row.score_fraction),
      exclusion_reasons: (row.exclusion_reasons ?? []) as string[],
      // Django serialises `computed_at.isoformat()`; a raw microsecond integer leaks the storage
      // representation to the client (the knowledge page history column).
      computed_at: formatPythonIso(row.computed_at as Instant),
      grade_revision: Number(row.grade_revision),
      question_id: question === null ? null : String(question.id),
      question_label: question === null ? '' : String(question.display_label),
    })
  }
  return rows
}

export interface StateRow {
  node_id: string
  node_name: string
  syllabus_version_id: string
  summary: string
  best_summary: string
  independent_correct_count: number
  distinct_question_count: number
  distinct_template_count: number
  has_delayed_correct: boolean
  recent_independent_attempts: number
  recent_independent_failures: number
  needs_review: boolean
  downgrade_reason: string
  detail: Record<string, unknown>
  as_of: string
  evidence: EvidenceRow[]
}

export const STATE_THRESHOLDS = {
  distinct_questions: 2,
  distinct_templates: 2,
  recent_window: 10,
} as const

/** Knowledge states with the evidence that produced them, and what is still missing. */
export function listStates(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null } = {},
): { thresholds: typeof STATE_THRESHOLDS; rule_version: string; states: StateRow[] } {
  requireProject(db, userId, projectId)
  if (options.subjectId !== null && options.subjectId !== undefined) {
    requireSubject(db, userId, projectId, options.subjectId)
  }
  const evidence = evidenceSummaryRows(db, userId, projectId, { subjectId: options.subjectId, limit: 200 })
  const byNode = new Map<string, EvidenceRow[]>()
  for (const row of evidence) {
    if (row.node_id === null) continue
    byNode.set(row.node_id, [...(byNode.get(row.node_id) ?? []), row])
  }
  const states = findRows(db, 'learning_knowledge_state', { user_id: userId, project_id: projectId }).map((row) => {
    const node = findOne(db, 'knowledge_node', { id: String(row.node_id) })
    const syllabus = findOne(db, 'exams_syllabus_version', { id: String(row.syllabus_version_id) })
    const detail = (row.detail ?? {}) as Record<string, unknown>
    const selection = byNode.get(String(row.node_id)) ?? []
    return {
      node_id: String(row.node_id),
      node_name: node === null ? '' : String(node.canonical_name),
      // `state.py::states_for_project` also publishes the owning subject and whether the syllabus
      // is the learner's own draft; the client reads both when grouping the map.
      subject_id: syllabus === null ? '' : String(syllabus.subject_id),
      syllabus_version_id: String(row.syllabus_version_id),
      syllabus_is_user_provisional: syllabus !== null && Boolean(syllabus.is_user_provisional),
      summary: String(row.summary),
      best_summary: String(row.best_summary),
      independent_correct_count: Number(row.independent_correct_count),
      distinct_question_count: Number(row.distinct_question_count),
      distinct_template_count: Number(row.distinct_template_count),
      has_delayed_correct: Boolean(row.has_delayed_correct),
      recent_independent_attempts: Number(row.recent_independent_attempts),
      recent_independent_failures: Number(row.recent_independent_failures),
      needs_review: Boolean(row.needs_review),
      downgrade_reason: String(row.downgrade_reason),
      // Django returns these three as top-level fields (read out of `detail`); the browser page
      // reads `missing_evidence` directly, and an absent field crashed the detail panel as soon as
      // the worker produced the first real state (B10 F6).
      missing_evidence: Array.isArray(detail.missing_evidence) ? detail.missing_evidence : [],
      independent_attempts: Array.isArray(detail.independent_attempts) ? detail.independent_attempts : [],
      thresholds: (detail.thresholds ?? STATE_THRESHOLDS) as Record<string, number>,
      rule_version: String(row.rule_version ?? ''),
      detail,
      as_of: formatPythonIso(row.as_of as Instant),
      evidence: selection,
    }
  })
  return { thresholds: STATE_THRESHOLDS, rule_version: EVIDENCE_RULE_VERSION, states }
}

export interface MistakeRow {
  attempt_id: string
  question_id: string
  question_label: string
  node_ids: string[]
  node_names: string[]
  confirmed_score: string
  max_score: string
  submitted_at: string
  exclusion_reasons: string[]
}

/** Confirmed lost marks: fully graded attempts that did not reach full marks. */
export function listMistakes(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null; limit?: number } = {},
): { rule_version: string; rows: MistakeRow[]; count: number } {
  requireProject(db, userId, projectId)
  const limit = options.limit ?? 100
  const contentMap = verificationContentMap(db, userId)
  const rows: MistakeRow[] = []

  for (const attempt of findRows(db, 'practice_attempt', { user_id: userId, project_id: projectId })) {
    if (rows.length >= limit) break
    const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
    if (item === null) continue
    const session = findOne(db, 'practice_session', { id: String(item.session_id) })
    if (session === null) continue
    // A running verification hides its own content, exactly like the evidence projection.
    const coverers = contentMap.get(String(item.question_version_id))
    if (coverers !== undefined && !coverers.has(String(item.id))) continue

    const grade =
      attempt.current_grade_event_id === null
        ? null
        : findOne(db, 'practice_grade_event', { id: attempt.current_grade_event_id })
    if (grade === null) continue
    // Only a fully confirmed grade can be a "lost mark": a pending review is not yet a mistake.
    if (grade.is_fully_confirmed !== true) continue
    const confirmed = Number(grade.confirmed_score ?? 0)
    const maxScore = Number(grade.max_score ?? 0)
    if (!(confirmed < maxScore)) continue

    const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
    const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
    if (options.subjectId !== null && options.subjectId !== undefined) {
      if (question === null || String(question.subject_id) !== options.subjectId) continue
    }
    const nodeIds = version === null
      ? []
      : findRows(db, 'knowledge_question_mapping', { question_version_id: String(version.id) }).map((mapping) =>
          String(mapping.node_id),
        )
    const nodeNames = nodeIds.map((nodeId) => {
      const node = findOne(db, 'knowledge_node', { id: nodeId })
      return node === null ? '' : String(node.canonical_name)
    })
    const evidence = findRows(db, 'practice_learning_evidence', { attempt_id: String(attempt.id) })
    rows.push({
      attempt_id: String(attempt.id),
      question_id: question === null ? '' : String(question.id),
      question_label: question === null ? '' : String(question.display_label),
      node_ids: nodeIds,
      node_names: nodeNames,
      confirmed_score: String(grade.confirmed_score),
      max_score: String(grade.max_score),
      submitted_at: String(attempt.submitted_at),
      exclusion_reasons: evidence
        .flatMap((row) => (row.exclusion_reasons ?? []) as string[])
        .filter((reason, index, all) => all.indexOf(reason) === index),
    })
  }
  return { rule_version: EVIDENCE_RULE_VERSION, rows, count: rows.length }
}

/** One attempt with its grade, for the attempt detail page. */
/**
 * Whether one session item's grading must be withheld *right now*.
 *
 * The single decision shared by the session snapshot and the submit response: the session hides its
 * own grading (running verification / timed exam), or another running verification covers the same
 * content. A replay after a verification opened must answer a receipt instead of the score it
 * returned the first time (R-INV 2); idempotency never grants a permanent right to read.
 */
export function deliveryHiddenForItem(db: DatabaseSync, userId: string, itemId: string): boolean {
  const item = findOne(db, 'practice_session_item', { id: itemId })
  if (item === null) return false
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null) return false
  if ((session.mode === 'verification' || session.mode === 'mock_exam') && session.status === 'active') return true
  const covering = verificationContentMap(db, userId).get(String(item.question_version_id))
  return covering !== undefined && [...covering].some((id) => id !== String(item.id))
}

/**
 * `verification_gate.assert_grading_not_blocked`: a score-shaped read while another run covers the
 * content is the same disclosure as answering it.
 *
 * An item of the gated run itself is exempt (`allow_self`), otherwise the verification could not
 * read its own item back; the exemption is per item, never per question.
 */
export function assertGradingNotBlocked(
  db: DatabaseSync,
  userId: string,
  item: Record<string, unknown>,
): void {
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null) return
  const hidesItself =
    (session.mode === 'verification' || session.mode === 'mock_exam') && session.status === 'active'
  if (hidesItself) return
  const covering = verificationContentMap(db, userId).get(String(item.question_version_id))
  if (covering === undefined) return
  const blocker = [...covering].find((id) => id !== String(item.id))
  if (blocker === undefined) return
  const blockerItem = findOne(db, 'practice_session_item', { id: blocker })
  const blockerSession = blockerItem === null ? null : findOne(db, 'practice_session', { id: String(blockerItem.session_id) })
  const label = blockerSession?.mode === 'mock_exam' ? '模拟考试' : '验证'
  throw new PurposeNotAllowed(
    `该内容正在${label}中（会话 ${String(blockerSession?.id ?? '')}）：为避免泄露答案，${label}结束前不能读取此题的有效评分。`,
    {
      details: {
        reason: 'active_verification_content_gate',
        gated_mode: blockerSession?.mode ?? null,
        verification_session_id: blockerSession === null ? null : String(blockerSession.id),
        verification_session_item_id: blocker,
      },
    },
  )
}

/**
 * `verification_gate.assert_item_not_in_active_verification`.
 *
 * Used by reveal: the same content may be inside a *different* running verification (another tab,
 * another project, a second session), and that run's integrity does not depend on which endpoint
 * asks. `allowSelf` mirrors Django's parameter: a verification item must be allowed to act on itself.
 */
export function assertItemNotInActiveVerification(
  db: DatabaseSync,
  userId: string,
  item: Record<string, unknown>,
  action: string,
  allowSelf = false,
): void {
  const covering = verificationContentMap(db, userId).get(String(item.question_version_id))
  if (covering === undefined) return
  const blocker = [...covering].find((id) => allowSelf ? id !== String(item.id) : true)
  if (blocker === undefined) return
  const blockerItem = findOne(db, 'practice_session_item', { id: blocker })
  const blockerSession = blockerItem === null ? null : findOne(db, 'practice_session', { id: String(blockerItem.session_id) })
  const label = blockerSession?.mode === 'mock_exam' ? '模拟考试' : '验证'
  throw new PurposeNotAllowed(
    `该内容正在${label}中（会话 ${String(blockerSession?.id ?? '')}）：为避免泄露答案，${label}结束前不能${action}。如只想练习，请先结束那次${label}。`,
    {
      details: {
        reason: 'active_verification_content_gate',
        gated_mode: blockerSession?.mode ?? null,
        verification_session_id: blockerSession === null ? null : String(blockerSession.id),
        verification_session_item_id: blocker,
      },
    },
  )
}

/** `getAttempt`: the attempt detail the practice page rebuilds itself from after a reload. */
export function getAttempt(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  attemptId: string,
  now: Instant,
): Record<string, unknown> {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null || String(attempt.project_id) !== String(projectId) || String(attempt.user_id) !== String(userId)) {
    throw new ScopeViolation('作答不存在或不在当前权限范围')
  }
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  // C05: a read path touching an exam reconciles it first, then applies the content gate (B02).
  const reconciled = expireSessionIfDue(db, session, now)
  assertGradingNotBlocked(db, userId, item)
  const grade =
    attempt.current_grade_event_id === null
      ? null
      : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
  const hidden =
    (reconciled.mode === 'verification' || reconciled.mode === 'mock_exam') && reconciled.status === 'active'
  return {
    attempt_id: String(attempt.id),
    session_item_id: String(attempt.session_item_id),
    submitted_at: formatPythonIso(attempt.submitted_at as Instant),
    elapsed_ms: Number(attempt.elapsed_ms),
    raw_answer: attempt.raw_answer ?? {},
    steps: attempt.steps ?? [],
    attachments: attempt.attachments ?? [],
    confidence: attempt.confidence,
    grading_revision: Number(attempt.grading_revision),
    receipt_only: hidden,
    grade: hidden ? null : gradePayload(grade),
  }
}

/** One session with its items and whether each has been delivered / answered. */
/**
 * One session snapshot, exactly the shape Django's `SessionOut` publishes.
 *
 * This is the single serializer for "create session" and "read session": the POST returns it and the
 * GET returns it, so the two cannot drift (a previous port returned the raw row from POST, which the
 * client read as `session_id: undefined`).
 *
 * Two independent things hide grading, and both are applied on **every** delivery:
 *  * the session hides its own grading (a running verification or a timed mock exam);
 *  * the item's content is covered by *another* running verification (the content gate), so a
 *    parallel practice attempt cannot leak an answer the verification is about to ask for.
 * When either applies, the totals are `null` rather than a number, and each affected item's grade
 * payload is `null` as well.
 */
export function getSession(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  now: Instant,
): Record<string, unknown> {
  const session = findOne(db, 'practice_session', { id: sessionId })
  if (session === null || String(session.user_id) !== String(userId) || String(session.project_id) !== String(projectId)) {
    throw new ScopeViolation('会话不存在或不在当前权限范围')
  }
  const hidesGrading =
    (session.mode === 'verification' || session.mode === 'mock_exam') && session.status === 'active'
  const items = findRows(db, 'practice_session_item', { session_id: session.id }).sort(
    (a, b) => Number(a.ordinal) - Number(b.ordinal),
  )
  const contentMap = verificationContentMap(db, userId)
  const withheldItemIds: string[] = []
  let confirmed = Decimal.zero()
  let pending = Decimal.zero()
  const payloadItems = items.map((item) => {
    const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
    const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
    const attempt = findOne(db, 'practice_attempt', { session_item_id: String(item.id) })
    const covering = contentMap.get(String(item.question_version_id))
    const withheld =
      covering !== undefined && [...covering].some((id) => id !== String(item.id))
    if (withheld) withheldItemIds.push(String(item.id))
    const rowHidden = hidesGrading || withheld
    const grade = attempt === null ? null : gradeEventOf(db, String(attempt.current_grade_event_id ?? ''))
    if (grade !== null) {
      if (grade.confirmed_score !== null && grade.confirmed_score !== undefined) {
        confirmed = confirmed.add(Decimal.parse(String(grade.confirmed_score)))
      }
      if (grade.pending_max_score !== null && grade.pending_max_score !== undefined) {
        pending = pending.add(Decimal.parse(String(grade.pending_max_score)))
      }
    }
    return {
      session_item_id: String(item.id),
      ordinal: Number(item.ordinal),
      question_id: question === null ? null : String(question.id),
      question_type: version === null ? null : String(version.question_type),
      display_label: question === null ? '' : String(question.display_label ?? ''),
      max_score: String(item.max_score),
      purpose: String(item.purpose),
      first_delivered_at: isoOf(item.first_delivered_at),
      draft_revision: Number(item.draft_revision),
      has_draft: item.draft !== null && typeof item.draft === 'object' && Object.keys(item.draft as object).length > 0,
      tutoring_allowed: Boolean(item.tutoring_allowed) && session.mode === 'practice',
      attempt_id: attempt === null ? null : String(attempt.id),
      can_reveal: !rowHidden,
      grading_withheld: withheld,
      attempt:
        attempt === null
          ? null
          : {
              attempt_id: String(attempt.id),
              submitted_at: formatPythonIso(attempt.submitted_at as Instant),
              elapsed_ms: Number(attempt.elapsed_ms),
              grading_revision: Number(attempt.grading_revision),
              grade: rowHidden ? null : gradePayload(grade),
              receipt_only: rowHidden,
            },
    }
  })
  const totalsHidden = hidesGrading || withheldItemIds.length > 0
  const hiddenReason = hidesGrading
    ? session.mode === 'mock_exam'
      ? '模拟考试进行中：交卷或到达服务器截止时间后才会显示分数与正误。'
      : '验证进行中：结束本次验证后才会显示分数与正误。'
    : withheldItemIds.length > 0
      ? '该会话包含正在验证/模拟考试中的同源内容：为避免泄露答案，该会话结束前不显示本会话的分数。无关会话不受影响。'
      : null
  return {
    session_id: String(session.id),
    project_id: String(session.project_id),
    subject_id: String(session.subject_id),
    mode: String(session.mode),
    status: String(session.status),
    policy_version: String(session.policy_version ?? ''),
    grading_hidden: hidesGrading,
    revealed_at: isoOf(session.revealed_at),
    created_at: formatPythonIso(session.created_at as Instant),
    finished_at: isoOf(session.finished_at),
    server_time: formatPythonIso(now),
    exam_started_at:
      session.exam_started_at === null || session.exam_started_at === undefined ? null : String(session.exam_started_at),
    exam_deadline:
      session.exam_deadline === null || session.exam_deadline === undefined ? null : String(session.exam_deadline),
    expired_at: isoOf(session.expired_at),
    items: payloadItems,
    confirmed_score: totalsHidden ? null : confirmed.toString(),
    pending_max_score: totalsHidden ? null : pending.toString(),
    score_visible: !totalsHidden,
    score_hidden_reason: hiddenReason,
    grading_withheld_session_item_ids: withheldItemIds,
  }
}

/** An optional stored instant → Django's ISO text (or null). */
function isoOf(value: unknown): string | null {
  return value === null || value === undefined ? null : formatPythonIso(value as Instant)
}

/** The current grade event of one attempt, or null. */
export function gradeEventOf(db: DatabaseSync, gradeEventId: string): Record<string, unknown> | null {
  if (gradeEventId === '') return null
  return findOne(db, 'practice_grade_event', { id: gradeEventId })
}

/** Django's `grade_payload`: the fields a client reads, with decimals as strings. */
export function gradePayload(grade: Record<string, unknown> | null): Record<string, unknown> | null {
  if (grade === null) return null
  const confirmedScore = grade.confirmed_score
  const maxScore = grade.max_score
  return {
    grade_event_id: String(grade.id),
    status: String(grade.status),
    method: String(grade.method),
    grading_revision: Number(grade.grading_revision),
    confirmed_score: confirmedScore === null || confirmedScore === undefined ? null : String(confirmedScore),
    max_score: maxScore === null || maxScore === undefined ? null : String(maxScore),
    pending_max_score:
      grade.pending_max_score === null || grade.pending_max_score === undefined
        ? null
        : String(grade.pending_max_score),
    estimated_score:
      grade.estimated_score === null || grade.estimated_score === undefined ? null : String(grade.estimated_score),
    is_fully_confirmed: Boolean(grade.is_fully_confirmed),
    is_correct:
      Boolean(grade.is_fully_confirmed) &&
      confirmedScore !== null &&
      confirmedScore !== undefined &&
      maxScore !== null &&
      maxScore !== undefined &&
      Decimal.parse(String(maxScore)).gt(Decimal.zero()) &&
      Decimal.parse(String(confirmedScore)).ge(Decimal.parse(String(maxScore))),
    parts: grade.parts ?? [],
    rule_version: grade.rule_version,
    rule_snapshot: grade.rule_snapshot ?? {},
    grader_is_self: Boolean(grade.grader_is_self),
    comment: grade.comment,
    superseded: Boolean(grade.is_superseded),
  }
}
