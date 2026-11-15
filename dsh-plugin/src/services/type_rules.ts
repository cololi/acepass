/**
 * Scoring-rule validation for an exam spec version.
 *
 * Port of `apps/exams/services/core.py::_validate_type_rules`. This is the gate between "a user
 * typed some scoring numbers" and "a published spec", so both the messages and their order are part
 * of what the UI shows, and both are pinned by golden vectors produced from the real function.
 *
 * One rule looks wrong and is kept anyway: **a negative `wrong_score` is rejected**. The grading
 * engine itself accepts a negative penalty (the fixtures in `grading.test.ts` use `-1`), but this
 * validator refuses to *author* one. Refusing is the stricter, safer direction, and silently
 * allowing a value the Python gate rejects would let a spec through that the original would not.
 */
import { Decimal, ZERO } from '../domain/decimal.ts'
import { InvalidInput } from './errors.ts'

/** `QuestionType.values`, in the order the Python enum declares them. */
export const QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'constructed_response',
  'material',
] as const

export type QuestionType = (typeof QUESTION_TYPES)[number]

const QUESTION_TYPE_SET: ReadonlySet<string> = new Set(QUESTION_TYPES)

/** The numeric keys checked on every rule; `default_max_score` is also the upper bound for the rest. */
const SCORE_KEYS = ['default_max_score', 'wrong_score', 'blank_score', 'partial_score'] as const
const BOUNDED_KEYS = ['wrong_score', 'blank_score', 'partial_score'] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Python treats `None` and `""` as "not configured" for every score key. */
function isUnset(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

function asDecimalOrThrow(questionType: string, key: string, raw: unknown): Decimal {
  try {
    return Decimal.parse(String(raw))
  } catch {
    throw new InvalidInput(`${questionType}.${key} 必须是十进制数`)
  }
}

export function validateTypeRules(rules: unknown): void {
  if (!isPlainRecord(rules)) throw new InvalidInput('question_type_rules 必须是对象')

  // Iteration follows the key order of the payload, exactly like a Python dict: the first failing
  // type decides the message the user sees.
  for (const [questionType, rule] of Object.entries(rules)) {
    if (!QUESTION_TYPE_SET.has(questionType)) {
      throw new InvalidInput(`未知题型：${questionType}`, { details: { type: questionType } })
    }
    if (rule === null || rule === undefined) continue
    if (!isPlainRecord(rule)) throw new InvalidInput(`${questionType} 的规则必须是对象`)

    for (const key of SCORE_KEYS) {
      const raw = rule[key]
      if (isUnset(raw)) continue
      const value = asDecimalOrThrow(questionType, key, raw)
      if (value.lt(ZERO)) throw new InvalidInput(`${questionType}.${key} 不能为负`)
    }

    const maxRaw = rule['default_max_score']
    if (isUnset(maxRaw)) continue
    const maxScore = Decimal.parse(String(maxRaw))
    for (const key of BOUNDED_KEYS) {
      const raw = rule[key]
      if (isUnset(raw)) continue
      const value = Decimal.parse(String(raw))
      if (value.gt(maxScore)) throw new InvalidInput(`${questionType}.${key} 不能超过该题型满分`)
    }
  }
}
