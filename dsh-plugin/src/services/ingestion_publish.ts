/**
 * O18 — publish a proofread candidate into an immutable question version.
 *
 * Port of `backend/apps/ingestion/services/core.py::publish_candidate` and its helpers
 * (`_ensure_material_version`, `published_child_version_ids`, `_reconcile_material_children`,
 * `_write_paper_item`, `_paper_position_key`, `_published_parent_item`,
 * `_attach_children_to_material_item`).
 *
 * The whole write-set is one transaction: candidate state, question identity, version, answer,
 * rubric, mappings, source links, paper item, audit rows and the stats outbox event either all
 * commit or none do. That matters most in the material flow, where a child publish creates the
 * parent's draft version *before* the parent can be published — a half-committed material would
 * leave a question identity nobody can publish.
 *
 * Two rules are easy to "simplify" and must not be:
 * - a material's own version is created by its **first child's** publication (a child points at its
 *   parent through a real version row), but it is published only after every child is;
 * - the paper item's `publication_paper_item_id` is the idempotency guard: a retried publication
 *   must not create a second item, and the unique (revision, position) constraint is the backstop.
 */
import type { DatabaseSync } from 'node:sqlite'

import { pyStr, pyTruthy } from '../ai/pyvalue.ts'
import { Decimal } from '../domain/decimal.ts'
import type { Instant } from '../domain/instant.ts'
import { transaction } from '../store/db.ts'
import { findOne, findRows, getRow, insertRow, updateRow, type Row } from '../store/repository.ts'
import { addPaperItem } from './exams.ts'
import { InvalidInput, ScopeViolation, StructureInvalid } from './errors.ts'
import { candidateSourceRegionRows, maybeCompleteJob, refreshCandidateIssues } from './ingestion.ts'
import { replaceKnowledgeMappings } from './mappings.ts'
import {
  createAnswerKeyVersion,
  createQuestion,
  createQuestionVersionDraft,
  normalizeContent,
  publishQuestionVersion,
  upsertRubricVersion,
} from './questions.ts'

const MATERIAL = 'material'
const CONSTRUCTED_RESPONSE = 'constructed_response'
const PUBLISHED = 'published'
const IGNORED = 'ignored'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** `_to_decimal`: `None`/`""` mean "not declared"; anything unparseable is a client error. */
function toDecimalOrNull(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === '') return null
  try {
    return value instanceof Decimal ? value : Decimal.parse(String(value))
  } catch {
    throw new InvalidInput('分值必须是十进制数')
  }
}

/** `spec_version.default_max_score(question_type)` — an absent/blank rule is `None`. */
function specDefaultMaxScore(spec: Row, questionType: unknown): Decimal | null {
  const rules = asRecord(spec.question_type_rules) ?? {}
  const rule = asRecord(rules[String(questionType)]) ?? {}
  const raw = rule['default_max_score']
  if (raw === null || raw === undefined || raw === '') return null
  try {
    return Decimal.parse(String(raw))
  } catch {
    return null
  }
}

export interface PublishCandidateOptions {
  /** Resolved by the route before the idempotency claim, exactly like the Django API. */
  examSpecVersion?: Row | null
  nodeIds?: string[]
  originType?: string
  displayLabel?: string
}

export interface PublishCandidateResult {
  candidate: Row
  question: Row
}

/**
 * Publish one candidate. The caller owns the idempotency claim and the outer transaction; this
 * function is the whole business write-set.
 */
