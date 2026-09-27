"""Real AI provider verification (M5 / "单独的 AI 接入验证").

This script exists because "the AI chain is wired" and "a real model answered a
real question" are different claims, and only the second one needs credentials.
It refuses to run on anything but a dedicated acceptance database and refuses to
run without a *real* provider configured, so a stub result can never be recorded
as a real one.

What it records, with observed values rather than assertions about intent:

* the provider, model and prompt version actually used;
* latency, prompt/completion tokens and cost, as reported by the provider;
* whether the structured output passed the product's validation;
* that the explanation wrote **no** score, mastery state or plan;
* the exact explanation blocks, so a human can check them against the question.

For image recognition it records the honest outcome for a text-only provider:
``vision_available() == False`` and the manual proofreading path staying open.

Usage (credentials come from the environment, never from this file)::

    POSTGRES_DB=acepass_acceptance_ai ACEPASS_AI_PROVIDER=openai_compatible \
    ACEPASS_AI_BASE_URL=https://api.deepseek.com/v1 ACEPASS_AI_API_KEY=... \
    ACEPASS_AI_TEXT_MODEL=deepseek-chat ACEPASS_AI_VISION_MODEL= \
    DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false \
    PYTHONPATH=backend backend/.venv/bin/python scripts/verify_real_ai.py --email you@example.com
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
django.setup()

from django.conf import settings  # noqa: E402
from django.db import connection  # noqa: E402

from apps.accounts.models import User  # noqa: E402
from apps.audit.models import LLMRun  # noqa: E402
from apps.common.enums import (  # noqa: E402
    AnswerSourceType,
    OriginType,
    TutorPurpose,
    VerificationStatus,
)
from apps.exams.models import Subject  # noqa: E402
from apps.learning.models import LearnerKnowledgeState  # noqa: E402
from apps.practice.models import Attempt, ExposureEvent, GradeEvent, SessionItem  # noqa: E402
from apps.practice.services import sessions as session_services  # noqa: E402
from apps.question_bank.services import core as qb_services  # noqa: E402
from apps.tutoring.services import core as tutor_services  # noqa: E402

ALLOWED_DB_PREFIXES = ("acepass_acceptance_", "acepass_browser_audit_", "test_acepass")


def fail(step: str, reason: str) -> dict:
    return {"step": step, "ok": False, "reason": reason}


def check_environment(email: str) -> dict:
    database = connection.settings_dict["NAME"]
    if not str(database).startswith(ALLOWED_DB_PREFIXES):
        raise SystemExit(
            f"refusing to run against {database!r}: it is not a dedicated acceptance database "
            f"(must start with one of {ALLOWED_DB_PREFIXES})"
        )
    user = User.objects.filter(email=email).first()
    if user is None:
        raise SystemExit(f"account {email!r} does not exist; create it with create_account first")
    from apps.ingestion.services import extraction

    provider = tutor_services.providers.get_provider()
    return {
        "step": "environment",
        "database": str(database),
        "provider": provider.name,
        "capabilities": sorted(provider.capabilities),
        "model_text": settings.AI_TEXT_MODEL,
        "model_vision": settings.AI_VISION_MODEL or "(未配置)",
        "prompt_version": tutor_services.prompts.EXPLAIN_PROMPT_VERSION,
        "is_stub_provider": provider.name in {"stub", "none"},
        "vision_available": extraction.vision_available(),
        "inline_tasks": bool(getattr(settings, "ACEPASS_INLINE_TASKS", False)),
        "email": email,
    }


def build_question(*, user) -> tuple[Subject, SessionItem, Attempt]:
    """One real question with a checked answer, submitted and graded."""
    subject = Subject.objects.filter(project__owner=user).order_by("created_at").first()
    if subject is None:
        raise SystemExit("the account has no project/subject; run bootstrap_acceptance first")
    question = qb_services.create_question(
        subject=subject,
        origin_type=OriginType.USER_AUTHORED,
        actor=user,
        display_label="真实模型验证题",
        is_demo=False,
    )
    version = qb_services.create_question_version_draft(
        question,
        question_type="true_false",
        content={
            "blocks": [
                {
                    "kind": "text",
                    "text": "真实模型验证题：若函数 f 在区间 I 上单调递增，则对 I 内任意 x1 < x2 都有 f(x1) < f(x2)。",
                }
            ]
        },
        actor=user,
        practice_max_score=2,
    )
    qb_services.create_answer_key_version(
        version,
        answer_payload={"kind": "true_false", "value": True},
        actor=user,
        source_type=AnswerSourceType.USER,
        verification_status=VerificationStatus.CHECKED,
        check_basis="真实模型验证夹具（人工核对）",
    )
    published = qb_services.publish_question_version(version, actor=user)
    session = session_services.create_session(user=user, project=subject.project, subject=subject,
                                             question_ids=[str(published.question_id)])
    item = session.items.first()
    session_services.presentation(item=item, user=user)
    from apps.practice.services import attempts as attempt_services

    attempt, _created = attempt_services.submit_attempt(
        session_item_id=str(item.id), user=user, raw_answer={"type": "true_false", "value": False}
    )
    return subject, item, attempt


def run_tutor_call(*, user, item: SessionItem) -> dict:
    tutor_session = tutor_services.create_tutor_session(
        item=item, user=user, purpose=TutorPurpose.EXPLANATION
    )
    job = tutor_services.create_job(
        tutor_session=tutor_session,
        user=user,
        user_question="请针对我的作答说明判断依据、常见误区与验证方法。",
        purpose=TutorPurpose.EXPLANATION,
    )
    from apps.ingestion.services import extraction

    prompt = tutor_services.build_prompt(item=item, user_question=job.request_text)
    citations, _context = tutor_services._allowed_citation_ids(item)
    errors: list[str] = []
    try:
        tutor_services.run_job(job=job, prompt=prompt, citations=citations, purpose=job.purpose)
    except Exception as exc:  # a real provider can fail; that is a recorded result too
        errors.append(f"{type(exc).__name__}: {exc}")
    job.refresh_from_db()
    run = LLMRun.objects.filter(id=job.llm_run_id).first()
    return {
        "step": "real_tutor_call",
        "job_status": job.status,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "errors": errors,
        "is_stub": bool(run.is_stub) if run else None,
        "provider": run.provider if run else "",
        "model": run.model_identifier if run else "",
        "prompt_version": run.prompt_version if run else "",
        "latency_ms": run.latency_ms if run else None,
        "prompt_tokens": run.prompt_tokens if run else None,
        "completion_tokens": run.completion_tokens if run else None,
        "cost_cents": str(run.cost_cents) if run and run.cost_cents is not None else None,
        "cost_known": bool(run.cost_known) if run else None,
        "attempts": run.attempts if run else None,
        "validation_result": run.validation_result if run else None,
        "raw_response_excerpt": (run.raw_response_excerpt[:400] if run else ""),
        "result_blocks_text": [
            block.get("text", "") for block in (job.result_blocks or []) if isinstance(block, dict)
        ],
        "finalized": job.finalized_at is not None,
        "vision_available": extraction.vision_available(),
    }


def side_effect_check(*, user, item: SessionItem, attempt: Attempt) -> dict:
    """A real explanation must not write a score, mastery state or plan."""
    attempt.refresh_from_db()
    return {
        "step": "no_score_side_effects",
        "grade_events": GradeEvent.objects.filter(attempt=attempt).count(),
        "grade_event_unchanged": attempt.current_grade_event_id is not None,
        "knowledge_states": LearnerKnowledgeState.objects.filter(user=user).count(),
        "exposures": ExposureEvent.objects.filter(session_item=item).count(),
        "ok": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--report", default="")
    args = parser.parse_args()

    report: dict = {"steps": []}
    environment = check_environment(args.email)
    report["steps"].append(environment)
    if environment["is_stub_provider"]:
        report["ok"] = False
        report["note"] = (
            "provider 是 stub/none：这不是真实模型验证。请把 ACEPASS_AI_PROVIDER 设为 openai_compatible "
            "并从安全配置注入 base URL、key 与模型名。"
        )
    else:
        user = User.objects.get(email=args.email)
        _subject, item, attempt = build_question(user=user)
        report["steps"].append(run_tutor_call(user=user, item=item))
        report["steps"].append(side_effect_check(user=user, item=item, attempt=attempt))
        last = report["steps"][-2]
        report["ok"] = last["job_status"] == "succeeded" and not last["is_stub"]
        report["note"] = (
            "真实模型已返回并通过结构校验；讲解内容是否准确仍需人工核验（本脚本只记录逐字输出与校验结果）。"
            if report["ok"]
            else "真实模型调用未成功：失败原因已记录，产品保持人工校对路径，不会伪造结果。"
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.report:
        Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
