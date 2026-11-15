/**
 * Ingestion access helpers.
 *
 * Batch B1: the editorial-preview exposure writer.
 * Batch B3: the private-file download gate (O02) — `assetScope`, `sealedQuestionsForAsset`,
 * `assertAssetDownloadAllowed`, `recordDownloadExposure`.
 *
 * Port of `backend/apps/learning/services/contamination.py::record_editorial_preview` as called by
 * `apps/ingestion/api.py::_record_editorial_preview`, and of
 * `backend/apps/ingestion/services/access.py`.
 *
 * Opening or editing a re-import candidate that is already linked to a published question shows the
 * proofreader that question's answer. That is a real exposure (C04 source 1) and makes the question
 * permanently ineligible for *strictly independent* evidence, so it is written to the append-only
 * ledger — it is not a UI concern. Repeating the same open reuses the existing row.
 *
 * The download gate is the one place where "the bytes are the sealed content" is decided. The
 * relation walk below is deliberately explicit, because guessing a link (for example "any asset in
 * the same project") would either leak sealed pages or lock a learner out of their own attachment:
 *
 *   1. `SourceRegion.crop_asset` — a crop belongs to the regions that use it;
 *   2. `QuestionSourceLink.region` — which version's stem/answer was read from that region;
 *   3. `AnswerKeyVersion.source_region.crop_asset` — the crop an answer was read from;
 *   4. `SourceDocument.asset` — a whole-page scan inherits the sealing of every question drawn
 *      from its regions;
 *   5. an `image` block of a sealed question version that names the asset (stem/material image).
 *
 * An asset with no region, no link, no answer-key link and no block reference — a learner's own
 * attachment — is not related to any question, so no sealing decision applies to it.
 */
import type { DatabaseSync } from 'node:sqlite'

import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { findOne, findRows, getRow, insertRow, type Row } from '../store/repository.ts'
import { PurposeNotAllowed, ScopeViolation } from './errors.ts'
import { isSealed, reasonMessage, sealedQuestionIds } from './sealing.ts'

const KIND_EDITORIAL_PREVIEW = 'editorial_preview'
const KIND_ANSWER_DELIVERED = 'answer_delivered'
const EXPOSURE_PURPOSES = new Set(['practice', 'verification', 'editorial', 'preview'])

/** `_published_version(question, None)`: current pointer, else the newest version. */
function publishedVersion(db: DatabaseSync, question: Row): Row | null {
  const current = question.current_published_version_id
  if (current !== null && current !== undefined) {
    const version = getRow(db, 'question_bank_question_version', current)
    if (version !== null) return version
  }
  return findRows(
    db,
    'question_bank_question_version',
    { question_id: question.id },
    { orderBy: [['version', 'desc']], limit: 1 },
  )[0] ?? null
}

/**
 * Record (or reuse) the `editorial_preview` exposure for one candidate.
 *
 * Returns `null` when the candidate is not linked to a published question — nothing published has
 * been looked at yet, so there is no exposure to record.
 */
export function recordCandidateEditorialPreview(
  db: DatabaseSync,
  options: { candidate: Row; actorId: string; source: string },
  now: Instant,
): Row | null {
  const { candidate, actorId, source } = options
  const questionId = candidate.publication_question_id
  if (questionId === null || questionId === undefined) return null
  const question = getRow(db, 'question_bank_question', questionId)
  if (question === null) return null

  const existing = findRows(
    db,
    'practice_exposure_event',
    { user_id: actorId, question_id: question.id, kind: KIND_EDITORIAL_PREVIEW },
    { orderBy: [['server_time', 'desc']] },
  ).find((row) => {
    const detail = row.detail
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return false
    return String((detail as Record<string, unknown>)['candidate_id'] ?? '') === String(candidate.id)
  })
  if (existing !== undefined) return existing

  const version = publishedVersion(db, question)
  return insertRow(
    db,
    'practice_exposure_event',
    {
      user_id: actorId,
      project_id: candidate.project_id,
      question_id: question.id,
      question_version_id: version === null ? null : version.id,
      family_id: question.family_id ?? null,
      content_lineage_id: question.content_lineage_id ?? null,
      session_item_id: null,
      kind: KIND_EDITORIAL_PREVIEW,
      purpose: 'editorial',
      source,
      server_time: now,
      reveals_answer: true,
      detail: {
        proofread_at: formatPythonIso(now),
        note: '',
        published_question:
          question.current_published_version_id !== null && question.current_published_version_id !== undefined,
        candidate_id: String(candidate.id),
        candidate_status: candidate.status,
      },
    },
    { now },
  )
}

// --------------------------------------------------------------------------
// O02: private file download
// --------------------------------------------------------------------------

