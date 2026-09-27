"""Idempotency for requests with business side effects.

Rules implemented here (docs/03-domain-and-api.md §4.3, §8):

* same key + same payload  -> replay the stored result, no second effect
* same key + other payload -> 409
* concurrent same key      -> the loser of the unique-constraint race replays

Usage::

    replay = claim(user, scope, key, payload)
    if replay is not None:
        return api.create_response(request, replay.body, status=replay.status_code)
    ...  # perform the effect exactly once
    record_result(user, scope, key, status_code=201, response_body=body,
                  resource_type="practice_session", resource_id=session.id)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from django.db import IntegrityError, transaction

from apps.audit.models import IdempotencyRecord
from apps.common.errors import IdempotencyConflict


def fingerprint(payload: Any) -> str:
    """Stable digest of a JSON-serialisable request payload."""
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Replay:
    body: Any
    status_code: int
    record: IdempotencyRecord


def claim(user, route_scope: str, key: str, payload: Any) -> Replay | None:
    """Claim an idempotency key for this request.

    Returns a :class:`Replay` when the caller must replay a stored result
    instead of executing the effect, or ``None`` when the claim was granted.

    The insert runs inside its own savepoint so that a lost race cannot poison
    the surrounding transaction; API requests are wrapped in an atomic block, and
    a failed statement would otherwise leave it unusable.
    """
    if not key:
        raise ValueError("idempotency key is required for side-effecting requests")
    digest = fingerprint(payload)
    existing = IdempotencyRecord.objects.filter(
        user=user, route_scope=route_scope, idempotency_key=key
    ).first()
    if existing is not None:
        return _replay_or_conflict(existing, digest, route_scope)
    try:
        with transaction.atomic():
            IdempotencyRecord.objects.create(
                user=user,
                route_scope=route_scope,
                idempotency_key=key,
                request_fingerprint=digest,
            )
    except IntegrityError:
        existing = IdempotencyRecord.objects.filter(
            user=user, route_scope=route_scope, idempotency_key=key
        ).first()
        if existing is None:  # pragma: no cover - extremely unlikely
            raise
        return _replay_or_conflict(existing, digest, route_scope)
    return None


def release(user, route_scope: str, key: str) -> None:
    """Drop an unfulfilled claim.

    A request that failed before recording a result must not block the caller
    from retrying with the same key, and it must not replay a non-existent
    result. Called by the request middleware on a 4xx/5xx response.
    """
    IdempotencyRecord.objects.filter(
        user=user, route_scope=route_scope, idempotency_key=key, status_code__isnull=True
    ).delete()


def _replay_or_conflict(existing: IdempotencyRecord, digest: str, route_scope: str) -> Replay:
    if existing.request_fingerprint != digest:
        raise IdempotencyConflict(details={"route_scope": route_scope, "reason": "same_key_different_payload"})
    if existing.response_body is None:
        # The first attempt is still in flight (or died before recording).
        # Reporting a conflict is safer than guessing a success response.
        raise IdempotencyConflict(
            message="相同幂等键的请求正在处理中，请稍后重试",
            details={"route_scope": route_scope, "reason": "in_flight"},
        )
    return Replay(body=existing.response_body, status_code=existing.status_code or 200, record=existing)


def json_safe(value: Any) -> Any:
    """Convert a response body into something the JSON column can store.

    A replayed response must equal the original one, so this is applied to the
    stored copy rather than to the live response: decimals become strings (the
    wire format for Decimal in this API), dates become ISO strings.
    """
    import datetime as _datetime
    from decimal import Decimal as _Decimal

    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, _Decimal):
        return str(value)
    if isinstance(value, (_datetime.datetime, _datetime.date)):
        return value.isoformat()
    if isinstance(value, uuid.UUID) if (uuid := __import__("uuid")) else False:
        return str(value)
    return value


def record_result(
    user,
    route_scope: str,
    key: str,
    *,
    status_code: int,
    response_body: Any,
    resource_type: str = "",
    resource_id: str = "",
) -> None:
    IdempotencyRecord.objects.filter(user=user, route_scope=route_scope, idempotency_key=key).update(
        status_code=status_code,
        response_body=json_safe(response_body),
        resource_type=resource_type,
        resource_id=str(resource_id or ""),
    )
