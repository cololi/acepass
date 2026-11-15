/**
 * Validated-segment SSE reader for tutor jobs (B08).
 *
 * The backend only emits segments that already passed validation, so the
 * transcript is built from what arrived — never from a half-written model
 * response. The reader is deliberately hand-rolled instead of using
 * `EventSource`:
 *
 *  * a reconnect must carry the resume point in `?after=<lastIndex>` (the
 *    browser `EventSource` always reuses the original URL), and
 *  * `event: error` frames would collide with the transport-level `error`
 *    event that `EventSource` fires for a dropped connection.
 *
 * Aborting the fetch stops the stream locally; it never re-asks the model.
 */

import { tutorStreamUrl, normalizeTutorSegment, type TutorSegmentOut } from './client'

export interface TutorStreamFrame {
  event: string
  data: string
}

/**
 * Incremental SSE framing: returns every complete frame plus the partial tail
 * that must be kept for the next chunk. Comments (`: keep-alive`) carry no
 * field and are dropped.
 */
export function parseSseFrames(buffer: string): { frames: TutorStreamFrame[]; rest: string } {
  const frames: TutorStreamFrame[] = []
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    let event = 'message'
    const dataLines: string[] = []
    let hasField = false
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') {
        event = value
        hasField = true
      } else if (field === 'data') {
        dataLines.push(value)
        hasField = true
      }
      // `id` / `retry` are accepted and ignored: the resume key is the segment
      // index the client already holds, which is what `?after=` takes.
    }
    if (hasField) frames.push({ event, data: dataLines.join('\n') })
  }
  return { frames, rest }
}

export type TutorStreamConnection = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface TutorStreamState {
  connection: TutorStreamConnection
  /** Job status as reported by `status` frames; empty until one arrives. */
  jobStatus: string
  /** The source (question/answer version) is stale: content must not be shown. */
  isStale: boolean
  /** Segment count the server claims to have produced so far. */
  serverSegmentCount: number | null
  segments: TutorSegmentOut[]
  /** Resume point for `?after=`; `null` before the first segment arrives. */
  lastIndex: number | null
  done: boolean
  timedOut: boolean
  /** `error` frame with `code: "stale_source"`: stop, show nothing partial. */
  staleSource: boolean
  staleReason: string
  errorCode: string
  errorText: string
  /** True once a reconnect succeeded; the model was not called again. */
  reconnected: boolean
  reconnectCount: number
  /** Reconnects exhausted: the caller falls back to stored segments. */
  transportFailed: boolean
}

export const initialTutorStreamState: TutorStreamState = {
  connection: 'idle',
  jobStatus: '',
  isStale: false,
  serverSegmentCount: null,
  segments: [],
  lastIndex: null,
  done: false,
  timedOut: false,
  staleSource: false,
  staleReason: '',
  errorCode: '',
  errorText: '',
  reconnected: false,
  reconnectCount: 0,
  transportFailed: false,
}

/** A stream that must stop consuming: no reconnect, no further frames. */
export function tutorStreamFinished(state: TutorStreamState): boolean {
  return state.done || state.timedOut || state.staleSource || Boolean(state.errorCode)
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * Pure frame → state transition, so the live stream and the offline transcript
 * path share exactly one reading of the protocol.
 */
export function reduceTutorStream(state: TutorStreamState, frame: TutorStreamFrame): TutorStreamState {
  let payload: Record<string, unknown> = {}
  if (frame.data) {
    try {
      const parsed = JSON.parse(frame.data)
      payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed }
    } catch {
      payload = { raw: frame.data }
    }
  }
  switch (frame.event) {
    case 'status': {
      const count = payload.segment_count ?? payload.segmentCount
      return {
        ...state,
        jobStatus: textOf(payload.status) || state.jobStatus,
        isStale: payload.is_stale === undefined ? state.isStale : Boolean(payload.is_stale),
        serverSegmentCount: count === undefined || count === null ? state.serverSegmentCount : Number(count),
      }
    }
    case 'segment': {
      const segment = normalizeTutorSegment({
        index: payload.index,
        kind: payload.kind,
        text: payload.text,
        items: payload.items,
        digest: payload.digest,
        is_stale: payload.is_stale,
      })
      // A segment the server already marked stale is never content to show.
      if (segment.is_stale) return { ...state, isStale: true }
      // A replayed segment (same index) is ignored rather than duplicated.
      if (state.segments.some((row) => row.index === segment.index)) return state
      const segments = [...state.segments, segment].sort((a, b) => a.index - b.index)
      const lastIndex = segments.length ? segments[segments.length - 1].index : state.lastIndex
      return { ...state, segments, lastIndex }
    }
    case 'done':
      return { ...state, done: true }
    case 'error': {
      const code = textOf(payload.code)
      if (code === 'stale_source') {
        return { ...state, staleSource: true, staleReason: textOf(payload.reason), isStale: true }
      }
      return {
        ...state,
        errorCode: code || 'stream_error',
        errorText: textOf(payload.reason) || textOf(payload.message) || textOf(payload.raw),
      }
    }
    case 'timeout':
      return { ...state, timedOut: true }
    default:
      return state
  }
}

