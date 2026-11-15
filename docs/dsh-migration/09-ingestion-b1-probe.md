# 09 ingestion B1 探针：Django 实测 HTTP 行为

日期：2026-11-06。范围：B1 的 **O03 / O04 / O07 / O10–O17**，外加这些路由的 Schema 与 query 校验、以及 21 段文本的 `Region.clean` 回滚。
方法：真实 Django 路由 + `django.test.Client` + 一次性 PostgreSQL 测试库；不是 pytest。本文是证据，不是验收声明。

- 脚本：[dsh-plugin/scripts/probe_ingestion_b1.py](../../dsh-plugin/scripts/probe_ingestion_b1.py)
- 原始证据（114 个 case 的 request/status/JSON/DB checks 与符号表）：[09-ingestion-b1-probe.json](./09-ingestion-b1-probe.json)
- 对照规格：[06-ingestion-port-spec.md](./06-ingestion-port-spec.md)

## 0. 运行结果

| 项 | 值 |
|---|---|
| Django | `5.2.17` |
| settings | `config.settings.test` |
| DB bootstrap | `setup_test_environment()` → `connection.creation.create_test_db(verbosity=0, autoclobber=True)`，`finally` 中 `destroy_test_db`；**成功**，退出码 0 |
| Case 数 | **114**（111 operational + 3 setup） |
| 出现过的状态码 | `200, 201, 400, 404, 409, 422` |
| 错误响应 | 46 个；`request_id` 出现 **0** 次 |
| outbox | 所有 case 前后均为 0 行（`audit_outbox_event` 未写入） |
| 脚本副作用 | 只新增 `docs/dsh-migration/09-ingestion-b1-probe.json`；未改 `backend/apps`、`dsh-plugin/src`、`dsh-plugin/tests` 或 git 状态 |

复现：

```bash
cd dsh-plugin
../backend/.venv/bin/python scripts/probe_ingestion_b1.py
# 末行：114 cases (111 operational + 3 setup) written to .../09-ingestion-b1-probe.json
```

夹具（`SYMBOLS` 可反查真实 ID）：

| 符号 | 用途 |
|---|---|
| `{USER_OWNER}` / `{USER_OTHER}` | 两个账号；后者拥有 `{PROJECT_B}` |
| `{PROJECT_A}` / `{PROJECT_B}` / `{PROJECT_C}` / `{PROJECT_D}` / `{PROJECT_E}` | 主项目 / 他人项目 / 列表上限夹具 / 排序夹具 / 空列表 |
| `{SUBJECT_A1}` / `{SUBJECT_A2}` | 本项目两个科目 |
| `{SUBJECT_B1}` | 另一个项目的科目（跨项目 404 用例） |
| `{SUBJECT_C1}` | 项目 C 的科目（长文档用例） |
| `{QUESTION_PUBLISHED}` / `{VERSION_PUBLISHED}` | 已发布题与版本（O14/O15 的 editorial preview 前置） |
| `{JOB_LABELLED}` | O07 成功导入（2 个 ready 候选） |
| `{JOB_DEFAULT}` | O07 默认字段导入（1 个 draft 候选；后设为 failed 供 O12） |
| `{JOB_PARSE_FALSE}` | `parse=false` 的 0 候选任务（后设为 attempts=3 供 O12） |

> 符号表只列脚本 `symbols` 中登记过的名称；正文中未登记的 `{DOC_LABELLED}`、`{CAND_IGNORE_CONFLICT}` 等只是按用途命名的可读别名，真实值见证据 JSON 的 concrete ID。

> 夹具边界：O14–O17 的候选/任务起点由 ORM 直接创建（包括 `status=published`、`publication_*` 链接），因为 O18 发布尚未实现；被观测的路由与 service 是真的。O12 的 `failed` 状态同样由 ORM 设置，因为没有任何 HTTP 操作能把任务改成 failed。详见 §15。

---

## 1. O03 `GET /api/v1/projects/{project_id}/source-documents`

### 1.1 实测

| case | 请求 | status | 结果 |
|---|---|---|---|
| O03-01 | `{PROJECT_E}`，无 query | 200 | `[]` |
| O03-02 | `?subject_id={SUBJECT_A1}` | 200 | 1 条：`title=DOC-A1` |
| O03-03 | `?subject_id={SUBJECT_B1}`（他人项目科目） | 404 | `not_found / 科目不存在或不属于该项目`，`details={}` |
| O03-04 | 路径为 `{PROJECT_B}` | 404 | `not_found / 项目不存在或无权访问`，`details={}` |
| O03-05 | `?limit=0` | 200 | **1 条**（`max(1,min(0,100))`） |
| O03-06 | `?limit=1` | 200 | 1 条 |
| O03-07 | `?limit=100`（项目 A 共 3 条） | 200 | 3 条，顺序 `["", "DOC-A2", "DOC-A1"]`（空标题是 DOC-NONE；created_at desc） |
| O03-08 | `?limit=101`（项目 C 共 **102** 条） | 200 | **100 条**（上限 100 被观测到） |
| O03-12 | `?limit=100`（项目 C 共 102 条） | 200 | 100 条 |
| O03-09 | `?limit=-5` | 200 | **1 条** |
| O03-10 | `?limit=abc` | 400 | `invalid_input / 请求参数校验失败`；`details.errors=[{type:"int_parsing",loc:["query","limit"],msg:"Input should be a valid integer, unable to parse string as an integer"}]` |
| O03-11 | `?limit=1.5` | 400 | 同上，`type` 仍是 `int_parsing`（query 值是字符串） |

响应字段顺序（`DocumentOut`，Ninja 按响应模型重排）：

