"""P2 batch 2 (acceptance C02): AI-generated variants validated before content.

Acceptance rule (docs/05 §3, C02): 生成题条件完整、答案可验证，单选唯一；失败留候选；
不进入 official_past 统计。

Product rules proved here, each with the test that proves it:

* 模型不发布内容 — a proposal only ever creates an ingestion job plus candidates;
  publication stays the existing human gate (``…/import-candidates/{id}/publish``),
  and a candidate whose answer nobody confirmed cannot publish at all
  (``test_a_variant_answer_must_be_confirmed_by_a_human_before_it_can_publish``).
* 条件完整、答案可验证、单选唯一 — :func:`ai.prompts.registry.validate_variant_payload`
  (``test_variant_validator_enforces_every_type_rule``,
  ``test_variant_validator_surfaces_the_shared_content_contract_verbatim``,
  ``test_single_choice_with_two_correct_options_is_rejected_and_stays_a_candidate``,
  ``test_fill_blank_whose_answers_do_not_match_its_blanks_is_rejected_and_stays_a_candidate``,
  ``test_constructed_response_whose_rubric_total_disagrees_is_rejected_and_stays_a_candidate``).
* 独立校验 — :func:`apps.question_bank.services.variants.independent_checks` re-derives
  the answer contract, the duplicate identity, the syllabus ownership and the
  "AI content never joins a real paper" rule from the stored payload
  (``test_independent_checks_do_not_trust_the_prompt_validator``,
  ``test_a_variant_that_copies_the_source_stem_is_rejected_as_a_duplicate``,
  ``test_a_variant_duplicating_a_published_question_cannot_publish``,
  ``test_a_variant_targeting_another_subjects_node_cannot_publish``,
  ``test_the_official_past_rule_is_asserted_not_assumed``).
* 失败留候选 — a rejected proposal is stored with its problems and reported by the
  job; nothing is dropped and nothing is published
  (``test_no_proposal_passed_is_reported_and_every_failure_stays_a_candidate``).
* 不进入 official_past 统计 — the published variant is ``ai_generated``/``is_demo``,
  has no paper item, cannot be attached to a real paper and never appears in the
  cycle analysis (``test_a_variant_answer_must_be_confirmed_by_a_human_before_it_can_publish``).
* AI 未配置 — without a provider the endpoint answers 503 ``ai_not_configured`` and
  writes only one ``unavailable`` audit row
  (``test_proposal_without_a_provider_is_ai_not_configured``).
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest
from django.core.exceptions import ValidationError

from ai.prompts import registry as prompts
from ai.providers import base as providers
from apps.analytics.services import cycles as cycle_service
from apps.audit.models import LLMRun
from apps.common.content import content_digest
from apps.common.enums import ImportCandidateStatus, ImportJobStatus
from apps.exams.models import PaperItem
from apps.exams.services import core as exam_services
from apps.ingestion.models import ImportCandidate, ImportJob
from apps.knowledge.models import KnowledgeNode
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion
from apps.question_bank.services import core as qb_services
from apps.question_bank.services import sealing
from apps.question_bank.services import variants as variant_services

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------
# Fixtures and scripted provider
# --------------------------------------------------------------------------
class VariantProvider(providers.BaseProvider):
    """Deterministic scripted provider: a test double, never a real model.

    ``is_stub=True`` is not decoration: the candidate, the job and the audit row
    must all show that no real model was called.
    """

    name = "test-variants"
    capabilities = ("propose_variant",)
    is_stub = True

    def __init__(self, payloads: list[dict], *, fail_on_call: int | None = None, error: Exception | None = None):
        self.payloads = list(payloads)
        self.requests: list[providers.AiRequest] = []
        self.fail_on_call = fail_on_call
        self.error = error or providers.AiTimeout("scripted provider timeout")

    def call(self, request: providers.AiRequest) -> providers.AiCallResult:
        self.requests.append(request)
        if self.fail_on_call is not None and len(self.requests) >= self.fail_on_call:
            raise self.error
        payload = self.payloads[min(len(self.requests) - 1, len(self.payloads) - 1)]
        return providers.AiCallResult(
            payload=payload,
            raw_text=json.dumps(payload, ensure_ascii=False),
            prompt_tokens=11,
            completion_tokens=22,
            cost_cents="0.0000",
            cost_known=True,
            attempts=1,
            latency_ms=3,
            is_stub=True,
            provider=self.name,
            model="test-variant-model",
            prompt_version=request.prompt_version,
        )


def _source_version(subject, question_type: str = "single_choice") -> QuestionVersion:
    version = (
        QuestionVersion.objects.filter(
            question__subject=subject,
            question_type=question_type,
            status="published",
            parent_material_version__isnull=True,
        )
        .select_related("question")
        .order_by("question__display_label")
        .first()
    )
    assert version is not None, f"演示夹具应包含已发布的 {question_type} 题目"
    return version


def _node(subject) -> KnowledgeNode:
    node = (
        KnowledgeNode.objects.filter(syllabus_version__subject=subject, syllabus_version__status="published")
        .exclude(is_unclassified=True)
        .select_related("syllabus_version")
        .order_by("display_order")
        .first()
    )
    assert node is not None
    return node


def _options() -> list[dict]:
    return [
        {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "96 元"}]},
        {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "100 元"}]},
        {"id": "opt_c", "label": "C", "blocks": [{"kind": "text", "text": "104 元"}]},
        {"id": "opt_d", "label": "D", "blocks": [{"kind": "text", "text": "120 元"}]},
    ]


def _single_choice_payload(*, stem: str = "变式：某商品原价 100 元，先涨价 20% 再降价 20%，最终价格是多少？") -> dict:
    return {
        "question_type": "single_choice",
        "content": {"blocks": [{"kind": "text", "text": stem}], "options": _options()},
        "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_b"},
        "practice_max_score": "2.00",
        "difficulty_note": "与原题相当",
        "rationale": "改变数值条件，仍考查同一考点的同型计算",
        "doubts": [],
    }


def _set_provider(payloads: list[dict]) -> VariantProvider:
    provider = VariantProvider(payloads)
    providers.set_provider_override(provider)
    return provider


def _propose(caller, project, *, source_version, node, payloads, key, count=1, difficulty_note="与原题相当"):
    _set_provider(payloads)
    return caller.post(
        f"/api/v1/projects/{project.id}/variants/propose",
        {
            "source_version_id": str(source_version.id),
            "node_id": str(node.id),
            "count": count,
            "difficulty_note": difficulty_note,
        },
        key=key,
    )


def _confirm_answer(caller, project, candidate_id: str, *, extra: dict | None = None):
    """The ordinary human confirmation of a proposal's answer (see P1-01 flow)."""
    candidate = ImportCandidate.objects.get(id=candidate_id)
    payload = dict(candidate.draft_payload)
    payload["answer_status_known"] = True
    payload["answer_confirmed_by_human"] = True
    payload["check_basis"] = "人工核对变式条件与答案"
    if extra:
        payload.update(extra)
    return caller.patch(
        f"/api/v1/projects/{project.id}/import-candidates/{candidate_id}",
        {"draft_payload": payload, "expected_revision": candidate.revision, "note": "人工确认 AI 变式答案"},
    )


