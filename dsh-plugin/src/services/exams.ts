/**
 * Exams: projects and subjects.
 *
 * Port of `backend/apps/exams/services/core.py` (project/subject part) and the matching routes in
 * `apps/exams/api.py`.
 *
 * Two behaviours are easy to "improve" and must not be: `update_project` assigns the new values
 * *before* checking for a duplicate name (so the check sees the new name), and an already-archived
 * project is returned unchanged by `archive_project` rather than being an error — the route is
 * idempotent because it is retried by the client.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Decimal } from '../domain/decimal.ts'
import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { insertRow, findOne, findRows, updateRow } from '../store/repository.ts'
import { enqueue } from '../store/outbox.ts'
import { transaction } from '../store/db.ts'
import { InvalidInput, ScopeViolation, StructureInvalid } from './errors.ts'
import { validateTypeRules } from './type_rules.ts'

const DESCRIPTION_LIMIT = 500
const SUBJECT_CODE_LIMIT = 40

/** Fields `update_project` accepts; anything else is ignored rather than rejected. */
const MUTABLE_PROJECT_FIELDS = new Set(['name', 'description', 'target_date', 'target_score', 'display_order'])

export interface ProjectIn {
  name: string
  description?: string
  target_date?: string | null
  target_score?: Decimal | string | null
}

export interface ProjectPatch {
  name?: string | null
  description?: string | null
  target_date?: string | null
  target_score?: Decimal | string | null
  display_order?: number | null
}

export interface SubjectIn {
  name: string
  code?: string
  total_score?: Decimal | string | null
  pass_score?: Decimal | string | null
}

function strip(value: unknown): string {
  return String(value ?? '').trim()
}

/** Python's `str.strip()` trims Unicode whitespace; `String#trim` does the same set closely enough. */
function asDecimal(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Decimal) return value
  return Decimal.parse(String(value))
}

export function requireProject(db: DatabaseSync, userId: string, projectId: string): Record<string, unknown> {
  const project = findOne(db, 'exams_project', { id: projectId, owner_id: userId })
  // A project that exists under another owner is reported as missing, so its existence cannot be
  // probed (the Python scope helper does the same).
  if (project === null) throw new ScopeViolation('项目不存在或无权访问')
  return project
}

/** `_project_out()` — the counts are computed, never stored. */
export function projectOut(db: DatabaseSync, project: Record<string, unknown>): Record<string, unknown> {
  const subjectRows = findRows(db, 'exams_subject', { project_id: project.id })
  let questionCount = 0
  for (const subject of subjectRows) {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM "question_bank_question" WHERE "subject_id" = ?')
      .get(subject.id as never) as { n: number }
    questionCount += row.n
  }
  return {
    id: String(project.id),
    name: project.name,
    description: project.description,
    target_date: project.target_date,
    target_score: project.target_score === null ? null : String(project.target_score),
    is_archived: project.is_archived,
    display_order: project.display_order,
    subject_count: subjectRows.length,
    question_count: questionCount,
    created_at: formatPythonIso(project.created_at as Instant),
  }
}

export function subjectOut(subject: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(subject.id),
    project_id: String(subject.project_id),
    name: subject.name,
    code: subject.code,
    display_order: subject.display_order,
    total_score: subject.total_score === null ? null : String(subject.total_score),
    pass_score: subject.pass_score === null ? null : String(subject.pass_score),
  }
}

export function listProjects(
  db: DatabaseSync,
  userId: string,
  options: { includeArchived?: boolean } = {},
): Record<string, unknown>[] {
  const where: Record<string, unknown> = { owner_id: userId }
  if (options.includeArchived !== true) where.is_archived = false
  return findRows(db, 'exams_project', where, { orderBy: [['display_order', 'asc']] }).map((row) =>
    projectOut(db, row),
  )
}

function writeContentRevision(
  db: DatabaseSync,
  options: {
    actorId: string
    entityType: string
    entityId: string
    action: string
    projectId: string
    detail?: Record<string, unknown>
    reason?: string
    now: Instant
  },
): void {
  insertRow(
    db,
    'audit_content_revision',
    {
      actor_id: options.actorId,
      entity_type: options.entityType,
      entity_id: options.entityId,
      action: options.action,
      project_id: options.projectId,
      reason: options.reason ?? '',
      before_digest: '',
      after_digest: '',
      detail: options.detail ?? {},
    },
    { now: options.now },
  )
}

export function createProject(
  db: DatabaseSync,
  userId: string,
  payload: ProjectIn,
  now: Instant,
): Record<string, unknown> {
  const name = strip(payload.name)
  if (!name) throw new InvalidInput('项目名称不能为空')
  return transaction(db, () => {
    if (findOne(db, 'exams_project', { owner_id: userId, name }) !== null) {
      throw new InvalidInput('已存在同名项目', { details: { name } })
    }
    const last = db
      .prepare('SELECT MAX("display_order") AS value FROM "exams_project" WHERE "owner_id" = ?')
      .get(userId) as { value: number | null }
    const project = insertRow(
      db,
      'exams_project',
      {
        owner_id: userId,
        name,
        description: String(payload.description ?? '').slice(0, DESCRIPTION_LIMIT),
        target_date: payload.target_date ?? null,
        target_score: asDecimal(payload.target_score),
        is_archived: false,
        display_order: (last.value ?? 0) + 1,
      },
      { now },
    )
    return projectOut(db, project)
  })
}

