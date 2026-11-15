"""Golden vectors for the AI runtime contract: `llm_run` shape, provider degradation, call defaults.

Everything here is introspected or executed from the real Django code:

* `LLMRun` columns come from `LLMRun._meta` (name/type/null/max_length/default/choices, table name,
  indexes), so the Postgres schema in Phase 2 can be checked against the model, not against docs.
* `AiCallResult` / `AiRequest` defaults come from `dataclasses.fields`.
* Provider tables and `provider_status()` come from instantiating the real providers and calling the
  real function under `override_settings` — no network and no DB.
* `AiUnavailable` codes come from actually calling `NullProvider.call` and from the real
  "capability not declared" guard in `OpenAICompatibleProvider.call`.

The Node side re-declares the same shape; mismatches are test failures.

Usage (from dsh-plugin/):
    ../backend/.venv/bin/python scripts/gen_ai_runtime_golden.py > tests/golden/ai_runtime.json
"""
from __future__ import annotations

import datetime as dt
import dataclasses
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
import django  # noqa: E402

django.setup()

from django.db import models as django_models  # noqa: E402
from django.test import override_settings  # noqa: E402

from ai.providers import base as providers  # noqa: E402
from apps.audit.models import LLMRun  # noqa: E402
from apps.common.enums import LlmRunStatus  # noqa: E402


def field_kind(field: django_models.Field) -> str:
    if isinstance(field, django_models.UUIDField):
        return "uuid"
    if isinstance(field, django_models.DateTimeField):
        return "datetime"
    if isinstance(field, django_models.JSONField):
        return "json"
    if isinstance(field, django_models.TextField):
        return "text"
    if isinstance(field, django_models.DecimalField):
        return "decimal"
    if isinstance(field, django_models.BooleanField):
        return "bool"
    if isinstance(field, django_models.PositiveSmallIntegerField):
        return "positive_small_int"
    if isinstance(field, django_models.PositiveIntegerField):
        return "positive_int"
    if isinstance(field, django_models.CharField):
        return "char"
    if isinstance(field, django_models.ForeignKey):
        return "fk"
    return type(field).__name__


def field_default(field: django_models.Field) -> object:
    if isinstance(field, django_models.DateTimeField) and field.auto_now:
        return "auto_now"
    if isinstance(field, django_models.DateTimeField) and field.auto_now_add:
        return "auto_now_add"
    if not field.has_default():
        return None
    default = field.get_default()
    if callable(default) or getattr(field.default, "__name__", "") == "uuid4":
        name = getattr(field.default, "__name__", "callable")
        return name if name in {"uuid4"} else "callable"
    return default


LLM_RUN_FIELDS = []
for field in LLMRun._meta.concrete_fields:
    LLM_RUN_FIELDS.append(
        {
            "name": field.name,
            "kind": field_kind(field),
            "nullable": bool(field.null),
            "blank": bool(field.blank),
            "maxLength": field.max_length,
            "default": field_default(field),
            "generated": bool(field.auto_created or field.name in {"id", "created_at", "updated_at"}),
            "choices": [list(choice) for choice in field.choices] if field.choices else None,
        }
    )


def dataclass_shape(cls) -> dict:
    fields = []
    for field in dataclasses.fields(cls):
        if field.default is not dataclasses.MISSING:
            value = field.default
        elif field.default_factory is not dataclasses.MISSING:
            value = field.default_factory()
        else:
            value = "<required>"
        fields.append({"name": field.name, "default": value})
    return {"name": cls.__name__, "fields": fields}


def provider_tables() -> dict:
    text_only = providers.OpenAICompatibleProvider(
        base_url="https://example.test/v1",
        api_key="test-key",
        text_model="text-model",
        vision_model=None,
        connect_timeout=10,
        total_timeout=90,
        max_retries=2,
    )
    text_vision = providers.OpenAICompatibleProvider(
        base_url="https://example.test/v1",
        api_key="test-key",
        text_model="text-model",
        vision_model="vision-model",
        connect_timeout=10,
        total_timeout=90,
        max_retries=2,
    )
    return {
        "capabilities": list(providers.CAPABILITIES),
        "p0_capabilities": list(providers.P0_CAPABILITIES),
        "stub_capabilities": list(providers.STUB_CAPABILITIES),
        "providers": {
            "null": {
                "name": providers.NullProvider.name,
                "is_stub": providers.NullProvider.is_stub,
                "capabilities": list(providers.NullProvider.capabilities),
                "supports": {capability: providers.NullProvider().supports(capability) for capability in providers.CAPABILITIES},
            },
            "openai_text_only": {
                "name": text_only.name,
                "is_stub": text_only.is_stub,
                "capabilities": list(text_only.capabilities),
                "supports": {capability: text_only.supports(capability) for capability in providers.CAPABILITIES},
            },
            "openai_text_vision": {
                "name": text_vision.name,
                "is_stub": text_vision.is_stub,
                "capabilities": list(text_vision.capabilities),
                "supports": {capability: text_vision.supports(capability) for capability in providers.CAPABILITIES},
            },
        },
    }


