/**
 * DSH Command Palette integration.
 *
 * Typing `/acepass` in a Harness conversation opens the AcePass panel. The
 * command is client-owned (`ctx.commandUi`), so it needs no Host command in the
 * agent catalog and disappears with this plugin. Everything is defensive: a
 * build of DSH without `ui-commands`, a rejected duplicate name, or a layout
 * that is not mounted yet must leave the panel working and the rest of the
 * Harness untouched.
 */

export interface CommandUiContribution {
  name: string
  label: () => string
  description: () => string
  available: (session: unknown) => boolean
  ui: { kind: 'action'; run: (session: unknown) => void }
}

export interface CommandUiLike {
  register(contribution: CommandUiContribution): () => void
}

export interface RegisterOptions {
  commandUi: CommandUiLike | undefined
  /** Opens the AcePass panel; supplied by the client entry (layout service). */
  openPanel: () => void
}

let registered = false

/** Whether `/acepass` was accepted by this browser's command service. */
export function isAcePassCommandRegistered(): boolean {
  return registered
}

/**
 * Register `/acepass`. Returns an idempotent disposer.
 *
 * The command is marked available in every session: the panel is a workspace
 * surface, not session state, so refusing it in an empty conversation would be
 * arbitrary. `run` ignores the session for the same reason.
 */
export function registerAcePassCommands(options: RegisterOptions): () => void {
  const { commandUi, openPanel } = options
  if (commandUi === undefined || registered) return () => undefined

  let dispose: (() => void) | undefined
  try {
    dispose = commandUi.register({
      name: 'acepass',
      label: () => '打开 AcePass',
      description: () => '打开 AcePass 备考面板（今日学习、刷题、考点与报告）',
      available: () => true,
      ui: {
        kind: 'action',
        run: () => {
          try {
            openPanel()
          } catch (error) {
            console.warn('[acepass] /acepass could not open the panel', error)
          }
        },
      },
    })
    registered = true
  } catch (error) {
    // Duplicate names and older command services throw; the panel must still load.
    console.warn('[acepass] /acepass command was not registered', error)
    return () => undefined
  }

  return () => {
    if (!registered) return
    registered = false
    try {
      dispose?.()
    } catch (error) {
      console.warn('[acepass] /acepass command disposer failed', error)
    }
  }
}
