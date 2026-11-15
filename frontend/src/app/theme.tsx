/**
 * Theme integration with DeepSeek Harness.
 *
 * Inside DSH the appearance belongs to the shell: `ui-theme` owns the
 * `light` / `dark` / `system` preference, persists it through the Host settings
 * API, applies `body[data-ds-dark-theme]` and publishes the `--dsw-*` tokens
 * this panel reads. The panel therefore must not keep a palette of its own —
 * it registers with the shell's theme service (`ctx.theme`) and renders a
 * control that writes the same preference the DSH Settings page writes.
 *
 * When the panel is opened outside DSH (the standalone Vite app, tests) the
 * service is absent. The same control then persists to `localStorage` and
 * resolves `system` through `prefers-color-scheme`, so both environments keep
 * one API and one visual contract.
 *
 * The resolved scheme is mirrored to `html[data-acepass-theme]`; the stylesheet
 * only reads it for its standalone `--ap-palette-*` fallbacks, never to override
 * the shell tokens.
 */
import { useEffect, useSyncExternalStore, type ReactElement } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** The subset of `ctx.theme` this panel calls (published by `dsh-client-ui-theme`). */
export interface DshThemeService {
  getTheme(): { preference: ThemePreference; active: { colorScheme: ResolvedTheme } }
  setTheme(preference: ThemePreference): void
}

/** Minimal Cordis event surface needed to follow `theme/change`. */
export interface DshEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface ThemeSnapshot {
  /** What the user selected: `system`, `light` or `dark`. */
  preference: ThemePreference
  /** What is actually painted right now. */
  resolved: ResolvedTheme
  /** `dsh` when the Harness theme service is driving the panel. */
  source: 'dsh' | 'local'
}

const STORAGE_KEY = 'acepass.theme'
const ATTRIBUTE = 'data-acepass-theme'
const VALID: readonly ThemePreference[] = ['system', 'light', 'dark']

const listeners = new Set<() => void>()
let service: DshThemeService | undefined
let disposeThemeListener: (() => void) | undefined
let mediaQuery: MediaQueryList | undefined
let installed = false

let snapshot: ThemeSnapshot = { preference: 'system', resolved: 'light', source: 'local' }

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function readLocalPreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system'
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null && (VALID as readonly string[]).includes(stored)) return stored as ThemePreference
  } catch {
    /* storage disabled: the panel still works, the choice is just not remembered */
  }
  return 'system'
}

function writeLocalPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    /* ignore: see readLocalPreference */
  }
}

/** Resolve the current snapshot from the shell service when present, else locally. */
function computeSnapshot(): ThemeSnapshot {
  if (service !== undefined) {
    try {
      const current = service.getTheme()
      const preference = (VALID as readonly string[]).includes(current.preference) ? current.preference : 'system'
      const resolved: ResolvedTheme = current.active?.colorScheme === 'dark' ? 'dark' : 'light'
      return { preference, resolved, source: 'dsh' }
    } catch (error) {
      // A disposed or half-mounted service must degrade to the local control,
      // never leave the panel stuck on the wrong palette.
      console.warn('[acepass] theme service unavailable; falling back to local theme', error)
    }
  }
  const preference = readLocalPreference()
  const resolved: ResolvedTheme = preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference
  return { preference, resolved, source: 'local' }
}

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute(ATTRIBUTE, resolved)
  // Only the standalone document owns `color-scheme`. Inside DSH the shell does;
  // an inline value left behind here would override `html { color-scheme: dark }`
  // and paint native controls (select popups, scrollbars) with the light scheme.
  if (service === undefined) root.style.colorScheme = resolved
  else root.style.removeProperty('color-scheme')
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('[acepass] theme listener failed', error)
    }
  }
}

/** Recompute, write the document attribute, and notify React only on a real change. */
function refresh(): void {
  const next = computeSnapshot()
  const changed =
    next.preference !== snapshot.preference || next.resolved !== snapshot.resolved || next.source !== snapshot.source
  snapshot = next
  applyResolved(next.resolved)
  if (changed) emit()
}

function onSystemSchemeChange(): void {
  if (snapshot.preference === 'system' && service === undefined) refresh()
}

/**
 * Install the module once per browser document.
 *
 * Safe to call from every mount; it is a no-op after the first call.
 */
