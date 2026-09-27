# AcePass 实施状态

本文件按里程碑记录实际实现范围、验证方式与未完成项。
**只写实际运行过的检查**；未运行的测试不写“通过”，未经过真实时间的不写“已验证”。
最后更新：M0—M5 主体完成，正在补齐自动化测试、前端与交付记录。

## 0. 当前环境（实测）

| 项目 | 实测值 |
|---|---|
| 工作目录 | `/Users/cololi/Documents/AcePass` |
| Python | 3.12.13（`backend/.venv`，uv 提供的 CPython） |
| Django | 5.2.17 |
| django-ninja | 1.4.5 |
| psycopg | 3.2.13（binary） |
| Celery / redis-py | 5.5.3 / 6.4.0 |
| Pillow | 11.3.0 |
| Node / npm | v24.18.0 / 12.1.0 |
| PostgreSQL | 16.15（Homebrew，本机 5432；文档原写 17 系列，已按实际改为 16/17 兼容） |
| Redis | 8.10.2（Homebrew，本机 6379） |
| Docker | 客户端 29.8.1 已安装，**OrbStack 守护进程未运行**，因此 Compose 未实测 |
| AI provider | 未配置（`ACEPASS_AI_PROVIDER=none`），真实模型验证未做 |

依赖精确版本见 `backend/requirements/lock.txt`。

## 1. M0 工程、环境与真实状态

**实现范围**

- Django 5.2 + Django Ninja 模块化单体：`backend/config`（settings 分 base/dev/test、`api.py` 汇总路由、`celery.py`、`asgi.py`）。
- 10 个业务模块 `apps/{accounts,audit,exams,ingestion,question_bank,knowledge,practice,tutoring,learning,analytics}`，加 `apps/common`（枚举、内容结构校验、答案结构校验、作用域校验、统一错误）。
- 确定性判分适配器位于 `backend/domain/grading`；证据与计划服务位于 `backend/domain`… 更正：证据/状态/配对/计划位于 `apps/learning/services`，判分适配器位于 `backend/domain/grading`。
- 统一错误信封 `{"error":{code,message,details,request_id}}`，请求关联 ID 中间件（`apps/audit/middleware.py`）。
- 账户命令 `create_account`（无默认密码、无默认管理员），Session + CSRF 登录，登录限流。
- 健康检查 `/health/live`、`/health/ready`（就绪同时检查数据库与缓存，AI 只报配置状态）。
- 私有文件存储适配层 `apps/ingestion/storage.py`（服务端生成对象键、路径穿越防护、原子写入）。
- `infra/docker/docker-compose.yml` + `infra/proxy/nginx.conf`：web/api/worker×3/scheduler/postgres/redis，持久化卷、健康检查、私有网络。

**已验证**

- `manage.py check`：无问题。
- 迁移在空库执行成功（accounts/audit/exams/ingestion/knowledge/practice/question_bank/learning/tutoring/analytics 全部 0001+）。
- 登录、CSRF、未登录 401：在 PostgreSQL 测试库上通过（见 §7 自动化证据）。
- OpenAPI 生成成功，共 **84** 条路由。

**未完成 / 未验证**

- Docker Compose 未实际启动（守护进程未运行），只做了配置静态检查。
- 未配置 HTTPS/生产反向代理实机验证。

## 2. M1 多项目与领域数据

**实现范围**

- `exams`：`ExamProject`/`Subject`/`ExamSpecVersion`/`SyllabusVersion`/`Paper`/`PaperRevision`/`PaperItem`。试卷自然键 `(subject, cycle_key, session_key, paper_code)` 唯一；`effective_revision` 每卷只有一个统计有效版本；AI 生成题不得挂到 `official_past`；父子题须同卷同科目。
- `accounts.UserSettings`：时区、每日总预算（默认 60 分钟）、项目比例分配、未诊断时间占比。
- `ingestion`：`Asset`（role + sensitivity 决定访问时机）、`SourceDocument`（粘贴文本也保留原文）、`SourceRegion`（归一化 bbox + 越界约束）、`ImportJob`、`ImportCandidate`、`CandidateRevision`（校对修订不可变快照）。
- `question_bank`：`Question`/`QuestionVersion`（含 material 父子）/`AnswerKeyVersion`（pending/checked/disputed + 核对依据）/`RubricVersion`（逐评分点，合计校验）/`QuestionSourceLink`/`QuestionFamily`/`ContentLineage`/`QuestionPoolPolicy`。
- `knowledge`：`KnowledgeNode`（大纲内树形，含显式“未分类”节点）、`QuestionTemplate`、`QuestionKnowledge`（映射修订批次，主要权重合计必须为 1，辅助权重必须为 0）、`VerificationPairing`（A/B/C 同科目，B/C 不得等于 A）。
- `practice`：`PracticeSession`（mode 由服务端决定）/`SessionItem`（冻结题目、答案、rubric、规范、映射版本与分值）/`Attempt`（唯一，不可变）/`GradeEvent`（追加式，`(attempt, grading_revision)` 唯一）/`ExposureEvent`/`ErrorDiagnosis`/`LearningEvidence`。
- `audit`：`RequestLog`、`IdempotencyRecord`（`(user, route_scope, key)` 唯一）、`OutboxEvent`（事务发件箱，可去重）、`LLMRun`、`ContentRevision`。

