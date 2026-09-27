"""Hybrid retrieval: ranking, honest degradation and the permission pre-filter.

The tests here are the acceptance evidence for P1-04, so they assert the
*reasons* a channel reports, not only its scores: a vector channel that is not
configured must say so, and content the caller may not retrieve must stay
unreachable even when a crafted provider hands it a perfect similarity.
"""

from __future__ import annotations

import json
from decimal import Decimal
from io import StringIO
from typing import Any
from urllib.parse import urlencode

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db.models import Count
from django.utils import timezone

from ai.providers import embeddings as embedding_providers
from ai.providers.base import AiInvalidOutput, AiUnavailable
from apps.common.enums import AnswerSourceType, MismatchPolicy, OriginType, VerificationStatus
from apps.common.errors import InvalidInput
from apps.question_bank.models import QuestionFamily, QuestionPoolPolicy, QuestionVersion
from apps.question_bank.services import core as qb_services
from apps.search.models import SearchDocument, SearchDocumentKind
from apps.search.services import hybrid as hybrid_service
from apps.search.services import index as index_service
from apps.search.services import vector as vector_service
from apps.search.services.tokenize import TOKENIZER_VERSION
from tests.conftest import OWNER_EMAIL

pytestmark = pytest.mark.django_db

#: Markers let the scripted test provider drive the vector channel deterministically.
STRONG_MARKER = "【甲甲】"
WEAK_MARKER = "【乙乙】"
NEUTRAL_MARKER = "【丙丙】"
HIDDEN_MARKER = "【隐藏哨兵】"
QUERY_MARKER = "【查询哨兵】"

#: Text that exists only in answer material and must never reach a result.
ANSWER_SENTINEL = "答案哨兵值不可泄漏"
RUBRIC_SENTINEL = "评分点哨兵必须核对步骤"
EXPLANATION_SENTINEL = "解析哨兵仅供内部核对"

EMBEDDING_MODEL = "scripted-embedding-v1"


class ScriptedEmbeddingProvider(embedding_providers.BaseEmbeddingProvider):
    """Offline embedding provider whose output is scripted per text marker.

    The vector ranking is asserted exactly, so the provider must not depend on
    anything that changes between runs: no network, no randomness, no hashing.
    """

    name = "scripted_test"
    is_stub = True

    def __init__(
        self,
        script: dict[str, list[float]] | None = None,
        *,
        default: list[float] | None = None,
        model: str = EMBEDDING_MODEL,
    ):
        self.script = dict(script or {})
        self.default = list(default if default is not None else [0.0, 0.0, 1.0, 0.0])
        self.model = model
        self.calls: list[list[str]] = []

    @property
    def is_available(self) -> bool:
        return True

    @property
    def unavailable_reason(self) -> str:
        return ""

    @property
    def model_name(self) -> str:
        return self.model

    @property
    def dimension(self) -> int | None:
        return len(self.default)

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self._vector(text) for text in texts]

    def _vector(self, text: str) -> list[float]:
        for needle, vector in self.script.items():
            if needle in text:
                return list(vector)
        return list(self.default)


@pytest.fixture(autouse=True)
def _reset_embedding_provider():
    yield
    embedding_providers.set_embedding_provider_override(None)


# --------------------------------------------------------------------------
# Fixture content, created through the real question-bank services
# --------------------------------------------------------------------------
def choice_options(texts: tuple[str, ...] = ("甲", "乙", "丙", "丁")) -> list[dict[str, Any]]:
    ids = ("opt_a", "opt_b", "opt_c", "opt_d")
    labels = ("A", "B", "C", "D")
    return [
        {"id": option_id, "label": label, "blocks": [{"kind": "text", "text": text}]}
        for option_id, label, text in zip(ids, labels, texts, strict=False)
    ]


def publish_question(
    subject,
    actor,
    *,
    label: str,
    blocks: list[dict[str, Any]],
    question_type: str = "single_choice",
    options: list[dict[str, Any]] | None = None,
    blanks: list[dict[str, Any]] | None = None,
    answer_payload: dict[str, Any] | None = None,
    rubric_criteria: list[dict[str, Any]] | None = None,
    rubric_total: Decimal | None = None,
    explanation: str | None = None,
    max_score: Decimal = Decimal("2.00"),
    publish: bool = True,
    family=None,
) -> QuestionVersion:
    """Create one question (and its checked answer) through the real services."""
    question = qb_services.create_question(
        subject=subject,
        origin_type=OriginType.DEMO,
        actor=actor,
        display_label=label,
        is_demo=True,
        family=family,
    )
    content: dict[str, Any] = {"blocks": blocks}
    if options is not None:
        content["options"] = options
    if blanks is not None:
        content["blanks"] = blanks
    version = qb_services.create_question_version_draft(
        question,
        question_type=question_type,
        content=content,
        actor=actor,
        practice_max_score=max_score,
        revision_reason="检索模块测试夹具",
    )
    answer = qb_services.create_answer_key_version(
        version,
        answer_payload=answer_payload or {"kind": "single_choice", "correct_option_id": "opt_a"},
        actor=actor,
        source_type=AnswerSourceType.USER,
        verification_status=VerificationStatus.CHECKED,
        check_basis="检索模块测试夹具人工核对",
        explanation_blocks=[{"kind": "text", "text": explanation}] if explanation else [],
    )
    if rubric_criteria:
        qb_services.upsert_rubric_version(
            answer,
            criteria=rubric_criteria,
            total_score=rubric_total,
            actor=actor,
            usage_note="检索模块测试夹具",
        )
    if publish:
        return qb_services.publish_question_version(version, actor=actor)
    return version


