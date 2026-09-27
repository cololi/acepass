"""Question bank: identity, versions, answer keys, rubrics, lineage and pool policy."""

from __future__ import annotations

from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import models

from apps.common.enums import (
    SCORABLE_LEAF_TYPES,
    AnswerSourceType,
    ContentLineageBasis,
    MismatchPolicy,
    MultipleChoicePolicy,
    OriginType,
    QuestionType,
    QuestionVersionStatus,
    VerificationStatus,
)
from apps.common.models import BaseModel


class ContentLineage(BaseModel):
    """Known same-content relationship across one owner's projects.

    Used to keep "never seen in this system" honest: exposure follows the
    lineage, while learning state stays per project. Lineage is scoped to one
    owner, never derived from a global content hash.
    """

    owner = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="content_lineages")
    basis = models.CharField(max_length=24, choices=ContentLineageBasis.choices)
    is_confirmed = models.BooleanField(default=False)
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "question_bank_content_lineage"
        verbose_name = "内容谱系"
        verbose_name_plural = "内容谱系"


class QuestionFamily(BaseModel):
    """Near-duplicate family (same template, changed numbers, reworded)."""

    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="question_families")
    name = models.CharField(max_length=200)
    relation_confirmed = models.BooleanField(default=False)
    revision = models.PositiveIntegerField(default=1)
    note = models.CharField(max_length=500, blank=True)
    #: Merge audit (P2/C03). Both fields are written on the *source* family when
    #: its questions are absorbed: ``merged_into`` names the surviving family and
    #: ``merged_at`` says when. A family that has at least one ``merged_from`` row
    #: is a *merged* family: its members stop being distinct "variants" of each
    #: other, which is what :mod:`apps.learning.services.contamination` reads.
    merged_into = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="merged_from"
    )
    merged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "question_bank_family"
        constraints = [
            models.UniqueConstraint(fields=["subject", "name"], name="uniq_family_name_per_subject"),
        ]
        ordering = ["subject", "name"]
        verbose_name = "题目家族"
        verbose_name_plural = "题目家族"

    def __str__(self) -> str:
        return self.name


class Question(BaseModel):
    """Stable question identity. Content lives in versions."""

    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="questions")
    origin_type = models.CharField(max_length=24, choices=OriginType.choices, default=OriginType.DEMO)
    current_published_version = models.ForeignKey(
        "question_bank.QuestionVersion",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="published_for_questions",
    )
    family = models.ForeignKey(
        QuestionFamily, null=True, blank=True, on_delete=models.SET_NULL, related_name="questions"
    )
    content_lineage = models.ForeignKey(
        ContentLineage, null=True, blank=True, on_delete=models.SET_NULL, related_name="questions"
    )
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="created_questions"
    )
    is_demo = models.BooleanField(default=True, help_text="演示题不计入真实历年统计")
    display_label = models.CharField(max_length=200, blank=True, help_text="题号/标签，仅用于列表展示")

    class Meta:
        db_table = "question_bank_question"
        indexes = [models.Index(fields=["subject", "origin_type"])]
        ordering = ["-created_at"]
        verbose_name = "题目"
        verbose_name_plural = "题目"

    def __str__(self) -> str:
        return self.display_label or f"question#{self.id}"


