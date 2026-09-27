import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchSearchResults,
  reindexSearch,
  searchChannelReason,
  type SearchReindexOut,
  type SearchResultRow,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

const CHANNEL_LABELS: Record<string, string> = {
  hybrid: '混合',
  keyword: '关键词',
  vector: '向量',
}

const KIND_LABELS: Record<string, string> = {
  question: '题目版本',
  node: '考点',
}

/** One request at a time; the response is the only place ranks come from. */
const RESULT_LIMIT = 10

function scoreText(score: number | null, digits: number): string {
  return typeof score === 'number' ? score.toFixed(digits) : '—'
}

function ResultRowView({ row }: { row: SearchResultRow }) {
  return (
    <tr data-testid="search-result-row">
      <td>
        <div>{row.display_label || '（无标签）'}</div>
        <div className="small">{row.excerpt || '（无可展示的题干文本）'}</div>
        {row.matched_terms.length ? (
          <div className="tiny muted">命中词：{row.matched_terms.join('、')}</div>
        ) : null}
      </td>
      <td className="small">{KIND_LABELS[row.kind] ?? row.kind}</td>
      <td className="small">
        <div>
          关键词：
          {row.keyword_rank
            ? `第 ${row.keyword_rank} 名（BM25 ${scoreText(row.keyword_score, 3)}）`
            : '未命中'}
        </div>
        <div>
          向量：
          {row.vector_rank
            ? `第 ${row.vector_rank} 名（余弦 ${scoreText(row.vector_score, 4)}）`
            : '未命中'}
        </div>
      </td>
      <td className="small">{scoreText(row.fused_score, 4)}</td>
    </tr>
  )
}

