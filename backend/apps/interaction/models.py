"""Interaction domain: memory-driven learning sessions and their steps.

A session is the unit of *interaction*, not the unit of evidence: it coordinates
warm-up recall, encoding, practice (through the existing practice session),
repair and transfer steps, and stores only what the learner actually did
(docs/26 §6). Grading, evidence and knowledge states stay in their own modules;
this app never writes them.
"""

from __future__ import annotations

from django.db import models

from apps.common.enums import (
    InteractionSessionMode,
    InteractionSessionStatus,
    SessionStage,
    SessionStepKind,
    SessionStepOutcome,
    SessionStepStatus,
)
from apps.common.models import BaseModel


class InteractionSession(BaseModel):
    """One learning session: a planned sequence of steps inside one scope.

    ``status`` is a small state machine enforced by the service:

        planned -> active -> completed
           |          |
           +----------+-> abandoned / expired

    ``practice_session`` is optional because a pure recall session creates no
    practice work; when it is set, the practice steps point at that session's
    items and all existing grading/evidence gates apply unchanged.
    """

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="interaction_sessions")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="interaction_sessions")
    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="interaction_sessions")
    syllabus_version = models.ForeignKey(
        "exams.SyllabusVersion",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="interaction_sessions",
        help_text="会话内考点共同使用的大纲版本；混合大纲时为 null",
    )
    mode = models.CharField(
        max_length=16, choices=InteractionSessionMode.choices, default=InteractionSessionMode.DAILY
    )
    status = models.CharField(
        max_length=16, choices=InteractionSessionStatus.choices, default=InteractionSessionStatus.PLANNED
    )
    stage = models.CharField(max_length=16, choices=SessionStage.choices, default=SessionStage.WARMUP)
    plan = models.ForeignKey(
        "learning.StudyPlan", null=True, blank=True, on_delete=models.SET_NULL, related_name="interaction_sessions"
    )
    practice_session = models.ForeignKey(
        "practice.PracticeSession",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="interaction_sessions",
    )
    budget_minutes = models.PositiveIntegerField(default=0)
    estimated_minutes = models.PositiveIntegerField(default=0)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    summary = models.JSONField(default=dict, blank=True)
    notes = models.JSONField(default=list, blank=True)
    rule_version = models.CharField(max_length=40, default="m1")

    class Meta:
        db_table = "learning_interaction_session"
        indexes = [
            models.Index(fields=["user", "project", "status"]),
            models.Index(fields=["user", "project", "-created_at"]),
            models.Index(fields=["user", "subject", "status"]),
        ]
        ordering = ["-created_at"]
        verbose_name = "学习会话"
        verbose_name_plural = "学习会话"

    def __str__(self) -> str:
        return f"session:{self.mode}:{self.status}"


class SessionStep(BaseModel):
    """One interaction step of a session, in ordinal order.

    A step stores what to show (a snapshot in ``payload``) and what happened
    (``outcome``), never a score of its own: practice steps are graded by the
    existing grading service and recall steps write a :class:`memory.RecallEvent`.
    ``deadline_at`` is the server-owned clock for timed transfer steps.
    """

    session = models.ForeignKey(InteractionSession, on_delete=models.CASCADE, related_name="steps")
    ordinal = models.PositiveIntegerField()
    stage = models.CharField(max_length=16, choices=SessionStage.choices)
    kind = models.CharField(max_length=20, choices=SessionStepKind.choices)
    status = models.CharField(max_length=16, choices=SessionStepStatus.choices, default=SessionStepStatus.PENDING)
    node = models.ForeignKey(
        "knowledge.KnowledgeNode", null=True, blank=True, on_delete=models.SET_NULL, related_name="session_steps"
    )
    question = models.ForeignKey(
        "question_bank.Question", null=True, blank=True, on_delete=models.SET_NULL, related_name="session_steps"
    )
    session_item = models.ForeignKey(
        "practice.SessionItem", null=True, blank=True, on_delete=models.SET_NULL, related_name="interaction_steps"
    )
    estimated_minutes = models.PositiveSmallIntegerField(default=1)
    hint_level = models.PositiveSmallIntegerField(default=0)
    confidence_before = models.PositiveSmallIntegerField(null=True, blank=True)
    outcome = models.CharField(
        max_length=20, choices=SessionStepOutcome.choices, default=SessionStepOutcome.UNKNOWN
    )
    #: Display snapshot (prompt, card revision, question label, ...); never an answer.
    payload = models.JSONField(default=dict, blank=True)
    reason_codes = models.JSONField(default=list, blank=True)
    deadline_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    skipped_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        db_table = "learning_session_step"
        constraints = [
            models.UniqueConstraint(fields=["session", "ordinal"], name="uniq_step_ordinal_per_session"),
        ]
        indexes = [
            models.Index(fields=["session", "status"]),
            models.Index(fields=["session", "kind"]),
        ]
        ordering = ["session", "ordinal"]
        verbose_name = "学习会话步骤"
        verbose_name_plural = "学习会话步骤"

    def __str__(self) -> str:
        return f"step:{self.ordinal}:{self.kind}:{self.status}"
