# 12 ingestion B3 探针：O01 / O02 / O05 / O08（Django 实测）

日期：2026-11-06。目标：在移植之前，用**真实 Django + 真实 PostgreSQL** 记录四个资产/图片操作的状态码、
错误信封、响应形状、响应头与行级副作用。本文所有数字与正文都来自同目录的
[12-ingestion-b3-probe.json](./12-ingestion-b3-probe.json)（由 `dsh-plugin/scripts/probe_ingestion_b3.py`
生成，64 个请求，一次性测试库，跑完即销毁），不来自规格文档的推测。

覆盖：O01 `POST .../assets`、O02 `GET .../assets/{asset_id}`、O05 `POST .../source-documents/image`、
O08 `POST .../imports/images`。用例编号 P01–P64：O01 = P01–P20，O02 = P21–P39，O05 = P40–P49，
O08 = P50–P64。

## 0. 结论（先看这七条）

1. **O01 不做 MIME 与真实格式的交叉校验**：PNG 字节配 `image/jpeg` 返回 201，`content_type` 落成
   `image/jpeg`、对象键后缀 `.jpg`，而存储的字节仍是 PNG（P09，magic `89504e47…`）。下载时这个声明的
   `Content-Type` 会原样回给客户端。
2. **`sensitivity` 不由接口推断，只有 O05/O08 按 role 推**：O01 传 `role=answer_page` 仍是
   `public_to_owner`（P02）；O05 的 `answer_page` → `contains_answers`（P41），O08 亦同（P63，asset 与
   document 两级都是 `contains_answers`）。
3. **O02 门禁顺序是 内部审核 → 封存 → editorial → contains_answers**：P28 打的是
   `answer_page/contains_answers` 资产并带 `purpose=editorial`，拿到的是 editorial 那条文案
   （「…可能包含答案的来源文件…」）而不是 contains_answers 那条（「…含答案的来源文件…」），证明
   editorial 判定先于 contains_answers；封存分支又排在二者之前，与 purpose 无关
   （P33–P37 全部 403 `purpose_not_allowed`）。
4. **exposure 只在 `contains_answers` 上写，但 editorial 放行后也写**：P29 是 editorial + 无验证会话，
   返回 200 并写入一条 `purpose=editorial`、`question/question_version/session_item` 全为 `null` 的
   exposure；`purpose` 传非法值则回落 `practice`（P31）。
5. **O08 的去重键是「原始上传字节的 sha256」对「document 上存的重编码 sha256」**：两者相等才命中。
   Pillow 对干净 PNG 的重编码是逐字节幂等的（P01 上传 sha256 == asset.checksum），所以同一张干净图
   二次上传会命中（P52）；一旦原图带 tEXt 之类的元数据，重编码会改变字节，同一份原始字节再上传**不命中**
   （P53 新建了第二份 document）。
6. **O08 的 `files=[]` 到不了「请至少上传一张图片」**：`list[UploadedFile] = File(...)` 是必填，空列表在
   multipart 里不产生任何 part，Ninja 先返回 400 `请求参数校验失败`，`loc=["file","files"]`（P55）。
   同一路径上「先逐图校验再 claim」是真实的：P56 第二张损坏，零写入且**没有幂等记录**。
7. **O08 的视觉分支（B5）在响应返回前就已经跑完**：`after_commit_dispatch()` 在测试设置下是内联的，
   响应体仍是派发前的 summary（只有 `vision_extraction_queued`），而 DB 里的 job 已追加
   `vision_extracted_stub`、候选 revision=2/`is_stub_output=true`、outbox 1 行 `processed`、
   `audit_llm_run` 1 行 `succeeded/is_stub=true`（P64）。**本批不声称视觉分支已移植。**

## 1. 环境与方法

- Python 3.12（`backend/.venv`）、Django 5.2.17、django-ninja、Pillow 11.3.0、PostgreSQL 16（127.0.0.1:5432）。
  设置模块 `config.settings.test`（`AI_PROVIDER` 默认为 `stub`，`ACEPASS_INLINE_TASKS=True`）。
