/**
 * Learning-session engine (docs/26 §6).
 *
 * A session is a deterministic sequence of steps built from real facts:
 * due knowledge-point memories (FSRS), exam-frequency value, ability states and
 * eligible questions. The engine stores what the learner actually did and never
 * invents a score: practice grading stays in the practice service, recall writes
 * a memory event, and the model coach only ever produces validated dialogue.
 *
 * Plans are built once at creation; a wrong practice answer appends repair steps
 * (minimal explanation + one retest) instead of rewriting the plan. Every step
 * carries `reason_codes` so the UI can explain why it is there.
 */
import type { DatabaseSync } from 'node:sqlite'

import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import { coverageFromPoints, evaluateRecall, isSpaced, recallOutcome, sessionScore, type KeyPoint, type RecallRating } from '../domain/recall.ts'
import { desiredRetentionForValue } from '../domain/knowledge_value.ts'
import { eligibility, questionMinutes } from './planner.ts'
import { createSession as createPracticeSession, finishSession, presentItem } from './sessions.ts'
import { submitAttempt } from './practice.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { getStudySettings } from './accounts.ts'
import { gradePayload } from './learning.ts'
import { requireProject, requireSubject } from './exams.ts'
import * as cards from './node_cards.ts'
import * as nodeMemory from './node_memory.ts'
import * as frequency from './node_frequency.ts'
import { runCoachTurn } from './coach.ts'
import { isSealed, reasonMessage } from './sealing.ts'
import { verificationContentMap } from './learning.ts'
import type { LlmPort } from '../llm/contract.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation } from './errors.ts'
import {
  STUDY_RULE_VERSION,
  type CoachTurnOut,
  type FrequencyProfile,
  type NodeCardOut,
  type NodeMemoryOut,
  type RecallCoverage,
  type RecallEventOut,
  type SessionModeName,
  type SessionOut,
  type SessionStageName,
  type SessionStepKindName,
  type SessionStepOut,
  type StudyDeskOut,
} from './study_contract.ts'

/* ------------------------------------------------------------------ constants */

const PENDING = 'pending'
const ACTIVE = 'active'
const SUBMITTED = 'submitted'
const COMPLETED = 'completed'
const SKIPPED = 'skipped'
const EXPIRED = 'expired'
const SESSION_PLANNED = 'planned'
const SESSION_ACTIVE = 'active'
const SESSION_COMPLETED = 'completed'
const SESSION_ABANDONED = 'abandoned'
const SESSION_EXPIRED = 'expired'
const STEP_KINDS = ['recall', 'encode_read', 'self_explain', 'practice', 'repair_brief', 'repair_retest', 'transfer'] as const
const SESSION_MODES = ['daily', 'new_learn', 'repair', 'exam_prep', 'quick_recall'] as const
const RATINGS: RecallRating[] = ['again', 'hard', 'good', 'easy']
const PRACTICE_MODES = new Set(['daily', 'new_learn', 'exam_prep'])
const WARMUP_PER_STEP_MINUTES = 2

export interface SessionDeps {
  /** The model port for the coach; absent means "no model, deterministic fallbacks". */
  port?: LlmPort
}

function parseMode(value: unknown): SessionModeName {
  const mode = String(value ?? 'daily')
  if (!(SESSION_MODES as readonly string[]).includes(mode)) {
    throw new InvalidInput('未知的学习会话模式', { details: { allowed: [...SESSION_MODES] } })
  }
  return mode as SessionModeName
}

function mandatoryBudget(mode: SessionModeName, dailyBudget: number): number {
  const base =
    mode === 'quick_recall'
      ? 6
      : mode === 'repair'
        ? 15
        : mode === 'new_learn'
          ? 20
          : mode === 'exam_prep'
            ? Math.min(45, Math.max(10, Math.round(dailyBudget * 0.9)))
            : Math.max(5, Math.min(45, Math.round(dailyBudget * 0.6)))
  return Math.max(5, Math.min(90, Math.floor(base)))
}

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : formatPythonIso(value as Instant)
}

/* ------------------------------------------------------------------ payloads */

function stepOut(db: DatabaseSync, step: Record<string, unknown>): SessionStepOut {
  const nodeId = step.node_id === null || step.node_id === undefined ? null : String(step.node_id)
  const node = nodeId === null ? null : findOne(db, 'knowledge_node', { id: nodeId })
  const questionId = step.question_id === null || step.question_id === undefined ? null : String(step.question_id)
  const question = questionId === null ? null : findOne(db, 'question_bank_question', { id: questionId })
  return {
    ordinal: Number(step.ordinal),
    stage: String(step.stage) as SessionStageName,
    kind: String(step.kind) as SessionStepKindName,
    status: String(step.status),
    node_id: nodeId,
    node_name: node === null ? '' : String(node.canonical_name ?? ''),
    question_id: questionId,
    question_label: question === null ? '' : String(question.display_label ?? ''),
    session_item_id: step.session_item_id === null || step.session_item_id === undefined ? null : String(step.session_item_id),
    estimated_minutes: Number(step.estimated_minutes ?? 1),
    hint_level: Number(step.hint_level ?? 0),
    confidence_before: step.confidence_before === null || step.confidence_before === undefined ? null : Number(step.confidence_before),
    outcome: String(step.outcome ?? 'unknown'),
    reason_codes: Array.isArray(step.reason_codes) ? (step.reason_codes as string[]) : [],
    deadline_at: iso(step.deadline_at),
    started_at: iso(step.started_at),
    finished_at: iso(step.finished_at),
    payload: (step.payload ?? {}) as Record<string, unknown>,
  }
}

function sessionSteps(db: DatabaseSync, sessionId: string): Record<string, unknown>[] {
  return findRows(db, 'learning_session_step', { session_id: sessionId }, { orderBy: [['ordinal', 'asc']] })
}

function sessionPayload(db: DatabaseSync, session: Record<string, unknown>): SessionOut {
  const steps = sessionSteps(db, String(session.id)).map((step) => stepOut(db, step))
  const current = steps.find((step) => step.status === PENDING || step.status === ACTIVE) ?? null
  return {
    session_id: String(session.id),
    project_id: String(session.project_id),
    subject_id: String(session.subject_id),
    mode: String(session.mode) as SessionModeName,
    status: String(session.status),
    stage: String(session.stage) as SessionStageName,
    budget_minutes: Number(session.budget_minutes ?? 0),
    estimated_minutes: Number(session.estimated_minutes ?? 0),
    practice_session_id:
      session.practice_session_id === null || session.practice_session_id === undefined
        ? null
        : String(session.practice_session_id),
    started_at: iso(session.started_at),
    finished_at: iso(session.finished_at),
    steps,
    current_step_ordinal: current === null ? null : current.ordinal,
    notes: Array.isArray(session.notes) ? (session.notes as string[]) : [],
    summary: (session.summary ?? {}) as Record<string, unknown>,
  }
}

function sessionOr404(db: DatabaseSync, userId: string, projectId: string, sessionId: string): Record<string, unknown> {
  const session = findOne(db, 'learning_interaction_session', { id: sessionId })
  if (
    session === null ||
    String(session.user_id) !== userId ||
    String(session.project_id) !== projectId
  ) {
    throw new ScopeViolation('学习会话不存在或不在当前权限范围')
  }
  return session
}

function stepOr404(db: DatabaseSync, sessionId: string, ordinal: number): Record<string, unknown> {
  const step = findRows(db, 'learning_session_step', { session_id: sessionId, ordinal }).at(0)
  if (step === undefined) throw new ScopeViolation('学习步骤不存在或不在当前权限范围')
  return step
}

function nodeForStep(db: DatabaseSync, step: Record<string, unknown>) {
  const nodeId = step.node_id === null || step.node_id === undefined ? null : String(step.node_id)
  if (nodeId === null) return null
  return findOne(db, 'knowledge_node', { id: nodeId })
}

/* ------------------------------------------------------------------ planning */

interface NodeCandidate {
  node_id: string
  node_name: string
  value_index: number | null
  status: string
  cycles_present: number
  counted_cycles: number
  ability_summary: string | null
  memory: NodeMemoryOut | null
  card: NodeCardOut | null
  retrievability: number | null
  due_at: string | null
  reason_codes: string[]
  score: number
}

