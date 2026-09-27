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


def redis_identity(client) -> dict:
    """Name the exact Redis instance this drill will FLUSHALL.

    ``FLUSHALL`` wipes the whole instance, so switching the database *number* is
    not isolation: a second user of the same instance loses its queue too. The
    endpoint and the server ``run_id`` are recorded so the evidence identifies the
    instance, and the caller has to acknowledge the flush explicitly.
    """
    kwargs = client.connection_pool.connection_kwargs
    info = client.info("server")
    return {
        "host": kwargs.get("host"),
        "port": kwargs.get("port"),
        "db": kwargs.get("db"),
        "redis_version": info.get("redis_version"),
        "run_id": info.get("run_id"),
        "mode": "dedicated_instance",
    }


def guard_redis(client) -> dict:
    """Refuse to flush an instance the operator has not declared dedicated."""
    if os.environ.get("ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL") != "1":
        print(
            "refusing to run: this drill calls FLUSHALL on the whole Redis instance.\n"
            "Isolation is an *exclusive Redis instance* (changing the DB number does not\n"
            "isolate anything). Start one, point REDIS_URL at it, make sure nothing else\n"
            "uses it, then set ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 to acknowledge.",
            file=sys.stderr,
        )
        sys.exit(2)
    identity = redis_identity(client)
    existing = sum(1 for _ in client.scan_iter(match="*", count=500))
    identity["keys_before_drill"] = existing
    return identity


def tutor_message_counts(job) -> tuple[int, int]:
    """``(assistant turns, exposure events)`` for one tutor job."""
    from apps.practice.models import ExposureEvent
    from apps.tutoring.models import TutorTurn

    turns = TutorTurn.objects.filter(job=job, role="assistant").count()
    exposures = ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count()
    return turns, exposures


