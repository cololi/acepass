/**
 * The rest of the knowledge domain: templates, pairings, the knowledge map, the prerequisite graph.
 *
 * Port of `backend/apps/knowledge/api.py` (the read/write projections) plus
 * `apps/knowledge/services/core.py::create_question_template` and
 * `apps/knowledge/services/relations.py` (the graph rules). The web client's Knowledge page reads
 * every one of these, and the acceptance suite asserts on three of them directly:
 *
 *  * `GET /knowledge-map` — the tree with real evidence counts, never a simulated number;
 *  * `GET/POST/DELETE /knowledge-relations` — an edge that would close a cycle is refused **with the
 *    path**, because "A needs B and B needs A" has no study order to derive;
 *  * `GET /knowledge-nodes/{id}/prerequisites` — which prerequisites still block, and why.
 *
 * The graph only *reorders* work: it never invents a score, never changes a knowledge state, and a
 * missing prerequisite question is reported rather than silently replaced by the dependent one.
 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { findOne, findRows, insertRow, updateRow } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'
import { requireProject, requireSubject } from './exams.ts'
import {
  createVerificationPairing,
  pairingCandidates,
  resolvePairingTargets,
  type PairingCreateIn,
} from './pairing.ts'

type Row = Record<string, unknown>

/** `KnowledgeStateSummary` values that count as "the learner can do this unaided". */
export const SATISFIED_STATES: ReadonlySet<string> = new Set(['independent', 'handles_unseen', 'delayed_verified'])

const RELATION_TYPES: ReadonlySet<string> = new Set(['prerequisite', 'related'])
const RELATION_TYPE_PREREQUISITE = 'prerequisite'

/* --------------------------------------------------------------- templates */

export interface TemplateIn {
  subject_id: string
  name: string
  description?: string
}

/** `TemplateOut`. */
export function templateOut(template: Row): Row {
  return {
    id: String(template.id),
    subject_id: String(template.subject_id),
    name: template.name,
    description: template.description,
    review_status: template.review_status,
  }
}

/** Every template of the project's subjects, optionally narrowed to one subject. */
export function listTemplates(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null } = {},
): Row[] {
  const project = requireProject(db, userId, projectId)
  if (options.subjectId !== null && options.subjectId !== undefined) {
    requireSubject(db, userId, String(project.id), options.subjectId)
  }
  const subjectIds = new Set(
    findRows(db, 'exams_subject', { project_id: project.id })
      .filter(
        (subject) =>
          options.subjectId === null || options.subjectId === undefined || String(subject.id) === options.subjectId,
      )
      .map((subject) => String(subject.id)),
  )
  return findRows(db, 'knowledge_question_template', {})
    .filter((template) => subjectIds.has(String(template.subject_id)))
    // `Meta.ordering = ["subject", "name"]`.
    .sort((left, right) => {
      const bySubject = compareText(String(left.subject_id), String(right.subject_id))
      return bySubject !== 0 ? bySubject : compareText(String(left.name), String(right.name))
    })
    .map((template) => templateOut(template))
}

/**
 * `create_question_template`: get-or-create per (subject, name).
 *
 * A repeated name reuses the row instead of splitting the same "way of asking" into two identities —
 * template diversity is what `distinct_template_count` counts, so a duplicate would make one way of
 * asking look like two. A non-empty description still updates the existing row.
 */
export function createTemplate(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: TemplateIn,
  now: Instant,
): Row {
  const subject = requireSubject(db, userId, projectId, String(payload.subject_id))
  const name = String(payload.name ?? '').trim()
  if (name === '') throw new InvalidInput('模板名称不能为空')
  const description = String(payload.description ?? '')
  return transaction(db, () => {
    const existing = findOne(db, 'knowledge_question_template', { subject_id: subject.id, name })
    if (existing !== null) {
      if (description !== '') {
        return templateOut(
          updateRow(db, 'knowledge_question_template', existing.id, { description: description.slice(0, 500) }, { now })!,
        )
      }
      return templateOut(existing)
    }
    return templateOut(
      insertRow(
        db,
        'knowledge_question_template',
        {
          subject_id: subject.id,
          name,
          description: description.slice(0, 500),
          review_status: 'approved',
          confirmed_by_id: userId,
        },
        { now },
      ),
    )
  })
}

