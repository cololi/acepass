/**
 * Private sources: assets, image documents and PDF documents — port of `store_asset` /
 * `create_image_document` / `create_pdf_document` / `find_duplicate_document`
 * (`backend/apps/ingestion/services/core.py`).
 *
 * **Why the image work is hoisted out of the transaction.** Django's `store_asset` is
 * `@transaction.atomic` and calls `validate_image` + `strip_metadata` inside it, because Pillow is
 * synchronous. Here the decoder is `sharp`, whose API is promise-based, and `store/db.ts`'s
 * `transaction()` runs its callback synchronously on purpose (`BEGIN IMMEDIATE` + `COMMIT` around a
 * sync function; a returned promise would commit before the work finished — 06 §0.1). So the split
 * is:
 *
 *   1. `prepareAssetImage()` — async, no database access: validate, then re-encode;
 *   2. `storeAsset()` — sync, inside the caller's transaction: role/sensitivity/subject checks, key,
 *      file write, row insert.
 *
 * That is behaviour-preserving: the async phase is a pure function of the uploaded bytes, and the
 * order of the *checks* is kept by running the synchronous field checks in `storeAsset()` — which
 * Django also runs before it touches the image. The only observable consequence is that a request
 * which is wrong in two ways reports the same error Django reports, because the field checks and the
 * image checks are still ordered role → sensitivity → subject → MIME → size → decode.
 *
 * A re-encode failure is **not** an error: Django keeps the original bytes ("record it" is a comment
 * with no write behind it), and so does this port (`reencoded: false`).
 */
import type { DatabaseSync } from 'node:sqlite'

import { pyCodePointSlice } from '../domain/ingestion/pystring.ts'
import type { Instant } from '../domain/instant.ts'
import { insertRow, findRows, getRow, type Row } from '../store/repository.ts'
import { buildKey, getStorage } from '../ingestion/storage.ts'
import { stripMetadata, validateImage } from '../ingestion/images.ts'
import { InvalidInput, ScopeViolation } from './errors.ts'

/** `AssetRole` values (`apps/common/enums.py`). */
export const ASSET_ROLES: readonly string[] = [
  'past_paper_page',
  'answer_page',
  'stem_crop',
  'material_crop',
  'answer_crop',
  'user_attachment',
  'other',
]

/** `AssetSensitivity` values. */
export const ASSET_SENSITIVITIES: readonly string[] = ['public_to_owner', 'contains_answers', 'internal_review']

const REGION_ROLES = new Set(['stem_crop', 'material_crop', 'answer_crop'])
const SOURCE_ROLES = new Set(['past_paper_page', 'answer_page'])

/**
 * The key namespace for a role.
 *
 * `region` holds crops (they are derived from a page and are the ones that get re-cut), `source`
 * holds whole uploaded pages, and everything else — including a learner's own attachment — lands in
 * `uploads`. Keeping crops and sources in different prefixes means an operator can move or expire one
 * class without touching the other.
 */
export function assetNamespace(role: string): string {
  if (REGION_ROLES.has(role)) return 'region'
  if (SOURCE_ROLES.has(role)) return 'source'
  return 'uploads'
}

/** The key suffix for a content type; anything unrecognised is stored as `.bin`. */
export function assetSuffix(contentType: string): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  }
  return known[contentType] ?? 'bin'
}

export interface PreparedImage {
  /** The bytes that will be stored (re-encoded, or the original when the re-encode failed). */
  payload: Uint8Array
  width: number
  height: number
  reencoded: boolean
  format: string
}

/**
 * Validate an upload and strip its metadata, before any transaction opens.
 *
 * `reencode: false` is the PDF path's shape (PDFs are never re-encoded); images always validate, and
 * only the re-encode is skipped when the caller says so.
 */
export async function prepareAssetImage(options: {
  bytes: Uint8Array
  contentType: string
  reencode?: boolean
}): Promise<PreparedImage> {
  const facts = await validateImage({ bytes: options.bytes, contentType: options.contentType })
  if (options.reencode === false) {
    return { payload: options.bytes, width: facts.width, height: facts.height, reencoded: false, format: facts.detected }
  }
  const stripped = await stripMetadata(options.bytes)
  return {
    payload: stripped.bytes,
    width: facts.width,
    height: facts.height,
    reencoded: stripped.reencoded,
    format: stripped.format,
  }
}

