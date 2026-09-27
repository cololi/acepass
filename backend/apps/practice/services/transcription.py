"""Handwriting transcription: propose -> human decides -> one gate (B07).

A photo answer is not readable text. The model reads the photo and *proposes* a
transcription; the learner confirms or edits it. Until that happens the answer is
opaque, so nothing downstream may grade it:

* :func:`handwriting_assets` lists the photos of a constructed-response attempt
  that still have no confirmed transcription,
* :func:`assert_transcription_confirmed` is the single gate every consumer
  (estimation, diagnosis, the tutoring workstream) must call before touching the
  answer.

The proposal is inert: :attr:`AnswerTranscription.raw_text` is what the model
*thinks* it read, ``is_stub`` marks a test/demo result, and only
``confirmed_text`` may be used as the learner's answer. A stub transcription says
so in its own text, so it can never pass for a real recognition result.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from django.db import transaction
from django.utils import timezone

from ai.prompts import registry as prompts
from ai.providers import base as providers
from apps.audit.models import ContentRevision, LLMRun
from apps.common.enums import LlmRunStatus, QuestionType, TranscriptionStatus
from apps.common.errors import DependencyUnavailable, InvalidInput, ScopeViolation, TranscriptionRequired
from apps.ingestion.services.access import asset_scope
from apps.ingestion.storage import StorageError, get_storage
from apps.practice.models import AnswerTranscription, Attempt

#: The capability a provider must declare to read a photo. A text-only model is
#: never asked to guess at handwriting.
TRANSCRIBE_CAPABILITY = "transcribe_handwriting"

#: Statuses whose ``confirmed_text`` is the learner's answer.
CONFIRMED_STATUSES = frozenset({TranscriptionStatus.CONFIRMED, TranscriptionStatus.EDITED})


def blocks_text(blocks: Any) -> str:
    """Render question blocks for prompt context, keeping math and images.

    Shared by the transcription, estimation and diagnosis prompts so all three
    send the model the same question wording.
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


def learner_answer_text(attempt: Attempt) -> str:
    """The learner's own *text*: the typed answer plus confirmed transcriptions.

    Photos are never passed on as bytes by an estimation/diagnosis prompt; a
    handwritten answer reaches those prompts only through the transcriptions the
    learner confirmed.
    """
    raw = attempt.raw_answer if isinstance(attempt.raw_answer, dict) else {}
    question_type = raw.get("type")
    parts: list[str] = []
    if question_type == QuestionType.CONSTRUCTED_RESPONSE:
        text = str(raw.get("text") or "").strip()
        if text:
            parts.append(text)
    elif question_type == QuestionType.FILL_BLANK:
        blanks = raw.get("blanks") or {}
        rendered = "；".join(f"{key}={value}" for key, value in blanks.items())
        if rendered:
            parts.append(rendered)
    elif raw:
        parts.append(json.dumps(raw, ensure_ascii=False)[:2000])
    confirmed = confirmed_text_for(attempt)
    if confirmed:
        parts.append("【学习者已确认的手写转写】\n" + confirmed)
    return "\n".join(parts)


