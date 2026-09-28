"""Transactional outbox: durable events with a dispatcher that survives crashes.

The row is always written inside the business transaction first. Only after the
commit is the consumer triggered, and if the broker (or the inline consumer)
fails the row stays recoverable. Redis is never the source of truth.

Recovery contract
-----------------

``processed_at`` is the only proof that an effect actually happened. A row is
therefore recoverable while it is in ``pending``, ``dispatched``, ``processing``
or ``failed``, and the periodic scan re-delivers it. That matters for the cases
the original implementation could not survive:

* **Redis flushed or restarted** — every ``dispatched`` row lost its message, so
  ``dispatch_pending`` (which only looked at ``pending``) never re-sent it.
* **Worker killed mid-task** — the row was already ``dispatched`` and stayed
  that way, with no lease to expire.
* **Restored from a PostgreSQL-only backup** — the same as a Redis flush.

Re-delivery is safe because every consumer is idempotent and re-checks the real
state before writing, and because ``attempts``/``max_attempts`` bound the retry
loop instead of hammering a poisoned event forever.

Dispatch contract
-----------------

The dispatcher must never hold an outbox row lock while a consumer can see its
message. Every consumer claims its row with
``select_for_update(skip_locked=True)`` (:func:`run_leased` →
:func:`claim_event`), so a scan that called one from inside its own locking
transaction made a worker that was faster than the commit skip itself
(``skipped_lease_not_held``) and left the event leased for the whole
``OUTBOX_LEASE_SECONDS``. The same skip happens for a write that merely runs
*after* ``send_task``: the message is already in the broker, the worker claims
while the row is still locked, and the delivery is lost until the lease expires.
:func:`dispatch_pending` therefore selects its batch and commits the delivery
record (``dispatched`` + lease + one attempt) in one short transaction, and only
then hands the messages to the broker.
"""

from __future__ import annotations

import logging
import secrets
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db import transaction as db_transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.audit.models import OutboxEvent
from apps.common.enums import OutboxStatus

logger = logging.getLogger("apps.audit.outbox")

#: How long a consumer may hold a claimed row before it is considered abandoned.
DEFAULT_LEASE_SECONDS = 300
#: Exponential backoff base between delivery attempts.
DEFAULT_BACKOFF_SECONDS = 30
#: Cap on the computed backoff.
MAX_BACKOFF_SECONDS = 1800


def inline_mode() -> bool:
    """Run consumers in-process (test/demo) instead of handing them to Celery."""
    return bool(getattr(settings, "ACEPASS_INLINE_TASKS", False))


def _lease_seconds() -> int:
    return int(getattr(settings, "OUTBOX_LEASE_SECONDS", DEFAULT_LEASE_SECONDS))


def enqueue(
    topic: str,
    payload: dict[str, Any] | None = None,
    *,
    dedupe_key: str | None = None,
    delay_seconds: int = 0,
) -> OutboxEvent:
    """Persist an event in the *current* transaction.

    A dedupe hit on an event that never got processed re-arms the existing row
    instead of returning it as a dead no-op: the caller's intent is "make sure
    this effect happens", and a row whose ``processed_at`` is empty has not
    happened yet.
    """
    now = timezone.now()
    defaults = {
        "topic": topic,
        "payload": payload or {},
        "status": OutboxStatus.PENDING,
        "available_at": now + timedelta(seconds=max(delay_seconds, 0)),
        "attempts": 0,
        "max_attempts": int(getattr(settings, "OUTBOX_MAX_ATTEMPTS", 8)),
    }
    if dedupe_key:
        event, created = OutboxEvent.objects.get_or_create(dedupe_key=dedupe_key, defaults=defaults)
        if not created:
            logger.debug("outbox dedupe hit topic=%s key=%s", topic, dedupe_key)
            if event.is_recoverable and event.status == OutboxStatus.FAILED:
                # A previous attempt exhausted its retries; a fresh enqueue from
                # the same business action is an explicit request to try again.
                event.status = OutboxStatus.PENDING
                event.available_at = now + timedelta(seconds=max(delay_seconds, 0))
                event.attempts = 0
                event.last_error = ""
                event.save(update_fields=["status", "available_at", "attempts", "last_error", "updated_at"])
        return event
    return OutboxEvent.objects.create(**defaults)


