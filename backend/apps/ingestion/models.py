"""Ingestion domain: private material, source regions, import jobs and candidates."""

from __future__ import annotations

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.common.enums import (
    AssetRole,
    AssetSensitivity,
    ImportCandidateStatus,
    ImportJobStatus,
)
from apps.common.models import BaseModel


class Asset(BaseModel):
    """One private stored object.

    `sensitivity` is the gate that decides who may read the bytes and when: a
    page that contains answers must not be reachable through the same rule as a
    stem crop.
    """

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="assets")
    project = models.ForeignKey(
        "exams.ExamProject", on_delete=models.CASCADE, related_name="assets", db_index=True
    )
    subject = models.ForeignKey(
        "exams.Subject", null=True, blank=True, on_delete=models.SET_NULL, related_name="assets"
    )
    role = models.CharField(max_length=24, choices=AssetRole.choices, default=AssetRole.OTHER)
    sensitivity = models.CharField(
        max_length=24, choices=AssetSensitivity.choices, default=AssetSensitivity.PUBLIC_TO_OWNER
    )
    object_key = models.CharField(max_length=300, unique=True)
    original_filename = models.CharField(max_length=255, blank=True)
    content_type = models.CharField(max_length=80)
    size_bytes = models.PositiveIntegerField()
    checksum = models.CharField(max_length=64, db_index=True)
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    #: Set when this asset is a crop of a source document page.
    source_document = models.ForeignKey(
        "ingestion.SourceDocument", null=True, blank=True, on_delete=models.SET_NULL, related_name="derived_assets"
    )
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="uploaded_assets"
    )
    #: Blocks hard deletion while content still references the bytes.
    is_retained = models.BooleanField(default=True)

    class Meta:
        db_table = "ingestion_asset"
        indexes = [models.Index(fields=["project", "role"])]
        verbose_name = "私有文件"
        verbose_name_plural = "私有文件"

    def __str__(self) -> str:
        return f"{self.role}:{self.object_key}"


class SourceDocument(BaseModel):
    """Original material: an uploaded image, or pasted text with its raw body.

    Pasted text always creates a document, so the original wording stays
    traceable and the parsed structure never becomes the only record.
    """

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="source_documents")
    project = models.ForeignKey(
        "exams.ExamProject", on_delete=models.CASCADE, related_name="source_documents", db_index=True
    )
    subject = models.ForeignKey(
        "exams.Subject", null=True, blank=True, on_delete=models.SET_NULL, related_name="source_documents"
    )
    title = models.CharField(max_length=300, blank=True)
    #: `image`, `text`, `pdf` or `pdf_answer`; PDF is the P1 native-text import.
    document_type = models.CharField(max_length=16, default="image")
    role = models.CharField(max_length=24, choices=AssetRole.choices, default=AssetRole.PAST_PAPER_PAGE)
    sensitivity = models.CharField(
        max_length=24, choices=AssetSensitivity.choices, default=AssetSensitivity.PUBLIC_TO_OWNER
    )
    asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.PROTECT, related_name="documents")
    #: Full original text for pasted input; never replaced by parsed output.
    raw_text = models.TextField(blank=True)
    #: Per-page text extracted from a native-text PDF, page order starting at 1.
    #: Kept beside ``raw_text`` so a candidate's page number and that page's
    #: wording both stay checkable against the original file.
    page_texts = models.JSONField(default=list, blank=True)
    checksum = models.CharField(max_length=64, db_index=True)
    source_type = models.CharField(max_length=40, default="user_paste")
    source_note = models.CharField(max_length=500, blank=True, help_text="来源说明：出处、年份、获取方式")
    usage_scope = models.CharField(max_length=200, blank=True, help_text="允许的使用范围")
    page_count = models.PositiveSmallIntegerField(default=1)

    class Meta:
        db_table = "ingestion_source_document"
        indexes = [models.Index(fields=["project", "-created_at"])]
        verbose_name = "来源文档"
        verbose_name_plural = "来源文档"

    def __str__(self) -> str:
        return f"{self.title or self.document_type}#{self.id}"


