"""Composed API surface.

Each business module owns a typed router; this module mounts them under one
versioned prefix so the OpenAPI document, authentication scheme and error
contract stay consistent.

The project-scoped routers already carry ``/projects/{project_id}`` in their
operation paths (see ``apps.common.api.project_scoped_router`` for why) and are
therefore mounted at the empty prefix. Order within a router matters where one
path could swallow another.
"""

from __future__ import annotations

from ninja import NinjaAPI

from apps.accounts.api import router as accounts_router
from apps.analytics.api import analytics_router, regrade_router
from apps.common.errors import build_exception_handlers
from apps.exams.api import project_router, projects_router
from apps.ingestion.api import ingestion_router
from apps.knowledge.api import knowledge_router
from apps.learning.api import learning_router, plan_tasks_router
from apps.memory.api import memory_router
from apps.practice.api import practice_router
from apps.question_bank.api import question_api_router
from apps.search.api import search_router
from apps.tutoring.api import tutor_router

api = NinjaAPI(
    title="AcePass API",
    version="1.0.0",
    description=(
        "以考试得分为目标的个性化刷题、补弱与学习验证系统。"
        "示例与演示数据会明确标注，未配置 AI 时相关接口返回 ai_not_configured。"
    ),
    urls_namespace="acepass",
)
build_exception_handlers(api)

api.add_router("", accounts_router)
api.add_router("", projects_router)
api.add_router("", plan_tasks_router)
api.add_router("", learning_router)
api.add_router("", analytics_router)
api.add_router("", regrade_router)
api.add_router("", project_router)
api.add_router("", ingestion_router)
api.add_router("", question_api_router)
api.add_router("", knowledge_router)
api.add_router("", practice_router)
api.add_router("", memory_router)
api.add_router("", search_router)
api.add_router("", tutor_router)
