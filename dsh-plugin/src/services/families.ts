/**
 * Question families: near-duplicate groups, with the sealing rules applied on every membership
 * change.
 *
 * Port of `backend/apps/question_bank/services/families.py` (membership part). The refusals here are
 * not bookkeeping: adding a question to a sealed family would silently extend what a seal covers,
 * and removing the last member of a sealed family would silently unseal content a policy explicitly
 * sealed. Both must be an explicit `seal`/`unseal` instead.
 */
import type { DatabaseSync } from 'node:sqlite'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { InvalidInput, PurposeNotAllowed, ScopeViolation } from './errors.ts'
import { SEALED_FAMILY, reasonMessage, sealedFamilyIds, sealedQuestionIds } from './sealing.ts'
import { exposureState } from '../domain/contamination.ts'
import { loadExposureFacts, refreshNodeState } from './evidence_rebuild.ts'

const FAMILY_NAME_LIMIT = 200
const FAMILY_NOTE_LIMIT = 500

export function familyPayload(
  db: DatabaseSync,
  projectId: string,
  family: Record<string, unknown>,
): Record<string, unknown> {
  const memberIds = findRows(db, 'question_bank_question', { family_id: family.id }).map((row) => String(row.id))
  const familySealed = sealedFamilyIds(db, projectId, [String(family.id)]).size > 0
  const sealedMembers = sealedQuestionIds(db, projectId, memberIds)
  return {
    id: String(family.id),
    subject_id: String(family.subject_id),
    name: family.name,
    revision: family.revision,
    relation_confirmed: family.relation_confirmed,
    note: family.note,
    member_count: memberIds.length,
    sealed: familySealed,
    sealed_reason: familySealed ? SEALED_FAMILY : '',
    sealed_member_count: sealedMembers.size,
    merged_into_id: family.merged_into_id === null ? null : String(family.merged_into_id),
    merged_at: family.merged_at === null ? null : formatPythonIso(family.merged_at as Instant),
  }
}

function requireFamilyInProject(
  db: DatabaseSync,
  projectId: string,
  familyId: string,
): Record<string, unknown> {
  const family = findOne(db, 'question_bank_family', { id: familyId })
  const subject = family === null ? null : findOne(db, 'exams_subject', { id: String(family.subject_id) })
  if (family === null || subject === null || String(subject.project_id) !== String(projectId)) {
    throw new ScopeViolation('家族不存在或不属于该项目')
  }
  return family
}

export function listFamilies(
  db: DatabaseSync,
  projectId: string,
  options: { subjectId?: string | null } = {},
): Record<string, unknown>[] {
  const subjects = findRows(db, 'exams_subject', { project_id: projectId })
  const allowed = new Set(subjects.map((subject) => String(subject.id)))
  if (options.subjectId !== null && options.subjectId !== undefined && !allowed.has(String(options.subjectId))) {
    throw new ScopeViolation('科目不存在或不属于该项目')
  }
  const subjectOrder = new Map(subjects.map((subject) => [String(subject.id), Number(subject.display_order ?? 0)]))
  const rows = findRows(db, 'question_bank_family', {})
    .filter((family) =>
      options.subjectId === null || options.subjectId === undefined
        ? allowed.has(String(family.subject_id))
        : String(family.subject_id) === String(options.subjectId),
    )
    // Django orders by `subject__display_order, name`; a name-only sort would
    // interleave subjects and change the list the client already renders.
    .sort((left, right) => {
      const leftOrder = subjectOrder.get(String(left.subject_id)) ?? 0
      const rightOrder = subjectOrder.get(String(right.subject_id)) ?? 0
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return String(left.name).localeCompare(String(right.name), 'zh-Hans-CN')
    })
  return rows.map((family) => familyPayload(db, projectId, family))
}

