# 走向 100%：P1 剩余与 P2 全量的新一轮计划

日期：2026-09-27。起点：`75386ea`（P1 第一批交付完成）。
**进度更新（2026-09-27）：批次 2（B04/B05/B06）、批次 3（B07/B08）、批次 4（C01/C04）与
批次 5（C03/C02）均已交付，`docs/05` §3 的 P1 条目 B01—B08 与 P2 的 C01—C04 全部关闭；
仅剩批次 6（C05 限时模拟考试、C06 报告未完成范围、C07 受限数学判分、C08 效果校准）。**
适用范围：`docs/04-implementation-plan.md` §4/§5 的 P1、P2 任务卡，以及
`docs/05-acceptance.md` §3 的 B01—B08、C01—C08 验收条目。

## 1. 起点状态（本轮开始时的真实状态）

| 范围 | 状态 | 依据 |
|---|---|---|
| P0（M0—M6） | 已完成并实测（含 P0.1/P0.2 全部修复轮） | `docs/11`—`docs/15`、`docs/implementation-status.md` |
| P1 第一批（B01/B02/B03） | 已交付：原生文字 PDF 导入、大纲词表与人工映射、真实周期统计 | `docs/16-p1-first-batch-delivery.md` |
| P1 剩余（B04—B08） | 未开始 | 本文档第 2 节 |
| P2（C01—C08） | 未开始 | 本文档第 3 节 |
| 真实 AI provider（讲解/图片识别） | **未验证**：调用已实际发起，被 provider 余额（HTTP 402）阻断 | `docs/16` §4 |
| 真实 ≥24 小时学习效果 | **未验证**：无真实经过时间的证据 | `docs/16` §5 |
| 远程部署 / GitHub Actions 实际执行 | **未验证**：没有授权目标，CI 未推送触发 | `README.md` §7 |

后端全量测试基线：**226 passed**（2026-09-27，`backend/.venv`，PostgreSQL 16 真实库）。

## 2. 批次划分

每个批次都以"可运行路径 + 真实执行的测试 + 交付记录 + 明确的未验证边界"为完成标准，
不批量生成空壳，也不把未运行的东西写成通过。

### 批次 2（本轮）：考点前置关系、标签候选、混合检索、FSRS 记忆卡

| 验收 | 交付内容 | 关键实现要点 | 完成条件 |
|---|---|---|---|
| B04（前半） | 考点前置关系 | `knowledge_relation` 有向边（同大纲、无自环、唯一约束）；加边前做环检测并返回环路径；停用不物理删除；计划器按前置关系重排补弱顺序并给出 `reason_codes` | 环被拒绝且图不变；缺口有题时先排前置考点，缺口无题时显式记录 `prerequisite_missing_question` 与说明，不静默替换 |
| B04（后半） | AI 标签候选 | 建议是惰性数据：校验只接受逐字来自本科目大纲的考点名；采纳写入**新的辅助标签映射修订**（权重 0，主权重仍合计 1），绝不创建/改名考点；无 provider 时明确 `ai_not_configured` | 未核对建议不改动受控词表；采纳后主权重合计仍为 1，旧修订原样保留；无法解析的名称进入 `unresolved_names` 并被拒绝 |
| B05 | 中文关键词 + 向量混合检索 | 中文单字+二元组分词、BM25 关键词通道、可配置嵌入 provider 的向量通道、RRF 融合；**权限/发布状态/封存过滤在打分之前**；无向量时显式降级为关键词并给出原因 | 固定金标集报告召回与错误；跨项目/未发布/撤回/保留家族即使相似度为 1.0 也不返回；结果不含答案与 rubric 文本 |
| B06 | FSRS 主动回忆卡 | 纯 Python FSRS-4.5 默认参数调度器（版本可追踪、纯函数、可注入时间）；记忆卡与复习日志分离，日志只追加；卡状态可由日志重放恢复；记忆卡**不**写入学习证据、**不**改变考点状态 | 复习日志重放与当前状态一致；参数/scheduler 版本落库；复习卡片后 `LearningEvidence` 与考点状态不变；到期卡进入当日计划并受全局预算约束 |

### 批次 3：诊断追问、手写转写确认、AI 估分、SSE —— **已交付（`docs/19`）**

| 验收 | 交付内容 | 完成条件 | 结果 |
|---|---|---|---|
| B07 | 诊断追问（`diagnose` 能力）、手写转写确认、AI rubric 逐点估分 | AI 估分只产生 `estimated_score`，人工确认前不进入正式总分；字迹不清必须先确认转写再诊断；失败路径不写分数与掌握状态 | **已交付**：转写门禁 409、人工录入路径（无模型时可用）、估分事件 inert、诊断只提受控原因；真实模型未验证 |
| B08 | 经校验的分段 SSE 与重连 | 断线重连不重复调用模型；只发送通过校验的片段；失效来源被拦截；未验证内容不外流 | **已交付**：真实 HTTP 流式读取、`?after=` 重连零成本（`/ai-runs` 计数不变）、失效来源只发 `error: stale_source` |

