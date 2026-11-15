/** 内容卡追加版本；只有当前且人工确认的卡才能作为回忆基准。 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { findOne, findRows, insertRow, updateRow, type Row } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { requireProject, requireSubject } from './exams.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import type { NodeCardOut, NodeCardKeyPoint } from './study_contract.ts'
export interface CardInput { blocks: unknown[]; key_points: unknown[]; citations: string[]; source_note?: string }
function scope(db: DatabaseSync, userId: string, projectId: string, nodeId: string): Row {
  requireProject(db,userId,projectId)
  const node = findOne(db,'knowledge_node',{id:nodeId})
  const syllabus = node && findOne(db,'exams_syllabus_version',{id:node.syllabus_version_id})
  if (!node || !syllabus) throw new ScopeViolation('考点不存在或不属于该项目')
  requireSubject(db,userId,projectId,String(syllabus.subject_id))
  return node
}
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
function validate(input: CardInput) {
  if (!Array.isArray(input.blocks) || !input.blocks.length) throw new InvalidInput('内容块不能为空')
  for (const raw of input.blocks) {
    const b = raw as Record<string,unknown> | null
    if (!b || typeof b !== 'object' || !(
      b.kind === 'text' && nonempty(b.text) || b.kind === 'math' && nonempty(b.latex) ||
      b.kind === 'list' && Array.isArray(b.items) && b.items.length > 0 && b.items.every(nonempty)
    )) throw new InvalidInput('内容块必须为非空文字、公式或列表')
  }
  if (!Array.isArray(input.key_points) || !input.key_points.length || input.key_points.length > 20) throw new InvalidInput('关键点需要 1 至 20 项')
  const ids = new Set<string>()
  const points = input.key_points.map(raw => {
    const p = raw as Record<string,unknown> | null
    if (!p || !nonempty(p.id) || !nonempty(p.text) || ids.has(p.id.trim()) || (p.required !== undefined && typeof p.required !== 'boolean')) throw new InvalidInput('关键点必须有唯一标识和非空文字')
    ids.add(p.id.trim())
    return { id: p.id.trim(), text: p.text.trim(), required: p.required !== false }
  })
  if (!points.some(p=>p.required)) throw new InvalidInput('至少需要一个必要关键点')
  if (!Array.isArray(input.citations) || input.citations.some(c => typeof c !== 'string' || !/^(knowledge_node|question_version|answer_key_version|rubric_version|node_card):\S+$/.test(c))) throw new InvalidInput('引用必须使用允许的来源前缀并包含标识')
  if (input.source_note !== undefined && typeof input.source_note !== 'string') throw new InvalidInput('来源说明必须为文字')
  return points
}
function out(row: Row, node: Row): NodeCardOut {
  return { card_id:String(row.id),node_id:String(row.node_id),node_name:String(node.canonical_name),syllabus_version_id:String(row.syllabus_version_id),revision:Number(row.revision),is_current:Boolean(row.is_current),status:String(row.status),origin:String(row.origin),blocks:row.blocks as NodeCardOut['blocks'],key_points:row.key_points as NodeCardKeyPoint[],citations:row.citations as string[],source_note:String(row.source_note),model_run_id:row.model_run_id == null ? null : String(row.model_run_id),confirmed_at:row.confirmed_at == null ? null : formatPythonIso(row.confirmed_at as Instant),created_at:formatPythonIso(row.created_at as Instant) }
}
export function cardRevisions(db:DatabaseSync,userId:string,projectId:string,nodeId:string):NodeCardOut[] {
  const node=scope(db,userId,projectId,nodeId)
  return findRows(db,'knowledge_node_card',{node_id:nodeId},{orderBy:[['revision','desc']]}).map(r=>out(r,node))
}
export function currentCard(db:DatabaseSync,userId:string,projectId:string,nodeId:string):NodeCardOut|null { return cardRevisions(db,userId,projectId,nodeId).find(c=>c.is_current) ?? null }
export function confirmedCard(db:DatabaseSync,userId:string,projectId:string,nodeId:string):NodeCardOut|null { const c=currentCard(db,userId,projectId,nodeId); return c?.status==='confirmed'?c:null }
export function createCardRevision(db:DatabaseSync,userId:string,projectId:string,nodeId:string,input:CardInput,options:{origin:'manual'|'model_candidate';modelRunId?:string|null},now:Instant):NodeCardOut {
  const node=scope(db,userId,projectId,nodeId), points=validate(input)
  if (!['manual','model_candidate'].includes(options.origin)) throw new InvalidInput('未知内容卡来源')
  if (options.origin==='model_candidate' && !nonempty(options.modelRunId)) throw new InvalidInput('模型草稿必须关联模型运行记录')
  return transaction(db,()=>{
    const rows=findRows(db,'knowledge_node_card',{node_id:nodeId})
    for (const row of rows) if (row.is_current) updateRow(db,'knowledge_node_card',row.id,{is_current:false},{now})
    return out(insertRow(db,'knowledge_node_card',{node_id:nodeId,syllabus_version_id:node.syllabus_version_id,revision:Math.max(0,...rows.map(r=>Number(r.revision)))+1,is_current:true,status:'draft',origin:options.origin,blocks:input.blocks,key_points:points,citations:input.citations,source_note:input.source_note??'',model_run_id:options.modelRunId??null,confirmed_at:null,confirmed_by_id:null},{now}),node)
  })
}
export function confirmCard(db:DatabaseSync,userId:string,projectId:string,cardId:string,now:Instant):NodeCardOut {
  return transaction(db,()=>{
    const row=findOne(db,'knowledge_node_card',{id:cardId})
    if (!row) throw new ScopeViolation('内容卡不存在')
    const node=scope(db,userId,projectId,String(row.node_id))
    if (!row.is_current) throw new InvalidInput('只能确认当前版本')
    if (row.status==='confirmed') return out(row,node)
    if (row.status!=='draft') throw new InvalidInput('只能确认草稿')
    validate(row as unknown as CardInput)
    if (!(row.citations as string[]).length) throw new InvalidInput('确认内容卡至少需要一条引用')
    return out(updateRow(db,'knowledge_node_card',row.id,{status:'confirmed',confirmed_at:now,confirmed_by_id:userId},{now})!,node)
  })
}
