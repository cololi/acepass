"""Knowledge domain: syllabus nodes, templates and per-version mappings."""

from __future__ import annotations

from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import models

from apps.common.enums import KnowledgeNodeKind, KnowledgeRelationType, SuggestionStatus
from apps.common.models import BaseModel


class KnowledgeNode(BaseModel):
    """A chapter or knowledge point inside one syllabus version."""

    syllabus_version = models.ForeignKey(
        "exams.SyllabusVersion", on_delete=models.CASCADE, related_name="knowledge_nodes"
    )
    parent = models.ForeignKey(
        "knowledge.KnowledgeNode", null=True, blank=True, on_delete=models.CASCADE, related_name="children"
    )
    kind = models.CharField(max_length=16, choices=KnowledgeNodeKind.choices, default=KnowledgeNodeKind.POINT)
    canonical_name = models.CharField(max_length=200)
    aliases = models.JSONField(default=list, blank=True)
    code = models.CharField(max_length=40, blank=True)
    #: Node that absorbs unmapped score weight so no marks silently disappear.
    is_unclassified = models.BooleanField(default=False)
    display_order = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "knowledge_node"
        constraints = [
            models.UniqueConstraint(
                fields=["syllabus_version", "parent", "canonical_name"], name="uniq_node_name_in_parent"
            ),
        ]
        ordering = ["syllabus_version", "display_order", "canonical_name"]
        verbose_name = "考点"
        verbose_name_plural = "考点"

    def __str__(self) -> str:
        return self.canonical_name

    def clean(self) -> None:
        errors: dict[str, str] = {}
        if self.parent_id:
            if self.parent.syllabus_version_id != self.syllabus_version_id:
                errors["parent"] = "父子考点必须属于同一大纲版本"
            if self.parent_id == self.id:
                errors["parent"] = "考点不能以自身为父"
        if self.is_unclassified and self.parent_id is None:
            # allowed: an explicit root "unclassified" bucket
            pass
        if errors:
            raise ValidationError(errors)

    def ancestors(self) -> list[KnowledgeNode]:
        chain: list[KnowledgeNode] = []
        node = self.parent
        seen = {self.id}
        while node is not None and node.id not in seen:
            chain.append(node)
            seen.add(node.id)
            node = node.parent
        return chain


class QuestionTemplate(BaseModel):
    """A manually confirmed "way of asking" used for evidence diversity."""

    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="templates")
    name = models.CharField(max_length=200)
    description = models.CharField(max_length=500, blank=True)
    review_status = models.CharField(max_length=16, default="draft")
    confirmed_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="confirmed_templates"
    )

    class Meta:
        db_table = "knowledge_question_template"
        constraints = [
            models.UniqueConstraint(fields=["subject", "name"], name="uniq_template_name_per_subject"),
        ]
        ordering = ["subject", "name"]
        verbose_name = "题目模板"
        verbose_name_plural = "题目模板"

    def __str__(self) -> str:
        return self.name


class QuestionKnowledge(BaseModel):
    """Mapping revision: which knowledge points one question version covers.

    A mapping batch never mutates an earlier batch, so historical evidence keeps
    pointing at the mapping that produced it. For one scoring unit the primary
    weights must sum to exactly 1; auxiliary tags carry weight 0 and cannot add
    score a second time.
    """

    question_version = models.ForeignKey(
        "question_bank.QuestionVersion", on_delete=models.CASCADE, related_name="knowledge_mappings"
    )
    mapping_revision = models.PositiveIntegerField(default=1)
    node = models.ForeignKey(KnowledgeNode, on_delete=models.PROTECT, related_name="question_mappings")
    is_primary = models.BooleanField(default=True)
    score_weight = models.DecimalField(max_digits=6, decimal_places=4, default=Decimal("1.0000"))
    template = models.ForeignKey(
        QuestionTemplate, null=True, blank=True, on_delete=models.SET_NULL, related_name="mappings"
    )
    note = models.CharField(max_length=300, blank=True)

    class Meta:
        db_table = "knowledge_question_mapping"
        constraints = [
            models.UniqueConstraint(
                fields=["question_version", "mapping_revision", "node"],
                name="uniq_mapping_node_per_revision",
            ),
            models.CheckConstraint(
                condition=models.Q(score_weight__gte=0) & models.Q(score_weight__lte=1),
                name="mapping_weight_between_0_and_1",
            ),
        ]
        ordering = ["question_version", "mapping_revision", "node"]
        verbose_name = "考点映射"
        verbose_name_plural = "考点映射"

    def clean(self) -> None:
        if not self.is_primary and self.score_weight != 0:
            raise ValidationError({"score_weight": "辅助标签权重必须为 0，不能重复得分"})


