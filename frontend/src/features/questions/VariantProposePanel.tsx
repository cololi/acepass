import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  problemsOf,
  proposeVariants,
  serverMessageOf,
  type ApiProblemRow,
  type KnowledgeNode,
  type QuestionListItem,
  type VariantCandidateOut,
  type VariantProposeOut,
} from '../../api/client'
import { useToast } from '../../app/context'

/**
 * C02: ask the configured provider for variants of one question.
 *
 * The surface is deliberately one-way. A model never publishes anything, so
 * this panel can only produce *candidates*: every candidate is listed with the
 * server's own problem list, and the only follow-up link goes to the ordinary
 * candidate review page where a human decides. Two honest outcomes are spelled
 * out instead of a spinner that implies success:
 *
 * * 「已生成 N 条候选，需人工校对后发布」 — with each candidate's problems, and
 * * 「没有可用的变式：全部候选都被校验拦下」 — with *every* problem listed.
 *
 * When no provider declares `propose_variant` the server answers 503
 * `ai_not_configured`; that sentence is shown exactly as the server wrote it,
 * and no candidate row is rendered at all.
 */

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  ready: '待校对',
  published: '已发布',
  ignored: '已忽略',
  rejected: '已否决',
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  ai_derived: 'AI 推导答案（需人工确认）',
  official: '官方答案',
  manual: '人工录入',
  extracted: '抽取得到',
}

function failureOf(error: unknown): { message: string; problems: ApiProblemRow[] } {
  return { message: serverMessageOf(error), problems: problemsOf(error) }
}

function issueRow(issue: { code: string; message: string; severity?: string }, key: string) {
  return (
    <li key={key} data-testid="variant-issue">
      {issue.severity === 'warning' ? '⚠️ ' : '⛔ '}
      {issue.message}
      {issue.code ? `（${issue.code}）` : ''}
    </li>
  )
}

function CandidateRow({ jobId, candidate, index }: { jobId: string; candidate: VariantCandidateOut; index: number }) {
  return (
    <li
      data-testid="variant-candidate-row"
      data-candidate-id={candidate.candidate_id}
      data-status={candidate.status}
      style={{ marginBottom: 10, borderTop: '1px solid #eef1f4', paddingTop: 8 }}
    >
      <div className="row between">
        <div className="small">
          <strong>候选 {index + 1}</strong> · {candidate.question_type ?? '题型未知'} ·{' '}
          <span className={`pill ${candidate.blocking_issues.length ? 'danger' : 'ok'}`}>
            {candidate.blocking_issues.length
              ? `${candidate.blocking_issues.length} 项阻止发布`
              : '未发现阻断问题'}
          </span>{' '}
          <span className="pill neutral">{STATUS_LABELS[candidate.status] ?? candidate.status}</span>
          {candidate.is_stub_output ? <span className="pill warn">stub 输出</span> : null}
        </div>
        <Link className="btn small" to={`/imports/${jobId}/candidates/${candidate.candidate_id}`}>
          校对/发布
        </Link>
      </div>
      <div className="tiny muted">
        答案来源：{(SOURCE_TYPE_LABELS[candidate.answer_source_type] ?? candidate.answer_source_type) || '未标注'}
        {candidate.answer_needs_confirmation
          ? ' · 答案尚未人工确认，发布前必须核对（answer_status_known）'
          : ' · 答案已由人工确认'}
        {' · '}内容指纹 {candidate.content_digest || '—'}
        {' · '}候选编号 {candidate.candidate_id}
      </div>
      {candidate.review_issues.length ? (
        <ul style={{ margin: '6px 0 0 18px' }} className="small">
          {candidate.review_issues.map((issue, issueIndex) =>
            issueRow(issue, `${candidate.candidate_id}-${issueIndex}`),
          )}
        </ul>
      ) : (
        <div className="small muted">该候选没有校验问题，但仍需人工校对答案后才能发布。</div>
      )}
    </li>
  )
}

