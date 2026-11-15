/**
 * The outbox consumer.
 *
 * `runOnce` claims one due event, runs its handler under the claim, and confirms with the same
 * token. A handler that throws records a retryable failure instead of confirming, so the retry budget
 * (`outbox.ts`) decides when the work is abandoned rather than this loop guessing.
 *
 * The handler runs *inside* the lease but **outside** the claim transaction: a long job must not hold
 * the SQLite write lock, and the token is what protects the business write (see `holdClaim`).
 *
 * B10 adds the piece that was missing: a **runtime driver**. `startOutboxWorker` runs one bounded
 * round per tick on a stoppable timer, so the events the submission/regrade paths enqueue are
 * actually consumed in a live plugin instead of waiting for a test to call `drain`. It is
 * deliberately not a Celery-style multi-process pool: SQLite has one writer and the outbox row is
 * already the durable queue.
 */
import type { DatabaseSync } from 'node:sqlite'
import { fromDate, type Instant } from '../domain/instant.ts'
import {
  claimEvent,
  dispatchPending,
  failClaim,
  holdClaim,
  markProcessed,
  unresolvedSummary,
  type OutboxEvent,
} from '../store/outbox.ts'
import { transaction } from '../store/db.ts'
import {
  invalidateEvidenceForAnswerVersion,
  rebuildEvidenceForAttempt,
  refreshSessionStates,
  refreshStatesForAttempt,
} from '../services/evidence_rebuild.ts'
import { markProjectStaleForPaper } from '../services/paper_stats.ts'
import {
  applyExtraction,
  markExtractionFailed,
  performExtraction,
  prepareExtraction,
} from '../services/ingestion_extraction.ts'
import type { LlmPort } from '../llm/contract.ts'
import { executeRegradeRun } from '../services/regrade_runs.ts'
import { onAttemptGraded } from '../services/pairing.ts'
import { reconcilePlan } from '../services/plan_reconcile.ts'

export type TopicHandler = (db: DatabaseSync, event: OutboxEvent, now: Instant) => void

/**
 * Topic names that changed between the Django producer and this port.
 *
 * `audit_outbox_event` is one of the exported tables (18 §4.5 F3), so an archive imported from the
 * Django implementation can legitimately contain a *pending* row under the old name. Rewriting
 * imported rows would break the archive digest contract the reconciliation depends on, so the
 * mapping is applied when the row is consumed instead. Everything else keeps its original topic.
 */
export const TOPIC_ALIASES: Readonly<Record<string, string>> = {
  'projection.rebuild_attempt_evidence': 'evidence.rebuild_for_attempt',
}

/** The canonical topic a stored row resolves to (identity for unaliased names). */
export function resolveTopic(topic: string): string {
  return TOPIC_ALIASES[topic] ?? topic
}

/** Async (AI) topics; kept next to `asyncHandlers` and asserted against its keys by the tests. */
export const ASYNC_TOPICS: readonly string[] = ['ingestion.extract_candidate']

/**
 * Every topic this worker can consume, canonical and legacy names included.
 *
 * Used by the D0 retirement check to answer "would this event be understood?" without pretending
 * that an unknown topic is fine.
 */
export function knownTopics(): Set<string> {
  const names = new Set<string>([...Object.keys(defaultHandlers()), ...ASYNC_TOPICS])
  for (const legacy of Object.keys(TOPIC_ALIASES)) names.add(legacy)
  return names
}

/**
 * Unresolved rows whose topic resolves to no handler, grouped by topic.
 *
 * A non-empty result means an import carried work this port cannot perform; the D0 switch is not
 * allowed while it is non-empty (18 §4.3).
 */
export function unknownTopics(db: DatabaseSync): Record<string, number> {
  const known = knownTopics()
  const rows = db
    .prepare(
      `SELECT "topic", COUNT(*) AS n FROM "audit_outbox_event"
        WHERE "processed_at" IS NULL GROUP BY "topic"`,
    )
    .all() as { topic: string; n: number }[]
  const out: Record<string, number> = {}
  for (const row of rows) {
    if (known.has(row.topic)) continue
    out[row.topic] = row.n
  }
  return out
}

