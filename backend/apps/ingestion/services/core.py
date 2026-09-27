"""Ingestion services: private material, imports, proofreading and publication."""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.audit.models import ContentRevision
from apps.common.content import normalize_content, validate_content
from apps.common.enums import (
    AssetRole,
    AssetSensitivity,
    ImportCandidateStatus,
    ImportJobStatus,
    OriginType,
    QuestionType,
)
from apps.common.errors import InvalidInput, ScopeViolation, StructureInvalid, VersionConflict
from apps.ingestion.models import Asset, CandidateRevision, ImportCandidate, ImportJob, SourceDocument, SourceRegion
from apps.ingestion.services import layout
from apps.ingestion.storage import build_key, get_storage


def file_checksum(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def validate_image(*, content: bytes, content_type: str) -> tuple[int, int]:
    """Validate real image bytes (not just the declared MIME type)."""
    from io import BytesIO

    from django.conf import settings
    from PIL import Image, UnidentifiedImageError

    allowed = tuple(getattr(settings, "ALLOWED_IMAGE_MIME_TYPES", ("image/jpeg", "image/png", "image/webp")))
    if content_type not in allowed:
        raise InvalidInput(message="仅支持 JPEG/PNG/WebP 图片", details={"content_type": content_type})
    max_bytes = getattr(settings, "IMAGE_MAX_BYTES", 10 * 1024 * 1024)
    if len(content) > max_bytes:
        raise InvalidInput(message=f"图片超过大小上限 {max_bytes // (1024 * 1024)} MiB")
    max_pixels = getattr(settings, "IMAGE_MAX_PIXELS", 25_000_000)
    try:
        with Image.open(BytesIO(content)) as probe:
            probe.verify()
        with Image.open(BytesIO(content)) as probe:
            width, height = probe.size
            detected = (probe.format or "").lower()
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidInput(message="图片内容无法解析，文件可能损坏或不是真实图片") from exc
    if detected not in {"jpeg", "png", "webp"}:
        raise InvalidInput(message="图片格式与声明不一致", details={"detected": detected})
    if width * height > max_pixels:
        raise InvalidInput(message="图片像素超过上限，请先裁剪或压缩")
    return width, height


def strip_metadata(content: bytes) -> bytes:
    """Re-encode without EXIF/metadata; SVG and HTML are never executed."""
    from io import BytesIO

    from PIL import Image

    try:
        with Image.open(BytesIO(content)) as image:
            image.load()
            clean = Image.new(image.mode, image.size)
            clean.putdata(list(image.getdata()))
            output = BytesIO()
            fmt = (image.format or "PNG").upper()
            if fmt == "JPG":
                fmt = "JPEG"
            if fmt == "JPEG" and image.mode not in ("RGB", "L"):
                clean = clean.convert("RGB")
            clean.save(output, format=fmt)
            return output.getvalue()
    except Exception:
        # A re-encode failure must not lose the original: keep it but record it.
        return content


@transaction.atomic
def store_asset(
    *,
    owner,
    project,
    content: bytes,
    content_type: str,
    role: str = AssetRole.OTHER,
    sensitivity: str = AssetSensitivity.PUBLIC_TO_OWNER,
    subject=None,
    original_filename: str = "",
    source_document: SourceDocument | None = None,
    reencode: bool = True,
) -> Asset:
    """Persist private bytes under a server-generated key."""
    if role not in AssetRole.values:
        raise InvalidInput(message="资产角色无效", details={"role": role})
    if sensitivity not in AssetSensitivity.values:
        raise InvalidInput(message="资产敏感级别无效")
    if subject is not None and str(subject.project_id) != str(project.id):
        raise ScopeViolation(message="科目不属于该项目")
    width = height = None
    payload = content
    if content_type.startswith("image/"):
        width, height = validate_image(content=content, content_type=content_type)
        if reencode:
            payload = strip_metadata(content)
    namespace = f"{owner.id}/{project.id}/{'region' if role in {AssetRole.STEM_CROP, AssetRole.MATERIAL_CROP, AssetRole.ANSWER_CROP} else 'source' if role in {AssetRole.PAST_PAPER_PAGE, AssetRole.ANSWER_PAGE} else 'uploads'}"
    suffix = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "application/pdf": "pdf",
    }.get(content_type, "bin")
    key = build_key(namespace, suffix)
    stored = get_storage().save(key, payload, content_type=content_type)
    return Asset.objects.create(
        owner=owner,
        project=project,
        subject=subject,
        role=role,
        sensitivity=sensitivity,
        object_key=stored.key,
        original_filename=original_filename[:255],
        content_type=content_type,
        size_bytes=stored.size,
        checksum=stored.checksum,
        width=width,
        height=height,
        source_document=source_document,
        uploaded_by=owner,
    )


