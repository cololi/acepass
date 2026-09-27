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
"""

from __future__ import annotations

import logging
import secrets
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db import transaction as db_transaction
from django.db.models import Q
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


def mark_retryable_failure(event: OutboxEvent, error: str, *, recoverable: bool = True) -> None:
    """Record a failed attempt and schedule the next one."""
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
    OutboxEvent.objects.filter(id=event.id).update(**updates)
    for key, value in updates.items():
        setattr(event, key, value)
    logger.warning(
        "outbox delivery failed topic=%s attempts=%s exhausted=%s error=%s",
        event.topic,
        attempts,
        exhausted,
        str(error)[:200],
    )


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


def dispatch_event(event: OutboxEvent) -> bool:
    """Deliver one event to its consumer."""
    if inline_mode():
        return _run_inline(event)
    from config.celery import app as celery_app

    try:
        celery_app.send_task(event.topic, kwargs={"outbox_event_id": str(event.id), **event.payload})
    except Exception as exc:  # broker down: keep the row recoverable
        mark_retryable_failure(event, str(exc))
        return False
    now = timezone.now()
    OutboxEvent.objects.filter(id=event.id).update(
        status=OutboxStatus.DISPATCHED,
        dispatched_at=now,
        attempts=event.attempts + 1,
        # A dispatched row is leased too: if the worker never confirms, the
        # lease expires and the scanner re-delivers it.
        lease_expires_at=now + timedelta(seconds=_lease_seconds()),
        updated_at=now,
    )
    event.status = OutboxStatus.DISPATCHED
    event.attempts = event.attempts + 1
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
    claim = claim_event(str(event.id))
    if claim is None:
        return False
    try:
        result = task.apply(kwargs={"outbox_event_id": str(event.id), **event.payload}, throw=False)
    except Exception as exc:  # pragma: no cover - defensive
        mark_retryable_failure(event, str(exc))
        return False
    if getattr(result, "failed", lambda: False)():
        mark_retryable_failure(event, str(getattr(result, "result", "consumer failed")))
        return False
    # The consumer's own `_mark_outbox(ok=True)` is authoritative. Confirm it
    # here only when the consumer did not, so this path can never downgrade a
    # `processed` row back to `dispatched` (the original bug).
    event.refresh_from_db()
    if event.processed_at is None:
        mark_processed(str(event.id), claim_token=claim.claim_token)
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


def dispatch_pending(limit: int = 100) -> int:
    """Re-deliver every event that no consumer has confirmed yet.

    Named for compatibility, but it is deliberately *not* limited to ``pending``:
    a row sitting in ``dispatched`` or ``processing`` with an expired lease is
    exactly the Redis-flush / killed-worker case that must be recovered.
    """
    dispatched = 0
    with db_transaction.atomic():
        events = list(
            _recoverable_queryset(cutoff=timezone.now())
            .select_for_update(skip_locked=True)
            .order_by("available_at")[:limit]
        )
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
