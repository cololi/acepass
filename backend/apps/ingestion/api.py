"""Ingestion API: private assets, imports, proofreading and publication."""

from __future__ import annotations

from typing import Any

from django.http import Http404, StreamingHttpResponse
from ninja import File, Form, Schema
from ninja.files import UploadedFile

from ai.providers import base as providers
from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.enums import AssetRole, SourceKind
from apps.common.errors import AiNotConfigured, DependencyUnavailable, InvalidInput, ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.exams.models import ExamSpecVersion
from apps.ingestion import services as ingestion_services
from apps.ingestion.models import ImportCandidate, ImportJob, SourceDocument
from apps.ingestion.services import access as asset_access
from apps.ingestion.services import imports as import_services
from apps.ingestion.services import text_parser
from apps.ingestion.services.core import (
    create_image_document,
    create_text_document,
    store_asset,
    validate_image,
)
from apps.ingestion.storage import get_storage
from apps.knowledge.models import KnowledgeNode
from apps.question_bank.models import QuestionVersion
from apps.question_bank.services import variants as variant_services

ingestion_router = project_scoped_router(tags=["ingestion"])


class AssetOut(Schema):
    id: str
    project_id: str
    role: str
    sensitivity: str
    content_type: str
    size_bytes: int
    width: int | None
    height: int | None
    checksum: str
    original_filename: str
    download_url: str


class TextImportIn(Schema):
    text: str
    subject_id: str | None = None
    title: str = ""
    source_note: str = ""
    usage_scope: str = ""
    parse: bool = True


class ImportJobOut(Schema):
    id: str
    project_id: str
    subject_id: str | None
    status: str
    input_kind: str
    progress_percent: int
    problems: list[dict[str, Any]]
    attempts: int
    max_attempts: int
    last_error: str
    extractor_version: str
    duplicate_of_job_id: str | None
    document_ids: list[str]
    candidate_count: int
    candidate_status_counts: dict[str, int]
    #: P2 batch 1: per-page layout diagnosis (added field, nothing renamed).
    page_diagnostics: list[dict[str, Any]] = []
    created_at: str


class CandidateRegionOut(Schema):
    id: str
    document_id: str
    page_index: int
    x: float
    y: float
    width: float
    height: float
    role: str
    text_span: str
    crop_asset_id: str | None
    # Declared explicitly: django-ninja serialises through the response model, so
    # a field the schema does not list never reaches the proofreading UI — the
    # page a candidate came from is part of "来源页可追溯", not decoration.
    document_asset_id: str | None = None
    document_title: str = ""
    document_type: str = ""


class CandidateOut(Schema):
    id: str
    job_id: str
    subject_id: str | None
    status: str
    revision: int
    review_issues: list[dict[str, Any]]
    is_stub_output: bool
    extractor_version: str
    draft_payload: dict[str, Any]
    machine_payload: dict[str, Any]
    source_regions: list[CandidateRegionOut]
    publication_question_id: str | None
    publication_version_id: str | None
    publication_paper_item_id: str | None = None
    #: Material parent/children parsed from the source (P1-01).
    parent_candidate_id: str | None = None
    child_candidate_ids: list[str] = []
    #: 卷面题号 inside the paper revision, and the revision it belongs to.
    source_position_key: str = ""
    paper_revision_id: str | None = None
    #: How an answer page was matched onto this candidate (proposal, not a key).
    answer_match: dict[str, Any] = {}
    #: P2 batch 1: the explicit layout confirmation that clears the blocking
    #: issues a suspicious source page (multi-column/table/formula/scan) raises.
    layout_review_confirmed_at: str | None = None
    layout_review_note: str = ""
    updated_at: str


class CandidatePatch(Schema):
    draft_payload: dict[str, Any] | None = None
    subject_id: str | None = None
    expected_revision: int | None = None
    note: str = ""


class CandidateLayoutConfirmIn(Schema):
    """Body of the layout confirmation; the note is what the human checked."""

    note: str = ""


class CandidatePublishIn(Schema):
    exam_spec_version_id: str | None = None
    node_ids: list[str] = []
    origin_type: str = "user_authored"
    display_label: str = ""


