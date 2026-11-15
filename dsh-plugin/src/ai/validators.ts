/**
 * The seven output validators, ported from `backend/ai/prompts/registry.py`.
 *
 * Contract: a validator never trusts the model, never fills in missing facts and never produces a
 * number a human would mistake for a confirmed one. The two outputs are always
 * `[clean, problems]`:
 *  - `clean` is what may be stored as a *candidate* (never a formal score, mastery state, plan or
 *    statistic — see `outcome.ts`);
 *  - `problems` is the list the `llm_run.validation_result` row records. Some problems still leave a
 *    usable candidate (`score_over_cap` truncates, `cause_without_evidence` downgrades to `unknown`,
 *    `unknown_tag_name` drops the proposal), so callers must use the disposition table rather than
 *    "any problem means reject".
 *
 * Numeric formatting follows Python: scores go through `str(Decimal(str(value)))` because that string
 * is stored, and a `2.0`/`2` difference is visible in the audit row.
 */
import { Decimal, DecimalError } from '../domain/decimal.ts'
import { blankIds, SCORABLE_LEAF_TYPES, validateContent, type ContentIssue } from './content.ts'
import { DIAGNOSIS_ERROR_TYPES, blocksText } from './prompts.ts'
import {
  isPyNumber, normalizedForCompare, plain, pyClampUnit, pyFloat, pyIterOrEmpty, pyLen, pyOr, pyRepr,
  pySlice, pyStr, pyStrip, pyTruthy, PyTypeError, PyValueError,
} from './pyvalue.ts'

export interface ValidationProblem {
  code: string
  message: string
  index?: number
  path?: string
  severity?: string
}

export type ValidationResult<TClean> = readonly [clean: TClean, problems: ValidationProblem[]]

const NOT_OBJECT: ValidationProblem = { code: 'not_object', message: '模型输出不是对象' }

type Map = Readonly<Record<string, unknown>>

const asRecord = (value: unknown): Map | null =>
  // `PyNumber` is a wrapper object, not a JSON object; Python would see a number here.
  value !== null && typeof value === 'object' && !Array.isArray(value) && !isPyNumber(value) ? (value as Map) : null

const fieldOf = (map: Map, key: string, fallback: unknown = null): unknown =>
  Object.hasOwn(map, key) ? map[key] : fallback

/** `[str(item)[:limit] for item in (value or [])][:cap]` */
function stringList(value: unknown, limit: number, cap: number, nonEmpty = false): string[] {
  const rows: string[] = []
  for (const item of pyIterOrEmpty(value)) {
    const text = pyStr(item)
    if (nonEmpty && pyStrip(text) === '') continue
    rows.push(pySlice(text, limit))
  }
  return rows.slice(0, cap)
}

function confidenceOf(value: unknown): number | null {
  if (value === null || value === undefined) return null
  try {
    return pyClampUnit(pyFloat(value))
  } catch (error) {
    if (error instanceof PyTypeError || error instanceof PyValueError) return null
    throw error
  }
}

/* ------------------------------------------------------------------ extract */

export interface ExtractClean {
  question_type: string
  display_label: string
  content: Map
  answer_payload: unknown
  answer_status_known: boolean
  source_hint: unknown
  doubts: string[]
}

