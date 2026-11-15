#!/usr/bin/env node
/**
 * Online backup of a `.acepass` SQLite store (and, optionally, its private media tree).
 *
 *   npm run db:backup -- --db <path> --out <dir> [--force]
 *   node scripts/db-backup.mjs --data-root <dir>          # <dir>/acepass.sqlite → <dir>/backups/...
 *   node scripts/db-backup.mjs --data-root <dir> --include-media --keep 7 --sign-key ~/.acepass-backup.key
 *
 * The artifact is a directory containing `acepass.sqlite` (a consistent single-file snapshot) and
 * `manifest.json` (sha256, byte size, schema version, per-table row counts and digests). The
 * snapshot is produced through SQLite's online backup API, so the source may be in use; the artifact
 * is renamed into place only after it has been re-opened and verified.
 *
 * `--include-media` additionally archives `<dataRoot>/private-media` into `<backup>/media/` and
 * records `{path, bytes, sha256}` for every file in the manifest (`media.included: true`), so
 * `db:verify` can prove the archived bytes are the ones that were backed up.
 *
 * `--keep N` rotates the backups directory after a successful run: the newest N backups produced by
 * this tool (recognised through `manifest.tool.name`) are kept, the older ones are listed and
 * removed. Directories that are not this tool's output are listed and never touched.
 *
 * `--sign-key <path>` (or `ACEPASS_BACKUP_SIGNING_KEY`, or `ACEPASS_BACKUP_SIGNING_KEY_FILE`) signs
 * `manifest.json` with HMAC-SHA256. The key is read from a file outside the backup; it is never
 * echoed, written into the artifact or included in an error message. Without a key the artifact is
 * byte-identical to an unsigned B9 backup.
 *
 * Exit codes: 0 ok, 1 failure, 2 bad arguments, 3 verification failure, 4 refused (existing dest /
 * missing source / unusable signing key). One JSON object is printed on stdout (the last line is
 * machine-readable); the human-readable summary goes to stderr.
 */
import { dirname, resolve } from 'node:path'
import {
  BackupFailure,
  backupDatabase,
  defaultBackupDir,
  loadSigningKey,
  resolveDatabasePath,
  rotateBackups,
} from '../src/migrate/backup.ts'

function usage() {
  return [
    'usage: db-backup.mjs [--db <path> | --data-root <dir>] [--out <dir>] [--force]',
    '                     [--include-media] [--media-root <dir>]',
    '                     [--keep <n>] [--sign-key <path>]',
    '',
    '  --db <path>        the .acepass SQLite file (default: ACEPASS_DB, else <cwd>/.acepass/acepass.sqlite)',
    '  --data-root <dir>  directory that owns acepass.sqlite (alternative to --db)',
    '  --out <dir>        backup directory (default: <source dir>/backups/<name>-<UTC timestamp>)',
    '  --force            replace an existing backup directory',
    '  --include-media    also archive <dataRoot>/private-media into <backup>/media (per-file sha256 in manifest)',
    '  --media-root <dir> media root to archive (default: <source dir>/private-media); needs --include-media',
    '  --keep <n>         after a successful backup keep the newest n backups of this tool in the',
    '                     backups directory and delete the older ones (n >= 1; nothing else is deleted)',
    '  --sign-key <path>  HMAC-SHA256 sign manifest.json with the key in <path> (>= 16 bytes)',
    '',
    'Environment:',
    '  ACEPASS_DB / ACEPASS_DATA_ROOT            used when the path flags are absent',
    '  ACEPASS_BACKUP_SIGNING_KEY                signing key material (alternative to --sign-key)',
    '  ACEPASS_BACKUP_SIGNING_KEY_FILE           file holding the signing key',
    '  ACEPASS_DB_CRASH_AT                       drill hook: SIGKILL self at a named stage',
    '',
    'Exit codes: 0 ok, 1 failure, 2 bad arguments, 3 verification failure, 4 refused.',
  ].join('\n')
}

