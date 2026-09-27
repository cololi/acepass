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
3. it refuses to run outside a dedicated acceptance database unless ``--allow``
  names the database explicitly, so a typo cannot rewrite production data.

Run against a copy first:

    POSTGRES_DB=acepass_acceptance_… DJANGO_SETTINGS_MODULE=config.settings.dev \
      backend/.venv/bin/python manage.py audit_projection_semantics --allow acepass_acceptance_…
"""

from __future__ import annotations

from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from apps.common.enums import GradeStatus
from apps.learning.services import evidence as evidence_service
from apps.practice.models import Attempt, GradeEvent, LearningEvidence

ALLOWED_DB_PREFIXES = ("acepass_browser_audit_", "acepass_acceptance_", "test_acepass")


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

        rewritten = 0
        with transaction.atomic():
            for grade in grades:
                change = classify_grade_event(grade)
                if change is None:
                    continue
                expected_pending = _pending_from_parts(grade.parts)
                expected_fully = _is_fully_confirmed(grade.parts)
                grade.pending_max_score = expected_pending
                grade.is_fully_confirmed = expected_fully
                grade.status = GradeStatus.CONFIRMED if expected_fully else GradeStatus.PENDING_REVIEW
                grade.save(update_fields=["pending_max_score", "is_fully_confirmed", "status", "updated_at"])
                rewritten += 1
        self.stdout.write(f"grade_events_rewritten={rewritten}")

        rebuilt = 0
        attempt_ids = (
            Attempt.objects.filter(evidence_rows__isnull=False).values_list("id", flat=True).distinct()
        )
        for attempt_id in attempt_ids:
            rebuilt += evidence_service.rebuild_for_attempt(str(attempt_id))
        self.stdout.write(f"evidence_rows_rebuilt={rebuilt}")
        self.stdout.write("done: raw answers, attempts and grade-event history were not modified")
