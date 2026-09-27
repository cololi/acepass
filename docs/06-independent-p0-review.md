# AcePass P0 独立验收报告

验收日期：2026-09-27。审查 HEAD：`7db03c5`；应用代码版本：`5428018`。

**结论：已有可运行实现和测试基础，但未通过完整 P0 业务验收。下一轮应修复 P0 并重新验收，暂不进入 P1 功能开发。**

这不是只缺 API Key、等待 24 小时或启动 Docker：评分、验证隔离、复习入口、延迟调度、图片导入和辅导闭环还存在可复现缺陷。原交付报告保留为历史记录，本报告补充独立核查结果。

## 1. 本次实际执行与证据

| 检查 | 结果 | 能证明什么 |
|---|---|---|
| Git 状态与提交差异 | 审查开始工作区干净；5428018→7db03c5 只改两份状态文档 | 报告对应的应用代码未变化；实际只有一个后续文档提交 |
| 原后端全部测试 | **119 passed，22.83s**；独立 PostgreSQL 测试库 | 原套件可重复通过，不代表所有规格分支覆盖 |
| Ruff / 缺失迁移检查 | 通过；`No changes detected` | 静态规范和模型/迁移一致 |
| 前端 TypeScript + Vite build | 通过；有大于 500 kB 的 chunk 提示 | 可构建；打包体积不是本轮业务阻断 |
| 原 Playwright 套件 | **16 passed，26.5s**；桌面/手机各 8 | 真实 API 与浏览器下原断言通过 |
| 新增后端规格回归 | **13 failed / 1 passed，6.36s** | 失败覆盖实际缺口；通过项排除了“0 分被当独立正确”的猜测 |
| 新增浏览器回归 | **3 failed** | 提交后辅导入口缺失、刷新后 reveal 422、大题无照片输入 |
| 真实 Celery Worker | 收到未注册的 `learning.reconcile_plan`，丢弃消息 | 真实队列链路不完整，内联测试未发现 |
| 备份恢复 | 核对已存在恢复库及两张图片哈希，与原报告一致 | 存储层恢复有证据；不证明未消费任务能恢复 |
| 真实模型/真题/真实隔天 | 本次未运行 | 继续保持未验证，不把逻辑/演示当效果 |
| Compose 完整启动 | 本次未启动 Docker；生产 settings 探针安全复现失败 | 默认部署仍需修复和实机验收 |

浏览器复测专门使用独立数据库 `acepass_browser_audit_20260927`、Redis 6391、API 8001、Vite 5174 和独立媒体目录，另启动真实 Celery Worker。未使用原套件对当前开发库执行 reset/rebuild。验收结束已停止临时服务、删除本次浏览器库；现有 8000/5173 服务和业务库未修改。

新增文件仅为本报告、修复计划、回归测试及证据；**没有修改应用代码，也没有提交或部署修复**。

证据目录：[review/2026-09-27](review/2026-09-27/README.md)。包含 [后端失败输出](review/2026-09-27/regression-results.txt)、[原浏览器输出](review/2026-09-27/playwright-original-suite.txt)、[新浏览器失败输出](review/2026-09-27/ui-regression-results.txt)、[Worker 日志](review/2026-09-27/celery-worker.txt) 和截图。

## 2. 必须先修复的问题

下表 P1/P2 是缺陷优先级，和产品功能阶段 P0/P1/P2 不同。P1 问题应在本轮 P0 修复中解决。

### R01 · P1：复习和证据接口实际为 404

前端请求 `/api/v1/projects/{id}/learning-states`、`/evidence`、`/review-tasks`；后端 learning router 仍声明无项目路径的路由，并挂载到空前缀。三条独立回归均返回 404；原浏览器套件也记录相同 404，但只检查标题/空态仍通过。

位置：[learning/api.py](../backend/apps/learning/api.py) 231、255、271 行；[config/api.py](../backend/config/api.py) 43 行。

影响：考点证据和错题复习不能按约定取得数据。“路由参数问题已全部修复”的报告不成立。修复后需校验全部前端调用与 OpenAPI 路径，而非只检查少数路由。

