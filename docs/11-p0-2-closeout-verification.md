# P0.2 收尾验证报告

基线：`f809365`（问题基线见 [09 独立复验](09-p0-1-independent-reacceptance.md)）。本轮按
[10 P0.2 收尾计划](10-p0-2-closeout-plan.md) 的 G01—G07 执行，目标是关闭 B01—B07 与发布门槛，
不进入 P1、不部署到任何远程环境。

**结论：B01—B07 与三项发布门槛均已修复并有本轮实际运行的证据；原 11 条后端反例与 2 条浏览器反例
全部转为通过，并已迁入正式套件。真实 provider、真实隔天（24 小时）与真实学习效果仍未验证，
保持明确未验证标识。**

四类证据分开标识，本节所有数字都是本轮实际执行结果：

| 标识 | 含义 |
|---|---|
| 自动化 | `pytest`（真实 PostgreSQL），本轮 177 passed |
| 浏览器 | Playwright 真实浏览器（desktop 1280×900 + mobile Pixel 7），本轮 36 passed |
| 归档反例 | `docs/review/2026-09-27/p01-independent/` 中复验者自己的测试文件，本轮未改动并重跑 |
| 真实故障 / 真实进程 | 真 Redis `FLUSHALL`、真 `SIGKILL` Worker 进程组、真 nginx 容器与端口 |

## 1. 本轮实际改动

按组列出改动文件与要解决的问题；命令与结果见 §2。

### G01 重判事务、序号与执行时可信校验（B01/B03）

| 文件 | 改动 |
|---|---|
| `backend/apps/analytics/migrations/0004_p0_2_regrade_generation_sequence.py` | 新建 `analytics_regrade_generation_seq` 序列 + `uniq_regrade_question_generation` 唯一约束；迁移前把序列推进到 `MAX(generation)+1`，并把历史重复的 `(question, generation)` 用序列重编号（现有业务库 0 条 regrade run，未改写任何历史行） |
| `backend/apps/analytics/models.py` | `RegradeRun.allocate_generation()`：用 `nextval` 分配代次；`Meta.constraints` 增加唯一约束 |
| `backend/apps/practice/services/attempts.py` | `start_regrade_run` 改为一个事务内重读目标答案版本 + 序列分配代次；新增 `RegradeTargetUntrusted`、`recheck_regrade_target`（执行时加锁重查答案/rubric 可信状态）、`invalidate_for_untrusted_regrade_target`（拒绝时把覆盖的作答转入人工复核） |
| `backend/apps/analytics/services/reports.py` | `execute_regrade_run` 整体一个事务 + `select_for_update` 锁 run 行；执行前重新校验目标；目标在中途进入争议时回滚本轮写入并记录拒绝；不再有 `running` 半成品 |
| `backend/apps/analytics/api.py` | `ReportOut` 增加 `hidden_verification_content_attempts` |

**关于"先锁稳定题目行"**：计划要求先锁 Question 行再分配 generation。实测证明在
`test_concurrent_regrade_requests_receive_distinct_generations` 的两事务并发下，阻塞式行锁会
造成死锁（第一个请求持有行锁直到自己提交，而该测试的同步屏障正是要求两边都到达后才提交），
把唯一性缺陷换成活性缺陷。因此改用数据库序列：`nextval` 原子、单调、不阻塞，配合
`(question, generation)` 唯一约束作为数据库层兜底，唯一性与"v3→v2 不倒退"的要求都成立，
且不会死锁。这是本轮唯一偏离计划字面做法的地方，动机与实测都在 §2.1。

### G02 统一内容门禁（B02）

