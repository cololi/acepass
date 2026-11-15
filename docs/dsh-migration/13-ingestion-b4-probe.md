# 13 ingestion B4 探针：O09 PDF 批量导入与 O17 版式确认（Django 实测）

日期：2026-11-06。目标：在移植之前，用**真实 Django + 真实 PostgreSQL** 记录 PDF 批量导入（O09）与
版式确认门禁（O17）的状态码、错误信封、响应形状、逐页事实与行级副作用。本文所有数字与正文都来自同目录的
[13-ingestion-b4-probe.json](./13-ingestion-b4-probe.json)（由 `dsh-plugin/scripts/probe_ingestion_b4.py`
生成，40 个请求、26 个用例组，一次性测试库，跑完即销毁），不来自规格文档的推测。

覆盖：O09 `POST /api/v1/projects/{project_id}/imports/pdf`、O17
`POST /api/v1/projects/{project_id}/import-candidates/{id}/layout-confirm`。为了让「版式未确认不能发布」
成为可观测事实，另驱动了 O15 `PATCH .../import-candidates/{id}`（3 次）与 O18 `POST .../publish`（4 次）
作为前置。请求分布：O09 = 32、O15 = 3、O17 = 1、O18 = 4。用例编号 P01–P40，分属 C01–C26。

## 0. 结论（先看这九条）

1. **PDF 校验失败一律 400 `invalid_input`，不是 422。** 任务清单里写成 422 的八处（缺 cycle_key、非法
   source_kind、MIME、not_pdf、damaged、encrypted、no_text_layer、too_many_pages）在真实路由上全部是
   **400**（P07–P13、P15、P20、P40）；422 只出现在「发布被 blocking 候选问题阻断」的两例（P29、P37），
   且 code 是 `structure_invalid`。06 规格 §5.2 的 `I=`（InvalidInput→400）与实测一致，是任务清单写错了。
2. **校验顺序**：项目作用域 → 科目作用域 → `files` 非空 → `source_kind` 枚举 → 读入 bytes →
   official_past 且 `cycle_key.strip()` 为空 → （claim）→ 服务层逐份 MIME → 空/超限/`%PDF-` 头/解析/
   加密/页数/文本量。前缀这一段是实测的：P24/P39 先 404，P09 是 Ninja 必填校验（还没进视图），P07 在
   任何文件校验之前命中 cycle 文案；**服务层内部的先后（MIME 先于字节/解析）来自代码与 06 §5.2，本批每个
   用例只触发一个条件，没有一次请求同时命中两个条件的观测**（见 §5）。
3. **幂等 scope 是 `imports.create_pdf:{project_id}`，指纹只含 PDF 身份字段**：`checksums`（`files` 在前、
   `answer_files` 在后，原始字节 sha256）+ `subject_id`/`cycle_key`/`session_key`/`paper_code`/`source_kind`。
   同键同 body 重放返回**存储体原样**、同一 job、零新行（P22：`replay_body_equals_first=true`、
   `same_job=true`、`row_delta={}`）；同键不同文件 409 `idempotency_conflict`
   `details={route_scope,reason:"same_key_different_payload"}`（P23）；校验失败**不留幂等行**
   （P10 的 `idempotency_record=null`，行增量全 0）。
4. **`answer_match` 的三个 provenance 字段实测全为 `null`**（`document_id`、`document_title`、
   `source_page_index`；P03 四个候选全如此），因为 `apply_answer_matches` 的 success dict 不带 entry 的
   页/文档信息。**`answers_matched` 的 severity 由「有没有按顺序匹配」决定**：`position_matched==0` → `info`
   （P03：matched=4、position=0），`>0` → `warning`（P38：matched=1、position=1）。
5. **`page_diagnostics` 每行 12 键，且含 `document_title`**：`page_index / is_scanned / columns /
   has_table_grid / has_formula_tokens / reading_order_reliable / fragment_count / character_count /
   reasons / needs_review / document_id / document_title`。它在**建候选之前**落库，所以 P29 的 422
   `details.problems` 能直接引用它（`document_id` 已符号化）。
6. **版式确认只清当前候选**：P29 未确认发布 → 422，`details.problems` 是
   `multi_column_needs_review`（blocking，带 `pages[{document_id,page_index,reason}]`、`page_indexes`、
   `reasons`）；P30 `layout-confirm`（带 Idempotency-Key）→ 200，该候选 `review_issues=[]`、`status=ready`、
   `layout_review_confirmed_at=<now>`、`layout_review_note` 原样；同批第二个候选仍是
   `answer_unknown + multi_column_needs_review`。P31 再发布 → 200。**确认后 issue 确实消失，且只消失这一个**。
7. **重复导入是三层，不是一个标志**：同一份字节第二次导入会 ①新建 job 并写 `duplicate_input`
   （`job.duplicate_of` 指向首个 job，P06/P35）②复用来源文档（`duplicate_source_file`，
   `document_ids=["DOCUMENT_P05"]`，asset/document 零增量）③**仍然重新解析**并新建候选与 region
   （P06：job/candidate/region 各 +1）。存在 paper 身份时每次导入都新建一份 draft revision
   （P35 `revision_count=2`，两条都 `draft`、`effective_revision` 为空），第一轮已发布的题号在第二轮被
   `duplicate_paper_position` 阻断（P37 → 422）。
