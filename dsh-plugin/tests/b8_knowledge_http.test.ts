/**
 * The knowledge-domain operations through the real HTTP surface (`Request`→`Response`).
 *
 * These pin what a golden replay cannot see: status codes, the error envelope, query/body binding,
 * the idempotency claim/replay/conflict contract, scope 404s, the cycle refusal **with its path**, and
 * the honesty rule for tag suggestions (no model → 503, and nothing in the database moves).
 *
 * The routes are mounted exactly the way the entry point mounts them: `acepassRoutes({ llm })`, which
 * includes `knowledgeExtraRoutes(deps)` — never a second copy, or the first match would shadow the
 * injected port.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import type { CapabilityResult, LlmPort } from '../src/llm/contract.ts'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'
const CONTENT = {
  blocks: [{ kind: 'text', text: '2 + 2 等于几？' }],
  options: [
    { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '4' }] },
    { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '5' }] },
  ],
}

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

/** A provider the tests script; it never ships (R-INV 4 forbids a stub inside the product). */
function fakePort(result: CapabilityResult): LlmPort {
  return {
    async availability() {
      return {
        extract_question: { available: false, reason: 'ai_not_configured' },
        transcribe_handwriting: { available: false, reason: 'ai_not_configured' },
        suggest_tags: { available: true },
        explain: { available: false, reason: 'ai_not_configured' },
        diagnose: { available: false, reason: 'ai_not_configured' },
        estimate_grade: { available: false, reason: 'ai_not_configured' },
        propose_variant: { available: false, reason: 'ai_not_configured' },
        embed: { available: false, reason: 'ai_capability_unsupported' },
      }
    },
    async run() {
      return result
    },
  }
}

function okResult(text: string): CapabilityResult {
  return {
    ok: true,
    text,
    route: { provider: 'scripted', model: 'scripted-model' },
    promptVersion: 'p1-suggest-tags-v1',
    capability: 'suggest_tags',
    usage: { inputTokens: 11, outputTokens: 22 },
    latencyMs: 3,
  }
}

