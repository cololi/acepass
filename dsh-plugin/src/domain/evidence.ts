/**
 * Evidence projection — port of `backend/apps/learning/services/evidence.py`.
 *
 * What one confirmed attempt proves, dimension by dimension. Kept pure: the caller resolves the
 * storage-shaped questions (which exposures happened before this submission, what the contamination
 * service says, whether another question on the same template already counts, what the delay anchor
 * is) and hands them in; this module only applies the rules. `domain/` never touches DSH, the clock
 * or storage — that is what makes the golden-vector comparison possible.
 *
 * Parity notes that are easy to "fix" wrongly:
 * - `repeat_practice` always qualifies, even when the answer was seen. It is the raw-submission
 *   dimension; the strict ones are the ones that exclude.
 * - Pending is not wrong: a pending grade produces `is_correct = false` but never a confirmed zero,
 *   and `graded` (every part decided) is computed separately from `correct` (full marks).
 * - The delayed interval is judged at the instant the item was *first presented*, not the
 *   submission, so leaving a tab open cannot earn the credit (C03/B04).
 */
import { Decimal } from './decimal.ts'
import { type Instant, formatPythonIso } from './instant.ts'
import { pyFormatFixed } from './pyfmt.ts'

/** The rule set that decided a row; bumped when the "strictly unseen" rules change (C04). */
export const RULE_VERSION = 'p2-c04'

export const DIMENSION = {
  REPEAT_PRACTICE: 'repeat_practice',
  UNASSISTED_COMPLETION: 'unassisted_completion',
  INDEPENDENT_CORRECT: 'independent_correct',
  TEMPLATE_VARIANT: 'template_variant',
  UNSEEN_VARIANT: 'unseen_variant',
  DELAYED_VERIFICATION: 'delayed_verification',
} as const

export type Dimension = (typeof DIMENSION)[keyof typeof DIMENSION]

/** Every dimension an attempt produces, in the order the Python implementation writes them. */
export const ALL_DIMENSIONS: readonly Dimension[] = [
  DIMENSION.REPEAT_PRACTICE,
  DIMENSION.UNASSISTED_COMPLETION,
  DIMENSION.INDEPENDENT_CORRECT,
  DIMENSION.TEMPLATE_VARIANT,
  DIMENSION.UNSEEN_VARIANT,
  DIMENSION.DELAYED_VERIFICATION,
]

const SESSION_MODE_VERIFICATION = 'verification'
const SESSION_STATUS_ACTIVE = 'active'
const GRADE_STATUS_CONFIRMED = 'confirmed'
const GRADE_STATUS_PENDING_REVIEW = 'pending_review'
const GRADE_METHOD_SELF_CONFIRMED = 'self_confirmed'
const GRADE_METHOD_AI_ESTIMATED = 'ai_estimated'

export interface GradeFacts {
  status: string
  isFullyConfirmed: boolean
  confirmedScore: Decimal | null
  maxScore: Decimal | null
  graderIsSelf: boolean
  method: string
}

export interface SessionFacts {
  mode: string
  status: string
}

/** One knowledge node the question maps to, with the template it was mapped through. */
export interface MappingFacts {
  nodeId: string
  nodeName: string
  templateId: string | null
  mappingRevision: string
}

/** What the exposure log says happened before this submission. */
export interface ExposureFacts {
  /** `kind` of every answer-revealing exposure before submission (duplicates and order irrelevant). */
  answerRevealingKinds: string[]
  /** Whether any hint/answer/explanation exposure predates the submission. */
  hintBeforeSubmit: boolean
}

export interface ContaminationReason {
  code: string
  message: string
}

/** The most recent completed related learning event, as resolved by `anchors.py`. */
export interface AnchorFacts {
  at: Instant | null
  source: string
}

