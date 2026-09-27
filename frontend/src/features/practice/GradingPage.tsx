import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  newIdempotencyKey,
  type AttemptDetail,
  type GradeOut,
  type GradingQueueRow,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { GradePanel, OriginalWork } from './PracticePage'
import { AiEstimatePanel, TranscriptionPanel } from './AiAssistPanels'

const TYPE_LABELS: Record<string, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
  constructed_response: '大题',
}

/** A queue row already carries everything a reviewer needs; reuse the renderer. */
function toOriginalWork(row: GradingQueueRow): AttemptDetail {
  return {
    attempt_id: row.attempt_id,
    session_item_id: row.session_item_id,
    submitted_at: row.submitted_at,
    elapsed_ms: row.elapsed_ms,
    raw_answer: row.raw_answer,
    steps: row.steps,
    attachments: row.attachments,
    confidence: row.confidence,
    grading_revision: row.grading_revision,
    receipt_only: false,
    grade: null,
  }
}

/** A short excerpt of the submitted work, so a reviewer can pick a row by content. */
function answerPreview(row: GradingQueueRow): string {
  const raw = row.raw_answer ?? {}
  const type = String(raw.type ?? '')
  let text = ''
  if (type === 'constructed_response') text = String(raw.text ?? '')
  else if (type === 'fill_blank') {
    text = Object.entries((raw.blanks as Record<string, string>) ?? {})
      .map(([id, value]) => `${id}=${value || '（空）'}`)
      .join('，')
  } else if (type === 'true_false') text = raw.value ? '正确' : '错误'
  else text = JSON.stringify(raw.selected_option_ids ?? raw.selected_option_id ?? [])
  if (row.attachments?.length) text += ` · ${row.attachments.length} 张照片`
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return '（无文本作答）'
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
}

/**
 * Manual grading.
 *
 * Constructed responses are confirmed criterion by criterion, and a fill-in
 * blank that no rule could decide is resolved here as well. Your own attempt is
 * always recorded as self-confirmation, even with staff rights; only a different
 * authorised reviewer produces a reviewer-confirmed grade.
 */
