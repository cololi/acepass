import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  allocateBudget,
  nextDay,
  planDeltaMinutes,
  questionMinutes,
  DEFAULT_MINUTES_BY_TYPE,
  RULE_VERSION,
} from '../src/domain/planner.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/planner.json', import.meta.url), 'utf8'))

test(`allocateBudget(): ${golden.allocate.length} golden splits — order, minutes, percent, notes, rotation`, () => {
  for (const c of golden.allocate) {
    assert.deepEqual(allocateBudget(c.input), c.expected, c.name)
  }
})

test(`questionMinutes(): ${golden.question_minutes.length} golden estimates`, () => {
  for (const c of golden.question_minutes) {
    assert.equal(questionMinutes(c.facts), c.expected, JSON.stringify(c.facts))
  }
})

test('nextDay() / planDeltaMinutes() match the Python one-liners', () => {
  for (const c of golden.next_day) assert.equal(nextDay(c.input), c.expected, c.input)
  for (const c of golden.plan_delta_minutes) assert.equal(planDeltaMinutes(c.input), c.expected)
})

test('invariant: an equal split is exact — allocated minutes always sum to the budget', () => {
  // Only the no-percent split is exact. With explicit percentages the largest-remainder pass gives
  // out at most one extra minute per project, so a partial allocation legitimately stays partial
  // (e.g. {"p1": 40} of 60 minutes allocates 26). That is the Python behaviour, not a rounding slip.
  for (const c of golden.allocate) {
    if (c.input.projects.length === 0 || c.input.percentages.length > 0) continue
    const total = (c.expected.projects as Array<{ minutes: number }>).reduce((sum, row) => sum + row.minutes, 0)
    assert.equal(total, c.input.budget_minutes, c.name)
  }
})

test('invariant: a same-day retry is deterministic, and the rotation moves the first project', () => {
  const projects = [
    { id: 'p1', name: '项目1', target_date: null, created_at: '2026-01-01T09:00:00+00:00' },
    { id: 'p2', name: '项目2', target_date: null, created_at: '2026-01-01T09:01:00+00:00' },
    { id: 'p3', name: '项目3', target_date: null, created_at: '2026-01-01T09:02:00+00:00' },
  ]
  const first = allocateBudget({ projects, percentages: [], budget_minutes: 100, on_date: '2026-02-01' })
  const again = allocateBudget({ projects, percentages: [], budget_minutes: 100, on_date: '2026-02-01' })
  assert.deepEqual(first, again)
  const second = allocateBudget({ projects, percentages: [], budget_minutes: 100, on_date: '2026-02-02' })
  assert.notDeepEqual(first.projects.map((row) => row.project_id), second.projects.map((row) => row.project_id))
  assert.deepEqual([...first.project_order].sort(), ['p1', 'p2', 'p3'])
})

test('KNOWN-2 ported as-is: a 0% project still receives one remainder minute', () => {
  // Python says "本日不分配任何项目时间" and then hands each project exactly one minute, because the
  // largest-remainder loop does not skip projects with a zero share. Recorded, not fixed: changing it
  // changes the plan a learner already received.
  const result = allocateBudget({
    projects: [{ id: 'p1', name: '项目1', target_date: null, created_at: '2026-01-01T09:00:00+00:00' }],
    percentages: [['p9', 100]],
    budget_minutes: 60,
    on_date: '2026-02-01',
  })
  assert.equal(result.projects[0].percent, 0)
  assert.equal(result.projects[0].minutes, 1)
  assert.ok(result.notes.some((note) => note.includes('本日不分配任何项目时间')))
})

test('registered constants match the Python source of truth', () => {
  assert.equal(RULE_VERSION, 'p0-1')
  assert.deepEqual([...DEFAULT_MINUTES_BY_TYPE.entries()].sort(), [
    ['constructed_response', 15],
    ['fill_blank', 3],
  ])
})
