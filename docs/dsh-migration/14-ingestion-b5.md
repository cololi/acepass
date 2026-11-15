# 14 ingestion B5：O19/O20 变式 + 图片 extraction worker + LLM 审计适配

日期：2026-11-06。范围：阶段 3 的 **ingestion 第六批（B5）**——O19（`POST …/variants/propose`）、
O20（`GET …/variants`）、`ingestion.extract_candidate` worker，以及三者共用的 LLM 审计适配。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准，实施规格见
[06-ingestion-port-spec.md](./06-ingestion-port-spec.md) §2 / §6.1–§6.3 / §8.1。本文只记录本批次做了什么、
凭什么算完成、还差什么；Django 实测证据见 [14-ingestion-b5-probe.md](./14-ingestion-b5-probe.md)，
对拍差异见 [04-parity-findings.md](./04-parity-findings.md) §M。

## 0. 一句话结论

**O19/O20 上线，ingestion 累计 20/20**；B3 已入队但无人消费的 `ingestion.extract_candidate` 现在有真实
消费者，且模型调用在 SQLite 事务之外、应用前重新 `holdClaim`。三条硬要求都成立：

1. **生产无 stub**：`is_stub/is_stub_output` 是字面量 `false`，没有任何路径能新造 `true`；可读旧归档的 `true`
   但不改写。费用未知固定 `cost_known=false/cost_cents=null`，tokens 只记真实 `usage`。
2. **一次调用一条 run，且同一条 run 修状态**：O19 在调用前插入 `failed` 行，调用后按主键更新同一行
   （`validation_result`、model、tokens、latency、status）；不生成第二条 run 来"修复"状态。
3. **AI 不写正式分/掌握状态**：O19 只写 `import_job`、`import_candidate`、`audit_llm_run`、幂等记录；
   extraction 只改候选草稿/machine record 与 job problem。R-INV 3 的行级断言在 HTTP 测试里。

`npm run verify` 在系统 Node 24.22.2 与 DSH Electron Node 24.21 双运行时 **549 条测试全绿**
（523 → 549，新增 26）+ Cordis 加载烟测通过。

## 1. 本批次完成面

| 交付 | 位置 | 说明 |
|---|---|---|
| 变式纯规则 | `src/domain/ingestion/variants.ts` | `answerConsistencyProblems`（`variants.py:165`）、`proposedScore`（`:539`）、`variantDraftPayload`（`:580`）；`blocksText`/`normalizedText` 与 Python 的 Unicode `\s\W` 语义对齐 |
| 变式服务 | `src/services/variants.ts` | `independentChecks`（`:397`）、`variantReviewIssues`（`:482`）、`proposeVariants`（`:703`）、`variantJobs`（`:694`）、`variantCandidateSummary`/`variantJobSummary`（`:645`/`:673`）、`versionTexts`/`checkedAnswer`/`answerContext` |
| 发布门禁复核 | `src/services/ingestion.ts` | `refreshCandidateIssues` 在 `job.input_kind == "ai_variant"` 时追加 `variantReviewIssues`——审核/发布时按**已存草稿**重算，编辑无关字段清不掉拒绝 |
| extraction 服务 | `src/services/ingestion_extraction.ts` | `prepareExtraction` / `performExtraction` / `applyExtraction` / `markExtractionFailed` / `extractImageCandidate`；B06 迟到 revision 只写 machine record |
| worker | `src/jobs/worker.ts` | `asyncHandlers` + `runOnceAsync`/`drainAsync`：AI topic claim → **事务外 await** → 事务内 `holdClaim` 复核 → 应用 → `markProcessed`；同步 topic 语义不变 |
| HTTP | `src/http/ingestion_routes.ts` | O19 `runVariantResource`（claim 先提交、逐 run/候选短事务、失败 release 再抛 503）与 O20 列表；O08 的 `useVision` 改为端口 `availability().extract_question` |
| 审计适配 | `src/services/ai_runs.ts`、`src/llm/finish.ts` | `beginAuditedRun`/`finishAuditedRun`/`telemetryOf`；`runCapability` 的 `provider/model` 改从 `result.route` 写入；`finishFailure` 把 aborted/error 统一判为失败（纯函数，可脱离 SDK 测试） |
| 无能力错误 | `src/services/errors.ts` | `AiNotConfigured`（503 `ai_not_configured`） |
| 测试夹具 | `tests/support/b5_fixtures.ts` | 大纲/考点播种（变式与 extraction 两条测试共用） |
| 黄金向量 | `tests/golden/ingestion_b5_variants.json`（`scripts/gen_ingestion_b5_variants_golden.py`） | 30 条：10 answer consistency / 6 proposed score / 3 draft / 8 independent checks / 2 review / 1 job summary；**真实 PostgreSQL 行 + 真实函数**；sha256 `da98000d…037b6`，重跑逐字节一致 |
| 测试 | `tests/ingestion_b5_variants_golden.test.ts`(7)、`ingestion_b5_variants_http.test.ts`(9)、`ingestion_b5_extraction.test.ts`(7)、`llm_finish.test.ts`(3) | 26 条 |
| 探针 | `scripts/probe_ingestion_b5.py` → `14-ingestion-b5-probe.{md,json}` | 26 例真实 Django（O19 16 / O20 3 / extraction 7），sha256 `469e20ba…f7f55`，重跑一致 |

