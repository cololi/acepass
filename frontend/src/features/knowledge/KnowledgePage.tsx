import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  newIdempotencyKey,
  type EvidenceRow,
  type KnowledgeNode,
  type KnowledgeStateRow,
  type OutlineImportOut,
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

const OUTLINE_SKIP_REASONS: Record<string, string> = {
  empty_name: '没有识别出考点名称',
  merged_across_levels: '同名考点已在其他层级存在，已合并但未改变层级',
}

function nodeMapOf(nodes: KnowledgeNode[]): Map<string, KnowledgeNode> {
  const map = new Map<string, KnowledgeNode>()
  for (const node of nodes) map.set(node.id, node)
  return map
}

/** Ancestor ids, guarded against malformed cyclic data. */
function ancestorIdsOf(node: KnowledgeNode, byId: Map<string, KnowledgeNode>): string[] {
  const ancestors: string[] = []
  const seen = new Set<string>([node.id])
  let parentId = node.parent_id
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    ancestors.push(parentId)
    parentId = byId.get(parentId)?.parent_id ?? null
  }
  return ancestors
}

function nodePathLabel(node: KnowledgeNode, byId: Map<string, KnowledgeNode>): string {
  const names = [node.canonical_name]
  for (const ancestorId of ancestorIdsOf(node, byId)) {
    const ancestor = byId.get(ancestorId)
    if (!ancestor) break
    names.unshift(ancestor.canonical_name)
  }
  return names.join(' / ')
}

