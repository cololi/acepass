/**
 * Deterministic grading — port of `backend/domain/grading/adapters.py` and the pure helpers of
 * `backend/apps/common/answers.py` (`blank_specs`, `normalization_flags`, `blank_max_score`).
 *
 * Invariants carried over (R-INV-02/03):
 *  - an undecidable part is `pending_review`, never a guessed score, and never 0;
 *  - a wrong answer is a CONFIRMED zero (fully graded) — different from pending;
 *  - expressions are only given meaning by `expressions.ts`; units are reported, never converted
 *    in expression mode;
 *  - this module never reads the clock, storage or the network.
 *
 * Inputs are plain JSON (`unknown`), exactly like the Django layer passes dicts, so malformed
 * payloads behave the way Python does (mostly "treat as missing"). Scores are `Decimal`, rendered
 * with `str(Decimal)` semantics.
 */
import { Decimal, DecimalError, ZERO, pyMax, pyMin } from './decimal.ts'
import * as X from './expressions.ts'
import { pyFloatRepr } from './pyfmt.ts'
import { pyCasefold, pyCollapseSpaces, pyStrip } from './pytext.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = Record<string, unknown>

export const GradeStatus = { CONFIRMED: 'confirmed', PENDING_REVIEW: 'pending_review', ESTIMATED: 'estimated', VOID: 'void' } as const
export const GradeMethod = { DETERMINISTIC: 'deterministic', SELF_CONFIRMED: 'self_confirmed', REVIEWER_CONFIRMED: 'reviewer_confirmed', AI_ESTIMATED: 'ai_estimated', MIXED: 'mixed' } as const
export const MismatchPolicy = { REVIEW: 'review', WRONG: 'wrong' } as const
export const MultipleChoicePolicy = { EXACT_MATCH: 'exact_match', PARTIAL_CREDIT: 'partial_credit' } as const
export const QuestionType = { SINGLE_CHOICE: 'single_choice', MULTIPLE_CHOICE: 'multiple_choice', TRUE_FALSE: 'true_false', FILL_BLANK: 'fill_blank', CONSTRUCTED_RESPONSE: 'constructed_response', MATERIAL: 'material' } as const

const EQUIVALENCE_KEY = 'equivalence'
const EXPRESSION_MODE = 'expression'
const EXPRESSION_TOLERANCE_KEY = 'expression_tolerance'
const EXPRESSION_TIME_BUDGET_MS_KEY = 'expression_time_budget_ms'
const MAX_EXPRESSION_TOLERANCE = 1.0

const REVIEW_REASONS: Record<string, string> = {
  syntax: '表达式语法非法或含未知函数/符号，转人工复核',
  limit: '表达式超出受限计算上限，转人工复核',
  domain: '表达式在采样点无定义，无法判定等价，转人工复核',
  timeout: '表达式判分超时，转人工复核',
}
const FALLBACK_REASON = '表达式等价判定未完成，转人工复核'
const MISMATCH_REASON = '表达式与已登记答案不等价，且规则未明确判错，转人工复核'
const UNKNOWN_SYMBOL_REASON = '提交含未登记符号（可能是未知单位），转人工复核'
const NO_ANSWER_REASON = '表达式等价规则缺少已登记的标准答案，转人工复核'
const UNKNOWN_MODE_REASON = '未登记的等价判定模式，转人工复核'

export interface GradePart {
  part_id: string
  status: string
  score: Decimal | null
  max_score: Decimal
  method: string | null
  detail: Obj
}
export interface GradeResult {
  status: string
  method: string
  max_score: Decimal
  parts: GradePart[]
  confirmed_score: Decimal | null
  pending_max_score: Decimal
  is_fully_confirmed: boolean
  rule_snapshot: Obj
  notes: string[]
}

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
/** Python truthiness for JSON values. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (isObj(v)) return Object.keys(v).length > 0
  return true
}
/** `dict.get` — own keys only (never the prototype chain). */
const get = (o: unknown, key: string): unknown => (isObj(o) && Object.hasOwn(o, key) ? o[key] : undefined)
/** Python `str(x)` for the JSON values that reach grading. */
export function pyStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloatRepr(v)
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  return `{${Object.entries(v as Obj).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`
}
function pyRepr(v: unknown): string {
  if (typeof v === 'string') { const q = v.includes("'") && !v.includes('"') ? '"' : "'"; return q + v.replaceAll('\\', '\\\\').replaceAll(q, `\\${q}`).replaceAll('\n', '\\n') + q }
  return pyStr(v)
}

