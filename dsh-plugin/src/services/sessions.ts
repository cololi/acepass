/**
 * Practice sessions: freeze the versions, then deliver the stem.
 *
 * Port of `backend/apps/practice/services/sessions.py` (creation + presentation).
 *
 * Two decisions are made here and nowhere else:
 *  - the versions are frozen **at creation** (version, answer, rubric, spec, mapping revision,
 *    max score), so a later edit cannot change what an existing item means;
 *  - `first_delivered_at` is written exactly once, on the first presentation. That instant is what
 *    submission timing and the delayed-verification interval are judged against, so recording it
 *    again on a refresh would silently reset the learner's clock.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { enqueue } from '../store/outbox.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation, VersionConflict } from './errors.ts'
import { requireProject, requireSubject } from './exams.ts'
import { isSealed, reasonMessage } from './sealing.ts'
import { delayedIntervalStatus, resolveTaskMode } from './learning_extra.ts'

export const SESSION_MODES = ['practice', 'verification', 'mock_exam'] as const
const SCORABLE_LEAF_TYPES: ReadonlySet<string> = new Set([
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'constructed_response',
])

export interface CreateSessionIn {
  subject_id: string
  mode?: string
  question_ids?: string[]
  task_id?: string | null
  duration_minutes?: number | null
  purpose?: string
}

/** `_latest_mapping_revision()`: the highest mapping revision, or 1 when there is none. */
function latestMappingRevision(db: DatabaseSync, versionId: string): number {
  const rows = findRows(db, 'knowledge_question_mapping', { question_version_id: versionId })
  if (rows.length === 0) return 1
  return Math.max(...rows.map((row) => Number(row.mapping_revision)))
}

/** Practice score: explicit per-question value, else the spec default, else refuse. */
function resolveMaxScore(
  version: Record<string, unknown>,
  spec: Record<string, unknown> | null,
): Decimal {
  if (version.practice_max_score !== null && version.practice_max_score !== undefined) {
    return version.practice_max_score as Decimal
  }
  const rules = (spec?.question_type_rules ?? {}) as Record<string, unknown>
  const rule = rules[String(version.question_type)]
  if (typeof rule === 'object' && rule !== null) {
    const raw = (rule as Record<string, unknown>)['default_max_score']
    if (raw !== null && raw !== undefined && raw !== '') return Decimal.parse(String(raw))
  }
  throw new InvalidInput('无法确定该题分值：请填写题目练习分值，或选择已配置该题型默认分值的考试规范', {
    details: { question_version_id: String(version.id), question_type: String(version.question_type) },
  })
}

/** Pick the trusted answer and its rubric, or refuse to build an item. */
function resolveTrustedAnswer(
  db: DatabaseSync,
  versionId: string,
): { answer: Record<string, unknown>; rubric: Record<string, unknown> | null } | null {
  const answers = findRows(db, 'question_bank_answer_key_version', {
    question_version_id: versionId,
    verification_status: 'checked',
    is_disputed: false,
  }).sort((a, b) => Number(b.version) - Number(a.version))
  const answer = answers[0]
  if (answer === undefined) return null
  const rubric = findOne(db, 'question_bank_rubric_version', { answer_key_version_id: String(answer.id) })
  return { answer, rubric }
}