export function validateExtractPayload(
  payload: unknown,
  options: { allowed_asset_ids?: ReadonlySet<string> | null } = {},
): ValidationResult<ExtractClean | Record<string, never>> {
  const map = asRecord(payload)
  if (map === null) return [{}, [NOT_OBJECT]]
  const problems: ValidationProblem[] = []
  let questionType = fieldOf(map, 'question_type')
  if (typeof questionType !== 'string' || !['single_choice', 'multiple_choice', 'true_false', 'fill_blank', 'constructed_response', 'material'].includes(questionType)) {
    problems.push({ code: 'unknown_type', message: `模型给出的题型无效：${pyRepr(questionType)}` })
    questionType = 'single_choice'
  }
  const contentMap = asRecord(fieldOf(map, 'content'))
  const content = contentMap ?? {}
  for (const problem of validateContent(content, questionType as string)) {
    // The shared content contract's problems are flattened to code/message; the path is dropped
    // here and only the prefixed code reaches the run row, exactly like the Python extractor.
    problems.push({ code: `content.${problem.code}`, message: problem.message })
  }
  const allowedAssetIds = options.allowed_asset_ids ?? null
  if (allowedAssetIds !== null) {
    for (const block of pyIterOrEmpty(fieldOf(content, 'blocks'))) {
      const item = asRecord(block)
      if (item === null || fieldOf(item, 'kind') !== 'image' || !pyTruthy(fieldOf(item, 'asset_id'))) continue
      if (!allowedAssetIds.has(pyStr(fieldOf(item, 'asset_id')))) {
        problems.push({ code: 'unknown_asset', message: '输出引用了本次输入之外的图片资产' })
      }
    }
  }
  const answerPayload = asRecord(fieldOf(map, 'answer_payload')) ?? {}
  const answerKnown = pyTruthy(fieldOf(map, 'answer_status_known'))
  if (answerKnown && Object.keys(answerPayload).length === 0) {
    problems.push({ code: 'answer_claimed_but_empty', message: '声称有答案但未给出答案内容' })
  }
  const sourceHint = asRecord(fieldOf(map, 'source_hint'))
  const clean: ExtractClean = {
    question_type: questionType as string,
    display_label: pySlice(pyStr(pyOr(fieldOf(map, 'display_label'), '')), 200),
    // `content` is the raw object: Python stores it as-is so a reviewer sees exactly what the model
    // returned. `plain()` only unwraps this port's numeric-lexeme wrappers.
    content: plain(content) as Map,
    answer_payload: plain(answerPayload),
    answer_status_known: answerKnown,
    source_hint: sourceHint === null ? {} : plain(sourceHint),
    doubts: stringList(fieldOf(map, 'doubts'), 300, 20),
  }
  return [clean, problems]
}

/* ------------------------------------------------------------------ explain */

export interface ExplainClean {
  key_conditions: string[]
  stuck_points: string[]
  explanation_blocks: { kind: string; items?: string[]; text?: string; latex?: string }[]
  method_summary: string
  suggested_next: string[]
  missing_information: string[]
  citations: string[]
}

const EXPLAIN_BLOCK_KINDS = new Set(['text', 'math', 'list'])

export function validateExplainPayload(
  payload: unknown,
  options: { allowed_citation_ids: ReadonlySet<string> },
): ValidationResult<ExplainClean | Record<string, never>> {
  const map = asRecord(payload)
  if (map === null) return [{}, [NOT_OBJECT]]
  const problems: ValidationProblem[] = []
  const blocks: ExplainClean['explanation_blocks'] = []
  const rawBlocks = pyIterOrEmpty(fieldOf(map, 'explanation_blocks'))
  rawBlocks.forEach((block, index) => {
    const item = asRecord(block)
    if (item === null) {
      problems.push({ code: 'block_not_object', message: '讲解块必须是对象', index })
      return
    }
    const kind = fieldOf(item, 'kind', 'text')
    if (typeof kind !== 'string' || !EXPLAIN_BLOCK_KINDS.has(kind)) {
      problems.push({ code: 'unsupported_block', message: `不支持的讲解块类型：${pyStr(kind)}`, index })
      return
    }
    if (kind === 'list') {
      // Whitespace-only items are dropped, other items are stringified (Python `str(item)`).
      const items = stringList(fieldOf(item, 'items'), 500, Number.POSITIVE_INFINITY, true)
      blocks.push({ kind: 'list', items })
      return
    }
    const key = kind === 'text' ? 'text' : 'latex'
    // `.get(key, "")`: a present `null` becomes the string "None", not "".
    const value = pyStr(fieldOf(item, key, ''))
    if (pyStrip(value) === '') {
      problems.push({ code: 'empty_block', message: '讲解块内容为空', index })
      return
    }
    blocks.push({ kind, [key]: pySlice(value, 4000) })
  })
  const citations: string[] = []
  for (const citation of pyIterOrEmpty(fieldOf(map, 'citations'))) {
    const value = pyStr(citation)
    if (!options.allowed_citation_ids.has(value)) {
      problems.push({ code: 'unknown_citation', message: `引用了本次检索范围外的来源：${value}` })
      continue
    }
    citations.push(value)
  }
  const clean: ExplainClean = {
    key_conditions: stringList(fieldOf(map, 'key_conditions'), 300, 20),
    stuck_points: stringList(fieldOf(map, 'stuck_points'), 300, 20),
    explanation_blocks: blocks,
    method_summary: pySlice(pyStr(pyOr(fieldOf(map, 'method_summary'), '')), 2000),
    suggested_next: stringList(fieldOf(map, 'suggested_next'), 300, 20),
    missing_information: stringList(fieldOf(map, 'missing_information'), 300, 20),
    citations,
  }
  if (blocks.length === 0 && clean.key_conditions.length === 0) {
    problems.push({ code: 'empty_explanation', message: '模型没有给出任何可用讲解内容' })
  }
  return [clean, problems]
}