/**
 * The D0 gate in one call (`unresolved_summary() == {}` plus "no topic this port cannot consume").
 *
 * `ok` is true only when there is nothing left to confirm *and* every remaining row would be
 * understood. An empty database is `ok`; a database with a `failed` row is not, because `failed`
 * rows still need an operator decision (18 §4.3 D0).
 */
export function outboxHealth(db: DatabaseSync): {
  unresolved: Record<string, number>
  unknown_topics: Record<string, number>
  ok: boolean
} {
  const unresolved = unresolvedSummary(db)
  const unknown = unknownTopics(db)
  return {
    unresolved,
    unknown_topics: unknown,
    ok: Object.keys(unresolved).length === 0 && Object.keys(unknown).length === 0,
  }
}

/**
 * A consumer that has to await outside SQLite (an AI call).
 *
 * The handler owns the short transaction around its business writes and re-checks the claim token
 * inside it; the worker only records the terminal success/failure afterwards. This is the shape
 * 06 §6.3 requires: "不在长 SQLite 事务中 await；重新 holdClaim/检查→短事务应用/确认".
 */
export type AsyncTopicHandler = (
  db: DatabaseSync,
  event: OutboxEvent,
  now: Instant,
  claim: OutboxEvent,
) => Promise<void>

/** Topic → handler. An unknown topic is a bug, not a silent success. */
export function defaultHandlers(): Record<string, TopicHandler> {
  return {
    'evidence.rebuild_for_attempt': (db, event, now) => {
      const attemptId = String((event.payload as Record<string, unknown>).attempt_id ?? '')
      if (attemptId === '') throw new Error('evidence.rebuild_for_attempt is missing attempt_id')
      rebuildEvidenceForAttempt(db, attemptId, now)
    },
    'projection.refresh_paper_stats': (db, event) => {
      const paperId = String((event.payload as Record<string, unknown>).paper_id ?? '')
      if (paperId === '') throw new Error('projection.refresh_paper_stats is missing paper_id')
      markProjectStaleForPaper(db, paperId)
    },
    // The queued half of `POST .../regrades`: a worker may pick the run up before (or instead of)
    // an inline "run now". Execution is idempotent by run status, so both paths converge.
    'projection.run_regrade': (db, event, now) => {
      const runId = String((event.payload as Record<string, unknown>).regrade_run_id ?? '')
      if (runId === '') throw new Error('projection.run_regrade is missing regrade_run_id')
      executeRegradeRun(db, runId, now)
    },
    // Django `projection.regrade_effects`: a regrade changes the grade revision, so the evidence rows
    // must be recomputed before the node state is refreshed. `regrade.ts` enqueues the rebuild half;
    // this handler is the whole effect, so an imported event with the Django name is fully served.
    'projection.regrade_effects': (db, event, now) => {
      const attemptId = String((event.payload as Record<string, unknown>).attempt_id ?? '')
      if (attemptId === '') throw new Error('projection.regrade_effects is missing attempt_id')
      rebuildEvidenceForAttempt(db, attemptId, now)
      refreshStatesForAttempt(db, attemptId, now)
    },
    // Django `learning.on_attempt_graded`: evidence + state + paired A/B/C planning. This port runs
    // `onAttemptGraded` synchronously at submit/confirm time, but the handler stays because an
    // imported pending row (or a future producer) must not be discarded. Every step is idempotent.
    'learning.on_attempt_graded': (db, event, now) => {
      const attemptId = String((event.payload as Record<string, unknown>).attempt_id ?? '')
      if (attemptId === '') throw new Error('learning.on_attempt_graded is missing attempt_id')
      rebuildEvidenceForAttempt(db, attemptId, now)
      refreshStatesForAttempt(db, attemptId, now)
      onAttemptGraded(db, attemptId, now)
    },
    // Django `projection.rebuild_after_answer_change`: a disputed answer invalidates the evidence it
    // supported. This is the whole effect in Django too (it does not rebuild or refresh in place);
    // the invalidation reason is the fixed Chinese string the model stores.
    'projection.rebuild_after_answer_change': (db, event, now) => {
      const answerId = String((event.payload as Record<string, unknown>).answer_key_version_id ?? '')
      if (answerId === '') throw new Error('projection.rebuild_after_answer_change is missing answer_key_version_id')
      invalidateEvidenceForAnswerVersion(db, answerId, now)
    },
    // Django `learning.on_session_finished`: once a verification/exam ends, its evidence becomes
    // eligible and every attempt in the session is rebuilt then projected.
    'learning.on_session_finished': (db, event, now) => {
      const sessionId = String((event.payload as Record<string, unknown>).session_id ?? '')
      if (sessionId === '') throw new Error('learning.on_session_finished is missing session_id')
      refreshSessionStates(db, sessionId, now)
    },
    // `learning.reconcile_plan` (Django) and `plan.generated` (this port) are the same work: the
    // plan exists by the time the event is consumed, so the consumer re-derives instead of failing.
    'plan.generated': (db, event, now) => {
      reconcilePlanEvent(db, event, now)
    },
    'learning.reconcile_plan': (db, event, now) => {
      reconcilePlanEvent(db, event, now)
    },
    // Django's async tutoring job has no asynchronous equivalent here: the DSH route executes the
    // message inside `POST .../messages`. Failing loudly (with the re-run instruction) is honest;
    // silently confirming would claim a generation that never happened.
    'tutoring.run_job': () => {
      throw new Error(
        'tutoring.run_job has no asynchronous equivalent in DSH; re-run it through POST /api/acepass/projects/{project_id}/tutor-sessions/{session_id}/messages',
      )
    },
  }
}