class SourceDocumentOut(Schema):
    id: str
    project_id: str
    subject_id: str | None
    title: str
    document_type: str
    role: str
    sensitivity: str
    source_type: str
    source_note: str
    usage_scope: str
    checksum: str
    asset_id: str | None
    raw_text_preview: str


class TextParseIn(Schema):
    text: str


# --------------------------------------------------------------------------
# P2 batch 2: AI-generated variants (acceptance C02)
# --------------------------------------------------------------------------
class VariantProposeIn(Schema):
    """Either the stable question or one explicit version may be the source."""

    source_question_id: str | None = None
    source_version_id: str | None = None
    node_id: str
    count: int = 1
    difficulty_note: str = ""


class VariantCandidateOut(Schema):
    candidate_id: str
    job_id: str
    status: str
    awaiting_human_review: bool
    question_type: str | None
    review_issues: list[dict[str, Any]]
    blocking_issues: list[dict[str, Any]]
    #: The model's answer is a proposal: publishing stays blocked until a human
    #: confirms it (the ordinary ``answer_status_known`` confirmation).
    answer_needs_confirmation: bool
    answer_source_type: str
    content_digest: str
    source_question_id: str
    source_version_id: str
    node_id: str
    llm_run_id: str
    is_stub_output: bool
    publication_question_id: str | None
    publication_version_id: str | None
    created_at: str


class VariantProposeOut(Schema):
    job_id: str
    job_status: str
    project_id: str
    subject_id: str
    source_question_id: str
    source_version_id: str
    node_id: str
    node_name: str
    provider: str
    model: str
    is_stub: bool
    prompt_version: str
    origin_type: str
    requested_count: int
    count: int
    count_capped: bool
    candidates: list[VariantCandidateOut]
    validation: dict[str, Any]
    nothing_passed: bool
    problems: list[dict[str, Any]]
    notes: list[str]


class VariantJobOut(Schema):
    job_id: str
    project_id: str
    subject_id: str | None
    status: str
    input_kind: str
    extractor_version: str
    progress_percent: int
    problems: list[dict[str, Any]]
    candidate_count: int
    candidate_status_counts: dict[str, int]
    candidates: list[VariantCandidateOut]
    created_at: str


class VariantListOut(Schema):
    count: int
    limit: int
    jobs: list[VariantJobOut]


def _asset_out(asset) -> dict:
    return {
        "id": str(asset.id),
        "project_id": str(asset.project_id),
        "role": asset.role,
        "sensitivity": asset.sensitivity,
        "content_type": asset.content_type,
        "size_bytes": asset.size_bytes,
        "width": asset.width,
        "height": asset.height,
        "checksum": asset.checksum,
        "original_filename": asset.original_filename,
        "download_url": f"/api/v1/projects/{asset.project_id}/assets/{asset.id}",
    }


def _document_out(document: SourceDocument) -> dict:
    return {
        "id": str(document.id),
        "project_id": str(document.project_id),
        "subject_id": str(document.subject_id) if document.subject_id else None,
        "title": document.title,
        "document_type": document.document_type,
        "role": document.role,
        "sensitivity": document.sensitivity,
        "source_type": document.source_type,
        "source_note": document.source_note,
        "usage_scope": document.usage_scope,
        "checksum": document.checksum,
        "asset_id": str(document.asset_id) if document.asset_id else None,
        "raw_text_preview": (document.raw_text or "")[:400],
    }


# --------------------------------------------------------------------------
# Assets
# --------------------------------------------------------------------------
@ingestion_router.post("/projects/{project_id}/assets", auth=auth, response={201: AssetOut})
def upload_asset(request, project_id: str, file: File[UploadedFile], role: str = Form(AssetRole.PAST_PAPER_PAGE)):
    """Upload one private asset. The storage path is always server-generated."""
    project = require_project(request.user, project_id)
    content = file.read()
    if not content:
        raise InvalidInput(message="上传内容为空")
    content_type = (file.content_type or "").lower()
    asset = store_asset(
        owner=request.user,
        project=project,
        content=content,
        content_type=content_type,
        role=role,
        original_filename=file.name or "",
    )
    return 201, _asset_out(asset)


