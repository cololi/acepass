"""Outbox and Celery topic contract: R11 / F06 made executable.

`docs/06-independent-p0-review.md` §R11 and `docs/07-p0-repair-plan.md` F06 list
the ways one effect could be silently lost:

* a producer emitted ``learning.reconcile_plan`` while no worker registered a
  consumer for it, so the broker discarded the message for good;
* the dispatcher wrote ``dispatched`` over a row the consumer had already
  confirmed as ``processed``, erasing the only proof that the effect happened;
* the recovery scan looked at ``pending`` only, so a Redis flush or a
  PostgreSQL-only restore left every ``dispatched`` row unreachable;
* a killed worker held no recoverable claim, and a failing consumer had no
  attempt budget, so a row was either retried forever or never revisited.

Every case here is asserted against the real state machine in
``apps.audit.services.outbox`` and the real Celery app rather than a copy of the
rules. The produced-topic set is built by AST-parsing every ``enqueue(...)`` call
site (several are multi-line calls a regex would miss), and the registered-topic
set is read from the Celery app *after* the same import-time finalisation a real
worker performs — so a green run means a worker can execute every topic a
producer emits.
"""

from __future__ import annotations

import ast
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from django.utils import timezone

from apps.audit.models import OutboxEvent
from apps.audit.services import outbox
from apps.common.enums import OutboxStatus
from apps.learning.models import ReviewTask, StudyPlan, StudyTask
from apps.learning.services import evidence as evidence_service
from apps.learning.services import planner as planner_service
from apps.practice.models import Attempt, LearningEvidence
from apps.question_bank.models import AnswerKeyVersion
from config import celery as celery_module
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db

BACKEND_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOTS = ("apps", "config")

#: Topics the AST scan must find, so a broken scan cannot make the contract
#: vacuous. ``learning.reconcile_plan`` is the R11 regression: the planner emits
#: it and, before the repair, no worker registered a consumer for it.
EXPECTED_PRODUCER_TOPICS = frozenset(
    {
        "ingestion.extract_candidate",
        "learning.on_attempt_graded",
        "learning.on_session_finished",
        "learning.reconcile_plan",
        "projection.rebuild_after_answer_change",
        "projection.rebuild_attempt_evidence",
        "projection.refresh_paper_stats",
        "projection.regrade_effects",
        "projection.run_regrade",
        "tutoring.run_job",
    }
)

#: A topic no module registers, used to prove the dispatcher never hides one.
UNKNOWN_TOPIC = "test.topic_without_any_consumer"


def _relative(path: Path) -> str:
    return path.relative_to(BACKEND_ROOT).as_posix()


def _module_name(path: Path) -> str:
    return _relative(path).removesuffix(".py").replace("/", ".")


def _source_files() -> list[Path]:
    """Every module the contract covers: ``apps/**`` plus ``config/**``."""
    files: list[Path] = []
    for root in SOURCE_ROOTS:
        files.extend(sorted((BACKEND_ROOT / root).rglob("*.py")))
    return [path for path in files if "__pycache__" not in path.parts]


def _decorator_name(decorator: ast.expr) -> str:
    target = decorator.func if isinstance(decorator, ast.Call) else decorator
    if isinstance(target, ast.Name):
        return target.id
    return getattr(target, "attr", "")


def _decorated_topic_name(decorator: ast.expr, *, module: str, function: str) -> str | None:
    """The task name a ``@shared_task`` / ``@app.task`` decorator registers."""
    if _decorator_name(decorator) not in {"shared_task", "task"}:
        return None
    if isinstance(decorator, ast.Call):
        for keyword in decorator.keywords:
            if keyword.arg == "name":
                assert isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str), (
                    f"{module}.{function}: a task name must be a literal string to be checkable"
                )
                return keyword.value.value
    # Celery's default name for a task that does not pass `name=`.
    return f"{module}.{function}"


def _enqueue_call_sites() -> dict[str, list[str]]:
    """Literal topic -> call sites, parsed from the AST of every producer."""
    sites: dict[str, list[str]] = {}
    for path in _source_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name != "enqueue":
                continue
            topic = node.args[0]
            assert isinstance(topic, ast.Constant) and isinstance(topic.value, str), (
                f"{_relative(path)}:{node.lineno}: enqueue() must be called with a literal topic "
                "string, otherwise the producer/consumer contract cannot be checked"
            )
            sites.setdefault(topic.value, []).append(f"{_relative(path)}:{node.lineno}")
    return sites


