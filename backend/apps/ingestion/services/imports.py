"""Text and image import entry points.

P0 manual/text paths are complete here. Image *recognition* is milestone M5 and
goes through the AI capability layer; this module only stores the material and
creates candidate shells so a human can type the structure, and it never
pretends a model read the image.
"""

from __future__ import annotations

import hashlib

from django.db import transaction
from django.utils import timezone

from apps.common.enums import AssetRole, ImportJobStatus, QuestionType
from apps.common.errors import InvalidInput
from apps.ingestion.models import ImportCandidate, ImportJob, SourceDocument
from apps.ingestion.services import core as ingestion


@transaction.atomic
def start_text_import(
    *,
    owner,
    project,
    text: str,
    subject=None,
    title: str = "",
    source_note: str = "",
    usage_scope: str = "",
    segments: list[dict] | None = None,
) -> ImportJob:
    """Create the source document, the job and one candidate per segment."""
    document = ingestion.create_text_document(
        owner=owner,
        project=project,
        text=text,
        title=title,
        subject=subject,
        source_note=source_note,
        usage_scope=usage_scope,
    )
    job = ingestion.create_import_job(
        owner=owner,
        project=project,
        input_kind="text",
        subject=subject,
        input_text=text,
        documents=[document],
        extractor_version="text-structure-v1",
    )
    job.status = ImportJobStatus.PROCESSING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])

    cursor = 0
    for index, segment in enumerate(segments or []):
        start = text.find(segment.get("source_excerpt", ""), cursor)
        if start < 0:
            start = cursor
        end = start + len(segment.get("source_excerpt", ""))
        cursor = end
        region = ingestion.create_source_region(
            document=document,
            page_index=1,
            x=0.0,
            y=min(0.99, index * 0.05),
            width=1.0,
            height=0.05,
            role=AssetRole.STEM_CROP,
            text_span=segment.get("source_excerpt", "")[:2000],
        )
        region.char_start = start
        region.char_end = end
        region.save(update_fields=["char_start", "char_end", "updated_at"])
        ingestion.create_candidate(
            job=job,
            payload=segment,
            subject=subject,
            machine_payload=segment,
            regions=[region],
            extractor_version="text-structure-v1",
        )
    if not segments:
        ingestion.add_job_problem(
            job,
            "no_recognised_segment",
            "未能从粘贴文本中识别出题目结构，请使用“题目模板”格式或手工录入。",
            severity="warning",
        )
    ingestion.maybe_complete_job(job)
    return job


@transaction.atomic
def start_image_import(
    *,
    owner,
    project,
    documents: list[SourceDocument],
    subject=None,
    title: str = "",
    use_vision: bool | None = None,
) -> ImportJob:
    """Store image material and open one candidate per document.

    When a provider that declares ``extract_question`` is configured, the import
    is recorded as ``image_ai`` and a real extraction task is enqueued per
    candidate. Without one it stays ``image_manual`` and says so, instead of
    pretending a model read the page.
    """
    # Imported lazily: this module loads while the app registry is being built.
    from apps.audit.services.outbox import enqueue
    from apps.ingestion.services import extraction

    if use_vision is None:
        use_vision = extraction.vision_available()
    input_kind = "image_ai" if use_vision else "image_manual"
    extractor_version = "vision-v1" if use_vision else "manual-image-v1"
    job = ingestion.create_import_job(
        owner=owner,
        project=project,
        input_kind=input_kind,
        subject=subject,
        documents=documents,
        extractor_version=extractor_version,
    )
    job.status = ImportJobStatus.PROCESSING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])
    if use_vision:
        stub_note = (
            "（当前为测试/演示 stub，输出不代表真实模型识别，必须完整人工核对）"
            if extraction.vision_is_stub()
            else ""
        )
        ingestion.add_job_problem(
            job,
            "vision_extraction_queued",
            "图片已保存为私有来源，已排入视觉识别任务；识别结果仍需人工对照原图校对后才能发布。" + stub_note,
            severity="warning" if stub_note else "info",
        )
    else:
        ingestion.add_job_problem(
            job,
            "manual_structure_required",
            "图片已保存为私有来源；未配置视觉模型，请在校对页对照原图录入题干与答案。"
            "配置可用的视觉 provider 后，同一入口会自动改为模型识别 + 人工校对。",
            severity="warning",
        )
    for document in documents:
        region = ingestion.create_source_region(
            document=document, page_index=1, x=0.0, y=0.0, width=1.0, height=1.0, role=AssetRole.PAST_PAPER_PAGE
        )
        candidate = ingestion.create_candidate(
            job=job,
            payload={
                "question_type": QuestionType.SINGLE_CHOICE,
                "display_label": title or document.title,
                "content": {"blocks": [{"kind": "text", "text": ""}]},
                "answer_payload": {},
                "answer_status_known": False,
                "needs_manual_structure": True,
            },
            subject=subject,
            regions=[region],
            extractor_version=extractor_version,
        )
        if use_vision:
            enqueue(
                "ingestion.extract_candidate",
                {
                    "import_job_id": str(job.id),
                    "document_id": str(document.id),
                    "candidate_id": str(candidate.id),
                },
                dedupe_key=f"extract-candidate:{candidate.id}",
            )
    ingestion.maybe_complete_job(job)
    return job


