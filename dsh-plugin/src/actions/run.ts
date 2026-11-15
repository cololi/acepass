/**
 * The `acepass` tool's actions, with no DSH dependency.
 *
 * Kept apart from `tools/acepass.ts` (which is Cordis glue) so the behaviour can be unit-tested
 * without loading the SDK, and so the invariant "AI never writes a formal fact" is asserted where
 * the decision is actually made.
 */
import { newCard, schedule, RATINGS, FSRS_VERSION, type CardState } from '../domain/fsrs.ts'
import { parseInstant, formatInstant } from '../domain/instant.ts'
import { CAPABILITIES, type LlmPort } from '../llm/contract.ts'
import {
  EXPLAIN_PROMPT_VERSION,
  buildExplainPrompt,
  parseModelJson,
  validateExplainPayload,
  validationDisposition,
} from '../ai/index.ts'

export type Json = Record<string, unknown>

const toJsonState = (s: CardState): Json => ({
  stability: s.stability, difficulty: s.difficulty, phase: s.phase, reps: s.reps, lapses: s.lapses,
  learning_step: s.learningStep, last_reviewed_at: s.lastReviewedAt === null ? null : formatInstant(s.lastReviewedAt),
  due_at: s.dueAt === null ? null : formatInstant(s.dueAt), scheduled_days: s.scheduledDays, elapsed_days: s.elapsedDays,
})
const fromJsonState = (j: Json): CardState => ({
  ...newCard(), stability: Number(j.stability ?? 0), difficulty: Number(j.difficulty ?? 0),
  phase: (j.phase as CardState['phase']) ?? 'new', reps: Number(j.reps ?? 0), lapses: Number(j.lapses ?? 0),
  learningStep: Number(j.learning_step ?? 0),
  lastReviewedAt: j.last_reviewed_at ? parseInstant(String(j.last_reviewed_at)) : null,
  dueAt: j.due_at ? parseInstant(String(j.due_at)) : null,
  scheduledDays: Number(j.scheduled_days ?? 0), elapsedDays: Number(j.elapsed_days ?? 0),
})

/** Actions are added here as capabilities migrate; each must keep its Django-side invariants. */
export const ACTIONS = ['capabilities', 'fsrs_schedule', 'ai_explain'] as const

export async function runAction(
  action: string,
  payload: Json,
  deps: { llm: () => LlmPort },
  signal?: AbortSignal,
): Promise<Json> {
  switch (action) {
    case 'capabilities':
      return { ok: true, capabilities: await deps.llm().availability(signal), known: CAPABILITIES }

    case 'fsrs_schedule': {
      const rating = String(payload.rating ?? '')
      if (!(RATINGS as readonly string[]).includes(rating))
        return { ok: false, error: { code: 'bad_rating', message: `rating must be one of ${RATINGS.join(', ')}` } }
      if (!payload.reviewed_at) return { ok: false, error: { code: 'reviewed_at_required', message: 'the scheduler never invents "now"' } }
      const result = schedule(
        payload.state ? fromJsonState(payload.state as Json) : newCard(), rating, parseInstant(String(payload.reviewed_at)),
      )
      return {
        ok: true, scheduler_version: FSRS_VERSION, retrievability: result.retrievability, interval_days: result.intervalDays,
        elapsed_days: result.elapsedDays, phase_after: result.phaseAfter, is_lapse: result.isLapse, state: toJsonState(result.state),
      }
    }

    case 'ai_explain': {
      // The full path the invariant is about: prompt -> model -> parse -> validate -> disposition.
      // Nothing here writes: the caller decides what to do with the disposition, and a score or a
      // mastery state is never among the writable targets for a job result.
      const options = Array.isArray(payload.options) ? payload.options : []
      const allowed = Array.isArray(payload.allowed_citation_ids) ? payload.allowed_citation_ids : []
      const prompt = buildExplainPrompt({
        question_type: payload.question_type,
        stem_text: payload.stem_text,
        options: options as never,
        answer_summary: payload.answer_summary,
        explanation_blocks: payload.explanation_blocks,
        allowed_citation_ids: allowed,
        attempt_summary: payload.attempt_summary,
        user_question: payload.user_question,
        knowledge_nodes: Array.isArray(payload.knowledge_nodes) ? payload.knowledge_nodes : null,
        rubric_criteria: Array.isArray(payload.rubric_criteria) ? (payload.rubric_criteria as never) : null,
        material_text: payload.material_text,
        blanks: Array.isArray(payload.blanks) ? (payload.blanks as never) : null,
      })
      const result = await deps.llm().run({
        capability: 'explain',
        promptVersion: EXPLAIN_PROMPT_VERSION,
        // The Python builder returns one user message that already contains its instructions, so
        // splitting it into system + prompt would change the model input.
        system: '',
        prompt,
        signal,
      })
      if (!result.ok) {
        return {
          ok: false,
          error: { code: result.code, message: result.message, retryable: result.retryable },
          prompt_version: EXPLAIN_PROMPT_VERSION,
        }
      }
      let parsed: unknown
      try {
        parsed = parseModelJson(result.text)
      } catch (error) {
        return {
          ok: false,
          error: { code: 'ai_invalid_output', message: `model output is not valid JSON: ${(error as Error).message}` },
          prompt_version: EXPLAIN_PROMPT_VERSION,
          disposition: validationDisposition('explain', null, [{ code: 'not_json', message: '模型输出不是合法 JSON' }]),
        }
      }
      const [clean, problems] = validateExplainPayload(parsed, {
        allowed_citation_ids: new Set(allowed.map((value) => String(value))),
      })
      return {
        ok: true,
        prompt_version: EXPLAIN_PROMPT_VERSION,
        disposition: validationDisposition('explain', clean, problems),
        problems,
        explanation: clean,
        usage: result.usage ?? null,
        route: result.route,
      }
    }

    default:
      return { ok: false, error: { code: 'unknown_action', message: `unknown action ${JSON.stringify(action)}`, known: ACTIONS } }
  }
}
