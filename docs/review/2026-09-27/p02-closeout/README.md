# P0.2 收尾验证资产

基线 `f809365`。主报告：[11 P0.2 收尾验证报告](../../../11-p0-2-closeout-verification.md)。
本目录保存本轮**实际运行输出**，与上一层 P0.1 复验资产
[../p01-independent/](../p01-independent/README.md)（问题基线，未改动）分开。

| 资产 | 内容与结果 |
|---|---|
| [acceptance-suite.txt](acceptance-suite.txt) | 新版浏览器验收（隔离库/Redis/媒体/端口 + 真实 Worker）完整输出：**36 passed** |
| [archived-counter-examples.txt](archived-counter-examples.txt) | 复验者归档浏览器反例按 `playwright.remaining.config.cjs` 原样重跑：**2 passed** |
| [original-browser-suite.txt](original-browser-suite.txt) | 原浏览器套件（独立库/端口 + Worker）：**16 passed** |
| [worker-drill-real-faults.txt](worker-drill-real-faults.txt) | 真实故障注入脚本输出：真 `SIGKILL` 进程组、真 Redis `FLUSHALL`、两个消费者，`ok: true` |
| [worker-drill-report.json](worker-drill-report.json) | 同上，机器可读的逐步报告（每步 `real: true`） |
| [infra-and-release-gates.txt](infra-and-release-gates.txt) | `docker compose config`、nginx 模板渲染与 `nginx -t`、明文 301 目标端口实测、TLS 入口 200 |
| [restore-gate-real-commands.txt](restore-gate-real-commands.txt) | 不可连数据库的恢复 dry-run 退出 1；正常备份 dry-run 退出 0 |

后端数字（`backend/.venv/bin/python -m pytest tests -q` → **177 passed**）与复验者原始后端反例
（`docs/review/2026-09-27/p01-independent`，未修改 → **11 passed**）在主报告 §2.1 记录；两者都是
本轮实际执行的命令。

## 未在本目录中的证据（保持“未验证”）

- 真实 AI provider（无凭据）、真实间隔 24 小时的延迟验证体验、真实学习效果。
- Compose 全栈（api/worker/postgres/redis）本轮没有整体启动；只独立验证了 nginx 代理与发布门槛。
- GitHub Actions 上的真实 workflow 执行；本轮按 workflow 的同一命令在本机执行并记录。
