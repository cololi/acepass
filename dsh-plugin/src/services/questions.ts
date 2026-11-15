/**
 * Question version lifecycle: the published-version immutability rule lives here.
 *
 * Port of `backend/apps/question_bank/services/core.py` (draft/publish/withdraw part).
 *
 * The invariant (R-INV 1) is "a published version is never edited in place" — but note *how* the
 * Django implementation enforces it: not with a database trigger or a model `save()` override, but
 * with `assert_draft()` at the top of the edit path. Phase 2 deliberately did not add a stronger
 * store-level constraint, because that would be a divergence from the behaviour being ported;
 * this module is that guard.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { pyJsonCanonical } from '../store/pyjson.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { validateContent } from '../ai/content.ts'
import { pyTruthy } from '../ai/pyvalue.ts'
import { sumBlankScores, validateAnswerPayload } from '../domain/answers.ts'
import { Decimal } from '../domain/decimal.ts'
import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { pyFormatFixed } from '../domain/pyfmt.ts'
import { rubricProblems } from '../domain/rubric.ts'
import { enqueue } from '../store/outbox.ts'
import { InvalidInput, ScopeViolation, StructureInvalid, VersionConflict } from './errors.ts'
import { requireProject } from './exams.ts'
import { handleAnswerDispute } from './practice.ts'
import { assertNotSealed } from './sealing.ts'

export const QUESTION_VERSION_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  WITHDRAWN: 'withdrawn',
} as const

/** Types that can carry a score; a material parent cannot. */
const SCORABLE_LEAF_TYPES: ReadonlySet<string> = new Set([
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'constructed_response',
])

const VERIFICATION_CHECKED = 'checked'

export type Problem = { code: string; message: string; path: string }

/** Canonical copy: stable key order, no unknown top-level noise. */
export function normalizeContent(content: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    blocks: (Array.isArray(content['blocks']) ? content['blocks'] : []).filter(
      (block): block is Record<string, unknown> => typeof block === 'object' && block !== null && !Array.isArray(block),
    ),
  }
  // Python truthiness: an empty `options`/`blanks` list is falsy and is therefore omitted from the
  // canonical form. `[]` is truthy in JavaScript, and keeping it would change every digest of a
  // content object that declares an empty array.
  if (pyTruthy(content['options'])) {
    normalized['options'] = (content['options'] as unknown[]).filter(
      (option): option is Record<string, unknown> =>
        typeof option === 'object' && option !== null && !Array.isArray(option),
    )
  }
  if (pyTruthy(content['blanks'])) {
    normalized['blanks'] = (content['blanks'] as unknown[]).filter(
      (blank): blank is Record<string, unknown> =>
        typeof blank === 'object' && blank !== null && !Array.isArray(blank),
    )
  }
  if (content['table_note']) normalized['table_note'] = content['table_note']
  return normalized
}

/** `OriginType.values` — only `official_past` may back a real paper occurrence. */
export const ORIGIN_TYPES = [
  'official_past',
  'licensed_bank',
  'user_authored',
  'ai_generated',
  'demo',
] as const

/** `AnswerSourceType.values`. */
export const ANSWER_SOURCE_TYPES = ['official', 'textbook_or_bank', 'user', 'ai_derived'] as const
/** `VerificationStatus.values`. */
export const VERIFICATION_STATUSES = ['pending', 'checked', 'disputed'] as const

/**
 * `create_question` — a stable question identity, not a version.
 *
 * `is_demo` defaults from the origin: demo and AI-generated content never counts towards real
 * statistics, and letting a caller pass `is_demo=false` for `ai_generated` would be the one way to
 * launder generated content into a real paper. The explicit argument exists only for fixtures.
 */
export function createQuestion(
  db: DatabaseSync,
  userId: string,
  input: {
    subjectId: string
    originType?: string
    displayLabel?: string
    isDemo?: boolean | null
    familyId?: string | null
    contentLineageId?: string | null
  },
  now: Instant,
): Record<string, unknown> {
  const origin = String(input.originType ?? 'user_authored')
  if (!(ORIGIN_TYPES as readonly string[]).includes(origin)) {
    throw new InvalidInput('题目来源类型无效', { details: { origin_type: origin } })
  }
  const isDemo = input.isDemo ?? (origin === 'demo' || origin === 'ai_generated')
  return insertRow(
    db,
    'question_bank_question',
    {
      subject_id: input.subjectId,
      origin_type: origin,
      current_published_version_id: null,
      family_id: input.familyId ?? null,
      content_lineage_id: input.contentLineageId ?? null,
      created_by_id: userId,
      is_demo: isDemo,
      display_label: pyCodePointSlice(input.displayLabel ?? '', 0, 200),
    },
    { now },
  )
}

export interface DraftVersionIn {
  questionType: string
  content: Record<string, unknown>
  practiceMaxScore?: Decimal | string | null
  estimatedSeconds?: number | null
  parentMaterialVersionId?: string | null
  revisionReason?: string
}

/** `Decimal(str(value))`, or `null` for the values Python treats as "not declared". */
function optionalDecimal(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Decimal) return value
  return Decimal.parse(String(value))
}

/**
 * `create_question_version_draft` — the first (or next) draft version of an existing identity.
 *
 * A material child points at its parent through a real version row, so the parent check happens
 * here; `full_clean(exclude=["content","material_child_version_ids"])` then validates the model
 * rules that survive that exclusion (type/status, positive `estimated_seconds`, parent relation).
 */
