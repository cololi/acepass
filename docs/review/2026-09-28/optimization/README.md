# W4 独立复验（2026-09-28 代码优化轮）— 最终结论

- 复验者：`verifier`（独立于 W1/W2/W3 作者；三条优化结论只由我自己写的反例/计数器判定）
- 仓库：`/Users/cololi/Documents/AcePass`，分支 `main`，基线提交 `fe68b073e34161c4cf2188106494d9aed01cc4ba`
- 冻结工作区取证：[logs/06-frozen-workspace.txt](logs/06-frozen-workspace.txt)
- 写范围：`docs/review/2026-09-28/optimization/**`（**未修改任何源码**；`git diff` 里的 10 个文件全部是 W1/W2/W3 与 lead 的改动）
- 浏览器锁：`var/locks/browser-acceptance.lock`，本轮由我获取并在跑完后 `rmdir` 释放

---

## 0. 结论总览

**总判定：三条优化全部在独立反例下成立；全部门禁原样通过（无一通过数下降、无断言被改、无新增 skip、无门禁放宽）。**
另有 **1 处窄口径偏差**（§5.1）与 **2 处覆盖缺口**（§6）如实列出，均未改变门禁结论。

| # | 验收项 | 基线 | 本轮实测 | 结论 |
|---|---|---|---|---|
| 1 | 后端全量（`acepass_opt_v`） | 489 passed | **501 passed / 108.63s / 0 failed / 0 skipped** | ✅ 通过（+12 = W1 6 + W2 6） |
| 2 | ruff | 干净 | `All checks passed!` | ✅ 通过 |
| 3 | `manage.py check` | 干净 | `System check identified no issues (0 silenced).` | ✅ 通过 |
| 4 | `makemigrations --check --dry-run` | 无变化 | `No changes detected` | ✅ 通过 |
| 5 | 归档后端反例 p01-independent | 11 passed | **11 passed** | ✅ 通过 |
| 6 | 归档后端反例 p02-independent | 9 passed + 1 deselected | **9 passed, 1 deselected** | ✅ 通过 |
| 7 | 归档后端反例 p02-final-independent | 3 passed | **3 passed** | ✅ 通过 |
| 8 | 归档 `test_p0_regressions.py`（非门禁） | 1 failed / 13 passed | **1 failed / 13 passed（完全相同）** | ✅ 无回归 |
| 9 | 反例① outbox 快速消费者 | 优化前必须失败 | 优化前 **FAIL** → 优化后 **PASS** | ✅ 通过 |
| 10 | 反例② 查询数与行数无关 | 优化前必须随行数增长 | 22→127 / 29→201 → **8→8 / 7→7** | ✅ 通过 |
| 11 | 对抗性：响应体与优化前 oracle 逐字节一致 | — | questions **15/15**、sessions **6/6** 逐字节相同 | ✅ 通过（附 §5.1 窄偏差） |
| 12 | 对抗性：验证门禁语义（同版本/同族/同谱系/未覆盖） | — | **5/5** 符合语义 | ✅ 通过 |
| 13 | 反例③ 前端包体 | 886,357 B / 1 chunk / 入口 katex×15 | **39,762 B（4.49%）/ 19 chunk / 入口 katex×0**；首屏 342,882 B | ✅ 通过 |
| 14 | 前端 `npm run typecheck` | — | exit 0 | ✅ 通过 |
| 15 | 前端 `npm run test`（vitest） | 改动前 **10 failed / 1 passed（exit 1）** | **1 file / 5 tests passed（exit 0）** | ✅ 修好死门禁（§5.2） |
| 16 | Playwright 收集 | — | **86 tests in 9 files**（78 + 8 stub），独立于 vitest | ✅ 通过 |
| 17 | 浏览器主套件 | 78 passed | **78 passed (1.6m)** | ✅ 通过 |
| 18 | 浏览器 stub 专跑 | 8 passed | **8 passed (17.9s)** | ✅ 通过 |
| 19 | 归档浏览器反例 | 2 passed | **2 passed (4.6s)** | ✅ 通过 |
| 20 | 真故障演练 | `ok: true` | **`ok: true`**（真实 `FLUSHALL` + 真实 `SIGKILL`，两条恢复均 exactly-once） | ✅ 通过 |
| 21 | 真实模型凭据 / ≥24h / 真实试卷 / 远程部署 CI | 未验证 | **仍未验证** | ⛔ 未验证（§7） |

