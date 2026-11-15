# 27. M1 记忆驱动交互学习：交付与验证

> 状态：**已交付（2026-11-14，工作树起点 `7b41d19`）**。设计与规格见
> [26 交互学习逻辑重新设计](26-memory-interaction-redesign.md)；本文件只写**实际做了什么、
> 跑了什么、得到什么结果**。未运行或未验证的部分集中在 §8，不写成已完成。

## 1. 一句话

把「今日计划 + 刷题工作台 + 题目级记忆卡」的主线换成**考点级记忆驱动的学习会话**：
每个考点有 ①考频画像（真实试卷，样本不足就拒绝排名）②核心内容卡（模型只能出草稿，
人工确认后才作为回忆基准）③FSRS 记忆状态（只由确认后的回忆事件更新）④既有解题能力证据。
一次学习会话由确定性编排产生「唤回 → 编码 → 练习 → 修复 → 迁移」步骤；模型只作为受控的
「学习教练」参与回忆检查、提示、错因追问与收束反思，**永不写分数、掌握、证据或计划**。

## 2. 交付内容

| 能力 | 落点 | 关键事实 |
|---|---|---|
| 考点级 FSRS 记忆 | `memory_node_state` + `memory_recall_event`；`src/services/node_memory.ts` | 台账追加式、可按事件重放；同一 10 分钟内重复回忆照记但不更新调度；提前复习封顶 `hard`；目标保持率由考频价值在创建时确定并固定 |
| 考频画像 | `src/services/node_frequency.ts` + `src/domain/knowledge_value.ts` | 可计数周期沿用 `cycles.ts` 口径；`value_index` 是排序分值不是概率；完整周期 <2 不排名，趋势 <3 周期不给，演示/模拟/未确认覆盖不进分子分母 |
| 考点内容卡 | `knowledge_node_card`；`src/services/node_cards.ts` | 追加版本、唯一当前版本；只有 `confirmed` 卡可作回忆核对基准；模型草稿必须关联审计运行记录且必须人工确认 |
| 学习会话引擎 | `learning_interaction_session` + `learning_session_step`；`src/services/interaction.ts` | 确定性编排、原因码、预算与欠配说明；练习复用既有 practice 会话/判分/证据；答错自动追加修复讲解 + 同考点另题再测 |
| 节点级模型教练 | `tutoring_coach_turn`；`src/ai/coach_prompts.ts`、`src/ai/coach_validators.ts`、`src/services/coach.ts` | 6 个受控用途；只接受 JSON、引用白名单、关键点白名单、提示级上限；任何校验问题整条拒绝且不展示；写入 `audit_llm_run`（label `memory_coach`）；答案级提示写暴露事件 |
| HTTP 面 | `src/http/studyflow_routes.ts` + `src/http/routes.ts` | 23 条路由；写操作 `Idempotency-Key`；同步效果与 claim 同事务，模型调用走「先提交 claim → await → 提交结果 → 异常释放」 |
| 客户端 | `src/client/app/features/study/*`、`api/study.ts`、`AppShell.tsx`、`app.css` | 新增 `/study`、`/study/sessions/:id`、`/study/nodes/:id`；导航加「学习」，旧「今日计划」保留；所有选择器仍在 `.acepass-root` 下 |
| schema | Django 模型 6 张表 + `apps/interaction` 新 app + 生成器 | `schema.generated.ts` 从 Django 重新生成；`SCHEMA_VERSION 1 → 2`；既有数据库靠 `CREATE TABLE IF NOT EXISTS` 增量建表 |

## 3. 关键规则（实现里不可退让的部分）

1. **模型不写状态。** `runCoachTurn` 只写 `audit_llm_run` 与 `tutoring_coach_turn`（成功时
   另写答案暴露事件）；测试用行数断言证明 `practice_grade_event` / `practice_learning_evidence` /
   `learning_knowledge_state` / `memory_node_state` 不因一次教练调用改变。
2. **记忆 ≠ 能力。** 回忆事件只写 `memory_recall_event` + 更新 `memory_node_state`；练习只走既有
   `LearningEvidence`。前端文案与接口命名都分开（「记忆 R」与「解题能力」）。
3. **间隔诚实。** `isSpaced` 以 10 分钟为界：窗口内重复回忆写事件但 `memory_updated=false`；
   未到期提前复习评级最多 `hard`。
4. **考频诚实。** 只统计 `official_past` 且非演示、有效版本已确认且覆盖完整的周期；完整周期
   少于 2 个时 `value_index=null` 且不排名；少于 3 个数据周期不给趋势；每份被排除的试卷都带原因。
