/** 考点记忆台账与 FSRS 投影；不写练习、成绩、能力或证据。 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { FSRS_VERSION, DEFAULT_WEIGHTS, newCard, schedule, weightsFor, type CardState } from '../domain/fsrs.ts'
import { desiredRetentionForValue } from '../domain/knowledge_value.ts'
import { evaluateRecall, isSpaced, type RecallRating } from '../domain/recall.ts'
import { findOne, findRows, insertRow, updateRow, type Row } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { requireProject, requireSubject } from './exams.ts'
import { InvalidInput, ScopeViolation, IdempotencyConflictError } from './errors.ts'
import { normaliseIdempotencyKey } from './idempotency_key.ts'
import { cardState, retrievabilityNow } from './memory.ts'
import { nodeFrequency } from './node_frequency.ts'
import { compareCodePoints } from './cycles.ts'
import type { RecallCoverage, RecallEventOut, NodeMemoryOut } from './study_contract.ts'
export interface RecordRecallInput {
  nodeId:string; kind:string; rating:string; source:string; coverage?:RecallCoverage; promptText?:string; answerText?:string;
  latencyMs?:number|null; confidenceBefore?:number|null; questionId?:string|null; sessionItemId?:string|null;
  sessionId?:string|null; stepId?:string|null; modelRunId?:string|null; idempotencyKey:string; note?:string; reviewedAt?:Instant;
}
const iso=(v:unknown)=>v==null?null:formatPythonIso(v as Instant)
function scope(db:DatabaseSync,userId:string,projectId:string,nodeId:string):Row {
  requireProject(db,userId,projectId)
  const node=findOne(db,'knowledge_node',{id:nodeId})
  const syllabus=node && findOne(db,'exams_syllabus_version',{id:node.syllabus_version_id})
  if (!node || !syllabus) throw new ScopeViolation('考点不存在或不属于该项目')
  requireSubject(db,userId,projectId,String(syllabus.subject_id))
  return node
}
const stateOf=(r:Row)=>cardState({...r,last_reviewed_at:r.last_recall_at})
function statePatch(s:CardState):Row { return {phase:s.phase,stability:s.stability,difficulty:s.difficulty,due_at:s.dueAt,last_recall_at:s.lastReviewedAt,reps:s.reps,lapses:s.lapses,learning_step:s.learningStep} }
function payload(db:DatabaseSync,r:Row,now:Instant):NodeMemoryOut {
  return {node_id:String(r.node_id),node_name:String(findOne(db,'knowledge_node',{id:r.node_id})!.canonical_name),modality:String(r.modality),phase:String(r.phase),stability:Number(r.stability),difficulty:Number(r.difficulty),due_at:iso(r.due_at),last_recall_at:iso(r.last_recall_at),reps:Number(r.reps),lapses:Number(r.lapses),learning_step:Number(r.learning_step),retrievability:retrievabilityNow({...r,last_reviewed_at:r.last_recall_at},now),desired_retention:Number(r.desired_retention),is_suspended:Boolean(r.is_suspended),suspended_reason:String(r.suspended_reason),scheduler_version:String(r.scheduler_version),params_version:String(r.params_version),is_due:!r.is_suspended && r.due_at!=null && (r.due_at as Instant)<=now}
}
export function getOrCreateNodeMemory(db:DatabaseSync,userId:string,projectId:string,nodeId:string,now:Instant,options:{desiredRetention?:number}={}):Row {
  const node=scope(db,userId,projectId,nodeId)
  if (options.desiredRetention!==undefined && (!Number.isFinite(options.desiredRetention)||options.desiredRetention<=0||options.desiredRetention>=1)) throw new InvalidInput('目标保持率必须在 0 与 1 之间')
  return transaction(db,()=>{
    const existing=findOne(db,'memory_node_state',{user_id:userId,node_id:nodeId,modality:'recall'})
    if (existing) return existing
    const retention=options.desiredRetention??desiredRetentionForValue(nodeFrequency(db,userId,projectId,nodeId).value_index)
    return insertRow(db,'memory_node_state',{user_id:userId,project_id:projectId,node_id:nodeId,syllabus_version_id:node.syllabus_version_id,modality:'recall',...statePatch({...newCard(),dueAt:now}),scheduler_version:FSRS_VERSION,params_version:FSRS_VERSION,desired_retention:retention,is_suspended:false,suspended_reason:'',note:''},{now})
  })
}
function logs(db:DatabaseSync,id:unknown):Row[] {
  return findRows(db,'memory_recall_event',{memory_state_id:id}).sort((a,b)=>Number((a.reviewed_at as Instant)-(b.reviewed_at as Instant))||Number((a.created_at as Instant)-(b.created_at as Instant))||compareCodePoints(String(a.id),String(b.id)))
}
function eventOut(db:DatabaseSync,row:Row,memory:Row):RecallEventOut {
  const raw=row.coverage as RecallCoverage & {_requested_rating?:string}
  // 事件响应使用当时的投影，幂等重放不会被后续复习改写。
  let state=newCard()
  state.dueAt=memory.created_at as Instant
  for (const log of logs(db,memory.id)) {
    if (log.is_spaced) state=schedule(state,String(log.rating),log.reviewed_at as Instant,{weights:weightsFor(String(log.params_version)),desiredRetention:Number(memory.desired_retention)}).state
    if (log.id===row.id) break
  }
  return {event_id:String(row.id),node_id:String(row.node_id),rating:String(row.rating),source:String(row.source),kind:String(row.kind),is_spaced:Boolean(row.is_spaced),early_review:Boolean(row.early_review),memory_updated:Boolean(row.is_spaced),coverage:{covered:raw.covered,missing:raw.missing,cannot_judge:raw.cannot_judge,coverage:raw.coverage},reviewed_at:iso(row.reviewed_at)!,due_at:iso(row.due_after),interval_days:Number(row.interval_days),stability:Number(row.stability_after),difficulty:Number(row.difficulty_after),retrievability:Number(row.retrievability),memory:payload(db,{...memory,...statePatch(state),is_suspended:false,suspended_reason:'',params_version:row.params_version,scheduler_version:row.scheduler_version},row.reviewed_at as Instant),notes:[...(row.note?[String(row.note)]:[]),...(row.early_review?['early_review']:[])]}
}
function validateLinks(db:DatabaseSync,userId:string,projectId:string,input:RecordRecallInput) {
  const checkSession=(table:string,id:string)=>{
    const r=findOne(db,table,{id,user_id:userId,project_id:projectId})
    if (!r) throw new ScopeViolation('关联会话不存在或不属于当前用户和项目')
    return r
  }
  if (input.sessionId) checkSession('learning_interaction_session',input.sessionId)
  if (input.stepId) {
    const step=findOne(db,'learning_session_step',{id:input.stepId})
    if (!step) throw new ScopeViolation('关联步骤不存在')
    checkSession('learning_interaction_session',String(step.session_id))
    if (input.sessionId && step.session_id!==input.sessionId) throw new ScopeViolation('步骤不属于关联会话')
  }
  if (input.sessionItemId) {
    const item=findOne(db,'practice_session_item',{id:input.sessionItemId})
    if (!item) throw new ScopeViolation('关联题项不存在')
    checkSession('practice_session',String(item.session_id))
    if (input.questionId) {
      // `practice_session_item` freezes a *version*, not a question id; resolve it so the link
      // check compares the real identity instead of an always-undefined column.
      const version=findOne(db,'question_bank_question_version',{id:String(item.question_version_id)})
      if (version && String(version.question_id)!==input.questionId) throw new ScopeViolation('题项与题目不一致')
    }
  }
  if (input.questionId) {
    const q=findOne(db,'question_bank_question',{id:input.questionId})
    if (!q) throw new ScopeViolation('关联题目不存在')
    requireSubject(db,userId,projectId,String(q.subject_id))
  }
}
export function recordRecall(db:DatabaseSync,userId:string,projectId:string,input:RecordRecallInput,now:Instant):RecallEventOut {
  if (!['free_recall','cued_recall','self_explain','quiz'].includes(input.kind)) throw new InvalidInput('未知回忆类型')
  if (!['again','hard','good','easy'].includes(input.rating)) throw new InvalidInput('未知回忆评级')
  if (!['self_report','deterministic','model_assisted_confirmed'].includes(input.source)) throw new InvalidInput('未知回忆来源')
  if (!input.idempotencyKey?.trim()) throw new InvalidInput('回忆必须提供非空幂等键')
  const key=normaliseIdempotencyKey(input.idempotencyKey)
  const coverage=input.coverage??{covered:[],missing:[],cannot_judge:[],coverage:null}
  if (!coverage || !['covered','missing','cannot_judge'].every(k=>Array.isArray(coverage[k as keyof RecallCoverage]) && (coverage[k as keyof RecallCoverage] as unknown[]).every(v=>typeof v==='string')) || (coverage.coverage!==null && (!Number.isFinite(coverage.coverage)||coverage.coverage<0||coverage.coverage>1))) throw new InvalidInput('覆盖信息无效')
  if (input.latencyMs!=null && (!Number.isInteger(input.latencyMs)||input.latencyMs<0)) throw new InvalidInput('回忆用时必须为非负整数')
  if (input.confidenceBefore!=null && (!Number.isInteger(input.confidenceBefore)||input.confidenceBefore<1||input.confidenceBefore>5)) throw new InvalidInput('信心值必须为 1 至 5')
  return transaction(db,()=>{
    scope(db,userId,projectId,input.nodeId)
    validateLinks(db,userId,projectId,input)
    const memory=getOrCreateNodeMemory(db,userId,projectId,input.nodeId,now)
    const existing=findOne(db,'memory_recall_event',{memory_state_id:memory.id,idempotency_key:key})
    if (existing) {
      const original=(existing.coverage as Record<string,unknown>)._requested_rating??existing.rating
      if (original!==input.rating) throw new IdempotencyConflictError('相同幂等键使用了不同评级')
      return eventOut(db,existing,memory)
    }
    if (memory.is_suspended) throw new InvalidInput('记忆已暂停，请先恢复')
    const at=input.reviewedAt??now
    if (at>now || at<(memory.created_at as Instant) || (memory.last_recall_at!=null && at<(memory.last_recall_at as Instant))) throw new InvalidInput('回忆时间不能在未来或早于已有记忆')
    const before=stateOf(memory), spaced=isSpaced(before.lastReviewedAt,at), early=before.dueAt!==null&&at<before.dueAt
    const rating=evaluateRecall({coverage:null,hintLevel:0,latencyRatio:null,selfRating:input.rating as RecallRating,earlyReview:early})!.rating
    const result=spaced?schedule(before,rating,at,{weights:weightsFor(String(memory.params_version)),desiredRetention:Number(memory.desired_retention)}):null
    const after=result?.state??before
    const event=insertRow(db,'memory_recall_event',{
      memory_state_id:memory.id,user_id:userId,project_id:projectId,syllabus_version_id:memory.syllabus_version_id,node_id:input.nodeId,kind:input.kind,rating,source:input.source,is_spaced:spaced,early_review:early,
      // 内部元数据保留封顶前评级；对外 coverage 严格裁剪为冻结契约。
      coverage:{...coverage,_requested_rating:input.rating},prompt_text:input.promptText??'',answer_text:input.answerText??'',latency_ms:input.latencyMs??null,confidence_before:input.confidenceBefore??null,
      reviewed_at:at,elapsed_days:result?.elapsedDays??(before.lastReviewedAt===null?0:Number(at-before.lastReviewedAt)/86400000000),scheduled_days:before.scheduledDays,interval_days:result?.intervalDays??0,retrievability:result?.retrievability??retrievabilityNow({...memory,last_reviewed_at:memory.last_recall_at},at)??1,is_lapse:result?.isLapse??false,
      phase_before:before.phase,phase_after:after.phase,stability_before:before.stability,stability_after:after.stability,difficulty_before:before.difficulty,difficulty_after:after.difficulty,due_before:before.dueAt,due_after:after.dueAt,scheduler_version:result?.schedulerVersion??memory.scheduler_version,params_version:memory.params_version,idempotency_key:key,
      session_id:input.sessionId??null,step_id:input.stepId??null,question_id:input.questionId??null,session_item_id:input.sessionItemId??null,model_run_id:input.modelRunId??null,note:spaced?(input.note??''):'not_spaced'
    },{now})
    if (result) updateRow(db,'memory_node_state',memory.id,{...statePatch(after),scheduler_version:result.schedulerVersion},{now})
    return eventOut(db,event,memory)
  })
}
export function nodeMemoryView(db:DatabaseSync,userId:string,projectId:string,nodeId:string,now:Instant):{memory:NodeMemoryOut|null;events:RecallEventOut[]} {
  scope(db,userId,projectId,nodeId)
  const row=findOne(db,'memory_node_state',{user_id:userId,project_id:projectId,node_id:nodeId,modality:'recall'})
  return row?{memory:payload(db,row,now),events:logs(db,row.id).reverse().slice(0,20).map(e=>eventOut(db,e,row))}:{memory:null,events:[]}
}
export function memoryForNodes(db:DatabaseSync,userId:string,projectId:string,nodeIds:string[],now:Instant):Map<string,NodeMemoryOut> {
  requireProject(db,userId,projectId)
  const result=new Map<string,NodeMemoryOut>()
  for (const id of new Set(nodeIds)) { scope(db,userId,projectId,id); const row=findOne(db,'memory_node_state',{user_id:userId,project_id:projectId,node_id:id,modality:'recall'}); if(row) result.set(id,payload(db,row,now)) }
  return result
}
export function dueNodeMemories(db:DatabaseSync,userId:string,projectId:string,subjectId:string|null,now:Instant,limit=50):NodeMemoryOut[] {
  requireProject(db,userId,projectId)
  if (subjectId!==null) requireSubject(db,userId,projectId,subjectId)
  const syllabi=subjectId===null?null:new Set(findRows(db,'exams_syllabus_version',{subject_id:subjectId}).map(s=>String(s.id)))
  if (!Number.isFinite(limit)) throw new InvalidInput('条数必须为有限数字')
  return findRows(db,'memory_node_state',{user_id:userId,project_id:projectId,modality:'recall',is_suspended:false}).filter(r=>r.due_at!=null&&(r.due_at as Instant)<=now&&(!syllabi||syllabi.has(String(r.syllabus_version_id))))
    .sort((a,b)=>Number((a.due_at as Instant)-(b.due_at as Instant))||compareCodePoints(String(a.id),String(b.id))).slice(0,Math.max(0,Math.min(200,Math.trunc(limit)))).map(r=>payload(db,r,now))
}
export function rebuildNodeMemory(db:DatabaseSync,userId:string,projectId:string,nodeId:string):Record<string,unknown> {
  scope(db,userId,projectId,nodeId)
  const row=findOne(db,'memory_node_state',{user_id:userId,project_id:projectId,node_id:nodeId,modality:'recall'})
  if (!row) throw new ScopeViolation('考点记忆不存在')
  const events=logs(db,row.id),unknown:string[]=[]
  let state={...newCard(),dueAt:row.created_at as Instant},params=FSRS_VERSION,scheduler=FSRS_VERSION
  for (const e of events) {
    if (!e.is_spaced) continue
    params=String(e.params_version); scheduler=String(e.scheduler_version)
    let weights=DEFAULT_WEIGHTS
    try { weights=weightsFor(params) } catch { unknown.push(params) }
    state=schedule(state,String(e.rating),e.reviewed_at as Instant,{weights,desiredRetention:Number(row.desired_retention)}).state as typeof state
  }
  const comparable=(s:CardState,p:string,v:string)=>({...statePatch(s),due_at:iso(s.dueAt),last_recall_at:iso(s.lastReviewedAt),params_version:p,scheduler_version:v})
  const rebuilt:Row=comparable(state,params,scheduler),stored:Row=comparable(stateOf(row),String(row.params_version),String(row.scheduler_version))
  const compared=Object.keys(rebuilt),differing=compared.filter(k=>rebuilt[k]!==stored[k])
  return {matches:!differing.length&&!unknown.length,rebuilt,stored,log_count:events.length,compared_fields:compared,differing_fields:differing,unknown_params_versions:[...new Set(unknown)].sort(compareCodePoints)}
}
function suspension(db:DatabaseSync,userId:string,projectId:string,nodeId:string,reason:string,suspended:boolean,now:Instant):NodeMemoryOut {
  return transaction(db,()=>{scope(db,userId,projectId,nodeId);const row=findOne(db,'memory_node_state',{user_id:userId,project_id:projectId,node_id:nodeId,modality:'recall'});if(!row) throw new ScopeViolation('考点记忆不存在');return payload(db,updateRow(db,'memory_node_state',row.id,{is_suspended:suspended,suspended_reason:Array.from(reason).slice(0,300).join('')},{now})!,now)})
}
export function suspendNodeMemory(db:DatabaseSync,userId:string,projectId:string,nodeId:string,reason:string,now:Instant):NodeMemoryOut {return suspension(db,userId,projectId,nodeId,reason,true,now)}
export function resumeNodeMemory(db:DatabaseSync,userId:string,projectId:string,nodeId:string,now:Instant):NodeMemoryOut {return suspension(db,userId,projectId,nodeId,'',false,now)}
