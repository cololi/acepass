import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  apiRequest,
  newIdempotencyKey,
  type EvidenceRow,
  type MistakeRow,
  type ReviewTaskRow,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { ExposurePanel, ExposureToggle } from '../questions/ExposurePanel'

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
  /**
   * C04 also belongs here: a mistake row carries a question context, so the same
   * exposure explanation answers 「为什么这道题的证据不算严格独立」.
   */
  const [exposureQuestionId, setExposureQuestionId] = useState<string | null>(null)

  const subjectQuery = currentSubject ? `?subject_id=${currentSubject.id}` : ''

  const reviewQuery = useQuery({
    queryKey: ['review-tasks', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<{ now: string; rows: ReviewTaskRow[] }>(
        `/projects/${projectId}/review-tasks${subjectQuery}`,
      ),
    enabled: Boolean(projectId),
  })

  const evidenceQuery = useQuery({
    queryKey: ['evidence-mistakes', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<{ rows: EvidenceRow[] }>(
        `/projects/${projectId}/evidence?limit=200${currentSubject ? `&subject_id=${currentSubject.id}` : ''}`,
      ),
    enabled: Boolean(projectId),
  })

  // A mistake is a *confirmed* lost mark, which the evidence projection cannot
  // express: an exclude-everything row (self-assessed, assisted) is not a
  // mistake, and a fully graded wrong answer is not "excluded" either.
  const mistakesQuery = useQuery({
    queryKey: ['mistakes', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<{ rows: MistakeRow[] }>(`/projects/${projectId}/mistakes${subjectQuery}`),
    enabled: Boolean(projectId),
  })

  const startTask = useMutation({
    mutationFn: (row: ReviewTaskRow) =>
      apiRequest<{
        create_session_hint: { subject_id: string; question_ids: string[]; task_id: string; purpose: string }
      }>(`/study-tasks/${row.task_id}/start`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('task-start'),
      }).then((data) => ({ ...data, projectId: row.project_id })),
    onSuccess: (data) => {
      const hint = data.create_session_hint
      const params = new URLSearchParams({
        project: data.projectId,
        subject: hint.subject_id,
        task: hint.task_id,
        purpose: hint.purpose,
      })
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
  const mistakes = mistakesQuery.data?.rows ?? []
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
        C 的等待时间从刚完成的 B 作答开始计算。没有合格的 C 题时系统只记重复练习证据，不会声称掌握了陌生题。
      </div>
      {reviewQuery.isError ? (
        <div className="notice danger">{describeError(reviewQuery.error)}</div>
      ) : null}
      {evidenceQuery.isError ? (
        <div className="notice danger">{describeError(evidenceQuery.error)}</div>
      ) : null}

      <div className="card">
        <h2>延迟验证任务（{rows.length}）</h2>
        {reviewQuery.data ? (
          <p className="tiny muted">服务器时间：{new Date(reviewQuery.data.now).toLocaleString()}</p>
        ) : null}
        {reviewQuery.isLoading ? (
          <div className="empty-state">正在加载…</div>
        ) : reviewQuery.isError ? (
          <div className="notice danger">延迟验证任务加载失败：{describeError(reviewQuery.error)}</div>
        ) : rows.length === 0 ? (
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
                          onClick={() => startTask.mutate(row)}
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
        <h2>已确认的错题（{mistakes.length}）</h2>
        <p className="small muted">
          只有全部评分点都已确认、且未达到满分的作答才算错题。待人工评分、自评、辅助作答与 AI
          估计都不会出现在这里（它们既不是错题也不是 0 分）。
        </p>
        {mistakesQuery.isError ? (
          <div className="notice danger">{describeError(mistakesQuery.error)}</div>
        ) : mistakes.length === 0 ? (
          <div className="empty-state">还没有已确认的错题。</div>
        ) : (
          <div className="table-scroll">
            <table className="data" data-testid="mistake-table">
              <thead>
                <tr>
                  <th>题目</th>
                  <th>题型</th>
                  <th>得分</th>
                  <th>失分</th>
                  <th>时间</th>
                  <th>严格独立</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {mistakes.map((row) => (
                  <Fragment key={row.attempt_id}>
                    <tr>
                      <td className="small">{row.display_label || row.question_id.slice(0, 8)}</td>
                      <td className="small">{row.question_type}</td>
                      <td className="small">
                        {row.confirmed_score} / {row.max_score}
                      </td>
                      <td className="small">{row.lost_score}</td>
                      <td className="small">{new Date(row.submitted_at).toLocaleString()}</td>
                      <td>
                        <ExposureToggle
                          open={exposureQuestionId === row.question_id}
                          onToggle={() =>
                            setExposureQuestionId((current) =>
                              current === row.question_id ? null : row.question_id,
                            )
                          }
                        />
                      </td>
                      <td className="small">
                        {row.can_tutor ? (
                          <button
                            className="btn small"
                            onClick={() =>
                              navigate(
                                `/practice?subject=${row.subject_id}&session=${row.session_id}&item=${row.session_item_id}`,
                              )
                            }
                          >
                            查看作答与辅导
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                    {exposureQuestionId === row.question_id ? (
                      <tr>
                        <td colSpan={7} style={{ padding: 0, background: '#fbfcfe' }}>
                          <ExposurePanel questionId={row.question_id} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>未计入严格证据的作答（含排除原因）</h2>
        {evidenceQuery.isLoading ? (
          <div className="empty-state">正在加载…</div>
        ) : evidenceQuery.isError ? (
          <div className="notice danger">证据加载失败：{describeError(evidenceQuery.error)}</div>
        ) : excludedRows.length === 0 ? (
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
