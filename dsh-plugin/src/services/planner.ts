/**
 * The daily planner: what to practise today, and why.
 *
 * Port of `backend/apps/learning/services/planner.py` (generate + candidate categories).
 *
 * A plan is a **fixed category order** filled from one shared per-project budget:
 * due delayed verification → due memory review → weak points → undiagnosed probes → general practice.
 * The order is the product decision: a check that is due outranks new practice, and an undiagnosed
 * point is probed before more practice on something already diagnosed.
 *
 * Two properties matter more than the ordering itself:
 *  - **a task is only offered when the question is still usable** — published, checked answer,
 *    not AI-derived, not sealed. A withdrawn question must never come back through another channel;
 *  - **a refresh never disturbs started work.** Only pending/deferred tasks are replaced; anything the
 *    learner has begun keeps its row, so the plan revision is auditable rather than destructive.
 */
import type { DatabaseSync } from 'node:sqlite'
import { type Instant, formatPythonIso } from '../domain/instant.ts'
import { DEFAULT_MINUTES_BY_TYPE, RULE_VERSION, allocateBudget } from '../domain/planner.ts'
import { SUMMARY } from '../domain/state.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { enqueue } from '../store/outbox.ts'
import { getStudySettings } from './accounts.ts'
// The prerequisite graph is one implementation for the planner and the knowledge page
// (`relations.py::unmet_prerequisites`), so the two surfaces cannot disagree about "unmet".
import { compareText, unmetPrerequisites } from './knowledge_extra.ts'
import { isSealed, reasonMessage } from './sealing.ts'

