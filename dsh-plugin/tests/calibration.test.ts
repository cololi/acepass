/**
 * P2 C08 acceptance: effect calibration groups, honest samples and no causal claim.
 *
 * Every assertion here is about a refusal, not a number: a group below the threshold has no
 * statistics, an excluded attempt is named with its reason, a pair that differs in content or
 * timing gets no difference, and the payload refuses a causal/percentage field outright.
 *
 * The seeded store is the same `completeRow` style `regrade.test.ts` uses: real rows through the
 * real codec, so a column that changes meaning fails here instead of in production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { parseInstant, type Instant } from '../src/domain/instant.ts'
import { Decimal } from '../src/domain/decimal.ts'
import { openStore } from '../src/store/db.ts'
import { findOne, insertRow, updateRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import type { AttemptContext } from '../src/services/analytics.ts'
import {
  EXCLUSION_MESSAGES,
  assertNoCausalSummary,
  buildEffectCalibration,
  comparabilityBetween,
  difficultyBand,
  questionTypeLabel,
  timingState,
  type CalibrationGroup,
  type GroupDimensions,
} from '../src/services/calibration.ts'

const NOW = parseInstant('2026-06-01T00:00:00+00:00')
const HOUR_US = 3_600_000_000n
const MAX_SCORE = '2.00'

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
    row[column.name] = column.json ? {} : column.kind === 'datetime' ? NOW : column.kind === 'int' || column.kind === 'bool' ? 0 : ''
  }
  Object.assign(row, overrides)
  return row
}

/** The grade fields calibration reads; an empty object means "fully confirmed, full score". */
interface GradeInput {
  kind?: string
  status?: string
  method?: string
  confirmedScore?: string | null
  isFullyConfirmed?: boolean
  graderIsSelf?: boolean
  answerKeyVersionId?: string | null
  rubricVersionId?: string | null
}

interface QuestionIds {
  questionId: string
  versionId: string
  answerKeyId: string
}

/**
 * One project, one subject, one practice session and a helper to add real attempts.
 *
 * `grade: null` writes no grade event at all (the `no_grade` case); `grade: undefined` writes the
 * default fully-confirmed grade.
 */
