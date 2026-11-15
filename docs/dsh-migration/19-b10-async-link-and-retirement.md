# 19. B10：DSH 异步链接线、Celery 退役执行与阶段 8 收口

> 状态：**已完成**（唯一未执行项是 D1/D2 的真实停机：本机没有可停的 Celery 节点、Redis 是用户原生服务且
> broker 里仍有 108 条在途消息、Docker daemon 不可达；见 §4。本轮**没有停任何用户服务、没有启动容器、
> 没有删除 Django 生产代码**）。
> 本文只写已验证的事实；未验证的能力不写成已完成。
>
> **B10 之后（B11）**：用户已就五项待决事项作出决定并已执行——broker 108 条消息丢弃、Django 保留对照、
> W3 修复、备份暂不调度、插件装入 desktop profile。见 [20-post-b10-decisions.md](./20-post-b10-decisions.md)。

## 1. 结论

1. **异步链已接线**（18 §4.5 F1/F2/F3）。插件在 HTTP surface 挂载后启动一个有界、可停止的 outbox worker
   （`startOutboxWorker`，250ms 一拍、每拍最多 10 条、不重叠、`stop()` 等当前拍结束），dispose 时先停 worker
   再关库。提交/判分/重判/会话结束入队的事件现在在真实运行中会被消费：**不再需要测试或人工调用 `drain`**。
   `plan.generated` 有了消费者（对齐 Django `learning.reconcile_plan`）；未知 topic 仍然永久失败（不静默确认）。
2. **F3 按「消费时映射 + D0 零在途门禁」处理，不改导入行**。`projection.rebuild_attempt_evidence` 等 Django
   拼写在消费时解析到本地 handler；`audit_outbox_event` 是归档表之一，**改写导入行会破坏对账的逐行摘要契约**，
   所以不这么做。切换前用 `scripts/d0-check.mjs` 强制 `unresolved_summary() == {}` 且没有未知 topic。
3. **F4 三个能力已补齐并有真实 Django 探针**：`projection.regrade_effects` 的证据重建、争议答案的
   `projection.rebuild_after_answer_change`（证据失效）、会话结束的 `learning.on_session_finished`
   （逐 attempt 重建证据 + 刷新状态）。顺带修掉一个此前未发现的真实缺口：Node 的手动结束会话**漏了**
   `revealed_at` 与 origin task 置 completed（Django `_finish_locked` 三件事只做了两件），也没有入队事件。
4. **退役执行做到「可逆优先」的边界**：D0 检查工具落地并用真实验收库证明（10/10 processed、`{}`、exit 0）；
   D1 没有可停对象（本机无 Celery 进程）；D2 **不能停**——Redis 是用户的 launchd 原生服务，且 db0 里还有
   **108 条 Celery 消息**（projection 58 + ingestion 50）没有消费者，原生 Redis **未开 AOF**，18 §4.3 的
   「AOF 可恢复」回滚假设在本机不成立。D1/D2 只做了**隔离演练**（`compose config` 校验 + `b10-drill`
   独立项目/卷/端口 override 校验），从未 `up`。
5. **全量浏览器验收已重跑**：worker 接线改变了运行时行为，按约定用隔离 `DSH_HOME` + 新夹具重跑
   main、archive、@stub 三组，逐条分类（数字见 §5）。
6. **B9 剩余边界能做的都做了**：规划器 weak 分支整体对齐（W1）与 `trigger_event` 空串（W2）用真实 Django
   探针证明 8 vs 8 候选、8 vs 8 任务、0 字段差异（改前 8 vs 1、56 处差异）；备份加了 `--include-media`、
   `--keep` 轮转与可选 HMAC 签名（26 条测试）。

## 2. F1/F2/F3：outbox worker 运行时接线

### 2.1 驱动（`src/jobs/worker.ts::startOutboxWorker`）

B9 的事实是：`runOnce`/`drain`/`runOnceAsync` 在 `src/` 内零调用点，只有测试导入。因此提交判分入队的
`evidence.rebuild_for_attempt` 在真实使用中永不消费，证据/状态投影不会更新。B10 新增运行时驱动：

