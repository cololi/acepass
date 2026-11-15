/**
 * Real paper cycle analysis (P1-03).
 *
 * Port of `backend/apps/analytics/services/cycles.py`.
 *
 * The product question is "how is the score distributed across cycles, and what is still
 * uncovered" — and the honest answer depends entirely on which papers may be counted. This module
 * therefore refuses to estimate:
 *
 *  - only **real occurrence records** count. Demo fixtures, mock papers and practice sets are
 *    excluded by `source_kind` and `is_demo`, so a demo dataset can never masquerade as an official
 *    distribution;
 *  - a cycle only counts when **every** registered paper in it has a *confirmed* revision whose
 *    coverage was manually marked complete. A single uploaded paper never proves a whole year,
 *    which is exactly what `coverage_incomplete` and `coverage_unknown` exist for;
 *  - the denominator is stated per cycle (the total scored marks of that cycle's effective
 *    revisions) and questions whose score is unknown stay out of it;
 *  - weights are counted once: the primary mapping weights of one question version already sum to
 *    1 (enforced on write), auxiliary tags carry weight 0, and any scored item with no mapping
 *    falls into an explicit `未分类` bucket instead of silently disappearing. `share_total` is
 *    reported so the caller can see that the shares add up to at most 1 — never more.
 *
 * Five complete cycles is the requested horizon; with fewer, the report says so
 * (`insufficient_cycles`) and lists what is missing instead of averaging over whatever happens to
 * be there.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { findOne, findRows } from '../store/repository.ts'
import { coverageStatus } from './exams.ts'

type Row = Record<string, unknown>

/** The analysis horizon: "近五年" means five *complete* cycles, never five rows. */
export const DEFAULT_CYCLE_COUNT = 5
export const UNCLASSIFIED_LABEL = '未分类'
/** Internal key for scored marks whose question has no knowledge mapping at all. */
export const UNCLASSIFIED_KEY = '__unclassified__'
/** Why a paper cannot be counted, in a machine-readable form the UI maps to text. */
export const REASON_DEMO = 'demo_or_mock'
export const REASON_NO_REVISION = 'no_effective_revision'
export const REASON_NOT_CONFIRMED = 'revision_not_confirmed'
export const REASON_NO_ITEMS = 'no_scored_items'
/** The verdict of a paper that does enter the numbers. */
export const REASON_COUNTED = 'counted'

const OFFICIAL_PAST = 'official_past'
const REVISION_CONFIRMED = 'confirmed'
const COVERAGE_COMPLETE = 'coverage_complete'
/** `Decimal("-1")`: the sort sentinel for a node that never got a share (a zero denominator). */
const NO_SHARE = Decimal.parse('-1')

function decimalOf(value: unknown): Decimal {
  if (value instanceof Decimal) return value
  if (value === null || value === undefined) return Decimal.zero()
  return Decimal.parse(String(value))
}

/**
 * Python compares strings by code point; `Array#sort`'s default and `<` compare UTF-16 units.
 *
 * The difference only shows up outside the BMP, but a label or a UUID prefix is compared here to
 * decide the order of a report, so it is worth getting right rather than "close enough".
 */
