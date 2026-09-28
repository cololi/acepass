"""W1 — the dispatcher must not hold the row lock its own consumer needs.

``docs/15`` §7.1 recorded the defect and left it unfixed: ``dispatch_pending``
chose its batch with ``select_for_update(skip_locked=True)`` and then called the
consumer *inside that same transaction*, while every consumer claims the very
same row with ``select_for_update(skip_locked=True)`` through
:func:`outbox.run_leased`. A worker that is faster than the dispatcher's commit
is therefore skipped (``skipped_lease_not_held``), and the event sits at
``dispatched`` with a full lease (300 s by default) until a later scan finds it
again — no loss and no duplicate effect, but a worst case of ~5.5 minutes per
event.

These cases are deterministic and need no broker, no browser and no waiting:

* the "worker" is the **real registered Celery task**, executed on **its own
  thread**. Django keeps one database connection per thread, so the task really
  does run in a second session — the production split between the dispatching
  process and the worker process;
* it runs *inside* the dispatcher's ``send_task`` call, which is exactly the
  interleaving the row lock turned into a skip. There is no sleep and no race to
  win: the worker is guaranteed to be at the lock while the dispatcher's
  transaction is open (before the repair) or after it committed (after it).
"""

from __future__ import annotations

import threading
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.db import connections
from django.utils import timezone

from apps.audit.models import OutboxEvent
from apps.audit.services import outbox
from apps.common.enums import OutboxStatus
from config import celery as celery_module

pytestmark = pytest.mark.django_db(transaction=True)

#: A real producer topic with a real registered consumer (``apps/audit/tasks.py``).
TOPIC = "projection.rebuild_attempt_evidence"
#: Generous bound: a stuck case must fail with a message, not hang the suite.
WORKER_TIMEOUT = 30.0


def _registered_task(topic: str):
    """The consumer a real worker would execute for ``topic``."""
    celery_module.app.loader.import_default_modules()
    task = celery_module.app.tasks.get(topic)
    assert task is not None, f"{topic} has no registered consumer; this case would prove nothing"
    return task