---

## 1. 基线固定（优化前，工作区 backend 零改动）

全量测试开始时 `git diff --stat` 为空、结束时 backend 仍干净，因此这是真·优化前基线。
日志：[00-baseline-git-state.txt](logs/00-baseline-git-state.txt)、[01-baseline-backend-suite.txt](logs/01-baseline-backend-suite.txt)

```bash
cd backend && POSTGRES_DB=acepass_opt_v POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q
# 优化前: 489 passed, 3 warnings in 223.24s   (EXIT=0)
# 优化后: 501 passed, 3 warnings in 108.63s   (EXIT=0)   logs/10-gate-backend-suite.txt
```

优化前后端包体（`git archive HEAD` 干净导出后构建，不触碰作者的 `frontend/dist`）：
[04-probe-frontend-before.txt](logs/04-probe-frontend-before.txt)、[probe-frontend-before.json](logs/probe-frontend-before.json)

| 指标 | 优化前 | 计划书 §1.3 |
|---|---:|---:|
| 入口 JS | **886,357 B**（gzip 258,543） | 886,357 B ✅一致 |
| 入口 CSS | 36,459 B | 36,459 B ✅一致 |
| `dist/` 合计 | 1,996,204 B | 2.0 MB ✅一致 |
| JS chunk 数 | **1** | 单块 ✅一致 |
| 入口 `katex` 次数 | **15** | 「KaTeX 打进首屏」✅一致 |

---

## 2. 反例①：outbox 快速消费者不再被派发行锁跳过

文件：[probes/test_w4_outbox_fast_consumer.py](probes/test_w4_outbox_fast_consumer.py)
证据：[02-probe-outbox-before.txt](logs/02-probe-outbox-before.txt) + [probe-outbox-before.json](logs/probe-outbox-before.json)（红）、
[31-probe-outbox-after.txt](logs/31-probe-outbox-after.txt) + [probe-outbox-after.json](logs/probe-outbox-after.json)（绿）

**构造**：把 `celery_app.send_task` 换成「快消费者 broker」——它在 `send_task` 内部起线程跑真实
`outbox.run_leased()` 并 **join 到结束**，保证消费者的领取尝试一定发生在派发者事务提交之前
（真实竞态的最坏时序，对应现场「一次运行 24 条被跳过、另一次 0 条」）。同时用**另一条连接**
`select_for_update(nowait=True)` 直接观测该行此刻是否被别的会话锁住 —— 这是观测，不是从结果反推。
探针不假设修复形态，只断言可观测契约：同一轮 `dispatch_pending()` 内效果被应用、消费者未被跳过、
`processed_at` 被置位（不需要等租约）。

| 观测量 | 优化前 | 优化后 |
|---|---|---|
| `dispatcher_in_atomic_block` | **true** | **false** |
| `row_locked_by_other_before_claim` | **true** | **false** |
| `consumer_executed` | **false**（`claim was not available`） | **true**（`effect-applied`） |
| 效果执行次数 | 0 | 1 |
| 事件状态 | `dispatched`，`processed=false`，租约 +300.0s | `processed`，`processed_at` 已写，租约清空 |
| 实现日志 | `INFO apps.audit.outbox outbox event … is not claimable by this consumer; skipping` | 无 |

红→绿复现命令：

```bash
# 优化前（在干净 HEAD 工作区跑；本轮已实际跑过，见 02-probe-outbox-before.txt）
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-28/optimization/probes" W4_PROBE_LABEL=before \
  backend/.venv/bin/python -m pytest \
  docs/review/2026-09-28/optimization/probes/test_w4_outbox_fast_consumer.py \
  -c backend/pytest.ini --ds=verifier_settings -q
# 优化后
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-28/optimization/probes" W4_PROBE_LABEL=after \
  backend/.venv/bin/python -m pytest \
  docs/review/2026-09-28/optimization/probes/test_w4_outbox_fast_consumer.py \
  -c backend/pytest.ini --ds=verifier_settings -q   # 2 passed
```

