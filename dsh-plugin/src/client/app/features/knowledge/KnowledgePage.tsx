import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  acceptTagSuggestion,
  apiRequest,
  createKnowledgeRelation,
  createTagSuggestion,
  cycleNamesOf,
  deactivateKnowledgeRelation,
  fetchKnowledgeRelations,
  fetchNodePrerequisites,
  fetchTagSuggestions,
  newIdempotencyKey,
  rejectTagSuggestion,
  type EvidenceRow,
  type KnowledgeNode,
  type KnowledgeStateRow,
  type OutlineImportOut,
  type QuestionListItem,
  type SyllabusOut,
  type TagSuggestionDecisionOut,
  type VerificationPairingOut,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { FamiliesPanel } from './FamiliesPanel'

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

const UNMET_REASON_LABELS: Record<string, string> = {
  prerequisite_undiagnosed: '还没有作答证据，视为未满足',
  prerequisite_needs_review: '需要复习',
  prerequisite_not_independent: '尚未达到独立完成',
}

const TAG_STATUS_LABELS: Record<string, string> = {
  proposed: '待人工决定',
  accepted: '已采纳',
  rejected: '已否决',
  superseded: '已被新建议取代',
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
  // 前置关系：the cycle path is state, not an error string, so it can be shown
  // as a path even though the server only returns name lists.
  const [relationForm, setRelationForm] = useState({ from_node_id: '', to_node_id: '', note: '' })
  const [relationCycle, setRelationCycle] = useState<string[]>([])
  const [relationError, setRelationError] = useState('')
  const [relationNotice, setRelationNotice] = useState('')
  // 标签建议：selection is kept per suggestion id so a new proposal starts clean.
  const [tagVersionId, setTagVersionId] = useState('')
  const [tagError, setTagError] = useState('')
  const [tagResult, setTagResult] = useState<TagSuggestionDecisionOut | null>(null)
  const [selectedTagNames, setSelectedTagNames] = useState<Record<string, string[]>>({})

  const projectId = currentProject?.id ?? null
  const projectKey = projectId ?? ''

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
    queryFn: () => apiRequest<QuestionListItem[]>(`/projects/${projectId}/questions?limit=100&subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  // 标签建议只能作用于已发布版本：draft 版本没有稳定的映射修订可写。
  const tagVersionOptions = (questionsQuery.data ?? [])
    .filter((question) => Boolean(question.published_version_id))
    .map((question) => ({
      versionId: question.published_version_id as string,
      label: question.display_label || question.id.slice(0, 8),
    }))
  const tagVersion = tagVersionOptions.find((option) => option.versionId === tagVersionId) ?? tagVersionOptions[0] ?? null
  const activeTagVersionId = tagVersion?.versionId ?? null

  const relationsQuery = useQuery({
    queryKey: ['knowledge-relations', projectId, currentSubject?.id],
    queryFn: () => fetchKnowledgeRelations(projectKey, currentSubject?.id),
    enabled: Boolean(projectId && currentSubject),
  })

  const prerequisitesQuery = useQuery({
    queryKey: ['node-prerequisites', projectId, relationForm.to_node_id],
    queryFn: () => fetchNodePrerequisites(projectKey, relationForm.to_node_id),
    enabled: Boolean(projectId && relationForm.to_node_id),
  })

  const tagSuggestionsQuery = useQuery({
    queryKey: ['tag-suggestions', projectId, activeTagVersionId],
    queryFn: () => fetchTagSuggestions(projectKey, activeTagVersionId ?? ''),
    enabled: Boolean(projectId && activeTagVersionId),
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

  const addRelation = useMutation({
    mutationFn: (payload: { syllabus_version_id: string; from_node_id: string; to_node_id: string; note: string }) =>
      createKnowledgeRelation(projectKey, { ...payload, relation_type: 'prerequisite' }),
    onSuccess: async (edge) => {
      // Only a 201 reaches this branch: a refused edge can never be reported as
      // created, and the success notice is cleared on every failure below.
      setRelationCycle([])
      setRelationError('')
      setRelationNotice(`已添加前置关系：${edge.from_node_name} → ${edge.to_node_name}`)
      setRelationForm({ from_node_id: '', to_node_id: '', note: '' })
      toast.push('前置关系已添加', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['knowledge-relations'] })
    },
    onError: (err) => {
      setRelationNotice('')
      const cycle = cycleNamesOf(err)
      setRelationCycle(cycle)
      setRelationError(cycle.length ? '' : describeError(err))
    },
  })

  const deactivateRelation = useMutation({
    mutationFn: (relationId: string) => deactivateKnowledgeRelation(projectKey, relationId, '人工停用（考点地图）'),
    onSuccess: async (edge) => {
      setRelationCycle([])
      setRelationError('')
      setRelationNotice(`已停用前置关系：${edge.from_node_name} → ${edge.to_node_name}（记录保留，未删除）`)
      await queryClient.invalidateQueries({ queryKey: ['knowledge-relations'] })
    },
    onError: (err) => {
      setRelationNotice('')
      setRelationCycle([])
      setRelationError(describeError(err))
    },
  })

  const generateTags = useMutation({
    mutationFn: (versionId: string) => createTagSuggestion(projectKey, versionId),
    onSuccess: async () => {
      setTagError('')
      setTagResult(null)
      toast.push('已生成标签建议；请人工核对后再采纳', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['tag-suggestions'] })
    },
    onError: (err) => {
      setTagResult(null)
      // "AI 未配置" is a documented state, not a failed suggestion: never invent
      // proposals when the provider is missing.
      setTagError(
        err instanceof ApiError && err.isAiUnavailable
          ? 'AI 未配置：无法生成标签建议'
          : describeError(err),
      )
    },
  })

  const acceptTags = useMutation({
    mutationFn: (payload: { suggestionId: string; nodeNames: string[] }) =>
      acceptTagSuggestion(projectKey, payload.suggestionId, {
        node_names: payload.nodeNames,
        note: '人工核对后采纳（考点地图）',
      }),
    onSuccess: async (result) => {
      setTagError('')
      setTagResult(result)
      toast.push(`已采纳 ${result.added_node_names.length} 个辅助标签（映射修订 ${result.mapping_revision ?? '—'}）`, 'ok')
      await queryClient.invalidateQueries({ queryKey: ['tag-suggestions'] })
    },
    onError: (err) => {
      setTagResult(null)
      setTagError(describeError(err))
    },
  })

  const rejectTags = useMutation({
    mutationFn: (suggestionId: string) =>
      rejectTagSuggestion(projectKey, suggestionId, { node_names: null, note: '人工核对后否决（考点地图）' }),
    onSuccess: async (suggestion) => {
      setTagError('')
      setTagResult(null)
      toast.push(`已否决该建议（${TAG_STATUS_LABELS[suggestion.status] ?? suggestion.status}）；未写入任何映射`, 'info')
      await queryClient.invalidateQueries({ queryKey: ['tag-suggestions'] })
    },
    onError: (err) => setTagError(describeError(err)),
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

  const relationEdges = relationsQuery.data?.edges ?? []
  const relationFromNode = editableNodeMap.get(relationForm.from_node_id) ?? null
  const relationToNode = editableNodeMap.get(relationForm.to_node_id) ?? null
  // Both ends must live in one syllabus version: the server refuses a mixed
  // pair, and a disabled button explains that before the request is sent.
  const relationSameSyllabus = Boolean(
    relationFromNode && relationToNode && relationFromNode.syllabus_version_id === relationToNode.syllabus_version_id,
  )
  const relationSelfLoop = Boolean(relationFromNode && relationToNode && relationFromNode.id === relationToNode.id)
  const canAddRelation = Boolean(
    relationFromNode && relationToNode && relationSameSyllabus && !relationSelfLoop && !addRelation.isPending,
  )
  const prerequisitePreview = prerequisitesQuery.data ?? null

  const tagSuggestions = [...(tagSuggestionsQuery.data ?? [])].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  )
  const currentTagSuggestion = tagSuggestions[0] ?? null
  const chosenTagNames = currentTagSuggestion ? (selectedTagNames[currentTagSuggestion.id] ?? []) : []
  const toggleTagName = (suggestionId: string, name: string) => {
    setSelectedTagNames((current) => {
      const chosen = current[suggestionId] ?? []
      return {
        ...current,
        [suggestionId]: chosen.includes(name) ? chosen.filter((item) => item !== name) : [...chosen, name],
      }
    })
  }

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
      <div className="page-title" data-testid="page-knowledge">
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
                          className={selectedNodeId === node.id ? 'row-selected' : undefined} style={{ cursor: 'pointer' }}
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
                            <td colSpan={5} className="surface-subtle">
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

      <div className="card" data-testid="prerequisite-panel">
        <h2>前置关系（{relationEdges.length}）</h2>
        <p className="small muted">
          前置关系表示学习顺序：先掌握「前置考点」，再学「依赖考点」。加边只记录这条顺序，不改变任何考点的掌握状态；
          系统会拒绝任何会形成环的关系，并给出环上的完整路径。停用关系只标记失效，历史记录仍然保留。
        </p>
        {editableNodes.length === 0 ? (
          <div className="notice warn">该科目还没有可编辑的考点的记录：请先在「设置」中发布大纲，或使用下方词表导入。</div>
        ) : null}
        <div className="grid three">
          <label className="field">
            <span>前置考点</span>
            <select
              data-testid="prerequisite-from-select"
              value={relationForm.from_node_id}
              onChange={(event) => {
                setRelationCycle([])
                setRelationError('')
                setRelationNotice('')
                setRelationForm({ ...relationForm, from_node_id: event.target.value })
              }}
            >
              <option value="">请选择</option>
              {editableNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {nodePathLabel(node, editableNodeMap)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>依赖考点</span>
            <select
              data-testid="prerequisite-to-select"
              value={relationForm.to_node_id}
              onChange={(event) => {
                setRelationCycle([])
                setRelationError('')
                setRelationNotice('')
                setRelationForm({ ...relationForm, to_node_id: event.target.value })
              }}
            >
              <option value="">请选择</option>
              {editableNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {nodePathLabel(node, editableNodeMap)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>说明（可选）</span>
            <input
              value={relationForm.note}
              placeholder="例如：先学函数再学导数"
              onChange={(event) => setRelationForm({ ...relationForm, note: event.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <button
            className="btn primary"
            data-testid="prerequisite-add"
            disabled={!canAddRelation}
            onClick={() => {
              if (!relationFromNode || !relationToNode) return
              setRelationCycle([])
              setRelationError('')
              setRelationNotice('')
              addRelation.mutate({
                syllabus_version_id: relationFromNode.syllabus_version_id,
                from_node_id: relationFromNode.id,
                to_node_id: relationToNode.id,
                note: relationForm.note.trim(),
              })
            }}
          >
            添加前置关系
          </button>
          <span className="small muted">方向：前置考点 → 依赖考点。</span>
        </div>
        {relationFromNode && relationToNode && !relationSameSyllabus ? (
          <div className="notice warn" data-testid="prerequisite-mismatch">
            两个考点不在同一个大纲版本内，无法建立关系；请选择同一大纲下的考点。
          </div>
        ) : null}
        {relationSelfLoop ? (
          <div className="notice warn" data-testid="prerequisite-self-loop">
            不能把考点设为自己的前置。
          </div>
        ) : null}
        {relationCycle.length ? (
          <div className="notice danger" data-testid="prerequisite-cycle-error">
            加入该关系会形成环：{relationCycle.join(' → ')}
          </div>
        ) : null}
        {relationCycle.length ? (
          <p className="small muted" style={{ marginTop: 0 }}>
            服务器已拒绝该请求，没有创建任何关系；请调整方向或先停用环上的某条关系。
          </p>
        ) : null}
        {relationError ? (
          <div className="notice danger" data-testid="prerequisite-error">
            {relationError}
          </div>
        ) : null}
        {relationNotice ? (
          <div className="notice ok" data-testid="prerequisite-notice">
            {relationNotice}
          </div>
        ) : null}

        {relationForm.to_node_id ? (
          <div className="small" data-testid="prerequisite-preview" style={{ marginTop: 8 }}>
            {prerequisitesQuery.isLoading ? (
              <span className="muted">正在读取该考点的前置关系…</span>
            ) : prerequisitesQuery.isError ? (
              <span className="muted">前置关系读取失败：{describeError(prerequisitesQuery.error)}</span>
            ) : prerequisitePreview ? (
              <>
                <div>
                  该依赖考点的现有前置：
                  {prerequisitePreview.prerequisites.length
                    ? prerequisitePreview.prerequisites
                        .map((row) => `${row.node_name}（${SUMMARY_LABELS[row.state] ?? row.state}）`)
                        .join('、')
                    : '无'}
                </div>
                {prerequisitePreview.unmet.length ? (
                  <div className="notice warn" style={{ marginTop: 6 }}>
                    尚未满足的前置：
                    {prerequisitePreview.unmet
                      .map((row) => `${row.node_name}（${UNMET_REASON_LABELS[row.reason ?? ''] ?? row.reason ?? '未满足'}）`)
                      .join('、')}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        <div className="table-scroll" data-testid="prerequisite-edges" style={{ marginTop: 10 }}>
          {relationEdges.length === 0 ? (
            <div className="empty-state">还没有前置关系。选择「前置考点」与「依赖考点」后点击「添加前置关系」。</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>前置考点</th>
                  <th />
                  <th>依赖考点</th>
                  <th>说明</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {relationEdges.map((edge) => (
                  <tr key={edge.id} data-testid="prerequisite-edge-row">
                    <td className="small">{edge.from_node_name}</td>
                    <td className="muted">→</td>
                    <td className="small">{edge.to_node_name}</td>
                    <td className="small">{edge.note || '—'}</td>
                    <td>
                      <button
                        className="btn small ghost"
                        data-testid="prerequisite-deactivate"
                        disabled={deactivateRelation.isPending}
                        onClick={() => deactivateRelation.mutate(edge.id)}
                      >
                        停用
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" data-testid="tag-suggestion-panel">
        <h2>标签建议（AI 候选，人工决定）</h2>
        <p className="small muted">
          模型只提出候选考点名称，且名称必须逐字来自本科目已发布大纲中的考点；没有配置模型时请求会明确失败，
          系统不会编造建议。被采纳的名称只作为辅助标签，主要考点与计分权重仍然由人工决定。
        </p>
        <div className="notice info" data-testid="tag-suggestion-note">
          采纳只会写入新的“辅助标签”映射修订（权重 0），不会创建或改名考点
        </div>
        <div className="grid two">
          <label className="field">
            <span>题目版本（仅已发布）</span>
            <select
              value={activeTagVersionId ?? ''}
              disabled={tagVersionOptions.length === 0}
              onChange={(event) => {
                setTagVersionId(event.target.value)
                setTagError('')
                setTagResult(null)
              }}
            >
              {tagVersionOptions.length === 0 ? <option value="">（该科目还没有已发布的题目版本）</option> : null}
              {tagVersionOptions.map((option) => (
                <option key={option.versionId} value={option.versionId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              className="btn primary"
              data-testid="tag-suggestion-generate"
              disabled={!activeTagVersionId || generateTags.isPending}
              onClick={() => {
                if (!activeTagVersionId) return
                setTagError('')
                generateTags.mutate(activeTagVersionId)
              }}
            >
              生成建议
            </button>
            <span className="small muted">生成不写入任何映射。</span>
          </div>
        </div>
        {tagError ? (
          <div className="notice danger" data-testid="tag-suggestion-error">
            {tagError}
          </div>
        ) : null}
        {tagSuggestionsQuery.isLoading ? <p className="muted">读取中…</p> : null}
        {tagSuggestionsQuery.isError ? (
          <div className="notice danger">标签建议读取失败：{describeError(tagSuggestionsQuery.error)}</div>
        ) : null}
        {!currentTagSuggestion ? (
          <div className="empty-state">该题目版本还没有标签建议。点击「生成建议」向已配置的模型请求候选考点。</div>
        ) : (
          <>
            <div className="row between">
              <h3 style={{ margin: 0 }}>{currentTagSuggestion.question_label || '（无题目标签）'}</h3>
              <div className="row">
                <span
                  className={`pill ${
                    currentTagSuggestion.status === 'accepted'
                      ? 'ok'
                      : currentTagSuggestion.status === 'proposed'
                        ? 'warn'
                        : 'neutral'
                  }`}
                >
                  {TAG_STATUS_LABELS[currentTagSuggestion.status] ?? currentTagSuggestion.status}
                </span>
                {currentTagSuggestion.is_stub ? (
                  <span className="pill warn" data-testid="tag-suggestion-stub">
                    stub（测试/演示，不是真实模型）
                  </span>
                ) : null}
              </div>
            </div>
            <p className="tiny muted">
              模型：{currentTagSuggestion.model_identifier || '—'} · 提示词版本：
              {currentTagSuggestion.prompt_version || '—'} · 生成时间：
              {new Date(currentTagSuggestion.created_at).toLocaleString()}
            </p>
            <ul className="small" data-testid="tag-suggestion-list">
              {currentTagSuggestion.proposals.map((proposal) => (
                <li key={proposal.name}>
                  <label className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      data-testid="tag-proposal-checkbox"
                      checked={chosenTagNames.includes(proposal.name)}
                      disabled={currentTagSuggestion.status !== 'proposed'}
                      onChange={() => toggleTagName(currentTagSuggestion.id, proposal.name)}
                    />
                    <span>{proposal.name}</span>
                    <span className="muted tiny">
                      置信度 {typeof proposal.confidence === 'number' ? proposal.confidence.toFixed(2) : '—'}
                    </span>
                    {proposal.rationale ? <span className="tiny muted">{proposal.rationale}</span> : null}
                  </label>
                </li>
              ))}
              {currentTagSuggestion.proposals.length === 0 ? (
                <li className="muted">模型没有给出可用候选；没有任何映射会被写入。</li>
              ) : null}
            </ul>
            <div className="row">
              <button
                className="btn primary"
                data-testid="tag-suggestion-accept"
                disabled={
                  currentTagSuggestion.status !== 'proposed' || chosenTagNames.length === 0 || acceptTags.isPending
                }
                onClick={() =>
                  acceptTags.mutate({ suggestionId: currentTagSuggestion.id, nodeNames: chosenTagNames })
                }
              >
                采纳所选
              </button>
              <button
                className="btn ghost"
                data-testid="tag-suggestion-reject"
                disabled={currentTagSuggestion.status !== 'proposed' || rejectTags.isPending}
                onClick={() => rejectTags.mutate(currentTagSuggestion.id)}
              >
                否决
              </button>
              <span className="small muted">否决只记录决定，不写入任何映射。</span>
            </div>
            {tagResult ? (
              <div className="notice ok" data-testid="tag-suggestion-result" style={{ marginTop: 10 }}>
                <div>
                  <strong>采纳结果：</strong>映射修订 {tagResult.mapping_revision ?? '—'} · 新增辅助标签：
                  {tagResult.added_node_names.join('、') || '（无）'}
                </div>
                {tagResult.unresolved_names.length ? (
                  <div className="small">
                    未能匹配到考点的名称（需人工处理）：
                    {tagResult.unresolved_names.join('、')}
                  </div>
                ) : null}
                <div className="tiny">新增映射全部为辅助标签（权重 0）；未创建、未改名任何考点。</div>
              </div>
            ) : null}
            {currentTagSuggestion.unresolved_names.length ? (
              <div className="notice warn">
                上次决定中未能匹配的名称：
                {currentTagSuggestion.unresolved_names.join('、')}；这些名称不会自动创建考点。
              </div>
            ) : null}
            <h4>当前映射修订</h4>
            {currentTagSuggestion.latest_mappings.length ? (
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>考点</th>
                      <th>权重</th>
                      <th>类型</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentTagSuggestion.latest_mappings.map((row) => (
                      <tr key={row.node_id}>
                        <td className="small">{row.node_name}</td>
                        <td className="small">{row.weight}</td>
                        <td className="small">{row.is_primary ? '主要考点' : '辅助标签（权重 0）'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small muted">该版本还没有映射修订；采纳前请先建立主要考点映射。</p>
            )}
            {tagSuggestions.length > 1 ? (
              <details className="small">
                <summary>历史建议（{tagSuggestions.length}）</summary>
                <ul>
                  {tagSuggestions.map((suggestion) => (
                    <li key={suggestion.id}>
                      {new Date(suggestion.created_at).toLocaleString()} ·{' '}
                      {TAG_STATUS_LABELS[suggestion.status] ?? suggestion.status}
                      {suggestion.accepted_mapping_revision ? ` · 映射修订 ${suggestion.accepted_mapping_revision}` : ''}
                      {suggestion.decision_note ? ` · ${suggestion.decision_note}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>

      {/* C03: 题目家族（成员、封存、两步合并）— subject-scoped like the rest of this page. */}
      <FamiliesPanel questions={questionsQuery.data ?? []} />

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
