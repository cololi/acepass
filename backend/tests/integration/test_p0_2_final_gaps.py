"""P0.2 final gaps: C01, C02, C04 and C05 closeout regressions.

Migrated from the independent re-review's runnable counterexamples
(`docs/review/2026-09-27/p02-final-independent/`) with the business assertions
kept intact and each group's *positive* path added, so a fix cannot pass by
disabling the behaviour instead of correcting it:

* **C01** — a replayed ``finish`` is re-serialised under the gate that applies
  now: hidden while a verification covers the content, restored once it closes,
  and never a second finish effect.
* **C02** — every regrade branch that would touch a grade or evidence checks the
  generation on the freshly locked attempt first; an old queued run counts as
  skipped, while a newer run still invalidates the older evidence it replaces.
* **C04** — the synchronous HTTP caller takes the *same* outbox lease a worker
  takes, so exactly one consumer calls the model and commits; the final job, the
  response, the assistant message and the exposure all describe that one result.
* **C05** — ``scripts/verify_proxy.sh`` isolates itself: unique compose project,
  image tag, ports, resources, env file and TLS directory; an existing
  ``infra/docker/.env`` sentinel survives both the success and the failure path.

The C05 checks run the real committed script under a Docker shim that intercepts
every ``docker`` invocation, so they never touch a real container, volume or
network — and they never mutate a developer's configuration.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import textwrap
from copy import deepcopy
from datetime import timedelta
from pathlib import Path

import pytest
from django.conf import settings
from django.utils import timezone

from ai.providers import base as providers
from apps.analytics.services.reports import execute_regrade_run, request_regrade
from apps.audit.models import OutboxEvent
from apps.audit.services import outbox
from apps.learning.services.evidence import rebuild_for_attempt
from apps.practice.models import ExposureEvent, LearningEvidence
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from apps.tutoring.models import TutorJob, TutorTurn
from apps.tutoring.tasks import run_tutor_job
from tests.integration.test_p0_2_closeout_gaps import _service_attempt
from tests.integration.test_practice_flow import present, published, start_session, submit

pytestmark = pytest.mark.django_db

REPO_ROOT = Path(settings.BASE_DIR).resolve().parent


def _parallel_practice_then_verification(caller, project, subject):
    """A finished ordinary practice session, then an open verification on the same question."""
    version = published(subject, "true_false")
    practice = start_session(caller, project, subject, version.question, key="finished-practice")
    item_id = practice["items"][0]["session_item_id"]
    present(caller, project, item_id)
    result = submit(caller, project, item_id, {"type": "true_false", "value": True}, key="answer")
    assert result.status_code == 200, result.content
    finish_url = f"/api/v1/projects/{project.id}/practice-sessions/{practice['session_id']}/finish"
    finished = caller.post(finish_url, {}, key="finish-practice")
    assert finished.status_code == 200, finished.content
    assert finished.json()["confirmed_score"] is not None
    verification = start_session(caller, project, subject, version.question, mode="verification", key="verify")
    present(caller, project, verification["items"][0]["session_item_id"])
    return practice, finish_url, finished.json(), verification


# --------------------------------------------------------------------------
# C01 — a replayed finish obeys the current gate and stays idempotent
# --------------------------------------------------------------------------
def test_finished_session_replay_rechecks_current_verification_gate(caller, project_a, subject_a1):
    practice, finish_url, finished, _verification = _parallel_practice_then_verification(
        caller, project_a, subject_a1
    )
    session_url = f"/api/v1/projects/{project_a.id}/practice-sessions/{practice['session_id']}"
    current = caller.get(session_url)
    assert current.status_code == 200
    assert current.json()["confirmed_score"] is None
    assert current.json()["items"][0]["attempt"]["grade"] is None

    replay = caller.post(finish_url, {}, key="finish-practice")
    assert replay.status_code == 200, replay.content
    body = replay.json()
    assert body.get("confirmed_score") is None, body
    assert body["items"][0]["attempt"]["grade"] is None, body
    assert body.get("score_visible") is False, body
    # The replay must not be a stored copy of the original (which still held the score).
    assert body != finished

    # The end effect happened exactly once: one finish event, one finish timestamp.
    assert OutboxEvent.objects.filter(dedupe_key=f"session-finished:{practice['session_id']}").count() == 1
    assert (
        caller.get(session_url).json()["finished_at"] == body["finished_at"] == finished["finished_at"]
    )


def test_finished_session_replay_restores_grading_after_verification_closes(caller, project_a, subject_a1):
    """Positive path: closing the verification makes the same key deliver the score again."""
    practice, finish_url, _finished, verification = _parallel_practice_then_verification(
        caller, project_a, subject_a1
    )
    finish_verification = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions/{verification['session_id']}/finish",
        {},
        key="finish-verify",
    )
    assert finish_verification.status_code == 200, finish_verification.content

    replay = caller.post(finish_url, {}, key="finish-practice")
    assert replay.status_code == 200, replay.content
    body = replay.json()
    assert body["confirmed_score"] is not None, body
    assert body["items"][0]["attempt"]["grade"] is not None, body
    assert body["items"][0]["attempt"]["grade"]["is_correct"] is True, body
    # The detail read and the replay agree once nothing covers the content.
    assert caller.get(
        f"/api/v1/projects/{project_a.id}/practice-sessions/{practice['session_id']}"
    ).json()["confirmed_score"] == body["confirmed_score"]
    assert OutboxEvent.objects.filter(dedupe_key=f"session-finished:{practice['session_id']}").count() == 1


# --------------------------------------------------------------------------
# C02 — the content-version branch checks the generation before it writes
# --------------------------------------------------------------------------
def _publish_second_content_version(project, qv1, source_key):
    """An ordinary editorial revision of the same stable question, through services."""
    content = deepcopy(qv1.content)
    content["blocks"][0]["text"] += "（文字校订版）"
    qv2 = content_services.create_question_version_draft(
        qv1.question,
        question_type=qv1.question_type,
        content=content,
        actor=project.owner,
        practice_max_score=qv1.practice_max_score,
        revision_reason="Editorial correction",
    )
    # The reviewed key must exist before publication: publishing validates it.
    key2 = AnswerKeyVersion.objects.create(
        question_version=qv2,
        version=1,
        answer_payload=deepcopy(source_key.answer_payload),
        verification_status="checked",
        checked_by=project.owner,
        check_basis="C02 official regression fixture",
    )
    content_services.replace_knowledge_mappings(
        qv2,
        [
            {"node_id": str(row.node_id), "is_primary": row.is_primary, "score_weight": row.score_weight}
            for row in qv1.knowledge_mappings.all()
        ],
        actor=project.owner,
    )
    return content_services.publish_question_version(qv2, actor=project.owner), key2


def test_old_content_version_regrade_keeps_newer_generation_evidence(project_a, subject_a1):
    now = timezone.now()
    qv1 = published(subject_a1, "true_false")
    old_item, _old_attempt = _service_attempt(
        project_a, subject_a1, qv1, now - timedelta(minutes=3), now - timedelta(minutes=2)
    )
    old = request_regrade(
        question=qv1.question,
        target_answer_key_version=old_item.answer_key_version,
        actor=project_a.owner,
        reason="Queued against the original content version",
    )

    qv2, key2 = _publish_second_content_version(project_a, qv1, old_item.answer_key_version)
    _item2, attempt2 = _service_attempt(project_a, subject_a1, qv2, now - timedelta(minutes=1), now)
    assert attempt2.session_item.question_version_id == qv2.id

    new = request_regrade(
        question=qv2.question,
        target_answer_key_version=key2,
        actor=project_a.owner,
        reason="Newer regrade against corrected content",
    )
    assert new.generation > old.generation
    execute_regrade_run(str(new.id))
    rebuild_for_attempt(str(attempt2.id))
    attempt2.refresh_from_db()
    assert attempt2.applied_regrade_generation == new.generation
    grade_id = attempt2.current_grade_event_id
    active_ids = set(
        LearningEvidence.objects.filter(attempt=attempt2, is_active=True).values_list("id", flat=True)
    )
    assert active_ids

    execute_regrade_run(str(old.id))
    attempt2.refresh_from_db()
    old.refresh_from_db()
    assert attempt2.current_grade_event_id == grade_id
    assert attempt2.applied_regrade_generation == new.generation
    remaining = set(
        LearningEvidence.objects.filter(attempt=attempt2, is_active=True).values_list("id", flat=True)
    )
    assert remaining == active_ids, (
        f"旧代次 {old.generation} 不得失效较新代次 {new.generation} 的证据："
        f"before={len(active_ids)} after={len(remaining)}"
    )
    # The old run wrote nothing to the newer attempt and is reported as skipped for
    # it, while still re-grading the older attempt it genuinely owns: the watermark
    # is per attempt, not per question.
    assert old.invalidated_evidence == 0
    assert old.stale_skipped_attempts == 1
    assert old.regraded_attempts == 1


def test_newer_content_version_regrade_still_invalidates_older_evidence(project_a, subject_a1):
    """Positive path: the *newer* run still retires evidence the content change replaces."""
    now = timezone.now()
    qv1 = published(subject_a1, "true_false")
    _item1, attempt1 = _service_attempt(
        project_a, subject_a1, qv1, now - timedelta(minutes=3), now - timedelta(minutes=2)
    )
    rebuild_for_attempt(str(attempt1.id))
    active_before = LearningEvidence.objects.filter(attempt=attempt1, is_active=True).count()
    assert active_before > 0

    qv2, key2 = _publish_second_content_version(project_a, qv1, attempt1.session_item.answer_key_version)
    run = request_regrade(
        question=qv2.question,
        target_answer_key_version=key2,
        actor=project_a.owner,
        reason="Newer revision replaces the older evidence",
    )
    execute_regrade_run(str(run.id))
    run.refresh_from_db()
    attempt1.refresh_from_db()
    assert run.status == "succeeded"
    assert run.invalidated_evidence == active_before
    assert run.stale_skipped_attempts == 0
    assert run.regraded_attempts == 0
    assert LearningEvidence.objects.filter(attempt=attempt1, is_active=True).count() == 0


# --------------------------------------------------------------------------
# C04 — the inline HTTP caller and a worker share one lease
# --------------------------------------------------------------------------
@pytest.mark.django_db(transaction=True)
def test_http_inline_tutor_shares_the_worker_lease(caller, project_a, practice_item, monkeypatch, settings):
    """Real HTTP handler, real outbox row, real leased task: one owner, one result."""
    settings.ACEPASS_INLINE_TASKS = False
    # Broker transport is irrelevant to this deterministic interleaving: the actual
    # task below still claims and confirms the persisted outbox row.
    monkeypatch.setattr(outbox, "after_commit_dispatch", lambda **kwargs: None)
    opened = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions",
        {"session_item_id": str(practice_item.id), "purpose": "explanation"},
        key="final-gap-tutor-session",
    )
    assert opened.status_code == 201, opened.content
    tutor_id = opened.json()["tutor_session_id"]

    calls: list[int] = []
    seen: dict = {}

    def interleaved_provider(provider, request, **kwargs):
        assert connection_autocommit_is_on()
        index = len(calls) + 1
        calls.append(index)
        if index == 1:
            job = TutorJob.objects.get(tutor_session_id=tutor_id)
            event = OutboxEvent.objects.get(dedupe_key=f"tutor-job:{job.id}")
            # The synchronous caller already owns the lease the worker would need.
            seen["during_inline_call"] = {
                "status": event.status,
                "token_present": bool(event.claim_token),
                "lease_live": event.lease_expires_at is not None
                and event.lease_expires_at > timezone.now(),
            }
            verdict = run_tutor_job(outbox_event_id=str(event.id), **event.payload)
            seen["second_consumer_verdict"] = verdict
            job.refresh_from_db()
            event.refresh_from_db()
            if verdict == "succeeded":  # pragma: no cover - the guarded design skips here
                assert job.result_blocks[0]["text"] == "leased-worker-result"
                seen["expected_final_text"] = "leased-worker-result"
            else:
                # Correct design: the inline caller holds the same claim, so the
                # duplicate delivery never calls the provider or writes a result.
                assert verdict == "skipped_lease_not_held", verdict
                assert event.processed_at is None and event.status == "processing"
                seen["expected_final_text"] = "inline-http-result"
        text = "inline-http-result" if index == 1 else "leased-worker-result"
        body = {
            "explanation_blocks": [{"kind": "text", "text": text}],
            "citations": [],
            "missing_information": [],
            "suggested_next": [],
        }
        return providers.AiCallResult(payload=body, raw_text=json.dumps(body), is_stub=True)

    monkeypatch.setattr(providers, "call_with_deadline", interleaved_provider)
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/tutor-sessions/{tutor_id}/messages",
        {"user_question": "Explain this question"},
        key="final-gap-http-tutor-message",
    )
    assert response.status_code == 201, response.content
    job = TutorJob.objects.get(id=response.json()["tutor_job_id"])
    event = OutboxEvent.objects.get(dedupe_key=f"tutor-job:{job.id}")
    assistant_texts = list(TutorTurn.objects.filter(job=job, role="assistant").values_list("text", flat=True))
    exposures = ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count()

    assert seen["during_inline_call"] == {"status": "processing", "token_present": True, "lease_live": True}
    assert seen["second_consumer_verdict"] == "skipped_lease_not_held"
    assert len(calls) == 1, "只有一个消费者可以调用模型"
    assert len(assistant_texts) == 1 and exposures == 1
    assert event.status == "processed" and event.processed_at is not None
    assert job.finalized_at is not None
    assert job.result_blocks[0]["text"] == assistant_texts[0] == seen["expected_final_text"]
    assert response.json()["result_blocks"] == job.result_blocks
    # The synchronous response describes the committed job, not a private copy.
    assert response.json()["status"] == job.status == "succeeded"


def connection_autocommit_is_on() -> bool:
    """The provider call must run outside any transaction (no lock during the request)."""
    from django.db import connection

    return connection.get_autocommit() is True


# --------------------------------------------------------------------------
# C05 — the release-gate script isolates its own resources
# --------------------------------------------------------------------------
SHIM = """#!/usr/bin/env bash
# Test-only shim: records every docker invocation and fails where the test asks.
printf '%s\\n' "$*" >> "$DOCKER_SHIM_LOG"
case "$*" in
  *"FAIL_PATTERN"*) exit 42;;
  *"config --format json"*)
    # Answer for the *api* service the way compose would, so the cleanup path is
    # exercised instead of silently skipped. ``own`` reports the tag this run
    # generated (read from its temporary env file); ``foreign`` reports somebody
    # else's image, which the script must refuse to delete.
    env_file=""; previous=""
    for arg in "$@"; do
      if [ "$previous" = "--env-file" ]; then env_file="$arg"; fi
      previous="$arg"
    done
    tag="$(sed -n 's/^ACEPASS_IMAGE_TAG=//p' "$env_file" 2>/dev/null | head -1)"
    case "${DOCKER_SHIM_CONFIG_IMAGE:-own}" in
      own) printf '{"services":{"api":{"image":"acepass-backend:%s"}}}\\n' "$tag";;
      foreign) printf '{"services":{"api":{"image":"redis:7-alpine"}}}\\n';;
      *) printf '{}\\n';;
    esac
    exit 0;;
  *) exit 0;;