**schema 无变更、无新依赖、无迁移**：本批次只写已有列。`audit_llm_run` 的 24 列在阶段 5 已生成；
`ingestion_import_job`/`import_candidate` 的列在 B0–B2 已在 schema 里。

## 2. 变式规则：为什么先做纯层

`variants.py` 的规则分两层，移植也分两层：

1. **纯规则**（`domain/ingestion/variants.ts`）：答案与本题是否自洽、候选提议的分值、草稿字段。它们不碰数据库，
   因此 30 条黄金向量可以逐分支覆盖，包括 Python 的几个"不直观"行为：
   - `answer.blank_answer_missing` 遍历的是 `set` 差集（多缺失空位时顺序不确定，见 04 §M M5）；
   - `_proposed_score` 的大题分支先按 rubric 合计，合计为 0 才回落到声明总分；填空题先按各空 `max_score`，
     没有才用题干 `blanks[].max_score`；
   - `_draft_payload` 的 `rubric_criteria`/`difficulty_note`/`doubts` 是 `or` 语义（空值回落，真值原样保留，
     包括非字符串/非数组的畸形真值），`answer_status_known` 恒 false；
   - `display_label` 是 `"AI变式·" + (源 label 或 id 前 8 位)`，按**码点**截 200。
2. **依赖真实行的检查**（`services/variants.ts`）：`independentChecks` 查已发布 digest、同家族 digest、最近 200 个
   同 project/subject 非 ignored 候选、考点所属大纲、以及 `official_past` 规则探针。黄金向量用真实行冻结了 8 组：
   干净变式、题干照抄源题、已发布重复、家族重复、pending 重复、跨科目考点、大纲未发布（warning）、答案指向不存在选项。

`official_past` 自检不是复制规则：`exams.ts` 把 `PaperItem.clean()` 的三条规则抽成 `paperItemRuleErrors`，
`addPaperItem` 与 `officialPastRuleProblems` 共用它。探针构造 "AI 题 × official_past 卷" 的内存入参；如果规则被
删除，变式流水线会直接产出 `official_past_rule_missing` 并阻塞，而不是悄悄生成可能进入真题统计的内容。

`variantReviewIssues` 被 `refreshCandidateIssues` 调用（O15 编辑、O16 ignore、O18 发布、O19 候选创建都会经过），
所以拒绝是**持久**的：改题干之外的无辜字段不会让重复/无答案的变式变成可发布。

## 3. O19：异步资源包装与幂等

O19 不能套现有的同步 `ingestionResource`（它把 claim 与副作用放在同一个同步事务里）。`runVariantResource`
的顺序是：

