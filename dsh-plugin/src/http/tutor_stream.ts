/**
 * `tutor.stream` — the real producer that replaces the `service_not_migrated` terminal.
 *
 * Port of `backend/apps/tutoring/services/streaming.py::stream_events`. The contract (docs/05 §3
 * B08) is "SSE 断线重连不重复调用；只发送验证后的内容片段，失效来源被拦截":
 *
 *  * **only validated content**: a segment mirrors one block of `TutorJob.result_blocks`, which
 *    `runTutorJob` writes *after* `validateExplainPayload` accepted the model output. Nothing a model
 *    produced raw — a partial stream, an unparsable payload, a fabricated citation — has a block to
 *    mirror, so it cannot be delivered.
 *  * **reconnect does not re-call**: this module never calls a provider and never creates an
 *    `LLMRun`. A reconnect only filters the stored rows (`index > cursor`); generation happened once,
 *    in the POST that created the job.
 *  * **invalidated sources are blocked**: a stale frozen source yields one `error` frame
 *    (`stale_source`) and no segment at all.
 *
 * ## Cursor mapping (host adaptation)
 *
 * The transport (`http/stream.ts`) owns a single monotonic `seq` cursor and drops `seq <= after`; the
 * browser client's resume key is the **segment index** it already holds (`api/tutorStream.ts` sends
 * `?after=<lastIndex>`). This producer therefore maps segment index `i` onto transport `seq = i + 2`
 * and reserves `seq = 1` for the `status` frame:
 *
 *  * a fresh connection (`after = 0`) receives `status`, then every segment;
 *  * a resume with `after = c` is read in the same seq space (`lastIndex = c - 2`), so no segment is
 *    ever skipped and the worst case is re-sending the two segments already behind the cursor. The
 *    client ignores a segment whose index it already holds, and this producer never re-generates
 *    anything, which is the property that matters.
 *
 * When the source is stale the single `error` frame replaces everything else, exactly like Django.
 */
import type { DatabaseSync } from 'node:sqlite'

import { findOne, findRows, type Row } from '../store/repository.ts'
import { InvalidInput } from '../services/errors.ts'
import { requireProject } from '../services/exams.ts'
import { assertJobDeliverable, deliveryBlockReason, isTerminalJob, jobScope, segmentData } from '../services/tutoring.ts'
import type { StreamFrame, StreamOperation, StreamProducer } from './stream.ts'

/** Segment index `i` is frame `i + 2`; `1` belongs to the status frame. */
const SEGMENT_SEQ_OFFSET = 2

export interface TutorStreamDeps {
  db: DatabaseSync
  userId: string
  /** Injected in tests so the timeout branch is deterministic. */
  nowMs?: () => number
  /** How long an in-flight job is followed before an honest `timeout` frame (Django: 30s). */
  budgetMs?: number
}

function statusData(db: DatabaseSync, job: Row, lastEventId: number | null): Record<string, unknown> {
  return {
    tutor_job_id: String(job.id),
    status: String(job.status),
    is_stale: Boolean(job.is_stale),
    segment_count: findRows(db, 'tutoring_segment', { job_id: job.id }).length,
    citation_count: Array.isArray(job.citations) ? job.citations.length : 0,
    finalized: job.finalized_at !== null && job.finalized_at !== undefined,
    is_stub: runIsStub(db, job),
    last_event_id: lastEventId,
  }
}

function runIsStub(db: DatabaseSync, job: Row): boolean {
  if (job.llm_run_id === null || job.llm_run_id === undefined) return false
  const run = findOne(db, 'audit_llm_run', { id: String(job.llm_run_id) })
  return run === null ? false : Boolean(run.is_stub)
}

function segmentCount(db: DatabaseSync, job: Row): number {
  return findRows(db, 'tutoring_segment', { job_id: job.id }).length
}

/** One connection's producer: a bounded database poll, never a provider call. */
class TutorStreamProducer implements StreamProducer {
  readonly #db: DatabaseSync
  readonly #jobId: string
  readonly #startedAt: number
  readonly #budgetMs: number
  readonly #nowMs: () => number
  #cancelled = false
  #terminated = false

  constructor(options: {
    db: DatabaseSync
    jobId: string
    budgetMs: number
    nowMs: () => number
    startedAt: number
  }) {
    this.#db = options.db
    this.#jobId = options.jobId
    this.#budgetMs = options.budgetMs
    this.#startedAt = options.startedAt
    this.#nowMs = options.nowMs
  }

  cancel(): void {
    this.#cancelled = true
  }

