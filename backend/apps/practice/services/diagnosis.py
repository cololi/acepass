"""AI-assisted error diagnosis and the follow-up questions it asks (B07).

The rule (docs/05 B07): "诊断追问". A diagnosis is a *candidate* explanation of a
wrong answer, never a verdict:

* a cause is stored with ``origin="model"`` and ``status="proposed"`` — only a
  human confirm/reject path (the existing ``/diagnosis`` endpoint) can settle it,
* a cause without evidence is downgraded to ``unknown`` by the validator and is
  never reported as "careless" (the controlled error-type list has no such value),
* if nothing survives validation, **nothing is stored**: returning an empty result
  with an explicit note is honest, while inventing a cause to look useful is not,
* no score, no grade event, no ``LearningEvidence`` and no knowledge state is ever
  written here — diagnosis changes what we *ask*, not what we scored.

A handwritten answer must be transcribed and confirmed first (the same gate as
estimation): a diagnosis built on text the model only guessed at would be a
diagnosis of a different answer.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from django.db import transaction
from django.utils import timezone

from ai.prompts import registry as prompts
from ai.providers import base as providers
from apps.audit.models import LLMRun
from apps.common.enums import FollowUpStatus, LlmRunStatus, QuestionType
from apps.common.errors import InvalidInput, PurposeNotAllowed, ScopeViolation
from apps.practice.models import Attempt, DiagnosisFollowUp, ErrorDiagnosis
from apps.practice.services import transcription as transcription_services
from apps.practice.services import verification_gate

#: The capability a provider must declare. Diagnosis is a text job: the answer
#: reaches it as confirmed text, never as a photo.
DIAGNOSE_CAPABILITY = "diagnose"

_NO_CAUSE_NOTE = "模型没有给出有证据支持的原因，系统没有替你猜一个原因；可补充解题过程后再试。"


def _strip_code_fence(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    return cleaned.strip()


def _model_identifier(provider: providers.BaseProvider) -> str:
    return getattr(provider, "text_model", "") or ""


def checked_answer(item):
    """The frozen answer, only while it is still trustworthy.

    Eligibility mirrors the helpers the rest of the repo already uses
    (``AnswerKeyVersion.is_usable``; tutoring's ``answer_summary`` and session
    building's ``_resolve_versions``): the answer must be ``checked`` and not
    disputed. A disputed answer is never the reference for a diagnosis.
    """
    answer = item.answer_key_version
    if answer is None or not answer.is_usable:
        return None
    return answer


def _answer_summary(item, answer) -> str:
    """What the diagnosis may compare the learner's work against."""
    if answer is None:
        return ""
    payload = answer.answer_payload or {}
    question_type = item.question_version.question_type
    if question_type == QuestionType.SINGLE_CHOICE:
        return f"正确选项：{payload.get('correct_option_id')}"
    if question_type == QuestionType.MULTIPLE_CHOICE:
        return f"正确选项集合：{', '.join(payload.get('correct_option_ids') or [])}"
    if question_type == QuestionType.TRUE_FALSE:
        return f"标准答案：{'正确' if payload.get('value') else '错误'}"
    if question_type == QuestionType.FILL_BLANK:
        blanks = payload.get("blanks") or {}
        return "各空答案：" + "; ".join(
            f"{blank_id}: {' / '.join(spec.get('accepted_values') or []) or '（数值规则）'}"
            for blank_id, spec in blanks.items()
            if isinstance(spec, dict)
        )
    if question_type == QuestionType.CONSTRUCTED_RESPONSE:
        text = str(payload.get("text") or payload.get("reference_answer") or "").strip()
        if text:
            return f"参考作答：{text[:800]}"
        return "按评分标准逐点评分（请勿给出单一总分）"
    return ""


def _graded_parts(attempt: Attempt) -> list[dict[str, Any]]:
    """The per-criterion scores the diagnosis should explain."""
    grade = attempt.current_grade_event
    if grade is None:
        return []
    parts: list[dict[str, Any]] = []
    for part in grade.parts or []:
        if not isinstance(part, dict):
            continue
        parts.append(
            {
                "criterion_id": part.get("part_id"),
                "score": part.get("score"),
                "max_score": part.get("max_score"),
                "status": part.get("status"),
            }
        )
    return parts


def _new_run(*, attempt: Attempt, provider, request_summary: dict, input_snapshot: dict) -> LLMRun:
    return LLMRun.objects.create(
        provider=provider.name,
        model_identifier=_model_identifier(provider),
        capability=DIAGNOSE_CAPABILITY,
        prompt_version=prompts.DIAGNOSE_PROMPT_VERSION,
        status=LlmRunStatus.FAILED,
        request_summary=request_summary,
        input_snapshot=input_snapshot,
        is_stub=bool(provider.is_stub),
        user=attempt.user,
        project_id=attempt.project_id,
    )


def _record_call(run: LLMRun, call: providers.AiCallResult) -> None:
    run.prompt_tokens = call.prompt_tokens
    run.completion_tokens = call.completion_tokens
    run.cost_cents = call.cost_cents
    run.cost_known = call.cost_known
    run.attempts = call.attempts
    run.latency_ms = call.latency_ms
    run.is_stub = call.is_stub
    run.raw_response_excerpt = (call.raw_text or "")[:4000]
    run.model_identifier = call.model or run.model_identifier
    run.provider = call.provider or run.provider


def _record_failure(run: LLMRun, status: str, exc: Exception) -> None:
    run.status = status
    run.error_code = getattr(exc, "code", "ai_error")
    run.error_message = str(exc)[:500]
    run.cost_known = False
    run.save()


def diagnosis_payload(diagnosis: ErrorDiagnosis) -> dict[str, Any]:
    return {
        "diagnosis_id": str(diagnosis.id),
        "attempt_id": str(diagnosis.attempt_id),
        "error_type": diagnosis.error_type,
        "origin": diagnosis.origin,
        "status": diagnosis.status,
        "evidence": diagnosis.evidence or [],
        "note": diagnosis.note,
        "llm_run_id": str(diagnosis.llm_run_id) if diagnosis.llm_run_id else None,
        "created_at": diagnosis.created_at.isoformat(),
    }


def follow_up_payload(follow_up: DiagnosisFollowUp) -> dict[str, Any]:
    return {
        "follow_up_id": str(follow_up.id),
        "attempt_id": str(follow_up.attempt_id),
        "question": follow_up.question,
        "why": follow_up.why,
        "evidence_kind": follow_up.evidence_kind,
        "status": follow_up.status,
        "answer_text": follow_up.answer_text,
        "answered_at": follow_up.answered_at.isoformat() if follow_up.answered_at else None,
        "llm_run_id": str(follow_up.run_id) if follow_up.run_id else None,
    }


def propose_diagnosis(*, attempt: Attempt, actor, learner_note: str = "") -> dict[str, Any]:
    """Ask the model for candidate causes and the questions that would settle them."""
    # 1. The same gate as estimation: never diagnose text that was only guessed at.
    transcription_services.assert_transcription_confirmed(attempt)
    item = attempt.session_item
    provider = providers.get_provider()
    if not provider.supports(DIAGNOSE_CAPABILITY):
        run = _new_run(
            attempt=attempt,
            provider=provider,
            request_summary={"attempt_id": str(attempt.id), "reason": "provider_missing_capability"},
            input_snapshot={"attempt_id": str(attempt.id)},
        )
        reason = f"provider 不支持能力：{DIAGNOSE_CAPABILITY}"
        run.status = LlmRunStatus.UNAVAILABLE
        run.error_code = providers.AiUnavailable.code
        run.error_message = reason
        run.save()
        raise providers.AiUnavailable(reason)
    # A diagnosis paraphrases the learner's work and can hint at the answer, so it
    # follows the same content gate as every other delivery path.
    verification_gate.assert_grading_not_blocked(item=item, action="请求 AI 错误诊断")
    from apps.practice.services import sessions as session_services

    if session_services.delivery_hidden_for_item(item=item, user=attempt.user):
        raise PurposeNotAllowed(
            message="验证/考试进行中：不提供 AI 诊断，请先结束本次验证",
            details={"reason": "grading_hidden", "attempt_id": str(attempt.id)},
        )
    answer = checked_answer(item)
    learner_answer = transcription_services.learner_answer_text(attempt)
    graded_parts = _graded_parts(attempt)
    prompt = prompts.build_diagnose_prompt(
        question_type=item.question_version.question_type,
        stem_text=transcription_services.blocks_text((item.question_version.content or {}).get("blocks")),
        answer_summary=_answer_summary(item, answer),
        learner_answer_text=(learner_answer + (f"\n学习者的补充说明：{learner_note}" if learner_note else "")),
        graded_parts=graded_parts,
        transcription_note=transcription_services.transcription_note_for(attempt),
    )
    run = _new_run(
        attempt=attempt,
        provider=provider,
        request_summary={
            "attempt_id": str(attempt.id),
            "question_version_id": str(item.question_version_id),
            "answer_key_version_id": str(item.answer_key_version_id) if item.answer_key_version_id else None,
            "answer_usable": answer is not None,
            "criterion_ids": [part["criterion_id"] for part in graded_parts],
            "requested_by": str(actor.id) if actor is not None else None,
            "has_learner_note": bool(learner_note),
        },
        input_snapshot={
            "attempt_id": str(attempt.id),
            "question_version_id": str(item.question_version_id),
            "prompt_version": prompts.DIAGNOSE_PROMPT_VERSION,
            "allowed_error_types": list(prompts.DIAGNOSIS_ERROR_TYPES),
            # Digests, not contents: they let a test (or an auditor) prove the
            # prompt was built from the learner's *confirmed* text.
            "prompt_digest": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            "learner_answer_digest": hashlib.sha256(learner_answer.encode("utf-8")).hexdigest(),
        },
    )
    try:
        call = providers.call_with_deadline(
            provider,
            providers.AiRequest(
                capability=DIAGNOSE_CAPABILITY,
                prompt_version=prompts.DIAGNOSE_PROMPT_VERSION,
                prompt=prompt,
                input_context={"attempt_id": str(attempt.id)},
            ),
        )
    except providers.AiUnavailable as exc:
        _record_failure(run, LlmRunStatus.UNAVAILABLE, exc)
        raise
    except providers.AiError as exc:
        _record_failure(
            run, LlmRunStatus.TIMEOUT if isinstance(exc, providers.AiTimeout) else LlmRunStatus.FAILED, exc
        )
        raise
    _record_call(run, call)
    try:
        parsed = json.loads(_strip_code_fence(call.raw_text))
    except json.JSONDecodeError as exc:
        run.status = LlmRunStatus.REJECTED
        run.error_code = providers.AiInvalidOutput.code
        run.error_message = "模型输出不是合法 JSON，未记录任何诊断"
        run.save()
        raise providers.AiInvalidOutput("模型诊断输出不是合法 JSON，未记录任何诊断") from exc
    clean, problems = prompts.validate_diagnosis(parsed)
    run.validation_result = {
        "problems": problems,
        "accepted": not problems,
        "accepted_error_types": [cause["error_type"] for cause in clean["causes"]],
        "stored_causes": len(clean["causes"]),
        "stored_questions": len(clean["follow_up_questions"]),
    }
    run.status = LlmRunStatus.SUCCEEDED
    run.save()
    return _store_diagnosis(
        attempt=attempt, clean=clean, run=run, learner_note=learner_note, actor=actor
    )


@transaction.atomic
def _store_diagnosis(*, attempt: Attempt, clean: dict[str, Any], run: LLMRun, learner_note: str, actor) -> dict[str, Any]:
    """Persist only the validated causes and questions. Nothing else is written."""
    causes = clean["causes"]
    follow_ups: list[DiagnosisFollowUp] = []
    if causes:
        for cause in causes:
            ErrorDiagnosis.objects.create(
                attempt=attempt,
                error_type=str(cause["error_type"])[:40],
                evidence=cause.get("evidence") or [],
                origin="model",
                status="proposed",
                note=str(learner_note or "")[:500],
                llm_run=run,
                # ``origin=model`` rows are proposals: a human decides them through
                # the existing /diagnosis endpoint, so no decision is pre-filled.
                decided_by=None,
                decided_at=None,
            )
        for question in clean["follow_up_questions"]:
            follow_ups.append(
                DiagnosisFollowUp.objects.create(
                    attempt=attempt,
                    question=str(question["question"])[:500],
                    why=str(question.get("why") or "")[:300],
                    evidence_kind=str(question.get("evidence_kind") or "")[:60],
                    status=FollowUpStatus.PENDING,
                    run=run,
                )
            )
    stored = list(ErrorDiagnosis.objects.filter(attempt=attempt, llm_run=run).order_by("created_at"))
    return {
        "attempt_id": str(attempt.id),
        "origin": "model",
        "status": "proposed",
        "causes": [diagnosis_payload(row) for row in stored],
        "follow_up_questions": [follow_up_payload(row) for row in follow_ups],
        "missing_information": clean.get("missing_information") or [],
        "note": "" if causes else _NO_CAUSE_NOTE,
        "recorded": bool(causes),
        "is_stub": bool(run.is_stub),
        "prompt_version": prompts.DIAGNOSE_PROMPT_VERSION,
        "llm_run_id": str(run.id),
        "requested_by": str(actor.id) if actor is not None else None,
        # Explicit, so a client cannot read this as a grading action.
        "scores_changed": False,
        "knowledge_state_changed": False,
    }


@transaction.atomic
def answer_follow_up(*, follow_up: DiagnosisFollowUp, actor, text: str) -> DiagnosisFollowUp:
    """Record the learner's process evidence (never a score, never a state)."""
    locked = DiagnosisFollowUp.objects.select_for_update().filter(id=follow_up.id).first()
    if locked is None:
        raise ScopeViolation(message="追问不存在或不在当前权限范围")
    if locked.status != FollowUpStatus.PENDING:
        raise InvalidInput(message="该追问已经处理过", details={"status": locked.status})
    answer = str(text or "").strip()
    if not answer:
        raise InvalidInput(message="追问回答不能为空；不想回答请选择跳过")
    locked.answer_text = answer[:8000]
    locked.status = FollowUpStatus.ANSWERED
    locked.answered_at = timezone.now()
    locked.save()
    return locked


@transaction.atomic
def skip_follow_up(*, follow_up: DiagnosisFollowUp, actor) -> DiagnosisFollowUp:
    locked = DiagnosisFollowUp.objects.select_for_update().filter(id=follow_up.id).first()
    if locked is None:
        raise ScopeViolation(message="追问不存在或不在当前权限范围")
    if locked.status != FollowUpStatus.PENDING:
        raise InvalidInput(message="该追问已经处理过", details={"status": locked.status})
    locked.status = FollowUpStatus.SKIPPED
    locked.answered_at = timezone.now()
    locked.save()
    return locked