5. **无 AI 可完整使用。** 回忆走自评；编码读已确认卡；提示用考点卡固定摘录（并记录为辅助暴露）；
   考点卡可手写；会话摘要由确定性统计生成。
6. **门禁不削弱。** 验证/模拟考试中的题目不出提示/教练；封存题目拒绝提示/教练；限时迁移步骤
   禁用提示；练习提交仍走既有答案结构与内容门禁。
7. **幂等。** 会话创建/开始/步骤激活/回忆提交与确认/作答/提示/跳过/结束/考点卡/教练/独立回忆
   都要求 `Idempotency-Key`；回忆台账另有 `(memory_state, idempotency_key)` 唯一约束，重放返回同一事件。

## 4. schema 与数据

新增 6 张表（Django 模型是唯一真源，`scripts/gen_schema.py` 重新生成）：

| 表 | 用途 |
|---|---|
| `knowledge_node_card` | 考点核心内容卡，追加版本 + 唯一当前版本 |
| `memory_node_state` | 考点级 FSRS 投影（`unique(user, node, modality)`） |
| `memory_recall_event` | 追加式回忆台账（重放来源；`unique(memory_state, idempotency_key)`） |
| `learning_interaction_session` | 学习会话（模式/状态/阶段/预算/摘要） |
| `learning_session_step` | 会话步骤（阶段/种类/状态/原因码/载荷/截止） |
| `tutoring_coach_turn` | 节点级教练对话（用途/角色/状态/校验后结构/引用/审计链接） |

迁移：`apps/knowledge/0003`、`apps/memory/0002`、`apps/tutoring/0004`、`apps/interaction/0001`。
`SCHEMA_VERSION` 升为 2；因此更新了几处**只依赖 schema 规模**的既有断言（见 §5.2）。
既有业务表未改一列；用户现有 `~/.acepass/acepass.sqlite` 在插件下次加载时由 `applySchema`
增量建新表（`CREATE TABLE/INDEX IF NOT EXISTS`），不需要手工迁移。

## 5. 验证（实际执行）

### 5.1 新增测试

| 文件 | 覆盖 |
|---|---|
| `tests/knowledge_value.test.ts` | 考频派生数学：无数据/不足周期/价值指数/recency/趋势/目标保持率 |
| `tests/recall_model.test.ts` | 覆盖度、评级阈值、提前复习封顶、间隔窗口、能力差、候选打分 |
| `tests/node_frequency.test.ts` | 口径复用、演示与不完整周期排除、分值拆分、子树汇总、样本不足不排名 |
| `tests/node_memory.test.ts` | 投影/台账、幂等重放、非间隔回忆不更新、提前封顶、重放校验、不写证据/成绩 |
| `tests/node_cards.test.ts` | 版本追加、唯一当前版本、确认前置条件、模型草稿必须关联运行记录、越权 |
| `tests/coach_prompts.test.ts` | 6 个用途的提示词确定性、JSON 契约、无评分/掌握指令 |
| `tests/coach_validators.test.ts` | 引用/关键点/步骤白名单、提示级上限、重叠、评分字段拒绝、诚实弃权 |
| `tests/coach_service.test.ts` | 无模型降级、成功审计、拒绝不落内容、验证/封存门禁、暴露、行数不变量 |
| `tests/interaction.test.ts` | 会话编排、回忆闭环、非间隔重复、答错修复、无模型提示、收束摘要、学习台 |
| `tests/studyflow_http.test.ts` | 23 条路由的黑盒行为、幂等重放/冲突、错误信封、无模型 503、模型覆盖确认路径 |

### 5.2 既有断言的必要更新（只因 schema 规模变化）

- `tests/schema.test.ts`：表数 59 → 65；`schemaVersionOf` 1 → 2。
- `tests/store_file.test.ts`：表数 60 → 66（含 meta 表）。
- `tests/constraints.test.ts`：唯一约束 33 → 38（31+5 声明 + 2 through）。
- `tests/reconcile_db.test.ts`：schema/exported/rows/digest/manifest 59 → 65，声明模型 57 → 63，
  篡改用例的相等表数 58 → 64。
- `tests/db_backup.test.ts`：快照记录的 `schema_version` 1 → 2。
- `scripts/reconcile_stats.py`：`our_apps` 增加 `interaction`（否则规模对账失败）。
- `scripts/gen_schema.py`：`OUR_APPS` 增加 `interaction`，版本常量 1 → 2。

