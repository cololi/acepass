# 2026-09-27 独立验收证据

审查 HEAD `7db03c5`，应用代码基线 `5428018`。结论见 [独立验收报告](../../06-independent-p0-review.md)，修复顺序见 [下一步计划](../../07-p0-repair-plan.md)。本目录的失败是已复现的规格缺口，并非应用已修复的证明。

## 已实际运行

| 检查 | 结果 | 保存的证据 |
|---|---|---|
| 原 pytest 全套 | 119 passed，22.83s | 当次终端输出；使用独立测试库 |
| 原 Playwright | 16 passed，26.5s | [运行输出](playwright-original-suite.txt)，其中仍可见 learning 接口 404 |
| 新后端回归 | 13 failed / 1 passed，6.36s | [测试](test_p0_regressions.py)、[运行输出](regression-results.txt) |
| 新 UI 回归 | 3 failed | [测试](ui-regressions.spec.ts)、[运行输出](ui-regression-results.txt) |
| 非内联 Celery | 缺少 learning.reconcile_plan consumer | [Worker 日志](celery-worker.txt)、[隔离库最终计数](isolated-browser-db-summary.json) |
| Ruff、缺失迁移检查、前端构建 | 通过 | 当次终端输出；构建有 chunk 大于 500 kB 提示 |

后端回归中的一条通过测试验证“0 分没有被当成独立正确”，用于排除误报。13 条失败并不代表 13 个互不相关缺陷，例如三条 learning 路由失败属于同一问题。

截图及页面状态：

- [提交后没有辅导入口](screenshots/submitted.png) / [页面状态](screenshots/submitted.md)
- [刷新后 reveal 请求失败](screenshots/reveal-after-reload.png) / [页面状态](screenshots/reveal-after-reload.md)
- [大题没有照片输入](screenshots/photo-answer.png) / [页面状态](screenshots/photo-answer.md)

浏览器两轮共享本次新建的 `acepass_browser_audit_20260927`，依次运行原套件与新增回归；Redis 6391、API 8001、Vite 5174、媒体目录和真实 Worker 均隔离。最终计数在两轮完成后采集，不能当作原套件单独产生的结果。结束后已停止临时服务并删除该浏览器库；现有业务库和 8000/5173 服务未修改。pytest 使用其他专用测试库并自动清理。

## 后端复现

在仓库根目录执行，使用现有 PostgreSQL 配置连接，但由 Django 创建专用测试库：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27" \
  backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/test_p0_regressions.py \
  -c backend/pytest.ini --ds=review_settings -q -s
```

[review_settings.py](review_settings.py) 固定测试库为 `test_acepass_independent_regressions_20260927`。修复前预期出现上述失败；修复后应迁入正常测试套件，并完善真实并发和多入口覆盖。

## 浏览器复现

保存的 [Playwright 配置](playwright.review.config.cjs) 与 [Vite 配置](vite.review.config.mjs) 将当次临时配置整理为仓库相对路径，并增加环境隔离校验。新配置仅做加载和测试发现校验；上述实际运行结果来自同端口、同设置的临时配置。配置没有自动创建数据库或 Redis，也不会自动启动 Worker。

先创建一个**全新且仅供本次测试使用**的 PostgreSQL 数据库，名称以 `acepass_browser_audit_` 或 `acepass_acceptance_` 开头；启动独立 Redis 6391。原套件 globalSetup 会重建该库中的演示数据，不得指向业务库。新进程共同设置下列变量，媒体路径必须是本次新建的空目录：

```bash
export POSTGRES_DB=acepass_acceptance_20260927_rerun
export REDIS_URL=redis://127.0.0.1:6391/0
export DJANGO_SETTINGS_MODULE=config.settings.dev
export ACEPASS_INLINE_TASKS=false
export ACEPASS_PRIVATE_MEDIA_ROOT="$(mktemp -d /tmp/acepass-acceptance-media.XXXXXX)"
export DJANGO_CSRF_TRUSTED_ORIGINS=http://127.0.0.1:5174,http://127.0.0.1:8001
```

按本机 PostgreSQL 认证方式创建上面命名的空库，并在另一终端启动独立 Redis：

```bash
redis-server --bind 127.0.0.1 --port 6391 --save '' --appendonly no
```

使用同样环境变量，在 backend 目录启动真实消费者：

```bash
.venv/bin/celery -A config worker --pool=solo -Q ingestion,tutoring,projection -c 1 -l INFO
```

回到仓库根目录，先运行原套件完成演示数据准备，再运行新增回归。配置拒绝复用已存在的 API/Vite 服务：

```bash
ACEPASS_REVIEW_SUITE=original frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/playwright.review.config.cjs
ACEPASS_REVIEW_SUITE=regressions frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/playwright.review.config.cjs
```

结束后停止本次创建的 Worker/Redis，仅删除本次新建的测试库与媒体目录。真实 provider、真实隔天和 Compose 完整启动不包含在这组结果中。
