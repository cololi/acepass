/**
 * Knowledge nodes: the syllabus tree and the word-list import.
 *
 * Port of `backend/apps/knowledge/services/outline.py` (import + manual node creation).
 *
 * Two rules protect later statistics, and both are enforced here rather than by a constraint:
 *  - **synonyms merge, they do not duplicate.** A point imported twice (once as `导数`, once as
 *    `微分`) would split its score across two rows forever, so the second line merges into the first
 *    and the alternative becomes an alias;
 *  - **the tree stays a tree.** Re-parenting is checked against the node's own descendants, so a
 *    cycle is refused instead of creating a node unreachable from any root.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Instant } from '../domain/instant.ts'
import { KIND_BY_DEPTH, parseOutlineLine } from '../domain/outline.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import { requireProject } from './exams.ts'

export interface NodeIn {
  syllabus_version_id: string
  canonical_name: string
  kind?: string
  parent_id?: string | null
  code?: string
  aliases?: string[]
  is_unclassified?: boolean
  display_order?: number | null
}

export interface OutlineIn {
  text: string
  kind_by_depth?: Record<string, string>
}

function requireSyllabus(
  db: DatabaseSync,
  projectId: string,
  syllabusVersionId: string,
): Record<string, unknown> {
  const syllabus = findOne(db, 'exams_syllabus_version', { id: syllabusVersionId })
  if (syllabus === null) throw new ScopeViolation('大纲版本不存在或不属于该项目')
  const subject = findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
  if (subject === null || String(subject.project_id) !== String(projectId)) {
    throw new ScopeViolation('大纲版本不存在或不属于该项目')
  }
  return syllabus
}

export function listNodes(
  db: DatabaseSync,
  projectId: string,
  options: { syllabusVersionId?: string | null; subjectId?: string | null } = {},
): Record<string, unknown>[] {
  const subjectIds = new Set(findRows(db, 'exams_subject', { project_id: projectId }).map((row) => String(row.id)))
  const syllabi = findRows(db, 'exams_syllabus_version', {}).filter((syllabus) =>
    subjectIds.has(String(syllabus.subject_id)),
  )
  const allowedSyllabusIds = new Set(
    syllabi
      .filter(
        (syllabus) =>
          options.subjectId === null ||
          options.subjectId === undefined ||
          String(syllabus.subject_id) === String(options.subjectId),
      )
      .map((syllabus) => String(syllabus.id)),
  )
  return findRows(db, 'knowledge_node', {})
    .filter((node) => allowedSyllabusIds.has(String(node.syllabus_version_id)))
    .filter(
      (node) =>
        options.syllabusVersionId === null ||
        options.syllabusVersionId === undefined ||
        String(node.syllabus_version_id) === String(options.syllabusVersionId),
    )
    .sort((a, b) => Number(a.display_order) - Number(b.display_order))
    .map((node) => nodeOut(node))
}

export function nodeOut(node: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(node.id),
    syllabus_version_id: String(node.syllabus_version_id),
    parent_id: node.parent_id === null ? null : String(node.parent_id),
    kind: node.kind,
    canonical_name: node.canonical_name,
    code: node.code,
    aliases: node.aliases ?? [],
    is_unclassified: node.is_unclassified,
    display_order: node.display_order,
  }
}

export function createNode(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: NodeIn,
  now: Instant,
): Record<string, unknown> {
  const syllabus = requireSyllabus(db, projectId, payload.syllabus_version_id)
  // A published outline is the frozen reference for mappings; adding points to a draft would let a
  // mapping point at a node nobody has agreed to.
  if (syllabus.status !== 'published') {
    throw new InvalidInput('只能向已发布的大纲版本添加考点；请先发布大纲')
  }
  let parent: Record<string, unknown> | null = null
  if (payload.parent_id !== null && payload.parent_id !== undefined && payload.parent_id !== '') {
    parent = findOne(db, 'knowledge_node', {
      id: payload.parent_id,
      syllabus_version_id: syllabus.id,
    })
    if (parent === null) throw new ScopeViolation('父考点不存在或不属于该大纲版本')
  }
  const name = String(payload.canonical_name ?? '').trim()
  if (!name) throw new InvalidInput('考点名称不能为空')

  return transaction(db, () => {
    const siblings = findRows(db, 'knowledge_node', {
      syllabus_version_id: syllabus.id,
      parent_id: parent === null ? null : parent.id,
    })
    // The unique index is (syllabus_version, parent, canonical_name); a duplicate here would surface
    // as a raw constraint error, so it is reported as a business error instead.
    if (siblings.some((node) => String(node.canonical_name) === name)) {
      throw new InvalidInput('同一父节点下已存在同名考点', { details: { name } })
    }
    const node = insertRow(
      db,
      'knowledge_node',
      {
        syllabus_version_id: syllabus.id,
        parent_id: parent === null ? null : parent.id,
        kind: String(payload.kind ?? 'point'),
        canonical_name: name,
        code: String(payload.code ?? ''),
        aliases: payload.aliases ?? [],
        is_unclassified: payload.is_unclassified ?? false,
        display_order: payload.display_order ?? siblings.length + 1,
      },
      { now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'knowledge_node',
        entity_id: String(node.id),
        action: 'create',
        project_id: projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { canonical_name: name, parent_id: parent === null ? null : String(parent.id) },
      },
      { now },
    )
    return nodeOut(node)
  })
}

/** Every node below `node` (breadth-first, cycle-safe). */
export function descendants(db: DatabaseSync, nodeId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([nodeId])
  const frontier = [nodeId]
  while (frontier.length > 0) {
    const current = frontier.shift()!
    for (const child of findRows(db, 'knowledge_node', { parent_id: current })) {
      const id = String(child.id)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      frontier.push(id)
    }
  }
  return out
}

