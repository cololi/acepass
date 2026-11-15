import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../src/domain/decimal.ts'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { cycleAnalysis } from '../src/services/cycles.ts'

const NOW = parseInstant('2026-07-01T00:00:00+00:00')

/** Every NOT NULL column the test does not set gets a value the schema accepts. */
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
    row[column.name] = column.json ? {} : column.kind === 'datetime' ? NOW : column.kind === 'int' || column.kind === 'bool' ? 0 : ''
  }
  Object.assign(row, overrides)
  return row
}

interface Store {
  db: DatabaseSync
  close(): void
  subjectId: string
}

function emptyStore(): Store {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'cycles@example.com', date_joined: NOW }),
    { now: NOW },
  )
  const project = createProject(db, String(user.id), { name: '考研' }, NOW)
  const subject = createSubject(db, String(user.id), String(project.id), { name: '数学' }, NOW)
  return { db, close: handle.close, subjectId: String(subject.id) }
}

function addSyllabus(store: Store, name: string, status = 'published'): string {
  const row = insertRow(
    store.db,
    'exams_syllabus_version',
    completeRow('exams_syllabus_version', {
      subject_id: store.subjectId,
      name,
      version_label: 'v1',
      status,
      review_status: status === 'published' ? 'approved' : 'draft',
    }),
    { now: NOW },
  )
  return String(row.id)
}

interface NodeSpec {
  displayOrder?: number
  parentId?: string | null
  isUnclassified?: boolean
}

function addNode(store: Store, syllabusId: string, name: string, spec: NodeSpec = {}): string {
  const row = insertRow(
    store.db,
    'knowledge_node',
    completeRow('knowledge_node', {
      syllabus_version_id: syllabusId,
      parent_id: spec.parentId ?? null,
      canonical_name: name,
      code: name,
      is_unclassified: spec.isUnclassified ?? false,
      display_order: spec.displayOrder ?? 0,
    }),
    { now: NOW },
  )
  return String(row.id)
}

interface MappingSpec {
  nodeId: string
  weight: string
  primary?: boolean
  revision?: number
}

/** One question version with its knowledge mappings, exactly as a publish would leave them. */
function addQuestion(store: Store, mappings: readonly MappingSpec[]): string {
  const question = insertRow(
    store.db,
    'question_bank_question',
    completeRow('question_bank_question', {
      subject_id: store.subjectId,
      origin_type: 'import',
      is_demo: false,
      display_label: '',
    }),
    { now: NOW },
  )
  const version = insertRow(
    store.db,
    'question_bank_question_version',
    completeRow('question_bank_question_version', {
      question_id: question.id,
      version: 1,
      question_type: 'single_choice',
    }),
    { now: NOW },
  )
  for (const mapping of mappings) {
    insertRow(
      store.db,
      'knowledge_question_mapping',
      completeRow('knowledge_question_mapping', {
        question_version_id: version.id,
        mapping_revision: mapping.revision ?? 1,
        node_id: mapping.nodeId,
        is_primary: mapping.primary ?? true,
        score_weight: mapping.weight,
        note: '',
      }),
      { now: NOW },
    )
  }
  return String(version.id)
}

interface ItemSpec {
  questionVersionId: string
  maxScore: string
  positionKey: string
  isScored?: boolean
}

interface PaperSpec {
  cycleKey: string
  paperCode: string
  sourceKind?: string
  isDemo?: boolean
  effective?: boolean
  revisionStatus?: string
  coverage?: { expected?: number | null; covered?: number | null; confirmedAt?: boolean }
  items?: readonly ItemSpec[]
}