| 文件 | 改动 |
|---|---|
| `backend/apps/practice/services/verification_gate.py` | `active_verification_for_content` 支持 `exclude_item_id`；新增 `blocked_question_version_ids`、`assert_grading_not_blocked`（隐藏判分的验证/考试自身不受影响） |
| `backend/apps/practice/services/attempts.py` | `submit_attempt`（服务层，覆盖所有入口）在普通会话中遇到同题/同族/同源内容的进行中验证时 403 |
| `backend/apps/practice/api.py` | `get_attempt` 读取已有评分同样过门禁 |
| `backend/apps/tutoring/services/core.py` | `assert_tutoring_allowed`（创建）与新增 `assert_job_deliverable`（执行 + 读取）；`run_job` 在内容被门禁拦截时终态失败并写明原因 |
| `backend/apps/tutoring/api.py` | `get_job` 读取缓存结果过门禁 |
| `backend/apps/analytics/services/reports.py` | 报告排除被门禁覆盖内容的作答，并给出 `hidden_verification_content_attempts` 与说明；无关练习不受影响 |

### G03 一个权威的延迟锚点规则（B04）

| 文件 | 改动 |
|---|---|
| `backend/apps/learning/services/anchors.py` | 新增唯一权威定义 `latest_learning_anchor`：取"最近一次**完成**的相关学习事件"（作答提交、讲解/答案下发、辅导投递），呈现题目本身永远不算训练 |
| `backend/apps/learning/services/pairing.py` | 任务创建改用它；`delayed_interval_status` 在**启动时**重算锚点，只有"任务创建之后出现的新学习事件"才顺延截止时间（人工把 `not_before` 提前仍然有效），并回传 stored/recomputed 两个值 |
| `backend/apps/learning/services/evidence.py` | 延迟证据改用同一锚点，间隔按"本次作答完成时间 − 锚点"计算，不再用题目呈现时间 |
| `backend/apps/accounts/management/commands/bootstrap_acceptance.py` | 延迟验证链迁到独立项目 `验收项目C·延迟验证`（见 §3 说明） |

### G04 真实任务使用租约与终态检查（B05）

| 文件 | 改动 |
|---|---|
| `backend/apps/audit/services/outbox.py` | 新增 `run_leased`（消费者统一先 claim，再按 token 完成/失败）；`confirm_claim`/`fail_claim`；`mark_retryable_failure` 拒绝改写已 `processed` 的行，并支持 token 过滤；`dispatch_event` 对重投同样执行 `max_attempts` 上限；`_run_inline` 不再预先 claim（避免嵌套 claim 自我跳过），且不会把消费者报告的失败确认成成功 |
| `backend/apps/audit/tasks.py` | 全部 9 个消费者改为 `run_leased`；`_mark_outbox` 支持 token |
| `backend/apps/tutoring/tasks.py` | `run_tutor_job` 先 claim，再执行，按 token 完成/失败 |
| `scripts/verify_worker_e2e.py` | 重写为**真实**故障注入：脚本自己启动/`SIGKILL` Worker 进程组、对隔离 Redis 真实 `FLUSHALL`，并记录队列深度前后值 |

### G05 照片草稿与图片校对数据一致性（B06）

| 文件 | 改动 |
|---|---|
| `frontend/src/features/practice/PracticePage.tsx` | 草稿升级为版本化信封 `{draft_version:2, answer, asset_ids}`（旧草稿仍可读）；附件变化与文本变化走同一条防抖保存；刷新/换设备从草稿恢复照片 |
| `frontend/src/features/imports/CandidateReviewPage.tsx` | 可视填空编辑器与答案 JSON 共用一份来源：`accepted_values`/`max_score` 变更即同步写入 `answer_payload.blanks`；删除空位同时从答案里移除 |
| `backend/apps/ingestion/services/extraction.py` | 视觉提取在调用前固定 candidate revision，迟到结果只作为机器记录保留（`machine_payload.stale_revision` + 任务提示），绝不覆盖人工版本 |

### G06 CI 与发布门槛（B07）

