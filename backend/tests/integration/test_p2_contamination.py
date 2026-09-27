"""P2 batch 1 / C04: nothing may be re-labelled "strictly unseen" once exposed.

docs/05 §3 C04: 校对过、外部标记见过、已展示未提交的题均不能重新标为严格未见。

The three explicit contamination sources (editorial/proofreading preview, the
learner's own "met it outside the system" declaration, and a stem presented but
never submitted) plus the cross-project content-lineage rule are exercised
against the real fixtures and the real HTTP surface, together with the control
cases that keep a genuinely fresh question qualifying and the no-reset property
(recomputation, re-projection and a regrade cannot launder a contaminated
answer back into strict evidence).
"""

from __future__ import annotations

import pytest

from apps.audit.services import outbox
from apps.common.enums import ContentLineageBasis, ExposureKind
from apps.learning.services import contamination
from apps.learning.services import evidence as evidence_service
from apps.learning.services import state as state_service
from apps.practice.models import Attempt, ExposureEvent, LearningEvidence, SessionItem
from apps.practice.services import attempts as attempt_services
from apps.practice.services import exposure as exposure_service
from apps.question_bank.models import ContentLineage, Question, QuestionVersion
from tests.integration.test_learning_loop import answer_for
from tests.integration.test_practice_flow import present, start_session, submit

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------- helpers
def standalone_single_choice_versions(subject, count: int = 2) -> list[QuestionVersion]:
    """Distinct standalone single-choice questions of one demo subject.

    Material children are excluded: they are single-choice too, but they are
    graded as part of a material group and would make "two questions" ambiguous.
    """
    versions = list(
        QuestionVersion.objects.filter(
            question__subject=subject,
            question_type="single_choice",
            status="published",
            parent_material_version__isnull=True,
        )
        .select_related("question")
        .order_by("question__display_label")[:count]
    )
    assert len(versions) == count, f"演示科目应至少有 {count} 道独立单选题"
    return versions


def multi_item_session(caller, project, subject, questions, *, key: str) -> dict:
    response = caller.post(
        f"/api/v1/projects/{project.id}/practice-sessions",
        {
            "mode": "practice",
            "subject_id": str(subject.id),
            "question_ids": [str(question.id) for question in questions],
        },
        key=key,
    )
    assert response.status_code == 201, response.content
    return response.json()


def item_of(session: dict, index: int = 0) -> SessionItem:
    return SessionItem.objects.get(id=session["items"][index]["session_item_id"])


def answer_presented_item(caller, project, item: SessionItem, version: QuestionVersion, *, key: str) -> Attempt:
    """The ordinary flow: present the item, then submit the correct answer."""
    present(caller, project, str(item.id))
    response = submit(caller, project, str(item.id), answer_for(version), key=key)
    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload["grade"]["status"] == "confirmed", payload
    return Attempt.objects.get(id=payload["attempt_id"])


def dimension_rows(attempt: Attempt) -> dict[str, LearningEvidence]:
    return {
        row.dimension: row
        for row in LearningEvidence.objects.filter(attempt=attempt, is_active=True)
    }


def attempt_reason_codes(attempt: Attempt) -> list[str]:
    return [row["code"] for row in contamination.attempt_exclusion_reasons(attempt=attempt)]


def linked_candidate(project, owner, version: QuestionVersion):
    """A re-import candidate that is linked to an already-published question."""
    from apps.ingestion.models import ImportCandidate, ImportJob

    job = ImportJob.objects.create(
        project=project, subject=version.question.subject, created_by=owner, input_kind="manual"
    )
    return ImportCandidate.objects.create(
        job=job,
        project=project,
        subject=version.question.subject,
        status="ready",
        draft_payload={},
        publication_question_id=version.question_id,
        publication_version_id=version.id,
    )


