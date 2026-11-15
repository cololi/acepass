/**
 * Paired A/B/C verification tasks.
 *
 * Port of `backend/apps/learning/services/pairing.py`. A human-reviewed pairing (A = baseline,
 * B = immediate check on the same knowledge point, C = delayed check) drives this module: grading an
 * A attempt creates B, grading B creates C at least `delay_hours` later.
 *
 * Three rules make the chain trustworthy, and each one is a decision here rather than an accident:
 *
 *  * **exactly one task per (user, pairing, origin item, kind).** A repeated explanation, a re-read, a
 *    later grading or a regrade must not mint a second B (or a second C per B). The generated schema
 *    has the partial unique index `uniq_paired_task_per_origin`; the service checks the natural key
 *    first so the ordinary replay never relies on a constraint violation;
 *  * **no task without a usable question.** An unpublished, non-scorable-leaf or untrusted-answer
 *    question produces an explicit `invalidated` task carrying the reason, never a task that will
 *    fail later at delivery time (and never a fabricated question);
 *  * **the delay is measured from real training.** The anchor is the one authoritative rule shared
 *    with the evidence projection (`domain/anchors.ts`), always including the triggering B submission
 *    — anchoring C on A's day-old event would make the "delayed" check due immediately (R06).
 *
 * Outbox: Django enqueues `learning.on_attempt_graded` from `create_initial_grade` and the worker
 * calls `on_attempt_graded`. This port exposes the same call as a plain service function; the Node
 * worker does not consume that topic yet, so the acceptance fixture and any HMAC-free caller invoke
 * `onAttemptGraded` directly (see the B8 report). Evidence rebuild is still worker-driven.
 */
import type { DatabaseSync } from 'node:sqlite'
import { latestLearningAnchor } from '../domain/anchors.ts'
import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import { pyFormatFixed, pyRound } from '../domain/pyfmt.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { loadAnchorFacts } from './evidence_rebuild.ts'
import { requireSubject } from './exams.ts'
import { InvalidInput, ScopeViolation, StructureInvalid } from './errors.ts'

/** `settings.DELAYED_VERIFICATION_HOURS` (`ACEPASS_DELAYED_VERIFICATION_HOURS`, default 24). */
export const DELAYED_VERIFICATION_HOURS = 24

const HOUR_MICROS = 3_600_000_000n

export const TASK_KIND_PAIRED_IMMEDIATE = 'paired_immediate'
export const TASK_KIND_DELAYED_VERIFICATION = 'delayed_verification'

export const TASK_STATUS_PENDING = 'pending'
export const TASK_STATUS_DEFERRED = 'deferred'
export const TASK_STATUS_INVALIDATED = 'invalidated'

/** `QuestionVersion.is_scorable_leaf`: a leaf type that can carry a score. */
const SCORABLE_LEAF_TYPES: ReadonlySet<string> = new Set([
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'constructed_response',
])

type Row = Record<string, unknown>

/** Python truthiness for the columns read here (`estimated_seconds` is an int). */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'bigint') return value !== 0n
  return true
}

/**
 * `_published_version`: the question's current published version, else its newest published one.
 *
 * A pairing points at a question *identity*, so which version gets delivered is resolved at task
 * creation time — the same place Django resolves it.
 */
export function publishedVersion(db: DatabaseSync, question: Row): Row | null {
  const currentId = question.current_published_version_id
  if (currentId !== null && currentId !== undefined) {
    return findOne(db, 'question_bank_question_version', { id: String(currentId) })
  }
  const published = findRows(db, 'question_bank_question_version', {
    question_id: question.id,
    status: 'published',
  }).sort((a, b) => Number(b.version) - Number(a.version))
  return published[0] ?? null
}

function trustedAnswer(db: DatabaseSync, versionId: string): Row | null {
  return (
    findRows(db, 'question_bank_answer_key_version', {
      question_version_id: versionId,
      verification_status: 'checked',
      is_disputed: false,
    })[0] ?? null
  )
}