```json
["id","project_id","subject_id","title","document_type","role","sensitivity",
 "source_type","source_note","usage_scope","checksum","asset_id","raw_text_preview"]
```

### 1.2 与规格的差异 / 注意

- 字段集合与 06 §1 的 Document 基本一致，但**顺序不同**：实测 `subject_id` 第 3 位、`asset_id` 在 `checksum` 之后；06 表把 `subject_id/asset_id` 写成尾部可空字段。Node 若按原始 JSON 文本对拍，需要按实测顺序（否则只做对象等价即可）。
- `limit` 的 clamp 是 `max(1, min(limit, 100))`：`0`、负数都变成 1，`>100` 变成 100；规格的 “1..100” 被证实。
- `limit` 的 400 在 query 解析层发生，**不会**进入路由/owner 检查；`loc` 是 `["query","limit"]`，无 `body`/`payload`。
- 未知 `subject` 与外部项目都走 `ScopeViolation`，但消息不同：前者“科目不存在或不属于该项目”，后者“项目不存在或无权访问”。
- 排序只有 `created_at desc`；脚本把 O04 产生的 3 条文档的 `created_at` 固定为 `00:01/00:02/00:03Z` 后观测到严格倒序。**并列时间未测**。

---

## 2. O04 `POST /api/v1/projects/{project_id}/source-documents/text`

### 2.1 实测

| case | 请求要点 | status | 结果 |
|---|---|---|---|
| O04-01 | `{"text":"   \n\t  "}` | 400 | `invalid_input / 文本内容不能为空`，`details={}` |
| O04-02 | 项目 C，`text=450×"L"`，`title=301×"T"`，`source_note=501×"N"`，`usage_scope=201×"U"`，并额外发送 `raw_text/checksum/document_type/role/sensitivity/source_type/parse` | 201 | 见下 |
| O04-03 | 仅 `{"text":"无科目文档正文"}` | 201 | 全部默认值 |
| O04-04/05 | 带 `{SUBJECT_A1}` / `{SUBJECT_A2}` | 201 | 用于 O03 过滤与排序 |
| O04-06 | `subject_id={SUBJECT_B1}` | 404 | `not_found / 科目不存在或不属于该项目` |
| O04-07 | 路径为 `{PROJECT_B}` | 404 | `not_found / 项目不存在或无权访问` |

O04-02 的行级事实（请求里的冲突字段全部**被忽略**）：

| 字段 | 实测 |
|---|---|
| `title` | 长度 **300**（`"T"*301` → 300） |
| `source_note` | 长度 **500**（`"N"*501` → 500） |
| `usage_scope` | 长度 **200**（`"U"*201` → 200） |
| `raw_text` | 等于请求的 450 字符；**不是**请求里额外发送的 `"不应被采用的原文"` |
| `raw_text_preview` | 长度 **400**（`raw_text[:400]`） |
| `checksum` | `sha256(raw_text UTF-8)`，实测与脚本计算一致 |
| `document_type` | `"text"`（请求的 `"pdf"` 被忽略） |
| `role` | `"past_paper_page"`（请求的 `"answer_page"` 被忽略） |
| `sensitivity` | `"public_to_owner"`（请求的 `"contains_answers"` 被忽略） |
| `source_type` | `"user_paste"`（请求的 `"user_upload"` 被忽略） |
| `asset_id` | `null` |
| `page_count` | `1` |
| `page_texts` | `[]` |

O04 响应字段顺序与 O03 相同：

```json
["id","project_id","subject_id","title","document_type","role","sensitivity",
 "source_type","source_note","usage_scope","checksum","asset_id","raw_text_preview"]
```

### 2.2 注意

- O04 的 `TextImportIn` 也声明了 `parse`，但 O04 **不使用**它；`parse=false` 不影响创建。
- 未知字段被 pydantic 默认忽略；不要据此认为 API 接受客户端指定 `document_type/role/sensitivity/source_type`。
- 截断长度是 Python 码点（这里用 ASCII 观测，未用 emoji 区分 UTF-16）。

---

## 3. O07 `POST /api/v1/projects/{project_id}/imports`

### 3.1 成功响应（O07-01）

请求体：

```json
{"text":"<两段【题型】【题干】【选项】【答案】【解析】模板>",
 "subject_id":"{SUBJECT_A1}","title":"导入标题",
 "source_note":"导入来源说明","usage_scope":"仅练习"}
```

`201`，响应字段顺序（`ImportJobOut`）与值：

```json
{
  "id": "{JOB_LABELLED}",
  "project_id": "{PROJECT_A}",
  "subject_id": "{SUBJECT_A1}",
  "status": "awaiting_review",
  "input_kind": "text",
  "progress_percent": 0,
  "problems": [],
  "attempts": 0,
  "max_attempts": 3,
  "last_error": "",
  "extractor_version": "text-structure-v1",
  "duplicate_of_job_id": null,
  "document_ids": ["<O07-01 创建的文档 ID>"],
  "candidate_count": 2,
  "candidate_status_counts": {"ready": 2},
  "page_diagnostics": [],
  "created_at": "…+00:00"
}
```

行级事实（同一 case）：

