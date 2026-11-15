# 15 analytics B6：5 个报表查询 + regrade/answer-review 4 个操作

日期：2026-11-06。范围：阶段 3 的 **analytics 批次（B6）**——`backend/apps/analytics/api.py` 的
9 个路由：5 个报表读接口（practice / calibration / snapshots / cycle-analysis / coverage）与 4 个
重判/复核操作（创建 regrade、读取、立即执行、待复核答案队列）。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准；Django 实测证据见
[15-analytics-b6-probe.md](./15-analytics-b6-probe.md)，对拍差异见
[04-parity-findings.md](./04-parity-findings.md) §N。

## 0. 一句话结论

**analytics 9/9 完成，阶段 3 的 analytics 积压清零。** 三条硬要求都有可复现证据：

1. **报表不把未完成工作揉进一个“正式数字”**：`final_result` 在范围内仍有待评/部分确认/争议/失效/
   AI 估计时恒为 `null`，`aggregate.score_rate` 同时置空，只留标注下界的 `lower_bound`；
   `npm run verify` 的 580 条测试里，报告闭包与未完成范围逐字段对拍真实 Django。
2. **重判旧代次一行都不写**：黄金向量的 `old_generation_after_new` 与 HTTP 闭环都断言旧 run 的
   `regraded_attempts=0`、`stale_skipped_attempts` 计数、grade/evidence 行数不变；执行时目标争议
   走拒绝分支，把老作答转人工、保留较新代次的成果。
3. **重判不重复累加掌握次数**：重判后状态投影按 **active + grade_revision>0** 的证据重建一次；
   闭环测试断言“答对→重判成答错”后 `independent_correct_count` 从 1 变 0、旧 revision 证据只作历史保留。
   `npm run verify` 在系统 Node 24.22.2 与 DSH Electron Node 24.21 双运行时**580 条测试全绿**，
   Cordis 加载烟测通过（549 → 580，新增 31）。

## 1. 本批次完成面

| 交付 | 位置 | 说明 |
|---|---|---|
| 报表服务 | `src/services/analytics.ts` | `scopedAttempts`（双门禁）、`incompleteReasonCodes` / `incompleteScopePayload`、`reportAggregate`、`buildPracticeReport`（含快照写集）、`listSnapshots`、`paperCoverage`、`coverageCompletion`、`blockedQuestionVersionIds`（先结算过期模拟考） |
| 周期分析 | `src/services/cycles.ts` | `cycle_analysis` 整模块：只统计真实发生记录、周期完整性、主权重归一、未分类桶、coverage_gaps、insufficient_cycles |
| 效果校准 | `src/services/calibration.ts` | 分组（题型/难度代理/时限/暴露）、确认样本门槛、组内统计、可比性判定、`assertNoCausalSummary` 形状守卫 |
| 重判编排 | `src/services/regrade_runs.ts` | `requestRegrade` / `startRegradeRun`（generation 分配 + outbox）、`executeRegradeRun`（单事务、执行时复核、拒绝转人工、内容变更失效证据、状态重建、refresh 事件）、`regradePayload`、`pendingAnswerReviews` |
| 会话读路径 | `src/services/sessions.ts` | `expireSessionIfDue` / `expireDueMockExams`：报告前把过期模拟考结算为 finished（expired_at 记录服务器发现时刻） |
| 状态/证据 | `src/services/evidence_rebuild.ts`、`src/services/learning.ts` | 新增 `refreshStatesForAttempt`；状态投影补上 Python 的 `is_active=True, grade_revision>0` 过滤；验证内容门禁补上 `first_delivered_at` 过滤（未下发的题项不遮蔽报表） |
| worker | `src/jobs/worker.ts` | 消费 `projection.run_regrade`：创建接口只需入队，worker 与 `/run` 两条路径幂等收敛 |
| HTTP | `src/http/analytics_routes.ts` | 9 条路由；Django 的 I-Key 契约（trim/200 码点/409 + details）、Ninja 查询参数错误形状、`RegradeOut`/`ReportOut` 投影顺序 |
| 黄金向量 | `tests/golden/analytics_b6.json`（`scripts/gen_analytics_b6_golden.py`） | 一份真实行世界冻结：practice 报告（含快照写集）+ 3 个查询变体、coverage/completion、cycle ×2、calibration ×2、answer-reviews、4 组 regrade 写集；sha256 `558507835da84771b4acd5f4b15a35ccddc7588dfc8fa629c082b4a5069774d0`，重跑逐字节一致 |
| 测试 | `tests/analytics_b6_golden.test.ts`(5)、`tests/analytics_http.test.ts`(7)、`tests/calibration.test.ts`(10)、`tests/cycles.test.ts`(9) | 31 条 |
| 探针 | `scripts/probe_analytics_b6.py` → `15-analytics-b6-probe.{md,json}` | 61 例真实 Django HTTP（9 个操作全覆盖），sha256 `72e47a17bc54fa10359adc08130ff1a660fe32ca0ebef2568f4a9592406f70af`，重跑一致 |

