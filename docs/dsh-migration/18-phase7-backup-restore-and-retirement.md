# 18. B9：阶段 7 收尾（备份/恢复、真实库对账、运行时退役）与 B8 边界清账

> 状态：**已完成**（退役执行除外：Django 仍是在线对照实现，Celery/Redis/Docker 的前置条件未满足，
> 本轮交付可执行的残留检查与逐步退役清单，见 §4）。
> 本文只写已验证的事实；未验证的能力不写成已完成。

## 1. 结论

1. **备份/恢复**：`.acepass`（SQLite）有了可复现的 `npm run db:backup` / `db:restore` / `db:verify`。
   备份走 `VACUUM INTO` 的一致性快照（不复制正在写的文件），产物是「单文件快照 + manifest」；
   恢复前校验 sha256/行数/摘要，非空目标必须 `--force`，恢复前自动快照旧库、恢复后做完整性检查，
   失败自动回滚。备份中途 kill、恢复中途 kill 都用真实进程做过演练并有测试。
2. **真实库对账复跑**：对真实 PostgreSQL `acepass` 库重跑导出→导入→全量对账，**59/59 张表**行数与
   逐行摘要全等，统计数字逐项一致；03 §4 阶段 7 的出口判据可复现（见 §3）。过程中发现并修复了一个
   **真实的跨实现哈希缺陷**：JSON 里的 Python 浮点 `40.0` 被 `JSON.parse` 收成 `40`，manifest digest 只有
   56/59 可复现；修复后 59/59（见 §3.3、04 §Q8）。
3. **运行时退役**：Django 侧 Celery/Redis/Docker 的依赖面已逐项盘点（10 个 producer topic + 2 个 beat
   任务 + 3 个队列 + Redis 三用途 + 7 个 Compose 服务）。**本轮不删除 Django 生产代码**：Django 仍是
   行为真相源与回滚路径，退役前置条件未满足。本轮落地的是可执行的残留检查（DSH 插件运行时零依赖
   Celery/Redis/Postgres/Docker）与逐步退役/回滚清单（见 §4）。
4. **B8 边界清账**：`delayedIntervalStatus` 合并为单一实现；`on_explanation_delivered` 按 Django 移植
   但**不接生产路径**（Django 生产代码零调用，接了会创建 Django 不创建的 B 任务）；`Idempotency-Key`
   缺失统一为 Django 的 409 `idempotency_conflict`；规划器 reason_codes 与 Django 词表/追加语义对齐；
   向量通道确认属于 D-3，不擅自加 stub（见 §5、04 §Q）。

## 2. 备份与恢复

### 2.1 为什么不是 `cp`

`.acepass` 以 WAL 模式运行：已提交的最新事务可能在 `-wal` 文件里，主文件本身不是完整状态。
直接复制主文件会丢最新事务；在有写入者时复制还可能抓到撕裂页。备份因此必须走 SQLite 自己的
一致性机制。

实现选择 **`VACUUM INTO`**（`src/migrate/backup.ts::backupDatabase`），而不是 `sqlite.backup()`：

- `sqlite.backup()` 在**其他连接**提交时会从头重启；实测一个持续写入的库会让备份永远无法完成
  （B9 演练：1ms 一条写入时备份不返回）。这不是可接受的运维行为。
- `VACUUM INTO` 在一个读事务里取一致快照，其他进程可以继续写，不会重启，也不会饿死；
  实测 2,000 行基线 + 子进程持续写入时 25ms 完成，快照行数落在写入前后之间且完整性检查通过。
- 快照会继承源库的 `journal_mode=WAL`，备份完成后再 `PRAGMA journal_mode=DELETE`，产物是
  **单文件**（无 `-wal`/`-shm`），可以直接搬走。

### 2.2 产物格式

```text
<backup dir>/
  acepass.sqlite    一致快照（单文件、DELETE journal）
  manifest.json     format_version / created_at / source / snapshot / integrity / tables / media / tool
```

`manifest.json` 的关键字段：