@ingestion_router.get("/projects/{project_id}/assets/{asset_id}", auth=auth)
def download_asset(
    request, project_id: str, asset_id: str, purpose: str = "practice", session_item_id: str | None = None
):
    """Authenticated download; answer-bearing material is gated by purpose."""
    project = require_project(request.user, project_id)
    asset = asset_access.asset_scope(request.user, project, asset_id)
    session_item = None
    if session_item_id:
        from apps.practice.models import SessionItem

        session_item = (
            SessionItem.objects.filter(id=session_item_id, session__user=request.user, session__project=project)
            .select_related("session")
            .first()
        )
        if session_item is None:
            raise ScopeViolation(message="题项不存在或不属于该项目")
    asset_access.assert_asset_download_allowed(
        user=request.user,
        project=project,
        asset=asset,
        purpose=purpose,
        session=session_item.session if session_item else None,
    )
    storage = get_storage()
    if not storage.exists(asset.object_key):
        raise Http404("asset bytes are missing")
    asset_access.record_download_exposure(
        user=request.user, project=project, asset=asset, purpose=purpose, session_item=session_item
    )
    handle = storage.open(asset.object_key)
    response = StreamingHttpResponse(handle, content_type=asset.content_type)
    disposition = "inline" if asset.content_type.startswith("image/") else "attachment"
    response["Content-Disposition"] = f'{disposition}; filename="{asset.id}"'
    response["X-Content-Type-Options"] = "nosniff"
    response["Cache-Control"] = "private, no-store"
    return response


@ingestion_router.get("/projects/{project_id}/source-documents", auth=auth, response=list[SourceDocumentOut])
def list_source_documents(request, project_id: str, subject_id: str | None = None, limit: int = 50):
    project = require_project(request.user, project_id)
    queryset = SourceDocument.objects.filter(project=project, owner=request.user).order_by("-created_at")
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    return [_document_out(document) for document in queryset[: max(1, min(limit, 100))]]


@ingestion_router.post("/projects/{project_id}/source-documents/text", auth=auth, response={201: SourceDocumentOut})
def create_text_source(request, project_id: str, payload: TextImportIn):
    """Pasted text always creates a document keeping the raw original."""
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id) if payload.subject_id else None
    document = create_text_document(
        owner=request.user,
        project=project,
        text=payload.text,
        title=payload.title,
        subject=subject,
        source_note=payload.source_note,
        usage_scope=payload.usage_scope,
    )
    return 201, _document_out(document)


@ingestion_router.post("/projects/{project_id}/source-documents/image", auth=auth, response={201: SourceDocumentOut})
def create_image_source(
    request,
    project_id: str,
    file: File[UploadedFile],
    role: str = Form(AssetRole.PAST_PAPER_PAGE),
    title: str = Form(""),
    source_note: str = Form(""),
    usage_scope: str = Form(""),
    subject_id: str = Form(""),
):
    """Store an image source. Whole answer pages are marked as answer-bearing."""
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    content = file.read()
    if not content:
        raise InvalidInput(message="上传内容为空")
    if role not in AssetRole.values:
        raise InvalidInput(message="来源角色无效")
    sensitivity = "contains_answers" if role == AssetRole.ANSWER_PAGE else "public_to_owner"
    document = create_image_document(
        owner=request.user,
        project=project,
        content=content,
        content_type=(file.content_type or "").lower(),
        role=role,
        title=title,
        subject=subject,
        source_note=source_note,
        usage_scope=usage_scope,
        sensitivity=sensitivity,
        original_filename=file.name or "",
    )
    return 201, _document_out(document)


# --------------------------------------------------------------------------
# Imports
# --------------------------------------------------------------------------
@ingestion_router.post("/projects/{project_id}/imports/parse-text", auth=auth)
def parse_text_preview(request, project_id: str, payload: TextParseIn):
    """Preview the parsed structure without creating anything."""
    require_project(request.user, project_id)
    segments = text_parser.parse_paste(payload.text)
    return {"count": len(segments), "segments": segments}


@ingestion_router.post("/projects/{project_id}/imports", auth=auth, response={201: ImportJobOut})
def create_import(request, project_id: str, payload: TextImportIn):
    """Text import. Image imports use ``/imports/images``."""
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id) if payload.subject_id else None
    key = idempotency_key(request)
    scope = f"imports.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    segments = text_parser.parse_paste(payload.text) if payload.parse else []
    job = import_services.start_text_import(
        owner=request.user,
        project=project,
        text=payload.text,
        subject=subject,
        title=payload.title,
        source_note=payload.source_note,
        usage_scope=payload.usage_scope,
        segments=segments,
    )
    result = import_services.job_summary(job)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="import_job", resource_id=job.id
    )
    return 201, result