export interface NodePatch {
  canonical_name?: string | null
  kind?: string | null
  parent_id?: string | null
  code?: string | null
  aliases?: string[] | null
  display_order?: number | null
}

export function patchNode(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  nodeId: string,
  payload: NodePatch,
  now: Instant,
): Record<string, unknown> {
  const node = findOne(db, 'knowledge_node', { id: nodeId })
  if (node === null) throw new ScopeViolation('考点不存在或不属于该项目')
  requireSyllabus(db, projectId, String(node.syllabus_version_id))
  const syllabus = findOne(db, 'exams_syllabus_version', { id: String(node.syllabus_version_id) })!
  if (syllabus.status !== 'published') throw new InvalidInput('只能修改已发布大纲中的考点')

  const patch: Record<string, unknown> = {}
  if (payload.canonical_name !== null && payload.canonical_name !== undefined) {
    const name = payload.canonical_name.trim()
    if (!name) throw new InvalidInput('考点名称不能为空')
    patch.canonical_name = name
  }
  for (const key of ['kind', 'code', 'aliases', 'display_order'] as const) {
    const value = payload[key]
    if (value !== null && value !== undefined) patch[key] = value
  }
  if (payload.parent_id !== undefined) {
    const nextParentId = payload.parent_id === null || payload.parent_id === '' ? null : String(payload.parent_id)
    if (nextParentId === String(node.id)) {
      throw new InvalidInput('考点不能以自身为父（会形成环）', { details: { node_id: String(node.id) } })
    }
    if (nextParentId !== null) {
      // The tree stays a tree: an unchecked re-parent into a descendant makes the node unreachable
      // from any root and every later depth-first walk loops.
      if (descendants(db, String(node.id)).includes(nextParentId)) {
        throw new InvalidInput('不能把考点移动到自己的子节点下：会形成环，之后的覆盖统计将无法回到根节点', {
          details: { node_id: String(node.id), parent_id: nextParentId },
        })
      }
      const parent = findOne(db, 'knowledge_node', {
        id: nextParentId,
        syllabus_version_id: node.syllabus_version_id,
      })
      if (parent === null) throw new ScopeViolation('父考点不存在或不属于该大纲版本')
    }
    patch.parent_id = nextParentId
  }

  if (Object.keys(patch).length === 0) return nodeOut(node)
  return transaction(db, () => {
    const updated = updateRow(db, 'knowledge_node', node.id, patch, { now })!
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'knowledge_node',
        entity_id: String(node.id),
        action: 'update',
        project_id: projectId,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { before: { name: node.canonical_name, parent_id: node.parent_id }, after: patch },
      },
      { now },
    )
    return nodeOut(updated)
  })
}

