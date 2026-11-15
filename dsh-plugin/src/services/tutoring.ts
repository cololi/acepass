/**
 * Tutoring: permission-gated, versioned, audited explanations.
 *
 * Port of `backend/apps/tutoring/services/core.py` plus the read half of
 * `backend/apps/tutoring/services/streaming.py` (validated segments, staleness, transcript).
 *
 * Flow (docs/02 §6): permission → freeze versions → retrieve linked material → build prompt →
 * call provider → validate structure and citations → store the validated result → reveal only that.
 *
 * An explanation never writes a score, a mastery state, a plan or a statistic. If the answer is not
 * trustworthy the tutor may only clarify conditions (R-INV 3).
 *
 * Two host adaptations are documented in the B8 report:
 *
 *  * the provider call runs **inline in the POST** (`run_tutor_job_now` in Python); the package
 *    enqueues no `tutoring.run_job` outbox event, because the DSH worker has no consumer for that
 *    topic and an unclaimed event would be a permanent failure rather than a retry;
 *  * there is no stub provider (R-INV 4), so `is_stub` is always false and a missing model is an
 *    honest `ai_not_configured` on the job row (never invented content).
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { markFailed, markRejected, markSucceeded, type LlmRunRecord } from '../ai/audit.ts'
import { CAPABILITIES as AI_CAPABILITIES, P0_CAPABILITIES, availabilityMessage } from '../ai/degrade.ts'
import { EXPLAIN_PROMPT_VERSION, buildExplainPrompt } from '../ai/prompts.ts'
import { parseModelJson, pyRepr, pySlice, pyStr, pyStrip } from '../ai/pyvalue.ts'
import { validateExplainPayload } from '../ai/validators.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import type { LlmPort } from '../llm/contract.ts'
import { transaction } from '../store/db.ts'
import { pyJsonCanonical } from '../store/pyjson.ts'
import { countRows, findOne, findRows, insertRow, updateRow, type Row } from '../store/repository.ts'
import { beginAuditedRun, finishAuditedRun, telemetryOf } from './ai_runs.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation } from './errors.ts'
import { verificationContentMap } from './learning.ts'
import { contentDigest } from './questions.ts'
import { isSealed, reasonMessage } from './sealing.ts'
import { blocksText } from './transcription.ts'

export const TUTOR_PURPOSES = ['hint', 'explanation', 'clarify', 'diagnose'] as const
export type TutorPurpose = (typeof TUTOR_PURPOSES)[number]

/** `TutorRequestStatus`: the terminal-for-streaming set is computed where it is used. */
export const TUTOR_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable',
  STALE: 'stale',
} as const

/** Block kinds the structured-output validator accepts; nothing else may reach a segment row. */
export const VALID_SEGMENT_KINDS: ReadonlySet<string> = new Set(['text', 'math', 'list'])

/** A job that can no longer change; `succeeded` only counts once its business commit landed. */
export function isTerminalJob(job: Row): boolean {
  if (job.status === TUTOR_STATUS.FAILED || job.status === TUTOR_STATUS.UNAVAILABLE) return true
  return job.status === TUTOR_STATUS.SUCCEEDED && job.finalized_at !== null && job.finalized_at !== undefined
}

/* ------------------------------------------------------------------ content gate */

/** How a refusal names the run that owns the content (verification_gate.gate_mode_label). */
function gateModeLabel(mode: string): string {
  return mode === 'mock_exam' ? '模拟考试' : '验证'
}

/**
 * Raise 403 when the requested content is part of a running verification or mock exam.
 *
 * The same content-scoped gate every delivery path uses (R-INV 2): the exact version, a
 * near-duplicate family member and the same content lineage all count, and the check is server-side
 * so another tab, session or project cannot bypass it.
 */
export function assertContentNotInActiveVerification(
  db: DatabaseSync,
  userId: string,
  questionVersionId: string,
  action: string,
  excludeItemId?: string | null,
): void {
  const covering = verificationContentMap(db, userId).get(String(questionVersionId))
  if (covering === undefined) return
  const candidates = [...covering].filter((itemId) => itemId !== String(excludeItemId ?? ''))
  if (candidates.length === 0) return
  const items = candidates
    .map((itemId) => findOne(db, 'practice_session_item', { id: itemId }))
    .filter((row): row is Row => row !== null)
    .sort((left, right) => {
      const a = left.first_delivered_at as Instant | null
      const b = right.first_delivered_at as Instant | null
      if (a === null) return 1
      if (b === null) return -1
      return a < b ? -1 : a > b ? 1 : 0
    })
  const blocking = items[0]
  if (blocking === undefined) return
  const session = findOne(db, 'practice_session', { id: String(blocking.session_id) })
  const mode = session === null ? 'verification' : String(session.mode)
  const label = gateModeLabel(mode)
  throw new PurposeNotAllowed(
    `该内容正在${label}中（会话 ${String(blocking.session_id)}）：为避免泄露答案，${label}结束前不能${action}。` +
      `如只想练习，请先结束那次${label}。`,
    {
      details: {
        reason: 'active_verification_content_gate',
        gated_mode: mode,
        verification_session_id: String(blocking.session_id),
        verification_session_item_id: String(blocking.id),
      },
    },
  )
}

/**
 * Guard a path that would hand the learner a score for this content (`assert_grading_not_blocked`).
 *
 * A verification or mock exam hides its own grading, so its item may submit itself; every other
 * session mode delivers a score, and that score is as good as the answer while a run on the same
 * content is active.
 */
export function assertGradingNotBlocked(db: DatabaseSync, userId: string, item: Row, action: string): void {
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (
    session !== null &&
    (session.mode === 'verification' || session.mode === 'mock_exam') &&
    session.status === 'active'
  ) {
    return
  }
  assertContentNotInActiveVerification(db, userId, String(item.question_version_id), action, String(item.id))
}

/** Refuse an action on sealed content, naming the sealing policy (C03). */
export function assertContentNotSealed(db: DatabaseSync, projectId: string, questionId: string, action: string): void {
  const decision = isSealed(db, projectId, questionId)
  if (!decision.sealed) return
  throw new PurposeNotAllowed(`封存内容不可${action}：${reasonMessage(decision.code)}`, {
    details: { reason: decision.code, question_id: String(questionId), action },
  })
}

