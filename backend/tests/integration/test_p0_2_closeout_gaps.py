"""P0.2 close-out regressions: the C01-C04 cross-boundary findings.

These are the counter-examples from
``docs/review/2026-09-27/p02-independent/`` migrated into the normal suite after
the implementation satisfied them. The originals stay in the evidence directory
unchanged as the problem baseline; this file is what CI runs, so the business
requirements cannot silently disappear again.

What each group pins down:

* **C01** — *every* result-delivering entry point shares one content gate:
  the session snapshot and its nested grade, the idempotent submit replay, the
  idempotent tutor-message replay, the evidence projection and the grading queue.
  Idempotency replays the same *resource*, never a cached copy of a sensitive
  payload.
* **C02** — regrade generations order *all* exit branches: an older refused run
  cannot revoke a newer valid grade, and a legacy history whose order cannot be
  recovered is refused by the migration (with an actionable inventory and no
  partial modification) instead of being renumbered above an applied generation.
* **C03** — the delayed-verification interval is judged when the verification
  *starts* (the item's first presentation), so opening early and submitting late
  earns nothing.
* **C04** — the tutor consumer's business commit is protected by the outbox lease:
  a retry after a crash between "result stored" and "message/exposure written"
  completes the missing facts, and a stale consumer cannot overwrite the takeover
  or duplicate the message/exposure.
"""

from __future__ import annotations

import importlib
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.core.management import call_command
from django.db import connection, transaction
from django.utils import timezone

from apps.analytics.models import RegradeRun
from apps.analytics.services.reports import execute_regrade_run, request_regrade
from apps.audit.models import ContentRevision, OutboxEvent
from apps.common.enums import OutboxStatus
from apps.learning.services.evidence import compute_dimensions, rebuild_for_attempt
from apps.practice.models import Attempt, ExposureEvent, GradeEvent
from apps.practice.services import attempts as attempt_services
from apps.practice.services import sessions as session_services
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from apps.tutoring.models import TutorJob, TutorSession, TutorTurn
from apps.tutoring.services import core as tutor_services
from apps.tutoring.tasks import run_tutor_job
from tests.integration.test_learning_loop import answer_for, make_pairing
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------
# Shared fixtures / helpers
# --------------------------------------------------------------------------
def _parallel_practice_then_verification(caller, project, subject, qtype="true_false", answer=None):
    """A plain practice attempt, then a verification on the same content.

    This is the C01 shape: the score was legitimately delivered once, and the
    verification that starts afterwards must close every door to it again.
    """
    version = published(subject, qtype)
    practice = start_session(caller, project, subject, version.question, key="before-practice")
    item_id = practice["items"][0]["session_item_id"]
    present(caller, project, item_id)
    answer = answer or {"type": "true_false", "value": True}
    result = submit(caller, project, item_id, answer, key="before-submit")
    assert result.status_code == 200, result.content
    verification = start_session(
        caller, project, subject, version.question, mode="verification", key="after-verification"
    )
    present(caller, project, verification["items"][0]["session_item_id"])
    return practice, item_id, result.json(), answer, verification


def _service_attempt(project, subject, version, delivered, submitted):
    session = session_services.create_session(
        user=project.owner, project=project, subject=subject, question_ids=[str(version.question_id)]
    )
    item = session.items.get()
    session_services.presentation(item=item, user=project.owner, now=delivered)
    attempt, _ = attempt_services.submit_attempt(
        session_item_id=str(item.id), user=project.owner, raw_answer=answer_for(version), now=submitted
    )
    return item, attempt


def _new_key(version, number, value, owner):
    return AnswerKeyVersion.objects.create(
        question_version=version,
        version=number,
        answer_payload={"type": "true_false", "value": value},
        verification_status="checked",
        checked_by=owner,
    )


# --------------------------------------------------------------------------
# C01 — one content gate for every delivery and every idempotent replay
# --------------------------------------------------------------------------
def test_existing_parallel_session_must_hide_score(caller, project_a, subject_a1):
    practice, _item_id, submitted, _answer, _verification = _parallel_practice_then_verification(
        caller, project_a, subject_a1
    )
    assert caller.get(
        f"/api/v1/projects/{project_a.id}/attempts/{submitted['attempt_id']}"
    ).status_code == 403
    response = caller.get(f"/api/v1/projects/{project_a.id}/practice-sessions/{practice['session_id']}")
    payload = response.json()
    assert response.status_code == 403 or (
        payload.get("confirmed_score") is None and payload["items"][0]["attempt"]["grade"] is None
    ), payload