@transaction.atomic
def create_text_document(
    *,
    owner,
    project,
    text: str,
    title: str = "",
    subject=None,
    role: str = AssetRole.PAST_PAPER_PAGE,
    source_type: str = "user_paste",
    source_note: str = "",
    usage_scope: str = "",
    sensitivity: str = AssetSensitivity.PUBLIC_TO_OWNER,
) -> SourceDocument:
    """Pasted text always creates a document holding the raw original."""
    if not text.strip():
        raise InvalidInput(message="文本内容不能为空")
    return SourceDocument.objects.create(
        owner=owner,
        project=project,
        subject=subject,
        title=title[:300],
        document_type="text",
        role=role,
        sensitivity=sensitivity,
        raw_text=text,
        checksum=file_checksum(text.encode("utf-8")),
        source_type=source_type,
        source_note=source_note[:500],
        usage_scope=usage_scope[:200],
    )


@transaction.atomic
def create_image_document(
    *,
    owner,
    project,
    content: bytes,
    content_type: str,
    role: str = AssetRole.PAST_PAPER_PAGE,
    title: str = "",
    subject=None,
    source_note: str = "",
    usage_scope: str = "",
    sensitivity: str = AssetSensitivity.PUBLIC_TO_OWNER,
    original_filename: str = "",
) -> SourceDocument:
    asset = store_asset(
        owner=owner,
        project=project,
        content=content,
        content_type=content_type,
        role=role,
        sensitivity=sensitivity,
        subject=subject,
        original_filename=original_filename,
    )
    return SourceDocument.objects.create(
        owner=owner,
        project=project,
        subject=subject,
        title=title[:300],
        document_type="image",
        role=role,
        sensitivity=sensitivity,
        asset=asset,
        checksum=asset.checksum,
        source_type="user_upload",
        source_note=source_note[:500],
        usage_scope=usage_scope[:200],
    )


@transaction.atomic
def create_pdf_document(
    *,
    owner,
    project,
    content: bytes,
    role: str = AssetRole.PAST_PAPER_PAGE,
    title: str = "",
    subject=None,
    page_texts: list[str] | None = None,
    source_note: str = "",
    usage_scope: str = "",
    sensitivity: str = AssetSensitivity.PUBLIC_TO_OWNER,
    original_filename: str = "",
) -> SourceDocument:
    """Store one native-text PDF plus its per-page text layer.

    The original bytes and the extracted text are kept together: the text layer
    is what the parser reads, and the file is what a proofreader opens to check
    it. Neither replaces the other.
    """
    pages = list(page_texts or [])
    asset = store_asset(
        owner=owner,
        project=project,
        content=content,
        content_type="application/pdf",
        role=role,
        sensitivity=sensitivity,
        subject=subject,
        original_filename=original_filename,
        reencode=False,
    )
    return SourceDocument.objects.create(
        owner=owner,
        project=project,
        subject=subject,
        title=title[:300],
        document_type="pdf_answer" if role == AssetRole.ANSWER_PAGE else "pdf",
        role=role,
        sensitivity=sensitivity,
        asset=asset,
        raw_text="\n".join(pages),
        page_texts=pages,
        page_count=max(1, len(pages)),
        checksum=asset.checksum,
        source_type="user_upload",
        source_note=source_note[:500],
        usage_scope=usage_scope[:200],
    )


def find_duplicate_document(*, project, checksum: str) -> SourceDocument | None:
    return (
        SourceDocument.objects.filter(project=project, checksum=checksum)
        .exclude(document_type="text")
        .order_by("created_at")
        .first()
    )


