# 17. B8：阶段 3 剩余操作、页面缺口与验收收口

> 状态：**已完成**。main 78/78、archive 3/3；@stub 8 条按 R-INV 4 保持诚实失败（`intentional_divergence`）。
> 本文件只写已验证的事实；未验证的能力不写成已完成。

## 1. 范围

阶段 6 的出口判据仍是「Web 客户端 12 页 + SSE→Remote stream，浏览器验收套件（main 78 + stub 8 + 归档反例 2）
迁移后通过」。B7 交付了传输层与 13 个路由页，但 main 只有 31/78：失败的主体是阶段 3 白名单上**尚未移植的服务**
（揭示、草稿、评分确认、队列、AI 读面、知识域、学习读接口），而不是页面或传输。

B8 按「对验收的影响」排序补齐这些服务与路由，并把验收跑到可收口：

1. 揭示（最高优先）：`POST /session-items/{id}/reveal`、`POST /attempts/{id}/reveal`——五题型主证据链要在提交前
   读到 `answer_payload` 才能选正确答案；验证进行中必须 403 `purpose_not_allowed`。
2. 草稿与评分确认/队列：`PUT /session-items/{id}/draft`、`POST /attempts/{id}/confirm-grade`、`GET /grading-queue`，
   以及提交时接受 `asset_ids`（照片作答）。
3. AI 读面：`GET /projects/{id}/ai-status`、`GET /projects/{id}/ai-runs`；无模型时明示 `ai_not_configured`。
4. 知识域：模板、配对（`pairing.py::on_attempt_graded` + `_create_task` + 延迟任务重排）、知识地图、关系、先修、
   标签建议。
5. 学习读接口：今日计划、复习任务、学习任务、记忆卡、检索/重建索引、暴露台账、外部已见、转写、AI 估分/诊断、追问。
6. 辅导流：`tutor.stream` 接真实生产者，替换 `service_not_migrated` 终态。
7. 验收收口：`acceptance-server.mjs --fresh` + 更新后的夹具重跑 main 78 + @stub 8 + archive 3，逐条分类。

## 2. 交付

### 2.1 新增/改动的路由（55 条 + 1 个流操作）

全部走既有传输契约（`POST /api/acepass/rpc` 信封 + `GET /api/acepass/stream`），没有第二套业务逻辑。

| 域 | 路由 | 文件 |
|---|---|---|
| 实践写路径 | `POST /session-items/:id/reveal`、`POST /attempts/:id/reveal`、`PUT /session-items/:id/draft`、`POST /attempts/:id/confirm-grade`、`GET /grading-queue` | `src/http/study_routes.ts` |
| 实践提交 | `POST /session-items/:id/submit` 接受 `asset_ids`（≤6 张、≤30 MB、项目/所有者归属），写入 `attempt.attachments` | 同上 |
| 知识域 | `GET/POST question-templates`、`GET/POST verification-pairings` + `GET /{id}`、`GET knowledge-map`、`GET/POST knowledge-relations` + `DELETE /{id}`、`GET knowledge-nodes/:id/prerequisites`、`GET/POST question-versions/:id/tag-suggestions` + `accept`/`reject`（14 条） | `src/http/knowledge_extra_routes.ts` |
| 学习读接口 | `GET /study-plans/today`、`GET review-tasks`、`GET/POST study-tasks/:id/start|defer|skip|complete`、`POST reconcile-delay`、`GET questions/:id/exposure`、`POST questions/:id/external-seen`（10 条） | `src/http/learning_extra_routes.ts` |
| 记忆卡 | `GET/POST memory-cards`、`POST review`、`GET logs`、`POST rebuild|suspend|resume`（7 条） | `src/http/memory_routes.ts` |
| 检索 | `GET /search`、`POST /search/reindex`（2 条） | `src/http/search_routes.ts` |
| 辅导/AI 读面 | `GET ai-status`、`GET ai-runs`、`POST/GET tutor-sessions`、`POST tutor-sessions/:id/messages`、`GET tutor-jobs/:id`、`GET tutor-jobs/:id/segments`（7 条） | `src/http/tutor_routes.ts` |
| 实践 AI | `GET/POST attempt transcriptions`、`POST transcriptions/:id/confirm|reject`、`POST/GET ai-estimate`、`POST ai-diagnosis|diagnosis`、`POST diagnosis-follow-ups/:id/answer|skip`（10 条） | `src/http/practice_ai_routes.ts` |
| 流 | `GET /api/acepass/stream?op=tutor.stream&project_id=&job_id=&after=`（真实生产者，只读已验证分段，不重复调模型） | `src/http/tutor_stream.ts` |

