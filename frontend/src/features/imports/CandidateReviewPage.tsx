import { useEffect, useState } from 'react'
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
 */
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
    if (!candidateQuery.data || draft) return
    setDraft(candidateQuery.data.draft_payload)
    setAnswerJson(JSON.stringify(candidateQuery.data.draft_payload.answer_payload ?? {}, null, 2))
    const criteria = candidateQuery.data.draft_payload.rubric_criteria
    if (criteria) setRubricJson(JSON.stringify(criteria, null, 2))
  }, [candidateQuery.data, draft])

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
        body: { draft_payload: payload, subject_id: currentSubject?.id ?? null, expected_revision: candidateQuery.data.revision },
      })
    },
    onSuccess: async (data) => {
      setSaveError('')
      setDraft(data.draft_payload)
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
  const content = (draft.content ?? {}) as { blocks?: BlockLike[]; options?: Array<Record<string, unknown>>; blanks?: Array<Record<string, unknown>> }

  return (
    <>
      <div className="page-title">
        <h1>校对候选</h1>
        <span className="sub">
          任务 {jobId?.slice(0, 8)}… · 第 {candidate.revision} 次修订 · 状态 {candidate.status}
        </span>
        <span className="spacer" />
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
              <div key={region.id} style={{ marginBottom: 10 }}>
                <p className="tiny muted">
                  第 {region.page_index} 页 · 角色 {region.role} · 区域 (
                  {region.x.toFixed(2)}, {region.y.toFixed(2)}, {region.width.toFixed(2)}, {region.height.toFixed(2)})
                </p>
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
              value={String(draft.question_type ?? 'single_choice')}
              onChange={(event) => setDraft({ ...draft, question_type: event.target.value })}
            >
              <option value="single_choice">单选题</option>
              <option value="multiple_choice">多选题</option>
              <option value="true_false">判断题</option>
              <option value="fill_blank">填空题</option>
              <option value="constructed_response">大题</option>
              <option value="material">共享材料</option>
            </select>
          </label>
          <label className="field">
            <span>题干文本（第一块）</span>
            <textarea
              value={String((content.blocks?.[0] as { text?: string } | undefined)?.text ?? '')}
              onChange={(event) => {
                const blocks = [...(content.blocks ?? [])]
                blocks[0] = { kind: 'text', text: event.target.value }
                setDraft({ ...draft, content: { ...content, blocks } })
              }}
            />
          </label>
          <label className="field">
            <span>练习分值（留空则采用所选规范的题型默认分值）</span>
            <input
              value={String(draft.practice_max_score ?? '')}
              onChange={(event) => setDraft({ ...draft, practice_max_score: event.target.value || null })}
            />
          </label>
          <label className="field">
            <span>答案 JSON（必须与题型匹配，且由你本人核对）</span>
            <textarea value={answerJson} onChange={(event) => setAnswerJson(event.target.value)} style={{ minHeight: 140 }} />
          </label>
          <p className="tiny muted">
            单个正确选项：{'{'}&quot;kind&quot;: &quot;single_choice&quot;, &quot;correct_option_id&quot;: &quot;opt_a&quot;{'}'}
            ；判断题用布尔值；填空题按 blank_id 给出 accepted_values。
          </p>
          {String(draft.question_type) === 'constructed_response' ? (
            <label className="field">
              <span>评分标准 JSON（逐评分点，合计必须等于题目分值）</span>
              <textarea value={rubricJson} onChange={(event) => setRubricJson(event.target.value)} style={{ minHeight: 120 }} />
            </label>
          ) : null}
          <div className="row">
            <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
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
        {content.options?.length ? (
          <ul className="small">
            {content.options.map((option, index) => (
              <li key={index}>
                {String(option.label ?? option.id ?? index)}. {String((option.blocks as Array<{ text?: string }>)?.[0]?.text ?? '')}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  )
}
