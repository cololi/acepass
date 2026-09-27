"""Vision extraction: the missing joint between the provider and a candidate.

Before this module existed the chain was declared but disconnected: the provider
declared ``extract_question``, the prompt and validator existed, and
``ingestion.extract_candidate`` was registered — but the task imported a module
that did not exist, nothing ever enqueued the topic, and ``start_image_import``
hardcoded ``input_kind="image_manual"``. So a configured vision model was never
called.

The rules here:

* the model never becomes the source of truth; its output is a *candidate*
  subject to the same publication validation as a typed one,
* a failed or unconfigured provider falls back to the manual path with an
  explicit problem on the job, never to a fabricated structure,
* every call is recorded as an ``llm_run`` with the exact prompt/input versions,
  and stub output is flagged so it can never masquerade as a real result.
"""

from __future__ import annotations

import logging

from django.db import transaction

from apps.common.enums import ImportJobStatus, LlmRunStatus, QuestionType
from apps.ingestion import storage
from apps.ingestion.models import ImportCandidate, SourceDocument
from apps.ingestion.services import core as ingestion

logger = logging.getLogger("apps.ingestion.extraction")


def vision_available() -> bool:
    """Is a provider that can actually read an image configured right now?"""
    from ai.providers import base as providers

    try:
        return bool(providers.get_provider().supports("extract_question"))
    except Exception:  # pragma: no cover - defensive
        return False


def vision_is_stub() -> bool:
    from ai.providers import base as providers

    try:
        return bool(providers.get_provider().is_stub)
    except Exception:  # pragma: no cover - defensive
        return False


def _document_bytes(document: SourceDocument) -> tuple[bytes, str]:
    asset = document.asset
    if asset is None:
        raise FileNotFoundError("来源文档没有保存原始图片")
    with storage.get_storage().open(asset.object_key) as handle:
        return handle.read(), asset.content_type or "image/png"


def _record_run(
    *,
    provider_name: str,
    model: str,
    prompt_version: str,
    status: str,
    candidate: ImportCandidate,
    request_summary: dict,
    validation: dict | None = None,
    call=None,
    error_code: str = "",
    error_message: str = "",
):
    from apps.audit.models import LLMRun

    run = LLMRun.objects.create(
        provider=provider_name,
        model_identifier=model,
        capability="extract_question",
        prompt_version=prompt_version,
        status=status,
        request_summary=request_summary,
        input_snapshot={
            "candidate_id": str(candidate.id),
            "document_id": str(candidate.job.documents.first().id) if candidate.job.documents.exists() else None,
            "extractor_version": candidate.extractor_version,
        },
        validation_result=validation or {},
        raw_response_excerpt=(call.raw_text[:4000] if call is not None else ""),
        prompt_tokens=(call.prompt_tokens if call is not None else None),
        completion_tokens=(call.completion_tokens if call is not None else None),
        cost_cents=(call.cost_cents if call is not None else None),
        cost_known=(call.cost_known if call is not None else False),
        latency_ms=(call.latency_ms if call is not None else None),
        attempts=(call.attempts if call is not None else 1),
        is_stub=(call.is_stub if call is not None else False),
        error_code=error_code,
        error_message=error_message[:500],
        user=candidate.job.created_by,
        project_id=candidate.job.project_id,
    )
    return run


