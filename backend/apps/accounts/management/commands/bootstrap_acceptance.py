"""Build the real-user fixture for the browser acceptance run.

This is deliberately **not** the demo fixture. The demo fixture marks everything
``origin_type=demo`` / ``is_demo=True`` and pre-loads a complete question bank, so
a green browser run against it proves the UI renders demo data — it cannot prove
that a new account can set up its own project, subjects and questions and then
complete the loop. The independent review made exactly that objection
(docs/07 §3 "真实用户路径").

What this command does instead: create an account with nothing in it, then build
the minimum real structure through the same service layer the API uses —
projects, subjects, published exam specs, syllabi with knowledge points, and one
published question per scorable type with a checked answer (and a rubric for the
constructed response). Everything is labelled as an acceptance fixture, never as
a real past paper.

Only run this against a dedicated acceptance database; ``--allow`` must name the
database explicitly so a typo cannot touch a real one.
"""

from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from apps.accounts.services.settings import get_or_create_settings
from apps.common.enums import (
    AnswerSourceType,
    MismatchPolicy,
    MultipleChoicePolicy,
    OriginType,
    VerificationStatus,
)
from apps.exams.models import ExamProject, Subject
from apps.exams.services import core as exams_services
from apps.question_bank.services import core as qb_services

User = get_user_model()

FIXTURE_PREFIX = "验收"
FIXTURE_NOTE = "浏览器验收夹具：结构为真实录入路径，题目为自编验收题，不是历年真题。"
ALLOWED_DB_PREFIXES = ("acepass_browser_audit_", "acepass_acceptance_", "test_acepass")

PROJECT_A = "验收项目A·基础能力"
PROJECT_B = "验收项目B·专业实务"
PROJECT_C = "验收项目C·延迟验证"
SUBJECT_NAMES = ("验收科目一·数量关系", "验收科目二·判断推理", "验收科目三·专业实务")
#: The delayed-verification chain has its own project: see `build` for why.
SUBJECT_C = "验收延迟科目·数量关系"


class Command(BaseCommand):
    help = "Create an empty account and build the browser-acceptance structure for it."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True)
        parser.add_argument("--password", required=True)
        parser.add_argument("--display-name", default="验收用户")
        parser.add_argument(
            "--allow",
            required=True,
            help="The database name this command is allowed to modify; must be a dedicated acceptance database.",
        )

    def handle(self, *args, **options):
        database = connection.settings_dict["NAME"]
        if options["allow"] != database:
            raise CommandError(f"--allow={options['allow']} does not match the connected database {database!r}")
        if not str(database).startswith(ALLOWED_DB_PREFIXES):
            raise CommandError(
                f"refusing to build the acceptance fixture in {database!r}: "
                f"the name must start with one of {ALLOWED_DB_PREFIXES}"
            )
        summary = build(
            email=options["email"],
            password=options["password"],
            display_name=options["display_name"],
        )
        for key, value in summary.items():
            self.stdout.write(f"{key}={value}")