**schema 无变更、无新依赖、无迁移**：只写已有列；`analytics_report_snapshot` / `analytics_regrade_run`
在阶段 2 已进 schema。

## 2. 报表：为什么先有“范围”，再有数字

### 2.1 两道光闸

`scopedAttempts` 是两份报表（practice / calibration）共用的唯一定义，Django 的 `reports.py:110` 同构：

1. **会话门禁**：`session.status=active` 且 `mode in (verification, mock_exam)` 的作答不进入任何桶——
   它们的分数不是“待评”，而是刻意不披露；用聚合把分数算出来与直接返回字段等价。
2. **内容门禁**：进行中验证覆盖的内容（同题、同题族、同内容谱系）上的平行练习也不进入——
   否则“练一道平行题”就能反推出答案。门禁只覆盖**已下发**的题项（`first_delivered_at` 非空），
   没有展示过的题项不可能泄露答案。

两个排除数都是**项目级**：`hidden_verification_attempts` 与 `hidden_verification_content_attempts`
即使传了 `subject_id` 也不缩小（探针 R03 钉住）。报告在构造范围前先 `expire_due_mock_exams`，
所以一个“标签一直开着但早已过期”的模拟考不会永久遮蔽成绩；探针记录了 `active→finished`、
`finished_at=exam_deadline`、`expired_at=<now>` 的完整写集。

### 2.2 未完成范围与最终结果

`INCOMPLETE_REASON_ORDER` 的 7 个码按顺序输出，码是**可叠加事实**：一次作答可以同时是
“待人工 + 部分确认 + 争议”，每码的 `attempt_count` 因此可重叠，`incomplete_attempts` 才是去重数。
`aggregate` 的分子只累加**真实存在的确认分**：部分确认的 rubric 把已确认小计计入下界，
AI 估计、void、争议一律不计；`score_rate` 只在没有任何未完成项时出现，否则为 `null`，
`lower_bound` 仍给出已确认部分的下界（`reports.py:274`）。

`totals.repeat_practice` 是**范围内全部作答**（Django 的原字段语义），不是“重复练习次数”；
后者来自证据维度 `repeat_practice`，notes 里的数字来自证据行（探针 B6-P12 记录了这个同名字段两义，
本移植按现状保留）。

### 2.3 快照

`GET .../reports/practice` 默认 `save_snapshot=true`：在一次请求内写一条
`analytics_report_snapshot`，`input_watermark` 冻结尝试数、隐藏数、最新作答时刻、active 证据数、
未完成数与结果状态；`filters` 冻结 subject/node；`payload` 就是同一份报告。黄金向量把**整行**写集
（除随机 id 用 `<snapshot:1>` 符号）冻结；HTTP 测试断言 `save_snapshot=false` 零写、
`0/no/off/False/N` 为假值、`2/abc/空串` 是 400 `bool_parsing`。

### 2.4 coverage 与 cycle-analysis 不是同一份口径

- `paper_coverage` 的 `coverage_status` 来自 `PaperRevision.coverage_status` 属性，
  **只看 `expected/covered` 与人工确认时间，不看 `revision.status`**；演示卷也可以
  `coverage_complete` 并进入科目完成率。`coverage_rate = 计分题数 / 全部题项`（含 `is_scored=false`
  的材料父项），所以“覆盖完整”的卷也可能只有 0.6667。
