"""Shared model building blocks for every AcePass app."""

from __future__ import annotations

import uuid

from django.db import models


class UUIDPrimaryKeyMixin(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True


class TimeStampedMixin(models.Model):
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class BaseModel(UUIDPrimaryKeyMixin, TimeStampedMixin):
    """UUID identity plus audit timestamps.

    Business facts are never hard-deleted through the API; archive/withdraw is
    modelled explicitly on the owning entity.
    """

    class Meta:
        abstract = True
