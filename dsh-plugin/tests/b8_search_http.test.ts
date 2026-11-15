/**
 * HTTP black box for B8's retrieval: the keyword channel, the honest "no vector" state, project
 * isolation and the idempotent reindex.
 *
 * The acceptance case this backs (`frontend/tests/dsh/p1-batch2.spec.ts:97`) needs three things at
 * once: the fixture's judgement question is actually *found* by the query, the page can say the
 * vector channel is not configured, and the same query in another project returns none of project A's
 * content. The last one is tested with **identical stems in both projects**, so the assertion proves
 * the project scope rather than "project B happens to have no documents".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { countRows, findRows, insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createFetchHandler } from '../src/http/router.ts'
import { acepassRoutes } from '../src/http/routes.ts'
import {
  createProject,
  createSpecVersion,
  createSubject,
  createSyllabusVersion,
  publishSpecVersion,
  publishSyllabusVersion,
} from '../src/services/exams.ts'
import { createNode } from '../src/services/knowledge.ts'
import {
  createAnswerKeyVersion,
  createQuestion,
  createQuestionVersionDraft,
  publishQuestionVersion,
} from '../src/services/questions.ts'
import { replaceKnowledgeMappings } from '../src/services/mappings.ts'
import { sealQuestion } from '../src/services/sealing.ts'
import { tokenize, termFrequencies, bm25Scores, excerpt, type SearchDocument } from '../src/services/search.ts'
import { compareCodePoints } from '../src/services/cycles.ts'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-08-01T00:00:00+00:00')
const BASE = 'http://host/api/acepass'

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

function harness() {
  const handle = openStore({ path: ':memory:' })
  const db: DatabaseSync = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'search@example.com', display_name: '检索', date_joined: NOW }),
    { now: NOW },
  )
  let now: Instant = NOW
  const handler = createFetchHandler({
    db,
    routes: acepassRoutes(),
    actor: () => ({ userId: String(user.id), now }),
  })
  let counter = 0
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; key?: string | null } = {},
  ): Promise<{ status: number; text: string; body: any }> => {
    counter += 1
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (method !== 'GET') {
      const key = options.key === undefined ? `s-${counter}` : options.key
      if (key !== null) headers['idempotency-key'] = key
    }
    const response = await handler(
      new Request(`${BASE}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    )
    const text = await response.text()
    return { status: response.status, text, body: text === '' ? null : JSON.parse(text) }
  }
  return { db, user: String(user.id), close: handle.close, call, setNow: (v: Instant) => { now = v } }
}

interface Seeded {
  projectId: string
  subjectId: string
  nodeId: string
  questionId: string
  versionId: string
}

function seedProject(
  db: DatabaseSync,
  userId: string,
  options: { projectName: string; nodeName: string; stem: string; now: Instant },
): Seeded {
  const { now } = options
  const project = createProject(db, userId, { name: options.projectName }, now)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: '科目', total_score: '100', pass_score: '60' }, now)
  const subjectId = String(subject.id)
  const spec = createSpecVersion(
    db,
    userId,
    projectId,
    {
      subject_id: subjectId,
      name: '规范',
      total_score: '100',
      pass_score: '60',
      question_type_rules: { true_false: { max_score: '2', correct_score: '2', wrong_score: '0' } },
    },
    now,
  )
  publishSpecVersion(db, userId, projectId, String(spec.id), now)
  const syllabus = createSyllabusVersion(
    db,
    userId,
    projectId,
    { subject_id: subjectId, name: '大纲', version_label: '2026' },
    now,
  )
  publishSyllabusVersion(db, userId, projectId, String(syllabus.id), now)
  const node = createNode(
    db,
    userId,
    projectId,
    { syllabus_version_id: String(syllabus.id), canonical_name: options.nodeName, kind: 'point', display_order: 0 },
    now,
  )
  const question = createQuestion(db, userId, { subjectId, displayLabel: '判断-1' }, now)
  const questionId = String(question.id)
  const version = createQuestionVersionDraft(
    db,
    userId,
    projectId,
    questionId,
    {
      questionType: 'true_false',
      content: { blocks: [{ kind: 'text', text: options.stem }] },
      practiceMaxScore: '2',
      revisionReason: 'b8-search',
    },
    now,
  )
  const versionId = String(version.id)
  createAnswerKeyVersion(
    db,
    userId,
    projectId,
    versionId,
    {
      answerPayload: { kind: 'true_false', value: true },
      sourceType: 'user',
      verificationStatus: 'checked',
      checkBasis: 'b8 search 测试',
    },
    now,
  )
  replaceKnowledgeMappings(db, projectId, versionId, [{ node_id: String(node.id), is_primary: true, score_weight: '1' }], {
    actorId: userId,
    now,
  })
  publishQuestionVersion(db, userId, projectId, versionId, { now })
  return { projectId, subjectId, nodeId: String(node.id), questionId, versionId }
}

test('search: the keyword channel finds the stem and reports the missing vector channel', async () => {
  const h = harness()
  try {
    const seed = seedProject(h.db, h.user, {
      projectName: '检索项目A',
      nodeName: '三角形考点',
      stem: '验收判断：三角形内角和为 180 度。',
      now: NOW,
    })

    const reindexed = await h.call('POST', `/projects/${seed.projectId}/search/reindex`, {
      body: { subject_id: seed.subjectId },
    })
    assert.equal(reindexed.status, 200)
    for (const field of [
      'project_id',
      'subject_id',
      'indexed',
      'excluded',
      'embeddings',
      'embedding_unavailable_reason',
      'embedding_model',
      'documents_total',
      'documents_in_index',
      'tokenizer_version',
    ]) {
      assert.ok(field in reindexed.body, `reindex.${field} must exist`)
    }
    assert.equal(reindexed.body.indexed, 2, 'one published question + one node')
    assert.equal(reindexed.body.excluded, 0)
    assert.equal(reindexed.body.documents_total, 2)
    assert.equal(reindexed.body.documents_in_index, 2)
    // No embedding provider exists here: zero vectors and a reason, never a fabricated one.
    assert.equal(reindexed.body.embeddings, 0)
    assert.equal(reindexed.body.embedding_model, null)
    assert.match(reindexed.body.embedding_unavailable_reason, /未配置向量化模型/)
    assert.equal(reindexed.body.tokenizer_version, 'zh-char-ngram-v1')

    // The probe request the page sends before any query: 200 with an explicit empty state.
    const probe = await h.call('GET', `/projects/${seed.projectId}/search?q=&limit=10&channel=hybrid`)
    assert.equal(probe.status, 200)
    assert.deepEqual(probe.body.results, [])
    assert.deepEqual(probe.body.query_tokens, [])
    assert.equal(probe.body.notes[0], '查询为空或只包含标点，未产生检索词，因此没有结果。')
    // The hybrid probe also reports the vector channel before any query, which is the point of it.
    assert.ok(probe.body.notes.some((note: string) => note.startsWith('向量通道不可用，未参与排序：')))
    assert.equal(probe.body.channels.keyword.reason, '查询为空或只包含标点，未产生检索词')

    const searched = await h.call(
      'GET',
      `/projects/${seed.projectId}/search?q=${encodeURIComponent('三角形内角和')}&limit=10&channel=hybrid`,
    )
    assert.equal(searched.status, 200)
    assert.equal(searched.body.query, '三角形内角和')
    assert.ok(searched.body.query_tokens.includes('三角'))
    assert.ok(searched.body.query_tokens.includes('角和'))
    assert.equal(searched.body.candidate_documents, 2)
    assert.equal(searched.body.limit, 10)
    assert.deepEqual(searched.body.fusion, { method: 'rrf', k: 60 })
    assert.equal(searched.body.channels.keyword.available, true)
    assert.equal(searched.body.channels.keyword.used, true)
    // The vector channel is reported as unusable, with a machine-readable code and a reason.
    assert.equal(searched.body.channels.vector.available, false)
    assert.equal(searched.body.channels.vector.code, 'vector_not_configured')
    assert.equal(searched.body.channels.vector.used, false)
    assert.match(searched.body.channels.vector.reason, /未配置向量化模型/)
    assert.equal(searched.body.channels.vector.is_stub, false)
    assert.ok(
      searched.body.notes.some((note: string) => note.startsWith('向量通道不可用，未参与排序：')),
      `notes must explain the degradation: ${JSON.stringify(searched.body.notes)}`,
    )

    const top = searched.body.results[0]
    for (const field of [
      'document_id',
      'kind',
      'question_id',
      'question_version_id',
      'knowledge_node_id',
      'subject_id',
      'display_label',
      'excerpt',
      'keyword_score',
      'keyword_rank',
      'vector_score',
      'vector_rank',
      'fused_score',
      'channels',
      'matched_terms',
    ]) {
      assert.ok(field in top, `result.${field} must exist`)
    }
    // The page prints 「关键词：第 1 名」 from exactly this field.
    assert.equal(top.keyword_rank, 1)
    assert.equal(top.kind, 'question')
    assert.equal(top.question_id, seed.questionId)
    assert.equal(top.display_label, '判断-1')
    assert.match(top.excerpt, /三角形内角和/)
    assert.deepEqual(top.channels, ['keyword'])
    assert.equal(top.vector_score, null)
    assert.equal(top.vector_rank, null)
    assert.ok(top.keyword_score > 0)
    assert.ok(top.matched_terms.includes('三角'))
    // `matched_terms` is the query terms the document actually contains, in code-point order.
    assert.deepEqual(
      top.matched_terms,
      [...top.matched_terms].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)),
    )

    // Keyword-only and vector-only requests keep their documented shapes.
    const keywordOnly = await h.call(
      'GET',
      `/projects/${seed.projectId}/search?q=${encodeURIComponent('三角形内角和')}&channel=keyword`,
    )
    assert.equal(keywordOnly.status, 200)
    assert.equal(keywordOnly.body.fusion, null)
    assert.ok(keywordOnly.body.results.length >= 1)

    const vectorOnly = await h.call(
      'GET',
      `/projects/${seed.projectId}/search?q=${encodeURIComponent('三角形内角和')}&channel=vector`,
    )
    assert.equal(vectorOnly.status, 200)
    assert.deepEqual(vectorOnly.body.results, [])
    assert.equal(vectorOnly.body.channels.vector.requested, true)
    assert.equal(vectorOnly.body.channels.vector.used, false)
    assert.ok(vectorOnly.body.notes.some((note: string) => note.startsWith('已请求仅向量通道')))

    const badChannel = await h.call('GET', `/projects/${seed.projectId}/search?q=x&channel=fuzzy`)
    assert.equal(badChannel.status, 400)
    assert.equal(badChannel.body.error.message, '检索通道无效')
    assert.deepEqual(badChannel.body.error.details.allowed, ['keyword', 'vector', 'hybrid'])

    const badLimit = await h.call('GET', `/projects/${seed.projectId}/search?q=x&limit=51`)
    assert.equal(badLimit.status, 400)
    const one = await h.call(
      'GET',
      `/projects/${seed.projectId}/search?q=${encodeURIComponent('三角形内角和')}&limit=1`,
    )
    assert.equal(one.body.results.length, 1)
    assert.equal(one.body.limit, 1)

    const unknownProject = await h.call('GET', '/projects/missing/search?q=x')
    assert.equal(unknownProject.status, 404)
  } finally {
    h.close()
  }
})

test('search: another project with identical stems returns only its own documents', async () => {
  const h = harness()
  try {
    const projectA = seedProject(h.db, h.user, {
      projectName: '验收项目A',
      nodeName: '三角形考点',
      stem: '验收判断：三角形内角和为 180 度。',
      now: NOW,
    })
    const projectB = seedProject(h.db, h.user, {
      projectName: '验收项目B',
      nodeName: '专业考点',
      stem: '验收判断：三角形内角和为 180 度。',
      now: NOW,
    })
    assert.equal(
      (await h.call('POST', `/projects/${projectA.projectId}/search/reindex`, { body: {} })).status,
      200,
    )
    assert.equal(
      (await h.call('POST', `/projects/${projectB.projectId}/search/reindex`, { body: {} })).status,
      200,
    )

    const inA = await h.call(
      'GET',
      `/projects/${projectA.projectId}/search?q=${encodeURIComponent('三角形内角和')}`,
    )
    assert.equal(inA.status, 200)
    assert.ok(inA.body.results.length >= 1)
    for (const row of inA.body.results) {
      assert.equal(row.subject_id, projectA.subjectId)
      assert.notEqual(row.question_id, projectB.questionId)
    }

    const inB = await h.call(
      'GET',
      `/projects/${projectB.projectId}/search?q=${encodeURIComponent('三角形内角和')}`,
    )
    assert.equal(inB.status, 200)
    assert.ok(inB.body.results.length >= 1, 'project B has the same text, so it must find *its* copy')
    const serialised = JSON.stringify(inB.body.results)
    assert.ok(!serialised.includes(projectA.questionId), 'project A question id must never leak')
    assert.ok(!serialised.includes(projectA.nodeId), 'project A node id must never leak')
    for (const row of inB.body.results) {
      assert.equal(row.subject_id, projectB.subjectId)
    }

    // A subject from another project is a 404 rather than a silently unscoped search.
    const crossSubject = await h.call(
      'GET',
      `/projects/${projectA.projectId}/search?q=x&subject_id=${projectB.subjectId}`,
    )
    assert.equal(crossSubject.status, 404)

    // Scoping by the project's own subject still finds the question.
    const scoped = await h.call(
      'GET',
      `/projects/${projectA.projectId}/search?q=${encodeURIComponent('三角形内角和')}&subject_id=${projectA.subjectId}`,
    )
    assert.equal(scoped.status, 200)
    assert.equal(scoped.body.subject_id, projectA.subjectId)
    assert.ok(scoped.body.results.length >= 1)
  } finally {
    h.close()
  }
})

test('search reindex: idempotent per key, and sealed content is excluded from the index', async () => {
  const h = harness()
  try {
    const seed = seedProject(h.db, h.user, {
      projectName: '重排项目',
      nodeName: '封存考点',
      stem: '验收判断：会被封存的题干。',
      now: NOW,
    })

    const first = await h.call('POST', `/projects/${seed.projectId}/search/reindex`, {
      body: { subject_id: seed.subjectId },
      key: 'reindex-1',
    })
    assert.equal(first.status, 200)
    const replay = await h.call('POST', `/projects/${seed.projectId}/search/reindex`, {
      body: { subject_id: seed.subjectId },
      key: 'reindex-1',
    })
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.body, first.body)
    assert.equal(countRows(h.db, 'search_document', { project_id: seed.projectId }), 2, 'no duplicate rows')

    const keyless = await h.call('POST', `/projects/${seed.projectId}/search/reindex`, {
      body: {},
      key: null,
    })
    assert.equal(keyless.status, 409)
    assert.equal(keyless.body.error.code, 'idempotency_conflict')

    // A different subject under the same key is a payload conflict, not a second run.
    const otherSubject = await h.call('POST', `/projects/${seed.projectId}/search/reindex`, {
      body: {},
      key: 'reindex-1',
    })
    assert.equal(otherSubject.status, 409)
    assert.equal(otherSubject.body.error.code, 'idempotency_conflict')

    // Sealing removes the question from both the index run and the live retrieval gate.
    sealQuestion(h.db, {
      projectId: seed.projectId,
      questionId: seed.questionId,
      actorId: h.user,
      reason: '考前封存',
      now: NOW,
    })
    const sealedSearch = await h.call(
      'GET',
      `/projects/${seed.projectId}/search?q=${encodeURIComponent('三角形内角和')}`,
    )
    assert.equal(sealedSearch.status, 200)
    assert.ok(
      sealedSearch.body.results.every((row: any) => row.kind !== 'question'),
      'a sealed question must not be retrievable even before the index is rebuilt',
    )

    const reindexed = await h.call('POST', `/projects/${seed.projectId}/search/reindex`, { body: {} })
    assert.equal(reindexed.status, 200)
    assert.equal(reindexed.body.excluded, 1)
    assert.equal(reindexed.body.indexed, 1)
    const excludedRow = findRows(h.db, 'search_document', {
      project_id: seed.projectId,
      kind: 'question',
    })[0]
    assert.equal(excludedRow.is_searchable, false)
    assert.match(String(excludedRow.exclusion_reason), /封存/)
  } finally {
    h.close()
  }
})

test('tokenizer and BM25: the pure ranking layer round-trips CJK bigrams and latin runs', () => {
  // Deterministic by construction: token order is reading order, unigrams then that run's bigrams.
  assert.deepEqual(tokenize('三角形内角和'), [
    '三', '角', '形', '内', '角', '和',
    '三角', '角形', '形内', '内角', '角和',
  ])
  assert.deepEqual(tokenize('AB12 cathy 3.14 50%'), ['ab12', 'cathy', '3.14', '50%'])
  // NFKC folds full-width forms; punctuation only separates.
  assert.deepEqual(tokenize('ＡＢＣ１２，第 3 题'), ['abc12', '第', '3', '题'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(termFrequencies(['b', 'a', 'b']), { a: 1, b: 2 })

  const documents: SearchDocument[] = [
    {
      id: 'doc-a',
      kind: 'question',
      project_id: 'p',
      subject_id: 's',
      question_id: 'q-a',
      question_version_id: null,
      knowledge_node_id: null,
      text: '验收判断：三角形内角和为 180 度。',
      tokens: tokenize('验收判断：三角形内角和为 180 度。'),
      term_frequencies: termFrequencies(tokenize('验收判断：三角形内角和为 180 度。')),
      doc_length: tokenize('验收判断：三角形内角和为 180 度。').length,
      embedding: null,
      is_searchable: true,
    },
    {
      id: 'doc-b',
      kind: 'node',
      project_id: 'p',
      subject_id: 's',
      question_id: null,
      question_version_id: null,
      knowledge_node_id: 'n-b',
      text: '三角形考点',
      tokens: tokenize('三角形考点'),
      term_frequencies: termFrequencies(tokenize('三角形考点')),
      doc_length: tokenize('三角形考点').length,
      embedding: null,
      is_searchable: true,
    },
  ]
  const scores = bm25Scores(documents, tokenize('三角形内角和'))
  const ordered = [...scores.entries()].sort((left, right) => right[1] - left[1])
  assert.equal(ordered[0][0], 'doc-a', 'the stem with more matched terms must rank first')
  assert.equal(ordered.length, 2)
  // The excerpt is taken from the indexed text and keeps the matched phrase.
  assert.match(excerpt(documents[0].text, ['三角']), /三角形内角和/)
})

/** Real Django output (`scripts/gen_b8_learning_golden.py`), regenerated per release. */
const GOLDEN = JSON.parse(readFileSync(new URL('./golden/b8_learning.json', import.meta.url), 'utf8'))

