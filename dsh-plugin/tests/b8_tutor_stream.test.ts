/**
 * `tutor.stream` semantics: seq/after resume, the single terminal `done`, stale sources and the
 * honest empty stream when nothing was validated.
 *
 * The producer is driven directly (that is where the semantics live) and once through the real
 * transport (`mountStreamRoute`), because the transport owns the `id:`/`event:` framing the browser
 * reads. The rules under test are the ones docs/05 §3 B08 states:
 *
 *  * only validated segments are emitted, and reconnecting re-reads the same rows (no provider call,
 *    no `LLMRun`, no new segment);
 *  * `?after=` never skips a segment — the client may see an already-held one again and drops it by
 *    index;
 *  * a stale frozen source yields exactly one `error` frame (`stale_source`) and no content;
 *  * `cancel()` stops the producer;
 *  * a job that never settles ends in an honest `timeout` frame rather than a truncated transcript.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { countRows, findRows, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { createQuestionRevision, publishQuestionVersion } from '../src/services/questions.ts'
import { createSession, presentItem } from '../src/services/sessions.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { drain } from '../src/jobs/worker.ts'
import { createTutorJob, createTutorSession, runTutorJob } from '../src/services/tutoring.ts'
import { mountStreamRoute } from '../src/http/stream.ts'
import {
  segmentIndexForCursor,
  seqForSegmentIndex,
  tutorStreamOperation,
} from '../src/http/tutor_stream.ts'
import type { LlmPort } from '../src/llm/contract.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2027-07-01T00:00:00+00:00')

function completeRow(table: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const definition = TABLES.find((entry) => entry.name === table)
  assert.ok(definition, `unknown table ${table}`)
  const foreignKeys = new Map(definition.foreignKeys.map((fk) => [fk.column, fk]))
  const row: Record<string, unknown> = {}
  for (const column of definition.columns) {
    if (column.primaryKey || column.name in overrides) continue
    if (!column.notNull) continue
    const fk = foreignKeys.get(column.name)
    if (fk) {
      row[column.name] = `fk-${fk.refTable}`
      continue
    }
    row[column.name] = column.json
      ? {}
      : column.kind === 'datetime'
        ? NOW
        : column.kind === 'int' || column.kind === 'bool'
          ? 0
          : ''
  }
  Object.assign(row, overrides)
  return row
}

const BLOCKS = [
  { kind: 'text', text: '第一段：先列条件。' },
  { kind: 'math', latex: 'x = 20' },
  { kind: 'list', items: ['列式', '计算'] },
]

function explainJson(versionId: string, blocks = BLOCKS): string {
  return JSON.stringify({
    explanation_blocks: blocks,
    citations: [`question_version:${versionId}`],
    suggested_next: [],
    missing_information: [],
    key_conditions: [],
    stuck_points: [],
    method_summary: '',
  })
}

function scriptedPort(text: string, available = true): LlmPort & { calls: number } {
  const port = {
    calls: 0,
    async availability() {
      const table: Record<string, { available: boolean; reason?: string }> = {}
      for (const capability of [
        'extract_question',
        'transcribe_handwriting',
        'suggest_tags',
        'explain',
        'diagnose',
        'estimate_grade',
        'propose_variant',
        'embed',
      ]) {
        table[capability] = available
          ? { available: true }
          : { available: false, reason: 'ai_not_configured' }
      }
      return table as Awaited<ReturnType<LlmPort['availability']>>
    },
    async run(request: Parameters<LlmPort['run']>[0]) {
      port.calls += 1
      if (!available) {
        // The real port refuses before any generation when there is no model (R-INV 4).
        return {
          ok: false as const,
          code: 'ai_not_configured' as const,
          message: 'AI 未配置',
          capability: request.capability,
          promptVersion: request.promptVersion,
          retryable: false,
        }
      }
      return {
        ok: true as const,
        text,
        route: { provider: 'test-provider', model: 'test-model' },
        promptVersion: request.promptVersion,
        capability: request.capability,
        latencyMs: 2,
      }
    },
  }
  return port
}

interface Fixture {
  db: DatabaseSync
  close: () => void
  userId: string
  projectId: string
  otherProjectId: string
  sessionId: string
  itemId: string
  versionId: string
  answerId: string
  tutorSessionId: string
}

function fixture(): Fixture {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'stream@example.com', display_name: '流', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  const project = createProject(db, userId, { name: '流项目' }, NOW)
  const projectId = String(project.id)
  const other = createProject(db, userId, { name: '别的项目' }, NOW)
  const subject = createSubject(db, userId, projectId, { name: '数学' }, NOW)
  const question = insertRow(
    db,
    'question_bank_question',
    completeRow('question_bank_question', {
      subject_id: subject.id,
      origin_type: 'user_authored',
      is_demo: false,
      display_label: 'Q1',
      family_id: null,
    }),
    { now: NOW },
  )
  const draft = createQuestionRevision(
    db,
    userId,
    projectId,
    String(question.id),
    {
      question_type: 'single_choice',
      content: { blocks: [{ kind: 'text', text: '5 × 4 = ?' }], options: [{ id: 'opt_a' }, { id: 'opt_b' }] },
      practice_max_score: '2.00',
    },
    NOW,
  )
  const answer = insertRow(
    db,
    'question_bank_answer_key_version',
    completeRow('question_bank_answer_key_version', {
      question_version_id: draft.id,
      version: 1,
      verification_status: 'checked',
      is_disputed: false,
      answer_payload: { kind: 'single_choice', correct_option_id: 'opt_a' },
      check_basis: '教材',
      explanation_blocks: [],
    }),
    { now: NOW },
  )
  publishQuestionVersion(db, userId, projectId, String(draft.id), { now: NOW })
  const session = createSession(
    db,
    userId,
    projectId,
    {
      subject_id: String(subject.id),
      question_ids: [String(question.id)],
      mode: 'practice',
      duration_minutes: null,
    },
    NOW,
  )
  const item = findRows(db, 'practice_session_item', { session_id: String(session.id) })[0]
  presentItem(db, userId, String(item.id), NOW)
  submitAttempt(
    db,
    userId,
    String(item.id),
    { raw_answer: { type: 'single_choice', selected_option_id: 'opt_a' } },
    NOW + 5_000_000n,
  )
  drain(db, NOW + 5_000_000n)
  const tutorSession = createTutorSession(db, userId, item, 'explanation', NOW)
  return {
    db,
    close: handle.close,
    userId,
    projectId,
    otherProjectId: String(other.id),
    sessionId: String(session.id),
    itemId: String(item.id),
    versionId: String(draft.id),
    answerId: String(answer.id),
    tutorSessionId: String(tutorSession.id),
  }
}

async function succeededJob(f: Fixture): Promise<string> {
  const port = scriptedPort(explainJson(f.versionId))
  const created = createTutorJob(f.db, {
    tutorSession: findRows(f.db, 'tutoring_session', { id: f.tutorSessionId })[0],
    userId: f.userId,
    userQuestion: '讲解一下',
    now: NOW,
  })
  const job = await runTutorJob(f.db, created.job, { port, now: NOW })
  assert.equal(job.status, 'succeeded')
  return String(job.id)
}

async function collect(
  operation: ReturnType<typeof tutorStreamOperation>,
  params: Record<string, string>,
  cursors: number[],
): Promise<{ frames: { event: string; seq: number; data: any }[]; done: boolean }> {
  const producer = await operation.open(new URLSearchParams(params))
  const frames: { event: string; seq: number; data: any }[] = []
  let done = false
  for (const cursor of cursors) {
    const batch = await producer.next(cursor, new AbortController().signal)
    frames.push(...(batch.frames as typeof frames))
    done = batch.done
    if (done) break
  }
  producer.cancel()
  return { frames, done }
}

test('tutor stream: a succeeded job emits status, every validated segment, then done', async () => {
  const f = fixture()
  try {
    const jobId = await succeededJob(f)
    const runsBefore = countRows(f.db, 'audit_llm_run', {})
    const segmentsBefore = countRows(f.db, 'tutoring_segment', {})
    const operation = tutorStreamOperation({ db: f.db, userId: f.userId })
    const { frames, done } = await collect(operation, { project_id: f.projectId, job_id: jobId }, [0])

    assert.equal(done, true)
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['status', 'segment', 'segment', 'segment', 'done'],
    )
    assert.deepEqual(
      frames.map((frame) => frame.seq),
      [1, 2, 3, 4, 5],
      'seq is strictly increasing and segment i maps onto seq i+2',
    )
    assert.equal(frames[0].data.status, 'succeeded')
    assert.equal(frames[0].data.segment_count, 3)
    assert.equal(frames[0].data.is_stub, false)
    assert.deepEqual(
      frames.slice(1, 4).map((frame) => frame.data.kind),
      ['text', 'math', 'list'],
    )
    assert.deepEqual(frames[3].data.items, ['列式', '计算'])
    assert.equal(frames[4].data.segment_count, 3)
    assert.equal(frames[4].data.last_event_id, 2)

    // Streaming is a pure read: no call, no new run row, no new segment.
    assert.equal(countRows(f.db, 'audit_llm_run', {}), runsBefore)
    assert.equal(countRows(f.db, 'tutoring_segment', {}), segmentsBefore)
    assert.equal(seqForSegmentIndex(2), 4)
    assert.equal(segmentIndexForCursor(4), 2)
  } finally {
    f.close()
  }
})

test('tutor stream: after= resumes without skipping a segment and re-sends only held ones', async () => {
  const f = fixture()
  try {
    const jobId = await succeededJob(f)
    const operation = tutorStreamOperation({ db: f.db, userId: f.userId })
    const params = { project_id: f.projectId, job_id: jobId }

    // The client holds segment 0 (last index 0) and reconnects with ?after=0.
    const resumed = await collect(operation, params, [0, 2])
    const indices = resumed.frames.filter((frame) => frame.event === 'segment').map((frame) => frame.data.index)
    assert.deepEqual(indices, [0, 1, 2], 'a reconnect after 0 starts at 0 again — nothing is skipped')
    assert.equal(
      resumed.frames.filter((frame) => frame.event === 'done').length,
      1,
      'exactly one terminal done frame',
    )

    // The transport cursor after reading segment 1 is seq 3; the next batch must start at index 2.
    const heldOne = await collect(operation, params, [3])
    const afterThree = heldOne.frames.filter((frame) => frame.event === 'segment').map((frame) => frame.data.index)
    assert.deepEqual(afterThree, [2], 'the frame cursor resumes strictly after what the transport emitted')

    // A resume at the last segment still terminates with done and no content.
    const atEnd = await collect(operation, params, [4])
    assert.deepEqual(
      atEnd.frames.filter((frame) => frame.event === 'segment'),
      [],
    )
    assert.equal(atEnd.frames[atEnd.frames.length - 1].event, 'done')

    // "No gap": whatever cursor a client resumes from, every segment it does not hold arrives.
    const secondRun = await collect(operation, params, [2])
    assert.deepEqual(
      secondRun.frames.filter((frame) => frame.event === 'segment').map((frame) => frame.data.index),
      [1, 2],
      'a client holding index 0 receives 1 and 2 (0 may be repeated and is dropped by index)',
    )
  } finally {
    f.close()
  }
})

test('tutor stream: with no model the stream is status(unavailable) + done and zero segments', async () => {
  const f = fixture()
  try {
    const created = createTutorJob(f.db, {
      tutorSession: findRows(f.db, 'tutoring_session', { id: f.tutorSessionId })[0],
      userId: f.userId,
      userQuestion: '',
      now: NOW,
    })
    const finished = await runTutorJob(f.db, created.job, {
      port: scriptedPort('', false),
      now: NOW,
    })
    assert.equal(finished.status, 'unavailable')

    const operation = tutorStreamOperation({ db: f.db, userId: f.userId })
    const { frames, done } = await collect(operation, { project_id: f.projectId, job_id: String(finished.id) }, [0])
    assert.equal(done, true)
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['status', 'done'],
      'an unconfigured job delivers no content and no fabricated frame',
    )
    assert.equal(frames[0].data.status, 'unavailable')
    assert.equal(frames[0].data.segment_count, 0)
    assert.equal(frames[1].data.segment_count, 0)
    assert.equal(frames.filter((frame) => frame.event === 'segment').length, 0)
  } finally {
    f.close()
  }
})

test('tutor stream: a stale frozen source yields one error frame and no segment at all', async () => {
  const f = fixture()
  try {
    const jobId = await succeededJob(f)
    // A corrected answer key becomes the effective one: the stored explanation no longer applies.
    insertRow(
      f.db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: f.versionId,
        version: 2,
        verification_status: 'checked',
        is_disputed: false,
        answer_payload: { kind: 'single_choice', correct_option_id: 'opt_b' },
        check_basis: '勘误',
        explanation_blocks: [],
      }),
      { now: NOW + 1_000_000n },
    )
    const operation = tutorStreamOperation({ db: f.db, userId: f.userId })
    const { frames, done } = await collect(operation, { project_id: f.projectId, job_id: jobId }, [0])
    assert.equal(done, true)
    assert.equal(frames.length, 1, 'nothing but the refusal')
    assert.equal(frames[0].event, 'error')
    assert.equal(frames[0].data.code, 'stale_source')
    assert.match(frames[0].data.reason, /答案/)
  } finally {
    f.close()
  }
})

test('tutor stream: an in-flight job ends in an honest timeout frame, and cancel stops the producer', async () => {
  const f = fixture()
  try {
    // A queued job that nobody settles (the shape a worker-owned job has while it runs).
    const queued = insertRow(
      f.db,
      'tutoring_job',
      completeRow('tutoring_job', {
        tutor_session_id: f.tutorSessionId,
        user_id: f.userId,
        project_id: f.projectId,
        purpose: 'explanation',
        status: 'queued',
        request_text: '',
        result_blocks: [],
        citations: [],
        missing_information: [],
        suggested_next: [],
        error_code: '',
        error_message: '',
        llm_run_id: null,
        input_fingerprint: 'f'.repeat(64),
        is_stale: false,
        reveals_answer: false,
        delivered_at: null,
        finalized_at: null,
      }),
      { now: NOW },
    )
    let clock = 1_000
    const operation = tutorStreamOperation({ db: f.db, userId: f.userId, nowMs: () => clock, budgetMs: 30_000 })
    const producer = await operation.open(new URLSearchParams({ project_id: f.projectId, job_id: String(queued.id) }))

    const first = await producer.next(0, new AbortController().signal)
    assert.equal(first.done, false, 'a queued job keeps the stream open')
    assert.deepEqual(
      first.frames.map((frame) => frame.event),
      ['status'],
    )

    clock += 31_000
    const second = await producer.next(1, new AbortController().signal)
    const secondFrame = second.frames[0] as { event: string; data: Record<string, unknown> }
    assert.equal(second.done, true)
    assert.equal(second.frames.length, 1)
    assert.equal(secondFrame.event, 'timeout')
    assert.equal(secondFrame.data['code'], 'timeout')
    assert.equal(secondFrame.data['segment_count'], 0)

    // Cancel is final: no further frame is produced after the consumer disappears.
    const cancelled = await operation.open(new URLSearchParams({ project_id: f.projectId, job_id: String(queued.id) }))
    cancelled.cancel()
    const after = await cancelled.next(0, new AbortController().signal)
    assert.deepEqual(after.frames, [])
    assert.equal(after.done, true)
  } finally {
    f.close()
  }
})

test('tutor stream: scope and arguments are refused before the response starts', async () => {
  const f = fixture()
  try {
    const jobId = await succeededJob(f)
    const operation = tutorStreamOperation({ db: f.db, userId: f.userId })

    await assert.rejects(
      () => operation.open(new URLSearchParams({ project_id: f.projectId, job_id: 'missing' })),
      (error: any) => error.code === 'not_found',
    )
    await assert.rejects(
      () => operation.open(new URLSearchParams({ project_id: 'no-such-project', job_id: jobId })),
      (error: any) => error.code === 'not_found',
    )
    await assert.rejects(
      () => operation.open(new URLSearchParams({ project_id: f.projectId })),
      (error: any) => error.code === 'invalid_input',
    )
    // A job of another owner cannot be opened even inside the same project id.
    const otherUser = insertRow(
      f.db,
      'accounts_user',
      completeRow('accounts_user', { email: 'other@example.com', display_name: '别', date_joined: NOW }),
      { now: NOW },
    )
    const foreign = tutorStreamOperation({ db: f.db, userId: String(otherUser.id) })
    await assert.rejects(
      () => foreign.open(new URLSearchParams({ project_id: f.projectId, job_id: jobId })),
      (error: any) => error.code === 'not_found',
    )
  } finally {
    f.close()
  }
})

test('tutor stream: the transport frames the producer as SSE with resumable ids', async () => {
  const f = fixture()
  try {
    const jobId = await succeededJob(f)
    const operation = tutorStreamOperation({ db: f.db, userId: f.userId })
    const request = new Request(
      `http://host/api/acepass/stream?op=tutor.stream&project_id=${f.projectId}&job_id=${jobId}&after=0`,
    )
    const response = await mountStreamRoute(request, [operation])
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    assert.match(text, /^: connected$/m)
    assert.match(text, /event: status/)
    assert.match(text, /^id: 2$/m)
    assert.match(text, /event: segment/)
    assert.match(text, /event: done/)

    const events = [...text.matchAll(/event: (\w+)/g)].map((match) => match[1])
    assert.equal(events.filter((event) => event === 'segment').length, 3)
    assert.equal(events[events.length - 1], 'done', 'the stream ends in a terminal frame')
  } finally {
    f.close()
  }
})
