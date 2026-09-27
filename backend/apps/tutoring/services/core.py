"""Tutoring services: permission-gated, versioned, audited explanations.

Flow (docs/02 §6):

    permission -> freeze versions -> retrieve linked material -> build prompt
    -> call provider -> validate structure and citations -> store candidate
    -> reveal only the validated content

An explanation never writes a score, a mastery state, a plan or a statistic. If
the answer is not trustworthy, the tutor may only clarify conditions.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from ai.prompts import registry as prompts
from ai.providers import base as providers
from apps.audit.models import LLMRun
from apps.audit.services.outbox import enqueue
from apps.common.content import normalize_content
from apps.common.enums import (
    ExposureKind,
    LlmRunStatus,
    SessionMode,
    SessionStatus,
    TutorPurpose,
    TutorRequestStatus,
)
from apps.common.errors import InvalidInput, PurposeNotAllowed, ScopeViolation
from apps.practice.models import Attempt, SessionItem
from apps.practice.services import exposure
from apps.tutoring.models import TutorJob, TutorSession, TutorTurn

logger = logging.getLogger("apps.tutoring")


def _blocks_text(blocks: Any) -> str:
    """Render blocks for a prompt, keeping math and never dropping content.

    A math block lowers to ``$latex$`` and an image block to an explicit
    placeholder: silently emitting an empty string for them made the prompt look
    complete while the model was actually missing the question.
    """
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("kind")
        if kind == "text":
            parts.append(str(block.get("text", "")))
        elif kind == "math":
            parts.append(f"${block.get('latex', '')}$")
        elif kind == "list":
            parts.append("\n".join(f"- {item}" for item in (block.get("items") or [])))
        elif kind == "image":
            parts.append(f"[图片 {block.get('asset_id') or '未标注'}]")
    return "\n".join(part for part in parts if part)


def assert_tutoring_allowed(item: SessionItem, purpose: str) -> None:
    """Server-side gate. Hiding the button in the UI is not a control."""
    from apps.practice.services import verification_gate

    session = item.session
    if session.status != SessionStatus.ACTIVE:
        raise PurposeNotAllowed(message="会话已结束；如需辅导请新建练习会话")
    if session.mode != SessionMode.PRACTICE:
        raise PurposeNotAllowed(
            message="验证/考试模式不提供提示、讲解或诊断；如需辅导请先结束本次验证，再新建练习会话。"
        )
    if not item.tutoring_allowed:
        raise PurposeNotAllowed(message="该题项按计划不提供辅导（例如延迟验证题）")
    if purpose not in TutorPurpose.values:
        raise InvalidInput(message="辅导用途无效")
    # B02: an explanation delivers the answer. The item being a *practice* item
    # is not enough — the same content may be under a running verification in
    # another tab, session or project, and that run's integrity does not depend
    # on which endpoint is asked. The check is content-based and server-side.
    verification_gate.assert_content_not_in_active_verification(
        user=session.user,
        question_version=item.question_version,
        action="请求讲解与答案",
        exclude_item_id=item.id,
    )


def _allowed_citation_ids(item: SessionItem) -> tuple[list[str], dict[str, Any]]:
    """Citations a model may use: the frozen version and reviewed material only."""
    citations: list[str] = []
    context: dict[str, Any] = {}
    version = item.question_version
    citations.append(f"question_version:{version.id}")
    context["question_version"] = str(version.id)
    if item.answer_key_version_id:
        citations.append(f"answer_key_version:{item.answer_key_version_id}")
        context["answer_key_version"] = str(item.answer_key_version_id)
    if item.rubric_version_id:
        citations.append(f"rubric_version:{item.rubric_version_id}")
        context["rubric_version"] = str(item.rubric_version_id)
    if item.spec_version_id:
        citations.append(f"exam_spec_version:{item.spec_version_id}")
        context["exam_spec_version"] = str(item.spec_version_id)
    mappings = list(
        version.knowledge_mappings.filter(mapping_revision=item.mapping_revision).select_related("node")
    )
    for mapping in mappings:
        citations.append(f"knowledge_node:{mapping.node_id}")
    context["knowledge_nodes"] = [str(mapping.node_id) for mapping in mappings]
    # Names, not just opaque ids: the model cannot explain "this knowledge point"
    # from a UUID.
    context["knowledge_node_names"] = [mapping.node.canonical_name for mapping in mappings]
    return citations, context


def create_tutor_session(*, item: SessionItem, user, purpose: str = TutorPurpose.EXPLANATION) -> TutorSession:
    assert_tutoring_allowed(item, purpose)
    attempt = Attempt.objects.filter(session_item=item).first()
    return TutorSession.objects.create(
        user=user,
        project=item.session.project,
        practice_session=item.session,
        session_item=item,
        attempt=attempt,
        purpose=purpose,
        question_version=item.question_version,
        answer_key_version=item.answer_key_version,
        rubric_version=item.rubric_version,
        prompt_version=prompts.EXPLAIN_PROMPT_VERSION,
    )


def build_prompt(*, item: SessionItem, user_question: str = "") -> str:
    """Build the frozen prompt for one explain request.

    The prompt is *personalised*: it carries the student's own submitted answer,
    their steps, their confidence, their uploaded answer photos, the reviewed
    rubric criteria and the shared material. Passing only the grading status made
    "针对卡点讲解" impossible — the model could not see what the student wrote.
    """
    citations, context = _allowed_citation_ids(item)
    version = item.question_version
    material_blocks = None
    if version.parent_material_version_id:
        material_blocks = (version.parent_material_version.content or {}).get("blocks") or []
    return prompts.build_explain_prompt(
        question_type=version.question_type,
        stem_text=_blocks_text((version.content or {}).get("blocks")),
        options=(version.content or {}).get("options") or [],
        answer_summary=answer_summary(item),
        explanation_blocks=item.answer_key_version.explanation_blocks if item.answer_key_version_id else [],
        allowed_citation_ids=citations,
        attempt_summary=_attempt_summary(item),
        user_question=user_question,
        knowledge_nodes=context.get("knowledge_node_names") or [],
        rubric_criteria=(item.rubric_version.criteria if item.rubric_version_id else []) or [],
        material_text=_blocks_text(material_blocks) if material_blocks else "",
        blanks=(version.content or {}).get("blanks") or [],
    )


def _render_raw_answer(raw_answer: Any) -> str:
    """Render the student's submitted answer verbatim, for every question type."""
    if not isinstance(raw_answer, dict) or not raw_answer:
        return ""
    question_type = raw_answer.get("type")
    if question_type == "single_choice":
        selected = raw_answer.get("selected_option_ids") or raw_answer.get("selected_option_id")
        return f"选择：{selected if isinstance(selected, list) else [selected]}"
    if question_type == "multiple_choice":
        return f"选择：{raw_answer.get('selected_option_ids') or []}"
    if question_type == "true_false":
        value = raw_answer.get("value")
        return "判断：" + ("未作答" if value is None else ("正确" if value else "错误"))
    if question_type == "fill_blank":
        blanks = raw_answer.get("blanks") or {}
        return "各空作答：" + "; ".join(f"{key}={value!r}" for key, value in blanks.items())
    if question_type == "constructed_response":
        return f"作答原文：{raw_answer.get('text', '')}"
    return f"作答原文：{json.dumps(raw_answer, ensure_ascii=False)[:2000]}"


