import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finishFailure } from '../src/llm/finish.ts'

test('llm finish: an aborted stream is a cancellation, never a success', () => {
  assert.deepEqual(finishFailure({ kind: 'aborted' }, { signalAborted: false, timedOut: false }), {
    code: 'ai_cancelled',
    message: '已取消',
  })
  assert.deepEqual(finishFailure({ kind: 'aborted' }, { signalAborted: true, timedOut: true }), {
    code: 'ai_timeout',
    message: '模型调用超时',
  })
  assert.equal(finishFailure(undefined, { signalAborted: true, timedOut: false })?.code, 'ai_cancelled')
})

test('llm finish: a stream error maps dsh-llm codes, by code and never by message text', () => {
  assert.deepEqual(finishFailure({ kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } }, { signalAborted: false, timedOut: false }), {
    code: 'ai_rate_limited',
    message: '429',
  })
  assert.equal(
    finishFailure({ kind: 'error', failure: { code: 'NO_ADAPTER' } }, { signalAborted: false, timedOut: false })?.code,
    'ai_not_configured',
  )
  assert.deepEqual(finishFailure({ kind: 'error' }, { signalAborted: false, timedOut: false }), {
    code: 'ai_error',
    message: 'model error',
  })
})

test('llm finish: a completed stream is not a failure', () => {
  assert.equal(finishFailure(undefined, { signalAborted: false, timedOut: false }), null)
  assert.equal(finishFailure({ kind: 'stop' }, { signalAborted: false, timedOut: false }), null)
})
