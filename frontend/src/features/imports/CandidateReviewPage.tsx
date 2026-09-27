import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  apiRequest,
  confirmCandidateLayout,
  fetchImportJob,
  isLayoutBlockingIssue,
  isLayoutIssue,
  newIdempotencyKey,
  problemsOf,
  type ApiProblemRow,
  type CandidateOut,
  type KnowledgeNode,
  type SpecOut,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { Blocks, type BlockLike } from '../../components/Content'
import { LayoutDiagnostics, LayoutIssueRows } from './LayoutReview'

/**
 * Proofreading editor.
 *
 * The candidate draft is fully editable, but publishing is refused while any
 * blocking issue remains: missing options, an unverified answer, a rubric whose
 * points do not add up. The original extractor output stays visible for
 * side-by-side comparison.
 *
 * The editor has to be able to build *every* question type the product scores.
 * A version that could only edit the stem forced a human to hand-write JSON for
 * options, blanks and rubric points, which is why the image path stopped at
 * "manual" in practice (R07). Options, blanks, rubric criteria and material
 * child items are now first-class fields, while the raw JSON view remains for
 * anything the form does not cover.
 */

type DraftContent = {
  blocks?: BlockLike[]
  options?: Array<{ id?: string; label?: string; blocks?: BlockLike[] }>
  blanks?: Array<Record<string, unknown>>
}

const OPTION_IDS = ['opt_a', 'opt_b', 'opt_c', 'opt_d', 'opt_e', 'opt_f', 'opt_g', 'opt_h']

const TYPE_LABELS: Record<string, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
  constructed_response: '大题',
  material: '共享材料',
}

/** New P1 review codes, named in Chinese; the server message stays visible below. */
const ISSUE_LABELS: Record<string, string> = {
  answer_match_pending_confirmation: '答案由答案页匹配产生，需人工确认',
  paper_item_score_missing: '真实试卷题项必须填写分值',
  duplicate_paper_position: '该试卷题号已发布过版本，不能重复发布',
  material_without_children: '材料题还没有子题',
  material_children_unpublished: '仍有子题未发布',
  // P2 batch 1 / C01: layout blockers a human clears with 「确认版面无误」.
  page_without_text_layer_needs_manual_entry: '来源页没有文字层，需人工录入',
  multi_column_needs_review: '多栏阅读顺序需人工确认',
  table_or_formula_needs_review: '表格/公式版式需人工确认',
  cross_page_question: '题目跨页接续（仅提醒）',
}

const ANSWER_METHOD_LABELS: Record<string, string> = {
  label: '题号',
  position: '顺序',
}

function IssueItem({ issue }: { issue: { code: string; message: string } }) {
  const label = ISSUE_LABELS[issue.code]
  return (
    <li>
      {label ?? issue.message}（{issue.code}）
      {label && label !== issue.message ? <div className="tiny muted">{issue.message}</div> : null}
    </li>
  )
}

/**
 * A refused request, in the server's own words.
 *
 * A 422 (publication refused) carries `details.problems`: the list is shown
 * verbatim. The UI never decides by itself that a candidate is publishable —
 * the server remains authoritative and its refusal must reach the proofreader.
 */
type PublishFailure = { message: string; problems: ApiProblemRow[] }

function failureOf(error: unknown): PublishFailure {
  return {
    message: error instanceof ApiError ? error.message : describeError(error),
    problems: problemsOf(error),
  }
}

