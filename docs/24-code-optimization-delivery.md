# 代码优化轮交付记录（2026-09-28）

起点 `fe68b07`。本轮**不新增业务能力**，只做有测量证据的优化：修复一个已记录缺陷、消除两处热读路径
N+1、把前端首屏包体从 886 KB 降到 39.7 KB 入口块。所有数字来自真实执行，未验证项保持未验证。

计划与非协商约束见 [23 代码优化轮计划](23-code-optimization-plan.md)。

## 1. 一句话结果

| 工作流 | 优化前 | 优化后 | 证据 |
|---|---|---|---|
| W1 outbox 派发延迟（`docs/15` §7.1 缺陷） | 快速消费者被派发行的锁跳过，事件停在 `dispatched` 带 300s 租约，最坏 ≈5.5 分钟（300s 租约 + 30s beat） | 投递记录在短事务内提交、消息在提交后才发给 broker：**同一轮内**消费者领取并 `processed_at` 落库、租约清空 | 新增 6 条集成测试（HEAD 版实现上 3 failed / 修复后 6 passed）；真故障演练 `ok=true` |
| W2 热读路径 N+1 | `questions_list` **123 queries / 41.09 ms**；`practice_sessions_list` **67 / 19.85 ms**（20 会话夹具） | **7 / 5.65 ms**、**8 / 4.84 ms**，且**与行数无关** | 同一量尺 `scripts/dev/measure-hot-paths.sh`；其余 8 个端点查询数一字未变 |
| W3 前端首屏 | 入口 JS **886,357 B**（1 chunk，路由 + KaTeX 全在首屏） | 入口 **39,762 B**（4.5%），首屏合计 **342,882 B / 3 chunks**（38.7%） | `npm run build` + 独立浏览器探针；主套件 78 passed |

## 2. W1：outbox 派发不再被自己的行锁跳过

**缺陷**：`dispatch_pending` 在 `transaction.atomic()` 内先 `select_for_update(skip_locked=True)` 选批，
再**在同一事务持锁时**调用消费者；消费者 `claim_event` 也用 `select_for_update(skip_locked=True)` 领同一行，
于是直接 `skipped_lease_not_held`，事件停在 `dispatched` + 300s 租约，只能等周期扫描在租约过期后重投。

**修复**（`backend/apps/audit/services/outbox.py`）：选批与**投递记录**在一个短事务内完成并提交，
消息在提交之后才交给 broker；消息存在后不再写该行。`processing`（死 worker 的过期租约）行只记
`attempts`/`dispatched_at`，**不碰 claim 列**，接管消费者仍可领取；达到 `max_attempts` 的行不预标记、
不消耗计数；inline 模式记账保持原样（消费者自己记一次），broker 失败仍只计 1 次尝试。

**执行者发现并修掉的第二个窗口**：把投递记录写在 `send_task` 之后时，消息已在 broker 而该行仍被
UPDATE 锁着，快速 worker 照样 `is not claimable` 而跳过（真演练 worker 日志现场：行 attempts=3、
66 秒后才完成）。最终版把记录移到消息之前，两个窗口一起消除。

证据（`task-1`）：

```bash
# 红：把 HEAD 版 outbox.py 换入后
cd backend && POSTGRES_DB=acepass_opt_w POSTGRES_CONN_MAX_AGE=0 \
  .venv/bin/python -m pytest tests/integration/test_outbox_dispatch_lease.py -q     # 3 failed, 3 passed
# 绿：修复后同一命令                                                                # 6 passed
# 既有 outbox/worker 相关测试（未改一行）                                            # 98 passed
# 真故障演练（Redis 6395，专用库）
POSTGRES_DB=acepass_acceptance_opt_w_drill REDIS_URL=redis://127.0.0.1:6395/0 \
  ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 ACEPASS_OUTBOX_LEASE_SECONDS=5 \
  ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub ACEPASS_INLINE_TASKS=false \
  PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py   # {"ok": true}
```

红/绿原始输出：`var/opt-w1/red-before.txt`、`green-after.txt`、`related-tests.txt`、`drill-after.txt`。
独立复验者用**自己写的**最坏时序反例（`send_task` 内起线程跑真实 `run_leased` 并 join，另一连接
`FOR UPDATE NOWAIT` 直接观测行锁）复现了同样的红→绿。