# ------------------------------------------------------- 1. proofreading preview
def test_editorial_preview_makes_a_later_correct_answer_not_strictly_independent(
    caller, owner, project_a, subject_a1
):
    version = standalone_single_choice_versions(subject_a1, 1)[0]

    # The proofreader saw this question (and its answer) while proofreading it.
    event = contamination.record_editorial_preview(
        question=version.question, actor=owner, source="test_proofreading"
    )
    assert event.kind == ExposureKind.EDITORIAL_PREVIEW
    assert event.reveals_answer is True

    # Question-level, before anything else happens: exactly the C04 reason, and
    # no path back to "strictly unseen".
    before = contamination.exposure_state(
        user=owner, question_ids=[str(version.question_id)], project=project_a
    )[str(version.question_id)]
    assert before["seen"] is True
    assert before["strict_independent_eligible"] is False
    assert before["reasons"] == ["editorial_preview_seen"]
    assert before["sources"] == ["exposure_event:editorial_preview"]

    session = start_session(caller, project_a, subject_a1, version.question, key="c04-editorial-session")
    attempt = answer_presented_item(caller, project_a, item_of(session), version, key="c04-editorial-submit")

    rows = dimension_rows(attempt)
    assert rows, "一次已确认的作答必须产生证据行"
    assert rows["independent_correct"].qualifies is False
    assert any("校对" in reason for reason in rows["independent_correct"].exclusion_reasons)
    # Contamination blocks strictness, not practice: the raw submission still counts.
    assert rows["repeat_practice"].qualifies is True
    assert rows["unassisted_completion"].qualifies is False
    # Every strict dimension that claims first contact / independence says the
    # same, with the precise reason instead of a generic "not independent".
    for dimension in ("unseen_variant", "template_variant", "delayed_verification"):
        assert rows[dimension].qualifies is False
        assert any("校对" in reason for reason in rows[dimension].exclusion_reasons)

    # The precise C04 reason, with the ledger row that proves it.
    reasons = contamination.attempt_exclusion_reasons(attempt=attempt)
    assert [row["code"] for row in reasons] == ["editorial_preview_seen"]
    assert reasons[0]["evidence"]["exposure_kind"] == "editorial_preview"
    assert reasons[0]["evidence"]["evidence_id"] == str(event.id)
    assert "校对" in reasons[0]["message"]

    # Question-level, after the attempt: the proofreading reason is still there
    # (the item's own stem delivery is named as well, and never resets anything).
    state = contamination.exposure_state(
        user=owner, question_ids=[str(version.question_id)], project=project_a
    )[str(version.question_id)]
    assert state["seen"] is True
    assert state["strict_independent_eligible"] is False
    assert "editorial_preview_seen" in state["reasons"]
    assert state["first_seen_at"] == before["first_seen_at"]


def test_editorial_preview_endpoint_records_proofreading_of_a_published_reimport(
    caller, other_caller, owner, project_a, subject_a1
):
    version = standalone_single_choice_versions(subject_a1, 1)[0]
    candidate = linked_candidate(project_a, owner, version)
    path = f"/api/v1/projects/{project_a.id}/import-candidates/{candidate.id}/editorial-preview"

    first = caller.post(path, {}, key="c04-preview-1")
    assert first.status_code == 201, first.content
    body = first.json()
    assert body["seen"] is True
    assert body["reasons"] == ["editorial_preview_seen"]
    assert body["strict_independent_eligible"] is False
    assert ExposureEvent.objects.filter(
        user=owner, question=version.question, kind=ExposureKind.EDITORIAL_PREVIEW
    ).count() == 1

    # Same key replays; re-opening the same candidate does not stack rows.
    assert caller.post(path, {}, key="c04-preview-1").status_code == 201
    assert caller.post(path, {}, key="c04-preview-2").status_code == 201
    assert ExposureEvent.objects.filter(
        user=owner, question=version.question, kind=ExposureKind.EDITORIAL_PREVIEW
    ).count() == 1
    # Another user's project is a 404, never a hint that the candidate exists.
    assert other_caller.post(path, {}, key="c04-preview-other").status_code == 404

    # A candidate that is not linked to published content cannot claim a proofread.
    from apps.ingestion.models import ImportCandidate

    unlinked = ImportCandidate.objects.get(id=candidate.id)
    unlinked.publication_question_id = None
    unlinked.publication_version_id = None
    unlinked.save(update_fields=["publication_question_id", "publication_version_id", "updated_at"])
    refused = caller.post(path, {}, key="c04-preview-unlinked")
    assert refused.status_code == 400, refused.content

    # And the proofread question can no longer qualify as strictly independent.
    session = start_session(caller, project_a, subject_a1, version.question, key="c04-preview-session")
    attempt = answer_presented_item(caller, project_a, item_of(session), version, key="c04-preview-submit")
    rows = dimension_rows(attempt)
    assert rows["independent_correct"].qualifies is False
    assert attempt_reason_codes(attempt) == ["editorial_preview_seen"]
    assert rows["repeat_practice"].qualifies is True


