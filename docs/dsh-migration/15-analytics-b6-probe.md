# 15 analytics B6 探针：9 个报表 / 重判 HTTP 操作

日期：2026-11-06。方式：`dsh-plugin/scripts/probe_analytics_b6.py` 在一次性 PostgreSQL 测试库
（`test_acepass_b6_probe`，每次重建）上启动**真实 Django 5.2.17 + django-ninja 1.4.5**，
9 个操作全部走真实 Ninja 路由（`django.test.Client` 请求 `/api/v1/...`，`force_login` 登录，
JSON body、`Idempotency-Key` 头），不直接调用服务来“回答”请求。

种子世界是真实模型行：1 个项目、2 个科目、他用户名下 1 个项目；已发布大纲（父/子考点 + 权重 0 的
辅助考点）与 1 份未发布大纲；5 种计分题型各 1 题（含 1 道总分 10 的大题 rubric）、待核对答案、争议答案、
争议 rubric、无考点映射题、同名题目的两个版本；已发布 ExamSpecVersion（`choice_seconds=60`、
`fill_blank_seconds=90`、`constructed_response_seconds=600`）；练习/验证/过期模拟考会话；覆盖
fully confirmed、pending_review、部分确认、void、AI 估计、自评、失效、争议共 25 次作答；
7 张试卷（完整/未确认/未知/无有效版本/演示/草稿修订）。原始证据见
[15-analytics-b6-probe.json](./15-analytics-b6-probe.json)：**61 例**，sha256
`72e47a17…6f70af`，连续两次运行逐字节一致。

## 0. 覆盖

| 操作 | 例数 | 覆盖内容 |
|---|---|---|
| `GET …/reports/practice` | 11 | 默认写快照、`save_snapshot=false`、科目过滤、全部 7 个未完成理由、hidden 计数、参数解析 6 例 |
| `GET …/reports/calibration` | 3 | 全量分组、`assert_no_causal_summary`、科目过滤、样本不足组 |
| `GET …/reports/snapshots` | 7 | 排序、投影键、limit 省略/1/0/100/-3/abc |
| `GET …/papers/cycle-analysis` | 7 | 默认、max_cycles 1/0/99/abc、缺 `subject_id`、排除与阻塞原因 |
| `GET …/papers/coverage` | 2 | 7 张试卷行、completion 与最终/下界语义 |
| `POST …/regrades` | 18 | 201 写集、重放、409 三种、空格/超长键、7 条 400/404、代次/争议/版本场景 |
| `GET …/regrades/{id}` | 3 | 200、跨项目 404、未知 id 404 |
| `POST …/regrades/{id}/run` | 7 | 200、同键重放、新键 already_done、代次排序、执行时争议、证据失效 |
| `GET …/answer-reviews` | 2 | 24 行队列、`can_regrade`、rubric、`-created_at` 顺序 |

## 1. 九个操作的状态码与错误信封原文

- 报表类（practice / calibration / snapshots / cycle / coverage / answer-reviews / GET regrade）成功均为 **200**；
  `POST /regrades` 成功为 **201**；`POST /regrades/{id}/run` 成功 **200**（即使 run 内部 `status=failed`，见 B6-P4）。
- 统一错误信封 `{"error": {"code", "message", "details"}}`，实测原文：

| 场景 | 状态 | `code` | `message` 原文 |
|---|---|---|---|
| 他用户项目（X01–X07、G16） | 404 | `not_found` | `项目不存在或无权访问` |
| 题目不属于项目（G08） | 404 | `not_found` | `题目不存在或不属于该项目` |
| 答案不属于该题（G09） | 404 | `not_found` | `目标答案版本不存在或不属于该题目` |
| rubric 不属于该答案（G10） | 404 | `not_found` | `目标 rubric 不存在或不属于该答案版本` |
| 原因为空白（G11） | 400 | `invalid_input` | `重判必须说明原因` |
| 待核对 / 争议答案（G12/G13） | 400 | `invalid_input` | `重判目标必须是已核对且无争议的答案版本` |
| 争议 rubric（G14） | 400 | `invalid_input` | `重判目标 rubric 处于争议状态` |
| 未知 regrade id（G17） | 404 | `not_found` | `重判任务不存在或不属于该项目` |
| 缺幂等键（G04） | 409 | `idempotency_conflict` | `缺少 Idempotency-Key 请求头` |
| 幂等键 >200 字符（G05） | 409 | `idempotency_conflict` | `Idempotency-Key 过长` |
| 同键不同 body（G03） | 409 | `idempotency_conflict` | `相同幂等键使用了不同请求内容`，`details={reason:"same_key_different_payload", route_scope:"regrades.create:PROJECT"}` |
| 查询参数解析失败 | 400 | `invalid_input` | `请求参数校验失败`，`details.errors[0].type=bool_parsing / int_parsing / missing` |

