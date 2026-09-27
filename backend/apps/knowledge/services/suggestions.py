"""Machine-proposed knowledge tags that only a human can make effective (B04).

The acceptance rule is strict: *a tag suggestion must never edit the controlled
vocabulary*. This module therefore splits the work in two:

* :func:`propose_tags` asks a configured provider for candidate names, validates
  that every name is copied verbatim from the subject's own syllabus, and stores
  the result as inert data with its `llm_run` audit row. Without a provider the
  call fails loudly (``ai_not_configured``) instead of inventing anything.
* :func:`accept_suggestion` converts accepted names into **auxiliary** mappings
  (weight 0) inside a **new mapping revision** using the ordinary mapping
  service. The primary scoring mapping keeps being a human decision, existing
  revisions stay untouched, and unresolvable names are reported instead of being
  created on the fly.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from ai.prompts import registry as prompts
from ai.providers import base as providers
from apps.audit.models import ContentRevision, LLMRun
from apps.common.enums import LlmRunStatus, QuestionVersionStatus, SuggestionStatus
from apps.common.errors import InvalidInput, ScopeViolation
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge, TagSuggestion
from apps.question_bank.models import QuestionVersion
from apps.question_bank.services import core as question_services


def _blocks_text(blocks: Any) -> str:
    parts: list[str] = []
    for block in blocks or []:
        if isinstance(block, dict):
            if block.get("kind") == "list":
                parts.extend(str(item) for item in (block.get("items") or []))
            else:
                for key in ("text", "latex", "value"):
                    if block.get(key):
                        parts.append(str(block[key]))
                        break
    return " ".join(part.strip() for part in parts if part and part.strip())


def version_texts(version: QuestionVersion) -> tuple[str, list[str], str]:
    """Stem, option texts and material text — never the answer or the rubric."""
    content = version.content or {}
    stem = _blocks_text(content.get("blocks"))
    options = [_blocks_text(option.get("blocks")) for option in (content.get("options") or [])]
    material = ""
    if version.parent_material_version_id:
        material = _blocks_text((version.parent_material_version.content or {}).get("blocks"))
    elif version.question_type == "material":
        material = stem
    return stem, [text for text in options if text], material


def allowed_nodes(*, subject) -> list[KnowledgeNode]:
    """Nodes from the subject's published syllabi; empty when none is published."""
    return list(
        KnowledgeNode.objects.filter(
            syllabus_version__subject=subject, syllabus_version__status="published"
        )
        .select_related("syllabus_version")
        .order_by("syllabus_version_id", "display_order", "canonical_name")
    )


def resolve_node_names(*, subject, names: list[str]) -> tuple[dict[str, KnowledgeNode], list[str]]:
    """Map proposed names onto existing nodes; unknown names are returned as-is.

    Matching is deliberately literal (canonical name, an alias, or the node code)
    so a near-miss cannot silently attach the wrong knowledge point.
    """
    nodes = allowed_nodes(subject=subject)
    canonical = {node.canonical_name.strip(): node for node in nodes}
    by_alias: dict[str, KnowledgeNode] = {}
    by_code: dict[str, KnowledgeNode] = {}
    for node in nodes:
        for alias in node.aliases or []:
            by_alias.setdefault(str(alias).strip(), node)
        if node.code:
            by_code.setdefault(node.code.strip(), node)
    resolved: dict[str, KnowledgeNode] = {}
    unresolved: list[str] = []
    for raw in names:
        name = (raw or "").strip()
        if not name:
            continue
        node = canonical.get(name) or by_alias.get(name) or by_code.get(name)
        if node is None:
            unresolved.append(name)
        else:
            resolved[name] = node
    return resolved, unresolved