export function createFamily(
  db: DatabaseSync,
  options: { projectId: string; actorId: string; subjectId: string; name: string; note?: string; now: Instant },
): Record<string, unknown> {
  const subject = findOne(db, 'exams_subject', { id: options.subjectId })
  if (subject === null) throw new InvalidInput('必须指定科目')
  if (String(subject.project_id) !== String(options.projectId)) throw new ScopeViolation('科目不属于该项目')
  const name = String(options.name ?? '').trim()
  if (!name) throw new InvalidInput('家族名称不能为空')

  return transaction(db, () => {
    if (findOne(db, 'question_bank_family', { subject_id: subject.id, name }) !== null) {
      throw new InvalidInput('同一科目下已存在同名家族', { details: { name } })
    }
    const family = insertRow(
      db,
      'question_bank_family',
      {
        subject_id: subject.id,
        name: name.slice(0, FAMILY_NAME_LIMIT),
        note: String(options.note ?? '').slice(0, FAMILY_NOTE_LIMIT),
        relation_confirmed: false,
        revision: 1,
        merged_into_id: null,
        merged_at: null,
      },
      { now: options.now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'question_family',
        entity_id: String(family.id),
        action: 'create',
        project_id: options.projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { subject_id: String(subject.id), name: family.name },
      },
      { now: options.now },
    )
    return familyPayload(db, options.projectId, family)
  })
}

export function updateFamily(
  db: DatabaseSync,
  options: {
    projectId: string
    actorId: string
    familyId: string
    name?: string | null
    relationConfirmed?: boolean | null
    note?: string | null
    now: Instant
  },
): Record<string, unknown> {
  const family = requireFamilyInProject(db, options.projectId, options.familyId)
  const changed: Record<string, unknown> = {}
  if (options.name !== null && options.name !== undefined) {
    const name = options.name.trim()
    if (!name) throw new InvalidInput('家族名称不能为空')
    if (name !== family.name) {
      const clash = findOne(db, 'question_bank_family', { subject_id: family.subject_id, name })
      if (clash !== null && String(clash.id) !== String(family.id)) {
        throw new InvalidInput('同一科目下已存在同名家族', { details: { name } })
      }
    }
    changed.name = name.slice(0, FAMILY_NAME_LIMIT)
  }
  if (options.relationConfirmed !== null && options.relationConfirmed !== undefined) {
    changed.relation_confirmed = Boolean(options.relationConfirmed)
  }
  if (options.note !== null && options.note !== undefined) {
    changed.note = options.note.slice(0, FAMILY_NOTE_LIMIT)
  }
  if (Object.keys(changed).length === 0) return familyPayload(db, options.projectId, family)

  return transaction(db, () => {
    const updated = updateRow(db, 'question_bank_family', family.id, changed, { now: options.now })!
    const bump = Number(family.revision ?? 1) + 1
    const withRevision = updateRow(db, 'question_bank_family', family.id, { revision: bump }, { now: options.now })!
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'question_family',
        entity_id: String(family.id),
        action: 'update',
        project_id: options.projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { before: { name: family.name, note: family.note }, after: changed },
      },
      { now: options.now },
    )
    void updated
    return familyPayload(db, options.projectId, withRevision)
  })
}

/** Put one question into a family. Returns `{ question, changed }`. */
export function addQuestionToFamily(
  db: DatabaseSync,
  options: { projectId: string; actorId: string; familyId: string; questionId: string; now: Instant },
): { changed: boolean; family: Record<string, unknown> } {
  const family = requireFamilyInProject(db, options.projectId, options.familyId)
  const question = findOne(db, 'question_bank_question', { id: options.questionId })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (question === null || subject === null || String(subject.project_id) !== String(options.projectId)) {
    throw new ScopeViolation('题目不存在或不属于该项目')
  }
  if (String(question.subject_id) !== String(family.subject_id)) {
    throw new InvalidInput('题目与家族不属于同一科目，不能加入', {
      details: { question_subject_id: String(question.subject_id), family_subject_id: String(family.subject_id) },
    })
  }
  const sealed = sealedQuestionIds(db, options.projectId, [options.questionId])
  if (sealed.size > 0) {
    throw new PurposeNotAllowed(`封存内容不可加入家族：${reasonMessage('sealed_question_policy')}`, {
      details: { reason: 'sealed_question_policy', action: '加入家族' },
    })
  }
  if (sealedFamilyIds(db, options.projectId, [String(family.id)]).size > 0) {
    throw new PurposeNotAllowed(`封存内容不可加入家族：${reasonMessage(SEALED_FAMILY)}`, {
      details: { reason: SEALED_FAMILY, family_id: String(family.id), action: '加入家族' },
    })
  }
  if (question.family_id !== null && String(question.family_id) === String(family.id)) {
    return { changed: false, family: familyPayload(db, options.projectId, family) }
  }
  const previous = question.family_id === null ? null : String(question.family_id)
  return transaction(db, () => {
    updateRow(db, 'question_bank_question', question.id, { family_id: family.id }, { now: options.now })
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'question_family',
        entity_id: String(family.id),
        action: 'add_question',
        project_id: options.projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { question_id: String(question.id), previous_family_id: previous },
      },
      { now: options.now },
    )
    return { changed: true, family: familyPayload(db, options.projectId, family) }
  })
}

