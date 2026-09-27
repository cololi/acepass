# P0.2 定向补漏：本轮证据

本轮修复对象是 [12 独立复验](../../../12-p0-2-independent-review.md) 保留的 C01—C05。
任务书：[DEEPSEEK_P0_2_REMAINING.md](../../../../DEEPSEEK_P0_2_REMAINING.md)。

所有数字都是本轮实际执行结果。业务库 `acepass` 未执行 migrate、未审计改写、未清理；本轮所有
数据库都是新建的专用库，运行结束后已删除。

## 1. 文件清单

| 文件 | 本轮实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 后端全套 **194 passed**（177 + 本轮迁入 17 条）/ 130.87s，真实 PostgreSQL |
| [official-closeout-tests.txt](official-closeout-tests.txt) | 迁入正式套件的 C01—C04 回归 **17 passed** / 29.46s |
| [archived-counterexamples-after-fix.txt](archived-counterexamples-after-fix.txt) | 上一轮归档的 10 条交叉反例原样执行：**9 passed，1 条按方案调整后作废**（见 §3） |
| [browser-acceptance.txt](browser-acceptance.txt) | 新版浏览器验收 **36 passed** / 50.9s（desktop+mobile，真实 Worker，ACEPASS_INLINE_TASKS=false） |
| [archived-browser.txt](archived-browser.txt) | 上一轮归档浏览器反例 **2 passed** / 4.5s（未修改） |
| [worker-drill.txt](worker-drill.txt)、[JSON](worker-drill.json) | 真故障演练 **ok=true**：真 FLUSHALL 恢复、真 SIGKILL 命中处理中任务后恢复、同一 event 重复投递 + 迟到消费者 |
| [proxy-component.txt](proxy-component.txt) | 代理组件检查通过：301 目标、TLS、真实 `frontend/dist` 登录页与脚本资源、`api:8000` 上游真实解析 |
| [proxy-full-stack.txt](proxy-full-stack.txt) | 全栈检查通过：真实镜像 + 真实迁移 + 经 HTTPS 代理的真实登录（HTTP 200） |

## 2. 复现命令

后端全套与迁入回归：

```bash
cd backend && .venv/bin/python -m pytest tests -q
.venv/bin/python -m pytest tests/integration/test_p0_2_closeout_gaps.py -q
```

归档反例（专用测试库，`p02_independent_settings` 只改 TEST.NAME，不动业务库）：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" \
  backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p02-independent/test_*.py \
  -c backend/pytest.ini --ds=p02_independent_settings -q
```

浏览器（新建 `acepass_acceptance_p02_remaining_browser`、独占 Redis 6394、API 8014、Vite 5184、
空媒体目录 + 真实 Worker；两个套件共用这套端口，见 [p01 隔离说明](../p01-independent/README.md)）：

```bash
cd frontend && node_modules/.bin/playwright test --config playwright.acceptance.config.ts
cd .. && frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs
```

真故障演练（独占 Redis 实例；脚本会 `FLUSHALL`，换 DB 编号不能隔离，因此需要显式确认）：

```bash
ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 \
ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub \
ACEPASS_OUTBOX_LEASE_SECONDS=5 \
ACEPASS_WORKER_DRILL_REPORT=/tmp/acepass-drill.json \
PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py
```

发布门槛脚本（本机 Docker；GitHub Actions 未实际执行，保持未验证）：

```bash
bash scripts/verify_proxy.sh component     # 代理组件，固定 18080/18443
bash scripts/verify_proxy.sh full-stack    # 全栈，默认 8080/8443
```

## 3. 归档反例里唯一被作废的一条

[test_regrade_and_delay.py](test_regrade_and_delay.py) 的第三条
`test_generation_migration_cannot_promote_old_queued_run_above_applied_newer_run` 断言旧 run 抢到
更高代次后覆盖较新评分。C02 的修复是**拒绝歧义历史**：迁移不再重编号，所以它引用的
`RENUMBER_DUPLICATES` 常量按设计已不存在，该文件报 `AttributeError`。

它的业务断言（"重复历史不能让旧任务获得比新任务更高的有效顺序"）没有删除，而是迁入正式套件并由
两条测试覆盖：`test_generation_migration_refuses_ambiguous_history`（拒绝 + 无部分修改 + 清单可操作 +
拒绝后旧 run 仍不能覆盖）与 `test_unambiguous_history_migrates_and_keeps_generations_unique`
（无歧义路径仍正常迁移）。归档文件保持原样，作为问题基线不再修改。

## 4. 环境说明与一次已定位的假失败

- 浏览器套件在本机复跑时曾出现过与业务无关的失败（登录页显示"服务器内部错误"、科目下拉少于 2 项）。
  根因已定位为**本机 PostgreSQL 连接槽耗尽**：`FATAL: remaining connection slots are reserved for roles
  with the SUPERUSER attribute`（max_connections=100，开发服务 8000/5173 常年占用 40 条空闲连接）。
  清理后连续干净运行通过 36/36，[browser-acceptance.txt](browser-acceptance.txt) 是干净运行的结果。
  这不改变产品结论，但说明"本机一次失败"不等于"业务回归"，反之亦然。
- 演练与浏览器验收使用同一个独占 Redis 实例（6394），但分两次运行、期间各自 `FLUSHALL`，不并行。
- 本轮没有部署、没有读取或写出任何用户密钥、没有对业务库执行 migrate/审计改写。
- 真实 provider、真实隔夜（24 小时）等待、GitHub Actions 实际执行仍为**未验证**。