| 字段 | 内容 |
|---|---|
| `snapshot.sha256` | 快照文件字节的 sha256 |
| `snapshot.bytes` / `pages` | 字节数与页数 |
| `integrity.schema_version` | 快照里的 `_acepass_meta.schema_version`（当前为 1） |
| `integrity.foreign_key_violations` | `PRAGMA foreign_key_check` 的行数（必须为 0） |
| `tables[]` | 每张表的行数与逐行摘要（canonical JSON，按主键排序；与迁移归档同一套摘要算法） |
| `total_rows` | 业务表总行数（不含 `_acepass_meta`） |
| `media` | `{ root, included: false }`——私有媒体不在 SQLite 备份内，见 §7 |

摘要算法复用 `src/migrate/archive.ts::tableDigestFromDatabase`：同一份数据从归档导入后再备份，
每张表的 digest 与归档 `manifest.json` 的 digest 可直接比较。这是「备份」与「迁移」两条链路
互相验证的接口。

### 2.3 命令

```bash
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
cd dsh-plugin

# 备份（在线；默认 <源目录>/backups/<name>-<UTC>）
npm run db:backup -- --db /path/to/.acepass/acepass.sqlite --out /path/to/backup
# 或按 dataRoot / 环境变量解析
npm run db:backup -- --data-root /path/to/.acepass
ACEPASS_DATA_ROOT=/path/to/.acepass npm run db:backup

# 只校验备份，不恢复
npm run db:verify -- --backup /path/to/backup

# 恢复（默认拒绝非空目标；--force 覆盖并保留恢复前副本）
npm run db:restore -- --backup /path/to/backup --db /path/to/.acepass/acepass.sqlite --force
```

路径解析优先级：`--db` → `--data-root` → `ACEPASS_DB` → `ACEPASS_DATA_ROOT` → `<cwd>/.acepass/acepass.sqlite`。
退出码：0 成功、1 失败、2 参数错误、3 校验失败、4 拒绝（目标非空/源缺失/目录已存在）。
stdout 最后一行是机器可读 JSON，人读摘要走 stderr。

### 2.4 一致性、拒绝与回滚

备份：

1. 源文件不存在/为空 → 拒绝（`source_missing`/`source_empty`）。
2. 目标目录已存在且无 `--force` → 拒绝（`destination_exists`）。
3. 写入 `<dest>.partial-<pid>/`：`VACUUM INTO` → 转 DELETE journal → 重新打开快照做
   `integrity_check`/`foreign_key_check`/schema_version/逐表行数与摘要 → 写 manifest → fsync。
4. 校验全部通过后才 `rename` 到最终目录；kill 在任何一步都只会留下 `.partial-<pid>`，
   下一次运行会清理「属主进程已不存在」的临时目录。
5. 源库 `schema_version` 与当前插件不一致 → 拒绝（`schema_version_mismatch`）。

恢复：

1. 先校验备份目录（manifest 格式、sha256、大小、schema_version、表数、逐表行数与摘要、外键）。
2. 目标非空且无 `--force` → 拒绝（`target_not_empty`）；目标有未合并 WAL 且无 `--force` →
   拒绝（`target_busy`）；目标不是 AcePass 库 → 拒绝（`target_not_acepass`/`target_not_a_database`）。
3. 覆盖前把当前目标库用 `VACUUM INTO` 快照到 `<target>.pre-restore-<ts>/acepass.sqlite`。
4. 复制备份快照到目标同目录的 `.restore-<pid>.tmp`，校验 sha256，删掉旧 `-wal`/`-shm`，
   原子 `rename` 到目标。
5. 重新打开目标做完整性检查（schema_version、表数、外键、逐表行数与摘要）；失败则用恢复前
   快照回滚，并以 `rolled_back: true` 报错。
6. 成功时保留恢复前副本（不自动删除），路径写进 JSON 输出。

**恢复契约是离线**：先停 DSH 应用。运行中的应用持有一个数据库连接，替换文件会让它的视图与
磁盘不一致；`-wal` 检查就是为了拦住这种情况（`--force` 可越过，但后果自负）。

### 2.5 崩溃/中断演练（真实文件、真实进程）

