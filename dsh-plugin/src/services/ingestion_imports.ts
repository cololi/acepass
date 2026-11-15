/**
 * Ingestion import entry points (batch B1: the text path and job retry; B3: the image path;
 * B4: the native-text PDF path).
 *
 * Port of `backend/apps/ingestion/services/imports.py::start_text_import`, `start_image_import`,
 * `start_pdf_import` and `retry_job`.
 *
 * Every path is a single transaction: the source document(s), the job, one region per parsed segment
 * (or per page a question occupies) and one candidate per segment commit together. A region bbox
 * failure at segment index ≥ 20 therefore rolls the whole import back (Django does the same; see
 * `create_source_region`).
 *
 * Two paths need an asynchronous prelude because their decoders are promise-based (`sharp`,
 * `pdfjs`) while `transaction()` is deliberately synchronous: `prepareAssetImage` for images and
 * `preparePdfUploads` for PDFs. Both preludes are pure functions of the uploaded bytes and run
 * **before** the transaction (and, in the HTTP layer, before the idempotency claim), which is what
 * keeps "the second file was corrupt" a zero-write outcome.
 */
import type { DatabaseSync } from 'node:sqlite'

import { pyCodePointLen, pyCodePointSlice, pyFind, pyStrip, pyTruthy } from '../domain/ingestion/pystring.ts'
import {
  REASON_COLUMN_ORDER_AMBIGUOUS,
  REASON_FORMULA,
  REASON_MULTI_COLUMN,
  REASON_SCANNED,
  REASON_TABLE_GRID,
  ISSUE_MULTI_COLUMN,
  ISSUE_SCANNED,
  ISSUE_TABLE_FORMULA,
} from '../domain/ingestion/layout.ts'
import { bboxForText } from '../domain/ingestion/pdf_layout.ts'
import {
  applyAnswerMatches,
  attachCrossPageContinua,
  attachSourcePages,
  detectPageContinuations,
  parseAnswerPage,
  parsePaste,
  type ParsedSegment,
} from '../domain/ingestion/text_parser.ts'
import type { Instant } from '../domain/instant.ts'
import { transaction } from '../store/db.ts'
import { getRow, updateRow, type Row } from '../store/repository.ts'
import { enqueue } from '../store/outbox.ts'
import {
  addJobProblem,
  createCandidate,
  createImportJob,
  createSourceRegion,
  createTextDocument,
  maybeCompleteJob,
  refreshCandidateIssues,
} from './ingestion.ts'
import { createPdfDocument, findDuplicateDocument } from './ingestion_sources.ts'
import { createPaperRevisionForImport, getOrCreatePaperForImport } from './exams.ts'
import { extractNativeText, type PdfExtraction } from '../ingestion/pdf.ts'
import { fileChecksum } from './ingestion.ts'
import { InvalidInput } from './errors.ts'

export interface TextImportInput {
  ownerId: string
  projectId: string
  subjectId: string | null
  text: string
  title?: string
  sourceNote?: string
  usageScope?: string
  segments: Record<string, unknown>[]
}

/**
 * `start_text_import`: create the raw document, the job and one candidate per parsed segment.
 *
 * `cursor` only moves forward: the parser's `source_excerpt` is searched from the previous segment's
 * end, so identical excerpts map to successive occurrences instead of all pointing at the first.
 */
export function startTextImport(db: DatabaseSync, input: TextImportInput, now: Instant): Row {
  return transaction(db, () => {
    const document = createTextDocument(
      db,
      {
        ownerId: input.ownerId,
        projectId: input.projectId,
        subjectId: input.subjectId,
        text: input.text,
        title: input.title ?? '',
        sourceNote: input.sourceNote ?? '',
        usageScope: input.usageScope ?? '',
      },
      now,
    )
    let job = createImportJob(
      db,
      {
        ownerId: input.ownerId,
        projectId: input.projectId,
        subjectId: input.subjectId,
        inputKind: 'text',
        inputText: input.text,
        documents: [document],
        extractorVersion: 'text-structure-v1',
      },
      now,
    )
    job = updateRow(db, 'ingestion_import_job', job.id, { status: 'processing', started_at: now }, { now })!

    let cursor = 0
    input.segments.forEach((segment, index) => {
      const excerpt = segment['source_excerpt']
      if (typeof excerpt !== 'string') {
        // Python would raise `TypeError: must be str` inside `text.find`; the parser never emits
        // such a segment, and inventing an excerpt here would silently misplace the region.
        throw new Error('segment.source_excerpt must be a string')
      }
      let start = pyFind(input.text, excerpt, cursor)
      if (start < 0) start = cursor
      const end = start + pyCodePointLen(excerpt)
      cursor = end
      let region = createSourceRegion(
        db,
        {
          documentId: String(document.id),
          pageIndex: 1,
          x: 0,
          y: Math.min(0.99, index * 0.05),
          width: 1,
          height: 0.05,
          role: 'stem_crop',
          textSpan: pyCodePointSlice(excerpt, 0, 2000),
        },
        now,
      )
      region = updateRow(
        db,
        'ingestion_source_region',
        region.id,
        { char_start: start, char_end: end },
        { now },
      )!
      createCandidate(
        db,
        {
          job,
          payload: segment,
          subjectId: input.subjectId,
          machinePayload: segment,
          regionIds: [String(region.id)],
          extractorVersion: 'text-structure-v1',
        },
        now,
      )
    })

    if (input.segments.length === 0) {
      addJobProblem(
        db,
        job,
        {
          code: 'no_recognised_segment',
          message: '未能从粘贴文本中识别出题目结构，请使用“题目模板”格式或手工录入。',
          severity: 'warning',
        },
        now,
      )
    }
    maybeCompleteJob(db, getRow(db, 'ingestion_import_job', job.id)!, now)
    return getRow(db, 'ingestion_import_job', job.id)!
  })
}