export function ensureThemeRuntime(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  try {
    if (typeof window.matchMedia === 'function') {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener?.('change', onSystemSchemeChange)
      // Very old WebKit-only engines: keep the control reactive anyway.
      if (typeof mediaQuery.addEventListener !== 'function') {
        mediaQuery.addListener?.(onSystemSchemeChange)
      }
    }
  } catch {
    /* no media query: `system` resolves light, still a valid answer */
  }
  refresh()
}

/**
 * Bind the panel to the Harness theme service (called by the client plugin apply).
 *
 * `events` is the Cordis context that emits `theme/change`; passing it keeps the
 * control in sync with changes made from the DSH Settings page.
 */
export function attachDshThemeRuntime(theme: DshThemeService | undefined, events?: DshEventSource): void {
  detachDshThemeRuntime()
  ensureThemeRuntime()
  if (theme === undefined) return
  service = theme
  if (events !== undefined) {
    try {
      const dispose = events.on('theme/change', () => refresh())
      if (typeof dispose === 'function') disposeThemeListener = dispose as () => void
    } catch (error) {
      console.warn('[acepass] could not subscribe to DSH theme changes', error)
    }
  }
  refresh()
}

/** Unbind on plugin dispose; the panel falls back to its local control. */
export function detachDshThemeRuntime(): void {
  disposeThemeListener?.()
  disposeThemeListener = undefined
  service = undefined
  refresh()
}

/** Change the preference: DSH first (persisted by the shell), local storage otherwise. */
export function setThemePreference(preference: ThemePreference): void {
  if (!(VALID as readonly string[]).includes(preference)) return
  if (service !== undefined) {
    try {
      service.setTheme(preference)
      refresh()
      return
    } catch (error) {
      console.warn('[acepass] DSH theme service refused the preference; using the local control', error)
    }
  }
  writeLocalPreference(preference)
  refresh()
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React binding for the live snapshot (`source` tells the UI where it comes from). */
export function useThemeSnapshot(): ThemeSnapshot {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
}

function SunIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </svg>
  )
}

function MoonIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.8 5.8 0 1 0 6.8 6.8Z" />
    </svg>
  )
}

function AutoIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 2.4v11.2A5.6 5.6 0 0 0 8 2.4Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

const OPTIONS: ReadonlyArray<{ id: ThemePreference; label: string; Icon: () => ReactElement }> = [
  { id: 'system', label: '自动', Icon: AutoIcon },
  { id: 'light', label: '浅色', Icon: SunIcon },
  { id: 'dark', label: '深色', Icon: MoonIcon },
]

/**
 * The appearance control shared by the top bar and the Settings page.
 *
 * It is a segmented group, not a menu: all three choices stay visible so
 * "automatic" cannot be mistaken for "currently dark".
 */
export function ThemeSwitch({ className }: { className?: string }): ReactElement {
  const current = useThemeSnapshot()

  useEffect(() => {
    ensureThemeRuntime()
  }, [])

  const scopeHint = current.source === 'dsh' ? '切换整个 DSH 界面的主题' : '切换本页面主题'
  const resolvedLabel = current.resolved === 'dark' ? '深色' : '浅色'
  return (
    <div
      className={className === undefined ? 'theme-switch' : `theme-switch ${className}`}
      role="group"
      aria-label="主题"
      data-testid="theme-switch"
    >
      {OPTIONS.map(({ id, label, Icon }) => {
        const active = current.preference === id
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            title={`${label} · ${scopeHint}${id === 'system' ? `（当前${resolvedLabel}）` : ''}`}
            data-testid={`theme-${id}`}
            onClick={() => setThemePreference(id)}
          >
            <Icon />
            <span className="theme-switch-label">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Human-readable summary for the Settings page's DSH integration card. */
export function describeThemeSource(current: ThemeSnapshot): string {
  if (current.source === 'dsh') {
    return `DSH 主题服务已连接（${current.preference === 'system' ? '自动' : current.preference === 'dark' ? '深色' : '浅色'}偏好，当前${current.resolved === 'dark' ? '深色' : '浅色'}）；修改会写入 DSH 设置并同步整个界面。`
  }
  return `独立模式：只影响本面板，偏好保存在本机浏览器（当前${current.resolved === 'dark' ? '深色' : '浅色'}）。`
}
