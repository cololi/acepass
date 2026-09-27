"""AcePass Django settings — shared baseline.

Design notes
------------
* PostgreSQL is the only supported database. SQLite is never substituted for the
  consistency tests (see docs/04-implementation-plan.md M0).
* Every deployment-specific value comes from the environment; there is no
  default superuser password and no default AI credential.
* `ACEPASS_RUNTIME_MODE` distinguishes `production`, `development`, `test` and
  `demo`. The AI test stub only activates in `test`/`demo` mode and is always
  reported as a stub, never as a real provider.
"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BASE_DIR.parent


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def env_bool(name: str, default: bool = False) -> bool:
    raw = env(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    raw = env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:  # pragma: no cover - configuration error path
        raise ValueError(f"environment variable {name} must be an integer") from exc


def env_list(name: str, default: list[str] | None = None) -> list[str]:
    raw = env(name)
    if raw is None:
        return list(default or [])
    return [item.strip() for item in raw.split(",") if item.strip()]


# --------------------------------------------------------------------------
# Runtime mode
# --------------------------------------------------------------------------
RUNTIME_MODE = env("ACEPASS_RUNTIME_MODE", "development")
IS_PRODUCTION = RUNTIME_MODE == "production"
IS_TEST = RUNTIME_MODE == "test"
IS_DEMO = RUNTIME_MODE == "demo"

SECRET_KEY = env("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if IS_PRODUCTION:
        raise RuntimeError("DJANGO_SECRET_KEY is required in production mode")
    SECRET_KEY = "dev-only-insecure-key-change-me"

DEBUG = env_bool("DJANGO_DEBUG", default=not IS_PRODUCTION)
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", ["localhost", "127.0.0.1", "[::1]"])

# Same-origin deployment: the SPA is served by the reverse proxy that also
# routes /api, so no CORS layer is configured. CSRF trusts the configured
# origins only.
CSRF_TRUSTED_ORIGINS = env_list(
    "DJANGO_CSRF_TRUSTED_ORIGINS",
    ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8000", "http://127.0.0.1:8000"],
)

# --------------------------------------------------------------------------
# Applications
# --------------------------------------------------------------------------
DJANGO_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

LOCAL_APPS = [
    "apps.accounts",
    "apps.audit",
    "apps.exams",
    "apps.knowledge",
    "apps.ingestion",
    "apps.question_bank",
    "apps.practice",
    "apps.tutoring",
    "apps.learning",
    "apps.analytics",
]

INSTALLED_APPS = DJANGO_APPS + LOCAL_APPS

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.audit.middleware.RequestIdMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# --------------------------------------------------------------------------
# Database — PostgreSQL only
# --------------------------------------------------------------------------
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": env("POSTGRES_DB", "acepass"),
        "USER": env("POSTGRES_USER", "acepass"),
        "PASSWORD": env("POSTGRES_PASSWORD", "acepass_dev_pw"),
        "HOST": env("POSTGRES_HOST", "127.0.0.1"),
        "PORT": env("POSTGRES_PORT", "5432"),
        "CONN_MAX_AGE": env_int("POSTGRES_CONN_MAX_AGE", 60),
        "OPTIONS": {"connect_timeout": env_int("POSTGRES_CONNECT_TIMEOUT", 10)},
    }
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_USER_MODEL = "accounts.User"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 10}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# --------------------------------------------------------------------------
# Sessions / CSRF (same-origin, server-side session)
# --------------------------------------------------------------------------
SESSION_ENGINE = "django.contrib.sessions.backends.cache"
SESSION_CACHE_ALIAS = "default"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = IS_PRODUCTION
CSRF_COOKIE_HTTPONLY = False  # the SPA must echo it in X-CSRFToken
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = IS_PRODUCTION
CSRF_FAILURE_VIEW = "apps.accounts.views.csrf_failure"
SESSION_COOKIE_AGE = env_int("DJANGO_SESSION_COOKIE_AGE", 60 * 60 * 24 * 14)

if IS_PRODUCTION:
    SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", True)
    SECURE_HSTS_SECONDS = env_int("DJANGO_SECURE_HSTS_SECONDS", 60 * 60 * 24 * 30)
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"
    X_FRAME_OPTIONS = "DENY"

# --------------------------------------------------------------------------
# Cache / Redis / Celery
# --------------------------------------------------------------------------
REDIS_URL = env("REDIS_URL", "redis://127.0.0.1:6379/0")
CELERY_BROKER_URL = env("CELERY_BROKER_URL", REDIS_URL)
CELERY_RESULT_BACKEND = env("CELERY_RESULT_BACKEND", env("REDIS_URL", "redis://127.0.0.1:6379/1"))

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": env("CACHE_URL", REDIS_URL),
        "KEY_PREFIX": env("CACHE_KEY_PREFIX", "acepass"),
        "TIMEOUT": 300,
    }
}

CELERY_TASK_ALWAYS_EAGER = env_bool("CELERY_TASK_ALWAYS_EAGER", default=False)
#: Run outbox consumers in-process instead of handing them to Celery. Enabled by
#: the test/demo settings only; production relies on the workers plus the
#: periodic scan, so a broker outage can never lose business facts.
ACEPASS_INLINE_TASKS = env_bool("ACEPASS_INLINE_TASKS", default=IS_TEST or IS_DEMO)
CELERY_TASK_EAGER_PROPAGATES = False
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TIMEZONE = "UTC"
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_DEFAULT_QUEUE = "ingestion"
#: Autodiscovery looks for a `tasks` module inside each installed app, which
#: fails for the "apps." package prefix, so the modules are listed explicitly.
CELERY_IMPORTS = ("apps.audit.tasks", "apps.tutoring.tasks")
CELERY_TASK_ROUTES = {
    "ingestion.*": {"queue": "ingestion"},
    "tutoring.*": {"queue": "tutoring"},
    "projection.*": {"queue": "projection"},
    "audit.*": {"queue": "ingestion"},
}

# --------------------------------------------------------------------------
# AI provider capability layer
# --------------------------------------------------------------------------
# `none` (default) keeps every non-AI feature working and reports AI as
# unconfigured. `openai_compatible` performs real HTTPS calls. `stub` is only
# honoured in test/demo mode and is always surfaced as a stub in the UI/audit.
AI_PROVIDER = env("ACEPASS_AI_PROVIDER", "none")
AI_TEXT_MODEL = env("ACEPASS_AI_TEXT_MODEL")
AI_VISION_MODEL = env("ACEPASS_AI_VISION_MODEL")
AI_BASE_URL = env("ACEPASS_AI_BASE_URL")
AI_API_KEY = env("ACEPASS_AI_API_KEY")
AI_CONNECT_TIMEOUT_SECONDS = env_int("ACEPASS_AI_CONNECT_TIMEOUT_SECONDS", 10)
AI_TOTAL_TIMEOUT_SECONDS = env_int("ACEPASS_AI_TOTAL_TIMEOUT_SECONDS", 90)
AI_MAX_RETRIES = env_int("ACEPASS_AI_MAX_RETRIES", 2)
AI_MAX_STRUCTURE_REPAIRS = env_int("ACEPASS_AI_MAX_STRUCTURE_REPAIRS", 1)
# Ceiling for one provider call, in USD cents; null means "record only".
AI_MAX_COST_CENTS = env("ACEPASS_AI_MAX_COST_CENTS")
AI_ALLOW_STUB = IS_TEST or IS_DEMO

# --------------------------------------------------------------------------
# Private file storage adapter
# --------------------------------------------------------------------------
STORAGE_BACKEND = env("ACEPASS_STORAGE_BACKEND", "local")
PRIVATE_MEDIA_ROOT = Path(env("ACEPASS_PRIVATE_MEDIA_ROOT", str(REPO_ROOT / "var" / "private-media")))
MEDIA_ROOT = PRIVATE_MEDIA_ROOT
MEDIA_URL = "/api/v1/files/"
FILE_UPLOAD_MAX_MEMORY_SIZE = env_int("ACEPASS_FILE_UPLOAD_MAX_MEMORY_SIZE", 10 * 1024 * 1024)
DATA_UPLOAD_MAX_MEMORY_SIZE = env_int("ACEPASS_DATA_UPLOAD_MAX_MEMORY_SIZE", 32 * 1024 * 1024)

IMAGE_MAX_BYTES = env_int("ACEPASS_IMAGE_MAX_BYTES", 10 * 1024 * 1024)
IMAGE_MAX_PIXELS = env_int("ACEPASS_IMAGE_MAX_PIXELS", 25_000_000)
ATTEMPT_MAX_ATTACHMENTS = env_int("ACEPASS_ATTEMPT_MAX_ATTACHMENTS", 6)
ATTEMPT_MAX_ATTACHMENT_BYTES = env_int("ACEPASS_ATTEMPT_MAX_ATTACHMENT_BYTES", 30 * 1024 * 1024)
ALLOWED_IMAGE_MIME_TYPES = ("image/jpeg", "image/png", "image/webp")

SIGNED_URL_TTL_SECONDS = env_int("ACEPASS_SIGNED_URL_TTL_SECONDS", 300)

# --------------------------------------------------------------------------
# Domain tunables (versioned product assumptions, not exam rules)
# --------------------------------------------------------------------------
DELAYED_VERIFICATION_HOURS = env_int("ACEPASS_DELAYED_VERIFICATION_HOURS", 24)
DEFAULT_DAILY_BUDGET_MINUTES = env_int("ACEPASS_DEFAULT_DAILY_BUDGET_MINUTES", 60)
UNDIAGNOSED_TIME_SHARE_PERCENT = env_int("ACEPASS_UNDIAGNOSED_TIME_SHARE_PERCENT", 20)

# --------------------------------------------------------------------------
# i18n / static
# --------------------------------------------------------------------------
LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "UTC"  # business timestamps are UTC; user timezone only affects "today"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = Path(env("DJANGO_STATIC_ROOT", str(REPO_ROOT / "var" / "static")))
FRONTEND_DIST = Path(env("ACEPASS_FRONTEND_DIST", str(REPO_ROOT / "frontend" / "dist")))

# --------------------------------------------------------------------------
# Logging — no secrets, no raw personal images
# --------------------------------------------------------------------------
LOG_LEVEL = env("DJANGO_LOG_LEVEL", "INFO")
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "standard"},
    },
    "root": {"handlers": ["console"], "level": LOG_LEVEL},
    "loggers": {
        "django.request": {"handlers": ["console"], "level": "WARNING", "propagate": False},
        "apps": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
    },
}
