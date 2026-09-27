# AcePass P0 验收结果

> **P0.2 收尾完成（2026-09-27，基线 f809365）：B01—B07 与发布门槛已关闭。**
> 后端 177 passed、新版浏览器验收 36 passed、原浏览器套件 16 passed；复验者原始 11 条后端反例
> （`docs/review/2026-09-27/p01-independent`，未修改）与 2 条归档浏览器反例全部转为通过。
> 逐条证据见 [P0.2 收尾验证报告](11-p0-2-closeout-verification.md) 与
> [p02-closeout 资产](review/2026-09-27/p02-closeout/README.md)。
> 问题基线 [P0.1 独立复验](09-p0-1-independent-reacceptance.md) 保留不删。

> **独立验收（2026-09-27）：P0 暂不通过。** 下文为原交付验收记录；当时复跑原套件通过，
> 新增后端回归 13 failed / 1 passed、新增浏览器回归 3 failed。见 [独立验收报告](06-independent-p0-review.md)。
>
> **P0.1 修复后重新验收：以下 A01—A42 结论全部重新成立，且原先不成立的项已补齐。**
> 逐条修复证据、新的运行命令与仍属未验证的范围见
> [P0.1 修复与重新验收报告](08-p0-1-repair-verification.md)。本轮新增：
> 后端 164 passed（含 35 条 P0 回归 + 10 条 outbox 契约）、原浏览器套件 16 passed
> （弱断言已加固）、新增浏览器验收 30 passed 0 skipped、真实 Worker 端到端 ok。

本文件记录**实际执行过的验收**。四类证据分开标识：

| 标识 | 含义 |
|---|---|
| 自动化 | `pytest`（单元 + PostgreSQL 集成），118+ 用例 |
| 浏览器 | Playwright 真实浏览器（desktop 1280×900 与 mobile Pixel 7）各 8 项 |
| 真实 provider | 需要真实模型凭据；**未配置，未运行** |
| 真实延迟 | 需要真实经过 24 小时；**未运行**，只有可注入时钟的逻辑测试 |

运行环境与命令见 `README.md`；实现范围见 `docs/implementation-status.md`。

- 代码版本：`4eb1de0`（P0.1；问题基线 `5428018`，审查 HEAD `7db03c5`）
- 夹具：`load_demo_fixture`，两个项目、三个科目、33 个可计分叶子题（单选 9、多选 6、判断 6、填空 6、大题 6）+ 3 个共享材料父题
- 实测命令（P0.1 重新验收）：
  - `cd backend && .venv/bin/python -m pytest -q` → **164 passed**
  - 原浏览器套件（强制隔离配置）→ **16 passed**
  - 新增浏览器验收 `playwright.acceptance.config.ts` → **30 passed, 0 skipped**
  - `scripts/verify_worker_e2e.py` → **ok: true**，outbox 全量 processed
  - `./scripts/backup.sh` + `./scripts/restore.sh var/backups/<ts> acepass_restore_check` → 计数与校验和一致

## 1. P0 用例逐条结果

