/**
 * Sealing (封存 / holdout) — the one place the product decides "sealed".
 *
 * Port of `backend/apps/question_bank/services/sealing.py`.
 *
 * A question is sealed when the **latest** `QuestionPoolPolicy` revision for its project says
 * `is_holdout`, either for the question itself or for its family. "Latest" is per target, never
 * global: an older `is_holdout: true` row that a later revision cleared unseals the content again,
 * which is exactly how `unseal` works — it appends a new revision rather than editing the old one.
 *
 * Before this resolver existed the rule lived in one caller, so retrieval and practice could
 * disagree. Every entry point must call this module and nothing else may re-implement the
 * comparison against `QuestionPoolPolicy`.
 */
import type { DatabaseSync } from 'node:sqlite'
import { findOne, findRows, insertRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { formatPythonIso, parseInstant, type Instant } from '../domain/instant.ts'
import { InvalidInput, PurposeNotAllowed } from './errors.ts'

/** Stable reason codes: part of the wire contract (error `details`, `/sealed-content` rows). */
export const SEALED_QUESTION = 'sealed_question_policy'
export const SEALED_FAMILY = 'sealed_family_policy'

export const REASON_MESSAGES: Record<string, string> = {
  [SEALED_QUESTION]: '该题已被保留策略（holdout）封存：不参与练习、检索、AI 生成提示、导出与原页预览',
  [SEALED_FAMILY]: '该题所属家族已被保留策略（holdout）封存：不参与练习、检索、AI 生成提示、导出与原页预览',
}

/** Kept byte-identical to the earlier text so existing index rows stay comparable. */
export const SEARCH_EXCLUSION_REASON = '题目或题族已标记为保留（holdout），不参与检索'

export const ACTION_SEAL = 'seal'
export const ACTION_UNSEAL = 'unseal'

export function reasonMessage(code: string): string {
  return REASON_MESSAGES[code] ?? '该内容已被保留策略封存'
}

interface PolicyRow {
  id: string
  question_id: string | null
  family_id: string | null
  is_holdout: number | boolean
  revision: number
  change_reason: string
  created_at: Instant
}

/**
 * `(question_id -> latest policy, family_id -> latest policy)`.
 *
 * One ordered scan over the project; the first row seen for a target is its latest revision, which
 * is the only revision that may decide anything. Lower revisions are history and never consulted.
 */
export function latestPolicies(
  db: DatabaseSync,
  projectId: string,
  filter: { questionIds?: readonly string[]; familyIds?: readonly string[] } = {},
): { questions: Map<string, PolicyRow>; families: Map<string, PolicyRow> } {
  const rows = db
    .prepare(
      `SELECT "id","question_id","family_id","is_holdout","revision","change_reason","created_at"
         FROM "question_bank_pool_policy"
        WHERE "project_id" = ?
        ORDER BY "revision" DESC, "created_at" DESC, "id" DESC`,
    )
    .all(projectId) as unknown as PolicyRow[]
  // The raw query bypasses the repository codec, so the timestamp arrives as text.
  for (const row of rows) row.created_at = parseInstant(String(row.created_at))

  const questionIds = filter.questionIds === undefined ? null : new Set(filter.questionIds.map(String))
  const familyIds = filter.familyIds === undefined ? null : new Set(filter.familyIds.map(String))

  const questions = new Map<string, PolicyRow>()
  const families = new Map<string, PolicyRow>()
  for (const row of rows) {
    const questionId = row.question_id === null ? null : String(row.question_id)
    const familyId = row.family_id === null ? null : String(row.family_id)
    if (questionId !== null && (questionIds === null || questionIds.has(questionId)) && !questions.has(questionId)) {
      questions.set(questionId, row)
    }
    if (familyId !== null && (familyIds === null || familyIds.has(familyId)) && !families.has(familyId)) {
      families.set(familyId, row)
    }
  }
  return { questions, families }
}

/**
 * `question_id -> reason code` for the given `(question_id, family_id)` targets.
 *
 * Taking ids instead of rows is deliberate: a caller may hold a question loaded before its family
 * changed, and a stale family id would answer "not sealed" for content that is.
 */
export function sealCodes(
  db: DatabaseSync,
  projectId: string,
  targets: readonly (readonly [questionId: string, familyId: string | null])[],
): Map<string, string> {
  const decisions = new Map<string, string>()
  if (targets.length === 0) return decisions
  const familyIds = [...new Set(targets.map(([, familyId]) => familyId).filter((value): value is string => value !== null))]
  const { questions, families } = latestPolicies(db, projectId, {
    questionIds: targets.map(([questionId]) => questionId),
    familyIds,
  })
  for (const [questionId, familyId] of targets) {
    const questionPolicy = questions.get(questionId)
    if (questionPolicy !== undefined && Boolean(questionPolicy.is_holdout)) {
      decisions.set(questionId, SEALED_QUESTION)
      continue
    }
    if (familyId !== null) {
      const familyPolicy = families.get(familyId)
      if (familyPolicy !== undefined && Boolean(familyPolicy.is_holdout)) {
        decisions.set(questionId, SEALED_FAMILY)
      }
    }
  }
  return decisions
}

/** Every sealed question of one project (or the sealed subset of `questionIds`). */
export function sealedQuestionIds(
  db: DatabaseSync,
  projectId: string,
  questionIds?: readonly string[],
): Set<string> {
  const { questions, families } = latestPolicies(db, projectId)
  const sealedFamilies = new Set(
    [...families.entries()].filter(([, row]) => Boolean(row.is_holdout)).map(([familyId]) => familyId),
  )

  const candidates =
    questionIds === undefined
      ? findRows(db, 'question_bank_question', {}).filter((question) => {
          const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
          return subject !== null && String(subject.project_id) === String(projectId)
        })
      : questionIds.map((id) => ({ id }))

  const sealed = new Set<string>()
  for (const candidate of candidates) {
    const questionId = String(candidate.id)
    const row = questions.get(questionId)
    if (row !== undefined && Boolean(row.is_holdout)) {
      sealed.add(questionId)
      continue
    }
    const question =
      questionIds === undefined
        ? candidate
        : findOne(db, 'question_bank_question', { id: questionId })
    const familyId = (question as Record<string, unknown> | null)?.family_id ?? null
    if (familyId !== null && sealedFamilies.has(String(familyId))) sealed.add(questionId)
  }
  return sealed
}

/** The family ids whose own family-scoped policy currently seals them. */
export function sealedFamilyIds(
  db: DatabaseSync,
  projectId: string,
  familyIds?: readonly string[],
): Set<string> {
  const { families } = latestPolicies(db, projectId, familyIds === undefined ? {} : { familyIds })
  return new Set(
    [...families.entries()].filter(([, row]) => Boolean(row.is_holdout)).map(([familyId]) => familyId),
  )
}

export function isSealed(
  db: DatabaseSync,
  projectId: string,
  questionId: string,
): { sealed: boolean; code: string } {
  const question = findOne(db, 'question_bank_question', { id: questionId })
  if (question === null) return { sealed: false, code: '' }
  const familyId = question.family_id === null ? null : String(question.family_id)
  const decisions = sealCodes(db, projectId, [[questionId, familyId]])
  const code = decisions.get(questionId)
  return code === undefined ? { sealed: false, code: '' } : { sealed: true, code }
}

/** Refuse an action on sealed content, with the sentence the UI shows. */
export function assertNotSealed(
  db: DatabaseSync,
  projectId: string,
  questionId: string,
): void {
  const decision = isSealed(db, projectId, questionId)
  if (decision.sealed) {
    throw new PurposeNotAllowed(reasonMessage(decision.code), { details: { reason_code: decision.code } })
  }
}

function appendPolicy(
  db: DatabaseSync,
  options: {
    projectId: string
    actorId: string
    reason: string
    isHoldout: boolean
    questionId?: string | null
    familyId?: string | null
    now: Instant
  },
): Record<string, unknown> {
  const { projectId, actorId, now } = options
  const questionId = options.questionId ?? null
  const familyId = options.familyId ?? null
  if ((familyId === null) === (questionId === null)) {
    throw new InvalidInput('封存策略必须且只能指定一个目标（题目或家族）')
  }

  if (questionId !== null) {
    const question = findOne(db, 'question_bank_question', { id: questionId })
    const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
    if (question === null || subject === null || String(subject.project_id) !== String(projectId)) {
      throw new InvalidInput('题目不属于该项目')
    }
  }
  if (familyId !== null) {
    const family = findOne(db, 'question_bank_family', { id: familyId })
    const subject = family === null ? null : findOne(db, 'exams_subject', { id: String(family.subject_id) })
    if (family === null || subject === null || String(subject.project_id) !== String(projectId)) {
      throw new InvalidInput('题族不属于该项目')
    }
  }

  const previous = db
    .prepare(
      questionId !== null
        ? `SELECT MAX("revision") AS value FROM "question_bank_pool_policy" WHERE "project_id" = ? AND "question_id" = ?`
        : `SELECT MAX("revision") AS value FROM "question_bank_pool_policy" WHERE "project_id" = ? AND "family_id" = ?`,
    )
    .get(projectId, String(questionId ?? familyId)) as { value: number | null }
  const revision = (previous.value ?? 0) + 1

  return transaction(db, () => {
    const policy = insertRow(
      db,
      'question_bank_pool_policy',
      {
        project_id: projectId,
        question_id: questionId,
        family_id: familyId,
        revision,
        is_holdout: options.isHoldout,
        change_reason: String(options.reason ?? '').slice(0, 500),
        changed_by_id: actorId,
      },
      { now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: actorId,
        entity_type: familyId === null ? 'question' : 'question_family',
        entity_id: String(familyId ?? questionId),
        action: options.isHoldout ? ACTION_SEAL : ACTION_UNSEAL,
        project_id: projectId,
        reason: String(options.reason ?? '').slice(0, 500),
        before_digest: '',
        after_digest: '',
        detail: {
          target: familyId === null ? 'question' : 'family',
          policy_id: String(policy.id),
          revision,
          is_holdout: options.isHoldout,
          family_id: familyId,
          question_id: questionId,
        },
      },
      { now },
    )
    return policy
  })
}

export function sealQuestion(
  db: DatabaseSync,
  options: { projectId: string; questionId: string; actorId: string; reason?: string; now: Instant },
): Record<string, unknown> {
  return appendPolicy(db, {
    projectId: options.projectId,
    actorId: options.actorId,
    reason: options.reason ?? '',
    isHoldout: true,
    questionId: options.questionId,
    now: options.now,
  })
}

export function unsealQuestion(
  db: DatabaseSync,
  options: { projectId: string; questionId: string; actorId: string; reason?: string; now: Instant },
): Record<string, unknown> {
  return appendPolicy(db, {
    projectId: options.projectId,
    actorId: options.actorId,
    reason: options.reason ?? '',
    isHoldout: false,
    questionId: options.questionId,
    now: options.now,
  })
}

export function sealFamily(
  db: DatabaseSync,
  options: { projectId: string; familyId: string; actorId: string; reason?: string; now: Instant },
): Record<string, unknown> {
  return appendPolicy(db, {
    projectId: options.projectId,
    actorId: options.actorId,
    reason: options.reason ?? '',
    isHoldout: true,
    familyId: options.familyId,
    now: options.now,
  })
}

export function unsealFamily(
  db: DatabaseSync,
  options: { projectId: string; familyId: string; actorId: string; reason?: string; now: Instant },
): Record<string, unknown> {
  return appendPolicy(db, {
    projectId: options.projectId,
    actorId: options.actorId,
    reason: options.reason ?? '',
    isHoldout: false,
    familyId: options.familyId,
    now: options.now,
  })
}

/**
 * The `GET /sealed-content` payload: what is sealed and why.
 *
 * Only the latest policy per target is reported. An older `is_holdout: true` row that a later
 * revision cleared is history; reporting it would claim content is sealed when it is not.
 */
export function sealedContentReport(db: DatabaseSync, projectId: string): Record<string, unknown> {
  const { questions: questionLatest, families: familyLatest } = latestPolicies(db, projectId)
  const sealedIds = sealedQuestionIds(db, projectId)
  const subjectIds = new Set(
    findRows(db, 'exams_subject', { project_id: projectId }).map((subject) => String(subject.id)),
  )
  const questionRows: Record<string, unknown>[] = []
  for (const questionId of [...sealedIds].sort()) {
    const question = findOne(db, 'question_bank_question', { id: questionId })
    if (question === null || !subjectIds.has(String(question.subject_id))) continue
    const familyId = question.family_id === null ? null : String(question.family_id)
    const decisions = sealCodes(db, projectId, [[questionId, familyId]])
    const code = decisions.get(questionId) ?? ''
    const policyTarget = code === SEALED_QUESTION ? 'question' : 'family'
    const policy =
      policyTarget === 'question' ? questionLatest.get(questionId) : familyId === null ? undefined : familyLatest.get(familyId)
    const family = familyId === null ? null : findOne(db, 'question_bank_family', { id: familyId })
    questionRows.push({
      question_id: questionId,
      display_label: question.display_label,
      subject_id: String(question.subject_id),
      family_id: familyId,
      family_name: family === null ? '' : family.name,
      reason_code: code,
      reason_message: reasonMessage(code),
      policy_id: policy === undefined ? null : String(policy.id),
      policy_revision: policy === undefined ? null : policy.revision,
      policy_target: policy === undefined ? null : policyTarget,
      change_reason: policy === undefined ? '' : policy.change_reason,
      changed_at: policy === undefined ? null : formatPythonIso(policy.created_at),
    })
  }

  const familyRows: Record<string, unknown>[] = []
  const sealedFamilyIds = [...familyLatest.entries()]
    .filter(([, row]) => Boolean(row.is_holdout))
    .map(([familyId]) => familyId)
    .sort()
  for (const familyId of sealedFamilyIds) {
    const row = familyLatest.get(familyId)!
    const family = findOne(db, 'question_bank_family', { id: familyId })
    familyRows.push({
      family_id: familyId,
      name: family === null ? '' : family.name,
      subject_id: family === null ? null : String(family.subject_id),
      reason_code: SEALED_FAMILY,
      reason_message: reasonMessage(SEALED_FAMILY),
      policy_id: String(row.id),
      policy_revision: row.revision,
      change_reason: row.change_reason,
      changed_at: formatPythonIso(row.created_at),
    })
  }

  return {
    question_ids: [...sealedIds].sort(),
    questions: questionRows,
    families: familyRows,
    reasons: Object.fromEntries([...sealedIds].sort().map((id) => {
      const question = findOne(db, 'question_bank_question', { id })
      const familyId = question?.family_id === null || question?.family_id === undefined ? null : String(question.family_id)
      return [id, sealCodes(db, projectId, [[id, familyId]]).get(id) ?? '']
    })),
  }
}

/**
 * `_seal_out` — what a new policy revision means *now*, resolved rather than assumed.
 *
 * A `seal` call can report `sealed: true` because an older policy already covered
 * the target, and a family unseal can still leave members sealed by their own
 * policy; reporting the raw policy row would hide both.
 */
export function sealPayload(
  db: DatabaseSync,
  projectId: string,
  policy: Record<string, unknown>,
): Record<string, unknown> {
  const questionId = policy.question_id === null || policy.question_id === undefined ? null : String(policy.question_id)
  const familyId = policy.family_id === null || policy.family_id === undefined ? null : String(policy.family_id)
  const targetQuestionIds =
    questionId !== null
      ? [questionId]
      : findRows(db, 'question_bank_question', { family_id: familyId }).map((question) => String(question.id))
  const sealedIds = [...sealedQuestionIds(db, projectId, targetQuestionIds)].sort()
  const first = sealedIds[0]
  return {
    policy_id: String(policy.id),
    target: questionId !== null ? 'question' : 'family',
    question_id: questionId,
    family_id: familyId,
    revision: policy.revision,
    is_holdout: policy.is_holdout,
    change_reason: policy.change_reason,
    changed_at: formatPythonIso(policy.created_at as Instant),
    sealed: sealedIds.length > 0,
    // `_seal_out` reports the *code* here, not the sentence (`is_sealed` returns `(bool, code)`).
    sealed_reason: first === undefined ? '' : isSealed(db, projectId, first).code,
    sealed_question_ids: sealedIds,
  }
}