def _backoff_seconds(attempts: int) -> int:
    base = int(getattr(settings, "OUTBOX_BACKOFF_SECONDS", DEFAULT_BACKOFF_SECONDS))
    return min(base * (2 ** max(0, attempts - 1)), MAX_BACKOFF_SECONDS)


def mark_retryable_failure(
    event: OutboxEvent, error: str, *, recoverable: bool = True, claim_token: str | None = None
) -> bool:
    """Record a failed attempt and schedule the next one.

    Refuses to touch a row that already reached a terminal success (B05): a
    consumer that failed after a newer one completed used to flip ``processed``
    back to ``pending``, which turned a completed effect into a permanent retry
    loop. Only the holder of the current claim may record a failure for a claim,
    which is what ``claim_token`` enforces.
    """
    attempts = event.attempts + 1
    exhausted = attempts >= int(event.max_attempts or 8)
    updates: dict[str, Any] = {
        "attempts": attempts,
        "last_error": str(error)[:500],
        "claimed_at": None,
        "claim_token": "",
        "lease_expires_at": None,
        "updated_at": timezone.now(),
    }
    if recoverable and not exhausted:
        updates["status"] = OutboxStatus.PENDING
        updates["available_at"] = timezone.now() + timedelta(seconds=_backoff_seconds(attempts))
    else:
        updates["status"] = OutboxStatus.FAILED
        # Keep it recoverable later: the scan still revisits `failed` rows.
        updates["available_at"] = timezone.now() + timedelta(seconds=MAX_BACKOFF_SECONDS)
    filters: dict[str, Any] = {"id": event.id, "processed_at__isnull": True}
    if claim_token:
        filters["claim_token"] = claim_token
    updated = OutboxEvent.objects.filter(**filters).update(**updates)
    if not updated:
        logger.warning(
            "ignored stale failure for terminal event topic=%s id=%s (already confirmed)",
            event.topic,
            event.id,
        )
        return False
    for key, value in updates.items():
        setattr(event, key, value)
    logger.warning(
        "outbox delivery failed topic=%s attempts=%s exhausted=%s error=%s",
        event.topic,
        attempts,
        exhausted,
        str(error)[:200],
    )
    return True


def claim_event(event_id: str, *, lease_seconds: int | None = None) -> OutboxEvent | None:
    """Claim a row for one consumer. Returns None if someone else holds it."""
    token = secrets.token_hex(16)
    now = timezone.now()
    with db_transaction.atomic():
        row = OutboxEvent.objects.select_for_update(skip_locked=True).filter(id=event_id).first()
        if row is None:
            return None
        if row.processed_at is not None or row.status == OutboxStatus.PROCESSED:
            return None
        if row.status == OutboxStatus.PROCESSING and row.lease_expires_at and row.lease_expires_at > now:
            logger.info("outbox event %s is still leased by another consumer", event_id)
            return None
        row.status = OutboxStatus.PROCESSING
        row.claimed_at = now
        row.claim_token = token
        row.lease_expires_at = now + timedelta(seconds=lease_seconds or _lease_seconds())
        row.save(update_fields=["status", "claimed_at", "claim_token", "lease_expires_at", "updated_at"])
    return row


def mark_processed(event_id: str, *, claim_token: str = "") -> bool:
    """Consumer-side confirmation. This is the only terminal success."""
    now = timezone.now()
    filters: dict[str, Any] = {"id": event_id}
    if claim_token:
        filters["claim_token"] = claim_token
    updated = OutboxEvent.objects.filter(**filters).update(
        status=OutboxStatus.PROCESSED,
        processed_at=now,
        claimed_at=None,
        claim_token="",
        lease_expires_at=None,
        last_error="",
        updated_at=now,
    )
    return bool(updated)


def confirm_claim(claim: OutboxEvent) -> bool:
    """Confirm the exact claim, so a consumer cannot confirm someone else's work."""
    return mark_processed(str(claim.id), claim_token=claim.claim_token)


