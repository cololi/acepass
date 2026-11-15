/**
 * Effect calibration: comparable groups, honest samples, no causal claim.
 *
 * Port of `backend/apps/analytics/services/calibration.py` (docs/05 §3 C08): 学习效果对比按题型、
 * 难度、时限、暴露情况说明可比性和样本数；不从单人前后分数推断因果.
 *
 * The product temptation this module exists to refuse is a single headline number:
 * "你的得分率提升了 X%". A within-person before/after difference of two *different* sets of
 * questions, taken under different exposure conditions, with different time pressure and a handful
 * of attempts each, cannot support that sentence — no matter how the arithmetic is dressed up. So:
 *
 *  - attempts are grouped by the dimensions that actually make two sets of attempts comparable:
 *    question type, a declared difficulty proxy, the server-measured time condition, and the
 *    exposure state (reusing `domain/contamination.ts` instead of re-deriving it);
 *  - a group reports its confirmed-score statistics **only** from confirmed grades, and only when
 *    it has at least {@link MIN_GROUP_SAMPLE} of them. Below that the group is `insufficient_sample`
 *    and the numbers are withheld, not shown with a warning — a warning next to a number is still
 *    the number;
 *  - a difference is emitted only between two groups that hold type, difficulty and time condition
 *    equal, and it carries its per-group n, its spread and its own caveats. Groups that cannot be
 *    compared are listed with the reason;
 *  - {@link assertNoCausalSummary} is called on every payload before it is returned. It walks the
 *    whole structure and throws if a single causal or percentage-style summary key ever appears
 *    (`improvement_percent`, `pass_probability`, a bare top-level `delta`, …), so the "no causal
 *    claim" rule is enforced by code, not by the docstring you are reading.
 *
 * The Python original is read-only, and so is this port: it computes no projection row, writes no
 * snapshot and changes no state. Every string is kept verbatim from the oracle (including the
 * provenance note that names the Django module) because the payload is stored and compared.
 */
import type { DatabaseSync } from 'node:sqlite'
import { pyRepr, pyTruthy } from '../ai/pyvalue.ts'
import {
  attemptReferenceInstant,
  exposureState,
  type ExposureFacts,
  type ExposureState,
} from '../domain/contamination.ts'
import { Decimal, pyMax, pyMin } from '../domain/decimal.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { findOne, findRows } from '../store/repository.ts'
import {
  disputedAnswerKeyIds,
  disputedRubricIds,
  scopedAttempts,
  type AttemptContext,
} from './analytics.ts'
import { loadExposureFacts } from './evidence_rebuild.ts'
import { requireProject, requireSubject } from './exams.ts'

/** A group needs this many *confirmed* scores before any statistic is shown. */
export const MIN_GROUP_SAMPLE = 5

/** The difficulty proxy actually used. Named in the payload (`difficulty_proxy`) so a reader never
 * has to guess what "difficulty" meant. */
export const DIFFICULTY_PROXY = 'max_score_band'

/** Which question type answers which declared time rule. The demo and bootstrap fixtures declare
 * `choice_seconds` for all three objective types and a separate rule for fill-in and constructed
 * response, so the fallback reads the declared policy instead of inventing a limit. */
export const TIME_RULE_BY_TYPE: Readonly<Record<string, string>> = {
  single_choice: 'choice_seconds',
  multiple_choice: 'choice_seconds',
  true_false: 'choice_seconds',
  fill_blank: 'fill_blank_seconds',
  constructed_response: 'constructed_response_seconds',
}

/** `QuestionType` value -> label, exactly as `apps/common/enums.py` declares it. */
export const QUESTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
  constructed_response: '大题',
  material: '共享材料',
}

export const DIFFICULTY_PROXY_NOTE =
  '难度代理 = 该题项冻结的满分档（≤2 分 / 2—5 分 / >5 分）。' +
  '这是卷面分值权重，不是任何模型推断出的难度；它只能粗略代表题目长度与权重，' +
  '不能代表认知难度，也不能保证档内题目真的同质。'

export const TIMING_NOTE =
  '时限条件 = 服务端记录的 elapsed_ms 是否落在该题声明的时限内' +
  '（题项规范 time_rules，缺省回退到发表时的 estimated_seconds）。' +
  'elapsed_ms 由服务端在首次下发与提交之间测量，客户端时间不参与。'