export function createSession(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: CreateSessionIn,
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  if (project.is_archived === true) throw new InvalidInput('已归档项目不能新建练习会话')
  const mode = String(payload.mode ?? 'practice')
  if (!(SESSION_MODES as readonly string[]).includes(mode)) throw new InvalidInput('会话模式无效')
  const subject = requireSubject(db, userId, projectId, payload.subject_id)
  if (payload.duration_minutes !== null && payload.duration_minutes !== undefined && mode !== 'mock_exam') {
    // The mode may be decided by a task; an explicit exam length that would be ignored is a client
    // mistake, not a no-op.
    throw new InvalidInput('只有模拟考试（mock_exam）支持 duration_minutes；该会话的用途由任务决定', {
      details: { mode },
    })
  }
  if (mode === 'mock_exam' && (payload.duration_minutes === null || payload.duration_minutes === undefined)) {
    // The spec-derived duration is not ported yet, so an unknown length is refused rather than
    // producing an open-ended exam. Refusing is also what Python does when neither source exists.
    throw new InvalidInput('模拟考试必须显式给出时长（分钟）；该考试规范没有可用的题型时长')
  }
  let questionIds = (payload.question_ids ?? []).map(String)
  // A task decides the mode and the question; the client cannot downgrade a check to practice.
  let task: Record<string, unknown> | null = null
  let purpose = String(payload.purpose ?? 'practice')
  if (payload.task_id !== undefined && payload.task_id !== null && String(payload.task_id) !== '') {
    task = findOne(db, 'learning_study_task', { id: String(payload.task_id) })
    if (task === null) throw new ScopeViolation('学习任务不存在或不属于该项目')
    if (String(task.user_id) !== String(userId) || String(task.project_id) !== String(project.id)) {
      throw new ScopeViolation('学习任务不存在或不属于该项目')
    }
    if (String(task.subject_id) !== String(subject.id)) {
      throw new ScopeViolation('学习任务不属于当前项目/科目')
    }
    // Re-check the real interval here as well: the API may create a session straight from a task id.
    const interval = delayedIntervalStatus(db, task, now)
    if (!interval.satisfied) {
      throw new InvalidInput(interval.reason === '' ? '该验证任务尚未到期，不能开始' : interval.reason, {
        details: { not_before: interval.not_before ?? null, task_id: String(task.id) },
      })
    }
    // The task decides the mode; a client asking for something else is ignored (Django's
    // `resolve_task_mode`), never an error.
    purpose = String(task.task_kind ?? purpose)
    if (task.question_id !== null && task.question_id !== undefined) questionIds = [String(task.question_id)]
  } else if (!['practice', 'paired_immediate'].includes(purpose)) {
    // A client must not be able to *claim* a purpose that unlocks a different flow.
    throw new InvalidInput('不能由客户端指定该会话用途；请通过对应的学习任务开始', { details: { purpose } })
  }
  if (questionIds.length === 0) throw new InvalidInput('请提供题目或学习任务')

  const spec =
    findRows(db, 'exams_spec_version', { subject_id: subject.id, status: 'published' }).sort(
      (a, b) => Number(b.version) - Number(a.version),
    )[0] ?? null

  const resolvedMode = task === null ? mode : resolveTaskMode(String(task.task_kind ?? ''), mode)
  return transaction(db, () => {
    if (task !== null) {
      updateRow(
        db,
        'learning_study_task',
        task.id,
        { status: 'in_progress', started_at: task.started_at ?? now },
        { now },
      )
    }
    const examStartedAt = resolvedMode === 'mock_exam' ? now : null
    const session = insertRow(
      db,
      'practice_session',
      {
        user_id: userId,
        project_id: project.id,
        subject_id: subject.id,
        mode: resolvedMode,
        status: 'active',
        policy_version: 'p0-1',
        note: `purpose=${purpose}`,
        exam_started_at: examStartedAt,
        exam_deadline:
          resolvedMode === 'mock_exam'
            ? examStartedAt! + BigInt(Math.trunc(Number(payload.duration_minutes))) * 60_000_000n
            : null,
        finished_at: null,
        revealed_at: null,
        expired_at: null,
        origin_task_id: task === null ? null : task.id,
      },
      { now },
    )

    const pending = [...questionIds]
    let ordinal = 0
    while (pending.length > 0) {
      const questionId = pending.shift()!
      const version = findRows(db, 'question_bank_question_version', {
        question_id: questionId,
        status: 'published',
      }).sort((a, b) => Number(b.version) - Number(a.version))[0]
      if (version === undefined) {
        throw new InvalidInput('题目没有已发布版本，不能用于练习', { details: { question_id: questionId } })
      }
      const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
      if (question === null || String(question.subject_id) !== String(subject.id)) {
        throw new ScopeViolation('题目不属于当前科目', { details: { question_id: questionId } })
      }
      // A sealed question (or a member of a sealed family) never enters a practice session, and the
      // decision comes from the single resolver so this path cannot disagree with search.
      const sealed = isSealed(db, projectId, String(question.id))
      if (sealed.sealed) {
        // Django refuses sealed content with 403 `purpose_not_allowed` (not a 404): the content
        // exists, it may not be used for practice. A 404 would read as "deleted" and the browser
        // suite (rightly) treats it as a contract drift.
        throw new PurposeNotAllowed(reasonMessage(sealed.code), { details: { reason_code: sealed.code } })
      }

      const questionType = String(version.question_type)
      if (!SCORABLE_LEAF_TYPES.has(questionType)) {
        // A material parent is never a submittable item: its children are.
        const children = ((version.material_child_version_ids ?? []) as unknown[]).map(String)
        for (const childVersionId of children) {
          const child = findOne(db, 'question_bank_question_version', { id: childVersionId, status: 'published' })
          if (child !== null) pending.push(String(child.question_id))
        }
        continue
      }

      const trusted = resolveTrustedAnswer(db, String(version.id))
      if (trusted === null) {
        throw new InvalidInput('该题没有已核对且无争议的答案，不能进入计分练习', {
          details: { question_id: questionId },
        })
      }
      const maxScore = resolveMaxScore(version, spec)
      if (questionType === 'constructed_response') {
        if (trusted.rubric === null) {
          throw new InvalidInput('大题缺少评分标准（rubric），不能建题项', { details: { question_id: questionId } })
        }
        if (String(trusted.rubric.total_score) !== String(maxScore)) {
          throw new InvalidInput(
            `rubric 总分 ${trusted.rubric.total_score} 与本次计分满分 ${maxScore.toString()} 不一致；请提供匹配的答案/rubric 版本`,
            { details: { question_id: questionId } },
          )
        }
      }

      ordinal += 1
      insertRow(
        db,
        'practice_session_item',
        {
          session_id: session.id,
          ordinal,
          question_version_id: version.id,
          answer_key_version_id: trusted.answer.id,
          rubric_version_id: trusted.rubric === null ? null : trusted.rubric.id,
          spec_version_id: spec === null ? null : spec.id,
          mapping_revision: latestMappingRevision(db, String(version.id)),
          max_score: maxScore,
          purpose,
          pairing_id: task === null ? null : task.pairing_id ?? null,
          tutoring_allowed: resolvedMode === 'practice' && purpose !== 'delayed_verification',
          first_delivered_at: null,
          draft: {},
          draft_revision: 0,
          paper_item_id: null,
        },
        { now },
      )
    }
    if (ordinal === 0) throw new InvalidInput('没有可用于本次会话的计分题项')

    return { ...session, item_count: ordinal }
  })
}