def hold_claim(event_id: str, claim_token: str) -> OutboxEvent | None:
    """Lock and re-read a claim, returning it only while *this* consumer owns it.

    The lease protects the outbox row; business writes need the same protection.
    A consumer that already lost the row (lease expired and a takeover re-claimed
    it, or the row was confirmed) must not go on to write job results, assistant
    messages or exposures — otherwise the stale consumer overwrites the takeover's
    committed outcome, which is exactly the C04 double-write.

    Must be called inside a transaction: the row is locked ``FOR UPDATE`` so the
    ownership decision and the writes that depend on it commit together, and the
    lock is held for the short business commit only — never across a model call.
    """
    row = OutboxEvent.objects.select_for_update().filter(id=event_id).first()
    if row is None or row.processed_at is not None:
        return None
    if not claim_token or row.claim_token != claim_token:
        logger.info("outbox event %s is no longer owned by this consumer", event_id)
        return None
    return row


def fail_claim(claim: OutboxEvent, error: str, *, recoverable: bool = True) -> bool:
    """Record a failure for the exact claim, never for a terminal row."""
    return mark_retryable_failure(claim, error, recoverable=recoverable, claim_token=claim.claim_token)


def run_leased(event_id: str | None, action):
    """Run ``action`` while holding the outbox lease for ``event_id``.

    Every real consumer goes through this (B05). Before, only the inline path
    called :func:`claim_event`; the Celery tasks executed business logic first and
    told the outbox afterwards, so two consumers — an inline "run now" and a
    worker redelivery, or two workers after a visibility timeout — could both
    apply the effect, and the second completion could overwrite a terminal state.

    Returns ``(executed, result)``: ``executed`` is ``False`` when another live
    consumer holds the lease or the row is already terminal, in which case
    ``action`` is never called.

    ``event_id`` of ``None`` (a direct call with no outbox row, e.g. a manual
    invocation in a test or a management command) runs the action without a
    lease, because there is nothing to serialise on.
    """
    if not event_id:
        return True, action()
    claim = claim_event(str(event_id))
    if claim is None:
        logger.info("outbox event %s is not claimable by this consumer; skipping", event_id)
        return False, None
    try:
        result = action()
    except Exception as exc:
        fail_claim(claim, str(exc))
        raise
    confirm_claim(claim)
    return True, result


def dispatch_event(event: OutboxEvent) -> bool:
    """Deliver one event to its consumer."""
    # The attempt cap binds *redelivery* as well, not only failures (B05). A
    # message that reached the broker but was never confirmed used to be re-sent
    # on every scan forever, so ``attempts`` climbed past ``max_attempts``.
    if int(event.attempts) >= int(event.max_attempts or 8):
        now = timezone.now()
        OutboxEvent.objects.filter(id=event.id, processed_at__isnull=True).update(
            status=OutboxStatus.FAILED,
            claimed_at=None,
            claim_token="",
            lease_expires_at=None,
            last_error=(event.last_error or "投递次数已达上限，停止自动重投")[:500],
            updated_at=now,
        )
        logger.warning(
            "outbox event %s reached max_attempts=%s without confirmation; not redelivering",
            event.id,
            event.max_attempts,
        )
        return False
    if inline_mode():
        return _run_inline(event)
    from config.celery import app as celery_app

    try:
        # Nothing may be written to this row once the message exists: the worker
        # is free to claim it the moment the broker accepts it (docs/15 §7.1).
        # The delivery record was already committed by `_record_deliveries`.
        celery_app.send_task(event.topic, kwargs={"outbox_event_id": str(event.id), **event.payload})
    except Exception as exc:  # broker down: keep the row recoverable
        mark_retryable_failure(event, str(exc))
        return False
    return True


def _run_inline(event: OutboxEvent) -> bool:
    """Run the registered consumer in-process (test/demo mode only)."""
    # Importing the task modules is what registers them; `imports` alone is only
    # applied when the worker finalises, and the API process never does that.
    import apps.audit.tasks  # noqa: F401
    import apps.tutoring.tasks  # noqa: F401
    from config import celery as celery_module

    task = celery_module.app.tasks.get(event.topic)
    if task is None:
        mark_retryable_failure(event, f"unknown topic {event.topic}", recoverable=False)
        return False
    # The consumer claims its own lease (``run_leased``), exactly like a real
    # worker does. This path must therefore *not* pre-claim: a nested claim would
    # find the lease already held by this very call and skip the work.
    try:
        result = task.apply(kwargs={"outbox_event_id": str(event.id), **event.payload}, throw=False)
    except Exception as exc:  # pragma: no cover - defensive
        mark_retryable_failure(event, str(exc))
        return False
    if getattr(result, "failed", lambda: False)():
        mark_retryable_failure(event, str(getattr(result, "result", "consumer failed")))
        return False
    # A consumer that succeeded has already confirmed with its own token. Confirm
    # here only in the narrow case "returned normally, still holds its own claim,
    # never confirmed", so the row cannot get stuck. Two other outcomes are NOT
    # successes and must be left alone: a consumer that reported a failure leaves
    # the row in ``pending``/``failed``, and a consumer that skipped because
    # another lease was live leaves that other consumer's token in place.
    event.refresh_from_db()
    if event.processed_at is None and event.status == OutboxStatus.PROCESSING and not event.claim_token:
        mark_processed(str(event.id))
    return True