/* ---------------------------------------------------------------- pairings */

/**
 * `_pairing_out`.
 *
 * `gap` is not decoration: a pairing without a C question cannot produce delayed-verification
 * evidence, and the reviewer has to be told that before the lesson, not after the deadline.
 */
export function pairingOut(db: DatabaseSync, pairing: Row): Row {
  const node = findOne(db, 'knowledge_node', { id: String(pairing.node_id) })
  const gap =
    pairing.delayed_question_id === null
      ? '缺少延迟验证题（C 题）：到期后只能用原题重复练习，不计入延迟验证证据'
      : ''
  return {
    id: String(pairing.id),
    project_id: String(pairing.project_id),
    subject_id: String(pairing.subject_id),
    node_id: String(pairing.node_id),
    node_name: node === null ? '' : String(node.canonical_name),
    baseline_question_id:
      pairing.baseline_question_id === null ? null : String(pairing.baseline_question_id),
    immediate_question_id: String(pairing.immediate_question_id),
    delayed_question_id: pairing.delayed_question_id === null ? null : String(pairing.delayed_question_id),
    pairing_version: Number(pairing.pairing_version),
    delay_hours: Number(pairing.delay_hours),
    is_active: Boolean(pairing.is_active),
    reviewed_at: pairing.reviewed_at === null ? null : formatPythonIso(pairing.reviewed_at as Instant),
    note: pairing.note,
    gap,
  }
}

/** Every pairing of the project (optionally one subject / one node), newest version first. */
export function listPairings(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null; nodeId?: string | null } = {},
): Row[] {
  const project = requireProject(db, userId, projectId)
  if (options.subjectId !== null && options.subjectId !== undefined) {
    requireSubject(db, userId, String(project.id), options.subjectId)
  }
  return findRows(db, 'knowledge_verification_pairing', { project_id: project.id })
    .filter(
      (pairing) =>
        (options.subjectId === null || options.subjectId === undefined || String(pairing.subject_id) === options.subjectId) &&
        (options.nodeId === null || options.nodeId === undefined || String(pairing.node_id) === options.nodeId),
    )
    // `Meta.ordering = ["project", "subject", "node", "-pairing_version"]`.
    .sort((left, right) => {
      const bySubject = compareText(String(left.subject_id), String(right.subject_id))
      if (bySubject !== 0) return bySubject
      const byNode = compareText(String(left.node_id), String(right.node_id))
      if (byNode !== 0) return byNode
      return Number(right.pairing_version) - Number(left.pairing_version)
    })
    .map((pairing) => pairingOut(db, pairing))
}

/** `create_pairing`: scope first (Django's order), then one versioned pairing row. */
export function createPairing(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: PairingCreateIn,
  now: Instant,
): Row {
  const targets = resolvePairingTargets(db, userId, projectId, payload)
  const pairing = createVerificationPairing(
    db,
    userId,
    projectId,
    targets,
    {
      delayHours: payload.delay_hours ?? 24,
      note: payload.note ?? '',
    },
    now,
  )
  return pairingOut(db, pairing)
}

/**
 * One pairing plus the questions that could serve as A/B/C.
 *
 * The candidate list is computed from the node's primary mappings, so the reviewer sees what the
 * product would accept instead of a free-text question id.
 */
export function getPairingDetail(db: DatabaseSync, userId: string, projectId: string, pairingId: string): Row {
  const project = requireProject(db, userId, projectId)
  const pairing = findOne(db, 'knowledge_verification_pairing', { id: pairingId, project_id: project.id })
  if (pairing === null) throw new ScopeViolation('配对不存在或不属于该项目')
  const candidates = pairingCandidates(db, String(pairing.node_id)).map((question) => {
    const published =
      question.current_published_version_id === null
        ? null
        : findOne(db, 'question_bank_question_version', { id: String(question.current_published_version_id) })
    return {
      id: String(question.id),
      display_label: question.display_label,
      question_type: published === null ? null : published.question_type,
    }
  })
  return { pairing: pairingOut(db, pairing), candidates }
}

