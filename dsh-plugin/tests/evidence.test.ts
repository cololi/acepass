import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Decimal } from '../src/domain/decimal.ts'
import { parseInstant } from '../src/domain/instant.ts'
import { latestLearningAnchor, type AnchorFacts } from '../src/domain/anchors.ts'
import { computeDimensions, type AttemptFacts } from '../src/domain/evidence.ts'
import { projectNodeState, type StateEvidenceRow, type Summary } from '../src/domain/state.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/evidence.json', import.meta.url), 'utf8'))
const anchorFacts = golden.anchor_facts as AnchorFacts
const NOW = parseInstant('2026-03-01T00:00:00+00:00')

/** The golden facts are plain JSON; the port takes Decimal / Instant values. */
function toAttemptFacts(spec: Record<string, any>): AttemptFacts {
  return {
    elapsedMs: spec.elapsedMs,
    firstDeliveredAt: spec.firstDeliveredAt === null ? null : parseInstant(spec.firstDeliveredAt),
    submittedAt: parseInstant(spec.submittedAt),
    answerKeyUsable: spec.answerKeyUsable,
    session: spec.session,
    purpose: spec.purpose,
    grade:
      spec.grade === null
        ? null
        : {
            status: spec.grade.status,
            isFullyConfirmed: spec.grade.isFullyConfirmed,
            confirmedScore:
              spec.grade.confirmedScore === null ? null : Decimal.parse(spec.grade.confirmedScore),
            maxScore: spec.grade.maxScore === null ? null : Decimal.parse(spec.grade.maxScore),
            graderIsSelf: spec.grade.graderIsSelf,
            method: spec.grade.method,
          },
    mappings: spec.mappings,
    assistance: spec.assistance,
    contamination: spec.contamination,
    sameTemplateOtherQuestion: spec.sameTemplateOtherQuestion,
    familyId: spec.familyId,
    familyRelationConfirmed: spec.familyRelationConfirmed,
    familyHasOtherQuestions: spec.familyHasOtherQuestions,
    anchor:
      spec.anchor === null
        ? null
        : { at: spec.anchor.at === null ? null : parseInstant(spec.anchor.at), source: spec.anchor.source },
    delayHours: spec.delayHours,
  }
}

test(`computeDimensions(): ${golden.attempt_cases.length} real-row scenarios — every row identical`, () => {
  const failures: string[] = []
  for (const c of golden.attempt_cases) {
    const got = computeDimensions(toAttemptFacts(c.facts))
    const actual = got.map((row) => ({
      dimension: row.dimension,
      nodeId: row.nodeId,
      qualifies: row.qualifies,
      isCorrect: row.isCorrect,
      scoreFraction: row.scoreFraction === null ? null : row.scoreFraction.toString(),
      exclusionReasons: row.exclusionReasons,
      detail: row.detail,
    }))
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), c.expected_rows)
    } catch (error) {
      failures.push(`#${c.name}\n${(error as Error).message.split('\n').slice(0, 18).join('\n')}`)
    }
  }
  assert.deepEqual(failures, [], `first mismatches:\n\n${failures.join('\n\n')}`)
})

test(`latestLearningAnchor(): ${golden.anchor_cases.length} real-row cases`, () => {
  for (const c of golden.anchor_cases) {
    assert.deepEqual(latestLearningAnchor(anchorFacts, c.query), c.expected, c.query.node_id)
  }
})

test(`projectNodeState(): ${golden.state_sequences.length} real-row sequences`, () => {
  const failures: string[] = []
  for (const steps of golden.state_sequences) {
    for (const [index, step] of steps.entries()) {
      const rows: StateEvidenceRow[] = (step.rows as Array<Record<string, any>>)
        // The queryset filters `grade_revision__gt=0`; that is the store's job, so it is done here.
        .filter((row) => (row.gradeRevision as number) > 0)
        .map((row) => ({
          id: row.id,
          attemptId: row.attemptId,
          dimension: row.dimension,
          qualifies: row.qualifies,
          isCorrect: row.isCorrect,
          gradeEventId: row.gradeEventId,
          templateId: row.templateId,
          questionId: row.questionId,
          computedAt: parseInstant(row.computedAt),
          exclusionReasons: row.exclusionReasons,
        }))
      const previous = {
        summary: step.previous.summary as Summary,
        bestSummary: step.previous.bestSummary as Summary,
      }
      const got = projectNodeState({ rows, previous, now: NOW })
      const { as_of: _asOf, ...rest } = got
      try {
        assert.deepEqual(JSON.parse(JSON.stringify(rest)), step.expected)
      } catch (error) {
        failures.push(
          `node ${step.node_id} step ${index}\n${(error as Error).message.split('\n').slice(0, 16).join('\n')}`,
        )
      }
    }
  }
  assert.deepEqual(failures, [], `first mismatches:\n\n${failures.join('\n\n')}`)
})

test('invariant: AI-estimated, self-confirmed, pending and unusable-answer rows never become strict evidence', () => {
  const cases = golden.attempt_cases as Array<{
    name: string
    facts: Record<string, any>
    expected_rows: Array<{ dimension: string; qualifies: boolean }>
  }>
  for (const name of ['ai-estimated', 'self-confirmed', 'pending-review', 'unusable-answer-key', 'no-elapsed-time']) {
    const c = cases.find((candidate) => candidate.name === name)!
    const independent = c.expected_rows.filter((row) => row.dimension === 'independent_correct')
    assert.ok(independent.length > 0)
    for (const row of independent) assert.equal(row.qualifies, false, name)
  }
  const basic = cases.find((candidate) => candidate.name === 'independent-basic')!
  assert.equal(basic.expected_rows.find((row) => row.dimension === 'independent_correct')!.qualifies, true)
  assert.equal(basic.expected_rows.find((row) => row.dimension === 'repeat_practice')!.qualifies, true)
})

test('invariant: a pending grade is neither a wrong answer nor a zero', () => {
  const cases = golden.attempt_cases as Array<{
    name: string
    expected_rows: Array<{ dimension: string; scoreFraction: string | null; isCorrect: boolean }>
  }>
  const pending = cases.find((candidate) => candidate.name === 'pending-review')!
  for (const row of pending.expected_rows) {
    assert.equal(row.scoreFraction, null)
    assert.equal(row.isCorrect, false)
  }
  const wrong = cases.find((candidate) => candidate.name === 'wrong-answer')!
  assert.equal(wrong.expected_rows[0].scoreFraction, '0.0000')
})

test('invariant: the summary lattice never downgrades best_summary', () => {
  const order = ['undiagnosed', 'needs_foundation', 'completes_with_hints', 'independent', 'handles_unseen', 'delayed_verified']
  for (const steps of golden.state_sequences as Array<Array<{ expected: { summary: string; best_summary: string } }>>) {
    let best = 'undiagnosed'
    for (const step of steps) {
      assert.ok(order.indexOf(step.expected.best_summary) >= order.indexOf(best), 'best_summary went backwards')
      best = step.expected.best_summary
    }
  }
})