def _codes(row: dict) -> set[str]:
    return {issue["code"] for issue in row["review_issues"]}


# --------------------------------------------------------------------------
# 1. No provider: honest 503, one audit row, nothing created
# --------------------------------------------------------------------------
def test_proposal_without_a_provider_is_ai_not_configured(caller, project_a, subject_a1):
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    providers.set_provider_override(providers.NullProvider())

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/variants/propose",
        {"source_version_id": str(source.id), "node_id": str(node.id), "count": 1},
        key="variant-no-provider",
    )
    assert response.status_code == 503, response.content
    body = response.json()["error"]
    assert body["code"] == "ai_not_configured"
    assert body["details"]["error_code"] == "ai_not_configured"

    # Nothing was fabricated: no job, no candidate, no question.
    assert ImportJob.objects.filter(project=project_a, input_kind="ai_variant").count() == 0
    assert ImportCandidate.objects.filter(job__input_kind="ai_variant").count() == 0
    assert Question.objects.filter(subject=subject_a1, origin_type="ai_generated").count() == 0
    runs = LLMRun.objects.filter(capability="propose_variant")
    assert runs.count() == 1
    run = runs.get()
    assert run.status == "unavailable"
    assert run.error_code == "ai_not_configured"
    assert run.project_id == project_a.id


def test_the_offline_stub_can_never_be_mistaken_for_a_generator(caller, project_a, subject_a1):
    """The stub answers propose_variant, but its payload must fail validation."""
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    providers.set_provider_override(providers.StubProvider())

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/variants/propose",
        {"source_version_id": str(source.id), "node_id": str(node.id), "count": 1},
        key="variant-stub",
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["is_stub"] is True
    assert body["validation"]["accepted"] == 0
    assert body["nothing_passed"] is True
    [row] = body["candidates"]
    assert row["is_stub_output"] is True
    codes = _codes(row)
    assert "variant_answer_missing" in codes
    assert row["blocking_issues"], "stub 输出必须留下阻塞问题，不能被当成可用变式"
    candidate = ImportCandidate.objects.get(id=row["candidate_id"])
    assert candidate.status == ImportCandidateStatus.DRAFT
    # A publish attempt reports the problems instead of publishing stub content.
    publish = caller.post(
        f"/api/v1/projects/{project_a.id}/import-candidates/{candidate.id}/publish",
        {"node_ids": [str(node.id)]},
        key="variant-stub-publish",
    )
    assert publish.status_code == 422
    assert Question.objects.filter(subject=subject_a1, origin_type="ai_generated").count() == 0