| 属性 | 实现 | 为什么 |
|---|---|---|
| 有界 | 每拍一次 `runOnceAsync`，`limit` 默认 10 | 不用无界 `drain` 长时间占住事件循环；单条 AI 调用不会把整队拖死 |
| 不重叠 | 在飞时 `tick()` 返回同一个 Promise | 慢 handler 不会叠加拍数；定时器不会造出并发消费者 |
| 可停止 | `stop()` 清定时器并 `await` 在飞拍；幂等 | dispose 时先停 worker 再关库；关库不会与 handler 写库竞态 |
| 可注入时钟 | `now?: () => Instant`，每次 claim 时取 | 验收夹具与测试用同一时钟，重启不会把 `as_of`/`computed_at` 推到墙钟 |
| 立即一拍 | 启动即 `void tick()` | 进程重启时恢复 pending 行，不用等一个 interval |
| 诚实失败 | 每事件失败交给 outbox 重试预算；未知 topic 永久失败；库坏 → `onError` | 不让一个坏事件杀死宿主，也不把未做的事确认掉 |

`src/index.ts` 只在**成功挂载 HTTP surface 之后**启动它（没有 Web 端的主机不空转定时器），`ctx.effect`
的 disposer 先 `worker.stop()`，待其结束后再 `store.close()`。

### 2.2 `plan.generated`（F2）

`src/services/plan_reconcile.ts::reconcilePlan` 按 `planner.py::reconcile_plan` 移植：

1. `plan_id` 为空 → 仍执行 `reconcileDelayedTasks` 并返回 `plan_missing`（Django 的“无计划仍校正延迟任务”语义）；
2. 计划不存在 → `plan_missing`，**处理成功而不是永久失败**；
3. 同 user + plan_date 有更新 revision → `superseded=true`（写进 note）；
4. 重算延迟任务的 `not_before`，把 review 的 `not_before`/`delay_anchor_at` 写回 study task；
5. 往 `learning_study_plan.notes` 追加一条审计 note（含时刻、未开始任务数、顺延数、是否被取代）。

`plan.generated`（本移植的 topic）与 `learning.reconcile_plan`（Django 原名）共用一个 handler，
所以归档导入的 pending 行也能消费。

### 2.3 topic 映射（F3）与 D0 门禁

- `TOPIC_ALIASES`：`projection.rebuild_attempt_evidence` → `evidence.rebuild_for_attempt`（唯一改名）；
  其余 Django 拼写（`projection.regrade_effects`、`projection.rebuild_after_answer_change`、
  `learning.on_attempt_graded`、`learning.on_session_finished`、`learning.reconcile_plan`、
  `tutoring.run_job`）都有 handler 或明确的永久失败语义。
- `tutoring.run_job` 没有异步等价实现：DSH 在 `POST .../messages` 内联执行。handler 主动抛错并给出重跑路径，
  **不静默确认**。
- `knownTopics()` / `unknownTopics()` / `outboxHealth()` 与 `scripts/d0-check.mjs`：
  `unresolved` 按 status 聚合（与 Django `unresolved_summary()` 同口径），`unknown_topics` 是解析后仍无 handler
  的未确认 topic；`ok = 两者都空`；退出码 0/3/2。只读打开（`readOnly:true`），不建表、不改行、不 drain。
- **不清理导入行**：`audit_outbox_event` 被归档导出，`reconcileArchive` 比较逐表行数与逐行摘要；改写 topic 会让
  对账失去意义。因此选择「消费时映射」+「切换前 D0 零在途」两道闸门，而不是导入时重写。

### 2.4 验收夹具的时钟语义

`scripts/acceptance-fixture.ts` 在 seed 结束前用**同一个 `now`** 调 `drain`（生产同一份 handler），
并要求 `failed == 0`。否则浏览器验收服务器启动后 worker 会用墙钟处理 seed 留下的事件，把
`computed_at`/`as_of` 推后。最终夹具：**10 条事件、10 processed、0 failed**；`d0-check` →
`{"total":10,"processed":10,"unresolved":{},"unknown_topics":{},"ok":true}`。

### 2.5 测试（7 条，`tests/worker_lifecycle.test.ts`）

1. 提交后**不手动 drain**，证据 6 行 + 节点状态 `independent`，且 `as_of` 是注入的 `NOW`（不是墙钟）；
2. `stop()` 之后 `tick()` 返回空闲、入队事件保持 `pending`；
3. 未知 topic 永久失败、`unknownTopics` 点名、`outboxHealth.ok=false`；
4. 归档里的 Django topic 拼写被解析并消费，health 恢复 `ok`；
5. 真实 `generatePlan` 的 `plan.generated` 被消费并追加 note；不存在的 plan_id 处理成功（不永久失败）；
6. `asyncHandlers` 的 key 与 `ASYNC_TOPICS` 一致、所有 handler 都是 known；
7. `learning-states` 在 worker 产出状态后仍保留 Django 的平铺字段（F6 回归，见 §3.1）。