# ------------------------------------------------------------ 2. external seen
def test_external_seen_declaration_excludes_that_question_only(caller, project_a, subject_a1):
    exposed, fresh = standalone_single_choice_versions(subject_a1, 2)

    declared = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{exposed.question_id}/external-seen",
        {"seen": True, "note": "在教材上做过这道题"},
        key="c04-external-declare",
    )
    assert declared.status_code == 201, declared.content
    assert declared.json()["reasons"] == ["external_seen"]

    session = multi_item_session(
        caller, project_a, subject_a1, [exposed.question, fresh.question], key="c04-external-session"
    )
    contaminated = answer_presented_item(caller, project_a, item_of(session, 0), exposed, key="c04-external-a")
    control = answer_presented_item(caller, project_a, item_of(session, 1), fresh, key="c04-external-b")

    rows = dimension_rows(contaminated)
    assert rows["independent_correct"].qualifies is False
    assert any("系统外" in reason for reason in rows["independent_correct"].exclusion_reasons)
    assert rows["repeat_practice"].qualifies is True
    assert attempt_reason_codes(contaminated) == ["external_seen"]

    # Control: a fresh question in the same session still qualifies.
    assert dimension_rows(control)["independent_correct"].qualifies is True
    assert attempt_reason_codes(control) == []


# ------------------------------------------- 3. presented but never submitted
def test_presented_without_submit_blocks_the_next_item_on_the_same_question(
    caller, project_a, subject_a1
):
    version = standalone_single_choice_versions(subject_a1, 1)[0]

    # A probe item is delivered and abandoned: no attempt is ever submitted.
    probe = start_session(caller, project_a, subject_a1, version.question, key="c04-probe-session")
    probe_item = item_of(probe)
    present(caller, project_a, str(probe_item.id))
    probe_item.refresh_from_db()
    assert probe_item.first_delivered_at is not None
    assert Attempt.objects.filter(session_item=probe_item).count() == 0
    assert ExposureEvent.objects.filter(
        session_item=probe_item, kind=ExposureKind.STEM_DELIVERED
    ).exists()

    # A later item on the same question is answered correctly — the question was
    # already displayed without a submission (C04 source 3).
    session = start_session(caller, project_a, subject_a1, version.question, key="c04-after-probe-session")
    attempt = answer_presented_item(caller, project_a, item_of(session), version, key="c04-after-probe-submit")

    rows = dimension_rows(attempt)
    assert rows["independent_correct"].qualifies is False
    assert any("展示但未提交" in reason for reason in rows["independent_correct"].exclusion_reasons)
    assert rows["repeat_practice"].qualifies is True

    codes = attempt_reason_codes(attempt)
    assert "presented_without_submit" in codes
    assert "stem_delivered" in codes  # the abandoned delivery is named too
    presented = next(
        row
        for row in contamination.attempt_exclusion_reasons(attempt=attempt)
        if row["code"] == "presented_without_submit"
    )
    assert presented["evidence"]["evidence_type"] == "session_item"
    assert presented["evidence"]["evidence_id"] == str(probe_item.id)

    state = contamination.exposure_state(
        user=project_a.owner, question_ids=[str(version.question_id)], project=project_a
    )[str(version.question_id)]
    assert state["strict_independent_eligible"] is False
    assert "presented_without_submit" in state["reasons"]

    # Control: the same procedure on a question with no abandoned presentation.
    control_version = standalone_single_choice_versions(subject_a1, 2)[1]
    control_session = start_session(
        caller, project_a, subject_a1, control_version.question, key="c04-no-probe-session"
    )
    control = answer_presented_item(
        caller, project_a, item_of(control_session), control_version, key="c04-no-probe-submit"
    )
    assert dimension_rows(control)["independent_correct"].qualifies is True
    assert attempt_reason_codes(control) == []


