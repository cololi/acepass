#!/usr/bin/env python
"""Empirical probe for B8 practice write paths (reveal / draft / confirm-grade / grading queue).

Everything runs against the **real** Django services and the real Ninja router on a throw-away
PostgreSQL test database: presentation, item reveal, attempt reveal, the verification content gate,
draft optimistic locking, criterion-by-criterion confirmation, the grading queue, and attachment
submission.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_b8_practice.py

Writes ``docs/dsh-migration/17-b8-practice-probe.json`` only.
"""

from __future__ import annotations

import json
import os
import re
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import Client  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.audit.models import IdempotencyRecord, OutboxEvent  # noqa: E402
from apps.common.content import content_digest  # noqa: E402
from apps.exams.models import ExamProject, Subject  # noqa: E402
from apps.ingestion.models import Asset  # noqa: E402
from apps.practice.models import Attempt, GradeEvent, SessionItem  # noqa: E402
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionVersion,
    RubricVersion,
)

OUT_JSON = ROOT / "docs" / "dsh-migration" / "17-b8-practice-probe.json"
TEST_DB_NAME = "test_acepass_b8_practice"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

UNSET = object()
CASES: list[dict] = []
SYMBOLS: dict[str, str] = {}
CLIENT = Client()
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)")


def _auto_name(value: str) -> str:
    name = SYMBOLS.get(value)
    if name is None:
        name = f"REF_{len(SYMBOLS):03d}"
        SYMBOLS[value] = name
    return name


def reg(name: str, value) -> str:
    text = str(getattr(value, "id", value))
    SYMBOLS[text] = name
    return text


def scrub(value, key: str | None = None):
    if isinstance(value, dict):
        return {name: scrub(item, name) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(item, key) for item in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, str):
        if UUID_RE.fullmatch(value):
            return _auto_name(value)
        return TIME_RE.sub("<time>", UUID_RE.sub(lambda m: _auto_name(m.group(0)), value))
    return value


def db_counts() -> dict:
    return {
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_outbox_event": OutboxEvent.objects.count(),
        "practice_attempt": Attempt.objects.count(),
        "practice_grade_event": GradeEvent.objects.count(),
        "practice_session_item": SessionItem.objects.count(),
    }


def call(case_id: str, title: str, method: str, path: str, *, json_body=UNSET, key=UNSET) -> dict:
    headers = {}
    if key is not UNSET:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    before = db_counts()
    if json_body is not UNSET:
        response = getattr(CLIENT, method)(
            path, data=json.dumps(json_body, ensure_ascii=False), content_type="application/json", **headers
        )
    else:
        response = getattr(CLIENT, method)(path, **headers)
    after = db_counts()
    payload = json.loads(response.content.decode("utf-8")) if response.content else None
    case = {
        "id": case_id,
        "title": title,
        "request": {
            "method": method.upper(),
            "path": scrub(path),
            "json_body": None if json_body is UNSET else scrub(json_body),
            "idempotency_key": None if key is UNSET else key,
        },
        "status": response.status_code,
        "payload": scrub(payload),
        # Raw (unscrubbed) payload for the script's own control flow; stripped before writing.
        "_raw": payload,
        "row_delta": {name: after[name] - before[name] for name in after if after[name] != before[name]},
    }
    CASES.append(case)
    return case


def make_question(subject, label: str, *, question_type="single_choice", content=None, answer=None, rubric=None, max_score="2.00"):
    content = content or {
        "blocks": [{"kind": "text", "text": f"题目 {label}：1+1 等于几？"}],
        "options": [
            {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "1"}]},
            {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "2"}]},
        ],
    }
    question = Question.objects.create(subject=subject, origin_type="user_authored", display_label=label)
    version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type=question_type,
        content=content,
        status="draft",
        content_digest=content_digest(content),
        practice_max_score=Decimal(max_score),
        revision_reason="probe",
        source_note="",
    )
    answer_row = AnswerKeyVersion.objects.create(
        question_version=version,
        version=1,
        answer_payload=answer or {"kind": "single_choice", "correct_option_id": "opt_b"},
        source_type="user_authored",
        verification_status="checked",
        checked_by=question.subject.project.owner,
        checked_at=timezone.now(),
        check_basis="探针依据",
        explanation_blocks=[{"kind": "text", "text": "因为 1+1=2。"}],
        is_disputed=False,
    )
    if rubric is not None:
        RubricVersion.objects.create(
            answer_key_version=answer_row,
            version=1,
            criteria=rubric,
            total_score=Decimal(max_score),
            usage_note="",
            checked_by=question.subject.project.owner,
            checked_at=timezone.now(),
            is_disputed=False,
        )
    version.status = "published"
    version.published_at = timezone.now()
    version.save(update_fields=["status", "published_at"])
    question.current_published_version = version
    question.save(update_fields=["current_published_version"])
    return question, version


