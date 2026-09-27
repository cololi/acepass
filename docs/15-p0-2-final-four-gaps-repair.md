# P0.2 最后四组遗漏修复：C01、C02、C04、C05

日期：2026-09-27。起点：`2c87e0c`（复验审查 HEAD，工作区保留复验者新增的 `docs/14-*` 与
`docs/review/2026-09-27/p02-final-independent/`）。本轮提交：`7285991`。
问题基线：[14 最终独立复验](14-p0-2-final-independent-review.md)；任务书：`DEEPSEEK_P0_2_FINAL_GAPS.md`。

**结论：四组遗漏已修复并有本轮实测证据。** 正式后端 **203 passed**（194 + 本轮迁入 9 条）、
复验者三条原始反例原样 **3 passed**、上轮有效反例原样 **9 passed / 1 deselected**、
隔离浏览器 **36 passed**、归档浏览器 **2 passed**、真故障演练 **ok=true**、
仅提交内容的干净副本下代理组件与真实全栈 HTTPS/CSRF 登录均通过且环境哨兵保持不变。
C03、已修的争议拒绝分支、序列与歧义历史安全拒绝、受租约 Worker 的两阶段提交**未改动**。

**真实 provider、真实隔夜（≥24h）与真实学习效果、GitHub Actions 上的实际执行仍未验证**；
本轮没有新增证据可以改变这三项状态，因此继续保持未验证。

| 检查 | 本轮实测结果 | 证据 |
|---|---|---|
| 新增反例与正向恢复（正式套件） | **9 passed** | [official-final-gaps.txt](review/2026-09-27/p02-final-gaps/official-final-gaps.txt) |
| 复验者三条原始反例（文件未改） | **3 passed** | [reviewer-three-after-fix.txt](review/2026-09-27/p02-final-gaps/reviewer-three-after-fix.txt) |
| 上轮有效反例（文件未改，deselect 1 条已批准作废项） | **9 passed, 1 deselected** | [archived-nine-after-fix.txt](review/2026-09-27/p02-final-gaps/archived-nine-after-fix.txt) |
| 正式后端全套 | **203 passed, 216.90s** | [backend-suite.txt](review/2026-09-27/p02-final-gaps/backend-suite.txt) |
| Ruff / Django check / 迁移检查 | 通过 | 见 §6 |
| 隔离浏览器验收（真实 Worker，desktop+mobile） | **36 passed, 48.3s** | [browser-acceptance.txt](review/2026-09-27/p02-final-gaps/browser-acceptance.txt) |
| 归档浏览器反例（原文件未改） | **2 passed, 3.6s** | [archived-browser.txt](review/2026-09-27/p02-final-gaps/archived-browser.txt) |
| 真故障演练（真 FLUSHALL、真 SIGKILL、双消费者） | **ok=true** | [worker-drill.txt](review/2026-09-27/p02-final-gaps/worker-drill.txt)、[JSON](review/2026-09-27/p02-final-gaps/worker-drill.json) |
| 干净副本：代理组件 + 全栈 HTTPS/CSRF 登录 | 两步均 **exit 0** | [clean-export-release-gate.txt](review/2026-09-27/p02-final-gaps/clean-export-release-gate.txt) |
| 干净副本：隔离检查（哨兵/卷/网络/镜像/临时目录） | 全部保持 | 同上文件末段 |
| 最终前端类型检查与生产构建 | 通过（仅有既有大包体积提示） | 见 §6 |

## 1. C01 结束练习的幂等重放按当前门禁重新序列化

**问题（复验实测）**：普通练习正确提交并结束得 2 分，随后开启同题验证；详情 GET 已正确隐藏，
但用原幂等键重放 `POST /practice-sessions/{id}/finish` 仍返回 `confirmed_score="2.00"`、
`is_correct=true`、`score_visible=true`。原因是重放分支直接返回 `replay.body`（缓存响应）。

**修复**：[backend/apps/practice/api.py](backend/apps/practice/api.py) 的 `finish_session` 在重放分支
先按当前状态再执行一次 `finish_session`（已结束会话原样返回，不产生第二个结束事件），
再用 `session_state` **重新序列化**，与详情读取、`submit` 重放、tutor 消息重放共用同一条
内容门禁。幂等只保证"结束副作用不重复"，不再构成永久读取敏感响应的权限。

**验收（真实执行）**

| 断言 | 结果 |
|---|---|
| 验证进行中：重放返回 200，`confirmed_score=null`、嵌套 `grade=null`、`score_visible=false`，且与原始缓存 body 不同 | 通过 |
| 结束副作用恰好一次：`session-finished:{id}` 事件 1 条，`finished_at` 与首次结束一致 | 通过 |
| **正向恢复**：结束验证会话后，同一幂等键重放恢复真实分数与 `is_correct=true`，与详情 GET 一致 | 通过 |
| 复验者原始反例文件未修改，原样通过 | 通过 |