export function createQuestionVersionDraft(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
  input: DraftVersionIn,
  now: Instant,
): Record<string, unknown> {
  const question = findOne(db, 'question_bank_question', { id: questionId })
  if (question === null) throw new InvalidInput('题目不存在')
  const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (subject === null || String(subject.project_id) !== String(projectId)) {
    throw new InvalidInput('题目不存在')
  }
  const parentId = input.parentMaterialVersionId ?? null
  if (parentId !== null && parentId !== '') {
    const parent = findOne(db, 'question_bank_question_version', { id: parentId })
    if (parent === null) throw new ScopeViolation('父材料版本不存在或不属于该科目')
    const parentQuestion = findOne(db, 'question_bank_question', { id: String(parent.question_id) })
    if (parentQuestion === null || String(parentQuestion.subject_id) !== String(question.subject_id)) {
      throw new ScopeViolation('父材料版本不存在或不属于该科目')
    }
    if (String(parent.question_id) === String(question.id)) {
      throw new InvalidInput('题目不能以自身为父材料')
    }
  }
  const practiceMaxScore = optionalDecimal(input.practiceMaxScore ?? null)
  if (input.questionType === 'material' && practiceMaxScore !== null && practiceMaxScore.truthy) {
    throw new InvalidInput('共享材料父题不计分，不能设置练习分值')
  }
  const estimatedSeconds = input.estimatedSeconds ?? null
  if (estimatedSeconds !== null && (!Number.isInteger(estimatedSeconds) || estimatedSeconds < 0)) {
    throw new StructureInvalid('结构校验失败', {
      details: { errors: { estimated_seconds: ['确保这个值大于或等于 0。'] } },
    })
  }
  // Validation happens before the row exists, so a structurally invalid draft never lands.
  const applied = applyContent({}, input.questionType, input.content)

  return transaction(db, () => {
    const last = db
      .prepare('SELECT MAX("version") AS value FROM "question_bank_question_version" WHERE "question_id" = ?')
      .get(questionId) as { value: number | null }
    const versionNumber = (last.value ?? 0) + 1
    const version = insertRow(
      db,
      'question_bank_question_version',
      {
        question_id: question.id,
        parent_material_version_id: parentId === null || parentId === '' ? null : parentId,
        version: versionNumber,
        question_type: applied.question_type,
        status: QUESTION_VERSION_STATUS.DRAFT,
        content: applied.content,
        content_digest: '',
        practice_max_score: practiceMaxScore,
        estimated_seconds: estimatedSeconds,
        revision_reason: pyCodePointSlice(String(input.revisionReason ?? ''), 0, 500),
        source_note: '',
        material_child_version_ids: [],
        created_by_id: userId,
        withdrawn_at: null,
        withdrawn_reason: '',
      },
      { now },
    )
    writeRevision(db, {
      actorId: userId,
      entityId: String(version.id),
      action: 'create_draft',
      projectId,
      detail: { question_id: String(question.id), version: versionNumber, type: input.questionType },
      now,
    })
    return version
  })
}

export interface AnswerVersionIn {
  answerPayload: Record<string, unknown>
  sourceType?: string
  verificationStatus?: string
  checkBasis?: string
  explanationBlocks?: unknown[]
  sourceRegionId?: string | null
}

/**
 * `create_answer_key_version` — an immutable answer revision.
 *
 * A `checked` answer must carry a concrete basis, and the payload must be gradable for the
 * version's type *before* it is stored. The published answer is later frozen by the immutability
 * rule, which is why the publish path creates one instead of editing an existing one.
 */
