"""AI capability layer: failure modes, stub honesty and permission gates."""

from __future__ import annotations

import pytest
from django.test import override_settings

from ai.providers import base as providers
from apps.audit.models import LLMRun
from apps.ingestion.services import access as asset_access
from apps.practice.models import SessionItem
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db


def tutor_session_for(caller, project, item_id: str, purpose: str = "explanation", key: str | None = None):
    response = caller.post(
        f"/api/v1/projects/{project.id}/tutor-sessions",
        {"session_item_id": item_id, "purpose": purpose},
        key=key or f"tutor-{item_id}",
    )
    assert response.status_code == 201, response.content
    return response.json()["tutor_session_id"]


def ask(caller, project, tutor_session_id: str, question: str = "请讲解"):
    return caller.post(
        f"/api/v1/projects/{project.id}/tutor-sessions/{tutor_session_id}/messages",
        {"user_question": question},
        key=f"message-{tutor_session_id}",
    )


def test_ai_status_reports_unconfigured_without_pretending(caller, project_a):
    with override_settings(AI_PROVIDER="none"):
        response = caller.get(f"/api/v1/projects/{project_a.id}/ai-status")
    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is False
    assert body["is_stub"] is False
    assert "未配置" in body["message"]


def test_stub_provider_is_labelled_and_never_reported_as_real(caller, project_a, practice_item):
    providers.set_provider_override(providers.StubProvider())
    tutor_session_id = tutor_session_for(caller, project_a, str(practice_item.id))
    response = ask(caller, project_a, tutor_session_id)
    assert response.status_code == 201, response.content
    job = response.json()
    assert job["status"] == "succeeded"
    assert job["is_stub"] is True
    assert job["provider"] == "stub"
    assert job["result_blocks"]
    # The audit row says stub as well.
    run = LLMRun.objects.get(id=job["tutor_job_id"] and LLMRun.objects.latest("created_at").id)
    assert run.is_stub is True
    assert run.capability == "explain"
    assert run.prompt_version == job["prompt_version"]


def test_stub_provider_refuses_to_run_outside_test_or_demo_mode():
    with override_settings(AI_PROVIDER="stub", AI_ALLOW_STUB=False):
        provider = providers.get_provider()
        status = providers.provider_status()
    assert isinstance(provider, providers.NullProvider)
    assert status["configured"] is False
    with override_settings(AI_PROVIDER="stub", AI_ALLOW_STUB=True):
        provider = providers.get_provider()
        status = providers.provider_status()
    assert isinstance(provider, providers.StubProvider)
    assert status["is_stub"] is True
    assert "stub" in status["message"]


@pytest.mark.parametrize("behaviour", ["timeout", "invalid_json", "unavailable"])
def test_provider_failures_degrade_clearly(caller, project_a, practice_item, behaviour):
    providers.set_provider_override(providers.StubProvider(behaviour=behaviour))
    tutor_session_id = tutor_session_for(caller, project_a, str(practice_item.id))
    response = ask(caller, project_a, tutor_session_id)
    assert response.status_code == 201
    job = response.json()
    assert job["status"] in {"failed", "unavailable"}
    assert job["result_blocks"] == []
    assert job["error_message"]
    run = LLMRun.objects.latest("created_at")
    assert run.status in {"failed", "timeout", "rejected", "unavailable"}


def test_citations_outside_the_retrieval_set_are_rejected(caller, project_a, practice_item):
    providers.set_provider_override(providers.StubProvider(behaviour="fabricated_reference"))
    tutor_session_id = tutor_session_for(caller, project_a, str(practice_item.id))
    response = ask(caller, project_a, tutor_session_id)
    job = response.json()
    assert job["status"] == "failed"
    assert job["result_blocks"] == []
    run = LLMRun.objects.latest("created_at")
    assert run.validation_result["accepted"] is False
    assert any("来源" in problem["message"] for problem in run.validation_result["problems"])