### R02 · P1：评分完成与满分正确混用

10 分大题三项全部人工确认 `0+3+5=8`，实际返回 `pending_review`、`pending_max_score=2`，失分被当作未评分。客观判分 `_finalize` 的 `is_fully_confirmed` 也要求得到满分，语义同样错误。

位置：[attempts.py](../backend/apps/practice/services/attempts.py) 329–341 行；[adapters.py](../backend/domain/grading/adapters.py) 104–109 行；关联证据计算 [evidence.py](../backend/apps/learning/services/evidence.py) 199、255 行。

必须区分：`已全部评分`、`本题正确/满分`、`可作为无辅助证据`。待评分值只能来自尚未评分的分项，不能用满分减得分。修复后同步检查错题列表、正确率分母、失败后的状态降级。

已专门排除误报：当前 0 分作答没有被计为严格独立正确；本报告不声称这个未成立的问题。

### R03 · P1：验证中仍可获知成绩或直接取得答案

两条复现：

- 判断题验证提交只回执，但 GET 会话仍返回 `score_visible=false, confirmed_score="2.00"`；报告也给出 2/2，可推导答案。
- 保持 verification 活动，另建同题 practice 后 reveal，HTTP 200 返回 `answer_payload.value=true`。

位置：[sessions.py](../backend/apps/practice/services/sessions.py) 382–384、432–434 行；[reports.py](../backend/apps/analytics/services/reports.py) 86 行。

修复需要统一服务端用途门禁，覆盖会话汇总、报告、评分队列、证据、平行练习、辅导、来源图片及已知内容谱系。仅隐藏按钮或设置 `score_visible=false` 不满足契约。

### R04 · P1：旧重判任务能覆盖新答案

先申请答案 v2，再申请 v3；按 v3→v2 顺序执行，最终有效答案倒退 v2，得分从 2 变 0。当前检查使用执行时的当前 revision，不能表达“这项任务已经过期”。

位置：[attempts.py](../backend/apps/practice/services/attempts.py) 536 行附近；重判请求在 [analytics/services/reports.py](../backend/apps/analytics/services/reports.py)。

申请时分配明确目标 generation/revision；执行时比较目标，旧任务标 stale。补真实乱序、并发重投和重复执行回归，保留原作答与全部评分历史。

### R05 · P1：答案争议后仍能继续自动判分

先创建并呈现题项，再将其固定答案置 disputed，最后提交：实际仍 `confirmed` 并得 2 分。现有争议处理覆盖了已有作答，未覆盖已开始但未提交的会话。

位置：[attempts.py](../backend/apps/practice/services/attempts.py) 230 行附近。

提交与人工确认时重新核查固定答案/rubric 的当前可信状态；保存原始作答，但争议内容进入待复核。并发争议与提交必须有明确事务顺序。

### R06 · P1：延迟验证时间和启动模式不可靠

- A 在 25 小时前完成、B 刚提交，C 的 `not_before` 却落在 B 提交前 1 小时，锚点没有包含刚完成的 B。
- 将 C 设为明天到期，直接用 task_id 创建会话仍 HTTP 201，绕过等待。
- 复习页/今日任务的“开始验证”不传 mode；工作台默认 practice，后端也不由任务用途确定模式。

位置：[pairing.py](../backend/apps/learning/services/pairing.py) 168–174 行；[sessions.py](../backend/apps/practice/services/sessions.py) 85–98 行；[ReviewPage.tsx](../frontend/src/features/review/ReviewPage.tsx) 42 行；[PracticePage.tsx](../frontend/src/features/practice/PracticePage.tsx) 147 行。

统一“启动任务/按任务创建会话”的领域校验，重新计算锚点并检查到期；由服务端任务用途固定 verification，不能信任客户端改成 practice。用户提前训练应显式进入普通练习并重置延迟锚点。

### R07 · P1：图片导入不是只缺模型凭据