/**
 * `start_image_import`: store the pages, open one proofreading candidate per page, and either
 * queue vision extraction or say plainly that the learner has to type the structure in.
 *
 * The branch is chosen by capability, not by hope: with a provider that declares
 * `extract_question` the job is `image_ai` / `vision-v1` and one `ingestion.extract_candidate`
 * outbox row is enqueued per candidate; without one the job is `image_manual` / `manual-image-v1`
 * and carries the `manual_structure_required` warning. **A manual import is still a 201** — the
 * bytes are saved and the proofreading path works, so refusing the upload would be a regression.
 *
 * `useVision` is an input here rather than a lookup: the HTTP layer has no model route in B3, so
 * every real request takes the manual branch. The `image_ai` branch is implemented and covered by
 * the write-set golden vectors with an injected `true`, but the worker that consumes the queued
 * extraction is batch B5 — the port does not claim the vision chain is wired (04 §K).
 */
export interface ImageImportInput {
  ownerId: string
  projectId: string
  subjectId: string | null
  documents: Row[]
  title?: string
  useVision: boolean
  /** `extraction.vision_is_stub()`: only a stub provider is a stub, never a real one. */
  visionIsStub?: boolean
}

export function startImageImport(db: DatabaseSync, input: ImageImportInput, now: Instant): Row {
  return transaction(db, () => {
    const inputKind = input.useVision ? 'image_ai' : 'image_manual'
    const extractorVersion = input.useVision ? 'vision-v1' : 'manual-image-v1'
    let job = createImportJob(
      db,
      {
        ownerId: input.ownerId,
        projectId: input.projectId,
        subjectId: input.subjectId,
        inputKind,
        documents: input.documents,
        extractorVersion,
      },
      now,
    )
    job = updateRow(db, 'ingestion_import_job', job.id, { status: 'processing', started_at: now }, { now })!

    if (input.useVision) {
      const stubNote = input.visionIsStub
        ? '（当前为测试/演示 stub，输出不代表真实模型识别，必须完整人工核对）'
        : ''
      job = addJobProblem(
        db,
        job,
        {
          code: 'vision_extraction_queued',
          message: `图片已保存为私有来源，已排入视觉识别任务；识别结果仍需人工对照原图校对后才能发布。${stubNote}`,
          severity: stubNote === '' ? 'info' : 'warning',
        },
        now,
      )
    } else {
      job = addJobProblem(
        db,
        job,
        {
          code: 'manual_structure_required',
          message:
            '图片已保存为私有来源；未配置视觉模型，请在校对页对照原图录入题干与答案。' +
            '配置可用的视觉 provider 后，同一入口会自动改为模型识别 + 人工校对。',
          severity: 'warning',
        },
        now,
      )
    }

    const title = input.title ?? ''
    for (const document of input.documents) {
      const region = createSourceRegion(
        db,
        {
          documentId: String(document.id),
          pageIndex: 1,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          role: 'past_paper_page',
        },
        now,
      )
      const candidate = createCandidate(
        db,
        {
          job,
          payload: {
            question_type: 'single_choice',
            // Python `title or document.title`: an empty form field falls back to the document.
            display_label: title !== '' ? title : String(document.title ?? ''),
            content: { blocks: [{ kind: 'text', text: '' }] },
            answer_payload: {},
            answer_status_known: false,
            needs_manual_structure: true,
          },
          subjectId: input.subjectId,
          regionIds: [String(region.id)],
          extractorVersion,
        },
        now,
      )
      if (input.useVision) {
        enqueue(db, {
          topic: 'ingestion.extract_candidate',
          payload: {
            import_job_id: String(job.id),
            document_id: String(document.id),
            candidate_id: String(candidate.id),
          },
          dedupeKey: `extract-candidate:${candidate.id}`,
          now,
        })
      }
    }
    return maybeCompleteJob(db, getRow(db, 'ingestion_import_job', job.id)!, now)
  })
}