class QuestionVersion(BaseModel):
    """One immutable published (or draft) revision of a question's content."""

    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="versions")
    version = models.PositiveIntegerField(default=1)
    question_type = models.CharField(max_length=32, choices=QuestionType.choices)
    content = models.JSONField(default=dict)
    #: Material parent: the shared material version whose children these are.
    parent_material_version = models.ForeignKey(
        "question_bank.QuestionVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="child_versions"
    )
    #: Material only: ordered child version ids for validation and presentation.
    material_child_version_ids = models.JSONField(default=list, blank=True)
    practice_max_score = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True, help_text="独立练习分值"
    )
    estimated_seconds = models.PositiveIntegerField(null=True, blank=True)
    status = models.CharField(
        max_length=16, choices=QuestionVersionStatus.choices, default=QuestionVersionStatus.DRAFT, db_index=True
    )
    revision_reason = models.CharField(max_length=500, blank=True)
    source_note = models.CharField(max_length=500, blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="created_versions"
    )
    published_at = models.DateTimeField(null=True, blank=True)
    withdrawn_at = models.DateTimeField(null=True, blank=True)
    withdrawn_reason = models.CharField(max_length=500, blank=True)
    #: Content digest at publish time, so later tampering is detectable.
    content_digest = models.CharField(max_length=64, blank=True)

    class Meta:
        db_table = "question_bank_question_version"
        constraints = [
            models.UniqueConstraint(fields=["question", "version"], name="uniq_question_version"),
        ]
        ordering = ["question", "-version"]
        verbose_name = "题目版本"
        verbose_name_plural = "题目版本"

    def __str__(self) -> str:
        return f"{self.question_id} v{self.version}"

    @property
    def is_published(self) -> bool:
        return self.status == QuestionVersionStatus.PUBLISHED

    @property
    def is_scorable_leaf(self) -> bool:
        return self.question_type in SCORABLE_LEAF_TYPES

    def clean(self) -> None:
        errors: dict[str, str] = {}
        if self.question_id and self.question.subject_id:
            if self.parent_material_version_id:
                parent = self.parent_material_version
                if parent.question_type != QuestionType.MATERIAL:
                    errors["parent_material_version"] = "父版本必须是共享材料题"
                if parent.question.subject_id != self.question.subject_id:
                    errors["parent_material_version"] = "父子题必须属于同一科目"
                if parent.id == self.id:
                    errors["parent_material_version"] = "题目不能以自身为父"
                if parent.question_id == self.question_id:
                    errors["parent_material_version"] = "父题不能是同一题目身份"
        if self.question_type == QuestionType.MATERIAL and self.practice_max_score:
            errors["practice_max_score"] = "共享材料父题不计分"
        if errors:
            raise ValidationError(errors)


class QuestionSourceLink(BaseModel):
    """Which source region(s) a version's stem/answer/material came from."""

    question_version = models.ForeignKey(QuestionVersion, on_delete=models.CASCADE, related_name="source_links")
    region = models.ForeignKey("ingestion.SourceRegion", on_delete=models.PROTECT, related_name="question_links")
    #: stem / option / material / answer / rubric / explanation
    role = models.CharField(max_length=24, default="stem")
    note = models.CharField(max_length=300, blank=True)

    class Meta:
        db_table = "question_bank_source_link"
        constraints = [
            models.UniqueConstraint(fields=["question_version", "region", "role"], name="uniq_version_region_role"),
        ]
        verbose_name = "题目来源关联"
        verbose_name_plural = "题目来源关联"


class AnswerKeyVersion(BaseModel):
    """Answer for one question version. Never edited in place once checked."""

    question_version = models.ForeignKey(QuestionVersion, on_delete=models.CASCADE, related_name="answer_keys")
    version = models.PositiveIntegerField(default=1)
    #: Type-specific graded payload; see apps/common/answers.py.
    answer_payload = models.JSONField(default=dict)
    source_type = models.CharField(max_length=24, choices=AnswerSourceType.choices, default=AnswerSourceType.USER)
    verification_status = models.CharField(
        max_length=16, choices=VerificationStatus.choices, default=VerificationStatus.PENDING, db_index=True
    )
    checked_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="checked_answers"
    )
    checked_at = models.DateTimeField(null=True, blank=True)
    check_basis = models.CharField(max_length=500, blank=True, help_text="核对依据：与哪个题号/版本的哪个来源一致")
    source_region = models.ForeignKey(
        "ingestion.SourceRegion", null=True, blank=True, on_delete=models.SET_NULL, related_name="answer_keys"
    )
    explanation_blocks = models.JSONField(default=list, blank=True, help_text="已审核的人工解析（结构化块）")
    is_disputed = models.BooleanField(default=False)
    dispute_reason = models.CharField(max_length=500, blank=True)
    supersedes = models.ForeignKey(
        "question_bank.AnswerKeyVersion", null=True, blank=True, on_delete=models.SET_NULL, related_name="superseded_by"
    )
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="created_answers"
    )

    class Meta:
        db_table = "question_bank_answer_key_version"
        constraints = [
            models.UniqueConstraint(fields=["question_version", "version"], name="uniq_answer_version"),
        ]
        ordering = ["question_version", "-version"]
        verbose_name = "答案版本"
        verbose_name_plural = "答案版本"

    def __str__(self) -> str:
        return f"answer v{self.version} ({self.verification_status})"

    @property
    def is_trusted(self) -> bool:
        return self.verification_status == VerificationStatus.CHECKED

    @property
    def is_usable(self) -> bool:
        """Only trusted, undisputed answers may grade or be published."""
        return self.is_trusted and not self.is_disputed


