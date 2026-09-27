import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchVariantJobs, serverMessageOf, type VariantListOut } from '../../api/client'
import { useScope } from '../../app/context'

/**
 * C02 variants list: every AI variant batch of this project and its candidates.
 *
 * The list is an import entry point on purpose — a variant batch *is* an import
 * job, so proofreading and publishing stay on the one existing review path.
 * The heading states the rule that keeps C02 honest: AI-generated content is
 * never a real past-paper occurrence and cannot be counted in cycle statistics,
 * no matter what a candidate looks like.
 */

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  processing: '处理中',
  awaiting_review: '待校对',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const CANDIDATE_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  ready: '待校对',
  published: '已发布',
  ignored: '已忽略',
  rejected: '已否决',
}

function formatMoment(raw: string): string {
  if (!raw) return '未带时间'
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? raw : at.toLocaleString()
}

export function VariantsList() {
  const { currentProject } = useScope()
  const projectId = currentProject?.id ?? null

  const variantsQuery = useQuery({
    queryKey: ['variants', projectId],
    queryFn: () => fetchVariantJobs(projectId as string, 20),
    enabled: Boolean(projectId),
    retry: false,
  })

  const data: VariantListOut | null = variantsQuery.data ?? null

  return (
    <div className="card" data-testid="variants-list">
      <div className="row between">
        <h2 style={{ margin: 0 }}>AI 变式任务</h2>
        {data ? (
          <span className="small muted">
            服务端返回 {data.count} 个任务（最多 {data.limit} 个，按创建时间倒序）
          </span>
        ) : null}
      </div>
      <p className="small muted">
        每一批变式都是一个导入任务：候选只有通过服务端的确定性校验并由人工核对答案后，才能走原有发布流程。
        AI 生成内容<strong>永远不会</strong>成为真实考试发生记录，也不能计入周期统计。
      </p>

      {variantsQuery.isLoading ? <p className="muted">正在读取变式任务…</p> : null}
      {variantsQuery.isError ? (
        <div className="notice danger" data-testid="variants-error">
          {serverMessageOf(variantsQuery.error)}
        </div>
      ) : null}
      {!variantsQuery.isLoading && !variantsQuery.isError && !data ? (
        <div className="notice danger" data-testid="variants-error">
          服务端没有返回变式任务清单：这里不会显示为「没有任务」。
        </div>
      ) : null}

      {data && data.jobs.length === 0 ? (
        <div className="empty-state">
          还没有 AI 变式任务。可在题库页对一道已发布题目点「生成变式」。
        </div>
      ) : null}

      {data?.jobs.map((job) => (
        <div
          key={job.job_id}
          data-testid="variants-job-row"
          data-job-id={job.job_id}
          style={{ marginTop: 12, borderTop: '1px solid #eef1f4', paddingTop: 8 }}
        >
          <div className="row between">
            <div className="small">
              <strong>任务 {job.job_id.slice(0, 8)}…</strong> · {formatMoment(job.created_at)} ·{' '}
              <span className={`pill ${job.status === 'failed' ? 'danger' : job.status === 'completed' ? 'ok' : 'warn'}`}>
                {JOB_STATUS_LABELS[job.status] ?? job.status}
              </span>{' '}
              · 候选 {job.candidate_count} 条 · 进度 {job.progress_percent}%
            </div>
            <Link className="btn small" to={`/imports?job=${job.job_id}`}>
              打开校对列表
            </Link>
          </div>
          <div className="tiny muted">
            生成器版本：{job.extractor_version || '—'} · 状态分布：
            {Object.entries(job.candidate_status_counts)
              .map(([status, count]) => `${CANDIDATE_STATUS_LABELS[status] ?? status}:${count}`)
              .join('、') || '—'}
            {job.subject_id ? ` · 科目 ${job.subject_id.slice(0, 8)}…` : ''}
          </div>

          {job.problems.length ? (
            <ul className="small" style={{ margin: '6px 0 0 18px' }}>
              {job.problems.map((problem, index) => (
                <li key={`${problem.code}-${index}`} data-testid="variant-issue">
                  {problem.severity === 'warning' ? '⚠️ ' : problem.severity === 'info' ? 'ℹ️ ' : '⛔ '}
                  {problem.message}
                  {problem.code ? `（${problem.code}）` : ''}
                </li>
              ))}
            </ul>
          ) : null}

          {job.candidates.length ? (
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 6 }}>
              {job.candidates.map((candidate, index) => (
                <li
                  key={candidate.candidate_id}
                  data-testid="variant-candidate-row"
                  data-candidate-id={candidate.candidate_id}
                  data-status={candidate.status}
                >
                  <div className="row between">
                    <span className="small">
                      候选 {index + 1} · {candidate.question_type ?? '题型未知'} ·{' '}
                      <span className="pill neutral">
                        {CANDIDATE_STATUS_LABELS[candidate.status] ?? candidate.status}
                      </span>{' '}
                      {candidate.blocking_issues.length ? (
                        <span className="pill danger">{candidate.blocking_issues.length} 项阻止发布</span>
                      ) : (
                        <span className="pill ok">未发现阻断问题</span>
                      )}
                      {candidate.is_stub_output ? <span className="pill warn">stub 输出</span> : null}
                    </span>
                    <Link className="btn small" to={`/imports/${job.job_id}/candidates/${candidate.candidate_id}`}>
                      校对/发布
                    </Link>
                  </div>
                  {candidate.review_issues.length ? (
                    <ul className="small" style={{ margin: '4px 0 0 18px' }}>
                      {candidate.review_issues.map((issue, issueIndex) => (
                        <li key={`${candidate.candidate_id}-${issueIndex}`} data-testid="variant-issue">
                          {issue.severity === 'warning' ? '⚠️ ' : '⛔ '}
                          {issue.message}
                          {issue.code ? `（${issue.code}）` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="small muted">该任务没有候选。</div>
          )}
        </div>
      ))}
    </div>
  )
}