8. **扫描页不阻断同文档的干净页**：P16 混合文档只有 1 个候选，它唯一的 issue 是 `answer_unknown`（没有
   `page_without_text_layer_needs_manual_entry`）；扫描页的事实只出现在 job problems 与 page_diagnostics 里。
   换句话说，**扫描页上根本不会产生候选**，那条 blocking issue 是「如果有候选落在该页」时才会出现（本批
   无法通过 HTTP 造出这种候选，见 §5）。
9. **发布后候选会追加指向自身的 `duplicate_published` / `duplicate_label`**（P31、P34：两条 warning 的
   `question_id` 就是刚发布的题）。另外 publish 的 **HTTP 响应体没有 `question_id`**（`CandidateOut` 未声明
   该键），发布产生的 question/version/paper_item 只能从行里读（P31/P34 的 `response_field_order` 可证）。

## 1. 环境与方法

**运行方式**（从 `dsh-plugin/` 目录）：

```bash
cd dsh-plugin
../backend/.venv/bin/python scripts/probe_ingestion_b4.py
# → docs/dsh-migration/13-ingestion-b4-probe.json，末尾打印 sha256
```

- Python 3.12（`backend/.venv`）、Django 5.2.17、pypdf 5.1.0、django-ninja、PostgreSQL 16
  （127.0.0.1:5432）。设置模块 `config.settings.test`。
- **隔离**：建库前把 `connection.settings_dict["TEST"]["NAME"]` 固定为 `test_acepass_b4_probe`；建库后把
  `PRIVATE_MEDIA_ROOT` 指到 `/tmp/acepass-b4-probe-media`（先 rmtree 再 mkdir）并 `reset_storage_cache()`。
  跑完 `destroy_test_db`，退出码 0。
- **真实 multipart**：全部走 `django.test.Client` 的真 multipart 通道（`SimpleUploadedFile` + 字段字典，
  多文件用同名列表 `files` / `answer_files`），没有手工拼 multipart 字节。
- **PDF 夹具**全部由 `backend/tests/support/pdf_builder.py` 现场生成：
  `build_text_pdf`（每行一个 `Tj`，`T*` 换行）、`build_layout_pdf`（每个片段显式 `1 0 0 1 x y Tm`）、
  `build_scanned_pdf`（`None` 页是整页 `/Image`、无任何文字操作符）。两份加密夹具用
  `PdfWriter.encrypt(user_password=…, owner_password="acepass-b4-owner", algorithm="RC4-128")` 生成，
  0 页夹具用 `PdfWriter()` 直接写出。**27 份夹具的字节数与 sha256 记在 JSON 的
  `fixtures.pdf_fixtures`**，两次运行逐字节相同（含加密件：pypdf 的文件密钥由文档 id 派生，不引入随机量）。
- **记录**：`request{method,path,form,json_body,idempotency_key}`（form 里文件只记文件名/声明 MIME/字节数/
  sha256）、`status`、`response`、`response_field_order`、`response_headers`（只取 Content-Type、
  Content-Disposition、X-Content-Type-Options、Cache-Control）、`checks`（行级 delta、job、documents、
  `fixture_pages` 逐页事实含页文本原文、`page_diagnostics` 行原样、candidates、paper/revisions/
  paper_items、幂等行）。
- **规范化**：所有 UUID 换成符号名（`JOB_P01`、`DOCUMENT_P01`、`ASSET_OF_DOCUMENT_P01`、`CANDIDATE_P27_1`、
  `REGION_…`、`PAPER_P02`、`REVISION_P02_1`、`QUESTION_P34`、`VERSION_P34`、`PAPER_ITEM_P34`、
  `ANSWER_KEY_P34`…，跨用例复用的文档保留**首个**符号，例如 P06 的 `DOCUMENT_P05`）；所有时间戳换成
  `"<now>"`；`object_key` 只记形状（段数 / namespace / 前缀长度 / token 长度 / 后缀）。最终 JSON 里
  **没有残留 `REF_nnn`**（发布产生的 id 在 P31/P34 从行读回后命名）。
- **可重复性**：同一脚本连续两次运行的 `shasum -a 256` 都是
  `f2a40e35ac860ada692dbd0f128f243318b80babbfebe9fcf38b64ba9e5e662c`。

## 2. 逐例结果

