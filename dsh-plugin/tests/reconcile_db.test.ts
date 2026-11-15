import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tableDigest } from '../src/migrate/archive.ts'

/**
 * `scripts/reconcile_db.mjs` end to end.
 *
 * The drill database is built by Django's own migrations and ORM (a real PostgreSQL database,
 * not a fixture), then exported, imported and reconciled by the command under test. Nothing here
 * reads the developer's `acepass` database: the drill uses its own scratch database, created and
 * dropped in this file, so the assertions hold whatever the real database happens to contain.
 *
 * Three failure modes are pinned, because "reconciled" must mean all three checks passed:
 *  1. a manifest row count that lies about what the files hold;
 *  2. a row value that differs from the digest the manifest recorded;
 *  3. an archive that is internally consistent (counts and digests agree) but no longer matches
 *     the source database's statistics — the aggregate check is the only thing that catches it.
 */

const PLUGIN = process.cwd()
const BACKEND = join(PLUGIN, '..', 'backend')
const PYTHON = join(BACKEND, '.venv', 'bin', 'python')
const HELPERS = join('scripts', 'reconcile_stats.py')
const CLI = join('scripts', 'reconcile_db.mjs')
const DRILL_DB = `acepass_recon_test_${process.pid}`
const AVAILABLE = existsSync(PYTHON)

let workDir: string | null = null

function pythonJson(args: string[]): Record<string, any> {
  const stdout = execFileSync(PYTHON, [HELPERS, ...args], { cwd: PLUGIN, encoding: 'utf8' }).trim()
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  return JSON.parse(lines.at(-1)!)
}

/** Django migrations plus a handful of real rows: enough to make every statistic non-zero. */
function seed(): void {
  const script = `
import os, sys
from pathlib import Path
ROOT = Path(${JSON.stringify(BACKEND)})
sys.path.insert(0, str(ROOT))
os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.dev"
import django
django.setup()
from decimal import Decimal
from django.utils import timezone
from apps.accounts.models import User, UserSettings
from apps.exams.models import ExamProject, Subject, ExamSpecVersion, SyllabusVersion
from apps.knowledge.models import KnowledgeNode
from apps.question_bank.models import Question, QuestionVersion, AnswerKeyVersion
from apps.practice.models import PracticeSession, SessionItem, ExposureEvent
from apps.practice.services import attempts as attempt_services

now = timezone.now()
user = User.objects.create_user(email="recon@example.com", password="x", display_name="对账")
UserSettings.objects.create(
    user=user, timezone="Asia/Shanghai", daily_budget_minutes=45,
    project_budget_percent={}, undiagnosed_time_share_percent=25,
)
project = ExamProject.objects.create(owner=user, name="对账项目", description="")
subject = Subject.objects.create(project=project, name="科目")
spec = ExamSpecVersion.objects.create(subject=subject, version=1, status="published",
    question_type_rules={"single_choice": {"policy": "exact_match", "default_max_score": "2.00"}})
syllabus = SyllabusVersion.objects.create(subject=subject, name="大纲", version_label="v1", status="draft")
question = Question.objects.create(subject=subject, origin_type="import", is_demo=False, display_label="对账题")
version = QuestionVersion.objects.create(
    question=question, version=1, question_type="single_choice", status="published",
    content={"blocks": [{"kind": "text", "text": "1+1"}], "options": [{"id": "a", "text": "1"}, {"id": "b", "text": "2"}]},
    practice_max_score=Decimal("2.00"),
)
AnswerKeyVersion.objects.create(
    question_version=version, version=1, verification_status="checked", is_disputed=False,
    answer_payload={"kind": "single_choice", "correct_option_id": "b"},
    check_basis="教材", source_type="textbook",
)
KnowledgeNode.objects.create(
    syllabus_version=syllabus, kind="point", canonical_name="考点A",
    aliases=["别名甲", "别名乙"], display_order=1, code="",
)
session = PracticeSession.objects.create(
    user=user, project=project, subject=subject, mode="practice", status="active", note="purpose=practice",
)
item = SessionItem.objects.create(
    session=session, ordinal=1, question_version=version,
    answer_key_version=version.answer_keys.first(), spec_version=spec,
    mapping_revision=1, max_score=Decimal("2.00"), purpose="practice", tutoring_allowed=True,
)
# Submit one attempt so the schema's real reference cycle exists in the data:
# practice_attempt.current_grade_event_id <-> practice_grade_event.attempt_id.
attempt_services.submit_attempt(
    session_item_id=str(item.id), user=user,
    raw_answer={"type": "single_choice", "selected_option_id": "b"},
)
# One exposure row: the statistics tamper case removes it, so it must exist.
ExposureEvent.objects.create(
    user=user, project=project, question=question, question_version=version,
    kind="stem_delivered", purpose="practice", source="session", server_time=now,
)
print("seeded")
`
  execFileSync(PYTHON, ['-c', script], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, POSTGRES_DB: DRILL_DB, PYTHONPATH: BACKEND },
  })
}

