"""Bookkeeping shared by the paths that open an :class:`~apps.audit.models.LLMRun`.

Every AI path in ``apps/practice/services`` does the same three things around a
model call: it opens a run row *before* the call (so a failure still leaves a
trace), copies the call's usage/cost/latency onto that row, and records why a
failed call failed. The copies had drifted only in whitespace, so they live here
once.

Deliberately *not* shared:

* ``apps/tutoring/services/core.py`` — its recorder also threads the lease/claim
  through the row, so a retry cannot double-charge a run. That is a different
  contract, not a duplicate.
* each service's ``_new_run`` — opening the row is service-specific: the
  capability, the prompt version and (for transcription) whether the *vision*
  model field is the right identifier all come from the caller.
"""

from __future__ import annotations

from ai.providers import base as providers
from apps.audit.models import LLMRun


def model_identifier(provider: providers.BaseProvider) -> str:
    """The text model this provider declares, or ``""`` when it declares none."""
    return getattr(provider, "text_model", "") or ""


def record_call(run: LLMRun, call: providers.AiCallResult) -> None:
    """Copy one call's usage onto its run row. The caller still saves the row."""
    run.prompt_tokens = call.prompt_tokens
    run.completion_tokens = call.completion_tokens
    run.cost_cents = call.cost_cents
    run.cost_known = call.cost_known
    run.attempts = call.attempts
    run.latency_ms = call.latency_ms
    run.is_stub = call.is_stub
    run.raw_response_excerpt = (call.raw_text or "")[:4000]
    run.model_identifier = call.model or run.model_identifier
    run.provider = call.provider or run.provider


def record_failure(run: LLMRun, status: str, exc: Exception) -> None:
    """Mark a run failed and persist the reason. Cost stays unknown, not zero."""
    run.status = status
    run.error_code = getattr(exc, "code", "ai_error")
    run.error_message = str(exc)[:500]
    run.cost_known = False
    run.save()