| 对象 | 实测 |
|---|---|
| `SourceDocument` | `title="导入标题"`, `source_note="导入来源说明"`, `usage_scope="仅练习"`, `subject_id={SUBJECT_A1}`, `document_type="text"`, `role="past_paper_page"`, `sensitivity="public_to_owner"`, `source_type="user_paste"`, `raw_text` 与请求完全相等, `checksum=sha256(raw_text)`, `page_count=1`, `page_texts=[]`, `asset_id=null` |
| `ImportJob` | `status=awaiting_review`, `input_kind=text`, `extractor_version=text-structure-v1`, `progress_percent=0`, `attempts=0`, `max_attempts=3`, `last_error=""`, `problems=[]`, `duplicate_of=null`, `started_at` 已设置, `finished_at=null`, `input_fingerprint == sha256(text)` |
| `ImportCandidate` | 2 行；`status=ready`、`revision=1`、`review_issues=[]`、`is_stub_output=false`、`machine_payload == draft_payload`、`reviewed_at=null`、`publication_question_id/version_id=null`、`subject_id={SUBJECT_A1}` |
| `SourceRegion` | 2 行；`page_index=1`, `x=0.0`, `width=1.0`, `height=0.05`, `role=stem_crop`；`y=0.0/0.05`；`char_start=12/74`、`char_end=20/82`；`text_span="第一题题干内容？"/"第二题题干内容？"` |

`candidate_status_counts` 由 `job_summary` 里的集合推导生成，**只含实际存在的状态**；这里是 `{"ready": 2}`。空任务时是 `{}`（O07-03）。

### 3.2 默认值（O07-02）

`{"text":"<一段模板>"}` → 201：

- `subject_id=null`；文档 `title=""`、`source_note=""`、`usage_scope=""`、`subject_id=null`。
- 候选 1 个，`status=draft`，`review_issues=[{code:"subject_missing",...}]`；`candidate_status_counts={"draft":1}`。

### 3.3 `parse=false`（O07-03）

`{"text":"<唯一模板>","parse":false}` → 201：

- `status=awaiting_review`；`candidate_count=0`；`candidate_status_counts={}`；
- `problems=[{"code":"no_recognised_segment","message":"未能从粘贴文本中识别出题目结构，请使用“题目模板”格式或手工录入。","severity":"warning"}]`；
- 仍创建 1 个 `SourceDocument`；0 个 region、0 个 candidate。

### 3.4 幂等键

| case | Idempotency-Key | 结果 |
|---|---|---|
| O07-04 | `o07-empty-then-retry`，空文本 | 400 `invalid_input / 文本内容不能为空`；随后该 key 的 `IdempotencyRecord` 行数 = **0**（claim 已释放） |
| O07-05 | 同 key，换成合法 body | **201**；该 key 行数 = **1**（同 key 可重试） |
| O07-06 | 不发送 header | 409 `idempotency_conflict / 缺少 Idempotency-Key 请求头`，`details={}` |
| O07-07 | `"  padded-key  "` | **201**；数据库存的是 trim 后的 `"padded-key"` |
| O07-08 | `"padded-key"`（同 body） | 201 重放（证明前后空格被 trim） |
| O07-09 | 200×`"k"` | 201 |
| O07-10 | 201×`"k"` | 409 `idempotency_conflict / Idempotency-Key 过长`，`details={}` |
| O07-11 | O07-01 的 key + 完全相同的 body | **201**，与 O07-01 响应逐字段相等（`identical_to_O07_01=true`） |
| O07-12 | 同 key + 不同 body | 409 `idempotency_conflict / 相同幂等键使用了不同请求内容`；`details={"route_scope":"imports.create:{PROJECT_A}","reason":"same_key_different_payload"}` |

重放返回的是**第一次的 201**，不是 200；body 含原 `created_at` 与 `document_ids`。

### 3.5 重复输入（O07-13a/b）

相同 `text`、不同 key、连续两次 POST：

- 第一次：201，`duplicate_of_job_id=null`、`problems=[]`。
- 第二次：**201**（未阻断）；`duplicate_of_job_id={JOB_DUP_FIRST}`；`problems` 里有一条：

```json
{"code":"duplicate_input",
 "message":"检测到相同输入的历史导入任务，请确认是复用还是新建题库（不会自动重复计入真实试卷）",
 "severity":"warning",
 "duplicate_job_id":"{JOB_DUP_FIRST}"}
```

- 第二次仍创建新的 document/job/candidate（`candidate_count=1`），不是复用旧任务。

### 3.6 无结构文本（O07-14）

`{"text":"只有一句话，没有题号也没有标签。"}` → **201，candidate_count=1，problems=[]**。
`parse_paste` 实际返回 1 段（numbered fallback），所以“无段”路径并没有被这个输入触发。**`no_recognised_segment` 只能由 `parse=false`（或解析器真的返回 []）产生**；不能把“文本没有题号”当成必然 0 候选。

### 3.7 21 段与 `Region.clean`（O07-15 / O07-16）

O07-15 用 21 条编号行（`1. 第1题 …` 到 `21. 第21题 …`）走真实 HTTP：

- `parse_paste` 实际返回 **21** 段；
- 请求返回 **422**：

```json
{"error":{"code":"structure_invalid","message":"结构校验失败",
          "details":{"errors":{"width":["区域超出页面范围"]}}}}
```

- `details.errors` 是 **dict**（`message_dict`），不是 400 schema 的 list；
- 前后 `db_counts` delta 为 `{}`：document/job/region/candidate 全部回滚；
- 该 key 的 `IdempotencyRecord` = 0（失败 claim 被中间件释放）。

O07-16 直接调用真实的 `apps.ingestion.services.imports.start_text_import(..., segments=[21 个合成段])`：

```json
{"outcome":"exception",
 "exception":{"type":"ValidationError",
              "message_dict":{"width":["区域超出页面范围"]},
              "messages":["区域超出页面范围"],
              "str":"{'width': ['区域超出页面范围']}"}}
```

计数 delta 同样为 `{}`。异常不是 `StructureInvalid`/`AcePassError`；它从 model `full_clean` 抛出，由 Django `ValidationError` handler 映射成 422。