def _start_worker_thread(work) -> tuple[threading.Thread, dict]:
    """Start ``work`` on its own thread, and therefore on its own DB connection.

    This is what makes the case a *second database session*: without it the
    consumer would share the dispatcher's connection and see its own locks.
    """
    outcome: dict = {}

    def target() -> None:
        try:
            outcome.update(work() or {})
        except BaseException as exc:  # noqa: BLE001 - surfaced through the assertion
            outcome["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            connections.close_all()

    thread = threading.Thread(target=target, name="outbox-case-worker")
    thread.start()
    return thread, outcome


def _join_worker_thread(thread: threading.Thread) -> None:
    thread.join(timeout=WORKER_TIMEOUT)
    assert not thread.is_alive(), "the worker thread never finished; the dispatcher may still hold the row lock"


def _run_in_worker_thread(work) -> dict:
    thread, outcome = _start_worker_thread(work)
    _join_worker_thread(thread)
    return outcome


def _consume_with_real_consumer(task, kwargs: dict) -> dict:
    """Run the registered consumer exactly as a worker does (claim, act, confirm)."""
    result = task.apply(kwargs=kwargs, throw=False)
    verdict = result.result if result.state == "SUCCESS" else f"{result.state}: {result.result!r}"
    return {"verdict": verdict}


def _claim(event_id: str) -> str | None:
    row = outbox.claim_event(str(event_id))
    return row.claim_token if row is not None else None


def test_the_delivery_record_is_committed_before_the_message_exists(monkeypatch, settings):
    """The row is free and already leased when the broker is handed the message."""
    settings.ACEPASS_INLINE_TASKS = False
    settings.OUTBOX_LEASE_SECONDS = 300  # production lease: a skipped event waits ~5 minutes

    event = outbox.enqueue(TOPIC, {"attempt_id": str(uuid.uuid4())})
    task = _registered_task(TOPIC)
    at_send: dict = {}
    worker: dict = {}
    handoffs: list[str] = []

    def immediate_broker(topic, kwargs=None, **options):
        # This is the instant the message starts to exist. Anything the
        # dispatcher writes to the row after this point runs while the worker is
        # claiming it, and `select_for_update(skip_locked=True)` then skips the
        # row — the observed "is not claimable by this consumer".
        row = OutboxEvent.objects.get(id=event.id)
        at_send.update(
            {
                "status": row.status,
                "attempts": row.attempts,
                "lease_is_live": row.lease_expires_at is not None and row.lease_expires_at > timezone.now(),
            }
        )
        # A worker that is faster than the dispatcher: it claims the row while
        # the dispatcher is still inside `dispatch_pending`.
        worker.update(_run_in_worker_thread(lambda: _consume_with_real_consumer(task, kwargs or {})))
        handoffs.append(topic)
        return SimpleNamespace(id="outbox-case-message")

    monkeypatch.setattr(celery_module.app, "send_task", immediate_broker)

    dispatched = outbox.dispatch_pending()
    event.refresh_from_db()
    observed = {
        "dispatch_pending_returned": dispatched,
        "at_send": at_send,
        "worker": worker,
        "handoffs": handoffs,
        "status": event.status,
        "processed_at": str(event.processed_at),
        "attempts": event.attempts,
        "lease_expires_at": str(event.lease_expires_at),
    }
    assert at_send == {"status": OutboxStatus.DISPATCHED, "attempts": 1, "lease_is_live": True}, (
        "the delivery record (dispatched + attempt + lease) must be committed before the broker "
        f"is called: {observed!r}. A record written after `send_task` locks the row while the "
        "worker claims it, and the event then stays unconfirmed until the lease expires."
    )
    assert worker.get("verdict") == "evidence_rows=0", (
        "the consumer was skipped by the dispatcher's own row lock (docs/15 §7.1): "
        f"{observed!r}. The event stays unconfirmed with a {settings.OUTBOX_LEASE_SECONDS}s lease, so the "
        "effect only happens after that lease expires and a later scan re-delivers it."
    )
    assert event.processed_at is not None, f"processed_at is the only completion proof: {observed!r}"
    assert event.status == OutboxStatus.PROCESSED, observed
    assert event.lease_expires_at is None, observed
    assert event.claim_token == "", observed


def test_a_broker_failure_counts_exactly_one_attempt(monkeypatch, settings):
    """A failed hand-off must not eat two attempts of the retry budget."""
    settings.ACEPASS_INLINE_TASKS = False
    settings.OUTBOX_MAX_ATTEMPTS = 3
    settings.OUTBOX_BACKOFF_SECONDS = 30

    event = outbox.enqueue(TOPIC, {"attempt_id": str(uuid.uuid4())})

    def broken_broker(topic, kwargs=None, **options):
        raise ConnectionError("broker is down")

    monkeypatch.setattr(celery_module.app, "send_task", broken_broker)

    assert outbox.dispatch_pending() == 0
    event.refresh_from_db()
    observed = {
        "status": event.status,
        "attempts": event.attempts,
        "available_at": str(event.available_at),
        "lease_expires_at": str(event.lease_expires_at),
        "claim_token": event.claim_token,
        "last_error": event.last_error,
    }
    assert event.attempts == 1, f"one failed delivery is one attempt: {observed!r}"
    assert event.status == OutboxStatus.PENDING, observed
    assert event.available_at > timezone.now(), f"the backoff must postpone the next attempt: {observed!r}"
    assert event.lease_expires_at is None and event.claim_token == "", observed
    assert "broker is down" in event.last_error, observed
    assert event.processed_at is None, observed


def test_inline_mode_keeps_finishing_the_event_in_the_same_round(settings):
    """The in-process path (tests/demo) must keep its single-round behaviour."""
    settings.ACEPASS_INLINE_TASKS = True

    event = outbox.enqueue(TOPIC, {"attempt_id": str(uuid.uuid4())})

    assert outbox.dispatch_pending() == 1
    event.refresh_from_db()
    observed = {
        "status": event.status,
        "processed_at": str(event.processed_at),
        "claim_token": event.claim_token,
        "lease_expires_at": str(event.lease_expires_at),
    }
    assert event.status == OutboxStatus.PROCESSED and event.processed_at is not None, observed
    assert event.claim_token == "" and event.lease_expires_at is None, observed
    assert outbox.unresolved_summary() == {}, "nothing may be left behind for the scanner"
    assert outbox.dispatch_pending() == 0, "a confirmed event is never handed out again"


def test_a_second_scan_cannot_hand_out_an_event_the_first_scan_is_still_delivering(monkeypatch, settings):
    """Releasing the lock before the hand-off must not allow a duplicate delivery."""
    settings.ACEPASS_INLINE_TASKS = False

    event = outbox.enqueue(TOPIC, {"attempt_id": str(uuid.uuid4())})
    handoffs: list[str] = []
    sending = threading.Event()
    release = threading.Event()

    def slow_broker(topic, kwargs=None, **options):
        handoffs.append(topic)
        if threading.current_thread() is threading.main_thread():
            # Hold the hand-off open: this is the window the row lock used to cover.
            sending.set()
            assert release.wait(timeout=WORKER_TIMEOUT), "the probe never released the hand-off"
        return SimpleNamespace(id="outbox-case-message")

    def probe_scan() -> dict:
        try:
            assert sending.wait(timeout=WORKER_TIMEOUT), "the first scan never reached the broker"
            return {"dispatch_pending": outbox.dispatch_pending()}
        finally:
            release.set()

    monkeypatch.setattr(celery_module.app, "send_task", slow_broker)
    probe_thread, probe = _start_worker_thread(probe_scan)
    try:
        first = outbox.dispatch_pending()
    finally:
        release.set()  # never leave the probe waiting if the first scan raised
    _join_worker_thread(probe_thread)
    event.refresh_from_db()
    observed = {"first": first, "probe": probe, "handoffs": handoffs, "event_attempts": event.attempts}

    assert probe.get("error") is None, observed
    assert probe.get("dispatch_pending") == 0, f"the same event was handed out twice: {observed!r}"
    assert handoffs == [TOPIC], observed
    assert first == 1, observed
    assert event.status == OutboxStatus.DISPATCHED and event.attempts == 1, observed
    assert event.lease_expires_at is not None and event.lease_expires_at > timezone.now(), observed


def test_a_claim_taken_before_the_delivery_write_is_never_clobbered(monkeypatch, settings):
    """The consumer owns ``status``/``claim_token`` once it has claimed the row."""
    settings.ACEPASS_INLINE_TASKS = False

    event = outbox.enqueue(TOPIC, {"attempt_id": str(uuid.uuid4())})
    claimed: dict = {}

    def broker_that_claims(topic, kwargs=None, **options):
        claimed.update(_run_in_worker_thread(lambda: {"token": _claim(event.id)}))
        return SimpleNamespace(id="outbox-case-message")

    monkeypatch.setattr(celery_module.app, "send_task", broker_that_claims)

    assert outbox.dispatch_pending() == 1
    event.refresh_from_db()
    observed = {
        "claimed": claimed,
        "status": event.status,
        "claim_token": event.claim_token,
        "processed_at": str(event.processed_at),
        "attempts": event.attempts,
    }
    assert claimed.get("token"), f"the worker must be able to claim the row it was woken for: {observed!r}"
    assert event.status == OutboxStatus.PROCESSING, observed
    assert event.claim_token == claimed["token"], (
        "the dispatcher overwrote the live claim it had just created; the consumer's own "
        f"confirmation would then fail and the effect would wait for the lease to expire: {observed!r}"
    )
    assert event.processed_at is None, observed
    assert event.attempts == 1, f"the hand-off itself must still be recorded: {observed!r}"


def test_an_expired_lease_is_still_recovered_by_the_next_scan(monkeypatch, settings):
    """The repair must not cost the recovery path its meaning: expiry still re-delivers.

    A dead worker leaves a ``processing`` row behind. Its expired lease has to
    stay claimable by the takeover the scan performs — if the scan reserved that
    row the way it reserves a ``pending`` one, the takeover consumer would read
    the reservation as a live competitor lease and skip, and every later scan
    would refresh the reservation and skip again.
    """
    settings.ACEPASS_INLINE_TASKS = False

    event = outbox.enqueue(TOPIC, {"attempt_id": str(uuid.uuid4())})
    task = _registered_task(TOPIC)
    expired = timezone.now() - timedelta(seconds=1)
    OutboxEvent.objects.filter(id=event.id).update(
        status=OutboxStatus.PROCESSING,
        claim_token="dead-worker-token",
        claimed_at=expired,
        lease_expires_at=expired,
    )
    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSING
    assert OutboxEvent.objects.filter(outbox.lease_available_q()).filter(id=event.id).exists(), (
        "an expired consumer lease must stay recoverable"
    )

    worker: dict = {}

    def immediate_broker(topic, kwargs=None, **options):
        worker.update(_run_in_worker_thread(lambda: _consume_with_real_consumer(task, kwargs or {})))
        return SimpleNamespace(id="outbox-case-message")

    monkeypatch.setattr(celery_module.app, "send_task", immediate_broker)

    assert outbox.dispatch_pending() == 1
    event.refresh_from_db()
    observed = {"worker": worker, "status": event.status, "processed_at": str(event.processed_at)}
    assert worker.get("verdict") == "evidence_rows=0", observed
    assert event.status == OutboxStatus.PROCESSED and event.processed_at is not None, observed
