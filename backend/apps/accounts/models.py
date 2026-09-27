"""Accounts domain: identity, per-user study budget and timezone."""

from __future__ import annotations

import uuid

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from apps.common.enums import PracticeMode

MAX_DAILY_BUDGET_MINUTES = 24 * 60


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def _create_user(self, email: str, password: str | None, **extra):
        if not email:
            raise ValueError("email is required")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.full_clean(exclude=["password"])
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra):
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email: str, password: str, **extra):
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        if not extra.get("is_staff") or not extra.get("is_superuser"):
            raise ValueError("superuser requires is_staff and is_superuser")
        return self._create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """Identity only. A staff flag never grants access to another user's data."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    display_name = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(default=timezone.now)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        db_table = "accounts_user"
        verbose_name = "用户"
        verbose_name_plural = "用户"

    def __str__(self) -> str:
        return self.email

    @property
    def short_name(self) -> str:
        return self.display_name or self.email


class UserSettings(models.Model):
    """Global study budget. Multiple active projects share ONE daily budget."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="settings")
    timezone = models.CharField(max_length=64, default="Asia/Shanghai")
    daily_budget_minutes = models.PositiveIntegerField(
        default=60,
        validators=[MinValueValidator(0), MaxValueValidator(MAX_DAILY_BUDGET_MINUTES)],
    )
    #: Percent per project id; an empty dict means "split evenly".
    project_budget_percent = models.JSONField(default=dict, blank=True)
    #: Percent of project time reserved for undiagnosed knowledge points.
    undiagnosed_time_share_percent = models.PositiveSmallIntegerField(
        default=20, validators=[MaxValueValidator(80)]
    )
    #: Default tutoring availability; a session mode may only restrict it.
    default_practice_tutoring = models.CharField(
        max_length=16, choices=PracticeMode.choices, default=PracticeMode.ALLOWED
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "accounts_user_settings"
        verbose_name = "学习设置"
        verbose_name_plural = "学习设置"

    def __str__(self) -> str:
        return f"settings({self.user_id})"

    @property
    def zone(self):
        from zoneinfo import ZoneInfo

        try:
            return ZoneInfo(self.timezone)
        except Exception:  # pragma: no cover - validated on write
            return ZoneInfo("UTC")

    def local_date(self, at=None):
        """Current date for this user's display timezone (UTC storage)."""
        moment = at or timezone.now()
        return timezone.localtime(moment, self.zone).date()
