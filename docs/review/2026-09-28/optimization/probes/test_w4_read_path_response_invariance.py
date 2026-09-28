"""W4 adversarial check ② — response-body invariance for the two optimised read
paths, judged by an **independent oracle** instead of the author's body-diff.

Why this exists
---------------

The author (W2) compared `before/after` dumps of the same endpoints. That is
good evidence, but it is their own instrument. This probe re-implements the
*pre-optimisation* handler bodies verbatim (copied out of
``git show HEAD:backend/apps/question_bank/api.py`` and
``git show HEAD:backend/apps/practice/api.py``) as a reference oracle, seeds an
adversarial fixture the author's fixture does not contain, and then requires the
live endpoint to return **byte-identical JSON** to the oracle for every case.

Covered cases (the Lead asked for all of these explicitly):

* ``questions``: no filter / ``subject_id`` / ``question_type`` / ``status`` /
  ``origin_type`` / ``search`` / ``limit+offset`` / empty page / empty subject /
  combined filters / ``limit`` clamping (0 and >100);
* content shapes the simple path hides: a question with **no published version**,
  a published question whose **newest version is a draft**, a published question
  whose answer key is **disputed or only pending**, a published question with
  **only non-primary** knowledge mappings, and the *ordering* of
  ``knowledge_nodes`` and of pages with **tied ``created_at``**;
* ``practice-sessions``: no filter / ``subject_id`` / default limit / small
  limit / ``limit=0`` clamping;
* the **verification-gate semantic counter-example** W2 admits has no regression
  test: a running verification item must make exactly the sessions whose items
  are *covered* (same version, same near-duplicate family, same content lineage)
  report ``grading_hidden=true``, and must not touch uncovered ones.

Run (from the repository root)::

    PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-28/optimization/probes" \\
      W4_PROBE_LABEL=after \\
      backend/.venv/bin/python -m pytest \\
      docs/review/2026-09-28/optimization/probes/test_w4_read_path_response_invariance.py \\
      -c backend/pytest.ini --ds=verifier_settings -q
"""

from __future__ import annotations

import json
import os
from contextlib import ExitStack
from pathlib import Path

import pytest
from django.test import Client
from django.test.utils import override_settings
from django.utils import timezone

pytestmark = pytest.mark.django_db

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE.parent / "logs"
LABEL = os.environ.get("W4_PROBE_LABEL", "run")
REPORT_PATH = LOG_DIR / f"probe-response-invariance-{LABEL}.json"

OWNER_EMAIL = "w4-oracle@test.local"
OWNER_PASSWORD = "W4Oracle!2026"

REPORT: dict = {"probe": "w4-read-path-response-invariance", "label": LABEL, "cases": []}


def _write_report() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"W4PROBE wrote {REPORT_PATH}", flush=True)


@pytest.fixture(scope="module", autouse=True)
def _dump_report():
    yield
    _write_report()


