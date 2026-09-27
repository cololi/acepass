# P0.1 修复与重新验收报告

本报告逐条回应 [独立验收报告](06-independent-p0-review.md) 的 R01—R12，并记录
[P0 修复计划](07-p0-repair-plan.md) 中 F01—F11 的实际执行证据。

- 问题基线：`5428018`（审查时的应用代码），审查 HEAD `7db03c5`。
- 本轮交付：`a794b1a`（后端）、`4eb1de0`（前端/浏览器验收/运维）。
- 证据目录：[review/2026-09-27](review/2026-09-27/README.md) 保留原始失败输出；
  本报告的运行输出见下文各节。

结论：**R01—R11 的 P0 业务阻断已消除并有可重复的运行证据；R12 的部署与恢复路径已实测。**
真实模型 provider、真实隔天体验仍为**未验证**（见第 4 节），本轮不声称通过。

---

## 1. 本轮实际运行的测试

所有命令在仓库根目录或注明目录下执行。浏览器套件使用独立数据库 / Redis / 端口 /
媒体目录 / 真实 Worker，**不触碰开发库**。

| 套件 | 命令 | 结果 |
|---|---|---|
| 后端全量 | `cd backend && .venv/bin/python -m pytest -q` | **164 passed**（原 119 + 新回归 45） |
| 原浏览器套件（已加固） | `frontend/.bin/playwright test --config playwright.config.ts` | **16 passed**（desktop + mobile） |
| 新增浏览器验收 | `frontend/.bin/playwright test --config playwright.acceptance.config.ts` | **30 passed**（desktop + mobile，0 skipped） |
| 真实 Worker 端到端 | `scripts/verify_worker_e2e.py` | **ok: true**（见第 3 节） |
| 静态检查 | `cd backend && .venv/bin/ruff check .` | All checks passed |
| 迁移一致性 | `manage.py makemigrations --check --dry-run` | No changes detected |
| 前端类型与构建 | `cd frontend && npx tsc --noEmit && npm run build` | 通过（仅有 >500 kB chunk 提示） |
| 生产设置门禁 | `ACEPASS_RUNTIME_MODE=production … manage.py check --deploy --fail-level WARNING` | exit 0 |
| Compose 全栈 | `docker compose up -d` + `curl -k https://127.0.0.1:8443/health/ready` | 8 服务 healthy；200 |
| 备份恢复演练 | `scripts/backup.sh` / `scripts/restore.sh` | 见 R12 |

**测试数量不再作为完成证据。** 下表每一项都指向具体的断言与运行证据。

---

## 2. R01—R11 逐条修复验证

### R01 · 复习和证据接口实际为 404 → 已修复

**原因**：`learning` 路由把 `project_id` 只写在函数签名里，django-ninja 因此把它当作
**查询参数**；前端请求的是 `/projects/{id}/learning-states` 等路径，实际不存在。

**修复**：`learning/api.py` 六条路由改为带 `/projects/{project_id}` 字面前缀，与其余
项目级路由一致（`common/api.py` 已说明该约定）；`plans`、`reconcile-delay` 同样处理。
新增 `/projects/{id}/mistakes` 提供「已确认错题」投影，`evidence` 支持
`subject_id`/`dimension` 过滤，`review-tasks` 支持 `subject_id`。

**验证**
- `backend/tests/integration/test_p0_regressions.py::test_project_learning_routes_match_frontend`
  （参数化 4 条端点）全部 200。
- `…::test_project_learning_routes_require_the_owning_project`：他人项目 404 仍成立。
- 浏览器：`review page loads its queues over 2xx and shows confirmed mistakes`、
  `knowledge page loads states and evidence over 2xx` 监听网络，断言相关请求无 4xx/5xx。
- 浏览器原套件同样加入 2xx 断言，取代原先只看标题的写法。

### R02 · 评分完成与满分正确混用 → 已修复

**修复**（语义分离，而非只改一个条件）
- `domain/grading/adapters.py`：`is_fully_confirmed` 改为「所有计分项均已判定」；
  新增只读 `GradeResult.is_correct`（已评完 **且** 达到满分）。`_finalize` 的
  `pending_max_score` 只累计真正未判定的分项，不再由 `满分 − 得分` 估算。
- `practice/services/attempts.py::confirm_grade`：待评分值由未确认分项求和；
  已判定分项写入评分方法。
