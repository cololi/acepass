#!/usr/bin/env node
/**
 * Restore (or verify) a `.acepass` SQLite backup, optionally including its private media tree.
 *
 *   npm run db:restore -- --backup <dir> --db <path> [--force]
 *   npm run db:verify  -- --backup <dir> [--sign-key <path>]
 *   npm run db:restore -- --backup <dir> --data-root <dir> --force --restore-media --sign-key <path>
 *
 * Restore refuses a non-empty target unless `--force`; before replacing it, the current target is
 * snapshotted to `<target>.pre-restore-<ts>/acepass.sqlite`, and the restored file is verified
 * against the backup manifest. A failure after the replacement rolls the safety copy back.
 *
 * `--restore-media` also puts the archived media tree back under `<dataRoot>/private-media`. Media are
 * restored **before** the database (an old database beside new objects only leaves unreferenced files,
 * while a new database beside missing objects has broken references). Existing media files are never
 * overwritten without `--force`; an overwrite first copies the old bytes to
 * `<mediaRoot>.pre-restore-<ts>/`, and any failure while applying rewinds every file. Files in the
 * media root that the backup does not mention are left untouched.
 *
 * `--sign-key <path>` (or `ACEPASS_BACKUP_SIGNING_KEY` / `ACEPASS_BACKUP_SIGNING_KEY_FILE`) is
 * required to verify a signed manifest, and a key configured against an unsigned manifest is refused
 * (so a signature cannot simply be stripped). Without a key, behaviour is exactly the unsigned one.
 *
 * The restore contract is offline: stop the DSH app first (a live `-wal` is refused without
 * `--force`, because replacing a database under a running writer corrupts the writer's view).
 *
 * Exit codes: 0 ok, 1 failure, 2 bad arguments, 3 verification failure, 4 refused.
 */
import { resolve } from 'node:path'
import {
  BackupFailure,
  loadSigningKey,
  resolveDatabasePath,
  restoreDatabase,
  verifyBackupDirectory,
} from '../src/migrate/backup.ts'

