/**
 * Memory cards: FSRS active-recall scheduling over real rows.
 *
 * Port of `backend/apps/memory/services/scheduler.py` (the card list/create/review/logs/rebuild/
 * suspend/resume surface) — the HTTP shell is `memory_routes.ts`.
 *
 * The scheduler itself is `domain/fsrs.ts`, which is already golden-tested against the Python
 * implementation; this module only supplies it with rows, a clock and a transaction. Two rules are
 * worth restating because they are what stops a memory card from quietly becoming a score:
 *
 *  - **a review writes exactly one log row and updates the card projection.** It never creates a
 *    `practice_learning_evidence` row, never touches `learning_knowledge_state`, and never writes a
 *    grade or an attempt. Remembering a card is recall practice, not proof of solving ability
 *    (R-INV 3/4).
 *  - **the logs are the ledger and the card row is only a projection.** `rebuildCardFromLogs` replays
 *    them with the `params_version` each log recorded, so a hand-edited card is detected rather than
 *    trusted — and nothing is written by that check.
 *
 * Idempotency lives in the ledger (`(card, idempotency_key)` is unique), not in the generic request
 * journal: replaying a key returns the stored log, which is also the evidence `/rebuild` compares.
 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { normaliseIdempotencyKey } from './idempotency_key.ts'
import {
  DEFAULT_DESIRED_RETENTION,
  DEFAULT_WEIGHTS,
  FSRS_VERSION,
  type CardState,
  type Phase,
  retrievability,
  schedule,
  weightsFor,
} from '../domain/fsrs.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { IdempotencyConflictError, InvalidInput, ScopeViolation } from './errors.ts'
import { requireProject } from './exams.ts'

/** Default and maximum page sizes, so one request can never scan the whole table. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** Hard cap of the log window, so the ledger can never be dumped in one request. */
const MAX_LOG_LIMIT = 200
/** Review logs are replayed in this order; `created_at` breaks same-instant ties. */
const LOG_ORDER = ['reviewed_at', 'created_at'] as const
const RATINGS = ['again', 'hard', 'good', 'easy'] as const

const US_PER_DAY = 86_400_000_000n

/** `round(value, 6)` — the precision every float in these payloads is reported at. */
function round6(value: number): number {
  return Number(value.toFixed(6))
}

/** Python slices `str` by code points; `Array.slice` would cut an astral character in half. */
function sliceCodePoints(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('')
}

function clampLimit(limit: number | null | undefined, fallback = DEFAULT_LIMIT): number {
  if (limit === null || limit === undefined) return fallback
  return Math.max(1, Math.min(Math.trunc(limit), MAX_LIMIT))
}

function clampLogLimit(limit: number | null | undefined): number {
  return Math.min(Math.max(1, Math.trunc(limit ?? MAX_LOG_LIMIT)), MAX_LOG_LIMIT)
}

