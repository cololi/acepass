"""Report (and optionally repair) the projection impact of the P0.1 semantics fix.

The grading fix changed what ``GradeEvent.is_fully_confirmed`` and
``LearningEvidence.is_correct`` mean:

* before: "fully confirmed" required the score to reach full marks, so a wrong
  answer was stored as *not* fully confirmed and an 8/10 manual rubric stayed
  ``pending_review`` with a synthetic pending value;
* after: it means "every scoring part has been decided", and correctness is a
  separate fact.

Rows written by the old code therefore carry the old meaning. This command is
the reviewable step the repair plan asks for:

1. default is a **read-only audit** that prints how many stored rows still
  disagree with the current rules, and what each disagreement is;
2. ``--apply`` rewrites only the *derived projections* — it re-derives
  ``GradeEvent`` status/pending value and rebuilds ``LearningEvidence`` from the
  stored raw answers, answer versions and part scores. It never deletes a
  ``grade_event``, never changes an ``Attempt``, and never touches a raw answer;
3. **every rewritten row keeps its old values.** Each change is recorded as an
  ``audit_content_revision`` row with action ``projection_semantics_rewrite``,
  a batch id, the before/after values, their digests, and the reason (the exact
  disagreement). ``--report <path>`` also dumps the whole batch as JSON.
  ``--include-superseded`` is required to touch grade events that were already
  superseded: by default they are frozen history and stay exactly as they were,
  and the command prints how many it left alone — so "which history was updated"
  is always an explicit, checkable number rather than a claim;
4. it refuses to run outside a dedicated acceptance database unless ``--allow``
  names the database explicitly, so a typo cannot rewrite production data.

Run against a copy first:

    POSTGRES_DB=acepass_acceptance_… DJANGO_SETTINGS_MODULE=config.settings.dev \
      backend/.venv/bin/python manage.py audit_projection_semantics --allow acepass_acceptance_…
"""

from __future__ import annotations

import hashlib
import json
import uuid
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from apps.audit.models import ContentRevision
from apps.common.enums import GradeStatus
from apps.learning.services import evidence as evidence_service
from apps.practice.models import Attempt, GradeEvent, LearningEvidence

ALLOWED_DB_PREFIXES = ("acepass_browser_audit_", "acepass_acceptance_", "test_acepass")


