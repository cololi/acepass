"""P1-02/P1-03: syllabus word list, manual mapping and real cycle analysis.

Acceptance points covered here:

* 多项目/科目分别配置 — nodes live inside one subject's syllabus version;
* 同义词合并、环依赖拒绝 — ``导数（微分）`` merges, and re-parenting a node under
  its own descendant is refused;
* 只按真实试卷发生记录统计 — demo fixtures, mock papers and practice sets are
  excluded from every numerator and denominator;
* 明确完整/不完整周期与分母 — each cycle reports its status, its papers and the
  denominator actually used;
* 权重不重复 — a question's primary weights are counted once and the per-cycle
  shares never exceed 1 (unmapped marks land in 未分类);
* 不足五个完整周期就显示不足 — four complete cycles produce
  ``insufficient_cycles``, not a "近五年" claim.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.analytics.services import cycles as cycle_service
from apps.common.enums import PaperRevisionStatus
from apps.common.errors import InvalidInput
from apps.exams.models import Paper, PaperRevision, SyllabusVersion
from apps.exams.services import core as exam_services
from apps.knowledge.models import KnowledgeNode
from apps.knowledge.services import outline as outline_services
from apps.question_bank.models import QuestionVersion
from apps.question_bank.services import core as qb_services

pytestmark = pytest.mark.django_db


def _published_syllabus(subject) -> SyllabusVersion:
    syllabus = SyllabusVersion.objects.filter(subject=subject, status="published").first()
    assert syllabus is not None, "演示夹具应已发布大纲"
    return syllabus


# --------------------------------------------------------------------------
# P1-02 syllabus word list and manual mapping
# --------------------------------------------------------------------------
def test_outline_import_builds_hierarchy_and_merges_synonyms(project_a, subject_a1):
    syllabus = exam_services.create_syllabus_version(
        subject_a1, created_by=project_a.owner, name="P1 词表", version_label="v1"
    )
    exam_services.publish_syllabus_version(syllabus, actor=project_a.owner)
    report = outline_services.import_outline(
        syllabus_version=syllabus,
        text="""第一章 函数与极限
  第一节 函数
    1. 函数的定义（映射关系）
    2. 函数的性质
  第二节 极限
    1. 数列极限
      数列极限的定义
第二章 导数
  导数（微分）
  导数的应用
