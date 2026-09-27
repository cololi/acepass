"""P1 batch 3 (B07): handwriting transcription, AI estimation and AI diagnosis.

The acceptance rule (docs/05 §3, B07) is "AI 大题评分逐点评估；人工确认前只有
estimated_score；有字迹不清时先确认转写". These tests try to falsify each part of
it: nothing may fake a transcription, a score or a mastery state.
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal

import pytest
from django.utils import timezone

from ai.providers import base as providers
from apps.audit.models import ContentRevision, LLMRun
from apps.ingestion.models import Asset
from apps.ingestion.storage import get_storage
from apps.learning.models import LearnerKnowledgeState
from apps.practice.models import (
    AnswerTranscription,
    Attempt,
    DiagnosisFollowUp,
    ErrorDiagnosis,
    GradeEvent,
    LearningEvidence,
    SessionItem,
)
from apps.practice.services import transcription as transcription_services
from tests.integration.test_practice_flow import present, published, start_session

pytestmark = pytest.mark.django_db

#: The demo rubric of "A1-大题-1": c1=2.00, c2=3.00, c3=5.00 (total 10.00).
TRANSCRIPTION = {
    "text": "先列出已知条件，再代入公式求解，最后写出结论与单位。",
    "confidence": 0.82,
    "doubts": [],
    "illegible": False,
}


class ScriptedProvider(providers.BaseProvider):
    """Deterministic provider for tests. Declared as a stub on purpose.

    It returns exactly the payload the test scripts — including payloads that a
    real model should never get away with (over-cap scores, unknown criteria,
    causes without evidence), so the validation layer is what is under test.
    """

    name = "scripted-test"
    is_stub = True
    capabilities = ("transcribe_handwriting", "estimate_grade", "diagnose")

    def __init__(self, *, transcription=None, estimate=None, diagnosis=None):
        self.transcription = transcription if transcription is not None else TRANSCRIPTION
        self.estimate = estimate
        self.diagnosis = diagnosis

    def call(self, request: providers.AiRequest) -> providers.AiCallResult:
        payload = {
            "transcribe_handwriting": self.transcription,
            "estimate_grade": self.estimate,
            "diagnose": self.diagnosis,
        }.get(request.capability)
        if payload is None:
            raise providers.AiUnavailable(f"scripted provider 没有为 {request.capability} 准备输出")
        return providers.AiCallResult(
            payload=payload,
            raw_text=json.dumps(payload, ensure_ascii=False),
            prompt_tokens=10,
            completion_tokens=10,
            cost_cents=0,
            cost_known=True,
            attempts=1,
            latency_ms=1,
            is_stub=True,
            provider=self.name,
            model="scripted-1",
            prompt_version=request.prompt_version,
        )


def answer_asset(project, key: str) -> Asset:
    """One stored answer photo belonging to the project owner."""
    owner = project.owner
    object_key = f"{owner.id}/{project.id}/uploads/{key}.png"
    content = b"\x89PNG\r\n\x1a\n" + key.encode("ascii")
    get_storage().save(object_key, content)
    return Asset.objects.create(
        owner=owner,
        project=project,
        role="answer_page",
        sensitivity="public_to_owner",
        object_key=object_key,
        original_filename=f"{key}.png",
        content_type="image/png",
        size_bytes=len(content),
        checksum="a" * 64,
        uploaded_by=owner,
    )


def constructed_attempt(caller, project, subject, *, key: str, attach: bool = False):
    """Submit one constructed-response attempt, optionally with a photo answer."""
    version = published(subject, "constructed_response")
    session = start_session(caller, project, subject, version.question, key=f"{key}-session")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    present(caller, project, str(item.id))
    asset = answer_asset(project, key) if attach else None
    body: dict = {
        "answer": {"type": "constructed_response", "text": "推导过程：先列条件，再代入公式。"},
        "confidence": "unsure",
    }
    if asset is not None:
        body["asset_ids"] = [str(asset.id)]
    response = caller.post(f"/api/v1/projects/{project.id}/session-items/{item.id}/submit", body, key=f"{key}-submit")
    assert response.status_code == 200, response.content
    attempt = Attempt.objects.select_related("current_grade_event").get(session_item=item)
    return attempt, item, asset


def confirm_transcription(caller, project, attempt, asset, *, key: str, text: str | None = None):
    """Request a proposal and confirm it; returns the stored row."""
    created = caller.post(
        f"/api/v1/projects/{project.id}/attempts/{attempt.id}/transcriptions",
        {"asset_id": str(asset.id)},
        key=f"{key}-transcribe",
    )
    assert created.status_code == 201, created.content
    transcription_id = created.json()["transcription_id"]
    body: dict = {}
    if text is not None:
        body["text"] = text
    confirmed = caller.post(
        f"/api/v1/projects/{project.id}/transcriptions/{transcription_id}/confirm",
        body,
        key=f"{key}-confirm",
    )
    assert confirmed.status_code == 200, confirmed.content
    return AnswerTranscription.objects.get(id=transcription_id)


def confirm_full_grade(caller, project, attempt, item, *, key: str):
    """Confirm every rubric criterion by hand, so a real confirmed grade exists."""
    parts = [{"part_id": c["criterion_id"], "score": c["max_score"]} for c in item.rubric_version.criteria]
    response = caller.post(
        f"/api/v1/projects/{project.id}/attempts/{attempt.id}/confirm-grade",
        {"expected_grading_revision": attempt.grading_revision, "parts": parts},
        key=f"{key}-grade",
    )
    assert response.status_code == 200, response.content
    return GradeEvent.objects.get(id=response.json()["grade_event_id"])


def seed_knowledge_state(project, subject):
    """One existing mastery row, so "unchanged" is a real assertion."""
    from apps.exams.models import SyllabusVersion
    from apps.knowledge.models import KnowledgeNode

    node = KnowledgeNode.objects.filter(syllabus_version__subject=subject).first()
    syllabus = SyllabusVersion.objects.get(id=node.syllabus_version_id)
    state, _created = LearnerKnowledgeState.objects.get_or_create(
        user=project.owner,
        project=project,
        syllabus_version=syllabus,
        node=node,
        defaults={"summary": "needs_foundation", "best_summary": "needs_foundation", "as_of": timezone.now()},
    )
    return state


def inertness_snapshot(attempt, user):
    """Everything an estimate/diagnosis is forbidden to change.

    The inert rows themselves are excluded (a new ``ai_estimate`` event is the
    point of the operation); every *other* grade fact, all evidence and all
    mastery states must come out identical.
    """
    events = GradeEvent.objects.filter(attempt=attempt).exclude(kind="ai_estimate")
    return {
        "grade_events": sorted(str(value) for value in events.values_list("id", flat=True)),
        "confirmed_scores": sorted(
            (str(row.id), str(row.confirmed_score), row.status, row.method, row.is_superseded)
            for row in events
        ),
        "manual_confirmations": sorted(
            str(value)
            for value in events.filter(kind="manual_confirmation").values_list("id", flat=True)
        ),
        "current_grade_event": str(attempt.current_grade_event_id),
        "current_confirmed_score": (
            str(attempt.current_grade_event.confirmed_score) if attempt.current_grade_event else None
        ),
        "evidence": sorted(
            str(value) for value in LearningEvidence.objects.filter(attempt=attempt).values_list("id", flat=True)
        ),
        "evidence_total": LearningEvidence.objects.filter(user=user).count(),
        "states": sorted((str(row.id), row.summary) for row in LearnerKnowledgeState.objects.filter(user=user)),
    }


# --------------------------------------------------------------------------
# 1. No provider: an honest 503 and no rows at all
# --------------------------------------------------------------------------
def test_no_provider_refuses_transcription_and_estimation_without_writing(caller, project_a, subject_a1):
    providers.set_provider_override(providers.NullProvider())
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="noprov", attach=True)

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/transcriptions",
        {"asset_id": str(asset.id)},
        key="noprov-transcribe",
    )
    assert response.status_code == 503, response.content
    assert response.json()["error"]["code"] == "ai_not_configured"
    assert AnswerTranscription.objects.filter(attempt=attempt).count() == 0
    # The attempt is recorded honestly rather than silently: llm_run says unavailable.
    run = LLMRun.objects.filter(capability="transcribe_handwriting").latest("created_at")
    assert run.status == "unavailable"
    assert run.error_code == "ai_not_configured"

    # Estimation on a constructed-response attempt without photos reaches the
    # provider check and fails the same way — again writing nothing.
    plain, _item2, _asset2 = constructed_attempt(caller, project_a, subject_a1, key="noprov-est", attach=False)
    before_events = GradeEvent.objects.filter(attempt=plain).count()
    estimate = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{plain.id}/ai-estimate", {}, key="noprov-estimate"
    )
    assert estimate.status_code == 503, estimate.content
    assert estimate.json()["error"]["code"] == "ai_not_configured"
    assert GradeEvent.objects.filter(attempt=plain, kind="ai_estimate").count() == 0
    assert GradeEvent.objects.filter(attempt=plain).count() == before_events
    plain.refresh_from_db()
    assert plain.current_grade_event.kind == "initial"
    assert plain.current_grade_event.status == "pending_review"
    # The gate itself still answers first, even without a provider: photos are a
    # transcription problem before they are a model problem.
    assert AnswerTranscription.objects.filter(attempt=plain).count() == 0


# --------------------------------------------------------------------------
# 2. Stub: a proposal that says it is a stub, and a learner decision it cannot skip
# --------------------------------------------------------------------------
def test_stub_transcription_is_labelled_and_never_overwritten(caller, project_a, subject_a1):
    providers.set_provider_override(providers.StubProvider())
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="stub", attach=True)

    # Before any confirmation the gate is closed: estimation is a 409, not a guess.
    blocked = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="stub-estimate-blocked"
    )
    assert blocked.status_code == 409, blocked.content
    assert blocked.json()["error"]["code"] == "transcription_required"
    assert blocked.json()["error"]["details"]["asset_ids"] == [str(asset.id)]

    created = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/transcriptions",
        {"asset_id": str(asset.id)},
        key="stub-transcribe",
    )
    assert created.status_code == 201, created.content
    body = created.json()
    assert body["status"] == "proposed"
    assert body["is_stub"] is True
    assert body["confirmed_text"] == ""
    assert "stub" in body["raw_text"]
    row = AnswerTranscription.objects.get(attempt=attempt)
    assert row.status == "proposed"
    assert row.is_stub is True
    assert LLMRun.objects.get(id=row.run_id).is_stub is True

    listed = caller.get(f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/transcriptions")
    assert listed.status_code == 200
    assert listed.json()["pending_asset_ids"] == [str(asset.id)]
    assert listed.json()["transcriptions"][0]["raw_text"] == row.raw_text

    confirmed = caller.post(
        f"/api/v1/projects/{project_a.id}/transcriptions/{row.id}/confirm",
        {"text": "先列已知条件，再代入公式求解。"},
        key="stub-confirm",
    )
    assert confirmed.status_code == 200, confirmed.content
    assert confirmed.json()["status"] == "edited"
    assert confirmed.json()["confirmed_text"] == "先列已知条件，再代入公式求解。"
    row.refresh_from_db()
    assert row.status == "edited"
    assert row.decided_by_id == project_a.owner_id
    assert row.confirmed_text == "先列已知条件，再代入公式求解。"
    assert (
        ContentRevision.objects.filter(
            entity_type="answer_transcription",
            entity_id=str(row.id),
            action="transcription_confirmed",
        ).count()
        == 1
    )
    # The gate opens only for a *confirmed* transcription.
    assert caller.get(f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/transcriptions").json()[
        "pending_asset_ids"
    ] == []

    again = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/transcriptions",
        {"asset_id": str(asset.id)},
        key="stub-transcribe-again",
    )
    assert again.status_code == 400, again.content
    assert again.json()["error"]["code"] == "invalid_input"
    row.refresh_from_db()
    assert row.status == "edited"
    assert row.confirmed_text == "先列已知条件，再代入公式求解。"
    assert "stub" in row.raw_text, "the refused rerun must not have replaced the accepted text"


def test_stub_provider_cannot_turn_an_empty_estimate_into_a_score(caller, project_a, subject_a1):
    """The stub deliberately returns no criteria; no event may be written for it."""
    providers.set_provider_override(providers.StubProvider())
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="stubest", attach=True)
    confirm_transcription(caller, project_a, attempt, asset, key="stubest")

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="stubest-estimate"
    )
    assert response.status_code == 503, response.content
    assert response.json()["error"]["code"] == "dependency_unavailable"
    assert GradeEvent.objects.filter(attempt=attempt, kind="ai_estimate").count() == 0
    run = LLMRun.objects.filter(capability="estimate_grade").latest("created_at")
    assert run.status == "rejected"
    assert "empty_estimate" in [problem["code"] for problem in run.validation_result["problems"]]


# --------------------------------------------------------------------------
# 3. Estimation is per-criterion and inert
# --------------------------------------------------------------------------
TWO_CRITERIA_ESTIMATE = {
    "criteria": [
        {"criterion_id": "c1", "estimated_score": "2.00", "rationale": "条件列全", "missing_evidence": []},
        {
            "criterion_id": "c2",
            "estimated_score": "2.00",
            "rationale": "推导方向正确，但缺少一步",
            "missing_evidence": ["中间步骤"],
        },
    ],
    "overall_note": "参考估计：结论部分没有过程证据，未给分。",
    "confidence": 0.5,
}


def test_estimate_is_per_criterion_inert_and_leaves_the_confirmed_grade_alone(caller, project_a, subject_a1):
    providers.set_provider_override(ScriptedProvider(estimate=TWO_CRITERIA_ESTIMATE))
    attempt, item, asset = constructed_attempt(caller, project_a, subject_a1, key="estimate", attach=True)
    confirm_transcription(caller, project_a, attempt, asset, key="estimate")
    manual = confirm_full_grade(caller, project_a, attempt, item, key="estimate")

    attempt.refresh_from_db()
    seed_knowledge_state(project_a, subject_a1)
    before = inertness_snapshot(attempt, project_a.owner)
    assert before["states"], "the knowledge-state assertion must not be vacuous"
    assert manual.confirmed_score == Decimal("10.00")

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="estimate-run"
    )
    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload["is_inert"] is True
    assert payload["confirmed_total_unchanged"] is True
    assert payload["rubric_revision"] == str(item.rubric_version_id)
    assert payload["estimated_score"] == "4.00"
    assert payload["confirmed_score"] is None
    assert payload["status"] == "estimated"

    event = GradeEvent.objects.get(id=payload["grade_event_id"])
    assert event.kind == "ai_estimate"
    assert event.status == "estimated"
    assert event.method == "ai_estimated"
    assert event.estimated_score == Decimal("4.00")
    assert event.confirmed_score is None
    assert event.is_fully_confirmed is False
    assert event.grader is None
    assert event.rule_snapshot["inert"] is True
    assert event.rule_snapshot["prompt_version"] == "p1-estimate-grade-v1"
    assert event.rule_snapshot["criteria_total"] == "10.00"
    assert event.llm_run is not None and event.llm_run.capability == "estimate_grade"
    # Per-criterion rows, with the omitted criterion explicitly still pending.
    by_part = {part["part_id"]: part for part in event.parts}
    assert by_part["c1"]["score"] == "2.00"
    assert by_part["c1"]["rationale"] == "条件列全"
    assert by_part["c2"]["missing_evidence"] == ["中间步骤"]
    assert by_part["c3"]["score"] is None
    assert by_part["c3"]["status"] == "pending_review"

    after = inertness_snapshot(attempt, project_a.owner)
    assert after == before, "an estimate must not touch grades, evidence or mastery states"
    manual.refresh_from_db()
    assert manual.is_superseded is False
    assert GradeEvent.objects.filter(attempt=attempt, kind="manual_confirmation").count() == 1
    attempt.refresh_from_db()
    assert str(attempt.current_grade_event_id) == str(manual.id)
    assert attempt.current_grade_event.confirmed_score == Decimal("10.00")

    # GET returns the same latest estimate, labelled as inert.
    latest = caller.get(f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate")
    assert latest.status_code == 200
    assert latest.json()["has_estimate"] is True
    assert latest.json()["estimate"]["grade_event_id"] == str(event.id)
    assert latest.json()["estimate"]["criteria"][2]["criterion_id"] == "c3"

    # A second estimate supersedes the previous *estimate* only.
    second = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="estimate-run-2"
    )
    assert second.status_code == 200, second.content
    event.refresh_from_db()
    assert event.is_superseded is True
    second_event = GradeEvent.objects.get(id=second.json()["grade_event_id"])
    assert str(second_event.supersedes_id) == str(event.id)
    manual.refresh_from_db()
    assert manual.is_superseded is False
    attempt.refresh_from_db()
    assert str(attempt.current_grade_event_id) == str(manual.id)
    assert attempt.current_grade_event.confirmed_score == Decimal("10.00")
    assert (
        GradeEvent.objects.filter(attempt=attempt, kind="ai_estimate", is_superseded=False).count() == 1
    )
    assert inertness_snapshot(attempt, project_a.owner)["states"] == before["states"]

    # The inert estimate still reserved its revision, so a later human
    # confirmation writes its own new revision instead of colliding with it.
    attempt.refresh_from_db()
    parts = [{"part_id": c["criterion_id"], "score": c["max_score"]} for c in item.rubric_version.criteria]
    reconfirm = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/confirm-grade",
        {"expected_grading_revision": attempt.grading_revision, "parts": parts},
        key="estimate-regrade",
    )
    assert reconfirm.status_code == 200, reconfirm.content
    attempt.refresh_from_db()
    assert attempt.current_grade_event.kind == "manual_confirmation"
    assert attempt.current_grade_event.confirmed_score == Decimal("10.00")


def test_estimate_without_a_rubric_is_refused(caller, project_a, subject_a1):
    """The rubric is what makes point-by-point estimation possible — no rubric, no guess."""
    providers.set_provider_override(ScriptedProvider(estimate=TWO_CRITERIA_ESTIMATE))
    version = published(subject_a1, "fill_blank")
    session = start_session(caller, project_a, subject_a1, version.question, key="norubric-session")
    item = SessionItem.objects.get(id=session["items"][0]["session_item_id"])
    assert item.rubric_version_id is None
    present(caller, project_a, str(item.id))
    submitted = caller.post(
        f"/api/v1/projects/{project_a.id}/session-items/{item.id}/submit",
        {"answer": {"type": "fill_blank", "blanks": {}}, "confidence": "unsure"},
        key="norubric-submit",
    )
    assert submitted.status_code == 200, submitted.content
    attempt = Attempt.objects.get(session_item=item)
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="norubric-estimate"
    )
    assert response.status_code == 400, response.content
    assert response.json()["error"]["code"] == "invalid_input"
    assert GradeEvent.objects.filter(attempt=attempt, kind="ai_estimate").count() == 0
    # An unconfigured *rubric* is not an AI failure: nothing was called.
    assert LLMRun.objects.filter(capability="estimate_grade").count() == 0


# --------------------------------------------------------------------------
# 4. Validation honesty: over-cap scores and invented criteria
# --------------------------------------------------------------------------
def test_over_cap_estimate_is_truncated_and_the_problem_is_recorded(caller, project_a, subject_a1):
    providers.set_provider_override(
        ScriptedProvider(
            estimate={
                "criteria": [
                    {"criterion_id": "c1", "estimated_score": "99.00", "rationale": "模型给了超满分"},
                    {"criterion_id": "c2", "estimated_score": "3.00", "rationale": "推导完整"},
                ],
                "overall_note": "含超限值",
                "confidence": 0.4,
            }
        )
    )
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="overcap", attach=True)
    confirm_transcription(caller, project_a, attempt, asset, key="overcap")
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="overcap-estimate"
    )
    assert response.status_code == 200, response.content
    event = GradeEvent.objects.get(id=response.json()["grade_event_id"])
    by_part = {part["part_id"]: part for part in event.parts}
    assert by_part["c1"]["score"] == "2.00", "the criterion cap truncates the model score"
    assert event.estimated_score == Decimal("5.00")
    run = event.llm_run
    codes = [problem["code"] for problem in run.validation_result["problems"]]
    assert "score_over_cap" in codes
    assert run.status == "succeeded"
    assert response.json()["estimated_score"] == "5.00"


def test_unknown_criterion_from_the_model_is_dropped(caller, project_a, subject_a1):
    providers.set_provider_override(
        ScriptedProvider(
            estimate={
                "criteria": [
                    {"criterion_id": "c1", "estimated_score": "1.00", "rationale": "部分正确"},
                    {"criterion_id": "c99", "estimated_score": "5.00", "rationale": "不存在的评分点"},
                ],
                "overall_note": "含未知评分点",
                "confidence": 0.3,
            }
        )
    )
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="unknowncrit", attach=True)
    confirm_transcription(caller, project_a, attempt, asset, key="unknowncrit")
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="unknowncrit-estimate"
    )
    assert response.status_code == 200, response.content
    event = GradeEvent.objects.get(id=response.json()["grade_event_id"])
    part_ids = [part["part_id"] for part in event.parts]
    assert "c99" not in part_ids
    assert event.estimated_score == Decimal("1.00")
    codes = [problem["code"] for problem in event.llm_run.validation_result["problems"]]
    assert "unknown_criterion" in codes
    assert response.json()["criteria"][1]["criterion_id"] == "c2"


# --------------------------------------------------------------------------
# 5. The transcription gate
# --------------------------------------------------------------------------
def test_photo_answer_blocks_estimation_and_diagnosis_until_the_learner_confirms(
    caller, project_a, subject_a1
):
    providers.set_provider_override(
        ScriptedProvider(
            estimate=TWO_CRITERIA_ESTIMATE,
            diagnosis={"causes": [{"error_type": "concept_gap", "evidence": ["条件写错"]}], "follow_up_questions": []},
        )
    )
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="gate", attach=True)

    for path, body, key in (
        (f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, "gate-estimate"),
        (f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-diagnosis", {}, "gate-diagnosis"),
    ):
        response = caller.post(path, body, key=key)
        assert response.status_code == 409, response.content
        assert response.json()["error"]["code"] == "transcription_required"
        assert response.json()["error"]["details"]["asset_ids"] == [str(asset.id)]
    assert GradeEvent.objects.filter(attempt=attempt, kind="ai_estimate").count() == 0
    assert ErrorDiagnosis.objects.filter(attempt=attempt).count() == 0

    # Rejecting the proposal keeps the gate closed — a rejection is not a confirmation.
    created = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/transcriptions",
        {"asset_id": str(asset.id)},
        key="gate-transcribe",
    )
    assert created.status_code == 201, created.content
    rejected = caller.post(
        f"/api/v1/projects/{project_a.id}/transcriptions/{created.json()['transcription_id']}/reject",
        {"note": "识别错了"},
        key="gate-reject",
    )
    assert rejected.status_code == 200, rejected.content
    assert rejected.json()["status"] == "rejected"
    still_blocked = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="gate-estimate-2"
    )
    assert still_blocked.status_code == 409
    assert still_blocked.json()["error"]["details"]["asset_ids"] == [str(asset.id)]

    # A fresh proposal + confirmation opens the gate and estimation proceeds.
    transcribed = confirm_transcription(caller, project_a, attempt, asset, key="gate-again", text=None)
    assert transcribed.status == "confirmed"
    assert transcribed.confirmed_text
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="gate-estimate-3"
    )
    assert response.status_code == 200, response.content
    assert GradeEvent.objects.filter(attempt=attempt, kind="ai_estimate").count() == 1
    # And the diagnosis runs on the confirmed text, not on the photo: the run's
    # answer digest is the confirmed text the learner accepted.
    diagnosis = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-diagnosis", {}, key="gate-diagnosis-2"
    )
    assert diagnosis.status_code == 200, diagnosis.content
    run = LLMRun.objects.filter(capability="diagnose").latest("created_at")
    assert run.status == "succeeded"
    expected_digest = hashlib.sha256(
        transcription_services.learner_answer_text(Attempt.objects.get(id=attempt.id)).encode("utf-8")
    ).hexdigest()
    assert run.input_snapshot["learner_answer_digest"] == expected_digest
    assert transcribed.confirmed_text in transcription_services.learner_answer_text(attempt)


def test_estimation_refuses_while_the_same_content_is_in_a_running_verification(
    caller, project_a, subject_a1
):
    """A score-shaped delivery stays behind the B02 content gate."""
    providers.set_provider_override(ScriptedProvider(estimate=TWO_CRITERIA_ESTIMATE))
    attempt, item, _asset = constructed_attempt(caller, project_a, subject_a1, key="vcontent", attach=False)
    # A verification run on the *same* question starts afterwards: the estimate is
    # the same disclosure as reading a score, so it must be refused.
    version = item.question_version
    session = start_session(
        caller, project_a, subject_a1, version.question, mode="verification", key="vcontent-verification"
    )
    present(caller, project_a, session["items"][0]["session_item_id"])

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-estimate", {}, key="vcontent-estimate"
    )
    assert response.status_code == 403, response.content
    assert "验证" in response.json()["error"]["message"]
    assert GradeEvent.objects.filter(attempt=attempt, kind="ai_estimate").count() == 0
    # The gate refuses before any model call: no provider cost was incurred.
    assert LLMRun.objects.filter(capability="estimate_grade").count() == 0


# --------------------------------------------------------------------------
# 6. AI diagnosis: evidenced causes, downgraded causes, follow-up questions
# --------------------------------------------------------------------------
DIAGNOSIS_WITH_ONE_UNEVIDENCED_CAUSE = {
    "causes": [
        {"error_type": "concept_gap", "confidence": 0.6, "evidence": ["把分配律写成 a×(b+c)=a×b+c"]},
        {"error_type": "calculation_slip", "confidence": 0.4, "evidence": []},
    ],
    "follow_up_questions": [
        {"question": "第二步为什么直接相乘？", "why": "确认是否理解分配律", "evidence_kind": "过程步骤"},
        {"question": "单位是怎么确定的？", "why": "确认结论部分", "evidence_kind": "单位与符号"},
    ],
    "missing_information": ["草稿纸上的中间步骤"],
}


def test_diagnosis_proposes_only_evidenced_causes_and_asks_follow_ups(caller, project_a, subject_a1):
    providers.set_provider_override(ScriptedProvider(diagnosis=DIAGNOSIS_WITH_ONE_UNEVIDENCED_CAUSE))
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="diag", attach=True)
    confirm_transcription(caller, project_a, attempt, asset, key="diag")
    seed_knowledge_state(project_a, subject_a1)
    attempt.refresh_from_db()
    before = inertness_snapshot(attempt, project_a.owner)

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-diagnosis",
        {"learner_note": "我觉得是粗心"},
        key="diag-run",
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["scores_changed"] is False
    assert body["knowledge_state_changed"] is False
    assert body["origin"] == "model"
    assert body["status"] == "proposed"
    assert body["missing_information"] == ["草稿纸上的中间步骤"]

    stored = list(ErrorDiagnosis.objects.filter(attempt=attempt).order_by("created_at"))
    assert len(stored) == 2
    by_type = {row.error_type: row for row in stored}
    assert by_type["concept_gap"].evidence == ["把分配律写成 a×(b+c)=a×b+c"]
    # No evidence -> downgraded to unknown. It is never "careless".
    assert by_type["unknown"].evidence == []
    assert "careless" not in by_type
    for row in stored:
        assert row.origin == "model"
        assert row.status == "proposed"
        assert row.decided_by_id is None
        assert row.llm_run_id is not None
    assert LLMRun.objects.get(id=stored[0].llm_run_id).validation_result["stored_causes"] == 2

    follow_ups = list(DiagnosisFollowUp.objects.filter(attempt=attempt).order_by("created_at"))
    assert len(follow_ups) == 2
    assert {row.status for row in follow_ups} == {"pending"}
    assert [row.question for row in follow_ups] == ["第二步为什么直接相乘？", "单位是怎么确定的？"]

    answered = caller.post(
        f"/api/v1/projects/{project_a.id}/diagnosis-follow-ups/{follow_ups[0].id}/answer",
        {"text": "我以为 a×(b+c) 就是 a×b+c。"},
        key="diag-answer",
    )
    assert answered.status_code == 200, answered.content
    assert answered.json()["status"] == "answered"
    assert answered.json()["answer_text"] == "我以为 a×(b+c) 就是 a×b+c。"
    follow_ups[0].refresh_from_db()
    assert follow_ups[0].status == "answered"
    assert follow_ups[0].answered_at is not None

    skipped = caller.post(
        f"/api/v1/projects/{project_a.id}/diagnosis-follow-ups/{follow_ups[1].id}/skip", {}, key="diag-skip"
    )
    assert skipped.status_code == 200, skipped.content
    assert skipped.json()["status"] == "skipped"
    # Answering twice is refused rather than silently overwriting the evidence.
    again = caller.post(
        f"/api/v1/projects/{project_a.id}/diagnosis-follow-ups/{follow_ups[0].id}/answer",
        {"text": "改口"},
        key="diag-answer-2",
    )
    assert again.status_code == 400

    attempt.refresh_from_db()
    assert inertness_snapshot(attempt, project_a.owner) == before


def test_diagnosis_records_nothing_when_no_cause_survives_validation(caller, project_a, subject_a1):
    providers.set_provider_override(
        ScriptedProvider(
            diagnosis={
                "causes": [{"error_type": "careless", "confidence": 0.9, "evidence": ["看起来是粗心"]}],
                "follow_up_questions": [{"question": "当时在想什么？"}],
                "missing_information": [],
            }
        )
    )
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="diagempty", attach=True)
    confirm_transcription(caller, project_a, attempt, asset, key="diagempty")
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-diagnosis", {}, key="diagempty-run"
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["causes"] == []
    assert body["follow_up_questions"] == []
    assert body["recorded"] is False
    assert body["note"], "an empty result must say why nothing was recorded"
    assert ErrorDiagnosis.objects.filter(attempt=attempt).count() == 0
    assert DiagnosisFollowUp.objects.filter(attempt=attempt).count() == 0
    run = LLMRun.objects.filter(capability="diagnose").latest("created_at")
    codes = [problem["code"] for problem in run.validation_result["problems"]]
    assert "unknown_error_type" in codes


# --------------------------------------------------------------------------
# 7. Owner isolation
# --------------------------------------------------------------------------
def test_every_new_endpoint_is_404_for_another_users_attempt(
    caller, other_caller, project_a, subject_a1
):
    providers.set_provider_override(
        ScriptedProvider(
            estimate=TWO_CRITERIA_ESTIMATE,
            diagnosis=DIAGNOSIS_WITH_ONE_UNEVIDENCED_CAUSE,
        )
    )
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="isolation", attach=True)
    transcription = confirm_transcription(caller, project_a, attempt, asset, key="isolation")
    caller.post(f"/api/v1/projects/{project_a.id}/attempts/{attempt.id}/ai-diagnosis", {}, key="isolation-diag")
    follow_up = DiagnosisFollowUp.objects.filter(attempt=attempt).first()
    assert follow_up is not None

    base = f"/api/v1/projects/{project_a.id}"
    # /projects/{project_id} itself is already a 404 for a foreign project.
    assert other_caller.get(f"{base}/attempts/{attempt.id}/transcriptions").status_code == 404
    assert other_caller.get(f"{base}/attempts/{attempt.id}/ai-estimate").status_code == 404
    assert (
        other_caller.post(
            f"{base}/attempts/{attempt.id}/transcriptions", {"asset_id": str(asset.id)}, key="iso-t"
        ).status_code
        == 404
    )
    assert (
        other_caller.post(
            f"{base}/transcriptions/{transcription.id}/confirm", {"text": "别人的文本"}, key="iso-c"
        ).status_code
        == 404
    )
    assert (
        other_caller.post(f"{base}/transcriptions/{transcription.id}/reject", {}, key="iso-r").status_code == 404
    )
    assert (
        other_caller.post(f"{base}/attempts/{attempt.id}/ai-estimate", {}, key="iso-e").status_code == 404
    )
    assert (
        other_caller.post(f"{base}/attempts/{attempt.id}/ai-diagnosis", {}, key="iso-d").status_code == 404
    )
    assert (
        other_caller.post(
            f"{base}/diagnosis-follow-ups/{follow_up.id}/answer", {"text": "别人的回答"}, key="iso-a"
        ).status_code
        == 404
    )
    assert (
        other_caller.post(f"{base}/diagnosis-follow-ups/{follow_up.id}/skip", {}, key="iso-s").status_code == 404
    )

    transcription.refresh_from_db()
    assert transcription.confirmed_text == TRANSCRIPTION["text"]
    follow_up.refresh_from_db()
    assert follow_up.status == "pending"
    assert follow_up.answer_text == ""


def test_learner_can_type_the_transcription_when_no_vision_model_exists(caller, project_a, subject_a1):
    """The P0 rule "no vision model means the human path" must hold here too.

    Without a provider a photo answer would otherwise stay permanently
    un-gradeable: the API accepts the learner's own text, records it as a manual
    (never a recognition) row that is already confirmed, and the AI gate opens
    for the paths that do have a provider.
    """
    providers.set_provider_override(
        ScriptedProvider(
            estimate=TWO_CRITERIA_ESTIMATE,
            diagnosis={"causes": [{"error_type": "concept_gap", "evidence": ["条件写错"]}], "follow_up_questions": []},
        )
    )
    base = f"/api/v1/projects/{project_a.id}"
    attempt, _item, asset = constructed_attempt(caller, project_a, subject_a1, key="manual", attach=True)

    blocked = caller.post(f"{base}/attempts/{attempt.id}/ai-estimate", {}, key="manual-estimate-blocked")
    assert blocked.status_code == 409, blocked.content

    typed = "我写的是：先算 5×4=20，再写结论 20 个。"
    recorded = caller.post(
        f"{base}/attempts/{attempt.id}/transcriptions",
        {"asset_id": str(asset.id), "text": typed},
        key="manual-transcribe",
    )
    assert recorded.status_code == 201, recorded.content
    body = recorded.json()
    assert body["origin"] == "manual"
    assert body["status"] == "confirmed"
    assert body["is_confirmed"] is True
    assert body["is_stub"] is False
    assert body["llm_run_id"] is None  # no model was called
    assert body["confirmed_text"] == typed

    row = AnswerTranscription.objects.get(id=body["transcription_id"])
    assert row.run is None and row.confidence is None and row.doubts == []
    assert ContentRevision.objects.filter(
        entity_type="answer_transcription", entity_id=str(row.id), action="transcription_confirmed"
    ).count() == 1
    assert LLMRun.objects.filter(capability="transcribe_handwriting").count() == 0

    # The gate is open now: estimation and diagnosis run on the typed text.
    estimate = caller.post(f"{base}/attempts/{attempt.id}/ai-estimate", {}, key="manual-estimate-ok")
    assert estimate.status_code == 200, estimate.content
    diagnosis = caller.post(f"{base}/attempts/{attempt.id}/ai-diagnosis", {}, key="manual-diagnosis-ok")
    assert diagnosis.status_code == 200, diagnosis.content

    # A blank manual entry is refused, and a model row that was already confirmed
    # cannot be silently rewritten as a manual one.
    # An explicitly blank manual entry is a client mistake, not a silent fallback
    # into a model call: the learner must see why nothing was recorded.
    empty = caller.post(
        f"{base}/attempts/{attempt.id}/transcriptions", {"asset_id": str(asset.id), "text": "   "}, key="manual-empty"
    )
    assert empty.status_code == 400, empty.content
    assert empty.json()["error"]["code"] == "invalid_input"
    assert "不能为空" in empty.json()["error"]["message"]