### 2.1 O09 成功路径（C01–C05，6 个请求）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P01 | 两页两题、`practice_set`、带 subject | 201 | job：`input_kind=pdf_text`、`extractor_version=pdf-text-v2`、`status=awaiting_review`、`progress_percent=0`、problems=[]；document：`document_type=pdf`、`role=past_paper_page`、`sensitivity=public_to_owner`、`page_count=2`、`page_texts` 长度 45/45、`raw_text = "\n".join(pages)`；delta：asset/document/job/幂等各 1、candidate 2、region 3（第一个候选跨了两页，见 §4.5）；候选 `1`/`2` 唯一 issue `answer_unknown`；幂等行 `route_scope=imports.create_pdf:PROJECT_A`、`resource_type=import_job`、`status_code=201` |
| P02 | `official_past` + cycle_key/paper_code/session_key + `expected_session_count=4` | 201 | 新建 Paper（`source_kind=official_past`、`is_demo=false`、`effective_revision=null`、`revision_count=1`）与 draft PaperRevision（`revision=1`、`expected_session_count=4`、`covered_session_count=1`、`coverage_confirmed_by/at=null`、`status=draft`、`coverage_status=coverage_incomplete`、`note="由原生文字 PDF 导入创建（导入任务 JOB_P02）"`）；delta 另有 `audit_content_revision=2`（paper/create + paper_revision/create）；候选带 blocking `paper_item_score_missing` |
| P03 | 两份 paper + 一份答案 PDF | 201 | 3 份 document（2 份 `pdf/past_paper_page/public_to_owner` + 1 份 `pdf_answer/answer_page/contains_answers`，标题自动加「（答案）」后缀）；4 个候选全部 `method=label` 命中；problem `answers_matched`：matched=4、position_matched=0、severity=`info`、unmatched_labels=`["6"]`；每个命中候选多一条 blocking `answer_match_pending_confirmation` |
| P04 | 同一请求内两份相同字节 | 201 | 只有 1 份 document/asset（第二份在同一事务内命中复用）；候选 2 个，位置键 `1` 与 `1#2`；problem `duplicate_source_file`（「其中 1 份…」）；`page_diagnostics` 出现两行同页同文档；第二个候选额外 `duplicate_candidate` warning |
| P05 | 历史重复①：先导一次 | 201 | problems=[] |
| P06 | 历史重复②：再导同一份字节 | 201 | asset/document **零增量**（`document_ids=["DOCUMENT_P05"]`，复用 P05 的文档且不覆盖其标题/角色/科目）；job `duplicate_of=JOB_P05`，problems 依次 `duplicate_input` → `duplicate_source_file`；仍新建 job/candidate/region 各 1 |

### 2.2 O09 请求与文件校验（C06–C14，9 个请求）

| # | 用例 | 状态 | 响应 `error` |
|---|---|---|---|
| P07 | official_past 缺 cycle_key | 400 | `invalid_input`／真实考试试卷必须填写年份/周期与卷别代码，否则无法进入历年统计／`{}` |
| P08 | 非法 source_kind | 400 | `invalid_input`／试卷来源类型无效／`{source_kind:"bogus_kind"}` |
| P09 | 缺 files 字段 | 400 | `invalid_input`／请求参数校验失败／`{errors:[{loc:["file","files"],msg:"Field required",type:"missing"}]}` |
| P10 | PDF 字节声明 `content_type=text/plain` | 400 | `invalid_input`／仅支持 PDF 文件（原生文字版）／`{content_type:"text/plain",filename:"b4-mime.pdf"}` |
| P11 | 无 `%PDF-` 头的字节 | 400 | `invalid_input`／文件不是 PDF（缺少 %PDF- 头）／`{reason:"not_pdf"}` |
| P12 | 损坏 PDF（`%PDF-1.7` + 垃圾） | 400 | `invalid_input`／PDF 结构损坏，无法解析／`{reason:"damaged"}` |
| P13 | 加密（用户密码 `secret`） | 400 | `invalid_input`／PDF 已加密，请先提供未加密版本（本功能不支持解密）／`{reason:"encrypted"}` |
| P14 | 加密但**空用户密码** | 201 | 被当作「无密码文档」解锁后照常导入：`page_texts=[48]`、1 个候选、0 problem |
| P15 | 纯扫描件（`build_scanned_pdf([None])`） | 400 | `invalid_input`／未从该 PDF 中提取到文字层：它可能是扫描件/图片版。原生文字 PDF 才能自动结构化；扫描件请走图片导入的人工校对路径。／`{reason:"no_text_layer",pages:1,empty_pages:[1]}` |

### 2.3 页数边界（C19）

| # | 用例 | 状态 | 响应 `error` |
|---|---|---|---|
| P20 | 201 页 PDF | 400 | `invalid_input`／PDF 页数 201 超过上限 200，请拆分后分批导入／`{reason:"too_many_pages",pages:201}` |
| P40 | 0 页 PDF（`PdfWriter()` 直接写出，311 字节，`%PDF-1.3`） | 400 | `invalid_input`／PDF 没有任何页面／`{reason:"no_pages"}` |

