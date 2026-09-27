"""Accounts services: study-budget allocation across active projects."""

from __future__ import annotations

from datetime import date

from django.db import transaction

from apps.accounts.models import UserSettings
from apps.common.errors import InvalidInput


def get_or_create_settings(user) -> UserSettings:
    settings_obj, _ = UserSettings.objects.get_or_create(user=user)
    return settings_obj


@transaction.atomic
def update_study_settings(
    user,
    *,
    timezone_name: str | None = None,
    daily_budget_minutes: int | None = None,
    project_budget_percent: dict[str, float] | None = None,
    undiagnosed_time_share_percent: int | None = None,
) -> UserSettings:
    from apps.exams.models import ExamProject

    settings_obj = get_or_create_settings(user)
    if timezone_name:
        settings_obj.timezone = timezone_name
    if daily_budget_minutes is not None:
        settings_obj.daily_budget_minutes = daily_budget_minutes
    if undiagnosed_time_share_percent is not None:
        settings_obj.undiagnosed_time_share_percent = undiagnosed_time_share_percent
    if project_budget_percent is not None:
        active_ids = {
            str(pid)
            for pid in ExamProject.objects.filter(owner=user, is_archived=False).values_list("id", flat=True)
        }
        cleaned: dict[str, float] = {}
        for raw_pid, raw_percent in project_budget_percent.items():
            pid = str(raw_pid)
            if pid not in active_ids:
                raise InvalidInput(
                    message="预算分配包含不存在的项目或已归档项目",
                    details={"project_id": pid},
                )
            try:
                percent = float(raw_percent)
            except (TypeError, ValueError) as exc:
                raise InvalidInput(message="预算比例必须是数字", details={"project_id": pid}) from exc
            if percent < 0:
                raise InvalidInput(message="预算比例不能为负数", details={"project_id": pid})
            cleaned[pid] = percent
        if cleaned:
            filled = sum(cleaned.values())
            if filled > 100.0001:
                raise InvalidInput(message="预算比例合计不能超过 100%", details={"total": filled})
        settings_obj.project_budget_percent = cleaned
    settings_obj.full_clean(exclude=["user", "created_at", "updated_at"])
    settings_obj.save()
    return settings_obj


def rotation_shift(user, on_date: date, active_project_count: int) -> int:
    """Deterministic daily rotation offset.

    `days since 1970-01-01 mod active project count`, per docs/03 §6. The
    project set and offset are stored with the plan so a same-day retry reuses
    the snapshot instead of favouring one project.
    """
    if active_project_count <= 0:
        return 0
    return (on_date - date(1970, 1, 1)).days % active_project_count