/** `_estimate_minutes`: the version's own estimate, else the type's default. */
export function estimateMinutes(db: DatabaseSync, question: Row | null): number {
  if (question === null) return 2
  const version = publishedVersion(db, question)
  if (version === null) return 2
  const seconds = version.estimated_seconds
  if (pyTruthy(seconds)) return Math.max(1, pyRound(Number(seconds) / 60, 0))
  return version.question_type === 'constructed_response' ? 15 : version.question_type === 'fill_blank' ? 3 : 2
}

/**
 * `_anchor_for`: the anchor for one pairing node, with the triggering event always eligible.
 *
 * `includeMoment` is the event that *triggered* the task. For the delayed C task that is the
 * just-graded B attempt, and it must always be able to be the anchor.
 */
export function anchorFor(
  db: DatabaseSync,
  options: {
    userId: string
    projectId: string
    nodeId: string
    before: Instant
    includeMoment?: Instant | null
  },
): { anchor: Instant; source: string } {
  const facts = loadAnchorFacts(db, options.userId)
  const result = latestLearningAnchor(facts, {
    project_id: options.projectId,
    node_id: options.nodeId,
    before: formatPythonIso(options.before),
  })
  let anchor: Instant | null = result.anchor === null ? null : parseInstant(result.anchor)
  let source = result.source
  const moment = options.includeMoment ?? null
  if (moment !== null && (anchor === null || moment >= anchor)) {
    anchor = moment
    source = 'trigger_event'
  }
  if (anchor === null) {
    // No related event at all: the triggering event itself is the anchor.
    anchor = options.before
    source = 'current_event'
  }
  return { anchor, source }
}

/* ------------------------------------------------------------ the A/B/C pair */

export interface PairingCreateIn {
  subject_id: string
  node_id: string
  immediate_question_id: string
  delayed_question_id?: string | null
  baseline_question_id?: string | null
  delay_hours?: number
  note?: string
}

/** The rows a pairing write needs, resolved with Django's scope messages. */
export interface PairingTargets {
  subject: Row
  node: Row
  immediate: Row
  delayed: Row | null
  baseline: Row | null
}

/**
 * Resolve the pairing's node and questions exactly where `apps/knowledge/api.py::create_pairing`
 * does — *before* the idempotency claim, so a stale replay cannot outlive a scope that is gone.
 */
export function resolvePairingTargets(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: PairingCreateIn,
): PairingTargets {
  const subject = requireSubject(db, userId, projectId, String(payload.subject_id))
  const node = findOne(db, 'knowledge_node', { id: payload.node_id })
  if (node === null || !nodeBelongsToSubject(db, String(node.syllabus_version_id), String(subject.id))) {
    throw new ScopeViolation('考点不存在或不属于该科目')
  }
  const questionInSubject = (questionId: string | null | undefined, message: string): Row | null => {
    if (questionId === null || questionId === undefined || questionId === '') return null
    const question = findOne(db, 'question_bank_question', { id: questionId })
    if (question === null || String(question.subject_id) !== String(subject.id)) {
      throw new ScopeViolation(message)
    }
    return question
  }
  const immediate = questionInSubject(payload.immediate_question_id, 'B 题不存在或不属于该科目')
  if (immediate === null) throw new ScopeViolation('B 题不存在或不属于该科目')
  return {
    subject,
    node,
    immediate,
    delayed: questionInSubject(payload.delayed_question_id, 'C 题不存在或不属于该科目'),
    baseline: questionInSubject(payload.baseline_question_id, '基准题不存在或不属于该科目'),
  }
}

function nodeBelongsToSubject(db: DatabaseSync, syllabusVersionId: string, subjectId: string): boolean {
  const syllabus = findOne(db, 'exams_syllabus_version', { id: syllabusVersionId })
  return syllabus !== null && String(syllabus.subject_id) === subjectId
}

/**
 * `create_verification_pairing`: a human-reviewed A/B/C pairing, versioned per (project, subject,
 * node) so the history of a reviewed pairing stays readable.
 *
 * `full_clean(exclude=["project"])` is reproduced faithfully: the three questions must share the
 * subject, they must differ from each other, and the node must live in that subject's syllabus.
 * A violation is Django's `ValidationError` → 422 `structure_invalid` (see `apps/common/errors.py`).
 */
