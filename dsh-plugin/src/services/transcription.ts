/**
 * Handwriting transcription: propose → human decides → one gate (B07).
 *
 * Port of `backend/apps/practice/services/transcription.py`. A photo answer is not readable text: a
 * vision model *proposes* a transcription and the learner confirms or edits it. Until that happens
 * the answer is opaque, so nothing downstream may grade it — {@link assertTranscriptionConfirmed} is
 * the single gate every consumer (estimation, diagnosis) calls before touching the answer.
 *
 * Two rules from the Python module are load-bearing and preserved here:
 *
 *  * a **manual** row (`origin="manual"`) is created already confirmed, carries no confidence and no
 *    doubts, and is never labelled as a recognition result — this is the honest fallback when no
 *    vision model is configured, so a photo answer never becomes permanently un-gradeable;
 *  * the model output is only ever a *proposal*: `raw_text` is what the model thinks it read, and
 *    only `confirmed_text` may be used as the learner's answer.
 *
 * DSH has no stub provider (R-INV 4), so `is_stub` is always false on the rows this module writes.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  TRANSCRIBE_PROMPT_VERSION,
  buildTranscribePrompt,
} from '../ai/prompts.ts'
import { markFailed, markSucceeded } from '../ai/audit.ts'
import { parseModelJson, pySlice, pyStr, pyStrip } from '../ai/pyvalue.ts'
import { validateTranscription } from '../ai/validators.ts'
import { formatPythonIso, type Instant } from '../domain/instant.ts'
import { getStorage, StorageError } from '../ingestion/storage.ts'
import type { LlmPort } from '../llm/contract.ts'
import { transaction } from '../store/db.ts'
import { countRows, findOne, findRows, insertRow, updateRow, type Row } from '../store/repository.ts'
import { beginAuditedRun, finishAuditedRun, telemetryOf } from './ai_runs.ts'
import {
  AcePassError,
  AiNotConfigured,
  DependencyUnavailable,
  InvalidInput,
  ScopeViolation,
} from './errors.ts'
import { assetScope } from './ingestion_access.ts'

/** The capability a provider must declare to read a photo. A text-only model is never asked. */
export const TRANSCRIBE_CAPABILITY = 'transcribe_handwriting'

/** Statuses whose `confirmed_text` is the learner's answer (`CONFIRMED_STATUSES`). */
export const CONFIRMED_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'edited'])

export const MANUAL_NOTE = '学习者人工录入转写（未使用视觉模型）'

/**
 * Handwritten work must be transcribed and confirmed by the learner first.
 *
 * `TranscriptionRequired` from `apps/common/errors.py`: a 409 raised *before* any model is consulted,
 * so an unconfirmed photo can never be estimated or diagnosed.
 */
export class TranscriptionRequired extends AcePassError {
  code = 'transcription_required'
  statusCode = 409
  constructor(message?: string, options: { details?: Record<string, unknown> } = {}) {
    super(message ?? '该作答含手写照片且尚未确认转写，请先确认或修改转写文本', options)
  }
}

/**
 * Render question blocks for prompt context, keeping math and images.
 *
 * Shared by the transcription, estimation and diagnosis prompts (Python exports this from the
 * transcription service for the same reason) so all three send the model the same question wording.
 */
export function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const record = block as Record<string, unknown>
    const kind = record['kind']
    if (kind === 'text') {
      parts.push(pyStr(record['text'] ?? ''))
    } else if (kind === 'math') {
      parts.push(`$${pyStr(record['latex'] ?? '')}$`)
    } else if (kind === 'list') {
      const items = Array.isArray(record['items']) ? record['items'] : []
      parts.push(items.map((item) => `- ${pyStr(item)}`).join('\n'))
    } else if (kind === 'image') {
      parts.push(`[图片 ${pyStr(record['asset_id'] ?? '') || '未标注'}]`)
    }
  }
  // `"\n".join(part for part in parts if part)`: empty renders are dropped, not emitted as blanks.
  return parts.filter((part) => part !== '').join('\n')
}