export function VariantProposePanel({
  projectId,
  question,
  sourceSealed = false,
  onClose,
}: {
  projectId: string
  question: QuestionListItem
  /** The server reports this source question as sealed (C03 holdout). */
  sourceSealed?: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [nodeId, setNodeId] = useState('')
  const [count, setCount] = useState('1')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<VariantProposeOut | null>(null)
  const [failure, setFailure] = useState<{ message: string; problems: ApiProblemRow[] } | null>(null)

  const nodesQuery = useQuery({
    queryKey: ['nodes', projectId, question.subject_id],
    queryFn: () =>
      apiRequest<KnowledgeNode[]>(`/projects/${projectId}/knowledge-nodes?subject_id=${question.subject_id}`),
    enabled: Boolean(projectId && question.subject_id),
    retry: false,
  })

  const parsedCount = Number.parseInt(count, 10)
  const countValid = Number.isFinite(parsedCount) && parsedCount >= 1
  const nodes = nodesQuery.data ?? []
  /**
   * The first node of the source subject is preselected.
   *
   * A proposal needs a syllabus node (the server refuses without one), and the
   * panel would otherwise make "generate" unreachable until a human picks one
   * from a list they may not recognise; the select still lets them change it.
   */
  const effectiveNodeId = nodeId || nodes[0]?.id || ''

  const submit = useMutation({
    mutationFn: () => {
      // A new attempt clears the previous outcome: no success block survives a
      // later failure, and a later failure does not keep stale candidate rows.
      setResult(null)
      setFailure(null)
      return proposeVariants(projectId, {
        ...(question.published_version_id
          ? { source_version_id: question.published_version_id }
          : { source_question_id: question.id }),
        node_id: effectiveNodeId,
        count: countValid ? parsedCount : 1,
        difficulty_note: note,
      })
    },
    onSuccess: async (data) => {
      setResult(data)
      await queryClient.invalidateQueries({ queryKey: ['variants', projectId] })
      if (data.nothing_passed) {
        toast.push('没有可用的变式：全部候选都被校验拦下', 'error')
      } else {
        toast.push(`已生成 ${data.candidates.length} 条候选，需人工校对后发布`, 'ok')
      }
    },
    onError: (error) => setFailure(failureOf(error)),
  })

  const label = question.display_label || question.id.slice(0, 8)

  return (
    <div className="card" data-testid="variant-panel" data-question-id={question.id} style={{ margin: 12 }}>
      <div className="row between">
        <h3 style={{ margin: 0 }}>生成变式 · {label}</h3>
        <button className="btn small ghost" onClick={onClose}>
          收起
        </button>
      </div>
      <p className="small muted">
        变式由 AI 生成，只会成为待校对候选：必须通过服务端的确定性校验并由人工核对答案后，才能走原有发布流程。
        AI 生成内容永远不会成为真实考试发生记录，也不能计入周期统计。
      </p>
      {!question.published_version_id ? (
        <div className="notice warn">
          这道题还没有已发布版本，服务端会拒绝生成（只能从已发布的题目版本生成变式）。
        </div>
      ) : null}
      {sourceSealed ? (
        <div className="notice warn" data-testid="variant-source-sealed">
          该题已封存：封存内容不参与练习、检索、AI 生成提示与原页预览。服务端的封存拦截清单不包含变式生成
          （变式是全新题目，不会把原题发给学员），因此这里仍然可以生成候选；如果你不想用封存题作源题，请改选其他题目。
        </div>
      ) : null}

      <div className="grid three">
        <label className="field">
          <span>目标考点（该科目大纲）</span>
          <select
            data-testid="variant-node-select"
            value={effectiveNodeId}
            onChange={(event) => setNodeId(event.target.value)}
          >
            <option value="">请选择考点</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.canonical_name}
                {node.is_unclassified ? '（未分类）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>生成数量（单次上限 3，超出由服务端按上限执行）</span>
          <input
            data-testid="variant-count"
            type="number"
            min={1}
            max={3}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        <label className="field">
          <span>难度说明（可选）</span>
          <input
            data-testid="variant-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="例如：与源题同难度，只换数字"
          />
        </label>
      </div>
      {nodesQuery.isError ? (
        <div className="notice danger" data-testid="variant-error">
          {serverMessageOf(nodesQuery.error)}
        </div>
      ) : null}
      {!nodesQuery.isLoading && !nodesQuery.isError && nodes.length === 0 ? (
        <div className="notice warn">
          该科目还没有可选考点：请先在考点地图建立大纲与考点，否则无法指定变式考察的考点。
        </div>
      ) : null}

      <div className="row">
        <button
          className="btn primary"
          data-testid="variant-submit"
          disabled={!effectiveNodeId || !countValid || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? '生成中…' : '生成变式候选'}
        </button>
        <span className="small muted">
          {!effectiveNodeId
            ? '该科目还没有可选考点，请先在考点地图建立大纲与考点。'
            : !countValid
              ? '生成数量至少为 1。'
              : '生成不会发布任何内容，只会写入待校对候选。'}
        </span>
      </div>

      {result || failure ? (
        <div data-testid="variant-result" style={{ marginTop: 10 }}>
          {failure ? (
            <div className="notice danger" data-testid="variant-error">
              {failure.message}
              {failure.problems.length ? (
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {failure.problems.map((problem, index) =>
                    issueRow(problem, `${problem.code}-${index}`),
                  )}
                </ul>
              ) : null}
              <div className="small">本次没有生成任何候选。</div>
            </div>
          ) : null}

          {result ? (
            <>
              {result.is_stub ? (
                <div className="notice warn" data-testid="variant-stub-warning">
                  当前 provider 是 stub（未接入真实模型），候选只是占位输出，不能当作真实生成结果。
                </div>
              ) : null}
              {result.count_capped ? (
                <div className="notice warn" data-testid="variant-count-capped">
                  请求生成 {result.requested_count} 条，服务端按单次上限实际生成 {result.count} 条。
                </div>
              ) : null}
              {result.notes.map((noteText, index) => (
                <div className="notice info" data-testid="variant-note-message" key={index}>
                  {noteText}
                </div>
              ))}

              {result.nothing_passed ? (
                <div className="notice danger" data-testid="variant-nothing-passed">
                  <strong>没有可用的变式：全部候选都被校验拦下</strong>
                  <div className="small">
                    服务端共生成 {result.count} 条候选，全部存在阻断性问题；它们仍然保留为待校对候选，不会自动发布，
                    也不会进入真实考试记录与周期统计。
                  </div>
                  {result.problems.length ? (
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      {result.problems.map((problem, index) => issueRow(problem, `problem-${index}`))}
                    </ul>
                  ) : (
                    <div className="small">服务端没有返回问题明细，请打开候选查看。</div>
                  )}
                </div>
              ) : (
                <div className="notice ok" data-testid="variant-generated">
                  <strong>已生成 {result.candidates.length} 条候选，需人工校对后发布</strong>
                  <div className="small">
                    通过确定性校验 {result.validation.accepted} 条，被拦下 {result.validation.rejected} 条；
                    共 {result.validation.blocking_problem_count} 项阻断问题。考点：{result.node_name || '—'}
                    {result.is_stub ? '' : ` · provider：${result.provider}`}
                  </div>
                </div>
              )}

              {result.candidates.length ? (
                <ul style={{ listStyle: 'none', padding: 0, marginTop: 10 }}>
                  {result.candidates.map((candidate, index) => (
                    <CandidateRow
                      key={candidate.candidate_id}
                      jobId={result.job_id}
                      candidate={candidate}
                      index={index}
                    />
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