def run_steps(  # noqa: C901 - a drill reads better as one explicit sequence
    *,
    client,
    user,
    project,
    subject,
    version,
    payload,
    primary: Worker,
    secondary: Worker,
    pre_existing: set,
    started_at,
) -> None:
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
    # being consumed (polled at 5 ms). The kill scenario only counts as passed
    # when a task was really caught in flight — killing an idle worker proves
    # nothing, so that outcome is a failure, not a softer "ok".
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
    if not caught_in_flight:
        fail(
            "killed_worker_recovery",
            reason="no task was observed in the processing state before the kill; "
            "the kill proved nothing, so this scenario is not passed",
        )
    lease_seconds = int(settings.OUTBOX_LEASE_SECONDS)
    evidence_before_kill = LearningEvidence.objects.filter(attempt=kill_attempt, is_active=True).count()

    def recover_killed_rows():
        outbox.dispatch_pending(limit=50)
        return not OutboxEvent.objects.filter(id__in=kill_ids, processed_at__isnull=True).exists()

    primary.start()
    if caught_in_flight:
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
    # Two real consumers, the SAME event delivered twice, and a consumer that
    # loses its lease and returns late.
    #
    # "No duplicate evidence rows" only shows the projection converged; it says
    # nothing about the tutor's business facts. This step therefore asserts the
    # assistant message and the exposure too, and it does not rely on the two
    # workers happening to pick different events.
    _step5_two_consumers_same_event(
        client=client,
        user=user,
        item=kill_attempt.session_item,
        primary=primary,
        secondary=secondary,
        lease_seconds=lease_seconds,
    )

    # ---------------------------------------------------------------- summary
    drill_rows = set(
        OutboxEvent.objects.filter(created_at__gte=started_at).values_list("id", flat=True)
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


def _step5_two_consumers_same_event(*, client, user, item, primary, secondary, lease_seconds: int) -> None:
    """Real duplicate delivery + a late consumer, with tutor business facts."""
    import threading

    from ai.providers import base as providers
    from apps.tutoring.models import TutorJob
    from apps.tutoring.services import core as tutor_services
    from apps.tutoring.tasks import run_tutor_job

    secondary.start()
    primary.start()
    record("second_consumer_started", workers=2, real=True)

    tutor_session = tutor_services.create_tutor_session(item=item, user=user, purpose="explanation")
    job = tutor_services.create_job(tutor_session=tutor_session, user=user, user_question="解释本题")
    event = OutboxEvent.objects.get(dedupe_key=f"tutor-job:{job.id}")
    payload = dict(event.payload)

    # The late consumer: this process claims the event, then spends far longer
    # than the lease inside the (stub) model call. Its result must never land.
    original_call = providers.call_with_deadline
    entered = threading.Event()
    stale_result = {"returned": False, "assistant_turns": None, "exposures": None}

    def slow_call(provider, request, **kwargs):
        entered.set()
        time.sleep(lease_seconds * 3)
        body = {
            "explanation_blocks": [{"kind": "text", "text": "stale-consumer-must-not-win"}],
            "citations": [],
            "missing_information": [],
            "suggested_next": [],
        }
        return providers.AiCallResult(payload=body, raw_text=json.dumps(body), is_stub=True)

    def stale_consumer():
        providers.call_with_deadline = slow_call
        try:
            run_tutor_job(outbox_event_id=str(event.id), **payload)
        finally:
            providers.call_with_deadline = original_call
        event.refresh_from_db()
        job.refresh_from_db()
        turns, exposures = tutor_message_counts(job)
        stale_result.update(
            {
                "returned": True,
                "outbox_status": event.status,
                "job_status": job.status,
                "result_blocks": job.result_blocks,
                "assistant_turns": turns,
                "exposures": exposures,
            }
        )

    thread = threading.Thread(target=stale_consumer, name="stale-consumer", daemon=True)
    thread.start()
    if not entered.wait(timeout=30):
        fail("stale_consumer_takeover", reason="the in-process consumer never reached the model call")
        thread.join(timeout=60)
        return
    event.refresh_from_db()
    record(
        "stale_consumer_holds_lease",
        outbox_event_id=str(event.id),
        status=event.status,
        lease_seconds=lease_seconds,
        real=True,
    )

    # ACTIVELY deliver the same event a second time while the lease is still live.
    from config.celery import app as celery_app

    celery_app.send_task(event.topic, kwargs={"outbox_event_id": str(event.id), **payload})
    record("duplicate_delivery_sent", outbox_event_id=str(event.id), topic=event.topic, real=True)
    try:
        wait_for(
            lambda: OutboxEvent.objects.filter(id=event.id).exclude(attempts=1).exists()
            or OutboxEvent.objects.filter(id=event.id, processed_at__isnull=False).exists(),
            timeout=30,
            description="a second consumer to observe the duplicate delivery",
        )
        duplicate_disposition = "observed_by_second_consumer"
    except TimeoutError:
        duplicate_disposition = "consumed_by_the_holder_only"

    # Now let the lease expire and let the real worker take the event over.
    def takeover():
        outbox.dispatch_pending(limit=50)
        return OutboxEvent.objects.filter(id=event.id, processed_at__isnull=False).exists()

    try:
        wait_for(
            takeover,
            timeout=max(60.0, lease_seconds * 6),
            interval=1.0,
            description="the real worker to take the expired lease over and finish the job",
        )
    except TimeoutError as exc:
        fail("stale_consumer_takeover", reason=f"takeover never happened: {exc}")

    thread.join(timeout=max(60.0, lease_seconds * 6))
    thread_finished = not thread.is_alive()
    job.refresh_from_db()
    event.refresh_from_db()
    turns, exposures = tutor_message_counts(job)
    record(
        "stale_consumer_takeover",
        ok=thread_finished and stale_result.get("returned") is True and turns == 1 and exposures == 1,
        duplicate_delivery=duplicate_disposition,
        stale_consumer_returned=stale_result.get("returned") is True,
        stale_consumer_result_blocks=stale_result.get("result_blocks"),
        assistant_turns=turns,
        exposures=exposures,
        job_status=job.status,
        outbox_status=event.status,
        real=True,
    )
    if not thread_finished:
        fail("stale_consumer_takeover", reason="the stale consumer never returned, so the case was not exercised")
    elif stale_result.get("returned") is not True:
        fail("stale_consumer_takeover", reason="the stale consumer did not reach the write-back path")
    elif job.result_blocks and job.result_blocks[0].get("text") == "stale-consumer-must-not-win":
        fail("stale_consumer_takeover", reason="the stale consumer overwrote the takeover's result")
    elif turns != 1 or exposures != 1:
        fail(
            "stale_consumer_takeover",
            reason=f"assistant messages/exposures are not exactly one: turns={turns} exposures={exposures}",
        )
    elif TutorJob.objects.filter(id=job.id).count() != 1:
        fail("stale_consumer_takeover", reason="the job row was duplicated")
    elif event.status != OutboxStatus.PROCESSED:
        fail("stale_consumer_takeover", reason=f"the event is not confirmed: {event.status}")


def main() -> int:  # noqa: C901 - a drill script reads better as one sequence
    database = guard_database()
    started_at = timezone.now()
    client = redis_client()
    identity = guard_redis(client)
    record(
        "environment",
        database=database,
        redis_url=os.environ["REDIS_URL"],
        redis_instance=identity,
        inline=outbox.inline_mode(),
        outbox_lease_seconds=int(settings.OUTBOX_LEASE_SECONDS),
        ai_provider=(getattr(settings, "AI_PROVIDER", "") or "none"),
    )
    if (getattr(settings, "AI_PROVIDER", "") or "none").lower() != "stub":
        fail(
            "environment",
            reason="the tutor consistency step needs the stub provider "
            "(ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub); refusing to report a "
            "diagnostic-only run as an async acceptance pass",
        )
        return 1

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

    try:
        run_steps(
            client=client,
            user=user,
            project=project,
            subject=subject,
            version=version,
            payload=payload,
            primary=primary,
            secondary=secondary,
            pre_existing=pre_existing,
            started_at=started_at,
        )
    finally:
        # finally 清理：任何一个步骤抛异常都不能把 worker 留在后台运行。
        stopped = []
        for worker in (primary, secondary):
            try:
                if worker.alive():
                    worker.kill()
                    stopped.append(worker.name)
            except Exception as exc:  # noqa: BLE001 - cleanup must never mask the real failure
                record("worker_stop_failed", worker=worker.name, error=str(exc))
        record("workers_stopped_in_finally", workers=stopped, real=True)

    report_path = os.environ.get("ACEPASS_WORKER_DRILL_REPORT")
    if report_path:
        Path(report_path).write_text(json.dumps(REPORT, ensure_ascii=False, indent=2, default=str))
        note(f"report written to {report_path}")
    print(json.dumps({"ok": REPORT["ok"]}, ensure_ascii=False))
    return 0 if REPORT["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
