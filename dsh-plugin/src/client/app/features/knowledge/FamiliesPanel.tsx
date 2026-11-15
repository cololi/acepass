import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addQuestionToFamily,
  createQuestionFamily,
  fetchFamilyMergeImpact,
  fetchQuestionFamilies,
  mergeQuestionFamily,
  patchQuestionFamily,
  problemsOf,
  removeQuestionFromFamily,
  sealQuestionFamily,
  serverMessageOf,
  unsealQuestionFamily,
  type ApiProblemRow,
  type FamilyMergeImpactOut,
  type FamilyMergeOut,
  type QuestionFamilyOut,
  type QuestionListItem,
} from '../../api/client'
import { useScope, useToast } from '../../app/context'

/**
 * C03 families (题目家族) on the knowledge page: membership, sealing and merge.
 *
 * Three product rules drive this panel:
 *
 * 1. **A merge is never one click.** The target is chosen, then
 *    「查看合并影响」 asks the server for the preview (questions that move,
 *    evidence rows that go stale, already-exposed questions), and only then
 *    does 「确认合并」 send the write. When the performed counts differ from the
 *    preview, both numbers stay on screen.
 * 2. **A merged family is history, not a live family.** The list endpoint keeps
 *    returning it (with `merged_into_id`), but it can no longer receive members
 *    or be a merge target, so the live list shows only families that are still
 *    their own family and the absorbed ones move to a collapsed audit section.
 * 3. **Everything shown is the server's number.** `member_count`,
 *    `sealed_member_count`, the merge preview and the merge outcome all come
 *    from responses; the panel never counts members locally.
 */

type Failure = { familyId: string; message: string; problems: ApiProblemRow[] }

function failureOf(error: unknown): { message: string; problems: ApiProblemRow[] } {
  return { message: serverMessageOf(error), problems: problemsOf(error) }
}

function familyLabel(family: QuestionFamilyOut | undefined, fallbackId = ''): string {
  if (!family) return fallbackId.slice(0, 8)
  return family.name || family.id.slice(0, 8)
}

function questionLabel(question: QuestionListItem): string {
  return question.display_label || question.id.slice(0, 8)
}

function formatMoment(raw: string | null | undefined): string {
  if (!raw) return '未带时间'
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? raw : at.toLocaleString()
}

/** The metrics a human compares between the preview and the performed merge. */
function mergeComparisons(preview: FamilyMergeImpactOut, result: FamilyMergeOut) {
  return [
    { label: '移动的题目数量', preview: preview.questions_to_move, actual: result.questions_moved },
    {
      label: '目标家族题目总数',
      preview: preview.questions_in_target_after,
      actual: result.questions_in_target_after,
    },
    {
      label: '失效的证据行',
      preview: preview.evidence_rows_to_invalidate,
      actual: result.evidence_invalidated,
    },
    { label: '合并前已见题目', preview: preview.exposed_before_merge, actual: result.exposed_before_merge },
    { label: '合并后已见题目', preview: preview.exposed_after_merge, actual: result.exposed_after_merge },
  ]
}