export interface AttemptFacts {
  /** `attempt.elapsed_ms`; zero means no trustworthy timing record. */
  elapsedMs: number
  /** `session_item.first_delivered_at`, i.e. the first presentation of this item. */
  firstDeliveredAt: Instant | null
  /** `attempt.submitted_at`, used as the delay instant only when the item was never presented. */
  submittedAt: Instant
  /** `session_item.answer_key_version.is_usable`. */
  answerKeyUsable: boolean
  session: SessionFacts
  /** `session_item.purpose`. */
  purpose: string
  grade: GradeFacts | null
  mappings: MappingFacts[]
  assistance: ExposureFacts
  contamination: ContaminationReason[]
  /** Whether another question on the same template already has a qualifying independent row. */
  sameTemplateOtherQuestion: boolean
  familyId: string | null
  familyRelationConfirmed: boolean
  familyHasOtherQuestions: boolean
  /**
   * The delay anchor. `anchorFor` wins when present: Python resolves the anchor **per knowledge
   * node** (`_last_relevant_anchor(attempt, node_id, ...)`), and a question mapped to two nodes can
   * legitimately have a different anchor for each. `anchor` is the single-node shorthand the golden
   * vectors use.
   */
  anchor: AnchorFacts | null
  anchorFor?: (nodeId: string) => AnchorFacts | null
  /** `settings.DELAYED_VERIFICATION_HOURS`. */
  delayHours: number
}

export interface EvidenceRow {
  dimension: Dimension
  nodeId: string
  qualifies: boolean
  isCorrect: boolean
  scoreFraction: Decimal | null
  exclusionReasons: string[]
  detail: Record<string, unknown>
}

/** The instant the delayed interval is judged at, plus why that instant was chosen. */
export function delayEvaluationInstant(facts: {
  firstDeliveredAt: Instant | null
  submittedAt: Instant
}): { at: Instant; source: 'first_presentation' | 'submission' } {
  if (facts.firstDeliveredAt !== null) return { at: facts.firstDeliveredAt, source: 'first_presentation' }
  return { at: facts.submittedAt, source: 'submission' }
}

/**
 * Any answer-revealing exposure for this question before this submission.
 *
 * A hint alone does not make `assistance` true, but it does block `unassisted_completion`, which is
 * why the two facts are reported separately.
 */
export function preSubmitAssistance(exposure: ExposureFacts): { assistance: boolean; reasons: string[] } {
  const reasons: string[] = []
  const assistance = exposure.answerRevealingKinds.length > 0
  if (assistance) {
    const kinds = [...new Set(exposure.answerRevealingKinds)].sort()
    reasons.push('提交前已获得辅助暴露：' + kinds.join(', '))
  }
  if (exposure.hintBeforeSubmit && !assistance) reasons.push('提交前获得过提示')
  return { assistance, reasons }
}

/** A verification item only counts once that verification run is finished. */
export function confirmationOk(session: SessionFacts): boolean {
  if (session.mode === SESSION_MODE_VERIFICATION && session.status === SESSION_STATUS_ACTIVE) return false
  return true
}

/** Fully confirmed *and* at full marks — the only reading of "完全正确". */
export function isGradeCorrect(grade: GradeFacts | null): boolean {
  if (grade === null || !grade.isFullyConfirmed || grade.confirmedScore === null) return false
  if (grade.maxScore === null || grade.maxScore.isZero() || grade.maxScore.lt(Decimal.zero())) return false
  return grade.confirmedScore.ge(grade.maxScore)
}

/** `confirmed_score / max_score` quantised to four decimals, or null when it cannot be stated. */
export function fraction(grade: GradeFacts | null): Decimal | null {
  if (grade === null || grade.confirmedScore === null || grade.maxScore === null || grade.maxScore.isZero()) {
    return null
  }
  return grade.confirmedScore.div(grade.maxScore).quantize(-4)
}

/**
 * Same family + a different stable question = near duplicate, so it is not an unseen variant.
 *
 * The `familyId !== null` half is redundant in practice (a non-null family implies a non-null
 * family id) but it is part of the Python expression, so it is reproduced rather than dropped.
 */
