"""Transactional outbox: durable events with a dispatcher that survives crashes.

The row is always written inside the business transaction first. Only after the
commit is the consumer triggered, and if the broker (or the inline consumer)
fails the row stays pending for the periodic scan. Redis is never the source of
truth.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

from apps.audit.models import OutboxEvent
from apps.common.enums import OutboxStatus

logger = logging.getLogger("apps.audit.outbox")


def inline_mode() -> bool:
    """Run consumers in-process (test/demo) instead of handing them to Celery."""
    return bool(getattr(settings, "ACEPASS_INLINE_TASKS", False))


def enqueue(
    topic: str,
    payload: dict[str, Any] | None = None,
    *,
    dedupe_key: str | None = None,
    delay_seconds: int = 0,
) -> OutboxEvent:
    """Persist an event in the *current* transaction."""
    now = timezone.now()
    defaults = {
        "topic": topic,
        "payload": payload or {},
        "status": OutboxStatus.PENDING,
        "available_at": now + timedelta(seconds=max(delay_seconds, 0)),
        "attempts": 0,
    }
    if dedupe_key:
        event, created = OutboxEvent.objects.get_or_create(dedupe_key=dedupe_key, defaults=defaults)
        if not created:
            logger.debug("outbox dedupe hit topic=%s key=%s", topic, dedupe_key)
        return event
    return OutboxEvent.objects.create(**defaults)


def dispatch_event(event: OutboxEvent) -> bool:
    """Deliver one event to its consumer."""
    if inline_mode():
        return _run_inline(event)
    from config.celery import app as celery_app

    try:
        celery_app.send_task(event.topic, kwargs={"outbox_event_id": str(event.id), **event.payload})
    except Exception as exc:  # broker down: keep the row for the periodic scan
        event.attempts = event.attempts + 1
        event.last_error = str(exc)[:500]
        event.save(update_fields=["attempts", "last_error", "updated_at"])
        logger.warning("outbox dispatch failed topic=%s attempts=%s", event.topic, event.attempts)
        return False
    event.status = OutboxStatus.DISPATCHED
    event.dispatched_at = timezone.now()
    event.attempts = event.attempts + 1
    event.save(update_fields=["status", "dispatched_at", "attempts", "updated_at"])
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
        event.attempts = event.attempts + 1
        event.last_error = f"unknown topic {event.topic}"
        event.save(update_fields=["attempts", "last_error", "updated_at"])
        logger.warning("outbox topic has no registered consumer: %s", event.topic)
        return False
    try:
        task.apply(kwargs={"outbox_event_id": str(event.id), **event.payload}, throw=False)
    except Exception as exc:  # pragma: no cover - defensive
        event.attempts = event.attempts + 1
        event.last_error = str(exc)[:500]
        event.save(update_fields=["attempts", "last_error", "updated_at"])
        return False
    event.status = OutboxStatus.DISPATCHED
    event.dispatched_at = timezone.now()
    event.attempts = event.attempts + 1
    event.save(update_fields=["status", "dispatched_at", "attempts", "updated_at"])
    return True


def dispatch_pending(limit: int = 100) -> int:
    """Dispatch due pending events. Safe to run concurrently thanks to SKIP LOCKED."""
    from django.db import transaction as db_transaction

    dispatched = 0
    with db_transaction.atomic():
        events = list(
            OutboxEvent.objects.select_for_update(skip_locked=True)
            .filter(status=OutboxStatus.PENDING, available_at__lte=timezone.now())
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
        OutboxEvent.objects.filter(status=OutboxStatus.PENDING, available_at__lte=cutoff)
        .order_by("available_at")[:limit]
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


#: Alias kept for callers that prefer a context-manager style name.
register_commit_hook = after_commit_dispatch