/* ----------------------------------------------------------- knowledge map */

/**
 * Tree of nodes with real evidence counts; nothing is simulated.
 *
 * Only **published** syllabi participate: a draft outline is not the reference a mapping or a state
 * may point at, so showing its nodes in the map would offer points nobody has agreed to.
 */
export function knowledgeMap(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId: string; syllabusVersionId?: string | null },
): Row {
  const project = requireProject(db, userId, projectId)
  const subject = requireSubject(db, userId, String(project.id), options.subjectId)
  const syllabi = findRows(db, 'exams_syllabus_version', { subject_id: subject.id, status: 'published' }).filter(
    (syllabus) =>
      options.syllabusVersionId === null ||
      options.syllabusVersionId === undefined ||
      String(syllabus.id) === options.syllabusVersionId,
  )
  const syllabusById = new Map(syllabi.map((syllabus) => [String(syllabus.id), syllabus]))
  const nodes = findRows(db, 'knowledge_node', {})
    .filter((node) => syllabusById.has(String(node.syllabus_version_id)))
    .sort((left, right) => compareNodes(left, right))

  const states = new Map(
    findRows(db, 'learning_knowledge_state', { user_id: userId, project_id: project.id }).map((state) => [
      String(state.node_id),
      state,
    ]),
  )
  const payload = nodes.map((node) => {
    const syllabus = syllabusById.get(String(node.syllabus_version_id))!
    const state = states.get(String(node.id)) ?? null
    return {
      id: String(node.id),
      parent_id: node.parent_id === null ? null : String(node.parent_id),
      kind: node.kind,
      name: node.canonical_name,
      is_unclassified: node.is_unclassified,
      syllabus_version_id: String(node.syllabus_version_id),
      syllabus_is_user_provisional: Boolean(syllabus.is_user_provisional),
      question_count: findRows(db, 'knowledge_question_mapping', { node_id: node.id, is_primary: true }).length,
      evidence: {
        summary: state === null ? 'undiagnosed' : state.summary,
        best_summary: state === null ? 'undiagnosed' : state.best_summary,
        independent_correct_count: state === null ? 0 : Number(state.independent_correct_count),
        distinct_question_count: state === null ? 0 : Number(state.distinct_question_count),
        distinct_template_count: state === null ? 0 : Number(state.distinct_template_count),
        has_delayed_correct: state === null ? false : Boolean(state.has_delayed_correct),
        needs_review: state === null ? false : Boolean(state.needs_review),
        downgrade_reason: state === null ? '' : String(state.downgrade_reason),
        as_of: state === null ? null : formatPythonIso(state.as_of as Instant),
        rule_version: state === null ? null : state.rule_version,
      },
    }
  })
  return { subject_id: String(subject.id), nodes: payload }
}

/** `order_by("display_order", "canonical_name")`. */
function compareNodes(left: Row, right: Row): number {
  const byOrder = Number(left.display_order) - Number(right.display_order)
  return byOrder !== 0 ? byOrder : compareText(String(left.canonical_name), String(right.canonical_name))
}

/* --------------------------------------------------------------- relations */

/** `_relation_out`. */
export function relationOut(db: DatabaseSync, relation: Row): Row {
  const fromNode = findOne(db, 'knowledge_node', { id: String(relation.from_node_id) })
  const toNode = findOne(db, 'knowledge_node', { id: String(relation.to_node_id) })
  return {
    id: String(relation.id),
    syllabus_version_id: String(relation.syllabus_version_id),
    from_node_id: String(relation.from_node_id),
    from_node_name: fromNode === null ? '' : String(fromNode.canonical_name),
    to_node_id: String(relation.to_node_id),
    to_node_name: toNode === null ? '' : String(toNode.canonical_name),
    relation_type: relation.relation_type,
    is_active: Boolean(relation.is_active),
    note: relation.note,
  }
}