@pytest.fixture
def search_content(demo, owner, subject_a1, subject_b1) -> dict[str, Any]:
    """Published and hidden search content in project A subject A1 (+ one B1 question)."""
    strong = publish_question(
        subject_a1,
        owner,
        label="检索-强匹配",
        blocks=[{"kind": "text", "text": f"光合作用{STRONG_MARKER}"}],
        options=choice_options(),
        explanation=EXPLANATION_SENTINEL,
    )
    weak = publish_question(
        subject_a1,
        owner,
        label="检索-弱匹配",
        blocks=[
            {
                "kind": "text",
                "text": f"细胞呼吸发生在线粒体中，与光合作用只有间接关系，请判断下列说法是否正确{WEAK_MARKER}",
            }
        ],
        options=choice_options(("说法一", "说法二", "说法三", "说法四")),
    )
    neutral = publish_question(
        subject_a1,
        owner,
        label="检索-无关",
        blocks=[{"kind": "text", "text": f"酶的催化效率受温度与酸碱度影响{NEUTRAL_MARKER}"}],
        # Deliberately shares no token with the 光合作用 query, so a query that
        # returns it is a ranking bug rather than a lucky substring match.
        options=choice_options(("温度", "酸碱度", "湿度", "底物浓度")),
    )
    hidden_draft = publish_question(
        subject_a1,
        owner,
        label="检索-草稿",
        blocks=[{"kind": "text", "text": f"隐藏内容草稿题{HIDDEN_MARKER}"}],
        options=choice_options(),
        publish=False,
    )
    hidden_withdrawn = publish_question(
        subject_a1,
        owner,
        label="检索-已撤回",
        blocks=[{"kind": "text", "text": f"隐藏内容撤回题{HIDDEN_MARKER}"}],
        options=choice_options(),
    )
    hidden_holdout = publish_question(
        subject_a1,
        owner,
        label="检索-保留",
        blocks=[{"kind": "text", "text": f"隐藏内容保留题{HIDDEN_MARKER}"}],
        options=choice_options(),
    )
    foreign = publish_question(
        subject_b1,
        owner,
        label="检索-跨项目",
        blocks=[{"kind": "text", "text": f"隐藏内容跨项目题{HIDDEN_MARKER}"}],
        options=choice_options(),
    )
    blank = publish_question(
        subject_a1,
        owner,
        label="检索-填空哨兵",
        question_type="fill_blank",
        blocks=[{"kind": "text", "text": "填空哨兵题：请写出最终结果 __b1__。"}],
        blanks=[{"blank_id": "b1", "label": "第1空", "max_score": "2.00"}],
        answer_payload={
            "kind": "fill_blank",
            "blanks": {
                "b1": {
                    "accepted_values": [ANSWER_SENTINEL],
                    "normalization": {"strip_whitespace": True},
                    "max_score": "2.00",
                    "mismatch_policy": MismatchPolicy.REVIEW,
                }
            },
        },
    )
    essay = publish_question(
        subject_a1,
        owner,
        label="检索-大题哨兵",
        question_type="constructed_response",
        blocks=[{"kind": "text", "text": "大题哨兵题：请写出完整推导过程。"}],
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        rubric_criteria=[
            {"criterion_id": "c1", "text": RUBRIC_SENTINEL, "max_score": "10.00", "required": True}
        ],
        rubric_total=Decimal("10.00"),
        max_score=Decimal("10.00"),
        explanation=EXPLANATION_SENTINEL,
    )
    return {
        "strong": strong,
        "weak": weak,
        "neutral": neutral,
        "blank": blank,
        "essay": essay,
        "hidden_draft": hidden_draft,
        "hidden_withdrawn": hidden_withdrawn,
        "hidden_holdout": hidden_holdout,
        "foreign": foreign,
    }


