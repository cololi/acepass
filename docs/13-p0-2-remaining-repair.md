# P0.2 定向补漏：C01—C05 修复与验证

日期：2026-09-27；起点 `c168583`（复验审查 HEAD）/ `bfbbfbd`（应用修复），工作区保留复验者新增的
`docs/12-*`、`docs/review/2026-09-27/p02-independent/` 等文件。问题基线：[12 独立复验](12-p0-2-independent-review.md)。

**结论：C01—C05 五组问题已修复，10 条交叉反例中的 9 条原样转为通过，第 10 条按"安全拒绝歧义历史"
的方案调整为验证拒绝/回滚/清单；相关业务断言全部迁入正式套件（17 条）。后端 194 passed、浏览器
36 passed、归档反例 9+2 passed、真故障演练 ok=true、代理组件与全栈发布门槛在本机 Docker 实际执行通过。
真实 provider、真实隔夜等待与 GitHub Actions 实际执行仍为未验证。**

四类证据分开标识：

| 标识 | 含义 | 本轮数字 |
|---|---|---|
| 自动化 | `pytest`（真实 PostgreSQL） | 194 passed（含迁入 17 条） |
| 浏览器 | Playwright 真实浏览器（desktop+mobile）+ 真实 Worker | 36 passed；归档 2 passed |
| 真故障 | 真 Redis `FLUSHALL`、真 `SIGKILL`、真双消费者 | ok=true |
| 发布门槛 | 本机 Docker 实际执行 CI 步骤脚本 | 组件通过 + 全栈登录通过；**GA 未执行** |

证据：[p02-remaining](review/2026-09-27/p02-remaining/README.md)。

## 1. C01 所有交付与幂等重放共用门禁

**问题**：内容门禁只在直接读取 attempt 与 tutor job 时生效；会话汇总、嵌套 grade、`submit` 同键
重放、tutor 消息同键重放、evidence 投影、grading-queue 仍交付同一份答案信息。

| 文件 | 改动 |
|---|---|
| [verification_gate.py](backend/apps/practice/services/verification_gate.py) | 新增 `active_verification_content_map`（一次展开到同题/同族/同源的全部版本 → 覆盖它的验证题项 id 集合）与 `content_gate_blocks_item`；`blocked_question_version_ids` 改为它的派生。门禁成为**一个内容可见性规则**，覆盖集合按题项 id 判定，验证题项覆盖自己（否则验证会挡掉自己的运行） |
| [sessions.py](backend/apps/practice/services/sessions.py) | `session_state` 用共享 map 逐项判定：被覆盖的题项 `grade=None`、`receipt_only=true`、`grading_withheld=true`，会话总分**整体隐藏**（否则总分把被隐藏的分数当数字还回来），并给出被隐藏题项清单与原因；新增 `delivery_hidden_for_item` 作为所有单条交付路径的唯一判定 |
| [practice/api.py](backend/apps/practice/api.py) | `submit` 同键重放改为**重新序列化回执**（同一 attempt，grade 按当前门禁重新判定），不再回放缓存 body；`confirm-grade` 先过门禁，重放同样重新序列化；`grading-queue` 排除被**其他**运行验证覆盖的作答；`list_sessions` 的 `grading_hidden` 与详情页保持一致；`SessionOut` 增加 `grading_withheld_session_item_ids` |
| [tutoring/api.py](backend/apps/tutoring/api.py) | tutor 消息同键重放改为按资源 id 重取 job、过 `assert_job_deliverable` 后重新序列化；被门禁覆盖时 403 |
| [evidence.py](backend/apps/learning/services/evidence.py) | `evidence_summary_rows` 排除被其他运行验证覆盖的作答（保留覆盖者自身） |

设计要点：**幂等只保证不重复写入，不构成永久读取敏感响应的权限**。同一个资源可以重放，但回执里
的答案信息必须按当前上下文重新序列化；门禁解除（验证结束）后同一幂等键会重新给出真实评分。

**验收结果（真实执行）**

