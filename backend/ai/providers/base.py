"""AI capability layer.

Contract (docs/02 §6):

* a provider declares which capabilities it supports; a text model is never
  used as a vision model
* every call goes through capability -> prompt version -> JSON validation
* a stub provider exists for tests/demos only and is always reported as a stub
* without credentials the product keeps working and says "AI not configured"
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from django.conf import settings

logger = logging.getLogger("apps.ai")

CAPABILITIES = (
    "extract_question",
    "transcribe_handwriting",
    "suggest_tags",
    "explain",
    "diagnose",
    "estimate_grade",
    "propose_variant",
    "embed",
)

#: P0 only implements these two; the rest stay registered but disabled.
P0_CAPABILITIES = ("extract_question", "explain")

#: Capabilities the offline stub can answer. Every stub result carries
#: ``is_stub=True`` and the UI labels it, so a demo can never pass for a real
#: model result.
#:
#: ``suggest_tags`` is deliberately absent: the knowledge tag queue is only ever
#: filled by a real text model, so "no provider" stays an explicit
#: ``ai_not_configured`` instead of an empty stub proposal.
STUB_CAPABILITIES = (
    "extract_question",
    "transcribe_handwriting",
    "explain",
    "diagnose",
    "estimate_grade",
)


class AiError(RuntimeError):
    code = "ai_error"
    retryable = False


class AiUnavailable(AiError):
    code = "ai_not_configured"
    retryable = False


class AiTimeout(AiError):
    code = "ai_timeout"
    retryable = True


class AiRateLimited(AiError):
    code = "ai_rate_limited"
    retryable = True


class AiInvalidOutput(AiError):
    code = "ai_invalid_output"
    retryable = False


@dataclass
class AiCallResult:
    payload: dict[str, Any]
    raw_text: str = ""
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cost_cents: Any = None
    cost_known: bool = False
    attempts: int = 1
    latency_ms: int = 0
    is_stub: bool = False
    provider: str = ""
    model: str = ""
    prompt_version: str = ""
    validation: dict[str, Any] = field(default_factory=dict)


@dataclass
class AiRequest:
    capability: str
    prompt_version: str
    prompt: str
    images: list[tuple[str, bytes]] = field(default_factory=list)
    input_context: dict[str, Any] = field(default_factory=dict)
    max_output_tokens: int = 1500


class BaseProvider(ABC):
    name = "base"
    capabilities: tuple[str, ...] = ()
    is_stub = False

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities

    @abstractmethod
    def call(self, request: AiRequest) -> AiCallResult: ...


class NullProvider(BaseProvider):
    """Explicit "no AI configured" provider.

    It never fabricates a result: callers receive `AiUnavailable` and the UI
    shows "AI 未配置".
    """

    name = "none"
    capabilities: tuple[str, ...] = ()

    def call(self, request: AiRequest) -> AiCallResult:
        raise AiUnavailable("未配置 AI 能力（ACEPASS_AI_PROVIDER=none）")


class OpenAICompatibleProvider(BaseProvider):
    """Real HTTPS provider for OpenAI-compatible chat-completions APIs."""

    name = "openai_compatible"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        text_model: str | None,
        vision_model: str | None,
        connect_timeout: int,
        total_timeout: int,
        max_retries: int,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.text_model = text_model
        self.vision_model = vision_model
        self.connect_timeout = connect_timeout
        self.total_timeout = total_timeout
        self.max_retries = max(0, max_retries)
        capabilities = []
        if text_model:
            capabilities.extend(["explain", "diagnose", "suggest_tags", "estimate_grade"])
        if vision_model:
            # Handwriting transcription is a vision job: a text-only provider must
            # never be asked to read a photo.
            capabilities.extend(["extract_question", "transcribe_handwriting"])
        self.capabilities = tuple(capabilities)

    def _endpoint(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        return f"{self.base_url}/chat/completions"

    def _model_for(self, capability: str) -> str:
        if capability in {"extract_question", "transcribe_handwriting"}:
            if not self.vision_model:
                raise AiUnavailable("该 provider 未配置视觉模型，不能执行图片识别或手写转写")
            return self.vision_model
        if not self.text_model:
            raise AiUnavailable("该 provider 未配置文本模型")
        return self.text_model

    def call(self, request: AiRequest) -> AiCallResult:
        if not self.supports(request.capability):
            raise AiUnavailable(f"provider 不支持能力：{request.capability}")
        model = self._model_for(request.capability)
        content: list[dict[str, Any]] = [{"type": "text", "text": request.prompt}]
        for _name, data in request.images:
            import base64

            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{base64.b64encode(data).decode('ascii')}"},
                }
            )
        body = {
            "model": model,
            "messages": [{"role": "user", "content": content if request.images else request.prompt}],
            "max_tokens": request.max_output_tokens,
            "temperature": 0,
        }
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")

        attempt = 0
        started = time.monotonic()
        last_error: Exception | None = None
        while attempt <= self.max_retries:
            attempt += 1
            http_request = urllib.request.Request(
                self._endpoint(),
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(http_request, timeout=self.total_timeout) as response:
                    raw = response.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw)
                text = _extract_message_text(parsed)
                usage = parsed.get("usage") or {}
                return AiCallResult(
                    payload={"text": text},
                    raw_text=text,
                    prompt_tokens=usage.get("prompt_tokens"),
                    completion_tokens=usage.get("completion_tokens"),
                    cost_known=False,
                    attempts=attempt,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    provider=self.name,
                    model=model,
                    prompt_version=request.prompt_version,
                )
            except urllib.error.HTTPError as exc:
                status = exc.code
                detail = ""
                try:
                    detail = exc.read().decode("utf-8", errors="replace")[:500]
                except Exception:  # pragma: no cover
                    detail = ""
                if status in {408, 409, 425, 429, 500, 502, 503, 504}:
                    last_error = AiRateLimited(f"provider HTTP {status}: {detail}")
                    if attempt <= self.max_retries:
                        time.sleep(min(2 ** attempt, 8))
                        continue
                else:
                    raise AiError(f"provider HTTP {status}: {detail}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = AiTimeout(f"provider 连接失败：{exc}")
                if attempt <= self.max_retries:
                    time.sleep(min(2 ** attempt, 8))
                    continue
            except json.JSONDecodeError as exc:
                raise AiInvalidOutput("provider 返回的不是有效 JSON") from exc
        raise last_error or AiError("provider 调用失败")


def _extract_message_text(parsed: dict[str, Any]) -> str:
    try:
        choices = parsed["choices"]
        message = choices[0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise AiInvalidOutput("provider 响应缺少 choices[0].message.content") from exc
    if isinstance(message, list):
        parts = [part.get("text", "") for part in message if isinstance(part, dict)]
        return "".join(parts)
    return str(message)


class StubProvider(BaseProvider):
    """Deterministic offline provider for tests and the demo mode only.

    Results are always flagged `is_stub=True` and the UI labels them as such, so
    a stub can never masquerade as a real model result.
    """

    name = "stub"
    is_stub = True
    capabilities = STUB_CAPABILITIES

    def __init__(self, *, behaviour: str = "ok"):
        self.behaviour = behaviour

    def call(self, request: AiRequest) -> AiCallResult:
        if self.behaviour == "timeout":
            raise AiTimeout("stub: simulated timeout")
        if self.behaviour == "unavailable":
            raise AiUnavailable("stub: simulated missing provider")
        if self.behaviour == "invalid_json":
            raise AiInvalidOutput("stub: simulated invalid structured output")
        if self.behaviour == "fabricated_reference":
            payload = {"explanation_blocks": [{"kind": "text", "text": "stub 引用不存在的来源"}], "citations": ["source:does-not-exist"]}
            return self._result(request, payload)
        if request.capability == "explain":
            return self._result(
                request,
                {
                    "explanation_blocks": [
                        {"kind": "text", "text": "【stub 讲解】这是测试/演示模式的占位讲解，不是真实模型输出。"},
                        {"kind": "text", "text": "请以已审核的人工解析为准；系统不会把 stub 内容当作真实结果。"},
                    ],
                    "missing_information": [],
                    "suggested_next": ["重新独立作答同一考点题目"],
                    "citations": [],
                    "key_conditions": [],
                    "stuck_points": [],
                },
            )
        if request.capability == "extract_question":
            return self._result(
                request,
                {
                    "question_type": "single_choice",
                    "display_label": "stub-1",
                    "content": {
                        "blocks": [{"kind": "text", "text": "【stub 识别】此处应由真实视觉模型输出题干结构。"}],
                        "options": [
                            {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "选项A"}]},
                            {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "选项B"}]},
                        ],
                    },
                    "answer_payload": {},
                    "answer_status_known": False,
                    "source_hint": {},
                    "doubts": ["stub 输出仅供联调，不能作为正式内容"],
                },
            )
        if request.capability == "transcribe_handwriting":
            return self._result(
                request,
                {
                    "text": "【stub 转写】这是测试/演示模式的占位转写，不是真实识别结果。",
                    "confidence": 0.0,
                    "doubts": ["stub 输出：请人工核对原图并修改后再确认"],
                    "illegible": False,
                },
            )
        if request.capability == "estimate_grade":
            return self._result(
                request,
                {
                    "criteria": [],
                    "overall_note": "【stub 估分】stub 不产生任何评分点分数：请人工逐点确认。",
                    "confidence": 0.0,
                },
            )
        if request.capability == "diagnose":
            return self._result(
                request,
                {
                    "causes": [{"error_type": "unknown", "confidence": 0.0, "evidence": []}],
                    "follow_up_questions": [
                        {
                            "question": "【stub 追问】请写下你当时的完整推导步骤。",
                            "why": "stub 没有过程证据，只能请你补充",
                            "evidence_kind": "过程步骤",
                        }
                    ],
                    "missing_information": ["stub 输出没有诊断依据"],
                },
            )
        if request.capability == "suggest_tags":
            return self._result(request, {"tags": []})
        raise AiUnavailable(f"stub 未实现能力：{request.capability}")

    def _result(self, request: AiRequest, payload: dict[str, Any]) -> AiCallResult:
        return AiCallResult(
            payload=payload,
            raw_text=json.dumps(payload, ensure_ascii=False),
            prompt_tokens=0,
            completion_tokens=0,
            cost_cents=0,
            cost_known=True,
            attempts=1,
            latency_ms=1,
            is_stub=True,
            provider=self.name,
            model="stub-model",
            prompt_version=request.prompt_version,
        )


_provider_override: BaseProvider | None = None


def call_with_deadline(provider: BaseProvider, request: AiRequest, *, deadline_seconds: int | None = None) -> AiCallResult:
    """Run one provider call under a wall-clock deadline.

    A hung socket must not hold a worker forever, so the call runs in a helper
    thread that is abandoned (not killed) when the deadline passes; the caller
    gets `AiTimeout` and the cost may still have been incurred, which the
    `llm_run` row records honestly.
    """
    import concurrent.futures

    limit = deadline_seconds or getattr(settings, "AI_TOTAL_TIMEOUT_SECONDS", 90)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(provider.call, request)
        try:
            return future.result(timeout=limit)
        except concurrent.futures.TimeoutError as exc:
            raise AiTimeout(f"provider 调用超过 {limit} 秒未返回；费用可能已发生") from exc


def set_provider_override(provider: BaseProvider | None) -> None:
    """Test hook: inject a provider without touching settings."""
    global _provider_override
    _provider_override = provider


def get_provider() -> BaseProvider:
    if _provider_override is not None:
        return _provider_override
    configured = (getattr(settings, "AI_PROVIDER", "none") or "none").lower()
    if configured == "none":
        return NullProvider()
    if configured == "stub":
        if not getattr(settings, "AI_ALLOW_STUB", False):
            logger.warning("stub provider requested outside test/demo mode; refusing")
            return NullProvider()
        return StubProvider()
    if configured == "openai_compatible":
        api_key = getattr(settings, "AI_API_KEY", None)
        base_url = getattr(settings, "AI_BASE_URL", None)
        if not api_key or not base_url:
            return NullProvider()
        return OpenAICompatibleProvider(
            base_url=base_url,
            api_key=api_key,
            text_model=getattr(settings, "AI_TEXT_MODEL", None),
            vision_model=getattr(settings, "AI_VISION_MODEL", None),
            connect_timeout=getattr(settings, "AI_CONNECT_TIMEOUT_SECONDS", 10),
            total_timeout=getattr(settings, "AI_TOTAL_TIMEOUT_SECONDS", 90),
            max_retries=getattr(settings, "AI_MAX_RETRIES", 2),
        )
    logger.warning("unknown ACEPASS_AI_PROVIDER=%s; treating as unconfigured", configured)
    return NullProvider()


def provider_status() -> dict[str, Any]:
    """What the UI shows about AI availability. Never claims success."""
    provider = get_provider()
    capabilities = {capability: provider.supports(capability) for capability in CAPABILITIES}
    configured = not isinstance(provider, NullProvider)
    return {
        "provider": provider.name,
        "configured": configured,
        "is_stub": provider.is_stub,
        "capabilities": capabilities,
        "p0_capabilities": list(P0_CAPABILITIES),
        "message": (
            "AI 未配置：可正常使用手动录题、作答、判分与复习；图片识别和按需讲解需配置 provider。"
            if not configured
            else (
                "当前为测试/演示 stub：输出不代表真实模型结果。"
                if provider.is_stub
                else "已配置真实 provider；模型输出仍需人工核对后才能进入正式内容。"
            )
        ),
    }
