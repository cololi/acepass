"""Accounts API: session, CSRF and the global study budget."""

from __future__ import annotations

from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.core.cache import cache
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import ensure_csrf_cookie
from ninja import Router, Schema

from apps.accounts.models import MAX_DAILY_BUDGET_MINUTES, UserSettings
from apps.accounts.services.settings import update_study_settings
from apps.common.api import auth
from apps.common.errors import InvalidInput, RateLimited

User = get_user_model()


class LoginIn(Schema):
    email: str
    password: str


class UserOut(Schema):
    id: str
    email: str
    display_name: str
    is_staff: bool
    timezone: str
    daily_budget_minutes: int
    undiagnosed_time_share_percent: int
    #: True when the account exists but no exam project has been created yet.
    needs_project_setup: bool
    is_reviewer: bool


class StudySettingsOut(Schema):
    timezone: str
    daily_budget_minutes: int
    project_budget_percent: dict[str, float]
    undiagnosed_time_share_percent: int
    default_practice_tutoring: str


class StudySettingsPatch(Schema):
    timezone: str | None = None
    daily_budget_minutes: int | None = None
    project_budget_percent: dict[str, float] | None = None
    undiagnosed_time_share_percent: int | None = None


LOGIN_RATE_LIMIT = 10
LOGIN_RATE_WINDOW_SECONDS = 300


def _settings_for(user) -> UserSettings:
    settings_obj, _ = UserSettings.objects.get_or_create(user=user)
    return settings_obj


def user_out(user) -> dict[str, Any]:
    from apps.exams.models import ExamProject

    settings_obj = _settings_for(user)
    has_projects = ExamProject.objects.filter(owner=user).exists()
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "is_staff": user.is_staff,
        "timezone": settings_obj.timezone,
        "daily_budget_minutes": settings_obj.daily_budget_minutes,
        "undiagnosed_time_share_percent": settings_obj.undiagnosed_time_share_percent,
        "needs_project_setup": not has_projects,
        "is_reviewer": bool(user.is_staff),
    }


def _throttle_login(request, email: str) -> None:
    key = f"login-attempt:{email.lower()}:{request.META.get('REMOTE_ADDR', 'unknown')}"
    attempts = cache.get(key, 0)
    if attempts >= LOGIN_RATE_LIMIT:
        raise RateLimited(message="登录尝试过于频繁，请稍后再试")
    cache.set(key, attempts + 1, LOGIN_RATE_WINDOW_SECONDS)


def _clear_login_throttle(request, email: str) -> None:
    cache.delete(f"login-attempt:{email.lower()}:{request.META.get('REMOTE_ADDR', 'unknown')}")


router = Router(tags=["accounts"])


@router.get("/auth/csrf", auth=None)
@ensure_csrf_cookie
def get_csrf(request):
    """Issue the CSRF cookie and return the token for the SPA to echo.

    A real ``JsonResponse`` is returned (rather than a dict) so the CSRF
    middleware's `set_cookie` runs for this response as well.
    """
    return JsonResponse({"csrf_token": get_token(request)})


@router.post("/auth/login", auth=None)
def post_login(request, payload: LoginIn):
    _throttle_login(request, payload.email)
    user = authenticate(request, username=payload.email.lower().strip(), password=payload.password)
    if user is None or not user.is_active:
        raise InvalidInput(message="邮箱或密码不正确")
    login(request, user)
    _clear_login_throttle(request, payload.email)
    return {"user": user_out(user)}


@router.post("/auth/logout")
def post_logout(request):
    logout(request)
    return {"ok": True}


@router.get("/auth/me", auth=auth)
def get_me(request):
    return user_out(request.user)


@router.get("/me/study-settings", auth=auth, response=StudySettingsOut)
def get_study_settings(request):
    settings_obj = _settings_for(request.user)
    return {
        "timezone": settings_obj.timezone,
        "daily_budget_minutes": settings_obj.daily_budget_minutes,
        "project_budget_percent": settings_obj.project_budget_percent,
        "undiagnosed_time_share_percent": settings_obj.undiagnosed_time_share_percent,
        "default_practice_tutoring": settings_obj.default_practice_tutoring,
    }


@router.patch("/me/study-settings", auth=auth, response=StudySettingsOut)
def patch_study_settings(request, payload: StudySettingsPatch):
    if payload.timezone is not None:
        try:
            ZoneInfo(payload.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise InvalidInput(message="时区无效", details={"timezone": payload.timezone}) from exc
    if payload.daily_budget_minutes is not None and not (
        0 <= payload.daily_budget_minutes <= MAX_DAILY_BUDGET_MINUTES
    ):
        raise InvalidInput(message=f"每日预算必须在 0 到 {MAX_DAILY_BUDGET_MINUTES} 分钟之间")
    if payload.undiagnosed_time_share_percent is not None and not (
        0 <= payload.undiagnosed_time_share_percent <= 80
    ):
        raise InvalidInput(message="未诊断内容时间占比必须在 0 到 80 之间")

    settings_obj = update_study_settings(
        request.user,
        timezone_name=payload.timezone,
        daily_budget_minutes=payload.daily_budget_minutes,
        project_budget_percent=payload.project_budget_percent,
        undiagnosed_time_share_percent=payload.undiagnosed_time_share_percent,
    )
    return {
        "timezone": settings_obj.timezone,
        "daily_budget_minutes": settings_obj.daily_budget_minutes,
        "project_budget_percent": settings_obj.project_budget_percent,
        "undiagnosed_time_share_percent": settings_obj.undiagnosed_time_share_percent,
        "default_practice_tutoring": settings_obj.default_practice_tutoring,
    }
