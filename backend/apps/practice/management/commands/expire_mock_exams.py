"""Finish mock exams whose server-owned deadline has passed (C05).

The read paths reconcile the exam they touch, which covers a learner who comes
back. This command is the *worker* entry point for the runs nobody touches: a
closed tab, a lost connection, a batch of demo accounts. It is idempotent, so it
can be scheduled (cron / a task runner) as often as wanted — a second run finds
nothing left to do, and a run that races a live request cannot double-finish an
exam: both go through the same locked, re-checked writer.

    python manage.py expire_mock_exams
    python manage.py expire_mock_exams --project-id <uuid> --limit 100
    python manage.py expire_mock_exams --now 2026-01-01T09:00:00+08:00
"""

from __future__ import annotations

from datetime import datetime

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone


class Command(BaseCommand):
    help = "把已过服务器截止时间的模拟考试按截止时间结束（幂等，可反复运行）"

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--project-id",
            default="",
            help="只处理该项目下的模拟考试（默认全部项目）",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=200,
            help="单次最多结束多少场考试（默认 200）",
        )
        parser.add_argument(
            "--now",
            default="",
            help="按指定时刻判定（ISO 8601，便于补跑/复验；默认服务器当前时间）",
        )

    def handle(self, *args, **options):
        from apps.exams.models import ExamProject
        from apps.practice.services import sessions as session_services

        project = None
        project_id = (options.get("project_id") or "").strip()
        if project_id:
            project = ExamProject.objects.filter(id=project_id).first()
            if project is None:
                raise CommandError(f"项目不存在：{project_id}")

        now = None
        raw_now = (options.get("now") or "").strip()
        if raw_now:
            try:
                now = datetime.fromisoformat(raw_now)
            except ValueError as exc:
                raise CommandError(f"--now 不是合法的 ISO 8601 时间：{raw_now}") from exc
            if timezone.is_naive(now):
                now = timezone.make_aware(now, timezone.get_current_timezone())

        limit = max(1, int(options.get("limit") or 200))
        expired = session_services.expire_due_mock_exams(
            project=project, now=now, limit=limit
        )
        self.stdout.write(f"expired={expired}")