export function createVerificationPairing(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  targets: PairingTargets,
  options: { delayHours: number; note: string },
  now: Instant,
): Row {
  const { subject, node, immediate, delayed, baseline } = targets
  const subjectId = String(subject.id)
  if (!nodeBelongsToSubject(db, String(node.syllabus_version_id), subjectId)) {
    throw new ScopeViolation('考点不属于该科目的大纲版本')
  }
  for (const question of [baseline, immediate, delayed]) {
    if (question === null) continue
    if (String(question.subject_id) !== subjectId) throw new ScopeViolation('配对题目必须属于同一科目')
  }
  const delayHours = Number(options.delayHours)
  if (!(delayHours >= 1)) throw new InvalidInput('延迟验证间隔至少 1 小时')

  const questionIds = [baseline, immediate, delayed]
    .filter((question): question is Row => question !== null)
    .map((question) => String(question.id))
  if (new Set(questionIds).size !== questionIds.length) {
    // Django's `VerificationPairing.clean()` puts this under `immediate_question`.
    throw new StructureInvalid('结构校验失败', {
      details: { errors: { immediate_question: ['B/C 题必须是不同于基准题的其他稳定题目'] } },
    })
  }

  return transaction(db, () => {
    const previous = findRows(db, 'knowledge_verification_pairing', {
      project_id: projectId,
      subject_id: subjectId,
      node_id: node.id,
    })
    const current = previous.reduce((highest, row) => Math.max(highest, Number(row.pairing_version)), 0)
    const pairing = insertRow(
      db,
      'knowledge_verification_pairing',
      {
        project_id: projectId,
        subject_id: subjectId,
        node_id: node.id,
        baseline_question_id: baseline === null ? null : baseline.id,
        immediate_question_id: immediate.id,
        delayed_question_id: delayed === null ? null : delayed.id,
        pairing_version: current + 1,
        delay_hours: delayHours,
        is_active: true,
        reviewer_id: userId,
        reviewed_at: now,
        note: String(options.note ?? '').slice(0, 500),
      },
      { now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'verification_pairing',
        entity_id: String(pairing.id),
        action: 'create',
        project_id: projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { node_id: String(node.id), delay_hours: delayHours },
      },
      { now },
    )
    return pairing
  })
}

/**
 * `pairing_candidates`: published leaf questions mapped to this node, for the pairing form.
 *
 * The question list is the *primary* mappings of the node across every revision — Django reads
 * `node.question_mappings.filter(is_primary=True)` — so a question stays a candidate after a later
 * mapping revision moved it to auxiliary.
 */
export function pairingCandidates(
  db: DatabaseSync,
  nodeId: string,
  excludeQuestionIds: readonly string[] = [],
): Row[] {
  const exclude = new Set(excludeQuestionIds.map(String))
  const versionIds = new Set(
    findRows(db, 'knowledge_question_mapping', { node_id: nodeId, is_primary: true }).map((row) =>
      String(row.question_version_id),
    ),
  )
  const questionIds = new Set(
    findRows(db, 'question_bank_question_version', {})
      .filter((version) => versionIds.has(String(version.id)) && version.status === 'published')
      .map((version) => String(version.question_id)),
  )
  return findRows(db, 'question_bank_question', {})
    .filter((question) => questionIds.has(String(question.id)) && !exclude.has(String(question.id)))
    .sort((left, right) => compareText(String(left.display_label), String(right.display_label)))
}

/** Code-point comparison: `order_by("display_label")` without a locale collator. */
function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/* ------------------------------------------------------------ task creation */

const TASK_TABLE_COLUMNS = {
  estimated_minutes_source: 'default_by_type',
  rule_version: 'p0-1',
  deficit_notice: '',
  invalidated_reason: '',
} as const

interface CreateTaskInput {
  userId: string
  projectId: string
  subjectId: string
  taskKind: string
  question: Row | null
  nodeId: string
  pairing: Row
  originItemId: string | null
  triggerEvent: string
  reasonCodes: string[]
  notBefore: Instant | null
  delayAnchorAt: Instant | null
  estimatedMinutes: number
  deficitNotice?: string
}