interface Harness {
  db: ReturnType<typeof openStore>['db']
  close: () => void
  userId: string
  projectId: string
  otherProjectId: string
  subjectId: string
  otherSubjectId: string
  syllabusId: string
  otherSyllabusId: string
  nodes: Record<string, string>
  questions: Record<string, string>
  versions: Record<string, string>
  setPort: (port: LlmPort | undefined) => void
  call: (
    method: string,
    path: string,
    options?: { body?: unknown; key?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any }>
}

/** Three published single-choice questions on three nodes, all in one published syllabus. */
function harness(): Harness {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const userId = String(
    insertRow(
      db,
      'accounts_user',
      completeRow('accounts_user', {
        email: 'owner@acepass.local',
        display_name: '本机用户',
        date_joined: NOW,
        password: '!',
      }),
      { now: NOW },
    ).id,
  )
  const projectId = String(createProject(db, userId, { name: '知识项目' }, NOW).id)
  const otherProjectId = String(createProject(db, userId, { name: '另一个项目' }, NOW).id)
  const subjectId = String(createSubject(db, userId, projectId, { name: '数学', code: 'MATH' }, NOW).id)
  const otherSubjectId = String(createSubject(db, userId, otherProjectId, { name: '物理', code: 'PHYS' }, NOW).id)

  const syllabusId = String(
    insertRow(
      db,
      'exams_syllabus_version',
      completeRow('exams_syllabus_version', {
        subject_id: subjectId,
        name: '数学大纲',
        version_label: 'v1',
        status: 'published',
        is_user_provisional: true,
        created_at: NOW,
      }),
      { now: NOW },
    ).id,
  )
  const otherSyllabusId = String(
    insertRow(
      db,
      'exams_syllabus_version',
      completeRow('exams_syllabus_version', {
        subject_id: otherSubjectId,
        name: '物理大纲',
        version_label: 'v1',
        status: 'published',
        is_user_provisional: false,
        created_at: NOW + 1_000_000n,
      }),
      { now: NOW },
    ).id,
  )
  const nodes: Record<string, string> = {}
  const names = ['alpha', 'beta', 'gamma']
  names.forEach((name, index) => {
    nodes[name] = String(
      insertRow(
        db,
        'knowledge_node',
        completeRow('knowledge_node', {
          syllabus_version_id: syllabusId,
          canonical_name: name,
          kind: 'point',
          code: `C${index}`,
          aliases: [],
          is_unclassified: false,
          display_order: index,
        }),
        { now: NOW },
      ).id,
    )
  })

  const questions: Record<string, string> = {}
  const versions: Record<string, string> = {}
  names.forEach((name, index) => {
    const question = insertRow(
      db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subjectId,
        origin_type: 'user_authored',
        is_demo: false,
        display_label: `Q-0${index}`,
      }),
      { now: NOW },
    )
    questions[name] = String(question.id)
    const draft = createQuestionRevision(
      db,
      userId,
      projectId,
      String(question.id),
      { question_type: 'single_choice', content: CONTENT, practice_max_score: '2.00' },
      NOW,
    )
    versions[name] = String(draft.id)
    insertRow(
      db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: String(draft.id),
        version: 1,
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
        check_basis: '教材',
      }),
      { now: NOW },
    )
    publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })
    insertRow(
      db,
      'knowledge_question_mapping',
      completeRow('knowledge_question_mapping', {
        question_version_id: String(draft.id),
        mapping_revision: 1,
        node_id: nodes[name],
        is_primary: true,
        score_weight: '1.0000',
        note: '',
      }),
      { now: NOW },
    )
  })

  let port: LlmPort | undefined
  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    // One mount point, exactly like the entry point: `acepassRoutes(deps)` owns the knowledge
    // routes, so injecting the port there is the same path production takes.
    routes: acepassRoutes({ llm: () => port ?? unreachablePort() }),
    actor: () => ({ userId, now }),
  })
  let counter = 0
  const call: Harness['call'] = async (method, path, options = {}) => {
    counter += 1
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    }
    if (options.key !== undefined) headers['idempotency-key'] = options.key
    const request = new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const response = await handler(request)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    otherProjectId,
    subjectId,
    otherSubjectId,
    syllabusId,
    otherSyllabusId,
    nodes,
    questions,
    versions,
    setPort: (next) => {
      port = next
    },
    call,
  }
}

/** A model that cannot answer: used by the "no model configured" cases. */
function unreachablePort(): LlmPort {
  return {
    async availability() {
      return {
        extract_question: { available: false, reason: 'ai_not_configured' },
        transcribe_handwriting: { available: false, reason: 'ai_not_configured' },
        suggest_tags: { available: false, reason: 'ai_not_configured' },
        explain: { available: false, reason: 'ai_not_configured' },
        diagnose: { available: false, reason: 'ai_not_configured' },
        estimate_grade: { available: false, reason: 'ai_not_configured' },
        propose_variant: { available: false, reason: 'ai_not_configured' },
        embed: { available: false, reason: 'ai_capability_unsupported' },
      }
    },
    async run(request) {
      return {
        ok: false,
        code: 'ai_not_configured',
        message: 'AI 未配置',
        capability: request.capability,
        promptVersion: request.promptVersion,
        retryable: false,
      }
    },
  }
}

/* ------------------------------------------------------------------------- */