/** `(a, b)` ascending with NULL/None last, as PostgreSQL sorts `ASC` by default. */
function compareNullableInstant(a: unknown, b: unknown): number {
  const left = a === null || a === undefined ? null : Number(a as Instant)
  const right = b === null || b === undefined ? null : Number(b as Instant)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

function compareCreated(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const left = Number(a.created_at as Instant)
  const right = Number(b.created_at as Instant)
  if (left !== right) return left - right
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
}

/** `card_state`: the scheduler state of one card row. */
export function cardState(card: Record<string, unknown>): CardState {
  const dueAt = (card.due_at ?? null) as Instant | null
  const lastReviewedAt = (card.last_reviewed_at ?? null) as Instant | null
  let scheduledDays = 0
  if (dueAt !== null && lastReviewedAt !== null) {
    scheduledDays = Math.max(0, Number(dueAt - lastReviewedAt) / Number(US_PER_DAY))
  }
  return {
    stability: Number(card.stability ?? 0),
    difficulty: Number(card.difficulty ?? 0),
    phase: String(card.phase) as Phase,
    reps: Number(card.reps ?? 0),
    lapses: Number(card.lapses ?? 0),
    learningStep: Number(card.learning_step ?? 0),
    lastReviewedAt,
    dueAt,
    scheduledDays,
    elapsedDays: 0,
  }
}

/** `retrievability_now`: `R(t, S)`, or `null` when the card has no memory state yet. */
export function retrievabilityNow(
  card: Record<string, unknown>,
  now: Instant | null = null,
): number | null {
  const lastReviewedAt = (card.last_reviewed_at ?? null) as Instant | null
  const stability = Number(card.stability ?? 0)
  // A `new` card is reported as `null` rather than `1.0`: the product must not present
  // "never studied" as "perfectly remembered".
  if (lastReviewedAt === null || stability <= 0) return null
  const moment = now ?? (lastReviewedAt as Instant)
  const elapsedDays = Math.max(0, Number(moment - lastReviewedAt) / Number(US_PER_DAY))
  return retrievability(elapsedDays, stability)
}

/** `_primary_node`: the primary knowledge node of the question's current version, if any. */
function primaryNode(db: DatabaseSync, questionId: string): string | null {
  const versions = findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
    (a, b) => Number(b.version) - Number(a.version),
  )
  const version = versions[0] ?? null
  if (version === null) return null
  const mappings = findRows(db, 'knowledge_question_mapping', {
    question_version_id: String(version.id),
    is_primary: true,
  }).sort(compareCreated)
  return mappings[0] === undefined ? null : String(mappings[0].node_id)
}

/** `_excerpt`: first text block of the stem, trimmed; never options or answers. */
function excerpt(db: DatabaseSync, questionId: string): string {
  const versions = findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
    (a, b) => Number(b.version) - Number(a.version),
  )
  const version = versions[0] ?? null
  if (version === null) return ''
  const content = (version.content ?? {}) as Record<string, unknown>
  const blocks = (content.blocks ?? []) as Record<string, unknown>[]
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.kind === 'text' && block.text) {
      return sliceCodePoints(String(block.text).trim(), 0, 160)
    }
  }
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.text) {
      return sliceCodePoints(String(block.text).trim(), 0, 160)
    }
  }
  return ''
}

/** `card_payload`: memory state only — no grade, no ability. */
export function cardPayload(
  db: DatabaseSync,
  card: Record<string, unknown>,
  now: Instant | null = null,
): Record<string, unknown> {
  const questionId = String(card.question_id)
  const question = findOne(db, 'question_bank_question', { id: questionId })
  const nodeId =
    card.knowledge_node_id === null || card.knowledge_node_id === undefined
      ? null
      : String(card.knowledge_node_id)
  const node = nodeId === null ? null : findOne(db, 'knowledge_node', { id: nodeId })
  const value = retrievabilityNow(card, now)
  return {
    card_id: String(card.id),
    project_id: String(card.project_id),
    subject_id: String(card.subject_id),
    question_id: questionId,
    question_label: question === null ? '' : String(question.display_label ?? ''),
    stem_excerpt: excerpt(db, questionId),
    knowledge_node_id: nodeId,
    knowledge_node_name: node === null ? '' : String(node.canonical_name ?? ''),
    phase: String(card.phase),
    due_at: card.due_at === null || card.due_at === undefined ? null : formatPythonIso(card.due_at as Instant),
    last_reviewed_at:
      card.last_reviewed_at === null || card.last_reviewed_at === undefined
        ? null
        : formatPythonIso(card.last_reviewed_at as Instant),
    stability: round6(Number(card.stability ?? 0)),
    difficulty: round6(Number(card.difficulty ?? 0)),
    retrievability: value === null ? null : round6(value),
    reps: Number(card.reps ?? 0),
    lapses: Number(card.lapses ?? 0),
    learning_step: Number(card.learning_step ?? 0),
    is_suspended: card.is_suspended === true,
    suspended_reason: String(card.suspended_reason ?? ''),
    scheduler_version: String(card.scheduler_version),
    params_version: String(card.params_version),
    desired_retention: Number(card.desired_retention),
  }
}