| ID | 证据类型 | 结果 | 实际验证方式与观察 |
|---|---|---|---|
| A01 | 自动化 + 手工命令 | 通过 | 空库 `migrate` 成功；`create_account` 无默认密码；`test_login_and_me` 断言登录后 `needs_project_setup` 与预算字段 |
| A02 | 自动化 | 通过 | `test_login_required_and_csrf_enforced`：未登录 401，未带 CSRF 的跨站式 POST 被拒；`test_openapi_marks_authentication_on_business_routes` 证明仅 csrf/login/logout 匿名 |
| A03 | 自动化 + 浏览器 | 通过 | `test_two_projects_are_isolated`（题库/规范/会话跨项目 404）；浏览器用例切换项目后题库与科目随之变化，界面不残留 A 项目科目 |
| A04 | 自动化 | 通过 | `test_other_user_cannot_reach_known_ids`、`test_other_user_cannot_open_a_tutor_session`、`test_asset_access_rejects_foreign_and_missing_objects` 全部 404 |
| A05 | 自动化 | 通过 | `test_published_version_is_not_editable_in_place`：PATCH 已发布版本 400，正文未变；只能 `revisions` 建草稿 |
| A06 | 自动化 | 通过 | `test_labelled_template_parses_all_three_questions`：解析出题型/选项/答案且原文保留；负号与单位在 `test_negative_sign_and_units_survive_parsing` 中未被改写 |
| A07 | 自动化 | 通过 | `test_import_candidate_cannot_publish_with_blocking_problems`：缺选项 → `awaiting_review`，发布 422 且列出问题 |
| A08 | 自动化 | 通过 | `test_same_paper_reupload_does_not_double_count`：同一试卷身份重复登记只有 1 条；图片导入按 checksum 复用来源并提示疑似重复 |
| A09 | 自动化 | 通过 | 同 A07；另 `test_generated_answer_cannot_reach_practice_without_checked_answer` 证明未核对答案无法进入计分练习 |
| A10 | 自动化 + 浏览器 | 通过 | `test_single_choice_full_loop`（稳定 ID）、`test_true_false_false_is_graded_not_treated_as_blank`（false 记为正确而非漏答）、多选顺序无关 |
| A11 | 自动化 | 通过 | `test_multiple_choice_rule_differs_per_project`：A 项目少选 `{b}` = 2.00，B 项目同提交 = 0；错选按各自 `wrong_score`；`rule_snapshot` 保存当次规则 |
| A12 | 自动化 | 通过 | `test_fill_blank_only_applies_configured_normalisation`、`test_fill_blank_negative_sign_is_never_dropped`：仅做显式开关的归一化，`2` 不会匹配 `-2` |
| A13 | 自动化 | 通过 | `test_material_parent_produces_only_child_items`：材料父题建会话只产出 2 个叶子题项，分值 3+7，父题不计分 |
| A14 | 自动化 | 通过 | 同 A08；试卷自然键 `(subject, cycle_key, session_key, paper_code)` 唯一 |
| A15 | 自动化 | 通过 | `test_fill_blank_numeric_tolerance_boundary_is_inclusive`：10.1 通过、10.11 按规则判错；未知单位/表达式 `test_fill_blank_unknown_unit_or_expression_goes_to_review` 转待复核 |
| A16 | 自动化 | 通过 | `test_fill_blank_partial_confirmation_is_not_a_total_score`：确认 2.00 / 待评 1.00，`is_fully_confirmed=false`，不记 0 分 |
| A17 | 自动化 + 浏览器 | 通过 | `test_constructed_response_requires_criterion_by_criterion_confirmation`：全点确认得满分、超上限 400、漏必填 400；浏览器用例在 `/grading` 逐点打分并显示「自评确认」 |
| A18 | 自动化 | 通过 | 附件以追加式 `Attempt.attachments` 保存，重复提交被拒（`test_attempt_is_immutable_and_redo_requires_a_new_item`）；未实现手写识别，界面不伪造转写 |
| A19 | 自动化 | 通过 | `test_pre_submit_help_in_practice_blocks_strict_independent_evidence`：提交前 reveal + 提示 → `independent_correct.qualifies=false`，排除原因含「辅助」；`repeat_practice` 仍计入 |
| A20 | 自动化 | 通过 | `test_self_confirmed_grade_never_counts_as_independent`：`method=self_confirmed`，严格独立证据被排除；提交后 expose 不倒改提交前暴露 |
| A21 | 自动化 | 通过 | `test_submit_idempotency_same_key_replays_and_conflicts_otherwise`：同键重放同一 attempt、同键异载荷 409、新键重提 409；`test_practice_session_creation_is_idempotent` |
| A22 | 自动化 | 通过 | `test_regrade_creates_a_new_event_without_touching_history`：新增 `regrade` 事件，旧事件 `is_superseded=true` 且分数保留，二次执行不重复计数 |
| A23 | 自动化 | 通过 | `test_disputed_answer_sends_history_to_review_and_keeps_raw_answer`：争议后历史判分转待复核、原始作答不变 |
| A24 | 自动化 | 通过 | `test_import_job_retry_and_duplicate_detection`（复用来源不重复候选）+ outbox `dedupe_key` 唯一 + 发件箱扫描补发 |
| A25 | 自动化 | 通过 | `test_same_question_repeated_does_not_fake_distinct_evidence`：同题三次只有首次为严格独立，状态 `distinct_question_count=1`；`test_near_duplicate_family_is_not_unseen` |
| A26 | 自动化 | 通过 | `test_verification_hides_grading_and_blocks_every_parallel_entry`：辅导 403、题项/作答 reveal 403、含答案文件 403、会话视图无分数；结束后可见 |
| A27 | 自动化 + 浏览器 | 通过 | `test_draft_conflict_between_two_tabs`（旧 revision 409）；浏览器在 desktop 与 mobile 各完成五题型作答与草稿刷新恢复 |
| A28 | 自动化 | 通过 | `tests/integration/test_ai_providers.py`：超时/非法 JSON/未配置/伪造引用四种情形均明确失败且不进入正式内容；作答与确定性判分不受影响 |
| A29 | 自动化 | 通过 | `test_plan_never_exceeds_the_global_budget_and_replays_the_same_day`：`allocated_minutes ≤ daily_budget_minutes`；同日重试返回同一计划 |
| A30 | 自动化（可注入时钟） | 逻辑通过，**真实延迟未运行** | `test_delayed_interval_boundary_and_anchor_refresh`：23:59 未到期、24:00 到期；新教学事件使 `not_before` 后移并记 `anchor_updated`。真实等待 24 小时的证据不存在 |
| A31 | 自动化 | 通过 | `test_paired_task_is_created_once_per_origin_and_triggers_delayed_c`：A→B→C 各一个任务；`test_missing_delayed_question_is_recorded_not_faked`：缺 C 时写缺题记录，不冒充 |
| A32 | 自动化 | 通过 | 诊断为候选（`proposed`/`unknown`），`POST /attempts/{id}/diagnosis` 不写分数也不改状态；无过程证据时不推断粗心 |
| A33 | 自动化 + 浏览器 | 通过 | `test_report_separates_confirmed_pending_and_self_assessed`：`fully_confirmed`、`pending_review`、`self_assessed`、`assisted`、`repeat_practice`、`ai_estimated` 分列；报告保留 `excluded_evidence` |
| A34 | 自动化 | 通过 | `test_evidence_for_answer_dispute_is_invalidated`：争议后证据失效；AI 层只有 JSON 输出与产物表，没有数据库/文件写工具 |
| A35 | 手工命令（实测） | 通过 | 备份后恢复到空库空目录：attempts 30/30、grade_events 35/35、session_items 41/41、exposures 46/46、versions 324/324、answers 297/297、assets 2/2、tasks 19/19；媒体 SHA-256 校验通过 |
| A36 | 真实 provider | **未运行** | 没有任何 provider 凭据。已如实标注：`/ai-status` 返回未配置；stub 结果在 UI 与 `llm_run.is_stub` 标为测试/演示 |
| A37 | 自动化 | 通过 | `test_paired_task_is_created_once_per_origin_and_triggers_delayed_c`：未提交即可请求讲解（tutor 绑定题项），A 的讲解/重复读取/重判都只触发一个 B |
| A38 | 自动化 | 通过 | 未领取题无 `first_delivered_at`；恢复不重置（`test_single_choice_full_loop`）；验证结束前提交/查询/报告均无分数（A26 同用例） |
| A39 | 自动化 | 通过 | `test_stale_grading_revision_is_rejected`（旧 revision 409）；`test_admin_grading_own_attempt_is_self_confirmed`（管理员自评仍为 self） |
| A40 | 自动化 | 通过 | 发布可显式采用规范默认分值（`test_import_job_retry_and_duplicate_detection` 使用 `exam_spec_version_id`）；材料父题无答案且只给叶子建题项；配对任务唯一约束防重复 |
| A41 | 自动化（代码路径） | 通过 | `evidence._cross_project_lineage_seen` 在证据计算中检查同 owner 其他项目的答案暴露；两项目学习状态分别保存 |
| A42 | 自动化 | 通过 | `test_budget_is_split_with_largest_remainder_and_rotates`：60 分钟按 60/40 得 36/24；极小预算按日期轮换给能容纳整题的项目；同日结果确定 |

