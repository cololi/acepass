"""W4 verifier probe settings.

Deliberately a *separate* database from every writer's database, so a verifier
probe can never be confused with (or perturb) an author's measurement:

* W1 ``acepass_opt_w`` / W2 ``acepass_opt_q`` / W4 gate ``acepass_opt_v``
* these probes: ``W4_PROBE_DB`` (default ``acepass_opt_v_w4``)

``ACEPASS_INLINE_TASKS`` is False here on purpose: counter-example ① must
exercise the *broker hand-off* path (``dispatch_event`` -> ``send_task``), which
is the path the defect lives on. Inline mode never touches a broker.
"""

from __future__ import annotations

import os

from config.settings.test import *  # noqa: F401,F403

_PROBE_DB = os.environ.get("W4_PROBE_DB", "acepass_opt_v_w4")
DATABASES["default"]["TEST"] = {"NAME": f"test_{_PROBE_DB}"}  # noqa: F405

PRIVATE_MEDIA_ROOT = os.environ.get("W4_PROBE_MEDIA", "/tmp/acepass-w4-verify-media")
MEDIA_ROOT = PRIVATE_MEDIA_ROOT

ACEPASS_INLINE_TASKS = False
