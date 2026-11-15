/**
 * Contamination: what makes a question impossible to call "strictly unseen".
 *
 * Port of `backend/apps/learning/services/contamination.py`. The Python module is
 * the single place the "has this question already been exposed" rules live; this
 * port keeps the same shape: one evaluation per question set, and every caller
 * that needs an exclusion reason consumes it.
 *
 * The port is a *pure function over facts*: the caller (store layer) reads the
 * exposure ledger, the session items and the question/family rows and hands them
 * over as plain data. Nothing here reads a database, a clock or configuration, so
 * the same facts always produce byte-identical reasons — which is what makes the
 * Python-generated golden vectors meaningful.
 *
 * Rules (docs/05 §3 C04):
 *   - `external_seen` / `editorial_preview_seen` — absolute: once recorded, the
 *     question can never again be first contact (a later "seen=false" correction
 *     is history, not a reset).
 *   - `stem_delivered` / `hint_delivered` / `explanation_delivered` /
 *     `answer_delivered` / `feedback_delivered` — judged at an instant, so a
 *     rebuild of an old attempt sees only what was known then.
 *   - `presented_without_submit` — a presented item that was never submitted.
 *   - `lineage_seen_in_other_project` — the same content was exposed in another
 *     of the owner's projects.
 *   - `family_variant_seen` — C03: a member of a **merged** family is seen if any
 *     other member of that family was seen.
 */
import { type Instant, formatPythonIso, parseInstant } from './instant.ts'

/** Stable presentation order of the reason codes (and of recomputation). */
export const REASON_ORDER: readonly string[] = [
  'external_seen',
  'editorial_preview_seen',
  'answer_delivered',
  'explanation_delivered',
  'hint_delivered',
  'feedback_delivered',
  'stem_delivered',
  'presented_without_submit',
  'lineage_seen_in_other_project',
  'family_variant_seen',
]

/** Reasons that never expire. */
export const ABSOLUTE_REASON_CODES: ReadonlySet<string> = new Set(['external_seen', 'editorial_preview_seen'])

/** Exposure kinds that map onto an absolute reason code. */
const ABSOLUTE_KINDS: ReadonlySet<string> = new Set(['external_seen', 'editorial_preview'])

/** Exposure kind -> reason code. Unlisted kinds are not contamination markers. */
const KIND_TO_REASON: ReadonlyMap<string, string> = new Map([
  ['stem_delivered', 'stem_delivered'],
  ['hint_delivered', 'hint_delivered'],
  ['explanation_delivered', 'explanation_delivered'],
  ['answer_delivered', 'answer_delivered'],
  ['feedback_delivered', 'feedback_delivered'],
  ['editorial_preview', 'editorial_preview_seen'],
  ['external_seen', 'external_seen'],
])

/** Reason code -> the sentence stored in `LearningEvidence.exclusion_reasons`. */
export const REASON_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['external_seen', '本人已声明在系统外见过本题（声明不可撤销，不能重新标为严格未见）'],
  ['editorial_preview_seen', '本人校对/编辑预览过本题（校对已看过答案，不能重新标为严格未见）'],
  ['answer_delivered', '本题已下发过答案，不能作为严格独立首次接触证据'],
  ['explanation_delivered', '本题已下发过讲解，不能作为严格独立首次接触证据'],
  ['hint_delivered', '本题已下发过提示，不能作为严格独立首次接触证据'],
  ['feedback_delivered', '本题已下发过判分反馈，不能作为严格独立首次接触证据'],
  ['stem_delivered', '本题题干已下发过（重复练习按重复统计，不能作为首次接触或陌生变式证据）'],
  ['presented_without_submit', '本题曾展示但未提交（已展示未提交的题不能重新标为严格未见）'],
  [
    'lineage_seen_in_other_project',
    '同一内容在本人其他项目中已暴露（内容谱系跨项目计为已见，不能重新标为严格未见）',
  ],
  [
    'family_variant_seen',
    '同家族（合并后）的其他题目已暴露：家族合并后不再构成不同家族证据，不能作为陌生变式或严格首次接触',
  ],
])

export interface QuestionFact {
  id: string
  content_lineage_id: string | null
  family_id: string | null
  /** `question.subject.project_id`. */
  subject_project_id: string | null
}

