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
import { ScopeViolation,InvalidInput,IdempotencyConflictError } from '../src/services/errors.ts'

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


import {getOrCreateNodeMemory,recordRecall,nodeMemoryView,rebuildNodeMemory,memoryForNodes,dueNodeMemories,suspendNodeMemory,resumeNodeMemory} from '../src/services/node_memory.ts'
import {findOne,findRows} from '../src/store/repository.ts'
const later=(minutes:number)=>NOW+BigInt(minutes)*60000000n
const recall=(nodeId:string,key:string,rating='good')=>({nodeId,idempotencyKey:key,kind:'free_recall',rating,source:'self_report'})
test('memory: frequency retention is fixed on creation',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点'),q=addQuestion(s,[{nodeId:n,weight:'1'}])
 for(const cycleKey of ['2024','2025']) addPaper(s,{cycleKey,paperCode:cycleKey,items:[{questionVersionId:q,maxScore:'10',positionKey:'1'}]})
 const row=getOrCreateNodeMemory(s.db,s.userId,s.projectId,n,NOW)
 assert.equal(row.desired_retention,0.95)
 assert.equal(getOrCreateNodeMemory(s.db,s.userId,s.projectId,n,NOW,{desiredRetention:0.9}).desired_retention,0.95)
 }finally{s.close()}
})
test('memory: ledger, non-spaced audit, replay, early cap and projection rebuild',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点')
 const initial=getOrCreateNodeMemory(s.db,s.userId,s.projectId,n,NOW)
 assert.equal(initial.desired_retention,0.85)
 const protectedTables=TABLES.filter(t=>t.name.startsWith('practice_')||t.name==='learning_knowledge_state').map(t=>t.name)
 const counts=()=>protectedTables.map(t=>findRows(s.db,t).length)
 const before=counts()
 const first=recordRecall(s.db,s.userId,s.projectId,recall(n,'first','easy'),NOW)
 assert.equal(first.memory_updated,true);assert.equal(first.memory?.reps,1);assert.notEqual(first.due_at,first.reviewed_at)
 const projection=findOne(s.db,'memory_node_state',{id:initial.id})
 const repeat=recordRecall(s.db,s.userId,s.projectId,recall(n,'repeat'),later(5))
 assert.equal(repeat.memory_updated,false);assert.equal(repeat.rating,'hard');assert.equal(repeat.interval_days,0);assert.ok(repeat.notes.includes('not_spaced'))
 assert.deepEqual(findOne(s.db,'memory_node_state',{id:initial.id}),projection)
 assert.deepEqual(recordRecall(s.db,s.userId,s.projectId,recall(n,'repeat'),later(6)),repeat)
 assert.equal(findRows(s.db,'memory_recall_event').length,2)
 const early=recordRecall(s.db,s.userId,s.projectId,recall(n,'early','easy'),later(10))
 assert.equal(early.early_review,true);assert.equal(early.rating,'hard');assert.equal(early.memory_updated,true)
 assert.deepEqual(recordRecall(s.db,s.userId,s.projectId,recall(n,'early','easy'),later(20)),early)
 assert.deepEqual(recordRecall(s.db,s.userId,s.projectId,recall(n,'first','easy'),later(20)),first)
 assert.throws(()=>recordRecall(s.db,s.userId,s.projectId,recall(n,'early','hard'),later(20)),IdempotencyConflictError)
 assert.equal(rebuildNodeMemory(s.db,s.userId,s.projectId,n).matches,true)
 updateRow(s.db,'memory_node_state',initial.id,{reps:99},{now:later(20)})
 const rebuilt=rebuildNodeMemory(s.db,s.userId,s.projectId,n)
 assert.equal(rebuilt.matches,false);assert.ok((rebuilt.differing_fields as string[]).includes('reps'))
 assert.deepEqual(counts(),before)
 }finally{s.close()}
})
test('memory: reads, suspension and validation leave no accidental writes',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点')
 assert.deepEqual(nodeMemoryView(s.db,s.userId,s.projectId,n,NOW),{memory:null,events:[]})
 assert.throws(()=>recordRecall(s.db,s.userId,s.projectId,recall(n,' '),NOW),InvalidInput)
 assert.throws(()=>recordRecall(s.db,s.userId,s.projectId,{...recall(n,'bad'),sessionId:'foreign'},NOW),ScopeViolation)
 assert.equal(findRows(s.db,'memory_node_state').length,0)
 getOrCreateNodeMemory(s.db,s.userId,s.projectId,n,NOW)
 assert.equal(dueNodeMemories(s.db,s.userId,s.projectId,s.subjectId,NOW).length,1)
 assert.equal(memoryForNodes(s.db,s.userId,s.projectId,[n],NOW).get(n)?.retrievability,null)
 assert.equal(suspendNodeMemory(s.db,s.userId,s.projectId,n,'暂停',NOW).is_due,false)
 assert.throws(()=>recordRecall(s.db,s.userId,s.projectId,recall(n,'pause'),NOW),InvalidInput)
 assert.equal(dueNodeMemories(s.db,s.userId,s.projectId,null,NOW).length,0)
 assert.equal(resumeNodeMemory(s.db,s.userId,s.projectId,n,NOW).is_due,true)
 assert.equal(rebuildNodeMemory(s.db,s.userId,s.projectId,n).matches,true)
 }finally{s.close()}
})
test('memory: invalid enums and foreign session, step and item links are rejected atomically',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点')
 for(const patch of [{kind:'unknown'},{rating:'unknown'},{source:'model'},{latencyMs:-1},{confidenceBefore:6}]) assert.throws(()=>recordRecall(s.db,s.userId,s.projectId,{...recall(n,'invalid'),...patch},NOW),InvalidInput)
 const other=insertRow(s.db,'accounts_user',completeRow('accounts_user',{email:'other@example.com',date_joined:NOW}),{now:NOW})
 const session=insertRow(s.db,'learning_interaction_session',completeRow('learning_interaction_session',{user_id:other.id,project_id:s.projectId,subject_id:s.subjectId,mode:'daily',status:'active',stage:'warmup'}),{now:NOW})
 const step=insertRow(s.db,'learning_session_step',completeRow('learning_session_step',{session_id:session.id,ordinal:1,stage:'warmup',kind:'recall',status:'pending'}),{now:NOW})
 for(const patch of [{sessionId:String(session.id)},{stepId:String(step.id)},{sessionItemId:'missing-item'}]) assert.throws(()=>recordRecall(s.db,s.userId,s.projectId,{...recall(n,'foreign'),...patch},NOW),ScopeViolation)
 assert.equal(findRows(s.db,'memory_node_state').length,0);assert.equal(findRows(s.db,'memory_recall_event').length,0)
 }finally{s.close()}
})