@transaction.atomic
def build(*, email: str, password: str, display_name: str) -> dict:
    email = email.strip().lower()
    user = User.objects.filter(email=email).first()
    if user is None:
        user = User.objects.create_user(email=email, password=password, display_name=display_name)
    settings_obj = get_or_create_settings(user)
    settings_obj.daily_budget_minutes = 90
    settings_obj.save(update_fields=["daily_budget_minutes", "updated_at"])

    for name in (PROJECT_A, PROJECT_B, PROJECT_C):
        existing = ExamProject.objects.filter(owner=user, name=name).first()
        if existing is not None:
            exams_services.archive_project(existing, reason="验收夹具重建")

    project_a = exams_services.create_project(user, name=PROJECT_A)
    project_b = exams_services.create_project(user, name=PROJECT_B)

    published = 0
    built = []
    for index, subject_name in enumerate(SUBJECT_NAMES):
        project = project_a if index < 2 else project_b
        subject = exams_services.create_subject(project, name=subject_name, total_score=100, pass_score=60)
        spec = _published_spec(subject, user, partial_credit=index == 0)
        syllabus = _published_syllabus(subject, user)
        nodes = _nodes(syllabus, ["验收考点一", "验收考点二", "验收考点三"])
        versions = _seed_subject(
            project=project,
            subject=subject,
            spec=spec,
            nodes=nodes,
            user=user,
            label_prefix=FIXTURE_PREFIX,
        )
        published += len(versions)
        built.append((subject, nodes, versions))

    # The delayed-verification chain lives in its own project.
    #
    # Its deadline is time-sensitive by design: any *new* training or explanation
    # on the same knowledge point legitimately pushes it forward (B04). Sharing a
    # project with the other scenarios meant an earlier test revealing an answer
    # on the same knowledge point silently un-did the fixture's "C is due" setup,
    # so the browser test measured test ordering instead of the anchor rule. In
    # its own project the chain is driven only by the chain.
    project_c = exams_services.create_project(user, name=PROJECT_C)
    subject_c = exams_services.create_subject(project_c, name=SUBJECT_C, total_score=100, pass_score=60)
    spec_c = _published_spec(subject_c, user, partial_credit=False)
    syllabus_c = _published_syllabus(subject_c, user)
    nodes_c = _nodes(syllabus_c, ["验收延迟考点一", "验收延迟考点二", "验收延迟考点三"])
    versions_c = _seed_subject(
        project=project_c,
        subject=subject_c,
        spec=spec_c,
        nodes=nodes_c,
        user=user,
        label_prefix="验收延迟",
    )
    published += len(versions_c)
    delayed_tasks = _seed_delayed_verification((subject_c, nodes_c, versions_c), user)

    return {
        "email": email,
        "project_a": str(project_a.id),
        "project_b": str(project_b.id),
        "project_c": str(project_c.id),
        "subjects": Subject.objects.filter(project__owner=user).count(),
        "published_versions": published,
        "delayed_verification_tasks": delayed_tasks,
    }


def _seed_delayed_verification(subject_and_nodes, user) -> int:
    """Drive a real A -> B -> C chain so the review page has actual work.

    The chain is produced by the normal service path (grading an A attempt
    creates B; grading a B attempt creates C). Only C's deadline is then moved
    into the past so the browser can start it — the anchor itself is computed by
    the real logic, which is what the browser test asserts about.
    """
    from datetime import timedelta

    from django.utils import timezone

    from apps.knowledge.services import core as knowledge_services
    from apps.learning.models import ReviewTask, StudyTask
    from apps.learning.services import pairing as pairing_services
    from apps.practice.services import attempts as attempt_services
    from apps.practice.services import sessions as session_services
    from apps.question_bank.models import QuestionVersion

    subject, nodes, versions = subject_and_nodes
    singles = [v for v in versions if v.question_type == "single_choice"]
    if not singles:
        return 0
    baseline = singles[0]
    others = list(
        QuestionVersion.objects.filter(
            question__subject=subject, question_type="single_choice", status="published"
        ).exclude(id=baseline.id)
    )
    if len(others) < 2:
        return 0
    node = next(iter(nodes.values()))
    pairing = knowledge_services.create_verification_pairing(
        project=subject.project,
        subject=subject,
        node=node,
        baseline_question=baseline.question,
        immediate_question=others[0].question,
        delayed_question=others[1].question,
        delay_hours=24,
        actor=user,
        note=FIXTURE_NOTE,
    )

    def _answer_for(version):
        payload = version.answer_keys.filter(is_disputed=False).first().answer_payload
        return {"type": "single_choice", "selected_option_ids": [payload["correct_option_id"]]}

    now = timezone.now()
    session_a = session_services.create_session(
        user=user, project=subject.project, subject=subject, question_ids=[str(baseline.question_id)]
    )
    item_a = session_a.items.get()
    session_services.presentation(item=item_a, user=user, now=now - timedelta(hours=30, minutes=5))
    attempt_a, _grade_a = attempt_services.submit_attempt(
        session_item_id=str(item_a.id),
        user=user,
        raw_answer=_answer_for(baseline),
        now=now - timedelta(hours=30),
    )
    pairing_services.on_attempt_graded(str(attempt_a.id))

    b_task = StudyTask.objects.filter(pairing=pairing, task_kind="paired_immediate").first()
    if b_task is None or b_task.question_id is None:
        return 0
    b_version = (
        QuestionVersion.objects.filter(question_id=b_task.question_id, status="published")
        .order_by("-version")
        .first()
    )
    if b_version is None:
        return 0
    session_b = session_services.create_session(
        user=user, project=subject.project, subject=subject, question_ids=[str(b_task.question_id)]
    )
    item_b = session_b.items.get()
    session_services.presentation(item=item_b, user=user, now=now - timedelta(minutes=35))
    attempt_b, _grade_b = attempt_services.submit_attempt(
        session_item_id=str(item_b.id),
        user=user,
        raw_answer=_answer_for(b_version),
        now=now - timedelta(minutes=30),
    )
    pairing_services.on_attempt_graded(str(attempt_b.id))

    c_task = StudyTask.objects.filter(
        pairing=pairing, task_kind="delayed_verification", origin_session_item=item_b
    ).first()
    if c_task is None:
        return 0
    due = now - timedelta(minutes=1)
    c_task.not_before = due
    c_task.due_at = due
    c_task.save(update_fields=["not_before", "due_at", "updated_at"])
    ReviewTask.objects.filter(study_task=c_task).update(not_before=due, updated_at=now)
    return StudyTask.objects.filter(pairing=pairing).count()