# --------------------------------------------------------------------------
# 2. A well-formed variant becomes an ordinary reviewable candidate
# --------------------------------------------------------------------------
def test_well_formed_variant_becomes_an_awaiting_review_candidate(caller, project_a, subject_a1):
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    payload = _single_choice_payload()
    provider = _set_provider([payload])

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/variants/propose",
        {
            "source_question_id": str(source.question_id),
            "node_id": str(node.id),
            "count": 1,
            "difficulty_note": "与原题相当",
        },
        key="variant-good",
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["source_version_id"] == str(source.id)
    assert body["prompt_version"] == prompts.PROPOSE_VARIANT_PROMPT_VERSION
    assert body["origin_type"] == "ai_generated"
    assert body["provider"] == "test-variants" and body["model"] == "test-variant-model"
    assert body["is_stub"] is True
    assert body["validation"] == {
        "requested_count": 1,
        "count": 1,
        "accepted": 1,
        "rejected": 0,
        "blocking_problem_count": 0,
        "nothing_passed": False,
    }

    job = ImportJob.objects.get(id=body["job_id"])
    assert job.input_kind == "ai_variant"
    assert job.extractor_version == prompts.PROPOSE_VARIANT_PROMPT_VERSION
    assert job.subject_id == subject_a1.id
    assert job.status == ImportJobStatus.AWAITING_REVIEW

    [row] = body["candidates"]
    candidate = ImportCandidate.objects.get(id=row["candidate_id"])
    assert candidate.job_id == job.id
    assert candidate.status == ImportCandidateStatus.DRAFT  # 待校对 = awaiting review
    assert row["awaiting_human_review"] is True
    assert row["question_type"] == "single_choice"
    # The validator and the independent checks found nothing to fix; the only
    # blocking issue is the deliberate "the model's answer is not verified yet" gate.
    variant_codes = {
        code
        for code in _codes(row)
        if code.startswith(("answer.", "duplicate", "variant", "node_", "stem_", "rubric"))
    }
    assert variant_codes == set()
    assert {issue["code"] for issue in row["blocking_issues"]} == {"answer_unknown"}
    # The answer is recorded as AI-derived and pending: a human must still confirm.
    assert row["answer_needs_confirmation"] is True
    assert row["answer_source_type"] == "ai_derived"
    assert candidate.draft_payload["answer_status_known"] is False
    assert candidate.draft_payload["answer_source_type"] == "ai_derived"
    assert candidate.draft_payload["answer_verification"] == {
        "source_type": "ai_derived",
        "verification_status": "pending",
        "requires_human_confirmation": True,
        "note": "AI 推导答案：发布前必须由人工核对并确认（answer_status_known=true）",
    }
    assert candidate.draft_payload["variant_of_version_id"] == str(source.id)
    assert candidate.is_stub_output is True
    # The digest is the normalized content digest, stored on payload and machine record.
    expected_digest = content_digest(payload["content"])
    assert row["content_digest"] == expected_digest
    assert candidate.machine_payload["content_digest"] == expected_digest

    run = LLMRun.objects.get(id=row["llm_run_id"])
    assert run.status == "succeeded"
    assert run.capability == "propose_variant"
    assert run.prompt_version == prompts.PROPOSE_VARIANT_PROMPT_VERSION
    assert run.model_identifier == "test-variant-model"
    assert run.is_stub is True
    assert (run.prompt_tokens, run.completion_tokens, run.attempts) == (11, 22, 1)
    assert run.validation_result["accepted"] is True
    assert run.validation_result["problems"] == []
    assert run.validation_result["content_digest"] == expected_digest
    # The prompt used the source version and the target node, never a copy of the answer.
    prompt = provider.requests[0].prompt
    assert source.content["blocks"][0]["text"] in prompt
    assert node.canonical_name in prompt
    assert "不得直接照抄" in prompt and "不会自动发布" in prompt

    listing = caller.get(f"/api/v1/projects/{project_a.id}/variants").json()
    assert listing["count"] == 1
    assert listing["jobs"][0]["job_id"] == body["job_id"]
    assert listing["jobs"][0]["candidates"][0]["candidate_id"] == row["candidate_id"]


# --------------------------------------------------------------------------
# 3. Rules the validator enforces (and the candidate that survives the failure)
# --------------------------------------------------------------------------
def test_variant_validator_surfaces_the_shared_content_contract_verbatim():
    payload = _single_choice_payload()
    payload["content"]["options"] = []
    _clean, problems = prompts.validate_variant_payload(payload, question_type="single_choice")
    # Verbatim: the same dict the publish gate would report, not a re-worded copy.
    assert {
        "code": "options_empty",
        "message": "选择题必须至少有一个选项",
        "path": "options",
        "severity": "blocking",
    } in problems
    payload["content"] = {"blocks": [], "options": _options()}
    _clean, problems = prompts.validate_variant_payload(payload, question_type="single_choice")
    assert {
        "code": "stem_empty",
        "message": "题干不能为空",
        "path": "blocks",
        "severity": "blocking",
    } in problems