SESSION_SEQ = 0


def session_flow(project_id: str, subject_id: str, question_ids: list[str], mode: str = "practice") -> tuple[str, str]:
    global SESSION_SEQ
    SESSION_SEQ += 1
    created = call(
        f"SETUP-{SESSION_SEQ}",
        f"create a {mode} session (fixture setup)",
        "post",
        f"/api/v1/projects/{project_id}/practice-sessions",
        json_body={"mode": mode, "subject_id": subject_id, "question_ids": question_ids},
        key=f"probe-session-{mode}-{len(CASES)}",
    )
    assert created["status"] == 201, created
    session_id = created["_raw"]["session_id"]
    item = SessionItem.objects.filter(session_id=session_id).first()
    return session_id, str(item.id)


def build() -> None:
    User = get_user_model()
    owner = User.objects.create_user(email="b8-practice@example.invalid", password="probe-password-123", display_name="探针用户")
    project = ExamProject.objects.create(owner=owner, name="实践写路径探针")
    subject = Subject.objects.create(project=project, name="数学", code="MATH")
    other_project = ExamProject.objects.create(owner=owner, name="另一个项目")
    other_subject = Subject.objects.create(project=other_project, name="物理", code="PHY")
    reg("PROJECT", project)
    reg("SUBJECT", subject)
    reg("OTHER_PROJECT", other_project)

    single_q, single_v = make_question(subject, "单选")
    rubric_criteria = [
        {"criterion_id": "c1", "text": "正确列出已知条件", "max_score": "4", "required": True},
        {"criterion_id": "c2", "text": "推导过程正确", "max_score": "3", "required": True},
        {"criterion_id": "c3", "text": "结论正确", "max_score": "3", "required": True},
    ]
    cr_q, cr_v = make_question(
        subject,
        "大题",
        question_type="constructed_response",
        content={"blocks": [{"kind": "text", "text": "写出推导过程。"}]},
        answer={"kind": "constructed_response", "rubric_required": True, "reference_answer": "20 个"},
        rubric=rubric_criteria,
        max_score="10.00",
    )
    reg("SINGLE", single_v)
    reg("CR", cr_v)

    CLIENT.force_login(owner)
    base = f"/api/v1/projects/{project.id}"
    other_base = f"/api/v1/projects/{other_project.id}"

    # ---------------------------------------------------------------- presentation
    session_id, item_id = session_flow(str(project.id), str(subject.id), [str(single_q.id)])
    reg("SESSION", session_id)
    reg("ITEM", item_id)
    presented = call("P01", "presentation carries draft/clock/tutoring", "get", f"{base}/session-items/{item_id}/presentation")
    assert presented["status"] == 200, presented

    # ---------------------------------------------------------------- reveal
    call("P02", "reveal before submit returns the trusted answer", "post", f"{base}/session-items/{item_id}/reveal")
    verification_session, verification_item = session_flow(
        str(project.id), str(subject.id), [str(single_q.id)], mode="verification"
    )
    call("P03", "reveal before submit on a verification is refused", "get", f"{base}/session-items/{verification_item}/presentation")
    call("P04", "verification reveal is 403 purpose_not_allowed", "post", f"{base}/session-items/{verification_item}/reveal")
    call("P05", "a practice item covered by a running verification cannot reveal", "post", f"{base}/session-items/{item_id}/reveal")
    call("P05b", "finishing the verification lifts the content gate", "post", f"{base}/practice-sessions/{verification_session}/finish", key="probe-finish-verification")

    # ---------------------------------------------------------------- draft
    call(
        "P06",
        "draft save increments the revision",
        "put",
        f"{base}/session-items/{item_id}/draft",
        json_body={"draft": {"draft_version": 2, "answer": {"selected_option_id": "opt_b"}, "asset_ids": []}, "draft_revision": 0},
    )
    call(
        "P07",
        "a stale draft revision conflicts",
        "put",
        f"{base}/session-items/{item_id}/draft",
        json_body={"draft": {"draft_version": 2, "answer": {}, "asset_ids": []}, "draft_revision": 0},
    )

    # ---------------------------------------------------------------- attachment submit
    asset = Asset.objects.create(
        owner=owner,
        project=project,
        subject=subject,
        role="user_attachment",
        object_key="probe/answer.png",
        original_filename="answer.png",
        content_type="image/png",
        size_bytes=1024,
        checksum="0" * 64,
        uploaded_by=owner,
    )
    foreign_asset = Asset.objects.create(
        owner=owner,
        project=other_project,
        subject=other_subject,
        role="user_attachment",
        object_key="probe/foreign.png",
        original_filename="foreign.png",
        content_type="image/png",
        size_bytes=1024,
        checksum="1" * 64,
        uploaded_by=owner,
    )
    reg("ASSET", asset)
    reg("FOREIGN_ASSET", foreign_asset)
    submitted = call(
        "P08",
        "submit with a photo stores the attachment",
        "post",
        f"{base}/session-items/{item_id}/submit",
        json_body={"answer": {"type": "single_choice", "selected_option_id": "opt_b"}, "asset_ids": [str(asset.id)]},
        key="probe-submit-1",
    )
    attempt_id = submitted["_raw"]["attempt_id"]
    reg("ATTEMPT", attempt_id)
    call("P09", "attempt detail exposes the attachment and the score", "get", f"{base}/attempts/{attempt_id}")
    call("P10", "reveal after submit uses the attempt route", "post", f"{base}/attempts/{attempt_id}/reveal")
    call(
        "P11",
        "draft after submit is refused",
        "put",
        f"{base}/session-items/{item_id}/draft",
        json_body={"draft": {"draft_version": 2, "answer": {}, "asset_ids": []}, "draft_revision": 2},
    )

    # ---------------------------------------------------------------- foreign attachment
    session2, item2 = session_flow(str(project.id), str(subject.id), [str(single_q.id)])
    call(
        "P12",
        "an attachment from another project is a 404",
        "post",
        f"{base}/session-items/{item2}/submit",
        json_body={"answer": {"type": "single_choice", "selected_option_id": "opt_b"}, "asset_ids": [str(foreign_asset.id)]},
        key="probe-submit-foreign",
    )

    # ---------------------------------------------------------------- confirm grade
    cr_session, cr_item = session_flow(str(project.id), str(subject.id), [str(cr_q.id)])
    call("P13", "present the constructed response", "get", f"{base}/session-items/{cr_item}/presentation")
    cr_submit = call(
        "P14",
        "constructed response submits to pending review",
        "post",
        f"{base}/session-items/{cr_item}/submit",
        json_body={"answer": {"type": "constructed_response", "text": "5 × 4 = 20"}},
        key="probe-submit-cr",
    )
    cr_attempt_id = cr_submit["_raw"]["attempt_id"]
    reg("CR_ATTEMPT", cr_attempt_id)
    queue = call("P15", "grading queue lists the pending attempt with its rubric", "get", f"{base}/grading-queue")
    rubric_id = None
    for row in queue["_raw"] or []:
        if row["attempt_id"] == cr_attempt_id:
            rubric_id = row["rubric"]["rubric_version_id"]
    assert rubric_id is not None, queue
    confirmed = call(
        "P16",
        "confirm-grade 8/10 is fully confirmed and not correct",
        "post",
        f"{base}/attempts/{cr_attempt_id}/confirm-grade",
        json_body={
            "parts": [
                {"part_id": "c1", "score": "0"},
                {"part_id": "c2", "score": "3"},
                {"part_id": "c3", "score": "3"},
            ],
            "expected_grading_revision": 1,
            "rubric_version_id": rubric_id,
        },
        key="probe-confirm-1",
    )
    assert confirmed["status"] == 200, confirmed
    call(
        "P17",
        "the same confirm key replays without a second grade event",
        "post",
        f"{base}/attempts/{cr_attempt_id}/confirm-grade",
        json_body={
            "parts": [
                {"part_id": "c1", "score": "0"},
                {"part_id": "c2", "score": "3"},
                {"part_id": "c3", "score": "3"},
            ],
            "expected_grading_revision": 1,
            "rubric_version_id": rubric_id,
        },
        key="probe-confirm-1",
    )
    call(
        "P18",
        "a stale grading revision conflicts",
        "post",
        f"{base}/attempts/{cr_attempt_id}/confirm-grade",
        json_body={"parts": [{"part_id": "c1", "score": "4"}], "expected_grading_revision": 1},
        key="probe-confirm-2",
    )

    # ---------------------------------------------------------------- verification queue exclusion
    call(
        "P19",
        "a live verification attempt stays out of the grading queue",
        "get",
        f"{base}/grading-queue",
    )

    # ---------------------------------------------------------------- scope
    call("P20", "an attempt of another project is a 404", "get", f"{other_base}/attempts/{attempt_id}")
    call("P21", "a foreign attempt cannot be confirmed", "post", f"{other_base}/attempts/{cr_attempt_id}/confirm-grade",
         json_body={"parts": [], "expected_grading_revision": 1}, key="probe-confirm-foreign")
    call("P22", "reveal of an unknown item is a 404", "post", f"{base}/session-items/00000000-0000-4000-8000-000000000000/reveal")


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        build()
    finally:
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    for case in CASES:
        case.pop("_raw", None)
    payload = {"database": "postgresql (throw-away test database)", "cases": CASES}
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"cases={len(CASES)}")
    for case in CASES:
        print(case["id"], case["status"], case["title"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
