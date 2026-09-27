"""Management command wrapper around the demo fixture service."""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.accounts.services.demo_fixture import DEMO_NOTE, load_demo_fixture


class Command(BaseCommand):
    help = "载入标记清晰的演示夹具（两个项目、三个科目、五种题型）"

    def add_arguments(self, parser) -> None:
        parser.add_argument("--email", required=True, help="夹具归属的账户邮箱")
        parser.add_argument("--rebuild", action="store_true", help="已存在同名演示项目时归档旧项目再重建")

    def handle(self, *args, **options):
        try:
            result = load_demo_fixture(options["email"], rebuild=options["rebuild"])
        except LookupError as exc:
            raise CommandError("账户不存在，请先运行 create_account") from exc
        self.stdout.write(self.style.SUCCESS(f"演示夹具已载入：{result['summary']}"))
        self.stdout.write(self.style.WARNING(DEMO_NOTE))