function parseArgs(argv) {
  const args = {
    db: null,
    dataRoot: null,
    out: null,
    mediaRoot: null,
    signKey: null,
    keep: null,
    force: false,
    includeMedia: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--force') args.force = true
    else if (arg === '--include-media') args.includeMedia = true
    else if (arg === '--db') args.db = argv[++index] ?? null
    else if (arg === '--data-root') args.dataRoot = argv[++index] ?? null
    else if (arg === '--out') args.out = argv[++index] ?? null
    else if (arg === '--media-root') args.mediaRoot = argv[++index] ?? null
    else if (arg === '--sign-key') args.signKey = argv[++index] ?? null
    else if (arg === '--keep') args.keep = argv[++index] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function fail(message, exitCode) {
  process.stderr.write(`db-backup: ${message}\n`)
  process.exit(exitCode)
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  fail(`${error.message}\n${usage()}`, 2)
}
if (args.help) {
  process.stderr.write(`${usage()}\n`)
  process.exit(0)
}
if (args.keep !== null) {
  if (!/^\d+$/.test(String(args.keep).trim())) fail(`--keep 需要一个整数，收到 ${JSON.stringify(args.keep)}\n${usage()}`, 2)
  args.keep = Number(String(args.keep).trim())
  if (args.keep < 1) fail(`--keep 必须 >= 1（0 会删掉所有备份）\n${usage()}`, 2)
}
if (args.mediaRoot !== null && !args.includeMedia) {
  fail(`--media-root 只能与 --include-media 一起使用\n${usage()}`, 2)
}
if (args.signKey !== null && String(args.signKey).trim() === '') fail(`--sign-key 需要一个文件路径\n${usage()}`, 2)

const sourcePath = resolveDatabasePath({ db: args.db, dataRoot: args.dataRoot })
const destDir = args.out === null ? defaultBackupDir(sourcePath) : resolve(args.out)
const crashAt = process.env.ACEPASS_DB_CRASH_AT ?? ''

try {
  const signingKey = loadSigningKey({ path: args.signKey })
  const result = await backupDatabase({
    sourcePath,
    destDir,
    force: args.force,
    includeMedia: args.includeMedia,
    mediaRoot: args.mediaRoot ?? undefined,
    signingKey,
    onStage: (stage) => {
      // Crash drill hook: only active when the operator/test sets the env var.
      if (crashAt !== '' && crashAt === stage) process.kill(process.pid, 'SIGKILL')
    },
  })
  let rotation = null
  if (args.keep !== null) {
    // Rotation runs after a successful backup; the listing is printed with the summary below.
    rotation = rotateBackups({ directory: dirname(destDir), keep: args.keep, protect: [destDir] })
  }
  const media = result.manifest.media
  const summary = {
    ok: true,
    source: sourcePath,
    backup: result.destDir,
    tables: result.manifest.tables.length,
    rows: result.manifest.total_rows,
    schema_version: result.manifest.integrity.schema_version,
    snapshot_sha256: result.manifest.snapshot.sha256,
    snapshot_bytes: result.manifest.snapshot.bytes,
    media: media.included
      ? { included: true, files: media.file_count ?? 0, bytes: media.total_bytes ?? 0 }
      : { included: false },
    signed: result.manifest.signature !== undefined,
    signature_algorithm: result.manifest.signature?.algorithm ?? null,
    rotation:
      rotation === null
        ? null
        : { keep: rotation.keep, kept: rotation.kept.length, deleted: rotation.deleted.map((path) => path.split('/').pop()), skipped: rotation.skipped.length },
    warnings: result.warnings,
  }
  process.stderr.write(
    `db:backup ok — ${summary.tables} 张表 / ${summary.rows} 行 → ${summary.backup}\n` +
      `  sha256 ${summary.snapshot_sha256}\n` +
      (media.included
        ? `  媒体 ${summary.media.files} 个文件 / ${summary.media.bytes} 字节（manifest 逐文件 sha256）\n`
        : '') +
      (summary.signed ? `  manifest 已签名（${summary.signature_algorithm}）\n` : '') +
      summary.warnings.map((warning) => `  warning: ${warning}\n`).join(''),
  )
  if (rotation !== null) {
    const name = (path) => path.split('/').pop() ?? path
    process.stderr.write(
      `db:backup 轮转 --keep ${rotation.keep}（${rotation.directory}）\n` +
        `  保留 ${rotation.kept.length} 份：${rotation.kept.map(name).join(', ') || '(无)'}\n` +
        `  删除 ${rotation.deleted.length} 份：${rotation.deleted.map(name).join(', ') || '(无)'}\n` +
        (rotation.skipped.length === 0
          ? ''
          : `  跳过 ${rotation.skipped.length} 个非本工具目录：${rotation.skipped
              .map((entry) => `${name(entry.path)}（${entry.reason}）`)
              .join(', ')}\n`) +
        rotation.failed.map((entry) => `  warning: 无法删除 ${entry.path}：${entry.error}\n`).join(''),
    )
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} catch (error) {
  if (error instanceof BackupFailure) {
    process.stderr.write(`db-backup: ${error.message}\n`)
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, kind: error.kind, message: error.message, details: error.details })}\n`)
    process.exit(error.kind === 'refused' ? 4 : error.kind === 'verification' ? 3 : 1)
  }
  process.stderr.write(`db-backup: ${error?.stack ?? error}\n`)
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'internal_error', message: String(error?.message ?? error) })}\n`)
  process.exit(1)
}