function abilityByNode(db: DatabaseSync, projectId: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const row of findRows(db, 'learning_knowledge_state', { project_id: projectId })) {
    map.set(String(row.node_id), row)
  }
  return map
}

function retrievabilityOf(memory: NodeMemoryOut | null, now: Instant): number | null {
  if (memory === null || memory.last_recall_at === null) return null
  const stability = Number(memory.stability ?? 0)
  if (stability <= 0) return null
  const last = parseInstant(memory.last_recall_at)
  const elapsedDays = Math.max(0, Number(now - last) / 86_400_000_000)
  return Number((1 + ((19 / 81) * elapsedDays) / stability) ** -0.5)
}

function candidateForNode(
  db: DatabaseSync,
  projectId: string,
  node: Record<string, unknown>,
  planning: Map<string, { value_index: number | null; status: string; cycles_present: number; counted_cycles: number }>,
  abilities: Map<string, Record<string, unknown>>,
  memory: NodeMemoryOut | null,
  card: NodeCardOut | null,
  now: Instant,
  options: { novelty: boolean; consecutiveSameNode: boolean; prerequisiteUrgency?: number },
): NodeCandidate {
  const nodeId = String(node.id)
  const value = planning.get(nodeId) ?? { value_index: null, status: 'no_real_data', cycles_present: 0, counted_cycles: 0 }
  const ability = abilities.get(nodeId) ?? null
  const retrievability = retrievabilityOf(memory, now)
  const risk = retrievability === null ? 0 : 1 - retrievability
  const scored = sessionScore({
    valueIndex: value.value_index,
    forgettingRisk: risk,
    abilityGap: ability === null ? 1 : 0.8,
    prerequisiteUrgency: options.prerequisiteUrgency ?? 0,
    novelty: options.novelty,
    consecutiveSameNode: options.consecutiveSameNode,
  })
  return {
    node_id: nodeId,
    node_name: String(node.canonical_name ?? ''),
    value_index: value.value_index,
    status: value.status,
    cycles_present: value.cycles_present,
    counted_cycles: value.counted_cycles,
    ability_summary: ability === null ? null : String(ability.summary ?? ''),
    memory,
    card,
    retrievability,
    due_at: memory?.due_at ?? null,
    reason_codes: scored.reason_codes,
    score: scored.score,
  }
}

function subjectNodes(db: DatabaseSync, subjectId: string): Record<string, unknown>[] {
  const published = new Set(
    findRows(db, 'exams_syllabus_version', { subject_id: subjectId, status: 'published' }).map((row) => String(row.id)),
  )
  return findRows(db, 'knowledge_node', { is_unclassified: false })
    .filter((node) => published.has(String(node.syllabus_version_id)))
    .sort((left, right) => {
      const byOrder = Number(left.display_order) - Number(right.display_order)
      if (byOrder !== 0) return byOrder
      const leftName = String(left.canonical_name ?? '')
      const rightName = String(right.canonical_name ?? '')
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
    })
}

function usableQuestionForNode(db: DatabaseSync, projectId: string, nodeId: string): Record<string, unknown> | null {
  const pairings = findRows(db, 'knowledge_verification_pairing', { project_id: projectId, node_id: nodeId })
    .filter((row) => row.is_active === true)
    .sort((left, right) => Number(right.pairing_version) - Number(left.pairing_version))
  for (const pairing of pairings) {
    const candidate = findOne(db, 'question_bank_question', { id: String(pairing.immediate_question_id) })
    if (candidate !== null && isUsable(db, projectId, String(candidate.id))) return candidate
  }
  const versionIds = new Set(
    findRows(db, 'knowledge_question_mapping', { node_id: nodeId })
      .filter((mapping) => mapping.is_primary === true)
      .map((mapping) => String(mapping.question_version_id)),
  )
  for (const versionId of [...versionIds].sort()) {
    const version = findOne(db, 'question_bank_question_version', { id: versionId })
    if (version === null || String(version.status) !== 'published') continue
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
    if (question !== null && isUsable(db, projectId, String(question.id))) return question
  }
  return null
}

function isUsable(db: DatabaseSync, projectId: string, questionId: string): boolean {
  const question = findOne(db, 'question_bank_question', { id: questionId })
  if (question === null || question.is_demo === true) return false
  return eligibility(db, projectId, questionId).ok
}

function questionTypeOf(db: DatabaseSync, questionId: string): string {
  const versions = findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
    (left, right) => Number(right.version) - Number(left.version),
  )
  return versions.length === 0 ? '' : String(versions[0].question_type ?? '')
}

function persistedSteps(db: DatabaseSync, rows: Array<Record<string, unknown>>, now: Instant): void {
  for (const row of rows) insertRow(db, 'learning_session_step', row, { now })
}

/* ------------------------------------------------------------------- create */

export interface CreateInteractionSessionInput {
  subject_id: string
  mode?: string | null
  budget_minutes?: number | null
  plan_id?: string | null
}

export function createInteractionSession(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  input: CreateInteractionSessionInput,
  now: Instant,
): SessionOut {
  const project = requireProject(db, userId, projectId)
  if (project.is_archived === true) throw new InvalidInput('已归档项目不能新建学习会话')
  const subjectId = String(input.subject_id ?? '')
  if (subjectId === '') throw new InvalidInput('必须指定科目')
  const subject = requireSubject(db, userId, projectId, subjectId)
  const mode = parseMode(input.mode)
  const settings = getStudySettings(db, userId, now)
  const budget = input.budget_minutes === null || input.budget_minutes === undefined
    ? mandatoryBudget(mode, Number(settings.daily_budget_minutes))
    : Math.max(5, Math.min(120, Math.trunc(Number(input.budget_minutes))))

  const open = findRows(db, 'learning_interaction_session', {
    user_id: userId,
    project_id: projectId,
    subject_id: subjectId,
  }).find((row) => row.status === SESSION_PLANNED || row.status === SESSION_ACTIVE)
  if (open !== undefined) return sessionPayload(db, open)

  return transaction(db, () => {
    const syllabus = findRows(db, 'exams_syllabus_version', { subject_id: subjectId, status: 'published' }).sort(
      (left, right) => Number(right.version) - Number(left.version),
    )[0]
    const session = insertRow(
      db,
      'learning_interaction_session',
      {
        user_id: userId,
        project_id: projectId,
        subject_id: subjectId,
        syllabus_version_id: syllabus === undefined ? null : syllabus.id,
        mode,
        status: SESSION_PLANNED,
        stage: 'warmup',
        plan_id: input.plan_id ?? null,
        practice_session_id: null,
        budget_minutes: budget,
        estimated_minutes: 0,
        started_at: null,
        finished_at: null,
        summary: {},
        notes: [],
        rule_version: STUDY_RULE_VERSION,
      },
      { now },
    )
    const planned = planSteps(db, userId, projectId, subjectId, String(session.id), mode, budget, now)
    persistedSteps(db, planned.rows, now)
    let practiceSessionId: string | null = planned.practiceSessionId
    let practiceError: string | null = planned.practiceError
    if (planned.practiceRows.length > 0) {
      try {
        const created = createPracticeSession(
          db,
          userId,
          projectId,
          { subject_id: subjectId, mode: 'practice', question_ids: planned.questionIds, purpose: 'practice' },
          now,
        )
        practiceSessionId = String(created.id)
        const items = findRows(db, 'practice_session_item', { session_id: practiceSessionId }).sort(
          (left, right) => Number(left.ordinal) - Number(right.ordinal),
        )
        const byQuestion = new Map<string, string>()
        for (const item of items) {
          const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
          if (version !== null) byQuestion.set(String(version.question_id), String(item.id))
        }
        for (const row of planned.practiceRows) {
          const itemId = byQuestion.get(String(row.question_id))
          if (itemId === undefined) continue
          insertRow(
            db,
            'learning_session_step',
            {
              session_id: session.id,
              ordinal: row.ordinal,
              stage: row.stage,
              kind: row.kind,
              status: PENDING,
              node_id: row.node_id,
              question_id: row.question_id,
              session_item_id: itemId,
              estimated_minutes: row.estimated_minutes,
              hint_level: 0,
              confidence_before: null,
              outcome: 'unknown',
              payload: row.payload,
              reason_codes: row.reason_codes,
              deadline_at: row.deadline_at ?? null,
              started_at: null,
              finished_at: null,
              skipped_reason: '',
            },
            { now },
          )
        }
      } catch (error) {
        practiceError = error instanceof Error ? error.message : String(error)
      }
    }
    const estimated = planned.estimated_minutes + 2
    const notes = [...planned.notes]
    if (practiceError !== null) notes.push(`练习步骤未能创建：${practiceError}`)
    const updated = updateRow(
      db,
      'learning_interaction_session',
      session.id,
      { practice_session_id: practiceSessionId, estimated_minutes: estimated, notes },
      { now },
    )!
    return sessionPayload(db, updated)
  })
}