export function createAnswerKeyVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  versionId: string,
  input: AnswerVersionIn,
  now: Instant,
): Record<string, unknown> {
  const version = requireVersion(db, userId, projectId, versionId)
  const sourceType = String(input.sourceType ?? 'user')
  if (!(ANSWER_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    throw new InvalidInput('答案来源类型无效')
  }
  const verificationStatus = String(input.verificationStatus ?? 'pending')
  if (!(VERIFICATION_STATUSES as readonly string[]).includes(verificationStatus)) {
    throw new InvalidInput('答案核对状态无效')
  }
  const checkBasis = String(input.checkBasis ?? '')
  if (verificationStatus === 'checked' && checkBasis.trim() === '') {
    throw new InvalidInput('标记为已核对时必须填写核对依据')
  }
  const problems = validateAnswerPayload(
    input.answerPayload,
    String(version.question_type),
    (version.content ?? {}) as Record<string, unknown>,
  )
  if (problems.length > 0) {
    throw new StructureInvalid('答案结构校验失败', { details: { problems } })
  }
  const checked = verificationStatus === 'checked'
  return transaction(db, () => {
    const last = db
      .prepare(
        'SELECT MAX("version") AS value FROM "question_bank_answer_key_version" WHERE "question_version_id" = ?',
      )
      .get(versionId) as { value: number | null }
    const number = (last.value ?? 0) + 1
    const previous = findRows(db, 'question_bank_answer_key_version', { question_version_id: versionId }).sort(
      (a, b) => Number(b.version) - Number(a.version),
    )[0]
    const answer = insertRow(
      db,
      'question_bank_answer_key_version',
      {
        question_version_id: version.id,
        version: number,
        answer_payload: input.answerPayload,
        source_type: sourceType,
        verification_status: verificationStatus,
        checked_by_id: checked ? userId : null,
        checked_at: checked ? now : null,
        check_basis: pyCodePointSlice(checkBasis, 0, 500),
        source_region_id: input.sourceRegionId ?? null,
        explanation_blocks: input.explanationBlocks ?? [],
        is_disputed: false,
        dispute_reason: '',
        supersedes_id: previous === undefined ? null : previous.id,
        created_by_id: userId,
      },
      { now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'answer_key_version',
        entity_id: String(answer.id),
        action: 'create',
        project_id: projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { verification_status: verificationStatus, source_type: sourceType },
      },
      { now },
    )
    return answer
  })
}

/**
 * `upsert_rubric_version` — create or replace the rubric of a *draft* answer.
 *
 * A checked answer on a published version is frozen; changing its rubric would silently re-score
 * history. `full_clean` runs after the row is written in Django, but the transaction rolls back, so
 * this port validates first and writes nothing on failure.
 */
export function upsertRubricVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  answerId: string,
  input: { criteria: unknown[]; totalScore: Decimal | string; usageNote?: string },
  now: Instant,
): Record<string, unknown> {
  const answer = findOne(db, 'question_bank_answer_key_version', { id: answerId })
  if (answer === null) throw new InvalidInput('答案版本不存在')
  const version = requireVersion(db, userId, projectId, String(answer.question_version_id))
  const usable = answer.verification_status === 'checked' && answer.is_disputed !== true
  if (usable && version.status !== QUESTION_VERSION_STATUS.DRAFT) {
    throw new InvalidInput('已发布且已核对的答案不能直接改 rubric，请创建新的答案版本')
  }
  const totalScore = input.totalScore instanceof Decimal ? input.totalScore : Decimal.parse(String(input.totalScore))
  const errors = rubricProblems(input.criteria, totalScore)
  if (Object.keys(errors).length > 0) {
    throw new StructureInvalid('结构校验失败', { details: { errors } })
  }
  const existing = findOne(db, 'question_bank_rubric_version', { answer_key_version_id: answerId })
  if (existing === null) {
    return insertRow(
      db,
      'question_bank_rubric_version',
      {
        answer_key_version_id: answer.id,
        version: 1,
        criteria: input.criteria,
        total_score: totalScore,
        usage_note: pyCodePointSlice(String(input.usageNote ?? ''), 0, 500),
        checked_by_id: userId,
        checked_at: now,
        is_disputed: false,
      },
      { now },
    )
  }
  return updateRow(
    db,
    'question_bank_rubric_version',
    existing.id,
    {
      criteria: input.criteria,
      total_score: totalScore,
      usage_note: pyCodePointSlice(String(input.usageNote ?? ''), 0, 500),
      version: Number(existing.version) + 1,
      checked_by_id: userId,
      checked_at: now,
    },
    { now },
  )!
}

/** `content_digest()` — the same canonical JSON the idempotency fingerprint uses. */
export function contentDigest(content: Record<string, unknown>): string {
  return createHash('sha256').update(pyJsonCanonical(normalizeContent(content)), 'utf8').digest('hex')
}

/** Only a draft may be edited; a published version needs a new revision. */
export function assertDraft(version: Record<string, unknown>): void {
  if (version.status !== QUESTION_VERSION_STATUS.DRAFT) {
    throw new InvalidInput('只有草稿版本可以直接修改；已发布内容请创建新版本', {
      details: { status: version.status },
    })
  }
}

function requireVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  versionId: string,
): Record<string, unknown> {
  const version = findOne(db, 'question_bank_question_version', { id: versionId })
  if (version === null) throw new InvalidInput('题目版本不存在')
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (question === null || subject === null || String(subject.project_id) !== String(projectId)) {
    throw new InvalidInput('题目版本不存在')
  }
  return version
}

function applyContent(
  version: Record<string, unknown>,
  questionType: string,
  content: Record<string, unknown>,
): Record<string, unknown> {
  const problems = validateContent(content, questionType)
  if (problems.length > 0) {
    throw new StructureInvalid('题目结构校验失败', { details: { problems } })
  }
  return { ...version, question_type: questionType, content: normalizeContent(content) }
}

function writeRevision(
  db: DatabaseSync,
  options: {
    actorId: string
    entityId: string
    action: string
    projectId: string
    detail?: Record<string, unknown>
    afterDigest?: string
    now: Instant
  },
): void {
  insertRow(
    db,
    'audit_content_revision',
    {
      actor_id: options.actorId,
      entity_type: 'question_version',
      entity_id: options.entityId,
      action: options.action,
      project_id: options.projectId,
      reason: '',
      before_digest: '',
      after_digest: options.afterDigest ?? '',
      detail: options.detail ?? {},
    },
    { now: options.now },
  )
}

export interface DraftIn {
  question_type?: string
  content?: Record<string, unknown>
  practice_max_score?: string | null
  estimated_seconds?: number | null
  parent_material_version_id?: string | null
  revision_reason?: string
}

/**
 * Create the next draft revision of a question.
 *
 * `estimated_seconds` stays `null` when the caller did not send it — Python stores `None`, and
 * defaulting it to `0` would make "unknown" indistinguishable from "takes no time" in planning.
 */
