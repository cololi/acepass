"""Demo fixture data: two projects, three subjects, all five question types.

Everything created here is explicitly marked as a demo fixture
(``origin_type=demo`` / ``is_demo=True`` and demo exam-spec rules carrying a
note). It exists so the multi-project and full question-type loop can be
exercised end to end; nothing in it may be presented as an official exam rule, a
real past paper, or a verified learning effect.
"""

from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from apps.accounts.services.settings import get_or_create_settings
from apps.common.enums import (
    AnswerSourceType,
    MismatchPolicy,
    MultipleChoicePolicy,
    OriginType,
    SourceKind,
    VerificationStatus,
)
from apps.exams.models import ExamProject, Subject
from apps.exams.services import core as exams_services
from apps.knowledge.models import KnowledgeNode
from apps.question_bank.services import core as qb_services

User = get_user_model()

DEMO_NOTE = "演示夹具（demo）：不是任何真实考试的官方规则，也不能用于统计真实历年占比。"

PROJECT_A_NAME = "演示项目A·综合能力"
PROJECT_B_NAME = "演示项目B·专业实务"


def load_demo_fixture(email: str, *, rebuild: bool = False) -> dict:
    """Create the demo fixture for one account and return a summary dict."""
    with transaction.atomic():
        return _load(email, rebuild=rebuild)


def _load(email: str, *, rebuild: bool) -> dict:
    user = User.objects.filter(email=email.strip().lower()).first()
    if user is None:
        raise LookupError("account does not exist; create it with create_account first")
    settings_obj = get_or_create_settings(user)
    settings_obj.daily_budget_minutes = 60
    settings_obj.save(update_fields=["daily_budget_minutes", "updated_at"])

    for name in (PROJECT_A_NAME, PROJECT_B_NAME):
        existing = ExamProject.objects.filter(owner=user, name=name).first()
        if existing is not None and rebuild:
            exams_services.archive_project(existing, reason="演示夹具重建")

    project_a = _build_project_a(user, rebuild=rebuild)
    project_b = _build_project_b(user, rebuild=rebuild)
    settings_obj.project_budget_percent = {str(project_a.id): 60.0, str(project_b.id): 40.0}
    settings_obj.save(update_fields=["project_budget_percent", "updated_at"])
    return {
        "project_a": project_a,
        "project_b": project_b,
        "note": DEMO_NOTE,
        "summary": (
            f"{project_a.name}（{project_a.subjects.count()} 个科目）；{project_b.name}"
        ),
    }


# ------------------------------------------------------------------
def _build_project_a(user, *, rebuild: bool) -> ExamProject:
    project = ExamProject.objects.filter(owner=user, name="演示项目A·综合能力").first()
    if project is None:
        project = exams_services.create_project(
            user,
            name="演示项目A·综合能力",
            description="演示用多科目项目：用于验证多项目隔离、全题型与学习闭环。",
            target_score=Decimal("80.00"),
        )
    else:
        project.is_archived = False
        project.archived_at = None
        project.save(update_fields=["is_archived", "archived_at", "updated_at"])

    subject_one = _subject(project, "演示科目A1·数量关系", Decimal("100.00"), Decimal("60.00"))
    subject_two = _subject(project, "演示科目A2·判断推理", Decimal("100.00"), Decimal("60.00"))

    spec_one = _spec(
        subject_one,
        partial_credit=True,
        note="项目A规则：多选题少选得部分分（演示假设，非官方规则）。",
    )
    spec_two = _spec(subject_two, partial_credit=False, note="项目A第二科目：多选完全匹配（演示假设）。")
    syllabus_one = _syllabus(subject_one, "演示大纲A1")
    nodes_one = _nodes(syllabus_one, ["数与式", "方程与不等式", "几何初步"])
    syllabus_two = _syllabus(subject_two, "演示大纲A2")
    nodes_two = _nodes(syllabus_two, ["逻辑判断", "资料分析"])

    _seed_questions(
        project=project,
        subject=subject_one,
        spec=spec_one,
        syllabus=syllabus_one,
        nodes=nodes_one,
        user=user,
        label_prefix="A1",
    )
    _seed_questions(
        project=project,
        subject=subject_two,
        spec=spec_two,
        syllabus=syllabus_two,
        nodes=nodes_two,
        user=user,
        label_prefix="A2",
    )
    _register_paper(subject_one, user)
    return project

