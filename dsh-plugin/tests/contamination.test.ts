import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ABSOLUTE_REASON_CODES,
  REASON_ORDER,
  attemptExclusionReasons,
  evaluateExposure,
  exposureState,
  mergedFamilyScope,
  type ExposureFacts,
} from '../src/domain/contamination.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/contamination.json', import.meta.url), 'utf8'))
const facts = golden.facts as ExposureFacts

test(`exposureState(): ${golden.cases.length} golden cases — seen/reasons/instants/sources/evidence identical`, () => {
  const failures: string[] = []
  for (const c of golden.cases) {
    const got = exposureState(facts, c.query)
    const actual: Record<string, unknown> = {}
    for (const questionId of c.query.question_ids) actual[questionId] = got.get(questionId)
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), c.expected)
    } catch (error) {
      failures.push(`#${c.name}: ${(error as Error).message.split('\n').slice(0, 12).join('\n')}`)
    }
  }
  assert.deepEqual(failures, [], `first mismatches:\n${failures.join('\n\n')}`)
})

test('reason codes keep the stable presentation order, and only absolute ones ignore the window', () => {
  assert.deepEqual(
    [...REASON_ORDER],
    [
      'external_seen',
      'editorial_preview_seen',
      'answer_delivered',
      'explanation_delivered',
      'hint_delivered',
      'feedback_delivered',
      'stem_delivered',
      'presented_without_submit',
      'lineage_seen_in_other_project',
      'family_variant_seen',
    ],
  )
  assert.deepEqual([...ABSOLUTE_REASON_CODES].sort(), ['editorial_preview_seen', 'external_seen'])

  // A declaration recorded *after* the judging instant still contaminates, while a
  // delivery recorded before it does too; the window never removes an absolute fact.
  const cases = golden.cases as Array<{ name: string; expected: Record<string, { reasons: string[] }> }>
  const afterWindow = cases.find((c) => c.name === 'absolute-after-window')!
  const reasons = Object.values(afterWindow.expected)[0].reasons
  assert.ok(reasons.includes('external_seen'), 'absolute reason survives the window')
  assert.ok(!reasons.includes('lineage_seen_in_other_project'), 'windowed reason from after the instant is dropped')
})

test('merged families are scoped from family rows, not from a precomputed map', () => {
  const questions = new Map(facts.questions.map((question) => [question.id, question]))
  const merged = facts.families.filter((family) => family.merged_into_id !== null)
  assert.ok(merged.length > 0, 'fixture has a merged family')
  const target = merged[0].merged_into_id as string
  const scope = mergedFamilyScope(questions, facts.families)
  const members = [...scope.values()][0]
  assert.deepEqual(
    members,
    facts.families.find((family) => family.id === target)!.member_ids.slice().sort(),
  )
  // Ordinary (unmerged) families are not scoped at all.
  assert.equal(scope.size, facts.questions.filter((q) => q.family_id === target).length)
})

test('a question that was presented but never submitted is contaminated; a submitted one is not', () => {
  const evaluated = evaluateExposure(facts, { question_ids: facts.questions.map((q) => q.id), project_id: null })
  const withAttempt = facts.items.filter((item) => item.has_attempt)
  assert.ok(withAttempt.length > 0, 'fixture has a submitted item')
  for (const item of withAttempt) {
    const factIds = (evaluated.get(item.question_id) ?? [])
      .filter((fact) => fact.code === 'presented_without_submit')
      .map((fact) => fact.evidence_id)
    assert.ok(!factIds.includes(item.id), `submitted item ${item.id} must not contaminate`)
  }
  const never = facts.items.filter((item) => !item.has_attempt)
  assert.ok(never.length > 0)
  for (const item of never) {
    // The same question can still be contaminated by other items; the specific
    // fact for this item must be present.
    const factIds = (evaluated.get(item.question_id) ?? [])
      .filter((fact) => fact.code === 'presented_without_submit')
      .map((fact) => fact.evidence_id)
    assert.ok(factIds.includes(item.id), `unsubmitted item ${item.id} must contaminate`)
  }
})

test('an attempt sees only what was knowable when its item was presented', () => {
  const item = facts.items.find((candidate) => candidate.question_id !== null)!
  const state = attemptExclusionReasons(facts, {
    question_id: item.question_id,
    project_id: item.session_project_id,
    first_delivered_at: item.first_delivered_at,
    submitted_at: '2026-01-01T23:59:59+00:00',
    session_item_id: item.id,
  })
  // Its own delivery cannot be held against it.
  assert.ok(!state.some((row) => row.evidence.session_item_id === item.id && row.code === 'presented_without_submit'))
  for (const row of state) {
    if (row.evidence.server_time === null) continue
    if (ABSOLUTE_REASON_CODES.has(row.code)) continue
    assert.ok(
      new Date(row.evidence.server_time) < new Date(item.first_delivered_at),
      `${row.code} at ${row.evidence.server_time} must precede the presentation`,
    )
  }
})
