import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Decimal } from '../src/domain/decimal.ts'
import { parseInstant } from '../src/domain/instant.ts'
import {
  ALL_DIMENSIONS,
  RULE_VERSION,
  computeDimensions,
  confirmationOk,
  fraction,
  isGradeCorrect,
  type AttemptFacts,
  type GradeFacts,
} from '../src/domain/evidence.ts'
import {
  REQUIRED_DELAYED_CORRECT,
  REQUIRED_DISTINCT_QUESTIONS,
  REQUIRED_DISTINCT_TEMPLATES,
  RECENT_FAILURES_FOR_REVIEW,
  RECENT_WINDOW,
  SUMMARY,
  SUMMARY_ORDER,
  projectNodeState,
  summaryFromCounts,
  missingEvidence,
  type StateEvidenceRow,
  type Summary,
} from '../src/domain/state.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/evidence_state.json', import.meta.url), 'utf8'))

/** The golden grade payload is the Django model's shape; the port takes camelCase facts. */
function gradeFacts(spec: Record<string, unknown> | null): GradeFacts | null {
  if (spec === null) return null
  return {
    status: spec.status as string,
    isFullyConfirmed: spec.is_fully_confirmed as boolean,
    confirmedScore: spec.confirmed_score === null ? null : Decimal.parse(spec.confirmed_score as string),
    maxScore: spec.max_score === null ? null : Decimal.parse(spec.max_score as string),
    graderIsSelf: spec.grader_is_self as boolean,
    method: spec.method as string,
  }
}

function attemptFacts(input: Record<string, any>): AttemptFacts {
  return {
    elapsedMs: input.elapsed_ms,
    firstDeliveredAt: input.first_delivered_at === null ? null : parseInstant(input.first_delivered_at),
    submittedAt: parseInstant(input.submitted_at),
    answerKeyUsable: input.answer_key_usable,
    session: { mode: input.session.mode, status: input.session.status },
    purpose: input.purpose,
    grade: gradeFacts(input.grade),
    mappings: input.mappings.map((mapping: any) => ({
      nodeId: mapping.node_id,
      nodeName: mapping.node_name,
      templateId: mapping.template_id,
      mappingRevision: mapping.mapping_revision,
    })),
    assistance: {
      answerRevealingKinds: input.assistance.answer_revealing_kinds,
      hintBeforeSubmit: input.assistance.hint_before_submit,
    },
    contamination: input.contamination,
    sameTemplateOtherQuestion: input.same_template_other_question,
    familyId: input.family_id,
    familyRelationConfirmed: input.family_relation_confirmed,
    familyHasOtherQuestions: input.family_has_other_questions,
    anchor: input.anchor === null ? null : { at: input.anchor.at === null ? null : parseInstant(input.anchor.at), source: input.anchor.source },
    delayHours: input.delay_hours,
  }
}

test('evidence: rule version and dimension list match the Python source of truth', () => {
  assert.equal(RULE_VERSION, golden.source.evidence_rule_version)
  assert.equal(ALL_DIMENSIONS.length, 6)
  assert.deepEqual([...ALL_DIMENSIONS], [
    'repeat_practice',
    'unassisted_completion',
    'independent_correct',
    'template_variant',
    'unseen_variant',
    'delayed_verification',
  ])
})

test('evidence: compute_dimensions() reproduces every golden case', () => {
  let checked = 0
  for (const [index, entry] of golden.dimensions.entries()) {
    const facts = attemptFacts(entry.input)
    const got = computeDimensions(facts).map((row) => ({
      node_id: row.nodeId,
      dimension: row.dimension,
      qualifies: row.qualifies,
      is_correct: row.isCorrect,
      score_fraction: row.scoreFraction === null ? null : row.scoreFraction.toString(),
      exclusion_reasons: row.exclusionReasons,
      detail: row.detail,
    }))
    assert.deepEqual(got, entry.expected.rows, `dimension case #${index}`)
    checked += 1
  }
  assert.equal(checked, golden.dimensions.length)
  assert.ok(checked > 300, 'the fixture must actually cover the rule, not a token sample')
})

test('evidence: every dimension reaches both verdicts in the fixture', () => {
  const coverage = golden.coverage.dimensions
  for (const dimension of ALL_DIMENSIONS) {
    const bucket = coverage[dimension]
    assert.ok(bucket, `no coverage recorded for ${dimension}`)
    assert.ok(bucket.qualifies_true > 0, `${dimension} never qualifies in the fixture`)
    // `repeat_practice` is the raw-submission dimension: it always qualifies, by design.
    if (dimension === 'repeat_practice') {
      assert.equal(bucket.qualifies_false, 0, 'repeat_practice must never be excluded')
      continue
    }
    assert.ok(bucket.qualifies_false > 0, `${dimension} never refuses in the fixture`)
  }
})