- **隔离**：建库前把 `connection.settings_dict["TEST"]["NAME"]` 固定为 `test_acepass_b3_probe`；建库后把
  `PRIVATE_MEDIA_ROOT` 指到 `/tmp/acepass-b3-probe-media`（先 rmtree 再 mkdir）并 `reset_storage_cache()`。
  跑完 `destroy_test_db`，退出码 0。
- **真实 multipart**：全部走 `django.test.Client` 的真 multipart 通道（`SimpleUploadedFile` + 字段字典，
  多文件用同名列表），没有手工拼 multipart 字节。
- **图片素材**由 Pillow 现场生成、确定性：`solid_png(tag)` 用 `zlib.crc32(tag)` 推尺寸与颜色，每个用例
  一张不同的图（避免用例之间意外命中 O08 去重）；`tagged_png()` 带一个 tEXt 块；截断 JPEG、EXIF
  Orientation=6 的 JPEG、GIF、BMP、`1900×1900`（固定 seed `random.Random(20260301)`，生成 10,847,106 字节）、
  `6000×5000` 纯色 PNG、纯文本字节。
- **夹具**：两个用户/项目（A 属 owner，B 属 other）、两个科目；practice / verification 两个会话各带一个
  SessionItem，另一个用户的会话带一个 SessionItem；三道题使用**固定 UUID**（`1111…`、`2222…`、`3333…`），
  使「多道封存题报哪一道」在多次运行间可比。O02 的 `contains_answers`/`internal_review` 资产由
  `store_asset` 直接建（O01 无法设 sensitivity，O05 在本文件里编号靠后），这点在用例标题里写明。
- **记录**：`request{method,path,query,form,idempotency_key}`（form 里文件只记文件名/声明 MIME/字节数/
  sha256）、`status`、`response`、`response_field_order`、`response_headers`（只取 Content-Type、
  Content-Disposition、X-Content-Type-Options、Cache-Control）、`checks`（行级 delta、新建的 asset /
  source_document / exposure_event 行、job/candidate 行、幂等行、outbox、LLMRun）。二进制下载另记
  `body_sha256` / `body_bytes` / `body_hex16`。
- **规范化**：所有 UUID 换成符号名（`ASSET_P01`、`DOCUMENT_P41`、`EXPOSURE_01`…，未命名的先按出现顺序
  记 `REF_nnn`，其后拿到真名再回填）；所有时间戳换成 `"<now>"`（含 exposure 的 `server_time` 与
  `detail.server_time`）；`object_key` 只记形状（段数 / namespace / 前缀长度 / token 长度 / 后缀）；
  图片 asset 的 checksum 记 `<reencoded>`，非图片记真实 hex。
- **可重复性**：同一脚本连续两次运行的 `shasum -a 256` 均为
  `3c395d411b5158745ee03d858dcb0f2a044c15ff458730c09eb3ee71675c44a9`。

## 2. 逐例结果

