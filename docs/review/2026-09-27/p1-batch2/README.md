# P1 第二批交付证据（起点 `75386ea`，功能提交 `ae173cc`，记录提交 `43ec753`）

主报告：[18 P1 第二批交付](../../../18-p1-second-batch-delivery.md)。
本目录只保存本轮实际执行输出；未执行的项不写成通过。运行环境：macOS 27.0 / Python 3.12.13 /
PostgreSQL 16.15 / Redis 8.10.2（确定性用例离线，浏览器与演练使用独占库与独占 Redis 实例）。

## 1. 文件清单

| 文件 | 实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 正式后端全套 **316 passed / 190.73s**（起点 226 + 本轮迁入 90：前置关系与标签候选 11、记忆卡计划 5、FSRS 19、记忆卡集成 15、分词 15、混合检索 25），真实 PostgreSQL |
| [browser-acceptance.txt](browser-acceptance.txt) | 隔离浏览器验收 **58 passed / 1.3m**（P0 36 + P1 第一批 12 + 本批 10；desktop+mobile，`ACEPASS_INLINE_TASKS=false`，真实 Worker） |
| [browser-acceptance-rerun.txt](browser-acceptance-rerun.txt) | 同一条命令复跑 **58 passed / 1.3m**（两次一致；首轮 3 条失败的原因是测试自身竞态与运行顺序，见主报告 §6） |
| [reviewer-eleven.txt](reviewer-eleven.txt) | 复验者原始后端反例（`p01-independent`，**文件未改**）**11 passed** |
| [archived-nine.txt](archived-nine.txt) | 上轮有效后端反例（`p02-independent`，**文件未改**）**9 passed, 1 deselected** |
| [reviewer-three.txt](reviewer-three.txt) | 复验者三条反例（`p02-final-independent`，**文件未改**）**3 passed** |
| [archived-browser.txt](archived-browser.txt) | 归档浏览器反例（`playwright.remaining.config.cjs`，**文件未改**）**2 passed** |
| [worker-drill.txt](worker-drill.txt)、[worker-drill.json](worker-drill.json) | 真故障演练 **ok=true**（真 `FLUSHALL` / 真 `SIGKILL` 命中处理中任务 / 同一 event 重复投递且旧消费者返回后仍 1 消息 1 曝光） |
| [search-gold.json](search-gold.json) | B05 固定金标集（8 条中文查询，期望用标签表达，重建数据库后仍可复现） |
| [search-eval.txt](search-eval.txt) | 金标集评测：**recall@5 = 1.000、recall@10 = 1.000、MRR = 1.000**，`--min-recall 0.8` 门槛 **passed=True**；向量通道 `available=False` 并给出中文原因 |
| [search-eval.json](search-eval.json) | 同一评测的 JSON（含通道状态、文档计数、逐条名次与阈值判定） |
| [search-eval-bad-gold.txt](search-eval-bad-gold.txt) | 反例：故意写错的标签 → 打印 `unresolved_label` 且 **exit 1**（金标文件不能静默忽略坏条目） |
| [clean-export-release-gate.txt](clean-export-release-gate.txt) | 仅提交内容导出的干净副本：代理组件与真实全栈 HTTPS/CSRF 登录两步 **exit 0**，既有配置哨兵保持不变 |

## 2. 复现命令

见主报告 §5（含每条命令的独占库 / Redis / 端口 / 媒体目录参数）。要点：

- 后端：`cd backend && POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q`
- 浏览器：`bash scripts/dev/reset-p1-batch2-browser.sh` 后在 `frontend/` 运行
  `playwright test --config playwright.acceptance.config.ts`（库 `acepass_acceptance_p1_batch2`、
  Redis 6395、API 8015、Vite 5185、空媒体目录、真实 Worker、`POSTGRES_CONN_MAX_AGE=0`）。
- 归档浏览器反例：**先由主套件建好夹具库**，再用 `POSTGRES_DB=acepass_acceptance_p1_batch2`
  指向同一个库运行 `playwright.remaining.config.cjs`（端口 8014/5184 是该 harness 的硬要求）。
- 检索金标集：`manage.py search_eval --project <项目A> --user acceptance@acepass.local --gold search-gold.json --k 5,10 --min-recall 0.8`。
- 真故障演练：演练库需先 `migrate` 与 `bootstrap_acceptance --allow <db>`；
  运行环境必须是 `ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub ACEPASS_INLINE_TASKS=false`
  （脚本拒绝在非 stub 或内联模式下把诊断性运行当作异步验收通过）。

## 3. 未验证项

- 真实嵌入模型调用与真实向量检索质量（无凭据；测试向量来自注入的确定性 provider）。
- 真实模型标签建议（文本模型凭据不可用，`is_stub` 语义保持诚实）。
- 真实 AI 讲解与图片识别（与 P1 第一批相同，保持未验证）。
- 真实间隔 ≥24 小时的学习效果（只有可注入时间的逻辑证据）。
- 远程部署与 GitHub Actions 实际执行（发布门槛只在提交内容的干净副本上本机执行）。
