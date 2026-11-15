# AcePass 实施状态

> **最新：代码结构与模块关联清理轮已交付（2026-11-09，起点 `7b41d19`）。** 本轮不新增业务能力：
> 前端 `src/api/client.ts` 2932 行拆成 39 行兼容桶 + 15 个域模块（入口 JS 43,143 → 22,275 B，−48.4%，
> 23 个引用点一行未改）、后端 `ai/prompts/registry.py` 1049 行拆成 57 行显式桶 + 7 个提示族模块；
> 五类重复实现各归并一处、删掉 2 个空包；查询数 `knowledge_nodes` 12→5、`knowledge_map` 11→7、
> 会话详情 44→8（不再随行数增长）、变式列表 25→6、来源区域 10→7；前端考试倒计时不再整页重绘、
> 知识页去掉 O(节点×状态)、项目切换 2 次 subjects GET 并为 1 次。后端 **501 passed**、
> ruff/check/makemigrations 干净、归档反例 11 / 9（+1 deselected）/ 3 原样通过、前端 tsc/vitest/build 干净、
> **没有任何既有测试文件被修改**。未做项与限制见 [25 代码结构清理](25-code-structure-cleanup.md)。

> **上一轮：代码优化轮已交付（2026-09-28，起点 `fe68b07`）。** 本轮不新增业务能力：
> outbox 派发缺陷修复（快速消费者不再被派发行的锁跳过，事件同一轮内 `processed`，替代原先等 300s 租约、
> 最坏 ≈5.5 分钟）、热读路径 N+1 消除（`questions_list` 123→7 查询 / 41.09→5.65 ms，
> `practice_sessions_list` 67→8 / 19.85→4.84 ms，且与行数无关，响应逐字节不变）、
> 前端首屏包体（入口 JS 886,357→39,762 B，首屏合计 342,882 B / 3 chunks，KaTeX 与路由按需加载）。
> 后端 **501 passed**（489 基线 + 本轮新增 12 条，0 failed / 0 skipped）、ruff/check/makemigrations 干净、
> 归档后端反例 **11 / 9（+1 deselected）/ 3** 原样通过、浏览器主套件 **78 passed**、stub 专跑 **8 passed**、
> 归档浏览器反例 **2 passed**、真故障演练 **ok=true**；**没有任何既有测试文件被修改**。
> 见 [24 代码优化轮交付](24-code-optimization-delivery.md) 与
> [独立复验证据](review/2026-09-28/optimization/README.md)。**仍未验证**：真实模型凭据、真实 ≥24 小时、
> 真实考试材料、远程部署与 GitHub Actions 实际执行。

> **最新：P2 第三批已交付，P1/P2 规划内的开发任务全部完成（2026-09-28，起点 `ac58807`）。**
> 限时模拟考试（服务端截止时间 + 一次性交卷 + 考试中零反馈 + 到期自动结束，并修复考试期间并行会话的
> 答案泄漏）、诚实报告范围（未完成时不给最终分，只给标注清楚的下限与缺失范围）、受限数学判分
> （白名单表达式、超时/超限/非法语法/未知单位转人工、静态检查证明不可执行代码）与效果校准
> （分组样本数与可比性说明、样本不足不给统计量、因果结论由代码守卫禁止）已实现：后端 **489 passed**、
> 隔离浏览器主套件 **78 passed 连续两次**、stub 专跑 **8 passed**、三组归档后端反例 11/9/3 原样通过、
> 归档浏览器反例 2 passed、真故障演练 **ok=true**、干净副本发布门槛通过。
> **未验证项只剩外部阻塞**：真实模型凭据、真实 ≥24 小时、真实考试材料、远程部署与 GitHub Actions 实际执行。
> 见 [22 P2 第三批交付](22-p2-third-batch-delivery.md) 与
> [p2-batch3 证据](review/2026-09-27/p2-batch3/README.md)。