1. **body 校验**（Ninja/Pydantic 形状）→ 项目 → "至少一个 source" → `count>=1` → source version（404）→
   node（404）。这一步与 Django 视图顺序一致；错误信封用既有 `schemaError`（400，不是 422，见 04 §M M12）。
2. **claim 在独立事务提交**（`variants.propose:{project_id}`，指纹是五个字段的默认值展开形态）。
   重放直接返回记录的 201；同 key 异 body → 409，`details={route_scope,reason}`。
3. `proposeVariants` 内部按 Django 的 autocommit 语义分步提交：job + info problem（一个事务）→ 上限 note
   （一个事务）→ 每个候选：**先插 failed run（独立事务）→ await 模型（事务外）→ 同一条 run 更新 +
   候选创建（各一个短事务）**。第 2 次调用失败时，第 1 个候选与两条 run 都已提交，job 置 `failed`，然后抛
   `VariantProviderFailure`。
4. **成功才 recordResult**（201）。失败时 `release` 未完成的 claim，再按 code 映射：
   `ai_not_configured`/`ai_capability_unsupported` → 503 `AiNotConfigured`（API 文案保持 Python 原文）；
   其余 → 503 `DependencyUnavailable`（`生成变式失败：{exc}`），`details.error_code` 保留端口 code。
   已提交的 run/job/候选**不删除**（"失败留候选"，06 §6.2）。

不把模型调用放进 SQLite 事务有两个理由：`transaction()` 是同步的，返回 Promise 会在工作完成前 COMMIT；
以及长事务会持写锁阻塞所有其它请求。幂等的诚实边界：崩溃在 claim 之后、recordResult 之前会留下 in-flight
记录（Django 同样），不假装 exactly-once 计费；重复的失败请求会再建 job，这不是"假装模型只调用一次"。

## 4. LLM 审计适配

- **O19 的 run 生命周期**：`beginAuditedRun` 插入 `failed` 行（`request_summary` 含 source version/题型/科目/
  node/requested_count/difficulty_note[:200]，`input_snapshot` 含源 `content_digest`、`avoid_stem_count=1`、
  `engine=prompt_version`），`finishAuditedRun` 按主键更新。调用成功且无 blocking → `succeeded`；
  有 blocking → `rejected`，但 `error_code/error_message` 留空（Django 的变式路径把原因放在
  `validation_result`，不放在错误列；见 04 §M M11）。调用失败 → `timeout`/`unavailable`/`failed`，
  `error_code` 是端口 code，`error_message` 是端口原文截 500。
- **模型标识**：`result.route.model` 写入 `model_identifier`；`provider` 是 DSH route 的 provider
  （无 route 的失败行是 `dsh-llm`）。不是 Django 的 provider 实现名（04 §M M3）。
- **extraction 的 run**：仍是"调用后插一行"（Django `_record_run` 的时序）。`input_snapshot.document_id`
  取 `job.documents.first()`（through 行 id 升序），不一定是本次 document（04 §M M7）。
  `raw_response_excerpt` 按能力截断：extract/transcribe 4000、variant 2000。
- **无 stub / 无假费用**：`newLlmRun` 的 `is_stub` 是字面量 `false`；`withCallTelemetry` 只在
  `costKnown===true` 时保存 `cost_cents`，而 DSH 端口从不声明价格，所以恒 `cost_known=false`、`cost_cents=null`。
  tokens 只取端口真实 `usage`（缺失即 null）。
- **finish 语义**：端口把 `finish.kind === 'aborted'`、`signal.aborted`、`finish.kind === 'error'` 都映射为失败
  （不是成功）；`ai_empty` 也是失败。O19 只把 `result.ok === true` 当成功。
- **端口能力**：无 llm/route → `ai_not_configured`；模型未声明 `image` modality → `ai_capability_unsupported`
  （不猜 vision）。O19 的 API 兼容层把两者都映射成 `AiNotConfigured`，`details.error_code` 区分实际原因。

## 5. extraction worker

