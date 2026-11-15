/** 节点教练只写对话、调用审计和真实交付暴露；不写学习结论。 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import type { LlmPort, CapabilityResult } from '../llm/contract.ts'
import { markFailed, markRejected, markSucceeded } from '../ai/audit.ts'
import { parseModelJson, pySlice } from '../ai/pyvalue.ts'
import { COACH_PURPOSES, COACH_PROMPT_VERSION, COACH_AUDIT_CAPABILITY, buildCoachPrompt, renderCoachText, type CoachPurpose, type CoachPromptInput } from '../ai/coach_prompts.ts'
import { validateCoachReply } from '../ai/coach_validators.ts'
import { transaction } from '../store/db.ts'
import { findRows, getRow, insertRow, type Row } from '../store/repository.ts'
import { requireProject } from './exams.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation } from './errors.ts'
import { assertContentNotInActiveVerification, assertContentNotSealed } from './tutoring.ts'
import { beginAuditedRunOf, finishAuditedRun, telemetryOf } from './ai_runs.ts'
import type { CoachTurnOut, CoachReplyOut } from './study_contract.ts'
export type { CoachTurnOut, CoachReplyOut } from './study_contract.ts'

export interface CoachTurnArgs {
  userId: string; projectId: string; nodeId: string; purpose: string
  message?: string; sessionId?: string | null; stepOrdinal?: number | null
}
export function coachThreadKey(nodeId: string, purpose: string, sessionId?: string | null): string {
  return `coach:${JSON.stringify([nodeId, purpose, sessionId ?? null])}`
}
export async function coachAvailability(port: LlmPort): Promise<{ configured: boolean; available: boolean; reason: string; message: string }> {
  try {
    const state = (await port.availability()).explain
    const available = state?.available === true
    const reason = available ? '' : state?.reason ?? 'ai_not_configured'
    return { configured: reason !== 'ai_not_configured', available, reason, message: available ? 'AI 教练可用' : reason === 'ai_not_configured' ? 'AI 未配置；未生成教练回复。' : 'AI 教练暂不可用；未生成回复。' }
  } catch {
    return { configured: false, available: false, reason: 'ai_error', message: '无法检查 AI 可用性；未生成回复。' }
  }
}
function nodeScope(db: DatabaseSync, args: CoachTurnArgs): Row {
  requireProject(db, args.userId, args.projectId)
  const node = getRow(db, 'knowledge_node', args.nodeId)
  const syllabus = node && getRow(db, 'exams_syllabus_version', node.syllabus_version_id)
  const subject = syllabus && getRow(db, 'exams_subject', syllabus.subject_id)
  if (!node || !subject || subject.project_id !== args.projectId) throw new ScopeViolation()
  return node
}
function purposeOf(value: string): CoachPurpose {
  if (!(COACH_PURPOSES as readonly string[]).includes(value)) throw new InvalidInput('教练用途无效')
  return value as CoachPurpose
}
function questionGate(db: DatabaseSync, args: CoachTurnArgs, versionId: unknown): Row {
  const version = getRow(db, 'question_bank_question_version', versionId)
  const question = version && getRow(db, 'question_bank_question', version.question_id)
  const subject = question && getRow(db, 'exams_subject', question.subject_id)
  if (!version || !question || subject?.project_id !== args.projectId) throw new ScopeViolation()
  assertContentNotInActiveVerification(db, args.userId, String(version.id), '请求记忆教练')
  assertContentNotSealed(db, args.projectId, String(question.id), '请求记忆教练')
  return version
}
function sessionContext(db: DatabaseSync, args: CoachTurnArgs): { session: Row | null; step: Row | null; item: Row | null } {
  if (args.stepOrdinal != null && (!args.sessionId || !Number.isInteger(args.stepOrdinal) || args.stepOrdinal < 1)) throw new InvalidInput('步骤需要有效会话和序号')
  if (!args.sessionId) return { session: null, step: null, item: null }
  const session = getRow(db, 'learning_interaction_session', args.sessionId)
  if (!session || session.user_id !== args.userId || session.project_id !== args.projectId) throw new ScopeViolation()
  const step = args.stepOrdinal == null ? null : findRows(db, 'learning_session_step', { session_id: session.id, ordinal: args.stepOrdinal })[0]
  if (args.stepOrdinal != null && (!step || step.node_id !== args.nodeId)) throw new ScopeViolation()
  const item = step?.session_item_id ? getRow(db, 'practice_session_item', step.session_item_id) : null
  const practice = item ? getRow(db, 'practice_session', item.session_id) : session.practice_session_id ? getRow(db, 'practice_session', session.practice_session_id) : null
  if (item && (!practice || practice.user_id !== args.userId || practice.project_id !== args.projectId || practice.id !== session.practice_session_id)) throw new ScopeViolation()
  if (step && (args.purpose === 'hint' || args.purpose === 'misconception_probe')) {
    // Interaction modes describe the plan; the linked practice session owns the assessment mode.
    if (session.status !== 'active' || (practice?.mode ?? session.mode) !== 'practice' || (practice && practice.status !== 'active') || step.kind === 'transfer' || step.stage === 'transfer' || step.deadline_at != null || (step.payload as Row)?.timed === true || (item && !item.tutoring_allowed)) throw new PurposeNotAllowed('限时、迁移、验证或非活动练习不提供教练提示')
  }
  if (item) {
    const version = questionGate(db, args, item.question_version_id)
    if (step?.question_id && step.question_id !== version.question_id) throw new ScopeViolation()
  }
  if (!item && step?.question_id) {
    const question = getRow(db, 'question_bank_question', step.question_id)
    if (!question?.current_published_version_id) throw new ScopeViolation()
    questionGate(db, args, question.current_published_version_id)
  }
  return { session, step: step ?? null, item }
}
function sourceAllowed(db: DatabaseSync, args: CoachTurnArgs, id: unknown): boolean {
  try { questionGate(db, args, id); return true } catch (e) { if (e instanceof PurposeNotAllowed || e instanceof ScopeViolation) return false; throw e }
}
function grounding(db: DatabaseSync, args: CoachTurnArgs, node: Row, ctx: ReturnType<typeof sessionContext>) {
  const citations = [`knowledge_node:${args.nodeId}`], versions = new Set<string>()
  const sources: Row[] = [], keyPoints: { id: string; text: string; required?: boolean }[] = []
  const cards = findRows(db, 'knowledge_node_card', { node_id: node.id, is_current: true }, { orderBy: [['revision', 'desc']] })
  const card = cards.find(c => c.status === 'confirmed') ?? (ctx.step ? cards.find(c => c.status === 'draft') : undefined)
  if (card) {
    // A card that names gated question sources must not launder those sources into the prompt.
    const refs = (Array.isArray(card.citations) ? card.citations : []) as unknown[]
    const referenced: string[] = []
    let eligible = true
    for (const ref of refs) {
      if (typeof ref !== 'string') { eligible = false; break }
      const [kind, id] = ref.split(':')
      let versionId: unknown = kind === 'question_version' ? id : null
      if (kind === 'answer_key_version') versionId = getRow(db, 'question_bank_answer_key_version', id)?.question_version_id
      if (kind === 'rubric_version') {
        const rubric = getRow(db, 'question_bank_rubric_version', id)
        versionId = rubric && getRow(db, 'question_bank_answer_key_version', rubric.answer_key_version_id)?.question_version_id
      }
      if (versionId) { if (!sourceAllowed(db, args, versionId)) eligible = false; else referenced.push(String(versionId)) }
      else if (kind !== 'knowledge_node' || id !== args.nodeId) eligible = false
    }
    if (eligible) {
      referenced.forEach(id => versions.add(id))
      citations.push(`node_card:${String(card.id)}:${String(card.revision)}`)
      sources.push({ citation: citations.at(-1), status: card.status === 'confirmed' ? '已确认' : '未确认草稿', blocks: card.blocks, key_points: card.key_points })
      if (card.status === 'confirmed' && Array.isArray(card.key_points)) {
        for (const p of card.key_points.slice(0, 40) as Row[]) if (typeof p.id === 'string' && typeof p.text === 'string') keyPoints.push({ id: p.id, text: p.text, required: p.required === true })
      }
    }
  }
  const candidateIds = [...new Set([...(ctx.item ? [String(ctx.item.question_version_id)] : ctx.step?.question_id ? [String(getRow(db, 'question_bank_question', ctx.step.question_id)?.current_published_version_id)] : []), ...findRows(db, 'knowledge_question_mapping', { node_id: node.id }, { orderBy: [['created_at', 'desc']], limit: 40 }).map(m => String(m.question_version_id))])]
  for (const id of candidateIds.slice(0, 6)) {
    if (!sourceAllowed(db, args, id)) continue
    const version = getRow(db, 'question_bank_question_version', id)!
    if (version.status !== 'published') continue
    const question = getRow(db, 'question_bank_question', version.question_id)!
    versions.add(id); citations.push(`question_version:${id}`)
    sources.push({ citation: citations.at(-1), label: question.display_label, content: version.content })
    const linked = ctx.item?.question_version_id === id ? ctx.item : null
    const answer = linked?.answer_key_version_id ? getRow(db, 'question_bank_answer_key_version', linked.answer_key_version_id) : findRows(db, 'question_bank_answer_key_version', { question_version_id: id }, { orderBy: [['version', 'desc']], limit: 1 })[0]
    if (answer && answer.question_version_id === id && answer.verification_status === 'checked' && !answer.is_disputed) {
      citations.push(`answer_key_version:${String(answer.id)}`)
      sources.push({ citation: citations.at(-1), explanation_blocks: answer.explanation_blocks })
      const rubric = linked?.rubric_version_id ? getRow(db, 'question_bank_rubric_version', linked.rubric_version_id) : findRows(db, 'question_bank_rubric_version', { answer_key_version_id: answer.id }, { orderBy: [['version', 'desc']], limit: 1 })[0]
      if (rubric && rubric.answer_key_version_id === answer.id && rubric.checked_at && !rubric.is_disputed) {
        citations.push(`rubric_version:${String(rubric.id)}`)
        sources.push({ citation: citations.at(-1), criteria: rubric.criteria })
      }
    }
  }
  const memory = findRows(db, 'memory_node_state', { user_id: args.userId, project_id: args.projectId, node_id: node.id }, { limit: 6 }).map(r => ({ modality: r.modality, phase: r.phase, reps: r.reps, lapses: r.lapses, note: r.note }))
  const evidence = findRows(db, 'practice_learning_evidence', { user_id: args.userId, project_id: args.projectId, knowledge_node_id: node.id, is_active: true }, { orderBy: [['created_at', 'desc']], limit: 4 })
  for (const e of evidence) {
    const item = getRow(db, 'practice_session_item', e.session_item_id)
    if (!item || !sourceAllowed(db, args, item.question_version_id)) continue
    const attempt = getRow(db, 'practice_attempt', e.attempt_id)
    if (!attempt) continue
    versions.add(String(item.question_version_id)); citations.push(`practice_attempt:${String(attempt.id)}`)
    sources.push({ citation: citations.at(-1), raw_answer: attempt.raw_answer, dimension: e.dimension, exclusion_reasons: e.exclusion_reasons })
  }
  const path: string[] = [String(node.canonical_name)], seen = new Set([String(node.id)])
  let parent = node.parent_id
  while (parent && path.length < 20 && !seen.has(String(parent))) {
    const row = getRow(db, 'knowledge_node', parent)
    if (!row || row.syllabus_version_id !== node.syllabus_version_id) break
    seen.add(String(row.id)); path.unshift(String(row.canonical_name)); parent = row.parent_id
  }
  const maxHint = Math.min(3, Math.max(1, Number(ctx.step?.hint_level ?? 0) + 1))
  const reflectionSteps: Row[] = []
  if (ctx.session && args.purpose === 'session_reflection') {
    for (const step of findRows(db, 'learning_session_step', { session_id: ctx.session.id }, { orderBy: [['ordinal', 'asc']], limit: 10 })) {
      const item = step.session_item_id ? getRow(db, 'practice_session_item', step.session_item_id) : null
      if (item && !sourceAllowed(db, args, item.question_version_id)) continue
      if (item) versions.add(String(item.question_version_id))
      citations.push(`session_step:${String(step.ordinal)}`)
      reflectionSteps.push({ citation: citations.at(-1), node_id: step.node_id, kind: step.kind, status: step.status, outcome: step.outcome })
    }
  }
  if (ctx.session) citations.push(`interaction_session:${String(ctx.session.id)}`)
  if (ctx.step && !citations.includes(`session_step:${String(ctx.step.ordinal)}`)) citations.push(`session_step:${String(ctx.step.ordinal)}`)
  const input: CoachPromptInput = { node_name: String(node.canonical_name), node_path: path.join(' / '), key_points: keyPoints, learner_text: args.message ?? '', allowed_citations: citations, hint_level: maxHint, sources, memory_summary: memory,
    session_step_facts: { session_id: ctx.session?.id ?? null, status: ctx.session?.status ?? null, step_ordinal: ctx.step?.ordinal ?? null, kind: ctx.step?.kind ?? null, outcome: ctx.step?.outcome ?? null, steps: reflectionSteps } }
  return { input, versions: [...versions], maxHint, keyPoints, citations }
}
function turnOut(row: Row): CoachTurnOut {
  const success = row.status === 'succeeded'
  return { turn_id: String(row.id), thread_key: String(row.thread_key), node_id: String(row.node_id), purpose: row.purpose as CoachPurpose, role: String(row.role), ordinal: Number(row.ordinal), status: String(row.status), text: success ? String(row.text) : '', structured: success ? row.structured as Row : {}, citations: success ? row.citations as string[] : [], missing_information: success ? row.missing_information as string[] : [], prompt_version: String(row.prompt_version), error_code: String(row.error_code), error_message: String(row.error_message), llm_run_id: row.llm_run_id == null ? null : String(row.llm_run_id), created_at: formatPythonIso(row.created_at as Instant) }
}
export function listCoachTurns(db: DatabaseSync, userId: string, projectId: string, nodeId: string, options: { purpose?: string | null; limit?: number } = {}): CoachTurnOut[] {
  nodeScope(db, { userId, projectId, nodeId, purpose: options.purpose ?? 'recall_check' })
  if (options.purpose) purposeOf(options.purpose)
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.trunc(options.limit!))) : 50
  const rows = findRows(db, 'tutoring_coach_turn', { user_id: userId, project_id: projectId, node_id: nodeId, ...(options.purpose ? { purpose: options.purpose } : {}) }, { orderBy: [['created_at', 'desc'], ['ordinal', 'desc']], limit })
  return rows.map(row => {
    if (row.status === 'succeeded') {
      const step = row.step_id ? getRow(db, 'learning_session_step', row.step_id) : null
      const args = { userId, projectId, nodeId, purpose: String(row.purpose), sessionId: row.session_id as string | null, stepOrdinal: step ? Number(step.ordinal) : null }
      sessionContext(db, args)
      const audit = row.llm_run_id ? getRow(db, 'audit_llm_run', row.llm_run_id) : null
      const snapshot = audit?.input_snapshot as Row | undefined
      for (const id of (snapshot?.question_version_ids ?? []) as string[]) questionGate(db, args, id)
    }
    return turnOut(row)
  })
}
export async function runCoachTurn(db: DatabaseSync, args: CoachTurnArgs, deps: { port: LlmPort; now: Instant }): Promise<CoachReplyOut> {
  const purpose = purposeOf(args.purpose), node = nodeScope(db, args), ctx = sessionContext(db, args)
  const linkedVersionId = ctx.item?.question_version_id ?? (ctx.step?.question_id ? getRow(db, 'question_bank_question', ctx.step.question_id)?.current_published_version_id : null)
  const ground = grounding(db, args, node, ctx)
  const prompt = buildCoachPrompt(purpose, ground.input)
  const threadKey = coachThreadKey(args.nodeId, purpose, args.sessionId)
  const write = (status: string, errorCode = '', errorMessage = '', structured: Row = {}, runId: string | null = null): CoachTurnOut => transaction(db, () => {
    const latest = findRows(db, 'tutoring_coach_turn', { thread_key: threadKey }, { orderBy: [['ordinal', 'desc']], limit: 1 })[0]
    const turn = insertRow(db, 'tutoring_coach_turn', { thread_key: threadKey, user_id: args.userId, project_id: args.projectId, node_id: args.nodeId, session_id: ctx.session?.id ?? null, step_id: ctx.step?.id ?? null, purpose, role: 'assistant', ordinal: Number(latest?.ordinal ?? 0) + 1, status, text: status === 'succeeded' ? renderCoachText(purpose, structured) : '', structured, citations: structured.citations ?? [], missing_information: structured.missing_information ?? [], llm_run_id: runId, prompt_version: COACH_PROMPT_VERSION, error_code: errorCode, error_message: pySlice(errorMessage, 500) }, { now: deps.now })
    if (status === 'succeeded' && (structured.reveals_answer === true || (purpose === 'hint' && structured.hint_level === 3)) && linkedVersionId) {
      const version = getRow(db, 'question_bank_question_version', linkedVersionId)!
      const question = getRow(db, 'question_bank_question', version.question_id)!
      insertRow(db, 'practice_exposure_event', { user_id: args.userId, project_id: args.projectId, question_id: question.id, question_version_id: version.id, family_id: question.family_id ?? null, content_lineage_id: question.content_lineage_id ?? null, session_item_id: ctx.item?.id ?? null, kind: structured.reveals_answer === true ? 'answer_delivered' : 'hint_delivered', purpose: 'practice', source: `coach_turn:${purpose}`, server_time: deps.now, reveals_answer: structured.reveals_answer === true, detail: { coach_turn_id: turn.id, hint_level: structured.hint_level ?? null, prompt_version: COACH_PROMPT_VERSION, node_id: args.nodeId } }, { now: deps.now })
    }
    return turnOut(turn)
  })
  const availability = await coachAvailability(deps.port)
  if (!availability.available) return { turn: write('unavailable', availability.reason, availability.message), model_used: false, availability_reason: availability.reason }
  // Availability itself awaits external code; recheck before sending any source text.
  nodeScope(db, args); sessionContext(db, args)
  ground.versions.forEach(id => questionGate(db, args, id))
  const audit = beginAuditedRunOf(db, { capability: COACH_AUDIT_CAPABILITY, promptVersion: COACH_PROMPT_VERSION, system: '', prompt }, { userId: args.userId, projectId: args.projectId, requestSummary: { purpose, node_id: args.nodeId, session_id: args.sessionId ?? null, step_ordinal: args.stepOrdinal ?? null, hint_level_requested: ground.maxHint }, inputSnapshot: { source_ids: ground.citations, question_version_ids: ground.versions, prompt_digest: createHash('sha256').update(prompt).digest('hex'), source_digests: ground.input.sources!.map(s => ({ id: s.citation, digest: createHash('sha256').update(JSON.stringify(s)).digest('hex') })) }, retrievalSourceIds: ground.citations }, deps.now)
  let result: CapabilityResult
  try { result = await deps.port.run({ capability: 'explain', promptVersion: COACH_PROMPT_VERSION, system: '', prompt }) }
  catch { result = { ok: false, code: 'ai_error', message: 'AI 调用失败，请稍后重试。', capability: 'explain', promptVersion: COACH_PROMPT_VERSION, retryable: false } }
  if (!result.ok) return transaction(db, () => {
    finishAuditedRun(db, audit.rowId, markFailed(audit.record, result, telemetryOf(result)), deps.now)
    return { turn: write('failed', result.code, result.message, {}, audit.rowId), model_used: true, availability_reason: result.code }
  })
  let clean: Row = {}, problems: { code: string; message: string }[] = []
  try {
    ;[clean, problems] = validateCoachReply(purpose, parseModelJson(result.text), { allowed_citations: new Set(ground.citations), ...(purpose === 'encode_briefing' ? {} : { allowed_key_point_ids: new Set(ground.keyPoints.map(p => p.id)) }), max_hint_level: ground.maxHint, allowed_step_ids: new Set(ground.citations.filter(id => id.startsWith('session_step:'))) })
  } catch { problems = [{ code: 'invalid_json', message: 'AI 回复不是有效 JSON。' }] }
  if (problems.length) return transaction(db, () => {
    const message = pySlice(problems.map(p => p.message).join('；'), 500)
    finishAuditedRun(db, audit.rowId, markRejected(audit.record, telemetryOf(result), { problems }, message), deps.now)
    return { turn: write('failed', 'ai_invalid_output', message, {}, audit.rowId), model_used: true, availability_reason: '' }
  })
  try { nodeScope(db, args); sessionContext(db, args); ground.versions.forEach(id => questionGate(db, args, id)) }
  catch (error) {
    transaction(db, () => { finishAuditedRun(db, audit.rowId, markFailed(audit.record, { code: 'purpose_not_allowed', message: '交付前内容权限已改变' }, telemetryOf(result)), deps.now); write('failed', 'purpose_not_allowed', '交付前内容权限已改变', {}, audit.rowId) })
    throw error
  }
  if (!linkedVersionId && (clean.reveals_answer === true || clean.hint_level === 3)) clean.detail = { node_only_exposure: true, hint_level: clean.hint_level, reveals_answer: clean.reveals_answer === true }
  return transaction(db, () => {
    finishAuditedRun(db, audit.rowId, markSucceeded(audit.record, telemetryOf(result), { problems: [] }), deps.now)
    return { turn: write('succeeded', '', '', clean, audit.rowId), model_used: true, availability_reason: '' }
  })
}
