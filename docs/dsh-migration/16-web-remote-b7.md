# 16. B7：Remote 通道 + Web 客户端 12 页（B8 已收口）

> 状态：**B7 已交付，B8 已收口**。本文件记录 B7（传输层 + 页面接线）的交付与当时实测；
> 阶段 6 的最终数字（main 78/78、archive 3/3、@stub 8 条有意差异）与阶段 3 剩余操作的移植见
> [17-b8-practice-and-page-gaps.md](./17-b8-practice-and-page-gaps.md)。本文件 §7/§8 的数字是 B7 当时的历史实测。

## 1. 范围

阶段 6 的出口判据是「Web 客户端 12 页 + SSE→Remote stream，浏览器验收套件（78 + stub 8 + 归档反例 2）迁移后通过」。
B7 负责传输层与页面接线；浏览器验收的数字在第 6 节给出实测结果，未通过项按原因分类，不静默改断言。

## 2. 宿主约束（本轮实测）

在**运行中的 DSH Web 应用**（`dsh web`，隔离 `DSH_HOME`）里逐条验证：

1. `connection.fetch` 仍是**精确路径**注册表：`fetchRoutes.get(url.pathname)`，`:param` 模式永不匹配；同一路径只能注册一次，方法集合并存。
2. 配置文件插件（profile bundle）加载在**子 Cordis 树**：`ctx.get('connection')` 拿到的 `HostConnectionService` 不是挂在 Web 服务器上的那个实例；写进子实例的 Fetch 路由永远 404。
3. `connection.rpc.handle(channel, handler)` 对树外插件**不可用**：它用连接服务自己的 Context 读 `webServer`，该 Context 没有注入 `webServer`，抛 `cannot get property "webServer" without inject`。只有 `rpc.intercept('/api', ...)` 可用，而 `/api` 已被 Typert Gateway 占用。
4. 结论：参数化 REST 走**一条精确路径** `/api/acepass/rpc`（POST），流走 `/api/acepass/stream`（GET/POST，SSE）。两者都用根实例注册（`ctx.root.get('connection')`），并按**活路由表**而不是对象身份去重（Cordis 每次 `get` 返回新代理）。

## 3. 传输契约

### 3.1 一元调用 `/api/acepass/rpc`

请求：

```json
{ "method": "GET|POST|PATCH|PUT|DELETE",
  "path": "/api/v1/projects/<id>/questions",
  "query": { "limit": "20" },
  "headers": { "idempotency-key": "..." },
  "body": { "...": "JSON 载荷" },
  "fields": { "...": "multipart 文本字段" },
  "files": [{ "field": "file", "filename": "a.pdf", "contentType": "application/pdf", "base64": "..." }] }
```

响应：

```json
{ "status": 200, "headers": { "content-type": "application/json; charset=utf-8", "x-request-id": "req-1" },
  "encoding": "utf8", "body": "<原样响应体>" }
```

- 宿主用**同一个** `createFetchHandler` 重放请求：状态码、错误信封、`x-request-id`、`Idempotency-Key` 的 key/payload 重放与冲突、claim 与副作用同事务，全部沿用 HTTP 路由的实现，不存在第二套业务逻辑。
- 二进制响应（O02 私有媒体）以 `encoding: "base64"` 返回。
- 请求体上限 64 MiB，超限 413；信封非法 400。
- 静态路径（无 `:param`）同时按精确路由直接挂载，浏览器可直接 `fetch`。

### 3.2 流 `/api/acepass/stream`

`GET /api/acepass/stream?op=<name>&after=<seq>`，`text/event-stream`：

- 每帧带单调 `id:`（= `seq`），`?after=` 严格恢复，重连不重放、不跳过。
- `event: done` 终止；`event: error` 带 `{code,message}` 并终止；`: keep-alive` 心跳。
- 客户端断开 → `cancel()`，生产者停止。
- `tutor.stream` 目前返回终态 `service_not_migrated`（辅导队列仍是阶段 3 白名单），不伪造任何片段。

### 3.3 有意差异

| 项 | Django | DSH |
|---|---|---|
| 身份 | 邮箱/密码 + CSRF | DSH 会话；无登录页、无 CSRF |
| 路由 | 真实 URL | 面板内 `HashRouter`（`#/questions`），深链/刷新保持页面 |
| 传输 | 同源 `fetch` | `transportFetch` → `/api/acepass/rpc` |
| 流 | SSE | SSE over 精确 Fetch 路由（DSH Remote mux 需要生成型 `RemoteStreamHandle`，树外插件不可用） |

## 4. 页面清单

