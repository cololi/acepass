# 14 ingestion B5 探针：O19/O20 变式与图片 extraction worker

日期：2026-11-06。方式：`dsh-plugin/scripts/probe_ingestion_b5.py` 在一次性 PostgreSQL 测试库上启动
**真实 Django**，O19/O20 走真实 Ninja 路由与 `django.test.Client`（登录、`Idempotency-Key`、JSON body），
extraction 直接调用真实服务 `apps.ingestion.services.extraction.extract_image_candidate`。AI provider 一律是
**scripted test double**（`is_stub=True`、`provider="probe-scripted"`、`model="probe-model"`），不是真实模型。

本文件只记录实测结果；原始 JSON 见 [14-ingestion-b5-probe.json](./14-ingestion-b5-probe.json)（26 例，
sha256 `469e20ba…f7f55`，重复运行逐字节一致：UUID 一律符号化、时间戳一律 `<now>`）。

## 0. 覆盖与结论

| 操作 | 例数 | 内容 |
|---|---|---|
| O19 `POST …/variants/propose` | 16 | 无能力、无 source/count=0、源/考点 404、草稿/材料/封存拒绝、成功写集、重放、冲突、重复提案、上限、第 2 次调用失败、跨项目 |
| O20 `GET …/variants` | 3 | 列表与顺序、limit clamp、limit 非整数 |
| extraction worker | 7 | 入队、成功、非法 JSON、校验拒绝、无能力、迟到 revision、缺资产行 |

结论：O19/O20 的**可观察 API 行为**（状态码、错误信封原文、幂等 scope/指纹、候选/审计行）全部有实测依据；
extraction 的 5 条退化路径都按 Django 现状复刻。两处**有意偏离**（Django 真实 provider 的 `call.payload`
缺陷、extraction 失败分支的 lost-update）与一处**未达 parity**（`max_output_tokens`）记录在
[04 §M](./04-parity-findings.md)。

## 1. O19：前置与拒绝路径（P01–P08、P15–P16）

| 例 | 场景 | 状态 | 关键证据 |
|---|---|---|---|
| P01 | 无 provider | **503** | `error.code=ai_not_configured`，message 原文 `生成变式需要配置 AI 能力：未配置可生成变式的文本模型；请配置 provider 或人工录入变式`，`details={error_code:"ai_not_configured"}`；**行增量只有 1 条 `audit_llm_run`**（status=`unavailable`，`provider="none"`，`model_identifier=""`，`error_code="ai_not_configured"`，`cost_known=false`），无 Job/Candidate |
| P02 | 两个 source 都空 | 400 | `必须提供 source_question_id 或 source_version_id`，零写入 |
| P03 | `count=0` | 400 | `count 必须至少为 1`，零写入 |
| P04 | 不存在的 source version | 404 | `源题目版本不存在或不属于该项目` |
| P05 | 不存在的 node | 404 | `考点不存在或不属于该项目` |
| P06 | 显式给 draft 版本的 id | 400 | `只能从已发布的题目版本生成变式：草稿内容还没有经过人工发布`，零 provider 调用 |
| P07 | material 版本 | 400 | `共享材料题不能生成变式；请选择它的子题作为源题` |
| P08 | 封存题 | 403 | `封存内容不可用于生成变式：…`，`details={reason:"sealed_question_policy",question_id,action:"用于生成变式"}`；零 run/job（封存检查在模型审计之前） |
| P15 | 另一项目的 node | 404 | `考点不存在或不属于该项目` |
| P16 | 另一项目的 source version | 404 | `源题目版本不存在或不属于该项目` |

## 2. O19：成功、幂等与失败（P09–P14）

**P09 成功写集**（scripted provider 返回合法单选择变式，`count=1`）：

- 201；`origin_type=ai_generated`、`is_stub=true`（test double；生产移植无 stub，恒 false）、`model="probe-model"`、
  `validation={requested_count:1,count:1,accepted:1,rejected:0,blocking_problem_count:0,nothing_passed:false}`；
