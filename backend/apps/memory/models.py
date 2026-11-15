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

from apps.common.enums import (
    MemoryCardPhase,
    MemoryRating,
    NodeMemoryModality,
    RecallEventKind,
    RecallEventSource,
)
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


class NodeMemoryState(BaseModel):
    """Current FSRS state of one knowledge point's active recall (M1 redesign).

    This is the memory projection of the *knowledge point*, not of a question.
    It is updated only by :class:`RecallEvent` rows written from a confirmed
    retrieval attempt; it never reflects solving ability and never writes
    ``LearnerKnowledgeState`` or :class:`LearningEvidence` (docs/26 §10).

    ``desired_retention`` is derived from the exam-frequency value index when
    the row is created and then stays fixed: rewriting it later would silently
    change every past interval of a replay.
    """

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="node_memory_states")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="node_memory_states")
    syllabus_version = models.ForeignKey(
        "exams.SyllabusVersion", on_delete=models.CASCADE, related_name="node_memory_states"
    )
    node = models.ForeignKey("knowledge.KnowledgeNode", on_delete=models.CASCADE, related_name="memory_states")
    modality = models.CharField(
        max_length=16, choices=NodeMemoryModality.choices, default=NodeMemoryModality.RECALL
    )
    phase = models.CharField(max_length=16, choices=MemoryCardPhase.choices, default=MemoryCardPhase.NEW)
    stability = models.FloatField(default=0.0)
    difficulty = models.FloatField(default=0.0)
    due_at = models.DateTimeField(null=True, blank=True, db_index=True)
    last_recall_at = models.DateTimeField(null=True, blank=True)
    reps = models.PositiveIntegerField(default=0)
    lapses = models.PositiveIntegerField(default=0)
    learning_step = models.PositiveIntegerField(default=0)
    scheduler_version = models.CharField(max_length=40, default=FSRS_VERSION)
    params_version = models.CharField(max_length=40, default=FSRS_VERSION)
    desired_retention = models.FloatField(default=DEFAULT_DESIRED_RETENTION)
    is_suspended = models.BooleanField(default=False)
    suspended_reason = models.CharField(max_length=300, blank=True)
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "memory_node_state"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "node", "modality"], name="uniq_node_memory_per_modality"
            ),
        ]
        indexes = [
            models.Index(fields=["user", "project", "due_at"]),
            models.Index(fields=["user", "node"]),
        ]
        ordering = ["due_at", "created_at"]
        verbose_name = "考点记忆状态"
        verbose_name_plural = "考点记忆状态"

    def __str__(self) -> str:
        return f"node-memory:{self.node_id}:{self.phase}"


class RecallEvent(BaseModel):
    """Append-only ledger of one retrieval attempt on a knowledge point.

    Every row stores the projection before and after itself, exactly like
    :class:`MemoryReviewLog`: the state row is only a projection and can be
    rebuilt by replaying the events in ``reviewed_at`` order with the recorded
    ``params_version``. ``idempotency_key`` is unique per memory state, so a
    retried request replays the stored event instead of scheduling twice.

    ``is_spaced`` is the honesty gate from docs/26 §5.2: a repeated recall inside
    the same 10-minute window is recorded for audit but must not move the
    scheduler.
    """

    memory_state = models.ForeignKey(NodeMemoryState, on_delete=models.CASCADE, related_name="events")
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="recall_events")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="recall_events")
    syllabus_version = models.ForeignKey(
        "exams.SyllabusVersion", on_delete=models.CASCADE, related_name="recall_events"
    )
    node = models.ForeignKey("knowledge.KnowledgeNode", on_delete=models.CASCADE, related_name="recall_events")
    kind = models.CharField(max_length=20, choices=RecallEventKind.choices)
    rating = models.CharField(max_length=16, choices=MemoryRating.choices)
    source = models.CharField(max_length=24, choices=RecallEventSource.choices)
    is_spaced = models.BooleanField(default=True)
    early_review = models.BooleanField(default=False)
    #: ``{"covered": [kp_id], "missing": [kp_id], "cannot_judge": [kp_id], "coverage": 0.5}``
    coverage = models.JSONField(default=dict, blank=True)
    prompt_text = models.TextField(blank=True)
    answer_text = models.TextField(blank=True)
    latency_ms = models.PositiveIntegerField(null=True, blank=True)
    confidence_before = models.PositiveSmallIntegerField(null=True, blank=True)
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
    session = models.ForeignKey(
        "interaction.InteractionSession",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="recall_events",
    )
    step = models.ForeignKey(
        "interaction.SessionStep",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="recall_events",
    )
    question = models.ForeignKey(
        "question_bank.Question", null=True, blank=True, on_delete=models.SET_NULL, related_name="recall_events"
    )
    session_item = models.ForeignKey(
        "practice.SessionItem", null=True, blank=True, on_delete=models.SET_NULL, related_name="recall_events"
    )
    model_run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="recall_events"
    )
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "memory_recall_event"
        constraints = [
            models.UniqueConstraint(
                fields=["memory_state", "idempotency_key"], name="uniq_recall_event_idempotency"
            ),
        ]
        indexes = [
            models.Index(fields=["user", "node", "-reviewed_at"]),
            models.Index(fields=["user", "reviewed_at"]),
            models.Index(fields=["session", "step"]),
        ]
        ordering = ["-reviewed_at", "-created_at"]
        verbose_name = "考点回忆事件"
        verbose_name_plural = "考点回忆事件"

    def __str__(self) -> str:
        return f"recall:{self.node_id}:{self.rating}@{self.reviewed_at:%Y-%m-%d %H:%M}"
