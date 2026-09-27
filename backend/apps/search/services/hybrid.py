"""Hybrid retrieval: BM25 keyword channel + cosine vector channel + RRF fusion.

Order of operations (this order *is* the security property):

1. ``index_service.searchable_documents`` produces the candidate set — the one
   place that decides what may be retrieved (owner, project, published, not
   withdrawn, holdout excluded). Nothing below this line can add a document.
2. each channel scores **only** those candidates;
3. reciprocal rank fusion merges the channels' ranked lists;
4. the top ``limit`` documents are serialised.

Because filtering happens before scoring, a document that is sealed, unpublished,
withdrawn or owned by someone else cannot be returned even if a provider hands
it a cosine similarity of 1.0: it was never in the input.

Channel behaviour is explicit rather than silent:

* ``channel="hybrid"`` (default) uses both channels. If the vector channel is
  unavailable the response reports ``channels.vector.available = false`` with the
  reason and the ranking degrades to keyword-only.
* ``channel="keyword"`` restricts ranking to the keyword channel and does not
  embed the query at all (no provider cost for a keyword-only request).
* ``channel="vector"`` restricts ranking to the vector channel. **Chosen
  behaviour:** when that channel is unavailable the response is a normal 200 with
  an empty ``results`` list, ``channels.vector.reason`` filled in and a note —
  not an error status. Rationale: the honest reason is more useful to a caller
  than a generic failure, the same response shape covers "no vectors stored yet",
  and the evaluation command can report the degradation instead of aborting.

No result field can carry answer text: every string comes from
``SearchDocument.text``, which ``services/index.py`` builds from stem-shaped
fields only.
"""

from __future__ import annotations

import math
from typing import Any

from ai.providers.base import AiError
from apps.common.enums import SearchChannel
from apps.common.errors import InvalidInput
from apps.common.scope import require_subject
from apps.search.services import index as index_service
from apps.search.services import vector as vector_service
from apps.search.services.tokenize import TOKENIZER_VERSION, tokenize

#: Okapi BM25 parameters (the standard defaults; reported in the response).
BM25_K1 = 1.2
BM25_B = 0.75
#: Reciprocal rank fusion constant (the value from the original RRF paper).
RRF_K = 60
#: Longest excerpt returned per hit; the excerpt is taken from indexed stem text.
EXCERPT_LENGTH = 160
#: Hard ceiling for one request, mirrored by the API query validation.
MAX_LIMIT = 50


def _ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def _bm25_scores(documents: list, query_terms: list[str]) -> dict[str, float]:
    """Okapi BM25 over the filtered candidate set only.

    The corpus statistics are computed from the *candidates* the caller may see,
    not from the whole table: a sealed document must not influence the idf of a
    document the learner can retrieve.
    """
    if not documents or not query_terms:
        return {}
    lengths = {str(document.id): (document.doc_length or len(document.tokens or [])) for document in documents}
    total_length = sum(lengths.values())
    document_count = len(documents)
    average_length = total_length / document_count if document_count else 0.0
    document_frequency = dict.fromkeys(query_terms, 0)
    for document in documents:
        frequencies = document.term_frequencies or {}
        for term in query_terms:
            if frequencies.get(term):
                document_frequency[term] += 1
    scores: dict[str, float] = {}
    for document in documents:
        frequencies = document.term_frequencies or {}
        length = lengths[str(document.id)]
        score = 0.0
        for term in query_terms:
            occurrences = frequencies.get(term) or 0
            if not occurrences:
                continue
            frequency = document_frequency[term]
            idf = math.log(1 + (document_count - frequency + 0.5) / (frequency + 0.5))
            normalization = 1 - BM25_B + BM25_B * (length / average_length if average_length else 0.0)
            denominator = occurrences + BM25_K1 * normalization
            if denominator:
                score += idf * (occurrences * (BM25_K1 + 1)) / denominator
        if score > 0:
            scores[str(document.id)] = score
    return scores