**附：一个不作硬断言的设计属性**（诚实记录，不是缺陷）。同一探针的第二个用例模拟「broker 已收下消息、
但没有任何消费者确认」——修复后它**仍然**要等满 300 s 租约才被下一轮扫描重投：

```json
{"round_1_dispatched": 1, "round_2_selected": 0, "lease_seconds_after_round_1": 300.0,
 "verdict": "FAIL (still unconfirmed; would wait out a 300.0s lease)"}
```

这是「dispatched 行带租约、租约到期才可恢复」这一既有设计契约（docs/15 恢复语义）的直接结果，不是本次
优化引入的；真正被修掉的是「消费者在本该成功的时序上被自己人的锁跳过」，由上面的硬断言覆盖。

---

## 3. 反例②：读路径查询数与行数无关（自写计数器）

文件：[probes/test_w4_read_path_query_count.py](probes/test_w4_read_path_query_count.py)
证据：[03-probe-readpath-before.txt](logs/03-probe-readpath-before.txt) + [probe-readpath-before.json](logs/probe-readpath-before.json)、
[32-probe-readpath-after.txt](logs/32-probe-readpath-after.txt) + [probe-readpath-after.json](logs/probe-readpath-after.json)

自建夹具（`load_demo_fixture` + 深拷贝 published 题到 40 行），`CaptureQueriesContext` 计数，每请求重复
3 次并要求查询数稳定（实测 `query_count_stable_across_repeats: true`）：

| 端点 | 5 行 | 40 行 | 与行数无关 | ≤12 目标 |
|---|---:|---:|---|---|
| `GET /practice-sessions?limit=50` 优化前 | 22 | **127** | ❌ | ❌ |
| `GET /practice-sessions?limit=50` 优化后 | **8** | **8** | ✅ | ✅ |
| `GET /questions?limit=N` 优化前 | 29 | **201** | ❌ | ❌ |
| `GET /questions?limit=N` 优化后 | **7** | **7** | ✅ | ✅ |

---

## 4. 全部门禁原始结果

### 4.1 后端静态门禁

```
11-gate-ruff.txt            All checks passed!                                   EXIT=0
12-gate-manage-check.txt    System check identified no issues (0 silenced).       EXIT=0
13-gate-makemigrations.txt  No changes detected                                   EXIT=0
```

### 4.2 归档后端反例（文件未改，已逐文件核验）

`git ls-files --error-unmatch`（tracked）+ `git diff --quiet HEAD`（`==HEAD`）逐一核验 13 个归档文件：**全部通过**；
`find docs/review/2026-09-27 -newermt 2026-09-28` 为空 —— 本轮没有人动过这些反例。

| 组 | 命令 | 预期 | 实测 | 日志 |
|---|---|---|---|---|
| 1 | `p01-independent/test_*.py --ds=p01_independent_settings` | 11 | **11 passed** | [14](logs/14-gate-archived-p01.txt) |
| 2 | `p02-independent/test_*.py --ds=p02_independent_settings -k 'not generation_migration_cannot_promote'` | 9 (+1 desel) | **9 passed, 1 deselected** | [15](logs/15-gate-archived-p02.txt) |
| 3 | `p02-final-independent/test_*.py --ds=review_settings` | 3 | **3 passed** | [16](logs/16-gate-archived-p02-final.txt) |
| 4 | `docs/review/2026-09-27/test_p0_regressions.py --ds=review_settings`（非门禁） | 与优化前相同 | **1 failed, 13 passed（与优化前逐条相同）** | [17](logs/17-gate-archived-p0-regressions.txt) |

> **分组映射更正**：lead 消息曾把 11/9/3 映射为「p02-independent / p02-final-independent / test_p0_regressions.py」。
> 实测为 **11 = p01-independent、9(+1 deselect) = p02-independent、3 = p02-final-independent**，
> 与 `docs/19 §5`、`p2-batch3/README.md` 的 reviewer-eleven / archived-nine / reviewer-three 三个日志一致，
> 也与各目录的函数计数一致（6+3+2=11、5+3+2-1=9、1+1+1=3）；`test_p0_regressions.py` 实际 14 条。
> 我按**四组全跑**执行以覆盖所有解释，证据见 [05-archived-group-mapping-resolution.txt](logs/05-archived-group-mapping-resolution.txt)。
> 第 4 组唯一失败 `test_image_service_invokes_configured_vision_provider`（断言 vision provider 被调用，`seen == []`）
> 与三条优化范围无关，优化前后完全一致，故不判为本轮回归（其同名副本已迁入 `backend/tests`，属 501 全量且通过）。