def retry_job(job: ImportJob, *, actor) -> ImportJob:
    """Recoverable retry: reuse the same sources, never duplicate candidates."""
    if job.status not in {ImportJobStatus.FAILED, ImportJobStatus.CANCELLED}:
        raise InvalidInput(message="只有失败或已取消的任务可以重试")
    if job.attempts >= job.max_attempts:
        raise InvalidInput(message=f"已重试 {job.attempts} 次，达到上限；请新建导入任务")
    job.attempts += 1
    job.status = ImportJobStatus.PROCESSING
    job.last_error = ""
    job.started_at = timezone.now()
    job.save(update_fields=["attempts", "status", "last_error", "started_at", "updated_at"])
    ingestion.add_job_problem(job, "retried", f"任务已重试（第 {job.attempts} 次），复用原有来源与候选。")
    ingestion.maybe_complete_job(job)
    return job


def job_summary(job: ImportJob) -> dict:
    candidates = job.candidates.all()
    return {
        "id": str(job.id),
        "project_id": str(job.project_id),
        "subject_id": str(job.subject_id) if job.subject_id else None,
        "status": job.status,
        "input_kind": job.input_kind,
        "progress_percent": job.progress_percent,
        "problems": job.problems,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "last_error": job.last_error,
        "extractor_version": job.extractor_version,
        "duplicate_of_job_id": str(job.duplicate_of_id) if job.duplicate_of_id else None,
        "document_ids": [str(document.id) for document in job.documents.all()],
        "candidate_count": candidates.count(),
        "candidate_status_counts": {
            status: sum(1 for candidate in candidates if candidate.status == status)
            for status in {candidate.status for candidate in candidates}
        },
        "created_at": job.created_at.isoformat(),
    }


def candidate_summary(candidate: ImportCandidate, *, include_payload: bool = True) -> dict:
    return {
        "id": str(candidate.id),
        "job_id": str(candidate.job_id),
        "subject_id": str(candidate.subject_id) if candidate.subject_id else None,
        "status": candidate.status,
        "revision": candidate.revision,
        "review_issues": candidate.review_issues,
        "is_stub_output": candidate.is_stub_output,
        "extractor_version": candidate.extractor_version,
        "draft_payload": candidate.draft_payload if include_payload else {},
        "machine_payload": candidate.machine_payload if include_payload else {},
        "source_regions": [
            {
                "id": str(region.id),
                "document_id": str(region.document_id),
                "page_index": region.page_index,
                "x": region.x,
                "y": region.y,
                "width": region.width,
                "height": region.height,
                "role": region.role,
                "text_span": region.text_span,
                "crop_asset_id": str(region.crop_asset_id) if region.crop_asset_id else None,
                # The whole page the crop came from, so a proofreader can always
                # compare against the original image even when no crop exists.
                "document_asset_id": str(region.document.asset_id) if region.document.asset_id else None,
                "document_title": region.document.title,
                "document_type": region.document.document_type,
            }
            for region in candidate.source_regions.select_related("document")
        ],
        "publication_question_id": str(candidate.publication_question_id) if candidate.publication_question_id else None,
        "publication_version_id": str(candidate.publication_version_id) if candidate.publication_version_id else None,
        "updated_at": candidate.updated_at.isoformat(),
    }


def text_fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