@transaction.atomic
def propose_tags(*, version: QuestionVersion, user, actor=None) -> TagSuggestion:
    """Ask the configured provider for tag candidates for one version."""
    project = version.question.subject.project
    provider = providers.get_provider()
    run = LLMRun.objects.create(
        provider=provider.name,
        model_identifier="",
        capability="suggest_tags",
        prompt_version=prompts.SUGGEST_TAGS_PROMPT_VERSION,
        status=LlmRunStatus.FAILED,
        request_summary={
            "question_version_id": str(version.id),
            "question_type": version.question_type,
            "subject_id": str(version.question.subject_id),
        },
        input_snapshot={"content_digest": version.content_digest},
        is_stub=getattr(provider, "is_stub", False),
        user=user,
        project_id=project.id,
    )
    if not provider.supports("suggest_tags"):
        run.status = LlmRunStatus.UNAVAILABLE
        run.error_code = "ai_not_configured"
        run.error_message = "当前 provider 不声明 suggest_tags 能力（未配置文本模型）"
        run.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        raise providers.AiUnavailable("未配置可用的文本模型，无法生成标签建议")

    nodes = allowed_nodes(subject=version.question.subject)
    allowed_names = [node.canonical_name for node in nodes]
    stem, options, material = version_texts(version)
    prompt = prompts.build_tag_suggestion_prompt(
        subject_name=version.question.subject.name,
        stem_text=stem,
        option_texts=options,
        allowed_node_names=allowed_names,
        material_text=material,
    )
    try:
        call = providers.call_with_deadline(
            provider,
            providers.AiRequest(
                capability="suggest_tags",
                prompt_version=prompts.SUGGEST_TAGS_PROMPT_VERSION,
                prompt=prompt,
                input_context={"allowed_node_count": len(allowed_names)},
                max_output_tokens=800,
            ),
        )
    except providers.AiUnavailable as exc:
        run.status = LlmRunStatus.UNAVAILABLE
        run.error_code = exc.code
        run.error_message = str(exc)[:500]
        run.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        raise
    except providers.AiError as exc:
        run.status = LlmRunStatus.TIMEOUT if isinstance(exc, providers.AiTimeout) else LlmRunStatus.FAILED
        run.error_code = exc.code
        run.error_message = str(exc)[:500]
        run.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        raise

    clean, problems = prompts.validate_tag_suggestions(call.payload, allowed_node_names=set(allowed_names))
    run.model_identifier = call.model
    run.raw_response_excerpt = (call.raw_text or "")[:2000]
    run.prompt_tokens = call.prompt_tokens
    run.completion_tokens = call.completion_tokens
    run.cost_cents = call.cost_cents
    run.cost_known = call.cost_known
    run.latency_ms = call.latency_ms
    run.attempts = call.attempts
    run.validation_result = {"accepted": len(clean), "problems": problems}
    run.status = LlmRunStatus.SUCCEEDED
    run.save(
        update_fields=[
            "model_identifier",
            "raw_response_excerpt",
            "prompt_tokens",
            "completion_tokens",
            "cost_cents",
            "cost_known",
            "latency_ms",
            "attempts",
            "validation_result",
            "status",
            "updated_at",
        ]
    )

    # A new proposal supersedes older pending ones: only one is actionable.
    TagSuggestion.objects.filter(
        question_version=version, status=SuggestionStatus.PROPOSED
    ).update(status=SuggestionStatus.SUPERSEDED, updated_at=timezone.now())
    return TagSuggestion.objects.create(
        project=project,
        question_version=version,
        run=run,
        status=SuggestionStatus.PROPOSED,
        proposals=clean,
        model_identifier=call.model,
        prompt_version=prompts.SUGGEST_TAGS_PROMPT_VERSION,
        is_stub=call.is_stub,
        created_by=actor or user,
    )