export const EXPOSURE_NOTE =
  '暴露情况来自 apps.learning.services.contamination 的同一套规则' +
  '（系统外已见、校对预览、答案/讲解/提示下发、展示未提交、跨项目同源、合并家族），' +
  '辅助状态取自证据投影 unassisted_completion 不合格且有用时记录的行；' +
  '重复 = 本人在同一项目中已答过同一题。四类互斥，按 辅助 > 重复 > 已见 > 严格独立 归类。'

export const STATUS_OK = 'ok'
export const STATUS_INSUFFICIENT = 'insufficient_sample'

/** Exact key names (lowercased, symbols removed) that must never appear anywhere in a calibration
 * payload: each one is a way of smuggling a causal or probability claim into a within-person
 * observation. */
export const FORBIDDEN_SUMMARY_KEYS: ReadonlySet<string> = new Set([
  'improvement',
  'improvementrate',
  'improvementscore',
  'scoregain',
  'gain',
  'learninggain',
  'effect',
  'causaleffect',
  'causalestimate',
  'causalinference',
  'passprobability',
  'passrate',
  'passchance',
  'probabilityofpass',
  'overalldelta',
  'totaldelta',
  'beforedafter',
  'beforeafterscore',
  'predictedscore',
  '提升',
  '提升率',
  '通过概率',
  '通过率',
  '因果效应',
])

/** A `delta` may only live inside a row that also states its sample size, its spread and its own
 * caveats. These are the keys that row must carry. */
export const DELTA_REQUIRED_COMPANIONS: ReadonlySet<string> = new Set(['samplesize', 'spread', 'caveats'])

const CAUSAL_SUBSTRINGS: readonly string[] = ['提升', '因果', '通过率', '通过概率']

/**
 * Python's `AssertionError` for this guard.
 *
 * The name is set to `AssertionError` so a stack trace reads like the Django failure it replaces;
 * the message text is the oracle's, character for character.
 */
export class CausalSummaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

/** `re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(key).lower())` — the key comparison form. */
function normalised(key: unknown): string {
  return String(key).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/gu, '')
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Throw if the payload grew a causal/summary field.
 *
 * The rule is enforced on the *shape* of every payload this module returns, so a later edit that
 * adds `improvement_percent` (or a bare top-level `delta` without n/spread/caveats) fails loudly at
 * request time instead of shipping a claim the data cannot support.
 */
