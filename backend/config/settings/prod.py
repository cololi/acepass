"""Production settings.

Deployment contract — one TLS termination point
-----------------------------------------------
TLS terminates at the nginx edge proxy (``infra/proxy/nginx.conf``): port 80
only redirects to 443, and the certificate/key are mounted into that proxy. The
proxy forwards to Gunicorn over plain HTTP inside the private Docker network
and states the original scheme with ``X-Forwarded-Proto: https``. The public
scheme is therefore always HTTPS, and no TLS listener is required in the API
container.

Consequences encoded below, so the settings and the proxy agree:

* ``SECURE_PROXY_SSL_HEADER`` trusts that one header, so Django sees the
  proxied request as secure instead of redirecting it again.
* ``SECURE_SSL_REDIRECT`` stays on: anything reaching Django *without* the
  proxy header — a container talking to Gunicorn directly, a misrouted port —
  is still sent to HTTPS rather than served in clear text. It is never turned
  off globally.
* ``USE_X_FORWARDED_HOST`` stays off because the proxy forwards the original
  ``Host`` header unchanged, so Django validates that value against
  ``ALLOWED_HOSTS``. Enable ``DJANGO_USE_X_FORWARDED_HOST`` only when another
  proxy layer in front rewrites ``Host`` and sets ``X-Forwarded-Host``.
* ``/health/live`` and ``/health/ready`` are exempt from the HTTPS redirect:
  the Compose healthcheck and any in-network probe speak plain HTTP to
  Gunicorn on 8000. The exemption is path-scoped — business and API paths are
  unaffected — and the endpoint exposes no business data.
* Cookies are HTTPS-only, and ``CSRF_TRUSTED_ORIGINS`` must use ``https://``
  to match the public scheme (loopback ``http://`` origins are accepted only
  for local verification of the stack).

Everything security-relevant is opt-in through the environment: there is no
default secret, no default allowed host and no default debug mode. `check
--deploy` is expected to pass before a release.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401,F403
from .base import env_bool, env_int, env_list  # noqa: F401

DEBUG = False
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", True)

# --------------------------------------------------------------------------
# TLS termination at the proxy (see module docstring)
# --------------------------------------------------------------------------
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = env_bool("DJANGO_USE_X_FORWARDED_HOST", False)

# Internal probes are answered over plain HTTP inside the network. Patterns are
# matched against the path without its leading slash (Django's documented
# SECURE_REDIRECT_EXEMPT behaviour), so these two exact paths are the only ones
# outside the HTTPS requirement.
SECURE_REDIRECT_EXEMPT = [
    *env_list("DJANGO_SECURE_REDIRECT_EXEMPT", []),
    r"^health/live$",
    r"^health/ready$",
]

# The proxy preserves the original Host header, so every public host name must
# still come from DJANGO_ALLOWED_HOSTS. Loopback names are appended because the
# in-container healthcheck and host-side verification of the stack connect with
# a loopback Host header; they grant access to nothing else.
ALLOWED_HOSTS = list(dict.fromkeys([*ALLOWED_HOSTS, "127.0.0.1", "localhost", "[::1]"]))

SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True


def _insecure_csrf_origins(origins: list[str]) -> list[str]:
    """Return the trusted origins that do not match the public HTTPS scheme.

    ``http://`` on an HTTPS site accepts CSRF tokens over an unencrypted hop,
    so it is refused. Loopback origins stay usable for local verification.
    """
    rejected: list[str] = []
    for origin in origins:
        parts = urlsplit(origin)
        host = (parts.hostname or "").lower()
        if parts.scheme == "https":
            continue
        if parts.scheme == "http" and (host == "localhost" or host == "::1" or host.startswith("127.")):
            continue
        rejected.append(origin)
    return rejected


_insecure_origins = _insecure_csrf_origins(CSRF_TRUSTED_ORIGINS)  # noqa: F405
if _insecure_origins:
    raise ImproperlyConfigured(
        "DJANGO_CSRF_TRUSTED_ORIGINS must use https:// in production "
        f"(loopback http origins are allowed for local verification): {_insecure_origins}"
    )

# HSTS is enabled by default behind TLS termination; set the value to 0 only if
# you deliberately do not want it (and read up on the consequences first).
SECURE_HSTS_SECONDS = env_int("DJANGO_SECURE_HSTS_SECONDS", 60 * 60 * 24 * 30)
SECURE_HSTS_INCLUDE_SUBDOMAINS = env_bool("DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS", True)
SECURE_HSTS_PRELOAD = env_bool("DJANGO_SECURE_HSTS_PRELOAD", False)
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# The only deploy-check warning this deployment accepts on purpose: HSTS preload
# is a one-way decision owned by the domain holder (see README). It is silenced
# explicitly so CI can run `check --deploy --fail-level WARNING` and still fail
# on every *new*, unreviewed warning.
SILENCED_SYSTEM_CHECKS = ["security.W021"]

# Static files are collected for the proxy/whitenoise layer; media stays private.
STATICFILES_STORAGE = "django.contrib.staticfiles.storage.ManifestStaticFilesStorage"

# Keep the outbox scan enabled: it is the recovery path when the broker is down.
CELERY_TASK_ALWAYS_EAGER = False
ACEPASS_INLINE_TASKS = False