## 3. W2：热读路径查询数与行数解耦

| 用例 | before | after | 说明 |
|---|---:|---:|---|
| `GET /projects/{id}/questions?limit=50` | 123 q / 41.09 ms | **7 q / 5.65 ms** | `select_related("current_published_version")` + 两个相关子查询（最新版本号/题型）+ `Prefetch(to_attr)` 一次取本页可信答案键与主考点映射 |
| `GET /projects/{id}/practice-sessions?limit=50` | 67 q / 19.85 ms | **8 q / 4.84 ms** | `annotate(Count(..., distinct=True))` 取代逐行 `.count()`；`Prefetch(items)` 取代逐会话读取；**逐项验证门禁判断原样保留** |
| 其余 8 个端点 | 7/5/11/12/11/18/6/5 | 一字未变 | 无回归 |

- **行数无关**：独立复验者实测 5 行 → 40 行时 `practice-sessions` 22→127 变 **8→8**，`questions` 29→201 变 **7→7**。
- **行为不变**：作者用同库同行的 `fe68b07` 原文实现做对照，12 个变体全部逐字节相等；独立复验者把
  优化前处理函数从 `git show HEAD:` 抄成 oracle，自建夹具覆盖 subject/question_type/status/origin_type/
  search 命中与未命中/limit+offset/深 offset/空页/空科目/夹取 → **questions 15/15、sessions 6/6 全等**；
  门禁语义反例 5/5（同版本/同族/同谱系 `grading_hidden=true`、无关题 false）。
- **没有加索引、没有迁移**：EXPLAIN 在 5000 题 / 20000 会话规模下命中既有唯一索引与 FK 索引；
  20k 会话基准 65–72 ms（legacy 逐行 count 132–554 ms，相关子查询备选 86–93 ms 已否）。证据
  `var/opt-w2/explain-plans.txt`、`explain-at-scale.txt`。

## 4. W3：首屏不再携带路由与 KaTeX

| 产物 | before | after | 变化 |
|---|---:|---:|---:|
| 入口 JS `index-*.js` | 886,357 B | **39,762 B** | **4.5%** |
| 入口 JS gzip | 258,561 B | 12,490 B | 4.8% |
| 首屏 JS（入口 + 静态 import 图，3 chunks） | 886,357 B | **342,882 B** | **38.7%** |
| 入口 CSS | 36,459 B | 7,376 B | 20.2% |
| 按需 JS（首屏不下载） | 0 | 548,365 B / 16 chunks | 12 个路由页 + KaTeX |

做法：12 个路由页面改 `React.lazy` + 可见的 Suspense 加载态 + chunk 加载失败的错误边界与「重新加载」
（`HomePage` 保持同步，登录后落地页不二次往返）；KaTeX 与它的 CSS 只在真正渲染公式时
`await Promise.all([import('katex'), import('katex/dist/katex.min.css')])`，失败回落显示原始 LaTeX；
`manualChunks` 拆 vendor-react / vendor-query / vendor-katex。

**公式运行时验证**（两个来源，互相独立）：作者的浏览器探针与 Lead 亲自重跑
（`node frontend/perfprobe/math-probe.mjs`，`var/lead-verify/katex-runtime-probe.txt`）在 **dev 与生产
`vite preview` 两种模式**下都是：页面加载时 katex 请求 **0**，渲染公式后 **3**，`.katex` 生成且
`font-family` 含 `KaTeX_Main`（样式确实按需生效）。

**顺带修好的死门禁**：`npm run test`（vitest）在本轮之前就是坏的——没有 `include`，它会去收集
`tests/acceptance/*.spec.ts` 这些 Playwright 规格并失败（干净导出实测 **10 failed | 1 passed, exit 1**）。
`vite.config.ts` 加了 `test.include: ['src/**/*.test.{ts,tsx}']` 并补了 5 条行为锁用例。
独立复验者确认这是**修好而非放宽**：被排除的 10 个文件全部 `import '@playwright/test'`，改动前全仓库
唯一的非 Playwright 测试文件就是本轮新增那个（在新 include 内），`frontend/tests/**` 零改动，
Playwright 仍由自己的配置收集（86 tests / 9 files）。

