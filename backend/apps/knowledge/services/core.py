"""Knowledge services: syllabus nodes, templates, mappings and pairings."""

from __future__ import annotations

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.audit.models import ContentRevision
from apps.common.errors import InvalidInput, ScopeViolation
from apps.knowledge.models import KnowledgeNode, QuestionTemplate, VerificationPairing


@transaction.atomic
def create_knowledge_node(
    *,
    syllabus_version,
    canonical_name: str,
    kind: str = "point",
    parent: KnowledgeNode | None = None,
    code: str = "",
    aliases: list[str] | None = None,
    is_unclassified: bool = False,
    display_order: int = 0,
) -> KnowledgeNode:
    name = (canonical_name or "").strip()
    if not name:
        raise InvalidInput(message="考点名称不能为空")
    if parent is not None and parent.syllabus_version_id != syllabus_version.id:
        raise ScopeViolation(message="父子考点必须属于同一大纲版本")
    if KnowledgeNode.objects.filter(syllabus_version=syllabus_version, parent=parent, canonical_name=name).exists():
        raise InvalidInput(message="同一层级下已存在同名考点", details={"name": name})
    node = KnowledgeNode(
        syllabus_version=syllabus_version,
        parent=parent,
        kind=kind,
        canonical_name=name,
        code=code[:40],
        aliases=aliases or [],
        is_unclassified=is_unclassified,
        display_order=display_order,
    )
    node.full_clean(exclude=["aliases"])
    node.save()
    return node


@transaction.atomic
def create_verification_pairing(
    *,
    project,
    subject,
    node: KnowledgeNode,
    immediate_question,
    delayed_question=None,
    baseline_question=None,
    delay_hours: int = 24,
    actor=None,
    note: str = "",
) -> VerificationPairing:
    """Human-reviewed A/B/C pairing. All three must share the project/subject."""
    if str(node.syllabus_version.subject_id) != str(subject.id):
        raise ScopeViolation(message="考点不属于该科目的大纲版本")
    for question in (baseline_question, immediate_question, delayed_question):
        if question is None:
            continue
        if str(question.subject_id) != str(subject.id):
            raise ScopeViolation(message="配对题目必须属于同一科目")
    if delay_hours < 1:
        raise InvalidInput(message="延迟验证间隔至少 1 小时")
    current = (
        VerificationPairing.objects.filter(project=project, subject=subject, node=node).aggregate(
            value=Max("pairing_version")
        )["value"]
        or 0
    )
    pairing = VerificationPairing(
        project=project,
        subject=subject,
        node=node,
        baseline_question=baseline_question,
        immediate_question=immediate_question,
        delayed_question=delayed_question,
        pairing_version=current + 1,
        delay_hours=delay_hours,
        reviewer=actor,
        reviewed_at=timezone.now(),
        note=note[:500],
    )
    pairing.full_clean(exclude=["project"])
    pairing.save()
    ContentRevision.objects.create(
        actor=actor,
        entity_type="verification_pairing",
        entity_id=str(pairing.id),
        action="create",
        project_id=project.id,
        detail={"node_id": str(node.id), "delay_hours": delay_hours},
    )
    return pairing


def pairing_candidates(*, project, node: KnowledgeNode, exclude_question_ids: list[str] | None = None):
    """Published leaf questions mapped to this node, for the Admin pairing form."""
    from apps.question_bank.models import Question, QuestionVersion

    exclude = {str(value) for value in (exclude_question_ids or [])}
    version_ids = (
        node.question_mappings.filter(is_primary=True)
        .values_list("question_version_id", flat=True)
    )
    questions = (
        Question.objects.filter(
            id__in=QuestionVersion.objects.filter(id__in=list(version_ids), status="published").values_list(
                "question_id", flat=True
            )
        )
        .select_related("current_published_version")
        .order_by("display_label")
    )
    return [question for question in questions if str(question.id) not in exclude]


@transaction.atomic
def create_question_template(*, subject, name: str, description: str = "", actor=None) -> QuestionTemplate:
    clean = (name or "").strip()
    if not clean:
        raise InvalidInput(message="模板名称不能为空")
    template, created = QuestionTemplate.objects.get_or_create(
        subject=subject,
        name=clean,
        defaults={"description": description[:500], "review_status": "approved", "confirmed_by": actor},
    )
    if not created and description:
        template.description = description[:500]
        template.save(update_fields=["description", "updated_at"])
    return template
