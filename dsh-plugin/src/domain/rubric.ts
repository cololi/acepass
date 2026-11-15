/**
 * Rubric structural validation — port of `RubricVersion.clean` in
 * `backend/apps/question_bank/models.py`.
 *
 * The rubric is the scoring contract for a constructed response, so an invalid one must never reach
 * `publish_problems` as "fine". Django validates it twice: `upsert_rubric_version` calls
 * `full_clean()` (a failure is a 422 `结构校验失败` with `details.errors`), and `publish_problems`
 * re-runs it defensively (`rubric_invalid`). Both are reproduced here; the messages are the
 * zh-hans strings Django emits because they reach the reviewer unchanged.
 */
import { Decimal } from './decimal.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `str(value)` for the pieces that appear inside the messages. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/**
 * Every `criteria[i]` / `criteria` / `total_score` error, keyed the way Django's
 * `ValidationError.message_dict` is keyed.
 *
 * Note the dependency check runs *after* the score was accumulated and **overwrites** an earlier
 * message for the same criterion: that is what `errors[key] = ...` does in Python, and a port that
 * appended instead would report two problems where Django reports one.
 */
export function rubricProblems(
  criteria: unknown,
  totalScore: Decimal | string | null | undefined,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const list = Array.isArray(criteria) ? criteria : []
  const seen = new Set<string>()
  const criterionIds = new Set<string>()
  for (const criterion of list) {
    if (isRecord(criterion) && criterion['criterion_id']) criterionIds.add(pyStr(criterion['criterion_id']))
  }

  let total = Decimal.zero()
  list.forEach((criterion, index) => {
    const key = `criteria[${index}]`
    if (!isRecord(criterion)) {
      errors[key] = ['评分点必须是对象']
      return
    }
    const criterionId = pyStr(criterion['criterion_id'] ?? '')
    if (criterionId === '') {
      errors[key] = ['评分点缺少 criterion_id']
      return
    }
    if (seen.has(criterionId)) {
      errors[key] = [`评分点 ID 重复：${criterionId}`]
      return
    }
    seen.add(criterionId)
    let score: Decimal
    try {
      score = Decimal.parse(pyStr(criterion['max_score']))
    } catch {
      errors[key] = ['评分点分值必须是十进制数']
      return
    }
    if (score.isNegative()) {
      errors[key] = ['评分点分值不能为负']
      return
    }
    total = total.add(score)
    // Python iterates whatever `depends_on` holds: a list by element, a string by character, a
    // dict by key, and an empty/null value not at all. A list-only port would silently accept a
    // string that Django rejects.
    const dependencies = criterion['depends_on']
    const dependencyItems: unknown[] = Array.isArray(dependencies)
      ? dependencies
      : typeof dependencies === 'string'
        ? [...dependencies]
        : isRecord(dependencies)
          ? Object.keys(dependencies)
          : []
    for (const dependency of dependencyItems) {
      if (!criterionIds.has(pyStr(dependency))) {
        errors[key] = [`评分点依赖不存在：${pyStr(dependency)}`]
      }
    }
  })

  if (list.length === 0) errors['criteria'] = ['大题 rubric 必须至少包含一个评分点']
  if (list.length > 0) {
    const stated = totalScore === null || totalScore === undefined ? null : Decimal.parse(String(totalScore))
    if (stated !== null && !total.eq(stated)) {
      errors['total_score'] = [`评分点合计 ${total.toString()} 与 rubric 总分 ${stated.toString()} 不一致`]
    }
  }
  return errors
}
