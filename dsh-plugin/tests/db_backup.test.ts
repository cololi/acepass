import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { ensureOwner } from '../src/services/accounts.ts'
import { createProject, createSubject } from '../src/services/exams.ts'
import { insertRow } from '../src/store/repository.ts'
import { TABLES } from '../src/store/schema.generated.ts'
import {
  BackupFailure,
  SIGNATURE_ALGORITHM,
  backupDatabase,
  checkManifestSignature,
  inspectSnapshot,
  loadSigningKey,
  resolveDatabasePath,
  restoreBackupMedia,
  restoreDatabase,
  rotateBackups,
  signManifest,
  verifyBackupDirectory,
} from '../src/migrate/backup.ts'

/**
 * Backup/restore is only trustworthy if it is exercised as an operator would run it: real files,
 * real child processes, and kills at the exact points where a naive `cp` would corrupt the store.
 *
 * The drills below cover:
 *  - an online snapshot while another process is committing rows;
 *  - a backup killed after the snapshot but before the rename (no artifact, stale partial cleaned);
 *  - a restore killed before and after the rename (old data intact / new data + valid file);
 *  - a post-restore verification failure rolling the safety copy back;
 *  - checksum and manifest tampering being refused;
 *  - WAL content that was committed but not checkpointed still being in the backup;
 *  - `--include-media`: per-file sha256/bytes/path in the manifest, symlinks refused, missing /
 *    tampered / extra archived files refused, media restored byte-identically, immutable when the
 *    database restore is refused, and a failed media apply rewinding every file;
 *  - `--keep N` rotation that only ever deletes directories identifying themselves as this tool's
 *    output, and never the backup just written;
 *  - optional HMAC-SHA256 manifest signatures: verified with the key, refused without it, tampering
 *    detected, and the key absent from every artifact and every line of output.
 */

const PLUGIN = process.cwd()
const NOW = parseInstant('2027-04-01T00:00:00+00:00')
const NOW_DATE = new Date(Number(NOW / 1000n))

function seedStore(path: string, projectName = '备份项目') {
  const handle = openStore({ path })
  const userId = ensureOwner(handle.db, NOW)
  const project = createProject(handle.db, userId, { name: projectName }, NOW)
  createSubject(handle.db, userId, String(project.id), { name: '科目' }, NOW)
  return { handle, userId, projectId: String(project.id) }
}

function fillRows(path: string, count: number): void {
  const handle = openStore({ path })
  const userId = ensureOwner(handle.db, NOW)
  for (let index = 0; index < count; index += 1) {
    insertRow(
      handle.db,
      'audit_idempotency_record',
      {
        user_id: userId,
        route_scope: 'drill',
        idempotency_key: `k${index}`,
        request_fingerprint: `f${index}`,
        status_code: 200,
        response_body: { blob: 'y'.repeat(500) },
        resource_type: '',
        resource_id: '',
        created_at: NOW,
        updated_at: NOW,
      },
      { now: NOW },
    )
  }
  handle.close()
}

function projectNames(path: string): string[] {
  const handle = openStore({ path })
  try {
    return (handle.db.prepare('SELECT name FROM "exams_project" ORDER BY name').all() as { name: string }[]).map(
      (row) => row.name,
    )
  } finally {
    handle.close()
  }
}