/** Move one question out of a family. A sealed family refuses this. */
export function removeQuestionFromFamily(
  db: DatabaseSync,
  options: { projectId: string; actorId: string; familyId: string; questionId: string; now: Instant },
): { changed: boolean } {
  const family = requireFamilyInProject(db, options.projectId, options.familyId)
  const question = findOne(db, 'question_bank_question', { id: options.questionId })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (question === null || subject === null || String(subject.project_id) !== String(options.projectId)) {
    throw new ScopeViolation('题目不存在或不属于该项目')
  }
  if (question.family_id === null || String(question.family_id) !== String(family.id)) {
    throw new InvalidInput('该题不在这个家族中', { details: { question_id: String(question.id) } })
  }
  if (sealedFamilyIds(db, options.projectId, [String(family.id)]).size > 0) {
    throw new PurposeNotAllowed(
      `封存内容不可移出家族：${reasonMessage(SEALED_FAMILY)}请先解除家族封存。`,
      { details: { reason: SEALED_FAMILY, family_id: String(family.id), action: '移出家族' } },
    )
  }
  return transaction(db, () => {
    updateRow(db, 'question_bank_question', question.id, { family_id: null }, { now: options.now })
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'question_family',
        entity_id: String(family.id),
        action: 'remove_question',
        project_id: options.projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { question_id: String(question.id) },
      },
      { now: options.now },
    )
    return { changed: true }
  })
}

// --------------------------------------------------------------------------
// Merge: absorb one near-duplicate family into another.
//
// Port of `apps/question_bank/services/families.py::merge_impact/merge_families`.
// The merge is the one place where *old proof* has to be withdrawn: after two
// families become one, an `unseen_variant` / `template_variant` row that existed
// because the questions were "different families" is no longer true. Rows are
// invalidated (never deleted), and the knowledge states that consumed them are
// recomputed, so a merge can lower a summary — that is the point, not a bug.
// --------------------------------------------------------------------------

/** The exact `invalidated_reason` C03 requires on stale evidence rows. */
export const MERGE_INVALIDATION_REASON = '家族合并后不再构成不同家族证据'

/** Dimensions that exist because two questions were *different* families. */
export const DISTINCTNESS_DIMENSIONS: readonly string[] = ['unseen_variant', 'template_variant']

interface ExposureLike {
  seen: boolean
  reasons: string[]
}