- `learning/services/evidence.py`：`is_correct` 用新语义；`independent_correct`
  资格显式要求「已评完且满分」，未满分时排除原因写明「判分已完成但未达到满分」。
- `analytics/services/reports.py`：分桶按**完整性**（`fully_graded` /
  `partially_graded`），不再把 0 分错答或部分分归入「待评」；对外同时保留
  `fully_confirmed`/`partially_pending` 别名以兼容既有读取方。
- `practice/services/mistakes.py`（新）：错题＝已评完且未满分的作答；待评、自评、
  AI 估计、活动验证一律不出现。

**验证**
| 断言 | 测试 |
|---|---|
| 判断题错答 `status=confirmed`、`confirmed_score=0`、`pending_max_score=0`、`is_fully_confirmed=true`、`is_correct=false` | 后端 `test_wrong_objective_answer_is_fully_graded_but_not_correct`；浏览器 `a wrong objective answer is fully graded, scores 0, and is not called correct` |
| 大题 8/10 全部评分点确认后 `confirmed`、待评 0 | 后端 `test_all_manual_parts_confirmed_with_partial_score_is_final`；浏览器 `an answered constructed response can be confirmed criterion by criterion down to a real partial score`（真实点击评分页、断言 `grade-score` 显示 8/10） |
| 部分确认保留真实待评分值 | `test_rubric_partial_confirmation_keeps_only_undecided_value` |
| 必填评分点不能留空 | `test_required_rubric_criteria_cannot_be_left_unscored` |
| 0 分不构成严格独立证据 | `test_zero_score_is_not_independent_correct_evidence` |
| 报告分桶分离 | `test_report_bucket_separates_completeness_from_perfection` |

### R03 · 验证中泄分与另建 practice 取答案 → 已修复

**修复**
- `session_state` 在 `hides_grading` 时**不返回** `confirmed_score`/`pending_max_score`
  （不再只是 `score_visible=false` 却照旧下发数字），并给出 `score_hidden_reason`。
- `practice/services/verification_gate.py`（新）：基于内容的服务端门禁——同一题目版本、
  同一稳定题目、同一近重复家族、同一内容谱系中任一处于活动验证时，`reveal` 返回 403
  `purpose_not_allowed`。跨标签页、跨项目、另一会话同样受限。
- `grading-queue` 排除活动验证/考试的作答；`evidence` 投影、`mistakes`、报告分桶与
  排除原因同样排除隐藏运行，并在报告中返回 `hidden_verification_attempts`。
- `confirm_grade` 对活动验证**拒绝写入**（此前只隐藏响应，仍可改分）。

**验证**
- 后端：`test_active_verification_never_serializes_score`（会话/作答/报告/评分队列/证据/
  错题六个入口全部无分数）、`test_parallel_practice_cannot_reveal_active_verification`
  （同题另建 practice 后 reveal 403）、`test_confirm_grade_is_blocked_while_verification_is_active`、
  `test_verification_gate_is_content_based_not_a_blanket_ban`（无关内容不被误伤）。
- 浏览器：`an active verification returns no score anywhere and blocks reveal` —
  从「开始验证」进入后直接向服务器查询会话，断言 `mode=verification`、
  `score_visible=false`、分数为 `null`，并实际调用 reveal 断言 403 +
  `purpose_not_allowed`。

### R04 · 旧重判覆盖新答案 → 已修复

**修复**：`RegradeRun.generation` 为单调递增的**请求序号**，
`Attempt.applied_regrade_generation` 是只增不减的高水位。执行重判时若
`generation <= 已生效代次`，则判定该任务过期、不写入，并计入
`RegradeRun.stale_skipped_attempts`。申请序号用 `select_for_update` 串行化，避免并发同号。
原作答与全部 `grade_event` 保持不变，仅新增 superseding 事件。

**验证**：`test_older_regrade_late_completion_cannot_override_newer`（v3 先执行、v2 后执行，
最终仍为 v3 且得分满分，v2 记为 stale）、
`test_regrade_history_is_preserved_and_replay_is_idempotent`（初始事件与答案版本仍在，
重放不新增修订）。并发同号：`start_regrade_run` 的行锁保证序号唯一；执行期再次校验。

### R05 · 答案争议后仍继续自动判分 → 已修复

**修复**：提交与人工确认都在事务内重新读取固定答案/rubric 的**当前**可信状态
（`_content_trust_blocker`）。答案或 rubric 争议时仍保存原始作答，但生成
`pending_review` 的初次判分事件，`confirmed_score=null`、`pending_max_score=满分`，
不给出任何分数。人工确认遇到争议内容返回 403。