def test_variant_validator_enforces_every_type_rule():
    # Only the five scorable types: a material is never a variant.
    _clean, problems = prompts.validate_variant_payload(
        {"question_type": "material", "content": {"blocks": []}, "answer_payload": {}},
        question_type="material",
    )
    assert [problem["code"] for problem in problems] == ["variant_type_not_scorable"]

    # A non-object payload and a missing answer are problems, not crashes.
    _clean, problems = prompts.validate_variant_payload("not json", question_type="single_choice")
    assert [problem["code"] for problem in problems] == ["not_object"]
    _clean, problems = prompts.validate_variant_payload(
        {**_single_choice_payload(), "answer_payload": {}}, question_type="single_choice"
    )
    assert "variant_answer_missing" in {problem["code"] for problem in problems}

    # The declared type must match the requested one.
    _clean, problems = prompts.validate_variant_payload(
        {**_single_choice_payload(), "question_type": "true_false"}, question_type="single_choice"
    )
    assert "variant_type_mismatch" in {problem["code"] for problem in problems}

    multiple = {
        "question_type": "multiple_choice",
        "content": {"blocks": [{"kind": "text", "text": "变式多选"}], "options": _options()},
        "answer_payload": {"kind": "multiple_choice", "correct_option_ids": ["opt_a"]},
    }
    _clean, problems = prompts.validate_variant_payload(multiple, question_type="multiple_choice")
    assert "multiple_choice_too_few_correct" in {problem["code"] for problem in problems}
    multiple["answer_payload"]["correct_option_ids"] = ["opt_a", "opt_a"]
    _clean, problems = prompts.validate_variant_payload(multiple, question_type="multiple_choice")
    assert "multiple_choice_duplicate_correct" in {problem["code"] for problem in problems}
    multiple["answer_payload"]["correct_option_ids"] = ["opt_a", "opt_z"]
    _clean, problems = prompts.validate_variant_payload(multiple, question_type="multiple_choice")
    assert "multiple_choice_unknown_correct" in {problem["code"] for problem in problems}

    true_false = {
        "question_type": "true_false",
        "content": {"blocks": [{"kind": "text", "text": "变式判断：该说法正确。"}]},
        "answer_payload": {"kind": "true_false", "value": "true"},
    }
    _clean, problems = prompts.validate_variant_payload(true_false, question_type="true_false")
    assert "true_false_value_missing" in {problem["code"] for problem in problems}

    fill_blank = {
        "question_type": "fill_blank",
        "content": {
            "blocks": [{"kind": "text", "text": "变式填空：结果为 __b1__。"}],
            "blanks": [{"blank_id": "b1", "label": "第1空", "max_score": "2.00"}],
        },
        "answer_payload": {"kind": "fill_blank", "blanks": {"b1": {"max_score": "2.00"}}},
    }
    _clean, problems = prompts.validate_variant_payload(fill_blank, question_type="fill_blank")
    assert "blank_accepted_values_missing" in {problem["code"] for problem in problems}

    constructed = {
        "question_type": "constructed_response",
        "content": {"blocks": [{"kind": "text", "text": "变式大题：写出推导过程。"}]},
        "answer_payload": {"kind": "constructed_response", "rubric_required": True},
        "rubric_criteria": [{"criterion_id": "c1", "text": "过程", "max_score": "0"}],
        "rubric_total_score": "3.00",
    }
    _clean, problems = prompts.validate_variant_payload(constructed, question_type="constructed_response")
    codes = {problem["code"] for problem in problems}
    assert {"rubric_criterion_score_not_positive", "rubric_total_mismatch"} <= codes
    constructed["rubric_criteria"] = []
    _clean, problems = prompts.validate_variant_payload(constructed, question_type="constructed_response")
    assert "rubric_criteria_missing" in {problem["code"] for problem in problems}

    # The stem must not state the answer, and generated content may not reference assets.
    leak = _single_choice_payload(stem="变式：正确答案是 opt_b，请直接选择。")
    _clean, problems = prompts.validate_variant_payload(leak, question_type="single_choice")
    assert "stem_leaks_answer" in {problem["code"] for problem in problems}
    with_image = _single_choice_payload()
    with_image["content"]["blocks"] = [
        {"kind": "text", "text": "变式题干"},
        {"kind": "image", "asset_id": "00000000-0000-0000-0000-000000000000"},
    ]
    _clean, problems = prompts.validate_variant_payload(with_image, question_type="single_choice")
    assert "variant_assets_not_allowed" in {problem["code"] for problem in problems}


def test_a_material_cannot_be_a_variant_source(caller, project_a, subject_a1):
    """Only the five scorable types exist as variants; a material never does."""
    material = QuestionVersion.objects.filter(
        question__subject=subject_a1, question_type="material", status="published"
    ).first()
    assert material is not None, "演示夹具应包含已发布的共享材料题"
    node = _node(subject_a1)
    provider = _set_provider([_single_choice_payload()])
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/variants/propose",
        {"source_version_id": str(material.id), "node_id": str(node.id), "count": 1},
        key="variant-material-source",
    )
    assert response.status_code == 400, response.content
    assert response.json()["error"]["code"] == "invalid_input"
    # Rejected before any paid model call, and no empty job is left behind.
    assert provider.requests == []
    assert ImportJob.objects.filter(project=project_a, input_kind="ai_variant").count() == 0