| 演练 | 注入点 | 结果 |
|---|---|---|
| 备份中途 kill | `ACEPASS_DB_CRASH_AT=snapshot`（快照写完、rename 前） | 退出 137；最终目录不存在；留下 `.partial-<pid>`；重跑成功并清理残留 |
| 恢复中途 kill（rename 前） | `ACEPASS_DB_CRASH_AT=copied` | 退出 137；目标仍是旧库；留下 `.restore-<pid>.tmp`；重跑成功 |
| 恢复中途 kill（rename 后、校验前） | `ACEPASS_DB_CRASH_AT=renamed` | 退出 137；目标是新库且可打开；重跑成功 |
| 恢复后校验失败 | 测试用 `onStage` 在 rename 后破坏目标 | 自动回滚；目标恢复为旧库；错误 `restore_failed` + `rolled_back: true` |

`ACEPASS_DB_CRASH_AT` 只由 CLI 读取，未设置时不产生任何行为；它存在是为了让 kill 点可复现，
而不是产品功能。测试：`tests/db_backup.test.ts`（12 条，真实临时文件 + 子进程）。

### 2.6 测试覆盖

`tests/db_backup.test.ts`：

1. 在线快照的 counts/digests/sha256 可校验；
2. 另一个进程持续写入时不撕裂、不饿死，快照行数落在前后区间；
3. WAL 中已提交但未 checkpoint 的行进入快照；
4. 恢复到新文件后逐表行数/摘要一致；
5. 非空目标无 `--force` 被拒，`--force` 覆盖且恢复前副本可读；
6. 篡改快照字节（sha256 不匹配）与篡改 manifest digest（行摘要不匹配）都被拒，目标未被动；
7. 备份 kill / 恢复 kill 的真实进程演练（上表）；
8. 恢复后校验失败自动回滚；
9. 路径解析优先级；
10. 源缺失/目标目录已存在的拒绝码；
11. 同一 `now` 下两次备份的 manifest（除时间戳外）逐字节一致。

## 3. 真实库对账复跑

### 3.1 命令与源库

```bash
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
cd dsh-plugin
node --experimental-strip-types scripts/reconcile_db.mjs \
  --database acepass --migrate-copy --out var/b9/recon-acepass --quiet
```

源库：本机 PostgreSQL **16.15** 的 `acepass`（真实数据：4 users / 4 projects / 6 subjects / 360 questions /
57 sessions / 42 attempts / 49 grade events / 64 exposure events）。该库**落后当前 Django 迁移**（**13 条未应用迁移，涉及 9 个 app**）：
51/59 业务表存在，缺 8 张表（`knowledge_relation`、`knowledge_tag_suggestion`、`memory_card`、
`memory_review_log`、`practice_answer_transcription`、`practice_diagnosis_follow_up`、`search_document`、
`tutoring_segment`），另有 7 张表各缺列（如 `practice_session.exam_started_at/expired_at`、
`ingestion_import_candidate` 缺 7 列）。驱动先做 schema introspection：

- 无 `--migrate-copy` → 退出 3，逐表逐列列出缺失项（**不静默导出子集**）；
- `--migrate-copy` → `CREATE DATABASE … TEMPLATE acepass`（有连接时回退 `pg_dump | psql`）克隆，
  只对克隆跑 Django `migrate`，从克隆导出，`finally` 删除克隆。源库只读；跑完复核仍为 60 表 /
  35 条 migration / 4 users / 4 projects / 360 questions / 57 sessions / 42 attempts（未变）。

### 3.2 结果（2026-11-07，耗时 4.2s）

| 检查 | 结果 |
|---|---|
| 表 | **59/59**（57 个声明模型 + 2 个自动 M2M through：`ingestion_import_candidate_source_regions`、`ingestion_import_job_documents`） |
| 行数 | **5383**，逐表 59/59 相等；28 张非空表、31 张空表 |
| 逐行摘要 | **59/59** 与归档 manifest 相等（含 3 张带浮点 JSON 的表，见 §3.3） |
| 统计 | **13/13** 相等：users 4 / projects 4 / subjects 6 / questions 360 / published_question_versions 360 / sessions 57 / attempts 42 / confirmed_attempts 28 / confirmed_score_total `58.00` / grade_events 49 / study_tasks 19 / study_plans 1 / exposure_events 64 |
| 归档内容哈希 | `content_sha256 = f36e63a3bcad233381762d26f4c4777474b83e26fa01b0ddd2ac47bb2715f18e`（两次运行一致） |
| manifest sha256 | `5c20b271…`（**每次不同**：`source.database` 是带时间戳的克隆名；可复现的是 content hash） |
| 迁移前后基线 | 13/13 无变化（克隆上跑 Django 迁移不改变业务数据） |