### 2.1 O01 `POST /api/v1/projects/{project_id}/assets`（P01–P20）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P01 | 默认 role 上传 PNG | 201 | AssetOut 字段顺序 `id,project_id,role,sensitivity,content_type,size_bytes,width,height,checksum,original_filename,download_url`；`role=past_paper_page`、`sensitivity=public_to_owner`、43×41；对象键 5 段 `namespace=source/前缀2位/32位token/.png`；asset delta 1，无 document/审计/outbox |
| P02 | `role=answer_page` | 201 | `sensitivity` 仍是 `public_to_owner`（O01 不看 role） |
| P03 | `role=stem_crop` | 201 | 对象键 `namespace=region` |
| P04 | 空文件 | 400 | `invalid_input / 上传内容为空 / details={}` |
| P05 | role 非法 | 400 | `资产角色无效`，`details={role:"bogus_role"}` |
| P06 | 截断 JPEG | 400 | `图片内容无法解析，文件可能损坏或不是真实图片` |
| P07 | GIF | 400 | `仅支持 JPEG/PNG/WebP 图片`，`details={content_type:"image/gif"}` |
| P08 | BMP | 400 | 同上，`details={content_type:"image/bmp"}` |
| P09 | PNG 字节 + `image/jpeg` | 201 | 通过校验；落 `content_type=image/jpeg`、键后缀 `.jpg`，但存储字节是 PNG（`89504e470d0a1a0a`），尺寸 54×46 |
| P10 | `text/plain` 非图片 | 201 | 保存原始字节；`width/height=null`；键后缀 `.bin`；checksum = 原始字节 sha256 |
| P11 | >10 MiB 的 PNG | 400 | `图片超过大小上限 10 MiB`（上传 10,847,106 字节） |
| P12 | 6000×5000 | 400 | `图片像素超过上限，请先裁剪或压缩`（30,000,000 px） |
| P13 | 304 字文件名 | 201 | `original_filename` 截到 255 |
| P14 | 中文+引号文件名 | 201 | 逐字节原样（`试卷 "第一页" 副本.png`） |
| P15 | 缺 `file` | 400 | `请求参数校验失败`，`details.errors=[{type:"missing",loc:["file","file"],msg:"Field required"}]` |
| P16 | JSON body 打 multipart 端点 | 400 | 与 P15 完全相同的信封（`loc=["file","file"]`），没有 415/422 |
| P17 | 外来项目 | 404 | `not_found / 项目不存在或无权访问` |
| P18 | 匿名 | 401 | `unauthorized / 请先登录`，`details={}` |
| P19 | 同一份字节二次上传 | 201 | 新 asset、新对象键、**同一 checksum**；同 checksum 共 2 行（不去重） |
| P20 | EXIF Orientation=6 的 JPEG | 201 | 存储尺寸仍 120×80（**不自动旋转**）；`Exif` 标记被剥离；上传字节 sha256 ≠ asset.checksum |