/**
 * `retry_job`: reuse the same sources and candidates — it never re-runs the parser, rebuilds
 * candidates, re-enqueues vision work or clears `finished_at`.
 */
export function retryJob(db: DatabaseSync, job: Row, now: Instant): Row {
  return transaction(db, () => {
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new InvalidInput('只有失败或已取消的任务可以重试')
    }
    if (Number(job.attempts) >= Number(job.max_attempts)) {
      throw new InvalidInput(`已重试 ${Number(job.attempts)} 次，达到上限；请新建导入任务`)
    }
    const attempts = Number(job.attempts) + 1
    let updated = updateRow(
      db,
      'ingestion_import_job',
      job.id,
      { attempts, status: 'processing', last_error: '', started_at: now },
      { now },
    )!
    updated = addJobProblem(
      db,
      updated,
      { code: 'retried', message: `任务已重试（第 ${attempts} 次），复用原有来源与候选。`, severity: 'warning' },
      now,
    )
    return maybeCompleteJob(db, updated, now)
  })
}

// --------------------------------------------------------------------------
// O09 — native-text PDF batch import
// --------------------------------------------------------------------------

/** One uploaded PDF, already read into memory by the HTTP layer. */
export interface PdfUpload {
  filename: string
  bytes: Uint8Array
  /** The declared MIME type; an empty string means "assume application/pdf". */
  contentType: string
}

/** Recorded on every candidate and job so the producer of a parse is traceable. */
export const PDF_EXTRACTOR_VERSION = 'pdf-text-v2'
/** Upper bound on the per-page diagnosis rows persisted on one job. */
export const MAX_JOB_PAGE_DIAGNOSTICS = 500

const PDF_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/x-pdf',
  'application/octet-stream',
])

export interface PdfImportInput {
  ownerId: string
  projectId: string
  subjectId: string | null
  paperFiles: PdfUpload[]
  answerFiles?: PdfUpload[]
  /**
   * The result of `preparePdfUploads`. The HTTP layer passes it because the extraction has to run
   * **before** the idempotency claim (it is asynchronous and the claim must share the write
   * transaction); omitting it makes the function extract on its own, which is what tests use.
   */
  prepared?: PreparedPdfUpload[]
  title?: string
  sourceNote?: string
  usageScope?: string
  cycleKey?: string
  sessionKey?: string
  paperCode?: string
  sourceKind?: string
  expectedSessionCount?: number | null
  paperTitle?: string
}

interface SourceFile {
  document: Row
  extraction: PdfExtraction
  reused: boolean
}

/** One upload after the MIME check and the extraction, before any database write. */
export interface PreparedPdfUpload {
  upload: PdfUpload
  extraction: PdfExtraction
  checksum: string
  isAnswer: boolean
}

/**
 * The asynchronous half of O09: MIME allowlist + extraction + checksum, per upload, in Django's
 * order (papers first, then answers).
 *
 * Order matters for the *reported error*, not just for the work: Django validates and extracts one
 * file before it looks at the next, so a request whose first file has a wrong MIME type reports that
 * and not the second file's corruption. Hoisting the whole loop in front of the transaction keeps
 * that order because nothing is written either way.
 */
export async function preparePdfUploads(input: {
  paperFiles: PdfUpload[]
  answerFiles?: PdfUpload[]
}): Promise<PreparedPdfUpload[]> {
  const answerFiles = input.answerFiles ?? []
  const uploads = [...input.paperFiles, ...answerFiles]
  const prepared: PreparedPdfUpload[] = []
  for (let index = 0; index < uploads.length; index += 1) {
    const upload = uploads[index]
    const contentType = (upload.contentType ?? '').toLowerCase()
    if (contentType !== '' && !PDF_CONTENT_TYPES.has(contentType)) {
      throw new InvalidInput('仅支持 PDF 文件（原生文字版）', {
        details: { content_type: contentType, filename: upload.filename },
      })
    }
    const extraction = await extractNativeText(upload.bytes)
    prepared.push({
      upload,
      extraction,
      checksum: fileChecksum(upload.bytes),
      isAnswer: index >= input.paperFiles.length,
    })
  }
  return prepared
}

/** The two checks Django performs before it touches a single byte. */
function assertPdfImportInput(db: DatabaseSync, input: PdfImportInput): void {
  if (input.paperFiles.length === 0) throw new InvalidInput('请至少上传一份试卷 PDF')
  if (input.subjectId !== null && input.subjectId !== undefined) {
    const subject = getRow(db, 'exams_subject', input.subjectId)
    if (subject === null || String(subject.project_id) !== String(input.projectId)) {
      throw new InvalidInput('科目不属于该项目')
    }
  }
}