---

## 4. O10 `GET /api/v1/projects/{project_id}/imports`

| case | 请求 | status | 结果 |
|---|---|---|---|
| O10-01 | `?status=nope` | 200 | `[]`（未知枚举不报错，只做原值过滤） |
| O10-02 | 无 query（项目 D，3 条） | 200 | 3 条；`created_at` 顺序 `00:03 / 00:02 / 00:01`，即 desc；`created_by` 为他人的任务不可见 |
| O10-03 | `?status=awaiting_review` | 200 | 3 条 |
| O10-04 | `?limit=0` | 200 | 1 条（最新那条） |
| O10-05 | `?limit=-5` | 200 | 1 条 |
| O10-09 | `?limit=100`（项目 C 共 101 条） | 200 | 100 条 |
| O10-06 | `?limit=101`（项目 C 共 101 条） | 200 | **100 条** |
| O10-07 | `?limit=abc` | 400 | `int_parsing`，`loc=["query","limit"]` |
| O10-08 | `?limit=1.5` | 400 | 同上（query 字符串，仍是 `int_parsing`） |

说明：O10 与 O03 的字段顺序不同（JobOut vs DocumentOut）；JobOut 顺序见 §3.1。列表元素没有额外 `owner` 字段；所有权只体现为过滤。

---

## 5. O11 `GET /api/v1/projects/{project_id}/imports/{job_id}`

| case | 请求 | status | 结果 |
|---|---|---|---|
| O11-01 | 自己的 `{JOB_D2}` | 200 | `id` 与路径一致 |
| O11-02 | 不存在的 UUID | 404 | `not_found / 导入任务不存在或不属于该项目` |
| O11-03 | 同项目、`created_by={USER_OTHER}` 的任务 | 404 | 同上 |
| O11-04 | 项目 D 路径 + 项目 B 的 `{JOB_B}` | 404 | 同上（job 查询限定 `project + created_by`） |
| O11-05 | 项目 B 路径（他人项目） | 404 | `not_found / 项目不存在或无权访问`（先 `require_project`） |

`JobOut` 不含 `started_at/finished_at`；任务的这些字段只能从 DB 侧观测（见 O12）。

---

## 6. O12 `POST /api/v1/projects/{project_id}/imports/{job_id}/retry`

| case | 请求 | status | 结果 |
|---|---|---|---|
| O12-01 | 非 failed 的 `{JOB_D1}` | 400 | `invalid_input / 只有失败或已取消的任务可以重试` |
| O12-02 | `{JOB_DEFAULT}`（ORM 设为 failed） | 200 | 见下 |
| O12-03 | 同 key 同 body 重放 | 200 | 与 O12-02 响应逐字段相等 |
| O12-04 | `attempts=3,max_attempts=3` 的 failed 任务 | 400 | `invalid_input / 已重试 3 次，达到上限；请新建导入任务` |

O12-02 的行级事实：

| 字段 | 重试前（ORM 设置） | 重试后 |
|---|---|---|
| `status` | `failed` | `awaiting_review` |
| `attempts` | `0` | **1** |
| `last_error` | `"合成失败原因"` | **`""`** |
| `started_at` | `2026-02-01T01:00:00+00:00` | 当前真实时间（晚于 `finished_at`） |
| `finished_at` | `2026-02-01T02:00:00+00:00` | **保留原值**（未清空） |
| `progress_percent` | `40` | `40`（未改） |
| `problems` | `[]` | `[{"code":"retried","message":"任务已重试（第 1 次），复用原有来源与候选。","severity":"warning"}]` |

因此出现一个容易被误判的状态：`status=awaiting_review` 但 `finished_at` 非空，且 **`finished_at < started_at`**（脚本 checks：`finished_at_before_started_at=true`、`non_terminal_status_with_finished_at=true`）。

- `ContentRevision` delta = **0**；`OutboxEvent` delta = **0**（重试不写审计、不重建候选、不重跑 parser）。
- 同 key 重放返回第一次的 200 body，`identical_to_O12_02=true`。

---

## 7. O13 `GET /api/v1/projects/{project_id}/import-candidates`

| case | 请求 | status | 结果 |
|---|---|---|---|
| O13-01 | `?job_id={JOB_LABELLED}` | 200 | 2 条；DB `created_at` 升序；响应**没有** `created_at` 字段 |
| O13-02 | `?job_id=…&status=ready` | 200 | 2 条 |
| O13-03 | `?job_id={JOB_DEFAULT}&status=draft` | 200 | 1 条 |
| O13-04 | `?status=nope` | 200 | `[]` |
| O13-05 | `?limit=0` | 200 | 1 条 |
| O13-06 | `?limit=-5` | 200 | 1 条 |
| O13-13 | `?limit=100`（项目 C 共 101 条） | 200 | 100 条 |
| O13-07 | `?limit=101`（项目 C 共 101 条） | 200 | **100 条** |
| O13-08 | `?limit=abc` | 400 | `int_parsing`，`loc=["query","limit"]` |
| O13-09 | `?limit=1.5` | 400 | 同上 |
| O13-10 | `?job_id={JOB_B}`（外部项目） | 200 | `[]` |
| O13-11 | `?job_id={JOB_D_FOREIGN_OWNER}`（同项目、他人创建） | 200 | `[]` |
| O13-12 | 无 query（项目 D，3 个自己的 + 1 个他人候选） | 200 | 3 条；DB 总候选 4；他人候选不可见 |

`CandidateOut` 字段顺序：