@ingestion_router.post("/projects/{project_id}/imports/images", auth=auth, response={201: ImportJobOut})
def create_image_import(
    request,
    project_id: str,
    files: list[UploadedFile] = File(...),
    subject_id: str = Form(""),
    title: str = Form(""),
    role: str = Form(AssetRole.PAST_PAPER_PAGE),
):
    """Store image material and open proofreading candidates.

    ``files`` must be declared as ``list[UploadedFile] = File(...)``. The earlier
    ``list[File[UploadedFile]]`` expands to ``list[Annotated[UploadedFile,
    File(...)]]``; django-ninja's automatic File detection then fails, the
    parameter is classified as a *body* field, and a real multipart upload is
    answered with HTTP 400 ``body.files Field required`` because the multipart
    body model only ever reads ``request.POST``.
    """
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    if not files:
        raise InvalidInput(message="请至少上传一张图片")
    contents = []
    for upload in files:
        content = upload.read()
        validate_image(content=content, content_type=(upload.content_type or "").lower())
        contents.append(content)
    checksums = [ingestion_services.file_checksum(content) for content in contents]
    key = idempotency_key(request)
    scope = f"imports.create_images:{project_id}"
    replay = idempotency.claim(
        request.user, scope, key, {"checksums": checksums, "subject_id": subject_id, "role": role}
    )
    if replay is not None:
        return replay.status_code, replay.body
    documents = []
    duplicates = []
    for upload, content, checksum in zip(files, contents, checksums, strict=True):
        existing = ingestion_services.find_duplicate_document(project=project, checksum=checksum)
        if existing is not None:
            duplicates.append(existing)
            continue
        documents.append(
            create_image_document(
                owner=request.user,
                project=project,
                content=content,
                content_type=(upload.content_type or "").lower(),
                role=role,
                title=title,
                subject=subject,
                sensitivity="contains_answers" if role == AssetRole.ANSWER_PAGE else "public_to_owner",
                original_filename=upload.name or "",
            )
        )
    job = import_services.start_image_import(
        owner=request.user, project=project, documents=documents or duplicates, subject=subject, title=title
    )
    if duplicates:
        ingestion_services.add_job_problem(
            job,
            "duplicate_source_file",
            f"其中 {len(duplicates)} 张图片与已有来源文件完全相同，已复用原来源而未新增（避免同一试卷重复统计）。",
            severity="warning",
        )
    result = import_services.job_summary(job)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="import_job", resource_id=job.id
    )
    # Kick the extraction tasks this import just enqueued. Without this the
    # `ingestion.extract_candidate` rows only move when the periodic scanner
    # runs, so "the vision chain is wired" was not observable from the API.
    outbox.after_commit_dispatch()
    return 201, result