export function FamiliesPanel({ questions }: { questions: QuestionListItem[] }) {
  const { currentProject, currentSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const projectId = currentProject?.id ?? null
  const subjectId = currentSubject?.id ?? null

  const [createForm, setCreateForm] = useState({ name: '', note: '' })
  const [createError, setCreateError] = useState<{ message: string; problems: ApiProblemRow[] } | null>(null)
  const [createNotice, setCreateNotice] = useState('')
  const [sealReason, setSealReason] = useState('')
  const [sealNotice, setSealNotice] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<{ familyId: string; text: string } | null>(null)
  const [memberPick, setMemberPick] = useState<Record<string, string>>({})
  const [editFamilyId, setEditFamilyId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', note: '' })
  const [mergeFamilyId, setMergeFamilyId] = useState<string | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [mergeReason, setMergeReason] = useState('')
  const [mergePreview, setMergePreview] = useState<{
    familyId: string
    targetFamilyId: string
    data: FamilyMergeImpactOut
  } | null>(null)
  const [mergeResult, setMergeResult] = useState<{ familyId: string; data: FamilyMergeOut } | null>(null)
  const [mergeError, setMergeError] = useState<{ message: string; problems: ApiProblemRow[] } | null>(null)

  const familiesKey = ['question-families', projectId, subjectId] as const

  const familiesQuery = useQuery({
    queryKey: familiesKey,
    queryFn: () => fetchQuestionFamilies(projectId as string, subjectId as string),
    enabled: Boolean(projectId && subjectId),
    retry: false,
  })

  const families = familiesQuery.data ?? []
  const familyById = new Map(families.map((family) => [family.id, family]))
  const liveFamilies = families.filter((family) => !family.merged_into_id)
  const mergedFamilies = families.filter((family) => Boolean(family.merged_into_id))
  const mergeFamily = mergeFamilyId ? familyById.get(mergeFamilyId) : undefined

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['question-families', projectId, subjectId] })
  }

  const createFamily = useMutation({
    mutationFn: () => {
      setCreateError(null)
      setCreateNotice('')
      return createQuestionFamily(projectId as string, {
        subject_id: subjectId as string,
        name: createForm.name,
        note: createForm.note,
      })
    },
    onSuccess: async (family) => {
      setCreateForm({ name: '', note: '' })
      setCreateNotice(`已创建家族「${familyLabel(family)}」：成员 ${family.member_count} 道（服务端计数）`)
      await refresh()
      toast.push('已创建题目家族', 'ok')
    },
    onError: (error) => setCreateError(failureOf(error)),
  })

  const patchFamily = useMutation({
    mutationFn: (payload: {
      familyId: string
      patch: { name?: string; relation_confirmed?: boolean; note?: string }
    }) => {
      setFailure(null)
      setNotice(null)
      return patchQuestionFamily(projectId as string, payload.familyId, payload.patch)
    },
    onSuccess: async (family) => {
      setEditFamilyId(null)
      setNotice({
        familyId: family.id,
        text: `已保存：家族「${familyLabel(family)}」修订 ${family.revision}，近重复关系${
          family.relation_confirmed ? '已确认' : '未确认'
        }`,
      })
      await refresh()
      toast.push('已更新家族', 'ok')
    },
    onError: (error, payload) => setFailure({ familyId: payload.familyId, ...failureOf(error) }),
  })

  const addMember = useMutation({
    mutationFn: (payload: { familyId: string; questionId: string }) => {
      setFailure(null)
      setNotice(null)
      return addQuestionToFamily(projectId as string, payload.familyId, payload.questionId)
    },
    onSuccess: async (result) => {
      setNotice({
        familyId: result.family_id,
        text: result.changed
          ? `已加入家族：成员 ${result.member_count} 道（服务端计数）`
          : `该题本来就在这个家族中：成员仍为 ${result.member_count} 道`,
      })
      await refresh()
    },
    onError: (error, payload) => setFailure({ familyId: payload.familyId, ...failureOf(error) }),
  })

  const removeMember = useMutation({
    mutationFn: (payload: { familyId: string; questionId: string }) => {
      setFailure(null)
      setNotice(null)
      return removeQuestionFromFamily(projectId as string, payload.familyId, payload.questionId)
    },
    onSuccess: async (result) => {
      setNotice({
        familyId: result.family_id,
        text: `已移出家族：成员 ${result.member_count} 道（服务端计数）`,
      })
      await refresh()
    },
    onError: (error, payload) => setFailure({ familyId: payload.familyId, ...failureOf(error) }),
  })

  const sealFamily = useMutation({
    mutationFn: (payload: { familyId: string; sealed: boolean }) => {
      setFailure(null)
      setSealNotice('')
      return payload.sealed
        ? unsealQuestionFamily(projectId as string, payload.familyId, sealReason)
        : sealQuestionFamily(projectId as string, payload.familyId, sealReason)
    },
    onSuccess: async (result) => {
      setSealReason('')
      setSealNotice(
        result.is_holdout
          ? `已封存家族：策略修订 ${result.revision}，本次覆盖 ${result.sealed_question_ids.length} 道题`
          : `已解除家族封存：策略修订 ${result.revision}（家族成员中仍被单独封存的题目保持封存）`,
      )
      await refresh()
      await queryClient.invalidateQueries({ queryKey: ['sealed-content', projectId] })
      toast.push(result.is_holdout ? '已封存该家族' : '已解除该家族的封存', 'ok')
    },
    onError: (error, payload) => setFailure({ familyId: payload.familyId, ...failureOf(error) }),
  })

  const mergeImpact = useMutation({
    mutationFn: (payload: { familyId: string; targetFamilyId: string }) => {
      setMergeError(null)
      setMergeResult(null)
      setMergePreview(null)
      return fetchFamilyMergeImpact(projectId as string, payload.familyId, payload.targetFamilyId)
    },
    onSuccess: (data, payload) =>
      setMergePreview({ familyId: payload.familyId, targetFamilyId: payload.targetFamilyId, data }),
    onError: (error) => setMergeError(failureOf(error)),
  })

  const merge = useMutation({
    mutationFn: (payload: { familyId: string; targetFamilyId: string }) => {
      setMergeError(null)
      setMergeResult(null)
      return mergeQuestionFamily(projectId as string, payload.familyId, {
        target_family_id: payload.targetFamilyId,
        reason: mergeReason,
      })
    },
    onSuccess: async (data, payload) => {
      setMergeResult({ familyId: payload.familyId, data })
      setMergeReason('')
      await refresh()
      await queryClient.invalidateQueries({ queryKey: ['sealed-content', projectId] })
      toast.push(
        data.noop
          ? '这次合并没有写入任何内容：此前已经合并过'
          : `已合并：移动 ${data.questions_moved} 道题，失效证据 ${data.evidence_invalidated} 行`,
        data.noop ? 'info' : 'ok',
      )
    },
    onError: (error) => setMergeError(failureOf(error)),
  })

  if (!currentProject) return null

  return (
    <div className="card" data-testid="families-panel">
      <h2>题目家族</h2>
      <p className="small muted">
        家族记录「同一模板、只改数字或措辞」的近重复题。合并两个家族后，系统会重新检查旧曝光、把「属于不同家族」的证据
        标记为失效（失效而不是删除）并重算受影响的学习状态。封存家族后，全部成员都不参与练习、检索、AI 生成提示、
        导出与原页预览。
      </p>

      <h3>新建家族</h3>
      <div className="grid two">
        <label className="field">
          <span>家族名称（同一科目内不可重名）</span>
          <input
            data-testid="family-name"
            value={createForm.name}
            onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })}
            placeholder="例如：2024 真题 卷三 计算题同模板"
          />
        </label>
        <label className="field">
          <span>备注（可选）</span>
          <input
            data-testid="family-note"
            value={createForm.note}
            onChange={(event) => setCreateForm({ ...createForm, note: event.target.value })}
            placeholder="例如：同一模板，仅换数字"
          />
        </label>
      </div>
      <div className="row">
        <button
          className="btn primary"
          data-testid="family-create"
          disabled={!currentSubject || !createForm.name.trim() || createFamily.isPending}
          onClick={() => createFamily.mutate()}
        >
          创建家族
        </button>
        <span className="small muted">
          {!currentSubject ? '请先在上方选择科目。' : '名称必填；服务端会拒绝同一科目下的同名家族。'}
        </span>
      </div>
      {createError ? (
        <div className="notice danger" data-testid="family-create-error">
          {createError.message}
          {createError.problems.length ? (
            <ul style={{ margin: '6px 0 0 18px' }}>
              {createError.problems.map((problem, index) => (
                <li key={`${problem.code}-${index}`}>
                  {problem.message}（{problem.code}）
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {createNotice ? (
        <div className="notice ok" data-testid="family-create-notice">
          {createNotice}
        </div>
      ) : null}

      <h3>封存家族</h3>
      <p className="small muted">
        封存后的家族成员不可用于练习、检索、AI 生成提示、导出与原页预览；解除封存会追加一条新的策略修订
        （成员中单独被封存的题目不会因此解除）。
      </p>
      <label className="field">
        <span>封存/解除封存原因（写入审计）</span>
        <input
          data-testid="seal-reason"
          value={sealReason}
          onChange={(event) => setSealReason(event.target.value)}
          placeholder="例如：该模板与今年预测题重合，考前不用"
        />
      </label>
      {sealNotice ? (
        <div className="notice ok" data-testid="family-seal-notice">
          {sealNotice}
        </div>
      ) : null}

      <h3>家族列表</h3>
      {familiesQuery.isLoading ? <p className="muted">正在读取家族…</p> : null}
      {familiesQuery.isError ? (
        <div className="notice danger" data-testid="families-error">
          {serverMessageOf(familiesQuery.error)}
        </div>
      ) : null}
      {!familiesQuery.isLoading && !familiesQuery.isError && families.length === 0 ? (
        <div className="empty-state">
          该科目还没有题目家族。可以先创建家族，再按题目把近重复题加入同一个家族。
        </div>
      ) : null}

      {liveFamilies.length ? (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>家族</th>
                <th>成员</th>
                <th>封存</th>
                <th>成员管理（按题目）</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {liveFamilies.map((family) => {
                const picked = memberPick[family.id] ?? ''
                return (
                  <Fragment key={family.id}>
                    <tr data-testid="family-row" data-family-id={family.id}>
                      <td>
                        <div>
                          {familyLabel(family)}{' '}
                          {family.relation_confirmed ? (
                            <span className="pill ok">近重复关系已确认</span>
                          ) : (
                            <span className="pill warn">关系未确认</span>
                          )}
                        </div>
                        <div className="tiny muted">
                          修订 {family.revision}
                          {family.note ? ` · 备注：${family.note}` : ''}
                        </div>
                      </td>
                      <td className="small">
                        {family.member_count} 道
                        {family.sealed_member_count ? (
                          <div className="tiny muted">其中 {family.sealed_member_count} 道被封存</div>
                        ) : null}
                      </td>
                      <td className="small">
                        {family.sealed ? (
                          <span className="pill danger" data-testid="family-sealed-state">
                            已封存
                          </span>
                        ) : (
                          <span className="pill neutral">未封存</span>
                        )}
                        {family.sealed ? (
                          <div className="tiny muted">
                            封存内容不参与练习、检索、AI 生成提示、导出与原页预览
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row">
                          <select
                            data-testid="family-member-question"
                            data-family-id={family.id}
                            value={picked}
                            onChange={(event) => setMemberPick({ ...memberPick, [family.id]: event.target.value })}
                            style={{ width: 'auto', maxWidth: 220 }}
                          >
                            <option value="">选择该科目的题目</option>
                            {questions.map((question) => (
                              <option key={question.id} value={question.id}>
                                {questionLabel(question)}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn small"
                            data-testid="family-member-add"
                            data-family-id={family.id}
                            disabled={!picked || addMember.isPending}
                            onClick={() => addMember.mutate({ familyId: family.id, questionId: picked })}
                          >
                            加入
                          </button>
                          <button
                            className="btn small ghost"
                            data-testid="family-member-remove"
                            data-family-id={family.id}
                            disabled={!picked || removeMember.isPending}
                            onClick={() => removeMember.mutate({ familyId: family.id, questionId: picked })}
                          >
                            移出
                          </button>
                        </div>
                        <div className="tiny muted">
                          接口只返回成员数量、不返回成员清单，因此这里按题目加入/移出，数量以服务端为准。
                        </div>
                      </td>
                      <td>
                        <div className="row">
                          {family.sealed ? (
                            <button
                              className="btn small"
                              data-testid="family-unseal"
                              data-family-id={family.id}
                              disabled={sealFamily.isPending}
                              onClick={() => sealFamily.mutate({ familyId: family.id, sealed: true })}
                            >
                              解除封存
                            </button>
                          ) : (
                            <button
                              className="btn small"
                              data-testid="family-seal"
                              data-family-id={family.id}
                              disabled={sealFamily.isPending}
                              onClick={() => sealFamily.mutate({ familyId: family.id, sealed: false })}
                            >
                              封存
                            </button>
                          )}
                          <button
                            className="btn small"
                            data-testid="family-merge"
                            data-family-id={family.id}
                            onClick={() => {
                              setMergeFamilyId((current) => (current === family.id ? null : family.id))
                              setMergeTargetId('')
                              setMergePreview(null)
                              setMergeResult(null)
                              setMergeError(null)
                            }}
                          >
                            {mergeFamilyId === family.id ? '收起合并' : '合并到其他家族'}
                          </button>
                          <button
                            className="btn small ghost"
                            data-testid="family-edit"
                            data-family-id={family.id}
                            onClick={() => {
                              setEditFamilyId((current) => (current === family.id ? null : family.id))
                              setEditForm({ name: family.name, note: family.note })
                            }}
                          >
                            重命名/确认关系
                          </button>
                        </div>
                      </td>
                    </tr>

                    {editFamilyId === family.id ? (
                      <tr>
                        <td colSpan={5} className="surface-subtle">
                          <div data-testid="family-edit-panel" data-family-id={family.id}>
                            <div className="grid two">
                              <label className="field">
                                <span>家族名称</span>
                                <input
                                  data-testid="family-rename-input"
                                  value={editForm.name}
                                  onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                                />
                              </label>
                              <label className="field">
                                <span>备注</span>
                                <input
                                  data-testid="family-note-input"
                                  value={editForm.note}
                                  onChange={(event) => setEditForm({ ...editForm, note: event.target.value })}
                                />
                              </label>
                            </div>
                            <div className="row">
                              <button
                                className="btn small primary"
                                data-testid="family-rename-submit"
                                disabled={patchFamily.isPending || !editForm.name.trim()}
                                onClick={() =>
                                  patchFamily.mutate({
                                    familyId: family.id,
                                    patch: { name: editForm.name, note: editForm.note },
                                  })
                                }
                              >
                                保存名称与备注
                              </button>
                              <button
                                className="btn small"
                                data-testid="family-relation-confirm"
                                disabled={patchFamily.isPending || family.relation_confirmed}
                                onClick={() =>
                                  patchFamily.mutate({ familyId: family.id, patch: { relation_confirmed: true } })
                                }
                              >
                                {family.relation_confirmed ? '近重复关系已确认' : '确认近重复关系'}
                              </button>
                              <span className="small muted">
                                确认只记录「这些题确实是近重复」，不会合并或封存任何内容。
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}

                    {failure && failure.familyId === family.id ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="notice danger" data-testid="family-row-error">
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
                        </td>
                      </tr>
                    ) : null}

                    {notice && notice.familyId === family.id ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="notice ok" data-testid="family-row-notice">
                            {notice.text}
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
      ) : null}

      {mergedFamilies.length ? (
        <details data-testid="merged-families" style={{ marginTop: 10 }}>
          <summary className="small">
            已合并的家族（{mergedFamilies.length}）— 仅审计记录，不再是可加入/可合并的家族
          </summary>
          <ul className="small">
            {mergedFamilies.map((family) => (
              <li key={family.id} data-testid="merged-family-row" data-family-id={family.id}>
                {familyLabel(family)} · 修订 {family.revision} · 已合并到「
                {familyLabel(family.merged_into_id ? familyById.get(family.merged_into_id) : undefined, family.merged_into_id ?? '')}
                」 · {formatMoment(family.merged_at)} · 成员 {family.member_count} 道
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {mergeFamily ? (
        <div
          className="card surface-subtle divider-top"
          data-testid="family-merge-panel"
          data-family-id={mergeFamily.id}
          style={{ marginTop: 12 }}
        >
          <div className="row between">
            <h3 style={{ margin: 0 }}>合并家族：「{familyLabel(mergeFamily)}」</h3>
            <button className="btn small ghost" onClick={() => setMergeFamilyId(null)}>
              收起合并
            </button>
          </div>
          <p className="small muted">
            合并会把源家族的题目移入目标家族、使「属于不同家族」的证据失效（不删除）并重算受影响的学习状态。
            必须先查看影响，再确认合并：这里没有跳过预览直接合并的入口。
          </p>
          <div className="grid two">
            <label className="field">
              <span>目标家族（同一科目，已合并的家族不再作为目标）</span>
              <select
                data-testid="family-merge-target"
                value={mergeTargetId}
                onChange={(event) => {
                  setMergeTargetId(event.target.value)
                  setMergePreview(null)
                  setMergeResult(null)
                  setMergeError(null)
                }}
              >
                <option value="">请选择目标家族</option>
                {liveFamilies
                  .filter((candidate) => candidate.id !== mergeFamily.id)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id} title={`成员 ${candidate.member_count} 道`}>
                      {candidate.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>合并原因（写入审计）</span>
              <input
                data-testid="family-merge-reason"
                value={mergeReason}
                onChange={(event) => setMergeReason(event.target.value)}
                placeholder="例如：复核后确认是同一模板的近重复题"
              />
            </label>
          </div>
          <div className="row">
            <button
              className="btn"
              data-testid="family-merge-impact"
              disabled={!mergeTargetId || mergeImpact.isPending}
              onClick={() => mergeImpact.mutate({ familyId: mergeFamily.id, targetFamilyId: mergeTargetId })}
            >
              查看合并影响
            </button>
            <button
              className="btn primary"
              data-testid="family-merge-confirm"
              disabled={
                !mergePreview ||
                mergePreview.familyId !== mergeFamily.id ||
                mergePreview.targetFamilyId !== mergeTargetId ||
                merge.isPending
              }
              onClick={() => merge.mutate({ familyId: mergeFamily.id, targetFamilyId: mergeTargetId })}
            >
              确认合并
            </button>
            <span className="small muted">
              {mergePreview && mergePreview.familyId === mergeFamily.id
                ? '影响预览已加载：请先核对下面的数字，再确认合并。'
                : '确认合并按钮在查看影响之前不可用。'}
            </span>
          </div>

          {mergeError ? (
            <div className="notice danger" data-testid="family-merge-error">
              {mergeError.message}
              {mergeError.problems.length ? (
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {mergeError.problems.map((problem, index) => (
                    <li key={`${problem.code}-${index}`}>
                      {problem.message}（{problem.code}）
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {mergePreview && mergePreview.familyId === mergeFamily.id ? (
            <div className="notice info" data-testid="family-merge-preview">
              <strong>合并影响预览</strong>
              <div className="small">
                「{mergePreview.data.source_family_name}」 → 「{mergePreview.data.target_family_name}」；
                以下数字全部来自服务端：
              </div>
              <ul className="small" style={{ margin: '6px 0 0 18px' }}>
                <li>
                  将移动的题目：{mergePreview.data.questions_to_move} 道（目标家族合并后共{' '}
                  {mergePreview.data.questions_in_target_after} 道题目）
                </li>
                <li>
                  将失效的证据行：{mergePreview.data.evidence_rows_to_invalidate} 行（失效而非删除，
                  原因：家族合并后不再构成不同家族证据）
                </li>
                <li>受影响用户：{mergePreview.data.affected_user_ids.length} 人</li>
                <li>
                  合并前已见题目：{mergePreview.data.exposed_before_merge} 道 → 合并后按合并家族规则为{' '}
                  {mergePreview.data.exposed_after_merge} 道
                </li>
              </ul>
              {mergePreview.data.already_merged ? (
                <div className="small">
                  服务端报告这两个家族此前已经合并过：再次确认不会写入任何内容（noop）。
                </div>
              ) : null}
            </div>
          ) : null}

          {mergeResult && mergeResult.familyId === mergeFamily.id ? (
            <div className="notice ok" data-testid="family-merge-result">
              <strong>合并结果{mergeResult.data.noop ? '（本次没有写入任何内容）' : ''}</strong>
              <div className="small">
                源家族「{familyLabel(familyById.get(mergeResult.data.source_family_id), mergeResult.data.source_family_id)}
                」 → 目标家族「
                {familyLabel(familyById.get(mergeResult.data.target_family_id), mergeResult.data.target_family_id)}
                」 · 目标家族修订 {mergeResult.data.merge_revision}
                {mergeResult.data.content_revision_id
                  ? ` · 审计记录 ${mergeResult.data.content_revision_id.slice(0, 8)}`
                  : ''}
              </div>
              <ul className="small" style={{ margin: '6px 0 0 18px' }}>
                <li>
                  实际移动题目：{mergeResult.data.questions_moved} 道（目标家族现有{' '}
                  {mergeResult.data.questions_in_target_after} 道）
                </li>
                <li>
                  失效证据：{mergeResult.data.evidence_invalidated} 行 · 重算学习状态：
                  {mergeResult.data.states_recomputed} 个
                </li>
                <li>
                  已见题目：合并前 {mergeResult.data.exposed_before_merge} → 合并后{' '}
                  {mergeResult.data.exposed_after_merge} · 曝光变化 {mergeResult.data.exposure_changes.length} 条
                </li>
              </ul>
              {mergePreview &&
              mergePreview.familyId === mergeFamily.id &&
              mergePreview.targetFamilyId === mergeResult.data.target_family_id ? (
                (() => {
                  const differing = mergeComparisons(mergePreview.data, mergeResult.data).filter(
                    (row) => row.preview !== row.actual,
                  )
                  if (!differing.length) {
                    return (
                      <div className="small">预览与实际一致：所有计数都与查看影响时的数字相同。</div>
                    )
                  }
                  return (
                    <div className="notice warn" data-testid="family-merge-difference">
                      <strong>预览与实际不一致：两个数字都列在下面，不隐藏差异</strong>
                      <ul className="small" style={{ margin: '6px 0 0 18px' }}>
                        {differing.map((row) => (
                          <li key={row.label}>
                            {row.label}：预览 {row.preview} · 实际 {row.actual}
                          </li>
                        ))}
                      </ul>
                      <div className="tiny muted">
                        差异通常来自预览之后又有新作答或新证据写入；请按实际数字判断。
                      </div>
                    </div>
                  )
                })()
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
