"""Local development settings: same baseline, local-friendly cache fallback."""

from __future__ import annotations

import os

from .base import *  # noqa: F401,F403
from .base import env, env_bool

DEBUG = env_bool("DJANGO_DEBUG", True)

# Locmem keeps `manage.py runserver` usable even if Redis is not running.
# Celery still needs a broker; without Redis the outbox stays queued and the
# API keeps serving (async features degrade, they do not crash).
if env_bool("ACEPASS_USE_LOCMEM_CACHE", default=not os.environ.get("REDIS_URL")):
    CACHES = {  # noqa: F405
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "acepass-dev",
        }
    }
    SESSION_ENGINE = "django.contrib.sessions.backends.db"

INTERNAL_IPS = ["127.0.0.1", "localhost"]