- 行增量：`audit_idempotency_record+1`、`audit_llm_run+1`、`ingestion_import_job+1`、`ingestion_import_candidate+1`；
- run：`status=succeeded`、`provider="probe-scripted"`、`model_identifier="probe-model"`、
  `validation_result` 的键为 `accepted/content_digest/independent_problems/index/problems/validation_problems`；
- job：`input_kind=ai_variant`、`extractor_version=p2-propose-variant-v1`、
  `input_text="ai-variant:VERSION:NODE:同考点换数:1"`、`problems` 是先 `ai_variant_not_published`（info）；
- candidate：`status=draft`、`answer_status_known=false`、`answer_source_type=ai_derived`、
  `practice_max_score="2.00"`、`display_label="AI变式·Q1"`、`variant_prompt_version=p2-propose-variant-v1`；
  `review_issues` 是 `answer_unknown`（blocking）+ `no_source_region`（warning）——**AI 答案只是提案**，
  所以即使校验通过也不是 ready；
- `problems` 顶层把候选的问题平铺进去（`variants.py:962`），不是只列变式校验问题。

**P10 重放**：同 key 同 body → 201，响应与 P09 相同，**行增量全 0**（幂等表只读，不再产生第二条 run/job）。
**P11 冲突**：同 key、`count` 改 2 → 409 `idempotency_conflict`，
`details={reason:"same_key_different_payload",route_scope:"variants.propose:PROJECT"}`。

**P12 重复提案**：候选内容与 P09 的 pending candidate 相同 → 仍 201、仍建候选；`accepted=0/1`；
该候选 `review_issues` 同时出现 `answer_unknown`、`no_source_region`、`duplicate_pending_proposal`（带
`candidate_id`）与通用扫描的 `duplicate_candidate`（两条独立规则，见 04 §M M13）。

**P13 上限**：请求 5 → `requested_count=5`、`count=3`、`count_capped=true`，job 多一条
`variant_count_capped` warning；`notes` 原文：
`单次最多生成 3 道变式：请求 5 道，已按上限执行 3 道（如需更多请分批提出）。`
三个候选里 2 个 accepted，第 3 个与第 2 个题干相同 → `duplicate_pending_proposal`。

**P14 第二次调用失败**（`count=2`，第 2 次抛 `AiTimeout`）：

- 503，`error.code=dependency_unavailable`，message `生成变式失败：scripted timeout`，
  `details={error_code:"ai_timeout"}`；
- 行增量 `audit_llm_run+2`、`ingestion_import_candidate+1`、`ingestion_import_job+1`：**第 1 个候选与两条 run 都保留**；
- 两条 run 的 status 分别是 `succeeded` / `timeout`；job `status=failed`，
  `last_error="变式生成失败：scripted timeout"`；
- 失败请求释放了幂等 claim（同 key 可重试，不再 409）。

## 3. O20：列表（P17–P19）

- P17 `GET …/variants?limit=500`：200，`count=4`（P09/P12/P13/P14 四个 ai_variant job），
  `limit=50`（clamp 到 1..50），job 按 `created_at desc`；每 job 带 `candidate_count`、
  `candidate_status_counts`（只含实际状态，不补零）与 `candidates`（按 `created_at asc`）。
- P18 同 P17（重复确认 clamp）。
- P19 `limit=abc`：400 `请求参数校验失败`，
  `errors=[{type:"int_parsing",loc:["query","limit"],msg:"Input should be a valid integer, unable to parse string as an integer"}]`。

## 4. extraction worker（P20–P26）

**P20 入队**：真实 `start_image_import(use_vision=True)` → `input_kind=image_ai`、`extractor_version=vision-v1`、
job 问题 `vision_extraction_queued`；行增量 `ingestion_import_job+1`、`ingestion_import_candidate+1`、
`audit_outbox_event+1`（topic `ingestion.extract_candidate`）。本探针直接调用服务，**不消费** outbox，所以
P21–P26 里 `outbox_status` 仍是 `pending`——这是探针方法，不是缺陷；worker 的 claim/确认语义由 Node 测试覆盖。