**已验证**

- 演示夹具在真实 PostgreSQL 上创建 2 个项目、3 个科目、33 个可计分叶子题（单选 9、多选 6、判断 6、填空 6、大题 6），另 3 个共享材料父题，10 条试卷题项。
- 跨项目访问题目/作答返回 404；未授权用户看不到他人项目。

**未完成 / 未验证**

- 组织共享、多用户协作明确不做（P0 仅 owner）。

## 3. M2 导入、校对与全题型内容

**实现范围**

- 文本粘贴 → 原文文档 + 区域（记录字符偏移）+ 候选；两种解析策略（显式【题干】【选项】【答案】模板优先，编号题启发式兜底），**不猜答案**，解析不出答案时写 `answer_status_known=false`。
- 图片导入 → 私有保存 + 人工结构化候选；真实识别在 M5 走 provider，未配置时明确提示“需人工录入”，不伪造识别结果。
- 校对问题清单：缺题型/缺选项/答案缺失/无来源区域/重复候选/重复已发布内容/同题号冲突。
- 发布事务：候选锁定 → 结构校验 → 创建题目身份与版本 → 答案（必须 checked + 核对依据）→ rubric → 考点映射 → 发布 → 审计，一起提交；有阻塞问题则 422 并列出问题。
- 同文件重复上传复用来源（`checksum` 命中），不新增来源、不重复计入试卷。
- 全部五种题型 + 共享材料父子题录入与发布。

**已验证**

- 演示夹具通过发布事务生成全部题型；`material` 父题只校验材料与子题清单，不参与计分。

**未完成 / 未验证**

- PDF 导入、复杂扫描、答案页自动匹配为 P1/P2。
- 原图旋转/裁剪未做（P0 只准确显示原图与已识别区域）。

## 4. M3 全题型工作台与正式评分

**实现范围**

- 题项呈现接口只给题干/选项/空位/材料与允许的图片资产 ID；首次领取写 `first_delivered_at` 与暴露事件，重读不重置。
- 判分适配器：单选、多选（完全匹配 / 少选部分分，错选按 `wrong_score`）、判断（`false` 不等于未答）、填空（逐空：精确匹配 + 显式归一化开关、数值 Decimal 容差与单位白名单、不确定转待复核）、大题（逐评分点人工确认）。
- 提交单事务 + 幂等键：同键同载荷返回同一 attempt；同键异载荷 409；同题项第二次提交（不同键）409。
- 大题确认：必填评分点缺失、超上限、刻度不符都拒绝；`expected_grading_revision` 过期 409；本人评分一律 `self_confirmed`，staff 给自己评分也是自评。
- 验证/考试模式：提交只回收讫状态，会话、attempt 查询、报告全部隐藏分数与正误；tutor/reveal/含答案文件在验证期间拒绝。
- 练习模式：提交前可 reveal（记录答案暴露），提交后仍可 reveal。
- 重判：`regrade_attempt` 追加新 `grade_event`，比较并交换有效指针，旧任务不得覆盖新结果；题干版本不同则不做机械重判而是失效证据。
- 答案转争议：受影响历史判分转为待复核，原始作答保留。

**已验证（真实 PostgreSQL 测试库，HTTP 全链路）**

- 单选正确 3.00/3.00；多选 `{b}` 在 A（少选部分分）= 2.00、在 B（完全匹配）= 0；含错选 = 0/`wrong`。
- 判断 `false` 记为正确而非漏答；填空 `-2` / `10.1` 两空确认 3.00/3.00；未登记等价答案的填空 `pending_review`、确认分为 null、待评满分 3.00。
- 大题初次 `pending_review`，逐评分点确认后 7.00/7.00 且 `method=self_confirmed`；超上限与漏必填均 400。
- 材料父题建会话产出 2 个叶子题项（不建父题项）。
- 幂等：同键重放返回同一 attempt；同键异载荷 409；新键重提 409。
- 验证模式：提交仅回执、tutor 403、reveal 403、会话视图无分数；结束后分数可见。
- 跨用户访问作答/项目 404；未登录 401。

**未完成 / 未验证**

- 限时模拟考试（P2）、手写识别（P1）。
- 负分规则、整卷封底只按版本化配置存在，未做真实考试规则验证。