function goldenDocument(entry: Record<string, any>): SearchDocument {
  return {
    id: entry.ref,
    kind: entry.kind,
    project_id: 'golden-project',
    subject_id: 'golden-subject',
    question_id: entry.kind === 'question' ? entry.ref : null,
    question_version_id: null,
    knowledge_node_id: entry.kind === 'node' ? entry.ref : null,
    text: entry.text,
    tokens: entry.tokens,
    term_frequencies: entry.term_frequencies,
    doc_length: entry.doc_length,
    embedding: null,
    is_searchable: true,
  }
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

test('golden vectors: tokenizer, BM25 ranking and excerpts match the real Django projection', () => {
  // 1. Tokenizer + term frequencies, over the corpus of real indexed strings.
  for (const entry of GOLDEN.tokenizer as Array<Record<string, any>>) {
    assert.deepEqual(tokenize(entry.text), entry.tokens, `tokens for ${JSON.stringify(entry.text)}`)
    assert.deepEqual(termFrequencies(entry.tokens), entry.term_frequencies)
  }

  // 2. BM25 over the stored index rows, ranked exactly like the wire reports it.
  const documents = (GOLDEN.search.corpus as Array<Record<string, any>>).map(goldenDocument)
  const byId = new Map(documents.map((document) => [document.id, document]))
  const scores = bm25Scores(documents, tokenize(GOLDEN.search.bm25_query))
  const ranked = [...scores.entries()]
    .sort((left, right) => (right[1] !== left[1] ? right[1] - left[1] : compareCodePoints(left[0], right[0])))
    .map(([id, score], index) => ({ ref: id, score: round6(score), rank: index + 1 }))
  assert.deepEqual(ranked, GOLDEN.search.bm25_ranked)

  // 3. Every recorded query: the same candidates, ranks, fused scores, excerpts and matched terms.
  for (const query of GOLDEN.search.queries as Array<Record<string, any>>) {
    const terms = [...new Set(tokenize(query.query))] as string[]
    assert.deepEqual(query.query_tokens, [...new Set(tokenize(query.query))], `query tokens for ${JSON.stringify(query.query)}`)
    const queryScores = bm25Scores(documents, terms)
    const order = [...queryScores.entries()]
      .sort((left, right) => (right[1] !== left[1] ? right[1] - left[1] : compareCodePoints(left[0], right[0])))
    assert.equal(query.candidate_documents, documents.length)
    assert.equal(query.keyword.hits, order.length)
    assert.equal(query.keyword.used, order.length > 0)
    assert.equal(query.results.length, order.length)
    order.forEach(([id], index) => {
      const expected = query.results[index]
      assert.equal(expected.ref, id, `rank ${index + 1} of ${JSON.stringify(query.query)}`)
      assert.equal(expected.keyword_rank, index + 1)
      const document = byId.get(id)!
      // Scores are compared at the precision the wire uses (6 decimals).
      assert.equal(expected.keyword_score, round6(queryScores.get(id)!))
      assert.equal(expected.fused_score, round6(1 / (60 + index + 1)))
      assert.equal(expected.excerpt, excerpt(document.text, terms))
      assert.deepEqual(
        expected.matched_terms,
        terms.filter((term) => document.term_frequencies[term]).sort(compareCodePoints),
      )
    })
    if (terms.length === 0) {
      assert.equal(query.keyword.reason, '查询为空或只包含标点，未产生检索词')
    } else {
      assert.equal(query.keyword.reason, null)
    }
  }

  // 4. Excerpt window arithmetic, including the truncation and the "no matched term" paths.
  for (const entry of GOLDEN.search.excerpt_cases as Array<Record<string, any>>) {
    assert.equal(excerpt(entry.text, entry.terms), entry.expected, `excerpt for ${JSON.stringify(entry.terms)}`)
  }
})