interface PlannedSteps {
  rows: Array<Record<string, unknown>>
  practiceRows: Array<Record<string, unknown>>
  questionIds: string[]
  practiceSessionId: string | null
  estimated_minutes: number
  notes: string[]
  practiceError: string | null
}

function planSteps(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string,
  sessionId: string,
  mode: SessionModeName,
  budget: number,
  now: Instant,
): PlannedSteps {
  const notes: string[] = []
  const rows: Array<Record<string, unknown>> = []
  const practiceRows: Array<Record<string, unknown>> = []
  const questionIds: string[] = []
  const nodes = subjectNodes(db, subjectId)
  const planning = frequency.planningValues(db, userId, projectId, subjectId)
  const abilities = abilityByNode(db, projectId)
  const memories = nodeMemory.memoryForNodes(
    db,
    userId,
    projectId,
    nodes.map((node) => String(node.id)),
    now,
  )
  const dueIds = [...memories.entries()].filter(([, memory]) => memory.is_due).map(([nodeId]) => nodeId)
  const dueSet = new Set(dueIds)
  let ordinal = 1

  // 1. Warm-up: due node memories, highest value x forgetting risk first.
  const warmupCandidates = nodes
    .filter((node) => dueSet.has(String(node.id)))
    .map((node) =>
      candidateForNode(db, projectId, node, planning, abilities, memories.get(String(node.id)) ?? null, null, now, {
        novelty: false,
        consecutiveSameNode: false,
      }),
    )
    .sort((left, right) => right.score - left.score)
  const warmupBudget = mode === 'quick_recall' ? budget : Math.max(0, Math.floor(budget * 0.3))
  const maxWarmup = Math.max(0, Math.min(6, Math.floor(warmupBudget / WARMUP_PER_STEP_MINUTES)))
  const warmup = warmupCandidates.slice(0, maxWarmup)
  for (const candidate of warmup) {
    const node = nodes.find((row) => String(row.id) === candidate.node_id)!
    rows.push({
      session_id: sessionId,
      ordinal: ordinal++,
      stage: 'warmup',
      kind: 'recall',
      status: PENDING,
      node_id: candidate.node_id,
      question_id: null,
      session_item_id: null,
      estimated_minutes: WARMUP_PER_STEP_MINUTES,
      hint_level: 0,
      confidence_before: null,
      outcome: 'unknown',
      payload: recallPayload(db, userId, projectId, node, candidate, 'warmup'),
      reason_codes: ['due_memory', ...candidate.reason_codes],
      deadline_at: null,
      started_at: null,
      finished_at: null,
      skipped_reason: '',
    })
  }
  if (warmup.length === 0) notes.push('今天没有到期的考点记忆：本次会话从编码或练习开始。')
  else if (warmupCandidates.length > warmup.length) {
    notes.push(`还有 ${warmupCandidates.length - warmup.length} 个到期考点未排入本次会话（预算只够 ${warmup.length} 个）。`)
  }

  // 2. Encode: high-value nodes with no memory state (or new), up to 2.
  if (mode !== 'quick_recall') {
    const encodeBudget = Math.max(0, Math.floor(budget * 0.3))
    const maxEncode = Math.max(0, Math.min(2, Math.floor(encodeBudget / 6)))
    const encodeCandidates = nodes
      .filter((node) => !memories.has(String(node.id)))
      .map((node) => {
        const card = cards.confirmedCard(db, userId, projectId, String(node.id))
        return candidateForNode(db, projectId, node, planning, abilities, null, card, now, {
          novelty: true,
          consecutiveSameNode: false,
        })
      })
      .filter((candidate) => candidate.card !== null || usableQuestionForNode(db, projectId, candidate.node_id) !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, maxEncode)
    for (const candidate of encodeCandidates) {
      const node = nodes.find((row) => String(row.id) === candidate.node_id)!
      const card = cards.confirmedCard(db, userId, projectId, candidate.node_id)
      rows.push({
        session_id: sessionId,
        ordinal: ordinal++,
        stage: 'encode',
        kind: 'encode_read',
        status: PENDING,
        node_id: candidate.node_id,
        question_id: null,
        session_item_id: null,
        estimated_minutes: 2,
        hint_level: 0,
        confidence_before: null,
        outcome: 'unknown',
        payload: {
          node_name: candidate.node_name,
          card,
          blocks: card === null ? [] : card.blocks,
          key_points: card === null ? [] : card.key_points,
          citations: card === null ? [] : card.citations,
          note:
            card === null
              ? '这个考点还没有已确认的内容卡：先按题目与解析回忆，记得在考点页补一张卡。'
              : '读完后进入立即回忆：不要回看卡片。',
        },
        reason_codes: ['new_knowledge_point', ...candidate.reason_codes],
        deadline_at: null,
        started_at: null,
        finished_at: null,
        skipped_reason: '',
      })
      rows.push({
        session_id: sessionId,
        ordinal: ordinal++,
        stage: 'encode',
        kind: 'recall',
        status: PENDING,
        node_id: candidate.node_id,
        question_id: null,
        session_item_id: null,
        estimated_minutes: 2,
        hint_level: 0,
        confidence_before: null,
        outcome: 'unknown',
        payload: recallPayload(db, userId, projectId, node, candidate, 'encode'),
        reason_codes: ['immediate_recall', ...candidate.reason_codes],
        deadline_at: null,
        started_at: null,
        finished_at: null,
        skipped_reason: '',
      })
      if (card !== null && card.key_points.length > 0) {
        rows.push({
          session_id: sessionId,
          ordinal: ordinal++,
          stage: 'encode',
          kind: 'self_explain',
          status: PENDING,
          node_id: candidate.node_id,
          question_id: null,
          session_item_id: null,
          estimated_minutes: 2,
          hint_level: 0,
          confidence_before: null,
          outcome: 'unknown',
          payload: recallPayload(db, userId, projectId, node, candidate, 'self_explain'),
          reason_codes: ['self_explain', ...candidate.reason_codes],
          deadline_at: null,
          started_at: null,
          finished_at: null,
          skipped_reason: '',
        })
      }
    }
    if (encodeCandidates.length === 0) notes.push('没有可编码的新考点（缺已确认的内容卡或可用题目）。')
  }

  // 3. Practice: fill the rest with eligible questions, interleaved by node.
  if (PRACTICE_MODES.has(mode) || mode === 'quick_recall') {
    const plannedMinutes = rows.reduce((total, row) => total + Number(row.estimated_minutes), 0)
    let remaining = Math.max(0, budget - plannedMinutes)
    const queue: NodeCandidate[] = nodes
      .map((node) => {
        const memory = memories.get(String(node.id)) ?? null
        const card = cards.confirmedCard(db, userId, projectId, String(node.id))
        return candidateForNode(db, projectId, node, planning, abilities, memory, card, now, {
          novelty: !memories.has(String(node.id)),
          consecutiveSameNode: false,
        })
      })
      .filter((candidate) => usableQuestionForNode(db, projectId, candidate.node_id) !== null)
      .sort((left, right) => right.score - left.score)
    let lastNode: string | null = rows.length === 0 ? null : String(rows[rows.length - 1].node_id ?? '')
    const usedQuestions = new Set<string>()
    for (const candidate of queue) {
      if (remaining <= 0) break
      if (practiceRows.length >= 8) break
      const question = usableQuestionForNode(db, projectId, candidate.node_id)
      if (question === null) continue
      const questionId = String(question.id)
      if (usedQuestions.has(questionId)) continue
      const minuteCost = questionMinutes(
        findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
          (left, right) => Number(right.version) - Number(left.version),
        )[0] ?? null,
      )
      if (minuteCost > remaining) continue
      usedQuestions.add(questionId)
      questionIds.push(questionId)
      const consecutive = lastNode === candidate.node_id
      const reason = [...candidate.reason_codes]
      if (consecutive) reason.push('interleave_penalty')
      practiceRows.push({
        ordinal: ordinal++,
        stage: 'practice',
        kind: 'practice',
        node_id: candidate.node_id,
        question_id: questionId,
        estimated_minutes: minuteCost,
        payload: {
          question_type: questionTypeOf(db, questionId),
          display_label: String(question.display_label ?? ''),
          hints_available: true,
        },
        reason_codes: reason,
        deadline_at: null,
      })
      lastNode = candidate.node_id
      remaining -= minuteCost
    }
    if (practiceRows.length === 0 && PRACTICE_MODES.has(mode)) {
      notes.push('没有可用的合格题目：练习阶段留空（缺已发布题目、已核对答案或题目被封存）。')
    }
    if (practiceRows.length === 8 && remaining > 0) {
      notes.push(`本次练习已达 8 题上限，仍有约 ${remaining} 分钟未安排。`)
    }
  }

  // 4. Transfer: one timed item for a node whose ability is already independent.
  const plannedMinutes = rows.reduce((total, row) => total + Number(row.estimated_minutes), 0) +
    practiceRows.reduce((total, row) => total + Number(row.estimated_minutes), 0)
  if (mode !== 'quick_recall' && mode !== 'repair' && budget - plannedMinutes >= 3) {
    const transferCandidate = nodes
      .map((node) =>
        candidateForNode(db, projectId, node, planning, abilities, memories.get(String(node.id)) ?? null, null, now, {
          novelty: false,
          consecutiveSameNode: true,
        }),
      )
      .filter((candidate) => {
        const ability = abilities.get(candidate.node_id)
        const summary = ability === undefined ? '' : String(ability.summary ?? '')
        return (summary === 'handles_unseen' || summary === 'delayed_verified') &&
          usableQuestionForNode(db, projectId, candidate.node_id) !== null
      })
      .sort((left, right) => right.score - left.score)[0]
    if (transferCandidate !== undefined) {
      const question = usableQuestionForNode(db, projectId, transferCandidate.node_id)
      if (question !== null && !questionIds.includes(String(question.id))) {
        questionIds.push(String(question.id))
        practiceRows.push({
          ordinal: ordinal++,
          stage: 'transfer',
          kind: 'transfer',
          node_id: transferCandidate.node_id,
          question_id: String(question.id),
          estimated_minutes: 3,
          payload: {
            question_type: questionTypeOf(db, String(question.id)),
            display_label: String(question.display_label ?? ''),
            hints_available: false,
            timed_seconds: 180,
          },
          reason_codes: ['transfer_check', ...transferCandidate.reason_codes],
          deadline_at: null,
        })
      }
    } else {
      notes.push('没有满足迁移条件的考点（需要已独立完成并存在另一道可用题）。')
    }
  }

  return {
    rows,
    practiceRows,
    questionIds,
    practiceSessionId: null,
    estimated_minutes:
      rows.reduce((total, row) => total + Number(row.estimated_minutes), 0) +
      practiceRows.reduce((total, row) => total + Number(row.estimated_minutes), 0),
    notes,
    practiceError: null,
  }
}