export interface FamilyFact {
  id: string
  merged_into_id: string | null
  member_ids: string[]
}

export interface ExposureFact {
  id: string
  question_id: string | null
  question_version_id: string | null
  question_version_question_id: string | null
  content_lineage_id: string | null
  project_id: string | null
  session_item_id: string | null
  kind: string
  /** ISO-8601 instant (`datetime.isoformat()`). */
  server_time: string
}

export interface ItemFact {
  id: string
  question_id: string
  content_lineage_id: string | null
  session_project_id: string
  /** ISO-8601 instant; items without a delivery instant are not passed in. */
  first_delivered_at: string
  has_attempt: boolean
}

/**
 * All ledger facts for one owner. The caller scopes by user; this module never
 * filters by owner, so a fact set is *the* answer for that owner and nothing else.
 */
export interface ExposureFacts {
  questions: QuestionFact[]
  families: FamilyFact[]
  exposures: ExposureFact[]
  items: ItemFact[]
}

export interface ExposureQuery {
  question_ids: string[]
  /** The project the caller asks *from* (the lineage rule counts other projects). */
  project_id?: string | null
  /** Instant the delivery-caused reasons are judged at; `null` = no window. */
  before?: string | null
  exclude_session_item_ids?: string[]
}

export interface ContaminationFact {
  code: string
  at: Instant | null
  evidence_id: string
  evidence_type: 'exposure_event' | 'session_item' | 'family_member'
  exposure_kind: string | null
  question_id: string
  project_id: string | null
  session_item_id: string | null
  cross_project: boolean
}

export interface ReasonRow {
  code: string
  message: string
  evidence: {
    evidence_id: string
    evidence_type: string
    exposure_kind: string | null
    question_id: string
    project_id: string | null
    session_item_id: string | null
    server_time: string | null
  }
}

export interface ExposureState {
  seen: boolean
  reasons: string[]
  first_seen_at: string | null
  sources: string[]
  strict_independent_eligible: boolean
  exclusion_reasons: ReasonRow[]
}

/** Earlier by instant; a fact without an instant is never "earlier" than one with. */
function earlier(candidate: ContaminationFact, current: ContaminationFact): boolean {
  if (candidate.at === null) return false
  if (current.at === null) return true
  return candidate.at < current.at
}

function factEvidence(fact: ContaminationFact): ReasonRow['evidence'] {
  return {
    evidence_id: fact.evidence_id,
    evidence_type: fact.evidence_type,
    exposure_kind: fact.exposure_kind,
    question_id: fact.question_id,
    project_id: fact.project_id,
    session_item_id: fact.session_item_id,
    server_time: fact.at === null ? null : formatPythonIso(fact.at),
  }
}

function sourceLabel(fact: ContaminationFact): string {
  if (fact.evidence_type === 'session_item') {
    const prefix = fact.cross_project ? 'lineage_session_item' : 'session_item'
    return `${prefix}:presented_without_submit`
  }
  if (fact.evidence_type === 'family_member') {
    return `merged_family_member:${fact.question_id}`
  }
  const prefix = fact.cross_project ? 'lineage_exposure' : 'exposure_event'
  return `${prefix}:${fact.exposure_kind}`
}

/** Collapse facts into one deterministic reason row per code (earliest wins). */
export function reasonRows(facts: readonly ContaminationFact[]): { rows: ReasonRow[]; chosen: ContaminationFact[] } {
  const best = new Map<string, ContaminationFact>()
  for (const fact of facts) {
    const current = best.get(fact.code)
    if (current === undefined || earlier(fact, current)) best.set(fact.code, fact)
  }
  const rows: ReasonRow[] = []
  const chosen: ContaminationFact[] = []
  for (const code of REASON_ORDER) {
    const fact = best.get(code)
    if (fact === undefined) continue
    rows.push({ code, message: REASON_MESSAGES.get(code) as string, evidence: factEvidence(fact) })
    chosen.push(fact)
  }
  return { rows, chosen }
}

/**
 * `question id -> every member of its merged family`, for questions whose family
 * absorbed another family. Before any merge exists this is empty and the C04
 * rules are unchanged for ordinary families.
 */