test('b8 http: question templates are a get-or-create per subject and name', async () => {
  const h = harness()
  try {
    const empty = await h.call('GET', `/projects/${h.projectId}/question-templates`)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, [])

    const created = await h.call('POST', `/projects/${h.projectId}/question-templates`, {
      body: { subject_id: h.subjectId, name: '  计算题  ', description: '两步运算' },
    })
    assert.equal(created.status, 201)
    assert.deepEqual(Object.keys(created.body).sort(), ['description', 'id', 'name', 'review_status', 'subject_id'])
    assert.equal(created.body.name, '计算题', 'the name is trimmed before it becomes an identity')
    assert.equal(created.body.review_status, 'approved', 'a confirmed template is approved, not draft')
    assert.equal(created.body.description, '两步运算')

    // The same name must not split one "way of asking" into two identities.
    const again = await h.call('POST', `/projects/${h.projectId}/question-templates`, {
      body: { subject_id: h.subjectId, name: '计算题', description: '更新后的说明' },
    })
    assert.equal(again.status, 201, 'Django answers 201 even when the row was reused')
    assert.equal(again.body.id, created.body.id)
    assert.equal(again.body.description, '更新后的说明')

    const listed = await h.call('GET', `/projects/${h.projectId}/question-templates?subject_id=${h.subjectId}`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.length, 1)

    const blank = await h.call('POST', `/projects/${h.projectId}/question-templates`, {
      body: { subject_id: h.subjectId, name: '   ' },
    })
    assert.equal(blank.status, 400)
    assert.equal(blank.body.error.message, '模板名称不能为空')

    const missing = await h.call('POST', `/projects/${h.projectId}/question-templates`, {
      body: { name: '缺科目' },
    })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'invalid_input')
    assert.deepEqual(missing.body.error.details.errors, [
      { type: 'missing', loc: ['body', 'payload', 'subject_id'], msg: 'Field required' },
    ])

    // A subject of another project is not reachable through this project's scope.
    const crossProject = await h.call('GET', `/projects/${h.projectId}/question-templates?subject_id=${h.otherSubjectId}`)
    assert.equal(crossProject.status, 404)
    assert.equal(crossProject.body.error.code, 'not_found')
  } finally {
    h.close()
  }
})

test('b8 http: a pairing is versioned, replayed by its key and refused outside its subject', async () => {
  const h = harness()
  try {
    const [alpha, beta, gamma] = ['alpha', 'beta', 'gamma']
    const first = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-1',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: h.questions[beta],
        baseline_question_id: h.questions[alpha],
        delay_hours: 24,
        note: '人工配对',
      },
    })
    assert.equal(first.status, 201)
    assert.equal(first.body.node_name, alpha)
    assert.equal(first.body.pairing_version, 1)
    assert.equal(first.body.is_active, true)
    assert.match(first.body.gap, /缺少延迟验证题/, 'a pairing without C says so up front')

    // Same key + same payload replays the stored response instead of writing a second row.
    const replay = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-1',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: h.questions[beta],
        baseline_question_id: h.questions[alpha],
        delay_hours: 24,
        note: '人工配对',
      },
    })
    assert.equal(replay.status, 201)
    assert.equal(replay.body.id, first.body.id)
    assert.equal(findRows(h.db, 'knowledge_verification_pairing', {}).length, 1)

    // Omitting the defaults is the same request: Django fingerprints `model_dump`, so does this.
    const replayWithDefaultsOmitted = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-1',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: h.questions[beta],
        baseline_question_id: h.questions[alpha],
        delay_hours: 24,
        note: '人工配对',
      },
    })
    assert.equal(replayWithDefaultsOmitted.body.id, first.body.id)

    const conflict = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-1',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: h.questions[gamma],
        delay_hours: 24,
      },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'idempotency_conflict')

    // A second reviewed pairing on the same node is a new *version*, not a duplicate.
    const second = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-2',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: h.questions[beta],
        delayed_question_id: h.questions[gamma],
        baseline_question_id: h.questions[alpha],
        delay_hours: 24,
        note: '补齐 C 题',
      },
    })
    assert.equal(second.status, 201)
    assert.equal(second.body.pairing_version, 2)
    assert.equal(second.body.gap, '', 'with a C question there is no gap')

    const listed = await h.call('GET', `/projects/${h.projectId}/verification-pairings?subject_id=${h.subjectId}`)
    assert.equal(listed.status, 200)
    assert.deepEqual(
      listed.body.map((row: any) => row.pairing_version),
      [2, 1],
      'newest version first',
    )

    const detail = await h.call(
      'GET',
      `/projects/${h.projectId}/verification-pairings/${first.body.id}`,
    )
    assert.equal(detail.status, 200)
    assert.equal(detail.body.pairing.id, first.body.id)
    assert.deepEqual(
      detail.body.candidates.map((row: any) => row.id),
      [h.questions[alpha]],
      'only the primary-mapped question of that node is a candidate',
    )
    assert.equal(detail.body.candidates[0].question_type, 'single_choice')

    const unknownProject = await h.call(
      'GET',
      `/projects/${h.otherProjectId}/verification-pairings/${first.body.id}`,
    )
    assert.equal(unknownProject.status, 404)
    assert.equal(unknownProject.body.error.message, '配对不存在或不属于该项目')

    const badNode = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-3',
      body: {
        subject_id: h.subjectId,
        node_id: 'not-a-node',
        immediate_question_id: h.questions[beta],
      },
    })
    assert.equal(badNode.status, 404)
    assert.equal(badNode.body.error.message, '考点不存在或不属于该科目')

    const badQuestion = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-4',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: 'not-a-question',
      },
    })
    assert.equal(badQuestion.status, 404)
    assert.equal(badQuestion.body.error.message, 'B 题不存在或不属于该科目')

    const zeroDelay = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-5',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: h.questions[beta],
        delay_hours: 0,
      },
    })
    assert.equal(zeroDelay.status, 400)
    assert.equal(zeroDelay.body.error.message, '延迟验证间隔至少 1 小时')

    // B and C must differ from the baseline: one question cannot play two roles.
    const duplicate = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      key: 'pairing-key-6',
      body: {
        subject_id: h.subjectId,
        node_id: h.nodes['alpha'],
        immediate_question_id: h.questions[beta],
        delayed_question_id: h.questions[beta],
        baseline_question_id: h.questions[beta],
      },
    })
    assert.equal(duplicate.status, 422)
    assert.equal(duplicate.body.error.code, 'structure_invalid')
    assert.deepEqual(duplicate.body.error.details.errors, {
      immediate_question: ['B/C 题必须是不同于基准题的其他稳定题目'],
    })

    const noKey = await h.call('POST', `/projects/${h.projectId}/verification-pairings`, {
      body: { subject_id: h.subjectId, node_id: h.nodes['alpha'], immediate_question_id: h.questions[beta] },
    })
    assert.equal(noKey.status, 409, 'Django raises IdempotencyConflict, not a 400')
    assert.equal(noKey.body.error.message, '缺少 Idempotency-Key 请求头')
  } finally {
    h.close()
  }
})