/** `_dec(value, default)` */
export function dec(value: unknown, fallback: Decimal): Decimal {
  if (value === null || value === undefined || value === '') return fallback
  try { return Decimal.parse(pyStr(value)) } catch (e) { if (e instanceof DecimalError) return fallback; throw e }
}
const sortedStrings = (xs: Iterable<string>): string[] => [...xs].sort()
const asStringList = (v: unknown): string[] => (Array.isArray(v) ? v.map(pyStr) : [])
const asRecord = (v: unknown): Obj => (isObj(v) ? v : {})

function part(part_id: string, status: string, score: Decimal | null, max_score: Decimal, method: string | null, detail: Obj = {}): GradePart {
  return { part_id, status, score, max_score, method, detail }
}

export function partToDict(p: GradePart): Obj {
  return { part_id: p.part_id, score: p.score === null ? null : p.score.toString(), max_score: p.max_score.toString(), status: p.status, method: p.method, detail: p.detail }
}
export function isCorrect(r: GradeResult): boolean {
  return Boolean(r.is_fully_confirmed && r.confirmed_score !== null && r.max_score.gt(ZERO) && r.confirmed_score.ge(r.max_score))
}
export function resultToDict(r: GradeResult): Obj {
  return {
    status: r.status, method: r.method, confirmed_score: r.confirmed_score === null ? null : r.confirmed_score.toString(),
    max_score: r.max_score.toString(), pending_max_score: r.pending_max_score.toString(), is_fully_confirmed: r.is_fully_confirmed,
    is_correct: isCorrect(r), parts: r.parts.map(partToDict), notes: r.notes,
  }
}
export function confirmedFraction(r: GradeResult): string | null {
  if (r.confirmed_score === null || r.max_score.le(ZERO)) return null
  return r.confirmed_score.div(r.max_score).quantize(-4).toString()
}

function finalize(parts: GradePart[], max_score: Decimal, rule_snapshot: Obj, notes: string[]): GradeResult {
  let confirmed = ZERO, pending = ZERO
  let hasConfirmed = false, hasPending = false
  const methods = new Set<string>()
  for (const p of parts) {
    if (p.status === GradeStatus.CONFIRMED) {
      hasConfirmed = true
      confirmed = confirmed.add(p.score ?? ZERO)
      if (p.method) methods.add(p.method)
    } else if (p.status === GradeStatus.PENDING_REVIEW) { hasPending = true; pending = pending.add(p.max_score) }
    else if (p.status === GradeStatus.VOID) { hasPending = true; pending = pending.add(p.max_score) }
  }
  const single = (): string => (methods.size > 1 ? GradeMethod.MIXED : methods.size === 1 ? [...methods][0] : GradeMethod.DETERMINISTIC)
  let status: string, method: string
  if (hasPending && hasConfirmed) { status = GradeStatus.PENDING_REVIEW; method = GradeMethod.MIXED }
  else if (hasPending) { status = GradeStatus.PENDING_REVIEW; method = single() }
  else if (hasConfirmed) { status = GradeStatus.CONFIRMED; method = single() }
  else { status = GradeStatus.VOID; method = GradeMethod.MIXED }
  const fully = status === GradeStatus.CONFIRMED && pending.isZero() && parts.every((p) => p.status === GradeStatus.CONFIRMED)
  return { status, method, max_score, parts, confirmed_score: hasConfirmed ? confirmed : null, pending_max_score: pending, is_fully_confirmed: fully, rule_snapshot, notes }
}