/**
 * `start_pdf_import`: import born-digital paper PDFs (plus optional answer PDFs) as candidates.
 *
 * Everything mechanical happens here — extraction, page attribution, structure parsing and answer
 * matching — and every step is recorded so a proofreader can check it against the original page.
 * Publication stays a separate, explicit human act, and no step needs an AI provider.
 *
 * **The async/transaction split.** `pdfjs` is promise-based and `transaction()` is deliberately
 * synchronous (06 §0.1), so the extraction runs *before* the transaction opens — the same split the
 * image path uses for `sharp`. Only the checks that must report Django's exact first error stay in
 * front of it: for each upload in order, the MIME allowlist is checked and the bytes are extracted
 * before the next upload is looked at, so a request that is wrong in two ways still reports the
 * first file's problem. The database work is then a single transaction, which is what makes "the
 * second PDF was corrupt" leave **zero** documents, candidates and job rows behind.
 */
export async function startPdfImport(db: DatabaseSync, input: PdfImportInput, now: Instant): Promise<Row> {
  assertPdfImportInput(db, input)
  const prepared = input.prepared ?? (await preparePdfUploads({ paperFiles: input.paperFiles, answerFiles: input.answerFiles }))
  return startPdfImportPrepared(db, { ...input, prepared }, now)
}

/**
 * The synchronous half: every write of one PDF import, in one transaction.
 *
 * Split out because `transaction()` must not span an `await` (06 §0.1) and because the HTTP layer
 * has to claim the idempotency key inside the same transaction as the writes. Callers that already
 * prepared the uploads use this directly; `startPdfImport` is the convenience wrapper for tests.
 */
export function startPdfImportPrepared(
  db: DatabaseSync,
  input: PdfImportInput & { prepared: PreparedPdfUpload[] },
  now: Instant,
): Row {
  assertPdfImportInput(db, input)
  const extracted = input.prepared

  // ---- one transaction for every write ------------------------------------------------
  return transaction(db, () => {
    const sources: SourceFile[] = []
    extracted.forEach((entry) => {
      const isAnswer = entry.isAnswer
      const role = isAnswer ? 'answer_page' : 'past_paper_page'
      const sensitivity = isAnswer ? 'contains_answers' : 'public_to_owner'
      const baseTitle = isAnswer ? (input.title ? `${input.title}（答案）` : '') : (input.title ?? '')
      const existing = findDuplicateDocument(db, { projectId: input.projectId, checksum: entry.checksum })
      if (existing !== null) {
        // Reuse the original source: its subject/role/sensitivity are **not** overwritten by this
        // request's parameters, so a later import cannot silently reclassify an existing page.
        sources.push({ document: existing, extraction: entry.extraction, reused: true })
        return
      }
      const document = createPdfDocument(
        db,
        {
          ownerId: input.ownerId,
          projectId: input.projectId,
          subjectId: input.subjectId,
          content: entry.upload.bytes,
          role,
          title: baseTitle !== '' ? baseTitle : entry.upload.filename,
          pageTexts: entry.extraction.pages.map((page) => page.text),
          sourceNote: input.sourceNote ?? '',
          usageScope: input.usageScope ?? '',
          sensitivity,
          originalFilename: entry.upload.filename,
        },
        now,
      )
      sources.push({ document, extraction: entry.extraction, reused: false })
    })

    let job = createImportJob(
      db,
      {
        ownerId: input.ownerId,
        projectId: input.projectId,
        subjectId: input.subjectId,
        inputKind: 'pdf_text',
        documents: sources.map((source) => source.document),
        extractorVersion: PDF_EXTRACTOR_VERSION,
      },
      now,
    )
    // The diagnosis is stored *before* any candidate is created: the candidate's blocking layout
    // issues are derived from it, so the guard cannot depend on a later write that might not happen.
    job = updateRow(
      db,
      'ingestion_import_job',
      job.id,
      {
        status: 'processing',
        started_at: now,
        page_diagnostics: collectPageDiagnostics(sources),
      },
      { now },
    )!

    const revision = preparePaperRevision(db, {
      ownerId: input.ownerId,
      projectId: input.projectId,
      job,
      subjectId: input.subjectId,
      cycleKey: input.cycleKey ?? '',
      sessionKey: input.sessionKey ?? '',
      paperCode: input.paperCode ?? '',
      sourceKind: input.sourceKind ?? 'official_past',
      expectedSessionCount: input.expectedSessionCount ?? null,
      coveredSessionCount: input.expectedSessionCount ? input.paperFiles.length : null,
      title: input.paperTitle !== undefined && input.paperTitle !== '' ? input.paperTitle : (input.title ?? ''),
      now,
    })

    const answers = collectAnswerEntries(sources.slice(input.paperFiles.length))
    const segmentsBySource = parsePaperSources(sources.slice(0, input.paperFiles.length))
    const created = createPdfCandidates(db, {
      job,
      segmentsBySource,
      answers,
      subjectId: input.subjectId,
      revision,
      now,
    })
    linkMaterialParents(db, created, now)
    if (revision !== null) job = annotatePaperDuplicates(db, job, created, now)
    job = reportJobProblems(db, job, {
      sources,
      emptyPages: collectEmptyPages(sources),
      createdCount: created.length,
      answers,
      matchCounts: created.matchCounts,
      segmentsBySource,
      now,
    })
    return maybeCompleteJob(db, getRow(db, 'ingestion_import_job', job.id)!, now)
  })
}