**验证**：`test_dispute_before_submit_must_not_use_disputed_key`（先呈现、再置争议、最后提交
→ `pending_review`，原始作答保留，只有一个 grade_event）、
`test_confirm_grade_refuses_a_disputed_rubric`。

### R06 · 延迟锚点与启动模式 → 已修复

**修复**
- `pairing._anchor_for` 新增 `include_moment`：C 的锚点必须能把**刚完成的 B 作答**
  作为锚点（此前严格 `<` 过滤使它只能锚定更早的 A 事件，导致「延迟」任务立即到期）。
- `delayed_interval_status` 在缺少 `ReviewTask` 行时仍从 `StudyTask` 自身读取间隔规则，
  不再返回「无需延迟」而静默移除门禁。
- `create_session` 在带 `task` 时**重新校验间隔**（拦截直接用 task_id 建会话绕过等待），
  并由任务用途**固定会话模式**（`delayed_verification`/`paired_immediate` → verification），
  客户端不能降级为 practice，也不能伪造 purpose。
- 前端所有「开始验证」入口把 `project`/`subject`/`task` 带入工作台 URL，工作台据此切换上下文。

**验证**
- 后端：`test_pairing_c_waits_24h_from_b_submission`（A 在 25 小时前、B 刚提交，
  断言 `not_before >= t_b + 24h` 且锚点 ≥ B 提交时间）、
  `test_delayed_task_cannot_be_started_before_its_deadline`（未到期建会话被拒 4xx，
  任务仍为 `pending`）、`test_task_purpose_fixes_verification_mode_server_side`
  （请求 practice，服务端返回 verification）、`test_delayed_purpose_cannot_be_forged_through_the_api`。
- 浏览器：`starting a delayed-verification task fixes the mode and the project server-side`
  ——验收夹具用真实服务路径生成 A→B→C 链（只把 C 的到期时间前移），浏览器点击「开始验证」
  后断言创建会话返回 `mode=verification`，且会话状态 `confirmed_score` 为 null。

### R07 · 图片导入不只是缺 Key → 已修复

**修复**
- `ingestion/api.py` 的 multipart 参数由 `list[File[UploadedFile]]` 改为
  `list[UploadedFile] = File(...)`。前者展开为 `list[Annotated[...]]`，django-ninja 的
  自动 File 判定失败而归类为 body，导致真实 multipart 报 400 `body.files Field required`。
- `ingestion/services/extraction.py`（新）：真正调用声明了 `extract_question` 的 provider，
  携带图片字节，校验输出，写入候选（`machine_payload` 记录 provider/model/prompt 版本/
  `is_stub`），失败时保留人工路径并记录问题。
- `start_image_import`：配置了视觉能力时记录 `input_kind="image_ai"` 并为每个候选入队
  `ingestion.extract_candidate`；未配置时保持 `image_manual` 并明确说明，不再声称链路可用。
- 修复 `audit/tasks.py` 中该任务对不存在模块 `services.extraction` 的导入。
- 校对页：显示**整页原图**（新增 `document_asset_id`）与模型原始输出；新增选项、空位、
  空位答案、rubric 编辑与原始 JSON 视图，可补齐五种题型结构。

**验证**
- `test_image_import_accepts_browser_multipart`：真实 multipart 201、`input_kind=image_ai`、
  provider 收到 `extract_question` 且 `request.images` 非空、产生 `LLMRun`。
- `test_image_import_falls_back_to_manual_without_a_vision_provider`：无 provider 时 201、
  `image_manual`、留下可校对候选且未伪造模型输出。
- `test_image_service_invokes_configured_vision_provider`：服务层直接调用同样走到 provider。

### R08 · 提交后辅导闭环不完整 → 已修复

**修复**
- `tutoring/services/core.py`：prompt 现在包含学生**作答原文**（按题型渲染）、
  **解题步骤**、自评把握、附件数量、rubric 逐条、空位、共享材料、考点名称；
  `_blocks_text` 不再丢弃 math 与 image 块（此前静默变成空串）。
- 删除重复定义的 `_attempt_summary`（后者曾遮蔽前者）。
- 提交后的 `SubmittedView` 提供「针对我的作答给提示」「完整讲解」，并在刷新后依然可用。

