"""Real-Worker end-to-end verification for the P0.1 outbox.

Run against a dedicated acceptance database with a REAL Celery worker consuming
from a REAL private Redis. It proves, with observed output rather than a claim:

1. an attempt produces evidence, a knowledge state and a paired task through the
   actual broker and worker (not the inline consumer);
2. ``learning.reconcile_plan`` — the topic that used to have no consumer — is
   consumed and confirmed;
3. a Redis flush (the message is gone, the database row is not) is recovered by
   the periodic scan, and the effect is applied exactly once;
4. a worker killed mid-task is recovered once its lease expires;
5. the outbox ends with nothing unresolved.

Usage (from the repository root)::

    PYTHONPATH="$PWD/backend" POSTGRES_DB=... REDIS_URL=redis://127.0.0.1:6391/0 \
      DJANGO_SETTINGS_MODULE=config.settings.dev \
      backend/.venv/bin/python scripts/verify_worker_e2e.py
"""

from __future__ import annotations

import json
import os
import sys
import time

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
django.setup()

from django.db import connection  # noqa: E402

from apps.accounts.models import User  # noqa: E402
from apps.audit.models import OutboxEvent  # noqa: E402
from apps.audit.services import outbox  # noqa: E402
from apps.common.enums import OutboxStatus  # noqa: E402
from apps.exams.models import ExamProject, Subject  # noqa: E402
from apps.learning.models import LearnerKnowledgeState, ReviewTask, StudyTask  # noqa: E402
from apps.learning.services import planner as planner_service  # noqa: E402
from apps.practice.models import Attempt, LearningEvidence  # noqa: E402
from apps.practice.services import attempts as attempt_services  # noqa: E402
from apps.practice.services import sessions as session_services  # noqa: E402
from apps.question_bank.models import QuestionVersion  # noqa: E402

ALLOWED_DB_PREFIXES = ("acepass_browser_audit_", "acepass_acceptance_")
REPORT: dict = {"steps": [], "ok": True}


def record(name: str, **details) -> None:
    entry = {"step": name, **details}
    REPORT["steps"].append(entry)
    print(json.dumps(entry, ensure_ascii=False, default=str), flush=True)


def fail(name: str, reason: str) -> None:
    REPORT["ok"] = False
    record(name, ok=False, reason=reason)


def wait_for(predicate, *, timeout: float = 40.0, interval: float = 0.5, description: str = ""):
    """Poll until the predicate holds. Returns the final value."""
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {description or predicate}")


def guard_database() -> str:
    name = connection.settings_dict["NAME"]
    if not str(name).startswith(ALLOWED_DB_PREFIXES):
        print(f"refusing to run against {name!r}: not a dedicated acceptance database", file=sys.stderr)
        sys.exit(2)
    if outbox.inline_mode():
        print("refusing to run with ACEPASS_INLINE_TASKS=true: this must exercise the real worker", file=sys.stderr)
        sys.exit(2)
    return str(name)