def document_for(version: QuestionVersion) -> SearchDocument:
    return SearchDocument.objects.get(question_version=version, kind=SearchDocumentKind.QUESTION)


def stamp_embedding(document: SearchDocument, vector: list[float], *, model: str = EMBEDDING_MODEL) -> None:
    """Make one index row maximally dangerous: embedded and claiming searchable.

    This is exactly what a row looks like when the content was retrievable when
    the index was built and the index was never rebuilt after it stopped being
    retrievable — the case the live visibility gate has to survive on its own.
    """
    SearchDocument.objects.filter(id=document.id).update(
        embedding=list(vector),
        embedding_model=model,
        embedding_dim=len(vector),
        embedding_updated_at=timezone.now(),
        is_searchable=True,
        exclusion_reason="",
    )


def search_url(project, **params) -> str:
    return f"/api/v1/projects/{project.id}/search?{urlencode(params)}"


# --------------------------------------------------------------------------
# Ranking
# --------------------------------------------------------------------------
def test_exact_stem_query_ranks_first_in_the_keyword_channel(project_a, subject_a1, owner, search_content):
    report = index_service.reindex_project(project_a, subject=subject_a1)
    assert report["indexed"] > 0
    assert report["embeddings"] == 0
    assert "未配置向量化模型" in (report["embedding_unavailable_reason"] or "")

    response = hybrid_service.search(
        user=owner,
        project=project_a,
        query="光合作用",
        subject_id=str(subject_a1.id),
        channel="keyword",
    )
    results = response["results"]
    assert results
    assert results[0]["document_id"] == str(document_for(search_content["strong"]).id)
    assert results[0]["question_id"] == str(search_content["strong"].question_id)
    assert results[0]["kind"] == SearchDocumentKind.QUESTION
    assert results[0]["keyword_rank"] == 1
    assert results[0]["vector_rank"] is None
    assert results[0]["vector_score"] is None
    # Tokens are unigrams + adjacent bigrams: the four-character word is
    # represented by its two bigrams, never as one token.
    assert {"光", "光合", "作用"} <= set(results[0]["matched_terms"])
    assert "光合作用" not in results[0]["matched_terms"]
    assert results[0]["excerpt"].startswith("光合作用")
    # The weak match is the longer stem that mentions the phrase once.
    assert results[1]["document_id"] == str(document_for(search_content["weak"]).id)
    assert response["channels"]["vector"]["used"] is False
    assert response["channels"]["keyword"]["k1"] == hybrid_service.BM25_K1
    assert response["channels"]["keyword"]["b"] == hybrid_service.BM25_B
    assert response["tokenizer_version"] == TOKENIZER_VERSION


def test_vector_channel_reports_an_explicit_reason_and_degrades_to_keyword(
    caller, project_a, subject_a1, search_content
):
    report = index_service.reindex_project(project_a, subject=subject_a1)
    assert report["embeddings"] == 0

    payload = caller.get(
        search_url(project_a, q="光合作用", subject_id=str(subject_a1.id))
    ).json()
    vector = payload["channels"]["vector"]
    assert vector["available"] is False
    assert vector["used"] is False
    assert vector["reason"] and "未配置向量化模型" in vector["reason"]
    assert vector["documents_with_embeddings"] == 0
    assert any("向量通道不可用" in note for note in payload["notes"])
    # Keyword results are still delivered: the degradation is announced, not silent.
    assert payload["results"]
    assert payload["channels"]["keyword"]["used"] is True
    assert payload["results"][0]["document_id"] == str(document_for(search_content["strong"]).id)