class SourceRegion(BaseModel):
    """A locatable area of a source document (page + normalised bbox)."""

    document = models.ForeignKey(SourceDocument, on_delete=models.CASCADE, related_name="regions")
    page_index = models.PositiveSmallIntegerField(default=1, validators=[MinValueValidator(1)])
    #: Normalised 0..1 coordinates so the region survives image rescaling.
    x = models.FloatField(validators=[MinValueValidator(0.0), MaxValueValidator(1.0)])
    y = models.FloatField(validators=[MinValueValidator(0.0), MaxValueValidator(1.0)])
    width = models.FloatField(validators=[MinValueValidator(0.0), MaxValueValidator(1.0)])
    height = models.FloatField(validators=[MinValueValidator(0.0), MaxValueValidator(1.0)])
    #: Cropped image derived from this region, if one was produced.
    crop_asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.SET_NULL, related_name="regions")
    role = models.CharField(max_length=24, choices=AssetRole.choices, default=AssetRole.STEM_CROP)
    #: Raw text inside the region, when the source is text.
    text_span = models.TextField(blank=True)
    char_start = models.PositiveIntegerField(null=True, blank=True)
    char_end = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        db_table = "ingestion_source_region"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(x__gte=0) & models.Q(y__gte=0) & models.Q(width__gt=0) & models.Q(height__gt=0),
                name="region_bbox_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(x__lte=1) & models.Q(y__lte=1),
                name="region_bbox_inside_page",
            ),
        ]
        ordering = ["document", "page_index", "y", "x"]
        verbose_name = "来源区域"
        verbose_name_plural = "来源区域"

    def __str__(self) -> str:
        return f"region p{self.page_index} ({self.x:.2f},{self.y:.2f},{self.width:.2f},{self.height:.2f})"

    def clean(self) -> None:
        if self.x + self.width > 1.0001 or self.y + self.height > 1.0001:
            raise ValidationError({"width": "区域超出页面范围"})


