"""Exams domain: projects, subjects, versioned exam specs, syllabus and papers."""

from __future__ import annotations

import uuid
from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from apps.common.enums import PaperRevisionStatus, QuestionType, ReviewStatus, SourceKind
from apps.common.models import BaseModel


class ExamProject(BaseModel):
    """One exam goal. A user may run several concurrently, fully isolated."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="projects")
    name = models.CharField(max_length=200)
    description = models.CharField(max_length=500, blank=True)
    target_date = models.DateField(null=True, blank=True)
    target_score = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    is_archived = models.BooleanField(default=False, db_index=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    display_order = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "exams_project"
        constraints = [
            models.UniqueConstraint(fields=["owner", "name"], name="uniq_project_name_per_owner"),
        ]
        ordering = ["display_order", "created_at"]
        verbose_name = "考试项目"
        verbose_name_plural = "考试项目"

    def __str__(self) -> str:
        return self.name


class Subject(BaseModel):
    project = models.ForeignKey(ExamProject, on_delete=models.CASCADE, related_name="subjects")
    name = models.CharField(max_length=200)
    code = models.CharField(max_length=40, blank=True)
    display_order = models.PositiveIntegerField(default=0)
    #: Declared full/pass marks for the subject, when the user knows them.
    total_score = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    pass_score = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)

    class Meta:
        db_table = "exams_subject"
        constraints = [
            models.UniqueConstraint(fields=["project", "name"], name="uniq_subject_name_per_project"),
        ]
        ordering = ["display_order", "created_at"]
        verbose_name = "科目"
        verbose_name_plural = "科目"

    def __str__(self) -> str:
        return f"{self.project.name}/{self.name}"


class ExamSpecVersion(BaseModel):
    """Versioned scoring rules for one subject.

    Published versions are immutable: changing a rule means publishing a new
    version, and every session item stores which version graded it.
    """

    subject = models.ForeignKey(Subject, on_delete=models.CASCADE, related_name="exam_spec_versions")
    version = models.PositiveIntegerField(default=1)
    name = models.CharField(max_length=200, blank=True)
    total_score = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    pass_score = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    #: {"single_choice": {"default_max_score": "2.00", "wrong_score": "0.00",
    #:   "blank_score": "0.00"}, "multiple_choice": {"policy": "partial_credit",
    #:   "partial_score": "2.00", ...}, "fill_blank": {...}, ...}
    question_type_rules = models.JSONField(default=dict)
    #: Timing policy for verification/limit checks; P0 stores but does not
    #: enforce a mock-exam deadline (that is P2).
    time_rules = models.JSONField(default=dict, blank=True)
    #: Whether the whole paper score is floored at zero. Versioned, never implicit.
    score_floor_at_zero = models.BooleanField(default=False)
    #: Free-form notes so a user can record where a rule came from.
    rule_source_note = models.CharField(max_length=500, blank=True)
    is_demo = models.BooleanField(default=False, help_text="演示规则，不代表任何真实考试的官方规则")
    status = models.CharField(max_length=16, default="draft", db_index=True)
    published_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="exam_specs"
    )

    class Meta:
        db_table = "exams_spec_version"
        constraints = [
            models.UniqueConstraint(fields=["subject", "version"], name="uniq_spec_version_per_subject"),
        ]
        ordering = ["-version"]
        verbose_name = "考试规范版本"
        verbose_name_plural = "考试规范版本"

    def __str__(self) -> str:
        return f"{self.subject} spec v{self.version}"

    @property
    def is_published(self) -> bool:
        return self.status == "published"

    def rule_for(self, question_type: str) -> dict:
        rules = self.question_type_rules or {}
        rule = rules.get(question_type)
        return dict(rule) if isinstance(rule, dict) else {}

    def default_max_score(self, question_type: str) -> Decimal | None:
        raw = self.rule_for(question_type).get("default_max_score")
        if raw in (None, ""):
            return None
        return Decimal(str(raw))

    def clean(self) -> None:
        if self.status == "published" and not self.question_type_rules:
            raise ValidationError({"question_type_rules": "发布规范前必须至少配置一种题型的计分规则"})
        for qtype in (self.question_type_rules or {}):
            if qtype not in QuestionType.values:
                raise ValidationError({"question_type_rules": f"未知题型：{qtype}"})


class SyllabusVersion(BaseModel):
    subject = models.ForeignKey(Subject, on_delete=models.CASCADE, related_name="syllabus_versions")
    name = models.CharField(max_length=200)
    version_label = models.CharField(max_length=80, blank=True)
    applies_from = models.DateField(null=True, blank=True)
    applies_to = models.DateField(null=True, blank=True)
    #: Present when the syllabus came from a stored document.
    source_document = models.ForeignKey(
        "ingestion.SourceDocument", null=True, blank=True, on_delete=models.SET_NULL, related_name="syllabi"
    )
    #: Marks a user-authored provisional outline so it is never presented as an
    #: official coverage baseline.
    is_user_provisional = models.BooleanField(default=True)
    review_status = models.CharField(max_length=16, choices=ReviewStatus.choices, default=ReviewStatus.DRAFT)
    status = models.CharField(max_length=16, default="draft", db_index=True)
    published_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="syllabi"
    )

    class Meta:
        db_table = "exams_syllabus_version"
        constraints = [
            models.UniqueConstraint(fields=["subject", "name", "version_label"], name="uniq_syllabus_label"),
        ]
        ordering = ["-created_at"]
        verbose_name = "大纲版本"
        verbose_name_plural = "大纲版本"

    def __str__(self) -> str:
        return f"{self.subject}/{self.name}{(' ' + self.version_label) if self.version_label else ''}"

    @property
    def is_published(self) -> bool:
        return self.status == "published"


class Paper(BaseModel):
    """A real exam paper occurrence (or a demo/practice set), by stable identity.

    The natural key is (subject, cycle_key, session_key, paper_code). Re-uploading
    the same paper must not create a second occurrence.
    """

    subject = models.ForeignKey(Subject, on_delete=models.CASCADE, related_name="papers")
    cycle_key = models.CharField(max_length=40, help_text="例如 2024 或 2024春")
    session_key = models.CharField(max_length=60, blank=True, help_text="例如 上半年 / 第1场")
    paper_code = models.CharField(max_length=60, help_text="卷别代码，例如 卷一 / A卷")
    title = models.CharField(max_length=300, blank=True)
    source_kind = models.CharField(max_length=20, choices=SourceKind.choices, default=SourceKind.DEMO)
    is_demo = models.BooleanField(default=True, help_text="演示数据不计入真实历年统计")
    effective_revision = models.ForeignKey(
        "exams.PaperRevision",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="effective_for_papers",
    )
    notes = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "exams_paper"
        constraints = [
            models.UniqueConstraint(
                fields=["subject", "cycle_key", "session_key", "paper_code"], name="uniq_paper_natural_key"
            ),
        ]
        verbose_name = "试卷（真实发生记录）"
        verbose_name_plural = "试卷（真实发生记录）"

    def __str__(self) -> str:
        return f"{self.subject}/{self.cycle_key}{self.session_key}{self.paper_code}"

    def clean(self) -> None:
        if self.effective_revision_id and self.effective_revision.paper_id != self.id:
            raise ValidationError({"effective_revision": "有效版本必须属于该试卷"})


class PaperRevision(BaseModel):
    paper = models.ForeignKey(Paper, on_delete=models.CASCADE, related_name="revisions")
    revision = models.PositiveIntegerField(default=1)
    spec_version = models.ForeignKey(
        ExamSpecVersion, null=True, blank=True, on_delete=models.PROTECT, related_name="paper_revisions"
    )
    #: Manual completeness confirmation: a single uploaded paper never proves a
    #: full cycle, so this is recorded explicitly.
    expected_session_count = models.PositiveSmallIntegerField(null=True, blank=True)
    covered_session_count = models.PositiveSmallIntegerField(null=True, blank=True)
    coverage_confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="coverage_confirmations"
    )
    coverage_confirmed_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=16, choices=PaperRevisionStatus.choices, default=PaperRevisionStatus.DRAFT, db_index=True
    )
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "exams_paper_revision"
        constraints = [
            models.UniqueConstraint(fields=["paper", "revision"], name="uniq_paper_revision"),
        ]
        ordering = ["paper", "-revision"]
        verbose_name = "试卷版本"
        verbose_name_plural = "试卷版本"

    def __str__(self) -> str:
        return f"{self.paper} r{self.revision}"

    @property
    def coverage_status(self) -> str:
        """Complete only when a human confirmed the counts, not merely typed them.

        Typing "expected 2 / covered 2" describes an intention; the confirmation
        is what states that the cycle really is covered. Cycle statistics count
        nothing but confirmed completeness, so a half-registered cycle cannot
        silently become an official distribution.
        """
        if self.expected_session_count is None or self.covered_session_count is None:
            return "coverage_unknown"
        if self.coverage_confirmed_at is None:
            return "coverage_incomplete"
        if self.covered_session_count >= self.expected_session_count:
            return "coverage_complete"
        return "coverage_incomplete"


class PaperItem(BaseModel):
    """A scored leaf question as it occurred in one paper revision."""

    revision = models.ForeignKey(PaperRevision, on_delete=models.CASCADE, related_name="items")
    position_key = models.CharField(max_length=40, help_text="卷面题号，例如 12 或 三.2")
    parent_item = models.ForeignKey(
        "exams.PaperItem", null=True, blank=True, on_delete=models.CASCADE, related_name="children"
    )
    question_version = models.ForeignKey(
        "question_bank.QuestionVersion", on_delete=models.PROTECT, related_name="paper_items"
    )
    answer_key_version = models.ForeignKey(
        "question_bank.AnswerKeyVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="paper_items"
    )
    max_score = models.DecimalField(max_digits=10, decimal_places=2)
    is_scored = models.BooleanField(default=True, help_text="父材料题不计分，仅叶子题计分")
    is_demo = models.BooleanField(default=False)

    class Meta:
        db_table = "exams_paper_item"
        constraints = [
            models.UniqueConstraint(fields=["revision", "position_key"], name="uniq_paper_item_position"),
        ]
        ordering = ["revision", "position_key"]
        verbose_name = "试卷题项"
        verbose_name_plural = "试卷题项"

    def __str__(self) -> str:
        return f"{self.revision}#{self.position_key}"

    def clean(self) -> None:
        errors: dict[str, str] = {}
        if self.parent_item_id:
            if self.parent_item.revision_id != self.revision_id:
                errors["parent_item"] = "父题项必须属于同一试卷版本"
            if self.parent_item_id == self.id:
                errors["parent_item"] = "题项不能以自身为父"
        if self.question_version_id and self.revision_id:
            qv = self.question_version
            if qv.question.subject_id != self.revision.paper.subject_id:
                errors["question_version"] = "题目科目与试卷科目不一致"
            if qv.question.origin_type == "ai_generated" and self.revision.paper.source_kind == SourceKind.OFFICIAL_PAST:
                errors["question_version"] = "AI 生成题不得挂到真实考试发生记录"
            if self.max_score < 0:
                errors["max_score"] = "分值不能为负"
        if errors:
            raise ValidationError(errors)


def new_paper_identity(subject: Subject) -> dict:
    """Placeholder helper used by tests/fixtures to build a unique key."""
    return {"subject": subject, "cycle_key": f"demo-{uuid.uuid4().hex[:8]}", "paper_code": "demo"}
