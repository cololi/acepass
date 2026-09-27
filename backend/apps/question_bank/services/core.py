"""Question-bank services: versioned content, answers, rubrics and mappings.

Rules enforced here (docs/03 §3, §8):

* published content, answers and rubrics are never edited in place
* a leaf scoring question can only be published with checked, undisputed answer
  (and rubric for constructed responses) plus a resolvable per-item max score
* awarding rules are frozen onto the session item and grade event, so a later
  rule change cannot silently re-grade history
"""

from __future__ import annotations

from decimal import Decimal

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.audit.models import ContentRevision
from apps.common.answers import sum_blank_scores, validate_answer_payload
from apps.common.content import content_digest, normalize_content, validate_content
from apps.common.enums import (
    SCORABLE_LEAF_TYPES,
    AnswerSourceType,
    OriginType,
    QuestionType,
    QuestionVersionStatus,
    VerificationStatus,
)
from apps.common.errors import InvalidInput, ScopeViolation, StructureInvalid
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge
from apps.question_bank.models import (
    AnswerKeyVersion,
    Question,
    QuestionVersion,
    RubricVersion,
)


def assert_draft(version: QuestionVersion) -> None:
    if version.status != QuestionVersionStatus.DRAFT:
        raise InvalidInput(
            message="只有草稿版本可以直接修改；已发布内容请创建新版本",
            details={"status": version.status},
        )


def _apply_content(version: QuestionVersion, question_type: str, content: dict) -> None:
    problems = validate_content(content, question_type)
    if problems:
        raise StructureInvalid(message="题目结构校验失败", details={"problems": problems})
    version.question_type = question_type
    version.content = normalize_content(content)


@transaction.atomic
def create_question(
    *,
    subject,
    origin_type: str = OriginType.DEMO,
    actor=None,
    display_label: str = "",
    family=None,
    content_lineage=None,
    is_demo: bool | None = None,
) -> Question:
    if origin_type not in OriginType.values:
        raise InvalidInput(message="题目来源类型无效", details={"origin_type": origin_type})
    if is_demo is None:
        is_demo = origin_type in {OriginType.DEMO, OriginType.AI_GENERATED}
    return Question.objects.create(
        subject=subject,
        origin_type=origin_type,
        created_by=actor,
        display_label=display_label[:200],
        family=family,
        content_lineage=content_lineage,
        is_demo=is_demo,
    )


@transaction.atomic
def create_question_version_draft(
    question: Question,
    *,
    question_type: str,
    content: dict,
    actor=None,
    practice_max_score: Decimal | None = None,
    estimated_seconds: int | None = None,
    parent_material_version_id: str | None = None,
    revision_reason: str = "",
) -> QuestionVersion:
    parent = None
    if parent_material_version_id:
        parent = QuestionVersion.objects.filter(
            id=parent_material_version_id, question__subject=question.subject
        ).first()
        if parent is None:
            raise ScopeViolation(message="父材料版本不存在或不属于该科目")
        if parent.question_id == question.id:
            raise InvalidInput(message="题目不能以自身为父材料")
    if question_type == QuestionType.MATERIAL and practice_max_score:
        raise InvalidInput(message="共享材料父题不计分，不能设置练习分值")
    version_number = (QuestionVersion.objects.filter(question=question).aggregate(v=Max("version"))["v"] or 0) + 1
    version = QuestionVersion(
        question=question,
        version=version_number,
        question_type=question_type,
        parent_material_version=parent,
        practice_max_score=practice_max_score,
        estimated_seconds=estimated_seconds,
        revision_reason=revision_reason[:500],
        created_by=actor,
    )
    _apply_content(version, question_type, content)
    version.full_clean(exclude=["content", "material_child_version_ids"])
    version.save()
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_version",
        entity_id=str(version.id),
        action="create_draft",
        project_id=question.subject.project_id,
        detail={"question_id": str(question.id), "version": version_number, "type": question_type},
    )
    return version