/** `_parse_paper_sources`: parse each paper PDF independently, keeping page offsets per document. */
function parsePaperSources(sources: SourceFile[]): Array<{ source: SourceFile; segments: ParsedSegment[] }> {
  return sources.map((source) => {
    const text = source.extraction.text
    const map = source.extraction.pageMap()
    const segments = parsePaste(text, { structureOnly: true })
    attachSourcePages(segments, text, map)
    // Per-page spans (a question may occupy two pages), the confirmed page-break joins, and the
    // geometry of each span.
    attachCrossPageContinua(
      segments,
      text,
      map,
      detectPageContinuations(source.extraction.pages.map((page) => ({ page_index: page.pageIndex, text: page.text }))),
    )
    attachSourceGeometry(segments, source.extraction)
    for (const segment of segments) if (segment.parse_issues === undefined) segment.parse_issues = []
    return { source, segments }
  })
}

/**
 * `_attach_source_geometry`: give every segment span a locatable box, when geometry exists.
 *
 * The box is the union of the fragments that produced the stem on the page the question starts on,
 * and of the fragments that produced each continuation span on the pages it runs onto. When the page
 * has no usable geometry the span keeps `bbox = null` and the region falls back to the whole page.
 */
function attachSourceGeometry(segments: ParsedSegment[], extraction: PdfExtraction): void {
  const pagesByIndex = new Map(extraction.pages.map((page) => [page.pageIndex, page]))
  for (const segment of segments) {
    const stem = String(segment.source_excerpt ?? '')
    const spans = (segment.source_spans as Array<Record<string, unknown>> | undefined) ?? []
    spans.forEach((span, position) => {
      const page = pagesByIndex.get(Number(span['page_index'] ?? 0))
      if (page === undefined) return
      // On the starting page the stem itself is the anchor; on a continuation page the stem is not
      // printed there, so the span's own wording is what the fragments are matched against.
      const needle = position === 0 ? stem : String(span['text'] ?? '')
      span['bbox'] = bboxForText(page, needle)
    })
  }
}

interface CreatedCandidates extends Array<{ candidate: Row; segment: ParsedSegment }> {
  matchCounts: { matched: number; position_matched: number }
}

/** `_unique_position_key`: the display label, with `#2`, `#3`… for a repeated number, cut to 40. */
function uniquePositionKey(displayLabel: string, used: Set<string>, fallbackIndex: number): string {
  const base = pyStrip(displayLabel ?? '') || String(fallbackIndex)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}#${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return pyCodePointSlice(candidate, 0, 40)
}

/**
 * `_create_candidates`: one proofreading candidate per parsed question, with its page and position.
 *
 * Answers are re-matched against **all** answer entries for each paper independently (the consumed
 * set lives inside one `applyAnswerMatches` call), which is what lets two paper files share one
 * answer sheet without stealing each other's entries.
 */
function createPdfCandidates(
  db: DatabaseSync,
  options: {
    job: Row
    segmentsBySource: Array<{ source: SourceFile; segments: ParsedSegment[] }>
    answers: { entries: Array<Record<string, unknown>>; unparsed: string[] }
    subjectId: string | null
    revision: Row | null
    now: Instant
  },
): CreatedCandidates {
  const usedPositions = new Set<string>()
  let runningIndex = 0
  const created: Array<{ candidate: Row; segment: ParsedSegment }> = []
  const localIds = new Map<string, Row>()
  let matchedAnswers = 0
  let positionMatched = 0

  for (const { source, segments } of options.segmentsBySource) {
    const report = applyAnswerMatches(segments, options.answers.entries as never)
    segments.forEach((segment, index) => {
      runningIndex += 1
      const match = report.results[index] ?? {}
      const payload: Record<string, unknown> = { ...segment }
      let answerMatch: Record<string, unknown> = {}
      if (pyTruthy(match['matched'])) {
        matchedAnswers += 1
        if (match['method'] === 'position') positionMatched += 1
        // A matched answer is a proposal: the proofreader must confirm it before it can publish.
        payload['answer_payload'] = match['answer_payload']
        payload['answer_status_known'] = false
        const issues = Array.isArray(payload['parse_issues']) ? [...(payload['parse_issues'] as unknown[])] : []
        issues.push(
          `答案来自答案页匹配（方式：${match['method'] === 'label' ? '题号' : '顺序'}，` +
            `原文：${pyCodePointSlice(String(match['raw'] ?? ''), 0, 40)}），需人工确认`,
        )
        payload['parse_issues'] = issues
        answerMatch = {
          matched: true,
          method: match['method'],
          label: match['label'],
          raw: match['raw'],
          // The parser's success dict carries none of these three fields, so the persisted
          // `answer_match` has nulls here — Django's current behaviour, kept on purpose (04 §L).
          source_page_index: match['source_page_index'] ?? null,
          document_id: match['document_id'] ?? null,
          document_title: match['document_title'] ?? null,
        }
      }
      const regionIds = regionsForSegment(db, String(source.document.id), segment, options.now)
      const candidate = createCandidate(
        db,
        {
          job: options.job,
          payload,
          subjectId: options.subjectId,
          machinePayload: payload,
          regionIds,
          extractorVersion: PDF_EXTRACTOR_VERSION,
          sourcePositionKey: uniquePositionKey(String(segment.display_label ?? ''), usedPositions, runningIndex),
          paperRevisionId: options.revision === null ? null : String(options.revision.id),
          answerMatch,
        },
        options.now,
      )
      if (pyTruthy(segment.local_id)) localIds.set(String(segment.local_id), candidate)
      created.push({ candidate, segment })
    })
  }
  const result = created as CreatedCandidates
  result.matchCounts = { matched: matchedAnswers, position_matched: positionMatched }
  return result
}