/** `log_payload`: one immutable ledger row as the wire shape. */
export function logPayload(log: Record<string, unknown>): Record<string, unknown> {
  return {
    log_id: String(log.id),
    card_id: String(log.card_id),
    rating: String(log.rating),
    reviewed_at: formatPythonIso(log.reviewed_at as Instant),
    elapsed_days: Number(log.elapsed_days),
    scheduled_days: Number(log.scheduled_days),
    interval_days: Number(log.interval_days),
    retrievability: Number(log.retrievability),
    is_lapse: log.is_lapse === true,
    phase_before: String(log.phase_before),
    phase_after: String(log.phase_after),
    stability_before: Number(log.stability_before),
    stability_after: Number(log.stability_after),
    difficulty_before: Number(log.difficulty_before),
    difficulty_after: Number(log.difficulty_after),
    due_before: log.due_before === null || log.due_before === undefined ? null : formatPythonIso(log.due_before as Instant),
    due_after: log.due_after === null || log.due_after === undefined ? null : formatPythonIso(log.due_after as Instant),
    scheduler_version: String(log.scheduler_version),
    params_version: String(log.params_version),
    source_session_item_id:
      log.source_session_item_id === null || log.source_session_item_id === undefined
        ? null
        : String(log.source_session_item_id),
    note: String(log.note ?? ''),
  }
}

/** `list_cards`: due first, suspended excluded by default. */
export function listCards(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { dueBefore?: string | null; includeSuspended?: boolean; limit?: number },
  now: Instant,
): Record<string, unknown>[] {
  requireProject(db, userId, projectId)
  const dueBefore =
    options.dueBefore === null || options.dueBefore === undefined || options.dueBefore === ''
      ? null
      : parseInstant(options.dueBefore)
  const rows = findRows(db, 'memory_card', { user_id: userId, project_id: projectId })
    .filter((card) => options.includeSuspended === true || card.is_suspended !== true)
    .filter((card) => {
      if (dueBefore === null) return true
      const due = (card.due_at ?? null) as Instant | null
      return due !== null && due <= dueBefore
    })
    .sort((a, b) => {
      const byDue = compareNullableInstant(a.due_at, b.due_at)
      return byDue !== 0 ? byDue : compareCreated(a, b)
    })
    .slice(0, clampLimit(options.limit))
  return rows.map((card) => cardPayload(db, card, now))
}

/**
 * `get_or_create_card`: ensure one card per (user, question); `created` says which happened.
 *
 * The question must be reachable through one of the caller's own projects, which is checked here
 * rather than trusted from the caller.
 */
export function getOrCreateCard(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
  now: Instant,
): { card: Record<string, unknown>; created: boolean } {
  requireProject(db, userId, projectId)
  const question = findOne(db, 'question_bank_question', { id: questionId })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  const project = subject === null ? null : findOne(db, 'exams_project', { id: String(subject.project_id) })
  if (question === null || subject === null || project === null) {
    throw new ScopeViolation('题目不存在或不属于该项目')
  }
  if (String(project.id) !== String(projectId)) throw new ScopeViolation('题目不存在或不属于该项目')
  if (String(project.owner_id) !== String(userId)) {
    throw new ScopeViolation('题目不存在或不在当前权限范围')
  }

  const existing = findOne(db, 'memory_card', { user_id: userId, question_id: questionId })
  if (existing !== null) return { card: existing, created: false }

  const card = insertRow(
    db,
    'memory_card',
    {
      user_id: userId,
      project_id: String(project.id),
      subject_id: String(subject.id),
      question_id: questionId,
      knowledge_node_id: primaryNode(db, questionId),
      phase: 'new',
      stability: 0,
      difficulty: 0,
      // A brand-new card is immediately available for recall practice.
      due_at: now,
      last_reviewed_at: null,
      reps: 0,
      lapses: 0,
      learning_step: 0,
      scheduler_version: FSRS_VERSION,
      params_version: FSRS_VERSION,
      desired_retention: DEFAULT_DESIRED_RETENTION,
      is_suspended: false,
      suspended_reason: '',
      note: '',
    },
    { now },
  )
  return { card, created: true }
}