def test_installed_provider_is_used_and_fusion_changes_the_order(project_a, subject_a1, owner, search_content):
    provider = ScriptedEmbeddingProvider(
        script={
            QUERY_MARKER: [1.0, 0.0, 0.0, 0.0],
            WEAK_MARKER: [1.0, 0.0, 0.0, 0.0],
            NEUTRAL_MARKER: [0.98, 0.02, 0.0, 0.0],
            STRONG_MARKER: [0.1, 0.99, 0.0, 0.0],
        }
    )
    embedding_providers.set_embedding_provider_override(provider)
    report = index_service.reindex_project(project_a, subject=subject_a1)
    assert report["embeddings"] == report["indexed"]
    assert report["embedding_unavailable_reason"] is None
    assert report["embedding_model"] == EMBEDDING_MODEL

    strong_document = document_for(search_content["strong"])
    weak_document = document_for(search_content["weak"])
    neutral_document = document_for(search_content["neutral"])
    for document in (strong_document, weak_document, neutral_document):
        document.refresh_from_db()
        assert document.embedding_model == EMBEDDING_MODEL
        assert document.embedding_dim == 4

    query = f"光合作用{QUERY_MARKER}"
    keyword = hybrid_service.search(
        user=owner, project=project_a, query=query, subject_id=str(subject_a1.id), channel="keyword"
    )
    vector = hybrid_service.search(
        user=owner, project=project_a, query=query, subject_id=str(subject_a1.id), channel="vector"
    )
    hybrid = hybrid_service.search(
        user=owner, project=project_a, query=query, subject_id=str(subject_a1.id), channel="hybrid"
    )

    assert [hit["document_id"] for hit in keyword["results"]][:2] == [
        str(strong_document.id),
        str(weak_document.id),
    ]
    assert [hit["document_id"] for hit in vector["results"]][:3] == [
        str(weak_document.id),
        str(neutral_document.id),
        str(strong_document.id),
    ]

    # RRF: weak = 1/(60+2) + 1/(60+1) > strong = 1/(60+1) + 1/(60+3)
    assert [hit["document_id"] for hit in hybrid["results"]][:2] == [
        str(weak_document.id),
        str(strong_document.id),
    ]
    winner, runner_up = hybrid["results"][0], hybrid["results"][1]
    assert winner["keyword_rank"] == 2
    assert winner["vector_rank"] == 1
    assert runner_up["keyword_rank"] == 1
    assert runner_up["vector_rank"] == 3
    assert winner["fused_score"] > runner_up["fused_score"]
    assert winner["channels"] == ["keyword", "vector"]
    assert hybrid["fusion"] == {"method": "rrf", "k": hybrid_service.RRF_K}
    assert keyword["fusion"] is None

    status = hybrid["channels"]["vector"]
    assert status["available"] is True
    assert status["used"] is True
    assert status["model"] == EMBEDDING_MODEL
    assert status["dimension"] == 4
    assert status["is_stub"] is True  # a test provider is never presented as real
    assert status["compared"] == status["documents_with_embeddings"]
    assert status["skipped_non_positive"] > 0  # orthogonal vectors are not ranked


# --------------------------------------------------------------------------
# Permission pre-filter
# --------------------------------------------------------------------------
def test_withheld_content_is_never_returned_even_at_cosine_one(
    project_a, project_b, subject_a1, owner, search_content
):
    provider = ScriptedEmbeddingProvider(
        script={QUERY_MARKER: [1.0, 0.0, 0.0, 0.0], HIDDEN_MARKER: [1.0, 0.0, 0.0, 0.0]}
    )
    embedding_providers.set_embedding_provider_override(provider)
    # Index while every hidden question is still retrievable, so each one gets a
    # real embedding; the state changes below happen *after* the index was built.
    index_service.reindex_project(project_a, subject=subject_a1)
    index_service.reindex_project(project_b)

    qb_services.withdraw_question_version(
        search_content["hidden_withdrawn"], actor=owner, reason="检索测试：撤回后不得再被检索"
    )
    QuestionPoolPolicy.objects.create(
        project=project_a,
        question=search_content["hidden_holdout"].question,
        is_holdout=True,
        changed_by=owner,
        change_reason="检索测试：标记保留",
    )
    draft_document = index_service.index_question_version(search_content["hidden_draft"], embed=False)
    stamp_embedding(draft_document, [1.0, 0.0, 0.0, 0.0])

    hidden_documents = {
        "draft": draft_document,
        "withdrawn": document_for(search_content["hidden_withdrawn"]),
        "holdout": document_for(search_content["hidden_holdout"]),
        "foreign": document_for(search_content["foreign"]),
    }
    query = f"隐藏内容{QUERY_MARKER}"
    query_vector = vector_service.embed_query_text(query)
    for name, document in hidden_documents.items():
        document.refresh_from_db()
        assert document.embedding, f"{name} 的向量未写入，测试前提不成立"
        assert vector_service.cosine_similarity(query_vector, document.embedding) == pytest.approx(1.0)
    # The local ones still claim to be searchable: only the live gate excludes them.
    assert hidden_documents["draft"].is_searchable is True
    assert hidden_documents["withdrawn"].is_searchable is True
    assert hidden_documents["holdout"].is_searchable is True

    hidden_ids = {str(document.id) for document in hidden_documents.values()}
    # Control: the very same content IS returned inside its own project, so the
    # exclusion below is caused by the scope gate and not by an empty channel.
    control = hybrid_service.search(user=owner, project=project_b, query=query, channel="vector")
    assert str(hidden_documents["foreign"].id) in {hit["document_id"] for hit in control["results"]}

    candidate_ids = {
        str(document.id)
        for document in index_service.searchable_documents(user=owner, project=project_a, subject=subject_a1)
    }
    assert not (candidate_ids & hidden_ids)

    for channel in ("keyword", "vector", "hybrid"):
        response = hybrid_service.search(
            user=owner,
            project=project_a,
            query=query,
            subject_id=str(subject_a1.id),
            limit=50,
            channel=channel,
        )
        returned = {hit["document_id"] for hit in response["results"]}
        assert not (returned & hidden_ids), f"{channel} 泄漏了不可检索文档"

    # Re-indexing marks the two policy-driven exclusions with their reason.
    refreshed = index_service.reindex_project(project_a, subject=subject_a1)
    assert refreshed["excluded"] >= 2
    assert document_for(search_content["hidden_withdrawn"]).is_searchable is False
    assert "withdrawn" in document_for(search_content["hidden_withdrawn"]).exclusion_reason
    assert document_for(search_content["hidden_holdout"]).is_searchable is False
    assert "holdout" in document_for(search_content["hidden_holdout"]).exclusion_reason