function pendingAll(partIds: string[], max_score: Decimal, reason: string, rule_snapshot: Obj): GradeResult {
  return finalize(partIds.map((id) => part(id, GradeStatus.PENDING_REVIEW, null, max_score, null, { reason })), max_score, rule_snapshot, [reason])
}

// ----------------------------------------------------------------- objective
export interface GradeInput { raw_answer: unknown; answer_payload: unknown; max_score: Decimal; rule: unknown }

export function gradeSingleChoice({ raw_answer, answer_payload, max_score, rule }: GradeInput): GradeResult {
  const correct = get(answer_payload, 'correct_option_id')
  if (!truthy(correct)) return pendingAll(['choice'], max_score, '标准答案缺失，无法自动判分', { rule: rule as Obj })
  let selected = get(raw_answer, 'selected_option_ids')
  if (!truthy(selected)) selected = get(raw_answer, 'selected_option_id')
  const list = typeof selected === 'string' ? [selected] : Array.isArray(selected) ? selected.map(pyStr) : []
  const wrong = dec(get(rule, 'wrong_score'), ZERO), blank = dec(get(rule, 'blank_score'), ZERO)
  let score: Decimal, detail: Obj
  if (list.length === 0) { score = blank; detail = { outcome: 'blank' } }
  else if (list.length > 1) { score = wrong; detail = { outcome: 'invalid_multiple_selection' } }
  else if (list[0] === correct) { score = max_score; detail = { outcome: 'correct' } }
  else { score = wrong; detail = { outcome: 'wrong' } }
  return finalize([part('choice', GradeStatus.CONFIRMED, score, max_score, GradeMethod.DETERMINISTIC, detail)], max_score, { correct_option_id: correct, rule: rule as Obj }, [])
}

export function gradeMultipleChoice({ raw_answer, answer_payload, max_score, rule }: GradeInput): GradeResult {
  const correct = asStringList(get(answer_payload, 'correct_option_ids'))
  if (correct.length === 0) return pendingAll(['choice'], max_score, '标准答案缺失，无法自动判分', { rule: rule as Obj })
  const policy = (truthy(get(answer_payload, 'policy')) ? get(answer_payload, 'policy') : get(rule, 'policy')) ?? MultipleChoicePolicy.EXACT_MATCH
  const policyV = truthy(policy) ? policy : MultipleChoicePolicy.EXACT_MATCH
  const partial = isObj(answer_payload) && Object.hasOwn(answer_payload, 'partial_score') ? answer_payload.partial_score : get(rule, 'partial_score')
  const wrongRaw = isObj(answer_payload) && Object.hasOwn(answer_payload, 'wrong_score') ? answer_payload.wrong_score : get(rule, 'wrong_score')
  const blankRaw = isObj(answer_payload) && Object.hasOwn(answer_payload, 'blank_score') ? answer_payload.blank_score : get(rule, 'blank_score')
  const wrongScore = dec(wrongRaw, ZERO), blankScore = dec(blankRaw, ZERO)

  let selRaw = get(raw_answer, 'selected_option_ids')
  if (selRaw === undefined || selRaw === null) selRaw = get(raw_answer, 'selected_option_id')
  const selected = typeof selRaw === 'string' ? [selRaw] : Array.isArray(selRaw) ? selRaw.map(pyStr) : []
  const snapshot = (): Obj => ({ correct_option_ids: correct, policy: policyV, partial_score: truthy(partial) ? pyStr(partial) : null, rule: rule as Obj })
  if (new Set(selected).size !== selected.length) return pendingAll(['choice'], max_score, '提交中存在重复选项 ID，需人工确认', { rule: rule as Obj })

  const sel = new Set(selected), cor = new Set(correct)
  const snap = snapshot()
  const one = (score: Decimal, detail: Obj): GradeResult =>
    finalize([part('choice', GradeStatus.CONFIRMED, score, max_score, GradeMethod.DETERMINISTIC, detail)], max_score, snap, [])
  if (sel.size === 0) return one(blankScore, { outcome: 'blank' })
  const equalSets = sel.size === cor.size && [...sel].every((x) => cor.has(x))
  if (equalSets) return one(max_score, { outcome: 'correct' })
  const missing = sortedStrings([...cor].filter((x) => !sel.has(x)))
  if ([...sel].every((x) => cor.has(x))) {
    if (policyV === MultipleChoicePolicy.PARTIAL_CREDIT) {
      if (partial === null || partial === undefined || partial === '') return pendingAll(['choice'], max_score, '少选部分分规则未配置，不猜测分数', snap)
      return one(pyMin(dec(partial, ZERO), max_score), { outcome: 'partial', missing })
    }
    return one(ZERO, { outcome: 'incomplete_exact_match', missing })
  }
  return one(wrongScore, { outcome: 'wrong', extra: sortedStrings([...sel].filter((x) => !cor.has(x))) })
}