def test_single_choice_with_two_correct_options_is_rejected_and_stays_a_candidate(
    caller, project_a, subject_a1
):
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    payload = _single_choice_payload()
    payload["answer_payload"] = {"kind": "single_choice", "correct_option_ids": ["opt_a", "opt_b"]}

    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[payload], key="variant-two-correct"
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["validation"]["accepted"] == 0
    assert body["validation"]["rejected"] == 1
    assert body["validation"]["nothing_passed"] is True
    assert body["nothing_passed"] is True
    [row] = body["candidates"]
    assert row["status"] == ImportCandidateStatus.DRAFT
    blocking_codes = {issue["code"] for issue in row["blocking_issues"]}
    assert {"single_choice_multiple_correct", "answer_unknown"} <= blocking_codes
    # The candidate carries the pipeline's blocking problems plus the deliberate
    # "the model's answer is not confirmed yet" gate.
    assert body["validation"]["blocking_problem_count"] == len(blocking_codes - {"answer_unknown"})
    # The failure is reported by the job and the candidate survives with it.
    job = ImportJob.objects.get(id=body["job_id"])
    assert job.status == ImportJobStatus.AWAITING_REVIEW
    assert any(problem["code"] == "variant_rejected" for problem in job.problems)
    assert any(problem["code"] == "no_variant_usable" for problem in job.problems)
    assert any("全部未通过校验" in note for note in body["notes"])
    assert ImportCandidate.objects.filter(job=job).count() == 1
    # And it cannot be published.
    publish = _publish(caller, project_a, row["candidate_id"], node_id=node.id, key="variant-two-correct-publish")
    assert publish.status_code == 422
    publish_codes = {problem["code"] for problem in publish.json()["error"]["details"]["problems"]}
    assert "single_choice_multiple_correct" in publish_codes


def test_fill_blank_whose_answers_do_not_match_its_blanks_is_rejected_and_stays_a_candidate(
    caller, project_a, subject_a1
):
    source = _source_version(subject_a1, "fill_blank")
    node = _node(subject_a1)
    payload = {
        "question_type": "fill_blank",
        "content": {
            "blocks": [{"kind": "text", "text": "变式填空：方程的解为 __b1__，请填写最简形式。"}],
            "blanks": [{"blank_id": "b1", "label": "第1空", "max_score": "3.00"}],
        },
        "answer_payload": {
            "kind": "fill_blank",
            "blanks": {"b2": {"accepted_values": ["1/2"], "max_score": "3.00"}},
        },
        "practice_max_score": "3.00",
    }
    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[payload], key="variant-blank-mismatch"
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["validation"]["accepted"] == 0
    [row] = body["candidates"]
    codes = _codes(row)
    assert {"fill_blank_answer_missing_for", "fill_blank_answer_unknown_blank"} <= codes
    assert row["status"] == ImportCandidateStatus.DRAFT
    assert ImportCandidate.objects.filter(id=row["candidate_id"]).exists()


def test_constructed_response_whose_rubric_total_disagrees_is_rejected_and_stays_a_candidate(
    caller, project_a, subject_a1
):
    source = _source_version(subject_a1, "constructed_response")
    node = _node(subject_a1)
    payload = {
        "question_type": "constructed_response",
        "content": {"blocks": [{"kind": "text", "text": "变式大题：请写出完整推导过程并给出结论。"}]},
        "answer_payload": {"kind": "constructed_response", "rubric_required": True},
        "rubric_criteria": [
            {"criterion_id": "c1", "text": "列出条件", "max_score": "2.00", "required": True},
            {"criterion_id": "c2", "text": "推导正确", "max_score": "3.00", "required": True},
        ],
        "rubric_total_score": "6.00",
    }
    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[payload], key="variant-rubric-mismatch"
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["validation"]["accepted"] == 0
    [row] = body["candidates"]
    codes = _codes(row)
    assert "rubric_total_mismatch" in codes
    # The independent pass reaches the same conclusion from the stored payload.
    assert "answer.rubric_total_mismatch" in codes
    assert row["status"] == ImportCandidateStatus.DRAFT
    run = LLMRun.objects.get(id=row["llm_run_id"])
    assert run.status == "rejected"
    assert run.validation_result["accepted"] is False


def test_no_proposal_passed_is_reported_and_every_failure_stays_a_candidate(caller, project_a, subject_a1):
    """Every failure of a batch is kept as a candidate; the payload says so."""
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    first = _single_choice_payload(stem="变式甲：条件不完整的题目")
    first["answer_payload"] = {}
    second = _single_choice_payload(stem="变式乙：条件不完整的题目")
    second["content"]["options"] = []
    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[first, second], key="variant-all-fail", count=2
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["count"] == 2
    assert body["validation"]["accepted"] == 0
    assert body["validation"]["rejected"] == 2
    assert body["nothing_passed"] is True
    assert len(body["candidates"]) == 2
    assert all(row["status"] == ImportCandidateStatus.DRAFT for row in body["candidates"])
    assert ImportCandidate.objects.filter(job_id=body["job_id"]).count() == 2
    job = ImportJob.objects.get(id=body["job_id"])
    codes = {problem["code"] for problem in job.problems}
    assert {"variant_rejected", "no_variant_usable"} <= codes
    assert any("全部未通过校验" in note for note in body["notes"])


# --------------------------------------------------------------------------
# 4. Duplicate identity (published content, source stem, other proposals)
# --------------------------------------------------------------------------
def test_a_variant_that_copies_the_source_stem_is_rejected_as_a_duplicate(caller, project_a, subject_a1):
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    source_stem = source.content["blocks"][0]["text"]
    payload = _single_choice_payload(stem=source_stem)
    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[payload], key="variant-copy-stem"
    )
    assert response.status_code == 201, response.content
    body = response.json()
    [row] = body["candidates"]
    codes = _codes(row)
    # Both the prompt validator (avoid_stems) and the independent check refuse it.
    assert {"stem_copies_source", "variant_duplicates_source"} <= codes
    assert body["validation"]["accepted"] == 0
    assert row["status"] == ImportCandidateStatus.DRAFT


