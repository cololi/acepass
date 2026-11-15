import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { newCard, schedule, retrievability, nextIntervalDays, DEFAULT_WEIGHTS, FSRS_VERSION, type CardState } from '../src/domain/fsrs.ts'
import { parseInstant, formatInstant } from '../src/domain/instant.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/fsrs.json', import.meta.url), 'utf8'))
const close = (a: number, b: number, what: string) =>
  assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`)

test('registered version and weights match the Python source of truth', () => {
  assert.equal(FSRS_VERSION, golden.fsrs_version)
  assert.deepEqual([...DEFAULT_WEIGHTS], golden.weights)
})

test('instant round-trips Python isoformat strings', () => {
  for (const s of ['2026-01-01T08:00:00Z', '2026-01-01T08:00:00.123456Z', '2026-01-01T08:01:00.000001Z'])
    assert.equal(formatInstant(parseInstant(s)), s)
})

test(`schedule() reproduces ${golden.cases.length} golden review sequences exactly`, () => {
  let steps = 0
  for (const [ci, c] of golden.cases.entries()) {
    let state: CardState = newCard()
    for (const [si, step] of c.steps.entries()) {
      const res = schedule(state, step.rating, parseInstant(step.at))
      const w = `case ${ci} step ${si}`
      close(res.retrievability, step.retrievability, `${w} R`)
      close(res.intervalDays, step.interval_days, `${w} interval`)
      close(res.elapsedDays, step.elapsed_days, `${w} elapsed`)
      assert.equal(res.phaseAfter, step.phase_after, `${w} phase`)
      assert.equal(res.isLapse, step.is_lapse, `${w} lapse`)
      const g = step.state, s = res.state
      close(s.stability, g.stability, `${w} S`); close(s.difficulty, g.difficulty, `${w} D`)
      assert.equal(s.phase, g.phase); assert.equal(s.reps, g.reps); assert.equal(s.lapses, g.lapses)
      assert.equal(s.learningStep, g.learning_step, `${w} step`)
      assert.equal(formatInstant(s.lastReviewedAt!), g.last_reviewed_at)
      assert.equal(formatInstant(s.dueAt!), g.due_at, `${w} due_at (microsecond parity)`)
      close(s.scheduledDays, g.scheduled_days, `${w} scheduled`)
      state = s; steps++
    }
  }
  assert.ok(steps > 1000)
})

test('scalar helpers match', () => {
  for (const v of golden.scalars) {
    const got = v.fn === 'retrievability' ? retrievability(v.args[0], v.args[1]) : nextIntervalDays(v.args[0], v.args[1])
    close(got, v.value, `${v.fn}(${v.args})`)
  }
})

test('unknown rating and phase are rejected, never defaulted', () => {
  assert.throws(() => schedule(newCard(), 'perfect', 0n))
  assert.throws(() => schedule({ ...newCard(), phase: 'bogus' as never }, 'good', 0n))
})
