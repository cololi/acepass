"""Request correlation and idempotency housekeeping middleware.

Every request gets a request id that is echoed in error payloads, and an
idempotency claim that did not produce a stored result is released so a failed
request can be retried with the same key instead of being answered from an empty
record.
"""

from __future__ import annotations

import logging
import time
import uuid

logger = logging.getLogger("apps.audit")

#: The request header used for idempotency, mirroring apps.common.api.
IDEMPOTENCY_HEADER = "HTTP_IDEMPOTENCY_KEY"


class RequestIdMiddleware:
    header = "HTTP_X_REQUEST_ID"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        raw = request.META.get(self.header)
        try:
            request.request_id = uuid.UUID(str(raw))
        except (TypeError, ValueError):
            request.request_id = uuid.uuid4()
        started = time.monotonic()
        response = self.get_response(request)
        response["X-Request-Id"] = str(request.request_id)
        self._release_unfulfilled_claim(request, response)
        self._record(request, response, int((time.monotonic() - started) * 1000))
        return response

    def _release_unfulfilled_claim(self, request, response) -> None:
        key = (request.META.get(IDEMPOTENCY_HEADER) or "").strip()
        if not key or response.status_code < 400:
            return
        user = getattr(request, "user", None)
        if user is None or not getattr(user, "is_authenticated", False):
            return
        try:
            from apps.audit.models import IdempotencyRecord

            # Only a claim with no stored result is released: a real conflict
            # (for example a replay with a different payload) must stay recorded.
            IdempotencyRecord.objects.filter(
                user=user, idempotency_key=key, status_code__isnull=True
            ).delete()
        except Exception:  # pragma: no cover - never break the response
            logger.warning("idempotency claim cleanup failed", exc_info=False)

    def _record(self, request, response, duration_ms: int) -> None:
        # Static file and admin asset traffic is not business behaviour.
        path = request.path
        if path.startswith("/static/") or path.startswith("/admin/jsi18n"):
            return
        try:
            from apps.audit.models import RequestLog

            user = request.user if getattr(request, "user", None) and request.user.is_authenticated else None
            RequestLog.objects.create(
                request_id=request.request_id,
                user=user,
                method=request.method or "",
                path=path[:500],
                status_code=getattr(response, "status_code", None),
                duration_ms=duration_ms,
            )
        except Exception:  # pragma: no cover - logging must never break a request
            logger.warning("request log write failed path=%s", path, exc_info=False)
