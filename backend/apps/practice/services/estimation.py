"""AI per-criterion grade estimation — deliberately inert (B07).

The rule (docs/05 B07): "AI 大题评分逐点评估；人工确认前只有 estimated_score".

So this module writes **one new** ``GradeEvent`` of kind ``ai_estimate`` that
carries ``estimated_score`` and nothing else:

* it never points ``Attempt.current_grade_event`` at it,
* it never touches a human ``manual_confirmation`` (it only supersedes earlier
  ``ai_estimate`` rows, so "the latest estimate" is unambiguous),
* it never writes ``LearningEvidence`` and never changes a
  ``LearnerKnowledgeState`` — no consumer is enqueued at all,
* ``confirmed_score`` stays ``None`` and ``is_fully_confirmed`` stays ``False``.

A learner whose grade is *already* fully confirmed can still ask for an estimate
(a second opinion), and the response says explicitly that the confirmed total is
unaffected (``confirmed_total_unchanged``).
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.db.models import Max

from ai.prompts import registry as prompts
from ai.providers import base as providers
from apps.audit.models import LLMRun
from apps.common.enums import GradeEventKind, GradeMethod, GradeStatus, LlmRunStatus
from apps.common.errors import InvalidInput, PurposeNotAllowed
from apps.practice.models import Attempt, GradeEvent
from apps.practice.services import transcription as transcription_services
from apps.practice.services import verification_gate

#: The capability a provider must declare. A text model is never asked to score
#: work it cannot read.
ESTIMATE_CAPABILITY = "estimate_grade"


def _strip_code_fence(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    return cleaned.strip()


def _blocks_text(blocks: Any) -> str:
    return transcription_services.blocks_text(blocks)


def _learner_answer_text(attempt: Attempt) -> str:
    """Only textual answers are sent — never the photos themselves.

    A handwritten answer reaches the model exclusively through the transcriptions
    the learner already confirmed (``assert_transcription_confirmed`` has run), so
    the model is never asked to score text it read approximately.
    """
    return transcription_services.learner_answer_text(attempt)


def _model_identifier(provider: providers.BaseProvider) -> str:
    return getattr(provider, "text_model", "") or ""


def rubric_criteria(rubric) -> list[dict[str, Any]]:
    """The frozen rubric as validator/prompt criteria (id, cap, description).

    ``description`` comes from the rubric's reviewed ``text``: the model is given
    the human wording, never a rewritten one.
    """
    criteria: list[dict[str, Any]] = []
    for criterion in rubric.criteria or []:
        if not isinstance(criterion, dict) or not criterion.get("criterion_id"):
            continue
        criteria.append(
            {
                "criterion_id": str(criterion["criterion_id"]),
                "max_score": str(criterion.get("max_score", "0")),
                "description": str(criterion.get("text") or criterion.get("description") or ""),
            }
        )
    return criteria


def _new_run(*, attempt: Attempt, provider, request_summary: dict, input_snapshot: dict) -> LLMRun:
    return LLMRun.objects.create(
        provider=provider.name,
        model_identifier=_model_identifier(provider),
        capability=ESTIMATE_CAPABILITY,
        prompt_version=prompts.ESTIMATE_GRADE_PROMPT_VERSION,
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


def estimate_grade(*, attempt: Attempt, actor) -> GradeEvent:
    """Estimate one attempt per rubric criterion. Never a confirmed score.

    ``actor`` is recorded on the audit run (who asked); the estimate itself has no
    grader — it is a model estimate, not a human decision.
    """
    # 1. The gate first, before anything else can look at the answer: a model may
    #    not estimate text it only guessed at.
    transcription_services.assert_transcription_confirmed(attempt)
    item = attempt.session_item
    provider = providers.get_provider()
    if not provider.supports(ESTIMATE_CAPABILITY):
        run = _new_run(
            attempt=attempt,
            provider=provider,
            request_summary={"attempt_id": str(attempt.id), "reason": "provider_missing_capability"},
            input_snapshot={"attempt_id": str(attempt.id)},
        )
        reason = f"provider 不支持能力：{ESTIMATE_CAPABILITY}"
        run.status = LlmRunStatus.UNAVAILABLE
        run.error_code = providers.AiUnavailable.code
        run.error_message = reason
        run.save()
        raise providers.AiUnavailable(reason)
    rubric = item.rubric_version
    if rubric is None:
        raise InvalidInput(
            message="该题没有固定的评分标准（rubric），不能逐点估分；请人工确认总分",
            details={"attempt_id": str(attempt.id)},
        )
    criteria = rubric_criteria(rubric)
    if not criteria:
        raise InvalidInput(
            message="该题的评分标准没有可用的评分点，不能逐点估分",
            details={"rubric_version_id": str(rubric.id)},
        )
    # An estimate is a score-shaped disclosure, so it follows the same content
    # gate as every other delivery path (B02/C01): never while this content is
    # inside a running verification, and never while this item's own grading is
    # deliberately hidden (a live verification or mock exam).
    verification_gate.assert_grading_not_blocked(item=item, action="请求 AI 逐点估分")
    from apps.practice.services import sessions as session_services

    if session_services.delivery_hidden_for_item(item=item, user=attempt.user):
        raise PurposeNotAllowed(
            message="验证/考试进行中：不提供 AI 估分，请先结束本次验证",
            details={"reason": "grading_hidden", "attempt_id": str(attempt.id)},
        )
    rubric_total = Decimal(str(rubric.total_score))
    learner_answer = _learner_answer_text(attempt)
    prompt = prompts.build_estimate_prompt(
        question_type=item.question_version.question_type,
        stem_text=_blocks_text((item.question_version.content or {}).get("blocks")),
        rubric_criteria=criteria,
        learner_answer_text=learner_answer,
        transcription_note=transcription_services.transcription_note_for(attempt),
        max_total=str(rubric_total),
    )
    run = _new_run(
        attempt=attempt,
        provider=provider,
        request_summary={
            "attempt_id": str(attempt.id),
            "question_version_id": str(item.question_version_id),
            "rubric_version_id": str(rubric.id),
            "criterion_ids": [criterion["criterion_id"] for criterion in criteria],
            "requested_by": str(actor.id) if actor is not None else None,
        },
        input_snapshot={
            "attempt_id": str(attempt.id),
            "question_version_id": str(item.question_version_id),
            "rubric_version_id": str(rubric.id),
            "prompt_version": prompts.ESTIMATE_GRADE_PROMPT_VERSION,
            "has_confirmed_transcription": bool(transcription_services.confirmed_text_for(attempt)),
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
                capability=ESTIMATE_CAPABILITY,
                prompt_version=prompts.ESTIMATE_GRADE_PROMPT_VERSION,
                prompt=prompt,
                input_context={"attempt_id": str(attempt.id), "rubric_version_id": str(rubric.id)},
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
        run.error_message = "模型输出不是合法 JSON，未写入任何估分"
        run.save()
        raise providers.AiInvalidOutput("模型估分输出不是合法 JSON，未写入任何估分") from exc
    clean, problems = prompts.validate_estimate(parsed, criteria=criteria)
    run.validation_result = {
        "problems": problems,
        "accepted": not problems,
        "accepted_criterion_ids": [row["criterion_id"] for row in clean["criteria"]],
    }
    if not clean["criteria"]:
        # Nothing usable survived validation. Writing an event now would put a
        # number (0) on the attempt that no model ever produced — a stub in
        # particular must never look like it scored the work.
        run.status = LlmRunStatus.REJECTED
        run.error_code = providers.AiInvalidOutput.code
        run.error_message = "模型没有给出任何可用的评分点估计，未写入估分"
        run.save()
        raise providers.AiInvalidOutput("模型没有给出任何可用的评分点估计，未写入估分")
    run.status = LlmRunStatus.SUCCEEDED
    run.save()
    return _write_estimate(
        attempt=attempt, item=item, rubric=rubric, criteria=criteria, clean=clean, run=run, max_total=rubric_total
    )


@transaction.atomic
def _write_estimate(*, attempt, item, rubric, criteria, clean, run, max_total) -> GradeEvent:
    """Append the estimate event without ever becoming the effective grade.

    The attempt row is locked only for the short write (never across the model
    call). ``grading_revision`` moves forward to keep the append-only revision
    sequence collision-free — a later human confirmation then writes its own new
    revision instead of colliding with this inert row — while
    ``current_grade_event`` is deliberately left pointing at the confirmed grade.
    """
    locked = Attempt.objects.select_for_update().filter(id=attempt.id).first()
    if locked is None:
        raise InvalidInput(message="作答不存在或不在当前权限范围", details={"attempt_id": str(attempt.id)})
    by_criterion = {row["criterion_id"]: row for row in clean["criteria"]}
    caps = {criterion["criterion_id"]: Decimal(criterion["max_score"]) for criterion in criteria}
    parts: list[dict[str, Any]] = []
    estimated_total = Decimal("0")
    for criterion in criteria:
        criterion_id = criterion["criterion_id"]
        row = by_criterion.get(criterion_id)
        if row is None:
            # The model skipped this criterion. The row stays explicitly pending
            # rather than silently missing, so the estimate is never read as
            # "everything was estimated".
            parts.append(
                {
                    "part_id": criterion_id,
                    "score": None,
                    "max_score": str(caps[criterion_id]),
                    "status": GradeStatus.PENDING_REVIEW,
                    "method": None,
                    "rationale": "",
                    "missing_evidence": ["模型未给出该评分点的估计"],
                    "detail": {"reason": "model_omitted_criterion", "text": criterion["description"]},
                }
            )
            continue
        score = Decimal(str(row["estimated_score"]))
        estimated_total += score
        parts.append(
            {
                "part_id": criterion_id,
                "score": str(score),
                "max_score": str(caps[criterion_id]),
                "status": GradeStatus.ESTIMATED,
                "method": GradeMethod.AI_ESTIMATED,
                "rationale": row.get("rationale", ""),
                "missing_evidence": row.get("missing_evidence") or [],
                "detail": {"text": criterion["description"]},
            }
        )
    previous_estimate = (
        GradeEvent.objects.filter(attempt=locked, kind=GradeEventKind.AI_ESTIMATE, is_superseded=False)
        .order_by("-grading_revision")
        .first()
    )
    highest_revision = (
        GradeEvent.objects.filter(attempt=locked).aggregate(highest=Max("grading_revision"))["highest"] or 0
    )
    revision = max(int(locked.grading_revision), int(highest_revision)) + 1
    event = GradeEvent.objects.create(
        attempt=locked,
        kind=GradeEventKind.AI_ESTIMATE,
        status=GradeStatus.ESTIMATED,
        method=GradeMethod.AI_ESTIMATED,
        grading_revision=revision,
        estimated_score=estimated_total,
        confirmed_score=None,
        max_score=item.max_score,
        pending_max_score=Decimal(str(rubric.total_score)),
        is_fully_confirmed=False,
        parts=parts,
        answer_key_version_id=item.answer_key_version_id,
        rubric_version_id=item.rubric_version_id,
        spec_version_id=item.spec_version_id,
        rule_snapshot={
            "inert": True,
            "prompt_version": prompts.ESTIMATE_GRADE_PROMPT_VERSION,
            "criteria_total": str(rubric.total_score),
            "criteria_count": len(criteria),
            "rubric_version_id": str(rubric.id),
            "estimated_criterion_ids": sorted(by_criterion),
        },
        rule_version=item.session.policy_version,
        grader=None,
        grader_is_self=False,
        comment=str(clean.get("overall_note") or "")[:1000],
        supersedes=previous_estimate,
        llm_run=run,
    )
    if previous_estimate is not None:
        # Only earlier *estimates* are superseded. A human manual_confirmation is
        # never touched, and the effective-grade pointer is never moved.
        previous_estimate.is_superseded = True
        previous_estimate.save(update_fields=["is_superseded", "updated_at"])
    if revision > int(locked.grading_revision):
        locked.grading_revision = revision
        locked.save(update_fields=["grading_revision", "updated_at"])
    # No outbox event is enqueued: this row must not rebuild evidence, must not
    # touch a knowledge state, and must not be mistaken for a graded attempt.
    return event


def latest_estimate(attempt: Attempt) -> GradeEvent | None:
    """The newest, not-yet-superseded AI estimate for this attempt."""
    return (
        GradeEvent.objects.filter(attempt=attempt, kind=GradeEventKind.AI_ESTIMATE, is_superseded=False)
        .select_related("llm_run")
        .order_by("-grading_revision")
        .first()
    )


def estimate_payload(event: GradeEvent) -> dict[str, Any]:
    """Wire shape of one estimate: inert, per-criterion, explicitly not a score."""
    run = event.llm_run
    snapshot = event.rule_snapshot or {}
    rubric_revision = str(event.rubric_version_id) if event.rubric_version_id else None
    return {
        "grade_event_id": str(event.id),
        "attempt_id": str(event.attempt_id),
        "kind": event.kind,
        "status": event.status,
        "method": event.method,
        "is_inert": True,
        "estimated_score": str(event.estimated_score) if event.estimated_score is not None else None,
        "confirmed_score": str(event.confirmed_score) if event.confirmed_score is not None else None,
        "confirmed_total_unchanged": True,
        "max_score": str(event.max_score),
        "pending_max_score": str(event.pending_max_score),
        "is_fully_confirmed": False,
        "rubric_version_id": rubric_revision,
        "rubric_revision": rubric_revision,
        "prompt_version": snapshot.get("prompt_version"),
        "criteria": [
            {
                "criterion_id": part.get("part_id"),
                "estimated_score": part.get("score"),
                "max_score": part.get("max_score"),
                "status": part.get("status"),
                "method": part.get("method"),
                "rationale": part.get("rationale", ""),
                "missing_evidence": part.get("missing_evidence") or [],
            }
            for part in (event.parts or [])
        ],
        "overall_note": event.comment,
        "is_stub": bool(run.is_stub) if run is not None else False,
        "provider": run.provider if run is not None else "",
        "model": run.model_identifier if run is not None else "",
        "created_at": event.created_at.isoformat(),
    }


def estimate_state(attempt: Attempt) -> dict[str, Any]:
    """``GET`` shape: the latest estimate, or an explicit empty state."""
    event = latest_estimate(attempt)
    if event is None:
        return {
            "attempt_id": str(attempt.id),
            "has_estimate": False,
            "is_inert": True,
            "confirmed_total_unchanged": True,
            "estimate": None,
            "message": "还没有 AI 估分：正式分数只由人工确认产生，估分不会自动成为成绩。",
        }
    return {
        "attempt_id": str(attempt.id),
        "has_estimate": True,
        "is_inert": True,
        "confirmed_total_unchanged": True,
        "estimate": estimate_payload(event),
        "message": "AI 估分仅供参考，未进入正式分数；正式分数以人工确认为准。",
    }