## 5. 本轮执行的门禁（冻结版本，Lead 与独立复验者各自跑过）

```bash
cd backend && POSTGRES_DB=acepass_opt_lead POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q   # 501 passed
bash scripts/dev/optimization-gate.sh          # 全量 + ruff + check + makemigrations + 四组归档 + 探针
bash scripts/dev/measure-hot-paths.sh          # 查询数/耗时量尺（独立库 acepass_perfprobe）
```

| 门禁 | 基线 | 本轮实测 |
|---|---|---|
| 后端全量 | 489 passed | **501 passed / 0 failed / 0 skipped**（+12 = W1 6 条 + W2 6 条） |
| ruff / `manage.py check` / `makemigrations --check` | 干净 | 全部干净，`No changes detected` |
| 归档后端反例 p01 / p02 / p02-final | 11 / 9（+1 deselected）/ 3 | **11 / 9（+1 deselected）/ 3**，13 个文件逐一 `==HEAD` |
| 浏览器主套件 / stub 专跑 / 归档浏览器反例 | 78 / 8 / 2 | **78 / 8 / 2**，无 skip，两次之间重置库与空媒体目录 |
| 真故障演练 | `ok=true` | **`ok=true`**（真实 SIGKILL、真实 FLUSHALL，恢复 exactly-once，`unresolved={}`） |
| 前端 `typecheck` / `vitest` / `build` | vitest 死 | 全部通过（vitest 5 tests，见 §4） |

**没有任何既有测试文件被修改**：`git diff --name-only` 里不含任何 `test`/`spec` 文件，本轮测试全是新增
（`test_outbox_dispatch_lease.py`、`test_read_path_query_budget.py`、`Content.test.tsx`）。
`docs/review/2026-09-27/test_p0_regressions.py` 的 1 failed / 13 passed **优化前后逐条相同**，
是归档遗留（`test_image_service_invokes_configured_vision_provider`，其迁入副本在 `backend/tests` 通过），
与本轮无关，已单独记录而不是"顺手修掉"。

复验证据：[docs/review/2026-09-28/optimization/README.md](review/2026-09-28/optimization/README.md)
（含逐条结论、复现命令、39 个原始日志）。

## 6. 本轮如实登记的限制（不是通过项）

1. **并列 `created_at` 时 `practice-sessions` 的排列不同**：把某项目全部会话 `created_at` 强制成同一
   时间戳后，返回的**行集合与每行字段完全相同**，但顺序与优化前不同（两侧各自多次调用都自稳）。
   `order_by("-created_at")` 本就不是全序，叠加 `Count` 的 GROUP BY 后计划变了。正常数据（微秒时间戳
   不同）21 个用例逐字节一致，不可复现。**未修**：要契约化应补次级排序键，属下一轮候选。
2. **KaTeX 运行时渲染没有被常设验收套件覆盖**：`frontend/tests/**` 与归档 spec 没有一条提到
   katex/math，78 条浏览器用例只能证明首屏路由能打开。本轮用探针（作者 + Lead 各自跑）证明运行时
   正确，但**没有把它固化成回归测试**，属下一轮候选。
3. **过期 `processing` 行在并发扫描下可能被投递两次**：为保住"接管消费者必须能领取"的显式取舍，
   与修复前由行锁顺带避免的行为不同；消费者租约 + 幂等保证无重复副作用，但没有专门的并发测试。
4. **投递记录提交后、broker 调用前 dispatcher 被杀**：该行带整段租约等重投（与消息丢失同一恢复路径），
   未单独注入该时刻故障。
5. **性能口径有限**：只测查询数、响应字节与包体字节；没有吞吐压测、没有真实网络条件下的首屏测量，
   也没有生产规模的真实延迟统计。outbox 的"5.5 分钟"是租约 + beat 的推算，本轮实测的是"同一轮内完成"。
6. **仍未验证（外部阻塞，保持未验证）**：真实模型凭据（DeepSeek 账户 402 无余额）、真实 ≥24 小时间隔
   的学习效果、真实考试材料、远程部署与 GitHub Actions 实际执行。