/** Stem and options only: no correct markers, no answer, no rubric. */
export function stemPayload(db: DatabaseSync, version: Record<string, unknown>): Record<string, unknown> {
  const content = (version.content ?? {}) as Record<string, unknown>
  const options = (Array.isArray(content['options']) ? content['options'] : [])
    .filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null)
    .map((option) => ({
      id: option['id'],
      label: option['label'] ?? option['id'],
      blocks: option['blocks'] ?? [],
    }))
  const parent =
    version.parent_material_version_id === null || version.parent_material_version_id === undefined
      ? null
      : findOne(db, 'question_bank_question_version', { id: String(version.parent_material_version_id) })
  return {
    question_version_id: String(version.id),
    question_type: version.question_type,
    blocks: content['blocks'] ?? [],
    options,
    blanks: (Array.isArray(content['blanks']) ? content['blanks'] : [])
      .filter((blank): blank is Record<string, unknown> => typeof blank === 'object' && blank !== null)
      .map((blank) => ({ blank_id: blank['blank_id'], label: blank['label'] ?? blank['blank_id'] })),
    blank_ids: (Array.isArray(content['blanks']) ? content['blanks'] : [])
      .filter((blank): blank is Record<string, unknown> => typeof blank === 'object' && blank !== null)
      .filter((blank) => blank['blank_id'])
      .map((blank) => String(blank['blank_id'])),
    material:
      parent === null
        ? null
        : {
            blocks: ((parent.content ?? {}) as Record<string, unknown>)['blocks'] ?? [],
            child_version_ids: parent.material_child_version_ids ?? [],
          },
  }
}

export interface PresentationResult {
  session_item_id: string
  session_id: string
  mode: string
  status: string
  ordinal: number
  max_score: string
  purpose: string
  tutoring_allowed: boolean
  first_delivery: boolean
  /** Django serialises the stamp as ISO text; `null` before the first delivery is impossible here. */
  first_delivered_at: string
  server_time: string
  draft: Record<string, unknown>
  draft_revision: number
  stem: Record<string, unknown>
  assets: string[]
  grading_hidden: boolean
  exam_started_at: string | null
  exam_deadline: string | null
  expired_at: string | null
}