interface RunResult {
  status: number | null
  summary: Record<string, any> | null
  stdout: string
  stderr: string
}

function runCli(args: string[]): RunResult {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd: PLUGIN,
    encoding: 'utf8',
    timeout: 240_000,
  })
  const stdout = (result.stdout ?? '').trim()
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  let summary: Record<string, any> | null = null
  try {
    summary = JSON.parse(lines.at(-1)!)
  } catch {
    summary = null
  }
  return { status: result.status, summary, stdout, stderr: result.stderr ?? '' }
}

interface ManifestTable {
  name: string
  columns: string[]
  rows: number
  digest: string
  no_model?: boolean
}

interface Manifest {
  format_version: number
  source: { engine: string; database: string; django_version: string }
  tables: ManifestTable[]
  missing_models?: string[]
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest
}

function writeManifest(dir: string, manifest: Manifest): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

function readRows(dir: string, table: string): unknown[][] {
  return readFileSync(join(dir, `${table}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown[])
}

function writeRows(dir: string, table: string, rows: unknown[][]): void {
  writeFileSync(join(dir, `${table}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

/** Copy the pristine archive so a tamper test cannot affect the next one. */
function cloneArchive(name: string): string {
  const target = join(workDir!, name)
  cpSync(join(workDir!, 'archive'), target, { recursive: true })
  return target
}

test.before(() => {
  if (!AVAILABLE) {
    console.log('SKIPPED: backend/.venv/bin/python is unavailable')
    return
  }
  workDir = mkdtempSync(join(tmpdir(), 'acepass-recon-'))
  pythonJson(['drop', '--database', DRILL_DB])
  pythonJson(['create', '--database', DRILL_DB])
  pythonJson(['migrate', '--database', DRILL_DB])
  seed()
})

test.after(() => {
  if (!AVAILABLE) return
  try {
    pythonJson(['drop', '--database', DRILL_DB])
  } finally {
    if (workDir !== null) rmSync(workDir, { recursive: true, force: true })
  }
})

test('reconcile: a scratch database exports, imports and reconciles', { timeout: 240_000 }, () => {
  if (!AVAILABLE) return
  const out = join(workDir!, 'run')
  const result = runCli(['--database', DRILL_DB, '--out', out])

  assert.equal(result.status, 0, `expected exit 0\n${result.stderr}`)
  assert.ok(result.summary !== null, 'the command must print one JSON summary line')
  const summary = result.summary!
  assert.equal(summary.ok, true)
  assert.equal(summary.database, DRILL_DB)
  // 57 declared models + 2 auto-created M2M through tables = 59 archive tables.
  assert.equal(summary.tables.schema, 59)
  assert.equal(summary.tables.declaredModels, 57)
  assert.equal(summary.tables.autoCreated, 2)
  assert.equal(summary.tables.exported, 59)
  assert.equal(summary.tables.rowsEqual, 59, 'every table must agree on its row count')
  assert.equal(summary.tables.digestEqual, 59, 'every table must agree on its row digest')
  assert.equal(summary.tables.manifestDigestEqual, 59, 'every manifest digest must match its row file')
  assert.ok(summary.tables.rows > 0, 'the seeded rows must be exported')
  assert.ok(summary.tables.nonEmpty > 0, 'the seeded tables must arrive non-empty')
  assert.equal(summary.statistics.equal, summary.statistics.total)
  assert.deepEqual(summary.statistics.differ, [])
  assert.match(summary.manifestSha256, /^[0-9a-f]{64}$/)

  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Record<string, any>
  assert.equal(report.ok, true)
  assert.equal(report.archive.source.engine, 'postgresql')
  assert.equal(report.archive.source.database, DRILL_DB)
  assert.equal(report.archive.missing_models.length, 0)
  assert.equal(report.archive.tables, 59)
  assert.deepEqual(report.source.schema.missing_tables, [])
  assert.deepEqual(report.source.schema.missing_columns, [])
  assert.deepEqual(report.source.schema.auto_created_tables, [
    'ingestion_import_candidate_source_regions',
    'ingestion_import_job_documents',
  ])
  assert.equal(report.reconciliation.mismatches.length, 0)
  assert.equal(report.statistics.items.length, 13)
  const users = report.statistics.items.find((item: any) => item.name === 'users')
  assert.equal(users.expected, 1)
  assert.equal(users.actual, 1)
  const scores = report.statistics.items.find((item: any) => item.name === 'confirmed_score_total')
  assert.match(String(scores.actual), /^\d+\.\d{2}$/, 'decimal sums compare as two-decimal strings')
  // The through tables carry Django's auto-created model, so they are exported as real tables
  // (empty here) rather than skipped: their digest is sha256("").
  const through = report.archive.tables_detail.find(
    (table: any) => table.table === 'ingestion_import_job_documents',
  )
  assert.equal(through.rows, 0)
  assert.equal(through.digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(through.no_model, undefined)

  cpSync(join(out, 'archive'), join(workDir!, 'archive'), { recursive: true })
})

test('reconcile: a manifest row count that lies exits non-zero', { timeout: 240_000 }, () => {
  if (!AVAILABLE) return
  const archive = cloneArchive('archive-count')
  const manifest = readManifest(archive)
  const table = manifest.tables.find((entry) => entry.name === 'accounts_user')!
  table.rows += 1
  writeManifest(archive, manifest)

  const result = runCli(['--database', DRILL_DB, '--out', join(workDir!, 'out-count'), '--archive', archive])

  assert.equal(result.status, 1, 'a row-count mismatch must exit non-zero')
  assert.equal(result.summary?.ok, false)
  assert.ok(
    result.summary?.problems.some((problem: string) => problem.startsWith('accounts_user:')),
    `the summary must name the table, got ${JSON.stringify(result.summary?.problems)}`,
  )
  assert.equal(result.summary?.tables.rowsEqual, 58)
  assert.equal(result.summary?.tables.digestEqual, 59)
  // The statistics still agree: only the count check failed.
  assert.deepEqual(result.summary?.statistics.differ, [])
})

test('reconcile: a tampered row value exits non-zero', { timeout: 240_000 }, () => {
  if (!AVAILABLE) return
  const archive = cloneArchive('archive-digest')
  const manifest = readManifest(archive)
  const table = manifest.tables.find((entry) => entry.name === 'accounts_user')!
  const rows = readRows(archive, 'accounts_user')
  const email = table.columns.indexOf('email')
  assert.ok(email >= 0 && rows.length === 1)
  rows[0][email] = 'tampered@example.com'
  writeRows(archive, 'accounts_user', rows)

  const result = runCli(['--database', DRILL_DB, '--out', join(workDir!, 'out-digest'), '--archive', archive])

  assert.equal(result.status, 1, 'a digest mismatch must exit non-zero')
  assert.equal(result.summary?.ok, false)
  assert.ok(
    result.summary?.problems.some((problem: string) => problem.includes('archive digest mismatch: accounts_user')),
    `the summary must name the table, got ${JSON.stringify(result.summary?.problems)}`,
  )
  assert.equal(result.summary?.tables.digestEqual, 59, 'the store matches the (tampered) files it read')
  assert.equal(result.summary?.tables.manifestDigestEqual, 58, 'the manifest digest is the provenance check')
  assert.equal(result.summary?.tables.rowsEqual, 59)
})

test('reconcile: an internally consistent archive that changes a statistic exits non-zero', { timeout: 240_000 }, () => {
  if (!AVAILABLE) return
  const archive = cloneArchive('archive-stats')
  const manifest = readManifest(archive)
  const table = manifest.tables.find((entry) => entry.name === 'practice_exposure_event')!
  const rows = readRows(archive, 'practice_exposure_event')
  assert.ok(rows.length >= 1, 'the seed must leave an exposure event behind')
  rows.pop()
  writeRows(archive, 'practice_exposure_event', rows)
  // Recompute the digest so the archive is self-consistent: only the aggregate can catch this.
  table.rows = rows.length
  table.digest = tableDigest(rows, table.columns)
  writeManifest(archive, manifest)

  const result = runCli(['--database', DRILL_DB, '--out', join(workDir!, 'out-stats'), '--archive', archive])

  assert.equal(result.status, 1, 'a statistic mismatch must exit non-zero')
  assert.equal(result.summary?.ok, false)
  assert.equal(result.summary?.tables.rowsEqual, 59, 'counts and digests are fine by construction')
  assert.equal(result.summary?.tables.digestEqual, 59)
  assert.ok(
    result.summary?.statistics.differ.includes('exposure_events'),
    `the summary must name the statistic, got ${JSON.stringify(result.summary?.statistics.differ)}`,
  )
})

test('reconcile: missing arguments are a usage error, not a crash', () => {
  const result = runCli(['--out', join(tmpdir(), 'acepass-recon-usage')])
  assert.equal(result.status, 2)
  assert.equal(result.summary?.ok, false)
  assert.equal(result.summary?.error.code, 'usage')
})