**出口判据**：03 §4 阶段 7 的「行数/哈希/统计数字一致」在真实库上可复现（`ok:true`、退出码 0）；
命令、归档与完整 JSON 报告在 `dsh-plugin/var/b9/recon-acepass/`。

### 3.3 对账发现并修复：浮点 JSON 的哈希契约（04 §Q8）

首轮复跑时 manifest（Python 侧）digest 只有 **56/59** 可复现，三张表对不上：
`accounts_user_settings`（`project_budget_percent` 里的 `40.0`/`60.0`）、`learning_study_plan`
（`allocation[].percent` 的 `40.0`）、`audit_idempotency_record`（`response_body` 里的浮点）。

根因：`archive.ts::readArchive` 用 `JSON.parse` 读 JSONL，把 Python 的 `40.0` 收成 JS 的 `40`；
`pyJsonCanonical` 于是输出 `40`，而 manifest 是 Python `json.dumps` 的 `40.0`。修复（`archive.ts` + `codec.ts`）：
`readArchive` 改用 `parsePyJson` 保留 `PyFloat`；JSON 列保留 token 交给 `encodeValue` 用 `pyJsonCanonical`
写库（其他列解包成 plain number）；`decodeForDigest` 的 JSON 分支用 `parsePyJson`。
修复后 **59/59** 全等；新增回归测试 `tests/migrate.test.ts::migration: a JSON float keeps Python 40.0…`。
这个 bug 之前的合成 drill 抓不到（没有浮点 JSON），只有真实库能暴露。

## 4. Celery/Redis/Docker 运行时退役

### 4.1 依赖面（只读盘点，证据 `dsh-plugin/var/b9/retirement-{inventory.md,report.json}`）

| 项 | 数量 / 内容 |
|---|---|
| Celery task | **12**（`apps/audit/tasks.py` 10 + `apps/tutoring/tasks.py` 1 + `config/celery.py` 1） |
| 队列 | **3**：`ingestion` / `tutoring` / `projection` |
| beat | **2**：`audit.scan_outbox`（30s）、`learning.refresh_delayed_tasks`（300s） |
| producer topic | **10**，15 个 `enqueue()` 调用点（逐条 file:line 已入表） |
| Redis | **3 处**：broker（db0）、result backend（db1，**死配置**：12 个 task 全 `ignore_result=True`、无 `AsyncResult`）、cache（db2，仅登录限流 + `/health/ready`） |
| Docker | **8 个服务**（postgres/redis/api/worker-ingestion/worker-tutoring/worker-projection/scheduler/web）、4 卷、1 网络 |
| CI | **5 个 job**（backend/infra/frontend/browser-acceptance/browser-original；后两个跑真实 celery worker） |
| DSH 插件运行时依赖 | 只有 `sharp` + `pdfjs-dist`（进程内库）+ peer `dsh-llm`/`dsh-tools` |

### 4.2 DSH 侧等价物与退役分类

