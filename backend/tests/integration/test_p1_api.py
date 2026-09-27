"""P1 API surface: the HTTP contract the UI is built on.

The report and UI both depend on these routes behaving exactly as described, so
they are exercised through the real HTTP client (multipart upload included)
rather than by calling the services directly.
"""

from __future__ import annotations

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.analytics.services import cycles as cycle_service
from apps.exams.models import Paper, PaperRevision
from apps.ingestion.models import ImportCandidate
from apps.knowledge.models import KnowledgeNode
from apps.knowledge.services import outline as outline_services
from tests.support.pdf_builder import build_text_pdf

pytestmark = pytest.mark.django_db

PAPER = "1．【题型】单选题\n【题干】示例题一？\n【选项】\nA. 甲\nB. 乙\n2．【题型】判断题\n【题干】示例题二成立。\n"
ANSWERS = "参考答案\n1. A\n2. 对\n"


def _pdf_upload(name: str, pages: list[str]) -> SimpleUploadedFile:
    return SimpleUploadedFile(name, build_text_pdf(pages), content_type="application/pdf")


def _post_pdf(caller, project, subject, *, with_answers: bool = True, key: str = "pdf-import-1", **extra):
    payload = {
        "files": [_pdf_upload("paper.pdf", [PAPER])],
        "subject_id": str(subject.id),
        "title": "2024 测试卷",
        "cycle_key": "2024",
        "session_key": "上半年",
        "paper_code": "卷一",
        "source_kind": "official_past",
    }
    if with_answers:
        payload["answer_files"] = [_pdf_upload("answers.pdf", [ANSWERS])]
    payload.update(extra)
    return caller.client.post(
        f"/api/v1/projects/{project.id}/imports/pdf",
        data=payload,
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
        HTTP_IDEMPOTENCY_KEY=key,
    )


def test_pdf_import_endpoint_accepts_a_real_multipart_upload(caller, project_a, subject_a1):
    response = _post_pdf(caller, project_a, subject_a1)
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["input_kind"] == "pdf_text"
    assert body["candidate_count"] == 2

    candidates = caller.get(f"/api/v1/projects/{project_a.id}/import-candidates?job_id={body['id']}").json()
    assert len(candidates) == 2
    for candidate in candidates:
        assert candidate["source_regions"][0]["page_index"] == 1
        assert candidate["source_position_key"] in {"1", "2"}
        assert candidate["paper_revision_id"] is not None
        assert candidate["answer_match"]["matched"] is True
        assert candidate["answer_match"]["method"] == "label"


def test_pdf_import_rejects_a_file_without_a_text_layer(caller, project_a, subject_a1):
    response = caller.client.post(
        f"/api/v1/projects/{project_a.id}/imports/pdf",
        data={
            "files": [_pdf_upload("scan.pdf", ["", ""])],
            "subject_id": str(subject_a1.id),
            "cycle_key": "2024",
            "paper_code": "卷一",
            "source_kind": "official_past",
        },
        HTTP_X_CSRFTOKEN=caller.client.cookies["csrftoken"].value,
        HTTP_IDEMPOTENCY_KEY="pdf-import-scan",
    )
    assert response.status_code == 400
    assert response.json()["error"]["details"]["reason"] == "no_text_layer"


def test_real_paper_import_requires_a_cycle_and_paper_code(caller, project_a, subject_a1):
    response = _post_pdf(caller, project_a, subject_a1, cycle_key="")
    assert response.status_code == 400
    assert "年份" in response.json()["error"]["message"]


def test_coverage_confirmation_drives_the_cycle_analysis(caller, project_a, subject_a1):
    imported = _post_pdf(caller, project_a, subject_a1).json()
    revision_id = caller.get(
        f"/api/v1/projects/{project_a.id}/import-candidates?job_id={imported['id']}"
    ).json()[0]["paper_revision_id"]

    # Before anything is confirmed the cycle is incomplete and cannot be counted.
    analysis = caller.get(
        f"/api/v1/projects/{project_a.id}/papers/cycle-analysis?subject_id={subject_a1.id}"
    ).json()
    assert analysis["status"] == "insufficient_cycles"
    assert analysis["complete_cycle_count"] == 0
    assert any(row["cycle_key"] == "2024" for row in analysis["incomplete_cycles"])

    # Declaring expected/covered sessions without confirming is still not enough.
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/paper-revisions/{revision_id}/coverage",
        {"expected_session_count": 1, "covered_session_count": 1, "confirm": False},
    )
    assert response.status_code == 200, response.content
    assert response.json()["coverage_status"] == "coverage_incomplete"

    # Confirming coverage on a revision with no scored items is refused: the
    # denominator would be a claim, not a number.
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/paper-revisions/{revision_id}/confirm", {}
    )
    assert response.status_code == 400

    # Publishing one proofread question creates the paper item, after which the
    # revision can be confirmed and the cycle becomes countable.
    candidate = _publish_first(caller, project_a, imported["id"])
    assert candidate["publication_version_id"]
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/paper-revisions/{revision_id}/coverage",
        {"expected_session_count": 1, "covered_session_count": 1, "confirm": True},
    )
    assert response.status_code == 200, response.content
    assert response.json()["coverage_status"] == "coverage_complete"
    response = caller.post(f"/api/v1/projects/{project_a.id}/paper-revisions/{revision_id}/confirm", {})
    assert response.status_code == 200, response.content
    assert response.json()["status"] == "confirmed"

    paper = Paper.objects.get(subject=subject_a1, cycle_key="2024")
    assert str(paper.effective_revision_id) == revision_id

    analysis = caller.get(
        f"/api/v1/projects/{project_a.id}/papers/cycle-analysis?subject_id={subject_a1.id}&max_cycles=5"
    ).json()
    assert analysis["complete_cycle_count"] == 1
    assert analysis["used_cycles"] == ["2024"]
    assert analysis["status"] == "insufficient_cycles"
    assert analysis["cycles"][0]["denominator_total_score"] == "2.000"
    assert analysis["cycles"][0]["nodes"][0]["unclassified"] is True
    assert any("未分类" in note for note in analysis["notes"])