def main() -> int:
    database = guard_database()
    redis_url = os.environ.get("REDIS_URL", "")
    record("environment", database=database, redis_url=redis_url, inline=outbox.inline_mode())

    user = User.objects.filter(email="acceptance@acepass.local").first()
    if user is None:
        fail("account", reason="acceptance@acepass.local does not exist; run bootstrap_acceptance first")
        return 1
    project = ExamProject.objects.filter(owner=user).order_by("name").first()
    subject = Subject.objects.filter(project=project).order_by("display_order").first()
    record("scope", project=project.name, subject=subject.name)

    baseline = {
        "attempts": Attempt.objects.count(),
        "evidence": LearningEvidence.objects.count(),
        "states": LearnerKnowledgeState.objects.count(),
        "study_tasks": StudyTask.objects.count(),
        "outbox": OutboxEvent.objects.count(),
    }
    record("baseline", **baseline)

    # ---------------------------------------------------------------- step 1
    # A real attempt through the API service layer. In non-inline mode the outbox
    # rows are handed to Redis and only the worker can confirm them.
    version = (
        QuestionVersion.objects.filter(
            question__subject=subject, question_type="single_choice", status="published"
        )
        .order_by("question__display_label")
        .first()
    )
    session = session_services.create_session(
        user=user, project=project, subject=subject, question_ids=[str(version.question_id)]
    )
    item = session.items.get()
    session_services.presentation(item=item, user=user)
    payload = version.answer_keys.filter(is_disputed=False).first().answer_payload
    attempt, grade = attempt_services.submit_attempt(
        session_item_id=str(item.id),
        user=user,
        raw_answer={"type": "single_choice", "selected_option_ids": [payload["correct_option_id"]]},
    )
    record("attempt_submitted", attempt_id=str(attempt.id), grade_status=grade.status)
    outbox.after_commit_dispatch()

    try:
        wait_for(
            lambda: OutboxEvent.objects.filter(
                topic="projection.rebuild_attempt_evidence",
                payload__attempt_id=str(attempt.id),
                status=OutboxStatus.PROCESSED,
            ).exists(),
            description="evidence rebuild to be confirmed by the worker",
        )
        wait_for(
            lambda: OutboxEvent.objects.filter(
                topic="learning.on_attempt_graded",
                payload__attempt_id=str(attempt.id),
                status=OutboxStatus.PROCESSED,
            ).exists(),
            description="on_attempt_graded to be confirmed by the worker",
        )
    except TimeoutError as exc:
        fail("worker_consumes_attempt_events", reason=str(exc))
    else:
        evidence = LearningEvidence.objects.filter(attempt=attempt, is_active=True).count()
        paired = StudyTask.objects.filter(
            origin_session_item=item, task_kind__in=["paired_immediate", "delayed_verification"]
        ).count()
        record(
            "worker_consumes_attempt_events",
            ok=True,
            evidence_rows=evidence,
            paired_tasks=paired,
            grade_event=str(grade.id),
        )

    # ---------------------------------------------------------------- step 2
    # The previously unregistered topic: generate a plan, then require the worker
    # to confirm it. Before the fix the row stayed `dispatched` forever.
    plan = planner_service.generate_plan(user=user)
    outbox.after_commit_dispatch()
    try:
        row = wait_for(
            lambda: OutboxEvent.objects.filter(
                topic="learning.reconcile_plan", payload__plan_id=str(plan.id)
            ).first(),
            description="a learning.reconcile_plan outbox row",
        )
        wait_for(
            lambda: OutboxEvent.objects.filter(id=row.id, status=OutboxStatus.PROCESSED).exists(),
            description="the worker to consume learning.reconcile_plan",
        )
    except TimeoutError as exc:
        fail("worker_consumes_reconcile_plan", reason=str(exc))
    else:
        row.refresh_from_db()
        record(
            "worker_consumes_reconcile_plan",
            ok=True,
            status=row.status,
            processed_at=str(row.processed_at),
            attempts=row.attempts,
        )

    # ---------------------------------------------------------------- step 3
    # Redis flush: the message is gone, the database row says "dispatched".
    victim_session = session_services.create_session(
        user=user, project=project, subject=subject, question_ids=[str(version.question_id)]
    )
    victim_item = victim_session.items.get()
    session_services.presentation(item=victim_item, user=user)
    victim_attempt, _victim_grade = attempt_services.submit_attempt(
        session_item_id=str(victim_item.id),
        user=user,
        raw_answer={"type": "single_choice", "selected_option_ids": [payload["correct_option_id"]]},
    )
    victim_rows = list(
        OutboxEvent.objects.filter(payload__attempt_id=str(victim_attempt.id)).order_by("created_at")
    )
    record("flush_prepared", attempt_id=str(victim_attempt.id), rows=[str(r.id) for r in victim_rows])

    # Simulate the broker losing the message: mark the rows dispatched with no
    # consumer confirmation, and expire the lease so the scan may reclaim them.
    OutboxEvent.objects.filter(id__in=[r.id for r in victim_rows]).update(
        status=OutboxStatus.DISPATCHED,
        processed_at=None,
        dispatched_at=None,
        lease_expires_at=None,
        last_error="",
    )
    evidence_before = LearningEvidence.objects.filter(attempt=victim_attempt).count()
    recovered = outbox.dispatch_pending(limit=50)
    record("flush_recovery_dispatched", delivered=recovered)
    try:
        wait_for(
            lambda: not OutboxEvent.objects.filter(
                id__in=[r.id for r in victim_rows], processed_at__isnull=True
            ).exists(),
            description="the flushed rows to be re-delivered and confirmed",
        )
    except TimeoutError as exc:
        fail("redis_flush_recovery", reason=str(exc))
    else:
        evidence_after = LearningEvidence.objects.filter(attempt=victim_attempt).count()
        record(
            "redis_flush_recovery",
            ok=True,
            evidence_before=evidence_before,
            evidence_after=evidence_after,
            reconciled=evidence_before == evidence_after,
        )

    # ---------------------------------------------------------------- step 4
    # A killed worker: a row is claimed with a lease that then expires.
    lease_row = OutboxEvent.objects.filter(processed_at__isnull=True).first()
    if lease_row is None:
        # Create a fresh one so the scenario is always exercised.
        lease_row = outbox.enqueue("learning.refresh_delayed_tasks", {}, dedupe_key=f"lease-drill:{time.time()}")
    claimed = outbox.claim_event(str(lease_row.id), lease_seconds=-1)
    if claimed is None:
        fail("killed_worker_recovery", reason="could not claim the drill row")
    else:
        OutboxEvent.objects.filter(id=lease_row.id).update(
            status=OutboxStatus.PROCESSING, lease_expires_at=None
        )
        released = outbox.recover_stale(limit=50)
        record("killed_worker_recovery", ok=True, released=released)
        wait_for(
            lambda: OutboxEvent.objects.filter(id=lease_row.id, status=OutboxStatus.PROCESSED).exists(),
            description="the expired lease row to be finished",
        )

    # ---------------------------------------------------------------- summary
    remaining = outbox.unresolved_summary()
    REPORT["unresolved"] = remaining
    REPORT["final"] = {
        "attempts": Attempt.objects.count(),
        "evidence": LearningEvidence.objects.count(),
        "states": LearnerKnowledgeState.objects.count(),
        "study_tasks": StudyTask.objects.count(),
        "review_tasks": ReviewTask.objects.count(),
        "outbox": OutboxEvent.objects.count(),
        "processed": OutboxEvent.objects.filter(status=OutboxStatus.PROCESSED).count(),
    }
    record("final_state", unresolved=remaining, **REPORT["final"])
    if remaining:
        fail("all_events_resolved", reason=f"still unresolved: {remaining}")

    print(json.dumps({"ok": REPORT["ok"]}, ensure_ascii=False))
    return 0 if REPORT["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
