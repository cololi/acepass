import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../src/domain/decimal.ts'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'


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


import {createCardRevision,confirmCard,currentCard,confirmedCard,cardRevisions} from '../src/services/node_cards.ts'
import {InvalidInput,ScopeViolation} from '../src/services/errors.ts'
const input={blocks:[{kind:'text',text:'定义'}],key_points:[{id:'a',text:'必要点',required:true}],citations:['knowledge_node:source']}
test('cards: draft, confirmation, append revisions and current baseline',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点')
 const a=createCardRevision(s.db,s.userId,s.projectId,n,input,{origin:'manual'},NOW)
 assert.equal(a.status,'draft');assert.equal(a.revision,1);assert.equal(confirmedCard(s.db,s.userId,s.projectId,n),null)
 const confirmed=confirmCard(s.db,s.userId,s.projectId,a.card_id,NOW)
 assert.equal(confirmed.status,'confirmed');assert.deepEqual(confirmCard(s.db,s.userId,s.projectId,a.card_id,NOW),confirmed)
 assert.equal(confirmedCard(s.db,s.userId,s.projectId,n)?.card_id,a.card_id)
 const b=createCardRevision(s.db,s.userId,s.projectId,n,input,{origin:'manual'},NOW)
 assert.equal(b.revision,2);assert.equal(currentCard(s.db,s.userId,s.projectId,n)?.card_id,b.card_id)
 assert.equal(cardRevisions(s.db,s.userId,s.projectId,n)[1].is_current,false)
 assert.equal(confirmedCard(s.db,s.userId,s.projectId,n),null)
 assert.throws(()=>confirmCard(s.db,s.userId,s.projectId,a.card_id,NOW),InvalidInput)
 }finally{s.close()}
})
test('cards: reject invalid content, missing confirmation citation and foreign owner',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点')
 for(const bad of [{...input,key_points:[]},{...input,blocks:[]},{...input,key_points:[{id:'a',text:'x',required:false}]},{...input,citations:['https://example.com']},{...input,key_points:[{id:'a',text:'x'},{id:'a',text:'y'}]}]) assert.throws(()=>createCardRevision(s.db,s.userId,s.projectId,n,bad,{origin:'manual'},NOW),InvalidInput)
 const draft=createCardRevision(s.db,s.userId,s.projectId,n,{...input,citations:[]},{origin:'manual'},NOW)
 assert.throws(()=>confirmCard(s.db,s.userId,s.projectId,draft.card_id,NOW),InvalidInput)
 assert.throws(()=>createCardRevision(s.db,s.userId,s.projectId,n,input,{origin:'model_candidate'},NOW),InvalidInput)
 assert.throws(()=>currentCard(s.db,'outsider',s.projectId,n),ScopeViolation)
 assert.throws(()=>createCardRevision(s.db,'outsider',s.projectId,n,input,{origin:'manual'},NOW),ScopeViolation)
 }finally{s.close()}
})
test('cards: model candidate requires a human confirmation and accepts all block kinds',()=>{
 const s=emptyStore();try {
 const n=addNode(s,addSyllabus(s,'纲'),'点')
 const run=insertRow(s.db,'audit_llm_run',completeRow('audit_llm_run',{user_id:s.userId,status:'succeeded'}),{now:NOW})
 const draft=createCardRevision(s.db,s.userId,s.projectId,n,{...input,blocks:[{kind:'math',latex:'x=1'},{kind:'list',items:['条件']}]},{origin:'model_candidate',modelRunId:String(run.id)},NOW)
 assert.equal(draft.origin,'model_candidate');assert.equal(draft.status,'draft')
 assert.equal(confirmedCard(s.db,s.userId,s.projectId,n),null)
 assert.equal(confirmCard(s.db,s.userId,s.projectId,draft.card_id,NOW).status,'confirmed')
 }finally{s.close()}
})