export function gradeTrueFalse({ raw_answer, answer_payload, max_score, rule }: GradeInput): GradeResult {
  const correct = get(answer_payload, 'value')
  if (typeof correct !== 'boolean') return pendingAll(['statement'], max_score, '标准答案缺失，无法自动判分', { rule: rule as Obj })
  const submitted = get(raw_answer, 'value') ?? null
  const wrong = dec(get(rule, 'wrong_score'), ZERO), blank = dec(get(rule, 'blank_score'), ZERO)
  const snapshot: Obj = { correct_value: correct, rule: rule as Obj }
  let p: GradePart
  if (submitted === null) p = part('statement', GradeStatus.CONFIRMED, blank, max_score, GradeMethod.DETERMINISTIC, { outcome: 'blank' })
  else if (typeof submitted !== 'boolean') return pendingAll(['statement'], max_score, '提交值不是布尔值，需人工确认', snapshot)
  else if (submitted === correct) p = part('statement', GradeStatus.CONFIRMED, max_score, max_score, GradeMethod.DETERMINISTIC, { outcome: 'correct' })
  else p = part('statement', GradeStatus.CONFIRMED, wrong, max_score, GradeMethod.DETERMINISTIC, { outcome: 'wrong' })
  return finalize([p], max_score, snapshot, [])
}

// ----------------------------------------------------------------- fill blank
const SAFE_POLICY_KEYS = new Set(['case_insensitive', 'strip_whitespace', 'fullwidth_to_halfwidth', 'collapse_internal_spaces', 'unicode_nfkc'])
export function blankSpecs(payload: unknown): Record<string, unknown> {
  const blanks = get(payload, 'blanks')
  return isObj(blanks) ? blanks : {}
}
export function normalizationFlags(spec: unknown): Record<string, boolean> {
  const flags = get(spec, 'normalization')
  if (!truthy(flags) || !isObj(flags)) return {}
  return Object.fromEntries(Object.entries(flags).filter(([k]) => SAFE_POLICY_KEYS.has(k)).map(([k, v]) => [k, truthy(v)]))
}
export function blankMaxScore(spec: unknown, fallback: Decimal): Decimal {
  const raw = get(spec, 'max_score')
  if (raw === null || raw === undefined || raw === '') return fallback
  try { return Decimal.parse(pyStr(raw)) } catch (e) { if (e instanceof DecimalError) return fallback; throw e }
}

export function normalizeText(value: string, flags: Record<string, boolean>): string {
  let text = value
  if (flags.unicode_nfkc) text = text.normalize('NFKC')
  if (flags.fullwidth_to_halfwidth)
    text = Array.from(text).map((ch) => { const c = ch.codePointAt(0)!; return c >= 0xff01 && c <= 0xff5e ? String.fromCodePoint(c - 0xfee0) : ch }).join('')
  if (flags.strip_whitespace ?? true) text = pyStrip(text)
  if (flags.collapse_internal_spaces) text = pyCollapseSpaces(text)
  if (flags.case_insensitive) text = pyCasefold(text)
  return text
}