## 3. F4：三个缺失能力

| Django 能力 | Node 落点 | 语义 |
|---|---|---|
| `projection.regrade_effects` | worker handler：`rebuildEvidenceForAttempt` + `refreshStatesForAttempt` | 重判后先重建证据行，再按行重投影状态；本人实现是幂等的 |
| `projection.rebuild_after_answer_change` | `evidence_rebuild.ts::invalidateEvidenceForAnswerVersion` | 把命中该答案版本的 active 证据行置失效（`is_active=false`、`invalidated_at`、固定原因「答案版本进入争议」），**只失效、不重建/不刷状态**（Django task 就是这样） |
| `learning.on_session_finished` | `evidence_rebuild.ts::refreshSessionStates` | 逐 attempt `rebuild_for_attempt` + `refresh_states_for_attempt`，返回节点刷新累计数 |
| 争议入口 | `questions.ts::disputeAnswerKeyVersion` + `practice.ts::handleAnswerDispute` | 标记 disputed + 审计行 + 每个已判 attempt 新建 invalidation 评分事件（转人工、原始作答不动）+ 同事务 enqueue |
| 会话结束写路径 | `sessions.ts::finishLocked`（手动/过期共用） | status/finished_at、`revealed_at`（verification/mock_exam）、origin task completed、`session-finished:<id>` 去重入队；晚于 deadline 的手动结束按 deadline 记录 |

**真实 Django 探针**（`scripts/probe_b10_capabilities.py`，一次性 test DB，12 例，重跑逐字节一致）：

- 证据失效：6 行 active → `returned=6`、`active_after=0`、二次调用 0；
- 争议：2 个已判 attempt `affected=2`，每个由 1 条评分事件变 2 条；新事件
  `kind=invalidation/status=pending_review/revision=prev+1/confirmed_score=null/pending_max_score=previous.max_score`，
  parts 全部 `score=null/status=pending_review`，旧事件 `is_superseded=true`；重复争议只计数不新建；
- `reason` 截断 500（输入 613 字）、grade comment 截断 400；
- 去重键同秒 1 条、下一秒第 2 条；
- 会话结束：3 个 attempt → 6 证据行/attempt、`refresh_session_states` 返回 **3**、任务 completed、
  `revealed_at=finished_at`、事件 1 条；过期/晚交按 deadline、practice 不揭示。
- **Django 侧没有 dispute 的 HTTP 路由**（1 处定义 + 5 处集成测试调用、0 处生产调用），Node 同样只有
  service、没有自行造路由；作用域校验（answer→version→question→subject→project，越权 404）是适配层。

**顺手修掉的真实缺口（F5）**：Node 的 `finishSession` 原来只写 `status/finished_at`，既没有 `revealed_at`
也没把 origin task 置 completed，更没有事件；与 Django `_finish_locked` 不一致。B10 收敛为单一 `finishLocked`，
手动结束与过期结束共用，并有「晚交按 deadline」的测试。

### 3.1 接线暴露的第二个真实缺口（F6）：`learning-states` 的响应形状

worker 第一次真正产出 `learning_knowledge_state` 行之后，知识页（`KnowledgePage.tsx`）在“证据详情”
面板读取 `selectedState.missing_evidence` 时崩溃：B7/B8 的 `listStates` 只返回了 `detail` 嵌套对象，
而 Django `state.py::states_for_project` 把 `missing_evidence` / `independent_attempts` / `thresholds`
**平铺**在状态行上，还带 `subject_id` / `syllabus_is_user_provisional` / `rule_version`。此前状态表为空，
页面走的是“该考点还没有任何作答证据”的空分支，所以这个差异一直没被触发；worker 接线让它变成真实可见的
崩溃（浏览器验收 main 唯一一条失败）。

修复（`src/services/learning.ts`）：按 Django 的形状补齐平铺字段，并把 `as_of` 与证据行的 `computed_at`
从原始微秒整数改为 `formatPythonIso`（Django 返回 `isoformat()`）。新增回归测试
`tests/worker_lifecycle.test.ts::the knowledge-state read keeps Django's top-level shape after a rebuild`，
并保留 `detail` 供既有调用方使用。

## 4. Celery/Redis/Docker 退役执行（D0–D2）

### 4.1 D0：可执行前置检查（已落地）

```bash
cd dsh-plugin
npm run retire:d0 -- --data-root /path/to/.acepass                       # stdout JSON，exit 0/3
node --experimental-strip-types scripts/d0-check.mjs --db ... --out var/b10/d0.json
```