> **P2 第二批已交付（2026-09-27，起点 `7b323df`）。** 封存（唯一解析器 + 九处入口门禁）与家族合并
> （两步确认、暴露重查、证据失效、状态重算）以及 AI 变式（确定性校验先行、失败留候选、发布强制
> `ai_generated`、不进真实考试统计）已实现：后端 **396 passed**（含本轮迁入 30 条）、
> 隔离浏览器主套件 **72 passed 连续两次**、stub 专跑 **8 passed**、三组归档后端反例 11/9/3 原样通过、
> 归档浏览器反例 2 passed、真故障演练 **ok=true**、干净副本发布门槛通过。**真实生成模型质量、
> 真实考试材料的封存语义、真实模型能力、真实 ≥24 小时与 GitHub Actions 实际执行仍未验证。**
> 见 [21 P2 第二批交付](21-p2-second-batch-delivery.md) 与
> [p2-batch2 证据](review/2026-09-27/p2-batch2/README.md)。**仅剩批次 6（C05—C08）。**

> **P2 第一批已交付（2026-09-27，起点 `17f3fd8`）。** 版式感知导入（逐页分类、按栏重排、
> 跨页合并、可疑页面阻断发布直到人工确认版面；不做 OCR，扫描页转人工）与污染规则
> （校对预览 / 外部已见 / 已展示未提交 / 跨项目同源 → 永久失去严格独立资格，无洗白路径）已实现：
> 后端 **366 passed**（含本轮迁入 26 条）、隔离浏览器主套件 **66 passed 连续两次**、stub 专跑 **6 passed**、
> 三组归档后端反例 11/9/3 原样通过、归档浏览器反例 2 passed、真故障演练 **ok=true**、
> 干净副本发布门槛通过。**真实试卷 PDF、OCR、真实模型能力、真实 ≥24 小时与 GitHub Actions
> 实际执行仍未验证。** 见 [20 P2 第一批交付](20-p2-first-batch-delivery.md) 与
> [p2-batch1 证据](review/2026-09-27/p2-batch1/README.md)。剩余：批次 5（C03/C02）与批次 6（C05—C08）。

> **P1 第三批已交付（2026-09-27，起点 `44a0c6c`）。** 手写转写确认（无模型时走人工录入，
> 有模型时只是建议）、AI 逐点估分（人工确认前只有 `estimated_score`，绝不进入正式分）、
> AI 诊断追问（只提受控原因、无证据降级为 unknown）、经校验分段 SSE（断线重连零成本、
> 失效来源被拦截）已实现：后端 **340 passed**（含本轮迁入 24 条）、隔离浏览器主套件 **62 passed**、
> stub 专跑 **6 passed**、三组归档后端反例 11/9/3 原样通过、归档浏览器反例 2 passed、
> 真故障演练 **ok=true**、干净副本发布门槛通过。**真实视觉/文本模型、真实嵌入向量、真实 ≥24 小时
> 与 GitHub Actions 实际执行仍未验证。** 见 [19 P1 第三批交付](19-p1-third-batch-delivery.md) 与
> [p1-batch3 证据](review/2026-09-27/p1-batch3/README.md)。**P1 已全部交付（B01—B08），
> 剩余为 P2 批次 4—6。**

> **P1 第二批已交付（2026-09-27，起点 `75386ea`）。** 考点前置关系（环拒绝 + 计划器按前置重排）、
> 标签建议（只写辅助标签修订，不创建/改名考点）、中文关键词 + 向量混合检索（权限/封存先过滤、无向量
> 时明确降级）、FSRS 记忆卡（日志可重放、卡片记忆不升级解题能力）已实现：后端 **316 passed**
> （含本轮迁入 90 条）、隔离浏览器 **58 passed**（P0 36 + P1 第一批 12 + 本批 10，连续两次一致）、
> 三组归档后端反例 11/9/3 原样通过、归档浏览器反例 2 passed、真故障演练 **ok=true**、
> 检索金标集 recall@5/@10 = 1.000、干净副本发布门槛通过。**真实嵌入模型、真实模型标签建议、
> 真实 AI 讲解/图片识别、真实 ≥24 小时与 GitHub Actions 实际执行仍未验证。** 见
> [18 P1 第二批交付](18-p1-second-batch-delivery.md) 与 [p1-batch2 证据](review/2026-09-27/p1-batch2/README.md)。
> 剩余批次划分见 [17 走向 100% 的计划](17-remaining-plan-to-completion.md)。

