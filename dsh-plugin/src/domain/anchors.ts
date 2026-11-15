/**
 * The one authoritative rule for "when did the latest related training happen".
 *
 * Port of `backend/apps/learning/services/anchors.py`. Three places used to answer
 * this question differently (B04), so the rule is defined once and every caller
 * uses it:
 *
 *   the anchor is the most recent moment a related learning event *completed*
 *   (an attempt was submitted, an explanation/answer was delivered, a tutoring
 *   job was delivered) at or before the requested instant.
 *
 * Presenting a question is not training, so it can never start the clock, and a
 * submission that arrives late cannot extend it (C03).
 *
 * Pure: the caller hands over the candidate events it already loaded.
 */
import { type Instant, formatPythonIso, parseInstant } from './instant.ts'

/** One completed learning event, with the project it belongs to and its nodes. */
export interface AnchorEvent {
  /** Attempts only: used by `exclude_attempt_id`. */
  id?: string
  project_id: string
  at: string
  node_ids: string[]
}

export interface AnchorFacts {
  /** Prior submissions (`Attempt.submitted_at`). */
  attempts: AnchorEvent[]
  /** Answer-revealing deliveries (`ExposureEvent` with `reveals_answer=True`). */
  teaching_exposures: AnchorEvent[]
  /** Delivered tutoring jobs (`TutorJob.delivered_at` with `status="succeeded"`). */
  tutoring: AnchorEvent[]
}

export interface AnchorQuery {
  /** The project to scope to; attempts/exposures/tutoring are all per project. */
  project_id: string
  node_id: string
  /** Nothing at or after this instant counts. */
  before: string | null
  exclude_attempt_id?: string | null
}

export interface AnchorResult {
  anchor: string | null
  source: string
}

/**
 * `(anchor, source)` for the latest completed related learning event.
 *
 * Returns `(null, "")` when the learner has no related event at or before
 * `before` — a delayed check with no anchor is not a delayed check, and callers
 * must say so instead of inventing "now" as the anchor.
 */
export function latestLearningAnchor(facts: AnchorFacts, query: AnchorQuery): AnchorResult {
  if (!query.node_id || query.before === null) return { anchor: null, source: '' }
  const before = parseInstant(query.before)
  const excluded = query.exclude_attempt_id ?? null

  let latest: Instant | null = null
  let source = ''

  const consider = (at: Instant | null, candidateSource: string): void => {
    if (at === null) return
    if (latest === null || at > latest) {
      latest = at
      source = candidateSource
    }
  }

  const newest = (events: readonly AnchorEvent[]): AnchorEvent | null => {
    let best: AnchorEvent | null = null
    for (const event of events) {
      if (event.project_id !== query.project_id) continue
      if (!event.node_ids.includes(query.node_id)) continue
      const at = parseInstant(event.at)
      if (at > before) continue
      if (best === null || at > parseInstant(best.at)) best = event
    }
    return best
  }

  // Python considers the sources in this order, and `>` keeps the first one on a
  // tie: prior attempt, then teaching exposure, then tutoring.
  const attempt = newest(
    facts.attempts.filter((row) => excluded === null || row.id !== excluded),
  )
  consider(attempt === null ? null : parseInstant(attempt.at), 'prior_attempt')

  const teaching = newest(facts.teaching_exposures)
  consider(teaching === null ? null : parseInstant(teaching.at), 'teaching_exposure')

  const tutoring = newest(facts.tutoring)
  consider(tutoring === null ? null : parseInstant(tutoring.at), 'tutoring')

  return { anchor: latest === null ? null : formatPythonIso(latest), source }
}
