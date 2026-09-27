"""Celery application.

Queues follow the architecture split so a large import cannot starve online
tutoring: ``ingestion`` (offline parsing/annotation), ``tutoring`` (online
generation) and ``projection`` (evidence/report rebuilds).

Every consumer task receives ``outbox_event_id`` and is idempotent: Redis may
redeliver, so PostgreSQL stays the source of truth and a redelivery cannot apply
an effect twice.
"""

from __future__ import annotations

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("acepass")
app.config_from_object("django.conf:settings", namespace="CELERY")
# ``autodiscover_tasks`` looks for ``<app>.tasks`` inside INSTALLED_APPS, which
# cannot resolve the "apps." package prefix used here, so the task modules are
# imported explicitly instead.
app.autodiscover_tasks()
app.conf.imports = tuple(app.conf.get("imports") or ()) + ("apps.audit.tasks", "apps.tutoring.tasks")


@app.task(name="audit.scan_outbox", ignore_result=True)
def scan_outbox(limit: int = 100) -> int:
    """Periodic safety net: re-dispatch events the broker never accepted."""
    from apps.audit.services.outbox import dispatch_pending

    return dispatch_pending(limit=limit)


app.conf.beat_schedule = {
    "scan-outbox": {
        "task": "audit.scan_outbox",
        "schedule": 30.0,
        "options": {"queue": "ingestion"},
    },
}
app.conf.timezone = "UTC"


def registered_topics() -> set[str]:
    """Task names this process can actually execute (used by the inline runner)."""
    return set(app.tasks)