function seeded(options: { timeRules?: Record<string, unknown>; withSpec?: boolean } = {}) {
  const handle = openStore({ path: ':memory:' })
  const db = handle.db
  let ordinal = 0

  const user = insertRow(
    db,
    'accounts_user',
    completeRow('accounts_user', { email: 'c08@example.com', date_joined: NOW }),
    { now: NOW },
  )
  const userId = String(user.id)
  const project = createProject(db, userId, { name: 'C08' }, NOW)
  const projectId = String(project.id)
  const subject = createSubject(db, userId, projectId, { name: '会计' }, NOW)
  const subjectId = String(subject.id)

  let specVersion = 0
  const addSpec = (timeRules: Record<string, unknown>): string => {
    // `exams_spec_version` is unique per (subject, version); a second spec is the next version.
    specVersion += 1
    return String(
      insertRow(
        db,
        'exams_spec_version',
        completeRow('exams_spec_version', {
          subject_id: subjectId,
          version: specVersion,
          name: `考试规范 v${specVersion}`,
          time_rules: timeRules,
          question_type_rules: {},
          status: 'published',
        }),
        { now: NOW },
      ).id,
    )
  }
  const defaultSpecId = (options.withSpec ?? true) ? addSpec(options.timeRules ?? { choice_seconds: 600 }) : null

  const session = insertRow(
    db,
    'practice_session',
    completeRow('practice_session', {
      user_id: userId,
      project_id: projectId,
      subject_id: subjectId,
      mode: 'practice',
      status: 'finished',
    }),
    { now: NOW },
  )
  const sessionId = String(session.id)

  const addQuestion = (
    question: { questionType?: string; estimatedSeconds?: number | null; disputedAnswer?: boolean } = {},
  ): QuestionIds => {
    const row = insertRow(
      db,
      'question_bank_question',
      completeRow('question_bank_question', {
        subject_id: subjectId,
        origin_type: 'import',
        is_demo: false,
        display_label: '',
      }),
      { now: NOW },
    )
    const version = insertRow(
      db,
      'question_bank_question_version',
      completeRow('question_bank_question_version', {
        question_id: row.id,
        version: 1,
        question_type: question.questionType ?? 'single_choice',
        estimated_seconds: question.estimatedSeconds ?? null,
      }),
      { now: NOW },
    )
    const answer = insertRow(
      db,
      'question_bank_answer_key_version',
      completeRow('question_bank_answer_key_version', {
        question_version_id: version.id,
        version: 1,
        verification_status: 'checked',
        answer_payload: {},
        check_basis: '教材',
        is_disputed: question.disputedAnswer ?? false,
      }),
      { now: NOW },
    )
    return { questionId: String(row.id), versionId: String(version.id), answerKeyId: String(answer.id) }
  }

  const addRubric = (answerKeyId: string, disputed = true): string =>
    String(
      insertRow(
        db,
        'question_bank_rubric_version',
        completeRow('question_bank_rubric_version', {
          answer_key_version_id: answerKeyId,
          version: 1,
          total_score: MAX_SCORE,
          is_disputed: disputed,
        }),
        { now: NOW },
      ).id,
    )

  const addExposure = (options: { questionId: string; versionId: string; serverTime?: Instant; kind?: string }): void => {
    insertRow(
      db,
      'practice_exposure_event',
      completeRow('practice_exposure_event', {
        user_id: userId,
        project_id: projectId,
        question_id: options.questionId,
        question_version_id: options.versionId,
        kind: options.kind ?? 'answer_delivered',
        purpose: 'practice',
        source: 'test',
        server_time: options.serverTime ?? NOW - 2n * HOUR_US,
        reveals_answer: true,
      }),
      { now: NOW },
    )
  }

  const addAttempt = (options: {
    versionId: string
    answerKeyId?: string | null
    rubricId?: string | null
    maxScore?: string
    elapsedMs?: number
    submittedAt?: Instant
    firstDeliveredAt?: Instant | null
    specVersionId?: string | null
    grade?: GradeInput | null
    assisted?: boolean
  }): { attemptId: string; itemId: string } => {
    ordinal += 1
    const maxScore = options.maxScore ?? MAX_SCORE
    const item = insertRow(
      db,
      'practice_session_item',
      completeRow('practice_session_item', {
        session_id: sessionId,
        question_version_id: options.versionId,
        answer_key_version_id: options.answerKeyId ?? null,
        rubric_version_id: options.rubricId ?? null,
        spec_version_id: options.specVersionId === undefined ? defaultSpecId : options.specVersionId,
        max_score: maxScore,
        ordinal,
        first_delivered_at: options.firstDeliveredAt === undefined ? NOW - HOUR_US : options.firstDeliveredAt,
        purpose: 'practice',
        mapping_revision: 1,
      }),
      { now: NOW },
    )
    const attempt = insertRow(
      db,
      'practice_attempt',
      completeRow('practice_attempt', {
        session_item_id: item.id,
        user_id: userId,
        project_id: projectId,
        raw_answer: {},
        steps: [],
        attachments: [],
        confidence: '',
        submitted_at: options.submittedAt ?? NOW,
        elapsed_ms: options.elapsedMs ?? 1_000,
        request_digest: '',
        idempotency_key: `c08-key-${ordinal}`,
        current_grade_event_id: null,
      }),
      { now: NOW },
    )
    if (options.grade !== null) {
      const grade = options.grade ?? {}
      const row = insertRow(
        db,
        'practice_grade_event',
        completeRow('practice_grade_event', {
          attempt_id: attempt.id,
          kind: grade.kind ?? 'manual_confirmation',
          status: grade.status ?? 'confirmed',
          method: grade.method ?? 'deterministic',
          grading_revision: 1,
          confirmed_score: grade.confirmedScore === undefined ? maxScore : grade.confirmedScore,
          max_score: maxScore,
          pending_max_score: '0.00',
          is_fully_confirmed: grade.isFullyConfirmed ?? true,
          parts: [],
          answer_key_version_id: grade.answerKeyVersionId === undefined ? (options.answerKeyId ?? null) : grade.answerKeyVersionId,
          rubric_version_id: grade.rubricVersionId ?? null,
          spec_version_id: null,
          rule_snapshot: {},
          grader_is_self: grade.graderIsSelf ?? false,
        }),
        { now: NOW },
      )
      updateRow(db, 'practice_attempt', attempt.id, { current_grade_event_id: row.id }, { now: NOW })
    }
    if (options.assisted === true) {
      // The evidence projection is what the service reads; it is seeded directly rather than
      // recomputed so the test exercises the service's query and not the projection's rules.
      insertRow(
        db,
        'practice_learning_evidence',
        completeRow('practice_learning_evidence', {
          attempt_id: attempt.id,
          session_item_id: item.id,
          user_id: userId,
          project_id: projectId,
          dimension: 'unassisted_completion',
          qualifies: false,
          exclusion_reasons: ['hint_delivered'],
          rule_version: 'p2-c04',
          computed_at: NOW,
          is_active: true,
          invalidated_reason: '',
          detail: {},
        }),
        { now: NOW },
      )
    }
    return { attemptId: String(attempt.id), itemId: String(item.id) }
  }

  return {
    db,
    close: handle.close,
    userId,
    projectId,
    subjectId,
    addSpec,
    addQuestion,
    addRubric,
    addExposure,
    addAttempt,
  }
}

