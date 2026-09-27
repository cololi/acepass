# AcePass 实施状态

按里程碑记录**实际实现范围、验证方式与未完成项**。未运行的测试不写“通过”，
未经过真实时间的不写“已验证”。逐条验收结果见 [`acceptance-results.md`](acceptance-results.md)。

- 代码版本：`906cfd9`
- 最近一次全量校验：`cd backend && .venv/bin/python -m pytest tests -q` → **119 passed in 61.01s**；
  `cd frontend && npx playwright test` → **desktop 8 passed / mobile 8 passed**

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
| Docker | 客户端 29.8.1 已装，**守护进程（OrbStack）未运行** → Compose 只做 `config` 语法校验 |
| AI provider | `none`（无凭据）→ 真实模型验证未做 |

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

- Compose 未实际启动（守护进程未运行）；未做 TLS/生产反向代理实机验证。

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

**未完成**：PDF 导入、复杂扫描、答案页自动匹配（P1/P2）；原图旋转/裁剪未做。

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

**未完成**：**真实隔天学习效果未验证**（没有真实等待 24 小时）；FSRS 与年度占比统计为 P1。

## 6. M5 图片识别与按需辅导

**实现范围**

- Provider 接口：能力声明、`NullProvider`（未配置即明确报错）、`OpenAICompatibleProvider`（真实 HTTPS + 超时 + 重试 + 用量）、
  `StubProvider`（**仅测试/演示模式**，结果永远标记 `is_stub`）、墙钟超时封装。
- 版本化提示词：`p0-extract-v1`、`p0-explain-v1`；输出结构校验（题型、块类型、引用必须落在本次检索集合内、
  不得凭空声称有答案）。
- 辅导服务：必须绑定题项（attempt 可空）、服务端用途门禁、冻结题目/答案/rubric 版本；
  `llm_run` 记录提供商、模型、提示词版本、输入摘要与指纹、用量、费用（未知为 null）、耗时、重试、校验结果、是否 stub。
- 无 provider 时：`/ai-status` 明确未配置，辅导任务 `unavailable`，图片识别回到人工校对；作答与确定性判分不受影响。
- 费用/版本审计接口 `/ai-runs`。

**已验证（stub，自动化）**：stub 讲解成功且 `is_stub=true`；暴露按「答案暴露/讲解暴露」分别记账；
超时/非法 JSON/未配置/伪造引用四种失败路径均明确失败且不进入正式内容。

**未完成（阻塞）**：**真实 provider 未配置**，A36 未运行；图片识别任务入口已接好，未配置时不产生候选。

## 7. M6 交付与验收

已完成：演示夹具与运维脚本（`scripts/backup.sh`、`scripts/restore.sh`、`scripts/demo_live_flow.py`）；
`README.md` 的启动/迁移/账户/测试/备份恢复命令；`docs/acceptance-results.md` 逐条结果；真实浏览器 desktop + mobile 各 8 项；
备份在空库空目录恢复并逐项核对计数与文件校验和。

未完成：Compose 实际启动、远程部署、真实 provider 验证、真实 24 小时延迟效果。

## 8. 测试证据分级

| 证据等级 | 覆盖 | 是否已运行 |
|---|---|---|
| 自动化（pytest，PostgreSQL） | 单元判分/解析规则 + 集成全链路、隔离、幂等、重判、证据、计划、AI 降级、路由契约、验收映射 | 是，119 passed |
| 真实浏览器（Playwright） | 项目切换、五题型作答、草稿恢复、人工评分、答案暴露、计划/复习/报告、考点地图 | 是，desktop 8 + mobile 8 passed |
| 真实 provider | 真实图片识别与真实讲解人工核验 | **否**（无凭据） |
| 真实延迟学习 | 真实经过 ≥24 小时后完成 C 题 | **否**（只有注入时钟的逻辑测试） |

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