> **P1 第一批已交付（2026-09-27，起点 `5fff64e`，提交 `2776276`）。** 原生文字 PDF 批量导入与
> 人工校对、大纲词表/人工映射、真实试卷周期统计（近五年完整周期口径）已实现；后端 **226 passed**
> （含本轮迁入 23 条）、隔离浏览器 **48 passed**（P0 36 + P1 12）、归档反例原样通过、真故障演练 ok=true、
> 干净副本发布门槛通过。见
> [16 P1 第一批交付](16-p1-first-batch-delivery.md) 与 [p1-batch 证据](review/2026-09-27/p1-batch/README.md)。

> **P0.2 最后四组遗漏（C01/C02/C04/C05）已修复（2026-09-27，起点 `2c87e0c`，提交 `7285991`）。**
> 正式后端 **203 passed**（194 + 本轮迁入 9 条）、复验者三条原始反例原样 **3 passed**、上轮有效反例原样
> **9 passed / 1 deselected**、隔离浏览器 **36 passed**、归档浏览器 **2 passed**、真故障演练 **ok=true**、
> 仅提交内容的干净副本下代理组件与真实全栈 HTTPS/CSRF 登录通过且环境哨兵保持不变。
> 逐条结果见 [15 最后四组遗漏修复](15-p0-2-final-four-gaps-repair.md)，证据见
> [p02-final-gaps](review/2026-09-27/p02-final-gaps/README.md)。**真实 provider、真实隔夜、
> 真实学习效果与 GitHub Actions 实际执行仍未验证。**

> **P0.2 定向补漏已完成 C01—C05（2026-09-27，起点 c168583/bfbbfbd）。** 后端 194 passed、
> 归档交叉反例 9/10 原样通过（第 10 条按"安全拒绝歧义历史"调整后作废，业务断言已迁入）、浏览器 36 passed、
> 归档浏览器 2 passed、真故障演练 ok=true、代理组件与全栈登录门槛本机 Docker 通过。
> 逐条结果见 [13 补漏报告](13-p0-2-remaining-repair.md)，证据见
> [p02-remaining](review/2026-09-27/p02-remaining/README.md)。该轮之后的独立复验（`2c87e0c`）保留了
> C01/C02/C04/C05 的四处遗漏，已在 [15](15-p0-2-final-four-gaps-repair.md) 关闭。

> **P0.2/c168583 独立复验曾保留 C01—C05。** 完整结论见 [12复验报告](12-p0-2-independent-review.md)；下文历史状态不替代该结果。

> **P0.2 收尾完成（2026-09-27，基线 f809365）：B01—B07 与三项发布门槛已修复并有本轮实测证据。**
> 逐条改动、命令与结果见 [P0.2 收尾验证报告](11-p0-2-closeout-verification.md)；
> 问题基线（P0.1 独立复验，仍作为历史保留）见 [09复验报告](09-p0-1-independent-reacceptance.md)。
> 真实 provider、真实隔天与真实学习效果仍为**未验证**。

> **独立验收（2026-09-27）：P0 暂不通过。** 已复现的缺口见
> [独立验收报告](06-independent-p0-review.md)，修复顺序见 [P0 修复计划](07-p0-repair-plan.md)。
> 原套件通过不能视为全部业务闭环通过。
>
> **P0.1 修复完成（同一日）：业务阻断已修复并重新验收通过。**
> 逐条修复证据见 [P0.1 修复与重新验收报告](08-p0-1-repair-verification.md)。
> 真实 provider 与真实隔天体验仍为未验证。

按里程碑记录**实际实现范围、验证方式与未完成项**。未运行的测试不写“通过”，
未经过真实时间的不写“已验证”。逐条验收结果见 [`acceptance-results.md`](acceptance-results.md)。

