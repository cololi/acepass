"""Pytest configuration.

PostgreSQL is required: the consistency and constraint tests must run against
the real database, never SQLite.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
os.environ.setdefault("ACEPASS_RUNTIME_MODE", "test")


def pytest_configure() -> None:
    os.environ.setdefault("ACEPASS_RUNTIME_MODE", "test")


@pytest.fixture(scope="session")
def django_db_modify_db_settings(django_db_modify_db_settings):
    """Keep the test database local; the suite never touches acepass (dev)."""
    return django_db_modify_db_settings


@pytest.fixture
def media_root(tmp_path, settings):
    settings.PRIVATE_MEDIA_ROOT = tmp_path / "private-media"
    settings.PRIVATE_MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    settings.MEDIA_ROOT = settings.PRIVATE_MEDIA_ROOT
    from apps.ingestion import storage

    storage.reset_storage_cache()
    yield settings.PRIVATE_MEDIA_ROOT
    storage.reset_storage_cache()
