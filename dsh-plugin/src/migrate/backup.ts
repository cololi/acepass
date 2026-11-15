/**
 * Online backup and restore for a `.acepass` SQLite store.
 *
 * Why this is not `cp acepass.sqlite backup.sqlite`: a live store runs in WAL mode, so the committed
 * state is split between the main file and the `-wal` file. Copying the main file alone silently
 * loses the newest transactions, and copying it while a writer is active can capture a torn page.
 * The backup therefore goes through SQLite itself: `VACUUM INTO` takes one consistent read snapshot
 * while other connections keep writing (the online backup API restarts whenever another connection
 * commits, which a busy store can postpone indefinitely — see `docs/dsh-migration/18-*.md` §2.1).
 *
 * The artifact is a directory, not a file:
 *
 *     <dest>/
 *       acepass.sqlite    a single-file, DELETE-journal snapshot (no -wal/-shm)
 *       manifest.json     sha256, byte size, schema version, per-table row counts and digests,
 *                         optional media file list, optional HMAC-SHA256 signature
 *       media/            only with `--include-media`: a byte-identical copy of the private media
 *                         tree, one `{path, bytes, sha256}` entry per file in the manifest
 *
 * A backup is written into `<dest>.partial-<pid>` and renamed into place only after the snapshot has
 * been re-opened, integrity-checked and digested. A kill at any point therefore leaves either the
 * previous backup or no backup at all — never a half-written one. Stale partials from a killed run
 * are removed on the next run when their owning pid is gone.
 *
 * Restore is deliberately conservative: the backup is verified first, a non-empty target is refused
 * unless `--force`, the current target is snapshotted into `<target>.pre-restore-<ts>/` before it is
 * replaced, and the restored file is verified again. Any failure after the replacement rolls the
 * safety copy back. The restore contract is **offline**: stop the DSH app before restoring.
 *
 * Optional extras (all inert unless asked for):
 *
 *  - `--include-media` archives `<dataRoot>/private-media` into `<backup>/media/` and records one
 *    `{path, bytes, sha256}` entry per file in `manifest.json`, so `db:verify` can prove the archived
 *    bytes are the ones that were backed up. Media are hashed and copied one file at a time: a file
 *    that changed between the two reads is refused (`media_changed_during_backup`) rather than
 *    silently archived in a torn state. Symlinks and special files are refused — following a link
 *    could pull arbitrary files from outside the media root into a backup.
 *  - `--restore-media` puts them back. Existing files are never overwritten without `--force`; an
 *    overwrite first copies the old bytes to `<mediaRoot>.pre-restore-<ts>/`, and any failure while
 *    applying rolls the whole media tree back. Files in the target that the backup does not mention
 *    are left alone: a restore must not delete data it does not know about.
 *  - `--keep N` rotates the backups directory. Only directories that identify themselves as this
 *    tool's output (their `manifest.json` names `@acepass/dsh-plugin`) are candidates; anything else
 *    is listed and skipped.
 *  - `--sign-key <path>` / `ACEPASS_BACKUP_SIGNING_KEY` add `manifest.signature`, an HMAC-SHA256 over
 *    a canonical (key-sorted) rendering of the manifest without the signature field. A signed backup
 *    requires the key to verify; a key configured against an unsigned backup is refused, so the
 *    signature cannot be dropped by an attacker. The key never enters the manifest, the logs or any
 *    error message.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, TABLES } from '../store/schema.generated.ts'
import { schemaVersionOf, tableNames } from '../store/db.ts'
import { tableDigest, tableDigestFromDatabase } from './archive.ts'

/**
 * Still `1`: media entries and the signature are additive optional fields, so a manifest written by
 * B9 (or by this build without the new flags) verifies unchanged, and older artifacts stay readable.
 */
export const BACKUP_FORMAT_VERSION = 1
export const SNAPSHOT_FILE = 'acepass.sqlite'
export const MANIFEST_FILE = 'manifest.json'
/** The tool identity written into `manifest.tool.name` and used to recognise our own backup dirs. */
export const BACKUP_TOOL_NAME = '@acepass/dsh-plugin'
/** Sub-directory of a backup that holds the archived media tree. */
export const MEDIA_DIR_IN_BACKUP = 'media'
/** `<dataRoot>/private-media` — the same layout `src/ingestion/storage.ts::mediaRootFor` uses. */
export const MEDIA_DIR_NAME = 'private-media'
export const SIGNATURE_ALGORITHM = 'hmac-sha256'
/** A signing key shorter than this is refused: an HMAC over a 4-character secret is theatre. */
export const MIN_SIGNING_KEY_BYTES = 16
export const SIGNING_KEY_ENV = 'ACEPASS_BACKUP_SIGNING_KEY'
export const SIGNING_KEY_FILE_ENV = 'ACEPASS_BACKUP_SIGNING_KEY_FILE'
const META_TABLE = '_acepass_meta'

export type FailureKind = 'refused' | 'verification' | 'io'

/** A backup/restore failure an operator can act on. `kind` maps onto the CLI exit code. */
export class BackupFailure extends Error {
  readonly code: string
  readonly kind: FailureKind
  readonly details: Record<string, unknown>

  constructor(code: string, kind: FailureKind, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'BackupFailure'
    this.code = code
    this.kind = kind
    this.details = details
  }
}

export interface BackupManifestTable {
  name: string
  rows: number
  digest: string
}

/** One archived media object, addressed by its path relative to the media root (always POSIX). */
export interface MediaFileEntry {
  path: string
  bytes: number
  sha256: string
}

/**
 * `included:false` is what a database-only backup records (and what B9 wrote): the media tree is not
 * in the artifact. The richer fields only exist when `included:true`, which keeps a database-only
 * manifest byte-identical to the B9 format.
 */
export interface BackupManifestMedia {
  root: string
  included: boolean
  /** Directory inside the backup that mirrors the media tree (only when `included`). */
  dest?: string
  file_count?: number
  total_bytes?: number
  files?: MediaFileEntry[]
}

export interface BackupManifestSignature {
  algorithm: string
  digest: string
}

export interface BackupManifest {
  format_version: number
  created_at: string
  source: { path: string; bytes: number; schema_version: number; tables: number; rows: number }
  snapshot: { file: string; bytes: number; sha256: string; pages: number }
  integrity: { check: 'ok'; foreign_key_violations: number; schema_version: number; tables: number }
  tables: BackupManifestTable[]
  total_rows: number
  media: BackupManifestMedia
  tool: { name: string; node: string; sqlite: string }
  /** Present only for a signed backup; covers every other field of this manifest. */
  signature?: BackupManifestSignature
}

export interface SnapshotInspection {
  schema_version: number
  tables: BackupManifestTable[]
  total_rows: number
  foreign_key_violations: number
  unknown_tables: string[]
  sqlite_version: string
  bytes: number
  pages: number
}

export type BackupStage = 'started' | 'snapshot' | 'media' | 'verified' | 'manifest' | 'committed'
export type RestoreStage =
  | 'validated'
  | 'safety-copy'
  | 'copied'
  | 'renamed'
  | 'verified'
  | 'committed'
  | 'rolled-back'
  | `media:${MediaRestoreStage}`
export type MediaRestoreStage =
  | 'verified'
  | 'planned'
  | 'staged'
  | 'safety-copy'
  | 'applied'
  | 'checked'
  | 'rolled-back'

export interface MediaVerification {
  included: true
  dest: string
  file_count: number
  total_bytes: number
  files: MediaFileEntry[]
}

