# 10 ingestion B1：core/serializers 与 O03/O04/O07/O10–O17

日期：2026-11-06。范围：阶段 3 的 **ingestion 第二批（B1）**。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准，实施规格见
[06-ingestion-port-spec.md](./06-ingestion-port-spec.md)。本文只记录本批次做了什么、凭什么算完成、还差什么；
Django 实测证据见 [09-ingestion-b1-probe.md](./09-ingestion-b1-probe.md)，对拍差异见
[04-parity-findings.md](./04-parity-findings.md) §I。

## 0. 一句话结论

ingestion 的**文本导入闭环**已移植：来源文档查询/创建（O03/O04）、文本导入（O07）、任务查询与重试
（O10–O12）、候选列表/详情/编辑/忽略/版式确认（O13–O17），共 **11 个操作**挂到进程内路由；
ingestion 累计 **12/20**。候选校对门禁（`refresh_candidate_issues`）用**真实 Django 行**生成的
30 组黄金向量逐字段对拍，布局策略 41 组；`npm run verify` 双运行时 **389 条测试全绿 + Cordis 加载烟测通过**
（328 → 389）。

## 1. 本批次完成面

| 交付 | 位置 | 说明 |
|---|---|---|
| ingestion core | `src/services/ingestion.ts` | `createTextDocument`、`createImportJob`、`createSourceRegion`、`createCandidate`、`refreshCandidateIssues`、`updateCandidate`、`ignoreCandidate`、`confirmLayoutReview`、`maybeCompleteJob`、`addJobProblem`、`jobSummary`、`candidateSummary` |
| 导入入口 | `src/services/ingestion_imports.ts` | `startTextImport`（文档 + job + 每段 region/candidate 同一事务）、`retryJob`（复用来源与候选，不重跑 parser） |
| 曝光写入 | `src/services/ingestion_access.ts` | `recordCandidateEditorialPreview`：候选已链接已发布题目时写 `editorial_preview`，同 user+question+kind+`detail.candidate_id` 复用一行 |
| 布局策略 | `src/domain/ingestion/layout.ts` | `layout.py` 整模块：reason→issue 映射、blocking 顺序、pages/page_indexes/reasons 去重 |
| HTTP | `src/http/ingestion_routes.ts` | O03/O04/O06/O07/O10–O17；Ninja 形状的 body/query 校验；ingestion 专用幂等包装（trim/长度/409 details/失败释放 claim） |
| 黄金向量 | `tests/golden/ingestion_review.json`（生成器 `scripts/gen_ingestion_review_golden.py`） | 30 组：27 组 issue/状态迁移 + 3 组 serializer；由真实 PostgreSQL 行与真实 Django 函数生成 |
| 布局向量 | `tests/golden/ingestion_layout.json`（生成器 `scripts/gen_ingestion_layout_golden.py`） | 41 组 case / 106 条向量 + 常量块 |
| 测试 | `tests/ingestion_b1_http.test.ts`、`tests/ingestion_review_golden.test.ts`、`tests/ingestion_layout.test.ts` | 21 条 HTTP 黑盒 + 30 条黄金回放 + 10 条布局 |
| Django 探针 | `scripts/probe_ingestion_b1.py` → `docs/dsh-migration/09-ingestion-b1-probe.{md,json}` | 114 例（111 operational + 3 setup），覆盖 200/201/400/404/409/422 与行级副作用 |

**B0 修正**：探针发现 Ninja 的 body 错误 `loc` 是 `["body","payload",<field>]`（不是 B0 写的
`["body",<field>]`），无 body 时是 `["body","payload"]`，数组/标量 body 会被当成空对象。B0 的 O06 已按实测
改正，`tests/ingestion_http.test.ts` 同步更新；这不是行为变更，而是修正 B0 的传输层缺陷（见 04 §I1）。

## 2. 为什么这算“移植”而不是“重写”

两层对照，期望值都不在测试里重算：

1. **候选门禁 / 序列化**：`gen_ingestion_review_golden.py` 先 `django.setup()`，在一次性 PostgreSQL 测试库
   里造**真实行**（project/subject/document/job/candidate/region/through/question/version/paper/revision/item），
   再直接调用 `refresh_candidate_issues`、`job_summary`、`candidate_summary`，把行与返回原样写进 fixture。
   Node 侧只把同一批行装进 SQLite、调用同名移植函数并 `deepEqual`。issue 顺序错一位、漏一条 duplicate 检查、
   时间戳形状不对都会在 30 组里显形。
2. **HTTP 契约**：`probe_ingestion_b1.py` 用真实 `django.test.Client` 打真实 Ninja 路由，记录状态码、完整错误信封、
   响应字段顺序与行级 delta。Node 的 21 条黑盒断言据此写成；`loc`、`bool_parsing`、`int_from_float` 与
   `int_parsing` 的区分、`parse:"false"` 的强制转换、重放返回原 201 等都不是猜的。

覆盖的**易错语义**（不是 happy path）：