判据：`unresolved_summary() == {}` **且** 没有未知 topic。对验收 seed：`10/10 processed`、`{}`、`ok:true`、exit 0。
反例（全部在 `/tmp` 副本上）：pending 未知 topic → exit 3 + 点名；pending 别名 topic → unknown `{}` 但仍
unsafe（exit 3）；`failed` 行 → `{failed:1}` exit 3。只读性有测试（检查前后主库 sha256 不变）。

### 4.2 D1：停 Celery worker/beat —— 没有可执行对象

```
$ pgrep -fl celery
(空)
$ backend/.venv/bin/celery -A config inspect active --timeout 1
Error: No nodes replied within time constraint
```

本机没有 Celery 节点在跑，也没有 compose 项目在运行（daemon 不可达）。**实际停用：无。**
真正执行时的命令与回滚写进 `var/b10/retirement-notes.md` §2。

### 4.3 D2：停 Redis —— 不能执行（三个独立理由）

1. Redis 是用户的 **launchd 原生服务**（pid 2022），不是本项目的 compose 服务；本批次明令不得停用户服务。
2. broker **db0 还有 108 条 Celery 消息**（`projection` 58、`ingestion` 50）且没有消费者；停 broker 是
   把在途工作悬空，不是退役。
3. 原生 Redis **`appendonly no` / `aof_enabled:0`**，靠 RDB 快照。18 §4.3 D2 写的「AOF everysec，队列可恢复」
   只对 compose 里的 redis 成立，**对本机不成立**；停/重启可能直接丢这 108 条。

**B11 更新**：108 条孤儿消息已按用户授权丢弃（`var/b11/redis-discard.json`，db0 `dbsize=0`）；
D2 仍不执行，因为 Django 被保留为对照运行时。

**隔离演练做到了哪一步**：`docker compose -f infra/docker/docker-compose.yml config -q`（8 服务）通过；
在 `/tmp/b10-drill` 写独立 override（项目名 `b10-drill`、卷 `b10-drill-*`、postgres/redis `!reset []` 不发布
宿主端口、web 只绑 `127.0.0.1:18080/18443`），`config -q` 通过。**没有执行 `docker compose up`**；
`docker ps` 对两个项目都因 daemon 不可达失败。

### 4.4 残留检查

```
npm run retire:check   → 0 violation(s)（137 源文件 + 2 bundle + package.json，12 条规则）
```

`tests/retirement.test.ts` **24/24**（原 17 + D0 新增 7）。

## 5. 全量浏览器验收（worker 接线后）

在 worker 运行时重跑全部浏览器验收（隔离 `DSH_HOME`，`node scripts/acceptance-server.mjs --fresh`，端口 59218；
未触碰 `~/.dsh` 与 59117 的 GUI）。只改传输机制，`expect()` 断言未改。

| 套件 | 命令 | 结果 |
|---|---|---|
| main（desktop + mobile） | `npx playwright test -c playwright.dsh.config.ts --project=desktop --project=mobile --grep-invert @stub` | **78 passed / 0 failed**（30.0m：39 desktop + 39 mobile）|
| archive 反例 | `npx playwright test -c playwright.dsh.config.ts --project=archive` | **3 passed**（10.4s）|
| @stub | `… --grep @stub` | **8 failed**，全部 `intentional_divergence`（R-INV 4：DSH 不提供离线 stub provider）|

分类脚本 `node scripts/acceptance-report.mjs --main … --stub … --archive …` 输出：
`{"collected":89,"passed":81,"failed":8,"byClass":{"intentional_divergence":8}}`（`var/acceptance/b8-report.json`、`SUMMARY.md`）。

**首轮失败一条并已修**：desktop 的 “knowledge page loads states and evidence over 2xx”。根因就是 §3.1 的 F6
（`learning-states` 缺平铺字段），不是 worker 的时序问题；修复后单独复跑该用例通过，再从头 `--fresh` 全量重跑
得到上表结果。除此之外没有第二条失败，也没有用放宽断言的方式让它变绿。

夹具：`outbox {handled:10, failed:0}`、`d0-check` ok（10/10 processed）。


## 6. 剩余 parity/边界

### 6.1 W1：weak 分支（真实 Django oracle 证明）

改前（B9 代码，同一夹具）：Django 8 条 weak 候选 vs Node **1** 条，12 处字段差异；计划任务 8 vs 8 但
**56 处字段差异**（Node 多排了 7 条 `general_practice`）。根因不是“少了一个排序”，而是整条分支的选择集与
题目解析都不同：