@transaction.atomic
def create_import_job(
    *,
    owner,
    project,
    input_kind: str,
    subject=None,
    input_text: str = "",
    documents: list[SourceDocument] | None = None,
    extractor_version: str = "manual-v1",
) -> ImportJob:
    documents = documents or []
    for document in documents:
        if str(document.project_id) != str(project.id):
            raise ScopeViolation(message="来源文档不属于该项目")
    fingerprint_source = input_text.encode("utf-8") if input_text else b"".join(
        document.checksum.encode("utf-8") for document in documents
    )
    fingerprint = file_checksum(fingerprint_source or str(project.id).encode("utf-8"))
    job = ImportJob.objects.create(
        project=project,
        subject=subject,
        created_by=owner,
        status=ImportJobStatus.QUEUED,
        input_kind=input_kind,
        input_text=input_text,
        extractor_version=extractor_version,
        input_fingerprint=fingerprint,
    )
    if documents:
        job.documents.set(documents)
    previous = (
        ImportJob.objects.filter(project=project, input_fingerprint=fingerprint)
        .exclude(id=job.id)
        .order_by("created_at")
        .first()
    )
    if previous is not None:
        job.duplicate_of = previous
        job.problems = [
            {
                "code": "duplicate_input",
                "message": "检测到相同输入的历史导入任务，请确认是复用还是新建题库（不会自动重复计入真实试卷）",
                "severity": "warning",
                "duplicate_job_id": str(previous.id),
            }
        ]
        job.save(update_fields=["duplicate_of", "problems", "updated_at"])
    return job


@transaction.atomic
def create_source_region(
    *,
    document: SourceDocument,
    page_index: int = 1,
    x: float,
    y: float,
    width: float,
    height: float,
    role: str = AssetRole.STEM_CROP,
    text_span: str = "",
    crop_asset: Asset | None = None,
) -> SourceRegion:
    region = SourceRegion(
        document=document,
        page_index=page_index,
        x=x,
        y=y,
        width=width,
        height=height,
        role=role,
        text_span=text_span,
        crop_asset=crop_asset,
    )
    region.full_clean(exclude=["document"])
    region.save()
    return region


@transaction.atomic
def create_candidate(
    *,
    job: ImportJob,
    payload: dict,
    subject=None,
    machine_payload: dict | None = None,
    regions: list[SourceRegion] | None = None,
    is_stub_output: bool = False,
    extractor_version: str = "",
    parent_candidate: ImportCandidate | None = None,
    source_position_key: str = "",
    paper_revision=None,
    answer_match: dict | None = None,
) -> ImportCandidate:
    subject = subject or job.subject
    candidate = ImportCandidate.objects.create(
        job=job,
        project=job.project,
        subject=subject,
        status=ImportCandidateStatus.DRAFT,
        draft_payload=payload,
        machine_payload=machine_payload or payload,
        is_stub_output=is_stub_output,
        extractor_version=extractor_version or job.extractor_version,
        parent_candidate=parent_candidate,
        source_position_key=source_position_key[:40],
        paper_revision=paper_revision,
        answer_match=answer_match or {},
    )
    if regions:
        for region in regions:
            if str(region.document.project_id) != str(job.project.id):
                raise ScopeViolation(message="来源区域不属于该项目")
        candidate.source_regions.set(regions)
    refresh_candidate_issues(candidate)
    return candidate


def published_paper_position(*, paper, position_key: str):
    """The already-published question version sitting at one paper position."""
    from apps.exams.models import PaperItem

    item = (
        PaperItem.objects.filter(
            revision__paper=paper,
            position_key=position_key,
            question_version__status="published",
        )
        .select_related("question_version")
        .order_by("created_at")
        .first()
    )
    return item.question_version if item is not None else None


