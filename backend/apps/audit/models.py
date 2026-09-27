"""Audit domain: request correlation, idempotency, outbox, model-run records."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from apps.common.enums import LlmRunStatus, OutboxStatus
from apps.common.models import BaseModel


class RequestLog(BaseModel):
    """Minimal request trace. Never stores secrets or raw personal images."""

    request_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="request_logs"
    )
    method = models.CharField(max_length=10)
    path = models.CharField(max_length=500)
    status_code = models.PositiveSmallIntegerField(null=True, blank=True)
    duration_ms = models.PositiveIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "audit_request_log"
        indexes = [models.Index(fields=["user", "-created_at"])]
        verbose_name = "请求日志"
        verbose_name_plural = "请求日志"


class IdempotencyRecord(BaseModel):
    """One row per (user, route scope, key). Guarantees side effects once."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="idempotency_records")
    route_scope = models.CharField(max_length=200)
    idempotency_key = models.CharField(max_length=200)
    request_fingerprint = models.CharField(max_length=64)
    status_code = models.PositiveSmallIntegerField(null=True, blank=True)
    response_body = models.JSONField(null=True, blank=True)
    resource_type = models.CharField(max_length=100, blank=True)
    resource_id = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "audit_idempotency_record"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "route_scope", "idempotency_key"], name="uniq_idempotency_user_scope_key"
            )
        ]
        verbose_name = "幂等记录"
        verbose_name_plural = "幂等记录"


class OutboxEvent(BaseModel):
    """Transactional outbox. Business state lives in PostgreSQL, not in Redis."""

    topic = models.CharField(max_length=100, db_index=True)
    payload = models.JSONField(default=dict)
    status = models.CharField(max_length=16, choices=OutboxStatus.choices, default=OutboxStatus.PENDING, db_index=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    available_at = models.DateTimeField(db_index=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=500, blank=True)
    dedupe_key = models.CharField(max_length=200, null=True, blank=True, unique=True)

    class Meta:
        db_table = "audit_outbox_event"
        indexes = [models.Index(fields=["status", "available_at"])]
        verbose_name = "任务发件箱"
        verbose_name_plural = "任务发件箱"


class LLMRun(BaseModel):
    """One model/provider invocation with its cost and validation outcome."""

    provider = models.CharField(max_length=60)
    model_identifier = models.CharField(max_length=120, blank=True)
    capability = models.CharField(max_length=40)
    prompt_version = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=16, choices=LlmRunStatus.choices, default=LlmRunStatus.FAILED)
    request_summary = models.JSONField(default=dict, blank=True)
    input_snapshot = models.JSONField(default=dict, blank=True)
    retrieval_source_ids = models.JSONField(default=list, blank=True)
    validation_result = models.JSONField(default=dict, blank=True)
    raw_response_excerpt = models.TextField(blank=True)
    prompt_tokens = models.PositiveIntegerField(null=True, blank=True)
    completion_tokens = models.PositiveIntegerField(null=True, blank=True)
    cost_cents = models.DecimalField(max_digits=10, decimal_places=4, null=True, blank=True)
    cost_known = models.BooleanField(default=False)
    latency_ms = models.PositiveIntegerField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=1)
    error_code = models.CharField(max_length=80, blank=True)
    error_message = models.CharField(max_length=500, blank=True)
    is_stub = models.BooleanField(default=False, help_text="由测试/演示 stub 产生，不代表真实模型结果")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="llm_runs"
    )
    project_id = models.UUIDField(null=True, blank=True, db_index=True)

    class Meta:
        db_table = "audit_llm_run"
        indexes = [models.Index(fields=["provider", "-created_at"]), models.Index(fields=["capability", "status"])]
        verbose_name = "模型调用"
        verbose_name_plural = "模型调用"

    def __str__(self) -> str:
        return f"{self.provider}:{self.capability}:{self.status}"


class ContentRevision(BaseModel):
    """Audit row for an editorial change to content or grading-relevant facts."""

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="content_revisions"
    )
    entity_type = models.CharField(max_length=80)
    entity_id = models.CharField(max_length=64)
    action = models.CharField(max_length=60)
    project_id = models.UUIDField(null=True, blank=True, db_index=True)
    reason = models.CharField(max_length=500, blank=True)
    before_digest = models.CharField(max_length=64, blank=True)
    after_digest = models.CharField(max_length=64, blank=True)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "audit_content_revision"
        indexes = [models.Index(fields=["entity_type", "entity_id", "-created_at"])]
        verbose_name = "内容修订"
        verbose_name_plural = "内容修订"