def test_family_level_holdout_excludes_every_member_question(project_a, subject_a1, owner, search_content):
    """A holdout on the family seals its questions, not only the named one."""
    family = QuestionFamily.objects.create(subject=subject_a1, name="检索测试家族", relation_confirmed=True)
    member = publish_question(
        subject_a1,
        owner,
        label="检索-家族成员",
        blocks=[{"kind": "text", "text": f"隐藏内容家族成员题{HIDDEN_MARKER}"}],
        options=choice_options(),
        family=family,
    )
    index_service.reindex_project(project_a, subject=subject_a1)
    member_document = document_for(member)
    assert member_document.is_searchable is True

    QuestionPoolPolicy.objects.create(
        project=project_a,
        family=family,
        is_holdout=True,
        changed_by=owner,
        change_reason="检索测试：整个题族封存",
    )

    candidates = {
        str(document.id)
        for document in index_service.searchable_documents(user=owner, project=project_a, subject=subject_a1)
    }
    assert str(member_document.id) not in candidates
    response = hybrid_service.search(
        user=owner,
        project=project_a,
        query=f"隐藏内容{HIDDEN_MARKER}",
        subject_id=str(subject_a1.id),
        channel="hybrid",
        limit=50,
    )
    assert str(member_document.id) not in {hit["document_id"] for hit in response["results"]}

    index_service.reindex_project(project_a, subject=subject_a1)
    refreshed = document_for(member)
    assert refreshed.is_searchable is False
    assert "holdout" in refreshed.exclusion_reason


def test_remove_document_purges_rows_and_requires_a_target(project_a, subject_a1, owner, search_content):
    index_service.reindex_project(project_a, subject=subject_a1)
    version = search_content["hidden_withdrawn"]
    assert SearchDocument.objects.filter(question_version=version).exists()

    assert index_service.remove_document(question_version=version) == 1
    assert not SearchDocument.objects.filter(question_version=version).exists()

    with pytest.raises(InvalidInput):
        index_service.remove_document()

    node_document = (
        index_service.searchable_documents(user=owner, project=project_a, subject=subject_a1)
        .filter(kind=SearchDocumentKind.NODE)
        .first()
    )
    assert node_document is not None
    assert index_service.remove_document(knowledge_node=node_document.knowledge_node) == 1


def test_other_projects_subject_is_a_404(caller, project_a, subject_b1, search_content):
    response = caller.get(search_url(project_a, q="隐藏内容", subject_id=str(subject_b1.id)))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    missing = caller.get(search_url(project_a, q="隐藏内容", subject_id="00000000-0000-0000-0000-000000000000"))
    assert missing.status_code == 404


def test_another_users_project_is_a_404(other_caller, project_a):
    assert other_caller.get(search_url(project_a, q="演示")).status_code == 404
    assert other_caller.post(f"/api/v1/projects/{project_a.id}/search/reindex", {}, key="foreign").status_code == 404


# --------------------------------------------------------------------------
# Answer-leak rule
# --------------------------------------------------------------------------
def test_serialized_results_contain_no_answer_rubric_or_explanation_text(
    caller, project_a, subject_a1, search_content
):
    index_service.reindex_project(project_a, subject=subject_a1)
    response = caller.get(search_url(project_a, q="哨兵题", subject_id=str(subject_a1.id), limit=50))
    assert response.status_code == 200
    body = response.json()
    returned = {hit["document_id"] for hit in body["results"]}
    # Both answer-bearing questions must actually be in the response, otherwise
    # the leak assertion below would be vacuous.
    assert str(document_for(search_content["blank"]).id) in returned
    assert str(document_for(search_content["essay"]).id) in returned

    # Django escapes non-ASCII in the byte stream, so the meaningful check is the
    # decoded payload re-encoded without escaping.
    serialized = json.dumps(body, ensure_ascii=False)
    assert ANSWER_SENTINEL not in serialized
    assert RUBRIC_SENTINEL not in serialized
    assert EXPLANATION_SENTINEL not in serialized
    assert "correct_option_id" not in serialized
    assert "accepted_values" not in serialized
    assert "explanation_blocks" not in serialized
    # Only stem-shaped text is exposed.
    essay_hit = next(hit for hit in body["results"] if hit["document_id"] == str(document_for(search_content["essay"]).id))
    assert "大题哨兵题" in essay_hit["excerpt"]