function existingTask(db: DatabaseSync, input: CreateTaskInput): Row | null {
  return (
    findRows(db, 'learning_study_task', {
      user_id: input.userId,
      pairing_id: input.pairing.id,
      origin_session_item_id: input.originItemId,
      task_kind: input.taskKind,
    })[0] ?? null
  )
}

/**
 * `_create_task`: one task, or `(existing, false)` when the natural key already produced it.
 *
 * Returns `(null, false)` when the question cannot be delivered at all — that is not an error, it is
 * the caller's cue to record the missing paired question explicitly.
 */
export function createPairedTask(
  db: DatabaseSync,
  input: CreateTaskInput,
  now: Instant,
): { task: Row | null; created: boolean } {
  const version = input.question === null ? null : publishedVersion(db, input.question)
  if (version === null || !SCORABLE_LEAF_TYPES.has(String(version.question_type))) return { task: null, created: false }
  if (trustedAnswer(db, String(version.id)) === null) return { task: null, created: false }

  // Django relies on the partial unique index and catches `IntegrityError`. SQLite's nested
  // `transaction` is not a savepoint here, so the natural key is checked first and the insert is
  // still guarded: the ordinary replay (a repeated grading, a regrade) never reaches the constraint.
  const known = input.originItemId === null ? null : existingTask(db, input)
  if (known !== null) return { task: known, created: false }
  try {
    const task = transaction(db, () =>
      insertRow(
        db,
        'learning_study_task',
        {
          user_id: input.userId,
          project_id: input.projectId,
          subject_id: input.subjectId,
          task_kind: input.taskKind,
          status: TASK_STATUS_PENDING,
          question_id: input.question === null ? null : input.question.id,
          knowledge_node_id: input.nodeId,
          pairing_id: input.pairing.id,
          pairing_version: input.pairing.pairing_version,
          origin_session_item_id: input.originItemId,
          trigger_event: input.triggerEvent,
          delay_anchor_at: input.delayAnchorAt,
          not_before: input.notBefore,
          due_at: input.notBefore,
          estimated_minutes: input.estimatedMinutes,
          estimated_minutes_source: TASK_TABLE_COLUMNS.estimated_minutes_source,
          reason_codes: input.reasonCodes,
          evidence_ids: [],
          rule_version: TASK_TABLE_COLUMNS.rule_version,
          invalidated_reason: TASK_TABLE_COLUMNS.invalidated_reason,
          deficit_notice: String(input.deficitNotice ?? ''),
        },
        { now },
      ),
    )
    return { task, created: true }
  } catch (error) {
    const raced = input.originItemId === null ? null : existingTask(db, input)
    if (raced !== null) return { task: raced, created: false }
    throw error
  }
}

/**
 * `_record_missing_pair_question`: keep an explicit record and never fake one.
 *
 * The row is `invalidated` with `question_id = null` and the reason in `deficit_notice`, so the
 * review page can say "paired question missing" instead of showing a task that cannot be opened.
 */
function recordMissingPairQuestion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  pairing: Row,
  kind: 'immediate' | 'delayed',
  now: Instant,
): void {
  const label = kind === 'immediate' ? 'B' : 'C'
  const taskKind = kind === 'delayed' ? TASK_KIND_DELAYED_VERIFICATION : TASK_KIND_PAIRED_IMMEDIATE
  const existing = findRows(db, 'learning_study_task', {
    user_id: userId,
    project_id: projectId,
    subject_id: pairing.subject_id,
    task_kind: taskKind,
    origin_session_item_id: null,
    question_id: null,
    pairing_id: pairing.id,
  })[0]
  if (existing !== undefined) return
  insertRow(
    db,
    'learning_study_task',
    {
      user_id: userId,
      project_id: projectId,
      subject_id: pairing.subject_id,
      task_kind: taskKind,
      status: TASK_STATUS_INVALIDATED,
      question_id: null,
      knowledge_node_id: pairing.node_id,
      pairing_id: pairing.id,
      pairing_version: pairing.pairing_version,
      origin_session_item_id: null,
      trigger_event: 'missing_paired_question',
      reason_codes: ['missing_paired_question', `missing_${kind}`],
      evidence_ids: [],
      estimated_minutes: 0,
      estimated_minutes_source: TASK_TABLE_COLUMNS.estimated_minutes_source,
      rule_version: TASK_TABLE_COLUMNS.rule_version,
      deficit_notice:
        `缺少合格的${label}题：配对 ${String(pairing.id)} 未关联可用${label}题，` +
        '到期后只能用原题重复练习，不计入延迟验证证据。',
      invalidated_reason: `缺少合格的${label}题`,
    },
    { now },
  )
}