/** The learner's own *text*: the typed answer plus the transcriptions they confirmed. */
export function learnerAnswerText(db: DatabaseSync, attempt: Row): string {
  const raw = (attempt.raw_answer !== null && typeof attempt.raw_answer === 'object' && !Array.isArray(attempt.raw_answer)
    ? attempt.raw_answer
    : {}) as Record<string, unknown>
  const questionType = raw['type']
  const parts: string[] = []
  if (questionType === 'constructed_response') {
    const text = pyStrip(pyStr(raw['text'] ?? ''))
    if (text !== '') parts.push(text)
  } else if (questionType === 'fill_blank') {
    const blanks = (raw['blanks'] !== null && typeof raw['blanks'] === 'object' ? raw['blanks'] : {}) as Record<string, unknown>
    const rendered = Object.entries(blanks)
      .map(([key, value]) => `${key}=${pyStr(value)}`)
      .join('；')
    if (rendered !== '') parts.push(rendered)
  } else if (Object.keys(raw).length > 0) {
    // Python: `json.dumps(raw, ensure_ascii=False)[:2000]`. The compact form differs from Python's
    // spaced separators; recorded as a documented divergence in the B8 report (prompt text only,
    // never a stored digest that this package compares).
    parts.push(pySlice(JSON.stringify(raw), 2000))
  }
  const confirmed = confirmedTextFor(db, attempt)
  if (confirmed !== '') parts.push(`【学习者已确认的手写转写】\n${confirmed}`)
  return parts.join('\n')
}

function itemOf(db: DatabaseSync, attempt: Row): Row {
  const item = findOne(db, 'practice_session_item', { id: String(attempt.session_item_id) })
  if (item === null) throw new ScopeViolation('作答不存在或不在当前权限范围')
  return item
}

function versionOf(db: DatabaseSync, item: Row): Row {
  const version = findOne(db, 'question_bank_question_version', { id: String(item.question_version_id) })
  if (version === null) throw new ScopeViolation('题项不存在或不在当前权限范围')
  return version
}

/** Whether this attempt carries handwritten work at all (only a constructed response can). */
export function isHandwrittenAttempt(db: DatabaseSync, attempt: Row): boolean {
  return versionOf(db, itemOf(db, attempt)).question_type === 'constructed_response'
}

/**
 * Answer photos that still need a confirmed transcription.
 *
 * Only a constructed-response attempt carries handwritten work; a photo attached to any other type is
 * not a transcription target.
 */
export function handwritingAssets(db: DatabaseSync, attempt: Row): string[] {
  if (!isHandwrittenAttempt(db, attempt)) return []
  const confirmed = new Set(
    findRows(db, 'practice_answer_transcription', { attempt_id: attempt.id })
      .filter((row) => CONFIRMED_STATUSES.has(String(row.status)))
      .map((row) => String(row.asset_id)),
  )
  const attachments = Array.isArray(attempt.attachments) ? attempt.attachments : []
  return attachments.map((asset) => String(asset)).filter((asset) => !confirmed.has(asset))
}

/**
 * The single gate: refuse to grade/diagnose an unconfirmed transcription.
 *
 * Exported for reuse — estimation and diagnosis both call it *first*, so a new entry point cannot
 * quietly skip the learner's confirmation.
 */
export function assertTranscriptionConfirmed(db: DatabaseSync, attempt: Row): void {
  const pending = handwritingAssets(db, attempt)
  if (pending.length > 0) throw new TranscriptionRequired(undefined, { details: { asset_ids: pending } })
}

/** The learner's own transcriptions, concatenated, for prompts. */
export function confirmedTextFor(db: DatabaseSync, attempt: Row): string {
  return findRows(db, 'practice_answer_transcription', { attempt_id: attempt.id })
    .filter((row) => CONFIRMED_STATUSES.has(String(row.status)) && String(row.confirmed_text ?? '') !== '')
    .sort(byCreatedAt)
    .map((row) => String(row.confirmed_text))
    .join('\n')
}

/** Prompt note: how many photos were transcribed, and what was doubtful at transcription time. */
export function transcriptionNoteFor(db: DatabaseSync, attempt: Row): string {
  const rows = findRows(db, 'practice_answer_transcription', { attempt_id: attempt.id })
    .filter((row) => CONFIRMED_STATUSES.has(String(row.status)))
    .sort(byCreatedAt)
  if (rows.length === 0) return ''
  const doubts = rows
    .flatMap((row) => (Array.isArray(row.doubts) ? row.doubts : []))
    .map((doubt) => pyStr(doubt))
    .filter((doubt) => pyStrip(doubt) !== '')
  let note = `手写作答已由学习者确认 ${rows.length} 张照片的转写。`
  if (doubts.length > 0) note += '转写时标注的疑点（仍以确认文本为准）：' + doubts.slice(0, 5).join('；')
  return note
}