export function getProject(db: DatabaseSync, userId: string, projectId: string): Record<string, unknown> {
  return projectOut(db, requireProject(db, userId, projectId))
}

export function updateProject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: ProjectPatch,
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  if (project.is_archived) throw new InvalidInput('已归档项目不能修改；请先恢复或新建项目')

  return transaction(db, () => {
    const changed: Record<string, string> = {}
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload)) {
      // Python skips unknown keys and explicit nulls: a null means "not provided" here, not "clear".
      if (!MUTABLE_PROJECT_FIELDS.has(key) || value === null || value === undefined) continue
      patch[key] = key === 'target_score' ? asDecimal(value) : value
      changed[key] = String(value)
    }
    const name = patch.name === undefined ? undefined : strip(patch.name)
    if (name !== undefined) patch.name = name

    // The name check runs against the *new* name, after the assignment — same order as Python.
    if (name !== undefined) {
      const clash = findOne(db, 'exams_project', { owner_id: userId, name })
      if (clash !== null && String(clash.id) !== String(project.id)) {
        throw new InvalidInput('已存在同名项目', { details: { name } })
      }
    }
    const updated = updateRow(db, 'exams_project', project.id, patch, { now })!
    if (Object.keys(changed).length > 0) {
      writeContentRevision(db, {
        actorId: userId,
        entityType: 'exam_project',
        entityId: String(project.id),
        action: 'update',
        projectId: String(project.id),
        detail: changed,
        now,
      })
    }
    return projectOut(db, updated)
  })
}

export function archiveProject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { reason?: string; now: Instant },
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const active = db
    .prepare('SELECT COUNT(*) AS n FROM "practice_session" WHERE "project_id" = ? AND "status" = ?')
    .get(String(project.id), 'active') as { n: number }
  if (active.n > 0) {
    throw new InvalidInput('存在进行中的练习会话，请先结束或放弃后再归档', {
      details: { active_sessions: active.n },
    })
  }
  if (project.is_archived) return projectOut(db, project)

  return transaction(db, () => {
    const updated = updateRow(
      db,
      'exams_project',
      project.id,
      { is_archived: true, archived_at: options.now },
      { now: options.now },
    )!
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'exam_project',
      entityId: String(project.id),
      action: 'archive',
      projectId: String(project.id),
      reason: options.reason ?? '',
      now: options.now,
    })
    return projectOut(db, updated)
  })
}

export function unarchiveProject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  if (!project.is_archived) return projectOut(db, project)
  return transaction(db, () => {
    const updated = updateRow(db, 'exams_project', project.id, { is_archived: false, archived_at: null }, { now })!
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'exam_project',
      entityId: String(project.id),
      action: 'unarchive',
      projectId: String(project.id),
      now,
    })
    return projectOut(db, updated)
  })
}

export function listSubjects(db: DatabaseSync, userId: string, projectId: string): Record<string, unknown>[] {
  const project = requireProject(db, userId, projectId)
  return findRows(db, 'exams_subject', { project_id: project.id }, { orderBy: [['display_order', 'asc']] }).map(
    subjectOut,
  )
}

export function createSubject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: SubjectIn,
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  if (project.is_archived) throw new InvalidInput('已归档项目不能新增科目')
  const name = strip(payload.name)
  if (!name) throw new InvalidInput('科目名称不能为空')

  return transaction(db, () => {
    if (findOne(db, 'exams_subject', { project_id: project.id, name }) !== null) {
      throw new InvalidInput('该项目下已存在同名科目', { details: { name } })
    }
    const last = db
      .prepare('SELECT MAX("display_order") AS value FROM "exams_subject" WHERE "project_id" = ?')
      .get(String(project.id)) as { value: number | null }
    const subject = insertRow(
      db,
      'exams_subject',
      {
        project_id: project.id,
        name,
        code: String(payload.code ?? '').slice(0, SUBJECT_CODE_LIMIT),
        display_order: (last.value ?? 0) + 1,
        total_score: asDecimal(payload.total_score),
        pass_score: asDecimal(payload.pass_score),
      },
      { now },
    )
    return subjectOut(subject)
  })
}

// ---------------------------------------------------------------------------
// Exam spec versions
// ---------------------------------------------------------------------------

/** `type_rule_summary()` — what the confirm-before-use UI shows for each question type. */
export function typeRuleSummary(rules: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const summary: Record<string, unknown> = {}
  for (const [questionType, rawRule] of Object.entries(rules ?? {})) {
    const rule = (rawRule ?? {}) as Record<string, unknown>
    summary[questionType] = {
      default_max_score: rule['default_max_score'] ?? null,
      wrong_score: rule['wrong_score'] ?? '0.00',
      blank_score: rule['blank_score'] ?? '0.00',
      policy: rule['policy'] ?? 'exact_match',
      partial_score: rule['partial_score'] ?? null,
      mismatch_policy: rule['mismatch_policy'] ?? 'review',
    }
  }
  return summary
}

export interface SpecIn {
  subject_id: string
  name?: string
  total_score?: Decimal | string | null
  pass_score?: Decimal | string | null
  question_type_rules?: Record<string, unknown>
  time_rules?: Record<string, unknown>
  score_floor_at_zero?: boolean
  rule_source_note?: string
  is_demo?: boolean
}