/** Pairings of one project, in the model's ordering (`subject, node, -pairing_version`). */
function pairingsFor(db: DatabaseSync, where: Row): Row[] {
  return findRows(db, 'knowledge_verification_pairing', { ...where, is_active: true }).sort((left, right) => {
    const subject = compareText(String(left.subject_id), String(right.subject_id))
    if (subject !== 0) return subject
    const node = compareText(String(left.node_id), String(right.node_id))
    if (node !== 0) return node
    return Number(right.pairing_version) - Number(left.pairing_version)
  })
}

/**
 * `on_attempt_graded`: trigger paired tasks from a confirmed grade on a baseline or B question.
 *
 * Returns the number of tasks created. Re-running it is safe and returns 0 the second time.
 */
export function onAttemptGraded(db: DatabaseSync, attemptId: string, now: Instant): number {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  if (attempt === null || attempt.current_grade_event_id === null) return 0
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) return 0
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) return 0
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  if (question === null) return 0

  const userId = String(attempt.user_id)
  const projectId = String(attempt.project_id)
  const submittedAt = attempt.submitted_at as Instant

  return transaction(db, () => {
    let created = 0

    // A graded → the immediate B check.
    for (const pairing of pairingsFor(db, { project_id: projectId, baseline_question_id: question.id })) {
      const immediate = findOne(db, 'question_bank_question', { id: String(pairing.immediate_question_id) })
      const result = createPairedTask(
        db,
        {
          userId,
          projectId,
          subjectId: String(pairing.subject_id),
          taskKind: TASK_KIND_PAIRED_IMMEDIATE,
          question: immediate,
          nodeId: String(pairing.node_id),
          pairing,
          originItemId: String(item.id),
          triggerEvent: 'confirmed_grade',
          reasonCodes: ['paired_immediate', 'same_knowledge_node'],
          notBefore: null,
          delayAnchorAt: null,
          estimatedMinutes: estimateMinutes(db, immediate),
        },
        now,
      )
      if (result.task === null) {
        recordMissingPairQuestion(db, userId, projectId, pairing, 'immediate', now)
        continue
      }
      created += result.created ? 1 : 0
    }

    // A graded B → the delayed C check, anchored on B's own completion.
    for (const pairing of pairingsFor(db, { project_id: projectId, immediate_question_id: question.id })) {
      if (pairing.delayed_question_id === null) {
        recordMissingPairQuestion(db, userId, projectId, pairing, 'delayed', now)
        continue
      }
      const delayHours = Number(pairing.delay_hours) || DELAYED_VERIFICATION_HOURS
      const anchor = anchorFor(db, {
        userId,
        projectId,
        nodeId: String(pairing.node_id),
        before: submittedAt,
        includeMoment: submittedAt,
      })
      const notBefore = anchor.anchor + BigInt(delayHours) * HOUR_MICROS
      const delayed = findOne(db, 'question_bank_question', { id: String(pairing.delayed_question_id) })
      const result = createPairedTask(
        db,
        {
          userId,
          projectId,
          subjectId: String(pairing.subject_id),
          taskKind: TASK_KIND_DELAYED_VERIFICATION,
          question: delayed,
          nodeId: String(pairing.node_id),
          pairing,
          originItemId: String(item.id),
          triggerEvent: 'paired_immediate_graded',
          reasonCodes: ['delayed_verification', `delay_${delayHours}h`, anchor.source],
          notBefore,
          delayAnchorAt: anchor.anchor,
          estimatedMinutes: estimateMinutes(db, delayed),
        },
        now,
      )
      if (result.task === null) {
        recordMissingPairQuestion(db, userId, projectId, pairing, 'delayed', now)
        continue
      }
      if (!result.created) continue
      insertRow(
        db,
        'learning_review_task',
        {
          user_id: userId,
          project_id: projectId,
          study_task_id: result.task.id,
          knowledge_node_id: pairing.node_id,
          delay_hours: delayHours,
          delay_anchor_at: anchor.anchor,
          not_before: notBefore,
          anchor_source: anchor.source,
          was_started: false,
          missing_question_reason: '',
        },
        { now },
      )
      created += 1
    }

    return created
  })
}