class VerificationPairing(BaseModel):
    """Human-reviewed A/B/C pairing used for independent verification.

    A = baseline question, B = immediate check on the same knowledge point,
    C = delayed check (>= delay_hours later). All three must live in the same
    project and subject, and B/C must be different stable questions from A.
    """

    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="verification_pairings")
    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="verification_pairings")
    node = models.ForeignKey(KnowledgeNode, on_delete=models.PROTECT, related_name="verification_pairings")
    baseline_question = models.ForeignKey(
        "question_bank.Question", null=True, blank=True, on_delete=models.PROTECT, related_name="pairings_as_baseline"
    )
    immediate_question = models.ForeignKey(
        "question_bank.Question", on_delete=models.PROTECT, related_name="pairings_as_immediate"
    )
    delayed_question = models.ForeignKey(
        "question_bank.Question",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="pairings_as_delayed",
    )
    pairing_version = models.PositiveIntegerField(default=1)
    delay_hours = models.PositiveSmallIntegerField(default=24)
    is_active = models.BooleanField(default=True, db_index=True)
    reviewer = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="reviewed_pairings"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "knowledge_verification_pairing"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "subject", "node", "pairing_version"], name="uniq_pairing_version"
            ),
        ]
        ordering = ["project", "subject", "node", "-pairing_version"]
        verbose_name = "配对验证"
        verbose_name_plural = "配对验证"

    def __str__(self) -> str:
        return f"pairing {self.node_id} v{self.pairing_version}"

    def clean(self) -> None:
        errors: dict[str, str] = {}
        subject_id = self.subject_id
        for field in ("baseline_question", "immediate_question", "delayed_question"):
            question = getattr(self, field, None)
            if question is None:
                continue
            if question.subject_id != subject_id:
                errors[field] = "配对题目必须属于同一科目"
        ids = [
            getattr(self, field).id
            for field in ("baseline_question", "immediate_question", "delayed_question")
            if getattr(self, field, None) is not None
        ]
        if len(ids) != len(set(ids)):
            errors["immediate_question"] = "B/C 题必须是不同于基准题的其他稳定题目"
        if self.node_id and self.node.syllabus_version.subject_id != subject_id:
            errors["node"] = "考点必须属于该科目的大纲版本"
        if errors:
            raise ValidationError(errors)


class KnowledgeRelation(BaseModel):
    """Directed edge between two knowledge points of one syllabus version.

    ``from_node`` is the prerequisite and ``to_node`` depends on it, so the
    planner can schedule the foundation before the weak point that needs it.
    The edge is soft-deactivated (``is_active=False``) instead of deleted, so a
    historical recommendation can still be explained afterwards.
    """

    syllabus_version = models.ForeignKey(
        "exams.SyllabusVersion", on_delete=models.CASCADE, related_name="knowledge_relations"
    )
    from_node = models.ForeignKey(KnowledgeNode, on_delete=models.CASCADE, related_name="outgoing_relations")
    to_node = models.ForeignKey(KnowledgeNode, on_delete=models.CASCADE, related_name="incoming_relations")
    relation_type = models.CharField(
        max_length=24, choices=KnowledgeRelationType.choices, default=KnowledgeRelationType.PREREQUISITE
    )
    is_active = models.BooleanField(default=True, db_index=True)
    note = models.CharField(max_length=300, blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="created_knowledge_relations"
    )

    class Meta:
        db_table = "knowledge_relation"
        constraints = [
            models.UniqueConstraint(
                fields=["from_node", "to_node", "relation_type"], name="uniq_knowledge_relation_edge"
            ),
            models.CheckConstraint(
                condition=~models.Q(from_node=models.F("to_node")), name="knowledge_relation_no_self_loop"
            ),
        ]
        indexes = [models.Index(fields=["syllabus_version", "relation_type", "is_active"])]
        ordering = ["syllabus_version", "relation_type", "created_at"]
        verbose_name = "考点关系"
        verbose_name_plural = "考点关系"

    def __str__(self) -> str:
        return f"{self.from_node_id}->{self.to_node_id} ({self.relation_type})"

    def clean(self) -> None:
        errors: dict[str, str] = {}
        if self.from_node_id and self.to_node_id and self.from_node_id == self.to_node_id:
            errors["to_node"] = "考点不能以自身为前置或相关关系"
        for field in ("from_node", "to_node"):
            node = getattr(self, field, None)
            if node is not None and self.syllabus_version_id and node.syllabus_version_id != self.syllabus_version_id:
                errors[field] = "关系两端的考点必须属于同一大纲版本"
        if errors:
            raise ValidationError(errors)


class TagSuggestion(BaseModel):
    """A machine-proposed set of knowledge tags for one question version.

    The proposal is inert data: accepting it writes a **new mapping revision**
    through the ordinary mapping service, and it can never create or rename a
    knowledge node, nor invent a template. Names that do not resolve to an
    existing node inside the syllabus stay listed in ``unresolved_names`` and
    need a human decision.
    """

    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="tag_suggestions")
    question_version = models.ForeignKey(
        "question_bank.QuestionVersion", on_delete=models.CASCADE, related_name="tag_suggestions"
    )
    run = models.ForeignKey(
        "audit.LLMRun", null=True, blank=True, on_delete=models.SET_NULL, related_name="tag_suggestions"
    )
    status = models.CharField(
        max_length=16, choices=SuggestionStatus.choices, default=SuggestionStatus.PROPOSED, db_index=True
    )
    #: ``[{"name": "...", "confidence": 0.8, "rationale": "..."}]`` as proposed.
    proposals = models.JSONField(default=list, blank=True)
    model_identifier = models.CharField(max_length=120, blank=True)
    prompt_version = models.CharField(max_length=40, blank=True)
    is_stub = models.BooleanField(default=False, help_text="由测试/演示 stub 产生，不代表真实模型结果")
    #: Mapping revision written when a human accepted the proposal.
    accepted_mapping_revision = models.PositiveIntegerField(null=True, blank=True)
    unresolved_names = models.JSONField(default=list, blank=True)
    decided_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="decided_tag_suggestions"
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    decision_note = models.CharField(max_length=500, blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="created_tag_suggestions"
    )

    class Meta:
        db_table = "knowledge_tag_suggestion"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["proposed", "accepted", "rejected", "superseded"]),
                name="tag_suggestion_status_known",
            ),
        ]
        indexes = [models.Index(fields=["project", "status", "-created_at"])]
        ordering = ["-created_at"]
        verbose_name = "标签建议"
        verbose_name_plural = "标签建议"

    def __str__(self) -> str:
        return f"tag-suggestion {self.question_version_id} ({self.status})"