def refresh_candidate_issues(candidate: ImportCandidate) -> list[dict]:
    """List blocking/warning issues for proofreading, including duplicates."""
    from apps.question_bank.models import Question, QuestionVersion

    issues: list[dict] = []
    payload = candidate.draft_payload or {}
    question_type = payload.get("question_type")
    content = payload.get("content") or {}
    if not question_type:
        issues.append({"code": "missing_question_type", "message": "缺少题型", "severity": "blocking"})
    else:
        for problem in validate_content(content, question_type):
            issues.append({**problem, "severity": "blocking"})
        if question_type in {QuestionType.SINGLE_CHOICE, QuestionType.MULTIPLE_CHOICE}:
            options = content.get("options") or []
            if len(options) < 2:
                issues.append({"code": "too_few_options", "message": "选项少于两个，疑似识别缺失", "severity": "blocking"})
    answer_payload = payload.get("answer_payload") or {}
    is_material = question_type == QuestionType.MATERIAL
    if is_material:
        # A material is a shared stem, not a scoring unit: it has no answer of its
        # own, and its completeness is defined by its published sub-questions.
        children = list(candidate.child_candidates.all()) if candidate.pk else []
        if not children:
            issues.append(
                {
                    "code": "material_without_children",
                    "message": "材料题没有任何子题；请先校对并发布子题，再发布材料题",
                    "severity": "blocking",
                }
            )
        else:
            unpublished = [child for child in children if child.status != ImportCandidateStatus.PUBLISHED]
            if unpublished:
                issues.append(
                    {
                        "code": "material_children_unpublished",
                        "message": f"仍有 {len(unpublished)} 个子题未发布，材料题的子题关系尚不完整",
                        "severity": "blocking",
                        "candidate_ids": [str(child.id) for child in unpublished],
                    }
                )
    elif not payload.get("answer_status_known", True):
        issues.append({"code": "answer_unknown", "message": "答案缺失或不确定，不能发布为计分题", "severity": "blocking"})
    elif not answer_payload:
        issues.append({"code": "answer_missing", "message": "尚未填写答案", "severity": "blocking"})
    match = candidate.answer_match or {}
    if match.get("matched") and not payload.get("answer_confirmed_by_match_review"):
        # Mechanical matching is a proposal. Until a human confirms it, the
        # candidate must not be publishable (答案匹配只产生候选).
        issues.append(
            {
                "code": "answer_match_pending_confirmation",
                "message": (
                    f"答案由答案页匹配产生（方式：{'题号' if match.get('method') == 'label' else '顺序'}，"
                    f"原文：{str(match.get('raw', ''))[:40]}），请核对后确认"
                ),
                "severity": "blocking",
                "method": match.get("method"),
                "source_page_index": match.get("source_page_index"),
            }
        )
    if not candidate.subject_id:
        issues.append({"code": "subject_missing", "message": "尚未选择科目", "severity": "blocking"})
    if candidate.paper_revision_id and not is_material:
        raw_score = payload.get("practice_max_score")
        if raw_score in (None, ""):
            issues.append(
                {
                    "code": "paper_item_score_missing",
                    "message": "该题属于真实试卷记录：发布前必须填写分值，否则周期分值的分母不完整",
                    "severity": "blocking",
                }
            )
    if candidate.paper_revision_id and candidate.source_position_key:
        published = published_paper_position(
            paper=candidate.paper_revision.paper, position_key=candidate.source_position_key
        )
        if published is not None and str(published.id) != str(candidate.publication_version_id or ""):
            # Re-importing a paper must not publish the same paper position twice.
            issues.append(
                {
                    "code": "duplicate_paper_position",
                    "message": (
                        f"该试卷的题号 {candidate.source_position_key} 已发布过版本；"
                        "重复导入不能再次发布（如需修订请在题库中创建新版本）"
                    ),
                    "severity": "blocking",
                    "question_id": str(published.question_id),
                    "question_version_id": str(published.id),
                }
            )
    if not candidate.source_regions.exists():
        issues.append(
            {"code": "no_source_region", "message": "缺少来源区域；题目必须可追溯到原文或原图", "severity": "warning"}
        )
    # P2 batch 1: layout that a deterministic parser cannot read reliably has to
    # reach a human *before* publication. The issues come from the pages this
    # candidate actually occupies, and only an explicit layout confirmation clears
    # them — nothing here can publish a multi-column, table/formula or scanned
    # page on its own (错误无法自动发布).
    if candidate.layout_review_confirmed_at is None:
        issues.extend(
            layout.layout_review_issues(
                page_diagnostics=candidate.job.page_diagnostics,
                pages=[
                    (region.document_id, region.page_index)
                    for region in candidate.source_regions.all()
                ],
            )
        )
    continues_on_pages = [int(page) for page in (payload.get("continues_on_pages") or [])]
    if len(continues_on_pages) > 1:
        # Non-blocking: the join is wanted, the proofreader just has to know that
        # the question was assembled across pages.
        issues.append(
            {
                "code": layout.ISSUE_CROSS_PAGE,
                "message": (
                    "该题跨页（第 "
                    + "、".join(str(page) for page in continues_on_pages)
                    + " 页）：题干/选项在页面之间被自动接续，请对照原页确认没有漏字或缺行"
                ),
                "severity": "warning",
                "pages": continues_on_pages,
            }
        )
    # P2 batch 2 (C02): an AI-generated variant is re-checked here, inside the
    # single publish gate, against its *stored* payload. That is what makes a
    # rejection durable — "failed proposals stay candidates" cannot be undone by
    # editing an unrelated field, and a variant can never be published while it
    # still duplicates published content, has an unverifiable answer, or targets
    # a node outside the question's syllabus.
    if candidate.job.input_kind == "ai_variant":
        from apps.question_bank.services import variants as variant_services

        issues.extend(variant_services.variant_review_issues(candidate))

    if question_type and content:
        digest = hashlib.sha256(
            repr(normalize_content(content)).encode("utf-8")
        ).hexdigest()
        existing_candidate = (
            ImportCandidate.objects.filter(project=candidate.project, draft_payload__content=content)
            .exclude(id=candidate.id)
            .exclude(status=ImportCandidateStatus.IGNORED)
            .first()
        )
        if existing_candidate is not None:
            issues.append(
                {
                    "code": "duplicate_candidate",
                    "message": "题库中疑似已有相同结构的候选，请确认是否为重复录入",
                    "severity": "warning",
                    "candidate_id": str(existing_candidate.id),
                }
            )
        del digest
        subject_id = candidate.subject_id
        if subject_id:
            near = QuestionVersion.objects.filter(
                question__subject_id=subject_id, status="published", content=content
            ).first()
            if near is not None:
                issues.append(
                    {
                        "code": "duplicate_published",
                        "message": "已存在内容完全相同的已发布版本，导入前请确认不要重复统计",
                        "severity": "warning",
                        "question_id": str(near.question_id),
                    }
                )
            similar_label = payload.get("display_label")
            if similar_label:
                same_label = Question.objects.filter(
                    subject_id=subject_id, display_label=similar_label
                ).first()
                if same_label is not None:
                    issues.append(
                        {
                            "code": "duplicate_label",
                            "message": f"该科目已存在相同题号/标签：{similar_label}",
                            "severity": "warning",
                            "question_id": str(same_label.id),
                        }
                    )
    candidate.review_issues = issues
    if candidate.status in {ImportCandidateStatus.PUBLISHED, ImportCandidateStatus.IGNORED}:
        # Recomputing issues must never un-publish or un-ignore a decided
        # candidate; the issues are informational for those two states.
        candidate.save(update_fields=["review_issues", "updated_at"])
        return issues
    blocking = [issue for issue in issues if issue.get("severity") == "blocking"]
    if not blocking and candidate.status == ImportCandidateStatus.DRAFT:
        candidate.status = ImportCandidateStatus.READY
    elif blocking:
        candidate.status = ImportCandidateStatus.DRAFT
    candidate.save(update_fields=["review_issues", "status", "updated_at"])
    return issues


