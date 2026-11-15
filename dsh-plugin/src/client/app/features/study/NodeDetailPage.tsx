import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { confirmNodeCard, createLearningSession, createNodeCard, fetchNodeCard, fetchNodeFrequency, fetchNodeMemory, generateNodeCard, recallNode } from '../../api/study'
import type { RecallEventOut, RecallRating } from '../../api/study'
import { useScope } from '../../app/context'
import { CoachPanel, label, moment, PayloadBlocks, percent, ratings, ReadError, RecallResult, useStudyAction } from './StudyShared'

export function NodeDetailPage() {
  const { nodeId } = useParams()
  const { currentProject, currentSubject } = useScope()
  if (!currentProject || !nodeId) return <div className="card empty-state">请先选择项目和考点。</div>
  return <NodeDetail key={`${currentProject.id}:${currentSubject?.id}:${nodeId}`} projectId={currentProject.id} nodeId={nodeId} />
}
function NodeDetail({ projectId, nodeId }: { projectId: string; nodeId: string }) {
  const navigate = useNavigate()
  const action = useStudyAction()
  const memory = useQuery({ queryKey: ['node-memory', projectId, nodeId], queryFn: () => fetchNodeMemory(projectId, nodeId) })
  const frequency = useQuery({ queryKey: ['node-frequency', projectId, nodeId, 5], queryFn: () => fetchNodeFrequency(projectId, nodeId) })
  const cardQuery = useQuery({ queryKey: ['node-card', projectId, nodeId], queryFn: () => fetchNodeCard(projectId, nodeId) })
  const [content, setContent] = useState('')
  const [points, setPoints] = useState('')
  const [citations, setCitations] = useState('')
  const [source, setSource] = useState('')
  const [recallText, setRecallText] = useState('')
  const [confidence, setConfidence] = useState(3)
  const [rating, setRating] = useState<RecallRating | ''>('')
  const [event, setEvent] = useState<RecallEventOut | null>(null)
  const card = cardQuery.data?.card
  const profile = frequency.data
  const state = memory.data?.memory
  return <section className="study-node" data-testid="page-study-node"><div className="page-title"><h1>{memory.data?.node_name || profile?.node_name || '考点详情'}</h1><Link to="/study">返回学习台</Link></div>
    {action.error != null && <ReadError error={action.error} />}
    <div className="grid two"><section className="card"><h2>记忆状态</h2>
      {memory.isLoading && <p role="status">正在读取记忆…</p>}{memory.isError && <ReadError error={memory.error} retry={() => void memory.refetch()} />}
      {memory.isSuccess && (state ? <><div className="study-memory-ring" aria-label={`记忆可提取率 ${percent(state.retrievability)}`}><strong>{percent(state.retrievability)}</strong><span>记忆 R</span></div><p>稳定性 S {state.stability} 天 · 难度 {state.difficulty}</p><p>下次到期：{moment(state.due_at)}{state.is_due ? '（已到期）' : ''}</p><p>回忆 {state.reps} 次 · 遗忘 {state.lapses} 次</p>{state.is_suspended && <p className="notice warn">已暂停：{state.suspended_reason}</p>}</> : <p className="muted">尚无记忆记录，完成一次自评回忆后建立。</p>)}
      <p className="tiny muted">记忆评级不等于解题能力，不会将模型建议记为解题得分。</p>
    </section><section className="card"><h2>考频与样本</h2>{frequency.isLoading && <p role="status">正在读取考频…</p>}{frequency.isError && <ReadError error={frequency.error} retry={() => void frequency.refetch()} />}
      {profile && <><p>出现周期 {profile.cycles_present}/{profile.counted_cycles} · 出现 {profile.appearances} 次</p><p>平均份额 {profile.share_avg ?? '未知'} · 平均分值 {profile.marks_avg ?? '未知'}</p><p>价值指数 {profile.value_index ?? '未知'} · 趋势 {profile.trend ?? '未知'}</p><p>最近出现：{profile.last_seen_cycle ?? '暂无'} · 状态：{label(profile.status)}</p>
      {profile.counted_cycles < 3 && <p className="notice warn">可计入周期不足 3 个，样本有限，请谨慎解读考频与趋势。</p>}
      <ul>{Object.entries(profile.question_types).map(([type, count]) => <li key={type}>{label(type)}：{count}</li>)}</ul>
      {profile.notes.map((note, i) => <p className="small muted" key={i}>{note}</p>)}
      <details><summary>统计口径与排除项</summary><p>近 {profile.horizon} 个周期 · 规则 {profile.rule_version}</p><p>计入周期：{profile.used_cycles.join('、') || '无'}</p>{profile.cycles.map(cycle => <p key={cycle.cycle_key}>{cycle.cycle_key}：{cycle.countable ? '计入' : '排除'} · {cycle.reasons.join('、')} · 出现 {cycle.appearances} 次</p>)}{profile.excluded_papers.map((paper, i) => <p key={`${paper.paper_id}:${i}`}>试卷 {paper.paper_id}：{paper.reason}</p>)}</details></>}
    </section></div>
    <section className="card" data-testid="node-card"><h2>核心考点卡</h2>{cardQuery.isLoading && <p role="status">正在读取考点卡…</p>}{cardQuery.isError && <ReadError error={cardQuery.error} retry={() => void cardQuery.refetch()} />}
      {cardQuery.isSuccess && !card && <p className="muted">尚无考点卡。可以手工创建；配置 AI 后也可生成待确认草稿。</p>}
      {card && <><p>修订 {card.revision} · 来源 {label(card.origin)} · <span className="pill neutral">{label(card.status)}</span></p>{!card.confirmed_at && <p className="notice warn">此卡尚未确认，草稿内容需要人工核对。</p>}<PayloadBlocks value={card.blocks} projectId={projectId} /><ul>{card.key_points.map(point => <li key={point.id}>{point.text}{point.required ? '（必需）' : ''}</li>)}</ul><p className="small muted">来源说明：{card.source_note || '未提供'}</p><ul>{card.citations.map((citation, i) => <li key={i}>{citation}</li>)}</ul>
      {!card.confirmed_at && <button className="btn small primary" data-testid="node-card-confirm" disabled={action.busy} onClick={() => void action.run(async () => { await confirmNodeCard(projectId, nodeId, card.card_id); await action.invalidate() })}>核对无误，确认此卡</button>}
      <button className="btn small ghost" disabled={action.busy} onClick={() => { setContent(card.blocks.map(b => typeof b.text === 'string' ? b.text : '').filter(Boolean).join('\n')); setPoints(card.key_points.map(p => `${p.id}|${p.text}|${p.required}`).join('\n')); setCitations(card.citations.join('\n')); setSource(card.source_note) }}>复制文字与要点到新草稿</button></>}
      <details><summary>手动创建新修订</summary><p className="small muted">新修订为草稿，需要再次确认；此表单只创建文字内容。</p>
      <label className="field"><span>考点正文</span><textarea value={content} onChange={e => setContent(e.target.value)} disabled={action.busy} /></label>
      <label className="field"><span>要点（每行 id|text|required，required 为 true 或 false）</span><textarea placeholder="p1|适用条件|true" value={points} onChange={e => setPoints(e.target.value)} disabled={action.busy} /></label>
      <label className="field"><span>引用（每行一条）</span><textarea value={citations} onChange={e => setCitations(e.target.value)} disabled={action.busy} /></label>
      <label className="field"><span>来源说明</span><input value={source} onChange={e => setSource(e.target.value)} disabled={action.busy} /></label>
      <button className="btn small" data-testid="node-card-create" disabled={action.busy || !content.trim() || !points.trim()} onClick={() => void action.run(async () => {
        const ids = new Set<string>()
        const key_points = points.split('\n').filter(line => line.trim()).map(line => {
          const parts = line.split('|').map(part => part.trim())
          if (parts.length !== 3 || !parts[0] || !parts[1] || !['true', 'false'].includes(parts[2]) || ids.has(parts[0])) throw new Error('要点格式应为唯一 id|文字|true 或 false，请检查每一行。')
          ids.add(parts[0]); return { id: parts[0], text: parts[1], required: parts[2] === 'true' }
        })
        await createNodeCard(projectId, nodeId, { blocks: [{ kind: 'text', text: content.trim() }], key_points, citations: citations.split('\n').map(s => s.trim()).filter(Boolean), source_note: source.trim() })
        await action.invalidate()
      })}>保存为草稿</button></details>
      <button className="btn small" data-testid="node-card-generate" disabled={action.busy || cardQuery.isLoading || cardQuery.isError} onClick={() => void action.run(async () => { await generateNodeCard(projectId, nodeId); await action.invalidate() })}>让 AI 起草</button>
      {cardQuery.data && <p className="tiny muted">共有 {cardQuery.data.revisions.length} 个修订。</p>}
    </section>
    <section className="card" data-testid="node-quick-recall"><h2>快速回忆</h2><p className="muted">先不看卡片，写下记得的内容，再诚实自评。无已确认卡时，使用你的评级记录回忆。</p>
      <label className="field"><span>我能回忆的内容</span><textarea value={recallText} onChange={e => { setRecallText(e.target.value); setEvent(null) }} disabled={action.busy} /></label>
      <label className="field"><span>回忆前信心（1–5）</span><select value={confidence} onChange={e => setConfidence(Number(e.target.value))} disabled={action.busy}>{[1, 2, 3, 4, 5].map(n => <option key={n}>{n}</option>)}</select></label>
      <label className="field"><span>我的评级</span><select value={rating} onChange={e => setRating(e.target.value as RecallRating | '')} disabled={action.busy}><option value="">请选择评级</option>{ratings.map(r => <option value={r.value} key={r.value}>{r.label}</option>)}</select></label>
      <button className="btn primary small" disabled={action.busy || !rating || !!event} onClick={() => void action.run(async () => {
        if (!rating) return
        setEvent(await recallNode(projectId, nodeId, { text: recallText.trim(), confidence_before: confidence, rating, kind: 'free_recall' }))
        await action.invalidate()
      })}>确认评级并记录回忆</button>
      {event && <RecallResult event={event} />}
      <div className="divider-top"><p className="small muted">5 分钟会话按本科目到期情况安排考点，未指定单一考点。</p><button className="btn small" disabled={action.busy || !profile?.subject_id} onClick={() => void action.run(async () => {
        if (!profile) return
        const session = await createLearningSession(projectId, { subject_id: profile.subject_id, mode: 'quick_recall', budget_minutes: 5 })
        await action.invalidate(session.session_id)
        if (action.isCurrent()) navigate(`/study/sessions/${encodeURIComponent(session.session_id)}`)
      })}>开始 5 分钟回忆</button></div>
    </section>
    <CoachPanel key={`${projectId}:${nodeId}`} projectId={projectId} nodeId={nodeId} />
    {memory.data && <section className="card"><h2>最近回忆记录</h2>{memory.data.events.length === 0 ? <p className="muted">暂无回忆历史。</p> : memory.data.events.map(item => <p key={item.event_id}>{moment(item.reviewed_at)} · {label(item.rating)} · {item.memory_updated ? '已更新记忆' : '仅记录'} · 下次 {moment(item.due_at)}</p>)}</section>}
  </section>
}