/**
 * `assert_tutoring_allowed` — the server-side gate. Hiding the button in the UI is not a control.
 *
 * The sealed-content and active-verification checks run before any prompt exists, because the prompt
 * is built from this item's stem, answer and rubric.
 */
export function assertTutoringAllowed(db: DatabaseSync, userId: string, item: Row, purpose: string): void {
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null) throw new ScopeViolation('会话不存在或不在当前权限范围')
  if (session.status !== 'active') throw new PurposeNotAllowed('会话已结束；如需辅导请新建练习会话')
  if (session.mode !== 'practice') {
    throw new PurposeNotAllowed(
      '验证/考试模式不提供提示、讲解或诊断；如需辅导请先结束本次验证，再新建练习会话。',
    )
  }
  if (!Boolean(item.tutoring_allowed)) {
    throw new PurposeNotAllowed('该题项按计划不提供辅导（例如延迟验证题）')
  }
  if (!(TUTOR_PURPOSES as readonly string[]).includes(purpose)) throw new InvalidInput('辅导用途无效')
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  assertContentNotSealed(db, String(session.project_id), String(version.question_id), '生成 AI 提示/讲解')
  assertContentNotInActiveVerification(db, userId, String(item.question_version_id), '请求讲解与答案', String(item.id))
}

/**
 * A queued or stored explanation may only be delivered while its content is neither sealed nor part
 * of a running verification.
 *
 * Checked at *read* time as well as at creation time: a job created before the verification started
 * still holds the answer, so the cached result is exactly the bypass B02 described. The stream, the
 * transcript and the JSON read all call this function.
 */
export function assertJobDeliverable(db: DatabaseSync, job: Row): void {
  const session = findOne(db, 'tutoring_session', { id: String(job.tutor_session_id) })
  if (session === null) throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
  const item = findOne(db, 'practice_session_item', { id: String(session.session_item_id) })
  if (item === null) throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
  assertContentNotSealed(db, String(job.project_id), String(version.question_id), '读取讲解与答案')
  assertContentNotInActiveVerification(db, String(job.user_id), String(item.question_version_id), '读取讲解与答案', String(item.id))
}

/* ------------------------------------------------------------------ sessions and jobs */

export function sessionScope(db: DatabaseSync, userId: string, projectId: string, tutorSessionId: string): Row {
  const session = findOne(db, 'tutoring_session', { id: tutorSessionId })
  if (session === null || String(session.user_id) !== userId || String(session.project_id) !== projectId) {
    throw new ScopeViolation('辅导会话不存在或不在当前权限范围')
  }
  return session
}

/** Owner- and project-scoped job lookup; an outsider gets a 404, not a 403. */
export function jobScope(db: DatabaseSync, userId: string, projectId: string, jobId: string): Row {
  const job = findOne(db, 'tutoring_job', { id: jobId })
  if (job === null || String(job.user_id) !== userId || String(job.project_id) !== projectId) {
    throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
  }
  return job
}

/** `_session_out` — the wire shape of one tutoring thread. */
export function tutorSessionPayload(session: Row): Record<string, unknown> {
  return {
    tutor_session_id: String(session.id),
    session_item_id: String(session.session_item_id),
    purpose: String(session.purpose),
    attempt_id: session.attempt_id === null || session.attempt_id === undefined ? null : String(session.attempt_id),
    prompt_version: String(session.prompt_version ?? ''),
    question_version_id:
      session.question_version_id === null || session.question_version_id === undefined
        ? null
        : String(session.question_version_id),
    answer_key_version_id:
      session.answer_key_version_id === null || session.answer_key_version_id === undefined
        ? null
        : String(session.answer_key_version_id),
    created_at: formatPythonIso(session.created_at as Instant),
  }
}

/** `create_tutor_session` — freeze the versions and keep the attempt optional. */
export function createTutorSession(
  db: DatabaseSync,
  userId: string,
  item: Row,
  purpose: string,
  now: Instant,
): Row {
  assertTutoringAllowed(db, userId, item, purpose)
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  if (session === null) throw new ScopeViolation('会话不存在或不在当前权限范围')
  const attempt = findOne(db, 'practice_attempt', { session_item_id: String(item.id) })
  return insertRow(
    db,
    'tutoring_session',
    {
      user_id: userId,
      project_id: session.project_id,
      practice_session_id: session.id,
      session_item_id: item.id,
      attempt_id: attempt === null ? null : attempt.id,
      purpose,
      question_version_id: item.question_version_id,
      answer_key_version_id: item.answer_key_version_id,
      rubric_version_id: item.rubric_version_id,
      prompt_version: EXPLAIN_PROMPT_VERSION,
    },
    { now },
  )
}

/** `GET /projects/{id}/tutor-sessions` rows, newest first, with their job summary. */
export function listTutorSessions(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { sessionItemId?: string | null; limit?: number } = {},
): Record<string, unknown>[] {
  const where: Row = { user_id: userId, project_id: projectId }
  if (options.sessionItemId !== null && options.sessionItemId !== undefined && options.sessionItemId !== '') {
    where.session_item_id = options.sessionItemId
  }
  const limit = Math.max(1, Math.min(Number(options.limit ?? 20), 50))
  const sessions = findRows(db, 'tutoring_session', where, {
    orderBy: [['created_at', 'desc']],
    limit,
  })
  return sessions.map((session) => {
    const jobs = findRows(db, 'tutoring_job', { tutor_session_id: session.id }, { orderBy: [['created_at', 'desc']] })
    return {
      ...tutorSessionPayload(session),
      job_count: jobs.length,
      last_job_status: jobs.length === 0 ? null : String(jobs[0].status),
    }
  })
}

