import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import { fetchCoachTurns, sendCoachTurn } from '../../api/study'
import type { RecallCoverage, RecallEventOut, RecallRating } from '../../api/study'
import { describeError, useToast } from '../../app/context'
import { Blocks } from '../../components/Content'
import type { BlockLike } from '../../components/Content'

export const moment = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—'
export const percent = (value: number | null | undefined) => value == null ? '未知' : `${Math.round(value * 100)}%`
export const ratings: Array<{ value: RecallRating; label: string }> = [
  { value: 'again', label: '1 忘记' }, { value: 'hard', label: '2 困难' },
  { value: 'good', label: '3 记得' }, { value: 'easy', label: '4 简单' },
]
const labels: Record<string, string> = {
  warmup: '热身回忆', insufficient_cycles: '样本周期不足', no_real_data: '暂无真实样本', ok: '正常', pending_review: '待人工复核', correct: '正确', incorrect: '未完全正确', unknown: '尚未判定',
  steps_total: '总步骤', steps_completed: '完成步骤', steps_skipped: '跳过步骤', recall_count: '回忆次数', rating_counts: '评级分布', memory_updates: '记忆更新次数', stability_gain: '稳定性变化', practice_items: '练习题数', practice_correct: '正确题数', practice_incorrect: '错误题数', practice_pending: '待评题数', errors: '错误记录', next_due: '下次到期', calibration: '信心校准', duration_minutes: '学习分钟数', rule_version: '规则版本',
  daily: '日常学习', quick_recall: '快速回忆', recall: '回忆', encode: '编码', encode_read: '阅读',
  self_explain: '自我解释', practice: '练习', repair: '修复', repair_brief: '最小讲解', repair_retest: '修复再测', transfer: '迁移',
  pending: '待开始', planned: '待开始', active: '进行中', in_progress: '进行中', completed: '已完成', done: '已完成',
  skipped: '已跳过', expired: '已超时', finished: '已结束', cancelled: '已取消', confirmed: '已确认', draft: '草稿',
  manual: '人工', ai: 'AI 草稿', generated: 'AI 草稿', insufficient: '样本不足', insufficient_data: '样本不足',
  single_choice: '单选题', multiple_choice: '多选题', true_false: '判断题', fill_blank: '填空题', constructed_response: '解答题',
  again: '忘记', hard: '困难', good: '记得', easy: '简单', ready: '就绪', new: '新考点', review: '复习',
}
export const label = (value: string | null | undefined) => value ? labels[value] ?? value : '暂无'
export const stepDone = (status: string) => ['completed', 'done', 'skipped', 'expired'].includes(status)
export const sessionDone = (status: string) => ['completed', 'finished', 'cancelled', 'expired'].includes(status)
export function studyError(error: unknown) {
  if (error instanceof ApiError && error.status === 409 && /session|active/i.test(error.code + error.message)) return `已有进行中的学习会话，请回学习台继续。${describeError(error)}`
  if (error instanceof ApiError && error.status === 404) return '未找到此学习内容，请检查当前项目，或返回学习台刷新。'
  return describeError(error)
}
export function ReadError({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div className="notice danger" role="alert">{studyError(error)} {retry && <button className="btn small" onClick={retry}>重试</button>}</div>
}
// A synchronous lock also guards two clicks before React commits disabled controls.
export function useStudyAction() {
  const lock = useRef(false)
  const live = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const toast = useToast()
  const qc = useQueryClient()
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  async function run(work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try { await work() }
    catch (err) { if (live.current) { setError(err); toast.push(studyError(err), 'error') } }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  async function invalidate(sessionId?: string) {
    await Promise.all(['study-desk', 'node-memory', 'node-card', 'coach', 'learning-session', 'current-learning-session'].map(key =>
      qc.invalidateQueries({ queryKey: key === 'learning-session' && sessionId ? [key, sessionId] : [key] })))
  }
  return { busy, error, run, invalidate, isCurrent: () => live.current }
}
export function PayloadBlocks({ value, projectId }: { value: unknown; projectId: string }) {
  const blocks = Array.isArray(value) ? value.filter((block): block is BlockLike => Boolean(block && typeof block === 'object' && typeof block.kind === 'string')) : []
  return <Blocks blocks={blocks} projectId={projectId} />
}
export function ReadOnlyFields({ value }: { value: Record<string, unknown> }) {
  if (!Object.keys(value).length) return null
  return <dl className="study-fields">{Object.entries(value).map(([key, val]) => <div key={key}><dt>{label(key)}</dt><dd>{typeof val === 'string' || typeof val === 'number' ? String(val) : JSON.stringify(val, null, 2)}</dd></div>)}</dl>
}
export function Coverage({ value, points = [] }: { value: RecallCoverage | null; points?: Array<{ id: string; text: string }> }) {
  if (!value) return <p className="notice info">尚无可用的覆盖检查结果，请根据自己的回忆选择评级；不会推断为零覆盖。</p>
  const text = (id: string) => points.find(p => p.id === id)?.text ?? id
  return <div data-testid="recall-coverage"><p>要点覆盖：{percent(value.coverage)}（不等于解题得分）</p>
    {([['已覆盖', value.covered], ['缺失', value.missing], ['无法判断', value.cannot_judge]] as const).map(([title, ids]) => <div key={title}><strong>{title}</strong><ul>{ids.length ? ids.map(id => <li key={id}>{text(id)}</li>) : <li className="muted">无</li>}</ul></div>)}
  </div>
}
export function RecallResult({ event }: { event: RecallEventOut }) {
  return <div className="notice info" data-testid="recall-result"><p>{event.memory_updated ? '记忆已更新' : '已记录回忆，未更新记忆排期'} · {label(event.rating)}</p><p>下次到期：{moment(event.due_at)} · 记忆 R {percent(event.retrievability)} · 稳定性 S {event.stability}</p>{event.early_review && <p>本次为提前复习。</p>}{event.notes.map((note, i) => <p key={i}>{note}</p>)}</div>
}
export function CoachPanel({ projectId, nodeId, sessionId, ordinal }: { projectId: string; nodeId: string; sessionId?: string; ordinal?: number }) {
  const [purpose, setPurpose] = useState('recall_check')
  const [message, setMessage] = useState('')
  const [availability, setAvailability] = useState('')
  const action = useStudyAction()
  const turns = useQuery({ queryKey: ['coach', projectId, nodeId, purpose], queryFn: () => fetchCoachTurns(projectId, nodeId, purpose) })
  return <section className="card coach-panel" data-testid="coach-panel"><h2>学习教练</h2>
    <p className="muted small">模型反馈仅为建议；评级由你确认。</p>
    <div className="row">{[['recall_check', '回忆检查'], ['hint', '提示'], ['misconception_probe', '错因追问'], ['self_explain_check', '自我解释检查']].map(([value, title]) => <button key={value} className={`btn small ${purpose === value ? 'primary' : 'ghost'}`} disabled={action.busy} onClick={() => { setPurpose(value); setAvailability('') }}>{title}</button>)}</div>
    {turns.isLoading && <p role="status">正在读取对话…</p>}
    {turns.isError && <ReadError error={turns.error} retry={() => void turns.refetch()} />}
    {turns.data?.length === 0 && <p className="muted">尚无此类对话。</p>}
    <div className="coach-turns">{turns.data?.map(turn => <article key={turn.turn_id} className="coach-turn"><strong>{turn.role === 'user' ? '你' : '教练'}</strong><p className="study-prewrap">{turn.text}</p><ReadOnlyFields value={turn.structured} />{turn.error_code && <p className="notice warn">{turn.error_code === 'ai_not_configured' ? 'AI 未配置，可使用人工自评。' : turn.error_message || turn.error_code}</p>}{turn.missing_information.length > 0 && <p>缺少信息：{turn.missing_information.join('、')}</p>}{turn.citations.length > 0 && <p className="small muted">来源：{turn.citations.join('；')}</p>}</article>)}</div>
    <label className="field"><span>给教练的说明（可选）</span><textarea value={message} disabled={action.busy} onChange={e => setMessage(e.target.value)} /></label>
    <button className="btn small" data-testid="coach-submit" disabled={action.busy} onClick={() => void action.run(async () => {
      const result = await sendCoachTurn(projectId, nodeId, { purpose, message: message.trim() || undefined, session_id: sessionId, step_ordinal: ordinal })
      setAvailability(result.model_used ? '本次已使用模型。' : result.availability_reason || '本次未使用模型。')
      setMessage('')
      await action.invalidate()
    })}>{action.busy ? '请求中…' : '发送给教练'}</button>
    {availability && <p className="notice info">{availability}</p>}{action.error != null && <ReadError error={action.error} />}
  </section>
}
