/**
 * Why a question can no longer be called "strictly unseen" — the C04 read path and its writer.
 *
 * Port of `backend/apps/practice/api.py` (`get_question_exposure` / `declare_external_seen`) plus
 * `apps/learning/services/contamination.py::exposure_state` / `record_external_seen`.
 *
 * The decision itself is **not** re-implemented here: `domain/contamination.ts` already owns it (and
 * is golden-tested against the Python module). This module only loads the real ledger rows
 * (`evidence_rebuild.loadExposureFacts`), asks the resolver, and appends the one row Django appends.
 *
 * Two properties are the point:
 *
 *  - the ledger is **append-only**. `seen=false` is stored as a correction row (kept, with its note)
 *    and `seen=true` stores the declaration — neither resets the decision. Once a question has ever
 *    been declared seen it can never produce strict-independent evidence again (C04: no path back to
 *    "strictly unseen").
 *  - nothing was delivered by the server here, so the row carries `reveals_answer=false` and
 *    `purpose="report"`: the learner is reporting an out-of-system fact, and the decision does not
 *    depend on `reveals_answer`.
 */
import type { DatabaseSync } from 'node:sqlite'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import { exposureState, type ExposureState } from '../domain/contamination.ts'
import { findOne, findRows, insertRow } from '../store/repository.ts'
import { loadExposureFacts } from './evidence_rebuild.ts'
import { ScopeViolation } from './errors.ts'
import { requireProject } from './exams.ts'

/** `contamination.EXTERNAL_SEEN_SOURCE` — the ledger names the real entry point. */
export const EXTERNAL_SEEN_SOURCE = 'question_external_seen_declaration'

/** `_question_scope`: owner-scoped question inside this project; a foreign id is a 404. */
function questionScope(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
): Record<string, unknown> {
  const project = requireProject(db, userId, projectId)
  const question = findOne(db, 'question_bank_question', { id: questionId })
  const subject = question === null ? null : findOne(db, 'exams_subject', { id: String(question.subject_id) })
  if (
    question === null ||
    subject === null ||
    String(subject.project_id) !== String(project.id) ||
    String(project.owner_id ?? userId) !== String(userId)
  ) {
    throw new ScopeViolation('题目不存在或不属于该项目')
  }
  return question
}

function stateOf(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
): ExposureState {
  const facts = loadExposureFacts(db, userId)
  const states = exposureState(facts, {
    question_ids: [questionId],
    project_id: projectId,
  })
  const state = states.get(questionId)
  if (state === undefined) {
    // The resolver returns an entry for every requested id; a missing one would be a programming
    // error, but reporting "not seen" would be a lie, so it is surfaced as such.
    throw new Error(`contamination resolver returned no state for ${questionId}`)
  }
  return state
}

function payload(questionId: string, state: ExposureState): Record<string, unknown> {
  return {
    question_id: questionId,
    seen: state.seen,
    reasons: state.reasons,
    first_seen_at: state.first_seen_at,
    sources: state.sources,
    strict_independent_eligible: state.strict_independent_eligible,
    exclusion_reasons: state.exclusion_reasons.map((row) => ({
      code: row.code,
      message: row.message,
      evidence: row.evidence,
    })),
  }
}

/**
 * `GET /projects/{id}/questions/{question_id}/exposure` — read-only.
 *
 * `strict_independent_eligible` is false once the question has been delivered, proofread, declared as
 * seen outside or exposed in another project — and there is no reset path. The rows explain which
 * ledger entry proves each reason, so the UI can answer "为什么这题不算严格独立".
 */
export function getQuestionExposure(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
): Record<string, unknown> {
  const question = questionScope(db, userId, projectId, questionId)
  return payload(String(question.id), stateOf(db, userId, projectId, String(question.id)))
}

/** `_published_version`: the current published version, else the newest one. */
function publishedVersionId(db: DatabaseSync, questionId: string): string | null {
  const versions = findRows(db, 'question_bank_question_version', { question_id: questionId }).sort(
    (a, b) => Number(b.version) - Number(a.version),
  )
  const published = versions.find((version) => version.status === 'published') ?? versions[0]
  return published === undefined ? null : String(published.id)
}

/**
 * `POST /projects/{id}/questions/{question_id}/external-seen` — the learner's own declaration.
 *
 * A repeat with the same Idempotency-Key reuses the same row (the HTTP layer records the replay);
 * a fresh key appends a new declaration, which keeps the correction history honest.
 */
export function recordExternalSeen(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  questionId: string,
  input: { seen?: unknown; note?: unknown },
  now: Instant,
): { eventId: string; result: Record<string, unknown> } {
  const question = questionScope(db, userId, projectId, questionId)
  const note = pyCodePointSlice(String(input.note ?? ''), 0, 300)
  const event = insertRow(
    db,
    'practice_exposure_event',
    {
      user_id: userId,
      project_id: projectId,
      question_id: String(question.id),
      question_version_id: publishedVersionId(db, String(question.id)),
      family_id:
        question.family_id === null || question.family_id === undefined ? null : String(question.family_id),
      content_lineage_id:
        question.content_lineage_id === null || question.content_lineage_id === undefined
          ? null
          : String(question.content_lineage_id),
      session_item_id: null,
      kind: 'external_seen',
      purpose: 'report',
      source: EXTERNAL_SEEN_SOURCE,
      server_time: now,
      reveals_answer: false,
      detail: {
        seen: input.seen === undefined ? true : Boolean(input.seen),
        note,
        declared_at: formatPythonIso(now),
        declared_by: String(userId),
      },
    },
    { now },
  )
  const state = stateOf(db, userId, projectId, String(question.id))
  return { eventId: String(event.id), result: payload(String(question.id), state) }
}