/** Citations a model may use: the frozen version and reviewed material only. */
export function allowedCitations(
  db: DatabaseSync,
  item: Row,
): { citations: string[]; context: Record<string, unknown> } {
  const citations: string[] = []
  const context: Record<string, unknown> = {}
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  citations.push(`question_version:${String(version.id)}`)
  context['question_version'] = String(version.id)
  if (item.answer_key_version_id !== null && item.answer_key_version_id !== undefined) {
    citations.push(`answer_key_version:${String(item.answer_key_version_id)}`)
    context['answer_key_version'] = String(item.answer_key_version_id)
  }
  if (item.rubric_version_id !== null && item.rubric_version_id !== undefined) {
    citations.push(`rubric_version:${String(item.rubric_version_id)}`)
    context['rubric_version'] = String(item.rubric_version_id)
  }
  if (item.spec_version_id !== null && item.spec_version_id !== undefined) {
    citations.push(`exam_spec_version:${String(item.spec_version_id)}`)
    context['exam_spec_version'] = String(item.spec_version_id)
  }
  const mappings = findRows(db, 'knowledge_question_mapping', {
    question_version_id: version.id,
    mapping_revision: item.mapping_revision,
  })
  const nodeIds: string[] = []
  const nodeNames: string[] = []
  for (const mapping of mappings) {
    citations.push(`knowledge_node:${String(mapping.node_id)}`)
    nodeIds.push(String(mapping.node_id))
    const node = findOne(db, 'knowledge_node', { id: String(mapping.node_id) })
    nodeNames.push(node === null ? '' : String(node.canonical_name ?? ''))
  }
  context['knowledge_nodes'] = nodeIds
  // Names, not just opaque ids: the model cannot explain "this knowledge point" from a UUID.
  context['knowledge_node_names'] = nodeNames
  return { citations, context }
}

function answerOf(db: DatabaseSync, item: Row): Row | null {
  if (item.answer_key_version_id === null || item.answer_key_version_id === undefined) return null
  return findOne(db, 'question_bank_answer_key_version', { id: String(item.answer_key_version_id) })
}

function rubricOf(db: DatabaseSync, item: Row): Row | null {
  if (item.rubric_version_id === null || item.rubric_version_id === undefined) return null
  return findOne(db, 'question_bank_rubric_version', { id: String(item.rubric_version_id) })
}

/** `answer_summary` — what a *usable* (checked, undisputed) answer may say. */
export function answerSummary(db: DatabaseSync, item: Row): string {
  const answer = answerOf(db, item)
  if (answer === null) return ''
  const usable = String(answer.verification_status) === 'checked' && !Boolean(answer.is_disputed)
  if (!usable) return ''
  const payload = (answer.answer_payload ?? {}) as Record<string, unknown>
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  const questionType = version === null ? '' : String(version.question_type)
  if (questionType === 'single_choice') return `正确选项：${pyStr(payload['correct_option_id'] ?? '')}`
  if (questionType === 'multiple_choice') {
    const ids = Array.isArray(payload['correct_option_ids']) ? payload['correct_option_ids'] : []
    return `正确选项集合：${ids.map((id) => pyStr(id)).join(', ')}`
  }
  if (questionType === 'true_false') return `标准答案：${payload['value'] ? '正确' : '错误'}`
  if (questionType === 'fill_blank') {
    const blanks = (payload['blanks'] ?? {}) as Record<string, unknown>
    const rendered = Object.entries(blanks)
      .filter(([, spec]) => spec !== null && typeof spec === 'object')
      .map(([blankId, spec]) => {
        const accepted = (spec as Record<string, unknown>)['accepted_values']
        const values = Array.isArray(accepted) ? accepted.map((value) => pyStr(value)).join(' / ') : ''
        return `${blankId}: ${values || '（数值规则）'}`
      })
      .join('; ')
    return `各空答案：${rendered}`
  }
  if (questionType === 'constructed_response') return '按评分标准逐点评分（请勿给出单一总分）'
  return ''
}

/** Render the student's submitted answer verbatim, for every question type. */
function renderRawAnswer(rawAnswer: unknown): string {
  if (rawAnswer === null || typeof rawAnswer !== 'object' || Array.isArray(rawAnswer)) return ''
  const raw = rawAnswer as Record<string, unknown>
  if (Object.keys(raw).length === 0) return ''
  const questionType = raw['type']
  if (questionType === 'single_choice') {
    const selected = raw['selected_option_ids'] ?? raw['selected_option_id']
    return `选择：${Array.isArray(selected) ? pyRepr(selected) : pyRepr([selected])}`
  }
  if (questionType === 'multiple_choice') {
    const selected = Array.isArray(raw['selected_option_ids']) ? raw['selected_option_ids'] : []
    return `选择：${pyRepr(selected)}`
  }
  if (questionType === 'true_false') {
    const value = raw['value']
    return '判断：' + (value === null || value === undefined ? '未作答' : value ? '正确' : '错误')
  }
  if (questionType === 'fill_blank') {
    const blanks = (raw['blanks'] ?? {}) as Record<string, unknown>
    return '各空作答：' + Object.entries(blanks).map(([key, value]) => `${key}=${pyRepr(value)}`).join('; ')
  }
  if (questionType === 'constructed_response') return `作答原文：${pyStr(raw['text'] ?? '')}`
  return `作答原文：${pySlice(JSON.stringify(raw), 2000)}`
}

function renderSteps(steps: unknown): string {
  if (!Array.isArray(steps) || steps.length === 0) return ''
  const lines: string[] = []
  steps.forEach((step, index) => {
    let text: string
    if (step !== null && typeof step === 'object' && !Array.isArray(step)) {
      const record = step as Record<string, unknown>
      const blocks = blocksText(record['blocks'])
      text = pyStr(record['text'] ?? '') || blocks || JSON.stringify(record)
    } else {
      text = pyStr(step)
    }
    if (pyStrip(text) !== '') lines.push(`步骤 ${index + 1}：${text}`)
  })
  return lines.join('\n')
}

/**
 * The student's actual work plus the factual grading state.
 *
 * Order matters: the work comes first because it is what the explanation must address, and the score
 * status is context rather than the subject.
 */
