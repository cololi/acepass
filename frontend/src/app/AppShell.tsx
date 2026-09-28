import {
  Component,
  Suspense,
  lazy,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { useAuth, useScope } from './context'
import { HomePage } from '../features/projects/HomePage'

/**
 * Route-level code splitting.
 *
 * The first screen only needs the shell, the scope selectors and the project
 * landing page; every other route is a separate chunk fetched when the user
 * actually navigates there. `HomePage` stays eager because `/` is the landing
 * route after login and must paint without a second round trip.
 */
function page<T extends Record<string, unknown>, K extends keyof T & string>(
  loader: () => Promise<T>,
  name: K,
): LazyExoticComponent<ComponentType> {
  return lazy(async () => ({ default: (await loader())[name] as unknown as ComponentType }))
}

const TodayPage = page(() => import('../features/today/TodayPage'), 'TodayPage')
const QuestionBankPage = page(() => import('../features/questions/QuestionBankPage'), 'QuestionBankPage')
const ImportsPage = page(() => import('../features/imports/ImportsPage'), 'ImportsPage')
const CandidateReviewPage = page(
  () => import('../features/imports/CandidateReviewPage'),
  'CandidateReviewPage',
)
const PracticePage = page(() => import('../features/practice/PracticePage'), 'PracticePage')
const GradingPage = page(() => import('../features/practice/GradingPage'), 'GradingPage')
const KnowledgePage = page(() => import('../features/knowledge/KnowledgePage'), 'KnowledgePage')
const SearchPage = page(() => import('../features/search/SearchPage'), 'SearchPage')
const MemoryPage = page(() => import('../features/memory/MemoryPage'), 'MemoryPage')
const ReviewPage = page(() => import('../features/review/ReviewPage'), 'ReviewPage')
const ReportsPage = page(() => import('../features/reports/ReportsPage'), 'ReportsPage')
const SettingsPage = page(() => import('../features/settings/SettingsPage'), 'SettingsPage')

/** Visible loading state: a route chunk is always fetched, never a blank screen. */
export function RouteFallback() {
  return (
    <div className="empty-state route-loading" role="status" aria-live="polite" style={{ paddingTop: 80 }}>
      页面加载中…
    </div>
  )
}

/**
 * A chunk can fail to load (offline, stale hash after a deploy). Showing a
 * reload affordance is the difference between "still loading" and "broken":
 * without this the Suspense fallback would sit there forever.
 */
class RouteErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null }

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  render() {
    if (this.state.message === null) return this.props.children
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        <div className="notice danger">页面资源加载失败：{this.state.message}</div>
        <button className="btn small" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    )
  }
}

export function AppShell() {
  const { user, logout } = useAuth()
  const { projects, currentProject, subjects, currentSubject, selectProject, selectSubject } = useScope()
  const [menuOpen, setMenuOpen] = useState(false)

  if (!user) return null

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">AcePass</span>
        <button className="btn small ghost" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen}>
          {menuOpen ? '收起菜单' : '菜单'}
        </button>
        <nav className={menuOpen ? '' : 'desktop-only'} style={menuOpen ? undefined : undefined}>
          <NavLink to="/" end onClick={() => setMenuOpen(false)}>
            项目
          </NavLink>
          <NavLink to="/today" onClick={() => setMenuOpen(false)}>
            今日学习
          </NavLink>
          <NavLink to="/practice" onClick={() => setMenuOpen(false)}>
            刷题
          </NavLink>
          <NavLink to="/questions" onClick={() => setMenuOpen(false)}>
            题库与导入
          </NavLink>
          <NavLink to="/knowledge" onClick={() => setMenuOpen(false)}>
            考点地图
          </NavLink>
          <NavLink to="/search" onClick={() => setMenuOpen(false)}>
            检索
          </NavLink>
          <NavLink to="/review" onClick={() => setMenuOpen(false)}>
            错题与复习
          </NavLink>
          <NavLink to="/memory" onClick={() => setMenuOpen(false)}>
            记忆卡
          </NavLink>
          <NavLink to="/grading" onClick={() => setMenuOpen(false)}>
            人工评分
          </NavLink>
          <NavLink to="/reports" onClick={() => setMenuOpen(false)}>
            报告
          </NavLink>
          <NavLink to="/settings" onClick={() => setMenuOpen(false)}>
            设置
          </NavLink>
        </nav>
        <span className="spacer" />
        <span className="small muted nowrap">{user.display_name || user.email}</span>
        <button className="btn small" onClick={() => void logout()}>
          退出
        </button>
      </header>

      <div className="context-strip">
        <span>当前项目</span>
        <select
          value={currentProject?.id ?? ''}
          onChange={(event) => selectProject(event.target.value)}
          style={{ width: 'auto', minWidth: 160 }}
          aria-label="选择考试项目"
        >
          {projects.length === 0 ? <option value="">（还没有项目）</option> : null}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <span>科目</span>
        <select
          value={currentSubject?.id ?? ''}
          onChange={(event) => selectSubject(event.target.value)}
          style={{ width: 'auto', minWidth: 140 }}
          aria-label="选择科目"
        >
          {subjects.length === 0 ? <option value="">（无科目）</option> : null}
          {subjects.map((subject) => (
            <option key={subject.id} value={subject.id}>
              {subject.name}
            </option>
          ))}
        </select>
        {currentProject?.is_archived ? <span className="chip">已归档</span> : null}
        <span className="spacer" />
        <span className="tiny">
          所有页面都在「项目 / 科目」上下文中：题库、评分、报告与辅导不跨项目共享。
        </span>
      </div>

      <main>
        <RouteErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/today" element={<TodayPage />} />
              <Route path="/practice" element={<PracticePage />} />
              <Route path="/questions" element={<QuestionBankPage />} />
              <Route path="/imports" element={<ImportsPage />} />
              <Route path="/imports/:jobId/candidates/:candidateId" element={<CandidateReviewPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/grading" element={<GradingPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  )
}