## 2. 报表数字与快照写集

**R01 默认请求**（无 `subject_id`、`save_snapshot` 省略）：200，`row_delta={analytics_report_snapshot:+1,
audit_outbox_event:+1}`；`result_status=incomplete`，`attempts_in_scope=25`，`incomplete_attempts=9`，
`final_result=null`，`aggregate.status=partial_lower_bound`、`score_rate=null`、
`lower_bound=0.6892`、`unresolved_max_score=23.00`。

分桶（`totals`）：`fully_graded` 17 次 / 38.00 / 42.00、`partially_graded` 1、`pending_review` 5
（其中 confirmed 3.00）、`self_assessed` 1（10.00）、`assisted` 2、`strict_independent` 2、
`ai_estimated` 1、`repeat_practice` **25**（见 B6-P12）。

快照写集（`analytics_report_snapshot` 新行）：`report_kind=practice`、
`calculation_version=p0-2-c06`、`filters={"node_id":null,"subject_id":null}`、
`status=succeeded`、`is_stale=false`、`as_of=<now>`、`notes` 与响应 `notes` 完全相同（8 条），
`input_watermark={attempt_count:25, evidence_count:7, hidden_verification_attempts:1,
incomplete_attempts:9, latest_attempt_at:"2026-01-05T09:27:00+00:00", result_status:"incomplete"}`，
`payload` 即同一份报告（含 `as_of`）。

**R02** `save_snapshot=false`：零快照写入；与 R01 的 payload 除 `as_of` 外**逐键相等**
（`payload_identical_except_as_of=true`，`differing_keys=[]`）。

**R03** `subject_id=<同项目另一科目>`：`subject_id=SUBJECT_2`，`attempts_in_scope=1`，
`by_question_type=[single_choice]`，`by_knowledge_node=[NODE_2]`；**hidden 计数仍是项目级**：
`hidden_verification_attempts=1`、`hidden_verification_content_attempts=1`，与未过滤报告一致
（`hidden_counts_are_project_wide=true`）。

**R04 未完成范围**：7 个理由码全出现，计数 `unscored:1, pending_review:3, partially_confirmed:1,
disputed_content:2, invalidated_grade:1, void_grade:1, ai_estimated:1`（一次作答可带多个码，
9 次未完成作答共 10 条码）。`missing_note` 以
`尚未评分：这次作答没有有效判分记录，任何总分都不是最终结果；待人工评分：…` 开头、逐条拼接 7 句原文。
`excluded_evidence` 只有 1 行：`{attempt:ATTEMPT_INVALID, dimension:"unassisted_completion",
reasons:["hint_before_submit"], node_id:NODE_CHILD}`（另一条 `is_active=false` 的证据行未出现）。

**过期模拟考**：R01 前会话 `status=active`，报告返回后 `status=finished`、`finished_at` 等于
`exam_deadline`（2026-01-05T08:00:00Z）、`expired_at` 已写；该次作答（grade `pending_review`）出现在
`incomplete_scope.attempt_ids` 中（`attempt_in_incomplete_scope=true`），不再计入 hidden。
`hidden_verification_attempts=1` 来自另一条已下发题项的进行中验证会话；first_delivered_at 为空的验证题项
未被门禁计入（其同题练习作答仍在报告范围内）。

**Calibration**：`attempts_in_scope=24`、hidden 1/1、7 个分组、仅 1 组可给统计量
（`single_choice|score_le_2|within_limit|strictly_independent`，sample 12 / confirmed 9，
`mean=1.0000 median=1.0000 stdev=0.0000 min=max=1.0000`）；其余 6 组 `insufficient_sample`、
`statistics=null`，并在 `not_comparable` 里给出
`确认样本 0 < 5：不展示统计量，也不参与任何比较。`。`assert_no_causal_summary(payload)` 通过
（`{"passes": true, "error": null}`）。

