"""Production settings.

Everything security-relevant is opt-in through the environment: there is no
default secret, no default allowed host and no default debug mode. `check
--deploy` is expected to pass before a release.
"""

from __future__ import annotations

from .base import *  # noqa: F401,F403
from .base import env_bool, env_int  # noqa: F401

DEBUG = False
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", True)
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# HSTS is enabled by default behind TLS termination; set the value to 0 only if
# you deliberately do not want it (and read up on the consequences first).
SECURE_HSTS_SECONDS = env_int("DJANGO_SECURE_HSTS_SECONDS", 60 * 60 * 24 * 30)
SECURE_HSTS_INCLUDE_SUBDOMAINS = env_bool("DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS", True)
SECURE_HSTS_PRELOAD = env_bool("DJANGO_SECURE_HSTS_PRELOAD", False)
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# Static files are collected for the proxy/whitenoise layer; media stays private.
STATICFILES_STORAGE = "django.contrib.staticfiles.storage.ManifestStaticFilesStorage"

# Keep the outbox scan enabled: it is the recovery path when the broker is down.
CELERY_TASK_ALWAYS_EAGER = False
ACEPASS_INLINE_TASKS = False
