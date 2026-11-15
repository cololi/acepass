/**
 * Pure variant rules — port of `backend/apps/question_bank/services/variants.py`:
 * `_answer_consistency_problems` (`:165`), `_proposed_score` (`:539`) and `_draft_payload`
 * (`:580`).
 *
 * Why these three are domain rules and not service code: they decide whether a model proposal is
 * *checkable at all*, and they run twice in Django — once when the proposal is stored and again
 * inside the publish gate (`variant_review_issues`). Keeping them pure is what lets the golden
 * vectors drive every branch without a database, and what stops the two call sites from drifting.
 *
 * The answer contract itself is not re-implemented here: `validateAnswerPayload` is the same
 * validator the publish gate and the grading path use (R-INV 3), and every problem it returns is
 * surfaced verbatim with an `answer.` code prefix, exactly like the Python function.
 */
import { Decimal, DecimalError } from '../decimal.ts'
import { validateAnswerPayload } from '../answers.ts'
import { blankIds, optionIds } from '../../ai/content.ts'
import { PROPOSE_VARIANT_PROMPT_VERSION } from '../../ai/prompts.ts'
import { normalizedForCompare, pySlice, pyStr, pyTruthy } from '../../ai/pyvalue.ts'

export const BLOCKING = 'blocking'
export const WARNING = 'warning'

/** `_problem()`: code/message/path/severity, then whatever extra facts the caller passes. */
export interface VariantProblem {
  code: string
  message: string
  path: string
  severity: string
  [key: string]: unknown
}

export function variantProblem(
  code: string,
  message: string,
  path = '',
  severity = BLOCKING,
  extra: Record<string, unknown> = {},
): VariantProblem {
  return { code, message, path, severity, ...extra }
}

/** `_blocks_text`: the plain text of a block list (text and math only, never answers). */
export function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const map = block as Record<string, unknown>
    if (map['kind'] === 'text') parts.push(pyStr(Object.hasOwn(map, 'text') ? map['text'] : ''))
    else if (map['kind'] === 'math') parts.push(`$${pyStr(Object.hasOwn(map, 'latex') ? map['latex'] : '')}$`)
  }
  return parts.filter((part) => part.length > 0).join(' ')
}

/** `_normalized_text`: `re.sub(r"[\s\W_]+", "", str(value or "")).lower()`. */
export function normalizedText(value: unknown): string {
  return normalizedForCompare(value)
}

function decimalOf(value: unknown): Decimal | null {
  try {
    return Decimal.parse(pyStr(value))
  } catch (error) {
    if (error instanceof DecimalError) return null
    throw error
  }
}

export interface AnswerConsistencyInput {
  content: Record<string, unknown>
  answerPayload: Record<string, unknown>
  questionType: string
  rubricCriteria: unknown
  statedRubricTotal: unknown
}

/**
 * The answer must be checkable against the variant's own content.
 *
 * Two facts the shared contract cannot know are added: every fill-blank answer needs a real
 * accepted value, and a constructed response's rubric must sum to the total the proposal states.
 */
