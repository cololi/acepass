"""P1-02 remainder: prerequisite graph and reviewed knowledge-tag suggestions.

Acceptance points covered here (docs/05 §3, B04):

* 前置关系加边产生环时拒绝 — an edge that would close a cycle is refused and the
  offending path names are returned, leaving the graph untouched;
* 标签建议不能直接改受控词表 — a model proposal never creates or renames a node;
  accepting one writes a **new auxiliary mapping revision** (weight 0) and keeps
  the primary weights summing to exactly 1;
* 前置关系辅助补弱 — the daily plan schedules the unmet prerequisite first and
  says so in ``reason_codes``; when the prerequisite has no question at all the
  gap is reported instead of being hidden.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest
from django.utils import timezone

from ai.providers import base as providers
from apps.common.errors import InvalidInput
from apps.knowledge.models import KnowledgeNode, KnowledgeRelation, QuestionKnowledge, TagSuggestion
from apps.knowledge.services import relations as relations_service
from apps.knowledge.services import suggestions as suggestion_services
from apps.learning.models import LearnerKnowledgeState
from apps.learning.services import planner
from apps.question_bank.models import QuestionVersion

pytestmark = pytest.mark.django_db


class _TagProvider(providers.BaseProvider):
    """Deterministic test provider; never a real model result."""

    name = "test-tags"
    capabilities = ("suggest_tags",)
    #: A test double is not a real model result and must be labelled as one.
    is_stub = True

    def __init__(self, payload: dict):
        self.payload = payload

    def call(self, request: providers.AiRequest) -> providers.AiCallResult:
        return providers.AiCallResult(
            payload=self.payload,
            raw_text=json.dumps(self.payload, ensure_ascii=False),
            provider=self.name,
            model="test-tag-model",
            prompt_version=request.prompt_version,
            is_stub=True,
        )


@pytest.fixture
def subject_syllabus(subject_a1):
    from apps.exams.models import SyllabusVersion

    return SyllabusVersion.objects.filter(subject=subject_a1, status="published").first()


@pytest.fixture
def mapped_nodes(subject_a1):
    """Two knowledge points of subject A1 that each own a published question."""
    rows = (
        QuestionKnowledge.objects.filter(
            question_version__question__subject=subject_a1, is_primary=True
        )
        .select_related("node")
        .order_by("node__canonical_name")
    )
    by_node: dict[str, KnowledgeNode] = {}
    for row in rows:
        by_node.setdefault(str(row.node_id), row.node)
    nodes = [node for node in by_node.values() if not node.is_unclassified]
    assert len(nodes) >= 2, "演示夹具应至少有两个已映射考点"
    return nodes[0], nodes[1]


# --------------------------------------------------------------------------
# Prerequisite graph
# --------------------------------------------------------------------------
def test_relation_cycle_is_refused_and_graph_stays_intact(project_a, subject_a1, subject_syllabus):
    nodes = list(KnowledgeNode.objects.filter(syllabus_version=subject_syllabus).order_by("canonical_name")[:3])
    first, second, third = nodes
    relations_service.add_relation(
        syllabus_version=subject_syllabus, from_node=first, to_node=second, actor=project_a.owner
    )
    relations_service.add_relation(
        syllabus_version=subject_syllabus, from_node=second, to_node=third, actor=project_a.owner
    )

    with pytest.raises(InvalidInput) as excinfo:
        relations_service.add_relation(
            syllabus_version=subject_syllabus, from_node=third, to_node=first, actor=project_a.owner
        )
    assert "环" in str(excinfo.value)
    assert excinfo.value.details["cycle_names"][0] == third.canonical_name
    assert excinfo.value.details["cycle_names"][-1] == third.canonical_name
    assert KnowledgeRelation.objects.filter(is_active=True).count() == 2
    # A self-loop is refused before the graph is even consulted.
    with pytest.raises(InvalidInput):
        relations_service.add_relation(
            syllabus_version=subject_syllabus, from_node=first, to_node=first, actor=project_a.owner
        )


def test_relation_endpoints_are_idempotent_and_scoped(caller, other_caller, project_a, subject_syllabus):
    nodes = list(KnowledgeNode.objects.filter(syllabus_version=subject_syllabus).order_by("canonical_name")[:2])
    project_id = project_a.id
    body = {
        "syllabus_version_id": str(subject_syllabus.id),
        "from_node_id": str(nodes[0].id),
        "to_node_id": str(nodes[1].id),
        "relation_type": "prerequisite",
        "note": "先学基础",
    }
    first = caller.post(f"/api/v1/projects/{project_id}/knowledge-relations", body, key="edge-1")
    assert first.status_code == 201, first.content
    replay = caller.post(f"/api/v1/projects/{project_id}/knowledge-relations", body, key="edge-1")
    assert replay.status_code == 201
    assert replay.json()["id"] == first.json()["id"]
    assert KnowledgeRelation.objects.count() == 1

    graph = caller.get(f"/api/v1/projects/{project_id}/knowledge-relations", subject_id=subject_syllabus.subject_id)
    assert graph.status_code == 200
    assert graph.json()["edge_count"] == 1
    assert graph.json()["edges"][0]["from_node_name"] == nodes[0].canonical_name

    # Another user cannot read or write inside this project.
    assert other_caller.get(f"/api/v1/projects/{project_id}/knowledge-relations").status_code == 404
    assert other_caller.post(f"/api/v1/projects/{project_id}/knowledge-relations", body, key="x").status_code == 404

    removed = caller.client.delete(
        f"/api/v1/projects/{project_id}/knowledge-relations/{first.json()['id']}",
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
    )
    assert removed.status_code == 200
    assert removed.json()["is_active"] is False
    assert KnowledgeRelation.objects.count() == 1  # deactivated, never deleted


def test_weak_point_schedules_unmet_prerequisite_first(owner, project_a, subject_syllabus, mapped_nodes):
    prerequisite, dependent = mapped_nodes
    relations_service.add_relation(
        syllabus_version=subject_syllabus, from_node=prerequisite, to_node=dependent, actor=owner
    )
    LearnerKnowledgeState.objects.create(
        user=owner,
        project=project_a,
        syllabus_version=subject_syllabus,
        node=dependent,
        summary="needs_review",
        needs_review=True,
        as_of=timezone.now(),
    )
    rows = planner.weakly_known_candidates(user=owner, project=project_a)
    assert rows, "薄弱考点应产生候选"
    row = rows[0]
    assert row["knowledge_node_id"] == str(prerequisite.id)
    assert "prerequisite_first" in row["reason_codes"]
    assert any(code.startswith("unblocks:") for code in row["reason_codes"])


def test_satisfied_prerequisite_keeps_the_weak_point(owner, project_a, subject_syllabus, mapped_nodes):
    prerequisite, dependent = mapped_nodes
    relations_service.add_relation(
        syllabus_version=subject_syllabus, from_node=prerequisite, to_node=dependent, actor=owner
    )
    now = timezone.now()
    LearnerKnowledgeState.objects.create(
        user=owner,
        project=project_a,
        syllabus_version=subject_syllabus,
        node=dependent,
        summary="needs_review",
        needs_review=True,
        as_of=now,
    )
    LearnerKnowledgeState.objects.create(
        user=owner,
        project=project_a,
        syllabus_version=subject_syllabus,
        node=prerequisite,
        summary="independent",
        best_summary="independent",
        as_of=now,
    )
    rows = planner.weakly_known_candidates(user=owner, project=project_a)
    assert len(rows) == 1
    assert rows[0]["knowledge_node_id"] == str(dependent.id)
    assert "prerequisite_first" not in rows[0]["reason_codes"]


def test_prerequisite_without_any_question_reports_the_gap(owner, project_a, subject_syllabus, mapped_nodes):
    prerequisite, dependent = mapped_nodes
    # A brand-new node has no mapping and no pairing, so no question can be chosen.
    lonely = KnowledgeNode.objects.create(
        syllabus_version=subject_syllabus, parent=None, kind="point", canonical_name="前置但无题考点"
    )
    relations_service.add_relation(
        syllabus_version=subject_syllabus, from_node=lonely, to_node=dependent, actor=owner
    )
    LearnerKnowledgeState.objects.create(
        user=owner,
        project=project_a,
        syllabus_version=subject_syllabus,
        node=dependent,
        summary="needs_review",
        needs_review=True,
        as_of=timezone.now(),
    )
    rows = planner.weakly_known_candidates(user=owner, project=project_a)
    assert rows
    row = rows[0]
    assert row["knowledge_node_id"] == str(dependent.id)
    assert "prerequisite_missing_question" in row["reason_codes"]
    assert "前置考点" in row["deficit_notice"]
    assert prerequisite is not None


# --------------------------------------------------------------------------
# Tag suggestions
# --------------------------------------------------------------------------
def _published_version_question(subject_a1) -> QuestionVersion:
    return (
        QuestionVersion.objects.filter(question__subject=subject_a1, status="published")
        .select_related("question__subject")
        .order_by("question__display_label")
        .first()
    )


def test_tag_suggestion_requires_a_real_provider(owner, subject_a1):
    version = _published_version_question(subject_a1)
    node_count = KnowledgeNode.objects.count()
    with pytest.raises(providers.AiUnavailable):
        suggestion_services.propose_tags(version=version, user=owner, actor=owner)
    assert TagSuggestion.objects.count() == 0
    assert KnowledgeNode.objects.count() == node_count


def test_tag_suggestion_never_widens_the_controlled_vocabulary(owner, subject_a1, subject_syllabus):
    version = _published_version_question(subject_a1)
    known = KnowledgeNode.objects.filter(syllabus_version=subject_syllabus).first().canonical_name
    providers.set_provider_override(
        _TagProvider(
            {
                "tags": [
                    {"name": known, "confidence": 0.9, "rationale": "题干关键词命中"},
                    {"name": "模型自创的考点", "confidence": 0.99, "rationale": "看起来相关"},
                ]
            }
        )
    )
    node_count = KnowledgeNode.objects.count()
    suggestion = suggestion_services.propose_tags(version=version, user=owner, actor=owner)
    assert suggestion.is_stub is True  # a test provider is never presented as a real model
    assert [row["name"] for row in suggestion.proposals] == [known]
    assert suggestion.run.status == "succeeded"
    problems = suggestion.run.validation_result["problems"]
    assert any(problem["code"] == "unknown_tag_name" for problem in problems)
    assert KnowledgeNode.objects.count() == node_count
    assert QuestionKnowledge.objects.filter(
        question_version=version, mapping_revision__gt=1
    ).count() == 0


def test_accepting_a_suggestion_writes_a_new_auxiliary_revision(owner, subject_a1, subject_syllabus):
    version = _published_version_question(subject_a1)
    mapped_ids = set(
        QuestionKnowledge.objects.filter(question_version=version).values_list("node_id", flat=True)
    )
    extra = KnowledgeNode.objects.filter(syllabus_version=subject_syllabus).exclude(id__in=mapped_ids).first()
    assert extra is not None
    providers.set_provider_override(
        _TagProvider({"tags": [{"name": extra.canonical_name, "confidence": 0.7, "rationale": "同章相关"}]})
    )
    suggestion = suggestion_services.propose_tags(version=version, user=owner, actor=owner)
    before_revision = max(
        QuestionKnowledge.objects.filter(question_version=version).values_list("mapping_revision", flat=True)
    )
    before_rows = list(QuestionKnowledge.objects.filter(question_version=version, mapping_revision=before_revision))
    result = suggestion_services.accept_suggestion(suggestion=suggestion, actor=owner, note="人工确认")
    assert result["mapping_revision"] == before_revision + 1
    assert result["added_node_names"] == [extra.canonical_name]
    after_rows = list(QuestionKnowledge.objects.filter(question_version=version, mapping_revision=result["mapping_revision"]))
    assert len(after_rows) == len(before_rows) + 1
    primary_total = sum((row.score_weight for row in after_rows if row.is_primary), Decimal("0"))
    assert primary_total == Decimal("1")
    added = next(row for row in after_rows if str(row.node_id) == str(extra.id))
    assert added.is_primary is False
    assert added.score_weight == Decimal("0")
    # The earlier revision is untouched: old evidence keeps its mapping.
    assert QuestionKnowledge.objects.filter(question_version=version, mapping_revision=before_revision).count() == len(before_rows)
    suggestion.refresh_from_db()
    assert suggestion.status == "accepted"
    assert suggestion.decided_by_id == owner.id


def test_accepting_names_that_do_not_resolve_is_refused(owner, subject_a1, subject_syllabus):
    version = _published_version_question(subject_a1)
    known = KnowledgeNode.objects.filter(syllabus_version=subject_syllabus).first().canonical_name
    providers.set_provider_override(_TagProvider({"tags": [{"name": known, "confidence": 0.5}]}))
    suggestion = suggestion_services.propose_tags(version=version, user=owner, actor=owner)
    with pytest.raises(InvalidInput) as excinfo:
        suggestion_services.accept_suggestion(
            suggestion=suggestion, actor=owner, node_names=["完全不存在的考点"]
        )
    assert "不能创建新考点" in str(excinfo.value)
    suggestion.refresh_from_db()
    assert suggestion.status == "proposed"
    assert KnowledgeNode.objects.filter(canonical_name="完全不存在的考点").count() == 0


def test_rejecting_a_suggestion_changes_nothing(owner, subject_a1, subject_syllabus):
    version = _published_version_question(subject_a1)
    known = KnowledgeNode.objects.filter(syllabus_version=subject_syllabus).first().canonical_name
    providers.set_provider_override(_TagProvider({"tags": [{"name": known, "confidence": 0.4}]}))
    suggestion = suggestion_services.propose_tags(version=version, user=owner, actor=owner)
    revisions_before = set(
        QuestionKnowledge.objects.filter(question_version=version).values_list("mapping_revision", flat=True)
    )
    suggestion_services.reject_suggestion(suggestion=suggestion, actor=owner, note="与题干无关")
    suggestion.refresh_from_db()
    assert suggestion.status == "rejected"
    assert set(
        QuestionKnowledge.objects.filter(question_version=version).values_list("mapping_revision", flat=True)
    ) == revisions_before


def test_tag_suggestion_endpoints_are_owner_scoped(caller, other_caller, project_a, subject_a1):
    version = _published_version_question(subject_a1)
    url = f"/api/v1/projects/{project_a.id}/question-versions/{version.id}/tag-suggestions"
    # No provider configured in the test environment → explicit failure, not a fake suggestion.
    response = caller.post(url, {}, key="tag-1")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ai_not_configured"
    assert TagSuggestion.objects.count() == 0
    assert other_caller.get(url).status_code == 404
    assert other_caller.post(url, {}, key="tag-x").status_code == 404