/* ------------------------------------------------------------------ tags */

export interface TagSuggestion {
  name: string
  confidence: number
  rationale: string
}

export function validateTagSuggestions(
  payload: unknown,
  options: { allowed_node_names: ReadonlySet<string> },
): ValidationResult<TagSuggestion[]> {
  const map = asRecord(payload)
  if (map === null) return [[], [NOT_OBJECT]]
  const problems: ValidationProblem[] = []
  const clean: TagSuggestion[] = []
  const seen = new Set<string>()
  pyIterOrEmpty(fieldOf(map, 'tags')).forEach((entry, index) => {
    const item = asRecord(entry)
    if (item === null) {
      problems.push({ code: 'tag_not_object', message: '标签必须是对象', index })
      return
    }
    const name = pyStrip(pyStr(pyOr(fieldOf(item, 'name'), '')))
    if (name === '') {
      problems.push({ code: 'empty_tag_name', message: '标签名称为空', index })
      return
    }
    if (!options.allowed_node_names.has(name)) {
      problems.push({ code: 'unknown_tag_name', message: `建议的考点不在当前大纲中：${name}`, index })
      return
    }
    if (seen.has(name)) return
    seen.add(name)
    // `float(item.get("confidence", 0.0))`: a non-numeric confidence becomes 0.0 silently.
    let confidence = 0
    try {
      confidence = pyFloat(fieldOf(item, 'confidence', 0.0))
    } catch (error) {
      if (!(error instanceof PyTypeError || error instanceof PyValueError)) throw error
      confidence = 0
    }
    clean.push({
      name,
      confidence: pyClampUnit(confidence),
      rationale: pySlice(pyStr(pyOr(fieldOf(item, 'rationale'), '')), 200),
    })
  })
  return [clean, problems]
}

/* ------------------------------------------------------------------ transcription */

export interface TranscriptionClean {
  text: string
  confidence: number | null
  doubts: string[]
  illegible: boolean
}

export function validateTranscription(payload: unknown): ValidationResult<TranscriptionClean> {
  const map = asRecord(payload)
  if (map === null) {
    return [{ text: '', confidence: null, doubts: [], illegible: true }, [NOT_OBJECT]]
  }
  const problems: ValidationProblem[] = []
  const text = pySlice(pyStrip(pyStr(pyOr(fieldOf(map, 'text'), ''))), 8000)
  const doubts = stringList(fieldOf(map, 'doubts'), 200, 20, true)
  let confidence: number | null = null
  if (fieldOf(map, 'confidence') !== null) {
    try {
      confidence = pyClampUnit(pyFloat(fieldOf(map, 'confidence')))
    } catch (error) {
      if (!(error instanceof PyTypeError || error instanceof PyValueError)) throw error
      confidence = null
      problems.push({ code: 'bad_confidence', message: 'confidence 不是数字，已忽略' })
    }
  }
  const illegible = pyTruthy(fieldOf(map, 'illegible')) || text === ''
  if (illegible && doubts.length === 0) doubts.push('模型认为照片无法辨认')
  if (text === '') problems.push({ code: 'empty_transcription', message: '模型没有读出任何文字' })
  return [{ text, confidence, doubts, illegible }, problems]
}

/* ------------------------------------------------------------------ estimate */

export interface RubricCriterionInput {
  criterion_id: unknown
  max_score: unknown
  description?: unknown
}

export interface EstimateRow {
  criterion_id: string
  estimated_score: string
  rationale: string
  missing_evidence: string[]
}

export interface EstimateClean {
  criteria: EstimateRow[]
  overall_note: string
  confidence: number | null
}