### 2.4 版式、答案与结构（C15–C18、C22–C23）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P16 | 扫描页 + 原生页混合 | 201 | 2 页：p1 45 字/5 片段/`reliable`；p2 0 字/0 片段/`is_scanned=true`、`reasons=["page_without_text_layer"]`、`needs_review=true`；候选只有 1 个（在 p1），issue 只有 `answer_unknown`，**没有**扫描页的 blocking issue；job problems 依次 `pdf_pages_without_text`（pages 里是 `{document_id,pages:[2],title}`）、`page_without_text_layer_needs_manual_entry`（pages 里是 p2 的整行诊断） |
| P17 | 双栏 8 题（LEFT_X=60/RIGHT_X=330/TOP_Y=800/step=30，内容流按行交错） | 201 | 1 页 359 字/40 片段/`columns=2`/`reading_order_reliable=true`/`reasons=["multi_column_layout"]`/`needs_review=true`；**页文本是栏序**：左栏 1–4 全部在前、右栏 5–8 在后（与内容流的行交错相反）；候选位置键 `1`…`8` 与栏序一致；每个候选 `multi_column_needs_review`（blocking，`page_indexes=[1]`）；job problem 同名 `warning` |
| P18 | 表格 + 公式 | 201 | 1 页 205 字/23 片段/`has_table_grid=true`、`has_formula_tokens=true`、`reasons=["table_grid_detected","formula_tokens_detected"]`；3 个候选（`1`、`一`=材料父、`2`）；公式逐字保留（`\frac{1}{2}x^{2}+\sqrt{3}`、`∫_0^1 f(x)dx`）；每个候选 `table_or_formula_needs_review`（blocking，`page_indexes=[1,1]` 因为两条 reason 映射到同一 code）；材料候选另有 `material_without_children` |
| P19 | 跨页题 | 201 | 2 页（p1 40 字/2 片段、p2 89 字/9 片段）；候选 2 个：`1` 的 `continues_on_pages=[1,2]`、两个 region（p1 char 14–40、p2 char 41–102）、issue `cross_page_question`（warning，pages=[1,2]）；`2` 只在 p2、无跨页 issue |
| P25 | 答案 PDF 有条目但匹配不到 | 201 | 1 个候选；job problem 只有 `answers_not_matched`（warning），没有 `answers_matched` |
| P26 | 文字层存在但无题目结构 | 201 | **0 个候选**、job `candidate_count=0`、`status=awaiting_review`、problem `no_recognised_segment`；delta 只有 asset/document/job/幂等各 1，没有 candidate/region |

### 2.5 幂等与作用域（C20–C21）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P21 | 同键同 body 第一次 | 201 | 写 1 条幂等行（`resource_type=import_job`） |
| P22 | 同键同 body 重放 | 201 | 响应体与 P21 逐字节相同（`replay_body_equals_first=true`）、同一 job（`same_job=true`）、`row_delta={}` |
| P23 | 同键不同 body（换了一份 PDF） | 409 | `idempotency_conflict`／相同幂等键使用了不同请求内容／`{route_scope:"imports.create_pdf:PROJECT_A",reason:"same_key_different_payload"}`；零写入 |
| P24 | subject 属于其他项目 | 404 | `not_found`／科目不存在或不属于该项目／`{}` |
| P39 | project 属于其他用户 | 404 | `not_found`／项目不存在或无权访问／`{}` |

### 2.6 O17 版式确认（C24，5 个请求）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P27 | 双栏 8 题导入（版式确认夹具） | 201 | 8 个候选，全部 `answer_unknown + multi_column_needs_review`；`page_diagnostics` 1 行 `columns=2` |
| P28 | O15：补齐答案与分值 | 200 | `revision` 1→2，`status` 仍 `draft` |
| P29 | O18：未确认版式就发布 | 422 | `structure_invalid`／候选仍有未解决的问题，不能发布／`details.problems[0]` 原文见 §3.8；零写入 |
| P30 | O17：`layout-confirm`（带 Idempotency-Key） | 200 | `review_issues=[]`、`status=ready`、`layout_review_confirmed_at=<now>`、`layout_review_note` 原样；幂等行 `route_scope=candidates.layout_confirm:CANDIDATE_P27_1`；delta：`audit_content_revision=1` + 幂等 1；**同批第二个候选仍 `answer_unknown`+`multi_column_needs_review`** |
| P31 | O18：确认后再发布 | 200 | 发布成功（Question/Version 各 1，非试卷候选不写 PaperItem）；响应体 22 键、**没有 `question_id`**；DB 候选 `status=published`，并追加自指的 `duplicate_published`/`duplicate_label` |

### 2.7 重复导入与 paper 位置（C25–C26，7 个请求）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P32 | 第一轮导入 `official_past` 2030/上半年/甲卷 | 201 | 新建 Paper + Revision(1)；候选带 `answer_unknown`、`paper_item_score_missing`（`duplicate_label` 是因为前面 P31 已发布过题号 `1`） |
| P33 | 第一轮候选补齐分值/答案 | 200 | `revision` 2 |
| P34 | 第一轮发布 | 200 | 写 PaperItem（`position_key=1`、`max_score="2.00"`、`is_scored=true`）、AnswerKeyVersion、Question/Version、outbox 1；DB 候选 `status=published` |
| P35 | 第二轮导入**同一份字节**（同一 paper 身份） | 201 | problems 依次 `duplicate_input`（`duplicate_job_id=JOB_P32`）→ `duplicate_paper_positions`（count 1）→ `duplicate_source_file`；asset/document 零增量；**新建 Revision 2**（`status=draft`、`item_count=0`）；候选在导入时就带 `duplicate_paper_position` blocking |
| P36 | 第二轮候选补齐分值/答案 | 200 | `revision` 2，其余不变 |
| P37 | 第二轮发布 | 422 | `structure_invalid`／候选仍有未解决的问题，不能发布／`details.problems=[duplicate_paper_position]`（原文见 §3.8）；零写入；Paper 仍 `effective_revision=null`、`revision_count=2` |
| P38 | 答案题号与卷面题号不一致（顺序匹配） | 201 | `answers_matched`：matched=1、position_matched=1、severity=`warning`、unmatched_labels=`["9"]`；候选 `answer_match.method=position`、`answer_match_pending_confirmation` blocking |