@transaction.atomic
def update_question_version_draft(
    version: QuestionVersion,
    *,
    question_type: str | None = None,
    content: dict | None = None,
    practice_max_score: Decimal | None = None,
    estimated_seconds: int | None = None,
    actor=None,
    expected_version: int | None = None,
) -> QuestionVersion:
    locked = QuestionVersion.objects.select_for_update().get(id=version.id)
    assert_draft(locked)
    if expected_version is not None and int(expected_version) != int(locked.version):
        from apps.common.errors import VersionConflict

        raise VersionConflict(details={"expected": expected_version, "actual": locked.version})
    if question_type is None and content is None and practice_max_score is None and estimated_seconds is None:
        return locked
    target_type = question_type or locked.question_type
    target_content = content if content is not None else locked.content
    if locked.question_type == QuestionType.MATERIAL and practice_max_score:
        raise InvalidInput(message="共享材料父题不计分")
    _apply_content(locked, target_type, target_content)
    if practice_max_score is not None:
        locked.practice_max_score = practice_max_score
    if estimated_seconds is not None:
        locked.estimated_seconds = estimated_seconds
    locked.full_clean(exclude=["content", "material_child_version_ids"])
    locked.save()
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_version",
        entity_id=str(locked.id),
        action="update_draft",
        project_id=locked.question.subject.project_id,
    )
    return locked


def resolve_max_score(version: QuestionVersion, spec_version) -> Decimal:
    """Per-item score: explicit practice score, else the spec default, else refuse.

    Never inferred from a subject total.
    """
    if version.question_type not in SCORABLE_LEAF_TYPES:
        raise InvalidInput(message="共享材料父题不计分，不能作为计分单元")
    if version.practice_max_score is not None:
        return version.practice_max_score
    if spec_version is not None:
        default = spec_version.default_max_score(version.question_type)
        if default is not None:
            return default
    raise InvalidInput(
        message="缺少该题的分值：请在题目上填写练习分值，或在考试规范中配置该题型默认分值",
        details={"question_version_id": str(version.id), "question_type": version.question_type},
    )


def publish_problems(version: QuestionVersion) -> list[dict]:
    """Everything that blocks publishing this version, with a fixable pointer."""
    problems: list[dict] = list(validate_content(version.content, version.question_type))
    if version.question_type == QuestionType.MATERIAL:
        children = list(version.child_versions.all())
        if not children:
            problems.append(
                {"code": "material_without_children", "message": "共享材料题必须包含子题", "path": "children"}
            )
        expected = [str(child.id) for child in children]
        declared = [str(value) for value in (version.material_child_version_ids or [])]
        if sorted(expected) != sorted(declared):
            problems.append(
                {
                    "code": "material_children_mismatch",
                    "message": "材料题的子题清单与实际子题版本不一致",
                    "path": "material_child_version_ids",
                }
            )
        for child in children:
            if child.question.subject_id != version.question.subject_id:
                problems.append(
                    {"code": "material_child_scope", "message": "子题与材料题必须属于同一科目", "path": str(child.id)}
                )
        return problems

    answers = [answer for answer in version.answer_keys.all() if not answer.is_disputed]
    usable = [answer for answer in answers if answer.verification_status == VerificationStatus.CHECKED]
    if not answers:
        problems.append({"code": "answer_missing", "message": "缺少答案版本，无法发布", "path": "answer_keys"})
    elif not usable:
        problems.append(
            {
                "code": "answer_not_checked",
                "message": "答案尚未核对（或处于争议），不能发布为计分题",
                "path": "answer_keys",
            }
        )
    answer = usable[0] if usable else None
    if answer is not None:
        if answer.question_version_id != version.id:
            problems.append({"code": "answer_version_mismatch", "message": "答案版本与题目版本不匹配", "path": "answer_keys"})
        for problem in validate_answer_payload(answer.answer_payload, version.question_type, version.content):
            problems.append({**problem, "path": f"answer.{problem.get('path', '')}"})
        if not answer.check_basis.strip():
            problems.append(
                {"code": "answer_check_basis_missing", "message": "已核对答案必须记录核对依据", "path": "answer_keys"}
            )

    if version.question_type == QuestionType.CONSTRUCTED_RESPONSE:
        rubric = getattr(answer, "rubric", None) if answer else None
        if rubric is None:
            problems.append(
                {"code": "rubric_missing", "message": "大题必须提供逐评分点的评分标准", "path": "rubric"}
            )
        else:
            try:
                rubric.full_clean(exclude=["answer_key_version"])
            except Exception as exc:
                problems.append(
                    {"code": "rubric_invalid", "message": getattr(exc, "message_dict", str(exc)).__str__(), "path": "rubric"}
                )
            if version.practice_max_score is not None and rubric.total_score != version.practice_max_score:
                problems.append(
                    {
                        "code": "rubric_total_mismatch",
                        "message": f"rubric 总分 {rubric.total_score} 与题目分值 {version.practice_max_score} 不一致",
                        "path": "rubric",
                    }
                )
    if version.question_type == QuestionType.FILL_BLANK and answer is not None:
        blank_total = sum_blank_scores(answer.answer_payload)
        if blank_total is not None and version.practice_max_score is not None and blank_total != version.practice_max_score:
            problems.append(
                {
                    "code": "blank_total_mismatch",
                    "message": f"各空分值合计 {blank_total} 与题目分值 {version.practice_max_score} 不一致",
                    "path": "answer.blanks",
                }
            )
    return problems


