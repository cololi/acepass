"""Embedding capability for the vector retrieval channel.

The chat layer (``ai.providers.base``) answers "can this deployment talk to a
model at all"; this module answers the narrower question "can it turn text into
vectors". They are separate because the two capabilities are configured
separately and because an embedding must never be fabricated: a made-up vector
would produce fake retrieval evidence, which is worse than an honestly
unavailable channel.

Honesty rules implemented here:

* ``NullEmbeddingProvider`` always reports ``is_available is False`` together
  with an explicit Chinese reason, and ``embed`` raises ``AiUnavailable``;
* ``AI_PROVIDER=stub`` deliberately provides **no** embeddings — the stub is a
  deterministic text-model stand-in for tests, not a source of vectors;
* ``OpenAICompatibleEmbeddingProvider`` performs a real HTTPS call and raises the
  same typed errors as the chat provider (timeout / rate limit / invalid output)
  instead of returning a placeholder;
* the settings are read with ``getattr(settings, ..., None)`` so this module
  works before any settings file is extended (``ACEPASS_AI_EMBEDDING_MODEL`` has
  no Django setting yet; its env name follows the ``ACEPASS_`` convention of
  ``config/settings/base.py``).
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod

from django.conf import settings

from ai.providers.base import AiError, AiInvalidOutput, AiRateLimited, AiTimeout, AiUnavailable

logger = logging.getLogger("apps.ai")

#: HTTP statuses worth retrying once, mirroring the chat provider.
_RETRYABLE_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}


class BaseEmbeddingProvider(ABC):
    """Contract every embedding provider implements.

    ``is_available``/``unavailable_reason`` are the only sanctioned way to ask
    whether the vector channel may be used; callers must not treat "no exception
    so far" as availability.
    """

    name = "base"
    is_stub = False
    capabilities: tuple[str, ...] = ("embed",)

    @property
    def is_available(self) -> bool:
        return False

    @property
    def unavailable_reason(self) -> str:
        return "未配置向量化模型（embedding provider）：向量检索不可用。"

    @property
    def model_name(self) -> str:
        return ""

    @property
    def dimension(self) -> int | None:
        """Declared vector length, or None when it is only known after a call."""
        return None

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed ``texts`` in order; raises ``AiError`` on failure."""


class NullEmbeddingProvider(BaseEmbeddingProvider):
    """Explicit "no embedding model configured" provider."""

    name = "none"
    capabilities: tuple[str, ...] = ()

    @property
    def unavailable_reason(self) -> str:
        return (
            "未配置向量化模型（embedding provider）：关键词检索可用，向量检索与混合排序不可用。"
            "设置 ACEPASS_AI_PROVIDER=openai_compatible 并配置 ACEPASS_AI_BASE_URL、"
            "ACEPASS_AI_API_KEY、ACEPASS_AI_EMBEDDING_MODEL 后启用。"
        )

    def embed(self, texts: list[str]) -> list[list[float]]:
        raise AiUnavailable(self.unavailable_reason)