function recallPayload(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  node: Record<string, unknown>,
  candidate: NodeCandidate,
  mode: 'warmup' | 'encode' | 'self_explain',
): Record<string, unknown> {
  const card = cards.confirmedCard(db, userId, projectId, String(node.id))
  const keyPoints: KeyPoint[] = card === null ? [] : card.key_points.map((point) => ({ ...point }))
  if (mode === 'self_explain') {
    return {
      node_name: String(node.canonical_name ?? ''),
      prompt: `请用你自己的话解释「${String(node.canonical_name ?? '')}」：它解决什么问题？什么时候适用、什么时候不适用？`,
      key_points: keyPoints,
      card_confirmed: card !== null,
      kind: 'self_explain',
      value_index: candidate.value_index,
      appearances: candidate.cycles_present,
      counted_cycles: candidate.counted_cycles,
    }
  }
  return {
    node_name: String(node.canonical_name ?? ''),
    prompt:
      mode === 'encode'
        ? `合上讲义，回忆「${String(node.canonical_name ?? '')}」的核心内容：定义、触发条件、公式或规则、易混点。`
        : `先别看答案：写下你对「${String(node.canonical_name ?? '')}」还记得的内容。`,
    key_points: keyPoints,
    card_confirmed: card !== null,
    kind: 'recall',
    value_index: candidate.value_index,
    appearances: candidate.cycles_present,
    counted_cycles: candidate.counted_cycles,
    retrievability: candidate.retrievability,
  }
}

export function currentInteractionSession(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string,
  now: Instant,
): SessionOut | null {
  requireProject(db, userId, projectId)
  const rows = findRows(db, 'learning_interaction_session', { user_id: userId, project_id: projectId })
    .filter((row) => String(row.status) === SESSION_PLANNED || String(row.status) === SESSION_ACTIVE)
    .filter((row) => String(row.subject_id) === subjectId)
    .sort((left, right) => Number(right.created_at as Instant) - Number(left.created_at as Instant))
  return rows.length === 0 ? null : sessionPayload(db, rows[0])
}

export function getInteractionSession(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  now: Instant,
): SessionOut {
  return sessionPayload(db, sessionOr404(db, userId, projectId, sessionId))
}

export function startInteractionSession(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  now: Instant,
): SessionOut {
  const session = sessionOr404(db, userId, projectId, sessionId)
  if (String(session.status) === SESSION_COMPLETED) return sessionPayload(db, session)
  const updated = transaction(db, () => {
    const stored = updateRow(
      db,
      'learning_interaction_session',
      session.id,
      {
        status: SESSION_ACTIVE,
        started_at: session.started_at ?? now,
        stage: resolveStage(db, String(session.id)),
      },
      { now },
    )!
    return stored
  })
  return sessionPayload(db, updated)
}

export function activateStep(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  ordinal: number,
  now: Instant,
): { step: SessionStepOut; presentation?: Record<string, unknown> } {
  const session = sessionOr404(db, userId, projectId, sessionId)
  if (String(session.status) === SESSION_COMPLETED) throw new PurposeNotAllowed('学习会话已结束')
  const step = stepOr404(db, sessionId, ordinal)
  if (step.status === COMPLETED || step.status === SKIPPED || step.status === EXPIRED) {
    throw new InvalidInput('该步骤已结束，不能重新激活')
  }
  const current = sessionSteps(db, sessionId).find((row) => row.status === PENDING || row.status === ACTIVE)
  if (current === undefined) throw new PurposeNotAllowed('没有待进行的步骤：可以结束并查看本次会话总结')
  if (Number(current.ordinal) !== ordinal) {
    throw new InvalidInput('只能开始当前步骤', { details: { current_ordinal: Number(current.ordinal) } })
  }
  const active = transaction(db, () => {
    let stored = step
    if (step.status === PENDING) {
      stored = updateRow(
        db,
        'learning_session_step',
        step.id,
        { status: ACTIVE, started_at: step.started_at ?? now },
        { now },
      )!
      updateRow(db, 'learning_interaction_session', session.id, { stage: String(step.stage), status: SESSION_ACTIVE, started_at: session.started_at ?? now }, { now })
    }
    if (String(step.status) === SESSION_ACTIVE || String(stored.status) === ACTIVE) {
      // A timed transfer gets a server-owned deadline when it is first activated.
      if (String(step.kind) === 'transfer' && (stored.deadline_at === null || stored.deadline_at === undefined)) {
        const seconds = Number((stored.payload as Record<string, unknown> | null)?.timed_seconds ?? 180)
        stored = updateRow(
          db,
          'learning_session_step',
          stored.id,
          { deadline_at: (now as bigint) + BigInt(Math.max(30, seconds)) * 1_000_000n },
          { now },
        )!
      }
    }
    return stored
  })
  const payload: { step: SessionStepOut; presentation?: Record<string, unknown> } = {
    step: stepOut(db, active),
  }
  const sessionItemId =
    active.session_item_id === null || active.session_item_id === undefined ? null : String(active.session_item_id)
  if (sessionItemId !== null && (String(active.kind) === 'practice' || String(active.kind) === 'repair_retest' || String(active.kind) === 'transfer')) {
    payload.presentation = presentItem(db, userId, sessionItemId, now) as unknown as Record<string, unknown>
  }
  return payload
}

