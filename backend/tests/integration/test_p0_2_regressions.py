"""P0.2 regression coverage for the independent re-acceptance findings B01-B07.

These are the counter-examples from
``docs/review/2026-09-27/p01-independent/`` migrated into the normal suite once
the implementation satisfied them. The originals are kept unchanged as the
problem baseline; this file is the version CI runs, so the business requirements
they cover cannot silently disappear again.

What each group pins down:

* **B01/B03** — a regrade request over real autocommit HTTP returns 201, two
  concurrent requests get distinct generations, and a target that becomes
  disputed before the queued run executes cannot produce a confirmed score.
* **B02** — a running verification's answer cannot be reached by grading a
  parallel practice attempt on the same content, nor by asking a tutor for an
  explanation.
* **B04** — starting a delayed task re-derives the anchor, so a brand-new
  training on the same knowledge point pushes the deadline forward, and delay
  evidence is measured from the completion of the previous training, not from
  the moment the question was displayed.
* **B05** — the real consumer honours an existing lease, a stale failure cannot
  reopen a processed event, and redelivery obeys ``max_attempts``.
* **B06** — a late vision result cannot overwrite a human proofread revision.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import Mock

import pytest
from django.utils import timezone

from apps.analytics.services.reports import execute_regrade_run, request_regrade
from apps.audit.models import OutboxEvent
from apps.audit.services import outbox
from apps.audit.tasks import rebuild_attempt_evidence
from apps.common.enums import OutboxStatus
from apps.learning.models import StudyTask
from apps.learning.services import pairing as pairing_services
from apps.learning.services.evidence import compute_dimensions
from apps.practice.models import Attempt
from apps.practice.services import attempts as attempt_services
from apps.practice.services import sessions as session_services
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from tests.integration.test_learning_loop import answer_for, make_pairing
from tests.integration.test_practice_flow import present, published, start_session, submit

#: Every case here touches PostgreSQL; the concurrency ones opt into a real
#: transaction with ``django_db(transaction=True)`` on top of this.
pytestmark = pytest.mark.django_db


def _make_service_attempt(project, subject, version, delivered, submitted):
    """One attempt submitted through the services, with explicit times."""
    session = session_services.create_session(
        user=project.owner, project=project, subject=subject, question_ids=[str(version.question_id)]
    )
    item = session.items.get()
    session_services.presentation(item=item, user=project.owner, now=delivered)
    attempt, _grade = attempt_services.submit_attempt(
        session_item_id=str(item.id), user=project.owner, raw_answer=answer_for(version), now=submitted
    )
    return item, attempt


# ------------------------------------------------------------------ B01/B03
@pytest.mark.django_db(transaction=True)
def test_regrade_http_works_without_test_wrapping_transaction(caller, project_a, subject_a1):
    """Real autocommit HTTP must work: the outer test transaction used to hide it."""
    version = published(subject_a1, "true_false")
    answer = AnswerKeyVersion.objects.get(question_version=version)
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/regrades",
        {
            "question_id": str(version.question_id),
            "target_answer_key_version_id": str(answer.id),
            "reason": "independent API autocommit acceptance",
        },
        key="audit-regrade-autocommit",
    )
    assert response.status_code == 201, response.content


@pytest.mark.django_db(transaction=True)
def test_concurrent_regrade_requests_receive_distinct_generations(project_a, subject_a1, monkeypatch):
    """Two real concurrent requests must never share a generation number."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import connections, transaction

    from apps.accounts.models import User
    from apps.analytics.models import RegradeRun
    from apps.question_bank.models import Question

    version = published(subject_a1, "true_false")
    answer = AnswerKeyVersion.objects.get(question_version=version)
    with transaction.atomic():
        seed = request_regrade(
            question=version.question,
            target_answer_key_version=answer,
            actor=project_a.owner,
            reason="seed generation",
        )
    barrier = Barrier(2, timeout=10)
    original_create = RegradeRun.objects.create

    def synchronized_create(*args, **kwargs):
        result = original_create(*args, **kwargs)
        barrier.wait()
        return result

    monkeypatch.setattr(RegradeRun.objects, "create", synchronized_create)

    def launch(index):
        try:
            with transaction.atomic():
                run = request_regrade(
                    question=Question.objects.get(id=version.question_id),
                    target_answer_key_version=AnswerKeyVersion.objects.get(id=answer.id),
                    actor=User.objects.get(id=project_a.owner_id),
                    reason=f"concurrent {index}",
                )
                return run.generation
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(launch, i) for i in range(2)]
        generations = [f.result(timeout=20) for f in futures]
    assert seed.generation not in generations or len(set(generations)) == 2
    assert len(set(generations)) == 2, f"并发请求必须拿到不同代次，实际 {generations}"