/** `active_relations`, in the model's ordering (`relation_type`, `created_at`). */
export function activeRelations(
  db: DatabaseSync,
  syllabusVersionId: string,
  relationType?: string | null,
): Row[] {
  return findRows(db, 'knowledge_relation', { syllabus_version_id: syllabusVersionId, is_active: true })
    .filter(
      (relation) =>
        relationType === null || relationType === undefined || String(relation.relation_type) === relationType,
    )
    .sort((left, right) => {
      const byType = compareText(String(left.relation_type), String(right.relation_type))
      if (byType !== 0) return byType
      const byCreated = Number(left.created_at) - Number(right.created_at)
      return byCreated !== 0 ? byCreated : compareText(String(left.id), String(right.id))
    })
}

/** `_adjacency`: `from_node_id → {to_node_id}` for the active edges of one type. */
function adjacency(db: DatabaseSync, syllabusVersionId: string, relationType: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>()
  for (const relation of activeRelations(db, syllabusVersionId, relationType)) {
    const from = String(relation.from_node_id)
    const bucket = graph.get(from) ?? new Set<string>()
    bucket.add(String(relation.to_node_id))
    graph.set(from, bucket)
  }
  return graph
}

/**
 * `find_cycle_path`: the path that adding `from → to` would close, or null.
 *
 * Adding the edge creates a cycle exactly when `to` can already reach `from`; the returned path
 * starts at `from` and ends back at it, so the reviewer sees the real mistake.
 */
export function findCyclePath(
  db: DatabaseSync,
  syllabusVersionId: string,
  fromNodeId: string,
  toNodeId: string,
  relationType: string,
): string[] | null {
  const graph = adjacency(db, syllabusVersionId, relationType)
  const start = toNodeId
  const goal = fromNodeId
  if (start === goal) return [start, goal]
  const previous = new Map<string, string | null>([[start, null]])
  const queue: string[] = [start]
  while (queue.length > 0) {
    const current = queue.shift()!
    const neighbours = [...(graph.get(current) ?? new Set<string>())].sort(compareText)
    for (const neighbour of neighbours) {
      if (previous.has(neighbour)) continue
      previous.set(neighbour, current)
      if (neighbour === goal) {
        const path = [goal]
        let node: string | null = current
        while (node !== null) {
          path.push(node)
          node = previous.get(node) ?? null
        }
        path.reverse()
        return [goal, ...path]
      }
      queue.push(neighbour)
    }
  }
  return null
}

/** `_names`: canonical names of a path, keeping the path's order. */
function nodeNames(db: DatabaseSync, nodeIds: readonly string[]): string[] {
  const names = new Map(
    findRows(db, 'knowledge_node', {}).map((node) => [String(node.id), String(node.canonical_name)]),
  )
  return nodeIds.map((nodeId) => names.get(nodeId) ?? nodeId)
}

/** `GraphOut`: active edges of every syllabus in scope, plus how many nodes they connect. */
export function listRelations(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null; syllabusVersionId?: string | null },
  now: Instant,
): Row {
  const project = requireProject(db, userId, projectId)
  if (options.subjectId !== null && options.subjectId !== undefined) {
    requireSubject(db, userId, String(project.id), options.subjectId)
  }
  const subjectIds = new Set(
    findRows(db, 'exams_subject', { project_id: project.id })
      .filter(
        (subject) =>
          options.subjectId === null || options.subjectId === undefined || String(subject.id) === options.subjectId,
      )
      .map((subject) => String(subject.id)),
  )
  const syllabi = findRows(db, 'exams_syllabus_version', {})
    .filter((syllabus) => subjectIds.has(String(syllabus.subject_id)))
    .filter(
      (syllabus) =>
        options.syllabusVersionId === null ||
        options.syllabusVersionId === undefined ||
        String(syllabus.id) === options.syllabusVersionId,
    )
    // `Meta.ordering = ["-created_at"]`; the id only breaks a same-microsecond tie.
    .sort((left, right) => {
      const byCreated = Number(right.created_at) - Number(left.created_at)
      return byCreated !== 0 ? byCreated : compareText(String(left.id), String(right.id))
    })
  const edges: Row[] = []
  for (const syllabus of syllabi) {
    edges.push(...activeRelations(db, String(syllabus.id)))
  }
  const syllabusIds = new Set(syllabi.map((syllabus) => String(syllabus.id)))
  const nodeCount = findRows(db, 'knowledge_node', {}).filter((node) =>
    syllabusIds.has(String(node.syllabus_version_id)),
  ).length
  return {
    edges: edges.map((relation) => relationOut(db, relation)),
    node_count: nodeCount,
    edge_count: edges.length,
    generated_at: formatPythonIso(now),
    unmet_prerequisites: [],
  }
}