def _render_steps(steps: Any) -> str:
    if not isinstance(steps, list) or not steps:
        return ""
    lines: list[str] = []
    for index, step in enumerate(steps, start=1):
        if isinstance(step, dict):
            text = step.get("text") or _blocks_text(step.get("blocks")) or json.dumps(step, ensure_ascii=False)
        else:
            text = str(step)
        if str(text).strip():
            lines.append(f"步骤 {index}：{text}")
    return "\n".join(lines)


def _attempt_summary(item: SessionItem) -> str:
    """The student's actual work plus the factual grading state.

    Order matters: the work comes first because it is what the explanation must
    address, and the score status is context rather than the subject.
    """
    attempt = Attempt.objects.filter(session_item=item).select_related("current_grade_event").first()
    if attempt is None:
        return ""
    lines: list[str] = []
    rendered = _render_raw_answer(attempt.raw_answer)
    if rendered:
        lines.append(rendered)
    steps = _render_steps(attempt.steps)
    if steps:
        lines.append("学生的解题步骤：\n" + steps)
    if attempt.attachments:
        lines.append(f"学生上传的作答照片数量：{len(attempt.attachments)}（内容不随本请求传输，仅用于人工评分）。")
    if attempt.confidence:
        lines.append(f"学生自评把握：{attempt.confidence}")
    if attempt.elapsed_ms:
        lines.append(f"本次用时：{attempt.elapsed_ms / 1000:.0f} 秒")
    grade = attempt.current_grade_event
    if grade is None:
        lines.append("判分状态：已提交，处理中（不要猜分数）")
    else:
        parts = ", ".join(
            f"{part.get('part_id')}: {part.get('status')}"
            + (f"({part.get('score')}/{part.get('max_score')})" if part.get("score") is not None else "")
            for part in (grade.parts or [])
        )
        lines.append(f"判分状态 {grade.status}；分项：{parts or '无'}")
        if grade.comment:
            lines.append(f"评分备注：{grade.comment}")
    return "\n".join(lines)