## 2. C02 不同题干版本的分支也先检查代次

**问题（复验实测）**：旧 qv1/gen1 任务在 qv2/gen2 已生效后执行，会把较新的 6 条有效 evidence
清成 0 条（grade 与水位保留），旧任务记 `invalidated_evidence=6`、`stale_skipped=0`。原因：
"题干版本不同"分支在进入 `regrade_attempt` 的代次检查之前就直接批量失效证据。

**修复**

| 文件 | 改动 |
|---|---|
| [attempts.py](backend/apps/practice/services/attempts.py) | 抽出 `lock_attempt_for_regrade`：**锁定 attempt 行 → 重新读取 → 判定代次**，成为所有重判分支的唯一判定入口；`regrade_attempt` 改为先判 stale 再做目标校验（旧任务对任何分支都只记跳过）；新增 `invalidate_evidence_for_content_change`：题干版本不同的分支先走同一锁定与代次判定，只有仍具权威的代次才失效证据，返回 `(invalidated, stale_skipped)` |
| [reports.py](backend/apps/analytics/services/reports.py) | 题干版本不同分支调用上述服务，把结果分别计入 `invalidated_evidence` 与 `stale_skipped_attempts`；不再直接写 `LearningEvidence` |

**验收（真实执行）**

| 断言 | 结果 |
|---|---|
| 复验者原始反例（文件未改）：旧任务执行后较新 evidence 集合完全不变，`current_grade_event` 与 `applied_regrade_generation` 不变 | 通过 |
| 该反例同时断言旧任务 `invalidated_evidence=0`、`stale_skipped_attempts=1`，且仍会重判它真正拥有的旧作答（`regraded_attempts=1`，水位按**作答**而非按题） | 通过 |
| **正向路径保留**：较新的 qv2 任务仍会把被内容修订取代的旧 evidence 失效，`invalidated_evidence=active_before`、`stale_skipped=0` | 通过 |
| C03 延迟边界、争议拒绝分支、序列方案与歧义历史安全拒绝 | 未改动，原反例继续通过 |

## 3. C04 HTTP 同步入口与 Worker 共享任务所有权

**问题（复验实测）**：生产 HTTP 在 autocommit、`ACEPASS_INLINE_TASKS=False` 下仍以 `claim=None`
调用模型；同一事件已被提交为 pending，真实 Worker 可以取得租约。Worker 先完成后，迟到的 HTTP
仍改写 job 结果与响应，助手消息却保留 Worker 内容：条数正确但**内容分裂**。

**修复**

| 文件 | 改动 |
|---|---|
| [tutoring/tasks.py](backend/apps/tutoring/tasks.py) | `run_tutor_job_now` 不再无租约执行：先取该 job 的 outbox 行并 `claim_event`，**与 Worker 争同一把租约**；拿不到就返回 `lease_not_acquired`，绝不调用模型、绝不写结果；成功路径由 `_finalize_success` 在同一事务内确认，失败路径用 `fail_claim` 归还 |
| [tutoring/api.py](backend/apps/tutoring/api.py) | `post_message` 按裁决处理：拿不到租约时不再自行生成内容，而是短暂等待（不持任何数据库锁）当前持有者完成最终提交，返回**已提交的**那一份结果；前端已有的 job 轮询接口继续可用 |
| [tutoring/services/core.py](backend/apps/tutoring/services/core.py) | `_write_job_result` 增加"无所有权不得覆写已终态"的兜底：`claim=None` 的调用者可以开始排队中的任务，但不能替换 succeeded/failed/unavailable 的结果——即"无所有权的成功覆写成功"也被挡住；新增 `wait_for_settlement`（纯读取 + sleep，不持锁） |

**验收（真实执行）**

| 断言 | 结果 |
|---|---|
| 复验者原始反例（文件未改）：真实 HTTP handler + 真实 outbox 行 + 真实 leased task 的确定性交错 | 通过 |
| 交错观测：provider 调用期间事件为 `processing` 且带本次运行的 claim token、租约有效；第二个消费者裁决 `skipped_lease_not_held` | 通过 |
| 模型调用恰好一次（`provider_calls=1`） | 通过 |
| 最终一致：job.result_blocks = HTTP 响应 = 助手消息 = `1 条`；曝光 `1 条`；outbox `processed`；`finalized_at` 已写 | 通过 |
| 模型网络请求仍在事务外（回调内断言 `connection.get_autocommit() is True`） | 通过 |
| 受租约 Worker 的两阶段提交、接管保护、崩溃恢复反例 | 未改动，原反例继续通过 |

允许的两种正确形态都已验证：正确持租约的 HTTP 使 Worker 跳过（本轮实现），测试不强求两次模型调用。