const UNIT = '[^\\s0-9+\\-.,]+'
// Python `\s` / `[0-9]` / `\d`: ASCII digits only here on purpose (see header of expressions.ts).
const NUMERIC_RE = new RegExp(`^([+-]?[0-9]*\\.?[0-9]+(?:[eE][+-]?[0-9]+)?)\\s*(${UNIT})?$`, 'u')
const EXPRESSION_RE = /[*/^()[\]{}]|(?<![\d.])[+-](?![\d.])|\//u

export function parseNumeric(value: unknown): [Decimal | null, string] {
  if (value === null || value === undefined) return [null, '']
  const text = pyStrip(pyStr(value))
  if (!text) return [null, '']
  const m = NUMERIC_RE.exec(text)
  if (!m) return [null, '']
  try { return [Decimal.parse(m[1]), m[2] ?? ''] } catch (e) { if (e instanceof DecimalError) return [null, '']; throw e }
}

function acceptedValues(spec: unknown): string[] {
  for (const key of ['accepted_values', 'accepted']) {
    const raw = get(spec, key)
    if (Array.isArray(raw) && raw.length > 0) return raw.map(pyStr)
  }
  return []
}

export function gradeFillBlank({ raw_answer, answer_payload, max_score, rule }: GradeInput): GradeResult {
  const specs = blankSpecs(answer_payload)
  let submitted = get(raw_answer, 'blanks')
  if (!isObj(submitted)) submitted = {}
  const ids = Object.keys(specs)
  if (ids.length === 0) return pendingAll(['blank'], max_score, '缺少按空位的答案规则，无法自动判分', { rule: rule as Obj })
  const defaultMismatch = isObj(rule) && Object.hasOwn(rule, 'mismatch_policy') ? rule.mismatch_policy : MismatchPolicy.REVIEW
  const perBlank = max_score.div(Decimal.fromInt(ids.length))
  const parts: GradePart[] = []
  for (const id of ids) {
    const spec = specs[id]
    parts.push(gradeOneBlank(id, spec, Object.hasOwn(submitted as Obj, id) ? (submitted as Obj)[id] : undefined, blankMaxScore(spec, perBlank), defaultMismatch))
  }
  const snapshot: Obj = {
    blank_ids: ids, default_mismatch_policy: defaultMismatch,
    expression_blanks: ids.filter((id) => isObj(specs[id]) && (specs[id] as Obj)[EQUIVALENCE_KEY] === EXPRESSION_MODE), rule: rule as Obj,
  }
  const notes: string[] = []
  for (const p of parts) {
    if (p.status === GradeStatus.PENDING_REVIEW && p.detail.equivalence === EXPRESSION_MODE) {
      const reason = p.detail.reason
      if (typeof reason === 'string' && reason && !notes.includes(reason)) notes.push(reason)
    }
  }
  return finalize(parts, max_score, snapshot, notes)
}

function gradeOneBlank(blankId: string, spec: unknown, submittedRaw: unknown, blankMax: Decimal, defaultMismatch: unknown): GradePart {
  const policy = isObj(spec) && Object.hasOwn(spec, 'mismatch_policy') ? spec.mismatch_policy : defaultMismatch
  const numeric = get(spec, 'numeric')
  const accepted = acceptedValues(spec)
  const flags = normalizationFlags(spec)
  const unitRule = truthy(get(spec, 'unit')) ? get(spec, 'unit') : {}
  const equivalence = get(spec, EQUIVALENCE_KEY)
  const submitted = submittedRaw === undefined ? null : submittedRaw
  const pending = (detail: Obj): GradePart => part(blankId, GradeStatus.PENDING_REVIEW, null, blankMax, null, detail)

  if (submitted === null) return pending({ reason: '未作答' })
  const text = typeof submitted === 'string' ? submitted : pyStr(submitted)
  if (!pyStrip(text)) return pending({ reason: '空作答' })

  if (equivalence !== undefined && equivalence !== null && equivalence !== '' && equivalence !== EXPRESSION_MODE)
    return pending({ reason: UNKNOWN_MODE_REASON, submitted: text, equivalence: pyStr(equivalence) })
  if (equivalence === EXPRESSION_MODE) return gradeExpressionBlank(blankId, spec, text, blankMax, policy, flags, accepted)
  if (truthy(numeric)) return gradeNumericBlank(blankId, numeric, text, blankMax, policy, unitRule)

  const target = normalizeText(text, flags)
  for (const candidate of accepted)
    if (normalizeText(pyStr(candidate), flags) === target)
      return part(blankId, GradeStatus.CONFIRMED, blankMax, blankMax, GradeMethod.DETERMINISTIC, { outcome: 'correct', submitted: text })
  if (policy === MismatchPolicy.WRONG)
    return part(blankId, GradeStatus.CONFIRMED, ZERO, blankMax, GradeMethod.DETERMINISTIC, { outcome: 'wrong', submitted: text, policy: 'wrong' })
  return pending({ reason: '未匹配到已登记的等价答案，等待人工复核', submitted: text, policy })
}