export function requireSubject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const subject = findOne(db, 'exams_subject', { id: subjectId, project_id: project.id })
  if (subject === null) throw new ScopeViolation('科目不存在或不属于该项目')
  return subject
}

export function specOut(spec: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(spec.id),
    subject_id: String(spec.subject_id),
    version: spec.version,
    name: spec.name,
    total_score: spec.total_score === null ? null : String(spec.total_score),
    pass_score: spec.pass_score === null ? null : String(spec.pass_score),
    question_type_rules: spec.question_type_rules ?? {},
    time_rules: spec.time_rules ?? {},
    score_floor_at_zero: spec.score_floor_at_zero,
    rule_source_note: spec.rule_source_note,
    is_demo: spec.is_demo,
    status: spec.status,
    published_at: spec.published_at === null ? null : formatPythonIso(spec.published_at as Instant),
    is_usable: spec.status === 'published',
    rule_summary: typeRuleSummary(spec.question_type_rules as Record<string, unknown>),
  }
}

function nextVersion(
  db: DatabaseSync,
  table: string,
  where: Record<string, unknown>,
  field = 'version',
): number {
  const columns = Object.keys(where)
  const predicate = columns.map((column) => `"${column}" = ?`).join(' AND ')
  const row = db
    .prepare(`SELECT MAX("${field}") AS value FROM "${table}" WHERE ${predicate}`)
    .get(...(Object.values(where) as never[])) as { value: number | null }
  return (row.value ?? 0) + 1
}

export function listSpecVersions(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null } = {},
): Record<string, unknown>[] {
  const project = requireProject(db, userId, projectId)
  const subjectIds = findRows(db, 'exams_subject', { project_id: project.id }).map((row) => String(row.id))
  const targets =
    options.subjectId === null || options.subjectId === undefined
      ? subjectIds
      : [String(requireSubject(db, userId, projectId, options.subjectId).id)]
  const seen = new Map<string, Record<string, unknown>>()
  for (const subjectId of targets) {
    for (const row of findRows(db, 'exams_spec_version', { subject_id: subjectId })) seen.set(String(row.id), row)
  }
  return [...seen.values()].map(specOut)
}

export function createSpecVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: SpecIn,
  now: Instant,
): Record<string, unknown> {
  const subject = requireSubject(db, userId, projectId, payload.subject_id)
  const rules = payload.question_type_rules ?? {}
  // The rules are validated before anything is written, so a bad spec never becomes a row.
  validateTypeRules(rules)
  return transaction(db, () => {
    const spec = insertRow(
      db,
      'exams_spec_version',
      {
        subject_id: subject.id,
        version: nextVersion(db, 'exams_spec_version', { subject_id: subject.id }),
        name: String(payload.name ?? ''),
        status: 'draft',
        total_score: asDecimal(payload.total_score),
        pass_score: asDecimal(payload.pass_score),
        score_floor_at_zero: payload.score_floor_at_zero ?? false,
        is_demo: payload.is_demo ?? true,
        rule_source_note: String(payload.rule_source_note ?? ''),
        question_type_rules: rules,
        time_rules: payload.time_rules ?? {},
        created_by_id: userId,
        published_at: null,
      },
      { now },
    )
    return specOut(spec)
  })
}

export function publishSpecVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  specId: string,
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const spec = findOne(db, 'exams_spec_version', { id: specId })
  if (spec === null) throw new ScopeViolation('规范版本不存在或不属于该项目')
  const subject = findOne(db, 'exams_subject', { id: String(spec.subject_id) })
  if (subject === null || String(subject.project_id) !== String(project.id)) {
    throw new ScopeViolation('规范版本不存在或不属于该项目')
  }
  if (spec.status === 'published') return specOut(spec)

  const rules = (spec.question_type_rules ?? {}) as Record<string, unknown>
  if (Object.keys(rules).length === 0) {
    throw new InvalidInput('发布规范前必须配置至少一种题型的计分规则')
  }
  validateTypeRules(rules)

  return transaction(db, () => {
    const updated = updateRow(
      db,
      'exams_spec_version',
      spec.id,
      { status: 'published', published_at: now },
      { now },
    )!
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'exam_spec_version',
      entityId: String(spec.id),
      action: 'publish',
      projectId: String(project.id),
      detail: { version: spec.version },
      now,
    })
    return specOut(updated)
  })
}

// ---------------------------------------------------------------------------
// Syllabus versions
// ---------------------------------------------------------------------------

export interface SyllabusIn {
  subject_id: string
  name: string
  version_label?: string
  applies_from?: string | null
  applies_to?: string | null
  is_user_provisional?: boolean
}

export function syllabusOut(db: DatabaseSync, syllabus: Record<string, unknown>): Record<string, unknown> {
  const nodes = db
    .prepare('SELECT COUNT(*) AS n FROM "knowledge_node" WHERE "syllabus_version_id" = ?')
    .get(String(syllabus.id)) as { n: number }
  return {
    id: String(syllabus.id),
    subject_id: String(syllabus.subject_id),
    name: syllabus.name,
    version_label: syllabus.version_label,
    applies_from: syllabus.applies_from,
    applies_to: syllabus.applies_to,
    is_user_provisional: syllabus.is_user_provisional,
    review_status: syllabus.review_status,
    status: syllabus.status,
    published_at: syllabus.published_at === null ? null : formatPythonIso(syllabus.published_at as Instant),
    node_count: nodes.n,
  }
}

