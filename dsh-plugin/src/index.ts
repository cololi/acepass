/**
 * AcePass — DSH plugin entry (Cordis plugin, Node half).
 *
 * Migration status lives in docs/dsh-migration/. This entry wires:
 *  - the `acepass` agent tool (capabilities, fsrs_schedule, ai_explain);
 *  - the dsh-llm backed AI port (no stub, honest `ai_not_configured`);
 *  - the HTTP surface under `/api/acepass/...` over the node:sqlite store.
 *
 * Every dependency is soft. Cordis throws on an un-injected service read, and "no model service" or
 * "no web server" must degrade to a smaller feature set rather than crash the plugin.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createLlmPort, type ModelRoute } from './llm/port.ts'
import { createAcePassTool } from './tools/acepass.ts'
import { openStore, type StoreHandle } from './store/db.ts'
import { ensureOwner as ensureOwnerAccount } from './services/accounts.ts'
import { fromDate } from './domain/instant.ts'
import { mountAcePass } from './http/mount.ts'
import { acepassRoutes } from './http/routes.ts'
import { tutorStreamOperation } from './http/tutor_stream.ts'
import { configureStorage, mediaRootFor } from './ingestion/storage.ts'
import { startOutboxWorker, type OutboxWorker } from './jobs/worker.ts'

export const name = 'acepass'
/** Soft dependencies are declared per `ctx.inject` below so the plugin loads on any host. */
export const inject: string[] = []

export interface Config { dataRoot: string; provider: string; model: string }
export const Config: Schema<Config> = Schema.object({
  dataRoot: Schema.string().default('').description("Data directory; '' means <workspace>/.acepass"),
  provider: Schema.string().default('').description("LLM provider; '' follows the session"),
  model: Schema.string().default('').description("LLM model; '' follows the session"),
})

/** Resolve the store path: an explicit `dataRoot`, else `<cwd>/.acepass`. */
export function resolveStorePath(config: Config, cwd: string): string {
  const root = config.dataRoot && config.dataRoot.trim() !== '' ? config.dataRoot : join(cwd, '.acepass')
  return join(root, 'acepass.sqlite')
}

/**
 * The single local user.
 *
 * The accepted deployment is single-user with workspace isolation (03 §0 D-2), so there is no login:
 * the workspace owner is the user, created on first use. DSH owns authentication. The implementation
 * lives in `services/accounts.ts` so the fixture seeder can bootstrap the same owner without importing
 * a Cordis plugin entry; this wrapper only keeps the historical signature (and the default clock).
 */
export function ensureOwner(db: ReturnType<typeof openStore>['db'], now = fromDate(new Date())): string {
  return ensureOwnerAccount(db, now)
}

export function apply(ctx: Context, config: Config): void {
  const route = (): ModelRoute | undefined =>
    config.provider && config.model ? { provider: config.provider, model: config.model } : undefined
  // `llm` is a soft dependency: Cordis throws on an un-injected property read, and "no model service"
  // must degrade to an honest ai_not_configured rather than crash the tool (R-INV-09).
  const llm = () => {
    try { return ctx.get('llm') as never } catch { return undefined }
  }
  const port = () => createLlmPort({ llm: llm(), route })

  ctx.inject(['tools'], (c) => {
    c.tools.register(createAcePassTool({ llm: port }))
  })

  // The store is opened lazily: a host without a writable workspace can still use the tool.
  let store: StoreHandle | undefined
  let owner: string | undefined
  let worker: OutboxWorker | undefined
  const openOnce = (): { db: StoreHandle['db']; userId: string } => {
    if (store === undefined) {
      const cwd = (ctx.get('workingDirectory') as { path?: string } | undefined)?.path ?? process.cwd()
      const storePath = resolveStorePath(config, cwd)
      // A configured `dataRoot` may not exist yet; the store owns its directory, not the operator.
      mkdirSync(dirname(storePath), { recursive: true })
      store = openStore({ path: storePath })
      owner = ensureOwner(store.db)
      // Private objects live beside the database (`<dataRoot>/private-media`, 06 §5.1) unless the
      // environment names a root explicitly, which is what the tests and an operator restore use.
      configureStorage(process.env.ACEPASS_PRIVATE_MEDIA_ROOT ?? mediaRootFor(dirname(storePath)))
    }
    return { db: store.db, userId: owner! }
  }
  ctx.effect(() => () => {
    // The worker must stop before the connection closes; a round that is still running awaits its
    // own handlers, so the close is deferred until it settles rather than racing it.
    const stopping = worker?.stop()
    worker = undefined
    if (stopping === undefined) {
      store?.close()
      store = undefined
      return
    }
    void stopping.finally(() => {
      store?.close()
      store = undefined
    })
  })

  ctx.inject(['connection'], () => {
    // The profile plugin loads in a child Cordis tree. More than one `HostConnectionService` can be
    // reachable, and only the instance the Web server's `/api` bridge was built from owns the live
    // registry: a route written to the wrong copy answers 404 without any error. Cordis also returns
    // a fresh Proxy per `get`, so the live route table — not object identity — is what dedupes.
    const candidates: any[] = []
    const seenRegistries = new Set<unknown>()
    for (const source of [ctx.root, ctx]) {
      try {
        const found = (source as any).get?.('connection')
        if (found?.fetch?.register === undefined || seenRegistries.has(found.fetchRoutes)) continue
        seenRegistries.add(found.fetchRoutes)
        candidates.push(found)
      } catch { /* service not present in this tree */ }
    }
    ctx.effect(() => {
      const disposers: Array<() => void> = []
      let mounted = false
      for (const conn of candidates) {
        try {
          const { db, userId } = openOnce()
          disposers.push(
            ...mountAcePass(conn, {
              db,
              userId,
              now: () => fromDate(new Date()),
              routes: acepassRoutes({ llm: port }),
              // The tutor stream is a real producer now: it reads the validated segments the job
              // already stored and never calls the model again (B8 §7).
              streams: [tutorStreamOperation({ db, userId })],
            }),
          )
          // One live registry is enough: registering the same exact path twice throws.
          mounted = true
          break
        } catch (error) {
          console.error('[acepass] route mount failed', error)
        }
      }
      if (mounted && worker === undefined) {
        // F1: the durable events the submission/regrade paths enqueue need a live consumer. The
        // loop starts only after the HTTP surface exists, so a host that never served a request does
        // not spin a timer, and a tick is bounded (10 events) and stamped with the wall clock.
        const { db } = openOnce()
        worker = startOutboxWorker(db, {
          llm: port,
          intervalMs: 250,
          onError: (error) => console.error('[acepass] outbox worker error', error),
        })
      }
      return () => {
        void worker?.stop()
        worker = undefined
        for (const dispose of disposers) {
          try { dispose() } catch { /* already withdrawn */ }
        }
      }
    }, 'acepass: http mount')
  })
}