def _registered_topics_as_a_worker_sees_them() -> set[str]:
    """Task names registered once a worker has imported its consumer modules."""
    celery_module.app.loader.import_default_modules()
    return celery_module.registered_topics()


def _task_registrations() -> dict[str, list[str]]:
    """Task name -> the modules that register it."""
    registrations: dict[str, list[str]] = {}
    for path in _source_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for decorator in node.decorator_list:
                topic = _decorated_topic_name(decorator, module=_module_name(path), function=node.name)
                if topic is not None:
                    registrations.setdefault(topic, []).append(f"{_relative(path)}:{node.lineno}")
    return registrations


def _consumer_modules() -> dict[str, list[str]]:
    """``apps.<app>.tasks`` modules that define at least one ``@shared_task``."""
    modules: dict[str, list[str]] = {}
    for path in sorted((BACKEND_ROOT / "apps").glob("*/tasks.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        consumers = [
            node.name
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
            and any(_decorator_name(decorator) == "shared_task" for decorator in node.decorator_list)
        ]
        if consumers:
            modules[_module_name(path)] = consumers
    return modules


def _beat_task_name(entry: dict) -> object:
    return getattr(entry.get("task"), "name", entry.get("task"))


def _redeliverable(event: OutboxEvent) -> OutboxEvent:
    """Clear a confirmed row's proof, as a Redis flush / restored backup would."""
    OutboxEvent.objects.filter(id=event.id).update(
        status=OutboxStatus.PENDING,
        processed_at=None,
        claimed_at=None,
        claim_token="",
        lease_expires_at=None,
        available_at=timezone.now() - timedelta(seconds=1),
    )
    event.refresh_from_db()
    assert event.status == OutboxStatus.PENDING and event.processed_at is None
    return event


# --------------------------------------------------------------- topic registry
def test_every_produced_topic_has_a_registered_consumer():
    produced = _enqueue_call_sites()
    assert EXPECTED_PRODUCER_TOPICS <= set(produced), (
        "the AST scan no longer sees producers that exist in the tree: "
        f"{sorted(EXPECTED_PRODUCER_TOPICS - set(produced))}"
    )

    registered = _registered_topics_as_a_worker_sees_them()
    unregistered = {topic: sites for topic, sites in produced.items() if topic not in registered}
    assert not unregistered, "producers emit topics no worker registers a consumer for (R11):\n" + "\n".join(
        f"  {topic} <- {', '.join(sites)}" for topic, sites in sorted(unregistered.items())
    )

    declared = celery_module.producer_topics()
    undeclared = {topic: sites for topic, sites in produced.items() if topic not in declared}
    assert not undeclared, (
        "enqueue() emits topics missing from config.celery.producer_topics():\n"
        + "\n".join(f"  {topic} <- {', '.join(sites)}" for topic, sites in sorted(undeclared.items()))
    )
    stale = declared - set(produced)
    assert not stale, (
        "config.celery.producer_topics() lists topics that no enqueue() call emits "
        f"(the hand-maintained registry drifted): {sorted(stale)}"
    )


def test_no_duplicate_task_names_across_modules():
    registrations = _task_registrations()
    assert {"audit.scan_outbox", "tutoring.run_job"} <= set(registrations), (
        "the scan must see the names whose duplication R11 reported: " f"{sorted(registrations)}"
    )

    duplicates = {topic: sites for topic, sites in registrations.items() if len(sites) > 1}
    assert not duplicates, "the same task name is registered from several modules:\n" + "\n".join(
        f"  {topic}: {', '.join(sites)}" for topic, sites in sorted(duplicates.items())
    )


def test_beat_schedule_and_imports_cover_every_consumer():
    beat = celery_module.app.conf.beat_schedule
    assert beat, "beat_schedule must not be empty, or nothing re-dispatches a lost event"

    registered = _registered_topics_as_a_worker_sees_them()
    scanners = [name for name, entry in beat.items() if _beat_task_name(entry) == "audit.scan_outbox"]
    assert scanners, f"beat_schedule has no audit.scan_outbox scanner: {sorted(beat)}"

    for name, entry in sorted(beat.items()):
        task_name = _beat_task_name(entry)
        assert task_name in registered, (
            f"beat entry {name!r} targets {task_name!r}, which no worker registers"
        )
        schedule = entry.get("schedule")
        assert isinstance(schedule, int | float) and not isinstance(schedule, bool), (
            f"beat entry {name!r} needs a numeric period, got {schedule!r}"
        )
        assert schedule > 0, f"beat entry {name!r} has a non-positive period {schedule!r}"

    consumers = _consumer_modules()
    assert consumers, "no @shared_task consumer module found; the import check would be vacuous"
    imported = set(celery_module.app.conf.imports or ())
    missing = {module: names for module, names in consumers.items() if module not in imported}
    assert not missing, (
        "app.conf.imports misses modules that define consumers, so a real worker "
        "would never execute them:\n"
        + "\n".join(f"  {module}: {', '.join(names)}" for module, names in sorted(missing.items()))
    )


# ------------------------------------------------------- dispatcher state machine
def test_inline_dispatch_confirms_with_processed_at_and_never_downgrades(project_a):
    assert outbox.inline_mode(), "these cases pin the in-process dispatcher used by tests and demo mode"

    plan = StudyPlan.objects.create(
        user=project_a.owner,
        plan_date=timezone.localdate(),
        revision=1,
        daily_budget_minutes=60,
        generated_at=timezone.now(),
    )
    # The real producer: this is the emit site R11 caught with no consumer.
    planner_service.enqueue_plan_event(plan)
    event = OutboxEvent.objects.get(topic="learning.reconcile_plan")
    assert event.status == OutboxStatus.PENDING and event.processed_at is None

    outbox.after_commit_dispatch()

    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSED
    assert event.processed_at is not None
    # The original bug: the dispatcher wrote `dispatched` over the consumer's own
    # confirmation, so no reader could tell the effect had happened.
    assert event.status != OutboxStatus.DISPATCHED
    assert event.claimed_at is None and event.claim_token == "" and event.lease_expires_at is None
    plan.refresh_from_db()
    assert len(plan.notes) == 1 and "计划核对" in plan.notes[0], "the consumer itself must have run"
    assert outbox.unresolved_summary() == {}


def test_redis_flush_recovery_redelivers_a_dispatched_row():
    event = outbox.enqueue("projection.rebuild_attempt_evidence", {"attempt_id": str(uuid.uuid4())})
    outbox.after_commit_dispatch()
    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSED and event.processed_at is not None

    # Redis was flushed (or the database was restored from a PostgreSQL-only
    # backup): the broker accepted the message, the consumer never ran, and the
    # row kept its delivery lease until it expired.
    expired = timezone.now() - timedelta(minutes=1)
    OutboxEvent.objects.filter(id=event.id).update(
        status=OutboxStatus.DISPATCHED,
        processed_at=None,
        dispatched_at=expired,
        claimed_at=None,
        claim_token="",
        lease_expires_at=expired,
        available_at=expired,
    )
    event.refresh_from_db()
    assert event.status == OutboxStatus.DISPATCHED, "the row must start where the pending-only scanner gave up"
    assert OutboxStatus.DISPATCHED in outbox.RECOVERABLE_STATUSES
    assert OutboxEvent.objects.filter(outbox.lease_available_q()).filter(id=event.id).exists()

    assert outbox.dispatch_pending() == 1
    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSED
    assert event.processed_at is not None
    assert outbox.unresolved_summary() == {}


def test_killed_worker_lease_expiry_is_recovered():
    event = outbox.enqueue("projection.rebuild_attempt_evidence", {"attempt_id": str(uuid.uuid4())})

    claim = outbox.claim_event(str(event.id))
    assert claim is not None
    assert claim.status == OutboxStatus.PROCESSING and claim.claim_token
    assert claim.lease_expires_at > timezone.now()
    # A live lease is exclusive: a second consumer must be refused the row.
    assert outbox.claim_event(str(event.id)) is None
    assert outbox.unresolved_summary() == {OutboxStatus.PROCESSING: 1}

    # The worker is killed mid-task. Nothing confirms, so the lease expires —
    # written directly here, which is the same state `lease_seconds=-1` reaches.
    # The retry window is kept in the future on purpose, so the release can be
    # observed on its own before the next delivery becomes due.
    retry_at = timezone.now() + timedelta(hours=1)
    OutboxEvent.objects.filter(id=event.id).update(
        lease_expires_at=timezone.now() - timedelta(seconds=1), available_at=retry_at
    )
    takeover = outbox.claim_event(str(event.id), lease_seconds=-1)
    assert takeover is not None, "an expired lease must never keep blocking the next consumer"
    assert takeover.claim_token != claim.claim_token
    assert takeover.lease_expires_at <= timezone.now()

    assert outbox.recover_stale() >= 1
    event.refresh_from_db()
    assert event.status == OutboxStatus.PENDING, "the dead worker's claim must be released back to the queue"
    assert event.processed_at is None
    assert event.claimed_at is None and event.claim_token == "" and event.lease_expires_at is None
    assert event.last_error, "the release is visible to an operator"

    # Once the retry is due, the ordinary scan finishes it.
    OutboxEvent.objects.filter(id=event.id).update(available_at=timezone.now() - timedelta(seconds=1))
    assert outbox.dispatch_pending() == 1
    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSED
    assert event.processed_at is not None
    assert outbox.unresolved_summary() == {}


def test_attempt_cap_backoff_and_dedupe_rearm(monkeypatch, settings):
    settings.OUTBOX_MAX_ATTEMPTS = 2
    settings.OUTBOX_BACKOFF_SECONDS = 30

    failing = {"on": True}

    def flaky_rebuild(_attempt_id: str) -> int:
        if failing["on"]:
            raise RuntimeError("consumer exploded")
        return 0

    monkeypatch.setattr(evidence_service, "rebuild_for_attempt", flaky_rebuild)

    topic = "projection.rebuild_attempt_evidence"
    dedupe_key = f"evidence:{uuid.uuid4()}"
    event = outbox.enqueue(topic, {"attempt_id": str(uuid.uuid4())}, dedupe_key=dedupe_key)
    assert event.max_attempts == 2

    enqueued_at = timezone.now()
    outbox.after_commit_dispatch()
    event.refresh_from_db()
    assert event.status == OutboxStatus.PENDING, "a retryable failure goes back to the queue"
    assert event.attempts == 1
    assert event.processed_at is None
    assert event.available_at > enqueued_at, "backoff must move the next attempt into the future"
    assert "consumer exploded" in event.last_error
    assert event.claimed_at is None and event.lease_expires_at is None

    # The backoff elapses and the consumer fails again: the budget is a cap.
    OutboxEvent.objects.filter(id=event.id).update(available_at=timezone.now() - timedelta(seconds=1))
    outbox.after_commit_dispatch()
    event.refresh_from_db()
    assert event.status == OutboxStatus.FAILED
    assert event.attempts == event.max_attempts == 2
    assert event.processed_at is None
    assert OutboxStatus.FAILED not in outbox.RECOVERABLE_STATUSES

    # An exhausted row is not re-delivered even when it is due again.
    OutboxEvent.objects.filter(id=event.id).update(available_at=timezone.now() - timedelta(minutes=1))
    assert outbox.dispatch_pending() == 0
    event.refresh_from_db()
    assert event.status == OutboxStatus.FAILED and event.processed_at is None

    # A fresh enqueue from the same business action re-arms it: a dedupe hit on
    # an effect that never happened is not a dead no-op.
    again = outbox.enqueue(topic, {"attempt_id": str(uuid.uuid4())}, dedupe_key=dedupe_key)
    assert again.id == event.id, "the dedupe key must resolve to the exhausted row"
    again.refresh_from_db()
    assert again.status == OutboxStatus.PENDING
    assert again.attempts == 0
    assert again.last_error == ""
    assert again.available_at <= timezone.now()
    assert again.is_recoverable is True

    failing["on"] = False
    assert outbox.dispatch_pending() == 1
    again.refresh_from_db()
    assert again.status == OutboxStatus.PROCESSED and again.processed_at is not None

    # A dedupe hit on an effect that really did happen stays a no-op.
    processed_at = again.processed_at
    third = outbox.enqueue(topic, {"attempt_id": str(uuid.uuid4())}, dedupe_key=dedupe_key)
    third.refresh_from_db()
    assert third.id == again.id
    assert third.status == OutboxStatus.PROCESSED and third.processed_at == processed_at


def test_unknown_topic_is_reported_not_silently_lost():
    assert UNKNOWN_TOPIC not in _registered_topics_as_a_worker_sees_them()

    event = outbox.enqueue(UNKNOWN_TOPIC, {"payload": "unconsumed"})
    outbox.after_commit_dispatch()
    event.refresh_from_db()
    assert event.status != OutboxStatus.PROCESSED
    assert event.processed_at is None, "an unhandled topic must never look done"
    assert UNKNOWN_TOPIC in event.last_error
    assert event.status in {OutboxStatus.PENDING, OutboxStatus.FAILED}
    assert outbox.unresolved_summary() == {event.status: 1}, "an operator must be able to find the row"

    # Even with its retry due, the row is never rewritten into a success.
    OutboxEvent.objects.filter(id=event.id).update(available_at=timezone.now() - timedelta(hours=1))
    outbox.dispatch_pending()
    outbox.after_commit_dispatch()
    event.refresh_from_db()
    assert event.status != OutboxStatus.PROCESSED
    assert event.processed_at is None
    assert UNKNOWN_TOPIC in event.last_error


# ------------------------------------------------------------- consumer contracts
def test_redelivered_consumers_do_not_double_their_effect(caller, project_a, subject_a1):
    version = published(subject_a1, "single_choice")
    session = start_session(caller, project_a, subject_a1, version.question, key="outbox-redelivery")
    item_id = session["items"][0]["session_item_id"]
    present(caller, project_a, item_id)
    correct = AnswerKeyVersion.objects.get(
        question_version=version, verification_status="checked", is_disputed=False
    ).answer_payload["correct_option_id"]
    response = submit(
        caller,
        project_a,
        item_id,
        {"type": "single_choice", "selected_option_ids": [correct]},
        key="outbox-redelivery-1",
    )
    assert response.status_code == 200, response.content
    assert response.json()["grade"]["status"] == "confirmed"

    attempt = Attempt.objects.get(session_item_id=item_id)

    def evidence_signature() -> list[tuple[str, str | None, int]]:
        return sorted(
            LearningEvidence.objects.filter(attempt=attempt).values_list(
                "dimension", "knowledge_node_id", "grade_revision"
            )
        )

    before = evidence_signature()
    assert before, "a graded attempt must have produced evidence before the redelivery"
    nodes = {(node_id, revision) for _dimension, node_id, revision in before}
    assert len(before) == len(nodes) * len(evidence_service.ALL_DIMENSIONS), (
        "one evidence row per (attempt, knowledge node, dimension, grading revision)"
    )

    events = []
    for topic in ("projection.rebuild_attempt_evidence", "learning.on_attempt_graded"):
        row = OutboxEvent.objects.filter(topic=topic, payload__attempt_id=str(attempt.id)).first()
        assert row is not None, f"{topic} was never enqueued for attempt {attempt.id}"
        assert row.status == OutboxStatus.PROCESSED and row.processed_at is not None
        events.append(_redeliverable(row))

    task_counts = (StudyTask.objects.count(), ReviewTask.objects.count())
    assert outbox.dispatch_pending() >= len(events)
    assert outbox.unresolved_summary() == {}
    # The same row was delivered a second time; nothing was applied twice.
    assert evidence_signature() == before
    assert (StudyTask.objects.count(), ReviewTask.objects.count()) == task_counts
    for event in events:
        event.refresh_from_db()
        assert event.status == OutboxStatus.PROCESSED and event.processed_at is not None


def test_consumer_reported_failure_is_not_confirmed_by_the_dispatcher():
    # `tutoring.run_job` reports a missing job through `_mark_outbox(ok=False)`
    # and returns normally instead of raising. The dispatcher must respect that
    # verdict: `processed_at` is only ever written for an effect that happened.
    event = outbox.enqueue(
        "tutoring.run_job",
        {
            "tutor_job_id": str(uuid.uuid4()),
            "prompt": "解释一下这道题",
            "citations": [],
            "purpose": "explain",
        },
    )

    outbox.after_commit_dispatch()
    event.refresh_from_db()
    assert event.processed_at is None, "a consumer-reported failure is not a success"
    assert event.status == OutboxStatus.PENDING
    assert "tutor job missing" in event.last_error
    assert event.attempts == 1

    # It stays retryable rather than being silently converted into a success.
    OutboxEvent.objects.filter(id=event.id).update(available_at=timezone.now() - timedelta(seconds=1))
    outbox.dispatch_pending()
    event.refresh_from_db()
    assert event.processed_at is None
    assert event.status == OutboxStatus.PENDING
    assert event.attempts == 2