  async next(after: number, _signal: AbortSignal): Promise<{ frames: StreamFrame[]; done: boolean }> {
    if (this.#cancelled || this.#terminated) return { frames: [], done: true }
    const job = findOne(this.#db, 'tutoring_job', { id: this.#jobId })
    if (job === null) {
      this.#terminated = true
      return {
        frames: [
          {
            event: 'error',
            seq: 1,
            data: { code: 'not_found', message: '辅导任务不存在或不在当前权限范围' },
          },
        ],
        done: true,
      }
    }
    const cursor = Number.isFinite(after) && after > 0 ? after : 0
    // The frame cursor is a transport seq; the segment cursor is an index. `-2` is the offset above.
    const lastIndex = cursor <= 1 ? -1 : cursor - SEGMENT_SEQ_OFFSET

    const reason = deliveryBlockReason(this.#db, job)
    if (reason !== '') {
      this.#terminated = true
      return {
        frames: [
          {
            event: 'error',
            seq: 1,
            data: {
              code: 'stale_source',
              reason,
              tutor_job_id: String(job.id),
              status: String(job.status),
              last_event_id: lastIndex,
            },
          },
        ],
        done: true,
      }
    }

    const frames: StreamFrame[] = []
    if (lastIndex < 0 && cursor === 0) {
      frames.push({ event: 'status', seq: 1, data: statusData(this.#db, job, null) })
    }
    const rows = findRows(this.#db, 'tutoring_segment', { job_id: job.id }, { orderBy: [['index', 'asc']] })
    const blocked = Boolean(job.is_stale)
    let lastSeq = frames.length > 0 ? frames[frames.length - 1].seq : cursor
    for (const row of rows) {
      const index = Number(row.index)
      if (index <= lastIndex) continue
      const seq = index + SEGMENT_SEQ_OFFSET
      frames.push({ event: 'segment', seq, data: segmentData(row, blocked) })
      lastSeq = seq
    }
    if (isTerminalJob(job)) {
      this.#terminated = true
      frames.push({
        event: 'done',
        seq: lastSeq + 1,
        data: {
          tutor_job_id: String(job.id),
          status: String(job.status),
          is_stale: Boolean(job.is_stale),
          segment_count: segmentCount(this.#db, job),
          citation_count: Array.isArray(job.citations) ? job.citations.length : 0,
          last_event_id: rows.length === 0 ? lastIndex : Number(rows[rows.length - 1].index),
        },
      })
      return { frames, done: true }
    }
    const elapsed = this.#nowMs() - this.#startedAt
    if (elapsed >= this.#budgetMs) {
      this.#terminated = true
      frames.push({
        event: 'timeout',
        seq: lastSeq + 1,
        data: {
          code: 'timeout',
          tutor_job_id: String(job.id),
          status: String(job.status),
          segment_count: segmentCount(this.#db, job),
          last_event_id: rows.length === 0 ? lastIndex : Number(rows[rows.length - 1].index),
          waited_seconds: Math.round((elapsed / 1000) * 1000) / 1000,
        },
      })
      return { frames, done: true }
    }
    return { frames, done: false }
  }
}

/**
 * The `tutor.stream` operation.
 *
 * Scope and the delivery gate run in `open()`, *before* the response starts: an exception raised
 * inside a producer can no longer become a JSON error, so a foreign job is a 404 and gated content a
 * 403 on the stream request itself (Django does the same before it constructs the response).
 */
export function tutorStreamOperation(deps: TutorStreamDeps): StreamOperation {
  return {
    name: 'tutor.stream',
    async open(args: URLSearchParams) {
      const projectId = (args.get('project_id') ?? '').trim()
      const jobId = (args.get('job_id') ?? '').trim()
      if (projectId === '' || jobId === '') {
        throw new InvalidInput('缺少 project_id 或 job_id', {
          details: { project_id: projectId, job_id: jobId },
        })
      }
      requireProject(deps.db, deps.userId, projectId)
      const job = jobScope(deps.db, deps.userId, projectId, jobId)
      assertJobDeliverable(deps.db, job)
      const nowMs = deps.nowMs ?? (() => Date.now())
      return new TutorStreamProducer({
        db: deps.db,
        jobId,
        budgetMs: deps.budgetMs ?? 30_000,
        nowMs,
        startedAt: nowMs(),
      })
    },
  }
}

/** Exported for tests: the affine map between a segment index and its transport seq. */
export function seqForSegmentIndex(index: number): number {
  return index + SEGMENT_SEQ_OFFSET
}

/** Exported for tests: how a transport cursor maps back to "the last segment index I hold". */
export function segmentIndexForCursor(cursor: number): number {
  if (cursor <= 1) return -1
  return cursor - SEGMENT_SEQ_OFFSET
}