## 3. 实测钉住的事实

### 3.1 校验顺序

按观测到的先后（括号里是取证的用例）：

1. 项目作用域 —— `require_project` → 404「项目不存在或无权访问」（P39）；
2. 科目作用域 —— `require_subject` → 404「科目不存在或不属于该项目」（P24）；
3. `files` 非空 —— 必填字段缺失时 Ninja 先返回 400「请求参数校验失败」（P09，`loc=["file","files"]`）；
   缺字段这一形态下，视图内的「请至少上传一份试卷 PDF」**在 HTTP 上不可达**（本批只测了缺字段，
   `files=[]` 空列表这一形态没有单独取证）；
4. `source_kind` 枚举 → 400「试卷来源类型无效」`{source_kind}`（P08）；
5. 读入 paper/answer 的 bytes（此时还不做 MIME 检查）；
6. official_past 且 `cycle_key.strip()` 为空 → 400（P07）；
7. 幂等 claim（scope `imports.create_pdf:{project_id}`）—— 这一步的位置来自代码；本批只能观测到
   「4xx 之后没有幂等行」，无法区分「没写」与「写了再 release」；
8. 服务层逐份校验：MIME → 空文件 → 40 MiB → `%PDF-` → 解析 → 加密 → 页数 → 文本量
   （P10–P13、P15、P20、P40 各自命中其中一条；这一步内部的先后来自 `pdf_text._open_reader` 与
   `extract_native_text` 的代码顺序，本批没有一次请求同时命中两条）。

失败请求的可观测结论是：**HTTP 层返回 4xx 之后不留幂等行**（P10 的 `idempotency_record=null`；
P07/P23 的行增量里都没有 `audit_idempotency_record`）。claim 是否曾经写入再被中间件 release 掉，
这一层本批区分不出来（两种实现的外部表现相同）。

### 3.2 错误文案原文（含 422）

| 场景 | 状态 | code | message |
|---|---|---|---|
| 缺 cycle_key | 400 | invalid_input | 真实考试试卷必须填写年份/周期与卷别代码，否则无法进入历年统计 |
| 非法 source_kind | 400 | invalid_input | 试卷来源类型无效 |
| 缺 files | 400 | invalid_input | 请求参数校验失败 |
| MIME | 400 | invalid_input | 仅支持 PDF 文件（原生文字版） |
| 无 `%PDF-` | 400 | invalid_input | 文件不是 PDF（缺少 %PDF- 头） |
| 结构损坏 | 400 | invalid_input | PDF 结构损坏，无法解析 |
| 加密 | 400 | invalid_input | PDF 已加密，请先提供未加密版本（本功能不支持解密） |
| 0 页 | 400 | invalid_input | PDF 没有任何页面 |
| 201 页 | 400 | invalid_input | PDF 页数 201 超过上限 200，请拆分后分批导入 |
| 无文字层 | 400 | invalid_input | 未从该 PDF 中提取到文字层：它可能是扫描件/图片版。原生文字 PDF 才能自动结构化；扫描件请走图片导入的人工校对路径。 |
| 幂等冲突 | 409 | idempotency_conflict | 相同幂等键使用了不同请求内容 |
| 发布被阻断 | 422 | structure_invalid | 候选仍有未解决的问题，不能发布 |

### 3.3 幂等

- **scope**：`imports.create_pdf:{project_id}`（P01 的幂等行、P23 的 `details.route_scope`）；
  O17 的 scope 是 `candidates.layout_confirm:{candidate_id}`（P30）。
- **指纹**（代码 + 实测一致）：`checksums`（`[*paper_uploads, *answer_uploads]` 的原始字节 sha256）、
  `subject_id`、`cycle_key`、`session_key`、`paper_code`、`source_kind`。`title`/`source_note`/
  `usage_scope`/`expected_session_count`/文件名/MIME **不在**指纹里（P22 是同一份 body 重放；
  「只改 title 仍 replay」本批没有单独取证，见 §5）。
- **重放**返回存储的 job summary，连 `created_at` 都是首轮那个（被规范化为 `<now>`），零写入（P22）。
- **冲突**只比较指纹，不看 job 是否存在（P23）；失败请求不写幂等行（P10）。

### 3.4 候选 issue 的顺序与条件

`refresh_candidate_issues` 里本批**同时出现过**的 code，其相对顺序在实测里可见（P35 的候选在导入时）：

```
answer_unknown → paper_item_score_missing → duplicate_paper_position
→ duplicate_candidate → duplicate_published → duplicate_label
```