| 检查 | 结果 |
|---|---|
| 归档 5 条门禁反例 | 全部通过（`test_delivery_gates.py` 5 passed） |
| 门禁解除后恢复可读（新增正向回归） | 通过 |
| 原幂等契约（同键同载荷重放、异载荷 409、不重复写入） | 通过（新增回归 + 原套件） |
| 无关会话/题项仍可用 | 通过（隐藏按题项判定，总分整体隐藏而不是整个端点 403） |

## 2. C02 重判所有分支遵守代次

**问题一（运行时）**：旧争议 run 的拒绝分支调用 `invalidate_for_untrusted_regrade_target` 时，
对该题目下**所有**作答写入 pending_review，撤销了较新 run 已经确认的有效评分。正常评分分支有
高水位保护，拒绝分支没有。

**问题二（历史迁移）**：0004 把重复的 `(question, generation)` 用序列重编号，可能把仍排队的旧 run
抬到已应用的新代次之上；恢复消费后旧 run 覆盖新 run。

| 文件 | 改动 |
|---|---|
| [attempts.py](backend/apps/practice/services/attempts.py) | `invalidate_for_untrusted_regrade_target` 增加 `refused_generation`：**先判断 stale 再决定是否改动 attempt**，`applied_regrade_generation > refused_generation` 的作答跳过并计数，返回 `(invalidated, skipped_newer)`；`start_regrade_run` 文档修正：不再声称"稳定行锁天然死锁"，改为锁范围/耦合的理由 |
| [reports.py](backend/apps/analytics/services/reports.py) | 拒绝分支把跳过数写入 `stale_skipped_attempts`（可审计，不再无差别撤销），日志与返回值带 `newer_generation_kept` |
| [0004 迁移](backend/apps/analytics/migrations/0004_p0_2_regrade_generation_sequence.py) | 改为**安全拒绝**：先检测重复 `(question, generation)`，发现即抛 `AmbiguousRegradeGenerationHistory` 并输出可操作清单（question / generation / run id / status / target answer version / created_at / question_max_generation）+ 处理建议；因为 Django 迁移在事务内，拒绝时**序列未创建、约束未添加、历史行未改写**。无歧义时序列推进到 `MAX+1` 并加唯一约束，不改写任何行 |
| [docs/11](11-p0-2-closeout-verification.md) | 修正"行锁死锁"表述：屏障测试的同步设计限制不能推断"稳定行锁天然死锁" |

**验收结果（真实执行）**

| 检查 | 结果 |
|---|---|
| 归档反例：旧争议 run 不得撤销较新有效评分 | 通过（`current_answer_version=3`、`grade_status=confirmed`、`applied_regrade_generation=2` 保持不变） |
| 归档反例：迁移拒绝且无部分修改（调整为验证拒绝/回滚/清单） | 通过：抛出拒绝、清单含歧义 run 与 `question_max_generation=2`、序列与约束均未创建、`stale.generation` 仍为 1、拒绝后旧 run 仍不能覆盖 v3 |
| 新增正向回归：无歧义历史迁移 | 通过：行未被改写（1/2 保留）、序列从 `MAX+1` 起分配、唯一约束已添加 |
| 序列方案保留 | 保留（nextval + `uniq_regrade_question_generation`），未改回题目行锁 |

## 3. C03 保留 A30 开始时的延迟边界

**问题**：B 训练锚点改成"完成"是对的，但 C 的验证间隔用**提交时间**判断，于是"23 小时打开、
25 小时提交"也能拿到延迟资格。

| 文件 | 改动 |
|---|---|
| [evidence.py](backend/apps/learning/services/evidence.py) | 新增 `_delay_evaluation_instant`：判定时刻取题项**首次呈现**（`first_delivered_at`），只有从未呈现过的服务端提交才回退到提交时间；锚点仍是唯一权威 `latest_learning_anchor`（最近完成的训练/教学事件），区间改为 `首次呈现 − 锚点`。detail 增加 `delay_evaluated_at` / `delay_evaluated_from` 以便逐行解释 |

**验收结果（真实执行）**