### 2.2 服务层（按 Django 逐字移植）

- `src/services/sessions.ts`：`presentItem` 补齐 Django `presentation()` 的 19 个字段（draft/draft_revision/assets/
  tutoring_allowed/grading_hidden/exam_started_at/exam_deadline/expired_at/ordinal/purpose/server_time）；
  `saveDraft`（乐观锁 409、已提交/已结束拒绝）、`revealPayload`、`assertRevealAllowed`、`recordRevealExposure`、
  `reconcileItemSession`；`createSession` 支持 `task_id`（按 `task_kind` 固定模式、复核延迟间隔、标记任务 in_progress、
  写 `origin_task_id`）。
- `src/services/practice.ts`：`confirmGrade`（rubric 逐点、pending parts、revision/答案版本冲突、门禁、内容修订审计）、
  `validateAttachments`；提交与确认都在同一事务内调用 `onAttemptGraded`（Django 的 outbox 事件等价）。
- `src/services/learning.ts`：`getAttempt` 改为 Django 字段（`attempt_id`/`attachments`/`receipt_only`）并加读取门禁；
  `assertGradingNotBlocked`、`assertItemNotInActiveVerification`。
- 知识域：`pairing.ts`（A→B→C、延迟锚点重算、任务重排、不可交付题失效）、`knowledge_extra.ts`（模板/配对/地图/
  关系环检测/先修）、`tag_suggestions.ts`（无模型 503、候选只读、人工决定）。
- 学习读：`learning_extra.ts`（今日计划/复习任务/学习任务/间隔复核）、`memory.ts`（FSRS 排期与台账）、
  `search.ts`（分词/BM25/RRF/索引门禁）、`exposure.ts`（暴露台账读+外部已见写）。
- 辅导与 AI：`tutoring.ts`（会话/任务/分段/门禁）、`transcription.ts`、`estimation.ts`、`diagnosis.ts`。

### 2.3 夹具（`scripts/acceptance-fixture.ts`）

补上 Django `bootstrap_acceptance._seed_delayed_verification` 的等价链，全程走真实服务：
`createVerificationPairing` → A 会话（present/submit，时间戳回拨 30h）→ `onAttemptGraded` 生成 B →
B 会话（present/submit，30 分钟前）→ `onAttemptGraded` 生成 C 与 `learning_review_task` → 把 C 的
`not_before`/`due_at` 与 ReviewTask 的 `not_before` 挪到 1 分钟前。summary 不再有 `skipped`，
`delayed_verification_tasks: 2`。

## 3. 对拍与验证方法

每条新服务行为都按既有规则交付：

1. **真实 Django 探针**（`scripts/probe_b8_*.py`，一次性 PostgreSQL 测试库，记录状态/响应/行数增量）：
   - `17-b8-practice-probe.json`：27 例（presentation 19 字段、两种 reveal、验证门禁 403、草稿 409/400、
     附件归属 404、confirm-grade 8/10、幂等重放、队列排除活动验证、越权 404）。
   - `17-b8-learning-probe.json`：57 例（PLAN 5 / TASKS 15 / MEMORY 16 / SEARCH 13 / EXPOSURE 8），连跑两次逐字节一致。
   - `17-b8-knowledge-probe.json`、`17-b8-tutor-probe.json`：见对应文件（知识域与辅导/转写）。
2. **黄金向量**（真实行 + 真实 Django 函数，重跑逐字节一致）：`tests/golden/b8_learning.json`
   （tokenizer/索引语料/BM25/RRF/excerpt/FSRS）以及知识域、辅导的向量文件。