function byCreatedAt(a: Row, b: Row): number {
  const left = a.created_at as Instant
  const right = b.created_at as Instant
  return left < right ? -1 : left > right ? 1 : 0
}

/** Wire shape of one transcription row. `raw_text` stays labelled as a proposal. */
export function transcriptionPayload(row: Row): Record<string, unknown> {
  const origin = String(row.origin)
  return {
    transcription_id: String(row.id),
    attempt_id: String(row.attempt_id),
    asset_id: String(row.asset_id),
    origin,
    status: String(row.status),
    raw_text: String(row.raw_text ?? ''),
    confirmed_text: String(row.confirmed_text ?? ''),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    doubts: Array.isArray(row.doubts) ? row.doubts : [],
    is_stub: Boolean(row.is_stub),
    note: String(row.note ?? ''),
    is_confirmed: CONFIRMED_STATUSES.has(String(row.status)),
    decided_at:
      row.decided_at === null || row.decided_at === undefined ? null : formatPythonIso(row.decided_at as Instant),
    llm_run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    // Only a model row names the instruction version that produced it.
    prompt_version: origin === 'model' ? TRANSCRIBE_PROMPT_VERSION : '',
  }
}

function attachmentIds(attempt: Row): string[] {
  const attachments = Array.isArray(attempt.attachments) ? attempt.attachments : []
  return attachments.map((value) => String(value))
}

/**
 * Record what the learner says they wrote, without any model.
 *
 * This is the honest fallback required by the P0 rule "no vision model means the human path".
 */
export function recordManualTranscription(
  db: DatabaseSync,
  options: { attempt: Row; assetId: string; text: string; actorId: string; note?: string },
  now: Instant,
): Row {
  const { attempt } = options
  const assetId = pyStrip(pyStr(options.assetId ?? ''))
  const attachments = attachmentIds(attempt)
  if (assetId === '' || !attachments.includes(assetId)) {
    throw new InvalidInput('该图片不属于本次作答，不能录入转写', {
      details: { asset_id: assetId, attachment_asset_ids: attachments },
    })
  }
  const body = pyStrip(pyStr(options.text ?? ''))
  if (body === '') throw new InvalidInput('人工录入的转写文本不能为空')
  return transaction(db, () => {
    const locked = findOne(db, 'practice_answer_transcription', { attempt_id: attempt.id, asset_id: assetId })
    if (
      locked !== null &&
      String(locked.origin) === 'model' &&
      CONFIRMED_STATUSES.has(String(locked.status))
    ) {
      throw new InvalidInput('该图片的模型转写已确认，不能改写为人工录入', {
        details: { transcription_id: String(locked.id), status: String(locked.status) },
      })
    }
    const fields: Row = {
      origin: 'manual',
      status: 'confirmed',
      raw_text: pySlice(body, 8000),
      confirmed_text: pySlice(body, 8000),
      confidence: null,
      doubts: [],
      is_stub: false,
      run_id: null,
      decided_by_id: options.actorId,
      decided_at: now,
      note: pySlice(pyStr(options.note ?? '') || MANUAL_NOTE, 500),
    }
    const row =
      locked === null
        ? insertRow(
            db,
            'practice_answer_transcription',
            { attempt_id: attempt.id, asset_id: assetId, ...fields },
            { now },
          )
        : updateRow(db, 'practice_answer_transcription', locked.id, fields, { now })
    if (row === null) throw new ScopeViolation('转写不存在或不在当前权限范围')
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'answer_transcription',
        entity_id: String(row.id),
        action: 'transcription_confirmed',
        project_id: attempt.project_id,
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: { asset_id: assetId, origin: 'manual', attempt_id: String(attempt.id) },
      },
      { now },
    )
    return row
  })
}

/**
 * The reason text for "this provider cannot run this capability".
 *
 * Django collapses "no provider" and "provider lacks the capability" into one `AiUnavailable`; this
 * port keeps the two codes apart (`ai_not_configured` vs `ai_capability_unsupported`), and the
 * sentence names which one applies. The `未配置` prefix is kept because the UI branches on it.
 */