@transaction.atomic
def accept_suggestion(
    *, suggestion: TagSuggestion, actor, node_names: list[str] | None = None, note: str = ""
) -> dict:
    """Turn accepted names into a new auxiliary mapping revision."""
    if suggestion.status != SuggestionStatus.PROPOSED:
        raise InvalidInput(message="该建议已被处理，不能重复采纳", details={"status": suggestion.status})
    version = suggestion.question_version
    if version.status != QuestionVersionStatus.PUBLISHED:
        raise InvalidInput(message="只能为已发布版本采纳标签建议；请先发布题目版本")

    requested = node_names if node_names is not None else [row.get("name") for row in suggestion.proposals]
    requested = [str(name) for name in requested if str(name or "").strip()]
    if not requested:
        raise InvalidInput(message="没有可采纳的标签：建议为空或未选择任何名称")
    resolved, unresolved = resolve_node_names(subject=version.question.subject, names=requested)
    if not resolved:
        raise InvalidInput(
            message="没有名称能匹配当前大纲中的考点；标签建议不能创建新考点，请人工建立映射",
            details={"unresolved_names": unresolved},
        )

    latest_revision = version.knowledge_mappings.aggregate(value=Max("mapping_revision"))["value"]
    current_rows = list(
        QuestionKnowledge.objects.filter(question_version=version, mapping_revision=latest_revision)
        .select_related("node")
        .order_by("node__canonical_name")
        if latest_revision
        else []
    )
    if not any(row.is_primary for row in current_rows):
        raise InvalidInput(
            message="该题目还没有主要考点映射：标签建议只作为辅助标签，请先人工建立权重合计为 1 的主考点",
            details={"latest_revision": latest_revision},
        )

    existing_node_ids = {str(row.node_id) for row in current_rows}
    mappings: list[dict] = [
        {
            "node_id": str(row.node_id),
            "is_primary": row.is_primary,
            "score_weight": str(row.score_weight),
            "template_id": str(row.template_id) if row.template_id else None,
            "note": row.note,
        }
        for row in current_rows
    ]
    added = []
    for name, node in resolved.items():
        if str(node.id) in existing_node_ids:
            unresolved.append(f"{name}（已映射，未重复添加）")
            continue
        mappings.append(
            {
                "node_id": str(node.id),
                "is_primary": False,
                "score_weight": "0",
                "template_id": None,
                "note": f"标签建议采纳（{suggestion.prompt_version or 'unknown'}）"[:300],
            }
        )
        added.append(name)
    if not added:
        raise InvalidInput(message="所有建议的考点都已映射，没有新增内容", details={"duplicates": unresolved})

    rows = question_services.replace_knowledge_mappings(version, mappings, actor=actor)
    revision = rows[0].mapping_revision if rows else None
    suggestion.status = SuggestionStatus.ACCEPTED
    suggestion.accepted_mapping_revision = revision
    suggestion.unresolved_names = unresolved
    suggestion.decided_by = actor
    suggestion.decided_at = timezone.now()
    suggestion.decision_note = note[:500]
    suggestion.save(
        update_fields=[
            "status",
            "accepted_mapping_revision",
            "unresolved_names",
            "decided_by",
            "decided_at",
            "decision_note",
            "updated_at",
        ]
    )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="tag_suggestion",
        entity_id=str(suggestion.id),
        action="accepted",
        project_id=suggestion.project_id,
        detail={
            "question_version_id": str(version.id),
            "mapping_revision": revision,
            "added": added,
            "unresolved": unresolved,
        },
    )
    return {
        "suggestion_id": str(suggestion.id),
        "status": suggestion.status,
        "mapping_revision": revision,
        "added_node_names": added,
        "unresolved_names": unresolved,
    }


@transaction.atomic
def reject_suggestion(*, suggestion: TagSuggestion, actor, note: str = "") -> TagSuggestion:
    if suggestion.status != SuggestionStatus.PROPOSED:
        raise InvalidInput(message="该建议已被处理，不能重复否决", details={"status": suggestion.status})
    suggestion.status = SuggestionStatus.REJECTED
    suggestion.decided_by = actor
    suggestion.decided_at = timezone.now()
    suggestion.decision_note = note[:500]
    suggestion.save(update_fields=["status", "decided_by", "decided_at", "decision_note", "updated_at"])
    return suggestion


def require_suggestion(*, project, suggestion_id: str) -> TagSuggestion:
    suggestion = TagSuggestion.objects.filter(id=suggestion_id, project=project).select_related(
        "question_version__question__subject"
    ).first()
    if suggestion is None:
        raise ScopeViolation(message="标签建议不存在或不属于该项目")
    return suggestion


def mapping_context(version: QuestionVersion) -> list[dict]:
    """Latest mapping revision, for the review UI."""
    return question_services.mapping_summary(version)


__all__ = [
    "accept_suggestion",
    "allowed_nodes",
    "mapping_context",
    "propose_tags",
    "reject_suggestion",
    "require_suggestion",
    "resolve_node_names",
    "version_texts",
]