function usage() {
  return [
    'usage: db-restore.mjs --backup <dir> [--db <path> | --data-root <dir>] [--force] [--verify-only]',
    '                       [--restore-media] [--media-root <dir>] [--sign-key <path>]',
    '',
    '  --backup <dir>     backup directory produced by db-backup.mjs',
    '  --db <path>        target .acepass SQLite file (default: ACEPASS_DB, else <cwd>/.acepass/acepass.sqlite)',
    '  --data-root <dir>  directory that owns acepass.sqlite (alternative to --db)',
    '  --force            overwrite a non-empty target / one with an unmerged WAL / differing media files',
    '  --verify-only      validate the backup directory (manifest, signature, snapshot, media) and stop',
    '  --restore-media    also restore the archived media tree (needs a backup made with --include-media)',
    '  --media-root <dir> media root to restore into (default: <target dir>/private-media)',
    '  --sign-key <path>  HMAC-SHA256 key used to verify a signed manifest (>= 16 bytes)',
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
    backup: null,
    db: null,
    dataRoot: null,
    mediaRoot: null,
    signKey: null,
    force: false,
    verifyOnly: false,
    restoreMedia: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--force') args.force = true
    else if (arg === '--verify-only') args.verifyOnly = true
    else if (arg === '--restore-media') args.restoreMedia = true
    else if (arg === '--backup') args.backup = argv[++index] ?? null
    else if (arg === '--db') args.db = argv[++index] ?? null
    else if (arg === '--data-root') args.dataRoot = argv[++index] ?? null
    else if (arg === '--media-root') args.mediaRoot = argv[++index] ?? null
    else if (arg === '--sign-key') args.signKey = argv[++index] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function fail(message, exitCode) {
  process.stderr.write(`db-restore: ${message}\n`)
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
if (args.backup === null) fail(`--backup is required\n${usage()}`, 2)
if (args.mediaRoot !== null && !args.restoreMedia) {
  fail(`--media-root 只能与 --restore-media 一起使用\n${usage()}`, 2)
}
if (args.signKey !== null && String(args.signKey).trim() === '') fail(`--sign-key 需要一个文件路径\n${usage()}`, 2)

const crashAt = process.env.ACEPASS_DB_CRASH_AT ?? ''

try {
  const signingKey = loadSigningKey({ path: args.signKey })
  if (args.verifyOnly) {
    const verified = await verifyBackupDirectory(resolve(args.backup), { signingKey })
    const summary = {
      ok: true,
      verified: true,
      backup: resolve(args.backup),
      created_at: verified.manifest.created_at,
      tables: verified.manifest.tables.length,
      rows: verified.manifest.total_rows,
      schema_version: verified.manifest.integrity.schema_version,
      snapshot_sha256: verified.manifest.snapshot.sha256,
      signed: verified.manifest.signature !== undefined,
      media: verified.media === null
        ? { included: false }
        : { included: true, files: verified.media.file_count, bytes: verified.media.total_bytes },
      warnings: verified.warnings,
    }
    process.stderr.write(
      `db:verify ok — ${summary.tables} 张表 / ${summary.rows} 行，sha256 ${summary.snapshot_sha256}\n` +
        (summary.signed ? '  manifest 签名有效（hmac-sha256）\n' : '  manifest 未签名\n') +
        (summary.media.included
          ? `  媒体 ${summary.media.files} 个文件 / ${summary.media.bytes} 字节，逐文件 sha256 一致\n`
          : '') +
        summary.warnings.map((warning) => `  warning: ${warning}\n`).join(''),
    )
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } else {
    const targetPath = resolveDatabasePath({ db: args.db, dataRoot: args.dataRoot })
    const result = await restoreDatabase({
      backupDir: resolve(args.backup),
      targetPath,
      force: args.force,
      restoreMedia: args.restoreMedia,
      mediaRoot: args.mediaRoot ?? undefined,
      signingKey,
      onStage: (stage) => {
        if (crashAt !== '' && crashAt === stage) process.kill(process.pid, 'SIGKILL')
      },
    })
    const summary = {
      ok: true,
      restored: result.targetPath,
      backup: result.backupDir,
      tables: result.manifest.tables.length,
      rows: result.manifest.total_rows,
      schema_version: result.manifest.integrity.schema_version,
      signed: result.manifest.signature !== undefined,
      safety_copy: result.safetyCopy,
      media:
        result.media === null
          ? null
          : {
              restored: result.media.restored,
              overwritten: result.media.overwritten,
              unchanged: result.media.unchanged,
              bytes: result.media.bytes,
              safety_copy: result.media.safetyDir,
            },
      warnings: result.warnings,
    }
    process.stderr.write(
      `db:restore ok — ${summary.tables} 张表 / ${summary.rows} 行 → ${summary.restored}\n` +
        (summary.safety_copy === null ? '' : `  恢复前副本：${summary.safety_copy}\n`) +
        (result.media === null
          ? ''
          : `  媒体：新建 ${result.media.restored} / 覆盖 ${result.media.overwritten} / 未变 ${result.media.unchanged}（${result.media.bytes} 字节）\n` +
            (result.media.safetyDir === null ? '' : `  媒体恢复前副本：${result.media.safetyDir}\n`)) +
        summary.warnings.map((warning) => `  warning: ${warning}\n`).join(''),
    )
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  }
} catch (error) {
  if (error instanceof BackupFailure) {
    process.stderr.write(`db-restore: ${error.message}\n`)
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, kind: error.kind, message: error.message, details: error.details })}\n`)
    process.exit(error.kind === 'refused' ? 4 : error.kind === 'verification' ? 3 : 1)
  }
  process.stderr.write(`db-restore: ${error?.stack ?? error}\n`)
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'internal_error', message: String(error?.message ?? error) })}\n`)
  process.exit(1)
}
