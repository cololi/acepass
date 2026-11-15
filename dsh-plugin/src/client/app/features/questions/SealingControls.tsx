import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchSealedContent,
  problemsOf,
  sealQuestion,
  serverMessageOf,
  unsealQuestion,
  type ApiProblemRow,
  type QuestionListItem,
  type SealedContentOut,
  type SealedContentQuestionRow,
} from '../../api/client'
import { useScope, useToast } from '../../app/context'

/**
 * C03 sealing (封存 / holdout) on the question bank page.
 *
 * Two rules shape this file and are not negotiable:
 *
 * * **The server decides.** What is sealed here comes from
 *   `GET /sealed-content`, which reports the *latest* policy revision per
 *   target. The UI never derives a state from a local flag, and a failed read
 *   says so instead of rendering "未封存".
 * * **Sealed content is unreachable.** Sealed questions and families do not
 *   enter practice, retrieval, AI generation prompts, export or the original
 *   page preview, so no surface here offers a "practice anyway" escape hatch —
 *   it only states the rule and shows the server's own refusal sentence when an
 *   action is refused.
 */

const REASON_CODE_LABELS: Record<string, string> = {
  sealed_question_policy: '题目自身被保留策略封存',
  sealed_family_policy: '所属家族被保留策略封存',
}

/** The plain statement of the rule, shared by every sealing surface. */
export const SEALING_RULE_TEXT =
  '封存（holdout）内容不可用于练习、检索、AI 生成提示、导出与原页预览。封存与解除封存都是追加一条新的策略修订，历史记录不会被删除。'

export function reasonCodeLabel(code: string): string {
  return REASON_CODE_LABELS[code] ?? code
}

function formatMoment(raw: string | null | undefined): string {
  if (!raw) return '记录未带时间'
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? raw : at.toLocaleString()
}

function failureOf(error: unknown): { message: string; problems: ApiProblemRow[] } {
  return { message: serverMessageOf(error), problems: problemsOf(error) }
}

/**
 * The confirm step for one question: server state, a reason, one action.
 *
 * The panel stays open after a successful write so the state line it shows is
 * the state the server just reported — closing it would hide the only evidence
 * the write happened.
 */
