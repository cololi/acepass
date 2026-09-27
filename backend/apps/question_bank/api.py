"""Question-bank API: question list/detail, drafts, publish/withdraw, mappings.

P2/C03 additions (all owner-scoped, all additive): sealing a question or a family,
listing what is sealed and why, and the family surface (list/create/patch, adding
and removing a member, merge preview and merge). Every sealing decision goes
through :mod:`apps.question_bank.services.sealing`; family membership and merging
go through :mod:`apps.question_bank.services.families`.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from ninja import Schema

from apps.audit.services import idempotency, outbox
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.errors import InvalidInput, ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.question_bank import services
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionFamily, QuestionVersion, RubricVersion
from apps.question_bank.services import families as family_services
from apps.question_bank.services import sealing

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


class ReasonIn(Schema):
    reason: str = ""


class SealOut(Schema):
    policy_id: str
    target: str
    question_id: str | None
    family_id: str | None
    revision: int
    is_holdout: bool
    change_reason: str
    changed_at: str
    sealed: bool
    sealed_reason: str
    sealed_question_ids: list[str]


class SealedContentOut(Schema):
    project_id: str
    questions: list[dict[str, Any]]
    families: list[dict[str, Any]]
    counts: dict[str, int]
    reason_codes: list[str]
    generated_at: str


class FamilyOut(Schema):
    id: str
    subject_id: str
    name: str
    revision: int
    relation_confirmed: bool
    note: str
    member_count: int
    sealed: bool
    sealed_reason: str
    sealed_member_count: int
    merged_into_id: str | None
    merged_at: str | None


class FamilyIn(Schema):
    subject_id: str
    name: str
    note: str = ""


class FamilyPatchIn(Schema):
    name: str | None = None
    relation_confirmed: bool | None = None
    note: str | None = None


class FamilyQuestionIn(Schema):
    question_id: str


class FamilyQuestionOut(Schema):
    family_id: str
    question_id: str
    changed: bool
    member_count: int
    sealed: bool
    sealed_reason: str


class MergeImpactOut(Schema):
    project_id: str
    source_family_id: str
    target_family_id: str
    source_family_name: str
    target_family_name: str
    already_merged: bool
    questions_to_move: int
    questions_in_target_after: int
    evidence_rows_to_invalidate: int
    affected_user_ids: list[str]
    exposed_before_merge: int
    exposed_after_merge: int
    exposed_question_ids_before_merge: list[str]


class MergeIn(Schema):
    target_family_id: str
    reason: str = ""


class MergeOut(Schema):
    project_id: str
    source_family_id: str
    target_family_id: str
    merge_revision: int
    questions_moved: int
    questions_in_target_after: int
    evidence_invalidated: int
    states_recomputed: int
    exposed_before_merge: int
    exposed_after_merge: int
    exposure_changes: list[dict[str, Any]]
    affected_user_ids: list[str]
    noop: bool
    content_revision_id: str | None


def _question_scope(project, question_id: str) -> Question:
    question = Question.objects.filter(id=question_id, subject__project=project).select_related("subject").first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    return question


def _family_scope(project, family_id: str) -> QuestionFamily:
    family = (
        QuestionFamily.objects.filter(id=family_id, subject__project=project).select_related("subject").first()
    )
    if family is None:
        raise ScopeViolation(message="题族不存在或不属于该项目")
    return family


def _seal_out(*, policy, project) -> dict[str, Any]:
    """Report what the new policy revision means *now*, through the resolver."""
    if policy.question_id:
        target_question_ids = [str(policy.question_id)]
    else:
        target_question_ids = [
            str(value)
            for value in Question.objects.filter(family_id=policy.family_id).values_list("id", flat=True)
        ]
    sealed_ids = sorted(sealing.sealed_question_ids(project=project, question_ids=target_question_ids))
    sealed_reason = ""
    if sealed_ids:
        sealed_reason = sealing.is_sealed(
            Question.objects.filter(id=sealed_ids[0]).first(), project=project
        )[1]
    return {
        "policy_id": str(policy.id),
        "target": "question" if policy.question_id else "family",
        "question_id": str(policy.question_id) if policy.question_id else None,
        "family_id": str(policy.family_id) if policy.family_id else None,
        "revision": policy.revision,
        "is_holdout": policy.is_holdout,
        "change_reason": policy.change_reason,
        "changed_at": policy.created_at.isoformat(),
        "sealed": bool(sealed_ids),
        "sealed_reason": sealed_reason,
        "sealed_question_ids": sealed_ids,
    }


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
    """Metadata view of the current published version (no answers, no file URLs).

    C03: sealed content is not previewable. The stem is the sealed content, and
    this endpoint would both deliver it and log a ``stem_delivered`` exposure, so
    it refuses with the sealing reason instead.
    """
    from apps.practice.services import exposure

    project = require_project(request.user, project_id)
    question = Question.objects.filter(id=question_id, subject__project=project).select_related("subject").first()
    if question is None:
        raise ScopeViolation(message="题目不存在或不属于该项目")
    sealing.assert_not_sealed(question=question, project=project, action="题库预览")
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


# --------------------------------------------------------------------------
# P2 / C03: sealing, sealed-content inventory and the family surface
# --------------------------------------------------------------------------
@question_api_router.post("/projects/{project_id}/questions/{question_id}/seal", auth=auth, response={201: SealOut})
def seal_question(request, project_id: str, question_id: str, payload: ReasonIn):
    """Seal one question by appending a new policy revision (never an edit)."""
    project = require_project(request.user, project_id)
    question = _question_scope(project, question_id)
    policy = sealing.seal_question(project=project, question=question, actor=request.user, reason=payload.reason)
    return 201, _seal_out(policy=policy, project=project)


@question_api_router.post("/projects/{project_id}/questions/{question_id}/unseal", auth=auth, response={201: SealOut})
def unseal_question(request, project_id: str, question_id: str, payload: ReasonIn):
    """Clear the holdout for one question with a new policy revision."""
    project = require_project(request.user, project_id)
    question = _question_scope(project, question_id)
    policy = sealing.unseal(project=project, question=question, actor=request.user, reason=payload.reason)
    return 201, _seal_out(policy=policy, project=project)


@question_api_router.post(
    "/projects/{project_id}/question-families/{family_id}/seal", auth=auth, response={201: SealOut}
)
def seal_family(request, project_id: str, family_id: str, payload: ReasonIn):
    """Seal a whole family: every member is sealed through the resolver."""
    project = require_project(request.user, project_id)
    family = _family_scope(project, family_id)
    policy = sealing.seal_family(project=project, family=family, actor=request.user, reason=payload.reason)
    return 201, _seal_out(policy=policy, project=project)


@question_api_router.post(
    "/projects/{project_id}/question-families/{family_id}/unseal", auth=auth, response={201: SealOut}
)
def unseal_family(request, project_id: str, family_id: str, payload: ReasonIn):
    """Clear a family's holdout; members sealed on their own stay sealed."""
    project = require_project(request.user, project_id)
    family = _family_scope(project, family_id)
    policy = sealing.unseal(project=project, family=family, actor=request.user, reason=payload.reason)
    return 201, _seal_out(policy=policy, project=project)


