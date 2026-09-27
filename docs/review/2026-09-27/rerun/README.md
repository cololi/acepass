# P0.1 重新验收运行输出（2026-09-27）

本目录是 P0.1 修复后的**重新运行输出**，与上级目录中原始失败输出一一对应，便于对比。
汇总结论见 [P0.1 修复与重新验收报告](../../../08-p0-1-repair-verification.md)。

| 文件 | 命令 | 结果 |
|---|---|---|
| `pytest-summary.txt` | `cd backend && .venv/bin/python -m pytest -q` | **164 passed** |
| `original-suite.txt` | 原浏览器套件（`frontend/playwright.config.ts`，已加固并强制隔离） | **16 passed**（desktop 8 + mobile 8） |
| `acceptance-suite.txt` | 新增浏览器验收（`frontend/playwright.acceptance.config.ts`） | **30 passed, 0 skipped**（desktop 15 + mobile 15） |
| `celery-worker.txt` | 真实 Celery worker（`-Q ingestion,tutoring,projection`） | 12 个主题全部注册并消费 |
| `worker-e2e.txt` | `scripts/verify_worker_e2e.py` | `ok: true`，outbox 56/56 processed，`unresolved={}` |

运行隔离（两个浏览器套件都强制，配置在缺少任一项时直接拒绝启动）：
独立 PostgreSQL 库（`acepass_acceptance_*` / `acepass_browser_audit_*`）、独立 Redis
（6391 / 6392）、独立 API 与 Vite 端口、全新空媒体目录、`ACEPASS_INLINE_TASKS=false`。
未对开发库执行任何 reset/rebuild；开发库仅先备份（`var/backups/pre-p01-*.sql`）后按序
应用追加型迁移。