function rowCount(path: string, table: string): number {
  const handle = openStore({ path })
  try {
    return Number((handle.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n)
  } finally {
    handle.close()
  }
}

function cli(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: PLUGIN,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n').filter((line) => line.trim() !== '')
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
}

/** A writer process that keeps committing rows for a fixed wall-clock window. */
function startWriter(workDir: string, dbPath: string): { child: ReturnType<typeof spawn>; done: Promise<number> } {
  const script = join(workDir, 'writer.mjs')
  writeFileSync(
    script,
    [
      `import { openStore } from ${JSON.stringify(pathToFileURL(join(PLUGIN, 'src/store/db.ts')).href)}`,
      `import { fromDate } from ${JSON.stringify(pathToFileURL(join(PLUGIN, 'src/domain/instant.ts')).href)}`,
      `import { insertRow } from ${JSON.stringify(pathToFileURL(join(PLUGIN, 'src/store/repository.ts')).href)}`,
      `const handle = openStore({ path: ${JSON.stringify(dbPath)} })`,
      `const user = handle.db.prepare('SELECT id FROM "accounts_user"').get().id`,
      `const now = fromDate(new Date())`,
      `let written = 0`,
      `const until = Date.now() + 1200`,
      `while (Date.now() < until) {`,
      `  insertRow(handle.db, 'audit_idempotency_record', {`,
      `    user_id: user, route_scope: 'live', idempotency_key: 'w' + written,`,
      `    request_fingerprint: 'wf' + written, status_code: 200,`,
      `    response_body: { blob: 'z'.repeat(500) }, resource_type: '', resource_id: '',`,
      `    created_at: now, updated_at: now,`,
      `  }, { now })`,
      `  written += 1`,
      `}`,
      `handle.close()`,
      `console.log(written)`,
    ].join('\n'),
    'utf8',
  )
  const child = spawn(process.execPath, ['--experimental-strip-types', script], { cwd: PLUGIN, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  const done = new Promise<number>((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise(Number(stdout.trim() || 0))
      else reject(new Error(`writer exited with ${code}`))
    })
  })
  return { child, done }
}

test('db backup: an online snapshot carries counts, digests and a checksum that verify', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbbackup-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const result = await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    assert.equal(result.manifest.tables.length, TABLES.length, 'every business table is described')
    assert.equal(result.manifest.total_rows, 3)
    assert.equal(result.manifest.integrity.check, 'ok')
    assert.equal(result.manifest.integrity.foreign_key_violations, 0)
    assert.equal(result.manifest.integrity.schema_version, 1)
    assert.ok(existsSync(join(result.destDir, 'acepass.sqlite')))
    assert.ok(!existsSync(join(result.destDir, 'acepass.sqlite-wal')), 'the snapshot is a single file')
    assert.ok(!existsSync(join(result.destDir, 'acepass.sqlite-shm')))
    const verified = await verifyBackupDirectory(result.destDir)
    assert.equal(verified.manifest.snapshot.sha256, result.manifest.snapshot.sha256)
    assert.deepEqual(
      verified.inspection.tables.map((table) => table.name),
      TABLES.map((table) => table.name),
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db backup: a writer committing during the snapshot does not starve or tear it', { timeout: 30_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dblive-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    fillRows(source, 800)
    const before = rowCount(source, 'audit_idempotency_record')
    const writer = startWriter(work, source)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    const result = await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    const written = await writer.done
    const after = rowCount(source, 'audit_idempotency_record')
    const snapshotRows = result.manifest.tables.find((table) => table.name === 'audit_idempotency_record')!.rows
    assert.ok(written > 0, 'the writer must actually have committed rows during the snapshot')
    assert.ok(snapshotRows >= before, `snapshot ${snapshotRows} must include the pre-existing rows ${before}`)
    assert.ok(snapshotRows <= after, `snapshot ${snapshotRows} cannot be ahead of the final store ${after}`)
    const verified = await verifyBackupDirectory(result.destDir)
    assert.equal(verified.inspection.foreign_key_violations, 0)
    assert.equal(verified.inspection.schema_version, 1)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db backup: rows committed to the WAL but not checkpointed are in the snapshot', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbwal-'))
  try {
    const source = join(work, 'acepass.sqlite')
    const seeded = seedStore(source)
    // Keep the connection open: the newest commit lives in the WAL, not the main file.
    const result = await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    seeded.handle.close()
    assert.equal(result.manifest.total_rows, 3)
    const verified = await verifyBackupDirectory(result.destDir)
    const snapshot = openStore({ path: join(result.destDir, 'acepass.sqlite') })
    try {
      assert.deepEqual(
        (snapshot.db.prepare('SELECT name FROM "exams_project"').all() as { name: string }[]).map((row) => row.name),
        ['备份项目'],
      )
    } finally {
      snapshot.close()
    }
    assert.equal(verified.inspection.schema_version, 1)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore: a verified backup restores into a fresh file with identical data', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbrestore-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source, '恢复源').handle.close()
    const backup = await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    const target = join(work, 'restored.sqlite')
    const restored = await restoreDatabase({ backupDir: backup.destDir, targetPath: target, now: NOW_DATE })
    assert.equal(restored.safetyCopy, null, 'a target that did not exist has nothing to preserve')
    assert.deepEqual(projectNames(target), ['恢复源'])
    const inspection = inspectSnapshot(target)
    assert.equal(inspection.total_rows, backup.manifest.total_rows)
    for (const expected of backup.manifest.tables) {
      const actual = inspection.tables.find((table) => table.name === expected.name)!
      assert.equal(actual.rows, expected.rows, `${expected.name} rows`)
      assert.equal(actual.digest, expected.digest, `${expected.name} digest`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore: a non-empty target is refused without --force, and preserved with it', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbrefuse-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source, '新数据').handle.close()
    const backup = await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    const target = join(work, 'target.sqlite')
    seedStore(target, '旧数据').handle.close()

    await assert.rejects(
      () => restoreDatabase({ backupDir: backup.destDir, targetPath: target, now: NOW_DATE }),
      (error: unknown) => {
        assert.ok(error instanceof BackupFailure)
        assert.equal(error.code, 'target_not_empty')
        assert.equal(error.kind, 'refused')
        return true
      },
    )
    assert.deepEqual(projectNames(target), ['旧数据'], 'the refused target is untouched')

    const restored = await restoreDatabase({
      backupDir: backup.destDir,
      targetPath: target,
      force: true,
      now: NOW_DATE,
    })
    assert.ok(restored.safetyCopy !== null)
    assert.deepEqual(projectNames(target), ['新数据'])
    assert.deepEqual(projectNames(restored.safetyCopy!), ['旧数据'], 'the safety copy is the old store')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore: a tampered snapshot or manifest is refused before the target is touched', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbtamper-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const backup = await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    const target = join(work, 'target.sqlite')
    seedStore(target, '原样').handle.close()

    // 1. Flip one byte of the snapshot: the manifest's sha256 no longer matches.
    const snapshotPath = join(backup.destDir, 'acepass.sqlite')
    const bytes = readFileSync(snapshotPath)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256
    writeFileSync(snapshotPath, bytes)
    await assert.rejects(
      () => verifyBackupDirectory(backup.destDir),
      (error: unknown) => {
        assert.ok(error instanceof BackupFailure)
        assert.equal(error.code, 'snapshot_checksum_mismatch')
        return true
      },
    )
    assert.deepEqual(projectNames(target), ['原样'])

    // 2. Rewrite the manifest with a wrong digest: the checksum passes but the rows do not.
    const second = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'backup2'),
      now: NOW_DATE,
    })
    const manifestPath = join(second.destDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      tables: { name: string; digest: string }[]
    }
    manifest.tables[0]!.digest = '0'.repeat(64)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await assert.rejects(
      () => verifyBackupDirectory(second.destDir),
      (error: unknown) => {
        assert.ok(error instanceof BackupFailure)
        assert.equal(error.code, 'backup_invalid')
        return true
      },
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db backup drill: a kill after the snapshot leaves no artifact and the rerun cleans the partial', () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbkillbackup-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const out = join(work, 'backup')
    const killed = cli('scripts/db-backup.mjs', ['--db', source, '--out', out], {
      ACEPASS_DB_CRASH_AT: 'snapshot',
    })
    assert.notEqual(killed.status, 0, 'the killed process must not report success')
    assert.ok(!existsSync(out), 'a kill before the rename must not leave a backup directory')
    const partials = readdirSync(work).filter((entry) => entry.startsWith('backup.partial-'))
    assert.equal(partials.length, 1, 'the incomplete work is visible as a partial directory')

    const rerun = cli('scripts/db-backup.mjs', ['--db', source, '--out', out])
    assert.equal(rerun.status, 0, rerun.stderr)
    assert.ok(existsSync(join(out, 'manifest.json')))
    assert.equal(
      readdirSync(work).filter((entry) => entry.startsWith('backup.partial-')).length,
      0,
      'the stale partial is removed by the next run',
    )
    const summary = lastJson(rerun.stdout)
    assert.equal(summary.ok, true)
    assert.ok(String(summary.snapshot_sha256).length === 64)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore drill: a kill before the rename keeps the old store, after it the new one', () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbkillrestore-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source, '新数据').handle.close()
    const backup = cli('scripts/db-backup.mjs', ['--db', source, '--out', join(work, 'backup')])
    assert.equal(backup.status, 0, backup.stderr)
    const target = join(work, 'target.sqlite')
    seedStore(target, '旧数据').handle.close()

    // Kill after the copy, before the rename: the target must still be the old store.
    const beforeRename = cli(
      'scripts/db-restore.mjs',
      ['--backup', join(work, 'backup'), '--db', target, '--force'],
      { ACEPASS_DB_CRASH_AT: 'copied' },
    )
    assert.notEqual(beforeRename.status, 0)
    assert.deepEqual(projectNames(target), ['旧数据'])
    assert.ok(
      readdirSync(work).some((entry) => entry.startsWith('target.sqlite.restore-')),
      'the copied snapshot is left as a visible temp file',
    )

    // Kill after the rename, before verification: the target is the new store, still valid.
    const afterRename = cli(
      'scripts/db-restore.mjs',
      ['--backup', join(work, 'backup'), '--db', target, '--force'],
      { ACEPASS_DB_CRASH_AT: 'renamed' },
    )
    assert.notEqual(afterRename.status, 0)
    assert.deepEqual(projectNames(target), ['新数据'])

    // A clean rerun succeeds and verifies the restored file.
    const rerun = cli('scripts/db-restore.mjs', ['--backup', join(work, 'backup'), '--db', target, '--force'])
    assert.equal(rerun.status, 0, rerun.stderr)
    assert.deepEqual(projectNames(target), ['新数据'])
    assert.equal(lastJson(rerun.stdout).ok, true)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore: a post-restore verification failure rolls the safety copy back', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbrollback-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source, '新数据').handle.close()
    const backup = await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    const target = join(work, 'target.sqlite')
    seedStore(target, '旧数据').handle.close()

    await assert.rejects(
      () =>
        restoreDatabase({
          backupDir: backup.destDir,
          targetPath: target,
          force: true,
          now: NOW_DATE,
          onStage: (stage) => {
            // Simulate a restored file that fails verification (disk fault, concurrent writer...).
            if (stage === 'renamed') writeFileSync(target, 'not a database any more')
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof BackupFailure)
        assert.equal(error.code, 'restore_failed')
        assert.equal((error.details as Record<string, unknown>).rolled_back, true)
        return true
      },
    )
    assert.deepEqual(projectNames(target), ['旧数据'], 'the safety copy is back in place')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db path: explicit --db wins, then --data-root, then the environment, then cwd', () => {
  assert.equal(resolveDatabasePath({ db: '/tmp/x.sqlite', dataRoot: '/tmp/root' }), '/tmp/x.sqlite')
  assert.equal(resolveDatabasePath({ dataRoot: '/tmp/root' }), '/tmp/root/acepass.sqlite')
  assert.equal(
    resolveDatabasePath({ env: { ACEPASS_DB: '/tmp/env.sqlite', ACEPASS_DATA_ROOT: '/tmp/envroot' } }),
    '/tmp/env.sqlite',
  )
  assert.equal(resolveDatabasePath({ env: { ACEPASS_DATA_ROOT: '/tmp/envroot' } }), '/tmp/envroot/acepass.sqlite')
  assert.equal(resolveDatabasePath({ cwd: '/tmp/cwd', env: {} }), '/tmp/cwd/.acepass/acepass.sqlite')
})

test('db backup: a missing source and an existing destination are refused with actionable codes', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbrefuse2-'))
  try {
    await assert.rejects(
      () => backupDatabase({ sourcePath: join(work, 'nope.sqlite'), destDir: join(work, 'backup') }),
      (error: unknown) => error instanceof BackupFailure && error.code === 'source_missing',
    )
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    await backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE })
    await assert.rejects(
      () => backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), now: NOW_DATE }),
      (error: unknown) => error instanceof BackupFailure && error.code === 'destination_exists',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db backup: the manifest is deterministic apart from the timestamp', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbdet-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const first = await backupDatabase({ sourcePath: source, destDir: join(work, 'b1'), now: NOW_DATE })
    const second = await backupDatabase({ sourcePath: source, destDir: join(work, 'b2'), now: NOW_DATE })
    assert.equal(first.manifest.snapshot.sha256, second.manifest.snapshot.sha256)
    assert.deepEqual(first.manifest.tables, second.manifest.tables)
    assert.equal(first.manifest.created_at, second.manifest.created_at)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------------------------- *
 * Shared fixtures for the media/signature/rotation cases
 * -------------------------------------------------------------------------------------------- */