def test_a_variant_duplicating_a_published_question_cannot_publish(caller, project_a, subject_a1):
    """A duplicate of published content stays blocked even after the answer is confirmed."""
    source = _source_version(subject_a1)  # 单选-1
    node = _node(subject_a1)
    others = list(
        QuestionVersion.objects.filter(
            question__subject=subject_a1,
            question_type="single_choice",
            status="published",
            parent_material_version__isnull=True,
        )
        .exclude(id=source.id)
        .order_by("question__display_label")
    )
    assert others, "演示夹具应包含第二道已发布单选题"
    duplicate = others[0]
    answer = duplicate.answer_keys.filter(is_disputed=False).order_by("-version").first()
    payload = {
        "question_type": "single_choice",
        "content": duplicate.content,
        "answer_payload": answer.answer_payload,
        "practice_max_score": "2.00",
    }
    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[payload], key="variant-duplicate-published"
    )
    assert response.status_code == 201, response.content
    body = response.json()
    [row] = body["candidates"]
    assert "duplicate_published_question" in _codes(row)
    assert body["validation"]["accepted"] == 0

    # Confirming the answer cannot clear a duplicate: the check is recomputed
    # from the stored payload inside the publish gate.
    patched = _confirm_answer(caller, project_a, row["candidate_id"])
    assert patched.status_code == 200, patched.content
    assert "duplicate_published_question" in _codes(patched.json())
    publish = caller.post(
        f"/api/v1/projects/{project_a.id}/import-candidates/{row['candidate_id']}/publish",
        {"node_ids": [str(node.id)]},
        key="variant-duplicate-publish",
    )
    assert publish.status_code == 422
    problems = publish.json()["error"]["details"]["problems"]
    assert "duplicate_published_question" in {problem["code"] for problem in problems}
    assert Question.objects.filter(subject=subject_a1, origin_type="ai_generated").count() == 0


def test_two_identical_proposals_in_one_batch_are_reported_as_duplicates(caller, project_a, subject_a1):
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    payload = _single_choice_payload(stem="变式：同一批次里重复出现的提案")
    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[payload], key="variant-batch-duplicate", count=2
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["count"] == 2
    assert body["validation"]["accepted"] == 1
    first, second = body["candidates"]
    assert "duplicate_pending_proposal" not in _codes(first)
    assert "duplicate_pending_proposal" in _codes(second)
    assert second["blocking_issues"]


def test_a_variant_duplicating_a_published_family_member_is_reported(caller, project_a, subject_a1):
    """Same subject *and* same family are both checked for the duplicate identity."""
    from apps.question_bank.models import QuestionFamily

    source = _source_version(subject_a1)
    node = _node(subject_a1)
    duplicate = (
        QuestionVersion.objects.filter(
            question__subject=subject_a1,
            question_type="single_choice",
            status="published",
            parent_material_version__isnull=True,
        )
        .exclude(id=source.id)
        .order_by("question__display_label")
        .first()
    )
    assert duplicate is not None
    family = QuestionFamily.objects.create(subject=subject_a1, name="C02 变式家族")
    duplicate.question.family = family
    duplicate.question.save(update_fields=["family", "updated_at"])
    source.question.family = family
    source.question.save(update_fields=["family", "updated_at"])
    answer = duplicate.answer_keys.filter(is_disputed=False).order_by("-version").first()
    payload = {
        "question_type": "single_choice",
        "content": duplicate.content,
        "answer_payload": answer.answer_payload,
        "practice_max_score": "2.00",
    }
    response = _propose(
        caller, project_a, source_version=source, node=node, payloads=[payload], key="variant-family-duplicate"
    )
    assert response.status_code == 201, response.content
    [row] = response.json()["candidates"]
    codes = _codes(row)
    assert {"duplicate_published_question", "duplicate_family_question"} <= codes
    family_issue = next(issue for issue in row["review_issues"] if issue["code"] == "duplicate_family_question")
    assert family_issue["family_id"] == str(family.id)


def test_independent_checks_do_not_trust_the_prompt_validator(project_a, subject_a1):
    """The independent pass re-derives the answer contract from content + answer."""
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    payload = _single_choice_payload()
    payload["answer_payload"] = {"kind": "single_choice", "correct_option_id": "opt_z"}
    result = variant_services.independent_checks(payload=payload, source_version=source, node=node)
    assert "answer.correct_option_not_in_options" in {problem["code"] for problem in result["problems"]}
    assert result["content_digest"] == content_digest(payload["content"])
    assert result["origin_type"] == "ai_generated"
    assert result["source_version_id"] == str(source.id)

    other_subject_node = (
        KnowledgeNode.objects.filter(syllabus_version__subject__project=project_a)
        .exclude(syllabus_version__subject=subject_a1)
        .select_related("syllabus_version")
        .first()
    )
    assert other_subject_node is not None
    mismatched = variant_services.independent_checks(payload=payload, source_version=source, node=other_subject_node)
    assert "node_subject_mismatch" in {problem["code"] for problem in mismatched["problems"]}