export function publishCandidate(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  candidateId: string,
  options: PublishCandidateOptions,
  now: Instant,
): PublishCandidateResult {
  return transaction(db, () => {
    const locked = getRow(db, 'ingestion_import_candidate', candidateId)
    if (locked === null || String(locked.project_id) !== String(projectId)) {
      throw new ScopeViolation('候选不存在或不属于该项目')
    }
    if (locked.status === PUBLISHED) {
      const question =
        locked.publication_question_id === null
          ? null
          : getRow(db, 'question_bank_question', locked.publication_question_id)
      if (question === null) throw new InvalidInput('候选已发布但题目身份缺失，请检查数据一致性')
      return { candidate: locked, question }
    }
    if (locked.status === IGNORED) throw new InvalidInput('已忽略的候选不能发布')
    if (!pyTruthy(locked.subject_id)) throw new InvalidInput('发布前必须选择科目')

    const payload = asRecord(locked.draft_payload) ?? {}
    const questionType = payload['question_type']
    const content = asRecord(payload['content']) ?? {}
    const issues = refreshCandidateIssues(db, locked, now)
    const blocking = issues.filter((issue) => (issue as Record<string, unknown>)['severity'] === 'blocking')
    if (blocking.length > 0) {
      throw new StructureInvalid('候选仍有未解决的问题，不能发布', { details: { problems: blocking } })
    }

    const job = getRow(db, 'ingestion_import_job', locked.job_id)
    if (job === null) throw new Error(`import job ${String(locked.job_id)} is missing`)
    let originType = String(options.originType ?? 'user_authored')
    if (job.input_kind === 'ai_variant') {
      // A variant is AI content by construction; relabelling it as user-authored would let it into
      // real-paper statistics. No B2 operation creates an `ai_variant` job (that is B5), so this
      // branch is defensive parity rather than a reachable path.
      originType = 'ai_generated'
    }

    const declaredScore = toDecimalOrNull(payload['practice_max_score'])
    const score =
      declaredScore !== null
        ? declaredScore
        : options.examSpecVersion === null || options.examSpecVersion === undefined
          ? null
          : specDefaultMaxScore(options.examSpecVersion, questionType)

    let question: Row
    let version: Row
    if (questionType === MATERIAL) {
      version = ensureMaterialVersion(db, userId, projectId, locked, now)
      question = getRow(db, 'question_bank_question', version.question_id)!
      // Django assigns the raw payload content here (not `normalize_content`); the digest computed
      // at publish normalises internally, so both forms hash the same.
      version = updateRow(
        db,
        'question_bank_question_version',
        version.id,
        {
          content,
          material_child_version_ids: publishedChildVersionIds(db, locked),
        },
        { now },
      )!
    } else {
      question = createQuestion(
        db,
        userId,
        {
          subjectId: String(locked.subject_id),
          originType,
          displayLabel:
            options.displayLabel !== undefined && options.displayLabel !== ''
              ? options.displayLabel
              : pyStr(payload['display_label'] ?? ''),
          isDemo: originType === 'demo' || originType === 'ai_generated',
        },
        now,
      )
      version = createQuestionVersionDraft(
        db,
        userId,
        projectId,
        String(question.id),
        {
          questionType: String(questionType),
          content,
          practiceMaxScore: score,
          estimatedSeconds:
            payload['estimated_seconds'] === undefined ? null : (payload['estimated_seconds'] as number | null),
          revisionReason: `由导入候选 ${String(locked.id)} 发布`,
        },
        now,
      )
      if (pyTruthy(locked.parent_candidate_id)) {
        const parent = getRow(db, 'ingestion_import_candidate', locked.parent_candidate_id)
        if (parent === null) throw new Error(`parent candidate ${String(locked.parent_candidate_id)} is missing`)
        const materialVersion = ensureMaterialVersion(db, userId, projectId, parent, now)
        // Django sets the parent after `full_clean`, i.e. without re-validating the draft.
        version = updateRow(
          db,
          'question_bank_question_version',
          version.id,
          { parent_material_version_id: materialVersion.id },
          { now },
        )!
      }
    }

    for (const region of candidateSourceRegionRows(db, String(locked.id))) {
      insertRow(
        db,
        'question_bank_source_link',
        {
          question_version_id: version.id,
          region_id: region.id,
          role: 'stem',
          note: '',
        },
        { now },
      )
    }

    let answer: Row | null = null
    if (questionType !== MATERIAL) {
      answer = createAnswerKeyVersion(
        db,
        userId,
        projectId,
        String(version.id),
        {
          answerPayload: asRecord(payload['answer_payload']) ?? {},
          sourceType: pyTruthy(payload['answer_source_type']) ? String(payload['answer_source_type']) : 'user',
          verificationStatus: 'checked',
          checkBasis: pyTruthy(payload['check_basis'])
            ? String(payload['check_basis'])
            : '人工校对确认（导入流程）',
          explanationBlocks: Array.isArray(payload['explanation_blocks']) ? payload['explanation_blocks'] : [],
        },
        now,
      )
      if (questionType === CONSTRUCTED_RESPONSE) {
        const criteria = Array.isArray(payload['rubric_criteria']) ? payload['rubric_criteria'] : []
        // `_to_decimal(a) or _to_decimal(b) or Decimal("0")`: a declared zero falls through,
        // because `Decimal("0")` is falsy in Python.
        const declaredTotal = toDecimalOrNull(payload['rubric_total_score'])
        const fallbackTotal = toDecimalOrNull(payload['practice_max_score'])
        const rubricTotal =
          declaredTotal !== null && declaredTotal.truthy
            ? declaredTotal
            : fallbackTotal !== null && fallbackTotal.truthy
              ? fallbackTotal
              : Decimal.zero()
        upsertRubricVersion(db, userId, projectId, String(answer.id), { criteria, totalScore: rubricTotal }, now)
      }
    }

    const nodeIds = (options.nodeIds ?? []).map(String)
    if (nodeIds.length > 0) {
      // Equal weights, not remainder distribution: Python divides 1 by the node count, and three
      // nodes therefore fail the "sum is exactly 1" check instead of being silently adjusted.
      const weight = Decimal.parse('1').div(Decimal.fromInt(nodeIds.length))
      replaceKnowledgeMappings(
        db,
        projectId,
        String(version.id),
        nodeIds.map((nodeId) => ({ node_id: nodeId, is_primary: true, score_weight: weight.toString() })),
        { actorId: userId, now },
      )
    }

    const published = publishQuestionVersion(db, userId, projectId, String(version.id), { now })

    const updated = updateRow(
      db,
      'ingestion_import_candidate',
      locked.id,
      {
        status: PUBLISHED,
        publication_question_id: question.id,
        publication_version_id: published.id,
      },
      { now },
    )!
    writePaperItem(db, userId, projectId, updated, published, now)
    reconcileMaterialChildren(db, userId, updated, now)
    refreshCandidateIssues(db, getRow(db, 'ingestion_import_candidate', locked.id)!, now)
    maybeCompleteJob(db, getRow(db, 'ingestion_import_job', locked.job_id)!, now)
    return { candidate: getRow(db, 'ingestion_import_candidate', locked.id)!, question }
  })
}