export function QuestionSealingPanel({
  projectId,
  question,
  sealedRow,
  stateUnknown = false,
  onClose,
}: {
  projectId: string
  question: QuestionListItem
  sealedRow: SealedContentQuestionRow | null
  /** The sealed-content inventory could not be read: do not claim 未封存. */
  stateUnknown?: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<{ message: string; problems: ApiProblemRow[] } | null>(null)
  const sealed = Boolean(sealedRow)
  /**
   * A question sealed *by its family* cannot be freed from here.
   *
   * The resolver checks the question's own latest policy first and the family's
   * after that, so appending a question-level `is_holdout=False` revision leaves
   * the content sealed by the family. Offering that button would be an action
   * that never does what its label says, so the panel points at the family
   * instead.
   */
  const sealedByFamily = sealedRow?.policy_target === 'family'

  const write = useMutation({
    mutationFn: () => {
      // A new attempt clears the previous outcome: a success notice must never
      // survive the failure that followed it.
      setNotice('')
      setFailure(null)
      return sealed
        ? unsealQuestion(projectId, question.id, reason)
        : sealQuestion(projectId, question.id, reason)
    },
    onSuccess: async (result) => {
      setReason('')
      setNotice(
        result.is_holdout
          ? `已封存：策略修订 ${result.revision}，本修订后服务端仍判定为封存的题目 ${result.sealed_question_ids.length} 道。`
          : result.sealed
            ? `已追加解除修订（策略修订 ${result.revision}），但该内容仍被封存：${
                result.sealed_reason ? reasonCodeLabel(result.sealed_reason) : '仍有其他封存策略生效'
              }。`
            : `已解除封存：策略修订 ${result.revision}，该内容不再被封存。`,
      )
      await queryClient.invalidateQueries({ queryKey: ['sealed-content', projectId] })
      toast.push(result.is_holdout ? '已封存该题' : '已追加解除修订', result.is_holdout ? 'ok' : 'info')
    },
    onError: (error) => setFailure(failureOf(error)),
  })

  const label = question.display_label || question.id.slice(0, 8)

  return (
    <div
      className="card"
      data-testid="question-seal-panel"
      data-question-id={question.id}
      style={{ margin: 12 }}
    >
      <div className="row between">
        <h3 style={{ margin: 0 }}>封存（holdout）· {label}</h3>
        <button className="btn small ghost" onClick={onClose}>
          收起
        </button>
      </div>

      <div
        className={sealed ? 'notice warn' : 'notice info'}
        data-testid="question-seal-state-detail"
        style={{ marginTop: 8 }}
      >
        <strong>
          服务端当前状态：{sealed ? '已封存' : stateUnknown ? '无法确认（服务端未返回封存清单）' : '未封存'}
        </strong>
        {sealedRow ? (
          <>
            <div className="small">
              {sealedRow.reason_message}（原因码：{sealedRow.reason_code} ·
              {reasonCodeLabel(sealedRow.reason_code)}）
            </div>
            {sealedRow.family_name ? (
              <div className="small">
                封存来源家族：{sealedRow.family_name}
                {sealedRow.family_id ? `（${sealedRow.family_id}）` : ''}
              </div>
            ) : null}
            <div className="tiny muted">
              策略修订 {sealedRow.policy_revision ?? '—'} · 生效时间 {formatMoment(sealedRow.changed_at)}
              {sealedRow.change_reason ? ` · 填写的原因：${sealedRow.change_reason}` : ' · 未填写原因'}
            </div>
          </>
        ) : stateUnknown ? (
          <div className="small">
            服务端的封存清单没有读到：这里不会显示为「未封存」。下面的操作仍然有效，但会不会重复封存以服务端记录为准。
          </div>
        ) : (
          <div className="small">
            服务端的封存清单里没有这道题：它可以被练习、检索、AI 生成提示与原页预览。
          </div>
        )}
      </div>

      <p className="small muted">{SEALING_RULE_TEXT}</p>

      <label className="field">
        <span>原因（写入审计；建议写清为什么封存或解除封存）</span>
        <textarea
          data-testid="seal-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：本家族与去年真题重复，考试前不再用于练习"
          style={{ minHeight: 60 }}
        />
      </label>

      {failure ? (
        <div className="notice danger" data-testid="question-seal-error">
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
      {notice ? (
        <div className="notice ok" data-testid="question-seal-notice">
          {notice}
        </div>
      ) : null}

      <div className="row">
        {sealed && !sealedByFamily ? (
          <button
            className="btn"
            data-testid="question-unseal-confirm"
            disabled={write.isPending}
            onClick={() => write.mutate()}
          >
            确认解除封存
          </button>
        ) : sealed ? (
          <span className="small" data-testid="question-seal-family-notice">
            本题由所属家族的封存覆盖，题目层面的解除不会让它重新可用：请到「考点地图 → 题目家族」里解除该家族的封存
            （或先把本题移出该家族）。这里不提供无效的解除入口。
          </span>
        ) : (
          <button
            className="btn primary"
            data-testid="question-seal-confirm"
            disabled={write.isPending}
            onClick={() => write.mutate()}
          >
            确认封存
          </button>
        )}
        <span className="small muted">
          {sealed
            ? sealedByFamily
              ? '封存内容不可用于练习、检索、AI 生成提示与原页预览；解除需要改家族封存。'
              : '解除封存后，该题会重新进入练习、检索、AI 生成提示与原页预览（除非它所属家族仍被封存）。'
            : '封存后，该题立刻从练习、检索、AI 生成提示与原页预览中消失。'}
        </span>
      </div>
    </div>
  )
}

/**
 * 「已封存内容」: what the server says is sealed in this project, and why.
 *
 * The endpoint is project-scoped (no `subject_id`), so the list shows the whole
 * project and names each row's subject instead of pretending to be narrower
 * than the answer it has.
 */
export function SealedContentList({ projectId }: { projectId: string }) {
  const { subjects } = useScope()
  const query = useQuery({
    queryKey: ['sealed-content', projectId],
    queryFn: () => fetchSealedContent(projectId),
    enabled: Boolean(projectId),
    retry: false,
  })

  const data: SealedContentOut | null = query.data ?? null
  const subjectName = (subjectId: string | null): string => {
    if (!subjectId) return '科目未知'
    return subjects.find((subject) => subject.id === subjectId)?.name ?? subjectId.slice(0, 8)
  }

  return (
    <div className="card" data-testid="sealed-content-list">
      <div className="row between">
        <h2 style={{ margin: 0 }}>已封存内容</h2>
        {data ? (
          <span className="small muted">
            服务端计数：题目 {data.counts.questions} 道 · 题目版本 {data.counts.question_versions} 个 · 家族{' '}
            {data.counts.families} 个 · 生成时间 {formatMoment(data.generated_at)}
          </span>
        ) : null}
      </div>
      <p className="small muted">
        {SEALING_RULE_TEXT}这一份清单来自服务端，只列出<strong>最新</strong>策略修订判定为封存的内容；下面每一行都带着封存它的原因码与填写的原因。
      </p>
      <p className="tiny muted">范围：该接口按项目返回（不接受科目参数），因此这里列出整个项目的封存内容。</p>

      {query.isLoading ? <p className="muted">正在读取封存清单…</p> : null}
      {query.isError ? (
        <div className="notice danger" data-testid="sealed-content-error">
          {serverMessageOf(query.error)}
        </div>
      ) : null}
      {!query.isLoading && !query.isError && !data ? (
        <div className="notice danger" data-testid="sealed-content-error">
          服务端没有返回封存清单：无法确认哪些内容被封存，因此这里不会显示为「没有封存」。
        </div>
      ) : null}

      {data ? (
        <>
          {data.questions.length === 0 && data.families.length === 0 ? (
            <div className="empty-state">当前项目没有被封存的题目或家族。</div>
          ) : null}

          {data.families.length ? (
            <>
              <h3>被封存的家族（{data.families.length}）</h3>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>家族</th>
                      <th>科目</th>
                      <th>成员</th>
                      <th>原因</th>
                      <th>策略修订</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.families.map((family) => (
                      <tr key={family.family_id} data-testid="sealed-family-row" data-family-id={family.family_id}>
                        <td>
                          {family.name || family.family_id.slice(0, 8)}
                          <div className="tiny muted">家族编号：{family.family_id}</div>
                        </td>
                        <td className="small">{subjectName(family.subject_id)}</td>
                        <td className="small">{family.question_ids.length} 道</td>
                        <td className="small">
                          {family.reason_message}
                          <div className="tiny muted">
                            原因码：{family.reason_code}
                            {family.change_reason ? ` · 填写的原因：${family.change_reason}` : ' · 未填写原因'}
                          </div>
                        </td>
                        <td className="small">
                          修订 {family.policy_revision ?? '—'}
                          <div className="tiny muted">{formatMoment(family.changed_at)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {data.questions.length ? (
            <>
              <h3>被封存的题目（{data.questions.length}）</h3>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>题目</th>
                      <th>科目</th>
                      <th>封存来源</th>
                      <th>原因</th>
                      <th>策略修订</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.questions.map((row) => (
                      <tr key={row.question_id} data-testid="sealed-question-row" data-question-id={row.question_id}>
                        <td>
                          {row.display_label || row.question_id.slice(0, 8)}
                          <div className="tiny muted">题目编号：{row.question_id}</div>
                        </td>
                        <td className="small">{subjectName(row.subject_id)}</td>
                        <td className="small">
                          {row.policy_target === 'family'
                            ? `家族：${row.family_name || (row.family_id ?? '').slice(0, 8)}`
                            : '题目自身'}
                          <div className="tiny muted">{reasonCodeLabel(row.reason_code)}</div>
                        </td>
                        <td className="small">
                          {row.reason_message}
                          {row.change_reason ? (
                            <div className="tiny muted">填写的原因：{row.change_reason}</div>
                          ) : (
                            <div className="tiny muted">未填写原因</div>
                          )}
                        </td>
                        <td className="small">
                          修订 {row.policy_revision ?? '—'}
                          <div className="tiny muted">{formatMoment(row.changed_at)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