/** A small but structurally realistic private-media tree (nested keys, non-ASCII, binary bytes). */
const MEDIA_FILES: Record<string, string | Buffer> = {
  'nested/deep/dir/x.bin': Buffer.from('0123456789'.repeat(100)),
  'top.txt': 'top-level',
  'u/1a/aa11.pdf': Buffer.from('%PDF-1.4 first page\n%%EOF\n'),
  'u/1a/bb22.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
  'u/2c/题-1.txt': '题干'.repeat(40),
}

/** Byte total of the fixture tree, computed so the assertion cannot drift from the data. */
const MEDIA_TOTAL_BYTES = Object.values(MEDIA_FILES).reduce<number>(
  (sum, content) => sum + (typeof content === 'string' ? Buffer.byteLength(content) : content.length),
  0,
)

const SIGN_KEY = 'b10-test-signing-key-0123456789abcdef'
const WRONG_KEY = 'b10-test-signing-key-fedcba9876543210'

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeMediaTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

/** `{relative path → sha256}` for every regular file under `root` (missing root → empty). */
function mediaDigests(root: string): Record<string, string> {
  const digests: Record<string, string> = {}
  if (!existsSync(root)) return digests
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) digests[relative] = sha256Bytes(readFileSync(absolute))
    }
  }
  walk(root, '')
  return digests
}

