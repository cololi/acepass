/**
 * Versioned knowledge mappings for a question version.
 *
 * Port of `backend/apps/question_bank/services/core.py::replace_knowledge_mappings` and the two
 * mapping routes.
 *
 * A mapping change never edits a revision: it writes a *new* revision and leaves the old rows
 * intact, because old evidence rows point at the revision that decided them. The weights are also a
 * closed contract — primary weights must sum to exactly 1, and an auxiliary node must weigh 0 so the
 * same score cannot be counted twice.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { findOne, findRows, insertRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import type { Instant } from '../domain/instant.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'

export interface MappingIn {
  node_id: string
  is_primary?: boolean
  score_weight?: string | number | null
  template_id?: string | null
  note?: string
}

const ONE = Decimal.parse('1')

function asWeight(value: unknown): Decimal {
  if (value === null || value === undefined || value === '') return Decimal.zero()
  return Decimal.parse(String(value))
}

function requireVersionInProject(
  db: DatabaseSync,
  projectId: string,
  versionId: string,
): {
  version: Record<string, unknown>
  question: Record<string, unknown>
  subject: Record<string, unknown>
} {
  const version = findOne(db, 'question_bank_question_version', { id: versionId })
  if (version === null) throw new ScopeViolation('题目版本不存在或不属于该项目')
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (question === null || subject === null || String(subject.project_id) !== String(projectId)) {
    throw new ScopeViolation('题目版本不存在或不属于该项目')
  }
  return { version, question, subject }
}

export function listMappings(
  db: DatabaseSync,
  projectId: string,
  versionId: string,
  options: { revision?: number | null } = {},
): Record<string, unknown>[] {
  requireVersionInProject(db, projectId, versionId)
  const rows = findRows(db, 'knowledge_question_mapping', { question_version_id: versionId })
    .filter(
      (row) =>
        options.revision === null ||
        options.revision === undefined ||
        Number(row.mapping_revision) === Number(options.revision),
    )
    .map((row) => {
      const node = findOne(db, 'knowledge_node', { id: String(row.node_id) })
      return {
        id: String(row.id),
        mapping_revision: row.mapping_revision,
        node_id: String(row.node_id),
        node_name: node === null ? '' : node.canonical_name,
        is_primary: Boolean(row.is_primary),
        score_weight: String(row.score_weight),
        template_id: row.template_id === null ? null : String(row.template_id),
      }
    })
  // Django orders by `mapping_revision, node__canonical_name`.
  return rows.sort((left, right) => {
    if (Number(left.mapping_revision) !== Number(right.mapping_revision)) {
      return Number(left.mapping_revision) - Number(right.mapping_revision)
    }
    return String(left.node_name).localeCompare(String(right.node_name), 'zh-Hans-CN')
  })
}

/**
 * Replace the mapping batch with a new revision.
 *
 * Returns the new rows. The previous revision stays readable, which is what lets an old evidence
 * row still explain which node it was decided under.
 */
export function replaceKnowledgeMappings(
  db: DatabaseSync,
  projectId: string,
  versionId: string,
  mappings: readonly MappingIn[],
  options: { actorId: string; now: Instant },
): Record<string, unknown>[] {
  const { version, question, subject } = requireVersionInProject(db, projectId, versionId)
  if (mappings.length === 0) {
    throw new InvalidInput('映射不能为空；未分类分值请显式映射到“未分类”节点')
  }

  const nodeIds = mappings.map((mapping) => String(mapping.node_id))
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new InvalidInput('同一考点不能重复映射')
  }

  const nodes = new Map<string, Record<string, unknown>>()
  for (const nodeId of nodeIds) {
    const node = findOne(db, 'knowledge_node', { id: nodeId })
    if (node !== null) nodes.set(nodeId, node)
  }
  if (nodes.size !== nodeIds.length) {
    throw new ScopeViolation('存在不属于可用大纲的考点')
  }
  for (const node of nodes.values()) {
    const syllabus = findOne(db, 'exams_syllabus_version', { id: String(node.syllabus_version_id) })
    if (syllabus === null || String(syllabus.subject_id) !== String(subject.id)) {
      throw new ScopeViolation('考点大纲与题目科目不一致')
    }
  }

  let primaryTotal = Decimal.zero()
  for (const mapping of mappings) {
    const isPrimary = mapping.is_primary ?? true
    if (isPrimary) primaryTotal = primaryTotal.add(asWeight(mapping.score_weight ?? '0'))
  }
  if (!primaryTotal.eq(ONE)) {
    throw new InvalidInput(
      `主要考点权重合计必须为 1（当前 ${primaryTotal.toString()}）；未分类分值请映射到显式“未分类”节点`,
      { details: { total: primaryTotal.toString() } },
    )
  }
  for (const mapping of mappings) {
    const isPrimary = mapping.is_primary ?? true
    if (!isPrimary && !asWeight(mapping.score_weight ?? '0').isZero()) {
      throw new InvalidInput('辅助考点权重必须为 0，避免重复计分')
    }
  }

  return transaction(db, () => {
    const last = db
      .prepare('SELECT MAX("mapping_revision") AS value FROM "knowledge_question_mapping" WHERE "question_version_id" = ?')
      .get(versionId) as { value: number | null }
    const revision = (last.value ?? 0) + 1

    const created: Record<string, unknown>[] = []
    for (const mapping of mappings) {
      const node = nodes.get(String(mapping.node_id))!
      const row = insertRow(
        db,
        'knowledge_question_mapping',
        {
          question_version_id: version.id,
          mapping_revision: revision,
          node_id: node.id,
          is_primary: mapping.is_primary ?? true,
          score_weight: asWeight(mapping.score_weight ?? '0'),
          template_id: mapping.template_id ?? null,
          note: String(mapping.note ?? '').slice(0, 300),
        },
        { now: options.now },
      )
      created.push({
        id: String(row.id),
        mapping_revision: row.mapping_revision,
        node_id: String(row.node_id),
        node_name: node.canonical_name,
        is_primary: Boolean(row.is_primary),
        score_weight: String(row.score_weight),
        template_id: row.template_id === null ? null : String(row.template_id),
      })
    }

    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'question_knowledge',
        entity_id: String(version.id),
        action: 'mapping_revision',
        project_id: projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { revision, count: created.length, question_id: String(question.id) },
      },
      { now: options.now },
    )
    return created
  })
}
