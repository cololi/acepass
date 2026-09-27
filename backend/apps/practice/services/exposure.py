"""Exposure ledger writes."""

from __future__ import annotations

from django.utils import timezone

from apps.practice.models import ExposureEvent


def record(*, user, project, kind: str, purpose: str, source: str, question=None, question_version=None,
           session_item=None, reveals_answer: bool = False, detail: dict | None = None) -> ExposureEvent:
    return ExposureEvent.objects.create(
        user=user,
        project=project,
        question=question,
        question_version=question_version,
        session_item=session_item,
        family=getattr(question, "family", None) if question is not None else None,
        content_lineage=getattr(question, "content_lineage", None) if question is not None else None,
        kind=kind,
        purpose=purpose,
        source=source,
        server_time=timezone.now(),
        reveals_answer=reveals_answer,
        detail=detail or {},
    )