| 例 | provider 行为 | 返回 | 候选 | job 问题 | run |
|---|---|---|---|---|---|
| P21 | 合法视觉 JSON | `ok` | revision **2**、`extractor_version=vision-v1`、`is_stub_output=true`（test double）、`answer_status_known=true`、`needs_manual_structure=true`、status=`ready`、review_issues=[] | `vision_extraction_queued` + **`vision_extracted_stub`**（test double 的措辞） | `succeeded`、`provider/model`、tokens=11/22、`validation={problems:[],accepted:true}` |
| P22 | `raw_text="this is not json"` | `invalid_output` | revision 1，草稿不动 | `vision_extraction_failed`（`视觉模型输出不是有效 JSON，请人工录入`） | `rejected`、`error_code=ai_invalid_output`、`error_message="模型返回的不是有效 JSON"` |
| P23 | 合法 JSON 但 `content.blocks` 为空 | `rejected` | revision 1 | `vision_extraction_failed`（`视觉识别结果未通过校验，已保留人工录入路径：题干不能为空`） | `rejected`、`error_code=ai_invalid_output`、`error_message` 是校验问题原文 |
| P24 | `NullProvider` | `unavailable` | revision 1 | `vision_extraction_failed`（`视觉模型未配置或不可用，已保留人工录入路径`） | `unavailable`、`error_code=ai_not_configured`、`error_message="未配置 AI 能力（…）"`、无 tokens/cost |
| P25 | 调用**期间**人工把候选 revision 1→2 | `ok` | revision **2**、草稿保持人工内容 | `vision_extracted_stale` | `succeeded`；machine payload 键为 `applied_revision/extraction_started_revision/extractor/is_stub_output/model/pending_clean_payload/prompt_version/provider/raw_excerpt/stale_revision`；`stale_revision=true` |
| P26 | 文档 `asset=None` | `missing_source_image` | revision 1 | `vision_extraction_failed`（`来源图片不可读取，无法识别`） | `failed`、`error_code=missing_source_image`、`error_message="来源文档没有保存原始图片"` |

P21 的 `machine_payload` 键是 `extractor/is_stub_output/model/prompt_version/provider/raw_excerpt`；
`is_stub_output` 来自 provider 的 `is_stub`，在真实 provider 下恒 false。P25 证明 **B06 迟到保护**：人工版本
不被覆盖，模型结果只作为 machine record 保留，外层仍返回 `"ok"`。

## 5. 与 Node 移植的对照要点

- P01/P09/P10/P11/P12/P13/P14 的响应字段与 Node HTTP 测试逐项一致；差异只在审计行的 `provider`
  （Django 实现名 vs `dsh-llm`/DSH route）与 `error_message`（Django 的 provider 原文 vs 端口原因），见 04 §M M2/M3。
- P09 的 `is_stub=true` 只证明"test double 会被标记"；Node 生产路径 `is_stub=false` 是字面量，测试断言
  `is_stub_output=false` 且不会新造 true。
- P14 的 `dependency_unavailable` 文案与 Node `VariantProviderFailure` 映射一致（`生成变式失败：{exc}`）。
- extraction 的 5 条退化路径与 Node 测试一一对应；Node 额外覆盖 worker 的 **claim 复核与 outbox 确认**
  （Django 探针直接调服务，看不到这一层）。

## 6. 复现

```bash
cd dsh-plugin
../backend/.venv/bin/python scripts/probe_ingestion_b5.py
# 26 cases; O19 16 / O20 3 / EXTRACT 7
shasum -a 256 ../docs/dsh-migration/14-ingestion-b5-probe.json
# 469e20ba33d7021521bab5637bf29f33074ead11ce76825af600f18ffe5f7f55
```