export function capabilityMissingReason(capability: string, reason: string): string {
  if (reason === 'ai_capability_unsupported') return `provider 不支持能力：${capability}`
  return `未配置 AI 能力（无法执行 ${capability}）`
}

/**
 * Map a provider failure onto the product's error contract (`_raise_ai_error`).
 *
 * A missing capability is "AI not configured" (503); anything else the provider raised is a
 * dependency failure (503). Never a fabricated result.
 */
export function raiseAiError(code: string, message: string, action: string): never {
  if (code === 'ai_not_configured' || code === 'ai_capability_unsupported') {
    throw new AiNotConfigured(`${action}需要配置 AI 能力：${message || '未配置 AI 能力'}`, {
      details: { error_code: code },
    })
  }
  throw new DependencyUnavailable(`${action}失败：${message || code}`, { details: { error_code: code } })
}

/**
 * Ask a vision provider to transcribe one answer photo.
 *
 * The result is only ever a *proposal*; a rerun replaces the proposal fields but never overwrites a
 * row the learner already confirmed or edited. When the provider cannot read photos the run row says
 * so and an `ai_not_configured` 503 is raised (no bytes are read, no image is guessed at).
 */
export async function requestTranscription(
  db: DatabaseSync,
  options: { attempt: Row; assetId: string; actorId: string; port: LlmPort },
  now: Instant,
): Promise<Row> {
  const { attempt } = options
  const assetId = pyStrip(pyStr(options.assetId ?? ''))
  const attachments = attachmentIds(attempt)
  if (assetId === '' || !attachments.includes(assetId)) {
    throw new InvalidInput('该图片不属于本次作答，不能转写', {
      details: { asset_id: assetId, attachment_asset_ids: attachments },
    })
  }
  const existing = findOne(db, 'practice_answer_transcription', { attempt_id: attempt.id, asset_id: assetId })
  if (existing !== null && CONFIRMED_STATUSES.has(String(existing.status))) {
    throw new InvalidInput('该图片的转写已由学习者确认，不能重新转写；如需修改请重新提交作答', {
      details: { transcription_id: String(existing.id), status: String(existing.status) },
    })
  }
  const item = itemOf(db, attempt)
  const version = versionOf(db, item)
  const question = findOne(db, 'question_bank_question', { id: String(version.question_id) })
  if (question === null) throw new ScopeViolation('题目不存在或不在当前权限范围')
  const subject = findOne(db, 'exams_subject', { id: String(question.subject_id) })
  // Scope the asset to the attempt's own owner/project: an attachment id from another project must
  // not become readable through this path.
  const asset = assetScope(db, String(attempt.user_id), String(attempt.project_id), assetId)
  const prompt = buildTranscribePrompt({
    subject_name: subject === null ? '' : subject.name,
    question_stem: blocksText((version.content as Record<string, unknown> | null)?.blocks),
  })
  const handle = beginAuditedRun(
    db,
    { capability: TRANSCRIBE_CAPABILITY, promptVersion: TRANSCRIBE_PROMPT_VERSION, system: '', prompt },
    {
      userId: String(attempt.user_id),
      projectId: String(attempt.project_id),
      requestSummary: {
        attempt_id: String(attempt.id),
        asset_id: assetId,
        question_version_id: String(item.question_version_id),
        question_type: String(version.question_type),
      },
      inputSnapshot: {
        attempt_id: String(attempt.id),
        asset_id: assetId,
        asset_content_type: String(asset.content_type ?? ''),
        asset_size_bytes: Number(asset.size_bytes ?? 0),
        prompt_version: TRANSCRIBE_PROMPT_VERSION,
        prompt_digest: promptDigest(prompt),
      },
    },
    now,
  )
  const availability = await options.port.availability()
  const capability = availability.transcribe_handwriting
  if (capability === undefined || !capability.available) {
    // Django's sentence names the missing modality; keep one suffix instead of stacking parentheses.
    const missing = capability.reason ?? 'ai_not_configured'
    const reason =
      missing === 'ai_capability_unsupported'
        ? `provider 不支持能力：${TRANSCRIBE_CAPABILITY}（需要视觉模型）`
        : `未配置 AI 能力：无法执行 ${TRANSCRIBE_CAPABILITY}（需要视觉模型）`
    finishAuditedRun(
      db,
      handle.rowId,
      markFailed(handle.record, { code: 'ai_not_configured', message: reason }),
      now,
    )
    raiseAiError('ai_not_configured', reason, '手写转写')
  }
  let imageBytes: Buffer
  try {
    const storage = getStorage()
    const key = String(asset.object_key ?? '')
    if (key === '' || !storage.exists(key)) throw new StorageError(String(asset.object_key ?? ''))
    imageBytes = storage.open(key)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    finishAuditedRun(
      db,
      handle.rowId,
      markFailed(handle.record, { code: 'asset_bytes_unavailable', message: pySlice(message, 500) }),
      now,
    )
    throw new DependencyUnavailable('作答图片不可读，无法转写；请重新上传照片', {
      details: { error_code: 'asset_bytes_unavailable' },
    })
  }
  const mediaType = String(asset.content_type ?? '').startsWith('image/') ? String(asset.content_type) : 'image/png'
  const result = await options.port.run({
    capability: TRANSCRIBE_CAPABILITY,
    promptVersion: TRANSCRIBE_PROMPT_VERSION,
    system: '',
    prompt,
    images: [{ mediaType, dataBase64: imageBytes.toString('base64') }],
  })
  if (!result.ok) {
    finishAuditedRun(db, handle.rowId, markFailed(handle.record, { code: result.code, message: result.message }), now)
    raiseAiError(result.code, result.message, '手写转写')
  }
  let parsed: unknown
  try {
    parsed = parseModelJson(result.text)
  } catch {
    finishAuditedRun(
      db,
      handle.rowId,
      {
        ...markFailed(handle.record, { code: 'ai_invalid_output', message: '模型输出不是合法 JSON，未生成任何转写' }, telemetryOf(result)),
      },
      now,
    )
    throw new DependencyUnavailable('模型转写输出不是合法 JSON，未生成任何转写', {
      details: { error_code: 'ai_invalid_output' },
    })
  }
  const [clean, problems] = validateTranscription(parsed)
  finishAuditedRun(
    db,
    handle.rowId,
    markSucceeded(handle.record, telemetryOf(result), { problems, accepted: problems.length === 0 }),
    now,
  )
  return storeProposal(db, {
    attempt,
    assetId,
    clean,
    isStub: false,
    runId: handle.rowId,
    now,
  })
}

