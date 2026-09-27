import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiRequest, newIdempotencyKey, type CandidateOut, type KnowledgeNode, type SpecOut } from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { Blocks, type BlockLike } from '../../components/Content'

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
  const seeded = useRef<string | null>(null)

  const projectId = currentProject?.id ?? null

  const candidateQuery = useQuery({
    queryKey: ['candidate', projectId, candidateId],
    queryFn: () => apiRequest<CandidateOut>(`/projects/${projectId}/import-candidates/${candidateId}`),
    enabled: Boolean(projectId && candidateId),
  })

  const nodesQuery = useQuery({
    queryKey: ['nodes', projectId, currentSubject?.id],
    queryFn: () => apiRequest<KnowledgeNode[]>(`/projects/${projectId}/knowledge-nodes?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

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
      toast.push('已发布为不可变题目版本', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['candidate', projectId, candidateId] })
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['questions'] })
      if (data.publication_question_id) navigate('/questions')
    },
    onError: (err) => setSaveError(describeError(err)),
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
    patchContent({
      blanks: [
        ...blanks,
        { blank_id: blankId, label: `第 ${blanks.length + 1} 空`, accepted_values: [], max_score: '' },
      ],
    })
    // Keep the answer JSON in step so the common case needs no JSON editing.
    try {
      const parsed = answerJson.trim() ? JSON.parse(answerJson) : { kind: 'fill_blank' }
      if (!parsed.blanks) parsed.blanks = {}
      parsed.blanks[blankId] = { accepted_values: [], mismatch_policy: 'review' }
      setAnswerJson(JSON.stringify(parsed, null, 2))
    } catch {
      /* the answer JSON is already invalid; leave the author's text alone */
    }
  }

  const removeBlank = (index: number) => {
    const removed = blanks[index]
    patchContent({ blanks: blanks.filter((_, position) => position !== index) })
    const blankId = String(removed?.blank_id ?? '')
    if (!blankId) return
    try {
      const parsed = JSON.parse(answerJson)
      if (parsed?.blanks) {
        delete parsed.blanks[blankId]
        setAnswerJson(JSON.stringify(parsed, null, 2))
      }
    } catch {
      /* ignore */
    }
  }

  const setBlankField = (index: number, field: string, value: unknown) =>
    patchContent({
      blanks: blanks.map((blank, position) => (position === index ? { ...blank, [field]: value } : blank)),
    })

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
              <li key={index}>
                {issue.message}（{issue.code}）
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="notice warn">
          <strong>需要确认的疑点：</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {warnings.map((issue, index) => (
              <li key={index}>
                {issue.message}（{issue.code}）
              </li>
            ))}
          </ul>
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
              value={String(draft.practice_max_score ?? '')}
              onChange={(event) => setDraft({ ...draft, practice_max_score: event.target.value || null })}
            />
          </label>

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
        <div className="row">
          <button className="btn primary" disabled={publish.isPending || blocking.length > 0} onClick={() => publish.mutate()}>
            发布题目版本
          </button>
          {blocking.length ? <span className="small muted">先解决阻止发布的问题</span> : null}
        </div>
      </div>

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