def _build_project_b(user, *, rebuild: bool) -> ExamProject:
    project = ExamProject.objects.filter(owner=user, name="演示项目B·专业实务").first()
    if project is None:
        project = exams_services.create_project(
            user,
            name="演示项目B·专业实务",
            description="演示用第二项目：验证跨项目权限、答案隔离与预算分配。",
        )
    else:
        project.is_archived = False
        project.archived_at = None
        project.save(update_fields=["is_archived", "archived_at", "updated_at"])

    subject = _subject(project, "演示科目B1·专业实务", Decimal("100.00"), Decimal("60.00"))
    spec = _spec(subject, partial_credit=False, note="项目B规则：多选完全匹配（演示假设，非官方规则）。")
    syllabus = _syllabus(subject, "演示大纲B1")
    nodes = _nodes(syllabus, ["专业基础", "案例分析"])
    _seed_questions(
        project=project,
        subject=subject,
        spec=spec,
        syllabus=syllabus,
        nodes=nodes,
        user=user,
        label_prefix="B1",
        origin=OriginType.USER_AUTHORED,
    )
    _register_paper(subject, user, source_kind=SourceKind.DEMO)
    return project

# ------------------------------------------------------------------
def _subject(project, name, total, pass_score) -> Subject:
    subject = Subject.objects.filter(project=project, name=name).first()
    if subject is None:
        subject = exams_services.create_subject(
            project, name=name, total_score=total, pass_score=pass_score
        )
    return subject

def _spec(subject, *, partial_credit: bool, note: str):
    spec = subject.exam_spec_versions.order_by("-version").first()
    if spec is not None and spec.status == "published":
        return spec
    rules = {
        "single_choice": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
        "multiple_choice": {
            "default_max_score": "4.00",
            "wrong_score": "0.00",
            "blank_score": "0.00",
            "policy": MultipleChoicePolicy.PARTIAL_CREDIT if partial_credit else MultipleChoicePolicy.EXACT_MATCH,
            "partial_score": "2.00" if partial_credit else None,
        },
        "true_false": {"default_max_score": "2.00", "wrong_score": "0.00", "blank_score": "0.00"},
        "fill_blank": {"default_max_score": "3.00", "mismatch_policy": MismatchPolicy.REVIEW},
        "constructed_response": {"default_max_score": "10.00"},
    }
    spec = exams_services.create_exam_spec_version(
        subject,
        created_by=subject.project.owner,
        name="演示规范 v1",
        total_score=subject.total_score,
        pass_score=subject.pass_score,
        question_type_rules=rules,
        time_rules={"constructed_response_seconds": 900, "fill_blank_seconds": 180, "choice_seconds": 120},
        score_floor_at_zero=False,
        rule_source_note=note,
        is_demo=True,
    )
    return exams_services.publish_exam_spec_version(spec, actor=subject.project.owner)

def _syllabus(subject, name):
    syllabus = subject.syllabus_versions.filter(name=name).first()
    if syllabus is None:
        syllabus = exams_services.create_syllabus_version(
            subject,
            created_by=subject.project.owner,
            name=name,
            version_label="演示",
            is_user_provisional=True,
        )
        syllabus = exams_services.publish_syllabus_version(syllabus, actor=subject.project.owner)
    return syllabus

def _nodes(syllabus, names: list[str]) -> dict[str, KnowledgeNode]:
    nodes: dict[str, KnowledgeNode] = {}
    for index, name in enumerate(names):
        node, _ = KnowledgeNode.objects.get_or_create(
            syllabus_version=syllabus,
            parent=None,
            canonical_name=name,
            defaults={"kind": "point", "display_order": index, "code": f"N{index + 1}"},
        )
        nodes[name] = node
    unclassified, _ = KnowledgeNode.objects.get_or_create(
        syllabus_version=syllabus,
        parent=None,
        canonical_name="未分类",
        defaults={"kind": "point", "is_unclassified": True, "display_order": 99},
    )
    nodes["未分类"] = unclassified
    return nodes

