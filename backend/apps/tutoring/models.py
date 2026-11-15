"""Tutoring domain: validated explanations bound to a session item."""

from __future__ import annotations

from django.db import models

from apps.common.enums import (
    CoachPurpose,
    CoachTurnRole,
    CoachTurnStatus,
    TutorPurpose,
    TutorRequestStatus,
)
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
    #: Set once the *business* final commit landed: the assistant turn, the
    #: exposure fact and the outbox completion. A consumer that finds this set must
    #: not write those facts a second time (C04). Separate from ``delivered_at``,
    #: which only records that a validated result exists on the job row.
    finalized_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "tutoring_job"
        indexes = [models.Index(fields=["user", "status", "-created_at"])]
        ordering = ["-created_at"]
        verbose_name = "辅导任务"
        verbose_name_plural = "辅导任务"

    def __str__(self) -> str:
        return f"tutor job {self.status}"


class TutorSegment(BaseModel):
    """One append-only, *validated* content block of a tutor job (B08).

    Only content that already passed the existing structured-output validation
    (``ai.prompts.registry.validate_explain_payload``) is ever stored here, and a
    stale segment is never delivered: the row mirrors ``TutorJob.result_blocks``
    block by block after the job reached ``succeeded``, so a partial model
    stream, a rejected payload or an invented citation has nothing to mirror.

    ``index`` is both the block position and the SSE event id, which makes the
    reconnect cursor a plain "send everything after this index" question instead
    of a second, lossy notion of position.
    """

    job = models.ForeignKey(TutorJob, on_delete=models.CASCADE, related_name="segments")
    index = models.PositiveIntegerField()
    #: text / math / list — the validated block kinds, nothing else.
    kind = models.CharField(max_length=16)
    text = models.TextField(blank=True)
    #: list blocks only; empty for text and math.
    items = models.JSONField(default=list, blank=True)
    #: sha256 of the canonical block, so tampering with a row is detectable.
    digest = models.CharField(max_length=64)
    #: Set when the frozen source this content was built from no longer holds.
    is_stale = models.BooleanField(default=False, db_index=True)
    stale_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        db_table = "tutoring_segment"
        constraints = [
            models.UniqueConstraint(fields=["job", "index"], name="uniq_tutor_segment_index"),
        ]
        ordering = ["job", "index"]
        verbose_name = "辅导内容片段"
        verbose_name_plural = "辅导内容片段"

    def __str__(self) -> str:
        return f"{self.job_id}#{self.index} ({self.kind})"


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


class CoachTurn(BaseModel):
    """One node-anchored coach exchange (M1 interaction redesign).

    Unlike :class:`TutorJob`, a coach turn is not bound to a practice session
    item: it is bound to a knowledge point and optionally to one step of an
    interaction session. It exists so that recall checks, self-explanation
    checks, hint ladders and misconception probes have a real conversation log
    rather than a one-shot job.

    Safety rules (docs/26 §7):

    * a model reply is stored only after structured validation; a rejected
      reply is stored with ``status=failed`` and never as content;
    * ``structured`` is the validated object, ``text`` is its rendered form for
      the transcript — neither may ever carry a score or a mastery claim;
    * citations are restricted to the ids supplied to the call.
    """

    #: Stable thread id: f"{session_id or 'ad_hoc'}:{node_id}:{purpose}".
    thread_key = models.CharField(max_length=160, db_index=True)
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="coach_turns")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="coach_turns")
    node = models.ForeignKey("knowledge.KnowledgeNode", on_delete=models.CASCADE, related_name="coach_turns")
    session = models.ForeignKey(
        "interaction.InteractionSession",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="coach_turns",
    )
    step = models.ForeignKey(
        "interaction.SessionStep", null=True, blank=True, on_delete=models.SET_NULL, related_name="coach_turns"
    )
    purpose = models.CharField(max_length=24, choices=CoachPurpose.choices)
    role = models.CharField(max_length=12, choices=CoachTurnRole.choices, default=CoachTurnRole.ASSISTANT)
    ordinal = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, choices=CoachTurnStatus.choices, default=CoachTurnStatus.QUEUED)
    #: The learner's question / the assistant's rendered reply; never raw model text.
    text = models.TextField(blank=True)
    #: Validated structured content (purpose-specific schema).
    structured = models.JSONField(default=dict, blank=True)
    citations = models.JSONField(default=list, blank=True)
    missing_information = models.JSONField(default=list, blank=True)
    llm_run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="coach_turns"
    )
    prompt_version = models.CharField(max_length=40, blank=True)
    error_code = models.CharField(max_length=80, blank=True)
    error_message = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "tutoring_coach_turn"
        constraints = [
            models.UniqueConstraint(fields=["thread_key", "ordinal"], name="uniq_coach_turn_ordinal"),
        ]
        indexes = [
            models.Index(fields=["thread_key", "-ordinal"]),
            models.Index(fields=["user", "node", "-created_at"]),
        ]
        ordering = ["thread_key", "ordinal"]
        verbose_name = "考点教练对话"
        verbose_name_plural = "考点教练对话"

    def __str__(self) -> str:
        return f"coach:{self.purpose}:{self.role}:{self.status}"
