"""Test settings.

Tests always run against PostgreSQL (real constraints and transactions). Fast
password hashing and locmem cache keep the suite quick; the AI provider is the
explicit stub, which is the only mode where a stub may be used.
"""

from __future__ import annotations

from .base import *  # noqa: F401,F403
from .base import env

RUNTIME_MODE = "test"
IS_TEST = True
DEBUG = False

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "acepass-test",
    }
}
SESSION_ENGINE = "django.contrib.sessions.backends.db"

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = False
#: Consumers run in-process so the suite does not need a broker.
ACEPASS_INLINE_TASKS = True

# Deterministic AI behaviour for the test suite; individual tests override this.
AI_PROVIDER = env("ACEPASS_TEST_AI_PROVIDER", "stub")
AI_ALLOW_STUB = True

# Keep the suite off the developer's real media directory.
PRIVATE_MEDIA_ROOT = env("ACEPASS_TEST_MEDIA_ROOT", "/tmp/acepass-test-media")
MEDIA_ROOT = PRIVATE_MEDIA_ROOT

DEFAULT_FILE_STORAGE = "django.core.files.storage.FileSystemStorage"

EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