function mediaPath(root: string, relative: string): string {
  return join(root, ...relative.split('/'))
}

function backupFailure(predicate: (failure: BackupFailure) => boolean) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BackupFailure, `expected a BackupFailure, got ${String(error)}`)
    return predicate(error)
  }
}

/* -------------------------------------------------------------------------------------------- *
 * --include-media
 * -------------------------------------------------------------------------------------------- */

test('db backup --include-media: every media file is archived with path, bytes and sha256', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmedia-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const mediaRoot = join(work, 'private-media')
    writeMediaTree(mediaRoot, MEDIA_FILES)
    const expected = mediaDigests(mediaRoot)

    const result = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'backup'),
      includeMedia: true,
      now: NOW_DATE,
    })
    const media = result.manifest.media
    assert.equal(media.included, true)
    assert.equal(media.root, mediaRoot)
    assert.equal(media.dest, 'media')
    assert.equal(media.file_count, Object.keys(expected).length)
    assert.deepEqual(
      (media.files ?? []).map((file) => file.path),
      Object.keys(expected).sort(),
      'entries are sorted by relative path',
    )
    for (const file of media.files ?? []) {
      assert.equal(file.sha256, expected[file.path], `${file.path} sha256`)
      assert.equal(file.bytes, statSync(mediaPath(mediaRoot, file.path)).size, `${file.path} bytes`)
      assert.ok(!file.path.startsWith('/'), 'paths are stored relative to the media root')
    }
    assert.equal(
      media.total_bytes,
      Object.keys(expected).reduce((sum, relative) => sum + statSync(mediaPath(mediaRoot, relative)).size, 0),
      'total_bytes is the sum of the per-file sizes',
    )
    assert.equal(media.total_bytes, MEDIA_TOTAL_BYTES)
    // The archived bytes are the source bytes — proven by re-hashing the copy.
    assert.deepEqual(mediaDigests(join(result.destDir, 'media')), expected)

    const verified = await verifyBackupDirectory(result.destDir)
    assert.equal(verified.media?.file_count, media.file_count)
    assert.equal(verified.media?.total_bytes, media.total_bytes)

    // Without the flag the artifact is still database-only (and byte-compatible with B9 manifests).
    const plain = await backupDatabase({ sourcePath: source, destDir: join(work, 'plain'), now: NOW_DATE })
    assert.equal(plain.manifest.media.included, false)
    assert.equal(plain.manifest.media.files, undefined)
    assert.ok(!existsSync(join(plain.destDir, 'media')))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db backup --include-media: a missing root is refused, an empty one archives zero files', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmedia2-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()

    await assert.rejects(
      () => backupDatabase({ sourcePath: source, destDir: join(work, 'b1'), includeMedia: true, now: NOW_DATE }),
      backupFailure((failure) => failure.code === 'media_root_missing' && failure.kind === 'refused'),
    )
    assert.ok(!existsSync(join(work, 'b1')), 'a refused backup leaves no artifact')

    mkdirSync(join(work, 'private-media'))
    const empty = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'b2'),
      includeMedia: true,
      now: NOW_DATE,
    })
    assert.equal(empty.manifest.media.included, true)
    assert.equal(empty.manifest.media.file_count, 0)
    assert.deepEqual(empty.manifest.media.files, [])
    assert.equal((await verifyBackupDirectory(empty.destDir)).media?.file_count, 0)

    // `mediaRoot` without `includeMedia` would be silently ignored, so it is refused instead.
    await assert.rejects(
      () =>
        backupDatabase({
          sourcePath: source,
          destDir: join(work, 'b3'),
          mediaRoot: join(work, 'private-media'),
          now: NOW_DATE,
        }),
      backupFailure((failure) => failure.code === 'media_flag_required' && failure.kind === 'refused'),
    )
    assert.ok(!existsSync(join(work, 'b3')))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db backup --include-media: a symlink in the media tree is refused, never followed', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmedialink-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const mediaRoot = join(work, 'private-media')
    writeMediaTree(mediaRoot, { 'ok.txt': 'ok' })
    const outside = join(work, 'outside-secret.txt')
    writeFileSync(outside, 'must not be archived')
    symlinkSync(outside, join(mediaRoot, 'leak.txt'))

    await assert.rejects(
      () => backupDatabase({ sourcePath: source, destDir: join(work, 'backup'), includeMedia: true, now: NOW_DATE }),
      backupFailure((failure) => failure.code === 'media_unsupported_entry' && failure.kind === 'refused'),
    )
    assert.ok(!existsSync(join(work, 'backup')), 'nothing is committed when the tree cannot be archived')
    assert.equal(
      readdirSync(work).filter((entry) => entry.includes('.partial-')).length,
      0,
      'the partial directory is not left behind',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db verify --include-media: missing, tampered and extra archived files are all refused', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmediaverify-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    writeMediaTree(join(work, 'private-media'), MEDIA_FILES)
    const make = (name: string) =>
      backupDatabase({ sourcePath: source, destDir: join(work, name), includeMedia: true, now: NOW_DATE })

    // 1. A file the manifest lists but the artifact does not contain.
    const missing = await make('missing')
    rmSync(join(missing.destDir, 'media', 'top.txt'))
    await assert.rejects(
      () => verifyBackupDirectory(missing.destDir),
      backupFailure((failure) => failure.code === 'media_file_missing' && failure.kind === 'verification'),
    )

    // 2. Same byte length, different bytes: only the per-file sha256 can catch this.
    const tampered = await make('tampered')
    writeFileSync(join(tampered.destDir, 'media', 'top.txt'), 'TOP-LEVEL')
    assert.equal(statSync(join(tampered.destDir, 'media', 'top.txt')).size, Buffer.byteLength('top-level'))
    await assert.rejects(
      () => verifyBackupDirectory(tampered.destDir),
      backupFailure((failure) => failure.code === 'media_checksum_mismatch' && failure.kind === 'verification'),
    )

    // 3. A file the artifact contains but the manifest does not describe.
    const extra = await make('extra')
    writeFileSync(join(extra.destDir, 'media', 'planted.txt'), 'planted')
    await assert.rejects(
      () => verifyBackupDirectory(extra.destDir),
      backupFailure((failure) => failure.code === 'media_unexpected_file' && failure.kind === 'verification'),
    )

    // 4. A signed manifest is checked before the media tree, so tampering cannot be hidden by
    //    rebuilding an unsigned artifact around it.
    const signed = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'signed'),
      includeMedia: true,
      signingKey: SIGN_KEY,
      now: NOW_DATE,
    })
    assert.ok((await verifyBackupDirectory(signed.destDir, { signingKey: SIGN_KEY })).media)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------------------------- *
 * --restore-media
 * -------------------------------------------------------------------------------------------- */