def test_target_disputed_between_regrade_request_and_execution_is_refused(caller, project_a, subject_a1):
    """A queued regrade whose target becomes disputed must not confirm a score."""
    version = published(subject_a1, "true_false")
    now = timezone.now()
    item, attempt = _make_service_attempt(project_a, subject_a1, version, now - timedelta(minutes=1), now)
    target = AnswerKeyVersion.objects.create(
        question_version=version,
        version=2,
        answer_payload=item.answer_key_version.answer_payload,
        verification_status="checked",
        checked_by=project_a.owner,
    )
    run = request_regrade(
        question=version.question,
        target_answer_key_version=target,
        actor=project_a.owner,
        reason="queued before dispute",
    )
    content_services.dispute_answer_key_version(target, actor=project_a.owner, reason="new evidence target wrong")
    execute_regrade_run(str(run.id))
    attempt.refresh_from_db()
    assert attempt.current_grade_event.status != "confirmed", (
        "争议期间排队任务执行后不得留下 confirmed 评分："
        f"status={attempt.current_grade_event.status} "
        f"answer_disputed={attempt.current_grade_event.answer_key_version.is_disputed}"
    )


# ---------------------------------------------------------------------- B02
def test_parallel_practice_submit_cannot_reveal_live_verification_score(caller, project_a, subject_a1):
    """The score of a parallel practice attempt is the answer by arithmetic."""
    version = published(subject_a1, "true_false")
    verification = start_session(caller, project_a, subject_a1, version.question, mode="verification")
    present(caller, project_a, verification["items"][0]["session_item_id"])
    practice = start_session(caller, project_a, subject_a1, version.question)
    item_id = practice["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    response = submit(caller, project_a, item_id, {"type": "true_false", "value": True}, key="parallel-grade")
    assert response.status_code == 403 or response.json().get("grade") is None, response.content


def test_parallel_practice_tutor_gate(caller, project_a, subject_a1):
    """Asking a tutor for an explanation on the same content is the same leak."""
    version = published(subject_a1, "true_false")
    verify = start_session(caller, project_a, subject_a1, version.question, mode="verification", key="audit-verify")
    present(caller, project_a, verify["items"][0]["session_item_id"])
    practice = start_session(caller, project_a, subject_a1, version.question, mode="practice", key="audit-practice")
    item = practice["items"][0]["session_item_id"]
    opened = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": item, "purpose": "explanation"},
        key="audit-tutor",
    )
    if opened.status_code == 201:
        session = opened.json()["tutor_session_id"]
        response = caller.post(
            f"/api/v1/projects/{project_a.id}/tutor-sessions/{session}/messages",
            {"user_question": "请讲解这道题"},
            key="audit-message",
        )
        assert response.status_code != 201, "平行练习不得通过辅导拿到讲解"
    assert opened.status_code == 403, opened.content


