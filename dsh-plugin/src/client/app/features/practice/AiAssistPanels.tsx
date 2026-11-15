/**
 * P1 batch 3 AI assistance surfaces (B07 / B08).
 *
 * Three rules shape every panel here:
 *
 *  * a model result is *inert* until a human decides — it is labelled as such
 *    and never written into a confirmed score;
 *  * a missing value is shown as `—` with the reason, never as a zero;
 *  * a stub run is named a stub, never presented as a real model answer.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  answerDiagnosisFollowUp,
  confirmTranscription,
  fetchAiEstimate,
  fetchTranscriptions,
  fetchTutorSegments,
  missingAssetIdsOf,
  rejectTranscription,
  requestAiDiagnosis,
  requestAiEstimate,
  requestTranscription,
  setAttemptDiagnosis,
  skipDiagnosisFollowUp,
  type AiDiagnosisOut,
  type AiEstimateOut,
  type DiagnosisCause,
  type DiagnosisFollowUp,
  type TranscriptionOut,
  type TutorJobOut,
  type TutorSegmentOut,
  type TutorSegmentsOut,
} from '../../api/client'
import {
  initialTutorStreamState,
  openTutorStream,
  type TutorStreamHandle,
  type TutorStreamState,
} from '../../api/tutorStream'
import { describeError, useToast } from '../../app/context'
import { Blocks } from '../../components/Content'

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function percentOrDash(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—（模型未给出置信度）'
  return `${Math.round(value * 100)}%`
}

/** Refusals that name the photos which still need a confirmed transcription. */
function TranscriptionRequiredNotice({ error }: { error: ApiError }) {
  const ids = missingAssetIdsOf(error)
  return (
    <div className="notice warn" data-testid="transcription-required-notice">
      <strong>{error.message}</strong>
      {ids.length ? (
        <div className="small">
          尚未确认转写的照片：{ids.map(shortId).join('、')}。请先在「手写转写确认」面板确认后再试。
        </div>
      ) : (
        <div className="small">请先在上方「手写转写确认」面板确认全部照片的转写。</div>
      )}
    </div>
  )
}

function aiFailureText(error: unknown): { text: string; notConfigured: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'ai_not_configured') {
      return { text: `未配置 AI：${error.message}`, notConfigured: true }
    }
    return { text: error.message, notConfigured: false }
  }
  return { text: describeError(error), notConfigured: false }
}

/* ======================================================== 手写转写确认（B07） */
const TRANSCRIPTION_STATUS: Record<string, { label: string; tone: string }> = {
  proposed: { label: '待确认（不计入评分）', tone: 'warn' },
  confirmed: { label: '已确认', tone: 'ok' },
  edited: { label: '已确认（人工修改）', tone: 'ok' },
  rejected: { label: '已否决（不用于估分/诊断）', tone: 'neutral' },
}

/**
 * One proposal per uploaded photo, with the model's own doubts kept visible.
 * A proposal is inert: only the human-confirmed text may feed estimation or
 * diagnosis, which is also what the backend's `409 transcription_required`
 * enforces.
 */
