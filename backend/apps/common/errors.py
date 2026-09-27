"""Typed business errors and the unified error envelope.

Wire contract (docs/03-domain-and-api.md §8):

    {"error": {"code": "...", "message": "...", "details": {}, "request_id": "..."}}

Codes map onto the documented HTTP statuses. The request id is only exposed
after authentication, matching the rule that unauthenticated responses must not
leak server-side detail.
"""

from __future__ import annotations

from typing import Any

from django.core.exceptions import ObjectDoesNotExist, PermissionDenied, ValidationError
from django.http import Http404
from ninja.errors import AuthenticationError, HttpError
from ninja.errors import ValidationError as NinjaValidationError


class AcePassError(Exception):
    """Base class for domain errors that carry a wire-stable code."""

    code = "internal_error"
    status_code = 500
    message = "服务器内部错误"

    def __init__(self, message: str | None = None, *, details: dict[str, Any] | None = None):
        self.message = message or self.message
        self.details = details or {}
        super().__init__(self.message)


class InvalidInput(AcePassError):
    code = "invalid_input"
    status_code = 400
    message = "请求参数无效"


class ScopeViolation(AcePassError):
    """Object exists but is not reachable through the requested scope.

    Deliberately mapped to 404 so an outsider cannot probe for existence.
    """

    code = "not_found"
    status_code = 404
    message = "对象不存在或不在当前权限范围"


class PurposeNotAllowed(AcePassError):
    """Known object, but the current session mode forbids this use."""

    code = "purpose_not_allowed"
    status_code = 403
    message = "当前会话用途不允许该操作"


class VersionConflict(AcePassError):
    code = "version_conflict"
    status_code = 409
    message = "版本已过期，请重新加载"


class IdempotencyConflict(AcePassError):
    code = "idempotency_conflict"
    status_code = 409
    message = "相同幂等键使用了不同请求内容"


class AlreadySubmitted(AcePassError):
    code = "already_submitted"
    status_code = 409
    message = "该题项已提交，请新建题项重做"


class StructureInvalid(AcePassError):
    code = "structure_invalid"
    status_code = 422
    message = "结构校验失败"


class RateLimited(AcePassError):
    code = "rate_limited"
    status_code = 429
    message = "请求过于频繁，请稍后再试"


class DependencyUnavailable(AcePassError):
    code = "dependency_unavailable"
    status_code = 503
    message = "依赖服务不可用"


class TranscriptionRequired(AcePassError):
    """Handwritten work must be transcribed and confirmed by the learner first.

    Raised before any AI estimation or diagnosis touches a photo answer: a model
    must never grade or diagnose text it read only approximately, and the learner
    has to confirm what the system thinks they wrote.
    """

    code = "transcription_required"
    status_code = 409
    message = "该作答含手写照片且尚未确认转写，请先确认或修改转写文本"


class AiNotConfigured(AcePassError):
    code = "ai_not_configured"
    status_code = 503
    message = "AI 能力未配置"


def request_id_of(request) -> str | None:
    if request is None:
        return None
    getter = getattr(request, "auth_request_id", None)
    if callable(getter):
        return getter()
    return None


def error_payload(code: str, message: str, details: dict[str, Any] | None, request_id: str | None) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message, "details": details or {}}
    if request_id:
        payload["request_id"] = request_id
    return {"error": payload}


def build_exception_handlers(api) -> None:
    """Attach the AcePass error contract to a NinjaAPI instance."""

    @api.exception_handler(AcePassError)
    def _handle_acepass(request, exc: AcePassError):
        return api.create_response(
            request,
            error_payload(exc.code, exc.message, exc.details, request_id_of(request)),
            status=exc.status_code,
        )

    @api.exception_handler(NinjaValidationError)
    def _handle_ninja_validation(request, exc: NinjaValidationError):
        errors = getattr(exc, "errors", None)
        details = {"errors": errors} if errors else {}
        return api.create_response(
            request,
            error_payload("invalid_input", "请求参数校验失败", details, request_id_of(request)),
            status=400,
        )

    @api.exception_handler(Http404)
    def _handle_404(request, exc: Http404):
        return api.create_response(
            request,
            error_payload("not_found", "对象不存在或不在当前权限范围", {}, request_id_of(request)),
            status=404,
        )

    @api.exception_handler(ObjectDoesNotExist)
    def _handle_missing(request, exc: ObjectDoesNotExist):
        return api.create_response(
            request,
            error_payload("not_found", "对象不存在或不在当前权限范围", {}, request_id_of(request)),
            status=404,
        )

    @api.exception_handler(PermissionDenied)
    def _handle_permission(request, exc: PermissionDenied):
        return api.create_response(
            request,
            error_payload(getattr(exc, "code", "purpose_not_allowed"), str(exc) or "不允许该操作", {}, request_id_of(request)),
            status=403,
        )

    @api.exception_handler(ValidationError)
    def _handle_django_validation(request, exc: ValidationError):
        return api.create_response(
            request,
            error_payload("structure_invalid", "结构校验失败", {"errors": exc.message_dict if hasattr(exc, "message_dict") else exc.messages}, request_id_of(request)),
            status=422,
        )

    @api.exception_handler(AuthenticationError)
    def _handle_auth(request, exc: AuthenticationError):
        return api.create_response(
            request, error_payload("unauthorized", "请先登录", {}, None), status=401
        )

    @api.exception_handler(HttpError)
    def _handle_http_error(request, exc: HttpError):
        code = "invalid_input" if exc.status_code < 500 else "internal_error"
        return api.create_response(
            request,
            error_payload(code, str(exc) or "请求无法处理", {}, request_id_of(request)),
            status=exc.status_code,
        )

    @api.exception_handler(Exception)
    def _handle_unexpected(request, exc: Exception):
        import logging

        logging.getLogger("apps.api").exception("unhandled API error")
        return api.create_response(
            request,
            error_payload("internal_error", "服务器内部错误", {}, request_id_of(request)),
            status=500,
        )