/** Same-name or same-alias lines merge into one node instead of duplicating a point. */
function findExisting(
  db: DatabaseSync,
  syllabusVersionId: string,
  parentId: string | null,
  name: string,
  aliases: readonly string[],
): Record<string, unknown> | null {
  const siblings = findRows(db, 'knowledge_node', { syllabus_version_id: syllabusVersionId, parent_id: parentId })
  const byName = siblings.find((node) => String(node.canonical_name) === name)
  if (byName !== undefined) return byName
  for (const alias of aliases) {
    const byAliasName = siblings.find((node) => String(node.canonical_name) === alias)
    if (byAliasName !== undefined) return byAliasName
    const byAliasList = siblings.find((node) =>
      ((node.aliases ?? []) as string[]).includes(alias),
    )
    if (byAliasList !== undefined) return byAliasList
  }
  return null
}

function mergeAliases(
  db: DatabaseSync,
  node: Record<string, unknown>,
  aliases: readonly string[],
  now: Instant,
): string[] {
  const current = (node.aliases ?? []) as string[]
  const added = aliases.filter((alias) => !current.includes(alias) && alias !== node.canonical_name)
  if (added.length > 0) {
    updateRow(db, 'knowledge_node', node.id, { aliases: [...current, ...added] }, { now })
  }
  return added
}

export interface OutlineReport {
  created: number
  merged: number
  aliases_added: { node_id: string; aliases: string[] }[]
  skipped: { line: number; text: string; reason: string; node_id?: string }[]
  node_count: number
}

/** Build the node tree of one syllabus from its word list. */
export function importOutline(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  syllabusVersionId: string,
  payload: OutlineIn,
  now: Instant,
): OutlineReport {
  const syllabus = requireSyllabus(db, projectId, syllabusVersionId)
  if (String(payload.text ?? '').trim() === '') throw new InvalidInput('词表内容不能为空')
  const kinds: Record<string, string> = { ...stringifyKeys(KIND_BY_DEPTH), ...(payload.kind_by_depth ?? {}) }

  return transaction(db, () => {
    let created = 0
    let merged = 0
    const aliasesAdded: OutlineReport['aliases_added'] = []
    const skipped: OutlineReport['skipped'] = []
    // `parents[depth]` is the last node at that depth, so the next line knows its parent. Deeper
    // entries are dropped as soon as a shallower line appears, which keeps a malformed word list
    // from nesting under a node it never mentioned.
    const parents = new Map<number, Record<string, unknown>>()

    const lines = String(payload.text).split(/\r?\n/)
    lines.forEach((rawLine, index) => {
      const parsed = parseOutlineLine(rawLine)
      if (parsed === null) return
      const lineNumber = index + 1
      const parent = parsed.depth > 0 ? parents.get(parsed.depth - 1) ?? null : null
      const existing = findExisting(db, String(syllabus.id), parent === null ? null : String(parent.id), parsed.name, parsed.aliases)
      let node: Record<string, unknown>
      if (existing !== null) {
        merged += 1
        const added = mergeAliases(db, existing, parsed.aliases, now)
        if (added.length > 0) aliasesAdded.push({ node_id: String(existing.id), aliases: added })
        node = existing
        if (parent !== null && String(existing.parent_id) !== String(parent.id)) {
          skipped.push({
            line: lineNumber,
            text: rawLine.slice(0, 120),
            reason: 'merged_across_levels',
            node_id: String(existing.id),
          })
        }
      } else {
        node = insertRow(
          db,
          'knowledge_node',
          {
            syllabus_version_id: syllabus.id,
            parent_id: parent === null ? null : parent.id,
            kind: kinds[String(parsed.depth)] ?? 'point',
            canonical_name: parsed.name,
            code: '',
            aliases: parsed.aliases,
            is_unclassified: false,
            display_order: lineNumber,
          },
          { now },
        )
        created += 1
        insertRow(
          db,
          'audit_content_revision',
          {
            actor_id: userId,
            entity_type: 'knowledge_node',
            entity_id: String(node.id),
            action: 'create_from_outline',
            project_id: projectId,
            reason: '',
            before_digest: '',
            after_digest: '',
            detail: { depth: parsed.depth, line: lineNumber },
          },
          { now },
        )
      }
      parents.set(parsed.depth, node)
      for (const deeper of [...parents.keys()]) if (deeper > parsed.depth) parents.delete(deeper)
    })

    return {
      created,
      merged,
      aliases_added: aliasesAdded,
      skipped,
      node_count: findRows(db, 'knowledge_node', { syllabus_version_id: syllabus.id }).length,
    }
  })
}

function stringifyKeys(input: Record<number, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [String(key), value]))
}
