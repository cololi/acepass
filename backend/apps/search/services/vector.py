"""Vector channel: cosine ranking over stored embeddings, plus its availability.

The channel is honest about being optional. ``vector_availability`` answers
"may this deployment rank by vector at all, with which model and dimension, and
if not, exactly why" — callers report that answer verbatim instead of degrading
silently. ``vector_channel`` never mixes incomparable vectors: a document is only
scored when its ``embedding_model`` and ``embedding_dim`` match the query vector,
so results embedded by a previous model silently drop out (the counts say so)
rather than being compared on a meaningless cosine.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from typing import Any

from ai.providers.base import AiInvalidOutput, AiUnavailable
from ai.providers.embeddings import get_embedding_provider


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity of two equal-length vectors, in ``[-1, 1]``.

    A zero vector, an empty vector or a length mismatch has no meaningful angle
    and returns ``0.0`` — "no evidence" rather than a fabricated perfect match.
    """
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for left, right in zip(a, b, strict=True):
        dot += left * right
        norm_a += left * left
        norm_b += right * right
    if norm_a <= 0.0 or norm_b <= 0.0:
        return 0.0
    value = dot / (math.sqrt(norm_a) * math.sqrt(norm_b))
    return max(-1.0, min(1.0, value))


def vector_availability() -> dict[str, Any]:
    """Report the vector channel's availability, model, dimension and reason."""
    provider = get_embedding_provider()
    status = {
        "available": False,
        "reason": None,
        "model": provider.model_name or None,
        "dimension": provider.dimension,
        "provider": provider.name,
        "is_stub": provider.is_stub,
    }
    if not provider.is_available:
        status["reason"] = provider.unavailable_reason or "向量通道不可用：未配置向量化模型"
        return status
    if not provider.model_name:
        status["reason"] = "向量化模型未声明模型名称，无法与已入库向量对齐"
        return status
    status["available"] = True
    return status


def embed_query_text(query: str) -> list[float]:
    """Embed one query string; raises ``AiError`` when the channel cannot answer."""
    provider = get_embedding_provider()
    availability = vector_availability()
    if not availability["available"]:
        raise AiUnavailable(availability["reason"] or "向量通道不可用")
    vectors = provider.embed([query])
    if len(vectors) != 1 or not vectors[0]:
        raise AiInvalidOutput("向量化模型未返回查询向量")
    return [float(value) for value in vectors[0]]


def vector_channel(
    query_vector: Sequence[float],
    documents: Iterable,
    *,
    limit: int,
    query_model: str | None = None,
    query_dim: int | None = None,
) -> dict[str, Any]:
    """Rank ``documents`` against ``query_vector`` by cosine similarity.

    ``documents`` are ``SearchDocument``-shaped objects (``id``, ``embedding``,
    ``embedding_model``, ``embedding_dim``). Documents are only compared when the
    embedding model and dimension match the query vector; the returned counters
    make every skip explicit.

    Returns ``{"hits", "compared", "skipped_missing_embedding",
    "skipped_vector_mismatch", "skipped_non_positive", "ranked"}`` where each hit
    is ``{"document", "document_id", "score", "rank", "embedding_model",
    "embedding_dim"}`` ranked from 1. A non-positive cosine score is not ranked:
    an anti-correlated vector is not evidence of relevance, and letting it take
    rank 1 would hand a reciprocal-rank-fusion point to a document the vector
    channel actually argues against.
    """
    model = query_model if query_model is not None else (get_embedding_provider().model_name or "")
    if not model:
        raise AiUnavailable("向量通道不可用：没有已配置的向量化模型名称")
    vector = [float(value) for value in query_vector]
    dimension = query_dim if query_dim is not None else len(vector)

    hits: list[dict[str, Any]] = []
    compared = 0
    skipped_missing = 0
    skipped_mismatch = 0
    skipped_non_positive = 0
    for document in documents:
        embedding = document.embedding
        if not embedding:
            skipped_missing += 1
            continue
        document_model = document.embedding_model or ""
        document_dim = document.embedding_dim or len(embedding)
        if document_model != model or document_dim != dimension:
            skipped_mismatch += 1
            continue
        compared += 1
        score = cosine_similarity(vector, embedding)
        if score <= 0:
            skipped_non_positive += 1
            continue
        hits.append(
            {
                "document": document,
                "document_id": str(document.id),
                "score": round(score, 6),
                "embedding_model": document_model,
                "embedding_dim": document_dim,
            }
        )
    hits.sort(key=lambda hit: (-hit["score"], hit["document_id"]))
    for rank, hit in enumerate(hits[: max(0, int(limit))], start=1):
        hit["rank"] = rank
    ranked = hits[: max(0, int(limit))]
    return {
        "hits": ranked,
        "compared": compared,
        "skipped_missing_embedding": skipped_missing,
        "skipped_vector_mismatch": skipped_mismatch,
        "skipped_non_positive": skipped_non_positive,
        "ranked": len(ranked),
    }