/** `apps/ingestion/services/access.py::presentation_asset_ids` — reviewed image blocks only. */
export function presentationAssetIds(content: unknown): Set<string> {
  const allowed = new Set<string>()
  const record = (content ?? {}) as Record<string, unknown>
  const blocks: unknown[] = Array.isArray(record.blocks) ? [...record.blocks] : []
  for (const key of ['options', 'blanks']) {
    const rows = Array.isArray(record[key]) ? (record[key] as unknown[]) : []
    for (const row of rows) {
      const blocksOfRow = (row as Record<string, unknown> | null)?.blocks
      if (Array.isArray(blocksOfRow)) blocks.push(...blocksOfRow)
    }
  }
  for (const block of blocks) {
    const entry = block as Record<string, unknown> | null
    if (entry !== null && typeof entry === 'object' && entry.kind === 'image' && entry.asset_id) {
      allowed.add(String(entry.asset_id))
    }
  }
  return allowed
}

/** `deliverable_asset_ids`: the version's own stem assets plus its material parent's. */
function deliverableAssetIds(db: DatabaseSync, version: Record<string, unknown>): Set<string> {
  const allowed = presentationAssetIds(version.content)
  const parentId = version.parent_material_version_id
  if (parentId !== null && parentId !== undefined) {
    const parent = findOne(db, 'question_bank_question_version', { id: String(parentId) })
    if (parent !== null) for (const id of presentationAssetIds(parent.content)) allowed.add(id)
  }
  return allowed
}

/**
 * Deliver one item, recording the first delivery exactly once.
 *
 * A refresh must not move `first_delivered_at`: that instant governs submission timing and the
 * delayed interval, and resetting it would quietly extend the learner's clock. The payload is
 * Django's `presentation()` field-for-field: the practice page restores its draft, attachments,
 * exam clock and tutoring gate from it, so a shorter projection silently loses learner work.
 */