## 4. C05 干净 checkout 可运行且脚本自带隔离

**问题（复验实测）**：`.gitignore:3` 的 `.env.*` 吞掉了 `infra/docker/.env.example`，
`git archive HEAD` 导出的副本运行全栈脚本直接 `cp: ... No such file or directory`（退出 1），
CI 首步也依赖同一未提交文件；`verify_proxy.sh` 对默认项目 `acepass` 执行 `down -v --remove-orphans`
并直接覆盖 `infra/docker/.env`，组件检查还预先删除固定同名容器。

**修复**

| 文件 | 改动 |
|---|---|
| [.gitignore](.gitignore) | `.env` / `.env.*` 继续忽略真实配置，新增 `!.env.example` 与 `!**/.env.example`：**无真实密钥的模板被提交**（本机 `.env` 与模板内容一致，均为 `change-me` 占位，已确认不含真实凭据） |
| [infra/docker/.env.example](infra/docker/.env.example) | 已纳入版本库（此前未被跟踪） |
| [scripts/verify_proxy.sh](scripts/verify_proxy.sh) | 每次运行生成唯一身份：Compose 项目 `acepass-verify-<run>`、镜像标签、容器/网络名、**由内核分配的空闲端口**、临时 env 文件与**临时证书目录**；`--project-name` 与 `--env-file` 显式出现在每条 compose 命令上；**不读不写不复制 `infra/docker/.env`**（进程环境优先于项目 `.env`）；清理只针对本次运行的容器、网络、卷与带本次标签的镜像，成功与失败路径一致；组件检查使用唯一容器/网络名，**不再预删固定同名资源**；`guard_identity` 在启动时拒绝任何不唯一的名字 |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | 新增"提交内自带模板、且不得提交真实配置"门槛；Compose 校验改为 `--env-file infra/docker/.env.example`（不再写出 `.env`）；证书生成到 `$RUNNER_TEMP`；失败诊断步骤不再声称能读到已被清理的容器 |

**验收（真实执行，全部在 `git archive HEAD` 的干净副本中）**

| 断言 | 结果 |
|---|---|
| 干净副本自带 `infra/docker/.env.example`；`git check-ignore` 确认模板不被忽略、真实 `.env` 仍被忽略 | 通过（见正式套件用例） |
| 干净副本执行代理组件检查 | **exit 0**：301 目标、TLS、真实产物脚本资源 200、`api:8000` 上游解析 ok |
| 干净副本执行全栈检查 | **exit 0**：真实镜像构建、全部迁移、**经 HTTPS 代理的真实 CSRF 登录 HTTP 200**、会话可用 |
| 既有配置哨兵 `infra/docker/.env` 在成功与失败路径后均保持不变 | 通过（真实运行 + 安全 shim 两条路径） |
| 失败路径（构建失败）退出码原样传递（42），且仍完成自身清理 | 通过 |
| 无默认项目 `acepass` 的任何调用；`down --volumes` 只带本次唯一项目名 | 通过 |
| 组件检查不预删固定同名容器，移除的名字全部属于本次运行 | 通过 |
| 镜像清理只删除**带本次唯一标签**的镜像：自家标签删除、外部镜像（`redis:7-alpine`）拒删并告警 | 通过（新增正式用例；该缺陷在干净副本实跑中被发现并修正） |
| 运行结束后：无残留容器/网络/卷、无残留临时目录、既有 `acepass-backend:p0` 镜像保留 | 通过 |
| 未触碰开发者服务与数据库：8000/5173 仍在监听，Redis 6379 存活，业务库连接未被终止 | 通过 |

## 5. 迁入正式套件的回归（9 条）

[backend/tests/integration/test_p0_2_final_gaps.py](backend/tests/integration/test_p0_2_final_gaps.py)：
C01 两条（当前门禁重放、验证关闭后恢复）、C02 两条（旧代次保留较新证据、新任务合理失效旧证据）、
C04 一条（HTTP 与 Worker 共用租约，含 1 次模型调用/1 消息/1 曝光/内容一致的正向断言）、
C05 四条（全栈隔离、镜像只删自家标签、组件不删外部容器、模板可提交且真实配置仍被忽略）。
复验者原始反例文件与归档反例**均未修改**，继续作为基线独立运行。

## 6. 本轮实际执行的命令与结果

```bash
cd backend && .venv/bin/python -m pytest tests -q                      # 203 passed, 216.90s
.venv/bin/python -m pytest tests/integration/test_p0_2_final_gaps.py -q # 9 passed
.venv/bin/ruff check apps ai domain config tests                       # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check          # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes
ACEPASS_RUNTIME_MODE=production DJANGO_SETTINGS_MODULE=config.settings.prod \
  .venv/bin/python manage.py check --deploy --fail-level WARNING       # no issues (1 silenced)
cd frontend && npx tsc -b && npx vite build                           # 通过（既有 chunk 体积提示）
```