/**
 * `_regions_for_segment`: one source region per page the question occupies.
 *
 * The first region is the page the question starts on and keeps the historic payload (the stem
 * excerpt); a continuation adds one region per further page, so a question split across a page break
 * is locatable on both pages while its position key still names the starting page.
 */
function regionsForSegment(db: DatabaseSync, documentId: string, segment: ParsedSegment, now: Instant): string[] {
  const excerpt = String(segment.source_excerpt ?? '')
  const rawSpans = segment.source_spans as Array<Record<string, unknown>> | undefined
  const spans =
    rawSpans !== undefined && rawSpans.length > 0
      ? rawSpans
      : [
          {
            page_index: Number(segment.source_page_index ?? 1),
            char_start: segment.source_char_start,
            char_end: segment.source_char_end,
            text: excerpt,
            bbox: segment.source_bbox,
          },
        ]
  const ids: string[] = []
  spans.forEach((span, position) => {
    const bbox = (span['bbox'] as Record<string, unknown> | null | undefined) ?? {}
    const textSpan = position === 0 ? excerpt : String(span['text'] ?? '')
    let region = createSourceRegion(
      db,
      {
        documentId,
        pageIndex: Math.trunc(Number(span['page_index'] ?? 1)) || 1,
        x: Number(bbox['x'] ?? 0.0),
        y: Number(bbox['y'] ?? 0.0),
        width: Number(bbox['width'] ?? 1.0),
        height: Number(bbox['height'] ?? 1.0),
        role: 'past_paper_page',
        textSpan: pyCodePointSlice(textSpan, 0, 2000),
      },
      now,
    )
    const charStart = span['char_start'] === undefined || span['char_start'] === null ? null : Math.trunc(Number(span['char_start']))
    const charEnd =
      span['char_end'] === undefined || span['char_end'] === null
        ? (charStart ?? 0) + pyCodePointLen(textSpan)
        : Math.trunc(Number(span['char_end']))
    region = updateRow(db, 'ingestion_source_region', region.id, { char_start: charStart, char_end: charEnd }, { now })!
    ids.push(String(region.id))
  })
  return ids
}

/** `_link_material_parents`: material parents/children come from the parsed structure, not retyping. */
function linkMaterialParents(
  db: DatabaseSync,
  created: Array<{ candidate: Row; segment: ParsedSegment }>,
  now: Instant,
): void {
  const localIds = new Map<string, Row>()
  for (const { candidate, segment } of created) {
    if (pyTruthy(segment.local_id)) localIds.set(String(segment.local_id), candidate)
  }
  for (const { candidate, segment } of created) {
    const parentLocal = segment.parent_local_id
    if (!pyTruthy(parentLocal)) continue
    const parent = localIds.get(String(parentLocal))
    if (parent === undefined) continue
    const updated = updateRow(db, 'ingestion_import_candidate', candidate.id, { parent_candidate_id: parent.id }, { now })!
    refreshCandidateIssues(db, updated, now)
  }
}

/**
 * `_collect_page_diagnostics`: per-page layout diagnosis of every uploaded PDF, tagged with its
 * document. The document id is what lets a candidate be blocked by the page it actually came from
 * instead of by the whole job: a scanned page in file A must not stop a clean page in file B.
 */
function collectPageDiagnostics(sources: SourceFile[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const source of sources) {
    for (const row of source.extraction.pageDiagnostics) {
      rows.push({
        ...row,
        document_id: String(source.document.id),
        document_title: source.document.title,
      })
      if (rows.length >= MAX_JOB_PAGE_DIAGNOSTICS) return rows
    }
  }
  return rows
}