function questionIdsOfFamily(db: DatabaseSync, familyId: string): string[] {
  return findRows(db, 'question_bank_question', { family_id: familyId }).map((question) => String(question.id))
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

function validateMerge(
  db: DatabaseSync,
  projectId: string,
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  if (String(source.id) === String(target.id)) {
    throw new InvalidInput('不能把一个家族合并到它自身')
  }
  const sourceSubject = findOne(db, 'exams_subject', { id: String(source.subject_id) })
  const targetSubject = findOne(db, 'exams_subject', { id: String(target.subject_id) })
  if (
    sourceSubject === null ||
    targetSubject === null ||
    String(sourceSubject.project_id) !== String(projectId) ||
    String(targetSubject.project_id) !== String(projectId)
  ) {
    throw new ScopeViolation('题族不存在或不属于该项目')
  }
  if (String(source.subject_id) !== String(target.subject_id)) {
    throw new InvalidInput('跨科目的家族不能合并：近重复关系只在同一科目内有意义', {
      details: {
        source_subject_id: String(source.subject_id),
        target_subject_id: String(target.subject_id),
      },
    })
  }
  const foreignQuestions = findRows(db, 'question_bank_question', { family_id: source.id }).filter(
    (question) => String(question.subject_id) !== String(target.subject_id),
  )
  if (foreignQuestions.length > 0) {
    throw new InvalidInput('源家族存在不属于目标科目的问题，不能合并；请先修正家族归属')
  }
  if (source.merged_into_id !== null && source.merged_into_id !== undefined) {
    if (String(source.merged_into_id) !== String(target.id)) {
      throw new InvalidInput('该家族已合并到其他家族，不能再次合并', {
        details: { merged_into: String(source.merged_into_id) },
      })
    }
  }
}

/** The owner plus anyone with facts on the merged questions. */
function affectedUserIds(db: DatabaseSync, project: Record<string, unknown>, questionIds: string[]): string[] {
  const ids = new Set<string>([String(project.owner_id)])
  if (questionIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT DISTINCT e."user_id" AS user_id
           FROM "practice_learning_evidence" e
           JOIN "practice_attempt" a ON a."id" = e."attempt_id"
           JOIN "practice_session_item" si ON si."id" = a."session_item_id"
           JOIN "question_bank_question_version" v ON v."id" = si."question_version_id"
          WHERE v."question_id" IN (${placeholders(questionIds.length)})`,
      )
      .all(...(questionIds as never[])) as { user_id: string }[]
    for (const row of rows) ids.add(String(row.user_id))
  }
  const wanted = new Set(questionIds)
  for (const exposure of findRows(db, 'practice_exposure_event', {})) {
    if (wanted.has(String(exposure.question_id))) ids.add(String(exposure.user_id))
  }
  return [...ids].sort()
}

function exposureStates(
  db: DatabaseSync,
  userIds: readonly string[],
  projectId: string,
  questionIds: string[],
): Map<string, Map<string, ExposureLike>> {
  const out = new Map<string, Map<string, ExposureLike>>()
  if (questionIds.length === 0) return out
  for (const userId of userIds) {
    const facts = loadExposureFacts(db, userId)
    out.set(
      userId,
      exposureState(facts, { question_ids: questionIds, project_id: projectId }) as Map<string, ExposureLike>,
    )
  }
  return out
}

function seen(state: Map<string, ExposureLike> | undefined, questionId: string): boolean {
  return Boolean(state?.get(questionId)?.seen)
}

function seenCount(state: Map<string, ExposureLike> | undefined, questionIds: readonly string[]): number {
  return questionIds.reduce((total, questionId) => total + (seen(state, questionId) ? 1 : 0), 0)
}

interface StaleEvidenceRow {
  id: string
  user_id: string
  project_id: string
  node_id: string | null
}

/**
 * Active evidence the merge makes stale: the two distinctness dimensions for the
 * merged questions, or any row whose stored detail names the old family.
 */
function staleEvidenceQuery(mergedIds: string[], sourceFamilyId: string): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT e."id" AS id, e."user_id" AS user_id, e."project_id" AS project_id,
                 e."knowledge_node_id" AS node_id
            FROM "practice_learning_evidence" e
            JOIN "practice_attempt" a ON a."id" = e."attempt_id"
            JOIN "practice_session_item" si ON si."id" = a."session_item_id"
            JOIN "question_bank_question_version" v ON v."id" = si."question_version_id"
           WHERE e."is_active" = 1
             AND (
               (e."dimension" IN (${DISTINCTNESS_DIMENSIONS.map(() => '?').join(', ')})
                AND v."question_id" IN (${placeholders(mergedIds.length)}))
               OR e."detail" LIKE ? OR e."exclusion_reasons" LIKE ?
             )`,
    params: [...DISTINCTNESS_DIMENSIONS, ...mergedIds, `%${sourceFamilyId}%`, `%${sourceFamilyId}%`],
  }
}

function staleEvidenceRows(db: DatabaseSync, mergedIds: string[], sourceFamilyId: string): StaleEvidenceRow[] {
  if (mergedIds.length === 0) return []
  const { sql, params } = staleEvidenceQuery(mergedIds, sourceFamilyId)
  const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id),
    project_id: String(row.project_id),
    node_id: row.node_id === null || row.node_id === undefined ? null : String(row.node_id),
  }))
}