/** The frozen relations `reports.scoped_attempts` hands a report, for one attempt id. */
function contextOf(db: DatabaseSync, attemptId: string): AttemptContext {
  const attempt = findOne(db, 'practice_attempt', { id: attemptId })
  assert.ok(attempt, `attempt ${attemptId}`)
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  assert.ok(item)
  const session = findOne(db, 'practice_session', { id: String(item.session_id) })
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
  const grade =
    attempt.current_grade_event_id === null || attempt.current_grade_event_id === undefined
      ? null
      : findOne(db, 'practice_grade_event', { id: String(attempt.current_grade_event_id) })
  assert.ok(session !== null && version !== null && question !== null)
  return { attempt, item, session, version, question, grade }
}

function groupsOf(payload: Record<string, unknown>): CalibrationGroup[] {
  return payload['groups'] as CalibrationGroup[]
}

function groupWith(payload: Record<string, unknown>, exposureState: string): CalibrationGroup {
  const group = groupsOf(payload).find((row) => row.dimensions.exposure_state === exposureState)
  assert.ok(group, `group with exposure ${exposureState}`)
  return group
}

// ------------------------------------------------------------------- statistics
test('calibration: five confirmed attempts report mean, median, spread and range', () => {
  const s = seeded()
  try {
    // Fractions 1, 0.75, 0.5, 0.25, 1 -> mean 0.7, median 0.75, population stdev sqrt(0.085).
    for (const score of ['2.00', '1.50', '1.00', '0.50', '2.00']) {
      const question = s.addQuestion()
      s.addAttempt({
        versionId: question.versionId,
        answerKeyId: question.answerKeyId,
        maxScore: MAX_SCORE,
        elapsedMs: 60_000,
        grade: { confirmedScore: score },
      })
    }
    const payload = buildEffectCalibration(s.db, s.userId, s.projectId, { now: NOW })

    assert.equal(payload['report_kind'], 'effect_calibration')
    assert.equal(payload['calculation_version'], 'p2-c08')
    assert.equal(payload['project_id'], s.projectId)
    assert.equal(payload['subject_id'], null)
    assert.equal(payload['minimum_group_sample'], 5)
    assert.equal(payload['group_count'], 1)
    assert.equal(payload['comparable_group_count'], 1)
    assert.equal(payload['comparable_pair_count'], 0)
    assert.deepEqual(payload['comparisons'], [])
    assert.deepEqual(payload['not_comparable'], [])

    const groups = groupsOf(payload)
    assert.equal(groups.length, 1)
    const group = groups[0]
    assert.equal(group.group_key, 'single_choice|score_le_2|within_limit|strictly_independent')
    assert.deepEqual(group.dimensions, {
      question_type: 'single_choice',
      question_type_label: '单选题',
      difficulty_band: 'score_le_2',
      difficulty_proxy: 'max_score_band',
      timing_state: 'within_limit',
      exposure_state: 'strictly_independent',
    })
    assert.equal(group.status, 'ok')
    assert.equal(group.sample_size, 5)
    assert.equal(group.confirmed_sample_size, 5)
    assert.deepEqual(group.statistics, {
      mean_confirmed_fraction: '0.7000',
      median_confirmed_fraction: '0.7500',
      spread_stdev: '0.2915',
      min_confirmed_fraction: '0.2500',
      max_confirmed_fraction: '1.0000',
      metric: 'confirmed_score / item_max_score',
    })
    assert.deepEqual(group.exclusions, { attempts_without_confirmed_score: 0, reasons: [] })
    assert.match(group.comparability, /^确认样本 5（≥5）：/)

    const grouping = payload['grouping'] as Record<string, unknown>
    assert.equal(grouping['attempts_in_scope'], 5)
    assert.equal(grouping['hidden_verification_attempts'], 0)
    assert.equal(grouping['hidden_verification_content_attempts'], 0)
    assert.deepEqual(payload['exclusions'], { attempts_in_scope: 5, reasons: [] })
    const caveats = payload['caveats'] as Record<string, unknown>
    assert.deepEqual(caveats['claims'], { causal_claim: false, improvement_claim: false })
    assert.equal((caveats['statements'] as string[]).length, 5)
  } finally {
    s.close()
  }
})