function resolveStage(db: DatabaseSync, sessionId: string): SessionStageName {
  const steps = sessionSteps(db, sessionId)
  const pending = steps.find((row) => row.status === PENDING || row.status === ACTIVE) ?? steps[steps.length - 1]
  return pending === undefined ? 'warmup' : (String(pending.stage) as SessionStageName)
}

/* ------------------------------------------------------------------ recall */

interface RecallDraft {
  text: string
  confidence_before: number | null
  coverage: RecallCoverage | null
  suggested_rating: string | null
  coach_turn_id: string | null
  key_points: KeyPoint[]
  prompt: string
  kind: string
}

function readRecallDraft(step: Record<string, unknown>): RecallDraft | null {
  const payload = (step.payload ?? {}) as Record<string, unknown>
  const draft = payload['recall_draft']
  if (draft === null || draft === undefined || typeof draft !== 'object') return null
  return draft as unknown as RecallDraft
}

async function tryModelCoverage(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  step: Record<string, unknown>,
  text: string,
  deps: SessionDeps,
  now: Instant,
): Promise<{ coverage: RecallCoverage; coach: CoachTurnOut | null } | null> {
  if (deps.port === undefined) return null
  const node = nodeForStep(db, step)
  if (node === null) return null
  const card = cards.confirmedCard(db, userId, projectId, String(node.id))
  if (card === null || card.key_points.length === 0) return null
  try {
    const reply = await runCoachTurn(
      db,
      {
        userId,
        projectId,
        nodeId: String(node.id),
        purpose: String(step.kind) === 'self_explain' ? 'self_explain_check' : 'recall_check',
        message: text,
        sessionId: String(step.session_id),
        stepOrdinal: Number(step.ordinal),
      },
      { port: deps.port, now },
    )
    if (reply.turn.status !== 'succeeded') return null
    const structured = reply.turn.structured as Record<string, unknown>
    const covered = Array.isArray(structured['key_points_covered'])
      ? (structured['key_points_covered'] as unknown[]).map((value) => String(value))
      : []
    const cannot = Array.isArray(structured['cannot_judge'])
      ? (structured['cannot_judge'] as unknown[]).map((value) => String(value))
      : []
    const coverage = coverageFromPoints(card.key_points, covered, cannot)
    return {
      coverage: {
        covered: coverage.covered,
        missing: coverage.missing,
        cannot_judge: coverage.cannot_judge,
        coverage: coverage.coverage,
      },
      coach: reply.turn,
    }
  } catch {
    // A coach refusal is not a reason to lose the learner's recall attempt.
    return null
  }
}

export async function submitRecallStep(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  ordinal: number,
  body: { text?: unknown; confidence_before?: unknown; latency_ms?: unknown },
  now: Instant,
  deps: SessionDeps = {},
): Promise<{
  step: SessionStepOut
  recall: {
    event: RecallEventOut | null
    coverage: RecallCoverage | null
    key_points: KeyPoint[]
    suggested_rating: string | null
    can_confirm: boolean
  }
  coach_turn: CoachTurnOut | null
}> {
  const session = sessionOr404(db, userId, projectId, sessionId)
  if (String(session.status) === SESSION_COMPLETED) throw new PurposeNotAllowed('学习会话已结束')
  const step = stepOr404(db, sessionId, ordinal)
  if (String(step.kind) !== 'recall' && String(step.kind) !== 'self_explain') {
    throw new InvalidInput('该步骤不是回忆步骤')
  }
  if (step.status !== ACTIVE) throw new InvalidInput('请先开始该步骤')
  const text = String(body.text ?? '')
  if (text.trim() === '') throw new InvalidInput('请先写下你能回忆的内容（哪怕只写关键词）')
  const confidence = body.confidence_before === null || body.confidence_before === undefined ? null : Math.max(1, Math.min(5, Math.trunc(Number(body.confidence_before))))
  const payload = (step.payload ?? {}) as Record<string, unknown>
  const keyPoints = Array.isArray(payload['key_points']) ? (payload['key_points'] as KeyPoint[]) : []
  const checked = await tryModelCoverage(db, userId, projectId, step, text, deps, now)
  const coverage = checked === null ? null : checked.coverage
  const evaluation =
    coverage === null ? null : evaluateRecall({ coverage: coverage.coverage, hintLevel: 0, latencyRatio: null })
  const draft: RecallDraft = {
    text,
    confidence_before: confidence,
    coverage,
    suggested_rating: evaluation === null ? null : evaluation.rating,
    coach_turn_id: checked?.coach?.turn_id ?? null,
    key_points: keyPoints,
    prompt: String(payload['prompt'] ?? ''),
    kind: String(step.kind),
  }
  const stored = transaction(db, () => {
    const updated = updateRow(
      db,
      'learning_session_step',
      step.id,
      { payload: { ...payload, recall_draft: draft }, confidence_before: confidence },
      { now },
    )!
    updateRow(db, 'learning_interaction_session', session.id, { status: SESSION_ACTIVE }, { now })
    return updated
  })
  return {
    step: stepOut(db, stored),
    recall: {
      event: null,
      coverage,
      key_points: keyPoints,
      suggested_rating: draft.suggested_rating,
      can_confirm: true,
    },
    coach_turn: checked?.coach ?? null,
  }
}

export function confirmRecallStep(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  ordinal: number,
  body: { rating?: unknown; coverage?: unknown; latency_ms?: unknown },
  idempotencyKey: string,
  now: Instant,
): { step: SessionStepOut; event: RecallEventOut } {
  const session = sessionOr404(db, userId, projectId, sessionId)
  if (String(session.status) === SESSION_COMPLETED) throw new PurposeNotAllowed('学习会话已结束')
  const step = stepOr404(db, sessionId, ordinal)
  const draft = readRecallDraft(step)
  if (draft === null) throw new InvalidInput('请先提交回忆内容')
  const completed = String(step.status) === COMPLETED
  if (String(step.status) !== ACTIVE && !completed) throw new InvalidInput('该步骤未在进行中')
  const rating = String(body.rating ?? draft.suggested_rating ?? '')
  if (!(RATINGS as readonly string[]).includes(rating)) {
    throw new InvalidInput('请选择一个记忆评级', { details: { allowed: [...RATINGS] } })
  }
  const coverage = draft.coverage
  const node = nodeForStep(db, step)
  if (node === null) throw new ScopeViolation('该步骤没有关联考点')
  const source = draft.coach_turn_id === null ? 'self_report' : 'model_assisted_confirmed'
  const event = nodeMemory.recordRecall(
    db,
    userId,
    projectId,
    {
      nodeId: String(node.id),
      kind: draft.kind === 'self_explain' ? 'self_explain' : 'free_recall',
      rating,
      source,
      coverage: coverage ?? { covered: [], missing: [], cannot_judge: [], coverage: null },
      promptText: draft.prompt,
      answerText: draft.text,
      latencyMs: body.latency_ms === null || body.latency_ms === undefined ? null : Math.max(0, Math.trunc(Number(body.latency_ms))),
      confidenceBefore: draft.confidence_before,
      sessionId,
      stepId: String(step.id),
      idempotencyKey,
      note: '',
    },
    now,
  )
  if (completed) {
    return { step: stepOut(db, step), event }
  }
  const updated = transaction(db, () => {
    const stored = updateRow(
      db,
      'learning_session_step',
      step.id,
      {
        status: COMPLETED,
        finished_at: now,
        outcome: recallOutcome(rating as RecallRating),
        payload: {
          ...((step.payload ?? {}) as Record<string, unknown>),
          recall_result: { event_id: event.event_id, rating, memory_updated: event.memory_updated, due_at: event.due_at },
        },
      },
      { now },
    )!
    updateRow(db, 'learning_interaction_session', session.id, { stage: resolveStage(db, sessionId) }, { now })
    return stored
  })
  return { step: stepOut(db, updated), event }
}

/* ------------------------------------------------------------------ practice */