/**
 * Preview a merge with the same helpers the merge uses, so the numbers a human
 * approves are the numbers the merge produces.
 */
export function mergeImpact(
  db: DatabaseSync,
  projectId: string,
  sourceFamilyId: string,
  targetFamilyId: string,
): Record<string, unknown> {
  const project = requireProjectRow(db, projectId)
  const source = requireFamilyInProject(db, projectId, sourceFamilyId)
  const target = requireFamilyInProject(db, projectId, targetFamilyId)
  validateMerge(db, projectId, source, target)

  const sourceIds = questionIdsOfFamily(db, sourceFamilyId)
  const targetIds = questionIdsOfFamily(db, targetFamilyId)
  const mergedIds = [...new Set([...sourceIds, ...targetIds])].sort()
  const users = affectedUserIds(db, project, mergedIds)
  const before = exposureStates(db, users, projectId, mergedIds)
  const anyMemberSeen = (userStates: Map<string, ExposureLike> | undefined): boolean =>
    mergedIds.some((questionId) => seen(userStates, questionId))
  const predicted = new Map<string, number>()
  for (const userId of users) {
    const userStates = before.get(userId)
    predicted.set(userId, anyMemberSeen(userStates) ? mergedIds.length : seenCount(userStates, mergedIds))
  }
  const alreadyMerged =
    source.merged_into_id !== null &&
    source.merged_into_id !== undefined &&
    String(source.merged_into_id) === String(target.id)
  const ownerId = String(project.owner_id)
  return {
    project_id: projectId,
    source_family_id: sourceFamilyId,
    target_family_id: targetFamilyId,
    source_family_name: source.name,
    target_family_name: target.name,
    already_merged: alreadyMerged,
    questions_to_move: sourceIds.length,
    questions_in_target_after: mergedIds.length,
    evidence_rows_to_invalidate: alreadyMerged ? 0 : staleEvidenceRows(db, mergedIds, sourceFamilyId).length,
    affected_user_ids: users.slice().sort(),
    exposed_before_merge: seenCount(before.get(ownerId), mergedIds),
    exposed_after_merge: predicted.get(ownerId) ?? 0,
    exposed_question_ids_before_merge: mergedIds.filter((questionId) => seen(before.get(ownerId), questionId)),
  }
}

function requireProjectRow(db: DatabaseSync, projectId: string): Record<string, unknown> {
  const project = findOne(db, 'exams_project', { id: projectId })
  if (project === null) throw new ScopeViolation('项目不存在')
  return project
}

