"""W4 counter-example ② — the read path's query count must not grow with the
number of rows.

This probe is written from scratch and does **not** import the author's
regression tests or the Lead's ``perfprobe`` module. It measures with
``CaptureQueriesContext`` on the same session/connection the request runs on and
asserts the property the optimisation claims:

* ``GET /api/v1/projects/{id}/questions?limit=N``  — N=5 vs N=40, same query count
* ``GET /api/v1/projects/{id}/practice-sessions?limit=50`` — 5 rows vs 40 rows,
  same query count

It also records a *shape* fingerprint of every response (top-level keys, per-item
key -> value types, list lengths). Seeding is deterministic, so the ``before``
and ``after`` fingerprints must be byte-identical apart from ids/timestamps —
this is the independent check that the optimisation did not narrow a response.

Run (from the repository root)::

    PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-28/optimization/probes" \\
      W4_PROBE_LABEL=before \\
      backend/.venv/bin/python -m pytest \\
      docs/review/2026-09-28/optimization/probes/test_w4_read_path_query_count.py \\
      -c backend/pytest.ini --ds=verifier_settings -q
"""

from __future__ import annotations

import json
import os
from contextlib import ExitStack
from pathlib import Path

import pytest
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext, override_settings
from django.utils import timezone

pytestmark = pytest.mark.django_db

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE.parent / "logs"
LABEL = os.environ.get("W4_PROBE_LABEL", "run")
REPORT_PATH = LOG_DIR / f"probe-readpath-{LABEL}.json"

OWNER_EMAIL = "w4-verifier@test.local"
OWNER_PASSWORD = "W4Verifier!2026"
FIRST_ROWS = 5
TOTAL_ROWS = 40

REPORT: dict = {"probe": "w4-read-path-query-count", "label": LABEL, "cases": []}


def _write_report() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"W4PROBE wrote {REPORT_PATH}", flush=True)


@pytest.fixture(scope="module", autouse=True)
def _dump_report():
    yield
    _write_report()


def _type_of(value) -> str:
    if isinstance(value, bool):
        return "bool"
    if value is None:
        return "null"
    if isinstance(value, str):
        return "str"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "dict"
    return type(value).__name__


def _fingerprint(body) -> dict:
    """Deterministic shape of a response: keys + value types + list lengths."""
    if isinstance(body, list):
        top = "list"
        items = body
        extra: dict = {}
    elif isinstance(body, dict):
        top = "dict"
        items = body.get("items") if isinstance(body.get("items"), list) else []
        extra = {k: _type_of(v) for k, v in sorted(body.items()) if k != "items"}
    else:  # pragma: no cover - defensive
        return {"top": _type_of(body)}
    item_types: dict[str, set[str]] = {}
    for item in items:
        if isinstance(item, dict):
            for key, value in item.items():
                item_types.setdefault(key, set()).add(_type_of(value))
    return {
        "top": top,
        "row_count": len(items),
        "extra_keys": extra,
        "item_keys": {key: sorted(types) for key, types in sorted(item_types.items())},
    }


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


