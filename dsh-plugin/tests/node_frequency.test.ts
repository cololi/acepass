import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../src/domain/decimal.ts'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { nodeFrequency, subjectFrequency, planningValues } from '../src/services/node_frequency.ts'
import { ScopeViolation } from '../src/services/errors.ts'

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
  userId: string
  projectId: string
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
  return { db, close: handle.close, userId: String(user.id), projectId: String(project.id), subjectId: String(subject.id) }
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


test('frequency: exact shares, subtree uniqueness, exclusions and planning contract', () => {
  const s=emptyStore()
  try {
    const syllabus=addSyllabus(s,'大纲'), parent=addNode(s,syllabus,'章'), a=addNode(s,syllabus,'甲',{parentId:parent}), b=addNode(s,syllabus,'乙',{parentId:parent})
    const q=addQuestion(s,[{nodeId:a,weight:'0.25'},{nodeId:b,weight:'0.75'}]), unmapped=addQuestion(s,[])
    const items=[{questionVersionId:q,maxScore:'8',positionKey:'1'},{questionVersionId:unmapped,maxScore:'2',positionKey:'2'}]
    for(const cycleKey of ['2024','2025']) addPaper(s,{cycleKey,paperCode:cycleKey,items})
    const demo=addPaper(s,{cycleKey:'2026',paperCode:'demo',isDemo:true,items})
    addPaper(s,{cycleKey:'2026',paperCode:'real',items})
    const f=nodeFrequency(s.db,s.userId,s.projectId,a)
    assert.deepEqual(f.used_cycles,['2025','2024'])
    assert.equal(f.appearances,2);assert.equal(f.cycles_present,2);assert.equal(f.share_avg,'0.2000');assert.equal(f.marks_avg,'2.000')
    assert.equal(f.cycles[0].denominator,'10.000');assert.equal(f.status,'ok');assert.equal(f.value_index,'1.0000')
    assert.equal(f.excluded_papers[0].paper_id,demo.paperId)
    assert.deepEqual(f.question_types,{single_choice:2})
    const tree=nodeFrequency(s.db,s.userId,s.projectId,parent,{includeDescendants:true})
    assert.equal(tree.appearances,2);assert.equal(tree.marks_avg,'8.000');assert.equal(tree.share_avg,'0.8000')
    const subject=subjectFrequency(s.db,s.userId,s.projectId,s.subjectId)
    assert.deepEqual(subject.unclassified,{appearances:2,marks:'4.000'})
    assert.equal(subject.coverage_gaps[0].node_id,parent)
    assert.deepEqual(planningValues(s.db,s.userId,s.projectId,s.subjectId).get(a),{node_id:a,value_index:1,status:'ok',appearances:2,cycles_present:2,counted_cycles:2,last_seen_cycle:'2025'})
    const limited=nodeFrequency(s.db,s.userId,s.projectId,a,{horizon:1})
    assert.equal(limited.status,'insufficient_cycles');assert.equal(limited.value_index,null);assert.equal(limited.trend,null)
  } finally {s.close()}
})
test('frequency: no data and cross-project subject scope',()=>{
 const s=emptyStore()
 try {
  const n=addNode(s,addSyllabus(s,'空'),'点')
  assert.equal(planningValues(s.db,s.userId,s.projectId,s.subjectId).get(n)?.status,'no_real_data')
  assert.equal(planningValues(s.db,s.userId,s.projectId,s.subjectId).get(n)?.value_index,null)
  const project=createProject(s.db,s.userId,{name:'另一项目'},NOW)
  assert.throws(()=>nodeFrequency(s.db,s.userId,String(project.id),n),ScopeViolation)
  assert.throws(()=>nodeFrequency(s.db,'outsider',s.projectId,n),ScopeViolation)
 }finally{s.close()}
})
test('frequency: one incomplete real paper blocks its entire cycle without writes',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点'),q=addQuestion(s,[{nodeId:n,weight:'1'}])
 const items=[{questionVersionId:q,maxScore:'6',positionKey:'1'}]
 addPaper(s,{cycleKey:'2025',paperCode:'complete',items})
 addPaper(s,{cycleKey:'2025',paperCode:'incomplete',items,coverage:{expected:2,covered:1}})
 const before=s.db.prepare('SELECT total_changes() AS n').get()
 const f=nodeFrequency(s.db,s.userId,s.projectId,n)
 assert.equal(f.status,'no_real_data');assert.equal(f.appearances,0);assert.equal(f.excluded_papers.length,1)
 assert.deepEqual(f.used_cycles,[]);assert.equal(f.value_index,null)
 assert.deepEqual(s.db.prepare('SELECT total_changes() AS n').get(),before)
 }finally{s.close()}
})
