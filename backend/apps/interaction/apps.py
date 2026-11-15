"""App configuration for interaction (memory-driven learning sessions)."""

from __future__ import annotations

from django.apps import AppConfig


class InteractionConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.interaction"