export function createQuestionRevision(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
  payload: DraftIn,
  now: Instant,
): Record<string, unknown> {
  return createQuestionVersionDraft(
    db,
    userId,
    projectId,
    questionId,
    {
      questionType: String(payload.question_type ?? 'single_choice'),
      content: payload.content ?? {},
      practiceMaxScore: payload.practice_max_score ?? null,
      estimatedSeconds: payload.estimated_seconds ?? null,
      parentMaterialVersionId: payload.parent_material_version_id ?? null,
      revisionReason: payload.revision_reason ?? '',
    },
    now,
  )
}

/** Edit a draft. A published version is refused here, which is the whole invariant. */
export function updateDraftVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  versionId: string,
  payload: DraftIn,
  options: { expectedVersion?: number | null; now: Instant },
): Record<string, unknown> {
  const version = requireVersion(db, userId, projectId, versionId)
  assertDraft(version)
  if (
    options.expectedVersion !== null &&
    options.expectedVersion !== undefined &&
    Number(options.expectedVersion) !== Number(version.version)
  ) {
    throw new VersionConflict('版本已过期，请重新加载', {
      details: { expected: options.expectedVersion, actual: version.version },
    })
  }

  const noChange =
    payload.question_type === undefined &&
    payload.content === undefined &&
    payload.practice_max_score === undefined &&
    payload.estimated_seconds === undefined
  if (noChange) return version

  const targetType = payload.question_type ?? String(version.question_type)
  const targetContent = payload.content ?? (version.content as Record<string, unknown>)
  if (version.question_type === 'material' && payload.practice_max_score) {
    throw new InvalidInput('共享材料父题不计分')
  }
  const applied = applyContent(version, targetType, targetContent)

  return transaction(db, () => {
    const patch: Record<string, unknown> = {
      question_type: applied.question_type,
      content: applied.content,
    }
    if (payload.practice_max_score !== undefined && payload.practice_max_score !== null) {
      patch.practice_max_score = payload.practice_max_score
    }
    if (payload.estimated_seconds !== undefined && payload.estimated_seconds !== null) {
      patch.estimated_seconds = payload.estimated_seconds
    }
    const updated = updateRow(db, 'question_bank_question_version', version.id, patch, { now: options.now })!
    writeRevision(db, {
      actorId: userId,
      entityId: String(version.id),
      action: 'update_draft',
      projectId,
      now: options.now,
    })
    return updated
  })
}

/**
 * `publish_problems` — everything that blocks publishing this version, with a fixable pointer.
 *
 * The order is the reviewer's reading order: content → material children → answer → rubric →
 * blank scores. Django's `answer_keys` relation is ordered `-version`, so the answer used for the
 * payload check is the newest non-disputed one — picking the oldest would validate a superseded
 * answer and publish the current one unvalidated.
 */
export function publishProblems(
  db: DatabaseSync,
  version: Record<string, unknown>,
): Problem[] {
  const problems: Problem[] = []
  const questionType = String(version.question_type)
  const content = (version.content ?? {}) as Record<string, unknown>
  for (const issue of validateContent(content, questionType)) {
    problems.push({ code: issue.code, message: issue.message, path: issue.path ?? '' })
  }

  if (questionType === 'material') {
    const children = findRows(db, 'question_bank_question_version', {
      parent_material_version_id: version.id,
    }).filter((child) => String(child.id) !== String(version.id))
    if (children.length === 0) {
      problems.push({ code: 'material_without_children', message: '共享材料题必须包含子题', path: 'children' })
    }
    const expected = children.map((child) => String(child.id)).sort()
    const declared = ((version.material_child_version_ids ?? []) as unknown[]).map((value) => String(value)).sort()
    if (JSON.stringify(expected) !== JSON.stringify(declared)) {
      problems.push({
        code: 'material_children_mismatch',
        message: '材料题的子题清单与实际子题版本不一致',
        path: 'material_child_version_ids',
      })
    }
    const subjectId = findOne(db, 'question_bank_question', { id: String(version.question_id) })
    for (const child of children) {
      const childQuestion = findOne(db, 'question_bank_question', { id: String(child.question_id) })
      if (
        subjectId !== null &&
        childQuestion !== null &&
        String(childQuestion.subject_id) !== String(subjectId.subject_id)
      ) {
        problems.push({
          code: 'material_child_scope',
          message: '子题与材料题必须属于同一科目',
          path: String(child.id),
        })
      }
    }
    return problems
  }

  const answers = findRows(db, 'question_bank_answer_key_version', { question_version_id: version.id }).sort(
    (a, b) => Number(b.version) - Number(a.version),
  )
  const undisputed = answers.filter((answer) => answer.is_disputed !== true)
  const usable = undisputed.filter((answer) => answer.verification_status === VERIFICATION_CHECKED)
  if (undisputed.length === 0) {
    problems.push({ code: 'answer_missing', message: '缺少答案版本，无法发布', path: 'answer_keys' })
  } else if (usable.length === 0) {
    problems.push({
      code: 'answer_not_checked',
      message: '答案尚未核对（或处于争议），不能发布为计分题',
      path: 'answer_keys',
    })
  }
  const answer = usable[0] ?? null
  if (answer !== null) {
    if (String(answer.question_version_id) !== String(version.id)) {
      problems.push({ code: 'answer_version_mismatch', message: '答案版本与题目版本不匹配', path: 'answer_keys' })
    }
    for (const issue of validateAnswerPayload(answer.answer_payload, questionType, content)) {
      problems.push({ code: issue.code, message: issue.message, path: `answer.${issue.path}` })
    }
    if (String(answer.check_basis ?? '').trim() === '') {
      problems.push({
        code: 'answer_check_basis_missing',
        message: '已核对答案必须记录核对依据',
        path: 'answer_keys',
      })
    }
  }

  if (questionType === 'constructed_response') {
    const rubric =
      answer === null ? null : findOne(db, 'question_bank_rubric_version', { answer_key_version_id: answer.id })
    if (rubric === null) {
      problems.push({ code: 'rubric_missing', message: '大题必须提供逐评分点的评分标准', path: 'rubric' })
    } else {
      // `rubric.full_clean(exclude=["answer_key_version"])` — re-validated at publish time because a
      // rubric row can predate a code change or be written by another path.
      const rubricErrors = rubricProblems(rubric.criteria, rubric.total_score as string)
      if (Object.keys(rubricErrors).length > 0) {
        problems.push({ code: 'rubric_invalid', message: pythonDictRepr(rubricErrors), path: 'rubric' })
      }
      if (
        version.practice_max_score !== null &&
        version.practice_max_score !== undefined &&
        !Decimal.parse(String(rubric.total_score)).eq(Decimal.parse(String(version.practice_max_score)))
      ) {
        problems.push({
          code: 'rubric_total_mismatch',
          message: `rubric 总分 ${String(rubric.total_score)} 与题目分值 ${String(version.practice_max_score)} 不一致`,
          path: 'rubric',
        })
      }
    }
  }

  if (questionType === 'fill_blank' && answer !== null) {
    const blankTotal = sumBlankScores(answer.answer_payload)
    if (
      blankTotal !== null &&
      version.practice_max_score !== null &&
      version.practice_max_score !== undefined &&
      !blankTotal.eq(Decimal.parse(String(version.practice_max_score)))
    ) {
      problems.push({
        code: 'blank_total_mismatch',
        message: `各空分值合计 ${blankTotal.toString()} 与题目分值 ${String(version.practice_max_score)} 不一致`,
        path: 'answer.blanks',
      })
    }
  }
  return problems
}