function cardOr404(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  cardId: string,
): Record<string, unknown> {
  const card = findOne(db, 'memory_card', { id: cardId, user_id: userId, project_id: projectId })
  if (card === null) throw new ScopeViolation('记忆卡不存在或不属于该项目')
  return card
}

function normalizeRating(rating: unknown): string {
  const value = String(rating ?? '').trim().toLowerCase()
  if (!(RATINGS as readonly string[]).includes(value)) {
    throw new InvalidInput(`未知的记忆评级：'${String(rating ?? '')}'`, {
      details: { allowed: [...RATINGS] },
    })
  }
  return value
}

function validateKey(idempotencyKey: string): string {
  // Same rule as every other side-effecting route: trim, 409 when missing, 409 when > 200 points.
  return normaliseIdempotencyKey(idempotencyKey)
}

/** `_counters_at`: `(reps, lapses)` after this log, recomputed from the ledger. */
function countersAt(db: DatabaseSync, cardId: string, log: Record<string, unknown>): { reps: number; lapses: number } {
  const reviewedAt = log.reviewed_at as Instant
  const createdAt = log.created_at as Instant
  const rows = findRows(db, 'memory_review_log', { card_id: cardId }).filter((row) => {
    const at = row.reviewed_at as Instant
    if (at < reviewedAt) return true
    return at === reviewedAt && (row.created_at as Instant) <= createdAt
  })
  return {
    reps: rows.length,
    lapses: rows.filter((row) => row.is_lapse === true).length,
  }
}

/** `_result_from_log`: the review response, rebuilt from the stored log (so a replay matches). */
function resultFromLog(
  db: DatabaseSync,
  card: Record<string, unknown>,
  log: Record<string, unknown>,
  replayed: boolean,
): Record<string, unknown> {
  const counters = countersAt(db, String(card.id), log)
  return {
    card_id: String(card.id),
    log_id: String(log.id),
    rating: String(log.rating),
    phase: String(log.phase_after),
    phase_before: String(log.phase_before),
    due_at: log.due_after === null || log.due_after === undefined ? null : formatPythonIso(log.due_after as Instant),
    reviewed_at: formatPythonIso(log.reviewed_at as Instant),
    interval_days: Number(log.interval_days),
    elapsed_days: Number(log.elapsed_days),
    scheduled_days: Number(log.scheduled_days),
    retrievability: Number(log.retrievability),
    stability: Number(log.stability_after),
    difficulty: Number(log.difficulty_after),
    is_lapse: log.is_lapse === true,
    reps: counters.reps,
    lapses: counters.lapses,
    scheduler_version: String(log.scheduler_version),
    params_version: String(log.params_version),
    idempotent_replay: replayed,
  }
}

/**
 * `review_card`: record exactly one review of a card and reschedule it.
 *
 * Same key + same rating replays the stored log; same key + another rating is a 409; a blank key is
 * a 400. The card row is re-read inside the write transaction, so two concurrent reviews cannot both
 * start from the same state.
 */