@transaction.atomic
def update_candidate(
    candidate: ImportCandidate,
    *,
    payload: dict | None = None,
    subject=None,
    expected_revision: int | None = None,
    actor=None,
    note: str = "",
) -> ImportCandidate:
    locked = ImportCandidate.objects.select_for_update().get(id=candidate.id)
    if expected_revision is not None and int(expected_revision) != int(locked.revision):
        raise VersionConflict(details={"expected": expected_revision, "actual": locked.revision})
    if locked.status == ImportCandidateStatus.PUBLISHED:
        raise InvalidInput(message="已发布的候选不能继续修改；请为已发布题目创建新版本")
    if subject is not None:
        if str(subject.project_id) != str(locked.project_id):
            raise ScopeViolation(message="科目不属于该项目")
        locked.subject = subject
    if payload is not None:
        locked.draft_payload = payload
    locked.revision += 1
    locked.reviewed_by = actor
    locked.reviewed_at = timezone.now()
    locked.save(update_fields=["subject", "draft_payload", "revision", "reviewed_by", "reviewed_at", "updated_at"])
    CandidateRevision.objects.create(
        candidate=locked,
        revision=locked.revision,
        payload=locked.draft_payload,
        review_issues=locked.review_issues,
        edited_by=actor,
        note=note[:500],
    )
    if actor is not None:
        ContentRevision.objects.create(
            actor=actor,
            entity_type="import_candidate",
            entity_id=str(locked.id),
            action="proofread",
            project_id=locked.project_id,
            detail={"revision": locked.revision},
        )
    refresh_candidate_issues(locked)
    return locked