/** Python's `str(message_dict)` for the `rubric_invalid` message. */
function pythonDictRepr(errors: Record<string, string[]>): string {
  const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  const entries = Object.entries(errors).map(
    ([key, messages]) => `${quote(key)}: [${messages.map((message) => quote(message)).join(', ')}]`,
  )
  return `{${entries.join(', ')}}`
}

export function publishQuestionVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  versionId: string,
  options: { allowWithoutScore?: boolean; now: Instant },
): Record<string, unknown> {
  const version = requireVersion(db, userId, projectId, versionId)
  if (version.status === QUESTION_VERSION_STATUS.PUBLISHED) return version
  if (version.status === QUESTION_VERSION_STATUS.WITHDRAWN) {
    throw new InvalidInput('已撤回版本不能重新发布；请创建新版本')
  }

  const problems = publishProblems(db, version)
  if (
    SCORABLE_LEAF_TYPES.has(String(version.question_type)) &&
    (version.practice_max_score === null || version.practice_max_score === undefined) &&
    options.allowWithoutScore !== true
  ) {
    problems.push({
      code: 'practice_max_score_missing',
      message: '未填写练习分值，且未显式采用所选考试规范的题型默认分值',
      path: 'practice_max_score',
    })
  }
  if (problems.length > 0) {
    throw new StructureInvalid('发布前校验未通过', { details: { problems } })
  }

  return transaction(db, () => {
    const digest = contentDigest(version.content as Record<string, unknown>)
    const locked = updateRow(
      db,
      'question_bank_question_version',
      version.id,
      { status: QUESTION_VERSION_STATUS.PUBLISHED, published_at: options.now, content_digest: digest },
      { now: options.now },
    )!
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })!
    updateRow(
      db,
      'question_bank_question',
      question.id,
      { current_published_version_id: version.id },
      { now: options.now },
    )
    writeRevision(db, {
      actorId: userId,
      entityId: String(version.id),
      action: 'publish',
      projectId,
      afterDigest: digest,
      detail: { question_id: String(question.id), version: version.version },
      now: options.now,
    })
    return locked
  })
}

export function withdrawQuestionVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  versionId: string,
  options: { reason?: string; now: Instant },
): Record<string, unknown> {
  const version = requireVersion(db, userId, projectId, versionId)
  if (version.status === QUESTION_VERSION_STATUS.WITHDRAWN) return version
  if (version.status !== QUESTION_VERSION_STATUS.PUBLISHED) {
    throw new InvalidInput('只有已发布版本可以撤回')
  }
  return transaction(db, () => {
    const updated = updateRow(
      db,
      'question_bank_question_version',
      version.id,
      {
        status: QUESTION_VERSION_STATUS.WITHDRAWN,
        withdrawn_at: options.now,
        withdrawn_reason: String(options.reason ?? '').slice(0, 500),
      },
      { now: options.now },
    )!
    const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })!
    if (String(question.current_published_version_id) === String(version.id)) {
      const fallback = findRows(db, 'question_bank_question_version', {
        question_id: question.id,
        status: QUESTION_VERSION_STATUS.PUBLISHED,
      })
        .filter((row) => String(row.id) !== String(version.id))
        .sort((a, b) => Number(b.version) - Number(a.version))[0]
      updateRow(
        db,
        'question_bank_question',
        question.id,
        { current_published_version_id: fallback === undefined ? null : fallback.id },
        { now: options.now },
      )
    }
    writeRevision(db, {
      actorId: userId,
      entityId: String(version.id),
      action: 'withdraw',
      projectId,
      detail: { reason: String(options.reason ?? '') },
      now: options.now,
    })
    return updated
  })
}