- **选择集**：Django 只过滤 `needs_review=True`（`planner.py:265-269`），不是
  `needs_review OR summary in (...)`——后者是 `state.py::weak_nodes`，planner 零调用；
- **排序/上限**：`-needs_review, as_of`，`max(1, min(limit, 50))`；
- **题目解析 `_question_for_node`**：active pairing 优先，其次只试**一条** primary published 映射
  （`.first()`，不是“继续找下一条”）；
- **前置重排**：`unmet_prerequisites` → `prerequisite_first` + `gap.reason` + `unblocks:<name>[:120]` +
  `blocked_state_<summary>`；前置无题时回退到弱点本身并带 `prerequisite_missing_question` + `deficit_notice`；
- **去重**：一次生成内同一题只排一次；`evidence_ids[:10]`。

改后：**8 vs 8 候选、0 字段差异；8 vs 8 计划任务、0 差异；`trigger_event` 两侧都是 `''`；
`allocated_minutes` 42/42**。探针 `var/b10/parity-probe.json` 重跑逐字节一致（B10 时 sha256 `c460c16e…`；B11 为 W3 扩充夹具后为 `5f0f8c92…`，见 20 §4）。

### 6.2 W2：`trigger_event`

新建任务写 `trigger_event=''`（Django `_materialise_task` 不设置该列，模型默认空串）；`trigger_event` 列是
`TEXT NOT NULL` 无默认值，所以显式写空串。重用分支不动该列（测试钉住）。

### 6.3 备份扩展（`--include-media` / `--keep` / 签名）

- `--include-media`：媒体逐文件 `path/bytes/sha256` 进 manifest（`included:true`），恢复端显式
  `--restore-media`（默认不覆盖，覆盖先留存副本，应用后校验失败逐文件回滚，**先媒体后库**）；
  缺失根/符号链接/设备拒绝；缺失/同长度篡改/多余文件三种拒绝码。
- `--keep N`：只识别本工具产出的目录（`manifest.tool.name`），外来目录只列出不删，`keep>=1`，`--dry-run`。
- 可选 HMAC-SHA256：`--sign-key` / `ACEPASS_BACKUP_SIGNING_KEY`，签名覆盖除 `signature` 外的整份 manifest
  canonical JSON；有签名无密钥 → exit 4、错误密钥 → exit 3；密钥不进 manifest/日志/错误。
- `format_version` 保持 1（新增字段可选），B9 产物不改一个字仍可校验/恢复。
- 测试 12 → **26 条**；真实 CLI 演练（媒体 5 文件、`--keep 2` 依次删旧、签名三态、恢复后逐文件 sha256 一致）
  见 `var/b10/backup-notes.md` 与 `var/b10/backup-demo/`。**没有**新增常驻进程、没有安装 launchd/cron。

## 7. 验证数字

| 项 | 数字 |
|---|---|
| `npm run verify` | typecheck + build + **767 条测试**在系统 Node 24.22.2 与 DSH Electron Node 24.21 双跑全绿 + `load-smoke OK` |
| B9 基线 | 720 |
| B10 新增 | **47**：worker 生命周期 7（含 F6 形状回归）、F4 能力 9、备份 14、退役 D0 7、规划器 W1/W2 10 |
| 真实 Django 探针 | F4 **12 例**（服务级，一次性 test DB）；规划器 1 份对照（8 weak / 8 plan tasks，前后差异 12/56 处）|
| 黄金向量 | `tests/golden/b10_capabilities.json`（sha256 `6b5f3af8…`，Django 真实行生成）；`planner.json` 未变（`132775127cbe…`）|
| D0 | 验收 seed 10/10 processed、`{}`、exit 0；反例 3 类 exit 3 |
| 真实库对账（复跑，2026-11-07） | **59/59 表、5383 行、59/59 逐行摘要、13/13 统计全等**；`content sha256 f36e63a3…`（与 B9 相同）；`ok:true`，2.8s。B10 没有改 schema/归档格式，复跑确认没有漂移 |
| 退役残留 | 0 violation（137 源文件 + 2 bundle + package.json）|
| 浏览器验收 | main **78/78**、archive **3/3**、@stub **0/8**（8 条全为 R-INV 4 有意差异；分类脚本 `collected 89 / passed 81 / failed 8 / intentional_divergence 8`）|

## 8. 已知边界