@transaction.atomic
def ignore_candidate(candidate: ImportCandidate, *, actor, reason: str = "") -> ImportCandidate:
    locked = ImportCandidate.objects.select_for_update().get(id=candidate.id)
    if locked.status == ImportCandidateStatus.PUBLISHED:
        raise InvalidInput(message="已发布候选不能标记为忽略")
    locked.status = ImportCandidateStatus.IGNORED
    locked.save(update_fields=["status", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="import_candidate",
        entity_id=str(locked.id),
        action="ignore",
        project_id=locked.project_id,
        reason=reason[:500],
    )
    maybe_complete_job(locked.job)
    return locked


@transaction.atomic
def confirm_layout_review(candidate: ImportCandidate, *, actor, note: str = "") -> ImportCandidate:
    """A human confirms the layout of the pages this candidate came from.

    This is the *only* way to clear the blocking layout issues
    (``multi_column_needs_review`` / ``table_or_formula_needs_review`` /
    ``page_without_text_layer_needs_manual_entry``), and it records who confirmed
    what and when: publishing a candidate from a page the parser could not read
    reliably therefore always leaves an auditable confirmation behind.
    """
    locked = ImportCandidate.objects.select_for_update().get(id=candidate.id)
    if locked.status == ImportCandidateStatus.PUBLISHED:
        raise InvalidInput(message="已发布的候选无需再确认版式")
    locked.layout_review_confirmed_at = timezone.now()
    locked.layout_review_note = (note or "")[:500]
    locked.reviewed_by = actor
    locked.reviewed_at = locked.layout_review_confirmed_at
    locked.save(
        update_fields=[
            "layout_review_confirmed_at",
            "layout_review_note",
            "reviewed_by",
            "reviewed_at",
            "updated_at",
        ]
    )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="import_candidate",
        entity_id=str(locked.id),
        action="layout_confirm",
        project_id=locked.project_id,
        reason=locked.layout_review_note,
        detail={
            "pages": [
                {"document_id": str(region.document_id), "page_index": region.page_index}
                for region in locked.source_regions.all()
            ],
            "continues_on_pages": (locked.draft_payload or {}).get("continues_on_pages") or [],
        },
    )
    refresh_candidate_issues(locked)
    return locked


@transaction.atomic
def publish_candidate(
    candidate: ImportCandidate,
    *,
    actor,
    exam_spec_version=None,
    node_ids: list[str] | None = None,
    origin_type: str = OriginType.USER_AUTHORED,
    display_label: str = "",
) -> tuple[ImportCandidate, Any]:
    """Turn a proofread candidate into an immutable question version.

    Publication is a single transaction: candidate state, question identity,
    version, answer, rubric, mappings and audit rows commit together.
    """
    from apps.question_bank.services import core as qb_services

    locked = ImportCandidate.objects.select_for_update().get(id=candidate.id)
    if locked.status == ImportCandidateStatus.PUBLISHED:
        from apps.question_bank.models import Question

        question = Question.objects.filter(id=locked.publication_question_id).first()
        if question is None:  # pragma: no cover - defensive
            raise InvalidInput(message="候选已发布但题目身份缺失，请检查数据一致性")
        return locked, question
    if locked.status == ImportCandidateStatus.IGNORED:
        raise InvalidInput(message="已忽略的候选不能发布")
    if locked.subject is None:
        raise InvalidInput(message="发布前必须选择科目")

    payload = locked.draft_payload or {}
    question_type = payload.get("question_type")
    content = payload.get("content") or {}
    issues = refresh_candidate_issues(locked)
    blocking = [issue for issue in issues if issue.get("severity") == "blocking"]
    if blocking:
        raise StructureInvalid(message="候选仍有未解决的问题，不能发布", details={"problems": blocking})
    if locked.job.input_kind == "ai_variant":
        # P2 batch 2 (C02): a variant is AI content by construction. The caller
        # cannot relabel it as user-authored to make it countable as real
        # material — the origin decides `is_demo`, and only `ai_generated`
        # guarantees the cycle analysis and the PaperItem rule keep it out.
        origin_type = OriginType.AI_GENERATED

    declared_score = _to_decimal(payload.get("practice_max_score"))
    if declared_score is None and exam_spec_version is not None:
        # Publishing may explicitly adopt the selected spec's default for this
        # type; the choice is recorded on the version and shown to the reviewer.
        declared_score = exam_spec_version.default_max_score(question_type)
    if question_type == QuestionType.MATERIAL:
        # The material version is created when its first child is published (a
        # child must point at it) and published only once its children are done,
        # because publish validation compares the declared child list with the
        # children that actually point at it.
        version = _ensure_material_version(locked, actor=actor)
        question = version.question
        version.content = content
        version.material_child_version_ids = published_child_version_ids(locked)
        version.save(update_fields=["content", "material_child_version_ids", "updated_at"])
    else:
        question = qb_services.create_question(
            subject=locked.subject,
            origin_type=origin_type,
            actor=actor,
            display_label=display_label or payload.get("display_label", ""),
            is_demo=origin_type in {OriginType.DEMO, OriginType.AI_GENERATED},
        )
        version = qb_services.create_question_version_draft(
            question,
            question_type=question_type,
            content=content,
            actor=actor,
            practice_max_score=declared_score,
            estimated_seconds=payload.get("estimated_seconds"),
            revision_reason=f"由导入候选 {locked.id} 发布",
        )
        if locked.parent_candidate_id:
            material_version = _ensure_material_version(locked.parent_candidate, actor=actor)
            version.parent_material_version = material_version
            version.save(update_fields=["parent_material_version", "updated_at"])
    if locked.source_regions.exists():
        from apps.question_bank.models import QuestionSourceLink

        for region in locked.source_regions.all():
            QuestionSourceLink.objects.create(question_version=version, region=region, role="stem")
    answer_payload = payload.get("answer_payload") or {}
    if question_type != QuestionType.MATERIAL:
        from apps.common.enums import AnswerSourceType, VerificationStatus

        answer = qb_services.create_answer_key_version(
            version,
            answer_payload=answer_payload,
            actor=actor,
            source_type=payload.get("answer_source_type") or AnswerSourceType.USER,
            verification_status=VerificationStatus.CHECKED,
            check_basis=payload.get("check_basis") or "人工校对确认（导入流程）",
            explanation_blocks=payload.get("explanation_blocks") or [],
        )
        if question_type == QuestionType.CONSTRUCTED_RESPONSE:
            criteria = payload.get("rubric_criteria") or []
            total = _to_decimal(payload.get("rubric_total_score")) or _to_decimal(payload.get("practice_max_score")) or Decimal("0")
            qb_services.upsert_rubric_version(answer, criteria=criteria, total_score=total, actor=actor)
    if node_ids:
        weights = Decimal("1") / Decimal(len(node_ids)) if node_ids else Decimal("0")
        qb_services.replace_knowledge_mappings(
            version,
            [
                {"node_id": node_id, "is_primary": True, "score_weight": weights}
                for node_id in node_ids
            ],
            actor=actor,
        )
    published = qb_services.publish_question_version(version, actor=actor)
    locked.status = ImportCandidateStatus.PUBLISHED
    locked.publication_question_id = question.id
    locked.publication_version_id = published.id
    locked.save(update_fields=["status", "publication_question_id", "publication_version_id", "updated_at"])
    # A candidate that belongs to a real paper occurrence writes its scored
    # position into that paper revision. This is what makes an imported real
    # paper countable by the cycle analysis, and `publication_paper_item_id`
    # makes the write idempotent.
    _write_paper_item(locked, published, actor=actor)
    _reconcile_material_children(locked, actor=actor)
    refresh_candidate_issues(locked)
    maybe_complete_job(locked.job)
    return locked, question