export interface TutorStreamOptions {
  projectId: string
  jobId: string
  onState: (state: TutorStreamState) => void
  maxReconnects?: number
  reconnectDelayMs?: number
}

/** A non-retryable HTTP answer (gated content, missing job, …). */
class StreamHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function delay(ms: number, register: (timer: number) => void): Promise<void> {
  return new Promise((resolve) => {
    register(window.setTimeout(resolve, ms))
  })
}

export interface TutorStreamHandle {
  /** Stop locally; never calls the model and never replays a finished stream. */
  close: () => void
  /**
   * Resume after `event: timeout` (or any stop that was not `done`): the next
   * request carries `?after=<lastIndex>`, so nothing already received is re-sent
   * and no provider call is made.
   */
  resume: () => void
}

/** Open the stream and return a handle that stops or resumes it. */
export function openTutorStream(options: TutorStreamOptions): TutorStreamHandle {
  const { projectId, jobId, onState } = options
  const maxReconnects = options.maxReconnects ?? 3
  const reconnectDelayMs = options.reconnectDelayMs ?? 700

  let state = initialTutorStreamState
  let closed = false
  let running = false
  let controller: AbortController | null = null
  let timer: number | null = null

  const emit = (next: TutorStreamState) => {
    state = next
    if (!closed) onState(state)
  }

  const close = () => {
    closed = true
    controller?.abort()
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }

  const run = async () => {
    emit({ ...state, connection: 'connecting' })
    while (!closed && !tutorStreamFinished(state)) {
      try {
        controller = new AbortController()
        const response = await fetch(tutorStreamUrl(projectId, jobId, state.lastIndex), {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => '')
          let code = 'stream_http_error'
          let message = `实时通道返回 HTTP ${response.status}`
          try {
            const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
            if (parsed?.error) {
              code = parsed.error.code || code
              message = parsed.error.message || message
            }
          } catch {
            /* a non-JSON body keeps the HTTP wording */
          }
          throw new StreamHttpError(response.status, code, message)
        }
        emit({ ...state, connection: 'open', reconnected: state.reconnectCount > 0 })
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseSseFrames(buffer)
          buffer = parsed.rest
          for (const frame of parsed.frames) {
            emit(reduceTutorStream(state, frame))
            if (tutorStreamFinished(state)) break
          }
          if (tutorStreamFinished(state)) {
            await reader.cancel().catch(() => undefined)
            break
          }
        }
        if (tutorStreamFinished(state)) break
        // The server closed the connection without `done`: reconnect and ask
        // for everything after the last segment we already hold.
        throw new Error('连接已断开')
      } catch (error) {
        if (closed) break
        if (tutorStreamFinished(state)) break
        if (error instanceof StreamHttpError && error.status < 500) {
          // A refusal will not fix itself by retrying: show the server's reason.
          emit({ ...state, connection: 'closed', errorCode: error.code, errorText: error.message })
          break
        }
        if (state.reconnectCount >= maxReconnects) {
          emit({
            ...state,
            connection: 'closed',
            transportFailed: true,
            errorText: '实时通道不可用：已改用服务端已保存的分段记录',
          })
          break
        }
        const nextCount = state.reconnectCount + 1
        emit({ ...state, connection: 'reconnecting', reconnectCount: nextCount })
        try {
          await delay(reconnectDelayMs * nextCount, (handle) => {
            timer = handle
          })
        } catch {
          break
        }
      }
    }
    if (!closed) emit({ ...state, connection: 'closed' })
  }

  const start = () => {
    if (running || closed) return
    running = true
    void run().finally(() => {
      running = false
    })
  }

  const resume = () => {
    if (closed) return
    emit({ ...state, timedOut: false, done: false, errorCode: '', errorText: '', transportFailed: false })
    start()
  }

  start()
  return { close, resume }
}