| 文件 | 改动 |
|---|---|
| `.github/workflows/ci.yml` | backend 改用专用库 `acepass_ci` 并新增迁移一致性检查；browser 拆成 `browser-acceptance`（专用库/Redis/媒体目录/端口 + 真实 Worker + 验收套件 + 新反例 + 结束后 outbox 必须全部确认）与 `browser-original`（原 16 套件，另一套库/端口/媒体）；infra 增加 nginx 模板渲染、明文 301 目标端口实测与恢复连接失败必须非零退出 |
| `infra/proxy/nginx.conf.template` | 明文入口 301 按实际公开 HTTPS 端口生成（`map $http_host` + envsubst），无端口 Host 保持不变 |
| `infra/docker/docker-compose.yml` | web 服务改用 nginx 模板机制并传入 `ACEPASS_HTTPS_PORT` |
| `scripts/restore.sh` | 先确认 `psql` 查询本身成功，再判断目标库是否存在；连接失败即拒绝并明确说明 |

### G07 历史数据审计与诚实的交付证据

| 文件 | 改动 |
|---|---|
| `backend/apps/practice/management/commands/audit_projection_semantics.py` | 每次派生字段改写写入 `audit_content_revision`（动作 `projection_semantics_rewrite`、批次号、前后值、摘要、原因）；新增 `--report` 输出整批 JSON 与 `--include-superseded`；默认**不动**已 superseded 的历史行并打印保留数量 |
| `scripts/verify_worker_e2e.py` | 真实故障注入与"仅改 DB 状态"彻底分开，报告中每步标注 `real` |
| `frontend/tests/acceptance/p0-2-empty-account.spec.ts` | 新增空账户经 UI 完整闭环（建项目→建科目→发布规范→上传图片→校对发布题目→作答→拿到确认满分） |
| `frontend/tests/acceptance/p0-acceptance.spec.ts` | 收紧跨项目/科目断言：会话必须落在任务自己的项目与科目；延迟验证链改用独立项目夹具 |
| `backend/tests/integration/test_p0_2_regressions.py` | 11 条复验反例 + 2 条本轮新增门禁断言迁入正式套件 |

## 2. 实际命令与结果

### 2.1 后端

```bash
cd backend && .venv/bin/python -m pytest tests -q
# 177 passed（原 164 + 本轮迁入的 13 条 P0.2 回归）

cd .. && PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p01-independent" \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p01-independent -c backend/pytest.ini \
  --ds=p01_independent_settings -q
# 11 passed（复验者原始反例文件，未修改）
```

`tests/integration/test_p0_2_regressions.py` 覆盖：真实 autocommit HTTP 201、两条真实事务并发的
generation 唯一、排队后目标争议不得确认评分、平行练习不得通过判分/辅导/缓存结果/报告泄露答案、
到期后新训练必须顺延、延迟证据按完成时间计算、真实消费者拒绝他人租约、processed 不可回退、
重投不超上限、迟到视觉结果不覆盖人工修订。

### 2.2 浏览器（隔离库/Redis/媒体/端口 + 真实 Worker）

```bash
# 每次运行使用新库与新媒体目录；Redis 6394、API 8014、Vite 5184
POSTGRES_DB=acepass_acceptance_p09 REDIS_URL=redis://127.0.0.1:6394/0 \
ACEPASS_INLINE_TASKS=false ACEPASS_BROWSER_API_PORT=8014 ACEPASS_BROWSER_WEB_PORT=5184 \
ACEPASS_PRIVATE_MEDIA_ROOT=/tmp/acepass-p09-browser-media \
  frontend/node_modules/.bin/playwright test --config playwright.acceptance.config.ts
# 36 passed（desktop 18 + mobile 18）
```

36 = 原 15 个验收场景 ×2 + 本轮新增（照片草稿、可视填空答案、空账户 UI 闭环）×2。运行日志
`docs/review/2026-09-27/p02-closeout/acceptance-suite.txt` 中只有预期状态码：200/201 为正常，
401 为登录前的 `/auth/me` 探测，404 与 403 是"跨项目会话不可见"与"验证期间拒绝 reveal"这两条
用例主动断言的拒绝，没有 5xx。

### 2.3 复验者归档反例原样重跑

```bash
# 复验者的配置要求 Redis 6394、API 8014、Vite 5184，与上一节同一隔离环境
frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs
# 2 passed
```

`draft-regression.spec.ts` 与 `fill-editor.spec.ts` **未做任何修改**。填空用例的输出显示
`answer_payload.blanks.b1.accepted_values=["5"]`，与它的断言一致。