export function attemptSummary(db: DatabaseSync, item: Row): string {
  const attempt = findOne(db, 'practice_attempt', { session_item_id: String(item.id) })
  if (attempt === null) return ''
  const lines: string[] = []
  const rendered = renderRawAnswer(attempt.raw_answer)
  if (rendered !== '') lines.push(rendered)
  const steps = renderSteps(attempt.steps)
  if (steps !== '') lines.push('学生的解题步骤：\n' + steps)
  const attachments = Array.isArray(attempt.attachments) ? attempt.attachments : []
  if (attachments.length > 0) {
    lines.push(`学生上传的作答照片数量：${attachments.length}（内容不随本请求传输，仅用于人工评分）。`)
  }
  if (pyStr(attempt.confidence ?? '') !== '') lines.push(`学生自评把握：${pyStr(attempt.confidence)}`)
  if (Number(attempt.elapsed_ms ?? 0) !== 0) {
    lines.push(`本次用时：${Math.round(Number(attempt.elapsed_ms) / 1000)} 秒`)
  }
  const grade =
    attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined
      ? null
      : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
  if (grade === null) {
    lines.push('判分状态：已提交，处理中（不要猜分数）')
  } else {
    const parts = Array.isArray(grade.parts) ? grade.parts : []
    const renderedParts = parts
      .map((part) => {
        if (part === null || typeof part !== 'object') return ''
        const record = part as Record<string, unknown>
        const score = record['score']
        return (
          `${pyStr(record['part_id'] ?? '')}: ${pyStr(record['status'] ?? '')}` +
          (score === null || score === undefined ? '' : `(${pyStr(score)}/${pyStr(record['max_score'] ?? '')})`)
        )
      })
      .filter((part) => part !== '')
      .join(', ')
    lines.push(`判分状态 ${pyStr(grade.status)}；分项：${renderedParts || '无'}`)
    const comment = pyStr(grade.comment ?? '')
    if (comment !== '') lines.push(`评分备注：${comment}`)
  }
  return lines.join('\n')
}

/**
 * Build the frozen prompt for one explain request.
 *
 * The prompt is *personalised*: it carries the student's own submitted answer, their steps, their
 * confidence, their uploaded photos, the reviewed rubric criteria and the shared material. Passing
 * only the grading status made "针对卡点讲解" impossible — the model could not see what was written.
 */
export function buildTutorPrompt(db: DatabaseSync, item: Row, userQuestion = ''): string {
  const { citations, context } = allowedCitations(db, item)
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  const content = (version.content ?? {}) as Record<string, unknown>
  const answer = answerOf(db, item)
  const rubric = rubricOf(db, item)
  let materialBlocks: unknown = null
  if (version.parent_material_version_id !== null && version.parent_material_version_id !== undefined) {
    const material = findOne(db, 'question_bank_question_version', { id: String(version.parent_material_version_id) })
    materialBlocks = (material?.content as Record<string, unknown> | undefined)?.['blocks'] ?? []
  }
  return buildExplainPrompt({
    question_type: version.question_type,
    stem_text: blocksText(content['blocks']),
    options: (Array.isArray(content['options']) ? content['options'] : []) as Record<string, unknown>[],
    answer_summary: answerSummary(db, item),
    explanation_blocks: answer === null ? [] : (answer.explanation_blocks ?? []),
    allowed_citation_ids: citations,
    attempt_summary: attemptSummary(db, item),
    user_question: userQuestion,
    knowledge_nodes: (context['knowledge_node_names'] as string[]) ?? [],
    rubric_criteria: rubric === null ? [] : ((rubric.criteria ?? []) as Record<string, unknown>[]),
    material_text: materialBlocks === null ? '' : blocksText(materialBlocks),
    blanks: (Array.isArray(content['blanks']) ? content['blanks'] : []) as Record<string, unknown>[],
  })
}

/**
 * Create the job, freeze its inputs and record the run. Nothing is returned raw.
 *
 * The run row is written **before** the call (Django does the same): an interrupted job therefore
 * leaves an honest "we tried" row, and the post-call facts update *that* row.
 */