#: States the scanner revisits. ``processed`` is the only state it must not
#: touch; ``failed`` is excluded because it has exhausted its attempt budget
#: (an operator or a fresh ``enqueue`` with the same dedupe key re-arms it).
RECOVERABLE_STATUSES = (OutboxStatus.PENDING, OutboxStatus.DISPATCHED, OutboxStatus.PROCESSING)


def lease_available_q(now=None) -> Q:
    """Unleased, or leased but past its expiry."""
    moment = now or timezone.now()
    return Q(lease_expires_at__isnull=True) | Q(lease_expires_at__lte=moment)


def _recoverable_queryset(*, cutoff, now=None):
    moment = now or timezone.now()
    return OutboxEvent.objects.filter(
        status__in=RECOVERABLE_STATUSES, available_at__lte=cutoff
    ).filter(lease_available_q(moment))


def _record_deliveries(events: list[OutboxEvent]) -> None:
    """Write the delivery record for a batch *before* any message exists.

    Called inside the transaction that selected the rows (they are locked
    ``FOR UPDATE``); that transaction commits before the broker is called, so by
    the time a consumer can see a message, the row is free and already marked.

    Both halves of that order are load-bearing (docs/15 §7.1):

    * every consumer claims its row with ``select_for_update(skip_locked=True)``
      (:func:`run_leased` → :func:`claim_event`), so a row lock that is still
      held while the worker claims makes the worker skip its own event. A
      delivery write that ran *after* ``send_task`` had exactly that effect: the
      message was already in the broker while the row was still being updated;
    * the row must already carry its delivery lease when the message appears,
      otherwise a concurrent scan sees an undelivered row and hands the same
      event out twice.

    ``processing`` rows are the dead-worker case: their claim columns belong to
    the takeover consumer that :func:`claim_event` must let through, so only
    ``attempts``/``dispatched_at`` are recorded for them.

    ``attempts`` is incremented in SQL while the in-memory rows keep their
    pre-delivery values on purpose: a broker failure is recorded by
    :func:`mark_retryable_failure`, which computes ``event.attempts + 1`` from
    that same pre-delivery value, so one failed hand-off counts exactly once.

    Inline mode is the exception: the consumer runs in-process and records the
    attempt through its own freshly claimed row, so counting the hand-off here
    as well would double the retry budget (this keeps the inline accounting
    exactly as it was).
    """
    if not events:
        return
    # Rows that already exhausted their budget must not be marked dispatched and
    # must not consume another attempt: `dispatch_event` marks those failed
    # without a hand-off, and the counter is a cap, not a rough guide (B05).
    # This uses the same pre-delivery values `dispatch_event` will see.
    handoff = [event for event in events if int(event.attempts) < int(event.max_attempts or 8)]
    if not handoff:
        return
    now = timezone.now()
    ids = [event.id for event in handoff]
    updates: dict[str, Any] = {"dispatched_at": now, "updated_at": now}
    if not inline_mode():
        updates["attempts"] = F("attempts") + 1
    OutboxEvent.objects.filter(id__in=ids, processed_at__isnull=True).update(**updates)
    # A dispatched row is leased too: if the worker never confirms, the lease
    # expires and the scanner re-delivers it. A dispatcher killed between this
    # commit and the broker call therefore leaves a recoverable leased row, not
    # a silently lost message.
    OutboxEvent.objects.filter(
        id__in=ids,
        processed_at__isnull=True,
        status__in=(OutboxStatus.PENDING, OutboxStatus.DISPATCHED),
    ).update(
        status=OutboxStatus.DISPATCHED,
        lease_expires_at=now + timedelta(seconds=_lease_seconds()),
        updated_at=now,
    )


