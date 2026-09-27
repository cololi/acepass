import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiRequest, newIdempotencyKey, type AiRunRow, type AiStatus, type ReportOut } from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

const BUCKET_LABELS: Record<string, string> = {
  fully_confirmed: '完整确认（可作为能力证据）',
  strict_independent: '严格独立正确',
  partially_pending: '部分待确认',
  pending_review: '待人工评分',
  self_assessed: '自评确认（单列）',
  assisted: '辅助作答（单列）',
  repeat_practice: '重复练习（含看过答案）',
  ai_estimated: 'AI 估计（不进入正式分）',
}

export function ReportsPage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [regradeReason, setRegradeReason] = useState('')

  const projectId = currentProject?.id ?? null

  const reportQuery = useQuery({
    queryKey: ['report', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<ReportOut>(
        `/projects/${projectId}/reports/practice${currentSubject ? `?subject_id=${currentSubject.id}` : '?save_snapshot=true'}`,
      ),
    enabled: Boolean(projectId),
  })

  const coverageQuery = useQuery({
    queryKey: ['coverage', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<{ coverage_note: string; papers: Array<Record<string, unknown>> }>(
        `/projects/${projectId}/papers/coverage?subject_id=${currentSubject?.id}`,
      ),
    enabled: Boolean(projectId && currentSubject),
  })

  const aiRunsQuery = useQuery({
    queryKey: ['ai-runs', projectId],
    queryFn: () => apiRequest<AiRunRow[]>(`/projects/${projectId}/ai-runs?limit=20`),
    enabled: Boolean(projectId),
  })

  const aiStatusQuery = useQuery({
    queryKey: ['ai-status', projectId],
    queryFn: () => apiRequest<AiStatus>(`/projects/${projectId}/ai-status`),
    enabled: Boolean(projectId),
  })

  const reviewAnswersQuery = useQuery({
    queryKey: ['answer-reviews', projectId],
    queryFn: () =>
      apiRequest<Array<Record<string, unknown>>>(`/projects/${projectId}/answer-reviews`),
    enabled: Boolean(projectId),
  })

  const startRegrade = useMutation({
    mutationFn: (payload: { question_id: string; answer_key_version_id: string }) =>
      apiRequest<{ regrade_run_id: string }>(`/projects/${projectId}/regrades`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('regrade'),
        body: {
          question_id: payload.question_id,
          target_answer_key_version_id: payload.answer_key_version_id,
          reason: regradeReason || '答案修正后重判',
          scope: 'all_attempts',
        },
      }),
    onSuccess: async (run) => {
      await apiRequest(`/projects/${projectId}/regrades/${run.regrade_run_id}/run`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('regrade-run'),
      })
      toast.push('重判已执行：原始作答与旧判分保留，仅新增覆盖事件且只计一次', 'ok')
      setRegradeReason('')
      await queryClient.invalidateQueries({ queryKey: ['report', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['answer-reviews', projectId] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  const report = reportQuery.data

  return (
    <>
      <div className="page-title">
        <h1>报告</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''} · 计算版本 {report?.calculation_version ?? '—'}
        </span>
      </div>

      <div className="notice info">
        P0 报告只呈现练习证据与已确认得分：完整确认、待人工评分、自评、辅助作答、重复练习与 AI 估计分别列出，
        不合并成一个“官方分数”，也不给出通过概率。
      </div>

      {reportQuery.isLoading ? <div className="card empty-state">统计数据中…</div> : null}
      {reportQuery.isError ? <div className="notice danger">{describeError(reportQuery.error)}</div> : null}

      {report ? (
        <>
          <div className="card">
            <h2>作答分类</h2>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>类别</th>
                    <th>作答次数</th>
                    <th>已确认分</th>
                    <th>满分</th>
                    <th>待评分值</th>
                    <th>确认比例</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(report.totals).map(([key, bucket]) => (
                    <tr key={key}>
                      <td>{BUCKET_LABELS[key] ?? key}</td>
                      <td>{bucket.attempts}</td>
                      <td>{bucket.confirmed_score}</td>
                      <td>{bucket.max_score}</td>
                      <td>{bucket.pending_max_score}</td>
                      <td>{bucket.confirmed_fraction ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.notes.length ? (
              <ul className="small muted">
                {report.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="grid two">
            <div className="card">
              <h2>按题型</h2>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>题型</th>
                      <th>次数</th>
                      <th>确认分</th>
                      <th>待评</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(report.by_question_type).map(([type, bucket]) => (
                      <tr key={type}>
                        <td className="small">{type}</td>
                        <td>{bucket.attempts}</td>
                        <td>
                          {bucket.confirmed_score} / {bucket.max_score}
                        </td>
                        <td>{bucket.pending_max_score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h2>按考点</h2>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>考点</th>
                      <th>权重</th>
                      <th>次数</th>
                      <th>确认分 / 满分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(report.by_knowledge_node).map(([nodeId, bucket]) => (
                      <tr key={nodeId}>
                        <td className="small">{bucket.node_name}</td>
                        <td className="small">{bucket.weight}</td>
                        <td>{bucket.attempts}</td>
                        <td>
                          {bucket.confirmed_score} / {bucket.max_score}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tiny muted">多考点题按显式权重拆分，父材料题不重复计分；未分类分值单独保留。</p>
            </div>
          </div>

          <div className="card">
            <h2>被排除的证据（{report.excluded_evidence.length}）</h2>
            {report.excluded_evidence.length === 0 ? (
              <p className="muted small">没有排除项。</p>
            ) : (
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>维度</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.excluded_evidence.slice(0, 25).map((row, index) => (
                      <tr key={index}>
                        <td className="small">{row.dimension}</td>
                        <td className="small">{row.reasons.join('；')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      <div className="card">
        <h2>真实试卷覆盖登记</h2>
        <p className="small muted">{coverageQuery.data?.coverage_note ?? coverageQuery.data?.coverage_note}</p>
        {coverageQuery.data?.papers.length ? (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>周期</th>
                  <th>卷别</th>
                  <th>来源</th>
                  <th>覆盖</th>
                  <th>题项</th>
                  <th>总分</th>
                </tr>
              </thead>
              <tbody>
                {coverageQuery.data.papers.map((paper) => (
                  <tr key={String(paper.paper_id)}>
                    <td className="small">{String(paper.cycle_key)}</td>
                    <td className="small">{String(paper.paper_code)}</td>
                    <td className="small">
                      {String(paper.source_kind)}
                      {paper.is_demo ? <span className="pill warn" style={{ marginLeft: 6 }}>演示</span> : null}
                    </td>
                    <td className="small">{String(paper.coverage_status)}</td>
                    <td>{String(paper.scored_item_count)}</td>
                    <td>{String(paper.total_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">该科目还没有登记真实试卷发生记录。</p>
        )}
      </div>

      <div className="card">
        <h2>答案核对与重判</h2>
        <div className="notice warn">
          答案从「已核对」变为「有争议」时，受影响的历史判分会转为待复核，原始作答保留；题干变化不会机械地用新答案重判旧作答。
        </div>
        {reviewAnswersQuery.data?.length ? (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>题号</th>
                  <th>状态</th>
                  <th>来源</th>
                  <th>核对依据</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {reviewAnswersQuery.data.map((row) => (
                  <tr key={String(row.answer_key_version_id)}>
                    <td className="small">{String(row.display_label ?? '')}</td>
                    <td className="small">
                      {String(row.verification_status)}
                      {row.is_disputed ? <span className="pill danger">争议</span> : null}
                    </td>
                    <td className="small">{String(row.source_type)}</td>
                    <td className="small">{String(row.check_basis ?? '') || '（未填写）'}</td>
                    <td>
                      <button
                        className="btn small"
                        disabled={startRegrade.isPending || String(row.verification_status) !== 'checked'}
                        onClick={() =>
                          startRegrade.mutate({
                            question_id: String(row.question_id),
                            answer_key_version_id: String(row.answer_key_version_id),
                          })
                        }
                        title={
                          String(row.verification_status) === 'checked'
                            ? '以该已核对答案重判历史作答'
                            : '只有已核对且无争议的答案才能作为重判目标'
                        }
                      >
                        以此答案重判
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">所有已录入答案都已核对。</p>
        )}
        <label className="field" style={{ marginTop: 10 }}>
          <span>重判原因（必填，会写入审计）</span>
          <input value={regradeReason} onChange={(event) => setRegradeReason(event.target.value)} placeholder="例如：标准答案第 12 题修正为 C" />
        </label>
      </div>

      <div className="card">
        <h2>模型调用与费用审计</h2>
        <p className="small muted">
          当前 provider：{aiStatusQuery.data?.provider ?? '—'} ·{' '}
          {aiStatusQuery.data?.configured ? (aiStatusQuery.data.is_stub ? '测试/演示 stub' : '真实 provider') : '未配置'}
          {' · '}
          {aiStatusQuery.data?.message}
        </p>
        {aiRunsQuery.data?.length ? (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>能力</th>
                  <th>提供商/模型</th>
                  <th>提示词</th>
                  <th>状态</th>
                  <th>用量</th>
                  <th>费用</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {aiRunsQuery.data.map((run) => (
                  <tr key={run.id}>
                    <td className="small">{new Date(run.created_at).toLocaleString()}</td>
                    <td className="small">{run.capability}</td>
                    <td className="small">
                      {run.provider}/{run.model || '—'}
                      {run.is_stub ? <span className="pill warn">stub</span> : null}
                    </td>
                    <td className="small">{run.prompt_version}</td>
                    <td className="small">{run.status}</td>
                    <td className="small">
                      {run.prompt_tokens ?? '—'}/{run.completion_tokens ?? '—'}
                    </td>
                    <td className="small">{run.cost_known ? `${run.cost_cents ?? '0'} 分` : '未知'}</td>
                    <td className="small">{run.latency_ms ? `${run.latency_ms} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">还没有模型调用记录。</p>
        )}
      </div>
    </>
  )
}
