# P1 第一批交付证据（起点 `5fff64e`，提交 `2776276`）

主报告：[16 P1 第一批交付](../../../16-p1-first-batch-delivery.md)。
本目录只保存本轮实际执行输出；未执行的项不写成通过。

## 1. 文件清单

| 文件 | 实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 正式后端全套 **226 passed / 101.10s**（203 + 本轮迁入 23 条 P1 回归），真实 PostgreSQL |
| [p1-regressions.txt](p1-regressions.txt) | 本轮 P1 三组回归 **23 passed**（PDF 导入 9、API 契约 7、大纲/周期 7） |
| [browser-acceptance.txt](browser-acceptance.txt) | 隔离浏览器验收 **48 passed / 1.1m**（P0 36 + P1 12；desktop+mobile，真实 Worker，`ACEPASS_INLINE_TASKS=false`） |
| [archived-browser.txt](archived-browser.txt) | 归档浏览器反例（原文件未改）**2 passed** |
| [archived-nine.txt](archived-nine.txt) | 上轮有效后端反例（原文件未改）**9 passed, 1 deselected** |
| [reviewer-three.txt](reviewer-three.txt) | 复验者三条反例（原文件未改）**3 passed** |
| [worker-drill.txt](worker-drill.txt)、[worker-drill.json](worker-drill.json) | 真故障演练 **ok=true**（真 FLUSHALL / 真 SIGKILL 命中处理中任务 / 同一 event 重复投递 + 旧消费者返回） |
| [clean-export-release-gate.txt](clean-export-release-gate.txt) | 仅提交内容导出的干净副本：代理组件 exit 0、真实全栈 HTTPS/CSRF 登录 exit 0，哨兵与资源隔离保持 |
| [real-ai-provider.txt](real-ai-provider.txt)、[real-ai-provider.json](real-ai-provider.json) | 真实 provider 调用**已实际发起**：api.deepseek.com 返回 HTTP 402 余额不足 → 真实讲解保持**未验证**；失败路径记录错误且不写分数/掌握结论 |

## 2. 复现命令

见主报告 §3。要点：

- 后端与 P1 回归：`cd backend && .venv/bin/python -m pytest tests -q`
- 浏览器（独占库 `acepass_acceptance_p1_batch`、Redis 6394、API 8014、Vite 5184、空媒体目录、真实 Worker）：
  先 `bash scripts/dev/reset-p1-batch-browser.sh`，再在 `frontend/` 下运行
  `node_modules/.bin/playwright test --config playwright.acceptance.config.ts`。
  验收进程另设 `POSTGRES_CONN_MAX_AGE=0`，避免共享开发库的连接上限造成假失败（见 P0.2 报告 §7.2）。
- 真故障演练：`ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 … scripts/verify_worker_e2e.py`（脚本会 FLUSHALL 独占 Redis）。
- 真实 AI：`scripts/verify_real_ai.py --email …`，凭据必须由环境注入（脚本拒绝 stub 与非专用库）。

## 3. 干净副本里有什么

`git archive HEAD` 只导出提交内容。`frontend/dist` 不入库（与 CI 一致，由 `frontend` 作业构建后作为 artifact 提供），
因此复制的是用提交中的前端源码在本机 `npx tsc -b && npx vite build` 产出的同一份产物（组件检查加载的脚本哈希
`index-yR2A03UU.js` 与该构建一致）。`infra/docker/.env` 由本轮人为放入哨兵，用于证明脚本既不读取也不覆盖既有配置。
`backend/requirements/lock.txt` 已包含本轮新增的 `pypdf==5.1.0`（镜像内 `pip install -r lock.txt` 因此可复现）。

## 4. 未验证项

真实 AI 讲解（provider 余额不足）、真实图片识别（无视觉模型凭据）、真实 ≥24 小时间隔、GitHub Actions 实际执行。
