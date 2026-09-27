"""P2 batch 2 / C03: sealed content is unreachable, and merging re-checks exposure.

docs/05 §3 C03: 封存家族不进练习/检索/生成提示/导出/原页预览/缓存；合并家族后检查旧暴露
并使证据失效。

Every enforcement point is exercised through the real HTTP surface (or the real
service the endpoint calls), together with a control question that must keep
working on the same path — an exclusion that also removes the control proves the
path is broken, not that the seal works.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.utils import timezone

from ai.providers import base as providers
from ai.providers import embeddings as embedding_providers
from apps.audit.models import ContentRevision, LLMRun
from apps.audit.services import outbox
from apps.common.enums import AnswerSourceType, OriginType, VerificationStatus
from apps.common.errors import InvalidInput
from apps.ingestion.models import SourceDocument, SourceRegion
from apps.ingestion.services.core import store_asset
from apps.knowledge.models import KnowledgeNode, QuestionTemplate, VerificationPairing
from apps.learning.models import LearnerKnowledgeState, StudyPlan, StudyTask
from apps.learning.services import contamination
from apps.learning.services import evidence as evidence_service
from apps.learning.services import planner as planner_service
from apps.practice.models import Attempt, LearningEvidence, SessionItem
from apps.question_bank.models import (
    QuestionFamily,
    QuestionPoolPolicy,
    QuestionSourceLink,
    QuestionVersion,
)
from apps.question_bank.services import core as qb_services
from apps.question_bank.services import sealing
from apps.search.models import SearchDocument
from apps.search.services import index as index_service
from apps.tutoring.services import core as tutor_services
from tests.integration.test_ai_providers import ask, tutor_session_for
from tests.integration.test_learning_loop import answer_for
from tests.integration.test_p1_tutor_stream import CountingStub
from tests.integration.test_practice_flow import present, start_session, submit

pytestmark = pytest.mark.django_db

#: One direction for every vector, so the vector channel ranks every document and
#: an exclusion can only come from the live visibility gate.
EMBEDDING_MODEL = "c03-scripted-embedding"
QUERY = "题目内容"


class FixedEmbeddingProvider(embedding_providers.BaseEmbeddingProvider):
    """Offline embedding provider: every text gets the same vector as the query."""

    name = "c03_scripted"
    is_stub = True
    _vector = [1.0, 0.0, 0.0, 0.0]

    @property
    def is_available(self) -> bool:
        return True

    @property
    def unavailable_reason(self) -> str:
        return ""

    @property
    def model_name(self) -> str:
        return EMBEDDING_MODEL

    @property
    def dimension(self) -> int | None:
        return len(self._vector)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [list(self._vector) for _text in texts]


@pytest.fixture(autouse=True)
def _reset_embedding_provider():
    yield
    embedding_providers.set_embedding_provider_override(None)


# --------------------------------------------------------------------- helpers
def choice_options() -> list[dict]:
    return [
        {"id": option_id, "label": label, "blocks": [{"kind": "text", "text": text}]}
        for option_id, label, text in zip(
            ("opt_a", "opt_b", "opt_c", "opt_d"), ("A", "B", "C", "D"), ("甲", "乙", "丙", "丁"), strict=False
        )
    ]


def knowledge_node(subject, name: str) -> KnowledgeNode:
    from apps.exams.models import SyllabusVersion

    syllabus = (
        SyllabusVersion.objects.filter(subject=subject, status="published").first()
        or subject.syllabus_versions.first()
    )
    assert syllabus is not None, "演示科目应有可用大纲版本"
    return KnowledgeNode.objects.create(syllabus_version=syllabus, kind="point", canonical_name=name)


def publish_single_choice(
    subject,
    actor,
    *,
    label: str,
    text: str,
    node: KnowledgeNode,
    template: QuestionTemplate | None = None,
    extra_blocks: list[dict] | None = None,
) -> QuestionVersion:
    """One published single-choice question with a checked answer and one mapping."""
    question = qb_services.create_question(
        subject=subject,
        origin_type=OriginType.DEMO,
        actor=actor,
        display_label=label,
        is_demo=True,
    )
    blocks = [{"kind": "text", "text": text}]
    blocks.extend(extra_blocks or [])
    version = qb_services.create_question_version_draft(
        question,
        question_type="single_choice",
        content={"blocks": blocks, "options": choice_options()},
        practice_max_score=Decimal("2.00"),
        actor=actor,
        revision_reason="C03 集成测试夹具",
    )
    qb_services.create_answer_key_version(
        version,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
        actor=actor,
        source_type=AnswerSourceType.USER,
        verification_status=VerificationStatus.CHECKED,
        check_basis="C03 集成测试夹具人工核对",
    )
    version = qb_services.publish_question_version(version, actor=actor)
    qb_services.replace_knowledge_mappings(
        version,
        [
            {
                "node_id": str(node.id),
                "is_primary": True,
                "score_weight": Decimal("1"),
                "template_id": str(template.id) if template is not None else None,
            }
        ],
        actor=actor,
    )
    return version


def seal_question_via_api(caller, project, question, *, key: str, reason: str = "C03 测试封存"):
    return caller.post(f"/api/v1/projects/{project.id}/questions/{question.id}/seal", {"reason": reason}, key=key)


def create_family_via_api(caller, project, subject, *, name: str, key: str) -> dict:
    response = caller.post(
        f"/api/v1/projects/{project.id}/question-families",
        {"subject_id": str(subject.id), "name": name, "note": "C03 集成测试"},
        key=key,
    )
    assert response.status_code == 201, response.content
    return response.json()


def add_to_family_via_api(caller, project, family_id: str, question, *, key: str) -> dict:
    response = caller.post(
        f"/api/v1/projects/{project.id}/question-families/{family_id}/questions",
        {"question_id": str(question.id)},
        key=key,
    )
    assert response.status_code == 201, response.content
    return response.json()


def answer_presented_item(caller, project, item: SessionItem, version: QuestionVersion, *, key: str) -> Attempt:
    present(caller, project, str(item.id))
    response = submit(caller, project, str(item.id), answer_for(version), key=key)
    assert response.status_code == 200, response.content
    assert response.json()["grade"]["status"] == "confirmed", response.content
    return Attempt.objects.get(id=response.json()["attempt_id"])


def practise_a_fresh_question(caller, project, subject, question, *, key: str) -> Attempt:
    session = start_session(caller, project, subject, question, key=f"{key}-session")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    version = QuestionVersion.objects.get(question=question, status="published")
    return answer_presented_item(caller, project, item, version, key=f"{key}-submit")


def dimension_rows(attempt: Attempt) -> dict[str, LearningEvidence]:
    return {row.dimension: row for row in LearningEvidence.objects.filter(attempt=attempt, is_active=True)}


def result_question_ids(response) -> set[str]:
    assert response.status_code == 200, response.content
    return {str(hit["question_id"]) for hit in response.json()["results"] if hit["question_id"]}


def start_practice(caller, project, subject, question, *, key: str):
    return caller.post(
        f"/api/v1/projects/{project.id}/practice-sessions",
        {"mode": "practice", "subject_id": str(subject.id), "question_ids": [str(question.id)]},
        key=key,
    )


def search(caller, project, subject, channel: str):
    return caller.get(
        f"/api/v1/projects/{project.id}/search",
        q=QUERY,
        subject_id=str(subject.id),
        channel=channel,
        limit=50,
    )


def delete_json(caller, path: str):
    return caller.client.delete(path, HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value)


def candidate_question_ids(rows) -> set[str]:
    return {str(row["question_id"]) for row in rows if row["question_id"]}


# ---------------------------------------------------------------------------
# 1. A sealed question is refused everywhere; a control question still works
# ---------------------------------------------------------------------------
def test_sealing_a_question_blocks_every_entry_point_and_the_control_still_works(
    caller, owner, project_a, subject_a1
):
    node_sealed = knowledge_node(subject_a1, "C03-封存考点")
    node_control = knowledge_node(subject_a1, "C03-对照考点")
    # Distinct markers, but both texts share the query's tokens.
    sealed_version = publish_single_choice(
        subject_a1, owner, label="C03-封存题", text="封存目标题目内容", node=node_sealed
    )
    control_version = publish_single_choice(
        subject_a1, owner, label="C03-对照题", text="对照目标题目内容", node=node_control
    )
    sealed_question, control_question = sealed_version.question, control_version.question

    embedding_providers.set_embedding_provider_override(FixedEmbeddingProvider())
    index_service.reindex_project(project_a, subject=subject_a1)
    sealed_document = SearchDocument.objects.get(question_version=sealed_version)
    assert sealed_document.is_searchable is True  # the live gate, not the flag, must exclude

    # Both work before the seal, so the controls below mean something.
    assert start_practice(caller, project_a, subject_a1, sealed_question, key="c03-pre-sealed").status_code == 201
    assert str(sealed_question.id) in result_question_ids(search(caller, project_a, subject_a1, "keyword"))

    sealed = seal_question_via_api(caller, project_a, sealed_question, key="c03-seal-question")
    assert sealed.status_code == 201, sealed.content
    body = sealed.json()
    assert body["is_holdout"] is True and body["sealed"] is True
    assert body["sealed_reason"] == "sealed_question_policy"
    assert body["sealed_question_ids"] == [str(sealed_question.id)]
    assert body["policy_id"] and body["changed_at"] and body["revision"] == 1

    # 1a. 练习/验证会话创建 — refused, naming the sealing policy.
    refused = start_practice(caller, project_a, subject_a1, sealed_question, key="c03-sealed-session")
    assert refused.status_code == 403, refused.content
    error = refused.json()["error"]
    assert error["details"]["reason"] == "sealed_question_policy"
    assert "封存" in error["message"] and "holdout" in error["message"]
    control = start_practice(caller, project_a, subject_a1, control_question, key="c03-control-session")
    assert control.status_code == 201, control.content

    # 1b. 检索 — keyword and vector requests both, through the live gate.
    assert str(sealed_question.id) not in result_question_ids(search(caller, project_a, subject_a1, "keyword"))
    assert str(control_question.id) in result_question_ids(search(caller, project_a, subject_a1, "keyword"))
    assert str(sealed_question.id) not in result_question_ids(search(caller, project_a, subject_a1, "vector"))
    assert str(control_question.id) in result_question_ids(search(caller, project_a, subject_a1, "vector"))
    # The index row still claims to be searchable: only the resolver excluded it.
    sealed_document.refresh_from_db()
    assert sealed_document.is_searchable is True

    control_item = SessionItem.objects.filter(
        session__user=owner, question_version__question=control_question
    ).first()
    assert control_item is not None

    # 1c. 生成提示（AI）— refused before a prompt, a job or an LLMRun exists.
    control_tutor = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": str(control_item.id), "purpose": "explanation"},
        key="c03-control-tutor",
    )
    assert control_tutor.status_code == 201, control_tutor.content  # the control still works
    control_ask = ask(caller, project_a, control_tutor.json()["tutor_session_id"], "请讲解")
    assert control_ask.status_code == 201, control_ask.content
    assert control_ask.json()["status"] == "succeeded"

    sealed_item = SessionItem.objects.create(
        session=control_item.session,
        ordinal=99,
        question_version=sealed_version,
        answer_key_version=sealed_version.answer_keys.order_by("-version").first(),
        max_score=Decimal("2.00"),
    )
    refused_tutor = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": str(sealed_item.id), "purpose": "explanation"},
        key="c03-sealed-tutor",
    )
    assert refused_tutor.status_code == 403, refused_tutor.content
    assert refused_tutor.json()["error"]["details"]["reason"] == "sealed_question_policy"
    assert "封存" in refused_tutor.json()["error"]["message"]

    # 1d. 计划/报告 — never scheduled, in any candidate category (including the
    #     categories a mapping or a pairing points at), and never shown in a plan
    #     payload built before the seal.
    assert str(sealed_question.id) not in candidate_question_ids(
        planner_service.general_candidates(user=owner, project=project_a, limit=50)
    )
    assert str(control_question.id) in candidate_question_ids(
        planner_service.general_candidates(user=owner, project=project_a, limit=50)
    )
    assert str(sealed_question.id) not in candidate_question_ids(
        planner_service.undiagnosed_candidates(user=owner, project=project_a, limit=500)
    )
    assert str(control_question.id) in candidate_question_ids(
        planner_service.undiagnosed_candidates(user=owner, project=project_a, limit=500)
    )
    now = timezone.now()
    LearnerKnowledgeState.objects.create(
        user=owner,
        project=project_a,
        syllabus_version=node_sealed.syllabus_version,
        node=node_sealed,
        summary="needs_foundation",
        best_summary="needs_foundation",
        needs_review=True,
        as_of=now,
    )
    LearnerKnowledgeState.objects.create(
        user=owner,
        project=project_a,
        syllabus_version=node_control.syllabus_version,
        node=node_control,
        summary="needs_foundation",
        best_summary="needs_foundation",
        needs_review=True,
        as_of=now,
    )
    VerificationPairing.objects.create(
        project=project_a,
        subject=subject_a1,
        node=node_sealed,
        immediate_question=sealed_question,
        pairing_version=1,
        is_active=True,
    )
    weak_rows = candidate_question_ids(planner_service.weakly_known_candidates(user=owner, project=project_a, limit=50))
    assert str(sealed_question.id) not in weak_rows
    assert str(control_question.id) in weak_rows

    plan = StudyPlan.objects.create(
        user=owner,
        plan_date=date(2031, 3, 4),
        timezone="UTC",
        revision=1,
        daily_budget_minutes=60,
        generated_at=now,
    )
    sealed_task = StudyTask.objects.create(
        plan=plan,
        user=owner,
        project=project_a,
        subject=subject_a1,
        task_kind="general_practice",
        status="pending",
        question=sealed_question,
        estimated_minutes=5,
        reason_codes=["general_practice"],
    )
    control_task = StudyTask.objects.create(
        plan=plan,
        user=owner,
        project=project_a,
        subject=subject_a1,
        task_kind="general_practice",
        status="pending",
        question=control_question,
        estimated_minutes=5,
        reason_codes=["general_practice"],
    )
    payload = planner_service.plan_payload(plan)
    visible = {row["task_id"] for row in payload["tasks"]}
    assert str(control_task.id) in visible
    assert str(sealed_task.id) not in visible
    assert any("封存" in note for note in payload["notes"])
    with pytest.raises(InvalidInput) as excinfo:
        planner_service.start_task(user=owner, task_id=str(sealed_task.id))
    assert "封存" in excinfo.value.message
    sealed_task.refresh_from_db()
    assert sealed_task.status == "invalidated"

    # 1e. 原页预览 / 资源读取 — the whole original page is refused through the
    #     stored source links (document -> region -> question version).
    page_asset = store_asset(
        owner=owner,
        project=project_a,
        content=b"C03 sealed page",
        content_type="text/plain",
        role="past_paper_page",
        subject=subject_a1,
        reencode=False,
    )
    document = SourceDocument.objects.create(
        owner=owner,
        project=project_a,
        subject=subject_a1,
        title="C03 原页",
        document_type="image",
        role="past_paper_page",
        asset=page_asset,
        checksum="c" * 64,
    )
    region = SourceRegion.objects.create(
        document=document, page_index=1, x=0.1, y=0.1, width=0.4, height=0.2, role="stem_crop"
    )
    QuestionSourceLink.objects.create(question_version=sealed_version, region=region, role="stem")
    refused_asset = caller.get(f"/api/v1/projects/{project_a.id}/assets/{page_asset.id}")
    assert refused_asset.status_code == 403, refused_asset.content
    assert refused_asset.json()["error"]["details"]["reason"] == "sealed_question_policy"
    assert "封存" in refused_asset.json()["error"]["message"]

    control_asset = store_asset(
        owner=owner,
        project=project_a,
        content=b"C03 control page",
        content_type="text/plain",
        role="past_paper_page",
        subject=subject_a1,
        reencode=False,
    )
    control_document = SourceDocument.objects.create(
        owner=owner,
        project=project_a,
        subject=subject_a1,
        title="C03 对照原页",
        document_type="image",
        role="past_paper_page",
        asset=control_asset,
        checksum="d" * 64,
    )
    control_region = SourceRegion.objects.create(
        document=control_document, page_index=1, x=0.1, y=0.1, width=0.4, height=0.2, role="stem_crop"
    )
    QuestionSourceLink.objects.create(question_version=control_version, region=control_region, role="stem")
    assert caller.get(f"/api/v1/projects/{project_a.id}/assets/{control_asset.id}").status_code == 200

    # An asset referenced only by a sealed stem image is refused too.
    image_asset = store_asset(
        owner=owner,
        project=project_a,
        content=b"C03 stem image bytes",
        content_type="text/plain",
        role="stem_crop",
        subject=subject_a1,
        reencode=False,
    )
    image_version = publish_single_choice(
        subject_a1,
        owner,
        label="C03-封存图片题",
        text="含图片的封存题",
        node=knowledge_node(subject_a1, "C03-图片考点"),
        extra_blocks=[{"kind": "image", "asset_id": str(image_asset.id), "alt": "题干图片"}],
    )
    assert (
        caller.get(f"/api/v1/projects/{project_a.id}/assets/{image_asset.id}").status_code == 200
    ), "未封存时题干图片应可读取（对照组）"
    assert (
        seal_question_via_api(caller, project_a, image_version.question, key="c03-seal-image-question").status_code
        == 201
    )
    assert (
        caller.get(f"/api/v1/projects/{project_a.id}/assets/{image_asset.id}").status_code == 403
    ), "封存题的题干图片必须不可读取"

    # 1f. 题库预览 is refused too (it would deliver the sealed stem).
    preview = caller.get(f"/api/v1/projects/{project_a.id}/questions/{sealed_question.id}")
    assert preview.status_code == 403, preview.content
    assert preview.json()["error"]["details"]["reason"] == "sealed_question_policy"
    assert caller.get(f"/api/v1/projects/{project_a.id}/questions/{control_question.id}").status_code == 200

    # 1g. 导出 surface — the resolver's exclusion list is exactly the sealed set.
    exclusions = sealing.sealed_exclusions(project=project_a)
    assert str(sealed_question.id) in exclusions["question_ids"]
    assert str(sealed_version.id) in exclusions["question_version_ids"]
    assert str(control_question.id) not in exclusions["question_ids"]
    assert exclusions["reasons"][str(sealed_question.id)] == "sealed_question_policy"

    # 1h. Inventory endpoint: what is sealed and why.
    inventory = caller.get(f"/api/v1/projects/{project_a.id}/sealed-content")
    assert inventory.status_code == 200, inventory.content
    listed = inventory.json()
    sealed_row = next(row for row in listed["questions"] if row["question_id"] == str(sealed_question.id))
    assert sealed_row["reason_code"] == "sealed_question_policy"
    assert sealed_row["policy_revision"] == 1
    assert sealed_row["change_reason"] == "C03 测试封存"
    assert all(row["question_id"] != str(control_question.id) for row in listed["questions"])

    # The sealed question never reached a model; the control one did.
    assert not LLMRun.objects.filter(
        project_id=project_a.id, input_snapshot__question_version_id=str(sealed_version.id)
    ).exists(), "封存题不得被发送给模型"
    assert LLMRun.objects.filter(
        project_id=project_a.id, input_snapshot__question_version_id=str(control_version.id)
    ).exists()


def test_a_stored_tutor_job_is_not_delivered_after_its_content_becomes_sealed(
    caller, owner, project_a, subject_a1
):
    """缓存: an already-stored explanation must not be replayed once sealed."""
    node = knowledge_node(subject_a1, "C03-缓存考点")
    version = publish_single_choice(subject_a1, owner, label="C03-缓存题", text="缓存题目内容", node=node)
    question = version.question

    session = start_session(caller, project_a, subject_a1, question, key="c03-cache-session")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project_a, str(item.id))
    tutor_session_id = tutor_session_for(caller, project_a, str(item.id), key="c03-cache-tutor")
    asked = ask(caller, project_a, tutor_session_id, "请讲解")
    assert asked.status_code == 201, asked.content
    job = asked.json()
    assert job["status"] == "succeeded", job
    job_id = job["tutor_job_id"]
    assert job["result_blocks"], "存入缓存的前提是 job 已经产生内容"

    # The control: before sealing, the cached content is deliverable.
    assert caller.get(f"/api/v1/projects/{project_a.id}/tutor-jobs/{job_id}").status_code == 200
    assert caller.get(f"/api/v1/projects/{project_a.id}/tutor-jobs/{job_id}/segments").status_code == 200

    assert seal_question_via_api(caller, project_a, question, key="c03-cache-seal").status_code == 201

    for path in (
        f"/api/v1/projects/{project_a.id}/tutor-jobs/{job_id}",
        f"/api/v1/projects/{project_a.id}/tutor-jobs/{job_id}/segments",
        f"/api/v1/projects/{project_a.id}/tutor-jobs/{job_id}/stream",
    ):
        refused = caller.get(path)
        assert refused.status_code == 403, f"{path} 仍可读取封存内容：{refused.content}"
        assert refused.json()["error"]["details"]["reason"] == "sealed_question_policy"
        assert "封存" in refused.json()["error"]["message"]
    replay = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions/{tutor_session_id}/messages",
        {"user_question": "再讲一次"},
        key="c03-cache-replay",
    )
    assert replay.status_code == 403, replay.content
    assert "封存" in replay.json()["error"]["message"]


def test_a_queued_job_is_refused_by_the_worker_without_calling_the_model(
    caller, owner, project_a, subject_a1
):
    """The consumer path re-checks sealing: a sealed question is never sent to a model.

    The job is queued *before* the seal and the outbox event is consumed after it,
    which is exactly the window in which a stored prompt would otherwise reach the
    provider.
    """
    provider = CountingStub()
    providers.set_provider_override(provider)

    node = knowledge_node(subject_a1, "C03-worker考点")
    version = publish_single_choice(subject_a1, owner, label="C03-worker题", text="worker题目内容", node=node)
    session = start_session(caller, project_a, subject_a1, version.question, key="c03-worker-session")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project_a, str(item.id))

    tutor_session = tutor_services.create_tutor_session(item=item, user=owner, purpose="explanation")
    job = tutor_services.create_job(tutor_session=tutor_session, user=owner, user_question="请讲解")
    assert job.status == "queued"
    prompt = tutor_services.build_prompt(item=item, user_question="请讲解")
    assert str(version.id) in prompt or "worker题目内容" in prompt

    assert seal_question_via_api(caller, project_a, version.question, key="c03-worker-seal").status_code == 201
    outbox.after_commit_dispatch()

    job.refresh_from_db()
    assert job.status == "failed"
    assert job.error_code == "blocked_by_sealed_content"
    assert job.result_blocks == []
    assert "封存" in job.error_message
    assert provider.calls == 0, "封存题不得被发送给模型"
    assert not job.segments.exists()
    # The read path refuses the stored job as well.
    refused = caller.get(f"/api/v1/projects/{project_a.id}/tutor-jobs/{job.id}")
    assert refused.status_code == 403, refused.content
    assert refused.json()["error"]["details"]["reason"] == "sealed_question_policy"


# ---------------------------------------------------------------------------
# 2. Family sealing, and a later revision that clears it
# ---------------------------------------------------------------------------
def test_family_seal_covers_every_member_and_a_later_revision_unseals_them(
    caller, owner, project_a, subject_a1
):
    member_a = publish_single_choice(
        subject_a1, owner, label="C03-家族成员甲", text="家族成员甲内容", node=knowledge_node(subject_a1, "C03-家族甲")
    )
    member_b = publish_single_choice(
        subject_a1, owner, label="C03-家族成员乙", text="家族成员乙内容", node=knowledge_node(subject_a1, "C03-家族乙")
    )
    family = create_family_via_api(caller, project_a, subject_a1, name="C03 封存家族", key="c03-family-create")
    add_to_family_via_api(caller, project_a, family["id"], member_a.question, key="c03-family-add-a")
    add_to_family_via_api(caller, project_a, family["id"], member_b.question, key="c03-family-add-b")

    listed = caller.get(f"/api/v1/projects/{project_a.id}/question-families?subject_id={subject_a1.id}")
    assert listed.status_code == 200, listed.content
    row = next(item for item in listed.json() if item["id"] == family["id"])
    assert row["member_count"] == 2 and row["sealed"] is False

    sealed = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{family['id']}/seal",
        {"reason": "C03 家族封存"},
        key="c03-family-seal",
    )
    assert sealed.status_code == 201, sealed.content
    body = sealed.json()
    assert body["sealed"] is True and body["sealed_reason"] == "sealed_family_policy"
    assert body["sealed_question_ids"] == sorted([str(member_a.question_id), str(member_b.question_id)])

    for question in (member_a.question, member_b.question):
        assert sealing.is_sealed(question, project=project_a) == (True, "sealed_family_policy")
        refused = start_practice(caller, project_a, subject_a1, question, key=f"c03-family-block-{question.id}")
        assert refused.status_code == 403, refused.content
        assert refused.json()["error"]["details"]["reason"] == "sealed_family_policy"
        assert "家族" in refused.json()["error"]["message"]
    assert index_service.holdout_reason(member_a.question, project_a) == sealing.SEARCH_EXCLUSION_REASON

    # A later policy revision clears the holdout: sealing is never permanent, and
    # the older row stays as history instead of being edited.
    unsealed = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{family['id']}/unseal",
        {"reason": "C03 解除家族封存"},
        key="c03-family-unseal",
    )
    assert unsealed.status_code == 201, unsealed.content
    assert unsealed.json()["sealed"] is False
    assert unsealed.json()["is_holdout"] is False and unsealed.json()["revision"] == 2
    assert QuestionPoolPolicy.objects.filter(family_id=family["id"]).count() == 2
    assert QuestionPoolPolicy.objects.filter(family_id=family["id"], is_holdout=True).count() == 1

    for question in (member_a.question, member_b.question):
        assert sealing.is_sealed(question, project=project_a) == (False, "")
        allowed = start_practice(caller, project_a, subject_a1, question, key=f"c03-family-allow-{question.id}")
        assert allowed.status_code == 201, allowed.content

    # Index-time eligibility follows the same resolver, in both directions.
    assert index_service.holdout_reason(member_a.question, project_a) == ""
    assert index_service.question_eligibility(member_a, project_a) == (True, "")


def test_question_seal_and_unseal_append_revisions(caller, owner, project_a, subject_a1):
    version = publish_single_choice(
        subject_a1, owner, label="C03-单题封存", text="单题封存内容", node=knowledge_node(subject_a1, "C03-单题考点")
    )
    first = seal_question_via_api(caller, project_a, version.question, key="c03-single-seal")
    assert first.status_code == 201 and first.json()["revision"] == 1
    assert index_service.holdout_reason(version.question, project_a) == sealing.SEARCH_EXCLUSION_REASON
    assert index_service.question_eligibility(version, project_a) == (False, sealing.SEARCH_EXCLUSION_REASON)

    second = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{version.question_id}/unseal",
        {"reason": "C03 解除单题封存"},
        key="c03-single-unseal",
    )
    assert second.status_code == 201, second.content
    assert second.json()["revision"] == 2 and second.json()["sealed"] is False
    assert index_service.holdout_reason(version.question, project_a) == ""


# ---------------------------------------------------------------------------
# 3. Merge: exposure re-check, evidence invalidation, idempotency
# ---------------------------------------------------------------------------
def test_merging_families_rechecks_exposure_and_invalidates_stale_evidence(
    caller, owner, project_a, subject_a1
):
    node = knowledge_node(subject_a1, "C03-合并考点")
    template = QuestionTemplate.objects.create(subject=subject_a1, name="C03-合并模板", review_status="approved")
    source_version = publish_single_choice(
        subject_a1, owner, label="C03-合并源题", text="合并源题内容", node=node, template=template
    )
    target_version = publish_single_choice(
        subject_a1, owner, label="C03-合并目标题", text="合并目标题内容", node=node, template=template
    )
    untouched_version = publish_single_choice(
        subject_a1, owner, label="C03-合并未接触题", text="合并未接触题内容", node=node, template=template
    )

    # Both practised questions are answered *before* joining a family, so their
    # `unseen_variant` / `template_variant` rows are genuinely qualified when the
    # merge makes them stale.
    source_attempt = practise_a_fresh_question(
        caller, project_a, subject_a1, source_version.question, key="c03-merge-source"
    )
    source_rows = dimension_rows(source_attempt)
    assert source_rows["independent_correct"].qualifies is True
    assert source_rows["unseen_variant"].qualifies is True

    target_attempt = practise_a_fresh_question(
        caller, project_a, subject_a1, target_version.question, key="c03-merge-target"
    )
    target_rows = dimension_rows(target_attempt)
    assert target_rows["template_variant"].qualifies is True
    assert target_rows["unseen_variant"].qualifies is True

    source_family = create_family_via_api(
        caller, project_a, subject_a1, name="C03 合并源家族", key="c03-merge-family-source"
    )
    target_family = create_family_via_api(
        caller, project_a, subject_a1, name="C03 合并目标家族", key="c03-merge-family-target"
    )
    add_to_family_via_api(caller, project_a, source_family["id"], source_version.question, key="c03-merge-add-source")
    add_to_family_via_api(caller, project_a, target_family["id"], target_version.question, key="c03-merge-add-target")
    add_to_family_via_api(
        caller, project_a, target_family["id"], untouched_version.question, key="c03-merge-add-untouched"
    )

    # Before the merge the untouched target question is genuinely unseen, and the
    # source family's exposure has not reached the target family.
    before_untouched = contamination.exposure_state(
        user=owner, question_ids=[str(untouched_version.question_id)], project=project_a
    )[str(untouched_version.question_id)]
    assert before_untouched["seen"] is False and before_untouched["reasons"] == []

    impact = caller.get(
        f"/api/v1/projects/{project_a.id}/question-families/{source_family['id']}/merge-impact",
        target_family_id=target_family["id"],
    )
    assert impact.status_code == 200, impact.content
    preview = impact.json()
    assert preview["already_merged"] is False
    assert preview["questions_to_move"] == 1
    assert preview["questions_in_target_after"] == 3
    # Every ``unseen_variant`` / ``template_variant`` row of the merged questions is
    # stale after the merge, qualifying or not: those dimensions exist only because
    # the questions were treated as different families.
    assert preview["evidence_rows_to_invalidate"] == 4
    assert preview["exposed_before_merge"] == 2
    assert preview["exposed_after_merge"] == 3
    assert sorted(preview["exposed_question_ids_before_merge"]) == sorted(
        [str(source_version.question_id), str(target_version.question_id)]
    )

    state_before = LearnerKnowledgeState.objects.filter(user=owner, project=project_a, node=node).first()
    before_as_of = state_before.as_of if state_before is not None else None

    merged = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{source_family['id']}/merge",
        {"target_family_id": target_family["id"], "reason": "C03 合并家族"},
        key="c03-merge-run",
    )
    assert merged.status_code == 201, merged.content
    result = merged.json()
    assert result["noop"] is False and result["content_revision_id"]

    # The counts the preview promised are the counts the merge performed.
    assert result["questions_moved"] == preview["questions_to_move"]
    assert result["questions_in_target_after"] == preview["questions_in_target_after"]
    assert result["evidence_invalidated"] == preview["evidence_rows_to_invalidate"]
    assert result["exposed_before_merge"] == preview["exposed_before_merge"]
    assert result["exposed_after_merge"] == preview["exposed_after_merge"]
    assert result["states_recomputed"] == 1

    # Both families' questions now report the target family; the audit pair and the
    # revision bump exist.
    for question in (source_version.question, target_version.question, untouched_version.question):
        question.refresh_from_db()
        assert str(question.family_id) == target_family["id"]
    source_family_row = QuestionFamily.objects.get(id=source_family["id"])
    target_family_row = QuestionFamily.objects.get(id=target_family["id"])
    assert str(source_family_row.merged_into_id) == target_family["id"]
    assert source_family_row.merged_at is not None
    assert target_family_row.revision == 2
    audit = ContentRevision.objects.filter(
        entity_type="question_family", entity_id=target_family["id"], action="merge"
    ).first()
    assert audit is not None
    assert audit.project_id == project_a.id and audit.reason == "C03 合并家族"
    assert audit.detail["source_family_id"] == source_family["id"]
    assert audit.detail["target_family_id"] == target_family["id"]
    assert audit.detail["questions_moved"] == 1
    assert audit.detail["evidence_invalidated"] == 4

    # Old exposure is re-checked: the question seen in the source family now
    # contaminates the target family — including one that was never presented.
    after_untouched = contamination.exposure_state(
        user=owner, question_ids=[str(untouched_version.question_id)], project=project_a
    )[str(untouched_version.question_id)]
    assert after_untouched["seen"] is True
    assert after_untouched["strict_independent_eligible"] is False
    assert after_untouched["reasons"] == ["family_variant_seen"]
    reason = after_untouched["exclusion_reasons"][0]
    assert "合并" in reason["message"]
    assert reason["evidence"]["evidence_type"] == "family_member"
    assert reason["evidence"]["question_id"] in {
        str(source_version.question_id),
        str(target_version.question_id),
    }
    assert after_untouched["sources"] == [
        f"merged_family_member:{reason['evidence']['question_id']}"
    ]
    # The target question that *was* practised reports the family reason too.
    after_target = contamination.exposure_state(
        user=owner, question_ids=[str(target_version.question_id)], project=project_a
    )[str(target_version.question_id)]
    assert "family_variant_seen" in after_target["reasons"]

    # Evidence rows are invalidated with the required reason, never deleted.
    stale_ids = [
        source_rows["unseen_variant"].id,
        source_rows["template_variant"].id,
        target_rows["unseen_variant"].id,
        target_rows["template_variant"].id,
    ]
    for evidence_id in stale_ids:
        row = LearningEvidence.objects.get(id=evidence_id)
        assert row.is_active is False
        assert row.invalidated_reason == "家族合并后不再构成不同家族证据"
        assert row.invalidated_at is not None
    assert LearningEvidence.objects.filter(id__in=stale_ids).count() == 4
    assert result["evidence_invalidated"] == 4
    projected = {
        row["id"] for row in evidence_service.evidence_summary_rows(user=owner, project=project_a, limit=400)
    }
    assert not (projected & {str(value) for value in stale_ids})

    # The affected knowledge state was recomputed through the state service.
    state_after = LearnerKnowledgeState.objects.filter(user=owner, project=project_a, node=node).first()
    assert state_after is not None
    assert before_as_of is None or state_after.as_of > before_as_of

    # A second identical merge writes nothing.
    again = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{source_family['id']}/merge",
        {"target_family_id": target_family["id"], "reason": "C03 合并家族"},
        key="c03-merge-again",
    )
    assert again.status_code == 201, again.content
    second = again.json()
    assert second["noop"] is True
    assert second["questions_moved"] == 0 and second["evidence_invalidated"] == 0
    assert second["merge_revision"] == 2 and second["content_revision_id"] is None
    assert ContentRevision.objects.filter(
        entity_type="question_family", entity_id=target_family["id"], action="merge"
    ).count() == 1
    assert QuestionFamily.objects.get(id=target_family["id"]).revision == 2
    assert LearningEvidence.objects.filter(id__in=stale_ids, is_active=True).count() == 0

    # The post-merge preview reports the same zero-move reality.
    post_impact = caller.get(
        f"/api/v1/projects/{project_a.id}/question-families/{source_family['id']}/merge-impact",
        target_family_id=target_family["id"],
    ).json()
    assert post_impact["already_merged"] is True
    assert post_impact["questions_to_move"] == 0
    assert post_impact["evidence_rows_to_invalidate"] == 0


def test_merge_refuses_self_cross_subject_and_cross_project(
    caller, project_a, project_b, subject_a1, subject_a2, subject_b1
):
    family_a1 = create_family_via_api(caller, project_a, subject_a1, name="C03-拒绝家族甲", key="c03-refuse-a1")
    family_a2 = create_family_via_api(caller, project_a, subject_a2, name="C03-拒绝家族乙", key="c03-refuse-a2")
    family_b1 = create_family_via_api(caller, project_b, subject_b1, name="C03-拒绝家族丙", key="c03-refuse-b1")

    same = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{family_a1['id']}/merge",
        {"target_family_id": family_a1["id"], "reason": "自合并"},
        key="c03-refuse-self",
    )
    assert same.status_code == 400, same.content
    assert "自身" in same.json()["error"]["message"]

    cross_subject = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{family_a1['id']}/merge",
        {"target_family_id": family_a2["id"], "reason": "跨科目"},
        key="c03-refuse-subject",
    )
    assert cross_subject.status_code == 400, cross_subject.content
    assert "科目" in cross_subject.json()["error"]["message"]

    # A family of another project is simply not in this project's scope.
    cross_project = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{family_a1['id']}/merge",
        {"target_family_id": family_b1["id"], "reason": "跨项目"},
        key="c03-refuse-project",
    )
    assert cross_project.status_code == 404, cross_project.content

    missing = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{family_a1['id']}/merge",
        {"target_family_id": "00000000-0000-0000-0000-000000000000", "reason": "不存在的家族"},
        key="c03-refuse-missing",
    )
    assert missing.status_code == 404, missing.content


# ---------------------------------------------------------------------------
# 4. The family API itself (list / create / patch / membership)
# ---------------------------------------------------------------------------
def test_family_api_creates_lists_patches_and_moves_members(caller, owner, project_a, subject_a1):
    node = knowledge_node(subject_a1, "C03-家族API考点")
    version = publish_single_choice(subject_a1, owner, label="C03-家族API题", text="家族API内容", node=node)

    created = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families",
        {"subject_id": str(subject_a1.id), "name": "C03-家族API"},
        key="c03-api-create",
    )
    assert created.status_code == 201, created.content
    clashing = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families",
        {"subject_id": str(subject_a1.id), "name": "C03-家族API"},
        key="c03-api-create-duplicate",
    )
    assert clashing.status_code == 400, clashing.content
    assert "同名" in clashing.json()["error"]["message"]

    family_id = created.json()["id"]
    added = add_to_family_via_api(caller, project_a, family_id, version.question, key="c03-api-add")
    assert added["changed"] is True and added["member_count"] == 1
    again = add_to_family_via_api(caller, project_a, family_id, version.question, key="c03-api-add-again")
    assert again["changed"] is False and again["member_count"] == 1

    listed = caller.get(f"/api/v1/projects/{project_a.id}/question-families?subject_id={subject_a1.id}").json()
    listed_row = next(row for row in listed if row["id"] == family_id)
    assert listed_row["name"] == "C03-家族API" and listed_row["member_count"] == 1
    assert listed_row["sealed"] is False and listed_row["merged_into_id"] is None

    patched = caller.patch(
        f"/api/v1/projects/{project_a.id}/question-families/{family_id}",
        {"relation_confirmed": True, "note": "C03 API 修订"},
    )
    assert patched.status_code == 200, patched.content
    assert patched.json()["relation_confirmed"] is True and patched.json()["note"] == "C03 API 修订"

    removed = delete_json(
        caller, f"/api/v1/projects/{project_a.id}/question-families/{family_id}/questions/{version.question_id}"
    )
    assert removed.status_code == 200, removed.content
    assert removed.json()["changed"] is True and removed.json()["member_count"] == 0
    version.question.refresh_from_db()
    assert version.question.family_id is None

    # A sealed question cannot join a family (the seal would silently change
    # meaning), which is the API-level half of the sealing gate.
    assert seal_question_via_api(caller, project_a, version.question, key="c03-api-seal-member").status_code == 201
    refused = caller.post(
        f"/api/v1/projects/{project_a.id}/question-families/{family_id}/questions",
        {"question_id": str(version.question_id)},
        key="c03-api-add-sealed",
    )
    assert refused.status_code == 403, refused.content
    assert refused.json()["error"]["details"]["reason"] == "sealed_question_policy"


# ---------------------------------------------------------------------------
# 5. Ownership: another user's project is a 404 on every new endpoint
# ---------------------------------------------------------------------------
def test_new_endpoints_are_owner_scoped(caller, other_caller, owner, project_a, subject_a1):
    node = knowledge_node(subject_a1, "C03-权限考点")
    version = publish_single_choice(subject_a1, owner, label="C03-权限题", text="权限内容", node=node)
    family = create_family_via_api(caller, project_a, subject_a1, name="C03-权限家族", key="c03-owner-family")
    add_to_family_via_api(caller, project_a, family["id"], version.question, key="c03-owner-add")

    base = f"/api/v1/projects/{project_a.id}"
    posts = [
        (f"{base}/questions/{version.question_id}/seal", {"reason": "x"}),
        (f"{base}/questions/{version.question_id}/unseal", {"reason": "x"}),
        (f"{base}/question-families/{family['id']}/seal", {"reason": "x"}),
        (f"{base}/question-families/{family['id']}/unseal", {"reason": "x"}),
        (f"{base}/question-families", {"subject_id": str(subject_a1.id), "name": "越权家族"}),
        (f"{base}/question-families/{family['id']}/questions", {"question_id": str(version.question_id)}),
        (f"{base}/question-families/{family['id']}/merge", {"target_family_id": str(family["id"]), "reason": "x"}),
    ]
    for index, (path, body) in enumerate(posts):
        response = other_caller.post(path, body, key=f"c03-other-post-{index}")
        assert response.status_code == 404, f"{path} → {response.status_code}: {response.content}"

    gets = [
        f"{base}/sealed-content",
        f"{base}/question-families",
        f"{base}/question-families/{family['id']}/merge-impact?target_family_id={family['id']}",
        f"{base}/questions/{version.question_id}",
    ]
    for path in gets:
        assert other_caller.get(path).status_code == 404, path
    assert other_caller.patch(f"{base}/question-families/{family['id']}", {"note": "越权"}).status_code == 404
    assert (
        delete_json(
            other_caller, f"{base}/question-families/{family['id']}/questions/{version.question_id}"
        ).status_code
        == 404
    )

    # The control: the owner reaches them all.
    assert caller.get(f"{base}/sealed-content").status_code == 200
    assert caller.get(f"{base}/question-families").status_code == 200
    assert (
        caller.get(f"{base}/question-families/{family['id']}/merge-impact?target_family_id={family['id']}").status_code
        == 400
    )  # self-merge is refused, but the scope check passed