```json
["id","job_id","subject_id","status","revision","review_issues","is_stub_output",
 "extractor_version","draft_payload","machine_payload","source_regions",
 "publication_question_id","publication_version_id","publication_paper_item_id",
 "parent_candidate_id","child_candidate_ids","source_position_key","paper_revision_id",
 "answer_match","layout_review_confirmed_at","layout_review_note","updated_at"]
```

`source_regions` 元素（`CandidateRegionOut`）：

```json
["id","document_id","page_index","x","y","width","height","role","text_span",
 "crop_asset_id","document_asset_id","document_title","document_type"]
```

**没有 `char_start` / `char_end`**（与 06 §1 的 Region 说明一致）；O07-01 的 region 行只在 DB 侧看得到这两个值。

---

## 8. O14 `GET /api/v1/projects/{project_id}/import-candidates/{candidate_id}`

### 8.1 无发布链接：不写 exposure

`{CAND_NO_LINK}`（`publication_question_id=null`）→ 200；`practice_exposure_event` delta = 0，`ContentRevision` delta = 0；响应 `publication_question_id=null`。

### 8.2 已发布链接：写一行 editorial preview

`{CAND_LINKED}` 由 ORM 设置 `publication_question_id={QUESTION_PUBLISHED}`、`publication_version_id={VERSION_PUBLISHED}`，`status=ready`。GET 一次后 DB 行：

| 字段 | 值 |
|---|---|
| `kind` | `editorial_preview` |
| `purpose` | `editorial` |
| `source` | `ingestion.candidate_detail` |
| `reveals_answer` | `true` |
| `project_id` | `{PROJECT_A}` |
| `question_id` | `{QUESTION_PUBLISHED}` |
| `question_version_id` | `{VERSION_PUBLISHED}` |
| `family_id` / `content_lineage_id` / `session_item_id` | `null` |
| `server_time` | 真实时间（ISO `+00:00`，保留微秒） |
| `detail` | `{"note":"","candidate_id":"{CAND_LINKED}","proofread_at":"…+00:00","candidate_status":"ready","published_question":true}` |

`detail` 的 key 顺序是 PostgreSQL `jsonb` 的顺序（`note, candidate_id, proofread_at, candidate_status, published_question`），**不是** Python 代码里的插入顺序；Node 不应依赖这个顺序。

重复 GET：exposure 行数仍为 **1**，`exposure_ids` 只有一行；两次响应逐字段相等（`response_equals_O14_02=true`）。去重键包含 `detail.candidate_id`，`source` 不参与。

不存在的候选 / 他人任务下的候选：404 `not_found / 候选不存在或不属于该项目`。

---

## 9. O15 `PATCH /api/v1/projects/{project_id}/import-candidates/{candidate_id}`

### 9.1 `draft_payload` 全替换 + 旧 issues 快照（O15-01）

请求：

```json
{"draft_payload":{"question_type":"single_choice",
                  "content":{"blocks":[{"kind":"text","text":"改后题干"}],"options":[]},
                  "answer_payload":{}},
 "expected_revision":1,"note":"改后说明"}
```

响应 200；行级事实：

| 项 | 值 |
|---|---|
| `candidate.revision` | **2** |
| `candidate.status` | `draft`（新 issues 含 blocking） |
| `candidate.draft_payload` | 与请求的 `bad_payload` **完全相等**，只有 `["answer_payload","content","question_type"]` 三个 key；旧 payload 的 `display_label/source_excerpt/parse_issues/...` 全部消失（全替换，不是 merge） |
| `candidate.machine_payload` | **不变**（与 patch 前逐字段相等） |
| 新 `review_issues` codes | `["options_empty","too_few_options","answer_missing"]` |
| `CandidateRevision.revision` | 2 |
| `CandidateRevision.payload` | 等于新 payload |
| `CandidateRevision.review_issues` | **`[]`**，等于 patch 前的旧 issues（`snapshot_equals_pre_refresh=true`），**不是** patch 后重算的 issues |
| `CandidateRevision.note` / `edited_by_id` | `"改后说明"` / `{USER_OWNER}` |
| `ContentRevision.action` | `proofread` |
| `ContentRevision.entity_type` / `entity_id` | `import_candidate` / `{CAND_EDIT}` |
| `ContentRevision.detail` | `{"revision":2}` |
| `before_digest` / `after_digest` / `reason` | `""` / `""` / `""` |

### 9.2 空 patch（O15-02）

`{}` → 200：`revision` 1→2；`reviewed_at` 被设置；`draft_payload` 不变；`CandidateRevision.revision=2`、`payload` 不变、`review_issues=[]`（等于 patch 前）；`ContentRevision.detail={"revision":2}`。**空 patch 也产生一行 CandidateRevision 与一行 ContentRevision。**

### 9.3 其他拒绝

| case | 请求 | status | 结果 |
|---|---|---|---|
| O15-03 | `{"subject_id":"{SUBJECT_A2}","expected_revision":2}` | 200 | `subject_id` 改为 A2，revision=3 |
| O15-04 | `{"subject_id":"{SUBJECT_B1}"}`（跨项目） | 404 | `not_found / 科目不存在或不属于该项目`；revision 保持 1 |
| O15-05 | `{"note":"n"*501,"expected_revision":3}` | 200 | `CandidateRevision.note` 长度 **500** |
| O15-06 | published 候选 + `{"note":"不应写入"}` | 400 | `invalid_input / 已发布的候选不能继续修改；请为已发布题目创建新版本`；revision 1→1 |
| O15-07 | linked 候选 + `{"expected_revision":99}` | 409 | `version_conflict / 版本已过期，请重新加载`；`details={"actual":1,"expected":99}`（两者都是 JSON int，`type` 是 `int`）；revision 保持 1 |