/** Exported for tests that need the canonical form without going through a publish. */
export { formatPythonIso }

// --------------------------------------------------------------------------
// Read side: metadata lists, the answer-free preview, answer keys, sources,
// rubric. Port of the query half of `apps/question_bank/api.py`.
//
// The Django list endpoint advertises a constant number of queries per page;
// this port keeps the same *behaviour* with an in-process join instead. The
// dataset is one workspace on one machine, so clarity wins over the query-count
// optimisation, and the tie-break caveat of D21 applies to `created_at` ties.
// --------------------------------------------------------------------------

export interface QuestionListFilters {
  subjectId?: string | null
  questionType?: string | null
  status?: string | null
  originType?: string | null
  search?: string | null
  limit?: number
  offset?: number
}

const DEFAULT_PAGE_SIZE = 20

function requireQuestionInProject(
  db: DatabaseSync,
  projectId: string,
  questionId: string,
): Record<string, unknown> {
  const question = findOne(db, 'question_bank_question', { id: questionId })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (question === null || subject === null || String(subject.project_id) !== String(projectId)) {
    throw new ScopeViolation('题目不存在或不属于该项目')
  }
  return question
}

/** Versions of one question, newest first (`QuestionVersion.Meta.ordering`). */
function versionsOf(db: DatabaseSync, questionId: string): Record<string, unknown>[] {
  return findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
    (a, b) => Number(b.version) - Number(a.version),
  )
}

/** `_version_out` — the wire form of one question version. */
export function versionPayload(version: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(version.id),
    question_id: String(version.question_id),
    version: version.version,
    question_type: version.question_type,
    status: version.status,
    content: version.content ?? {},
    practice_max_score: version.practice_max_score ?? null,
    estimated_seconds: version.estimated_seconds ?? null,
    revision_reason: version.revision_reason,
    published_at:
      version.published_at === null || version.published_at === undefined
        ? null
        : formatPythonIso(version.published_at as Instant),
  }
}

/**
 * Question list: metadata only, never the stem and never an answer.
 *
 * `question_type` / `status` filter *versions*, exactly like the Django queryset
 * (`versions__in=...`), so a question that only had one matching historical
 * version still appears once.
 */
export function listQuestions(
  db: DatabaseSync,
  projectId: string,
  filters: QuestionListFilters = {},
): Record<string, unknown>[] {
  const subjects = findRows(db, 'exams_subject', { project_id: projectId })
  const subjectIds = new Set(subjects.map((subject) => String(subject.id)))
  if (
    filters.subjectId !== null &&
    filters.subjectId !== undefined &&
    filters.subjectId !== '' &&
    !subjectIds.has(String(filters.subjectId))
  ) {
    throw new ScopeViolation('科目不存在或不属于该项目')
  }

  let questions = findRows(db, 'question_bank_question', {}).filter((question) =>
    subjectIds.has(String(question.subject_id)),
  )
  if (filters.subjectId !== null && filters.subjectId !== undefined && filters.subjectId !== '') {
    questions = questions.filter((question) => String(question.subject_id) === String(filters.subjectId))
  }
  if (filters.originType !== null && filters.originType !== undefined && filters.originType !== '') {
    questions = questions.filter((question) => String(question.origin_type) === String(filters.originType))
  }
  const term = (filters.search ?? '').trim().slice(0, 60)
  if (term !== '') {
    const needle = term.toLowerCase()
    questions = questions.filter((question) => String(question.display_label ?? '').toLowerCase().includes(needle))
  }

  const questionIds = new Set(questions.map((question) => String(question.id)))
  const versions = findRows(db, 'question_bank_question_version', {}).filter((version) =>
    questionIds.has(String(version.question_id)),
  )
  const versionsByQuestion = new Map<string, Record<string, unknown>[]>()
  for (const version of versions) {
    const key = String(version.question_id)
    const bucket = versionsByQuestion.get(key)
    if (bucket === undefined) versionsByQuestion.set(key, [version])
    else bucket.push(version)
  }
  for (const bucket of versionsByQuestion.values()) {
    bucket.sort((a, b) => Number(b.version) - Number(a.version))
  }

  const typeFilter = filters.questionType ?? null
  const statusFilter = filters.status ?? null
  if ((typeFilter !== null && typeFilter !== '') || (statusFilter !== null && statusFilter !== '')) {
    questions = questions.filter((question) =>
      (versionsByQuestion.get(String(question.id)) ?? []).some(
        (version) =>
          (typeFilter === null || typeFilter === '' || String(version.question_type) === String(typeFilter)) &&
          (statusFilter === null || statusFilter === '' || String(version.status) === String(statusFilter)),
      ),
    )
  }

  // `Question.Meta.ordering = ["-created_at"]`; ties keep insertion order (D21).
  questions = questions
    .map((question, index) => ({ question, index }))
    .sort((a, b) => {
      const left = a.question.created_at as Instant
      const right = b.question.created_at as Instant
      if (left === right) return a.index - b.index
      return right > left ? 1 : -1
    })
    .map((entry) => entry.question)

  const limit = Math.max(1, Math.min(filters.limit ?? DEFAULT_PAGE_SIZE, 100))
  const offset = Math.max(0, filters.offset ?? 0)
  const page = questions.slice(offset, offset + limit)

  const answerKeys = findRows(db, 'question_bank_answer_key_version', {})
  const mappings = findRows(db, 'knowledge_question_mapping', {})
  const nodes = new Map(findRows(db, 'knowledge_node', {}).map((node) => [String(node.id), node]))
  const items: Record<string, unknown>[] = []
  for (const question of page) {
    const publishedId = question.current_published_version_id
    const published =
      publishedId === null || publishedId === undefined
        ? null
        : (versionsByQuestion.get(String(question.id)) ?? []).find(
            (version) => String(version.id) === String(publishedId),
          ) ?? null
    const newest = (versionsByQuestion.get(String(question.id)) ?? [])[0] ?? null
    const trusted =
      published === null
        ? []
        : answerKeys.filter(
            (key) =>
              String(key.question_version_id) === String(published.id) &&
              key.verification_status === VERIFICATION_CHECKED &&
              key.is_disputed !== true,
          )
    const nodeNames =
      published === null
        ? []
        : mappings
            .filter(
              (mapping) =>
                String(mapping.question_version_id) === String(published.id) && mapping.is_primary === true,
            )
            .map((mapping) => {
              const node = nodes.get(String(mapping.node_id))
              return node === undefined ? null : String(node.canonical_name)
            })
            .filter((name): name is string => name !== null)
    items.push({
      id: String(question.id),
      subject_id: String(question.subject_id),
      display_label: question.display_label,
      origin_type: question.origin_type,
      is_demo: question.is_demo,
      question_type: published === null ? newest?.question_type ?? null : published.question_type,
      published_version_id: published === null ? null : String(published.id),
      latest_version: newest === null ? null : newest.version,
      has_trusted_answer: trusted.length > 0,
      knowledge_nodes: nodeNames,
    })
  }
  return items
}

