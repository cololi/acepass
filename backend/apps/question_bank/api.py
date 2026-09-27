"""Question-bank API: question list/detail, drafts, publish/withdraw, mappings."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from ninja import Schema

from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.errors import InvalidInput, ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.question_bank import services
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion, RubricVersion

question_api_router = project_scoped_router(tags=["question-bank"])


class QuestionListItem(Schema):
    id: str
    subject_id: str
    display_label: str
    origin_type: str
    is_demo: bool
    question_type: str | None
    published_version_id: str | None
    latest_version: int | None
    has_trusted_answer: bool
    knowledge_nodes: list[str]


class OptionOut(Schema):
    id: str
    label: str


class QuestionPreviewOut(Schema):
    id: str
    version_id: str
    subject_id: str
    question_type: str
    display_label: str
    content: dict[str, Any]
    options: list[OptionOut]
    blank_ids: list[str]
    material_child_version_ids: list[str]
    practice_max_score: Decimal | None
    estimated_seconds: int | None


class VersionOut(Schema):
    id: str
    question_id: str
    version: int
    question_type: str
    status: str
    content: dict[str, Any]
    practice_max_score: Decimal | None
    estimated_seconds: int | None
    revision_reason: str
    published_at: str | None


class AnswerKeyOut(Schema):
    id: str
    version: int
    verification_status: str
    is_usable: bool
    source_type: str
    check_basis: str
    checked_at: str | None
    is_disputed: bool


class AnswerDetailOut(AnswerKeyOut):
    answer_payload: dict[str, Any]
    explanation_blocks: list[Any]
    rubric: dict[str, Any] | None


class DraftIn(Schema):
    question_type: str
    content: dict[str, Any]
    practice_max_score: Decimal | None = None
    estimated_seconds: int | None = None
    parent_material_version_id: str | None = None
    revision_reason: str = ""


class MappingIn(Schema):
    node_id: str
    is_primary: bool = True
    score_weight: Decimal = Decimal("1")
    template_id: str | None = None
    note: str = ""


class MappingOut(Schema):
    id: str
    mapping_revision: int
    node_id: str
    node_name: str
    is_primary: bool
    score_weight: Decimal
    template_id: str | None


class SourceRegionOut(Schema):
    id: str
    document_id: str
    page_index: int
    x: float
    y: float
    width: float
    height: float
    role: str
    crop_asset_id: str | None


@question_api_router.get("/projects/{project_id}/questions", auth=auth, response=list[QuestionListItem])
def list_questions(
    request,
    project_id: str,
    subject_id: str | None = None,
    question_type: str | None = None,
    status: str | None = None,
    origin_type: str | None = None,
    search: str | None = None,
    limit: int = 20,
    offset: int = 0,
):
    """Metadata only: never the stem text or the answer."""
    project = require_project(request.user, project_id)
    limit = max(1, min(limit, 100))
    queryset = Question.objects.filter(subject__project=project).select_related("subject")
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    if origin_type:
        queryset = queryset.filter(origin_type=origin_type)
    if search:
        queryset = queryset.filter(display_label__icontains=search.strip()[:60])
    if question_type or status:
        version_filter: dict[str, Any] = {}
        if question_type:
            version_filter["question_type"] = question_type
        if status:
            version_filter["status"] = status
        queryset = queryset.filter(versions__in=QuestionVersion.objects.filter(**version_filter)).distinct()
    items = []
    for question in queryset[offset : offset + limit]:
        published = question.current_published_version
        latest = question.versions.order_by("-version").first()
        answer = None
        if published is not None:
            answer = published.answer_keys.filter(is_disputed=False, verification_status="checked").first()
        items.append(
            {
                "id": str(question.id),
                "subject_id": str(question.subject_id),
                "display_label": question.display_label,
                "origin_type": question.origin_type,
                "is_demo": question.is_demo,
                "question_type": published.question_type if published else (latest.question_type if latest else None),
                "published_version_id": str(published.id) if published else None,
                "latest_version": latest.version if latest else None,
                "has_trusted_answer": answer is not None,
                "knowledge_nodes": [
                    mapping.node.canonical_name
                    for mapping in (published.knowledge_mappings.all() if published else [])
                    if mapping.is_primary
                ],
            }
        )
    return items


@question_api_router.get("/projects/{project_id}/questions/{question_id}", auth=auth, response=QuestionPreviewOut)
def get_question(request, project_id: str, question_id: str):
    """Metadata view of the current published version (no answers, no file URLs)."""
    from apps.practice.services import exposure

    project = require_project(request.user, project_id)
    question = Question.objects.filter(id=question_id, subject__project=project).select_related("subject").first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    version = question.current_published_version or question.versions.order_by("-version").first()
    if version is None:
        raise ScopeViolation(message="该题目尚无版本")
    exposure.record(
        user=request.user,
        project=project,
        question=question,
        question_version=version,
        kind="stem_delivered",
        purpose="preview",
        source="question_detail",
        reveals_answer=False,
    )
    return _preview(version, question)


def _preview(version: QuestionVersion, question: Question) -> dict:
    content = version.content or {}
    return {
        "id": str(question.id),
        "version_id": str(version.id),
        "subject_id": str(question.subject_id),
        "question_type": version.question_type,
        "display_label": question.display_label,
        "content": content,
        "options": [
            {"id": option.get("id"), "label": option.get("label") or option.get("id")}
            for option in content.get("options") or []
            if isinstance(option, dict)
        ],
        "blank_ids": [
            blank.get("blank_id") for blank in content.get("blanks") or [] if isinstance(blank, dict) and blank.get("blank_id")
        ],
        "material_child_version_ids": list(version.material_child_version_ids or []),
        "practice_max_score": version.practice_max_score,
        "estimated_seconds": version.estimated_seconds,
    }


def _version_out(version: QuestionVersion) -> dict:
    return {
        "id": str(version.id),
        "question_id": str(version.question_id),
        "version": version.version,
        "question_type": version.question_type,
        "status": version.status,
        "content": version.content,
        "practice_max_score": version.practice_max_score,
        "estimated_seconds": version.estimated_seconds,
        "revision_reason": version.revision_reason,
        "published_at": version.published_at.isoformat() if version.published_at else None,
    }


@question_api_router.post("/projects/{project_id}/questions/{question_id}/revisions", auth=auth, response={201: VersionOut})
def create_revision(request, project_id: str, question_id: str, payload: DraftIn):
    """New draft from a published question. Published content is never edited."""
    project = require_project(request.user, project_id)
    question = Question.objects.filter(id=question_id, subject__project=project).first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"questions.revision:{question_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    version = services.create_question_version_draft(
        question,
        question_type=payload.question_type,
        content=payload.content,
        practice_max_score=payload.practice_max_score,
        estimated_seconds=payload.estimated_seconds,
        parent_material_version_id=payload.parent_material_version_id,
        revision_reason=payload.revision_reason,
        actor=request.user,
    )
    result = _version_out(version)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="question_version", resource_id=version.id
    )
    return 201, result


@question_api_router.patch("/projects/{project_id}/question-versions/{version_id}", auth=auth, response=VersionOut)
def patch_version(request, project_id: str, version_id: str, payload: DraftIn):
    """Draft-only edit guarded by an explicit revision check."""
    project = require_project(request.user, project_id)
    version = QuestionVersion.objects.filter(id=version_id, question__subject__project=project).first()
    if version is None:
        raise ScopeViolation(message="题目版本不存在或不属于该项目")
    version = services.update_question_version_draft(
        version,
        question_type=payload.question_type,
        content=payload.content,
        practice_max_score=payload.practice_max_score,
        estimated_seconds=payload.estimated_seconds,
        actor=request.user,
    )
    return _version_out(version)


@question_api_router.post("/projects/{project_id}/question-versions/{version_id}/publish", auth=auth, response=VersionOut)
def publish_version(request, project_id: str, version_id: str):
    project = require_project(request.user, project_id)
    version = QuestionVersion.objects.filter(id=version_id, question__subject__project=project).first()
    if version is None:
        raise ScopeViolation(message="题目版本不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"versions.publish:{version_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    version = services.publish_question_version(version, actor=request.user)
    result = _version_out(version)
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="question_version", resource_id=version.id
    )
    outbox.after_commit_dispatch()
    return result


@question_api_router.post("/projects/{project_id}/question-versions/{version_id}/withdraw", auth=auth, response=VersionOut)
def withdraw_version(request, project_id: str, version_id: str, reason: str = ""):
    project = require_project(request.user, project_id)
    version = QuestionVersion.objects.filter(id=version_id, question__subject__project=project).first()
    if version is None:
        raise ScopeViolation(message="题目版本不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"versions.withdraw:{version_id}"
    replay = idempotency.claim(request.user, scope, key, {"reason": reason})
    if replay is not None:
        return replay.status_code, replay.body
    version = services.withdraw_question_version(version, actor=request.user, reason=reason)
    result = _version_out(version)
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="question_version", resource_id=version.id
    )
    outbox.after_commit_dispatch()
    return result


@question_api_router.get("/projects/{project_id}/questions/{question_id}/answer-keys", auth=auth, response=list[AnswerKeyOut])
def list_answer_keys(request, project_id: str, question_id: str):
    """Answer metadata only — the payload itself requires a reveal endpoint."""
    project = require_project(request.user, project_id)
    question = Question.objects.filter(id=question_id, subject__project=project).first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    rows = []
    for answer in AnswerKeyVersion.objects.filter(question_version__question=question).order_by("-version"):
        rows.append(
            {
                "id": str(answer.id),
                "version": answer.version,
                "verification_status": answer.verification_status,
                "is_usable": answer.is_usable,
                "source_type": answer.source_type,
                "check_basis": answer.check_basis,
                "checked_at": answer.checked_at.isoformat() if answer.checked_at else None,
                "is_disputed": answer.is_disputed,
            }
        )
    return rows


@question_api_router.get("/projects/{project_id}/questions/{question_id}/source-regions", auth=auth, response=list[SourceRegionOut])
def list_source_regions(request, project_id: str, question_id: str):
    project = require_project(request.user, project_id)
    question = Question.objects.filter(id=question_id, subject__project=project).first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    rows = []
    for version in question.versions.all():
        for link in version.source_links.select_related("region"):
            region = link.region
            rows.append(
                {
                    "id": str(region.id),
                    "document_id": str(region.document_id),
                    "page_index": region.page_index,
                    "x": region.x,
                    "y": region.y,
                    "width": region.width,
                    "height": region.height,
                    "role": link.role,
                    "crop_asset_id": str(region.crop_asset_id) if region.crop_asset_id else None,
                }
            )
    return rows


@question_api_router.get("/projects/{project_id}/question-versions/{version_id}/mappings", auth=auth, response=list[MappingOut])
def list_mappings(request, project_id: str, version_id: str, revision: int | None = None):
    project = require_project(request.user, project_id)
    version = QuestionVersion.objects.filter(id=version_id, question__subject__project=project).first()
    if version is None:
        raise ScopeViolation(message="题目版本不存在或不属于该项目")
    queryset = version.knowledge_mappings.select_related("node").order_by("mapping_revision", "node__canonical_name")
    if revision is not None:
        queryset = queryset.filter(mapping_revision=revision)
    return [
        {
            "id": str(mapping.id),
            "mapping_revision": mapping.mapping_revision,
            "node_id": str(mapping.node_id),
            "node_name": mapping.node.canonical_name,
            "is_primary": mapping.is_primary,
            "score_weight": mapping.score_weight,
            "template_id": str(mapping.template_id) if mapping.template_id else None,
        }
        for mapping in queryset
    ]


@question_api_router.post("/projects/{project_id}/question-versions/{version_id}/mappings", auth=auth, response={201: list[MappingOut]})
def replace_mappings(request, project_id: str, version_id: str, payload: list[MappingIn]):
    """Replace the mapping batch with a new revision (history is kept)."""
    project = require_project(request.user, project_id)
    version = QuestionVersion.objects.filter(id=version_id, question__subject__project=project).first()
    if version is None:
        raise ScopeViolation(message="题目版本不存在或不属于该项目")
    if not payload:
        raise InvalidInput(message="映射不能为空；未分类分值请显式映射到“未分类”节点")
    key = idempotency_key(request)
    scope = f"mappings.replace:{version_id}"
    body = [item.model_dump(mode="json") for item in payload]
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    mappings = services.replace_knowledge_mappings(
        version,
        [
            {
                "node_id": item.node_id,
                "is_primary": item.is_primary,
                "score_weight": item.score_weight,
                "template_id": item.template_id,
                "note": item.note,
            }
            for item in payload
        ],
        actor=request.user,
    )
    result = [
        {
            "id": str(mapping.id),
            "mapping_revision": mapping.mapping_revision,
            "node_id": str(mapping.node_id),
            "node_name": mapping.node.canonical_name,
            "is_primary": mapping.is_primary,
            "score_weight": mapping.score_weight,
            "template_id": str(mapping.template_id) if mapping.template_id else None,
        }
        for mapping in mappings
    ]
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="question_version", resource_id=version.id
    )
    return 201, result


@question_api_router.get("/projects/{project_id}/rubric-versions/{rubric_id}", auth=auth)
def get_rubric(request, project_id: str, rubric_id: str):
    project = require_project(request.user, project_id)
    rubric = RubricVersion.objects.filter(
        id=rubric_id, answer_key_version__question_version__question__subject__project=project
    ).first()
    if rubric is None:
        raise ScopeViolation(message="评分标准不存在或不属于该项目")
    return {
        "id": str(rubric.id),
        "criteria": rubric.criteria,
        "total_score": str(rubric.total_score),
        "usage_note": rubric.usage_note,
        "checked_at": rubric.checked_at.isoformat() if rubric.checked_at else None,
    }