# --------------------------------------------------------------------------
# Reindex
# --------------------------------------------------------------------------
def test_reindex_is_idempotent_and_never_duplicates_rows(caller, project_a, subject_a1, search_content):
    first = caller.post(
        f"/api/v1/projects/{project_a.id}/search/reindex", {"subject_id": str(subject_a1.id)}, key="reindex-1"
    )
    assert first.status_code == 200, first.content
    body = first.json()
    assert body["indexed"] + body["excluded"] == body["documents_total"]
    assert body["documents_in_index"] == body["documents_total"]
    assert body["subject_id"] == str(subject_a1.id)
    rows_after_first = SearchDocument.objects.filter(project=project_a, subject=subject_a1).count()

    second = caller.post(
        f"/api/v1/projects/{project_a.id}/search/reindex", {"subject_id": str(subject_a1.id)}, key="reindex-2"
    )
    assert second.status_code == 200
    assert second.json() == body
    assert SearchDocument.objects.filter(project=project_a, subject=subject_a1).count() == rows_after_first

    replay = caller.post(
        f"/api/v1/projects/{project_a.id}/search/reindex", {"subject_id": str(subject_a1.id)}, key="reindex-1"
    )
    assert replay.json() == body

    duplicates = (
        SearchDocument.objects.filter(project=project_a, kind=SearchDocumentKind.QUESTION)
        .values("question_version")
        .annotate(rows=Count("id"))
        .filter(rows__gt=1)
    )
    assert not duplicates.exists()