**Snapshots**：`-as_of` 倒序（seed-3 → seed-2 → seed-1）；投影键恰为
`as_of, calculation_version, input_watermark, is_stale, notes, payload, report_kind, snapshot_id`
（**整份 payload 随列表返回**，见 B6-P10）。`limit` 1/0/100/-3 分别返回 1/1/3/1 行。

## 3. cycle / coverage 语义

**Y01**（默认 `max_cycles=5`）：`status=insufficient_cycles`、`complete_cycle_count=2`、
`used_cycle_count=2`、`used_cycles=["2024","2023"]`、`missing_complete_cycles=3`。
2024 周期 `denominator_total_score=4.000`、`scored_item_count=2`、`share_total=1.0000`，
节点：未分类 2.000（share 0.5000）、一元二次方程 1.200（0.3000，路径 `代数 / 一元二次方程`）、
代数 0.800（0.2000）——即 0.6/0.4 主权重按权重归一后分摊。2023 周期只有代数 1.000/1.0000。
`incomplete_cycles`：2025（`PAPER_2025B: revision_not_confirmed`，同周期的 2025A 自身
`countable=true` 但整周期不算）、2022（`demo_or_mock`）、2021（`coverage_incomplete`）、
2020（`no_effective_revision`）。`coverage_gaps` 只有 `辅助标签：计算`（权重 0 的辅助考点从未作为主映射）。

**V01**（同一科目 7 张试卷）：2020 `coverage_unknown`、0 分项、`coverage_rate=null`；2021
`coverage_incomplete`、rate null；2022 演示卷 `coverage_complete`、rate 1.0000；2023 complete 1.0000；
2024 complete 但 `scored_item_count=2 / unscored_item_count=1 / total_item_count=3` →
`coverage_rate=0.6667`、`coverage_rate_status=final`；2025 两卷（含一张 **draft** 修订）都是
`coverage_complete`、1.0000。科目级 `completion`：`status=partial_lower_bound`、
`coverage_rate=null`、`lower_bound=0.7143`、`papers_coverage_complete=5/7`，
`blocked=[PAPER_INCOMPLETE(coverage_incomplete), PAPER_NO_REVISION(no_effective_revision)]`，
`items={scored_total:7, unscored_total:1}`，`final_result=null`。

## 4. regrade：幂等、代次、争议

**创建（G01）**：201 body 为 `status="queued"`、`regraded_attempts=0`、`generation=1`、
`affected_attempts=2`、`scope="all_attempts"`、`requested_by=OWNER`；outbox 行
`topic=projection.run_regrade`、`dedupe_key=regrade-run:REGRADE_1`、`payload={regrade_run_id:REGRADE_1}`、
`status=processed`。但**同一请求返回时**数据库里的 run 已是 `status=succeeded`、`regraded_attempts=2`
（`config.settings.test` 的 `ACEPASS_INLINE_TASKS=True`，见 B6-P1）。行增量：
`analytics_regrade_run+1, audit_idempotency_record+1, audit_outbox_event+6, practice_grade_event+2,
practice_learning_evidence+6`（最后 6 行是 R01 入队的 `learning.on_session_finished` 在本次 dispatch
被消费后对模拟考作答重建的证据，不是重判写入——`evidence_for_expired_exam_attempt.count=6`）。

**幂等**：G02 同键同 body → 201，响应体与 G01 **完全相同**（`replay_matches_first_body=true`），
run 仍只有 1 条；G03 同键改 reason → 409 `same_key_different_payload`；G04 无键 → 409；G05 201 字符键 →
409 `Idempotency-Key 过长`；G06/G07 键 `"   b6-regrade-spaces   "` 与 `"b6-regrade-spaces"` 视为同一键
（第二次重放，`replay_matches_first_body=true`）。

**run**：G18 用新键执行已完成的 run → 200 `succeeded` / `regraded_attempts=2`，`practice_grade_event`
增量 0；G18R 同键重放 → 响应与 G18 完全相同、grade event 仍为 6 条；G19 再换新键 → 200，响应仍与 G18 相同（`same_body_as_G18=true`），grade event 仍为 6 条
（用例标题记为 already_done；JSON 只记录计数与响应不变）。

