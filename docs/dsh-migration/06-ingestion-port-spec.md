# Ingestion → DSH 移植规格

> 范围：私有资产、来源文档、文本/图片/PDF 导入、候选校对与发布、AI 变式。本文是实施规格，不表示端口已经实现或通过验收。
> 对照基线：当前仓库代码；仅静态阅读，未运行测试、构建或黄金向量生成器。文件定位均为仓库相对路径。

## 0. 范围与先决条件

**操作数更正：当前 `backend/apps/ingestion/api.py` 是 20 个操作，而非任务描述中的 14 个。** 下文 O01–O20 全覆盖；既有清单也是 20 个（`docs/dsh-migration/02-code-surface-inventory.md:134`）。不能将第 15–20 个校对、忽略、版式确认、发布、变式生成/列表排除。

约束沿用 R-IMPORT-01–13、R-INV-01–10：保留原始资料和溯源、候选不自动发布、AI 不写正式分、来源文件受答案/封存门禁约束；复杂扫描 PDF OCR 不存在（`docs/dsh-migration/01-requirements-inventory.md:83`、`:126`）。C9 要求换解析库后使用既有 PDF 夹具**逐页**对照，不是只比题目数量（`docs/dsh-migration/03-dsh-compatibility-and-migration-plan.md:57`）。

### 0.1 已有 Node 基础与缺口

| 基础 | 可以复用什么 | 实施前必须处理什么 |
|---|---|---|
| repository | `insertRow/updateRow/findRows/findOne/compareAndSet`；列 kind 编解码，JSON 已是对象，datetime 是 Instant，decimal 是 Decimal；未知列直接抛错 | 不写 ORM 属性名或未声明 JSON 列；`findOne` 匹配多行会抛错，Python `.first()` 应用 `findRows(...,{orderBy,limit:1})`；CAS 仅比较/更新一列，revision CAS 和 payload/audit 必须同事务（`dsh-plugin/src/store/repository.ts:47`、`:80`、`:206`、`:221`、`:242`） |
| SQLite | `openStore` 打开 FK、WAL、busy timeout；`transaction` 用 BEGIN IMMEDIATE，嵌套加入外层 | 回调是**同步**的；传 Promise 会提前 COMMIT，不能包 `await port.run()`、异步 PDF/sharp 或 async worker（`dsh-plugin/src/store/db.ts:48`、`:71`） |
| 幂等 | Python canonical JSON 指纹、claim/replay/conflict/release/recordResult 已有 | HTTP `resource(scope,handler,payloadOf)` 同步地包 claim+副作用+结果；payloadOf 默认 `ctx.body ?? {}`，可复用第三参表达默认值/query 指纹，但上传须先准备 checksum，AI 分段提交需专用包装（`dsh-plugin/src/store/idempotency.ts:50`、`:89`、`:126`、`:156`；`dsh-plugin/src/http/routes.ts:66`） |
| HTTP | `/api/acepass` 前缀；in-process router 支持 `:param` | DSH 只挂**无 `:` 的静态路径**，全部 ingestion 项目路径都尚不能靠直接注册上线；当前仅 JSON reader/JSON response，无 multipart/raw Response 通道。需新增传输适配并经 Remote 或静态分发入口承载参数，不能把进程内 Request 测试当宿主验收（`dsh-plugin/src/http/routes.ts:64`；`dsh-plugin/src/http/router.ts:97`、`:148`；`dsh-plugin/src/index.ts:109`） |
| 内容/AI 纯层 | `validateContent/validateAnswerPayload`、prompt builders、7 个 validators、audit/degrade/outcome、Python 字符串 helper 已有 | ingestion 编排、版式/text/PDF parser、资产存储/鉴权、variant 独立校验未实现；`outcome.keepCandidate` 不能解释成“用拒绝的 extraction 覆盖草稿”（`dsh-plugin/src/ai/content.ts:238`；`dsh-plugin/src/ai/validators.ts:79`、`:522`；`dsh-plugin/src/ai/outcome.ts:129`；`backend/apps/ingestion/services/extraction.py:223`） |
| 题库/考试/练习 | `createQuestionRevision/publishQuestionVersion`、`replaceKnowledgeMappings`、`registerPaper`、session 冻结与判分可复用 | 不存在完整的 create question / create answer / upsert rubric / add paper item ingestion 编排；已有发布校验缺 Python 的 fill-blank 总分、rubric.clean、材料子题同科目检查，见 §4.4（`dsh-plugin/src/services/questions.ts:145`、`:264`；`dsh-plugin/src/services/exams.ts:793`） |
| schema | ingestion 六实体表已存在 | **缺少两张 Django 自动 M2M 表**：job.documents、candidate.source_regions。生成器只枚举 `get_models()` 与 concrete_fields；不得虚构 `document_ids/source_region_ids` 列。批次 B1 前须扩展生成/归档覆盖（`dsh-plugin/scripts/gen_schema.py:193`、`:208`；`backend/apps/ingestion/models.py:168`、`:235`） |
| worker | 持久化 outbox 与 claim/lease 框架 | 默认仅 `evidence.rebuild_for_attempt`；`TopicHandler` 是同步 void，须接入异步 extraction；`projection.refresh_paper_stats` 也尚无默认消费者（`dsh-plugin/src/jobs/worker.ts:24`、`:27`） |

### 0.2 公共协议（适用于每个 O 编号）

- 下表完整路径是 Django 基线；Node 目标路径仅将 `/api/v1` 换为 `/api/acepass`，其余原样。文中的 `{project_id/job_id/candidate_id/asset_id}` 是 URL 参数，不是字面值；DSH 上线方式受 §0.1 限制。
- 全部操作要求 session auth，未登录 401 `unauthorized / 请先登录`；Django 的 SessionAuth/CSRF 由框架处理。Node 使用工作区 owner + 宿主 peer 授权，不移植登录/CSRF；项目/科目检查保留。现有 Node AuthenticationRequired 是 `unauthenticated / 需要登录`，是已有传输差异，不能声称完全相同（`backend/apps/common/api.py:11`；`backend/apps/common/errors.py:184`；`dsh-plugin/src/services/errors.ts:102`）。
- 每个操作先 `require_project(owner,project_id)`，失败 `ScopeViolation / 项目不存在或无权访问`；非空 subject 再查 project 内科目，失败 `ScopeViolation / 科目不存在或不属于该项目`（`backend/apps/common/scope.py:17`、`:27`）。这些 helper 本身**没有归档写入守卫**，不从需求文档推定 ingestion 已禁止归档写入。
- 错误信封 `{error:{code,message,details,request_id?}}`；无 details 为 `{}`。本文简记 `I=InvalidInput(400,invalid_input)`、`S=ScopeViolation(404,not_found)`、`P=PurposeNotAllowed(403,purpose_not_allowed)`、`V=VersionConflict(409,version_conflict)`、`T=StructureInvalid(422,structure_invalid)`；Django model ValidationError → T「结构校验失败」`{errors:message_dict或messages}`；Schema 解析错误 → 400「请求参数校验失败」`{errors:[...]}`，不要改成 422（`backend/apps/common/errors.py:35`、`:142`、`:176`）。Node 新增 `AiNotConfigured/DependencyUnavailable` 两个 503 类，现有 errors.ts 未提供它们（`dsh-plugin/src/services/errors.ts:89`、`:110`）。
- 标为 I-Key 的操作：trim header，空键/长度 >200 分别 409 `IdempotencyConflict / 缺少 Idempotency-Key 请求头`、`Idempotency-Key 过长`；同键异载荷为409「相同幂等键使用了不同请求内容」，details={route_scope,reason:"same_key_different_payload"}；未完成 claim 为409「相同幂等键的请求正在处理中，请稍后重试」，details={route_scope,reason:"in_flight"}（`backend/apps/common/errors.py:66`；`backend/apps/audit/services/idempotency.py:93`）。Python 中间件在失败响应后删除未完成 claim；Node 现有 resource 缺键却是400，且不 trim/限长，冲突映射只传 message 丢失 details，需 ingestion 适配修齐（`backend/apps/common/api.py:43`；`backend/apps/audit/middleware.py:40`；`dsh-plugin/src/http/routes.ts:72`、`:89`）。非 I-Key 操作不创建 claim，即便是 POST。
- ID 在线上为字符串，nullable ID 保留 null；datetime 用 Python `.isoformat()`（UTC `+00:00`，保留微秒），不得换毫秒 Date/Z。Decimal 在输出中为十进制字符串；候选 payload 是原 JSON，不把任意数值自动转 Decimal。坐标为 number、计数为 integer、bool 不得变 0/1。`toWireJson`/`jsonSafe` 可复用，response 必须按下述投影字段构造（`backend/apps/ingestion/services/imports.py:208`、`:236`；`dsh-plugin/src/http/router.ts:76`；`dsh-plugin/src/store/idempotency.ts:140`）。
- request Schema 除下文显式限制外没有长度/数量 Field 限制；存储截断、模型 full_clean 和 PDF/image 限制另列，不要把“无声明上限”写成“无限且一定成功”。Python code-point 截断、长度、偏移用 `pySlice/pyLen` 或等价 helper，不能直接 JS UTF-16 slice/indexOf（`dsh-plugin/src/ai/pyvalue.ts:134`）。

## 1. 请求与响应字典

表中 `?` 表示可空，不表示可省略；带 `=默认值` 才允许省略。`object`/`object[]` 为保留字段的 JSON 对象，不任意丢弃嵌套字段。

| 请求名 | 完整字段及默认值 | 依据 |
|---|---|---|
| TextIn | `text:string`；`subject_id:string?=null`；`title/source_note/usage_scope:string=""`；`parse:boolean=true` | `backend/apps/ingestion/api.py:51` |
| ParseIn | `text:string`（空文本可预览为零条） | `backend/apps/ingestion/api.py:166` |
| PatchIn | `draft_payload:object?=null, subject_id:string?=null, expected_revision:integer?=null, note:string=""`；payload 是全替换，不是 deep merge；null subject 不清空科目 | `backend/apps/ingestion/api.py:130`；`backend/apps/ingestion/services/core.py:626` |
| LayoutIn | `note:string=""` | `backend/apps/ingestion/api.py:137` |
| PublishIn | `exam_spec_version_id:string?=null, node_ids:string[]=[], origin_type:string="user_authored", display_label:string=""` | `backend/apps/ingestion/api.py:143` |
| VariantIn | `source_question_id:string?=null, source_version_id:string?=null, node_id:string, count:integer=1, difficulty_note:string=""`；至少一个 source，version 优先，count≥1、执行最多3 | `backend/apps/ingestion/api.py:173`、`:847`、`:875`；`backend/apps/question_bank/services/variants.py:734` |
| Asset multipart | `file:UploadedFile` 必填；`role:string="past_paper_page"` | `backend/apps/ingestion/api.py:288` |
| Image-source multipart | `file` 必填；`role="past_paper_page"`；`title/source_note/usage_scope/subject_id:string=""` | `backend/apps/ingestion/api.py:374` |
| Images multipart | `files:UploadedFile[]` 必填且非空；`subject_id/title:string="", role:string="past_paper_page"`；无显式总张数限制 | `backend/apps/ingestion/api.py:450` |
| PDF multipart | `files:UploadedFile[]` 必填非空，`answer_files:UploadedFile[]=[]`；`subject_id/title/source_note/cycle_key/session_key/paper_code/usage_scope:string=""`；`source_kind:string="official_past"`；`expected_session_count:integer?=null`；无显式文件总数限制 | `backend/apps/ingestion/api.py:526` |

role 仅 `past_paper_page,answer_page,stem_crop,material_crop,answer_crop,user_attachment,other`；sensitivity 仅 `public_to_owner,contains_answers,internal_review`；source_kind 仅 `official_past,mock,practice_set,demo`。注意 source image 的 API 检查 role，但 create_image_document 的 MIME 行为见 §5（`backend/apps/common/enums.py:274`；`dsh-plugin/src/services/exams.ts:643`）。