class RubricVersion(BaseModel):
    """Grading criteria for a constructed response (0..1 rubric per answer)."""

    answer_key_version = models.OneToOneField(
        AnswerKeyVersion, on_delete=models.CASCADE, related_name="rubric"
    )
    version = models.PositiveIntegerField(default=1)
    #: [{"criterion_id": "c1", "text": "...", "max_score": "3.00",
    #:   "required": true, "depends_on": ["c2"], "scale": "0.5"}]
    criteria = models.JSONField(default=list)
    total_score = models.DecimalField(max_digits=10, decimal_places=2)
    usage_note = models.CharField(max_length=500, blank=True)
    checked_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="checked_rubrics"
    )
    checked_at = models.DateTimeField(null=True, blank=True)
    is_disputed = models.BooleanField(default=False)

    class Meta:
        db_table = "question_bank_rubric_version"
        verbose_name = "评分标准版本"
        verbose_name_plural = "评分标准版本"

    def __str__(self) -> str:
        return f"rubric v{self.version} total={self.total_score}"

    def clean(self) -> None:
        errors: dict[str, str] = {}
        seen: set[str] = set()
        total = Decimal("0")
        criterion_ids = {
            str(c.get("criterion_id")) for c in self.criteria or [] if isinstance(c, dict) and c.get("criterion_id")
        }
        for index, criterion in enumerate(self.criteria or []):
            if not isinstance(criterion, dict):
                errors[f"criteria[{index}]"] = "评分点必须是对象"
                continue
            criterion_id = str(criterion.get("criterion_id") or "")
            if not criterion_id:
                errors[f"criteria[{index}]"] = "评分点缺少 criterion_id"
                continue
            if criterion_id in seen:
                errors[f"criteria[{index}]"] = f"评分点 ID 重复：{criterion_id}"
                continue
            seen.add(criterion_id)
            try:
                score = Decimal(str(criterion.get("max_score")))
            except Exception:
                errors[f"criteria[{index}]"] = "评分点分值必须是十进制数"
                continue
            if score < 0:
                errors[f"criteria[{index}]"] = "评分点分值不能为负"
                continue
            total += score
            for dependency in criterion.get("depends_on") or []:
                if str(dependency) not in criterion_ids:
                    errors[f"criteria[{index}]"] = f"评分点依赖不存在：{dependency}"
        if not self.criteria:
            errors["criteria"] = "大题 rubric 必须至少包含一个评分点"
        if self.criteria and total != self.total_score:
            errors["total_score"] = f"评分点合计 {total} 与 rubric 总分 {self.total_score} 不一致"
        if errors:
            raise ValidationError(errors)


class QuestionPoolPolicy(BaseModel):
    """Training/holdout intent. P0 records it; P2 enforces sealed holdout."""

    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="pool_policies")
    family = models.ForeignKey(
        QuestionFamily, null=True, blank=True, on_delete=models.CASCADE, related_name="pool_policies"
    )
    question = models.ForeignKey(
        Question, null=True, blank=True, on_delete=models.CASCADE, related_name="pool_policies"
    )
    revision = models.PositiveIntegerField(default=1)
    #: P2/C03: the latest revision per target decides sealing; see
    #: :mod:`apps.question_bank.services.sealing`, which is the only reader of
    #: this column. Older revisions are history and never decide anything.
    is_holdout = models.BooleanField(default=False, help_text="保留待验证（最新修订参与封存判定，见 services/sealing.py）")
    change_reason = models.CharField(max_length=500, blank=True)
    changed_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="pool_policy_changes"
    )

    class Meta:
        db_table = "question_bank_pool_policy"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(family__isnull=False) | models.Q(question__isnull=False),
                name="pool_policy_target_required",
            ),
        ]
        verbose_name = "用途策略"
        verbose_name_plural = "用途策略"


def default_mismatch_policy() -> str:
    """Fill-in answers go to human review unless an exam rule says otherwise."""
    return MismatchPolicy.REVIEW


def default_multiple_choice_policy() -> str:
    return MultipleChoicePolicy.EXACT_MATCH
