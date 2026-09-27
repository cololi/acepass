import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiRequest, newIdempotencyKey, type ProjectOut, type SpecOut, type SubjectOut, type SyllabusOut } from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'

interface StudySettings {
  timezone: string
  daily_budget_minutes: number
  project_budget_percent: Record<string, number>
  undiagnosed_time_share_percent: number
  default_practice_tutoring: string
}

const DEFAULT_RULES = {
  single_choice: { default_max_score: '2.00', wrong_score: '0.00', blank_score: '0.00' },
  multiple_choice: {
    default_max_score: '4.00',
    policy: 'exact_match',
    wrong_score: '0.00',
    blank_score: '0.00',
    partial_score: '2.00',
  },
  true_false: { default_max_score: '2.00', wrong_score: '0.00', blank_score: '0.00' },
  fill_blank: { default_max_score: '3.00', mismatch_policy: 'review' },
  constructed_response: { default_max_score: '10.00' },
}

export function SettingsPage() {
  const { currentProject, currentSubject, projects, subjects, reload, selectProject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [budget, setBudget] = useState('60')
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [percentages, setPercentages] = useState<Record<string, string>>({})
  const [undiagnosedShare, setUndiagnosedShare] = useState('20')
  const [subjectName, setSubjectName] = useState('')
  const [syllabusName, setSyllabusName] = useState('用户自建暂定大纲')
  const [specName, setSpecName] = useState('项目计分规则 v1')
  const [rulesJson, setRulesJson] = useState(JSON.stringify(DEFAULT_RULES, null, 2))
  const [ruleSourceNote, setRuleSourceNote] = useState('由用户按自己掌握的信息填写；未标注为官方规则。')
  const [error, setError] = useState('')

  const settingsQuery = useQuery({
    queryKey: ['study-settings'],
    queryFn: () => apiRequest<StudySettings>('/me/study-settings'),
  })

  useEffect(() => {
    const data = settingsQuery.data
    if (!data) return
    setBudget(String(data.daily_budget_minutes))
    setTimezone(data.timezone)
    setUndiagnosedShare(String(data.undiagnosed_time_share_percent))
    setPercentages(
      Object.fromEntries(
        projects.map((project) => [project.id, String(data.project_budget_percent[project.id] ?? '')]),
      ),
    )
  }, [settingsQuery.data, projects])

  const projectId = currentProject?.id ?? null

  const specsQuery = useQuery({
    queryKey: ['specs', projectId, currentSubject?.id],
    queryFn: () => apiRequest<SpecOut[]>(`/projects/${projectId}/exam-spec-versions?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const syllabusQuery = useQuery({
    queryKey: ['syllabus', projectId, currentSubject?.id],
    queryFn: () => apiRequest<SyllabusOut[]>(`/projects/${projectId}/syllabus-versions?subject_id=${currentSubject?.id}`),
    enabled: Boolean(projectId && currentSubject),
  })

  const saveSettings = useMutation({
    mutationFn: () => {
      const cleaned: Record<string, number> = {}
      Object.entries(percentages).forEach(([pid, value]) => {
        if (value.trim() !== '') cleaned[pid] = Number(value)
      })
      return apiRequest<StudySettings>('/me/study-settings', {
        method: 'PATCH',
        body: {
          daily_budget_minutes: Number(budget),
          timezone,
          undiagnosed_time_share_percent: Number(undiagnosedShare),
          project_budget_percent: cleaned,
        },
      })
    },
    onSuccess: async () => {
      setError('')
      toast.push('学习设置已保存', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['study-settings'] })
      await queryClient.invalidateQueries({ queryKey: ['today-plan'] })
    },
    onError: (err) => setError(describeError(err)),
  })

  const createSubject = useMutation({
    mutationFn: () =>
      apiRequest<SubjectOut>(`/projects/${projectId}/subjects`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('subject-create'),
        body: { name: subjectName },
      }),
    onSuccess: async () => {
      toast.push('科目已创建', 'ok')
      setSubjectName('')
      await reload()
      await queryClient.invalidateQueries()
    },
    onError: (err) => setError(describeError(err)),
  })

  const createSyllabus = useMutation({
    mutationFn: () =>
      apiRequest<SyllabusOut>(`/projects/${projectId}/syllabus-versions`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('syllabus-create'),
        body: {
          subject_id: currentSubject?.id,
          name: syllabusName,
          version_label: 'v1',
          is_user_provisional: true,
        },
      }),
    onSuccess: async (syllabus) => {
      await apiRequest(`/projects/${projectId}/syllabus-versions/${syllabus.id}/publish`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('syllabus-publish'),
      })
      toast.push('已创建并发布用户自建大纲（不会冒充官方大纲）', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['syllabus'] })
      await queryClient.invalidateQueries({ queryKey: ['knowledge-map'] })
    },
    onError: (err) => setError(describeError(err)),
  })

  const createSpec = useMutation({
    mutationFn: () => {
      let rules: unknown
      try {
        rules = JSON.parse(rulesJson)
      } catch {
        throw new Error('计分规则 JSON 格式不正确')
      }
      return apiRequest<SpecOut>(`/projects/${projectId}/exam-spec-versions`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('spec-create'),
        body: {
          subject_id: currentSubject?.id,
          name: specName,
          question_type_rules: rules,
          rule_source_note: ruleSourceNote,
          is_demo: false,
          score_floor_at_zero: false,
        },
      })
    },
    onSuccess: async (spec) => {
      await apiRequest(`/projects/${projectId}/exam-spec-versions/${spec.id}/publish`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('spec-publish'),
      })
      toast.push('规范已发布：新会话会固定使用该版本，已发布的旧版本不会被修改', 'ok')
      await queryClient.invalidateQueries({ queryKey: ['specs'] })
    },
    onError: (err) => setError(describeError(err)),
  })

  const archiveProject = useMutation({
    mutationFn: () =>
      apiRequest<ProjectOut>(`/projects/${projectId}/archive`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('project-archive'),
        body: { reason: '用户在设置页归档' },
      }),
    onSuccess: async () => {
      toast.push('项目已归档：历史保留，不再生成新任务', 'ok')
      await reload()
      await queryClient.invalidateQueries()
    },
    onError: (err) => setError(describeError(err)),
  })

  return (
    <>
      <div className="page-title">
        <h1>设置</h1>
        <span className="sub">全局预算、项目科目、大纲与计分规则</span>
      </div>

      {error ? <div className="notice danger">{error}</div> : null}

      <div className="card">
        <h2>全局学习设置</h2>
        <p className="small muted">
          每日总预算由所有进行中的项目共享；未指定比例时按项目等分，并按当地日期轮换顺序，避免总是偏向同一个项目。
        </p>
        <div className="grid three">
          <label className="field">
            <span>每日总预算（分钟）</span>
            <input value={budget} onChange={(event) => setBudget(event.target.value)} />
          </label>
          <label className="field">
            <span>时区（决定“今日”的边界）</span>
            <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </label>
          <label className="field">
            <span>未诊断内容时间占比（%）</span>
            <input value={undiagnosedShare} onChange={(event) => setUndiagnosedShare(event.target.value)} />
          </label>
        </div>
        <h3>项目预算比例</h3>
        <div className="grid three">
          {projects.map((project) => (
            <label className="field" key={project.id}>
              <span>{project.name}（%）</span>
              <input
                value={percentages[project.id] ?? ''}
                placeholder="留空表示等分"
                onChange={(event) => setPercentages({ ...percentages, [project.id]: event.target.value })}
              />
            </label>
          ))}
        </div>
        <button className="btn primary" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
          保存设置
        </button>
      </div>

      <div className="card">
        <h2>项目与科目</h2>
        <div className="grid two">
          <div>
            <h3>项目</h3>
            <ul className="small">
              {projects.map((project) => (
                <li key={project.id}>
                  {project.name} · 科目 {project.subject_count} · 题目 {project.question_count}
                  {currentProject?.id === project.id ? <span className="pill" style={{ marginLeft: 6 }}>当前</span> : null}
                  <button className="btn small ghost" onClick={() => selectProject(project.id)}>
                    切换
                  </button>
                </li>
              ))}
            </ul>
            {currentProject ? (
              <div className="row">
                <button className="btn small danger" disabled={archiveProject.isPending} onClick={() => archiveProject.mutate()}>
                  归档当前项目
                </button>
                <span className="tiny muted">归档前必须结束进行中的会话；历史作答与版本全部保留。</span>
              </div>
            ) : null}
          </div>
          <div>
            <h3>新增科目</h3>
            <div className="inline-field">
              <input value={subjectName} onChange={(event) => setSubjectName(event.target.value)} placeholder="科目名称" />
              <button
                className="btn small"
                disabled={!subjectName.trim() || !projectId || createSubject.isPending}
                onClick={() => createSubject.mutate()}
              >
                添加
              </button>
            </div>
            <ul className="small">
              {subjects.map((subject) => (
                <li key={subject.id}>{subject.name}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <h2>大纲版本</h2>
          <p className="small muted">
            用户自建大纲会被明确标注为非官方；没有大纲时不展示官方覆盖分析。修改名称需要新建版本，历史证据按当时大纲保留。
          </p>
          <div className="inline-field">
            <input value={syllabusName} onChange={(event) => setSyllabusName(event.target.value)} />
            <button
              className="btn small"
              disabled={!currentSubject || createSyllabus.isPending}
              onClick={() => createSyllabus.mutate()}
            >
              创建并发布
            </button>
          </div>
          <ul className="small">
            {(syllabusQuery.data ?? []).map((syllabus) => (
              <li key={syllabus.id}>
                {syllabus.name} {syllabus.version_label} · {syllabus.status} · 考点 {syllabus.node_count}
                {syllabus.is_user_provisional ? <span className="pill warn" style={{ marginLeft: 6 }}>用户自建</span> : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>考试规范（计分规则）</h2>
          <p className="small muted">
            规则由你本人确认：多选题是完全匹配还是少选给部分分、填空无法判断时转复核还是判错，都必须显式选择。
            系统不会假设某个考试的官方规则。
          </p>
          <label className="field">
            <span>规范名称</span>
            <input value={specName} onChange={(event) => setSpecName(event.target.value)} />
          </label>
          <label className="field">
            <span>规则来源说明</span>
            <input value={ruleSourceNote} onChange={(event) => setRuleSourceNote(event.target.value)} />
          </label>
          <label className="field">
            <span>题型规则 JSON</span>
            <textarea value={rulesJson} onChange={(event) => setRulesJson(event.target.value)} style={{ minHeight: 200 }} />
          </label>
          <button className="btn primary" disabled={!currentSubject || createSpec.isPending} onClick={() => createSpec.mutate()}>
            创建并发布规范
          </button>
          <h3>已发布版本</h3>
          <ul className="small">
            {(specsQuery.data ?? []).map((spec) => (
              <li key={spec.id}>
                {spec.name || `v${spec.version}`} · {spec.status}
                {spec.is_demo ? <span className="pill warn" style={{ marginLeft: 6 }}>演示规则</span> : null}
                {spec.rule_source_note ? <div className="tiny muted">{spec.rule_source_note}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card">
        <h2>AI 能力状态</h2>
        <AiStatusPanel projectId={projectId} />
      </div>
    </>
  )
}

function AiStatusPanel({ projectId }: { projectId: string | null }) {
  const statusQuery = useQuery({
    queryKey: ['ai-status', projectId],
    queryFn: () => apiRequest<{ provider: string; configured: boolean; is_stub: boolean; message: string }>(`/projects/${projectId}/ai-status`),
    enabled: Boolean(projectId),
  })
  if (!projectId) return <p className="small muted">请先选择项目。</p>
  if (!statusQuery.data) return <p className="small muted">读取中…</p>
  return (
    <div className={statusQuery.data.configured ? 'notice info' : 'notice warn'}>
      provider：{statusQuery.data.provider} · {statusQuery.data.configured ? (statusQuery.data.is_stub ? '测试/演示 stub' : '真实 provider') : '未配置'}
      <div>{statusQuery.data.message}</div>
      <p className="tiny" style={{ marginBottom: 0 }}>
        配置方式：设置环境变量 ACEPASS_AI_PROVIDER=openai_compatible、ACEPASS_AI_BASE_URL、ACEPASS_AI_API_KEY、
        ACEPASS_AI_TEXT_MODEL / ACEPASS_AI_VISION_MODEL 后重启 API 与 Worker。测试 stub 只在显式测试/演示模式下启用。
      </p>
    </div>
  )
}
