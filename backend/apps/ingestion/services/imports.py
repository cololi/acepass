"""Text, image and native-text PDF import entry points.

P0 manual/text paths are complete here. Image *recognition* is milestone M5 and
goes through the AI capability layer; this module only stores the material and
creates candidate shells so a human can type the structure, and it never
pretends a model read the image.

P1-01 adds the *native-text* PDF path: the text layer of a born-digital paper is
extracted page by page, parsed with the same labelled parser, and turned into
candidates that each know their source page. Answers printed on their own page
are matched onto those candidates as proposals only — nothing here reads an
image, calls a model, or publishes an answer key.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from django.db import transaction
from django.utils import timezone

from apps.common.enums import AssetRole, ImportJobStatus, QuestionType, SourceKind
from apps.common.errors import InvalidInput
from apps.ingestion.models import ImportCandidate, ImportJob, SourceDocument
from apps.ingestion.services import core as ingestion
from apps.ingestion.services import layout, pdf_text, text_parser


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
        # P2 batch 1: per-page layout diagnosis (multi-column, grid, formula,
        # scanned) so the proofreading UI can point at the pages that need a human.
        "page_diagnostics": job.page_diagnostics or [],
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
        "publication_paper_item_id": (
            str(candidate.publication_paper_item_id) if candidate.publication_paper_item_id else None
        ),
        # Material hierarchy parsed from the source, and the paper position this
        # candidate occupies (P1-01).
        "parent_candidate_id": str(candidate.parent_candidate_id) if candidate.parent_candidate_id else None,
        "child_candidate_ids": [str(child.id) for child in candidate.child_candidates.order_by("created_at")],
        "source_position_key": candidate.source_position_key,
        "paper_revision_id": str(candidate.paper_revision_id) if candidate.paper_revision_id else None,
        # How an answer page was matched onto this candidate: a proposal that a
        # human still has to confirm before an answer key can be published.
        "answer_match": candidate.answer_match or {},
        # P2 batch 1: the layout confirmation that clears the blocking issues a
        # suspicious source page produces (multi-column / table / formula / scan).
        "layout_review_confirmed_at": (
            candidate.layout_review_confirmed_at.isoformat()
            if candidate.layout_review_confirmed_at
            else None
        ),
        "layout_review_note": candidate.layout_review_note,
        "updated_at": candidate.updated_at.isoformat(),
    }


def text_fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# P1-01: native-text PDF batch import
# --------------------------------------------------------------------------
@dataclass
class PdfUpload:
    """One uploaded PDF, already read into memory by the API layer."""

    filename: str
    content: bytes
    content_type: str = "application/pdf"


#: Recorded on every candidate and job so the producer of a parse is traceable.
#: v2 is the layout-aware parser (P2 batch 1): column-major reading order,
#: cross-page joins and per-page layout diagnostics.
PDF_EXTRACTOR_VERSION = "pdf-text-v2"
#: Upper bound on the per-page diagnosis rows persisted on one job (a job may
#: carry several PDFs of up to MAX_PDF_PAGES pages each).
MAX_JOB_PAGE_DIAGNOSTICS = 500


@dataclass
class _SourceFile:
    document: SourceDocument
    extraction: pdf_text.PdfExtraction
    reused: bool


def _store_or_reuse_document(
    *,
    owner,
    project,
    upload: PdfUpload,
    role: str,
    subject,
    title: str,
    source_note: str,
    usage_scope: str,
) -> _SourceFile:
    """Reuse an identical file instead of storing a second copy of it."""
    content_type = (upload.content_type or "").lower()
    if content_type and content_type not in {"application/pdf", "application/x-pdf", "application/octet-stream"}:
        raise InvalidInput(
            message="仅支持 PDF 文件（原生文字版）",
            details={"content_type": content_type, "filename": upload.filename},
        )
    extraction = pdf_text.extract_native_text(upload.content)
    checksum = ingestion.file_checksum(upload.content)
    existing = ingestion.find_duplicate_document(project=project, checksum=checksum)
    if existing is not None:
        return _SourceFile(document=existing, extraction=extraction, reused=True)
    document = ingestion.create_pdf_document(
        owner=owner,
        project=project,
        content=upload.content,
        role=role,
        title=title or upload.filename,
        subject=subject,
        page_texts=[page.text for page in extraction.pages],
        source_note=source_note,
        usage_scope=usage_scope,
        sensitivity="contains_answers" if role == AssetRole.ANSWER_PAGE else "public_to_owner",
        original_filename=upload.filename,
    )
    return _SourceFile(document=document, extraction=extraction, reused=False)


def _unique_position_key(display_label: str, used: set[str], fallback_index: int) -> str:
    base = (display_label or "").strip() or str(fallback_index)
    candidate = base
    suffix = 2
    while candidate in used:
        candidate = f"{base}#{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate[:40]


@transaction.atomic
def start_pdf_import(
    *,
    owner,
    project,
    paper_files: list[PdfUpload],
    answer_files: list[PdfUpload] | None = None,
    subject=None,
    title: str = "",
    source_note: str = "",
    usage_scope: str = "",
    cycle_key: str = "",
    session_key: str = "",
    paper_code: str = "",
    source_kind: str = SourceKind.OFFICIAL_PAST,
    expected_session_count: int | None = None,
    paper_title: str = "",
) -> ImportJob:
    """Import born-digital paper PDFs (plus optional answer PDFs) as candidates.

    Everything mechanical happens here — extraction, page attribution, structure
    parsing and answer matching — and every step is recorded so a proofreader can
    check it against the original page. Publication stays a separate, explicit
    human act, and no step needs an AI provider.
    """
    answer_files = answer_files or []
    if not paper_files:
        raise InvalidInput(message="请至少上传一份试卷 PDF")
    if subject is not None and str(subject.project_id) != str(project.id):
        raise InvalidInput(message="科目不属于该项目")

    sources = _store_uploads(
        owner=owner,
        project=project,
        subject=subject,
        uploads=paper_files,
        role=AssetRole.PAST_PAPER_PAGE,
        title=title,
        source_note=source_note,
        usage_scope=usage_scope,
    )
    answer_sources = _store_uploads(
        owner=owner,
        project=project,
        subject=subject,
        uploads=answer_files,
        role=AssetRole.ANSWER_PAGE,
        title=f"{title}（答案）" if title else "",
        source_note=source_note,
        usage_scope=usage_scope,
    )

    job = ingestion.create_import_job(
        owner=owner,
        project=project,
        input_kind="pdf_text",
        subject=subject,
        documents=[source.document for source in [*sources, *answer_sources]],
        extractor_version=PDF_EXTRACTOR_VERSION,
    )
    job.status = ImportJobStatus.PROCESSING
    job.started_at = timezone.now()
    # The diagnosis is stored *before* any candidate is created: the candidate's
    # blocking layout issues are derived from it, so the guard cannot depend on a
    # later write that might not happen.
    job.page_diagnostics = _collect_page_diagnostics([*sources, *answer_sources])
    job.save(update_fields=["status", "started_at", "page_diagnostics", "updated_at"])

    revision = _prepare_paper_revision(
        owner=owner,
        job=job,
        subject=subject,
        cycle_key=cycle_key,
        session_key=session_key,
        paper_code=paper_code,
        source_kind=source_kind,
        expected_session_count=expected_session_count,
        covered_session_count=len(paper_files) if expected_session_count else None,
        title=paper_title or title,
    )
    answers = _collect_answer_entries(answer_sources)
    segments_by_source = _parse_paper_sources(sources)
    created, local_ids, match_counts = _create_candidates(
        job=job,
        segments_by_source=segments_by_source,
        answers=answers,
        subject=subject,
        revision=revision,
    )
    _link_material_parents(created, local_ids)
    if revision is not None:
        _annotate_paper_duplicates(job, created)
    _report_job_problems(
        job,
        sources=[*sources, *answer_sources],
        empty_pages=_empty_pages([*sources, *answer_sources]),
        created_count=len(created),
        answers=answers,
        match_counts=match_counts,
        segments_by_source=segments_by_source,
    )
    ingestion.maybe_complete_job(job)
    return job


def _store_uploads(
    *,
    owner,
    project,
    subject,
    uploads: list[PdfUpload],
    role: str,
    title: str,
    source_note: str,
    usage_scope: str,
) -> list[_SourceFile]:
    """Store (or reuse) one source document per uploaded PDF, in order."""
    stored: list[_SourceFile] = []
    for upload in uploads:
        stored.append(
            _store_or_reuse_document(
                owner=owner,
                project=project,
                upload=upload,
                role=role,
                subject=subject,
                title=title or upload.filename,
                source_note=source_note,
                usage_scope=usage_scope,
            )
        )
    return stored


def _parse_paper_sources(sources: list[_SourceFile]) -> list[tuple[_SourceFile, list[dict]]]:
    """Parse each paper PDF independently, keeping page offsets per document."""
    parsed: list[tuple[_SourceFile, list[dict]]] = []
    for source in sources:
        extraction = source.extraction
        text = extraction.text
        page_map = extraction.page_map()
        segments = text_parser.parse_paste(text, structure_only=True)
        text_parser.attach_source_pages(segments, text, page_map)
        # P2 batch 1: per-page spans (a question may occupy two pages), the
        # confirmed page-break joins, and the geometry of each span.
        text_parser.attach_cross_page_continua(
            segments,
            text,
            page_map,
            text_parser.detect_page_continuations(extraction.pages),
        )
        _attach_source_geometry(segments, extraction)
        for segment in segments:
            segment.setdefault("parse_issues", [])
        parsed.append((source, segments))
    return parsed


def _attach_source_geometry(segments: list[dict], extraction: pdf_text.PdfExtraction) -> None:
    """Give every segment span a locatable box, when geometry exists.

    The box is the union of the fragments that produced the stem on the page the
    question starts on, and of the fragments that produced each continuation span
    on the pages it runs onto. When the page has no usable geometry the span keeps
    ``bbox = None`` and the region falls back to the whole page — the character
    offsets still make it traceable, and nothing is invented.
    """
    pages_by_index = {page.page_index: page for page in extraction.pages}
    for segment in segments:
        stem = segment.get("source_excerpt") or ""
        for position, span in enumerate(segment.get("source_spans") or []):
            page = pages_by_index.get(int(span.get("page_index") or 0))
            if page is None:  # pragma: no cover - defensive: span outside the file
                continue
            # On the starting page the stem itself is the anchor; on a
            # continuation page the stem is not printed there, so the span's own
            # wording is what the fragments are matched against.
            needle = stem if position == 0 else (span.get("text") or "")
            span["bbox"] = pdf_text.bbox_for_text(page, needle)


def _create_candidates(
    *,
    job: ImportJob,
    segments_by_source: list[tuple[_SourceFile, list[dict]]],
    answers: dict,
    subject,
    revision,
) -> tuple[list[tuple[ImportCandidate, dict]], dict[str, ImportCandidate], dict]:
    """One proofreading candidate per parsed question, with its page and paper position."""
    used_positions: set[str] = set()
    running_index = 0
    created: list[tuple[ImportCandidate, dict]] = []
    local_ids: dict[str, ImportCandidate] = {}
    matched_answers = 0
    position_matched = 0

    for source, segments in segments_by_source:
        match_report = text_parser.apply_answer_matches(segments, answers["entries"])
        for segment, match in zip(segments, match_report["results"], strict=True):
            running_index += 1
            payload = dict(segment)
            answer_match: dict = {}
            if match.get("matched"):
                matched_answers += 1
                position_matched += 1 if match.get("method") == "position" else 0
                # A matched answer is a proposal: the proofreader must confirm it
                # before the candidate can be published.
                payload["answer_payload"] = match["answer_payload"]
                payload["answer_status_known"] = False
                payload.setdefault("parse_issues", []).append(
                    "答案来自答案页匹配（方式：{}，原文：{}），需人工确认".format(
                        "题号" if match.get("method") == "label" else "顺序", str(match.get("raw"))[:40]
                    )
                )
                answer_match = {
                    "matched": True,
                    "method": match.get("method"),
                    "label": match.get("label"),
                    "raw": match.get("raw"),
                    "source_page_index": match.get("source_page_index"),
                    "document_id": match.get("document_id"),
                    "document_title": match.get("document_title"),
                }
            region = _regions_for_segment(source.document, segment)
            candidate = ingestion.create_candidate(
                job=job,
                payload=payload,
                subject=subject,
                machine_payload=payload,
                regions=region,
                extractor_version=PDF_EXTRACTOR_VERSION,
                source_position_key=_unique_position_key(
                    str(segment.get("display_label") or ""), used_positions, running_index
                ),
                paper_revision=revision,
                answer_match=answer_match,
            )
            if segment.get("local_id"):
                local_ids[str(segment["local_id"])] = candidate
            created.append((candidate, segment))
    return (
        created,
        local_ids,
        {"matched": matched_answers, "position_matched": position_matched},
    )


def _regions_for_segment(document: SourceDocument, segment: dict) -> list:
    """The source regions of one parsed question: one per page it occupies.

    The first region is the page the question starts on and keeps the historic
    payload (the stem excerpt); a continuation adds one region per further page,
    so a question split across a page break is locatable on both pages while its
    position key still names the starting page (跨页题目归属到起始页).

    The bounding box comes from the fragment geometry when it exists and falls
    back to the whole page otherwise; the character offsets are always recorded.
    """
    excerpt = segment.get("source_excerpt") or ""
    spans = segment.get("source_spans") or [
        {
            "page_index": int(segment.get("source_page_index") or 1),
            "char_start": segment.get("source_char_start"),
            "char_end": segment.get("source_char_end"),
            "text": excerpt,
            "bbox": segment.get("source_bbox"),
        }
    ]
    regions = []
    for position, span in enumerate(spans):
        bbox = span.get("bbox") or {}
        text_span = excerpt if position == 0 else (span.get("text") or "")
        region = ingestion.create_source_region(
            document=document,
            page_index=int(span.get("page_index") or 1),
            x=float(bbox.get("x", 0.0)),
            y=float(bbox.get("y", 0.0)),
            width=float(bbox.get("width", 1.0)),
            height=float(bbox.get("height", 1.0)),
            role=AssetRole.PAST_PAPER_PAGE,
            text_span=(text_span or "")[:2000],
        )
        region.char_start = span.get("char_start")
        region.char_end = (
            span.get("char_end")
            if span.get("char_end") is not None
            else (region.char_start or 0) + len(text_span or "")
        )
        region.save(update_fields=["char_start", "char_end", "updated_at"])
        regions.append(region)
    return regions


def _link_material_parents(
    created: list[tuple[ImportCandidate, dict]], local_ids: dict[str, ImportCandidate]
) -> None:
    """Material parents/children come from the parsed structure, not retyping."""
    for candidate, segment in created:
        parent_local = segment.get("parent_local_id")
        if parent_local and parent_local in local_ids:
            candidate.parent_candidate = local_ids[parent_local]
            candidate.save(update_fields=["parent_candidate", "updated_at"])
            ingestion.refresh_candidate_issues(candidate)


def _collect_page_diagnostics(sources: list[_SourceFile]) -> list[dict]:
    """Per-page layout diagnosis of every uploaded PDF, tagged with its document.

    The document id is what lets a candidate be blocked by the page it actually
    came from instead of by the whole job: a scanned page in file A must not stop
    a clean page in file B from publishing.
    """
    rows: list[dict] = []
    for source in sources:
        for row in source.extraction.page_diagnostics:
            rows.append(
                {
                    **row,
                    "document_id": str(source.document.id),
                    "document_title": source.document.title,
                }
            )
            if len(rows) >= MAX_JOB_PAGE_DIAGNOSTICS:
                return rows
    return rows


def _page_labels(rows: list[dict], limit: int = 5) -> str:
    return "; ".join(
        f"{row.get('document_title') or 'PDF'} 第 {row.get('page_index')} 页" for row in rows[:limit]
    )


def _empty_pages(sources: list[_SourceFile]) -> list[dict]:
    report = []
    for source in sources:
        if source.extraction.empty_pages:
            report.append(
                {
                    "document_id": str(source.document.id),
                    "title": source.document.title,
                    "pages": source.extraction.empty_pages,
                }
            )
    return report


def _report_job_problems(
    job: ImportJob,
    *,
    sources: list[_SourceFile],
    empty_pages: list[dict],
    created_count: int,
    answers: dict,
    match_counts: dict,
    segments_by_source: list[tuple[_SourceFile, list[dict]]],
) -> None:
    """Every automatic step that a human has to know about, in plain language."""
    reused = sum(1 for source in sources if source.reused)
    if reused:
        ingestion.add_job_problem(
            job,
            "duplicate_source_file",
            f"其中 {reused} 份 PDF 与已有来源文件完全相同，已复用原来源而未新增副本"
            "（避免同一试卷被重复计入）。",
            severity="warning",
        )
    if empty_pages:
        ingestion.add_job_problem(
            job,
            "pdf_pages_without_text",
            "以下页面没有文字层（可能是插图页或扫描页），需要人工补齐："
            + "; ".join(f"{item['title']} 第 {item['pages']} 页" for item in empty_pages[:5]),
            severity="warning",
            pages=empty_pages[:20],
        )
    _report_layout_problems(job, page_diagnostics=job.page_diagnostics or [])
    matched = int(match_counts.get("matched") or 0)
    position_matched = int(match_counts.get("position_matched") or 0)
    if matched:
        ingestion.add_job_problem(
            job,
            "answers_matched",
            f"已从答案页匹配 {matched} 条答案（其中 {position_matched} 条按顺序匹配），"
            "都只是候选，必须逐条人工确认后才能发布。",
            severity="info" if not position_matched else "warning",
            matched=matched,
            position_matched=position_matched,
            unmatched_labels=_unmatched_answer_labels(segments_by_source, answers),
        )
    if answers["entries"] and not matched:
        ingestion.add_job_problem(
            job,
            "answers_not_matched",
            "答案页已解析出条目，但没有任何一条能匹配到题目；请在校对页手工填写。",
            severity="warning",
        )
    if not created_count:
        ingestion.add_job_problem(
            job,
            "no_recognised_segment",
            "未能从 PDF 文本层识别出题目结构：请确认使用的是原生文字 PDF，"
            "并在校对页按【题型】【题干】【选项】【答案】模板补录。",
            severity="warning",
        )


def _report_layout_problems(job: ImportJob, *, page_diagnostics: list[dict]) -> None:
    """Tell the proofreader which pages a human has to look at before publishing.

    These problems use the *same* codes as the blocking candidate issues, so the
    job payload and the candidate list cannot drift apart: a page reported here is
    exactly a page whose candidates stay blocked until the layout is confirmed.
    """
    reasons_by_page = [(row, set(row.get("reasons") or [])) for row in page_diagnostics]
    scanned = [row for row, reasons in reasons_by_page if layout.REASON_SCANNED in reasons]
    if scanned:
        ingestion.add_job_problem(
            job,
            layout.ISSUE_SCANNED,
            "以下页面没有文字层（扫描件/图片页）：本功能不做 OCR、不猜测内容，这些页面不会被自动结构化；"
            "请按原页人工录入，或改走图片导入的人工校对路径：" + _page_labels(scanned),
            severity="warning",
            pages=scanned[:20],
        )
    multi_column = [
        row
        for row, reasons in reasons_by_page
        if layout.REASON_MULTI_COLUMN in reasons
        or layout.REASON_COLUMN_ORDER_AMBIGUOUS in reasons
    ]
    if multi_column:
        ingestion.add_job_problem(
            job,
            layout.ISSUE_MULTI_COLUMN,
            f"{len(multi_column)} 页为多栏版式：栏内顺序无法完全确定时已保留提取顺序而未强行重排，"
            "相关候选必须人工确认版式后才能发布：" + _page_labels(multi_column),
            severity="warning",
            pages=multi_column[:20],
        )
    table_or_formula = [
        row
        for row, reasons in reasons_by_page
        if layout.REASON_TABLE_GRID in reasons or layout.REASON_FORMULA in reasons
    ]
    if table_or_formula:
        ingestion.add_job_problem(
            job,
            layout.ISSUE_TABLE_FORMULA,
            f"{len(table_or_formula)} 页含表格网格或公式符号：文本提取会改变版式，"
            "公式按原样保留、不做“纠正”，相关候选必须逐字人工确认后才能发布："
            + _page_labels(table_or_formula),
            severity="warning",
            pages=table_or_formula[:20],
        )


def _collect_answer_entries(answer_sources: list[_SourceFile]) -> dict:
    """Parse answer PDFs page by page so every matched answer keeps its page."""
    entries: list[dict] = []
    unparsed: list[str] = []
    for source in answer_sources:
        for page in source.extraction.pages:
            parsed = text_parser.parse_answer_page(page.text)
            for entry in parsed["entries"]:
                entries.append(
                    {
                        **entry,
                        "source_page_index": page.page_index,
                        "document_id": str(source.document.id),
                        "document_title": source.document.title,
                    }
                )
            unparsed.extend(parsed["unparsed"])
    return {"entries": entries, "unparsed": unparsed[:50]}


def _unmatched_answer_labels(segments_by_source, answers: dict) -> list[str]:
    labels = {
        str(segment.get("display_label"))
        for _source, segments in segments_by_source
        for segment in segments
    }
    return [str(entry.get("label")) for entry in answers["entries"] if str(entry.get("label")) not in labels][:50]


def _prepare_paper_revision(
    *,
    owner,
    job: ImportJob,
    subject,
    cycle_key: str,
    session_key: str,
    paper_code: str,
    source_kind: str,
    expected_session_count: int | None,
    covered_session_count: int | None,
    title: str,
):
    """Register/lookup the paper occurrence and open one draft revision."""
    from apps.exams.services import core as exam_services

    if subject is None or not cycle_key.strip() or not paper_code.strip():
        return None
    paper, _created = exam_services.get_or_create_paper(
        subject=subject,
        cycle_key=cycle_key,
        session_key=session_key,
        paper_code=paper_code,
        source_kind=source_kind,
        title=title,
        actor=owner,
    )
    return exam_services.create_paper_revision(
        paper,
        actor=owner,
        expected_session_count=expected_session_count,
        covered_session_count=covered_session_count,
        note=f"由原生文字 PDF 导入创建（导入任务 {job.id}）",
    )


def _annotate_paper_duplicates(job: ImportJob, created: list[tuple[ImportCandidate, dict]]) -> None:
    """Block publishing a paper position that an earlier revision already published."""
    duplicates = 0
    for candidate, _segment in created:
        issues = ingestion.refresh_candidate_issues(candidate)
        if any(issue.get("code") == "duplicate_paper_position" for issue in issues):
            duplicates += 1
    if duplicates:
        ingestion.add_job_problem(
            job,
            "duplicate_paper_positions",
            f"{duplicates} 个题号在该试卷的历史版本中已经发布过，已在候选上标为阻断项；"
            "重复导入不会再次发布（如需修订请在题库中创建新版本）。",
            severity="warning",
            count=duplicates,
        )