export function submitStepAnswer(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  ordinal: number,
  body: { answer?: unknown; steps?: unknown; confidence?: unknown; client_active_ms?: unknown; asset_ids?: unknown },
  now: Instant,
): { step: SessionStepOut; attempt_id: string; grade: Record<string, unknown> | null; receipt_only: boolean } {
  const session = sessionOr404(db, userId, projectId, sessionId)
  if (String(session.status) === SESSION_COMPLETED) throw new PurposeNotAllowed('学习会话已结束')
  const step = stepOr404(db, sessionId, ordinal)
  if (step.status !== ACTIVE) throw new InvalidInput('请先开始该步骤')
  const itemId = step.session_item_id === null || step.session_item_id === undefined ? null : String(step.session_item_id)
  if (itemId === null) throw new InvalidInput('该步骤没有可作答的题项')
  if (step.deadline_at !== null && step.deadline_at !== undefined && (now as bigint) > (step.deadline_at as Instant)) {
    updateRow(db, 'learning_session_step', step.id, { status: EXPIRED, finished_at: now, outcome: 'unknown' }, { now })
    throw new PurposeNotAllowed('该限时步骤已过截止时间')
  }
  const answer = (body.answer ?? {}) as Record<string, unknown>
  const result = submitAttempt(
    db,
    userId,
    itemId,
    {
      raw_answer: answer,
      steps: body.steps === undefined ? undefined : (body.steps as unknown[]),
      confidence: body.confidence === undefined || body.confidence === null ? undefined : String(body.confidence),
      client_active_ms: body.client_active_ms === null || body.client_active_ms === undefined ? null : Math.max(0, Math.trunc(Number(body.client_active_ms))),
      asset_ids: Array.isArray(body.asset_ids) ? (body.asset_ids as unknown[]).map((value) => String(value)) : undefined,
    },
    now,
  )
  const grade = (result.grade ?? null) as Record<string, unknown> | null
  const fullyConfirmed = grade !== null && grade.is_fully_confirmed === true
  const correct = grade !== null && grade.is_correct === true
  const outcome = grade === null ? 'pending_review' : fullyConfirmed ? (correct ? 'correct' : 'incorrect') : 'pending_review'
  const updated = transaction(db, () => {
    const stored = updateRow(
      db,
      'learning_session_step',
      step.id,
      { status: COMPLETED, finished_at: now, outcome, payload: { ...((step.payload ?? {}) as Record<string, unknown>), attempt_id: String(result.attempt.id), grade_outcome: outcome } },
      { now },
    )!
    if (outcome === 'incorrect') appendRepairSteps(db, userId, projectId, session, stored, now)
    updateRow(db, 'learning_interaction_session', session.id, { stage: resolveStage(db, sessionId) }, { now })
    return stored
  })
  return {
    step: stepOut(db, updated),
    attempt_id: String(result.attempt.id),
    grade: gradePayload(result.grade),
    receipt_only: false,
  }
}

function appendRepairSteps(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  session: Record<string, unknown>,
  failedStep: Record<string, unknown>,
  now: Instant,
): void {
  const sessionId = String(session.id)
  const existing = findRows(db, 'learning_session_step', { session_id: sessionId }).filter(
    (row) => String(row.stage) === 'repair' && String(row.node_id ?? '') === String(failedStep.node_id ?? ''),
  )
  if (existing.length > 0) return
  const steps = sessionSteps(db, sessionId)
  let ordinal = steps.reduce((max, row) => Math.max(max, Number(row.ordinal)), 0) + 1
  const node = nodeForStep(db, failedStep)
  if (node === null) return
  const card = cards.confirmedCard(db, userId, projectId, String(node.id))
  const keyPoints = card === null ? [] : card.key_points.filter((point) => point.required).map((point) => point.text)
  insertRow(
    db,
    'learning_session_step',
    {
      session_id: sessionId,
      ordinal: ordinal++,
      stage: 'repair',
      kind: 'repair_brief',
      status: PENDING,
      node_id: node.id,
      question_id: failedStep.question_id ?? null,
      session_item_id: null,
      estimated_minutes: 1,
      hint_level: 0,
      confidence_before: null,
      outcome: 'unknown',
      payload: {
        node_name: String(node.canonical_name ?? ''),
        brief: {
          key_points: keyPoints,
          message: '只讲当前卡点：对照上面的关键点，找出你漏掉的那一步；不要重读整道题。',
        },
        retest_available: usableQuestionForNode(db, projectId, String(node.id)) !== null,
      },
      reason_codes: ['error_repair', 'minimal_explanation'],
      deadline_at: null,
      started_at: null,
      finished_at: null,
      skipped_reason: '',
    },
    { now },
  )
  const retest = usableQuestionForNode(db, projectId, String(node.id))
  let retestItemId: string | null = null
  if (retest !== null) {
    try {
      const repairSession = createPracticeSession(
        db,
        userId,
        projectId,
        { subject_id: String(session.subject_id), mode: 'practice', question_ids: [String(retest.id)], purpose: 'practice' },
        now,
      )
      const repairItem = findRows(db, 'practice_session_item', { session_id: String(repairSession.id) }).sort(
        (left, right) => Number(left.ordinal) - Number(right.ordinal),
      )[0]
      retestItemId = repairItem === undefined ? null : String(repairItem.id)
    } catch {
      retestItemId = null
    }
  }
  if (retest !== null && retestItemId !== null) {
    insertRow(
      db,
      'learning_session_step',
      {
        session_id: sessionId,
        ordinal,
        stage: 'repair',
        kind: 'repair_retest',
        status: PENDING,
        node_id: node.id,
        question_id: retest.id,
        session_item_id: retestItemId,
        estimated_minutes: 2,
        hint_level: 0,
        confidence_before: null,
        outcome: 'unknown',
        payload: {
          question_type: questionTypeOf(db, String(retest.id)),
          display_label: String(retest.display_label ?? ''),
          hints_available: true,
        },
        reason_codes: ['error_repair', 'different_question'],
        deadline_at: null,
        started_at: null,
        finished_at: null,
        skipped_reason: '',
      },
      { now },
    )
  } else {
    updateRow(
      db,
      'learning_interaction_session',
      sessionId,
      { notes: [...((session.notes ?? []) as string[]), `考点「${String(node.canonical_name ?? '')}」答错后没有其它可用题，无法再测。`] },
      { now },
    )
  }
}

/* --------------------------------------------------------------------- hint */

export function completeReadStep(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  ordinal: number,
  now: Instant,
): SessionStepOut {
  sessionOr404(db, userId, projectId, sessionId)
  const step = stepOr404(db, sessionId, ordinal)
  if (step.status !== ACTIVE) throw new InvalidInput('请先开始该步骤')
  const updated = updateRow(
    db,
    'learning_session_step',
    step.id,
    { status: COMPLETED, finished_at: now, outcome: 'unknown' },
    { now },
  )!
  updateRow(db, 'learning_interaction_session', String(step.session_id), { stage: resolveStage(db, sessionId) }, { now })
  return stepOut(db, updated)
}

export function skipStep(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  ordinal: number,
  body: { reason?: unknown },
  now: Instant,
): SessionStepOut {
  const session = sessionOr404(db, userId, projectId, sessionId)
  const step = stepOr404(db, sessionId, ordinal)
  if (step.status === COMPLETED) throw new InvalidInput('已完成的步骤不能跳过')
  const reason = String(body.reason ?? '').trim()
  if (reason === '') throw new InvalidInput('跳过步骤需要写明原因')
  const updated = transaction(db, () => {
    const stored = updateRow(
      db,
      'learning_session_step',
      step.id,
      { status: SKIPPED, finished_at: now, outcome: 'skipped', skipped_reason: reason.slice(0, 300) },
      { now },
    )!
    updateRow(
      db,
      'learning_interaction_session',
      session.id,
      {
        stage: resolveStage(db, sessionId),
        notes: [...((session.notes ?? []) as string[]), `跳过步骤 ${ordinal}：${reason.slice(0, 120)}`],
      },
      { now },
    )
    return stored
  })
  return stepOut(db, updated)
}

/* ------------------------------------------------------------------- finish */