function FailureNotice({ failure, testId }: { failure: PublishFailure; testId: string }) {
  return (
    <div className="notice danger" data-testid={testId}>
      <strong>{failure.message}</strong>
      {failure.problems.length ? (
        <>
          <div className="small">服务端列出的问题：</div>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {failure.problems.map((problem, index) => (
              <li key={`${problem.code}-${index}`}>
                {problem.severity === 'blocking' ? '⛔ ' : problem.severity ? '⚠️ ' : ''}
                {problem.message}
                {problem.code ? `（${problem.code}）` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}

function candidateLabel(row: CandidateOut | undefined, fallbackId: string): string {
  if (!row) return `${fallbackId.slice(0, 8)}…`
  const label = String((row.draft_payload as { display_label?: unknown } | undefined)?.display_label ?? '')
  const position = row.source_position_key ? `卷面题号 ${row.source_position_key}` : ''
  return [label, position].filter(Boolean).join(' · ') || `${fallbackId.slice(0, 8)}…`
}

function textOf(blocks: BlockLike[] | undefined): string {
  const first = (blocks ?? []).find((block) => (block as { kind?: string }).kind === 'text')
  return String((first as { text?: string } | undefined)?.text ?? '')
}

function textBlock(text: string): BlockLike[] {
  return [{ kind: 'text', text } as unknown as BlockLike]
}

export function CandidateReviewPage() {
  const { jobId, candidateId } = useParams<{ jobId: string; candidateId: string }>()
  const { currentProject, currentSubject } = useScope()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [answerJson, setAnswerJson] = useState('')
  const [rubricJson, setRubricJson] = useState('')
  const [nodeIds, setNodeIds] = useState<string[]>([])
  const [saveError, setSaveError] = useState('')
  const [rawMode, setRawMode] = useState(false)
  const [layoutNote, setLayoutNote] = useState('')
  const [layoutFailure, setLayoutFailure] = useState<PublishFailure | null>(null)
  const [publishFailure, setPublishFailure] = useState<PublishFailure | null>(null)
  const seeded = useRef<string | null>(null)

  const projectId = currentProject?.id ?? null

  const candidateQuery = useQuery({
    queryKey: ['candidate', projectId, candidateId],
    queryFn: () => apiRequest<CandidateOut>(`/projects/${projectId}/import-candidates/${candidateId}`),
    enabled: Boolean(projectId && candidateId),
  })

  /**
   * The candidate payload carries the issues but not the per-page diagnosis, so
   * the 「版面检查」 panel reads the job's `page_diagnostics`. The pages shown are
   * still the candidate's own source pages — the payload's page numbers are the
   * only source of page numbers.
   */
  const jobQuery = useQuery({
    queryKey: ['importJob', projectId, jobId],
    queryFn: () => fetchImportJob(projectId as string, jobId as string),
    enabled: Boolean(projectId && jobId),
  })

  const nodesQuery = useQuery({
    queryKey: ['nodes', projectId, currentSubject?.id],
    queryFn: () => apiRequest<KnowledgeNode[]>(`/projects/${projectId}/knowledge-nodes?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  // Material parents and children live in the same candidate list, so the page
  // resolves their 卷面题号 and status without a second route.
  const jobCandidatesQuery = useQuery({
    queryKey: ['candidates', projectId, jobId],
    queryFn: () => apiRequest<CandidateOut[]>(`/projects/${projectId}/import-candidates?job_id=${jobId}`),
    enabled: Boolean(projectId && jobId),
  })

  const jobCandidates = useMemo(() => {
    const map = new Map<string, CandidateOut>()
    for (const row of jobCandidatesQuery.data ?? []) map.set(row.id, row)
    return map
  }, [jobCandidatesQuery.data])

  const specsQuery = useQuery({
    queryKey: ['specs', projectId, currentSubject?.id],
    queryFn: () => apiRequest<SpecOut[]>(`/projects/${projectId}/exam-spec-versions?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  useEffect(() => {
    const candidate = candidateQuery.data
    if (!candidate) return
    // Seed once per revision so a background refetch cannot discard edits.
    const token = `${candidate.id}:${candidate.revision}`
    if (seeded.current === token) return
    seeded.current = token
    setDraft(candidate.draft_payload)
    setAnswerJson(JSON.stringify(candidate.draft_payload.answer_payload ?? {}, null, 2))
    const criteria = candidate.draft_payload.rubric_criteria
    setRubricJson(criteria ? JSON.stringify(criteria, null, 2) : '')
  }, [candidateQuery.data])

  const content = useMemo<DraftContent>(() => ((draft?.content ?? {}) as DraftContent), [draft])
  const questionType = String(draft?.question_type ?? 'single_choice')

  const patchContent = useCallback(
    (patch: Partial<DraftContent>) => {
      setDraft((current) => (current ? { ...current, content: { ...((current.content ?? {}) as DraftContent), ...patch } } : current))
    },
    [],
  )

  const patchBlocks = useCallback(
    (blocks: BlockLike[]) => patchContent({ blocks }),
    [patchContent],
  )

  /**
   * The visible blank editor and the answer JSON are one source of truth.
   *
   * The structured editor used to write `content.blanks` only, so a reviewer who
   * filled in the accepted answer visually saved a question whose official
   * `answer_payload` was still empty — the question graded as "no rule for this
   * blank" (B06). Every visible field is mirrored into the payload, and the
   * JSON stays editable for the advanced cases it exists for.
   */
  const syncBlanksToAnswerJson = useCallback(
    (nextBlanks: Array<Record<string, unknown>>, removedIds: string[] = []) => {
      try {
        const parsed = answerJson.trim() ? JSON.parse(answerJson) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        const payload = parsed as Record<string, unknown>
        const previous = (payload.blanks ?? {}) as Record<string, Record<string, unknown>>
        const merged: Record<string, Record<string, unknown>> = {}
        for (const [key, value] of Object.entries(previous)) {
          if (!removedIds.includes(key)) merged[key] = value
        }
        for (const blank of nextBlanks) {
          const id = String(blank.blank_id ?? '')
          if (!id) continue
          const spec: Record<string, unknown> = { mismatch_policy: 'review', ...(merged[id] ?? {}) }
          spec.accepted_values = ((blank.accepted_values as string[]) ?? []).filter((value) => value !== '')
          if (blank.max_score !== undefined && blank.max_score !== null && String(blank.max_score) !== '') {
            spec.max_score = String(blank.max_score)
          } else {
            delete spec.max_score
          }
          merged[id] = spec
        }
        payload.kind = typeof payload.kind === 'string' && payload.kind ? payload.kind : 'fill_blank'
        payload.blanks = merged
        setAnswerJson(JSON.stringify(payload, null, 2))
      } catch {
        /* the answer JSON is already invalid; leave the author's text alone */
      }
    },
    [answerJson],
  )

  const save = useMutation({
    mutationFn: () => {
      if (!candidateQuery.data || !draft) throw new Error('尚未加载')
      let answerPayload: unknown = {}
      let rubricCriteria: unknown = undefined
      try {
        answerPayload = answerJson.trim() ? JSON.parse(answerJson) : {}
      } catch {
        throw new Error('答案 JSON 格式不正确，请检查括号与引号')
      }
      if (rubricJson.trim()) {
        try {
          rubricCriteria = JSON.parse(rubricJson)
        } catch {
          throw new Error('评分标准 JSON 格式不正确')
        }
      }
      const payload = {
        ...draft,
        answer_payload: answerPayload,
        answer_status_known: Object.keys(answerPayload as Record<string, unknown>).length > 0,
        ...(rubricCriteria ? { rubric_criteria: rubricCriteria } : {}),
      }
      return apiRequest<CandidateOut>(`/projects/${projectId}/import-candidates/${candidateId}`, {
        method: 'PATCH',
        body: {
          draft_payload: payload,
          subject_id: currentSubject?.id ?? null,
          expected_revision: candidateQuery.data.revision,
        },
      })
    },
    onSuccess: async (data) => {
      setSaveError('')
      setDraft(data.draft_payload)
      seeded.current = `${data.id}:${data.revision}`
      toast.push('校对已保存（保留修订记录）', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['candidate', projectId, candidateId] })
    },
    onError: (err) => setSaveError(describeError(err)),
  })

  /**
   * Confirm the layout of the pages this candidate came from.
   *
   * This is the only human act that clears the blocking layout issues, and the
   * server records who confirmed what and when. One fresh Idempotency-Key per
   * attempt: a repetitive click is a new confirmation, a network retry of the
   * same click is not.
   */
  const confirmLayout = useMutation({
    mutationFn: () => confirmCandidateLayout(projectId as string, candidateId as string, layoutNote),
    onSuccess: async (data) => {
      setLayoutFailure(null)
      setLayoutNote('')
      // The response is the server's recomputed candidate: the cleared issues
      // must disappear from the blocking list without a local guess.
      queryClient.setQueryData(['candidate', projectId, candidateId], data)
      await queryClient.invalidateQueries({ queryKey: ['candidate', projectId, candidateId] })
      await queryClient.invalidateQueries({ queryKey: ['candidates', projectId, jobId] })
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      toast.push('已确认版面：本题的版面阻止项已清除，确认时间与备注已写入审计', 'ok')
    },
    onError: (err) => setLayoutFailure(failureOf(err)),
  })

  const publish = useMutation({
    mutationFn: () =>
      apiRequest<CandidateOut & { question_id?: string }>(`/projects/${projectId}/import-candidates/${candidateId}/publish`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('candidate-publish'),
        body: {
          exam_spec_version_id: specsQuery.data?.find((spec) => spec.status === 'published')?.id ?? null,
          node_ids: nodeIds,
          origin_type: (draft?.origin_type as string) ?? 'user_authored',
          display_label: (draft?.display_label as string) ?? '',
        },
      }),
    onSuccess: async (data) => {
      setPublishFailure(null)
      toast.push('已发布为不可变题目版本', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['candidate', projectId, candidateId] })
      await queryClient.invalidateQueries({ queryKey: ['candidates', projectId, jobId] })
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['questions'] })
      if (data.publication_question_id) navigate('/questions')
    },
    /**
     * A refusal is information, not a dead end: show the server's message and
     * its problem list, then re-read the candidate so the visible blockers are
     * the ones the server just enforced.
     */
    onError: async (err) => {
      setPublishFailure(failureOf(err))
      await queryClient.invalidateQueries({ queryKey: ['candidate', projectId, candidateId] })
    },
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>
  if (candidateQuery.isLoading || !draft) return <div className="card empty-state">正在读取候选…</div>
  if (candidateQuery.isError) return <div className="notice danger">{describeError(candidateQuery.error)}</div>

  const candidate = candidateQuery.data!
  const blocking = candidate.review_issues.filter((issue) => issue.severity === 'blocking')
  const warnings = candidate.review_issues.filter((issue) => issue.severity !== 'blocking')
  const options = content.options ?? []
  const blanks = content.blanks ?? []
  const machineText = String((candidate.machine_payload as { raw_excerpt?: string } | undefined)?.raw_excerpt ?? '')
  const firstRegion = candidate.source_regions[0]
  const answerMatch = candidate.answer_match ?? {}
  const answerMatchMethod = answerMatch.method ? (ANSWER_METHOD_LABELS[answerMatch.method] ?? answerMatch.method) : '—'
  const parentCandidate = candidate.parent_candidate_id ? jobCandidates.get(candidate.parent_candidate_id) : undefined
  const childRows = candidate.child_candidate_ids.map((id) => ({ id, row: jobCandidates.get(id) }))
  const unloadedChildren = childRows.filter((child) => !child.row).length

  // The layout panel is scoped to the pages this candidate actually came from:
  // the page numbers come from the payload, never from the row order.
  const layoutIssues = candidate.review_issues.filter(isLayoutIssue)
  const layoutBlocking = layoutIssues.filter(isLayoutBlockingIssue)
  const sourcePages = candidate.source_regions
    .map((region) => ({
      document_id: region.document_id,
      document_title: region.document_title,
      page_index: region.page_index,
    }))
    .filter(
      (page, index, all) =>
        all.findIndex(
          (other) => other.document_id === page.document_id && other.page_index === page.page_index,
        ) === index,
    )
    .sort((a, b) => a.page_index - b.page_index)
  const layoutConfirmedAt = candidate.layout_review_confirmed_at
  const jobDiagnostics = jobQuery.data?.page_diagnostics

  const setOptionText = (index: number, text: string) => {
    const next = options.map((option, position) =>
      position === index
        ? { id: option.id ?? OPTION_IDS[position] ?? `opt_${position + 1}`, label: option.label ?? OPTION_IDS[position] ?? '', blocks: textBlock(text) }
        : option,
    )
    patchContent({ options: next })
  }

  const addOption = () =>
    patchContent({
      options: [
        ...options,
        {
          id: OPTION_IDS[options.length] ?? `opt_${options.length + 1}`,
          label: String.fromCharCode(65 + options.length),
          blocks: textBlock(''),
        },
      ],
    })

  const removeOption = (index: number) => patchContent({ options: options.filter((_, position) => position !== index) })

  const addBlank = () => {
    const blankId = `b${blanks.length + 1}`
    const next = [
      ...blanks,
      { blank_id: blankId, label: `第 ${blanks.length + 1} 空`, accepted_values: [], max_score: '' },
    ]
    patchContent({ blanks: next })
    // Keep the answer JSON in step so the common case needs no JSON editing.
    syncBlanksToAnswerJson(next)
  }

  const removeBlank = (index: number) => {
    const removed = blanks[index]
    const next = blanks.filter((_, position) => position !== index)
    patchContent({ blanks: next })
    const blankId = String(removed?.blank_id ?? '')
    if (!blankId) return
    syncBlanksToAnswerJson(next, [blankId])
  }

  const setBlankField = (index: number, field: string, value: unknown) => {
    const next = blanks.map((blank, position) => (position === index ? { ...blank, [field]: value } : blank))
    patchContent({ blanks: next })
    syncBlanksToAnswerJson(next)
  }

  return (
    <>
      <div className="page-title">
        <h1>校对候选</h1>
        <span className="sub">
          任务 {jobId?.slice(0, 8)}… · 第 {candidate.revision} 次修订 · 状态 {candidate.status} ·{' '}
          {TYPE_LABELS[questionType] ?? questionType}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={() => setRawMode((value) => !value)}>
          {rawMode ? '使用结构化编辑' : '查看/编辑原始 JSON'}
        </button>
        <button className="btn" onClick={() => navigate(`/imports?job=${jobId}`)}>
          返回列表
        </button>
      </div>

      {candidate.is_stub_output ? (
        <div className="notice warn">
          本候选由测试/演示 stub 生成，不代表真实模型识别结果；请勿作为正式内容发布。
        </div>
      ) : null}
      {blocking.length ? (
        <div className="notice danger">
          <strong>存在阻止发布的问题：</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {blocking.map((issue, index) => (
              <IssueItem key={index} issue={issue} />
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="notice warn">
          <strong>需要确认的疑点：</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {warnings.map((issue, index) => (
              <IssueItem key={index} issue={issue} />
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        C01: what the deterministic parser saw on each source page, and the one
        human act that clears the layout blockers. The panel shows the raw page
        facts before asking for a confirmation, so "确认版面无误" means the
        proofreader compared against the original page — not that the system read
        it.
      */}
      <LayoutDiagnostics
        diagnostics={jobDiagnostics}
        pages={sourcePages}
        loading={jobQuery.isLoading}
        error={jobQuery.isError ? describeError(jobQuery.error) : ''}
        footer={
          <div style={{ marginTop: 10 }}>
            {layoutFailure ? (
              <FailureNotice failure={layoutFailure} testId="layout-confirm-error" />
            ) : null}
            {layoutConfirmedAt ? (
              <div className="notice ok" data-testid="layout-confirmed-note">
                <strong>已确认版面（{new Date(layoutConfirmedAt).toLocaleString()}）</strong>
                {candidate.layout_review_note ? (
                  <div className="small">备注：{candidate.layout_review_note}</div>
                ) : (
                  <div className="small muted">备注：（未填写）</div>
                )}
                <div className="tiny muted">
                  确认只记录「已对照原页核对版式」，不改变题目内容；确认人与时间写入审计。
                </div>
              </div>
            ) : layoutBlocking.length ? (
              <div className="notice warn" data-testid="layout-unconfirmed-notice">
                <strong>本题尚未确认版面。</strong>
                服务器仍在本题上保留 {layoutBlocking.length} 项阻止发布的版面问题，确认前无法发布。
              </div>
            ) : (
              <p className="small muted" style={{ marginTop: 0 }}>
                本题当前没有版面阻止项。如果已对照原页核对过纸张版式，也可以在这里记录一次确认。
              </p>
            )}
            <h3>版面相关的问题</h3>
            <LayoutIssueRows issues={layoutIssues} />
            <label className="field">
              <span>版面确认备注（可选）：写清你对照原页核对了什么</span>
              <textarea
                value={layoutNote}
                onChange={(event) => setLayoutNote(event.target.value)}
                placeholder="例如：已对照原页确认左栏四题在前、右栏四题在后"
                data-testid="layout-confirm-note"
                style={{ minHeight: 60 }}
              />
            </label>
            <div className="row">
              <button
                className="btn primary"
                data-testid="layout-confirm"
                disabled={confirmLayout.isPending}
                onClick={() => confirmLayout.mutate()}
              >
                {layoutConfirmedAt ? '重新确认版面' : '确认版面无误'}
              </button>
              <span className="small muted">
                确认只清除版面阻止项：扫描页仍需你按原页人工录入，表格与公式仍需逐字核对。
              </span>
            </div>
          </div>
        }
      />

      {answerMatch.matched ? (
        <div className="notice warn" data-testid="candidate-answer-match">
          <strong>本题答案由答案页匹配产生，尚未经人工确认。</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            <li>匹配方式：{answerMatchMethod}</li>
            <li>答案原文：{answerMatch.raw ? String(answerMatch.raw) : '—'}</li>
            <li>
              来源页：
              {answerMatch.source_page_index ? `第 ${answerMatch.source_page_index} 页` : '—'}
              {answerMatch.document_title ? `（${answerMatch.document_title}）` : ''}
            </li>
          </ul>
          <p className="small" style={{ margin: '6px 0 0' }}>
            机械匹配只是候选，不构成答案依据。请打开答案原件逐题核对，确认后保存，才能发布为计分题。
          </p>
          <label className="row" style={{ gap: 6, marginTop: 6 }}>
            <input
              type="checkbox"
              checked={Boolean(draft.answer_confirmed_by_match_review)}
              onChange={(event) =>
                setDraft({ ...draft, answer_confirmed_by_match_review: event.target.checked })
              }
              data-testid="confirm-answer-match"
            />
            <span className="small">我已对照答案页核对本题答案（保存校对后生效）</span>
          </label>
        </div>
      ) : null}

      {candidate.parent_candidate_id ? (
        <div className="notice info" data-testid="candidate-material">
          本题是材料题的子题，父材料：
          <Link to={`/imports/${jobId}/candidates/${candidate.parent_candidate_id}`}>
            {candidateLabel(parentCandidate, candidate.parent_candidate_id)}
          </Link>
          。材料本身不计分，包含关系在发布时写入。
        </div>
      ) : null}

      <div className="grid two">
        <div className="card">
          <h2>来源对照</h2>
          {candidate.source_regions.length === 0 ? (
            <p className="small muted">该候选没有来源区域：题目必须可追溯到原文或原图。</p>
          ) : (
            candidate.source_regions.map((region) => (
              <div key={region.id} style={{ marginBottom: 10 }} data-testid="source-region">
                <p className="tiny muted">
                  第 {region.page_index} 页 · 角色 {region.role} · 区域 (
                  {region.x.toFixed(2)}, {region.y.toFixed(2)}, {region.width.toFixed(2)}, {region.height.toFixed(2)})
                </p>
                {region.document_asset_id ? (
                  <>
                    <p className="small">
                      <strong>原图</strong>（对照它录入题干、选项、空位与答案）
                    </p>
                    <img
                      src={`/api/v1/projects/${projectId}/assets/${region.document_asset_id}?purpose=editorial`}
                      alt="来源整页原图"
                      data-testid="source-page-image"
                      style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #dfe3e8' }}
                    />
                  </>
                ) : null}
                {region.text_span ? (
                  <pre className="small" style={{ whiteSpace: 'pre-wrap', background: '#f7f8fa', padding: 8, borderRadius: 8 }}>
                    {region.text_span}
                  </pre>
                ) : null}
                {region.crop_asset_id ? (
                  <img
                    src={`/api/v1/projects/${projectId}/assets/${region.crop_asset_id}?purpose=editorial`}
                    alt="来源裁图"
                    style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #dfe3e8' }}
                  />
                ) : (
                  <p className="tiny muted">
                    该区域没有裁图。整页原图可能同时包含答案，因此不会作为练习资源直接下发。
                  </p>
                )}
              </div>
            ))
          )}
          {machineText ? (
            <>
              <h3>模型原始输出（仅供对照，不代表已核对）</h3>
              <pre className="tiny" style={{ whiteSpace: 'pre-wrap', background: '#f7f8fa', padding: 8, borderRadius: 8 }}>
                {machineText}
              </pre>
            </>
          ) : null}
        </div>

        <div className="card">
          <h2>结构编辑</h2>
          {saveError ? <div className="notice danger">{saveError}</div> : null}
          {candidate.source_position_key || candidate.paper_revision_id ? (
            <p className="small muted" data-testid="candidate-source" style={{ marginTop: 0 }}>
              卷面题号：{candidate.source_position_key || '—'}
              {firstRegion
                ? ` · 来源页：第 ${firstRegion.page_index} 页${
                    firstRegion.document_title ? `（${firstRegion.document_title}）` : ''
                  }`
                : ''}
            </p>
          ) : null}
          <label className="field">
            <span>题号/标签</span>
            <input
              value={String(draft.display_label ?? '')}
              onChange={(event) => setDraft({ ...draft, display_label: event.target.value })}
            />
          </label>
          <label className="field">
            <span>题型</span>
            <select
              value={questionType}
              onChange={(event) => setDraft({ ...draft, question_type: event.target.value })}
              data-testid="question-type-select"
            >
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>题干文本（第一块）</span>
            <textarea
              value={textOf(content.blocks)}
              onChange={(event) => {
                const blocks = [...(content.blocks ?? [])]
                const index = blocks.findIndex((block) => (block as { kind?: string }).kind === 'text')
                if (index >= 0) blocks[index] = textBlock(event.target.value)[0]
                else blocks.unshift(textBlock(event.target.value)[0])
                patchBlocks(blocks)
              }}
              placeholder="从原图/原文抄录题干，保留负号、单位与上下标"
              data-testid="stem-input"
            />
          </label>
          <label className="field">
            <span>练习分值（留空则采用所选规范的题型默认分值）</span>
            <input
              data-testid="practice-max-score"
              value={String(draft.practice_max_score ?? '')}
              onChange={(event) => setDraft({ ...draft, practice_max_score: event.target.value || null })}
            />
          </label>
          {candidate.paper_revision_id && questionType !== 'material' ? (
            <p className="tiny muted">
              本题已登记为真实试卷题位：必须填写分值，否则该周期的分母不完整，周期分析不会计入这份试卷。
            </p>
          ) : null}

          {questionType === 'single_choice' || questionType === 'multiple_choice' ? (
            <div data-testid="option-editor">
              <h4>选项（至少两个，ID 稳定不变）</h4>
              {options.map((option, index) => (
                <div className="inline-field" key={option.id ?? index} style={{ marginBottom: 6 }}>
                  <span className="small muted nowrap">{option.label ?? OPTION_IDS[index]}</span>
                  <input
                    value={textOf(option.blocks)}
                    onChange={(event) => setOptionText(index, event.target.value)}
                    placeholder={`选项 ${option.label ?? OPTION_IDS[index]} 文本`}
                  />
                  <button className="btn small ghost" onClick={() => removeOption(index)} aria-label="删除选项">
                    ×
                  </button>
                </div>
              ))}
              <button className="btn small" onClick={addOption} data-testid="add-option">
                添加选项
              </button>
            </div>
          ) : null}

          {questionType === 'fill_blank' ? (
            <div data-testid="blank-editor">
              <h4>空位（按出现顺序，ID 为 b1、b2…）</h4>
              {blanks.map((blank, index) => (
                <div key={String(blank.blank_id ?? index)} className="inline-field" style={{ marginBottom: 6 }}>
                  <span className="small muted nowrap">{String(blank.blank_id ?? `b${index + 1}`)}</span>
                  <input
                    value={String(blank.label ?? '')}
                    onChange={(event) => setBlankField(index, 'label', event.target.value)}
                    placeholder="空位说明（可选）"
                  />
                  <input
                    value={((blank.accepted_values as string[]) ?? []).join('|')}
                    onChange={(event) =>
                      setBlankField(
                        index,
                        'accepted_values',
                        event.target.value ? event.target.value.split('|').map((value) => value.trim()) : [],
                      )
                    }
                    placeholder="可接受答案，用 | 分隔"
                  />
                  <input
                    value={String(blank.max_score ?? '')}
                    onChange={(event) => setBlankField(index, 'max_score', event.target.value)}
                    placeholder="满分"
                    style={{ maxWidth: 90 }}
                  />
                  <button className="btn small ghost" onClick={() => removeBlank(index)} aria-label="删除空位">
                    ×
                  </button>
                </div>
              ))}
              <button className="btn small" onClick={addBlank} data-testid="add-blank">
                添加空位
              </button>
              <p className="tiny muted">
                没有登记可接受答案的空位在作答后会进入人工复核，不会直接判错；单位与数值规则请在答案 JSON 中补充。
              </p>
            </div>
          ) : null}

          <label className="field">
            <span>答案 JSON（必须与题型匹配，且由你本人核对）</span>
            <textarea
              value={answerJson}
              onChange={(event) => setAnswerJson(event.target.value)}
              style={{ minHeight: rawMode ? 220 : 140 }}
              data-testid="answer-json"
            />
          </label>
          <p className="tiny muted">
            单个正确选项：{'{'}&quot;kind&quot;: &quot;single_choice&quot;, &quot;correct_option_id&quot;: &quot;opt_a&quot;{'}'}
            ；判断题用布尔值；填空题按 blank_id 给出 accepted_values 或 numeric 规则。
          </p>
          {questionType === 'constructed_response' ? (
            <label className="field">
              <span>评分标准 JSON（逐评分点，合计必须等于题目分值）</span>
              <textarea
                value={rubricJson}
                onChange={(event) => setRubricJson(event.target.value)}
                style={{ minHeight: 140 }}
                data-testid="rubric-json"
              />
            </label>
          ) : null}
          {rawMode ? (
            <label className="field">
              <span>完整草稿 JSON（结构化编辑未覆盖的字段在这里改）</span>
              <textarea
                value={JSON.stringify(draft, null, 2)}
                onChange={(event) => {
                  try {
                    setDraft(JSON.parse(event.target.value))
                  } catch {
                    /* keep the last valid object while the author is typing */
                  }
                }}
                style={{ minHeight: 260 }}
              />
            </label>
          ) : null}
          <div className="row">
            <button className="btn" disabled={save.isPending} onClick={() => save.mutate()} data-testid="save-candidate">
              保存校对
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>发布</h2>
        <p className="small muted">
          发布会在同一事务中创建题目身份、不可变版本、答案与 rubric，并写入审计。已发布内容不能原地修改，只能新建版本。
        </p>
        <label className="field">
          <span>考点映射（主要考点权重之和必须为 1；多个考点将平均分配权重）</span>
          <select
            multiple
            value={nodeIds}
            onChange={(event) => setNodeIds(Array.from(event.target.selectedOptions).map((option) => option.value))}
            style={{ minHeight: 120 }}
          >
            {(nodesQuery.data ?? []).map((node) => (
              <option key={node.id} value={node.id}>
                {node.canonical_name}
                {node.is_unclassified ? '（未分类）' : ''}
              </option>
            ))}
          </select>
        </label>
        {specsQuery.data?.filter((spec) => spec.status === 'published').length ? (
          <p className="small">
            将使用已发布规范：
            {specsQuery.data
              .filter((spec) => spec.status === 'published')
              .map((spec) => `${spec.name || `v${spec.version}`}${spec.is_demo ? '（演示规则）' : ''}`)
              .join('、')}
          </p>
        ) : (
          <div className="notice warn">
            该科目还没有已发布的考试规范：未填写练习分值的题目将无法发布。请先到「设置」发布规范。
          </div>
        )}
        {/*
          The server is authoritative: publishing with an unresolved blocker is
          refused with 422 and its own problem list, which is shown above the
          button. The visible notice explains the block *before* the attempt.
        */}
        {layoutBlocking.length ? (
          <div className="notice warn" data-testid="layout-blocked-notice">
            <strong>发布已被阻止：版面检查尚未确认（{layoutBlocking.length} 项）</strong>
            <ul style={{ margin: '6px 0 0 18px' }}>
              {layoutBlocking.map((issue, index) => (
                <IssueItem key={index} issue={issue} />
              ))}
            </ul>
            <p className="small" style={{ margin: '6px 0 0' }}>
              请在「版面检查」中对照原页逐项核对，然后点击「确认版面无误」。在确认之前，服务端会拒绝发布并把阻止项返回本页。
            </p>
          </div>
        ) : null}
        {publishFailure ? <FailureNotice failure={publishFailure} testId="candidate-publish-error" /> : null}
        {/*
          The button stays clickable while blockers exist on purpose: the server
          is authoritative, so a click must reach it and its 422 (message + full
          problem list) must land on this page. Hiding that behind a locally
          disabled button would replace the real refusal with a local guess.
        */}
        <div className="row">
          <button
            className="btn primary"
            data-testid="candidate-publish"
            disabled={publish.isPending}
            onClick={() => publish.mutate()}
            title={
              blocking.length
                ? '服务端会拒绝发布：仍有阻止项未解决，点击可看到服务端返回的完整问题清单'
                : '发布题目版本'
            }
          >
            发布题目版本
          </button>
          {blocking.length ? (
            <span className="pill danger" data-testid="candidate-publish-blocked">
              阻止发布：{blocking.length} 项未解决
            </span>
          ) : null}
        </div>
        <p className="tiny muted">
          发布校验以服务端为准：还有阻止项时点击发布会被拒绝，本页会原样显示服务端的错误信息与问题清单。
        </p>
      </div>

      {questionType === 'material' || candidate.child_candidate_ids.length ? (
        <div className="card" data-testid="candidate-material">
          <h2>材料题子题（{candidate.child_candidate_ids.length}）</h2>
          {candidate.child_candidate_ids.length === 0 ? (
            <div className="empty-state">
              解析没有识别到子题。共享材料本身不计分，必须包含子题才能发布；请按来源原图补全子题候选。
            </div>
          ) : (
            <>
              <p className="small muted">
                子题与材料同属一个候选列表：逐个子题发布后，材料题才能发布。发布顺序不影响材料与子题的包含关系。
              </p>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>卷面题号</th>
                      <th>标签</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {childRows.map((child) => (
                      <tr key={child.id}>
                        <td className="small">{child.row?.source_position_key || '—'}</td>
                        <td className="small">
                          {String((child.row?.draft_payload as { display_label?: unknown } | undefined)?.display_label ?? '') ||
                            '—'}
                        </td>
                        <td>
                          {child.row ? (
                            <span
                              className={`pill ${
                                child.row.status === 'published' ? 'ok' : child.row.status === 'ignored' ? 'neutral' : 'warn'
                              }`}
                            >
                              {child.row.status}
                            </span>
                          ) : (
                            <span className="pill neutral">未在当前列表</span>
                          )}
                        </td>
                        <td>
                          <Link className="btn small" to={`/imports/${jobId}/candidates/${child.id}`}>
                            校对子题
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {unloadedChildren ? (
                <p className="tiny muted">
                  其中 {unloadedChildren} 个子题不在当前候选列表（可能超出列表条数上限），请回到候选列表查找。
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="card">
        <h2>解析预览（发布后学员看到的题干）</h2>
        <Blocks blocks={(content.blocks ?? []) as never} projectId={projectId ?? undefined} />
        {options.length ? (
          <ul className="small">
            {options.map((option, index) => (
              <li key={option.id ?? index}>
                {String(option.label ?? option.id ?? index)}. {textOf(option.blocks)}
              </li>
            ))}
          </ul>
        ) : null}
        {blanks.length ? (
          <ul className="small">
            {blanks.map((blank, index) => (
              <li key={String(blank.blank_id ?? index)}>
                {String(blank.blank_id ?? `b${index + 1}`)}：{String(blank.label ?? '')}
                {blank.max_score ? `（${String(blank.max_score)} 分）` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  )
}