| 响应名 | 字段（所有字段都要输出） | 投影依据 |
|---|---|---|
| Asset | `id,project_id,role,sensitivity,content_type,checksum,original_filename,download_url:string`；`size_bytes:int,width/height:int?`；URL 基线 `/api/v1/projects/{project_id}/assets/{id}`，Node 换前缀 | `backend/apps/ingestion/api.py:37`、`:251` |
| Document | `id,project_id,title,document_type,role,sensitivity,source_type,source_note,usage_scope,checksum,raw_text_preview:string`；`subject_id,asset_id:string?`；preview 为 raw_text 前400字符 | `backend/apps/ingestion/api.py:150`、`:267` |
| Job | `id,project_id,status,input_kind,last_error,extractor_version:string`；`subject_id,duplicate_of_job_id:string?`；`progress_percent,attempts,max_attempts,candidate_count:int`；`problems,page_diagnostics:object[]`；`document_ids:string[]`；`candidate_status_counts:Record<string,int>`；`created_at:ISO string` | `backend/apps/ingestion/api.py:60`；`backend/apps/ingestion/services/imports.py:208` |
| Region | `id,document_id,role,text_span,document_title,document_type:string`；`page_index:int`（1起）；`x,y,width,height:number`；`crop_asset_id,document_asset_id:string?`；不返回 char_start/char_end | `backend/apps/ingestion/api.py:81`；`backend/apps/ingestion/services/imports.py:248` |
| Candidate | `id,job_id,status,extractor_version,source_position_key,layout_review_note:string`；`subject_id,publication_question_id,publication_version_id,publication_paper_item_id,parent_candidate_id,paper_revision_id:string?`；`revision:int,is_stub_output:boolean`；`review_issues:object[],draft_payload/machine_payload/answer_match:object,source_regions:Region[],child_candidate_ids:string[]`；`layout_review_confirmed_at:ISO string?,updated_at:ISO string` | `backend/apps/ingestion/api.py:100`；`backend/apps/ingestion/services/imports.py:236` |
| VariantCandidate | `candidate_id,job_id,status,answer_source_type,content_digest,source_question_id,source_version_id,node_id,llm_run_id:string`；`question_type:string?`；`awaiting_human_review,answer_needs_confirmation,is_stub_output:boolean`；`review_issues,blocking_issues:object[]`；`publication_question_id,publication_version_id:string?`；`created_at:ISO string` | `backend/apps/ingestion/api.py:183`；`backend/apps/question_bank/services/variants.py:645` |
| VariantPropose | `job_id,job_status,project_id,subject_id,source_question_id,source_version_id,node_id,node_name,provider,model,prompt_version,origin_type:string`；`is_stub,count_capped,nothing_passed:boolean`；`requested_count,count:int`；`candidates:VariantCandidate[],problems:object[],notes:string[]`；`validation:{requested_count,count,accepted,rejected,blocking_problem_count:int,nothing_passed:boolean}` | `backend/apps/ingestion/api.py:206`；`backend/apps/question_bank/services/variants.py:935` |
| VariantJob / VariantList | Job 变体：`job_id,project_id,status,input_kind,extractor_version:string,subject_id:string?,progress_percent/candidate_count:int,problems:object[],candidate_status_counts:Record<string,int>,candidates:VariantCandidate[],created_at:ISO string`；列表 `{count:int,limit:int,jobs:VariantJob[]}` | `backend/apps/ingestion/api.py:230`；`backend/apps/question_bank/services/variants.py:673` |

Job 的 status counts 只包含实际存在的状态，不补零；documents 无显式顺序，不能承诺上传顺序；Candidate source_regions 按模型 `document,page_index,y,x`，child IDs 按 created_at；同时间并列无额外顺序保证（`backend/apps/ingestion/services/imports.py:223`、`:266`、`:276`；`backend/apps/ingestion/models.py:139`）。

## 2. 全部 HTTP 操作与幂等契约

以下每行都继承 §0.2 的 auth/project 检查；`—` 表示不要求 I-Key。scope 中 ID 为实际路径 ID；JSON 指纹均使用 Schema 默认值展开后的 `model_dump(mode="json")`，不是客户端原始 JSON。

| # | method + 完整路径 | 请求 / 额外作用域 | I-Key：scope；claim payload | 成功响应 | 依据 |
|---|---|---|---|---|---|
| O01 | POST `/api/v1/projects/{project_id}/assets` | Asset multipart | — | 201 Asset | `backend/apps/ingestion/api.py:288` |
| O02 | GET `/api/v1/projects/{project_id}/assets/{asset_id}` | query `purpose:string="practice",session_item_id:string?=null`；asset owner/project、item session user/project | — | 200 字节流，headers 见 §3.2 | `backend/apps/ingestion/api.py:307` |
| O03 | GET `/api/v1/projects/{project_id}/source-documents` | query `subject_id:string?=null,limit:int=50`；文档 owner/project；非空 subject 查 scope | — | 200 Document[]，limit clamp 1..100、created_at desc | `backend/apps/ingestion/api.py:347` |
| O04 | POST `/api/v1/projects/{project_id}/source-documents/text` | TextIn；非空 subject 查 scope；parse 被忽略 | — | 201 Document | `backend/apps/ingestion/api.py:357` |
| O05 | POST `/api/v1/projects/{project_id}/source-documents/image` | Image-source multipart；非空 subject 查 scope | — | 201 Document | `backend/apps/ingestion/api.py:374` |
| O06 | POST `/api/v1/projects/{project_id}/imports/parse-text` | ParseIn | — | 200 `{count:int,segments:Segment[]}`，无写入 | `backend/apps/ingestion/api.py:413` |
| O07 | POST `/api/v1/projects/{project_id}/imports` | TextIn；非空 subject 查 scope | `imports.create:{project_id}`；完整 TextIn | 201 Job；resource `import_job/job.id` | `backend/apps/ingestion/api.py:421` |
| O08 | POST `/api/v1/projects/{project_id}/imports/images` | Images multipart；先逐图 validate，再 claim | `imports.create_images:{project_id}`；`{checksums:[原始字节sha256，按上传顺序],subject_id,role}` | 201 Job；resource `import_job/job.id` | `backend/apps/ingestion/api.py:450`、`:478` |
| O09 | POST `/api/v1/projects/{project_id}/imports/pdf` | PDF multipart；source_kind/cycle 先校验 | `imports.create_pdf:{project_id}`；`{checksums:[先files后answer_files的原始sha256],subject_id,cycle_key,session_key,paper_code,source_kind}` | 201 Job；resource `import_job/job.id` | `backend/apps/ingestion/api.py:526`、`:575` |
| O10 | GET `/api/v1/projects/{project_id}/imports` | query `status:string?=null,limit:int=20`；created_by owner；非空 status 原值过滤，不校验枚举 | — | 200 Job[]；limit 1..100、created_at desc | `backend/apps/ingestion/api.py:614` |
| O11 | GET `/api/v1/projects/{project_id}/imports/{job_id}` | job project+created_by | — | 200 Job | `backend/apps/ingestion/api.py:623` |
| O12 | POST `/api/v1/projects/{project_id}/imports/{job_id}/retry` | 无 body；先查 job project+created_by | `imports.retry:{job_id}`；`{}` | 200 Job；resource `import_job/job.id` | `backend/apps/ingestion/api.py:632` |
| O13 | GET `/api/v1/projects/{project_id}/import-candidates` | query `job_id:string?=null,status:string?=null,limit:int=50`；candidate project+job.created_by，过滤值不额外 get/scope | — | 200 Candidate[]；limit 1..100、created_at asc | `backend/apps/ingestion/api.py:651` |
| O14 | GET `/api/v1/projects/{project_id}/import-candidates/{candidate_id}` | candidate project+job.created_by | — | 200 Candidate；可能写 editorial exposure | `backend/apps/ingestion/api.py:665` |
| O15 | PATCH `/api/v1/projects/{project_id}/import-candidates/{candidate_id}` | PatchIn；candidate scope、非空 subject scope | —，revision 不是 I-Key | 200 Candidate | `backend/apps/ingestion/api.py:702` |
| O16 | POST `/api/v1/projects/{project_id}/import-candidates/{candidate_id}/ignore` | **query** `reason:string=""`（非 JSON body）；candidate scope | `candidates.ignore:{candidate_id}`；`{reason}` | 200 Candidate；resource `import_candidate/candidate.id` | `backend/apps/ingestion/api.py:721` |
| O17 | POST `/api/v1/projects/{project_id}/import-candidates/{candidate_id}/layout-confirm` | LayoutIn；candidate scope | `candidates.layout_confirm:{candidate_id}`；完整 LayoutIn | 200 Candidate；resource `import_candidate/candidate.id` | `backend/apps/ingestion/api.py:746` |
| O18 | POST `/api/v1/projects/{project_id}/import-candidates/{candidate_id}/publish` | PublishIn；candidate scope、可选 spec 项目内且 published；node scope 在 service 检查 | `candidates.publish:{candidate_id}`；完整 PublishIn | 200 Candidate；resource `import_candidate/candidate.id` | `backend/apps/ingestion/api.py:787` |
| O19 | POST `/api/v1/projects/{project_id}/variants/propose` | VariantIn；source 与 node 所在 project；source_version_id 优先，否则最新 published version | `variants.propose:{project_id}`；完整 VariantIn | 201 VariantPropose；resource `import_job/result.job_id` | `backend/apps/ingestion/api.py:865` |
| O20 | GET `/api/v1/projects/{project_id}/variants` | query `limit:int=20`；project+created_by+input_kind=ai_variant | — | 200 VariantList；limit 1..50、jobs created_at desc、candidates asc | `backend/apps/ingestion/api.py:917`；`backend/apps/question_bank/services/variants.py:694` |

**指纹不能补字段**：O08 不含 title/文件名/MIME；O09 不含 title/source_note/usage_scope/expected_session_count/文件名，也不编码 paper 与 answer 文件的分界。因此这些字段变化仍可 replay。O18 内部 result 写 `question_id`，但 CandidateOut 未声明，HTTP 原始响应及 replay 都应去掉该键；持久化幂等 response_body 却含它，需区分“存储结果”和“响应投影”（`backend/apps/ingestion/api.py:479`、`:580`、`:815`；CandidateOut `:100`）。

## 3. 非发布操作：写入、校验与状态

### 3.1 O01 / O04 / O05 来源写入

| 操作 | 有序行为 | 错误 / 审计 / outbox |
|---|---|---|
| O01 | 读完整 file；空检查；MIME lower；`storeAsset` 校验 role/sensitivity/subject，必要时图片校验重编码，保存字节，再 insert Asset | 空 → I「上传内容为空」；其余 §5；无 ContentRevision/outbox，无 checksum 去重。即使 role=answer_page，此接口仍默认 public_to_owner（`backend/apps/ingestion/api.py:291`；`backend/apps/ingestion/services/core.py:85`） |
| O04 | `text.strip()` 非空；insert SourceDocument：type=text,role=past_paper_page,sensitivity=public_to_owner,source_type=user_paste；raw_text 原样，UTF-8 sha256；title[:300],source_note[:500],usage_scope[:200] | I「文本内容不能为空」；无 Asset、Job、Candidate、审计/outbox；每次都新建（`backend/apps/ingestion/services/core.py:139`） |
| O05 | 空检查→role 枚举→answer_page 才 contains_answers→storeAsset→insert Document：type=image,asset_id,checksum=asset.checksum,source_type=user_upload，截断同 O04 | 空 I「上传内容为空」；role I「来源角色无效」；§5 校验；无 Job/审计/outbox；不去重（`backend/apps/ingestion/api.py:388`；`backend/apps/ingestion/services/core.py:173`） |

O03/O10/O11/O13/O20 都只投影，不刷新 issues/状态、不发 outbox。O11/O12 查不到 → S「导入任务不存在或不属于该项目」；O14–O18 查不到 → S「候选不存在或不属于该项目」。列表外项目 job_id 仅过滤为 `[]`，不变成 404（`backend/apps/ingestion/api.py:615`、`:624`、`:652`、`:666`）。

### 3.2 O02 私有文件下载

按序：project → Asset owner/project → optional SessionItem(session.user/project) → download gate → storage.exists → exposure → open/stream。资产缺失 S「文件不存在或不属于当前项目」；item 缺失 S「题项不存在或不属于该项目」；磁盘缺失 `Http404("asset bytes are missing")` 在线上被映射为 404 `not_found / 对象不存在或不在当前权限范围`，不是泄露路径（`backend/apps/ingestion/api.py:312`；`backend/apps/ingestion/services/access.py:52`；`backend/apps/common/errors.py:152`）。

门禁顺序与错误必须一致（全部 P，除封存外 details={}；`backend/apps/ingestion/services/access.py:139`）：

1. internal_review 且非 staff：「该文件仅限内部审核使用」。DSH owner 不应自动等同 staff，应读取既有用户事实。
2. `sealedQuestionsForAsset` 取得第一个按 question ID 排序的封存题：消息 `该文件包含已封存题目的原始内容（题目 {display_label or id}）：{sealing.reason_message(code)}，因此不能读取原页或答案文件。`；details `{reason:code,question_id,asset_id,action:"读取原页/答案文件"}`。
3. purpose=editorial：项目存在 ACTIVE verification/mock_exam →「存在未结束的验证/考试会话，暂不能查看可能包含答案的来源文件；请先结束验证」；否则直接允许（即使是 public_to_owner 也执行此 gate）。
4. contains_answers + session：`!allows_pre_submit_answers` →「当前会话模式在提交前不允许查看含答案的来源文件」；然后 active 且非 practice →「验证/考试进行中不允许查看含答案的来源文件」。无 session 但项目有活动 verification/mock →「存在未结束的验证/考试会话，暂不能查看含答案的来源文件」。没有按该 item 是否已交卷单独分支。