/** `_preview` — metadata plus the stem payload, never an answer. */
function previewPayload(
  version: Record<string, unknown>,
  question: Record<string, unknown>,
): Record<string, unknown> {
  const content = (version.content ?? {}) as Record<string, unknown>
  const options = Array.isArray(content['options']) ? (content['options'] as unknown[]) : []
  const blanks = Array.isArray(content['blanks']) ? (content['blanks'] as unknown[]) : []
  return {
    id: String(question.id),
    version_id: String(version.id),
    subject_id: String(question.subject_id),
    question_type: version.question_type,
    display_label: question.display_label,
    content,
    options: options
      .filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null)
      .map((option) => ({
        id: option['id'] === undefined ? null : option['id'],
        label: option['label'] ?? option['id'],
      })),
    blank_ids: blanks
      .filter((blank): blank is Record<string, unknown> => typeof blank === 'object' && blank !== null)
      .map((blank) => blank['blank_id'])
      .filter((value) => Boolean(value)),
    material_child_version_ids: Array.isArray(version.material_child_version_ids)
      ? version.material_child_version_ids
      : [],
    practice_max_score: version.practice_max_score ?? null,
    estimated_seconds: version.estimated_seconds ?? null,
  }
}

/**
 * Question detail. Delivers the stem, so it writes a `stem_delivered` exposure
 * row (purpose `preview`) exactly like the Django endpoint — the ledger is how
 * every downstream "has this been seen?" answer stays truthful.
 *
 * Sealed content is refused with the sealing reason (`C03`), because delivering
 * the stem would leak what the seal protects.
 */
export function getQuestionPreview(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
  now: Instant,
): Record<string, unknown> {
  const question = requireQuestionInProject(db, projectId, questionId)
  assertNotSealed(db, projectId, questionId)
  const versions = versionsOf(db, questionId)
  const publishedId = question.current_published_version_id
  const version =
    (publishedId === null || publishedId === undefined
      ? null
      : versions.find((candidate) => String(candidate.id) === String(publishedId))) ?? versions[0] ?? null
  if (version === null) throw new ScopeViolation('该题目尚无版本')
  insertRow(
    db,
    'practice_exposure_event',
    {
      user_id: userId,
      project_id: projectId,
      question_id: String(question.id),
      question_version_id: String(version.id),
      family_id: question.family_id ?? null,
      content_lineage_id: question.content_lineage_id ?? null,
      session_item_id: null,
      kind: 'stem_delivered',
      purpose: 'preview',
      source: 'question_detail',
      server_time: now,
      detail: {},
      reveals_answer: false,
    },
    { now },
  )
  return previewPayload(version, question)
}

/** Answer metadata for every version of one question, newest first. */
export function listAnswerKeys(
  db: DatabaseSync,
  projectId: string,
  questionId: string,
): Record<string, unknown>[] {
  requireQuestionInProject(db, projectId, questionId)
  const versionIds = new Set(versionsOf(db, questionId).map((version) => String(version.id)))
  return findRows(db, 'question_bank_answer_key_version', {})
    .filter((key) => versionIds.has(String(key.question_version_id)))
    .sort((a, b) => Number(b.version) - Number(a.version))
    .map((key) => ({
      id: String(key.id),
      version: key.version,
      verification_status: key.verification_status,
      // `AnswerKeyVersion.is_usable`: trusted (checked) and undisputed.
      is_usable: key.verification_status === VERIFICATION_CHECKED && key.is_disputed !== true,
      source_type: key.source_type,
      check_basis: key.check_basis,
      checked_at:
        key.checked_at === null || key.checked_at === undefined
          ? null
          : formatPythonIso(key.checked_at as Instant),
      is_disputed: key.is_disputed,
    }))
}

