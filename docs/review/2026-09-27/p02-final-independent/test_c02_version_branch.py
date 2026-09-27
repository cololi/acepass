"""C02: an old queued regrade cannot erase newer-version evidence."""
from copy import deepcopy
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.analytics.services.reports import execute_regrade_run, request_regrade
from apps.learning.services.evidence import rebuild_for_attempt
from apps.practice.models import LearningEvidence
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from tests.integration.test_p0_2_closeout_gaps import _service_attempt
from tests.integration.test_practice_flow import published

pytest_plugins = ["tests.conftest"]
pytestmark = pytest.mark.django_db


def test_old_content_version_regrade_keeps_newer_generation_evidence(project_a, subject_a1):
    now = timezone.now()
    qv1 = published(subject_a1, "true_false")
    old_item, _old_attempt = _service_attempt(project_a, subject_a1, qv1, now - timedelta(minutes=3), now - timedelta(minutes=2))
    old = request_regrade(question=qv1.question, target_answer_key_version=old_item.answer_key_version,
                          actor=project_a.owner, reason="Queued against the original content version")

    # A new content revision of the same stable question, through ordinary publish services.
    content = deepcopy(qv1.content)
    content["blocks"][0]["text"] += "（文字校订版）"
    qv2 = content_services.create_question_version_draft(
        qv1.question, question_type=qv1.question_type, content=content,
        actor=project_a.owner, practice_max_score=qv1.practice_max_score,
        revision_reason="Editorial correction while old regrade remains queued")
    key2 = AnswerKeyVersion.objects.create(
        question_version=qv2, version=1,
        answer_payload=deepcopy(old_item.answer_key_version.answer_payload),
        verification_status="checked", checked_by=project_a.owner,
        check_basis="Independent C02 regression fixture")
    content_services.replace_knowledge_mappings(
        qv2, [{"node_id": str(row.node_id), "is_primary": row.is_primary,
               "score_weight": row.score_weight}
              for row in qv1.knowledge_mappings.all()], actor=project_a.owner)
    qv2 = content_services.publish_question_version(qv2, actor=project_a.owner)
    _item2, attempt2 = _service_attempt(project_a, subject_a1, qv2, now - timedelta(minutes=1), now)
    assert attempt2.session_item.question_version_id == qv2.id

    new = request_regrade(question=qv2.question, target_answer_key_version=key2,
                          actor=project_a.owner, reason="Newer regrade against corrected content")
    assert new.generation > old.generation
    execute_regrade_run(str(new.id))
    rebuild_for_attempt(str(attempt2.id))  # apply the ordinary asynchronous evidence projection
    attempt2.refresh_from_db()
    assert attempt2.applied_regrade_generation == new.generation
    grade_id = attempt2.current_grade_event_id
    active_ids = set(LearningEvidence.objects.filter(attempt=attempt2, is_active=True).values_list("id", flat=True))
    assert active_ids

    execute_regrade_run(str(old.id))
    attempt2.refresh_from_db()
    old.refresh_from_db()
    assert attempt2.current_grade_event_id == grade_id
    assert attempt2.applied_regrade_generation == new.generation
    remaining_ids = set(LearningEvidence.objects.filter(attempt=attempt2, is_active=True).values_list("id", flat=True))
    assert remaining_ids == active_ids, (
        f"Old generation {old.generation} invalidated newer generation {new.generation} evidence: "
        f"before={len(active_ids)} after={len(remaining_ids)}, "
        f"old.invalidated_evidence={old.invalidated_evidence}, old.stale_skipped={old.stale_skipped_attempts}"
    )