test('evidence: is_grade_correct() and fraction() match', () => {
  for (const entry of golden.grade_correct) {
    assert.equal(isGradeCorrect(gradeFacts(entry.input)), entry.expected, JSON.stringify(entry.input))
  }
  for (const entry of golden.fraction) {
    // Two shapes: a full grade payload, or a bare `{confirmed_score, max_score}` pair.
    const facts: GradeFacts | null =
      entry.input === null
        ? null
        : 'status' in entry.input
          ? gradeFacts(entry.input)
          : {
              status: 'confirmed',
              isFullyConfirmed: true,
              confirmedScore: Decimal.parse(entry.input.confirmed_score),
              maxScore: Decimal.parse(entry.input.max_score),
              graderIsSelf: false,
              method: 'deterministic',
            }
    const got = fraction(facts)
    assert.equal(got === null ? null : got.toString(), entry.expected, JSON.stringify(entry.input))
  }
})

test('evidence: confirmation_ok() matches', () => {
  for (const entry of golden.confirmation_ok) {
    assert.equal(confirmationOk(entry.input), entry.expected, JSON.stringify(entry.input))
  }
})

test('state: summaryFromCounts() and missingEvidence() match', () => {
  for (const entry of golden.summary_from_counts) {
    const got = summaryFromCounts({
      independentCorrect: entry.input.independent_correct,
      distinctQuestions: entry.input.distinct_questions,
      distinctTemplates: entry.input.distinct_templates,
      hasDelayedCorrect: entry.input.has_delayed_correct,
      assistedOnly: entry.input.assisted_only,
      confirmedGap: entry.input.confirmed_gap,
      needsReview: entry.input.needs_review,
    })
    assert.equal(got, entry.expected, JSON.stringify(entry.input))
  }
  for (const entry of golden.missing_evidence) {
    const got = missingEvidence({
      independentCorrect: entry.input.independent_correct,
      distinctTemplates: entry.input.distinct_templates,
      hasDelayedCorrect: entry.input.has_delayed_correct,
    })
    assert.deepEqual(got, entry.expected, JSON.stringify(entry.input))
  }
})

function stateRows(specs: any[]): StateEvidenceRow[] {
  return specs.map((spec, index) => ({
    // The fixture stores no ids, so the harness derives them the same way the Python harness does.
    id: spec.id ?? `e${index}`,
    attemptId: spec.attempt_id ?? `a${index}`,
    dimension: spec.dimension,
    qualifies: spec.qualifies,
    isCorrect: spec.is_correct,
    gradeEventId: spec.grade_event_id ?? null,
    templateId: spec.template_id ?? null,
    questionId: spec.question_id ?? 'q1',
    computedAt: parseInstant(spec.computed_at),
    exclusionReasons: spec.exclusion_reasons ?? [],
  }))
}

test('state: projectNodeState() reproduces every golden case', () => {
  let checked = 0
  for (const [index, entry] of golden.state.entries()) {
    const projection = projectNodeState({
      rows: stateRows(entry.input.rows),
      previous: {
        summary: entry.input.prev_summary as Summary,
        bestSummary: entry.input.prev_best_summary as Summary,
      },
      now: 0n,
    })
    const { as_of: _ignored, ...rest } = projection
    assert.deepEqual(
      { ...rest, saved: true },
      entry.expected,
      `state case #${index}: ${JSON.stringify(entry.input.prev_summary)}/${JSON.stringify(entry.input.prev_best_summary)}`,
    )
    checked += 1
  }
  assert.equal(checked, golden.state.length)
})

test('state: the summary ladder and thresholds are not silently drifted', () => {
  assert.equal(golden.source.state_rule_version, 'p0-1')
  assert.deepEqual([...SUMMARY_ORDER], [
    SUMMARY.UNDIAGNOSED,
    SUMMARY.NEEDS_FOUNDATION,
    SUMMARY.COMPLETES_WITH_HINTS,
    SUMMARY.INDEPENDENT,
    SUMMARY.HANDLES_UNSEEN,
    SUMMARY.DELAYED_VERIFIED,
  ])
  assert.deepEqual(
    [REQUIRED_DISTINCT_QUESTIONS, REQUIRED_DISTINCT_TEMPLATES, REQUIRED_DELAYED_CORRECT, RECENT_WINDOW, RECENT_FAILURES_FOR_REVIEW],
    [3, 2, 1, 3, 2],
  )
  assert.equal(golden.coverage.needs_review_true > 0, true)
  assert.equal(golden.coverage.downgrade_reason_present > 0, true)
})

test('state: a bad previous best summary raises instead of defaulting', () => {
  assert.throws(
    () =>
      projectNodeState({
        rows: [],
        previous: { summary: SUMMARY.UNDIAGNOSED, bestSummary: SUMMARY.NEEDS_REVIEW },
        now: 0n,
      }),
    /unknown previous best summary/,
  )
})