export function validateEstimate(
  payload: unknown,
  options: { criteria: readonly RubricCriterionInput[] },
): ValidationResult<EstimateClean> {
  const map = asRecord(payload)
  if (map === null) return [{ criteria: [], overall_note: '', confidence: null }, [NOT_OBJECT]]
  const problems: ValidationProblem[] = []
  const allowed = new Map<string, RubricCriterionInput>()
  for (const criterion of options.criteria) allowed.set(pyStr(criterion.criterion_id), criterion)
  const rows: EstimateRow[] = []
  const seen = new Set<string>()
  pyIterOrEmpty(fieldOf(map, 'criteria')).forEach((entry, index) => {
    const item = asRecord(entry)
    if (item === null) {
      problems.push({ code: 'criterion_not_object', message: '评分点必须是对象', index })
      return
    }
    const criterionId = pyStr(pyOr(fieldOf(item, 'criterion_id'), ''))
    const criterion = allowed.get(criterionId)
    if (criterion === undefined) {
      problems.push({ code: 'unknown_criterion', message: `估计引用了不存在的评分点：${criterionId}`, index })
      return
    }
    if (seen.has(criterionId)) return
    seen.add(criterionId)
    let score: Decimal
    try {
      score = Decimal.parse(pyStr(fieldOf(item, 'estimated_score', 0)))
    } catch (error) {
      if (!(error instanceof DecimalError)) throw error
      problems.push({ code: 'bad_score', message: '估计分数不是数字', index })
      return
    }
    const cap = Decimal.parse(pyStr(fieldOf(criterion as unknown as Record<string, unknown>, 'max_score', 0)))
    if (score.lt(Decimal.zero())) {
      problems.push({ code: 'negative_score', message: '估计分数为负', index })
      return
    }
    if (score.gt(cap)) {
      problems.push({
        code: 'score_over_cap',
        message: `估计分数超过该评分点满分（${score.toString()} > ${cap.toString()}），已按满分截断`,
        index,
      })
      score = cap
    }
    rows.push({
      criterion_id: criterionId,
      estimated_score: score.toString(),
      rationale: pySlice(pyStr(pyOr(fieldOf(item, 'rationale'), '')), 500),
      missing_evidence: stringList(fieldOf(item, 'missing_evidence'), 200, 20),
    })
  })
  if (rows.length === 0) problems.push({ code: 'empty_estimate', message: '模型没有给出任何可用的评分点估计' })
  const clean: EstimateClean = {
    criteria: rows,
    overall_note: pySlice(pyStr(pyOr(fieldOf(map, 'overall_note'), '')), 1000),
    confidence: confidenceOf(fieldOf(map, 'confidence')),
  }
  return [clean, problems]
}

/* ------------------------------------------------------------------ diagnosis */

export interface DiagnosisCause {
  error_type: string
  confidence: number
  evidence: string[]
}

export interface FollowUpQuestion {
  question: string
  why: string
  evidence_kind: string
}

export interface DiagnosisClean {
  causes: DiagnosisCause[]
  follow_up_questions: FollowUpQuestion[]
  missing_information: string[]
}

export function validateDiagnosis(payload: unknown): ValidationResult<DiagnosisClean> {
  const map = asRecord(payload)
  if (map === null) {
    return [{ causes: [], follow_up_questions: [], missing_information: [] }, [NOT_OBJECT]]
  }
  const problems: ValidationProblem[] = []
  const causes: DiagnosisCause[] = []
  const seen = new Set<string>()
  pyIterOrEmpty(fieldOf(map, 'causes')).forEach((entry, index) => {
    const item = asRecord(entry)
    if (item === null) {
      problems.push({ code: 'cause_not_object', message: '原因必须是对象', index })
      return
    }
    let errorType = pyStrip(pyStr(pyOr(fieldOf(item, 'error_type'), '')))
    if (!(DIAGNOSIS_ERROR_TYPES as readonly string[]).includes(errorType)) {
      problems.push({ code: 'unknown_error_type', message: `原因类型不在受控词表中：${errorType}`, index })
      return
    }
    const evidence = stringList(fieldOf(item, 'evidence'), 300, 10, true)
    if (errorType !== 'unknown' && evidence.length === 0) {
      // A cause without evidence is not deleted: it is demoted, so the audit shows that the model
      // claimed something it could not support. The demoted row still occupies the dedupe slot.
      problems.push({ code: 'cause_without_evidence', message: `原因 ${errorType} 没有证据，已降级为 unknown`, index })
      errorType = 'unknown'
    }
    if (seen.has(errorType)) return
    seen.add(errorType)
    let confidence = 0
    try {
      confidence = pyFloat(fieldOf(item, 'confidence', 0.0))
    } catch (error) {
      if (!(error instanceof PyTypeError || error instanceof PyValueError)) throw error
      confidence = 0
    }
    causes.push({ error_type: errorType, confidence: pyClampUnit(confidence), evidence })
  })
  const questions: FollowUpQuestion[] = []
  pyIterOrEmpty(fieldOf(map, 'follow_up_questions')).forEach((entry, index) => {
    const item = asRecord(entry)
    if (item !== null) {
      const question = pyStrip(pyStr(pyOr(fieldOf(item, 'question'), '')))
      if (question === '') return
      questions.push({
        question: pySlice(question, 500),
        why: pySlice(pyStr(pyOr(fieldOf(item, 'why'), '')), 300),
        evidence_kind: pySlice(pyStr(pyOr(fieldOf(item, 'evidence_kind'), '')), 60),
      })
    } else if (pyStrip(pyStr(entry)) !== '') {
      questions.push({ question: pySlice(pyStr(entry), 500), why: '', evidence_kind: '' })
    } else {
      problems.push({ code: 'empty_question', message: '追问问题为空', index })
    }
  })
  const clean: DiagnosisClean = {
    causes,
    follow_up_questions: questions.slice(0, 10),
    missing_information: stringList(fieldOf(map, 'missing_information'), 300, 20),
  }
  return [clean, problems]
}