**代次（G20–G23，dispatcher 被抑制以保留 queued 状态）**：先建 A（generation=3）、再建 B（4），
两条都 `queued`。先跑 B：`regraded_attempts=2`，两个作答
`applied_regrade_generation=4`、`grading_revision` 3→4、grade event 6→8。再跑 A：200，
`regraded_attempts=0`、`stale_skipped_attempts=2`，grade event 仍 8 条、证据行仍 12 条、
两个作答的 `applied_regrade_generation` 仍为 4、`current_grade_event_id` 未变。

**执行时争议（G24/G25）**：建 run（generation=5）后把目标答案改为 `is_disputed=true`，再 run →
200，`status=failed`、`error_message="重判被拒绝：重判目标的答案版本已进入争议或不再是已核对状态，不能据此确认评分"`、
`regraded_attempts=0`、`stale_skipped_attempts=1`、`invalidated_evidence=1`。老作答（applied=0）当前
grade 变为 `invalidation/pending_review`、`confirmed_score=null`；applied=999 的较新作答完全不变
（`current_grade_event`、`grading_revision=1`、`status=confirmed`）。

**内容版本不同（G26/G27）**：目标答案属于 v2，而一次作答固定在 v1 → run 200 `succeeded`、
`regraded_attempts=1`、`invalidated_evidence=2`；v1 的两条证据行 `is_active=false`、
`invalidated_reason="题干版本不同，无法用新答案重判；证据失效"`、`invalidated_at` 已写。

## 5. 查询参数解析表

| 参数 | 值 | 状态 | 观测结果 |
|---|---|---|---|
| `save_snapshot` | 省略 | 200 | 写 1 条快照 |
| `save_snapshot` | `0` / `no` / `off` | 200 | 0 写入（falsey） |
| `save_snapshot` | `true` | 200 | 写 1 条快照（truthy） |
| `save_snapshot` | `2` / `abc` | 400 | `bool_parsing`：`Input should be a valid boolean, unable to interpret input` |
| `limit`（snapshots） | 省略 / `1` / `0` / `100` / `-3` | 200 | 3 / 1 / 1 / 3 / 1 行（`max(1, min(limit,50))`；50 上限因只有 3 行不可观测） |
| `limit` | `abc` | 400 | `int_parsing`：`Input should be a valid integer, unable to parse string as an integer` |
| `max_cycles` | 省略 | 200 | `cycle_horizon=5` |
| `max_cycles` | `1` | 200 | horizon=1，`used=1`，`missing=0`，**`status=ok`** |
| `max_cycles` | `0` | 200 | horizon=**5**（`int(max_cycles or 5)`），`missing=3` |
| `max_cycles` | `99` | 200 | horizon=**10**，`missing=8` |
| `max_cycles` | `abc` | 400 | `int_parsing` |
| `subject_id`（cycle） | 缺失 | 400 | `missing`：`Field required` |

## 6. 与直觉不同之处（B6-P）

- **B6-P1 `POST /regrades` 在 test 设置下同步执行**：201 body 说 `queued`/`regraded_attempts=0`，
  同一请求结束前 run 行已是 `succeeded`/`2`（G01）；随后 `POST .../run` 返回 200 且不写任何新结果（G18 的 `grade_events.delta=0`）。
  读到的 201 是“受理瞬间”的快照，不是执行结果。
- **B6-P2 重放返回过期的 201**：G02 的重放体与 G01 完全相同（`status:"queued"`、计数 0），
  而 `GET /regrades/{id}`（G15）返回 `succeeded`/2。客户端若拿重放体渲染会显示“排队中”。
- **B6-P3 `invalidated_evidence` 一字段两义**：正常分支计**证据行**（G27=2，对应 2 条 `is_active=false`），
  拒绝分支计**被转为待复核的作答数**（G25=1，对应 1 条 invalidation GradeEvent，证据行为 0）。
- **B6-P4 拒绝也是 200**：执行时目标争议不在 HTTP 层失败，`run` 返回 200 + `status:"failed"` +
  `error_message` 前缀 `重判被拒绝：`；`affected_attempts` 仍为 2（创建时冻结），
  `stale_skipped_attempts=1` 保护了较新代次的作答。