test('calibration: four confirmed plus one pending review withholds every number', () => {
  const s = seeded()
  try {
    for (let index = 0; index < 4; index += 1) {
      const question = s.addQuestion()
      s.addAttempt({ versionId: question.versionId, answerKeyId: question.answerKeyId, elapsedMs: 5_000 })
    }
    const pending = s.addQuestion()
    s.addAttempt({
      versionId: pending.versionId,
      answerKeyId: pending.answerKeyId,
      elapsedMs: 5_000,
      grade: { status: 'pending_review', confirmedScore: null, isFullyConfirmed: false },
    })

    const payload = buildEffectCalibration(s.db, s.userId, s.projectId, { now: NOW })
    const group = groupsOf(payload)[0]
    assert.equal(group.status, 'insufficient_sample')
    assert.equal(group.sample_size, 5)
    assert.equal(group.confirmed_sample_size, 4)
    assert.equal(group.statistics, null, 'a number next to a warning is still the number')
    assert.equal(group.exclusions.attempts_without_confirmed_score, 1)
    assert.deepEqual(
      group.exclusions.reasons.map((row) => [row.code, row.attempt_count]),
      [['pending_review', 1]],
    )
    assert.equal(group.exclusions.reasons[0].message, '判分待人工确认')
    assert.match(group.comparability, /^确认样本 4 < 5：不展示统计量/)

    assert.equal(payload['comparable_group_count'], 0)
    assert.equal(payload['comparable_pair_count'], 0)
    assert.deepEqual(payload['not_comparable'], [
      { group_key: group.group_key, code: 'insufficient_sample', message: group.comparability },
    ])
    assert.deepEqual(payload['exclusions'], {
      attempts_in_scope: 5,
      reasons: [{ code: 'pending_review', message: '判分待人工确认', attempt_count: 1 }],
    })
  } finally {
    s.close()
  }
})