@ingestion_router.post("/projects/{project_id}/imports/pdf", auth=auth, response={201: ImportJobOut})
def create_pdf_import(
    request,
    project_id: str,
    files: list[UploadedFile] = File(...),
    answer_files: list[UploadedFile] = File(default=[]),
    subject_id: str = Form(""),
    title: str = Form(""),
    source_note: str = Form(""),
    cycle_key: str = Form(""),
    session_key: str = Form(""),
    paper_code: str = Form(""),
    source_kind: str = Form(SourceKind.OFFICIAL_PAST),
    expected_session_count: int | None = Form(None),
    usage_scope: str = Form(""),
):
    """Batch-import born-digital paper PDFs (plus optional answer PDFs).

    The text layer is extracted deterministically — no model, no credentials. Each
    parsed question becomes a proofreading candidate that knows its source page,
    and answers printed on a separate PDF are matched onto those candidates as
    proposals only. ``files`` must be declared as ``list[UploadedFile]`` for the
    same reason as the image import (see ``create_image_import``).
    """
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    if not files:
        raise InvalidInput(message="请至少上传一份试卷 PDF")
    if source_kind not in SourceKind.values:
        raise InvalidInput(message="试卷来源类型无效", details={"source_kind": source_kind})
    paper_uploads = [
        import_services.PdfUpload(
            filename=upload.name or "paper.pdf",
            content=upload.read(),
            content_type=(upload.content_type or "application/pdf").lower(),
        )
        for upload in files
    ]
    answer_uploads = [
        import_services.PdfUpload(
            filename=upload.name or "answers.pdf",
            content=upload.read(),
            content_type=(upload.content_type or "application/pdf").lower(),
        )
        for upload in answer_files
    ]
    if source_kind == SourceKind.OFFICIAL_PAST and not cycle_key.strip():
        raise InvalidInput(message="真实考试试卷必须填写年份/周期与卷别代码，否则无法进入历年统计")
    key = idempotency_key(request)
    scope = f"imports.create_pdf:{project_id}"
    replay = idempotency.claim(
        request.user,
        scope,
        key,
        {
            "checksums": [ingestion_services.file_checksum(upload.content) for upload in [*paper_uploads, *answer_uploads]],
            "subject_id": subject_id,
            "cycle_key": cycle_key,
            "session_key": session_key,
            "paper_code": paper_code,
            "source_kind": source_kind,
        },
    )
    if replay is not None:
        return replay.status_code, replay.body
    job = import_services.start_pdf_import(
        owner=request.user,
        project=project,
        paper_files=paper_uploads,
        answer_files=answer_uploads,
        subject=subject,
        title=title,
        source_note=source_note,
        usage_scope=usage_scope,
        cycle_key=cycle_key,
        session_key=session_key,
        paper_code=paper_code,
        source_kind=source_kind,
        expected_session_count=expected_session_count,
        paper_title=title,
    )
    result = import_services.job_summary(job)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="import_job", resource_id=job.id
    )
    return 201, result


@ingestion_router.get("/projects/{project_id}/imports", auth=auth, response=list[ImportJobOut])
def list_imports(request, project_id: str, status: str | None = None, limit: int = 20):
    project = require_project(request.user, project_id)
    queryset = (
        ImportJob.objects.filter(project=project, created_by=request.user)
        # `job_summary` reads both collections; without the prefetch that is one
        # query per row for documents plus one for the candidate count/statuses.
        .prefetch_related("documents", "candidates")
        .order_by("-created_at")
    )
    if status:
        queryset = queryset.filter(status=status)
    return [import_services.job_summary(job) for job in queryset[: max(1, min(limit, 100))]]


@ingestion_router.get("/projects/{project_id}/imports/{job_id}", auth=auth, response=ImportJobOut)
def get_import(request, project_id: str, job_id: str):
    project = require_project(request.user, project_id)
    job = ImportJob.objects.filter(id=job_id, project=project, created_by=request.user).first()
    if job is None:
        raise ScopeViolation(message="导入任务不存在或不属于该项目")
    return import_services.job_summary(job)