**验证**
- `test_personalized_prompt_contains_actual_answer_and_steps`（原文与步骤标记都出现在 prompt）、
  `test_prompt_carries_rubric_and_math_and_material_context`（rubric 文本进入 prompt）。
- `test_tutoring_is_refused_while_a_verification_is_active`（403）。
- 浏览器 `a submitted item exposes the tutoring entry after reload`：刷新后点击完整讲解，
  断言请求返回 201 或明确的 503 `ai_not_configured`（不把未配置当成功）。

### R09 · 刷新后答案入口损坏 → 已修复

**原因**：已有 attempt 时不加载 presentation，但 reveal 仍从 presentation 取题项 ID，
于是请求 `/session-items/undefined/reveal`。

**修复**：会话响应新增稳定的 `attempt_id` 与 `can_reveal`；reveal 与辅导全部改用
`attempt_id`/`session_item_id`，不再依赖一次性 presentation；刷新与深链接（错题列表→
「查看作答与辅导」）都能恢复。顺带修复了项目作用域解析前就发出
`/projects/undefined/...` 的请求。

**验证**：`test_submitted_item_can_still_be_revealed_by_attempt`、
`test_get_attempt_returns_the_submitted_work_for_restore`；
浏览器 `reveal after a reload uses the attempt route and returns 200`
（断言 200 且 URL 含 `/attempts/`）。

### R10 · 大题与多项目用户路径缺项 → 已修复

| 缺项 | 修复 | 验证 |
|---|---|---|
| 大题无照片上传 | PracticePage 附件编辑器（上传/预览/提交前删除；提交后只读） | 浏览器断言 `input[type=file]` 存在、上传 201、刷新后原图可见、`attachments` 长度 1 |
| 人工评分页不显示原始作答 | 评分队列返回 `raw_answer`/`steps`/`attachments`/`rubric`，页面同屏渲染 | 浏览器断言 `original-work` 含提交时的唯一标记、`grading-rubric` 含评分点文本 |
| 全局任务不切项目 | 任务链接携带 `project`/`subject`，工作台采纳 | 浏览器 `starting a delayed-verification task …` 断言服务端模式 |
| 新建科目需刷新 | `reloadSubjects()` 立即重取并选中新科目 | 浏览器断言新科目无需刷新即出现在下拉中 |
| 科目筛选不完整 | `review-tasks`/`evidence`/`mistakes` 支持 `subject_id`，前端同步传参 | 后端 `test_evidence_route_accepts_subject_and_dimension_filters`；浏览器断言切换科目后请求带 `subject_id` |

### R11 · 真实异步任务与恢复语义 → 已修复

**修复**
- 注册缺失的 `learning.reconcile_plan` 消费者并提供真实实现（`planner.reconcile_plan`）。
- 删除重复注册（`tutoring.run_job`、`audit.scan_outbox` 各曾定义两次）。
- outbox 增加 `processing` 状态、租约（`claimed_at`/`claim_token`/`lease_expires_at`）、
  尝试上限（`max_attempts`）与退避（`next_retry_at` 由 `available_at` 表达）；
  扫描器不再只看 `pending`，而是重投 `pending`/`dispatched`/`processing` 中租约已过期的行。
  `processed_at` 是唯一成功凭据，投递成功不再回写 `dispatched` 覆盖消费确认。
- `learning.*` 加入队列路由；`learning.refresh_delayed_tasks` 进入 beat（此前无生产者也无调度）。
- `docker-compose.yml` 恢复 Redis 持久化。

**验证**：真实 Worker 端到端脚本 `scripts/verify_worker_e2e.py`（输出见第 3 节）与
`backend/tests/integration/test_outbox_contract.py` 的 10 条契约测试（生产主题 vs 注册表
一致性、无重名任务、beat/imports 覆盖、内联确认不被降级、Redis 清空恢复、租约回收、
尝试上限与退避、未知主题不被静默标成功、重投不重复生效、消费者报告失败不被强制确认）。

---

## 3. 真实 Worker 端到端证据

命令（独立库、独立 Redis 6391、真实 Celery worker，`ACEPASS_INLINE_TASKS=false`）：

```bash
PYTHONPATH="$PWD/backend" POSTGRES_DB=acepass_acceptance_… \
  REDIS_URL=redis://127.0.0.1:6391/0 ACEPASS_INLINE_TASKS=false \
  DJANGO_SETTINGS_MODULE=config.settings.dev \
  backend/.venv/bin/python scripts/verify_worker_e2e.py
```

实际输出（节选）：