test('db restore --restore-media: files land byte-identical, and a rerun changes nothing', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmediarestore-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    writeMediaTree(join(work, 'private-media'), MEDIA_FILES)
    const expected = mediaDigests(join(work, 'private-media'))
    const backup = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'backup'),
      includeMedia: true,
      now: NOW_DATE,
    })
    const restoredRoot = join(work, 'restored-media')
    const first = await restoreBackupMedia({
      backupDir: backup.destDir,
      mediaRoot: restoredRoot,
      now: NOW_DATE,
    })
    assert.equal(first.restored, Object.keys(expected).length)
    assert.equal(first.overwritten, 0)
    assert.equal(first.unchanged, 0)
    assert.equal(first.safetyDir, null, 'nothing existed, so nothing had to be preserved')
    assert.equal(first.bytes, backup.manifest.media.total_bytes)
    assert.deepEqual(mediaDigests(restoredRoot), expected)

    const second = await restoreBackupMedia({
      backupDir: backup.destDir,
      mediaRoot: restoredRoot,
      now: NOW_DATE,
    })
    assert.equal(second.restored, 0)
    assert.equal(second.overwritten, 0)
    assert.equal(second.unchanged, Object.keys(expected).length, 'identical files are not rewritten')
    assert.equal(second.safetyDir, null)
    assert.deepEqual(
      readdirSync(work).filter((entry) => entry.includes('.restore-')),
      [],
      'the staging directory is removed',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore --restore-media: a differing file needs --force and is copied aside first', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmediaforce-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    writeMediaTree(join(work, 'private-media'), MEDIA_FILES)
    const backup = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'backup'),
      includeMedia: true,
      now: NOW_DATE,
    })
    const targetRoot = join(work, 'existing-media')
    writeMediaTree(targetRoot, { 'top.txt': 'OLD-CONTENT' })

    await assert.rejects(
      () => restoreBackupMedia({ backupDir: backup.destDir, mediaRoot: targetRoot, now: NOW_DATE }),
      backupFailure((failure) => failure.code === 'media_exists' && failure.kind === 'refused'),
    )
    assert.equal(readFileSync(join(targetRoot, 'top.txt'), 'utf8'), 'OLD-CONTENT', 'a refused restore writes nothing')
    assert.deepEqual(mediaDigests(targetRoot), { 'top.txt': sha256Bytes('OLD-CONTENT') })

    const forced = await restoreBackupMedia({
      backupDir: backup.destDir,
      mediaRoot: targetRoot,
      force: true,
      now: NOW_DATE,
    })
    assert.equal(forced.overwritten, 1)
    assert.equal(forced.restored, Object.keys(MEDIA_FILES).length - 1)
    assert.ok(forced.safetyDir !== null)
    assert.equal(readFileSync(join(targetRoot, 'top.txt'), 'utf8'), 'top-level')
    assert.equal(
      readFileSync(join(forced.safetyDir!, 'top.txt'), 'utf8'),
      'OLD-CONTENT',
      'the pre-restore bytes are kept',
    )
    assert.deepEqual(mediaDigests(targetRoot), mediaDigests(join(work, 'private-media')))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore --restore-media: a failure while applying rewinds created and overwritten files', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmediarollback-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    writeMediaTree(join(work, 'private-media'), MEDIA_FILES)
    const backup = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'backup'),
      includeMedia: true,
      now: NOW_DATE,
    })
    const targetRoot = join(work, 'existing-media')
    writeMediaTree(targetRoot, { 'top.txt': 'OLD-CONTENT' })
    const corrupt = join(targetRoot, 'u', '1a', 'aa11.pdf')

    await assert.rejects(
      () =>
        restoreBackupMedia({
          backupDir: backup.destDir,
          mediaRoot: targetRoot,
          force: true,
          now: NOW_DATE,
          onStage: (stage) => {
            // Simulate a file that is damaged between being placed and being verified.
            if (stage === 'applied') writeFileSync(corrupt, 'corrupted after apply')
          },
        }),
      backupFailure(
        (failure) =>
          failure.code === 'media_restore_verification_failed' &&
          (failure.details as Record<string, unknown>).rolled_back === true,
      ),
    )
    assert.ok(!existsSync(corrupt), 'a file created by the failed restore is removed')
    assert.ok(!existsSync(join(targetRoot, 'u', '2c', '题-1.txt')))
    assert.equal(readFileSync(join(targetRoot, 'top.txt'), 'utf8'), 'OLD-CONTENT', 'the overwrite is restored')
    assert.deepEqual(mediaDigests(targetRoot), { 'top.txt': sha256Bytes('OLD-CONTENT') })
    assert.equal(
      readdirSync(work).filter((entry) => entry.includes('.restore-')).length,
      0,
      'the staging directory is removed on rollback too',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore: a refused database restore never touches the media tree', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmediaorder-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source, '备份项目').handle.close()
    writeMediaTree(join(work, 'private-media'), MEDIA_FILES)
    const expected = mediaDigests(join(work, 'private-media'))
    const backup = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'backup'),
      includeMedia: true,
      now: NOW_DATE,
    })
    const targetRoot = join(work, 'target')
    const target = join(targetRoot, 'acepass.sqlite')
    mkdirSync(targetRoot, { recursive: true })
    seedStore(target, '旧数据').handle.close()

    await assert.rejects(
      () =>
        restoreDatabase({
          backupDir: backup.destDir,
          targetPath: target,
          restoreMedia: true,
          now: NOW_DATE,
        }),
      backupFailure((failure) => failure.code === 'target_not_empty' && failure.kind === 'refused'),
    )
    assert.ok(!existsSync(join(targetRoot, 'private-media')), 'no media is written for a refused restore')
    assert.deepEqual(projectNames(target), ['旧数据'])

    // With --force both land, media first, and the database afterwards.
    const result = await restoreDatabase({
      backupDir: backup.destDir,
      targetPath: target,
      force: true,
      restoreMedia: true,
      now: NOW_DATE,
    })
    assert.equal(result.media?.restored, Object.keys(expected).length)
    assert.deepEqual(mediaDigests(join(targetRoot, 'private-media')), expected)
    assert.deepEqual(projectNames(target), ['备份项目'])
    assert.ok(result.safetyCopy !== null)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db restore --restore-media: a database-only backup cannot restore media', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbmediacontinually-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const plain = await backupDatabase({ sourcePath: source, destDir: join(work, 'plain'), now: NOW_DATE })
    const target = join(work, 'restore', 'acepass.sqlite')
    await assert.rejects(
      () => restoreDatabase({ backupDir: plain.destDir, targetPath: target, restoreMedia: true, now: NOW_DATE }),
      backupFailure((failure) => failure.code === 'media_not_in_backup' && failure.kind === 'refused'),
    )
    assert.ok(!existsSync(target), 'the refused restore does not create a target')
    assert.ok(!existsSync(join(work, 'restore', 'private-media')))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------------------------- *
 * --keep rotation
 * -------------------------------------------------------------------------------------------- */