export function GradingPage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [active, setActive] = useState<GradingQueueRow | null>(null)
  const [scores, setScores] = useState<Record<string, string>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [result, setResult] = useState<GradeOut | null>(null)

  const projectId = currentProject?.id ?? null

  const queueQuery = useQuery({
    queryKey: ['grading-queue', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<GradingQueueRow[]>(
        `/projects/${projectId}/grading-queue${currentSubject ? `?subject_id=${currentSubject.id}` : ''}`,
      ),
    enabled: Boolean(projectId),
  })

  const submitGrade = useMutation({
    mutationFn: () => {
      if (!active) throw new Error('没有选中的作答')
      const parts = active.parts.map((part) => ({
        part_id: part.part_id,
        score: scores[part.part_id] ?? '',
        decision: 'award',
        comment: comments[part.part_id] ?? '',
      }))
      return apiRequest<GradeOut>(`/projects/${projectId}/attempts/${active.attempt_id}/confirm-grade`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('confirm-grade'),
        body: {
          expected_grading_revision: active.grading_revision,
          parts,
          comment: '人工逐评分点确认',
        },
      })
    },
    onSuccess: async (grade) => {
      setResult(grade)
      toast.push(`已确认：${grade.confirmed_score ?? '—'} / ${grade.max_score}`, 'ok')
      await queryClient.invalidateQueries({ queryKey: ['grading-queue', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['evidence'] })
      await queryClient.invalidateQueries({ queryKey: ['learning-states'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const revealAttempt = useMutation({
    mutationFn: () =>
      apiRequest<{ answer_payload: Record<string, unknown>; rubric: { criteria: Array<Record<string, unknown>> } | null }>(
        `/projects/${projectId}/attempts/${active?.attempt_id}/reveal`,
        { method: 'POST', idempotencyKey: newIdempotencyKey('attempt-reveal') },
      ),
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  const rows = queueQuery.data ?? []

  return (
    <>
      <div className="page-title">
        <h1>人工评分</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => void queryClient.invalidateQueries({ queryKey: ['grading-queue', projectId] })}>
          刷新队列
        </button>
      </div>

      <div className="notice info">
        待评不等于错题或 0 分：在确认之前，该作答既不进入完整正确率，也不计入严格独立证据。
        你给自己的作答评分只会记为「自评确认」，即使拥有管理员权限也不会变成复核确认。
      </div>

      {rows.length === 0 ? (
        <div className="card empty-state">当前没有待人工确认的作答。</div>
      ) : (
        <div className="grid two">
          <div className="card">
            <h2>待评分（{rows.length}）</h2>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>题目</th>
                    <th>题型</th>
                    <th>提交时间</th>
                    <th>待评分值</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.attempt_id}
                      onClick={() => {
                        setActive(row)
                        setResult(null)
                        setScores(
                          Object.fromEntries(
                            row.parts.map((part) => [part.part_id, part.status === 'confirmed' ? (part.score ?? '') : '']),
                          ),
                        )
                        setComments({})
                      }}
                      style={{ cursor: 'pointer', background: active?.attempt_id === row.attempt_id ? '#f5f8ff' : undefined }}
                    >
                      <td className="small">
                        {row.display_label || row.question_id.slice(0, 8)}
                        <div className="tiny muted" data-testid="queue-answer-preview">
                          {answerPreview(row)}
                        </div>
                      </td>
                      <td className="small">{TYPE_LABELS[row.question_type] ?? row.question_type}</td>
                      <td className="small">{new Date(row.submitted_at).toLocaleString()}</td>
                      <td className="small">{row.pending_max_score}</td>
                      <td className="small">
                        {row.is_own_attempt ? <span className="pill warn">本人（自评）</span> : <span className="pill">他人</span>}
                        {row.can_review_as_other ? <span className="pill ok">可复核</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2>评分详情</h2>
            {!active ? (
              <div className="empty-state">从左侧选择一条待评分作答。</div>
            ) : (
              <>
                <p className="small muted">
                  {active.display_label || active.question_id.slice(0, 8)} · {TYPE_LABELS[active.question_type] ?? active.question_type} ·
                  版本 r{active.grading_revision} · 本项满分 {active.parts.reduce((sum, part) => sum + Number(part.max_score), 0)}
                  {active.is_own_attempt ? '（本人作答：将记录为自评确认）' : '（他人作答：可记录复核确认）'}
                </p>

                <h3>学生的原始作答</h3>
                <OriginalWork detail={toOriginalWork(active)} projectId={projectId} />

                {/* Transcriptions, estimates and diagnosis are owner-scoped on the
                    server: for someone else's attempt they would answer with a scope
                    error three times over, so the reviewer gets one plain note. */}
                {!active.is_own_attempt ? (
                  <div className="notice info" data-testid="reviewer-scope-note">
                    这是他人的作答：AI 转写确认与 AI 估分按作答归属校验，只能由作答者本人操作。
                    请直接使用下方的评分标准与逐评分点人工打分；你的确认会记录为复核确认。
                  </div>
                ) : (
                  <>
                    <TranscriptionPanel
                      projectId={projectId}
                      attemptId={active.attempt_id}
                      assetIds={active.attachments}
                    />

                    <AiEstimatePanel
                      projectId={projectId}
                      attemptId={active.attempt_id}
                      partIds={active.parts.map((part) => part.part_id)}
                      criterionDescriptions={Object.fromEntries(
                        (active.rubric?.criteria ?? [])
                          .filter((criterion) => criterion.criterion_id)
                          .map((criterion) => [
                            String(criterion.criterion_id),
                            String(criterion.text ?? criterion.description ?? ''),
                          ]),
                      )}
                      onPrefill={(values) => setScores((current) => ({ ...current, ...values }))}
                    />
                  </>
                )}

                {active.rubric ? (
                  <div className="card" style={{ background: '#f9fafc' }} data-testid="grading-rubric">
                    <h4 style={{ marginTop: 0 }}>评分标准（评分点与满分）</h4>
                    <ul className="small">
                      {active.rubric.criteria.map((criterion, index) => (
                        <li key={index}>
                          {String(criterion.criterion_id ?? index)} · {String(criterion.text ?? '')}（
                          {String(criterion.max_score ?? '')} 分）
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="row">
                  <button className="btn small" disabled={revealAttempt.isPending} onClick={() => revealAttempt.mutate()}>
                    查看标准答案（已记录暴露）
                  </button>
                </div>
                {revealAttempt.data ? (
                  <div className="notice info">
                    <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                      {JSON.stringify(revealAttempt.data.answer_payload, null, 2)}
                    </pre>
                  </div>
                ) : null}

                <h3>逐评分点打分</h3>
                {active.parts.map((part) => (
                  <div key={part.part_id} style={{ marginBottom: 10 }}>
                    <div className="row between">
                      <span className="small">
                        {part.part_id}
                        {part.detail?.reason ? ` · ${String(part.detail.reason)}` : ''}
                        {part.detail?.text ? ` · ${String(part.detail.text)}` : ''}
                      </span>
                      <span className="small muted">满分 {part.max_score}</span>
                    </div>
                    <div className="inline-field">
                      <input
                        value={scores[part.part_id] ?? ''}
                        placeholder={`0 ~ ${part.max_score}`}
                        onChange={(event) => setScores({ ...scores, [part.part_id]: event.target.value })}
                        style={{ maxWidth: 120 }}
                      />
                      <input
                        value={comments[part.part_id] ?? ''}
                        placeholder="评分理由（可选）"
                        onChange={(event) => setComments({ ...comments, [part.part_id]: event.target.value })}
                      />
                    </div>
                  </div>
                ))}
                <div className="row">
                  <button className="btn primary" disabled={submitGrade.isPending} onClick={() => submitGrade.mutate()}>
                    确认评分
                  </button>
                  <button className="btn" onClick={() => navigate('/review')}>
                    查看证据与排除原因
                  </button>
                </div>
                {result ? <GradePanel grade={result} projectId={projectId} /> : null}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
