"""P1 B08: append-only validated content segments for tutor jobs.

``TutorJob.result_blocks`` is the durable record of one validated model answer,
but it is a whole JSON document: a client cannot resume it, and an index into it
has no identity a reconnecting browser could send back. ``TutorSegment`` mirrors
that document one block per row, with the block position as the SSE event id, so
"reconnect after event n" is one indexed query and never a second model call.

The table only ever holds blocks that already passed
``validate_explain_payload``: the rows are written from the job's stored result,
inside the same commit as the assistant turn. ``(job, index)`` is unique, so a
re-delivery completes a missing mirror instead of duplicating content.
"""

from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    dependencies = [
        ("tutoring", "0002_p0_2_tutor_job_finalized_at"),
    ]

    operations = [
        migrations.CreateModel(
            name="TutorSegment",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("index", models.PositiveIntegerField()),
                ("kind", models.CharField(max_length=16)),
                ("text", models.TextField(blank=True)),
                ("items", models.JSONField(blank=True, default=list)),
                ("digest", models.CharField(max_length=64)),
                ("is_stale", models.BooleanField(db_index=True, default=False)),
                ("stale_reason", models.CharField(blank=True, max_length=300)),
                (
                    "job",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="segments",
                        to="tutoring.tutorjob",
                    ),
                ),
            ],
            options={
                "verbose_name": "辅导内容片段",
                "verbose_name_plural": "辅导内容片段",
                "db_table": "tutoring_segment",
                "ordering": ["job", "index"],
                "constraints": [
                    models.UniqueConstraint(fields=("job", "index"), name="uniq_tutor_segment_index")
                ],
            },
        ),
    ]