def _digest(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _pending_from_parts(parts) -> Decimal:
    """Pending value implied by the stored parts, under the current rules."""
    total = Decimal("0")
    for part in parts or []:
        if not isinstance(part, dict):
            continue
        if part.get("status") == GradeStatus.CONFIRMED:
            continue
        total += Decimal(str(part.get("max_score") or "0"))
    return total


def _is_fully_confirmed(parts) -> bool:
    return bool(parts) and all(
        isinstance(part, dict) and part.get("status") == GradeStatus.CONFIRMED for part in parts
    )


def classify_grade_event(grade: GradeEvent) -> dict | None:
    """Describe how one stored grade event disagrees with the current rules."""
    if grade.status not in {GradeStatus.CONFIRMED, GradeStatus.PENDING_REVIEW}:
        return None
    parts = grade.parts or []
    if not parts:
        return None
    if grade.status == GradeStatus.PENDING_REVIEW and grade.method == "mixed" and grade.invalidation_reason:
        # A dispute invalidation is intentional, not a semantics artefact.
        return None
    expected_pending = _pending_from_parts(parts)
    expected_fully = _is_fully_confirmed(parts)
    stored_pending = Decimal(str(grade.pending_max_score or "0"))
    problems = []
    if stored_pending != expected_pending:
        problems.append(f"pending_max_score {stored_pending} → {expected_pending}")
    if bool(grade.is_fully_confirmed) != expected_fully:
        problems.append(f"is_fully_confirmed {grade.is_fully_confirmed} → {expected_fully}")
    expected_status = GradeStatus.CONFIRMED if expected_fully else GradeStatus.PENDING_REVIEW
    if grade.status != expected_status:
        problems.append(f"status {grade.status} → {expected_status}")
    if not problems:
        return None
    return {
        "grade_event_id": str(grade.id),
        "attempt_id": str(grade.attempt_id),
        "kind": grade.kind,
        "problems": problems,
    }


class Command(BaseCommand):
    help = "Audit (and optionally rewrite) projections written under the old grading semantics."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Rewrite the derived projections.")
        parser.add_argument(
            "--allow",
            default="",
            help="Database name to authorise; required outside a dedicated acceptance database.",
        )
        parser.add_argument("--limit", type=int, default=50, help="How many examples to print.")
        parser.add_argument(
            "--report",
            default="",
            help="Optional path for a JSON batch report containing every before/after pair.",
        )
        parser.add_argument(
            "--include-superseded",
            action="store_true",
            help=(
                "Also rewrite grade events that were already superseded. Off by default: "
                "they are frozen history, and rewriting them changes the record of what was "
                "shown at the time. When enabled the same before/after audit is written."
            ),
        )

    def handle(self, *args, **options):
        database = str(connection.settings_dict["NAME"])
        allowed = str(database).startswith(ALLOWED_DB_PREFIXES) or options["allow"] == database
        if not allowed:
            raise CommandError(
                f"refusing to run against {database!r}: pass --allow {database} to authorise it explicitly, "
                "or use a dedicated acceptance database"
            )

        grades = list(
            GradeEvent.objects.filter(
                status__in=[GradeStatus.CONFIRMED, GradeStatus.PENDING_REVIEW]
            ).select_related("attempt")
        )
        findings = [change for grade in grades if (change := classify_grade_event(grade)) is not None]

        evidence_total = LearningEvidence.objects.filter(is_active=True).count()
        evidence_audit = []
        for row in LearningEvidence.objects.filter(is_active=True).select_related("grade_event")[:2000]:
            grade = row.grade_event
            if grade is None:
                continue
            expected = evidence_service.is_grade_correct(grade)
            if bool(row.is_correct) != expected:
                evidence_audit.append(
                    {
                        "evidence_id": str(row.id),
                        "dimension": row.dimension,
                        "is_correct": row.is_correct,
                        "expected": expected,
                    }
                )

        self.stdout.write(f"database={database}")
        self.stdout.write(f"grade_events_scanned={len(grades)}")
        self.stdout.write(f"grade_events_needing_rewrite={len(findings)}")
        self.stdout.write(f"evidence_active={evidence_total}")
        self.stdout.write(f"evidence_rows_with_is_correct_drift={len(evidence_audit)}")
        for row in findings[: options["limit"]]:
            self.stdout.write(f"  grade_event {row['grade_event_id']} kind={row['kind']}: {'; '.join(row['problems'])}")
        for row in evidence_audit[: options["limit"]]:
            self.stdout.write(
                f"  evidence {row['evidence_id']} {row['dimension']}: is_correct={row['is_correct']} "
                f"→ {row['expected']}"
            )

        if not options["apply"]:
            self.stdout.write("dry-run: no rows were modified (pass --apply to rewrite projections)")
            return

        # A rewrite of historical derivatives is only reviewable if the *old*
        # values survive it. Every changed row is written with a batch id and a
        # full before/after record in `ContentRevision`, and the batch can also be
        # dumped to a JSON report for offline review. Superseded events are left
        # alone by default: they are the frozen history of what was shown at the
        # time, and rewriting them would silently change the past.
        batch_id = uuid.uuid4().hex[:12]
        rewritten = 0
        skipped_superseded = 0
        report_rows: list[dict] = []
        with transaction.atomic():
            for grade in grades:
                change = classify_grade_event(grade)
                if change is None:
                    continue
                if grade.is_superseded and not options["include_superseded"]:
                    skipped_superseded += 1
                    continue
                expected_pending = _pending_from_parts(grade.parts)
                expected_fully = _is_fully_confirmed(grade.parts)
                before = {
                    "pending_max_score": str(grade.pending_max_score),
                    "is_fully_confirmed": bool(grade.is_fully_confirmed),
                    "status": grade.status,
                }
                after = {
                    "pending_max_score": str(expected_pending),
                    "is_fully_confirmed": expected_fully,
                    "status": GradeStatus.CONFIRMED if expected_fully else GradeStatus.PENDING_REVIEW,
                }
                grade.pending_max_score = expected_pending
                grade.is_fully_confirmed = expected_fully
                grade.status = after["status"]
                grade.save(update_fields=["pending_max_score", "is_fully_confirmed", "status", "updated_at"])
                ContentRevision.objects.create(
                    entity_type="grade_event",
                    entity_id=str(grade.id),
                    action="projection_semantics_rewrite",
                    project_id=grade.attempt.project_id if grade.attempt_id else None,
                    reason=f"P0.1 判分语义派生字段迁移 batch={batch_id}：{'; '.join(change['problems'])}"[:500],
                    before_digest=_digest(before),
                    after_digest=_digest(after),
                    detail={
                        "batch_id": batch_id,
                        "before": before,
                        "after": after,
                        "changed_fields": sorted(before.keys()),
                        "was_superseded": bool(grade.is_superseded),
                        "problems": change["problems"],
                    },
                )
                report_rows.append(
                    {
                        "grade_event_id": str(grade.id),
                        "attempt_id": str(grade.attempt_id),
                        "kind": grade.kind,
                        "was_superseded": bool(grade.is_superseded),
                        "before": before,
                        "after": after,
                    }
                )
                rewritten += 1
        self.stdout.write(f"audit_batch_id={batch_id}")
        self.stdout.write(f"grade_events_rewritten={rewritten}")
        self.stdout.write(f"grade_events_left_as_history={skipped_superseded}")
        if options["report"]:
            payload = {
                "batch_id": batch_id,
                "database": database,
                "grade_events_rewritten": rewritten,
                "grade_events_left_as_history": skipped_superseded,
                "rows": report_rows,
            }
            with open(options["report"], "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            self.stdout.write(f"report_written={options['report']}")

        rebuilt = 0
        attempt_ids = (
            Attempt.objects.filter(evidence_rows__isnull=False).values_list("id", flat=True).distinct()
        )
        for attempt_id in attempt_ids:
            rebuilt += evidence_service.rebuild_for_attempt(str(attempt_id))
        self.stdout.write(f"evidence_rows_rebuilt={rebuilt}")
        self.stdout.write(
            "done: raw answers, attempts and evidence source rows were not modified. "
            f"{rewritten} grade_event projection row(s) were rewritten as batch {batch_id} with a "
            "before/after audit in audit_content_revision; "
            f"{skipped_superseded} superseded (historical) row(s) were left untouched."
            if options["apply"]
            else "done"
        )