""",
        actor=project_a.owner,
    )
    assert report["created"] == 10
    assert report["merged"] == 0
    root = KnowledgeNode.objects.get(syllabus_version=syllabus, canonical_name="第一章 函数与极限")
    assert root.parent is None
    point = KnowledgeNode.objects.get(syllabus_version=syllabus, canonical_name="函数的定义")
    assert point.parent.canonical_name == "第一节 函数"
    assert point.aliases == ["映射关系"]

    # Re-importing the same word list merges instead of duplicating.
    again = outline_services.import_outline(
        syllabus_version=syllabus, text="第一章 函数与极限\n  第一节 函数\n    函数的定义（映射）\n", actor=project_a.owner
    )
    assert again["created"] == 0
    assert again["merged"] == 3
    assert KnowledgeNode.objects.filter(syllabus_version=syllabus, canonical_name="函数的定义").count() == 1
    refreshed = KnowledgeNode.objects.get(syllabus_version=syllabus, canonical_name="函数的定义")
    assert set(refreshed.aliases) == {"映射关系", "映射"}


def test_moving_a_node_under_its_own_descendant_is_refused(project_a, subject_a1):
    syllabus = _published_syllabus(subject_a1)
    parent = KnowledgeNode.objects.create(
        syllabus_version=syllabus, canonical_name="P1 环测试父", kind="section"
    )
    child = KnowledgeNode.objects.create(
        syllabus_version=syllabus, parent=parent, canonical_name="P1 环测试子"
    )
    grandchild = KnowledgeNode.objects.create(
        syllabus_version=syllabus, parent=child, canonical_name="P1 环测试孙"
    )
    with pytest.raises(InvalidInput) as excinfo:
        outline_services.update_knowledge_node(parent, actor=project_a.owner, parent=grandchild, move=True)
    assert "环" in str(getattr(excinfo.value, "message", excinfo.value))
    parent.refresh_from_db()
    assert parent.parent_id is None

    # The legal move still works: the grandchild becomes a direct child.
    moved = outline_services.update_knowledge_node(grandchild, actor=project_a.owner, parent=parent, move=True)
    assert moved.parent_id == parent.id


def test_manual_mapping_requires_weights_that_sum_to_one(project_a, subject_a1):
    syllabus = _published_syllabus(subject_a1)
    version = QuestionVersion.objects.filter(
        question__subject=subject_a1, status="published"
    ).first()
    node = KnowledgeNode.objects.filter(syllabus_version=syllabus).first()
    other = KnowledgeNode.objects.filter(syllabus_version=syllabus).exclude(id=node.id).first()

    with pytest.raises(InvalidInput):
        qb_services.replace_knowledge_mappings(
            version,
            [
                {"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("0.6")},
                {"node_id": str(other.id), "is_primary": True, "score_weight": Decimal("0.6")},
            ],
            actor=project_a.owner,
        )
    mappings = qb_services.replace_knowledge_mappings(
        version,
        [
            {"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("0.5")},
            {"node_id": str(other.id), "is_primary": True, "score_weight": Decimal("0.5")},
        ],
        actor=project_a.owner,
    )
    assert sum(Decimal(mapping.score_weight) for mapping in mappings) == Decimal("1")
    revision_before = mappings[0].mapping_revision
    with pytest.raises(InvalidInput):
        # The same node twice would double-count one point's weight.
        qb_services.replace_knowledge_mappings(
            version,
            [
                {"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("0.5")},
                {"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("0.5")},
            ],
            actor=project_a.owner,
        )
    still_there = list(version.knowledge_mappings.filter(mapping_revision=revision_before))
    assert len(still_there) == 2, "失败的重映射不得破坏上一批映射"


# --------------------------------------------------------------------------
# P1-03 cycle analysis fixtures
# --------------------------------------------------------------------------
def _real_paper_with_items(*, subject, cycle_key: str, node, actor, max_score: str = "10"):
    """One real occurrence record with a confirmed, coverage-complete revision."""
    paper, _created = exam_services.get_or_create_paper(
        subject=subject,
        cycle_key=cycle_key,
        paper_code="卷一",
        source_kind="official_past",
        title=f"{cycle_key} 年测试材料",
        actor=actor,
    )
    revision = exam_services.create_paper_revision(
        paper,
        actor=actor,
        expected_session_count=1,
        covered_session_count=1,
        note="P1-03 验收测试材料（自动生成，非真题）",
    )
    question = qb_services.create_question(
        subject=subject, origin_type="user_authored", actor=actor, display_label=f"{cycle_key}-1"
    )
    version = qb_services.create_question_version_draft(
        question,
        question_type="single_choice",
        content={
            "blocks": [{"kind": "text", "text": f"{cycle_key} 年测试题"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
            ],
        },
        actor=actor,
        practice_max_score=Decimal(max_score),
    )
    qb_services.replace_knowledge_mappings(
        version, [{"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("1")}], actor=actor
    )
    qb_services.create_answer_key_version(
        version,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
        actor=actor,
        verification_status="checked",
        check_basis="P1-03 验收夹具",
    )
    published = qb_services.publish_question_version(version, actor=actor)
    exam_services.add_paper_item(
        revision, actor=actor, position_key="1", question_version=published, max_score=Decimal(max_score)
    )
    exam_services.record_paper_coverage(
        revision, actor=actor, expected_session_count=1, covered_session_count=1, confirm=True
    )
    exam_services.confirm_paper_revision(revision, actor=actor)
    return paper, revision


def _real_paper_without_items(*, subject, cycle_key: str, actor):
    paper, _created = exam_services.get_or_create_paper(
        subject=subject,
        cycle_key=cycle_key,
        paper_code="卷一",
        source_kind="official_past",
        title=f"{cycle_key} 年测试材料",
        actor=actor,
    )
    revision = exam_services.create_paper_revision(paper, actor=actor, note="未完成校对")
    return paper, revision


def test_cycle_analysis_reports_insufficient_cycles_with_reasons(project_a, subject_a1):
    syllabus = _published_syllabus(subject_a1)
    node = KnowledgeNode.objects.filter(syllabus_version=syllabus).first()
    for year in (2020, 2021, 2022, 2023):
        _real_paper_with_items(subject=subject_a1, cycle_key=str(year), node=node, actor=project_a.owner)
    # An incomplete cycle must be reported, not silently dropped.
    _real_paper_without_items(subject=subject_a1, cycle_key="2024", actor=project_a.owner)
    # A demo paper in the same subject must never be counted.
    assert Paper.objects.filter(subject=subject_a1, is_demo=True).exists()

    report = cycle_service.cycle_analysis(subject=subject_a1, max_cycles=5)
    assert report["status"] == "insufficient_cycles"
    assert report["complete_cycle_count"] == 4
    assert report["used_cycle_count"] == 4
    assert report["missing_complete_cycles"] == 1
    assert report["used_cycles"] == ["2023", "2022", "2021", "2020"]
    incomplete = {row["cycle_key"]: row for row in report["incomplete_cycles"]}
    assert "2024" in incomplete
    assert {reason["reason"] for reason in incomplete["2024"]["blocking_reasons"]} == {"no_effective_revision"}
    assert any("不足 5 个" in note for note in report["notes"])
    assert all(row["denominator_total_score"] == "10.000" for row in report["cycles"])
    assert all(row["share_total"] == "1.0000" for row in report["cycles"])


def test_cycle_analysis_counts_each_question_weight_once(project_a, subject_a1):
    syllabus = _published_syllabus(subject_a1)
    first, second = list(KnowledgeNode.objects.filter(syllabus_version=syllabus)[:2])
    for year in (2019, 2020, 2021, 2022, 2023):
        _real_paper_with_items(subject=subject_a1, cycle_key=str(year), node=first, actor=project_a.owner)
    report = cycle_service.cycle_analysis(subject=subject_a1, max_cycles=5)
    assert report["status"] == "ok"
    assert report["used_cycle_count"] == 5
    for cycle_row in report["cycles"]:
        assert cycle_row["share_total"] == "1.0000"
        assert len(cycle_row["nodes"]) == 1
        assert cycle_row["nodes"][0]["share"] == "1.0000"
    node_rows = {row["label"]: row for row in report["nodes"]}
    assert node_rows[first.canonical_name]["average_share"] == "1.0000"
    # A published syllabus point that no counted cycle examined is a gap.
    gap_labels = {gap["label"] for gap in report["coverage_gaps"]}
    assert first.canonical_name not in gap_labels
    assert second.canonical_name in gap_labels


def test_cycle_analysis_excludes_demo_and_incomplete_papers(project_a, subject_a1):
    syllabus = _published_syllabus(subject_a1)
    node = KnowledgeNode.objects.filter(syllabus_version=syllabus).first()
    _real_paper_with_items(subject=subject_a1, cycle_key="2023", node=node, actor=project_a.owner)

    # A demo paper with the same shape: if it leaked into the numbers the
    # denominator would become 20 and the demo cycle would appear as "counted".
    demo = Paper.objects.filter(subject=subject_a1, is_demo=True).first()
    assert demo is not None
    demo_revision = demo.effective_revision
    assert demo_revision is not None, "演示夹具应带有效版本"
    demo_scored = demo_revision.items.filter(is_scored=True)
    assert demo_scored.exists(), "演示夹具应有计分题项（否则本用例证明不了排除规则）"

    report = cycle_service.cycle_analysis(subject=subject_a1, max_cycles=5)
    assert report["used_cycles"] == ["2023"]
    assert report["cycles"][0]["denominator_total_score"] == "10.000"
    assert demo.cycle_key not in report["used_cycles"]
    excluded = {row["cycle_key"] for row in report["incomplete_cycles"]}
    assert demo.cycle_key in excluded
    reasons = {row["cycle_key"]: row["blocking_reasons"] for row in report["incomplete_cycles"]}
    assert {reason["reason"] for reason in reasons[demo.cycle_key]} == {"demo_or_mock"}
    assert demo_scored.count() >= 1


def test_unmapped_scored_items_are_reported_as_unclassified(project_a, subject_a1):
    syllabus = _published_syllabus(subject_a1)
    node = KnowledgeNode.objects.filter(syllabus_version=syllabus).first()
    paper, revision = _real_paper_with_items(
        subject=subject_a1, cycle_key="2022", node=node, actor=project_a.owner
    )
    # A second item with no knowledge mapping at all: its marks must not vanish
    # from the denominator, and they must not be attributed to a random node.
    question = qb_services.create_question(
        subject=subject_a1, origin_type="user_authored", actor=project_a.owner, display_label="2022-2"
    )
    version = qb_services.create_question_version_draft(
        question,
        question_type="true_false",
        content={"blocks": [{"kind": "text", "text": "未映射题"}]},
        actor=project_a.owner,
        practice_max_score=Decimal("5"),
    )
    qb_services.create_answer_key_version(
        version,
        answer_payload={"kind": "true_false", "value": True},
        actor=project_a.owner,
        verification_status="checked",
        check_basis="P1-03 验收夹具",
    )
    published = qb_services.publish_question_version(version, actor=project_a.owner)
    exam_services.add_paper_item(
        revision, actor=project_a.owner, position_key="2", question_version=published, max_score=Decimal("5")
    )
    report = cycle_service.cycle_analysis(subject=subject_a1, max_cycles=5)
    cycle_row = report["cycles"][0]
    assert cycle_row["denominator_total_score"] == "15.000"
    unclassified = [row for row in cycle_row["nodes"] if row["unclassified"]]
    assert len(unclassified) == 1
    assert unclassified[0]["label"] == cycle_service.UNCLASSIFIED_LABEL
    assert unclassified[0]["score"] == "5.000"
    assert cycle_row["share_total"] == "1.0000"