1. **D0 只覆盖 SQLite outbox，不覆盖 broker**：DSH seed 干净 ≠ Django 侧没有在途工作。本机 db0 的 108 条
   消息就是反例；执行 D0/D1 时必须同时 `LLEN projection/ingestion == 0` + `celery inspect active` 为空。
2. **D1/D2 未真实执行**：本机无 Celery 节点、Redis 是用户服务且无 AOF、Docker daemon 不可达。隔离演练只证明
   compose 文件与 override 的合法性与隔离设计，不证明运行时行为。Django 生产代码未删除。
3. **`invalidate_for_answer_version` 只失效不重建/不刷状态**（Django task 语义）：争议后节点状态会保留到下一次
   刷新。照抄，不“顺手修好”。
4. **dispute 没有 HTTP 路由**（Django 也没有）：Node 只提供 service + outbox 入口；若将来要暴露，需要两侧同时决定。
5. **`effectiveDeadline` 仍只认已存 `exam_deadline`**：只有 `exam_started_at` 的历史行推不出时长（spec 时长推导
   未移植，既有边界）。
6. **归档导入的未知 topic**：保留行以便审计，消费时才会永久失败；D0 的零在途门禁是切换前提。`tutoring.run_job`
   计 known 但故意失败（无异步等价物）。
7. **规划器 `undiagnosed_candidates` 仍未对齐（W3，新发现）**：Django `planner.py:335-351` 把 UUID 集合与
   `str(mapping.node_id)` 比较，**永远为 False**，已有状态的考点也会被当“未诊断”；探针 informational 段
   Django 11 条 vs Node 0 条，且 Django 按 PostgreSQL/glibc 名称排序。这是 Django 侧缺陷，按“现状等价”复刻会
   改变现有行为，留给单独批次决策，本轮不猜。
8. **weak 的 `questionForNode`（undiagnosed 用）保持旧语义**；`is_demo` 排除是 Node 既有保护（Django
   `_eligible_question` 无 demo 检查），保留；`as_of` 全相等时 Django 无稳定序，Node 用 id 兜底。
9. **备份/媒体非原子快照**：先库后媒体，极端情况下可能出现“有行无文件”；媒体恢复只增/覆盖不删多余文件；
   恢复不是两段式事务（先媒体后库）；轮转按 created_at 不校验健康度；只支持对称 HMAC、无密钥轮换；
   调度只给 launchd/cron 示例，未安装。
10. **浏览器验收只改传输机制**：未改任何 `expect()` 断言；@stub 8 条仍是 R-INV 4 的有意差异。
11. **`d0-check` 的 `--out` 目录不存在时 exit 2**（已修）；D0 反例是单行注入，不覆盖真实导入批量行。

## 9. 复现命令

```bash
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
cd /Users/cololi/Documents/AcePass/dsh-plugin

# 全量验证（双运行时 + 加载烟测）
npm run verify

# worker 生命周期 / F4 / 规划器 / 备份 / 退役
node --test --experimental-strip-types tests/worker_lifecycle.test.ts
node --test --experimental-strip-types tests/b10_capabilities.test.ts
node --test --experimental-strip-types tests/planner_service.test.ts
node --test --experimental-strip-types tests/db_backup.test.ts
node --test --experimental-strip-types tests/retirement.test.ts

# 真实 Django 探针（本机 PostgreSQL；只建/删一次性 test 库）
../backend/.venv/bin/python scripts/probe_b10_capabilities.py
../backend/.venv/bin/python scripts/probe_b10_planner.py

# D0（隔离 seed）
node --experimental-strip-types scripts/acceptance-seed.mjs --data-root /tmp/b10-seed --quiet
node --experimental-strip-types scripts/d0-check.mjs --data-root /tmp/b10-seed

# 浏览器验收（隔离 DSH_HOME；59117 的 GUI 与 ~/.dsh 不动）
node scripts/acceptance-server.mjs --fresh
cd ../frontend
ACEPASS_RUN=b10-main ACEPASS_REPORT_JSON=../dsh-plugin/var/acceptance/b10-main-report.json \
  npx playwright test -c playwright.dsh.config.ts --project=desktop --project=mobile --grep-invert @stub

# 备份（含媒体/轮转/签名）
cd ../dsh-plugin
npm run db:backup -- --data-root /path/to/.acepass --include-media --keep 7 --sign-key /path/to/key
npm run db:verify -- --backup /path/to/backup --sign-key /path/to/key
npm run db:restore -- --backup /path/to/backup --data-root /path/to/.acepass --restore-media --force --sign-key /path/to/key
```