export interface StoreAssetInput {
  ownerId: string
  projectId: string
  /** The bytes to persist. For an image this must be `prepared.payload`. */
  content: Uint8Array
  contentType: string
  role?: string
  sensitivity?: string
  subjectId?: string | null
  originalFilename?: string
  sourceDocumentId?: string | null
  /** Required when `contentType` starts with `image/`; see the module docstring. */
  prepared?: PreparedImage | null
}

/**
 * The three field checks `store_asset` performs before it touches the bytes.
 *
 * Exposed separately because the route has to run them **before** the asynchronous image
 * preparation: Django validates role → sensitivity → subject and only then decodes the image, so a
 * request with both a bad role and a corrupt file must report the role. Calling this first keeps
 * that order while the decode stays outside the transaction.
 */
export function assertAssetFields(
  db: DatabaseSync,
  options: { projectId: string; role: string; sensitivity: string; subjectId?: string | null },
): void {
  if (!ASSET_ROLES.includes(options.role)) throw new InvalidInput('资产角色无效', { details: { role: options.role } })
  if (!ASSET_SENSITIVITIES.includes(options.sensitivity)) throw new InvalidInput('资产敏感级别无效')
  if (options.subjectId !== null && options.subjectId !== undefined) {
    const subject = getRow(db, 'exams_subject', options.subjectId)
    if (subject === null || String(subject.project_id) !== String(options.projectId)) {
      throw new ScopeViolation('科目不属于该项目')
    }
  }
}

/**
 * Persist private bytes under a server-generated key, then insert the `Asset` row.
 *
 * `object_key` never contains the original filename, and the row stores the size and SHA-256 of the
 * bytes that were actually written — not of the upload. For an image those differ (the re-encode
 * changes both), which is exactly why `Asset.checksum` cannot be used to detect "same original file
 * uploaded twice" (04 §K, and the `dedupe` golden vectors).
 */
export function storeAsset(db: DatabaseSync, input: StoreAssetInput, now: Instant): Row {
  const role = input.role ?? 'other'
  const sensitivity = input.sensitivity ?? 'public_to_owner'
  assertAssetFields(db, {
    projectId: input.projectId,
    role,
    sensitivity,
    subjectId: input.subjectId ?? null,
  })

  let width: number | null = null
  let height: number | null = null
  let payload = input.content
  if (input.contentType.startsWith('image/')) {
    const prepared = input.prepared
    if (prepared === null || prepared === undefined) {
      throw new Error('storeAsset: image bytes must be prepared before the transaction (validate + re-encode are async)')
    }
    width = prepared.width
    height = prepared.height
    payload = prepared.payload
  }

  const namespace = `${input.ownerId}/${input.projectId}/${assetNamespace(role)}`
  const key = buildKey(namespace, assetSuffix(input.contentType))
  const stored = getStorage().save(key, payload)
  return insertRow(
    db,
    'ingestion_asset',
    {
      owner_id: input.ownerId,
      project_id: input.projectId,
      subject_id: input.subjectId ?? null,
      role,
      sensitivity,
      object_key: stored.key,
      original_filename: pyCodePointSlice(input.originalFilename ?? '', 0, 255),
      content_type: input.contentType,
      size_bytes: stored.size,
      checksum: stored.checksum,
      width,
      height,
      source_document_id: input.sourceDocumentId ?? null,
      uploaded_by_id: input.ownerId,
      is_retained: true,
    },
    { now },
  )
}

export interface ImageDocumentInput {
  ownerId: string
  projectId: string
  subjectId?: string | null
  /**
   * The prepared image, or `null` for a non-image MIME type.
   *
   * A non-image upload through the image-source endpoint is a **current Django behaviour**, not a
   * bug this port may fix silently: `create_image_document` stores the bytes under
   * `document_type=image` without validating them, because `store_asset` only validates when
   * `content_type` starts with `image/` (probe P44). The document then lies about being an image.
   */
  prepared: PreparedImage | null
  /** The raw upload; used verbatim when `prepared` is `null`. */
  content: Uint8Array
  contentType: string
  role?: string
  title?: string
  sourceNote?: string
  usageScope?: string
  sensitivity?: string
  originalFilename?: string
}

/**
 * `create_image_document`: store the bytes, then create the `SourceDocument` that points at them.
 *
 * The document's `checksum` is the **asset's** checksum (the stored bytes), not the upload's — that
 * asymmetry is what makes a second upload of the same original miss the duplicate lookup.
 */