- 代码版本：`f809365`（P0.2 基线）；本轮改动见
  [P0.2 收尾验证报告](11-p0-2-closeout-verification.md) §1
- 最近一次全量校验（P0.2 收尾，本轮实际执行）：
  - 后端 `cd backend && .venv/bin/python -m pytest -q` → **177 passed**
    （原 164 + 本轮迁入的 13 条 P0.2 回归）
  - 复验者原始反例 `docs/review/2026-09-27/p01-independent`（未修改）→ **11 passed**
  - 新版浏览器验收（独立库/Redis/端口/媒体 + 真实 Worker）→ **36 passed**
    （含照片草稿、可视填空答案、空账户 UI 闭环与收紧后的跨项目断言）
  - 复验者归档浏览器反例（`playwright.remaining.config.cjs`，未修改）→ 通过
  - 原浏览器套件（独立库/端口）→ 见 P0.2 报告 §2.4
  - 真实故障注入 `scripts/verify_worker_e2e.py`（真 `SIGKILL` + 真 Redis `FLUSHALL`）→ 见 P0.2 报告 §2.5

## 0. 环境（实测）

| 项目 | 实测值 |
|---|---|
| 工作目录 | `/Users/cololi/Documents/AcePass` |
| Python | 3.12.13（`backend/.venv`） |
| Django / django-ninja | 5.2.17 / 1.4.5（精确版本见 `backend/requirements/lock.txt`） |
| psycopg / Celery / redis-py / Pillow | 3.2.13 / 5.5.3 / 6.4.0 / 11.3.0 |
| Node / npm / Vite / React | v24.18.0 / 12.1.0 / 6.4.3 / 19 |
| PostgreSQL | 16.15（Homebrew）。架构文档写「17 系列」，本机为 16.15：**这是实现与文档的差异，已按实际记录**；P0 未使用 17 专属特性，迁移与约束在 16 上全部通过 |
| Redis | 8.10.2（Homebrew） |
| Docker | 客户端 29.8.1 + OrbStack。P0.1 已实际 `build` + `up -d`，8 服务 healthy，`curl -k https://127.0.0.1:8443/health/ready` → 200；验证后已 `down -v` 并停止 OrbStack |
| AI provider | `none`（无凭据）→ **真实视觉/文本模型仍未验证**；业务链已用可注入 provider 验证接通 |

## 1. M0 工程、环境与真实状态

**实现范围**

- `backend/config`：settings 分 base/dev/test/prod、`api.py` 汇总 84 条路由、`celery.py`、`asgi.py`、`wsgi.py`。
- 10 个业务模块 + `apps/common`（枚举、内容结构校验、答案结构校验、作用域校验、统一错误、请求关联 ID）。
- 确定性判分适配器 `backend/domain/grading/adapters.py`；证据/状态/配对/计划在 `apps/learning/services/`。
- 统一错误信封 `{"error":{code,message,details,request_id}}`；未登录 401 不泄露服务器细节。
- 账户命令 `create_account`（无默认密码/管理员）、`load_demo_fixture`（演示夹具）、`reset_demo_progress`（验收前重置演示进度）。
- 私有文件存储适配层：服务端生成对象键、路径穿越防护、原子写入、EXIF 清理、真实解码校验。
- 健康检查：`/health/live`、`/health/ready`（就绪含数据库与缓存，AI 只报配置状态）。
- `infra/docker`（Compose）与 `infra/proxy/nginx.conf`（同源反向代理）。

**已验证**

- `manage.py check` 无问题；`migrate` 在空库成功；84 条路由生成 OpenAPI；
  `DJANGO_SETTINGS_MODULE=config.settings.prod manage.py check --deploy` 仅剩 `security.W021`（HSTS preload，有意不默认开启）。
- `docker compose config` 语法与变量校验通过（用临时 env 文件验证后删除）。
- 未登录访问业务 API → 401；无 CSRF 的写入 → 拒绝。

**未完成**

