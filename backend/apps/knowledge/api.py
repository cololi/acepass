"""Knowledge API: syllabus nodes, templates, mappings and verification pairings."""

from __future__ import annotations

from typing import Any

from ninja import Schema

from apps.audit.services import idempotency
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.errors import InvalidInput, ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.exams.models import SyllabusVersion
from apps.knowledge import services
from apps.knowledge.models import KnowledgeNode, QuestionTemplate, VerificationPairing
from apps.knowledge.services import outline as outline_services
from apps.question_bank.models import Question

knowledge_router = project_scoped_router(tags=["knowledge"])


class NodeIn(Schema):
    syllabus_version_id: str
    canonical_name: str
    kind: str = "point"
    parent_id: str | None = None
    code: str = ""
    aliases: list[str] = []
    is_unclassified: bool = False
    display_order: int = 0


class NodeOut(Schema):
    id: str
    syllabus_version_id: str
    parent_id: str | None
    kind: str
    canonical_name: str
    code: str
    aliases: list[str]
    is_unclassified: bool
    display_order: int
    question_count: int


class OutlineIn(Schema):
    text: str
    #: Depth (0 = chapter) → node kind overrides; defaults: 0 chapter, 1 section.
    kind_by_depth: dict[str, str] = {}


class OutlineOut(Schema):
    created: int
    merged: int
    aliases_added: list[dict]
    skipped: list[dict]
    node_count: int


class NodePatch(Schema):
    canonical_name: str | None = None
    aliases: list[str] | None = None
    parent_id: str | None = None
    #: Setting a parent (including null for the root) is an explicit move.
    move: bool = False


class TemplateIn(Schema):
    subject_id: str
    name: str
    description: str = ""


class TemplateOut(Schema):
    id: str
    subject_id: str
    name: str
    description: str
    review_status: str


class PairingIn(Schema):
    subject_id: str
    node_id: str
    immediate_question_id: str
    delayed_question_id: str | None = None
    baseline_question_id: str | None = None
    delay_hours: int = 24
    note: str = ""


class PairingOut(Schema):
    id: str
    project_id: str
    subject_id: str
    node_id: str
    node_name: str
    baseline_question_id: str | None
    immediate_question_id: str
    delayed_question_id: str | None
    pairing_version: int
    delay_hours: int
    is_active: bool
    reviewed_at: str | None
    note: str
    gap: str


def _node_out(node: KnowledgeNode) -> dict:
    return {
        "id": str(node.id),
        "syllabus_version_id": str(node.syllabus_version_id),
        "parent_id": str(node.parent_id) if node.parent_id else None,
        "kind": node.kind,
        "canonical_name": node.canonical_name,
        "code": node.code,
        "aliases": node.aliases or [],
        "is_unclassified": node.is_unclassified,
        "display_order": node.display_order,
        "question_count": node.question_mappings.filter(is_primary=True).count(),
    }


def _pairing_out(pairing: VerificationPairing) -> dict:
    gap = ""
    if pairing.delayed_question_id is None:
        gap = "缺少延迟验证题（C 题）：到期后只能用原题重复练习，不计入延迟验证证据"
    return {
        "id": str(pairing.id),
        "project_id": str(pairing.project_id),
        "subject_id": str(pairing.subject_id),
        "node_id": str(pairing.node_id),
        "node_name": pairing.node.canonical_name,
        "baseline_question_id": str(pairing.baseline_question_id) if pairing.baseline_question_id else None,
        "immediate_question_id": str(pairing.immediate_question_id),
        "delayed_question_id": str(pairing.delayed_question_id) if pairing.delayed_question_id else None,
        "pairing_version": pairing.pairing_version,
        "delay_hours": pairing.delay_hours,
        "is_active": pairing.is_active,
        "reviewed_at": pairing.reviewed_at.isoformat() if pairing.reviewed_at else None,
        "note": pairing.note,
        "gap": gap,
    }


@knowledge_router.get("/projects/{project_id}/knowledge-nodes", auth=auth, response=list[NodeOut])
def list_nodes(request, project_id: str, syllabus_version_id: str | None = None, subject_id: str | None = None):
    project = require_project(request.user, project_id)
    queryset = KnowledgeNode.objects.filter(syllabus_version__subject__project=project).select_related(
        "syllabus_version"
    )
    if syllabus_version_id:
        queryset = queryset.filter(syllabus_version_id=syllabus_version_id)
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(syllabus_version__subject_id=subject_id)
    return [_node_out(node) for node in queryset]


