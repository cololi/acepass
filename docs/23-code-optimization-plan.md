# 代码优化轮计划（2026-09-28）

起点：`fe68b07`（P2 第三批交付完成，P1/P2 规划内开发任务全部关闭）。
本轮**不新增业务能力**，只做「有测量证据的优化」，且不得让任何既有验收门禁变松。

## 0. 本轮的非协商约束

1. 不删除、不跳过、不放宽任何既有测试或断言语义；不关闭环境隔离；不清空业务库。
2. 每个优化都必须给出**同一条命令产出的 before/after 数字**，而不是形容词。
3. 外部阻塞项（真实模型凭据、真实 ≥24 小时、真实考试材料、远程部署/CI 实际执行）本轮**依然标注未验证**，
   不得因为"优化"而被顺手写成通过。
4. 行为不变是默认要求：读路径优化的返回值必须与优化前逐字节一致（时间戳字段除外，见各任务卡）。
5. 工作区只有一个写者一个范围：见 §3 的写范围划分，跨范围改动先找 Lead。

## 1. 基线测量（Lead 实测，2026-09-28）

### 1.1 后端全量测试

```bash
cd backend && POSTGRES_DB=acepass_opt_lead POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q
# → 489 passed, 3 warnings in 177.97s (0:02:57)
```

### 1.2 热读路径查询数与耗时（新量尺）

量尺：`backend/perfprobe/test_query_budget.py`（**在 `tests/` 之外**，因此不进入 489 验收计数），
入口 `scripts/dev/measure-hot-paths.sh`，独占库 `acepass_perfprobe`，固定夹具 20 个练习会话。

```bash
bash scripts/dev/measure-hot-paths.sh        # 原始数据：var/perfprobe/<label>.json
```

| 用例 | 查询数 | 中位耗时 | 备注 |
|---|---:|---:|---|
| `practice_sessions_list`（20 会话） | **67** | 19.85 ms | 每行 3 条查询：items 门禁、items.count()、Attempt.count() |
| `questions_list`（50 题） | **123** | 41.09 ms | 每行约 2.5 条：当前发布版本、最新版本、答案键 |
| `reports_practice` | 18 | 7.65 ms | — |
| `knowledge_nodes` / `today_plan` / `knowledge_map` | 12 / 11 / 11 | 3.3 ms | — |
| `grading_queue` / `memory_cards` / `search_hybrid` / `question_families` | 7 / 5 / 6 / 5 | 1.5–4.4 ms | 已接近常量 |

### 1.3 前端包体

```bash
cd frontend && npm run build && ls -la dist/assets/*.js dist/assets/*.css
```

| 产物 | 大小 |
|---|---:|
| `dist/assets/index-*.js` | 886,357 B（单块，路由与 KaTeX 全部打进首屏） |
| `dist/assets/index-*.css` | 36,459 B |
| `dist/` 合计 | 2.0 MB |

## 2. 已知缺陷（本轮修）

`docs/15` §7.1 记录、至今未修：`outbox.dispatch_pending` 在**持有 outbox 行锁的事务内**执行消费者，
而消费者 `claim_event` 用 `select_for_update(skip_locked=True)` 领取同一行 → 手快的消费者直接
`skipped_lease_not_held`，事件停在 `dispatched` 并带 300s 租约，只能等周期扫描在租约过期后重投。
无丢失、无重复副作用，但**单事件最坏延迟约 5.5 分钟**（本轮两次浏览器运行分别出现 24 条与 0 条被跳过）。

## 3. 工作流与写范围（互不重叠）

