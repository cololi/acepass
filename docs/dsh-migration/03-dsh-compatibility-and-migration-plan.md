# AcePass → DeepSeek Harness 插件：兼容性审计与迁移方案

> 决策（用户已确认）：**完全重写为 Node/TS 原生 DSH 插件**；AI 能力**改走 `dsh-llm`**；
> 本轮交付 = 需求/代码整理文档 + 插件骨架 + 本机加载验证。业务迁移按下面的阶段分批做，**未迁移的部分不会被标成已完成**。
> 本文数字均已与 02/01 及源码交叉核对（操作数 154 经独立 AST 扫描、实体模型 57 经 Django 注册表确认）。配套文档：[01 需求清单](01-requirements-inventory.md)（202 项需求、58 个原验收编号、28 条文档冲突）、[02 代码面清单](02-code-surface-inventory.md)。

## 0. 已确认的决策（用户，2026-11-05）

| # | 问题 | 决定 | 对方案的影响 |
|---|---|---|---|
| D-1 | 存储 | **`node:sqlite`** | 阶段 2 重写 57 个模型、31 个唯一约束（3 个条件唯一）、6 个检查约束；42 处 `select_for_update` 改为 SQLite 单写者事务，outbox 的 `skip_locked` 租约改为"短写事务 + 租约令牌 + 补扫"。**已在 DSH 自带运行时实测可用**（见 §0.1） |
| D-2 | 多用户 | **单用户 + 工作区隔离** | 隔离单位 = 工作区（每个 `.acepass` 一个库）；`owner` 层退化为 peer 校验；project/subject 两层隔离、答案隔离**一律保留**。账户/CSRF/登录模块（accounts 6 个操作）不迁移，改为宿主身份 |
| D-3 | 向量检索 | **外挂嵌入服务** | `embed` 能力不走 `dsh-llm`，由插件配置的独立嵌入端点提供（`embedding.baseUrl/model/apiKeyEnv`）；未配置时仍按既有"无向量明示降级"退为关键词通道。嵌入服务凭据**不得**进入产物 |
| D-4 | StudyHub | **并存** | 不导入其题库；`acepass` 工具名、数据目录 `.acepass`、存储键均与 StudyHub 隔离 |

### 0.1 `node:sqlite` 兼容性实测（DSH 自带运行时，非系统 Node）
- DSH 桌面版的 Node 是 **Electron 44.7.0 内置的 Node 24.21.0**（`ELECTRON_RUN_AS_NODE=1`），不是本机的 Node 24.18.0。
- 在该运行时内：`node:sqlite` 可用，SQLite 3.53.4；`CHECK`（含 `json_valid`）与 `FOREIGN KEY`（`pragma foreign_keys=on`）约束被强制执行（违反时抛 `ERR_SQLITE_ERROR`）。
- 测试同时在两个运行时下跑：`npm test`（系统 Node）与 `npm run test:dsh`（DSH 运行时）。**以 DSH 运行时为准。**
- 仍需在阶段 2 验证：WAL 并发读写、`BEGIN IMMEDIATE` 争用、崩溃恢复、`json_extract`/部分唯一索引语法、Decimal 以 TEXT 存储的比较。

## 1. DSH 插件契约（本机实测，非推测）

来源：已安装的 `DeepSeek Harness.app` 的 `app.asar`（`@deepseek-ai/*` 0.2.2-rc.1，Cordis 4.1.0），以及本机已装的同类插件
`@ericwang1358/dsh-daily-flashcard`（StudyHub 3.5.0）作为参照实现。