@transaction.atomic
def publish_question_version(version: QuestionVersion, *, actor, allow_without_score: bool = False) -> QuestionVersion:
    locked = QuestionVersion.objects.select_for_update().select_related("question").get(id=version.id)
    if locked.status == QuestionVersionStatus.PUBLISHED:
        return locked
    if locked.status == QuestionVersionStatus.WITHDRAWN:
        raise InvalidInput(message="已撤回版本不能重新发布；请创建新版本")
    problems = publish_problems(locked)
    if locked.question_type in SCORABLE_LEAF_TYPES and locked.practice_max_score is None and not allow_without_score:
        problems.append(
            {
                "code": "practice_max_score_missing",
                "message": "未填写练习分值，且未显式采用所选考试规范的题型默认分值",
                "path": "practice_max_score",
            }
        )
    if problems:
        raise StructureInvalid(message="发布前校验未通过", details={"problems": problems})
    locked.status = QuestionVersionStatus.PUBLISHED
    locked.published_at = timezone.now()
    locked.content_digest = content_digest(locked.content)
    locked.save(update_fields=["status", "published_at", "content_digest", "updated_at"])
    question = locked.question
    question.current_published_version = locked
    question.save(update_fields=["current_published_version", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_version",
        entity_id=str(locked.id),
        action="publish",
        project_id=question.subject.project_id,
        after_digest=locked.content_digest,
        detail={"question_id": str(question.id), "version": locked.version},
    )
    return locked


@transaction.atomic
def withdraw_question_version(version: QuestionVersion, *, actor, reason: str = "") -> QuestionVersion:
    from apps.common.errors import VersionConflict

    locked = QuestionVersion.objects.select_for_update().select_related("question").get(id=version.id)
    if locked.status == QuestionVersionStatus.WITHDRAWN:
        return locked
    if locked.status != QuestionVersionStatus.PUBLISHED:
        raise InvalidInput(message="只有已发布版本可以撤回")
    locked.status = QuestionVersionStatus.WITHDRAWN
    locked.withdrawn_at = timezone.now()
    locked.withdrawn_reason = reason[:500]
    locked.save(update_fields=["status", "withdrawn_at", "withdrawn_reason", "updated_at"])
    question = locked.question
    if question.current_published_version_id == locked.id:
        fallback = (
            question.versions.filter(status=QuestionVersionStatus.PUBLISHED).exclude(id=locked.id).order_by("-version").first()
        )
        question.current_published_version = fallback
        question.save(update_fields=["current_published_version", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_version",
        entity_id=str(locked.id),
        action="withdraw",
        project_id=question.subject.project_id,
        reason=reason[:500],
    )
    if not QuestionVersion.objects.filter(
        question=question, status=QuestionVersionStatus.PUBLISHED
    ).exists():
        pass
    else:  # pragma: no cover - defensive
        raise VersionConflict(message="撤回后仍存在已发布版本，请检查数据一致性")
    return locked


# --------------------------------------------------------------------------
# Answers and rubrics
# --------------------------------------------------------------------------
@transaction.atomic
def create_answer_key_version(
    version: QuestionVersion,
    *,
    answer_payload: dict,
    actor=None,
    source_type: str = AnswerSourceType.USER,
    verification_status: str = VerificationStatus.PENDING,
    check_basis: str = "",
    source_region=None,
    explanation_blocks: list | None = None,
) -> AnswerKeyVersion:
    if source_type not in AnswerSourceType.values:
        raise InvalidInput(message="答案来源类型无效")
    if verification_status not in VerificationStatus.values:
        raise InvalidInput(message="答案核对状态无效")
    if verification_status == VerificationStatus.CHECKED and not check_basis.strip():
        raise InvalidInput(message="标记为已核对时必须填写核对依据")
    problems = validate_answer_payload(answer_payload, version.question_type, version.content)
    if problems:
        raise StructureInvalid(message="答案结构校验失败", details={"problems": problems})
    number = (AnswerKeyVersion.objects.filter(question_version=version).aggregate(v=Max("version"))["v"] or 0) + 1
    previous = AnswerKeyVersion.objects.filter(question_version=version).order_by("-version").first()
    answer = AnswerKeyVersion.objects.create(
        question_version=version,
        version=number,
        answer_payload=answer_payload,
        source_type=source_type,
        verification_status=verification_status,
        check_basis=check_basis[:500],
        checked_by=actor if verification_status == VerificationStatus.CHECKED else None,
        checked_at=timezone.now() if verification_status == VerificationStatus.CHECKED else None,
        source_region=source_region,
        explanation_blocks=explanation_blocks or [],
        created_by=actor,
        supersedes=previous,
    )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="answer_key_version",
        entity_id=str(answer.id),
        action="create",
        project_id=version.question.subject.project_id,
        detail={"verification_status": verification_status, "source_type": source_type},
    )
    return answer


@transaction.atomic
def check_answer_key_version(
    answer: AnswerKeyVersion, *, actor, check_basis: str, explanation_blocks: list | None = None
) -> AnswerKeyVersion:
    """Mark an answer as verified. Requires a concrete basis, not self-agreement."""
    locked = AnswerKeyVersion.objects.select_for_update().get(id=answer.id)
    if not check_basis.strip():
        raise InvalidInput(message="标记为已核对时必须填写核对依据（与哪个题号/版本的哪个来源一致）")
    problems = validate_answer_payload(locked.answer_payload, locked.question_version.question_type, locked.question_version.content)
    if problems:
        raise StructureInvalid(message="答案结构校验失败", details={"problems": problems})
    locked.verification_status = VerificationStatus.CHECKED
    locked.check_basis = check_basis[:500]
    locked.checked_by = actor
    locked.checked_at = timezone.now()
    locked.is_disputed = False
    locked.dispute_reason = ""
    if explanation_blocks is not None:
        locked.explanation_blocks = explanation_blocks
    locked.save(
        update_fields=[
            "verification_status",
            "check_basis",
            "checked_by",
            "checked_at",
            "is_disputed",
            "dispute_reason",
            "explanation_blocks",
            "updated_at",
        ]
    )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="answer_key_version",
        entity_id=str(locked.id),
        action="check",
        project_id=locked.question_version.question.subject.project_id,
        reason=check_basis[:500],
    )
    return locked


