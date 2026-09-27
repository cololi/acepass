import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  newIdempotencyKey,
  type EvidenceRow,
  type KnowledgeStateRow,
  type SyllabusOut,
  type VerificationPairingOut,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

const SUMMARY_LABELS: Record<string, string> = {
  undiagnosed: '未诊断',
  needs_foundation: '需要补基础',
  completes_with_hints: '提示后能完成',
  independent: '可以独立完成',
  handles_unseen: '可以处理陌生变式',
  delayed_verified: '经过延迟验证',
  needs_review: '需要复习',
}

const SUMMARY_CLASS: Record<string, string> = {
  undiagnosed: 'neutral',
  needs_foundation: 'danger',
  completes_with_hints: 'warn',
  independent: 'ok',
  handles_unseen: 'ok',
  delayed_verified: 'ok',
  needs_review: 'danger',
}

const DIMENSION_LABELS: Record<string, string> = {
  repeat_practice: '重复练习',
  unassisted_completion: '无辅助完成',
  independent_correct: '严格独立正确',
  template_variant: '同模板变式',
  unseen_variant: '陌生变式',
  delayed_verification: '延迟验证',
}

export function KnowledgePage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [selectedNodeId, setSelectedNode] = useState<string | null>(null)
  const [pairForm, setPairForm] = useState({ node_id: '', immediate: '', delayed: '', baseline: '', delay_hours: '24' })

  const projectId = currentProject?.id ?? null

  const mapQuery = useQuery({
    queryKey: ['knowledge-map', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<{ subject_id: string; nodes: Array<Record<string, unknown>> }>(
        `/projects/${projectId}/knowledge-map?subject_id=${currentSubject?.id}`,
      ),
    enabled: Boolean(projectId && currentSubject),
  })

  const statesQuery = useQuery({
    queryKey: ['learning-states', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<{ thresholds: Record<string, number>; rule_version: string; states: KnowledgeStateRow[] }>(
        `/projects/${projectId}/learning-states?subject_id=${currentSubject?.id}`,
      ),
    enabled: Boolean(projectId && currentSubject),
  })

  const evidenceQuery = useQuery({
    queryKey: ['evidence', projectId, selectedNodeId],
    queryFn: () => apiRequest<{ rows: EvidenceRow[] }>(`/projects/${projectId}/evidence?node_id=${selectedNodeId}`),
    enabled: Boolean(projectId && selectedNodeId),
  })

  const syllabusQuery = useQuery({
    queryKey: ['syllabus', projectId, currentSubject?.id],
    queryFn: () => apiRequest<SyllabusOut[]>(`/projects/${projectId}/syllabus-versions?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const pairingsQuery = useQuery({
    queryKey: ['pairings', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<VerificationPairingOut[]>(`/projects/${projectId}/verification-pairings?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const questionsQuery = useQuery({
    queryKey: ['questions-for-pairing', projectId, currentSubject?.id],
    queryFn: () => apiRequest<Array<{ id: string; display_label: string }>>(`/projects/${projectId}/questions?limit=100&subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const addNode = useMutation({
    mutationFn: async (payload: { syllabus_version_id: string; canonical_name: string; parent_id: string | null }) =>
      apiRequest(`/projects/${projectId}/knowledge-nodes`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('node-create'),
        body: { ...payload, kind: 'point' },
      }),
    onSuccess: async () => {
      toast.push('考点已添加', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['knowledge-map'] })
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const createPairing = useMutation({
    mutationFn: () =>
      apiRequest(`/projects/${projectId}/verification-pairings`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('pairing-create'),
        body: {
          subject_id: currentSubject?.id,
          node_id: pairForm.node_id,
          immediate_question_id: pairForm.immediate,
          delayed_question_id: pairForm.delayed || null,
          baseline_question_id: pairForm.baseline || null,
          delay_hours: Number(pairForm.delay_hours) || 24,
          note: '人工配对（Admin/设置页维护）',
        },
      }),
    onSuccess: async () => {
      toast.push('配对验证已建立：A 的讲解或确认评分会触发 B，B 确认后按延迟生成 C', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['pairings'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>
  if (!currentSubject) return <div className="card empty-state">请先选择科目。</div>

  const nodes = mapQuery.data?.nodes ?? []
  const states = statesQuery.data?.states ?? []
  const publishedSyllabus = syllabusQuery.data?.find((syllabus) => syllabus.status === 'published') ?? null
  const selectedState = states.find((state) => state.node_id === selectedNodeId) ?? null
  const selectedNodeName =
    (nodes.find((raw) => (raw as unknown as { id: string }).id === selectedNodeId) as unknown as
      | { name: string }
      | undefined)?.name ?? ''

  return (
    <>
      <div className="page-title">
        <h1>考点地图</h1>
        <span className="sub">
          {currentProject.name} · {currentSubject.name} · 规则版本 {statesQuery.data?.rule_version ?? '—'}
        </span>
      </div>

      <div className="notice info">
        状态由规则函数从真实证据计算（阈值：{statesQuery.data?.thresholds.distinct_questions ?? 3} 道不同题、
        {statesQuery.data?.thresholds.distinct_templates ?? 2} 种模板、至少一次 24 小时后的延迟正确）。
        自评、AI 估计与辅助作答不计入严格独立证据。点击考点可查看证据与排除原因。
      </div>

      <div className="grid two">
        <div className="card">
          <h2>考点列表（{nodes.length}）</h2>
          {nodes.length === 0 ? (
            <div className="empty-state">
              该科目还没有考点。
              {publishedSyllabus ? '可在下方添加。' : '请先在「设置」中创建并发布用户自建大纲。'}
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>考点</th>
                    <th>题目</th>
                    <th>状态</th>
                    <th>独立正确</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((raw) => {
                    const node = raw as unknown as {
                      id: string
                      name: string
                      is_unclassified: boolean
                      question_count: number
                      evidence: { summary: string; best_summary: string; independent_correct_count: number; needs_review: boolean }
                    }
                    const state = states.find((item) => item.node_id === node.id)
                    const summary = state?.summary ?? node.evidence.summary
                    return (
                      <tr
                        key={node.id}
                        onClick={() => setSelectedNode(node.id)}
                        style={{ cursor: 'pointer', background: selectedNodeId === node.id ? '#f5f8ff' : undefined }}
                      >
                        <td>
                          {node.name}
                          {node.is_unclassified ? <span className="pill neutral" style={{ marginLeft: 6 }}>未分类</span> : null}
                        </td>
                        <td>{node.question_count}</td>
                        <td>
                          <span className={`pill ${SUMMARY_CLASS[summary] ?? 'neutral'}`}>
                            {SUMMARY_LABELS[summary] ?? summary}
                          </span>
                          {state?.needs_review ? <span className="pill danger">需要复习</span> : null}
                        </td>
                        <td>{state?.independent_correct_count ?? 0}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {publishedSyllabus ? (
            <div style={{ marginTop: 12 }}>
              <h3>添加考点</h3>
              <form
                className="row"
                onSubmit={(event) => {
                  event.preventDefault()
                  const form = event.currentTarget as HTMLFormElement
                  const input = form.elements.namedItem('nodeName') as HTMLInputElement
                  if (!input.value.trim()) return
                  addNode.mutate({ syllabus_version_id: publishedSyllabus.id, canonical_name: input.value, parent_id: null })
                  input.value = ''
                }}
              >
                <input name="nodeName" placeholder="新考点名称" style={{ maxWidth: 260 }} />
                <button className="btn small" type="submit" disabled={addNode.isPending}>
                  添加
                </button>
              </form>
              <p className="tiny muted">
                该大纲标记为「{publishedSyllabus.is_user_provisional ? '用户自建（非官方）' : '已审核'}」；改名需要新建大纲版本，历史证据按当时大纲保留。
              </p>
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>证据详情</h2>
          {!selectedNodeId ? (
            <div className="empty-state">选择左侧考点查看证据、缺失条件与排除原因。</div>
          ) : !selectedState ? (
            <div className="empty-state">
              该考点还没有任何作答证据（状态：未诊断）。完成一次作答后，这里会显示计入/排除明细与缺失条件。
            </div>
          ) : (
            <>
              <div className="row between">
                <h3 style={{ margin: 0 }} data-testid="evidence-node-name">
                  {selectedState.node_name || selectedNodeName}
                </h3>
                <span className={`pill ${SUMMARY_CLASS[selectedState.summary] ?? 'neutral'}`}>
                  {SUMMARY_LABELS[selectedState.summary] ?? selectedState.summary}
                </span>
              </div>
              <p className="small muted">
                历史最高状态：{SUMMARY_LABELS[selectedState.best_summary] ?? selectedState.best_summary}
                {selectedState.downgrade_reason ? ` · 降级原因：${selectedState.downgrade_reason}` : ''}
              </p>
              <ul className="small">
                <li>严格独立正确：{selectedState.independent_correct_count} 道不同题</li>
                <li>覆盖模板：{selectedState.distinct_template_count} 种</li>
                <li>延迟验证：{selectedState.has_delayed_correct ? '已满足' : '未满足'}</li>
              </ul>
              {selectedState.missing_evidence.length ? (
                <div className="notice warn">
                  还缺什么证据：
                  <ul style={{ margin: '4px 0 0 18px' }}>
                    {selectedState.missing_evidence.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <h3>证据行</h3>
              {evidenceQuery.isLoading ? <p className="muted">读取中…</p> : null}
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>维度</th>
                      <th>计入</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(evidenceQuery.data?.rows ?? []).map((row) => (
                      <tr key={row.id}>
                        <td className="small">{DIMENSION_LABELS[row.dimension] ?? row.dimension}</td>
                        <td>{row.qualifies ? <span className="pill ok">计入</span> : <span className="pill neutral">排除</span>}</td>
                        <td className="small">{row.exclusion_reasons.join('；') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="btn small" onClick={() => navigate('/reports')}>
                查看报告
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>人工配对验证（A / B / C）</h2>
        <p className="small muted">
          A 是基准题，B 是同一考点的即时验证题，C 是最少 {pairForm.delay_hours} 小时后的延迟验证题。三者必须属于同一科目，
          且 B/C 必须是不同于 A 的稳定题目。缺 C 题时会显式记录缺题，不拿原题冒充陌生验证。
        </p>
        {pairingsQuery.data?.length ? (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>考点</th>
                  <th>版本</th>
                  <th>延迟</th>
                  <th>状态</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {pairingsQuery.data.map((pairing) => (
                  <tr key={pairing.id}>
                    <td>{pairing.node_name}</td>
                    <td>v{pairing.pairing_version}</td>
                    <td>{pairing.delay_hours} 小时</td>
                    <td>{pairing.is_active ? <span className="pill ok">生效</span> : <span className="pill neutral">停用</span>}</td>
                    <td className="small">{pairing.gap || '已关联 B/C 题'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">还没有配对验证。缺少配对时，系统只会记录重复练习证据，不会声称掌握了新题。</div>
        )}

        <h3>建立配对</h3>
        <div className="grid three">
          <label className="field">
            <span>考点</span>
            <select value={pairForm.node_id} onChange={(event) => setPairForm({ ...pairForm, node_id: event.target.value })}>
              <option value="">请选择</option>
              {nodes.map((raw) => {
                const node = raw as unknown as { id: string; name: string }
                return (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                )
              })}
            </select>
          </label>
          <label className="field">
            <span>基准题 A（可空）</span>
            <select value={pairForm.baseline} onChange={(event) => setPairForm({ ...pairForm, baseline: event.target.value })}>
              <option value="">不指定</option>
              {(questionsQuery.data ?? []).map((question) => (
                <option key={question.id} value={question.id}>
                  {question.display_label || question.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>即时题 B</span>
            <select value={pairForm.immediate} onChange={(event) => setPairForm({ ...pairForm, immediate: event.target.value })}>
              <option value="">请选择</option>
              {(questionsQuery.data ?? []).map((question) => (
                <option key={question.id} value={question.id}>
                  {question.display_label || question.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>延迟题 C（可空，缺失会记录缺题）</span>
            <select value={pairForm.delayed} onChange={(event) => setPairForm({ ...pairForm, delayed: event.target.value })}>
              <option value="">暂不指定</option>
              {(questionsQuery.data ?? []).map((question) => (
                <option key={question.id} value={question.id}>
                  {question.display_label || question.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>延迟小时数</span>
            <input
              value={pairForm.delay_hours}
              onChange={(event) => setPairForm({ ...pairForm, delay_hours: event.target.value })}
            />
          </label>
        </div>
        <button
          className="btn primary"
          disabled={!pairForm.node_id || !pairForm.immediate || createPairing.isPending}
          onClick={() => createPairing.mutate()}
        >
          建立配对验证
        </button>
      </div>
    </>
  )
}