### 4.3 前端

```
18-gate-frontend-typecheck.txt   tsc --noEmit                      EXIT=0
19-gate-frontend-vitest.txt      1 file / 5 tests passed           EXIT=0
20b-playwright-collection.txt    Total: 86 tests in 9 files        EXIT=0
21-gate-frontend-build.txt       tsc -b + vite build               EXIT=0
```

包体（我自己在 `/tmp` 的工作区副本里构建 + 用自己写的脚本量）：[probe-frontend-after.json](logs/probe-frontend-after.json)

| 指标 | 优化前 | 优化后 | 判据 | 结论 |
|---|---:|---:|---|---|
| 入口 JS | 886,357 B | **39,762 B** | ≤576,132 B（65%） | ✅ **4.49%** |
| 入口 JS gzip | 258,543 B | **12,404 B** | — | ✅ |
| 入口 CSS | 36,459 B | 7,376 B | — | ✅ |
| 入口 chunk `katex` 次数 | 15 | **0** | =0 | ✅ |
| JS chunk 数 | 1 | **19** | >1（懒加载存在） | ✅ |
| 首屏（entry + modulepreload） | — | **342,882 B**（gzip 107,516） | — | ✅ 与 W3/lead 报告一致 |
| 含 katex 的 chunk | 入口本身 | `vendor-katex-*.js`(261,511 B) + `Content-*.js`(1,983 B) | 不在首屏 | ✅ |
| katex CSS | 在入口 CSS 内 | `vendor-katex-*.css`(29,288 B)，由 `Content-*.js` 按需注入 | 不在首屏 | ✅ |
| `dist/` 合计 | 1,996,204 B | 2,001,465 B | — | 代码搬家而非删除 ✅ |

`index.html` 的静态引用只有：`index-BFrTDZ2v.js`（入口）、`vendor-react-*.js`、`vendor-query-*.js`、
`index-D5z-b74d.css` —— **没有任何 katex 资源**；`Content-*.js` 里存在 `import("./vendor-katex-CBezJsc7.js")`。

### 4.4 浏览器（持锁串行，跑完释放）

脚本：[probes/run-browser-gates.sh](probes/run-browser-gates.sh)（`mkdir` 拿锁 + `trap` 保证释放）

| 步骤 | 环境 | 结果 | 日志 |
|---|---|---|---|
| reset → 主套件 `--grep-invert "@stub"` | p2-batch3：库 `acepass_acceptance_p2_batch3`、Redis 6399、API 8019、Vite 5189、媒体 `var/private-media-p2-batch3` | **78 passed (1.6m)** | [22](logs/22-gate-browser-main.txt) |
| 归档反例（**同一库**，无 globalSetup） | 固定 6394 / 8014 / 5184 | **2 passed (4.6s)** | [23](logs/23-gate-browser-archived.txt) |
| 再次 reset → stub 专跑 `--grep "@stub"` | 同上 + `ACEPASS_AI_PROVIDER=stub ACEPASS_RUNTIME_MODE=demo` | **8 passed (17.9s)** | [24](logs/24-gate-browser-stub.txt) |

三次与基线通过数逐项相同（78 / 2 / 8），无失败、无 skip；stub 两次运行之间按要求重置了库与空媒体目录。

### 4.5 真故障演练 `ok: true`

日志：[25-gate-worker-drill.txt](logs/25-gate-worker-drill.txt)、报告 JSON：[25-gate-worker-drill.json](logs/25-gate-worker-drill.json)

独立库 `acepass_acceptance_opt_v_drill`（**没有复用 W1 的 `acepass_acceptance_opt_w_drill`**）、
Redis 6395、`ACEPASS_OUTBOX_LEASE_SECONDS=5`、`ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1`。
脚本自己起停真实 Celery Worker，做真实 `SIGKILL`（signal 9）与真实 Redis `FLUSHALL`：