export function isNearDuplicate(facts: {
  familyId: string | null
  familyHasOtherQuestions: boolean
}): boolean {
  if (facts.familyId === null) return false
  return facts.familyHasOtherQuestions || facts.familyId !== null
}

const HOURS_PER_MICROSECOND = 3_600_000_000n

function hoursToMicroseconds(hours: number): bigint {
  const scaled = BigInt(Math.trunc(hours)) * HOURS_PER_MICROSECOND
  return scaled
}

/** All evidence rows (one per dimension × knowledge node) for one attempt. */
export function computeDimensions(facts: AttemptFacts): EvidenceRow[] {
  const rows: EvidenceRow[] = []
  const { assistance, reasons: assistanceReasons } = preSubmitAssistance(facts.assistance)
  const seenReasons = facts.contamination.map((row) => row.message)

  const trustedQuestion = facts.answerKeyUsable
  const grade = facts.grade
  // `graded` = every scoring part has been decided; `correct` = it also reached full marks. A wrong
  // answer is fully graded and still not correct, so the two facts are never conflated.
  const graded = grade !== null && grade.status === GRADE_STATUS_CONFIRMED && grade.isFullyConfirmed
  const correct = isGradeCorrect(grade)
  const selfGraded = grade !== null && (grade.graderIsSelf || grade.method === GRADE_METHOD_SELF_CONFIRMED)
  const estimatedOnly = grade !== null && grade.method === GRADE_METHOD_AI_ESTIMATED
  const pending = grade === null || grade.status === GRADE_STATUS_PENDING_REVIEW
  const timingOk = facts.elapsedMs > 0
  const verificationMode = facts.session.mode === SESSION_MODE_VERIFICATION

  const baseReasons: string[] = []
  if (!trustedQuestion) baseReasons.push('本题缺少已核对且无争议的答案')
  if (pending) baseReasons.push('判分尚未完全确认')
  if (estimatedOnly) baseReasons.push('仅有 AI 估计分，不作为正式分数')
  if (selfGraded) baseReasons.push('本次评分为自评确认，只产生自评证据')
  if (!timingOk) baseReasons.push('缺少可信用时记录')
  if (graded && !correct) baseReasons.push('判分已完成但未达到满分，不能作为严格独立正确证据')

  const evaluated = delayEvaluationInstant(facts)
  const delayUs = hoursToMicroseconds(facts.delayHours)
  const nearDuplicate = isNearDuplicate(facts)

  for (const mapping of facts.mappings) {
    rows.push({
      dimension: DIMENSION.REPEAT_PRACTICE,
      nodeId: mapping.nodeId,
      qualifies: true,
      isCorrect: correct,
      scoreFraction: fraction(grade),
      exclusionReasons: [],
      detail: { note: '原始提交存在即计入重复练习，即使看过答案也单列' },
    })

    const unassistedReasons = [...assistanceReasons]
    let unassisted = !assistance && unassistedReasons.length === 0
    if (!timingOk) {
      unassisted = false
      unassistedReasons.push('缺少可信用时记录')
    }
    rows.push({
      dimension: DIMENSION.UNASSISTED_COMPLETION,
      nodeId: mapping.nodeId,
      qualifies: unassisted,
      isCorrect: correct,
      scoreFraction: fraction(grade),
      exclusionReasons: unassistedReasons,
      detail: { note: '本次作答期间无辅助，不代表此前从未见过本题' },
    })

    const independentReasons = [...baseReasons, ...assistanceReasons, ...seenReasons]
    if (!confirmationOk(facts.session)) independentReasons.push('本次作答不足以作为独立能力证据（会话用途）')
    const independent =
      trustedQuestion &&
      graded &&
      correct &&
      !assistance &&
      seenReasons.length === 0 &&
      !selfGraded &&
      !estimatedOnly &&
      timingOk &&
      confirmationOk(facts.session)
    rows.push({
      dimension: DIMENSION.INDEPENDENT_CORRECT,
      nodeId: mapping.nodeId,
      qualifies: independent,
      isCorrect: correct,
      scoreFraction: fraction(grade),
      exclusionReasons: independent ? [] : independentReasons,
      detail: { template_id: mapping.templateId, verification_mode: verificationMode },
    })

    // Python only consults the evidence table when this mapping has a template; without one the
    // fact stays False even if another question on the same (absent) template somehow qualified.
    const sameTemplateOther = mapping.templateId === null ? false : facts.sameTemplateOtherQuestion
    const templateVariant = independent && sameTemplateOther
    const templateReasons = templateVariant
      ? []
      : !independent
        ? independentReasons
        : [mapping.templateId === null ? '尚未在其他题目上以同一模板独立正确' : '尚无同模板的其他独立正确记录']
    rows.push({
      dimension: DIMENSION.TEMPLATE_VARIANT,
      nodeId: mapping.nodeId,
      qualifies: templateVariant,
      isCorrect: correct,
      scoreFraction: fraction(grade),
      exclusionReasons: templateReasons,
      detail: { template_id: mapping.templateId },
    })

    const unseenReasons: string[] = []
    if (!independent) unseenReasons.push(...independentReasons)
    if (nearDuplicate) unseenReasons.push('本题目属于已知近重复家族，不能当作陌生变式')
    const unseen = independent && !nearDuplicate
    rows.push({
      dimension: DIMENSION.UNSEEN_VARIANT,
      nodeId: mapping.nodeId,
      qualifies: unseen,
      isCorrect: correct,
      scoreFraction: fraction(grade),
      exclusionReasons: unseen ? [] : unseenReasons,
      detail: {
        family_id: facts.familyId,
        family_confirmed: facts.familyId === null ? false : facts.familyRelationConfirmed,
        template_id: mapping.templateId,
      },
    })

    // Per-node when the caller can resolve it, else the single-anchor shorthand.
    const anchorFacts = facts.anchorFor === undefined ? facts.anchor : facts.anchorFor(mapping.nodeId)
    const anchor = anchorFacts === null ? null : anchorFacts.at
    const anchorSource = anchorFacts === null ? 'none' : anchorFacts.source
    const delayedReasons: string[] = []
    if (anchor === null) {
      delayedReasons.push('没有可用的延迟锚点（本题是该考点首次接触）')
    } else {
      // Measured from the completion of the most recent related training event to the moment the
      // verification *started*: the exposure of the question is not training, so it cannot start
      // the clock (B04), and the submission cannot extend it, so a late submit cannot earn the
      // credit (C03).
      const elapsed = evaluated.at - anchor
      if (elapsed < delayUs) {
        const elapsedHours = Number(elapsed) / 1_000_000 / 3600
        delayedReasons.push(
          `距最近相关训练/教学仅 ${pyFormatFixed(elapsedHours, 2)} 小时，未达到 ${facts.delayHours} 小时`,
        )
      }
    }
    if (!independent) {
      delayedReasons.push('本次作答不是严格独立正确，不能作为延迟验证证据')
      // ... and, when the reason is contamination, name it precisely (C04): "not independent"
      // alone would hide that the question was proofread, declared as seen outside, presented
      // without a submission, or seen in another project.
      for (const reason of seenReasons) {
        if (!delayedReasons.includes(reason)) delayedReasons.push(reason)
      }
    }
    const delayed = independent && anchor !== null && delayedReasons.length === 0
    rows.push({
      dimension: DIMENSION.DELAYED_VERIFICATION,
      nodeId: mapping.nodeId,
      qualifies: delayed,
      isCorrect: correct,
      scoreFraction: fraction(grade),
      exclusionReasons: delayed ? [] : delayedReasons,
      detail: {
        delay_anchor_at: anchor === null ? null : formatPythonIso(anchor),
        anchor_source: anchorSource,
        delay_hours_required: facts.delayHours,
        purpose: facts.purpose,
        // Auditability: which instant the interval was judged at, so a row can be explained
        // without re-deriving the rule.
        delay_evaluated_at: formatPythonIso(evaluated.at),
        delay_evaluated_from: evaluated.source,
      },
    })
  }
  return rows
}
