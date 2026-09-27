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
    void ensureCsrf().then(refresh)
  }, [refresh])

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await apiRequest<{ user: UserOut }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      })
      setUser(result.user)
    },
    [],
  )

  const logout = useCallback(async () => {
    await apiRequest('/auth/logout', { method: 'POST' })
    setUser(null)
  }, [])

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
  reload: () => Promise<void>
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

  useEffect(() => {
    let cancelled = false
    async function loadSubjects() {
      if (!projectId) {
        setSubjects([])
        setSubjectId(null)
        return
      }
      const list = await apiRequest<SubjectOut[]>(`/projects/${projectId}/subjects`)
      if (cancelled) return
      setSubjects(list)
      setSubjectId((current) => {
        if (current && list.some((subject) => subject.id === current)) return current
        return list[0]?.id ?? null
      })
    }
    void loadSubjects()
    return () => {
      cancelled = true
    }
  }, [projectId])

  const value = useMemo<ScopeContextValue>(
    () => ({
      projects,
      currentProject: projects.find((project) => project.id === projectId) ?? null,
      subjects,
      currentSubject: subjects.find((subject) => subject.id === subjectId) ?? null,
      selectProject: (next: string) => {
        setProjectId(next)
        setSubjectId(null)
      },
      selectSubject: setSubjectId,
      reload: loadProjects,
      loading,
    }),
    [projects, projectId, subjects, subjectId, loadProjects, loading],
  )
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useScope() {
  return useContext(ScopeContext)
}