@transaction.atomic
def dispute_answer_key_version(answer: AnswerKeyVersion, *, actor, reason: str) -> AnswerKeyVersion:
    """Dispute an answer: stop new grading, send in-flight work to review."""
    from apps.practice.services import attempts as attempt_services

    locked = AnswerKeyVersion.objects.select_for_update().get(id=answer.id)
    locked.verification_status = VerificationStatus.DISPUTED
    locked.is_disputed = True
    locked.dispute_reason = reason[:500]
    locked.save(update_fields=["verification_status", "is_disputed", "dispute_reason", "updated_at"])
    project_id = locked.question_version.question.subject.project_id
    ContentRevision.objects.create(
        actor=actor,
        entity_type="answer_key_version",
        entity_id=str(locked.id),
        action="dispute",
        project_id=project_id,
        reason=reason[:500],
    )
    # Existing work relying on this answer goes to human review; raw answers stay.
    affected = attempt_services.handle_answer_dispute(locked, actor=actor, reason=reason)
    from apps.audit.services.outbox import enqueue

    enqueue(
        "projection.rebuild_after_answer_change",
        {"answer_key_version_id": str(locked.id), "affected_attempts": affected},
        dedupe_key=f"answer-change:{locked.id}:{timezone.now().timestamp():.0f}",
    )
    return locked


