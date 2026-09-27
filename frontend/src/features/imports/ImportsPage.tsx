import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  isLayoutBlockingIssue,
  isLayoutIssue,
  newIdempotencyKey,
  type CandidateOut,
  type ImportJobOut,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { LAYOUT_ISSUE_LABELS, LayoutDiagnostics } from './LayoutReview'
import { VariantsList } from './VariantsList'

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  processing: '处理中',
  awaiting_review: '待校对',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const SOURCE_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'official_past', label: '真实考试试卷' },
  { value: 'mock', label: '模拟卷' },
  { value: 'practice_set', label: '练习集' },
]

const EMPTY_PDF_FORM = {
  title: '',
  source_note: '',
  usage_scope: '',
  cycle_key: '',
  session_key: '',
  paper_code: '',
  expected_session_count: '',
  source_kind: 'official_past',
}

export function ImportsPage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const selectedJobId = params.get('job')
  const [fileError, setFileError] = useState('')
  const [showPdfForm, setShowPdfForm] = useState(false)
  const [pdfError, setPdfError] = useState('')
  const [pdfForm, setPdfForm] = useState(EMPTY_PDF_FORM)
  const [paperFiles, setPaperFiles] = useState<File[]>([])
  const [answerFiles, setAnswerFiles] = useState<File[]>([])
  const [fileInputKey, setFileInputKey] = useState(0)

  const projectId = currentProject?.id ?? null

  const jobsQuery = useQuery({
    queryKey: ['imports', projectId],
    queryFn: () => apiRequest<ImportJobOut[]>(`/projects/${projectId}/imports?limit=50`),
    enabled: Boolean(projectId),
  })

  const uploadPdf = useMutation({
    mutationFn: async () => {
      const form = new FormData()
      paperFiles.forEach((file) => form.append('files', file))
      answerFiles.forEach((file) => form.append('answer_files', file))
      if (currentSubject) form.append('subject_id', currentSubject.id)
      form.append('title', pdfForm.title)
      form.append('source_note', pdfForm.source_note)
      if (pdfForm.usage_scope) form.append('usage_scope', pdfForm.usage_scope)
      form.append('cycle_key', pdfForm.cycle_key.trim())
      form.append('session_key', pdfForm.session_key.trim())
      form.append('paper_code', pdfForm.paper_code.trim())
      form.append('source_kind', pdfForm.source_kind)
      const expected = pdfForm.expected_session_count.trim()
      if (expected) form.append('expected_session_count', expected)
      return apiRequest<ImportJobOut>(`/projects/${projectId}/imports/pdf`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('import-pdf'),
        formData: form,
      })
    },
    onSuccess: async (job) => {
      setPdfError('')
      setPaperFiles([])
      setAnswerFiles([])
      setPdfForm(EMPTY_PDF_FORM)
      setFileInputKey((value) => value + 1)
      toast.push('试卷已解析为待校对候选，请逐题核对卷面题号、来源页与答案匹配结果', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      navigate(`/imports?job=${job.id}`)
    },
    onError: (err) => setPdfError(describeError(err)),
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
    queryFn: () => apiRequest<CandidateOut[]>(`/projects/${projectId}/import-candidates?job_id=${selectedJobId}`),
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

      <div className="card" data-testid="pdf-import-card">
        <h2>原生文字 PDF 批量导入</h2>
        <p className="small muted">
          只解析带文字层的 PDF（扫描图片版没有文字层，必须先自行 OCR，本页不会伪造识别结果）。
          答案单独成册时放进「答案 PDF」：匹配结果只是候选，必须由人工在校对页逐题确认后才会成为答案。
          导入只创建待校对候选与试卷题位记录，不会自动发布任何题目。
        </p>
        <div className="row">
          <button
            className="btn"
            data-testid="pdf-import-toggle"
            onClick={() => setShowPdfForm((open) => !open)}
          >
            {showPdfForm ? '收起 PDF 导入表单' : '展开 PDF 导入表单'}
          </button>
          <span className="small muted">
            表单默认收起：这一页的主要入口仍是图片导入，展开后再选择试卷与答案 PDF。
          </span>
        </div>
        {showPdfForm ? (
        <>
        <div className="grid two">
          <label className="field">
            <span>试卷 PDF（可多选，必填）</span>
            <input
              key={`paper-${fileInputKey}`}
              type="file"
              accept="application/pdf"
              multiple
              data-testid="pdf-paper-input"
              onChange={(event) => {
                setPdfError('')
                setPaperFiles(Array.from(event.target.files ?? []))
              }}
            />
          </label>
          <label className="field">
            <span>答案 PDF（可多选，可留空）</span>
            <input
              key={`answer-${fileInputKey}`}
              type="file"
              accept="application/pdf"
              multiple
              data-testid="pdf-answer-input"
              onChange={(event) => {
                setPdfError('')
                setAnswerFiles(Array.from(event.target.files ?? []))
              }}
            />
          </label>
        </div>
        <div className="grid three">
          <label className="field">
            <span>周期/年份（真实试卷必填）</span>
            <input
              data-testid="pdf-cycle-key"
              value={pdfForm.cycle_key}
              placeholder="例如 2024"
              onChange={(event) => setPdfForm({ ...pdfForm, cycle_key: event.target.value })}
            />
          </label>
          <label className="field">
            <span>场次</span>
            <input
              data-testid="pdf-session-key"
              value={pdfForm.session_key}
              placeholder="例如 上半年"
              onChange={(event) => setPdfForm({ ...pdfForm, session_key: event.target.value })}
            />
          </label>
          <label className="field">
            <span>卷别代码</span>
            <input
              data-testid="pdf-paper-code"
              value={pdfForm.paper_code}
              placeholder="例如 卷一"
              onChange={(event) => setPdfForm({ ...pdfForm, paper_code: event.target.value })}
            />
          </label>
          <label className="field">
            <span>来源类型</span>
            <select
              data-testid="pdf-source-kind"
              value={pdfForm.source_kind}
              onChange={(event) => setPdfForm({ ...pdfForm, source_kind: event.target.value })}
            >
              {SOURCE_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>预期场次（可留空，用于完整性统计）</span>
            <input
              data-testid="pdf-expected-sessions"
              value={pdfForm.expected_session_count}
              inputMode="numeric"
              placeholder="例如 2"
              onChange={(event) => setPdfForm({ ...pdfForm, expected_session_count: event.target.value })}
            />
          </label>
          <label className="field">
            <span>标题</span>
            <input
              data-testid="pdf-title"
              value={pdfForm.title}
              placeholder="例如 2024 年真题（卷一）"
              onChange={(event) => setPdfForm({ ...pdfForm, title: event.target.value })}
            />
          </label>
        </div>
        <div className="grid two">
          <label className="field">
            <span>来源说明（可留空）</span>
            <input
              value={pdfForm.source_note}
              placeholder="例如 官方公布的历年真题卷"
              onChange={(event) => setPdfForm({ ...pdfForm, source_note: event.target.value })}
            />
          </label>
          <label className="field">
            <span>使用范围（可留空）</span>
            <input
              value={pdfForm.usage_scope}
              placeholder="例如 仅本人复习使用"
              onChange={(event) => setPdfForm({ ...pdfForm, usage_scope: event.target.value })}
            />
          </label>
        </div>
        {pdfError ? <div className="notice danger">{pdfError}</div> : null}
        <div className="row">
          <button
            className="btn primary"
            data-testid="pdf-import-submit"
            disabled={paperFiles.length === 0 || uploadPdf.isPending}
            onClick={() => uploadPdf.mutate()}
          >
            导入试卷 PDF
          </button>
          <span className="small muted">
            真实考试试卷必须填写周期与卷别代码，否则不能进入历年统计；登记为模拟卷、练习集的内容不计入真实周期。
          </span>
        </div>
        </>
        ) : null}
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
          data-testid="image-import-input"
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

      {/* C02: AI 变式任务与候选；与其它导入入口并列，校对与发布仍走同一条路径。 */}
      <VariantsList />

      {selectedJob ? (
        <>
          {/*
            C01 at job level: the same deterministic page facts the candidate
            page shows, here for the whole import. A page that needs a human is
            visible before anyone opens a candidate.
          */}
          <LayoutDiagnostics
            diagnostics={selectedJob.page_diagnostics}
            footer={
              <p className="small muted" style={{ marginBottom: 0 }}>
                需要人工确认版面的候选在下方列表中标出；只有逐题「确认版面无误」后，这些候选才能发布。
              </p>
            }
          />
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
                      <th>版面</th>
                      <th>问题</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(candidatesQuery.data ?? []).map((candidate, index) => {
                      const layoutIssues = candidate.review_issues.filter(isLayoutIssue)
                      const layoutBlocking = layoutIssues.filter(isLayoutBlockingIssue)
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
                            {layoutBlocking.length ? (
                              <span className="pill danger">待确认版面：{layoutBlocking.length} 项阻止发布</span>
                            ) : candidate.layout_review_confirmed_at ? (
                              <span className="pill ok">已确认版面</span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                            {layoutIssues.map((issue) => (
                              <div className="tiny muted" key={issue.code}>
                                {LAYOUT_ISSUE_LABELS[issue.code] ?? issue.message}
                              </div>
                            ))}
                            {candidate.layout_review_confirmed_at ? (
                              <div className="tiny muted">
                                确认时间 {new Date(candidate.layout_review_confirmed_at).toLocaleString()}
                              </div>
                            ) : null}
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
        </>
      ) : null}
    </>
  )
}