复验者反例与归档反例：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-final-independent" \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-final-independent/test_*.py \
  -c backend/pytest.ini --ds=review_settings -q                        # 3 passed
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-independent/test_*.py \
  -c backend/pytest.ini --ds=p02_independent_settings -q \
  -k 'not generation_migration_cannot_promote'                         # 9 passed, 1 deselected
```

浏览器（独占数据库、独占 Redis 6394、API 8014、Vite 5184、空媒体目录、真实 Worker）：

```bash
cd frontend && node_modules/.bin/playwright test --config playwright.acceptance.config.ts   # 36 passed
cd .. && frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs           # 2 passed
```

真故障演练（独占 Redis，显式允许 `FLUSHALL`）：

```bash
ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 POSTGRES_DB=acepass_acceptance_p02_final_gaps_drill \
REDIS_URL=redis://127.0.0.1:6394/0 ACEPASS_OUTBOX_LEASE_SECONDS=5 \
PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py            # ok: true
```

干净副本发布门槛：

```bash
CLEAN=$(mktemp -d) && git archive HEAD | tar -x -C "$CLEAN"
cp -R frontend/dist "$CLEAN/frontend/dist"          # 由提交中的前端源码构建的产物（CI 同样由 frontend 作业产出）
printf 'TEST_EXISTING_CONFIGURATION=...\n' > "$CLEAN/infra/docker/.env"   # 环境哨兵
cd "$CLEAN" && bash scripts/verify_proxy.sh component && bash scripts/verify_proxy.sh full-stack
```

## 7. 过程中发现并如实记录的两项观察（均未改动，属下一批）

1. **outbox 派发与消费者租约的竞争（既有行为，非本轮引入）**：`dispatch_pending` 在持有 outbox 行锁的
   事务里调用 `send_task`，而消费者 `claim_event` 使用 `select_for_update(skip_locked=True)`；
   反应足够快的 Worker 会在锁未释放时直接跳过（日志 `is not claimable by this consumer`），
   该事件随后停在 `dispatched` 并带 300 秒租约，靠周期扫描（生产 beat 每 30 秒）在租约到期后重投。
   本轮两次浏览器运行分别观察到"24 条被跳过"与"0 条被跳过"两种结果；被跳过的那次经扫描后
   **54/54 processed、0 unresolved、无重复副作用**。相同模式在此前独立复验的
   [p02-independent/browser-worker.txt](review/2026-09-27/p02-independent/browser-worker.txt) 中已存在，
   因此不是本轮改动引入；本轮**未修改**该逻辑，仅记录机制与证据
   （[browser-outbox-state.txt](review/2026-09-27/p02-final-gaps/browser-outbox-state.txt)）。
2. **共享开发库的连接上限**：本机 PostgreSQL `max_connections=100`，开发者服务常驻 40 条空闲连接，
   而 dev 设置 `CONN_MAX_AGE=60` 会让多线程 `runserver` 在 60 秒内累积连接。一次并发运行后端全套时，
   浏览器套件出现 3 条 `remaining connection slots are reserved` 失败（
   [并发运行日志](review/2026-09-27/p02-final-gaps/browser-acceptance-concurrent-with-backend-suite.txt)）。
   单独运行、并为验收进程设置 `POSTGRES_CONN_MAX_AGE=0` 后 **36 passed**。未终止任何开发者连接，
   也未放宽任何断言。

## 8. 边界与未验证项

- 未部署到任何环境；未读取或写出用户模型密钥；业务库 `acepass` **未执行 migrate**、未改写、未清理；
  本轮所有数据库都是新建的专用库（浏览器 `acepass_acceptance_p02_final_gaps*`、演练 `..._drill`、
  测试库由 pytest 创建/删除），运行后已删除，专用 Redis 6394 已停止。
- **真实 provider（图片识别/讲解）未验证**；C04 的 provider 为 stub，交错是确定性模拟。
- **真实隔夜（≥24 小时）与真实学习效果未验证**。
- **GitHub Actions 未实际执行**：CI 的模板门槛、Compose 校验、两个代理检查仍只在本机以同一脚本验证。
- 浏览器为 stub 讲解，非真实模型；故障演练的模型调用亦为 stub。
- 第 7 节两项观察属于本轮发现但**不在四组范围内**，未修改；建议与 P1 第一批一起评估。

## 9. 下一步（按复验报告 P1 顺序，本轮不启动）

先做不需要 API Key 的确定性工作：原生文字 PDF 批量导入与人工校对、考纲/词表人工映射、
只按真实试卷发生记录统计的真实周期分析；随后单独接入真实 AI 图片识别与按需讲解并做小规模人工核验；
真实间隔 ≥24 小时的使用记录单独验证。