@transaction.atomic
def upsert_rubric_version(
    answer: AnswerKeyVersion,
    *,
    criteria: list[dict],
    total_score: Decimal,
    actor=None,
    usage_note: str = "",
) -> RubricVersion:
    """Create or replace the rubric of a *draft* answer (checked answers are frozen)."""
    if answer.is_usable and answer.question_version.status != QuestionVersionStatus.DRAFT:
        raise InvalidInput(message="已发布且已核对的答案不能直接改 rubric，请创建新的答案版本")
    rubric, created = RubricVersion.objects.get_or_create(
        answer_key_version=answer,
        defaults={"version": 1, "criteria": criteria, "total_score": total_score, "usage_note": usage_note},
    )
    if not created:
        rubric.criteria = criteria
        rubric.total_score = total_score
        rubric.usage_note = usage_note
        rubric.version += 1
    rubric.checked_by = actor
    rubric.checked_at = timezone.now()
    rubric.full_clean(exclude=["answer_key_version"])
    rubric.save()
    return rubric


@transaction.atomic
def replace_knowledge_mappings(version: QuestionVersion, mappings: list[dict], *, actor) -> list[QuestionKnowledge]:
    """New mapping revision; earlier revisions stay intact for old evidence."""
    node_ids = [str(mapping["node_id"]) for mapping in mappings]
    if len(node_ids) != len(set(node_ids)):
        raise InvalidInput(message="同一考点不能重复映射")
    nodes = {
        str(node.id): node
        for node in KnowledgeNode.objects.filter(id__in=node_ids).select_related("syllabus_version")
    }
    if len(nodes) != len(node_ids):
        raise ScopeViolation(message="存在不属于可用大纲的考点")
    subject_id = str(version.question.subject_id)
    for node in nodes.values():
        if str(node.syllabus_version.subject_id) != subject_id:
            raise ScopeViolation(message="考点大纲与题目科目不一致")

    primary_total = sum(
        (Decimal(str(mapping.get("score_weight", "0"))) for mapping in mappings if mapping.get("is_primary", True)),
        Decimal("0"),
    )
    if primary_total != Decimal("1"):
        raise InvalidInput(
            message=f"主要考点权重合计必须为 1（当前 {primary_total}）；未分类分值请映射到显式“未分类”节点",
            details={"total": str(primary_total)},
        )
    for mapping in mappings:
        if not mapping.get("is_primary", True) and Decimal(str(mapping.get("score_weight", "0"))) != 0:
            raise InvalidInput(message="辅助考点权重必须为 0，避免重复计分")

    current = (
        QuestionKnowledge.objects.filter(question_version=version).aggregate(v=Max("mapping_revision"))["v"] or 0
    )
    revision = current + 1
    created_rows = []
    for mapping in mappings:
        created_rows.append(
            QuestionKnowledge.objects.create(
                question_version=version,
                mapping_revision=revision,
                node=nodes[str(mapping["node_id"])],
                is_primary=bool(mapping.get("is_primary", True)),
                score_weight=Decimal(str(mapping.get("score_weight", "0"))),
                template_id=mapping.get("template_id"),
                note=(mapping.get("note") or "")[:300],
            )
        )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="question_knowledge",
        entity_id=str(version.id),
        action="mapping_revision",
        project_id=version.question.subject.project_id,
        detail={"revision": revision, "count": len(created_rows)},
    )
    return created_rows


def mapping_summary(version: QuestionVersion, revision: int | None = None) -> list[dict]:
    queryset = version.knowledge_mappings.select_related("node").order_by("mapping_revision", "node__canonical_name")
    if revision is not None:
        queryset = queryset.filter(mapping_revision=revision)
    else:
        latest = version.knowledge_mappings.aggregate(v=Max("mapping_revision"))["v"]
        queryset = queryset.filter(mapping_revision=latest) if latest else queryset.none()
    return [
        {
            "node_id": str(mapping.node_id),
            "node_name": mapping.node.canonical_name,
            "weight": str(mapping.score_weight),
            "is_primary": mapping.is_primary,
        }
        for mapping in queryset
    ]