/** Where each version came from in the source document, across all versions. */
export function listSourceRegions(
  db: DatabaseSync,
  projectId: string,
  questionId: string,
): Record<string, unknown>[] {
  requireQuestionInProject(db, projectId, questionId)
  const rows: Record<string, unknown>[] = []
  for (const version of versionsOf(db, questionId)) {
    for (const link of findRows(db, 'question_bank_source_link', { question_version_id: String(version.id) })) {
      const region = findOne(db, 'ingestion_source_region', { id: String(link.region_id) })
      if (region === null) continue
      rows.push({
        id: String(region.id),
        document_id: String(region.document_id),
        page_index: region.page_index,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        role: link.role,
        crop_asset_id: region.crop_asset_id === null ? null : String(region.crop_asset_id),
      })
    }
  }
  return rows
}

/** One rubric version, scoped through answer key -> version -> question -> subject. */
export function getRubricVersion(
  db: DatabaseSync,
  projectId: string,
  rubricId: string,
): Record<string, unknown> {
  const rubric = findOne(db, 'question_bank_rubric_version', { id: rubricId })
  const answer = rubric === null ? null : findOne(db, 'question_bank_answer_key_version', {
    id: String(rubric.answer_key_version_id),
  })
  const version = answer === null ? null : findOne(db, 'question_bank_question_version', {
    id: String(answer.question_version_id),
  })
  const question = version === null ? null : findOne(db, 'question_bank_question', {
    id: String(version.question_id),
  })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (
    rubric === null ||
    answer === null ||
    version === null ||
    question === null ||
    subject === null ||
    String(subject.project_id) !== String(projectId)
  ) {
    throw new ScopeViolation('评分标准不存在或不属于该项目')
  }
  return {
    id: String(rubric.id),
    criteria: rubric.criteria ?? {},
    total_score: rubric.total_score,
    usage_note: rubric.usage_note,
    checked_at:
      rubric.checked_at === null || rubric.checked_at === undefined
        ? null
        : formatPythonIso(rubric.checked_at as Instant),
  }
}

// ---------------------------------------------------------------------------
// Answer dispute (`question_bank/services/core.py::dispute_answer_key_version`)
// ---------------------------------------------------------------------------

/** `AnswerKeyVersion.is_usable` stops being true the moment the answer is disputed. */
export const DISPUTED_INVALIDATION_TOPIC = 'projection.rebuild_after_answer_change'

/**
 * Dispute an answer: stop new grading, send in-flight work to human review.
 *
 * Port of `question_bank/services/core.py::dispute_answer_key_version`. Three writes happen in one
 * transaction, because a half-applied dispute is worse than none:
 *
 *  1. the answer version is marked `disputed` (with the reason, truncated to the column width);
 *  2. an `audit_content_revision` row records the editorial action;
 *  3. every graded attempt that froze this answer version gets an invalidation grade event
 *     ({@link handleAnswerDispute}) — the raw answers stay untouched;
 *
 * and the evidence invalidation is handed to the outbox as `projection.rebuild_after_answer_change`.
 * The dedupe key carries `timezone.now().timestamp():.0f`, i.e. whole seconds, which is what Django
 * writes: two disputes in the same second collapse into one event, a later one does not.
 */
export function disputeAnswerKeyVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  answerKeyVersionId: string,
  reason: string,
  now: Instant,
): { answer: Record<string, unknown>; affected: number } {
  return transaction(db, () => {
    requireProject(db, userId, projectId)
    const answer = findOne(db, 'question_bank_answer_key_version', { id: answerKeyVersionId })
    const version =
      answer === null ? null : findOne(db, 'question_bank_question_version', { id: String(answer.question_version_id) })
    const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
    const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
    // Django resolves the object through `answer -> version -> question -> subject -> project` and
    // raises `ScopeViolation` before the service is reached; a foreign answer must look absent.
    if (
      answer === null ||
      version === null ||
      question === null ||
      subject === null ||
      String(subject.project_id) !== String(projectId)
    ) {
      throw new ScopeViolation('答案版本不存在或不属于该项目')
    }

    const updated = updateRow(
      db,
      'question_bank_answer_key_version',
      answer.id,
      {
        verification_status: 'disputed',
        is_disputed: true,
        dispute_reason: pyCodePointSlice(reason, 0, 500),
      },
      { now },
    )!
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'answer_key_version',
        entity_id: String(updated.id),
        action: 'dispute',
        project_id: projectId,
        reason: pyCodePointSlice(reason, 0, 500),
        before_digest: '',
        after_digest: '',
        detail: {},
      },
      { now },
    )
    // Existing work that relied on this answer goes to human review; raw answers stay.
    const affected = handleAnswerDispute(db, String(updated.id), userId, reason, now)
    enqueue(db, {
      topic: DISPUTED_INVALIDATION_TOPIC,
      payload: { answer_key_version_id: String(updated.id), affected_attempts: affected },
      // Django: f"answer-change:{answer.id}:{timezone.now().timestamp():.0f}".
      dedupeKey: `answer-change:${String(updated.id)}:${pyFormatFixed(Number(now) / 1e6, 0)}`,
      now,
    })
    return { answer: updated, affected }
  })
}
