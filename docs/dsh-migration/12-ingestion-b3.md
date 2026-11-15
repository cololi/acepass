# 12 ingestion B3：私有存储 + multipart/raw 传输 + sharp 图片 + 下载门禁与曝光

日期：2026-11-06。范围：阶段 3 的 **ingestion 第四批（B3）**——O01 / O02 / O05 / O08。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准，实施规格见
[06-ingestion-port-spec.md](./06-ingestion-port-spec.md) §2/§3.1/§3.2/§3.4/§5.1。本文只记录本批次做了什么、
凭什么算完成、还差什么；Django 实测证据见 [12-ingestion-b3-probe.md](./12-ingestion-b3-probe.md)，
对拍差异见 [04-parity-findings.md](./04-parity-findings.md) §K。

## 0. 一句话结论

**四个操作上线**：真实 multipart 上传、私有对象存储、sharp 真实解码与去元数据重编码、四道下载门禁与
exposure 台账全部跑通。ingestion 累计 **17/20**（B2 13 + O01/O02/O05/O08）。`npm run verify` 双运行时
**502 条测试全绿 + Cordis 加载烟测通过**（450 → 502，新增 52）。

三件必须同时成立才算完成的事，本批次都做了：

1. **真实 Django 探针**：64 个 HTTP 请求（O01 20 / O02 19 / O05 10 / O08 15），记录状态码、错误信封、
   响应头、行级 delta 与 exposure 行；
2. **真实行 + 真实函数生成的黄金向量**：128 组（25 store / 18 keys / 5 dedupe / 26 gates / 9 downloads /
   9 assets / 11 image_sources / 8 image_imports）+ 17 份图片字节，重跑逐字节一致；
3. **HTTP 黑盒**：28 条用例用平台 `FormData`/`File` 打真实 multipart，覆盖 201/400/403/404/409 与幂等。

## 1. 本批次完成面

| 交付 | 位置 | 说明 |
|---|---|---|
| 私有存储 | `src/ingestion/storage.ts` | `buildKey`、`LocalPrivateStorage.save/open/exists/size/delete/absolutePath`、`mediaRootFor`、`configureStorage` |
| 图片 | `src/ingestion/images.ts`、`src/ingestion/sharp.ts` | `sniffImageFormat`、`validateImage`、`stripMetadata`；sharp 经 `createRequire` 解析（打包走裸名、检出走 `.deps`） |
| 来源写入 | `src/services/ingestion_sources.ts` | `assertAssetFields`、`storeAsset`、`createImageDocument`、`findDuplicateDocument`、`assetNamespace`、`assetSuffix`、`prepareAssetImage` |
| 下载门禁 | `src/services/ingestion_access.ts` | `openVerificationRuns`、`assetScope`、`sessionItemScope`、`referencesAsset`、`sealedQuestionsForAsset`、`assertAssetDownloadAllowed`、`recordDownloadExposure` |
| 图片导入 | `src/services/ingestion_imports.ts` | `startImageImport`（含 `image_ai` 分支与 outbox 入队） |
| 传输层 | `src/http/router.ts` | multipart 解析（`form`/`files`）、`Response` 直通、错误响应补 `nosniff` |
| 路由 | `src/http/ingestion_routes.ts` | O01/O02/O05/O08 + `AssetOut` 投影 + Ninja 文件参数错误形状 |
| 错误类型 | `src/services/errors.ts` | 新增 `DependencyUnavailable`（503 `dependency_unavailable`）：sharp 缺失时不能报「你的文件损坏」 |
| 黄金向量 | `tests/golden/ingestion_b3.json`（`scripts/gen_ingestion_b3_golden.py`） | 128 组 + 17 份素材；sha256 `f291cc88…ccb57b4`，重跑一致 |
| 测试 | `tests/ingestion_b3_images.test.ts`(14)、`ingestion_b3_http.test.ts`(28)、`ingestion_b3_golden.test.ts`(10) | 52 条 |
| 探针 | `scripts/probe_ingestion_b3.py` → `12-ingestion-b3-probe.{md,json}` | 64 例真实 HTTP |
| 依赖 | `package.json` | `sharp@0.35.5` 为运行时依赖；`npm run deps:sharp` 装到 `.deps/`（`dsh-plugin/node_modules` 是指向 `frontend/node_modules` 的软链，不能在里面 `npm install`） |

