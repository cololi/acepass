"""Health endpoints, CSRF failure response, and session entry points."""

from __future__ import annotations

import uuid

from django.db import connection
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt


def csrf_failure(request, reason: str = ""):
    """CSRF rejection in the same error envelope as the rest of the API."""
    request_id = getattr(request, "request_id", None) or uuid.uuid4()
    return JsonResponse(
        {
            "error": {
                "code": "csrf_failed",
                "message": "CSRF 校验未通过，请刷新页面后重试",
                "details": {"reason": reason},
                "request_id": str(request_id),
            }
        },
        status=403,
    )


@csrf_exempt
def health_live(request):
    return JsonResponse({"status": "ok", "service": "acepass-api"})


@csrf_exempt
def health_ready(request):
    checks: dict[str, str] = {}
    ready = True

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        checks["database"] = "ok"
    except Exception as exc:  # pragma: no cover - only when the DB is down
        checks["database"] = f"error: {type(exc).__name__}"
        ready = False

    try:
        from django.core.cache import cache

        cache.set("health:ready", "1", 5)
        checks["cache"] = "ok" if cache.get("health:ready") == "1" else "degraded"
    except Exception as exc:  # pragma: no cover - only when Redis is down
        # A missing cache degrades async features but must not lose data.
        checks["cache"] = f"degraded: {type(exc).__name__}"

    from django.conf import settings

    checks["ai_provider"] = settings.AI_PROVIDER
    return JsonResponse({"status": "ready" if ready else "not_ready", "checks": checks}, status=200 if ready else 503)
