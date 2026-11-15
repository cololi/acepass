import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../../api/client'
import type { PresentationOut } from '../../api/client'
import { activateLearningStep, answerLearningStep, completeLearningStep, confirmLearningRecall, fetchLearningSession, finishLearningSession, hintLearningStep, recallLearningStep, skipLearningStep, startLearningSession } from '../../api/study'
import type { AnswerStepResult, HintStepResult, RecallCoverage, RecallEventOut, RecallStepResult, SessionOut, SessionStepOut } from '../../api/study'
import { useScope } from '../../app/context'
import { Blocks } from '../../components/Content'
import { CoachPanel, Coverage, label, moment, PayloadBlocks, percent, ratings, ReadError, ReadOnlyFields, RecallResult, sessionDone, stepDone, useStudyAction } from './StudyShared'

export function SessionRunnerPage() {
  const { sessionId } = useParams()
  const { currentProject, currentSubject } = useScope()
  if (!currentProject || !sessionId) return <div className="card empty-state">请先选择会话所属项目。<Link to="/study">返回学习台</Link></div>
  return <SessionRunner key={`${currentProject.id}:${currentSubject?.id}:${sessionId}`} projectId={currentProject.id} sessionId={sessionId} />
}
function SessionRunner({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const query = useQuery({ queryKey: ['learning-session', sessionId, projectId], queryFn: () => fetchLearningSession(projectId, sessionId), refetchOnWindowFocus: true })
  const action = useStudyAction()
  const [selected, setSelected] = useState<number | null>(null)
  const [activation, setActivation] = useState<{ step: SessionStepOut; presentation?: PresentationOut } | null>(null)
  const [fallbackNote, setFallbackNote] = useState('')
  const session = query.data
  const steps = [...(session?.steps ?? [])].sort((a, b) => a.ordinal - b.ordinal)
  const current = steps.find(s => s.ordinal === (selected ?? session?.current_step_ordinal)) ?? steps.find(s => !stepDone(s.status)) ?? steps.at(-1)
  const closed = session ? sessionDone(session.status) : false
  const pending = steps.filter(s => !stepDone(s.status))
  const activated = current && activation?.step.ordinal === current.ordinal ? activation : null
  async function activate(ordinal: number) {
    if (!action.isCurrent()) return
    const result = await activateLearningStep(projectId, sessionId, ordinal)
    if (!action.isCurrent()) return
    setActivation(result)
    setSelected(ordinal)
    await action.invalidate(sessionId)
  }
  async function next(from: SessionStepOut, complete = false) {
    const nextStep = steps.find(s => s.ordinal > from.ordinal && !stepDone(s.status))
    if (complete) {
      try { await completeLearningStep(projectId, sessionId, from.ordinal) }
      catch (err) {
        if (!(err instanceof ApiError && err.status === 404) || !nextStep) throw err
        setFallbackNote('当前服务尚未提供阅读完成接口，已尝试激活下一步；完成状态以服务器为准。')
      }
    }
    if (nextStep) await activate(nextStep.ordinal)
    else await action.invalidate(sessionId)
  }
  return <section className="study-runner" data-testid="page-session-runner"><div className="page-title"><h1>学习会话</h1><Link to="/study">返回学习台</Link>{session && <span className="sub">{label(session.mode)} · {label(session.status)} · 预算 {session.budget_minutes} 分钟</span>}</div>
    {query.isLoading && <div className="card" role="status">正在读取会话…</div>}
    {query.isError && <ReadError error={query.error} retry={() => void query.refetch()} />}
    {action.error != null && <ReadError error={action.error} />}
    {fallbackNote && <p className="notice warn">{fallbackNote}</p>}
    {session && !closed && !session.started_at && <section className="card"><p>学习安排已生成，开始后进入第一个步骤。</p><button className="btn primary" disabled={action.busy} onClick={() => void action.run(async () => {
      const started = await startLearningSession(projectId, sessionId)
      const first = started.steps.find(s => s.ordinal === started.current_step_ordinal) ?? started.steps.find(s => !stepDone(s.status))
      if (first) await activate(first.ordinal)
      else await action.invalidate(sessionId)
    })}>开始会话</button></section>}
    {session && closed ? <SessionSummary session={session} /> : session && <>
      <div className="runner-layout"><aside className="card stage-rail" aria-label="学习阶段">
        {[...new Set(steps.map(s => s.stage))].map(stage => <div key={stage}><h2>{label(stage)}</h2>{steps.filter(s => s.stage === stage).map(s => <button key={s.ordinal} className={`runner-step-link ${current?.ordinal === s.ordinal ? 'row-selected' : ''}`} aria-current={current?.ordinal === s.ordinal ? 'step' : undefined} disabled={action.busy} onClick={() => { setSelected(s.ordinal); setActivation(null) }}><span>{s.ordinal}. {label(s.kind)}</span><span className="small muted">{s.node_name || s.question_label}</span><span className="pill neutral">{label(s.status)}</span></button>)}</div>)}
        {steps.length === 0 && <p className="muted">会话没有可用步骤。</p>}
      </aside><div className="runner-center">{current ? <section className="card"><h2>{label(current.kind)} · {current.node_name || current.question_label}</h2>
        {!stepDone(current.status) && !activated ? <><p>进入步骤后获取本次题目或回忆内容。</p><button className="btn primary" disabled={action.busy || !session.started_at} onClick={() => void action.run(() => activate(current.ordinal))}>进入此步骤</button></> : <StepInteraction key={current.ordinal} projectId={projectId} session={session} step={current} activatedStep={activated?.step} presentation={activated?.presentation} action={action} next={() => next(current)} complete={() => next(current, true)} />}
        {!stepDone(current.status) && session.started_at && <SkipStep busy={action.busy} onSkip={reason => void action.run(async () => { await skipLearningStep(projectId, sessionId, current.ordinal, reason); await action.invalidate(sessionId) })} />}
      </section> : <div className="card empty-state">暂无可进行的步骤。</div>}
      <button className="btn small ghost" disabled={action.busy || query.isFetching} onClick={() => void query.refetch()}>刷新会话结果</button>
      {pending.length === 0 && <button className="btn primary" data-testid="runner-finish" disabled={action.busy} onClick={() => void action.run(async () => { await finishLearningSession(projectId, sessionId); await action.invalidate(sessionId) })}>完成学习，查看摘要</button>}
      </div><details className="runner-dock" open><summary>考点上下文与教练</summary>{current?.node_id ? <><NodeContext step={activated?.step ?? current} projectId={projectId} />
        {['transfer', 'repair_retest'].includes(current.kind) || (current.kind === 'practice' && (!activated?.presentation?.tutoring_allowed || activated.presentation.grading_hidden)) ? <div className="card notice info">本步骤暂不提供教练提示；以服务器的独立作答与评分门禁为准。</div> : <CoachPanel key={`${current.node_id}:${current.ordinal}`} projectId={projectId} nodeId={current.node_id} sessionId={sessionId} ordinal={current.ordinal} />}
      </> : <div className="card empty-state">此步骤未关联考点。</div>}</details></div>
      {session.notes.map((note, i) => <p className="small muted" key={i}>{note}</p>)}
    </>}
  </section>
}
function SkipStep({ busy, onSkip }: { busy: boolean; onSkip: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return <details className="divider-top"><summary>暂时跳过</summary><label className="field"><span>跳过原因</span><input value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label><button className="btn small ghost" disabled={busy || !reason.trim()} onClick={() => onSkip(reason.trim())}>记录原因并跳过</button></details>
}
function SessionSummary({ session }: { session: SessionOut }) {
  return <section className="card" data-testid="session-summary"><h2>本次学习摘要</h2><p>完成 {session.steps.filter(s => ['completed', 'done'].includes(s.status)).length} / {session.steps.length} 步 · 跳过 {session.steps.filter(s => s.status === 'skipped').length} 步</p><p>开始 {moment(session.started_at)} · 结束 {moment(session.finished_at)}</p>{session.summary ? <ReadOnlyFields value={session.summary} /> : <p className="muted">服务器尚未提供详细摘要。</p>}<p className="small muted">模型反思属于学习建议，记忆变化与评分以服务器记录为准。</p>{session.notes.map((note, i) => <p key={i}>{note}</p>)}<div className="row"><Link className="btn primary" to="/study">返回学习台</Link>{[...new Map(session.steps.filter(s => s.node_id).map(s => [s.node_id!, s])).values()].map(s => <Link key={s.node_id} to={`/study/nodes/${encodeURIComponent(s.node_id!)}`}>{s.node_name || '考点详情'}</Link>)}</div></section>
}
function NodeContext({ step, projectId }: { step: SessionStepOut; projectId: string }) {
  const payload = step.payload
  const memory = payload.memory && typeof payload.memory === 'object' ? payload.memory as Record<string, unknown> : null
  return <section className="card"><h2>{step.node_name || '当前考点'}</h2>{step.node_id && <Link to={`/study/nodes/${encodeURIComponent(step.node_id)}`}>查看考点详情</Link>}
    {payload.frequency != null && <ReadOnlyFields value={{ 考频: payload.frequency }} />}
    {payload.counted_cycles != null && <p>考频 {String(payload.cycles_present ?? payload.appearances ?? '未知')}/{String(payload.counted_cycles)} 周期</p>}
    {!memory && payload.retrievability != null && <p>记忆 R {percent(typeof payload.retrievability === 'number' ? payload.retrievability : null)} · S {String(payload.stability ?? '未知')}</p>}
    {memory && <p>记忆 R {percent(typeof memory.retrievability === 'number' ? memory.retrievability : null)} · S {String(memory.stability ?? '未知')}</p>}
    {payload.prerequisites != null && <ReadOnlyFields value={{ 前置考点: payload.prerequisites }} />}
    {step.kind !== 'recall' && step.kind !== 'self_explain' && !['transfer', 'repair_retest', 'practice'].includes(step.kind) && payload.card != null && <PayloadBlocks value={(payload.card as Record<string, unknown>).blocks} projectId={projectId} />}
  </section>
}
type Action = ReturnType<typeof useStudyAction>
function StepInteraction({ projectId, session, step, activatedStep, presentation, action, next, complete }: { projectId: string; session: SessionOut; step: SessionStepOut; activatedStep?: SessionStepOut; presentation?: PresentationOut; action: Action; next: () => Promise<void>; complete: () => Promise<void> }) {
  const payload = activatedStep?.payload ?? step.payload
  const [text, setText] = useState('')
  const [confidence, setConfidence] = useState(3)
  const [startedAt] = useState(Date.now)
  // Server-saved recall drafts let a learner confirm after a reload without resubmitting.
  const [recall, setRecall] = useState<RecallStepResult | null>(() => {
    const draft = payload.recall_draft
    if (!draft || typeof draft !== 'object' || stepDone(step.status)) return null
    const saved = draft as Record<string, unknown>
    const coverage = saved.coverage as RecallCoverage | null
    return {
      step, coach_turn: null,
      recall: {
        event: null,
        coverage: coverage ?? { covered: [], missing: [], cannot_judge: [], coverage: null },
        key_points: Array.isArray(saved.key_points) ? saved.key_points as RecallStepResult['recall']['key_points'] : [],
        suggested_rating: typeof saved.suggested_rating === 'string' ? saved.suggested_rating : null,
        can_confirm: true,
      },
    }
  })
  const [event, setEvent] = useState<RecallEventOut | null>(null)
  const done = stepDone(step.status)
  const isRecall = step.kind === 'recall' || step.kind === 'self_explain'
  const isPractice = ['practice', 'repair_retest', 'transfer'].includes(step.kind)
  const card = payload.card && typeof payload.card === 'object' ? payload.card as Record<string, unknown> : null
  return <div data-testid={`runner-step-${step.kind}`}>
    {isRecall && <><p className="runner-prompt">{typeof payload.prompt === 'string' ? payload.prompt : step.kind === 'recall' ? '先别看答案，写下你能回忆的。' : '用自己的话解释为什么，以及什么时候不适用。'}</p>
      {!done && !recall && !event && <><label className="field"><span>你的{step.kind === 'recall' ? '回忆' : '解释'}</span><textarea className="runner-recall-input" value={text} disabled={action.busy} onChange={e => setText(e.target.value)} /></label><label className="field"><span>回忆前信心（1–5）</span><select value={confidence} disabled={action.busy} onChange={e => setConfidence(Number(e.target.value))}>{[1, 2, 3, 4, 5].map(n => <option key={n}>{n}</option>)}</select></label><button className="btn primary" data-testid="runner-recall-submit" disabled={action.busy || !text.trim()} onClick={() => void action.run(async () => {
        const result = await recallLearningStep(projectId, session.session_id, step.ordinal, { text: text.trim(), confidence_before: confidence, latency_ms: Date.now() - startedAt })
        setRecall(result); setEvent(result.recall.event)
        await action.invalidate(session.session_id)
      })}>提交并检查回忆</button></>}
      {recall && <><Coverage value={recall.recall.coverage} points={recall.recall.key_points} /><p>建议评级：{label(recall.recall.suggested_rating)}</p>{recall.coach_turn && <p className="study-prewrap">{recall.coach_turn.text || recall.coach_turn.error_message}</p>}
        {!event && !done && recall.recall.can_confirm && <><p>调整评级并确认（1–4）</p><div className="row">{ratings.map(r => <button key={r.value} className="btn small" data-testid={`runner-rating-${r.value}`} disabled={action.busy} onClick={() => void action.run(async () => { const result = await confirmLearningRecall(projectId, session.session_id, step.ordinal, { rating: r.value, coverage: recall.recall.coverage ?? undefined }); setEvent(result.event); await action.invalidate(session.session_id) })}>{r.label}</button>)}</div></>}
        {!event && !done && !recall.recall.can_confirm && <p className="notice warn">服务器尚不允许确认评级，请查看检查结果或暂时跳过。</p>}
      </>}{event && <RecallResult event={event} />}
      {!recall && !event && done && <p>此步骤{label(step.status)}。{step.outcome ? `结果：${label(step.outcome)}` : ''} 可在考点详情查看记忆记录。</p>}
    </>}
    {['encode_read', 'repair_brief'].includes(step.kind) && <><PayloadBlocks value={card?.blocks ?? payload.blocks ?? payload.brief_blocks ?? (payload.brief && typeof payload.brief === 'object' ? (payload.brief as Record<string, unknown>).blocks : undefined)} projectId={projectId} />
      {Array.isArray(card?.key_points ?? payload.key_points) && <ul>{((card?.key_points ?? payload.key_points) as Array<Record<string, unknown>>).map((point, i) => <li key={i}>{String(point.text ?? '')}</li>)}</ul>}
      {!done && <button className="btn primary" disabled={action.busy} onClick={() => void action.run(complete)}>{step.kind === 'encode_read' ? '我读完了，进入回忆' : '理解了，再试一道'}</button>}
    </>}
    {isPractice && <PracticeStep key={`${step.ordinal}:${presentation?.session_item_id ?? 'none'}`} projectId={projectId} session={session} step={step} presentation={presentation} action={action} />}
    {!isRecall && !isPractice && !['encode_read', 'repair_brief'].includes(step.kind) && <p className="notice warn">暂不支持的步骤类型：{step.kind}。可以记录原因后跳过。</p>}
    {done && <div className="divider-top"><span className="pill neutral">{label(step.status)}</span> <button className="btn small" disabled={action.busy} onClick={() => void action.run(next)}>进入下一步</button></div>}
  </div>
}
function Countdown({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const seconds = Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000))
  return <p className="notice warn">服务端计时：{Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '请以服务端为准'}<span className="small">（此处为本机估算，提交是否超时由服务端判定）</span></p>
}
function PracticeStep({ projectId, session, step, presentation, action }: { projectId: string; session: SessionOut; step: SessionStepOut; presentation?: PresentationOut; action: Action }) {
  const type = presentation?.stem.question_type
  const [selected, setSelected] = useState<string[]>([])
  const [truth, setTruth] = useState<boolean | null>(null)
  const [blanks, setBlanks] = useState<Record<string, string>>(() => Object.fromEntries((presentation?.stem.blank_ids ?? []).map(id => [id, ''])))
  const [confidence, setConfidence] = useState('unsure')
  const [startedAt] = useState(Date.now)
  const [answerResult, setAnswerResult] = useState<AnswerStepResult | null>(null)
  const [hint, setHint] = useState<HintStepResult | null>(null)
  const done = stepDone(step.status)
  const grade = answerResult?.grade
  const locked = action.busy || done || !!answerResult
  const supported = ['single_choice', 'multiple_choice', 'true_false', 'fill_blank'].includes(type ?? '')
  const hasAnswer = type === 'true_false' ? truth !== null : type === 'fill_blank' ? Object.values(blanks).some(v => v.trim()) : selected.length > 0
  const isHintable = ['practice', 'repair_retest'].includes(step.kind) && Boolean(presentation?.tutoring_allowed) && !presentation?.grading_hidden
  const workbench = session.practice_session_id ? `/practice?${new URLSearchParams({ project: projectId, subject: session.subject_id, session: session.practice_session_id })}` : null
  return <div>{step.kind === 'transfer' && step.deadline_at && <Countdown deadline={step.deadline_at} />}
    {presentation ? <>{presentation.stem.material && <div className="surface-subtle card"><h3>共享材料</h3><Blocks blocks={presentation.stem.material.blocks} projectId={projectId} /></div>}<Blocks blocks={presentation.stem.blocks} projectId={projectId} />
      {!done && <><fieldset className="study-answer" disabled={locked}><legend>{label(type)} · 满分 {presentation.max_score}</legend>
        {(type === 'single_choice' || type === 'multiple_choice') && <div className="option-list">{presentation.stem.options.map(option => <label key={option.id} className={`option ${selected.includes(option.id) ? 'selected' : ''}`}><input type={type === 'single_choice' ? 'radio' : 'checkbox'} name={`study-option-${step.ordinal}`} checked={selected.includes(option.id)} onChange={() => setSelected(current => type === 'single_choice' ? [option.id] : current.includes(option.id) ? current.filter(id => id !== option.id) : [...current, option.id])} /><span>{option.label}. <Blocks blocks={option.blocks} projectId={projectId} /></span></label>)}</div>}
        {type === 'true_false' && <div className="row">{[true, false].map(value => <label key={String(value)}><input type="radio" name={`study-truth-${step.ordinal}`} checked={truth === value} onChange={() => setTruth(value)} />{value ? '正确' : '错误'}</label>)}</div>}
        {type === 'fill_blank' && presentation.stem.blanks.map(blank => <label key={blank.blank_id} className="field"><span>{blank.label}</span><input value={blanks[blank.blank_id] ?? ''} onChange={e => setBlanks(current => ({ ...current, [blank.blank_id]: e.target.value }))} /></label>)}
        {type === 'constructed_response' && (workbench ? <Link className="btn" to={workbench}>在刷题工作台作答</Link> : <p className="notice warn">服务器尚未关联刷题会话，暂不能跳转作答。</p>)}
        {!supported && type !== 'constructed_response' && <p className="notice warn">暂不支持此题型，请使用刷题工作台。</p>}
        {supported && <label className="field"><span>作答信心</span><select value={confidence} onChange={e => setConfidence(e.target.value)}><option value="unsure">不确定</option><option value="sure">确定</option><option value="guess">猜测</option></select></label>}
      </fieldset>{supported && <button className="btn primary" data-testid="runner-answer-submit" disabled={locked || !hasAnswer} onClick={() => void action.run(async () => {
        const answer = type === 'true_false' ? { type, value: truth } : type === 'fill_blank' ? { type, blanks } : { type, selected_option_ids: selected }
        const result = await answerLearningStep(projectId, session.session_id, step.ordinal, { answer, confidence, client_active_ms: Date.now() - startedAt })
        setAnswerResult(result)
        await action.invalidate(session.session_id)
      })}>提交作答</button>}</>}
    </> : <p className="muted">{done ? '此题已处理，结果以服务端记录为准。' : '服务器未返回题目呈现，请刷新会话并重新进入步骤。'}</p>}
    {workbench && <p className="small"><Link to={workbench}>打开刷题工作台</Link> · 返回后刷新会话同步作答结果。</p>}
    {done && !answerResult && <p className="notice info">步骤结果：{label(step.outcome)}。详细评分请在刷题工作台查看。</p>}
    {answerResult && (answerResult.receipt_only ? <p className="notice info">已收到作答，当前阶段暂不公开评分。</p> : grade ? <div className="notice info" data-testid="runner-grade"><p>已确认 {grade.confirmed_score ?? '待评'} / {grade.max_score} · 待评上限 {grade.pending_max_score}</p><p>{!grade.is_fully_confirmed ? '仍有内容待人工复核，未确认部分不计为零分。' : grade.is_correct ? '完全正确' : '本题未完全正确，请查看修复步骤。'}</p></div> : <p className="notice info">已提交，评分处理中，请刷新会话。</p>)}
    {isHintable && <div className="divider-top"><p>提示阶梯（提示会记为辅助暴露，之后的重做不算独立证据）</p><div className="row">{[1, 2, 3].map(level => <button className="btn small" disabled={action.busy || done} key={level} onClick={() => void action.run(async () => { setHint(await hintLearningStep(projectId, session.session_id, step.ordinal, level)); await action.invalidate(session.session_id) })}>提示 {level}</button>)}</div></div>}
    {hint && <section className="card surface-subtle"><p>{hint.model_used ? '模型提示' : '规则提示'}{hint.reveals_answer ? ' · 包含答案信息' : ''}</p><PayloadBlocks value={hint.blocks} projectId={projectId} />{hint.fallback_note && <p className="notice info">{hint.fallback_note}</p>}</section>}
  </div>
}