export function reviewCard(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  cardId: string,
  payload: { rating: unknown; source_session_item_id?: string | null },
  idempotencyKey: string,
  now: Instant,
): Record<string, unknown> {
  const rating = normalizeRating(payload.rating)
  const key = validateKey(idempotencyKey)
  cardOr404(db, userId, projectId, cardId)
  return transaction(db, () => {
    const locked = findOne(db, 'memory_card', { id: cardId })
    if (locked === null) throw new ScopeViolation('记忆卡不存在或不在当前权限范围')
    if (locked.is_suspended === true) throw new InvalidInput('卡片已暂停，恢复后才能复习')

    const existing = findOne(db, 'memory_review_log', { card_id: cardId, idempotency_key: key })
    if (existing !== null) {
      if (String(existing.rating) !== rating) {
        throw new IdempotencyConflictError('相同幂等键使用了不同的评级', {
          details: {
            card_id: String(locked.id),
            stored_rating: String(existing.rating),
            rating,
          },
        })
      }
      return resultFromLog(db, locked, existing, true)
    }

    let sourceItemId: string | null = null
    if (payload.source_session_item_id !== null && payload.source_session_item_id !== undefined) {
      const item = findOne(db, 'practice_session_item', { id: String(payload.source_session_item_id) })
      const session = item === null ? null : findOne(db, 'practice_session', { id: String(item.session_id) })
      if (
        item === null ||
        session === null ||
        String(session.user_id) !== String(locked.user_id) ||
        String(session.project_id) !== String(locked.project_id)
      ) {
        throw new ScopeViolation('题项不存在或不属于该项目的当前用户')
      }
      sourceItemId = String(item.id)
    }

    const stateBefore = cardState(locked)
    const result = schedule(stateBefore, rating, now, {
      weights: weightsFor(String(locked.params_version)),
      desiredRetention: Number(locked.desired_retention),
    })

    const log = insertRow(
      db,
      'memory_review_log',
      {
        card_id: String(locked.id),
        user_id: String(locked.user_id),
        rating,
        reviewed_at: now,
        elapsed_days: result.elapsedDays,
        scheduled_days: stateBefore.scheduledDays,
        interval_days: result.intervalDays,
        retrievability: result.retrievability,
        is_lapse: result.isLapse,
        phase_before: stateBefore.phase,
        phase_after: result.phaseAfter,
        stability_before: stateBefore.stability,
        stability_after: result.state.stability,
        difficulty_before: stateBefore.difficulty,
        difficulty_after: result.state.difficulty,
        due_before: stateBefore.dueAt,
        due_after: result.state.dueAt,
        scheduler_version: result.schedulerVersion,
        params_version: String(locked.params_version),
        idempotency_key: key,
        source_session_item_id: sourceItemId,
        note: '',
      },
      { now },
    )

    updateRow(
      db,
      'memory_card',
      locked.id,
      {
        phase: result.state.phase,
        stability: result.state.stability,
        difficulty: result.state.difficulty,
        due_at: result.state.dueAt,
        last_reviewed_at: result.state.lastReviewedAt,
        reps: result.state.reps,
        lapses: result.state.lapses,
        learning_step: result.state.learningStep,
        scheduler_version: result.schedulerVersion,
      },
      { now },
    )
    return resultFromLog(db, locked, log, false)
  })
}

/** `recent_logs`: newest first, capped: the ledger is append-only, so this is a real window. */
export function recentLogs(
  db: DatabaseSync,
  cardId: string,
  limit: number | null | undefined,
): Record<string, unknown>[] {
  return findRows(db, 'memory_review_log', { card_id: cardId })
    .sort((a, b) => {
      const left = a.reviewed_at as Instant
      const right = b.reviewed_at as Instant
      if (left !== right) return Number(right - left)
      const leftCreated = a.created_at as Instant
      const rightCreated = b.created_at as Instant
      if (leftCreated !== rightCreated) return Number(rightCreated - leftCreated)
      return String(a.id) < String(b.id) ? -1 : 1
    })
    .slice(0, clampLogLimit(limit))
}

export function listLogs(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  cardId: string,
  limit: number | null | undefined,
): Record<string, unknown>[] {
  cardOr404(db, userId, projectId, cardId)
  return recentLogs(db, cardId, limit).map(logPayload)
}

/** `_state_payload`: the comparable facts of one card state. */
function statePayload(
  state: CardState,
  schedulerVersion: string,
  paramsVersion: string,
): Record<string, unknown> {
  return {
    phase: state.phase,
    stability: state.stability,
    difficulty: state.difficulty,
    reps: state.reps,
    lapses: state.lapses,
    learning_step: state.learningStep,
    due_at: state.dueAt === null ? null : formatPythonIso(state.dueAt),
    last_reviewed_at: state.lastReviewedAt === null ? null : formatPythonIso(state.lastReviewedAt),
    scheduler_version: schedulerVersion,
    params_version: paramsVersion,
  }
}

