#!/usr/bin/env python
"""Generate golden vectors for the pure planning arithmetic.

Oracle: `apps.learning.services.planner.allocate_budget` / `_question_minutes` called with plain
objects (the function touches only attributes), so no database rows are involved. Rotation, the
largest-remainder split and Python's rounding are exactly what must not drift.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_planner_golden.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from apps.learning.services import planner  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "planner.json"


class FakeSettings:
    def __init__(self, percentages: dict[str, float] | None) -> None:
        self.project_budget_percent = percentages


class FakeUser:
    def __init__(self, percentages: dict[str, float] | None) -> None:
        self.settings = FakeSettings(percentages)


class FakeProject:
    def __init__(self, id: str, name: str, target_date: date | None, created_at: datetime) -> None:
        self.id = id
        self.name = name
        self.target_date = target_date
        self.created_at = created_at


CREATED = datetime(2026, 1, 1, 9, 0, tzinfo=timezone.utc)


def project(index: int, *, target: date | None = None, minutes: int = 0) -> FakeProject:
    return FakeProject(
        id=f"p{index}",
        name=f"项目{index}",
        target_date=target,
        created_at=CREATED + timedelta(minutes=minutes),
    )


def main() -> int:
    cases = []

    def case(name: str, projects: list[FakeProject], percentages, budget: int, on_date: date) -> None:
        user = FakeUser(percentages)
        expected = planner.allocate_budget(user, projects, budget, on_date)
        cases.append(
            {
                "name": name,
                "input": {
                    "projects": [
                        {
                            "id": row.id,
                            "name": row.name,
                            "target_date": row.target_date.isoformat() if row.target_date else None,
                            "created_at": row.created_at.isoformat(),
                        }
                        for row in projects
                    ],
                    "percentages": [[key, value] for key, value in (percentages or {}).items()],
                    "budget_minutes": budget,
                    "on_date": on_date.isoformat(),
                },
                "expected": expected,
            }
        )

    day = date(2026, 2, 1)

    case("no-projects", [], None, 120, day)
    case("single-project", [project(1)], None, 120, day)
    case("single-project-zero-budget", [project(1)], None, 0, day)
    case("single-project-one-minute", [project(1)], None, 1, day)
    case("three-projects-even", [project(1), project(2), project(3)], None, 100, day)
    case("seven-projects-even", [project(i) for i in range(1, 8)], None, 1440, day)
    case("three-projects-uneven", [project(1), project(2), project(3)], None, 101, day)
    case("target-date-order", [project(3), project(1, target=date(2026, 5, 1)), project(2, target=date(2026, 3, 1))], None, 90, day)
    case("created-at-tiebreak", [project(1, minutes=5), project(2, minutes=1), project(3, minutes=3)], None, 61, day)
    case("percentages-full", [project(1), project(2)], {"p1": 70.0, "p2": 30.0}, 60, day)
    case("percentages-partial", [project(1), project(2)], {"p1": 40.0}, 60, day)
    case("percentages-all-zero", [project(1), project(2)], {"p1": 0.0, "p2": 0.0}, 60, day)
    case("percentages-over-100", [project(1), project(2)], {"p1": 80.0, "p2": 40.0}, 60, day)
    case("percentages-fractional", [project(1), project(2), project(3)], {"p1": 33.333, "p2": 33.333, "p3": 33.334}, 100, day)
    case("percentages-unknown-id", [project(1)], {"p9": 50.0}, 60, day)
    case("percentages-only-other-project", [project(1), project(2)], {"p1": 100.0, "p9": 50.0}, 30, day)
    case("rotation-day-1", [project(1), project(2), project(3)], None, 100, date(2026, 2, 2))
    case("rotation-day-2", [project(1), project(2), project(3)], None, 100, date(2026, 2, 3))
    case("rotation-day-10", [project(1), project(2), project(3)], None, 100, date(2026, 2, 10))
    case("epoch-day", [project(1), project(2), project(3)], None, 100, date(1970, 1, 1))
    case("leap-day", [project(1), project(2)], None, 45, date(2024, 2, 29))
    case("many-projects-small-budget", [project(i) for i in range(1, 5)], None, 3, day)

    # --- question minutes -------------------------------------------------
    question_cases = []
    for estimated, question_type in [
        (None, "single_choice"),
        (0, "single_choice"),
        (90, "single_choice"),
        (150, "single_choice"),
        (30, "single_choice"),
        (45, "single_choice"),
        (60, "fill_blank"),
        (600, "constructed_response"),
        (841, "unknown_type"),
        (None, "fill_blank"),
        (None, "constructed_response"),
        (None, "unknown_type"),
    ]:
        question_cases.append(
            {
                "facts": {"estimated_seconds": estimated, "question_type": question_type},
                "expected": planner._question_minutes(
                    type(
                        "FakeQuestion",
                        (),
                        {
                            # `_question_minutes` reads current_published_version then versions.
                            "current_published_version": type(
                                "FakeVersion",
                                (),
                                {"estimated_seconds": estimated, "question_type": question_type},
                            )()
                            if estimated is not None or question_type
                            else None
                        },
                    )()
                ),
            }
        )

    payload = {
        "note": "Generated by scripts/gen_planner_golden.py from planner.allocate_budget/_question_minutes.",
        "allocate": cases,
        "question_minutes": question_cases,
        "next_day": [
            {"input": day.isoformat(), "expected": planner.next_day(day).isoformat()},
            {"input": date(2024, 2, 28).isoformat(), "expected": planner.next_day(date(2024, 2, 28)).isoformat()},
            {"input": date(2026, 12, 31).isoformat(), "expected": planner.next_day(date(2026, 12, 31)).isoformat()},
        ],
        "plan_delta_minutes": [
            {"input": {"daily_budget_minutes": 120, "allocated_minutes": 100}, "expected": 20},
            {"input": {"daily_budget_minutes": 0, "allocated_minutes": 0}, "expected": 0},
            {"input": {"daily_budget_minutes": 15, "allocated_minutes": 15}, "expected": 0},
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT}: {len(cases)} budget cases, {len(question_cases)} question-minute cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
