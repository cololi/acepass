/**
 * AcePass Web client (DSH browser half).
 *
 * The shell gets one `main` panel and one `sidebar.panellist` row. The panel is the migrated
 * frontend: its 13 routes live in a `HashRouter`, so a deep link (`#/questions`) and a reload keep
 * the page, which is what the browser acceptance suite navigates by.
 *
 * The Cordis context is shared with the components through a module-level slot: slot components are
 * plain React elements created by the shell, so they cannot receive the plugin context as a prop.
 */
import { Component, createElement, type ReactNode } from 'react'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import APP_CSS from './app/styles/app.css'
import OVERRIDE_CSS from './overrides.css'
import { AppRoot } from './app/app/AppRoot'
import { attachDshThemeRuntime, detachDshThemeRuntime, ensureThemeRuntime } from './app/theme'
import { registerAcePassCommands } from './dshCommands'

export const name = 'acepass-client'

/** Client plugin rows the shell must load before this bundle runs. */
export const inject = ['connection']

const PANEL_ID = 'acepass'
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 } },
})

let cssInstalled = false
function installCss(): void {
  if (cssInstalled) return
  cssInstalled = true
  const style = document.createElement('style')
  style.dataset.acepassApp = ''
  style.textContent = `${APP_CSS}\n${OVERRIDE_CSS}`
  document.head.append(style)
}

function AcePassIcon() {
  return createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('path', {
      d: 'M2.5 3.5h11v9h-11z M5 6.2h6 M5 8.2h6 M5 10.2h3.5',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinecap: 'round',
    }),
  )
}

class PanelBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null }
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }
  render() {
    if (this.state.message !== null) {
      return createElement('pre', { 'data-acepass': 'error', style: { padding: 16, whiteSpace: 'pre-wrap' } }, `AcePass 渲染失败：\n${this.state.message}`)
    }
    return this.props.children
  }
}

/** The panel is the whole migrated app; the shell owns the outer React root. */
function AcePassPanel() {
  try {
    installCss()
    return createElement(
      PanelBoundary,
      null,
      createElement(
        'div',
        { className: 'acepass-root' },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(HashRouter, null, createElement(AppRoot)),
        ),
      ),
    )
  } catch (error) {
    return createElement('pre', { 'data-acepass': 'error', style: { padding: 16, whiteSpace: 'pre-wrap' } }, `AcePass 初始化失败：${String(error)}`)
  }
}

export function apply(ctx: any): void {
  // Appearance belongs to the shell: follow `ui-theme` (light / dark / system)
  // instead of keeping a panel palette, and expose the same preference the DSH
  // Settings page writes. The service is soft: a host without it falls back to
  // the panel's own localStorage control.
  ensureThemeRuntime()
  ctx.inject(['theme'], (scoped: any) => {
    attachDshThemeRuntime(scoped.theme, scoped)
    scoped.effect(() => () => detachDshThemeRuntime(), 'acepass: DSH theme binding')
  })

  const openPanel = (from: any): void => {
    try {
      from.get('layout')?.selectPanel?.(PANEL_ID)
    } catch {
      /* layout not mounted yet; the sidebar entry still opens the panel */
    }
  }

  // `/acepass` in a Harness conversation opens this panel (client-owned command,
  // so it needs no agent-catalog entry).
  ctx.inject(['commandUi'], (scoped: any) => {
    scoped.effect(
      () =>
        registerAcePassCommands({
          commandUi: scoped.commandUi,
          openPanel: () => openPanel(scoped),
        }),
      'acepass: /acepass command',
    )
  })

  ctx.inject(['slots'], (scoped: any) => {
    scoped.effect(
      () =>
        scoped.slots.inject('main', () =>
          scoped.slots.register({ name: 'main', key: PANEL_ID, locale: 'acepass' }, AcePassPanel),
        ),
      'acepass: main panel',
    )
    scoped.effect(
      () =>
        scoped.slots.inject('sidebar.panellist', () =>
          scoped.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => 'AcePass' },
            AcePassIcon,
          ),
        ),
      'acepass: sidebar entry',
    )
    // A hash deep link (`/#/questions`) must open the panel, or a reload would land on the
    // Conversation while the hash still names an AcePass route.
    scoped.effect(() => {
      const select = () => {
        if (!window.location.hash.startsWith('#/')) return
        openPanel(scoped)
      }
      const timer = window.setTimeout(select, 0)
      return () => window.clearTimeout(timer)
    }, 'acepass: hash deep link')
  })
}
