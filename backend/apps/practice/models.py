"""Practice domain: sessions, presented items, attempts, grading and exposure."""

from __future__ import annotations

from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import models

from apps.common.enums import (
    EvidenceDimension,
    ExposureKind,
    ExposurePurpose,
    FollowUpStatus,
    GradeEventKind,
    GradeMethod,
    GradeStatus,
    SessionMode,
    SessionStatus,
    TranscriptionStatus,
)
from apps.common.models import BaseModel


class PracticeSession(BaseModel):
    """A run of items in one mode. The server owns which mode applies."""

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="practice_sessions")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="practice_sessions")
    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="practice_sessions")
    mode = models.CharField(max_length=16, choices=SessionMode.choices, default=SessionMode.PRACTICE, db_index=True)
    status = models.CharField(max_length=16, choices=SessionStatus.choices, default=SessionStatus.ACTIVE, db_index=True)
    #: Rule/criteria version so a later rule change can be told apart.
    policy_version = models.CharField(max_length=40, default="p0-1")
    #: For verification: whether the whole run may be revealed yet.
    revealed_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    #: Server-owned clock of a mock exam (C05). Both instants are written exactly
    #: once, inside the creation transaction, from ``timezone.now()`` — the
    #: request's own wall clock is never read. ``exam_deadline`` is the frozen
    #: end of the exam and :meth:`save` refuses to move it afterwards; the pair is
    #: kept so the deadline stays derivable and auditable
    #: (``exam_started_at + duration``) even if one field is ever lost.
    exam_started_at = models.DateTimeField(
        null=True, blank=True, help_text="模拟考试开始时间（服务器时钟，创建时写入一次）"
    )
    exam_deadline = models.DateTimeField(
        null=True, blank=True, help_text="模拟考试截止时间（服务器派生的时长，创建时写入一次，之后不可移动）"
    )
    #: When the server *noticed* the deadline had passed and finished the run.
    #: The end of the exam is ``exam_deadline`` (and ``finished_at``), not this
    #: moment: this field only records how long the run stayed reconcilable.
    expired_at = models.DateTimeField(null=True, blank=True)
    origin_task = models.ForeignKey(
        "learning.StudyTask", null=True, blank=True, on_delete=models.SET_NULL, related_name="sessions"
    )
    note = models.CharField(max_length=300, blank=True)

    class Meta:
        db_table = "practice_session"
        indexes = [models.Index(fields=["user", "status", "-created_at"])]
        ordering = ["-created_at"]
        verbose_name = "练习会话"
        verbose_name_plural = "练习会话"

    def __str__(self) -> str:
        return f"session#{self.id} {self.mode}"

    def save(self, *args, **kwargs):
        """Enforce the one-way, server-owned exam lifecycle (C05).

        Two invariants cannot be expressed as a column constraint because they
        compare the new row with the stored one:

        * ``exam_deadline`` is written once at creation and never moves. Every
          endpoint is therefore unable to extend an exam, and a future careless
          ``save()`` fails loudly instead of silently granting extra time.
        * a finished run never returns to ``active``: "one-shot submit" means the
          exam cannot be reopened by any path.

        ``QuerySet.update()`` (used by the demo-reset command and by tests that
        simulate legacy rows) bypasses this on purpose; the guard covers every
        model-level write.
        """
        update_fields = kwargs.get("update_fields")
        if not self._state.adding:
            stored = (
                PracticeSession.objects.filter(pk=self.pk)
                .values("status", "exam_deadline")
                .first()
            )
            if stored is not None:
                if (
                    (update_fields is None or "exam_deadline" in update_fields)
                    and stored["exam_deadline"] is not None
                    and self.exam_deadline is not None
                    and stored["exam_deadline"] != self.exam_deadline
                ):
                    raise ValidationError(
                        {"exam_deadline": "模拟考试截止时间由服务器在创建时写入一次，之后不可修改或延长（C05）"}
                    )
                if (
                    (update_fields is None or "status" in update_fields)
                    and stored["status"] != SessionStatus.ACTIVE
                    and self.status == SessionStatus.ACTIVE
                ):
                    raise ValidationError({"status": "会话已结束，不能在结束之后重新开始（考试不可重开）"})
        super().save(*args, **kwargs)

    @property
    def hides_grading(self) -> bool:
        """Verification and mock exams hide scores until the run is over."""
        return self.mode in {SessionMode.VERIFICATION, SessionMode.MOCK_EXAM} and self.status == SessionStatus.ACTIVE

    @property
    def allows_pre_submit_answers(self) -> bool:
        """Only practice may reveal answers before submitting."""
        return self.mode == SessionMode.PRACTICE


