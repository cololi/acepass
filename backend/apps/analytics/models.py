"""Analytics domain: report snapshots and recompute runs.

Reports are projections over confirmed evidence with an explicit input
watermark; missing data is reported as missing, never as zero.
"""

from __future__ import annotations

from django.db import models, transaction

from apps.common.enums import RecomputeStatus, RegradeStatus
from apps.common.models import BaseModel


class ReportSnapshot(BaseModel):
    """A computed practice report for one project and filter set."""

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="report_snapshots")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="report_snapshots")
    subject = models.ForeignKey(
        "exams.Subject", null=True, blank=True, on_delete=models.SET_NULL, related_name="report_snapshots"
    )
    report_kind = models.CharField(max_length=40, default="practice")
    calculation_version = models.CharField(max_length=40, default="p0-1")
    input_watermark = models.JSONField(default=dict, blank=True)
    filters = models.JSONField(default=dict, blank=True)
    as_of = models.DateTimeField()
    status = models.CharField(
        max_length=16, choices=RecomputeStatus.choices, default=RecomputeStatus.SUCCEEDED, db_index=True
    )
    payload = models.JSONField(default=dict, blank=True)
    notes = models.JSONField(default=list, blank=True)
    is_stale = models.BooleanField(default=False, help_text="输入已变化，需要重算")

    class Meta:
        db_table = "analytics_report_snapshot"
        indexes = [models.Index(fields=["user", "project", "report_kind", "-as_of"])]
        ordering = ["-as_of"]
        verbose_name = "报告快照"
        verbose_name_plural = "报告快照"

    def __str__(self) -> str:
        return f"report {self.report_kind}@{self.as_of:%Y-%m-%d %H:%M}"


class RecomputeRun(BaseModel):
    """One evidence/report recomputation, with its input version set."""

    user = models.ForeignKey("accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="recompute_runs")
    project = models.ForeignKey(
        "exams.ExamProject", null=True, blank=True, on_delete=models.CASCADE, related_name="recompute_runs"
    )
    reason = models.CharField(max_length=200, blank=True)
    scope = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=16, choices=RecomputeStatus.choices, default=RecomputeStatus.QUEUED, db_index=True
    )
    input_watermark = models.JSONField(default=dict, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    affected_attempts = models.PositiveIntegerField(default=0)
    affected_evidence = models.PositiveIntegerField(default=0)
    error_message = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "analytics_recompute_run"
        ordering = ["-created_at"]
        verbose_name = "重算运行"
        verbose_name_plural = "重算运行"


class RegradeRun(BaseModel):
    """A regrade against a specific reviewed answer/rubric revision."""

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="regrade_runs")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="regrade_runs")
    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="regrade_runs")
    question = models.ForeignKey("question_bank.Question", on_delete=models.CASCADE, related_name="regrade_runs")
    target_answer_key_version = models.ForeignKey(
        "question_bank.AnswerKeyVersion", on_delete=models.PROTECT, related_name="regrade_runs"
    )
    target_rubric_version = models.ForeignKey(
        "question_bank.RubricVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="regrade_runs"
    )
    reason = models.CharField(max_length=500)
    scope = models.CharField(max_length=32, default="all_attempts")
    status = models.CharField(
        max_length=16, choices=RegradeStatus.choices, default=RegradeStatus.QUEUED, db_index=True
    )
    #: Monotonic request order, allocated by the PostgreSQL sequence
    #: ``analytics_regrade_generation_seq`` (see
    #: ``apps.analytics.services.reports._next_regrade_generation``). Every
    #: request gets a number no other row can share, so a task issued earlier can
    #: never overwrite a result written by a later request even when the older
    #: task is executed last. ``nextval`` replaced "MAX + 1", which let two
    #: concurrent requests read the same maximum and insert the same number
    #: (B01); ``uniq_regrade_question_generation`` is the database backstop.
    generation = models.PositiveIntegerField(default=0, db_index=True)
    affected_attempts = models.PositiveIntegerField(default=0)
    regraded_attempts = models.PositiveIntegerField(default=0)
    stale_skipped_attempts = models.PositiveIntegerField(
        default=0, help_text="因更新的重判/评分已生效而拒绝写入的作答数"
    )
    invalidated_evidence = models.PositiveIntegerField(default=0)
    error_message = models.CharField(max_length=500, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    requested_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="requested_regrades"
    )

    class Meta:
        db_table = "analytics_regrade_run"
        ordering = ["-created_at"]
        verbose_name = "重判运行"
        verbose_name_plural = "重判运行"
        constraints = [
            # The database, not application bookkeeping, is what makes a
            # duplicate generation impossible under concurrency.
            models.UniqueConstraint(
                fields=["question", "generation"], name="uniq_regrade_question_generation"
            ),
        ]

    #: Database sequence that hands out regrade generations. Created by migration
    #: ``analytics.0004_p0_2_regrade_generation_sequence``.
    GENERATION_SEQUENCE = "analytics_regrade_generation_seq"

    @classmethod
    def allocate_generation(cls) -> int:
        """Return the next regrade generation number.

        ``nextval`` is atomic, monotonic and never blocks on another consumer, so
        two concurrent requests can never receive the same number. It also never
        rolls back with a failed transaction, which is exactly what a
        "requests-issued-so-far" counter must not do: a rolled-back request must
        not be allowed to hand its number to a later request that would then
        execute before the original one.

        On a non-PostgreSQL backend (the project targets PostgreSQL everywhere;
        this is a defensive fallback) the newest existing row is locked instead,
        which serialises requests but keeps the uniqueness guarantee.
        """
        from django.db import connections

        connection = connections[cls.objects.db]
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                cursor.execute(f"SELECT nextval('{cls.GENERATION_SEQUENCE}')")
                return int(cursor.fetchone()[0])
        with transaction.atomic():
            newest = (
                cls.objects.select_for_update().order_by("-generation").values_list("generation", flat=True).first()
            )
            return int(newest or 0) + 1