export function mergedFamilyScope(
  questions: ReadonlyMap<string, QuestionFact>,
  families: readonly FamilyFact[],
): Map<string, string[]> {
  const familyIds = new Set<string>()
  for (const question of questions.values()) {
    if (question.family_id) familyIds.add(question.family_id)
  }
  if (familyIds.size === 0) return new Map()
  const mergedTargets = new Set<string>()
  for (const family of families) {
    if (family.merged_into_id && familyIds.has(family.merged_into_id)) mergedTargets.add(family.merged_into_id)
  }
  if (mergedTargets.size === 0) return new Map()
  const members = new Map<string, string[]>()
  for (const family of families) {
    if (mergedTargets.has(family.id)) members.set(family.id, [...family.member_ids].sort())
  }
  const out = new Map<string, string[]>()
  for (const [questionId, question] of questions) {
    if (!question.family_id) continue
    const memberList = members.get(question.family_id)
    if (memberList) out.set(questionId, memberList)
  }
  return out
}

/** `question id -> the project a question is asked *from*`, else its subject's project. */
function homeProjectId(question: QuestionFact, projectId: string | null): string | null {
  if (projectId !== null) return projectId
  return question.subject_project_id
}

class Evaluator {
  private readonly facts = new Map<string, ContaminationFact[]>()
  private readonly questions: Map<string, QuestionFact>
  private readonly families: readonly FamilyFact[]
  private readonly exposures: readonly ExposureFact[]
  private readonly items: readonly ItemFact[]
  private readonly projectId: string | null
  private readonly before: Instant | null
  private readonly excludedItems: ReadonlySet<string>

  private readonly data: ExposureFacts
  private readonly query: ExposureQuery

  constructor(data: ExposureFacts, query: ExposureQuery) {
    this.data = data
    this.query = query
    this.families = data.families
    this.exposures = data.exposures
    this.items = data.items
    this.projectId = query.project_id ?? null
    this.before = query.before ? parseInstant(query.before) : null
    this.excludedItems = new Set(query.exclude_session_item_ids ?? [])
    this.questions = new Map()
    const byId = new Map(data.questions.map((question) => [question.id, question]))
    for (const questionId of query.question_ids) {
      const question = byId.get(questionId)
      if (question) this.questions.set(questionId, question)
      this.facts.set(questionId, [])
    }
  }

  private inWindow(instant: Instant, kind: string): boolean {
    if (this.before === null) return true
    return ABSOLUTE_KINDS.has(kind) || instant < this.before
  }

  private add(questionId: string, fact: Omit<ContaminationFact, 'question_id'>): void {
    const bucket = this.facts.get(questionId)
    if (bucket === undefined) return
    bucket.push({ ...fact, question_id: questionId })
  }

  /** Step 1 + 2: deliveries the server logged, and presentations that were never submitted. */
  private directFacts(): void {
    const evaluated = new Set(this.questions.keys())
    for (const row of this.exposures) {
      const directMatch =
        (row.question_version_question_id !== null && evaluated.has(row.question_version_question_id)) ||
        (row.question_id !== null && evaluated.has(row.question_id))
      if (!directMatch) continue
      if (row.session_item_id !== null && this.excludedItems.has(row.session_item_id)) continue
      const code = KIND_TO_REASON.get(row.kind)
      if (code === undefined) continue
      const at = parseInstant(row.server_time)
      if (!this.inWindow(at, row.kind)) continue
      const questionId = row.question_id ?? row.question_version_question_id ?? ''
      if (!this.facts.has(questionId)) continue
      this.add(questionId, {
        code,
        at,
        evidence_id: row.id,
        evidence_type: 'exposure_event',
        exposure_kind: row.kind,
        project_id: row.project_id,
        session_item_id: row.session_item_id,
        cross_project: false,
      })
    }

    for (const item of this.items) {
      if (!evaluated.has(item.question_id)) continue
      if (item.has_attempt) continue
      if (this.excludedItems.has(item.id)) continue
      const at = parseInstant(item.first_delivered_at)
      if (this.before !== null && !(at < this.before)) continue
      this.add(item.question_id, {
        code: 'presented_without_submit',
        at,
        evidence_id: item.id,
        evidence_type: 'session_item',
        exposure_kind: null,
        project_id: item.session_project_id,
        session_item_id: item.id,
        cross_project: false,
      })
    }
  }