O15-07 额外观测：`_record_editorial_preview` 在 `update_candidate` 之前执行，所以即使 PATCH 因 revision 冲突失败，仍新增 **1 行 exposure**：`source="ingestion.candidate_edit"`，detail 中 `candidate_status="ready"`。这与 06 §3.6 的顺序描述一致，但意味着“失败的 PATCH 也会留下副作用”。

---

## 10. O16 `POST /api/v1/projects/{project_id}/import-candidates/{candidate_id}/ignore?reason=…`

| case | 请求 | status | 结果 |
|---|---|---|---|
| O16-01 | `?reason="  理由X  "`，`{CAND_IGNORE}` | 200 | `status=ignored`、`revision` 仍 1、`reviewed_at=null`；`ContentRevision.action="ignore"`、`reason="  理由X  "`（长度 7，空格保留）、`detail={}`、digests `""` |
| O16-02 | GET `{JOB_IGNORE}` | 200 | `status=completed`、`progress_percent=100`、DB `finished_at` 已设置 |
| O16-03/04 | 同 key 同 reason 两次 | 200/200 | 响应逐字段相等；`ContentRevision` 行数仍 1 |
| O16-05/06 | 同 key 先 `理由A`，再 `理由B` | 200/409 | 第二次 `idempotency_conflict / 相同幂等键使用了不同请求内容`；`details={"route_scope":"candidates.ignore:{CAND_IGNORE_CONFLICT}","reason":"same_key_different_payload"}`；`ContentRevision` 行数仍 1 |
| O16-07 | `?reason="r"*501` | 200 | DB `ContentRevision.reason` 长度 **500**；`status=ignored` |
| O16-08 | published 候选 | 400 | `invalid_input / 已发布候选不能标记为忽略`；`ContentRevision` 行数 0 |

`ignore` 不增加 `revision`、不更新 `reviewed_at`（与 06 §4.1 一致）。`maybe_complete_job` 会在最后一个候选被忽略后把 job 置为 `completed/progress=100`。

---

## 11. O17 `POST /api/v1/projects/{project_id}/import-candidates/{candidate_id}/layout-confirm`

| case | 请求 | status | 结果 |
|---|---|---|---|
| O17-01 | `{"note":"已对照原页确认"}` | 200 | `layout_review_confirmed_at` 设置；`layout_review_note` 原样；`reviewed_at == layout_review_confirmed_at`；`revision` 1→1（**不 bump**）；`ContentRevision.action="layout_confirm"`、`reason=note`、`detail={"pages":[{"document_id":"{DOC_FIXTURE}","page_index":1}],"continues_on_pages":[]}` |
| O17-02a/02b | 先 PATCH 加 `continues_on_pages:[1,2]`，再 confirm | 200/200 | confirm 的 `detail.continues_on_pages=[1,2]`；`review_issues` 出现 `cross_page_question` warning（message：`该题跨页（第 1、2 页）：题干/选项在页面之间被自动接续，请对照原页确认没有漏字或缺行`，`pages:[1,2]`） |
| O17-03 | published 候选 | 400 | `invalid_input / 已发布的候选无需再确认版式` |
| O17-04 | 已 ignored 的 `{CAND_IGNORE}` | 200 | 仍 `status=ignored`、`revision=1`；`layout_review_note="忽略后确认版式"`（ignored 也允许确认） |
| O17-05/06 | 同 key 同 body 两次 | 200/200 | 响应逐字段相等；`ContentRevision` 行数仍 1 |

`layout-confirm` 不写 `CandidateRevision`，不 bump revision，不写 outbox；只写 1 行 `ContentRevision(layout_confirm)` 并更新 candidate 的 `layout_review_*` / `reviewed_*`。

---

## 12. Schema 与 query 校验

### 12.1 请求体（全部 400，除 P02/S06 外）

错误信封统一为 `{"error":{"code":"invalid_input","message":"请求参数校验失败","details":{"errors":[...]}}}`；每个 error item 的 key 只有 **`loc` / `msg` / `type`**（没有 `ctx`、没有 `input`）；envelope 没有 `request_id`。

| case | 端点 | body | 实测 errors |
|---|---|---|---|
| S01 | O07 | `{}` | `{"type":"missing","loc":["body","payload","text"],"msg":"Field required"}` |
| S02 | O07 | `{"text":123}` | `{"type":"string_type","loc":["body","payload","text"],"msg":"Input should be a valid string"}` |
| S03 | O07 | `{"text":"有效文本","title":123}` | `string_type`，`loc=["body","payload","title"]` |
| S04 | O07 | `{"text":"有效文本","parse":null}` | `{"type":"bool_type","loc":["body","payload","parse"],"msg":"Input should be a valid boolean"}` |
| S05 | O04 | `{"text":123}` | `string_type`，`loc=["body","payload","text"]` |
| P01 | O15 | `{"draft_payload":[]}` | `{"type":"dict_type","loc":["body","payload","draft_payload"],"msg":"Input should be a valid dictionary"}` |
| P03 | O15 | `{"expected_revision":3.7}` | `{"type":"int_from_float","loc":["body","payload","expected_revision"],"msg":"Input should be a valid integer, got a number with a fractional part"}` |
| P04 | O15 | `{"note":5}` | `string_type`，`loc=["body","payload","note"]` |
| S07 | O17 | `{"note":5}` | `string_type`，`loc=["body","payload","note"]` |

注意 `loc` 多了 **`"payload"`** 一层：真实是 `["body","payload","text"]`，不是 `["body","text"]`。06 §0.2 只写了“errors 数组”，08 B0 只写了“loc 以 body 开头”；Node 传输层必须保留这一层。

### 12.2 两个“不是 400”的强制转换

