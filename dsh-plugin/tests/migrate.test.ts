import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { findRows } from '../src/store/repository.ts'
import { importArchive, readArchive, reconcileArchive, tableDigest } from '../src/migrate/archive.ts'

/**
 * Phase 7 exit criterion: export a real database, import it, and reconcile.
 *
 * The source is a **real PostgreSQL database built by Django's own migrations and ORM** — not a
 * hand-written fixture — so the drill exercises the column types, foreign keys and JSON shapes the
 * production database actually has. The archive is produced by the Python exporter and read by the
 * TypeScript importer, which is the pair that will run during the cutover.
 */

const PLUGIN = process.cwd()
const BACKEND = join(PLUGIN, '..', 'backend')
const PYTHON = join(BACKEND, '.venv', 'bin', 'python')
const NOW = parseInstant('2027-03-01T00:00:00+00:00')
const DRILL_DB = 'acepass_migration_drill'

/** Django's migrations plus a handful of real rows, in a scratch database. */
function seedPostgres(): void {
  const script = `
import os, sys
from pathlib import Path
ROOT = Path(${JSON.stringify(BACKEND)})
sys.path.insert(0, str(ROOT))
os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.test"
os.environ["POSTGRES_DB"] = ${JSON.stringify(DRILL_DB)}
import django
django.setup()
from django.core.management import call_command
call_command("migrate", verbosity=0, interactive=False)

from decimal import Decimal
from django.utils import timezone
from apps.accounts.models import User, UserSettings
from apps.exams.models import ExamProject, Subject, ExamSpecVersion, SyllabusVersion
from apps.knowledge.models import KnowledgeNode
from apps.question_bank.models import Question, QuestionVersion, AnswerKeyVersion
from apps.practice.models import PracticeSession, SessionItem
from apps.practice.services import sessions as session_services

now = timezone.now()
user = User.objects.create_user(email="drill@example.com", password="x", display_name="演练")
UserSettings.objects.create(
    user=user, timezone="Asia/Shanghai", daily_budget_minutes=45,
    project_budget_percent={}, undiagnosed_time_share_percent=25,
)
project = ExamProject.objects.create(owner=user, name="演练项目", description="")
subject = Subject.objects.create(project=project, name="科目")
spec = ExamSpecVersion.objects.create(subject=subject, version=1, status="published",
    question_type_rules={"single_choice": {"policy": "exact_match", "default_max_score": "2.00"}})
syllabus = SyllabusVersion.objects.create(subject=subject, name="大纲", version_label="v1", status="draft")
question = Question.objects.create(subject=subject, origin_type="import", is_demo=False, display_label="演练题")
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
from apps.practice.services import attempts as attempt_services
attempt_services.submit_attempt(
    session_item_id=str(item.id), user=user,
    raw_answer={"type": "single_choice", "selected_option_id": "b"},
)
print("seeded")
`
  execFileSync(PYTHON, ['-c', script], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, POSTGRES_DB: DRILL_DB, PYTHONPATH: BACKEND },
  })
}

/** `CREATE DATABASE` cannot run inside a transaction, so this connects to `postgres` directly. */
function createDatabase(): void {
  execFileSync(
    PYTHON,
    [
      '-c',
      `
import psycopg
with psycopg.connect("host=127.0.0.1 port=5432 dbname=postgres user=acepass password=acepass_dev_pw", autocommit=True) as conn:
    with conn.cursor() as cur:
        cur.execute('CREATE DATABASE ${DRILL_DB}')
print("created")
`,
    ],
    { cwd: BACKEND, encoding: 'utf8' },
  )
}

function dropDatabase(): void {
  execFileSync(
    PYTHON,
    [
      '-c',
      `
import os, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(BACKEND)})
import django
os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.test"
os.environ["POSTGRES_DB"] = "postgres"
django.setup()
from django.db import connection
connection.close()
connection.settings_dict["NAME"] = "postgres"
with connection.cursor() as cursor:
    cursor.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s", [${JSON.stringify(DRILL_DB)}])
cursor_conn = connection
with connection.cursor() as cursor:
    cursor.execute('DROP DATABASE IF EXISTS "${DRILL_DB}"')
print("dropped")
`,
    ],
    { cwd: BACKEND, encoding: 'utf8', env: { ...process.env, POSTGRES_DB: 'postgres' } },
  )
}

