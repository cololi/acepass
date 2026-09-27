"""Syllabus word-list import and manual node editing (P1-02).

A syllabus arrives as a word list, not as a database export: chapters, sections
and points typed with indentation or numbering. This module turns that text into
the node tree the rest of the system already understands, and it is deliberately
strict about the two things that silently corrupt later statistics:

* **synonyms merge, they do not duplicate.** ``导数（微分）`` and a separate
  ``微分`` line are the same point; importing both would split one point's score
  across two rows forever. The canonical name is the one outside the brackets and
  the alternatives become aliases.
* **the tree stays a tree.** Re-parenting is checked against the node's own
  descendants, so a cycle is refused instead of creating a node that can never be
  reached from a root.
"""

from __future__ import annotations

import re
from typing import Any

from django.db import transaction

from apps.audit.models import ContentRevision
from apps.common.errors import InvalidInput
from apps.knowledge.models import KnowledgeNode

#: ``1``, ``1.1``, ``1.1.2``, ``一、``, ``（一）``, ``(1)``, ``- ``, ``* ``
NUMBERING_PATTERN = re.compile(
    r"^\s*(?P<number>(?:\d+\.)*\d+|一二三四五六七八九十]+|[（(]\s*[一二三四五六七八九十\d]+\s*[)）])\s*[.、．)）]?\s+?"
)
BULLET_PATTERN = re.compile(r"^\s*[-*•·]\s+")
#: ``导数（微分）`` / ``导数[微分]`` / ``导数 别名：微分, 求导``
SYNONYM_PATTERNS = (
    re.compile(r"^(?P<name>[^（(\[]+)[（(\[](?P<alias>[^）)\]]+)[）)\]]\s*$"),
    re.compile(r"^(?P<name>.+?)\s*(?:别名|又称|同义词)\s*[:：]\s*(?P<alias>.+)$"),
)
KIND_BY_DEPTH = {0: "chapter", 1: "section"}


def _split_synonyms(text: str) -> tuple[str, list[str]]:
    cleaned = text.strip()
    for pattern in SYNONYM_PATTERNS:
        match = pattern.match(cleaned)
        if match:
            name = match.group("name").strip(" \t-—:：")
            aliases = [part.strip() for part in re.split(r"[,，、;；/]", match.group("alias")) if part.strip()]
            return name or cleaned, aliases
    return cleaned, []


def _depth_and_name(line: str) -> tuple[int, str] | None:
    """Depth from indentation *and* numbering; the larger one wins."""
    if not line.strip():
        return None
    expanded = line.replace("\t", "    ")
    indent = len(expanded) - len(expanded.lstrip(" "))
    indent_depth = indent // 2 if indent >= 2 else 0

    body = expanded.strip()
    bullet = BULLET_PATTERN.match(body)
    if bullet:
        body = body[bullet.end() :].strip()
    number_depth = 0
    match = NUMBERING_PATTERN.match(body)
    if match:
        number = match.group("number")
        if re.fullmatch(r"(?:\d+\.)*\d+", number):
            # "1" is a chapter, "1.1" a section, "1.1.2" a point.
            number_depth = number.count(".")
        else:
            # "一、" / "（一）" style numbering carries one level of hierarchy.
            number_depth = 1
        body = body[match.end() :].strip()
    if not body:
        return None
    return max(indent_depth, number_depth), body


@transaction.atomic
def import_outline(*, syllabus_version, text: str, actor=None, kind_by_depth: dict | None = None) -> dict[str, Any]:
    """Create/merge the node tree of one syllabus from its word list."""
    kinds = {**KIND_BY_DEPTH, **(kind_by_depth or {})}
    created = 0
    merged = 0
    aliases_added: list[dict] = []
    skipped: list[dict] = []

    # parents[depth] = the last node created/merged at that depth, so the next
    # line knows what its parent is. Deeper entries are dropped as soon as a
    # shallower line appears, which keeps a malformed word list from nesting
    # under a node it never mentioned.
    parents: dict[int, KnowledgeNode] = {}
    for index, raw_line in enumerate((text or "").splitlines(), start=1):
        parsed = _depth_and_name(raw_line)
        if parsed is None:
            continue
        depth, body = parsed
        name, aliases = _split_synonyms(body)
        if not name:
            skipped.append({"line": index, "text": raw_line[:120], "reason": "empty_name"})
            continue
        parent = parents.get(depth - 1) if depth > 0 else None
        existing = _find_existing(syllabus_version=syllabus_version, parent=parent, name=name, aliases=aliases)
        if existing is not None:
            merged += 1
            added = _merge_aliases(existing, aliases)
            if added:
                aliases_added.append({"node_id": str(existing.id), "aliases": added})
            node = existing
            if parent is not None and existing.parent_id != parent.id:
                skipped.append(
                    {
                        "line": index,
                        "text": raw_line[:120],
                        "reason": "merged_across_levels",
                        "node_id": str(existing.id),
                    }
                )
        else:
            node = KnowledgeNode.objects.create(
                syllabus_version=syllabus_version,
                parent=parent,
                kind=kinds.get(depth, "point"),
                canonical_name=name,
                aliases=aliases,
                display_order=index,
            )
            created += 1
            if actor is not None:
                ContentRevision.objects.create(
                    actor=actor,
                    entity_type="knowledge_node",
                    entity_id=str(node.id),
                    action="create_from_outline",
                    project_id=syllabus_version.subject.project_id,
                    detail={"depth": depth, "line": index},
                )
        parents[depth] = node
        for deeper in [d for d in parents if d > depth]:
            parents.pop(deeper, None)
    return {
        "created": created,
        "merged": merged,
        "aliases_added": aliases_added,
        "skipped": skipped,
        "node_count": KnowledgeNode.objects.filter(syllabus_version=syllabus_version).count(),
    }