| Django task | 队列 | DSH 等价物 | 退役判断 |
|---|---|---|---|
| `projection.run_regrade` | projection | 同名 topic + `executeRegradeRun`（`src/jobs/worker.ts`）；HTTP 另有内联「立即执行」 | 等价路径已生效；Django 退役后无需重建 |
| `learning.on_attempt_graded` | projection | 判分事务内同步调用 `onAttemptGraded`（幂等） | 同上 |
| `learning.refresh_delayed_tasks` | projection | 读取时重算 `delayedIntervalStatus` / `reconcileDelayedTasks` | 同上 |
| `tutoring.run_job` | tutoring | `POST …/messages` 内联执行（无模型时 201+`unavailable`） | 同上 |
| `ingestion.extract_candidate` | ingestion | `asyncHandlers` + `runOnceAsync`（B5） | 同上 |
| `learning.reconcile_plan` | projection | 无独立 consumer；`generatePlan` 直接物化任务 | 可作为 topic 退役，但必须先清 `audit_outbox_event` 的 pending 行（见 F3） |
| `audit.scan_outbox` | ingestion | `dispatchPending()` + `recoverStale()`；**无运行时循环**（F1） | **阻塞**：先接线 worker loop |
| `projection.rebuild_attempt_evidence` | projection | `rebuildEvidenceForAttempt`（topic 已改名 `evidence.rebuild_for_attempt`）；**无运行时循环**（F1） | **阻塞**：接线 + topic 映射 |
| `projection.refresh_paper_stats` | projection | `markProjectStaleForPaper`；**无运行时循环**（F1） | **阻塞**：接线 |
| `projection.regrade_effects` | projection | 只有 `refreshStatesForAttempt`，**不重建证据行** | **阻塞**：缺实现（F4） |
| `projection.rebuild_after_answer_change` | projection | **无**（连 `is_disputed:true` 写入路径都没有） | **阻塞**：缺实现（F4） |
| `learning.on_session_finished` | projection | **无**（`refreshSessionStates` 零命中） | **阻塞**：缺实现（F4） |

结论：**5 个 topic 在 DSH 侧已有等价路径**，Django 退役后不需要在 DSH 重建；**1 个可退但要清死行**；
**6 个被阻塞**（3 个只差 worker 接线/映射，3 个差能力实现）。这不代表现在可以停 Django 的 worker——
Django 仍是在线实现与回滚路径。

### 4.3 退役步骤与回滚（按依赖顺序，任一步可原地回滚）

| 步 | 动作 | 验证 | 回滚 |
|---|---|---|---|
| D0 | 切换前检查：`audit_outbox_event` 无未确认行、无未知 topic（`unresolved_summary() == {}`）；Django 侧停止写入 | 查询返回空；DSH 验收全绿 | 无操作 |
| D1 | 停 Celery worker（3 个）与 beat | `celery inspect active` 为空；outbox 不再新增 processed | `docker compose start worker-* scheduler`（outbox 行仍在，可重投） |
| D2 | 停 Redis | `redis-cli ping` 失败；DSH 侧无任何请求打到 6379 | `docker compose start redis`（AOF everysec，队列可恢复） |
| D3 | 删 Celery/Redis 配置与依赖（`config/celery.py`、`apps/*/tasks.py`、`CELERY_*`/`CACHES`、requirements） | `manage.py check` 通过；CI backend job 仍绿 | `git checkout -- backend/` |
| D4 | 停 Postgres（先完成数据迁移与只读窗口） | 导出→导入→对账全等（§3）；备份可恢复 | `docker compose start postgres`（卷仍在） |
| D5 | 停 api/web/nginx，删 `infra/docker/**` 与 CI 的 Docker/NGINX job | 浏览器验收在 DSH 侧通过 | `git checkout -- infra/ .github/` |
| D6 | 删 Django 代码与 `backend/`（最后一步） | 无任何 DSH 代码引用 `backend/`（残留检查 0 违规） | 从 git 恢复 |

**本轮实际执行**：只做了 D0 的**可执行前置检查工具**（`retirement-check.mjs`）与盘点；**没有**停任何服务、
删任何 Django 代码或 compose/CI。原因：D0 的切换条件（DSH 成为唯一写入方）未满足，F1–F4 未清零。

### 4.4 残留检查（本轮落地的可执行部分）

```bash
cd dsh-plugin
node scripts/retirement-check.mjs            # 真树：0 violation，exit 0
node scripts/retirement-check.mjs --list-files --out var/b9/retirement-check.json
node --test --experimental-strip-types tests/retirement.test.ts   # 17/17
```

扫描范围：`src/**`（去注释后的词法扫描）、`lib/index.js`、`lib/client.js`、`package.json` dependencies。
规则覆盖 import/require、`redis://`/`amqp://`/`postgres://`、端口 6379/5432、Celery/Redis 环境变量、
`docker compose`/`celery` 命令行、依赖名。真树输出：

