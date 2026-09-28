"""W4 counter-example ① — a *fast* consumer must not be skipped by the
dispatcher's own outbox row lock.

What is reproduced
------------------

``outbox.dispatch_pending`` opens ``transaction.atomic()``, takes
``select_for_update(skip_locked=True)`` on the outbox row and then calls
``dispatch_event`` **inside that transaction**. On the broker path
(``ACEPASS_INLINE_TASKS=False``) ``dispatch_event`` hands the message to Celery
and afterwards writes ``dispatched`` + a 300 s lease. A worker that receives the
message before the dispatcher commits runs ``run_leased`` -> ``claim_event`` ->
``select_for_update(skip_locked=True)`` on the *same* row, which is locked by the
dispatcher's still-open transaction, so the claim returns ``None``. The task
returns ``"skipped_lease_not_held"``, the message is acked, and the row sits in
``dispatched`` until the lease expires.

Why this probe is deterministic
-------------------------------

The injected broker runs the worker's attempt *inside* ``send_task`` and joins
the thread before returning, so the attempt is guaranteed to happen while the
dispatcher is still inside its transaction. That is the worst-case timing of a
real race (the field symptom was 24 skipped events in one browser run and 0 in
another), not a synthetic situation: it is the exact ordering a real worker hits
whenever Redis is faster than the dispatcher's commit.

The probe does **not** assert anything about *how* the fix works; it asserts the
observable contract:

* the effect is applied inside the same ``dispatch_pending`` round,
* the consumer is not skipped,
* ``processed_at`` is set, i.e. nothing waits for the lease TTL.

Before the fix all three fail. After the fix all three must pass.

Run (from the repository root)::

    PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-28/optimization/probes" \\
      W4_PROBE_LABEL=before \\
      backend/.venv/bin/python -m pytest \\
      docs/review/2026-09-28/optimization/probes/test_w4_outbox_fast_consumer.py \\
      -c backend/pytest.ini --ds=verifier_settings -q
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import pytest
from django.db import connection, connections, transaction
from django.db.utils import DatabaseError
from django.test import override_settings

pytestmark = pytest.mark.django_db(transaction=True)

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE.parent / "logs"
LABEL = os.environ.get("W4_PROBE_LABEL", "run")
REPORT_PATH = LOG_DIR / f"probe-outbox-{LABEL}.json"

REPORT: dict = {"probe": "w4-outbox-fast-consumer", "label": LABEL, "cases": []}


def _write_report() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"W4PROBE wrote {REPORT_PATH}", flush=True)


@pytest.fixture(scope="module", autouse=True)
def _dump_report():
    yield
    _write_report()


def _row_locked_by_other(event_id: str) -> bool:
    """Independent mechanism probe: is the row locked by another session now?

    ``select_for_update(nowait=True)`` raises immediately on a foreign lock, so
    this is a direct observation of "the dispatcher still holds the row lock at
    the moment the consumer tries to claim it" — not an inference.
    """
    from apps.audit.models import OutboxEvent

    try:
        with transaction.atomic():
            list(OutboxEvent.objects.select_for_update(nowait=True).filter(id=event_id))
        return False
    except DatabaseError:
        return True


class FakeAsyncResult:
    def __init__(self, task_id: str) -> None:
        self.id = task_id
        self.state = "PENDING"

    def get(self, *args, **kwargs):
        return None


class FastBroker:
    """Stands in for ``celery_app.send_task``.

    ``mode="consume"``  the worker receives the message and runs the real
    consumer entry point ``outbox.run_leased``.
    ``mode="drop"``     the broker accepts the message but no consumer confirms
    it (models the message that was consumed and acked after a skip).
    """

    def __init__(self, *, mode: str = "consume", effects: list[str] | None = None) -> None:
        self.mode = mode
        self.effects: list[str] = effects if effects is not None else []
        self.calls: list[dict] = []
        self.attempts: list[dict] = []
        self._threads: list[threading.Thread] = []

    # -- the injected call -------------------------------------------------
    def send_task(self, name=None, kwargs=None, **options):
        event_id = str((kwargs or {}).get("outbox_event_id") or "")
        self.calls.append(
            {
                "task": name,
                "event_id": event_id,
                "dispatcher_in_atomic_block": connection.in_atomic_block,
                "options": sorted(options),
            }
        )
        thread = threading.Thread(target=self._worker, args=(event_id,), name="w4-fake-worker", daemon=True)
        thread.start()
        self._threads.append(thread)
        # Join: the attempt must land while the dispatcher is still in its
        # transaction, otherwise the race is not deterministic.
        thread.join(timeout=60)
        return FakeAsyncResult(event_id)

    # -- the worker --------------------------------------------------------
    def _worker(self, event_id: str) -> None:
        record: dict = {"event_id": event_id, "mode": self.mode}
        try:
            record["row_locked_by_other_before_claim"] = _row_locked_by_other(event_id)
            if self.mode == "drop":
                record["outcome"] = "message accepted, no consumer confirmed it"
                return
            from apps.audit.services import outbox

            def action():
                self.effects.append(event_id)
                return "effect-applied"

            executed, result = outbox.run_leased(event_id, action)
            record["consumer_executed"] = executed
            record["consumer_result"] = result
            record["outcome"] = "effect applied" if executed else "consumer skipped: claim was not available"
        except Exception as exc:  # pragma: no cover - defensive
            record["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            self.attempts.append(record)
            connections.close_all()

    def join(self, timeout: float = 60.0) -> None:
        for thread in self._threads:
            thread.join(timeout=timeout)


def _install(monkeypatch, broker: FastBroker) -> None:
    """Route every broker hand-off of this process to ``broker``."""
    import celery
    from config.celery import app as celery_app

    monkeypatch.setattr(celery_app, "send_task", broker.send_task, raising=False)
    monkeypatch.setattr(celery.Celery, "send_task", lambda self, *a, **kw: broker.send_task(*a, **kw), raising=False)


def _snapshot(event) -> dict:
    event.refresh_from_db()
    return {
        "status": event.status,
        "attempts": event.attempts,
        "processed": event.processed_at is not None,
        "processed_at": event.processed_at,
        "lease_expires_at": event.lease_expires_at,
        "claim_token_present": bool(event.claim_token),
        "last_error": event.last_error,
    }


@override_settings(ACEPASS_INLINE_TASKS=False)
def test_fast_consumer_is_not_skipped_by_the_dispatchers_row_lock(monkeypatch):
    """HARD assertion: one dispatch round must end with the effect applied."""
    from apps.audit.services import outbox

    event = outbox.enqueue("w4.probe.fast_consumer", {"probe": "w4-lock"})
    effects: list[str] = []
    broker = FastBroker(mode="consume", effects=effects)
    _install(monkeypatch, broker)

    dispatched = outbox.dispatch_pending(limit=10)
    broker.join()
    after = _snapshot(event)

    case = {
        "case": "fast_consumer_not_skipped",
        "dispatcher_returned": dispatched,
        "broker_calls": broker.calls,
        "consumer_attempts": broker.attempts,
        "effects": effects,
        "event_after_round": after,
        "verdict": (
            "PASS" if (effects and after["processed"] and broker.attempts and broker.attempts[0].get("consumer_executed"))
            else "FAIL"
        ),
    }
    REPORT["cases"].append(case)
    _write_report()

    assert broker.calls, (
        "the dispatcher never handed the event to the broker, so this probe cannot "
        "observe the hand-off: " + json.dumps(case, ensure_ascii=False, default=str)
    )
    assert case["consumer_attempts"][0].get("row_locked_by_other_before_claim") is not None
    assert case["verdict"] == "PASS", "fast consumer was not served inside the dispatch round: " + json.dumps(
        case, ensure_ascii=False, default=str
    )


@override_settings(ACEPASS_INLINE_TASKS=False)
def test_handoff_without_confirmation_is_recovered_within_the_same_dispatch_round(monkeypatch):
    """MEASUREMENT (not a hard gate).

    Round 1 hands the message over but nothing confirms it — the exact aftermath
    of a skipped consumer. Round 2 is the next scan, invoked immediately: no
    sleeping, no waiting for any wall clock. The number recorded here is the
    redelivery delay the defect is about, expressed in *rounds* and in seconds of
    remaining lease.
    """
    from apps.audit.services import outbox

    event = outbox.enqueue("w4.probe.handoff_dropped", {"probe": "w4-round"})
    drop = FastBroker(mode="drop")
    _install(monkeypatch, drop)
    first = outbox.dispatch_pending(limit=10)
    drop.join()
    after_first = _snapshot(event)

    effects: list[str] = []
    consume = FastBroker(mode="consume", effects=effects)
    _install(monkeypatch, consume)
    second = outbox.dispatch_pending(limit=10)
    consume.join()
    after_second = _snapshot(event)

    from django.utils import timezone

    lease_seconds = None
    if after_first["lease_expires_at"]:
        lease_seconds = round((after_first["lease_expires_at"] - timezone.now()).total_seconds(), 1)

    case = {
        "case": "handoff_dropped_then_next_round",
        "round_1_dispatched": first,
        "after_round_1": after_first,
        "round_2_selected": second,
        "after_round_2": after_second,
        "lease_seconds_after_round_1": lease_seconds,
        "effects": effects,
        "verdict": "PASS (recovered in the next scan round)"
        if after_second["processed"]
        else f"FAIL (still unconfirmed; would wait out a {lease_seconds}s lease)",
    }
    REPORT["cases"].append(case)
    _write_report()
    print("W4PROBE round-case " + json.dumps(case, ensure_ascii=False, default=str), flush=True)
