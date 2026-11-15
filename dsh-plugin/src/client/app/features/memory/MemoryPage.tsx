import { Fragment, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  createMemoryCard,
  fetchMemoryCardLogs,
  fetchMemoryCards,
  rebuildMemoryCard,
  resumeMemoryCard,
  reviewMemoryCard,
  suspendMemoryCard,
  type MemoryCardOut,
  type MemoryRating,
  type MemoryRebuildOut,
  type MemoryReviewOut,
  type QuestionListItem,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

const RATINGS: Array<{ value: MemoryRating; label: string; testId: string }> = [
  { value: 'again', label: '忘记', testId: 'memory-review-again' },
  { value: 'hard', label: '困难', testId: 'memory-review-hard' },
  { value: 'good', label: '记得', testId: 'memory-review-good' },
  { value: 'easy', label: '简单', testId: 'memory-review-easy' },
]

const RATING_LABELS: Record<string, string> = {
  again: '忘记',
  hard: '困难',
  good: '记得',
  easy: '简单',
}

const PHASE_LABELS: Record<string, string> = {
  new: '未学',
  learning: '学习中',
  review: '复习中',
  relearning: '重学中',
}

const CARD_LIMIT = 50

function moment(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

export function MemoryPage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [onlyDue, setOnlyDue] = useState(false)
  const [includeSuspended, setIncludeSuspended] = useState(false)
  const [createQuestionId, setCreateQuestionId] = useState('')
  const [createdCard, setCreatedCard] = useState<MemoryCardOut | null>(null)
  // One card's detail is shown at a time, so each result panel has exactly one
  // element on the page and "the last review" is never ambiguous.
  const [lastReview, setLastReview] = useState<{ cardId: string; result: MemoryReviewOut } | null>(null)
  const [lastRebuild, setLastRebuild] = useState<{ cardId: string; report: MemoryRebuildOut } | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  // Fixed at mount: a "due before" that changed on every render would refetch in
  // a loop and make the list impossible to read.
  const [dueBefore] = useState(() => new Date().toISOString())

  const projectId = currentProject?.id ?? null
  const projectKey = projectId ?? ''

  const cardsQuery = useQuery({
    queryKey: ['memory-cards', projectId, onlyDue, includeSuspended],
    queryFn: () =>
      fetchMemoryCards(projectKey, {
        dueBefore: onlyDue ? dueBefore : null,
        includeSuspended,
        limit: CARD_LIMIT,
      }),
    enabled: Boolean(projectId),
  })

  const questionsQuery = useQuery({
    queryKey: ['questions-for-memory', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<QuestionListItem[]>(
        `/projects/${projectId}/questions?limit=100&subject_id=${currentSubject?.id}`,
      ),
    enabled: Boolean(projectId && currentSubject),
  })

  const logsQuery = useQuery({
    queryKey: ['memory-logs', projectId, logsFor],
    queryFn: () => fetchMemoryCardLogs(projectKey, logsFor ?? '', 50),
    enabled: Boolean(projectId && logsFor),
  })

  const createCard = useMutation({
    mutationFn: (questionId: string) => createMemoryCard(projectKey, questionId),
    onSuccess: async (card) => {
      setCreatedCard(card)
      toast.push('记忆卡已就绪，可以开始复习', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['memory-cards'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const review = useMutation({
    mutationFn: (payload: { cardId: string; rating: MemoryRating }) =>
      reviewMemoryCard(projectKey, payload.cardId, payload.rating),
    onSuccess: async (result) => {
      setLastReview({ cardId: result.card_id, result })
      setLastRebuild((current) => (current && current.cardId === result.card_id ? null : current))
      toast.push(`已记录复习：${RATING_LABELS[result.rating] ?? result.rating}`, 'ok')
      await queryClient.invalidateQueries({ queryKey: ['memory-cards'] })
      await queryClient.invalidateQueries({ queryKey: ['memory-logs'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const rebuild = useMutation({
    mutationFn: (cardId: string) => rebuildMemoryCard(projectKey, cardId),
    onSuccess: (report, cardId) => setLastRebuild({ cardId, report }),
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const suspend = useMutation({
    mutationFn: (cardId: string) => suspendMemoryCard(projectKey, cardId, '人工暂停（记忆卡页）'),
    onSuccess: async () => {
      toast.push('记忆卡已暂停：排期保留，只是不再出现在待复习列表', 'info')
      await queryClient.invalidateQueries({ queryKey: ['memory-cards'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const resume = useMutation({
    mutationFn: (cardId: string) => resumeMemoryCard(projectKey, cardId),
    onSuccess: async () => {
      toast.push('记忆卡已恢复；过期时间没有被重置，逾期仍然是逾期', 'info')
      await queryClient.invalidateQueries({ queryKey: ['memory-cards'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  // Synchronous guard, not only the disabled attribute: two clicks inside one
  // render pass would otherwise both reach the network (with two fresh keys,
  // which the server would accept as two real reviews).
  const reviewInFlight = useRef(false)
  const requestReview = (cardId: string, rating: MemoryRating) => {
    if (reviewInFlight.current) return
    reviewInFlight.current = true
    review.mutate(
      { cardId, rating },
      {
        onSettled: () => {
          reviewInFlight.current = false
        },
      },
    )
  }

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  const cards = cardsQuery.data ?? []
  const publishedQuestions = (questionsQuery.data ?? []).filter((question) =>
    Boolean(question.published_version_id),
  )
  const dueCutoff = new Date(dueBefore).getTime()
  const busy = review.isPending || rebuild.isPending || suspend.isPending || resume.isPending

  return (
    <>
      <div className="page-title" data-testid="page-memory">
        <h1>记忆卡</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''}
        </span>
      </div>

      <div className="notice info" data-testid="memory-scope-note">
        记忆卡只反映记忆强度，不改变解题能力或考点掌握状态
      </div>
      <p className="small muted">
        评级只写入记忆卡的复习日志与下一次排期：它不生成作答证据、不改变考点状态，也不影响评分。
        到期时间由排期器按评级与历史计算；系统时间以服务器为准。
      </p>

      <div className="card" data-testid="memory-create">
        <h2>新建记忆卡</h2>
        <p className="small muted">
          每道题最多只有一张记忆卡。选择一道已发布题目即可建立或取回它的卡片，随后可以立即复习。
        </p>
        <div className="grid two">
          <label className="field">
            <span>题目（当前科目已发布）</span>
            <select
              data-testid="memory-create-question"
              value={createQuestionId}
              disabled={publishedQuestions.length === 0}
              onChange={(event) => setCreateQuestionId(event.target.value)}
            >
              {publishedQuestions.length === 0 ? <option value="">（没有已发布题目）</option> : null}
              {publishedQuestions.length > 0 && !createQuestionId ? <option value="">请选择</option> : null}
              {publishedQuestions.map((question) => (
                <option key={question.id} value={question.id}>
                  {question.display_label || question.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              className="btn primary"
              data-testid="memory-create-submit"
              disabled={!createQuestionId || createCard.isPending}
              onClick={() => {
                if (!createQuestionId) return
                createCard.mutate(createQuestionId)
              }}
            >
              建立记忆卡
            </button>
            {!currentSubject ? <span className="small muted">请先在上方选择科目。</span> : null}
          </div>
        </div>
        {createdCard ? (
          <div className="notice ok" data-testid="memory-create-result" style={{ marginTop: 10 }}>
            已就绪：{createdCard.question_label || '（无标签）'} · 阶段{' '}
            {PHASE_LABELS[createdCard.phase] ?? createdCard.phase} · 到期时间 {moment(createdCard.due_at)}
            {createdCard.due_at ? '（未到期的卡片也会保留在下方列表，可以提前复习）' : ''}
          </div>
        ) : null}
        {questionsQuery.isError ? (
          <div className="notice danger">题目列表读取失败：{describeError(questionsQuery.error)}</div>
        ) : null}
      </div>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>记忆卡（{cards.length}）</h2>
          <div className="row">
            <label className="small nowrap">
              <input
                type="checkbox"
                data-testid="memory-only-due"
                checked={onlyDue}
                onChange={(event) => setOnlyDue(event.target.checked)}
              />{' '}
              只看已到期
            </label>
            <label className="small nowrap">
              <input
                type="checkbox"
                data-testid="memory-include-suspended"
                checked={includeSuspended}
                onChange={(event) => setIncludeSuspended(event.target.checked)}
              />{' '}
              包含已暂停
            </label>
          </div>
        </div>
        {cardsQuery.isLoading ? <div className="empty-state">正在加载…</div> : null}
        {cardsQuery.isError ? (
          <div className="notice danger">记忆卡读取失败：{describeError(cardsQuery.error)}</div>
        ) : null}
        <div data-testid="memory-due-list">
          {!cardsQuery.isLoading && cards.length === 0 ? (
            <div className="empty-state">
              {onlyDue
                ? '当前没有已到期的记忆卡；可以取消「只看已到期」，或用上方「新建记忆卡」建立一张。'
                : '还没有记忆卡。用上方「新建记忆卡」选择一道已发布题目即可建立。'}
            </div>
          ) : cards.length > 0 ? (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>题目</th>
                    <th>考点</th>
                    <th>阶段 / 到期</th>
                    <th>记忆状态</th>
                    <th>复习</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((card) => {
                    const dueTime = card.due_at ? new Date(card.due_at).getTime() : null
                    const isDue = dueTime !== null && dueTime <= dueCutoff
                    const detail =
                      (lastReview && lastReview.cardId === card.card_id) ||
                      (lastRebuild && lastRebuild.cardId === card.card_id) ||
                      logsFor === card.card_id
                    return (
                      <Fragment key={card.card_id}>
                        <tr data-testid="memory-card-row">
                          <td>
                            <div>{card.question_label || '（无标签）'}</div>
                            <div className="tiny muted">{card.stem_excerpt || '（没有可展示的题干摘要）'}</div>
                          </td>
                          <td className="small">{card.knowledge_node_name || '未映射'}</td>
                          <td className="small">
                            <div>
                              {PHASE_LABELS[card.phase] ?? card.phase}
                              {card.is_suspended ? <span className="pill neutral">已暂停</span> : null}
                              {isDue ? <span className="pill warn">已到期</span> : <span className="pill neutral">未到期</span>}
                            </div>
                            <div className="tiny muted">到期：{moment(card.due_at)}</div>
                            <div className="tiny muted">上次复习：{moment(card.last_reviewed_at)}</div>
                          </td>
                          <td className="small">
                            <div>
                              稳定度 {card.stability.toFixed(2)} · 难度 {card.difficulty.toFixed(2)}
                            </div>
                            <div>
                              可提取性 {card.retrievability === null ? '—（尚未复习）' : card.retrievability.toFixed(2)}
                            </div>
                            <div className="tiny muted">
                              复习 {card.reps} 次 · 遗忘 {card.lapses} 次 · 排期器 {card.scheduler_version}
                            </div>
                          </td>
                          <td>
                            <div className="row">
                              {RATINGS.map((rating) => (
                                <button
                                  key={rating.value}
                                  className="btn small"
                                  data-testid={rating.testId}
                                  // Disabled while any review is in flight: a second
                                  // click can never double-review a card.
                                  disabled={busy || card.is_suspended}
                                  onClick={() => requestReview(card.card_id, rating.value)}
                                >
                                  {rating.label}
                                </button>
                              ))}
                            </div>
                            <div className="row">
                              <button
                                className="btn small ghost"
                                data-testid="memory-logs-toggle"
                                onClick={() => setLogsFor(logsFor === card.card_id ? null : card.card_id)}
                              >
                                {logsFor === card.card_id ? '收起日志' : '复习日志'}
                              </button>
                              <button
                                className="btn small ghost"
                                data-testid="memory-rebuild"
                                disabled={rebuild.isPending}
                                onClick={() => rebuild.mutate(card.card_id)}
                              >
                                重放校验
                              </button>
                              {card.is_suspended ? (
                                <button
                                  className="btn small ghost"
                                  data-testid="memory-resume"
                                  disabled={busy}
                                  onClick={() => resume.mutate(card.card_id)}
                                >
                                  恢复
                                </button>
                              ) : (
                                <button
                                  className="btn small ghost"
                                  data-testid="memory-suspend"
                                  disabled={busy}
                                  onClick={() => suspend.mutate(card.card_id)}
                                >
                                  暂停
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {detail ? (
                          <tr key={`${card.card_id}-detail`}>
                            <td colSpan={5} className="surface-subtle">
                              {lastReview && lastReview.cardId === card.card_id ? (
                                <div className="notice ok" data-testid="memory-next-due">
                                  <div>
                                    下次到期：{moment(lastReview.result.due_at)} · 间隔{' '}
                                    {lastReview.result.interval_days} 天 · 阶段{' '}
                                    {PHASE_LABELS[lastReview.result.phase_before] ?? lastReview.result.phase_before} →{' '}
                                    {PHASE_LABELS[lastReview.result.phase] ?? lastReview.result.phase}
                                  </div>
                                  <div className="small">
                                    评级 {RATING_LABELS[lastReview.result.rating] ?? lastReview.result.rating} ·{' '}
                                    {lastReview.result.is_lapse ? '记作一次遗忘' : '未记作遗忘'} · 复习{' '}
                                    {lastReview.result.reps} 次 · 日志 {lastReview.result.log_id.slice(0, 8)}
                                  </div>
                                </div>
                              ) : null}
                              {lastRebuild && lastRebuild.cardId === card.card_id ? (
                                <div
                                  className={lastRebuild.report.matches ? 'notice ok' : 'notice danger'}
                                  data-testid="memory-rebuild-result"
                                >
                                  {lastRebuild.report.matches
                                    ? '日志重放与当前状态一致'
                                    : `日志重放与当前状态不一致：${
                                        lastRebuild.report.differing_fields.join('、') || '（未列出差异字段）'
                                      }`}
                                  <div className="tiny">
                                    比对字段 {lastRebuild.report.compared_fields.length} 个 · 日志{' '}
                                    {lastRebuild.report.log_count} 条
                                    {lastRebuild.report.unknown_params_versions.length
                                      ? ` · 未知参数版本：${lastRebuild.report.unknown_params_versions.join('、')}`
                                      : ''}
                                  </div>
                                </div>
                              ) : null}
                              {logsFor === card.card_id ? (
                                <div data-testid="memory-logs">
                                  {logsQuery.isLoading ? <p className="muted">正在读取复习日志…</p> : null}
                                  {logsQuery.isError ? (
                                    <div className="notice danger">日志读取失败：{describeError(logsQuery.error)}</div>
                                  ) : null}
                                  {logsQuery.data?.length ? (
                                    <div className="table-scroll">
                                      <table className="data">
                                        <thead>
                                          <tr>
                                            <th>时间</th>
                                            <th>评级</th>
                                            <th>阶段</th>
                                            <th>间隔</th>
                                            <th>到期</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {logsQuery.data.map((log) => (
                                            <tr key={log.log_id}>
                                              <td className="small">{moment(log.reviewed_at)}</td>
                                              <td className="small">{RATING_LABELS[log.rating] ?? log.rating}</td>
                                              <td className="small">
                                                {PHASE_LABELS[log.phase_before] ?? log.phase_before} →{' '}
                                                {PHASE_LABELS[log.phase_after] ?? log.phase_after}
                                              </td>
                                              <td className="small">{log.interval_days} 天（排期 {log.scheduled_days} 天）</td>
                                              <td className="small">{moment(log.due_after)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : logsQuery.isSuccess ? (
                                    <p className="small muted">这张卡还没有复习日志。</p>
                                  ) : null}
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <p className="tiny muted">
          只显示最近 {CARD_LIMIT} 张卡（按到期时间排序）。暂停的卡片保留排期，但默认不参与复习。
        </p>
      </div>
    </>
  )
}