def answer_summary(item: SessionItem) -> str:
    answer = item.answer_key_version
    if answer is None or not answer.is_usable:
        return ""
    payload = answer.answer_payload or {}
    if item.question_version.question_type == "single_choice":
        return f"正确选项：{payload.get('correct_option_id')}"
    if item.question_version.question_type == "multiple_choice":
        return f"正确选项集合：{', '.join(payload.get('correct_option_ids') or [])}"
    if item.question_version.question_type == "true_false":
        return f"标准答案：{'正确' if payload.get('value') else '错误'}"
    if item.question_version.question_type == "fill_blank":
        blanks = payload.get("blanks") or {}
        return "各空答案：" + "; ".join(
            f"{blank_id}: {' / '.join(spec.get('accepted_values') or []) or '（数值规则）'}"
            for blank_id, spec in blanks.items()
            if isinstance(spec, dict)
        )
    if item.question_version.question_type == "constructed_response":
        return "按评分标准逐点评分（请勿给出单一总分）"
    return ""


@transaction.atomic
def create_job(
    *,
    tutor_session: TutorSession,
    user,
    user_question: str = "",
    purpose: str | None = None,
) -> TutorJob:
    """Create the job, freeze inputs, and record the run. Nothing is returned raw."""
    item = tutor_session.session_item
    resolved_purpose = purpose or tutor_session.purpose
    assert_tutoring_allowed(item, resolved_purpose)
    prompt = build_prompt(item=item, user_question=user_question)
    citations, context = _allowed_citation_ids(item)
    version = item.question_version
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "prompt": prompt,
                "prompt_version": prompts.EXPLAIN_PROMPT_VERSION,
                "question_version": str(version.id),
                "answer_key_version": str(item.answer_key_version_id),
                "rubric_version": str(item.rubric_version_id),
            },
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    job = TutorJob.objects.create(
        tutor_session=tutor_session,
        user=user,
        project=item.session.project,
        purpose=resolved_purpose,
        status=TutorRequestStatus.QUEUED,
        request_text=user_question[:2000],
        input_fingerprint=fingerprint,
        reveals_answer=resolved_purpose in {TutorPurpose.EXPLANATION},
    )
    TutorTurn.objects.create(
        tutor_session=tutor_session, role="user", text=user_question[:2000] or "（请求讲解）"
    )
    run = LLMRun.objects.create(
        provider=providers.get_provider().name,
        model_identifier=_model_identifier("explain"),
        capability="explain",
        prompt_version=prompts.EXPLAIN_PROMPT_VERSION,
        status=LlmRunStatus.FAILED,
        request_summary={
            "purpose": resolved_purpose,
            "question_version_id": str(version.id),
            "answer_key_version_id": str(item.answer_key_version_id),
            "rubric_version_id": str(item.rubric_version_id),
            "syllabus_version_id": str(item.rubric_version.answer_key_version.question_version.question.subject_id)
            if item.rubric_version_id
            else None,
            "user_question_present": bool(user_question),
        },
        input_snapshot={
            "question_version_id": str(version.id),
            "content_digest": hashlib.sha256(
                json.dumps(normalize_content(version.content or {}), sort_keys=True, ensure_ascii=False).encode("utf-8")
            ).hexdigest(),
            "answer_key_version_id": str(item.answer_key_version_id) if item.answer_key_version_id else None,
            "rubric_version_id": str(item.rubric_version_id) if item.rubric_version_id else None,
            "spec_version_id": str(item.spec_version_id) if item.spec_version_id else None,
            "retrieval": context,
        },
        retrieval_source_ids=citations,
        user=user,
        project_id=item.session.project_id,
    )
    job.llm_run = run
    job.save(update_fields=["llm_run", "updated_at"])
    enqueue(
        "tutoring.run_job",
        {"tutor_job_id": str(job.id), "prompt": prompt, "citations": citations, "purpose": resolved_purpose},
        dedupe_key=f"tutor-job:{job.id}",
    )
    return job


def _model_identifier(capability: str) -> str:
    provider = providers.get_provider()
    if capability == "extract_question":
        return getattr(provider, "vision_model", "") or ""
    return getattr(provider, "text_model", "") or ""


