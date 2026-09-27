import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiRequest, newIdempotencyKey, type ImportJobOut } from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  processing: '处理中',
  awaiting_review: '待校对',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function ImportsPage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const selectedJobId = params.get('job')
  const [fileError, setFileError] = useState('')

  const projectId = currentProject?.id ?? null

  const jobsQuery = useQuery({
    queryKey: ['imports', projectId],
    queryFn: () => apiRequest<ImportJobOut[]>(`/projects/${projectId}/imports?limit=50`),
    enabled: Boolean(projectId),
  })

  const uploadImage = useMutation({
    mutationFn: async (files: FileList) => {
      const form = new FormData()
      Array.from(files).forEach((file) => form.append('files', file))
      if (currentSubject) form.append('subject_id', currentSubject.id)
      form.append('title', '图片导入')
      form.append('role', 'past_paper_page')
      return apiRequest<ImportJobOut>(`/projects/${projectId}/imports/images`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('import-images'),
        formData: form,
      })
    },
    onSuccess: async (job) => {
      toast.push('图片已作为私有来源保存，请在校对页对照原图录入结构', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      navigate(`/imports?job=${job.id}`)
    },
    onError: (err) => setFileError(describeError(err)),
  })

  const retry = useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<ImportJobOut>(`/projects/${projectId}/imports/${jobId}/retry`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('import-retry'),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      toast.push('已重试（复用原有来源与候选，不会重复创建）', 'ok')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const candidatesQuery = useQuery({
    queryKey: ['candidates', projectId, selectedJobId],
    queryFn: () => apiRequest<Array<Record<string, unknown>>>(`/projects/${projectId}/import-candidates?job_id=${selectedJobId}`),
    enabled: Boolean(projectId && selectedJobId),
  })

  const ignoreCandidate = useMutation({
    mutationFn: (candidateId: string) =>
      apiRequest(`/projects/${projectId}/import-candidates/${candidateId}/ignore?reason=not_a_question`, { method: 'POST', idempotencyKey: newIdempotencyKey('candidate-ignore') }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['candidates', projectId, selectedJobId] })
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      toast.push('已标记为忽略（不进入题库）', 'info')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  const selectedJob = jobsQuery.data?.find((job) => job.id === selectedJobId) ?? null

  return (
    <>
      <div className="page-title">
        <h1>导入与校对</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''}
        </span>
        <span className="spacer" />
        <Link className="btn" to="/questions">
          返回题库（文字导入）
        </Link>
      </div>

      <div className="card">
        <h2>图片导入（手工结构化）</h2>
        <p className="small muted">
          图片会保存为私有来源文件：整页含答案的图片单独标记，提交前与验证期间不能通过文件地址绕过访问规则。
          未配置视觉模型时这里只提供人工结构化路径，不会伪造识别结果。
        </p>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(event) => {
            setFileError('')
            if (event.target.files?.length) uploadImage.mutate(event.target.files)
          }}
        />
        {fileError ? <div className="notice danger">{fileError}</div> : null}
      </div>

      <div className="card">
        <h2>导入任务</h2>
        {jobsQuery.data?.length === 0 ? <div className="empty-state">还没有导入任务。</div> : null}
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>创建时间</th>
                <th>类型</th>
                <th>状态</th>
                <th>候选</th>
                <th>问题</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {(jobsQuery.data ?? []).map((job) => (
                <tr key={job.id} style={job.id === selectedJobId ? { background: '#f5f8ff' } : undefined}>
                  <td className="small">{new Date(job.created_at).toLocaleString()}</td>
                  <td className="small">{job.input_kind}</td>
                  <td>
                    <span className={`pill ${job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'danger' : 'neutral'}`}>
                      {STATUS_LABELS[job.status] ?? job.status}
                    </span>
                  </td>
                  <td>{job.candidate_count}</td>
                  <td className="small">
                    {job.problems.slice(0, 2).map((problem, index) => (
                      <div key={index}>· {problem.message}</div>
                    ))}
                    {job.duplicate_of_job_id ? <div className="pill warn">疑似重复导入</div> : null}
                  </td>
                  <td>
                    <div className="row">
                      <button className="btn small" onClick={() => navigate(`/imports?job=${job.id}`)}>
                        校对
                      </button>
                      {job.status === 'failed' || job.status === 'cancelled' ? (
                        <button className="btn small" disabled={retry.isPending} onClick={() => retry.mutate(job.id)}>
                          重试
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedJob ? (
        <div className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>候选列表（任务 {selectedJob.id.slice(0, 8)}…）</h2>
            <span className="small muted">
              状态分布：
              {Object.entries(selectedJob.candidate_status_counts)
                .map(([status, count]) => `${status}:${count}`)
                .join('、') || '—'}
            </span>
          </div>
          {candidatesQuery.data?.length === 0 ? (
            <div className="empty-state">
              该任务没有候选。可能是解析未识别出结构（请使用模板重新导入），或图片任务只创建了人工结构化入口。
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>题型</th>
                    <th>标签</th>
                    <th>状态</th>
                    <th>问题</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(candidatesQuery.data ?? []).map((row, index) => {
                    const candidate = row as unknown as {
                      id: string
                      status: string
                      draft_payload: Record<string, unknown>
                      review_issues: Array<{ message: string; severity: string }>
                      is_stub_output: boolean
                    }
                    return (
                      <tr key={candidate.id}>
                        <td>{index + 1}</td>
                        <td className="small">{String(candidate.draft_payload.question_type ?? '—')}</td>
                        <td className="small">{String(candidate.draft_payload.display_label ?? '')}</td>
                        <td>
                          <span className={`pill ${candidate.status === 'published' ? 'ok' : candidate.status === 'ignored' ? 'neutral' : 'warn'}`}>
                            {candidate.status}
                          </span>
                          {candidate.is_stub_output ? <span className="pill warn">stub</span> : null}
                        </td>
                        <td className="small">
                          {candidate.review_issues.slice(0, 3).map((issue, issueIndex) => (
                            <div key={issueIndex}>
                              {issue.severity === 'blocking' ? '⛔ ' : '⚠️ '}
                              {issue.message}
                            </div>
                          ))}
                        </td>
                        <td>
                          <div className="row">
                            <Link className="btn small" to={`/imports/${selectedJob.id}/candidates/${candidate.id}`}>
                              校对/编辑
                            </Link>
                            {candidate.status !== 'published' ? (
                              <button
                                className="btn small ghost"
                                disabled={ignoreCandidate.isPending}
                                onClick={() => ignoreCandidate.mutate(candidate.id)}
                              >
                                忽略
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </>
  )
}
