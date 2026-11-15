/**
 * The stream half of the Remote channel: `GET /api/acepass/stream?op=<name>`.
 *
 * The browser could not open DSH's own Remote stream mux without the generated `RemoteStreamHandle`,
 * but it can read a streaming `Response` from an exact Fetch route. The wire is **Server-Sent
 * Events**, not a bespoke framing, because the migrated client already has a validated SSE reader
 * (`api/tutorStream.ts`) whose resume/duplicate/terminal rules are part of the contract:
 *
 *  * every frame carries a monotonic `seq`; `?after=` resumes strictly after it,
 *  * a reconnect therefore never replays or skips a frame,
 *  * `event: done` is terminal and closes the body,
 *  * `event: error` carries `{code, message}` and is terminal,
 *  * `: keep-alive` comments keep intermediaries from idling the socket out,
 *  * aborting the request calls `cancel()`, so a dropped client stops the producer instead of
 *    leaving it running.
 *
 * Operations are pure producers: they never write business state. A stream that has no migrated
 * producer (the tutoring job queue is still on the phase-3 whitelist) registers an operation that
 * fails with `service_not_migrated` rather than inventing segments.
 */
import { AcePassError, toErrorEnvelope } from '../services/errors.ts'

export interface StreamFrame {
  event: string
  data: unknown
  /** Monotonic within one operation instance; the client's resume cursor. */
  seq: number
}

export interface StreamProducer {
  /** Frames after `after` (exclusive); `done` means the producer will emit no more. */
  next(after: number, signal: AbortSignal): Promise<{ frames: StreamFrame[]; done: boolean }>
  /** Release producer resources when the consumer disappears. */
  cancel(): void
}

export interface StreamOperation {
  name: string
  /** Opens one producer. Throws an `AcePassError` to fail the stream with its code. */
  open(args: URLSearchParams): Promise<StreamProducer>
}

export const HEARTBEAT_MS = 15_000
/** Stop after this much silence even if the producer keeps returning nothing. */
export const IDLE_LIMIT = 10 * 60_000

function sse(event: string, data: unknown, id?: number): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${payload}\n\n`
}

/**
 * Serve one stream request.
 *
 * `op` is looked up in `operations`; an unknown name is a 404 with the standard envelope, so the
 * client can tell "this feature is not migrated" from "the network died".
 */
export async function mountStreamRoute(
  request: Request,
  operations: readonly StreamOperation[],
): Promise<Response> {
  const url = new URL(request.url)
  const name = url.searchParams.get('op') ?? ''
  const operation = operations.find((candidate) => candidate.name === name)
  if (operation === undefined) {
    const envelope = toErrorEnvelope(new AcePassError(`未知的流 ${name || '(空)'}`), 'stream')
    return Response.json(
      { ...envelope.body, error: { ...envelope.body.error, code: 'not_found' } },
      { status: 404, headers: { 'x-content-type-options': 'nosniff' } },
    )
  }
  const afterRaw = url.searchParams.get('after')
  const after = afterRaw === null || afterRaw.trim() === '' ? 0 : Number(afterRaw)
  if (!Number.isFinite(after) || after < 0) {
    return Response.json(
      { error: { code: 'invalid_input', message: 'after 必须是非负整数', details: { after: afterRaw } } },
      { status: 400 },
    )
  }

  const abort = new AbortController()
  let producer: StreamProducer
  try {
    producer = await operation.open(url.searchParams)
  } catch (error) {
    const envelope = toErrorEnvelope(error, 'stream')
    return Response.json(envelope.body, { status: envelope.status })
  }
  request.signal.addEventListener('abort', () => {
    abort.abort()
    producer.cancel()
  })

  const encoder = new TextEncoder()
  const started = Date.now()
  let cursor = after
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'))
      let done = false
      try {
        while (!done && !abort.signal.aborted) {
          const batch = await producer.next(cursor, abort.signal)
          for (const frame of batch.frames) {
            if (frame.seq <= cursor) continue
            controller.enqueue(encoder.encode(sse(frame.event, frame.data, frame.seq)))
            cursor = frame.seq
          }
          done = batch.done
          if (done) break
          if (batch.frames.length === 0) {
            if (Date.now() - started > IDLE_LIMIT) {
              controller.enqueue(encoder.encode(sse('error', { code: 'stream_idle', message: '流长时间无数据' })))
              done = true
              break
            }
            controller.enqueue(encoder.encode(': keep-alive\n\n'))
            await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS))
          }
        }
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(sse('done', { seq: cursor })))
      } catch (error) {
        if (!abort.signal.aborted) {
          const envelope = toErrorEnvelope(error, 'stream')
          controller.enqueue(
            encoder.encode(sse('error', { code: envelope.body.error.code, message: envelope.body.error.message })),
          )
        }
      } finally {
        producer.cancel()
        try {
          controller.close()
        } catch {
          /* already closed by the consumer */
        }
      }
    },
    cancel() {
      abort.abort()
      producer.cancel()
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * The one operation that exists today.
 *
 * Tutoring segments are produced by the phase-3 tutoring queue, which is not migrated. Answering a
 * terminal `error` frame is the honest behavior: the client shows the reason and keeps whatever it
 * had, and no segment is ever invented.
 */
export const unmigratedStream: StreamOperation = {
  name: 'tutor.stream',
  async open() {
    const producer: StreamProducer = {
      async next() {
        return {
          frames: [
            {
              event: 'error',
              seq: 1,
              data: {
                code: 'service_not_migrated',
                message: '辅导流式服务尚未迁移（阶段 3 白名单），不会显示任何片段',
              },
            },
          ],
          done: true,
        }
      },
      cancel() {},
    }
    return producer
  },
}