def dispatch_pending(limit: int = 100) -> int:
    """Re-deliver every event that no consumer has confirmed yet.

    Named for compatibility, but it is deliberately *not* limited to ``pending``:
    a row sitting in ``dispatched`` or ``processing`` with an expired lease is
    exactly the Redis-flush / killed-worker case that must be recovered.

    The row lock covers only the *choice* of the batch and its delivery record,
    never a consumer run: every consumer claims its own row with
    ``select_for_update(skip_locked=True)`` (:func:`run_leased` →
    :func:`claim_event`), so invoking one while this transaction still held the
    lock made a fast worker skip its own event (``skipped_lease_not_held``) and
    left the row leased for the whole ``OUTBOX_LEASE_SECONDS`` before a later
    scan could try again (docs/15 §7.1). The batch is selected and recorded in a
    short transaction, and the messages are handed to the broker only after that
    transaction has committed.
    """
    with db_transaction.atomic():
        events = list(
            _recoverable_queryset(cutoff=timezone.now())
            .select_for_update(skip_locked=True)
            .order_by("available_at")[:limit]
        )
        _record_deliveries(events)
    dispatched = 0
    for event in events:
        if dispatch_event(event):
            dispatched += 1
    return dispatched


def dispatch_after_commit(horizon_seconds: int = 0, limit: int = 500) -> int:
    """Post-commit trigger.

    With Celery this is the normal scan (due events only). In inline mode the
    horizon is widened, because no scheduler is running to pick up a delayed
    event later; the consumers themselves are idempotent and re-check the real
    time interval before acting.
    """
    if not inline_mode():
        return dispatch_pending(limit=limit)
    dispatched = 0
    cutoff = timezone.now() + timedelta(seconds=horizon_seconds)
    for event in list(
        _recoverable_queryset(cutoff=cutoff).order_by("available_at")[:limit]
    ):
        if dispatch_event(event):
            dispatched += 1
    return dispatched


def after_commit_dispatch(horizon_seconds: int = 0) -> None:
    """Trigger dispatch once the surrounding transaction commits.

    * production: the post-commit hook hands the events to Celery, and the
      periodic ``audit.scan_outbox`` covers a crash between commit and dispatch.
    * test/demo inline mode: consumers run right away, because a test client
      request wraps everything in an outer transaction that never commits.

    Network and image work must not run inside the business transaction, so the
    scheduler-driven path stays the default in production.
    """
    from django.db import transaction as db_transaction

    if inline_mode():
        dispatch_after_commit(horizon_seconds=horizon_seconds)
        return
    db_transaction.on_commit(lambda: dispatch_after_commit(horizon_seconds=horizon_seconds))


def recover_stale(limit: int = 200, *, include_failed: bool = False) -> int:
    """Re-arm rows whose lease expired, then re-deliver.

    Explicit about intent (rather than relying on ``dispatch_pending``'s filter)
    and it also clears an abandoned claim, so a dead worker's lease cannot block
    the next delivery. ``include_failed`` additionally resets rows that exhausted
    their attempt budget — an operator decision, never automatic.
    """
    now = timezone.now()
    released = OutboxEvent.objects.filter(
        status=OutboxStatus.PROCESSING, lease_expires_at__lte=now, processed_at__isnull=True
    ).update(
        status=OutboxStatus.PENDING,
        claimed_at=None,
        claim_token="",
        lease_expires_at=None,
        last_error="消费者租约过期，任务已重新排队",
        updated_at=now,
    )
    if include_failed:
        released += OutboxEvent.objects.filter(
            status=OutboxStatus.FAILED, processed_at__isnull=True
        ).update(
            status=OutboxStatus.PENDING,
            attempts=0,
            available_at=now,
            lease_expires_at=None,
            last_error="",
            updated_at=now,
        )
    return released + dispatch_pending(limit=limit)


def unresolved_summary() -> dict[str, int]:
    """Operational view of what still has not been confirmed done."""
    rows = (
        OutboxEvent.objects.filter(processed_at__isnull=True)
        .values_list("status")
        .order_by()
    )
    summary: dict[str, int] = {}
    for (status,) in rows:
        summary[status] = summary.get(status, 0) + 1
    return summary


#: Alias kept for callers that prefer a context-manager style name.
register_commit_hook = after_commit_dispatch
