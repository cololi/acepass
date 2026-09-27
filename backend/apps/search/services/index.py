"""Indexing, and the single visibility gate every retrieval path goes through.

Two responsibilities live here on purpose, because they must agree:

* **What gets written** — ``build_question_text``/``build_node_text`` produce the
  only strings that may enter the index, and they can only see stem-shaped
  fields (blocks, options, blanks, shared-material text, node names/aliases).
  Answers, rubric criteria and explanations are not reachable from them, so the
  answer-leak rule of ``apps/search/models.py`` holds by construction.
* **What may be retrieved** — ``visibility_filter`` is the authoritative gate:
  owner-scoped project, published (not withdrawn) question versions, the
  subject's own project, and sealed (holdout) questions/families excluded. It
  re-derives all of this from the live relations on every query, so a stale
  ``is_searchable`` flag can never widen the result set.
  ``SearchDocument.is_searchable`` only records what the last index run decided,
  together with the reason.

P2 sealing is wired in here through
:mod:`apps.question_bank.services.sealing` — the single resolver — so both the
index-time eligibility check (:func:`question_eligibility`) and the retrieval gate
(:func:`visibility_filter`) use one rule, and every caller (the HTTP API, the
evaluation command and the tests) inherits it by construction.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from django.db import transaction
from django.db.models import F, Q, QuerySet
from django.utils import timezone

from ai.providers.base import AiError
from ai.providers.embeddings import get_embedding_provider
from apps.common.enums import QuestionVersionStatus
from apps.common.errors import InvalidInput
from apps.knowledge.models import KnowledgeNode
from apps.question_bank.models import QuestionVersion
from apps.question_bank.services import sealing
from apps.search.models import SearchDocument, SearchDocumentKind
from apps.search.services.tokenize import TOKENIZER_VERSION, term_frequencies, tokenize

logger = logging.getLogger("apps.search")

#: How many texts one provider call carries.
EMBEDDING_BATCH_SIZE = 32


# --------------------------------------------------------------------------
# Text construction (stem-shaped fields only)
# --------------------------------------------------------------------------
def _blocks_text(blocks: Any) -> list[str]:
    """Flatten one structured block list into indexable strings.

    Only ``text``/``math``/table/image-alt content is read. The block kinds are
    defined in ``apps/common/content.py`` and none of them is answer-bearing.
    """
    parts: list[str] = []
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        kind = block.get("kind")
        if kind in {"text", "math"}:
            value = block.get("text") if kind == "text" else block.get("latex")
            if isinstance(value, str) and value.strip():
                parts.append(value)
        elif kind == "image":
            alt = block.get("alt")
            if isinstance(alt, str) and alt.strip():
                parts.append(alt)
        elif kind == "table":
            caption = block.get("caption")
            if isinstance(caption, str) and caption.strip():
                parts.append(caption)
            for row in block.get("rows") or []:
                if not isinstance(row, list):
                    continue
                for cell in row:
                    if isinstance(cell, dict):
                        value = cell.get("text")
                        if isinstance(value, str) and value.strip():
                            parts.append(value)
                    elif isinstance(cell, str) and cell.strip():
                        parts.append(cell)
    return parts


def build_question_text(version: QuestionVersion) -> str:
    """The indexed text of one question version: stem + options + material text.

    Deliberately does not take an ``AnswerKeyVersion`` or ``RubricVersion``
    argument, so no caller can pass answer material into the index.
    """
    content = version.content or {}
    parts: list[str] = []
    parts.extend(_blocks_text(content.get("blocks")))
    for option in content.get("options") or []:
        if isinstance(option, dict):
            parts.extend(_blocks_text(option.get("blocks")))
    for blank in content.get("blanks") or []:
        if isinstance(blank, dict):
            parts.extend(_blocks_text(blank.get("blocks")))
    if version.parent_material_version_id:
        parts.extend(_blocks_text((version.parent_material_version.content or {}).get("blocks")))
    return "\n".join(part.strip() for part in parts if part and part.strip())


def build_node_text(node: KnowledgeNode) -> str:
    """The indexed text of one knowledge node: canonical name plus aliases."""
    parts = [node.canonical_name]
    parts.extend(alias for alias in (node.aliases or []) if isinstance(alias, str) and alias.strip())
    return "\n".join(part.strip() for part in parts if part and part.strip())


def question_version_revision(version: QuestionVersion) -> str:
    """Digest naming exactly which revision a row holds."""
    if version.content_digest:
        return version.content_digest[:64]
    payload = json.dumps(
        {
            "id": str(version.id),
            "version": version.version,
            "question_type": version.question_type,
            "content": version.content,
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def node_revision(node: KnowledgeNode) -> str:
    payload = json.dumps(
        {"id": str(node.id), "name": node.canonical_name, "aliases": node.aliases or []},
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# Eligibility (index time) — kept in step with visibility_filter below
# --------------------------------------------------------------------------
def holdout_reason(question, project) -> str:
    """Exclusion reason when the question or its family is sealed (C03).

    The decision itself is not made here: it comes from
    :mod:`apps.question_bank.services.sealing`, the single resolver every entry
    point calls. This function only turns that decision into the wording the
    index stores, so the search index and the practice path can never disagree
    about which content is sealed.
    """
    sealed, _code = sealing.is_sealed(question, project=project)
    if sealed:
        return sealing.SEARCH_EXCLUSION_REASON
    return ""


def question_eligibility(version: QuestionVersion, project) -> tuple[bool, str]:
    """Whether one question version may be indexed as retrievable content."""
    if version.status != QuestionVersionStatus.PUBLISHED:
        return False, f"题目版本状态为 {version.status}，只有已发布内容可被检索"
    if version.withdrawn_at is not None:
        return False, "题目版本已撤回"
    if version.question.subject.project_id != project.id:
        return False, "题目版本不属于该项目"
    reason = holdout_reason(version.question, project)
    if reason:
        return False, reason
    return True, ""


def node_eligibility(node: KnowledgeNode, project) -> tuple[bool, str]:
    """Whether one knowledge node may be indexed as retrievable content.

    A node carries names only, never answer text, so its syllabus lifecycle
    status is not used as a gate; membership of the project is.
    """
    if node.syllabus_version.subject.project_id != project.id:
        return False, "考点不属于该项目"
    return True, ""


# --------------------------------------------------------------------------
# The visibility gate
# --------------------------------------------------------------------------
def visibility_filter(*, user, project, subject=None) -> QuerySet[SearchDocument]:
    """Every document the caller may retrieve, derived from live relations.

    The denormalised ``project``/``subject`` columns on the row are checked
    against the target's real relations, so a mis-written row cannot be
    retrieved either. ``is_searchable`` is *not* consulted here: it is an
    index-time record, and the live predicates below are what protect the data.

    Sealed content is excluded through
    :func:`apps.question_bank.services.sealing.sealed_question_ids` rather than
    by re-reading ``QuestionPoolPolicy`` here: the resolver owns the "latest
    revision per target" rule, so a seal (or a later unseal) takes effect on
    retrieval immediately and identically to every other entry point. Knowledge
    node documents carry no question and are never removed by this predicate.
    """
    queryset = SearchDocument.objects.filter(project=project, project__owner=user).filter(
        Q(
            kind=SearchDocumentKind.QUESTION,
            question_version__status=QuestionVersionStatus.PUBLISHED,
            question_version__withdrawn_at__isnull=True,
            question_version__question__subject_id=F("subject_id"),
            question_version__question__subject__project_id=F("project_id"),
        )
        | Q(
            kind=SearchDocumentKind.NODE,
            knowledge_node__syllabus_version__subject_id=F("subject_id"),
            knowledge_node__syllabus_version__subject__project_id=F("project_id"),
        )
    )
    if subject is not None:
        queryset = queryset.filter(
            Q(question_version__question__subject=subject) | Q(knowledge_node__syllabus_version__subject=subject)
        )
    sealed_ids = sorted(sealing.sealed_question_ids(project=project))
    if sealed_ids:
        queryset = queryset.filter(Q(question_id__isnull=True) | ~Q(question_id__in=sealed_ids))
    return queryset


def searchable_documents(*, user, project, subject=None) -> QuerySet[SearchDocument]:
    """The candidate set every scoring channel is fed with.

    Ordering is by primary key so a run without any relevance signal is still
    reproducible.
    """
    return (
        visibility_filter(user=user, project=project, subject=subject)
        .filter(is_searchable=True)
        .select_related("question", "question_version", "knowledge_node", "subject")
        .order_by("id")
    )


# --------------------------------------------------------------------------
# Embeddings
# --------------------------------------------------------------------------
def _embed_documents(documents: list[SearchDocument]) -> dict[str, Any]:
    """Compute and store embeddings for ``documents``.

    Returns ``{"embedded": n, "reason": str|None, "model": str|None}``. An
    unconfigured provider is reported as a reason and leaves every ``embedding``
    null — never a zero vector, which would make the vector channel look alive.
    """
    provider = get_embedding_provider()
    if not provider.is_available:
        return {"embedded": 0, "reason": provider.unavailable_reason, "model": provider.model_name or None}
    if not provider.model_name:
        return {
            "embedded": 0,
            "reason": "向量化模型未声明模型名称，无法与已入库向量对齐",
            "model": None,
        }
    if not documents:
        return {"embedded": 0, "reason": None, "model": provider.model_name}

    expected_dim = provider.dimension
    embedded = 0
    reason: str | None = None
    moment = timezone.now()
    for start in range(0, len(documents), EMBEDDING_BATCH_SIZE):
        chunk = documents[start : start + EMBEDDING_BATCH_SIZE]
        try:
            vectors = provider.embed([document.text for document in chunk])
        except AiError as exc:
            reason = f"向量化失败：{exc}"
            logger.warning("embedding batch failed: %s", exc)
            break
        if len(vectors) != len(chunk):
            reason = f"向量化失败：provider 返回 {len(vectors)} 条向量，期望 {len(chunk)} 条"
            break
        for document, vector in zip(chunk, vectors, strict=False):
            if not vector:
                reason = "向量化失败：provider 返回空向量"
                break
            if expected_dim is None:
                expected_dim = len(vector)
            if len(vector) != expected_dim:
                reason = f"向量化失败：向量维度 {len(vector)} 与 {expected_dim} 不一致"
                break
            document.embedding = [float(value) for value in vector]
            document.embedding_model = provider.model_name
            document.embedding_dim = len(vector)
            document.embedding_updated_at = moment
            document.save(
                update_fields=[
                    "embedding",
                    "embedding_model",
                    "embedding_dim",
                    "embedding_updated_at",
                    "updated_at",
                ]
            )
            embedded += 1
        if reason:
            break
    return {"embedded": embedded, "reason": reason, "model": provider.model_name}


# --------------------------------------------------------------------------
# Writing documents
# --------------------------------------------------------------------------
def index_question_version(version: QuestionVersion, *, embed: bool = True) -> SearchDocument:
    """Write (or update) the index row of one question version.

    Idempotent: the row is keyed by ``(question_version, kind)``, so re-indexing
    the same revision updates it in place; it never creates a second row.

    ``embed=False`` skips the vector step so a caller indexing many versions can
    batch the provider calls itself (``reindex_project`` does).
    """
    version = QuestionVersion.objects.select_related(
        "question__subject__project", "parent_material_version"
    ).get(id=version.id)
    project = version.question.subject.project
    searchable, reason = question_eligibility(version, project)
    text = build_question_text(version)
    tokens = tokenize(text)
    defaults = {
        "project": project,
        "subject": version.question.subject,
        "question": version.question,
        "text": text,
        "tokens": tokens,
        "term_frequencies": term_frequencies(tokens),
        "doc_length": len(tokens),
        "source_revision": question_version_revision(version),
        "is_searchable": searchable,
        "exclusion_reason": reason[:200],
    }
    with transaction.atomic():
        document, _created = SearchDocument.objects.update_or_create(
            question_version=version, kind=SearchDocumentKind.QUESTION, defaults=defaults
        )
        if embed and searchable:
            _embed_documents([document])
    return document


def index_knowledge_node(node: KnowledgeNode, *, embed: bool = True) -> SearchDocument:
    """Write (or update) the index row of one knowledge node."""
    node = KnowledgeNode.objects.select_related("syllabus_version__subject__project").get(id=node.id)
    project = node.syllabus_version.subject.project
    searchable, reason = node_eligibility(node, project)
    text = build_node_text(node)
    tokens = tokenize(text)
    defaults = {
        "project": project,
        "subject": node.syllabus_version.subject,
        "knowledge_node": node,
        "text": text,
        "tokens": tokens,
        "term_frequencies": term_frequencies(tokens),
        "doc_length": len(tokens),
        "source_revision": node_revision(node),
        "is_searchable": searchable,
        "exclusion_reason": reason[:200],
    }
    with transaction.atomic():
        document, _created = SearchDocument.objects.update_or_create(
            knowledge_node=node, kind=SearchDocumentKind.NODE, defaults=defaults
        )
        if embed and searchable:
            _embed_documents([document])
    return document


def remove_document(*, question_version=None, knowledge_node=None, kind: str | None = None) -> int:
    """Delete index rows for a target that must no longer be retrievable.

    Used when content is withdrawn for good; ordinary withdrawal is already
    handled by the live gate, so this is the explicit purge path.
    """
    if question_version is None and knowledge_node is None:
        raise InvalidInput(message="remove_document 需要指定题目版本或考点")
    queryset = SearchDocument.objects.all()
    if question_version is not None:
        queryset = queryset.filter(question_version=question_version)
    if knowledge_node is not None:
        queryset = queryset.filter(knowledge_node=knowledge_node)
    if kind:
        queryset = queryset.filter(kind=kind)
    removed = queryset.count()
    queryset.delete()
    return removed


def reindex_project(project, *, subject=None) -> dict[str, Any]:
    """Rebuild the index of one project (optionally one subject) and count it.

    ``indexed``/``excluded`` partition every row this run wrote: a row is
    ``indexed`` when it is retrievable and ``excluded`` when the eligibility
    check refused it (draft, withdrawn, holdout, wrong project). Excluded rows
    are still written — with their reason — so an exclusion is visible instead of
    being indistinguishable from "never seen". ``embeddings`` counts rows that
    received a vector in this run, and
    ``embedding_unavailable_reason`` is the explicit reason when that is zero.
    """
    versions = QuestionVersion.objects.filter(question__subject__project=project)
    nodes = KnowledgeNode.objects.filter(syllabus_version__subject__project=project)
    if subject is not None:
        versions = versions.filter(question__subject=subject)
        nodes = nodes.filter(syllabus_version__subject=subject)

    documents: list[SearchDocument] = []
    indexed = 0
    excluded = 0
    for version in versions.select_related("question__subject__project", "parent_material_version").order_by("id"):
        document = index_question_version(version, embed=False)
        documents.append(document)
        if document.is_searchable:
            indexed += 1
        else:
            excluded += 1
    for node in nodes.select_related("syllabus_version__subject__project").order_by("id"):
        document = index_knowledge_node(node, embed=False)
        documents.append(document)
        if document.is_searchable:
            indexed += 1
        else:
            excluded += 1

    embedding = _embed_documents([document for document in documents if document.is_searchable])
    in_index = SearchDocument.objects.filter(project=project)
    if subject is not None:
        in_index = in_index.filter(subject=subject)
    return {
        "project_id": str(project.id),
        "subject_id": str(subject.id) if subject is not None else None,
        "indexed": indexed,
        "excluded": excluded,
        "embeddings": embedding["embedded"],
        "embedding_unavailable_reason": embedding["reason"],
        "embedding_model": embedding["model"],
        "documents_total": len(documents),
        "documents_in_index": in_index.count(),
        "tokenizer_version": TOKENIZER_VERSION,
    }