/**
 * `rebuild_card_from_logs`: recompute a card by replaying its logs; report whether it still matches.
 *
 * Recovery evidence (acceptance B06): the logs are the ledger, the card row is only a projection.
 * Each log is replayed with the `params_version` it recorded, in `reviewed_at` order, so a card whose
 * row was edited by hand — or written by an older parameter set — is detected instead of trusted.
 * Nothing is written here, so the caller decides how to recover.
 */
export function rebuildCardFromLogs(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  cardId: string,
): Record<string, unknown> {
  const card = cardOr404(db, userId, projectId, cardId)
  const logs = findRows(db, 'memory_review_log', { card_id: cardId }).sort((a, b) => {
    const left = a.reviewed_at as Instant
    const right = b.reviewed_at as Instant
    if (left !== right) return Number(left - right)
    const leftCreated = a.created_at as Instant
    const rightCreated = b.created_at as Instant
    if (leftCreated !== rightCreated) return Number(leftCreated - rightCreated)
    return String(a.id) < String(b.id) ? -1 : 1
  })
  let state: CardState = {
    stability: 0,
    difficulty: 0,
    phase: 'new',
    reps: 0,
    lapses: 0,
    learningStep: 0,
    lastReviewedAt: null,
    dueAt: null,
    scheduledDays: 0,
    elapsedDays: 0,
  }
  let paramsVersion = String(card.params_version)
  let schedulerVersion = String(card.scheduler_version)
  const unknownVersions: string[] = []
  for (const log of logs) {
    const logVersion = String(log.params_version)
    let weights = DEFAULT_WEIGHTS
    try {
      weights = weightsFor(logVersion)
    } catch {
      unknownVersions.push(logVersion)
    }
    const result = schedule(state, String(log.rating), log.reviewed_at as Instant, {
      weights,
      desiredRetention: Number(card.desired_retention),
    })
    state = result.state
    paramsVersion = logVersion
    schedulerVersion = String(log.scheduler_version)
  }
  const rebuilt = statePayload(state, schedulerVersion, paramsVersion)
  const stored = statePayload(
    cardState(card),
    String(card.scheduler_version),
    String(card.params_version),
  )
  // A card with no logs has never been scheduled, so its creation default for `due_at` is not
  // replayable and must not be reported as a mismatch.
  const compared = Object.keys(rebuilt).filter(
    (key) => logs.length > 0 || (key !== 'due_at' && key !== 'last_reviewed_at'),
  )
  const differing = compared.filter((key) => rebuilt[key] !== stored[key])
  return {
    matches: differing.length === 0,
    rebuilt,
    stored,
    log_count: logs.length,
    compared_fields: compared,
    differing_fields: differing,
    unknown_params_versions: [...new Set(unknownVersions)].sort(),
  }
}

/** `suspend_card`: pause a card without touching its schedule. */
export function suspendCard(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  cardId: string,
  reason: string,
  now: Instant,
): Record<string, unknown> {
  cardOr404(db, userId, projectId, cardId)
  return transaction(db, () => {
    const locked = findOne(db, 'memory_card', { id: cardId })
    if (locked === null) throw new ScopeViolation('记忆卡不存在或不在当前权限范围')
    const updated = updateRow(db, 'memory_card', locked.id, {
      is_suspended: true,
      suspended_reason: pyCodePointSlice(reason, 0, 300),
    }, { now })!
    return cardPayload(db, updated, now)
  })
}

/** `resume_card`: resume a card; an overdue card stays overdue instead of being re-dated. */
export function resumeCard(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  cardId: string,
  now: Instant,
): Record<string, unknown> {
  cardOr404(db, userId, projectId, cardId)
  return transaction(db, () => {
    const locked = findOne(db, 'memory_card', { id: cardId })
    if (locked === null) throw new ScopeViolation('记忆卡不存在或不在当前权限范围')
    const updated = updateRow(db, 'memory_card', locked.id, {
      is_suspended: false,
      suspended_reason: '',
    }, { now })!
    return cardPayload(db, updated, now)
  })
}
