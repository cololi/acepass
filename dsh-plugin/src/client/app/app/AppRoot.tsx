import { AuthProvider, ToastProvider, ScopeProvider, useAuth } from './context'
import { AppShell } from './AppShell'

/**
 * The AcePass root.
 *
 * There is no login screen: DSH admits the browser and the plugin binds every request to the
 * workspace owner, so the only pre-shell state is "read the profile". A failed profile read is shown
 * as an error instead of a login form, because no password would fix it.
 */
function Gate() {
  const { user, loading, refresh } = useAuth()
  if (loading) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        正在读取账户…
      </div>
    )
  }
  if (!user) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        <div className="notice danger">无法读取本机账户（DSH 会话可能已失效）。</div>
        <button className="btn small" onClick={() => void refresh()}>
          重新读取
        </button>
      </div>
    )
  }
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