/** One occurrence record with a revision, its items and (by default) that revision effective. */
function addPaper(store: Store, spec: PaperSpec): { paperId: string; revisionId: string } {
  const paper = insertRow(
    store.db,
    'exams_paper',
    completeRow('exams_paper', {
      subject_id: store.subjectId,
      cycle_key: spec.cycleKey,
      session_key: '',
      paper_code: spec.paperCode,
      title: '',
      source_kind: spec.sourceKind ?? 'official_past',
      is_demo: spec.isDemo ?? false,
      notes: '',
    }),
    { now: NOW },
  )
  const coverage = spec.coverage ?? {}
  const revision = insertRow(
    store.db,
    'exams_paper_revision',
    completeRow('exams_paper_revision', {
      paper_id: paper.id,
      revision: 1,
      expected_session_count: coverage.expected === undefined ? 1 : coverage.expected,
      covered_session_count: coverage.covered === undefined ? 1 : coverage.covered,
      coverage_confirmed_at: coverage.confirmedAt === false ? null : NOW,
      status: spec.revisionStatus ?? 'confirmed',
      note: '',
    }),
    { now: NOW },
  )
  for (const item of spec.items ?? []) {
    insertRow(
      store.db,
      'exams_paper_item',
      completeRow('exams_paper_item', {
        revision_id: revision.id,
        position_key: item.positionKey,
        question_version_id: item.questionVersionId,
        max_score: item.maxScore,
        is_scored: item.isScored ?? true,
        is_demo: false,
      }),
      { now: NOW },
    )
  }
  if (spec.effective !== false) {
    updateRow(store.db, 'exams_paper', paper.id, { effective_revision_id: revision.id }, { now: NOW })
  }
  return { paperId: String(paper.id), revisionId: String(revision.id) }
}

function rowsOf(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return payload[key] as Record<string, unknown>[]
}

/** The exact sum of a string column, so "the shares add up" is checked with decimals, not floats. */
function sumField(rows: readonly Record<string, unknown>[], field: string): Decimal {
  let total = Decimal.zero()
  for (const row of rows) total = total.add(Decimal.parse(String(row[field])))
  return total
}

test('cycles: a complete cycle splits a question by its primary weight and states its denominator', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '2025 大纲')
    const algebra = addNode(s, syllabus, '代数', { displayOrder: 1 })
    const geometry = addNode(s, syllabus, '几何', { displayOrder: 2 })
    const q1 = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    const q2 = addQuestion(s, [
      { nodeId: algebra, weight: '0.6000' },
      { nodeId: geometry, weight: '0.4000' },
    ])
    const q3 = addQuestion(s, [{ nodeId: geometry, weight: '1.0000' }])
    addPaper(s, {
      cycleKey: '2025',
      paperCode: '卷一',
      items: [
        { questionVersionId: q1, maxScore: '10.00', positionKey: '1' },
        { questionVersionId: q2, maxScore: '20.00', positionKey: '2' },
      ],
    })
    addPaper(s, {
      cycleKey: '2025',
      paperCode: '卷二',
      items: [{ questionVersionId: q3, maxScore: '10.00', positionKey: '1' }],
    })

    const payload = cycleAnalysis(s.db, s.subjectId)
    assert.equal(payload['subject_id'], s.subjectId)
    assert.equal(payload['complete_cycle_count'], 1)
    assert.equal(payload['used_cycle_count'], 1)
    assert.deepEqual(payload['used_cycles'], ['2025'])

    const cycles = rowsOf(payload, 'cycles')
    assert.equal(cycles.length, 1)
    const cycle = cycles[0]
    assert.equal(cycle['cycle_key'], '2025')
    assert.equal(cycle['paper_count'], 2)
    assert.equal(cycle['scored_item_count'], 3)
    // The denominator is every scored mark of both papers: 10 + 20 + 10.
    assert.equal(cycle['denominator_total_score'], '40.000')
    assert.equal(cycle['share_total'], '1.0000')
    assert.deepEqual(rowsOf(cycle, 'nodes'), [
      {
        node_id: algebra,
        label: '代数',
        path: '代数',
        unclassified: false,
        // 10 (own) + 20 × 0.6 (the split question) = 22.
        score: '22.000',
        share: '0.5500',
      },
      {
        node_id: geometry,
        label: '几何',
        path: '几何',
        unclassified: false,
        // 20 × 0.4 + 10 = 18.
        score: '18.000',
        share: '0.4500',
      },
    ])
    // Exact arithmetic: the buckets add back up to the denominator and to `share_total`.
    assert.equal(sumField(rowsOf(cycle, 'nodes'), 'score').toString(), cycle['denominator_total_score'])
    assert.equal(sumField(rowsOf(cycle, 'nodes'), 'share').toString(), cycle['share_total'])

    assert.deepEqual(rowsOf(payload, 'nodes'), [
      {
        node_id: algebra,
        label: '代数',
        path: '代数',
        unclassified: false,
        cycle_count: 1,
        average_share: '0.5500',
        average_score: '22.000',
      },
      {
        node_id: geometry,
        label: '几何',
        path: '几何',
        unclassified: false,
        cycle_count: 1,
        average_share: '0.4500',
        average_score: '18.000',
      },
    ])
  } finally {
    s.close()
  }
})