def _rank(scores: dict[str, float]) -> list[tuple[str, float, int]]:
    """Deterministic ranking: score descending, document id ascending."""
    ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    return [(document_id, score, rank) for rank, (document_id, score) in enumerate(ordered, start=1)]


def _excerpt(text: str, terms: list[str], *, length: int = EXCERPT_LENGTH) -> str:
    """A readable window of the indexed text, preferring the first matched term."""
    collapsed = " ".join((text or "").split())
    if len(collapsed) <= length:
        return collapsed
    position = -1
    for term in terms:
        found = collapsed.find(term)
        if found >= 0 and (position < 0 or found < position):
            position = found
    if position < 0:
        return collapsed[:length] + "…"
    start = max(0, position - length // 3)
    end = min(len(collapsed), start + length)
    start = max(0, end - length)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(collapsed) else ""
    return f"{prefix}{collapsed[start:end]}{suffix}"


def _matched_terms(document, query_terms: list[str]) -> list[str]:
    frequencies = document.term_frequencies or {}
    return sorted(term for term in query_terms if frequencies.get(term))


def _result_item(
    document,
    *,
    keyword: tuple[float, int] | None,
    vector: tuple[float, int] | None,
    fused_score: float,
    query_terms: list[str],
) -> dict[str, Any]:
    question = document.question
    node = document.knowledge_node
    channels: list[str] = []
    if keyword is not None:
        channels.append(SearchChannel.KEYWORD.value)
    if vector is not None:
        channels.append(SearchChannel.VECTOR.value)
    return {
        "document_id": str(document.id),
        "kind": document.kind,
        "question_id": str(document.question_id) if document.question_id else None,
        "question_version_id": str(document.question_version_id) if document.question_version_id else None,
        "knowledge_node_id": str(document.knowledge_node_id) if document.knowledge_node_id else None,
        "subject_id": str(document.subject_id) if document.subject_id else None,
        "display_label": (question.display_label if question is not None else "")
        or (node.canonical_name if node is not None else ""),
        "excerpt": _excerpt(document.text, query_terms),
        "keyword_score": round(keyword[0], 6) if keyword is not None else None,
        "keyword_rank": keyword[1] if keyword is not None else None,
        "vector_score": round(vector[0], 6) if vector is not None else None,
        "vector_rank": vector[1] if vector is not None else None,
        "fused_score": round(fused_score, 6),
        "channels": channels,
        "matched_terms": _matched_terms(document, query_terms),
    }


def search(
    *,
    user,
    project,
    query: str,
    subject_id: str | None = None,
    limit: int = 10,
    channel: str = SearchChannel.HYBRID,
) -> dict[str, Any]:
    """Retrieve question versions and knowledge nodes for one project."""
    if channel not in SearchChannel.values:
        raise InvalidInput(
            message="检索通道无效",
            details={"channel": channel, "allowed": list(SearchChannel.values)},
        )
    effective_limit = max(1, min(int(limit or 10), MAX_LIMIT))
    subject = require_subject(user, project, subject_id) if subject_id else None
    text = (query or "").strip()
    query_terms = _ordered_unique(tokenize(text))
    documents = list(index_service.searchable_documents(user=user, project=project, subject=subject))
    by_id = {str(document.id): document for document in documents}

    notes: list[str] = []
    if not query_terms:
        notes.append("查询为空或只包含标点，未产生检索词，因此没有结果。")

    # --- keyword channel (BM25) -------------------------------------------
    keyword_requested = channel in {SearchChannel.KEYWORD.value, SearchChannel.HYBRID.value}
    keyword_ranked = _rank(_bm25_scores(documents, query_terms)) if keyword_requested else []
    keyword_positions = {document_id: (score, rank) for document_id, score, rank in keyword_ranked}

    # --- vector channel (cosine over stored embeddings) --------------------
    vector_requested = channel in {SearchChannel.VECTOR.value, SearchChannel.HYBRID.value}
    availability = vector_service.vector_availability()
    vector_positions: dict[str, tuple[float, int]] = {}
    vector_status: dict[str, Any] = {
        "requested": vector_requested,
        "used": False,
        "available": bool(availability["available"]),
        "reason": availability["reason"],
        "model": availability["model"],
        "dimension": availability["dimension"],
        "provider": availability["provider"],
        "is_stub": availability["is_stub"],
        "hits": 0,
        "compared": 0,
        "documents_with_embeddings": sum(1 for document in documents if document.embedding),
        "skipped_missing_embedding": 0,
        "skipped_vector_mismatch": 0,
        "skipped_non_positive": 0,
    }
    if vector_requested:
        if not availability["available"]:
            notes.append(f"向量通道不可用，未参与排序：{availability['reason']}")
        else:
            try:
                query_vector = vector_service.embed_query_text(text)
            except AiError as exc:
                vector_status["available"] = False
                vector_status["reason"] = f"查询向量化失败：{exc}"
                notes.append(f"向量通道不可用，未参与排序：{vector_status['reason']}")
            else:
                outcome = vector_service.vector_channel(query_vector, documents, limit=effective_limit)
                vector_positions = {hit["document_id"]: (hit["score"], hit["rank"]) for hit in outcome["hits"]}
                vector_status.update(
                    {
                        "used": bool(outcome["hits"]),
                        "hits": outcome["ranked"],
                        "compared": outcome["compared"],
                        "skipped_missing_embedding": outcome["skipped_missing_embedding"],
                        "skipped_vector_mismatch": outcome["skipped_vector_mismatch"],
                        "skipped_non_positive": outcome["skipped_non_positive"],
                    }
                )
    if channel == SearchChannel.VECTOR.value and not vector_status["used"]:
        notes.append(
            "已请求仅向量通道，但该通道没有可用结果，因此 results 为空："
            f"{vector_status['reason'] or '没有匹配的已入库向量'}"
        )

    # --- fusion -----------------------------------------------------------
    fused: dict[str, float] = {}
    if channel == SearchChannel.KEYWORD.value:
        for document_id, (_score, rank) in keyword_positions.items():
            fused[document_id] = 1 / (RRF_K + rank)
    elif channel == SearchChannel.VECTOR.value:
        for document_id, (_score, rank) in vector_positions.items():
            fused[document_id] = 1 / (RRF_K + rank)
    else:
        for positions in (keyword_positions, vector_positions):
            for document_id, (_score, rank) in positions.items():
                fused[document_id] = fused.get(document_id, 0.0) + 1 / (RRF_K + rank)

    ordered_ids = sorted(fused, key=lambda document_id: (-fused[document_id], document_id))[:effective_limit]
    results = [
        _result_item(
            by_id[document_id],
            keyword=keyword_positions.get(document_id),
            vector=vector_positions.get(document_id),
            fused_score=fused[document_id],
            query_terms=query_terms,
        )
        for document_id in ordered_ids
    ]

    return {
        "project_id": str(project.id),
        "subject_id": str(subject.id) if subject is not None else None,
        "query": text,
        "query_tokens": query_terms,
        "channel": channel,
        "limit": effective_limit,
        "candidate_documents": len(documents),
        "tokenizer_version": TOKENIZER_VERSION,
        "fusion": {"method": "rrf", "k": RRF_K} if channel == SearchChannel.HYBRID.value else None,
        "channels": {
            "keyword": {
                "requested": keyword_requested,
                "used": bool(keyword_ranked),
                "available": True,
                "reason": None if query_terms else "查询为空或只包含标点，未产生检索词",
                "documents_scored": len(documents),
                "hits": len(keyword_ranked),
                "k1": BM25_K1,
                "b": BM25_B,
            },
            "vector": vector_status,
        },
        "notes": notes,
        "results": results,
    }