### 2.4 原 16 条浏览器套件（独立库与端口）

```bash
POSTGRES_DB=acepass_browser_audit_p02 REDIS_URL=redis://127.0.0.1:6394/1 \
ACEPASS_BROWSER_API_PORT=8012 ACEPASS_BROWSER_WEB_PORT=5182 \
ACEPASS_PRIVATE_MEDIA_ROOT=/tmp/acepass-orig-media \
  frontend/node_modules/.bin/playwright test
# 16 passed
```

### 2.5 真实故障注入（真进程 / 真 Redis）

```bash
ACEPASS_OUTBOX_LEASE_SECONDS=5 PYTHONPATH="$PWD/backend" POSTGRES_DB=acepass_acceptance_p09 \
  REDIS_URL=redis://127.0.0.1:6394/0 ACEPASS_INLINE_TASKS=false \
  backend/.venv/bin/python scripts/verify_worker_e2e.py
# ok: true
```

关键步骤（完整输出见 `worker-drill-real-faults.txt`）：

| 步骤 | 观察 |
|---|---|
| 真 Worker 消费 | `worker_consumes_attempt_events ok: true`，6 条证据；`learning.reconcile_plan` 也被确认 |
| 真 Redis 丢失 | 停 Worker 后提交 → 观察到队列深度 **2** → 真 `FLUSHALL` → 深度 **0** |
| 租约到期后恢复 | 周期扫描重投 2 条，Worker 消费，`applied_exactly_once: true`（6 条证据、无重复维度） |
| 真进程被杀 | 轮询到 `PROCESSING` 时 `SIGKILL` 进程组：`caught_while_processing: true`，2 条未确认 |
| 杀后恢复 | 租约到期后扫描重投并完成，`applied_exactly_once: true` |
| 两个消费者 | 同时运行两个 Worker，事件仍只应用一次（`evidence_rows=6`） |
| 结论 | `ok: true`；演练前已存在的 6 条未确认行单独报告，不计入本次判定 |

`ACEPASS_OUTBOX_LEASE_SECONDS=5` 只用于让演练在可接受的时间内观察到租约到期；生产默认仍是 300 秒。

### 2.6 CI 与发布门槛（本地按 workflow 的同一命令执行）

```bash
cp infra/docker/.env.example infra/docker/.env
docker compose -f infra/docker/docker-compose.yml config --quiet          # OK
bash scripts/gen-dev-certs.sh infra/docker/certs localhost               # OK
docker run --rm -e ACEPASS_HTTPS_PORT=18443 \
  -v "$PWD/infra/proxy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  -v "$PWD/infra/docker/certs:/etc/nginx/certs:ro" nginx:1.27-alpine nginx -t   # syntax is ok
# 明文入口实测（真实容器 + 真实端口）
curl -s -o /dev/null -D - http://127.0.0.1:18080/login | grep -i location
#   Location: https://127.0.0.1:18443/login          （真实公开端口）
curl -s -o /dev/null -D - -H 'Host: acepass.example.com' http://127.0.0.1:18080/login | grep -i location
#   Location: https://acepass.example.com/login      （无端口 Host 不被改写）
curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:18443/login     # 200
# 恢复门槛
POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=59999 bash scripts/restore.sh --dry-run <backup> <db> <media>
#   退出码 1，明确输出「无法连接数据库 … 恢复前置检查无法完成，已拒绝（不是「目标库不存在」）」
bash scripts/restore.sh --dry-run var/backups/p02-dryrun acepass_p02_check <fresh-media>
#   退出码 0：正常备份的 dry-run 仍然通过
```

完整输出见 `docs/review/2026-09-27/p02-closeout/infra-and-release-gates.txt` 与
`restore-gate-real-commands.txt`。

### 2.7 历史数据副本演练