def assert_job_deliverable(job: TutorJob) -> None:
    """A queued or stored explanation may only be delivered while its content is
    not part of a running verification.

    Checked at *read* time as well as at creation time: a job created before the
    verification started still holds the answer, so the cached result is exactly
    the bypass B02 described ("旧任务结果读取没有内容门禁").
    """
    from apps.practice.services import verification_gate

    item = job.tutor_session.session_item
    verification_gate.assert_content_not_in_active_verification(
        user=job.user,
        question_version=item.question_version,
        action="读取讲解与答案",
        exclude_item_id=item.id,
    )


def run_job(*, job: TutorJob, prompt: str, citations: list[str], purpose: str) -> TutorJob:
    """Execute one provider call, validate it, and store only the validated result."""
    if job.status in {TutorRequestStatus.SUCCEEDED, TutorRequestStatus.FAILED, TutorRequestStatus.UNAVAILABLE}:
        return job
    try:
        assert_job_deliverable(job)
    except PurposeNotAllowed as exc:
        # Terminal, honest refusal: nothing is stored, and the reason is on the
        # job so a later read does not look like an unexplained failure.
        job.status = TutorRequestStatus.FAILED
        job.error_code = "blocked_by_active_verification"
        job.error_message = str(getattr(exc, "message", exc))[:500]
        job.result_blocks = []
        job.save(update_fields=["status", "error_code", "error_message", "result_blocks", "updated_at"])
        return job
    provider = providers.get_provider()
    run = job.llm_run
    started = timezone.now()
    job.status = TutorRequestStatus.RUNNING
    job.save(update_fields=["status", "updated_at"])
    try:
        call = providers.call_with_deadline(
            provider,
            providers.AiRequest(
                capability="explain",
                prompt_version=prompts.EXPLAIN_PROMPT_VERSION,
                prompt=prompt,
            ),
        )
    except providers.AiUnavailable as exc:
        job.status = TutorRequestStatus.UNAVAILABLE
        job.error_code = exc.code
        job.error_message = str(exc)[:500]
        job.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        _record_failure(run, LlmRunStatus.UNAVAILABLE, exc)
        return job
    except providers.AiError as exc:
        job.status = TutorRequestStatus.FAILED
        job.error_code = exc.code
        job.error_message = str(exc)[:500]
        job.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        _record_failure(run, LlmRunStatus.TIMEOUT if isinstance(exc, providers.AiTimeout) else LlmRunStatus.FAILED, exc)
        return job

    try:
        parsed = json.loads(_strip_code_fence(call.raw_text))
    except json.JSONDecodeError:
        job.status = TutorRequestStatus.FAILED
        job.error_code = "ai_invalid_output"
        job.error_message = "模型输出不是合法 JSON，未展示任何内容"
        job.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        _record_failure(run, LlmRunStatus.REJECTED, providers.AiInvalidOutput("invalid JSON"), call=call)
        return job

    clean, problems = prompts.validate_explain_payload(parsed, allowed_citation_ids=set(citations))
    run.validation_result = {"problems": problems, "accepted": not problems}
    if call.is_stub:
        run.is_stub = True
    if problems:
        job.status = TutorRequestStatus.FAILED
        job.error_code = "ai_invalid_output"
        job.error_message = "模型输出未通过校验，未展示：" + "; ".join(p["message"] for p in problems[:3])[:400]
        job.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        _record_failure(run, LlmRunStatus.REJECTED, providers.AiInvalidOutput(job.error_message), call=call)
        return job

    item = job.tutor_session.session_item
    frozen_ok = (
        str(item.question_version_id) == str(job.tutor_session.question_version_id)
        and str(item.answer_key_version_id or "") == str(job.tutor_session.answer_key_version_id or "")
    )
    job.result_blocks = clean["explanation_blocks"]
    job.citations = clean["citations"]
    job.missing_information = clean["missing_information"]
    job.suggested_next = clean["suggested_next"]
    job.status = TutorRequestStatus.SUCCEEDED
    job.delivered_at = timezone.now()
    job.is_stale = not frozen_ok
    job.save(
        update_fields=[
            "result_blocks",
            "citations",
            "missing_information",
            "suggested_next",
            "status",
            "delivered_at",
            "is_stale",
            "updated_at",
        ]
    )
    run.status = LlmRunStatus.SUCCEEDED
    run.prompt_tokens = call.prompt_tokens
    run.completion_tokens = call.completion_tokens
    run.cost_cents = call.cost_cents
    run.cost_known = call.cost_known
    run.attempts = call.attempts
    run.latency_ms = call.latency_ms
    run.is_stub = call.is_stub
    run.model_identifier = call.model or run.model_identifier
    run.provider = call.provider or run.provider
    run.raw_response_excerpt = call.raw_text[:4000]
    run.save()
    TutorTurn.objects.create(
        tutor_session=job.tutor_session,
        role="assistant",
        text=_blocks_text(clean["explanation_blocks"])[:8000],
        job=job,
    )
    # The delivered bundle is an exposure fact, recorded from the server side.
    kind = ExposureKind.ANSWER_DELIVERED if job.reveals_answer else ExposureKind.EXPLANATION_DELIVERED
    exposure.record(
        user=job.user,
        project=job.project,
        question=item.question_version.question,
        question_version=item.question_version,
        session_item=item,
        kind=kind,
        purpose="practice",
        source=f"tutor_job:{purpose}",
        reveals_answer=job.reveals_answer,
        detail={
            "tutor_job_id": str(job.id),
            "prompt_version": prompts.EXPLAIN_PROMPT_VERSION,
            "is_stub": call.is_stub,
            "delivered_at": job.delivered_at.isoformat() if job.delivered_at else None,
        },
    )
    del started
    return job