/* ------------------------------------------------------------------ variant */

export interface VariantRubricRow {
  criterion_id: string
  text: string
  max_score: string
  required: boolean
}

export interface VariantClean {
  question_type: string
  content: unknown
  answer_payload: unknown
  rubric_criteria: VariantRubricRow[]
  rubric_total_score: string | null
  practice_max_score: string | null
  difficulty_note: string
  rationale: string
  doubts: string[]
}

function variantProblem(code: string, message: string, path = '', severity = 'blocking'): ValidationProblem {
  return { code, message, path, severity }
}

/** `_VARIANT_ANSWER_MARKERS`: phrases that state the answer outright. */
export const VARIANT_ANSWER_MARKERS = [
  '正确答案是',
  '正确答案为',
  '正确答案：',
  '答案是',
  '答案为',
  '答案：',
  '故答案为',
  '应选',
  '故选',
  'answer is',
  'correct answer',
] as const

/** Shortest normalized option text that counts as "the stem quotes the correct option". */
export const VARIANT_OPTION_LEAK_MIN_LENGTH = 8
/** Block kinds a generated variant may never carry. */
export const VARIANT_FORBIDDEN_BLOCK_KINDS = ['image'] as const

function decimalOf(value: unknown): Decimal | null {
  try {
    return Decimal.parse(pyStr(value))
  } catch (error) {
    if (!(error instanceof DecimalError)) throw error
    return null
  }
}

function appendOptionLeak(
  optionId: string,
  option: Map,
  stem: string,
  problems: ValidationProblem[],
): void {
  const text = normalizedForCompare(blocksText(fieldOf(option, 'blocks', null)))
  // `len()` is code points; an option of eight emoji must not pass the threshold by UTF-16 units.
  if (pyLen(text) >= VARIANT_OPTION_LEAK_MIN_LENGTH && stem.includes(text)) {
    problems.push(variantProblem('stem_leaks_answer', `题干逐字包含正确选项 ${optionId} 的文本：答案不能出现在题干里`, 'content.blocks'))
  }
}

export interface VariantValidationOptions {
  question_type: string
  avoid_stems?: Iterable<unknown>
}

