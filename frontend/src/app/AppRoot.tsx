import { useState } from 'react'
import { AuthProvider, ScopeProvider, ToastProvider, describeError, useAuth } from './context'
import { AppShell } from './AppShell'

function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(email, password)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>AcePass</h1>
        <p className="muted small">以考试得分为目标的个性化刷题、补弱与学习验证系统。</p>
        {error ? <div className="notice danger">{error}</div> : null}
        <label className="field">
          <span>邮箱</span>
          <input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="tiny muted" style={{ marginTop: 10 }}>
          账户由管理员通过命令行创建：<code>python manage.py create_account 邮箱</code>。系统没有默认密码。
        </p>
      </form>
    </div>
  )
}

function Gate() {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        正在检查登录状态…
      </div>
    )
  }
  if (!user) return <LoginScreen />
  return (
    <ScopeProvider>
      <AppShell />
    </ScopeProvider>
  )
}

export function AppRoot() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  )
}
