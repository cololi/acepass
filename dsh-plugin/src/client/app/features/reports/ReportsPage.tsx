import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  bucketIsFinal,
  newIdempotencyKey,
  percentOfFraction,
  type AiRunRow,
  type AiStatus,
  type CoverageCompletionOut,
  type CycleAnalysisOut,
  type PaperOut,
  type PaperRevisionOut,
  type ReportBucketOut,
  type ReportOut,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { CalibrationPanel } from './CalibrationPanel'

const BUCKET_LABELS: Record<string, string> = {
  fully_graded: '已评完（每个评分点都已决定，可作能力证据）',
  fully_confirmed: '完整确认（可作为能力证据）',
  strict_independent: '严格独立正确',
  partially_graded: '部分已确认（未确认部分只是下限）',
  partially_pending: '部分待确认',
  pending_review: '待人工评分',
  self_assessed: '自评确认（单列）',
  assisted: '辅助作答（单列）',
  repeat_practice: '重复练习（含看过答案）',
  ai_estimated: 'AI 估计（不进入正式分）',
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  official_past: '真实考试试卷',
  mock: '模拟卷',
  practice_set: '练习集',
  demo: '演示数据',
}

const COVERAGE_STATUS_LABELS: Record<string, string> = {
  coverage_unknown: '未登记预期场次',
  coverage_incomplete: '覆盖不完整',
  coverage_complete: '覆盖完整（已人工确认）',
}

const REVISION_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  withdrawn: '已撤回',
}

/** Why one paper cannot be counted in its cycle (P1-03). */
const BLOCKING_REASON_LABELS: Record<string, string> = {
  demo_or_mock: '演示/模拟数据不计入',
  no_effective_revision: '尚未指定有效版本',
  revision_not_confirmed: '版本尚未人工确认',
  coverage_unknown: '未登记预期场次',
  coverage_incomplete: '覆盖不完整',
  no_scored_items: '没有计分题项',
}

function blockingReasonLabel(reason: string): string {
  const mapped = BLOCKING_REASON_LABELS[reason]
  if (mapped) return mapped
  if (reason.startsWith('source_kind=')) {
    const kind = reason.slice('source_kind='.length)
    return `来源类型为${SOURCE_KIND_LABELS[kind] ?? kind}，不计入真实周期`
  }
  return reason
}

function percentOf(share: string | null): string {
  if (share === null || share === '') return '—'
  const value = Number(share)
  if (!Number.isFinite(value)) return share
  return `${(value * 100).toFixed(1)}%`
}

/** A UUID is unreadable in a sentence; the full id stays in the tooltip. */
function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value
}

/**
 * C06: one bucket's fraction, labelled honestly.
 *
 * A bucket whose marks are not all confirmed is a *lower bound*, not a rate: the
 * cell says so in words and names how many marks are still missing, so the
 * number can never be read as the finished score rate. Only buckets the server
 * marks `partial_lower_bound` (or that still carry pending marks in an older
 * payload) take this path.
 */
function BucketFraction({ bucket }: { bucket: ReportBucketOut }) {
  if (!bucket.confirmed_fraction) {
    return <span className="muted">—</span>
  }
  if (bucketIsFinal(bucket)) {
    return (
      <span>
        {percentOf(bucket.confirmed_fraction)}
        <span className="pill ok" style={{ marginLeft: 6 }}>
          已全部确认
        </span>
      </span>
    )
  }
  return (
    <span>
      已确认部分（下限）{percentOf(bucket.confirmed_fraction)}
      <span className="pill warn" style={{ marginLeft: 6 }}>
        下限
      </span>
      <span className="tiny muted"> 还有 {bucket.pending_max_score} 分未评，不是最终得分率</span>
    </span>
  )
}

function integerOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Coverage inputs and the three human statements a cycle needs.
 *
 * Coverage counts alone never prove a cycle: the backend only counts a revision
 * whose completeness was confirmed, and only after the revision itself was
 * confirmed. The buttons therefore stay separate and explicit.
 */