def test_an_item_answered_before_a_later_abandoned_presentation_still_qualifies(
    caller, project_a, subject_a1
):
    """The rule is judged at the moment the item was presented, so it cannot reach back.

    The same question is put on screen twice in one session: the first item is
    answered, the second is abandoned. The answer came *before* the abandonment,
    so it stays strictly independent — and recomputation must agree.
    """
    version = standalone_single_choice_versions(subject_a1, 1)[0]
    session = multi_item_session(
        caller, project_a, subject_a1, [version.question, version.question], key="c04-order-session"
    )
    answered_item, abandoned_item = item_of(session, 0), item_of(session, 1)

    attempt = answer_presented_item(caller, project_a, answered_item, version, key="c04-order-submit")
    assert dimension_rows(attempt)["independent_correct"].qualifies is True

    present(caller, project_a, str(abandoned_item.id))
    assert Attempt.objects.filter(session_item=abandoned_item).count() == 0

    evidence_service.rebuild_for_attempt(str(attempt.id))
    rows = dimension_rows(attempt)
    assert rows["independent_correct"].qualifies is True
    assert rows["independent_correct"].exclusion_reasons == []
    assert attempt_reason_codes(attempt) == []


def test_a_never_presented_submission_is_not_labelled_presented_without_submit(
    caller, project_a, subject_a1
):
    """Control for the C04 rule, stated honestly.

    A submission whose item was never presented reproduces neither
    ``first_delivered_at`` nor a ``stem_delivered`` exposure before the attempt,
    so C04 must not call it "presented without submit". It is still not strict
    evidence — the pre-existing rule "缺少可信用时记录" applies, because the
    server-measured elapsed time only exists after a presentation. That is the
    timing rule, not the contamination rule, and the two must not be confused.
    """
    version = standalone_single_choice_versions(subject_a1, 1)[0]
    session = start_session(caller, project_a, subject_a1, version.question, key="c04-unpresented-session")
    item = item_of(session)
    assert item.first_delivered_at is None

    response = submit(caller, project_a, str(item.id), answer_for(version), key="c04-unpresented-submit")
    assert response.status_code == 200, response.content
    attempt = Attempt.objects.get(id=response.json()["attempt_id"])
    item.refresh_from_db()
    assert item.first_delivered_at is not None  # the submission itself records delivery

    assert "presented_without_submit" not in attempt_reason_codes(attempt)
    assert attempt_reason_codes(attempt) == []
    rows = dimension_rows(attempt)
    assert rows["independent_correct"].qualifies is False
    assert any("缺少可信用时记录" in reason for reason in rows["independent_correct"].exclusion_reasons)
    assert rows["repeat_practice"].qualifies is True