export function createImageDocument(db: DatabaseSync, input: ImageDocumentInput, now: Instant): Row {
  const role = input.role ?? 'past_paper_page'
  const sensitivity = input.sensitivity ?? 'public_to_owner'
  const asset = storeAsset(
    db,
    {
      ownerId: input.ownerId,
      projectId: input.projectId,
      content: input.prepared === null ? input.content : input.prepared.payload,
      contentType: input.contentType,
      role,
      sensitivity,
      subjectId: input.subjectId ?? null,
      originalFilename: input.originalFilename ?? '',
      prepared: input.prepared,
    },
    now,
  )
  return insertRow(
    db,
    'ingestion_source_document',
    {
      owner_id: input.ownerId,
      project_id: input.projectId,
      subject_id: input.subjectId ?? null,
      title: pyCodePointSlice(input.title ?? '', 0, 300),
      document_type: 'image',
      role,
      sensitivity,
      asset_id: asset.id,
      raw_text: '',
      page_texts: [],
      checksum: asset.checksum,
      source_type: 'user_upload',
      source_note: pyCodePointSlice(input.sourceNote ?? '', 0, 500),
      usage_scope: pyCodePointSlice(input.usageScope ?? '', 0, 200),
      page_count: 1,
    },
    { now },
  )
}

/**
 * `find_duplicate_document`: the earliest non-text document in this project with the same checksum.
 *
 * Text documents are excluded because their checksum is a hash of the pasted text, which has no
 * relationship to a file's bytes. Ordering is `created_at` ascending, so the *original* source wins
 * over a later copy — the reuse then points the new import at the first upload, not at the most
 * recent one.
 */
export function findDuplicateDocument(db: DatabaseSync, options: { projectId: string; checksum: string }): Row | null {
  const rows = findRows(
    db,
    'ingestion_source_document',
    { project_id: options.projectId, checksum: options.checksum },
    { orderBy: [['created_at', 'asc']] },
  )
  return rows.find((row) => row.document_type !== 'text') ?? null
}

export interface PdfDocumentInput {
  ownerId: string
  projectId: string
  subjectId?: string | null
  /** The original upload; PDFs are never re-encoded, so the stored bytes are the upload's bytes. */
  content: Uint8Array
  role?: string
  title?: string
  pageTexts: readonly string[]
  sourceNote?: string
  usageScope?: string
  sensitivity?: string
  originalFilename?: string
}

/**
 * `create_pdf_document`: store one native-text PDF plus its per-page text layer.
 *
 * The original bytes and the extracted text are kept together: the text layer is what the parser
 * reads, and the file is what a proofreader opens to check it. Neither replaces the other. Unlike
 * the image path there is **no re-encode**, so `Asset.checksum` is the SHA-256 of the uploaded bytes
 * and the duplicate lookup is exact (06 §5.1) — that asymmetry with images is the reason a PDF can
 * be de-duplicated reliably while a PNG cannot.
 *
 * `page_count` is `max(1, len(page_texts))`: a one-page PDF whose text layer is empty still counts as
 * one page, which keeps the "page 1 exists" invariant the region model relies on.
 */
export function createPdfDocument(db: DatabaseSync, input: PdfDocumentInput, now: Instant): Row {
  const role = input.role ?? 'past_paper_page'
  const sensitivity = input.sensitivity ?? 'public_to_owner'
  const pages = [...input.pageTexts]
  const asset = storeAsset(
    db,
    {
      ownerId: input.ownerId,
      projectId: input.projectId,
      content: input.content,
      contentType: 'application/pdf',
      role,
      sensitivity,
      subjectId: input.subjectId ?? null,
      originalFilename: input.originalFilename ?? '',
    },
    now,
  )
  return insertRow(
    db,
    'ingestion_source_document',
    {
      owner_id: input.ownerId,
      project_id: input.projectId,
      subject_id: input.subjectId ?? null,
      title: pyCodePointSlice(input.title ?? '', 0, 300),
      document_type: role === 'answer_page' ? 'pdf_answer' : 'pdf',
      role,
      sensitivity,
      asset_id: asset.id,
      raw_text: pages.join('\n'),
      page_texts: pages,
      checksum: asset.checksum,
      source_type: 'user_upload',
      source_note: pyCodePointSlice(input.sourceNote ?? '', 0, 500),
      usage_scope: pyCodePointSlice(input.usageScope ?? '', 0, 200),
      page_count: Math.max(1, pages.length),
    },
    { now },
  )
}