**schema 无变更**：本批次只写已有列（`ingestion_asset`、`ingestion_source_document`、`practice_exposure_event`、
`audit_outbox_event`），没有新表、新列、新约束，也没有数据迁移。

## 2. 为什么这算「移植」而不是「重写」

1. **决策对照**：`gen_ingestion_b3_golden.py` 在一次性 PostgreSQL 库里造真实行，调用真实
   `store_asset` / `create_image_document` / `find_duplicate_document` / `assert_asset_download_allowed` /
   `start_image_import`，把「行 + 决策 + 写集」冻结成 JSON；Node 侧灌同样的行、调同名函数、逐字段比。
2. **传输对照**：探针的 64 个请求钉住状态码、错误信封（含 `loc:["file","files"]` 这种 Ninja 细节）、
   四个下载响应头、`Content-Disposition` 用 asset id 而不是原文件名、两条 404 文案的差别。
3. **性质对照**（编码器不可能逐字节相等，06 §5.1）：存储对象的 **checksum 必须等于落盘字节的 sha256**、
   size 等于落盘长度、尺寸/格式保留、EXIF/ICC 全部消失、EXIF Orientation 不被应用（尺寸不变）、
   无损容器像素逐点相等、有损容器误差有上界。这些都在 `storedFacts()` 里逐项断言。
4. **零写入对照**：每个 case 记录 9 张表的行数（按项目过滤，与 `project_counts()` 同义），
   所以「多写一行/少写一行」会直接失败；拒绝类用例同时断言「一行都没写」。

覆盖的**易错语义**（不是 happy path）：

| 语义 | 为什么必须钉住 |
|---|---|
| 声明 MIME ≠ 真实格式 | PNG 字节声明 `image/jpeg` → 201，`content_type=image/jpeg`、键后缀 `.jpg`、**落盘是 PNG**；下载头也按声明发（K1） |
| 空字节的两条文案 | API 层是「上传内容为空」，service 层是「图片内容无法解析…」（K10） |
| role→sensitivity | 只有 O05/O08 按 role 推；O01 传 `answer_page` 仍是 `public_to_owner`（K2） |
| 门禁顺序 | 内部审核 → 封存 → editorial → contains_answers；`purpose=editorial` 在 contains_answers 之前判定（K3） |
| `allows_pre_submit_answers` 只看 mode | 传一个**已结束**的 verification session 仍然 403（K4） |
| exposure 关联 | 不传 `session_item_id` 时，即使 asset 与题目有 link，`question/version/family/lineage` 全 null（K13） |
| 写前开流 | exposure 在 `exists` 之后、`open` 之前写；开流失败仍留台账（K14） |
| 去重键 | 查重用**原始上传** sha256，document 存的是**重编码** sha256（K6） |
| 死代码 | O08 的「请至少上传一张图片」在 HTTP 上不可达（必填 File 先被 Ninja 拦下）；O05 的「来源角色无效」与 store_asset 的「资产角色无效」是两条消息（K5） |
| 非图片 MIME 的 image 文档 | O05 收 `text/plain` → `document_type=image`、`.bin` 键、无宽高（K11） |

## 3. 传输层：multipart 与 raw Response（含边界）

- `router.ts` 现在按 `Content-Type` 分流：`multipart/form-data` 走 `request.formData()`，把文本字段放进
  `ctx.form`（重名取**最后一个**，与 `request.POST.get()` 一致）、文件放进 `ctx.files`（保持 part 顺序，
  含 `field/filename/contentType/bytes`）；其余类型仍按 JSON 解析。