export function finishInteractionSession(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  now: Instant,
  deps: SessionDeps = {},
): SessionOut {
  const session = sessionOr404(db, userId, projectId, sessionId)
  if (String(session.status) === SESSION_COMPLETED) return sessionPayload(db, session)
  return transaction(db, () => {
    const steps = sessionSteps(db, sessionId)
    const open = steps.filter((row) => row.status === PENDING || row.status === ACTIVE)
    if (open.length > 0) {
      throw new InvalidInput('还有未完成的步骤：请完成或跳过后再结束会话', {
        details: { open_ordinals: open.map((row) => Number(row.ordinal)) },
      })
    }
    const events = findRows(db, 'memory_recall_event', { session_id: sessionId })
    const ratings: Record<string, number> = { again: 0, hard: 0, good: 0, easy: 0 }
    let stabilityGain = 0
    let confidenceSamples = 0
    let overconfident = 0
    let underconfident = 0
    for (const event of events) {
      ratings[String(event.rating)] = (ratings[String(event.rating)] ?? 0) + 1
      stabilityGain += Math.max(0, Number(event.stability_after) - Number(event.stability_before))
      const confidence = event.confidence_before
      if (confidence !== null && confidence !== undefined) {
        confidenceSamples += 1
        const rating = String(event.rating)
        if (Number(confidence) >= 4 && (rating === 'again' || rating === 'hard')) overconfident += 1
        if (Number(confidence) <= 2 && (rating === 'good' || rating === 'easy')) underconfident += 1
      }
    }
    const practice = steps.filter((row) => ['practice', 'repair_retest', 'transfer'].includes(String(row.kind)))
    const errors = practice
      .filter((row) => String(row.outcome) === 'incorrect')
      .map((row) => ({ node_name: String(nodeForStep(db, row)?.canonical_name ?? ''), question_label: String(row.question_id ?? '') }))
    const memoryRows = findRows(db, 'memory_node_state', { user_id: userId, project_id: projectId })
      .filter((row) => steps.some((step) => String(step.node_id ?? '') === String(row.node_id)))
      .sort((left, right) => Number((left.due_at ?? 0n) as bigint) - Number((right.due_at ?? 0n) as bigint))
      .slice(0, 3)
    const summary = {
      steps_total: steps.length,
      steps_completed: steps.filter((row) => String(row.status) === COMPLETED).length,
      steps_skipped: steps.filter((row) => String(row.status) === SKIPPED).length,
      recall_count: events.length,
      rating_counts: ratings,
      memory_updates: events.filter((row) => Number(row.interval_days) > 0).length,
      stability_gain: Math.round(stabilityGain * 10000) / 10000,
      practice_items: practice.length,
      practice_correct: practice.filter((row) => String(row.outcome) === 'correct').length,
      practice_incorrect: practice.filter((row) => String(row.outcome) === 'incorrect').length,
      practice_pending: practice.filter((row) => String(row.outcome) === 'pending_review').length,
      errors,
      next_due: memoryRows.map((row) => ({ node_id: String(row.node_id), node_name: String(nodeForStep(db, { node_id: row.node_id })?.canonical_name ?? ''), due_at: iso(row.due_at) })),
      calibration: {
        samples: confidenceSamples,
        overconfident,
        underconfident,
        note:
          confidenceSamples === 0
            ? '本次没有记录信心预测，无法给出校准结论。'
            : `信心与结果的一致性：${confidenceSamples} 次预测中，过度自信 ${overconfident} 次、低估 ${underconfident} 次。`,
      },
      duration_minutes: session.started_at === null || session.started_at === undefined ? 0 : Math.max(0, Math.round(Number(now - (session.started_at as Instant)) / 60_000_000)),
      rule_version: STUDY_RULE_VERSION,
    }
    const updated = updateRow(
      db,
      'learning_interaction_session',
      session.id,
      { status: SESSION_COMPLETED, finished_at: now, summary },
      { now },
    )!
    const practiceSessionId =
      session.practice_session_id === null || session.practice_session_id === undefined ? null : String(session.practice_session_id)
    if (practiceSessionId !== null) {
      try {
        const practice = findOne(db, 'practice_session', { id: practiceSessionId })
        if (practice !== null && String(practice.status) === 'active') {
          // Close the linked practice session through its own service so its state machine (attempts,
          // reveal policy, task completion) stays authoritative.
          finishSession(db, userId, practiceSessionId, now)
        }
      } catch {
        // A practice-session close failure must not lose the interaction summary.
      }
    }
    return sessionPayload(db, updated)
  })
}

/* --------------------------------------------------------------------- desk */

export interface DeskAiStatus {
  configured: boolean
  coach_available: boolean
  message: string
}

export function studyDesk(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string,
  now: Instant,
  ai: DeskAiStatus = { configured: false, coach_available: false, message: 'AI 未配置：回忆使用自评，考点卡可人工编辑。' },
): StudyDeskOut {
  const project = requireProject(db, userId, projectId)
  if (project.is_archived === true) throw new InvalidInput('项目已归档')
  const subject = requireSubject(db, userId, projectId, subjectId)
  const settings = getStudySettings(db, userId, now)
  const nodes = subjectNodes(db, subjectId)
  const planning = frequency.planningValues(db, userId, projectId, subjectId)
  const abilities = abilityByNode(db, projectId)
  const memories = nodeMemory.memoryForNodes(db, userId, projectId, nodes.map((node) => String(node.id)), now)
  const session = currentInteractionSession(db, userId, projectId, subjectId, now)
  const dueMemory: StudyDeskOut['due_memory'] = []
  const valueNodes: StudyDeskOut['value_nodes'] = []
  const weakNodes: StudyDeskOut['weak_nodes'] = []
  let withMemory = 0
  let neverDiagnosed = 0
  for (const node of nodes) {
    const nodeId = String(node.id)
    const memory = memories.get(nodeId) ?? null
    if (memory !== null) withMemory += 1
    const ability = abilities.get(nodeId) ?? null
    const card = cards.currentCard(db, userId, projectId, nodeId)
    const value = planning.get(nodeId) ?? null
    if (memory !== null && memory.is_due) {
      dueMemory.push({
        node_id: nodeId,
        node_name: String(node.canonical_name ?? ''),
        value_index: value === null ? null : value.value_index,
        retrievability: memory.retrievability,
        due_at: memory.due_at,
        appearances: value === null ? 0 : value.appearances,
        cycles_present: value === null ? 0 : value.cycles_present,
        counted_cycles: value === null ? 0 : value.counted_cycles,
        reason_codes: ['due_memory', ...(memory.retrievability !== null && memory.retrievability < 0.9 ? ['forgetting_risk'] : [])],
      })
    }
    if (ability === null) neverDiagnosed += 1
    valueNodes.push({
      node_id: nodeId,
      node_name: String(node.canonical_name ?? ''),
      path: String(node.canonical_name ?? ''),
      value_index: value === null ? null : value.value_index,
      status: value === null ? 'no_real_data' : value.status,
      appearances: value === null ? 0 : value.appearances,
      cycles_present: value === null ? 0 : value.cycles_present,
      counted_cycles: value === null ? 0 : value.counted_cycles,
      share_avg: null,
      last_seen_cycle: value === null ? null : value.last_seen_cycle,
      memory,
      ability_summary: ability === null ? null : String(ability.summary ?? ''),
      card_status: card === null ? null : card.status,
      reason_codes: [],
    })
    if (ability !== null && (ability.needs_review === true || String(ability.summary) === 'needs_foundation')) {
      weakNodes.push({
        node_id: nodeId,
        node_name: String(node.canonical_name ?? ''),
        ability_summary: String(ability.summary ?? ''),
        needs_review: ability.needs_review === true,
        value_index: value === null ? null : value.value_index,
        reason_codes: ability.needs_review === true ? ['recent_failures'] : ['foundation_gap'],
      })
    }
  }
  dueMemory.sort((left, right) => (right.value_index ?? 0) * (1 - (right.retrievability ?? 1)) - (left.value_index ?? 0) * (1 - (left.retrievability ?? 1)))
  valueNodes.sort((left, right) => (right.value_index ?? -1) - (left.value_index ?? -1))
  const notes: string[] = []
  if (nodes.length === 0) notes.push('该科目还没有已发布大纲的考点：先导入大纲并发布。')
  if (planning.size > 0 && [...planning.values()].every((value) => value.status !== 'ok')) {
    notes.push('考频样本不足（少于 2 个完整周期）：只展示原始计数，不按考频排序。')
  }
  notes.push('记忆复习只安排到期的考点；同一会话内重复回忆不计入间隔记忆。')
  return {
    project_id: projectId,
    subject_id: subjectId,
    subject_name: String(subject.name ?? ''),
    date: localDate(settings, now),
    budget_minutes: Number(settings.daily_budget_minutes ?? 60),
    session,
    due_memory: dueMemory.slice(0, 8),
    value_nodes: valueNodes.slice(0, 8),
    weak_nodes: weakNodes.slice(0, 6),
    coverage: {
      nodes_total: nodes.length,
      nodes_with_memory: withMemory,
      nodes_due: dueMemory.length,
      nodes_never_diagnosed: neverDiagnosed,
    },
    ai,
    notes,
    rule_version: STUDY_RULE_VERSION,
  }
}