| # | 路由 | 页面 |
|---|---|---|
| 1 | `/` | 项目 |
| 2 | `/today` | 今日学习 |
| 3 | `/practice` | 刷题 |
| 4 | `/questions` | 题库 |
| 5 | `/imports` | 导入 |
| 6 | `/imports/:jobId/candidates/:candidateId` | 候选审阅 |
| 7 | `/knowledge` | 考点地图 |
| 8 | `/search` | 检索 |
| 9 | `/review` | 错题与复习 |
| 10 | `/memory` | 记忆卡 |
| 11 | `/grading` | 人工评分 |
| 12 | `/reports` | 报告 |
| 13 | `/settings` | 设置 |

页面源码从真实 `frontend/src` 复制（不改写业务 UI），只替换传输层与身份层；页面不直接读 SQLite。

## 5. 验证

### 5.1 进程内 / 传输层（`npm run verify`）

- `tests/remote_channel.test.ts` **12 条**：路径翻译、同路由重放（状态/头/体）、幂等键在 RPC 上的重放与冲突、
  超限 413、非法 JSON 400、multipart 重建（fields + base64 files）、二进制响应 base64、精确路由按路径分组
  （`/me/study-settings` 的 GET/PATCH 共用一次注册、无 `:param`、无重复）、流的 `seq`/恢复/终态/取消/未迁移操作。
- `tests/study_routes.test.ts` **2 条**：规范/大纲/考点/试卷的 HTTP 黑盒（含「无计分规则不得发布」「重复登记复用同一试卷」「未知版本登记覆盖 404」）。
- `tests/accounts.test.ts` 新增 **1 条**：账户有 3 个项目时 `/auth/me` 仍返回 `needs_project_setup:false`（修复 04 §O20）。
- `tests/acceptance_seed.test.ts` **6 条**：夹具的项目/科目/五题型/周期统计/幂等重跑/「延迟验证如实标 skipped」。
- `npm run verify`：**602 条**测试在系统 Node 24.22.2 与 DSH Electron Node 24.21 双运行时全绿，加载烟测通过。

### 5.2 运行中的 DSH Web 应用（浏览器）

隔离 `DSH_HOME` 下启动 `dsh web`，插件按 profile bundle 安装，Playwright 真实浏览器：

- 浏览器鉴权：`?token=` 首次导航 → Cookie 会话；`/api/acepass/rpc` 与 `/api/acepass/stream` 均可达。
- 账户/项目/科目：`GET /auth/me` 200（owner）、`GET /projects` 200、界面新建项目 201 且上下文条切换。
- 13 个路由页逐一挂载（`.acepass-root` 存在、无错误边界、无 console error），有项目的上下文下各页发出的
  逻辑请求与状态见 `dsh-plugin/var/audit/pages.json`。B7 补挂了研究结构路由（规范/大纲/考点/试卷，91 条路由），
  并用真实浏览器验证「科目→规范→发布→大纲→发布→考点→列表」与「试卷登记一次、重复上传复用」闭环。

### 5.3 浏览器验收（78 + stub 8 + 归档 2）

（见 §7，由 B7 验收迁移结果填充）

## 6. 已知边界

### 6.1 前端 API 面上尚未迁移的路径（B8 范围）

以下路径被页面真实调用，服务层仍在阶段 3 白名单（04 §O13）；页面显示真实错误，不编造数据：

| 页面 | 缺失路径 |
|---|---|
| 今日学习 | `GET /study-plans/today` |
| 检索 | `GET /projects/{id}/search` |
| 错题与复习 | `GET /projects/{id}/review-tasks` |
| 记忆卡 | `GET/POST /projects/{id}/memory-cards`（含 logs/rebuild/suspend/resume） |
| 人工评分 | `GET /projects/{id}/grading-queue` |
| 报告/设置 | `GET /projects/{id}/ai-status`、`GET /projects/{id}/ai-runs` |
| 作答细节 | `attempts/{id}/diagnosis|ai-estimate|transcriptions`、`diagnosis-follow-ups/*`、`transcriptions/*/confirm|reject` |
| 知识域 | `knowledge-relations`、`knowledge-nodes/{id}/prerequisites`、`tag-suggestions/*`、`questions/{id}/exposure|external-seen` |
| 辅导流 | `GET /projects/{id}/tutor-jobs/{id}/stream`（`tutor.stream` 返回 `service_not_migrated`） |

### 6.2 传输层

- 流是 SSE over 精确 Fetch 路由，不是 Typert `RemoteStream`（树外插件无生成型 handle）；语义（游标、恢复、终态、
  取消）由测试钉住，但不具备 DSH mux 的跨物理重连与 uplink。