def _clone_published_questions(sources: list, *, count: int, label_prefix: str) -> int:
    """Clone published demo questions so the list endpoint really has 40+ rows.

    A clone copies the published version, its checked answer key and its
    knowledge mappings, so the cloned rows exercise the same per-row work as the
    demo rows (this is what makes "queries do not grow with rows" meaningful).
    """
    from apps.knowledge.models import QuestionKnowledge
    from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion

    created = 0
    index = 0
    while created < count:
        source = sources[index % len(sources)]
        index += 1
        published = source.current_published_version
        if published is None:  # pragma: no cover - defensive
            continue
        question = Question.objects.create(
            subject=source.subject,
            origin_type=source.origin_type,
            is_demo=True,
            display_label=f"{label_prefix}-{created + 1}",
            created_by=source.created_by,
        )
        version = QuestionVersion.objects.create(
            question=question,
            version=1,
            question_type=published.question_type,
            content=published.content,
            practice_max_score=published.practice_max_score,
            estimated_seconds=published.estimated_seconds,
            status=published.status,
            created_by=published.created_by,
            published_at=published.published_at or timezone.now(),
            content_digest=published.content_digest,
        )
        question.current_published_version = version
        question.save(update_fields=["current_published_version", "updated_at"])
        for key in published.answer_keys.all():
            AnswerKeyVersion.objects.create(
                question_version=version,
                version=key.version,
                answer_payload=key.answer_payload,
                source_type=key.source_type,
                verification_status=key.verification_status,
                is_disputed=key.is_disputed,
                explanation_blocks=key.explanation_blocks,
                created_by=key.created_by,
            )
        for mapping in published.knowledge_mappings.all():
            QuestionKnowledge.objects.create(
                question_version=version,
                mapping_revision=mapping.mapping_revision,
                node=mapping.node,
                is_primary=mapping.is_primary,
                score_weight=mapping.score_weight,
                template=mapping.template,
                note=mapping.note,
            )
        created += 1
    return created


@pytest.fixture(scope="module")
def fixture_data(django_db_setup, django_db_blocker, tmp_path_factory):
    """Committed demo fixture with exactly ``FIRST_ROWS`` practice sessions."""
    from apps.accounts.models import User
    from apps.accounts.services.demo_fixture import load_demo_fixture
    from apps.exams.models import Subject
    from apps.ingestion.storage import reset_storage_cache
    from apps.question_bank.models import Question, QuestionVersion

    media = tmp_path_factory.mktemp("w4-verify-media")
    stack = ExitStack()
    with django_db_blocker.unblock():
        stack.enter_context(override_settings(PRIVATE_MEDIA_ROOT=str(media), MEDIA_ROOT=str(media)))
        reset_storage_cache()

        User.objects.create_user(email=OWNER_EMAIL, password=OWNER_PASSWORD, display_name="W4 复验者")
        demo = load_demo_fixture(OWNER_EMAIL)
        project = demo["project_a"]
        subject = Subject.objects.filter(project=project).order_by("display_order").first()
        client = _login(Client())

        total_questions = Question.objects.filter(subject__project=project).count()
        sources = list(
            Question.objects.filter(subject=subject, current_published_version__isnull=False)
            .select_related("current_published_version")
            .order_by("display_label")[:8]
        )
        assert sources, "the demo fixture must contain published single-choice questions"
        cloned = 0
        if total_questions < TOTAL_ROWS:
            cloned = _clone_published_questions(
                sources, count=TOTAL_ROWS - total_questions, label_prefix="W4克隆题"
            )

        versions = list(
            QuestionVersion.objects.filter(
                question__subject=subject, question_type="single_choice", status="published"
            )
            .select_related("question")
            .order_by("question__display_label")[:8]
        )
        created = 0
        for index in range(FIRST_ROWS):
            version = versions[index % len(versions)]
            response = _post(
                client,
                f"/api/v1/projects/{project.id}/practice-sessions",
                {"mode": "practice", "subject_id": str(subject.id), "question_ids": [str(version.question_id)]},
                key=f"w4-verifier-seed-{index}",
            )
            if response.status_code == 201:
                created += 1
        assert created == FIRST_ROWS, f"seeded {created}/{FIRST_ROWS} sessions"

        try:
            yield {
                "client": client,
                "project_id": str(project.id),
                "subject_id": str(subject.id),
                "questions_before_clone": total_questions,
                "questions_cloned": cloned,
                "sessions": created,
            }
        finally:
            stack.close()