- `cycle_analysis` 额外要求 `source_kind=official_past`、非 demo、有效修订 `status=confirmed`，
  并要求**同周期全部已登记试卷都可计数**；少一个完整周期就 `insufficient_cycles` 并列出阻塞原因。
- 科目级 `coverage_completion` 只有在**每一张**试卷都 `coverage_complete` 时才给
  `coverage_rate`，否则 `null` + `lower_bound` + 具名阻塞试卷。

两份报告对同一张卷给出不同结论是 Django 的既有行为（探针 B6-P6），本移植按现状保留，没有把两者
“统一”成看起来更合理的一个口径。

## 3. 重判：generation 是唯一的排序权威

### 3.1 创建

`REGARDES.create:{project_id}` 的幂等指纹是 `RegradeIn` 默认值展开后的 JSON：
`{question_id, target_answer_key_version_id, target_rubric_version_id:null, reason, scope:"all_attempts"}`。
请求顺序与 Django 一致：body 校验 → 项目/题目/答案/rubric 作用域 404 → 空白原因 400 →
I-Key（缺键 409）→ claim → 状态复核（待核对/争议 400）→ 建 run（`affected_attempts` 在创建时冻结）
→ 入队 `projection.run_regrade`。响应 201 是**受理瞬间**的投影（`status=queued`）。

Django 在 test 设置下 `ACEPASS_INLINE_TASKS=True`，`after_commit_dispatch()` 会让同一请求内就执行 run，
于是 201 body 说 queued、数据库行已经 succeeded（探针 B6-P1/P2）。本移植按生产/异步语义返回 queued，
由 `/run` 或 worker 执行；幂等重放返回的是**第一次存储的 201 body**，与 `/run`/`GET` 的终态不同——
这是 Django 的“重放不重新投影”契约，不是缺陷，测试同时断言两处。

### 3.2 执行（单事务）

1. 读 run；已 `succeeded` → `already_done`（新键 `/run` 不再写）；
2. `recheck_regrade_target`：目标答案必须仍 `checked` 且无争议，rubric 不得争议；
3. 拒绝分支：把覆盖的作答转 `invalidation/pending_review`，但 **`applied_regrade_generation > run.generation`
   的作答完全不动**（`stale_skipped_attempts` 计数）；`invalidated_evidence` 记“被转人工的作答数”
   （与正常分支的“证据行数”同名字段不同义，探针 B6-P3）；
4. 正常分支：同内容版本 → 重新判分（新 `regrade` GradeEvent、supersede 旧行、`grading_revision+1`、
   `applied_regrade_generation` 只增不减、写 ContentRevision、入队证据重建）；
   不同内容版本 → 只失效 active 证据（`invalidated_evidence` 记行数，`stale` 记被护栏挡下的作答）；
5. 结束：一次 `refresh_states_for_attempt`（**不是每行证据一次**，这是“不重复累加”的关键）；
   入队 `projection.refresh_paper_stats`——Django 这里把 `subject_id` 当 `paper_id` 传，
   消费端查不到 Paper 静默返回 0，因此重判不会把快照标脏（KNOWN-B6-1，见 04 §N）。

### 3.3 幂等与查询参数

- 创建/执行都走与 ingestion 相同的 `regradeResource`：trim 后空键/200 码点超长 → 409
  `idempotency_conflict`；claim 与副作用同事务，失败回滚即释放；同键异载荷 409
  `details={route_scope, reason:"same_key_different_payload"}`；在飞 409 `in_flight`。
- 查询参数按 Pydantic/Ninja 实测形状：`save_snapshot` 接受 8 个布尔词（大小写不敏感、**不 trim**），
  其余 400 `bool_parsing`；`limit`/`max_cycles` 接受符号、数字间单下划线与整值小数串（`1.0`），
  `1.5/1e3/abc` 是 400 `int_parsing`；`subject_id` 缺失 400 `missing`；
  `max_cycles=0` 走 Python `or` 语义变 5，`99` 截到 10（探针 §5）。

