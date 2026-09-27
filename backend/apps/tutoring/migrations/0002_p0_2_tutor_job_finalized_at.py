"""P0.2 C04: record the tutor job's business final commit.

``delivered_at`` says a validated model result is stored on the job row; it does
not say the *consequences* of delivering it exist (the assistant turn and the
exposure fact). A consumer could crash between the two, and two consumers could
both write them. ``finalized_at`` marks the completed business commit so a
re-delivery finishes missing facts exactly once instead of duplicating them.

Nullable and additive: existing rows stay valid, no backfill is needed, and the
column is only written inside the short transaction that locks the job row.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tutoring", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="tutorjob",
            name="finalized_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