def _record_failure(run: LLMRun | None, status: str, exc: Exception, call: providers.AiCallResult | None = None) -> None:
    if run is None:
        return
    run.status = status
    run.error_code = getattr(exc, "code", "ai_error")
    run.error_message = str(exc)[:500]
    if call is not None:
        run.attempts = call.attempts
        run.latency_ms = call.latency_ms
        run.raw_response_excerpt = call.raw_text[:4000]
        run.is_stub = call.is_stub
    else:
        run.cost_known = False
        run.cost_cents = None
    run.save()


def _strip_code_fence(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3]
    return cleaned.strip()


def job_payload(job: TutorJob, *, include_content: bool = True) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "tutor_job_id": str(job.id),
        "tutor_session_id": str(job.tutor_session_id),
        "session_item_id": str(job.tutor_session.session_item_id),
        "purpose": job.purpose,
        "status": job.status,
        "reveals_answer": job.reveals_answer,
        "is_stale": job.is_stale,
        "is_stub": bool(job.llm_run.is_stub) if job.llm_run_id else False,
        "provider": job.llm_run.provider if job.llm_run_id else "",
        "model": job.llm_run.model_identifier if job.llm_run_id else "",
        "prompt_version": job.llm_run.prompt_version if job.llm_run_id else "",
        "error_code": job.error_code,
        "error_message": job.error_message,
        "delivered_at": job.delivered_at.isoformat() if job.delivered_at else None,
    }
    if include_content and job.status == TutorRequestStatus.SUCCEEDED:
        payload["result_blocks"] = job.result_blocks
        payload["citations"] = job.citations
        payload["missing_information"] = job.missing_information
        payload["suggested_next"] = job.suggested_next
    else:
        payload["result_blocks"] = []
        payload["citations"] = []
        payload["missing_information"] = []
        payload["suggested_next"] = []
    return payload


def ai_status() -> dict[str, Any]:
    status = providers.provider_status()
    status["max_retries"] = getattr(settings, "AI_MAX_RETRIES", 2)
    status["total_timeout_seconds"] = getattr(settings, "AI_TOTAL_TIMEOUT_SECONDS", 90)
    return status


def recent_runs(*, project_id: str, limit: int = 20) -> list[dict[str, Any]]:
    runs = LLMRun.objects.filter(project_id=project_id).order_by("-created_at")[: max(1, min(limit, 50))]
    return [
        {
            "id": str(run.id),
            "provider": run.provider,
            "model": run.model_identifier,
            "capability": run.capability,
            "prompt_version": run.prompt_version,
            "status": run.status,
            "is_stub": run.is_stub,
            "attempts": run.attempts,
            "latency_ms": run.latency_ms,
            "cost_cents": str(run.cost_cents) if run.cost_cents is not None else None,
            "cost_known": run.cost_known,
            "prompt_tokens": run.prompt_tokens,
            "completion_tokens": run.completion_tokens,
            "error_code": run.error_code,
            "created_at": run.created_at.isoformat(),
        }
        for run in runs
    ]


def session_scope(user, project, tutor_session_id: str) -> TutorSession:
    session = TutorSession.objects.filter(id=tutor_session_id, user=user, project=project).first()
    if session is None:
        raise ScopeViolation(message="辅导会话不存在或不在当前权限范围")
    return session