export function listSyllabusVersions(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null } = {},
): Record<string, unknown>[] {
  const project = requireProject(db, userId, projectId)
  const subjectIds = findRows(db, 'exams_subject', { project_id: project.id }).map((row) => String(row.id))
  const targets =
    options.subjectId === null || options.subjectId === undefined
      ? subjectIds
      : [String(requireSubject(db, userId, projectId, options.subjectId).id)]
  const seen = new Map<string, Record<string, unknown>>()
  for (const subjectId of targets) {
    for (const row of findRows(db, 'exams_syllabus_version', { subject_id: subjectId })) {
      seen.set(String(row.id), row)
    }
  }
  return [...seen.values()].map((row) => syllabusOut(db, row))
}

export function createSyllabusVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: SyllabusIn,
  now: Instant,
): Record<string, unknown> {
  const subject = requireSubject(db, userId, projectId, payload.subject_id)
  const name = strip(payload.name)
  if (!name) throw new InvalidInput('大纲名称不能为空')
  return transaction(db, () => {
    const syllabus = insertRow(
      db,
      'exams_syllabus_version',
      {
        subject_id: subject.id,
        name,
        version_label: String(payload.version_label ?? ''),
        applies_from: payload.applies_from ?? null,
        applies_to: payload.applies_to ?? null,
        is_user_provisional: payload.is_user_provisional ?? true,
        review_status: 'draft',
        status: 'draft',
        created_by_id: userId,
        published_at: null,
      },
      { now },
    )
    return syllabusOut(db, syllabus)
  })
}

export function publishSyllabusVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  syllabusId: string,
  now: Instant,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const syllabus = findOne(db, 'exams_syllabus_version', { id: syllabusId })
  if (syllabus === null) throw new ScopeViolation('大纲版本不存在或不属于该项目')
  const subject = findOne(db, 'exams_subject', { id: String(syllabus.subject_id) })
  if (subject === null || String(subject.project_id) !== String(project.id)) {
    throw new ScopeViolation('大纲版本不存在或不属于该项目')
  }
  if (syllabus.status === 'published') return syllabusOut(db, syllabus)

  return transaction(db, () => {
    // A user-authored outline is never relabelled official: the review status is only promoted to
    // `approved`, and `is_user_provisional` keeps whatever the author said.
    const updated = updateRow(
      db,
      'exams_syllabus_version',
      syllabus.id,
      {
        status: 'published',
        published_at: now,
        // Python only promotes it when it is not already `approved`, i.e. always ends up approved.
        review_status: 'approved',
      },
      { now },
    )!
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'syllabus_version',
      entityId: String(syllabus.id),
      action: 'publish',
      projectId: String(project.id),
      detail: { is_user_provisional: syllabus.is_user_provisional },
      now,
    })
    return syllabusOut(db, updated)
  })
}

// ---------------------------------------------------------------------------
// Papers (real exam occurrence records)
// ---------------------------------------------------------------------------

/** `SourceKind.values` — `demo` and `mock` are never presented as official past papers. */
export const SOURCE_KINDS = ['official_past', 'mock', 'practice_set', 'demo'] as const
const DEMO_SOURCE_KINDS: ReadonlySet<string> = new Set(['demo', 'mock'])

export const PAPER_REVISION_STATUS = { DRAFT: 'draft', CONFIRMED: 'confirmed', WITHDRAWN: 'withdrawn' } as const

export interface PaperIn {
  subject_id: string
  cycle_key: string
  session_key?: string
  paper_code: string
  source_kind?: string
  title?: string
}

