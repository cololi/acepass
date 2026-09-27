"""Django URL configuration.

API routers are mounted under ``/api/v1``. The SPA is served by the same origin
so session cookies and CSRF tokens work without cross-origin exceptions; the
reverse proxy also routes ``/api`` here.
"""

from __future__ import annotations

from django.conf import settings
from django.contrib import admin
from django.http import FileResponse, Http404, JsonResponse
from django.urls import path

from apps.accounts.views import health_live, health_ready
from config.api import api


def spa_index(request):
    """Serve the built SPA shell when it exists.

    Development uses the Vite dev server (which proxies /api here), so a missing
    bundle is not an error: it is reported explicitly instead of serving a blank
    page.
    """
    index = settings.FRONTEND_DIST / "index.html"
    if not index.is_file():
        return JsonResponse(
            {
                "error": {
                    "code": "frontend_not_built",
                    "message": "前端尚未构建：请运行 `npm run build`（开发时使用 Vite 开发服务器 http://127.0.0.1:5173）。",
                    "details": {"expected": str(index)},
                }
            },
            status=503,
        )
    return FileResponse(open(index, "rb"), content_type="text/html; charset=utf-8")


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", api.urls),
    path("health/live", health_live, name="health-live"),
    path("health/ready", health_ready, name="health-ready"),
]

# Static asset passthrough for the built SPA. Unknown non-API paths fall back to
# the SPA shell so client-side routing works on refresh.
if settings.FRONTEND_DIST.is_dir():
    from django.views.static import serve as static_serve

    urlpatterns += [
        path(
            "assets/<path:path>",
            lambda request, path: static_serve(request, path, document_root=str(settings.FRONTEND_DIST / "assets")),
        ),
    ]


def catch_all(request, path: str = ""):
    if path.startswith(("api/", "admin/", "static/", "health/", "assets/")):
        raise Http404(path)
    return spa_index(request)


urlpatterns += [path("<path:path>", catch_all)]