export function validateVariantPayload(
  payload: unknown,
  options: VariantValidationOptions,
): ValidationResult<VariantClean | Record<string, never>> {
  const questionType = options.question_type
  if (!SCORABLE_LEAF_TYPES.includes(questionType as never)) {
    // Checked before the object check, exactly like Python: the problem is about the request, not
    // about what the model returned.
    return [{}, [variantProblem('variant_type_not_scorable', `变式只允许五种可计分题型（不含 material），收到：${pyRepr(questionType)}`, 'question_type')]]
  }
  const map = asRecord(payload)
  if (map === null) return [{}, [variantProblem('not_object', '模型输出不是对象（只能是 JSON 对象）', 'payload')]]
  const problems: ValidationProblem[] = []
  const declared = fieldOf(map, 'question_type')
  if (declared !== questionType) {
    problems.push(variantProblem('variant_type_mismatch', `模型输出的题型 ${pyRepr(declared)} 与要求的 ${pyRepr(questionType)} 不一致`, 'question_type'))
  }
  const rawContent = fieldOf(map, 'content')
  const contentMap = asRecord(rawContent)
  const content = contentMap ?? {}
  if (contentMap === null) problems.push(variantProblem('content_not_object', '变式缺少 content 对象', 'content'))
  // The shared content contract decides what "structurally publishable" means; its problems are
  // appended untouched so the code/message/path a human sees matches the publish gate verbatim.
  for (const problem of validateContent(content, questionType as string)) {
    problems.push(contentProblemToVariant(problem))
  }
  pyIterOrEmpty(fieldOf(content, 'blocks')).forEach((block, index) => {
    const item = asRecord(block)
    if (item === null) return
    const kind = fieldOf(item, 'kind')
    if (typeof kind === 'string' && (VARIANT_FORBIDDEN_BLOCK_KINDS as readonly string[]).includes(kind)) {
      problems.push(variantProblem('variant_assets_not_allowed', `变式题干不能包含 ${pyStr(kind)} 块：模型无法知道本项目的真实资产，图片必须由人工在校对时补上`, `blocks[${index}]`))
    }
  })

  const rawAnswer = fieldOf(map, 'answer_payload')
  const answerRecord = asRecord(rawAnswer)
  let answer: Map = answerRecord ?? {}
  if (answerRecord === null || Object.keys(answerRecord).length === 0) {
    problems.push(variantProblem('variant_answer_missing', '模型没有给出答案：缺少答案的候选不能发布，必须人工补齐并确认', 'answer_payload'))
    answer = answerRecord ?? {}
  } else if (fieldOf(answerRecord, 'kind') !== questionType) {
    problems.push(variantProblem('variant_answer_kind_mismatch', `answer_payload.kind=${pyRepr(fieldOf(answerRecord, 'kind'))} 必须等于题型 ${pyRepr(questionType)}`, 'answer_payload.kind'))
  }

  const optionMap = new Map<string, Map>()
  for (const option of pyIterOrEmpty(fieldOf(content, 'options'))) {
    const item = asRecord(option)
    if (item === null || !pyTruthy(fieldOf(item, 'id'))) continue
    optionMap.set(pyStr(fieldOf(item, 'id')), item)
  }
  const rubricRows: VariantRubricRow[] = []
  let rubricTotal = Decimal.zero()
  let statedTotal: Decimal | null = null
  const stem = normalizedForCompare(blocksText(fieldOf(content, 'blocks', null)))
  for (const avoid of options.avoid_stems ?? []) {
    const avoidText = normalizedForCompare(avoid)
    if (stem !== '' && avoidText !== '' && stem === avoidText) {
      problems.push(variantProblem('stem_copies_source', '变式题干与必须避免的题干完全相同：这不是变式，请改写题干', 'content.blocks'))
      break
    }
  }
  for (const marker of VARIANT_ANSWER_MARKERS) {
    if (stem.includes(normalizedForCompare(marker))) {
      problems.push(variantProblem('stem_leaks_answer', `题干疑似直接写出答案（命中“${marker}”）：答案必须能从条件推出，不能写在题干里`, 'content.blocks'))
      break
    }
  }

  if (questionType === 'single_choice') {
    const listed = fieldOf(answer, 'correct_option_ids')
    if (Array.isArray(listed) && listed.length > 0) {
      problems.push(variantProblem('single_choice_multiple_correct', `单选题只能有一个正确选项，模型给出 ${listed.length} 个：${pyStr(listed)}`, 'answer_payload.correct_option_ids'))
    }
    const correct = fieldOf(answer, 'correct_option_id')
    if (typeof correct !== 'string' || pyStrip(correct) === '') {
      problems.push(variantProblem('single_choice_correct_missing', '单选题必须给出唯一的正确选项 ID', 'answer_payload.correct_option_id'))
    } else if (!optionMap.has(correct)) {
      problems.push(variantProblem('single_choice_correct_unknown', `正确选项 ${correct} 不在变式给定的选项中`, 'answer_payload.correct_option_id'))
    } else {
      appendOptionLeak(correct, optionMap.get(correct) as Map, stem, problems)
    }
  } else if (questionType === 'multiple_choice') {
    const correct = fieldOf(answer, 'correct_option_ids')
    if (!Array.isArray(correct) || correct.length === 0) {
      problems.push(variantProblem('multiple_choice_correct_missing', '多选题必须给出非空的正确选项集合', 'answer_payload.correct_option_ids'))
    } else {
      const optionIds = correct.map((value) => pyStr(value))
      const distinct = new Set(optionIds)
      if (distinct.size !== optionIds.length) {
        problems.push(variantProblem('multiple_choice_duplicate_correct', '多选题的正确选项集合存在重复 ID', 'answer_payload.correct_option_ids'))
      }
      if (distinct.size < 2) {
        problems.push(variantProblem('multiple_choice_too_few_correct', `多选题至少要有两个正确选项，模型给出 ${distinct.size} 个`, 'answer_payload.correct_option_ids'))
      }
      for (const optionId of optionIds) {
        const option = optionMap.get(optionId)
        if (option === undefined) {
          problems.push(variantProblem('multiple_choice_unknown_correct', `正确选项 ${optionId} 不在变式给定的选项中`, 'answer_payload.correct_option_ids'))
        } else {
          appendOptionLeak(optionId, option, stem, problems)
        }
      }
    }
  } else if (questionType === 'true_false') {
    if (typeof fieldOf(answer, 'value') !== 'boolean') {
      problems.push(variantProblem('true_false_value_missing', '判断题必须给出真正的布尔值（字符串 "true" 不等于布尔 true）', 'answer_payload.value'))
    }
  } else if (questionType === 'fill_blank') {
    const definedBlanks = blankIds(content)
    if (definedBlanks.length === 0) {
      problems.push(variantProblem('fill_blank_without_blanks', '填空题的 content 必须定义至少一个空位', 'content.blanks'))
    }
    const answers = fieldOf(answer, 'blanks')
    if (asRecord(answers) === null || Object.keys(answers as Map).length === 0) {
      problems.push(variantProblem('fill_blank_answer_missing', '填空题必须按空位给出答案', 'answer_payload.blanks'))
    } else {
      const answerMap = answers as Map
      // A non-string blank id can never equal a JSON object key; Python's dict lookup says the same,
      // and its `", ".join(missing)` would then crash. Stringifying only affects that crash path.
      const missing = definedBlanks.filter((blankId) => typeof blankId !== 'string' || !Object.hasOwn(answerMap, blankId))
      const unknown = Object.keys(answerMap).filter((blankId) => !definedBlanks.some((defined) => defined === blankId))
      if (missing.length > 0) {
        problems.push(variantProblem('fill_blank_answer_missing_for', `空位没有答案：${missing.map((id) => pyStr(id)).join(', ')}`, 'answer_payload.blanks'))
      }
      if (unknown.length > 0) {
        problems.push(variantProblem('fill_blank_answer_unknown_blank', `答案引用了题干未定义的空位：${unknown.join(', ')}`, 'answer_payload.blanks'))
      }
      for (const [blankId, spec] of Object.entries(answerMap)) {
        const path = `answer_payload.blanks.${blankId}`
        const specMap = asRecord(spec)
        if (specMap === null) {
          problems.push(variantProblem('blank_answer_not_object', '空位答案必须是对象', path))
          continue
        }
        const accepted = pyIterOrEmpty(fieldOf(specMap, 'accepted_values'))
        const usable = accepted.filter((value) => typeof value === 'string' && pyStrip(value) !== '')
        if (usable.length === 0) {
          problems.push(variantProblem('blank_accepted_values_missing', `空位 ${blankId} 没有可接受答案（accepted_values 必须是非空字符串数组）`, path))
        }
      }
    }
  } else if (questionType === 'constructed_response') {
    const criteria = fieldOf(map, 'rubric_criteria')
    if (!Array.isArray(criteria) || criteria.length === 0) {
      problems.push(variantProblem('rubric_criteria_missing', '大题必须给出至少一个评分点（rubric_criteria）', 'rubric_criteria'))
    } else {
      const seen = new Set<string>()
      criteria.forEach((entry, index) => {
        const path = `rubric_criteria[${index}]`
        const criterion = asRecord(entry)
        if (criterion === null) {
          problems.push(variantProblem('rubric_criterion_not_object', '评分点必须是对象', path))
          return
        }
        const criterionId = pyStrip(pyStr(pyOr(fieldOf(criterion, 'criterion_id'), '')))
        if (criterionId === '') {
          problems.push(variantProblem('rubric_criterion_id_missing', '评分点缺少 criterion_id', path))
          return
        }
        if (seen.has(criterionId)) {
          problems.push(variantProblem('rubric_criterion_duplicate', `评分点 ID 重复：${criterionId}`, path))
          return
        }
        seen.add(criterionId)
        const score = decimalOf(fieldOf(criterion, 'max_score'))
        if (score === null) {
          problems.push(variantProblem('rubric_criterion_score_invalid', '评分点满分必须是十进制数', path))
          return
        }
        if (!score.gt(Decimal.zero())) {
          problems.push(variantProblem('rubric_criterion_score_not_positive', `评分点满分必须为正数，收到 ${score.toString()}`, path))
          return
        }
        rubricTotal = rubricTotal.add(score)
        rubricRows.push({
          criterion_id: criterionId,
          text: pySlice(pyStr(pyOr(fieldOf(criterion, 'text'), '')), 500),
          max_score: score.toString(),
          required: pyTruthy(fieldOf(criterion, 'required', true)),
        })
      })
    }
    const stated = fieldOf(map, 'rubric_total_score')
    if (stated === null || stated === undefined || stated === '') {
      problems.push(variantProblem('rubric_total_missing', '大题必须给出 rubric_total_score（各评分点之和）', 'rubric_total_score'))
    } else {
      statedTotal = decimalOf(stated)
      if (statedTotal === null) {
        problems.push(variantProblem('rubric_total_invalid', 'rubric_total_score 必须是十进制数', 'rubric_total_score'))
      } else if (!statedTotal.gt(Decimal.zero())) {
        problems.push(variantProblem('rubric_total_not_positive', `rubric_total_score 必须为正数，收到 ${statedTotal.toString()}`, 'rubric_total_score'))
      } else if (!statedTotal.eq(rubricTotal)) {
        problems.push(variantProblem('rubric_total_mismatch', `评分点合计 ${rubricTotal.toString()} 与 rubric_total_score ${statedTotal.toString()} 不一致`, 'rubric_total_score'))
      }
    }
    // Identity, not truthiness: `1` and `"true"` do not declare a rubric.
    if (fieldOf(answer, 'rubric_required') !== true) {
      problems.push(variantProblem('rubric_required_missing', '大题答案必须声明 rubric_required=true（逐评分点人工确认）', 'answer_payload.rubric_required'))
    }
  }

  let proposedScore: Decimal | null = null
  const rawScore = fieldOf(map, 'practice_max_score')
  if (rawScore !== null && rawScore !== undefined && rawScore !== '') {
    proposedScore = decimalOf(rawScore)
    if (proposedScore === null) {
      problems.push(variantProblem('variant_score_invalid', 'practice_max_score 必须是十进制数', 'practice_max_score'))
    } else if (!proposedScore.gt(Decimal.zero())) {
      problems.push(variantProblem('variant_score_not_positive', `practice_max_score 必须为正数，收到 ${proposedScore.toString()}`, 'practice_max_score'))
      proposedScore = null
    }
  }

  const clean: VariantClean = {
    question_type: questionType as string,
    // Passthrough objects are stored as the model returned them; `plain()` only unwraps the parsers'
    // numeric lexemes back into JSON numbers.
    content: plain(content),
    answer_payload: plain(answer),
    rubric_criteria: rubricRows,
    // A stated total is kept exactly as proposed; rewriting it to the computed sum would hide a
    // disagreement a human still has to resolve.
    rubric_total_score: statedTotal === null ? null : statedTotal.toString(),
    practice_max_score: proposedScore === null ? null : proposedScore.toString(),
    difficulty_note: pySlice(pyStr(pyOr(fieldOf(map, 'difficulty_note'), '')), 300),
    rationale: pySlice(pyStr(pyOr(fieldOf(map, 'rationale'), '')), 500),
    doubts: stringList(fieldOf(map, 'doubts'), 300, 20, true),
  }
  return [clean, problems]
}

function contentProblemToVariant(problem: ContentIssue): ValidationProblem {
  // `dict(problem)`: code/message/path/severity survive verbatim.
  return { code: problem.code, message: problem.message, path: problem.path, severity: problem.severity }
}