/** Stable fingerprint of a paper's natural key, so re-uploading the same paper reuses it. */
export function paperIdentityFingerprint(options: {
  subjectId: string
  cycleKey: string
  sessionKey: string
  paperCode: string
}): string {
  const raw = [options.subjectId, options.cycleKey.trim(), options.sessionKey.trim(), options.paperCode.trim()].join('|')
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Complete only when a human confirmed the counts, not merely typed them. */
export function coverageStatus(revision: Record<string, unknown>): string {
  const expected = revision.expected_session_count
  const covered = revision.covered_session_count
  if (expected === null || expected === undefined || covered === null || covered === undefined) {
    return 'coverage_unknown'
  }
  if (revision.coverage_confirmed_at === null || revision.coverage_confirmed_at === undefined) {
    return 'coverage_incomplete'
  }
  return Number(covered) >= Number(expected) ? 'coverage_complete' : 'coverage_incomplete'
}

/** The sentence the UI shows; it never claims more than the data supports. */
export function coverageNote(revision: Record<string, unknown>): string {
  const status = coverageStatus(revision)
  if (status === 'coverage_unknown') {
    return 'coverage_unknown：未登记该周期预期场次/卷别，不能据单份试卷判断全年完整。'
  }
  if (status === 'coverage_incomplete') {
    if (revision.coverage_confirmed_at === null || revision.coverage_confirmed_at === undefined) {
      return 'coverage_incomplete：场次已登记但尚未人工确认为完整周期，不能作为完整周期统计。'
    }
    return 'coverage_incomplete：已登记场次少于预期，不能作为完整周期统计。'
  }
  return 'coverage_complete：人工确认覆盖该周期全部已登记场次。'
}

export function revisionOut(db: DatabaseSync, revision: Record<string, unknown>): Record<string, unknown> {
  const items = findRows(db, 'exams_paper_item', { revision_id: revision.id })
  return {
    id: String(revision.id),
    revision: revision.revision,
    status: revision.status,
    coverage_status: coverageStatus(revision),
    expected_session_count: revision.expected_session_count,
    covered_session_count: revision.covered_session_count,
    item_count: items.length,
    scored_item_count: items.filter((item) => Boolean(item.is_scored)).length,
    note: revision.note,
    coverage_confirmed_by:
      revision.coverage_confirmed_by_id === null ? null : String(revision.coverage_confirmed_by_id),
    coverage_confirmed_at:
      revision.coverage_confirmed_at === null ? null : formatPythonIso(revision.coverage_confirmed_at as Instant),
  }
}

export function paperOut(db: DatabaseSync, paper: Record<string, unknown>): Record<string, unknown> {
  const revisions = findRows(db, 'exams_paper_revision', { paper_id: paper.id }, {
    orderBy: [['revision', 'desc']],
  })
  return {
    id: String(paper.id),
    subject_id: String(paper.subject_id),
    cycle_key: paper.cycle_key,
    session_key: paper.session_key,
    paper_code: paper.paper_code,
    source_kind: paper.source_kind,
    title: paper.title,
    is_demo: paper.is_demo,
    effective_revision_id:
      paper.effective_revision_id === null ? null : String(paper.effective_revision_id),
    revisions: revisions.map((revision) => revisionOut(db, revision)),
    coverage_note: revisions.length === 0 ? '尚无版本' : coverageNote(revisions[0]),
  }
}

function requirePaper(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  paperId: string,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const paper = findOne(db, 'exams_paper', { id: paperId })
  if (paper === null) throw new ScopeViolation('试卷不存在或不属于该项目')
  const subject = findOne(db, 'exams_subject', { id: String(paper.subject_id) })
  if (subject === null || String(subject.project_id) !== String(project.id)) {
    throw new ScopeViolation('试卷不存在或不属于该项目')
  }
  return paper
}

function requireRevision(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  revisionId: string,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const revision = findOne(db, 'exams_paper_revision', { id: revisionId })
  if (revision === null) throw new ScopeViolation('试卷版本不存在或不属于该项目')
  const paper = findOne(db, 'exams_paper', { id: String(revision.paper_id) })
  const subject = paper === null ? null : findOne(db, 'exams_subject', { id: String(paper.subject_id) })
  if (paper === null || subject === null || String(subject.project_id) !== String(project.id)) {
    throw new ScopeViolation('试卷版本不存在或不属于该项目')
  }
  return revision
}

export function listPapers(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: { subjectId?: string | null } = {},
): Record<string, unknown>[] {
  const project = requireProject(db, userId, projectId)
  const subjectIds = findRows(db, 'exams_subject', { project_id: project.id }).map((row) => String(row.id))
  const targets =
    options.subjectId === null || options.subjectId === undefined
      ? subjectIds
      : [String(requireSubject(db, userId, projectId, options.subjectId).id)]
  const papers: Record<string, unknown>[] = []
  for (const subjectId of targets) {
    for (const paper of findRows(db, 'exams_paper', { subject_id: subjectId })) papers.push(paperOut(db, paper))
  }
  return papers
}

/**
 * Register a paper by its stable natural key.
 *
 * Uploading the same paper again reuses the occurrence instead of inventing a second one, so the
 * same file re-imported cannot double count.
 */
export function registerPaper(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  payload: PaperIn,
  now: Instant,
): { paper: Record<string, unknown>; created: boolean } {
  const subject = requireSubject(db, userId, projectId, payload.subject_id)
  const cycleKey = strip(payload.cycle_key)
  const paperCode = strip(payload.paper_code)
  if (!cycleKey || !paperCode) throw new InvalidInput('年份/周期与卷别代码不能为空')
  const sourceKind = String(payload.source_kind ?? 'demo')
  if (!(SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    throw new InvalidInput('试卷来源类型无效', { details: { source_kind: sourceKind } })
  }

  return transaction(db, () => {
    const existing = findOne(db, 'exams_paper', {
      subject_id: subject.id,
      cycle_key: cycleKey,
      session_key: strip(payload.session_key),
      paper_code: paperCode,
    })
    if (existing !== null) return { paper: paperOut(db, existing), created: false }

    const paper = insertRow(
      db,
      'exams_paper',
      {
        subject_id: subject.id,
        cycle_key: cycleKey,
        session_key: strip(payload.session_key),
        paper_code: paperCode,
        source_kind: sourceKind,
        title: String(payload.title ?? '').slice(0, 300),
        notes: '',
        // A demo/mock source is never presented as a real past paper.
        is_demo: DEMO_SOURCE_KINDS.has(sourceKind),
        effective_revision_id: null,
      },
      { now },
    )
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'paper',
      entityId: String(paper.id),
      action: 'create',
      projectId: String(requireProject(db, userId, projectId).id),
      detail: { cycle_key: paper.cycle_key, paper_code: paper.paper_code, source_kind: paper.source_kind },
      now,
    })
    return { paper: paperOut(db, paper), created: true }
  })
}

export function getPaper(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  paperId: string,
): Record<string, unknown> {
  return paperOut(db, requirePaper(db, userId, projectId, paperId))
}