# ---------------------------------------------------------------------------
# Oracle: the pre-optimisation handler bodies, copied verbatim from git HEAD.
# ---------------------------------------------------------------------------
def oracle_list_questions(
    *,
    user,
    project,
    subject_id=None,
    question_type=None,
    status=None,
    origin_type=None,
    search=None,
    limit=20,
    offset=0,
):
    """``git show HEAD:backend/apps/question_bank/api.py`` lines 281-336."""
    from apps.common.scope import require_subject
    from apps.question_bank.models import Question, QuestionVersion

    limit = max(1, min(limit, 100))
    queryset = Question.objects.filter(subject__project=project).select_related("subject")
    if subject_id:
        require_subject(user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    if origin_type:
        queryset = queryset.filter(origin_type=origin_type)
    if search:
        queryset = queryset.filter(display_label__icontains=search.strip()[:60])
    if question_type or status:
        version_filter: dict = {}
        if question_type:
            version_filter["question_type"] = question_type
        if status:
            version_filter["status"] = status
        queryset = queryset.filter(versions__in=QuestionVersion.objects.filter(**version_filter)).distinct()
    items = []
    for question in queryset[offset : offset + limit]:
        published = question.current_published_version
        latest = question.versions.order_by("-version").first()
        answer = None
        if published is not None:
            answer = published.answer_keys.filter(is_disputed=False, verification_status="checked").first()
        items.append(
            {
                "id": str(question.id),
                "subject_id": str(question.subject_id),
                "display_label": question.display_label,
                "origin_type": question.origin_type,
                "is_demo": question.is_demo,
                "question_type": published.question_type if published else (latest.question_type if latest else None),
                "published_version_id": str(published.id) if published else None,
                "latest_version": latest.version if latest else None,
                "has_trusted_answer": answer is not None,
                "knowledge_nodes": [
                    mapping.node.canonical_name
                    for mapping in (published.knowledge_mappings.all() if published else [])
                    if mapping.is_primary
                ],
            }
        )
    return items


def oracle_list_sessions(*, user, project, subject_id=None, limit=20):
    """``git show HEAD:backend/apps/practice/api.py`` lines 311-344."""
    from apps.common.scope import require_subject
    from apps.practice.models import Attempt, PracticeSession
    from apps.practice.services import sessions as session_services
    from apps.practice.services import verification_gate

    session_services.expire_due_mock_exams(user=user, project=project)
    queryset = PracticeSession.objects.filter(project=project, user=user).order_by("-created_at")
    if subject_id:
        require_subject(user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    content_map = verification_gate.active_verification_content_map(user=user)
    rows = []
    for session in queryset[: max(1, min(limit, 50))]:
        withheld = any(
            verification_gate.content_gate_blocks_item(item=item, content_map=content_map)
            for item in session.items.select_related("question_version").all()
        )
        rows.append(
            {
                "session_id": str(session.id),
                "subject_id": str(session.subject_id),
                "mode": session.mode,
                "status": session.status,
                "created_at": session.created_at.isoformat(),
                "item_count": session.items.count(),
                "submitted_count": Attempt.objects.filter(session_item__session=session).count(),
                "grading_hidden": session.hides_grading or withheld,
                "exam_deadline": session.exam_deadline.isoformat() if session.exam_deadline else None,
                "expired_at": session.expired_at.isoformat() if session.expired_at else None,
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------
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


def _make_question(*, subject, label, versions, family=None, lineage=None, node=None, primary=True, created_by=None):
    """``versions`` = list of dicts: {type, status, keys:[{verification_status, is_disputed}]}."""
    from apps.knowledge.models import QuestionKnowledge
    from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion

    question = Question.objects.create(
        subject=subject,
        origin_type="demo",
        is_demo=True,
        display_label=label,
        family=family,
        content_lineage=lineage,
        created_by=created_by,
    )
    made = []
    for index, spec in enumerate(versions, start=1):
        version = QuestionVersion.objects.create(
            question=question,
            version=index,
            question_type=spec["type"],
            content={"blocks": [{"kind": "text", "text": label}]},
            status=spec["status"],
            published_at=timezone.now() if spec["status"] == "published" else None,
            created_by=created_by,
        )
        for key_index, key_spec in enumerate(spec.get("keys", []), start=1):
            AnswerKeyVersion.objects.create(
                question_version=version,
                version=key_index,
                answer_payload={"kind": "text"},
                verification_status=key_spec.get("verification_status", "checked"),
                is_disputed=key_spec.get("is_disputed", False),
                created_by=created_by,
            )
        if spec["status"] == "published":
            question.current_published_version = version
            question.save(update_fields=["current_published_version", "updated_at"])
        made.append(version)
    if node is not None:
        for version in made:
            QuestionKnowledge.objects.create(
                question_version=version,
                mapping_revision=1,
                node=node,
                is_primary=primary,
                score_weight=1 if primary else 0,
            )
    return question, made


def _make_session(*, project, user, subject, version, mode="practice", status="active", delivered=True, ordinal=1):
    from apps.practice.models import PracticeSession, SessionItem

    session = PracticeSession.objects.create(
        user=user, project=project, subject=subject, mode=mode, status=status
    )
    item = SessionItem.objects.create(
        session=session, ordinal=ordinal, question_version=version, purpose="practice"
    )
    if delivered:
        item.first_delivered_at = timezone.now()
        item.save(update_fields=["first_delivered_at"])
    return session, item


@pytest.fixture(scope="module")
def frozen(django_db_setup, django_db_blocker, tmp_path_factory):
    from apps.accounts.models import User
    from apps.accounts.services.demo_fixture import load_demo_fixture
    from apps.exams.models import Subject
    from apps.ingestion.storage import reset_storage_cache
    from apps.knowledge.models import KnowledgeNode
    from apps.question_bank.models import ContentLineage, Question, QuestionFamily

    media = tmp_path_factory.mktemp("w4-oracle-media")
    stack = ExitStack()
    with django_db_blocker.unblock():
        stack.enter_context(override_settings(PRIVATE_MEDIA_ROOT=str(media), MEDIA_ROOT=str(media)))
        reset_storage_cache()

        user = User.objects.create_user(email=OWNER_EMAIL, password=OWNER_PASSWORD, display_name="W4 Oracle")
        demo = load_demo_fixture(OWNER_EMAIL)
        project = demo["project_a"]
        subject = Subject.objects.filter(project=project).order_by("display_order").first()
        empty_subject = Subject.objects.filter(project=project).exclude(id=subject.id).order_by("display_order").first()
        if empty_subject is None:
            empty_subject = Subject.objects.create(project=project, name="W4 空科目", display_order=99)

        node = KnowledgeNode.objects.filter(syllabus_version__subject=subject).first() or KnowledgeNode.objects.first()
        assert node is not None, "demo fixture must create knowledge nodes"
        family = QuestionFamily.objects.create(subject=subject, name="W4 近似重复族", relation_confirmed=True)
        lineage = ContentLineage.objects.create(owner=user, basis="manual", is_confirmed=True)

        # The gate question must be a pre-existing demo question, so the
        # "uncovered" session below cannot accidentally share its version.
        from apps.question_bank.models import Question as _Q

        q_gate = (
            _Q.objects.filter(subject=subject, current_published_version__isnull=False)
            .order_by("display_label")
            .first()
        )
        assert q_gate is not None, "the demo fixture must contain a published question"

        # --- adversarial content shapes -----------------------------------
        q_no_pub, _ = _make_question(
            subject=subject, label="W4 无发布版本", versions=[{"type": "single_choice", "status": "draft"}], created_by=user
        )
        q_pub_plus_draft, _ = _make_question(
            subject=subject,
            label="W4 已发布+草稿更新",
            versions=[
                {"type": "single_choice", "status": "published", "keys": [{"verification_status": "checked"}]},
                {"type": "true_false", "status": "draft"},
            ],
            created_by=user,
        )
        q_bad_key, _ = _make_question(
            subject=subject,
            label="W4 争议答案键",
            versions=[
                {
                    "type": "single_choice",
                    "status": "published",
                    "keys": [
                        {"verification_status": "checked", "is_disputed": True},
                        {"verification_status": "pending"},
                    ],
                }
            ],
            created_by=user,
        )
        q_aux_only, _ = _make_question(
            subject=subject,
            label="W4 仅有辅助映射",
            versions=[{"type": "single_choice", "status": "published", "keys": [{"verification_status": "checked"}]}],
            node=node,
            primary=False,
            created_by=user,
        )
        q_primary_node, _ = _make_question(
            subject=subject,
            label="W4 主映射题",
            versions=[{"type": "single_choice", "status": "published", "keys": [{"verification_status": "checked"}]}],
            node=node,
            primary=True,
            created_by=user,
        )
        q_family, family_versions = _make_question(
            subject=subject,
            label="W4 同族兄弟",
            versions=[{"type": "single_choice", "status": "published", "keys": [{"verification_status": "checked"}]}],
            family=family,
            created_by=user,
        )
        q_lineage, lineage_versions = _make_question(
            subject=subject,
            label="W4 同谱系兄弟",
            versions=[{"type": "single_choice", "status": "published", "keys": [{"verification_status": "checked"}]}],
            lineage=lineage,
            created_by=user,
        )
        q_plain, plain_versions = _make_question(
            subject=subject,
            label="W4 无关题",
            versions=[{"type": "single_choice", "status": "published", "keys": [{"verification_status": "checked"}]}],
            created_by=user,
        )
        # The gate expands from the *verification item's* question, so the gate
        # question itself must carry the family / lineage for those two coverage
        # paths to be reachable at all.
        q_gate.family = family
        q_gate.content_lineage = lineage
        q_gate.save(update_fields=["family", "content_lineage", "updated_at"])
        # --- the running verification that must gate covered content -------
        gate_version = q_gate.current_published_version
        verification, gate_item = _make_session(
            project=project, user=user, subject=subject, version=gate_version, mode="verification"
        )

        # --- sessions whose grading_hidden the gate must decide ------------
        s_same, _ = _make_session(project=project, user=user, subject=subject, version=gate_version)
        s_family, _ = _make_session(project=project, user=user, subject=subject, version=family_versions[0])
        s_lineage, _ = _make_session(project=project, user=user, subject=subject, version=lineage_versions[0])
        s_plain, _ = _make_session(project=project, user=user, subject=subject, version=plain_versions[0])
        # Ordinary practice rows for paging.
        for index in range(14):
            _make_session(project=project, user=user, subject=subject, version=plain_versions[0], ordinal=index + 1)

        client = _login(Client())
        try:
            yield {
                "client": client,
                "user": user,
                "project": project,
                "project_id": str(project.id),
                "subject_id": str(subject.id),
                "empty_subject_id": str(empty_subject.id),
                "verification_id": str(verification.id),
                "gate_item_id": str(gate_item.id),
                "session_expectations": {
                    "same_version": (str(s_same.id), True),
                    "family": (str(s_family.id), True),
                    "lineage": (str(s_lineage.id), True),
                    "uncovered": (str(s_plain.id), False),
                    "verification_itself": (str(verification.id), True),
                },
            }
        finally:
            stack.close()


def _compare(label: str, actual, expected) -> dict:
    actual_text = json.dumps(actual, sort_keys=True, ensure_ascii=False)
    expected_text = json.dumps(expected, sort_keys=True, ensure_ascii=False)
    row = {
        "case": label,
        "rows": len(expected) if isinstance(expected, list) else None,
        "byte_identical": actual_text == expected_text,
    }
    if actual_text != expected_text:
        row["actual_rows"] = len(actual) if isinstance(actual, list) else None
        row["first_difference"] = _first_difference(expected, actual)
    return row


def _first_difference(expected, actual):
    if isinstance(expected, list) and isinstance(actual, list):
        for index, (left, right) in enumerate(zip(expected, actual)):
            if json.dumps(left, sort_keys=True) != json.dumps(right, sort_keys=True):
                return {"index": index, "oracle": left, "endpoint": right}
        if len(expected) != len(actual):
            return {"length": {"oracle": len(expected), "endpoint": len(actual)}}
        return None
    return {"oracle": expected, "endpoint": actual}


def test_questions_list_matches_the_pre_optimisation_oracle(frozen):
    client: Client = frozen["client"]
    project_id = frozen["project_id"]
    subject_id = frozen["subject_id"]

    cases = {
        "all": {"limit": 50},
        "subject_id": {"subject_id": subject_id, "limit": 50},
        "question_type": {"question_type": "single_choice", "limit": 50},
        "status_published": {"status": "published", "limit": 50},
        "status_draft": {"status": "draft", "limit": 50},
        "origin_type": {"origin_type": "demo", "limit": 50},
        "search": {"search": "W4", "limit": 50},
        "search_no_hit": {"search": "绝不存在的标签", "limit": 50},
        "limit_offset": {"limit": 3, "offset": 2},
        "limit_offset_deep": {"limit": 4, "offset": 9},
        "empty_page": {"limit": 10, "offset": 100000},
        "empty_subject": {"subject_id": frozen["empty_subject_id"], "limit": 50},
        "limit_zero_clamped": {"limit": 0},
        "limit_over_max_clamped": {"limit": 500},
        "combined": {
            "subject_id": subject_id,
            "question_type": "single_choice",
            "status": "published",
            "origin_type": "demo",
            "limit": 7,
            "offset": 1,
        },
    }
    results = []
    for label, params in cases.items():
        query = "&".join(f"{key}={value}" for key, value in params.items())
        response = client.get(f"/api/v1/projects/{project_id}/questions?{query}")
        assert response.status_code == 200, (label, response.status_code, response.content[:300])
        row = _compare(label, response.json(), oracle_list_questions(user=frozen["user"], project=frozen["project"], **params))
        row["params"] = params
        results.append(row)
    REPORT["cases"].append({"endpoint": "questions_list", "results": results})
    _write_report()

    failures = [row for row in results if not row["byte_identical"]]
    assert not failures, "questions_list diverged from the pre-optimisation oracle: " + json.dumps(
        failures, ensure_ascii=False, default=str
    )


def test_page_order_under_tied_created_at(frozen):
    """``order_by("-created_at")`` is not a total order, before *and* after.

    The optimised queries add ``GROUP BY`` (the ``Count`` annotations), so this
    measures - instead of assuming - whether tied timestamps make the optimised
    page order differ from the pre-optimisation order. Both sides are sampled
    repeatedly, the tie is applied and then restored, and the row **set** is the
    hard assertion while the order is reported as what it is.
    """
    from apps.practice.models import PracticeSession
    from apps.question_bank.models import Question

    client: Client = frozen["client"]
    project = frozen["project"]
    project_id = frozen["project_id"]
    tie = timezone.now()
    original_sessions = dict(
        PracticeSession.objects.filter(project=project).values_list("id", "created_at")
    )
    original_questions = dict(Question.objects.filter(subject__project=project).values_list("id", "created_at"))

    def _ids(payload, key):
        return [row[key] for row in payload]

    result = {"case": "tied_created_at_page_order"}
    try:
        PracticeSession.objects.filter(project=project).update(created_at=tie)
        Question.objects.filter(subject__project=project).update(created_at=tie)

        endpoint_runs = [
            _ids(client.get(f"/api/v1/projects/{project_id}/practice-sessions?limit=50").json(), "session_id")
            for _ in range(3)
        ]
        oracle_runs = [
            _ids(oracle_list_sessions(user=frozen["user"], project=project, limit=50), "session_id") for _ in range(3)
        ]
        q_endpoint_runs = [
            _ids(client.get(f"/api/v1/projects/{project_id}/questions?limit=50").json(), "id") for _ in range(3)
        ]
        q_oracle_runs = [
            _ids(oracle_list_questions(user=frozen["user"], project=project, limit=50), "id") for _ in range(3)
        ]

        result["sessions"] = {
            "endpoint_stable_across_3_calls": len({tuple(run) for run in endpoint_runs}) == 1,
            "oracle_stable_across_3_calls": len({tuple(run) for run in oracle_runs}) == 1,
            "endpoint_order_equals_oracle_order": tuple(endpoint_runs[0]) == tuple(oracle_runs[0]),
            "set_identical": set(endpoint_runs[0]) == set(oracle_runs[0]),
            "rows": len(endpoint_runs[0]),
        }
        # Is the *oracle's own* tie order a contract, or a plan artefact? Force a
        # different plan for the same pre-optimisation query and look again.
        from django.db import connection as _connection

        with _connection.cursor() as cursor:
            cursor.execute("SET LOCAL enable_seqscan = off")
        oracle_other_plan = _ids(oracle_list_sessions(user=frozen["user"], project=project, limit=50), "session_id")
        result["sessions"]["oracle_order_is_plan_dependent"] = tuple(oracle_other_plan) != tuple(oracle_runs[0])
        result["sessions"]["oracle_other_plan_set_identical"] = set(oracle_other_plan) == set(oracle_runs[0])
        result["questions"] = {
            "endpoint_stable_across_3_calls": len({tuple(run) for run in q_endpoint_runs}) == 1,
            "oracle_stable_across_3_calls": len({tuple(run) for run in q_oracle_runs}) == 1,
            "endpoint_order_equals_oracle_order": tuple(q_endpoint_runs[0]) == tuple(q_oracle_runs[0]),
            "set_identical": set(q_endpoint_runs[0]) == set(q_oracle_runs[0]),
            "rows": len(q_endpoint_runs[0]),
        }
    finally:
        for session_id, created_at in original_sessions.items():
            PracticeSession.objects.filter(id=session_id).update(created_at=created_at)
        for question_id, created_at in original_questions.items():
            Question.objects.filter(id=question_id).update(created_at=created_at)

    REPORT["cases"].append(result)
    _write_report()
    print("W4PROBE tied-order " + json.dumps(result, ensure_ascii=False, default=str), flush=True)
    assert result["sessions"]["set_identical"], f"tied sessions returned a different row set: {result}"
    assert result["questions"]["set_identical"], f"tied questions returned a different row set: {result}"


def test_practice_sessions_list_matches_the_pre_optimisation_oracle(frozen):
    client: Client = frozen["client"]
    project_id = frozen["project_id"]
    subject_id = frozen["subject_id"]

    cases = {
        "all_limit_50": {"limit": 50},
        "default_limit": {},
        "limit_2": {"limit": 2},
        "limit_zero_clamped": {"limit": 0},
        "limit_over_max_clamped": {"limit": 500},
        "subject_id": {"subject_id": subject_id, "limit": 50},
    }
    results = []
    for label, params in cases.items():
        query = "&".join(f"{key}={value}" for key, value in params.items())
        response = client.get(f"/api/v1/projects/{project_id}/practice-sessions?{query}")
        assert response.status_code == 200, (label, response.status_code, response.content[:300])
        row = _compare(label, response.json(), oracle_list_sessions(user=frozen["user"], project=frozen["project"], **params))
        row["params"] = params
        results.append(row)
    REPORT["cases"].append({"endpoint": "practice_sessions_list", "results": results})
    _write_report()

    failures = [row for row in results if not row["byte_identical"]]
    assert not failures, "practice_sessions_list diverged from the pre-optimisation oracle: " + json.dumps(
        failures, ensure_ascii=False, default=str
    )


def test_verification_gate_semantic_counter_example(frozen):
    """The semantic W2 admits it has no regression test for.

    A running verification item on one question version must make
    ``grading_hidden=true`` for exactly the sessions whose items are covered —
    the same version, a question in the same near-duplicate family, a question in
    the same content lineage — and must leave an uncovered session alone. The
    optimised endpoint reads the gate from a prefetched item list, so this is
    exactly where a silent behaviour change would hide.
    """
    client: Client = frozen["client"]
    project_id = frozen["project_id"]
    body = client.get(f"/api/v1/projects/{project_id}/practice-sessions?limit=50").json()
    by_id = {row["session_id"]: row for row in body}

    checks = {}
    for name, (session_id, expected_hidden) in frozen["session_expectations"].items():
        row = by_id.get(session_id)
        checks[name] = {
            "session_id": session_id,
            "expected_grading_hidden": expected_hidden,
            "actual_grading_hidden": None if row is None else row["grading_hidden"],
            "pass": row is not None and row["grading_hidden"] is expected_hidden,
        }

    REPORT["cases"].append({"case": "verification_gate_semantics", "checks": checks})
    _write_report()
    failing = {name: value for name, value in checks.items() if not value["pass"]}
    assert not failing, "verification gate semantics changed: " + json.dumps(failing, ensure_ascii=False, default=str)