test('b8 http: the knowledge map joins nodes with real evidence and requires one subject', async () => {
  const h = harness()
  try {
    const missingSubject = await h.call('GET', `/projects/${h.projectId}/knowledge-map`)
    assert.equal(missingSubject.status, 400)
    assert.deepEqual(missingSubject.body.error.details.errors, [
      { type: 'missing', loc: ['query', 'subject_id'], msg: 'Field required' },
    ])

    const map = await h.call('GET', `/projects/${h.projectId}/knowledge-map?subject_id=${h.subjectId}`)
    assert.equal(map.status, 200)
    assert.equal(map.body.subject_id, h.subjectId)
    assert.deepEqual(
      map.body.nodes.map((node: any) => node.name),
      ['alpha', 'beta', 'gamma'],
      'display_order then canonical_name',
    )
    const first = map.body.nodes[0]
    assert.equal(first.parent_id, null)
    assert.equal(first.syllabus_version_id, h.syllabusId)
    assert.equal(first.syllabus_is_user_provisional, true)
    assert.equal(first.question_count, 1, 'the primary mapping is counted')
    assert.deepEqual(first.evidence, {
      summary: 'undiagnosed',
      best_summary: 'undiagnosed',
      independent_correct_count: 0,
      distinct_question_count: 0,
      distinct_template_count: 0,
      has_delayed_correct: false,
      needs_review: false,
      downgrade_reason: '',
      as_of: null,
      rule_version: null,
    })

    // A real state row is projected, never simulated.
    insertRow(
      h.db,
      'learning_knowledge_state',
      completeRow('learning_knowledge_state', {
        user_id: h.userId,
        project_id: h.projectId,
        node_id: h.nodes['alpha'],
        syllabus_version_id: h.syllabusId,
        summary: 'independent',
        best_summary: 'delayed_verified',
        independent_correct_count: 2,
        distinct_question_count: 2,
        distinct_template_count: 1,
        has_delayed_correct: true,
        needs_review: false,
        downgrade_reason: '',
        detail: {},
        as_of: NOW,
        rule_version: 'p2-c04',
      }),
      { now: NOW },
    )
    const withState = await h.call('GET', `/projects/${h.projectId}/knowledge-map?subject_id=${h.subjectId}`)
    assert.equal(withState.body.nodes[0].evidence.summary, 'independent')
    assert.equal(withState.body.nodes[0].evidence.best_summary, 'delayed_verified')
    assert.equal(withState.body.nodes[0].evidence.has_delayed_correct, true)
    assert.equal(withState.body.nodes[0].evidence.as_of, '2026-08-01T00:00:00+00:00')

    const otherSubject = await h.call(
      'GET',
      `/projects/${h.projectId}/knowledge-map?subject_id=${h.otherSubjectId}`,
    )
    assert.equal(otherSubject.status, 404, 'a subject of another project is out of scope')
  } finally {
    h.close()
  }
})