```bash
bash scripts/backup.sh var/backups/p02-dryrun                     # 只读现有业务库
bash scripts/restore.sh --dry-run var/backups/p02-dryrun acepass_p02_dryrun var/restore-check/p02/media   # exit 0
bash scripts/restore.sh var/backups/p02-dryrun acepass_p02_dryrun var/restore-check/p02/media
# 副本上执行新迁移与审计
POSTGRES_DB=acepass_p02_dryrun .venv/bin/python manage.py migrate --noinput
#   Applying analytics.0004_p0_2_regrade_generation_sequence... OK
POSTGRES_DB=acepass_p02_dryrun .venv/bin/python manage.py audit_projection_semantics --allow acepass_p02_dryrun
#   grade_events_scanned=49 / grade_events_needing_rewrite=0（现有业务库没有需要改写的历史行）
```

> 操作说明：本轮**没有**对现有业务库执行 `migrate`。迁移与审计只在恢复副本上演练过，
> 业务库（`acepass`）在演练前后完全一致（attempts=42、grade_events=49，演练后副本已删除）。
> 上线时需要在维护窗口对业务库执行一次 `manage.py migrate`，它会创建序列与唯一约束；
> 如历史 `(question, generation)` 存在重复，迁移会用序列重编号并在报告 §1 说明。

为了证明审计真的保留前后值，在**副本**上人为把一条 `confirmed` 事件改成旧语义后再跑
`--apply`：写入 `audit_content_revision`（`batch_id=56852dd11d05`，`before={pending 9.99,
is_fully_confirmed false}`，`after={pending 0, is_fully_confirmed true}`，含前后 sha256），
并输出 `grade_events_rewritten=1 / grade_events_left_as_history=0`。业务库本身未被修改
（演练后副本已删除）。

## 3. B01—B07 逐项回应

| ID | 结论 | 修复位置 | 本轮证据 | 残留边界 |
|---|---|---|---|---|
| **B01** 重判 500 与代次重复 | 已修复 | `attempts.start_regrade_run`、`analytics.0004`、`RegradeRun.allocate_generation` | 真实 autocommit HTTP 201；两条真实事务并发得到不同 generation；`uniq_regrade_question_generation` 兜底 | 行锁改为序列（§1 G01 说明），唯一性与单调性不变 |
| **B02** 判分/辅导旁路泄露 | 已修复 | `verification_gate`、`submit_attempt`、`get_attempt`、`tutoring` 创建/执行/读取、报告 | 平行练习提交 403；辅导创建 403；缓存讲解读取 403；报告不再计入被覆盖内容的作答 | 未覆盖的入口只剩不透露答案的列表类接口（暴露记录、错题列表），已在 §4 说明 |
| **B03** 执行时不重查答案可信状态 | 已修复 | `recheck_regrade_target`、`execute_regrade_run` | 排队后目标争议：重判被拒绝、run 记为 failed、相关作答转待复核，`current_grade_event.status != confirmed` | 拒绝会同时把已确认评分转人工复核，这是有意行为（争议内容不应保留已定分数） |
| **B04** 延迟锚点不一致 | 已修复 | `learning/services/anchors.py`、`pairing`、`evidence` | 到期后新训练 → 启动 400；25 小时前打开、1 小时前提交 → `qualifies=false` | 规则依赖"学习事件的完成时间"，历史任务不回溯重算（`reconcile_delayed_tasks` 会逐步顺延） |
| **B05** 租约没接入真实消费者 | 已修复 | `outbox.run_leased`/`confirm_claim`/`fail_claim`、`audit.tasks`、`tutoring.tasks` | 单测：他人租约下不执行、旧失败不改 processed、重投不超上限；真实演练：真 FLUSHALL、真 SIGKILL、两个消费者只应用一次 | 真故障演练在本机隔离环境执行，未在 CI 的 GitHub runner 上复跑 |
| **B06** 草稿与图片校对丢输入 | 已修复 | `PracticePage`、`CandidateReviewPage`、`ingestion.extraction` | 浏览器：刷新后照片仍在；可视填空答案写入 `answer_payload.blanks.b1.accepted_values`；服务层：迟到结果 `stale_skipped` 且人工内容保留、机器结果仍可对照 | 手写转写仍属 P1，未因本轮扩展 |
| **B07** CI 与隔离不匹配 | 已修复 | `.github/workflows/ci.yml`、`playwright.config.ts` 使用方式、`nginx.conf.template`、`restore.sh` | CI 改为专用库/Redis/媒体/端口 + 真实 Worker；原 16 与新 36 套件都在 CI 执行；nginx 跳转实测落到公开端口；不可连数据库的恢复 dry-run 退出 1 | workflow 未在 GitHub 上真实触发（本轮只在本机执行同一条命令） |