@ingestion_router.post("/projects/{project_id}/imports/{job_id}/retry", auth=auth, response=ImportJobOut)
def retry_import(request, project_id: str, job_id: str):
    project = require_project(request.user, project_id)
    job = ImportJob.objects.filter(id=job_id, project=project, created_by=request.user).first()
    if job is None:
        raise ScopeViolation(message="导入任务不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"imports.retry:{job_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    job = import_services.retry_job(job, actor=request.user)
    result = import_services.job_summary(job)
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="import_job", resource_id=job.id
    )
    return result


@ingestion_router.get("/projects/{project_id}/import-candidates", auth=auth, response=list[CandidateOut])
def list_candidates(request, project_id: str, job_id: str | None = None, status: str | None = None, limit: int = 50):
    project = require_project(request.user, project_id)
    queryset = ImportCandidate.objects.filter(project=project, job__created_by=request.user).order_by("created_at")
    if job_id:
        queryset = queryset.filter(job_id=job_id)
    if status:
        queryset = queryset.filter(status=status)
    return [
        import_services.candidate_summary(candidate)
        for candidate in queryset.select_related("job").prefetch_related(
            *import_services.candidate_prefetch()
        )[: max(1, min(limit, 100))]
    ]


@ingestion_router.get("/projects/{project_id}/import-candidates/{candidate_id}", auth=auth, response=CandidateOut)
def get_candidate(request, project_id: str, candidate_id: str):
    project = require_project(request.user, project_id)
    candidate = ImportCandidate.objects.filter(id=candidate_id, project=project, job__created_by=request.user).first()
    if candidate is None:
        raise ScopeViolation(message="候选不存在或不属于该项目")
    _record_editorial_preview(candidate, request.user, source="ingestion.candidate_detail")
    return import_services.candidate_summary(candidate)


def _record_editorial_preview(candidate: ImportCandidate, actor, *, source: str) -> None:
    """Proofreading published content is an exposure (C04 source 1).

    A re-import candidate linked to an already published question shows the
    proofreader that question's answer, so opening or editing it must make the
    question permanently ineligible for *strictly independent* evidence. The rule
    itself lives in ``apps.learning.services.contamination``; this is only the
    call site, and it stays silent while the candidate is not linked to a
    question (nothing published has been looked at yet).
    """
    if not candidate.publication_question_id:
        return
    from apps.learning.services import contamination
    from apps.question_bank.models import Question

    question = Question.objects.filter(id=candidate.publication_question_id).first()
    if question is None:  # pragma: no cover - defensive: the link is written at publish time
        return
    contamination.record_editorial_preview(
        question=question,
        actor=actor,
        source=source,
        candidate=candidate,
        project=candidate.project,
    )


@ingestion_router.patch("/projects/{project_id}/import-candidates/{candidate_id}", auth=auth, response=CandidateOut)
def patch_candidate(request, project_id: str, candidate_id: str, payload: CandidatePatch):
    project = require_project(request.user, project_id)
    candidate = ImportCandidate.objects.filter(id=candidate_id, project=project, job__created_by=request.user).first()
    if candidate is None:
        raise ScopeViolation(message="候选不存在或不属于该项目")
    subject = require_subject(request.user, project, payload.subject_id) if payload.subject_id else None
    _record_editorial_preview(candidate, request.user, source="ingestion.candidate_edit")
    candidate = ingestion_services.update_candidate(
        candidate,
        payload=payload.draft_payload,
        subject=subject,
        expected_revision=payload.expected_revision,
        actor=request.user,
        note=payload.note,
    )
    return import_services.candidate_summary(candidate)


@ingestion_router.post("/projects/{project_id}/import-candidates/{candidate_id}/ignore", auth=auth, response=CandidateOut)
def ignore_candidate(request, project_id: str, candidate_id: str, reason: str = ""):
    project = require_project(request.user, project_id)
    candidate = ImportCandidate.objects.filter(id=candidate_id, project=project, job__created_by=request.user).first()
    if candidate is None:
        raise ScopeViolation(message="候选不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"candidates.ignore:{candidate_id}"
    replay = idempotency.claim(request.user, scope, key, {"reason": reason})
    if replay is not None:
        return replay.status_code, replay.body
    candidate = ingestion_services.ignore_candidate(candidate, actor=request.user, reason=reason)
    result = import_services.candidate_summary(candidate)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="import_candidate",
        resource_id=candidate.id,
    )
    return result


@ingestion_router.post(
    "/projects/{project_id}/import-candidates/{candidate_id}/layout-confirm",
    auth=auth,
    response=CandidateOut,
)
def confirm_candidate_layout(
    request, project_id: str, candidate_id: str, payload: CandidateLayoutConfirmIn
):
    """Confirm the layout of the pages a candidate came from (P2 batch 1).

    Multi-column order, table/formula wording and scanned pages are reported as
    *blocking* issues on the candidate; publishing stays the single gate, so this
    explicit human action is what makes such a candidate publishable. The note
    records what the proofreader compared against the original page.
    """
    project = require_project(request.user, project_id)
    candidate = ImportCandidate.objects.filter(id=candidate_id, project=project, job__created_by=request.user).first()
    if candidate is None:
        raise ScopeViolation(message="候选不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"candidates.layout_confirm:{candidate_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    candidate = ingestion_services.confirm_layout_review(
        candidate, actor=request.user, note=payload.note
    )
    result = import_services.candidate_summary(candidate)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="import_candidate",
        resource_id=candidate.id,
    )
    return result


@ingestion_router.post("/projects/{project_id}/import-candidates/{candidate_id}/publish", auth=auth, response=CandidateOut)
def publish_candidate(request, project_id: str, candidate_id: str, payload: CandidatePublishIn):
    """Publish a proofread candidate into an immutable question version."""
    project = require_project(request.user, project_id)
    candidate = ImportCandidate.objects.filter(id=candidate_id, project=project, job__created_by=request.user).first()
    if candidate is None:
        raise ScopeViolation(message="候选不存在或不属于该项目")
    spec = None
    if payload.exam_spec_version_id:
        spec = ExamSpecVersion.objects.filter(id=payload.exam_spec_version_id, subject__project=project).first()
        if spec is None:
            raise ScopeViolation(message="考试规范版本不存在或不属于该项目")
        if spec.status != "published":
            raise InvalidInput(message="只能使用已发布的考试规范版本")
    key = idempotency_key(request)
    scope = f"candidates.publish:{candidate_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    candidate, question = ingestion_services.publish_candidate(
        candidate,
        actor=request.user,
        exam_spec_version=spec,
        node_ids=payload.node_ids,
        origin_type=payload.origin_type,
        display_label=payload.display_label,
    )
    result = import_services.candidate_summary(candidate)
    result["question_id"] = str(question.id)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="import_candidate",
        resource_id=candidate.id,
    )
    outbox.after_commit_dispatch()
    return result


