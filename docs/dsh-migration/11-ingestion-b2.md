# 11 ingestion B2：O18 发布写集 + questions/exams 发布缺口 + paper stats 消费

日期：2026-11-06。范围：阶段 3 的 **ingestion 第三批（B2）**。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准，实施规格见
[06-ingestion-port-spec.md](./06-ingestion-port-spec.md) §4.3/§4.4。本文只记录本批次做了什么、凭什么算完成、
还差什么；Django 实测证据见 [11-ingestion-b2-probe.md](./11-ingestion-b2-probe.md)，对拍差异见
[04-parity-findings.md](./04-parity-findings.md) §J。

## 0. 一句话结论

**O18 发布上线**：一个已校对候选在**一个事务**里变成不可变的 question/version/answer/rubric/mapping/
source-link/PaperItem 写集，材料题“先子后父”、同卷同号拒绝、AI 来源强制、失败零半发布全部有实测与向量。
ingestion 累计 **13/20**（B1 12 + O18）。同时补齐 `publishProblems` 的 4 个缺口（rubric `full_clean`、
填空各空合计、材料子题跨科目、答案版本不匹配），修掉两个跨批次的真实缺陷（DecimalField 未按
`decimal_places` 量化、`normalize_content` 把空数组当真值），并把 `projection.refresh_paper_stats`
接进 worker。`npm run verify` 双运行时 **450 条测试全绿 + Cordis 加载烟测通过**（389 → 450，新增 61）。

## 1. 本批次完成面

| 交付 | 位置 | 说明 |
|---|---|---|
| 发布服务 | `src/services/ingestion_publish.ts` | `publishCandidate`、`ensureMaterialVersion`、`publishedChildVersionIds`、`reconcileMaterialChildren`、`writePaperItem`、`paperPositionKey` |
| 题目写集 | `src/services/questions.ts` | 新增 `createQuestion`、`createQuestionVersionDraft`、`createAnswerKeyVersion`、`upsertRubricVersion`；`publishProblems` 补齐 4 项；`estimated_seconds` 缺省改为 `null` |
| 纯规则 | `src/domain/rubric.ts`、`src/domain/answers.ts` | `rubricProblems`（`RubricVersion.clean` 整段，含依赖覆盖语义）；`sumBlankScores` |
| 试卷写集 | `src/services/exams.ts` | `addPaperItem`（重复题号、科目、父题项、AI 题挂真实卷、负分；审计 + outbox 同事务） |
| 统计消费 | `src/services/paper_stats.ts`、`src/jobs/worker.ts` | `markProjectStaleForPaper`（裸 `UPDATE`，不动 `updated_at`）+ `projection.refresh_paper_stats` handler |
| HTTP | `src/http/ingestion_routes.ts` | O18 路由；`CandidatePublishIn` 校验；`CandidateOut` 响应投影（存储体含 `question_id`、响应不含）；ingestion 幂等记录补 `resource_type/resource_id` |
| 存储层 | `scripts/gen_schema.py`、`src/store/schema.generated.ts`、`src/store/repository.ts` | `DecimalField` 按 `decimal_places` 量化（J1） |
| 黄金向量 | `tests/golden/ingestion_publish.json`（`scripts/gen_ingestion_publish_golden.py`） | 24 组发布（13 成功写集 + 11 拒绝）+ 13 组 `publish_problems`；真实 PostgreSQL 行 + 真实服务；重跑逐字节一致（sha256 `71dbfa01…ff06`） |
| 测试 | `tests/ingestion_publish_golden.test.ts`、`tests/ingestion_b2_http.test.ts`、`tests/publish_closed_loop.test.ts` | 38 条黄金回放 + 19 条 HTTP 黑盒 + 4 条闭环 |
| Django 探针 | `scripts/probe_ingestion_b2.py` → `docs/dsh-migration/11-ingestion-b2-probe.{md,json}` | 40 例真实 HTTP：200/400/404/409/422、行级 delta、写集、幂等存储体 |

**schema 无表结构变更**：`decimalPlaces` 是生成器的**元数据**，不改变任何 DDL；表/索引/唯一/检查数量不变。