封存关系遍历是 crop→SourceRegion、整页 asset→SourceDocument→regions→QuestionSourceLink→version、AnswerKey.source_region.crop_asset、以及封存题所有版本的 image blocks（含 options/blanks）；没有关系的用户附件不猜测关联；**实际 answer-key 分支只查 crop_asset，不查整页 document.asset**，不要将模块注释扩大成代码能力（`backend/apps/ingestion/services/access.py:59`、`:84`、`:121`）。

contains_answers 才写 `practice_exposure_event`：kind=answer_delivered,source=asset_download,reveals_answer=true；purpose 不在 practice/verification/editorial/preview 则回退 practice；item 决定 question/version/family/lineage，detail `{asset_id,role,server_time:ISO}`。每次实际下载都写，无去重/outbox。storage.exists 后、真正 open 前写入，因此 open 竞态失败仍可能留下 exposure（`backend/apps/ingestion/services/access.py:183`；`backend/apps/practice/services/exposure.py:10`）。

成功 `Content-Type=asset.content_type`；image/* 的 disposition 为 `inline; filename="{asset.id}"`，其余 attachment；`X-Content-Type-Options:nosniff`、`Cache-Control:private, no-store`。不公开 object_key，不将私人目录挂静态服务（`backend/apps/ingestion/api.py:338`）。

### 3.3 O06 / O07 文本预览与导入

O06 `parsePaste(text)` 返回 `{count,segments}`，完全无 DB 写入、空白得 []；O07 claim 后 `parse ? parsePaste(text) : []`，在 service 事务中执行以下步骤（`backend/apps/ingestion/api.py:413`、`:432`；`backend/apps/ingestion/services/imports.py:30`）：

1. 新建 text Document → `createImportJob(input_kind=text,input_text=text,extractor_version=text-structure-v1)` → documents M2M；job queued→processing，started_at=now。
2. 每个 segment 按顺序：从 cursor 查 source_excerpt，找不到用 cursor；end=start+excerpt 长度；建 Region(page=1,x=0,y=min(.99,index*.05),width=1,height=.05,role=stem_crop,text_span=excerpt[:2000])，full_clean 后补 char_start/end。
3. 创建 Candidate：draft/machine 都是 segment，revision=1、is_stub_output=false；挂 regions 后 `refreshCandidateIssues`。**文本路径不调用 `_link_material_parents`**，即使 payload 有 local_id/parent_local_id 也未连 DB 父子，不能将 PDF 父子支持误报为文本已实现（`backend/apps/ingestion/services/imports.py:65`、`:85`、`:465`）。
4. segments 为空：job problem `no_recognised_segment / 未能从粘贴文本中识别出题目结构，请使用“题目模板”格式或手工录入。 / warning`；`maybeCompleteJob`；record 201。无 ContentRevision/outbox。

公共 createImportJob：传入 documents 逐个验证 project，不同 → S「来源文档不属于该项目」；fingerprint=sha256(input_text UTF-8)，若无文本则 sha256(按传入顺序拼接 document.checksum UTF-8)，仍空则 hash project ID。建 job 后查同 project/fingerprint 最早历史 job（不含自身），设置 duplicate_of，附 warning `{code:"duplicate_input",message:"检测到相同输入的历史导入任务，请确认是复用还是新建题库（不会自动重复计入真实试卷）",duplicate_job_id}`；不会阻断或复用整个任务（`backend/apps/ingestion/services/core.py:274`）。

公共 createCandidate：subject=传入或 job.subject；machine_payload 使用 Python `machine_payload or payload`；source_position_key[:40]；每个 region.project 不同 → S「来源区域不属于该项目」；插入+M2M+refresh；无初始 CandidateRevision（`backend/apps/ingestion/services/core.py:354`）。

已知异常：文本 index≥20 时 y=.99,height=.05 超过 1.0001，Region.clean 抛 T `{errors:{width:["区域超出页面范围"]}}`，可使整批回滚；不要按注释假设任意题数可导入（`backend/apps/ingestion/services/imports.py:76`；`backend/apps/ingestion/models.py:146`）。

### 3.4 O08 图片批量导入

按顺序：无 files → I「请至少上传一张图片」→逐张真实图片校验→计算原始 SHA256→claim→逐张查同 project/checksum、非 text 文档、created_at 最早→重复放 duplicates、新文件创建 image Document→`startImageImport(documents or duplicates)`。混合新旧时 **只导入新 documents**；全重复时复用 duplicates 创建新 job/candidates；重复 Document 的 subject/role/sensitivity 不被本次参数覆盖（`backend/apps/ingestion/api.py:470`；`backend/apps/ingestion/services/core.py:265`）。

`startImageImport` 先能力检查，支持 extract_question：kind=image_ai、extractor=vision-v1；否则 image_manual/manual-image-v1。建 Job+M2M、processing+started_at；每个 doc 一个整页 Region(0,0,1,1,page1,role=past_paper_page)，一个单选空壳 Candidate：`display_label=title or document.title,content={blocks:[{kind:"text",text:""}]},answer_payload={},answer_status_known=false,needs_manual_structure=true`（`backend/apps/ingestion/services/imports.py:104`）。

job problems：支持视觉 → `vision_extraction_queued`，真实模型 severity=info；无视觉 → `manual_structure_required / 图片已保存为私有来源；未配置视觉模型，请在校对页对照原图录入题干与答案。配置可用的视觉 provider 后，同一入口会自动改为模型识别 + 人工校对。 / warning`。有 duplicates 再附 `duplicate_source_file / 其中 {n} 张图片与已有来源文件完全相同，已复用原来源而未新增（避免同一试卷重复统计）。 / warning`（`backend/apps/ingestion/services/imports.py:140`；`backend/apps/ingestion/api.py:508`）。

有视觉时每 candidate 同事务 enqueue `ingestion.extract_candidate`，payload `{import_job_id,document_id,candidate_id}`，dedupe=`extract-candidate:{candidate.id}`；随后 maybeCompleteJob，记录 201，再 after_commit_dispatch。返回的是任务派发前的 summary，不承诺响应内已含模型结果；无视觉仍 201，保留人工路径，**不返回伪造识别成功/不硬改为 503**（`backend/apps/ingestion/services/imports.py:179`；`backend/apps/ingestion/api.py:515`）。

### 3.5 O09 PDF 批量导入

API 校验顺序：非空 files，否则 I「请至少上传一份试卷 PDF」；source_kind 枚举否则 I「试卷来源类型无效」`{source_kind}`；读取 paper/answer bytes（空 MIME 默认 application/pdf、空 filename 分别 paper.pdf/answers.pdf）；official_past 且 cycle_key.strip() 空 → I「真实考试试卷必须填写年份/周期与卷别代码，否则无法进入历年统计」；再 claim。**代码只检查 cycle_key，未同时拒绝空 paper_code**（`backend/apps/ingestion/api.py:550`、`:572`）。

service 单事务有序步骤（`backend/apps/ingestion/services/imports.py:377`）：

1. 再查 files；subject 跨 project 此处是 I「科目不属于该项目」。先 paper files 后 answer files，逐份 MIME/字节/PDF 校验（§5.2），再按原始 checksum 查询复用；即使重复也重新解析；新 PDF 保存原始 bytes，建 Asset、Document，answer 为 pdf_answer/answer_page/contains_answers，paper 为 pdf/past_paper_page/public_to_owner。page_texts 保存逐页文本、raw_text=`"\n".join(pages)`、page_count=max(1,pages.length)（`backend/apps/ingestion/services/core.py:214`；`backend/apps/ingestion/services/imports.py:326`）。
2. 建 Job(input_kind=pdf_text,extractor_version=pdf-text-v2)+documents；processing，started_at；**先存 page_diagnostics 再建候选**。逐 paper、answer 页诊断附 document_id/title，全 job 最多500条，超过即截断（`backend/apps/ingestion/services/imports.py:428`、`:682`）。
3. 仅当 subject、cycle_key.strip、paper_code.strip 都非空，按自然键 subject+cycle+session+paper_code get/create Paper；旧 Paper 不覆盖 source_kind；每次新建 draft PaperRevision，expected_session_count 原值，covered_session_count=`len(paper_files) if expected_session_count else null`，note=`由原生文字 PDF 导入创建（导入任务 {job.id}）`。不确认 coverage、不设置 effective_revision；审计 paper/create（只新纸）与 paper_revision/create（`backend/apps/ingestion/services/imports.py:863`；`backend/apps/exams/services/core.py:255`、`:283`）。
4. 所有答案 PDF 逐页 parseAnswerPage，entries 增加页/文档 provenance；unparsed 最多50。各 paper **独立** parsePaste(joinedText,structure_only=true)→attachSourcePages→detect/attachCrossPageContinua→bboxForText（`backend/apps/ingestion/services/imports.py:510`、`:834`）。
5. 每个 paper 对**全部** answers 重新 applyAnswerMatches，消费集合只在一次函数调用内有效；每段建 Region(s)、Candidate。匹配成功写 answer_payload、answer_status_known=false、parse_issues 人工确认提示、answer_match；position 从 display_label 或 running_index，重号加 #2/#3，再截40。使用局部 local_id 字典，全部创建后再补 parent_candidate，可能跨文件 local_id 重名覆盖（`backend/apps/ingestion/services/imports.py:365`、`:557`、`:670`）。
6. Region 每页一个：bbox 没有则整页框；首 span text_span 为 excerpt，续页为 span.text，截2000；char_start/end 保存**文档全局字符偏移**。无 cropAsset 自动产生（`backend/apps/ingestion/services/imports.py:624`）。
7. 有 revision 则刷新所有候选，检测历史同 Paper/position 的 published question version；附 `duplicate_paper_positions` warning/count；再写 problems，maybeCompleteJob→201。无 LLM/OCR，无 outbox；PaperItem 在 O18 才写（`backend/apps/ingestion/services/imports.py:465`、`:899`）。

报告问题按实际代码顺序保留 code/message/severity/额外字段，不压成一句“解析失败”：`duplicate_source_file`、`pdf_pages_without_text(pages[:20])`、扫描/多栏/表格公式三个 layout code(pages[:20])、`answers_matched(matched,position_matched,unmatched_labels)`（顺序匹配时 warning，否则 info）、`answers_not_matched`、`no_recognised_segment`，其余 warning；原文模板是 `backend/apps/ingestion/services/imports.py:724`、`:784`，直接移植这些格式化函数并生成黄金向量。

**代码与溯源意图的差异**：apply_answer_matches 的 success dict 只含 matched/method/label/raw/answer_payload/parse_issue，丢掉 entry 的 source_page_index/document_id/document_title；上层 `.get()` 得到 null，因此当前持久化 answer_match 三字段可能全 null。不要宣称已经关联答案页 Region；当前 publish 将全部候选 region 都标 stem，创建 answer key 也未传 source_region（`backend/apps/ingestion/services/text_parser.py:645`；`backend/apps/ingestion/services/imports.py:591`；`backend/apps/ingestion/services/core.py:804`、`:810`）。

### 3.6 O12 重试；O14 编辑预览

O12：仅 failed/cancelled 可重试，否则 I「只有失败或已取消的任务可以重试」；attempts≥max_attempts → I「已重试 {attempts} 次，达到上限；请新建导入任务」。attempts++、processing、last_error=""、started_at=now，附 `retried / 任务已重试（第 {attempts} 次），复用原有来源与候选。 / warning`，maybeCompleteJob。**不重跑 parser、不重建候选、不重新 enqueue vision、不清旧 finished_at**；无 ContentRevision（`backend/apps/ingestion/services/imports.py:192`）。

O14/O15 在返回/修改前 `_record_editorial_preview`：candidate.publication_question_id 为空或 Question 不存在则无写入；否则按 user+question+kind=editorial_preview+detail.candidate_id 复用首条 exposure（source 不参与去重）。新写 purpose=editorial、reveals_answer=true，source 分别 `ingestion.candidate_detail` / `ingestion.candidate_edit`；detail={proofread_at,note:"",published_question,candidate_id,candidate_status}，关联当前 published version、family、lineage；无 outbox（`backend/apps/ingestion/api.py:675`；`backend/apps/learning/services/contamination.py:631`）。

这是 GET 的真实副作用；不能加 I-Key 或把列表 O13 改成每条都曝光。O15 预览写入在 update_candidate 自身事务前，revision 冲突仍可能已有 exposure；Node 应保留该顺序，不误将其与校对回滚绑在一起（`backend/apps/ingestion/api.py:709`）。此路径没有调用 asset gate 或 sealing gate，不能用注释/需求声称候选详情已自动遮蔽。

## 4. 候选校对、发布与状态机

### 4.1 O15 / O16 / O17 的写入顺序

| 操作 | 锁内验证与写入 | 审计 / 完成处理 |
|---|---|---|
| O15 updateCandidate | 重新读锁行；expected_revision 非 null 且不等 → V 默认「版本已过期，请重新加载」`{expected,actual}`；published → I「已发布的候选不能继续修改；请为已发布题目创建新版本」；非空 subject 跨 project → S「科目不属于该项目」；可选全替换 payload/subject；即使空 patch 也 revision++，reviewed_by/at 更新 | 先 CandidateRevision(candidate,新revision,新payload,**刷新前旧review_issues**,edited_by,note[:500])；actor 非空写 ContentRevision(import_candidate,proofread,detail={revision})；最后 refreshCandidateIssues。machine_payload 不动，无 outbox/no maybeComplete（`backend/apps/ingestion/services/core.py:611`） |
| O16 ignoreCandidate | published → I「已发布候选不能标记为忽略」；其他（含已 ignored）写 status=ignored；不加 revision、不改 reviewed_at | ContentRevision(import_candidate,ignore,reason[:500])；maybeCompleteJob；无 CandidateRevision/outbox（`backend/apps/ingestion/services/core.py:657`） |
| O17 confirmLayoutReview | published → I「已发布的候选无需再确认版式」；其余包括 ignored 可确认；layout_review_confirmed_at=now,note=(note or "")[:500],reviewed_by/at 更新；不加 revision | ContentRevision(import_candidate,layout_confirm,reason=note,detail={pages:[{document_id,page_index}],continues_on_pages:payload字段或[]})；refreshCandidateIssues；无 CandidateRevision/outbox/no maybeComplete（`backend/apps/ingestion/services/core.py:676`） |

### 4.2 refreshCandidateIssues：共同发布门禁

按以下顺序重算并**替换** review_issues；不是附加 parser 的 parse_issues。每项包含 code/message/severity，额外字段如下。该函数被创建、编辑、版式确认、AI 应用、PDF 重复检查、发布前后调用（`backend/apps/ingestion/services/core.py:410`）。

| 顺序 / 条件 | issue（B=blocking，W=warning）及 message / extras |
|---|---|
| 无 question_type | B `missing_question_type`「缺少题型」 |
| 有 type | `validateContent(content,type)` 每条原 code/message/path 置 B；选择题 options<2 再 B `too_few_options`「选项少于两个，疑似识别缺失」（`:421`） |
| material | 无 children：B `material_without_children`「材料题没有任何子题；请先校对并发布子题，再发布材料题」；有未 published children：B `material_children_unpublished`「仍有 {n} 个子题未发布，材料题的子题关系尚不完整」+candidate_ids（`:429`） |
| 非 material | `answer_status_known` 默认 true；为 false：B `answer_unknown`「答案缺失或不确定，不能发布为计分题」；否则空 answer：B `answer_missing`「尚未填写答案」（`:452`） |
| answer_match.matched 且未 answer_confirmed_by_match_review | B `answer_match_pending_confirmation`「答案由答案页匹配产生（方式：{label→题号，否则顺序}，原文：{str(raw)[:40]}），请核对后确认」+method/source_page_index（`:456`） |
| 无 subject | B `subject_missing`「尚未选择科目」（`:472`） |
| 有 paper_revision、非 material，score 为 null/空字符串 | B `paper_item_score_missing`「该题属于真实试卷记录：发布前必须填写分值，否则周期分值的分母不完整」（`:474`） |
| paper_revision+position，历史同纸同号 published version 且不同于自身 publication_version_id | B `duplicate_paper_position`「该试卷的题号 {key} 已发布过版本；重复导入不能再次发布（如需修订请在题库中创建新版本）」+question_id/question_version_id（`:484`；查询 `:393`） |
| 无 region | W `no_source_region`「缺少来源区域；题目必须可追溯到原文或原图」（`:502`） |
| 未 layout_review_confirmed_at | §5.3 按候选实际 (document,page) 追加 B；已确认仅跳过 layout，不解除答案/重复等（`:511`） |
| continues_on_pages 长度>1 | W `cross_page_question`「该题跨页（第 {页号以、拼接} 页）：题干/选项在页面之间被自动接续，请对照原页确认没有漏字或缺行」+pages（`:521`） |
| job.input_kind=ai_variant | 追加 §6 独立 variantReviewIssues（`:543`） |
| type+content，项目中其他非 ignored candidate JSON content 完全相同 | W `duplicate_candidate`「题库中疑似已有相同结构的候选，请确认是否为重复录入」+candidate_id（`:548`） |
| subject 内 published version content 完全相同 | W `duplicate_published`「已存在内容完全相同的已发布版本，导入前请确认不要重复统计」+question_id；相同非空 display_label 再 W `duplicate_label`「该科目已存在相同题号/标签：{label}」+question_id（`:568`） |

content/answer 的共享问题全集不另造简化校验器：以 `backend/apps/common/content.py` 的 validate_content 与 `backend/apps/common/answers.py` 的 validate_answer_payload 为规范，现成 Node 分别 `dsh-plugin/src/ai/content.ts:87`、`:238`、`dsh-plugin/src/domain/answers.ts`；保留嵌套 path、code/message、限额（blocks120/options26/blanks20/text8000）。原结构重复用 JSON 值等价，不用序列化 key 顺序等价；这里计算的 repr-normalize digest 最终 `del digest`，不是去重条件（`backend/apps/ingestion/services/core.py:549`、`:567`）。

状态：published/ignored 仅更新 issues 和 updated_at，保持状态；其余有 B→draft，无 B 且原 draft→ready。没有“看起来已校对就自动发布”；但 `needs_manual_structure`、parse_issues、is_stub_output 本身**不是**独立 blocker，不能推定有额外人工标记门禁（`backend/apps/ingestion/services/core.py:596`）。

Job 初始 queued；同步导入设置 processing，随即 maybeCompleteJob：failed/cancelled 不变；存在至少一个 candidate 且全 published/ignored→completed,progress=100,finished_at=now；其他→awaiting_review（progress 不增加，未清 finished_at）。CandidateRevision 仅手工 PATCH 产生；confirm/ignore/publish 不增加 revision。这也是 extraction 只比 revision 时的状态竞态风险（`backend/apps/ingestion/models.py:161`、`:179`、`:230`；`backend/apps/ingestion/services/core.py:986`）。

### 4.3 O18 发布：一个原子事务中的有序写集

API 在 claim 前校验 spec：不存在/项目不同 S「考试规范版本不存在或不属于该项目」；非 published I「只能使用已发布的考试规范版本」。代码仅按 spec.subject.project，不验证 spec 与 candidate 同科目（`backend/apps/ingestion/api.py:794`）。

1. 锁 candidate。published 则返回 publication_question（不再新建）；身份丢失 I「候选已发布但题目身份缺失，请检查数据一致性」；ignored I「已忽略的候选不能发布」；无 subject I「发布前必须选择科目」。refresh 后有 blocking → T「候选仍有未解决的问题，不能发布」`{problems:blocking}`（`backend/apps/ingestion/services/core.py:738`）。
2. ai_variant 强制 origin_type=ai_generated；其余使用请求 origin。解析 practice_max_score：null/""→null，Decimal(str(value)) 失败 I「分值必须是十进制数」；无声明值且给 spec，则使用该题型 default_max_score。paper candidate 缺 score 在上一步已阻断，不能靠 spec 绕过（`backend/apps/ingestion/services/core.py:758`、`:977`）。
3. 普通叶子：createQuestion(subject,origin,display_label=请求或payload,is_demo=origin∈{demo,ai_generated})→createQuestionVersionDraft(content,type,score,estimated_seconds,revision_reason=`由导入候选 {id} 发布`)。有 parent_candidate，ensureMaterialVersion 后设置 parent_material_version（此设置在 draft.full_clean 后）。材料：ensureMaterialVersion（若 pointer 已存在则复用），更新 content、material_child_version_ids；父 draft 是发布第一个子题时预建，origin 固定 user_authored/is_demo=false（`:770`、`:849`）。
4. 每个 source region 建 `question_bank_source_link(role=stem)`。非材料创建 checked AnswerKeyVersion：source_type=payload.answer_source_type or user，check_basis=payload.check_basis or「人工校对确认（导入流程）」、explanation_blocks 原 payload；checked_by/at；不填 source_region。constructed_response 建/更新 Rubric，criteria=payload.rubric_criteria or []，total=`decimal(rubric_total_score) or decimal(practice_max_score) or 0`（`:801`）。
5. node_ids 非空才 replace mappings，每个 primary=true、weight=Decimal(1)/len(node_ids)，新 mapping_revision，**不是剩余权重分配**；不默认采用 variant_node_id，也不自动创建 family/content_lineage（`:823`）。
6. `publishQuestionVersion` 校验并改 status=published,published_at,digest；更新 Question.current_published_version；candidate.status=published、publication_question_id/version_id。写 PaperItem（若有 revision 且 marker 为空）：position 优先 source_position_key→payload.display_label→`cand-{id前8字符}`，latest answer，材料 score=0/is_scored=false，叶子 score=payload score or 0；parent_item 若已发布则连上，材料后发布时反向补已发布子 item（`:833`、`:912`）。
7. reconcile 父 material_child_version_ids（按 child.created_at）；refresh candidate issues；maybeCompleteJob；全部成功才提交。API recordResult 后 `after_commit_dispatch`。任一校验失败回滚 candidate/question/version/answer/rubric/mapping/item/source-link/audit/outbox；O18 自身没有额外 import_candidate/publish ContentRevision（`:842`；`backend/apps/ingestion/api.py:817`）。

### 4.4 O18 传递校验、审计与 outbox（不能只做 candidate 校验）

| 调用 | 精确拒绝 / 记录 |
|---|---|
| createQuestion / draft | origin 枚举失败 I「题目来源类型无效」`{origin_type}`；origin=official_past/licensed_bank/user_authored/ai_generated/demo。content 校验失败 T「题目结构校验失败」`{problems}`。draft.full_clean 验证 type/status、Decimal/positive estimated_seconds、父材料关系；model 错误按 §0.2 映射。ContentRevision(question_version,create_draft,detail={question_id,version,type})（`backend/apps/question_bank/services/core.py:49`、`:58`、`:84`；`backend/apps/question_bank/models.py:160`） |
| createAnswer | source 枚举 I「答案来源类型无效」；verification 枚举 I「答案核对状态无效」；checked 且 basis.strip 空 I「标记为已核对时必须填写核对依据」；validateAnswerPayload 失败 T「答案结构校验失败」`{problems}`。版本=max+1、supersedes=latest；ContentRevision(answer_key_version,create,detail={verification_status,source_type})（`backend/apps/question_bank/services/core.py:350`） |
| upsertRubric | 已 usable 且题目非 draft → I「已发布且已核对的答案不能直接改 rubric，请创建新的答案版本」；新版本1，否则递增；checked_by/at，full_clean；**无** rubric ContentRevision（`backend/apps/question_bank/services/core.py:471`） |
| Rubric.clean | errors[`criteria[i]`]：非对象「评分点必须是对象」、无 ID「评分点缺少 criterion_id」、重复「评分点 ID 重复：{id}」、非法 Decimal「评分点分值必须是十进制数」、负数「评分点分值不能为负」、未知依赖「评分点依赖不存在：{dependency}」；空 criteria「大题 rubric 必须至少包含一个评分点」；total_score「评分点合计 {total} 与 rubric 总分 {stated} 不一致」。T「结构校验失败」`{errors}`（`backend/apps/question_bank/models.py:274`） |
| mappings | 重复 node I「同一考点不能重复映射」；缺节点 S「存在不属于可用大纲的考点」；科目不同 S「考点大纲与题目科目不一致」；primary sum≠1 I「主要考点权重合计必须为 1（当前 {total}）；未分类分值请映射到显式“未分类”节点」`{total:string}`；辅助非零 I「辅助考点权重必须为 0，避免重复计分」。ContentRevision(question_knowledge,mapping_revision,detail={revision,count})；不要求大纲 published（`backend/apps/question_bank/services/core.py:500`） |
| publishQuestionVersion | withdrawn I「已撤回版本不能重新发布；请创建新版本」；发布问题 T「发布前校验未通过」`{problems}`；包括 content、material_without_children/material_children_mismatch/material_child_scope，answer_missing/answer_not_checked/answer_version_mismatch/answer_check_basis_missing、answer validator path 加 `answer.`、rubric_missing/rubric_invalid/rubric_total_mismatch、blank_total_mismatch、practice_max_score_missing；code/message/path 原样取 `backend/apps/question_bank/services/core.py:190`–`:290`，不得只保留 Node 已有子集。审计 question_version/publish，after_digest、detail={question_id,version} |
| addPaperItem | withdrawn I「已撤回试卷版本不能新增题项」；重复 position I「该试卷版本已存在相同题号，请确认是修订还是不同卷」`{position_key}`；科目不同 S「题目科目与试卷科目不一致」。full_clean 的 errors：parent_item「父题项必须属于同一试卷版本」/「题项不能以自身为父」；question_version「题目科目与试卷科目不一致」/「AI 生成题不得挂到真实考试发生记录」；max_score「分值不能为负」，按 T/errors。审计 paper_item/create，detail={position_key,max_score:string,is_scored}（`backend/apps/exams/services/core.py:321`；`backend/apps/exams/models.py:285`） |

唯一发布 outbox 来自 PaperItem：`projection.refresh_paper_stats`，payload `{paper_id}`，dedupe=`paper-stats:{paper_id}:{revision_id}`；入队与 item 同事务，提交后派发。普通无 paper 发布不发题库搜索/证据事件，不凭空加 topic（`backend/apps/exams/services/core.py:362`；`backend/apps/question_bank/services/core.py:274`）。

现有 Node `publishProblems` 只比 rubric 字符串，没有 rubric.full_clean、fill-blank sum、材料 child scope；`createQuestionRevision` estimated_seconds 缺省为0，而 Python 可 null。上述是复用前的 parity 差异，不是本文已修复（`dsh-plugin/src/services/questions.ts:182`、`:264`；`backend/apps/question_bank/services/core.py:113`、`:210`、`:247`、`:260`）。等分 3 个节点时 Python Decimal 的舍入和严格和=1 校验可能拒绝；以黄金向量固定实际结果，不能自行“修正最后一个权重”。

## 5. 文件与纯解析端口

### 5.1 storage / sharp

原根目录为 `ACEPASS_PRIVATE_MEDIA_ROOT`，默认 `<repo>/var/private-media`（`backend/config/settings/base.py:254`）。建议 Node 使用 `<workspace>/.acepass/private-media`（**新目标布局**，保留迁入 object_key），不得混为现有实现。key=`{owner_id}/{project_id}/{namespace}/{token前2}/{32位随机hex}.{suffix}`；namespace 为 region（stem/material/answer_crop）、source（past_paper_page/answer_page）、否则 uploads；suffix 由 MIME jpeg→jpg/png/webp/pdf，否则 bin。原文件名只保存在 original_filename[:255]，不拼进路径（`backend/apps/ingestion/services/core.py:112`；`backend/apps/ingestion/storage.py:62`）。

storage save 流式 SHA256 + size，先 `target.suffix+.part` 写入，再 os.replace；DB Asset.checksum/size 对应**最终存储字节**。Asset.source_document 仅 crop 关系；普通 create_image/pdf_document 先建 Asset(source_document=null) 再 Document(asset_id)，不补反向指针。DB rollback 不撤回已 rename 文件，跨批失败可能遗留孤儿；Node staging/失败清理可作为显式运维改良，但不能删除复用文件（`backend/apps/ingestion/storage.py:89`；`backend/apps/ingestion/services/core.py:121`、`:197`）。

| 校验顺序 | 错误（均 I） | 依据 |
|---|---|---|
| role 不在枚举 / sensitivity 不在枚举 / subject 不在 project | 「资产角色无效」`{role}` /「资产敏感级别无效」；subject 是 S「科目不属于该项目」 | `backend/apps/ingestion/services/core.py:100` |
| image MIME 不在 jpeg/png/webp | 「仅支持 JPEG/PNG/WebP 图片」`{content_type}` | `backend/apps/ingestion/services/core.py:39` |
| 原始 bytes >10 MiB（可配置 IMAGE_MAX_BYTES） | 「图片超过大小上限 {max_bytes//MiB} MiB」 | `backend/apps/ingestion/services/core.py:42`；`backend/config/settings/base.py:260` |
| Pillow open.verify 后重新 open 读取尺寸/格式失败（UnidentifiedImageError/OSError） | 「图片内容无法解析，文件可能损坏或不是真实图片」 | `backend/apps/ingestion/services/core.py:46` |
| detected 格式不在 jpeg/png/webp | 「图片格式与声明不一致」`{detected}`；**没有**严格 MIME==detected 检查 | `backend/apps/ingestion/services/core.py:54` |
| width*height >25,000,000（可配置） | 「图片像素超过上限，请先裁剪或压缩」 | `backend/apps/ingestion/services/core.py:56` |

`store_asset` 仅 content_type.startswith(image/) 才 validate/reencode。O01 可存非图片任意非空 bytes；O05 也未强制图片 MIME，因此非 image MIME 可被保存为 document_type=image；O08 才无条件 validateImage。不得将这三条现状写成同一 allowlist。重编码 Pillow 复制 pixels 到同 mode/size 新图，JPEG 非 RGB/L 转 RGB，按检测格式保存；异常直接返回原 bytes，**注释“record it”并无对应审计写入**（`backend/apps/ingestion/services/core.py:61`、`:108`；`backend/apps/ingestion/api.py:394`、`:475`）。

sharp 需复现：真实解码/损坏拒绝、MIME allowlist、byte/pixel 上限、尺寸、不自动 EXIF 旋转、去 metadata、JPEG mode 转换、格式保留和明确的重编码失败策略。JPEG/WebP 编码器、压缩默认值、PNG palette/透明度处理不可能普遍字节相等；因此新图片 checksum 不与 Pillow 编码结果强求一致。**性质测试**：尺寸/方向、可解码、metadata、像素/视觉误差（lossy 单列阈值）、stored checksum 与 actual bytes 一致、原字节不被公开；Pillow 失败回退也单列测试，不能普遍宣称绝无 EXIF。

去重差异必须可见：O08 lookup 用 raw checksum，Document 却存 encoded checksum；同原图二次上传不一定命中。建议先等价保留此行为并写失败反例，若以后引入 raw_checksum 必须单独 schema/迁移设计；现表没有该列，禁止偷偷传给 insertRow（`backend/apps/ingestion/api.py:477`、`:488`；`backend/apps/ingestion/services/core.py:206`）。PDF 不重编码，原字节 checksum 可严格对拍。

### 5.2 pdfjs-dist 输入、输出和错误

建议 `src/ingestion/pdf.ts::extractNativeText(bytes):Promise<PdfExtraction>` 做底层 adapter；纯几何/文本算法置 `src/domain/ingestion/pdf_layout.ts`。这里的库方案来自 C9，未在本次任务安装或验证库版本。

| 条件（按顺序） | I message / details | Python 锚点 |
|---|---|---|
| MIME 非空且非 application/pdf、application/x-pdf、application/octet-stream | 「仅支持 PDF 文件（原生文字版）」`{content_type,filename}` | `backend/apps/ingestion/services/imports.py:338` |
| bytes 空 / >40MiB / 前5字节非 %PDF- | 「PDF 文件为空」`{reason:"empty_file"}` /「PDF 超过大小上限 40 MiB」`{reason:"too_large",size}` /「文件不是 PDF（缺少 %PDF- 头）」`{reason:"not_pdf"}` | `backend/apps/ingestion/services/pdf_text.py:207` |
| PdfReadError / 其他 open 异常 | 「PDF 结构损坏，无法解析」/「PDF 无法解析」，都 `{reason:"damaged"}` | `backend/apps/ingestion/services/pdf_text.py:222` |
| encrypted 且空密码解锁失败 | 「PDF 已加密，请先提供未加密版本（本功能不支持解密）」`{reason:"encrypted"}`；空密码可解锁则继续 | `backend/apps/ingestion/services/pdf_text.py:228` |
| 页数读取失败 / 0页 / >200页 | 「PDF 页数无法读取」`{reason:"damaged"}` /「PDF 没有任何页面」`{reason:"no_pages"}` /「PDF 页数 {n} 超过上限 200，请拆分后分批导入」`{reason:"too_many_pages",pages:n}` | `backend/apps/ingestion/services/pdf_text.py:245` |
| 累计 cleaned 文本 >2,000,000 字符 | 「PDF 文本量超过上限，请拆分后分批导入」`{reason:"too_much_text",characters:total}` | `backend/apps/ingestion/services/pdf_text.py:267` |
| 全文 character_count<2 | 「未从该 PDF 中提取到文字层：它可能是扫描件/图片版。原生文字 PDF 才能自动结构化；扫描件请走图片导入的人工校对路径。」`{reason:"no_text_layer",pages,empty_pages}` | `backend/apps/ingestion/services/pdf_text.py:282` |

逐页失败不是自动失败整个 PDF：先 visitor extract，异常丢 geometry 再普通 extract，仍异常为空文本；单页 `len(text.strip())<2` 标 scanned；全文无文字才拒绝。normalize 仅去 CR、每行尾空白、尾部空行，不 NFKC、不改负号/单位/公式；页文本以单个 newline 连接，page_map 包含全局 code-point [start,end]（`backend/apps/ingestion/services/pdf_text.py:190`、`:452`、`:836`）。

PdfExtraction={page_count,pages,character_count,empty_pages,metadata,page_diagnostics}；page={page_index,text,character_count,fragments,columns,has_table_grid,has_formula_tokens,is_scanned,reading_order_reliable,diagnostics}；diagnostic row={page_index,is_scanned,columns,has_table_grid,has_formula_tokens,reading_order_reliable,fragment_count,character_count,reasons,needs_review}。metadata 只 title/producer/creator[:300]，当前 service 不单独落 metadata 列（`backend/apps/ingestion/services/pdf_text.py:101`、`:143`、`:160`、`:823`）。

### 5.3 版式分类（纯逻辑要黄金向量，库差异要逐页审计）

- fragment 是 show-text 操作 Tj/TJ 的矩阵位置；失败用 visitor_text chunks。normalized top-left：x=(x_pt-left)/page_width，y=(top-(baseline+font_size))/page_height；width 按每字符 CJK≥0x2E80=1em，否则 .5em，至少 .5em；height=1.2em；font 缺失12pt，坏 page box 595×842；每页最多4000 fragments，截断标 reason（`backend/apps/ingestion/services/pdf_text.py:335`、`:374`、`:452`）。pdfjs adapter 必须明确如何将 text items/operator runs 转成此语义，不能直接用不同尺度的 viewport 坐标。
- 同行 baseline tolerance=3pt，x-cluster tolerance=12pt；column cluster≥max(3,int(fragment_count*.15))；gutter≥12pt，邻带纵向重叠≥.5页面高度，cross ratio≤.25 才 qualifying；存在 crossing 则 order ambiguous；columns=1+qualifying。无 crossing 才按栏→y→x 重排；重排后可见字符数比原文少则保留原文并标 ambiguous。代码只比**数量**，不是字符集合（`backend/apps/ingestion/services/pdf_text.py:557`、`:616`、`:728`）。
- grid：≥3行，每行≥3 fragments；x tolerance=6pt，有≥3列各跨≥2行。formula：任一强符号 `∫∑∏√≤≥±≈≠∞∂∈∉∪∩⊂⊆⇒⇔∴`，或去 `__+` 后 LaTeX/上下标/×÷ 构造≥2；不改正文。geometry_unavailable / too_many_fragments 标 order unreliable，但**自身不阻断**（`backend/apps/ingestion/services/pdf_text.py:656`、`:682`、`:692`）。
- bboxForText 用 fragment.text 在 needle 内或 needle 首行前40字符在 fragment 内，合并匹配框；未匹配返回 null→整页；clamp 到0..1，最小 width/height=.005。Region.full_clean 另查 x/y/width/height 0..1、正宽高、page≥1，x+w/y+h≤1.0001，否则 width「区域超出页面范围」（`backend/apps/ingestion/services/pdf_text.py:773`；`backend/apps/ingestion/models.py:109`）。
- layoutReviewIssues 仅匹配 candidate 的 (document_id,page_index)；输出顺序 scanned→multi_column→table/formula，各 issue={code,message,severity:"blocking",pages:[{document_id,page_index,reason}],page_indexes:[可重复],reasons:[排序去重]}。reason map：page_without_text_layer→page_without_text_layer_needs_manual_entry；multi_column_layout/column_reading_order_ambiguous→multi_column_needs_review；table_grid_detected/formula_tokens_detected→table_or_formula_needs_review。三条中文消息原样复用 `backend/apps/ingestion/services/layout.py:73`；不因同 job 其他页可疑阻断干净候选（`:115`）。

**对拍边界**：同一标准化 fragment 输入，分类/排序/bbox/issue 必须严格等价；同一真实 PDF，先逐页比文本、页号、题目顺序、reasons、blocking，再列出几何偏差与原因。pdfjs/pypdf 字体解码、run 合并、浮点框不可假定逐位相等；几何用边界/包含/页归属性质和明确容差，**分类或发布门禁变化不可仅以“浮点容差”豁免**。保留每页差异报告，不只截图或 hash 最终字符串；扫描、混合、双栏、表格、公式、跨页夹具都要覆盖。

### 5.4 文本 parser（O06/O07/O09 共用）

`parsePaste` strip 输入，空→[]；优先 labelled，有任何 labelled 结果就不 fallback；否则 numbered。structure_only 过滤 `structure_signals` 为空的段；**实际 numbered payload 没填 sections，可能被 PDF 全过滤**，以代码而非注释“题号也算信号”为准（`backend/apps/ingestion/services/text_parser.py:116`、`:329`、`:374`）。

Segment 必有 `{question_type,display_label,structure_signals:string[],content,answer_payload,answer_status_known:boolean,explanation_blocks:object[],source_excerpt:string[:1000],parse_issues:string[],practice_max_score:string|null}`；可选 knowledge_hint/source_note/rubric_criteria/local_id/parent_local_id/child_local_ids；PDF 再附 source_char_start/end/source_page_index/source_spans/continues_on_pages（`backend/apps/ingestion/services/text_parser.py:177`、`:354`、`:668`、`:782`）。

规则要逐条 port：标签/别名/正则原表 `text_parser.py:31`–`:88`；同一行多标签，材料先父后子，子题编号保存；options 仅 A–H，ID opt_a…；blank 用 `__+`/空中英文括号，ID b1…；声明题型优先，否则选项→判断关键词与短题干→空位→长于80的大题→单选。选择题答案只取匹配到 options 的字母组；声明单选多答案取第一个但 parse_issue（仍 known=true）；多选 exact_match；判断前缀真/假；填空按 ;；,，| 拆且数量一致；大题给 rubric_required=true；rubric 行分值 regex，默认"0"、c{index+1}、required=true（`backend/apps/ingestion/services/text_parser.py:395`、`:418`、`:444`、`:507`）。

parse_issues 为提示字符串，不抛异常：类型未知/推断、未提供答案、选项未匹配、单选多个答案、判断不明、空位缺失/数量不等、未支持类型；精确模板及顺序直接对拍 `backend/apps/ingestion/services/text_parser.py:395`、`:444`。保留负号、单位、ASCII/Unicode 边界：Python `\b`/`\w` 与 JS 不同。

答案页：跳标题，仅编号+answer-like 值开条目（开头值≤200字符），后续行接 raw；未匹配行 capped50。label 首条 wins；material 不消费；重复 label 已消费则顺序找首个未消费 entry；**先消费再 parse**，不可用也不退还；每个结果包含 matched 或 reason(material_parent/no_answer_entry/answer_value_unusable)；不改正式答案（`backend/apps/ingestion/services/text_parser.py:540`、`:594`）。

页归属：首行40字符从 cursor 搜索，找不到沿用 cursor；offset 落 start≤offset≤end 的页。段 end 为下一段 start 或全文长度；每页交集产生 span，首段即使空白保留，后续空白跳过。跨页标记仅当每个相邻边界都确认：上一页最后行去闭合引号后非终止标点，下一页首行非结构标签/新题号且是 continuation；最后/首行截200字符，reason=line_continues_across_page_break（`backend/apps/ingestion/services/text_parser.py:668`、`:693`、`:750`、`:822`）。

## 6. AI：变式、图片识别与相邻转写契约

### 6.1 能力与审计适配

| 路径 | capability / prompt version / 已有 Node 函数 | 无模型时的精确退化 |
|---|---|---|
| O19 变式 | propose_variant / p2-propose-variant-v1；buildVariantPrompt、validateVariantPayload | 写 unavailable LLMRun，无 Job/Candidate；HTTP 503 ai_not_configured；消息 `生成变式需要配置 AI 能力：未配置可生成变式的文本模型；请配置 provider 或人工录入变式`，details={error_code:"ai_not_configured"}（Python 原文）；DSH adapter 保持此 API 文案，端口原因留审计 |
| O08/worker 提取 | extract_question / p0-extract-v1；buildExtractPrompt、validateExtractPayload | 创建时无视觉：201 image_manual + manual_structure_required，无模型调用/LLMRun；排队后能力失效：unavailable LLMRun + vision_extraction_failed，保留人工候选 |
| 作答照片转写（不属于20个接口） | transcribe_handwriting / p1-transcribe-v1；buildTranscribePrompt、validateTranscription | unavailable LLMRun、抛 AiUnavailable→practice API 503；无假转写，可人工录入；不创建 ImportCandidate |

依据：`dsh-plugin/src/ai/prompts.ts:33`、`:195`、`:282`、`:363`；`backend/apps/ingestion/api.py:833`；`backend/apps/question_bank/services/variants.py:763`；`backend/apps/ingestion/services/extraction.py:162`；`backend/apps/practice/services/transcription.py:332`。

端口必须实际使用 `createLlmPort`→resolveCallConfig→stream→BlockAssembler；无 llm/route 是 ai_not_configured，模型未声明 image modality 是 ai_capability_unsupported（不是猜 vision）；finish error/aborted 不当成功；按 code 映射，不匹配 message。Python 把无 capability 合并 AiUnavailable，Node 内部可保留 unsupported，HTTP 兼容层将此类不可用映射为 AiNotConfigured 并在 details.error_code 保留实际端口 code（**适配决策**；`dsh-plugin/src/llm/port.ts:49`、`:71`；`dsh-plugin/src/llm/contract.ts:52`）。

生产绝不 stub，`is_stub/is_stub_output=false`；可读取旧 archive 中 true 但不得新造真模型成功。费用未知 cost_known=false/cost_cents=null，tokens 仅真实 usage；模型标识从 result.route.model 传给审计。现有 `runCapability` 没把 model 放入 telemetry，成功即 markSucceeded、validation 参数却在调用前传入；需调用后校验再更新同一 run 或新增 orchestration helper，不能生成第二条 run 来修状态（`dsh-plugin/src/services/ai_runs.ts:82`、`:115`；`dsh-plugin/src/ai/audit.ts:176`）。

`audit_llm_run` 存 provider/model_identifier/capability/prompt_version/status、request_summary/input_snapshot/retrieval_source_ids/validation_result、raw_response_excerpt、prompt/completion tokens、cost_cents/cost_known、latency_ms/attempts、error_code/error_message[:500]、is_stub、user_id/project_id。extract/transcribe excerpt4000，variant2000；status 仅 succeeded/failed/rejected/unavailable/timeout，无 running/queued（`dsh-plugin/src/ai/audit.ts:21`、`:34`；`dsh-plugin/src/services/ai_runs.ts:36`）。

### 6.2 O19 / O20 变式具体服务

API 前置：两 source 都空 I「必须提供 source_question_id 或 source_version_id」；count<1 I「count 必须至少为 1」；source 查不到 S「源题目版本不存在或不属于该项目」；node 项目内查不到 S「考点不存在或不属于该项目」。两个 source 都提供不做一致性校验，version 优先（`backend/apps/ingestion/api.py:847`、`:875`）。

service 前置：source 跨项目 S「源题目不属于该项目」；非五种 leaf（包括 material）I「共享材料题不能生成变式；请选择它的子题作为源题」；非 published I「只能从已发布的题目版本生成变式：草稿内容还没有经过人工发布」；sealing.assert_not_sealed(action="用于生成变式")，P message=`封存内容不可用于生成变式：{reason_message(code)}`，details={reason:code,question_id,action:"用于生成变式"}，发生在模型审计前（`backend/apps/question_bank/services/variants.py:720`；`backend/apps/question_bank/services/sealing.py:209`）。node 同 project 不同 subject 不在 API 抛错，而是留阻塞候选。

1. requested=max(1,int(count or 1))，effective=min(requested,3)。无能力先建 failed run，再 unavailable/error_code=ai_not_configured,error_message=`当前 provider 不声明 propose_variant 能力（未配置文本模型）` 后抛；无 job（`backend/apps/question_bank/services/variants.py:734`）。
2. 源文本只取 text/math，math 包 `$...$`，可取 parent material；答案 context 优先最新 non-disputed usable，否则最新 non-disputed 并标“尚未人工核对”；rubric criteria 逐项字符串化。建 ai_variant Job，input_text=`ai-variant:{sourceVersion}:{node或no-node}:{difficulty_note.strip()}:{effective}`，extractor=p2-propose-variant-v1，processing/started_at；附 ai_variant_not_published info，capped 则 variant_count_capped warning+notes（`backend/apps/question_bank/services/variants.py:75`、`:109`、`:776`）。
3. **每道一次串行调用**：先建 run（failed），summary={source_question_version_id,question_type,subject_id,node_id,requested_count,difficulty_note[:200]}，snapshot={content_digest,avoid_stem_count:1,engine:prompt_version}；prompt 含 source type/stem/options/answer summary/node_name/difficulty_note/avoid_stems=[source stem]/rubric/material，模型请求 max_output_tokens=2000（`:738`、`:813`）。现 Node CapabilityRequest 无 token limit 字段且 stream 未传，须扩展已证实宿主参数或明确为未达 parity，不伪称已限制（`dsh-plugin/src/llm/contract.ts:26`；`dsh-plugin/src/llm/port.ts:83`）。
4. provider AiError：run timeout/unavailable/failed + code/message；job failed、last_error=`变式生成失败：{exc}`[:500]、finished_at；重新抛，API unavailable→AiNotConfigured，其他→DependencyUnavailable「生成变式失败：{exc}」`{error_code}`。已完成候选和 run **保留**，这有明确测试（`backend/apps/question_bank/services/variants.py:841`；`backend/tests/integration/test_p2_variants.py:931`）。
5. validateVariantPayload→draftPayload→independentChecks（下表）；run.validation_result={accepted,problems,validation_problems,independent_problems,content_digest,index}，blocking severity 默认 blocking；有 blocking rejected，否则 succeeded。**不论校验通过与否都建候选**；draft.answer_status_known=false，故 accepted 也还不是 ready/published（`:854`）。
6. draft 保存 question_type/content/answer_payload/rubric_criteria/rubric_total_score/practice_max_score、answer_source_type=ai_derived、answer_verification={source_type:ai_derived,verification_status:pending,requires_human_confirmation:true,note}、display_label=`AI变式·{源label或id前8}`[:200]、variant_of_question_id/version_id/node_id/content_digest/prompt_version/llm_run_id、difficulty_note/rationale/doubts。score 依 rubric sum→声明分，或 leaf 声明分→blank sum→content 全部 blank 分值；用 Decimal，不猜 default（`:539`、`:580`）。
7. machine 保存 producer=ai_variant/provider/model/prompt_version/llm_run_id/is_stub、sourceVersion/node/digest、raw_response_excerpt[:2000]、model_output={question_type,difficulty_note,rationale,doubts}；无 source document/region，因此 no_source_region warning 正常存在。rejected 附 variant_rejected warning/candidate_id/codes；全不通过附 no_variant_usable warning+notes；maybeCompleteJob，返回 §1 VariantPropose（`:624`、`:901`）。无 ContentRevision/outbox，无自动 family/node mapping、Question/AnswerKey/Grade/Evidence 写入。

independentChecks **重新校验持久化草稿**，不是只信模型 validator；输出 `{problems,content_digest,origin_type:"ai_generated",source_version_id}`（`backend/apps/question_bank/services/variants.py:397`）：

| 校验 | code / message / details（均含 path、severity；默认 blocking） |
|---|---|
| 答案与本题一致 | 共享 answer validator 每 code 加 `answer.`；material：variant_type_not_scorable「共享材料不能作为变式（material 不产生可判定答案）」path=type；错 option：answer.correct_option_not_in_options「正确选项 {id} 不在变式选项中」；填空空 accepted_values：answer.blank_accepted_values_missing「空位 {id} 没有可接受答案，无法判定对错」，未覆盖：answer.blank_answer_missing「空位 {id} 没有答案」；rubric 总分缺失/非法/不等为 answer.rubric_total_missing/invalid/mismatch，中文原文 `backend/apps/question_bank/services/variants.py:165` |
| 同科目 published digest hit | duplicate_published_question「变式内容与已发布题目版本完全相同：不能再次作为新变式发布」+question_id/question_version_id/display_label；源 family 其他题同 digest 再 duplicate_family_question「同一题目家族中已存在完全相同内容的已发布题目，不能重复生成」+question_id/family_id（`:268`） |
| 最近200个同 project/subject 非 ignored candidate | digest 与 normalized stem 均同→duplicate_pending_proposal「同一批候选中已存在完全相同的变式：重复提案不会产生第二道题」+candidate_id；含 published candidates，exclude 当前候选（`:325`） |
| node | 科目不符 node_subject_mismatch「目标考点不属于该题目的科目大纲：变式不能挂到别的科目的考点上」+node_id；大纲未 published 为 warning node_syllabus_not_published「目标考点所在大纲尚未发布：发布变式前需要先发布大纲」（`:438`） |
| official_past 防线自检 | 用未存内存 PaperItem.clean 探针确认 AI 题会被拒绝；若未拒绝，official_past_rule_missing「服务端未拒绝“AI 生成题挂到真实考试发生记录”：在规则恢复前不生成变式，避免生成内容进入真题统计」path=origin_type。Node 应共享正式 item validator，不写 probe DB 行（`:355`） |
| 源题干 normalized 同 | variant_duplicates_source「变式题干与源题题干完全相同：它不是有效变式」path=content.blocks +source_version_id（`:460`） |

variantReviewIssues：published/ignored 直接 []；source ID 优先 machine→draft，缺源 variant_source_missing「找不到变式的源题版本：无法验证它是否构成有效变式」path=variant_of_version_id；node 同优先级，缺节点 variant_node_missing「变式没有可核对的考点：无法验证它属于该科目大纲」path=variant_node_id；再次 validateVariantPayload(源type,avoid源stem)+independentChecks(exclude self)。不允许编辑无关字段清掉拒绝（`backend/apps/question_bank/services/variants.py:482`）。

**异步幂等实施要求**：O19 不可直接用同步 resource 包整个调用。建议 `http/ingestion_routes.ts::runVariantResource` 短事务 claim→提交 run/job→事务外 await→每个 run/candidate 短事务→成功 recordResult；失败保留 run/job/已建 candidates、单独 release 未完成 claim，再抛503。重复失败请求可以新建 job，不是假装 exactly-once 模型计费；崩溃后未完成 claim 的恢复需显式策略。此处是保留 Python 可观察行为所需的专用包装；不得通过整批 rollback 丢掉失败审计（`backend/apps/audit/middleware.py:40`；`backend/tests/integration/test_p2_variants.py:195`、`:931`；`dsh-plugin/src/store/db.ts:71`）。

### 6.3 图片 extraction worker

查 candidate(id,job_id) 缺→`candidate_missing`；document(id,project_id) 缺→`document_missing`，无新写入；读取当前 revision 后调用模型。当前 Python 未验证 document 属于 job.documents，只约束 project（`backend/apps/ingestion/services/extraction.py:105`）。

读图缺失：记录 failed/missing_source_image，job warning vision_extraction_failed「来源图片不可读取，无法识别」；注意 `_document_bytes` 缺 asset 抛 FileNotFoundError，但 storage.open 缺文件抛 ObjectNotFound(StorageError)，当前 except 只捕 FileNotFoundError，存在未统一降级分支，Node 不应宣称该异常已覆盖（`backend/apps/ingestion/services/extraction.py:53`、`:132`；`backend/apps/ingestion/storage.py:111`）。

prompt={project_name,subject_name或「（未指定科目）」,source_note=document.source_note or title}，images 含真实 bytes/MIME。每次 call 记录 run：snapshot={candidate_id,document_id:**job.documents.first** 的ID,extractor_version}（不一定是本次 document）；summary capability 或 missing reason；4000 excerpt（`backend/apps/ingestion/services/extraction.py:61`、`:148`）。

失败分类：AiUnavailable→unavailable run + warning「视觉模型未配置或不可用，已保留人工录入路径」，返回 unavailable；AiTimeout→timeout、其他 AiError→failed，warning「视觉识别失败：{exc}」，返回 failed；非 JSON→rejected/ai_invalid_output「模型返回的不是有效 JSON」，warning「视觉模型输出不是有效 JSON，请人工录入」，返回 invalid_output；validateExtractPayload（allowed_asset_ids={document.asset_id}）有任意 problems→rejected/ai_invalid_output，保存 validation，不应用 clean，warning「视觉识别结果未通过校验，已保留人工录入路径：{messages以；拼接}」，返回 rejected（`backend/apps/ingestion/services/extraction.py:160`）。

成功锁内应用：machine={extractor:"vision",is_stub_output,provider,model,prompt_version,raw_excerpt[:4000]}。revision 变化时只写 machine 加 stale_revision/extraction_started_revision/applied_revision/pending_clean_payload；job 加 vision_extracted_stale warning，人工 payload/revision 不动。未变化则写 clean 的 type（默认单选）/label（回退原label）/content/answer_payload/answer_status_known/doubts、needs_manual_structure=true；machine、is_stub_output、extractor=vision-v1、revision++；refresh issues；vision_extracted warning；仅 job 原 processing 时 maybeCompleteJob（`backend/apps/ingestion/services/extraction.py:239`）。

无 CandidateRevision/ContentRevision；外层 extract_image_candidate 即使 `_apply_extraction` 返回 stale_skipped 也返回 "ok"。确认版式、忽略、发布不改 revision，因此**仅 revision 比较不足以排除所有迟到状态竞态**；按现状写反例，强化状态 CAS 要单独记录行为调整（`backend/apps/ingestion/services/extraction.py:229`；`backend/apps/ingestion/services/core.py:657`、`:676`）。worker 不在长 SQLite 事务中 await；取 lease token/revision→调用→重新 holdClaim/检查→短事务应用/确认；无能力是可审计人工退化，不无限重试。

### 6.4 转写边界（复用资产，不扩张 ingestion 操作数）

转写服务在 `backend/apps/practice/services/transcription.py:283`，Node 推荐 `src/services/transcription.ts::{requestTranscription,storeTranscriptionProposal,recordManualTranscription,confirmTranscription,rejectTranscription}`；现 `practice.ts` 是提交/评分服务，并没有这些入口。前置 asset 必须属于 attempt.attachments，否则 I「该图片不属于本次作答，不能转写」`{asset_id,attachment_asset_ids}`；confirmed/edited 已决定行不得重转（同文件 `:296`、`:401`）；asset_scope 仍检查 attempt.user/project。

run snapshot 含 attempt_id/asset_id/asset_content_type/asset_size_bytes/prompt_version/prompt_digest，summary 含 question_version_id/type。missing bytes→failed/asset_bytes_unavailable，503 DependencyUnavailable「作答图片不可读，无法转写；请重新上传照片」；非法 JSON→rejected/ai_invalid_output，不造 proposal；validateTranscription 有问题仍 succeeded、validation.accepted=false，clean proposal 仍保存（`backend/apps/practice/services/transcription.py:312`、`:339`、`:367`）。

`practice_answer_transcription` 插入/更新 attempt+asset 唯一行：status=proposed,raw_text,confirmed_text="",confidence,doubts,is_stub,run_id,decided_by/at=null；调用后锁内再次检查 confirmed/edited，禁止迟到覆盖；手工录入/确认/否决另写 ContentRevision，只有 confirmed/edited 文本进入后续估分诊断。未确认照片触发 TranscriptionRequired 409 `transcription_required` + pending asset_ids，不等同识别题目，也不产生导入 candidate/outbox（`backend/apps/practice/services/transcription.py:128`、`:186`、`:390`、`:429`、`:471`）。

## 7. 写表清单、列与 FK 顺序

下表是整个调用图的写集，包括中间件与下游发布；读查 user/project/subject/node/spec/session 不列为写。除 M2M 外各表共有 `id,created_at,updated_at`；J=JSON，D=Decimal TEXT，T=Instant datetime，`?` nullable；其他 ID 为 UUID 字符串。列依据均为 **当前生成 schema 的真实表名**，不能写 `llm_run`、`question_knowledge` 等逻辑简称。

| 表 | 与本域相关的写入列（公共三列省略） | 写入入口 / schema 定位 |
|---|---|---|
| ingestion_asset | owner_id,project_id,subject_id?,role,sensitivity,object_key,original_filename,content_type,size_bytes,checksum,width?,height?,source_document_id?,uploaded_by_id?,is_retained | O01/O05/O08/O09；`dsh-plugin/src/store/schema.generated.ts:2425` |
| ingestion_source_document | owner_id,project_id,subject_id?,title,document_type,role,sensitivity,asset_id?,raw_text,page_texts:J,checksum,source_type,source_note,usage_scope,page_count | O04/O05/O07/O08/O09；`:3217` |
| ingestion_source_region | document_id,page_index,x/y/width/height:float,crop_asset_id?,role,text_span,char_start?,char_end? | O07/O08/O09；`:3412` |
| ingestion_import_job | project_id,subject_id?,created_by_id,status,input_kind,input_text,extractor_version,progress_percent,problems:J,page_diagnostics:J,attempts,max_attempts,last_error,input_fingerprint,duplicate_of_id?,started_at:T?,finished_at:T? | O07/O08/O09/O12/O16/O18/O19/worker；`:3004` |
| ingestion_import_candidate | job_id,project_id,subject_id?,parent_candidate_id?,source_position_key,paper_revision_id?,answer_match:J,status,revision,draft_payload:J,machine_payload:J,review_issues:J,extractor_version,is_stub_output,duplicate_of_candidate_id?,reviewed_by_id?,reviewed_at:T?,layout_review_confirmed_at:T?,layout_review_note,publication_question_id?,publication_version_id?,publication_paper_item_id? | O07/O08/O09/O15–19/worker；duplicate_of_candidate 留默认null，当前上述服务未设置；`:2728` |
| ingestion_candidate_revision | candidate_id,revision,payload:J,review_issues:J,edited_by_id?,note | 仅 O15；`:2626` |
| ingestion_import_job_documents（缺失，目标须补） | Django 自动 through：id 自增、importjob_id、sourcedocument_id；双 FK cascade、pair unique | O07/O08/O09；Django `backend/apps/ingestion/models.py:168`；生成器遗漏 `dsh-plugin/scripts/gen_schema.py:193` |
| ingestion_import_candidate_source_regions（缺失，目标须补） | Django 自动 through：id 自增、importcandidate_id、sourceregion_id；双 FK cascade、pair unique | O07/O08/O09；Django `backend/apps/ingestion/models.py:235`；生成器遗漏同上；自动表/列名应在补生成器时用 through._meta 再确认 |
| exams_paper | subject_id,cycle_key,session_key,paper_code,title,source_kind,is_demo,effective_revision_id?=null,notes | O09 新建才写；不改旧纸；`:1780` |
| exams_paper_revision | paper_id,revision,spec_version_id?（此入口不传）,expected_session_count?,covered_session_count?,coverage_confirmed_by_id?,coverage_confirmed_at:T?,status=draft,note | O09；`:2041` |
| exams_paper_item | revision_id,position_key,parent_item_id?,question_version_id,answer_key_version_id?,max_score:D,is_scored,is_demo | O18；父材料后发布还 update 子 parent_item/updated_at；`:1909` |
| question_bank_question | subject_id,origin_type,current_published_version_id?,family_id?,content_lineage_id?,created_by_id?,is_demo,display_label | O18；family/lineage 默认null，无自动创建；`:7729` |
| question_bank_question_version | question_id,version,question_type,content:J,parent_material_version_id?,material_child_version_ids:J,practice_max_score:D?,estimated_seconds?,status,revision_reason,source_note,created_by_id?,published_at:T?,withdrawn_at:T?,withdrawn_reason,content_digest | O18 新建/发布/补父children；`:8185` |
| question_bank_source_link | question_version_id,region_id,role=stem,note | O18；`:8101` |
| question_bank_answer_key_version | question_version_id,version,answer_payload:J,source_type,verification_status,checked_by_id?,checked_at:T?,check_basis,source_region_id?,explanation_blocks:J,is_disputed,dispute_reason,supersedes_id?,created_by_id? | O18；`:7459` |
| question_bank_rubric_version | answer_key_version_id,version,criteria:J,total_score:D,usage_note,checked_by_id?,checked_at:T?,is_disputed | O18 主观题；`:8383` |
| knowledge_question_mapping | question_version_id,mapping_revision,node_id,is_primary,score_weight:D,template_id?,note | O18；`:3802` |
| practice_exposure_event | user_id,project_id,question_id?,question_version_id?,family_id?,content_lineage_id?,session_item_id?,kind,purpose,source,server_time:T,detail:J,reveals_answer | O02/O14/O15；`:6346` |
| audit_content_revision | actor_id?,entity_type,entity_id,action,project_id?,reason,before_digest,after_digest,detail:J | O09/O15/O16/O17/O18，明细见 §3/4；`:785` |
| audit_idempotency_record | user_id,route_scope,idempotency_key,request_fingerprint,status_code?,response_body:J?,resource_type,resource_id | §2 所有 I-Key；失败 rollback/release；`:908` |
| audit_outbox_event | topic,payload:J,status,attempts,max_attempts,available_at:T,dispatched_at:T?,claimed_at:T?,claim_token,lease_expires_at:T?,processed_at:T?,last_error,dedupe_key? | O08 extraction / O18 paper stats；`:1253` |
| audit_llm_run | §6.1 全字段（含4个J、cost_cents:D?） | O19/worker；相邻转写也写；`:1022` |
| audit_request_log | request_id,user_id?,method,path[:500],status_code?,duration_ms? | Python 中间件所有请求（含失败），写失败吞掉并 logger.warn；Node router 尚未写，应单列公共传输迁移，不误称已具备；`:1405`；`backend/apps/audit/middleware.py:58` |
| practice_answer_transcription（仅相邻依赖） | attempt_id,asset_id:text,origin,run_id?,status,raw_text,confirmed_text,confidence:float?,doubts:J,is_stub,decided_by_id?,decided_at:T?,note | §6.4，非20个 ingestion 操作写集；`:5725` |

没有本域对 learner state/evidence/grade/study task/search index 的直接写入；不将“AI 变式节点”当 knowledge mapping 已落库。outbox 的下游统计/搜索是否另有表写入，属于消费者实现范围，不能由 enqueue 反推已执行。

FK 顺序：先 user/project/subject → asset(source_document=null) → document(asset_id) → regions → job → through；Paper(effective_revision=null) → PaperRevision → candidates → candidate-region through → parent_candidate 补写 → revisions/audit。asset↔document 的环只有 crop 或迁入既有数据才需回填反向指针；普通上传不填（`dsh-plugin/src/store/schema.generated.ts:2425`、`:3217`）。

发布：Question(current_published_version=null)→QuestionVersion→AnswerKey→Rubric→Mappings/SourceLink→Question.current_published_version；PaperItem(parent_item=null) 可在父后补。材料有逻辑环：先创建父 draft 给 child FK，发布所有 child，最后发布父并填 children JSON；不能先发布父。candidate.publication_* 是普通 UUID **不是 FK**，variant run/source references 在 JSON 也不是 FK，须服务检查悬空（`backend/apps/ingestion/models.py:254`；`backend/apps/ingestion/services/core.py:849`）。

归档 import 已有 nullable-FK 两阶段规划，但目前 TABLES 无 through，不能宣称 existing 57-table 对账已验证 ingestion M2M。需把新增 through 纳入导出/导入/count/hash，对 nullable self-reference duplicate_of/parent_candidate、Question↔Version、Paper↔Revision、Asset↔Document 分两阶段；schema 更新仍从 generator 来，不手改 generated 文件（`dsh-plugin/src/migrate/archive.ts:123`；`dsh-plugin/scripts/gen_schema.py:193`）。

## 8. 推荐文件划分、批次与验收

以下均为**建议新增/扩展位置**，本次不创建代码或测试。避免写一个吞掉所有错误的通用导入器。

| 文件 / 函数 | 对应操作 / Python 依赖 | 黄金向量或验证 |
|---|---|---|
| `src/domain/ingestion/text_parser.ts`：parsePaste,parseAnswerPage,applyAnswerMatches,attachSourcePages,detectPageContinuations,attachCrossPageContinua | O06/O07/O09；`backend/apps/ingestion/services/text_parser.py:116`、`:540`、`:594`、`:668` | 建议 `scripts/gen_ingestion_text_golden.py`→`tests/golden/ingestion_text.json`，直接调用 Python 实函数；包含全部 segment/path/parse_issue，不在生成器重写 parser |
| `src/domain/ingestion/layout.ts`：issueForReason,reasonsNeedingReview,layoutReviewIssues；`pdf_layout.ts`：classifyPage,orderPageText,bboxForText | O09/O17/所有 refresh；`backend/apps/ingestion/services/layout.py:88`；`pdf_text.py:692` | `gen_ingestion_layout_golden.py`→`ingestion_layout.json`；标准化 fragments、threshold 边界与 issue 原文 |
| `src/ingestion/pdf.ts`：extractNativeText；`src/ingestion/storage.ts`：buildKey,save,open,exists；`src/ingestion/images.ts`：validateImage,stripMetadata | O01/O02/O05/O08/O09；`storage.py:62`、`core.py:32`、`pdf_text.py:242` | `gen_ingestion_pdf_golden.py`→`ingestion_pdf.json`（固定 fixtures bytes/hash + 每页 facts）；图片性质测试，原 PDF hash 严格相同 |
| `src/services/ingestion_sources.ts`：storeAsset,createTextDocument,createImageDocument,createPdfDocument,findDuplicateDocument,listSourceDocuments | O01/O03/O04/O05/O08/O09；`core.py:85`–`:270` | 存储故障/DB失败/重复跨 role、不公开 key |
| `src/services/ingestion_access.ts`：assetScope,sealedQuestionsForAsset,assertAssetDownloadAllowed,recordDownloadExposure,recordCandidateEditorialPreview | O02/O14/O15；`access.py:52`–`:200`、`api.py:675` | 真实关系图门禁；复用 `services/sealing.ts`，不能以 domain contamination 纯函数代替 exposure writer |
| `src/services/ingestion.ts`：createImportJob,createSourceRegion,createCandidate,refreshCandidateIssues,updateCandidate,ignoreCandidate,confirmLayoutReview,maybeCompleteJob,jobSummary,candidateSummary | O07–O18；`core.py:274`、`:410`、`:611`；`imports.py:208` | `gen_ingestion_review_golden.py`→`ingestion_review.json`，用事实适配器提供候选/版本/region/诊断输入；state/write-set 测试另做 |
| `src/services/ingestion_imports.ts`：startTextImport,startImageImport,startPdfImport,retryJob,preparePaperRevision,createPdfCandidates | O07/O08/O09/O12；`imports.py:30`、`:104`、`:377` | SQLite 集成：M2M、顺序、纸自然键、重复、答案匹配、状态/问题、回滚 |
| `src/services/ingestion_publish.ts`：publishCandidate,ensureMaterialVersion,writePaperItem,reconcileMaterialChildren | O18；`core.py:722`；扩展 `questions.ts` createQuestion/createAnswerKeyVersion/upsertRubricVersion；`exams.ts` createPaperRevision/addPaperItem | 复用 validateContent/answers、mapping，补齐 §4.4；不能用 sessions 的 trusted answer 选择器代替发布审批 |
| `src/domain/ingestion/variants.ts`：answerConsistencyProblems,proposedScore,variantDraftPayload；`src/services/variants.ts`：independentChecks,variantReviewIssues,proposeVariants,variantJobs | O19/O20/O18；`question_bank/services/variants.py:165`、`:397`、`:703` | `gen_ingestion_variants_golden.py`→`ingestion_variants.json`；纯规则向量 + DB duplicate/scope/partial failure 测试 |
| `src/services/ingestion_extraction.ts`：extractImageCandidate,applyExtraction,markExtractionFailed | O08 worker；`extraction.py:105`、`:239` | 注入 tests-only fake LlmPort；成功/拒绝/无配置/迟到；审计单行、无正式成绩 |
| `src/http/ingestion_routes.ts`：ingestionRoutes,normalizeIngestionRequest,runVariantResource；扩展 router multipart/raw Response | 全20操作，§2 为注册清单 | Request→Response 黑盒 + 静态/Remote 真宿主验收分开；原资源包装保留同步路径但加 normalized payload/精确 scope |

已有生成器范式：`dsh-plugin/scripts/gen_outline_golden.py:15` 设置 Django 环境后直接 import 实函数；prompts/validators 已有 ai_prompts/ai_validators golden，不重复写另一套 prompt。新生成器仅未来实现时运行，本次没有执行。

### 8.1 批次（最小首批无需数据库新表、文件或 AI）

| 批次 | 范围与依赖 | 独立出口 |
|---|---|---|
| B0 | text parser 纯函数 + O06；复用 requireProject/errors | Python 向量全等；空白、中文/emoji偏移、单选多答案、负号/单位、材料、编号 fallback；断言所有表/文件零写入。只声称服务/in-process 完成，不声称 DSH 动态路径可访问 |
| B1 | 补两 through 的 generator/schema/archive；ingestion core/serializers；O03/O04/O07/O10–17（asset editorial helper 依赖 exposure writer） | 文本创建→查询→revision patch→ignore，重放/冲突/所有权，候选 snapshot 旧issues、job完成；不需要 LLM/PDF/sharp |
| B2 | 补 questions/exams 发布缺口 + O18；paper stats 消费能力 | leaf→answer→rubric/mapping→publish→session冻结→submit 确定性判分；只验证真正闭环，不改判分模块。失败事务零半发布、材料先子后父、重复 paper position |
| B3 | private storage/sharp + multipart/raw response + O01/O02/O05/O08 手工退化 | 浏览器真实 multipart，按 scope/purpose/sealing 拒绝下载，哈希/重编码/缺文件与泄露防线；无模型仍可手工完成 |
| B4 | pdfjs adapter、layout/text provenance + O09 | 既有 PDF 逐页黄金对照；跨页与双栏题序、混合扫描、答案匹配需双确认、同卷复用及版本/覆盖未确认不计统计 |
| B5 | AI 异步事务/审计适配、extraction worker、O19/O20；转写作为相邻练习切片 | 无模型/无vision/非法输出/中途失败保留、迟到 revision、node范围与重算gate；tests-only fake port；生产无 stub；DSH static/Remote 链实际可达后才标传输完成 |

### 8.2 最高风险的五组显式测试

1. **事务/异步/幂等**：相同 key 同 normalized body 单副作用、异 body409；上传不参与指纹的字段保持 replay；claim 前校验顺序；变式第二次调用失败仍保留第一 candidate+两个 run；无配置单 unavailable run。参考 `backend/tests/integration/test_isolation_and_idempotency.py:289`、`backend/tests/integration/test_p2_variants.py:195`、`:931`。
2. **审批与迟到模型结果**：expected_revision冲突、旧issues审计快照、publication不增revision、layout确认不解除answer-match、ignored不可publish；extraction成功/失败/迟到不丢人工结构。参考 `backend/tests/integration/test_p0_2_regressions.py:341`、`backend/tests/integration/test_p2_layout_import.py:170`、`backend/tests/integration/test_p1_pdf_import.py:228`。
3. **PDF 逐页/字符/几何**：双栏阅读次序、跨页起始页与span、表格/公式、整份扫描拒绝/混合保留、geometry unavailable/cap4000、500诊断截断；特别补 numbered structure_only 空结果、多文件 answer消费重置/local_id碰撞/answer provenance丢失。fixtures 源 `backend/tests/support/pdf_builder.py:227`、`:275`、`:298`；测试类 `backend/tests/integration/test_p2_layout_import.py:170`、`:295`、`:393`、`:491`、`:610`、`:710`。
4. **发布写集与统计**：子题先发布/材料后补父 item；同卷重导不能同号再发；AI 强制 ai_generated、不得挂 official_past；Decimal 等分/填空sum/rubric full_clean 与回滚。参考 `backend/tests/integration/test_p1_pdf_import.py:246`、`:296`、`:314`；`backend/tests/integration/test_p2_variants.py:624`、`:753`、`:852`；`backend/tests/integration/test_p1_api.py:91`。
5. **文件隔离与编码**：外国项目/用户404，sealed裁图/整页/inline引用403，internal_review/验证会话门禁，含答案下载exposure、candidate GET dedupe；真实multipart、原始/重编码hash不等、metadata与尺寸、空/损坏/超限/缺字节、非图片 source-image现状。参考 `backend/tests/integration/test_ai_providers.py:214`、`backend/tests/integration/test_p0_regressions.py:558`、`:596`、`:627`；关系门禁以 `backend/apps/ingestion/services/access.py:59` 为逐分支基线。

验收时将“现状差异”单列：本文指出的缺陷/不明确行为不在移植中暗改；若决定修正，新增明确的行为决策与反例，再变更对拍预期。尤其不能以 03 中“schema 基本完成/AI 纯层完成”替代 M2M、异步事务、发布完整校验和实际宿主传输的证据。
