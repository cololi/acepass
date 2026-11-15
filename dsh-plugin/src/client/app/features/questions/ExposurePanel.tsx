import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  declareQuestionExternalSeen,
  fetchQuestionExposure,
  problemsOf,
  type ContaminationEvidenceOut,
  type QuestionExposureOut,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

/**
 * C04 exposure: 「为什么这题不算严格独立」.
 *
 * The server owns the verdict; this panel only explains it. Two rules shape the
 * copy and are not negotiable:
 *
 * * a question the server reports as seen is **never** rendered as unseen, and
 * * `strict_independent_eligible === false` is spelled out in words with its
 *   reasons and proof — never a bare red dot.
 *
 * The declaration ledger is append-only: 「记录更正」 writes a correction row and
 * says plainly that the contamination marker stays, because there is no path
 * from "has been exposed" back to "strictly unseen".
 */

/** Reason code → the short Chinese heading of the row. */
const REASON_LABELS: Record<string, string> = {
  external_seen: '系统外已见（本人声明）',
  editorial_preview_seen: '本人校对/编辑预览过本题',
  answer_delivered: '本题已下发过答案',
  explanation_delivered: '本题已下发过讲解',
  hint_delivered: '本题已下发过提示',
  feedback_delivered: '本题已下发过判分反馈',
  stem_delivered: '本题题干已下发过（重复练习）',
  presented_without_submit: '本题曾展示但未提交',
  lineage_seen_in_other_project: '同一内容在本人其他项目中已暴露',
}

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  exposure_event: '曝光账本记录',
  session_item: '练习会话下发记录',
}

const EXPOSURE_KIND_LABELS: Record<string, string> = {
  external_seen: '系统外已见声明',
  editorial_preview: '校对/编辑预览（已看过答案）',
  stem_delivered: '题干下发',
  hint_delivered: '提示下发',
  explanation_delivered: '讲解下发',
  answer_delivered: '答案下发',
  feedback_delivered: '判分反馈下发',
}

/** An ISO instant from the server, or an explicit "the record carries no time". */
function formatMoment(raw: string | null | undefined): string {
  if (!raw) return '记录未带时间'
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? raw : at.toLocaleString()
}

function evidenceSentence(evidence: ContaminationEvidenceOut): string {
  const type = EVIDENCE_TYPE_LABELS[evidence.evidence_type] ?? evidence.evidence_type ?? '未知记录类型'
  const kind = evidence.exposure_kind
    ? (EXPOSURE_KIND_LABELS[evidence.exposure_kind] ?? evidence.exposure_kind)
    : evidence.evidence_type === 'session_item'
      ? '展示但未提交'
      : '未标注种类'
  return `依据：${type} · ${kind}`
}

/** Only the server's own message may explain a refusal; this never guesses. */
function refusalText(error: unknown): { message: string; problems: ReturnType<typeof problemsOf> } {
  const problems = problemsOf(error)
  const message = error instanceof ApiError ? error.message : describeError(error)
  return { message, problems }
}

export function ExposureToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button className="btn small" data-testid="exposure-open" onClick={onToggle}>
      {open ? '收起曝光说明' : '为什么这题不算严格独立'}
    </button>
  )
}

/**
 * The state itself: verdict in words, then one row per reason with its proof.
 *
 * Exported separately so the same block can be embedded wherever a question has
 * to explain itself, and so the wording can be rendered without the actions.
 */
