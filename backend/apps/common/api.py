"""Shared API plumbing: authentication, request ids and idempotency headers."""

from __future__ import annotations

from ninja import Router
from ninja.security import SessionAuth

from apps.common.errors import IdempotencyConflict


class LazySessionAuth(SessionAuth):
    """Session authentication that resolves Django's lazy user safely.

    ``SessionAuth.get_user`` would force-evaluate ``request.user`` during
    ``__init__``, which is not resolved yet under ASGI; resolving it here keeps
    the check honest instead of disabling it.
    """

    def get_user(self, request):
        user = getattr(request, "user", None)
        if user is None or not getattr(user, "is_authenticated", False):
            return None
        return user


auth = LazySessionAuth()


def attach_request_id(request):
    """Expose the middleware request id in the error envelope.

    The value is added to the response payload by the exception handlers, not by
    a response header, so it is only ever returned to the authenticated caller.
    """

    def _getter():
        return str(getattr(request, "request_id", "") or "") or None

    request.auth_request_id = _getter
    return request


def idempotency_key(request, *, required: bool = True) -> str:
    key = (request.headers.get("Idempotency-Key") or "").strip()
    if not key and required:
        raise IdempotencyConflict(message="缺少 Idempotency-Key 请求头")
    if len(key) > 200:
        raise IdempotencyConflict(message="Idempotency-Key 过长")
    return key


def project_scoped_router(*, tags: list[str] | None = None):
    """Router whose operations all live under ``/projects/{project_id}``.

    django-ninja builds the path-parameter set from the *operation path* when the
    operation is registered, so a parameter that arrives only through a mounted
    router prefix is classified as a query parameter and fails validation
    ("Field required"). Every operation on this router therefore writes the
    literal ``/projects/{project_id}`` prefix in its path, and the router is
    mounted at the static prefix ``/projects``. Mounting at a prefix keeps the
    generated URL name stable, so ``In``/``Res``/OpenAPI stay unchanged.

    Within a router, registration order is preserved, so a longer path must be
    registered before a shorter one that could swallow it (for example
    ``/source-documents/image`` before ``/source-documents``).
    ``tests/integration/test_api_contract.py`` asserts this contract.
    """

    return Router(tags=tags)
