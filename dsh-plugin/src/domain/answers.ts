/**
 * Answer payload validation per question type — port of `backend/apps/common/answers.py`.
 *
 * The payload shape *is* the grading contract: an answer can only be marked `checked` once this
 * returns nothing, so accepting something Python rejects would let an ungradable answer reach the
 * grader. Every message, path and code is pinned by golden vectors produced from the real function.
 *
 * Nothing here awards a score; scoring lives in `grading.ts`.
 */
import { Decimal } from './decimal.ts'

export interface AnswerProblem {
  code: string
  message: string
  path: string
}

const OPTION_ID = /^[A-Za-z0-9_-]{1,40}$/
const BLANK_ID = /^[A-Za-z0-9_-]{1,40}$/
const SAFE_POLICY_KEYS: ReadonlySet<string> = new Set([
  'case_insensitive',
  'strip_whitespace',
  'fullwidth_to_halfwidth',
  'collapse_internal_spaces',
  'unicode_nfkc',
])
const MISMATCH_POLICIES: ReadonlySet<string> = new Set(['review', 'wrong'])
const MC_POLICIES: ReadonlySet<string> = new Set(['exact_match', 'partial_credit'])

const MATERIAL = 'material'
const SINGLE_CHOICE = 'single_choice'
const MULTIPLE_CHOICE = 'multiple_choice'
const TRUE_FALSE = 'true_false'
const FILL_BLANK = 'fill_blank'
const CONSTRUCTED_RESPONSE = 'constructed_response'

