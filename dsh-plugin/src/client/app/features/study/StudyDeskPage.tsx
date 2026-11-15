import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { createLearningSession, fetchStudyDesk, fetchCurrentLearningSession } from '../../api/study'
import { useScope } from '../../app/context'
import { label, moment, percent, ReadError, sessionDone, useStudyAction } from './StudyShared'

export function StudyDeskPage() {
  const { currentProject, currentSubject } = useScope()
  if (!currentProject || !currentSubject) return <div className="card empty-state" data-testid="page-study-desk">请先选择项目和科目；尚未建立科目时，请到项目页创建。</div>
  return <StudyDesk key={`${currentProject.id}:${currentSubject.id}`} projectId={currentProject.id} subjectId={currentSubject.id} />
}
function StudyDesk({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const navigate = useNavigate()
  const action = useStudyAction()
  const query = useQuery({ queryKey: ['study-desk', projectId, subjectId], queryFn: () => fetchStudyDesk(projectId, subjectId) })
  const current = useQuery({ queryKey: ['current-learning-session', projectId, subjectId], queryFn: () => fetchCurrentLearningSession(projectId, subjectId) })
  const desk = query.data
  const active = [current.data, desk?.session].find(s => s && !sessionDone(s.status))
  const available = desk && desk.budget_minutes > 0 && desk.coverage.nodes_total > 0 && (desk.due_memory.length + desk.value_nodes.length + desk.weak_nodes.length > 0)
  return <section className="study-desk" data-testid="page-study-desk"><div className="page-title"><h1>学习台</h1><span className="sub">{desk?.subject_name} · 先回忆，再练习</span></div>
    {query.isLoading && <div className="card" role="status">正在整理学习内容…</div>}
    {query.isError && <ReadError error={query.error} retry={() => void query.refetch()} />}
    {current.isError && <ReadError error={current.error} retry={() => void current.refetch()} />}
    {desk && <><section className="card"><h2>今天的学习流</h2><p>{active ? label(active.mode) : '日常学习'} · 预算 {active?.budget_minutes ?? desk.budget_minutes} 分钟{active ? ` · ${active.steps.length} 个步骤 · ${label(active.status)}` : ''}</p>
      {active && <p className="muted">预计 {active.estimated_minutes} 分钟 · 回忆 {active.steps.filter(s => s.kind === 'recall').length} · 新考点 {active.steps.filter(s => s.kind === 'encode_read').length} · 练习 {active.steps.filter(s => ['practice', 'repair_retest', 'transfer'].includes(s.kind)).length}</p>}
      {!active && !available && <p className="notice info">{desk.budget_minutes <= 0 ? '今天的学习预算为 0，请先设置学习预算。' : desk.coverage.nodes_total === 0 ? '还没有考点，请先导入大纲并关联题目。' : '暂无可安排的回忆或练习，请完善考点卡和已发布题目。'}</p>}
      <button className="btn primary" data-testid="study-start" disabled={action.busy || current.isLoading || current.isError || (!active && !available)} onClick={() => void action.run(async () => {
        const result = active ?? await createLearningSession(projectId, { subject_id: subjectId, mode: 'daily', budget_minutes: desk.budget_minutes })
        await action.invalidate(result.session_id)
        if (action.isCurrent()) navigate(`/study/sessions/${encodeURIComponent(result.session_id)}`)
      })}>{action.busy ? '准备中…' : active ? '继续学习' : '开始今天的学习'}</button>
      {action.error != null && <ReadError error={action.error} />}
    </section>
    <section className="card"><h2>到期记忆</h2>{desk.due_memory.length === 0 ? <p className="muted">当前没有到期的考点记忆。</p> : desk.due_memory.map(node => <div className="study-list-row" key={node.node_id}><div><strong>{node.node_name}</strong><p className="small muted">记忆 R {percent(node.retrievability)} · 考频 {node.cycles_present}/{node.counted_cycles} 周期 · 到期 {moment(node.due_at)}</p></div><Link className="btn small" to={`/study/nodes/${encodeURIComponent(node.node_id)}`}>回忆此考点</Link></div>)}</section>
    <section className="card"><h2>高价值考点</h2>{desk.value_nodes.length === 0 ? <p className="muted">暂无考频与价值数据，请导入有考试周期的真题并关联考点。</p> : desk.value_nodes.map(node => <div className="study-list-row" key={node.node_id}><div><strong>{node.node_name}</strong><p>价值 {node.value_index ?? '未知'} · 出现 {node.cycles_present}/{node.counted_cycles} 周期（{node.appearances} 次）</p><p className="small muted">能力：{node.ability_summary || '尚未诊断'} · 考点卡：{label(node.card_status)}</p></div><Link className="btn small" to={`/study/nodes/${encodeURIComponent(node.node_id)}`}>查看与学习</Link></div>)}</section>
    <section className="card"><h2>薄弱考点</h2>{desk.weak_nodes.length === 0 ? <p className="muted">暂无薄弱诊断记录；不代表所有考点均已掌握。</p> : desk.weak_nodes.map(node => <div className="study-list-row" key={node.node_id}><div><strong>{node.node_name}</strong><p>{node.ability_summary || '尚未诊断'}{node.needs_review ? ' · 待复核' : ''}</p></div><Link className="btn small" to={`/study/nodes/${encodeURIComponent(node.node_id)}`}>查看卡点</Link></div>)}</section>
    <section className="card"><h2>学习覆盖</h2><div className="row"><span>总考点 {desk.coverage.nodes_total}</span><span>已有记忆 {desk.coverage.nodes_with_memory}</span><span>到期 {desk.coverage.nodes_due}</span><span>未诊断 {desk.coverage.nodes_never_diagnosed}</span></div></section>
    <p className="notice info">{desk.ai.configured ? (desk.ai.coach_available ? 'AI 教练可用' : 'AI 已配置，教练暂不可用') : 'AI 未配置，可阅读考点卡并人工自评'}{desk.ai.message ? `：${desk.ai.message}` : ''}</p>
    {desk.notes.map((note, i) => <p className="muted" key={i}>{note}</p>)}<p className="tiny muted">规则版本：{desk.rule_version}</p></>}
  </section>
}