## 2. 浏览器验收明细（Playwright，desktop + mobile 各 8 项）

| 用例 | 观察结果 |
|---|---|
| 项目上下文与切换 | 顶部始终显示项目/科目；切换项目后题库数据随之变化 |
| 五题型作答 | 单选/多选/判断/填空/大题依次在真实浏览器中作答并提交，均出现判分或回执 |
| 草稿保存与恢复 | 输入后显示「已保存」，刷新页面草稿内容仍在 |
| 大题人工评分 | `/grading` 逐评分点打分后显示「自评确认」 |
| 按需讲解与答案暴露 | 练习中「查看答案与解析」后出现「答案与解析（已记录暴露）」 |
| 今日计划/复习/报告 | 生成计划显示预算分钟数与任务；复习页显示延迟任务；报告显示作答分类与按考点 |
| 考点地图 | 点击考点显示证据面板（有证据显示计数，无证据显示明确空态） |
| AI 状态 | 设置页显示 provider 与配置状态说明 |

## 3. 未运行项及其阻塞原因

| 项目 | 阻塞原因 | 影响范围 |
|---|---|---|
| A36 真实图片识别 + 真实讲解 | 没有 provider 凭据（`ACEPASS_AI_API_KEY` 等） | 只影响真实 AI 验证；手动录题、作答、判分、复习、计划、报告均可用 |
| 真实隔天（≥24h）延迟学习效果 | 需要真实经过 24 小时 | 只有可注入时钟的逻辑证据；**不得**据此声称隔天效果已验证 |
| Docker Compose 实际启动 | 本机 Docker 守护进程（OrbStack）未运行 | 只做了 `docker compose config` 语法与变量校验 |
| 远程部署 | 没有被授权的部署目标 | 未向任何服务器发布 |
| 真实考试内容质量 | 用户未提供真实试卷、评分细则、答案使用范围 | 夹具全部标注为演示；不冒充官方规则 |
| P1/P2 能力（PDF 批量导入、向量检索、FSRS、生成题、限时模拟考试、效果校准） | 按文档分期，未开始 | 未在界面提供入口，也没有标为已完成 |

## 4. 额外边界检查（自动化覆盖）

非法选项 ID、重复多选 ID、过大或伪造 MIME 图片、路径穿越（对象键由服务端生成并校验）、
未授权附件绑定、题干原始 HTML/脚本注入、撤回题与归档项目、过期 rubric/答案版本、
未知空位 ID、表达式不执行（`1/2` 不等于 `0.5` 且不 `eval`）、
`POST` 缺 `Idempotency-Key`、失败请求可用同键重试。