| case | 请求 | 实测 |
|---|---|---|
| S06 | `{"text":"<可解析的编号题>","parse":"false"}` | **201**；`candidate_count=0`，`problems=[no_recognised_segment]`。pydantic 把字符串 `"false"` 转成 `False`，不是类型错误。 |
| P02 | `{"expected_revision":"3"}`（候选 revision=2） | **409**；`version_conflict / 版本已过期，请重新加载`；`details={"actual":2,"expected":3}`（都成了 int）。pydantic 把 `"3"` 转成 int 后才做 revision 比较。 |

### 12.3 Query

| case | 端点 | limit | status | 实测 |
|---|---|---|---|---|
| Q01/Q02 | O03 | `abc` / `1.5` | 400 | `type=int_parsing`，`loc=["query","limit"]`，msg `Input should be a valid integer, unable to parse string as an integer` |
| Q03/Q04 | O10 | `abc` / `1.5` | 400 | 同上 |
| Q05/Q06 | O13 | `abc` / `1.5` | 400 | 同上 |

Query 的 `1.5` 是 **`int_parsing`**（字符串无法解析），而 body 的 `3.7` 是 **`int_from_float`**（数字有小数部分）；两者不能共用一个错误模板。

---

## 13. 行级效果汇总

| 操作 | 写行 |
|---|---|
| O03 / O10 / O11 / O13 | 只读；无 audit/outbox/idempotency |
| O04 | +1 `ingestion_source_document`；无 job/candidate/region/audit/outbox |
| O07 成功 | +1 document、+1 job、+2 region、+2 candidate（本例）；无 CandidateRevision/ContentRevision/outbox/exposure；+1 `audit_idempotency_record`（该 key） |
| O07 `parse=false` | +1 document、+1 job、0 region/candidate；`problems` 追加 `no_recognised_segment` |
| O07 21 段失败 | 事务内全部回滚，四表 delta 全为 0；400/422 后 claim 删除 |
| O07 重复输入 | 仍 +1 document/job/candidate；job 写 `duplicate_of` 与 `duplicate_input` problem |
| O12 重试 | job 的 `attempts/status/last_error/started_at` 更新，`finished_at` 保留；+1 idempotency；**0** ContentRevision、**0** outbox |
| O14 无链接 | 0 exposure、0 ContentRevision |
| O14 有链接 | +1 `practice_exposure_event`（`editorial_preview`），重复 GET 仍只 1 行 |
| O15 PATCH | +1 `ingestion_candidate_revision`、+1 `audit_content_revision(proofread)`；revision+1；无 idempotency |
| O15 linked 冲突 | PATCH 失败仍 +1 exposure（`ingestion.candidate_edit`）；revision 不变 |
| O16 ignore | +1 `audit_content_revision(ignore)`、+1 idempotency；无 CandidateRevision；`reviewed_at/revision` 不变；最后一个候选时 job → completed |
| O17 layout-confirm | +1 `audit_content_revision(layout_confirm)`、+1 idempotency；无 CandidateRevision；revision 不变 |

所有 observed case 的 `audit_outbox_event` 前后均为 0；本批没有 enqueue。

`CandidateRevision` 只在 O15 手工 PATCH 产生；`ContentRevision` 的 action 集合实测为 `proofread` / `ignore` / `layout_confirm`（O07/O12/O14 都不写）。`before_digest/after_digest` 在所有观察到的 ContentRevision 行中都是 `""`。

---

## 14. 与 06 规格的差异 / 易踩点

> 这里只列“实测与规格文字不一致或规格未写、但移植必须知道”的项；不重复已由规格正确描述的行为。

