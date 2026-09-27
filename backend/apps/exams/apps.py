"""App configuration for exams."""

from __future__ import annotations

from django.apps import AppConfig


class ExamsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.exams"