def _find_existing(*, syllabus_version, parent, name: str, aliases: list[str]) -> KnowledgeNode | None:
    candidates = KnowledgeNode.objects.filter(syllabus_version=syllabus_version, parent=parent)
    hit = candidates.filter(canonical_name=name).first()
    if hit is not None:
        return hit
    for alias in aliases:
        hit = candidates.filter(canonical_name=alias).first()
        if hit is not None:
            return hit
        for node in candidates:
            if alias in (node.aliases or []):
                return node
    return None


def _merge_aliases(node: KnowledgeNode, aliases: list[str]) -> list[str]:
    current = list(node.aliases or [])
    added = [alias for alias in aliases if alias not in current and alias != node.canonical_name]
    if added:
        node.aliases = [*current, *added]
        node.save(update_fields=["aliases", "updated_at"])
    return added


def descendants(node: KnowledgeNode) -> list[KnowledgeNode]:
    """Every node below ``node`` (breadth-first, cycle-safe)."""
    out: list[KnowledgeNode] = []
    frontier = [node.id]
    seen = {node.id}
    while frontier:
        children = list(KnowledgeNode.objects.filter(parent_id__in=frontier))
        frontier = []
        for child in children:
            if child.id in seen:
                continue
            seen.add(child.id)
            out.append(child)
            frontier.append(child.id)
    return out


@transaction.atomic
def update_knowledge_node(
    node: KnowledgeNode,
    *,
    actor=None,
    canonical_name: str | None = None,
    aliases: list[str] | None = None,
    parent: KnowledgeNode | None = None,
    move: bool = False,
) -> KnowledgeNode:
    """Rename, re-alias or re-parent one node, refusing anything that loops."""
    locked = KnowledgeNode.objects.select_for_update().get(id=node.id)
    if canonical_name is not None:
        name = canonical_name.strip()
        if not name:
            raise InvalidInput(message="考点名称不能为空")
        locked.canonical_name = name
    if aliases is not None:
        locked.aliases = [str(alias).strip() for alias in aliases if str(alias).strip()]
    if move:
        if parent is not None:
            if parent.syllabus_version_id != locked.syllabus_version_id:
                raise InvalidInput(message="父子考点必须属于同一大纲版本")
            if parent.id == locked.id:
                raise InvalidInput(message="考点不能以自身为父（会形成环）")
            if parent.id in {child.id for child in descendants(locked)}:
                raise InvalidInput(
                    message="不能把考点移动到自己的子节点下：会形成环，之后的覆盖统计将无法回到根节点",
                    details={"node_id": str(locked.id), "parent_id": str(parent.id)},
                )
        locked.parent = parent
    duplicate = (
        KnowledgeNode.objects.filter(
            syllabus_version_id=locked.syllabus_version_id,
            parent=locked.parent,
            canonical_name=locked.canonical_name,
        )
        .exclude(id=locked.id)
        .exists()
    )
    if duplicate:
        raise InvalidInput(message="同一层级下已存在同名考点", details={"name": locked.canonical_name})
    locked.full_clean(exclude=["aliases"])
    locked.save()
    if actor is not None:
        ContentRevision.objects.create(
            actor=actor,
            entity_type="knowledge_node",
            entity_id=str(locked.id),
            action="update",
            project_id=locked.syllabus_version.subject.project_id,
            detail={
                "canonical_name": locked.canonical_name,
                "aliases": locked.aliases,
                "parent_id": str(locked.parent_id) if locked.parent_id else None,
            },
        )
    return locked