- P35：`["answer_unknown","paper_item_score_missing","duplicate_paper_position","duplicate_candidate","duplicate_published","duplicate_label"]`。
- P29（多栏、无试卷身份）：只有 `multi_column_needs_review`。
- P16（混合扫描）：只有 `answer_unknown` —— 扫描页不落到干净页的候选上。
- 版式类 issue 在 `layout_review_confirmed_at` 为空时才追加；`answer_unknown` / `duplicate_*` / 分值
  缺失**不会**被版式确认清掉（P30 的 `review_issues` 变空，是因为 P28 已经补齐了答案与分值）。
- 上表没有列出的 code（`subject_missing`、`no_source_region`、`cross_page_question` 等）在同一批候选上
  没有与上述 code 同时出现，因此它们的相对位置来自代码，不是本批的观测。

`table_or_formula_needs_review` 的 `page_indexes` 是 `[1,1]`（`table_grid_detected` 与
`formula_tokens_detected` 在同一页各产生一条），`reasons` 是排序去重的
`["formula_tokens_detected","table_grid_detected"]`（P18）。

### 3.5 page_diagnostics 形状与逐页事实

每行（P17 原文，`document_id` 已符号化）：

```json
{"page_index": 1, "is_scanned": false, "columns": 2, "has_table_grid": false,
 "has_formula_tokens": false, "reading_order_reliable": true, "fragment_count": 40,
 "character_count": 359, "reasons": ["multi_column_layout"], "needs_review": true,
 "document_id": "DOCUMENT_P17", "document_title": "B4 双栏材料"}
```

- `page_diagnostics` 覆盖 **job 的全部文档**（P03 有 3 行：两份试卷 + 一份答案），answer 文档也在内。
- 混合文档里扫描页的整行诊断会被原样塞进 job problem 的 `pages[0]`（P16），所以同一个形状在
  problem 里也能看到。
- 逐页事实（JSON 的 `checks.fixture_pages`，含每页 `text` 原文）：

| 用例 | 文档 | 页 | 字符/片段 | columns | table/formula | scanned | reliable | reasons | needs_review |
|---|---|---|---|---|---|---|---|---|---|
| P01 | DOCUMENT_P01 | 1 / 2 | 45/5 · 45/5 | 1 · 1 | – | 否 | 是 | `[]` | 否 |
| P02 | DOCUMENT_P02 | 1 | 46/5 | 1 | – | 否 | 是 | `[]` | 否 |
| P03 | DOCUMENT_P03_1/2 | 1 | 89/10 · 89/10 | 1 | – | 否 | 是 | `[]` | 否 |
| P03 | DOCUMENT_P03_3（答案） | 1 | 29/6 | 1 | – | 否 | 是 | `[]` | 否 |
| P04 | DOCUMENT_P04 | 1（诊断出现两行） | 46/5 | 1 | – | 否 | 是 | `[]` | 否 |
| P14 | DOCUMENT_P14 | 1 | 48/5 | 1 | – | 否 | 是 | `[]` | 否 |
| P16 | DOCUMENT_P16 | 1 / 2 | 45/5 · 0/0 | 1 · 1 | – | 否 / **是** | 是 / **否** | `[]` / `["page_without_text_layer"]` | 否 / **是** |
| P17 | DOCUMENT_P17 | 1 | 359/40 | **2** | – | 否 | 是 | `["multi_column_layout"]` | **是** |
| P18 | DOCUMENT_P18 | 1 | 205/23 | 1 | **是 / 是** | 否 | 是 | `["table_grid_detected","formula_tokens_detected"]` | **是** |
| P19 | DOCUMENT_P19 | 1 / 2 | 40/2 · 89/9 | 1 · 1 | – | 否 | 是 | `[]` | 否 |
| P25 | DOCUMENT_P25_1/2 | 1 | 45/5 · 13/2 | 1 | – | 否 | 是 | `[]` | 否 |
| P26 | DOCUMENT_P26 | 1 | 21/2 | 1 | – | 否 | 是 | `[]` | 否 |
| P27 | DOCUMENT_P27 | 1 | 367/40 | **2** | – | 否 | 是 | `["multi_column_layout"]` | **是** |
| P38 | DOCUMENT_P38_1/2 | 1 | 43/5 · 9/2 | 1 | – | 否 | 是 | `[]` | 否 |

### 3.6 答案匹配

- `answer_match` 的写入形状（P03）：`{"matched":true,"method":"label","label":"1","raw":"A",
  "source_page_index":null,"document_id":null,"document_title":null}` —— **三个 provenance 字段都是 null**。
- `answer_match_pending_confirmation` 的原文：`答案由答案页匹配产生（方式：题号，原文：A），请核对后确认`，
  severity=blocking，额外字段 `method`、`source_page_index`（null）。
- `answers_matched` 的额外字段：`matched`、`position_matched`、`unmatched_labels`；
  severity = `info` iff `position_matched == 0`，否则 `warning`（P03 vs P38）。
- `unmatched_labels` 是「答案条目的 label 不在**任何** segment 的 display_label 里」：P03 的 `["6"]`
  （答案页多出的题号 6），P38 的 `["9"]`（卷面题号是 1）。
