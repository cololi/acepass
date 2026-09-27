import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiRequest, newIdempotencyKey, type PlanTaskOut, type TodayPlanOut } from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

const TASK_LABELS: Record<string, string> = {
  delayed_verification: '延迟验证',
  paired_immediate: '配对即时验证',
  weakness_repair: '补弱练习',
  undiagnosed_probe: '未诊断考点',
  general_practice: '一般练习',
}

const REASON_LABELS: Record<string, string> = {
  due_delayed_verification: '到期延迟验证',
  paired_immediate: '同一考点的配对验证',
  same_knowledge_node: '同一考点',
  weakness_repair: '已确认薄弱点',
  undiagnosed_node: '该考点尚未诊断',
  general_practice: '补足剩余时间',
  explanation_first: '先看讲解后触发验证',
  anchor_updated: '锚点已被更新的训练刷新',
}

export function TodayPage() {
  const { currentProject, projects } = useScope()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const todayQuery = useQuery({
    queryKey: ['today-plan'],
    queryFn: () => apiRequest<TodayPlanOut>('/study-plans/today'),
  })

  const generate = useMutation({
    mutationFn: (refresh: boolean) =>
      apiRequest<TodayPlanOut>('/study-plans/today/generate', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('plan-generate'),
        body: { refresh },
      }),
    onSuccess: async (data) => {
      toast.push(
        data.plan
          ? `今日计划：预算 ${data.plan.daily_budget_minutes} 分钟，已安排 ${data.plan.allocated_minutes} 分钟`
          : '已生成计划',
        'ok',
      )
      await queryClient.invalidateQueries({ queryKey: ['today-plan'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const startTask = useMutation({
    mutationFn: (task: PlanTaskOut) =>
      apiRequest<{
        create_session_hint: { subject_id: string; question_ids: string[]; task_id: string; purpose: string }
      }>(`/study-tasks/${task.task_id}/start`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('task-start'),
      }).then((data) => ({ ...data, projectId: task.project_id })),
    onSuccess: (data) => {
      const hint = data.create_session_hint
      // The task may belong to a different project than the one currently
      // selected; the workbench adopts `project`/`subject` from the URL so the
      // session is created in the right project (R10).
      const params = new URLSearchParams({
        project: data.projectId,
        subject: hint.subject_id,
        task: hint.task_id,
        purpose: hint.purpose,
      })
      hint.question_ids.forEach((id) => params.append('q', id))
      navigate(`/practice?${params.toString()}`)
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const deferTask = useMutation({
    mutationFn: (taskId: string) =>
      apiRequest(`/study-tasks/${taskId}/defer`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('task-defer'),
        body: { reason: 'user' },
      }),
    onSuccess: async () => {
      toast.push('任务已顺延，保留在列表中并计入积压', 'info')
      await queryClient.invalidateQueries({ queryKey: ['today-plan'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const data = todayQuery.data

  return (
    <>
      <div className="page-title">
        <h1>今日学习</h1>
        <span className="sub">跨项目的总预算安排，顺序为：到期延迟验证 → 薄弱点 → 未诊断考点 → 其他练习。</span>
        <span className="spacer" />
        <button className="btn" disabled={generate.isPending} onClick={() => generate.mutate(false)}>
          {data?.plan ? '补生成缺失任务' : '生成今日计划'}
        </button>
        {data?.plan ? (
          <button className="btn" disabled={generate.isPending} onClick={() => generate.mutate(true)}>
            刷新计划（替换未开始任务）
          </button>
        ) : null}
      </div>

      {todayQuery.isError ? <div className="notice danger">{describeError(todayQuery.error)}</div> : null}

      {!data?.plan ? (
        <div className="card empty-state">
          <p>今天还没有计划。</p>
          <p className="small">
            生成计划会根据你的项目比例分配总预算，并挑选到期复习、薄弱点巩固和尚未诊断的考点。
            {projects.length === 0 ? '（当前还没有进行中的项目）' : ''}
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>
                {data.plan.plan_date} 计划（第 {data.plan.revision} 版）
              </h2>
              <span className="pill">
                预算 {data.plan.daily_budget_minutes} 分钟 / 已安排 {data.plan.allocated_minutes} 分钟
              </span>
            </div>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>比例</th>
                    <th>分配分钟</th>
                  </tr>
                </thead>
                <tbody>
                  {data.plan.allocation.map((row) => (
                    <tr key={row.project_id}>
                      <td>
                        {row.project_name}
                        {currentProject?.id === row.project_id ? <span className="pill" style={{ marginLeft: 6 }}>当前</span> : null}
                      </td>
                      <td>{row.percent}%</td>
                      <td>{row.minutes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.notes.length ? (
              <ul className="small muted" style={{ marginBottom: 0 }}>
                {data.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {data.progress_notes.length ? (
            <div className="notice info">
              {data.progress_notes.map((note, index) => (
                <div key={index}>{note}</div>
              ))}
            </div>
          ) : null}

          {data.backlog.length ? (
            <div className="notice warn">
              积压未完成任务：
              {data.backlog.map((row) => `${row.project_name} ${row.overdue_tasks} 个`).join('；')}
              （顺延展示，不会复制任务）
            </div>
          ) : null}

          <div className="card">
            <h2>今日任务（{data.tasks.length}）</h2>
            {data.tasks.length === 0 ? (
              <div className="empty-state">
                今天没有可安排的合格题目：可能是题目没有已核对答案、预算放不下整题，或全部考点都已安排过。
              </div>
            ) : (
              <div className="stack">
                {data.tasks.map((task) => {
                  const project = projects.find((item) => item.id === task.project_id)
                  return (
                    <div key={task.task_id} className="card" style={{ marginBottom: 0 }}>
                      <div className="row between">
                        <div>
                          <span className="pill neutral">{TASK_LABELS[task.task_kind] ?? task.task_kind}</span>{' '}
                          <strong>{task.question_label || '（无题目）'}</strong>{' '}
                          <span className="small muted">
                            {project?.name ?? ''}
                            {task.knowledge_node_name ? ` · ${task.knowledge_node_name}` : ''}
                          </span>
                        </div>
                        <span className="small muted">预计 {task.estimated_minutes} 分钟</span>
                      </div>
                      <p className="small muted" style={{ margin: '6px 0 4px' }}>
                        原因：
                        {task.reason_codes
                          .map((code) => REASON_LABELS[code] ?? code)
                          .filter((value, index, list) => list.indexOf(value) === index)
                          .join('、')}
                      </p>
                      {task.not_before && !task.available_now ? (
                        <div className="notice warn" style={{ marginBottom: 6 }}>
                          尚未到期：{new Date(task.not_before).toLocaleString()} 起可开始
                          {task.delay_hours ? `（延迟 ${task.delay_hours} 小时）` : ''}
                        </div>
                      ) : null}
                      {task.deficit_notice ? <div className="notice warn">{task.deficit_notice}</div> : null}
                      <div className="row">
                        <button className="btn primary small" disabled={startTask.isPending} onClick={() => startTask.mutate(task)}>
                          开始
                        </button>
                        <button className="btn small" disabled={deferTask.isPending} onClick={() => deferTask.mutate(task.task_id)}>
                          顺延
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
