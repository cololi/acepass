"""Search API: hybrid retrieval and an explicit, idempotent project reindex.

Both operations are owner-scoped through ``require_project``, so another user's
project is a 404 (never a 403 that would confirm it exists). The retrieval
response is the hybrid service payload verbatim — including the channel
availability block — because a caller must be able to see *why* the vector
channel did or did not take part.
"""

from __future__ import annotations

from typing import Any

from ninja import Query, Schema

from apps.audit.services import idempotency
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.enums import SearchChannel
from apps.common.scope import require_project, require_subject
from apps.search.services import hybrid as hybrid_service
from apps.search.services import index as index_service

search_router = project_scoped_router(tags=["search"])


class SearchOut(Schema):
    project_id: str
    subject_id: str | None
    query: str
    query_tokens: list[str]
    channel: str
    limit: int
    candidate_documents: int
    tokenizer_version: str
    fusion: dict[str, Any] | None
    channels: dict[str, Any]
    notes: list[str]
    results: list[dict[str, Any]]


class ReindexIn(Schema):
    subject_id: str | None = None


class ReindexOut(Schema):
    project_id: str
    subject_id: str | None
    indexed: int
    excluded: int
    embeddings: int
    embedding_unavailable_reason: str | None
    embedding_model: str | None
    documents_total: int
    documents_in_index: int
    tokenizer_version: str


@search_router.get("/projects/{project_id}/search", auth=auth, response=SearchOut)
def search(
    request,
    project_id: str,
    q: str,
    subject_id: str | None = None,
    limit: int = Query(10, ge=1, le=50),
    channel: str = SearchChannel.HYBRID.value,
):
    """Hybrid search over published stems, shared material and knowledge nodes.

    ``channel`` selects the ranking channels: ``hybrid`` (default) fuses keyword
    and vector results with reciprocal rank fusion, ``keyword`` uses BM25 alone,
    ``vector`` uses cosine similarity alone. A requested channel that is not
    configured returns HTTP 200 with an empty ``results`` list, an explicit
    ``channels.<name>.reason`` and a note — see ``services/hybrid.py`` for why
    that is chosen over an error status. No answer, rubric or explanation text is
    ever returned: the index holds stem-shaped text only.
    """
    project = require_project(request.user, project_id)
    return hybrid_service.search(
        user=request.user,
        project=project,
        query=q,
        subject_id=subject_id,
        limit=limit,
        channel=channel,
    )


@search_router.post("/projects/{project_id}/search/reindex", auth=auth, response={200: ReindexOut})
def reindex(request, project_id: str, payload: ReindexIn | None = None):
    """Rebuild this project's retrieval index (idempotent per key and per run).

    ``indexed``/``excluded`` partition the rows the run wrote: excluded rows are
    drafts, withdrawn versions, holdout families or out-of-project targets, and
    each one stores its exclusion reason. Re-running with a different key
    rewrites the same rows instead of duplicating them.
    """
    project = require_project(request.user, project_id)
    subject_id = payload.subject_id if payload is not None else None
    subject = require_subject(request.user, project, subject_id) if subject_id else None
    key = idempotency_key(request)
    scope = f"search.reindex:{project_id}"
    body = {"subject_id": str(subject.id) if subject is not None else None}
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    result = index_service.reindex_project(project, subject=subject)
    idempotency.record_result(
        request.user,
        scope,
        key,
        status_code=200,
        response_body=result,
        resource_type="search_index",
        resource_id=project.id,
    )
    return result