def _strip_code_fence(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    return cleaned.strip()


def _model_identifier(provider: providers.BaseProvider, capability: str) -> str:
    if capability == TRANSCRIBE_CAPABILITY:
        return getattr(provider, "vision_model", "") or ""
    return getattr(provider, "text_model", "") or ""


def handwriting_assets(attempt: Attempt) -> list[str]:
    """Answer photos that still need a confirmed transcription.

    Only a constructed-response attempt carries handwritten work; a photo attached
    to any other type is not a transcription target.
    """
    item = attempt.session_item
    if item.question_version.question_type != QuestionType.CONSTRUCTED_RESPONSE:
        return []
    confirmed = set(
        AnswerTranscription.objects.filter(attempt=attempt, status__in=CONFIRMED_STATUSES).values_list(
            "asset_id", flat=True
        )
    )
    return [str(asset_id) for asset_id in (attempt.attachments or []) if str(asset_id) not in confirmed]


def assert_transcription_confirmed(attempt: Attempt) -> None:
    """The single gate: refuse to grade/diagnose an unconfirmed transcription.

    Exported for reuse — estimation, diagnosis and any other module that would
    otherwise consume a photo answer must call this first, so a new entry point
    cannot quietly skip the learner's confirmation.
    """
    pending = handwriting_assets(attempt)
    if pending:
        raise TranscriptionRequired(details={"asset_ids": pending})


def confirmed_text_for(attempt: Attempt) -> str:
    """The learner's own transcriptions, concatenated, for prompts."""
    rows = (
        AnswerTranscription.objects.filter(attempt=attempt, status__in=CONFIRMED_STATUSES)
        .exclude(confirmed_text="")
        .order_by("created_at")
    )
    return "\n".join(row.confirmed_text for row in rows)


def transcription_note_for(attempt: Attempt) -> str:
    """Prompt note: how many photos were transcribed and what was doubtful."""
    rows = list(
        AnswerTranscription.objects.filter(attempt=attempt, status__in=CONFIRMED_STATUSES).order_by("created_at")
    )
    if not rows:
        return ""
    doubts = [str(doubt) for row in rows for doubt in (row.doubts or []) if str(doubt).strip()]
    note = f"手写作答已由学习者确认 {len(rows)} 张照片的转写。"
    if doubts:
        note += "转写时标注的疑点（仍以确认文本为准）：" + "；".join(doubts[:5])
    return note


def transcription_payload(transcription: AnswerTranscription) -> dict[str, Any]:
    """Wire shape of one transcription row. ``raw_text`` stays labelled."""
    return {
        "transcription_id": str(transcription.id),
        "attempt_id": str(transcription.attempt_id),
        "asset_id": transcription.asset_id,
        "origin": transcription.origin,
        "status": transcription.status,
        "raw_text": transcription.raw_text,
        "confirmed_text": transcription.confirmed_text,
        "confidence": transcription.confidence,
        "doubts": transcription.doubts or [],
        "is_stub": transcription.is_stub,
        "note": transcription.note,
        "is_confirmed": transcription.status in CONFIRMED_STATUSES,
        "decided_at": transcription.decided_at.isoformat() if transcription.decided_at else None,
        "llm_run_id": str(transcription.run_id) if transcription.run_id else None,
        "prompt_version": prompts.TRANSCRIBE_PROMPT_VERSION if transcription.origin == "model" else "",
    }


@transaction.atomic
def record_manual_transcription(
    *, attempt: Attempt, asset_id: str, text: str, actor, note: str = ""
) -> AnswerTranscription:
    """Record what the learner says they wrote, without any model.

    This is the honest fallback required by the P0 rule "no vision model means the
    human path": a photo answer must not become permanently un-gradeable just
    because no provider is configured. The row is created already confirmed
    (``origin="manual"``), carries no confidence and no doubts, and is never
    labelled as a recognition result.
    """
    asset_id = str(asset_id or "").strip()
    attachments = [str(value) for value in (attempt.attachments or [])]
    if not asset_id or asset_id not in attachments:
        raise InvalidInput(
            message="该图片不属于本次作答，不能录入转写",
            details={"asset_id": asset_id, "attachment_asset_ids": attachments},
        )
    body = (text or "").strip()
    if not body:
        raise InvalidInput(message="人工录入的转写文本不能为空")
    locked = AnswerTranscription.objects.select_for_update().filter(attempt=attempt, asset_id=asset_id).first()
    if locked is not None and locked.origin == "model" and locked.status in CONFIRMED_STATUSES:
        raise InvalidInput(
            message="该图片的模型转写已确认，不能改写为人工录入",
            details={"transcription_id": str(locked.id), "status": locked.status},
        )
    now = timezone.now()
    fields = {
        "origin": "manual",
        "status": TranscriptionStatus.CONFIRMED,
        "raw_text": body[:8000],
        "confirmed_text": body[:8000],
        "confidence": None,
        "doubts": [],
        "is_stub": False,
        "run": None,
        "decided_by": actor,
        "decided_at": now,
        "note": (note or "学习者人工录入转写（未使用视觉模型）")[:500],
    }
    if locked is None:
        locked = AnswerTranscription.objects.create(attempt=attempt, asset_id=asset_id, **fields)
    else:
        for name, value in fields.items():
            setattr(locked, name, value)
        locked.save(
            update_fields=[*fields.keys(), "updated_at"],
        )
    ContentRevision.objects.create(
        actor=actor,
        entity_type="answer_transcription",
        entity_id=str(locked.id),
        action="transcription_confirmed",
        project_id=attempt.project_id,
        detail={"asset_id": asset_id, "origin": "manual", "attempt_id": str(attempt.id)},
    )
    return locked


def _new_run(*, attempt: Attempt, provider, request_summary: dict, input_snapshot: dict) -> LLMRun:
    """Record the invocation *before* it happens; failures are updated onto it."""
    return LLMRun.objects.create(
        provider=provider.name,
        model_identifier=_model_identifier(provider, TRANSCRIBE_CAPABILITY),
        capability=TRANSCRIBE_CAPABILITY,
        prompt_version=prompts.TRANSCRIBE_PROMPT_VERSION,
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


def _read_asset_bytes(asset) -> bytes:
    storage = get_storage()
    if not storage.exists(asset.object_key):
        raise StorageError("asset bytes are missing")
    with storage.open(asset.object_key) as handle:
        return handle.read()


def request_transcription(*, attempt: Attempt, asset_id: str, actor) -> AnswerTranscription:
    """Ask a vision provider to transcribe one answer photo.

    The result is only ever a *proposal*. A rerun replaces the proposal fields;
    it never overwrites a row the learner already confirmed or edited.
    """
    asset_id = str(asset_id or "").strip()
    attachments = [str(value) for value in (attempt.attachments or [])]
    if not asset_id or asset_id not in attachments:
        raise InvalidInput(
            message="该图片不属于本次作答，不能转写",
            details={"asset_id": asset_id, "attachment_asset_ids": attachments},
        )
    existing = AnswerTranscription.objects.filter(attempt=attempt, asset_id=asset_id).first()
    if existing is not None and existing.status in CONFIRMED_STATUSES:
        raise InvalidInput(
            message="该图片的转写已由学习者确认，不能重新转写；如需修改请重新提交作答",
            details={"transcription_id": str(existing.id), "status": existing.status},
        )
    item = attempt.session_item
    question = item.question_version.question
    # Scope the asset to the attempt's own owner/project: an attachment id from
    # another project must not become readable through this path.
    asset = asset_scope(attempt.user, attempt.project, asset_id)
    provider = providers.get_provider()
    prompt = prompts.build_transcribe_prompt(
        subject_name=question.subject.name,
        question_stem=blocks_text((item.question_version.content or {}).get("blocks")),
    )
    run = _new_run(
        attempt=attempt,
        provider=provider,
        request_summary={
            "attempt_id": str(attempt.id),
            "asset_id": asset_id,
            "question_version_id": str(item.question_version_id),
            "question_type": item.question_version.question_type,
        },
        input_snapshot={
            "attempt_id": str(attempt.id),
            "asset_id": asset_id,
            "asset_content_type": asset.content_type,
            "asset_size_bytes": asset.size_bytes,
            "prompt_version": prompts.TRANSCRIBE_PROMPT_VERSION,
            # The prompt is not stored, but its digest is: an auditor can tell
            # which instruction version produced this proposal.
            "prompt_digest": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        },
    )
    if not provider.supports(TRANSCRIBE_CAPABILITY):
        reason = f"provider 不支持能力：{TRANSCRIBE_CAPABILITY}（需要视觉模型）"
        run.status = LlmRunStatus.UNAVAILABLE
        run.error_code = providers.AiUnavailable.code
        run.error_message = reason
        run.save()
        raise providers.AiUnavailable(reason)
    try:
        image_bytes = _read_asset_bytes(asset)
    except StorageError as exc:  # the row exists but its bytes do not
        run.status = LlmRunStatus.FAILED
        run.error_code = "asset_bytes_unavailable"
        run.error_message = str(exc)[:500]
        run.save()
        raise DependencyUnavailable(message="作答图片不可读，无法转写；请重新上传照片") from exc
    try:
        call = providers.call_with_deadline(
            provider,
            providers.AiRequest(
                capability=TRANSCRIBE_CAPABILITY,
                prompt_version=prompts.TRANSCRIBE_PROMPT_VERSION,
                prompt=prompt,
                images=[(asset.original_filename or "answer.png", image_bytes)],
                input_context={"attempt_id": str(attempt.id), "asset_id": asset_id},
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
        run.error_message = "模型输出不是合法 JSON，未生成任何转写"
        run.save()
        raise providers.AiInvalidOutput("模型转写输出不是合法 JSON，未生成任何转写") from exc
    clean, problems = prompts.validate_transcription(parsed)
    run.validation_result = {"problems": problems, "accepted": not problems}
    run.status = LlmRunStatus.SUCCEEDED
    run.save()
    return _store_proposal(attempt=attempt, asset_id=asset_id, clean=clean, call=call, run=run)


def _record_failure(run: LLMRun, status: str, exc: Exception) -> None:
    run.status = status
    run.error_code = getattr(exc, "code", "ai_error")
    run.error_message = str(exc)[:500]
    run.cost_known = False
    run.save()


@transaction.atomic
def _store_proposal(
    *,
    attempt: Attempt,
    asset_id: str,
    clean: dict[str, Any],
    call: providers.AiCallResult,
    run: LLMRun,
) -> AnswerTranscription:
    """Persist the proposal, re-checking under the row lock that it is not decided."""
    locked = (
        AnswerTranscription.objects.select_for_update().filter(attempt=attempt, asset_id=asset_id).first()
    )
    if locked is not None and locked.status in CONFIRMED_STATUSES:
        raise InvalidInput(
            message="该图片的转写已由学习者确认，不能重新转写",
            details={"transcription_id": str(locked.id), "status": locked.status},
        )
    fields = {
        "status": TranscriptionStatus.PROPOSED,
        "raw_text": clean["text"],
        "confirmed_text": "",
        "confidence": clean["confidence"],
        "doubts": clean["doubts"],
        "is_stub": bool(call.is_stub),
        "run": run,
        # A fresh proposal is undecided again; an earlier rejection is not carried over.
        "decided_by": None,
        "decided_at": None,
    }
    if locked is None:
        return AnswerTranscription.objects.create(attempt=attempt, asset_id=asset_id, **fields)
    for name, value in fields.items():
        setattr(locked, name, value)
    locked.save()
    return locked


@transaction.atomic
def confirm_transcription(
    *, transcription: AnswerTranscription, actor, text: str | None = None
) -> AnswerTranscription:
    """Accept the model text, or the learner's corrected text, as *the* answer."""
    locked = AnswerTranscription.objects.select_for_update().filter(id=transcription.id).first()
    if locked is None:
        raise ScopeViolation(message="转写不存在或不在当前权限范围")
    if locked.status != TranscriptionStatus.PROPOSED:
        raise InvalidInput(
            message="只有待确认的转写可以确认",
            details={"status": locked.status},
        )
    candidate = locked.raw_text if text is None else str(text)
    confirmed = candidate.strip()
    if not confirmed:
        raise InvalidInput(message="确认文本不能为空；看不清的内容请手动输入，或否决这次转写")
    # ``edited`` means the learner changed what the model read — the honest label
    # for a confirmation that is not a straight accept.
    edited = text is not None and confirmed != locked.raw_text.strip()
    locked.confirmed_text = confirmed[:8000]
    locked.status = TranscriptionStatus.EDITED if edited else TranscriptionStatus.CONFIRMED
    locked.decided_by = actor
    locked.decided_at = timezone.now()
    locked.save()
    ContentRevision.objects.create(
        actor=actor,
        entity_type="answer_transcription",
        entity_id=str(locked.id),
        action="transcription_confirmed",
        project_id=locked.attempt.project_id,
        detail={
            "status": locked.status,
            "asset_id": locked.asset_id,
            "edited": edited,
            "is_stub": locked.is_stub,
            "confirmed_length": len(locked.confirmed_text),
        },
    )
    return locked


@transaction.atomic
def reject_transcription(*, transcription: AnswerTranscription, actor, note: str = "") -> AnswerTranscription:
    """Refuse the proposal; the photo stays unconfirmed and the gate stays closed."""
    locked = AnswerTranscription.objects.select_for_update().filter(id=transcription.id).first()
    if locked is None:
        raise ScopeViolation(message="转写不存在或不在当前权限范围")
    if locked.status != TranscriptionStatus.PROPOSED:
        raise InvalidInput(message="只有待确认的转写可以否决", details={"status": locked.status})
    locked.status = TranscriptionStatus.REJECTED
    locked.confirmed_text = ""
    locked.note = str(note or "")[:500]
    locked.decided_by = actor
    locked.decided_at = timezone.now()
    locked.save()
    ContentRevision.objects.create(
        actor=actor,
        entity_type="answer_transcription",
        entity_id=str(locked.id),
        action="transcription_rejected",
        project_id=locked.attempt.project_id,
        reason=locked.note,
        detail={"asset_id": locked.asset_id, "is_stub": locked.is_stub},
    )
    return locked