## 2. 为什么这算“移植”而不是“重写”

1. **写集对照**：`gen_ingestion_publish_golden.py` 在一次性 PostgreSQL 测试库里用真实
   `publish_candidate` 发布候选，再把**发布后的语义快照**冻结成 JSON：候选指针、question、version（含
   `content_digest`）、answer、rubric、source links、mapping、paper items、审计动作序列、outbox。Node 侧在
   SQLite 里重放同一批起始行与同一串步骤，逐字段 `deepEqual`。新行按角色命名（`Q_TARGET`/`V_TARGET`/
   `A_TARGET`/…），所以“少写一行/多写一行/顺序错”都会失败。
2. **发布前校验对照**：13 组 `publish_problems` 向量覆盖答案缺失/未核对/依据为空/答案非法、rubric 缺失/
   总分不一致/rubric 自身非法、填空合计、材料无子题/清单不一致/跨科目、两个通过用例。
3. **HTTP 契约对照**：40 例探针钉住状态码、错误信封、检查顺序、幂等语义、响应投影与行级副作用；Node 的
   19 条黑盒断言按实测值写，不按规格猜测。
4. **闭环**：发布 → 会话冻结 → 提交判分 → 证据重建 → 报表失效，用真实服务跑通；判分模块本身不改。

覆盖的**易错语义**（不是 happy path）：

| 语义 | 为什么必须钉住 |
|---|---|
| 存储体 ≠ 响应体 | `question_id` 只在幂等表里；重放也要投影掉，否则客户端会看到第一次没有的键 |
| 检查顺序 | body → 项目 → 候选 → 规范 → 幂等键；“规范不存在 + 没键”是 404 不是 409 |
| 失败零半发布 | P22（候选科目≠试卷科目）在写完 question/version/answer 之后才 404，整笔回滚 delta 全 0 |
| 材料先子后父 | 第一个子题发布时**预建**父草稿并回写候选指针；父发布后 children 按 `created_at`、父 item 回连子 item |
| 三考点等分 | `Decimal("1")/3 × 3 = 0.9999999999999999999999999999` → 400；不“修正最后一个权重” |
| rubric 双出口 | upsert 的 `full_clean` → 422 `结构校验失败`+`errors`（消息数组）；publish 的 `rubric_invalid` → Python 字典 repr |
| 重复卷面号 | 候选门禁就 blocking（`duplicate_paper_position`），不是等 addPaperItem 的唯一约束报错 |
| 同卷同号 item | `addPaperItem` 的 `position_key` 去重 + `publication_paper_item_id` 幂等双保险 |
| 候选 revision | 发布不 bump revision、不改 `reviewed_at`；重复发布只多一条幂等记录 |
| 分值来源 | 显式分值 → 规范默认 → 仍无则 422 `practice_max_score_missing`；材料题永不计分 |
| Decimal 量化 | 权重存 `1.0000`/`0.5000`、分值存 `2.00`、`confirmed_score` 存 `0.00`（J1） |
| 空数组真值 | `normalize_content` 对 `options: []` 省略该键（Python 真值），否则 digest 不同（J2） |

## 3. 事务与幂等边界

- `publishCandidate` 自身是一个 `BEGIN IMMEDIATE` 事务；HTTP 的 `ingestionResource` 把 **claim + 发布 +
  recordResult** 再包一层（嵌套事务合并），所以失败时幂等 claim 与业务写一起回滚，同键可重试。
- O18 的幂等指纹是 `CandidatePublishIn.model_dump(mode="json")` 的**展开默认值**对象：
  `{exam_spec_version_id, node_ids: [], origin_type: "user_authored", display_label: ""}`。因此“省略默认值”
  与“显式写默认值”是同一请求（测试有专项）。
- 存储体 = `candidate_summary + question_id`；响应 = `CandidateOut` 投影。重放同样投影。
- 发布成功后 `refreshCandidateIssues` 重算 issue（published 只更新 issues，不回退状态）、`maybeCompleteJob`
  推进 job；两者都在同一事务里。
- `addPaperItem` 的 outbox 入队与 item 写入同事务；worker 消费 `projection.refresh_paper_stats` 时只置
  `is_stale=1`，不重算报表。