export interface BackupOptions {
  sourcePath: string
  /** Defaults to `<source dir>/backups/<name>-<UTC timestamp>`. */
  destDir?: string
  force?: boolean
  now?: Date
  /** Archive `<dataRoot>/private-media` (or `mediaRoot`) into the backup. */
  includeMedia?: boolean
  /** Media root override; defaults to `dirname(sourcePath)/private-media`. Needs `includeMedia`. */
  mediaRoot?: string
  /** HMAC-SHA256 key; when present the manifest is signed. */
  signingKey?: Buffer | string | null
  /** Test/operator hook; a crash drill kills the process at a named stage. */
  onStage?: (stage: BackupStage) => void
}

export interface BackupResult {
  destDir: string
  manifest: BackupManifest
  warnings: string[]
}

export interface RestoreOptions {
  backupDir: string
  targetPath: string
  force?: boolean
  now?: Date
  /** Put the archived media tree back under `mediaRoot` (implies nothing about the database). */
  restoreMedia?: boolean
  /** Media root override; defaults to `dirname(targetPath)/private-media`. Needs `restoreMedia`. */
  mediaRoot?: string
  /** Key used to check `manifest.signature`; required when the backup carries one. */
  signingKey?: Buffer | string | null
  onStage?: (stage: RestoreStage) => void
}

export interface RestoreResult {
  targetPath: string
  backupDir: string
  manifest: BackupManifest
  safetyCopy: string | null
  /** `null` unless `restoreMedia` was requested. */
  media: MediaRestoreResult | null
  warnings: string[]
}

export interface VerifyOptions {
  /** Key used to check `manifest.signature`; required when the backup carries one. */
  signingKey?: Buffer | string | null
}

export interface MediaRestoreOptions {
  backupDir: string
  mediaRoot: string
  force?: boolean
  now?: Date
  /** An already-verified manifest; when omitted the backup directory is verified first. */
  manifest?: BackupManifest
  onStage?: (stage: MediaRestoreStage) => void
}

export interface MediaRestoreResult {
  mediaRoot: string
  /** Files newly created in the media root. */
  restored: number
  /** Files that already existed with different content and were replaced (needs `--force`). */
  overwritten: number
  /** Files that already existed with identical content; left untouched. */
  unchanged: number
  bytes: number
  /** Directory holding the pre-restore bytes of every overwritten file. */
  safetyDir: string | null
  warnings: string[]
}

export interface RotationOptions {
  /** The directory that holds backup directories (the parent of `--out`). */
  directory: string
  keep: number
  /** Directories never deleted (the backup this run just wrote). */
  protect?: string[]
  /** List the plan without deleting anything. */
  dryRun?: boolean
}

export interface RotationIdentity {
  dir: string
  name: string
  created_at: string
  tool: string
  format_version: number
  rows: number
  bytes: number
}

export interface RotationResult {
  directory: string
  keep: number
  kept: string[]
  deleted: string[]
  /** Directories that were never candidates, with the reason (not ours / unreadable). */
  skipped: { path: string; reason: string }[]
  failed: { path: string; error: string }[]
  dry_run: boolean
}


export interface DatabasePathOptions {
  db?: string | null
  dataRoot?: string | null
  cwd?: string
  env?: Record<string, string | undefined>
}

/**
 * Resolve the store path the CLI operates on: explicit `--db`, then `--data-root`, then
 * `ACEPASS_DB`, then `ACEPASS_DATA_ROOT`, then `<cwd>/.acepass/acepass.sqlite` (the plugin default).
 */
export function resolveDatabasePath(options: DatabasePathOptions = {}): string {
  if (options.db !== undefined && options.db !== null && options.db.trim() !== '') {
    return resolve(options.db)
  }
  if (options.dataRoot !== undefined && options.dataRoot !== null && options.dataRoot.trim() !== '') {
    return join(resolve(options.dataRoot), SNAPSHOT_FILE)
  }
  const env = options.env ?? process.env
  if (env.ACEPASS_DB !== undefined && env.ACEPASS_DB.trim() !== '') return resolve(env.ACEPASS_DB)
  if (env.ACEPASS_DATA_ROOT !== undefined && env.ACEPASS_DATA_ROOT.trim() !== '') {
    return join(resolve(env.ACEPASS_DATA_ROOT), SNAPSHOT_FILE)
  }
  return join(resolve(options.cwd ?? process.cwd()), '.acepass', SNAPSHOT_FILE)
}

/** `<source dir>/backups/<name>-<UTC timestamp>`. */
export function defaultBackupDir(sourcePath: string, now: Date = new Date()): string {
  const name = basename(sourcePath).replace(/\.sqlite$/i, '')
  return join(dirname(resolve(sourcePath)), 'backups', `${name}-${timestampSlug(now)}`)
}