def _published_spec(subject: Subject, user, *, partial_credit: bool):
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
        name=f"{FIXTURE_PREFIX}规范 v1",
        total_score=subject.total_score,
        pass_score=subject.pass_score,
        question_type_rules=rules,
        time_rules={"single_choice_seconds": 60, "constructed_response_seconds": 600},
        score_floor_at_zero=False,
        rule_source_note=FIXTURE_NOTE,
        is_demo=False,
    )
    return exams_services.publish_exam_spec_version(spec, actor=user)


def _published_syllabus(subject: Subject, user):
    syllabus = exams_services.create_syllabus_version(
        subject,
        created_by=subject.project.owner,
        name=f"{FIXTURE_PREFIX}大纲",
        version_label="验收",
        is_user_provisional=True,
    )
    return exams_services.publish_syllabus_version(syllabus, actor=user)


def _nodes(syllabus, names: list[str]):
    from apps.knowledge.services import core as knowledge_services

    created = {}
    for index, name in enumerate(names):
        created[name] = knowledge_services.create_knowledge_node(
            syllabus_version=syllabus,
            canonical_name=name,
            kind="point",
            display_order=index,
        )
    return created


def _seed_subject(*, project, subject, spec, nodes, user, label_prefix: str) -> list:
    """One published question of every scorable type, with a checked answer."""
    node_list = list(nodes.values())
    created_versions = []
    blueprints = [
        {
            "label": f"{label_prefix}-单选-1",
            "question_type": "single_choice",
            "content": {
                "blocks": [{"kind": "text", "text": "验收单选：下列哪一项等于 3 + 4 × 2？"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "11"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "14"}]},
                    {"id": "opt_c", "label": "C", "blocks": [{"kind": "text", "text": "9"}]},
                    {"id": "opt_d", "label": "D", "blocks": [{"kind": "text", "text": "12"}]},
                ],
            },
            "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
            "explanation": [{"kind": "text", "text": "先乘后加：4 × 2 = 8，再加 3 得 11。"}],
        },
        # Two more single-choice questions, so a real A/B/C verification pairing
        # can be built from *different* stable questions on the same subject.
        {
            "label": f"{label_prefix}-单选-2",
            "question_type": "single_choice",
            "content": {
                "blocks": [{"kind": "text", "text": "验收单选：12 的一半是多少？"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "6"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "24"}]},
                    {"id": "opt_c", "label": "C", "blocks": [{"kind": "text", "text": "4"}]},
                    {"id": "opt_d", "label": "D", "blocks": [{"kind": "text", "text": "8"}]},
                ],
            },
            "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
            "explanation": [{"kind": "text", "text": "12 ÷ 2 = 6。"}],
        },
        {
            "label": f"{label_prefix}-单选-3",
            "question_type": "single_choice",
            "content": {
                "blocks": [{"kind": "text", "text": "验收单选：一个正方形边长 3，周长是多少？"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "6"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "12"}]},
                    {"id": "opt_c", "label": "C", "blocks": [{"kind": "text", "text": "9"}]},
                    {"id": "opt_d", "label": "D", "blocks": [{"kind": "text", "text": "18"}]},
                ],
            },
            "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_b"},
            "explanation": [{"kind": "text", "text": "正方形周长 = 4 × 3 = 12。"}],
        },
        {
            "label": f"{label_prefix}-多选-1",
            "question_type": "multiple_choice",
            "content": {
                "blocks": [{"kind": "text", "text": "验收多选：下列哪些数是偶数？"}],
                "options": [
                    {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "2"}]},
                    {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "3"}]},
                    {"id": "opt_c", "label": "C", "blocks": [{"kind": "text", "text": "4"}]},
                    {"id": "opt_d", "label": "D", "blocks": [{"kind": "text", "text": "5"}]},
                ],
            },
            "answer_payload": {"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_c"]},
            "explanation": [{"kind": "text", "text": "2 与 4 能被 2 整除。"}],
        },
        {
            "label": f"{label_prefix}-判断-1",
            "question_type": "true_false",
            "content": {"blocks": [{"kind": "text", "text": "验收判断：三角形内角和为 180 度。"}]},
            "answer_payload": {"kind": "true_false", "value": True},
            "explanation": [{"kind": "text", "text": "欧氏平面几何中三角形内角和为 180 度。"}],
        },
        {
            "label": f"{label_prefix}-填空-1",
            "question_type": "fill_blank",
            "content": {
                "blocks": [{"kind": "text", "text": "验收填空：3 + 4 = ____，10 ÷ 2 = ____。"}],
                "blanks": [
                    {"blank_id": "b1", "label": "第 1 空"},
                    {"blank_id": "b2", "label": "第 2 空"},
                ],
            },
            "answer_payload": {
                "kind": "fill_blank",
                "blanks": {
                    "b1": {
                        "accepted_values": ["7"],
                        "max_score": "1.50",
                        "normalization": {"strip_whitespace": True, "fullwidth_to_halfwidth": True},
                        "mismatch_policy": MismatchPolicy.WRONG,
                    },
                    "b2": {
                        "accepted_values": ["5"],
                        "max_score": "1.50",
                        "normalization": {"strip_whitespace": True, "fullwidth_to_halfwidth": True},
                        "mismatch_policy": MismatchPolicy.WRONG,
                    },
                },
            },
            "explanation": [{"kind": "text", "text": "3 + 4 = 7；10 ÷ 2 = 5。"}],
        },
        {
            "label": f"{label_prefix}-大题-1",
            "question_type": "constructed_response",
            "content": {
                "blocks": [
                    {
                        "kind": "text",
                        "text": "验收大题：一箱有 5 袋，每袋 4 个，共多少个？请写出完整推导过程并给出结论。",
                    }
                ]
            },
            "answer_payload": {"kind": "constructed_response", "rubric_required": True},
            "rubric_criteria": [
                {"criterion_id": "c1", "text": "正确列出已知条件", "max_score": "2.00", "required": True},
                {"criterion_id": "c2", "text": "推导过程正确", "max_score": "3.00", "required": True},
                {"criterion_id": "c3", "text": "结论正确且单位完整", "max_score": "5.00", "required": True},
            ],
            "rubric_total": Decimal("10.00"),
            "explanation": [{"kind": "text", "text": "5 × 4 = 20 个。"}],
        },
    ]
    for index, blueprint in enumerate(blueprints):
        created_versions.append(
            _publish_one(
                subject=subject,
                spec=spec,
                node=node_list[index % len(node_list)],
                user=user,
                **blueprint,
            )
        )
    return created_versions