/**
 * `add_relation`: one edge, refusing anything that would break the graph.
 *
 * The edge is *evidence*, not scratch state: deactivating keeps the row, so a recommendation
 * produced last month can still be explained today.
 */
export function createRelation(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: {
    syllabus_version_id: string
    from_node_id: string
    to_node_id: string
    relation_type?: string
    note?: string
  },
  now: Instant,
): Row {
  const project = requireProject(db, userId, projectId)
  const syllabus = findOne(db, 'exams_syllabus_version', { id: payload.syllabus_version_id })
  if (syllabus === null) throw new ScopeViolation('大纲版本不存在或不属于该项目')
  const ownerSubject = findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
  if (ownerSubject === null || String(ownerSubject.project_id) !== String(project.id)) {
    throw new ScopeViolation('大纲版本不存在或不属于该项目')
  }
  const fromNode = findOne(db, 'knowledge_node', {
    id: payload.from_node_id,
    syllabus_version_id: syllabus.id,
  })
  const toNode = findOne(db, 'knowledge_node', { id: payload.to_node_id, syllabus_version_id: syllabus.id })
  if (fromNode === null || toNode === null) throw new ScopeViolation('关系两端的考点必须属于该大纲版本')
  const relationType = String(payload.relation_type ?? RELATION_TYPE_PREREQUISITE)
  const note = String(payload.note ?? '')

  return transaction(db, () => {
    if (String(fromNode.id) === String(toNode.id)) {
      throw new InvalidInput('考点不能以自身为前置或相关关系')
    }
    if (!RELATION_TYPES.has(relationType)) {
      throw new InvalidInput('未知的关系类型', { details: { relation_type: relationType } })
    }
    const cycle = findCyclePath(db, String(syllabus.id), String(fromNode.id), String(toNode.id), relationType)
    if (cycle !== null) {
      throw new InvalidInput('加入该关系会形成环，已拒绝', {
        details: { cycle_node_ids: cycle, cycle_names: nodeNames(db, cycle) },
      })
    }
    const existing = findOne(db, 'knowledge_relation', {
      from_node_id: fromNode.id,
      to_node_id: toNode.id,
      relation_type: relationType,
    })
    if (existing !== null) {
      if (!existing.is_active) {
        const nextNote = (note !== '' ? note : String(existing.note)).slice(0, 300)
        return relationOut(
          db,
          updateRow(db, 'knowledge_relation', existing.id, { is_active: true, note: nextNote }, { now })!,
        )
      }
      // Re-adding an already active edge is the same edge, not a second one.
      return relationOut(db, existing)
    }
    const relation = insertRow(
      db,
      'knowledge_relation',
      {
        syllabus_version_id: syllabus.id,
        from_node_id: fromNode.id,
        to_node_id: toNode.id,
        relation_type: relationType,
        is_active: true,
        note: note.slice(0, 300),
        created_by_id: userId,
      },
      { now },
    )
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'knowledge_relation',
        entity_id: String(relation.id),
        action: 'create',
        project_id: project.id,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: {
          from_node: String(fromNode.id),
          to_node: String(toNode.id),
          relation_type: relationType,
        },
      },
      { now },
    )
    return relationOut(db, relation)
  })
}

/** `deactivate_relation`: mark the edge inactive and keep the row for the audit trail. */
export function deactivateRelation(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  relationId: string,
  reason: string,
  now: Instant,
): Row {
  const project = requireProject(db, userId, projectId)
  const relation = findOne(db, 'knowledge_relation', { id: relationId })
  if (relation === null) throw new ScopeViolation('关系不存在或不属于该项目')
  const syllabus = findOne(db, 'exams_syllabus_version', { id: String(relation.syllabus_version_id) })
  const subject = syllabus === null ? null : findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
  if (subject === null || String(subject.project_id) !== String(project.id)) {
    throw new ScopeViolation('关系不存在或不属于该项目')
  }
  if (!relation.is_active) return relationOut(db, relation)
  return transaction(db, () => {
    const updated = updateRow(
      db,
      'knowledge_relation',
      relation.id,
      { is_active: false, note: (reason !== '' ? reason : String(relation.note)).slice(0, 300) },
      { now },
    )!
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: userId,
        entity_type: 'knowledge_relation',
        entity_id: String(relation.id),
        action: 'deactivate',
        project_id: project.id,
        reason: reason.slice(0, 500),
        before_digest: '',
        after_digest: '',
        detail: {},
      },
      { now },
    )
    return relationOut(db, updated)
  })
}