export function assertNoCausalSummary(value: unknown, path = '$'): void {
  if (isRow(value)) {
    const keys = new Set(Object.keys(value).map((key) => normalised(key)))
    for (const rawKey of Object.keys(value)) {
      const norm = normalised(rawKey)
      if (FORBIDDEN_SUMMARY_KEYS.has(norm)) {
        throw new CausalSummaryError(`${path}: forbidden causal/summary field ${pyRepr(rawKey)}`)
      }
      if (norm.endsWith('percent') || norm.endsWith('percentage')) {
        throw new CausalSummaryError(`${path}: percentage-style summary field ${pyRepr(rawKey)} is not allowed`)
      }
      if (CAUSAL_SUBSTRINGS.some((token) => norm.includes(token))) {
        throw new CausalSummaryError(`${path}: causal-claiming field ${pyRepr(rawKey)} is not allowed`)
      }
    }
    if (keys.has('delta')) {
      const rawDeltaKey = Object.keys(value).find((raw) => normalised(raw) === 'delta') as string
      const deltaBody = value[rawDeltaKey]
      // The companions may sit beside the delta or inside the delta object itself; a bare
      // difference is never allowed through.
      const target = isRow(deltaBody) ? deltaBody : value
      const targetKeys = new Set(Object.keys(target).map((key) => normalised(key)))
      if (![...DELTA_REQUIRED_COMPANIONS].every((companion) => targetKeys.has(companion))) {
        const missing = [...DELTA_REQUIRED_COMPANIONS].filter((companion) => !targetKeys.has(companion)).sort()
        throw new CausalSummaryError(
          `${path}.${rawDeltaKey}: a delta must carry its sample size, spread and caveats` +
            ` (missing [${missing.map((entry) => pyRepr(entry)).join(', ')}])`,
        )
      }
    }
    for (const [rawKey, child] of Object.entries(value)) assertNoCausalSummary(child, `${path}.${rawKey}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoCausalSummary(child, `${path}[${index}]`))
  }
}

/** `QuestionType(value).label`, falling back to the raw value for a type added without a label. */
export function questionTypeLabel(questionType: string): string {
  return QUESTION_TYPE_LABELS[questionType] ?? questionType
}

/** The declared proxy, in bands. Documented in {@link DIFFICULTY_PROXY_NOTE}. */
export function difficultyBand(maxScore: Decimal): string {
  if (maxScore.le(Decimal.fromInt(2))) return 'score_le_2'
  if (maxScore.le(Decimal.fromInt(5))) return 'score_2_to_5'
  return 'score_gt_5'
}

/** Python `int(value)` for the JSON-shaped values a time rule can hold. */
function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^[+-]?\d+$/.test(text)) throw new RangeError(`invalid literal for int() with base 10: ${pyRepr(value)}`)
    return Number(text)
  }
  throw new TypeError(`int() argument must be a string or a number, not ${typeof value}`)
}

function decimalOf(value: unknown): Decimal {
  if (value instanceof Decimal) return value
  if (value === null || value === undefined) return Decimal.zero()
  return Decimal.parse(String(value))
}

/**
 * The declared per-item time limit, or `null` when the spec declares none.
 *
 * Read from the frozen `ExamSpecVersion` the item was presented under (never from the current
 * spec), then from the question version's own `estimated_seconds`, then from the shared
 * `choice_seconds` rule for the three objective types. Python truthiness decides each rung: a
 * stored `0`, `null` or `""` falls through instead of becoming a zero-second limit.
 */
export function configuredLimitSeconds(db: DatabaseSync, context: AttemptContext): number | null {
  const item = context.item
  const spec =
    item.spec_version_id === null || item.spec_version_id === undefined
      ? null
      : findOne(db, 'exams_spec_version', { id: String(item.spec_version_id) })
  const timeRules = spec === null ? null : spec.time_rules
  const rules: Record<string, unknown> = isRow(timeRules) && pyTruthy(timeRules) ? timeRules : {}
  const questionType = String(context.version.question_type)
  const exact = rules[`${questionType}_seconds`]
  if (pyTruthy(exact)) return pyInt(exact)
  const estimated = context.version.estimated_seconds
  if (pyTruthy(estimated)) return pyInt(estimated)
  const shared = rules[TIME_RULE_BY_TYPE[questionType] ?? '']
  return pyTruthy(shared) ? pyInt(shared) : null
}

/** `within_limit` / `over_limit` / `no_server_timing` / `no_configured_limit`. */
export function timingState(db: DatabaseSync, context: AttemptContext): string {
  const elapsedMs = Math.trunc(Number(context.attempt.elapsed_ms ?? 0))
  if (elapsedMs <= 0) return 'no_server_timing'
  const limit = configuredLimitSeconds(db, context)
  if (limit === null) return 'no_configured_limit'
  return elapsedMs <= limit * 1000 ? 'within_limit' : 'over_limit'
}

/**
 * Attempts the evidence projection marked as not unassisted.
 *
 * The projection folds "pre-submit answer-revealing exposure / hint" and "no trustworthy timing
 * record" into the same `qualifies=false` row. An attempt with `elapsed_ms > 0` cannot have failed
 * on timing, so restricting the set to those attempts keeps this flag about assistance only;
 * attempts without a usable timing record are disclosed by `timing_state` instead.
 */
function assistedAttemptIds(db: DatabaseSync, userId: string, projectId: string): Set<string> {
  const ids = new Set<string>()
  for (const row of findRows(db, 'practice_learning_evidence', {
    user_id: userId,
    project_id: projectId,
    dimension: 'unassisted_completion',
    qualifies: false,
  })) {
    ids.add(String(row.attempt_id))
  }
  if (ids.size === 0) return new Set()
  const out = new Set<string>()
  for (const id of ids) {
    const attempt = findOne(db, 'practice_attempt', { id })
    if (attempt !== null && Number(attempt.elapsed_ms) > 0) out.add(id)
  }
  return out
}

/** One attempt's exposure label as the payload's `dimensions.exposure_state` reads it. */
export interface ExposureLabel {
  exposure_state: string
  message: string
  reason_codes: string[]
  first_seen_at: string | null
}

function isoOf(value: unknown): string {
  return formatPythonIso(value as Instant)
}

/**
 * Exposure label per attempt, reusing the contamination evaluation.
 *
 * `contamination.exposure_state` is called with exactly the window the evidence projection uses (as
 * of the item's first presentation, excluding the item's own deliveries), so "strictly independent"
 * here means the same thing it means everywhere else. Results are cached per
 * (question, item, reference instant) — the same key the Python original uses.
 */
function exposureLabels(
  facts: ExposureFacts,
  attempts: readonly AttemptContext[],
  projectId: string,
  assistedIds: ReadonlySet<string>,
): Map<string, ExposureLabel> {
  // Python re-sorts ascending here because `scoped_attempts` hands back `-submitted_at`. Both sorts
  // are stable, so equal instants keep the caller's (rowid) order and `seen_questions` agrees.
  const ordered = [...attempts].sort((left, right) => {
    const a = left.attempt.submitted_at as Instant
    const b = right.attempt.submitted_at as Instant
    if (a === b) return 0
    return a < b ? -1 : 1
  })
  const seenQuestions = new Set<string>()
  const states = new Map<string, ExposureLabel>()
  const cache = new Map<string, ExposureState>()
  for (const context of ordered) {
    const item = context.item
    const questionId = String(context.version.question_id)
    const reference = attemptReferenceInstant(
      {
        first_delivered_at:
          item.first_delivered_at === null || item.first_delivered_at === undefined
            ? null
            : isoOf(item.first_delivered_at),
      },
      isoOf(context.attempt.submitted_at),
    )
    // A cache key, not a wire format: ids are UUIDs and `reference` is an ISO instant, so `|`
    // cannot appear inside a component.
    const cacheKey = `${questionId}|${String(item.id)}|${reference}`
    let state = cache.get(cacheKey)
    if (state === undefined) {
      state = exposureState(facts, {
        question_ids: [questionId],
        project_id: projectId,
        before: reference,
        exclude_session_item_ids: [String(item.id)],
      }).get(questionId) as ExposureState
      cache.set(cacheKey, state)
    }
    const repeated = seenQuestions.has(questionId)
    seenQuestions.add(questionId)
    let label: string
    let detail: string
    if (assistedIds.has(String(context.attempt.id))) {
      label = 'assisted'
      detail = '本次作答在提交前获得过提示/答案暴露，不是无辅助完成'
    } else if (repeated) {
      label = 'repeated'
      detail = '同一题目在本人同一项目中已作答过：本次不是首次接触'
    } else if (!state.strict_independent_eligible) {
      label = 'seen_elsewhere'
      detail = '本题此前已暴露（系统外已见/校对/下发过答案或讲解/展示未提交/同源/合并家族）'
    } else {
      label = 'strictly_independent'
      detail = '本题在本次呈现前没有被任何入口暴露给本人'
    }
    states.set(String(context.attempt.id), {
      exposure_state: label,
      message: detail,
      reason_codes: [...state.reasons],
      first_seen_at: state.first_seen_at,
    })
  }
  return states
}

/** Exclusion reasons for the confirmed-score statistic, in presentation order. */
export const EXCLUSION_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['no_grade', '没有判分记录'],
  ['pending_review', '判分待人工确认'],
  ['partially_confirmed', '部分评分点未确认'],
  ['void_grade', '判分已作废'],
  ['invalidated_grade', '原判分已失效，等待重评'],
  ['ai_estimated_only', '仅有 AI 估计分'],
  ['self_assessed_grade', '自评确认：不作为效果校准的确认分'],
  ['disputed_content', '答案或评分标准有争议'],
  ['zero_max_score', '满分不为正，无法计算得分率'],
])

function exclusionMessage(code: string): string {
  return EXCLUSION_MESSAGES.get(code) as string
}

/**
 * `(fraction, exclusion_codes)` — a fraction only from a confirmed grade.
 *
 * Every code states a fact; they are additive, so an attempt can carry several. A fraction is
 * returned only when the grade is confirmed, fully confirmed, on a positively scored item, and
 * neither self-assessed nor disputed — otherwise the caller counts the attempt as excluded.
 */
export function confirmedFraction(
  context: AttemptContext,
  disputedAnswers: ReadonlySet<string>,
  disputedRubrics: ReadonlySet<string>,
): [Decimal, string[]] {
  const grade = context.grade
  const item = context.item
  const codes: string[] = []
  if (grade === null) return [Decimal.zero(), ['no_grade']]
  if (grade.kind === 'invalidation') codes.push('invalidated_grade')
  else if (grade.status === 'pending_review') codes.push('pending_review')
  if (grade.status === 'void') codes.push('void_grade')
  if (grade.method === 'ai_estimated' || grade.status === 'estimated') codes.push('ai_estimated_only')
  if (grade.status === 'confirmed' && grade.is_fully_confirmed !== true) {
    codes.push('partially_confirmed')
  } else if (
    grade.status === 'pending_review' &&
    grade.confirmed_score !== null &&
    grade.confirmed_score !== undefined
  ) {
    // A half-decided rubric keeps a real confirmed subtotal while the attempt is still pending
    // overall: both facts are named.
    codes.push('partially_confirmed')
  }
  if (grade.method === 'self_confirmed' || grade.grader_is_self === true) codes.push('self_assessed_grade')
  const answerIds = new Set<string>([
    String(item.answer_key_version_id ?? ''),
    String(grade.answer_key_version_id ?? ''),
  ])
  const rubricIds = new Set<string>([
    String(item.rubric_version_id ?? ''),
    String(grade.rubric_version_id ?? ''),
  ])
  let disputed = false
  for (const id of answerIds) if (disputedAnswers.has(id)) disputed = true
  for (const id of rubricIds) if (disputedRubrics.has(id)) disputed = true
  if (disputed) codes.push('disputed_content')
  const maxScore = decimalOf(item.max_score)
  if (maxScore.le(Decimal.zero())) codes.push('zero_max_score')
  const usable =
    grade.status === 'confirmed' &&
    grade.confirmed_score !== null &&
    grade.confirmed_score !== undefined &&
    grade.is_fully_confirmed === true &&
    maxScore.gt(Decimal.zero()) &&
    !codes.includes('self_assessed_grade') &&
    !codes.includes('disputed_content')
  if (!usable) return [Decimal.zero(), codes]
  return [decimalOf(grade.confirmed_score).div(maxScore), codes]
}

/** Population standard deviation and range of a group's confirmed fractions. */
export function spread(values: readonly Decimal[]): { mean: string; stdev: string; min: string; max: string } {
  const count = values.length
  let total = Decimal.zero()
  for (const value of values) total = total.add(value)
  const mean = total.div(Decimal.fromInt(count))
  let squared = Decimal.zero()
  for (const value of values) {
    const deviation = value.sub(mean)
    squared = squared.add(deviation.mul(deviation))
  }
  const variance = squared.div(Decimal.fromInt(count))
  // Decimal has no sqrt; the spread is reported through float, which is more precision than any
  // sample this size can justify.
  const stdev = Decimal.parse(String(Math.sqrt(Number(variance))))
  let minimum = values[0]
  let maximum = values[0]
  for (const value of values) {
    minimum = pyMin(minimum, value)
    maximum = pyMax(maximum, value)
  }
  return {
    mean: mean.quantize(-4).toString(),
    stdev: stdev.quantize(-4).toString(),
    min: minimum.quantize(-4).toString(),
    max: maximum.quantize(-4).toString(),
  }
}

export function median(values: readonly Decimal[]): string {
  const ordered = [...values].sort((left, right) => left.cmp(right))
  const middle = Math.floor(ordered.length / 2)
  const value =
    ordered.length % 2 === 1
      ? ordered[middle]
      : ordered[middle - 1].add(ordered[middle]).div(Decimal.fromInt(2))
  return value.quantize(-4).toString()
}

/** The four dimensions a group is keyed by, plus the two labels that explain them. */
export interface GroupDimensions {
  question_type: string
  question_type_label: string
  difficulty_band: string
  difficulty_proxy: string
  timing_state: string
  exposure_state: string
}

export interface GroupStatistics {
  mean_confirmed_fraction: string
  median_confirmed_fraction: string
  spread_stdev: string
  min_confirmed_fraction: string
  max_confirmed_fraction: string
  metric: string
}

export interface GroupExclusionReason {
  code: string
  message: string
  attempt_count: number
}

/** The fields a group row needs to be compared: status, n, dimensions and (for a delta) stats. */
export interface ComparableGroup {
  group_key: string
  dimensions: GroupDimensions
  confirmed_sample_size: number
  status: string
  statistics: GroupStatistics | null
}

/** One row of `payload.groups`. */
export interface CalibrationGroup extends ComparableGroup {
  sample_size: number
  exclusions: {
    attempts_without_confirmed_score: number
    reasons: GroupExclusionReason[]
  }
  comparability: string
}

export interface DeltaRow {
  metric: string
  group_a_mean: string
  group_b_mean: string
  delta: string
  sample_size: { group_a: number; group_b: number }
  spread: { group_a_stdev: string; group_b_stdev: string }
  caveats: string[]
}

export interface ComparabilityVerdict {
  group_a: string
  group_b: string
  comparable: boolean
  code: string
  message: string | null
  delta: DeltaRow | null
}

function statisticsOf(group: ComparableGroup): GroupStatistics {
  // An `ok` group always carries statistics; Python would fail with a TypeError on `None[...]`.
  if (group.statistics === null) throw new Error(`${group.group_key}: an ok group must carry statistics`)
  return group.statistics
}

/**
 * Can these two groups be compared at all, and if not, why not.
 *
 * Only the exposure axis may differ: two groups that also differ in question type, difficulty band
 * or time condition are not a comparison, they are two different measurements.
 */
export function comparabilityBetween(left: ComparableGroup, right: ComparableGroup): ComparabilityVerdict {
  const leftDimensions = left.dimensions
  const rightDimensions = right.dimensions
  const base = { group_a: left.group_key, group_b: right.group_key }
  if (left.status !== STATUS_OK || right.status !== STATUS_OK) {
    return {
      ...base,
      comparable: false,
      code: 'insufficient_sample',
      message:
        `样本不足（各组确认样本 ${left.confirmed_sample_size} / ` +
        `${right.confirmed_sample_size}，门槛 ${MIN_GROUP_SAMPLE}）：不比较、不展示差值。`,
      delta: null,
    }
  }
  if (leftDimensions.question_type !== rightDimensions.question_type) {
    return {
      ...base,
      comparable: false,
      code: 'different_question_type',
      message: '题型不同：分值规则与作答方式不同，不能比较',
      delta: null,
    }
  }
  if (leftDimensions.difficulty_band !== rightDimensions.difficulty_band) {
    return {
      ...base,
      comparable: false,
      code: 'different_content_difficulty',
      message:
        `难度档不同（${leftDimensions.difficulty_band} vs ${rightDimensions.difficulty_band}）：题目内容权重不同，` +
        '得分率差异不能归因于学习效果',
      delta: null,
    }
  }
  if (leftDimensions.timing_state !== rightDimensions.timing_state) {
    return {
      ...base,
      comparable: false,
      code: 'different_time_condition',
      message:
        `时限条件不同（${leftDimensions.timing_state} vs ${rightDimensions.timing_state}）：限时与不限时的分数不可比`,
      delta: null,
    }
  }
  const exposures = new Set([leftDimensions.exposure_state, rightDimensions.exposure_state])
  if (leftDimensions.exposure_state !== rightDimensions.exposure_state && !exposures.has('strictly_independent')) {
    return {
      ...base,
      comparable: false,
      code: 'different_exposure_state',
      message:
        `暴露条件不同（${leftDimensions.exposure_state} vs ${rightDimensions.exposure_state}）：两组都已被污染，` +
        '无法判断差异来自学习还是来自暴露',
      delta: null,
    }
  }
  return { ...base, comparable: true, code: 'comparable_with_caveats', message: null, delta: null }
}

/** A per-group delta with its n, its spread and its own caveats. */
export function deltaRow(left: ComparableGroup, right: ComparableGroup): DeltaRow {
  const leftStats = statisticsOf(left)
  const rightStats = statisticsOf(right)
  const delta = Decimal.parse(rightStats.mean_confirmed_fraction).sub(
    Decimal.parse(leftStats.mean_confirmed_fraction),
  )
  return {
    metric: 'mean_confirmed_fraction',
    group_a_mean: leftStats.mean_confirmed_fraction,
    group_b_mean: rightStats.mean_confirmed_fraction,
    delta: delta.quantize(-4).toString(),
    sample_size: { group_a: left.confirmed_sample_size, group_b: right.confirmed_sample_size },
    spread: {
      group_a_stdev: leftStats.spread_stdev,
      group_b_stdev: rightStats.spread_stdev,
    },
    caveats: [
      '这是同一个人、不同时间、不同题目的两组观察值之差，不是因果效应，也不代表学习提升。',
      '两组题目内容与暴露条件仍可能不同；样本量小，差值不稳定。',
    ],
  }
}

export function groupKey(dimensions: GroupDimensions): string {
  return [
    dimensions.question_type,
    dimensions.difficulty_band,
    dimensions.timing_state,
    dimensions.exposure_state,
  ].join('|')
}

/** What this group's numbers may be used for, stated on the group itself. */
export function comparabilityStatement(options: {
  sufficient: boolean
  confirmedSampleSize: number
  dimensions: GroupDimensions
}): string {
  const dimensions = options.dimensions
  const where =
    `题型 ${dimensions.question_type_label}、难度档 ${dimensions.difficulty_band}` +
    `（代理 ${dimensions.difficulty_proxy}）、时限条件 ${dimensions.timing_state}、` +
    `暴露情况 ${dimensions.exposure_state}`
  if (!options.sufficient) {
    return `确认样本 ${options.confirmedSampleSize} < ${MIN_GROUP_SAMPLE}：不展示统计量，也不参与任何比较。（${where}）`
  }
  return (
    `确认样本 ${options.confirmedSampleSize}（≥${MIN_GROUP_SAMPLE}）：可给出该组自身的确认分均值/中位数与离散度。` +
    `（${where}）与其他组比较必须同题型、同难度档、同时限条件；即使条件相同，组间差值也只是观察差异，` +
    '不代表因果或学习提升。'
  )
}

/** A group being accumulated across attempts (Python's `groups.setdefault(...)` body). */
interface GroupAccumulator {
  group_key: string
  dimensions: GroupDimensions
  sample_size: number
  confirmed_sample_size: number
  fractions: Decimal[]
  exclusion_counts: Map<string, number>
}

function freshExclusionCounts(): Map<string, number> {
  return new Map([...EXCLUSION_MESSAGES.keys()].map((code) => [code, 0]))
}

function bump(counts: Map<string, number>, code: string): void {
  counts.set(code, (counts.get(code) as number) + 1)
}

/**
 * Grouped, sample-sized, deliberately non-causal comparison of practice attempts.
 *
 * Read-only: nothing is written and no snapshot is produced. Every payload passes through
 * {@link assertNoCausalSummary} before it is returned.
 */
export function buildEffectCalibration(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null; now: Instant },
): Record<string, unknown> {
  const subjectId = options.subjectId ?? null
  const project = requireProject(db, userId, projectId)
  const subject = subjectId === null ? null : requireSubject(db, userId, projectId, subjectId)

  const scoped = scopedAttempts(db, userId, projectId, { subjectId, now: options.now })
  const attempts = scoped.rows
  const disputedAnswers = disputedAnswerKeyIds(db, projectId)
  const disputedRubrics = disputedRubricIds(db, projectId)
  const assistedIds = assistedAttemptIds(db, userId, projectId)
  const exposure = exposureLabels(loadExposureFacts(db, userId), attempts, projectId, assistedIds)

  const groups = new Map<string, GroupAccumulator>()
  const exclusionsGlobal = freshExclusionCounts()
  for (const context of attempts) {
    const item = context.item
    const questionType = String(context.version.question_type)
    const dimensions: GroupDimensions = {
      question_type: questionType,
      question_type_label: questionTypeLabel(questionType),
      difficulty_band: difficultyBand(decimalOf(item.max_score)),
      difficulty_proxy: DIFFICULTY_PROXY,
      timing_state: timingState(db, context),
      exposure_state: (exposure.get(String(context.attempt.id)) as ExposureLabel).exposure_state,
    }
    const key = groupKey(dimensions)
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        group_key: key,
        dimensions,
        sample_size: 0,
        confirmed_sample_size: 0,
        fractions: [],
        exclusion_counts: freshExclusionCounts(),
      }
      groups.set(key, group)
    }
    group.sample_size += 1
    const [fraction, codes] = confirmedFraction(context, disputedAnswers, disputedRubrics)
    if (codes.length > 0) {
      // A code may repeat within one attempt; Python counts the attempt once per distinct code.
      for (const code of new Set(codes)) {
        bump(group.exclusion_counts, code)
        bump(exclusionsGlobal, code)
      }
    } else {
      group.confirmed_sample_size += 1
      group.fractions.push(fraction)
    }
  }

  const rows: CalibrationGroup[] = []
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) as GroupAccumulator
    const fractions = group.fractions
    const sufficient = fractions.length >= MIN_GROUP_SAMPLE
    let statistics: GroupStatistics | null = null
    if (sufficient) {
      const summary = spread(fractions)
      statistics = {
        mean_confirmed_fraction: summary.mean,
        median_confirmed_fraction: median(fractions),
        spread_stdev: summary.stdev,
        min_confirmed_fraction: summary.min,
        max_confirmed_fraction: summary.max,
        metric: 'confirmed_score / item_max_score',
      }
    }
    const reasons: GroupExclusionReason[] = []
    for (const code of EXCLUSION_MESSAGES.keys()) {
      const count = group.exclusion_counts.get(code) as number
      if (count === 0) continue
      reasons.push({ code, message: exclusionMessage(code), attempt_count: count })
    }
    rows.push({
      group_key: key,
      dimensions: group.dimensions,
      sample_size: group.sample_size,
      confirmed_sample_size: group.confirmed_sample_size,
      status: sufficient ? STATUS_OK : STATUS_INSUFFICIENT,
      // Withheld, not warned about: a number next to a warning is still read as the number.
      statistics,
      exclusions: {
        attempts_without_confirmed_score: group.sample_size - group.confirmed_sample_size,
        reasons,
      },
      comparability: comparabilityStatement({
        sufficient,
        confirmedSampleSize: fractions.length,
        dimensions: group.dimensions,
      }),
    })
  }

  const eligible = rows.filter((row) => row.status === STATUS_OK)
  const comparisons: ComparabilityVerdict[] = []
  for (let index = 0; index < eligible.length; index += 1) {
    for (const right of eligible.slice(index + 1)) {
      const row = comparabilityBetween(eligible[index], right)
      if (row.comparable) row.delta = deltaRow(eligible[index], right)
      comparisons.push(row)
    }
  }
  const comparablePairs = comparisons.filter((row) => row.comparable)

  const notComparable: Record<string, unknown>[] = []
  for (const row of rows) {
    if (row.status !== STATUS_OK) {
      notComparable.push({ group_key: row.group_key, code: STATUS_INSUFFICIENT, message: row.comparability })
    }
  }
  for (const row of comparisons) {
    if (!row.comparable) {
      notComparable.push({ group_key: `${row.group_a} ↔ ${row.group_b}`, code: row.code, message: row.message })
    }
  }

  const payload: Record<string, unknown> = {
    report_kind: 'effect_calibration',
    calculation_version: 'p2-c08',
    as_of: formatPythonIso(options.now),
    project_id: String(project.id),
    subject_id: subject === null ? null : String(subject.id),
    minimum_group_sample: MIN_GROUP_SAMPLE,
    grouping: {
      dimensions: ['question_type', 'difficulty_band', 'timing_state', 'exposure_state'],
      difficulty_proxy: DIFFICULTY_PROXY,
      difficulty_proxy_note: DIFFICULTY_PROXY_NOTE,
      timing_note: TIMING_NOTE,
      exposure_note: EXPOSURE_NOTE,
      attempts_in_scope: attempts.length,
      hidden_verification_attempts: scoped.hiddenRunCount,
      hidden_verification_content_attempts: scoped.hiddenContentCount,
    },
    groups: rows,
    group_count: rows.length,
    comparable_group_count: eligible.length,
    comparisons,
    comparable_pair_count: comparablePairs.length,
    not_comparable: notComparable,
    exclusions: {
      attempts_in_scope: attempts.length,
      reasons: [...exclusionsGlobal.entries()]
        .filter(([, count]) => count !== 0)
        .map(([code, count]) => ({ code, message: exclusionMessage(code), attempt_count: count })),
    },
    caveats: {
      statements: [
        '本报告只统计同一个人的个人作答记录：这是个人观察，不是对照实验，也没有对照组。',
        '不推断因果、不声称学习提升：任何组间差异都可能来自题目内容、时间、状态、运气与暴露条件的共同作用。',
        '各组的样本数、题目内容与暴露条件并不相同；只有同时满足同题型、同难度档、同时限条件的两组才给出组间差值，' +
          '且差值仍不代表因果。',
        '自评分、AI 估计分、待评、争议与失效分数一律不进入统计；确认样本少于门槛的组不展示任何统计量。',
        '若需要因果结论，需要预先设计的对照或随机化条件与足够样本，本报告不具备这些条件。',
      ],
      claims: { causal_claim: false, improvement_claim: false },
      minimum_group_sample: MIN_GROUP_SAMPLE,
    },
  }
  assertNoCausalSummary(payload)
  return payload
}