def status_for(config: dict) -> dict:
    with override_settings(**config):
        return providers.provider_status()


BASE_CONFIG = {
    "AI_API_KEY": "test-key",
    "AI_BASE_URL": "https://example.test/v1",
    "AI_TEXT_MODEL": "text-model",
    "AI_VISION_MODEL": None,
    "AI_MAX_RETRIES": 2,
}

STATUS_CASES = {
    "none": {"AI_PROVIDER": "none"},
    "openai_text_only": {"AI_PROVIDER": "openai_compatible", **BASE_CONFIG},
    "openai_text_vision": {"AI_PROVIDER": "openai_compatible", **BASE_CONFIG, "AI_VISION_MODEL": "vision-model"},
    "openai_missing_key": {"AI_PROVIDER": "openai_compatible", **BASE_CONFIG, "AI_API_KEY": None},
    "openai_missing_base_url": {"AI_PROVIDER": "openai_compatible", **BASE_CONFIG, "AI_BASE_URL": None},
    "unknown_provider": {"AI_PROVIDER": "something_else"},
    "stub_refused": {"AI_PROVIDER": "stub", "AI_ALLOW_STUB": False},
}

PROVIDER_STATUS = {name: status_for(config) for name, config in STATUS_CASES.items()}


def error_shapes() -> list[dict]:
    errors = [providers.AiError, providers.AiUnavailable, providers.AiTimeout, providers.AiRateLimited, providers.AiInvalidOutput]
    return [
        {
            "class": cls.__name__,
            "code": cls.code,
            "retryable": cls.retryable,
            "sample": str(cls("样例错误")),
        }
        for cls in errors
    ]


def caught(fn) -> dict:
    try:
        fn()
    except providers.AiError as exc:
        return {"raised": type(exc).__name__, "code": exc.code, "retryable": exc.retryable, "message": str(exc)}
    raise AssertionError("expected an AiError")


REQUEST = providers.AiRequest(capability="explain", prompt_version="p0-explain-v1", prompt="prompt")

FAILURE_PATHS = {
    "null_provider": caught(lambda: providers.NullProvider().call(REQUEST)),
    "capability_not_declared": caught(
        lambda: providers.OpenAICompatibleProvider(
            base_url="https://example.test/v1",
            api_key="test-key",
            text_model="text-model",
            vision_model=None,
            connect_timeout=10,
            total_timeout=90,
            max_retries=2,
        ).call(providers.AiRequest(capability="extract_question", prompt_version="p0-extract-v1", prompt="prompt"))
    ),
    "vision_model_missing": caught(
        lambda: providers.OpenAICompatibleProvider(
            base_url="https://example.test/v1",
            api_key="test-key",
            text_model="text-model",
            vision_model=None,
            connect_timeout=10,
            total_timeout=90,
            max_retries=2,
        )._model_for("transcribe_handwriting")
    ),
}

payload = {
    "source": {
        "models": "backend/apps/audit/models.py::LLMRun",
        "providers": "backend/ai/providers/base.py",
        "enums": "backend/apps/common/enums.py::LlmRunStatus",
        "harness": "django.setup() + model/dataclass introspection + override_settings; no network, no DB",
    },
    "llm_run": {
        "table": LLMRun._meta.db_table,
        "fields": LLM_RUN_FIELDS,
        "statuses": [list(choice) for choice in LlmRunStatus.choices],
        "indexes": [
            {"fields": list(index.fields), "name": index.name}
            for index in LLMRun._meta.indexes
        ],
    },
    "ai_call_result": dataclass_shape(providers.AiCallResult),
    "ai_request": dataclass_shape(providers.AiRequest),
    "providers": provider_tables(),
    "provider_status": PROVIDER_STATUS,
    "errors": error_shapes(),
    "failure_paths": FAILURE_PATHS,
}

json.dump(payload, sys.stdout, ensure_ascii=False, sort_keys=False, separators=(",", ":"))
sys.stdout.write("\n")