test('calibration: every exclusion reason is counted on the group and in the scope', () => {
  const s = seeded()
  try {
    type AttemptPatch = Omit<Parameters<typeof s.addAttempt>[0], 'versionId' | 'answerKeyId'>
    const attempt = (overrides: AttemptPatch): void => {
      const question = s.addQuestion()
      s.addAttempt({ versionId: question.versionId, answerKeyId: question.answerKeyId, elapsedMs: 1_000, ...overrides })
    }

    attempt({ grade: null })
    attempt({ grade: { status: 'pending_review', confirmedScore: null, isFullyConfirmed: false } })
    attempt({ grade: { status: 'confirmed', isFullyConfirmed: false, confirmedScore: '1.00' } })
    attempt({ grade: { status: 'void', confirmedScore: '0.00' } })
    attempt({ grade: { kind: 'invalidation', confirmedScore: MAX_SCORE } })
    attempt({ grade: { method: 'ai_estimated', status: 'estimated', confirmedScore: '1.00' } })
    attempt({ grade: { method: 'self_confirmed', confirmedScore: MAX_SCORE } })

    const disputedAnswer = s.addQuestion({ disputedAnswer: true })
    s.addAttempt({
      versionId: disputedAnswer.versionId,
      answerKeyId: disputedAnswer.answerKeyId,
      elapsedMs: 1_000,
      grade: {},
    })
    const disputedRubric = s.addQuestion()
    const rubricId = s.addRubric(disputedRubric.answerKeyId)
    s.addAttempt({
      versionId: disputedRubric.versionId,
      answerKeyId: disputedRubric.answerKeyId,
      rubricId,
      elapsedMs: 1_000,
      grade: { rubricVersionId: rubricId },
    })
    const zeroScore = s.addQuestion()
    s.addAttempt({
      versionId: zeroScore.versionId,
      answerKeyId: zeroScore.answerKeyId,
      maxScore: '0.00',
      elapsedMs: 1_000,
      grade: { confirmedScore: '0.00' },
    })

    const payload = buildEffectCalibration(s.db, s.userId, s.projectId, { now: NOW })
    const groups = groupsOf(payload)
    assert.equal(groups.length, 1, 'all ten attempts share one group')
    const group = groups[0]
    assert.equal(group.sample_size, 10)
    assert.equal(group.confirmed_sample_size, 0)
    assert.equal(group.status, 'insufficient_sample')
    assert.equal(group.statistics, null)
    assert.equal(group.exclusions.attempts_without_confirmed_score, 10)

    const expected: [string, number][] = [
      ['no_grade', 1],
      ['pending_review', 1],
      ['partially_confirmed', 1],
      ['void_grade', 1],
      ['invalidated_grade', 1],
      ['ai_estimated_only', 1],
      ['self_assessed_grade', 1],
      ['disputed_content', 2],
      ['zero_max_score', 1],
    ]
    assert.deepEqual(
      group.exclusions.reasons.map((row) => [row.code, row.attempt_count]),
      expected,
    )
    for (const row of group.exclusions.reasons) {
      assert.equal(row.message, EXCLUSION_MESSAGES.get(row.code))
    }
    assert.deepEqual(
      (payload['exclusions'] as Record<string, unknown>)['reasons'],
      expected.map(([code, count]) => ({ code, message: EXCLUSION_MESSAGES.get(code as string), attempt_count: count })),
    )
  } finally {
    s.close()
  }
})

// ------------------------------------------------------------------- comparisons
test('calibration: two groups that differ only in exposure get a delta with n, spread and caveats', () => {
  const s = seeded()
  try {
    for (const score of ['2.00', '1.50', '1.00', '0.50', '2.00']) {
      const question = s.addQuestion()
      s.addAttempt({
        versionId: question.versionId,
        answerKeyId: question.answerKeyId,
        elapsedMs: 60_000,
        grade: { confirmedScore: score },
      })
    }
    for (const score of ['2.00', '2.00', '0.00', '0.00', '0.00']) {
      const question = s.addQuestion()
      s.addExposure({ questionId: question.questionId, versionId: question.versionId })
      s.addAttempt({
        versionId: question.versionId,
        answerKeyId: question.answerKeyId,
        elapsedMs: 60_000,
        grade: { confirmedScore: score },
      })
    }

    const payload = buildEffectCalibration(s.db, s.userId, s.projectId, { now: NOW })
    assert.equal(payload['group_count'], 2)
    assert.equal(payload['comparable_group_count'], 2)
    assert.equal(payload['comparable_pair_count'], 1)

    const independent = groupWith(payload, 'strictly_independent')
    const seen = groupWith(payload, 'seen_elsewhere')
    assert.equal(independent.dimensions.timing_state, 'within_limit')
    assert.equal(seen.dimensions.timing_state, 'within_limit')
    assert.equal(seen.dimensions.difficulty_band, independent.dimensions.difficulty_band)
    assert.equal(independent.statistics?.mean_confirmed_fraction, '0.7000')
    assert.equal(independent.statistics?.spread_stdev, '0.2915')
    assert.equal(seen.statistics?.mean_confirmed_fraction, '0.4000')
    assert.equal(seen.statistics?.spread_stdev, '0.4899')
    assert.equal(seen.statistics?.median_confirmed_fraction, '0.0000')
    assert.equal(seen.statistics?.min_confirmed_fraction, '0.0000')
    assert.equal(seen.statistics?.max_confirmed_fraction, '1.0000')

    const comparisons = payload['comparisons'] as Record<string, unknown>[]
    assert.equal(comparisons.length, 1)
    const row = comparisons[0]
    // Groups are compared in sorted group-key order: "seen_elsewhere" sorts before "strictly_…".
    assert.equal(row['group_a'], seen.group_key)
    assert.equal(row['group_b'], independent.group_key)
    assert.equal(row['comparable'], true)
    assert.equal(row['code'], 'comparable_with_caveats')
    assert.equal(row['message'], null)

    const delta = row['delta'] as Record<string, unknown>
    assert.equal(delta['metric'], 'mean_confirmed_fraction')
    assert.equal(delta['group_a_mean'], '0.4000')
    assert.equal(delta['group_b_mean'], '0.7000')
    assert.equal(delta['delta'], '0.3000')
    assert.deepEqual(delta['sample_size'], { group_a: 5, group_b: 5 })
    assert.deepEqual(delta['spread'], { group_a_stdev: '0.4899', group_b_stdev: '0.2915' })
    const caveats = delta['caveats'] as string[]
    assert.equal(caveats.length, 2)
    assert.ok(caveats.some((caveat) => caveat.includes('因果')))
    assert.deepEqual(payload['not_comparable'], [])
  } finally {
    s.close()
  }
})