test('db backup --keep: only this tool\'s backups rotate, the newest N survive', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbkeep-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const backups = join(work, 'backups')
    const names: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const now = new Date(NOW_DATE.getTime() + index * 60_000)
      const result = await backupDatabase({
        sourcePath: source,
        destDir: join(backups, `acepass-run-${index}`),
        now,
      })
      names.push(basename(result.destDir))
    }
    // A directory of another tool (self-identifying through its own manifest) and a hand-made one.
    const foreign = join(backups, 'other-tool')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(
      join(foreign, 'manifest.json'),
      `${JSON.stringify(
        {
          format_version: 1,
          created_at: '2030-01-01T00:00:00.000Z',
          tool: { name: 'another-tool' },
          snapshot: { file: 'acepass.sqlite', bytes: 1, sha256: 'a'.repeat(64) },
          total_rows: 0,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    writeFileSync(join(foreign, 'acepass.sqlite'), 'x')
    mkdirSync(join(backups, 'hand-made'))
    writeFileSync(join(backups, 'notes.txt'), 'keep me')

    const rotation = rotateBackups({ directory: backups, keep: 2 })
    assert.deepEqual(rotation.kept.map((path) => basename(path)).sort(), names.slice(2).sort())
    assert.deepEqual(rotation.deleted.map((path) => basename(path)).sort(), names.slice(0, 2).sort())
    assert.equal(rotation.skipped.length, 2, 'the foreign and the hand-made directory are listed, not deleted')
    assert.ok(rotation.skipped.every((entry) => existsSync(entry.path)), 'skipped directories still exist')
    for (const name of names.slice(0, 2)) assert.ok(!existsSync(join(backups, name)))
    assert.ok(existsSync(join(foreign, 'acepass.sqlite')))
    assert.ok(existsSync(join(backups, 'hand-made')))
    assert.ok(existsSync(join(backups, 'notes.txt')), 'plain files are never touched')
    assert.equal(rotation.directory, backups)
    assert.equal(rotation.dry_run, false)

    // The backup this run just wrote is protected even when `keep` would otherwise drop it.
    const afterRotation = readdirSync(backups)
      .filter((entry) => /^acepass-run-\d+$/.test(entry))
      .sort()
    assert.deepEqual(afterRotation, names.slice(2).sort())
    const guarded = rotateBackups({
      directory: backups,
      keep: 1,
      protect: [join(backups, afterRotation[0]!)],
    })
    assert.ok(
      existsSync(join(backups, afterRotation[0]!)),
      'a protected backup survives even though keep=1 would have dropped it',
    )
    assert.ok(existsSync(join(backups, afterRotation[1]!)), 'the newest backup is kept')
    assert.equal(guarded.deleted.length, 0, 'a protected directory is never deleted')
    assert.equal(guarded.kept.length, 2)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db backup --keep: a non-positive keep is refused and a dry run deletes nothing', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbkeep2-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const backups = join(work, 'backups')
    await backupDatabase({ sourcePath: source, destDir: join(backups, 'one'), now: NOW_DATE })
    await backupDatabase({ sourcePath: source, destDir: join(backups, 'two'), now: new Date(NOW_DATE.getTime() + 1000) })

    assert.throws(
      () => rotateBackups({ directory: backups, keep: 0 }),
      backupFailure((failure) => failure.code === 'keep_invalid' && failure.kind === 'refused'),
    )
    assert.throws(
      () => rotateBackups({ directory: backups, keep: 1.5 }),
      backupFailure((failure) => failure.code === 'keep_invalid'),
    )
    const dry = rotateBackups({ directory: backups, keep: 1, dryRun: true })
    assert.equal(dry.dry_run, true)
    assert.equal(dry.deleted.length, 1, 'the plan is reported')
    assert.ok(existsSync(join(backups, 'one')), 'a dry run deletes nothing')
    assert.ok(existsSync(join(backups, 'two')))
    // A missing directory is not an error: there is simply nothing to rotate.
    assert.deepEqual(rotateBackups({ directory: join(work, 'nope'), keep: 3 }).deleted, [])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------------------------- *
 * Optional HMAC-SHA256 signature
 * -------------------------------------------------------------------------------------------- */

test('db backup --sign-key: the manifest is signed, verifiable, and tamper-evident', async () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbsign-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const keyPath = join(work, 'signing.key')
    writeFileSync(keyPath, `${SIGN_KEY}\n`, 'utf8')

    // Key loading: file (trailing newline is not key material), environment, and refusals.
    assert.equal(loadSigningKey({ path: keyPath, env: {} })!.toString('utf8'), SIGN_KEY)
    assert.equal(loadSigningKey({ env: { ACEPASS_BACKUP_SIGNING_KEY: SIGN_KEY } })!.toString('utf8'), SIGN_KEY)
    assert.equal(loadSigningKey({ env: {} }), null)
    // A raw 32-byte key (`openssl rand -out key 32`) is not text; it must survive byte for byte.
    const rawKey = Buffer.from([...Array(32).keys()].map((value) => (value * 7 + 200) % 256))
    const rawKeyPath = join(work, 'raw.key')
    writeFileSync(rawKeyPath, Buffer.concat([rawKey, Buffer.from('\n', 'utf8')]))
    assert.deepEqual(loadSigningKey({ path: rawKeyPath, env: {} }), rawKey)
    const shortKey = join(work, 'short.key')
    writeFileSync(shortKey, 'abc', 'utf8')
    assert.throws(
      () => loadSigningKey({ path: shortKey, env: {} }),
      backupFailure((failure) => failure.code === 'sign_key_too_short' && failure.kind === 'refused'),
    )
    assert.throws(
      () => loadSigningKey({ path: join(work, 'missing.key'), env: {} }),
      backupFailure((failure) => failure.code === 'sign_key_unreadable' && failure.kind === 'refused'),
    )

    const signed = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'signed'),
      signingKey: SIGN_KEY,
      now: NOW_DATE,
    })
    assert.equal(signed.manifest.signature?.algorithm, SIGNATURE_ALGORITHM)
    assert.match(String(signed.manifest.signature?.digest), /^[0-9a-f]{64}$/)
    const manifestText = readFileSync(join(signed.destDir, 'manifest.json'), 'utf8')
    assert.ok(!manifestText.includes(SIGN_KEY), 'the key never enters the artifact')
    assert.ok(!manifestText.includes(sha256Bytes(SIGN_KEY)), 'not even a digest of the key')

    const verified = await verifyBackupDirectory(signed.destDir, { signingKey: SIGN_KEY })
    assert.equal(verified.manifest.signature?.digest, signed.manifest.signature?.digest)
    assert.deepEqual(verified.warnings, [])

    // A signature we cannot check proves nothing.
    await assert.rejects(
      () => verifyBackupDirectory(signed.destDir),
      backupFailure((failure) => failure.code === 'signature_key_missing' && failure.kind === 'refused'),
    )
    await assert.rejects(
      () => verifyBackupDirectory(signed.destDir, { signingKey: WRONG_KEY }),
      backupFailure((failure) => failure.code === 'signature_mismatch' && failure.kind === 'verification'),
    )

    // Tampering with a field the signature covers (but not the snapshot) is still detected.
    const tampered = await backupDatabase({
      sourcePath: source,
      destDir: join(work, 'tampered'),
      signingKey: SIGN_KEY,
      now: NOW_DATE,
    })
    const manifest = JSON.parse(readFileSync(join(tampered.destDir, 'manifest.json'), 'utf8')) as {
      total_rows: number
    }
    manifest.total_rows += 1
    writeFileSync(join(tampered.destDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await assert.rejects(
      () => verifyBackupDirectory(tampered.destDir, { signingKey: SIGN_KEY }),
      backupFailure((failure) => failure.code === 'signature_mismatch'),
    )

    // An unsigned backup plus a key is refused, so stripping the signature cannot downgrade it.
    const plain = await backupDatabase({ sourcePath: source, destDir: join(work, 'plain'), now: NOW_DATE })
    await assert.rejects(
      () => verifyBackupDirectory(plain.destDir, { signingKey: SIGN_KEY }),
      backupFailure((failure) => failure.code === 'signature_missing' && failure.kind === 'refused'),
    )
    // …and without a key an unsigned backup behaves exactly as before.
    assert.equal((await verifyBackupDirectory(plain.destDir)).manifest.signature, undefined)
    assert.deepEqual(checkManifestSignature(signManifest(plain.manifest, SIGN_KEY), SIGN_KEY), [])
    assert.equal(signManifest(plain.manifest, SIGN_KEY).signature?.algorithm, SIGNATURE_ALGORITHM)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------------------------- *
 * CLI surface: flags, exit codes, end-to-end round trip
 * -------------------------------------------------------------------------------------------- */

test('db backup/db restore CLI: --include-media --keep --sign-key round trip', () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbcli-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source, '备份项目').handle.close()
    const mediaRoot = join(work, 'private-media')
    writeMediaTree(mediaRoot, MEDIA_FILES)
    const expected = mediaDigests(mediaRoot)
    const keyPath = join(work, 'signing.key')
    const cliKey = 'b10-cli-signing-key-0123456789abcdef'
    writeFileSync(keyPath, `${cliKey}\n`, 'utf8')
    const noEnv = { ACEPASS_BACKUP_SIGNING_KEY: '' }

    // Three runs in the same backups directory, keeping two.
    for (let index = 0; index < 3; index += 1) {
      const out = join(work, 'backups', `run-${index}`)
      const run = cli(
        'scripts/db-backup.mjs',
        ['--db', source, '--out', out, '--include-media', '--keep', '2', '--sign-key', keyPath],
        noEnv,
      )
      assert.equal(run.status, 0, run.stderr)
      const summary = lastJson(run.stdout)
      assert.equal(summary.ok, true)
      assert.deepEqual(summary.media, { included: true, files: Object.keys(expected).length, bytes: MEDIA_TOTAL_BYTES })
      assert.equal(summary.signed, true)
      assert.equal((summary.rotation as Record<string, unknown>).keep, 2)
      assert.ok(!run.stdout.includes(cliKey) && !run.stderr.includes(cliKey), 'the key is never printed')
    }
    const remaining = readdirSync(join(work, 'backups')).filter((entry) => entry.startsWith('run-')).sort()
    assert.deepEqual(remaining, ['run-1', 'run-2'], '--keep 2 removed the oldest backup')
    assert.equal(
      cli('scripts/db-backup.mjs', ['--db', source, '--out', join(work, 'backups', 'run-2')], noEnv).status,
      4,
      'an existing backup directory is still refused without --force',
    )

    // db:verify checks signature + media, and refuses to pretend without the key.
    const verify = cli('scripts/db-restore.mjs', ['--backup', join(work, 'backups', 'run-2'), '--verify-only', '--sign-key', keyPath], noEnv)
    assert.equal(verify.status, 0, verify.stderr)
    const verifySummary = lastJson(verify.stdout)
    assert.equal(verifySummary.signed, true)
    assert.deepEqual(verifySummary.media, {
      included: true,
      files: Object.keys(expected).length,
      bytes: MEDIA_TOTAL_BYTES,
    })
    assert.equal(
      cli('scripts/db-restore.mjs', ['--backup', join(work, 'backups', 'run-2'), '--verify-only'], noEnv).status,
      4,
      'a signed backup without a key is refused, not silently accepted',
    )

    // Restore into a fresh data root: database and media together.
    const targetRoot = join(work, 'restored')
    mkdirSync(targetRoot, { recursive: true })
    const restore = cli(
      'scripts/db-restore.mjs',
      ['--backup', join(work, 'backups', 'run-2'), '--data-root', targetRoot, '--restore-media', '--sign-key', keyPath],
      noEnv,
    )
    assert.equal(restore.status, 0, restore.stderr)
    const restoredSummary = lastJson(restore.stdout)
    assert.equal(restoredSummary.ok, true)
    assert.equal((restoredSummary.media as Record<string, unknown>).restored, Object.keys(expected).length)
    assert.ok(!restore.stdout.includes(cliKey) && !restore.stderr.includes(cliKey))
    assert.deepEqual(mediaDigests(join(targetRoot, 'private-media')), expected)
    assert.ok(readFileSync(join(targetRoot, 'acepass.sqlite')).length > 0)
    assert.deepEqual(projectNames(join(targetRoot, 'acepass.sqlite')), ['备份项目'])

    // A second restore is idempotent: identical media is reported as unchanged.
    const again = cli(
      'scripts/db-restore.mjs',
      ['--backup', join(work, 'backups', 'run-2'), '--data-root', targetRoot, '--restore-media', '--force', '--sign-key', keyPath],
      noEnv,
    )
    assert.equal(again.status, 0, again.stderr)
    assert.equal((lastJson(again.stdout).media as Record<string, unknown>).unchanged, Object.keys(expected).length)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('db CLI: bad arguments and unusable keys map to distinct exit codes', () => {
  const work = mkdtempSync(join(tmpdir(), 'acepass-dbcli2-'))
  try {
    const source = join(work, 'acepass.sqlite')
    seedStore(source).handle.close()
    const noEnv = { ACEPASS_BACKUP_SIGNING_KEY: '' }
    const shortKey = join(work, 'short.key')
    writeFileSync(shortKey, 'abc', 'utf8')
    const out = join(work, 'out')

    const backupCases: [string[], number][] = [
      [['--db', source, '--out', out, '--keep', '0'], 2],
      [['--db', source, '--out', out, '--keep', 'abc'], 2],
      [['--db', source, '--out', out, '--media-root', join(work, 'm')], 2],
      [['--db', source, '--out', out, '--sign-key', join(work, 'missing.key')], 4],
      [['--db', source, '--out', out, '--sign-key', shortKey], 4],
      [['--db', source, '--out', out, '--include-media'], 4],
      [['--db', source, '--out', out, '--bogus'], 2],
    ]
    for (const [argv, expected] of backupCases) {
      const result = cli('scripts/db-backup.mjs', argv, noEnv)
      assert.equal(result.status, expected, `${argv.join(' ')} → ${result.status}\n${result.stderr}`)
      // Exit 4 comes from a BackupFailure, which always reports a machine-readable object; exit 2 is
      // a usage error where only the usage text on stderr is produced.
      if (expected === 4) assert.equal(lastJson(result.stdout).ok, false)
    }
    assert.ok(!existsSync(out), 'no refused invocation left a backup directory')

    const restoreCases: [string[], number][] = [
      [[], 2],
      [['--backup', join(work, 'nope'), '--verify-only'], 3],
      [['--backup', join(work, 'nope'), '--media-root', join(work, 'm')], 2],
      [['--backup', join(work, 'nope'), '--verify-only', '--sign-key', shortKey], 4],
    ]
    for (const [argv, expected] of restoreCases) {
      const result = cli('scripts/db-restore.mjs', argv, noEnv)
      assert.equal(result.status, expected, `${argv.join(' ')} → ${result.status}\n${result.stderr}`)
    }
    // --help documents the new flags and exit codes without touching anything.
    const helpBackup = cli('scripts/db-backup.mjs', ['--help'], noEnv)
    assert.equal(helpBackup.status, 0)
    assert.match(helpBackup.stderr, /--include-media/)
    assert.match(helpBackup.stderr, /--keep <n>/)
    assert.match(helpBackup.stderr, /--sign-key <path>/)
    assert.match(helpBackup.stderr, /Exit codes: 0 ok, 1 failure, 2 bad arguments, 3 verification failure, 4 refused/)
    const helpRestore = cli('scripts/db-restore.mjs', ['--help'], noEnv)
    assert.equal(helpRestore.status, 0)
    assert.match(helpRestore.stderr, /--restore-media/)
    assert.match(helpRestore.stderr, /--media-root <dir>/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