```json
{"step": "worker_stopped_for_flush", "killed_with": "SIGKILL", "real": true}
{"step": "flush_prepared", "queue_depth_before_flush": 2, "real": true}
{"step": "redis_flushed_for_real", "flushed": true, "queue_depth_after_flush": 0, "real": true}
{"step": "flush_recovery_scan", "delivered": 2, "lease_seconds": 5, "real": true}
{"step": "redis_flush_recovery", "ok": true, "applied_exactly_once": true, "real": true}
{"step": "worker_killed_mid_flight", "signal": 9, "caught_while_processing": true, "unconfirmed_after_kill": 2}
{"step": "killed_worker_recovery", "ok": true, "applied_exactly_once": true, "lease_seconds": 5}
{"step": "stale_consumer_takeover", "duplicate_delivery": "observed_by_second_consumer",
 "job_status": "succeeded", "outbox_status": "processed", "real": true}
{"step": "final_state", "unresolved": {}, "outbox": 18, "processed": 18}
{"ok": true}
```

复现（前置：`bash scripts/dev/reset-p2-batch3-browser.sh acepass_acceptance_opt_v_drill 6395` →
`manage.py migrate` → `create_account acceptance@acepass.local` → `bootstrap_acceptance --allow acepass_acceptance_opt_v_drill`）：

```bash
ACEPASS_WORKER_DRILL_REPORT="$PWD/docs/review/2026-09-28/optimization/logs/25-gate-worker-drill.json" \
ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub ACEPASS_INLINE_TASKS=false \
ACEPASS_PRIVATE_MEDIA_ROOT=/tmp/acepass-w4-drill-media \
POSTGRES_DB=acepass_acceptance_opt_v_drill REDIS_URL=redis://127.0.0.1:6395/0 \
ACEPASS_OUTBOX_LEASE_SECONDS=5 POSTGRES_CONN_MAX_AGE=0 \
PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py   # DRILL_EXIT=0
```

---

## 5. lead 指定的两条对抗性检查（结论：都不是放宽门禁；另附一条我自己的发现）

### 5.1 ⚠️ `practice-sessions` 在「`created_at` 完全并列」时的排序偏差（唯一实质发现）

文件：[probes/test_w4_read_path_response_invariance.py](probes/test_w4_read_path_response_invariance.py) 的
`test_page_order_under_tied_created_at`；证据 [probe-response-invariance-after.json](logs/probe-response-invariance-after.json)

把该项目全部练习会话的 `created_at` 强制写成**同一个时间戳**后（微秒级并列），各重复调用 3 次：

| 端点 | 端点 3 次自稳 | oracle 3 次自稳 | 端点序 == oracle 序 | 行集合相同 |
|---|---|---|---|---|
| `practice-sessions?limit=50` | ✅ | ✅ | ❌ **不同排列** | ✅ 19 行相同 |
| `questions?limit=50` | ✅ | ✅ | ✅ | ✅ 32 行相同 |

**判读（不替作者圆场，也不夸大）**：差异只出现在**完全并列的排序键**上；行集合与每行字段值全部一致。
优化前的查询同样只用 `order_by("-created_at")`，对并列行**从未定义过**顺序（SQL 语义上并列行的先后不属于契约）。
因此这是「排序键非全序」这一既有性质在新增 `GROUP BY` 计划下的表现，不是数据丢失或字段变化。
本轮**不作为失败项**，但如实登记：若将来有消费者依赖并列行的先后，需要显式加次级排序键（如 `-id`）。
正常数据下（每次会话由不同请求创建，微秒时间戳不同）21 个用例全部逐字节一致，本偏差不可复现。

### 5.2 W3 的 `vite.config.ts test.include`：**修好一个死门禁，不是放宽门禁**

在 `git archive HEAD` 的干净导出里叠加当前新增的 `src/components/Content.test.tsx`，
先跑 HEAD 配置、再覆盖当前配置，全程不改仓库文件（日志 [20](logs/20-gate-frontend-vitest-include-adversarial.txt)）：

| | Test Files | Tests | exit |
|---|---|---|---|
| **改动前**（HEAD `vite.config.ts`，无 `test` 键 → vitest 默认 include） | **10 failed \| 1 passed (11)** | 5 passed | **1** |
| **改动后**（当前 `test.include=['src/**/*.test.{ts,tsx}']`） | **1 passed (1)** | **5 passed** | **0** |