test('calibration: a difficulty difference blocks the comparison and names the reason', () => {
  const s = seeded()
  try {
    for (let index = 0; index < 5; index += 1) {
      const question = s.addQuestion()
      s.addAttempt({ versionId: question.versionId, answerKeyId: question.answerKeyId, elapsedMs: 60_000 })
    }
    for (let index = 0; index < 5; index += 1) {
      const question = s.addQuestion()
      s.addAttempt({
        versionId: question.versionId,
        answerKeyId: question.answerKeyId,
        maxScore: '6.00',
        elapsedMs: 60_000,
      })
    }

    // The verdict itself, on the same two group shapes the payload would carry. The message is
    // what the UI shows: a difference in content weight is not a difference in learning.
    const verdict = comparabilityBetween(groupRow('a'), groupRow('b', { difficulty_band: 'score_gt_5' }))
    assert.equal(verdict.comparable, false)
    assert.equal(verdict.code, 'different_content_difficulty')
    assert.equal(verdict.delta, null)
    assert.match(
      verdict.message as string,
      /难度档不同（score_le_2 vs score_gt_5）：题目内容权重不同，得分率差异不能归因于学习效果/,
    )

    // Two `ok` groups that cannot be compared make the payload's own delta guard fire: Python
    // raises here too (`assert_no_causal_summary` rejects a `delta: None` row without companions,
    // calibration.py:151-162 called from calibration.py:636). This test pins that parity rather
    // than pretending the service returns a payload Python never returns.
    assert.throws(
      () => buildEffectCalibration(s.db, s.userId, s.projectId, { now: NOW }),
      {
        name: 'AssertionError',
        message:
          /^\$\.comparisons\[0\]\.delta: a delta must carry its sample size, spread and caveats \(missing \['caveats', 'samplesize', 'spread'\]\)/,
      },
    )
  } finally {
    s.close()
  }
})

function groupRow(
  key: string,
  changes: Partial<GroupDimensions> = {},
  status = 'ok',
): CalibrationGroup {
  return {
    group_key: key,
    dimensions: {
      question_type: 'single_choice',
      question_type_label: '单选题',
      difficulty_band: 'score_le_2',
      difficulty_proxy: 'max_score_band',
      timing_state: 'within_limit',
      exposure_state: 'repeated',
      ...changes,
    },
    sample_size: 5,
    confirmed_sample_size: status === 'ok' ? 5 : 2,
    status,
    statistics: null,
    exclusions: { attempts_without_confirmed_score: 0, reasons: [] },
    comparability: '',
  }
}

