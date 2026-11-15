import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ApiError, apiRequest, ensureCsrf, type ProjectOut, type SubjectOut, type UserOut } from '../api/client'

/* ------------------------------------------------------------------ toasts */
type ToastKind = 'info' | 'ok' | 'error'
interface Toast {
  id: number
  kind: ToastKind
  text: string
}

interface ToastContextValue {
  push: (text: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastContextValue>({ push: () => undefined })

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, kind, text }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200)
  }, [])
  const value = useMemo(() => ({ push }), [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind === 'info' ? '' : toast.kind}`}>
          {toast.text}
        </div>
      ))}
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ai_not_configured') return 'AI 未配置：请先配置 provider 或使用人工解析。'
    const details = error.details as Record<string, unknown> | undefined
    if (details?.problems && Array.isArray(details.problems)) {
      const first = details.problems[0] as { message?: string }
      return `${error.message}：${first?.message ?? ''}`
    }
    if (details?.errors) return `${error.message}（${JSON.stringify(details.errors).slice(0, 200)}）`
    return error.message
  }
  if (error instanceof Error) return error.message
  return '发生未知错误'
}

/* ------------------------------------------------------------------ session */
interface AuthContextValue {
  user: UserOut | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  login: async () => undefined,
  logout: async () => undefined,
  refresh: async () => undefined,
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserOut | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const me = await apiRequest<UserOut>('/auth/me')
      setUser(me)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // DSH owns the identity: the workspace owner is always the user, so there is no login step and
    // no CSRF exchange — only the profile read.
    void refresh()
  }, [refresh])

  // Login and logout are intentionally absent: a browser session is admitted by DSH, and the
  // plugin runs single-user against the workspace owner (03 §0 D-2).
  const login = useCallback(async (_email: string, _password: string) => undefined, [])

  const logout = useCallback(async () => undefined, [])

  const value = useMemo(() => ({ user, loading, login, logout, refresh }), [user, loading, login, logout, refresh])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}

/* --------------------------------------------------- project/subject context */
interface ScopeContextValue {
  projects: ProjectOut[]
  currentProject: ProjectOut | null
  subjects: SubjectOut[]
  currentSubject: SubjectOut | null
  selectProject: (projectId: string) => void
  selectSubject: (subjectId: string) => void
  /** Re-read projects *and* the current project's subjects. */
  reload: () => Promise<void>
  /** Re-read only the current project's subjects. */
  reloadSubjects: () => Promise<SubjectOut[]>
  loading: boolean
}

const ScopeContext = createContext<ScopeContextValue>({
  projects: [],
  currentProject: null,
  subjects: [],
  currentSubject: null,
  selectProject: () => undefined,
  selectSubject: () => undefined,
  reload: async () => undefined,
  reloadSubjects: async () => [],
  loading: false,
})

const PROJECT_STORAGE = 'acepass.currentProject'
const SUBJECT_STORAGE = 'acepass.currentSubject'

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [projects, setProjects] = useState<ProjectOut[]>([])
  const [subjects, setSubjects] = useState<SubjectOut[]>([])
  const [projectId, setProjectId] = useState<string | null>(() => window.localStorage.getItem(PROJECT_STORAGE))
  const [subjectId, setSubjectId] = useState<string | null>(() => window.localStorage.getItem(SUBJECT_STORAGE))
  const [loading, setLoading] = useState(false)

  const loadProjects = useCallback(async () => {
    if (!user) {
      setProjects([])
      return
    }
    setLoading(true)
    try {
      const list = await apiRequest<ProjectOut[]>('/projects')
      setProjects(list)
      setProjectId((current) => {
        if (current && list.some((project) => project.id === current)) return current
        return list[0]?.id ?? null
      })
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (projectId) window.localStorage.setItem(PROJECT_STORAGE, projectId)
    else window.localStorage.removeItem(PROJECT_STORAGE)
  }, [projectId])

  useEffect(() => {
    if (subjectId) window.localStorage.setItem(SUBJECT_STORAGE, subjectId)
    else window.localStorage.removeItem(SUBJECT_STORAGE)
  }, [subjectId])

  /** Fetch the current project's subjects and adopt a valid selection. */
  const fetchSubjects = useCallback(
    async (forProjectId: string | null, options: { keepCurrent?: boolean } = {}): Promise<SubjectOut[]> => {
      const keepCurrent = options.keepCurrent ?? true
      if (!forProjectId) {
        setSubjects([])
        setSubjectId(null)
        return []
      }
      const list = await apiRequest<SubjectOut[]>(`/projects/${forProjectId}/subjects`)
      setSubjects(list)
      setSubjectId((current) =>
        keepCurrent && current && list.some((subject) => subject.id === current)
          ? current
          : (list[0]?.id ?? null),
      )
      return list
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    void fetchSubjects(projectId).catch(() => {
      if (!cancelled) {
        setSubjects([])
        setSubjectId(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [projectId, fetchSubjects])

  const reloadSubjects = useCallback(async () => {
    try {
      return await fetchSubjects(projectId)
    } catch {
      return []
    }
  }, [fetchSubjects, projectId])

  const reload = useCallback(async () => {
    await loadProjects()
    await reloadSubjects()
  }, [loadProjects, reloadSubjects])

  const selectProject = useCallback(
    (next: string) => {
      setProjectId(next)
      // Subjects belong to a project: clear immediately, then load that
      // project's list. A stale subject id from another project must never be
      // used to create a session.
      setSubjectId(null)
      void fetchSubjects(next, { keepCurrent: false })
    },
    [fetchSubjects],
  )

  const value = useMemo<ScopeContextValue>(
    () => ({
      projects,
      currentProject: projects.find((project) => project.id === projectId) ?? null,
      subjects,
      currentSubject: subjects.find((subject) => subject.id === subjectId) ?? null,
      selectProject,
      selectSubject: setSubjectId,
      reload,
      reloadSubjects,
      loading,
    }),
    [projects, projectId, subjects, subjectId, selectProject, reload, reloadSubjects, loading],
  )
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useScope() {
  return useContext(ScopeContext)
}