export function KnowledgePage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [selectedNodeId, setSelectedNode] = useState<string | null>(null)
  const [pairForm, setPairForm] = useState({ node_id: '', immediate: '', delayed: '', baseline: '', delay_hours: '24' })
  const [outlineText, setOutlineText] = useState('')
  const [outlineSyllabusId, setOutlineSyllabusId] = useState('')
  const [outlineReport, setOutlineReport] = useState<OutlineImportOut | null>(null)
  const [outlineError, setOutlineError] = useState('')
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ canonical_name: '', aliases: '', parent_id: '' })
  const [editError, setEditError] = useState('')

  const projectId = currentProject?.id ?? null

  const mapQuery = useQuery({
    queryKey: ['knowledge-map', projectId, currentSubject?.id],
    queryFn: () =>
      apiRequest<{ subject_id: string; nodes: Array<Record<string, unknown>> }>(
        `/projects/${projectId}/knowledge-map?subject_id=${currentSubject?.id}`,
      ),
    enabled: Boolean(projectId && currentSubject),
  })

  const editableNodesQuery = useQuery({
    queryKey: ['nodes', projectId, currentSubject?.id],
    queryFn: () => apiRequest<KnowledgeNode[]>(`/projects/${projectId}/knowledge-nodes?subject_id=${currentSubject?.id}`),
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

  const importOutline = useMutation({
    mutationFn: (syllabusId: string) =>
      apiRequest<OutlineImportOut>(`/projects/${projectId}/syllabus-versions/${syllabusId}/nodes/import`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('outline-import'),
        body: { text: outlineText },
      }),
    onSuccess: async (report) => {
      setOutlineError('')
      setOutlineReport(report)
      setOutlineText('')
      toast.push(`词表导入完成：新建 ${report.created} 个、合并 ${report.merged} 个`, 'ok')
      await queryClient.invalidateQueries({ queryKey: ['knowledge-map'] })
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      await queryClient.invalidateQueries({ queryKey: ['syllabus'] })
    },
    onError: (err) => {
      setOutlineReport(null)
      setOutlineError(describeError(err))
    },
  })

  const updateNode = useMutation({
    mutationFn: (payload: { nodeId: string; canonical_name: string; aliases: string[]; parent_id: string | null }) =>
      apiRequest<KnowledgeNode>(`/projects/${projectId}/knowledge-nodes/${payload.nodeId}`, {
        method: 'PATCH',
        body: {
          canonical_name: payload.canonical_name,
          aliases: payload.aliases,
          parent_id: payload.parent_id,
          move: true,
        },
      }),
    onSuccess: async () => {
      setEditError('')
      setEditingNodeId(null)
      toast.push('考点已更新；父考点变化会记入修订记录', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['knowledge-map'] })
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
    },
    onError: (err) => setEditError(describeError(err)),
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
  const editableNodes = editableNodesQuery.data ?? []
  const editableNodeMap = nodeMapOf(editableNodes)
  const outlineSyllabus =
    syllabusQuery.data?.find((syllabus) => syllabus.id === outlineSyllabusId) ?? publishedSyllabus ?? syllabusQuery.data?.[0] ?? null
  const outlineTargetId = outlineSyllabus?.id ?? ''
  const editingNode = editingNodeId ? (editableNodeMap.get(editingNodeId) ?? null) : null
  // Every node of the same syllabus stays selectable, including the ones the
  // backend must refuse: a cycle is a real user mistake, and the server's
  // explanation ("环") is what the reviewer needs to read, not a silent gap in
  // the list. Impossible choices are labelled instead of hidden.
  const moveOptions = editingNode
    ? editableNodes
        .filter((node) => node.syllabus_version_id === editingNode.syllabus_version_id)
        .map((node) => {
          const isSelf = node.id === editingNode.id
          const isDescendant = !isSelf && ancestorIdsOf(node, editableNodeMap).includes(editingNode.id)
          return {
            node,
            invalidNote: isSelf ? '（当前考点自身，不能作为上级）' : isDescendant ? '（自己的子节点，会形成环）' : '',
          }
        })
    : []
  const selectedState = states.find((state) => state.node_id === selectedNodeId) ?? null
  const openNodeEditor = (nodeId: string, editableNode: KnowledgeNode | undefined) => {
    if (!editableNode) return
    setEditError('')
    setEditingNodeId(nodeId)
    setEditForm({
      canonical_name: editableNode.canonical_name,
      aliases: editableNode.aliases.join('、'),
      parent_id: editableNode.parent_id ?? '',
    })
  }
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
        自评、AI 估计与辅助作答不计入严格独立证据。点击考点可查看证据与排除原因，并在列表内直接改名、维护别名或调整层级。
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
                    <th>操作</th>
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
                    const editableNode = editableNodeMap.get(node.id)
                    return (
                      <Fragment key={node.id}>
                        <tr
                          onClick={() => {
                            setSelectedNode(node.id)
                            // Selecting a node is also how a reviewer opens its
                            // inline editor; the 编辑 button only toggles it.
                            if (editingNodeId !== node.id) openNodeEditor(node.id, editableNode)
                          }}
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
                          <td>
                            <button
                              className="btn small ghost"
                              disabled={!editableNode}
                              title={editableNode ? '修改名称、别名与所属上级考点' : '该考点没有可编辑的大纲节点记录'}
                              onClick={(event) => {
                                event.stopPropagation()
                                if (!editableNode) return
                                if (editingNodeId === node.id) {
                                  setEditingNodeId(null)
                                  setEditError('')
                                  return
                                }
                                setSelectedNode(node.id)
                                openNodeEditor(node.id, editableNode)
                              }}
                            >
                              {editingNodeId === node.id ? '收起' : '编辑'}
                            </button>
                          </td>
                        </tr>
                        {editingNodeId === node.id && editableNode ? (
                          <tr>
                            <td colSpan={5} style={{ background: '#fafbfc' }}>
                              <div data-testid="node-editor">
                                <div data-testid="node-error">
                                  {editError ? <div className="notice danger">{editError}</div> : null}
                                </div>
                                <div className="grid three">
                                  <label className="field">
                                    <span>考点名称</span>
                                    <input
                                      data-testid="node-rename"
                                      value={editForm.canonical_name}
                                      onChange={(event) => setEditForm({ ...editForm, canonical_name: event.target.value })}
                                    />
                                  </label>
                                  <label className="field">
                                    <span>别名（用「、」或逗号分隔，用于识别同一考点）</span>
                                    <input
                                      data-testid="node-aliases"
                                      value={editForm.aliases}
                                      placeholder="例如 二次函数、抛物线"
                                      onChange={(event) => setEditForm({ ...editForm, aliases: event.target.value })}
                                    />
                                  </label>
                                  <label className="field">
                                    <span>上级考点（同一大纲内）</span>
                                    <select
                                      data-testid="node-parent"
                                      value={editForm.parent_id}
                                      onChange={(event) => setEditForm({ ...editForm, parent_id: event.target.value })}
                                    >
                                      <option value="">顶层（无上级）</option>
                                      {moveOptions.map((option) => (
                                        <option key={option.node.id} value={option.node.id}>
                                          {nodePathLabel(option.node, editableNodeMap)}
                                          {option.invalidNote}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>
                                <div className="row">
                                  <button
                                    className="btn small primary"
                                    data-testid="node-save"
                                    disabled={updateNode.isPending || !editForm.canonical_name.trim()}
                                    onClick={() => {
                                      setEditError('')
                                      updateNode.mutate({
                                        nodeId: editableNode.id,
                                        canonical_name: editForm.canonical_name.trim(),
                                        aliases: editForm.aliases
                                          .split(/[、,，]/)
                                          .map((alias) => alias.trim())
                                          .filter(Boolean),
                                        parent_id: editForm.parent_id || null,
                                      })
                                    }}
                                  >
                                    保存修改
                                  </button>
                                  <button
                                    className="btn small ghost"
                                    onClick={() => {
                                      setEditingNodeId(null)
                                      setEditError('')
                                    }}
                                  >
                                    取消
                                  </button>
                                  <span className="tiny muted">
                                    移动不能指向自己或自己的子节点（会形成环，系统会拒绝并说明原因）。
                                  </span>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
                该大纲标记为「{publishedSyllabus.is_user_provisional ? '用户自建（非官方）' : '已审核'}」；改名与移动会记入修订记录，
                历史证据仍按当时的大纲归属保留。
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

      <div className="card" data-testid="outline-import-card">
        <h2>大纲词表导入</h2>
        <p className="small muted">
          一行一个考点，用缩进表示层级（顶层为章，向下一级为节）；同一行可以用「、」或逗号补充别名。
          同名或同别名的行会合并到同一个考点，不会为同一个知识点建立两条互相竞争的统计口径。
        </p>
        <div className="grid two">
          <label className="field">
            <span>目标大纲版本</span>
            <select
              value={outlineTargetId}
              onChange={(event) => setOutlineSyllabusId(event.target.value)}
              disabled={!syllabusQuery.data?.length}
            >
              {(syllabusQuery.data ?? []).map((syllabus) => (
                <option key={syllabus.id} value={syllabus.id}>
                  {syllabus.name || `大纲 v${syllabus.version_label}`}
                  {syllabus.status === 'published' ? '（已发布）' : `（${syllabus.status}）`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!syllabusQuery.data?.length ? (
          <div className="notice warn">该科目还没有大纲版本：请先在「设置」中创建并发布用户自建大纲。</div>
        ) : outlineSyllabus && outlineSyllabus.status !== 'published' ? (
          <div className="notice warn">
            该大纲尚未发布：导入的考点不会出现在上面的考点列表与考点地图中，请先在「设置」中发布该大纲版本。
          </div>
        ) : null}
        <label className="field">
          <span>词表内容</span>
          <textarea
            data-testid="outline-text"
            value={outlineText}
            onChange={(event) => setOutlineText(event.target.value)}
            style={{ minHeight: 160 }}
            placeholder={'第一章 函数\n  函数的概念\n  函数的性质、单调性\n第二章 数列\n  等差数列'}
          />
        </label>
        {outlineError ? <div className="notice danger">{outlineError}</div> : null}
        <div className="row">
          <button
            className="btn primary"
            data-testid="outline-submit"
            disabled={!outlineText.trim() || !outlineTargetId || importOutline.isPending}
            onClick={() => {
              if (!outlineTargetId) return
              importOutline.mutate(outlineTargetId)
            }}
          >
            导入词表
          </button>
          <span className="small muted">导入只新增或合并考点，不会删除已有考点，也不会改动历史证据。</span>
        </div>
        {outlineReport ? (
          <div className="notice ok" data-testid="outline-report" style={{ marginTop: 10 }}>
            <strong>导入结果：</strong>
            新建 {outlineReport.created} 个 · 合并 {outlineReport.merged} 个 · 该大纲现有 {outlineReport.node_count} 个考点。
            {outlineReport.aliases_added.length ? (
              <div className="small">
                新增别名：
                {outlineReport.aliases_added
                  .map((entry) => entry.aliases.join('、'))
                  .filter(Boolean)
                  .join('；')}
              </div>
            ) : null}
            {outlineReport.skipped.length ? (
              <div className="small">
                跳过的行（{outlineReport.skipped.length}）：
                <ul style={{ margin: '4px 0 0 18px' }}>
                  {outlineReport.skipped.map((skip, index) => (
                    <li key={index}>
                      第 {skip.line} 行「{skip.text || '（空行）'}」：
                      {OUTLINE_SKIP_REASONS[skip.reason] ?? skip.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
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
