"""P0.2: make regrade ``generation`` a database-allocated, unique sequence number.

B01 showed that "read MAX(generation) + 1" is not a generator: two concurrent
requests both read the same maximum and both insert the same number. Locking the
*stable* question row before allocating does fix the duplicate, but it is the
wrong trade here: the requester would hold a lock on a row that is unrelated to
the number being allocated for the whole request, which serialises every regrade
request of a question behind one another and couples two independent business
actions. (The earlier concurrency counter-example used a test barrier that a
correctly serialised implementation cannot cross either, so it never demonstrated
"a row lock inherently deadlocks" — the objection is about scope and coupling, not
liveness.)

A PostgreSQL sequence gives the uniqueness guarantee without blocking and without
coupling: ``nextval`` is atomic, monotonic, never rolled back and never waits on
another consumer. The ``(question, generation)`` unique constraint is the hard
backstop, so a duplicate is impossible even if application code regresses.

Ambiguous legacy history is **refused, never renumbered** (C02)
--------------------------------------------------------------

The old MAX+1 scheme could store two rows with the same ``(question, generation)``
while a *higher* generation for the same question had already been applied. There
is no reliable way to recover the intended order of those rows after the fact:
``created_at`` records when a row was inserted, not which request the system
considered newer, and the two duplicates were by construction created in the same
window.

Renumbering such a row from the sequence would hand an old, still-queued run a
number *above* an already-applied newer run, so executing it would overwrite a
valid newer grade — exactly the ordering bug this migration exists to prevent.
The migration therefore stops instead of guessing: it raises
:class:`AmbiguousRegradeGenerationHistory` with an actionable inventory (question,
generation, run id, status, target answer version, created_at), and because
Django runs migrations in a transaction nothing is left half-applied — no
sequence, no constraint, no rewritten row.

The operator resolves the inventory by hand (cancel or re-queue the duplicates,
or delete rows that never applied) and re-runs ``migrate``. The business database
for this release contains no regrade runs at all, so the refusal is a guard rail
for reachable legacy states rather than a step in the normal path.
"""

from django.db import migrations, models

SEQUENCE = "analytics_regrade_generation_seq"


class AmbiguousRegradeGenerationHistory(RuntimeError):
    """Raised when duplicate ``(question, generation)`` rows cannot be ordered."""


CREATE_SEQUENCE = f"CREATE SEQUENCE IF NOT EXISTS {SEQUENCE}"

#: Duplicate ``(question, generation)`` pairs are the ambiguous state: the old
#: MAX+1 scheme could produce them, and their relative order is not recoverable.
DETECT_DUPLICATES = """
SELECT r.question_id,
       r.generation,
       r.id,
       r.status,
       r.target_answer_key_version_id,
       r.created_at,
       (SELECT MAX(inner_run.generation)
          FROM analytics_regrade_run AS inner_run
         WHERE inner_run.question_id = r.question_id) AS question_max_generation
FROM analytics_regrade_run AS r
WHERE (r.question_id, r.generation) IN (
        SELECT question_id, generation
          FROM analytics_regrade_run
         GROUP BY question_id, generation
        HAVING COUNT(*) > 1
      )
ORDER BY r.question_id, r.generation, r.created_at, r.id
"""

#: Point the sequence at MAX(generation) + 1 without consuming a value, so the
#: next ``nextval`` can never collide with a number an existing row already uses.
SETVAL_TO_MAX = f"""
SELECT setval(
    '{SEQUENCE}',
    GREATEST(COALESCE((SELECT MAX(generation) FROM analytics_regrade_run), 0), 0) + 1,
    false
)
"""


def assert_unambiguous_history(apps, schema_editor):
    """Refuse to migrate a history whose generation order cannot be recovered."""
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        cursor.execute(DETECT_DUPLICATES)
        rows = cursor.fetchall()
    if not rows:
        return
    inventory = "\n".join(
        f"  - question={row[0]} generation={row[1]} run={row[2]} status={row[3]} "
        f"target_answer_key_version={row[4]} created_at={row[5]} "
        f"(question_max_generation={row[6]})"
        for row in rows
    )
    raise AmbiguousRegradeGenerationHistory(
        "analytics.0004 拒绝迁移：存在重复的 (question, generation) 重判记录，"
        "无法可靠还原它们的先后顺序。\n"
        f"受影响记录（{len(rows)} 条）：\n{inventory}\n"
        "处理建议：对每条记录确认它是否已经产生过有效结果（status=succeeded 且被 "
        "practice_attempt.applied_regrade_generation 覆盖），对未产生结果的重复记录执行取消"
        "（置为 failed 并写明原因），或删除从未生效的历史行；重复消除后重新执行 migrate。"
        "禁止直接抬高旧 run 的 generation —— 那会让旧任务覆盖较新的有效评分。\n"
        "本次迁移未做任何部分修改：序列未创建、约束未添加、历史行未被改写。"
    )


def create_sequence_and_position(apps, schema_editor):
    """Create the sequence and advance it past MAX(generation).

    History has already been proven unambiguous, so no row needs rewriting: the
    sequence starts above every stored number and the unique constraint can be
    added directly.
    """
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        cursor.execute(CREATE_SEQUENCE)
        cursor.execute(SETVAL_TO_MAX)


def drop_sequence(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(f"DROP SEQUENCE IF EXISTS {SEQUENCE}")


class Migration(migrations.Migration):
    dependencies = [
        ("analytics", "0003_p0_1_grading_and_regrade_semantics"),
    ]

    operations = [
        # Refusal first: nothing is created until the history is proven safe, and
        # a refusal rolls the whole migration back (no sequence, no constraint).
        migrations.RunPython(assert_unambiguous_history, migrations.RunPython.noop),
        migrations.RunPython(create_sequence_and_position, drop_sequence),
        migrations.AddConstraint(
            model_name="regraderun",
            constraint=models.UniqueConstraint(
                fields=["question", "generation"], name="uniq_regrade_question_generation"
            ),
        ),
    ]