def test_the_official_past_rule_is_asserted_not_assumed(monkeypatch, project_a, subject_a1):
    """The pipeline probes PaperItem.clean() instead of trusting it silently."""
    assert variant_services.official_past_rule_problems(subject=subject_a1) == []
    monkeypatch.setattr(PaperItem, "clean", lambda self: None)
    problems = variant_services.official_past_rule_problems(subject=subject_a1)
    assert [problem["code"] for problem in problems] == ["official_past_rule_missing"]
    assert problems[0]["severity"] == "blocking"


def test_a_variant_targeting_another_subjects_node_cannot_publish(caller, project_a, subject_a1, subject_a2):
    source = _source_version(subject_a1)
    foreign_node = _node(subject_a2)
    payload = _single_choice_payload()
    response = _propose(
        caller, project_a, source_version=source, node=foreign_node, payloads=[payload], key="variant-foreign-node"
    )
    assert response.status_code == 201, response.content
    body = response.json()
    [row] = body["candidates"]
    assert "node_subject_mismatch" in _codes(row)
    assert body["validation"]["accepted"] == 0
    patched = _confirm_answer(caller, project_a, row["candidate_id"])
    assert patched.status_code == 200, patched.content
    publish = caller.post(
        f"/api/v1/projects/{project_a.id}/import-candidates/{row['candidate_id']}/publish",
        {"node_ids": [str(foreign_node.id)]},
        key="variant-foreign-node-publish",
    )
    assert publish.status_code == 422
    assert "node_subject_mismatch" in {
        problem["code"] for problem in publish.json()["error"]["details"]["problems"]
    }


# --------------------------------------------------------------------------
# 5. Publication stays the human gate; AI origin never enters real statistics
# --------------------------------------------------------------------------
def _publish(caller, project, candidate_id: str, *, node_id, key: str, origin_type: str = "user_authored"):
    return caller.post(
        f"/api/v1/projects/{project.id}/import-candidates/{candidate_id}/publish",
        {"node_ids": [str(node_id)], "origin_type": origin_type},
        key=key,
    )