/** Shared body of the two plan topics: the payload only ever carries `plan_id`. */
function reconcilePlanEvent(db: DatabaseSync, event: OutboxEvent, now: Instant): void {
  const planId = String((event.payload as Record<string, unknown>).plan_id ?? '')
  // An empty plan id is Django's documented shape ("reconcile delayed tasks, plan_missing"), not an
  // error; a missing plan is reported by the service, never retried forever.
  reconcilePlan(db, planId, now)
}

export interface WorkerOptions {
  handlers?: Record<string, TopicHandler>
  leaseSeconds?: number
}

/**
 * The AI topics, separated because their handler awaits.
 *
 * `ingestion.extract_candidate` was already enqueued by B3; B5 is what consumes it. A missing
 * candidate/document is an honest no-op (Django returns `candidate_missing`/`document_missing`), a
 * transient provider failure is retried by the outbox, and a provider that is simply not configured
 * is an audited manual degradation — never an infinite retry.
 */
export function asyncHandlers(llm: () => LlmPort): Record<string, AsyncTopicHandler> {
  return {
    'ingestion.extract_candidate': async (db, event, now, claim) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      const importJobId = String(payload['import_job_id'] ?? '')
      const documentId = String(payload['document_id'] ?? '')
      const candidateId = String(payload['candidate_id'] ?? '')
      if (importJobId === '' || documentId === '' || candidateId === '') {
        throw new Error('ingestion.extract_candidate is missing import_job_id/document_id/candidate_id')
      }
      const prepared = prepareExtraction(db, { importJobId, documentId, candidateId })
      // Both "missing" outcomes are zero-write results in Django's service, not worker failures.
      if (prepared === 'candidate_missing' || prepared === 'document_missing') return
      const performed = await performExtraction(db, llm(), prepared, now)
      transaction(db, () => {
        if (holdClaim(db, { eventId: event.id, claimToken: claim.claimToken }) === null) return
        if (performed.effect.kind === 'apply') {
          applyExtraction(
            db,
            {
              candidateId: String(prepared.candidate.id),
              clean: performed.effect.clean,
              call: performed.effect.call,
              expectedRevision: prepared.capturedRevision,
            },
            now,
          )
        } else {
          markExtractionFailed(db, String(prepared.candidate.id), performed.effect.message, now)
        }
      })
    },
  }
}

export interface WorkerResult {
  handled: number
  failed: number
  skipped: number
}

/**
 * Drain up to `limit` due events.
 *
 * `dispatchPending` first leases what is due; each leased event is then claimed with its own token,
 * which is the same two-step the Python worker performs (delivery lease, then consumer claim).
 */