export function SearchPage() {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [draftQuery, setDraftQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null)
  const [channel, setChannel] = useState('hybrid')
  const [reindexReport, setReindexReport] = useState<SearchReindexOut | null>(null)

  const projectId = currentProject?.id ?? null
  const projectKey = projectId ?? ''

  // The probe (empty q) exists so the channel status — and the reason the vector
  // channel is unusable — is visible before the first real search, instead of
  // being discovered only after a query degraded silently.
  const activeQuery = submittedQuery ?? ''
  const searchQuery = useQuery({
    queryKey: ['search', projectId, currentSubject?.id, activeQuery, channel],
    queryFn: () =>
      fetchSearchResults(projectKey, {
        q: activeQuery,
        subjectId: currentSubject?.id ?? null,
        limit: RESULT_LIMIT,
        channel,
      }),
    enabled: Boolean(projectId),
  })

  const reindex = useMutation({
    mutationFn: () => {
      // `subject_id` is optional: omitting it reindexes the whole project.
      const body: { subject_id?: string } = {}
      if (currentSubject) body.subject_id = currentSubject.id
      return reindexSearch(projectKey, body)
    },
    onSuccess: async (report) => {
      setReindexReport(report)
      toast.push(`索引重建完成：收录 ${report.indexed} 条、排除 ${report.excluded} 条`, 'ok')
      await queryClient.invalidateQueries({ queryKey: ['search'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  const hasSearched = submittedQuery !== null
  const results = searchQuery.data?.results ?? []
  const vectorStatus = searchQuery.data?.channels.vector ?? null
  const vectorUnavailable = vectorStatus ? !vectorStatus.available : false
  const vectorReason = searchChannelReason(vectorStatus) || '未配置嵌入模型'
  const vectorNotice =
    channel === 'vector'
      ? `向量通道未配置：${vectorReason}；本次只请求向量通道，因此没有结果`
      : channel === 'keyword'
        ? `向量通道未配置：${vectorReason}；本次只使用关键词通道`
        : `向量通道未配置：${vectorReason}，仅使用关键词检索`

  const submit = () => {
    const next = draftQuery.trim()
    if (!next) return
    setSubmittedQuery(next)
  }

  return (
    <>
      <div className="page-title" data-testid="page-search">
        <h1>检索</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''}
        </span>
      </div>

      <div className="notice info">
        检索只使用题干、选项、共享材料与考点名称建立索引，答案、解析与评分细则从不进入索引，因此结果里不可能出现答案原文。
        混合通道把关键词（BM25）与向量（余弦）两路结果按名次融合（RRF）；某一通道不可用时会明确说明原因，并降级到仍然可用的通道。
      </div>

      {vectorUnavailable ? (
        <div className="notice warn" data-testid="search-vector-notice">
          {vectorNotice}
        </div>
      ) : null}

      <div className="card">
        <h2>检索</h2>
        <form
          className="grid three"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <label className="field">
            <span>关键词</span>
            <input
              data-testid="search-input"
              value={draftQuery}
              placeholder="例如：函数 单调性"
              onChange={(event) => setDraftQuery(event.target.value)}
            />
          </label>
          <label className="field">
            <span>检索通道</span>
            <select
              data-testid="search-channel-select"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button className="btn primary" type="submit" data-testid="search-submit" disabled={!draftQuery.trim()}>
              检索
            </button>
            <span className="small muted">范围：当前项目{currentSubject ? ' · 当前科目' : ''}。</span>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>
            检索结果{hasSearched ? `（${results.length}）` : ''}
          </h2>
          {searchQuery.data ? (
            <span className="small muted">
              候选文档 {searchQuery.data.candidate_documents} 条 · 分词
              {searchQuery.data.query_tokens.length ? `：${searchQuery.data.query_tokens.join('、')}` : '：无'}
              {searchQuery.data.fusion ? ` · 融合 ${searchQuery.data.fusion.method}(k=${searchQuery.data.fusion.k})` : ''}
            </span>
          ) : null}
        </div>
        {searchQuery.isError && hasSearched ? (
          <div className="notice danger">检索失败：{describeError(searchQuery.error)}</div>
        ) : null}
        <div data-testid="search-results">
          {!hasSearched ? (
            <div className="empty-state">
              输入关键词后点击「检索」。当前只展示通道状态；还没有发起检索，因此这里没有结果。
            </div>
          ) : searchQuery.isFetching ? (
            <div className="empty-state">检索中…</div>
          ) : results.length === 0 ? (
            <div className="empty-state">没有匹配内容</div>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>内容（题干摘要）</th>
                    <th>类型</th>
                    <th>各通道名次</th>
                    <th>融合得分</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((row) => (
                    <ResultRowView key={row.document_id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {searchQuery.data?.notes?.length ? (
          <div className="notice warn" style={{ marginTop: 10 }}>
            <ul style={{ margin: '0 0 0 18px' }}>
              {searchQuery.data.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="tiny muted">
          结果为题干摘要与名次信息；分数只说明这一路的排序位置，不代表掌握程度。向量通道不可用时，融合只由关键词通道决定。
        </p>
      </div>

      <div className="card">
        <h2>索引维护</h2>
        <p className="small muted">
          重建索引会重新投影当前项目的题目版本与考点，并记录被排除的行与原因（草稿、已撤回、隔离题等）。
          向量只有在配置了嵌入模型时才会生成，否则会给出明确原因，不会伪造向量。
        </p>
        <div className="row">
          <button
            className="btn"
            data-testid="search-reindex"
            disabled={reindex.isPending}
            onClick={() => reindex.mutate()}
          >
            重建索引
          </button>
          <span className="small muted">
            范围：{currentSubject ? `当前科目（${currentSubject.name}）` : '当前项目全部科目'}。
          </span>
        </div>
        {reindexReport ? (
          <div className="notice ok" data-testid="search-reindex-result" style={{ marginTop: 10 }}>
            <div>
              收录 {reindexReport.indexed} 条 · 排除 {reindexReport.excluded} 条 · 本次生成向量{' '}
              {reindexReport.embeddings} 条 · 索引内共 {reindexReport.documents_in_index} 条（分词版本{' '}
              {reindexReport.tokenizer_version}）
            </div>
            {reindexReport.embeddings === 0 && reindexReport.embedding_unavailable_reason ? (
              <div className="small">向量未生成的原因：{reindexReport.embedding_unavailable_reason}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  )
}