# ------------------------------------------------- 4. cross-project lineage
def test_cross_project_lineage_exposure_excludes_strict_evidence_in_this_project(
    caller, owner, project_a, project_b, subject_a1, subject_b1
):
    version_a = standalone_single_choice_versions(subject_a1, 1)[0]
    version_b = standalone_single_choice_versions(subject_b1, 1)[0]
    untouched = standalone_single_choice_versions(subject_a1, 2)[1]

    lineage = ContentLineage.objects.create(
        owner=owner,
        basis=ContentLineageBasis.MANUAL_CONFIRMED,
        is_confirmed=True,
        note="C04 集成测试：两个项目中的同一内容",
    )
    Question.objects.filter(id__in=[version_a.question_id, version_b.question_id]).update(
        content_lineage=lineage
    )
    # Re-read: the in-memory instances were loaded before the lineage was attached.
    question_b = Question.objects.get(id=version_b.question_id)
    version_b = QuestionVersion.objects.get(id=version_b.id)

    # The same content was met in project B (a stem-only preview and a delivered
    # answer): exposure follows the lineage, learning state does not.
    exposure_service.record(
        user=owner,
        project=project_b,
        question=question_b,
        question_version=version_b,
        kind=ExposureKind.STEM_DELIVERED,
        purpose="preview",
        source="test_cross_project",
        reveals_answer=False,
    )
    exposure_service.record(
        user=owner,
        project=project_b,
        question=question_b,
        question_version=version_b,
        kind=ExposureKind.ANSWER_DELIVERED,
        purpose="practice",
        source="test_cross_project",
        reveals_answer=True,
    )

    session = start_session(caller, project_a, subject_a1, version_a.question, key="c04-lineage-session")
    attempt = answer_presented_item(caller, project_a, item_of(session), version_a, key="c04-lineage-submit")

    rows = dimension_rows(attempt)
    assert rows["independent_correct"].qualifies is False
    assert any("其他项目" in reason for reason in rows["independent_correct"].exclusion_reasons)
    assert rows["repeat_practice"].qualifies is True
    assert attempt_reason_codes(attempt) == ["lineage_seen_in_other_project"]

    # The two projects' learning states stay separate: the attempt lives in A only.
    assert LearningEvidence.objects.filter(attempt=attempt, project=project_b).count() == 0
    assert all(
        row["attempt_id"] != str(attempt.id)
        for row in evidence_service.evidence_summary_rows(user=owner, project=project_b, limit=200)
    )

    # Control: a question without that lineage still qualifies in project A.
    control_session = start_session(
        caller, project_a, subject_a1, untouched.question, key="c04-lineage-control-session"
    )
    control = answer_presented_item(
        caller, project_a, item_of(control_session), untouched, key="c04-lineage-control-submit"
    )
    assert dimension_rows(control)["independent_correct"].qualifies is True


