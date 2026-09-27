"""Real-Worker end-to-end verification, including REAL fault injection.

Run against a dedicated acceptance database with a REAL private Redis. The script
starts and stops its own Celery worker processes, so "the worker was killed" and
"the queue was flushed" are actual operating-system and Redis actions rather than
database edits dressed up as a drill.

What it proves, with observed output rather than a claim:

1. an attempt produces evidence, a knowledge state and a paired task through the
   actual broker and worker (not the inline consumer);
2. ``learning.reconcile_plan`` — the topic that used to have no consumer — is
   consumed and confirmed;
3. **real Redis loss** (``FLUSHALL`` on the isolated instance, with the messages
   observed in the queue before and gone after) is recovered by the periodic
   scan, and the effect is applied exactly once;
4. **real worker kill** (``SIGKILL`` to the worker process group while it is
   consuming) is recovered when the lease expires, and the effect is applied
   exactly once;
5. **two consumers** on the same queues do not double-apply an event;
6. the outbox ends with nothing unresolved.

Simulated steps are labelled as such in the JSON report. Nothing here edits a
row to *pretend* a process died.

Usage (from the repository root)::

    PYTHONPATH="$PWD/backend" POSTGRES_DB=acepass_acceptance_x \
      REDIS_URL=redis://127.0.0.1:6394/0 DJANGO_SETTINGS_MODULE=config.settings.dev \
      ACEPASS_INLINE_TASKS=false ACEPASS_PRIVATE_MEDIA_ROOT=/tmp/... \
      ACEPASS_OUTBOX_LEASE_SECONDS=5 \
      backend/.venv/bin/python scripts/verify_worker_e2e.py
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
django.setup()

from django.conf import settings  # noqa: E402
from django.db import connection  # noqa: E402
from django.utils import timezone  # noqa: E402

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
ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
REPORT: dict = {"steps": [], "ok": True, "notes": []}
QUEUES = "ingestion,tutoring,projection"


def record(name: str, **details) -> None:
    entry = {"step": name, **details}
    REPORT["steps"].append(entry)
    print(json.dumps(entry, ensure_ascii=False, default=str), flush=True)


def note(text: str) -> None:
    REPORT["notes"].append(text)
    print(json.dumps({"note": text}, ensure_ascii=False), flush=True)


def fail(name: str, reason: str) -> None:
    REPORT["ok"] = False
    record(name, ok=False, reason=reason)


def wait_for(predicate, *, timeout: float = 60.0, interval: float = 0.5, description: str = ""):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {description or predicate}")


# --------------------------------------------------------------------------
# Real process / broker control
# --------------------------------------------------------------------------
class Worker:
    """A real Celery worker process this script starts and can really kill."""

    def __init__(self, name: str):
        self.name = name
        self.process: subprocess.Popen | None = None
        self.log = Path(f"/tmp/acepass-worker-drill-{name}.log")

    def start(self) -> None:
        if self.process is not None and self.process.poll() is None:
            return
        env = {**os.environ, "DJANGO_SETTINGS_MODULE": "config.settings.dev"}
        # Truncate first: a "ready." line from an earlier run would otherwise make
        # the readiness wait return before this process is actually consuming.
        self.log.write_bytes(b"")
        with self.log.open("ab") as handle:
            self.process = subprocess.Popen(
                [
                    str(BACKEND / ".venv" / "bin" / "celery"),
                    "-A",
                    "config",
                    "worker",
                    "--pool=solo",
                    "-Q",
                    QUEUES,
                    "-c",
                    "1",
                    "-l",
                    "INFO",
                    "-n",
                    f"{self.name}@%h",
                ],
                cwd=str(BACKEND),
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # own process group, so killpg hits all children
            )
        wait_for(
            lambda: "ready." in self.log.read_text(errors="replace"),
            timeout=60,
            description=f"{self.name} to report ready",
        )

    def kill(self, sig: int = signal.SIGKILL) -> int:
        """Really kill the worker process group. Returns the signal used."""
        if self.process is None:
            return sig
        try:
            os.killpg(os.getpgid(self.process.pid), sig)
        except ProcessLookupError:  # pragma: no cover - already gone
            pass
        self.process.wait(timeout=30)
        return sig

    def alive(self) -> bool:
        return self.process is not None and self.process.poll() is None


def redis_client():
    import redis

    return redis.Redis.from_url(os.environ["REDIS_URL"])


def queue_depth(client) -> int:
    """Real queue length in Redis (Celery's default list keys)."""
    total = 0
    for key in client.scan_iter(match="*", count=500):
        if client.type(key) == b"list":
            total += int(client.llen(key))
    return total


def guard_database() -> str:
    name = connection.settings_dict["NAME"]
    if not str(name).startswith(ALLOWED_DB_PREFIXES):
        print(f"refusing to run against {name!r}: not a dedicated acceptance database", file=sys.stderr)
        sys.exit(2)
    if outbox.inline_mode():
        print("refusing to run with ACEPASS_INLINE_TASKS=true: this must exercise the real worker", file=sys.stderr)
        sys.exit(2)
    if not os.environ.get("REDIS_URL"):
        print("refusing to run without REDIS_URL: the drill needs the real broker", file=sys.stderr)
        sys.exit(2)
    return str(name)


def evidence_applied_exactly_once(attempt) -> tuple[bool, int]:
    """True when this attempt has exactly one evidence row per (dimension, node)."""
    from django.db.models import Count

    rows = LearningEvidence.objects.filter(attempt=attempt)
    duplicated = (
        rows.values("dimension", "knowledge_node_id").annotate(n=Count("id")).filter(n__gt=1).exists()
    )
    return (not duplicated and rows.exists()), rows.count()


def submit_one_attempt(*, user, project, subject, version, payload):
    session = session_services.create_session(
        user=user, project=project, subject=subject, question_ids=[str(version.question_id)]
    )
    item = session.items.get()
    session_services.presentation(item=item, user=user)
    attempt, grade = attempt_services.submit_attempt(
        session_item_id=str(item.id),
        user=user,
        raw_answer={"type": "single_choice", "selected_option_ids": [payload["correct_option_id"]]},
    )
    outbox.after_commit_dispatch()
    return item, attempt, grade


def main() -> int:  # noqa: C901 - a drill script reads better as one sequence
    database = guard_database()
    REPORT_STARTED_AT = timezone.now()
    client = redis_client()
    record(
        "environment",
        database=database,
        redis_url=os.environ["REDIS_URL"],
        inline=outbox.inline_mode(),
        outbox_lease_seconds=int(settings.OUTBOX_LEASE_SECONDS),
    )

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

    version = (
        QuestionVersion.objects.filter(
            question__subject=subject, question_type="single_choice", status="published"
        )
        .order_by("question__display_label")
        .first()
    )
    payload = version.answer_keys.filter(is_disputed=False).first().answer_payload

    primary = Worker("drill-primary")
    secondary = Worker("drill-secondary")
    # Rows that were already unresolved before this drill (for example because a
    # previous acceptance run ended with its worker stopped). They are reported
    # separately: their recovery depends on the lease they were given, and mixing
    # them into the drill's own assertion would make the result depend on history.
    pre_existing = set(
        OutboxEvent.objects.filter(processed_at__isnull=True).values_list("id", flat=True)
    )
    record("pre_existing_unresolved", count=len(pre_existing))
    client.flushall()
    record("broker_flushed_before_drill", queue_depth=queue_depth(client), real=True)

    # ---------------------------------------------------------------- step 1
    primary.start()
    _item, attempt, grade = submit_one_attempt(
        user=user, project=project, subject=subject, version=version, payload=payload
    )
    record("attempt_submitted", attempt_id=str(attempt.id), grade_status=grade.status, worker="drill-primary")
    try:
        wait_for(
            lambda: OutboxEvent.objects.filter(
                topic="projection.rebuild_attempt_evidence",
                payload__attempt_id=str(attempt.id),
                status=OutboxStatus.PROCESSED,
            ).exists(),
            description="evidence rebuild to be confirmed by the real worker",
        )
        wait_for(
            lambda: OutboxEvent.objects.filter(
                topic="learning.on_attempt_graded",
                payload__attempt_id=str(attempt.id),
                status=OutboxStatus.PROCESSED,
            ).exists(),
            description="on_attempt_graded to be confirmed by the real worker",
        )
    except TimeoutError as exc:
        fail("worker_consumes_attempt_events", reason=str(exc))
    else:
        record(
            "worker_consumes_attempt_events",
            ok=True,
            evidence_rows=LearningEvidence.objects.filter(attempt=attempt, is_active=True).count(),
            paired_tasks=StudyTask.objects.filter(
                origin_session_item=_item, task_kind__in=["paired_immediate", "delayed_verification"]
            ).count(),
            grade_event=str(grade.id),
            real=True,
        )

    # ---------------------------------------------------------------- step 2
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
            real=True,
        )

    # ---------------------------------------------------------------- step 3
    # REAL Redis loss. The worker is stopped first so the messages are provably
    # still in the queue when the flush happens.
    primary.kill()
    record("worker_stopped_for_flush", worker="drill-primary", killed_with="SIGKILL", real=True)
    client.flushall()

    _victim_item, victim_attempt, _victim_grade = submit_one_attempt(
        user=user, project=project, subject=subject, version=version, payload=payload
    )
    victim_rows = list(
        OutboxEvent.objects.filter(payload__attempt_id=str(victim_attempt.id)).order_by("created_at")
    )
    depth_before = queue_depth(client)
    record(
        "flush_prepared",
        attempt_id=str(victim_attempt.id),
        rows=[str(r.id) for r in victim_rows],
        queue_depth_before_flush=depth_before,
        real=True,
    )
    if depth_before <= 0:
        fail("redis_flush_recovery", reason="no message reached Redis, so a flush would prove nothing")
    else:
        flushed = client.flushall()
        depth_after = queue_depth(client)
        record("redis_flushed_for_real", flushed=bool(flushed), queue_depth_after_flush=depth_after, real=True)
        evidence_before = LearningEvidence.objects.filter(attempt=victim_attempt).count()
        # Restart the worker: the messages are gone from Redis, so only the
        # periodic scan (the same call the beat task makes) can recover them —
        # and only once the dispatched lease expires, which is exactly the
        # contract that makes a lost message recoverable instead of stuck.
        primary.start()
        lease = int(settings.OUTBOX_LEASE_SECONDS)
        scanned = 0

        def scan_until_recovered():
            nonlocal scanned
            scanned += outbox.dispatch_pending(limit=50)
            return not OutboxEvent.objects.filter(
                id__in=[r.id for r in victim_rows], processed_at__isnull=True
            ).exists()

        try:
            wait_for(
                scan_until_recovered,
                timeout=max(60.0, lease * 3),
                interval=1.0,
                description="the flushed rows to be re-delivered after the lease expired and confirmed",
            )
        except TimeoutError as exc:
            fail("redis_flush_recovery", reason=str(exc))
        else:
            record("flush_recovery_scan", delivered=scanned, lease_seconds=lease, real=True)
            once, evidence_after = evidence_applied_exactly_once(victim_attempt)
            record(
                "redis_flush_recovery",
                ok=once,
                evidence_rows=evidence_after,
                evidence_before_recovery=evidence_before,
                applied_exactly_once=once,
                real=True,
            )
            if not once:
                fail("redis_flush_recovery", reason=f"evidence applied more than once: {evidence_after} rows")

    # ---------------------------------------------------------------- step 4
    # REAL worker kill. The worker is SIGKILLed as soon as a row is observed
    # being consumed (polled at 5 ms), and the report says honestly whether the
    # kill actually landed while a row was in flight.
    primary.start()
    _kill_item, kill_attempt, _kill_grade = submit_one_attempt(
        user=user, project=project, subject=subject, version=version, payload=payload
    )
    kill_ids = [r.id for r in OutboxEvent.objects.filter(payload__attempt_id=str(kill_attempt.id))]
    caught_in_flight = False
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if OutboxEvent.objects.filter(id__in=kill_ids, status=OutboxStatus.PROCESSING).exists():
            caught_in_flight = True
            break
        if not OutboxEvent.objects.filter(id__in=kill_ids, processed_at__isnull=True).exists():
            break  # the worker already finished; killing now would prove nothing
        time.sleep(0.005)
    used_signal = primary.kill(signal.SIGKILL)
    unconfirmed_after_kill = OutboxEvent.objects.filter(
        id__in=kill_ids, processed_at__isnull=True
    ).count()
    record(
        "worker_killed_mid_flight",
        worker="drill-primary",
        signal=int(used_signal),
        rows=len(kill_ids),
        caught_while_processing=caught_in_flight,
        unconfirmed_after_kill=unconfirmed_after_kill,
        real=True,
    )
    lease_seconds = int(settings.OUTBOX_LEASE_SECONDS)
    evidence_before_kill = LearningEvidence.objects.filter(attempt=kill_attempt, is_active=True).count()

    def recover_killed_rows():
        outbox.dispatch_pending(limit=50)
        return not OutboxEvent.objects.filter(id__in=kill_ids, processed_at__isnull=True).exists()

    primary.start()
    try:
        wait_for(
            recover_killed_rows,
            timeout=max(60.0, lease_seconds * 4),
            interval=1.0,
            description="the killed worker's rows to be recovered after the lease expired",
        )
    except TimeoutError as exc:
        fail("killed_worker_recovery", reason=str(exc))
    else:
        once, evidence_after_kill = evidence_applied_exactly_once(kill_attempt)
        record(
            "killed_worker_recovery",
            ok=once,
            evidence_rows=evidence_after_kill,
            evidence_before_recovery=evidence_before_kill,
            applied_exactly_once=once,
            lease_seconds=lease_seconds,
            real=True,
        )
        if not once:
            fail("killed_worker_recovery", reason=f"evidence applied more than once: {evidence_after_kill} rows")

    # ---------------------------------------------------------------- step 5
    # Two real consumers on the same queues: the lease, not luck, decides who
    # applies the effect.
    secondary.start()
    record("second_consumer_started", workers=2, real=True)
    _pair_item, pair_attempt, _pair_grade = submit_one_attempt(
        user=user, project=project, subject=subject, version=version, payload=payload
    )
    pair_rows = list(OutboxEvent.objects.filter(payload__attempt_id=str(pair_attempt.id)))
    record("pair_rows_dispatched", rows=len(pair_rows), queue_depth=queue_depth(client), real=True)
    try:
        wait_for(
            lambda: not OutboxEvent.objects.filter(
                id__in=[r.id for r in pair_rows], processed_at__isnull=True
            ).exists(),
            timeout=90,
            description="both consumers to settle every row",
        )
    except TimeoutError as exc:
        record(
            "two_consumers_timeout_detail",
            states=[
                {"id": str(r.id), "topic": r.topic, "status": r.status, "attempts": r.attempts}
                for r in OutboxEvent.objects.filter(id__in=[r.id for r in pair_rows])
            ],
            queue_depth=queue_depth(client),
            primary_alive=primary.alive(),
            secondary_alive=secondary.alive(),
        )
        fail("two_consumers_apply_once", reason=str(exc))
    once, evidence_rows = evidence_applied_exactly_once(pair_attempt)
    record(
        "two_consumers_apply_once",
        ok=once,
        evidence_rows=evidence_rows,
        rows=len(pair_rows),
        real=True,
    )
    if not once:
        fail("two_consumers_apply_once", reason=f"two consumers did not apply exactly once: {evidence_rows} rows")
    secondary.kill()
    primary.kill()
    record("workers_stopped", workers=["drill-primary", "drill-secondary"], real=True)

    # ---------------------------------------------------------------- summary
    drill_rows = set(
        OutboxEvent.objects.filter(created_at__gte=REPORT_STARTED_AT).values_list("id", flat=True)
    )
    drill_unresolved = OutboxEvent.objects.filter(
        id__in=drill_rows, processed_at__isnull=True
    ).count() if drill_rows else 0
    legacy_unresolved = OutboxEvent.objects.filter(
        id__in=pre_existing, processed_at__isnull=True
    ).count() if pre_existing else 0
    remaining = outbox.unresolved_summary()
    REPORT["unresolved"] = remaining
    REPORT["drill_rows"] = len(drill_rows)
    REPORT["drill_rows_unresolved"] = drill_unresolved
    REPORT["pre_existing_rows_unresolved"] = legacy_unresolved
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
    if drill_unresolved:
        fail("all_events_resolved", reason=f"the drill left {drill_unresolved} row(s) unresolved")
    if legacy_unresolved:
        note(
            f"{legacy_unresolved} pre-existing row(s) (created before this drill) are still "
            "unconfirmed; their own lease has to expire before the scan may reclaim them. "
            "They are excluded from the drill verdict and reported here instead."
        )

    report_path = os.environ.get("ACEPASS_WORKER_DRILL_REPORT")
    if report_path:
        Path(report_path).write_text(json.dumps(REPORT, ensure_ascii=False, indent=2, default=str))
        note(f"report written to {report_path}")
    print(json.dumps({"ok": REPORT["ok"]}, ensure_ascii=False))
    return 0 if REPORT["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
