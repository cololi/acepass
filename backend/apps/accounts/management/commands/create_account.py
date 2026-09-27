"""Account bootstrap command.

There is deliberately no default password and no auto-created admin: an
operator must state the email and either supply a password or be prompted for
one. Use ``--generate-password`` in scripted environments where the printed
value is captured and rotated immediately.
"""

from __future__ import annotations

import secrets
import string

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.accounts.services.settings import get_or_create_settings

User = get_user_model()


def generate_password(length: int = 20) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*-_"
    return "".join(secrets.choice(alphabet) for _ in range(length))


class Command(BaseCommand):
    help = "创建或更新 AcePass 账户（不提供默认密码）"

    def add_arguments(self, parser) -> None:
        parser.add_argument("email", help="登录邮箱")
        parser.add_argument("--password", default=None, help="密码；省略时交互输入（不回显）")
        parser.add_argument("--generate-password", action="store_true", help="随机生成强度足够的密码并打印一次")
        parser.add_argument("--display-name", default="", help="显示名")
        parser.add_argument("--staff", action="store_true", help="标记为内部复核人员（不等于可访问他人数据）")
        parser.add_argument("--superuser", action="store_true", help="创建超级用户（仅用于 Django Admin 运维）")
        parser.add_argument("--timezone", default="Asia/Shanghai", help="用户时区，默认 Asia/Shanghai")
        parser.add_argument(
            "--daily-budget-minutes", type=int, default=60, help="每日总学习预算（分钟），默认 60"
        )

    def handle(self, *args, **options):
        email = options["email"].strip().lower()
        if not email or "@" not in email:
            raise CommandError("请提供有效邮箱")
        password = options["password"]
        generated = False
        if options["generate_password"]:
            password = generate_password()
            generated = True
        if not password:
            from django.core.management.utils import get_random_secret_key  # noqa: F401  (import keeps utils loaded)

            password = self._prompt_password()
        if len(password) < 10:
            raise CommandError("密码至少 10 位")

        user = User.objects.filter(email=email).first()
        created = user is None
        if created:
            user = User.objects.create_user(
                email=email,
                password=password,
                display_name=options["display_name"],
                is_staff=options["staff"] or options["superuser"],
                is_superuser=options["superuser"],
            )
        else:
            user.set_password(password)
            if options["display_name"]:
                user.display_name = options["display_name"]
            if options["staff"]:
                user.is_staff = True
            if options["superuser"]:
                user.is_superuser = True
            user.save()

        settings_obj = get_or_create_settings(user)
        settings_obj.timezone = options["timezone"]
        settings_obj.daily_budget_minutes = options["daily_budget_minutes"]
        settings_obj.full_clean(exclude=["user", "created_at", "updated_at"])
        settings_obj.save()

        action = "已创建" if created else "已更新"
        self.stdout.write(self.style.SUCCESS(f"{action}账户：{email}"))
        if generated:
            self.stdout.write(self.style.WARNING("一次性密码（请立即保存并修改）："))
            self.stdout.write(password)

    def _prompt_password(self) -> str:
        import getpass

        first = getpass.getpass("密码：")
        second = getpass.getpass("再次输入密码：")
        if first != second:
            raise CommandError("两次输入的密码不一致")
        return first