def test_stored_tutor_result_is_gated_too(caller, project_a, subject_a1):
    """A result computed *before* the verification started is still a leak."""
    version = published(subject_a1, "true_false")
    practice = start_session(caller, project_a, subject_a1, version.question, mode="practice", key="stored-tutor")
    item_id = practice["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    opened = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": item_id, "purpose": "explanation"},
        key="stored-tutor-session",
    )
    assert opened.status_code == 201, opened.content
    session_id = opened.json()["tutor_session_id"]
    asked = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions/{session_id}/messages",
        {"user_question": "先讲解一次"},
        key="stored-tutor-message",
    )
    assert asked.status_code == 201, asked.content
    job_id = asked.json()["tutor_job_id"]
    assert caller.get(f"/api/v1/projects/{project_a.id}/tutor-jobs/{job_id}").status_code == 200

    # Now a verification on the same content starts and is presented.
    verify = start_session(caller, project_a, subject_a1, version.question, mode="verification", key="stored-verify")
    present(caller, project_a, verify["items"][0]["session_item_id"])

    reread = caller.get(f"/api/v1/projects/{project_a.id}/tutor-jobs/{job_id}")
    assert reread.status_code == 403, "验证进行中不得读取已缓存的讲解结果"
    assert reread.json()["error"]["code"] == "purpose_not_allowed"


def test_report_does_not_aggregate_content_under_verification(caller, project_a, subject_a1):
    """An aggregate over a parallel attempt leaks the same number."""
    version = published(subject_a1, "true_false")
    practice = start_session(caller, project_a, subject_a1, version.question, mode="practice", key="report-practice")
    item_id = practice["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    submit(caller, project_a, item_id, {"type": "true_false", "value": True}, key="report-submit")

    before = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert before["totals"]["repeat_practice"]["attempts"] >= 1

    verify = start_session(caller, project_a, subject_a1, version.question, mode="verification", key="report-verify")
    present(caller, project_a, verify["items"][0]["session_item_id"])

    during = caller.get(f"/api/v1/projects/{project_a.id}/reports/practice").json()
    assert during["hidden_verification_content_attempts"] >= 1
    assert (
        during["totals"]["repeat_practice"]["attempts"] < before["totals"]["repeat_practice"]["attempts"]
    ), "验证进行中，平行练习的分数不得进入报告统计"


# ---------------------------------------------------------------------- B04
def test_delayed_task_rechecks_latest_training_at_direct_session_start(caller, project_a, subject_a1):
    """A stored deadline does not survive a brand-new training event."""
    pair, a, b, _c = make_pairing(subject_a1)
    for version in (a, b, _c):
        content_services.replace_knowledge_mappings(
            version, [{"node_id": str(pair.node_id), "is_primary": True, "score_weight": "1"}], actor=project_a.owner
        )
    now = timezone.now()
    old = now - timedelta(hours=26)
    item_b, attempt_b = _make_service_attempt(project_a, subject_a1, b, old - timedelta(minutes=1), old)
    pairing_services.on_attempt_graded(str(attempt_b.id))
    task = StudyTask.objects.get(pairing=pair, origin_session_item=item_b, task_kind="delayed_verification")
    assert task.not_before < now
    _item_a, attempt_a = _make_service_attempt(
        project_a, subject_a1, a, now - timedelta(minutes=2), now - timedelta(minutes=1)
    )
    assert attempt_a.submitted_at > task.delay_anchor_at
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": "verification", "subject_id": str(subject_a1.id), "task_id": str(task.id)},
        key="latest-anchor",
    )
    assert response.status_code in {400, 403, 409}, response.content


def test_delayed_evidence_uses_completion_not_start_of_last_training(project_a, subject_a1):
    """Time on screen is not training: the clock starts at completion."""
    pair, _a, b, c = make_pairing(subject_a1)
    for version in (b, c):
        content_services.replace_knowledge_mappings(
            version, [{"node_id": str(pair.node_id), "is_primary": True, "score_weight": "1"}], actor=project_a.owner
        )
    now = timezone.now()
    _make_service_attempt(project_a, subject_a1, b, now - timedelta(hours=25), now - timedelta(hours=1))
    _item_c, attempt_c = _make_service_attempt(project_a, subject_a1, c, now - timedelta(minutes=1), now)
    dimension = next(
        row
        for row in compute_dimensions(attempt_c)
        if row["dimension"] == "delayed_verification" and row["node"].id == pair.node_id
    )
    assert dimension["qualifies"] is False, dimension


