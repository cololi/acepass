/**
 * What an AI result is allowed to become.
 *
 * This is the executable form of the gate in docs/03 §5 and R-INV-03: AI output may create audit
 * rows and *candidates* (import drafts, tag proposals, transcription proposals, estimated grade
 * events, diagnosis candidates, blocked variant candidates). It may never write a formal score, a
 * confirmed grade pointer, a knowledge/mastery state, a study plan or a statistic.
 *
 * The per-capability decisions below are read off the seven call sites, not guessed:
 *  - explain/extract reject the run when the validator reports any problem;
 *  - suggest_tags/transcription/diagnosis keep the cleaned candidate even with problems (Python sets
 *    `SUCCEEDED` and records `problems` in `validation_result`);
 *  - estimate rejects only when nothing usable survived (`clean.criteria` empty), otherwise the
 *    estimate is stored as an inert `estimated` event;
 *  - variants store a *blocked* candidate when any blocking problem exists.
 *
 * Those six decisions are not executable parity: driving them needs the Django DB, so they are
 * transcribed from the call sites and listed as such in the migration report. What *is* executable
 * here is the disposition itself, and it is pinned by tests.
 */
import { GradeMethod, GradeStatus } from '../domain/grading.ts'
import type { AuditCapability } from './audit.ts'
import type { ValidationProblem } from './validators.ts'

export type DispositionStatus = 'succeeded' | 'rejected'

/** Rows an AI path may append/update. Every one of them is audit or candidate material. */
export const AI_WRITE_TARGETS = [
  'llm_run',
  'coach_turn',
  'import_candidate',
  'tag_suggestion',
  'answer_transcription',
  'ai_estimate_event',
  'error_diagnosis',
  'diagnosis_follow_up',
  'tutor_job',
  'tutor_segment',
] as const
export type AiWriteTarget = (typeof AI_WRITE_TARGETS)[number]

/** Facts only a human/deterministic path may write. AI must never touch any of these. */
export const FORMAL_WRITE_TARGETS = [
  'attempt_current_grade_event',
  'grade_event_confirmed',
  'knowledge_state',
  'mastery_state',
  'study_plan',
  'statistics',
] as const

export function isAiWritableTarget(target: string): boolean {
  return (AI_WRITE_TARGETS as readonly string[]).includes(target)
}

/** Deny-by-default guard for a service layer that wants a runtime assertion, not just types. */
export function assertAiWritableTarget(target: string): void {
  if (!isAiWritableTarget(target)) {
    throw new Error(`AI 输出不得写入 ${target}：只允许候选与审计记录（R-INV-03）`)
  }
}

/**
 * An AI estimate is stored with `status=estimated, method=ai_estimated`. Those are the Django enums,
 * imported from the domain port so the strings cannot drift.
 */
export const AI_GRADE_EVENT = {
  status: GradeStatus.ESTIMATED,
  method: GradeMethod.AI_ESTIMATED,
} as const

/** `estimated` is not `confirmed`; only the human/deterministic path may set the latter. */
export function isConfirmedGradeStatus(status: string): boolean {
  return status === GradeStatus.CONFIRMED
}

/** Refuse to persist an estimate as a confirmed grade (the specific failure R-AI-07 prohibits). */
export function assertNotConfirmedGrade(status: string, method: string): void {
  if (isConfirmedGradeStatus(status) || method !== GradeMethod.AI_ESTIMATED) {
    throw new Error(`AI 估分只能以 estimated/ai_estimated 存储，拒绝 ${status}/${method}`)
  }
}

export interface ValidationDisposition {
  status: DispositionStatus
  /** Whether the cleaned candidate is stored (possibly marked blocked/failed for a human). */
  keepCandidate: boolean
  reason: string
  writes: readonly AiWriteTarget[]
}

const BASE_WRITES: Record<AuditCapability, readonly AiWriteTarget[]> = {
  memory_coach: ['llm_run', 'coach_turn'],
  extract_question: ['llm_run', 'import_candidate'],
  explain: ['llm_run', 'tutor_job', 'tutor_segment'],
  suggest_tags: ['llm_run', 'tag_suggestion'],
  transcribe_handwriting: ['llm_run', 'answer_transcription'],
  estimate_grade: ['llm_run', 'ai_estimate_event'],
  diagnose: ['llm_run', 'error_diagnosis', 'diagnosis_follow_up'],
  propose_variant: ['llm_run', 'import_candidate'],
}

function disposition(
  capability: AuditCapability,
  status: DispositionStatus,
  keepCandidate: boolean,
  reason: string,
): ValidationDisposition {
  const writes = status === 'succeeded' || keepCandidate
    ? BASE_WRITES[capability]
    : (['llm_run'] as const)
  return { status, keepCandidate, reason, writes }
}

const blockingProblems = (problems: readonly ValidationProblem[]): ValidationProblem[] =>
  problems.filter((problem) => (problem.severity ?? 'blocking') === 'blocking')

/**
 * Map `(clean, problems)` to what may be stored.
 *
 * Note the asymmetry: "has problems" is not one decision. A tag suggestion with an invented name
 * still succeeds (the invented name is dropped and reported); an explanation with problem codes is
 * rejected and never shown.
 */
export function validationDisposition(
  capability: AuditCapability,
  clean: unknown,
  problems: readonly ValidationProblem[],
): ValidationDisposition {
  switch (capability) {
    case 'extract_question':
      return problems.length > 0
        ? disposition(capability, 'rejected', true, 'validation_problems')
        : disposition(capability, 'succeeded', true, 'candidate_stored')
    case 'memory_coach':
      return problems.length > 0
        ? disposition(capability, 'rejected', false, 'validation_problems')
        : disposition(capability, 'succeeded', true, 'coach_turn_stored')
    case 'explain':
      return problems.length > 0
        ? disposition(capability, 'rejected', false, 'validation_problems')
        : disposition(capability, 'succeeded', true, 'segments_stored')
    case 'estimate_grade': {
      const criteria = (clean as { criteria?: unknown[] } | null)?.criteria ?? []
      return criteria.length === 0
        ? disposition(capability, 'rejected', false, 'no_usable_criteria')
        : disposition(capability, 'succeeded', true, 'estimated_event_stored')
    }
    case 'propose_variant':
      return blockingProblems(problems).length > 0
        ? disposition(capability, 'rejected', true, 'blocking_problems')
        : disposition(capability, 'succeeded', true, 'candidate_stored')
    case 'suggest_tags':
    case 'transcribe_handwriting':
    case 'diagnose':
      // Python stores the cleaned candidate and records the problems; it does not reject the run.
      return disposition(capability, 'succeeded', true, 'candidate_with_problems')
  }
}