```
retirement-check: 136 source files + bundles [lib/index.js, lib/client.js] + package.json, 6429669 bytes → 0 violation(s) [clean]
```

检查的边界：它是**静态**检查，证明「代码/依赖/配置里没有指向外部服务的引用」，不证明运行期行为
（动态拼接的 host:port 看不到）；需要时用 socket 观测补足。

### 4.5 阻塞项（下一批的前置条件）

| ID | 问题 | 影响 | 前置条件 |
|---|---|---|---|
| F1 | `src/jobs/worker.ts` 的 `runOnce/drain` 在 `src/` 内**零调用点**（只有测试导入） | 提交/判分 enqueue 的 `evidence.rebuild_for_attempt` 永不消费；证据/状态投影在真实使用中不更新 | 在插件生命周期内启动有界 worker loop（并处理验收夹具的时钟语义） |
| F2 | `plan.generated` 无 handler | 一旦 drain 会把该事件记为永久失败 | 增加 handler（或与 Django `learning.reconcile_plan` 对齐） |
| F3 | topic 改名（`evidence.rebuild_for_attempt` vs `projection.rebuild_attempt_evidence` 等） | 导入的 pending 行会变成未知 topic | 切换前清空 pending 行；或加映射层 |
| F4 | 3 个能力无 Node 等价实现（`regrade_effects` 证据重建、`rebuild_after_answer_change`、`on_session_finished`） | 不能声称 Celery 全量等价退役 | 逐项移植 + 探针/黄金向量 |


## 5. B8 已知边界清账

### 5.1 `delayedIntervalStatus`：两份实现合并为一份

- 唯一实现：`src/services/pairing.ts::delayedIntervalStatus`；`src/services/learning_extra.ts` 删除重复实现
  及其 `delayHoursFor`/`hours2`/`DEFAULT_DELAY_HOURS`，改为导入并 re-export（`sessions.ts` /
  `learning_extra_routes.ts` 的导入路径不变）。
- 行为修正：等待文案由 `toFixed(2)` 改为 `pyFormatFixed(remaining, 2)`，与 Django 的
  `f"{remaining:.2f}"` 逐字符一致（半数到偶，不是 JS 的半数远离零）。
- 证据：`b8_knowledge.json` 重跑生成器后 sha256 仍为 `24c1400124b3ff84f87fa6d170e92b11e2cf3e52ca2dad17e8a9f6523bebacf7`（逐字节相同）；
  `b8_pairing` 8/8、`b8_knowledge_golden` 3/3、`acceptance_seed` 6/6、`b8_learning_http` 8/8、`sessions` 8/8。

### 5.2 `pairing.on_explanation_delivered`：移植但**不接线**

- 按 `backend/apps/learning/services/pairing.py:199` 移植为
  `src/services/pairing.ts::onExplanationDelivered(db, itemId, now)`，幂等（同一 origin item 已有 B 任务时不重复创建；
  无合格配对题不伪造），+3 条测试。
- **Django 生产代码零调用**：`grep -rn "on_explanation_delivered" --include=*.py backend` 只命中定义行与
  `backend/tests/integration/test_learning_loop.py:141`（测试直接调用，用来验证幂等）；
  `pairing_service.` 的生产调用点只有 `delayed_interval_status`/`reconcile_delayed_tasks`/`on_attempt_graded`。
  Django 的讲解下发只写 `ExposureKind`，不调 pairing。
- 因此**不接进** reveal/tutoring 的生产路径：接了会创建 Django 不创建的 B 任务，属于行为偏离。记录为 W4。

### 5.3 `Idempotency-Key`：统一为 Django 的 409

- 决策：**统一**（不是保持两套）。Django `apps/common/api.py::idempotency_key` 的规则是：header 按 Python
  `str.strip()` 去空白；缺失/空 → **409 `idempotency_conflict`**；超过 200 个码点 → 同一 409。B3–B7 的
  `routes.ts::resource` 与 `study_routes.ts::effect` 返回 400 `invalid_input`，是迁移期的偏差。