## 4. 存储层变更（影响面最大的一个）

Django 在保存 `DecimalField` 时按 `decimal_places` 量化，Node 之前按 `Decimal.toString()` 原样写。B2 的黄金
向量在 `score_weight` 上第一次暴露了它（`0.5` vs `0.5000`）。修法：

1. `gen_schema.py` 为每个 decimal 列输出 `decimalPlaces`；
2. `repository.ts` 在编码前 `quantize(-decimalPlaces)`（`Decimal.quantize` 已与 Python 对拍过）。

副作用与处理：

- 4 处既有测试期望按**库值**更新：`subject.pass_score` `"90"→"90.00"`、两处 `confirmed_score` `"0"→"0.00"`、
  `mapping.score_weight` `"1"→"1.0000"`。这些都是 Django 的真实存储形态，不是行为改变。
- Django 对“刚创建、未重新查询”的对象返回内存值（`"1"`），对重新查询返回库值（`"1.0000"`）；Node 统一返回
  库值。已登记为 J1，属于“同一事实的两种表示”，不再逐路径模拟内存态。
- 表结构未变，无需数据迁移；但**旧 Node 库**里已经写下的非量化值（如 `"1"`）不会自动改写。迁移期若要用
  旧库，需跑一次 `UPDATE … SET col = printf('%.4f', col)` 之类的归一化（本批次没有旧 Node 生产库）。

## 5. 验证

```bash
cd dsh-plugin
npm run golden:ingestion-publish   # 24 组发布 + 13 组发布前校验（真实 PostgreSQL 行 + 真实服务）
npm run verify                     # typecheck → build → 450 测试（系统 Node 24.22）→ 450（DSH Electron Node）→ 加载烟测
```

结果：系统 Node **24.22.2** 与 DSH 运行时（Electron 44.7 / Node 24.21）均 `450 pass / 0 fail`，
`load-smoke OK: plugin loaded into real Cordis + dsh-tools; tool registered and executed`。
黄金生成器重跑与已提交 fixture 逐字节一致（sha256 `71dbfa01…ff06`）。
探针 `probe_ingestion_b2.py` 的原始观测在 `11-ingestion-b2-probe.json`（40 例）。

## 6. 未完成 / 下一批前置

- **B3**：O01/O02/O05/O08（私有存储、multipart、sharp、下载门禁/曝光）。
- **B4**：O09（pdfjs 适配、逐页版式黄金对照）。
- **B5**：O19/O20（AI 变式、异步 extraction worker）与相邻转写。O18 的 `ai_variant` 强制来源分支已写但
  不可达（候选门禁需要 B5 的变式校验，见 J6）。
- **analytics 9 个操作**未开始；本批次只做 paper stats 的**失效标记**，不做报表重算。
- 明确未做：`answer_version_mismatch` 分支（关系上不可达，按 Python 保留防御）；`createPaperRevision`
  （试卷版本由 B3/B4 的导入创建；本批次的测试直接建行，未移植无路由可测的写函数）；O18 之外的发布路径
  （如从题库直接发布）没有新增 HTTP 操作，只补了服务函数。
- 传输边界同 B0/B1：动态路径仍只在进程内可达，阶段 6 的 Remote 通道承接。

## 7. 回滚面

业务代码是**纯增量**：删除 `src/services/ingestion_publish.ts`、`src/services/paper_stats.ts`、
`src/domain/rubric.ts`、三个新测试与 fixture/生成器/探针；把 `src/http/ingestion_routes.ts` 还原到 B1 的
17 条路由（移除 O18、`candidatePublishBody`、`candidateOut`、`project` 投影与资源元数据）；移除
`package.json` 的 `golden:ingestion-publish` 与聚合项；`worker.ts` 去掉 paper stats handler。

**存储层量化**（J1）是跨批次的正确性修复，回滚它会让 `score_weight`/`confirmed_score` 再次以未量化形态
落库；若必须回滚，需同时回退 `gen_schema.py`、`schema.generated.ts`、`repository.ts` 与 4 处测试期望。
schema 无表结构变更，无需回滚数据库。