实际 multipart `files` 上传返回 400，报 `body.files Field required`；入口使用 `list[File[UploadedFile]]`，和前端发送方式不匹配。绕开 HTTP 直接调用图片导入服务，在已配置支持视觉能力的 stub 下仍只创建 `image_manual` 候选，模型调用次数为 0、extract 的 LLMRun 为 0。

位置：[ingestion/api.py](../backend/apps/ingestion/api.py) 338–346 行；[imports.py](../backend/apps/ingestion/services/imports.py) 97–145 行。

另有 `ingestion.extract_candidate` 任务，但它导入不存在的 `services.extraction`。仅有 provider 能力声明、prompt 和 validator 不代表业务链已接通。[audit/tasks.py](../backend/apps/audit/tasks.py) 177–188 行。

图片校对页面也只展示 crop_asset，初始整页 region 没有 crop；编辑器不能补齐选项、空位、图像与材料子题。需要先完成可实际操作的人工路径，再接通真实/假 provider 共用的提取任务。

### R08 · P1：作答后的个性化辅导闭环不完整

提交后页面没有 AI 提示/完整讲解入口；浏览器回归已失败。后端即使直接调用 tutor，prompt 只含评分状态及分项状态，未包含学生实际答案和步骤；两个独立标记均未进入 prompt。主题干还只提取 text，不完整携带数学块、图片、共享材料和 rubric 内容。

位置：[PracticePage.tsx](../frontend/src/features/practice/PracticePage.tsx) 335、470–491、501–544 行；[tutoring/services/core.py](../backend/apps/tutoring/services/core.py) 110–122、165–178 行。

恢复“做错→查看自己原始作答→针对卡点讲解→配对验证”。保持提示/完整讲解用途差异；按权限和受控资源构造完整上下文，不把缺失内容交给模型猜测。

### R09 · P1：已提交题刷新后的答案入口损坏

提交后刷新，点击“查看答案与解析”，实际请求 `/session-items/undefined/reveal`，HTTP 422。原因是已有 attempt 时不加载 presentation，但 reveal 仍从 presentation 获取题项 ID。

位置：[PracticePage.tsx](../frontend/src/features/practice/PracticePage.tsx) 76、192、538 行。[浏览器截图](review/2026-09-27/screenshots/reveal-after-reload.png)。

稳定题项 ID 必须来自会话/URL 状态，不能依赖另一分支的临时查询缓存。补刷新、深链接和重新登录后的恢复回归。

### R10 · P1：大题与多项目用户路径缺项

| 缺项 | 证据 | 修复要求 |
|---|---|---|
| 大题只有文本框，无照片上传；提交不带附件 | [PracticePage.tsx](../frontend/src/features/practice/PracticePage.tsx) 174、432–443；真实浏览器回归失败 | 上传/预览/删除未提交附件、草稿、提交后不可变图片 |
| 人工评分页不显示 raw_answer、steps、attachments | [GradingPage.tsx](../frontend/src/features/practice/GradingPage.tsx) 154–221 | 原始作答与 rubric 同屏，避免凭记忆打分 |
| 全局今日任务点击另一项目任务不切项目 | [TodayPage.tsx](../frontend/src/features/today/TodayPage.tsx) 55–69 | 同步项目/科目/任务上下文，向正确项目创建会话 |
| 新建科目后仅刷新项目列表 | [SettingsPage.tsx](../frontend/src/features/settings/SettingsPage.tsx) 107；[context.tsx](../frontend/src/app/context.tsx) 183、216 | 科目立即进入下拉，不要求手动刷新 |
| 复习/评分队列科目过滤不完整 | [ReviewPage.tsx](../frontend/src/features/review/ReviewPage.tsx) 22–28；[practice/api.py](../backend/apps/practice/api.py) 502 | UI 参数与服务端 scope 同步；切科目有数据断言 |

除照片输入已通过真实浏览器复现外，其余条目为代码路径确认，需要修复阶段补完整浏览器用例。

### R11 · P1：真实异步任务与恢复语义不完整

本次独立真实 Worker 运行：生成计划发出 `learning.reconcile_plan`，Worker 报未注册并丢弃。其他注册的任务能处理；隔离库最终有 96 条 evidence、3 条 knowledge state，仍有 1 个该主题 outbox 停在 dispatched。这不等于整个队列完全不可用，但证明任务注册闭环不完整。