/** `sha256(prompt)` — the prompt is not stored, but its digest lets an auditor name the version. */
export function promptDigest(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

/** Persist the proposal, re-checking under the row lock that it is not already decided. */
function storeProposal(
  db: DatabaseSync,
  options: { attempt: Row; assetId: string; clean: { text: string; confidence: number | null; doubts: string[] }; isStub: boolean; runId: string; now: Instant },
): Row {
  return transaction(db, () => {
    const locked = findOne(db, 'practice_answer_transcription', {
      attempt_id: options.attempt.id,
      asset_id: options.assetId,
    })
    if (locked !== null && CONFIRMED_STATUSES.has(String(locked.status))) {
      throw new InvalidInput('该图片的转写已由学习者确认，不能重新转写', {
        details: { transcription_id: String(locked.id), status: String(locked.status) },
      })
    }
    const fields: Row = {
      status: 'proposed',
      raw_text: options.clean.text,
      confirmed_text: '',
      confidence: options.clean.confidence,
      doubts: options.clean.doubts,
      is_stub: options.isStub,
      run_id: options.runId,
      // A fresh proposal is undecided again; an earlier rejection is not carried over.
      decided_by_id: null,
      decided_at: null,
      note: '',
    }
    const row =
      locked === null
        ? insertRow(
            db,
            'practice_answer_transcription',
            { attempt_id: options.attempt.id, asset_id: options.assetId, ...fields },
            { now: options.now },
          )
        : updateRow(db, 'practice_answer_transcription', locked.id, fields, { now: options.now })
    if (row === null) throw new ScopeViolation('转写不存在或不在当前权限范围')
    return row
  })
}

/** Accept the model text, or the learner's corrected text, as *the* answer. */
export function confirmTranscription(
  db: DatabaseSync,
  options: { transcription: Row; actorId: string; text?: string | null },
  now: Instant,
): Row {
  return transaction(db, () => {
    const locked = findOne(db, 'practice_answer_transcription', { id: options.transcription.id })
    if (locked === null) throw new ScopeViolation('转写不存在或不在当前权限范围')
    if (String(locked.status) !== 'proposed') {
      throw new InvalidInput('只有待确认的转写可以确认', { details: { status: String(locked.status) } })
    }
    const candidate = options.text === undefined || options.text === null ? String(locked.raw_text ?? '') : pyStr(options.text)
    const confirmed = pyStrip(candidate)
    if (confirmed === '') {
      throw new InvalidInput('确认文本不能为空；看不清的内容请手动输入，或否决这次转写')
    }
    // `edited` means the learner changed what the model read — the honest label for a confirmation
    // that is not a straight accept.
    const edited =
      options.text !== undefined && options.text !== null && confirmed !== pyStrip(String(locked.raw_text ?? ''))
    const status = edited ? 'edited' : 'confirmed'
    const row = updateRow(
      db,
      'practice_answer_transcription',
      locked.id,
      {
        confirmed_text: pySlice(confirmed, 8000),
        status,
        decided_by_id: options.actorId,
        decided_at: now,
      },
      { now },
    )
    if (row === null) throw new ScopeViolation('转写不存在或不在当前权限范围')
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'answer_transcription',
        entity_id: String(row.id),
        action: 'transcription_confirmed',
        project_id: attemptProjectId(db, row),
        reason: '',
        before_digest: '',
        after_digest: '',
        detail: {
          status,
          asset_id: String(row.asset_id),
          edited,
          is_stub: Boolean(row.is_stub),
          confirmed_length: Array.from(String(row.confirmed_text)).length,
        },
      },
      { now },
    )
    return row
  })
}