export function listPaperItems(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  revisionId: string,
): Record<string, unknown>[] {
  const revision = requireRevision(db, userId, projectId, revisionId)
  return findRows(db, 'exams_paper_item', { revision_id: revision.id }, {
    orderBy: [['position_key', 'asc']],
  }).map((item) => ({
    id: String(item.id),
    position_key: item.position_key,
    parent_item_id: item.parent_item_id === null ? null : String(item.parent_item_id),
    question_version_id: String(item.question_version_id),
    answer_key_version_id:
      item.answer_key_version_id === null ? null : String(item.answer_key_version_id),
    max_score: item.max_score === null ? null : String(item.max_score),
    is_scored: item.is_scored,
  }))
}

export interface CoverageIn {
  expected_session_count?: number | null
  covered_session_count?: number | null
  note?: string
  confirm?: boolean
}

/**
 * Record — or explicitly confirm — how much of one cycle a revision covers.
 *
 * Typing "expected 2 / covered 2" is an intention; the `confirm` flag is what states the cycle
 * really is covered, and cycle statistics count nothing but confirmed completeness.
 */
export function recordPaperCoverage(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  revisionId: string,
  payload: CoverageIn,
  now: Instant,
): Record<string, unknown> {
  const revision = requireRevision(db, userId, projectId, revisionId)
  if (revision.status === PAPER_REVISION_STATUS.WITHDRAWN) {
    throw new InvalidInput('已撤回的试卷版本不能登记覆盖情况')
  }
  const expected = payload.expected_session_count ?? null
  const covered = payload.covered_session_count ?? null
  if (expected !== null && expected < 1) throw new InvalidInput('预期场次必须是正整数')
  if (covered !== null && covered < 0) throw new InvalidInput('已覆盖场次不能为负')

  const nextExpected = expected ?? (revision.expected_session_count as number | null)
  const nextCovered = covered ?? (revision.covered_session_count as number | null)
  const patch: Record<string, unknown> = {}
  if (expected !== null) patch.expected_session_count = expected
  if (covered !== null) patch.covered_session_count = covered
  if (payload.confirm === true) {
    if (nextExpected === null || nextCovered === null) {
      throw new InvalidInput('确认覆盖前必须填写“预期场次”和“已覆盖场次”')
    }
    if (nextCovered < nextExpected) {
      throw new InvalidInput('已覆盖场次少于预期场次，不能标记为完整周期', {
        details: { expected: nextExpected, covered: nextCovered },
      })
    }
    patch.coverage_confirmed_by_id = userId
    patch.coverage_confirmed_at = now
  }
  if (payload.note) patch.note = String(payload.note).slice(0, 500)

  return transaction(db, () => {
    const updated = updateRow(db, 'exams_paper_revision', revision.id, patch, { now })!
    const paper = findOne(db, 'exams_paper', { id: String(revision.paper_id) })!
    const subject = findOne(db, 'exams_subject', { id: String(paper.subject_id) })!
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'paper_revision',
      entityId: String(revision.id),
      action: 'record_coverage',
      projectId: String(subject.project_id),
      detail: {
        expected_session_count: updated.expected_session_count,
        covered_session_count: updated.covered_session_count,
        coverage_status: coverageStatus(updated),
        confirmed: updated.coverage_confirmed_at !== null,
      },
      now,
    })
    return revisionOut(db, updated)
  })
}

/** Human confirmation that this revision's items are proofread and usable. */
export function confirmPaperRevision(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  revisionId: string,
  now: Instant,
): Record<string, unknown> {
  const revision = requireRevision(db, userId, projectId, revisionId)
  if (revision.status === PAPER_REVISION_STATUS.WITHDRAWN) {
    throw new InvalidInput('已撤回的试卷版本不能确认')
  }
  const scored = db
    .prepare('SELECT COUNT(*) AS n FROM "exams_paper_item" WHERE "revision_id" = ? AND "is_scored" = 1')
    .get(String(revision.id)) as { n: number }
  if (scored.n === 0) {
    throw new InvalidInput('该版本还没有任何计分题项，确认前请先完成导入与校对')
  }
  return transaction(db, () => {
    const updated = updateRow(
      db,
      'exams_paper_revision',
      revision.id,
      { status: PAPER_REVISION_STATUS.CONFIRMED },
      { now },
    )!
    const paper = findOne(db, 'exams_paper', { id: String(revision.paper_id) })!
    const subject = findOne(db, 'exams_subject', { id: String(paper.subject_id) })!
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'paper_revision',
      entityId: String(revision.id),
      action: 'confirm',
      projectId: String(subject.project_id),
      detail: { revision: revision.revision },
      now,
    })
    // The first confirmed revision becomes effective automatically; a later one does not, because
    // switching what counts statistically is a deliberate act.
    if (paper.effective_revision_id === null) {
      updateRow(db, 'exams_paper', paper.id, { effective_revision_id: revision.id }, { now })
    }
    return revisionOut(db, updated)
  })
}

