import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiRequest, newIdempotencyKey, type EvidenceRow, type ReviewTaskRow } from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

const DIMENSION_LABELS: Record<string, string> = {
  repeat_practice: '重复练习',
  unassisted_completion: '无辅助完成',
  independent_correct: '严格独立正确',
  template_variant: '同模板变式',
  unseen_variant: '陌生变式',
  delayed_verification: '延迟验证',
}

export function ReviewPage() {
  const { currentProject, currentSubject } = useScope()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const projectId = currentProject?.id ?? null

  const reviewQuery = useQuery({
    queryKey: ['review-tasks', projectId],
    queryFn: () => apiRequest<{ now: string; rows: ReviewTaskRow[] }>(`/projects/${projectId}/review-tasks`),
    enabled: Boolean(projectId),
  })

  const evidenceQuery = useQuery({
    queryKey: ['evidence-mistakes', projectId, currentSubject?.id],
    queryFn: () => apiRequest<{ rows: EvidenceRow[] }>(`/projects/${projectId}/evidence?limit=200`),
    enabled: Boolean(projectId),
  })

  const startTask = useMutation({
    mutationFn: (taskId: string) =>
      apiRequest<{ create_session_hint: { subject_id: string; question_ids: string[]; task_id: string; purpose: string } }>(
        `/study-tasks/${taskId}/start`,
        { method: 'POST', idempotencyKey: newIdempotencyKey('task-start') },
      ),
    onSuccess: (data) => {
      const hint = data.create_session_hint
      const params = new URLSearchParams({ subject: hint.subject_id, task: hint.task_id, purpose: hint.purpose })
      hint.question_ids.forEach((id) => params.append('q', id))
      navigate(`/practice?${params.toString()}`)
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const reconcile = useMutation({
    mutationFn: (taskId: string) =>
      apiRequest(`/study-tasks/${taskId}/reconcile-delay`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('task-reconcile'),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['review-tasks', projectId] })
      toast.push('已按最新锚点重新核对延迟间隔', 'info')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  const rows = reviewQuery.data?.rows ?? []
  const failedRows = (evidenceQuery.data?.rows ?? []).filter(
    (row) => row.dimension === 'independent_correct' && row.qualifies && !row.is_correct,
  )
  const excludedRows = (evidenceQuery.data?.rows ?? []).filter((row) => !row.qualifies)

  return (
    <>
      <div className="page-title">
        <h1>错题与复习</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''}
        </span>
      </div>

      <div className="notice info">
        延迟验证只有在真实间隔满足要求时才可开始；中途查看讲解会刷新锚点，使未开始的任务向后顺延。
        没有合格的 C 题时系统只记重复练习证据，不会声称掌握了陌生题。
      </div>

      <div className="card">
        <h2>延迟验证任务（{rows.length}）</h2>
        {reviewQuery.data ? (
          <p className="tiny muted">服务器时间：{new Date(reviewQuery.data.now).toLocaleString()}</p>
        ) : null}
        {rows.length === 0 ? (
          <div className="empty-state">还没有延迟验证任务。完成一次基准题的讲解或确认评分后会自动生成。</div>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>题目</th>
                  <th>考点</th>
                  <th>延迟</th>
                  <th>锚点</th>
                  <th>可开始时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.task_id}>
                    <td className="small">{row.question_label || '（无题目）'}</td>
                    <td className="small">{row.knowledge_node_name || '—'}</td>
                    <td className="small">{row.delay_hours ? `${row.delay_hours} 小时` : '—'}</td>
                    <td className="small">
                      {row.delay_anchor_at ? new Date(row.delay_anchor_at).toLocaleString() : '—'}
                      {row.anchor_source ? <div className="tiny muted">{row.anchor_source}</div> : null}
                    </td>
                    <td className="small">
                      {row.not_before ? new Date(row.not_before).toLocaleString() : '—'}
                      {!row.due_now ? <div className="pill warn">未到期</div> : <div className="pill ok">可开始</div>}
                    </td>
                    <td className="small">
                      {row.status}
                      {row.deficit_notice ? <div className="tiny muted">{row.deficit_notice}</div> : null}
                    </td>
                    <td>
                      <div className="row">
                        <button
                          className="btn small primary"
                          disabled={!row.due_now || row.status === 'completed' || startTask.isPending}
                          onClick={() => startTask.mutate(row.task_id)}
                        >
                          开始验证
                        </button>
                        <button className="btn small" disabled={reconcile.isPending} onClick={() => reconcile.mutate(row.task_id)}>
                          重算间隔
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>已确认的失分（严格独立证据中未完全正确）</h2>
        {failedRows.length === 0 ? (
          <div className="empty-state">
            还没有这种记录。注意：待人工评分、自评、辅助作答与 AI 估计都不会出现在这里（它们不是错题也不是 0 分）。
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>考点</th>
                  <th>维度</th>
                  <th>得分比例</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {failedRows.map((row) => (
                  <tr key={row.id}>
                    <td className="small">{row.node_name ?? '—'}</td>
                    <td className="small">{DIMENSION_LABELS[row.dimension] ?? row.dimension}</td>
                    <td className="small">{row.score_fraction ?? '—'}</td>
                    <td className="small">{new Date(row.computed_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>未计入严格证据的作答（含排除原因）</h2>
        {excludedRows.length === 0 ? (
          <div className="empty-state">没有需要解释的排除项。</div>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>维度</th>
                  <th>排除原因</th>
                </tr>
              </thead>
              <tbody>
                {excludedRows.slice(0, 40).map((row) => (
                  <tr key={row.id}>
                    <td className="small">{DIMENSION_LABELS[row.dimension] ?? row.dimension}</td>
                    <td className="small">{row.exclusion_reasons.join('；') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="tiny muted">
          错误原因保持「未知」直到有真实依据；系统不会单凭一次选错就推断“粗心”或判定基础缺失。
        </p>
      </div>
    </>
  )
}