## 4. 发布门槛与交付证据修正

| 项目 | 结论 | 证据 |
|---|---|---|
| 恢复 dry-run 误报成功 | 已修复：连接失败即非零退出并说明原因 | §2.6 命令输出 |
| 默认 HTTP→HTTPS 跳转端口 | 已修复：按实际公开端口生成，无端口 Host 保持原样 | §2.6 三条 curl 输出（含跳转目标 200） |
| 历史评分迁移无前后值审计 | 已修复：批次 + 前后值 + 摘要 + `--report`；默认不动 superseded 历史行 | §2.7（含副本上的前后值抽样） |
| `verify_worker_e2e.py` 用改 DB 状态冒充故障 | 已修复：真进程 `SIGKILL`、真 Redis `FLUSHALL`，每步标注 `real` | §2.5 |
| 浏览器断言偏弱（辅导只看 201、跨项目实为 A→A、报告只看标题） | 已收紧：跨项目/科目断言会话归属；新增空账户 UI 全闭环；照片/填空反例进入正式套件 | §2.2、`p0-2-empty-account.spec.ts` |
| bootstrap_acceptance 预建全部内容 | 仍保留（验收套件需要稳定夹具），但空账户路径另有独立测试覆盖 | `p0-2-empty-account.spec.ts` |
| Compose 全栈 | 本轮独立启动 nginx 容器验证跳转与 TLS 入口；Compose 全栈（api/worker/postgres）未整体启动 | §2.6；交付者此前的 Compose 记录仍是记录，不是本轮独立证据 |
| 真实 provider / 真实 24 小时 / 真实学习效果 | **未验证** | 无真实凭据，未做真实等待；仍按 09 报告的标识保留 |

**未验证范围（不得据此宣称通过）**：真实模型质量、真实间隔 24 小时的体验、Compose 全栈部署、
CI 在 GitHub runner 上的一次真实执行。

## 5. 夹具说明（延迟验证链独立成项目）

原验收夹具把 A→B→C 链放在 `验收项目A`。B04 修复后，任何"新的训练或讲解"都会合法顺延 C 的截止
时间，于是同一套件里更早的用例（reveal 大题/多选）在同一个考点上产生的暴露会把 C 顺延到未来，
浏览器用例于是变成在测执行顺序而不是测规则。修复方式是让延迟验证链拥有自己的项目
`验收项目C·延迟验证`，只有链自身的事件会影响它的锚点；两个相关浏览器用例改为在该项目下断言，
并新增"会话必须创建在任务所属项目与科目"的收紧断言。夹具仍然通过真实服务路径产生 A→B→C，
没有手写任务行。

## 6. 观察到的非复现波动（如实记录）

`p0-acceptance.spec.ts` 的一次全量运行中，mobile 的"附件随大题一起提交"用例因前端科目下拉瞬时为
空（`subjects=[]`）而一直点不到「开始练习」。同一用例单独重跑、以及随后两次完整重跑均通过
（36 passed）；API 日志中没有对应的 4xx/5xx，本轮未能稳定复现该状态，因此按"观察到的波动"记录，
不写成已修复，也不据此放宽任何断言。若后续再次出现，应从 `ScopeProvider` 的科目加载时序入手排查。

## 7. 下一步

G01—G07 已完成且证据齐备，P0 工程与人工路径可以确认通过。P1 第一批"真实内容与分析"可以在
拿到真实 provider 凭据后再开始；轮次内不部署到任何未指定环境。