/** Absorb `sourceFamilyId` into `targetFamilyId`. Repeating the same merge is a no-op. */
export function mergeFamilies(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  sourceFamilyId: string,
  targetFamilyId: string,
  options: { reason?: string; now: Instant },
): Record<string, unknown> {
  const project = requireProjectRow(db, projectId)
  const source = requireFamilyInProject(db, projectId, sourceFamilyId)
  const target = requireFamilyInProject(db, projectId, targetFamilyId)
  validateMerge(db, projectId, source, target)

  return transaction(db, () => {
    const current = requireFamilyInProject(db, projectId, sourceFamilyId)
    const currentTarget = requireFamilyInProject(db, projectId, targetFamilyId)
    const mergedIds = [...questionIdsOfFamily(db, sourceFamilyId), ...questionIdsOfFamily(db, targetFamilyId)]
    const users = affectedUserIds(db, project, mergedIds)
    const before = exposureStates(db, users, projectId, mergedIds)
    const ownerId = String(project.owner_id)

    if (
      current.merged_into_id !== null &&
      current.merged_into_id !== undefined &&
      String(current.merged_into_id) === String(currentTarget.id)
    ) {
      const states = exposureStates(db, users, projectId, mergedIds)
      const exposed = seenCount(states.get(ownerId), mergedIds)
      return {
        project_id: projectId,
        source_family_id: sourceFamilyId,
        target_family_id: targetFamilyId,
        merge_revision: currentTarget.revision,
        questions_moved: 0,
        questions_in_target_after: mergedIds.length,
        evidence_invalidated: 0,
        states_recomputed: 0,
        exposed_before_merge: exposed,
        exposed_after_merge: exposed,
        exposure_changes: [],
        affected_user_ids: users.slice().sort(),
        noop: true,
        content_revision_id: null,
      }
    }

    // 1. Move the questions and record the merge itself (audit pair + revision).
    const moved = db
      .prepare('UPDATE "question_bank_question" SET "family_id" = ?, "updated_at" = ? WHERE "family_id" = ?')
      .run(
        String(currentTarget.id),
        formatPythonIso(options.now),
        String(current.id),
      ).changes
    const targetRevision = updateRow(
      db,
      'question_bank_family',
      currentTarget.id,
      { revision: Number(currentTarget.revision ?? 1) + 1 },
      { now: options.now },
    )!
    updateRow(
      db,
      'question_bank_family',
      current.id,
      { merged_into_id: currentTarget.id, merged_at: options.now },
      { now: options.now },
    )

    // 2. Recompute exposure through the C04 rule: one seen member contaminates
    //    the whole merged family.
    const after = exposureStates(db, users, projectId, mergedIds)
    const changes: Record<string, unknown>[] = []
    for (const [affectedUserId, statesAfter] of after) {
      const statesBefore = before.get(affectedUserId)
      for (const [questionId, stateAfter] of statesAfter) {
        if (stateAfter.seen && !seen(statesBefore, questionId)) {
          changes.push({
            user_id: affectedUserId,
            question_id: questionId,
            seen_before: false,
            seen_after: true,
            reasons: [...stateAfter.reasons],
          })
        }
      }
    }

    // 3. Invalidate (never delete) the evidence that claimed distinctness, then
    //    recompute the knowledge states that consumed it.
    const staleRows = staleEvidenceRows(db, mergedIds, sourceFamilyId)
    for (const row of staleRows) {
      updateRow(
        db,
        'practice_learning_evidence',
        row.id,
        { is_active: false, invalidated_at: options.now, invalidated_reason: MERGE_INVALIDATION_REASON },
        { now: options.now },
      )
    }
    const targets = new Map<string, { userId: string; projectId: string; nodeId: string }>()
    for (const row of staleRows) {
      if (row.node_id === null) continue
      targets.set(`${row.user_id}:${row.project_id}:${row.node_id}`, {
        userId: row.user_id,
        projectId: row.project_id,
        nodeId: row.node_id,
      })
    }
    for (const targetState of targets.values()) {
      refreshNodeState(db, targetState.userId, targetState.projectId, targetState.nodeId, options.now)
    }

    const revision = insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'question_family',
        entity_id: String(targetRevision.id),
        action: 'merge',
        project_id: projectId,
        reason: String(options.reason ?? '').slice(0, 500),
        before_digest: '',
        after_digest: '',
        detail: {
          source_family_id: String(current.id),
          source_family_name: current.name,
          target_family_id: String(targetRevision.id),
          target_family_name: targetRevision.name,
          target_revision: targetRevision.revision,
          questions_moved: Number(moved),
          merged_question_ids: mergedIds,
          evidence_invalidated: staleRows.length,
          invalidated_evidence_ids: staleRows.map((row) => row.id),
          invalidated_reason: MERGE_INVALIDATION_REASON,
          states_recomputed: targets.size,
          exposure_changes: changes,
        },
      },
      { now: options.now },
    )

    return {
      project_id: projectId,
      source_family_id: sourceFamilyId,
      target_family_id: targetFamilyId,
      merge_revision: targetRevision.revision,
      questions_moved: Number(moved),
      questions_in_target_after: mergedIds.length,
      evidence_invalidated: staleRows.length,
      states_recomputed: targets.size,
      exposed_before_merge: seenCount(before.get(ownerId), mergedIds),
      exposed_after_merge: seenCount(after.get(ownerId), mergedIds),
      exposure_changes: changes,
      affected_user_ids: users.slice().sort(),
      noop: false,
      content_revision_id: String(revision.id),
    }
  })
}