def _ensure_material_version(candidate: ImportCandidate, *, actor):
    """The material's own version, created as a draft on first need.

    A sub-question can only point at its material through a real version row, so
    the material version has to exist before the first child is published — but it
    can only be *published* after its children are, which is why the two steps are
    separate.
    """
    from apps.question_bank.models import QuestionVersion
    from apps.question_bank.services import core as qb_services

    if candidate.publication_version_id:
        existing = QuestionVersion.objects.filter(id=candidate.publication_version_id).first()
        if existing is not None:
            return existing
    payload = candidate.draft_payload or {}
    question = qb_services.create_question(
        subject=candidate.subject,
        origin_type=OriginType.USER_AUTHORED,
        actor=actor,
        display_label=payload.get("display_label", ""),
        is_demo=False,
    )
    version = qb_services.create_question_version_draft(
        question,
        question_type=QuestionType.MATERIAL,
        content=payload.get("content") or {"blocks": []},
        actor=actor,
        revision_reason=f"由导入候选 {candidate.id} 的材料题版本",
    )
    candidate.publication_question_id = question.id
    candidate.publication_version_id = version.id
    candidate.save(update_fields=["publication_question_id", "publication_version_id", "updated_at"])
    return version


def published_child_version_ids(candidate: ImportCandidate) -> list[str]:
    """Published versions of a material candidate's children, in source order."""
    ids: list[str] = []
    for child in candidate.child_candidates.order_by("created_at"):
        if child.publication_version_id:
            ids.append(str(child.publication_version_id))
    return ids