## 4. 黄金向量与探针

`scripts/gen_analytics_b6_golden.py` 在一次性 PostgreSQL 库里造真实行，**冻结时钟**
（`patch django.utils.timezone.now`）后直接调用真实服务：

- practice 报告（默认写快照、`save_snapshot=false`、两个科目过滤）——payload、快照整行、排除证据；
- coverage / completion、cycle ×2（horizon 5/1）、calibration ×2（全项目/另一科目）、answer-reviews；
- 4 组 regrade：成功（2 改 1 跳）、内容版本失效、旧代次在新代次之后执行（0 写入）、执行时目标争议
  （拒绝 + 转人工 + 较新代次保留）。随机 run/grade id 用 `<run>` / 尝试名归一，节点/答案 id 保持
  真实 uuid（Python 对 `question_ids` 的排序是 uuid 字典序，符号化会改变顺序——这一点在生成器里钉住）。

Node 回放 `tests/analytics_b6_golden.test.ts` 把同一批行插进 SQLite（fixture 的 id 就是稳定符号或原始
uuid；作者/项目/科目等外键按插入顺序两阶段补齐：paper→effective_revision、attempt→current_grade），
再调用同一批函数；5 条测试覆盖全部冻结面，首次对拍即全绿。

`scripts/probe_analytics_b6.py` 用真实 Django + Ninja 路由记录 **61 例**：状态码、错误信封原文、
报表数字、快照写集、参数解析表、regrade 幂等/代次/争议/内容失效写集。报告见
[15-analytics-b6-probe.md](./15-analytics-b6-probe.md)，JSON 连续两次运行 sha256 一致。

## 5. 验证

```bash
cd dsh-plugin
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
npm run golden:analytics-b6   # 重跑生成器；sha256 应为 5585078…74d0
npm run verify                # typecheck → build → 580 测试（系统 Node + DSH Electron Node）→ 加载烟测
```

- 测试：**580 条全绿**（B6 新增 31：report/coverage/cycle/calibration/answer-review/regrade 黄金 5、
  HTTP 7、calibration 单测 10、cycles 单测 9）；`load-smoke OK`。
- 黄金向量：`558507835da84771b4acd5f4b15a35ccddc7588dfc8fa629c082b4a5069774d0`，重跑逐字节一致。
- 真实 Django 探针：61 例，`72e47a17bc54fa10359adc08130ff1a660fe32ca0ebef2568f4a9592406f70af`。

## 6. 已知边界

- **analytics 的 9 条路径都含 `:param`**，DSH 的精确路径 Fetch registry 挂不上（03 §3 的宿主约束），
  所以本批次只声称进程内 `Request→Response` 可达；浏览器验收要等阶段 6 的 Remote 通道。
- **calibration 的两个 `ok` 组不可比时 Django 会 500**：每个 verdict 都带 `delta: null`，
  而 `assert_no_causal_summary` 对非对象 delta 要求同行的 `sample_size/spread/caveats`，
  必然抛 `AssertionError`（`calibration.py:151-162`、`:383/390/401/407/414`）。本移植按现状复刻，
  没有为了“能返回”而改 payload；探针的 calibration 世界只有 1 个 `ok` 组，所以请求成功。
  该缺陷已登记 04 §N（KNOWN-B6-2），修复应单独立项（改守卫或改 verdict 形状都会改变冻结契约）。
- 过期模拟考的结算在 Node 里不写 `learning.on_session_finished` outbox（Django 写）：
  worker 没有该 topic 的消费者，写一条必然永久失败；报表数字不受影响（报告直接读 grade），
  但该会话的证据重建时机比 Django 晚。见 04 §N DIV-B6-3。
- `answer-reviews` 的 200 行截断与 snapshots 的 50 行上限没有在探针里触达（种子不足）；
  代码按 Django 的 `[:200]` / `max(1,min(limit,50))` 实现，但“截断行为”缺少真实 Django 观测。
- 真实模型、Web 客户端、SSE→Remote、备份/恢复仍不在本批次范围。