### 批次 4—6：P2（C01—C08）

| 批次 | 验收 | 交付内容 |
|---|---|---|
| 4 | C01、C04 | 扫描件/多栏/跨页/公式表格解析路由与逐类金标回归（无视觉模型时明确转人工，不假装识别成功）；"已校对/外部已见/已展示未提交"不得重新标为严格未见 |
| 5 | C03、C02 | 家族封存与污染检测（练习、检索、生成提示、导出、原页预览、缓存统一过滤，合并家族后旧暴露失效）；AI 生成变式的独立校验（条件完整、答案可验证、单选唯一、失败留候选、不进 `official_past` 统计） |
| 6 | C05—C08 | 限时模拟考试（服务端时钟、一次性交卷、无中途反馈）；受限数学判分插件（资源限制、白名单语法、无任意代码执行、不确定转人工）；效果评估与参数校准（可比性与样本数明示，不从单人前后分数推断因果） |

每个批次结束都更新 `docs/implementation-status.md`、`docs/acceptance-results.md` 与 `README.md`
的状态段，并新增一份交付记录（下一份为 `docs/18-p1-second-batch-delivery.md`）。

## 3. 验证方式（每批都要重复执行）

```bash
# 后端
cd backend && POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q
.venv/bin/ruff check apps ai domain config tests
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run

# 归档反例（文件未改，必须继续通过）
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p02-independent/test_*.py -c backend/pytest.ini --ds=p02_independent_settings -q \
  -k 'not generation_migration_cannot_promote'
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-final-independent" backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p02-final-independent/test_*.py -c backend/pytest.ini --ds=review_settings -q

# 隔离浏览器验收（独占库/Redis 6394/媒体目录/端口 + 真实 Worker）
bash scripts/dev/reset-p1-batch-browser.sh
cd frontend && playwright test --config playwright.acceptance.config.ts

# 真故障演练
ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 POSTGRES_DB=acepass_acceptance_p1_batch_drill \
  REDIS_URL=redis://127.0.0.1:6394/0 ACEPASS_OUTBOX_LEASE_SECONDS=5 \
  PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py
```

规则（不因进度压力放宽）：

1. 不为了通过而删除/弱化测试、关闭隔离或清空业务库；
2. 归档反例文件保持原样，失败就修实现或如实记录争议；
3. 没有真实凭据/真实时间就写"未验证"，stub 结果永远标记为 stub；
4. 每次浏览器运行使用全新库与空媒体目录，开发服务 8000/5173 不被触碰。

## 4. 外部阻塞项（保持"未验证"，不阻塞其余开发）

| 项目 | 阻塞原因 | 本计划的处理 |
|---|---|---|
| 真实 AI 讲解 / 图片识别 / 嵌入向量 | provider 账户余额 HTTP 402；`deepseek-chat` 亦无视觉模型 | 代码路径与降级路径全部实现并由 stub/注入 provider 验证；真实调用留待可用凭据后重跑 `scripts/verify_real_ai.py` |
| 真实 ≥24 小时学习效果 | 需要真实经过时间 | 只有可注入时钟的逻辑证据；计划中不出现"已验证提分" |
| 远程部署 | 没有授权的部署目标 | 只做本机 Compose/代理门槛验证 |
| GitHub Actions 实际执行 | CI 未推送触发 | 用同一脚本在本机执行并如实标注 |

## 5. "100% 开发完成"的判据

本项目按以下判据定义完成，而不是按主观感受：

1. `docs/04` §3—§5 的每一张任务卡与 `docs/05` §2—§3 的每一条验收（A01—A42、B01—B08、C01—C08）
   都有：代码实现、可复现命令、真实执行结果、证据路径，或明确的"外部阻塞 + 未验证"标注；
2. 后端全量测试、隔离浏览器套件、归档反例、真故障演练、干净副本发布门槛在每一批交付时都实际运行过；
3. 真实模型、真实时间、远程部署与 CI 的实际执行状态如实披露，不用 stub 或逻辑测试冒充；
4. UI 不出现未经计算的数据、不可用的按钮或把估分/自评当确定性证据的展示。

满足 1—4 即视为本项目开发完成；外部阻塞项在其条件具备后按同一脚本重跑即可补证，不改变已交付范围。