function problem(code: string, message: string, path = ''): AnswerProblem {
  return { code, message, path }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Python `value in (None, "")`. Note `0` and `false` are NOT in that set. */
function isUnset(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/**
 * Python truthiness. `[]`, `{}`, `""` and `0` are all falsy there and truthy in JavaScript, and the
 * `if not accepted and not numeric` branch is decided by exactly this.
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'number') return value !== 0
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return true
}

/** `str()` as Python writes it, for the interpolated parts of the messages. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/** `repr()` for the two values that appear in `answer_kind_mismatch`. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return `'${value}'`
  return pyStr(value)
}

function decimalOrProblem(
  value: unknown,
  path: string,
  problems: AnswerProblem[],
  options: { allowNone?: boolean } = {},
): Decimal | null {
  if (isUnset(value)) {
    if (options.allowNone === true) return null
    problems.push(problem('score_missing', '缺少分值配置', path))
    return null
  }
  let parsed: Decimal
  try {
    parsed = Decimal.parse(String(value))
  } catch {
    problems.push(problem('score_invalid', '分值必须是十进制数', path))
    return null
  }
  if (parsed.lt(Decimal.zero())) {
    problems.push(problem('score_negative', '分值不能为负', path))
    return null
  }
  return parsed
}

function optionIdsOf(content: Record<string, unknown> | null): Set<string> {
  const ids = new Set<string>()
  const options = content?.['options']
  if (!Array.isArray(options)) return ids
  for (const option of options) {
    if (isRecord(option) && option['id']) ids.add(pyStr(option['id']))
  }
  return ids
}

function blankIdsOf(content: Record<string, unknown> | null): string[] {
  const ids: string[] = []
  const blanks = content?.['blanks']
  if (!Array.isArray(blanks)) return ids
  for (const blank of blanks) {
    if (isRecord(blank) && blank['blank_id']) ids.push(pyStr(blank['blank_id']))
  }
  return ids
}

export function validateAnswerPayload(
  payload: unknown,
  questionType: string,
  content: Record<string, unknown> | null = null,
): AnswerProblem[] {
  const problems: AnswerProblem[] = []
  const contentRecord = isRecord(content) ? content : null

  if (questionType === MATERIAL) {
    // A material parent carries no answer of its own; anything but an empty object/null is wrong.
    const empty = isRecord(payload) && Object.keys(payload).length === 0
    if (!(payload === null || payload === undefined || empty)) {
      problems.push(problem('material_has_answer', '共享材料父题不应带答案', 'answer_payload'))
    }
    return problems
  }
  if (!isRecord(payload)) {
    return [problem('answer_not_object', '答案必须是对象', 'answer_payload')]
  }

  const declared = payload['kind']
  if (declared !== questionType) {
    problems.push(
      problem(
        'answer_kind_mismatch',
        `答案类型 ${pyRepr(declared)} 与题型 ${pyRepr(questionType)} 不一致`,
        'answer_payload.kind',
      ),
    )
    return problems
  }

  const optionIds = optionIdsOf(contentRecord)
  const blankIds = blankIdsOf(contentRecord)

  if (questionType === SINGLE_CHOICE) {
    const correct = payload['correct_option_id']
    if (typeof correct !== 'string' || !OPTION_ID.test(correct)) {
      problems.push(problem('correct_option_missing', '单选题必须指定唯一的正确选项 ID', 'answer_payload'))
    } else if (optionIds.size > 0 && !optionIds.has(correct)) {
      problems.push(problem('correct_option_unknown', `正确选项 ${correct} 不在题干选项中`, 'answer_payload'))
    }
  } else if (questionType === MULTIPLE_CHOICE) {
    const correct = payload['correct_option_ids']
    if (!Array.isArray(correct) || correct.length === 0) {
      problems.push(problem('correct_options_missing', '多选题必须给出非空的正确选项集合', 'answer_payload'))
    } else {
      const distinct = new Set(correct.map((value) => pyStr(value)))
      if (distinct.size !== correct.length) {
        problems.push(problem('correct_options_duplicate', '正确选项集合存在重复 ID', 'answer_payload'))
      }
      for (const optionId of correct) {
        if (typeof optionId !== 'string' || !OPTION_ID.test(optionId)) {
          problems.push(problem('correct_option_invalid', '选项 ID 无效', 'answer_payload'))
        } else if (optionIds.size > 0 && !optionIds.has(optionId)) {
          problems.push(problem('correct_option_unknown', `正确选项 ${optionId} 不在题干选项中`, 'answer_payload'))
        }
      }
    }
    const policy = payload['policy'] === undefined ? 'exact_match' : payload['policy']
    if (typeof policy !== 'string' || !MC_POLICIES.has(policy)) {
      problems.push(problem('mc_policy_invalid', '多选计分策略无效', 'answer_payload.policy'))
    }
    if (policy === 'partial_credit') {
      decimalOrProblem(payload['partial_score'], 'answer_payload.partial_score', problems)
    } else {
      const partial = payload['partial_score']
      // A partial score without the policy would be an implicit guess, so it is refused instead.
      if (!(isUnset(partial) || partial === '0' || partial === '0.00')) {
        problems.push(
          problem(
            'partial_score_without_policy',
            '未选择少选部分分策略时不应配置部分分（避免隐式猜测）',
            'answer_payload.partial_score',
          ),
        )
      }
    }
    decimalOrProblem(payload['wrong_score'] === undefined ? '0' : payload['wrong_score'], 'answer_payload.wrong_score', problems, {
      allowNone: true,
    })
    decimalOrProblem(payload['blank_score'] === undefined ? '0' : payload['blank_score'], 'answer_payload.blank_score', problems, {
      allowNone: true,
    })
  } else if (questionType === TRUE_FALSE) {
    if (typeof payload['value'] !== 'boolean') {
      problems.push(problem('tf_value_missing', '判断题必须给出布尔标准答案（false 不等于未答）', 'answer_payload'))
    }
  } else if (questionType === FILL_BLANK) {
    const blanks = payload['blanks']
    if (!isRecord(blanks) || Object.keys(blanks).length === 0) {
      problems.push(problem('blanks_missing', '填空题必须按空位给出答案', 'answer_payload.blanks'))
    } else {
      if (blankIds.length > 0) {
        const missing = blankIds.filter((blankId) => !(blankId in blanks))
        const unknown = Object.keys(blanks).filter((blankId) => !blankIds.includes(blankId))
        if (missing.length > 0) {
          problems.push(
            problem('blank_answer_missing', `缺少空位答案：${missing.join(', ')}`, 'answer_payload.blanks'),
          )
        }
        if (unknown.length > 0) {
          problems.push(
            problem('blank_answer_unknown', `存在题干未定义的空位：${unknown.join(', ')}`, 'answer_payload.blanks'),
          )
        }
      }
      for (const [blankId, spec] of Object.entries(blanks)) {
        const path = `answer_payload.blanks.${blankId}`
        if (!BLANK_ID.test(pyStr(blankId))) {
          problems.push(problem('blank_id_invalid', '空位 ID 无效', path))
          continue
        }
        if (!isRecord(spec)) {
          problems.push(problem('blank_spec_invalid', '空位答案必须是对象', path))
          continue
        }
        const accepted = spec['accepted_values']
        const numeric = spec['numeric']
        if (!pyTruthy(accepted) && !pyTruthy(numeric)) {
          problems.push(
            problem('blank_without_rule', '每个空位必须给出可接受答案或数值规则，无法判断时转人工复核', path),
          )
        }
        if (accepted !== undefined && accepted !== null) {
          if (!Array.isArray(accepted) || accepted.length === 0) {
            problems.push(problem('accepted_values_invalid', 'accepted_values 必须是非空数组', path))
          } else if (!accepted.every((value) => typeof value === 'string')) {
            problems.push(problem('accepted_values_invalid', 'accepted_values 必须是字符串数组', path))
          }
        }
        const normalization = spec['normalization']
        if (normalization !== undefined && normalization !== null) {
          if (!isRecord(normalization)) {
            problems.push(problem('normalization_invalid', '归一化开关必须是对象', path))
          } else {
            const unknownKeys = Object.keys(normalization).filter((key) => !SAFE_POLICY_KEYS.has(key))
            if (unknownKeys.length > 0) {
              problems.push(
                problem('normalization_unknown', `不支持的归一化开关：${unknownKeys.sort().join(', ')}`, path),
              )
            }
            if (pyTruthy(normalization['delete_symbols'])) {
              problems.push(problem('normalization_unsafe', '禁止全局删除负号/标点等符号', path))
            }
          }
        }
        if (numeric !== undefined && numeric !== null) {
          if (!isRecord(numeric)) {
            problems.push(problem('numeric_invalid', 'numeric 规则必须是对象', path))
          } else {
            decimalOrProblem(numeric['value'], `${path}.numeric.value`, problems)
            decimalOrProblem(
              numeric['abs_tol'] === undefined ? '0' : numeric['abs_tol'],
              `${path}.numeric.abs_tol`,
              problems,
              { allowNone: true },
            )
            decimalOrProblem(
              numeric['rel_tol'] === undefined ? '0' : numeric['rel_tol'],
              `${path}.numeric.rel_tol`,
              problems,
              { allowNone: true },
            )
            const conversions = numeric['unit_conversions']
            if (conversions !== undefined && conversions !== null) {
              if (!isRecord(conversions)) {
                problems.push(problem('unit_conversions_invalid', '单位换算表必须是对象', path))
              } else {
                for (const [unit, factor] of Object.entries(conversions)) {
                  decimalOrProblem(factor, `${path}.numeric.unit_conversions.${unit}`, problems)
                }
              }
            }
          }
        }
        const policy = spec['mismatch_policy'] === undefined ? 'review' : spec['mismatch_policy']
        if (typeof policy !== 'string' || !MISMATCH_POLICIES.has(policy)) {
          problems.push(problem('mismatch_policy_invalid', '不匹配处理策略无效', path))
        }
        decimalOrProblem(spec['max_score'] === undefined ? '0' : spec['max_score'], `${path}.max_score`, problems, {
          allowNone: true,
        })
        const unit = spec['unit']
        if (unit !== undefined && unit !== null) {
          if (!isRecord(unit)) {
            problems.push(problem('unit_invalid', '单位规则必须是对象', path))
          } else if (unit['whitelist'] !== undefined && unit['whitelist'] !== null && !isRecord(unit['whitelist'])) {
            problems.push(problem('unit_whitelist_invalid', '单位白名单必须是对象', path))
          }
        }
      }
    }
  } else if (questionType === CONSTRUCTED_RESPONSE) {
    if (payload['rubric_required'] !== true) {
      problems.push(problem('rubric_required', '大题必须声明需要 rubric 逐评分点确认', 'answer_payload'))
    }
  }

  return problems
}

/**
 * `sum_blank_scores` — the total configured blank score, or `null` when any blank declares
 * something that is not a decimal.
 *
 * This is what makes a fill-blank question's declared per-blank scores agree with the question's
 * max score before publication. A blank without `max_score` contributes nothing (the grader falls
 * back to the question score), while a *malformed* one makes the whole sum unknowable — returning
 * `null` rather than skipping it is what stops a typo from silently changing the denominator.
 */
export function sumBlankScores(payload: unknown): Decimal | null {
  const record = isRecord(payload) ? payload : null
  const blanks = record?.['blanks']
  if (!isRecord(blanks)) return Decimal.zero()
  let total = Decimal.zero()
  for (const spec of Object.values(blanks)) {
    const raw = isRecord(spec) ? spec['max_score'] : null
    if (raw === null || raw === undefined || raw === '') continue
    try {
      total = total.add(Decimal.parse(String(raw)))
    } catch {
      return null
    }
  }
  return total
}