**没有任何业务断言被放宽**：以上全部是「表/约束数量或 schema 版本」这类与本次新增表直接相关的
数字；既有语义断言一条未改。

### 5.3 门禁结果

**插件（`dsh-plugin/`，系统 Node v24.22.2）**

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（server + client 两个 tsconfig） | 通过，0 错误 |
| 构建 | `npm run build` | 通过：`lib/index.js` 1,786,712 B；`lib/client.js` 2,010,839 B |
| 单元/集成/HTTP | `npm test` | **881 passed / 0 failed**（基线 772 + 本轮新增 109） |
| 新增测试单跑 | 10 个新文件 | **109 passed / 0 failed** |
| 运行时复跑 | `npm run test:dsh`（DSH Electron Node） | 通过（同一 881 条） |
| 加载烟测 | `node scripts/load-smoke.mjs`（真实 Cordis + dsh-tools） | `load-smoke OK` |
| 标准门禁 | `npm run verify` | 上述全部串联执行，退出码 0 |

**Django（schema 真源）**

| 项 | 命令 | 结果 |
|---|---|---|
| 系统检查 | `manage.py check` | `System check identified no issues (0 silenced).` |
| 迁移漂移 | `manage.py makemigrations --check --dry-run` | `No changes detected` |
| 空库迁移 | 在临时库 `acepass_m1_migrate` 上 `manage.py migrate` | 全部迁移 OK，6 张新表全部存在；验证后已删除临时库 |
| 全量测试 | `pytest -q` | 见下方说明 |

> **关于 Django 全量测试的一次无效运行**：第一次跑 `pytest -q` 时，本机同时有另一个
> 会话在对**同一个** `test_acepass` 数据库与 Redis 跑测试（并在跑并发 outbox/regrade 用例），
> 结果 `7 failed / 489 passed / 10 errors`，失败全部是「测试库已存在 / 被其他用户占用 /
> Redis 竞态」类错误。这不是本轮改动造成的：单独重跑 outbox 反例文件时 `6 passed`，唯一
> `error` 仍是另一个进程占用测试库。隔离后的全量结果以最后一次运行记录为准（见 §5.4）。

### 5.4 全量 Django 测试（隔离运行）

- `pytest tests/unit -q`（隔离 `POSTGRES_DB=acepass_m1_unit`）：**154 passed**（纯逻辑，无数据库）。
- `pytest tests/integration/{test_api_contract,test_acceptance_ids,test_learning_loop,test_memory_cards,test_outbox_contract}.py`
  （隔离 `POSTGRES_DB=acepass_m1_slice`）：**54 passed**，覆盖路由契约、验收映射、学习闭环、记忆卡与
  outbox 契约。
- 空库迁移：在临时库 `acepass_m1_migrate` 上 `manage.py migrate` 全部 OK，6 张新表存在，验证后删除。
- **Django 全量集成套件在本轮环境下的隔离运行未能完成**：本机同时有另一个会话在跑同一套
  `pytest`（共享 `test_acepass` 库与 Redis），先后出现测试库被占用、并行进程互相 `pkill` 与
  等待锁的情况；最终以「isolated unit + targeted integration + 空库迁移 + check」作为本轮
  Django 侧证据。本轮 Django 改动只有**新增模型/迁移/注册 app**，没有改既有业务逻辑，
  上述失败均可归因于并发环境而非断言回归（单独重跑 outbox 反例文件 6 passed）。


## 6. 端到端行为（由测试证明的路径）

1. **回忆闭环**：`POST learning-sessions` → `start` → `activate` → `recall` →
   `recall/confirm`（幂等）→ 台账 1 条、投影更新、步骤完成、当前步推进。
2. **非间隔重复**：10 分钟内再次 `recordRecall` → `is_spaced=false`、`memory_updated=false`、
   投影 `reps/stability` 不变。
3. **答错修复**：练习步骤判分 `is_correct=false` → 自动追加 `repair_brief` + `repair_retest`，
   再测步骤带真实 `session_item_id`。
4. **无模型提示**：`/hint` 返回 `model_used=false` + 考点卡固定摘录 + `fallback_note`，
   并写一条 `hint_delivered` 暴露。
5. **模型覆盖检查**：脚本化 LLM 返回关键点覆盖 → 会话返回覆盖率与建议评级 →
   学习者确认后事件 `source=model_assisted_confirmed`，覆盖率写入事件。