export function compareCodePoints(left: string, right: string): number {
  const a = [...left]
  const b = [...right]
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    const x = a[index].codePointAt(0) ?? 0
    const y = b[index].codePointAt(0) ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * Sort cycles by their leading year when there is one, else lexically.
 *
 * A key like "2024春" still means 2024; a key with fewer than four leading digits ("demo") carries
 * no year at all and sorts as year 0, so a fixture label can never outrank a real year.
 */
export function cycleSortKey(cycleKey: string): readonly [number, string] {
  const match = /^[0-9]+/.exec(cycleKey)
  const digits = match === null ? '' : match[0]
  // Python's `str.isdigit` also accepts non-ASCII decimal digits (and then `int()` parses them); a
  // cycle key is a year label a human typed, so only ASCII digits are treated as a year here.
  return [digits.length >= 4 ? Number(digits) : 0, cycleKey]
}

/** Descending by `(year, cycle_key)`, the tuple order `sorted(..., reverse=True)` produces. */
function compareCycles(left: string, right: string): number {
  const a = cycleSortKey(left)
  const b = cycleSortKey(right)
  if (a[0] !== b[0]) return a[0] > b[0] ? -1 : 1
  return -compareCodePoints(a[1], b[1])
}

/**
 * The row `Paper.effective_revision_id` points at, or `null`.
 *
 * The FK is `ON DELETE SET NULL`, so a set id whose row is gone cannot survive a delete; Django
 * raises `RelatedObjectDoesNotExist` on that read, and a silent `null` here would instead turn a
 * broken reference into "this paper has no revision" and quietly shrink the statistics.
 */
export function effectiveRevision(db: DatabaseSync, paper: Row): Row | null {
  const id = paper.effective_revision_id
  if (id === null || id === undefined) return null
  const revision = findOne(db, 'exams_paper_revision', { id: String(id) })
  if (revision === null) {
    throw new Error(
      `exams_paper ${String(paper.id)}: effective revision ${String(id)} does not exist`,
    )
  }
  return revision
}

/**
 * May this occurrence record enter the numbers, and if not, why not.
 *
 * The order matters for the message a user reads: "it is a demo paper" is a more useful
 * explanation than "the revision is not confirmed", even though both may be true.
 */
function verdictFor(
  db: DatabaseSync,
  paper: Row,
  revision: Row | null,
): readonly [boolean, string] {
  if (Boolean(paper.is_demo)) return [false, REASON_DEMO]
  if (String(paper.source_kind) !== OFFICIAL_PAST) {
    // Mock papers and practice sets are registered on purpose; they simply never describe an
    // official distribution.
    return [false, `source_kind=${String(paper.source_kind)}`]
  }
  if (revision === null) return [false, REASON_NO_REVISION]
  if (String(revision.status) !== REVISION_CONFIRMED) return [false, REASON_NOT_CONFIRMED]
  const status = coverageStatus(revision)
  if (status !== COVERAGE_COMPLETE) return [false, status]
  if (findRows(db, 'exams_paper_item', { revision_id: revision.id, is_scored: true }, { limit: 1 }).length === 0) {
    return [false, REASON_NO_ITEMS]
  }
  return [true, REASON_COUNTED]
}

/** `paper_is_countable(paper)` — may this occurrence record be counted, and if not, why not. */
export function paperIsCountable(db: DatabaseSync, paper: Row): readonly [boolean, string] {
  return verdictFor(db, paper, effectiveRevision(db, paper))
}

/**
 * `_latest_mapping_revision`: the newest mapping batch of one question version, 0 when there is
 * none.
 *
 * Every batch is scanned, not only the newest-looking row: a version whose mappings were all
 * retired (or never made) has no revision at all, and answering "0" is what sends its score to the
 * explicit unclassified bucket instead of dropping it.
 */
export function latestMappingRevision(db: DatabaseSync, questionVersionId: string): number {
  let latest = 0
  for (const mapping of findRows(db, 'knowledge_question_mapping', { question_version_id: questionVersionId })) {
    latest = Math.max(latest, Number(mapping.mapping_revision))
  }
  return latest
}

/**
 * Every primary mapping in the newest batch of one question version, in node order.
 *
 * `QuestionKnowledge.Meta.ordering` is `["question_version", "mapping_revision", "node"]`, which for
 * one version and one revision is node order (`node` is the FK, i.e. the node id). Auxiliary tags
 * (`is_primary = false`, weight 0) are not weights and are dropped here, because counting one
 * question's score twice would make `share_total` exceed 1.
 */
export function primaryMappings(db: DatabaseSync, questionVersionId: string): Row[] {
  const revision = latestMappingRevision(db, questionVersionId)
  const rows = findRows(db, 'knowledge_question_mapping', {
    question_version_id: questionVersionId,
    mapping_revision: revision,
  })
  rows.sort((left, right) => compareCodePoints(String(left.node_id), String(right.node_id)))
  return rows.filter(
    (mapping) => Boolean(mapping.is_primary) && decimalOf(mapping.score_weight).gt(Decimal.zero()),
  )
}

/**
 * `KnowledgeNode.ancestors()`: the parent chain, nearest first, stopping on a repeat.
 *
 * The seen-set starts with the node itself, so a node that is its own parent (or a longer ring that
 * loops back) yields an empty chain instead of spinning. A parent id whose row is gone stops the
 * walk: the FK is `ON DELETE CASCADE`, so that can only be a dangling reference in a hand-edited
 * store.
 */
export function nodeAncestors(db: DatabaseSync, node: Row): Row[] {
  const chain: Row[] = []
  const seen = new Set<string>([String(node.id)])
  let parentId = node.parent_id
  let current: Row | null = null
  if (parentId !== null && parentId !== undefined) {
    current = findOne(db, 'knowledge_node', { id: String(parentId) })
  }
  while (current !== null) {
    const key = String(current.id)
    if (seen.has(key)) break
    chain.push(current)
    seen.add(key)
    parentId = current.parent_id
    current =
      parentId === null || parentId === undefined
        ? null
        : findOne(db, 'knowledge_node', { id: String(parentId) })
  }
  return chain
}

/** `_node_path`: "大纲 / 章节 / 考点", root first. */
export function nodePath(db: DatabaseSync, node: Row): string {
  const names = [String(node.canonical_name)]
  for (const ancestor of nodeAncestors(db, node)) names.push(String(ancestor.canonical_name))
  return names.reverse().join(' / ')
}

/** One score bucket of a single cycle. `path` is absent only for the unclassified bucket. */
interface ScoreBucket {
  node_id: string | null
  label: string
  path?: string
  score: Decimal
  unclassified: boolean
}

function requireNode(db: DatabaseSync, nodeId: string): Row {
  const node = findOne(db, 'knowledge_node', { id: nodeId })
  // `mapping.node` is a `PROTECT` FK, so this is a dangling reference, not an expected state.
  if (node === null) throw new Error(`knowledge_node ${nodeId} does not exist`)
  return node
}

/**
 * Per-node score of one cycle plus the denominator actually used.
 *
 * A mapped item splits its marks by `weight / weight_total` across the primary mappings of its
 * newest batch; an unmapped one goes to `未分类` whole. The split is exact rational arithmetic under
 * the default decimal context, so the parts of one item add back up to its own score.
 */
export function nodeShares(
  db: DatabaseSync,
  items: readonly Row[],
): { perNode: Map<string, ScoreBucket>; total: Decimal } {
  const perNode = new Map<string, ScoreBucket>()
  let total = Decimal.zero()
  for (const item of items) {
    const score = decimalOf(item.max_score)
    total = total.add(score)
    const mappings = primaryMappings(db, String(item.question_version_id))
    if (mappings.length === 0) {
      let bucket = perNode.get(UNCLASSIFIED_KEY)
      if (bucket === undefined) {
        bucket = { node_id: null, label: UNCLASSIFIED_LABEL, score: Decimal.zero(), unclassified: true }
        perNode.set(UNCLASSIFIED_KEY, bucket)
      }
      bucket.score = bucket.score.add(score)
      continue
    }
    let weightTotal = Decimal.zero()
    for (const mapping of mappings) weightTotal = weightTotal.add(decimalOf(mapping.score_weight))
    for (const mapping of mappings) {
      const weight = decimalOf(mapping.score_weight)
      const share = weightTotal.gt(Decimal.zero()) ? score.mul(weight).div(weightTotal) : score
      const key = String(mapping.node_id)
      let bucket = perNode.get(key)
      if (bucket === undefined) {
        const node = requireNode(db, key)
        bucket = {
          node_id: key,
          label: String(node.canonical_name),
          path: nodePath(db, node),
          score: Decimal.zero(),
          unclassified: false,
        }
        perNode.set(key, bucket)
      }
      bucket.score = bucket.score.add(share)
    }
  }
  return { perNode, total }
}

/** A node as one cycle reports it: scores already quantised to their reported precision. */
interface CycleNode {
  node_id: string | null
  label: string
  path: string
  unclassified: boolean
  score: Decimal
  share: Decimal | null
}

interface CycleSummary {
  cycle_key: string
  paper_count: number
  scored_item_count: number
  total: Decimal
  share_total: Decimal
  nodes: CycleNode[]
}

interface CycleRow {
  cycle_key: string
  status: string
  paper_count: number
  papers: Record<string, unknown>[]
  blocking_reasons: { paper_id: string; reason: string }[]
  /** The papers of this cycle by id, in the order they were registered. */
  papers_by_id: Map<string, Row>
}

interface AverageEntry {
  node_id: string | null
  label: string
  path: string
  unclassified: boolean
  shares: Decimal[]
  scores: Decimal[]
  cycle_count: number
  average_share: Decimal | null
  average_score: Decimal | null
}

function nodeOut(node: CycleNode): Record<string, unknown> {
  return {
    node_id: node.node_id,
    label: node.label,
    path: node.path,
    unclassified: node.unclassified,
    score: node.score.toString(),
    share: node.share === null ? null : node.share.toString(),
  }
}

/** Distribution over the most recent complete real cycles of one subject. */
export function cycleAnalysis(
  db: DatabaseSync,
  subjectId: string,
  options: { maxCycles?: number } = {},
): Record<string, unknown> {
  const maxCycles = options.maxCycles ?? DEFAULT_CYCLE_COUNT
  const papers = findRows(db, 'exams_paper', { subject_id: subjectId })
  // `order_by("cycle_key")` groups the papers by cycle in cycle order, and keeps a cycle's papers
  // in registration order — the order their items enter the denominator.
  papers.sort((left, right) => compareCodePoints(String(left.cycle_key), String(right.cycle_key)))
  const byCycle = new Map<string, Row[]>()
  for (const paper of papers) {
    const cycleKey = String(paper.cycle_key)
    const group = byCycle.get(cycleKey)
    if (group === undefined) byCycle.set(cycleKey, [paper])
    else group.push(paper)
  }

  // The effective revision is read once per paper here: the verdict, the projected counts and the
  // item list all need it, and `effective_revision_id` cannot change under an in-memory scan.
  const revisionByPaper = new Map<string, Row | null>()
  const cycles: CycleRow[] = []
  for (const [cycleKey, cyclePapers] of byCycle) {
    const reasons: { paper_id: string; reason: string }[] = []
    let complete = true
    const papersOut: Record<string, unknown>[] = []
    for (const paper of cyclePapers) {
      const revision = effectiveRevision(db, paper)
      revisionByPaper.set(String(paper.id), revision)
      const verdict = verdictFor(db, paper, revision)
      if (!verdict[0]) {
        complete = false
        reasons.push({ paper_id: String(paper.id), reason: verdict[1] })
      }
      // A paper with no effective revision was never read, so its coverage is *unknown* rather than
      // "incomplete" — the two mean different things to a reader.
      papersOut.push({
        paper_id: String(paper.id),
        paper_code: paper.paper_code,
        session_key: paper.session_key,
        source_kind: paper.source_kind,
        countable: verdict[0],
        reason: verdict[1],
        coverage_status: revision === null ? 'coverage_unknown' : coverageStatus(revision),
        expected_session_count: revision === null ? null : revision.expected_session_count,
        covered_session_count: revision === null ? null : revision.covered_session_count,
      })
    }
    cycles.push({
      cycle_key: cycleKey,
      status: complete ? 'complete' : 'incomplete',
      paper_count: cyclePapers.length,
      papers: papersOut,
      blocking_reasons: reasons,
      papers_by_id: new Map(cyclePapers.map((paper) => [String(paper.id), paper])),
    })
  }
  cycles.sort((left, right) => compareCycles(left.cycle_key, right.cycle_key))

  const completeCycles = cycles.filter((row) => row.status === 'complete')
  const used = completeCycles.slice(0, maxCycles)
  const excluded = cycles.filter((row) => row.status !== 'complete')

  const summaries: CycleSummary[] = []
  for (const row of used) {
    const items: Row[] = []
    for (const paper of row.papers_by_id.values()) {
      const revision = revisionByPaper.get(String(paper.id))
      if (revision === null || revision === undefined) {
        // Unreachable: a cycle is only "complete" when every paper has an effective revision.
        throw new Error(`cycle ${row.cycle_key}: countable paper ${String(paper.id)} has no revision`)
      }
      // `items.filter(is_scored=True)` keeps `PaperItem.Meta.ordering` (`revision, position_key`).
      for (const item of findRows(
        db,
        'exams_paper_item',
        { revision_id: revision.id, is_scored: true },
        { orderBy: [['revision_id', 'asc'], ['position_key', 'asc']] },
      )) {
        items.push(item)
      }
    }
    const { perNode, total } = nodeShares(db, items)
    // Descending by score; equal buckets keep the order the mappings were read in.
    const ranked = [...perNode.values()].sort((left, right) => right.score.cmp(left.score))
    const hasDenominator = total.gt(Decimal.zero())
    // `share_total` is the sum of the *unrounded* divisions, quantised once at the end. Summing the
    // rounded per-row shares instead would drift: three buckets of exactly 1/3 report 0.3333 each
    // and would add up to 0.9999, while the true total is 1.
    const rawShares = ranked.map((bucket) => (hasDenominator ? bucket.score.div(total) : null))
    let shareTotal = Decimal.zero()
    for (const share of rawShares) if (share !== null) shareTotal = shareTotal.add(share)
    const nodes: CycleNode[] = ranked.map((bucket, index) => {
      const share = rawShares[index] ?? null
      return {
        node_id: bucket.node_id,
        label: bucket.label,
        path: bucket.path ?? bucket.label,
        unclassified: bucket.unclassified,
        score: bucket.score.quantize(-3),
        share: share === null ? null : share.quantize(-4),
      }
    })
    summaries.push({
      cycle_key: row.cycle_key,
      paper_count: row.paper_count,
      scored_item_count: items.length,
      total,
      share_total: shareTotal,
      nodes,
    })
  }

  const averages = new Map<string, AverageEntry>()
  for (const summary of summaries) {
    for (const node of summary.nodes) {
      const key = node.node_id ?? UNCLASSIFIED_KEY
      let entry = averages.get(key)
      if (entry === undefined) {
        entry = {
          node_id: node.node_id,
          label: node.label,
          path: node.path,
          unclassified: node.unclassified,
          shares: [],
          scores: [],
          cycle_count: 0,
          average_share: null,
          average_score: null,
        }
        averages.set(key, entry)
      }
      if (node.share !== null) entry.shares.push(node.share)
      entry.scores.push(node.score)
    }
  }
  for (const entry of averages.values()) {
    const count = entry.shares.length
    entry.cycle_count = count
    let shareSum = Decimal.zero()
    for (const share of entry.shares) shareSum = shareSum.add(share)
    let scoreSum = Decimal.zero()
    for (const score of entry.scores) scoreSum = scoreSum.add(score)
    // Both averages divide by the number of cycles that *had* a share: a cycle with a zero
    // denominator reports no share, and pretending it contributed a 0 would understate the node.
    entry.average_share = count === 0 ? null : shareSum.div(Decimal.fromInt(count)).quantize(-4)
    entry.average_score = count === 0 ? null : scoreSum.div(Decimal.fromInt(count)).quantize(-3)
  }

  const gaps = coverageGaps(db, subjectId, averages)
  const status = used.length >= maxCycles ? 'ok' : 'insufficient_cycles'
  const nodeRows = [...averages.values()]
  // `sorted(..., reverse=True)` on `(average_share or Decimal("-1"), label)` reverses both fields,
  // so the highest share comes first and equal shares fall back to the label descending.
  nodeRows.sort((left, right) => {
    const byShare = (right.average_share ?? NO_SHARE).cmp(left.average_share ?? NO_SHARE)
    if (byShare !== 0) return byShare
    return -compareCodePoints(left.label, right.label)
  })
  return {
    subject_id: subjectId,
    cycle_horizon: maxCycles,
    status,
    complete_cycle_count: completeCycles.length,
    used_cycle_count: used.length,
    missing_complete_cycles: Math.max(0, maxCycles - used.length),
    used_cycles: summaries.map((summary) => summary.cycle_key),
    cycles: summaries.map((summary) => ({
      cycle_key: summary.cycle_key,
      paper_count: summary.paper_count,
      scored_item_count: summary.scored_item_count,
      denominator_total_score: summary.total.quantize(-3).toString(),
      share_total: summary.share_total.quantize(-4).toString(),
      nodes: summary.nodes.map(nodeOut),
    })),
    incomplete_cycles: excluded.map((row) => ({
      cycle_key: row.cycle_key,
      paper_count: row.paper_count,
      blocking_reasons: row.blocking_reasons,
      papers: row.papers,
    })),
    nodes: nodeRows.map((entry) => ({
      node_id: entry.node_id,
      label: entry.label,
      path: entry.path,
      unclassified: entry.unclassified,
      cycle_count: entry.cycle_count,
      average_share: entry.average_share === null ? null : entry.average_share.toString(),
      average_score: entry.average_score === null ? null : entry.average_score.toString(),
    })),
    coverage_gaps: gaps,
    notes: cycleNotes(status, used.length, maxCycles, excluded.length),
  }
}

/**
 * `_coverage_gaps`: published syllabus points that no counted cycle ever examined.
 *
 * Only a *published* syllabus of this subject is a baseline a reader can be held to, and the
 * explicit `未分类` bucket is a catch-all rather than a topic, so neither is ever reported missing.
 */
export function coverageGaps(
  db: DatabaseSync,
  subjectId: string,
  averages: ReadonlyMap<string, unknown>,
): Record<string, unknown>[] {
  const published = new Set(
    findRows(db, 'exams_syllabus_version', { subject_id: subjectId, status: 'published' }).map((row) =>
      String(row.id),
    ),
  )
  const nodes = findRows(db, 'knowledge_node', { is_unclassified: false }).filter((node) =>
    published.has(String(node.syllabus_version_id)),
  )
  // `order_by("display_order", "canonical_name")`.
  nodes.sort((left, right) => {
    const byOrder = Number(left.display_order) - Number(right.display_order)
    if (byOrder !== 0) return byOrder
    return compareCodePoints(String(left.canonical_name), String(right.canonical_name))
  })
  const gaps: Record<string, unknown>[] = []
  for (const node of nodes) {
    if (averages.has(String(node.id))) continue
    gaps.push({
      node_id: String(node.id),
      label: node.canonical_name,
      path: nodePath(db, node),
      reason: 'never_examined_in_counted_cycles',
    })
  }
  return gaps
}

/** `_notes` — what the report is counting, and what it is not. */
export function cycleNotes(
  status: string,
  used: number,
  horizon: number,
  excludedCount: number,
): string[] {
  const notes = [
    '只统计真实考试发生记录（source_kind=official_past 且非演示数据）；演示、模拟与练习集不计入任何分子或分母。',
    '完整周期 = 该周期全部已登记试卷都有“已确认且人工标记覆盖完整”的有效版本。',
    '分值权重按题目版本的主要考点权重计入一次；辅助标签权重为 0；无映射的计分题进入“未分类”。',
  ]
  if (status !== 'ok') {
    notes.push(
      `目前只有 ${used} 个完整周期，不足 ${horizon} 个：不给出“近五年”结论，` +
        `未完整周期 ${excludedCount} 个，原因见 incomplete_cycles。`,
    )
  }
  return notes
}