function timestampSlug(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remove `<dest>.partial-<pid>` directories whose owning process is gone. */
function cleanupStalePartials(destDir: string): string[] {
  const parent = dirname(destDir)
  if (!existsSync(parent)) return []
  const prefix = `${basename(destDir)}.partial-`
  const removed: string[] = []
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(prefix)) continue
    const pid = Number(entry.slice(prefix.length))
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) continue
    rmSync(join(parent, entry), { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}

/** A directory name that does not exist yet (`<base>` or `<base>-1`, `<base>-2`, ...). */
function uniqueDir(base: string): string {
  if (!existsSync(base)) return base
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base}-${process.pid}`
}

/** Remove `<mediaRoot>.restore-<pid>.tmp` staging directories whose owning process is gone. */
function cleanupStaleMediaStaging(mediaRoot: string): string[] {
  const parent = dirname(mediaRoot)
  if (!existsSync(parent)) return []
  const prefix = `${basename(mediaRoot)}.restore-`
  const removed: string[] = []
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
    const pid = Number(entry.slice(prefix.length, -'.tmp'.length))
    if (Number.isInteger(pid) && pid > 0 && pid === process.pid) continue
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) continue
    rmSync(join(parent, entry), { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}

/* -------------------------------------------------------------------------------------------- *
 * Media (private objects)
 *
 * The media tree is content addressed by `src/ingestion/storage.ts`, but the backup does not assume
 * that: it walks whatever is on disk, hashes each file, and refuses anything that is not a regular
 * file. Both directions keep the exact bytes, and the relative path is the identity — so a restore
 * can be compared file by file against the manifest without any database involvement.
 * -------------------------------------------------------------------------------------------- */

function mediaFilePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

function assertSafeMediaPath(relativePath: string, code = 'manifest_invalid'): void {
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new BackupFailure(code, 'verification', `媒体路径非法：${JSON.stringify(relativePath)}`)
  }
  const parts = relativePath.split('/')
  if (parts.some((part) => part === '' || part === '..' || part === '.')) {
    throw new BackupFailure(code, 'verification', `媒体路径包含非法段：${JSON.stringify(relativePath)}`)
  }
}

/**
 * Every regular file under `root`, as sorted POSIX relative paths. Refuses links and specials.
 *
 * The failure code is a parameter because the same walk serves two different questions: at backup
 * time a symlink means "this tree cannot be archived" (refused), while at verify time it means "this
 * artifact was tampered with" (verification).
 */
function listMediaFiles(
  root: string,
  failure: { code: string; kind: FailureKind } = { code: 'media_unexpected_entry', kind: 'verification' },
): string[] {
  const found: string[] = []
  const walk = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new BackupFailure(
          failure.code,
          failure.kind,
          `媒体目录包含符号链接（拒绝跟随）：${relative}`,
          { path: relative },
        )
      }
      if (entry.isDirectory()) {
        walk(absolute, relative)
        continue
      }
      if (!entry.isFile()) {
        throw new BackupFailure(
          failure.code,
          failure.kind,
          `媒体目录包含非常规文件（设备/FIFO/socket）：${relative}`,
          { path: relative },
        )
      }
      found.push(relative)
    }
  }
  walk(root, '')
  return found.sort()
}

/**
 * Hash every file under the media root.
 *
 * The database snapshot is taken *before* this runs, on purpose: assets are written to disk before
 * their row is inserted, so scanning media afterwards can only pick up an extra (unreferenced) file
 * — never a row whose object is missing from the archive.
 */
async function scanMediaRoot(root: string): Promise<{
  files: MediaFileEntry[]
  total_bytes: number
  warnings: string[]
}> {
  const warnings: string[] = []
  const files: MediaFileEntry[] = []
  let totalBytes = 0
  let partials = 0
  for (const relative of listMediaFiles(root, { code: 'media_unsupported_entry', kind: 'refused' })) {
    const absolute = mediaFilePath(root, relative)
    const bytes = statSync(absolute).size
    files.push({ path: relative, bytes, sha256: await sha256File(absolute) })
    totalBytes += bytes
    if (relative.endsWith('.part')) partials += 1
  }
  if (partials > 0) {
    warnings.push(`媒体目录里有 ${partials} 个 .part 孤儿文件（中断的上传），已一并归档`)
  }
  return { files, total_bytes: totalBytes, warnings }
}

/**
 * Copy the scanned files into `destRoot`, verifying each copy against the hash from the scan.
 *
 * A mismatch means the file changed between hashing and copying. Retrying once absorbs a metadata
 * touch; two mismatches in a row are refused rather than archived, because a backup that contains
 * neither the old nor the new bytes of a file is worse than a backup that failed.
 */
async function archiveMediaTree(
  sourceRoot: string,
  destRoot: string,
  files: MediaFileEntry[],
): Promise<void> {
  mkdirSync(destRoot, { recursive: true })
  for (const file of files) {
    const source = mediaFilePath(sourceRoot, file.path)
    const dest = mediaFilePath(destRoot, file.path)
    mkdirSync(dirname(dest), { recursive: true })
    let copied = false
    for (let attempt = 0; attempt < 2 && !copied; attempt += 1) {
      copyFileSync(source, dest)
      copied = (await sha256File(dest)) === file.sha256
    }
    if (!copied) {
      rmSync(dest, { force: true })
      throw new BackupFailure(
        'media_changed_during_backup',
        'io',
        `媒体文件在备份过程中发生变化，已中止：${file.path}`,
        { path: file.path },
      )
    }
    fsyncFile(dest)
  }
}

/** Build the manifest media block, archiving the tree into `<tempDir>/media` when asked to. */
async function collectMedia(
  sourcePath: string,
  mediaRoot: string,
  includeMedia: boolean,
  destDir: string,
): Promise<{ block: BackupManifestMedia; warnings: string[] }> {
  if (!includeMedia) {
    return { block: { root: mediaRoot, included: false }, warnings: [] }
  }
  const root = resolve(mediaRoot)
  if (root === resolve('/')) {
    throw new BackupFailure('media_root_invalid', 'refused', `拒绝把文件系统根目录当作媒体目录：${root}`, {
      media_root: root,
    })
  }
  if (!existsSync(root)) {
    throw new BackupFailure(
      'media_root_missing',
      'refused',
      `--include-media 指定的媒体目录不存在：${root}`,
      { media_root: root },
    )
  }
  if (!statSync(root).isDirectory()) {
    throw new BackupFailure(
      'media_root_invalid',
      'refused',
      `--include-media 指定的路径不是目录：${root}`,
      { media_root: root },
    )
  }
  // A destination inside the media root would archive the backup into itself, one level deeper on
  // every run. Refuse instead of producing an ever-growing artifact.
  const resolvedDest = resolve(destDir)
  if (resolvedDest === root || resolvedDest.startsWith(`${root}${sep}`)) {
    throw new BackupFailure(
      'media_dest_inside_media',
      'refused',
      `备份目录在媒体目录内部，会自我嵌套：${resolvedDest}`,
      { media_root: root, dest: resolvedDest },
    )
  }
  const scan = await scanMediaRoot(root)
  await archiveMediaTree(root, join(resolve(destDir), MEDIA_DIR_IN_BACKUP), scan.files)
  return {
    block: {
      root,
      included: true,
      dest: MEDIA_DIR_IN_BACKUP,
      file_count: scan.files.length,
      total_bytes: scan.total_bytes,
      files: scan.files,
    },
    warnings: scan.warnings,
  }
}

/**
 * Prove that the archived media tree is exactly what the manifest describes.
 *
 * "Exactly" includes the absence of extras: a file nobody recorded is a file nobody validated, and a
 * restore would put it into the media root.
 */
export async function verifyBackupMedia(
  backupDir: string,
  manifest: BackupManifest,
): Promise<MediaVerification | null> {
  const media = manifest.media
  if (media === undefined || media === null || media.included !== true) return null
  const directory = resolve(backupDir)
  const destName = media.dest ?? MEDIA_DIR_IN_BACKUP
  if (destName !== MEDIA_DIR_IN_BACKUP) {
    throw new BackupFailure(
      'manifest_invalid',
      'verification',
      `manifest 指向非法媒体目录：${String(destName)}`,
    )
  }
  const mediaDir = join(directory, destName)
  if (!existsSync(mediaDir) || !statSync(mediaDir).isDirectory()) {
    throw new BackupFailure('media_dir_missing', 'verification', `备份缺少媒体目录：${mediaDir}`)
  }
  const files = media.files ?? []
  if (!Array.isArray(files)) {
    throw new BackupFailure('manifest_invalid', 'verification', 'manifest.media.files 不是数组')
  }
  if (media.file_count !== undefined && Number(media.file_count) !== files.length) {
    throw new BackupFailure(
      'manifest_invalid',
      'verification',
      `manifest 的 media.file_count（${media.file_count}）与 files 条数（${files.length}）不一致`,
    )
  }
  const seen = new Set<string>()
  let totalBytes = 0
  for (const file of files) {
    if (typeof file?.path !== 'string' || typeof file?.sha256 !== 'string' || !Number.isFinite(file?.bytes)) {
      throw new BackupFailure('manifest_invalid', 'verification', 'manifest.media.files 有条目不完整')
    }
    assertSafeMediaPath(file.path)
    if (seen.has(file.path)) {
      throw new BackupFailure('manifest_invalid', 'verification', `manifest 记录了重复的媒体路径：${file.path}`)
    }
    seen.add(file.path)
    const absolute = mediaFilePath(mediaDir, file.path)
    if (!existsSync(absolute)) {
      throw new BackupFailure('media_file_missing', 'verification', `备份缺少媒体文件：${file.path}`, {
        path: file.path,
      })
    }
    if (!lstatSync(absolute).isFile()) {
      throw new BackupFailure(
        'media_unexpected_entry',
        'verification',
        `备份里的媒体路径不是常规文件：${file.path}`,
        { path: file.path },
      )
    }
    const bytes = statSync(absolute).size
    if (bytes !== Number(file.bytes)) {
      throw new BackupFailure(
        'media_size_mismatch',
        'verification',
        `媒体文件大小 ${bytes} != manifest ${file.bytes}：${file.path}`,
        { path: file.path, expected: file.bytes, actual: bytes },
      )
    }
    const digest = await sha256File(absolute)
    if (digest !== file.sha256) {
      throw new BackupFailure(
        'media_checksum_mismatch',
        'verification',
        `媒体文件 sha256 ${digest.slice(0, 12)} != manifest ${String(file.sha256).slice(0, 12)}：${file.path}`,
        { path: file.path, expected: file.sha256, actual: digest },
      )
    }
    totalBytes += bytes
  }
  const extras = listMediaFiles(mediaDir).filter((path) => !seen.has(path))
  if (extras.length > 0) {
    throw new BackupFailure(
      'media_unexpected_file',
      'verification',
      `备份里有多余的媒体文件（不在 manifest 中）：${extras[0]}`,
      { count: extras.length, files: extras.slice(0, 20) },
    )
  }
  return {
    included: true,
    dest: destName,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
  }
}

/**
 * Put the archived media tree back under a media root.
 *
 * The dangerous part is a partial restore: a database that points at objects which are half old and
 * half new is worse than an untouched media root. Everything is therefore staged and hashed first,
 * then applied file by file with a per-file safety copy, and any failure rewinds both directions
 * (created files removed, replaced files restored from the safety directory).
 *
 * Files present in the target but absent from the manifest are left alone — this function never
 * deletes data it did not create.
 */
export async function restoreBackupMedia(options: MediaRestoreOptions): Promise<MediaRestoreResult> {
  const backupDir = resolve(options.backupDir)
  const mediaRoot = resolve(options.mediaRoot)
  const now = options.now ?? new Date()
  const warnings: string[] = []
  const manifest = options.manifest ?? (await verifyBackupDirectory(backupDir)).manifest
  const media = manifest.media
  if (media === undefined || media === null || media.included !== true) {
    throw new BackupFailure(
      'media_not_in_backup',
      'refused',
      `这份备份不含媒体文件（manifest.media.included=false）：${backupDir}`,
      { backup: backupDir },
    )
  }
  if (mediaRoot === resolve('/')) {
    throw new BackupFailure('media_root_invalid', 'refused', `拒绝把媒体恢复到文件系统根目录：${mediaRoot}`, {
      media_root: mediaRoot,
    })
  }
  const files = media.files ?? []
  if (!Array.isArray(files)) {
    throw new BackupFailure('manifest_invalid', 'verification', 'manifest.media.files 不是数组')
  }
  if (media.file_count !== undefined && Number(media.file_count) !== files.length) {
    throw new BackupFailure(
      'manifest_invalid',
      'verification',
      `manifest 的 media.file_count（${media.file_count}）与 files 条数（${files.length}）不一致`,
    )
  }
  const mediaDir = join(backupDir, media.dest ?? MEDIA_DIR_IN_BACKUP)
  if (!existsSync(mediaDir) || !statSync(mediaDir).isDirectory()) {
    throw new BackupFailure('media_dir_missing', 'verification', `备份缺少媒体目录：${mediaDir}`)
  }
  options.onStage?.('verified')

  const stale = cleanupStaleMediaStaging(mediaRoot)
  if (stale.length > 0) warnings.push(`清理了 ${stale.length} 个上次中断留下的媒体暂存目录：${stale.join(', ')}`)

  // Plan against what is on disk now: identical files are left untouched, different ones need
  // `--force`, missing ones are created.
  type Planned = { file: MediaFileEntry; dest: string; action: 'create' | 'overwrite' | 'unchanged' }
  const plan: Planned[] = []
  for (const file of files) {
    assertSafeMediaPath(file.path)
    const dest = mediaFilePath(mediaRoot, file.path)
    if (!existsSync(dest)) {
      plan.push({ file, dest, action: 'create' })
      continue
    }
    if (!lstatSync(dest).isFile()) {
      throw new BackupFailure(
        'media_destination_not_file',
        'refused',
        `媒体目标路径已被非文件占用，拒绝覆盖：${file.path}`,
        { path: file.path, dest },
      )
    }
    const bytes = statSync(dest).size
    const same = bytes === Number(file.bytes) && (await sha256File(dest)) === file.sha256
    plan.push({ file, dest, action: same ? 'unchanged' : 'overwrite' })
  }
  const overwrites = plan.filter((entry) => entry.action === 'overwrite')
  if (overwrites.length > 0 && options.force !== true) {
    throw new BackupFailure(
      'media_exists',
      'refused',
      `媒体目录已有 ${overwrites.length} 个内容不同的同名文件，默认不覆盖：${overwrites[0]!.file.path}（用 --force 覆盖，覆盖前会留副本）`,
      {
        media_root: mediaRoot,
        count: overwrites.length,
        sample: overwrites.slice(0, 10).map((entry) => entry.file.path),
      },
    )
  }
  options.onStage?.('planned')

  // Stage everything that will be applied, verifying the bytes as they land.
  const staging = `${mediaRoot}.restore-${process.pid}.tmp`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  let stagedBytes = 0
  try {
    for (const entry of plan) {
      if (entry.action === 'unchanged') continue
      const source = mediaFilePath(mediaDir, entry.file.path)
      if (!existsSync(source)) {
        throw new BackupFailure('media_file_missing', 'verification', `备份缺少媒体文件：${entry.file.path}`, {
          path: entry.file.path,
        })
      }
      const staged = mediaFilePath(staging, entry.file.path)
      mkdirSync(dirname(staged), { recursive: true })
      copyFileSync(source, staged)
      const digest = await sha256File(staged)
      if (digest !== entry.file.sha256) {
        throw new BackupFailure(
          'media_checksum_mismatch',
          'verification',
          `暂存区里的媒体文件校验失败：${entry.file.path}`,
          { path: entry.file.path, expected: entry.file.sha256, actual: digest },
        )
      }
      fsyncFile(staged)
      stagedBytes += Number(entry.file.bytes)
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  options.onStage?.('staged')

  let safetyDir: string | null = null
  const created: string[] = []
  const replaced: { dest: string; safety: string }[] = []
  if (overwrites.length > 0) {
    safetyDir = uniqueDir(`${mediaRoot}.pre-restore-${timestampSlug(now)}`)
    for (const entry of overwrites) {
      const safety = mediaFilePath(safetyDir, entry.file.path)
      mkdirSync(dirname(safety), { recursive: true })
      copyFileSync(entry.dest, safety)
      fsyncFile(safety)
      replaced.push({ dest: entry.dest, safety })
    }
  }
  options.onStage?.('safety-copy')

  const rollback = (): void => {
    for (const dest of created) rmSync(dest, { force: true })
    for (const { dest, safety } of replaced) {
      try {
        copyFileSync(safety, dest)
      } catch (error) {
        warnings.push(`回滚时无法还原 ${basename(dest)}：${(error as Error).message}`)
      }
    }
    rmSync(staging, { recursive: true, force: true })
  }

  try {
    for (const entry of plan) {
      if (entry.action === 'unchanged') continue
      mkdirSync(dirname(entry.dest), { recursive: true })
      renameSync(mediaFilePath(staging, entry.file.path), entry.dest)
      if (entry.action === 'create') created.push(entry.dest)
    }
    options.onStage?.('applied')
    for (const entry of plan) {
      if (entry.action === 'unchanged') continue
      const digest = await sha256File(entry.dest)
      if (digest !== entry.file.sha256) {
        throw new BackupFailure(
          'media_restore_verification_failed',
          'verification',
          `恢复后的媒体文件校验失败：${entry.file.path}`,
          { path: entry.file.path, expected: entry.file.sha256, actual: digest },
        )
      }
    }
    options.onStage?.('checked')
  } catch (error) {
    rollback()
    options.onStage?.('rolled-back')
    if (error instanceof BackupFailure) {
      throw new BackupFailure(error.code, error.kind, error.message, {
        ...error.details,
        rolled_back: true,
        removed_created: created.length,
        restored_overwritten: replaced.length,
      })
    }
    throw new BackupFailure('media_restore_failed', 'io', `媒体恢复失败并已回滚：${(error as Error).message}`, {
      rolled_back: true,
      removed_created: created.length,
      restored_overwritten: replaced.length,
    })
  }
  rmSync(staging, { recursive: true, force: true })
  return {
    mediaRoot,
    restored: created.length,
    overwritten: replaced.length,
    unchanged: plan.filter((entry) => entry.action === 'unchanged').length,
    bytes: stagedBytes,
    safetyDir,
    warnings,
  }
}

/* -------------------------------------------------------------------------------------------- *
 * Manifest signature (optional, HMAC-SHA256)
 *
 * The digest covers a canonical rendering of the manifest with the `signature` field removed:
 * object keys sorted, arrays kept in order. That makes the digest independent of JSON formatting and
 * of any future field, while a stripped signature is detectable because a keyed verification is
 * required whenever a key is configured.
 * -------------------------------------------------------------------------------------------- */

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function manifestSigningBytes(manifest: BackupManifest): Buffer {
  const { signature: _signature, ...rest } = manifest
  return Buffer.from(canonicalJson(rest), 'utf8')
}

/** Resolve the key material from a file path, the environment, or nothing at all. */
export function loadSigningKey(
  options: {
    path?: string | null
    env?: Record<string, string | undefined>
  } = {},
): Buffer | null {
  const env = options.env ?? process.env
  let material: Buffer | null = null
  const explicit = options.path ?? null
  const envPath = env[SIGNING_KEY_FILE_ENV]?.trim()
  if (explicit !== null && explicit !== '') {
    material = readKeyFile(explicit)
  } else if (env[SIGNING_KEY_ENV] !== undefined && env[SIGNING_KEY_ENV] !== '') {
    material = Buffer.from(env[SIGNING_KEY_ENV], 'utf8')
  } else if (envPath !== undefined && envPath !== '') {
    material = readKeyFile(envPath)
  }
  if (material === null) return null
  if (material.length < MIN_SIGNING_KEY_BYTES) {
    throw new BackupFailure(
      'sign_key_too_short',
      'refused',
      `签名密钥至少需要 ${MIN_SIGNING_KEY_BYTES} 字节（当前 ${material.length} 字节）`,
      { bytes: material.length },
    )
  }
  return material
}

function readKeyFile(path: string): Buffer {
  const resolved = resolve(path)
  if (!existsSync(resolved)) {
    throw new BackupFailure('sign_key_unreadable', 'refused', `签名密钥文件不存在：${resolved}`, {
      path: resolved,
    })
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(resolved)
  } catch (error) {
    throw new BackupFailure('sign_key_unreadable', 'refused', `签名密钥文件不可读：${resolved}`, {
      path: resolved,
      error: (error as Error).message,
    })
  }
  // Trailing newlines are what `openssl rand -hex 32 > key` leaves behind; they are not key
  // material. Trim on bytes, not on a decoded string: a raw 32-byte key (`openssl rand -out key 32`)
  // is not valid UTF-8 and must survive byte for byte.
  let end = bytes.length
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1
  return bytes.subarray(0, end)
}

function normalizeKey(key: Buffer | string | null | undefined): Buffer | null {
  if (key === null || key === undefined) return null
  const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8')
  if (buffer.length === 0) return null
  if (buffer.length < MIN_SIGNING_KEY_BYTES) {
    throw new BackupFailure(
      'sign_key_too_short',
      'refused',
      `签名密钥至少需要 ${MIN_SIGNING_KEY_BYTES} 字节（当前 ${buffer.length} 字节）`,
      { bytes: buffer.length },
    )
  }
  return buffer
}

export function signManifest(manifest: BackupManifest, key: Buffer | string): BackupManifest {
  const material = normalizeKey(key)
  if (material === null) {
    throw new BackupFailure('sign_key_too_short', 'refused', '签名密钥为空')
  }
  const digest = createHmac('sha256', material).update(manifestSigningBytes(manifest)).digest('hex')
  return { ...manifest, signature: { algorithm: SIGNATURE_ALGORITHM, digest } }
}

/**
 * Check `manifest.signature` against a key.
 *
 * Returns warnings for the operator; throws when the manifest cannot be trusted:
 *  - signed + no key → `signature_key_missing` (refused): a signature we cannot check proves nothing;
 *  - signed + wrong key/tampered manifest → `signature_mismatch` (verification);
 *  - unsigned + key configured → `signature_missing` (refused): otherwise stripping the signature
 *    would silently downgrade a backup to unsigned. Pass no key to accept one deliberately.
 */
export function checkManifestSignature(
  manifest: BackupManifest,
  key: Buffer | string | null | undefined,
): string[] {
  const material = normalizeKey(key)
  const signature = manifest.signature
  if (signature === undefined || signature === null) {
    if (material !== null) {
      throw new BackupFailure(
        'signature_missing',
        'refused',
        '配置了签名密钥，但这份备份的 manifest 没有签名（拒绝在无法验签的情况下降级恢复；确实要恢复未签名备份就不要传密钥）',
      )
    }
    return []
  }
  if (String(signature.algorithm ?? '') !== SIGNATURE_ALGORITHM) {
    throw new BackupFailure(
      'signature_algorithm_unsupported',
      'verification',
      `不支持的签名算法：${String(signature.algorithm)}（期望 ${SIGNATURE_ALGORITHM}）`,
    )
  }
  const digest = String(signature.digest ?? '')
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new BackupFailure('signature_invalid', 'verification', 'manifest.signature.digest 不是 64 位十六进制')
  }
  if (material === null) {
    throw new BackupFailure(
      'signature_key_missing',
      'refused',
      '这份备份带 HMAC 签名，校验需要密钥（--sign-key <path> 或 ACEPASS_BACKUP_SIGNING_KEY）',
      { algorithm: SIGNATURE_ALGORITHM },
    )
  }
  const expected = createHmac('sha256', material).update(manifestSigningBytes(manifest)).digest()
  const actual = Buffer.from(digest, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new BackupFailure(
      'signature_mismatch',
      'verification',
      `manifest 的 HMAC-SHA256 签名不匹配（密钥不对，或 manifest 被改过）：${digest.slice(0, 12)}`,
      { algorithm: SIGNATURE_ALGORITHM },
    )
  }
  return []
}

/* -------------------------------------------------------------------------------------------- *
 * Rotation
 * -------------------------------------------------------------------------------------------- */

/** Read the identity a backup directory claims for itself, or the reason it is not one of ours. */
export function readBackupIdentity(directory: string): RotationIdentity | { error: string } {
  const dir = resolve(directory)
  const manifestPath = join(dir, MANIFEST_FILE)
  if (!existsSync(manifestPath)) return { error: `没有 ${MANIFEST_FILE}` }
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
  } catch (error) {
    return { error: `${MANIFEST_FILE} 不是合法 JSON：${(error as Error).message}` }
  }
  const tool = String(manifest?.tool?.name ?? '')
  if (tool !== BACKUP_TOOL_NAME) return { error: `不是本工具的产物（manifest.tool.name=${JSON.stringify(tool)}）` }
  if (Number(manifest?.format_version) !== BACKUP_FORMAT_VERSION) {
    return { error: `不支持的备份格式 ${String(manifest?.format_version)}` }
  }
  if (!/^[0-9a-f]{64}$/.test(String(manifest?.snapshot?.sha256 ?? ''))) {
    return { error: 'manifest.snapshot.sha256 缺失或非法' }
  }
  if (!existsSync(join(dir, SNAPSHOT_FILE))) return { error: `缺少 ${SNAPSHOT_FILE}` }
  return {
    dir,
    name: basename(dir),
    created_at: String(manifest.created_at ?? ''),
    tool,
    format_version: Number(manifest.format_version),
    rows: Number(manifest.total_rows ?? 0),
    bytes: Number(manifest.snapshot?.bytes ?? 0),
  }
}

/**
 * Keep the newest `keep` backups in `directory` and delete the rest.
 *
 * Safety rules, in order of importance:
 *  - only direct children of `directory` are considered (no recursion into a path an operator did
 *    not point at);
 *  - a candidate must identify itself as this tool's output through its own manifest; anything else
 *    (a hand-made copy, another tool's directory, a directory without a manifest) is listed and
 *    skipped, never deleted;
 *  - `protect` (the backup just written) is never deleted;
 *  - `keep` must be at least 1, so a typo cannot empty the directory.
 */
export function rotateBackups(options: RotationOptions): RotationResult {
  const directory = resolve(options.directory)
  const keep = Number(options.keep)
  if (!Number.isInteger(keep) || keep < 1) {
    throw new BackupFailure('keep_invalid', 'refused', `--keep 必须是 >= 1 的整数（收到 ${String(options.keep)}）`)
  }
  const protectedPaths = new Set((options.protect ?? []).map((path) => resolve(path)))
  const result: RotationResult = {
    directory,
    keep,
    kept: [],
    deleted: [],
    skipped: [],
    failed: [],
    dry_run: options.dryRun === true,
  }
  if (!existsSync(directory)) return result
  const candidates: RotationIdentity[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const identity = readBackupIdentity(join(directory, entry.name))
    if ('error' in identity) {
      result.skipped.push({ path: join(directory, entry.name), reason: identity.error })
      continue
    }
    candidates.push(identity)
  }
  candidates.sort((left, right) => {
    if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
    return left.name < right.name ? 1 : left.name > right.name ? -1 : 0
  })
  const survivors = candidates.slice(0, keep)
  const doomed = candidates.slice(keep)
  for (const identity of survivors) result.kept.push(identity.dir)
  for (const identity of doomed) {
    if (protectedPaths.has(identity.dir)) {
      result.kept.push(identity.dir)
      continue
    }
    if (options.dryRun === true) {
      result.deleted.push(identity.dir)
      continue
    }
    try {
      rmSync(identity.dir, { recursive: true, force: true })
      result.deleted.push(identity.dir)
    } catch (error) {
      result.failed.push({ path: identity.dir, error: (error as Error).message })
    }
  }
  return result
}



function metaDigest(db: DatabaseSync): string {
  const rows = db.prepare(`SELECT key, value FROM "${META_TABLE}" ORDER BY key`).all() as {
    key: string
    value: string
  }[]
  return tableDigest(
    rows.map((row) => [row.key, row.value]),
    ['key', 'value'],
  )
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
  return Number(row.n)
}

function pragmaNumber(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  return Number(Object.values(row ?? {})[0] ?? 0)
}

/**
 * Re-open a snapshot and derive every fact the manifest claims.
 *
 * This runs on the file that was just written, not on the live source: it is the only way to know
 * the backup is self-consistent (a live source can change between two reads).
 */
export function inspectSnapshot(snapshotPath: string): SnapshotInspection {
  if (!existsSync(snapshotPath)) {
    throw new BackupFailure('snapshot_missing', 'verification', `快照文件不存在：${snapshotPath}`)
  }
  const db = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[]).map((row) =>
      String(Object.values(row)[0]),
    )
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new BackupFailure('snapshot_corrupt', 'verification', `快照完整性检查失败：${integrity.join('; ')}`, {
        integrity,
      })
    }
    const foreignKeyViolations = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length
    const present = tableNames(db)
    const expected = TABLES.map((table) => table.name)
    const missing = expected.filter((name) => !present.includes(name))
    if (missing.length > 0 || !present.includes(META_TABLE)) {
      throw new BackupFailure(
        'snapshot_schema_mismatch',
        'verification',
        `快照缺少表：${[...missing, ...(present.includes(META_TABLE) ? [] : [META_TABLE])].join(', ')}`,
        { missing },
      )
    }
    const unknownTables = present.filter((name) => name !== META_TABLE && !expected.includes(name))
    const tables = expected.map((name) => ({
      name,
      rows: countRows(db, name),
      digest: tableDigestFromDatabase(db, name),
    }))
    const sqliteVersion = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v)
    return {
      schema_version: schemaVersionOf(db),
      tables,
      total_rows: tables.reduce((sum, table) => sum + table.rows, 0),
      foreign_key_violations: foreignKeyViolations,
      unknown_tables: unknownTables,
      sqlite_version: sqliteVersion,
      bytes: fileBytes(snapshotPath),
      pages: pragmaNumber(db, 'page_count'),
    }
  } finally {
    db.close()
  }
}

function compareInspection(manifest: BackupManifest, inspection: SnapshotInspection): string[] {
  const problems: string[] = []
  if (inspection.schema_version !== manifest.integrity.schema_version) {
    problems.push(
      `schema_version ${inspection.schema_version} != manifest ${manifest.integrity.schema_version}`,
    )
  }
  if (inspection.total_rows !== manifest.total_rows) {
    problems.push(`total rows ${inspection.total_rows} != manifest ${manifest.total_rows}`)
  }
  if (inspection.foreign_key_violations !== 0) {
    problems.push(`foreign key violations: ${inspection.foreign_key_violations}`)
  }
  const expected = new Map(manifest.tables.map((table) => [table.name, table]))
  for (const actual of inspection.tables) {
    const wanted = expected.get(actual.name)
    if (wanted === undefined) {
      problems.push(`${actual.name}: not described by the manifest`)
      continue
    }
    if (actual.rows !== wanted.rows) problems.push(`${actual.name}: ${actual.rows} rows != ${wanted.rows}`)
    if (actual.digest !== wanted.digest) {
      problems.push(`${actual.name}: digest ${actual.digest.slice(0, 12)} != ${wanted.digest.slice(0, 12)}`)
    }
  }
  for (const name of expected.keys()) {
    if (!inspection.tables.some((table) => table.name === name)) problems.push(`${name}: missing from snapshot`)
  }
  return problems
}

export interface VerifiedBackup {
  manifest: BackupManifest
  snapshotPath: string
  inspection: SnapshotInspection
  warnings: string[]
  /** `null` when the backup does not include the media tree. */
  media: MediaVerification | null
}

/** Validate a backup directory against its own manifest, without touching any target. */
export async function verifyBackupDirectory(
  backupDir: string,
  options: VerifyOptions = {},
): Promise<VerifiedBackup> {
  const directory = resolve(backupDir)
  const manifestPath = join(directory, MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    throw new BackupFailure('manifest_missing', 'verification', `备份目录缺少 ${MANIFEST_FILE}：${directory}`)
  }
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
  } catch (error) {
    throw new BackupFailure('manifest_invalid', 'verification', `manifest.json 不是合法 JSON：${String(error)}`)
  }
  if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
    throw new BackupFailure(
      'manifest_version',
      'verification',
      `不支持的备份格式 ${manifest.format_version}（期望 ${BACKUP_FORMAT_VERSION}）`,
    )
  }
  // The signature covers every other manifest field, so check it before anything derived from them
  // is believed — but after the format check, which reads a field the signature protects.
  const warnings = checkManifestSignature(manifest, options.signingKey ?? null)
  const file = String(manifest.snapshot?.file ?? '')
  if (file !== SNAPSHOT_FILE) {
    throw new BackupFailure('manifest_invalid', 'verification', `manifest 指向非法快照文件：${file}`)
  }
  const snapshotPath = join(directory, file)
  if (!existsSync(snapshotPath)) {
    throw new BackupFailure('snapshot_missing', 'verification', `备份快照不存在：${snapshotPath}`)
  }
  const bytes = fileBytes(snapshotPath)
  if (bytes !== Number(manifest.snapshot.bytes)) {
    throw new BackupFailure(
      'snapshot_size_mismatch',
      'verification',
      `快照大小 ${bytes} != manifest ${manifest.snapshot.bytes}`,
    )
  }
  const sha256 = await sha256File(snapshotPath)
  if (sha256 !== manifest.snapshot.sha256) {
    throw new BackupFailure(
      'snapshot_checksum_mismatch',
      'verification',
      `快照 sha256 ${sha256.slice(0, 12)} != manifest ${String(manifest.snapshot.sha256).slice(0, 12)}`,
      { expected: manifest.snapshot.sha256, actual: sha256 },
    )
  }
  const inspection = inspectSnapshot(snapshotPath)
  if (inspection.schema_version !== SCHEMA_VERSION) {
    throw new BackupFailure(
      'schema_version_mismatch',
      'verification',
      `备份的 schema_version 是 ${inspection.schema_version}，当前插件期望 ${SCHEMA_VERSION}`,
    )
  }
  const problems = compareInspection(manifest, inspection)
  if (problems.length > 0) {
    throw new BackupFailure('backup_invalid', 'verification', `备份校验失败：${problems[0]}`, { problems })
  }
  const media = await verifyBackupMedia(directory, manifest)
  return { manifest, snapshotPath, inspection, warnings, media }
}

/**
 * Take an online backup of a live store.
 *
 * The source is opened read-write (a WAL database must be readable as a whole; a read-only handle
 * cannot recover a WAL on its own), but nothing is written to it. The snapshot is converted to
 * DELETE journal mode so the artifact is one self-contained file.
 */
export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? new Date()
  const sourcePath = resolve(options.sourcePath)
  if (!existsSync(sourcePath)) {
    throw new BackupFailure('source_missing', 'refused', `源数据库不存在：${sourcePath}`, { source: sourcePath })
  }
  const sourceBytes = fileBytes(sourcePath)
  if (sourceBytes === 0) {
    throw new BackupFailure('source_empty', 'refused', `源数据库是空文件：${sourcePath}`, { source: sourcePath })
  }
  const destDir = resolve(options.destDir ?? defaultBackupDir(sourcePath, now))
  const warnings: string[] = []
  const stale = cleanupStalePartials(destDir)
  if (stale.length > 0) warnings.push(`清理了 ${stale.length} 个上次中断留下的临时目录：${stale.join(', ')}`)
  const destExists = existsSync(destDir)
  if (destExists && options.force !== true) {
    throw new BackupFailure('destination_exists', 'refused', `备份目录已存在：${destDir}（用 --force 覆盖）`, {
      destination: destDir,
    })
  }
  const parent = dirname(destDir)
  mkdirSync(parent, { recursive: true })
  const tempDir = join(parent, `${basename(destDir)}.partial-${process.pid}`)
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })
  const snapshotPath = join(tempDir, SNAPSHOT_FILE)

  options.onStage?.('started')
  const sourceDb = new DatabaseSync(sourcePath)
  try {
    sourceDb.exec('PRAGMA busy_timeout = 5000')
    // `VACUUM INTO` takes one consistent read snapshot and writes it to a new file. Unlike the
    // online backup API it does not restart when another connection commits, so a busy store cannot
    // starve the backup; in WAL mode the writer keeps working while the snapshot is read.
    sourceDb.prepare('VACUUM INTO ?').run(snapshotPath)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new BackupFailure('snapshot_failed', 'io', `在线备份失败：${(error as Error).message}`, {
      source: sourcePath,
    })
  } finally {
    sourceDb.close()
  }
  options.onStage?.('snapshot')

  // A backup inherits the source's journal mode; force the snapshot to one file so an operator can
  // copy/move it without also having to reason about a `-wal` that belongs to a different database.
  const snapshotDb = new DatabaseSync(snapshotPath)
  try {
    snapshotDb.exec('PRAGMA journal_mode = DELETE')
  } finally {
    snapshotDb.close()
  }

  let inspection: SnapshotInspection
  try {
    inspection = inspectSnapshot(snapshotPath)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
  if (inspection.schema_version !== SCHEMA_VERSION) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new BackupFailure(
      'schema_version_mismatch',
      'refused',
      `源库的 schema_version 是 ${inspection.schema_version}，当前插件期望 ${SCHEMA_VERSION}`,
      { source: sourcePath, schema_version: inspection.schema_version },
    )
  }
  options.onStage?.('verified')

  if (options.mediaRoot !== undefined && options.mediaRoot !== null && options.includeMedia !== true) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new BackupFailure(
      'media_flag_required',
      'refused',
      '--media-root 只能与 --include-media 一起使用（否则媒体根会被静默忽略）',
    )
  }
  const mediaRoot = resolve(options.mediaRoot ?? join(dirname(sourcePath), MEDIA_DIR_NAME))
  let media: { block: BackupManifestMedia; warnings: string[] }
  try {
    media = await collectMedia(sourcePath, mediaRoot, options.includeMedia === true, tempDir)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
  warnings.push(...media.warnings)
  options.onStage?.('media')

  const sha256 = await sha256File(snapshotPath)
  const bytes = fileBytes(snapshotPath)
  const manifest: BackupManifest = {
    format_version: BACKUP_FORMAT_VERSION,
    created_at: now.toISOString(),
    source: {
      path: sourcePath,
      bytes: sourceBytes,
      schema_version: inspection.schema_version,
      tables: inspection.tables.length,
      rows: inspection.total_rows,
    },
    snapshot: { file: SNAPSHOT_FILE, bytes, sha256, pages: inspection.pages },
    integrity: {
      check: 'ok',
      foreign_key_violations: inspection.foreign_key_violations,
      schema_version: inspection.schema_version,
      tables: inspection.tables.length,
    },
    tables: inspection.tables,
    total_rows: inspection.total_rows,
    media: media.block,
    tool: { name: BACKUP_TOOL_NAME, node: process.version, sqlite: inspection.sqlite_version },
  }
  const signingKey = normalizeKey(options.signingKey ?? null)
  const written = signingKey === null ? manifest : signManifest(manifest, signingKey)
  writeFileSync(join(tempDir, MANIFEST_FILE), `${JSON.stringify(written, null, 2)}\n`, 'utf8')
  fsyncFile(snapshotPath)
  fsyncFile(join(tempDir, MANIFEST_FILE))
  options.onStage?.('manifest')

  let replaced: string | null = null
  if (destExists) {
    replaced = uniqueDir(`${destDir}.old-${timestampSlug(now)}`)
    renameSync(destDir, replaced)
  }
  try {
    renameSync(tempDir, destDir)
  } catch (error) {
    if (replaced !== null) renameSync(replaced, destDir)
    rmSync(tempDir, { recursive: true, force: true })
    throw new BackupFailure('commit_failed', 'io', `备份提交失败：${(error as Error).message}`)
  }
  if (replaced !== null) rmSync(replaced, { recursive: true, force: true })
  options.onStage?.('committed')
  return { destDir, manifest: written, warnings }
}

interface TargetState {
  exists: boolean
  bytes: number
  empty: boolean
  rows: number
  schema_version: number
  tables: number
  is_acepass: boolean
  wal_bytes: number
}

function inspectTarget(targetPath: string): TargetState {
  if (!existsSync(targetPath)) {
    return {
      exists: false,
      bytes: 0,
      empty: true,
      rows: 0,
      schema_version: 0,
      tables: 0,
      is_acepass: false,
      wal_bytes: 0,
    }
  }
  const bytes = fileBytes(targetPath)
  const walBytes = fileBytes(`${targetPath}-wal`)
  if (bytes === 0) {
    return {
      exists: true,
      bytes: 0,
      empty: true,
      rows: 0,
      schema_version: 0,
      tables: 0,
      is_acepass: false,
      wal_bytes: walBytes,
    }
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(targetPath)
  } catch (error) {
    throw new BackupFailure(
      'target_not_a_database',
      'refused',
      `目标文件不是 SQLite 数据库：${targetPath}（${(error as Error).message}）`,
      { target: targetPath },
    )
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const present = tableNames(db)
    if (present.length === 0) {
      return {
        exists: true,
        bytes,
        empty: true,
        rows: 0,
        schema_version: 0,
        tables: 0,
        is_acepass: false,
        wal_bytes: walBytes,
      }
    }
    const isAcepass = present.includes(META_TABLE)
    const business = TABLES.map((table) => table.name).filter((name) => present.includes(name))
    const rows = isAcepass ? business.reduce((sum, name) => sum + countRows(db, name), 0) : 0
    return {
      exists: true,
      bytes,
      empty: isAcepass ? rows === 0 : false,
      rows,
      schema_version: isAcepass ? schemaVersionOf(db) : 0,
      tables: present.length,
      is_acepass: isAcepass,
      wal_bytes: walBytes,
    }
  } finally {
    db.close()
  }
}

/**
 * Restore a verified backup over `targetPath`.
 *
 * Order matters: verify the backup, refuse a non-empty target unless forced, snapshot the current
 * target, copy the snapshot beside the target, verify the copy's checksum, remove the old WAL, and
 * only then rename it into place. A failure after the rename restores the safety copy.
 */
export async function restoreDatabase(options: RestoreOptions): Promise<RestoreResult> {
  const now = options.now ?? new Date()
  const backupDir = resolve(options.backupDir)
  const targetPath = resolve(options.targetPath)
  const warnings: string[] = []

  const verified = await verifyBackupDirectory(backupDir, { signingKey: options.signingKey })
  warnings.push(...verified.warnings)
  options.onStage?.('validated')

  const target = inspectTarget(targetPath)
  if (target.exists && !target.is_acepass && target.tables > 0) {
    throw new BackupFailure(
      'target_not_acepass',
      'refused',
      `目标文件是 SQLite 数据库，但不是 AcePass 库（缺少 ${META_TABLE}）：${targetPath}`,
      { target: targetPath },
    )
  }
  if (target.exists && !target.empty && options.force !== true) {
    throw new BackupFailure(
      'target_not_empty',
      'refused',
      `目标库非空（${target.rows} 行业务数据）：${targetPath}（用 --force 覆盖）`,
      { target: targetPath, rows: target.rows },
    )
  }
  if (target.wal_bytes > 0 && options.force !== true) {
    throw new BackupFailure(
      'target_busy',
      'refused',
      `目标库还有未合并的 WAL（${target.wal_bytes} 字节），应用可能仍在运行：${targetPath}`,
      { target: targetPath, wal_bytes: target.wal_bytes },
    )
  }
  if (options.mediaRoot !== undefined && options.mediaRoot !== null && options.restoreMedia !== true) {
    throw new BackupFailure(
      'media_flag_required',
      'refused',
      '--media-root 只能与 --restore-media 一起使用（否则媒体根会被静默忽略）',
    )
  }

  // Media first, database second. Getting the order wrong is what breaks a data root: an old
  // database beside new objects merely has unreferenced files, while a new database beside missing
  // objects has broken references. Both are refused/rolled back long before this point when the
  // backup or the target is not acceptable, so a media restore never runs against a failed DB plan.
  let media: MediaRestoreResult | null = null
  if (options.restoreMedia === true) {
    media = await restoreBackupMedia({
      backupDir,
      mediaRoot: resolve(options.mediaRoot ?? join(dirname(targetPath), MEDIA_DIR_NAME)),
      force: options.force === true,
      now,
      manifest: verified.manifest,
      onStage: (stage) => options.onStage?.(`media:${stage}`),
    })
    warnings.push(...media.warnings)
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  let safetyCopy: string | null = null
  if (target.exists) {
    const safetyDir = `${targetPath}.pre-restore-${timestampSlug(now)}`
    mkdirSync(safetyDir, { recursive: true })
    const safetySnapshot = join(safetyDir, SNAPSHOT_FILE)
    if (target.bytes === 0) {
      writeFileSync(safetySnapshot, '')
    } else {
      const safetyDb = new DatabaseSync(targetPath)
      try {
        safetyDb.exec('PRAGMA busy_timeout = 5000')
        safetyDb.prepare('VACUUM INTO ?').run(safetySnapshot)
      } catch (error) {
        throw new BackupFailure(
          'safety_copy_failed',
          'io',
          `恢复前无法备份当前目标库：${(error as Error).message}`,
          { target: targetPath },
        )
      } finally {
        safetyDb.close()
      }
    }
    safetyCopy = safetySnapshot
  }
  options.onStage?.('safety-copy')

  const tempTarget = `${targetPath}.restore-${process.pid}.tmp`
  rmSync(tempTarget, { force: true })
  copyFileSync(verified.snapshotPath, tempTarget)
  fsyncFile(tempTarget)
  const copiedSha = await sha256File(tempTarget)
  if (copiedSha !== verified.manifest.snapshot.sha256) {
    rmSync(tempTarget, { force: true })
    throw new BackupFailure(
      'copy_checksum_mismatch',
      'verification',
      `复制到目标目录的快照校验失败：${copiedSha.slice(0, 12)} != ${String(verified.manifest.snapshot.sha256).slice(0, 12)}`,
    )
  }
  options.onStage?.('copied')

  rmSync(`${targetPath}-wal`, { force: true })
  rmSync(`${targetPath}-shm`, { force: true })
  let renamed = false
  try {
    renameSync(tempTarget, targetPath)
    renamed = true
    options.onStage?.('renamed')
    const inspection = inspectSnapshot(targetPath)
    const problems = compareInspection(verified.manifest, inspection)
    if (problems.length > 0) {
      throw new BackupFailure('restore_verification_failed', 'verification', `恢复后校验失败：${problems[0]}`, {
        problems,
      })
    }
    options.onStage?.('verified')
  } catch (error) {
    rmSync(`${targetPath}-wal`, { force: true })
    rmSync(`${targetPath}-shm`, { force: true })
    if (safetyCopy !== null) {
      const rollbackTemp = `${targetPath}.rollback-${process.pid}.tmp`
      rmSync(rollbackTemp, { force: true })
      copyFileSync(safetyCopy, rollbackTemp)
      fsyncFile(rollbackTemp)
      renameSync(rollbackTemp, targetPath)
    } else if (renamed || existsSync(targetPath)) {
      rmSync(targetPath, { force: true })
    }
    rmSync(tempTarget, { force: true })
    options.onStage?.('rolled-back')
    if (error instanceof BackupFailure) throw error
    throw new BackupFailure('restore_failed', 'io', `恢复失败：${(error as Error).message}`, {
      rolled_back: true,
    })
  }
  options.onStage?.('committed')
  return { targetPath, backupDir, manifest: verified.manifest, safetyCopy, media, warnings }
}