test('b8 http: an edge that would close a cycle is refused with its path, then deactivated', async () => {
  const h = harness()
  try {
    const body = (from: string, to: string) => ({
      syllabus_version_id: h.syllabusId,
      from_node_id: h.nodes[from],
      to_node_id: h.nodes[to],
      relation_type: 'prerequisite',
      note: '先学前者',
    })

    const created = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'relation-1',
      body: body('alpha', 'beta'),
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.from_node_name, 'alpha')
    assert.equal(created.body.to_node_name, 'beta')
    assert.equal(created.body.is_active, true)

    // Same key, same payload: replay, no second edge.
    const replayed = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'relation-1',
      body: body('alpha', 'beta'),
    })
    assert.equal(replayed.status, 201)
    assert.equal(replayed.body.id, created.body.id)

    // The reverse edge closes a cycle; the details carry the path the UI renders.
    const refused = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'relation-2',
      body: body('beta', 'alpha'),
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'invalid_input')
    assert.equal(refused.body.error.message, '加入该关系会形成环，已拒绝')
    assert.deepEqual(refused.body.error.details.cycle_node_ids, [h.nodes.beta, h.nodes.alpha, h.nodes.beta])
    assert.deepEqual(refused.body.error.details.cycle_names, ['beta', 'alpha', 'beta'])

    const graph = await h.call('GET', `/projects/${h.projectId}/knowledge-relations?subject_id=${h.subjectId}`)
    assert.equal(graph.status, 200)
    assert.equal(graph.body.edge_count, 1, 'the refused edge wrote nothing')
    assert.equal(graph.body.node_count, 3)
    assert.equal(graph.body.generated_at, '2026-08-01T00:00:00+00:00')
    assert.deepEqual(graph.body.unmet_prerequisites, [])
    assert.equal(graph.body.edges.length, 1)

    const selfLoop = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'relation-3',
      body: body('alpha', 'alpha'),
    })
    assert.equal(selfLoop.status, 400)
    assert.equal(selfLoop.body.error.message, '考点不能以自身为前置或相关关系')

    const unknownType = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'relation-4',
      body: { ...body('alpha', 'gamma'), relation_type: 'depends_on' },
    })
    assert.equal(unknownType.status, 400)
    assert.equal(unknownType.body.error.message, '未知的关系类型')
    assert.deepEqual(unknownType.body.error.details, { relation_type: 'depends_on' })

    const crossSyllabus = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'relation-5',
      body: { ...body('alpha', 'beta'), syllabus_version_id: h.otherSyllabusId },
    })
    assert.equal(crossSyllabus.status, 404, 'a syllabus of another project is out of scope')

    const deactivated = await h.call(
      'DELETE',
      `/projects/${h.projectId}/knowledge-relations/${created.body.id}?reason=${encodeURIComponent('方向写错了')}`,
    )
    assert.equal(deactivated.status, 200)
    assert.equal(deactivated.body.is_active, false)
    assert.equal(deactivated.body.note, '方向写错了')
    assert.equal(
      findRows(h.db, 'knowledge_relation', { id: created.body.id }).length,
      1,
      'the history row stays: an edge is evidence, not scratch state',
    )

    const reactivated = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'relation-6',
      body: body('alpha', 'beta'),
    })
    assert.equal(reactivated.status, 201)
    assert.equal(reactivated.body.id, created.body.id, 'a re-added edge revives the same row')
    assert.equal(reactivated.body.is_active, true)

    const afterReactivation = await h.call(
      'GET',
      `/projects/${h.projectId}/knowledge-relations?subject_id=${h.subjectId}`,
    )
    assert.equal(afterReactivation.body.edge_count, 1)

    const unknownRelation = await h.call(
      'DELETE',
      `/projects/${h.projectId}/knowledge-relations/not-a-relation`,
    )
    assert.equal(unknownRelation.status, 404)
    assert.equal(unknownRelation.body.error.message, '关系不存在或不属于该项目')
  } finally {
    h.close()
  }
})