esac
"""


def _docker_shim_fixture(tmp_path: Path, fail_pattern: str) -> tuple[Path, Path, Path, str]:
    """A disposable copy of the release-gate script with an intercepting docker."""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    (root / "infra/docker/certs").mkdir(parents=True)
    (root / "frontend/dist").mkdir(parents=True)
    shutil.copyfile(REPO_ROOT / "scripts/verify_proxy.sh", root / "scripts/verify_proxy.sh")
    shutil.copyfile(REPO_ROOT / "scripts/gen-dev-certs.sh", root / "scripts/gen-dev-certs.sh")
    shutil.copyfile(REPO_ROOT / "infra/docker/docker-compose.yml", root / "infra/docker/docker-compose.yml")
    shutil.copyfile(REPO_ROOT / "infra/docker/.env.example", root / "infra/docker/.env.example")
    (root / "frontend/dist/index.html").write_text('<div id="root">AcePass</div>\n')

    sentinel = "TEST_EXISTING_CONFIGURATION=preserve-this-fake-sentinel\n"
    env_path = root / "infra/docker/.env"
    env_path.write_text(sentinel)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "docker"
    shim.write_text(SHIM.replace("FAIL_PATTERN", fail_pattern))
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    # Hermetic python for the script's free-port helper.
    (bin_dir / "python3").write_text(f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n')
    (bin_dir / "python3").chmod(0o755)
    log = tmp_path / "docker-calls.txt"
    log.write_text("")
    return root, bin_dir, log, sentinel


def _run_script(tmp_path: Path, mode: str, fail_pattern: str, *, config_image: str = "own") -> dict:
    root, bin_dir, log, sentinel = _docker_shim_fixture(tmp_path, fail_pattern)
    env = dict(os.environ)
    for key in ("COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_PROFILES", "ACEPASS_TLS_DIR"):
        env.pop(key, None)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["DOCKER_SHIM_LOG"] = str(log)
    env["DOCKER_SHIM_CONFIG_IMAGE"] = config_image
    result = subprocess.run(
        ["bash", "scripts/verify_proxy.sh", mode],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    return {
        "returncode": result.returncode,
        "output": result.stdout + result.stderr,
        "calls": [line for line in log.read_text().splitlines() if line.strip()],
        "env_preserved": (root / "infra/docker/.env").read_text() == sentinel,
        "root": root,
    }


def test_full_stack_script_isolates_project_env_and_volumes(tmp_path):
    run = _run_script(tmp_path, "full-stack", "build api")
    assert run["returncode"] == 42, run["output"]  # the shim's failure is propagated
    calls = run["calls"]
    compose_calls = [call for call in calls if call.startswith("compose ")]
    assert compose_calls, calls
    for call in compose_calls:
        assert "--project-name acepass-verify-" in call, call
        assert "--env-file" in call, call
    # Never the default project, and volumes are only ever removed for our own project.
    assert not any("--project-name acepass " in call for call in calls), calls
    down_calls = [call for call in compose_calls if " down " in call]
    assert down_calls, calls
    for call in down_calls:
        assert "--project-name acepass-verify-" in call and "--volumes" in call, call
    # An existing local configuration is preserved on the failure path.
    assert run["env_preserved"], "既有 infra/docker/.env 被覆盖"
    # The config the run used is its own temporary file, never the project's `.env`.
    env_files = [call.split("--env-file ")[1].split()[0] for call in compose_calls if "--env-file " in call]
    assert env_files, calls
    assert all(not path.endswith("infra/docker/.env") for path in env_files), env_files
    # The run's own temporary directory (env file, certs, cookies) is gone again.
    assert not Path(env_files[0]).parent.exists(), env_files[0]


def test_image_cleanup_removes_only_this_runs_tag(tmp_path):
    """The run deletes its own uniquely tagged image and never a foreign one."""
    run = _run_script(tmp_path, "full-stack", "build api", config_image="own")
    removals = [call for call in run["calls"] if call.startswith("image rm ")]
    assert len(removals) == 1, run["calls"]
    assert removals[0].startswith("image rm acepass-backend:acepass-verify-"), removals

    foreign = _run_script(tmp_path / "foreign", "full-stack", "build api", config_image="foreign")
    assert not [call for call in foreign["calls"] if call.startswith("image rm ")], foreign["calls"]
    assert "跳过镜像清理" in foreign["output"], foreign["output"]


def test_component_script_never_removes_foreign_containers(tmp_path):
    run = _run_script(tmp_path, "component", "network create")
    assert run["returncode"] == 42, run["output"]
    calls = run["calls"]
    assert calls, "组件检查必须实际调用 docker"
    assert calls[0].startswith("network create acepass-proxy-"), calls
    run_id = calls[0].split()[-1].removeprefix("acepass-proxy-")
    own_names = {
        f"acepass-proxy-{run_id}",
        f"acepass-proxy-{run_id}-web",
        f"acepass-proxy-{run_id}-upstream",
    }
    for call in calls:
        tokens = call.split()
        if tokens[0] == "rm":
            # `rm -f <names...>`: every target is this run's own resource.
            assert tokens[1] == "-f" and set(tokens[2:]) <= own_names, call
        elif tokens[:2] == ["network", "rm"]:
            assert tokens[2] in own_names, call
        # The previous fixed names are never referenced at all, let alone removed.
        for foreign in ("acepass-proxy-web", "acepass-proxy-upstream", "acepass-proxy-component"):
            assert foreign not in tokens, call
    assert run["env_preserved"]


def test_release_gate_works_from_the_commit_and_ignores_real_configuration():
    template = REPO_ROOT / "infra/docker/.env.example"
    assert template.is_file(), "干净 checkout 必须自带 infra/docker/.env.example"
    text = template.read_text()
    assert "change-me" in text and "DJANGO_SECRET_KEY" in text
    assert "acepass_dev_pw" not in text, "模板不得携带真实凭据"
    if (REPO_ROOT / ".git").exists():
        not_ignored = subprocess.run(
            ["git", "check-ignore", "-q", "infra/docker/.env.example"], cwd=REPO_ROOT
        )
        ignored = subprocess.run(["git", "check-ignore", "-q", "infra/docker/.env"], cwd=REPO_ROOT)
        assert not_ignored.returncode != 0, ".env.example 是被提交的模板，不能被忽略"
        assert ignored.returncode == 0, ".env 必须保持忽略"


#: Kept for readers of the migrated counterexample: the assertions above are the
#: same business contract, expressed against the official fixtures.
MIGRATED_FROM = textwrap.dedent(
    """
    docs/review/2026-09-27/p02-final-independent/test_finish_replay.py
    docs/review/2026-09-27/p02-final-independent/test_c02_version_branch.py
    docs/review/2026-09-27/p02-final-independent/test_http_tutor_lease.py
    docs/review/2026-09-27/p02-final-independent/check_proxy_script_isolation.py
    """
)
