"""App configuration for question_bank."""

from __future__ import annotations

from django.apps import AppConfig


class QuestionBankConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.question_bank"