test('cycles: an incomplete cycle is named with exact reasons and never averaged in', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '大纲')
    const algebra = addNode(s, syllabus, '代数')
    const q = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    // The one complete cycle: 10 marks. It must stay the only number in the payload.
    addPaper(s, {
      cycleKey: '2025',
      paperCode: '卷一',
      items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1' }],
    })
    const demo = addPaper(s, {
      cycleKey: '2023',
      paperCode: '卷一',
      isDemo: true,
      items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1' }],
    })
    const draft = addPaper(s, {
      cycleKey: '2023',
      paperCode: '卷二',
      revisionStatus: 'draft',
      items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1' }],
    })

    const payload = cycleAnalysis(s.db, s.subjectId)
    assert.equal(payload['complete_cycle_count'], 1)
    assert.deepEqual(payload['used_cycles'], ['2025'])
    assert.equal(rowsOf(payload, 'cycles').length, 1)
    assert.equal(rowsOf(payload, 'cycles')[0]['denominator_total_score'], '10.000', 'the 2023 marks stay out')

    const incomplete = rowsOf(payload, 'incomplete_cycles')
    assert.equal(incomplete.length, 1)
    assert.equal(incomplete[0]['cycle_key'], '2023')
    assert.equal(incomplete[0]['paper_count'], 2)
    assert.deepEqual(incomplete[0]['blocking_reasons'], [
      { paper_id: demo.paperId, reason: 'demo_or_mock' },
      { paper_id: draft.paperId, reason: 'revision_not_confirmed' },
    ])
    const papers = incomplete[0]['papers'] as Record<string, unknown>[]
    assert.deepEqual(
      papers.map((paper) => [paper['paper_id'], paper['countable'], paper['reason']]),
      [
        [demo.paperId, false, 'demo_or_mock'],
        [draft.paperId, false, 'revision_not_confirmed'],
      ],
    )
    // Coverage is reported independently of the verdict: both revisions really are covered.
    assert.deepEqual(
      papers.map((paper) => paper['coverage_status']),
      ['coverage_complete', 'coverage_complete'],
    )
    assert.deepEqual(
      papers.map((paper) => [paper['expected_session_count'], paper['covered_session_count']]),
      [
        [1, 1],
        [1, 1],
      ],
    )
  } finally {
    s.close()
  }
})