3. **HTTP/Remote 黑盒**：`tests/b8_*.test.ts` 用 `createFetchHandler` 直接驱动 `Request`→`Response`，
   成功/越权/门禁/幂等/冲突各至少一条；`tests/b8_practice_writes.test.ts` 另有一条**跨实现形状比对**：
   读入真实 Django 探针的响应，逐层比较键集合与值类型，防止「移植时静默少一个客户端要读的字段」。
4. **真实浏览器**：`frontend/tests/dsh`（只改传输机制，`expect()` 断言逐文件不变）+ 归档反例。
5. **双运行时**：`npm run verify` = typecheck → build → 系统 Node 24.22.2 与 DSH Electron Node 24.21 双跑 →
   真实 Cordis 加载烟测。

## 4. 关键对拍发现（新发现从 04 §P 起编号）

- **`presentation` 少 11 个字段**（B7 遗留）：草稿、附件资产、辅导门禁、考试时钟全部丢失，照片草稿刷新后消失。
  已按 Django 19 字段补齐，并用探针响应做形状比对。
- **`get_attempt` 字段名与门禁**：Django 是 `attempt_id` + `attachments` + `receipt_only`，且读取时同样过内容门禁；
  移植版曾返回 `id` 且无门禁。刷新后的「查看答案」因此走不到稳定 attempts 路由。
- **`confirm-grade` 的响应形状在 Django 内部不一致**：首次返回 grade payload 本体，幂等重放却包成 `{grade:…}`。
  按实测复刻两种形状（04 §P1）。
- **提交附件**：B7 明确拒绝 `asset_ids`（422），Django 实际支持（≤6 张 / ≤30 MB / 项目归属）。照片作答与评分页
  的原始工作依赖它。
- **`study-plans/today/generate` 返回 `TodayPlanOut`**（plan/tasks/notes/backlog/progress_notes），不是 plan 行；
  今日页读 `plan.daily_budget_minutes`，返回裸行会得到 undefined。
- **验收 harness 的 same-document 导航**：DSH 的面板路由是 hash，`page.goto` 到同一路由不会重建页面组件，
  而 Django 是整页加载。harness 在同路由导航后强制 reload（只改传输机制，不改断言）。
- **配对触发点**：Django 走 outbox（`learning.on_attempt_graded`）；Node 没有该 topic，改为 submit/confirm 的
  同一事务内同步调用（幂等，失败回滚），不引入「已判分但没生成 B 任务」的中间态。

## 5. 验证数字

### 5.1 单元/契约测试

| 批次 | 测试条数 | 说明 |
|---|---|---|
| B7 基线 | 602 | 双运行时全绿 |
| B8 新增 | **79** | 实践写路径 10、知识域 16、学习读 17、辅导/AI 36（含 3 条黄金向量比对、1 条跨实现形状比对） |
| 合计 | **681** | 系统 Node 24.22.2 与 DSH Electron Node 24.21 双跑全绿 |

`tests/b8_practice_writes.test.ts` 的「projections keep the exact field shape Django published」读入真实 Django 探针的
响应，对 presentation / reveal / attempt detail / grading-queue row / confirm-grade / 错误信封逐层比较键集合与值类型
（`request_id` 是已记录的传输差异，比较时忽略）。

### 5.2 真实 Django 探针

| 探针 | 用例数 | 文件 |
|---|---|---|
| practice | 27 | [17-b8-practice-probe.json](./17-b8-practice-probe.json) |
| learning | 57 | [17-b8-learning-probe.json](./17-b8-learning-probe.json) |
| knowledge | 49 | [17-b8-knowledge-probe.json](./17-b8-knowledge-probe.json) |
| tutor/AI | 43 | [17-b8-tutor-probe.json](./17-b8-tutor-probe.json) |

黄金向量（真实行 + 真实 Django 函数；本轮重跑三份文件 sha256 全部不变）：

| 文件 | sha256（前 12 位） |
|---|---|
| `tests/golden/b8_learning.json` | `b40bb962572b` |
| `tests/golden/b8_knowledge.json` | `24c1400124b3` |
| `tests/golden/b8_tutor.json` | `4729b1e539ab` |

### 5.3 浏览器验收（隔离实例 + 新夹具）

| run | collected | passed | failed |
|---|---|---|---|
| main | 78 | **78** | 0 |
| @stub | 8 | 0（有意差异：无 stub provider，R-INV 4） | 8 |
| archive | 3 | **3** | 0 |