- 匹配失败但条目存在 → `answers_not_matched`（P25）；条目值「以上都不对」无法解析成选项，所以 matched=0。
- 每个 paper 对**全部**答案重新匹配，消费集合只在一次 `apply_answer_matches` 调用内有效（P03 两份
  paper 各自按 label 命中 2 条）。

### 3.7 paper / revision 语义

- Paper 按自然键 `(subject, cycle_key, session_key, paper_code)` get/create；`source_kind`/`title` 只在
  新建时写入（P02 建、P35 复用同一条 `PAPER_P35`）。
- **每次导入都新建一份 draft revision**：P35 的 `revision_count=2`，两条都 `status=draft`、
  `coverage_confirmed_by/at=null`、`effective_revision=null`。
- `expected_session_count` 原样保存；`covered_session_count = len(paper_files) if expected_session_count else null`
  （P02：expected 4 / covered 1 → `coverage_status=coverage_incomplete`；P32：1/1 但**未确认**，
  仍是 `coverage_incomplete`）。
- `note` 固定为 `由原生文字 PDF 导入创建（导入任务 {job.id}）`（job id 已符号化）。
- 发布才写 PaperItem（P34：`position_key=1`、`max_score="2.00"`、`is_scored=true`、`answer_key_version`
  非空），导入本身不写（O09 的 delta 里没有 `exams_paper_item`）。

### 3.8 发布与版式确认

- 未确认发布（P29）：

```json
{"code":"structure_invalid","message":"候选仍有未解决的问题，不能发布",
 "details":{"problems":[{"code":"multi_column_needs_review","severity":"blocking",
   "message":"该题来自多栏页面：多栏的阅读顺序无法完全确定，请对照原页确认题干、选项的先后顺序后再发布",
   "pages":[{"document_id":"DOCUMENT_P27","page_index":1,"reason":"multi_column_layout"}],
   "page_indexes":[1],"reasons":["multi_column_layout"]}]}}
```

- 版式确认（P30）：`review_issues` 从 `[multi_column_needs_review]` 变 `[]`，`status` 从 `draft` 变
  `ready`，`layout_review_confirmed_at` 有值，`layout_review_note` 原样保存；`audit_content_revision` +1
  （`layout_confirm`）；幂等 scope 是 `candidates.layout_confirm:CANDIDATE_P27_1`。
- 确认**只影响当前候选**：P30 之后同 job 的第二个候选仍是
  `["answer_unknown","multi_column_needs_review"]`。
- 再发布（P31）200；响应是 `CandidateOut` 的 22 个键（`id/job_id/…/layout_review_note/updated_at`），
  **没有 `question_id`**；DB 里 `publication_question_id`/`publication_version_id` 有值。
- 重复导入的发布阻断（P37）：

```json
{"code":"structure_invalid","message":"候选仍有未解决的问题，不能发布",
 "details":{"problems":[{"code":"duplicate_paper_position","severity":"blocking",
   "message":"该试卷的题号 1 已发布过版本；重复导入不能再次发布（如需修订请在题库中创建新版本）",
   "question_id":"QUESTION_P34","question_version_id":"VERSION_P34"}]}}
```

### 3.9 行增量（只看有变化的表）

| 用例 | delta |
|---|---|
| P01 | asset 1、document 1、job 1、candidate 2、region 3、幂等 1 |
| P03 | asset 3、document 3、job 1、candidate 4、region 4、幂等 1 |
| P04 | asset 1、document 1、job 1、candidate 2、region 2、幂等 1 |
| P06 | job 1、candidate 1、region 1、幂等 1（asset/document **0**） |
| P16 | asset 1、document 1、job 1、candidate 1、region 1、幂等 1 |
| P19 | asset 1、document 1、job 1、candidate 2、region 3、幂等 1 |
| P22 | `{}`（重放零写入） |
| P23 | `{}`（409 零写入） |
| P28 | content_revision 1（revision 1→2） |
| P29 | `{}`（422 零写入） |
| P30 | content_revision 1、幂等 1 |
| P31 | content_revision 3、question 1、question_version 1、answer_key_version 1、幂等 1 |
| P34 | content_revision 4、paper_item 1、question 1、question_version 1、answer_key_version 1、outbox 1、幂等 1 |
| P35 | job 1、candidate 1、region 1、paper_revision 1、content_revision 1、幂等 1（asset/document **0**） |
| P37 | `{}`（422 零写入） |

所有成功导入（201）的 delta 里都**没有** `audit_outbox_event`、`audit_llm_run` —— O09 全程不排队、不调模型。

## 4. 与代码注释 / 06 规格不一致之处

1. **任务清单把 PDF 校验错误写成 422，实测全是 400。** 06 规格 §5.2 的 `I=` 映射（InvalidInput→400）才是
   对的；422 只有 `structure_invalid`（发布被阻断、Django 模型校验失败）会用。
2. **`pdf_pages_without_text` 的页号是列表字面量**：P16 的原文是
   `…需要人工补齐：B4 扫描页混排 第 [2] 页`（`"; ".join(f"{title} 第 {pages} 页")` 直接把 list 格式化进
   字符串），同一 job 里的 `page_without_text_layer_needs_manual_entry` 却是 `第 2 页`（走 `_page_labels`）。
   两条 problem 的页号写法不一致。