test('cycles: every reason a paper cannot be counted has its own code', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '大纲')
    const algebra = addNode(s, syllabus, '代数')
    const q = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    addPaper(s, { cycleKey: '2022', paperCode: '无版本', effective: false, items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1' }] })
    addPaper(s, {
      cycleKey: '2022',
      paperCode: '覆盖不全',
      coverage: { expected: 2, covered: 1 },
      items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1' }],
    })
    addPaper(s, {
      cycleKey: '2022',
      paperCode: '未确认覆盖',
      coverage: { confirmedAt: false },
      items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1' }],
    })
    addPaper(s, {
      cycleKey: '2022',
      paperCode: '没有计分题',
      items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1', isScored: false }],
    })
    addPaper(s, { cycleKey: '2022', paperCode: '模拟卷', sourceKind: 'mock', isDemo: false, items: [] })

    const payload = cycleAnalysis(s.db, s.subjectId)
    assert.equal(rowsOf(payload, 'cycles').length, 0, 'nothing here is countable')
    assert.equal(payload['complete_cycle_count'], 0)
    assert.deepEqual(payload['used_cycles'], [])
    assert.equal(payload['missing_complete_cycles'], 5)
    const reasons = (rowsOf(payload, 'incomplete_cycles')[0]['blocking_reasons'] as Record<string, unknown>[]).map(
      (row) => row['reason'],
    )
    assert.deepEqual(reasons, [
      'no_effective_revision',
      'coverage_incomplete',
      'coverage_incomplete',
      'no_scored_items',
      'source_kind=mock',
    ])
    assert.deepEqual(payload['nodes'], [], 'no cycle was counted, so no node has a share')
    // A paper with no effective revision reports "unknown" coverage, not "incomplete" coverage.
    const papers = rowsOf(payload, 'incomplete_cycles')[0]['papers'] as Record<string, unknown>[]
    assert.deepEqual(
      papers.map((paper) => paper['coverage_status']),
      ['coverage_unknown', 'coverage_incomplete', 'coverage_incomplete', 'coverage_complete', 'coverage_complete'],
    )
    assert.deepEqual(
      papers.map((paper) => [paper['expected_session_count'], paper['covered_session_count']]),
      [
        [null, null],
        [2, 1],
        [1, 1],
        [1, 1],
        [1, 1],
      ],
    )
  } finally {
    s.close()
  }
})

test('cycles: fewer complete cycles than the horizon is insufficient_cycles, with a note', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '大纲')
    const algebra = addNode(s, syllabus, '代数')
    const geometry = addNode(s, syllabus, '几何')
    const q1 = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    const q2 = addQuestion(s, [
      { nodeId: algebra, weight: '0.6000' },
      { nodeId: geometry, weight: '0.4000' },
    ])
    const q3 = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    addPaper(s, {
      cycleKey: '2025',
      paperCode: '卷一',
      items: [
        { questionVersionId: q1, maxScore: '10.00', positionKey: '1' },
        { questionVersionId: q2, maxScore: '20.00', positionKey: '2' },
      ],
    })
    addPaper(s, {
      cycleKey: '2024',
      paperCode: '卷一',
      items: [{ questionVersionId: q3, maxScore: '10.00', positionKey: '1' }],
    })

    const payload = cycleAnalysis(s.db, s.subjectId)
    assert.equal(payload['status'], 'insufficient_cycles')
    assert.equal(payload['cycle_horizon'], 5)
    assert.equal(payload['complete_cycle_count'], 2)
    assert.equal(payload['used_cycle_count'], 2)
    assert.equal(payload['missing_complete_cycles'], 3)
    assert.deepEqual(payload['used_cycles'], ['2025', '2024'])
    assert.deepEqual(payload['notes'], [
      '只统计真实考试发生记录（source_kind=official_past 且非演示数据）；演示、模拟与练习集不计入任何分子或分母。',
      '完整周期 = 该周期全部已登记试卷都有“已确认且人工标记覆盖完整”的有效版本。',
      '分值权重按题目版本的主要考点权重计入一次；辅助标签权重为 0；无映射的计分题进入“未分类”。',
      '目前只有 2 个完整周期，不足 5 个：不给出“近五年”结论，未完整周期 0 个，原因见 incomplete_cycles。',
    ])

    // The averages divide by the cycles that *had* a share: 几何 only appears in one of the two.
    assert.deepEqual(rowsOf(payload, 'nodes'), [
      {
        node_id: algebra,
        label: '代数',
        path: '代数',
        unclassified: false,
        cycle_count: 2,
        // (22/30 + 10/10) / 2 = 0.86665 -> 0.8666 (ROUND_HALF_EVEN)
        average_share: '0.8666',
        average_score: '16.000',
      },
      {
        node_id: geometry,
        label: '几何',
        path: '几何',
        unclassified: false,
        cycle_count: 1,
        average_share: '0.2667',
        average_score: '8.000',
      },
    ])

    // A horizon the data does meet is `ok`, and the shortfall note disappears.
    const full = cycleAnalysis(s.db, s.subjectId, { maxCycles: 2 })
    assert.equal(full['status'], 'ok')
    assert.equal(full['cycle_horizon'], 2)
    assert.equal(full['missing_complete_cycles'], 0)
    assert.equal((full['notes'] as string[]).length, 3)
  } finally {
    s.close()
  }
})