class SessionItem(BaseModel):
    """One fixed question presentation inside a session.

    Every grading-relevant version is frozen here: question content, answer key,
    rubric, exam spec and mapping. A later edit of any of them cannot change how
    this item was graded.
    """

    session = models.ForeignKey(PracticeSession, on_delete=models.CASCADE, related_name="items")
    ordinal = models.PositiveIntegerField()
    question_version = models.ForeignKey(
        "question_bank.QuestionVersion", on_delete=models.PROTECT, related_name="session_items"
    )
    answer_key_version = models.ForeignKey(
        "question_bank.AnswerKeyVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="session_items"
    )
    rubric_version = models.ForeignKey(
        "question_bank.RubricVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="session_items"
    )
    spec_version = models.ForeignKey(
        "exams.ExamSpecVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="session_items"
    )
    mapping_revision = models.PositiveIntegerField(default=1)
    max_score = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    #: practice / paired_immediate / delayed_verification / weakness_repair ...
    purpose = models.CharField(max_length=32, default="practice")
    paper_item = models.ForeignKey(
        "exams.PaperItem", null=True, blank=True, on_delete=models.SET_NULL, related_name="session_items"
    )
    pairing = models.ForeignKey(
        "knowledge.VerificationPairing", null=True, blank=True, on_delete=models.SET_NULL, related_name="session_items"
    )
    tutoring_allowed = models.BooleanField(default=True)
    first_delivered_at = models.DateTimeField(null=True, blank=True)
    draft = models.JSONField(default=dict, blank=True)
    draft_revision = models.PositiveIntegerField(default=0)
    draft_updated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "practice_session_item"
        constraints = [
            models.UniqueConstraint(fields=["session", "ordinal"], name="uniq_session_item_ordinal"),
        ]
        ordering = ["session", "ordinal"]
        verbose_name = "会话题项"
        verbose_name_plural = "会话题项"

    def __str__(self) -> str:
        return f"{self.session_id}#{self.ordinal}"


class Attempt(BaseModel):
    """The user's immutable submission for one session item."""

    session_item = models.OneToOneField(SessionItem, on_delete=models.PROTECT, related_name="attempt")
    user = models.ForeignKey("accounts.User", on_delete=models.PROTECT, related_name="attempts")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.PROTECT, related_name="attempts")
    raw_answer = models.JSONField(default=dict)
    steps = models.JSONField(default=list, blank=True)
    #: Attachment asset ids, append-only: later uploads never replace these.
    attachments = models.JSONField(default=list, blank=True)
    confidence = models.CharField(max_length=16, blank=True)
    submitted_at = models.DateTimeField()
    #: Server-measured elapsed time (authoritative) and client telemetry.
    elapsed_ms = models.PositiveIntegerField(default=0)
    client_active_ms = models.PositiveIntegerField(null=True, blank=True)
    request_digest = models.CharField(max_length=64, blank=True)
    idempotency_key = models.CharField(max_length=200, blank=True, db_index=True)
    #: Current effective grade event pointer (append-only history lives in GradeEvent).
    current_grade_event = models.ForeignKey(
        "practice.GradeEvent", null=True, blank=True, on_delete=models.SET_NULL, related_name="effective_for_attempts"
    )
    grading_revision = models.PositiveIntegerField(default=0)
    #: Highest regrade *request generation* that has actually written a result.
    #: Only ever moves forward, so a task issued earlier can never overwrite a
    #: result produced by a later request.
    applied_regrade_generation = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "practice_attempt"
        indexes = [models.Index(fields=["user", "project", "-submitted_at"])]
        ordering = ["-submitted_at"]
        verbose_name = "作答"
        verbose_name_plural = "作答"

    def __str__(self) -> str:
        return f"attempt#{self.id}"