位置：[planner.py](../backend/apps/learning/services/planner.py) 463 行；[audit/tasks.py](../backend/apps/audit/tasks.py) 中不存在对应 consumer。[运行摘要](review/2026-09-27/isolated-browser-db-summary.json)。

更严重的恢复问题：send_task 成功就写 dispatched，扫描只扫 pending。Redis 被清空/重启或从只备份 PostgreSQL 的备份恢复，已派发未消费任务不会重派；failed 也没有恢复扫描。内联模式还会在消费者已写 processed 后再写回 dispatched，需要一并修复状态机。

位置：[outbox.py](../backend/apps/audit/services/outbox.py) 59–70、90–99、109–112 行；[docker-compose.yml](../infra/docker/docker-compose.yml) 58 行关闭 Redis 持久化。

原本机库的只读快照里 evidence/state/review_task 都为 0，outbox 103 条全部 dispatched、processed_at 为空；README 却将 Worker 写为可选。原浏览器套件允许空态，因此绿灯不能证明 A→B→C 已经跑通。

### R12 · 发布门槛：Compose 与备份恢复边界

生产设置实测：探针 Host 127.0.0.1 返回 400；改为 localhost 返回 HTTPS 301，而 API 只提供 HTTP。web 又依赖 API healthy；nginx 只监听 80 且固定传 `$scheme`，TLS 终止方式未闭合。

位置：[docker-compose.yml](../infra/docker/docker-compose.yml) 77–78、143–144 行；[nginx.conf](../infra/proxy/nginx.conf) 11、27 行；[prod.py](../backend/config/settings/prod.py) 14 行。

其他修复：恢复脚本不检查目标媒体目录为空，可能覆盖文件（[restore.sh](../scripts/restore.sh) 38–40）；CI `check --deploy || true` 吞掉所有错误（[ci.yml](../.github/workflows/ci.yml) 64）；缺 `.dockerignore` 会把本地 venv 放进镜像上下文，Gunicorn 单独安装未锁版本。前两项影响恢复/发布可靠性；镜像整理可随部署验收完成。

## 3. 对原验收结论的修正

| 原结论 | 独立核查后的边界 |
|---|---|
| 119 passed | 属实；新增用例发现未覆盖的分支，不能直接映射为 A01–A42 全面完成 |
| 五题型浏览器通过 | 原用例允许缺题型 continue 且只要求 seen >=3；需改成五种全通过并检查结果 |
| 验证模式隐藏评分通过 | 原浏览器同名用例只测 practice reveal；API 旁路确实泄露分数/答案 |
| 复习和证据页面可用 | 页面标题出现，但真实请求 404；空态被用例当通过 |
| 大题人工确认通过 | 满分路径通过；部分分错误，页面也未展示原始作答 |
| A22 乱序重判通过 | 原测试不覆盖 v3 先执行、v2 后执行；新增复现失败 |
| A30 延迟边界通过 | 单一时钟边界通过；B 锚点和按 task 创建会话的旁路仍失败 |
| 图片识别已实现，仅缺 Key | 不成立；上传 HTTP 契约和提取任务接线尚未完成 |
| 备份 tasks 19/19 | 19 指 study_task；不是 19 个延迟 review_task。存储校验不能代替异步恢复验收 |

PostgreSQL 16.15 与原方案 17 的差异可以作为经过验证的环境选择记录，本次不要求为修复业务缺陷而先升级数据库。目录调整及路由显式化本身也可接受，但实现需覆盖全部模块。

## 4. 下一步决定

执行 [P0 修复与重新验收计划](07-p0-repair-plan.md)。先确保可信评分和验证边界，再补闭环与交付可靠性；真实 provider 验证安排在代码接通之后。无需为了开始修复先提供模型密钥，也无需等待真实 24 小时。

真实时间体验和学习效果研究继续独立记录，不是替代上述逻辑修复的理由。未经授权不向远程环境发布。
