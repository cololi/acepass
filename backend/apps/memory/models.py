"""Memory domain models (FSRS active-recall cards).

Card state is a separate projection from
:class:`apps.learning.models.LearnerKnowledgeState`: remembering a card never
upgrades solving ability, and reviewing a card never writes evidence, a grade or
a knowledge state. The card scheduler only answers "when should this question be
shown again for recall practice".

Both tables are append-only in spirit: the card row holds the current
projection, while :class:`MemoryReviewLog` is the immutable ledger that produced
it. A card can therefore always be recomputed from its logs
(``apps.memory.services.scheduler.rebuild_card_from_logs``), which is the
recovery evidence the acceptance rules ask for (B06).
"""

from __future__ import annotations

from django.db import models

from apps.common.enums import MemoryCardPhase, MemoryRating
from apps.common.models import BaseModel
from domain.memory.fsrs import DEFAULT_DESIRED_RETENTION, FSRS_VERSION


class MemoryCard(BaseModel):
    """Current FSRS state of one (user, question) active-recall card.

    The card carries the scheduler version and the parameter version it was last
    written with, so a later change of defaults never silently rewrites history:
    the logs are replayed with the version they recorded.
    """

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="memory_cards")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="memory_cards")
    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="memory_cards")
    question = models.ForeignKey("question_bank.Question", on_delete=models.CASCADE, related_name="memory_cards")
    knowledge_node = models.ForeignKey(
        "knowledge.KnowledgeNode",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="memory_cards",
        help_text="主考点（可空）：用于按考点聚合记忆卡，不代表解题能力",
    )
    phase = models.CharField(max_length=16, choices=MemoryCardPhase.choices, default=MemoryCardPhase.NEW, db_index=True)
    #: FSRS stability in days; 0 means "no memory state yet".
    stability = models.FloatField(default=0.0)
    #: FSRS difficulty on the published 1..10 scale.
    difficulty = models.FloatField(default=0.0)
    due_at = models.DateTimeField(null=True, blank=True, db_index=True)
    last_reviewed_at = models.DateTimeField(null=True, blank=True)
    reps = models.PositiveIntegerField(default=0, help_text="已完成复习次数（含学习步骤）")
    lapses = models.PositiveIntegerField(default=0, help_text="已从复习阶段遗忘的次数")
    learning_step = models.PositiveIntegerField(default=0, help_text="已走完的短步数（0 表示等待第一步）")
    scheduler_version = models.CharField(max_length=40, default=FSRS_VERSION)
    params_version = models.CharField(max_length=40, default=FSRS_VERSION)
    desired_retention = models.FloatField(default=DEFAULT_DESIRED_RETENTION)
    is_suspended = models.BooleanField(default=False)
    suspended_reason = models.CharField(max_length=300, blank=True)
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "memory_card"
        constraints = [
            models.UniqueConstraint(fields=["user", "question"], name="uniq_memory_card_per_question"),
        ]
        indexes = [
            models.Index(fields=["user", "project", "due_at"]),
            models.Index(fields=["user", "is_suspended", "due_at"]),
        ]
        ordering = ["due_at", "created_at"]
        verbose_name = "记忆卡"
        verbose_name_plural = "记忆卡"

    def __str__(self) -> str:
        return f"card:{self.question_id}:{self.phase}"


class MemoryReviewLog(BaseModel):
    """Append-only ledger of one memory review.

    Rows are never updated and never deleted: the card row is only a projection,
    and the card state must stay reproducible by replaying its logs in
    ``reviewed_at`` order with the recorded ``params_version``. Every log stores
    the state before and after the review, so a corrupted card can be detected
    and rebuilt without guessing (``rebuild_card_from_logs``).

    ``scheduled_days`` is the interval the card had been waiting out before this
    review, ``elapsed_days`` the time actually elapsed, and ``interval_days`` the
    interval scheduled by this review. ``idempotency_key`` is unique per card, so
    a retried request replays instead of scheduling the same review twice.
    """

    card = models.ForeignKey(MemoryCard, on_delete=models.CASCADE, related_name="logs")
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="memory_review_logs")
    rating = models.CharField(max_length=16, choices=MemoryRating.choices)
    reviewed_at = models.DateTimeField(db_index=True)
    elapsed_days = models.FloatField(default=0.0)
    scheduled_days = models.FloatField(default=0.0)
    interval_days = models.FloatField(default=0.0)
    retrievability = models.FloatField(default=1.0)
    is_lapse = models.BooleanField(default=False)
    phase_before = models.CharField(max_length=16, choices=MemoryCardPhase.choices)
    phase_after = models.CharField(max_length=16, choices=MemoryCardPhase.choices)
    stability_before = models.FloatField(default=0.0)
    stability_after = models.FloatField(default=0.0)
    difficulty_before = models.FloatField(default=0.0)
    difficulty_after = models.FloatField(default=0.0)
    due_before = models.DateTimeField(null=True, blank=True)
    due_after = models.DateTimeField(null=True, blank=True)
    scheduler_version = models.CharField(max_length=40, default=FSRS_VERSION)
    params_version = models.CharField(max_length=40, default=FSRS_VERSION)
    idempotency_key = models.CharField(max_length=200)
    source_session_item = models.ForeignKey(
        "practice.SessionItem",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="memory_review_logs",
        help_text="来源题项（可空）：仅作来源说明，不产生学习证据",
    )
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "memory_review_log"
        constraints = [
            models.UniqueConstraint(fields=["card", "idempotency_key"], name="uniq_memory_log_idempotency"),
        ]
        indexes = [
            models.Index(fields=["card", "-reviewed_at"]),
            models.Index(fields=["user", "reviewed_at"]),
        ]
        ordering = ["-reviewed_at", "-created_at"]
        verbose_name = "记忆复习日志"
        verbose_name_plural = "记忆复习日志"

    def __str__(self) -> str:
        return f"log:{self.card_id}:{self.rating}@{self.reviewed_at:%Y-%m-%d %H:%M}"