/* ----------------------------------------------------------- prerequisites */

/** `prerequisite_nodes`: the direct prerequisites of one node, in the relation's order. */
export function prerequisiteNodes(db: DatabaseSync, node: Row): Row[] {
  return activeRelations(db, String(node.syllabus_version_id), RELATION_TYPE_PREREQUISITE)
    .filter((relation) => String(relation.to_node_id) === String(node.id))
    .map((relation) => findOne(db, 'knowledge_node', { id: String(relation.from_node_id) }))
    .filter((prerequisite): prerequisite is Row => prerequisite !== null)
}

/**
 * `unmet_prerequisites`: prerequisites that are not yet demonstrated, with the reason why.
 *
 * A node with no state at all is *undiagnosed*, which is not the same as "known": it is reported as
 * unmet so the planner schedules the foundation first.
 */
export function unmetPrerequisites(
  db: DatabaseSync,
  node: Row,
  stateByNode: ReadonlyMap<string, string>,
): Row[] {
  const unmet: Row[] = []
  for (const prerequisite of prerequisiteNodes(db, node)) {
    const summary = stateByNode.get(String(prerequisite.id))
    if (summary !== undefined && SATISFIED_STATES.has(summary)) continue
    const reason =
      summary === undefined
        ? 'prerequisite_undiagnosed'
        : summary === 'needs_review'
          ? 'prerequisite_needs_review'
          : 'prerequisite_not_independent'
    unmet.push({
      node_id: String(prerequisite.id),
      node_name: prerequisite.canonical_name,
      state: summary === undefined || summary === '' ? 'undiagnosed' : summary,
      reason,
    })
  }
  return unmet.sort((left, right) => compareText(String(left.node_name), String(right.node_name)))
}

/**
 * `node_prerequisites`: direct prerequisites plus, given the learner's states, which ones block.
 *
 * The state is read from `learning_knowledge_state` — the same rows the evidence projection writes —
 * so the page cannot show "unmet" for a node the planner already treats as done.
 */
export function nodePrerequisites(db: DatabaseSync, userId: string, projectId: string, nodeId: string): Row {
  const project = requireProject(db, userId, projectId)
  const node = findOne(db, 'knowledge_node', { id: nodeId })
  if (node === null || !nodeInProject(db, node, String(project.id))) {
    throw new ScopeViolation('考点不存在或不属于该项目')
  }
  const prerequisites = prerequisiteNodes(db, node)
  const stateByNode = new Map<string, string>()
  for (const prerequisite of prerequisites) {
    const state = findRows(db, 'learning_knowledge_state', {
      user_id: userId,
      project_id: project.id,
      node_id: prerequisite.id,
    })[0]
    if (state !== undefined) stateByNode.set(String(prerequisite.id), String(state.summary))
  }
  return {
    node_id: String(node.id),
    node_name: node.canonical_name,
    prerequisites: prerequisites.map((prerequisite) => ({
      node_id: String(prerequisite.id),
      node_name: prerequisite.canonical_name,
      state: stateByNode.get(String(prerequisite.id)) ?? 'undiagnosed',
    })),
    unmet: unmetPrerequisites(db, node, stateByNode),
  }
}

function nodeInProject(db: DatabaseSync, node: Row, projectId: string): boolean {
  const syllabus = findOne(db, 'exams_syllabus_version', { id: String(node.syllabus_version_id) })
  const subject = syllabus === null ? null : findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
  return subject !== null && String(subject.project_id) === projectId
}

/** Code-point comparison, matching the ordering of the stored short identifiers. */
export function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
