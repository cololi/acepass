"""Prerequisite graph between knowledge points (P1-02, acceptance B04).

Two rules make the graph trustworthy rather than decorative:

* **it stays a DAG.** A cycle would mean "A needs B and B needs A", from which
  no study order can be derived; an edge that would close a cycle is refused and
  the offending path is returned so the reviewer can fix the real mistake.
* **edges are evidence, not scratch state.** Deactivating keeps the row, so a
  recommendation produced last month can still be explained today.

The graph only *reorders* work. It never invents a score, never changes a
knowledge state, and a missing prerequisite question is reported instead of
being silently replaced by the dependent one.
"""

from __future__ import annotations

from collections import deque

from django.db import transaction
from django.utils import timezone

from apps.audit.models import ContentRevision
from apps.common.enums import KnowledgeRelationType, KnowledgeStateSummary
from apps.common.errors import InvalidInput, ScopeViolation
from apps.knowledge.models import KnowledgeNode, KnowledgeRelation

#: A prerequisite counts as satisfied once the learner can do it unaided.
SATISFIED_STATES = {
    KnowledgeStateSummary.INDEPENDENT,
    KnowledgeStateSummary.HANDLES_UNSEEN,
    KnowledgeStateSummary.DELAYED_VERIFIED,
}


def active_relations(*, syllabus_version, relation_type: str | None = None):
    queryset = KnowledgeRelation.objects.filter(syllabus_version=syllabus_version, is_active=True).select_related(
        "from_node", "to_node"
    )
    if relation_type:
        queryset = queryset.filter(relation_type=relation_type)
    return queryset


def _adjacency(syllabus_version, relation_type: str) -> dict[str, set[str]]:
    graph: dict[str, set[str]] = {}
    for relation in active_relations(syllabus_version=syllabus_version, relation_type=relation_type):
        graph.setdefault(str(relation.from_node_id), set()).add(str(relation.to_node_id))
    return graph


def find_cycle_path(*, from_node: KnowledgeNode, to_node: KnowledgeNode, relation_type: str) -> list[str] | None:
    """Return the path that adding ``from_node -> to_node`` would close.

    Adding the edge creates a cycle exactly when ``to_node`` can already reach
    ``from_node``; the returned path starts at ``from_node`` and ends back at it.
    """
    graph = _adjacency(from_node.syllabus_version, relation_type)
    start = str(to_node.id)
    goal = str(from_node.id)
    if start == goal:
        return [start, goal]
    previous: dict[str, str | None] = {start: None}
    queue: deque[str] = deque([start])
    while queue:
        current = queue.popleft()
        for neighbour in sorted(graph.get(current, ())):
            if neighbour in previous:
                continue
            previous[neighbour] = current
            if neighbour == goal:
                path = [goal]
                node = current
                while node is not None:
                    path.append(node)
                    node = previous[node]
                path.reverse()
                return [goal, *path]
            queue.append(neighbour)
    return None


def _names(node_ids: list[str]) -> list[str]:
    names = {
        str(node_id): name
        for node_id, name in KnowledgeNode.objects.filter(id__in=node_ids).values_list("id", "canonical_name")
    }
    return [names.get(node_id, str(node_id)) for node_id in node_ids]