export function answerConsistencyProblems(input: AnswerConsistencyInput): VariantProblem[] {
  const { content, answerPayload, questionType, rubricCriteria, statedRubricTotal } = input
  const problems: VariantProblem[] = []
  if (questionType === 'material') {
    return [variantProblem('variant_type_not_scorable', '共享材料不能作为变式（material 不产生可判定答案）', 'type')]
  }
  for (const problem of validateAnswerPayload(answerPayload, questionType, content)) {
    problems.push({
      ...problem,
      code: `answer.${String(problem.code ?? 'invalid')}`,
      severity: BLOCKING,
    })
  }
  if (questionType === 'single_choice' || questionType === 'multiple_choice') {
    const existing = new Set(optionIds(content).map((id) => pyStr(id)))
    if (questionType === 'single_choice') {
      const correct = answerPayload['correct_option_id']
      if (typeof correct === 'string' && correct !== '' && existing.size > 0 && !existing.has(correct)) {
        problems.push(
          variantProblem(
            'answer.correct_option_not_in_options',
            `正确选项 ${correct} 不在变式选项中`,
            'answer_payload.correct_option_id',
          ),
        )
      }
    } else {
      for (const optionId of (answerPayload['correct_option_ids'] ?? []) as unknown[]) {
        if (existing.size > 0 && !existing.has(pyStr(optionId))) {
          problems.push(
            variantProblem(
              'answer.correct_option_not_in_options',
              `正确选项 ${pyStr(optionId)} 不在变式选项中`,
              'answer_payload.correct_option_ids',
            ),
          )
        }
      }
    }
  }
  if (questionType === 'fill_blank') {
    const defined = new Set(blankIds(content).map((id) => pyStr(id)))
    const rawAnswers = answerPayload['blanks']
    const answers =
      rawAnswers !== null && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
        ? (rawAnswers as Record<string, unknown>)
        : {}
    for (const [blankId, spec] of Object.entries(answers)) {
      if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue
      const accepted = Array.isArray((spec as Record<string, unknown>)['accepted_values'])
        ? ((spec as Record<string, unknown>)['accepted_values'] as unknown[])
        : []
      const usable = accepted.filter((value) => typeof value === 'string' && pyTruthy((value as string).trim()))
      if (usable.length === 0) {
        problems.push(
          variantProblem(
            'answer.blank_accepted_values_missing',
            `空位 ${blankId} 没有可接受答案，无法判定对错`,
            `answer_payload.blanks.${blankId}`,
          ),
        )
      }
    }
    const answered = new Set(Object.keys(answers))
    // Python iterates a `set` difference here; the insertion order of `defined` is the
    // deterministic superset of that (see 04 §M). Only one missing blank is used in vectors.
    for (const blankId of defined) {
      if (!answered.has(blankId)) {
        problems.push(variantProblem('answer.blank_answer_missing', `空位 ${blankId} 没有答案`, 'answer_payload.blanks'))
      }
    }
  }
  if (questionType === 'constructed_response') {
    const criteria = Array.isArray(rubricCriteria) ? rubricCriteria : []
    let total = Decimal.zero()
    let computed = true
    for (const criterion of criteria) {
      if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion)) {
        computed = false
        continue
      }
      const score = decimalOf((criterion as Record<string, unknown>)['max_score'])
      if (score === null) computed = false
      else total = total.add(score)
    }
    if (statedRubricTotal === null || statedRubricTotal === undefined || statedRubricTotal === '') {
      problems.push(
        variantProblem('answer.rubric_total_missing', '大题没有给出 rubric 总分，无法核对', 'rubric_total_score'),
      )
    } else if (computed) {
      const stated = decimalOf(statedRubricTotal)
      if (stated === null) {
        problems.push(variantProblem('answer.rubric_total_invalid', 'rubric 总分不是十进制数', 'rubric_total_score'))
      } else if (!stated.eq(total)) {
        problems.push(
          variantProblem(
            'answer.rubric_total_mismatch',
            `评分点合计 ${total.toString()} 与声明的总分 ${stated.toString()} 不一致：无法按点判分`,
            'rubric_total_score',
          ),
        )
      }
    }
  }
  return problems
}

export interface ProposedScoreInput {
  clean: Record<string, unknown>
  questionType: string
  content: Record<string, unknown>
  answerPayload: Record<string, unknown>
}

/**
 * The score the candidate proposes, so publishing does not guess one.
 *
 * A constructed response is worth the sum of its validated rubric criteria, and a fill blank is
 * worth the sum of its blank scores when the model declared them.
 */
