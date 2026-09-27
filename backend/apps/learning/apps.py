"""App configuration for learning."""

from __future__ import annotations

from django.apps import AppConfig


class LearningConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.learning"