/** `_open_verification_runs`: an unfinished verification/mock exam blocks answer-bearing reads. */
export function openVerificationRuns(db: DatabaseSync, userId: string, projectId: string): Row[] {
  return findRows(db, 'practice_session', { user_id: userId, project_id: projectId, status: 'active' }).filter(
    (session) => session.mode === 'verification' || session.mode === 'mock_exam',
  )
}

/** `asset_scope`: the asset must belong to this project *and* this user. */
export function assetScope(db: DatabaseSync, userId: string, projectId: string, assetId: string): Row {
  const asset = findOne(db, 'ingestion_asset', { id: assetId, project_id: projectId, owner_id: userId })
  if (asset === null) throw new ScopeViolation('文件不存在或不属于当前项目')
  return asset
}

/**
 * `session_item_id` in the query string: the item must belong to the caller's session in this
 * project. A foreign item is a 404, not a 403 — the caller may not learn that it exists.
 */
export function sessionItemScope(db: DatabaseSync, userId: string, projectId: string, sessionItemId: string): Row {
  const item = findOne(db, 'practice_session_item', { id: sessionItemId })
  if (item === null) throw new ScopeViolation('题项不存在或不属于该项目')
  const session = getRow(db, 'practice_session', item.session_id)
  if (session === null || String(session.user_id) !== String(userId) || String(session.project_id) !== String(projectId)) {
    throw new ScopeViolation('题项不存在或不属于该项目')
  }
  return item
}

/** `_references_asset`: does one version's structured content name this asset in an image block? */
export function referencesAsset(content: unknown, assetId: string): boolean {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return false
  const record = content as Record<string, unknown>
  const needle = String(assetId)
  const blocks: unknown[] = [...((record.blocks as unknown[]) ?? [])]
  for (const option of (record.options as unknown[]) ?? []) {
    if (option !== null && typeof option === 'object') blocks.push(...((option as Record<string, unknown>).blocks as unknown[]) ?? [])
  }
  for (const blank of (record.blanks as unknown[]) ?? []) {
    if (blank !== null && typeof blank === 'object') blocks.push(...((blank as Record<string, unknown>).blocks as unknown[]) ?? [])
  }
  return blocks.some((block) => {
    if (block === null || typeof block !== 'object') return false
    const entry = block as Record<string, unknown>
    return entry.kind === 'image' && String(entry.asset_id ?? '') === needle
  })
}

/**
 * `sealed_questions_for_asset`: every question these bytes can reveal that the resolver calls
 * sealed, ordered by question id (string order, as `sorted()` does).
 *
 * The second `sealed_question_ids` call is not redundant: the first one is the *project-wide* set
 * used to find inline image references, the second re-checks the candidate questions against the
 * sealing policies so a question that is not actually sealed (for example an unrelated sealed
 * family) is not reported.
 */
export function sealedQuestionsForAsset(
  db: DatabaseSync,
  projectId: string,
  asset: Row,
): Array<{ question: Row; code: string }> {
  const versionIds = new Set<string>()

  const documentIds = findRows(db, 'ingestion_source_document', { asset_id: asset.id }).map((row) => String(row.id))
  const cropRegions = findRows(db, 'ingestion_source_region', { crop_asset_id: asset.id })
  const regionIds = new Set(cropRegions.map((row) => String(row.id)))
  for (const documentId of documentIds) {
    for (const region of findRows(db, 'ingestion_source_region', { document_id: documentId })) {
      regionIds.add(String(region.id))
    }
  }
  for (const regionId of regionIds) {
    for (const link of findRows(db, 'question_bank_source_link', { region_id: regionId })) {
      versionIds.add(String(link.question_version_id))
    }
  }
  // Answers read from a region whose crop is this asset. Django filters on
  // `source_region__crop_asset` only — a whole-page document asset is *not* consulted here, which is
  // narrower than the module comment suggests and is kept as-is (06 §3.2).
  for (const region of cropRegions) {
    for (const answer of findRows(db, 'question_bank_answer_key_version', { source_region_id: region.id })) {
      if (answer.question_version_id !== null && answer.question_version_id !== undefined) {
        versionIds.add(String(answer.question_version_id))
      }
    }
  }

  const questionIds = new Set<string>()
  for (const versionId of versionIds) {
    const version = getRow(db, 'question_bank_question_version', versionId)
    if (version !== null) questionIds.add(String(version.question_id))
  }

  const projectSealed = sealedQuestionIds(db, projectId)
  if (projectSealed.size > 0) {
    for (const questionId of projectSealed) {
      for (const version of findRows(db, 'question_bank_question_version', { question_id: questionId })) {
        if (referencesAsset(version.content, String(asset.id))) {
          questionIds.add(questionId)
          break
        }
      }
    }
  }

  if (questionIds.size === 0) return []
  const sealed = sealedQuestionIds(db, projectId, [...questionIds].sort())
  if (sealed.size === 0) return []
  const out: Array<{ question: Row; code: string }> = []
  for (const questionId of [...sealed].sort()) {
    const question = getRow(db, 'question_bank_question', questionId)
    if (question === null) continue
    out.push({ question, code: isSealed(db, projectId, questionId).code })
  }
  return out
}