def extract_image_candidate(*, import_job_id: str, document_id: str, candidate_id: str) -> str:
    """Run one vision extraction for one candidate of an image import."""
    from ai.prompts import registry as prompts
    from ai.providers import base as providers

    candidate = (
        ImportCandidate.objects.select_related("job__created_by", "job__project", "subject")
        .filter(id=candidate_id, job_id=import_job_id)
        .first()
    )
    if candidate is None:
        return "candidate_missing"
    document = (
        SourceDocument.objects.select_related("asset")
        .filter(id=document_id, project_id=candidate.job.project_id)
        .first()
    )
    if document is None:
        return "document_missing"

    provider = providers.get_provider()
    provider_name = provider.name
    model_name = ""
    try:
        image_bytes, content_type = _document_bytes(document)
    except FileNotFoundError as exc:
        _record_run(
            provider_name=provider_name,
            model="",
            prompt_version=prompts.EXTRACT_PROMPT_VERSION,
            status=LlmRunStatus.FAILED,
            candidate=candidate,
            request_summary={"reason": "missing_source_image"},
            error_code="missing_source_image",
            error_message=str(exc),
        )
        _mark_extraction_failed(candidate, "来源图片不可读取，无法识别")
        return "missing_source_image"

    prompt = prompts.build_extract_prompt(
        project_name=candidate.job.project.name,
        subject_name=candidate.subject.name if candidate.subject_id else "（未指定科目）",
        source_note=document.source_note or document.title,
    )
    request = providers.AiRequest(
        capability="extract_question",
        prompt_version=prompts.EXTRACT_PROMPT_VERSION,
        prompt=prompt,
        images=[(document.asset.original_filename or "source.png", image_bytes)],
        input_context={"document_id": str(document.id), "content_type": content_type},
    )
    try:
        call = providers.call_with_deadline(provider, request)
    except providers.AiUnavailable as exc:
        _record_run(
            provider_name=provider_name,
            model="",
            prompt_version=prompts.EXTRACT_PROMPT_VERSION,
            status=LlmRunStatus.UNAVAILABLE,
            candidate=candidate,
            request_summary={"capability": "extract_question"},
            error_code=getattr(exc, "code", "ai_not_configured"),
            error_message=str(exc),
        )
        _mark_extraction_failed(candidate, "视觉模型未配置或不可用，已保留人工录入路径")
        return "unavailable"
    except providers.AiError as exc:
        _record_run(
            provider_name=provider_name,
            model="",
            prompt_version=prompts.EXTRACT_PROMPT_VERSION,
            status=LlmRunStatus.TIMEOUT if isinstance(exc, providers.AiTimeout) else LlmRunStatus.FAILED,
            candidate=candidate,
            request_summary={"capability": "extract_question"},
            error_code=getattr(exc, "code", "ai_error"),
            error_message=str(exc),
        )
        _mark_extraction_failed(candidate, f"视觉识别失败：{exc}")
        return "failed"

    import json

    try:
        parsed = json.loads(_strip_code_fence(call.raw_text))
    except json.JSONDecodeError:
        _record_run(
            provider_name=call.provider or provider_name,
            model=call.model or model_name,
            prompt_version=prompts.EXTRACT_PROMPT_VERSION,
            status=LlmRunStatus.REJECTED,
            candidate=candidate,
            request_summary={"capability": "extract_question"},
            call=call,
            error_code="ai_invalid_output",
            error_message="模型返回的不是有效 JSON",
        )
        _mark_extraction_failed(candidate, "视觉模型输出不是有效 JSON，请人工录入")
        return "invalid_output"

    clean, problems = prompts.validate_extract_payload(
        parsed, allowed_asset_ids={str(document.asset_id)} if document.asset_id else None
    )
    _record_run(
        provider_name=call.provider or provider_name,
        model=call.model,
        prompt_version=prompts.EXTRACT_PROMPT_VERSION,
        status=LlmRunStatus.SUCCEEDED if not problems else LlmRunStatus.REJECTED,
        candidate=candidate,
        request_summary={"capability": "extract_question", "document_id": str(document.id)},
        validation={"problems": problems, "accepted": not problems},
        call=call,
        error_code="" if not problems else "ai_invalid_output",
        error_message="" if not problems else "; ".join(item["message"] for item in problems)[:500],
    )
    if problems:
        _mark_extraction_failed(
            candidate, "视觉识别结果未通过校验，已保留人工录入路径：" + "；".join(item["message"] for item in problems)
        )
        return "rejected"

    _apply_extraction(candidate=candidate, clean=clean, call=call, problems=problems)
    return "ok"


def _apply_extraction(*, candidate: ImportCandidate, clean: dict, call, problems: list[dict]) -> None:
    """Store the machine output and open the manual proofreading step."""
    with transaction.atomic():
        locked = ImportCandidate.objects.select_for_update().get(id=candidate.id)
        payload = {
            "question_type": clean.get("question_type") or QuestionType.SINGLE_CHOICE,
            "display_label": clean.get("display_label") or locked.draft_payload.get("display_label", ""),
            "content": clean.get("content") or {"blocks": [{"kind": "text", "text": ""}]},
            "answer_payload": clean.get("answer_payload") or {},
            "answer_status_known": bool(clean.get("answer_status_known")),
            # The model never asserts a structure is finished; a human confirms it.
            "needs_manual_structure": True,
            "doubts": clean.get("doubts") or [],
        }
        locked.machine_payload = {
            "extractor": "vision",
            "is_stub_output": bool(call.is_stub),
            "provider": call.provider,
            "model": call.model,
            "prompt_version": call.prompt_version,
            "raw_excerpt": call.raw_text[:4000],
        }
        locked.draft_payload = payload
        locked.is_stub_output = bool(call.is_stub)
        locked.extractor_version = "vision-v1"
        locked.revision += 1
        locked.save(
            update_fields=[
                "machine_payload",
                "draft_payload",
                "is_stub_output",
                "extractor_version",
                "revision",
                "updated_at",
            ]
        )
        ingestion.refresh_candidate_issues(locked)
        job = locked.job
        ingestion.add_job_problem(
            job,
            "vision_extracted" if not call.is_stub else "vision_extracted_stub",
            (
                "已用视觉模型生成候选结构；仍需人工对照原图核对题干、选项与答案后才能发布。"
                if not call.is_stub
                else "当前为测试/演示 stub 输出，不代表真实模型识别，必须完整人工核对。"
            ),
            severity="warning",
        )
        if job.status == ImportJobStatus.PROCESSING:
            ingestion.maybe_complete_job(job)


def _mark_extraction_failed(candidate: ImportCandidate, message: str) -> None:
    ingestion.add_job_problem(candidate.job, "vision_extraction_failed", message, severity="warning")
    if not candidate.draft_payload.get("needs_manual_structure"):
        candidate.draft_payload = {**candidate.draft_payload, "needs_manual_structure": True}
        candidate.save(update_fields=["draft_payload", "updated_at"])
    if candidate.job.status == ImportJobStatus.PROCESSING:
        ingestion.maybe_complete_job(candidate.job)


def _strip_code_fence(text: str) -> str:
    value = (text or "").strip()
    if value.startswith("```"):
        value = value.split("\n", 1)[-1]
        if value.rstrip().endswith("```"):
            value = value.rstrip()[:-3]
    return value.strip()


__all__ = [
    "extract_image_candidate",
    "vision_available",
    "vision_is_stub",
]