/**
 * `on_explanation_delivered`: trigger the immediate B task when an explanation is delivered on A.
 *
 * This covers "learned from the explanation, no attempt yet": B is created from the delivered A
 * item without inventing an attempt. Django (and this port) are careful about two things:
 *
 *  * **the explanation, not a grade, is the origin.** `origin_session_item` is the A item, so the
 *    natural key is `(user, pairing, A item, paired_immediate)` — a repeated reveal, a re-read of
 *    the same item or a later grading of the *same* A item never mint a second B (grading reuses the
 *    row the explanation created). Only a different session item is a different origin.
 *  * **no eligible question means no task at all.** Unlike `on_attempt_graded`, Django does not
 *    record an `invalidated` marker here: nothing was graded, so there is no evidence deficit to
 *    record. `createPairedTask` returns `(null, false)` and this function only counts creations.
 *
 * Not wired into reveal/tutoring: Django has no production caller for it (`grep -rn
 * on_explanation_delivered backend/apps`), only the integration test. Calling it from the Node
 * reveal path would create B tasks Django never creates, so it stays an explicit service call.
 */
export function onExplanationDelivered(db: DatabaseSync, itemId: string, now: Instant): number {
  const item = findOne(db, 'practice_session_item', { id: itemId })
  if (item === null) return 0
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null) return 0
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) return 0
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  if (question === null) return 0

  const userId = String(session.user_id)
  const projectId = String(session.project_id)
  let created = 0
  for (const pairing of pairingsFor(db, { project_id: projectId, baseline_question_id: question.id })) {
    const immediate = findOne(db, 'question_bank_question', { id: String(pairing.immediate_question_id) })
    const result = createPairedTask(
      db,
      {
        userId,
        projectId,
        subjectId: String(pairing.subject_id),
        taskKind: TASK_KIND_PAIRED_IMMEDIATE,
        question: immediate,
        nodeId: String(pairing.node_id),
        pairing,
        originItemId: String(item.id),
        triggerEvent: 'explanation_delivered',
        reasonCodes: ['paired_immediate', 'explanation_first'],
        notBefore: null,
        delayAnchorAt: null,
        estimatedMinutes: estimateMinutes(db, immediate),
      },
      now,
    )
    if (result.created) created += 1
  }
  return created
}

/* --------------------------------------------------- delayed re-anchoring */

/** `_delay_hours_for`: the interval this task was created with, never silently defaulted to 0. */
function delayHoursFor(task: Row, review: Row | null): number {
  if (review !== null && pyTruthy(review.delay_hours)) return Number(review.delay_hours)
  const codes = (task.reason_codes ?? []) as unknown[]
  for (const code of codes) {
    if (typeof code !== 'string' || !code.startsWith('delay_') || !code.endsWith('h')) continue
    const value = Number(code.slice('delay_'.length, -1))
    if (Number.isFinite(value)) return Math.trunc(value)
  }
  return DELAYED_VERIFICATION_HOURS
}

function reviewTaskOf(db: DatabaseSync, studyTaskId: string): Row | null {
  return findRows(db, 'learning_review_task', { study_task_id: studyTaskId })[0] ?? null
}

/**
 * `reconcile_delayed_tasks`: push `not_before` later when a newer related training event appears.
 *
 * Runs before starting a delayed task and from the periodic sweep. Returns how many tasks moved.
 */