def test_reindex_requires_an_idempotency_key(caller, project_a, subject_a1, search_content):
    response = caller.client.post(
        f"/api/v1/projects/{project_a.id}/search/reindex",
        data=json.dumps({}),
        content_type="application/json",
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"


def test_reindex_accepts_an_absent_body(caller, project_a, subject_a1, search_content):
    """``subject_id`` is optional, so the whole body is: no body means the project."""
    response = caller.post(f"/api/v1/projects/{project_a.id}/search/reindex", None, key="reindex-no-body")
    assert response.status_code == 200, response.content
    assert response.json()["subject_id"] is None
    assert response.json()["documents_total"] > 0


# --------------------------------------------------------------------------
# API surface
# --------------------------------------------------------------------------
def test_api_payload_matches_the_service_and_validates_input(caller, project_a, subject_a1, owner, search_content):
    index_service.reindex_project(project_a, subject=subject_a1)
    body = caller.get(
        search_url(project_a, q="光合作用", subject_id=str(subject_a1.id), limit=3, channel="hybrid")
    ).json()
    expected = hybrid_service.search(
        user=owner,
        project=project_a,
        query="光合作用",
        subject_id=str(subject_a1.id),
        limit=3,
        channel="hybrid",
    )
    assert body == expected
    assert body["limit"] == 3
    assert body["tokenizer_version"] == TOKENIZER_VERSION

    assert caller.get(f"/api/v1/projects/{project_a.id}/search").status_code == 400
    assert caller.get(search_url(project_a, q="演示", limit=51)).status_code == 400
    assert caller.get(search_url(project_a, q="演示", channel="vector2")).status_code == 400


def test_requested_vector_channel_without_a_provider_is_explicit_not_silent(
    caller, project_a, subject_a1, search_content
):
    index_service.reindex_project(project_a, subject=subject_a1)
    response = caller.get(search_url(project_a, q="光合作用", subject_id=str(subject_a1.id), channel="vector"))
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == []
    assert body["channels"]["vector"]["available"] is False
    assert body["channels"]["vector"]["reason"]
    assert any("results 为空" in note for note in body["notes"])


def test_empty_query_reports_why_there_are_no_results(caller, project_a, subject_a1, search_content):
    index_service.reindex_project(project_a, subject=subject_a1)
    body = caller.get(search_url(project_a, q="，。")).json()
    assert body["query_tokens"] == []
    assert body["results"] == []
    assert any("未产生检索词" in note for note in body["notes"])


def test_results_are_ordered_by_fused_score_then_document_id(caller, project_a, subject_a1, search_content):
    """The documented tie-break must hold on real data, not just in analysis."""
    index_service.reindex_project(project_a, subject=subject_a1)
    body = caller.get(search_url(project_a, q="光合作用", subject_id=str(subject_a1.id), limit=50)).json()
    ordering = [(hit["fused_score"], hit["document_id"]) for hit in body["results"]]
    assert ordering == sorted(ordering, key=lambda item: (-item[0], item[1]))


# --------------------------------------------------------------------------
# Embedding provider contract (offline: no provider call is made)
# --------------------------------------------------------------------------
def test_unconfigured_deployment_never_fabricates_vectors(settings):
    settings.AI_PROVIDER = "none"
    provider = embedding_providers.get_embedding_provider()
    assert isinstance(provider, embedding_providers.NullEmbeddingProvider)
    assert provider.is_available is False
    assert "未配置向量化模型" in provider.unavailable_reason
    assert vector_service.vector_availability()["available"] is False
    with pytest.raises(AiUnavailable):
        provider.embed(["光合作用"])

    # The chat stub is for deterministic text tests; it must not invent vectors.
    settings.AI_PROVIDER = "stub"
    settings.AI_ALLOW_STUB = True
    assert isinstance(embedding_providers.get_embedding_provider(), embedding_providers.NullEmbeddingProvider)


def test_openai_compatible_embedding_provider_reports_which_setting_is_missing(settings):
    settings.AI_PROVIDER = "openai_compatible"
    settings.AI_BASE_URL = "https://example.invalid/v1"
    settings.AI_API_KEY = ""
    settings.ACEPASS_AI_EMBEDDING_MODEL = "text-embedding-3-small"
    provider = embedding_providers.get_embedding_provider()
    assert provider.is_available is False
    assert "ACEPASS_AI_API_KEY" in provider.unavailable_reason

    settings.AI_API_KEY = "test-key"
    settings.ACEPASS_AI_EMBEDDING_MODEL = ""
    provider = embedding_providers.get_embedding_provider()
    assert provider.is_available is False
    assert "ACEPASS_AI_EMBEDDING_MODEL" in provider.unavailable_reason

    settings.ACEPASS_AI_EMBEDDING_MODEL = "text-embedding-3-small"
    provider = embedding_providers.get_embedding_provider()
    assert provider.is_available is True
    assert provider.model_name == "text-embedding-3-small"
    assert provider._endpoint() == "https://example.invalid/v1/embeddings"


def test_openai_compatible_embedding_response_is_parsed_strictly():
    """The wire format is pinned without a network call (tests stay offline)."""
    provider = embedding_providers.OpenAICompatibleEmbeddingProvider(
        base_url="https://example.invalid/v1", api_key="k", model="m"
    )
    payload = json.dumps({"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]})
    assert provider._parse(payload, expected=2) == [[1.0, 0.0], [0.0, 1.0]]
    assert provider.dimension == 2  # observed from the first successful call

    with pytest.raises(AiInvalidOutput):
        provider._parse(json.dumps({"data": [{"index": 0, "embedding": [1.0, 0.0]}]}), expected=2)
    with pytest.raises(AiInvalidOutput):
        provider._parse(json.dumps({"data": [{"index": 0, "embedding": ["not-a-number"]}]}), expected=1)
    with pytest.raises(AiInvalidOutput):
        provider._parse(json.dumps({"data": [{"index": 0, "embedding": [1.0, 2.0, 3.0]}]}), expected=1)


# --------------------------------------------------------------------------
# search_eval (acceptance evidence)
# --------------------------------------------------------------------------
def run_search_eval(**options) -> tuple[str, str, int]:
    """Run the command and return (stdout, error message, exit code)."""
    out, err = StringIO(), StringIO()
    code = 0
    error = ""
    try:
        call_command("search_eval", stdout=out, stderr=err, **options)
    except CommandError as exc:
        code = 1
        error = str(exc)
    return out.getvalue(), error, code


def write_gold(tmp_path, queries: list[dict[str, Any]]) -> str:
    path = tmp_path / "gold.json"
    path.write_text(json.dumps({"queries": queries}, ensure_ascii=False), encoding="utf-8")
    return str(path)


def test_search_eval_resolves_labels_and_passes(tmp_path, project_a, subject_a1, search_content):
    index_service.reindex_project(project_a, subject=subject_a1)
    gold = write_gold(
        tmp_path,
        [{"id": "q1", "query": "光合作用", "expected_labels": ["检索-强匹配"], "note": "同义题干"}],
    )
    out, error, code = run_search_eval(
        project=str(project_a.id), user=OWNER_EMAIL, gold=gold, k="5", min_recall=1.0
    )
    assert code == 0, f"{error}\n{out}"
    assert "result passed=True" in out
    assert "rank=1" in out
    assert f"tokenizer={TOKENIZER_VERSION}" in out
    assert "channel vector available=False" in out


def test_search_eval_fails_loudly_on_an_unresolved_label(tmp_path, project_a, subject_a1, search_content):
    index_service.reindex_project(project_a, subject=subject_a1)
    gold = write_gold(
        tmp_path, [{"id": "q1", "query": "光合作用", "expected_labels": ["不存在的标签"]}]
    )
    out, error, code = run_search_eval(project=str(project_a.id), user=OWNER_EMAIL, gold=gold, k="5")
    assert code == 1
    assert "无法解析" in error
    assert "不存在的标签" in error
    assert "unresolved_label" in out
    assert "result passed=False" in out


def test_search_eval_gate_fails_when_recall_is_below_the_threshold(tmp_path, project_a, subject_a1, search_content):
    index_service.reindex_project(project_a, subject=subject_a1)
    gold = write_gold(
        tmp_path,
        [
            {
                "id": "q1",
                "query": "光合作用",
                "expected_labels": ["检索-强匹配", "检索-无关"],
            }
        ],
    )
    out, error, code = run_search_eval(
        project=str(project_a.id), user=OWNER_EMAIL, gold=gold, k="5", min_recall=1.0
    )
    assert code == 1, out
    assert "未达标" in error
    assert "miss label=检索-无关" in out
    assert "threshold k=5" in out


def test_search_eval_json_report_is_self_describing(tmp_path, project_a, subject_a1, search_content):
    index_service.reindex_project(project_a, subject=subject_a1)
    gold = write_gold(
        tmp_path,
        [
            {"id": "q1", "query": "光合作用", "expected_labels": ["检索-强匹配"]},
            {
                "id": "q2",
                "query": "哨兵题",
                "expected_labels": ["检索-填空哨兵"],
                "expected_question_ids": [str(search_content["blank"].question_id)],
            },
        ],
    )
    out, error, code = run_search_eval(
        project=str(project_a.id), user=OWNER_EMAIL, gold=gold, k="5,10", json=True, min_recall=1.0
    )
    assert code == 0, f"{error}\n{out}"
    payload = json.loads(out)
    assert payload["command"] == "search_eval"
    assert payload["tokenizer_version"] == TOKENIZER_VERSION
    assert payload["channel"] == "hybrid"
    assert payload["project_id"] == str(project_a.id)
    assert payload["k_values"] == [5, 10]
    assert payload["threshold_applied"] is True
    assert payload["passed"] is True
    assert payload["unresolved_labels"] == []
    assert payload["document_counts"]["searchable_documents"] > 0
    assert payload["document_counts"]["distinct_labels"] > 0
    assert payload["channels"]["vector"]["available"] is False
    assert payload["channels"]["keyword"]["available"] is True
    assert payload["channels"]["vector"]["reason"]
    assert [query["id"] for query in payload["queries"]] == ["q1", "q2"]
    assert payload["queries"][0]["first_hit_rank"] == 1
    assert payload["queries"][1]["recall"]["5"] == 1.0
    assert payload["aggregate"]["mean_recall"]["5"] == 1.0
    assert payload["aggregate"]["mrr"] == 1.0
    assert payload["thresholds"]["10"]["passed"] is True


def test_search_eval_print_gold_template_lists_labels_without_a_gold_file(
    project_a, project_b, subject_a1, search_content
):
    index_service.reindex_project(project_a, subject=subject_a1)
    out, error, code = run_search_eval(
        project=str(project_a.id), user=OWNER_EMAIL, print_gold_template=True
    )
    assert code == 0, error
    template = json.loads(out)
    assert template["project_id"] == str(project_a.id)
    assert template["tokenizer_version"] == TOKENIZER_VERSION
    assert template["index_empty"] is False
    assert template["distinct_labels"] > 0
    labels = {entry["label"] for entry in template["available"]["questions"]}
    assert {"检索-强匹配", "检索-弱匹配", "检索-无关"} <= labels
    assert all(entry["resolved_ids"] for entry in template["available"]["questions"])
    assert template["queries"]  # a skeleton entry showing the accepted shape

    # An unbuilt index must not yield a silently empty label list.
    out_b, error_b, code_b = run_search_eval(
        project=str(project_b.id), user=OWNER_EMAIL, print_gold_template=True
    )
    assert code_b == 1
    assert "没有可检索的索引文档" in error_b
    assert json.loads(out_b)["index_empty"] is True


def test_search_eval_rejects_a_gold_entry_without_expectations(tmp_path, project_a, subject_a1, search_content):
    gold = write_gold(tmp_path, [{"id": "q1", "query": "光合作用"}])
    _out, error, code = run_search_eval(project=str(project_a.id), user=OWNER_EMAIL, gold=gold)
    assert code == 1
    assert "expected_" in error