test('calibration: the comparability verdict names the one dimension that blocks it', () => {
  assert.equal(comparabilityBetween(groupRow('a'), groupRow('b')).code, 'comparable_with_caveats')
  assert.equal(
    comparabilityBetween(groupRow('a'), groupRow('b', { question_type: 'fill_blank' })).code,
    'different_question_type',
  )
  assert.equal(
    comparabilityBetween(groupRow('a'), groupRow('b', { timing_state: 'over_limit' })).code,
    'different_time_condition',
  )
  assert.equal(
    comparabilityBetween(groupRow('a'), groupRow('b', { exposure_state: 'assisted' })).code,
    'different_exposure_state',
  )
  // One strictly independent group is enough: that is the comparison the report exists to show.
  assert.equal(
    comparabilityBetween(groupRow('a'), groupRow('b', { exposure_state: 'strictly_independent' })).comparable,
    true,
  )
  const small = comparabilityBetween(groupRow('a'), groupRow('small', {}, 'insufficient_sample'))
  assert.equal(small.code, 'insufficient_sample')
  assert.match(small.message as string, /样本不足（各组确认样本 5 \/ 2，门槛 5）/)
})

// ------------------------------------------------------------------- guard
test('calibration: the causal-summary guard rejects percentages and bare deltas', () => {
  const rejects = (payload: unknown, message: RegExp): void => {
    // The guard is Python's `AssertionError`, message for message; matching on `message` keeps the
    // `AssertionError` name from obscuring the path prefix.
    assert.throws(() => assertNoCausalSummary(payload), { name: 'AssertionError', message })
  }
  rejects({ improvement_percent: 1 }, /^\$: percentage-style summary field 'improvement_percent' is not allowed$/)
  rejects({ pass_rate: 0.5 }, /^\$: forbidden causal\/summary field 'pass_rate'$/)
  rejects({ 提升率: 1 }, /^\$: forbidden causal\/summary field '提升率'$/)
  rejects({ 通过率: 0.5 }, /^\$: forbidden causal\/summary field '通过率'$/)
  rejects({ 因果效应: 1 }, /^\$: forbidden causal\/summary field '因果效应'$/)
  rejects(
    { delta: 0.1 },
    /^\$\.delta: a delta must carry its sample size, spread and caveats \(missing \['caveats', 'samplesize', 'spread'\]\)$/,
  )
  rejects({ groups: [{ delta: 0.1 }] }, /^\$\.groups\[0\]\.delta: a delta must carry/)
  // The rule is about keys, not values: a caveat sentence that mentions the forbidden idea is fine.
  assert.doesNotThrow(() => assertNoCausalSummary({ note: '不推断因果、不声称学习提升' }))

  // A delta with its n, spread and caveats is allowed, whether they sit beside it or inside it.
  assert.doesNotThrow(() =>
    assertNoCausalSummary({ delta: '0.10', sample_size: {}, spread: {}, caveats: ['仅组内观察'] }),
  )
  assert.doesNotThrow(() =>
    assertNoCausalSummary({
      delta: { metric: 'mean_confirmed_fraction', delta: '0.1', sample_size: {}, spread: {}, caveats: [] },
    }),
  )
})

test('calibration: question type labels and difficulty bands follow the declared proxy', () => {
  assert.equal(questionTypeLabel('single_choice'), '单选题')
  assert.equal(questionTypeLabel('multiple_choice'), '多选题')
  assert.equal(questionTypeLabel('true_false'), '判断题')
  assert.equal(questionTypeLabel('fill_blank'), '填空题')
  assert.equal(questionTypeLabel('constructed_response'), '大题')
  assert.equal(questionTypeLabel('material'), '共享材料')
  assert.equal(questionTypeLabel('matching'), 'matching', 'an unlabelled type falls back to its value')

  assert.equal(difficultyBand(Decimal.parse('2.00')), 'score_le_2')
  assert.equal(difficultyBand(Decimal.parse('0')), 'score_le_2')
  assert.equal(difficultyBand(Decimal.parse('2.01')), 'score_2_to_5')
  assert.equal(difficultyBand(Decimal.parse('5.00')), 'score_2_to_5')
  assert.equal(difficultyBand(Decimal.parse('5.01')), 'score_gt_5')
})