- handler 可以返回 `Response`（O02 的字节流），router 只补 `x-request-id`，不改任何业务头。
- 错误响应补了 `x-content-type-options: nosniff`：Django 的 `SecurityMiddleware` 对**每个**响应都加，
  探针 P22/P24/P26 可证；这是本批次顺带修掉的一处全局传输差异（K17）。
- **边界（未验证，不得声称）**：DSH 的 Fetch 注册表按**精确路径**索引，而 O01/O02/O05/O08 的路径都含
  `{project_id}` 等参数，因此**没有**挂到宿主 registry 上；本批次只声称「进程内 `Request`→`Response` 可达」。
  「DSH 宿主/Remote 通道能收到 multipart 并交给插件」属于阶段 6，未验证。`requestBody:'buffered'` 对二进制
  上传是否够用同样未在宿主验证。

## 4. 图片：sharp 与 Pillow 的等价边界

sharp 0.35.5 经 N-API 预编译二进制，在**系统 Node 24.22.2 与 DSH Electron Node 24.21 两个运行时**都加载并
完成真实解码（`npm run verify` 的两次 502 条测试都跑了图片用例，不是只在一个运行时验证）。

保留的语义：MIME allowlist → 10 MiB → 魔数识别 → 格式 allowlist → 25 M 像素 → 全量解码；重编码保留
格式/尺寸/通道，JPEG 的 CMYK 转 sRGB，**不**应用 EXIF 旋转，元数据（EXIF/ICC/XMP）全部剥离，
重编码失败回退原始字节（`reencoded: false`）。

两处**有意差异**（都写进 04 §K，也都在测试里显式断言）：

1. **调色板 PNG**：Django 的 `Image.new("P", …)` 只复制索引、不复制调色板，于是存储出来的图**颜色变了**
   （黄金向量：mean 20.64 / max 105 通道误差），却仍标 `mode=P`。本移植用 sharp 展开调色板，颜色**逐点保留**。
   这是「Django 丢数据、移植更正确」的差异，按现状不改回。
2. **sharp 的 PNG 编码器不是 Pillow 的逐字节复制**：干净 PNG 在 Pillow 里重编码后字节不变（`encoded_equals_raw: true`），
   在 sharp 里会变（363 → 3263 字节）。于是 `Document.checksum` 不再等于原始上传的 sha256，**同一张图二次上传
   在 Django 里能命中去重、在移植里不命中**。算法（用原始 sha 查、存重编码 sha）完全一致，差异只来自编码器；
   修复它需要 `raw_checksum` 列或条件化重编码，属独立决策，本批次**不暗改**（06 §5.1 正是要求把这个差异写出来）。

另有两处**共有**属性，记录以免将来被单方面「修好」：WebP 的重编码在两边都是有损（Pillow 默认 quality 80，
sharp 默认 80），所以无损 WebP 上传后会被存成有损；JPEG 亦然。

## 5. 门禁与曝光

`assertAssetDownloadAllowed` 的顺序与文案逐字对齐（探针 P26–P37）：

1. `internal_review` 且非 staff → 403「该文件仅限内部审核使用」。**DSH owner 不被当作 staff**（读
   `accounts_user.is_staff`，本机用户是 false），所以 internal_review 资产在本部署里**不可下载**——这是
   事实，不是缺陷，用户需要时得显式把该用户标成 staff。
2. 封存：`sealedQuestionsForAsset` 走四条显式关系（crop region → source link、整页 document → region → link、
   `AnswerKeyVersion.source_region.crop_asset`、封存题版本的 `image` block），命中即 403 并带
   `{reason, question_id, asset_id, action}`；多道封存题按 question id 字符串排序报第一道。
3. `purpose=editorial` 且项目有未结束的 verification/mock → 403；否则放行（**并且仍然写 exposure**）。
4. `contains_answers`：带 session 时只看 `mode`（practice 放行，其余 403），不带 session 时看是否有未结束的
   验证会话。

