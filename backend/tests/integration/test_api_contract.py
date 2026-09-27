"""API surface contract: route ordering, error envelope and OpenAPI stability."""

from __future__ import annotations

import pytest
from django.urls import resolve

from config.api import api

pytestmark = pytest.mark.django_db


def all_route_patterns() -> list[str]:
    """Registered routes in match order, exactly as django-ninja will try them.

    ``_get_urls()`` yields the flattened pattern list in registration order; the
    public ``api.urls`` property re-runs django-ninja's global registry check and
    would fail once the Django test client has registered its own API instance.
    """
    return [str(pattern.pattern) for pattern in api._get_urls()]


def test_openapi_document_is_generated_and_has_no_duplicated_prefix():
    schema = api.get_openapi_schema()
    paths = list(schema["paths"])
    assert len(paths) >= 80
    assert not [path for path in paths if "projects/projects" in path]
    assert not [path for path in paths if "//" in path]


def test_openapi_marks_authentication_on_business_routes():
    schema = api.get_openapi_schema()
    anonymous = []
    for path, methods in schema["paths"].items():
        for method, operation in methods.items():
            if not operation.get("security"):
                anonymous.append(f"{method.upper()} {path}")
    # The anonymous entry points are exactly: issue a CSRF token, log in, log out.
    assert sorted(anonymous) == [
        "GET /api/v1/auth/csrf",
        "POST /api/v1/auth/login",
        "POST /api/v1/auth/logout",
    ]


def test_path_parameter_operations_are_registered_before_shorter_siblings():
    """django-ninja matches in registration order.

    A literal path such as ``/imports/images`` must be registered before
    ``/imports/{job_id}``, otherwise the parameterised route would swallow it and
    the request would fail on validation instead of reaching the handler.
    """
    patterns = all_route_patterns()
    assert patterns
    checks = [
        # A literal segment must win over a parameter that would otherwise match it.
        ("projects/<project_id>/imports/<job_id>", "projects/<project_id>/imports/images"),
    ]
    for short, long in checks:
        assert short in patterns, f"{short} is not registered"
        assert long in patterns, f"{long} is not registered"
        assert patterns.index(long) < patterns.index(short), f"{long} must precede {short}"


def test_unknown_objects_are_not_reachable_through_another_scope(other_caller, project_a):
    response = other_caller.get(f"/api/v1/projects/{project_a.id}/questions")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_error_envelope_shape(client):
    response = client.get("/api/v1/projects")
    assert response.status_code == 401
    body = response.json()
    assert set(body) == {"error"}
    assert {"code", "message", "details"} <= set(body["error"])


def test_request_id_header_is_returned(api):
    response = api.get("/api/v1/auth/me")
    assert response.status_code == 200
    assert response["X-Request-Id"]


def test_health_endpoints(api):
    live = api.get("/health/live")
    ready = api.get("/health/ready")
    assert live.status_code == 200
    assert ready.status_code == 200
    assert ready.json()["checks"]["database"] == "ok"
    assert ready.json()["checks"]["ai_provider"] in {"none", "stub", "openai_compatible"}


def test_project_scoped_route_rejects_a_foreign_project_id(caller, project_a, project_b):
    questions_b = caller.get(f"/api/v1/projects/{project_b.id}/questions?limit=5").json()
    assert questions_b
    response = caller.get(f"/api/v1/projects/{project_a.id}/questions/{questions_b[0]['id']}")
    assert response.status_code == 404


def test_url_resolution_keeps_the_project_prefix(api):
    match = resolve("/api/v1/projects/00000000-0000-0000-0000-000000000000/questions")
    assert match.kwargs.get("project_id") == "00000000-0000-0000-0000-000000000000"


def test_unknown_question_id_is_a_clean_404(caller, project_a):
    response = caller.get(f"/api/v1/projects/{project_a.id}/questions/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