function expressionTolerance(spec: unknown): number {
  const raw = get(spec, EXPRESSION_TOLERANCE_KEY)
  if (raw === null || raw === undefined || raw === '') return X.DEFAULT_TOLERANCE
  let value: number
  try { value = X.toFloat(raw) } catch { return X.DEFAULT_TOLERANCE }
  if (!Number.isFinite(value) || value <= 0) return X.DEFAULT_TOLERANCE
  return Math.min(value, MAX_EXPRESSION_TOLERANCE)
}
function expressionBudget(spec: unknown): number {
  const raw = get(spec, EXPRESSION_TIME_BUDGET_MS_KEY)
  if (raw === null || raw === undefined || raw === '') return X.DEFAULT_TIME_BUDGET_SECONDS
  let ms: number
  try { ms = X.toFloat(raw) } catch { return X.DEFAULT_TIME_BUDGET_SECONDS }
  if (!Number.isFinite(ms) || ms <= 0) return X.DEFAULT_TIME_BUDGET_SECONDS
  return Math.min(ms / 1000, X.MAX_TIME_BUDGET_SECONDS)
}

function freeVars(expr: string): string[] | null {
  try { return X.freeVariables(expr) } catch (e) { if (e instanceof X.ExpressionError) return null; throw e }
}
function unregisteredSymbols(target: string, candidates: string[]): string[] {
  const submitted = freeVars(target)
  if (submitted === null) return []
  const registered = new Set<string>()
  for (const c of candidates) { const v = freeVars(c); if (v) v.forEach((s) => registered.add(s)) }
  return submitted.filter((s) => !registered.has(s)).sort()
}
function mentionsMoreSymbolsThanAccepted(target: string, candidates: string[]): boolean {
  const submitted = freeVars(target)
  if (submitted === null) return false
  const counts = candidates.map(freeVars).filter((v): v is string[] => v !== null).map((v) => v.length)
  if (counts.length === 0) return false
  return submitted.length > Math.max(...counts)
}