def _measure(client: Client, path: str, *, repeats: int = 3) -> dict:
    samples = []
    for _ in range(repeats):
        with CaptureQueriesContext(connection) as captured:
            response = client.get(path)
        body = response.json()
        samples.append(
            {
                "status": response.status_code,
                "queries": len(captured.captured_queries),
                "bytes": len(response.content),
                "fingerprint": _fingerprint(body),
            }
        )
    assert samples[0]["status"] == 200, f"{path} -> {samples[0]['status']}"
    query_counts = {sample["queries"] for sample in samples}
    assert len(query_counts) == 1, f"{path} query count varies between repeats: {query_counts}"
    first = dict(samples[0])
    first["path"] = path
    first["repeats"] = repeats
    first["query_count_stable_across_repeats"] = True
    return first


def test_query_count_does_not_grow_with_row_count(fixture_data):
    client: Client = fixture_data["client"]
    project_id = fixture_data["project_id"]

    small_sessions = _measure(client, f"/api/v1/projects/{project_id}/practice-sessions?limit=50")
    small_questions = _measure(client, f"/api/v1/projects/{project_id}/questions?limit={FIRST_ROWS}")

    # Grow to TOTAL_ROWS practice sessions through the real API.
    from apps.exams.models import Subject
    from apps.practice.models import PracticeSession
    from apps.question_bank.models import QuestionVersion

    project = PracticeSession.objects.filter(project_id=project_id).first().project
    subject = Subject.objects.filter(project=project).order_by("display_order").first()
    versions = list(
        QuestionVersion.objects.filter(
            question__subject=subject, question_type="single_choice", status="published"
        )
        .select_related("question")
        .order_by("question__display_label")[:8]
    )
    grown = 0
    for index in range(FIRST_ROWS, TOTAL_ROWS):
        version = versions[index % len(versions)]
        response = _post(
            client,
            f"/api/v1/projects/{project_id}/practice-sessions",
            {"mode": "practice", "subject_id": str(subject.id), "question_ids": [str(version.question_id)]},
            key=f"w4-verifier-seed-{index}",
        )
        if response.status_code == 201:
            grown += 1
    assert grown == TOTAL_ROWS - FIRST_ROWS, f"grew only {grown} sessions"

    large_sessions = _measure(client, f"/api/v1/projects/{project_id}/practice-sessions?limit=50")
    large_questions = _measure(client, f"/api/v1/projects/{project_id}/questions?limit={TOTAL_ROWS}")

    cases = {
        "practice_sessions_list": {
            "small": small_sessions,
            "large": large_sessions,
            "target_queries": 12,
        },
        "questions_list": {
            "small": small_questions,
            "large": large_questions,
            "target_queries": 12,
        },
    }
    for name, case in cases.items():
        small, large = case["small"], case["large"]
        case["rows_small"] = small["fingerprint"]["row_count"]
        case["rows_large"] = large["fingerprint"]["row_count"]
        case["queries_small"] = small["queries"]
        case["queries_large"] = large["queries"]
        case["independent_of_rows"] = small["queries"] == large["queries"]
        case["under_target"] = large["queries"] <= case["target_queries"]
        case["verdict"] = (
            "PASS"
            if case["independent_of_rows"] and case["under_target"] and case["rows_large"] > case["rows_small"]
            else "FAIL"
        )
    REPORT["cases"] = [{"case": name, **case} for name, case in cases.items()]
    REPORT["fixture"] = {k: v for k, v in fixture_data.items() if k != "client"}
    _write_report()
    print("W4PROBE summary " + json.dumps(REPORT["cases"], ensure_ascii=False, default=str), flush=True)

    for name, case in cases.items():
        assert case["rows_large"] > case["rows_small"], f"{name}: row counts did not grow ({case})"
        assert case["independent_of_rows"], (
            f"{name}: query count still grows with rows "
            f"({case['rows_small']} rows -> {case['queries_small']} queries, "
            f"{case['rows_large']} rows -> {case['queries_large']} queries)"
        )
        assert case["under_target"], (
            f"{name}: {case['queries_large']} queries at {case['rows_large']} rows exceeds the ≤12 target"
        )
