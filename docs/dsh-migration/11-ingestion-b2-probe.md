# 11 ingestion B2 探针：O18 发布（Django 实测）

日期：2026-11-06。目标：在移植 O18 之前，用**真实 Django + 真实 PostgreSQL** 记录
`POST /api/v1/projects/{project_id}/import-candidates/{candidate_id}/publish` 的状态码、错误信封、
响应形状与行级副作用。本文所有数字与正文都来自同目录的
[11-ingestion-b2-probe.json](./11-ingestion-b2-probe.json)（由 `dsh-plugin/scripts/probe_ingestion_b2.py`
生成，40 个请求，一次性测试库，跑完即销毁）。Node 侧的黑盒断言按本文件写成，不按规格文档猜测。

## 0. 结论（先看这五条）

1. **响应与存储体是两种形状**：HTTP 响应经 `CandidateOut` 过滤，**没有** `question_id`；幂等表里
   `response_body` **有** `question_id`。重放时 Ninja 仍按响应模型过滤，所以重放响应也没有该键。
2. **检查顺序固定**：body（pydantic）→ 项目 → 候选 → 考试规范 → `Idempotency-Key`。因此“规范不存在 +
   没有幂等键”返回 404 而不是 409（P30）。
3. **发布不增加候选 revision**：P01 发布后 `revision` 仍是 1、`reviewed_at` 仍为 null；重复发布
   （新键）只多一条幂等记录（P04）。
4. **三考点等分会被拒绝**：`Decimal("1")/3` 三个相加是 `0.9999999999999999999999999999`，权重和 ≠ 1 →
   400（P15）。这是 Decimal 语义，不是浮点误差，不能“修正最后一个权重”。
5. **材料题的版本由第一个子题创建**：子题发布时 `_ensure_material_version` 建父题草稿并回写候选指针
   （P24 的 `question_bank_question` delta = 2）；材料题本身只能在其子题全部发布后发布（P23 → P26）。

## 1. 方法与夹具

- `django.test.Client` 打真实 Ninja 路由；夹具用真实服务/ORM 建：项目、科目、已发布/草稿规范、大纲、
  考点、来源文档、试卷与试卷版本、候选与来源区域。候选状态由真实 `refresh_candidate_issues` 计算。
- 每个用例记录：请求、状态码、完整 JSON、字段顺序、错误信封，以及需要时的**行级 write-set**（新建的
  question/version/answer/rubric/source link/mapping/paper item 的语义字段）与**行数 delta**。
- 生成的 id 以符号名替代（`QUESTION_OF_CAND_P01` 等），所以证据可读且不依赖随机 UUID。
- Django 测试设置下 Celery 是 eager 的，P20 的 outbox 记录显示 `processed`；Node 侧入队后由 worker
  消费（记录为 pending → processed），这是执行方式差异，不是契约差异。