export function runOnce(
  db: DatabaseSync,
  now: Instant,
  options: WorkerOptions & { limit?: number } = {},
): WorkerResult {
  const handlers = options.handlers ?? defaultHandlers()
  const dispatched = dispatchPending(db, {
    now,
    limit: options.limit ?? 10,
    leaseSeconds: options.leaseSeconds,
  })
  let handled = 0
  let failed = 0
  let skipped = 0

  for (const event of dispatched) {
    const claim = claimEvent(db, { eventId: event.id, now, leaseSeconds: options.leaseSeconds })
    if (claim === null) {
      skipped += 1
      continue
    }
    const handler = handlers[resolveTopic(event.topic)]
    if (handler === undefined) {
      // Fail loudly rather than confirm: a topic nobody handles is a registration mistake.
      failClaim(db, {
        eventId: event.id,
        claimToken: claim.claimToken,
        error: `no handler for topic ${event.topic}`,
        recoverable: false,
        now,
      })
      failed += 1
      continue
    }
    try {
      transaction(db, () => {
        const held = holdClaim(db, { eventId: event.id, claimToken: claim.claimToken })
        if (held === null) throw new Error('claim lost before the handler ran')
        handler(db, claim, now)
      })
      markProcessed(db, { eventId: event.id, claimToken: claim.claimToken, now })
      handled += 1
    } catch (error) {
      failClaim(db, {
        eventId: event.id,
        claimToken: claim.claimToken,
        error: error instanceof Error ? error.message : String(error),
        now,
      })
      failed += 1
    }
  }
  return { handled, failed, skipped }
}

/** Drain until nothing is due (bounded by `maxRounds` so a retry storm cannot spin forever). */
export function drain(
  db: DatabaseSync,
  now: Instant,
  options: WorkerOptions & { maxRounds?: number; limit?: number } = {},
): WorkerResult {
  const totals: WorkerResult = { handled: 0, failed: 0, skipped: 0 }
  const maxRounds = options.maxRounds ?? 50
  for (let round = 0; round < maxRounds; round += 1) {
    const result = runOnce(db, now, options)
    totals.handled += result.handled
    totals.failed += result.failed
    totals.skipped += result.skipped
    if (result.handled + result.failed + result.skipped === 0) break
  }
  return totals
}

/**
 * One drain round that can await AI work.
 *
 * Sync topics keep the exact `runOnce` semantics; AI topics are claimed, awaited **outside** the
 * write transaction, and only then apply their guarded write. `markProcessed` with the claim token
 * is the only terminal success, so a lost lease cannot confirm the event.
 */
export async function runOnceAsync(
  db: DatabaseSync,
  now: Instant,
  options: WorkerOptions & { llm: () => LlmPort; asyncHandlers?: Record<string, AsyncTopicHandler>; limit?: number },
): Promise<WorkerResult> {
  const handlers = options.handlers ?? defaultHandlers()
  const asyncTopics = options.asyncHandlers ?? asyncHandlers(options.llm)
  const dispatched = dispatchPending(db, {
    now,
    limit: options.limit ?? 10,
    leaseSeconds: options.leaseSeconds,
  })
  let handled = 0
  let failed = 0
  let skipped = 0

  for (const event of dispatched) {
    const claim = claimEvent(db, { eventId: event.id, now, leaseSeconds: options.leaseSeconds })
    if (claim === null) {
      skipped += 1
      continue
    }
    const asyncHandler = asyncTopics[resolveTopic(event.topic)]
    if (asyncHandler !== undefined) {
      try {
        await asyncHandler(db, event, now, claim)
        if (markProcessed(db, { eventId: event.id, claimToken: claim.claimToken, now })) handled += 1
        else skipped += 1
      } catch (error) {
        failClaim(db, {
          eventId: event.id,
          claimToken: claim.claimToken,
          error: error instanceof Error ? error.message : String(error),
          now,
        })
        failed += 1
      }
      continue
    }
    const handler = handlers[resolveTopic(event.topic)]
    if (handler === undefined) {
      failClaim(db, {
        eventId: event.id,
        claimToken: claim.claimToken,
        error: `no handler for topic ${event.topic}`,
        recoverable: false,
        now,
      })
      failed += 1
      continue
    }
    try {
      transaction(db, () => {
        const held = holdClaim(db, { eventId: event.id, claimToken: claim.claimToken })
        if (held === null) throw new Error('claim lost before the handler ran')
        handler(db, claim, now)
      })
      markProcessed(db, { eventId: event.id, claimToken: claim.claimToken, now })
      handled += 1
    } catch (error) {
      failClaim(db, {
        eventId: event.id,
        claimToken: claim.claimToken,
        error: error instanceof Error ? error.message : String(error),
        now,
      })
      failed += 1
    }
  }
  return { handled, failed, skipped }
}

