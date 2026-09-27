"""Tutoring domain: validated explanations bound to a session item."""

from __future__ import annotations

from django.db import models

from apps.common.enums import TutorPurpose, TutorRequestStatus
from apps.common.models import BaseModel


class TutorSession(BaseModel):
    """A tutoring thread. Always bound to one practice session item.

    An attempt is optional: practice may ask for a hint or a full explanation
    before submitting anything, which must be recorded as assistance rather
    than quietly ignored.
    """

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="tutor_sessions")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="tutor_sessions")
    practice_session = models.ForeignKey(
        "practice.PracticeSession", on_delete=models.CASCADE, related_name="tutor_sessions"
    )
    session_item = models.ForeignKey(
        "practice.SessionItem", on_delete=models.CASCADE, related_name="tutor_sessions"
    )
    attempt = models.ForeignKey(
        "practice.Attempt", null=True, blank=True, on_delete=models.SET_NULL, related_name="tutor_sessions"
    )
    purpose = models.CharField(max_length=16, choices=TutorPurpose.choices, default=TutorPurpose.EXPLANATION)
    #: Frozen inputs so a later edit cannot change what was explained.
    question_version = models.ForeignKey(
        "question_bank.QuestionVersion", null=True, blank=True, on_delete=models.SET_NULL, related_name="tutor_sessions"
    )
    answer_key_version = models.ForeignKey(
        "question_bank.AnswerKeyVersion", null=True, blank=True, on_delete=models.SET_NULL, related_name="tutor_sessions"
    )
    rubric_version = models.ForeignKey(
        "question_bank.RubricVersion", null=True, blank=True, on_delete=models.SET_NULL, related_name="tutor_sessions"
    )
    prompt_version = models.CharField(max_length=40, default="p0-explain-v1")

    class Meta:
        db_table = "tutoring_session"
        indexes = [models.Index(fields=["user", "project", "-created_at"])]
        ordering = ["-created_at"]
        verbose_name = "辅导会话"
        verbose_name_plural = "辅导会话"

    def __str__(self) -> str:
        return f"tutor#{self.id}"


class TutorJob(BaseModel):
    """One model-backed request. The validated result is polled, never streamed raw."""

    tutor_session = models.ForeignKey(TutorSession, on_delete=models.CASCADE, related_name="jobs")
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="tutor_jobs")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="tutor_jobs")
    purpose = models.CharField(max_length=16, choices=TutorPurpose.choices, default=TutorPurpose.EXPLANATION)
    status = models.CharField(
        max_length=16, choices=TutorRequestStatus.choices, default=TutorRequestStatus.QUEUED, db_index=True
    )
    request_text = models.TextField(blank=True)
    #: Validated content only: [{"kind": "text"|"math"|"list", ...}]
    result_blocks = models.JSONField(default=list, blank=True)
    citations = models.JSONField(default=list, blank=True)
    missing_information = models.JSONField(default=list, blank=True)
    suggested_next = models.JSONField(default=list, blank=True)
    error_code = models.CharField(max_length=80, blank=True)
    error_message = models.CharField(max_length=500, blank=True)
    llm_run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="tutor_jobs"
    )
    input_fingerprint = models.CharField(max_length=64, blank=True, db_index=True)
    #: Set when the frozen inputs changed after the job started.
    is_stale = models.BooleanField(default=False)
    #: True when the delivered content includes the answer itself.
    reveals_answer = models.BooleanField(default=False)
    delivered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "tutoring_job"
        indexes = [models.Index(fields=["user", "status", "-created_at"])]
        ordering = ["-created_at"]
        verbose_name = "辅导任务"
        verbose_name_plural = "辅导任务"

    def __str__(self) -> str:
        return f"tutor job {self.status}"


class TutorTurn(BaseModel):
    """Conversation log. Kept separate from the validated job output."""

    tutor_session = models.ForeignKey(TutorSession, on_delete=models.CASCADE, related_name="turns")
    role = models.CharField(max_length=16, default="user")
    text = models.TextField(blank=True)
    job = models.ForeignKey(TutorJob, null=True, blank=True, on_delete=models.SET_NULL, related_name="turns")

    class Meta:
        db_table = "tutoring_turn"
        ordering = ["created_at"]
        verbose_name = "辅导对话"
        verbose_name_plural = "辅导对话"
