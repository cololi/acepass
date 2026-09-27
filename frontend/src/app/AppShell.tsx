import { useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { useAuth, useScope } from './context'
import { HomePage } from '../features/projects/HomePage'
import { TodayPage } from '../features/today/TodayPage'
import { QuestionBankPage } from '../features/questions/QuestionBankPage'
import { ImportsPage } from '../features/imports/ImportsPage'
import { CandidateReviewPage } from '../features/imports/CandidateReviewPage'
import { PracticePage } from '../features/practice/PracticePage'
import { GradingPage } from '../features/practice/GradingPage'
import { KnowledgePage } from '../features/knowledge/KnowledgePage'
import { SearchPage } from '../features/search/SearchPage'
import { MemoryPage } from '../features/memory/MemoryPage'
import { ReviewPage } from '../features/review/ReviewPage'
import { ReportsPage } from '../features/reports/ReportsPage'
import { SettingsPage } from '../features/settings/SettingsPage'

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
      </main>
    </div>
  )
}