export function TranscriptionPanel({
  projectId,
  attemptId,
  assetIds,
  heading = '手写转写确认',
}: {
  projectId: string | null
  attemptId: string | null
  assetIds: string[]
  heading?: string
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  /** Manual entry text, keyed by asset id: usable before any row exists. */
  const [manualDrafts, setManualDrafts] = useState<Record<string, string>>({})
  const [manualError, setManualError] = useState<{ assetId: string; message: string } | null>(null)
  const [visionNotice, setVisionNotice] = useState('')
  const [pendingAssetId, setPendingAssetId] = useState<string | null>(null)

  const enabled = Boolean(projectId && attemptId)
  const listQuery = useQuery({
    queryKey: ['transcriptions', projectId, attemptId],
    queryFn: () => fetchTranscriptions(projectId as string, attemptId as string),
    enabled,
  })

  // Another attempt starts a fresh confirmation, never the previous one's state.
  useEffect(() => {
    setDrafts({})
    setNotes({})
    setManualDrafts({})
    setManualError(null)
    setVisionNotice('')
  }, [projectId, attemptId])

  const rows = listQuery.data?.transcriptions ?? []
  const pending = listQuery.data?.pending_asset_ids ?? []
  const serverAssetIds = listQuery.data?.attachment_asset_ids ?? []

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transcriptions', projectId, attemptId] })

  const generate = useMutation({
    mutationFn: (assetId: string) => requestTranscription(projectId as string, attemptId as string, assetId),
    onMutate: (assetId: string) => setPendingAssetId(assetId),
    onSuccess: async () => {
      setVisionNotice('')
      setManualError(null)
      await refresh()
      toast.push('已生成转写建议：请核对（可修改）后确认', 'ok')
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ai_not_configured') {
        // Keep the server's own wording; the manual entry below is the way out.
        setVisionNotice(error.message)
        return
      }
      toast.push(describeError(error), 'error')
    },
    onSettled: () => setPendingAssetId(null),
  })

  /**
   * The learner's own transcription: no model is called and the row comes back
   * already confirmed, so the estimate/diagnosis gate opens immediately.
   * A blank text is still sent — the server decides, and its answer (a refusal
   * or a proposal) is shown instead of a silent no-op.
   */
  const manual = useMutation({
    mutationFn: (payload: { assetId: string; text: string }) =>
      requestTranscription(projectId as string, attemptId as string, payload.assetId, payload.text),
    onSuccess: async (row, variables) => {
      setManualError(null)
      setVisionNotice('')
      setManualDrafts((current) => ({ ...current, [variables.assetId]: '' }))
      await refresh()
      // The server decides what a submission became: a confirmed manual entry,
      // or (blank text with a vision model configured) a model proposal.
      if (row.is_confirmed) {
        toast.push(
          row.origin === 'manual'
            ? '已按人工录入确认转写：估分与诊断将以这段文本为准'
            : '转写已确认：估分与诊断将以确认后的文本为准',
          'ok',
        )
        return
      }
      toast.push('服务端返回了转写建议：请核对后确认', 'info')
    },
    onError: (error, variables) => {
      setManualError({ assetId: variables.assetId, message: aiFailureText(error).text })
      if (error instanceof ApiError && error.code === 'ai_not_configured') {
        // A blank text fell through to the model path and no vision model is
        // configured: say exactly what the server said.
        setVisionNotice(error.message)
      }
    },
  })

  const confirm = useMutation({
    mutationFn: (payload: { row: TranscriptionOut; text: string; note: string }) =>
      confirmTranscription(projectId as string, attemptId as string, payload.row.id, {
        text: payload.text,
        note: payload.note,
      }),
    onSuccess: async () => {
      await refresh()
      toast.push('转写已确认：估分与诊断将以确认后的文本为准', 'ok')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const reject = useMutation({
    mutationFn: (payload: { row: TranscriptionOut; note: string }) =>
      rejectTranscription(projectId as string, attemptId as string, payload.row.id, payload.note),
    onSuccess: async () => {
      await refresh()
      toast.push('已否决该转写：它不会参与估分或诊断', 'info')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  // Every photo of the attempt is listed, plus any proposal the server kept for
  // an asset the current view no longer shows (never hide a decision that exists).
  const orderedAssetIds = useMemo(() => {
    const seen = new Set(assetIds)
    const extra = rows.map((row) => row.asset_id).filter((id) => id && !seen.has(id))
    return [...assetIds, ...extra]
  }, [assetIds, rows])

  // The server's own attachment list wins when it has one: the panel must not
  // describe a different set of photos than the one the gate is computed from.
  const listedAssetIds = serverAssetIds.length ? serverAssetIds : orderedAssetIds

  const summary = (() => {
    if (visionNotice) return '未配置视觉模型：请人工录入'
    if (!listedAssetIds.length) return '本题没有照片，无需转写'
    if (!rows.length) return '尚未请求转写'
    if (pending.length) return '待确认（不计入评分）'
    if (rows.some((row) => row.is_confirmed)) return '已确认'
    if (rows.some((row) => row.status === 'rejected')) return '转写已否决'
    return '待确认（不计入评分）'
  })()

  return (
    <section className="card surface-subtle" data-testid="transcription-panel">
      <div className="row between">
        <h3 style={{ margin: 0 }}>{heading}</h3>
        <span className={`pill ${visionNotice ? 'warn' : 'neutral'}`} data-testid="transcription-status">
          {summary}
        </span>
      </div>
      <p className="small muted">
        AI 转写只是建议：确认前不计入评分，也不会用于估分或诊断。字迹不清时请先修改再确认；
        没有视觉模型时，直接在文本框里人工录入并确认即可。
      </p>

      {!enabled ? <p className="small muted">提交作答后才能确认手写转写。</p> : null}
      {enabled && !listedAssetIds.length ? (
        <p className="small muted" data-testid="transcription-empty">
          本题没有上传照片，无需转写确认。
        </p>
      ) : null}

      {visionNotice ? (
        <div className="notice warn" data-testid="transcription-not-configured">
          未配置视觉模型：请人工录入。
          <div className="tiny muted">{visionNotice}</div>
          <div className="small">
            在下方照片的文本框中写下照片里的内容，点击「人工录入转写」即可确认（不调用模型）。
          </div>
        </div>
      ) : null}

      {pending.length ? (
        <div className="notice warn" data-testid="transcription-pending">
          还有 {pending.length} 张照片的转写未确认：{pending.map(shortId).join('、')}。未确认前，
          AI 估分与诊断会被服务端拒绝（409 transcription_required）。
        </div>
      ) : null}

      {listQuery.isError ? <div className="notice danger">{describeError(listQuery.error)}</div> : null}

      {listedAssetIds.map((assetId, index) => {
        const row = rows.find((item) => item.asset_id === assetId) ?? null
        const status = row ? TRANSCRIPTION_STATUS[row.status] ?? { label: row.status, tone: 'neutral' } : null
        // A proposal has no confirmed text yet: fall back to what the model read.
        const stored = row ? row.confirmed_text || row.raw_text : ''
        const value = row ? (drafts[row.id] ?? stored) : ''
        return (
          <div
            key={assetId}
            className="card surface-raised"
            style={{ marginTop: 10 }}
            data-testid="transcription-row"
            data-asset-id={assetId}
          >
            <div className="row between">
              <strong className="small">照片 {index + 1}</strong>
              <span className="row" style={{ gap: 8 }}>
                {row?.origin === 'manual' ? (
                  <span className="pill neutral" data-testid="transcription-origin">
                    人工录入（非模型识别）
                  </span>
                ) : null}
                {row?.is_stub ? (
                  <span className="pill warn" data-testid="transcription-stub">
                    stub（测试/演示，不是真实模型）
                  </span>
                ) : null}
                {status ? (
                  <span className={`pill ${status.tone}`} data-testid="transcription-row-status">
                    {status.label}
                  </span>
                ) : (
                  <span className="pill neutral" data-testid="transcription-row-status">
                    未请求转写
                  </span>
                )}
              </span>
            </div>

            {!row ? (
              <>
                <p className="small muted" style={{ margin: '6px 0' }}>
                  这张照片还没有转写记录。
                </p>
                {!visionNotice ? (
                  <button
                    className="btn small"
                    data-testid="transcription-generate"
                    disabled={!enabled || (generate.isPending && pendingAssetId === assetId)}
                    onClick={() => generate.mutate(assetId)}
                  >
                    请求 AI 转写
                  </button>
                ) : null}
                <label className="field" style={{ marginTop: 6 }}>
                  <span className="small muted">
                    人工录入转写（你的原文；提交后即为已确认，不调用模型）
                  </span>
                  <textarea
                    data-testid="transcription-text"
                    rows={4}
                    value={manualDrafts[assetId] ?? ''}
                    placeholder="把照片里的手写内容写在这里"
                    onChange={(event) =>
                      setManualDrafts({ ...manualDrafts, [assetId]: event.target.value })
                    }
                  />
                </label>
                <div data-testid="transcription-manual-submit">
                  <button
                    className="btn small primary"
                    data-testid="transcription-confirm"
                    disabled={!enabled || (manual.isPending && manual.variables?.assetId === assetId)}
                    onClick={() =>
                      manual.mutate({ assetId, text: manualDrafts[assetId] ?? '' })
                    }
                  >
                    人工录入转写
                  </button>
                </div>
                {manualError?.assetId === assetId ? (
                  <div className="notice danger" data-testid="transcription-manual-error">
                    {manualError.message}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <label className="field" style={{ marginTop: 6 }}>
                  <span className="small muted">
                    {row.origin === 'manual'
                      ? '人工录入的转写（提交即为已确认）'
                      : '转写文本（可修改；确认后以这里的内容为准）'}
                  </span>
                  <textarea
                    data-testid="transcription-text"
                    value={value}
                    rows={4}
                    placeholder="模型没有读出文字时可在此人工录入"
                    onChange={(event) => setDrafts({ ...drafts, [row.id]: event.target.value })}
                  />
                </label>

                {row.origin === 'manual' ? (
                  <p className="tiny muted" data-testid="transcription-doubts">
                    人工录入：没有模型识别，因此没有模型置信度与不确定处标注。
                  </p>
                ) : row.doubts.length ? (
                  <div data-testid="transcription-doubts">
                    <span className="small">
                      <strong>模型标注的不确定处：</strong>
                    </span>
                    <ul className="small" style={{ margin: '4px 0' }}>
                      {row.doubts.map((doubt, doubtIndex) => (
                        <li key={doubtIndex}>{doubt}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="tiny muted" data-testid="transcription-doubts">
                    模型没有标注不确定处（这不代表转写一定正确，仍需人工核对）。
                  </p>
                )}

                <p className="tiny muted">
                  {row.origin === 'manual'
                    ? '来源：学习者人工录入（未使用模型）'
                    : `置信度：${percentOrDash(row.confidence)}`}
                  {row.decided_at ? ` · 处理时间 ${new Date(row.decided_at).toLocaleString()}` : ''}
                  {row.note ? ` · 备注：${row.note}` : ''}
                </p>

                {!row.is_confirmed ? (
                  <>
                    <label className="field">
                      <span className="small muted">备注（可选，随确认一起提交）</span>
                      <input
                        value={notes[row.id] ?? ''}
                        placeholder="例如：第三行符号看不清，按扣分点原文录入"
                        onChange={(event) => setNotes({ ...notes, [row.id]: event.target.value })}
                      />
                    </label>

                    <div className="row">
                      <button
                        className="btn primary small"
                        data-testid="transcription-confirm"
                        disabled={confirm.isPending || value.trim().length === 0}
                        title={value.trim().length === 0 ? '转写为空：请先录入文字' : undefined}
                        onClick={() =>
                          confirm.mutate({ row, text: value.trim(), note: notes[row.id] ?? '' })
                        }
                      >
                        确认转写
                      </button>
                      <button
                        className="btn small"
                        data-testid="transcription-reject"
                        disabled={reject.isPending}
                        onClick={() => reject.mutate({ row, note: notes[row.id] ?? '' })}
                      >
                        否决转写
                      </button>
                      <button
                        className="btn small ghost"
                        disabled={generate.isPending && pendingAssetId === assetId}
                        onClick={() => generate.mutate(assetId)}
                      >
                        重新请求转写
                      </button>
                    </div>
                    {value.trim().length === 0 ? (
                      <p className="tiny muted">转写为空：请先人工录入文字，再确认。</p>
                    ) : null}
                  </>
                ) : row.origin === 'manual' ? (
                  <div data-testid="transcription-manual-submit">
                    <button
                      className="btn small"
                      data-testid="transcription-confirm"
                      disabled={manual.isPending && manual.variables?.assetId === assetId}
                      onClick={() => manual.mutate({ assetId, text: value })}
                    >
                      重新录入转写
                    </button>
                    <p className="tiny muted" style={{ marginBottom: 0 }}>
                      已确认的人工录入会一直生效，直到你重新录入；修改后估分与诊断会以新文本为准。
                    </p>
                  </div>
                ) : (
                  <p className="tiny muted" style={{ marginBottom: 0 }}>
                    已确认的模型转写不能改写；如需修改请重新提交作答。
                  </p>
                )}
                {manualError?.assetId === assetId ? (
                  <div className="notice danger" data-testid="transcription-manual-error">
                    {manualError.message}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )
      })}
    </section>
  )
}

/* ==================================================== AI 逐点估分（B07） */
/**
 * A `409 transcription_required` refusal stops being true the moment every
 * photo is confirmed. The panel that shows it reads the shared transcriptions
 * cache (the confirmation panel keeps it fresh) and drops the stale refusal
 * instead of telling the learner to do something they just did.
 */
function useClearedTranscriptionRefusal(
  projectId: string | null,
  attemptId: string | null,
  failure: unknown,
  clear: () => void,
) {
  const shared = useQuery({
    queryKey: ['transcriptions', projectId, attemptId],
    queryFn: () => fetchTranscriptions(projectId as string, attemptId as string),
    // Read-only observer: the confirmation panel owns fetching this key.
    enabled: false,
  })
  useEffect(() => {
    if (!(failure instanceof ApiError) || failure.code !== 'transcription_required') return
    if (shared.data && shared.data.pending_asset_ids.length === 0) clear()
  }, [failure, shared.data, clear])
}

/**
 * A per-criterion reference estimate. It is inert by construction: the panel
 * only offers to *prefill* the human's own inputs, and the banner never goes
 * away because the estimate never becomes a confirmed score by itself.
 */
export function AiEstimatePanel({
  projectId,
  attemptId,
  partIds,
  criterionDescriptions = {},
  onPrefill,
}: {
  projectId: string | null
  attemptId: string | null
  /** The manual inputs the reviewer confirms: prefill only targets these ids. */
  partIds: string[]
  /** Human rubric wording by criterion id (the estimate payload omits it). */
  criterionDescriptions?: Record<string, string>
  onPrefill: (values: Record<string, string>) => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<unknown>(null)

  const enabled = Boolean(projectId && attemptId)
  const queryKey = ['ai-estimate', projectId, attemptId] as const
  const estimateQuery = useQuery({
    queryKey,
    queryFn: () => fetchAiEstimate(projectId as string, attemptId as string),
    enabled,
  })

  // A refusal (or an estimate) belongs to one attempt, never to the next row.
  useEffect(() => {
    setFailure(null)
  }, [projectId, attemptId])
  // …and a transcription refusal is dropped once the photos are confirmed.
  useClearedTranscriptionRefusal(projectId, attemptId, failure, () => setFailure(null))

  const request = useMutation({
    mutationFn: () => requestAiEstimate(projectId as string, attemptId as string),
    onSuccess: (data) => {
      setFailure(null)
      queryClient.setQueryData(queryKey, data)
      toast.push('已生成参考估计：未确认，不计入正式分数', 'info')
    },
    onError: (error) => setFailure(error),
  })

  const estimate: AiEstimateOut | null = estimateQuery.data ?? null
  const criteria = estimate?.criteria ?? []
  const hasNumber = criteria.some((row) => row.estimated_score !== null)
  const partIdSet = useMemo(() => new Set(partIds), [partIds])

  const prefill = () => {
    if (!estimate) return
    const values: Record<string, string> = {}
    let unmapped = 0
    for (const criterion of estimate.criteria) {
      if (criterion.estimated_score === null) continue
      if (!partIdSet.has(criterion.criterion_id)) {
        unmapped += 1
        continue
      }
      values[criterion.criterion_id] = criterion.estimated_score
    }
    const filled = Object.keys(values).length
    if (!filled) {
      toast.push('估计的评分点与本题的评分点无法对应，未预填任何数值', 'error')
      return
    }
    onPrefill(values)
    toast.push(`已按参考估计预填 ${filled} 个评分点：仍需你核对并确认`, 'info')
    if (unmapped) toast.push(`${unmapped} 个估计评分点不在本题评分点中，已跳过`, 'error')
  }

  const errorText = failure ? aiFailureText(failure) : null

  return (
    <section className="card surface-subtle" data-testid="ai-estimate-panel">
      <div className="row between">
        <h3 style={{ margin: 0 }}>AI 逐点估分</h3>
        <button
          className="btn small"
          data-testid="ai-estimate-request"
          disabled={!enabled || request.isPending}
          onClick={() => request.mutate()}
        >
          {request.isPending ? '正在请求…' : 'AI 逐点估分'}
        </button>
      </div>

      {/* The banner is permanent: an estimate is never a confirmed score. */}
      <div className="notice info" data-testid="ai-estimate-inert-notice">
        参考估计：未确认，不计入正式分数。人工确认前只有 estimated_score，正式分与掌握状态不受影响。
      </div>

      {!enabled ? <p className="small muted">提交作答后才能请求估分。</p> : null}
      {estimateQuery.isLoading ? <p className="small muted">正在读取已有估计…</p> : null}
      {estimateQuery.isError ? <div className="notice danger">{describeError(estimateQuery.error)}</div> : null}

      {errorText ? (
        failure instanceof ApiError && failure.code === 'transcription_required' ? (
          <TranscriptionRequiredNotice error={failure} />
        ) : (
          <div className="notice danger" data-testid="ai-estimate-error">
            {errorText.text}
          </div>
        )
      ) : null}

      {estimate ? (
        <>
          <p className="small muted">
            状态：{estimate.status || '—'} · 方法：{estimate.method || '—'} · 模型：
            {estimate.model_identifier || '—'} · rubric 版本：{estimate.rubric_revision ?? '—'} · 置信度：
            {percentOrDash(estimate.confidence)}
          </p>

          {estimate.is_stub ? (
            <div className="notice warn" data-testid="ai-estimate-stub">
              stub（测试/演示，不是真实模型）
            </div>
          ) : null}

          {!criteria.length || !hasNumber ? (
            <div className="notice warn" data-testid="ai-estimate-empty">
              模型没有给出评分点估计。
              {criteria.length ? '（下列评分点都没有估计值，不以 0 分代替）' : ''}
            </div>
          ) : null}

          {criteria.length ? (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>评分点</th>
                    <th>满分</th>
                    <th>估计分</th>
                    <th>依据</th>
                    <th>缺失证据</th>
                  </tr>
                </thead>
                <tbody>
                  {criteria.map((row) => (
                    <tr key={row.criterion_id} data-testid="ai-estimate-criterion-row">
                      <td className="small">
                        {criterionDescriptions[row.criterion_id] || row.description || row.criterion_id}
                        <div className="tiny muted">{row.criterion_id}</div>
                      </td>
                      <td className="small">{row.max_score || '—'}</td>
                      <td className="small">
                        {row.estimated_score ?? '—'}
                        {row.estimated_score === null ? (
                          <div className="tiny muted">模型没有给出该评分点的估计</div>
                        ) : null}
                      </td>
                      <td className="small">{row.rationale || '—（模型没有给出依据）'}</td>
                      <td className="small">
                        {row.missing_evidence.length ? row.missing_evidence.join('；') : '—（未标注缺失证据）'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <p className="small">
            参考估计合计：{estimate.estimated_total ?? '—（模型未给出合计）'}（正式分
            {estimate.confirmed_total_unchanged ? '未改变' : '状态未知，请以人工确认为准'}）
            {estimate.overall_note ? ` · 总评：${estimate.overall_note}` : ''}
          </p>

          <div className="row">
            <button className="btn small" data-testid="ai-estimate-prefill" onClick={prefill} disabled={!hasNumber}>
              按估计值预填
            </button>
            <span className="tiny muted">预填只写入下方输入框，不会替你提交确认。</span>
          </div>
        </>
      ) : null}
    </section>
  )
}

/* ================================================== AI 诊断与追问（B07） */
const ERROR_TYPE_LABELS: Record<string, string> = {
  concept_gap: '概念没掌握',
  misread_question: '看错题目要求',
  calculation_slip: '计算/抄写失误',
  unit_or_sign_error: '单位/符号错误',
  incomplete_reasoning: '过程不完整',
  method_misapplied: '方法用错',
  guessing: '猜答案',
  unknown: '证据不足，暂不判断',
}

const FOLLOW_UP_STATUS: Record<string, string> = {
  pending: '待回答',
  answered: '已回答',
  skipped: '已跳过',
}

/**
 * Possible error causes plus follow-up questions. Diagnosis is descriptive
 * only: confirming a cause writes an `ErrorDiagnosis` row and never touches a
 * score, a grade event or a knowledge state.
 */
export function DiagnosisPanel({
  projectId,
  attemptId,
}: {
  projectId: string | null
  attemptId: string | null
}) {
  const toast = useToast()
  const [diagnosis, setDiagnosis] = useState<AiDiagnosisOut | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [decisions, setDecisions] = useState<Record<string, string>>({})
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [followUpStatus, setFollowUpStatus] = useState<Record<string, string>>({})

  const enabled = Boolean(projectId && attemptId)

  // Diagnosis belongs to one attempt: switching items clears the transcript.
  useEffect(() => {
    setDiagnosis(null)
    setFailure(null)
    setDecisions({})
    setAnswers({})
    setFollowUpStatus({})
  }, [projectId, attemptId])
  // A transcription refusal stops applying as soon as the photos are confirmed.
  useClearedTranscriptionRefusal(projectId, attemptId, failure, () => setFailure(null))

  const request = useMutation({
    mutationFn: () => requestAiDiagnosis(projectId as string, attemptId as string),
    onSuccess: (data) => {
      setFailure(null)
      setDiagnosis(data)
      // A cause the server already decided keeps its decision; fresh model
      // candidates arrive as `proposed` and wait for the human.
      setDecisions(
        Object.fromEntries(
          data.causes.filter((cause) => cause.status !== 'proposed').map((cause) => [cause.error_type, cause.status]),
        ),
      )
      setFollowUpStatus({})
      setAnswers({})
      toast.push('已生成可能原因与追问（都需要你确认）', 'info')
    },
    onError: (error) => setFailure(error),
  })

  const decide = useMutation({
    mutationFn: (payload: { cause: DiagnosisCause; status: 'confirmed' | 'rejected' }) =>
      setAttemptDiagnosis(projectId as string, attemptId as string, {
        error_type: payload.cause.error_type,
        status: payload.status,
        note: '在诊断面板人工确认',
      }),
    onSuccess: (row, variables) => {
      setDecisions((current) => ({ ...current, [variables.cause.error_type]: row.status || variables.status }))
      toast.push(
        variables.status === 'confirmed' ? '已记录：确认此原因（不影响分数）' : '已记录：否定此原因（不影响分数）',
        'ok',
      )
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const answer = useMutation({
    mutationFn: (payload: { followUp: DiagnosisFollowUp; text: string }) =>
      answerDiagnosisFollowUp(projectId as string, payload.followUp.id, payload.text),
    onSuccess: (row, variables) => {
      setFollowUpStatus((current) => ({ ...current, [variables.followUp.id]: row.status || 'answered' }))
      toast.push('追问已记录', 'ok')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const skip = useMutation({
    mutationFn: (followUp: DiagnosisFollowUp) => skipDiagnosisFollowUp(projectId as string, followUp.id),
    onSuccess: (row, variables) => {
      setFollowUpStatus((current) => ({ ...current, [variables.id]: row.status || 'skipped' }))
      toast.push('已跳过该追问', 'info')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const errorText = failure ? aiFailureText(failure) : null

  return (
    <section className="card surface-subtle" data-testid="diagnosis-panel">
      <div className="row between">
        <h3 style={{ margin: 0 }}>诊断与追问</h3>
        <button
          className="btn small"
          data-testid="diagnosis-request"
          disabled={!enabled || request.isPending}
          onClick={() => request.mutate()}
        >
          {request.isPending ? '正在请求…' : 'AI 诊断'}
        </button>
      </div>

      <div className="notice info">
        诊断只描述可能原因，永远不会改变分数或掌握状态；所有原因都需要你人工确认或否定。
      </div>

      {!enabled ? <p className="small muted">提交作答后才能请求诊断。</p> : null}

      {errorText ? (
        failure instanceof ApiError && failure.code === 'transcription_required' ? (
          <TranscriptionRequiredNotice error={failure} />
        ) : (
          <div className="notice danger" data-testid="diagnosis-error">
            {errorText.text}
          </div>
        )
      ) : null}

      {diagnosis ? (
        <>
          {diagnosis.is_stub ? (
            <div className="notice warn" data-testid="diagnosis-stub">
              stub（测试/演示，不是真实模型）
            </div>
          ) : null}
          {diagnosis.causes.length ? (
            diagnosis.causes.map((cause) => {
              const decision = decisions[cause.error_type]
              const label = ERROR_TYPE_LABELS[cause.error_type] ?? cause.error_type
              const unknown = cause.error_type === 'unknown'
              return (
                <div
                  key={cause.error_type}
                  className="card surface-raised"
                  style={{ marginTop: 8 }}
                  data-testid="diagnosis-cause-row"
                >
                  <div className="row between">
                    <span className="small">
                      <span className={`pill ${decision ? (decision === 'confirmed' ? 'ok' : 'neutral') : 'warn'}`}>
                        {decision === 'confirmed' ? '已确认' : decision ? '已否定' : '可能原因·待确认'}
                      </span>{' '}
                      <strong>{unknown ? '证据不足，暂不判断' : label}</strong>
                      <span className="tiny muted">（{cause.error_type}）</span>
                    </span>
                    <span className="small muted">置信度：{percentOrDash(cause.confidence)}</span>
                  </div>
                  {cause.evidence.length ? (
                    <ul className="small" style={{ margin: '6px 0' }}>
                      {cause.evidence.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="tiny muted" style={{ margin: '6px 0' }}>
                      —（模型没有给出可核对的证据{unknown ? '，因此不做判断' : ''}）
                    </p>
                  )}
                  <div className="row">
                    <button
                      className="btn small primary"
                      data-testid="diagnosis-confirm"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ cause, status: 'confirmed' })}
                    >
                      确认为此原因
                    </button>
                    <button
                      className="btn small"
                      data-testid="diagnosis-reject"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ cause, status: 'rejected' })}
                    >
                      否定
                    </button>
                    {decision ? (
                      <span
                        className={`pill ${decision === 'confirmed' ? 'ok' : 'neutral'}`}
                        data-testid="diagnosis-decision"
                      >
                        {decision === 'confirmed'
                          ? '已确认为此原因'
                          : decision === 'rejected'
                            ? '已否定'
                            : decision === 'unknown'
                              ? '已记录：证据不足'
                              : decision}
                      </span>
                    ) : null}
                  </div>
                </div>
              )
            })
          ) : (
            <div className="notice warn" data-testid="diagnosis-empty">
              模型没有给出可能原因（证据不足时不给结论）。
              {diagnosis.note ? <div className="tiny muted">{diagnosis.note}</div> : null}
            </div>
          )}

          {diagnosis.follow_up_questions.length ? (
            <div style={{ marginTop: 10 }}>
              <h4>追问（补充过程证据，不影响分数）</h4>
              {diagnosis.follow_up_questions.map((question) => {
                const status = followUpStatus[question.id] ?? question.status
                return (
                  <div
                    key={question.id}
                    className="card surface-raised"
                    style={{ marginTop: 8 }}
                    data-testid="diagnosis-follow-up"
                  >
                    <div className="row between">
                      <strong className="small">{question.question}</strong>
                      <span className={`pill ${status === 'pending' ? 'warn' : 'neutral'}`}>
                        {FOLLOW_UP_STATUS[status] ?? status}
                      </span>
                    </div>
                    <p className="tiny muted">
                      {question.why ? `为什么问：${question.why}` : '为什么问：—（模型未说明）'}
                      {question.evidence_kind ? ` · 证据类型：${question.evidence_kind}` : ''}
                    </p>
                    <label className="field">
                      <span className="small muted">你的回答</span>
                      <textarea
                        rows={2}
                        value={answers[question.id] ?? ''}
                        placeholder="写下具体过程（例如当时怎么算的）"
                        onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
                      />
                    </label>
                    <div className="row">
                      <button
                        className="btn small primary"
                        data-testid="diagnosis-follow-up-answer"
                        disabled={answer.isPending || !(answers[question.id] ?? '').trim()}
                        onClick={() => answer.mutate({ followUp: question, text: (answers[question.id] ?? '').trim() })}
                      >
                        回答
                      </button>
                      <button
                        className="btn small"
                        data-testid="diagnosis-follow-up-skip"
                        disabled={skip.isPending}
                        onClick={() => skip.mutate(question)}
                      >
                        跳过
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}

          {diagnosis.missing_information.length ? (
            <p className="small" data-testid="diagnosis-missing-information">
              <strong>模型认为还缺的信息：</strong>
              {diagnosis.missing_information.join('；')}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

/* ============================================== 经校验分段 SSE 辅导（B08） */
/**
 * One validated segment. The server stores exactly three kinds — `text`,
 * `math` (the segment text *is* the LaTeX source) and `list` (items) — so each
 * is rendered for what it is rather than as a blob of text.
 */
function SegmentView({ segment }: { segment: TutorSegmentOut }) {
  return (
    <div className="card surface-raised" style={{ marginTop: 8 }} data-testid="tutor-stream-segment">
      <div className="row between">
        <span className="pill neutral">{segment.kind || 'segment'}</span>
        <span className="tiny muted">第 {segment.index} 段</span>
      </div>
      {segment.kind === 'math' && segment.text ? (
        <Blocks blocks={[{ kind: 'math', latex: segment.text }]} />
      ) : null}
      {segment.kind !== 'math' && segment.text ? (
        <p className="small" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>
          {segment.text}
        </p>
      ) : null}
      {segment.items.length ? (
        <ul className="small" style={{ margin: '4px 0 0' }}>
          {segment.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
      {!segment.text && !segment.items.length ? (
        <p className="tiny muted" style={{ margin: 0 }}>
          （该分段没有可显示内容）
        </p>
      ) : null}
    </div>
  )
}

/**
 * Live transcript of a tutor job.
 *
 * Segments arrive only after server-side validation, so a reconnect resumes at
 * `?after=<lastIndex>` and never re-asks the model. Content is never presented
 * as final while it is still streaming, and a stale source hides the partial
 * transcript instead of shipping it.
 */
export function TutorStreamPanel({ projectId, job }: { projectId: string | null; job: TutorJobOut }) {
  const [state, setState] = useState<TutorStreamState>(initialTutorStreamState)
  const [fallback, setFallback] = useState<TutorSegmentsOut | null>(null)
  const [fallbackError, setFallbackError] = useState('')
  const handleRef = useRef<TutorStreamHandle | null>(null)

  useEffect(() => {
    if (!projectId || !job.tutor_job_id) return
    setState(initialTutorStreamState)
    setFallback(null)
    setFallbackError('')
    const handle = openTutorStream({ projectId, jobId: job.tutor_job_id, onState: setState })
    handleRef.current = handle
    return () => {
      handle.close()
      handleRef.current = null
    }
  }, [projectId, job.tutor_job_id])

  // Reconnects exhausted (or the stream never opened): read the stored,
  // already validated segments instead of guessing at the content.
  useEffect(() => {
    if (!state.transportFailed || !projectId) return
    let cancelled = false
    fetchTutorSegments(projectId, job.tutor_job_id)
      .then((data) => {
        if (!cancelled) setFallback(data)
      })
      .catch((error) => {
        if (!cancelled) setFallbackError(describeError(error))
      })
    return () => {
      cancelled = true
    }
  }, [state.transportFailed, projectId, job.tutor_job_id])

  const failed = job.status === 'failed' || Boolean(job.error_code && job.status !== 'succeeded')
  const stale = state.staleSource || state.isStale || job.is_stale || Boolean(fallback?.is_stale)
  // A stale segment is not content: it is dropped rather than displayed.
  const segments = (state.segments.length ? state.segments : (fallback?.segments ?? [])).filter(
    (segment) => !segment.is_stale,
  )
  const finished = state.done || job.status === 'succeeded'
  const streamed = state.segments.length > 0
  const staleReason = state.staleReason || fallback?.stale_reason || ''
  // The frozen source is only known to be current once the stream said so: the
  // stored result is withheld until the first status frame (or a transport
  // failure that triggers the `/segments` read) instead of flashing content that
  // may already be invalidated.
  const sourceChecked =
    state.jobStatus !== '' ||
    state.done ||
    state.timedOut ||
    state.errorCode !== '' ||
    state.transportFailed

  const statusLabel = (() => {
    if (stale) return '内容已失效'
    if (state.timedOut) return '接收超时'
    if (state.errorCode) return '接收失败'
    // "已完成" is only claimed once the stream (or the stored transcript) has
    // confirmed the frozen source is still current.
    if (finished && sourceChecked) return '已完成'
    return '正在接收…'
  })()

  return (
    <div className="card surface-subtle" data-testid="tutor-stream-panel">
      <div className="row between">
        <h3 style={{ margin: 0 }}>辅导结果</h3>
        <span
          className={`pill ${stale || state.errorCode || failed ? 'danger' : finished ? 'ok' : 'warn'}`}
          data-testid="tutor-stream-status"
        >
          {statusLabel}
        </span>
      </div>

      {job.is_stub ? (
        <div className="notice warn" data-testid="tutor-stub-notice">
          stub（测试/演示，不是真实模型）
        </div>
      ) : null}

      {state.reconnected ? (
        <div className="notice info" data-testid="tutor-stream-reconnect">
          已重连（未重复调用模型）
        </div>
      ) : null}

      {stale ? (
        <div className="notice danger" data-testid="tutor-stream-stale">
          内容已失效：题目或答案版本已更新，请重新请求。
          {staleReason ? <div className="tiny muted">{staleReason}</div> : null}
        </div>
      ) : null}

      {failed && !stale ? (
        <div className="notice danger" data-testid="tutor-stream-error">
          {job.error_message || '辅导失败（服务端未给出说明）'}
          {job.error_code === 'ai_not_configured'
            ? '（AI 未配置：手动录题、作答、判分与复习仍可正常使用）'
            : ''}
        </div>
      ) : null}

      {!stale && !failed ? (
        <>
          <p className="tiny muted">
            提供商 {job.provider || '—'} · 模型 {job.model || '—'} · 提示词版本 {job.prompt_version || '—'}
            {job.reveals_answer ? ' · 本次包含答案性内容，已记录答案暴露' : ' · 仅提示，已记录辅助暴露'}
            {state.serverSegmentCount !== null
              ? ` · 服务端分段 ${state.serverSegmentCount}`
              : job.segment_count
                ? ` · 服务端分段 ${job.segment_count}`
                : ''}
            {streamed ? ` · 已接收 ${state.segments.length} 段` : ''}
          </p>

          {state.timedOut ? (
            <div className="notice warn" data-testid="tutor-stream-timeout">
              接收超时：已收到的分段不是最终内容。
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn small"
                  data-testid="tutor-stream-resume"
                  onClick={() => handleRef.current?.resume()}
                >
                  继续接收（不会重复调用模型）
                </button>
              </div>
            </div>
          ) : null}

          {state.errorCode ? (
            <div className="notice danger" data-testid="tutor-stream-error">
              {state.errorText || `实时通道返回错误（${state.errorCode}）`}
            </div>
          ) : null}

          {state.transportFailed ? (
            <div className="notice warn" data-testid="tutor-stream-fallback">
              {state.errorText || '实时通道不可用'}
              {fallbackError ? `：${fallbackError}` : ''}
            </div>
          ) : null}

          {segments.map((segment) => (
            <SegmentView key={segment.index} segment={segment} />
          ))}

          {!segments.length && job.result_blocks.length && sourceChecked ? (
            <>
              <p className="tiny muted">服务端已保存的最终结果（收到分段后以上方分段为准）：</p>
              <Blocks blocks={job.result_blocks} />
            </>
          ) : null}

          {!segments.length && (sourceChecked ? !job.result_blocks.length : true) ? (
            <p className="small muted" data-testid="tutor-stream-empty">
              {!sourceChecked
                ? '正在接收…（正在校验内容来源，尚不显示任何内容）'
                : finished
                  ? '服务端没有返回可显示的内容。'
                  : '正在接收…（还没有通过校验的分段）'}
            </p>
          ) : null}

          {job.missing_information.length ? (
            <p className="small">
              <strong>缺失信息：</strong>
              {job.missing_information.join('；')}
            </p>
          ) : null}
          {job.suggested_next.length ? (
            <p className="small">
              <strong>建议下一步：</strong>
              {job.suggested_next.join('；')}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