function PaperRevisionControls({
  revision,
  busy,
  onRecord,
  onConfirmRevision,
}: {
  revision: PaperRevisionOut
  busy: boolean
  onRecord: (payload: { expected: number | null; covered: number | null; confirm: boolean }) => void
  onConfirmRevision: () => void
}) {
  const [expected, setExpected] = useState(revision.expected_session_count === null ? '' : String(revision.expected_session_count))
  const [covered, setCovered] = useState(revision.covered_session_count === null ? '' : String(revision.covered_session_count))
  const expectedValue = integerOrNull(expected)
  const coveredValue = integerOrNull(covered)
  const canRecord = expectedValue !== null && coveredValue !== null && !busy
  return (
    <>
      <td>
        <input
          value={expected}
          inputMode="numeric"
          placeholder="预期"
          style={{ maxWidth: 78 }}
          aria-label="预期场次"
          onChange={(event) => setExpected(event.target.value)}
        />
      </td>
      <td>
        <input
          value={covered}
          inputMode="numeric"
          placeholder="已覆盖"
          style={{ maxWidth: 78 }}
          aria-label="已覆盖场次"
          onChange={(event) => setCovered(event.target.value)}
        />
      </td>
      <td>
        <div className="row">
          <button
            className="btn small"
            disabled={!canRecord}
            title="登记预期与已覆盖场次；填写本身不代表周期完整"
            onClick={() => {
              if (expectedValue === null || coveredValue === null) return
              onRecord({ expected: expectedValue, covered: coveredValue, confirm: false })
            }}
          >
            登记覆盖
          </button>
          <button
            className="btn small"
            disabled={busy}
            title="人工声明该版本覆盖了整个周期；只有确认后该周期才可能被计入"
            onClick={() => onRecord({ expected: expectedValue, covered: coveredValue, confirm: true })}
          >
            确认完整
          </button>
          <button
            className="btn small primary"
            disabled={busy}
            title="把版本标记为已人工确认；至少需要一个计分题项。该试卷还没有有效版本时会同时设为有效版本"
            onClick={onConfirmRevision}
          >
            确认版本
          </button>
        </div>
      </td>
    </>
  )
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
      apiRequest<{
        coverage_note: string
        papers: Array<Record<string, unknown>>
        completion: CoverageCompletionOut
      }>(`/projects/${projectId}/papers/coverage?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const cycleQuery = useQuery({
    queryKey: ['cycle-analysis', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<CycleAnalysisOut>(
        `/projects/${projectId}/papers/cycle-analysis?subject_id=${currentSubject?.id}&max_cycles=5`,
      ),
    enabled: Boolean(projectId && currentSubject),
  })

  const papersQuery = useQuery({
    queryKey: ['papers', projectId, currentSubject?.id],
    queryFn: () => apiRequest<PaperOut[]>(`/projects/${projectId}/papers?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const recordCoverage = useMutation({
    mutationFn: (payload: { revisionId: string; expected: number | null; covered: number | null; confirm: boolean }) =>
      apiRequest<PaperRevisionOut>(`/projects/${projectId}/paper-revisions/${payload.revisionId}/coverage`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('paper-coverage'),
        body: {
          expected_session_count: payload.expected,
          covered_session_count: payload.covered,
          confirm: payload.confirm,
        },
      }),
    onSuccess: async (revision) => {
      toast.push(
        revision.coverage_status === 'coverage_complete'
          ? '已登记覆盖并人工确认为完整周期'
          : '已登记覆盖情况；未确认为完整周期前不会计入周期统计',
        'ok',
      )
      await queryClient.invalidateQueries({ queryKey: ['coverage', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['papers', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['cycle-analysis', projectId] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const confirmRevision = useMutation({
    mutationFn: (revisionId: string) =>
      apiRequest<PaperRevisionOut>(`/projects/${projectId}/paper-revisions/${revisionId}/confirm`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('paper-revision-confirm'),
      }),
    onSuccess: async () => {
      toast.push('已确认为人工核对过的版本；该试卷还没有有效版本时会同时设为有效版本', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['coverage', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['papers', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['cycle-analysis', projectId] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
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

  // A failed read clears the report: a stale aggregate must never stay on screen
  // while the server is saying it cannot be computed.
  const report = reportQuery.isError ? null : reportQuery.data
  const cycle = cycleQuery.data
  const coverageCompletion = coverageQuery.isError ? null : (coverageQuery.data?.completion ?? null)
  const incompleteScope = report?.incomplete_scope ?? null
  const aggregate = report?.aggregate ?? null
  const finalResult = report?.final_result ?? null
  const resultIncomplete =
    report?.result_status === 'incomplete' || Boolean(incompleteScope?.is_incomplete)
  const resultNoData = report?.result_status === 'no_data' || aggregate?.status === 'no_data'

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

      {report && resultIncomplete ? (
        <div
          className="card warn-panel"
          data-testid="report-incomplete-banner"
        >
          <h2 style={{ marginTop: 0 }}>成绩未完成</h2>
          <p className="small">
            范围内有 <strong>{incompleteScope?.incomplete_attempts ?? 0}</strong> 次作答仍有未确认部分
            {incompleteScope?.attempts_in_scope !== undefined
              ? `（共 ${incompleteScope.attempts_in_scope} 次在范围内）`
              : ''}
            ：在确认之前，本报告不输出最终得分率、通过率或排名。
            {finalResult === null ? '服务器已把 final_result 置为 null。' : ''}
          </p>
          <ul className="small">
            {(incompleteScope?.reasons ?? []).map((reason) => (
              <li key={reason.code} data-testid="report-incomplete-reason">
                <strong>{reason.message}</strong>（{reason.attempt_count} 次）
                {reason.question_ids.length ? (
                  <span className="tiny muted">
                    {' '}
                    · 涉及题目：
                    {reason.question_ids
                      .slice(0, 5)
                      .map((id) => shortId(id))
                      .join('、')}
                    {reason.question_ids.length > 5 ? ' 等' : ''}
                  </span>
                ) : null}
                {reason.session_item_ids.length ? (
                  <span className="tiny muted">
                    {' '}
                    · 题项：
                    {reason.session_item_ids
                      .slice(0, 5)
                      .map((id) => shortId(id))
                      .join('、')}
                    {reason.session_item_ids.length > 5 ? ' 等' : ''}
                  </span>
                ) : null}
                {reason.ids_truncated ? <span className="tiny muted">（列表已截断）</span> : null}
              </li>
            ))}
          </ul>
          {incompleteScope?.missing_note ? (
            <p className="small muted" style={{ marginBottom: 0 }}>
              {incompleteScope.missing_note}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* The lower bound must stay visible while the scope is incomplete: it is
          the honest number, and hiding it would leave the banner without a value.
          The final card keeps its own guard so it can never render for an
          incomplete report even if the server ever sent both. */}
      {report ? (
        resultNoData ? (
          <div className="card" data-testid="report-no-data">
            <h2>没有可统计的作答</h2>
            <p className="small muted" style={{ marginBottom: 0 }}>
              {aggregate?.label ?? '服务器没有返回可统计的作答：不显示任何推算得分率、通过率或排名。'}
            </p>
          </div>
        ) : finalResult && !resultIncomplete ? (
          <div className="card" data-testid="report-final-result">
            <h2>最终结果（范围内每一次作答都已确认）</h2>
            <p className="small">
              最终得分率 <strong>{percentOfFraction(finalResult.score_rate)}</strong> · 已确认{' '}
              {finalResult.confirmed_score} / {finalResult.max_score} 分 · 覆盖 {finalResult.attempts} 次作答
              {finalResult.includes_self_assessed_attempts
                ? `（含 ${finalResult.includes_self_assessed_attempts} 次自评确认，单列展示）`
                : ''}
            </p>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              {finalResult.basis}
            </p>
          </div>
        ) : aggregate || resultIncomplete ? (
          <div className="card" data-testid="report-lower-bound">
            <h2>已确认部分（下限）</h2>
            <p className="small">
              已确认部分（下限）<strong>{percentOfFraction(aggregate?.lower_bound ?? null)}</strong>
              {aggregate ? `（已确认 ${aggregate.confirmed_score} / ${aggregate.max_score} 分）` : ''}；
              还有 <strong>{aggregate?.unresolved_max_score ?? '—'}</strong> 分未评
              {aggregate ? `（${aggregate.unresolved_attempts} 次作答）` : ''}。
            </p>
            <p className="small">
              <strong>这不是最终得分率</strong>：未确认部分不计入，也不输出通过率或排名。
            </p>
            {aggregate?.label ? <p className="tiny muted">{aggregate.label}</p> : null}
            {aggregate?.missing?.note ? (
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                {aggregate.missing.note}
              </p>
            ) : null}
          </div>
        ) : null
      ) : null}

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
                    <tr
                      key={key}
                      data-testid={bucketIsFinal(bucket) ? undefined : 'report-partial-bucket'}
                    >
                      <td>{BUCKET_LABELS[key] ?? key}</td>
                      <td>{bucket.attempts}</td>
                      <td>{bucket.confirmed_score}</td>
                      <td>{bucket.max_score}</td>
                      <td>{bucket.pending_max_score}</td>
                      <td>
                        <BucketFraction bucket={bucket} />
                      </td>
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
                      <th>确认比例</th>
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
                        <td className="small">
                          <BucketFraction bucket={bucket} />
                        </td>
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

      <CalibrationPanel projectId={projectId} subjectId={currentSubject?.id ?? null} />

      <div className="card" data-testid="cycle-analysis">
        <h2>真实周期分析（近五年）</h2>
        <p className="small muted">
          只统计真实考试发生记录：演示、模拟卷与练习集不计入任何分子或分母；一个周期只有在全部已登记试卷都有
          「已人工确认、覆盖完整且至少有一个计分题项」的有效版本时才算完整周期。
          分值按题目版本的主要考点权重计入一次，没有映射的计分题进入「未分类」。
        </p>
        {!currentSubject ? <div className="empty-state">请先选择科目。</div> : null}
        {cycleQuery.isLoading ? <p className="muted small">计算中…</p> : null}
        {cycleQuery.isError ? <div className="notice danger">{describeError(cycleQuery.error)}</div> : null}
        {cycle ? (
          <>
            {cycle.status === 'ok' ? (
              <div className="notice info" data-testid="cycle-status">
                <strong>完整周期充足：</strong>已用完整周期 {cycle.used_cycle_count} / {cycle.cycle_horizon}
                {cycle.used_cycles.length ? `（${cycle.used_cycles.join('、')}）` : ''}；以下分布按周期给出，不作为通过率预测。
              </div>
            ) : (
              <div className="notice warn" data-testid="cycle-status">
                <strong>完整周期不足：</strong>已用完整周期 {cycle.used_cycle_count} / {cycle.cycle_horizon}
                ，还缺 {cycle.missing_complete_cycles} 个完整周期。
                {cycle.used_cycles.length
                  ? `当前只计入 ${cycle.used_cycles.join('、')}；这些数据只是已完整周期的分布，不构成“近五年”结论。`
                  : '目前没有任何完整周期，因此不给出“近五年”结论。'}
              </div>
            )}

            {cycle.cycles.length ? (
              <>
                <h3>各周期分值分布（{cycle.status === 'ok' ? '已计入的完整周期' : '已计入的完整周期，不足 5 个'}）</h3>
                <div className="table-scroll">
                  <table className="data" data-testid="cycle-table">
                    <thead>
                      <tr>
                        <th>周期</th>
                        <th>试卷数</th>
                        <th>计分题数</th>
                        <th>分母总分</th>
                        <th>权重合计</th>
                        <th>主要考点（占比）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cycle.cycles.map((row) => (
                        <tr key={row.cycle_key}>
                          <td className="small">{row.cycle_key}</td>
                          <td>{row.paper_count}</td>
                          <td>{row.scored_item_count}</td>
                          <td>{row.denominator_total_score}</td>
                          <td>{percentOf(row.share_total)}</td>
                          <td className="small">
                            {row.nodes.length === 0
                              ? '—'
                              : row.nodes
                                  .slice(0, 5)
                                  .map((node) => `${node.label}（${percentOf(node.share)}）`)
                                  .join('、')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="tiny muted">
                  权重合计是该周期各考点占比之和（含「未分类」），正常情况下接近 100%；出现「未分类」条目说明有计分题没有映射到考点。
                </p>
              </>
            ) : null}

            {cycle.nodes.length ? (
              <>
                <h3>已计入周期的考点平均占比</h3>
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>考点</th>
                        <th>出现周期数</th>
                        <th>平均占比</th>
                        <th>平均分值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cycle.nodes.map((node) => (
                        <tr key={node.node_id ?? '__unclassified__'}>
                          <td>
                            {node.label}
                            {node.unclassified ? <span className="pill neutral" style={{ marginLeft: 6 }}>未分类</span> : null}
                            {node.path && node.path !== node.label ? <div className="tiny muted">{node.path}</div> : null}
                          </td>
                          <td>{node.cycle_count}</td>
                          <td>{percentOf(node.average_share)}</td>
                          <td>{node.average_score ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="tiny muted">平均占比只在出现该考点的已计入周期上取平均；没有出现的周期不按 0 计入。</p>
              </>
            ) : null}

            <h3>未覆盖大纲考点（{cycle.coverage_gaps.length}）</h3>
            <div data-testid="cycle-gaps">
              {cycle.coverage_gaps.length === 0 ? (
                <p className="small muted">已计入的完整周期覆盖了已发布大纲的全部考点。</p>
              ) : (
                <ul className="small">
                  {cycle.coverage_gaps.map((gap) => (
                    <li key={gap.node_id}>
                      {gap.label}
                      {gap.path ? <span className="tiny muted">（{gap.path}）</span> : null}：
                      {gap.reason === 'never_examined_in_counted_cycles' ? '在已计入的完整周期里没有出现过' : gap.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <h3>未完整周期（{cycle.incomplete_cycles.length}）</h3>
            <div data-testid="cycle-incomplete">
              {cycle.incomplete_cycles.length === 0 ? (
                <p className="small muted">所有已登记周期都已完整。</p>
              ) : (
                cycle.incomplete_cycles.map((row) => (
                  <div key={row.cycle_key} style={{ marginBottom: 10 }}>
                    <p className="small" style={{ marginBottom: 4 }}>
                      <strong>{row.cycle_key}</strong> · 已登记试卷 {row.paper_count} 份 · 阻塞原因：
                      {row.blocking_reasons.length
                        ? Array.from(new Set(row.blocking_reasons.map((item) => blockingReasonLabel(item.reason)))).join('；')
                        : '—'}
                    </p>
                    <div className="table-scroll">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>卷别</th>
                            <th>场次</th>
                            <th>来源</th>
                            <th>覆盖</th>
                            <th>预期/已覆盖</th>
                            <th>能否计入</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.papers.map((paper) => (
                            <tr key={paper.paper_id}>
                              <td className="small">{paper.paper_code || '—'}</td>
                              <td className="small">{paper.session_key || '—'}</td>
                              <td className="small">
                                {paper.source_kind ? (SOURCE_KIND_LABELS[paper.source_kind] ?? paper.source_kind) : '—'}
                              </td>
                              <td className="small">
                                {COVERAGE_STATUS_LABELS[paper.coverage_status] ?? paper.coverage_status}
                              </td>
                              <td className="small">
                                {paper.expected_session_count ?? '—'} / {paper.covered_session_count ?? '—'}
                              </td>
                              <td className="small">
                                {paper.countable ? (
                                  <span className="pill ok">可计入</span>
                                ) : (
                                  <span className="pill warn">{blockingReasonLabel(paper.reason)}</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              )}
            </div>

            {cycle.notes.length ? (
              <ul className="small muted">
                {cycle.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="card">
        <h2>真实试卷覆盖登记</h2>
        <p className="small muted">{coverageQuery.data?.coverage_note ?? coverageQuery.data?.coverage_note}</p>
        {coverageQuery.isError ? (
          <div className="notice danger">{describeError(coverageQuery.error)}</div>
        ) : null}
        {coverageCompletion ? (
          coverageCompletion.status === 'final' && coverageCompletion.final_result ? (
            <div className="notice ok" data-testid="coverage-completion">
              <strong>覆盖完整：</strong>完成率可作为最终值{' '}
              {percentOfFraction(coverageCompletion.final_result.coverage_rate)}（
              {coverageCompletion.final_result.papers_total} 份已登记试卷全部覆盖完整）。
            </div>
          ) : coverageCompletion.status === 'no_data' ? (
            <div className="notice info" data-testid="coverage-completion">
              {coverageCompletion.note}
            </div>
          ) : (
            <div className="notice warn" data-testid="coverage-completion">
              <strong>覆盖未完成：不输出完成率。</strong>
              {coverageCompletion.incomplete_scope.blocked_paper_count} /{' '}
              {coverageCompletion.incomplete_scope.papers_total} 份试卷的覆盖未确认完整
              {coverageCompletion.lower_bound
                ? `（已完成 {percentOfFraction(coverageCompletion.lower_bound)} 只是下限）`
                : ''}
              ：{(coverageCompletion.incomplete_scope.reasons ?? [])
                .map((reason) => `${reason.message}（${reason.paper_count}）`)
                .join('；') || '原因未提供'}
            </div>
          )
        ) : null}
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

        <h3>版本覆盖与人工确认</h3>
        <p className="small muted">
          周期统计只读取每份试卷的「有效版本」，并要求该版本已人工确认、覆盖已标记完整、且至少有一个计分题项。
          登记场次只是记录事实；「确认完整」与「确认版本」才是人工声明，确认前不会进入周期分析。
        </p>
        {papersQuery.isError ? <div className="notice danger">{describeError(papersQuery.error)}</div> : null}
        {papersQuery.data?.length ? (
          papersQuery.data.map((paper) => {
            const effectiveRevision =
              paper.revisions.find((revision) => revision.id === paper.effective_revision_id) ?? null
            return (
              <div key={paper.id} style={{ marginTop: 12 }}>
                <div className="row between">
                  <h4 style={{ margin: 0 }}>
                    {paper.cycle_key} · {paper.paper_code || '未填卷别'} · {paper.session_key || '未填场次'}
                  </h4>
                  <span className="small muted">
                    {SOURCE_KIND_LABELS[paper.source_kind] ?? paper.source_kind}
                    {paper.is_demo ? <span className="pill warn" style={{ marginLeft: 6 }}>演示</span> : null}
                  </span>
                </div>
                <p className="tiny muted">
                  有效版本：
                  {effectiveRevision
                    ? `r${effectiveRevision.revision}（${COVERAGE_STATUS_LABELS[effectiveRevision.coverage_status] ?? effectiveRevision.coverage_status}）`
                    : '尚未指定；确认版本时若还没有有效版本会自动指定'}
                  ；周期统计只读取有效版本。
                </p>
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>版本</th>
                        <th>状态</th>
                        <th>覆盖</th>
                        <th>题项（计分）</th>
                        <th>预期场次</th>
                        <th>已覆盖场次</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paper.revisions.map((revision) => (
                        <tr key={revision.id}>
                          <td className="small">
                            r{revision.revision}
                            {revision.id === paper.effective_revision_id ? (
                              <span className="pill ok" style={{ marginLeft: 6 }}>
                                有效版本
                              </span>
                            ) : null}
                          </td>
                          <td className="small">{REVISION_STATUS_LABELS[revision.status] ?? revision.status}</td>
                          <td className="small">
                            {COVERAGE_STATUS_LABELS[revision.coverage_status] ?? revision.coverage_status}
                            {revision.coverage_confirmed_at ? (
                              <span className="pill ok" style={{ marginLeft: 6 }}>
                                已人工确认
                              </span>
                            ) : null}
                          </td>
                          <td className="small">
                            {revision.item_count}（{revision.scored_item_count}）
                          </td>
                          <PaperRevisionControls
                            key={`${revision.id}:${revision.expected_session_count}:${revision.covered_session_count}:${revision.coverage_status}:${revision.status}`}
                            revision={revision}
                            busy={recordCoverage.isPending || confirmRevision.isPending}
                            onRecord={(payload) => recordCoverage.mutate({ revisionId: revision.id, ...payload })}
                            onConfirmRevision={() => confirmRevision.mutate(revision.id)}
                          />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })
        ) : papersQuery.isSuccess ? (
          <p className="small muted">该科目还没有真实试卷记录：请先在「导入与校对」中导入试卷 PDF。</p>
        ) : null}
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