@knowledge_router.post("/projects/{project_id}/knowledge-nodes", auth=auth, response={201: NodeOut})
def create_node(request, project_id: str, payload: NodeIn):
    project = require_project(request.user, project_id)
    syllabus = SyllabusVersion.objects.filter(id=payload.syllabus_version_id, subject__project=project).first()
    if syllabus is None:
        raise ScopeViolation(message="大纲版本不存在或不属于该项目")
    if syllabus.status != "published":
        raise InvalidInput(message="只能向已发布的大纲版本添加考点；请先发布大纲")
    parent = None
    if payload.parent_id:
        parent = KnowledgeNode.objects.filter(id=payload.parent_id, syllabus_version=syllabus).first()
        if parent is None:
            raise ScopeViolation(message="父考点不存在或不属于该大纲版本")
    key = idempotency_key(request)
    scope = f"nodes.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    node = services.create_knowledge_node(
        syllabus_version=syllabus,
        canonical_name=payload.canonical_name,
        kind=payload.kind,
        parent=parent,
        code=payload.code,
        aliases=payload.aliases,
        is_unclassified=payload.is_unclassified,
        display_order=payload.display_order,
    )
    result = _node_out(node)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="knowledge_node",
        resource_id=node.id,
    )
    return 201, result


@knowledge_router.get("/projects/{project_id}/question-templates", auth=auth, response=list[TemplateOut])
def list_templates(request, project_id: str, subject_id: str | None = None):
    project = require_project(request.user, project_id)
    queryset = QuestionTemplate.objects.filter(subject__project=project)
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    return [
        {
            "id": str(template.id),
            "subject_id": str(template.subject_id),
            "name": template.name,
            "description": template.description,
            "review_status": template.review_status,
        }
        for template in queryset
    ]


@knowledge_router.post("/projects/{project_id}/question-templates", auth=auth, response={201: TemplateOut})
def create_template(request, project_id: str, payload: TemplateIn):
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id)
    template = services.create_question_template(
        subject=subject, name=payload.name, description=payload.description, actor=request.user
    )
    return 201, {
        "id": str(template.id),
        "subject_id": str(template.subject_id),
        "name": template.name,
        "description": template.description,
        "review_status": template.review_status,
    }


@knowledge_router.get("/projects/{project_id}/verification-pairings", auth=auth, response=list[PairingOut])
def list_pairings(request, project_id: str, subject_id: str | None = None, node_id: str | None = None):
    project = require_project(request.user, project_id)
    queryset = VerificationPairing.objects.filter(project=project).select_related("node")
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    if node_id:
        queryset = queryset.filter(node_id=node_id)
    return [_pairing_out(pairing) for pairing in queryset]


@knowledge_router.post("/projects/{project_id}/verification-pairings", auth=auth, response={201: PairingOut})
def create_pairing(request, project_id: str, payload: PairingIn):
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id)
    node = KnowledgeNode.objects.filter(id=payload.node_id, syllabus_version__subject=subject).first()
    if node is None:
        raise ScopeViolation(message="考点不存在或不属于该科目")
    immediate = Question.objects.filter(id=payload.immediate_question_id, subject=subject).first()
    if immediate is None:
        raise ScopeViolation(message="B 题不存在或不属于该科目")
    delayed = None
    if payload.delayed_question_id:
        delayed = Question.objects.filter(id=payload.delayed_question_id, subject=subject).first()
        if delayed is None:
            raise ScopeViolation(message="C 题不存在或不属于该科目")
    baseline = None
    if payload.baseline_question_id:
        baseline = Question.objects.filter(id=payload.baseline_question_id, subject=subject).first()
        if baseline is None:
            raise ScopeViolation(message="基准题不存在或不属于该科目")
    key = idempotency_key(request)
    scope = f"pairings.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    pairing = services.create_verification_pairing(
        project=project,
        subject=subject,
        node=node,
        immediate_question=immediate,
        delayed_question=delayed,
        baseline_question=baseline,
        delay_hours=payload.delay_hours,
        actor=request.user,
        note=payload.note,
    )
    result = _pairing_out(pairing)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=201,
        response_body=result,
        resource_type="verification_pairing",
        resource_id=pairing.id,
    )
    return 201, result


@knowledge_router.get("/projects/{project_id}/verification-pairings/{pairing_id}", auth=auth)
def get_pairing_detail(request, project_id: str, pairing_id: str):
    """Pairing detail plus eligible candidates, keeping the A/B/C gap explicit."""
    project = require_project(request.user, project_id)
    pairing = (
        VerificationPairing.objects.filter(id=pairing_id, project=project).select_related("node", "subject").first()
    )
    if pairing is None:
        raise ScopeViolation(message="配对不存在或不属于该项目")
    candidates = services.pairing_candidates(project=project, node=pairing.node)
    return {
        "pairing": _pairing_out(pairing),
        "candidates": [
            {
                "id": str(question.id),
                "display_label": question.display_label,
                "question_type": question.current_published_version.question_type
                if question.current_published_version
                else None,
            }
            for question in candidates
        ],
    }