test('cycles: a scored item with no mapping lands in 未分类 and still counts in the denominator', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '大纲')
    const algebra = addNode(s, syllabus, '代数')
    const mapped = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    const unmapped = addQuestion(s, [])
    addPaper(s, {
      cycleKey: '2025',
      paperCode: '卷一',
      items: [
        { questionVersionId: mapped, maxScore: '10.00', positionKey: '1' },
        { questionVersionId: unmapped, maxScore: '5.00', positionKey: '2' },
      ],
    })

    const payload = cycleAnalysis(s.db, s.subjectId)
    const cycle = rowsOf(payload, 'cycles')[0]
    assert.equal(cycle['denominator_total_score'], '15.000', 'the unmapped marks are in the denominator')
    assert.equal(cycle['share_total'], '1.0000')
    assert.deepEqual(rowsOf(cycle, 'nodes'), [
      {
        node_id: algebra,
        label: '代数',
        path: '代数',
        unclassified: false,
        score: '10.000',
        share: '0.6667',
      },
      {
        node_id: null,
        label: '未分类',
        path: '未分类',
        unclassified: true,
        score: '5.000',
        share: '0.3333',
      },
    ])
    assert.deepEqual(
      rowsOf(payload, 'nodes').map((node) => [node['node_id'], node['label'], node['unclassified']]),
      [
        [algebra, '代数', false],
        [null, '未分类', true],
      ],
    )
  } finally {
    s.close()
  }
})

test('cycles: coverage_gaps lists published nodes no counted cycle examined', () => {
  const s = emptyStore()
  try {
    const published = addSyllabus(s, '已发布大纲')
    const algebra = addNode(s, published, '代数', { displayOrder: 1 })
    const geometry = addNode(s, published, '几何', { displayOrder: 2 })
    const catchAll = addNode(s, published, '未分类根', { displayOrder: 3, isUnclassified: true })
    const never = addNode(s, published, '未考', { displayOrder: 4 })
    const chapter = addNode(s, published, '函数', { displayOrder: 5 })
    const leaf = addNode(s, published, '极限', { displayOrder: 6, parentId: chapter })
    const draftSyllabus = addSyllabus(s, '草稿大纲', 'draft')
    const draftNode = addNode(s, draftSyllabus, '草稿考点', { displayOrder: 1 })

    const q1 = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    const q2 = addQuestion(s, [{ nodeId: geometry, weight: '1.0000' }])
    addPaper(s, {
      cycleKey: '2025',
      paperCode: '卷一',
      items: [
        { questionVersionId: q1, maxScore: '10.00', positionKey: '1' },
        { questionVersionId: q2, maxScore: '10.00', positionKey: '2' },
      ],
    })

    const payload = cycleAnalysis(s.db, s.subjectId)
    const gaps = rowsOf(payload, 'coverage_gaps')
    assert.deepEqual(
      gaps.map((gap) => [gap['node_id'], gap['label'], gap['path']]),
      [
        [never, '未考', '未考'],
        [chapter, '函数', '函数'],
        [leaf, '极限', '函数 / 极限'],
      ],
    )
    assert.deepEqual(
      gaps.map((gap) => gap['reason']),
      ['never_examined_in_counted_cycles', 'never_examined_in_counted_cycles', 'never_examined_in_counted_cycles'],
    )
    const listed = new Set(gaps.map((gap) => gap['node_id']))
    assert.equal(listed.has(algebra), false, 'an examined node is not a gap')
    assert.equal(listed.has(catchAll), false, 'the catch-all bucket is not a syllabus point')
    assert.equal(listed.has(geometry), false)
    assert.equal(listed.has(draftNode), false, 'only a published syllabus is a baseline')
  } finally {
    s.close()
  }
})