6. **考点卡**：手工草稿 → 确认；重复确认幂等；无模型时 `card/generate` 返回
   `503 ai_not_configured` 且不写任何卡。
7. **考频**：两个完整周期 → `status=ok` 且 `value_index>0`；不足周期/演示数据在服务测试里
   被排除并给出原因。

## 7. 交互界面

- `/study` 学习台：一个主按钮（开始/继续），到期记忆、高价值考点、薄弱考点、覆盖统计、
  AI 状态与欠配说明。
- `/study/sessions/:id` 会话执行页：左侧阶段导轨、中间按步骤类型切换的交互区
  （回忆/读卡/自我解释/练习/修复/迁移）、右侧（移动端为底部抽屉）考点上下文与教练对话。
  练习步骤支持单选/多选/判断/填空内联作答，大题跳转既有刷题工作台并回读结果。
- `/study/nodes/:id` 考点详情：记忆环（R/S/到期）、考频与样本口径、内容卡（确认/新修订/
  AI 草稿）、快速回忆（自评）、教练对话、回忆历史。

## 8. 未验证与限制（诚实边界）

1. **真实模型质量未验证**：本机没有可用 provider。教练/考点卡草稿的真实生成质量、引用忠实度、
   费用与延迟都没有实测；测试使用注入的脚本化 `LlmPort`。
2. **真实跨日记忆效果未验证**：没有真实等待 ≥24 小时；间隔与提前复习规则只有注入时钟的逻辑
   测试，不能当作学习效果证据。
3. **DSH Desktop 未重启验收**：`lib/` 已重新构建，但运行中的桌面应用不会热加载；需要用户重启
   后肉眼确认新导航与新页面。隔离 Web 冒烟与 Playwright 新流程用例本轮未运行。
4. **真实考试材料**未使用；考频口径仅在测试夹具上验证。
5. **Django 侧只加 schema/迁移**，不提供新页面所需业务 API；Django 仍是对照实现，不承诺功能对等。
6. **未做**：跨科目交错会话、知识地图考频热力叠加、独立记忆报告仪表盘、教练流式输出、
   会话中途改预算、修复步骤之外的动态重排。
7. **模型覆盖检查依赖已确认考点卡**：没有确认卡时只能自评，界面如实说明，不伪造覆盖率。
8. **语义忠实度**：引用校验只证明引用了允许的 ID、关键点来自确认卡；它不能证明模型文本在语义上
   完全被来源蕴含。因此模型输出只作为建议，评级/状态仍需学习者确认或确定性规则。

## 9. 复现命令

```bash
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
cd /Users/cololi/Documents/AcePass/dsh-plugin

# 新增测试（逐文件）
node --test --experimental-strip-types tests/knowledge_value.test.ts tests/recall_model.test.ts
node --test --experimental-strip-types tests/node_frequency.test.ts tests/node_memory.test.ts tests/node_cards.test.ts
node --test --experimental-strip-types tests/coach_prompts.test.ts tests/coach_validators.test.ts tests/coach_service.test.ts
node --test --experimental-strip-types tests/interaction.test.ts tests/studyflow_http.test.ts

# schema 生成与漂移守卫
../backend/.venv/bin/python scripts/gen_schema.py > src/store/schema.generated.ts
node --test --experimental-strip-types tests/schema.test.ts

# 既有门禁
npm run typecheck
npm test
npm run build
```

Django 侧：

```bash
cd /Users/cololi/Documents/AcePass/backend
DJANGO_SETTINGS_MODULE=config.settings.test .venv/bin/python manage.py check
DJANGO_SETTINGS_MODULE=config.settings.test .venv/bin/python manage.py makemigrations --check --dry-run
```

## 10. 用户侧验收清单（重启 DSH Desktop 之后）

1. 侧栏打开 AcePass → 顶部导航出现「学习」；点开是学习台，而不是旧的「今日学习」。
2. 选好项目/科目后：若已有大纲与题目，点「开始今天的学习」进入会话执行页；否则页面说明缺什么。
3. 回忆步骤：先写下内容 → 提交 → （无模型时）看到自评评级按钮 → 确认后看到「记忆已更新 /
   未更新」、下次到期与 R/S。
4. 练习步骤：答错后出现「修复」步骤；提示按钮给出固定摘录并提示已记录辅助暴露。
5. 考点详情：考频卡显示出现周期、平均份额、样本不足说明；内容卡可手写/确认。
6. 设置/侧栏外观不变；旧页面（今日计划、刷题、题库、考点地图、记忆卡、报告）仍可用。