class ImportJob(BaseModel):
    project = models.ForeignKey(
        "exams.ExamProject", on_delete=models.CASCADE, related_name="import_jobs", db_index=True
    )
    subject = models.ForeignKey(
        "exams.Subject", null=True, blank=True, on_delete=models.SET_NULL, related_name="import_jobs"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="import_jobs"
    )
    status = models.CharField(
        max_length=20, choices=ImportJobStatus.choices, default=ImportJobStatus.QUEUED, db_index=True
    )
    #: `manual`, `text`, `image_ai` — kept so a stub-assisted run is visible.
    input_kind = models.CharField(max_length=20, default="text")
    #: Free text input, when the user pasted material.
    input_text = models.TextField(blank=True)
    documents = models.ManyToManyField(SourceDocument, related_name="import_jobs", blank=True)
    #: Parsing/prompt version so candidate output can be traced to its producer.
    extractor_version = models.CharField(max_length=60, default="manual-v1")
    progress_percent = models.PositiveSmallIntegerField(default=0, validators=[MaxValueValidator(100)])
    #: Structured problem list: [{"code": ..., "message": ..., "severity": ...}]
    problems = models.JSONField(default=list, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=3)
    last_error = models.CharField(max_length=500, blank=True)
    #: Fingerprint of the input so an identical re-import is recognised.
    input_fingerprint = models.CharField(max_length=64, blank=True, db_index=True)
    duplicate_of = models.ForeignKey(
        "ingestion.ImportJob", null=True, blank=True, on_delete=models.SET_NULL, related_name="duplicates"
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ingestion_import_job"
        indexes = [models.Index(fields=["project", "status", "-created_at"])]
        ordering = ["-created_at"]
        verbose_name = "导入任务"
        verbose_name_plural = "导入任务"

    def __str__(self) -> str:
        return f"import#{self.id} {self.status}"


class ImportCandidate(BaseModel):
    """A proposed question structure awaiting human proofreading."""

    job = models.ForeignKey(ImportJob, on_delete=models.CASCADE, related_name="candidates")
    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="import_candidates")
    subject = models.ForeignKey(
        "exams.Subject", null=True, blank=True, on_delete=models.SET_NULL, related_name="import_candidates"
    )
    #: Material parent of a sub-question. The relation is parsed from the source
    #: (【材料】/子题) instead of being re-typed by the proofreader, and it survives
    #: publication: the material question stores the published child versions.
    parent_candidate = models.ForeignKey(
        "ingestion.ImportCandidate", null=True, blank=True, on_delete=models.SET_NULL, related_name="child_candidates"
    )
    #: 卷面题号 inside the paper revision (also the position key of the PaperItem
    #: created on publication), so re-importing the same paper can be recognised.
    source_position_key = models.CharField(max_length=40, blank=True, db_index=True)
    #: Draft paper revision this candidate belongs to, when it came from a paper
    #: PDF. Publishing writes a PaperItem here, which is what makes the imported
    #: real paper countable by the cycle analysis.
    paper_revision = models.ForeignKey(
        "exams.PaperRevision", null=True, blank=True, on_delete=models.SET_NULL, related_name="import_candidates"
    )
    #: How an answer page was matched onto this candidate (method, raw value,
    #: source page). Recorded so the confirmation is auditable, never implicit.
    answer_match = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=16, choices=ImportCandidateStatus.choices, default=ImportCandidateStatus.DRAFT, db_index=True
    )
    revision = models.PositiveIntegerField(default=1)
    #: Editable draft structure (see question_bank.content for the schema).
    draft_payload = models.JSONField(default=dict)
    #: The untouched extractor output, for side-by-side comparison.
    machine_payload = models.JSONField(default=dict, blank=True)
    source_regions = models.ManyToManyField(SourceRegion, related_name="candidates", blank=True)
    #: [{"code": "missing_options", "message": "...", "severity": "blocking"}]
    review_issues = models.JSONField(default=list, blank=True)
    extractor_version = models.CharField(max_length=60, blank=True)
    is_stub_output = models.BooleanField(default=False, help_text="由测试/演示 stub 生成，不代表真实模型识别")
    duplicate_of_candidate = models.ForeignKey(
        "ingestion.ImportCandidate", null=True, blank=True, on_delete=models.SET_NULL, related_name="duplicates"
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="reviewed_candidates"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    publication_question_id = models.UUIDField(null=True, blank=True)
    publication_version_id = models.UUIDField(null=True, blank=True)
    #: PaperItem created when this candidate was published (idempotency marker).
    publication_paper_item_id = models.UUIDField(null=True, blank=True)

    class Meta:
        db_table = "ingestion_import_candidate"
        ordering = ["job", "created_at"]
        verbose_name = "导入候选"
        verbose_name_plural = "导入候选"

    def __str__(self) -> str:
        return f"candidate#{self.id} {self.status}"


class CandidateRevision(BaseModel):
    """Immutable snapshot of a candidate draft at one revision.

    Proofreading overwrites the working draft, so each saved revision is kept
    here: the record of "what was reviewed" must survive later edits.
    """

    candidate = models.ForeignKey(ImportCandidate, on_delete=models.CASCADE, related_name="revisions")
    revision = models.PositiveIntegerField()
    payload = models.JSONField(default=dict)
    review_issues = models.JSONField(default=list, blank=True)
    edited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="candidate_revisions"
    )
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "ingestion_candidate_revision"
        constraints = [
            models.UniqueConstraint(fields=["candidate", "revision"], name="uniq_candidate_revision"),
        ]
        ordering = ["candidate", "-revision"]
        verbose_name = "候选修订"
        verbose_name_plural = "候选修订"
