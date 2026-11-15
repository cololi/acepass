/**
 * The `/acepass` Command Palette contribution.
 *
 * `ctx.commandUi` is a shell service, so the unit under test is the pure
 * registration seam: the contribution shape the runtime reads (`name`, lazy
 * label/description, `available`, `ui.kind: 'action'`), the fact that `run`
 * opens the panel, and the deliberate failure modes — no command service,
 * duplicate registration, and a throw from the shell's `register` must all
 * leave the panel usable instead of taking the plugin down.
 *
 * No browser and no DSH composition is needed: the module has no React or DOM
 * dependency, which is exactly what lets it be tested here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAcePassCommandRegistered,
  registerAcePassCommands,
  type CommandUiContribution,
  type CommandUiLike,
} from '../src/client/dshCommands.ts'

function recordingCommandUi(): { ui: CommandUiLike; contributions: CommandUiContribution[]; disposed: number } {
  const contributions: CommandUiContribution[] = []
  let disposed = 0
  return {
    contributions,
    get disposed() {
      return disposed
    },
    ui: {
      register(contribution) {
        contributions.push(contribution)
        return () => {
          disposed += 1
        }
      },
    },
  }
}

test('/acepass registers a client-owned action that opens the panel', () => {
  const recorded = recordingCommandUi()
  let opened = 0
  const dispose = registerAcePassCommands({ commandUi: recorded.ui, openPanel: () => (opened += 1) })

  assert.equal(recorded.contributions.length, 1)
  const contribution = recorded.contributions[0]!
  assert.equal(contribution.name, 'acepass')
  assert.equal(contribution.available({} as never), true)
  assert.equal(contribution.ui.kind, 'action')
  assert.equal(typeof contribution.label(), 'string')
  assert.ok(contribution.label().length > 0)
  assert.equal(typeof contribution.description(), 'string')
  assert.ok(contribution.description().length > 0)

  contribution.ui.run({ sessionId: 'anything' })
  assert.equal(opened, 1)
  assert.equal(isAcePassCommandRegistered(), true)

  dispose()
  assert.equal(recorded.disposed, 1)
  assert.equal(isAcePassCommandRegistered(), false)
})

test('a host without the command service registers nothing and stays quiet', () => {
  let opened = 0
  const dispose = registerAcePassCommands({ commandUi: undefined, openPanel: () => (opened += 1) })
  assert.equal(isAcePassCommandRegistered(), false)
  dispose()
  assert.equal(opened, 0)
})

test('a rejected registration does not throw and leaves the panel independent', () => {
  const failing: CommandUiLike = {
    register() {
      throw new Error('ui-commands: duplicate contribution for /acepass')
    },
  }
  const dispose = registerAcePassCommands({ commandUi: failing, openPanel: () => undefined })
  assert.equal(isAcePassCommandRegistered(), false)
  assert.doesNotThrow(() => dispose())
})

test('a throwing openPanel is contained inside run, not propagated into the shell', () => {
  const recorded = recordingCommandUi()
  registerAcePassCommands({
    commandUi: recorded.ui,
    openPanel: () => {
      throw new Error('layout is gone')
    },
  })
  const contribution = recorded.contributions[0]!
  assert.doesNotThrow(() => contribution.ui.run({}))
})