export function createTutorJob(
  db: DatabaseSync,
  options: { tutorSession: Row; userId: string; userQuestion?: string; purpose?: string | null; now: Instant },
): { job: Row; prompt: string; citations: string[] } {
  const { tutorSession, userId, now } = options
  const item = findOne(db, 'practice_session_item', { id: String(tutorSession.session_item_id) })
  if (item === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  const requested = options.purpose ?? null
  const resolvedPurpose = requested === null || requested === '' ? String(tutorSession.purpose) : requested
  const userQuestion = pyStr(options.userQuestion ?? '')
  return transaction(db, () => {
    assertTutoringAllowed(db, userId, item, resolvedPurpose)
    const prompt = buildTutorPrompt(db, item, userQuestion)
    const { citations, context } = allowedCitations(db, item)
    const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
    const rubric = rubricOf(db, item)
    const fingerprint = sha256(
      pyJsonCanonical({
        prompt,
        prompt_version: EXPLAIN_PROMPT_VERSION,
        question_version: String(item.question_version_id),
        answer_key_version: pyStr(item.answer_key_version_id ?? null),
        rubric_version: pyStr(item.rubric_version_id ?? null),
      }),
    )
    const job = insertRow(
      db,
      'tutoring_job',
      {
        tutor_session_id: tutorSession.id,
        user_id: userId,
        project_id: tutorSession.project_id,
        purpose: resolvedPurpose,
        status: TUTOR_STATUS.QUEUED,
        request_text: pySlice(userQuestion, 2000),
        input_fingerprint: fingerprint,
        reveals_answer: resolvedPurpose === 'explanation',
        result_blocks: [],
        citations: [],
        missing_information: [],
        suggested_next: [],
        error_code: '',
        error_message: '',
      },
      { now },
    )
    insertRow(
      db,
      'tutoring_turn',
      {
        tutor_session_id: tutorSession.id,
        role: 'user',
        text: pySlice(userQuestion, 2000) || '（请求讲解）',
        job_id: null,
      },
      { now },
    )
    // `syllabus_version_id` in Django's summary is the subject id (frozen input bookkeeping); the
    // same field is produced here so an auditor of either implementation sees the same keys.
    const subjectId = rubricSubjectId(db, item)
    const handle = beginAuditedRun(
      db,
      { capability: 'explain', promptVersion: EXPLAIN_PROMPT_VERSION, system: '', prompt },
      {
        userId,
        projectId: String(tutorSession.project_id),
        requestSummary: {
          purpose: resolvedPurpose,
          question_version_id: String(version?.id ?? ''),
          answer_key_version_id: pyStr(item.answer_key_version_id ?? null),
          rubric_version_id: pyStr(item.rubric_version_id ?? null),
          syllabus_version_id: subjectId,
          user_question_present: userQuestion !== '',
        },
        inputSnapshot: {
          question_version_id: String(version?.id ?? ''),
          content_digest: contentDigest((version?.content ?? {}) as Record<string, unknown>),
          answer_key_version_id: item.answer_key_version_id ? String(item.answer_key_version_id) : null,
          rubric_version_id: item.rubric_version_id ? String(item.rubric_version_id) : null,
          spec_version_id: item.spec_version_id ? String(item.spec_version_id) : null,
          retrieval: context,
        },
        retrievalSourceIds: citations,
      },
      now,
    )
    const stored = updateRow(db, 'tutoring_job', job.id, { llm_run_id: handle.rowId }, { now })
    return { job: stored ?? job, prompt, citations }
  })
}

function rubricSubjectId(db: DatabaseSync, item: Row): string | null {
  if (item.rubric_version_id === null || item.rubric_version_id === undefined) return null
  const rubric = findOne(db, 'question_bank_rubric_version', { id: String(item.rubric_version_id) })
  if (rubric === null) return null
  const answer = findOne(db, 'question_bank_answer_key_version', { id: String(rubric.answer_key_version_id) })
  if (answer === null) return null
  const version = findOne(db, 'question_bank_question_version', { id: String(answer.question_version_id) })
  if (version === null) return null
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  return question === null ? null : String(question.subject_id)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ running a job */

/**
 * Execute one provider call, validate it, and store only the validated result.
 *
 * Returns the job row after the attempt. A missing model leaves `unavailable` +
 * `error_code=ai_not_configured` (the honest state the UI shows), never invented content.
 */
export async function runTutorJob(
  db: DatabaseSync,
  job: Row,
  options: { port: LlmPort; now: Instant },
): Promise<Row> {
  const { port, now } = options
  let current = job
  if (current.status === TUTOR_STATUS.FAILED || current.status === TUTOR_STATUS.UNAVAILABLE) return current
  if (current.status === TUTOR_STATUS.SUCCEEDED) {
    return current.finalized_at === null || current.finalized_at === undefined
      ? finalizeSuccess(db, current, now)
      : current
  }
  const item = findOne(db, 'practice_session_item', { id: String(tutorSessionOf(db, current).session_item_id) })
  if (item === null) throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
  try {
    assertJobDeliverable(db, current)
  } catch (error) {
    if (!(error instanceof PurposeNotAllowed)) throw error
    const refusal = String((error.details as Record<string, unknown>)['reason'] ?? '')
    const code =
      refusal === 'sealed_question_policy' || refusal === 'sealed_family_policy'
        ? 'blocked_by_sealed_content'
        : 'blocked_by_active_verification'
    return writeJobResult(db, current, {
      status: TUTOR_STATUS.FAILED,
      error_code: code,
      error_message: pySlice(error.message, 500),
      result_blocks: [],
    }, now)
  }
  current = writeJobResult(db, current, { status: TUTOR_STATUS.RUNNING }, now)
  const prompt = buildTutorPrompt(db, item, pyStr(current.request_text ?? ''))
  const { citations } = allowedCitations(db, item)
  const runId = current.llm_run_id === null || current.llm_run_id === undefined ? null : String(current.llm_run_id)
  const result = await port.run({
    capability: 'explain',
    promptVersion: EXPLAIN_PROMPT_VERSION,
    system: '',
    prompt,
  })
  if (!result.ok) {
    if (runId !== null) {
      const record = beginAuditedRecord(db, runId)
      finishAuditedRun(db, runId, markFailed(record, { code: result.code, message: result.message }), now)
    }
    const unavailable = result.code === 'ai_not_configured' || result.code === 'ai_capability_unsupported'
    return writeJobResult(
      db,
      current,
      {
        status: unavailable ? TUTOR_STATUS.UNAVAILABLE : TUTOR_STATUS.FAILED,
        error_code: result.code,
        error_message: pySlice(unavailable ? unconfiguredReason(result.code, result.message) : result.message, 500),
      },
      now,
    )
  }
  let parsed: unknown
  try {
    parsed = parseModelJson(result.text)
  } catch {
    if (runId !== null) {
      const record = beginAuditedRecord(db, runId)
      finishAuditedRun(
        db,
        runId,
        markRejected(record, telemetryOf(result), {}, 'invalid JSON'),
        now,
      )
    }
    return writeJobResult(
      db,
      current,
      {
        status: TUTOR_STATUS.FAILED,
        error_code: 'ai_invalid_output',
        error_message: '模型输出不是合法 JSON，未展示任何内容',
      },
      now,
    )
  }
  const [clean, problems] = validateExplainPayload(parsed, { allowed_citation_ids: new Set(citations) })
  if (problems.length > 0) {
    const message = '模型输出未通过校验，未展示：' + pySlice(problems.slice(0, 3).map((problem) => problem.message).join('; '), 400)
    if (runId !== null) {
      const record = beginAuditedRecord(db, runId)
      finishAuditedRun(
        db,
        runId,
        markRejected(record, telemetryOf(result), { problems, accepted: false }, message),
        now,
      )
    }
    return writeJobResult(
      db,
      current,
      {
        status: TUTOR_STATUS.FAILED,
        error_code: 'ai_invalid_output',
        error_message: pySlice(message, 500),
      },
      now,
    )
  }
  if (runId !== null) {
    const record = beginAuditedRecord(db, runId)
    finishAuditedRun(
      db,
      runId,
      markSucceeded(record, telemetryOf(result), { problems, accepted: true }),
      now,
    )
  }
  const session = tutorSessionOf(db, current)
  const frozenOk =
    String(item.question_version_id) === String(session.question_version_id ?? '') &&
    String(item.answer_key_version_id ?? '') === String(session.answer_key_version_id ?? '')
  current = writeJobResult(
    db,
    current,
    {
      result_blocks: clean['explanation_blocks'] as unknown[],
      citations: clean['citations'] as unknown[],
      missing_information: clean['missing_information'] as unknown[],
      suggested_next: clean['suggested_next'] as unknown[],
      status: TUTOR_STATUS.SUCCEEDED,
      delivered_at: now,
      is_stale: !frozenOk,
    },
    now,
  )
  return finalizeSuccess(db, current, now)
}

/**
 * The message stored on a job whose provider could not run.
 *
 * Django's `str(AiUnavailable)` names the environment switch that would fix it; DSH has no such
 * switch, so the sentence names the host fact instead. The `未配置` prefix is kept because the UI
 * branches on it.
 */
export function unconfiguredReason(code: string, message: string): string {
  if (code === 'ai_capability_unsupported') {
    return `provider 不支持该能力：${message || '当前模型不支持'}`
  }
  return '未配置 AI 能力（DSH 会话没有可用的模型路由）'
}

/** Read the audit row back so the post-call facts update *that* row instead of inserting another. */
function beginAuditedRecord(db: DatabaseSync, rowId: string): LlmRunRecord {
  const row = findOne(db, 'audit_llm_run', { id: rowId })
  if (row === null) throw new ScopeViolation('模型调用记录不存在')
  return {
    provider: String(row.provider),
    model_identifier: String(row.model_identifier ?? ''),
    capability: String(row.capability) as LlmRunRecord['capability'],
    prompt_version: String(row.prompt_version) as LlmRunRecord['prompt_version'],
    status: String(row.status) as LlmRunRecord['status'],
    request_summary: (row.request_summary ?? {}) as Record<string, unknown>,
    input_snapshot: (row.input_snapshot ?? {}) as Record<string, unknown>,
    retrieval_source_ids: (Array.isArray(row.retrieval_source_ids) ? row.retrieval_source_ids : []).map((id) =>
      String(id),
    ),
    validation_result: (row.validation_result ?? {}) as Record<string, unknown>,
    raw_response_excerpt: String(row.raw_response_excerpt ?? ''),
    prompt_tokens: row.prompt_tokens === null || row.prompt_tokens === undefined ? null : Number(row.prompt_tokens),
    completion_tokens:
      row.completion_tokens === null || row.completion_tokens === undefined ? null : Number(row.completion_tokens),
    cost_cents: row.cost_cents === null || row.cost_cents === undefined ? null : String(row.cost_cents),
    cost_known: Boolean(row.cost_known),
    latency_ms: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    attempts: Number(row.attempts ?? 1),
    error_code: String(row.error_code ?? ''),
    error_message: String(row.error_message ?? ''),
    is_stub: false,
    user_id: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
    project_id: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
  }
}

function tutorSessionOf(db: DatabaseSync, job: Row): Row {
  const session = findOne(db, 'tutoring_session', { id: String(job.tutor_session_id) })
  if (session === null) throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
  return session
}

/** Short write: persist a job state change and return the stored row. */
function writeJobResult(db: DatabaseSync, job: Row, fields: Row, now: Instant): Row {
  return transaction(db, () => {
    const locked = findOne(db, 'tutoring_job', { id: String(job.id) })
    if (locked === null) return job
    // A newer consumer already delivered a validated result; a stale one must not overwrite it with
    // a failure.
    if (locked.status === TUTOR_STATUS.SUCCEEDED && fields['status'] !== TUTOR_STATUS.SUCCEEDED) return locked
    return updateRow(db, 'tutoring_job', locked.id, fields, { now }) ?? locked
  })
}

/**
 * Commit the business facts of a successful job exactly once: the assistant turn, the exposure fact,
 * the validated segments and `finalized_at` are one fact.
 *
 * Idempotent: a re-delivery that finds the turn/exposure already there writes nothing new.
 */
export function finalizeSuccess(db: DatabaseSync, job: Row, now: Instant): Row {
  return transaction(db, () => {
    const locked = findOne(db, 'tutoring_job', { id: String(job.id) })
    if (locked === null || locked.status !== TUTOR_STATUS.SUCCEEDED) return locked ?? job
    appendSegments(db, locked, now)
    if (locked.finalized_at === null || locked.finalized_at === undefined) {
      const session = tutorSessionOf(db, locked)
      const item = findOne(db, 'practice_session_item', { id: String(session.session_item_id) })
      if (item === null) throw new ScopeViolation('辅导任务不存在或不在当前权限范围')
      const existingTurn = findRows(db, 'tutoring_turn', { job_id: locked.id, role: 'assistant' })
      if (existingTurn.length === 0) {
        insertRow(
          db,
          'tutoring_turn',
          {
            tutor_session_id: locked.tutor_session_id,
            role: 'assistant',
            text: pySlice(blocksText(locked.result_blocks), 8000),
            job_id: locked.id,
          },
          { now },
        )
      }
      const exposureRows = findRows(db, 'practice_exposure_event', {}).filter(
        (row) => (row.detail as Record<string, unknown> | null)?.['tutor_job_id'] === String(locked.id),
      )
      if (exposureRows.length === 0) {
        const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
        const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
        const run = locked.llm_run_id === null || locked.llm_run_id === undefined
          ? null
          : findOne(db, 'audit_llm_run', { id: String(locked.llm_run_id) })
        insertRow(
          db,
          'practice_exposure_event',
          {
            user_id: locked.user_id,
            project_id: locked.project_id,
            question_id: question === null ? null : question.id,
            question_version_id: item.question_version_id,
            family_id: question === null ? null : (question.family_id ?? null),
            content_lineage_id: question === null ? null : (question.content_lineage_id ?? null),
            session_item_id: item.id,
            kind: Boolean(locked.reveals_answer) ? 'answer_delivered' : 'explanation_delivered',
            purpose: 'practice',
            source: `tutor_job:${String(locked.purpose)}`,
            server_time: now,
            reveals_answer: Boolean(locked.reveals_answer),
            detail: {
              tutor_job_id: String(locked.id),
              prompt_version: EXPLAIN_PROMPT_VERSION,
              is_stub: run === null ? false : Boolean(run.is_stub),
              delivered_at:
                locked.delivered_at === null || locked.delivered_at === undefined
                  ? null
                  : formatPythonIso(locked.delivered_at as Instant),
              recovered_after_interruption: true,
            },
          },
          { now },
        )
      }
      const finalized = updateRow(db, 'tutoring_job', locked.id, { finalized_at: now }, { now })
      return finalized ?? locked
    }
    return locked
  })
}

/* ------------------------------------------------------------------ segments (B08) */

function blockFields(index: number, block: Row): Row | null {
  const kind = pyStr(block['kind'] ?? 'text') || 'text'
  if (!VALID_SEGMENT_KINDS.has(kind)) return null
  let items: string[] = []
  let text = ''
  let canonical: Record<string, unknown>
  if (kind === 'list') {
    const raw = Array.isArray(block['items']) ? block['items'] : []
    items = raw.map((item) => pyStr(item)).filter((item) => pyStrip(item) !== '')
    canonical = { kind: 'list', items }
  } else if (kind === 'math') {
    text = pyStr(block['latex'] ?? '')
    canonical = { kind: 'math', latex: text }
  } else {
    text = pyStr(block['text'] ?? '')
    canonical = { kind: 'text', text }
  }
  if (kind !== 'list' && pyStrip(text) === '') return null
  return { index, kind, text, items, digest: sha256(pyJsonCanonical(canonical)) }
}

/**
 * Idempotently mirror `job.result_blocks` into segment rows.
 *
 * Only a succeeded job with validated blocks has anything to mirror, and `(job, index)` is unique,
 * so a re-run after a crash completes a missing mirror instead of duplicating it.
 */
export function appendSegments(db: DatabaseSync, job: Row, now: Instant): number {
  if (job.status !== TUTOR_STATUS.SUCCEEDED) return 0
  const blocks = Array.isArray(job.result_blocks) ? (job.result_blocks as unknown[]) : []
  if (blocks.length === 0) return 0
  const existing = new Set(
    findRows(db, 'tutoring_segment', { job_id: job.id }).map((row) => Number(row.index)),
  )
  const pending: Row[] = []
  blocks.forEach((block, index) => {
    if (existing.has(index) || block === null || typeof block !== 'object') return
    const fields = blockFields(index, block as Row)
    if (fields === null) return
    pending.push({
      job_id: job.id,
      is_stale: Boolean(job.is_stale),
      stale_reason: Boolean(job.is_stale) ? STALE_FROZEN_INPUTS : '',
      ...fields,
    })
  })
  for (const row of pending) insertRow(db, 'tutoring_segment', row, { now })
  if (Boolean(job.is_stale)) markStaleSegments(db, job, STALE_FROZEN_INPUTS, now)
  return pending.length
}

/** Mark every not-yet-stale segment stale. Idempotent and bounded; a stale segment is never shown. */
export function markStaleSegments(db: DatabaseSync, job: Row, reason: string, now: Instant): number {
  let changed = 0
  for (const row of findRows(db, 'tutoring_segment', { job_id: job.id, is_stale: false })) {
    updateRow(
      db,
      'tutoring_segment',
      row.id,
      { is_stale: true, stale_reason: pySlice(pyStr(reason) || STALE_FROZEN_INPUTS, 300) },
      { now },
    )
    changed += 1
  }
  return changed
}

/** Reason attached when the frozen inputs drifted after the job started. */
export const STALE_FROZEN_INPUTS = '冻结输入在任务运行期间已变化：原讲解不再对应当前题目内容'
/** Reason for a job explicitly retired as stale: it delivers nothing, ever. */
export const STALE_JOB_STATUS_REASON = '任务已被标记为失效：不再交付任何内容'

/** The answer a *new* session item for this content would freeze today. */
function effectiveAnswerKeyId(db: DatabaseSync, questionVersionId: string | null): string | null {
  if (questionVersionId === null) return null
  const rows = findRows(db, 'question_bank_answer_key_version', {
    question_version_id: questionVersionId,
    verification_status: 'checked',
    is_disputed: false,
  }).sort((left, right) => Number(right.version) - Number(left.version))
  return rows.length === 0 ? null : String(rows[0].id)
}

/** Why the job's frozen inputs no longer match the live content (`''` = current). */
export function sourceIsStale(db: DatabaseSync, job: Row): string {
  const session = tutorSessionOf(db, job)
  const item = findOne(db, 'practice_session_item', { id: String(session.session_item_id) })
  if (item === null) return ''
  if (String(session.question_version_id ?? '') !== String(item.question_version_id ?? '')) {
    return '题项已切换到新的题目版本：原讲解不再对应当前题目内容'
  }
  const frozenAnswerId =
    session.answer_key_version_id === null || session.answer_key_version_id === undefined
      ? null
      : String(session.answer_key_version_id)
  if (frozenAnswerId === null) {
    if (item.answer_key_version_id === null || item.answer_key_version_id === undefined) return ''
    return '题项已关联答案版本，而原讲解是在没有可用答案时生成的'
  }
  const frozen = findOne(db, 'question_bank_answer_key_version', { id: frozenAnswerId })
  if (frozen === null) return '原讲解依据的答案版本已被删除'
  if (String(frozen.question_version_id) !== String(session.question_version_id ?? '')) {
    return '原讲解依据的答案版本与冻结的题目版本不一致'
  }
  const effectiveId = effectiveAnswerKeyId(db, session.question_version_id as string)
  if (effectiveId === null) return '该题目版本当前没有已核对且无争议的答案版本'
  if (effectiveId !== frozenAnswerId) return '该题目版本的已核对答案已更新：原讲解依据的答案不再有效'
  return ''
}

/** Non-empty when no segment of this job may be delivered. */
export function deliveryBlockReason(db: DatabaseSync, job: Row): string {
  if (job.status === TUTOR_STATUS.STALE) return STALE_JOB_STATUS_REASON
  const live = sourceIsStale(db, job)
  if (live !== '') return live
  if (Boolean(job.is_stale)) return STALE_FROZEN_INPUTS
  const staleRow = findRows(db, 'tutoring_segment', { job_id: job.id, is_stale: true }, {
    orderBy: [['index', 'asc']],
  })[0]
  if (staleRow !== undefined) return pyStr(staleRow.stale_reason ?? '') || STALE_FROZEN_INPUTS
  return ''
}

/** One stored segment as the wire sees it. */
export function segmentData(row: Row, blocked = false): Record<string, unknown> {
  return {
    index: Number(row.index),
    kind: String(row.kind),
    text: String(row.text ?? ''),
    items: Array.isArray(row.items) ? row.items : [],
    digest: String(row.digest),
    is_stale: Boolean(row.is_stale) || blocked,
  }
}

/** `segments_payload` — the transcript view, same staleness rule as the stream. */
export function segmentsPayload(db: DatabaseSync, job: Row): Record<string, unknown> {
  const reason = deliveryBlockReason(db, job)
  const rows = findRows(db, 'tutoring_segment', { job_id: job.id }, { orderBy: [['index', 'asc']] })
  return {
    tutor_job_id: String(job.id),
    status: String(job.status),
    is_stale: reason !== '',
    stale_reason: reason,
    segment_count: rows.length,
    segments: rows.map((row) => segmentData(row, reason !== '')),
  }
}

/* ------------------------------------------------------------------ AI status and runs */

/**
 * `ai_status()` — whether AI is configured, and what it may be used for. Never fakes health.
 *
 * The capability table is this package's honest host probe (`llm/port.ts::availability`), and the
 * three message strings are `provider_status()`'s, byte for byte (`ai_runtime.json`). `max_retries`
 * and `total_timeout_seconds` are the Django settings the UI displays when a call is configured.
 */
export function aiStatus(
  availability: Record<string, { available: boolean; reason?: string }>,
  options: { providerName?: string; maxRetries?: number; totalTimeoutSeconds?: number } = {},
): Record<string, unknown> {
  const capabilities: Record<string, boolean> = {}
  for (const capability of AI_CAPABILITIES) capabilities[capability] = availability[capability]?.available === true
  const configured = Object.values(capabilities).some(Boolean)
  return {
    // Django reports the provider implementation's name. `dsh-llm` is this package's adapter, and
    // `none` matches `NullProvider.name` when nothing is configured.
    provider: configured ? (options.providerName ?? 'dsh-llm') : 'none',
    configured,
    is_stub: false,
    capabilities,
    p0_capabilities: [...P0_CAPABILITIES],
    message: availabilityMessage(configured),
    max_retries: options.maxRetries ?? 2,
    total_timeout_seconds: options.totalTimeoutSeconds ?? 90,
  }
}

/** `recent_runs()` — the audit rows of one project, newest first. */
export function recentRuns(db: DatabaseSync, projectId: string, limit = 20): Record<string, unknown>[] {
  const clamped = Math.max(1, Math.min(Number(limit), 50))
  const rows = findRows(db, 'audit_llm_run', { project_id: projectId }, {
    orderBy: [['created_at', 'desc']],
    limit: clamped,
  })
  return rows.map((run) => ({
    id: String(run.id),
    provider: String(run.provider),
    model: String(run.model_identifier ?? ''),
    capability: String(run.capability),
    prompt_version: String(run.prompt_version ?? ''),
    status: String(run.status),
    is_stub: Boolean(run.is_stub),
    attempts: Number(run.attempts ?? 1),
    latency_ms: run.latency_ms === null || run.latency_ms === undefined ? null : Number(run.latency_ms),
    cost_cents: run.cost_cents === null || run.cost_cents === undefined ? null : String(run.cost_cents),
    cost_known: Boolean(run.cost_known),
    prompt_tokens: run.prompt_tokens === null || run.prompt_tokens === undefined ? null : Number(run.prompt_tokens),
    completion_tokens:
      run.completion_tokens === null || run.completion_tokens === undefined ? null : Number(run.completion_tokens),
    error_code: String(run.error_code ?? ''),
    created_at: formatPythonIso(run.created_at as Instant),
  }))
}

/**
 * `job_payload()` — the wire shape of one tutoring job.
 *
 * Validated content is only included for a `succeeded` job; every other state answers empty arrays,
 * so a failure can never be mistaken for an explanation.
 */
export function jobPayload(db: DatabaseSync, job: Row): Record<string, unknown> {
  const session = tutorSessionOf(db, job)
  const run =
    job.llm_run_id === null || job.llm_run_id === undefined
      ? null
      : findOne(db, 'audit_llm_run', { id: String(job.llm_run_id) })
  const segmentCount = countRows(db, 'tutoring_segment', { job_id: job.id })
  const payload: Record<string, unknown> = {
    tutor_job_id: String(job.id),
    tutor_session_id: String(job.tutor_session_id),
    session_item_id: String(session.session_item_id),
    purpose: String(job.purpose),
    status: String(job.status),
    reveals_answer: Boolean(job.reveals_answer),
    is_stale: Boolean(job.is_stale),
    is_stub: run === null ? false : Boolean(run.is_stub),
    provider: run === null ? '' : String(run.provider),
    model: run === null ? '' : String(run.model_identifier ?? ''),
    prompt_version: run === null ? '' : String(run.prompt_version ?? ''),
    error_code: String(job.error_code ?? ''),
    error_message: String(job.error_message ?? ''),
    delivered_at:
      job.delivered_at === null || job.delivered_at === undefined
        ? null
        : formatPythonIso(job.delivered_at as Instant),
    segment_count: segmentCount,
  }
  if (job.status === TUTOR_STATUS.SUCCEEDED) {
    payload['result_blocks'] = job.result_blocks ?? []
    payload['citations'] = job.citations ?? []
    payload['missing_information'] = job.missing_information ?? []
    payload['suggested_next'] = job.suggested_next ?? []
  } else {
    payload['result_blocks'] = []
    payload['citations'] = []
    payload['missing_information'] = []
    payload['suggested_next'] = []
  }
  return payload
}
