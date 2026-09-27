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
    # The only corrector for a delayed task whose anchor moved. It had no producer
    # and no schedule, so a premature `not_before` could never be pushed back.
    "refresh-delayed-tasks": {
        "task": "learning.refresh_delayed_tasks",
        "schedule": 300.0,
        "options": {"queue": "projection"},
    },
}
app.conf.timezone = "UTC"


def registered_topics() -> set[str]:
    """Task names this process can actually execute (used by the inline runner)."""
    return set(app.tasks)


def producer_topics() -> set[str]:
    """Every topic string any ``enqueue()`` call in the codebase emits.

    Kept next to the app so ``tests/integration/test_outbox_contract.py`` can
    assert that no producer outruns its consumer — the class of bug that let
    ``learning.reconcile_plan`` be discarded by a real worker while every inline
    test stayed green.

    A beat-scheduled topic is not a producer topic: nothing calls ``enqueue()``
    for ``learning.refresh_delayed_tasks``, so it lives in ``beat_schedule``
    (pinned there, together with its consumer registration) instead of here.
    """
    return {
        "projection.rebuild_attempt_evidence",
        "projection.regrade_effects",
        "projection.run_regrade",
        "projection.rebuild_after_answer_change",
        "projection.refresh_paper_stats",
        "learning.on_attempt_graded",
        "learning.on_session_finished",
        "learning.reconcile_plan",
        "tutoring.run_job",
        "ingestion.extract_candidate",
    }
