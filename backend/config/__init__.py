"""Configuration package. Importing it exposes the Celery app for the CLI."""

from __future__ import annotations

from .celery import app as celery_app

__all__ = ("celery_app",)