export function presentItem(
  db: DatabaseSync,
  userId: string,
  sessionItemId: string,
  now: Instant,
): PresentationResult {
  return transaction(db, () => {
    const item = findOne(db, 'practice_session_item', { id: sessionItemId })
    if (item === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
    let session = findOne(db, 'practice_session', { id: String(item.session_id) })
    if (session === null || String(session.user_id) !== String(userId)) {
      throw new ScopeViolation('题项不存在或不在当前权限范围')
    }
    // A stale tab that reconnects after the deadline sees the exam finished, never a run still open.
    session = expireSessionIfDue(db, session, now)
    const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
    if (version === null) throw new ScopeViolation('题项不存在或不在当前权限范围')

    let firstDelivery = false
    let deliveredAt = item.first_delivered_at as Instant | null
    if (deliveredAt === null) {
      deliveredAt = now
      firstDelivery = true
      updateRow(db, 'practice_session_item', item.id, { first_delivered_at: now }, { now })
      // The delivery ledger is append-only: this row is the evidence that the learner was shown the
      // stem, and it is what the "assisted" dimension later judges against.
      const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
      insertRow(
        db,
        'practice_exposure_event',
        {
          user_id: userId,
          project_id: session.project_id,
          question_id: version.question_id,
          question_version_id: version.id,
          family_id: question?.family_id ?? null,
          content_lineage_id: question?.content_lineage_id ?? null,
          session_item_id: item.id,
          kind: 'stem_delivered',
          purpose: session.mode === 'mock_exam' ? 'verification' : String(session.mode),
          source: 'session_item_presentation',
          server_time: now,
          reveals_answer: false,
          detail: { first_delivery: true },
        },
        { now },
      )
    }

    const examStarted = session.exam_started_at
    const examDeadline = session.exam_deadline
    const expiredAt = session.expired_at
    return {
      session_item_id: String(item.id),
      session_id: String(session.id),
      mode: String(session.mode),
      status: String(session.status),
      ordinal: Number(item.ordinal),
      max_score: String(item.max_score),
      purpose: String(item.purpose ?? ''),
      tutoring_allowed: Boolean(item.tutoring_allowed) && session.mode === 'practice',
      first_delivery: firstDelivery,
      first_delivered_at: formatPythonIso(deliveredAt as Instant),
      server_time: formatPythonIso(now),
      draft: (item.draft ?? {}) as Record<string, unknown>,
      draft_revision: Number(item.draft_revision ?? 0),
      stem: stemPayload(db, version),
      assets: [...deliverableAssetIds(db, version)].sort(),
      grading_hidden: session.mode === 'verification' || session.mode === 'mock_exam'
        ? session.status === 'active'
        : false,
      exam_started_at: examStarted === null || examStarted === undefined ? null : formatPythonIso(examStarted as Instant),
      exam_deadline: examDeadline === null || examDeadline === undefined ? null : formatPythonIso(examDeadline as Instant),
      expired_at: expiredAt === null || expiredAt === undefined ? null : formatPythonIso(expiredAt as Instant),
    }
  })
}

/** `reconcile_item_session`: an item read path finishes an exam whose deadline has passed. */
export function reconcileItemSession(
  db: DatabaseSync,
  sessionItemId: string,
  now: Instant,
): Record<string, unknown> {
  const item = findOne(db, 'practice_session_item', { id: sessionItemId })
  if (item === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  return expireSessionIfDue(db, session, now)
}

/**
 * Draft save with optimistic locking (`sessions.py::save_draft`).
 *
 * The revision check is what keeps two tabs from overwriting each other's answers; a stale tab gets
 * 409 instead of silently winning. An already-submitted item is not editable — the attempt is the
 * record of what was answered.
 */
export function saveDraft(
  db: DatabaseSync,
  userId: string,
  sessionItemId: string,
  draft: Record<string, unknown>,
  draftRevision: number | null,
  now: Instant,
): { session_item_id: string; draft_revision: number; draft_updated_at: string; saved: boolean } {
  return transaction(db, () => {
    const item = findOne(db, 'practice_session_item', { id: sessionItemId })
    if (item === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
    let session = findOne(db, 'practice_session', { id: String(item.session_id) })
    if (session === null || String(session.user_id) !== String(userId)) {
      throw new ScopeViolation('题项不存在或不在当前权限范围')
    }
    session = expireSessionIfDue(db, session, now)
    if (session.status !== 'active') throw new InvalidInput('会话已结束，不能再保存草稿')
    const existing = findOne(db, 'practice_attempt', { session_item_id: sessionItemId })
    if (existing !== null) throw new InvalidInput('该题项已提交，作答不可编辑；如需重做请新建题项')
    const current = Number(item.draft_revision ?? 0)
    if (draftRevision !== null && Number(draftRevision) !== current) {
      throw new VersionConflict('草稿已在其他标签页更新，请刷新后再编辑', {
        details: { expected: draftRevision, actual: current },
      })
    }
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new InvalidInput('草稿必须是对象')
    }
    const updated = updateRow(
      db,
      'practice_session_item',
      item.id,
      { draft, draft_revision: current + 1, draft_updated_at: now },
      { now },
    )!
    return {
      session_item_id: String(updated.id),
      draft_revision: Number(updated.draft_revision),
      draft_updated_at: formatPythonIso(now),
      saved: true,
    }
  })
}

export interface RevealPayload {
  question_version_id: string
  answer_key_version_id: string | null
  answer_payload: Record<string, unknown>
  answer_source_type: string | null
  answer_verification_status: string | null
  check_basis: string
  explanation_blocks: unknown[]
  rubric: Record<string, unknown> | null
  confidence_note: string
  exposure_recorded: boolean
}

/** `sessions.py::reveal_payload` — the trusted answer and the reviewed explanation. */
export function revealPayload(db: DatabaseSync, item: Record<string, unknown>): RevealPayload {
  const answerId = item.answer_key_version_id
  const answer = answerId === null || answerId === undefined
    ? null
    : findOne(db, 'question_bank_answer_key_version', { id: String(answerId) })
  const usable = answer !== null && answer.verification_status === 'checked' && answer.is_disputed !== true
  let confidenceNote = ''
  if (answer === null) {
    confidenceNote = '该题没有可用答案，仅能提供已审核的人工解析（若有）。'
  } else if (!usable) {
    confidenceNote = '该题答案尚未核对或存在争议；此处内容不作为判分依据。'
  }
  let rubric: Record<string, unknown> | null = null
  if (item.rubric_version_id !== null && item.rubric_version_id !== undefined) {
    const row = findOne(db, 'question_bank_rubric_version', { id: String(item.rubric_version_id) })
    if (row !== null) {
      rubric = {
        rubric_version_id: String(row.id),
        criteria: row.criteria ?? [],
        total_score: String(row.total_score),
      }
    }
  }
  return {
    question_version_id: String(item.question_version_id),
    answer_key_version_id: answer === null ? null : String(answer.id),
    answer_payload: (answer?.answer_payload ?? {}) as Record<string, unknown>,
    answer_source_type: answer === null ? null : String(answer.source_type),
    answer_verification_status: answer === null ? null : String(answer.verification_status),
    check_basis: answer === null ? '' : String(answer.check_basis ?? ''),
    explanation_blocks: Array.isArray(answer?.explanation_blocks) ? (answer!.explanation_blocks as unknown[]) : [],
    rubric,
    confidence_note: confidenceNote,
    exposure_recorded: false,
  }
}

/**
 * `sessions.py::assert_reveal_allowed`.
 *
 * Practice may always reveal. A verification or exam may not, before submitting; and a run that
 * still hides its grading must finish first — otherwise "show me the answer" would be the score.
 */
export function assertRevealAllowed(
  session: Record<string, unknown>,
  beforeSubmit: boolean,
): void {
  if (session.mode === 'practice') return
  if (beforeSubmit) {
    throw new PurposeNotAllowed('验证/考试模式在提交前不提供答案或完整讲解')
  }
  const hidden =
    (session.mode === 'verification' || session.mode === 'mock_exam') && session.status === 'active'
  if (hidden) {
    throw new PurposeNotAllowed(
      session.mode === 'mock_exam'
        ? '模拟考试尚未结束：交卷或到达服务器截止时间后才能查看答案与讲解'
        : '验证尚未结束：请先结束本次验证，再查看答案与讲解',
    )
  }
}

/** The reveal exposure row (`exposure.record` with `kind=answer_delivered`). */
export function recordRevealExposure(
  db: DatabaseSync,
  userId: string,
  item: Record<string, unknown>,
  session: Record<string, unknown>,
  source: string,
  detail: Record<string, unknown>,
  now: Instant,
): void {
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
  insertRow(
    db,
    'practice_exposure_event',
    {
      user_id: userId,
      project_id: session.project_id,
      question_id: question?.id ?? null,
      question_version_id: item.question_version_id,
      family_id: question?.family_id ?? null,
      content_lineage_id: question?.content_lineage_id ?? null,
      session_item_id: item.id,
      kind: 'answer_delivered',
      purpose: session.mode === 'practice' ? 'practice' : 'verification',
      source,
      server_time: now,
      reveals_answer: true,
      detail,
    },
    { now },
  )
}

/**
 * Finish a mock exam whose server-owned deadline has passed.
 *
 * Safe to call from every read path: the fast path is a pure in-memory check, and when the deadline
 * has passed the row is re-read inside one transaction so two concurrent readers produce exactly
 * one transition. The exam ends at the *deadline*, never at the moment the expiry was noticed;
 * `expired_at` records when the server reconciled it. A manual finish leaves `expired_at` null.
 *
 * Returns the (possibly updated) session row.
 */
export function expireSessionIfDue(
  db: DatabaseSync,
  session: Record<string, unknown>,
  now: Instant,
): Record<string, unknown> {
  if (session.mode !== 'mock_exam' || session.status !== 'active') return session
  const deadline = effectiveDeadline(session)
  if (deadline === null || now < deadline) return session
  return transaction(db, () => {
    const locked = findOne(db, 'practice_session', { id: String(session.id) })
    if (locked === null || locked.mode !== 'mock_exam' || locked.status !== 'active') return locked ?? session
    const lockedDeadline = effectiveDeadline(locked)
    if (lockedDeadline === null || now < lockedDeadline) return locked
    return finishLocked(db, locked, lockedDeadline, now, now)
  })
}

/** `sessions.py::_exam_is_due` — a mock exam whose deadline has passed and that is still active. */
function examIsDue(session: Record<string, unknown>, moment: Instant): boolean {
  if (session.mode !== 'mock_exam' || session.status !== 'active') return false
  const deadline = effectiveDeadline(session)
  return deadline !== null && moment >= deadline
}

export const SESSION_FINISHED_TOPIC = 'learning.on_session_finished'

/**
 * The single writer of the finished state (`sessions.py::_finish_locked`), shared by the manual
 * finish and the deadline expiry.
 *
 * Everything Django does in that one helper happens here, because each part is observable:
 *  - `status`/`finished_at` move once;
 *  - a verification or mock exam reveals its grading at the moment it ends (`revealed_at`), a plain
 *    practice session leaves the column alone;
 *  - the task that opened the session is marked `completed` with `completed_at = finished_at`;
 *  - exactly one `learning.on_session_finished` event is enqueued (the dedupe key is the session, so a
 *    repeated finish cannot produce a second one).
 *
 * `now` is when the server wrote the row; `finished_at` may be earlier (an exam ends at its deadline).
 */
function finishLocked(
  db: DatabaseSync,
  locked: Record<string, unknown>,
  finishedAt: Instant,
  now: Instant,
  expiredAt: Instant | null,
): Record<string, unknown> {
  const revealsGrading = locked.mode === 'verification' || locked.mode === 'mock_exam'
  const patch: Record<string, unknown> = {
    status: 'finished',
    finished_at: finishedAt,
    // Django always saves `revealed_at`; for a practice session the stored value is unchanged.
    revealed_at: revealsGrading ? finishedAt : (locked.revealed_at ?? null),
  }
  if (expiredAt !== null) patch.expired_at = expiredAt
  const finished = updateRow(db, 'practice_session', locked.id, patch, { now })!
  if (locked.origin_task_id !== null && locked.origin_task_id !== undefined) {
    // Django updates unconditionally (`filter(...).update(...)`), so a missing task is a no-op rather
    // than an error: the session may outlive the plan that created it.
    updateRow(
      db,
      'learning_study_task',
      locked.origin_task_id,
      { status: 'completed', completed_at: finishedAt },
      { now },
    )
  }
  enqueue(db, {
    topic: SESSION_FINISHED_TOPIC,
    payload: { session_id: String(finished.id) },
    dedupeKey: `session-finished:${String(finished.id)}`,
    now,
  })
  return finished
}

/** The stored deadline wins; a legacy row with only `exam_started_at` has no derivable end here. */
function effectiveDeadline(session: Record<string, unknown>): Instant | null {
  if (session.exam_deadline !== null && session.exam_deadline !== undefined) {
    return session.exam_deadline as Instant
  }
  return null
}

/**
 * Sweep every overdue mock exam of one owner.
 *
 * This is the read-path reconciliation Django's `expire_due_mock_exams` performs before a report
 * builds its exclusion counts: a run whose tab was closed for good must not keep hiding its scores.
 * Idempotent: every finish goes through {@link expireSessionIfDue}.
 */
export function expireDueMockExams(db: DatabaseSync, userId: string, now: Instant): number {
  let expired = 0
  for (const session of findRows(db, 'practice_session', { user_id: userId, mode: 'mock_exam', status: 'active' })) {
    const wasActive = session.status === 'active'
    const updated = expireSessionIfDue(db, session, now)
    if (wasActive && updated.status === 'finished') expired += 1
  }
  return expired
}

/**
 * Finish a session explicitly (the learner ends it).
 *
 * Django's `finish_session`: a manual submit that arrives *after* the server-owned deadline does not
 * extend the exam — it records the same end an automatic expiry would (`finished_at` = the deadline,
 * `expired_at` = the moment the server noticed), and a second finish is a no-op. All of the finished
 * state comes from {@link finishLocked}, which also enqueues `learning.on_session_finished` once.
 */
export function finishSession(
  db: DatabaseSync,
  userId: string,
  sessionId: string,
  now: Instant,
): Record<string, unknown> {
  const session = findOne(db, 'practice_session', { id: sessionId })
  if (session === null || String(session.user_id) !== String(userId)) {
    throw new ScopeViolation('会话不存在或不在当前权限范围')
  }
  // Django short-circuits on `finished` only: an `abandoned` row (the demo-reset command is the sole
  // producer) would still be finished here, and matching that keeps the transition identical.
  if (session.status === 'finished') return session
  return transaction(db, () => {
    // Re-read under the write lock: a concurrent expiry must not be overwritten by a late manual
    // finish, and both paths have to agree on which one wrote the finished row.
    const locked = findOne(db, 'practice_session', { id: sessionId })
    if (locked === null || String(locked.user_id) !== String(userId)) {
      throw new ScopeViolation('会话不存在或不在当前权限范围')
    }
    if (locked.status === 'finished') return locked
    if (examIsDue(locked, now)) {
      return finishLocked(db, locked, effectiveDeadline(locked)!, now, now)
    }
    return finishLocked(db, locked, now, now, null)
  })
}