function pageLabels(rows: Array<Record<string, unknown>>, limit = 5): string {
  return rows
    .slice(0, limit)
    .map((row) => `${pyTruthy(row['document_title']) ? String(row['document_title']) : 'PDF'} 第 ${String(row['page_index'])} 页`)
    .join('; ')
}

/** Python `str(list)` for the page numbers in one problem message. */
function pyListRepr(values: readonly number[]): string {
  return `[${values.map((value) => String(value)).join(', ')}]`
}

function collectEmptyPages(sources: SourceFile[]): Array<Record<string, unknown>> {
  const report: Array<Record<string, unknown>> = []
  for (const source of sources) {
    if (source.extraction.emptyPages.length === 0) continue
    report.push({
      document_id: String(source.document.id),
      title: source.document.title,
      pages: source.extraction.emptyPages,
    })
  }
  return report
}

/** `_collect_answer_entries`: parse answer PDFs page by page so every matched answer keeps its page. */
function collectAnswerEntries(answerSources: SourceFile[]): {
  entries: Array<Record<string, unknown>>
  unparsed: string[]
} {
  const entries: Array<Record<string, unknown>> = []
  const unparsed: string[] = []
  for (const source of answerSources) {
    for (const page of source.extraction.pages) {
      const parsed = parseAnswerPage(page.text)
      for (const entry of parsed.entries) {
        entries.push({
          ...entry,
          source_page_index: page.pageIndex,
          document_id: String(source.document.id),
          document_title: source.document.title,
        })
      }
      unparsed.push(...parsed.unparsed)
    }
  }
  return { entries, unparsed: unparsed.slice(0, 50) }
}

function unmatchedAnswerLabels(
  segmentsBySource: Array<{ source: SourceFile; segments: ParsedSegment[] }>,
  answers: { entries: Array<Record<string, unknown>> },
): string[] {
  const labels = new Set<string>()
  for (const { segments } of segmentsBySource) for (const segment of segments) labels.add(String(segment.display_label))
  return answers.entries
    .filter((entry) => !labels.has(String(entry['label'])))
    .map((entry) => String(entry['label']))
    .slice(0, 50)
}

/**
 * `_prepare_paper_revision`: register/lookup the paper occurrence and open one draft revision.
 *
 * Only when the subject **and** both natural-key parts are non-empty: a paper without a 卷别代码
 * cannot enter the historical statistics, and inventing one would fabricate an official record.
 */
function preparePaperRevision(
  db: DatabaseSync,
  options: {
    ownerId: string
    projectId: string
    job: Row
    subjectId: string | null
    cycleKey: string
    sessionKey: string
    paperCode: string
    sourceKind: string
    expectedSessionCount: number | null
    coveredSessionCount: number | null
    title: string
    now: Instant
  },
): Row | null {
  if (options.subjectId === null || pyStrip(options.cycleKey) === '' || pyStrip(options.paperCode) === '') return null
  const { paper } = getOrCreatePaperForImport(
    db,
    {
      subjectId: options.subjectId,
      projectId: options.projectId,
      cycleKey: options.cycleKey,
      sessionKey: options.sessionKey,
      paperCode: options.paperCode,
      sourceKind: options.sourceKind,
      title: options.title,
      actorId: options.ownerId,
    },
    options.now,
  )
  return createPaperRevisionForImport(
    db,
    paper,
    {
      expectedSessionCount: options.expectedSessionCount,
      coveredSessionCount: options.coveredSessionCount,
      note: `由原生文字 PDF 导入创建（导入任务 ${String(options.job.id)}）`,
      actorId: options.ownerId,
      projectId: options.projectId,
    },
    options.now,
  )
}

/** `_annotate_paper_duplicates`: block publishing a position an earlier revision already published. */
function annotatePaperDuplicates(
  db: DatabaseSync,
  job: Row,
  created: Array<{ candidate: Row; segment: ParsedSegment }>,
  now: Instant,
): Row {
  let duplicates = 0
  for (const { candidate } of created) {
    const issues = refreshCandidateIssues(db, getRow(db, 'ingestion_import_candidate', candidate.id)!, now)
    if (issues.some((issue) => issue.code === 'duplicate_paper_position')) duplicates += 1
  }
  if (duplicates === 0) return job
  return addJobProblem(
    db,
    job,
    {
      code: 'duplicate_paper_positions',
      message:
        `${duplicates} 个题号在该试卷的历史版本中已经发布过，已在候选上标为阻断项；` +
        '重复导入不会再次发布（如需修订请在题库中创建新版本）。',
      severity: 'warning',
      extra: { count: duplicates },
    },
    now,
  )
}

/**
 * `_report_job_problems`: every automatic step that a human has to know about, in plain language.
 *
 * The layout problems use the **same** codes as the blocking candidate issues, so the job payload
 * and the candidate list cannot drift apart: a page reported here is exactly a page whose candidates
 * stay blocked until the layout is confirmed.
 */