@knowledge_router.get("/projects/{project_id}/knowledge-map", auth=auth)
def knowledge_map(request, project_id: str, subject_id: str, syllabus_version_id: str | None = None):
    """Tree of nodes with real evidence counts; nothing is simulated."""
    from apps.learning.models import LearnerKnowledgeState

    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, subject_id)
    syllabi = SyllabusVersion.objects.filter(subject=subject, status="published")
    if syllabus_version_id:
        syllabi = syllabi.filter(id=syllabus_version_id)
    nodes = list(
        KnowledgeNode.objects.filter(syllabus_version__in=syllabi)
        .select_related("syllabus_version")
        .order_by("display_order", "canonical_name")
    )
    states = {
        str(state.node_id): state
        for state in LearnerKnowledgeState.objects.filter(user=request.user, project=project, node__in=nodes)
    }
    payload: list[dict[str, Any]] = []
    for node in nodes:
        state = states.get(str(node.id))
        payload.append(
            {
                "id": str(node.id),
                "parent_id": str(node.parent_id) if node.parent_id else None,
                "kind": node.kind,
                "name": node.canonical_name,
                "is_unclassified": node.is_unclassified,
                "syllabus_version_id": str(node.syllabus_version_id),
                "syllabus_is_user_provisional": node.syllabus_version.is_user_provisional,
                "question_count": node.question_mappings.filter(is_primary=True).count(),
                "evidence": {
                    "summary": state.summary if state else "undiagnosed",
                    "best_summary": state.best_summary if state else "undiagnosed",
                    "independent_correct_count": state.independent_correct_count if state else 0,
                    "distinct_question_count": state.distinct_question_count if state else 0,
                    "distinct_template_count": state.distinct_template_count if state else 0,
                    "has_delayed_correct": state.has_delayed_correct if state else False,
                    "needs_review": state.needs_review if state else False,
                    "downgrade_reason": state.downgrade_reason if state else "",
                    "as_of": state.as_of.isoformat() if state else None,
                    "rule_version": state.rule_version if state else None,
                },
            }
        )
    return {"subject_id": str(subject.id), "nodes": payload}


@knowledge_router.post("/projects/{project_id}/syllabus-versions/{syllabus_id}/nodes/import", auth=auth,
                       response=OutlineOut)
def import_syllabus_outline(request, project_id: str, syllabus_id: str, payload: OutlineIn):
    """Build the node tree of one syllabus from its word list.

    Same-name (or same-alias) lines merge into one node instead of duplicating a
    point, so one knowledge point never collects two competing score rows.
    """
    project = require_project(request.user, project_id)
    syllabus = SyllabusVersion.objects.filter(id=syllabus_id, subject__project=project).first()
    if syllabus is None:
        raise ScopeViolation(message="大纲版本不存在或不属于该项目")
    if not (payload.text or "").strip():
        raise InvalidInput(message="词表内容不能为空")
    key = idempotency_key(request)
    scope = f"nodes.import:{syllabus_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    report = outline_services.import_outline(
        syllabus_version=syllabus, text=payload.text, actor=request.user, kind_by_depth=payload.kind_by_depth
    )
    result = {key: value for key, value in report.items() if key != "nodes"}
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="syllabus", resource_id=syllabus.id
    )
    return result


@knowledge_router.patch("/projects/{project_id}/knowledge-nodes/{node_id}", auth=auth, response=NodeOut)
def patch_node(request, project_id: str, node_id: str, payload: NodePatch):
    """Rename, re-alias or re-parent one node (cycles are refused)."""
    project = require_project(request.user, project_id)
    node = KnowledgeNode.objects.filter(id=node_id, syllabus_version__subject__project=project).first()
    if node is None:
        raise ScopeViolation(message="考点不存在或不属于该项目")
    parent = None
    if payload.move and payload.parent_id:
        parent = KnowledgeNode.objects.filter(
            id=payload.parent_id, syllabus_version_id=node.syllabus_version_id
        ).first()
        if parent is None:
            raise ScopeViolation(message="父考点不存在或不属于该大纲版本")
    updated = outline_services.update_knowledge_node(
        node,
        actor=request.user,
        canonical_name=payload.canonical_name,
        aliases=payload.aliases,
        parent=parent,
        move=payload.move,
    )
    return _node_out(updated)