/**
 * The material's own version, created as a draft on first need.
 *
 * A sub-question can only point at its material through a real version row, so the version must
 * exist before the first child is published — but it can only be *published* after its children
 * are, which is why the two steps are separate.
 */
export function ensureMaterialVersion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  candidate: Row,
  now: Instant,
): Row {
  if (pyTruthy(candidate.publication_version_id)) {
    const existing = getRow(db, 'question_bank_question_version', candidate.publication_version_id)
    if (existing !== null) return existing
  }
  const payload = asRecord(candidate.draft_payload) ?? {}
  const question = createQuestion(
    db,
    userId,
    {
      subjectId: String(candidate.subject_id),
      originType: 'user_authored',
      displayLabel: pyStr(payload['display_label'] ?? ''),
      isDemo: false,
    },
    now,
  )
  const content = asRecord(payload['content']) ?? { blocks: [] }
  const version = createQuestionVersionDraft(
    db,
    userId,
    projectId,
    String(question.id),
    {
      questionType: MATERIAL,
      content,
      revisionReason: `由导入候选 ${String(candidate.id)} 的材料题版本`,
    },
    now,
  )
  updateRow(
    db,
    'ingestion_import_candidate',
    candidate.id,
    { publication_question_id: question.id, publication_version_id: version.id },
    { now },
  )
  return version
}