// ------------------------------------------------------------------- timing
test('calibration: timing state reads the frozen spec, then the estimate, then the shared rule', () => {
  const s = seeded({ timeRules: { choice_seconds: 600 } })
  try {
    // An exact rule that contradicts the shared rule proves the exact key is read first.
    const exactSpec = s.addSpec({ single_choice_seconds: 300, choice_seconds: 600 })
    type AttemptPatch = Omit<Parameters<typeof s.addAttempt>[0], 'versionId' | 'answerKeyId'>
    const add = (options: AttemptPatch, question: { estimatedSeconds?: number | null } = {}) => {
      const ids = s.addQuestion(question)
      return s.addAttempt({ ...options, versionId: ids.versionId, answerKeyId: ids.answerKeyId })
    }

    const idle = add({ elapsedMs: 0 })
    const noLimit = add({ elapsedMs: 1_000, specVersionId: null })
    const atLimit = add({ elapsedMs: 600_000 })
    const overLimit = add({ elapsedMs: 600_001 })
    const exactAtLimit = add({ elapsedMs: 300_000, specVersionId: exactSpec })
    const exactOverLimit = add({ elapsedMs: 300_001, specVersionId: exactSpec })
    // The second rung: a version-level estimate fills in when the spec declares no rule.
    const estimatedAttempt = add({ elapsedMs: 300_000, specVersionId: null }, { estimatedSeconds: 300 })
    // A stored `0` is falsy in Python, so it must fall through rather than mean "no time allowed".
    const zeroEstimate = add({ elapsedMs: 1_000, specVersionId: null }, { estimatedSeconds: 0 })

    const state = (attemptId: string): string => timingState(s.db, contextOf(s.db, attemptId))
    assert.equal(state(idle.attemptId), 'no_server_timing')
    assert.equal(state(noLimit.attemptId), 'no_configured_limit')
    assert.equal(state(atLimit.attemptId), 'within_limit', 'exactly at the limit is within it')
    assert.equal(state(overLimit.attemptId), 'over_limit')
    assert.equal(state(exactAtLimit.attemptId), 'within_limit')
    assert.equal(state(exactOverLimit.attemptId), 'over_limit', 'the exact key wins over the shared one')
    assert.equal(state(estimatedAttempt.attemptId), 'within_limit', 'estimated_seconds is the second rung')
    assert.equal(state(zeroEstimate.attemptId), 'no_configured_limit', 'a stored 0 is not a limit')

    // The same labels reach the payload through the group dimensions.
    const payload = buildEffectCalibration(s.db, s.userId, s.projectId, { now: NOW })
    const states = new Set(groupsOf(payload).map((group) => group.dimensions.timing_state))
    assert.deepEqual([...states].sort(), [
      'no_configured_limit',
      'no_server_timing',
      'over_limit',
      'within_limit',
    ])
  } finally {
    s.close()
  }
})

// ------------------------------------------------------------------- exposure labels
test('calibration: assistance is only claimed when the evidence row also has server timing', () => {
  const s = seeded()
  try {
    const assisted = s.addQuestion()
    const assistedAttempt = s.addAttempt({
      versionId: assisted.versionId,
      answerKeyId: assisted.answerKeyId,
      elapsedMs: 5_000,
      assisted: true,
    })
    // The same evidence flag on an attempt with no usable timing record is a timing disclosure,
    // not an assistance claim: `elapsed_ms > 0` is the filter the service applies.
    const untimed = s.addQuestion()
    s.addAttempt({
      versionId: untimed.versionId,
      answerKeyId: untimed.answerKeyId,
      elapsedMs: 0,
      assisted: true,
    })

    const labels = new Map(
      groupsOf(buildEffectCalibration(s.db, s.userId, s.projectId, { now: NOW })).map((group) => [
        group.dimensions.exposure_state,
        group,
      ]),
    )
    assert.ok(labels.has('assisted'))
    assert.ok(labels.has('strictly_independent'))
    assert.equal(labels.get('assisted')?.dimensions.timing_state, 'within_limit')
    assert.equal(labels.get('strictly_independent')?.dimensions.timing_state, 'no_server_timing')
    assert.equal(
      (labels.get('assisted') as CalibrationGroup).confirmed_sample_size,
      1,
      'the assisted attempt itself is still a confirmed score',
    )
    // The evidence row exists for the assisted attempt only.
    const evidence = findOne(s.db, 'practice_learning_evidence', { attempt_id: assistedAttempt.attemptId })
    assert.ok(evidence)
    assert.equal(evidence.qualifies, false)
  } finally {
    s.close()
  }
})
