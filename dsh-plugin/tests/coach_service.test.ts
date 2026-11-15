import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { countRows, findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import { insertNodeRow, insertSyllabusRow } from './support/b5_fixtures.ts'
import { coachThreadKey, coachAvailability, listCoachTurns, runCoachTurn } from '../src/services/coach.ts'
import { COACH_PROMPT_VERSION } from '../src/ai/coach_prompts.ts'
import type { LlmPort, CapabilityRequest } from '../src/llm/contract.ts'
const NOW = parseInstant('2027-06-01T00:00:00+00:00')
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


function scriptedPort(payload: unknown, available = true): LlmPort & { calls: CapabilityRequest[] } {
  const calls: CapabilityRequest[] = []
  return { calls, async availability() { return { explain: { available, reason: available ? undefined : 'ai_not_configured' } } as Awaited<ReturnType<LlmPort['availability']>> }, async run(request) {
    calls.push(request)
    return { ok: true, text: typeof payload === 'string' ? payload : JSON.stringify(payload), capability: request.capability, promptVersion: request.promptVersion, route: { provider: 'test-provider', model: 'test-model' }, usage: { inputTokens: 7, outputTokens: 9 }, latencyMs: 4 }
  } }
}
function fixture() {
  const handle = openStore({ path: ':memory:' }), db = handle.db
  const user = insertRow(db, 'accounts_user', completeRow('accounts_user', { email: 'coach@example.com', display_name: '学习者', date_joined: NOW }), { now: NOW })
  const userId = String(user.id), projectId = String(createProject(db, userId, { name: '教练' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学' }, NOW).id)
  const syllabusId = insertSyllabusRow(db, { subjectId, now: NOW })
  const nodeId = insertNodeRow(db, { syllabusId, name: '乘法', now: NOW })
  const card = insertRow(db, 'knowledge_node_card', completeRow('knowledge_node_card', { node_id: nodeId, syllabus_version_id: syllabusId, revision: 1, is_current: true, status: 'confirmed', origin: 'manual', blocks: [{ kind: 'text', text: '重复加法' }], key_points: [{ id: 'kp1', text: '相同加数', required: true }], citations: [] }), { now: NOW })
  const args = { userId, projectId, nodeId, purpose: 'recall_check', message: '我记得重复加法' }
  const valid = { coach_message: '请解释加数。', key_points_covered: ['kp1'], key_points_missing: [], cannot_judge: [], next_question: '有几个加数？', citations: [`knowledge_node:${nodeId}`, `node_card:${card.id}:1`] }
  function step(mode = 'practice', hintLevel = 2) {
    const question = insertRow(db, 'question_bank_question', completeRow('question_bank_question', { subject_id: subjectId, origin_type: 'user_authored', is_demo: false, display_label: '题1' }), { now: NOW })
    const draft = createQuestionRevision(db, userId, projectId, String(question.id), { question_type: 'single_choice', content: { blocks: [{ kind: 'text', text: '5 × 4 = ?' }], options: [{ id: 'a' }, { id: 'b' }] }, practice_max_score: '2.00' }, NOW)
    insertRow(db, 'question_bank_answer_key_version', completeRow('question_bank_answer_key_version', { question_version_id: draft.id, version: 1, verification_status: 'checked', check_basis: '教材', is_disputed: false, answer_payload: { kind: 'single_choice', correct_option_id: 'a' }, explanation_blocks: [{ kind: 'text', text: '20' }] }), { now: NOW })
    publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })
    const practice = createSession(db, userId, projectId, { subject_id: subjectId, question_ids: [String(question.id)], mode }, NOW)
    const item = findRows(db, 'practice_session_item', { session_id: practice.id })[0]
    presentItem(db, userId, String(item.id), NOW)
    const session = insertRow(db, 'learning_interaction_session', completeRow('learning_interaction_session', { user_id: userId, project_id: projectId, subject_id: subjectId, syllabus_version_id: syllabusId, mode: 'daily', status: 'active', practice_session_id: practice.id }), { now: NOW })
    const step = insertRow(db, 'learning_session_step', completeRow('learning_session_step', { session_id: session.id, ordinal: 1, stage: 'practice', kind: 'practice', status: 'active', node_id: nodeId, question_id: question.id, session_item_id: item.id, hint_level: hintLevel }), { now: NOW })
    return { session, step, item, question, draft, practice, args: { ...args, purpose: 'hint', sessionId: String(session.id), stepOrdinal: 1 } }
  }
  return { ...handle, args, valid, step, card }
}
const protectedTables = ['practice_grade_event', 'practice_learning_evidence', 'learning_knowledge_state', 'memory_node_state']
test('unconfigured coach writes unavailable turn with no model call or content', async t => {
  const f = fixture(); t.after(f.close); const port = scriptedPort(f.valid, false)
  assert.equal((await coachAvailability(port)).configured, false)
  const reply = await runCoachTurn(f.db, f.args, { port, now: NOW })
  assert.equal(reply.turn.status, 'unavailable'); assert.equal(reply.model_used, false); assert.equal(reply.availability_reason, 'ai_not_configured')
  assert.equal(port.calls.length, 0); assert.equal(reply.turn.text, ''); assert.deepEqual(reply.turn.structured, {}); assert.deepEqual(reply.turn.citations, [])
})
test('validated turn audits the independent label, citations and version; no learning writes or automatic replay', async t => {
  const f = fixture(); t.after(f.close); const port = scriptedPort(f.valid)
  const before = protectedTables.map(table => countRows(f.db, table))
  const reply = await runCoachTurn(f.db, f.args, { port, now: NOW })
  assert.equal(reply.turn.status, 'succeeded'); assert.equal(port.calls.length, 1)
  assert.deepEqual(reply.turn.citations, f.valid.citations)
  assert.deepEqual(protectedTables.map(table => countRows(f.db, table)), before)
  const audit = findRows(f.db, 'audit_llm_run')[0]
  assert.equal(countRows(f.db, 'audit_llm_run'), 1); assert.equal(audit.capability, 'memory_coach'); assert.equal(audit.prompt_version, COACH_PROMPT_VERSION); assert.equal(audit.status, 'succeeded')
  assert.equal(port.calls[0].capability, 'explain'); assert.equal(port.calls[0].system, ''); assert.equal(port.calls[0].promptVersion, COACH_PROMPT_VERSION)
  assert.match(port.calls[0].prompt, /重复加法/); assert.match(port.calls[0].prompt, /我记得重复加法/)
  const second = await runCoachTurn(f.db, f.args, { port, now: NOW })
  assert.equal(second.turn.ordinal, 2); assert.equal(port.calls.length, 2)
  assert.equal(listCoachTurns(f.db, f.args.userId, f.args.projectId, f.args.nodeId).length, 2)
  assert.notEqual(coachThreadKey('n', 'hint'), coachThreadKey('n', 'hint', 's'))
})
for (const [name, patch] of Object.entries({ unknownCitation: { citations: ['invented'] }, score: { score: 4 }, unknownPoint: { key_points_covered: ['alien'] } })) test(`service rejects ${name} with no content`, async t => {
  const f = fixture(); t.after(f.close); const port = scriptedPort({ ...f.valid, ...patch })
  const reply = await runCoachTurn(f.db, f.args, { port, now: NOW })
  assert.equal(reply.turn.status, 'failed'); assert.equal(reply.turn.error_code, 'ai_invalid_output'); assert.deepEqual(reply.turn.structured, {}); assert.equal(reply.turn.text, ''); assert.deepEqual(reply.turn.citations, [])
  assert.equal(findRows(f.db, 'audit_llm_run')[0].status, 'rejected'); assert.equal(countRows(f.db, 'practice_exposure_event'), 0)
})
const hint = { coach_message: '使用重复加法。', hint_blocks: [{ kind: 'text', text: '20' }], hint_level: 3, reveals_answer: true, next_question: '', citations: [] }
test('active verification item refuses hint before calling model or creating audit', async t => {
  const f = fixture(); t.after(f.close); const s = f.step('verification'), port = scriptedPort(hint)
  await assert.rejects(runCoachTurn(f.db, s.args, { port, now: NOW }), { code: 'purpose_not_allowed' })
  assert.equal(port.calls.length, 0); assert.equal(countRows(f.db, 'audit_llm_run'), 0)
})
test('hint exceeding server maximum is rejected', async t => {
  const f = fixture(); t.after(f.close); const port = scriptedPort(hint)
  const reply = await runCoachTurn(f.db, { ...f.args, purpose: 'hint' }, { port, now: NOW })
  assert.equal(reply.turn.error_code, 'ai_invalid_output'); assert.deepEqual(reply.turn.structured, {})
})
test('answer revealing hint commits exactly one exposure and no learning writes', async t => {
  const f = fixture(); t.after(f.close); const s = f.step(), port = scriptedPort(hint)
  const before = protectedTables.map(table => countRows(f.db, table)), exposures = countRows(f.db, 'practice_exposure_event')
  const reply = await runCoachTurn(f.db, s.args, { port, now: NOW })
  assert.equal(reply.turn.status, 'succeeded'); assert.equal(countRows(f.db, 'practice_exposure_event'), exposures + 1)
  const exposure = findRows(f.db, 'practice_exposure_event', { source: 'coach_turn:hint' })[0]
  assert.equal(exposure.kind, 'answer_delivered'); assert.equal(exposure.reveals_answer, true); assert.equal((exposure.detail as any).coach_turn_id, reply.turn.turn_id)
  assert.deepEqual(protectedTables.map(table => countRows(f.db, table)), before)
})
test('level 3 without disclosure records hint exposure with reveals_answer false', async t => {
  const f = fixture(); t.after(f.close); const s = f.step(), port = scriptedPort({ ...hint, reveals_answer: false })
  await runCoachTurn(f.db, s.args, { port, now: NOW })
  const rows = findRows(f.db, 'practice_exposure_event', { source: 'coach_turn:hint' })
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'hint_delivered'); assert.equal(rows[0].reveals_answer, false)
})
test('invalid JSON and transport exceptions leave failed turns and one audit', async t => {
  for (const throws of [false, true]) {
    const f = fixture(); t.after(f.close); const port = scriptedPort('not JSON')
    if (throws) port.run = async () => { throw new Error('private details') }
    const reply = await runCoachTurn(f.db, f.args, { port, now: NOW })
    assert.equal(reply.turn.status, 'failed'); assert.equal(reply.turn.error_code, throws ? 'ai_error' : 'ai_invalid_output'); assert.deepEqual(reply.turn.structured, {}); assert.equal(countRows(f.db, 'audit_llm_run'), 1)
  }
})
test('scope, timed and transfer gates refuse before model', async t => {
  const f = fixture(); t.after(f.close); const s = f.step(), port = scriptedPort(hint)
  for (const patch of [{ stage: 'transfer' }, { stage: 'practice', deadline_at: NOW }]) {
    updateRow(f.db, 'learning_session_step', s.step.id, patch, { now: NOW })
    await assert.rejects(runCoachTurn(f.db, s.args, { port, now: NOW }), { code: 'purpose_not_allowed' })
  }
  await assert.rejects(runCoachTurn(f.db, { ...f.args, nodeId: 'missing' }, { port, now: NOW }), { code: 'not_found' })
  assert.equal(port.calls.length, 0)
})
test('sealing during await blocks delivery and history rechecks sealing', async t => {
  const f = fixture(); t.after(f.close); const s = f.step(), port = scriptedPort(hint)
  const first = await runCoachTurn(f.db, s.args, { port, now: NOW }); assert.equal(first.turn.status, 'succeeded')
  const original = port.run
  port.run = async request => {
    const result = await original(request)
    sealQuestion(f.db, { actorId: f.args.userId, projectId: f.args.projectId, questionId: String(s.question.id), reason: 'holdout', now: NOW })
    return result
  }
  await assert.rejects(runCoachTurn(f.db, s.args, { port, now: NOW }), { code: 'purpose_not_allowed' })
  assert.throws(() => listCoachTurns(f.db, f.args.userId, f.args.projectId, f.args.nodeId), { code: 'purpose_not_allowed' })
  assert.equal(findRows(f.db, 'practice_exposure_event', { source: 'coach_turn:hint' }).length, 1)
})

test('verification of the same content elsewhere blocks a practice coach call', async t => {
  const f = fixture(); t.after(f.close); const s = f.step(), port = scriptedPort(hint)
  const verify = createSession(f.db, f.args.userId, f.args.projectId, { subject_id: String(s.question.subject_id), question_ids: [String(s.question.id)], mode: 'verification' }, NOW)
  const item = findRows(f.db, 'practice_session_item', { session_id: verify.id })[0]
  presentItem(f.db, f.args.userId, String(item.id), NOW)
  await assert.rejects(runCoachTurn(f.db, s.args, { port, now: NOW }), (error: any) => error.code === 'purpose_not_allowed' && error.details.reason === 'active_verification_content_gate')
  assert.equal(port.calls.length, 0)
})
test('question-linked step without an item records a real question exposure', async t => {
  const f = fixture(); t.after(f.close); const s = f.step(), port = scriptedPort(hint)
  updateRow(f.db, 'learning_session_step', s.step.id, { session_item_id: null }, { now: NOW })
  const reply = await runCoachTurn(f.db, s.args, { port, now: NOW })
  assert.equal(reply.turn.status, 'succeeded')
  const exposure = findRows(f.db, 'practice_exposure_event', { source: 'coach_turn:hint' })[0]
  assert.equal(exposure.question_version_id, s.draft.id); assert.equal(exposure.session_item_id, null)
})
test('honest abstention succeeds; encoding is a dialogue draft only', async t => {
  const f = fixture(); t.after(f.close)
  const reply = await runCoachTurn(f.db, f.args, { port: scriptedPort({ ...f.valid, key_points_covered: [], cannot_judge: ['缺少推导'], missing_information: ['缺少推导'] }), now: NOW })
  assert.equal(reply.turn.status, 'succeeded'); assert.deepEqual(reply.turn.missing_information, ['缺少推导'])
  const cards = countRows(f.db, 'knowledge_node_card')
  const draft = await runCoachTurn(f.db, { ...f.args, purpose: 'encode_briefing' }, { port: scriptedPort({ coach_message: '待确认草稿', blocks: [{ kind: 'text', text: '相同加数' }], key_points: [{ id: 'draft-kp', text: '重复加法', required: true }], citations: f.valid.citations }), now: NOW })
  assert.equal(draft.turn.status, 'succeeded'); assert.equal(countRows(f.db, 'knowledge_node_card'), cards)
})
test('finished session reflection uses actual step facts and does not mutate sessions', async t => {
  const f = fixture(); t.after(f.close); const s = f.step()
  updateRow(f.db, 'learning_interaction_session', s.session.id, { status: 'finished' }, { now: NOW })
  const before = findRows(f.db, 'learning_interaction_session')
  const port = scriptedPort({ coach_message: '记录了练习步骤', highlights: ['练习步骤'], next_focus: [], step_ids: ['session_step:1'], citations: ['session_step:1'] })
  const reply = await runCoachTurn(f.db, { ...f.args, purpose: 'session_reflection', sessionId: String(s.session.id) }, { port, now: NOW })
  assert.equal(reply.turn.status, 'succeeded'); assert.match(port.calls[0].prompt, /session_step:1/)
  assert.deepEqual(findRows(f.db, 'learning_interaction_session'), before)
})
test('node-only requests exclude drafts and gated mapped questions', async t => {
  const f = fixture(); t.after(f.close); const s = f.step('verification')
  updateRow(f.db, 'knowledge_node_card', f.card.id, { status: 'draft', blocks: [{ kind: 'text', text: 'SECRET_DRAFT' }] }, { now: NOW })
  insertRow(f.db, 'knowledge_question_mapping', completeRow('knowledge_question_mapping', { question_version_id: s.draft.id, node_id: f.args.nodeId, mapping_revision: 1, is_primary: true, score_weight: '1.0' }), { now: NOW })
  const port = scriptedPort({ ...f.valid, key_points_covered: [], citations: [`knowledge_node:${f.args.nodeId}`], cannot_judge: ['缺少已确认资料'] })
  const reply = await runCoachTurn(f.db, f.args, { port, now: NOW })
  assert.equal(reply.turn.status, 'succeeded'); assert.doesNotMatch(port.calls[0].prompt, /SECRET_DRAFT|5 × 4/)
  assert.doesNotMatch(port.calls[0].prompt, new RegExp(String(s.draft.id)))
})
