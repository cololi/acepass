import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiRequest,
  fetchSealedContent,
  newIdempotencyKey,
  problemsOf,
  serverMessageOf,
  type ApiProblemRow,
  type QuestionListItem,
  type SealedContentQuestionRow,
  type SyllabusOut,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { ExposurePanel, ExposureToggle } from './ExposurePanel'
import { QuestionSealingPanel, SealedContentList } from './SealingControls'
import { VariantProposePanel } from './VariantProposePanel'

const TYPE_LABELS: Record<string, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
  constructed_response: '大题',
  material: '共享材料',
}

const ORIGIN_LABELS: Record<string, string> = {
  official_past: '真实考试原题',
  licensed_bank: '授权题库',
  user_authored: '用户自编',
  ai_generated: 'AI 生成',
  demo: '演示夹具',
}

const PARSE_TEMPLATE = `【题型】单选题
【题干】这里写题干，填空用 __ 或（ ）标记，例如：方程 x+1=0 的解是 __。
【选项】
A. 第一个选项
B. 第二个选项
C. 第三个选项
D. 第四个选项
【答案】A
【解析】可选：写下人工解析。
【分值】2
【考点】可选：写下考点名称，校对时再映射。
【来源】可选：说明出处，例如“自编练习题”。`

export function QuestionBankPage() {
  const { currentProject, currentSubject } = useScope()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [typeFilter, setTypeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [importText, setImportText] = useState('')
  const [sourceNote, setSourceNote] = useState('')
  const [importError, setImportError] = useState('')
  /** One question's exposure explanation is expanded at a time. */
  const [exposureQuestionId, setExposureQuestionId] = useState<string | null>(null)
  /** Same for the sealing confirm step and the variant proposal form (C03/C02). */
  const [sealPanelQuestionId, setSealPanelQuestionId] = useState<string | null>(null)
  const [variantPanelQuestionId, setVariantPanelQuestionId] = useState<string | null>(null)
  /**
   * The server's own refusal for the last 开始练习 click.
   *
   * A sealed question cannot enter a session, and the server answers 403
   * `purpose_not_allowed` with the sealing reason. That sentence is kept on
   * screen verbatim instead of being dropped into a toast that fades away.
   */
  const [practiceRefusal, setPracticeRefusal] = useState<{
    label: string
    message: string
    problems: ApiProblemRow[]
  } | null>(null)

  const projectId = currentProject?.id ?? null

  const questionsQuery = useQuery({
    queryKey: ['questions', projectId, currentSubject?.id, typeFilter, search],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' })
      if (currentSubject) params.set('subject_id', currentSubject.id)
      if (typeFilter) params.set('question_type', typeFilter)
      if (search.trim()) params.set('search', search.trim())
      return apiRequest<QuestionListItem[]>(`/projects/${projectId}/questions?${params.toString()}`)
    },
    enabled: Boolean(projectId),
  })

  /**
   * C03: what the server says is sealed right now (latest policy per target).
   *
   * The question list itself carries no sealing flag, so this inventory is the
   * only source of per-question state — and when it cannot be read the page
   * says so instead of rendering every question as "未封存".
   */
  const sealedQuery = useQuery({
    queryKey: ['sealed-content', projectId],
    queryFn: () => fetchSealedContent(projectId as string),
    enabled: Boolean(projectId),
    retry: false,
  })

  const sealedByQuestion = new Map<string, SealedContentQuestionRow>()
  for (const row of sealedQuery.data?.questions ?? []) sealedByQuestion.set(row.question_id, row)
  const sealedStateUnknown = sealedQuery.isError || (sealedQuery.isSuccess && sealedQuery.data === null)

  const syllabusQuery = useQuery({
    queryKey: ['syllabus', projectId, currentSubject?.id],
    queryFn: () => apiRequest<SyllabusOut[]>(`/projects/${projectId}/syllabus-versions?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const parsePreview = useMutation({
    mutationFn: () =>
      apiRequest<{ count: number; segments: Array<Record<string, unknown>> }>(`/projects/${projectId}/imports/parse-text`, {
        method: 'POST',
        body: { text: importText },
      }),
    onError: (err) => setImportError(describeError(err)),
  })

  const createImport = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>(`/projects/${projectId}/imports`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('import-create'),
        body: {
          text: importText,
          subject_id: currentSubject?.id ?? null,
          title: '粘贴导入',
          source_note: sourceNote,
          parse: true,
        },
      }),
    onSuccess: async (job) => {
      toast.push('已创建导入任务，请在导入页校对', 'ok')
      setImportText('')
      await queryClient.invalidateQueries({ queryKey: ['imports', projectId] })
      navigate(`/imports?job=${job.id}`)
    },
    onError: (err) => setImportError(describeError(err)),
  })

  const createSession = useMutation({
    mutationFn: (questionId: string) => {
      // A new attempt clears the previous refusal: no stale sentence stays on
      // screen while the server is being asked again.
      setPracticeRefusal(null)
      return apiRequest<{ session_id: string }>(`/projects/${projectId}/practice-sessions`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('session-create'),
        body: {
          mode: 'practice',
          subject_id: currentSubject?.id,
          question_ids: [questionId],
          purpose: 'practice',
        },
      })
    },
    onSuccess: (data) => {
      // Carry the project and subject in the URL: the workbench is also reachable
      // from a task in another project, and it must not create the next session
      // with whatever happens to be selected globally.
      const params = new URLSearchParams({ session: data.session_id })
      if (projectId) params.set('project', projectId)
      if (currentSubject?.id) params.set('subject', currentSubject.id)
      navigate(`/practice?${params.toString()}`)
    },
    onError: (err, questionId) => {
      // Show the server's own refusal (e.g. 封存内容不可进入练习/验证会话：…) as-is:
      // a sealed question is never offered a "practice anyway" path, it is
      // reported the way the server reported it.
      const label =
        (questionsQuery.data ?? []).find((question) => question.id === questionId)?.display_label ||
        questionId.slice(0, 8)
      setPracticeRefusal({ label, message: serverMessageOf(err), problems: problemsOf(err) })
      toast.push(serverMessageOf(err), 'error')
    },
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  return (
    <>
      <div className="page-title">
        <h1>题库与导入</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigate('/imports')}>
          导入与校对列表
        </button>
      </div>

      <div className="card">
        <h2>文字导入</h2>
        <p className="small muted">
          粘贴内容会先保存为来源文档（保留原文），再生成待校对的候选。系统不会自动猜答案；只有人工核对过的题目才能发布为计分题。
        </p>
        <div className="grid two">
          <label className="field">
            <span>粘贴题目文本</span>
            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={PARSE_TEMPLATE}
              style={{ minHeight: 180 }}
            />
          </label>
          <div>
            <label className="field">
              <span>来源说明（建议填写：出处、年份、获取方式）</span>
              <input value={sourceNote} onChange={(event) => setSourceNote(event.target.value)} />
            </label>
            <div className="row">
              <button className="btn" disabled={!importText.trim() || parsePreview.isPending} onClick={() => parsePreview.mutate()}>
                预览解析结果
              </button>
              <button
                className="btn primary"
                disabled={!importText.trim() || !currentSubject || createImport.isPending}
                onClick={() => createImport.mutate()}
              >
                创建导入任务
              </button>
            </div>
            {!currentSubject ? <div className="notice warn">请先在上方选择科目。</div> : null}
            {parsePreview.data ? (
              <div className="notice info">
                解析出 {parsePreview.data.count} 道候选。示例题型：
                {parsePreview.data.segments
                  .slice(0, 5)
                  .map((segment) => String(segment.question_type))
                  .join('、') || '（无法识别结构，请使用【题干】【选项】【答案】模板）'}
              </div>
            ) : null}
            {importError ? <div className="notice danger">{importError}</div> : null}
            <details className="small">
              <summary>推荐的粘贴模板</summary>
              <pre className="code-block">{PARSE_TEMPLATE}</pre>
            </details>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>已发布题目</h2>
          <div className="row">
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} style={{ width: 'auto' }}>
              <option value="">全部题型</option>
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="按题号/标签搜索"
              style={{ width: 180 }}
            />
          </div>
        </div>
        {questionsQuery.isLoading ? <p className="muted">读取中…</p> : null}
        {sealedStateUnknown ? (
          <div className="notice warn" data-testid="sealed-state-unknown">
            无法从服务端读取封存清单
            {sealedQuery.isError ? `：${serverMessageOf(sealedQuery.error)}` : '：服务端没有返回可用内容'}。
            下面的题目不会显示为「未封存」，开始练习时仍以服务端判定为准。
          </div>
        ) : null}
        {practiceRefusal ? (
          <div className="notice danger" data-testid="practice-refusal" role="alert">
            <strong>服务端拒绝了这个操作（{practiceRefusal.label}）</strong>
            <div>{practiceRefusal.message}</div>
            {practiceRefusal.problems.length ? (
              <ul style={{ margin: '6px 0 0 18px' }}>
                {practiceRefusal.problems.map((problem, index) => (
                  <li key={`${problem.code}-${index}`}>
                    {problem.message}（{problem.code}）
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="small">
              封存内容不可用于练习、检索、AI 生成提示、导出与原页预览：这里不提供「仍然练习」的入口。
            </div>
          </div>
        ) : null}
        {questionsQuery.data?.length === 0 ? (
          <div className="empty-state">
            该科目还没有题目。可以先粘贴文字导入，或用手工录入路径（导入候选即人工录入入口）。
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>题号/标签</th>
                  <th>题型</th>
                  <th>来源</th>
                  <th>可信答案</th>
                  <th>考点</th>
                  <th>严格独立</th>
                  <th>封存</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(questionsQuery.data ?? []).map((question) => {
                  const sealedRow = sealedByQuestion.get(question.id) ?? null
                  return (
                    <Fragment key={question.id}>
                      <tr data-testid="question-row" data-question-id={question.id}>
                        <td>
                          {question.display_label || '（无标签）'}
                          {question.is_demo ? <span className="pill warn" style={{ marginLeft: 6 }}>演示</span> : null}
                        </td>
                        <td>{question.question_type ? (TYPE_LABELS[question.question_type] ?? question.question_type) : '—'}</td>
                        <td className="small">{ORIGIN_LABELS[question.origin_type] ?? question.origin_type}</td>
                        <td>
                          {question.has_trusted_answer ? (
                            <span className="pill ok">已核对</span>
                          ) : (
                            <span className="pill danger">无</span>
                          )}
                        </td>
                        <td className="small">{question.knowledge_nodes.join('、') || '未映射'}</td>
                        <td>
                          <ExposureToggle
                            open={exposureQuestionId === question.id}
                            onToggle={() =>
                              setExposureQuestionId((current) => (current === question.id ? null : question.id))
                            }
                          />
                        </td>
                        <td>
                          <div className="row">
                            {sealedRow ? (
                              <span
                                className="pill danger"
                                data-testid="question-sealed-state"
                                data-question-id={question.id}
                                title={`${sealedRow.reason_message}（原因码：${sealedRow.reason_code}）`}
                              >
                                已封存
                              </span>
                            ) : null}
                            <button
                              className="btn small"
                              data-testid={sealedRow ? 'question-unseal' : 'question-seal'}
                              data-question-id={question.id}
                              onClick={() =>
                                setSealPanelQuestionId((current) => (current === question.id ? null : question.id))
                              }
                            >
                              {sealedRow ? '解除封存' : '封存'}
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="row">
                            <button
                              className="btn small"
                              disabled={!question.has_trusted_answer || !currentSubject}
                              onClick={() => createSession.mutate(question.id)}
                              title={question.has_trusted_answer ? '开始练习' : '缺少已核对答案，不能进入计分练习'}
                            >
                              开始练习
                            </button>
                            <button
                              className="btn small ghost"
                              data-testid="variant-propose"
                              data-question-id={question.id}
                              title={
                                sealedRow
                                  ? '已封存：封存内容不参与练习、检索与 AI 生成提示；服务端的封存拦截不包含变式生成'
                                  : '用 AI 生成待校对变式候选'
                              }
                              onClick={() =>
                                setVariantPanelQuestionId((current) => (current === question.id ? null : question.id))
                              }
                            >
                              生成变式
                            </button>
                          </div>
                          {sealedRow ? (
                            <div className="tiny muted">已封存：不参与练习、检索与 AI 生成提示</div>
                          ) : null}
                        </td>
                      </tr>
                      {exposureQuestionId === question.id ? (
                        <tr>
                          <td colSpan={8} className="surface-subtle" style={{ padding: 0 }}>
                            <ExposurePanel questionId={question.id} />
                          </td>
                        </tr>
                      ) : null}
                      {sealPanelQuestionId === question.id ? (
                        <tr>
                          <td colSpan={8} className="surface-subtle" style={{ padding: 0 }}>
                            <QuestionSealingPanel
                              projectId={projectId as string}
                              question={question}
                              sealedRow={sealedRow}
                              stateUnknown={sealedStateUnknown}
                              onClose={() => setSealPanelQuestionId(null)}
                            />
                          </td>
                        </tr>
                      ) : null}
                      {variantPanelQuestionId === question.id ? (
                        <tr>
                          <td colSpan={8} className="surface-subtle" style={{ padding: 0 }}>
                            <VariantProposePanel
                              projectId={projectId as string}
                              question={question}
                              sourceSealed={Boolean(sealedRow)}
                              onClose={() => setVariantPanelQuestionId(null)}
                            />
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
      </div>

      <SealedContentList projectId={projectId as string} />

      <div className="card">
        <h2>大纲与考点</h2>
        {syllabusQuery.data?.length ? (
          <ul className="small">
            {syllabusQuery.data.map((syllabus) => (
              <li key={syllabus.id}>
                {syllabus.name}
                {syllabus.version_label ? ` ${syllabus.version_label}` : ''} · 状态 {syllabus.status} · 考点{' '}
                {syllabus.node_count} 个
                {syllabus.is_user_provisional ? <span className="pill warn" style={{ marginLeft: 6 }}>用户自建（非官方）</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">
            该科目还没有大纲版本。没有大纲不使用官方覆盖分析；可在「设置」中创建用户自建的暂定大纲。
          </p>
        )}
        <button className="btn small" onClick={() => navigate('/knowledge')}>
          打开考点地图
        </button>
      </div>
    </>
  )
}