test('b8 http: prerequisites report which ones block and why', async () => {
  const h = harness()
  try {
    const edge = await h.call('POST', `/projects/${h.projectId}/knowledge-relations`, {
      key: 'prereq-1',
      body: {
        syllabus_version_id: h.syllabusId,
        from_node_id: h.nodes['alpha'],
        to_node_id: h.nodes.gamma,
        relation_type: 'prerequisite',
        note: '',
      },
    })
    assert.equal(edge.status, 201)

    const undiagnosed = await h.call(
      'GET',
      `/projects/${h.projectId}/knowledge-nodes/${h.nodes.gamma}/prerequisites`,
    )
    assert.equal(undiagnosed.status, 200)
    assert.equal(undiagnosed.body.node_id, h.nodes.gamma)
    assert.equal(undiagnosed.body.node_name, 'gamma')
    assert.deepEqual(undiagnosed.body.prerequisites, [
      { node_id: h.nodes['alpha'], node_name: 'alpha', state: 'undiagnosed' },
    ])
    assert.deepEqual(undiagnosed.body.unmet, [
      { node_id: h.nodes['alpha'], node_name: 'alpha', state: 'undiagnosed', reason: 'prerequisite_undiagnosed' },
    ])

    // A diagnosed-but-needs-review prerequisite still blocks, with its own reason.
    const state = insertRow(
      h.db,
      'learning_knowledge_state',
      completeRow('learning_knowledge_state', {
        user_id: h.userId,
        project_id: h.projectId,
        node_id: h.nodes['alpha'],
        syllabus_version_id: h.syllabusId,
        summary: 'needs_review',
        best_summary: 'independent',
        independent_correct_count: 2,
        distinct_question_count: 2,
        distinct_template_count: 1,
        has_delayed_correct: false,
        needs_review: true,
        downgrade_reason: '',
        detail: {},
        as_of: NOW,
        rule_version: 'p2-c04',
      }),
      { now: NOW },
    )
    const needsReview = await h.call(
      'GET',
      `/projects/${h.projectId}/knowledge-nodes/${h.nodes.gamma}/prerequisites`,
    )
    assert.equal(needsReview.body.prerequisites[0].state, 'needs_review')
    assert.equal(needsReview.body.unmet[0].reason, 'prerequisite_needs_review')

    // Once the learner can do it unaided, the prerequisite stops blocking.
    updateRow(h.db, 'learning_knowledge_state', state.id, { summary: 'independent', needs_review: false }, { now: NOW })
    const satisfied = await h.call(
      'GET',
      `/projects/${h.projectId}/knowledge-nodes/${h.nodes.gamma}/prerequisites`,
    )
    assert.equal(satisfied.body.prerequisites[0].state, 'independent')
    assert.deepEqual(satisfied.body.unmet, [])

    const unknown = await h.call(
      'GET',
      `/projects/${h.projectId}/knowledge-nodes/not-a-node/prerequisites`,
    )
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.message, '考点不存在或不属于该项目')
  } finally {
    h.close()
  }
})