test('migration: a real Postgres database exports, imports and reconciles', { timeout: 240_000 }, () => {
  if (!existsSync(PYTHON)) {
    // The drill needs the Django environment; skipping is honest, silently passing is not.
    console.log('SKIPPED: backend/.venv/bin/python is unavailable')
    return
  }

  const workDir = mkdtempSync(join(tmpdir(), 'acepass-migrate-'))
  const archiveDir = join(workDir, 'archive')
  try {
    dropDatabase()
    createDatabase()
    seedPostgres()

    // 1. Export the live database with the Python exporter.
    const tablesJson = join(workDir, 'tables.json')
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/schema_tables.mjs', tablesJson], {
      cwd: PLUGIN,
      encoding: 'utf8',
    })
    const exported = JSON.parse(
      execFileSync(
        PYTHON,
        ['scripts/export_db.py', '--out', archiveDir, '--tables-json', tablesJson],
        {
          cwd: PLUGIN,
          encoding: 'utf8',
          env: { ...process.env, DJANGO_SETTINGS_MODULE: 'config.settings.test', POSTGRES_DB: DRILL_DB, PYTHONPATH: BACKEND },
        },
      ).trim().split('\n').pop()!,
    ) as { tables: number; rows: number }

    assert.ok(exported.rows > 0, 'the exported database must contain the seeded rows')
    const manifest = JSON.parse(readFileSync(join(archiveDir, 'manifest.json'), 'utf8')) as {
      tables: { name: string; rows: number }[]
    }
    const nonEmpty = manifest.tables.filter((table) => table.rows > 0)
    assert.ok(nonEmpty.length >= 6, `expected the seeded tables to be non-empty, got ${nonEmpty.length}`)
    assert.deepEqual(
      manifest.tables.filter((table) => table.rows > 0).map((table) => table.name).sort(),
      [
        'accounts_user',
        'audit_outbox_event',
        'accounts_user_settings',
        'exams_project',
        'exams_spec_version',
        'exams_subject',
        'exams_syllabus_version',
        'knowledge_node',
        'practice_attempt',
        'practice_grade_event',
        'practice_session',
        'practice_session_item',
        'question_bank_answer_key_version',
        'question_bank_question',
        'question_bank_question_version',
      ].sort(),
      'every seeded table must arrive with rows',
    )

    // 2. Import into a fresh SQLite store.
    const store = openStore({ path: join(workDir, 'acepass.sqlite') })
    try {
      const archive = readArchive(archiveDir)
      const report = importArchive(store.db, archive, NOW)
      assert.equal(report.rows, exported.rows, 'every exported row must be imported')

      // 3. Reconcile: counts, per-row digests, and a few learner-visible statistics.
      const reconciliation = reconcileArchive(store.db, archive)
      assert.deepEqual(reconciliation.problems, [], 'counts and digests must agree table by table')
      assert.equal(reconciliation.ok, true)

      const user = store.db.prepare('SELECT * FROM "accounts_user"').get() as Record<string, unknown>
      assert.equal(user.email, 'drill@example.com')
      assert.equal(user.display_name, '演练')

      const settings = store.db.prepare('SELECT * FROM "accounts_user_settings"').get() as Record<string, unknown>
      assert.equal(settings.timezone, 'Asia/Shanghai')
      assert.equal(Number(settings.daily_budget_minutes), 45)

      const item = store.db.prepare('SELECT * FROM "practice_session_item"').get() as Record<string, unknown>
      assert.equal(String(item.max_score), '2.00', 'the decimal keeps its scale, not just its value')

      // Read through the repository so the JSON columns are decoded, not raw text.
      const node = findRows(store.db, 'knowledge_node', {})[0]
      assert.deepEqual(node.aliases, ['别名甲', '别名乙'], 'JSON arrays survive the round trip')

      const version = findRows(store.db, 'question_bank_question_version', {})[0]
      const content = version.content as Record<string, unknown>
      assert.equal((content.blocks as unknown[]).length, 1, 'JSON content survives the round trip')

      // Foreign keys were preserved as real references, not re-generated ids.
      const session = store.db.prepare('SELECT * FROM "practice_session"').get() as Record<string, unknown>
      assert.equal(String(item.session_id), String(session.id))
      assert.equal(String(session.user_id), String(user.id))
    } finally {
      store.close()
    }
  } finally {
    dropDatabase()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('migration: an archive row with the wrong column count is refused', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'acepass-bad-'))
  try {
    const store = openStore({ path: join(workDir, 'x.sqlite') })
    try {
      const archive = {
        manifest: {
          format_version: 1,
          source: { engine: 'postgresql', database: 'x', django_version: '5.2' },
          tables: [{ name: 'accounts_user', columns: ['id', 'email'], rows: 1, digest: 'x' }],
        },
        rows: new Map([['accounts_user', [['only-one-value']]]]),
      }
      assert.throws(() => importArchive(store.db, archive, NOW), /row has 1 values but 2 columns/)
    } finally {
      store.close()
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('migration: an archive table the schema does not have is refused', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'acepass-bad2-'))
  try {
    const store = openStore({ path: join(workDir, 'x.sqlite') })
    try {
      const archive = {
        manifest: {
          format_version: 1,
          source: { engine: 'postgresql', database: 'x', django_version: '5.2' },
          tables: [{ name: 'django_migrations', columns: ['id'], rows: 0, digest: '' }],
        },
        rows: new Map<string, unknown[][]>(),
      }
      assert.throws(() => importArchive(store.db, archive, NOW), /table the schema does not have/)
    } finally {
      store.close()
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

/**
 * A JSON field whose Python value was `40.0` must survive as a float token.
 *
 * The manifest digest is computed by Python (`json.dumps` writes `40.0`, `40` for an int). If the
 * reader uses `JSON.parse`, the token is lost, `pyJsonCanonical` prints `40`, and the archive no
 * longer hashes to the digest Python recorded. The B9 real-database run caught exactly this on
 * `accounts_user_settings`, `learning_study_plan` and `audit_idempotency_record`; a synthetic drill
 * without float-bearing JSON could not.
 */
test('migration: a JSON float keeps Python 40.0 through read, import and digest', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'acepass-float-'))
  try {
    const archiveDir = join(workDir, 'archive')
    mkdirSync(archiveDir)
    const columns = [
      'id',
      'created_at',
      'updated_at',
      'topic',
      'payload',
      'status',
      'attempts',
      'max_attempts',
      'available_at',
      'dispatched_at',
      'claimed_at',
      'claim_token',
      'lease_expires_at',
      'processed_at',
      'last_error',
      'dedupe_key',
    ]
    const row = [
      '00000000-0000-0000-0000-000000000001',
      '2027-01-01T00:00:00+00:00',
      '2027-01-01T00:00:00+00:00',
      'test',
      { score: 40.0, ratio: 0.5 },
      'pending',
      0,
      8,
      '2027-01-01T00:00:00+00:00',
      null,
      null,
      '',
      null,
      null,
      '',
      null,
    ]
    // The canonical string Python's `json.dumps` produces for this row: sorted keys, `40.0` kept.
    const canonical =
      '{"attempts":0,"available_at":"2027-01-01T00:00:00+00:00","claim_token":"","claimed_at":null,' +
      '"created_at":"2027-01-01T00:00:00+00:00","dedupe_key":null,"dispatched_at":null,' +
      '"id":"00000000-0000-0000-0000-000000000001","last_error":"","lease_expires_at":null,' +
      '"max_attempts":8,"payload":{"ratio":0.5,"score":40.0},"processed_at":null,"status":"pending",' +
      '"topic":"test","updated_at":"2027-01-01T00:00:00+00:00"}\n'
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
    writeFileSync(
      join(archiveDir, 'manifest.json'),
      JSON.stringify(
        {
          format_version: 1,
          source: { engine: 'postgresql', database: 'x', django_version: '5.2' },
          tables: [{ name: 'audit_outbox_event', columns, rows: 1, digest }],
        },
        null,
        2,
      ),
      'utf8',
    )
    // Write the float token literally: `JSON.stringify` would turn `40.0` into `40`, which is the
    // exact loss this test exists to prevent.
    const line = JSON.stringify(row).replace('"score":40', '"score":40.0')
    writeFileSync(join(archiveDir, 'audit_outbox_event.jsonl'), `${line}\n`, 'utf8')

    const archive = readArchive(archiveDir)
    assert.equal(
      tableDigest(archive.rows.get('audit_outbox_event')!, columns),
      digest,
      'the reader must preserve the float token the manifest was hashed with',
    )

    const store = openStore({ path: join(workDir, 'x.sqlite') })
    try {
      importArchive(store.db, archive, NOW)
      const stored = store.db
        .prepare('SELECT payload FROM "audit_outbox_event"')
        .get() as { payload: string }
      assert.match(stored.payload, /40\.0/, 'the stored JSON keeps the float token')
      const reconciliation = reconcileArchive(store.db, archive)
      assert.deepEqual(reconciliation.problems, [])
      assert.equal(reconciliation.ok, true)
    } finally {
      store.close()
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})