| 项 | 契约 | AcePass 的落点 |
|---|---|---|
| 包形态 | npm 包，`type: module`；`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，由 profile 的 `dsh.profile.bundles` 引用 | `dsh-plugin/package.json` + `cordis.patch.yml` |
| 宿主入口 | 导出 `name` / `inject` / `Config`(schemastery) / `apply(ctx, config)`，Cordis 插件 | `dsh-plugin/src/index.ts` |
| 依赖注入 | **读未声明的 service 属性会抛错**（`cannot get property "llm" without inject`）。可选能力必须 `ctx.get()` + try/catch 或 `ctx.inject([...], cb)` | 已实测并修复：`llm` 作为软依赖 |
| Agent 工具 | `ctx.inject(['tools'], c => c.tools.register(defineTool({name, description, parameters, output:{schema,render}, execute})))`；`output.schema` 必须是对象；返回 null/数组/标量会让整个调用失败 | `acepass` 工具 |
| 模型调用 | `ctx.llm.resolveCallConfig()` → `ctx.llm.stream()` → `BlockAssembler`；失败以终止 `finish` chunk 到达（`kind: error/aborted`），按稳定 `code` 路由，**不要按 message 判断** | `src/llm/port.ts` |
| Web 客户端 | `package.json` 的 `dsh.client = {platform:'web', inject:[...]}` + `exports["./client"]`；产物是 `window.__ModuleLoader__.load({id, factory})` 形式的 **lazy-CJS 包**，外部模块只能来自 shell 的共享模块表（含 react）；`require.async` 分块 | 阶段 6，见 §4 |
| HTTP/RPC | 插件**不自开端口**：经 `connection.fetch.register({path:'/api/...'})` 或 Typert `@Remote` 暴露；peer/owner 权限由宿主 `remoteAccess` 判定 | 取代 Django Ninja `/api`，见 §3 |
| 后台任务 | `dsh-jobs-local` / 插件自管队列；**没有** Celery/Redis | 取代 outbox，见 §3 |
| 会话 | 每个 DSH session 有 `cwd`（工作区）；StudyHub 以此定位数据库目录 | AcePass 数据放 `<workspace>/.acepass` |
| 版本声明 | `engines.dsh` 目前**仅声明性**，宿主不强制 | 已写 `>=0.2.0-rc.2 <0.3` |

### 本机环境事实
- Node v24.18.0；DSH SDK 0.2.2-rc.1；profile：`~/.dsh/profiles/web`（`patchReload: live`）。
- **应用内 SDK 不带 `.d.ts`**，无法对宿主做完整类型检查。已用 `src/host.d.ts` 只声明实际调用的表面，并在注释里标注来源；加宽接口时必须同时跑 `npm run smoke`。
- 本机 StudyHub 插件与 AcePass 功能有重叠（错题/闪卡/题库）。两者**可并存**，但 AcePass 的 tool 名固定为 `acepass`，不与其 `study_workspace` 冲突。

## 2. 兼容性审计：Python 世界里哪些东西在 DSH 里没有对应物

| # | AcePass 现状 | DSH 里的情况 | 结论 / 处置 |
|---|---|---|---|
| C1 | Django ORM + PostgreSQL 16（**已决策 D-1：node:sqlite**）：**57 个实体模型**（13 个模型文件）、59 个 JSONField（落为 JSONB）、31 个 UniqueConstraint（3 个带条件）、6 个 CheckConstraint、**42 处 `select_for_update`（2 处 `skip_locked`，在 outbox）**；未发现 advisory lock/GIN/tsvector/触发器（02 §2） | 无关系库；StudyHub 用内容寻址 JSON 分片库 | **最大风险**。需选存储：`node:sqlite`（Node 24 内置）或保留外部 Postgres。建议 `node:sqlite` + 事务；唯一/检查约束需逐条重写并有反例测试（见 §5 门禁） |
| C2 | Django Ninja REST（`/api/*`，**154 个操作 / 11 个 app**：GET 68、POST 77、PATCH 6、DELETE 2、PUT 1；其中 **48 个要求 `Idempotency-Key`**，见 02 §1） | 无 REST 框架；可注册 fetch 路由或 Typert Remote | 保留 HTTP 形态，用 `connection.fetch.register` 逐路由注册；请求/响应 JSON 契约不变，以便复用现有 HTTP 黑盒测试 |
| C3 | Django session + CSRF 登录、多用户 `owner` 隔离 | DSH 是本地单用户；非 owner peer 由 `remoteAccess.decide` 控制 | **语义变化，需要用户决策**：隔离单位从"账号"变为"工作区/peer"。R-INV 里"每个查询检查 owner/project/subject"保留 project/subject 两层，owner 层退化为 peer 校验。**不得**因此放宽答案隔离 |
| C4 | Celery + Redis 发件箱，派发租约 | 无 | 用进程内串行队列 + 持久化 outbox 表；保留"同轮 processed、旧任务不覆盖新版本、幂等"语义；崩溃恢复需重做故障演练 |
| C5 | `backend/ai/providers`（OpenAI 兼容，读 `DEEPSEEK_API_KEY`）+ 离线 stub | `ctx.llm`（凭据/模型由 DSH 统一管理） | 已改走 `dsh-llm`；**stub 不迁移**（见 C6） |
| C6 | stub provider 仅测试/演示可用，所有结果标 `is_stub` | 无对应 | 端口层**不提供 stub**；测试用注入的假 `llm` 对象，只存在于 `tests/`，不进产物。保持 R-INV-09 |
| C7 | **向量嵌入**（`embed`，混合检索的向量通道） | `dsh-llm` **没有 embedding 接口** | **已决策（D-3）：外挂嵌入服务**。`dsh-llm` 端口里 `embed` 仍固定返回 `ai_capability_unsupported`（不得伪装）；新增独立 `embedding` 端口走插件配置的端点；未配置则按既有"无向量明示降级"退为关键词检索 |
| C8 | 图片识别/手写转写（视觉） | 取决于所选模型的 `inputModalities` | 端口层先查 `resolveModelInfo().inputModalities`，缺失视为不支持（不向上猜）。纯文本模型不会被当视觉模型用 |
| C9 | `pypdf` 原生文字 PDF 解析 + 版式分类 | 可用 `pdfjs-dist`（StudyHub 已用 6.3.289）| 逐页分类/分栏/表格/公式判定是**几何启发式**，换底层库会改变坐标/字符流 → 必须用既有 PDF 夹具做逐页黄金对照 |
| C10 | `Pillow` 图片私有存储/校验 | `sharp`（profile 已带） | 低风险 |
| C11 | React Router `BrowserRouter` SPA（Vite，全局 URL） | 客户端插件挂在 DSH shell 内，**不拥有 URL** | 改 `MemoryRouter`/插件内部状态路由；KaTeX 样式与 `fetch('/api')` 前缀需适配；Vite 分块改为 tsdown/esbuild 的 `require.async` 分块 |
| C12 | SSE 分段讲解（`tutorStream.ts`） | Remote stream（WebSocket mux） | 改用 Typert `RemoteStream`；"仅发验证后片段、断线重连零成本"需重测 |
| C13 | 限时模拟考试的**服务端截止时间** | 本地单进程，时钟可信度更低 | 语义不变（截止时间由服务端存储），但"系统时钟被用户改动"成为新威胁面，需补测试并写进已知限制 |
| C14 | 数据库备份/恢复脚本、Docker/Nginx/TLS 部署 | 插件随 DSH 分发，无独立部署 | 备份改为导出/导入 `.acepass` 目录并校验；`infra/` 与 CI 的 Postgres/Redis 服务在迁移完成后退役（**迁移期间保留，作为对照实现**） |
| C15 | `engines.dsh` 不强制 | — | 兼容性靠 `npm run smoke` 在 CI 里对**目标 DSH 版本**重放，而不是靠声明 |

## 3. 目标架构

```
DSH host (Node)                                     DSH web client (browser)
┌───────────────────────────────────────┐           ┌──────────────────────────────┐
│ @acepass/dsh-plugin  (Cordis plugin)  │  fetch/   │ client bundle (lazy CJS)     │
│  ├─ domain/   纯函数（FSRS、判分、证据、 │  Remote   │  ├─ pages (React, 12 个路由页)│
│  │            规划、状态规则）  ← 黄金向量 │◄─────────►│  ├─ MemoryRouter             │
│  ├─ store/    node:sqlite + 迁移 + 约束   │           │  └─ KaTeX 按需加载            │
│  ├─ services/ 导入/题库/作答/暴露/任务/报告│           └──────────────────────────────┘
│  ├─ jobs/     持久化 outbox + 串行 worker │
│  ├─ llm/      port → ctx.llm（无 stub）   │
│  ├─ http/     connection.fetch.register  │
│  └─ tools/    `acepass` agent 工具        │
└───────────────────────────────────────┘
```
原则：**`domain/` 不依赖 DSH、不读时钟、不读存储**——这是能做逐位对照测试的前提，FSRS 已按此落地。

## 4. 分阶段迁移（每阶段有出口判据；未达标不得标完成）

| 阶段 | 内容 | 出口判据 | 状态 |
|---|---|---|---|
| 0 | 需求/代码面整理；插件骨架；真实 Cordis 加载验证 | 本文档 + 01/02；`npm run verify` 全绿 | **已完成** |
| 1 | 纯领域层移植：FSRS ✅、受限数学表达式判分 ✅、确定性判分 ✅、Python Decimal/文本/格式化 helper ✅、污染判定 ✅、延迟锚点 ✅、证据投影 ✅、状态投影 ✅、规划预算 ✅ | 每个模块有 Python 生成的黄金向量，逐位一致；反例（非法语法/超限/超时转人工）一致 | **9 个纯领域模块已完成**（含预算切分/题时估算）；剩规划候选查询与 `pairing.py` 的编排部分随阶段 2 的 store 一起做 |
| 2 | 存储层：schema、迁移、约束、不可变版本、幂等键 | 对 02 清单里的每个模型/约束有"违反即拒绝"的反例测试；并发提交幂等测试 | **基本完成**：schema 由 Django 模型自动生成（57 表 / 330 索引 / 31 唯一 / 6 检查，带漂移守卫）；31 个唯一约束与 6 个检查约束均有反例测试；幂等键指纹与 Python 逐位一致（含 Python 兼容 JSON 规范化）；outbox 的租约/令牌/B05 语义与失败重投已移植并有崩溃演练（真实文件、进程重启后接管过期租约）；不可变版本守卫**判定为服务层职责、非数据库约束**：Django 本身没有 trigger，`assert_draft`/发布门禁都在服务层（02 §2.11），因此存储层不引入比原实现更强的约束（那会是偏离），改为在阶段 3 逐个移植这些守卫 |
| 3 | 服务层 + HTTP：账户/项目/题库/导入/作答/暴露/评分/任务/报告 | 复用现有 `backend/tests/integration` 的 HTTP 黑盒用例，改指向新实现，**不改断言** | **进行中**：实体读写层 `src/store/repository.ts` 已完成（insert/update/get/find/findOne/count/compareAndSet/delete，按列 kind 编解码、未知列即拒绝、自动填 id 与时间戳、CAS 乐观并发）；141 条测试全绿。**accounts 切片已完成**：`src/services/errors.ts`（统一错误信封 `{error:{code,message,details,request_id}}` 与状态码映射）、`src/services/accounts.ts`（`/auth/me`、`GET/PATCH /me/study-settings`，含设置行惰性创建、时区/预算/占比校验、项目预算比例的活动项目与合计校验）。`auth/csrf|login|logout` **不移植**——DSH 拥有身份，且已确认「单用户+工作区隔离」。**exams 项目/科目切片已完成**：`src/services/exams.ts` 覆盖 8 个操作（projects 的 list/create/get/patch/archive/unarchive、subjects 的 list/create），含重名与归档守卫、`display_order` 递增、`ContentRevision` 审计行、作用域越权返回 404。**累计 17 个操作**：规范版本 list/create/publish 与大纲版本 list/create/publish 已完成，计分规则校验 `validateTypeRules` 用 28 条黄金向量与真实 `_validate_type_rules` 对拍（含「负 wrong_score 会被拒绝」这一与判分引擎不一致的既有行为，按现状保留）。**exams 全部 21 个操作完成**：新增试卷登记（自然键去重，重复上传不重复计数）、试卷详情、题项列表、覆盖率登记/确认、版本确认、设置有效版本。覆盖率语义按原实现：「填了数字」只是意图，`confirm` 才是人工声明，未确认前一律 `coverage_incomplete`；`mock`/`demo` 来源永不标成真题。题库域已开始：`src/domain/answers.ts` 移植 `validate_answer_payload`（77 条黄金向量、30 个 problem code，覆盖 6 种题型与全部嵌套规则）；`src/services/questions.ts` 实现 R-INV 1 的**发布版本不可原地改**守卫（`assertDraft`）、草稿创建/修改（带 `expected_version` 乐观锁）、发布前校验（缺答案/答案未核对/核对依据缺失/rubric 缺失与总分不符/材料题子题）、发布（写 `content_digest` 并指向 `current_published_version`）、撤回（回退到上一已发布版本）。封存（holdout）已移植：`src/services/sealing.ts` 是**唯一**判定"已封存"的解析器——按目标取**最新**策略修订（题目或题族各一条），封存题族覆盖其成员，解封是**追加新修订**而非改旧行，`/sealed-content` 只报告仍然生效的最新策略。知识映射与题族已完成：`src/services/mappings.ts`（映射**新开修订**、旧修订保留给历史证据；主要考点权重必须**恰好为 1**、辅助考点权重必须为 0 以免重复计分、跨科目考点即 403）；`src/services/families.ts`（家族 CRUD + 成员增删，**封存家族拒绝加入与移出**——移出最后一个成员会静默解封策略明确封存的内容，必须走显式 unseal）。**HTTP 传输层已建立**：`src/http/router.ts` + `src/http/routes.ts`，统一错误信封与状态码、`Idempotency-Key` 的 key/payload 重放与冲突、**claim 与副作用同一事务**（失败回滚即释放，无需显式 release）。14 条路由已挂载；9 条 HTTP 黑盒测试直接驱动 `Request`→`Response`。**发现一个宿主约束**：DSH 的 `connection.fetch` 注册表按**精确路径**索引（`fetchRoutes.get(url.pathname)`），带 `:param` 的动态路径无法注册 → 已只挂静态路径，参数化 REST 改走 Remote 通道（阶段 6 处理，已记录）。**作答提交（系统心脏）已打通**：`src/services/practice.ts` 实现 `submitAttempt`——先查考试截止时间（逾期是 409「已过截止」，不是笼统的「会话已结束」）→ 会话状态 → 重复提交拒绝 → `validateAnswerShape` 对照实际题面校验 → 写入原始作答案 → 判分（`domain/grading.ts`）→ 写入 `GradeEvent`（含 `rule_snapshot` 与 `rule_version`）→ 指向当前评分 → 按 `evidence:attempt:revision` 去重键入 outbox。争议答案不判分但**保留原始作答**并转人工。**闭环已打通**：`src/services/evidence_rebuild.ts` 把已对拍的领域模块接上真实数据（污染判定、延迟锚点、6 维证据、状态投影），`src/jobs/worker.ts` 消费 outbox：派发租约 → 消费者 claim（带 token）→ 处理器在事务内 `holdClaim` 复核归属 → 确认；失败记可重试失败、未知 topic 记永久失败（不静默确认）。**修正一处建模缺陷**：延迟锚点在 Python 里是**按考点**解析的，我此前的 `AttemptFacts.anchor` 是单值；已加 `anchorFor(nodeId)`，黄金向量仍全绿。**会话链已补全**：`src/services/sessions.ts` 实现 `createSession` / `presentItem` / `finishSession`——创建时**冻结**版本（题目版本、答案版本、rubric、考试规范、映射修订、满分），首现时间只写一次（刷新不得重置学习者时钟），`stem_delivered` 曝光行只记一次，题干载荷不含任何答案字段；封存题、无已核对答案、rubric 总分不符均在建题项前拒绝。**知识域已开始**：`src/domain/outline.ts`（词表解析，39 条黄金向量）与 `src/services/knowledge.ts`（考点列表/新增/改写/词表导入）——同义名**合并而非重复**（否则一个考点的分数会永久拆成两行）、改名/移动**禁止成环**、只能往已发布大纲里加考点。**每日计划已跑通**：`src/services/planner.ts` 实现 `generatePlan`——按固定类别顺序（到期延迟验证 → 到期记忆复习 → 薄弱点 → 未诊断探针 → 一般练习）填充同一份项目预算，候选必须仍可用（已发布 / 已核对答案 / 非 AI 推导 / 未封存）才可排入；刷新生成新修订且**只替换未开始的任务**，已开始的一行不动；时区按学习者的本地日期算"今天"（服务器时钟不作数）。**读路径已通 + 评测内容闸门**：`src/services/learning.ts` 提供证据/掌握状态/错题/作答详情/会话详情，并实现 `verificationContentMap`——正在进行的验证会按**内容**（同题、同族、同内容谱系）遮蔽所有投影，且**验证自身的题项不被遮蔽**（否则考生看不到自己的卷子）。HTTP 路由扩到 45 条；`toWireJson` 让 `Instant`/`Decimal` 以文本出线（否则 `JSON.stringify` 直接抛 BigInt）。**题库 23 个操作全部完成**：查询面（题目列表/详情预览/答案版本/来源区域/评分标准）已移植——列表带「已发布版本、最新版本、可信答案、主要考点」元数据；预览是**会写 `stem_delivered` 曝光**的读接口，封存内容按 C03 拒绝预览；版本补丁/发布/撤回、映射读写（新开修订）已挂路由；封存/解封（题目与家族）与 `/sealed-content` 上线；**家族合并（impact + merge）**按 C03 移植：合并后按「已见成员污染整个合并家族」重算暴露，把 `unseen_variant`/`template_variant` 证据**置为失效（不删除）**并重算受影响考点状态，重复合并是 `noop` 且不再抬 revision。三处顺序语义按 Django 修正并加测试：题族列表 `subject.display_order → name`、映射 `mapping_revision → node.canonical_name`、题目列表 `-created_at`。测试升至 **314 条**（新增 19 条：题库查询 9、家族合并 5、HTTP 黑盒 3、顺序回归 2），`npm run verify` 在系统 Node 与 DSH 运行时双跑全绿。**ingestion 已开工（B0）**：文本结构解析器整模块移植（`src/domain/ingestion/text_parser.ts` + `pystring.ts`，`parsePaste` / `parseAnswerPage` / `applyAnswerMatches` / `attachSourcePages` / `detectPageContinuations` / `attachCrossPageContinua`），黄金向量由真实 Python 函数生成（52 条粘贴样例 × 2 种模式（共 104 条向量）、19 条答案页、8 条匹配、6 条来源页、9 条跨页断点、5 条跨页切片），含 Unicode 空白、emoji 码点偏移与 Python `\b`/`\s`/`\d` 的类语义；O06 `POST .../imports/parse-text` 已挂路由（进程内），用 Ninja 的 400 错误形状钉住缺失/类型错误，并断言预览零写入；测试升至 **328 条**（新增 14：解析 9、HTTP 黑盒 5）。交付说明见 [08-ingestion-b0.md](./08-ingestion-b0.md)。**ingestion B1 完成**：`src/services/ingestion.ts`（createTextDocument / createImportJob / createSourceRegion / createCandidate / refreshCandidateIssues / updateCandidate / ignoreCandidate / confirmLayoutReview / maybeCompleteJob / addJobProblem / jobSummary / candidateSummary）、`src/services/ingestion_imports.ts`（startTextImport / retryJob）、`src/services/ingestion_access.ts`（editorial preview 曝光写入）与 `src/domain/ingestion/layout.ts`（`layout.py` 整模块）落地；O03/O04/O07/O10–O17 共 **11 个操作**挂进程内路由（累计 ingestion **12/20**）。候选 issue 门禁用**真实 Django 行**生成的 **30 组黄金向量**对拍（issue 顺序、duplicate_candidate/published/label、材料父子、答案页匹配待确认、卷面同号、layout blocking、跨页 warning、published/ignored 不回退、draft↔ready 迁移、job/candidate serializer），布局策略另 41 组；HTTP 黑盒 21 条覆盖幂等重放/冲突/键 trim 与长度、空文本后 claim 释放、21 段 422 整批回滚、O14 曝光去重、O15 旧 issue 快照与 revision 冲突、O16 完成 job、O17 ignored 可确认。测试升至 **389 条**（新增 61：B1 HTTP 21、review 黄金 30、layout 10），`npm run verify` 双运行时全绿。Django 实测探针 114 例见 [09-ingestion-b1-probe.md](./09-ingestion-b1-probe.md)；交付说明见 [10-ingestion-b1.md](./10-ingestion-b1.md)。**ingestion B2 完成**：O18 发布写集落地（`src/services/ingestion_publish.ts`：publishCandidate / ensureMaterialVersion / publishedChildVersionIds / reconcileMaterialChildren / writePaperItem / paperPositionKey），补齐 `questions.ts` 的 createQuestion / createQuestionVersionDraft / createAnswerKeyVersion / upsertRubricVersion，以及 `publishProblems` 的 rubric `full_clean`、填空各空合计、材料子题跨科目、答案版本不匹配四项；`exams.ts` 新增 addPaperItem（重复题号/科目/父题项/AI 题挂真实卷/负分，审计与 outbox 同事务）；`paper_stats.ts` + worker 消费 `projection.refresh_paper_stats`（只置 `is_stale`，不重算报表）。O18 挂进程内路由，响应按 `CandidateOut` 投影（幂等存储体含 `question_id`、HTTP 响应不含）。写集用**真实 PostgreSQL 行 + 真实 `publish_candidate`** 生成的 **24 组黄金向量**对拍（13 成功写集 + 11 拒绝；新行按角色命名，重跑逐字节一致），发布前校验另 13 组；HTTP 黑盒 19 条 + 闭环 4 条（发布→会话冻结→提交判分→证据重建→报表失效）。同时修掉两个跨批次缺陷：DecimalField 未按 `decimal_places` 量化（存储层按 schema 元数据 quantize，4 处测试期望改为库值）、`normalize_content` 把空数组当真值导致 `content_digest` 不同。ingestion 累计 **13/20**；测试升至 **450 条**（新增 61），`npm run verify` 双运行时全绿。Django 实测探针 40 例见 [11-ingestion-b2-probe.md](./11-ingestion-b2-probe.md)；交付说明见 [11-ingestion-b2.md](./11-ingestion-b2.md)。**B5 完成后 ingestion 20/20 已全部完成**（操作总数 **20** 已按 `apps/ingestion/api.py` 的 20 个路由与 02 清单逐条核对，规格见 [06-ingestion-port-spec.md](./06-ingestion-port-spec.md)）；**analytics 9 个操作全部完成（B6）**：practice/calibration/snapshots/cycle-analysis/coverage 五个报表与 regrade 创建/读取/立即执行/answer-reviews 四个操作上线，报表快照写集、查询参数解析、I-Key 契约与执行时代次护栏均与真实 Django 对拍；ingestion 的首个前置 **Django 自动 M2M through 表未进 schema/归档**（`import_job_documents`、`import_candidate_source_regions`）已在 B0 一并修掉——`gen_schema.py`/`export_db.py` 改用 `include_auto_created=True`，并补上 `unique_together` 的唯一约束（见 08 §8）；作答细节（草稿、确认评分、揭示、诊断、评分队列、转写、AI 估计/诊断）与知识域剩余操作（模板、配对、图谱、关系、先修、标签建议）仍在阶段 3 白名单上。**ingestion B3 完成（累计 17/20）**：O01/O02/O05/O08——私有对象存储（`<dataRoot>/private-media`，`.part`+rename，落盘 sha256）、真实 multipart 与 raw `Response` 传输、sharp 真实解码/去元数据重编码、四道下载门禁（内部审核→封存→editorial→contains_answers）与 `answer_delivered` 曝光台账。传输边界：四条路径都含参数，仍未挂到 DSH 的精确路径 registry，只声称进程内 `Request`→`Response` 可达（见 [12](./12-ingestion-b3.md) §3）。**ingestion B4 完成（累计 18/20）**：O09 `POST .../imports/pdf`——`src/ingestion/pdf.ts`（pdfjs-dist 6.5.438 legacy 构建，经 `createRequire` 解析、缺失即 503；读 **operator list** 而非 `getTextContent()`，因为后者会丢弃页面框外字形、并按 0.6em 拆 run，前者会凭空多出 `table_grid_detected`）、`src/domain/ingestion/pdf_layout.ts`（fragment 归一化、行/栏/grid/公式判定、栏优先重排、bbox 与 clamp 的纯移植，阈值与 `pdf_text.py` 逐条一致）、`startPdfImport`（异步提取在事务外、单事务内完成 documents→job→page_diagnostics→Paper/Revision→逐 paper 解析与跨页接续→候选/region→答案匹配→重复题号→problems）。对拍：7 份真实 PDF 的**逐页** text/页号/字符数/分类/诊断行全等、9 种拒绝的 message/details 逐字相等、44 条版式阈值向量（含 `<`/`<=` 边界与 `unambiguous=true` 但重建丢字符的路径）1e-12 容差全等、**12 组成功写集 + 6 组拒绝**（含「第二份损坏整体回滚」零写入）与真实 `start_pdf_import` 逐字段一致。发现并记录 pypdf 的 `TL = operand*font_size` 缺陷（`T*` 页面 baseline 被放大一个字号）——本移植用规范正确的 `CTM×TM`，只比文字与顺序，其余几何逐位相等（[04](./04-parity-findings.md) §L）。测试升至 **523 条**（新增 21），`npm run verify` 双运行时全绿；Django 实测探针 40 例见 [13-ingestion-b4-probe.md](./13-ingestion-b4-probe.md)；交付说明见 [13-ingestion-b4.md](./13-ingestion-b4.md)。**B5 完成 O19/O20 与图片 extraction worker，ingestion 累计 20/20**（变式纯规则/独立校验/发布门禁复核、异步 O19 幂等包装、worker 在事务外调用模型并在应用前重新持锁、单条 run 审计适配、生产无 stub）；黄金向量 30 条 + Django 探针 26 例，测试升至 **549 条**，差异见 [04](./04-parity-findings.md) §M，交付说明见 [14-ingestion-b5.md](./14-ingestion-b5.md)。**B6 完成 analytics 9/9，阶段 3 的 analytics 积压清零**：`src/services/analytics.ts`（practice 报告含快照写集与未完成范围、snapshots、coverage/completion、双门禁的 `scopedAttempts`、报表前结算过期模拟考）、`src/services/cycles.ts`（真实卷周期分析：只统计 official_past 非 demo、周期完整性、主权重归一、未分类桶）、`src/services/calibration.ts`（分组/样本门槛/可比性与 `assertNoCausalSummary` 形状守卫）、`src/services/regrade_runs.ts`（创建/执行/代次护栏/执行时目标争议拒绝/内容变更证据失效/answer-reviews）；worker 消费 `projection.run_regrade`。HTTP 9 条路由挂在 `src/http/analytics_routes.ts`，I-Key 缺失/超长 409、同键异载荷 details、`save_snapshot` 八词布尔解析、`limit`/`max_cycles` 的 int/missing 错误形状逐条按 Ninja 实测。黄金向量由**真实 PostgreSQL 行 + 冻结时钟 + 真实 analytics 服务**生成（practice 报告+快照整行+3 个查询变体、coverage/completion、cycle×2、calibration×2、answer-reviews、4 组 regrade 写集，重跑逐字节一致 sha256 `5585078…74d0`）；真实 Django 探针 **61 例**（9 个操作全覆盖），差异见 [04](./04-parity-findings.md) §N，交付说明见 [15-analytics-b6.md](./15-analytics-b6.md)。测试升至 **580 条**（新增 31），`npm run verify` 双运行时全绿。 |
| 4 | outbox/worker/重判/故障演练 | SIGKILL 后恢复、重复投递幂等、旧任务不覆盖新版本 | **已完成**：worker 消费 + `regrade.ts` 代次护栏；故障演练用**真实 SIGKILL 子进程**验证「崩溃≠确认」与重启接管，重复投递由租约争抢保证只处理一次，重判的旧代次**一行都不写**（含内容变更分支的证据失效） |
| 5 | AI：**7 个**已有提示词版本（`p0-extract-v1`、`p0-explain-v1`、`p1-transcribe-v1`、`p1-suggest-tags-v1`、`p1-diagnose-v1`、`p1-estimate-grade-v1`、`p2-propose-variant-v1`）+ 校验器 + `llm_run` 审计 + 降级 | `ai_not_configured` 全路径；校验失败留候选；无任何路径写正式分/掌握状态 | **纯层已完成并有端到端接线**：7 个 builder（40 条逐字符向量）、7 个校验器（168 条向量 + 93 个 problem code）、`llm_run` 24 列元数据与状态枚举、能力矩阵与降级；`acepass` 的 `ai_explain` 走通「提示词→模型→解析→校验→处置」全链路，`ai_not_configured` 全路径有测试。服务层落库（job/candidate/attempt 写入）随阶段 3 接 |
| 6 | Web 客户端（12 页）+ SSE→Remote stream | 浏览器验收套件（78 + stub 8 + 归档反例 2）迁移后通过 | **已完成（B8）**：B7 的 Remote 通道与 13 个路由页 + B8 补齐的阶段 3 剩余操作（揭示/草稿/评分确认/队列/附件提交、AI 读面、知识域、学习读接口、辅导流真实生产者，共 55 条路由 + `tutor.stream`）。浏览器验收（89 条收集）实测 **main 78/78、archive 3/3、@stub 0/8**；失败只剩 8 条 @stub，全部是 R-INV 4 的有意差异（DSH 无 stub provider），`unmigrated_stage3_endpoint` 与 `transport_client_defect` 清零。`expect()` 计数逐文件不变（只改登录/导航/响应观察/故障注入与同路由导航的整页重载）。B8 发现并修复的真实缺陷：`presentation` 少 11 个字段（草稿/附件/时钟/辅导门禁）、`get_attempt` 字段名与门禁、提交附件被误拒、`today/generate` 返回裸行、节点环文案缺「环」字（见 04 §P）。`npm run verify` 681 条测试双运行时全绿 + 加载烟测通过；B8 探针 27+57+49+43 例、黄金向量 3 份重跑逐字节一致。详见 17-b8-practice-and-page-gaps.md |
| 7 | 数据迁移：Postgres → `.acepass`；备份/恢复；退役 Django/Celery/Redis/Docker | 对一份真实库做导出→导入→全量对账（行数/哈希/统计数字一致） | **出口判据已达成（B9）**：`scripts/export_db.py` + `src/migrate/archive.ts`（两阶段导入）对真实 PostgreSQL **`acepass`** 库复跑：源库落后于当前迁移，`scripts/reconcile_db.mjs` 只读 introspection 后**克隆+跑 Django 迁移**再导出（源库不动），导入 `.acepass` 后 **59/59 张表**（57 个声明模型 + 2 个 M2M through）行数与逐行摘要全等、统计项逐项一致（18 §3）。**备份/恢复已交付**：`npm run db:backup`/`db:restore`/`db:verify`，`VACUUM INTO` 在线快照 + sha256/行数/摘要校验 + 非空目标 `--force` + 恢复前副本 + 恢复后完整性检查 + 失败回滚，真实 kill 演练与 12 条测试（18 §2）。**退役**：Celery/Redis/Docker 依赖面已盘点（12 task / 3 队列 / 2 beat / 10 topic / Redis 3 用途 / 8 个 Compose 服务 / 5 个 CI job），残留检查 0 违规；**实际退役被 F1–F4 阻塞**（DSH outbox worker 未接线、`plan.generated` 无 handler、topic 改名、3 个能力无等价实现），前置条件见 18 §4.5。**B10 已清账**：outbox worker 有运行时驱动（有界/可停止/可注入时钟）、`plan.generated` 有消费者、topic 改名走消费时别名 + D0 零在途门禁、3 个能力逐项移植并有 12 例真实 Django 探针；浏览器验收在 worker 运行中全量重跑（见 19）。**退役执行**：D0 检查工具可执行（验收 seed 10/10 processed、`{}`、exit 0）；D1 本机无 Celery 节点可停；D2 因「Redis 是用户原生服务 + broker 仍有 108 条在途消息 + 原生 Redis 无 AOF」未执行；Django 生产代码未删除（19 §4） |
| 8 | 异步链运行时接线、三个能力补齐、Celery 退役执行与最终收口 | submit 后无需手动 drain 即产生证据；`unresolved_summary()=={}` 且无未知 topic；D0–D2 的执行/回滚有记录；全量浏览器验收在 worker 运行中通过 | **已完成（B10）**：`startOutboxWorker` 接线 + `plan.generated`/`learning.reconcile_plan` 消费者 + 争议/证据失效/会话结束三个能力（真实 Django 探针 12 例、黄金向量 1 份、HTTP/服务黑盒测试）；D0 工具与 D1/D2 隔离演练记录（真实停机被环境阻塞，见 19 §4）；备份补 `--include-media`/`--keep`/HMAC；规划器 W1/W2 对齐（8 vs 8 候选、0 字段差异）。`npm run verify` **767 条**测试双运行时全绿 + 加载烟测；浏览器验收数字见 19 §5。**B11 决策执行**：Redis 108 条孤儿消息按授权丢弃（db0 `dbsize=0`，服务未停）；Django 按用户决定保留做对照（D3–D6 不执行）；W3 修复（Django `undiagnosed_candidates` 的 UUID/str 比较 + Node 对齐，探针 1 = 1）；插件装入 desktop profile 并用应用自身 `dsh-app-boot` 组合验证（18/18 bundle、0 skipped、`acepass` 条目），面板需重启应用后确认；备份调度按用户决定暂不安装。`npm run verify` **768 条**、Django 集成 353 条全绿（20）|

**对照实现策略**：阶段 1–6 期间保留 Django 后端不动，它是行为真相源；新实现用同一批夹具与黑盒测试对打。阶段 7 通过后才退役。

### 4.1 对拍基线：文档声称 ≠ 代码行为（来自 01 §6，已逐条抽查 D26/D27）
对拍必须以**代码实际行为 + 已有测试**为准，而不是以文档摘要为准。下列条目在 Django 实现里**未达到文档措辞**，迁移时先按"现状等价"移植，再单独立项补齐，**不得**在迁移中悄悄改变或悄悄宣称完成：
- **D26 / R-PLAN-02**：A42"整题余额再分配"未实现，`generate_plan` 只逐项目排题，`_plan_project` 返回的 `remaining` 仅用于备注。
- **D27 / R-PLAN-08–10**：未诊断预留只统计、不限制前序消耗；刷新计划不扣除旧的进行中/完成项。
- **D28**：状态规则"最近严格独立尝试"窗口按维度行与 `computed_at`，并未过滤辅助/污染排除原因。
- **D21**：`questions_list` 等在 `created_at` 并列时排序与优化前不同（R-GAP-06），黑盒对拍需避开并列时间戳。
- **D22**：`docs/review/2026-09-27/test_p0_regressions.py` 本身 1 failed/13 passed（优化前后相同），不能当作对拍 oracle。
- **D17**：受限数学判分是白名单解析器 + 预算 + 静态检查，**不是**独立沙箱进程；Node 移植保持同一安全断言，不引入 `eval`/`Function`/`vm`。

## 5. 不可退让的门禁（来自 R-INV，迁移不得为过测试而放宽）
1. 已发布版本不可原地改；历史作答与当时评分依据可复现。
2. 题干响应永不预带答案；练习/验证模式由服务端限制；暴露台账完整。
3. AI 只产候选/讲解/诊断，**不写**正式分、掌握状态、计划、统计；待评 ≠ 错题/0 分。
4. 无模型时功能照常，明示"AI 未配置"；**无 stub 进入产物**。
5. 所有副作用请求与异步任务幂等；重判不重复累加掌握次数。
6. 不编造官方真题、评分细则、通过概率、学习效果。

## 6. 决策记录
四项已在 §0 确认并生效；本节原有的开放问题已关闭。

## 7. 本轮已验证的事实（可复现）
```bash
cd dsh-plugin
export PATH="$PWD/../frontend/node_modules/.bin:$PATH"
npm run golden        # 用 Python 实现重新生成全部黄金向量（FSRS/表达式/Decimal/格式化/判分/证据-状态/污染/证据场景/规划）
npm run verify        # typecheck → build → 580 条测试（系统 Node + DSH Electron Node 双跑）→ 真实 Cordis+dsh-tools 加载烟测
```
- FSRS：184 条序列、逐步比对 `retrievability / interval / phase / lapse / S / D / learning_step / due_at(微秒)`，**全部一致**。
  过程中发现并修复了自己的 `formatInstant` 微秒 bug。
- 受限数学表达式：`compare` 115 / `normalize`+`free_variables` 190 / `evaluate` 33 条向量，规范串与错误类别全部一致；
  另有静态测试断言引擎源码不含 `eval`/`Function`/`vm`/动态 import，敌意输入只得到语法/超限拒绝。
- Python `Decimal` 算术：2500 组二元运算 + 上下文/量化/特殊值向量，经 `string→Decimal→string` 往返逐字符一致；
  精度 28、`ROUND_HALF_EVEN`、`str(Decimal)` 指数形式均与 CPython 对齐。
- 确定性判分：`adapters.py` 4883 条向量，`status / confirmed_score / parts / detail / notes / rule_snapshot` 全字段一致；
  不变量测试（答错必为 0、不可判定必为待评、主观题绝不自动给分、原型链污染载荷无法命中继承属性）通过。
- 加载烟测：把构建产物按真实安装布局放进 SDK 解析树，加载进**真实** Cordis + `dsh-system-prompt` + `dsh-tools`；
  `acepass` 工具注册成功并执行；无模型时 `explain → ai_not_configured`、`embed → ai_capability_unsupported`。
- 污染判定（`contamination.py`）：11 组真实行场景，逐条比对 `seen / reasons / first_seen_at / sources / strict_independent_eligible / exclusion_reasons`
  （含证据 id、`exposure_kind`、`session_item_id`、`server_time`）。覆盖绝对原因无视时间窗、窗口边界、跨项目谱系、合并家族互通、
  已展示未提交、被排除的会话项、按题目 id 兜底的暴露行、以及"同项目暴露不算谱系"的负例。
- 延迟锚点（`anchors.py`）：4 组真实行场景，锚点时刻与来源（`prior_attempt` / `teaching_exposure` / 无锚点）一致；
  锚点只认"已完成的学习事件"，展示与迟交都不参与计时（B04/C03）。
- 证据投影（`evidence.py`）：两层对照——609 条规则函数向量（内存假对象图）+ **24 条真实行场景**
  （真实会话/项/判分事件/暴露行/考点映射入库后由 Django 服务产出）。覆盖已判分但未满分、仅 AI 估计、自评确认、
  待复核、无答案版本、守时缺失、验证进行中、近重复家族、映射版本回退、外部已见、家族合并、延迟达标与 5 小时未达标。
- O18 发布写集（B2）：真实 PostgreSQL 行 + 真实 `publish_candidate` 生成 24 组发布向量（13 成功写集 + 11 拒绝）
  与 13 组 `publish_problems` 向量，逐字段一致；另有 40 例真实 Django HTTP 探针、19 条 HTTP 黑盒与 4 条闭环
  （发布→会话冻结→提交判分→证据重建→报表失效）。重跑生成器与已提交 fixture 逐字节一致。
- Python 浮点格式化（`pyfmt.ts::pyFormatFixed`）：`format(x, '.Nf')` 8200 条向量（1640 个值 × 0/1/2/3/6 位）
  与 CPython 逐字符一致，含次正规数、`1e300`、`2**53`、`-0.0`、`inf`/`nan`。该函数此前有一个只影响少数数值的
  尾数掩码 bug（`2.625` → `2.00`），修好后补了穷举对拍——这类 bug 场景向量抓不到（见 04 §E）。
- 规划预算（`planner.py`）：22 组切分（0/1/2/3/4/7 个项目 × 0–1440 分钟 × 轮转日期 × 各种百分比组合）与 12 组题时估算，逐字段比对项目顺序、每分钟数、`percent` 四位舍入、提示文案与 `rotation_offset`。`round()`/`round(x,4)` 用半数到偶（90s→2 分钟、150s→2 分钟、100/3 → 33.3333），不是 `Math.round`。
- 状态投影（`state.py`）：288 条规则向量 + 6 条真实行序列（12 步），逐步比对 `summary / best_summary / 各项计数 /
  recent 窗口 / needs_review / downgrade_reason / missing_evidence / source_evidence_ids`；`best_summary` 单调不下降。
  其中 `source_evidence_ids` 的顺序依赖查询返回顺序（原实现没有 `ORDER BY`），已按"库里自然顺序"冻结进黄金向量。

- 存储层（阶段 2）：schema 由 `scripts/gen_schema.py` 从 Django 模型自动生成（**59 表（57 个声明模型 + 2 个 Django 自动 M2M through 表）/ 334 索引 / 33 唯一约束（3 个条件）/ 6 检查约束**），
  `schema.test.ts` 重跑生成器逐字节比对，防漂移；`constraints.test.ts` 为**每一条**唯一约束与检查约束准备了"违反即拒绝"的反例，
  并断言约束数量与 01/02 清单一致（声明模型 31 条 + through 表 2 条 = 33）（31 / 3 / 6）。类型映射：`Decimal`→TEXT、时间→带偏移的微秒级 TEXT、JSON→TEXT+`json_valid()`、
  布尔→INTEGER；`Decimal` 的 CHECK 用 `CAST(... AS NUMERIC)`，否则 `'1.0' <= '1'` 按文本比较会把合法的满分权重拒掉。
- 幂等（阶段 2）：`fingerprint()` 与 Python 的 `json.dumps(sort_keys, ensure_ascii=False, default=str, separators)` 逐字符一致，
  24 条黄金向量 + 两个钉死的真实摘要；`pyjson.ts` 自带保留 int/float 区分的解析器（`1` 与 `1.0` 在 Python 里是不同载荷）
  与 BigInt 大整数路径。
- outbox（阶段 2/4）：租约 + claim token、B05（终态不得被迟到的失败改写）、"尝试次数是上限不是提示"、过期租约接管，
  13 条测试覆盖；`store_file.test.ts` 用真实文件做**崩溃演练**：消费者领租约后进程关闭，重启进程看到的是 `processing`
  且 `processed_at IS NULL`（崩溃绝不等于确认），过期后可被接管。

- AI 层（阶段 5）：7 个提示词版本 + system 常量 + 40 条 builder 向量**逐字符**一致；7 个校验器 168 条向量覆盖
  全部失败原因（重复/未知 ID/超上限/负分/答案泄漏/题干照抄/rubric 合计不符…）；`llm_run` 的 24 列元数据、状态枚举、
  能力矩阵与两类降级文案均与 Django `provider_status()` 对拍。生成器直接 import 真实 Python；重跑与已提交 fixture 逐字节一致。
  端到端接线：`acepass` 的 `ai_explain` 走完「提示词→模型→`parseModelJson`→校验→处置」，7 条测试锁住
  "无模型时明示 `ai_not_configured` 且不伪造结果"与"任何处置都不得包含正式分/掌握状态"。AI 层做了 19 处变异测试，
  首轮 2 处存活（截断/阈值边界缺向量），补齐后全红。
- 逐位对照中发现的**实现差异与已知缺陷**（KNOWN-1、DIV-1/2、JS-1/2/3）单列在
  [04-parity-findings.md](./04-parity-findings.md)，其中 KNOWN-1 是 Django 侧既有 bug，按"现状等价"复刻并建议另立修复。
- 题库面（阶段 3 续）：列表元数据（`has_trusted_answer` 只看已发布版本的 checked 且未争议答案；`knowledge_nodes` 只取 primary 映射）、
  预览的曝光台账（`stem_delivered`/`preview`/`question_detail`，封存内容拒绝）、答案版本 `is_usable`（checked 且未争议）、
  来源区域连接、rubric 作用域（404 而非 403）均有测试；发布/撤回/映射替换/加成员/合并的幂等键 scope 与 Django 一致，
  重放不产生第二次副作用（HTTP 黑盒测试驱动 `Request`→`Response`）。撤回的 `reason` 是 **query 参数**且参与幂等指纹，
  发布与映射替换的指纹分别固定为 `{}` 与「映射数组」——按 Django 的实现钉住，未按直觉改。
- 家族合并（阶段 3 续）：`merge_impact` 与 `merge_families` 共用同一套 helper，因此预览的数字就是合并的结果；
  合并把题目移入目标家族、目标 `revision+1`、写 `merged_into/merged_at` 审计对；随后按 C04 重算暴露
  （只报告由未见变已见的变化及其原因 `family_variant_seen`），把依赖「不同家族」的 `unseen_variant`/`template_variant`
  证据**置为失效**（保留行、写固定原因「家族合并后不再构成不同家族证据」），再重算受影响考点状态。
  重复合并返回 `noop=true`、零写入、不再抬 revision；自合并/跨科目/已合并到别处均拒绝。
- ingestion B0（阶段 3 续）：文本解析器整模块按 Python 逐分支移植，151 组黄金向量由**真实 Python 函数**生成；钉住了 Unicode 词边界/空白/码点偏移、材料父子状态机、答案页消费顺序与 `_page_for_offset` 的末页兜底（见 04 §H）。O06 预览零写入（57 张表行数不变），参数错误复刻 Ninja 的 `body` 定位形状。
- ingestion B1（阶段 3 续）：core/serializers 与 O03/O04/O07/O10–O17 完成（累计 12/20）。候选 issue 门禁用**真实 Django 行**生成的 30 组黄金向量（`gen_ingestion_review_golden.py`）逐字段对拍；布局策略 41 组；HTTP 黑盒 21 条钉住幂等键 trim/长度/释放、O07 21 段 422 回滚、O14 曝光去重、O15 pre-refresh issue 快照与「冲突仍写 exposure」的顺序、O16/O17 副作用。Django 实测 114 例记录于 [09](./09-ingestion-b1-probe.md)；对拍发现并修正 B0 的 `loc` 缺 `payload` 层（见 [04](./04-parity-findings.md) §I）。
- ingestion B3（阶段 3 续）：O01/O02/O05/O08 完成（累计 17/20）。`gen_ingestion_b3_golden.py` 用真实 PostgreSQL 行 +
  真实 `store_asset`/`create_image_document`/`find_duplicate_document`/`assert_asset_download_allowed`/`start_image_import`
  生成 **128 组**向量（25 store / 18 keys / 5 dedupe / 26 gates / 9 downloads / 9 assets / 11 image_sources / 8 image_imports）
  与 17 份图片字节，重跑逐字节一致（sha256 `f291cc88…ccb57b4`）；`probe_ingestion_b3.py` 记录 **64 例**真实 HTTP
  （O01 20 / O02 19 / O05 10 / O08 15）。**sharp 0.35.5 在两个运行时（系统 Node 24.22.2、DSH Electron Node 24.21）
  都完成真实解码与重编码**，所以图片路径不是单运行时结论。门禁顺序、exposure 的空关联形态、两条 404 文案、
  Ninja 的 `loc=["file","files"]`、声明 MIME≠真实格式、非图片 MIME 落成 image 文档，全部按实测钉住。
  两处**有意差异**（04 §K）：调色板 PNG 在 Django 里会丢调色板并改颜色、移植保留颜色；sharp 的 PNG 编码器与
  Pillow 不逐字节等价，导致「同图二次上传」的去重结果不同（算法一致、编码器不同，修它需要独立决策）。
- ingestion B4（阶段 3 续）：O09 完成（累计 18/20）。`src/ingestion/pdf.ts` 用 **pdfjs-dist 6.5.438 的 legacy
  构建**（现代构建 import 即要 `Uint8Array.prototype.toHex`，Node 24.22/24.21 都没有——实测抛
  `hashOriginal.toHex is not a function`），两个运行时都能 `require(esm)` 成功。适配层读
  `page.getOperatorList()`：`getTextContent()` 会（a）**丢弃页面框外的字形**（`table_formula` 夹具里
  `∫_0^1 f(x)dx 的值。` 的尾部 12 个字符消失）、（b）按 0.6em 视觉间隙把一段 run 拆成
  `chunk + " " + chunk`（`A. 甲` 变 3 个 item，双栏页每个选项行变 4 个 fragment → 凭空触发
  `table_grid_detected`）。两者都是内容/门禁变化，所以改用 operator list + 内容流状态机。
  对拍结果：7 份真实 PDF 逐页 text/页号/字符数/columns/grid/formula/scanned/reliable/diagnostics/
  diagnostic_row 全等；3 份显式 `Tm` 夹具的 fragment 几何 1e-12 内相等；9 种拒绝的 message/details 逐字相等；
  44 条版式阈值向量全等（`<` vs `<=`、gutter 恰好 12pt、纵向重叠恰好 0.5、crossing 恰好 0.25、
  `_lines`/`_x_clusters` 比锚点不比邻居、`_join_line` 的 0.36em、`_clamp_bbox` 原点回推、
  `page_map` 的 Python 码点语义）；12 组成功写集 + 6 组拒绝与真实 `start_pdf_import` 逐字段一致
  （含 `job.problems` 原文与顺序、候选 `draft_payload.source_spans[].bbox`、region char 偏移、
  paper/revision 字段与审计行、12 张表行数增量；拒绝用例行数前后完全相同）。
- 逐位对照中发现的**实现差异与已知缺陷**（KNOWN-1、DIV-1/2、JS-1/2/3）单列在
  [04-parity-findings.md](./04-parity-findings.md)，其中 KNOWN-1 是 Django 侧既有 bug，按"现状等价"复刻并建议另立修复。
  B4 新增 DIV-B4-1…4 与 KNOWN-B4-1（见 §L），其中 DIV-B4-1 是 **pypdf 5.1.0 的 `TL` 缺陷**
  （`pypdf/_page.py:1988` 的 `TL = operands[0] * font_size * scale_x`，使 `T*` 换行的第 2..n 行
  baseline 多乘一个字号：14pt 行距被报成 168pt），本移植用规范正确的 `CTM×TM`，只比文字与顺序。
- ingestion B5（阶段 3 续）：O19/O20 与图片 extraction worker 完成（ingestion **20/20**）。`src/domain/ingestion/variants.ts`
  移植 `_answer_consistency_problems` / `_proposed_score` / `_draft_payload`；`src/services/variants.ts` 移植
  `independent_checks` / `variant_review_issues` / `propose_variants` / `variant_jobs`，O19/O20 已挂 HTTP（幂等 scope
  `variants.propose:{project_id}`，指纹为四个默认值展开后的 body）。`src/services/ingestion_extraction.ts` 移植
  `extract_image_candidate` / `_apply_extraction` / `_mark_extraction_failed`（B06 迟到 revision 只写 machine record），
  `src/jobs/worker.ts` 新增 async 消费路径消费 B3 已入队的 `ingestion.extract_candidate`（模型调用在事务外，应用前重新
  `holdClaim`）。LLM 审计适配：O19 每调用**先建 failed run 再在同一条 run 上更新**（不生成第二条 run 修状态），
  `provider/model` 从 `result.route` 写入，`cost_known=false/cost_cents=null`，`is_stub` 字面量 false；无 llm/route 是
  `ai_not_configured`、模型未声明 image modality 是 `ai_capability_unsupported`，finish error/aborted 不当成功。
  黄金向量 30 条（10 answer consistency / 6 score / 3 draft / 8 checks / 2 review / 1 job summary，真实行 + 真实函数，
  重跑逐字节一致 sha256 `da98000d…037b6`）；Django 探针 **26 例**（O19 16 / O20 3 / extraction 7）；Node 测试新增 26 条
  （golden 7、O19/O20 HTTP 9、extraction 7、finish 语义 3），`npm run verify` 双运行时 **549 条全绿 + 加载烟测通过**。差异见 04 §M：
  DIV-B5-1（Django 真实 provider 的 `call.payload` 是 `{"text":…}`，变式校验必然 `not_object`；Node 改为解析
  `result.text`，真实模型可用）、DIV-B5-2（extraction 失败分支不覆盖人工草稿）、DIV-B5-3（`max_output_tokens=2000`
  未接，明确记为未达 parity）。
- analytics B6（阶段 3 续）：5 个报表 + 4 个 regrade/复核操作完成，阶段 3 的 analytics 积压清零。`build_practice_report` 的未完成范围（7 码）、`aggregate.lower_bound` 与 `final_result=null`、双门禁的项目级排除计数、快照整行写集均与真实 Django 逐字段一致；`paper_coverage`/`coverage_completion`/`cycle_analysis` 的分母、权重归一、未分类桶、周期阻塞原因与 `insufficient_cycles` 由真实行冻结；calibration 的分组统计、排除计数、可比性判定与禁因果形状守卫均一致（并复刻了「两个 ok 组不可比时 Django 500」的既有缺陷，见 04 §N）；regrade 的 201 幂等重放、执行时目标争议拒绝（200+failed+转人工）、旧代次零写入、内容变更证据失效、`invalidated_evidence` 一字段两义均按实测钉住。顺带修掉两处**早先模块的 parity 缺口**：状态投影现在按 `is_active=True, grade_revision>0` 取证据（此前会把被取代 revision 的合格行继续计数），验证内容门禁只覆盖已下发题项（`first_delivered_at`）。黄金向量 sha256 `5585078…74d0`，探针 61 例 sha256 `72e47a17…f70af`，测试 549→580，双运行时全绿。
- Web / Remote 通道（B7，阶段 6）：在**真实运行中的 DSH Web 应用**（`dsh web`，隔离 `DSH_HOME`，浏览器 Cookie 鉴权）里验证：
  `POST /api/acepass/rpc` 用同一个 `createFetchHandler` 重放逻辑请求，状态码/错误信封/`x-request-id`/`Idempotency-Key`
  重放与冲突全部沿用 HTTP 路由（浏览器实测：`/auth/me` 200、项目列表 200、新建项目 201 且二次提交只生效一次）；
  `GET /api/acepass/stream` 的 SSE 帧带单调 `id`，`?after=` 严格恢复、`done`/`error` 终态唯一、断开触发 `cancel()`，
  11 条 Node 测试钉住这些语义。客户端从真实 `frontend/src` 复制（不改页面业务代码），仅替换传输/身份/路由：
  13 个路由页在面板内挂载，首屏项目页、新建项目、科目切换经浏览器验证；`npm run verify` 602 条测试双运行时全绿。
  浏览器验收（89 条收集）实测 main 31/78、@stub 0/8（有意差异）、archive 1/3；`expect()` 计数逐文件相同。
  验收过程中发现并修复 5 个真实缺陷：`/auth/me` 多项目 500（§O20）、`POST /practice-sessions` 非 SessionOut 且时间戳为原始微秒（§O21）、
  `/session-items/:id/submit` 从未挂路由且请求体字段未适配（§O22/O24）、封存内容进入练习返回 404 而非 403（§O23）；
  另补挂研究结构路由（规范/大纲/考点/试卷）与 `<img>` 资产精确路由（§O17/O18）。
  宿主事实：精确路径注册表、同路径多方法必须合并、profile 插件在子 Cordis 树、`rpc.handle` 不可用（04 §O1–O3）；
  首启两个 dialog 会拦截点击、深色主题改写原生控件（04 §O7/O15）。**未验证**：真实模型调用、86 条验收的最终通过数。
- 阶段 3 剩余操作 / 页面缺口（B8，阶段 6 收口）：补齐 55 条路由 + `tutor.stream` 真实生产者——实践写路径
  （`reveal` 两条、`draft`、`confirm-grade`、`grading-queue`、提交 `asset_ids`）、AI 读面（`ai-status`/`ai-runs`/
  tutor 会话与流/转写/AI 估分与诊断/追问）、知识域（模板、配对、知识地图、关系与环拒绝、先修、标签建议）、
  学习读接口（今日计划、复习任务、学习任务、记忆卡、检索与重建索引、暴露台账、外部已见）。服务层按 Django 逐字移植，
  幂等 scope 逐字一致。**验证**：`npm run verify` **681 条**测试双运行时全绿（系统 Node 24.22.2 + DSH Electron
  Node 24.21）+ 加载烟测通过；真实 Django 探针 practice 27 / learning 57 / knowledge 49 / tutor 43 例；黄金向量
  `b8_learning` / `b8_knowledge` / `b8_tutor` 三份重跑逐字节一致；浏览器验收 **main 78/78、archive 3/3、@stub 0/8**
  （8 条全为 R-INV 4 有意差异），`unmigrated_stage3_endpoint` 与 `transport_client_defect` 清零。对拍发现见 04 §P
  （`confirm-grade` 首调/重放的两种形状、`presentation` 19 字段、`get_attempt` 字段名与读取门禁、附件提交、
  `today/generate` 返回 `TodayPlanOut`、hash 路由的同路由导航、配对走同步而非 outbox、无模型时 201+`unavailable`、
  转写闸门 409 先于 provider、节点环文案必须含「环」等）。
- 阶段 7 收尾 / B8 边界清账（B9）：**备份/恢复**——`npm run db:backup` / `db:restore` / `db:verify`，
  `VACUUM INTO` 在线一致快照（`sqlite.backup()` 在持续写入下会无限重启，实测后弃用）、单文件快照 +
  sha256/行数/摘要 manifest、非空目标 `--force`、恢复前自动副本、恢复后完整性检查（schema_version/表数/外键）
  与失败回滚；备份 kill、恢复 kill（rename 前后）真实进程演练，`tests/db_backup.test.ts` 12 条。
  **真实库对账**——真实 PostgreSQL `acepass` 库（落后于当前迁移）经只读克隆+迁移后导出，导入 `.acepass`
  后 **59/59 表**行数与逐行摘要全等、统计项逐项一致，`scripts/reconcile_db.mjs` 一条命令可复现（18 §3）。
  **运行时退役**——Celery 12 task / 3 队列 / 2 beat / 10 topic、Redis 三用途（result backend 是死配置）、
  Docker 8 服务、CI 5 job 全部盘点；`scripts/retirement-check.mjs` 对插件真树 0 违规（17 条测试）。
  **边界清账**——`delayedIntervalStatus` 合并为 `pairing.ts` 单一实现；`on_explanation_delivered` 移植但不接线
  （Django 生产零调用）；`Idempotency-Key` 缺失统一为 Django 的 409；规划器 reason_codes 词表与追加语义对齐
  （Django 探针 1→2→3 重复追加被逐项复现）；向量通道确认 D-3。**验证**：`npm run verify` 720 条测试双运行时
  全绿 + 加载烟测；`b8_knowledge`/`planner` 黄金向量重跑逐字节不变。**未完成**：Celery/Redis/Docker 的实际退役
  （F1–F4 阻塞，前置条件见 18 §4.5）、DSH outbox worker 运行时接线。详见
  [18-phase7-backup-restore-and-retirement.md](./18-phase7-backup-restore-and-retirement.md)。
- 异步链接线与退役收口（B10）：`src/jobs/worker.ts::startOutboxWorker` 在 HTTP surface 挂载后启动一个有界
  （每拍最多 10 条）、不重叠、可停止、可注入时钟的 outbox loop；dispose 先停 worker 再关库。提交/判分/重判/
  会话结束入队的事件在真实运行中被消费（不再需要人工 `drain`）；`plan.generated` 有对齐
  `learning.reconcile_plan` 的消费者。F4 三个能力逐项移植：`regrade_effects` 证据重建、争议答案的证据失效
  （`invalidate_for_answer_version` + `handle_answer_dispute` + `disputeAnswerKeyVersion`）、会话结束逐 attempt
  重建+刷新状态；顺带修正 Node 手动结束会话漏写 `revealed_at`/origin task completed 的缺口。真实 Django 服务级
  探针 **12 例**（一次性 test DB，重跑逐字节一致）、黄金向量 `b10_capabilities.json`。**退役**：`scripts/d0-check.mjs`
  落地（验收 seed 10/10 processed、`unknown_topics {}`、exit 0；反例 exit 3）；D1 无 Celery 节点可停；
  D2 因用户原生 Redis + broker 108 条在途 + 无 AOF 未执行；Docker daemon 不可达，只做 `compose config` 与
  `b10-drill` 隔离 override 校验（从未 `up`）；Django 生产代码未删除。**备份**补 `--include-media`/`--keep`/
  HMAC 签名（26 条测试）。**规划器 W1/W2**：weak 分支整体对齐（选择集/排序/`_question_for_node`/前置重排/
  deficit_notice），真实 Django 探针改前 8 vs 1、56 处任务差异 → 改后 **8 vs 8、0 差异**，`trigger_event` 两侧 `''`。
  新发现：Django `undiagnosed_candidates` 的 UUID/str 比较恒假（W3，未修，留单独批次）；`learning-states`
  响应形状缺平铺字段（worker 接线后导致知识页崩溃，已修）；`projection.rebuild_attempt_evidence` 改名走消费时
  别名 + D0 门禁（不改写导入行，避免破坏对账摘要契约）。`npm run verify` **767 条**测试双运行时全绿 + 加载烟测；
  全量浏览器验收在 worker 运行中重跑（19 §5）。详见 [19-b10-async-link-and-retirement.md](./19-b10-async-link-and-retirement.md)。
- B10 后决策执行（B11，详见 [20-post-b10-decisions.md](./20-post-b10-decisions.md)）：按用户 2026-11-08 的五项决定——
  Redis db0 的 **108 条孤儿 Celery 消息**（projection 58 + ingestion 50）已丢弃（只删 4 个 AcePass 键，
  `var/b11/redis-discard.json`，删除后 `dbsize=0`，Redis 服务未停）；Django **保留做对照**，D3–D6 不删除；
  **W3 修复**（Django 把 `diagnosed` 集合的 UUID 统一 `str`；Node `undiagnosedCandidates` 重写为「排除任何有状态
  节点 + primary published 映射 + 资格 + 名称排序」，探针新增正/负夹具后 Django 1 = Node 1、0 差异；
  连带确认并钉住「同一题可同时进入 undiagnosed_probe 与 general_practice」的 Django 行为）；备份调度暂不安装；
  插件装入 `~/.dsh/profiles/desktop`（备份 + `link:` 依赖 + bundle + node_modules 软链），用应用自身的
  Electron Node + `dsh-app-boot` 只读组合验证 **18/18 bundle、0 skipped、`acepass` 条目进入 223 条 entry 树**；
  未重启运行中的应用（会终止本会话），面板需重启后确认。`npm run verify` **768 条**双运行时全绿，
  Django 集成测试 **353 条**全绿。
- **未验证**：在运行中的 DSH GUI 里加载（见 §8）、真实模型调用（本环境无 provider）、嵌入/向量通道（DSH 无 embed 端点）、
  Celery/Redis 的真实停机（D1/D2 被环境阻塞，见 19 §4）、Django `undiagnosed_candidates` 的对齐（W3）。

## 8. 接入本机 DSH profile（显式、可回滚）
**没有**修改用户的 `~/.dsh/profiles/web`（那会影响正在运行的 GUI）。B7 用**隔离的 `DSH_HOME`** 验证了同一套接入方式：
```bash
cd dsh-plugin && npm run build          # 产物：lib/index.js（宿主）+ lib/client.js（浏览器）
# 1) profile 的 package.json：dependencies 加
#      "@acepass/dsh-plugin": "link:/Users/cololi/Documents/AcePass/dsh-plugin"
#    并在 dsh.profile.bundles 末尾加 "@acepass/dsh-plugin"
# 2) 在 profile 目录执行 pnpm install（或先手动建立 node_modules 链接）
# 3) 如需固定数据目录，在 profile 的 cordis.patch.yml 覆盖 config.dataRoot
# 回滚：删掉上述两处并 pnpm install。
```
实测要点（04 §O1–O3）：插件按 profile bundle 安装后，宿主半在**子 Cordis 树**里加载，Fetch 路由必须注册到
`ctx.root.get('connection')`；浏览器半由 `dsh-client-modules` 以 `window.__ModuleLoader__.load(...)` 形态加载，
`dsh.client.inject` 必须列出 `dsh-client-connection` / `dsh-client-ui-layout` / `dsh-client-ui-sidebar`。
`npm run build` 同时构建两半（`scripts/build.mjs` + `scripts/build-client.mjs`），`lib/client.js` 约 1.9 MB
（含内联 KaTeX 字体），只在打开面板时加载。