# --------------------------------------------------------- 5. no reset path
def test_no_recompute_regrade_or_reprojection_turns_a_contaminated_answer_back(
    caller, owner, project_a, subject_a1
):
    version = standalone_single_choice_versions(subject_a1, 1)[0]
    declared = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{version.question_id}/external-seen",
        {"seen": True, "note": "系统外做过"},
        key="c04-no-reset-declare",
    )
    assert declared.status_code == 201, declared.content

    session = start_session(caller, project_a, subject_a1, version.question, key="c04-no-reset-session")
    item = item_of(session)
    attempt = answer_presented_item(caller, project_a, item, version, key="c04-no-reset-submit")

    def snapshot() -> dict[str, tuple]:
        return {
            row.dimension: (row.qualifies, tuple(row.exclusion_reasons), row.grade_revision)
            for row in LearningEvidence.objects.filter(attempt=attempt, is_active=True)
        }

    first = snapshot()
    assert first["independent_correct"][0] is False
    assert any("系统外" in reason for reason in first["independent_correct"][1])
    assert first["repeat_practice"][0] is True
    row_count = len(first)

    # The recompute entry point, twice: same rows, no invented ones, same verdict.
    assert evidence_service.rebuild_for_attempt(str(attempt.id)) == row_count
    assert snapshot() == first
    evidence_service.rebuild_for_attempt(str(attempt.id))
    assert snapshot() == first

    # Re-projecting the knowledge state does not launder it either.
    mapping = version.knowledge_mappings.first()
    assert mapping is not None
    state_service.refresh_node_state(
        user=owner,
        project=project_a,
        syllabus_version=mapping.node.syllabus_version,
        node=mapping.node,
    )
    assert snapshot() == first

    # A regrade writes a new revision; the new rows are excluded for the same reason.
    regrade = attempt_services.regrade_attempt(
        attempt=attempt,
        target_answer_key_version=item.answer_key_version,
        actor=owner,
        reason="C04 稳定性检查：重判不得洗白",
    )
    assert regrade is not None and regrade.grading_revision == 2
    outbox.after_commit_dispatch()
    evidence_service.rebuild_for_attempt(str(attempt.id))
    attempt.refresh_from_db()

    after = snapshot()
    assert after["independent_correct"][0] is False
    assert any("系统外" in reason for reason in after["independent_correct"][1])
    assert after["independent_correct"][2] == 2
    assert after["repeat_practice"][0] is True
    # The superseded revision stays visible as history; it is never deleted and
    # never silently reactivated.
    assert LearningEvidence.objects.filter(attempt=attempt, grade_revision=1, is_active=False).exists()
    assert not LearningEvidence.objects.filter(attempt=attempt, is_active=True).exclude(grade_revision=2).exists()


# ----------------------------------------------------------------- 6. API
def test_exposure_endpoint_explains_reasons_and_is_owner_scoped(
    caller, other_caller, owner, project_a, subject_a1, subject_b1
):
    exposed, practised = standalone_single_choice_versions(subject_a1, 2)
    path = f"/api/v1/projects/{project_a.id}/questions/{exposed.question_id}/exposure"

    fresh = caller.get(path)
    assert fresh.status_code == 200, fresh.content
    body = fresh.json()
    assert body["question_id"] == str(exposed.question_id)
    assert body["seen"] is False
    assert body["strict_independent_eligible"] is True
    assert body["reasons"] == []
    assert body["exclusion_reasons"] == []
    assert body["first_seen_at"] is None
    assert body["sources"] == []

    declared = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{exposed.question_id}/external-seen",
        {"seen": True, "note": "教材第 3 章"},
        key="c04-api-declare",
    )
    assert declared.status_code == 201, declared.content
    body = declared.json()
    assert body["seen"] is True and body["strict_independent_eligible"] is False
    assert body["reasons"] == ["external_seen"]
    reason = next(row for row in body["exclusion_reasons"] if row["code"] == "external_seen")
    assert reason["message"]
    assert reason["evidence"]["exposure_kind"] == "external_seen"
    assert reason["evidence"]["evidence_id"]
    assert body["first_seen_at"] is not None
    assert body["sources"] == ["exposure_event:external_seen"]

    # Same key replays the stored answer without appending another ledger row.
    replay = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{exposed.question_id}/external-seen",
        {"seen": True, "note": "教材第 3 章"},
        key="c04-api-declare",
    )
    assert replay.status_code == 201
    assert replay.json()["seen"] is True
    # A different body under the same key is a conflict, never a silent second write.
    conflict = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{exposed.question_id}/external-seen",
        {"seen": False, "note": "同一个键换了内容"},
        key="c04-api-declare",
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"

    # A correction is a new ledger row, never a reset: the question stays seen.
    corrected = caller.post(
        f"/api/v1/projects/{project_a.id}/questions/{exposed.question_id}/external-seen",
        {"seen": False, "note": "记错了，其实没见过"},
        key="c04-api-correct",
    )
    assert corrected.status_code == 201, corrected.content
    assert corrected.json()["seen"] is True
    assert corrected.json()["reasons"] == ["external_seen"]
    rows = list(
        ExposureEvent.objects.filter(
            user=owner, question=exposed.question, kind=ExposureKind.EXTERNAL_SEEN
        ).order_by("server_time")
    )
    assert [row.detail["seen"] for row in rows] == [True, False]

    # A question that was only put on screen explains itself as delivered.
    session = start_session(caller, project_a, subject_a1, practised.question, key="c04-api-practised")
    present(caller, project_a, str(item_of(session).id))
    practised_body = caller.get(
        f"/api/v1/projects/{project_a.id}/questions/{practised.question_id}/exposure"
    ).json()
    assert practised_body["seen"] is True
    assert "stem_delivered" in practised_body["reasons"]
    assert practised_body["strict_independent_eligible"] is False

    # Another user's project is a 404 on every entry point.
    assert other_caller.get(path).status_code == 404
    assert other_caller.get(path).json()["error"]["code"] == "not_found"
    assert (
        other_caller.post(
            f"/api/v1/projects/{project_a.id}/questions/{exposed.question_id}/external-seen",
            {"seen": True},
            key="c04-api-other",
        ).status_code
        == 404
    )

    # A question from another project is a 404 through this project's route too.
    foreign_version = standalone_single_choice_versions(subject_b1, 1)[0]
    foreign = caller.get(
        f"/api/v1/projects/{project_a.id}/questions/{foreign_version.question_id}/exposure"
    )
    assert foreign.status_code == 404
    assert foreign.json()["error"]["code"] == "not_found"