/** One paper has exactly one statistically effective revision. */
export function setEffectiveRevision(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  paperId: string,
  revisionId: string,
  now: Instant,
): Record<string, unknown> {
  const paper = requirePaper(db, userId, projectId, paperId)
  const revision = findOne(db, 'exams_paper_revision', { id: revisionId, paper_id: paper.id })
  if (revision === null) throw new ScopeViolation('试卷版本不存在或不属于该试卷')
  if (revision.status === PAPER_REVISION_STATUS.WITHDRAWN) {
    throw new InvalidInput('已撤回版本不能设为有效版本')
  }
  return transaction(db, () => {
    const previous = paper.effective_revision_id
    const updated = updateRow(db, 'exams_paper', paper.id, { effective_revision_id: revision.id }, { now })!
    const subject = findOne(db, 'exams_subject', { id: String(paper.subject_id) })!
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'paper',
      entityId: String(paper.id),
      action: 'set_effective_revision',
      projectId: String(subject.project_id),
      detail: { from: previous === null ? null : String(previous), to: String(revision.id) },
      now,
    })
    return paperOut(db, updated)
  })
}

// ---------------------------------------------------------------------------
// Paper items (the bridge from "a question was published" to "this real paper
// occurrence contains this question with this score")
// ---------------------------------------------------------------------------

export interface PaperItemIn {
  positionKey: string
  questionVersionId: string
  answerKeyVersionId?: string | null
  maxScore: Decimal | string
  isScored?: boolean
  parentItemId?: string | null
}

/**
 * `add_paper_item` — one scored leaf occurrence in a paper revision.
 *
 * Duplicate positions are refused rather than merged: re-importing a paper must not publish the
 * same 卷面题号 twice, because the cycle analysis counts positions, not rows. The model's
 * `full_clean` errors are reported together, exactly like Django, and the stats projection is
 * enqueued in the same transaction as the item — a committed item with no refresh event would leave
 * the report claiming it is current.
 */
/**
 * `PaperItem.clean()` rules that the publish path can ask about without writing a row.
 *
 * Split out of `addPaperItem` for the B5 variant self-check: `official_past_rule_problems` has to
 * *prove* that "AI content never joins a real paper" is still enforced, and the only honest way to
 * prove it is to run the same rule the writer runs. Keeping one implementation is what makes the
 * probe meaningful (a second copy could pass while the writer had lost the rule).
 */
export function paperItemRuleErrors(input: {
  revisionId: string
  paperSubjectId: string
  questionSubjectId: string
  questionOriginType: string
  paperSourceKind: string
  parentRevisionId?: string | null
  maxScore: Decimal
}): Record<string, string> {
  const errors: Record<string, string> = {}
  if (
    input.parentRevisionId !== null &&
    input.parentRevisionId !== undefined &&
    String(input.parentRevisionId) !== String(input.revisionId)
  ) {
    errors['parent_item'] = '父题项必须属于同一试卷版本'
  }
  // `PaperItem.clean()` repeats the subject check and refuses AI content on a real paper.
  if (String(input.questionSubjectId) !== String(input.paperSubjectId)) {
    errors['question_version'] = '题目科目与试卷科目不一致'
  }
  if (input.questionOriginType === 'ai_generated' && input.paperSourceKind === 'official_past') {
    errors['question_version'] = 'AI 生成题不得挂到真实考试发生记录'
  }
  if (input.maxScore.isNegative()) errors['max_score'] = '分值不能为负'
  return errors
}

export function addPaperItem(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  revisionId: string,
  input: PaperItemIn,
  now: Instant,
): Record<string, unknown> {
  const revision = findOne(db, 'exams_paper_revision', { id: revisionId })
  if (revision === null) throw new ScopeViolation('试卷版本不存在或不属于该项目')
  const paper = findOne(db, 'exams_paper', { id: String(revision.paper_id) })
  const subject = paper === null ? null : findOne(db, 'exams_subject', { id: String(paper.subject_id) })
  if (paper === null || subject === null || String(subject.project_id) !== String(projectId)) {
    throw new ScopeViolation('试卷版本不存在或不属于该项目')
  }
  if (revision.status === PAPER_REVISION_STATUS.WITHDRAWN) {
    throw new InvalidInput('已撤回试卷版本不能新增题项')
  }
  // Django checks the *raw* argument for a duplicate and stores the stripped form
  // (`PaperItem(position_key=position_key.strip())`). Keeping both is what makes a padded
  // re-import collide on the unique constraint exactly where Django collides.
  const rawPosition = String(input.positionKey ?? '')
  const positionKey = rawPosition.trim()
  const duplicate = findOne(db, 'exams_paper_item', { revision_id: revision.id, position_key: rawPosition })
  if (duplicate !== null) {
    throw new InvalidInput('该试卷版本已存在相同题号，请确认是修订还是不同卷', {
      details: { position_key: positionKey },
    })
  }
  const version = findOne(db, 'question_bank_question_version', { id: input.questionVersionId })
  const question = version === null ? null : findOne(db, 'question_bank_question', { id: String(version.question_id) })
  if (question === null) throw new ScopeViolation('题目版本不存在或不属于该项目')
  if (String(question.subject_id) !== String(paper.subject_id)) {
    throw new ScopeViolation('题目科目与试卷科目不一致')
  }
  const parent = input.parentItemId === null || input.parentItemId === undefined
    ? null
    : findOne(db, 'exams_paper_item', { id: input.parentItemId })
  const maxScore = input.maxScore instanceof Decimal ? input.maxScore : Decimal.parse(String(input.maxScore))

  const errors = paperItemRuleErrors({
    revisionId: String(revision.id),
    paperSubjectId: String(paper.subject_id),
    questionSubjectId: String(question.subject_id),
    questionOriginType: String(question.origin_type),
    paperSourceKind: String(paper.source_kind),
    parentRevisionId: parent === null ? null : String(parent.revision_id),
    maxScore,
  })
  if (Object.keys(errors).length > 0) {
    throw new StructureInvalid('结构校验失败', { details: { errors } })
  }

  return transaction(db, () => {
    const item = insertRow(
      db,
      'exams_paper_item',
      {
        revision_id: revision.id,
        position_key: positionKey,
        parent_item_id: parent === null ? null : parent.id,
        question_version_id: version!.id,
        answer_key_version_id: input.answerKeyVersionId ?? null,
        max_score: maxScore,
        is_scored: input.isScored ?? true,
        is_demo: Boolean(paper.is_demo),
      },
      { now },
    )
    writeContentRevision(db, {
      actorId: userId,
      entityType: 'paper_item',
      entityId: String(item.id),
      action: 'create',
      projectId: String(subject.project_id),
      detail: { position_key: item.position_key, max_score: maxScore.toString(), is_scored: Boolean(item.is_scored) },
      now,
    })
    enqueue(db, {
      topic: 'projection.refresh_paper_stats',
      payload: { paper_id: String(paper.id) },
      dedupeKey: `paper-stats:${String(paper.id)}:${String(revision.id)}`,
      now,
    })
    return item
  })
}