test('cycles: cycles sort by leading year descending and a non-year key sorts as 0', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '大纲')
    const algebra = addNode(s, syllabus, '代数')
    const q = addQuestion(s, [{ nodeId: algebra, weight: '1.0000' }])
    for (const cycleKey of ['2024', 'demo', '2025', '2024春']) {
      addPaper(s, {
        cycleKey,
        paperCode: '卷一',
        items: [{ questionVersionId: q, maxScore: '10.00', positionKey: '1' }],
      })
    }

    const payload = cycleAnalysis(s.db, s.subjectId)
    assert.equal(payload['complete_cycle_count'], 4)
    assert.deepEqual(payload['used_cycles'], ['2025', '2024春', '2024', 'demo'])
    assert.deepEqual(
      rowsOf(payload, 'cycles').map((cycle) => cycle['cycle_key']),
      ['2025', '2024春', '2024', 'demo'],
    )
    assert.deepEqual(cycleAnalysis(s.db, s.subjectId, { maxCycles: 2 })['used_cycles'], ['2025', '2024春'])
  } finally {
    s.close()
  }
})

test('cycles: share_total is the exact sum, not the sum of the rounded shares', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '大纲')
    const items: ItemSpec[] = []
    for (const [index, name] of ['甲', '乙', '丙'].entries()) {
      const node = addNode(s, syllabus, name, { displayOrder: index + 1 })
      const question = addQuestion(s, [{ nodeId: node, weight: '1.0000' }])
      items.push({ questionVersionId: question, maxScore: '10.00', positionKey: String(index + 1) })
    }
    addPaper(s, { cycleKey: '2025', paperCode: '卷一', items })

    const payload = cycleAnalysis(s.db, s.subjectId)
    const cycle = rowsOf(payload, 'cycles')[0]
    assert.equal(cycle['denominator_total_score'], '30.000')
    assert.deepEqual(
      rowsOf(cycle, 'nodes').map((node) => [node['label'], node['score'], node['share']]),
      [
        ['甲', '10.000', '0.3333'],
        ['乙', '10.000', '0.3333'],
        ['丙', '10.000', '0.3333'],
      ],
    )
    // Three thirds: the reported rows add up to 0.9999, but the true total is exactly 1.
    assert.equal(sumField(rowsOf(cycle, 'nodes'), 'share').toString(), '0.9999')
    assert.equal(cycle['share_total'], '1.0000')
  } finally {
    s.close()
  }
})

test('cycles: only the newest mapping revision counts, and an auxiliary tag carries no weight', () => {
  const s = emptyStore()
  try {
    const syllabus = addSyllabus(s, '大纲')
    const algebra = addNode(s, syllabus, '代数')
    const geometry = addNode(s, syllabus, '几何')
    const tag = addNode(s, syllabus, '辅助标签')
    const question = addQuestion(s, [
      // A retired batch that would hand the whole question to 代数.
      { nodeId: algebra, weight: '1.0000', revision: 1 },
      { nodeId: algebra, weight: '0.4000', revision: 2 },
      { nodeId: geometry, weight: '0.6000', revision: 2 },
      // An auxiliary tag is not a weight; counting it would make share_total exceed 1.
      { nodeId: tag, weight: '0.0000', revision: 2, primary: false },
    ])
    addPaper(s, {
      cycleKey: '2025',
      paperCode: '卷一',
      items: [{ questionVersionId: question, maxScore: '20.00', positionKey: '1' }],
    })

    const payload = cycleAnalysis(s.db, s.subjectId)
    const cycle = rowsOf(payload, 'cycles')[0]
    assert.equal(cycle['denominator_total_score'], '20.000')
    assert.deepEqual(rowsOf(cycle, 'nodes'), [
      {
        node_id: geometry,
        label: '几何',
        path: '几何',
        unclassified: false,
        score: '12.000',
        share: '0.6000',
      },
      {
        node_id: algebra,
        label: '代数',
        path: '代数',
        unclassified: false,
        score: '8.000',
        share: '0.4000',
      },
    ])
    assert.equal(cycle['share_total'], '1.0000')
    assert.equal(
      rowsOf(payload, 'nodes').some((node) => node['label'] === '辅助标签'),
      false,
      'a zero-weight tag never becomes a bucket',
    )
  } finally {
    s.close()
  }
})