test('b8 http: tag suggestions fail honestly without a model and never write mappings', async () => {
  const h = harness()
  try {
    const before = {
      nodes: findRows(h.db, 'knowledge_node', {}).length,
      mappings: findRows(h.db, 'knowledge_question_mapping', {}).length,
      suggestions: findRows(h.db, 'knowledge_tag_suggestion', {}).length,
    }
    const listed = await h.call(
      'GET',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
    )
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body, [])

    const refused = await h.call(
      'POST',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
      { key: 'tags-1', body: {} },
    )
    assert.equal(refused.status, 503)
    assert.equal(refused.body.error.code, 'ai_not_configured')
    assert.equal(refused.body.error.message, '未配置可用的文本模型，无法生成标签建议')

    // Nothing may move (R-INV 4) — and Django leaves no audit row for a *refused* call either: its
    // `propose_tags` transaction rolls the run row back when it raises (probe case A02 records an
    // empty `row_delta`). This port matches that exactly.
    assert.equal(findRows(h.db, 'knowledge_node', {}).length, before.nodes)
    assert.equal(findRows(h.db, 'knowledge_question_mapping', {}).length, before.mappings)
    assert.equal(findRows(h.db, 'knowledge_tag_suggestion', {}).length, before.suggestions)
    assert.equal(findRows(h.db, 'audit_llm_run', {}).length, 0)

    // The claim was released, so the same key can be retried once a model exists.
    const retried = await h.call(
      'POST',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
      { key: 'tags-1', body: {} },
    )
    assert.equal(retried.status, 503, 'a released claim is retried, not reported as a conflict')

    const unknownVersion = await h.call(
      'GET',
      `/projects/${h.projectId}/question-versions/not-a-version/tag-suggestions`,
    )
    assert.equal(unknownVersion.status, 404)
    assert.equal(unknownVersion.body.error.message, '题目版本不存在或不属于该项目')

    const noKey = await h.call(
      'POST',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
      { body: {} },
    )
    assert.equal(noKey.status, 409)
    assert.equal(noKey.body.error.message, '缺少 Idempotency-Key 请求头')
  } finally {
    h.close()
  }
})