export function ExposureStateBlock({
  state,
  currentProjectId,
}: {
  state: QuestionExposureOut
  currentProjectId?: string | null
}) {
  return (
    <>
      <div
        className={state.strict_independent_eligible ? 'notice ok' : 'notice warn'}
        data-testid="exposure-state"
      >
        <strong>
          {state.strict_independent_eligible
            ? '系统内未见记录（可计入严格独立证据）'
            : '不会计入严格独立证据'}
        </strong>
        {state.seen ? (
          <div className="small">
            服务端已记录本题的曝光：共 {state.exclusion_reasons.length || state.reasons.length} 项原因。
            已见的题不会被显示为「未见」。
          </div>
        ) : (
          <div className="small">
            服务端没有找到本题的曝光记录（未下发、未校对预览、未声明系统外已见），因此目前可计入严格独立证据。
          </div>
        )}
        {!state.strict_independent_eligible ? (
          <div className="small">
            本题不能作为严格独立的首次接触证据；下面的原因与依据就是判定的全部理由。
          </div>
        ) : null}
        {state.first_seen_at ? (
          <div className="small muted">最早记录时间：{formatMoment(state.first_seen_at)}</div>
        ) : null}
      </div>

      {state.exclusion_reasons.length ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {state.exclusion_reasons.map((reason) => (
            <li
              key={reason.code}
              data-testid="exposure-reason"
              className="divider-top" style={{ marginBottom: 8, paddingTop: 6 }}
            >
              <div className="small">
                <strong>{REASON_LABELS[reason.code] ?? reason.message}</strong>（{reason.code}）
              </div>
              <div className="small muted">{reason.message}</div>
              <div className="tiny muted" data-testid="exposure-evidence">
                {evidenceSentence(reason.evidence)} · 时间：{formatMoment(reason.evidence.server_time)} · 记录编号：
                {reason.evidence.evidence_id || '—'}（{reason.evidence.evidence_type || '—'}:
                {reason.evidence.exposure_kind ?? '—'}）
              </div>
              {reason.evidence.project_id && currentProjectId && reason.evidence.project_id !== currentProjectId ? (
                <div className="tiny muted">
                  这条记录来自本人其他项目：内容谱系跨项目计为已见，学习状态仍然按项目分开。
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">没有污染原因：本题目前没有阻止严格独立判定的记录。</p>
      )}

      {state.sources.length ? <p className="tiny muted">来源清单：{state.sources.join('、')}</p> : null}
    </>
  )
}

export function ExposurePanel({ questionId }: { questionId: string }) {
  const { currentProject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const projectId = currentProject?.id ?? null
  const queryKey = ['question-exposure', projectId, questionId] as const

  const exposureQuery = useQuery({
    queryKey,
    queryFn: () => fetchQuestionExposure(projectId as string, questionId),
    enabled: Boolean(projectId && questionId),
    // A missing exposure payload must show the server's own message promptly
    // instead of retrying the answer away.
    retry: false,
  })

  const state: QuestionExposureOut | null = exposureQuery.data ?? null

  const declare = useMutation({
    mutationFn: (payload: { seen: boolean; note: string }) =>
      declareQuestionExternalSeen(projectId as string, questionId, payload),
    onSuccess: async (data, payload) => {
      if (data) queryClient.setQueryData(queryKey, data)
      else await queryClient.invalidateQueries({ queryKey })
      setNote('')
      toast.push(
        payload.seen
          ? '已记录「系统外已见」声明：本题不再计入严格独立证据'
          : '已记录更正（污染标记保留，本题仍不会计入严格独立证据）',
        payload.seen ? 'info' : 'ok',
      )
      await queryClient.invalidateQueries({ queryKey: ['evidence-mistakes'] })
      await queryClient.invalidateQueries({ queryKey: ['evidence'] })
    },
  })

  const markSeen = () => declare.mutate({ seen: true, note })
  const recordCorrection = () => declare.mutate({ seen: false, note })

  const failure = declare.isError ? refusalText(declare.error) : null

  return (
    <div className="card" data-testid="exposure-panel" data-question-id={questionId}>
      <h3 style={{ marginTop: 0 }}>为什么这题不算严格独立</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        这一块解释「严格独立证据」的口径：本题在系统内是否已被曝光。判定由服务端给出，这里只展示原因与依据。
      </p>

      {exposureQuery.isLoading ? <p className="muted">正在读取曝光记录…</p> : null}

      {exposureQuery.isError ? (
        <div className="notice danger" data-testid="exposure-error">
          {refusalText(exposureQuery.error).message}
        </div>
      ) : null}

      {!exposureQuery.isLoading && !exposureQuery.isError && !state ? (
        <div className="notice danger" data-testid="exposure-error">
          服务端没有返回本题的曝光状态：无法判断是否可以计入严格独立证据，因此这里不会显示为「未见」。
        </div>
      ) : null}

      {state ? (
        <>
          <ExposureStateBlock state={state} currentProjectId={projectId} />

          <label className="field">
            <span>备注（可选）：写清你是在哪里见过这题，或这次更正的理由</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：上周在培训班讲义上做过这道题"
              data-testid="exposure-note"
              data-question-id={questionId}
              style={{ minHeight: 60 }}
            />
          </label>

          {failure ? (
            <div className="notice danger" data-testid="exposure-error">
              {failure.message}
              {failure.problems.length ? (
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {failure.problems.map((problem, index) => (
                    <li key={`${problem.code}-${index}`}>
                      {problem.message}（{problem.code}）
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="row">
            <button
              className="btn"
              data-testid="exposure-mark-seen"
              disabled={declare.isPending}
              onClick={markSeen}
            >
              标记为「系统外已见」
            </button>
            <button
              className="btn ghost"
              data-testid="exposure-correct"
              disabled={declare.isPending}
              onClick={recordCorrection}
            >
              记录更正
            </button>
          </div>
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            声明一旦提交就无法撤销：本题会永久不再计入严格独立证据，也不能重新标为「严格未见」。
            「记录更正」只是把更正追加到账本（保留时间与备注）：污染标记仍然保留，判定结果不变。
            这两项操作只影响证据口径，不影响你继续练习本题。
          </p>
        </>
      ) : null}
    </div>
  )
}
