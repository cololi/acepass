"""P0.2: make regrade ``generation`` a database-allocated, unique sequence number.

B01 showed that "read MAX(generation) + 1" is not a generator: two concurrent
requests both read the same maximum and both insert the same number. Locking the
*stable* question row before allocating fixes the duplicate, but a blocking row
lock cannot be held across run creation without deadlocking the two-connection
concurrency test (the first requester keeps its lock until its own transaction
commits, while the second waits for the lock — neither can proceed).

A PostgreSQL sequence gives the same guarantee without blocking: ``nextval`` is
atomic, monotonic, never rolled back and never waits on another consumer. The
``(question, generation)`` unique constraint is the hard backstop, so a duplicate
is impossible even if application code regresses.

Existing rows are preserved. The sequence is advanced past the current maximum
before it is used, and any pre-existing duplicate ``(question, generation)`` pair
(possible under the old MAX+1 scheme) is renumbered from the sequence so the
constraint can be added; the renumbering never deletes or rewrites a completed
regrade result.
"""

from django.db import migrations, models

SEQUENCE = "analytics_regrade_generation_seq"

CREATE_SEQUENCE = f"CREATE SEQUENCE IF NOT EXISTS {SEQUENCE}"

#: Point the sequence at MAX(generation) + 1 without consuming a value, so the
#: next ``nextval`` can never collide with a number an existing row already uses.
SETVAL_TO_MAX = f"""
SELECT setval(
    '{SEQUENCE}',
    GREATEST(COALESCE((SELECT MAX(generation) FROM analytics_regrade_run), 0), 0) + 1,
    false
)
"""

#: A duplicate (question, generation) is possible under the old MAX+1 scheme.
#: Give every row after the first a fresh number from the sequence; row order
#: follows created_at so the newest request keeps the highest number.
RENUMBER_DUPLICATES = f"""
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY question_id, generation ORDER BY created_at, id
           ) AS position
    FROM analytics_regrade_run
),
duplicates AS (SELECT id FROM ranked WHERE position > 1)
UPDATE analytics_regrade_run
SET generation = nextval('{SEQUENCE}')
WHERE id IN (SELECT id FROM duplicates)
"""

#: Re-advance after renumbering so future allocations stay above every stored row.
SETVAL_AFTER_BACKFILL = f"""
SELECT setval(
    '{SEQUENCE}',
    GREATEST(COALESCE((SELECT MAX(generation) FROM analytics_regrade_run), 0), 0) + 1,
    false
)
"""


class Migration(migrations.Migration):
    dependencies = [
        ("analytics", "0003_p0_1_grading_and_regrade_semantics"),
    ]

    operations = [
        migrations.RunSQL(CREATE_SEQUENCE, reverse_sql=f"DROP SEQUENCE IF EXISTS {SEQUENCE}"),
        migrations.RunSQL(SETVAL_TO_MAX, reverse_sql=migrations.RunSQL.noop),
        migrations.RunSQL(RENUMBER_DUPLICATES, reverse_sql=migrations.RunSQL.noop),
        migrations.RunSQL(SETVAL_AFTER_BACKFILL, reverse_sql=migrations.RunSQL.noop),
        migrations.AddConstraint(
            model_name="regraderun",
            constraint=models.UniqueConstraint(
                fields=["question", "generation"], name="uniq_regrade_question_generation"
            ),
        ),
    ]