class GradeEvent(BaseModel):
    """Append-only grading record. Nothing here is ever overwritten."""

    attempt = models.ForeignKey(Attempt, on_delete=models.CASCADE, related_name="grade_events")
    kind = models.CharField(max_length=24, choices=GradeEventKind.choices, default=GradeEventKind.INITIAL)
    status = models.CharField(max_length=16, choices=GradeStatus.choices, default=GradeStatus.PENDING_REVIEW)
    method = models.CharField(max_length=24, choices=GradeMethod.choices, default=GradeMethod.DETERMINISTIC)
    grading_revision = models.PositiveIntegerField(default=1)
    confirmed_score = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    max_score = models.DecimalField(max_digits=10, decimal_places=2)
    pending_max_score = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    estimated_score = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True, help_text="AI 估计，独立字段，永不进入正式分"
    )
    is_fully_confirmed = models.BooleanField(default=False)
    parts = models.JSONField(default=list, blank=True)
    #: Frozen grading inputs.
    answer_key_version = models.ForeignKey(
        "question_bank.AnswerKeyVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="grade_events"
    )
    rubric_version = models.ForeignKey(
        "question_bank.RubricVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="grade_events"
    )
    spec_version = models.ForeignKey(
        "exams.ExamSpecVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="grade_events"
    )
    rule_snapshot = models.JSONField(default=dict, blank=True)
    rule_version = models.CharField(max_length=40, default="p0-1")
    grader = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="grade_events"
    )
    grader_is_self = models.BooleanField(default=False)
    comment = models.CharField(max_length=1000, blank=True)
    supersedes = models.ForeignKey(
        "practice.GradeEvent", null=True, blank=True, on_delete=models.SET_NULL, related_name="superseded_by"
    )
    is_superseded = models.BooleanField(default=False, db_index=True)
    invalidation_reason = models.CharField(max_length=500, blank=True)
    llm_run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="grade_events"
    )

    class Meta:
        db_table = "practice_grade_event"
        constraints = [
            models.UniqueConstraint(fields=["attempt", "grading_revision"], name="uniq_grade_revision_per_attempt"),
        ]
        indexes = [models.Index(fields=["attempt", "-grading_revision"])]
        ordering = ["attempt", "-grading_revision"]
        verbose_name = "判分事件"
        verbose_name_plural = "判分事件"

    def __str__(self) -> str:
        return f"grade r{self.grading_revision} {self.status}"

    def clean(self) -> None:
        errors: dict[str, str] = {}
        if self.confirmed_score is not None and self.confirmed_score < 0:
            errors["confirmed_score"] = "确认分不能为负"
        if self.confirmed_score is not None and self.confirmed_score > self.max_score:
            errors["confirmed_score"] = "确认分不能超过满分"
        if errors:
            raise ValidationError(errors)


class ExposureEvent(BaseModel):
    """What the server actually delivered to the user, and when.

    Recorded from the server side (not from a client click report) so tutoring,
    previews, editorial views and file access all appear in one ledger.
    """

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="exposure_events")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="exposure_events")
    question = models.ForeignKey(
        "question_bank.Question", null=True, blank=True, on_delete=models.SET_NULL, related_name="exposure_events"
    )
    question_version = models.ForeignKey(
        "question_bank.QuestionVersion",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="exposure_events",
    )
    family = models.ForeignKey(
        "question_bank.QuestionFamily", null=True, blank=True, on_delete=models.SET_NULL, related_name="exposure_events"
    )
    content_lineage = models.ForeignKey(
        "question_bank.ContentLineage", null=True, blank=True, on_delete=models.SET_NULL, related_name="exposure_events"
    )
    session_item = models.ForeignKey(
        SessionItem, null=True, blank=True, on_delete=models.SET_NULL, related_name="exposure_events"
    )
    kind = models.CharField(max_length=32, choices=ExposureKind.choices, db_index=True)
    purpose = models.CharField(max_length=24, choices=ExposurePurpose.choices, default=ExposurePurpose.PRACTICE)
    #: Which server entry point produced the exposure.
    source = models.CharField(max_length=60, default="api")
    server_time = models.DateTimeField(db_index=True)
    detail = models.JSONField(default=dict, blank=True)
    #: True when the delivered payload can be used to infer the answer.
    reveals_answer = models.BooleanField(default=False, db_index=True)

    class Meta:
        db_table = "practice_exposure_event"
        indexes = [
            models.Index(fields=["user", "question", "kind"]),
            models.Index(fields=["question_version", "kind"]),
        ]
        ordering = ["-server_time"]
        verbose_name = "暴露事件"
        verbose_name_plural = "暴露事件"

    def __str__(self) -> str:
        return f"{self.kind}@{self.server_time:%Y-%m-%d %H:%M}"


class ErrorDiagnosis(BaseModel):
    """Candidate error cause. Never changes a score or a mastery state."""

    attempt = models.ForeignKey(Attempt, on_delete=models.CASCADE, related_name="diagnoses")
    error_type = models.CharField(max_length=40, default="unknown")
    evidence = models.JSONField(default=list, blank=True)
    #: model / user / reviewer
    origin = models.CharField(max_length=16, default="user")
    llm_run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="diagnoses"
    )
    #: proposed / confirmed / rejected / unknown
    status = models.CharField(max_length=16, default="proposed", db_index=True)
    note = models.CharField(max_length=500, blank=True)
    decided_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="decided_diagnoses"
    )
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "practice_error_diagnosis"
        ordering = ["-created_at"]
        verbose_name = "错误原因"
        verbose_name_plural = "错误原因"

    def __str__(self) -> str:
        return f"{self.error_type}:{self.status}"


