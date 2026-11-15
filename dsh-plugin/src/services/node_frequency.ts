/** 考频只读画像：周期口径复用 cycles，派生数学复用 knowledge_value。 */
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { computeFrequency, DEFAULT_HORIZON, FREQUENCY_RULE_VERSION, type CycleObservation } from '../domain/knowledge_value.ts'
import { findOne, findRows, type Row } from '../store/repository.ts'
import { requireProject, requireSubject } from './exams.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import { paperIsCountable, effectiveRevision, primaryMappings, nodePath, compareCodePoints, cycleSortKey, cycleNotes } from './cycles.ts'
import type { FrequencyProfile, SubjectFrequencyOut, PlanningValue } from './study_contract.ts'

const dec = (v: unknown) => v instanceof Decimal ? v : Decimal.parse(String(v))
const byId = (a: Row, b: Row) => compareCodePoints(String(a.id), String(b.id))
function scopedNode(db: DatabaseSync, userId: string, projectId: string, nodeId: string): { node: Row; subjectId: string } {
  requireProject(db, userId, projectId)
  const node = findOne(db, 'knowledge_node', { id: nodeId })
  const syllabus = node && findOne(db, 'exams_syllabus_version', { id: node.syllabus_version_id })
  if (!node || !syllabus) throw new ScopeViolation('考点不存在或不属于该项目')
  const subjectId = String(syllabus.subject_id)
  requireSubject(db, userId, projectId, subjectId)
  return { node, subjectId }
}
function dataset(db: DatabaseSync, subjectId: string, horizon: number) {
  if (!Number.isInteger(horizon) || horizon < 1) throw new InvalidInput('周期数量必须为正整数')
  const groups = new Map<string, Row[]>()
  for (const paper of findRows(db, 'exams_paper', { subject_id: subjectId }).sort(byId)) {
    const key = String(paper.cycle_key)
    groups.set(key, [...(groups.get(key) ?? []), paper])
  }
  const excluded: FrequencyProfile['excluded_papers'] = []
  const all = [...groups].sort(([a], [b]) => cycleSortKey(b)[0] - cycleSortKey(a)[0] || -compareCodePoints(a, b)).map(([key, papers]) => {
    const reasons: string[] = []
    for (const paper of papers) {
      const [ok, reason] = paperIsCountable(db, paper)
      if (!ok) { reasons.push(reason); excluded.push({ paper_id: String(paper.id), reason }) }
    }
    return { key, papers, reasons }
  })
  const used = all.filter(c => !c.reasons.length).slice(0, horizon).map(c => {
    const items = c.papers.flatMap(p => findRows(db, 'exams_paper_item', { revision_id: effectiveRevision(db, p)!.id, is_scored: true })).sort(byId)
    let total = Decimal.zero()
    const entries = items.map(item => {
      const score = dec(item.max_score)
      total = total.add(score)
      const mappings = primaryMappings(db, String(item.question_version_id))
      let weights = Decimal.zero()
      for (const m of mappings) weights = weights.add(dec(m.score_weight))
      const shares = mappings.map(m => ({ node: String(m.node_id), marks: score.mul(dec(m.score_weight)).div(weights) }))
      const version = findOne(db, 'question_bank_question_version', { id: item.question_version_id })!
      return { score, shares, type: String(version.question_type) }
    })
    return { ...c, total, entries }
  })
  return { all, used, excluded, horizon }
}
type Data = ReturnType<typeof dataset>
function profile(db: DatabaseSync, node: Row, subjectId: string, data: Data, ids: Set<string>): FrequencyProfile {
  const observations: CycleObservation[] = data.used.map((c, age) => {
    let marks = Decimal.zero(), appearances = 0
    const types: Record<string, number> = {}
    for (const item of c.entries) {
      const selected = item.shares.filter(s => ids.has(s.node))
      if (!selected.length) continue
      appearances++
      types[item.type] = (types[item.type] ?? 0) + 1
      for (const share of selected) marks = marks.add(share.marks)
    }
    return { cycle_key: c.key, age, present: appearances > 0, appearances, marks, denominator: c.total.gt(Decimal.zero()) ? c.total : null, question_types: types }
  })
  const computed = computeFrequency(observations, { horizon: data.horizon })
  return { node_id: String(node.id), node_name: String(node.canonical_name), path: nodePath(db, node), subject_id: subjectId,
    horizon: data.horizon, ...computed, used_cycles: data.used.map(c => c.key),
    cycles: observations.map(o => ({ cycle_key: o.cycle_key, countable: true, reasons: [], appearances: o.appearances,
      marks: dec(o.marks).quantize(-3).toString(), denominator: o.denominator === null ? null : dec(o.denominator).quantize(-3).toString(),
      share: o.denominator === null ? null : dec(o.marks).div(dec(o.denominator)).quantize(-4).toString(), question_types: o.question_types })),
    excluded_papers: data.excluded, notes: [...cycleNotes(computed.status, observations.length, data.horizon, data.all.filter(c => c.reasons.length).length), ...computed.notes], rule_version: FREQUENCY_RULE_VERSION }
}
export function nodeFrequency(db: DatabaseSync, userId: string, projectId: string, nodeId: string, options: { horizon?: number; includeDescendants?: boolean } = {}): FrequencyProfile {
  const { node, subjectId } = scopedNode(db, userId, projectId, nodeId)
  const ids = new Set([nodeId])
  if (options.includeDescendants) {
    const nodes = findRows(db, 'knowledge_node', { syllabus_version_id: node.syllabus_version_id, is_unclassified: false })
    let changed = true
    while (changed) { changed = false; for (const child of nodes) if (ids.has(String(child.parent_id)) && !ids.has(String(child.id))) { ids.add(String(child.id)); changed = true } }
    if (node.is_unclassified) ids.delete(nodeId)
  }
  return profile(db, node, subjectId, dataset(db, subjectId, options.horizon ?? DEFAULT_HORIZON), ids)
}
export function subjectFrequency(db: DatabaseSync, userId: string, projectId: string, subjectId: string, options: { horizon?: number } = {}): SubjectFrequencyOut {
  const subject = requireSubject(db, userId, projectId, subjectId)
  const data = dataset(db, subjectId, options.horizon ?? DEFAULT_HORIZON)
  const published = new Set(findRows(db, 'exams_syllabus_version', { subject_id: subjectId, status: 'published' }).map(r => String(r.id)))
  const nodes = findRows(db, 'knowledge_node', { is_unclassified: false }).filter(n => published.has(String(n.syllabus_version_id))).sort(byId)
    .map(n => profile(db, n, subjectId, data, new Set([String(n.id)])))
    .sort((a,b) => Number(b.value_index ?? -1) - Number(a.value_index ?? -1) || compareCodePoints(a.node_name,b.node_name) || compareCodePoints(a.node_id,b.node_id))
  let marks = Decimal.zero(), appearances = 0
  for (const c of data.used) for (const item of c.entries) if (!item.shares.length) { marks = marks.add(item.score); appearances++ }
  const computed = computeFrequency(data.used.map((c, age) => ({ cycle_key: c.key, age, present: false, appearances: 0, marks: 0, denominator: c.total, question_types: {} })), options)
  return { subject_id: subjectId, subject_name: String(subject.name), horizon: data.horizon, status: computed.status, counted_cycles: data.used.length,
    used_cycles: data.used.map(c => c.key), nodes, coverage_gaps: nodes.filter(n => !n.appearances).map(n => ({ node_id: n.node_id, label: n.node_name, path: n.path, reason: 'never_examined_in_counted_cycles' })),
    unclassified: { appearances, marks: marks.quantize(-3).toString() }, notes: [...cycleNotes(computed.status, data.used.length, data.horizon, data.all.filter(c => c.reasons.length).length), ...computed.notes], rule_version: FREQUENCY_RULE_VERSION }
}
export function planningValues(db: DatabaseSync, userId: string, projectId: string, subjectId: string, options: { horizon?: number } = {}): Map<string, PlanningValue> {
  return new Map(subjectFrequency(db,userId,projectId,subjectId,options).nodes.map(n => [n.node_id, { node_id: n.node_id, value_index: n.value_index === null ? null : Number(n.value_index), status: n.status, appearances: n.appearances, cycles_present: n.cycles_present, counted_cycles: n.counted_cycles, last_seen_cycle: n.last_seen_cycle }]))
}