function localDate(settings: unknown, now: Instant): string {
  const rows = (settings ?? {}) as Record<string, unknown>
  const timezone = String(rows.timezone ?? 'UTC')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone === '' ? 'UTC' : timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Number(now / 1_000n)))
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${read('year')}-${read('month')}-${read('day')}`
}


/* --------------------------------------------------------------------- hints */

export interface HintResult {
  step: SessionStepOut
  blocks: Array<Record<string, unknown>>
  reveals_answer: boolean
  model_used: boolean
  coach_turn: CoachTurnOut | null
  fallback_note: string
}

function assertHintAllowed(db: DatabaseSync, userId: string, projectId: string, step: Record<string, unknown>): void {
  const kind = String(step.kind)
  if (kind === 'transfer') throw new PurposeNotAllowed('迁移/限时步骤不提供提示：这一步要测量独立表现')
  if (kind !== 'practice' && kind !== 'repair_retest') throw new InvalidInput('该步骤不支持提示')
  const questionId = step.question_id === null || step.question_id === undefined ? null : String(step.question_id)
  if (questionId !== null) {
    const sealing = isSealed(db, projectId, questionId)
    if (sealing.sealed) throw new PurposeNotAllowed(`封存内容不可提示：${reasonMessage(sealing.code)}`)
    const versions = findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
      (left, right) => Number(right.version) - Number(left.version),
    )
    const versionId = versions.length === 0 ? null : String(versions[0].id)
    const ownItem = step.session_item_id === null || step.session_item_id === undefined ? null : String(step.session_item_id)
    const covering = versionId === null ? undefined : verificationContentMap(db, userId).get(versionId)
    if (covering !== undefined && [...covering].some((itemId) => itemId !== ownItem)) {
      throw new PurposeNotAllowed('该内容正在验证或模拟考试中：结束前不提供任何提示')
    }
  }
  const itemId = step.session_item_id === null || step.session_item_id === undefined ? null : String(step.session_item_id)
  if (itemId !== null) {
    const item = findOne(db, 'practice_session_item', { id: itemId })
    if (item !== null && item.tutoring_allowed !== true) {
      throw new PurposeNotAllowed('该题项按计划不提供辅导')
    }
  }
}

function deterministicHint(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  step: Record<string, unknown>,
  level: number,
): Array<Record<string, unknown>> {
  const node = nodeForStep(db, step)
  if (node === null) {
    return [{ kind: 'text', text: '这一步没有关联考点卡：先写下你已经确定的条件。' }]
  }
  const card = cards.confirmedCard(db, userId, projectId, String(node.id))
  const points = card === null ? [] : card.key_points.filter((point) => point.required)
  if (level <= 1) {
    return [
      {
        kind: 'text',
        text: `先定位考点：「${String(node.canonical_name ?? '')}」。问自己：这道题在考它的哪个触发条件？`,
      },
    ]
  }
  if (level === 2) {
    const first = points[0]?.text ?? '该考点的适用条件'
    return [{ kind: 'text', text: `把注意力放在这条原则上：${first}。它决定了下一步该用哪个方法。` }]
  }
  const bullets = points.slice(0, 3).map((point) => point.text)
  return [
    { kind: 'text', text: '只展开关键的一步，不给出完整答案：' },
    { kind: 'list', items: bullets.length > 0 ? bullets : ['回到题干，列出已知条件与所求', '确认适用条件是否满足'] },
  ]
}

export async function requestStepHint(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sessionId: string,
  ordinal: number,
  body: { level?: unknown },
  now: Instant,
  deps: SessionDeps = {},
): Promise<HintResult> {
  const session = sessionOr404(db, userId, projectId, sessionId)
  if (String(session.status) === SESSION_COMPLETED) throw new PurposeNotAllowed('学习会话已结束')
  const step = stepOr404(db, sessionId, ordinal)
  if (step.status !== ACTIVE) throw new InvalidInput('请先开始该步骤再请求提示')
  assertHintAllowed(db, userId, projectId, step)
  const level = Math.max(1, Math.min(3, Math.trunc(Number(body.level ?? 1))))
  // The coach derives its allowed maximum from `step.hint_level + 1`; recording the *current*
  // level before the call is what lets a level-2/3 request actually receive that level.
  const currentLevel = Number(step.hint_level ?? 0)
  if (level - 1 > currentLevel) {
    updateRow(db, 'learning_session_step', step.id, { hint_level: level - 1 }, { now })
  }
  const node = nodeForStep(db, step)
  let coachTurn: CoachTurnOut | null = null
  let blocks: Array<Record<string, unknown>> = []
  let revealsAnswer = false
  let modelUsed = false
  if (deps.port !== undefined && node !== null) {
    try {
      const reply = await runCoachTurn(
        db,
        {
          userId,
          projectId,
          nodeId: String(node.id),
          purpose: 'hint',
          message: `请给出第 ${level} 级提示（1=方向，2=原理，3=关键一步的部分展开；不要给出完整答案）。`,
          sessionId,
          stepOrdinal: ordinal,
        },
        { port: deps.port, now },
      )
      coachTurn = reply.turn
      if (reply.turn.status === 'succeeded') {
        const structured = reply.turn.structured as Record<string, unknown>
        const rawBlocks = Array.isArray(structured['hint_blocks']) ? (structured['hint_blocks'] as unknown[]) : []
        blocks = rawBlocks
          .filter((block): block is Record<string, unknown> => block !== null && typeof block === 'object')
          .map((block) => block as Record<string, unknown>)
        revealsAnswer = structured['reveals_answer'] === true
        modelUsed = blocks.length > 0
      }
    } catch {
      modelUsed = false
    }
  }
  let fallbackNote = ''
  if (!modelUsed) {
    blocks = deterministicHint(db, userId, projectId, step, level)
    revealsAnswer = false
    fallbackNote =
      deps.port === undefined
        ? 'AI 未配置：显示的是考点卡中的固定提示，不是模型生成内容。'
        : '模型本轮不可用：显示的是考点卡中的固定提示。'
  }
  const updated = transaction(db, () => {
    const nextLevel = Math.max(Number(step.hint_level ?? 0), level)
    const stored = updateRow(
      db,
      'learning_session_step',
      step.id,
      { hint_level: nextLevel, payload: { ...((step.payload ?? {}) as Record<string, unknown>), hint: { level, blocks, reveals_answer: revealsAnswer, model_used: modelUsed } } },
      { now },
    )!
    if (!modelUsed && step.question_id !== null && step.question_id !== undefined) {
      // A deterministic hint is assistance too: record it as an exposure so later independence is
      // not overstated. The model path records its own exposure inside the coach service.
      const versionId = (() => {
        const versions = findRows(db, 'question_bank_question_version', { question_id: String(step.question_id) }).sort(
          (left, right) => Number(right.version) - Number(left.version),
        )
        return versions.length === 0 ? null : String(versions[0].id)
      })()
      insertRow(
        db,
        'practice_exposure_event',
        {
          user_id: userId,
          project_id: projectId,
          question_id: step.question_id,
          question_version_id: versionId,
          family_id: null,
          content_lineage_id: null,
          session_item_id: step.session_item_id ?? null,
          kind: 'hint_delivered',
          purpose: 'practice',
          source: 'study_hint',
          server_time: now,
          reveals_answer: revealsAnswer,
          detail: { session_id: sessionId, step_ordinal: ordinal, hint_level: level, rules_based: true },
        },
        { now },
      )
    }
    return stored
  })
  return {
    step: stepOut(db, updated),
    blocks,
    reveals_answer: revealsAnswer,
    model_used: modelUsed,
    coach_turn: coachTurn,
    fallback_note: fallbackNote,
  }
}
