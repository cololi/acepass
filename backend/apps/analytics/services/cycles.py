"""Real paper cycle analysis (P1-03).

The product question is "how is the score distributed across cycles, and what is
still uncovered" — and the honest answer depends entirely on which papers may be
counted. This module therefore refuses to estimate:

* only **real occurrence records** count. Demo fixtures, mock papers and practice
  sets are excluded by ``source_kind`` and ``is_demo``, so a demo dataset can
  never masquerade as an official distribution;
* a cycle only counts when **every** registered paper in it has a *confirmed*
  revision whose coverage was manually marked complete. A single uploaded paper
  never proves a whole year, which is exactly what ``coverage_incomplete`` and
  ``coverage_unknown`` exist for;
* the denominator is stated per cycle (the total scored marks of that cycle's
  effective revisions) and questions whose score is unknown stay out of it;
* weights are counted once: the primary mapping weights of one question version
  already sum to 1 (enforced on write), auxiliary tags carry weight 0, and any
  scored item with no mapping falls into an explicit ``未分类`` bucket instead of
  silently disappearing. ``share_total`` is reported so the caller can see that
  the shares add up to at most 1 — never more.

Five complete cycles is the requested horizon; with fewer, the report says so
(``insufficient_cycles``) and lists what is missing instead of averaging over
whatever happens to be there.
"""

from __future__ import annotations

from decimal import Decimal

from apps.common.enums import PaperRevisionStatus, SourceKind
from apps.exams.models import Paper

#: The analysis horizon: "近五年" means five *complete* cycles, never five rows.
DEFAULT_CYCLE_COUNT = 5
UNCLASSIFIED_LABEL = "未分类"


def _cycle_sort_key(cycle_key: str) -> tuple[int, str]:
    """Sort cycles by their leading year when there is one, else lexically."""
    digits = ""
    for character in cycle_key:
        if character.isdigit():
            digits += character
        else:
            break
    return (int(digits) if len(digits) >= 4 else 0, cycle_key)


def paper_is_countable(paper: Paper) -> tuple[bool, str]:
    if paper.is_demo:
        return False, "demo_or_mock"
    if paper.source_kind != SourceKind.OFFICIAL_PAST:
        return False, f"source_kind={paper.source_kind}"
    revision = paper.effective_revision
    if revision is None:
        return False, "no_effective_revision"
    if revision.status != PaperRevisionStatus.CONFIRMED:
        return False, "revision_not_confirmed"
    status = revision.coverage_status
    if status != "coverage_complete":
        return False, status
    if not revision.items.filter(is_scored=True).exists():
        return False, "no_scored_items"
    return True, "counted"


def _node_shares(items) -> tuple[dict[str, dict], Decimal]:
    """Per-node score of one cycle plus the denominator actually used."""
    per_node: dict[str, dict] = {}
    total = Decimal("0")
    for item in items:
        score = Decimal(item.max_score)
        total += score
        mappings = [
            mapping
            for mapping in item.question_version.knowledge_mappings.filter(
                mapping_revision=_latest_mapping_revision(item.question_version)
            ).select_related("node")
            if mapping.is_primary and Decimal(mapping.score_weight) > 0
        ]
        if not mappings:
            bucket = per_node.setdefault(
                "__unclassified__",
                {"node_id": None, "label": UNCLASSIFIED_LABEL, "score": Decimal("0"), "unclassified": True},
            )
            bucket["score"] += score
            continue
        weight_total = sum((Decimal(mapping.score_weight) for mapping in mappings), Decimal("0"))
        for mapping in mappings:
            weight = Decimal(mapping.score_weight)
            share = score * weight / weight_total if weight_total > 0 else score
            bucket = per_node.setdefault(
                str(mapping.node_id),
                {
                    "node_id": str(mapping.node_id),
                    "label": mapping.node.canonical_name,
                    "path": _node_path(mapping.node),
                    "score": Decimal("0"),
                    "unclassified": False,
                },
            )
            bucket["score"] += share
    return per_node, total


