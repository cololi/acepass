import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiRequest, newIdempotencyKey, type ProjectOut } from '../../api/client'
import { describeError, useAuth, useScope, useToast } from '../../app/context'

interface StudySettings {
  timezone: string
  daily_budget_minutes: number
  project_budget_percent: Record<string, number>
  undiagnosed_time_share_percent: number
  default_practice_tutoring: string
}

export function HomePage() {
  const { user } = useAuth()
  const { projects, currentProject, selectProject, reload } = useScope()
  const queryClient = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [error, setError] = useState('')

  const settingsQuery = useQuery({
    queryKey: ['study-settings'],
    queryFn: () => apiRequest<StudySettings>('/me/study-settings'),
  })

  const createProject = useMutation({
    mutationFn: () =>
      apiRequest<ProjectOut>('/projects', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('project-create'),
        body: { name, description, target_date: targetDate || null, target_score: null },
      }),
    onSuccess: async (project) => {
      toast.push(`项目「${project.name}」已创建`, 'ok')
      setShowForm(false)
      setName('')
      setDescription('')
      setTargetDate('')
      setError('')
      await reload()
      selectProject(project.id)
      await queryClient.invalidateQueries()
    },
    onError: (err) => setError(describeError(err)),
  })

  const canCreate = Boolean(name.trim()) && !createProject.isPending

  if (user?.needs_project_setup && projects.length === 0) {
    return (
      <>
        <div className="page-title">
          <h1>开始使用</h1>
        </div>
        <div className="notice info">
          还没有考试项目。请先创建项目并添加科目，然后导入或手工录入题目。系统首版支持多个项目同时备考，每个项目独立管理科目、题库、评分规则与学习状态。
        </div>
        <div className="card">
          <h2>新建考试项目</h2>
          {error ? <div className="notice danger">{error}</div> : null}
          <label className="field">
            <span>项目名称（例如：某某资格考试 2026）</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>目标日期（可空）</span>
            <input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
          </label>
          <label className="field">
            <span>说明（可空）</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <button className="btn primary" disabled={!canCreate} onClick={() => createProject.mutate()}>
            创建项目
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="page-title">
        <h1>我的备考项目</h1>
        <span className="sub">
          每日总预算 {settingsQuery.data ? `${settingsQuery.data.daily_budget_minutes} 分钟` : '（读取中…）'}
          ，由所有进行中的项目共享。
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigate('/today')}>
          查看今日学习
        </button>
        <button className="btn primary" onClick={() => setShowForm((open) => !open)}>
          {showForm ? '取消' : '新建项目'}
        </button>
      </div>

      {showForm ? (
        <div className="card">
          <h2>新建考试项目</h2>
          {error ? <div className="notice danger">{error}</div> : null}
          <div className="grid two">
            <label className="field">
              <span>项目名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span>目标日期（可空）</span>
              <input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>说明（可空）</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <button className="btn primary" disabled={!canCreate} onClick={() => createProject.mutate()}>
            创建
          </button>
        </div>
      ) : null}

      {projects.length === 0 ? (
        <div className="card empty-state">还没有进行中的项目。</div>
      ) : (
        <div className="grid three">
          {projects.map((project) => (
            <div key={project.id} className="card">
              <div className="row between">
                <h3 style={{ margin: 0 }}>{project.name}</h3>
                {currentProject?.id === project.id ? <span className="pill">当前项目</span> : null}
              </div>
              <p className="small muted" style={{ margin: '6px 0' }}>
                {project.description || '（无说明）'}
              </p>
              <p className="small">
                科目 {project.subject_count} 个 · 题目 {project.question_count} 道
                {project.target_date ? ` · 目标日期 ${project.target_date}` : ''}
              </p>
              <div className="row">
                <button className="btn small" onClick={() => selectProject(project.id)}>
                  切换到此项目
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    selectProject(project.id)
                    navigate('/questions')
                  }}
                >
                  进入题库
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => {
                    selectProject(project.id)
                    navigate('/settings')
                  }}
                >
                  项目设置
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