### 2.2 O02 `GET /api/v1/projects/{project_id}/assets/{asset_id}`（P21–P39）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P21 | public_to_owner 图片 | 200 | `Content-Type=image/png`；`Content-Disposition=inline; filename="{asset.id}"`；`X-Content-Type-Options=nosniff`；`Cache-Control=private, no-store`；body 136 字节，sha256 == asset.checksum，前 8 字节 `89504e470d0a1a0a` |
| P22 | asset 不存在 | 404 | `文件不存在或不属于当前项目` |
| P23 | 外来项目路径 | 404 | `项目不存在或无权访问`（project 先查） |
| P24 | 磁盘缺字节 | 404 | `对象不存在或不在当前权限范围`、`details={}`；asset 行仍在；**不写 exposure** |
| P25 | contains_answers + practice item | 200 | 写 1 条 exposure：`kind=answer_delivered`、`purpose=practice`、`source=asset_download`、`reveals_answer=true`、question/version/item 三列全填、`detail={asset_id,role,server_time}` |
| P26 | verification 活动会话的 item | 403 | `当前会话模式在提交前不允许查看含答案的来源文件`，`details={}` |
| P27 | 无 session，项目有未结束 verification | 403 | `存在未结束的验证/考试会话，暂不能查看含答案的来源文件` |
| P28 | `purpose=editorial` + 未结束 verification | 403 | `存在未结束的验证/考试会话，暂不能查看可能包含答案的来源文件；请先结束验证`（editorial 判定早于 contains_answers） |
| P29 | editorial，verification 已结束 | 200 | 放行，**仍写 exposure**：`purpose=editorial`、`question/question_version/session_item` 均为 `null` |
| P30 | session_item 属于别人 | 404 | `题项不存在或不属于该项目` |
| P31 | `purpose=bogus_purpose` | 200 | 照常返回字节；exposure 的 `purpose` 回落 `practice`（其余同 P25） |
| P32 | internal_review + 非 staff | 403 | `该文件仅限内部审核使用`，`details={}` |
| P33 | 封存① crop region 的 `crop_asset` | 403 | `该文件包含已封存题目的原始内容（题目 封存甲）：{封存原因}，因此不能读取原页或答案文件。`，`details={reason:"sealed_question_policy",question_id,asset_id,action:"读取原页/答案文件"}` |
| P34 | 封存② 整页 `document.asset` | 403 | 同上；`asset_id` 是整页资产 |
| P35 | 封存③ `AnswerKeyVersion.source_region.crop_asset` | 403 | 同上；只走 crop_asset，不查答案页整页 document |
| P36 | 封存④ 封存题版本的 image block | 403 | 同上；关系来自 `content.blocks[kind=image].asset_id` |
| P37 | 两道题都被封存 | 403 | 报 **question id 排序第一道**（固定 `2222…` < `3333…` → 题目「封存甲」） |
| P38 | 与封存题无关的用户附件 | 200 | 正常下载，`inline`（image/*） |
| P39 | 非图片 asset | 200 | `Content-Disposition=attachment; filename="{asset.id}"`；body 等于上传的 29 字节文本 |

### 2.3 O05 `POST /api/v1/projects/{project_id}/source-documents/image`（P40–P49）

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P40 | 正常图片来源 | 201 | DocumentOut 字段顺序 `id,project_id,subject_id,title,document_type,role,sensitivity,source_type,source_note,usage_scope,checksum,asset_id,raw_text_preview`；`document_type=image`、`source_type=user_upload`、`checksum == asset.checksum`、`raw_text_preview=""`；asset delta 1 + document delta 1 |
| P41 | `role=answer_page` | 201 | `sensitivity=contains_answers`（asset 与 document 两级） |
| P42 | role 非法 | 400 | `来源角色无效`，`details={}` |
| P43 | 空文件 | 400 | `上传内容为空` |
| P44 | `text/plain` 非图片 | 201 | 仍落 `document_type=image` + `source_type=user_upload`；asset `content_type=text/plain`、无宽高、键后缀 `.bin`；document.checksum = asset.checksum（原始字节） |
| P45 | GIF | 400 | `仅支持 JPEG/PNG/WebP 图片`（`store_asset` 的图片 allowlist） |
| P46 | title/source_note/usage_scope 超长 | 201 | 请求 400/600/300 字 → 落库 300/500/200 |
| P47 | 跨项目 subject_id | 404 | `科目不存在或不属于该项目` |
| P48 | `subject_id=""` | 201 | 响应 `subject_id=null` |
| P49 | 外来项目 | 404 | `项目不存在或无权访问` |

### 2.4 O08 `POST /api/v1/projects/{project_id}/imports/images`（P50–P64）

`AI_PROVIDER=none`（P50–P63）→ manual 路径；P64 临时改为 `stub`（B5）。

| # | 用例 | 状态 | 关键事实 |
|---|---|---|---|
| P50 | 单张（manual） | 201 | `input_kind=image_manual`、`extractor_version=manual-image-v1`、`status=awaiting_review`、`problems=[manual_structure_required]`；候选是空壳：`answer_status_known=false`、`needs_manual_structure=true`、`review_issues=[too_few_options,answer_unknown,subject_missing]`、整页 region `(0,0,1,1,past_paper_page)`；delta：asset/document/job/candidate/region/幂等各 1 |
| P51 | 两张 | 201 | document/candidate/region 各 2，job 1；`document_ids` 与上传顺序一致 |
| P52 | 与已有 document 完全重复 | 201 | asset/document delta **0**；job 复用 `DOCUMENT_P41`（其 role/sensitivity/subject 不被本次 `role=answer_page`+subject 覆盖）；`problems` 追加 `duplicate_source_file`；job.subject 用请求的科目 |
| P53 | 同一原始字节（带 tEXt）再导入 | 201 | **未命中**去重：新建 asset+document；原因见 §0.5（document 存重编码 checksum，而重编码丢 tEXt） |
| P54 | 新旧混合 | 201 | 只导入新的那张（document delta 1）；旧的一张进 duplicates，`problems` 有 `duplicate_source_file` |
| P55 | `files=[]` | 400 | `请求参数校验失败`，`loc=["file","files"]`；「请至少上传一张图片」在 HTTP 上不可达 |
| P56 | 第二张损坏 | 400 | `图片内容无法解析…`；零写入，**且没有幂等记录**（校验早于 claim） |
| P57 | 缺 Idempotency-Key | 409 | `idempotency_conflict / 缺少 Idempotency-Key 请求头 / details={}` |
| P58 | 同键同载荷（第一次） | 201 | 写 1 条幂等记录，`resource_type=import_job`、`resource_id` 指向该 job |
| P59 | 同键同载荷重放 | 201 | 返回**存储体原样**（含相同的 `created_at`），`replay_body_equals_first=true`，行 delta 0 |
| P60 | 同键不同 checksums | 409 | `相同幂等键使用了不同请求内容`，`details={route_scope:"imports.create_images:{project}",reason:"same_key_different_payload"}`，零写入 |
| P61 | title 不参与指纹（第一次） | 201 | `title=标题甲` |
| P62 | 同键同图、仅改 title | 201 | 仍然 replay，响应与 P61 全等（指纹只含 checksums/subject_id/role） |
| P63 | `role=answer_page` | 201 | asset 与 document 的 `sensitivity` 都是 `contains_answers`，asset `role=answer_page` |
| P64 | stub 视觉分支（B5） | 201 | 响应：`input_kind=image_ai`、`extractor_version=vision-v1`、`problems=[vision_extraction_queued]`（stub 文案带「测试/演示 stub」）；返回后 DB：job 追加 `vision_extracted_stub`、候选 revision 2 / `is_stub_output=true` / draft 换成 stub 结构、outbox 1 行 `ingestion.extract_candidate`（`processed`，dedupe `extract-candidate:{candidate}`）、`audit_llm_run` 1 行 `stub/extract_question/p0-extract-v1/succeeded/is_stub=true` |

## 3. 关键观测

**对象键与重编码。** 键恒为 5 段 `{owner}/{project}/{namespace}/{token前2}/{32hex}.{suffix}`，namespace 只由
role 决定（`stem_crop/material_crop/answer_crop→region`、`past_paper_page/answer_page→source`、
其余 `uploads`），suffix 只由**声明的** `content_type` 决定（`text/plain→bin`）。`strip_metadata` 用
Pillow 把像素复制到同 mode/size 的新图再保存：干净 PNG 重编码逐字节幂等（P01 上传 sha256 与 asset
checksum 相等），带 EXIF 的 JPEG 会被剥离（P20 两者不等），格式按**检测到的**格式保存（P09 存成 PNG）。

**O02 的四条 header 与 body。** 200 恒为 `Content-Type={asset.content_type}`、
`Content-Disposition={inline|attachment}; filename="{asset.id}"`（是 id，不是原文件名）、
`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`；body 与磁盘字节逐字节一致。
错误响应只有 SecurityMiddleware 的 `nosniff`，没有后两个头。

**exposure 的触发面。** 只有 `contains_answers` 才写；写入发生在 `storage.exists` 之后、`open` 之前
（P24 缺字节时 0 条）。`question/question_version/family/content_lineage` 全部来自 session_item（无
session 时为 null，如 P29），`detail` 只含 `{asset_id,role,server_time}`。purpose 允许值
`practice/verification/editorial/preview`，其余回落 `practice`（P31）。

**封存关系的四条路径互不依赖。** P33/P34/P35/P36 各用一条独立关系把同一个封存题连到四个不同资产，
四例都 403 且 `details` 只差 `asset_id`；P38 的无关附件 200，说明实现不按「项目里有封存题」一刀切。
P37 证明多题命中时报 `sorted(question_id)` 的第一道，并把该题的 `display_label` 写进 message。

**O08 的幂等指纹与去重是两件事。** 指纹是 `{checksums, subject_id, role}`（P62 证明 title 不在内）；
去重是逐张 `find_duplicate_document(project, checksum)`（P52 命中、P53 不命中）。幂等 claim 在逐图校验
**之后**才写（P56 无幂等行）；同键同载荷重放返回存储的 job summary 且零写入（P59）。

## 4. 与 06 规格的差异 / 需要写进实现的事实

1. **§3.4 把「无 files → I『请至少上传一张图片』」写成 HTTP 可见行为，实际不可达**：空列表在 multipart
   里不产生 part，django-ninja 的必填校验先返回 400 `请求参数校验失败`（P55）。该分支只能由内部调用触发。
2. **§5.1 说「O05 也未强制图片 MIME」，实测更进一步**：非图片 MIME 会被完整落成
   `document_type=image` + `source_type=user_upload`，无宽高，键后缀 `.bin`，`document.checksum` 等于原始
   字节 sha256（P44）。只把它写成「不强制 MIME」会漏掉「仍然以 image 文档落库」这一点。
3. **§5.1 的「没有严格 MIME==detected 检查」需要补一句**：不仅不检查，错误的 `content_type` 会被持久化，
   并在 O02 下载时原样作为 `Content-Type` 返回，而对象键后缀也跟着声明的 MIME 走（P09：`.jpg` + PNG 字节）。
4. **§3.2 只写了「contains_answers 才写 exposure」，没写 editorial 放行后的形态**：P29 里
   `purpose=editorial` 且无 session，照样写一条 `kind=answer_delivered`、`purpose=editorial`、
   `question/question_version/session_item` 全为 `null` 的 exposure。实现时必须保留「无 item 也写」这条。
5. **§3.2 门禁顺序实测与文档一致**（internal_review → 封存 → editorial → contains_answers）。需要注意
   editorial 分支是 `return` 式的：没有未结束验证时它直接放行，不再进入 contains_answers 判定，因此
   `purpose=editorial` 的 200 不依赖资产的 sensitivity（P28 的 403 与 P29 的 200 是同一资产）。
6. **§5.1 的「同原图二次上传不一定命中」可以给出确定判据**：命中与否取决于「原始字节 sha256」是否等于
   「重编码后 sha256」。干净 PNG 二者相等（命中），带 tEXt 的 PNG 或带 EXIF 的 JPEG 二者不等（不命中）。
   现表没有 raw_checksum 列，Node 侧若照抄该行为，这个不对称会保留（P52/P53/P20）。
7. **§3.4 的「返回的是任务派发前的 summary」在测试设置下更极端**：派发是内联同步执行的，请求返回前
   视觉任务已经跑完，响应体却没有 `vision_extracted_stub`；断言必须从 DB 读 job/candidate，不能从响应读（P64）。
8. **O02 的 404 有三种文案**：project 先查（`项目不存在或无权访问`）→ asset
   （`文件不存在或不属于当前项目`）→ session_item（`题项不存在或不属于该项目`）→ 磁盘缺字节走
   `Http404` 映射的 `对象不存在或不在当前权限范围`（P22/P23/P24/P30）。四者对客户端都是 `not_found`。

## 5. 未覆盖

- **视觉分支的模型侧**（P64 只用 `AI_PROVIDER=stub`）：真实 provider 的失败/超时/拒绝、`LlmRun` 的
  token/成本字段、失败后候选保留策略都未测，属 B5。
- **并发**：同键并发 claim（`in_flight`）、同图并发上传的双写、`storage.save` 的 `.part` 竞态都未测。
- **O08 的 `subject_id` 跨项目**：只测了 O05 的跨项目 subject（P47）；O08 的 `require_subject` 走同一
  helper，未单独取一条证据。
- **O01/O05 的 subject 跨项目参数**：O01 不接受 subject 表单字段，因此未测。
- **`source_kind`/PDF 相关（O09）**、O03/O04/O06/O07/O10–O20 不在本批范围。
- **多文件 `Content-Disposition` 与 `original_filename` 编码**（RFC 5987 `filename*`）：只用了 ASCII + 中文
  文件名，未测试非 ASCII 下载头的编码形式——实现里 `filename` 用的是 asset id，所以本批未触及。
- **`is_staff=true` 的 internal_review 放行**：P32 只测了非 staff 的 403，未测 staff 的 200。
