# P1 第三批交付证据（起点 `44a0c6c`）

主报告：[19 P1 第三批交付](../../../19-p1-third-batch-delivery.md)。
本目录只保存本轮实际执行输出；未执行的项不写成通过。环境：macOS 27.0 / Python 3.12.13 /
PostgreSQL 16.15 / Redis 8.10.2（浏览器与演练使用独占库 ""acepass_acceptance_p1_batch3"" 与独占 Redis 6396）。

## 1. 文件清单

| 文件 | 实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 正式后端全套 **340 passed / 94.18s**（起点 316 + 本轮迁入 24：转写/估分/诊断 13、SSE 11） |
| [browser-acceptance.txt](browser-acceptance.txt) | 隔离浏览器主套件（无 provider 环境）**62 passed / 1.3m**：P0 36 + 批次 1 的 12 + 批次 2 的 10 + 本批 4（转写门禁与人工录入、流式面板的诚实失败路径） |
| [browser-acceptance-stub.txt](browser-acceptance-stub.txt) | 隔离浏览器 stub 专跑（`ACEPASS_AI_PROVIDER=stub ACEPASS_RUNTIME_MODE=demo`，`--grep "@stub"`）**6 passed / 16.1s**：stub 转写标注与确认、估分保持 inert、诊断追问、SSE 分段与零成本重连 |
| [reviewer-eleven.txt](reviewer-eleven.txt) | 复验者原始后端反例（`p01-independent`，文件未改）**11 passed** |
| [archived-nine.txt](archived-nine.txt) | 上轮有效后端反例（`p02-independent`，文件未改）**9 passed, 1 deselected** |
| [reviewer-three.txt](reviewer-three.txt) | 复验者三条反例（`p02-final-independent`，文件未改）**3 passed** |
| [archived-browser.txt](archived-browser.txt) | 归档浏览器反例（未改）**2 passed** |
| [worker-drill.txt](worker-drill.txt)、[worker-drill.json](worker-drill.json) | 真故障演练 **ok=true**（真 `FLUSHALL` / 真 `SIGKILL` / 重复投递 + 旧消费者返回） |
| [clean-export-release-gate.txt](clean-export-release-gate.txt) | 仅提交内容导出的干净副本：代理组件与真实全栈 HTTPS/CSRF 登录两步 exit 0，既有配置哨兵保持不变 |

## 2. 复现命令

见主报告 §5。要点：

- 浏览器需要**两次运行**：主套件在无 provider 环境（`--grep-invert "@stub"`），stub 专跑显式
  `ACEPASS_AI_PROVIDER=stub ACEPASS_RUNTIME_MODE=demo`（`--grep "@stub"`）。两次之间必须
  `bash scripts/dev/reset-p1-batch3-browser.sh`（新库 + 空媒体目录）。
- 归档浏览器反例没有自己的 globalSetup：先用主套件建好夹具库，再指向同一个库运行。
- 真故障演练需要 ACEPASS_RUNTIME_MODE=test + ACEPASS_AI_PROVIDER=stub + ACEPASS_INLINE_TASKS=false，
  且演练库需先 `migrate` + `bootstrap_acceptance --allow <db>`。

## 3. 未验证项

- 真实视觉模型转写、真实文本模型逐点估分与诊断（本机无可用凭据；stub 只证明流程与标注诚实）。
- 真实 AI 讲解/图片识别（A36）、真实嵌入向量检索（B05）、真实 ≥24 小时学习效果。
- 远程部署与 GitHub Actions 实际执行（发布门槛只在提交内容的干净副本上本机执行）。
- 真实多进程 Worker 下的飞行中 SSE 轮询、并发重连与 finalize 事务竞争。