def test_idempotent_submit_must_recheck_gate(caller, project_a, subject_a1):
    _practice, item_id, _submitted, answer, _verification = _parallel_practice_then_verification(
        caller, project_a, subject_a1
    )
    replay = submit(caller, project_a, item_id, answer, key="before-submit")
    assert replay.status_code == 403 or replay.json().get("grade") is None, replay.json()


def test_evidence_of_parallel_attempt_must_be_hidden(caller, project_a, subject_a1):
    _practice, _item_id, submitted, _answer, _verification = _parallel_practice_then_verification(
        caller, project_a, subject_a1
    )
    rebuild_for_attempt(submitted["attempt_id"])
    response = caller.get(f"/api/v1/projects/{project_a.id}/evidence")
    assert response.status_code == 200
    leaked = [row for row in response.json()["rows"] if row["attempt_id"] == submitted["attempt_id"]]
    assert not leaked, leaked


def test_pending_parallel_grade_queue_must_hide_score_and_rubric(caller, project_a, subject_a1):
    _practice, _item_id, submitted, _answer, _verification = _parallel_practice_then_verification(
        caller,
        project_a,
        subject_a1,
        qtype="constructed_response",
        answer={"type": "constructed_response", "text": "my work"},
    )
    response = caller.get(f"/api/v1/projects/{project_a.id}/grading-queue")
    assert response.status_code == 200
    leaked = [row for row in response.json() if row["attempt_id"] == submitted["attempt_id"]]
    assert not leaked, leaked


def test_idempotent_tutor_message_must_recheck_gate(caller, project_a, subject_a1):
    version = published(subject_a1, "true_false")
    practice = start_session(caller, project_a, subject_a1, version.question, key="tutor-practice")
    item_id = practice["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    opened = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": item_id, "purpose": "explanation"},
        key="tutor-open",
    )
    assert opened.status_code == 201
    tutor_id = opened.json()["tutor_session_id"]
    url = f"/api/v1/projects/{project_a.id}/tutor-sessions/{tutor_id}/messages"
    body = {"user_question": "请讲解此题"}
    asked = caller.post(url, body, key="tutor-message")
    assert asked.status_code == 201 and asked.json()["result_blocks"], asked.content
    verification = start_session(
        caller, project_a, subject_a1, version.question, mode="verification", key="tutor-verification"
    )
    present(caller, project_a, verification["items"][0]["session_item_id"])
    assert caller.get(
        f"/api/v1/projects/{project_a.id}/tutor-jobs/{asked.json()['tutor_job_id']}"
    ).status_code == 403
    replay = caller.post(url, body, key="tutor-message")
    assert replay.status_code == 403 or not replay.json().get("result_blocks"), replay.json()


def test_gate_lifts_when_the_verification_finishes(caller, project_a, subject_a1):
    """Hiding is not permission: once the verification is over the result returns."""
    practice, item_id, submitted, answer, verification = _parallel_practice_then_verification(
        caller, project_a, subject_a1
    )
    finished = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions/{verification['session_id']}/finish",
        {},
        key="finish-verification",
    )
    assert finished.status_code == 200, finished.content
    assert caller.get(
        f"/api/v1/projects/{project_a.id}/attempts/{submitted['attempt_id']}"
    ).status_code == 200
    session = caller.get(f"/api/v1/projects/{project_a.id}/practice-sessions/{practice['session_id']}")
    assert session.status_code == 200
    assert session.json()["confirmed_score"] is not None
    # And the idempotent replay delivers the real grade again, from current state.
    replay = submit(caller, project_a, item_id, answer, key="before-submit")
    assert replay.status_code == 200 and replay.json()["grade"] is not None, replay.json()