- 已在本机实机启动 Compose 全栈并验证 TLS/健康检查/依赖顺序；**未向任何远程环境部署**。
- 真实 provider 凭据未配置；真实隔天体验未经过。

## 2. M1 多项目与领域数据

**实现范围**

- `exams`：`ExamProject`/`Subject`/`ExamSpecVersion`/`SyllabusVersion`/`Paper`/`PaperRevision`/`PaperItem`。
  试卷自然键唯一；`effective_revision` 每卷只有一个统计有效版本；AI 生成题不得挂到 `official_past`；父子题须同卷同科目。
- `accounts.UserSettings`：时区、每日总预算（默认 60 分钟）、项目比例、未诊断时间占比。
- `ingestion`：`Asset`（role + sensitivity 决定访问时机）、`SourceDocument`（粘贴文本也保留原文）、
  `SourceRegion`（归一化 bbox + 越界约束）、`ImportJob`、`ImportCandidate`、`CandidateRevision`。
- `question_bank`：题目/版本（含 material 父子）/答案（pending·checked·disputed + 核对依据）/rubric（逐点合计校验）/
  来源关联/家族/内容谱系/用途策略。
- `knowledge`：考点树（含显式「未分类」）、模板、映射修订（主要权重合计必须为 1，辅助权重必须为 0）、配对验证 A/B/C。
- `practice`：会话/题项（冻结题目·答案·rubric·规范·映射版本与分值）/作答（唯一不可变）/
  判分事件（追加式，`(attempt, grading_revision)` 唯一）/暴露事件/错误诊断/学习证据。
- `audit`：请求日志、幂等记录、发件箱（可去重）、`LLMRun`、内容修订。

**已验证**：演示夹具在真实 PostgreSQL 上创建 2 项目、3 科目、36 个已发布版本（33 个可计分叶子 + 3 个材料父题）、10 条试卷题项。

**未完成**：组织共享与多用户协作明确不做（P0 仅 owner）。

## 3. M2 导入、校对与全题型内容

**实现范围**

- 文本粘贴 → 原文文档 + 区域（字符偏移）+ 候选；显式模板优先，编号题启发式兜底；**不猜答案**，
  无法确定答案时写 `answer_status_known=false` 并列出问题。
- 图片导入 → 私有保存 + 人工结构化候选；未配置视觉模型时不产生识别结果，明确提示需人工录入。
- 校对问题清单：缺题型/缺选项/答案缺失/无来源区域/重复候选/重复已发布内容/同题号冲突。
- 发布事务：锁定候选 → 结构校验 → 题目身份与版本 → 答案（必须 checked + 核对依据）→ rubric → 考点映射 → 发布 → 审计，一起提交。
- 同文件重复上传复用来源（checksum 命中），不新增来源、不重复计入试卷。
- 五种题型 + 共享材料父子题均可录入与发布。

**已验证**：夹具通过发布事务生成全部题型；缺选项候选停在 `awaiting_review` 且发布返回 422。

**未完成**：复杂扫描件/多栏/跨页解析（P2-01）、原图旋转/裁剪未做。原生文字 PDF 导入与答案页匹配已于
P1 第一批交付（见 [16](16-p1-first-batch-delivery.md) §1）。

## 4. M3 全题型工作台与正式评分

**实现范围**

- 题项呈现只给题干/选项/空位/材料与允许的图片资产 ID；首次领取写 `first_delivered_at` 与暴露事件，重读不重置。
- 判分：单选、多选（完全匹配 / 少选部分分 / 错选按 `wrong_score`）、判断（`false` ≠ 未答）、
  填空（逐空精确匹配 + 显式归一化开关 + Decimal 容差 + 单位白名单；表达式不 `eval`）、大题（逐评分点人工确认）。
- 提交单事务 + 幂等键：同键同载荷重放；同键异载荷 409；同题项换键重提 409。
- 大题确认：必填缺失/超上限/刻度不符都拒绝；`expected_grading_revision` 过期 409；本人评分一律 `self_confirmed`。
- 验证/考试模式：提交只回执；会话、作答查询、报告全部隐藏分数与正误；tutor/reveal/含答案文件在验证期间一律拒绝。
- 练习模式：提交前可 reveal（记答案暴露），提交后仍可 reveal。
- 重判：追加新判分事件，比较并交换有效指针；题干版本不同则失效证据而不机械重判。
- 答案转争议：受影响历史判分转待复核，原始作答保留。