function attemptProjectId(db: DatabaseSync, transcription: Row): string {
  const attempt = findOne(db, 'practice_attempt', { id: String(transcription.attempt_id) })
  return attempt === null ? '' : String(attempt.project_id)
}

/** Refuse the proposal; the photo stays unconfirmed and the gate stays closed. */
export function rejectTranscription(
  db: DatabaseSync,
  options: { transcription: Row; actorId: string; note?: string },
  now: Instant,
): Row {
  return transaction(db, () => {
    const locked = findOne(db, 'practice_answer_transcription', { id: options.transcription.id })
    if (locked === null) throw new ScopeViolation('转写不存在或不在当前权限范围')
    if (String(locked.status) !== 'proposed') {
      throw new InvalidInput('只有待确认的转写可以否决', { details: { status: String(locked.status) } })
    }
    const note = pySlice(pyStr(options.note ?? ''), 500)
    const row = updateRow(
      db,
      'practice_answer_transcription',
      locked.id,
      { status: 'rejected', confirmed_text: '', note, decided_by_id: options.actorId, decided_at: now },
      { now },
    )
    if (row === null) throw new ScopeViolation('转写不存在或不在当前权限范围')
    insertRow(
      db,
      'audit_content_revision',
      {
        actor_id: options.actorId,
        entity_type: 'answer_transcription',
        entity_id: String(row.id),
        action: 'transcription_rejected',
        project_id: attemptProjectId(db, options.transcription),
        reason: note,
        before_digest: '',
        after_digest: '',
        detail: { asset_id: String(row.asset_id), is_stub: Boolean(row.is_stub) },
      },
      { now },
    )
    return row
  })
}

/** `GET …/transcriptions` — the transcriptions plus which photos still block grading. */
export function transcriptionList(db: DatabaseSync, attempt: Row): Record<string, unknown> {
  const pending = handwritingAssets(db, attempt)
  const rows = findRows(db, 'practice_answer_transcription', { attempt_id: attempt.id }).sort(byCreatedAt)
  return {
    attempt_id: String(attempt.id),
    attachment_asset_ids: attachmentIds(attempt),
    pending_asset_ids: pending,
    transcription_required: pending.length > 0,
    gate_open: pending.length === 0,
    transcriptions: rows.map(transcriptionPayload),
  }
}

/** How many transcriptions one attempt has (used by the AI surfaces' audit summaries). */
export function transcriptionCount(db: DatabaseSync, attemptId: string): number {
  return countRows(db, 'practice_answer_transcription', { attempt_id: attemptId })
}