export function proposedScore(input: ProposedScoreInput): string | null {
  const { clean, questionType, content, answerPayload } = input
  if (questionType === 'constructed_response') {
    const rows = Array.isArray(clean['rubric_criteria']) ? (clean['rubric_criteria'] as unknown[]) : []
    let total = Decimal.zero()
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const score = decimalOf((row as Record<string, unknown>)['max_score'])
      if (score === null) continue
      total = total.add(score)
    }
    if (total.gt(Decimal.zero())) return total.toString()
    const stated = clean['rubric_total_score']
    return stated === null || stated === undefined || stated === '' ? null : pyStr(stated)
  }
  const declaredScore = clean['practice_max_score']
  if (declaredScore !== null && declaredScore !== undefined && declaredScore !== '') {
    return pyStr(declaredScore)
  }
  if (questionType === 'fill_blank') {
    const blankTotal = sumBlankScoresOf(answerPayload)
    if (blankTotal !== null && !blankTotal.eq(Decimal.zero())) return blankTotal.toString()
    const blanks = Array.isArray(content['blanks']) ? (content['blanks'] as unknown[]) : []
    const declared = blanks
      .filter(
        (blank): blank is Record<string, unknown> =>
          blank !== null &&
          typeof blank === 'object' &&
          !Array.isArray(blank) &&
          (blank as Record<string, unknown>)['max_score'] !== null &&
          (blank as Record<string, unknown>)['max_score'] !== undefined &&
          (blank as Record<string, unknown>)['max_score'] !== '',
      )
      .map((blank) => blank['max_score'])
    if (declared.length > 0 && declared.length === blanks.length) {
      let total = Decimal.zero()
      for (const value of declared) {
        const score = decimalOf(value)
        if (score === null) return null
        total = total.add(score)
      }
      return total.gt(Decimal.zero()) ? total.toString() : null
    }
  }
  return null
}

/** `apps.common.answers.sum_blank_scores`, imported lazily to keep the argument shapes explicit. */
function sumBlankScoresOf(payload: Record<string, unknown>): Decimal | null {
  const blanks = payload['blanks']
  if (blanks === null || typeof blanks !== 'object' || Array.isArray(blanks)) return Decimal.zero()
  let total = Decimal.zero()
  for (const spec of Object.values(blanks as Record<string, unknown>)) {
    const raw = spec !== null && typeof spec === 'object' && !Array.isArray(spec) ? (spec as Record<string, unknown>)['max_score'] : null
    if (raw === null || raw === undefined || raw === '') continue
    const score = decimalOf(raw)
    if (score === null) return null
    total = total.add(score)
  }
  return total
}

export interface VariantSourceFacts {
  questionId: string
  questionType: string
  displayLabel: string
  versionId: string
}

export interface VariantDraftInput {
  clean: Record<string, unknown>
  sourceVersion: VariantSourceFacts
  nodeId: string | null
  digest: string
  runId: string
}

/**
 * `_draft_payload`: the candidate a human will proofread.
 *
 * The model's answer is a *proposal*, never a key: `answer_status_known` is always false, so the
 * ordinary human confirmation is still required before publication.
 */
export function variantDraftPayload(input: VariantDraftInput): Record<string, unknown> {
  const { clean, sourceVersion, nodeId, digest, runId } = input
  const questionType = pyTruthy(clean['question_type']) ? clean['question_type'] : sourceVersion.questionType
  const content = isRecord(clean['content']) ? clean['content'] : {}
  const answerPayload = isRecord(clean['answer_payload']) ? clean['answer_payload'] : {}
  const label = pyTruthy(sourceVersion.displayLabel)
    ? pyStr(sourceVersion.displayLabel)
    : pySlice(sourceVersion.questionId, 8)
  return {
    question_type: questionType,
    content,
    answer_payload: answerPayload,
    // `clean.get("rubric_criteria") or []`: a truthy non-list is kept as-is, exactly like Python.
    rubric_criteria: pyTruthy(clean['rubric_criteria']) ? clean['rubric_criteria'] : [],
    rubric_total_score: clean['rubric_total_score'] ?? null,
    practice_max_score: proposedScore({
      clean,
      questionType: pyStr(questionType),
      content,
      answerPayload,
    }),
    answer_status_known: false,
    answer_source_type: 'ai_derived',
    answer_verification: {
      source_type: 'ai_derived',
      verification_status: 'pending',
      requires_human_confirmation: true,
      note: 'AI 推导答案：发布前必须由人工核对并确认（answer_status_known=true）',
    },
    display_label: pySlice(`AI变式·${label}`, 200),
    variant_of_question_id: sourceVersion.questionId,
    variant_of_version_id: sourceVersion.versionId,
    variant_node_id: nodeId ?? '',
    variant_content_digest: digest,
    variant_prompt_version: PROPOSE_VARIANT_PROMPT_VERSION,
    variant_llm_run_id: runId,
    difficulty_note: pyTruthy(clean['difficulty_note']) ? clean['difficulty_note'] : '',
    rationale: pyTruthy(clean['rationale']) ? clean['rationale'] : '',
    doubts: pyTruthy(clean['doubts']) ? clean['doubts'] : [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