/** Published versions of a material candidate's children, in source order. */
export function publishedChildVersionIds(db: DatabaseSync, candidate: Row): string[] {
  return findRows(db, 'ingestion_import_candidate', { parent_candidate_id: candidate.id }, {
    orderBy: [['created_at', 'asc']],
  })
    .map((child) => child.publication_version_id)
    .filter((value) => pyTruthy(value))
    .map((value) => String(value))
}

/** Keep a material version's child list in step with its published children. */
export function reconcileMaterialChildren(
  db: DatabaseSync,
  userId: string,
  candidate: Row,
  now: Instant,
): void {
  if (!pyTruthy(candidate.parent_candidate_id)) return
  const parent = getRow(db, 'ingestion_import_candidate', candidate.parent_candidate_id)
  if (parent === null || !pyTruthy(parent.publication_version_id)) return
  const version = getRow(db, 'question_bank_question_version', parent.publication_version_id)
  if (version === null) return
  const derived = publishedChildVersionIds(db, parent)
  const current = Array.isArray(version.material_child_version_ids)
    ? (version.material_child_version_ids as unknown[]).map(String)
    : []
  if (JSON.stringify([...current].sort()) !== JSON.stringify([...derived].sort())) {
    updateRow(db, 'question_bank_question_version', version.id, { material_child_version_ids: derived }, { now })
  }
}

/** The 卷面题号 a candidate occupies; candidates always have one. */
function paperPositionKey(candidate: Row): string {
  const payload = asRecord(candidate.draft_payload) ?? {}
  if (pyTruthy(candidate.source_position_key)) return String(candidate.source_position_key)
  if (pyTruthy(payload['display_label'])) return pyStr(payload['display_label'])
  return `cand-${String(candidate.id).slice(0, 8)}`
}

/**
 * Create the PaperItem for a published candidate, exactly once.
 *
 * This is the bridge between "a question was published" and "the real paper occurrence now
 * contains this question with this score", which is what the cycle analysis counts.
 */
export function writePaperItem(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  candidate: Row,
  publishedVersion: Row,
  now: Instant,
): void {
  if (!pyTruthy(candidate.paper_revision_id) || candidate.publication_paper_item_id !== null) return
  const payload = asRecord(candidate.draft_payload) ?? {}
  const isMaterial = payload['question_type'] === MATERIAL
  const revision = getRow(db, 'exams_paper_revision', candidate.paper_revision_id)
  if (revision === null) throw new Error(`paper revision ${String(candidate.paper_revision_id)} is missing`)
  const latestAnswer =
    findRows(db, 'question_bank_answer_key_version', { question_version_id: publishedVersion.id }).sort(
      (a, b) => Number(b.version) - Number(a.version),
    )[0] ?? null
  const parentCandidate = pyTruthy(candidate.parent_candidate_id)
    ? getRow(db, 'ingestion_import_candidate', candidate.parent_candidate_id)
    : null
  const parentItem =
    parentCandidate !== null && pyTruthy(parentCandidate.publication_paper_item_id)
      ? getRow(db, 'exams_paper_item', parentCandidate.publication_paper_item_id)
      : null
  const maxScore = isMaterial ? Decimal.zero() : (toDecimalOrNull(payload['practice_max_score']) ?? Decimal.zero())
  const item = addPaperItem(
    db,
    userId,
    projectId,
    String(revision.id),
    {
      positionKey: paperPositionKey(candidate),
      questionVersionId: String(publishedVersion.id),
      answerKeyVersionId: latestAnswer === null ? null : String(latestAnswer.id),
      maxScore,
      isScored: !isMaterial,
      parentItemId: parentItem === null ? null : String(parentItem.id),
    },
    now,
  )
  updateRow(
    db,
    'ingestion_import_candidate',
    candidate.id,
    { publication_paper_item_id: item.id },
    { now },
  )
  if (!isMaterial) return
  // Children are usually published first, so their items are linked here.
  for (const child of findRows(db, 'ingestion_import_candidate', { parent_candidate_id: candidate.id })) {
    if (!pyTruthy(child.publication_paper_item_id)) continue
    updateRow(db, 'exams_paper_item', child.publication_paper_item_id, { parent_item_id: item.id }, { now })
  }
}