def test_idempotency_contract_is_unchanged_by_the_gate(caller, project_a, subject_a1):
    """Same key + same payload replays; a different payload is still a 409."""
    version = published(subject_a1, "true_false")
    practice = start_session(caller, project_a, subject_a1, version.question, key="idem-practice")
    item_id = practice["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    first = submit(caller, project_a, item_id, {"type": "true_false", "value": True}, key="idem-submit")
    assert first.status_code == 200, first.content
    again = submit(caller, project_a, item_id, {"type": "true_false", "value": True}, key="idem-submit")
    assert again.status_code == 200
    assert again.json()["attempt_id"] == first.json()["attempt_id"]
    other = submit(caller, project_a, item_id, {"type": "true_false", "value": False}, key="idem-submit")
    assert other.status_code == 409, other.content
    assert Attempt.objects.filter(session_item_id=item_id).count() == 1


# --------------------------------------------------------------------------
# C02 — generation ordering on every branch, and an honest migration
# --------------------------------------------------------------------------
def test_old_disputed_regrade_cannot_invalidate_a_newer_trusted_grade(project_a, subject_a1):
    version = published(subject_a1, "true_false")
    now = timezone.now()
    item, attempt = _service_attempt(project_a, subject_a1, version, now - timedelta(minutes=1), now)
    original_value = item.answer_key_version.answer_payload["value"]
    v2 = _new_key(version, 2, not original_value, project_a.owner)
    v3 = _new_key(version, 3, original_value, project_a.owner)
    old = request_regrade(
        question=version.question, target_answer_key_version=v2, actor=project_a.owner, reason="older queued target"
    )
    new = request_regrade(
        question=version.question, target_answer_key_version=v3, actor=project_a.owner, reason="new valid target"
    )
    execute_regrade_run(str(new.id))
    attempt.refresh_from_db()
    prior_id = attempt.current_grade_event_id
    assert attempt.current_grade_event.answer_key_version_id == v3.id
    content_services.dispute_answer_key_version(v2, actor=project_a.owner, reason="only obsolete v2 wrong")
    execute_regrade_run(str(old.id))
    attempt.refresh_from_db()
    old.refresh_from_db()
    assert attempt.current_grade_event_id == prior_id, "旧争议 run 不得撤销较新的有效评分"
    assert attempt.current_grade_event.answer_key_version_id == v3.id
    assert attempt.current_grade_event.status == "confirmed"
    # The refusal is still recorded, and it says what it deliberately left alone.
    assert old.status == "failed"
    assert old.stale_skipped_attempts == 1
    assert old.invalidated_evidence == 0


def _ambiguous_legacy_state(project, subject, version, item):
    """Reproduce the reachable pre-0004 state: a duplicate gen=1 plus an applied gen=2."""
    v2 = _new_key(version, 2, not item.answer_key_version.answer_payload["value"], project.owner)
    v3 = _new_key(version, 3, item.answer_key_version.answer_payload["value"], project.owner)
    _reset_to_pre_0004_schema()
    common = {
        "user": project.owner,
        "project": project,
        "subject": subject,
        "question": version.question,
        "requested_by": project.owner,
    }
    RegradeRun.objects.create(
        **common, target_answer_key_version=item.answer_key_version, generation=1, status="succeeded", reason="first old run"
    )
    stale = RegradeRun.objects.create(
        **common, target_answer_key_version=v2, generation=1, reason="concurrent duplicate remains queued"
    )
    latest = RegradeRun.objects.create(
        **common, target_answer_key_version=v3, generation=2, reason="latest valid request"
    )
    return v2, v3, stale, latest


def _reset_to_pre_0004_schema():
    """Drop only the 0004 artifacts, inside the test's transaction.

    The point of the refusals below is that the migration creates *nothing*, so the
    pre-migration schema has to be reproduced first. Every statement here is rolled
    back by pytest; no business database is ever touched.
    """
    with connection.cursor() as cursor:
        # Django's TestCase defers FK checks; PostgreSQL refuses ALTER TABLE while
        # trigger events are pending, so flush them first (as the archived
        # counter-example does). Every statement here is rolled back by pytest.
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        cursor.execute(
            "ALTER TABLE analytics_regrade_run DROP CONSTRAINT IF EXISTS uniq_regrade_question_generation"
        )
        cursor.execute("DROP SEQUENCE IF EXISTS analytics_regrade_generation_seq")


def test_generation_migration_refuses_ambiguous_history(project_a, subject_a1):
    """A history whose order cannot be recovered is refused, not renumbered.

    Renumbering the duplicate from the sequence would hand an old queued run a
    number above the already-applied generation 2 and let it overwrite a valid
    newer grade. The migration therefore stops, lists exactly what it found, and
    leaves no partial modification behind (C02).
    """
    version = published(subject_a1, "true_false")
    now = timezone.now()
    item, attempt = _service_attempt(project_a, subject_a1, version, now - timedelta(minutes=1), now)
    _v2, v3, stale, latest = _ambiguous_legacy_state(project_a, subject_a1, version, item)
    execute_regrade_run(str(latest.id))
    attempt.refresh_from_db()
    assert attempt.applied_regrade_generation == 2
    assert attempt.current_grade_event.answer_key_version_id == v3.id

    mod = importlib.import_module("apps.analytics.migrations.0004_p0_2_regrade_generation_sequence")
    schema_editor = SimpleNamespace(connection=connection)
    with pytest.raises(mod.AmbiguousRegradeGenerationHistory) as excinfo:
        # A savepoint, so the refusal cannot poison this test's transaction and
        # "nothing was left behind" can actually be checked.
        with transaction.atomic():
            mod.assert_unambiguous_history(None, schema_editor)
    message = str(excinfo.value)
    assert str(stale.id) in message, "清单必须列出无法排序的那一行"
    assert f"question={version.question_id}" in message
    assert "generation=1" in message and "question_max_generation=2" in message
    assert str(latest.id) not in message, "清单只列歧义行，不把已应用的新代次当成待处理项"
    assert "migrate" in message  # actionable: says what to do next

    # No partial modification: the 0004 artifacts are still absent and no stored
    # row was rewritten.
    assert not _sequence_exists(mod.SEQUENCE)
    assert not _constraint_exists("uniq_regrade_question_generation")
    stale.refresh_from_db()
    latest.refresh_from_db()
    assert (stale.generation, latest.generation) == (1, 2), "被拒绝的迁移不得改写任何历史行"

    # And the ordering the migration refused to guess at is still not violated at
    # runtime: the old queued run cannot jump above the applied generation.
    execute_regrade_run(str(stale.id))
    attempt.refresh_from_db()
    assert attempt.current_grade_event.answer_key_version_id == v3.id
    assert attempt.applied_regrade_generation == 2


def test_unambiguous_history_migrates_and_keeps_generations_unique(project_a, subject_a1):
    """The safe path still works: sequence above MAX, constraint added, no renumbering."""
    version = published(subject_a1, "true_false")
    now = timezone.now()
    item, _attempt = _service_attempt(project_a, subject_a1, version, now - timedelta(minutes=1), now)
    _reset_to_pre_0004_schema()
    v2 = _new_key(version, 2, not item.answer_key_version.answer_payload["value"], project_a.owner)
    v3 = _new_key(version, 3, item.answer_key_version.answer_payload["value"], project_a.owner)
    common = {
        "user": project_a.owner,
        "project": project_a,
        "subject": subject_a1,
        "question": version.question,
        "requested_by": project_a.owner,
    }
    first = RegradeRun.objects.create(**common, target_answer_key_version=v2, generation=1, reason="old")
    second = RegradeRun.objects.create(**common, target_answer_key_version=v3, generation=2, reason="new")
    mod = importlib.import_module("apps.analytics.migrations.0004_p0_2_regrade_generation_sequence")
    schema_editor = SimpleNamespace(connection=connection)
    mod.assert_unambiguous_history(None, schema_editor)
    mod.create_sequence_and_position(None, schema_editor)
    with connection.cursor() as cursor:
        cursor.execute(
            "ALTER TABLE analytics_regrade_run "
            "ADD CONSTRAINT uniq_regrade_question_generation UNIQUE (question_id, generation)"
        )
    first.refresh_from_db()
    second.refresh_from_db()
    assert (first.generation, second.generation) == (1, 2), "无歧义历史不得被改写"
    assert _sequence_exists(mod.SEQUENCE)
    assert _constraint_exists("uniq_regrade_question_generation")
    assert RegradeRun.allocate_generation() > 2, "序列必须从 MAX(generation)+1 起分配"


def _sequence_exists(name: str) -> bool:
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass(%s)", [name])
        return cursor.fetchone()[0] is not None


def _constraint_exists(name: str) -> bool:
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_constraint WHERE conname = %s", [name])
        return cursor.fetchone() is not None


# --------------------------------------------------------------------------
# C03 — the delayed interval is judged at first presentation
# --------------------------------------------------------------------------
def _delayed_dimension(project, subject_a1, node_id, attempt):
    return next(
        row
        for row in compute_dimensions(attempt)
        if row["dimension"] == "delayed_verification" and row["node"].id == node_id
    )


def test_delayed_credit_cannot_be_earned_by_opening_early_and_submitting_late(project_a, subject_a1):
    pair, _a, b, c = make_pairing(subject_a1)
    for version in (b, c):
        content_services.replace_knowledge_mappings(
            version,
            [{"node_id": str(pair.node_id), "is_primary": True, "score_weight": "1"}],
            actor=project_a.owner,
        )
    now = timezone.now()
    # B completes 25h ago; C is first presented 23h later and submitted at 25h.
    _service_attempt(project_a, subject_a1, b, now - timedelta(hours=25, minutes=1), now - timedelta(hours=25))
    item_c, attempt_c = _service_attempt(project_a, subject_a1, c, now - timedelta(hours=2), now)
    dimension = _delayed_dimension(project_a, subject_a1, pair.node_id, attempt_c)
    assert dimension["qualifies"] is False
    assert item_c.first_delivered_at < attempt_c.submitted_at
    assert dimension["detail"]["delay_evaluated_from"] == "first_presentation"


def test_delayed_credit_is_earned_when_the_interval_is_met_at_first_presentation(project_a, subject_a1):
    pair, _a, b, c = make_pairing(subject_a1)
    for version in (b, c):
        content_services.replace_knowledge_mappings(
            version,
            [{"node_id": str(pair.node_id), "is_primary": True, "score_weight": "1"}],
            actor=project_a.owner,
        )
    now = timezone.now()
    # B completes 26h ago and C is first presented 25h later: the interval really
    # was met when the verification started, so the evidence stands.
    _service_attempt(project_a, subject_a1, b, now - timedelta(hours=26, minutes=1), now - timedelta(hours=26))
    _item_c, attempt_c = _service_attempt(project_a, subject_a1, c, now - timedelta(hours=1), now)
    dimension = _delayed_dimension(project_a, subject_a1, pair.node_id, attempt_c)
    assert dimension["qualifies"] is True, dimension
    assert dimension["detail"]["delay_evaluated_from"] == "first_presentation"


# --------------------------------------------------------------------------
# C04 — the business final commit is protected by the lease
# --------------------------------------------------------------------------
def _tutor_job_for(item):
    tutor = TutorSession.objects.create(
        user=item.session.user,
        project=item.session.project,
        practice_session=item.session,
        session_item=item,
        purpose="explanation",
        question_version=item.question_version,
        answer_key_version=item.answer_key_version,
        rubric_version=item.rubric_version,
    )
    job = tutor_services.create_job(tutor_session=tutor, user=item.session.user, user_question="解释本题")
    return job, OutboxEvent.objects.get(dedupe_key=f"tutor-job:{job.id}")


@pytest.mark.django_db(transaction=True)
def test_tutor_retry_after_success_save_restores_exposure(practice_item, monkeypatch):
    """A crash between "result stored" and "facts written" must be recoverable."""
    job, event = _tutor_job_for(practice_item)
    original_create = TutorTurn.objects.create
    monkeypatch.setattr(
        TutorTurn.objects, "create", lambda **kwargs: (_ for _ in ()).throw(SystemExit("crash before exposure"))
    )
    with pytest.raises(SystemExit):
        run_tutor_job(outbox_event_id=str(event.id), **event.payload)
    event.refresh_from_db()
    job.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSING
    assert job.status == "succeeded"
    assert not ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).exists()
    monkeypatch.setattr(TutorTurn.objects, "create", original_create)
    OutboxEvent.objects.filter(id=event.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    run_tutor_job(outbox_event_id=str(event.id), **event.payload)
    event.refresh_from_db()
    job.refresh_from_db()
    assert job.finalized_at is not None
    assert event.status == OutboxStatus.PROCESSED and event.processed_at is not None
    assert TutorTurn.objects.filter(job=job, role="assistant").count() == 1
    assert ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count() == 1, (
        "成功且可读的讲解必须在崩溃重投后保留曝光事实"
    )


@pytest.mark.django_db(transaction=True)
def test_stale_tutor_consumer_cannot_overwrite_after_lease_takeover(practice_item, monkeypatch):
    """The takeover's committed result wins; the late consumer writes nothing."""
    import json

    from ai.providers import base as providers

    job, event = _tutor_job_for(practice_item)
    invocations: list[int] = []

    def call_with_takeover(provider, request, **kwargs):
        number = len(invocations) + 1
        invocations.append(number)
        if number == 1:
            # Deterministic lease expiry/takeover interleaving, not a real clock.
            OutboxEvent.objects.filter(id=event.id).update(
                lease_expires_at=timezone.now() - timedelta(seconds=1)
            )
            run_tutor_job(outbox_event_id=str(event.id), **event.payload)
        payload = {
            "explanation_blocks": [{"kind": "text", "text": f"consumer-{number}"}],
            "citations": [],
            "missing_information": [],
            "suggested_next": [],
        }
        return providers.AiCallResult(payload=payload, raw_text=json.dumps(payload), is_stub=True)

    monkeypatch.setattr(providers, "call_with_deadline", call_with_takeover)
    run_tutor_job(outbox_event_id=str(event.id), **event.payload)
    job.refresh_from_db()
    event.refresh_from_db()
    assert len(invocations) == 2
    assert job.result_blocks[0]["text"] == "consumer-2", "过期消费者不得覆盖接管者已确认的结果"
    assert TutorTurn.objects.filter(job=job, role="assistant").count() == 1
    assert ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count() == 1
    assert event.status == OutboxStatus.PROCESSED


@pytest.mark.django_db(transaction=True)
def test_redelivering_the_same_event_twice_adds_nothing(practice_item):
    """The same event delivered twice: one assistant message, one exposure."""
    job, event = _tutor_job_for(practice_item)
    first = run_tutor_job(outbox_event_id=str(event.id), **event.payload)
    assert first == "succeeded"
    second = run_tutor_job(outbox_event_id=str(event.id), **event.payload)
    assert second in {"succeeded", "skipped_lease_not_held"}
    job.refresh_from_db()
    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSED
    assert TutorTurn.objects.filter(job=job, role="assistant").count() == 1
    assert ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count() == 1
    assert TutorJob.objects.filter(id=job.id).count() == 1


@pytest.mark.django_db(transaction=True)
def test_stale_consumer_cannot_reopen_a_succeeded_job_with_a_failure(practice_item, monkeypatch):
    """A late timeout must not overwrite a takeover's delivered explanation."""
    import json

    from ai.providers import base as providers

    job, event = _tutor_job_for(practice_item)
    calls: list[int] = []

    def provider_fails_after_takeover(provider, request, **kwargs):
        calls.append(1)
        if len(calls) > 1:
            # The takeover's own model call succeeds normally.
            payload = {
                "explanation_blocks": [{"kind": "text", "text": "takeover-result"}],
                "citations": [],
                "missing_information": [],
                "suggested_next": [],
            }
            return providers.AiCallResult(payload=payload, raw_text=json.dumps(payload), is_stub=True)
        # While this consumer is "waiting for the model", its lease expires and a
        # second consumer takes the event over and delivers.
        OutboxEvent.objects.filter(id=event.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
        run_tutor_job(outbox_event_id=str(event.id), **event.payload)
        raise providers.AiUnavailable("provider down")

    monkeypatch.setattr(providers, "call_with_deadline", provider_fails_after_takeover)
    run_tutor_job(outbox_event_id=str(event.id), **event.payload)
    job.refresh_from_db()
    event.refresh_from_db()
    assert len(calls) == 2
    assert event.status == OutboxStatus.PROCESSED
    assert job.status == "succeeded", "旧消费者不得把已交付的任务改回失败"
    assert job.result_blocks[0]["text"] == "takeover-result"
    assert job.error_code == ""
    assert TutorTurn.objects.filter(job=job, role="assistant").count() == 1
    assert ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count() == 1


# --------------------------------------------------------------------------
# G07 positive regression (migrated with the same business assertions)
# --------------------------------------------------------------------------
def test_history_audit_preserves_superseded_and_records_current(practice_item):
    item = practice_item
    attempt, grade = attempt_services.submit_attempt(
        session_item_id=str(item.id),
        user=item.session.user,
        raw_answer={
            "type": "single_choice",
            "selected_option_ids": [item.answer_key_version.answer_payload["correct_option_id"]],
        },
    )
    GradeEvent.objects.filter(id=grade.id).update(is_fully_confirmed=False, pending_max_score=Decimal("9.99"))
    history = GradeEvent.objects.create(
        attempt=attempt,
        grading_revision=2,
        is_superseded=True,
        status="confirmed",
        max_score=grade.max_score,
        confirmed_score=grade.confirmed_score,
        pending_max_score=Decimal("9.99"),
        is_fully_confirmed=False,
        parts=grade.parts,
    )
    call_command("audit_projection_semantics", apply=True)
    grade.refresh_from_db()
    history.refresh_from_db()
    audit = ContentRevision.objects.get(entity_id=str(grade.id), action="projection_semantics_rewrite")
    assert grade.is_fully_confirmed and grade.pending_max_score == 0
    assert history.pending_max_score == Decimal("9.99") and not history.is_fully_confirmed
    assert not ContentRevision.objects.filter(
        entity_id=str(history.id), action="projection_semantics_rewrite"
    ).exists()
    assert audit.detail["before"]["pending_max_score"] == "9.99"
    assert audit.detail["after"]["pending_max_score"] == "0"
    assert audit.detail["batch_id"] and audit.before_digest != audit.after_digest