def _publish_one(
    *,
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
    explanation=None,
):
    question = qb_services.create_question(
        subject=subject,
        origin_type=OriginType.USER_AUTHORED,
        actor=user,
        display_label=label,
        is_demo=False,
    )
    version = qb_services.create_question_version_draft(
        question,
        question_type=question_type,
        content=content,
        actor=user,
        practice_max_score=spec.default_max_score(question_type),
        estimated_seconds=(spec.time_rules or {}).get(f"{question_type}_seconds"),
        revision_reason="验收夹具初始版本",
    )
    answer = qb_services.create_answer_key_version(
        version,
        answer_payload=answer_payload,
        actor=user,
        source_type=AnswerSourceType.USER,
        verification_status=VerificationStatus.CHECKED,
        check_basis=FIXTURE_NOTE,
        explanation_blocks=explanation or [],
    )
    if rubric_criteria:
        qb_services.upsert_rubric_version(
            answer,
            criteria=rubric_criteria,
            total_score=rubric_total,
            actor=user,
            usage_note=FIXTURE_NOTE,
        )
    qb_services.replace_knowledge_mappings(
        version,
        [{"node_id": str(node.id), "is_primary": True, "score_weight": Decimal("1")}],
        actor=user,
    )
    qb_services.publish_question_version(version, actor=user)
    return version