/** `settings.local_date(moment)`: the date in the learner's timezone, `YYYY-MM-DD`. */
export function localDateIn(timezone: string, now: Instant): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone === '' ? 'UTC' : timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    // `Instant` is microseconds; `Date` wants milliseconds.
  }).formatToParts(new Date(Number(now / 1_000n)))
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${read('year')}-${read('month')}-${read('day')}`
}

const TASK_PENDING = 'pending'
const TASK_DEFERRED = 'deferred'

export interface PlanCandidate {
  task_id: string | null
  task_kind: string
  question_id: string | null
  question_label: string
  knowledge_node_id: string | null
  knowledge_node_name: string
  project_id: string
  subject_id: string
  estimated_minutes: number
  reason_codes: string[]
  evidence_ids: string[]
  pairing_version: string | null
  not_before: string | null
  deficit_notice: string
  memory_card_id?: string | null
}

/** Minutes a question is expected to take. */
export function questionMinutes(version: Record<string, unknown> | null): number {
  if (version === null) return 2
  const seconds = version.estimated_seconds
  if (seconds !== null && seconds !== undefined && Number(seconds) > 0) {
    // Python's `round()` is half-to-even, and `Math.round` is not; 90s must not become 2 minutes.
    return Math.max(1, Math.round(Number(seconds) / 60))
  }
  return DEFAULT_MINUTES_BY_TYPE.get(String(version.question_type)) ?? 2
}

/** A question may be scheduled only while its content still deserves to be practised. */
export function eligibility(
  db: DatabaseSync,
  projectId: string,
  questionId: string | null,
): { ok: boolean; reason: string; version: Record<string, unknown> | null } {
  if (questionId === null) return { ok: false, reason: '没有关联题目', version: null }
  const version = findRows(db, 'question_bank_question_version', { question_id: questionId, status: 'published' }).sort(
    (a, b) => Number(b.version) - Number(a.version),
  )[0] ?? null
  if (version === null) return { ok: false, reason: '题目没有已发布版本', version: null }
  // Sealing is checked through the single resolver on every candidate category at once, so a sealed
  // question cannot arrive through a mapping, a memory card or the general pool.
  const sealed = isSealed(db, projectId, questionId)
  if (sealed.sealed) return { ok: false, reason: reasonMessage(sealed.code), version }
  const answer = findRows(db, 'question_bank_answer_key_version', {
    question_version_id: String(version.id),
    verification_status: 'checked',
    is_disputed: false,
  })[0]
  if (answer === undefined) return { ok: false, reason: '题目缺少已核对且无争议的答案', version }
  if (String(answer.source_type) === 'ai_derived') {
    return { ok: false, reason: 'AI 推导答案尚未通过独立验证', version }
  }
  return { ok: true, reason: '', version }
}

function publicEligibility(db: DatabaseSync, projectId: string, questionId: string | null): boolean {
  const question = questionId === null ? null : findOne(db, 'question_bank_question', { id: questionId })
  if (question !== null && question.is_demo === true) return false
  return eligibility(db, projectId, questionId).ok
}

/** Due cards only: a card still waiting out its interval is not "reviewed early". */
export function memoryReviewCandidates(
  db: DatabaseSync,
  projectId: string,
  now: Instant,
  limit = 10,
): PlanCandidate[] {
  const rows: PlanCandidate[] = []
  for (const card of findRows(db, 'memory_card', {})) {
    if (rows.length >= limit) break
    const dueAt = card.due_at as Instant | null
    if (dueAt !== null && dueAt > now) continue
    const questionId = card.question_id === null ? null : String(card.question_id)
    if (!publicEligibility(db, projectId, questionId)) continue
    const version = findRows(db, 'question_bank_question_version', { question_id: questionId, status: 'published' })[0]
    const question = findOne(db, 'question_bank_question', { id: questionId })
    rows.push({
      task_id: null,
      task_kind: 'memory_review',
      question_id: questionId,
      question_label: question === undefined || question === null ? '' : String(question.display_label),
      knowledge_node_id: card.knowledge_node_id === null ? null : String(card.knowledge_node_id),
      knowledge_node_name: '',
      project_id: projectId,
      subject_id: String(question?.subject_id ?? ''),
      // Recall is deliberately cheap: half the solving estimate, at least a minute.
      estimated_minutes: Math.max(1, Math.floor(questionMinutes(version ?? null) / 2)),
      reason_codes: ['memory_due'],
      evidence_ids: [],
      pairing_version: null,
      not_before: null,
      deficit_notice: '',
      memory_card_id: String(card.id),
    })
  }
  return rows
}

/** Checks that are due: existing delayed-verification tasks, oldest first. */
export function delayedTaskCandidates(
  db: DatabaseSync,
  projectId: string,
  now: Instant,
  limit = 20,
): PlanCandidate[] {
  const due = findRows(db, 'learning_study_task', { project_id: projectId, task_kind: 'delayed_verification' })
    .filter((task) => task.status === TASK_PENDING || task.status === TASK_DEFERRED)
    .filter((task) => task.due_at === null || (task.due_at as Instant) <= now)
    .sort((a, b) => String(a.due_at ?? '').localeCompare(String(b.due_at ?? '')))
    .slice(0, limit)

  const rows: PlanCandidate[] = []
  for (const task of due) {
    const questionId = task.question_id === null ? null : String(task.question_id)
    if (!publicEligibility(db, projectId, questionId)) continue
    const version = findRows(db, 'question_bank_question_version', { question_id: questionId, status: 'published' })[0]
    const question = findOne(db, 'question_bank_question', { id: questionId })
    rows.push({
      task_id: String(task.id),
      task_kind: 'delayed_verification',
      question_id: questionId,
      question_label: question === undefined || question === null ? '' : String(question.display_label),
      knowledge_node_id: task.knowledge_node_id === null ? null : String(task.knowledge_node_id),
      knowledge_node_name: '',
      project_id: projectId,
      subject_id: String(question?.subject_id ?? ''),
      estimated_minutes: questionMinutes(version ?? null),
      // `_task_candidate(:170)` prefixes the plan reason to the task's own codes, so the stored row
      // says both *why it is in today's plan* and *how the task came to exist*. Django re-prefixes
      // on every regeneration, so a second refresh accumulates the marker again — reproduced here.
      reason_codes: ['due_delayed_verification', ...((task.reason_codes ?? []) as string[])],
      evidence_ids: [],
      pairing_version: null,
      not_before: task.due_at === null ? null : formatPythonIso(task.due_at as Instant),
      deficit_notice: '',
    })
  }
  return rows
}

/**
 * A representative question mapped to one node, if any is still usable.
 *
 * This is the looser lookup the undiagnosed branch has always used (any mapping, first usable one).
 * The weak-repair branch uses `questionForWeakRepair` below, which follows Django's
 * `_question_for_node`; the two differ, and that divergence is recorded in `var/b10/parity-notes.md`
 * because Django's `undiagnosed_candidates` reads primary mappings directly instead of going through
 * `_question_for_node`.
 */
function questionForNode(db: DatabaseSync, projectId: string, nodeId: string): string | null {
  for (const mapping of findRows(db, 'knowledge_question_mapping', { node_id: nodeId })) {
    const version = findOne(db, 'question_bank_question_version', { id: String(mapping.question_version_id) })
    if (version === null) continue
    const questionId = String(version.question_id)
    if (publicEligibility(db, projectId, questionId)) return questionId
  }
  return null
}

/**
 * `planner.py::_question_for_node`: the question the weak branch offers for one knowledge node.
 *
 * A reviewed A/B/C pairing is the designed check for the node, so its immediate question wins over
 * the generic primary mapping; only when no active pairing yields a usable question does Django fall
 * back to `QuestionKnowledge.filter(is_primary=True, question_version__status="published").first()`.
 * `.first()` is exactly one attempt — an unusable primary mapping means "no question", it is not
 * replaced by the next mapping (Django's behaviour is copied, not fixed).
 */
function questionForWeakRepair(db: DatabaseSync, projectId: string, nodeId: string): string | null {
  // Django orders pairings by the model Meta (`project, subject, node, -pairing_version`); the
  // project and node are fixed by the filter, so the remaining key is `(subject, -pairing_version)`.
  const pairings = findRows(db, 'knowledge_verification_pairing', { project_id: projectId, node_id: nodeId })
    .filter((pairing) => pairing.is_active === true)
    .sort(
      (left, right) =>
        compareText(String(left.subject_id), String(right.subject_id)) ||
        Number(right.pairing_version) - Number(left.pairing_version),
    )
  for (const pairing of pairings) {
    const questionId = String(pairing.immediate_question_id)
    if (publicEligibility(db, projectId, questionId)) return questionId
  }
  // `QuestionKnowledge` Meta ordering is `question_version, mapping_revision, node`; UUID text
  // comparison is bytewise in both SQLite and PostgreSQL, so the order survives the port.
  const mapping = findRows(db, 'knowledge_question_mapping', { node_id: nodeId })
    .filter((row) => row.is_primary === true)
    .filter((row) => {
      const version = findOne(db, 'question_bank_question_version', { id: String(row.question_version_id) })
      return version !== null && String(version.status) === 'published'
    })
    .sort(
      (left, right) =>
        compareText(String(left.question_version_id), String(right.question_version_id)) ||
        Number(left.mapping_revision) - Number(right.mapping_revision) ||
        compareText(String(left.node_id), String(right.node_id)),
    )[0]
  if (mapping === undefined) return null
  const version = findOne(db, 'question_bank_question_version', { id: String(mapping.question_version_id) })
  if (version === null) return null
  const questionId = String(version.question_id)
  return publicEligibility(db, projectId, questionId) ? questionId : null
}

/** `as_of` ordering: the projection stores microseconds, so compare exactly, not as a float. */
function compareInstant(left: unknown, right: unknown): number {
  const a = BigInt(left as bigint)
  const b = BigInt(right as bigint)
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Confirmed weak points, reordered by the prerequisite graph (`planner.py:256-329`).
 *
 * The switch is the **`needs_review` flag**, not the summary: Django selects
 * `needs_review=True` rows ordered by `-needs_review, as_of` (all selected rows share the flag, so
 * the effective order is `as_of`), capped at `max(1, min(limit, 50))`. A `needs_foundation` point
 * without recent failures is not repair work, and a `needs_review` point is, regardless of its
 * current summary. (`state.py::weak_nodes` — `needs_review=True OR summary in (needs_foundation,
 * completes_with_hints)` — is a different helper that this planner does not call.)
 *
 * A weak point whose foundation is not demonstrated yet is not practised directly: the prerequisite
 * is scheduled first and the reason codes say so (`prerequisite_first`, the gap's reason,
 * `unblocks:<weak point>` cut at 120 characters, `blocked_state_<summary>`). When the prerequisite
 * has no usable question the weak point is still offered, but the missing foundation is reported as
 * `prerequisite_missing_question` plus `deficit_notice` instead of being hidden.
 *
 * One question is scheduled at most once per pass: a state whose chosen question was already taken
 * (by an earlier state or its prerequisite) is dropped, not silently re-pointed elsewhere.
 */
export function weaklyKnownCandidates(db: DatabaseSync, projectId: string, limit = 20): PlanCandidate[] {
  // A project has exactly one learner, so the project scope carries the same guarantee as Django's
  // `filter(user=user, project=project)`; the `id` tie-break is ours (Django leaves equal `as_of`
  // rows unordered, which is not reproducible across databases).
  const states = findRows(db, 'learning_knowledge_state', { project_id: projectId })
    .filter((state) => state.needs_review === true)
    .sort(
      (left, right) => compareInstant(left.as_of, right.as_of) || compareText(String(left.id), String(right.id)),
    )
    .slice(0, Math.max(1, Math.min(limit, 50)))
  // The prerequisite graph needs *every* state of the project, not just the selected weak ones: a
  // prerequisite counts as satisfied only when its own state says so.
  const stateByNode = new Map<string, string>()
  for (const state of findRows(db, 'learning_knowledge_state', { project_id: projectId })) {
    stateByNode.set(String(state.node_id), String(state.summary))
  }
  const scheduled = new Set<string>()
  const rows: PlanCandidate[] = []
  for (const state of states) {
    const stateNode = findOne(db, 'knowledge_node', { id: String(state.node_id) })
    if (stateNode === null) continue
    const summary = String(state.summary)
    const unmet = unmetPrerequisites(db, stateNode, stateByNode)
    let chosen: string | null = null
    let target = stateNode
    let usedFallback = false
    let reasonCodes = ['weakness_repair', `state_${summary}`]
    if (unmet.length > 0) {
      // `unmet` is already ordered by node name; the first gap that owns a usable question wins.
      for (const gap of unmet) {
        const questionId = questionForWeakRepair(db, projectId, String(gap.node_id))
        if (questionId === null) continue
        const gapNode = findOne(db, 'knowledge_node', { id: String(gap.node_id) })
        if (gapNode === null) continue
        chosen = questionId
        target = gapNode
        reasonCodes = [
          'prerequisite_first',
          String(gap.reason),
          `unblocks:${String(stateNode.canonical_name)}`.slice(0, 120),
          `blocked_state_${summary}`,
        ]
        break
      }
      if (chosen === null) {
        usedFallback = true
        reasonCodes.push('prerequisite_missing_question')
      }
    }
    if (chosen === null) {
      chosen = questionForWeakRepair(db, projectId, String(state.node_id))
      target = stateNode
    }
    if (chosen === null || scheduled.has(chosen)) continue
    scheduled.add(chosen)
    let deficitNotice = ''
    if (unmet.length > 0 && usedFallback) {
      deficitNotice = `前置考点「${String(unmet[0].node_name)}」尚无可练习题目：先用可用题目练习，前置缺口已记录，不计入该考点的独立掌握证据`
    }
    const question = findOne(db, 'question_bank_question', { id: chosen })
    // `_question_minutes`: `current_published_version`, else the highest version at all.
    const versions = findRows(db, 'question_bank_question_version', { question_id: chosen }).sort(
      (left, right) => Number(right.version) - Number(left.version),
    )
    const currentVersionId = question?.current_published_version_id
    const version =
      currentVersionId === null || currentVersionId === undefined
        ? versions[0]
        : (versions.find((candidate) => String(candidate.id) === String(currentVersionId)) ?? versions[0])
    rows.push({
      task_id: null,
      task_kind: 'weakness_repair',
      question_id: chosen,
      question_label: question === null ? '' : String(question.display_label),
      knowledge_node_id: String(target.id),
      knowledge_node_name: String(target.canonical_name),
      project_id: projectId,
      subject_id: String(question?.subject_id ?? ''),
      estimated_minutes: questionMinutes(version ?? null),
      reason_codes: reasonCodes,
      // Django keeps the first ten evidence rows on the candidate (`planner.py:323`).
      evidence_ids: ((state.source_evidence_ids ?? []) as string[]).slice(0, 10),
      pairing_version: null,
      not_before: null,
      deficit_notice: deficitNotice,
    })
  }
  return rows
}

/**
 * Nodes with **no state row at all**: probing them is what turns "unknown" into a diagnosis.
 *
 * Port of `planner.py::undiagnosed_candidates`. Two details matter and both were wrong before:
 *
 *  - the exclusion set is "any state exists for this node", not "the state summary is undiagnosed".
 *    A node whose projection says `needs_foundation` has been diagnosed; probing it again would be a
 *    duplicate. Django's queryset yields UUIDs while the mapping loop compares strings, so its
 *    `node_id in diagnosed` was always False (W3); this port compares the normalised string ids of
 *    the *fixed* Django implementation.
 *  - candidates come from **primary mappings**, ordered by the node's canonical name, one question
 *    per node and at most `limit` rows. A question is only offered when `_eligible_question` would
 *    accept it (current published version, not sealed, checked undisputed non-AI answer).
 */
export function undiagnosedCandidates(db: DatabaseSync, projectId: string, limit = 20): PlanCandidate[] {
  const diagnosed = new Set(
    findRows(db, 'learning_knowledge_state', { project_id: projectId }).map((state) => String(state.node_id)),
  )
  const ordered: Array<{ mapping: Record<string, unknown>; nodeName: string }> = []
  for (const mapping of findRows(db, 'knowledge_question_mapping', {})) {
    // `is_primary` is a boolean column (stored as 0/1); the raw row keeps the boolean.
    if (mapping.is_primary !== true) continue
    const version = findOne(db, 'question_bank_question_version', { id: String(mapping.question_version_id) })
    if (version === null || String(version.status) !== 'published') continue
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
    if (question === null) continue
    const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
    if (subject === null || String(subject.project_id) !== projectId) continue
    const node = findOne(db, 'knowledge_node', { id: String(mapping.node_id) })
    if (node === null) continue
    ordered.push({ mapping, nodeName: String(node.canonical_name) })
  }
  // Django orders by `node__canonical_name`; ties have no guaranteed order, so the node id is a
  // deterministic tie-breaker. Python/PostgreSQL collation can differ from code-point order for
  // non-ASCII names; the probe fixture keeps the names in one collation class (recorded boundary).
  ordered.sort(
    (left, right) =>
      compareText(left.nodeName, right.nodeName) ||
      compareText(String(left.mapping.node_id), String(right.mapping.node_id)),
  )

  const rows: PlanCandidate[] = []
  const seen = new Set<string>()
  for (const { mapping, nodeName } of ordered) {
    const nodeId = String(mapping.node_id)
    if (diagnosed.has(nodeId) || seen.has(nodeId)) continue
    const version = findOne(db, 'question_bank_question_version', { id: String(mapping.question_version_id) })
    if (version === null) continue
    const questionId = String(version.question_id)
    if (!publicEligibility(db, projectId, questionId)) continue
    seen.add(nodeId)
    const question = findOne(db, 'question_bank_question', { id: questionId })
    // `_question_minutes` reads the *current* published version, not the mapped one.
    const versions = findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
      (left, right) => Number(right.version) - Number(left.version),
    )
    const currentId = question?.current_published_version_id
    const minutesVersion =
      currentId === null || currentId === undefined
        ? versions[0]
        : (versions.find((entry) => String(entry.id) === String(currentId)) ?? versions[0])
    rows.push({
      task_id: null,
      task_kind: 'undiagnosed_probe',
      question_id: questionId,
      question_label: question === null ? '' : String(question.display_label),
      knowledge_node_id: nodeId,
      knowledge_node_name: nodeName,
      project_id: projectId,
      subject_id: String(question?.subject_id ?? ''),
      estimated_minutes: questionMinutes(minutesVersion ?? null),
      reason_codes: ['undiagnosed_node'],
      evidence_ids: [],
      pairing_version: null,
      not_before: null,
      deficit_notice: '',
    })
    if (rows.length >= limit) break
  }
  return rows
}

/** Everything else that is usable, as the pool of last resort. */
export function generalCandidates(db: DatabaseSync, projectId: string, limit = 20): PlanCandidate[] {
  const rows: PlanCandidate[] = []
  for (const question of findRows(db, 'question_bank_question', {})) {
    if (rows.length >= limit) break
    const questionId = String(question.id)
    const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
    if (subject === null || String(subject.project_id) !== String(projectId)) continue
    const check = eligibility(db, projectId, questionId)
    if (!check.ok) continue
    const version = check.version
    rows.push({
      task_id: null,
      task_kind: 'general_practice',
      question_id: questionId,
      question_label: String(question.display_label ?? ''),
      knowledge_node_id: null,
      knowledge_node_name: '',
      project_id: projectId,
      subject_id: String(question.subject_id),
      estimated_minutes: questionMinutes(version),
      reason_codes: ['general_practice'],
      evidence_ids: [],
      pairing_version: null,
      not_before: null,
      deficit_notice: '',
    })
  }
  return rows
}

function materialiseTask(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  planId: string,
  candidate: PlanCandidate,
  now: Instant,
): string | null {
  if (candidate.task_id !== null) {
    // An existing task is reused, not duplicated: the plan points at the work already queued, and
    // its reason codes are rewritten to the candidate's list — Django's
    // `task.reason_codes = list(candidate["reason_codes"])`. TodayPage resolves its Chinese labels
    // from these codes, so a reused delayed check must carry `due_delayed_verification`.
    const task = findOne(db, 'learning_study_task', { id: candidate.task_id })
    if (task === null || (task.status !== TASK_PENDING && task.status !== TASK_DEFERRED)) return null
    updateRow(
      db,
      'learning_study_task',
      task.id,
      { plan_id: planId, reason_codes: candidate.reason_codes },
      { now },
    )
    return String(task.id)
  }
  const created = insertRow(
    db,
    'learning_study_task',
    {
      user_id: userId,
      project_id: projectId,
      subject_id: candidate.subject_id,
      question_id: candidate.question_id,
      knowledge_node_id: candidate.knowledge_node_id,
      task_kind: candidate.task_kind,
      status: TASK_PENDING,
      plan_id: planId,
      memory_card_id: candidate.memory_card_id ?? null,
      pairing_id: null,
      pairing_version: candidate.pairing_version,
      // A plan-created task records *no* triggering event: Django's `_materialise_task` does not
      // pass `trigger_event` and the model default is `''` (`models.py:129`). The reason codes are
      // what explains the task; `trigger_event` belongs to tasks a grade/explanation created.
      trigger_event: '',
      delay_anchor_at: null,
      not_before: candidate.not_before === null ? null : (candidate.not_before as unknown as Instant),
      due_at: candidate.not_before === null ? null : (candidate.not_before as unknown as Instant),
      estimated_minutes: Math.max(1, Math.trunc(candidate.estimated_minutes)),
      reason_codes: candidate.reason_codes,
      evidence_ids: candidate.evidence_ids,
      rule_version: RULE_VERSION,
      invalidated_reason: '',
      started_at: null,
      completed_at: null,
      // Django's `_materialise_task` (`planner.py:558-572`) does not copy the candidate's
      // `deficit_notice` onto the row, and neither does it set `estimated_minutes_source` — the
      // model defaults (`''` and `default_by_type`) are what a real Django row holds. Copied as-is
      // (like the duplicate `reason_codes` prefixes) rather than "improved" here.
      deficit_notice: '',
    },
    { now },
  )
  return String(created.id)
}

export interface GeneratePlanOptions {
  onDate?: string | null
  refresh?: boolean
  now: Instant
}

export function generatePlan(
  db: DatabaseSync,
  userId: string,
  options: GeneratePlanOptions,
): Record<string, unknown> {
  const { now } = options
  const settings = getStudySettings(db, userId, now)
  const localDate = options.onDate ?? localDateIn(String(settings.timezone ?? 'UTC'), now)
  const budget = Number(settings.daily_budget_minutes)
  const undiagnosedShare = Number(settings.undiagnosed_time_share_percent)

  const projects = findRows(db, 'exams_project', { owner_id: userId }).filter(
    (project) => project.is_archived !== true,
  )
  const existing = findRows(db, 'learning_study_plan', { user_id: userId, plan_date: localDate })[0] ?? null
  if (existing !== null && options.refresh !== true) return existing

  return transaction(db, () => {
    const allocation = allocateBudget({
      projects: projects.map((project) => ({
        id: String(project.id),
        name: String(project.name),
        target_date: project.target_date === null ? null : String(project.target_date),
        created_at: formatPythonIso(project.created_at as Instant),
      })),
      percentages: Object.entries((settings.project_budget_percent ?? {}) as Record<string, unknown>).map(
        ([key, value]) => [key, Number(value)],
      ) as Array<[string, number]>,
      budget_minutes: budget,
      on_date: localDate,
    })

    const revision = existing === null ? 1 : Number(existing.revision) + 1
    const plan = insertRow(
      db,
      'learning_study_plan',
      {
        user_id: userId,
        plan_date: localDate,
        timezone: String(settings.timezone ?? 'UTC'),
        revision,
        daily_budget_minutes: budget,
        allocated_minutes: 0,
        allocation: allocation.projects,
        project_order: allocation.project_order,
        rotation_offset: allocation.rotation_offset,
        rule_version: RULE_VERSION,
        notes: allocation.notes,
        generated_at: now,
      },
      { now },
    )

    if (existing !== null) {
      // A refresh replaces only work that has not started; anything begun keeps its row.
      for (const task of findRows(db, 'learning_study_task', { plan_id: existing.id })) {
        if (task.status !== TASK_PENDING && task.status !== TASK_DEFERRED) continue
        updateRow(
          db,
          'learning_study_task',
          task.id,
          { status: 'skipped', invalidated_reason: '计划刷新后被新修订替换' },
          { now },
        )
      }
    }

    let plannedMinutes = 0
    const notes: string[] = []
    for (const share of allocation.projects) {
      if (share.minutes <= 0) {
        notes.push(`${share.project_name}：本日分配 0 分钟，未安排任务（预算不足以容纳任何题目）`)
        continue
      }
      let remaining = share.minutes
      const reserve = Math.trunc((share.minutes * undiagnosedShare) / 100)
      let reserveUsed = 0
      const categories: Array<[string, PlanCandidate[]]> = [
        ['due_delayed_verification', delayedTaskCandidates(db, share.project_id, now)],
        ['memory_review', memoryReviewCandidates(db, share.project_id, now)],
        ['weakness_repair', weaklyKnownCandidates(db, share.project_id)],
        ['undiagnosed_probe', undiagnosedCandidates(db, share.project_id)],
        ['general_practice', generalCandidates(db, share.project_id)],
      ]
      let projectPlanned = 0
      for (const [category, candidates] of categories) {
        for (const candidate of candidates) {
          const cost = Math.max(1, Math.trunc(candidate.estimated_minutes))
          if (cost > remaining) continue
          const taskId = materialiseTask(db, userId, share.project_id, String(plan.id), candidate, now)
          if (taskId === null) continue
          remaining -= cost
          projectPlanned += cost
          if (category === 'undiagnosed_probe') reserveUsed += cost
        }
        if (remaining <= 0) break
      }
      plannedMinutes += projectPlanned
      if (reserve > 0 && reserveUsed < reserve) {
        notes.push(
          `${share.project_name}：未诊断内容预留 ${reserve} 分钟，本日实际安排 ${reserveUsed} 分钟（无更多合格未诊断题）`,
        )
      }
      if (remaining > 0) {
        notes.push(`${share.project_name}：仍有 ${remaining} 分钟未分配（没有能完整容纳的合格题目）`)
      }
    }

    const updated = updateRow(
      db,
      'learning_study_plan',
      plan.id,
      { allocated_minutes: plannedMinutes, notes: [...allocation.notes, ...notes] },
      { now },
    )!
    enqueue(db, {
      topic: 'plan.generated',
      payload: { plan_id: String(plan.id) },
      dedupeKey: `plan:${plan.id}`,
      now,
    })
    return updated
  })
}

/** Today's plan, or `null` when nothing has been generated for the date. */
export function currentPlan(
  db: DatabaseSync,
  userId: string,
  onDate: string,
): Record<string, unknown> | null {
  return findRows(db, 'learning_study_plan', { user_id: userId, plan_date: onDate })[0] ?? null
}

/** The tasks of one plan, in the order they were created. */
export function planTasks(db: DatabaseSync, planId: string): Record<string, unknown>[] {
  return findRows(db, 'learning_study_task', { plan_id: planId })
}