# ------------------------------------------------------------------
def _leaf_publish(
    *,
    project,
    subject,
    spec,
    node,
    user,
    label,
    question_type,
    content,
    answer_payload,
    rubric_criteria=None,
    rubric_total=None,
    max_score=None,
    explanation=None,
    origin=OriginType.DEMO,
):
    question = qb_services.create_question(
        subject=subject,
        origin_type=origin,
        actor=user,
        display_label=label,
        is_demo=True,
    )
    version = qb_services.create_question_version_draft(
        question,
        question_type=question_type,
        content=content,
        actor=user,
        practice_max_score=max_score if max_score is not None else spec.default_max_score(question_type),
        estimated_seconds=(spec.time_rules or {}).get(f"{question_type}_seconds"),
        revision_reason="演示夹具初始版本",
    )
    answer = qb_services.create_answer_key_version(
        version,
        answer_payload=answer_payload,
        actor=user,
        source_type=AnswerSourceType.USER,
        verification_status=VerificationStatus.CHECKED,
        check_basis="演示夹具人工核对（非真题，非官方答案）",
        explanation_blocks=explanation or [],
    )
    if rubric_criteria:
        qb_services.upsert_rubric_version(
            answer,
            criteria=rubric_criteria,
            total_score=rubric_total,
            actor=user,
            usage_note=DEMO_NOTE,
        )
    qb_services.replace_knowledge_mappings(
        version,
        [{"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("1")}],
        actor=user,
    )
    return qb_services.publish_question_version(version, actor=user)

def _seed_questions(*, project, subject, spec, syllabus, nodes, user, label_prefix, origin=OriginType.DEMO):
    node_names = [name for name in nodes if name != "未分类"]
    pick = lambda index: nodes[node_names[index % len(node_names)]]  # noqa: E731

    # --- single choice (2 per subject) -------------------------------------
    for index in range(2):
        _leaf_publish(
            project=project,
            subject=subject,
            spec=spec,
            node=pick(index),
            user=user,
            label=f"{label_prefix}-单选-{index + 1}",
            question_type="single_choice",
            content={
                "blocks": [{"kind": "text", "text": f"演示选择题 {index + 1}：下列哪一项符合题意？"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
                    {"id": "opt_c", "label": "C", "blocks": [{"kind": "text", "text": "丙"}]},
                    {"id": "opt_d", "label": "D", "blocks": [{"kind": "text", "text": "丁"}]},
                ],
            },
            answer_payload={"kind": "single_choice", "correct_option_id": "opt_a" if index == 0 else "opt_c"},
            explanation=[{"kind": "text", "text": "演示解析：用于验证按需讲解链路，不代表真实题目效果。"}],
            origin=origin,
        )

    # --- multiple choice ---------------------------------------------------
    for index in range(2):
        correct = ["opt_a", "opt_c"] if index == 0 else ["opt_b", "opt_d"]
        policy = spec.rule_for("multiple_choice").get("policy", MultipleChoicePolicy.EXACT_MATCH)
        payload = {
            "kind": "multiple_choice",
            "correct_option_ids": correct,
            "policy": policy,
            "wrong_score": "0.00",
            "blank_score": "0.00",
        }
        if policy == MultipleChoicePolicy.PARTIAL_CREDIT:
            payload["partial_score"] = "2.00"
        _leaf_publish(
            project=project,
            subject=subject,
            spec=spec,
            node=pick(index + 1),
            user=user,
            label=f"{label_prefix}-多选-{index + 1}",
            question_type="multiple_choice",
            content={
                "blocks": [{"kind": "text", "text": f"演示多选题 {index + 1}：选出所有正确项。"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "说法一"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "说法二"}]},
                    {"id": "opt_c", "label": "C", "blocks": [{"kind": "text", "text": "说法三"}]},
                    {"id": "opt_d", "label": "D", "blocks": [{"kind": "text", "text": "说法四"}]},
                ],
            },
            answer_payload=payload,
            origin=origin,
        )

    # --- true/false --------------------------------------------------------
    for index in range(2):
        _leaf_publish(
            project=project,
            subject=subject,
            spec=spec,
            node=pick(index + 2),
            user=user,
            label=f"{label_prefix}-判断-{index + 1}",
            question_type="true_false",
            content={"blocks": [{"kind": "text", "text": f"演示判断题 {index + 1}：该说法是否正确？"}]},
            answer_payload={"kind": "true_false", "value": index % 2 == 0},
            origin=origin,
        )

    # --- fill in the blank -------------------------------------------------
    _leaf_publish(
        project=project,
        subject=subject,
        spec=spec,
        node=pick(0),
        user=user,
        label=f"{label_prefix}-填空-精确",
        question_type="fill_blank",
        content={
            "blocks": [{"kind": "text", "text": "演示填空：方程的解为 __b1__，结果约为 __b2__（保留一位小数）。"}],
            "blanks": [
                {"blank_id": "b1", "label": "第1空", "max_score": "2.00"},
                {"blank_id": "b2", "label": "第2空", "max_score": "1.00"},
            ],
        },
        answer_payload={
            "kind": "fill_blank",
            "blank_order_matters": True,
            "blanks": {
                "b1": {
                    "accepted_values": ["-2", "−2"],
                    "normalization": {"strip_whitespace": True, "fullwidth_to_halfwidth": True},
                    "max_score": "2.00",
                    "mismatch_policy": MismatchPolicy.REVIEW,
                },
                "b2": {
                    "numeric": {"value": "10", "abs_tol": "0.1", "rel_tol": "0"},
                    "max_score": "1.00",
                    "mismatch_policy": MismatchPolicy.REVIEW,
                },
            },
        },
        max_score=Decimal("3.00"),
        origin=origin,
    )
    # A blank whose equivalence list does not cover the semantic answer is a
    # deliberate fixture for the "human fallback" acceptance case.
    _leaf_publish(
        project=project,
        subject=subject,
        spec=spec,
        node=pick(1),
        user=user,
        label=f"{label_prefix}-填空-待复核",
        question_type="fill_blank",
        content={
            "blocks": [{"kind": "text", "text": "演示填空（用于待复核路径）：结果写成最简形式 __b1__。"}],
            "blanks": [{"blank_id": "b1", "label": "第1空", "max_score": "3.00"}],
        },
        answer_payload={
            "kind": "fill_blank",
            "blanks": {
                "b1": {
                    "accepted_values": ["1/2"],
                    "normalization": {"strip_whitespace": True},
                    "max_score": "3.00",
                    "mismatch_policy": MismatchPolicy.REVIEW,
                }
            },
        },
        max_score=Decimal("3.00"),
        origin=origin,
    )

    # --- constructed response ---------------------------------------------
    _leaf_publish(
        project=project,
        subject=subject,
        spec=spec,
        node=pick(2),
        user=user,
        label=f"{label_prefix}-大题-1",
        question_type="constructed_response",
        content={
            "blocks": [
                {"kind": "text", "text": "演示大题：写出完整推导过程，并在最后一行给出结论。"},
                {"kind": "table", "rows": [[{"text": "步骤"}, {"text": "说明"}]], "caption": "答题格式示例"},
            ]
        },
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        rubric_criteria=[
            {"criterion_id": "c1", "text": "正确列出已知条件", "max_score": "2.00", "required": True},
            {"criterion_id": "c2", "text": "推导过程正确", "max_score": "3.00", "required": True},
            {"criterion_id": "c3", "text": "结论正确且单位完整", "max_score": "5.00", "required": True},
        ],
        rubric_total=Decimal("10.00"),
        max_score=Decimal("10.00"),
        origin=origin,
    )

    # --- material parent with two children (3 + 7 marks) -------------------
    _seed_material_group(
        project=project,
        subject=subject,
        spec=spec,
        syllabus=syllabus,
        nodes=nodes,
        user=user,
        label_prefix=label_prefix,
        origin=origin,
    )

def _seed_material_group(*, project, subject, spec, syllabus, nodes, user, label_prefix, origin):
    node_a = nodes[[name for name in nodes if name != "未分类"][0]]
    node_b = nodes[[name for name in nodes if name != "未分类"][1]]

    parent = qb_services.create_question(
        subject=subject, origin_type=origin, actor=user, display_label=f"{label_prefix}-材料-1", is_demo=True
    )
    child_one = qb_services.create_question(
        subject=subject, origin_type=origin, actor=user, display_label=f"{label_prefix}-材料-1-子1", is_demo=True
    )
    child_two = qb_services.create_question(
        subject=subject, origin_type=origin, actor=user, display_label=f"{label_prefix}-材料-1-子2", is_demo=True
    )

    material_content = {
        "blocks": [
            {"kind": "text", "text": "共享材料（演示）：下面是一段用于两道子题的材料，父子题分值 3 + 7。"}
        ]
    }
    parent_version = qb_services.create_question_version_draft(
        parent,
        question_type="material",
        content=material_content,
        actor=user,
        revision_reason="演示材料题",
    )
    child_one_version = qb_services.create_question_version_draft(
        child_one,
        question_type="single_choice",
        content={
            "blocks": [{"kind": "text", "text": "子题1（3 分）：根据材料，正确选项是？"}],
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "选项一"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "选项二"}]},
            ],
        },
        actor=user,
        practice_max_score=Decimal("3.00"),
        parent_material_version_id=str(parent_version.id),
        revision_reason="演示材料子题",
    )
    child_two_version = qb_services.create_question_version_draft(
        child_two,
        question_type="constructed_response",
        content={"blocks": [{"kind": "text", "text": "子题2（7 分）：结合材料写出你的分析过程。"}]},
        actor=user,
        practice_max_score=Decimal("7.00"),
        parent_material_version_id=str(parent_version.id),
        revision_reason="演示材料子题",
    )

    for child_version, node, answer_payload, criteria, total in (
        (
            child_one_version,
            node_a,
            {"kind": "single_choice", "correct_option_id": "opt_a"},
            None,
            None,
        ),
        (
            child_two_version,
            node_b,
            {"kind": "constructed_response", "rubric_required": True},
            [
                {"criterion_id": "c1", "text": "引用材料关键信息", "max_score": "3.00", "required": True},
                {"criterion_id": "c2", "text": "分析过程完整", "max_score": "4.00", "required": True},
            ],
            Decimal("7.00"),
        ),
    ):
        answer = qb_services.create_answer_key_version(
            child_version,
            answer_payload=answer_payload,
            actor=user,
            source_type=AnswerSourceType.USER,
            verification_status=VerificationStatus.CHECKED,
            check_basis="演示夹具人工核对（非真题）",
        )
        if criteria:
            qb_services.upsert_rubric_version(answer, criteria=criteria, total_score=total, actor=user)
        qb_services.replace_knowledge_mappings(
            child_version,
            [{"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("1")}],
            actor=user,
        )
        qb_services.publish_question_version(child_version, actor=user)

    parent_version.material_child_version_ids = [str(child_one_version.id), str(child_two_version.id)]
    parent_version.save(update_fields=["material_child_version_ids", "updated_at"])
    qb_services.publish_question_version(parent_version, actor=user)

def _register_paper(subject, user, source_kind: str = SourceKind.DEMO):
    paper, _ = exams_services.get_or_create_paper(
        subject=subject,
        cycle_key="演示2024" if source_kind == SourceKind.DEMO else "2024",
        session_key="演示场次",
        paper_code="演示卷一",
        source_kind=source_kind,
        title="演示试卷（不是真实考试记录）",
        actor=user,
    )
    if paper.revisions.exists():
        return paper
    revision = exams_services.create_paper_revision(
        paper,
        actor=user,
        expected_session_count=1,
        covered_session_count=1,
        coverage_confirmed_by=user,
        coverage_confirmed_at=timezone.now(),
        status="confirmed",
        note="演示夹具：单个科目单份卷，仅用于验证题项与分值登记。",
    )
    position = 1
    for version in (
        subject.questions.filter(current_published_version__isnull=False)
        .select_related("current_published_version")
        .order_by("display_label")[:5]
    ):
        published = version.current_published_version
        if published is None or published.question_type == "material":
            continue
        exams_services.add_paper_item(
            revision,
            actor=user,
            position_key=str(position),
            question_version=published,
            answer_key_version=published.answer_keys.filter(is_disputed=False).first(),
            max_score=published.practice_max_score or Decimal("2.00"),
        )
        position += 1
    exams_services.set_effective_revision(paper, revision, actor=user)
    return paper
