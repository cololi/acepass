# `2c87e0c` → `7285991` 最后四组遗漏修复的证据

主报告：[15 最后四组遗漏修复](../../../15-p0-2-final-four-gaps-repair.md)。
任务输入：[DEEPSEEK_P0_2_FINAL_GAPS.md](../../../../DEEPSEEK_P0_2_FINAL_GAPS.md)、
问题基线：[14 最终独立复验](../../../14-p0-2-final-independent-review.md)。
复验者的原始反例与 shim 保存在
[p02-final-independent](../p02-final-independent/README.md)，**本轮没有修改其中任何文件**。

所有数字都是本轮实际执行结果；未执行的项（真实 provider、真实隔夜、GitHub Actions 实际运行）
保持未验证，未写成通过。业务库 `acepass` 未 migrate、未改写、未清理。

## 1. 文件清单

| 文件 | 实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 正式后端全套 **203 passed / 216.90s**（194 + 本轮迁入 9 条），真实 PostgreSQL，专用测试库 |
| [official-final-gaps.txt](official-final-gaps.txt) | 迁入正式套件的 C01/C02/C04/C05 回归 **9 passed** |
| [reviewer-three-after-fix.txt](reviewer-three-after-fix.txt) | 复验者三条原始反例（文件未改）原样 **3 passed** |
| [archived-nine-after-fix.txt](archived-nine-after-fix.txt) | 上轮有效反例（文件未改）**9 passed, 1 deselected**（deselect 的是已批准作废的旧迁移重编号用例） |
| [browser-acceptance.txt](browser-acceptance.txt) | 隔离浏览器验收 **36 passed / 48.3s**（desktop+mobile，真实 Worker，`ACEPASS_INLINE_TASKS=false`） |
| [archived-browser.txt](archived-browser.txt) | 归档浏览器反例（原文件未改）**2 passed / 3.6s** |
| [worker-drill.txt](worker-drill.txt)、[worker-drill.json](worker-drill.json) | 真故障演练 **ok=true**：真 `FLUSHALL` 恢复、真 `SIGKILL` 命中处理中任务后恢复、同一 event 重复投递 + 旧消费者返回后仍 1 消息/1 曝光 |
| [script-isolation.json](script-isolation.json) | 完整 fixture + Docker shim：全栈与组件两条路径都 preserves 既有配置、只用唯一项目名、只删自家镜像与自家容器/网络、失败码原样传递 |
| [check_script_isolation.py](check_script_isolation.py) | 上述证据的可运行入口（不接触真实 Docker） |
| [reviewer-shim-after-fix.json](reviewer-shim-after-fix.json) | 用**复验者未修改的** shim 重跑修复后的脚本：`existing_env_preserved=true`、`template_overwrote_existing_env=false`，compose 调用带唯一项目名与临时 env 文件 |
| [clean-export-release-gate.txt](clean-export-release-gate.txt) | 仅提交内容导出的干净副本：代理组件 exit 0、真实全栈 HTTPS/CSRF 登录 exit 0；哨兵/卷/网络/镜像/临时目录与开发服务检查 |
| [browser-outbox-state.txt](browser-outbox-state.txt) | 浏览器运行后的 outbox 状态与一次既有派发竞争观察（**范围外，未修改**，见报告 §7.1） |
| [browser-acceptance-concurrent-with-backend-suite.txt](browser-acceptance-concurrent-with-backend-suite.txt) | 与后端全套并发运行时浏览器套件的失败原始输出：3 条 `remaining connection slots are reserved`（共享开发库连接上限，报告 §7.2）；单独运行为 36 passed |

## 2. 复现入口

后端与迁入回归：

```bash
cd backend && .venv/bin/python -m pytest tests -q
.venv/bin/python -m pytest tests/integration/test_p0_2_final_gaps.py -q
```

复验者三条反例（专用测试库，`review_settings.py` 只改 TEST.NAME）：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-final-independent" \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-final-independent/test_*.py \
  -c backend/pytest.ini --ds=review_settings -q
```

归档 9 条有效反例：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-independent/test_*.py \
  -c backend/pytest.ini --ds=p02_independent_settings -q -k 'not generation_migration_cannot_promote'
```

脚本隔离（不需要 Docker）：

```bash
backend/.venv/bin/python docs/review/2026-09-27/p02-final-gaps/check_script_isolation.py   # C05 isolation evidence: ok
```

浏览器（独占库 `acepass_acceptance_*`、独占 Redis 6394、API 8014、Vite 5184、空媒体目录、真实 Worker；
另设 `POSTGRES_CONN_MAX_AGE=0` 以避免共享开发库的连接上限，见报告 §7.2）：

```bash
cd frontend && node_modules/.bin/playwright test --config playwright.acceptance.config.ts
cd .. && frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs
```

真故障演练（独占 Redis，脚本会 `FLUSHALL`，需显式确认；演练库需先 `migrate` 与 `bootstrap_acceptance`）：

```bash
ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 \
ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub ACEPASS_OUTBOX_LEASE_SECONDS=5 \
ACEPASS_WORKER_DRILL_REPORT=/tmp/acepass-drill-final-gaps.json \
PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py
```

干净副本发布门槛：

```bash
CLEAN=$(mktemp -d) && git archive HEAD | tar -x -C "$CLEAN"
cp -R frontend/dist "$CLEAN/frontend/dist"
printf 'TEST_EXISTING_CONFIGURATION=preserve-this-existing-deployment\n' > "$CLEAN/infra/docker/.env"
cd "$CLEAN" && bash scripts/verify_proxy.sh component   # exit 0
cd "$CLEAN" && bash scripts/verify_proxy.sh full-stack  # exit 0，真实登录 HTTP 200
```

## 3. 干净副本包含什么

`git archive HEAD` 只导出**提交内容**（396 个文件），其中第一次包含 `infra/docker/.env.example`。
`frontend/dist` 不入库（与 CI 一致：由 `frontend` 作业构建并作为 artifact 提供），因此这里复制的是
用提交中的前端源码在本机 `npx tsc -b && npx vite build` 产出的同一份产物（脚本资源哈希
`index-GequEHA5.js` 与组件检查中加载的一致）。`infra/docker/.env` 由本轮**人为放入哨兵**，
用于证明脚本既不读取也不覆盖既有配置。

## 4. 未验证项（保持未验证）

- 真实 AI provider（图片识别、按需讲解）质量与费用；C04 的 provider 是 stub。
- 真实间隔 ≥24 小时的 A/B/C 使用记录与真实学习效果。
- GitHub Actions 上的实际执行：CI 变更只在本机以同一脚本验证。