@transaction.atomic
def add_relation(
    *,
    syllabus_version,
    from_node: KnowledgeNode,
    to_node: KnowledgeNode,
    relation_type: str = KnowledgeRelationType.PREREQUISITE,
    actor=None,
    note: str = "",
) -> KnowledgeRelation:
    """Add one edge, refusing anything that would break the graph."""
    if from_node.syllabus_version_id != syllabus_version.id or to_node.syllabus_version_id != syllabus_version.id:
        raise ScopeViolation(message="关系两端的考点必须属于该大纲版本")
    if from_node.id == to_node.id:
        raise InvalidInput(message="考点不能以自身为前置或相关关系")
    if relation_type not in KnowledgeRelationType.values:
        raise InvalidInput(message="未知的关系类型", details={"relation_type": relation_type})

    cycle = find_cycle_path(from_node=from_node, to_node=to_node, relation_type=relation_type)
    if cycle is not None:
        raise InvalidInput(
            message="加入该关系会形成环，已拒绝",
            details={"cycle_node_ids": cycle, "cycle_names": _names(cycle)},
        )

    existing = KnowledgeRelation.objects.filter(
        from_node=from_node, to_node=to_node, relation_type=relation_type
    ).first()
    if existing is not None:
        if not existing.is_active:
            existing.is_active = True
            existing.note = (note or existing.note)[:300]
            existing.save(update_fields=["is_active", "note", "updated_at"])
        return existing

    relation = KnowledgeRelation.objects.create(
        syllabus_version=syllabus_version,
        from_node=from_node,
        to_node=to_node,
        relation_type=relation_type,
        note=(note or "")[:300],
        created_by=actor,
    )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="knowledge_relation",
        entity_id=str(relation.id),
        action="create",
        project_id=syllabus_version.subject.project_id,
        detail={
            "from_node": str(from_node.id),
            "to_node": str(to_node.id),
            "relation_type": relation_type,
        },
    )
    return relation


@transaction.atomic
def deactivate_relation(*, relation: KnowledgeRelation, actor=None, reason: str = "") -> KnowledgeRelation:
    if relation.is_active:
        relation.is_active = False
        relation.note = (reason or relation.note)[:300]
        relation.save(update_fields=["is_active", "note", "updated_at"])
        ContentRevision.objects.create(
            actor=actor,
            entity_type="knowledge_relation",
            entity_id=str(relation.id),
            action="deactivate",
            project_id=relation.syllabus_version.subject.project_id,
            reason=(reason or "")[:500],
        )
    return relation


def prerequisite_nodes(node: KnowledgeNode) -> list[KnowledgeNode]:
    """Direct prerequisites of ``node`` in the same syllabus version."""
    return [
        relation.from_node
        for relation in active_relations(
            syllabus_version=node.syllabus_version, relation_type=KnowledgeRelationType.PREREQUISITE
        ).filter(to_node=node)
    ]


def unmet_prerequisites(*, node: KnowledgeNode, state_by_node: dict[str, str]) -> list[dict]:
    """Prerequisites that are not yet demonstrated, with the reason why.

    ``state_by_node`` maps ``str(node_id) -> KnowledgeStateSummary``. A node with
    no state at all is *undiagnosed*, which is not the same as "known": it is
    reported as unmet so the planner schedules the foundation first.
    """

    unmet: list[dict] = []
    for prerequisite in prerequisite_nodes(node):
        summary = state_by_node.get(str(prerequisite.id))
        if summary in SATISFIED_STATES:
            continue
        if summary is None:
            reason = "prerequisite_undiagnosed"
        elif summary == KnowledgeStateSummary.NEEDS_REVIEW:
            reason = "prerequisite_needs_review"
        else:
            reason = "prerequisite_not_independent"
        unmet.append(
            {
                "node_id": str(prerequisite.id),
                "node_name": prerequisite.canonical_name,
                "state": summary or KnowledgeStateSummary.UNDIAGNOSED,
                "reason": reason,
            }
        )
    return sorted(unmet, key=lambda row: row["node_name"])


def graph_summary(*, syllabus_version) -> dict:
    """Edges plus the nodes that currently block others, for the UI panel."""
    relations = list(active_relations(syllabus_version=syllabus_version))
    return {
        "edges": [
            {
                "id": str(relation.id),
                "from_node_id": str(relation.from_node_id),
                "from_node_name": relation.from_node.canonical_name,
                "to_node_id": str(relation.to_node_id),
                "to_node_name": relation.to_node.canonical_name,
                "relation_type": relation.relation_type,
                "note": relation.note,
            }
            for relation in relations
        ],
        "node_count": KnowledgeNode.objects.filter(syllabus_version=syllabus_version).count(),
        "edge_count": len(relations),
        "generated_at": timezone.now().isoformat(),
    }