- **B6-P5 队列说可以重判、创建接口说不行**：`answer-reviews` 对 `B6-争议rubric`（答案 checked、
  rubric `R_CR3` 已争议）返回 `can_regrade=true / is_usable=true`，但用同一 rubric 建 regrade 得到 400
  `重判目标 rubric 处于争议状态`（G14）。`can_regrade` 只看答案、不看 rubric。
- **B6-P6 coverage 与 cycle-analysis 对同一试卷结论相反**：演示卷 2022 在 coverage 里
  `coverage_complete` 且计入 5/7 完成率，在 cycle 里是 `demo_or_mock`；2025 卷二（**draft** 修订但
  `expected=covered=1` 且有人工确认时间）在 coverage 里 `coverage_complete`，在 cycle 里
  `revision_not_confirmed`。`PaperRevision.coverage_status` 不看 `status` 字段。
- **B6-P7 “覆盖完整”的卷覆盖率不是 1**：2024 卷 2 个计分题 + 1 个 `is_scored=false` 材料项 →
  `coverage_rate=0.6667` 且 `coverage_rate_status=final`。覆盖率是 `计分题/全部题项`，
  不是“该周期场次覆盖率”。
- **B6-P8 `max_cycles` 三个语义混在一个参数里**：`0` 静默变 5（`or` 语义）、`99` 截到 10，
  而 `max_cycles=1` 时 `status` 从 `insufficient_cycles` 翻成 `ok`——`status` 比的是 `used >= horizon`，
  不是文档说的“近五年”。
- **B6-P9 `by_knowledge_node.weight` 是“该节点第一次出现的映射权重”**：`NODE_CHILD` 报
  `weight:"1.0000"`，尽管单选题映射是 0.6/0.4；辅助考点 `NODE_AUX` 生成 `attempts:1, max_score:0.000000,
  confirmed_fraction:null` 的桶——权重 0 的映射仍产生一行。
- **B6-P10 读接口会写库，且写下的消费者延后执行**：R01 这个 GET 让过期模拟考 `active→finished`
  并入队 1 条 outbox（`learning.on_session_finished`）；该事件不在本请求消费，而是在**下一条触发
  dispatch 的请求**（第一次 `POST /regrades`）里执行，一次重建 6 条证据行（G01 的 evidence +6）。
- **B6-P11 重判刷新事件把 subject id 当 paper_id**：`enqueued_outbox` 中
  `topic=projection.refresh_paper_stats`、`payload={"paper_id":"SUBJECT"}`——负载里是**科目** id，
  与事件名/消费端 `refresh_paper_stats(paper_id)` 期望的**试卷** id 不是同一类对象。
- **B6-P12 `totals.repeat_practice` 不是“重复练习次数”**：它累计**范围内全部**作答（25 次），
  而 notes 里“其中 1 次属于重复练习”来自 `repeat_practice` 证据行。同名字段两种口径。

## 7. 未覆盖 / 限制

- `answer-reviews` 的 `[:200]` 截断未实测：只种了 24 条答案（JSON 中 `seeded_over_200=false`）。
- snapshots 的 50 行上限无法观测（只有 3 条种子快照；`limit=100` 返回 3 行）。
- G20–G27 在脚本内**抑制了 outbox dispatcher**（`dispatch_after_commit` 置空，记录在用例里），
  否则创建即执行，无法观测 queued/generation 顺序；生产 Celery 路径本身未跑。
- 未覆盖分页/排序并列、PDF 导入、AI 估计写入路径与前端。

## 8. 复现

```bash
cd dsh-plugin
../backend/.venv/bin/python scripts/probe_analytics_b6.py
sha256sum ../docs/dsh-migration/15-analytics-b6-probe.json
```

两次运行结果：`72e47a17bc54fa10359adc08130ff1a660fe32ca0ebef2568f4a9592406f70af`
（61 例；UUID 一律符号化、种子时间戳固定为 2026-01-05T09:00:00Z 起算，
仅操作自身写入的时间字段记为 `<now>`，`question_ids` 等按原始 UUID 排序的列表在输出时按符号名重排）。