/** Drain every due event, including AI topics, with the same bounded-round guard. */
export async function drainAsync(
  db: DatabaseSync,
  now: Instant,
  options: WorkerOptions & {
    llm: () => LlmPort
    asyncHandlers?: Record<string, AsyncTopicHandler>
    maxRounds?: number
    limit?: number
  },
): Promise<WorkerResult> {
  const totals: WorkerResult = { handled: 0, failed: 0, skipped: 0 }
  const maxRounds = options.maxRounds ?? 50
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await runOnceAsync(db, now, options)
    totals.handled += result.handled
    totals.failed += result.failed
    totals.skipped += result.skipped
    if (result.handled + result.failed + result.skipped === 0) break
  }
  return totals
}

// ---------------------------------------------------------------------------
// Runtime driver (B10 / F1)
// ---------------------------------------------------------------------------

export interface OutboxWorkerOptions {
  /** The model port, resolved lazily so a host without a model still consumes sync topics. */
  llm: () => LlmPort
  /** Tick period. One bounded round per tick; a slow handler delays the next tick, never overlaps. */
  intervalMs?: number
  limit?: number
  leaseSeconds?: number
  handlers?: Record<string, TopicHandler>
  asyncHandlers?: Record<string, AsyncTopicHandler>
  /**
   * Injectable clock. Every round stamps its work with `now()` at claim time; the timer itself never
   * invents a timestamp. Tests and the acceptance fixture use the same clock they seeded with, so a
   * rebuild cannot move `as_of`/`computed_at` just because wall-clock time passed.
   */
  now?: () => Instant
  /** Receives unexpected loop failures (a broken store); per-event failures stay in the outbox. */
  onError?: (error: unknown) => void
}

export interface OutboxWorker {
  readonly intervalMs: number
  readonly running: boolean
  /** Run one bounded round now (joins an in-flight round instead of starting a second one). */
  tick(): Promise<WorkerResult>
  /** Stop the timer and wait for the round in flight. Idempotent. */
  stop(): Promise<void>
}

const IDLE_RESULT: WorkerResult = { handled: 0, failed: 0, skipped: 0 }

/**
 * Start the in-process outbox worker.
 *
 * This is the runtime half of the outbox that B9 found missing (18 §4.5 F1): the submission and
 * regrade paths enqueue durable events, and without a driver nothing ever consumed them in a live
 * plugin. The loop is intentionally small:
 *
 *  - **bounded**: one `runOnceAsync` round per tick, itself capped by `limit`; no unbounded drain;
 *  - **non-overlapping**: a tick that is still running makes the next timer call join it, so a slow
 *    AI call cannot stack rounds;
 *  - **stoppable**: `stop()` clears the timer and awaits the in-flight round; the plugin fiber calls
 *    it before the store closes;
 *  - **honest**: a per-event failure is recorded by the outbox (`failClaim`), an unknown topic becomes
 *    a permanent failure, and a broken store reaches `onError` instead of killing the host process.
 *
 * The first tick runs immediately: a process that restarts with pending rows should resume work
 * without waiting a full interval.
 */
export function startOutboxWorker(db: DatabaseSync, options: OutboxWorkerOptions): OutboxWorker {
  const intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? 250))
  const now = options.now ?? (() => fromDate(new Date()))
  let stopped = false
  let inFlight: Promise<WorkerResult> | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  const round = async (): Promise<WorkerResult> => {
    try {
      return await runOnceAsync(db, now(), {
        llm: options.llm,
        limit: options.limit,
        leaseSeconds: options.leaseSeconds,
        handlers: options.handlers,
        asyncHandlers: options.asyncHandlers,
      })
    } catch (error) {
      options.onError?.(error)
      return IDLE_RESULT
    }
  }

  const tick = (): Promise<WorkerResult> => {
    if (inFlight !== null) return inFlight
    if (stopped) return Promise.resolve(IDLE_RESULT)
    inFlight = round().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const stop = async (): Promise<void> => {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (inFlight !== null) await inFlight
  }

  timer = setInterval(() => {
    void tick()
  }, intervalMs)
  // A timer must never be the reason the host process stays alive.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  void tick()

  return {
    intervalMs,
    get running(): boolean {
      return !stopped
    },
    tick,
    stop,
  }
}
