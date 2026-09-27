"""Reset one account's practice state so a demo fixture can be rebuilt.

This is a **demo/acceptance helper**, not a learner-facing feature: it abandons
active sessions (raw answers and grade events are kept) and archives the demo
projects so `load_demo_fixture --rebuild` can start from a clean slate. It
refuses to touch non-demo projects.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.common.enums import SessionStatus
from apps.exams.models import ExamProject
from apps.exams.services import core as exams_services
from apps.practice.models import PracticeSession

User = get_user_model()

DEMO_PROJECT_NAMES = ("演示项目A·综合能力", "演示项目B·专业实务")


class Command(BaseCommand):
    help = "放弃演示账户进行中的会话并归档演示项目（便于重建演示夹具）"

    def add_arguments(self, parser) -> None:
        parser.add_argument("--email", required=True)

    @transaction.atomic
    def handle(self, *args, **options):
        user = User.objects.filter(email=options["email"].strip().lower()).first()
        if user is None:
            raise CommandError("账户不存在")

        abandoned = PracticeSession.objects.filter(user=user, status=SessionStatus.ACTIVE).update(
            status=SessionStatus.ABANDONED, finished_at=timezone.now(), updated_at=timezone.now()
        )
        archived = 0
        for name in DEMO_PROJECT_NAMES:
            project = ExamProject.objects.filter(owner=user, name=name, is_archived=False).first()
            if project is None:
                continue
            exams_services.archive_project(project, reason="演示夹具重建前归档")
            archived += 1
        outside = ExamProject.objects.filter(owner=user).exclude(name__in=DEMO_PROJECT_NAMES).count()
        self.stdout.write(
            self.style.SUCCESS(
                f"已放弃 {abandoned} 个进行中会话，归档 {archived} 个演示项目"
                + (f"（保留 {outside} 个非演示项目，未修改）" if outside else "")
            )
        )