## 2. 逐例结果

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P01 | 发布已校对单选候选 | 200 | 建 1 question/1 version/1 answer/1 source link；3 条审计（create_draft、answer create、publish）；响应无 `question_id`，存储体有；`resource_type=import_candidate` |
| P02 | 同键同 body 重放 | 200 | 响应与 P01 全等；行数 delta 全 0 |
| P03 | 同键不同 body | 409 | `idempotency_conflict`，`details={route_scope,reason:"same_key_different_payload"}`，零写入 |
| P04 | 已发布候选换新键再发 | 200 | 返回同一 question/version；只多 1 条幂等记录；不再建版本 |
| P05 | 已忽略候选 | 400 | `已忽略的候选不能发布` |
| P06 | 有 blocking issue | 422 | `候选仍有未解决的问题，不能发布`，`details.problems` 是**候选 issue**（含 `severity`） |
| P07 | 别的项目的候选 | 404 | `候选不存在或不属于该项目` |
| P08 | 不存在的规范 | 404 | 在幂等键之前检查 |
| P09 | 草稿规范 | 400 | `只能使用已发布的考试规范版本` |
| P10 | 同项目**另一科目**的已发布规范 | 200 | 只按 `spec.subject.project` 校验，不校验与候选同科目 |
| P11 | 非法 `origin_type` | 400 | `题目来源类型无效`，`details.origin_type`；零写入 |
| P12 | 未声明分值 + 规范默认值 | 200 | version `practice_max_score=2.00`（采用规范默认） |
| P13 | 1 个考点 | 200 | mapping revision 1，weight `1.0000` |
| P14 | 2 个考点 | 200 | 两条 `0.5000`；审计含 `question_knowledge/mapping_revision` |
| P15 | 3 个考点 | 400 | `details.total="0.9999999999999999999999999999"`；零写入 |
| P16 | 考点属于别的科目 | 404 | `考点大纲与题目科目不一致` |
| P17 | 大题 + rubric | 200 | rubric 由 `rubric_criteria`/`rubric_total_score` 写入，`checked_at` 有值；source_type=official |
| P18 | rubric 合计 ≠ 总分 | 422 | `结构校验失败` + `details.errors={total_score:["评分点合计 3.00 与 rubric 总分 6.00 不一致"]}`；零写入 |
| P19 | 填空各空合计 ≠ 题目分值 | 422 | `发布前校验未通过`，`problems=[blank_total_mismatch]` |
| P20 | 真实试卷候选 | 200 | 写 PaperItem（position 1、`max_score=2.00`、`is_scored=true`、answer 指向最新答案）+ 1 条 outbox（`projection.refresh_paper_stats`，dedupe `paper-stats:{paper}:{revision}`） |
| P21 | 同卷同号再发布 | 422 | 候选门禁 `duplicate_paper_position`（blocking，带 question/version id） |
| P22 | 候选科目 ≠ 试卷科目 | 404 | `题目科目与试卷科目不一致`；**整个发布回滚**，delta 全 0 |
| P23 | 材料题先于子题 | 422 | `material_children_unpublished`（候选门禁） |
| P24 | 第一个子题 | 200 | delta：question/version 各 **2**（子题 + 预建材料草稿）、1 个 paper item；子题 version 的 `parent_material_version` 指向材料草稿 |
| P25 | 第二个子题 | 200 | 同上，paper item position 3.2 |
| P26 | 子题全发布后发材料 | 200 | 材料 version `practice_max_score=null`、`material_child_version_ids=[child1,child2]`；paper item `is_scored=false`、`max_score=0.00`；子题 item 的 `parent_item` 回连 |
| P27 | `ai_variant` 任务的候选 | 422 | 门禁先报 `variant_source_missing`（B5 的变式校验）；O18 的“强制 ai_generated”分支在 B2 不可达 |
| P28 | 请求 `display_label` 优先 | 200 | question.display_label = 请求值；`estimated_seconds=90` 落库 |
| P29 | 缺少幂等键 | 409 | `缺少 Idempotency-Key 请求头` |
| P30 | 规范不存在 + 无键 | 404 | 规范检查先于幂等键 |
| P31 | body 是数组 | 200 | Ninja 把数组 body 当空对象；全默认字段 → 正常发布 |
| P32 | 未给 `estimated_seconds` | 200 | version `estimated_seconds=null`（不是 0） |
| P33 | 无 `source_position_key` | 200 | paper item position 取 `payload.display_label` |
| P34 | `origin_type=demo` | 200 | `is_demo=true` |
| P35 | 250 字 `display_label` | 200 | 发布后 question.display_label 长度 **200** |
| P36 | `node_ids` 是字符串 | 400 | `list_type`，loc `["body","payload","node_ids"]` |
| P37 | `node_ids` 含非字符串 | 400 | `string_type`，loc `[...,"node_ids",0]` |
| P38 | `origin_type` 非字符串 | 400 | `string_type` |
| P39 | `display_label=null` | 400 | `string_type`（该字段非 Optional） |
| P40 | `exam_spec_version_id` 非字符串 | 400 | `string_type` |

## 3. 对 Node 移植的硬约束

- **错误信封**：400/404/409/422 的 `code/message/details` 按上表原样；`details.problems`（候选门禁）与
  `details.errors`（结构校验）不能混用。
- **422 的两种来源**：候选门禁 → `候选仍有未解决的问题，不能发布` + `problems`；发布前校验 →
  `发布前校验未通过` + `problems`；模型 `full_clean`（rubric）→ `结构校验失败` + `errors`。
- **审计行**：普通叶子 3 条（version create_draft、answer create、version publish）；带映射 4 条
  （多 `question_knowledge/mapping_revision`）；材料题 2 条（create_draft、publish，材料草稿由子题那笔建）。
- **材料父子**：子题先发布 → 父题草稿存在但 `status=draft`；父题发布后 `material_child_version_ids`
  按子题 `created_at` 排序；父 item 回连已发布子 item。
- **paper item**：`position_key` 优先级 `source_position_key → payload.display_label → cand-{id 前 8 位}`；
  材料 `is_scored=false, max_score=0.00`；`answer_key_version` 取该版本**最新**答案（含争议答案，O18 不筛）。
- **幂等**：指纹是 `CandidatePublishIn.model_dump(mode="json")`（默认值参与），存储体含 `question_id`，
  响应投影不含；失败请求释放 claim（P11/P15/P16/P22 之后同键可重试）。