def _reconcile_material_children(candidate: ImportCandidate, *, actor) -> None:
    """Keep a material version's child list in step with its published children."""
    from apps.question_bank.models import QuestionVersion

    if candidate.parent_candidate_id is None:
        return
    parent = candidate.parent_candidate
    if not parent.publication_version_id:
        return
    version = QuestionVersion.objects.filter(id=parent.publication_version_id).first()
    if version is None:  # pragma: no cover - defensive
        return
    derived = published_child_version_ids(parent)
    if sorted(map(str, version.material_child_version_ids or [])) != sorted(derived):
        version.material_child_version_ids = derived
        version.save(update_fields=["material_child_version_ids", "updated_at"])


def _write_paper_item(candidate: ImportCandidate, published_version, *, actor) -> None:
    """Create the PaperItem for a published candidate, exactly once.

    This is the bridge between "a question was published" and "the real paper
    occurrence now contains this question with this score", which is what the
    cycle analysis counts. It is idempotent through
    ``publication_paper_item_id``: a retried publication cannot create a second
    item, and the unique (revision, position) constraint is the second guard.
    """
    from apps.exams.models import PaperItem
    from apps.exams.services import core as exam_services

    if candidate.paper_revision_id is None or candidate.publication_paper_item_id is not None:
        return
    payload = candidate.draft_payload or {}
    is_material = payload.get("question_type") == QuestionType.MATERIAL
    item = exam_services.add_paper_item(
        candidate.paper_revision,
        actor=actor,
        position_key=_paper_position_key(candidate),
        question_version=published_version,
        answer_key_version=published_version.answer_keys.order_by("-version").first(),
        max_score=Decimal("0") if is_material else (_to_decimal(payload.get("practice_max_score")) or Decimal("0")),
        is_scored=not is_material,
        parent_item=_published_parent_item(candidate),
    )
    candidate.publication_paper_item_id = item.id
    candidate.save(update_fields=["publication_paper_item_id", "updated_at"])
    if is_material:
        _attach_children_to_material_item(candidate, item, PaperItem)


def _paper_position_key(candidate: ImportCandidate) -> str:
    """The 卷面题号 this candidate occupies; candidates always have one."""
    payload = candidate.draft_payload or {}
    return (
        candidate.source_position_key
        or str(payload.get("display_label") or "")
        or f"cand-{str(candidate.id)[:8]}"
    )


def _published_parent_item(candidate: ImportCandidate):
    """The material's paper item, when the child was published after it."""
    from apps.exams.models import PaperItem

    parent = candidate.parent_candidate
    if parent is None or not parent.publication_paper_item_id:
        return None
    return PaperItem.objects.filter(id=parent.publication_paper_item_id).first()


def _attach_children_to_material_item(candidate: ImportCandidate, item, paper_item_model) -> None:
    """Children are usually published first, so their items are linked here."""
    child_item_ids = [
        child.publication_paper_item_id
        for child in candidate.child_candidates.all()
        if child.publication_paper_item_id
    ]
    if child_item_ids:
        paper_item_model.objects.filter(id__in=child_item_ids).update(
            parent_item=item, updated_at=timezone.now()
        )


def _to_decimal(value) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception as exc:
        raise InvalidInput(message="分值必须是十进制数") from exc


def maybe_complete_job(job: ImportJob) -> ImportJob:
    """`completed` means every candidate is published or explicitly ignored."""
    if job.status in {ImportJobStatus.FAILED, ImportJobStatus.CANCELLED}:
        return job
    pending = job.candidates.exclude(
        status__in=[ImportCandidateStatus.PUBLISHED, ImportCandidateStatus.IGNORED]
    ).count()
    if pending == 0 and job.candidates.exists():
        job.status = ImportJobStatus.COMPLETED
        job.progress_percent = 100
        job.finished_at = timezone.now()
        job.save(update_fields=["status", "progress_percent", "finished_at", "updated_at"])
    else:
        job.status = ImportJobStatus.AWAITING_REVIEW
        job.save(update_fields=["status", "updated_at"])
    return job


def add_job_problem(job: ImportJob, code: str, message: str, *, severity: str = "warning", **extra) -> None:
    problems = list(job.problems or [])
    problems.append({"code": code, "message": message, "severity": severity, **extra})
    job.problems = problems
    job.save(update_fields=["problems", "updated_at"])


@transaction.atomic
def mark_job_failed(job: ImportJob, *, error: str) -> ImportJob:
    locked = ImportJob.objects.select_for_update().get(id=job.id)
    locked.status = ImportJobStatus.FAILED
    locked.last_error = error[:500]
    locked.finished_at = timezone.now()
    locked.save(update_fields=["status", "last_error", "finished_at", "updated_at"])
    return locked