def _latest_mapping_revision(question_version) -> int:
    latest = 0
    for mapping in question_version.knowledge_mappings.all():
        latest = max(latest, mapping.mapping_revision)
    return latest


def _node_path(node) -> str:
    names = [node.canonical_name]
    for ancestor in node.ancestors():
        names.append(ancestor.canonical_name)
    return " / ".join(reversed(names))


def cycle_analysis(*, subject, max_cycles: int = DEFAULT_CYCLE_COUNT) -> dict:
    """Distribution over the most recent complete real cycles of one subject."""
    papers = list(
        Paper.objects.filter(subject=subject)
        .select_related("effective_revision")
        .prefetch_related("effective_revision__items__question_version")
        .order_by("cycle_key")
    )
    by_cycle: dict[str, list[Paper]] = {}
    for paper in papers:
        by_cycle.setdefault(paper.cycle_key, []).append(paper)

    cycles: list[dict] = []
    for cycle_key, cycle_papers in by_cycle.items():
        reasons: list[dict] = []
        complete = True
        verdicts: dict[str, tuple[bool, str]] = {}
        for paper in cycle_papers:
            verdicts[str(paper.id)] = paper_is_countable(paper)
            if not verdicts[str(paper.id)][0]:
                complete = False
                reasons.append({"paper_id": str(paper.id), "reason": verdicts[str(paper.id)][1]})
        cycles.append(
            {
                "cycle_key": cycle_key,
                "status": "complete" if complete else "incomplete",
                "paper_count": len(cycle_papers),
                "papers": [
                    {
                        "paper_id": str(paper.id),
                        "paper_code": paper.paper_code,
                        "session_key": paper.session_key,
                        "source_kind": paper.source_kind,
                        "countable": verdicts[str(paper.id)][0],
                        "reason": verdicts[str(paper.id)][1],
                        "coverage_status": (
                            paper.effective_revision.coverage_status if paper.effective_revision_id else "coverage_unknown"
                        ),
                        "expected_session_count": (
                            paper.effective_revision.expected_session_count
                            if paper.effective_revision_id
                            else None
                        ),
                        "covered_session_count": (
                            paper.effective_revision.covered_session_count if paper.effective_revision_id else None
                        ),
                    }
                    for paper in cycle_papers
                ],
                "blocking_reasons": reasons,
                "papers_by_id": {str(paper.id): paper for paper in cycle_papers},
            }
        )
    cycles.sort(key=lambda row: _cycle_sort_key(row["cycle_key"]), reverse=True)

    complete_cycles = [row for row in cycles if row["status"] == "complete"]
    used = complete_cycles[:max_cycles]
    excluded = [row for row in cycles if row["status"] != "complete"]

    cycle_rows: list[dict] = []
    for row in used:
        items = []
        for paper in row["papers_by_id"].values():
            items.extend(
                item
                for item in paper.effective_revision.items.filter(is_scored=True).select_related("question_version")
            )
        per_node, total = _node_shares(items)
        ranked = sorted(per_node.values(), key=lambda bucket: bucket["score"], reverse=True)
        share_total = sum(
            (bucket["score"] / total for bucket in ranked if total > 0),
            Decimal("0"),
        )
        cycle_rows.append(
            {
                "cycle_key": row["cycle_key"],
                "paper_count": row["paper_count"],
                "scored_item_count": len(items),
                "denominator_total_score": str(total.quantize(Decimal("0.001"))),
                "share_total": str(share_total.quantize(Decimal("0.0001"))),
                "nodes": [
                    {
                        "node_id": bucket["node_id"],
                        "label": bucket["label"],
                        "path": bucket.get("path", bucket["label"]),
                        "unclassified": bucket["unclassified"],
                        "score": str(bucket["score"].quantize(Decimal("0.001"))),
                        "share": (
                            str((bucket["score"] / total).quantize(Decimal("0.0001"))) if total > 0 else None
                        ),
                    }
                    for bucket in ranked
                ],
            }
        )

    averages: dict[str, dict] = {}
    for cycle_row in cycle_rows:
        for node in cycle_row["nodes"]:
            key = node["node_id"] or "__unclassified__"
            entry = averages.setdefault(
                key,
                {
                    "node_id": node["node_id"],
                    "label": node["label"],
                    "path": node["path"],
                    "unclassified": node["unclassified"],
                    "shares": [],
                    "scores": [],
                },
            )
            if node["share"] is not None:
                entry["shares"].append(Decimal(node["share"]))
            entry["scores"].append(Decimal(node["score"]))
    for entry in averages.values():
        count = len(entry["shares"])
        entry["cycle_count"] = count
        entry["average_share"] = (
            str((sum(entry["shares"], Decimal("0")) / count).quantize(Decimal("0.0001"))) if count else None
        )
        entry["average_score"] = (
            str((sum(entry["scores"], Decimal("0")) / count).quantize(Decimal("0.001"))) if count else None
        )
        entry.pop("shares")
        entry.pop("scores")

    gaps = _coverage_gaps(subject=subject, averages=averages)
    status = "ok" if len(used) >= max_cycles else "insufficient_cycles"
    return {
        "subject_id": str(subject.id),
        "cycle_horizon": max_cycles,
        "status": status,
        "complete_cycle_count": len(complete_cycles),
        "used_cycle_count": len(used),
        "missing_complete_cycles": max(0, max_cycles - len(used)),
        "used_cycles": [row["cycle_key"] for row in cycle_rows],
        "cycles": cycle_rows,
        "incomplete_cycles": [
            {
                "cycle_key": row["cycle_key"],
                "paper_count": row["paper_count"],
                "blocking_reasons": row["blocking_reasons"],
                "papers": row["papers"],
            }
            for row in excluded
        ],
        "nodes": sorted(
            averages.values(),
            key=lambda entry: (
                Decimal(entry["average_share"]) if entry["average_share"] is not None else Decimal("-1"),
                entry["label"],
            ),
            reverse=True,
        ),
        "coverage_gaps": gaps,
        "notes": _notes(status=status, used=len(used), horizon=max_cycles, excluded=excluded),
    }