**已验证**：见验收表 A10—A28；含真实 PostgreSQL 上的 HTTP 全链路与并发幂等。

**未完成**：限时模拟考试（P2）、手写识别（P1）；负分/整卷封底只按版本化配置存在，未做真实考试规则验证。

## 5. M4 证据、补弱任务与报告

**实现范围**

- 证据投影：六维度（重复练习、无辅助完成、严格独立正确、同模板变式、陌生变式、延迟验证），每行保留排除原因；
  跨项目内容谱系暴露检查；延迟锚点取最近相关作答或教学事件。
- 考点状态：规则函数（非 LLM），阈值 3 道不同题 / 2 种模板 / 1 次 ≥24h 延迟正确；最近 3 次独立作答中 ≥2 次失败则
  `needs_review` 并降级，历史最高状态保留；缺失证据逐条列出。
- 配对任务：A 的确认评分或讲解下发触发唯一 B；B 确认评分后按锚点 + `delay_hours` 生成 C 并写 `ReviewTask`；
  `(user, pairing, origin_session_item, task_kind)` 唯一约束防重复；缺 C 写明确缺题记录。
- 计划：全局预算按项目最大余数法分配整数分钟；按考试日期/创建时间排序 +
  `距 1970-01-01 天数 mod 项目数` 轮换；项目内固定顺序（到期延迟 → 弱项 → 未诊断 → 一般练习），
  未诊断预留 20%；余额放不下整题则保留空闲并解释；刷新创建新修订只替换未开始任务。
- 报告：完整确认 / 部分待评 / 待复核 / 自评 / 辅助 / 重复练习 / 严格独立 / AI 估计分列，缺数据不补零。

**已验证**：60 分钟按 60/40 分配 36+24；计划任务不超额；报告计数与操作一致；延迟 24 小时边界由可注入时钟验证。

**P1 批次 2 新增**：考点前置关系（`knowledge_relation`，环拒绝，补弱顺序按前置重排并可解释）、
FSRS 记忆卡（`apps/memory` + `domain/memory/fsrs.py`，日志可重放、参数版本可追踪、
复习不写学习证据也不改变考点状态；到期卡按 `TaskKind.MEMORY_REVIEW` 进入当日计划并受全局预算约束）。

**未完成**：**真实隔天学习效果未验证**（没有真实等待 24 小时）；年度占比校准（P2-06）未开始。

## 6. M5 图片识别与按需辅导

**实现范围**

- Provider 接口：能力声明、`NullProvider`（未配置即明确报错）、`OpenAICompatibleProvider`（真实 HTTPS + 超时 + 重试 + 用量）、
  `StubProvider`（**仅测试/演示模式**，结果永远标记 `is_stub`）、墙钟超时封装。
- 版本化提示词：`p0-extract-v1`、`p0-explain-v1`；输出结构校验（题型、块类型、引用必须落在本次检索集合内、
  不得凭空声称有答案）。
- 辅导服务：必须绑定题项（attempt 可空）、服务端用途门禁、冻结题目/答案/rubric 版本；
  `llm_run` 记录提供商、模型、提示词版本、输入摘要与指纹、用量、费用（未知为 null）、耗时、重试、校验结果、是否 stub。
- P1 批次 2 新增：标签建议（`p1-suggest-tags-v1`，只接受逐字来自大纲的考点名，采纳只写辅助标签修订）、
  嵌入 provider（`ai/providers/embeddings.py`，未配置时明确不可用，`AI_PROVIDER=stub` 不伪造向量）。