@question_api_router.get("/projects/{project_id}/sealed-content", auth=auth, response=SealedContentOut)
def list_sealed_content(request, project_id: str):
    """What is sealed in this project, and which policy revision sealed it."""
    project = require_project(request.user, project_id)
    return sealing.sealed_content_report(project=project)


# --------------------------------------------------------------------------
# Family surface: list / create / patch, membership, merge preview and merge
# --------------------------------------------------------------------------
@question_api_router.get("/projects/{project_id}/question-families", auth=auth, response=list[FamilyOut])
def list_question_families(request, project_id: str, subject_id: str | None = None):
    project = require_project(request.user, project_id)
    queryset = QuestionFamily.objects.filter(subject__project=project).select_related("subject")
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    return [
        family_services.family_payload(project=project, family=family)
        for family in queryset.order_by("subject__display_order", "name")
    ]


@question_api_router.post("/projects/{project_id}/question-families", auth=auth, response={201: FamilyOut})
def create_question_family(request, project_id: str, payload: FamilyIn):
    """Create one family. Names are unique per subject."""
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id)
    key = idempotency_key(request)
    scope = f"question_families.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    family = family_services.create_family(
        project=project, subject=subject, name=payload.name, note=payload.note, actor=request.user
    )
    result = family_services.family_payload(project=project, family=family)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="question_family", resource_id=family.id
    )
    return 201, result