| 检查 | 结果 |
|---|---|
| 归档反例：B 完成 23h 后打开 C、25h 后提交 | 通过：`qualifies=false`，排除原因 `距最近相关训练/教学仅 23.00 小时`，`delay_evaluated_from=first_presentation` |
| 新增正向回归：首次呈现时已满 24h | 通过：`qualifies=true`，未把正常延迟证据一起挡掉 |
| B 的锚点仍是完成时间、辅助作答仍被排除 | 通过（原套件 B04 用例保持通过） |

## 4. C04 租约保护业务最终提交

**问题一**：job 先写 succeeded、随后进程中断，重投后 `run_job` 见到 succeeded 直接返回，
助手消息与曝光事实永久缺失，outbox 却记为 processed。
**问题二**：两个消费者并发时，token 只保护 outbox 确认，不约束业务写入；旧消费者返回后覆盖
接管者的结果，并产生 2 条消息、2 条曝光。

| 文件 | 改动 |
|---|---|
| [outbox.py](backend/apps/audit/services/outbox.py) | 新增 `hold_claim`：在事务内 `select_for_update` 重读 outbox 行，只有 token 仍是自己且未 processed 才返回该行；所有权判定与依赖它的写入同事务提交 |
| [tutoring/services/core.py](backend/apps/tutoring/services/core.py) | `run_job` 接受 `claim`，所有写入经 `_write_job_result`（短事务：重查 claim + 锁 job 行；已 succeeded 的任务不会被旧消费者改成失败）；成功路径拆成**两阶段**：阶段一提交已验证结果（`result_blocks/status/delivered_at`，崩溃后仍可恢复），阶段二 `_finalize_success` 在一个短事务内一致提交**助手消息 + 曝光 + `finalized_at` + outbox processed**；见到 succeeded 的重投直接进入阶段二补齐缺失事实；模型网络调用仍在事务外，锁只在短提交内持有 |
| [tutoring/models.py](backend/apps/tutoring/models.py) + [0002 迁移](backend/apps/tutoring/migrations/0002_p0_2_tutor_job_finalized_at.py) | 新增 `finalized_at`（业务最终提交完成事实），可空、加法式迁移，无回填 |
| [tutoring/tasks.py](backend/apps/tutoring/tasks.py) | 把 claim 传给 `run_job`；末尾的 `confirm_claim` 只覆盖"没有业务事实的终态"（模型失败），业务成功由阶段二在自身事务内确认 |

**"按 job 防重复"**：阶段二先 `select_for_update` 锁 job 行，再以 `finalized_at` 为完成事实判定，
并发终结者被串行化，第二个看到 `finalized_at` 已写入即跳过；同时保留助手消息/曝光存在性检查作为
第二道防线。

**验收结果（真实执行）**

| 检查 | 结果 |
|---|---|
| 归档反例 1：succeeded 后、消息/曝光前中断，重投补齐 | 通过：`assistant_turns=1`、`exposures=1`、`outbox=processed`、`finalized_at` 已写 |
| 归档反例 2：租约到期接管，旧消费者返回 | 通过：`final_blocks=consumer-2`、`assistant_turns=1`、`exposures=1` |
| 新增：同一 event 重复投递两次 | 通过：仍 1 条助手消息、1 条曝光、1 个 job |
| 新增：旧消费者超时失败不得把已交付任务改回失败 | 通过：job 仍 succeeded，结果仍是接管者的 |
| 真故障演练 | **ok=true**：真 `FLUSHALL` 后扫描恢复且只应用一次；真 `SIGKILL` **确实命中 processing 状态的任务**（`caught_while_processing=true`）后恢复；双消费者阶段主动对**同一 event 重复投递**并让**旧消费者超时返回**，最终 1 条助手消息/1 条曝光 |
| 演练卫生 | 独占 Redis 实例需要 `ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1` 显式确认并记录实例 `run_id`；`try/finally` 保证任何失败路径都停掉自建 Worker；kill 场景未命中处理中任务时判为**不通过** |

## 5. C05 修正 CI 实际 nginx 容器

**问题**：workflow 的 `nginx -t` 步骤传了 `--add-host api:127.0.0.1`，真正启动跳转测试容器却没有，
也不存在 `api` 容器/网络别名，模板里的 `server api:8000` 在干净 runner 上无法解析；容器只挂配置和
证书，没有 AcePass 产物，`/login` 返回 200 也不能证明登录页可用。

