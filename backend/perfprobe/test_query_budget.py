"""Before/after instrument for read-path optimisation.

The point of this module is that an optimisation claim ("fewer queries",
"faster list endpoint") becomes a *number produced by a repeatable command*
instead of an opinion. It asserts nothing on purpose: budgets live in the
regression tests written next to the code they protect.

Usage::

    bash scripts/dev/measure-hot-paths.sh                    # every case
    bash scripts/dev/measure-hot-paths.sh -k practice         # one case
    PERFPROBE_OUT=var/perfprobe/after.json bash scripts/dev/measure-hot-paths.sh

Output: one ``PERFPROBE {json}`` line per case on stdout, plus the same payload
(when ``PERFPROBE_OUT`` is set) written as a JSON array.

Data is seeded once per module on a dedicated database
(``POSTGRES_DB=acepass_perfprobe`` by default, so it never collides with a
concurrent acceptance run) and each case measures the same fixture.
"""

from __future__ import annotations

import json
import os
import statistics
import time
from contextlib import ExitStack
from pathlib import Path

import pytest
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext, override_settings
from django.utils import timezone

pytestmark = pytest.mark.django_db

OWNER_EMAIL = "perfprobe@test.local"
OWNER_PASSWORD = "PerfProbe!2026"

#: How many practice sessions to seed, so a list endpoint's per-row work shows.
SEEDED_SESSIONS = int(os.environ.get("PERFPROBE_SESSIONS", "20"))
#: Repeats per case; the median is reported (first request can warm caches).
REPEATS = 3

_RESULTS: list[dict] = []


def _login(client: Client) -> Client:
    client.get("/api/v1/auth/csrf")
    token = client.cookies["csrftoken"].value
    response = client.post(
        "/api/v1/auth/login",
        data={"email": OWNER_EMAIL, "password": OWNER_PASSWORD},
        content_type="application/json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert response.status_code == 200, response.content
    return client


def _post(client: Client, path: str, body: dict, key: str):
    token = client.cookies["csrftoken"].value
    return client.post(
        path,
        data=body,
        content_type="application/json",
        HTTP_X_CSRFTOKEN=token,
        HTTP_IDEMPOTENCY_KEY=key,
    )


@pytest.fixture(scope="module")
def probe(django_db_setup, django_db_blocker, tmp_path_factory):
    """One committed fixture set (owner, demo content, N practice sessions)."""
    from apps.accounts.models import User
    from apps.accounts.services.demo_fixture import load_demo_fixture
    from apps.exams.models import Subject
    from apps.ingestion.storage import reset_storage_cache
    from apps.question_bank.models import QuestionVersion

    media = tmp_path_factory.mktemp("perfprobe-media")
    stack = ExitStack()
    with django_db_blocker.unblock():
        stack.enter_context(override_settings(PRIVATE_MEDIA_ROOT=str(media), MEDIA_ROOT=str(media)))
        reset_storage_cache()

        User.objects.create_user(email=OWNER_EMAIL, password=OWNER_PASSWORD, display_name="探针用户")
        demo = load_demo_fixture(OWNER_EMAIL)
        project = demo["project_a"]
        subject = Subject.objects.filter(project=project).order_by("display_order").first()
        client = _login(Client())

        versions = list(
            QuestionVersion.objects.filter(
                question__subject=subject, question_type="single_choice", status="published"
            )
            .select_related("question")
            .order_by("question__display_label")[:8]
        )
        assert versions, "demo fixture must contain published single-choice questions"

        created = 0
        for index in range(SEEDED_SESSIONS):
            version = versions[index % len(versions)]
            response = _post(
                client,
                f"/api/v1/projects/{project.id}/practice-sessions",
                {"mode": "practice", "subject_id": str(subject.id), "question_ids": [str(version.question_id)]},
                key=f"perfprobe-seed-{index}",
            )
            if response.status_code == 201:
                created += 1
        assert created == SEEDED_SESSIONS, f"seeded {created}/{SEEDED_SESSIONS} sessions"

        try:
            yield {
                "client": client,
                "project_id": str(project.id),
                "subject_id": str(subject.id),
                "sessions": created,
            }
        finally:
            stack.close()


def _measure(name: str, factory, *, repeats: int = REPEATS) -> dict:
    """Run one request factory repeatedly and report queries + median wall time."""
    samples: list[float] = []
    status = None
    queries = None
    body_bytes = None
    for index in range(repeats):
        started = time.perf_counter()
        with CaptureQueriesContext(connection) as captured:
            response = factory()
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        samples.append(elapsed_ms)
        status = response.status_code
        queries = len(captured.captured_queries)
        body_bytes = len(response.content)
        assert status < 500, f"{name} returned {status}: {response.content[:400]!r}"
        if index == 0:
            # Fail fast and loudly rather than measuring an endpoint that 4xx's.
            assert status == 200, f"{name} returned {status}: {response.content[:400]!r}"
    row = {
        "case": name,
        "status": status,
        "queries": queries,
        "median_ms": round(statistics.median(samples), 2),
        "min_ms": round(min(samples), 2),
        "bytes": body_bytes,
        "at": timezone.now().isoformat(timespec="seconds"),
    }
    _RESULTS.append(row)
    print(f"PERFPROBE {json.dumps(row, ensure_ascii=False)}", flush=True)
    return row


def test_query_budget_probe(probe, request, pytestconfig):
    """Every case in one test, so the fixture is seeded exactly once."""
    client: Client = probe["client"]
    project_id = probe["project_id"]
    subject_id = probe["subject_id"]
    get = client.get

    cases = {
        "practice_sessions_list": lambda: get(
            f"/api/v1/projects/{project_id}/practice-sessions?limit=50"
        ),
        "questions_list": lambda: get(f"/api/v1/projects/{project_id}/questions?limit=50"),
        "grading_queue": lambda: get(f"/api/v1/projects/{project_id}/grading-queue"),
        "memory_cards": lambda: get(f"/api/v1/projects/{project_id}/memory-cards?limit=50"),
        "knowledge_map": lambda: get(
            f"/api/v1/projects/{project_id}/knowledge-map?subject_id={subject_id}"
        ),
        "knowledge_nodes": lambda: get(f"/api/v1/projects/{project_id}/knowledge-nodes"),
        "today_plan": lambda: get("/api/v1/study-plans/today"),
        "reports_practice": lambda: get(f"/api/v1/projects/{project_id}/reports/practice"),
        "search_hybrid": lambda: get(f"/api/v1/projects/{project_id}/search?q=%E5%87%BD%E6%95%B0&limit=10"),
        "question_families": lambda: get(f"/api/v1/projects/{project_id}/question-families"),
    }

    keyword = pytestconfig.getoption("-k") or ""
    for name, factory in cases.items():
        if keyword and keyword not in name:
            continue
        _measure(name, factory)

    out = os.environ.get("PERFPROBE_OUT")
    assert out, "PERFPROBE_OUT must point at a writable path (see scripts/dev/measure-hot-paths.sh)"
    target = Path(out)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "seeded_sessions": probe["sessions"],
        "repeats": REPEATS,
        "cases": _RESULTS,
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PERFPROBE wrote {target}", flush=True)