class OpenAICompatibleEmbeddingProvider(BaseEmbeddingProvider):
    """Real HTTPS provider for OpenAI-compatible ``POST {base}/embeddings``."""

    name = "openai_compatible_embedding"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str | None,
        dimension: int | None = None,
        connect_timeout: int = 10,
        total_timeout: int = 30,
        max_retries: int = 1,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self._model = model or ""
        self._dimension = dimension
        #: ``urllib`` has one timeout; kept for symmetry with the chat provider
        #: and so a future client can use it without an API change here.
        self.connect_timeout = connect_timeout
        self.total_timeout = total_timeout
        #: Spec: one retry — an embedding batch is cheap to repeat, and a second
        #: failure is reported rather than hidden behind a longer backoff.
        self.max_retries = max(0, max_retries)

    @property
    def is_available(self) -> bool:
        return bool(self.base_url and self.api_key and self._model)

    @property
    def unavailable_reason(self) -> str:
        if not self.base_url:
            return "向量化模型未配置：缺少 API base URL（ACEPASS_AI_BASE_URL）"
        if not self.api_key:
            return "向量化模型未配置：缺少 API key（ACEPASS_AI_API_KEY）"
        if not self._model:
            return "向量化模型未配置：缺少 embedding 模型名（ACEPASS_AI_EMBEDDING_MODEL）"
        return ""

    @property
    def model_name(self) -> str:
        return self._model

    @property
    def dimension(self) -> int | None:
        return self._dimension

    def _endpoint(self) -> str:
        if self.base_url.endswith("/embeddings"):
            return self.base_url
        return f"{self.base_url}/embeddings"

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        reason = self.unavailable_reason
        if reason:
            raise AiUnavailable(reason)
        payload = json.dumps(
            {"model": self._model, "input": list(texts), "encoding_format": "float"},
            ensure_ascii=False,
        ).encode("utf-8")
        attempt = 0
        last_error: Exception | None = None
        while attempt <= self.max_retries:
            attempt += 1
            request = urllib.request.Request(
                self._endpoint(),
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.total_timeout) as response:
                    raw = response.read().decode("utf-8", errors="replace")
                return self._parse(raw, expected=len(texts))
            except urllib.error.HTTPError as exc:
                detail = ""
                try:
                    detail = exc.read().decode("utf-8", errors="replace")[:500]
                except Exception:  # pragma: no cover - defensive
                    detail = ""
                if exc.code in _RETRYABLE_STATUSES:
                    last_error = AiRateLimited(f"embedding provider HTTP {exc.code}: {detail}")
                    if attempt <= self.max_retries:
                        time.sleep(min(2**attempt, 8))
                        continue
                else:
                    raise AiError(f"embedding provider HTTP {exc.code}: {detail}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = AiTimeout(f"embedding provider 连接失败：{exc}")
                if attempt <= self.max_retries:
                    time.sleep(min(2**attempt, 8))
                    continue
            except json.JSONDecodeError as exc:
                raise AiInvalidOutput("embedding provider 返回的不是有效 JSON") from exc
        raise last_error or AiError("embedding provider 调用失败")

    def _parse(self, raw: str, *, expected: int) -> list[list[float]]:
        parsed = json.loads(raw)
        data = parsed.get("data") if isinstance(parsed, dict) else None
        if not isinstance(data, list) or len(data) != expected:
            raise AiInvalidOutput(f"embedding provider 返回 {len(data) if isinstance(data, list) else 0} 条向量，期望 {expected} 条")
        ordered = sorted(data, key=lambda item: item.get("index", 0) if isinstance(item, dict) else 0)
        vectors: list[list[float]] = []
        for item in ordered:
            vector = item.get("embedding") if isinstance(item, dict) else None
            if not isinstance(vector, list) or not vector:
                raise AiInvalidOutput("embedding provider 响应缺少 data[].embedding")
            try:
                values = [float(value) for value in vector]
            except (TypeError, ValueError) as exc:
                raise AiInvalidOutput("embedding 向量包含非数值元素") from exc
            if self._dimension is not None and len(values) != self._dimension:
                raise AiInvalidOutput(f"embedding 维度 {len(values)} 与声明的 {self._dimension} 不一致")
            vectors.append(values)
        if self._dimension is None and vectors:
            # Record the observed dimension so later documents can be matched
            # against the same query vector length.
            self._dimension = len(vectors[0])
        return vectors


_embedding_override: BaseEmbeddingProvider | None = None


def set_embedding_provider_override(provider: BaseEmbeddingProvider | None) -> None:
    """Test hook: inject an embedding provider without touching settings."""
    global _embedding_override
    _embedding_override = provider


def get_embedding_provider() -> BaseEmbeddingProvider:
    """The embedding provider this deployment may use, never a fabricated one."""
    if _embedding_override is not None:
        return _embedding_override
    configured = (getattr(settings, "AI_PROVIDER", "none") or "none").lower()
    if configured != "openai_compatible":
        # `none` has nothing to call; `stub` exists for deterministic chat tests
        # and must not invent vectors that a report could mistake for real ones.
        return NullEmbeddingProvider()
    return OpenAICompatibleEmbeddingProvider(
        base_url=getattr(settings, "AI_BASE_URL", None) or getattr(settings, "ACEPASS_AI_BASE_URL", "") or "",
        api_key=getattr(settings, "AI_API_KEY", None) or getattr(settings, "ACEPASS_AI_API_KEY", "") or "",
        model=getattr(settings, "ACEPASS_AI_EMBEDDING_MODEL", None)
        or getattr(settings, "AI_EMBEDDING_MODEL", None),
        dimension=getattr(settings, "ACEPASS_AI_EMBEDDING_DIM", None),
        connect_timeout=getattr(settings, "AI_CONNECT_TIMEOUT_SECONDS", 10),
        # Embedding gets its own optional budget because a query embed sits in the
        # request path; it falls back to the shared AI ceiling when unset.
        total_timeout=getattr(settings, "ACEPASS_AI_EMBEDDING_TIMEOUT_SECONDS", None)
        or getattr(settings, "AI_TOTAL_TIMEOUT_SECONDS", 30),
        max_retries=1,
    )