def _coverage_gaps(*, subject, averages: dict) -> list[dict]:
    """Published syllabus points that no counted cycle ever examined."""
    from apps.knowledge.models import KnowledgeNode

    nodes = (
        KnowledgeNode.objects.filter(
            syllabus_version__subject=subject,
            syllabus_version__status="published",
            is_unclassified=False,
        )
        .select_related("parent")
        .order_by("display_order", "canonical_name")
    )
    gaps = []
    for node in nodes:
        entry = averages.get(str(node.id))
        if entry is None:
            gaps.append(
                {
                    "node_id": str(node.id),
                    "label": node.canonical_name,
                    "path": _node_path(node),
                    "reason": "never_examined_in_counted_cycles",
                }
            )
    return gaps


def _notes(*, status: str, used: int, horizon: int, excluded: list[dict]) -> list[str]:
    notes = [
        "只统计真实考试发生记录（source_kind=official_past 且非演示数据）；"
        "演示、模拟与练习集不计入任何分子或分母。",
        "完整周期 = 该周期全部已登记试卷都有“已确认且人工标记覆盖完整”的有效版本。",
        "分值权重按题目版本的主要考点权重计入一次；辅助标签权重为 0；无映射的计分题进入“未分类”。",
    ]
    if status != "ok":
        notes.append(
            f"目前只有 {used} 个完整周期，不足 {horizon} 个：不给出“近五年”结论，"
            f"未完整周期 {len(excluded)} 个，原因见 incomplete_cycles。"
        )
    return notes