  /** Step 3: the same content in another project — exposure follows the lineage. */
  private lineageFacts(): void {
    const lineageHomes = new Map<string, Set<string>>()
    for (const question of this.questions.values()) {
      if (question.content_lineage_id === null) continue
      const home = homeProjectId(question, this.projectId)
      if (home === null) continue
      const homes = lineageHomes.get(question.content_lineage_id) ?? new Set<string>()
      homes.add(home)
      lineageHomes.set(question.content_lineage_id, homes)
    }
    if (lineageHomes.size === 0) return

    for (const row of this.exposures) {
      if (row.content_lineage_id === null || !lineageHomes.has(row.content_lineage_id)) continue
      if (row.session_item_id !== null && this.excludedItems.has(row.session_item_id)) continue
      const at = parseInstant(row.server_time)
      if (!this.inWindow(at, row.kind)) continue
      const code = KIND_TO_REASON.get(row.kind)
      if (code === undefined) continue
      const homes = lineageHomes.get(row.content_lineage_id) as Set<string>
      if (row.project_id !== null && homes.has(row.project_id)) continue
      for (const [questionId, question] of this.questions) {
        if (question.content_lineage_id !== row.content_lineage_id) continue
        this.add(questionId, {
          code: 'lineage_seen_in_other_project',
          at,
          evidence_id: row.id,
          evidence_type: 'exposure_event',
          exposure_kind: row.kind,
          project_id: row.project_id,
          session_item_id: row.session_item_id,
          cross_project: true,
        })
        if (ABSOLUTE_REASON_CODES.has(code)) {
          // A declaration or a proofreading preview is a property of the content,
          // so it stays absolute across the lineage too.
          this.add(questionId, {
            code,
            at,
            evidence_id: row.id,
            evidence_type: 'exposure_event',
            exposure_kind: row.kind,
            project_id: row.project_id,
            session_item_id: row.session_item_id,
            cross_project: true,
          })
        }
      }
    }

    for (const item of this.items) {
      if (item.content_lineage_id === null || !lineageHomes.has(item.content_lineage_id)) continue
      if (item.has_attempt) continue
      if (this.excludedItems.has(item.id)) continue
      const at = parseInstant(item.first_delivered_at)
      if (this.before !== null && !(at < this.before)) continue
      const homes = lineageHomes.get(item.content_lineage_id) as Set<string>
      if (homes.has(item.session_project_id)) continue
      for (const [questionId, question] of this.questions) {
        if (question.content_lineage_id !== item.content_lineage_id) continue
        this.add(questionId, {
          code: 'lineage_seen_in_other_project',
          at,
          evidence_id: item.id,
          evidence_type: 'session_item',
          exposure_kind: null,
          project_id: item.session_project_id,
          session_item_id: item.id,
          cross_project: true,
        })
      }
    }
  }

  /** Step 4: C03 merged families — a member is seen if any member was seen. */
  private mergedFamilyFacts(): void {
    const familyMap = mergedFamilyScope(
      new Map(this.query.question_ids.flatMap((id) => {
        const question = this.questions.get(id)
        return question ? [[id, question] as [string, QuestionFact]] : []
      })),
      this.families,
    )
    for (const questionId of this.query.question_ids) {
      const memberIds = familyMap.get(questionId)
      if (memberIds === undefined) continue
      let best: ContaminationFact | null = null
      for (const memberId of memberIds) {
        if (memberId === questionId) continue
        for (const fact of this.facts.get(memberId) ?? []) {
          if (fact.code === 'family_variant_seen') continue
          if (best === null || earlier(fact, best)) best = fact
        }
      }
      if (best === null) continue
      this.facts.get(questionId)?.push({
        code: 'family_variant_seen',
        at: best.at,
        evidence_id: best.evidence_id,
        evidence_type: 'family_member',
        exposure_kind: best.exposure_kind,
        question_id: best.question_id,
        project_id: best.project_id,
        session_item_id: best.session_item_id,
        cross_project: false,
      })
    }
  }