逐条回答 lead 的三个问题：

1. **被排除的到底是谁**：改动前失败的 10 个文件**全部**是 `tests/acceptance/*.spec.ts`（9 个）与
   `tests/e2e/p0-loop.spec.ts`（1 个），**每一个都 `import '@playwright/test'`**（逐文件 grep ≥1）。
   它们是 Playwright 规格，被 vitest 误收集后在 collect 阶段抛
   `test.describe() called outside of a Playwright run`。
2. **有没有原本通过的 vitest 用例被排除**：**没有**。改动前全仓库只有 **1 个**非 Playwright 测试文件
   （正是 W3 本轮新增的 `src/components/Content.test.tsx`），它 `import { describe, expect, it } from 'vitest'`、
   用 `react-dom/server` 渲染（因此 `environment: 'node'` 正确、不需要 jsdom），**落在新 include 内**，
   5 条断言在改动前后都通过。改动前仓库里**不存在**任何其他 vitest 单测。
3. **有没有放宽/改测试**：`git status --porcelain -- frontend/tests` **为空**，`git diff --stat -- frontend/tests` 为空
   —— 验收测试一个字节都没动；`vite.config.ts` 的改动只是新增 `test.include`（外加与 vitest 无关的 `manualChunks`）。
   Playwright 仍由自己的配置单独收集：`--list` 得 **86 tests in 9 files**（78 非 stub + 8 stub，见
   [20b](logs/20b-playwright-collection.txt)），与改动前一致。

**残留风险（如实登记，当前影响为 0）**：include 只写了 `.test.{ts,tsx}`；若将来有人在 `src/` 下写
`*.spec.ts` 单测，它不会被收集（今天 `src/**/*.spec.ts` 数量为 **0**）。更稳的写法是同时收
`src/**/*.{test,spec}.{ts,tsx}`，或在 `tests/` 下加 vitest 专用 exclude。

### 5.3 W2 的「响应体不变」：自写 oracle 逐字节比对（**21/21 通过**）

文件：[probes/test_w4_read_path_response_invariance.py](probes/test_w4_read_path_response_invariance.py)
证据：[30-probe-response-invariance.txt](logs/30-probe-response-invariance.txt)、
[probe-response-invariance-after.json](logs/probe-response-invariance-after.json)

**不看作者的 body-diff**：我把优化前的处理函数体从 `git show HEAD:...` 原样抄成 oracle
（`oracle_list_questions` / `oracle_list_sessions`，查询与循环逐行一致），自建夹具后要求
**端点返回的 JSON 与 oracle 逐字节相同**（`json.dumps(sort_keys=True)` 全等）。

覆盖到的用例（questions **15/15** 逐字节一致）：无过滤 / `subject_id` / `question_type` /
`status=published` / `status=draft` / `origin_type` / `search` 命中 / `search` 无命中 /
`limit+offset` / 深 `offset` / 空页（`offset=100000`）/ 空科目 / `limit=0`（夹到 1）/
`limit=500`（夹到 100）/ 组合过滤。sessions **6/6**：`limit=50` / 默认 limit / `limit=2` /
`limit=0` / `limit=500` / `subject_id`。

夹具里刻意安排了简单路径会漏掉的内容形状，全部逐字节一致：

- 题目**完全没有发布版本**（`published_version_id=null`，`question_type` 取最新版本）；
- 已发布题干 + **更新的草稿版本**（`latest_version` 与 `question_type` 必须分别取「最新」和「已发布」）；
- 答案键**只有 disputed 或 pending**（`has_trusted_answer=false`）；
- 只有**非主**知识点映射（`knowledge_nodes=[]`）与有主映射两种情形。

**验证门禁语义反例（W2 承认缺失的那条）**：自己构造一个 active 的 verification 会话，在其题项上写
`first_delivered_at`，再建 4 个练习会话，实测 **5/5** 符合语义：

| 会话题项与验证项的关系 | 期望 `grading_hidden` | 实测 |
|---|---|---|
| 同一 question version | true | ✅ true |
| 同一**近似重复族**（`Question.family`） | true | ✅ true |
| 同一**内容谱系**（`Question.content_lineage`） | true | ✅ true |
| 无关题 | false | ✅ false |
| 验证会话自身（`hides_grading`） | true | ✅ true |