```json
{"step": "environment", "database": "acepass_acceptance_…", "inline": false}
{"step": "attempt_submitted", "attempt_id": "bfe2ac6b-…", "grade_status": "confirmed"}
{"step": "worker_consumes_attempt_events", "ok": true, "evidence_rows": 6, "paired_tasks": 1}
{"step": "worker_consumes_reconcile_plan", "ok": true, "status": "processed", "attempts": 1}
{"step": "flush_prepared", "rows": ["8424e6c7-…", "7c936358-…"]}
{"step": "flush_recovery_dispatched", "delivered": 2}
{"step": "redis_flush_recovery", "ok": true, "evidence_before": 0, "evidence_after": 6}
{"step": "killed_worker_recovery", "ok": true, "released": 1}
{"step": "final_state", "unresolved": {}, "outbox": 56, "processed": 56}
{"ok": true}
```

Worker 日志确认 12 个主题全部注册，且**此前会被丢弃**的主题被真实消费：

```
[tasks]
  . audit.scan_outbox
  . ingestion.extract_candidate
  . learning.on_attempt_graded
  . learning.on_session_finished
  . learning.reconcile_plan          ← 修复前不存在
  . learning.refresh_delayed_tasks
  . projection.rebuild_after_answer_change
  . projection.rebuild_attempt_evidence
  . projection.refresh_paper_stats
  . projection.regrade_effects
  . projection.run_regrade
  . tutoring.run_job

Task learning.reconcile_plan[777dd0a2-…] succeeded in 0.098s:
  'pending=30 delayed_updated=6 superseded=False'
```

浏览器验收运行结束后的库状态：outbox **50/50 processed、`unresolved={}`**，
144 条证据（6 个维度各 24）、3 条知识状态、8 个学习任务（1 个即时 B、7 个延迟 C）、
7 条 ReviewTask —— 即 A→B→C 与证据/状态投影确实由真实队列驱动完成。

---

## 4. 仍然未验证的部分（不声称通过）

| 项目 | 状态 | 原因 |
|---|---|---|
| 真实视觉模型识别 | **未验证** | 本机未配置 provider 凭据；链路已接通并有 stub/服务层测试，但没有真实模型样例 |
| 真实文本模型讲解 | **未验证** | 同上；浏览器断言只到「201 或明确 503 `ai_not_configured`」 |
| 真实隔天（24h）体验 | **未验证** | 规则用可注入时钟与真实时间戳验证；未经过真实一天的等待 |
| 真实考试真题与学习效果 | **未验证** | 验收夹具为自编题，明确标注；不代表真题质量或学习效果 |
| 远程部署 | **未执行** | 未获指定目标，按要求不向远程机器部署 |

「检测到视觉 provider 时会调用提取并产生 `LLMRun`」已用可注入 provider 验证；
这只证明业务链接通，不证明识别质量。

---

## 5. 对原验收结论的逐条回应

| 原报告结论 | 本轮结果 |
|---|---|
| R01 复习/证据 404 | 已修复；4 条端点 200 且有跨项目 404 断言 |
| R02 评分完成与满分混用 | 已修复；语义分离并更新 evidence/report/state，未只改条件 |
| R03 验证中泄分/旁路 | 已修复；会话/报告/队列/证据/错题/人工确认全部受门禁，另建 practice reveal 403 |
| R04 旧重判覆盖新重判 | 已修复；请求代次 + 高水位，乱序执行不回退，历史保留 |
| R05 争议后继续判分 | 已修复；保存原作答并转待评，人工确认拒绝 |
| R06 延迟锚点与启动模式 | 已修复；锚点含 B，未到期拒绝建会话，模式由服务端固定 |
| R07 图片导入非只缺 Key | 已修复；multipart 201、原图可见、全题型校对、真实调用视觉 provider |
| R08 辅导闭环不完整 | 已修复；prompt 含作答/步骤/rubric/材料，提交后入口存在且刷新可用 |
| R09 刷新后 reveal 损坏 | 已修复；改用稳定 attempt 路由，深链接可用 |
| R10 大题与多项目路径 | 已修复；照片、原始作答同屏、跨项目、新科目、科目筛选 |
| R11 异步与恢复语义 | 已修复；全主题注册、租约/退避/上限、丢队列与宕机可幂等恢复 |
| R12 Compose 与备份恢复 | 已修复并实测；TLS 方案统一、探针 200、空目录恢复、清单校验、CI 不再吞错 |
| 「五题型浏览器通过」 | 弱断言已替换：五类必须全部作答，断言真实分数/待评状态 |
| 「验证模式隐藏评分通过」 | 弱断言已替换：网络层断言无分数 + reveal 403 |
| 「图片识别仅缺 Key」 | 不成立 → 已接通并有调用证据；真实模型质量仍未验证 |
| 「备份 tasks 19/19」 | 不适用；改为对 outbox/异步恢复的独立验证 |