// --------------------------------------------------------------------------
// Paper occurrence helpers used by the PDF import (O09)
// --------------------------------------------------------------------------

/** `SourceKind` values that are never presented as an official past paper. */
const DEMO_PAPER_SOURCE_KINDS: ReadonlySet<string> = new Set(['demo', 'mock'])

export interface PaperOccurrenceIn {
  subjectId: string
  projectId: string
  cycleKey: string
  sessionKey?: string
  paperCode: string
  sourceKind?: string
  title?: string
  actorId: string
}

/**
 * `get_or_create_paper`: register a paper occurrence by its stable natural key.
 *
 * The `get_or_create` semantics matter and are preserved exactly: when the occurrence already
 * exists, **nothing** is overwritten — in particular its `source_kind`, so a later import cannot
 * reclassify an official past paper as a practice set (or the reverse) just by uploading a file.
 * The audit row is written only when the occurrence is new.
 */
export function getOrCreatePaperForImport(
  db: DatabaseSync,
  input: PaperOccurrenceIn,
  now: Instant,
): { paper: Record<string, unknown>; created: boolean } {
  const cycleKey = input.cycleKey.trim()
  const paperCode = input.paperCode.trim()
  if (!cycleKey || !paperCode) throw new InvalidInput('年份/周期与卷别代码不能为空')
  const sourceKind = String(input.sourceKind ?? 'demo')
  if (!(SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    throw new InvalidInput('试卷来源类型无效', { details: { source_kind: sourceKind } })
  }
  const sessionKey = (input.sessionKey ?? '').trim()
  const existing = findOne(db, 'exams_paper', {
    subject_id: input.subjectId,
    cycle_key: cycleKey,
    session_key: sessionKey,
    paper_code: paperCode,
  })
  if (existing !== null) return { paper: existing, created: false }

  const paper = insertRow(
    db,
    'exams_paper',
    {
      subject_id: input.subjectId,
      cycle_key: cycleKey,
      session_key: sessionKey,
      paper_code: paperCode,
      source_kind: sourceKind,
      title: pyCodePointSlice(input.title ?? '', 0, 300),
      notes: '',
      // A demo/mock source is never presented as a real past paper.
      is_demo: DEMO_PAPER_SOURCE_KINDS.has(sourceKind),
      effective_revision_id: null,
    },
    { now },
  )
  writeContentRevision(db, {
    actorId: input.actorId,
    entityType: 'paper',
    entityId: String(paper.id),
    action: 'create',
    projectId: input.projectId,
    detail: { cycle_key: paper.cycle_key, paper_code: paper.paper_code, source_kind: paper.source_kind },
    now,
  })
  return { paper, created: true }
}

/**
 * `create_paper_revision`: open one more draft revision for an existing occurrence.
 *
 * Every import opens a **new draft**: a re-import is a new reading of the same paper, and reusing
 * the previous revision would silently edit what a proofreader already confirmed. The revision is
 * left with `coverage_confirmed_at = null` and the paper's `effective_revision_id` untouched —
 * "the file arrived" is not "this is the statistically effective version".
 */
export function createPaperRevisionForImport(
  db: DatabaseSync,
  paper: Record<string, unknown>,
  fields: {
    expectedSessionCount?: number | null
    coveredSessionCount?: number | null
    note?: string
    actorId: string
    projectId: string
  },
  now: Instant,
): Record<string, unknown> {
  const revision = nextVersion(db, 'exams_paper_revision', { paper_id: paper.id }, 'revision')
  const row = insertRow(
    db,
    'exams_paper_revision',
    {
      paper_id: paper.id,
      revision,
      spec_version_id: null,
      expected_session_count: fields.expectedSessionCount ?? null,
      covered_session_count: fields.coveredSessionCount ?? null,
      coverage_confirmed_by_id: null,
      coverage_confirmed_at: null,
      status: PAPER_REVISION_STATUS.DRAFT,
      note: fields.note ?? '',
    },
    { now },
  )
  writeContentRevision(db, {
    actorId: fields.actorId,
    entityType: 'paper_revision',
    entityId: String(row.id),
    action: 'create',
    projectId: fields.projectId,
    detail: { revision },
    now,
  })
  return row
}