test('b8 http: a scripted model only produces inert proposals, and a human decides', async () => {
  const h = harness()
  try {
    h.setPort(fakePort(okResult(JSON.stringify({
      tags: [
        { name: 'beta', confidence: 0.9, rationale: '题干涉及 beta' },
        { name: 'invented-topic', confidence: 0.8, rationale: '不在大纲' },
      ],
    }))))
    const created = await h.call(
      'POST',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
      { key: 'tags-model-1', body: {} },
    )
    assert.equal(created.status, 201)
    assert.equal(created.body.status, 'proposed')
    assert.equal(created.body.is_stub, false)
    assert.equal(created.body.model_identifier, 'scripted-model')
    const run = findRows(h.db, 'audit_llm_run', {})[0]!
    assert.equal(run.capability, 'suggest_tags')
    assert.equal(run.status, 'succeeded')
    assert.equal(run.model_identifier, 'scripted-model')
    assert.deepEqual((run.validation_result as any).accepted, 1)
    assert.equal((run.validation_result as any).problems.length, 1, 'the invented name is recorded as a problem')
    assert.equal(created.body.prompt_version, 'p1-suggest-tags-v1')
    assert.deepEqual(
      created.body.proposals.map((row: any) => row.name),
      ['beta'],
      'a name that is not in the syllabus is dropped by the validator, never invented',
    )
    assert.deepEqual(created.body.latest_mappings, [
      { node_id: h.nodes.alpha, node_name: 'alpha', weight: '1.0000', is_primary: true },
    ])

    // The proposal itself wrote no mapping and changed no node.
    assert.equal(findRows(h.db, 'knowledge_question_mapping', { question_version_id: h.versions.alpha }).length, 1)
    assert.equal(findRows(h.db, 'knowledge_node', {}).length, 3)

    // A second proposal supersedes the pending one instead of stacking two actionable rows.
    h.setPort(fakePort(okResult(JSON.stringify({ tags: [{ name: 'gamma', confidence: 0.7, rationale: '同义' }] }))))
    const second = await h.call(
      'POST',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
      { key: 'tags-model-2', body: {} },
    )
    assert.equal(second.status, 201)
    const listed = await h.call(
      'GET',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
    )
    // Exactly one actionable proposal survives. (The relative order is not asserted: the test clock
    // is frozen, so both rows share `created_at` and Django's `-created_at` has no tie-break either.)
    assert.deepEqual(
      listed.body.map((row: any) => row.status).sort(),
      ['proposed', 'superseded'],
      'exactly one actionable proposal',
    )
    assert.deepEqual(
      listed.body.filter((row: any) => row.status === 'proposed').map((row: any) => row.id),
      [second.body.id],
    )

    // Accepting writes a *new auxiliary mapping revision* with weight 0.
    const accepted = await h.call(
      'POST',
      `/projects/${h.projectId}/tag-suggestions/${second.body.id}/accept`,
      { body: { node_names: ['gamma'], note: '人工核对' } },
    )
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.status, 'accepted')
    assert.equal(accepted.body.mapping_revision, 2)
    assert.deepEqual(accepted.body.added_node_names, ['gamma'])
    const revisionTwo = findRows(h.db, 'knowledge_question_mapping', {
      question_version_id: h.versions.alpha,
      mapping_revision: 2,
    })
    assert.equal(revisionTwo.length, 2)
    const auxiliary = revisionTwo.find((row) => String(row.node_id) === h.nodes.gamma)!
    assert.equal(auxiliary.is_primary, false)
    assert.equal(String(auxiliary.score_weight), '0.0000')
    const primary = revisionTwo.find((row) => row.is_primary === true)!
    assert.equal(String(primary.node_id), h.nodes.alpha, 'the primary scoring mapping is untouched')

    // Accepting twice is refused: one decision per proposal.
    const twice = await h.call(
      'POST',
      `/projects/${h.projectId}/tag-suggestions/${second.body.id}/accept`,
      { body: { node_names: ['gamma'] } },
    )
    assert.equal(twice.status, 400)
    assert.equal(twice.body.error.message, '该建议已被处理，不能重复采纳')

    // A proposal whose names are all already mapped adds nothing and says why.
    h.setPort(fakePort(okResult(JSON.stringify({ tags: [{ name: 'gamma', confidence: 0.5, rationale: '重复' }] }))))
    const duplicateProposal = await h.call(
      'POST',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
      { key: 'tags-model-3', body: {} },
    )
    const refusedAccept = await h.call(
      'POST',
      `/projects/${h.projectId}/tag-suggestions/${duplicateProposal.body.id}/accept`,
      { body: { node_names: ['gamma'] } },
    )
    assert.equal(refusedAccept.status, 400)
    assert.equal(refusedAccept.body.error.message, '所有建议的考点都已映射，没有新增内容')

    // Rejecting records the decision and writes no mapping.
    const rejected = await h.call(
      'POST',
      `/projects/${h.projectId}/tag-suggestions/${duplicateProposal.body.id}/reject`,
      { body: { note: '不需要' } },
    )
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.status, 'rejected')
    assert.equal(rejected.body.decision_note, '不需要')
    assert.equal(
      findRows(h.db, 'knowledge_question_mapping', { question_version_id: h.versions.alpha, mapping_revision: 2 }).length,
      2,
      'a rejection writes no mapping revision',
    )

    const unknownSuggestion = await h.call(
      'POST',
      `/projects/${h.projectId}/tag-suggestions/not-a-suggestion/accept`,
      { body: {} },
    )
    assert.equal(unknownSuggestion.status, 404)
    assert.equal(unknownSuggestion.body.error.message, '标签建议不存在或不属于该项目')
  } finally {
    h.close()
  }
})

test('b8 http: a failing model is a dependency failure, never a fabricated proposal', async () => {
  const h = harness()
  try {
    h.setPort(
      fakePort({
        ok: false,
        code: 'ai_timeout',
        message: '模型超时',
        capability: 'suggest_tags',
        promptVersion: 'p1-suggest-tags-v1',
        retryable: true,
      }),
    )
    const failed = await h.call(
      'POST',
      `/projects/${h.projectId}/question-versions/${h.versions.alpha}/tag-suggestions`,
      { key: 'tags-timeout', body: {} },
    )
    assert.equal(failed.status, 503)
    assert.equal(failed.body.error.code, 'dependency_unavailable')
    assert.equal(failed.body.error.message, '模型调用失败：ai_timeout')
    assert.deepEqual(failed.body.error.details, { ai_error: 'ai_timeout' })
    assert.equal(findRows(h.db, 'knowledge_tag_suggestion', {}).length, 0)
    // No run row and no suggestion: a failed call produces no candidate and no claim of one.
    assert.equal(findRows(h.db, 'audit_llm_run', {}).length, 0)
  } finally {
    h.close()
  }
})
