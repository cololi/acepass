# 07 题库面收口：23 个操作与家族合并

日期：2026-11-06。范围：阶段 3 的**题库域收口**。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准，本文只记录本批次做了什么、凭什么算完成、还差什么。

## 0. 一句话结论

`backend/apps/question_bank/api.py` 的 **23 个操作全部有 Node 实现并挂到路由**，其中家族合并（`merge-impact` / `merge`）
按 C03 的"合并后证据失效"语义完整移植。`npm run verify` 在系统 Node 与 DSH 自带 Node 双跑：**314 条测试全绿 + 真实 Cordis 加载烟测通过**。

## 1. 完成面：23/23

| # | 操作 | 实现 | 备注 |
|---|---|---|---|
| 1 | `GET /projects/{id}/questions` | `services/questions.ts::listQuestions` | 元数据；类型/状态过滤作用在**版本**上；`limit` 夹在 1..100 |
| 2 | `GET /projects/{id}/questions/{qid}` | `getQuestionPreview` | 写 `stem_delivered` 曝光；封存拒绝 |
| 3 | `POST .../questions/{qid}/revisions` | `createQuestionRevision` | 本轮补上 `Idempotency-Key` 门禁与 `questions.revision:{qid}` scope |
| 4 | `PATCH .../question-versions/{vid}` | `updateDraftVersion` | 已发布版本不可原地改（R-INV 1） |
| 5 | `POST .../question-versions/{vid}/publish` | `publishQuestionVersion` | 幂等指纹固定 `{}` |
| 6 | `POST .../question-versions/{vid}/withdraw` | `withdrawQuestionVersion` | `reason` 是 **query 参数**，参与幂等指纹 |
| 7 | `GET .../questions/{qid}/answer-keys` | `listAnswerKeys` | 只出元数据；`is_usable = checked && !disputed` |
| 8 | `GET .../questions/{qid}/source-regions` | `listSourceRegions` | 跨版本的 `source_link → region` 连接 |
| 9 | `GET .../question-versions/{vid}/mappings` | `listMappings` | 按 `mapping_revision → node.canonical_name` 排序 |
| 10 | `POST .../question-versions/{vid}/mappings` | `replaceKnowledgeMappings` | 新开修订，旧修订保留；空映射拒绝 |
| 11 | `GET .../rubric-versions/{rid}` | `getRubricVersion` | 作用域穿透失败一律 404 |
| 12–15 | 题目/家族的 `seal` / `unseal` | `sealQuestion` / `sealFamily` 等 + `sealPayload` | 追加策略修订；返回的是**解析后**的封存集合，不是新行 |
| 16 | `GET .../sealed-content` | `sealedContentReport` | 只报告仍然生效的最新策略 |
| 17–18 | 家族 `list` / `create` | 已有 | 列表顺序修正为 `subject.display_order → name` |
| 19 | `PATCH .../question-families/{fid}` | `updateFamily` | 改名/确认/备注，写审计 |
| 20 | `POST .../question-families/{fid}/questions` | `addQuestionToFamily` | 封存题/封存家族双向拒绝 |
| 21 | `DELETE .../question-families/{fid}/questions/{qid}` | `removeQuestionFromFamily` | 从封存家族移出被拒绝（避免静默解封） |
| 22 | `GET .../question-families/{fid}/merge-impact` | `mergeImpact` | 与 merge 共用 helper，预测=结果 |
| 23 | `POST .../question-families/{fid}/merge` | `mergeFamilies` | 重复合并 `noop` 零写入 |

路由总数 27 → **45**（题库 20 条新增；其中 19 条是 `:param` 路径，按 03 §F8 的宿主约束只在进程内测试可达，阶段 6 由 Remote 通道承接；
`/sealed-content` 等静态路径可直接由 `connection.fetch` 挂载）。

## 2. 家族合并：本批次唯一的新领域逻辑

`backend/apps/question_bank/services/families.py::merge_families` 是一个"会推翻旧结论"的写操作，移植时按顺序实现：

1. **校验**：不能合并到自身；跨科目拒绝；源家族里若有非目标科目成员拒绝；已合并到别处的家族不能再合并。
2. **移动 + 审计对**：`question.family_id → target`、目标 `revision+1`、源写 `merged_into/merged_at`；写一条 `ContentRevision(action="merge")`，
   detail 里带两个家族 id、移动数、失效证据 id 列表与暴露变化。
3. **暴露重算**：合并家族规则是"任一成员已见 ⇒ 整个家族已见"（`domain/contamination.ts` 的 `mergedFamilyScope`），
   写操作前后各算一次，只把**由未见变已见**的变化与原因（`family_variant_seen`）报给调用方。