/**
 * `assert_asset_download_allowed`: the four gates, in the order the messages are written in.
 *
 * Every refusal is `PurposeNotAllowed` (403) and — except sealing — carries no `details`. The
 * sealing refusal carries the code and the question so the client can explain *why* the page is
 * gone instead of showing a bare "forbidden".
 */
export function assertAssetDownloadAllowed(
  db: DatabaseSync,
  options: {
    userId: string
    projectId: string
    asset: Row
    purpose?: string
    session?: Row | null
  },
): void {
  const { userId, projectId, asset } = options
  const purpose = options.purpose ?? 'practice'
  const session = options.session ?? null

  if (asset.sensitivity === 'internal_review') {
    const user = getRow(db, 'accounts_user', userId)
    if (user === null || !Boolean(user.is_staff)) {
      throw new PurposeNotAllowed('该文件仅限内部审核使用')
    }
  }

  const sealed = sealedQuestionsForAsset(db, projectId, asset)
  if (sealed.length > 0) {
    const { question, code } = sealed[0]
    const label = String(question.display_label ?? '') !== '' ? String(question.display_label) : String(question.id)
    throw new PurposeNotAllowed(
      `该文件包含已封存题目的原始内容（题目 ${label}）：${reasonMessage(code)}，因此不能读取原页或答案文件。`,
      {
        details: {
          reason: code,
          question_id: String(question.id),
          asset_id: String(asset.id),
          action: '读取原页/答案文件',
        },
      },
    )
  }

  if (purpose === 'editorial') {
    // The editorial preview is a *proofreading* view of material that may contain answers, so a
    // live verification run refuses it even for a public page — the gate is about the purpose, not
    // only about `sensitivity`.
    if (openVerificationRuns(db, userId, projectId).length > 0) {
      throw new PurposeNotAllowed('存在未结束的验证/考试会话，暂不能查看可能包含答案的来源文件；请先结束验证')
    }
    return
  }

  if (asset.sensitivity === 'contains_answers') {
    if (session !== null) {
      // `allows_pre_submit_answers` is exactly `mode == practice`; a mock exam or a verification
      // run never reveals the key before submission.
      if (session.mode !== 'practice') {
        throw new PurposeNotAllowed('当前会话模式在提交前不允许查看含答案的来源文件')
      }
      if (session.status === 'active' && session.mode !== 'practice') {
        throw new PurposeNotAllowed('验证/考试进行中不允许查看含答案的来源文件')
      }
    } else if (openVerificationRuns(db, userId, projectId).length > 0) {
      throw new PurposeNotAllowed('存在未结束的验证/考试会话，暂不能查看含答案的来源文件')
    }
  }
}

/**
 * `record_download_exposure`: the bytes were delivered, so log it.
 *
 * Only answer-bearing assets are logged, and the log is written *before* the stream opens — a race
 * where the open fails still leaves the exposure row, which is the safe direction: an unlogged
 * delivery would let a question keep counting as "never seen".
 */
export function recordDownloadExposure(
  db: DatabaseSync,
  options: { userId: string; projectId: string; asset: Row; purpose: string; sessionItem?: Row | null },
  now: Instant,
): Row | null {
  const { userId, projectId, asset } = options
  if (asset.sensitivity !== 'contains_answers') return null
  const sessionItem = options.sessionItem ?? null
  const version =
    sessionItem === null ? null : getRow(db, 'question_bank_question_version', sessionItem.question_version_id)
  const question = version === null ? null : getRow(db, 'question_bank_question', version.question_id)
  const purpose = EXPOSURE_PURPOSES.has(options.purpose) ? options.purpose : 'practice'
  return insertRow(
    db,
    'practice_exposure_event',
    {
      user_id: userId,
      project_id: projectId,
      question_id: question === null ? null : question.id,
      question_version_id: version === null ? null : version.id,
      family_id: question === null ? null : (question.family_id ?? null),
      content_lineage_id: question === null ? null : (question.content_lineage_id ?? null),
      session_item_id: sessionItem === null ? null : sessionItem.id,
      kind: KIND_ANSWER_DELIVERED,
      purpose,
      source: 'asset_download',
      server_time: now,
      reveals_answer: true,
      detail: { asset_id: String(asset.id), role: asset.role, server_time: formatPythonIso(now) },
    },
    { now },
  )
}