| 语义 | 为什么必须钉住 |
|---|---|
| issue 的**替换**与顺序 | `review_issues` 每次重算并替换，不是追加 parser 的 `parse_issues`；顺序决定校对页第一条 blocking |
| published/ignored 不回退 | 重算 issue 不能把已发布/已忽略候选改回 draft；否则一次打开详情就改变已决定状态 |
| 空 patch 也 revision+1 | O15 的语义是“保存一次修订”，不是“有变化才保存”；CandidateRevision 存**刷新前**的 issues |
| 答案页匹配只产生提案 | `answer_match.matched` 且未人工确认 → blocking；确认后才放行 |
| 卷面同号 | 同 paper+position 已有 published version → blocking，重导不能重复发布 |
| 材料父子 | 无子题 / 有未发布子题都 blocking；子题 `candidate_ids` 按 created_at |
| 布局门禁 | 多栏/表格公式/扫描页来自 `job.page_diagnostics`，只有显式 layout-confirm 才清除；`geometry_unavailable`/`too_many_fragments` 永不阻断 |
| 曝光是读接口的副作用 | O14 打开详情、O15 编辑前都写 `editorial_preview`；O15 的 revision 冲突**仍保留**已写 exposure |
| 幂等键 | trim 后空 → 409（不是 400）；>200 码点 → 409；失败请求释放 claim，同 key 换 body 可重试；重放返回原 201 |
| job 完成判定 | 全部候选 published/ignored 才 completed；**零候选不是 completed**，是 awaiting_review；空文本只在 `parse=false` 时出现 |
| 21 段回滚 | 第 21 个 region 的 `y+.05>1.0001` 触发 `ValidationError` → 422 `structure_invalid`，document/job/region/candidate 全回滚、claim 释放 |
| 重试不重跑 | O12 只改 attempts/status/last_error/started_at 并追加 problem；`finished_at` 保留、不重建候选、不写 ContentRevision |

## 3. 幂等与事务边界

- `ingestionResource` 把 **claim + 副作用 + recordResult** 放进同一个 `BEGIN IMMEDIATE` 事务：失败即回滚，
  claim 随副作用一起消失（等价于 Django 中间件在 4xx/5xx 上的 `release()`，但不需要显式释放）。
- O07 的指纹是 `TextIn.model_dump(mode="json")` 展开默认值后的对象（`text/subject_id/title/source_note/usage_scope/parse`），
  所以 `parse:"false"` 与 `parse:false` 是同一请求；`subject_id` 的空串与 null 不同。
- O12 的指纹固定 `{}`；O16 的指纹是 **query** 参数 `{reason}`（不读 body）；O17 是完整 `LayoutIn`。
- O15 没有幂等键：revision 由 `expected_revision` 做 CAS；空 patch 也会 revision+1。
- O14/O15 的 exposure 写入在 update 事务**之外**（O15 先 preview 再 update），保留 Django 的“失败也留痕”顺序。

## 4. 传输边界（与 B0 相同）

所有 ingestion 路径都含 `:project_id`/`:candidate_id` 等参数段，DSH 的 `connection.fetch` 注册表按**精确
pathname** 索引，无法挂载（`src/index.ts` 仍只注册静态路径）。本批次**只声称进程内 Request→Response 可达**，
不声称 GUI/宿主可达；参数化 REST 统一由阶段 6 的 Remote 通道承接（03 §F8）。`EventSource`/前端调用在宿主切换前
不会工作，这是已知且已记录的边界。

## 5. 验证

```bash
cd dsh-plugin
npm run golden:ingestion-layout   # 41 组布局向量（真实 Python 模块）
npm run golden:ingestion-review   # 30 组候选门禁/序列化向量（真实 PostgreSQL 行 + 真实服务）
npm run verify                    # typecheck → build → 389 测试（系统 Node）→ 389（DSH Electron Node）→ 加载烟测
```

结果：系统 Node 24.18 与 DSH 运行时（Electron 44.7 / Node 24.21）均 `389 pass / 0 fail`，`load-smoke OK`。
两个生成器重跑均与已提交 fixture 逐字节一致（`ingestion_review.json` sha256
`167dfa87…e994`，`ingestion_layout.json` sha256 `c66c0107…642e`）。

schema **本批次无变更**（B0 已补两张 through 表：59 表 / 334 索引 / 33 唯一 / 6 检查）。

## 6. 未完成 / 下一批前置

- **B2**：O18 发布写集（Question/Version/AnswerKey/Rubric/Mapping/SourceLink/PaperItem、材料先子后父、
  重复卷面号、PaperItem outbox）。B1 的候选门禁已把“能不能发布”算出来，但还没有“发布”本身。
- **B3**：O01/O02/O05/O08（私有存储、multipart、sharp、下载门禁/曝光）。
- **B4**：O09（pdfjs 适配、逐页版式黄金对照）。
- **B5**：O19/O20（AI 变式、异步 extraction worker）与相邻转写。
- 明确未做：`ai_variant` 的独立变式校验分支（B1 不可达，已在 04 §I4 登记）；Django 错误信封的
  `request_id` 差异（全局传输层，04 §I2）；`content` 为非对象时的病态 500 差异（04 §I5）。

## 7. 回滚面

业务代码是**纯增量**：删除 `src/services/ingestion.ts`、`src/services/ingestion_imports.ts`、
`src/services/ingestion_access.ts`、`src/domain/ingestion/layout.ts`、三个新测试与两个 fixture/生成器，
把 `src/http/ingestion_routes.ts` 还原到 B0 的单条 O06 路由（并恢复 B0 的 `loc` 形状），移除
`package.json` 的 `golden:ingestion-layout`/`golden:ingestion-review` 与 `golden` 聚合里的两项即可。
schema 无变更，无需回滚数据库。**注意**：回滚会把 O06 的 `loc` 缺陷带回来，只应在确认 B1 不继续时做。