3. **`answer_match` 的三个 provenance 字段就是 null**（06 §3.5 已指出「可能全 null」，实测确认）：匹配成功
   的候选无法从 `answer_match` 找回答案页的 document/page，只能靠 `draft_payload.parse_issues` 的中文提示。
4. **发布后候选追加自指的 `duplicate_published` / `duplicate_label`**（P31/P34）：这两条 warning 的
   `question_id` 就是刚刚发布的那道题。规格只描述了「题库里已有相同内容」的语义，没有写「发布自身也会命中」。
5. **一个候选可以有多个跨页 region，且续页 span 会包含下一题的行首**：P01 的两页两题里，第 1 题在第 2 页
   也有一条 region（`char_start=46, char_end=60`，`text_span="2．【题型】单选题\n【题干】"`），因为
   `source_char_end` 取「下一段的起点」，而 excerpt 从 `【题干】` 开始，下一题的题号行就被算进了上一段。
   `page_diagnostics` 的 p2 仍是干净页，所以这个 region 不产生任何 issue；但「一条 region 对一段文本」的
   直觉不成立（06 §3.5 只写「Region 每页一个」）。
6. **publish 的响应体没有 `question_id`**：`CandidateOut` 没有声明该键，Ninja 把内部 result 过滤掉了
   （06 §3.6/§4.3 已提示「HTTP 原始响应及 replay 都应去掉该键」；实测 P31/P34 的 `response_field_order`
   里确实没有，DB 里有 `publication_question_id`）。
7. **同一请求内重复字节会产生 `1#2` 位置键 + `duplicate_candidate`**（P04）：跨请求的复用规格里有，
   同请求内的这条行为没有写。
8. **`build_text_pdf` 夹具的几何不可信**：`T*` 换行在 pypdf 的 operand visitor 下让 fragment 的 y 每行
   递增 168pt（把页面往下撑穿），`bbox_for_text` 的结果先越界再被 clamp —— P03 的候选 `2`、`4`（同一页的
   第二道题）的 region 就是 `y=0.995,height=0.005`。因此本批只在 `build_layout_pdf`（显式 `Tm`）夹具上
   把 bbox 当事实引用（P17–P19），文本类夹具的 bbox 只作为记录。这也是 C01 测试用 `build_layout_pdf`
   做几何断言的原因。

## 5. 未覆盖

- **40 MiB 上限（`too_large`）与 2,000,000 字符上限（`too_much_text`）**：没有构造对应夹具，代码分支存在
  但本批未实测。
- **`MAX_JOB_PAGE_DIAGNOSTICS=500` 截断**：需要 >500 页的 job（且每份 ≤200 页），本批未覆盖。
- **同一 job 里「候选落在扫描页上」**：扫描页没有文字层，解析不会在那里产生候选；要在 HTTP 上造出这种
  候选，只能在图片导入路径或直接写库。P16 记录的是「干净页的候选不被扫描页阻断」。
- **幂等指纹不含哪些字段**：`title`/`source_note`/`usage_scope`/`expected_session_count`/文件名/MIME
  按代码不在指纹里，但本批只做了「同 body 重放」，没有单独改 title 取一条证据。
- **O17 缺 Idempotency-Key → 409**：`test_p2_layout_import.py` 里有，本批只测了带 key 的成功路径。
- **并发**：同键并发 claim（`in_flight`）、同一份字节并发导入、`storage.save` 的竞态都未测。
- **真实外部 PDF**：全部夹具来自 `pdf_builder`（Type0/Identity-H、无嵌入字库）。Word/LaTeX 导出的
  真实 PDF（子集字体、`TD`/`TJ` 版式、表格线）没有对拍，几何与列检测结论不能外推到它们。
- **多份答案 PDF**：只用了一份答案 PDF；多份 answers 的 entries 拼接顺序、跨文档 label 重名未取证。
- **视觉/模型分支**：O09 全程不调用模型（delta 无 `audit_llm_run`、无 outbox），B5 不在本批。

## 6. 数字汇总

- 用例组 26 个（C01–C26），HTTP 请求 **40** 个：O09 = 32、O15 = 3、O17 = 1、O18 = 4。
- 状态码分布：**201 × 19**（其中 P22 是重放）、**400 × 10**、**200 × 6**、**404 × 2**、**422 × 2**、
  **409 × 1**。
- 成功导入 18 次（P22 是重放不算新 job）；被拒绝的 PDF：10 次 400 + 1 次 409 + 2 次 404。
- 夹具 27 份 PDF：2 份加密（其中 1 份可用空密码解开）、1 份纯扫描、1 份扫描混排、2 份双栏
  （P17 与 P27 各一份）、1 份表格公式、1 份跨页、1 份 201 页、1 份 0 页、1 份损坏、1 份非 PDF、
  1 份 MIME 伪装，其余为单/多页纯文字件。
- 符号 155 个，`REF_nnn` 残留 0 个；两次运行 sha256 =
  `f2a40e35ac860ada692dbd0f128f243318b80babbfebe9fcf38b64ba9e5e662c`。