def test_proofreading_a_linked_reimport_candidate_records_the_exposure(caller, project_a, subject_a1):
    """C04 source 1 must be reachable from the real proofreading path.

    ``apps/ingestion/api.py`` is the call site: opening (or editing) a re-import
    candidate that is already linked to a published question means the proofreader
    is looking at that question's answer, so the question can no longer produce
    strict-independent evidence — no matter how the answer is graded later.
    """
    from apps.ingestion.models import ImportCandidate, ImportJob
    from apps.question_bank.models import QuestionVersion

    version = standalone_single_choice_versions(subject_a1, 1)[0]
    job = ImportJob.objects.create(
        project=project_a,
        subject=subject_a1,
        created_by=project_a.owner,
        status="awaiting_review",
        input_kind="pdf",
    )
    candidate = ImportCandidate.objects.create(
        job=job,
        project=project_a,
        subject=subject_a1,
        status="ready",
        source_position_key="1",
        publication_question_id=version.question_id,
        publication_version_id=version.id,
    )
    assert (
        ExposureEvent.objects.filter(
            user=project_a.owner, question=version.question, kind=ExposureKind.EDITORIAL_PREVIEW
        ).count()
        == 0
    )

    detail = caller.get(f"/api/v1/projects/{project_a.id}/import-candidates/{candidate.id}")
    assert detail.status_code == 200, detail.content
    rows = ExposureEvent.objects.filter(
        user=project_a.owner, question=version.question, kind=ExposureKind.EDITORIAL_PREVIEW
    )
    assert rows.count() == 1
    assert rows.first().detail["candidate_id"] == str(candidate.id)

    # Re-opening the same candidate reuses the row instead of stacking duplicates.
    assert caller.get(f"/api/v1/projects/{project_a.id}/import-candidates/{candidate.id}").status_code == 200
    assert rows.count() == 1

    state = contamination.exposure_state(user=project_a.owner, question_ids=[str(version.question_id)])[
        str(version.question_id)
    ]
    assert state["seen"] is True
    assert "editorial_preview_seen" in state["reasons"]
    assert state["strict_independent_eligible"] is False

    # An unlinked candidate (nothing published yet) must not record anything.
    unlinked = ImportCandidate.objects.create(
        job=job,
        project=project_a,
        subject=subject_a1,
        status="draft",
        source_position_key="2",
        publication_question_id=None,
    )
    assert caller.get(f"/api/v1/projects/{project_a.id}/import-candidates/{unlinked.id}").status_code == 200
    assert rows.count() == 1