# --------------------------------------------------------------------------
# P2 batch 2: AI-generated variants (acceptance C02)
# --------------------------------------------------------------------------
def _raise_ai_error(exc: providers.AiError, *, action: str) -> None:
    """Map provider failures the way the rest of the product does.

    Mirrors the helper in ``apps/practice/api.py``: a missing capability is
    "AI not configured" (503) and anything else the provider raised is a
    dependency failure (503) — never a fabricated result.
    """
    if isinstance(exc, providers.AiUnavailable):
        raise AiNotConfigured(
            message=f"{action}需要配置 AI 能力：{exc}", details={"error_code": exc.code}
        ) from exc
    raise DependencyUnavailable(message=f"{action}失败：{exc}", details={"error_code": exc.code}) from exc


def _variant_source_version(user, project, payload: VariantProposeIn) -> QuestionVersion:
    """Owner-scoped source version; a foreign or unknown id is a 404."""
    queryset = QuestionVersion.objects.filter(question__subject__project=project).select_related(
        "question__subject"
    )
    if payload.source_version_id:
        version = queryset.filter(id=payload.source_version_id).first()
    else:
        version = (
            queryset.filter(question_id=payload.source_question_id, status="published")
            .order_by("-version")
            .first()
        )
    if version is None:
        raise ScopeViolation(message="源题目版本不存在或不属于该项目")
    return version


@ingestion_router.post(
    "/projects/{project_id}/variants/propose", auth=auth, response={201: VariantProposeOut}
)
def propose_variants(request, project_id: str, payload: VariantProposeIn):
    """Propose AI variants of one question as reviewable candidates (C02).

    The response contains candidates and their problems — never published
    content. Publishing stays the ordinary human gate
    (``…/import-candidates/{id}/publish``); there is deliberately no second path.
    """
    project = require_project(request.user, project_id)
    if not payload.source_question_id and not payload.source_version_id:
        raise InvalidInput(message="必须提供 source_question_id 或 source_version_id")
    if payload.count < 1:
        raise InvalidInput(message="count 必须至少为 1")
    version = _variant_source_version(request.user, project, payload)
    node = (
        KnowledgeNode.objects.filter(id=payload.node_id, syllabus_version__subject__project=project)
        .select_related("syllabus_version__subject")
        .first()
    )
    if node is None:
        raise ScopeViolation(message="考点不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"variants.propose:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    try:
        result = variant_services.propose_variants(
            project=project,
            source_version=version,
            node=node,
            actor=request.user,
            count=payload.count,
            difficulty_note=payload.difficulty_note,
        )
    except providers.AiError as exc:
        _raise_ai_error(exc, action="生成变式")
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="import_job",
        resource_id=result["job_id"],
    )
    return 201, result


@ingestion_router.get("/projects/{project_id}/variants", auth=auth, response=VariantListOut)
def list_variants(request, project_id: str, limit: int = 20):
    """Variant batches of this project and their candidates, newest first."""
    project = require_project(request.user, project_id)
    bounded = max(1, min(int(limit), 50))
    jobs = variant_services.variant_jobs(project=project, user=request.user, limit=bounded)
    return {"count": len(jobs), "limit": bounded, "jobs": jobs}