- RPC 请求体上限 64 MiB；上传走 base64（+33%），大数据量导入受内存限制。
- 无登录/CSRF：DSH 会话即身份；`/auth/login|logout|csrf` 不移植。
- DSH 深色主题下原生控件的对比度由 `.acepass-root` 局部覆盖，未做完整主题适配。

## 7. 浏览器验收迁移结果

套件：`frontend/tests/dsh`（9 个 spec，43 个 test body × desktop/mobile = 86）+ `tests/dsh/archive`
（归档反例 3 条，其中 2 条是出口判据计数、1 条为被主套件覆盖的照片输入重复冒烟）。`expect(...)`
逐文件与原件相同（计数与文本哈希一致），只替换登录/导航/响应观察/故障注入等传输机制。

夹具：`scripts/acceptance-seed.mjs` 经服务层生成——3 个项目（验收项目A/B/C）、5 个科目、28 个已发布版本
（五题型：单选 12 / 多选 4 / 判断 4 / 填空 4 / 大题 4）、周期统计科目（2019–2023 完整 + 2024 不完整 + 演示卷）；
延迟验证链未生成（`skipped:["delayed_verification"]`，需要未移植的配对服务），相关用例按 `unmigrated_endpoint` 归类。

**最终实测（最新构建，隔离实例 + seeded 夹具）**：

| run | collected | passed | failed |
|---|---|---|---|
| main | 78 | **31** | 47 |
| @stub | 8 | **0** | 8（有意差异：DSH 无 stub provider，R-INV 4） |
| archive | 3 | **1** | 2（归档反例 **2/3**：#1 辅导入口、#2 揭示后刷新均依赖未迁移的 `/reveal`、`/messages`） |

失败分类（57 红）：`unmigrated_stage3_endpoint` **37**、`transport_client_defect` **12**（其中大多数已在本轮修复或由封存污染连锁导致，
见 04 §O23/O24）、`intentional_divergence` **8**（@stub）。逐条结果与 `expect()` 保留表见
[b7-report.json](../../dsh-plugin/var/acceptance/b7-report.json) 与 [SUMMARY.md](../../dsh-plugin/var/acceptance/SUMMARY.md)。
**阶段 6 因此未达标**：主套件 31/78，不是 78。B8 的第一优先是揭示（7 条直接用例 + 五题型主证据链），其次是草稿（15 条引用）、
knowledge-map（11）、confirm-grade/grading-queue（6）与知识域各面。

## 8. 下一批（B8）范围

按 B7 验收的失败分类与页面审计（`dsh-plugin/var/audit/pages.json`、04 §O13）排序。每条新服务行为仍按既有规则：
真实 Django 探针 + 真实行/真实函数黄金向量（重跑一致）+ HTTP/Remote 黑盒 + 双运行时 verify。

1. **揭示 `POST /session-items/{id}/reveal`（最高优先）**：验收里 7 条直接用例（五题型循环、验证进行中 403
   `purpose_not_allowed`、刷新后 200、归档 1 条），并让「五题型」这条主证据链恢复（它要读 `answer_payload`
   来选正确答案）。门禁与 Django `delivery_hidden_for_item` 完全一致，禁止为过测试放宽 R-INV 2。
2. **评分确认与队列**：`POST /attempts/{id}/confirm-grade`、`GET /grading-queue`、`PATCH /session-items/{id}/draft`
   （6 条直接用例 + 照片作答/报告下界依赖）。
3. **AI 读面**：`GET /projects/{id}/ai-status`、`GET /projects/{id}/ai-runs`（各约 10 条用例引用；无模型时
   必须明示 `ai_not_configured`，不得伪造）。
4. **知识域**：模板、配对（`pairing.py::on_attempt_graded` + `_create_task` + 延迟任务重排）、图谱
   （`GET /knowledge-map`）、关系、先修、标签建议。配对同时是夹具「延迟验证链」的前置（当前 `skipped`）。
5. **学习读接口**：`GET /study-plans/today`、`GET /projects/{id}/review-tasks`、`GET/POST /memory-cards`
   （含 logs/rebuild/suspend/resume）、`GET /projects/{id}/search` + `POST /search/reindex`、`questions/{id}/exposure`、
   `questions/{id}/external-seen`、诊断/追问、转写确认/拒绝、AI 估计。
6. **验收收口**：解锁上述后用 `acceptance-server.mjs --fresh` 重跑 main 78 + @stub 8 + archive 3；Django 特有断言
   按 04 记录，不改断言；目标是把 `unmigrated_endpoint` 类清零。
7. **流**：配对/辅导队列迁移后给 `tutor.stream` 接真实生产者，替换 `service_not_migrated` 终态。