---

## 6. 迁移与投影处理

### 6.1 迁移（全部为追加字段，无破坏性操作）

| 迁移 | 内容 |
|---|---|
| `practice/0002_p0_1_grading_and_regrade_semantics` | `attempt.applied_regrade_generation` |
| `analytics/0003_p0_1_grading_and_regrade_semantics` | `regraderun.generation`、`regraderun.stale_skipped_attempts` |
| `audit/0002_p0_1_outbox_lease_and_recovery` | `outboxevent` 的 `claim_token`/`claimed_at`/`lease_expires_at`/`max_attempts`、`status` 选项与租约索引 |

`makemigrations --check --dry-run` → `No changes detected`。开发库在**先备份**
（`var/backups/pre-p01-*.sql`）后按序应用，三个应用完成后 `/health/live` 与
`/api/v1/auth/csrf` 仍为 200。

### 6.2 outbox 历史状态处置

旧实现把「broker 接受」当成功并写入 `dispatched`，而扫描器只扫 `pending`，因此
`dispatched` 事实上是终态；`learning.reconcile_plan` 这类没有消费者的主题会永久停留
在 `dispatched`（原报告记录的 103 条即此种状态）。

本轮**不把任何历史行直接改成 `processed`**。新扫描器改为重投
`pending`/`dispatched`/`processing` 中 `processed_at` 为空且租约已过期的行，
由消费者**幂等重放**来真正完成业务动作：

- `projection.rebuild_attempt_evidence` / `learning.on_attempt_graded` 都是
  `update_or_create` 型投影重建，重放不新增业务记录；
- `learning.reconcile_plan` 有 `dedupe_key`（`plan:{id}`）保护，重复投递只更新同一计划；
- `regrade` 以 `RegradeRun.status == SUCCEEDED` 短路，重放返回 `already_done`。

`OutboxEvent.max_attempts` 与 `available_at` 退避限制重试次数，避免「毒事件」无限重投；
`failed` 行保持终止态，由运维显式 `recover_stale(include_failed=True)` 或同 `dedupe_key`
的重新入队来复位 —— 不会被自动反复重投。

### 6.3 评分语义的历史投影更正

`is_fully_confirmed` 的语义在修复后不同，旧行携带旧含义。为此新增可审查命令
`manage.py audit_projection_semantics`：默认只读审计并列出差异，`--apply` 才改写
**派生字段**；命令默认拒绝在非专用验收库上运行，必须显式 `--allow <db>`。

- 隔离验收库（`08` 修复后的新库）dry-run：`grade_events_scanned=26`、
  `needing_rewrite=0`（该库的写入本就来自修复后代码）。
- 开发库（含旧代码写入的数据）dry-run：`grade_events_scanned=49`、
  **`needing_rewrite=15`**，全部是「0 分错答被旧逻辑记为未评完」这一种差异
  （`is_fully_confirmed False → True`），`evidence_active=0`。
- 应用后重跑审计：`needing_rewrite=0`。过程中未修改任何 `Attempt`、原始作答或
  `grade_event` 历史，只更新了 `status`/`pending_max_score`/`is_fully_confirmed`
  三个派生列，并按当前规则重建证据行。

未对真实业务库做任何清空或重建；所有新回归在独立测试库运行。重判与争议只新增
superseding 事件，不覆盖历史。

## 7. 是否申请进入 P1

原测试（164 后端 / 16 浏览器）与新回归（35 后端 / 30 浏览器）全部通过；空账户路径
（`bootstrap_acceptance` 从零建项目/科目/规范/题目，再完成全流程）与真实异步闭环
（真实 Redis + 真实 Worker + 丢队列/宕机恢复）均已实测。

**建议：进入 P1 首批（真实内容与分析）。** 唯一保留的未验证项是真实 provider 与真实
隔天体验，它们需要凭据与真实时间，不构成逻辑阻断；进入 P1 后应优先补这两项的真实证据，
并继续区分「规则验证」与「真实效果验证」。