4. **证据失效**：`unseen_variant` / `template_variant` 维度、或 `detail`/`exclusion_reasons` 文本里点名旧家族 id 的**活动**证据行，
   一律 `is_active=false` + `invalidated_at` + 固定原因「家族合并后不再构成不同家族证据」。**不删除**——历史可复现性是门禁 §5.1。
5. **状态重算**：按失效行的 `(user, project, node)` 去重后调用既有 `refreshNodeState`；没有考点 id 的行不触发重算（与 Python 一致）。
6. **幂等**：同一对家族重复合并返回 `noop=true`，不写审计、不再抬 revision；`merge-impact` 对已合并返回 `already_merged=true`、
   `evidence_rows_to_invalidate=0`。

单写者事务（`BEGIN IMMEDIATE`）+ 事务内重读两个家族，替代 Django 的 `select_for_update`；失败整体回滚，与阶段 2 的事务约定一致。

## 3. 同批修正的三处"顺序分叉"

移植读接口时发现三处排序与 Django 不一致，都已修正并加回归测试（这类分叉不会抛错，只会让列表顺序悄悄变化）：

| 位置 | 之前 | Django 语义 | 现在 |
|---|---|---|---|
| 题族列表 | 全局按 `name` | `subject__display_order, name` | 先科目顺序再名字 |
| 映射列表 | `mapping_revision, node_id` | `mapping_revision, node__canonical_name` | 先修订再考点名 |
| 题目列表 | 无显式排序（插入序） | `-created_at` | 按 `created_at` 倒序，并列时保持插入序（D21） |

另修一处**契约缺失**：`POST .../revisions` 在 Django 里要求 `Idempotency-Key`（scope `questions.revision:{qid}`），
此前 Node 路由没包 `resource()`，会让客户端重放变成二次建版本。现与 Django 一致，并有 400 反例测试。

## 4. 验证证据（可复现）

```bash
cd dsh-plugin
export PATH="$PWD/../frontend/node_modules/.bin:$PATH"
npm run verify     # typecheck → build → 314 测试（系统 Node）→ 314 测试（DSH/Electron Node）→ 真实 Cordis 加载烟测
```

- 新增 `tests/question_queries.test.ts`（9 条）：列表元数据与分页、过滤/搜索、预览曝光与封存拒绝、答案版本可用性、来源区域、rubric 作用域。
- 新增 `tests/families_merge.test.ts`（5 条）：impact 预测、合并副作用与 exposed 变化、重复合并 no-op、三类拒绝、预览不写库。
- `tests/http.test.ts` 新增 3 条黑盒：完整"建题 → 发布 → 列表 → 预览 → 封存 → 解封"链路；家族成员增删/改名/合并/impact 的 `Request`→`Response` 行为；撤回的 `reason` 取自 query 且参与幂等指纹（同 key 换 reason → 409）。
- `tests/mappings.test.ts`、`tests/families.test.ts` 各新增 1 条顺序回归。

测试数字：295 → **314**（+19），失败 0。没有新增黄金向量：本批次是**服务/HTTP 编排层**，其可观察行为由 Django 既有黑盒契约与
Python 源码逐条对照得出；纯领域模块（判分/证据/状态/污染）的黄金向量仍是原有真相源，未改动。

## 5. 未做（明确不在本批次）

- 导入/候选/变体（ingestion **20** 个操作；规格见 [06-ingestion-port-spec.md](./06-ingestion-port-spec.md)）、报告/校准/评分快照/周期分析/覆盖率（analytics 9 个操作）——下一批次。
- **下一批次的前置依赖**：Django 自动 M2M through 表（`ingestion_import_job_documents`、`ingestion_import_candidate_source_regions`）不在 `schema.generated.ts` 中，且 `scripts/export_db.py` 对无模型的表导出为空并标 `no_model`——归档会丢这两张表的行，须先扩展 schema 生成器与导出脚本，再加 ingestion 服务。
- 作答细节：草稿、确认评分、揭示、外部已见、诊断与跟进、评分队列、转写、AI 估计/诊断。
- 知识域剩余：模板、验证配对、知识图谱、关系、先修、标签建议。
- 阶段 6 的动态路径 Remote 通道；本批次的 `:param` 路由只在进程内测试可用。

## 6. 回滚

本批次只改 `dsh-plugin/src` 与 `tests/`（`docs/` 除外），且 `dsh-plugin/` 整体尚未纳入 git；
回滚 = 还原到上一批次的 `src/services/questions.ts`、`src/services/families.ts`、`src/services/mappings.ts`、`src/services/sealing.ts`、
`src/http/routes.ts` 与对应测试文件。数据库 schema 无变化，已存在的库无需迁移。