> 构造要点：`active_verification_content_map` 是**从验证项所在题目**向外扩展的，所以族/谱系必须挂在
> **验证题目**上才可达；我第一次把族挂到兄弟题上，探针正确地红了 —— 那是我的夹具错误，已修正并重跑。

### 5.4 其他独立核对

- **归档反例未被改**：13 个文件逐一 `git ls-files --error-unmatch`（tracked）+ `git diff --quiet HEAD`（`==HEAD`）。
- **既有测试未被改/删**：`git status --porcelain -- backend/tests frontend/tests docs/review/2026-09-27`
  只有两个 `??` 新增文件（W1/W2 的回归测试），没有任何 ` M` / ` D`；全量套件 501 passed 且**无 skip**。
- **新增测试不是摆设**：W1 `test_outbox_dispatch_lease.py`（6 条）与 W2 `test_read_path_query_budget.py`（6 条）
  共 12 条，正是 489→501 的差值；两个文件里没有 `skip`/`xfail`/`deselect`。
- **`.gitignore` 的 3 行新增**只忽略 `frontend/perfprobe/dist-before/`（约 900 KB 旧包体备份）。
  该备份不是证据：优化前的 886,357 B 我已用 `git archive HEAD` 独立重建复现（§1），数字不依赖它。

---

## 6. 覆盖缺口（不是失败，但必须写明）

1. **客户端公式渲染没有浏览器断言**：`frontend/tests/**` 与归档 spec 中**没有任何**用例提到
   `katex`/`math`。W3 把 KaTeX 改成动态 `import()` 后，浏览器套件 78 条只覆盖了首屏路由能打开，
   **没有一条断言公式在客户端真的被 KaTeX 渲染出来**（若动态 import 失败，代码会退化为显示原始 LaTeX，
   不会有测试变红）。我能独立证明的只有**静态接线正确**：入口无 katex、
   `Content-*.js` 里存在 `import("./vendor-katex-*.js")`、`Content-*.js` 引用 `vendor-katex-*.css`
   （Vite 的 preload 会在该 chunk 加载时注入样式）、`index.html` 无任何 katex 资源。
   **运行时渲染正确性未验证。**
2. **并列排序键的次序**：见 §5.1，`practice-sessions` 在完全并列的 `created_at` 上返回的排列与优化前不同
   （行集合相同、字段相同）。未加次级排序键前，这一顺序不属于契约。

---

## 7. 仍未验证项（不因本轮优化改口）

计划书 §0.3 的四项外部阻塞，本轮**依然全部未验证**，我不把它们写成通过：

1. **真实模型凭据** —— 本机无可用 DeepSeek / 视觉 / 嵌入凭据（余额 HTTP 402）。讲解、图片识别、
   手写转写、逐点估分、标签建议、嵌入向量、变式生成全部只有 stub / 脚本 provider 证据；
   stub 结果在日志里始终标注为 stub（浏览器 stub 专跑 8 条）。
2. **真实 ≥24 小时间隔的学习效果** —— 没有真实经过时间，只有可注入时钟的逻辑证据。
3. **真实考试材料** —— 版式、周期统计、封存与效果校准都建立在明确标注的验收夹具上。
4. **远程部署 / GitHub Actions 实际执行** —— 所有门槛只在本机执行，没有跑在远程 runner 上。

本轮自身新增的受限项：

5. **反例①是进程内线程 + 独立连接构造的最坏时序**，不是真实多进程 Celery 上的统计竞态压测；
   真实多进程路径由 §4.5 的演练（`ok: true`）覆盖，那是它自己的证据，不是反例①的替代品。
6. **反例②的跨运行比对是形状指纹**（键 + 值类型 + 行数）；逐字节比对由 §5.3 的自写 oracle 在同一夹具内完成。
7. **性能只覆盖读路径查询数与包体字节**：没有做吞吐/并发压测，也没有真实网络（CDN、压缩传输）下的首屏测量。
8. 见 §6 的两处覆盖缺口。

---

## 8. 复现清单（全部命令）