  evaluate(): Map<string, ContaminationFact[]> {
    if (this.questions.size === 0) {
      return new Map(this.query.question_ids.map((id) => [id, []]))
    }
    // C03: merged-family siblings are evaluated alongside the requested
    // questions (their facts prove the family was already seen), but the result
    // still holds the requested ids only.
    const familyMap = mergedFamilyScope(this.questions, this.families)
    const siblingIds = new Set<string>()
    for (const memberIds of familyMap.values()) {
      for (const memberId of memberIds) {
        if (!this.questions.has(memberId)) siblingIds.add(memberId)
      }
    }
    if (siblingIds.size > 0) {
      const byId = new Map(this.data.questions.map((question) => [question.id, question]))
      for (const siblingId of [...siblingIds].sort()) {
        const sibling = byId.get(siblingId)
        if (sibling) this.questions.set(siblingId, sibling)
        if (!this.facts.has(siblingId)) this.facts.set(siblingId, [])
      }
    }

    this.directFacts()
    this.lineageFacts()
    this.mergedFamilyFacts()

    const out = new Map<string, ContaminationFact[]>()
    for (const questionId of this.query.question_ids) out.set(questionId, this.facts.get(questionId) ?? [])
    return out
  }
}

/** Per-question contamination facts, narrowed by the optional window. */
export function evaluateExposure(
  facts: ExposureFacts,
  query: ExposureQuery,
): Map<string, ContaminationFact[]> {
  return new Evaluator(facts, query).evaluate()
}

/**
 * Per question id: has this question been exposed, and why it is no longer unseen.
 *
 * `before` and `exclude_session_item_ids` never add reasons; they only limit the
 * delivery-caused ones to what had happened before the item under judgement was
 * presented. Absolute reasons ignore the window.
 */
export function exposureState(facts: ExposureFacts, query: ExposureQuery): Map<string, ExposureState> {
  const evaluated = evaluateExposure(facts, query)
  const out = new Map<string, ExposureState>()
  for (const [questionId, questionFacts] of evaluated) {
    const { rows, chosen } = reasonRows(questionFacts)
    const instants = chosen.filter((fact) => fact.at !== null).map((fact) => fact.at as Instant)
    out.set(questionId, {
      seen: rows.length > 0,
      reasons: rows.map((row) => row.code),
      first_seen_at: instants.length > 0 ? formatPythonIso(instants.reduce((a, b) => (b < a ? b : a))) : null,
      sources: [...new Set(chosen.map(sourceLabel))].sort(),
      strict_independent_eligible: rows.length === 0,
      exclusion_reasons: rows,
    })
  }
  return out
}

/** `question id -> [{"code", "message", "evidence"}, ...]` (same rules). */
export function exclusionReasons(facts: ExposureFacts, query: ExposureQuery): Map<string, ReasonRow[]> {
  const states = exposureState(facts, query)
  const out = new Map<string, ReasonRow[]>()
  for (const [questionId, state] of states) out.set(questionId, state.exclusion_reasons)
  return out
}

/** The instant an attempt's contamination is judged at: presentation, else submission. */
export function attemptReferenceInstant(item: { first_delivered_at: string | null }, submittedAt: string): string {
  return item.first_delivered_at ?? submittedAt
}

/** The question-level state of one attempt, as of its own presentation. */
export function attemptExposureState(
  facts: ExposureFacts,
  attempt: {
    question_id: string
    project_id: string | null
    first_delivered_at: string | null
    submitted_at: string
    session_item_id: string
  },
): ExposureState {
  const states = exposureState(facts, {
    question_ids: [attempt.question_id],
    project_id: attempt.project_id,
    before: attemptReferenceInstant({ first_delivered_at: attempt.first_delivered_at }, attempt.submitted_at),
    exclude_session_item_ids: [attempt.session_item_id],
  })
  return states.get(attempt.question_id) as ExposureState
}

/** The precise reasons one attempt cannot be strictly independent. */
export function attemptExclusionReasons(
  facts: ExposureFacts,
  attempt: Parameters<typeof attemptExposureState>[1],
): ReasonRow[] {
  return attemptExposureState(facts, attempt).exclusion_reasons
}