# ---------------------------------------------------------------------- B05
def test_real_consumer_refuses_another_live_claim(monkeypatch, settings):
    """The real Celery task must claim the lease before doing any work."""
    settings.ACEPASS_INLINE_TASKS = False
    from apps.learning.services import evidence

    spy = Mock(return_value=0)
    monkeypatch.setattr(evidence, "rebuild_for_attempt", spy)
    event = outbox.enqueue("projection.rebuild_attempt_evidence", {"attempt_id": "irrelevant"})
    claim = outbox.claim_event(str(event.id))
    assert claim is not None
    result = rebuild_attempt_evidence.run(attempt_id="irrelevant", outbox_event_id=str(event.id))
    event.refresh_from_db()
    assert result == "skipped_lease_not_held"
    assert spy.call_count == 0, f"另一活跃租约存在时不得执行：calls={spy.call_count} status={event.status}"


def test_stale_failure_cannot_reopen_processed_event():
    """``processed`` is terminal for every writer, including an older consumer."""
    event = outbox.enqueue("learning.refresh_delayed_tasks", {})
    outbox.mark_processed(str(event.id))
    outbox.mark_retryable_failure(event, "older consumer failed after newer one completed")
    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSED
    assert event.processed_at is not None


def test_successfully_sent_but_lost_messages_obey_retry_cap(monkeypatch, settings):
    """Redelivery is bounded too, not just failure retries."""
    settings.ACEPASS_INLINE_TASKS = False
    from config.celery import app

    monkeypatch.setattr(app, "send_task", Mock())
    event = outbox.enqueue("learning.refresh_delayed_tasks", {})
    event.max_attempts = 1
    event.save(update_fields=["max_attempts"])
    outbox.dispatch_pending()
    OutboxEvent.objects.filter(id=event.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    outbox.dispatch_pending()
    event.refresh_from_db()
    assert event.attempts <= event.max_attempts, f"重投超出上限: {event.attempts}>{event.max_attempts}"


# ---------------------------------------------------------------------- B06
def test_late_extraction_must_not_overwrite_human_review(project_a, subject_a1):
    """A model result that arrives after proofreading loses to the human."""
    import io

    from PIL import Image

    from ai.providers.base import AiCallResult
    from apps.ingestion.services.core import create_image_document, update_candidate
    from apps.ingestion.services.extraction import _apply_extraction
    from apps.ingestion.services.imports import start_image_import

    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(buffer, format="PNG")
    document = create_image_document(
        owner=project_a.owner,
        project=project_a,
        content=buffer.getvalue(),
        content_type="image/png",
        subject=subject_a1,
    )
    job = start_image_import(
        owner=project_a.owner, project=project_a, documents=[document], subject=subject_a1, use_vision=False
    )
    candidate = job.candidates.get()
    edited = {
        **candidate.draft_payload,
        "question_type": "true_false",
        "content": {"blocks": [{"kind": "text", "text": "HUMAN_REVIEW_MARKER"}]},
        "answer_payload": {"kind": "true_false", "value": True},
        "answer_status_known": True,
    }
    update_candidate(candidate, payload=edited, actor=project_a.owner, expected_revision=candidate.revision)
    stale = {
        "question_type": "true_false",
        "content": {"blocks": [{"kind": "text", "text": "STALE_MODEL_OUTPUT"}]},
        "answer_payload": {},
        "answer_status_known": False,
    }
    outcome = _apply_extraction(
        candidate=candidate, clean=stale, call=AiCallResult(payload=stale, is_stub=True), problems=[]
    )
    candidate.refresh_from_db()
    assert outcome == "stale_skipped"
    assert candidate.draft_payload["content"]["blocks"][0]["text"] == "HUMAN_REVIEW_MARKER"
    # The machine output is not thrown away: it stays available for comparison.
    assert candidate.machine_payload["stale_revision"] is True
    assert candidate.machine_payload["pending_clean_payload"]["content"]["blocks"][0]["text"] == "STALE_MODEL_OUTPUT"