function gradeExpressionBlank(blankId: string, spec: unknown, text: string, blankMax: Decimal, policy: unknown, flags: Record<string, boolean>, accepted: string[]): GradePart {
  const pending = (detail: Obj): GradePart => part(blankId, GradeStatus.PENDING_REVIEW, null, blankMax, null, detail)
  const correct = (detail: Obj): GradePart => part(blankId, GradeStatus.CONFIRMED, blankMax, blankMax, GradeMethod.DETERMINISTIC, detail)
  if (accepted.length === 0) return pending({ reason: NO_ANSWER_REASON, submitted: text, equivalence: EXPRESSION_MODE })
  const target = normalizeText(text, flags)
  const candidates = accepted.map((c) => normalizeText(c, flags))
  for (const c of candidates)
    if (c === target) return correct({ outcome: 'correct', submitted: text, equivalence: EXPRESSION_MODE, match: 'exact', accepted: c })

  const tolerance = expressionTolerance(spec), budget = expressionBudget(spec)
  if (mentionsMoreSymbolsThanAccepted(target, candidates))
    return pending({ reason: UNKNOWN_SYMBOL_REASON, submitted: text, equivalence: EXPRESSION_MODE, unknown_symbols: unregisteredSymbols(target, candidates) })

  const verdicts: [string, X.ExpressionVerdict][] = []
  for (const c of candidates) {
    const v = X.compareExpressions(target, c, { tolerance, timeBudget: budget })
    if (v.outcome === X.OUTCOME_EQUIVALENT)
      return correct({ outcome: 'correct', submitted: text, equivalence: EXPRESSION_MODE, match: 'expression', accepted: c, samples_checked: v.samplesChecked, tolerance: pyFloatRepr(tolerance), reason: v.reason })
    verdicts.push([c, v])
  }
  const undecided = verdicts.find(([, v]) => v.outcome === X.OUTCOME_UNKNOWN)
  if (undecided) {
    const [c, v] = undecided
    return pending({
      reason: REVIEW_REASONS[v.errorType ?? ''] ?? FALLBACK_REASON, submitted: text, equivalence: EXPRESSION_MODE, accepted: c,
      error: v.errorType, message: v.reason, samples_checked: v.samplesChecked,
      sample: v.sample && Object.keys(v.sample).length > 0 ? v.sample : null,
    })
  }
  const unknownSymbols = unregisteredSymbols(target, verdicts.map(([c]) => c))
  if (unknownSymbols.length > 0)
    return pending({ reason: UNKNOWN_SYMBOL_REASON, submitted: text, equivalence: EXPRESSION_MODE, unknown_symbols: unknownSymbols })
  const samplesChecked = Math.min(...verdicts.map(([, v]) => v.samplesChecked))
  if (policy === MismatchPolicy.WRONG)
    return part(blankId, GradeStatus.CONFIRMED, ZERO, blankMax, GradeMethod.DETERMINISTIC, { outcome: 'wrong', submitted: text, equivalence: EXPRESSION_MODE, policy: 'wrong', reason: '表达式与已登记答案不等价', samples_checked: samplesChecked })
  return pending({ reason: MISMATCH_REASON, submitted: text, equivalence: EXPRESSION_MODE, policy, samples_checked: samplesChecked })
}

function gradeNumericBlank(blankId: string, numeric: unknown, text: string, blankMax: Decimal, policy: unknown, unitRule: unknown): GradePart {
  const pending = (detail: Obj): GradePart => part(blankId, GradeStatus.PENDING_REVIEW, null, blankMax, null, detail)
  let target: Decimal
  try { target = Decimal.parse(pyStr(get(numeric, 'value'))) } catch (e) { if (e instanceof DecimalError) return pending({ reason: '数值规则无效' }); throw e }
  const absTol = dec(get(numeric, 'abs_tol'), ZERO), relTol = dec(get(numeric, 'rel_tol'), ZERO)
  const conversions = truthy(get(numeric, 'unit_conversions')) ? get(numeric, 'unit_conversions') : {}
  const expectedUnit = pyStrOrEmpty(truthy(get(unitRule, 'expected')) ? get(unitRule, 'expected') : get(numeric, 'expected_unit'))
  const whitelist = truthy(get(unitRule, 'whitelist')) ? get(unitRule, 'whitelist') : conversions

  let [value, unit] = parseNumeric(text)
  if (value === null) {
    if (EXPRESSION_RE.test(text)) return pending({ reason: '提交内容是表达式，P0 不做符号等价判断，转人工复核', submitted: text })
    if (policy === MismatchPolicy.WRONG) return part(blankId, GradeStatus.CONFIRMED, ZERO, blankMax, GradeMethod.DETERMINISTIC, { outcome: 'wrong', submitted: text })
    return pending({ reason: '无法解析为数值（可能含表达式或格式差异）', submitted: text })
  }
  if (unit) {
    if (expectedUnit) {
      if (unit === expectedUnit) { /* same unit */ }
      else if (isObj(whitelist) && Object.hasOwn(whitelist, unit) && Object.hasOwn(whitelist, expectedUnit)) {
        let factor: Decimal
        try { factor = Decimal.parse(pyStr(whitelist[unit])).div(Decimal.parse(pyStr(whitelist[expectedUnit]))) }
        catch (e) { if (e instanceof DecimalError) return pending({ reason: '单位换算表无效', unit }); throw e }
        value = value.mul(factor)
      } else return pending({ reason: '未知或不允许的单位', unit, expected_unit: expectedUnit })
    } else if (!(isObj(whitelist) && Object.hasOwn(whitelist, unit))) return pending({ reason: '未配置单位规则', unit })
  } else if (expectedUnit) {
    if (!truthy(get(unitRule, 'unit_optional') ?? false)) return pending({ reason: '缺少单位', expected_unit: expectedUnit })
  }
  const tolerance = pyMax(absTol, relTol.mul(target.abs()))
  if (value.sub(target).abs().le(tolerance))
    return part(blankId, GradeStatus.CONFIRMED, blankMax, blankMax, GradeMethod.DETERMINISTIC, { outcome: 'correct', submitted: text, parsed: value.toString() })
  if (policy === MismatchPolicy.WRONG)
    return part(blankId, GradeStatus.CONFIRMED, ZERO, blankMax, GradeMethod.DETERMINISTIC, { outcome: 'wrong', submitted: text, parsed: value.toString(), tolerance: tolerance.toString() })
  return pending({ reason: '超出数值容差且规则未明确判错', submitted: text, parsed: value.toString(), tolerance: tolerance.toString() })
}
const pyStrOrEmpty = (v: unknown): string => (v === null || v === undefined || v === '' ? '' : pyStr(v))