`extractImageCandidate` 被拆成三段，因为事务边界不同：

1. `prepareExtraction`（读）：candidate 必须属于 `import_job_id`；document 必须属于 job 的 **project**
   （Django 不校验 `job.documents` 成员，06 §6.3 明确记录）；缺 → `candidate_missing`/`document_missing`，零写入。
   捕获 `capturedRevision`。
2. `performExtraction`（读图 + 模型调用，**事务外**）：读 `asset.object_key` 的字节；`asset` 行缺失 →
   `missing_source_image` 的 failed run + job warning；`storage.open` 缺磁盘对象抛 `StorageError`，**不**降级
   （Django 的 `except FileNotFoundError` 也不捕获它，04 §M M8）。调用后立即持久化 **一条** run：
   - `ai_not_configured`/`ai_capability_unsupported` → `unavailable`；
   - `ai_timeout`/其它 → `timeout`/`failed`；
   - 非 JSON → `rejected/ai_invalid_output`（`raw_excerpt` 仍记录）；
   - 校验有问题 → `rejected/ai_invalid_output` + `validation_result={problems,accepted:false}`；
   - 成功 → `succeeded` + `validation_result={problems:[],accepted:true}`。
3. `applyExtraction` / `markExtractionFailed`（短事务，业务写）：application 条件比较 revision；
   - 不同 → 只写 machine record 的 `stale_revision/extraction_started_revision/applied_revision/
     pending_clean_payload`，草稿/revision 不动，job 加 `vision_extracted_stale`；
   - 相同 → 写 `question_type/display_label/content/answer_payload/answer_status_known/doubts/
     needs_manual_structure=true`，machine record、`extractor_version=vision-v1`、`is_stub_output=false`、
     `revision+1`，`refreshCandidateIssues`，job 加 `vision_extracted`（stub 时 `vision_extracted_stub`，本包不会发生），
     job 原 `processing` 才 `maybeCompleteJob`；
   - 失败路径只加 `vision_extraction_failed` warning、必要时把 `needs_manual_structure` 翻回 true、job 原
     `processing` 才 `maybeCompleteJob`。

worker 的异步语义：`runOnceAsync`/`drainAsync` 对 AI topic **claim 后 await**，业务写入前在同一个事务里
`holdClaim` 复核；租约丢失则不写业务状态、`markProcessed` 拿不到 token 即计为 skipped，审计行保留（模型确实
被调用过）。模型调用抛异常 → `failClaim`（可重试），不会把事件确认成功；`ai_not_configured` 是人工退化，
事件确认成功、不无限重试。

## 6. 验证

```bash
cd dsh-plugin
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
npm run verify     # typecheck → build → 549 测试（系统 Node + DSH Electron Node 双跑）→ Cordis 加载烟测
```

- **测试数 549**（523 → 549，新增 26：golden 7、O19/O20 HTTP 9、extraction 7、finish 语义 3），双运行时全绿。
- **黄金向量**：`tests/golden/ingestion_b5_variants.json`，30 条
  （10 answer consistency / 6 proposed score / 3 draft / 8 checks / 2 review / 1 summary），
  sha256 `da98000d…037b6`；`scripts/gen_ingestion_b5_variants_golden.py` 重跑逐字节一致。
  覆盖：六种题型的答案自洽（含 material 拒绝、CR rubric 合计缺失/非法/不等、填空空值/缺答案）、
  分值推导、草稿全字段、已发布/家族/pending 三类重复、跨科目考点、大纲未发布 warning、源题干照抄、
  复核 issue 重算、job 摘要（两个候选、状态计数、created_at 文本）。
- **HTTP 黑盒 9 条**：无 provider（1 条 unavailable run、0 job）、成功（候选/审计/幂等重放）、上限（5→3）、
  校验拒绝（保持候选与 `variant_rejected`/`no_variant_usable`）、第 2 次失败（保留第 1 候选与两条 run、
  可重试）、前置 400/404、body 形状（400 + `loc`/`int_from_float`）、幂等冲突 409、草稿/材料拒绝、
  O20 列表与 limit、R-INV 3 行增量断言。