@question_api_router.patch(
    "/projects/{project_id}/question-families/{family_id}", auth=auth, response=FamilyOut
)
def patch_question_family(request, project_id: str, family_id: str, payload: FamilyPatchIn):
    """Rename / confirm the near-duplicate relation / annotate one family."""
    project = require_project(request.user, project_id)
    family = _family_scope(project, family_id)
    family = family_services.update_family(
        project=project,
        family=family,
        actor=request.user,
        name=payload.name,
        relation_confirmed=payload.relation_confirmed,
        note=payload.note,
    )
    return family_services.family_payload(project=project, family=family)


@question_api_router.post(
    "/projects/{project_id}/question-families/{family_id}/questions",
    auth=auth,
    response={201: FamilyQuestionOut},
)
def add_question_to_family(request, project_id: str, family_id: str, payload: FamilyQuestionIn):
    """Put one question into a family (refused for sealed content)."""
    project = require_project(request.user, project_id)
    family = _family_scope(project, family_id)
    question = _question_scope(project, payload.question_id)
    key = idempotency_key(request)
    scope = f"question_families.add:{family_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    question, changed = family_services.add_question_to_family(
        project=project, family=family, question=question, actor=request.user
    )
    result = _family_question_out(project=project, family=family, question=question, changed=changed)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="question_family", resource_id=family.id
    )
    return 201, result


@question_api_router.delete(
    "/projects/{project_id}/question-families/{family_id}/questions/{question_id}",
    auth=auth,
    response=FamilyQuestionOut,
)
def remove_question_from_family(request, project_id: str, family_id: str, question_id: str):
    """Move one question out of a family (back to "no family")."""
    project = require_project(request.user, project_id)
    family = _family_scope(project, family_id)
    question = _question_scope(project, question_id)
    question, changed = family_services.remove_question_from_family(
        project=project, family=family, question=question, actor=request.user
    )
    return _family_question_out(project=project, family=family, question=question, changed=changed)


def _family_question_out(*, project, family: QuestionFamily, question: Question, changed: bool) -> dict[str, Any]:
    payload = family_services.family_payload(project=project, family=family)
    return {
        "family_id": str(family.id),
        "question_id": str(question.id),
        "changed": changed,
        "member_count": payload["member_count"],
        "sealed": payload["sealed"],
        "sealed_reason": payload["sealed_reason"],
    }


@question_api_router.get(
    "/projects/{project_id}/question-families/{family_id}/merge-impact",
    auth=auth,
    response=MergeImpactOut,
)
def question_family_merge_impact(request, project_id: str, family_id: str, target_family_id: str):
    """Preview a merge: how many questions move, how much evidence goes stale."""
    project = require_project(request.user, project_id)
    source_family = _family_scope(project, family_id)
    target_family = _family_scope(project, target_family_id)
    return family_services.merge_impact(
        project=project, source_family=source_family, target_family=target_family
    )


@question_api_router.post(
    "/projects/{project_id}/question-families/{family_id}/merge", auth=auth, response={201: MergeOut}
)
def merge_question_family(request, project_id: str, family_id: str, payload: MergeIn):
    """Merge one family into another (Idempotency-Key required).

    Re-checks old exposure, invalidates the evidence that relied on family
    distinctness and recomputes the affected knowledge states; repeating the same
    merge is a no-op.
    """
    project = require_project(request.user, project_id)
    source_family = _family_scope(project, family_id)
    target_family = _family_scope(project, payload.target_family_id)
    key = idempotency_key(request)
    scope = f"question_families.merge:{family_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    result = family_services.merge_families(
        project=project,
        source_family=source_family,
        target_family=target_family,
        actor=request.user,
        reason=payload.reason,
    )
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="question_family",
        resource_id=target_family.id,
    )
    outbox.after_commit_dispatch()
    return 201, result