- 落地：新增 `src/services/idempotency_key.ts`（`normaliseIdempotencyKey` / `requireIdempotencyKey`），
  `routes.ts`、`study_routes.ts`（effect + submit + confirm-grade）、`memory.ts` 改为走它；
  B8 新路由本来就按 Django 的 409，不动。
- 测试同步：`tests/http.test.ts`（3 处）、`tests/remote_channel.test.ts`（1 处）、`tests/b8_memory_http.test.ts`
  的 400 断言改为 409 + `idempotency_conflict` + Django 文案「缺少 Idempotency-Key 请求头」。
- 影响面：客户端对副作用请求始终带 key，验收不受影响；旧行为只有直接调用 API 且漏带 header 时可见。

### 5.4 规划器 `reason_codes`（04 §P16）

- **对账不受影响**：`reconcileArchive` 只比较导入行与归档 manifest 的逐表行数/摘要，不重新生成计划。
- **追加语义已对齐**：延迟候选为 `['due_delayed_verification', ...task.reason_codes]`；`materialiseTask`
  重用分支把 `reason_codes` 与 `plan_id` 一起写回（Django `planner.py:185,528-533`）。真实 Django 探针
  （`bootstrap_acceptance`，一次性 test DB）显示跨天每次生成再前缀一次（1→2→3），Node 探针逐项一致；
  Django 的重复追加行为被**照抄**（P16 是对齐，不是替 Django 清理）。
- **词表已对齐**：`delayed_due`→`due_delayed_verification`、`weak_node`→`weakness_repair`+`state_<summary>`、
  `undiagnosed`→`undiagnosed_node`、`general_pool`→`general_practice`。前端 `TodayPage` 的中文标签现在能命中
  「到期延迟验证 / 已确认薄弱点 / 该考点尚未诊断 / 补足剩余时间」。
- 已知边界：weak 分支的**前置重排**（`prerequisite_first`/`unblocks:`/`blocked_state_`）未移植（W1）；
  planner 新建任务的 `trigger_event` 仍取 `candidate.reason_codes[0]`，Django 留空 `''`（W2）。

### 5.5 向量通道

确认属于 **D-3**：DSH 不暴露 embed 端点，`channels.vector.available=false`、`code=vector_not_configured`、
`is_stub=false`，检索降级到关键词通道；`tests/b8_search_http.test.ts` 钉住该文案与排名。**没有加 stub**
（R-INV 4）。解除条件是在部署侧配置 D-3 的外挂嵌入端点，不是代码缺口。


## 6. 验证数字

### 6.1 单元/契约测试（双运行时）

| 批次 | 测试条数 | 说明 |
|---|---|---|
| B8 基线 | 681 | 系统 Node 24.22.2 + DSH Electron Node 24.21 |
| B9 新增 | **39** | 备份/恢复 12、浮点归档回归 1、边界清账 4（explanation 3 + plan reason code 1）、退役检查 17、真实库对账驱动 5 |
| 合计 | **720** | `npm run verify` 双运行时全绿 + 真实 Cordis/`dsh-tools` 加载烟测通过 |

`npm run verify`：typecheck → build → 720 条测试在系统 Node 24.22.2 与 DSH Electron Node 24.21
双运行时全绿 → `load-smoke OK`（插件在真实 Cordis 中加载、`acepass` 工具注册并执行）。

黄金向量重跑逐字节不变：`tests/golden/b8_knowledge.json`（sha256 `24c1400124b3…`）、
`tests/golden/planner.json`（sha256 `132775127cbe…`）。

### 6.2 浏览器验收（子集回归，不是全量）

B9 改了服务层行为（`Idempotency-Key` 409、规划器 reason_codes、`delayedIntervalStatus` 合并），
按任务约定用**隔离 DSH_HOME + 新夹具**跑相关 spec 子集：

```bash
cd dsh-plugin
node scripts/acceptance-server.mjs --fresh
cd ../frontend
ACEPASS_RUN=b9-subset ACEPASS_REPORT_JSON=../dsh-plugin/var/acceptance/b9-subset-report.json \
  npx playwright test -c playwright.dsh.config.ts --project=desktop \
  --grep "review page loads its queues|knowledge page loads states|starting a delayed-verification|failing learning endpoint"
```