def _publish_first(caller, project, job_id: str) -> dict:
    """Proofread and publish the first candidate of a job, as the UI does."""
    candidates = caller.get(f"/api/v1/projects/{project.id}/import-candidates?job_id={job_id}").json()
    candidate = candidates[0]
    payload = dict(candidate["draft_payload"])
    payload["practice_max_score"] = "2"
    payload["answer_status_known"] = True
    payload["answer_confirmed_by_match_review"] = True
    payload["check_basis"] = "人工核对答案页匹配"
    response = caller.patch(
        f"/api/v1/projects/{project.id}/import-candidates/{candidate['id']}",
        {"draft_payload": payload, "expected_revision": candidate["revision"]},
    )
    assert response.status_code == 200, response.content
    response = caller.post(
        f"/api/v1/projects/{project.id}/import-candidates/{candidate['id']}/publish", {}
    )
    assert response.status_code == 200, response.content
    return response.json()


def test_syllabus_word_list_endpoint_and_node_move(caller, project_a, subject_a1):
    syllabus = caller.post(
        f"/api/v1/projects/{project_a.id}/syllabus-versions",
        {"subject_id": str(subject_a1.id), "name": "P1 API 大纲", "version_label": "v1"},
    ).json()
    caller.post(f"/api/v1/projects/{project_a.id}/syllabus-versions/{syllabus['id']}/publish", {})

    response = caller.post(
        f"/api/v1/projects/{project_a.id}/syllabus-versions/{syllabus['id']}/nodes/import",
        {"text": "第一章 数与式\n  第一节 实数\n    实数的分类（有理数与无理数）\n    实数的运算\n"},
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["created"] == 4
    assert body["merged"] == 0

    nodes = caller.get(
        f"/api/v1/projects/{project_a.id}/knowledge-nodes?syllabus_version_id={syllabus['id']}"
    ).json()
    root = next(node for node in nodes if node["canonical_name"] == "第一章 数与式")
    child = next(node for node in nodes if node["canonical_name"] == "第一节 实数")
    leaf = next(node for node in nodes if node["canonical_name"] == "实数的运算")
    assert child["parent_id"] == root["id"]
    assert leaf["parent_id"] == child["id"]

    # Moving the root under its own descendant would create a cycle.
    response = caller.patch(
        f"/api/v1/projects/{project_a.id}/knowledge-nodes/{root['id']}",
        {"parent_id": leaf["id"], "move": True},
    )
    assert response.status_code == 400
    assert "环" in response.json()["error"]["message"]

    # A legal rename + alias update is accepted.
    response = caller.patch(
        f"/api/v1/projects/{project_a.id}/knowledge-nodes/{leaf['id']}",
        {"canonical_name": "实数的四则运算", "aliases": ["实数运算"]},
    )
    assert response.status_code == 200, response.content
    assert response.json()["canonical_name"] == "实数的四则运算"
    assert response.json()["aliases"] == ["实数运算"]


def test_cycle_analysis_endpoint_reports_insufficient_cycles_for_a_fresh_subject(caller, project_a, subject_a2):
    analysis = caller.get(
        f"/api/v1/projects/{project_a.id}/papers/cycle-analysis?subject_id={subject_a2.id}"
    ).json()
    assert analysis["status"] == "insufficient_cycles"
    assert analysis["used_cycle_count"] == 0
    assert analysis["missing_complete_cycles"] == 5
    assert analysis["cycles"] == []
    assert analysis["notes"]


def test_cycle_analysis_endpoint_is_scoped_to_the_project(caller, other_caller, project_a, subject_a1):
    response = other_caller.get(
        f"/api/v1/projects/{project_a.id}/papers/cycle-analysis?subject_id={subject_a1.id}"
    )
    assert response.status_code == 404
