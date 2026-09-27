"""Shared fixtures: real PostgreSQL, real HTTP client, demo fixtures per test."""

from __future__ import annotations

import pytest
from django.test import Client

from apps.accounts.models import User
from apps.accounts.services.demo_fixture import load_demo_fixture
from apps.exams.models import ExamProject, Subject
from apps.ingestion.storage import reset_storage_cache

OWNER_EMAIL = "owner@test.local"
OWNER_PASSWORD = "OwnerTest!2026"
OTHER_EMAIL = "other@test.local"
OTHER_PASSWORD = "OtherTest!2026"


@pytest.fixture(autouse=True)
def _isolated_media(tmp_path, settings):
    settings.PRIVATE_MEDIA_ROOT = tmp_path / "private-media"
    settings.PRIVATE_MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    settings.MEDIA_ROOT = settings.PRIVATE_MEDIA_ROOT
    reset_storage_cache()
    yield
    reset_storage_cache()


@pytest.fixture(autouse=True)
def _reset_provider():
    from ai.providers import base as providers

    yield
    providers.set_provider_override(None)


@pytest.fixture
def owner(db) -> User:
    return User.objects.create_user(email=OWNER_EMAIL, password=OWNER_PASSWORD, display_name="演示用户")


@pytest.fixture
def other_user(db) -> User:
    return User.objects.create_user(email=OTHER_EMAIL, password=OTHER_PASSWORD, display_name="另一位用户")


@pytest.fixture
def staff_reviewer(db) -> User:
    """A different internal reviewer: staff, but never the answerer."""
    return User.objects.create_user(
        email="reviewer@test.local", password="ReviewerTest!2026", is_staff=True, display_name="复核员"
    )


@pytest.fixture
def demo(owner) -> dict:
    """Two projects, three subjects and all five question types, clearly marked demo."""
    return load_demo_fixture(OWNER_EMAIL)


def login(client: Client, email: str, password: str) -> Client:
    client.get("/api/v1/auth/csrf")
    token = client.cookies["csrftoken"].value
    response = client.post(
        "/api/v1/auth/login",
        data={"email": email, "password": password},
        content_type="application/json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert response.status_code == 200, response.content
    return client


@pytest.fixture
def api(owner) -> Client:
    return login(Client(), OWNER_EMAIL, OWNER_PASSWORD)


@pytest.fixture
def other_api(other_user) -> Client:
    return login(Client(), OTHER_EMAIL, OTHER_PASSWORD)


class ApiCaller:
    """Small helper around Django's test client with CSRF + idempotency headers."""

    def __init__(self, client: Client):
        self.client = client
        self.counter = 0

    def _headers(self, key: str | None) -> dict:
        headers = {"HTTP_X_CSRFTOKEN": self.client.cookies["csrftoken"].value}
        if key:
            headers["HTTP_IDEMPOTENCY_KEY"] = key
        return headers

    def get(self, path: str, **params):
        query = "&".join(f"{key}={value}" for key, value in params.items() if value is not None)
        url = f"{path}?{query}" if query else path
        return self.client.get(url)

    def post(self, path: str, body=None, *, key: str | None = None):
        if key is None:
            self.counter += 1
            key = f"test-{path}-{self.counter}"
        return self.client.post(
            path,
            data=body,
            content_type="application/json",
            **self._headers(key),
        )

    def patch(self, path: str, body=None):
        return self.client.patch(path, data=body, content_type="application/json", **self._headers(None))

    def put(self, path: str, body=None):
        return self.client.put(path, data=body, content_type="application/json", **self._headers(None))


@pytest.fixture
def caller(api) -> ApiCaller:
    return ApiCaller(api)


@pytest.fixture
def other_caller(other_api) -> ApiCaller:
    """An authenticated caller for the second user (for cross-user checks)."""
    return ApiCaller(other_api)


@pytest.fixture
def project_a(demo) -> ExamProject:
    return demo["project_a"]


@pytest.fixture
def project_b(demo) -> ExamProject:
    return demo["project_b"]


@pytest.fixture
def subject_a1(project_a) -> Subject:
    return Subject.objects.filter(project=project_a).order_by("display_order").first()


@pytest.fixture
def subject_a2(project_a) -> Subject:
    return Subject.objects.filter(project=project_a).order_by("display_order")[1]


@pytest.fixture
def subject_b1(project_b) -> Subject:
    return Subject.objects.filter(project=project_b).order_by("display_order").first()


@pytest.fixture
def practice_item(caller, project_a, subject_a1):
    """One presented single-choice item in the owner's practice session."""
    from apps.practice.models import SessionItem
    from apps.question_bank.models import QuestionVersion

    version = (
        QuestionVersion.objects.filter(
            question__subject=subject_a1, question_type="single_choice", status="published"
        )
        .select_related("question")
        .order_by("question__display_label")
        .first()
    )
    response = caller.post(
        f"/api/v1/projects/{project_a.id}/practice-sessions",
        {"mode": "practice", "subject_id": str(subject_a1.id), "question_ids": [str(version.question_id)]},
        key="shared-practice-session",
    )
    assert response.status_code == 201, response.content
    item_id = response.json()["items"][0]["session_item_id"]
    caller.get(f"/api/v1/projects/{project_a.id}/session-items/{item_id}/presentation")
    return SessionItem.objects.get(id=item_id)