| # | 06 规格 | 实测 | 影响 |
|---|---|---|---|
| D1 | §0.2：Schema 错误 `{errors:[...]}` | `loc` 多一层 `"payload"`：`["body","payload","text"]` | Node 若只按 `body` + 字段名生成 loc，会全部对不上 |
| D2 | §0.2：错误信封 `{code,message,details,request_id?}` | 46 个错误响应全部只有 `code/message/details`；`request_id` 出现 0 次 | 不要为了“补 request_id”而改变响应；`attach_request_id` 在路由里未被调用（静态阅读） |
| D3 | §4.1：跨项目 subject → S「科目不属于该项目」 | HTTP 先走 `require_subject`，实际 404 `not_found / 科目不存在或不属于该项目` | service 内的「科目不属于该项目」在 HTTP 路径不可达；Node 应对齐实测消息 |
| D4 | §1 Document 字段顺序 | 实际 `subject_id` 第 3 位，`asset_id` 在 `checksum` 后 | 仅字段顺序不同；字段集合相同 |
| D5 | §1 Job 字段顺序 | 实际 `subject_id` 第 3 位，`progress_percent` 在 `problems` 前，`page_diagnostics` 在 `candidate_count` 前 | 同上 |
| D6 | §1 Candidate 字段 | 实际无 `created_at`；含 `publication_paper_item_id`、`parent_candidate_id`、`answer_match`、`layout_review_*`；顺序按 `CandidateOut` 声明 | O13 排序不能靠响应里的 `created_at`；只能按 DB/顺序本身 |
| D7 | §1 Region 不返回 `char_start/char_end` | 确认：`source_regions` 元素没有这两键；DB 行有（O07-01: 12/20 与 74/82） | 需要偏移时只能由 Node 自己保存/计算 |
| D8 | §3.6 O12「不清旧 finished_at」 | 确认保留；但状态已变 `awaiting_review`，出现 `finished_at < started_at` | 不能把 `finished_at != null` 当成“任务已结束”；Node 的状态判断应以 `status` 为准 |
| D9 | §3.3「segments 为空 → no_recognised_segment」 | 非空但无题号/标签的文本仍返回 **1 段**；`no_recognised_segment` 只在 `parse=false`（或解析器返回 []）出现 | 不要把“无题号”当成 0 候选；`parse=false` 是唯一可稳定触发的 HTTP 路径 |
| D10 | §1 O07 成功响应 | 201 重放仍返回 **201**（存的是原状态码），不是 200 | 重放状态码必须存/回放原值 |
| D11 | §3.6 exposure detail | detail 的 key 顺序是 JSONB 顺序，不是插入顺序 | 只比较 key 集合/值，不要依赖顺序 |
| D12 | §0.2 错误类 | 422 的 `details.errors` 是 **dict**（`{"width":[...]}`）；400 schema 的 `errors` 是 **list** | 两种形状不能归一化成同一个 `errors` 类型 |
| D13 | §0.2 Schema 校验 | `parse:"false"` 被强制转成 `False`（201，0 候选）；`expected_revision:"3"` 被转成 int 后返回 409（不是 400） | “错误类型 → 400”的直觉会错；Node 必须复刻 pydantic 的 lax 转换 |
| D14 | §1/O03 `limit` | `limit=0` / `-5` → 1；`100` / `101` 在 102 行项目上 → 100；`1.5` → 400 `int_parsing` | clamp 与 query 转换的行为要同时复刻 |
| D15 | §3.1 O04 截断 | `title[:300]`、`source_note[:500]`、`usage_scope[:200]`、preview `[:400]`；未知字段忽略 | 不能把客户端传入的 `document_type/role/sensitivity/source_type` 写进行 |
| D16 | §3.3 O07 duplicate | 第二次同样输入仍 **201 新建**，只加 `duplicate_input` warning；不阻断 | 不要实现成“复用第一个 job” |
| D17 | §4.1 O15 空 patch | revision+1、写 CandidateRevision 与 ContentRevision，即使 payload 没变 | “空 patch 无副作用”是错的 |
| D18 | §4.1 O16 ignore | 不 bump revision、不改 reviewed_at；`ContentRevision.action=ignore`、detail `{}`；reason 空格保留 | 与 PATCH 的 `proofread` 审计形状不同 |
| D19 | §4.1 O17 layout-confirm | ignored 也允许；不 bump revision；detail 含 `pages` 与 `continues_on_pages` | 不要把 ignored 当禁止态 |
| D20 | §3.3 Region 失败 | 21 段 → HTTP **422** `structure_invalid / 结构校验失败`，`details.errors={"width":["区域超出页面范围"]}`；事务回滚 | 这是 422 不是 400/409；Node 若返回 400 会与 Django 不同 |
| D21 | §0.2 `Idempotency-Key` | trim 后空 → 409「缺少…」；200 字符 key 通过、201 字符 key → 409「过长」；空文本 400 后 claim 删除，同 key 换 body 可 201 | 现有 Node `resource` 缺键 400 是已记录的差异，必须修 |
| D22 | §1 O07 `candidate_status_counts` | 由 set 推导，只含实际状态；空任务 `{}`；键顺序不保证 | 只比较映射内容；不要补零/排序断言 |
| D23 | §1 Job `document_ids` | 只列 `job.documents`；没有显式顺序承诺 | 不要假设上传顺序 |
| D24 | §3.6 O15 preview | 冲突 PATCH 仍写 1 行 exposure（先 preview 后 update） | 事务边界/顺序必须保留 |

---

## 15. 不能观测 / 未覆盖

1. **O18 发布**未运行（B2 范围）：O14/O15 的 `publication_question_id/version_id` 与 O15/O16/O17 的 `published` 状态均由 ORM 直接设置；没有真实 publish 写集/重复发布/材料父子链路。
2. **O12 的 failed 状态**由 ORM 设置；没有任何 HTTP 操作能造成 `failed`。只观测了 failed，未观测 `cancelled` 的重试。
3. **并发同 key 的 `in_flight` 409** 未观测：脚本串行，无法制造“claim 已插入但结果未记录”的窗口。
4. **created_at 并列**未观测：O03/O10/O13 的顺序结论只覆盖严格递增/递减时间戳。
5. **O14 去重的边界**只测了同一 `user+question+kind+detail.candidate_id` 的重复 GET；换 `source`、候选状态变化后的复用未单独实测。
6. **O17 note 的 500 截断**未测（O15 note 与 O16 reason 已测 501→500）。
7. **O01/O02/O05/O06/O08/O09/O18/O19/O20** 不属于 B1，未调用。
8. **multipart/PDF/图片/sharp** 未涉及；本批只走 JSON。
9. **`request_id` 的“为什么没有”**只做了响应观测（46 个错误全是 0 次）；静态阅读显示 `attach_request_id` 未被任何调用点触发，但本探针没有改代码验证。
10. **exposure/audit/CandidateRevision 的字段**只能从数据库行读取；HTTP 响应不含这些对象，因此 O14/O17 的 detail 是 DB 侧观测。

---

## 16. 复现与产物

```bash
cd dsh-plugin
../backend/.venv/bin/python scripts/probe_ingestion_b1.py
```

- 脚本会打印每个 case 的 `id / status / op / title`，末行给出 `114 cases (111 operational + 3 setup)`。
- 证据 JSON 的 `cases[]` 每项含 `request`（method/path/query/body/idempotency_key）、`status`、`response`（大列表只存 count + first/last）、`response_field_order`、`checks`（行级事实）。
- `symbols` 把真实 UUID 映射到符号名；报告只使用符号名。
- `notes` / `unobserved` 是脚本自己的边界声明。