export function reconcileDelayedTasks(db: DatabaseSync, now: Instant): number {
  let updated = 0
  const pending = findRows(db, 'learning_review_task', { was_started: false })
  for (const review of pending) {
    const task = findOne(db, 'learning_study_task', { id: String(review.study_task_id) })
    if (task === null) continue
    if (task.status !== TASK_STATUS_PENDING && task.status !== TASK_STATUS_DEFERRED) continue
    const anchor = anchorFor(db, {
      userId: String(review.user_id),
      projectId: String(review.project_id),
      nodeId: String(review.knowledge_node_id ?? task.knowledge_node_id ?? ''),
      before: now,
    })
    const expected = anchor.anchor + BigInt(Number(review.delay_hours)) * HOUR_MICROS
    const current = (review.not_before ?? null) as Instant | null
    if (current !== null && expected <= current) continue
    transaction(db, () => {
      updateRow(
        db,
        'learning_review_task',
        review.id,
        { not_before: expected, delay_anchor_at: anchor.anchor, anchor_source: anchor.source },
        { now },
      )
      updateRow(
        db,
        'learning_study_task',
        task.id,
        {
          delay_anchor_at: anchor.anchor,
          not_before: expected,
          due_at: expected,
          reason_codes: [...((task.reason_codes ?? []) as unknown[]), 'anchor_updated'],
        },
        { now },
      )
    })
    updated += 1
  }
  return updated
}

export interface DelayIntervalStatus {
  required: boolean
  satisfied: boolean
  reason: string
  not_before?: string | null
  stored_not_before?: string
  recomputed_not_before?: string | null
  anchor_source?: string
}

/**
 * `delayed_interval_status`: re-check the real interval before starting a delayed task.
 *
 * The stored `not_before` is a snapshot, not the truth: a *new* training event on the same knowledge
 * point moves the real deadline forward, so a task whose stored deadline has passed may still not be
 * startable. A task with no stored deadline at all stays unstartable — "we forgot to freeze a
 * deadline" must not silently become "no delay required".
 */
export function delayedIntervalStatus(db: DatabaseSync, task: Row, now: Instant): DelayIntervalStatus {
  if (task.task_kind !== TASK_KIND_DELAYED_VERIFICATION) {
    return { required: false, satisfied: true, reason: '' }
  }
  const review = reviewTaskOf(db, String(task.id))
  const codes = (task.reason_codes ?? []) as unknown[]
  const anchorSource =
    review !== null
      ? String(review.anchor_source ?? '')
      : codes.length === 0
        ? 'unknown'
        : String(codes[codes.length - 1])
  const notBefore = (task.not_before ?? null) as Instant | null
  if (notBefore === null) {
    return {
      required: true,
      satisfied: false,
      reason: '延迟验证任务缺少可开始的截止时间，需重新核对锚点后再开始',
      not_before: null,
    }
  }
  const delayHours = delayHoursFor(task, review)
  const storedAnchor = ((review === null ? null : review.delay_anchor_at) ?? task.delay_anchor_at ?? null) as
    | Instant
    | null
  const anchor = anchorFor(db, {
    userId: String(task.user_id),
    projectId: String(task.project_id),
    nodeId: String(task.knowledge_node_id ?? ''),
    before: now,
  })
  // Only a learning event that happened *after* the task was created moves the deadline; a manual
  // correction of `not_before` therefore stays a correction instead of being silently undone.
  const recomputed =
    storedAnchor === null || anchor.anchor > storedAnchor
      ? anchor.anchor + BigInt(delayHours) * HOUR_MICROS
      : null
  const requiredAt = recomputed !== null && recomputed > notBefore ? recomputed : notBefore
  if (now < requiredAt) {
    const remaining = Number(requiredAt - now) / 3_600_000_000
    const moved = recomputed !== null && recomputed > notBefore
    return {
      required: true,
      satisfied: false,
      reason:
        `延迟验证需等待：还需约 ${pyFormatFixed(remaining, 2)} 小时（锚点 ` +
        `${anchor.source || anchorSource || 'unknown'}${moved ? '，期间有新的训练/讲解，截止时间已顺延' : ''}）`,
      not_before: formatPythonIso(requiredAt),
      stored_not_before: formatPythonIso(notBefore),
      recomputed_not_before: recomputed === null ? null : formatPythonIso(recomputed),
      anchor_source: anchor.source || anchorSource,
    }
  }
  return {
    required: true,
    satisfied: true,
    reason: '',
    not_before: formatPythonIso(requiredAt),
    stored_not_before: formatPythonIso(notBefore),
    recomputed_not_before: recomputed === null ? null : formatPythonIso(recomputed),
    anchor_source: anchor.source || anchorSource,
  }
}