```bash
# ---- 后端 ----
cd backend && POSTGRES_DB=acepass_opt_v POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q   # 501 passed
.venv/bin/ruff check apps ai domain config tests                                                       # All checks passed!
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check                            # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes
cd ..

# ---- 归档后端反例（文件未改；四组全跑）----
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p01-independent" POSTGRES_CONN_MAX_AGE=0 \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p01-independent/test_*.py \
  -c backend/pytest.ini --ds=p01_independent_settings -q                                     # 11 passed
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" POSTGRES_CONN_MAX_AGE=0 \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-independent/test_*.py \
  -c backend/pytest.ini --ds=p02_independent_settings -q -k 'not generation_migration_cannot_promote'  # 9 passed, 1 deselected
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-final-independent" POSTGRES_CONN_MAX_AGE=0 \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-final-independent/test_*.py \
  -c backend/pytest.ini --ds=review_settings -q                                              # 3 passed
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27" POSTGRES_CONN_MAX_AGE=0 \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/test_p0_regressions.py \
  -c backend/pytest.ini --ds=review_settings -q                                              # 1 failed, 13 passed（非门禁，与优化前相同）

# ---- 我的三条反例（独立库 acepass_opt_v_w4）----
for f in test_w4_outbox_fast_consumer test_w4_read_path_query_count test_w4_read_path_response_invariance; do
  PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-28/optimization/probes" W4_PROBE_LABEL=after \
    backend/.venv/bin/python -m pytest "docs/review/2026-09-28/optimization/probes/$f.py" \
    -c backend/pytest.ini --ds=verifier_settings -q
done

# ---- 前端 ----
cd frontend && npm run typecheck && npm run test          # exit 0 / 1 file, 5 tests passed
# Playwright 收集（需 p2-batch3 环境变量，见 §4.4）
npx playwright test --list --config playwright.acceptance.config.ts       # Total: 86 tests in 9 files
# 包体：先干净构建（不碰工作区 dist），再自己量
cd .. && bash docs/review/2026-09-28/optimization/probes/probe_frontend_bundle.sh <dist-dir> <label>

# ---- 浏览器（必须先拿锁；脚本内 trap 释放）----
bash docs/review/2026-09-28/optimization/probes/run-browser-gates.sh       # 78 / 2 / 8 passed

# ---- 真故障演练 ---- 见 §4.5
```

---

## 9. 纪律与边界

- 全程未执行 `git commit / checkout / reset / stash / clean`；只用只读命令
  （`status` / `rev-parse` / `diff` / `ls-files` / `archive` / `show`）。
- 未修改 `docs/review/2026-09-28/optimization/` 之外的任何文件；作者的 `frontend/dist`、`var/perfprobe/` 均未触碰
  （前端「优化前/优化后」都在 `/tmp` 的独立副本里构建）。
- 全部测试使用独立库：`acepass_opt_v`（全量）、`acepass_opt_v_w4`（我的探针）、
  `test_acepass_p01_independent_gaps` / `test_acepass_p02_*` / `test_acepass_review_4kdv8c`（归档）、
  `acepass_acceptance_p2_batch3`（浏览器）、`acepass_acceptance_opt_v_drill`（演练）；一律 `POSTGRES_CONN_MAX_AGE=0`。
- 浏览器验收全程单运行者：`mkdir var/locks/browser-acceptance.lock` 拿锁，`trap` 在脚本退出时 `rmdir` 释放（已确认释放）。
- 未使用 W1 的演练库 `acepass_acceptance_opt_w_drill` / `_drill2`。
- 未初始化、未删除任何业务库；`git status` 里的改动全部属于 W1/W2/W3/lead。
- **一次自我更正**：05:28 我的一条量包体命令里 `W4_PROBE_OUT` 拼成了绝对路径叠加，误在仓库根目录生成了
  `Users/cololi/…/probe-frontend-after.json` 一个文件（仓库根多出 `?? Users/`）。该文件与
  [logs/probe-frontend-after.json](logs/probe-frontend-after.json) **md5 完全相同**（`7f89233e…`），
  已删除整棵误建目录；清理后 `git status` 与 §1 冻结快照逐行一致（10 个 ` M` + 原有 `??`），
  现在 `git status` 里没有任何属于我的多余条目。