## 5. M4 证据、补弱任务与报告

**实现范围**

- 证据投影 `apps/learning/services/evidence.py`：六个维度（重复练习、无辅助完成、严格独立正确、同模板变式、陌生变式、延迟验证），每行保留排除原因；跨项目内容谱系暴露检查；延迟锚点取最近相关作答或教学事件。
- 考点状态 `state.py`：规则函数（非 LLM），阈值 3 道不同题 / 2 种模板 / 1 次 ≥24h 延迟正确；最近 3 次独立作答中 ≥2 次失败则 `needs_review` 并降级，历史最高状态单独保留；缺什么证据明确列出。
- 配对任务 `pairing.py`：A 的确认评分或讲解下发触发唯一 B；B 确认评分后按锚点 + `delay_hours` 生成 C 并写 `ReviewTask`；`(user, pairing, origin_session_item, task_kind)` 唯一约束保证重复触发不重复建；缺 C 题写明确的缺题记录，不拿原题冒充。
- 计划 `planner.py`：全局预算按项目最大余数法分配整数分钟，按考试日期/创建时间排序 + `距 1970-01-01 天数 mod 项目数` 轮换；项目内固定顺序（到期延迟验证 → 弱项 → 未诊断 → 一般练习），未诊断内容预留 20%；余额放不下整题则保留空闲并解释；刷新创建新修订只替换未开始任务。
- 报告 `apps/analytics`：完整确认 / 部分待评 / 待复核 / 自评 / 辅助 / 重复练习 / 严格独立 / AI 估计分行列出，缺数据不补零，排除原因可查。

**已验证**

- 60 分钟预算在 60/40 比例下分配 36 + 24 分钟，计划生成 14 个任务，未超额；同日重复生成返回同一计划。
- 报告计数与操作一致（自评 1、辅助 1、待评 4、严格独立 3）。
- 延迟任务在注入时钟下的边界测试见自动化测试（23:59 不算、24:00 算）。

**未完成 / 未验证**

- **真实隔天学习效果未验证**：所有延迟相关结论仅来自可注入时钟的逻辑测试，没有真实等待 24 小时。
- FSRS 记忆卡、年度占比统计为 P1。

## 6. M5 图片识别与按需辅导

**实现范围**

- Provider 接口 `ai/providers/base.py`：能力声明（文本/视觉）、`NullProvider`（未配置，明确报错）、`OpenAICompatibleProvider`（真实 HTTPS，超时/重试/费用记录）、`StubProvider`（**仅测试/演示模式**，结果永远标记 `is_stub`）。
- 提示词版本化 `ai/prompts/registry.py`：`p0-extract-v1`、`p0-explain-v1`，输出结构校验（题型、块类型、引用必须落在本次检索集合内、不得凭空声称有答案）。
- 辅导服务：必须绑定题项（attempt 可空），服务端用途门禁，冻结题目/答案/rubric 版本，`llm_run` 记录提供商、模型、提示词版本、输入摘要与摘要指纹、用量、费用（未知为 null）、耗时、重试、校验结果、是否 stub。
- 无 provider 时：`/ai-status` 明确返回未配置，辅导任务 `unavailable`，图片识别回到人工校对；作答与确定性判分不受影响。
- 费用/版本审计接口 `/ai-runs`。

**已验证（stub，自动化）**

- stub provider 下讲解任务成功并标记 `is_stub=true`，暴露事件按“答案暴露/讲解暴露”分别记账。
- stub 输出不会伪装成真实模型：`llm_run.is_stub`、任务 DTO `is_stub`、状态说明都标注。

**未完成 / 未验证（阻塞）**

- **真实 provider 未配置**：`ACEPASS_AI_API_KEY`/`ACEPASS_AI_BASE_URL` 缺失，因此 A36（真实图片识别 + 真实讲解人工核验）**未运行**。这阻塞的是真实 AI 验证，不影响其余功能。
- 图片识别任务入口已接好（`ingestion.extract_candidate`），未配置 provider 时不产生候选。

## 7. M6 交付与验收（进行中）

已完成：
- 演示夹具服务 `apps/accounts/services/demo_fixture.py` + 命令 `load_demo_fixture`。
- 端到端 HTTP 全链路脚本已跑通（登录 → 两项目 → 五题型 → 幂等 → 验证模式隔离 → 辅导 → 计划 → 报告 → 越权拒绝）。
- `README.md` 启动/迁移/账户/测试/备份恢复命令。
- `docs/acceptance-results.md` 逐条用例记录（含未运行原因）。

未完成：
- 前端界面（React + Vite）正在实现，浏览器验收未运行。
- Playwright 真实浏览器验收未运行。
- 备份恢复未在空目录实测。
- Docker Compose 未启动验证。