| 工作流 | 负责人 | 写范围 | 目标（可测） |
|---|---|---|---|
| W1 outbox 派发延迟 | `worker-latency` | `backend/apps/audit/**`、`backend/tests/integration/test_outbox_*.py`、`scripts/verify_worker_e2e.py` | 快速消费者不再被自己人的行锁跳过：单事件重投延迟从「租约 TTL（300s）」降到「同一轮扫描内」；`verify_worker_e2e.py` 仍 `ok=true` |
| W2 热读路径 N+1 | `backend-queries` | `backend/apps/**`（`audit/` 除外）、`backend/tests/integration/test_read_path_*.py`、所需迁移 | `questions_list` 123→≤12；`practice_sessions_list` 67→≤12 且**与行数无关**；响应体逐字节不变 |
| W3 前端首屏包体 | `frontend-bundle` | `frontend/src/**`、`frontend/vite.config.ts`、`frontend/index.html`、`frontend/perfprobe/**` | 入口 JS ≤ 基线的 65%（KaTeX 与路由按需加载），typecheck/vitest/浏览器主套件不变 |
| W4 独立复验 | `verifier` | `docs/review/2026-09-28/**`（只写证据，不改源码） | 用自己的反例复现三条结论；全量 489+、三组归档后端反例 11/9/3、归档浏览器反例 2、浏览器主套件 78 + stub 8、真故障演练 `ok=true` |
| Lead | `lead` | `backend/perfprobe/**`、`scripts/dev/measure-hot-paths.sh`、`docs/23-*.md`、`README.md`、`docs/implementation-status.md`、`docs/acceptance-results.md`、git 提交 | 量尺、计划、终验、提交 |

### 并发隔离约定

- 每个写者用自己的库：`POSTGRES_DB=acepass_opt_q`（W2）、`acepass_opt_w`（W1）、`acepass_opt_v`（W4），
  一律 `POSTGRES_CONN_MAX_AGE=0`（避免 `max_connections=100` 被空闲连接撞满）。
- **浏览器验收同一时刻只允许一个运行者**：用 `var/locks/browser-acceptance.lock` 目录当锁
  （`mkdir` 原子获取，用完 `rmdir`），批次用 p2-batch3（Redis 6396 / API 8016 / Vite 5186）。
- 开发服务 8000/5173 不可触碰；`git commit/reset/checkout/stash` 只有 Lead 做。

## 4. 完成判据（本轮算完成的定义）

1. 三条优化各自有 before/after 数字（同一命令、可复跑），且数字来自真实执行而非估算。
2. 新增回归测试能**在优化前的代码上失败**、在优化后通过（W1、W2 各至少一条这种"先红后绿"的证据）。
3. 独立复验者不看实现结论，自己写反例复现，并跑完全部验收门禁，全部原样通过。
4. `docs/23`、`implementation-status.md`、`acceptance-results.md`、`README.md` 如实更新；
   未验证项仍然标注未验证；Lead 提交并给出最终 diff 摘要。

## 5. 实际结果（2026-09-28 完成）

四条判据全部满足，交付记录见 **[24 代码优化轮交付](24-code-optimization-delivery.md)**，独立复验证据见
[docs/review/2026-09-28/optimization/README.md](review/2026-09-28/optimization/README.md)。

| 工作流 | before → after | 先红后绿 | 复验 |
|---|---|---|---|
| W1 outbox | 停在 `dispatched` + 300s 租约（最坏 ≈5.5 min）→ **同一轮内 `processed`** | HEAD 实现 3 failed → 修复后 6 passed | 独立反例红→绿 + 演练 `ok=true` |
| W2 读路径 | questions 123→**7** 查询 / 41.09→**5.65** ms；sessions 67→**8** / 19.85→**4.84** ms | 2 failed（26→56、19→31）→ 6 passed | oracle 逐字节 15/15 + 6/6，门禁语义 5/5 |
| W3 前端 | 入口 886,357→**39,762 B**（首屏 342,882 B / 3 chunks） | vitest 死门禁 10 failed → 5 passed | 独立量包体 + 独立浏览器探针（Lead 复核） |

门禁：后端 **501 passed**、ruff/check/makemigrations 干净、归档 **11 / 9（+1 deselected）/ 3**、
浏览器 **78 / 8 / 2**、演练 **ok=true**、**无任何既有测试文件被修改**。

计划外但如实登记的限制（详见 §6 of docs/24）：并列 `created_at` 时 `practice-sessions` 排列不同（非全序，
正常数据不可复现）、KaTeX 运行时渲染未固化进常设套件、并发扫描下过期 `processing` 行可能重复投递。