89 条收集，81 条通过；**失败只剩 8 条 @stub，全部归类 `intentional_divergence`**。`unmigrated_stage3_endpoint`
与 `transport_client_defect` 均为 **0**。逐条结果见 [b8-report.json](../../dsh-plugin/var/acceptance/b8-report.json) 与
[SUMMARY.md](../../dsh-plugin/var/acceptance/SUMMARY.md)。

夹具：3 个项目、5 个科目、28 个已发布版本（单选 12 / 多选 4 / 判断 4 / 填空 4 / 大题 4）、周期统计科目
（2019–2023 完整 + 2024 不完整 + 演示卷）、**延迟验证任务 2 条（`skipped: []`）**。

### 5.4 双运行时

`npm run verify`：**通过**——typecheck → build → 681 条测试在系统 Node 24.22.2 与 DSH Electron Node 24.21
双运行时全绿 → 真实 Cordis + `dsh-tools` 加载烟测通过（`acepass` 工具注册并执行）。

## 6. 已知边界

1. **无 stub provider**（R-INV 4）：@stub 8 条在 DSH 侧只能得到诚实的 `ai_not_configured`，归类为有意差异，
   不为了变绿加 stub。
2. **向量通道不运行**：DSH 不暴露 embed 端点，`channels.vector.available=false`、`code=vector_not_configured`、
   `embeddings` 恒 0；检索只走关键词/混合降级。
3. **`Idempotency-Key` 缺失的响应不一致**：Django 的 `idempotency_key()` 返回 409 `idempotency_conflict`；
   B3–B7 既有路由（`study_routes.ts::effect()`）返回 400 `invalid_input` 且已被测试钉住。B8 新路由按 Django 的 409，
   旧路由不改（改动会破坏既有契约测试与验收）；记录在 04 §P。
4. **`study-tasks/{id}/start` 的失效写入**：Django 先写 invalidated 再抛 400；Node 的 claim 与副作用同事务，
   改为事务外补写失效（最终库状态一致，同键重试会重新校验而不是 409 in-flight）。
5. **规划器 `reason_codes` 追加语义未对齐**：Django 对已存在任务追加候选 reason_codes，移植版保留原值（不影响验收）。
6. **`review-tasks` 无 `limit`**：Django 只有 `subject_id`/`only_due`；任务书里的 limit 在 Django 侧不存在。
7. **流游标语义**：宿主 `seq` 与客户端 `after`（段索引）不是同一空间（段索引 i 映射为 seq=i+2），
   恢复时最坏重发游标前 2 段，客户端按 index 去重后不丢段；跨物理重连与 uplink 仍不具备（16 §6.2）。
8. **Django 特有行为**（记录不改断言）：`confirm-grade` 两种响应形状；@stub 的诚实失败；`/auth/*` 不移植。
9. **验收 harness 的两处预算调整**（只影响 harness，不改断言）：同路由 `page.goto` 后强制整页 reload（恢复 Django 的
   整页加载语义）；per-test 超时 90s → 180s（DSH 面板每次导航要重新挂载，mobile 项目两次 reload 会超过 90s）。
10. **配对/锚点规则有两份实现**：`learning_extra.ts::delayedIntervalStatus` 与 `pairing.ts::delayedIntervalStatus`
   各一份（文案格式一个用 `toFixed(2)`、一个用 `pyFormatFixed`）。两侧都有测试与探针，但应合并为单处；列入 B9 清账。
11. **`pairing.on_explanation_delivered` 未移植**：Django 在辅导讲解交付时也触发 B 任务；本批只接了「判分」触发点
   （验收不依赖讲解触发）。列入 B9 清账。
12. **知识域标签建议的模型路径**：探针里用进程内 scripted 替身（`is_stub=true`）验证「只产候选、人工决定」，产物与
   运行时不启用 stub（R-INV 4）。

## 7. 下一批（B9）

若阶段 6 在 B8 收口后达标：进入阶段 7 的数据迁移与退役（备份/恢复命令、Celery/Redis/Docker 的实际退役、
真实库全量对账的复跑）。若仍有失败：按 `b8-report.json` 的分类继续，优先 `transport_client_defect`。