def _official_past_paper(*, subject, cycle_key: str, node, actor, max_score: str = "10"):
    """One countable real occurrence record (coverage confirmed by a human)."""
    paper, _created = exam_services.get_or_create_paper(
        subject=subject,
        cycle_key=cycle_key,
        paper_code="卷一",
        source_kind="official_past",
        title=f"{cycle_key} 年 C02 验收测试材料（自动生成，非真题）",
        actor=actor,
    )
    revision = exam_services.create_paper_revision(
        paper,
        actor=actor,
        expected_session_count=1,
        covered_session_count=1,
        note="C02 验收测试材料：只用于验证生成题不会进入真题统计",
    )
    question = qb_services.create_question(
        subject=subject, origin_type="user_authored", actor=actor, display_label=f"{cycle_key}-真题位1"
    )
    version = qb_services.create_question_version_draft(
        question,
        question_type="single_choice",
        content={
            "blocks": [{"kind": "text", "text": f"{cycle_key} 年真实卷测试题（非真题，仅用于统计验证）"}],
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
        check_basis="C02 验收夹具（人工核对）",
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


def test_a_variant_answer_must_be_confirmed_by_a_human_before_it_can_publish(
    caller, owner, project_a, subject_a1
):
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    response = _propose(
        caller,
        project_a,
        source_version=source,
        node=node,
        payloads=[_single_choice_payload()],
        key="variant-publish-gate",
    )
    assert response.status_code == 201, response.content
    body = response.json()
    [row] = body["candidates"]
    candidate_id = row["candidate_id"]

    # 1. An unconfirmed AI answer is not publishable, and the refusal names it.
    blocked = _publish(caller, project_a, candidate_id, node_id=node.id, key="variant-publish-blocked")
    assert blocked.status_code == 422, blocked.content
    assert "answer_unknown" in {
        problem["code"] for problem in blocked.json()["error"]["details"]["problems"]
    }
    assert Question.objects.filter(subject=subject_a1, origin_type="ai_generated").count() == 0

    # 2. The ordinary human confirmation makes it publishable — through the
    #    existing publish endpoint, which is still the only publish path.
    patched = _confirm_answer(caller, project_a, candidate_id)
    assert patched.status_code == 200, patched.content
    assert "answer_unknown" not in _codes(patched.json())
    assert patched.json()["status"] == ImportCandidateStatus.READY
    published_response = _publish(
        caller,
        project_a,
        candidate_id,
        node_id=node.id,
        key="variant-publish-ok",
        # Even when the caller asks for another origin, a variant stays AI content.
        origin_type="user_authored",
    )
    assert published_response.status_code == 200, published_response.content
    published_body = published_response.json()
    assert published_body["status"] == ImportCandidateStatus.PUBLISHED

    question = Question.objects.get(id=published_body["publication_question_id"])
    assert question.origin_type == "ai_generated"
    assert question.is_demo is True, "AI 生成题必须标记为非真题，不能进入真实历年统计"
    version = QuestionVersion.objects.get(id=published_body["publication_version_id"])
    assert version.status == "published"
    assert version.content_digest == row["content_digest"]
    answer = AnswerKeyVersion.objects.get(question_version=version)
    assert answer.source_type == "ai_derived"
    assert answer.verification_status == "checked"
    assert answer.check_basis
    meanings = list(version.knowledge_mappings.values_list("node_id", flat=True))
    assert [str(value) for value in meanings] == [str(node.id)]

    # 3. It can never be attached to a real paper occurrence: the existing
    #    PaperItem rule refuses it, so it cannot enter cycle statistics.
    _paper, revision = _official_past_paper(subject=subject_a1, cycle_key="2019", node=node, actor=owner)
    with pytest.raises(ValidationError) as excinfo:
        exam_services.add_paper_item(
            revision,
            actor=owner,
            position_key="2",
            question_version=version,
            max_score=Decimal("2.00"),
        )
    assert "AI 生成题不得挂到真实考试发生记录" in str(excinfo.value)
    assert not PaperItem.objects.filter(question_version=version).exists()

    # 4. The countable cycle only contains the real paper's own score.
    report = cycle_service.cycle_analysis(subject=subject_a1, max_cycles=5)
    assert report["used_cycles"] == ["2019"]
    assert report["cycles"][0]["denominator_total_score"] == "10.000"
    assert report["cycles"][0]["share_total"] == "1.0000"


def test_a_provider_failure_mid_batch_keeps_what_was_already_validated(caller, project_a, subject_a1):
    """失败留候选 also holds when the provider dies halfway through a batch."""
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    provider = VariantProvider(
        [_single_choice_payload(stem="变式一：第一个候选可用")],
        fail_on_call=2,
        error=providers.AiTimeout("scripted provider timeout"),
    )
    providers.set_provider_override(provider)
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/variants/propose",
        {"source_version_id": str(source.id), "node_id": str(node.id), "count": 2},
        key="variant-mid-batch-failure",
    )
    assert response.status_code == 503, response.content
    assert response.json()["error"]["code"] == "dependency_unavailable"
    job = ImportJob.objects.get(project=project_a, input_kind="ai_variant")
    assert job.status == ImportJobStatus.FAILED
    assert job.last_error.startswith("变式生成失败")
    # The candidate that had already passed validation survives the failure.
    assert job.candidates.count() == 1
    assert job.candidates.first().status == ImportCandidateStatus.DRAFT
    runs = list(LLMRun.objects.filter(capability="propose_variant").order_by("created_at"))
    assert [run.status for run in runs] == ["succeeded", "timeout"]
    assert runs[1].error_code == "ai_timeout"
    assert runs[0].validation_result["accepted"] is True


# --------------------------------------------------------------------------
# 6. Owner scoping and the batch cap
# --------------------------------------------------------------------------
def test_variant_endpoints_are_owner_scoped_and_cap_the_batch(caller, other_caller, project_a, subject_a1):
    source = _source_version(subject_a1)
    node = _node(subject_a1)
    body = {"source_version_id": str(source.id), "node_id": str(node.id), "count": 1}

    foreign = other_caller.post(f"/api/v1/projects/{project_a.id}/variants/propose", body, key="variant-foreign")
    assert foreign.status_code == 404
    assert foreign.json()["error"]["code"] == "not_found"
    assert other_caller.get(f"/api/v1/projects/{project_a.id}/variants").status_code == 404

    payloads = [_single_choice_payload(stem=f"变式 {index}：不同的题干条件") for index in range(1, 4)]
    capped = _propose(
        caller, project_a, source_version=source, node=node, payloads=payloads, key="variant-cap", count=10
    )
    assert capped.status_code == 201, capped.content
    capped_body = capped.json()
    assert capped_body["requested_count"] == 10
    assert capped_body["count"] == 3
    assert capped_body["count_capped"] is True
    assert len(capped_body["candidates"]) == 3
    assert capped_body["notes"] and "最多生成 3 道变式" in capped_body["notes"][0]
    job = ImportJob.objects.get(id=capped_body["job_id"])
    assert any(problem["code"] == "variant_count_capped" for problem in job.problems)
    assert ImportCandidate.objects.filter(job=job).count() == 3


def test_a_sealed_question_cannot_be_used_as_a_variant_source(caller, project_a, subject_a1):
    """C03 × C02: sealed content must never enter a generation prompt.

    The gate sits in the service (not the API) and runs before any provider call,
    so no caller and no paid request can bypass it.
    """
    version = _source_version(subject_a1)
    sealing.seal_question(
        project=project_a, question=version.question, actor=project_a.owner, reason="保留待验证"
    )
    provider = _set_provider([_single_choice_payload()])

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/variants/propose",
        {"source_version_id": str(version.id), "node_id": str(_node(subject_a1).id), "count": 1},
        key="variant-sealed-source",
    )
    assert response.status_code == 403, response.content
    body = response.json()
    assert body["error"]["code"] == "purpose_not_allowed"
    assert "封存" in body["error"]["message"]
    assert provider.requests == [], "封存题目不得触发任何模型调用"
    assert LLMRun.objects.filter(capability="propose_variant").count() == 0
    assert ImportJob.objects.filter(input_kind="ai_variant").count() == 0