`recordDownloadExposure` 只在 `contains_answers` 上写，`kind=answer_delivered`、`source=asset_download`、
`reveals_answer=true`、`detail={asset_id, role, server_time}`；`purpose` 非法值回落 `practice`。
没有 session_item 时 question/version/family/lineage 全为 null（探针 P29 的真实形态）。

## 6. 验证

```bash
cd dsh-plugin
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
npm run deps:sharp                    # 首次：把 sharp 装进 .deps（软链的 node_modules 不能直接装）
npm run golden:ingestion-b3           # 128 组向量（真实 PostgreSQL 行 + 真实函数）
npm run verify                        # typecheck → build → 502 测试（系统 Node）→ 502（DSH Electron Node）→ 加载烟测
../backend/.venv/bin/python scripts/probe_ingestion_b3.py   # 64 例真实 HTTP
```

结果：

- 系统 Node **24.22.2**：`502 pass / 0 fail`；DSH 运行时（Electron 44.7 / Node 24.21）：`502 pass / 0 fail`；
  `load-smoke OK: plugin loaded into real Cordis + dsh-tools; tool registered and executed`。
- 黄金生成器重跑与已提交 fixture **逐字节一致**（sha256 `f291cc88b69930688cb0d7c6f1fb4f8887ad992b9b33bb58266eb27b0ccb57b4`）。
- 探针 64 例、两次运行 sha256 一致（`3c395d41…c44a9`），报告见 [12-ingestion-b3-probe.md](./12-ingestion-b3-probe.md)。

## 7. 未完成 / 下一批前置

- **B4**：O09（pdfjs 适配、逐页版式黄金对照）。`src/ingestion/pdf.ts` 不存在，PDF 校验矩阵、page_map、
  版式分类全部未移植。
- **B5**：O19/O20 与 extraction worker。O08 的 `image_ai` 分支**已实现并有写集测试**（`startImageImport`
  的 outbox 入队、`vision_extraction_queued` 的 info/warning 两种 severity、stub 标注），但 HTTP 端点固定
  `useVision: false`——没有视觉 provider 接进来，且消费 `ingestion.extract_candidate` 的 worker 属于 B5，
  所以**不声称视觉链路已通**。
- **analytics 9 个操作**未开始。
- 未覆盖/未验证（不猜）：`is_staff=true` 放行 internal_review（只有非 staff 的 403 有实测与向量）、
  同键 `in_flight` 409 与并发双写、`storage.save` 的 `.part` 竞态、O08 的 `subject_id` 跨项目（与 O05 共用
  `require_subject`，但未单独取证）、`store_asset(reencode=False)` 的直接调用（只经 PDF 路径间接覆盖）、
  sharp 缺失时的端到端 503（只断言了错误契约，因为本机装了 sharp）。
- 传输边界同 B0/B1/B2：动态路径仍只在进程内可达，阶段 6 的 Remote 通道承接。

## 8. 回滚面

业务代码是**纯增量**：删除 `src/ingestion/`（两个文件）、`src/services/ingestion_sources.ts`、三个新测试与
fixture/生成器/探针；`src/services/ingestion_access.ts` 回退到只留 `recordCandidateEditorialPreview`；
`src/services/ingestion_imports.ts` 去掉 `startImageImport`；`src/http/ingestion_routes.ts` 移除 4 条路由与
`assetOut`/`requireFilePart`/`fileParts`/三个 handler；`src/http/router.ts` 的 multipart/Response 支持可以保留
（对既有路由无行为影响，除新增的 `nosniff` 头）；`package.json` 去掉 `sharp`、`deps:sharp`、
`golden:ingestion-b3`。

**数据面**：本批次没有 schema 变更，回滚不需要动数据库；已写入的 `ingestion_asset` / `practice_exposure_event`
行在新代码缺失时不会被读取到（O01/O02 路由不存在即 404），但**文件已落盘**——回滚后需要人工清理
`<dataRoot>/private-media` 下的对象（本批次没有删除命令，孤儿文件是已知运维面，见 06 §5.1）。