class AnswerTranscription(BaseModel):
    """One handwriting-transcription record for one answer photo.

    A vision model may read the image, and the learner then confirms or edits what
    the system thinks they wrote. Without a vision model the learner types the
    text themselves (``origin="manual"``), which is the honest fallback the P0
    import path already uses. Only :attr:`confirmed_text` may feed grading,
    estimation or diagnosis — :attr:`raw_text` is a *proposal* and is never a
    source of truth. ``is_stub`` marks a test/demo transcription, which is never a
    real recognition result.
    """

    attempt = models.ForeignKey(Attempt, on_delete=models.CASCADE, related_name="transcriptions")
    #: The id inside ``Attempt.attachments`` (append-only asset list).
    asset_id = models.CharField(max_length=64)
    #: ``model`` when a vision provider read the photo, ``manual`` when the learner
    #: typed their own work. A manual row is never labelled as a recognition result.
    origin = models.CharField(max_length=16, default="model")
    run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="transcriptions"
    )
    status = models.CharField(
        max_length=16, choices=TranscriptionStatus.choices, default=TranscriptionStatus.PROPOSED, db_index=True
    )
    raw_text = models.TextField(blank=True)
    confirmed_text = models.TextField(blank=True)
    confidence = models.FloatField(null=True, blank=True)
    doubts = models.JSONField(default=list, blank=True)
    is_stub = models.BooleanField(default=False, help_text="由测试/演示 stub 产生的转写，不是真实识别结果")
    decided_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="decided_transcriptions"
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "practice_answer_transcription"
        constraints = [
            models.UniqueConstraint(fields=["attempt", "asset_id"], name="uniq_transcription_per_asset"),
        ]
        indexes = [models.Index(fields=["attempt", "status"])]
        ordering = ["attempt", "created_at"]
        verbose_name = "手写转写"
        verbose_name_plural = "手写转写"

    def __str__(self) -> str:
        return f"transcription {self.status} asset={self.asset_id[:8]}"


class DiagnosisFollowUp(BaseModel):
    """One question the diagnosis asked the learner, and the answer if given.

    Follow-up answers are the process evidence a model cannot read from a photo;
    storing them as ``pending`` rows (instead of showing and dropping them) is what
    makes "证据不足就问" auditable.
    """

    attempt = models.ForeignKey(Attempt, on_delete=models.CASCADE, related_name="diagnosis_follow_ups")
    question = models.CharField(max_length=500)
    why = models.CharField(max_length=300, blank=True)
    evidence_kind = models.CharField(max_length=60, blank=True)
    status = models.CharField(
        max_length=16, choices=FollowUpStatus.choices, default=FollowUpStatus.PENDING, db_index=True
    )
    answer_text = models.TextField(blank=True)
    run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="diagnosis_follow_ups"
    )
    answered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "practice_diagnosis_follow_up"
        indexes = [models.Index(fields=["attempt", "status"])]
        ordering = ["attempt", "created_at"]
        verbose_name = "诊断追问"
        verbose_name_plural = "诊断追问"

    def __str__(self) -> str:
        return f"follow-up {self.status}"


class LearningEvidence(BaseModel):
    """Projection row: what one attempt proves, and what it does not.

    Every row keeps its exclusion reasons so the UI can explain why an attempt
    did not count towards a stricter dimension.
    """

    attempt = models.ForeignKey(Attempt, on_delete=models.CASCADE, related_name="evidence_rows")
    session_item = models.ForeignKey(SessionItem, on_delete=models.CASCADE, related_name="evidence_rows")
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="evidence_rows")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="evidence_rows")
    grade_event = models.ForeignKey(
        GradeEvent, null=True, blank=True, on_delete=models.SET_NULL, related_name="evidence_rows"
    )
    grade_revision = models.PositiveIntegerField(default=0)
    knowledge_node = models.ForeignKey(
        "knowledge.KnowledgeNode", null=True, blank=True, on_delete=models.CASCADE, related_name="evidence_rows"
    )
    dimension = models.CharField(max_length=32, choices=EvidenceDimension.choices, db_index=True)
    qualifies = models.BooleanField(default=False, db_index=True)
    is_correct = models.BooleanField(default=False)
    score_fraction = models.DecimalField(max_digits=6, decimal_places=4, null=True, blank=True)
    exclusion_reasons = models.JSONField(default=list, blank=True)
    rule_version = models.CharField(max_length=40, default="p0-1")
    computed_at = models.DateTimeField()
    is_active = models.BooleanField(default=True, db_index=True)
    invalidated_at = models.DateTimeField(null=True, blank=True)
    invalidated_reason = models.CharField(max_length=300, blank=True)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "practice_learning_evidence"
        constraints = [
            models.UniqueConstraint(
                fields=["attempt", "dimension", "knowledge_node", "grade_revision"],
                name="uniq_evidence_per_dimension_revision",
            ),
        ]
        indexes = [models.Index(fields=["user", "project", "dimension", "qualifies"])]
        verbose_name = "学习证据"
        verbose_name_plural = "学习证据"