结果：**4 passed / 12.0s**（`p0-acceptance.spec.ts:409/422/457/513`）。夹具：3 项目 / 5 科目 /
28 个已发布版本 / 延迟验证任务 2 条（`skipped: []`）。覆盖：review-tasks 的延迟状态、knowledge
evidence、延迟验证任务的服务端 mode、学习接口故障注入。

**未重跑**全量 main 78 + archive 3 + @stub 8：B8 的 **main 78/78、archive 3/3、@stub 0/8** 仍是最近一次
全量结果；B9 的改动没有触碰页面断言，子集 + 单测 + 黄金向量覆盖了改动面。全量重跑列入 B10 收尾
（与 outbox worker 接线一起做，避免两次 30 分钟跑）。

### 6.3 真实库与运行时

| 检查 | 结果 |
|---|---|
| 真实 PostgreSQL 对账 | 59/59 表、5383 行、59/59 digest、13/13 统计，`ok:true`（18 §3） |
| 备份/恢复测试 | 12/12（真实文件 + 子进程 kill 演练） |
| 退役残留检查 | 0 violation（136 源文件 + 2 bundle + package.json，17/17 测试） |

## 7. 已知边界

1. **备份只覆盖 SQLite**：私有媒体（`<dataRoot>/private-media` 的图片/PDF）不在备份目录内；
   manifest 记录了 `media.root` 与 `included:false`。完整灾难恢复需要同时复制该目录（或后续
   增加 `--include-media`）。这是本轮明确的范围边界，不写成已完成。
2. **恢复必须离线**：没有跨进程的数据库锁协议；运行中的 DSH 不会被检测到，只能靠 `-wal` 提示
   与操作纪律。`--force` 可越过 WAL 检查，属于操作者显式承担风险。
3. **备份没有签名/加密**：manifest 的 sha256 防的是传输/磁盘损坏与误改，不防恶意重写
   （能同时改快照与 manifest 的人可以伪造一份自洽的备份）。需要时用外部签名/加密。
4. **没有自动备份调度**：`db:backup` 是一次性命令；定时备份需要外部 cron/launchd，未在本轮接入。
5. **Django 的 Celery/Redis/Docker 未退役**：见 §4 的前置条件；本轮只落地残留检查与退役清单。
6. **DSH 的 outbox 消费者有实现、无驱动**（F1）：`src/jobs/worker.ts::runOnce/drain/runOnceAsync` 在
   `src/` 内零调用点（只有测试导入）。提交/判分 enqueue 的 `evidence.rebuild_for_attempt` 在真实使用中
   不会被消费，证据/状态投影不会自动更新。这是退役 Django projection worker 的硬前置，也是下一批
   的第一优先级；在接线前不能声称异步链等价。
7. **`plan.generated` 无 handler**（F2）、**两个 topic 改名**（F3）、**3 个 Django 能力在 Node 无等价实现**
   （F4：`regrade_effects` 的证据重建、`rebuild_after_answer_change`、`on_session_finished`）：退役
   清单已逐条列出；其中 F2/F3 是接线/映射问题，F4 是能力缺口。
8. **规划器仍不是完整 parity**：reason_codes 词表与追加语义已对齐，但 weak 分支的前置重排
   （`prerequisite_first`/`unblocks:`/`blocked_state_`）与创建任务时的 `trigger_event` 仍与 Django
   不同（见 04 §Q W1/W2）。
9. **`on_explanation_delivered` 不接生产路径**：Django 定义了它但生产代码零调用（只有集成测试
   直接调用）。移植函数并测试幂等，但不接线，避免创建 Django 不创建的 B 任务（见 04 §Q W4）。
10. **对账的源库是「克隆+当前迁移」**：真实 `acepass` 落后 13 条迁移，不改源库是硬约束；归档来自
    只读克隆上跑完 Django 迁移后的库。只验证正向 PostgreSQL→SQLite，没有反向工具；5383 行全量
    进内存，未做百万行压力验证；统计只覆盖 13 项学习者可见聚合（见 `var/b9/recon-notes.md`）。