- **extraction 7 条**：成功（revision 2、machine record、单 run、outbox processed）、校验拒绝（草稿不动）、
  非法 JSON、排队后能力失效（unavailable + 确认事件）、迟到 revision（人工版本胜出、machine stale）、
  传输异常（`failClaim`、no run、草稿不动）、candidate/document missing（零写入）。
- **finish 语义 3 条**：`aborted` → `ai_cancelled` / 超时 → `ai_timeout`；`error` 按 dsh-llm code 映射
  （不按 message 猜）；正常完成不产生失败。
- **Django 探针 26 例**：O19 16 / O20 3 / extraction 7，报告见
  [14-ingestion-b5-probe.md](./14-ingestion-b5-probe.md)。
- **`npm run golden` 已接入** `golden:ingestion-b5`（17 个生成器链的最后一个）。

## 7. 已知边界与有意的差异（详见 04 §M）

| 编号 | 差异 | 处理 |
|---|---|---|
| DIV-B5-1 | **Django 的真实 provider 路径无法产出合格变式**：`OpenAICompatibleProvider.call` 返回 `payload={"text": …}`，而 `propose_variants` 直接校验 `call.payload` → 每次候选 `not_object`。Node 改为解析 `result.text`。 | 有意偏离；不把坏路径当 oracle。Django 修复另立项（`suggest_tags` 有同一 bug）。 |
| DIV-B5-2 | extraction 失败分支若人工在调用期间改过草稿，Django 用旧对象 `save(update_fields=["draft_payload"])` 可能覆盖人工版本。Node 重读当前行、只翻 `needs_manual_structure`。 | 更安全的方向；该分支在图片候选上通常不可达。 |
| DIV-B5-3 | Python `max_output_tokens=2000` 会进 `max_tokens`；Node 的 `CapabilityRequest`/`stream` 没有已证实的对应参数。 | **未达 parity**，不伪称已限制；已在 06 §6.2 与 04 §M M9 记录。 |
| M2/M3 | 审计行的 `provider`/`error_message`、响应里的 `provider` 与 Django 实现名不同。 | 字段诚实（`dsh-llm`/DSH route + 端口原因）；API 文案保持 Python 原文。 |
| M5 | 多缺失空位的 `answer.blank_answer_missing` 顺序在 Django 里是 set 哈希序。 | Node 用题干顺序（确定性）；黄金向量只放单个缺失。 |
| M8 | 缺磁盘对象（`StorageError`）不降级，worker 重试；只有缺资产行才是 `missing_source_image`。 | 与 Django 的异常捕获面一致，不声称已覆盖。 |

**未做 / 不声称完成**：
- 在运行中的 DSH GUI 里加载 O19/O20（四条 ingestion 路径含参数，仍只能声称进程内 `Request`→`Response` 可达；
  真实浏览器/Remote 通道属阶段 6）；
- 真实模型调用（本批次所有 provider 都是 tests-only fake / Django scripted double）；
- `max_output_tokens` 的真实宿主限制（见 DIV-B5-3）；
- `src/services/transcription.ts`（作答照片转写，06 §6.4 明确不属于 20 个 ingestion 操作）；
- analytics 的 9 个操作（报告/校准/重判查询，下一批）。

## 8. 回滚面

本批次没有 schema 变更、没有迁移、没有新依赖。回滚 = 删除 `src/domain/ingestion/variants.ts`、
`src/services/variants.ts`、`src/services/ingestion_extraction.ts`，撤回 `src/jobs/worker.ts` 的 async 分支、
`src/http/ingestion_routes.ts` 的 O19/O20 路由与 O08 的 `useVision` 改动、`src/services/ingestion.ts` 的
`ai_variant` 分支，以及三条 B5 测试与两个脚本；`package.json` 去掉 `golden:ingestion-b5` 条目。
`dsh-plugin/` 与 `docs/dsh-migration/` 仍未跟踪，未做任何 git 操作。