| 文件 | 改动 |
|---|---|
| [ci.yml](.github/workflows/ci.yml) | `frontend` 作业上传真实构建产物 `acepass-frontend-dist`，`infra` 作业 `needs: [frontend]` 并下载到 `frontend/dist`；两个检查**分开执行、分开命名**：`Proxy component check` 与 `Full-stack login check`；失败时导出 compose 日志 |
| [scripts/verify_proxy.sh](scripts/verify_proxy.sh) | `component`：建独立 docker 网络，起一个监听 **8000**、网络别名 `api` 的桩上游（模板 upstream 因此真的可解析），nginx 容器挂载**真实 `frontend/dist`** 与证书；断言 301 目标（带端口/不带端口）、TLS 握手、`/health/ready` 经代理到达上游、`/login` 含 AcePass 标题与 SPA 挂载点、引用的 hashed JS 资源 200 且 Content-Type 为 javascript。`full-stack`：用 compose 构建真实应用镜像，起真实 postgres/redis/api/web，跑真实迁移、建真实账户，再经 HTTPS 代理完成**带 CSRF 的真实登录**并读取会话。两者都在 `trap EXIT` 中清理容器/网络/卷 |

**验收结果（本机 Docker 实际执行脚本）**

| 检查 | 结果 |
|---|---|
| 组件检查 | 通过：`Location: https://127.0.0.1:18443/login`、无端口 Host 保持原样、上游解析 ok、脚本资源 `HTTP 200 (application/javascript)` |
| 全栈检查 | 通过：真实镜像构建、全部迁移应用（含本轮 `analytics.0004`、`tutoring.0002`）、`全栈登录 HTTP 200`、代理后会话可用、登录页来自真实产物 |
| 清理 | 两次运行结束后 `docker ps -a` / `docker volume ls` / `docker network ls` 均无残留 |
| GitHub Actions 实际执行 | **未验证**（本轮未推送、未触发 workflow；workflow 仅通过 YAML 解析与本地等价脚本验证） |

## 6. 迁入正式套件的回归

[test_p0_2_closeout_gaps.py](backend/tests/integration/test_p0_2_closeout_gaps.py)（17 条）：

- C01：既有平行会话隐藏分数、`submit` 同键重放重新过门禁、evidence 隐藏、grading-queue 隐藏、
  tutor 消息同键重放过门禁；另加"验证结束后恢复可读"与"幂等契约未被门禁改变"两条正向回归。
- C02：旧争议 run 不得撤销较新有效评分、迁移拒绝歧义历史（拒绝 + 无部分修改 + 清单可操作 +
  拒绝后仍不能覆盖）、无歧义历史迁移正向回归。
- C03：23h 打开/25h 提交不得获得延迟资格、首次呈现已满 24h 正常判定。
- C04：崩溃重投补齐曝光、接管后旧消费者不得覆盖、同一 event 重复投递、旧消费者失败不得改回失败。
- G07：历史审计正向回归（当前行改写、superseded 行保留、批次与前后值齐全）一并迁入。

未删除任何风险场景，未放宽验证隔离：浏览器继续使用独占数据库/Redis/端口/媒体与真实 Worker，
演练继续使用真实 `FLUSHALL` 与真实 `SIGKILL`。

## 7. 边界与未验证项

- 未部署到任何环境；未读取或写出用户密钥；业务库 `acepass` 未执行 migrate、未审计改写、未清理。
- 历史迁移只在新建的专用库上构造并执行；专用库在运行结束后删除。
- **真实 provider 质量、真实隔夜（24 小时）等待、真实学习效果仍未验证。**
- **GitHub Actions 未实际执行**：`Proxy component check` / `Full-stack login check` 只在本地用同一
  脚本跑通，CI 上的实际结果保持未验证。
- 浏览器为 stub 讲解、非真实模型；故障演练的模型调用亦为 stub，不含真实 provider 延迟。
- P1（原生 PDF、历年统计等）未开始；是否进入 P1 取决于上述工程边界是否闭合，而非等待凭据。