def test_tutoring_requires_a_session_item_and_records_the_exposure(caller, project_a, practice_item):
    providers.set_provider_override(providers.StubProvider())
    tutor_session_id = tutor_session_for(caller, project_a, str(practice_item.id), purpose="explanation")
    ask(caller, project_a, tutor_session_id, question="请给出完整讲解")

    from apps.practice.models import ExposureEvent

    exposures = ExposureEvent.objects.filter(session_item=practice_item, kind="answer_delivered")
    assert exposures.exists()
    assert exposures.first().reveals_answer is True

    hint_session = tutor_session_for(caller, project_a, str(practice_item.id), purpose="hint", key="tutor-hint")
    ask(caller, project_a, hint_session, question="只给提示")
    hint_exposure = ExposureEvent.objects.filter(session_item=practice_item, kind="explanation_delivered")
    assert hint_exposure.exists()
    assert hint_exposure.first().reveals_answer is False


def test_unknown_session_item_is_not_reachable(caller, project_a):
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": "00000000-0000-0000-0000-000000000000", "purpose": "explanation"},
        key="tutor-unknown",
    )
    assert response.status_code == 404


def test_other_user_cannot_open_a_tutor_session(other_caller, project_a, practice_item):
    response = other_caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": str(practice_item.id), "purpose": "explanation"},
        key="tutor-foreign",
    )
    assert response.status_code == 404


def test_provider_status_lists_capabilities_honestly():
    with override_settings(
        AI_PROVIDER="openai_compatible",
        AI_API_KEY="",
        AI_BASE_URL="",
    ):
        provider = providers.get_provider()
        assert isinstance(provider, providers.NullProvider)
    with override_settings(
        AI_PROVIDER="openai_compatible",
        AI_API_KEY="test-key",
        AI_BASE_URL="https://example.invalid/v1",
        AI_TEXT_MODEL="text-model",
        AI_VISION_MODEL=None,
    ):
        provider = providers.get_provider()
        assert provider.supports("explain") is True
        # A text-only provider must never be used as a vision model.
        assert provider.supports("extract_question") is False
        with pytest.raises(providers.AiUnavailable):
            provider.call(
                providers.AiRequest(capability="extract_question", prompt_version="v1", prompt="read this")
            )


def test_no_api_key_means_manual_path_keeps_working(caller, project_a, subject_a1, practice_item):
    """With AI unconfigured, answer/judge/review still work end to end."""
    providers.set_provider_override(providers.NullProvider())
    tutor_session_id = tutor_session_for(caller, project_a, str(practice_item.id))
    response = ask(caller, project_a, tutor_session_id)
    assert response.status_code == 201
    job = response.json()
    assert job["status"] == "unavailable"
    assert job["error_code"] == "ai_not_configured"

    # The graded submission path is unaffected.
    version = practice_item.question_version
    from apps.question_bank.models import AnswerKeyVersion

    correct = AnswerKeyVersion.objects.get(question_version=version).answer_payload["correct_option_id"]
    submit(
        caller,
        project_a,
        str(practice_item.id),
        {"type": "single_choice", "selected_option_ids": [correct]},
        key="ai-off-submit",
    )
    detail = caller.get(f"/api/v1/projects/{project_a.id}/attempts/{practice_item.attempt.id}")
    assert detail.json()["grade"]["status"] == "confirmed"


def test_answer_bearing_file_is_refused_for_editorial_preview_during_verification(
    caller, project_a, subject_a1
):
    from apps.ingestion.models import Asset

    asset = Asset.objects.create(
        owner=project_a.owner,
        project=project_a,
        role="answer_page",
        sensitivity="contains_answers",
        object_key="owner/answer-page-2",
        content_type="image/png",
        size_bytes=10,
        checksum="y" * 64,
        uploaded_by=project_a.owner,
    )
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, mode="verification", key="v-asset")
    response = caller.get(
        f"/api/v1/projects/{project_a.id}/assets/{asset.id}?purpose=editorial&session_item_id={session['items'][0]['session_item_id']}"
    )
    assert response.status_code == 403
    assert "验证" in response.json()["error"]["message"]


def test_asset_access_rejects_foreign_and_missing_objects(other_caller, project_a):
    from apps.ingestion.models import Asset

    asset = Asset.objects.create(
        owner=project_a.owner,
        project=project_a,
        role="stem_crop",
        sensitivity="public_to_owner",
        object_key="owner/stem",
        content_type="image/png",
        size_bytes=10,
        checksum="z" * 64,
        uploaded_by=project_a.owner,
    )
    assert other_caller.get(f"/api/v1/projects/{project_a.id}/assets/{asset.id}").status_code == 404
    assert asset_access.presentation_asset_ids  # imported for the contract check
