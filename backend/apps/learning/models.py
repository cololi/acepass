"""Learning domain: evidence-based state projection, daily plan and delayed tasks."""

from __future__ import annotations

from django.db import models

from apps.common.enums import (
    KnowledgeStateSummary,
    TaskKind,
    TaskStatus,
)
from apps.common.models import BaseModel


class LearnerKnowledgeState(BaseModel):
    """Per (user, project, syllabus, node) projection built from real evidence.

    This is a rule function over confirmed evidence, never an LLM output. The
    current summary can be downgraded by recent failures or a grading
    correction; the historical best is kept separately so a downgrade does not
    erase what was once demonstrated.
    """

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="knowledge_states")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="knowledge_states")
    syllabus_version = models.ForeignKey(
        "exams.SyllabusVersion", on_delete=models.CASCADE, related_name="knowledge_states"
    )
    node = models.ForeignKey("knowledge.KnowledgeNode", on_delete=models.CASCADE, related_name="states")
    summary = models.CharField(
        max_length=32, choices=KnowledgeStateSummary.choices, default=KnowledgeStateSummary.UNDIAGNOSED
    )
    best_summary = models.CharField(
        max_length=32, choices=KnowledgeStateSummary.choices, default=KnowledgeStateSummary.UNDIAGNOSED
    )
    independent_correct_count = models.PositiveIntegerField(default=0)
    distinct_question_count = models.PositiveIntegerField(default=0)
    distinct_template_count = models.PositiveIntegerField(default=0)
    has_delayed_correct = models.BooleanField(default=False)
    recent_independent_failures = models.PositiveIntegerField(default=0)
    recent_independent_attempts = models.PositiveIntegerField(default=0)
    needs_review = models.BooleanField(default=False, db_index=True)
    downgrade_reason = models.CharField(max_length=300, blank=True)
    projection_version = models.CharField(max_length=40, default="p0-1")
    rule_version = models.CharField(max_length=40, default="p0-1")
    as_of = models.DateTimeField()
    detail = models.JSONField(default=dict, blank=True)
    #: Evidence rows that produced this projection, for the "open the evidence" view.
    source_evidence_ids = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = "learning_knowledge_state"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "project", "syllabus_version", "node"], name="uniq_state_per_node"
            ),
        ]
        indexes = [models.Index(fields=["user", "project", "summary"])]
        verbose_name = "考点状态"
        verbose_name_plural = "考点状态"

    def __str__(self) -> str:
        return f"{self.node_id}:{self.summary}"


class StudyPlan(BaseModel):
    """One day's plan: the budget split and the frozen rotation snapshot."""

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="study_plans")
    plan_date = models.DateField(db_index=True)
    timezone = models.CharField(max_length=64, default="UTC")
    revision = models.PositiveIntegerField(default=1)
    daily_budget_minutes = models.PositiveIntegerField(default=0)
    allocated_minutes = models.PositiveIntegerField(default=0)
    #: How the global budget was split, per project.
    allocation = models.JSONField(default=list, blank=True)
    #: [project_id, ...] in base order, plus the daily rotation shift.
    project_order = models.JSONField(default=list, blank=True)
    rotation_offset = models.PositiveIntegerField(default=0)
    rule_version = models.CharField(max_length=40, default="p0-1")
    notes = models.JSONField(default=list, blank=True, help_text="未分配原因等可解释说明")
    generated_at = models.DateTimeField()

    class Meta:
        db_table = "learning_study_plan"
        constraints = [
            models.UniqueConstraint(fields=["user", "plan_date", "revision"], name="uniq_plan_revision"),
        ]
        indexes = [models.Index(fields=["user", "plan_date", "-revision"])]
        ordering = ["-plan_date", "-revision"]
        verbose_name = "学习计划"
        verbose_name_plural = "学习计划"

    def __str__(self) -> str:
        return f"plan {self.plan_date} r{self.revision}"


class StudyTask(BaseModel):
    """A scheduled unit of work tied to one project, subject and question."""

    plan = models.ForeignKey(StudyPlan, null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks")
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="study_tasks")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="study_tasks")
    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="study_tasks")
    task_kind = models.CharField(max_length=32, choices=TaskKind.choices, db_index=True)
    status = models.CharField(max_length=16, choices=TaskStatus.choices, default=TaskStatus.PENDING, db_index=True)
    question = models.ForeignKey(
        "question_bank.Question", null=True, blank=True, on_delete=models.SET_NULL, related_name="study_tasks"
    )
    knowledge_node = models.ForeignKey(
        "knowledge.KnowledgeNode", null=True, blank=True, on_delete=models.SET_NULL, related_name="study_tasks"
    )
    pairing = models.ForeignKey(
        "knowledge.VerificationPairing", null=True, blank=True, on_delete=models.SET_NULL, related_name="study_tasks"
    )
    pairing_version = models.PositiveIntegerField(null=True, blank=True)
    origin_session_item = models.ForeignKey(
        "practice.SessionItem", null=True, blank=True, on_delete=models.SET_NULL, related_name="derived_tasks"
    )
    #: The event that created this task (confirmed grade, explanation, ...).
    trigger_event = models.CharField(max_length=60, blank=True)
    delay_anchor_at = models.DateTimeField(null=True, blank=True)
    not_before = models.DateTimeField(null=True, blank=True, db_index=True)
    due_at = models.DateTimeField(null=True, blank=True)
    estimated_minutes = models.PositiveIntegerField(default=2)
    estimated_minutes_source = models.CharField(max_length=40, default="default_by_type")
    reason_codes = models.JSONField(default=list, blank=True)
    evidence_ids = models.JSONField(default=list, blank=True)
    rule_version = models.CharField(max_length=40, default="p0-1")
    invalidated_reason = models.CharField(max_length=300, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    deficit_notice = models.CharField(max_length=300, blank=True, help_text="例如：无合格配对题，降级为重复练习")

    class Meta:
        db_table = "learning_study_task"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "pairing", "origin_session_item", "task_kind"],
                name="uniq_paired_task_per_origin",
                condition=models.Q(origin_session_item__isnull=False),
            ),
        ]
        indexes = [
            models.Index(fields=["plan", "status"]),
            models.Index(fields=["user", "project", "status"]),
        ]
        ordering = ["created_at"]
        verbose_name = "学习任务"
        verbose_name_plural = "学习任务"

    def __str__(self) -> str:
        return f"{self.task_kind}:{self.status}"


class ReviewTask(BaseModel):
    """Delayed verification record: when a task becomes legitimately "delayed"."""

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="review_tasks")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="review_tasks")
    study_task = models.OneToOneField(StudyTask, on_delete=models.CASCADE, related_name="review_task")
    knowledge_node = models.ForeignKey(
        "knowledge.KnowledgeNode", null=True, blank=True, on_delete=models.SET_NULL, related_name="review_tasks"
    )
    delay_hours = models.PositiveSmallIntegerField(default=24)
    delay_anchor_at = models.DateTimeField()
    not_before = models.DateTimeField(db_index=True)
    anchor_source = models.CharField(max_length=60, blank=True)
    was_started = models.BooleanField(default=False)
    missing_question_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        db_table = "learning_review_task"
        ordering = ["not_before"]
        verbose_name = "延迟验证任务"
        verbose_name_plural = "延迟验证任务"

    def __str__(self) -> str:
        return f"review {self.not_before:%Y-%m-%d %H:%M}"
