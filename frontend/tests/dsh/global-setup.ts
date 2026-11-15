/**
 * Start (or reuse) the isolated DSH instance before the first worker boots.
 *
 * The config already calls `ensureServer()` so that `use.baseURL` can carry the
 * one-time token; this hook exists so that a bare `playwright test` with a
 * hand-written config still gets a server, and so a failed boot is reported once
 * instead of once per test.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureServer, readState } from './state'

export default function globalSetup(): void {
  const state = ensureServer()
  const seed = state.seed?.status ?? 'unknown'
  process.stdout.write(
    `[dsh-setup] DSH web ${state.url.replace(/token=.*/, 'token=***')} ` +
      `(pid ${state.pid}, dataRoot ${state.dataRoot}, fixture: ${seed})\n`,
  )
  if (seed !== 'seeded') {
    process.stdout.write(
      `[dsh-setup] WARNING: acceptance fixture is "${seed}" — fixture-dependent cases will be reported, not forced green.\n`,
    )
  }
  // Touch the state again so a later `readState()` (workers) never re-reads a stale cache.
  readState()

  // One trace per run: the report attributes every logical call to its test.
  const trace = path.join(state.dataRoot, '..', `rpc-trace-${process.env.ACEPASS_RUN ?? 'main'}.jsonl`)
  fs.mkdirSync(path.dirname(trace), { recursive: true })
  fs.writeFileSync(trace, '')
}