function reportJobProblems(
  db: DatabaseSync,
  job: Row,
  options: {
    sources: SourceFile[]
    emptyPages: Array<Record<string, unknown>>
    createdCount: number
    answers: { entries: Array<Record<string, unknown>>; unparsed: string[] }
    matchCounts: { matched: number; position_matched: number }
    segmentsBySource: Array<{ source: SourceFile; segments: ParsedSegment[] }>
    now: Instant
  },
): Row {
  let current = job
  const reused = options.sources.filter((source) => source.reused).length
  if (reused > 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: 'duplicate_source_file',
        message:
          `其中 ${reused} 份 PDF 与已有来源文件完全相同，已复用原来源而未新增副本` +
          '（避免同一试卷被重复计入）。',
        severity: 'warning',
      },
      options.now,
    )
  }
  if (options.emptyPages.length > 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: 'pdf_pages_without_text',
        message:
          '以下页面没有文字层（可能是插图页或扫描页），需要人工补齐：' +
          options.emptyPages
            .slice(0, 5)
            .map((item) => `${String(item['title'])} 第 ${pyListRepr(item['pages'] as number[])} 页`)
            .join('; '),
        severity: 'warning',
        extra: { pages: options.emptyPages.slice(0, 20) },
      },
      options.now,
    )
  }
  current = reportLayoutProblems(db, current, (current.page_diagnostics as Array<Record<string, unknown>>) ?? [], options.now)

  const matched = Number(options.matchCounts.matched ?? 0)
  const positionMatched = Number(options.matchCounts.position_matched ?? 0)
  if (matched > 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: 'answers_matched',
        message:
          `已从答案页匹配 ${matched} 条答案（其中 ${positionMatched} 条按顺序匹配），` +
          '都只是候选，必须逐条人工确认后才能发布。',
        severity: positionMatched === 0 ? 'info' : 'warning',
        extra: {
          matched,
          position_matched: positionMatched,
          unmatched_labels: unmatchedAnswerLabels(options.segmentsBySource, options.answers),
        },
      },
      options.now,
    )
  }
  if (options.answers.entries.length > 0 && matched === 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: 'answers_not_matched',
        message: '答案页已解析出条目，但没有任何一条能匹配到题目；请在校对页手工填写。',
        severity: 'warning',
      },
      options.now,
    )
  }
  if (options.createdCount === 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: 'no_recognised_segment',
        message:
          '未能从 PDF 文本层识别出题目结构：请确认使用的是原生文字 PDF，' +
          '并在校对页按【题型】【题干】【选项】【答案】模板补录。',
        severity: 'warning',
      },
      options.now,
    )
  }
  return current
}

function reportLayoutProblems(
  db: DatabaseSync,
  job: Row,
  pageDiagnostics: Array<Record<string, unknown>>,
  now: Instant,
): Row {
  let current = job
  const reasonsByPage = pageDiagnostics.map((row) => ({ row, reasons: new Set<string>((row['reasons'] as string[]) ?? []) }))
  const scanned = reasonsByPage.filter((entry) => entry.reasons.has(REASON_SCANNED)).map((entry) => entry.row)
  if (scanned.length > 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: ISSUE_SCANNED,
        message:
          '以下页面没有文字层（扫描件/图片页）：本功能不做 OCR、不猜测内容，这些页面不会被自动结构化；' +
          '请按原页人工录入，或改走图片导入的人工校对路径：' + pageLabels(scanned),
        severity: 'warning',
        extra: { pages: scanned.slice(0, 20) },
      },
      now,
    )
  }
  const multiColumn = reasonsByPage
    .filter((entry) => entry.reasons.has(REASON_MULTI_COLUMN) || entry.reasons.has(REASON_COLUMN_ORDER_AMBIGUOUS))
    .map((entry) => entry.row)
  if (multiColumn.length > 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: ISSUE_MULTI_COLUMN,
        message:
          `${multiColumn.length} 页为多栏版式：栏内顺序无法完全确定时已保留提取顺序而未强行重排，` +
          '相关候选必须人工确认版式后才能发布：' + pageLabels(multiColumn),
        severity: 'warning',
        extra: { pages: multiColumn.slice(0, 20) },
      },
      now,
    )
  }
  const tableOrFormula = reasonsByPage
    .filter((entry) => entry.reasons.has(REASON_TABLE_GRID) || entry.reasons.has(REASON_FORMULA))
    .map((entry) => entry.row)
  if (tableOrFormula.length > 0) {
    current = addJobProblem(
      db,
      current,
      {
        code: ISSUE_TABLE_FORMULA,
        message:
          `${tableOrFormula.length} 页含表格网格或公式符号：文本提取会改变版式，` +
          '公式按原样保留、不做“纠正”，相关候选必须逐字人工确认后才能发布：' + pageLabels(tableOrFormula),
        severity: 'warning',
        extra: { pages: tableOrFormula.slice(0, 20) },
      },
      now,
    )
  }
  return current
}