// ------------------------------------------------------ constructed response
export function gradeConstructedResponse(i: GradeInput & { rubric: unknown }): GradeResult {
  const criteria = get(i.rubric, 'criteria')
  if (!truthy(criteria)) return pendingAll(['rubric'], i.max_score, '缺少评分标准，无法评分，保持待评', { rule: i.rule as Obj })
  // Python iterates whatever is truthy: a non-empty STRING/number-like value yields no dict elements, so the
  // result has zero parts and status `void`. Reproduced on purpose for parity; see docs/dsh-migration/04 (KNOWN-1).
  const items: unknown[] = Array.isArray(criteria) ? criteria : typeof criteria === 'string' ? Array.from(criteria) : isObj(criteria) ? Object.keys(criteria) : []
  const parts = items.filter(isObj).map((c) =>
    part(pyStr(c.criterion_id ?? null), GradeStatus.PENDING_REVIEW, null, dec(c.max_score, ZERO), null, { text: c.text === undefined ? '' : c.text, required: truthy(c.required) }))
  return finalize(parts, i.max_score, { rule: i.rule as Obj, rubric_version_required: true }, ['大题需逐评分点人工确认'])
}

// ------------------------------------------------------------------ dispatch
export function grade(input: { question_type: string; raw_answer: unknown; answer_payload: unknown; max_score: Decimal; rule: unknown; rubric?: unknown }): GradeResult {
  const raw = isObj(input.raw_answer) ? input.raw_answer : {}
  const base: GradeInput = { raw_answer: raw, answer_payload: input.answer_payload, max_score: input.max_score, rule: input.rule }
  switch (input.question_type) {
    case QuestionType.SINGLE_CHOICE: return gradeSingleChoice(base)
    case QuestionType.MULTIPLE_CHOICE: return gradeMultipleChoice(base)
    case QuestionType.TRUE_FALSE: return gradeTrueFalse(base)
    case QuestionType.FILL_BLANK: return gradeFillBlank(base)
    case QuestionType.CONSTRUCTED_RESPONSE: return gradeConstructedResponse({ ...base, rubric: input.rubric ?? null })
    default: return pendingAll(['unknown'], input.max_score, `P0 尚不支持自动判分的题型：${input.question_type}`, { rule: input.rule as Obj })
  }
}
export { asRecord }