- P1 批次 3 新增：手写转写（`p1-transcribe-v1`，`origin=model|manual`，未确认前不进入估分/诊断）、
  逐点估分（`p1-estimate-grade-v1`，`status=estimated` 独立事件，永不进入正式分）、
  诊断追问（`p1-diagnose-v1`，受控 error_type，无证据降级为 unknown）、
  经校验分段 SSE（`TutorSegment`，重连零成本，失效来源拦截）。
- 无 provider 时：`/ai-status` 明确未配置，辅导任务 `unavailable`，图片识别回到人工校对；作答与确定性判分不受影响。
- 费用/版本审计接口 `/ai-runs`。

**已验证（stub，自动化）**：stub 讲解成功且 `is_stub=true`；暴露按「答案暴露/讲解暴露」分别记账；
超时/非法 JSON/未配置/伪造引用四种失败路径均明确失败且不进入正式内容。

**未完成（阻塞）**：**真实 provider 未配置**（HTTP 402 余额不足、无视觉模型），A36 未运行；
图片识别与手写转写的模型入口已接好，未配置时不产生候选并明确报 `ai_not_configured`（手写转写此时走人工录入）。

## 7. M6 交付与验收

已完成：演示夹具与运维脚本（`scripts/backup.sh`、`scripts/restore.sh`、`scripts/demo_live_flow.py`）；
`README.md` 的启动/迁移/账户/测试/备份恢复命令；`docs/acceptance-results.md` 逐条结果；真实浏览器 desktop + mobile 各 8 项；
备份在空库空目录恢复并逐项核对计数与文件校验和。

未完成：Compose 实际启动、远程部署、真实 provider 验证、真实 24 小时延迟效果。

## 8. 测试证据分级

| 证据等级 | 覆盖 | 是否已运行 |
|---|---|---|
| 自动化（pytest，PostgreSQL） | 单元判分/解析规则 + 集成全链路、隔离、幂等、重判、证据、计划、AI 降级、路由契约、验收映射、P1/P2 全部批次（含模拟考试、表达式判分、报告范围与校准） | 是，**489 passed**（2026-09-28，见 [22](22-p2-third-batch-delivery.md)） |
| 真实浏览器（Playwright） | 上述全部 + 模拟考试时钟与零反馈、报告未完成范围、效果校准面板 | 是，**78 passed 连续两次** + stub 专跑 **8 passed**（2026-09-28） |
| 真实 provider | 真实图片识别、真实讲解、真实嵌入向量、真实标签建议、真实手写转写与逐点估分 | **否**（凭据不可用：HTTP 402 余额不足、无视觉模型、无嵌入模型） |
| 真实延迟学习 | 真实经过 ≥24 小时后完成 C 题 | **否**（只有注入时钟的逻辑测试） |
| 远程部署 / CI 实际执行 | 真实目标服务器、GitHub Actions | **否**（无授权目标、CI 未推送触发） |

## 9. 文档与实现的差异（已修正或记录）

1. **PostgreSQL 版本**：架构文档写 17 系列，本机与实测为 16.15。已在本文件记录；
   P0 未依赖 17 专属能力，若目标环境使用 17 亦可。
2. **路由挂载**：django-ninja 1.4 从「操作路径」推导路径参数，因此项目级路由在操作路径中显式写
   `/projects/{project_id}`，并由 `project_scoped_router` 统一挂载；`tests/integration/test_api_contract.py` 固定该契约。
3. **证据与状态服务位置**：架构文档示例把 `services/{grading,evidence,planning}` 放在仓库根；
   实现把判分适配器放在 `backend/domain/grading`，证据/状态/配对/计划放在 `apps/learning/services`，
   以避免可安装包与本地目录同名造成的导入歧义。
4. **「独立正确」与重复练习的解释**：数据契约写明「开始前未见本题答案/解析、未预览本题」。
   实现据此把「同题再次练习」排除出严格独立证据，并在未达 3 道不同题/2 种模板时
   明确列出缺失项，而不是把重复练习累加成功力结论。
5. **答题计时**：`elapsed_ms` 由服务端按题项首次呈现时间计算，客户端 `client_active_ms` 仅作遥测，
   不参与正式判定（数据契约 §4.2 一致）。
