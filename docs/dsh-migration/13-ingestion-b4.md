# 13 ingestion B4：pdfjs 适配层 + 版式分类 + O09 PDF 批量导入

日期：2026-11-06。范围：阶段 3 的 **ingestion 第五批（B4）**——O09（`POST .../imports/pdf`），以及它依赖的
两层新基础设施：`pdfjs-dist` 适配层与纯几何/文本的版式分类。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准，实施规格见
[06-ingestion-port-spec.md](./06-ingestion-port-spec.md) §3.5 / §5.2 / §5.3 / §5.4 / §8。本文只记录本批次
做了什么、凭什么算完成、还差什么；Django 实测证据见 [13-ingestion-b4-probe.md](./13-ingestion-b4-probe.md)，
对拍差异见 [04-parity-findings.md](./04-parity-findings.md) §L。

## 0. 一句话结论

**O09 上线，ingestion 累计 18/20**（B3 17 + O09；剩 O19/O20 属 B5）。原生文字 PDF 的文本层提取、逐页
版式诊断、结构解析、答案页匹配、Paper/PaperRevision 登记与候选写集全部跑通，且**没有一行是猜的**：
`npm run verify` 双运行时 **523 条测试全绿 + Cordis 加载烟测通过**（502 → 523，新增 21）。

三件必须同时成立的事，本批次都做了：

1. **真实 Django 探针**：40 例 HTTP（O09 32 例 / O15 3 / O17 1 / O18 4），记录状态码、错误信封原文、
   逐页诊断、候选 issue 顺序、paper/revision 字段与行级 delta；
2. **真实行 + 真实函数生成的黄金向量**：PDF 侧 7 份真实 PDF × 逐页事实 + 9 种拒绝 + 44 条版式纯函数向量
   （另有 normalise 8 / clamp 7 / bbox 7 / page_map 5 / estimate_width 8）；写集侧 **12 组成功写集 + 6 组
   拒绝**（14 份夹具 PDF）。两个生成器都重跑逐字节一致；
3. **HTTP 黑盒**：12 条用例用平台 `FormData`/`File` 打真实 multipart，覆盖 201/400/404/409、幂等重放与
   版式门禁。

## 1. 本批次完成面

| 交付 | 位置 | 说明 |
|---|---|---|
| PDF 适配层 | `src/ingestion/pdf.ts` | `extractNativeText`、`loadPdfjs`、`resetPdfjsCache`、`pageBbox`、`PDF_MESSAGES`；pdfjs 经 `createRequire` 解析（打包走裸名、检出走 `.deps`），缺失时 `DependencyUnavailable`(503) |
| 版式纯逻辑 | `src/domain/ingestion/pdf_layout.ts` | `makeFragment`、`estimateWidthPt`、`pageBox`、`pageNotes`、`lines`、`xClusters`、`joinLine`、`detectColumns`、`columnMajorText`、`detectTableGrid`、`detectFormulaTokens`、`classifyPage`、`orderedPageText`、`buildPage`、`diagnosticRow`、`clampBbox`、`bboxForText`、`normalise`、`pageMap`、`visibleCharacters` |
| 来源写入 | `src/services/ingestion_sources.ts` | 新增 `createPdfDocument`（PDF 不重编码，`checksum` 就是上传字节的 SHA-256） |
| 导入服务 | `src/services/ingestion_imports.ts` | 新增 `preparePdfUploads`（异步：MIME + 提取 + checksum）、`startPdfImportPrepared`（同步：单事务全部写集）、`startPdfImport`（测试用包装）；`PDF_EXTRACTOR_VERSION='pdf-text-v2'`、`MAX_JOB_PAGE_DIAGNOSTICS=500` |
| 试卷登记 | `src/services/exams.ts` | 新增 `getOrCreatePaperForImport`、`createPaperRevisionForImport`（自然键复用、每次导入新开 draft 修订、不确认覆盖、不设 effective） |
| 路由 | `src/http/ingestion_routes.ts` | O09 `createPdfImport` + `SOURCE_KINDS` 枚举 + `expected_session_count` 的 Ninja `int_parsing` 形状 |
| 黄金向量 | `tests/golden/ingestion_b4_pdf.json`（`scripts/gen_ingestion_b4_pdf_golden.py`）<br>`tests/golden/ingestion_b4_imports.json`（`scripts/gen_ingestion_b4_imports_golden.py`） | PDF 侧 sha256 `ef9aed31…4aea30d`；写集侧 12+6 组，含 14 份夹具 PDF |
| 测试 | `tests/ingestion_b4_pdf.test.ts`(5)、`ingestion_b4_http.test.ts`(14)、`ingestion_b4_imports.test.ts`(2) | 21 条 |
| 探针 | `scripts/probe_ingestion_b4.py` → `13-ingestion-b4-probe.{md,json}` | 40 例真实 HTTP |
| 依赖 | `package.json` | `pdfjs-dist@6.5.438` 为运行时依赖；`npm run deps:pdfjs` 装到 `.deps/`（与 sharp 同一原因：`dsh-plugin/node_modules` 是指向 `frontend/node_modules` 的软链，不能在里面 `npm install`） |

**schema 无变更**：本批次只写已有列。`ImportJob.page_diagnostics`、`ImportCandidate.answer_match`、
`SourceDocument.page_texts/page_count`、`Paper/PaperRevision` 都是 B0–B2 已在 schema 里的字段。

## 2. 为什么这算「移植」而不是「重写」

| Django | 本移植 | 对拍方式 |
|---|---|---|
| `pdf_text._open_reader` | `pdf.ts::openDocument` | 9 种拒绝的 message/details 逐字相等 |
| `pdf_text._extract_page`（两个 visitor） | `pdf.ts::extractPage`（`getOperatorList`） | 7 份真实 PDF 逐页 text / 页号 / 字符数 / 分类 / 诊断行相等 |
| `pdf_text._fragment/_normalise/_page_layout/_ordered_page_text` | `pdf_layout.ts` 同名函数 | 44 条合成几何向量，1e-12 容差 |
| `pdf_text.bbox_for_text/_clamp_bbox` | `pdf_layout.ts::bboxForText/clampBbox` | 14 条向量（含越界回推与无匹配 null） |
| `imports._store_or_reuse_document` | `startPdfImportPrepared` 的 documents 段 | 12 组写集：复用/新建/`duplicate_source_file` |
| `imports._collect_page_diagnostics` | `collectPageDiagnostics` | 500 行截断（`diagnostics_truncation`）与每行 `document_id/document_title` |
| `imports._parse_paper_sources` / `_attach_source_geometry` | `parsePaperSources` / `attachSourceGeometry` | 候选 `draft_payload.source_spans[].bbox` 逐位相等 |
| `imports._create_candidates` / `_regions_for_segment` | `createPdfCandidates` / `regionsForSegment` | 候选顺序、`source_position_key`、region 的 page/bbox/char 偏移 |
| `imports._report_job_problems` | `reportJobProblems` / `reportLayoutProblems` | `job.problems` 原文与顺序（含 `f"{pages} 页"` 打出 `[2]` 这种 Python list repr） |
| `imports._prepare_paper_revision` | `preparePaperRevision` | paper 自然键复用、修订号递增、`covered_session_count`、note 里的 job id |
| `api.create_pdf_import` | `createPdfImport` | 校验顺序、幂等 scope/指纹、Ninja 错误形状 |

## 3. pdfjs 适配层：为什么读 operator list 而不是 `getTextContent()`

这是本批次唯一一个**必须偏离直觉实现**的地方，理由都是实测出来的，不是偏好：

1. **`getTextContent()` 会丢弃页面框外的字形。** pdf.js 的 `compareWithLastPosition` 里有
   `posX > viewBox[2] → return false`，该字形连同其后的整段被静默跳过。实测 `table_formula` 夹具里
   `【题干】…∫_0^1 f(x)dx 的值。` 这一行比页面宽，`getTextContent()` 只回来 `…∫_0^1`，尾部 12 个字符消失；
   pypdf 保留它们（这也正是 `_clamp_bbox` 存在的原因）。**这是内容截断，不是几何噪声**，不能作为
   "库差异"放过。
2. **`getTextContent()` 会在 0.6 em 以上的每个视觉间隙把一段 run 拆成 `chunk + " " + chunk`。** 于是
   `A. 甲` 变成 3 个 item，双栏页的每个选项行变成 4 个 fragment —— 而 `_detect_table_grid` 只数
   "一行 ≥3 个 fragment"，4 个 fragment 的选项行会被判成"对齐的表格单元格"，**凭空多出一个
   `table_grid_detected` 阻断项**。这是发布门禁变化，不是容差问题。
3. **operator list 与 pypdf 的 `visitor_operand_before` 语义一致**：一个 show-text 操作一个 fragment，
   位置是 `CTM × TM` 的平移，文字来自 glyph 的 `unicode`。适配层因此只需要一个内容流状态机
   （`q/Q`、`cm`、`BT/ET`、`Tm`、`Td/TD`、`T*`、`TL`、`Tf`、form XObject 的 `paintFormXObjectBegin/End`），
   不需要"猜 run 边界"。

`pdfjs-dist` 用 **legacy build**（`legacy/build/pdf.mjs`）：现代构建在 import 阶段就要
`Uint8Array.prototype.toHex`，Node 24.22 / 24.21 都没有（实测抛 `hashOriginal.toHex is not a function`）。
legacy 构建在两个运行时都能 `require(esm)` 成功，`npm run verify` 的双运行时测试就是证据。

页面文本的重建走**内容流顺序**：baseline 变化超过 3pt 起新行，同行 run 用 `joinLine` 的空格规则拼接
（间隙 > 0.36em 插一个空格）。这与 `pypdf.extract_text()` 的 plain 模式在全部 7 份夹具上逐字符一致。

## 4. O09 写路径：异步提取与单事务的边界

`pdfjs` 是 Promise API，而 `store/db.ts` 的 `transaction()` 刻意是同步的（06 §0.1：返回 Promise 会在
工作完成前 COMMIT）。所以入口拆成两半：

1. **`preparePdfUploads`（异步，事务外）**：按 Django 的顺序逐份处理 —— paper files 先、answer files 后，
   每份都是「MIME allowlist → 提取 → checksum」，**第一份出错就停**。这保住了"Django 报第一份的错误"
   这个可观察行为：首份 MIME 错、次份损坏时，报的是 MIME。
2. **`startPdfImportPrepared`（同步，单事务）**：documents（复用或新建）→ job → `page_diagnostics`
   （**先于任何候选**写入）→ Paper/PaperRevision → 答案条目 → 逐 paper 独立 `parsePaste(structure_only)` +
   `attachSourcePages` + `attachCrossPageContinua` + `bboxForText` → 候选与 region → 材料父子 → 每个 paper
   对**全部** answers 重新 `applyAnswerMatches` → 重复题号检测 → problems → `maybeCompleteJob`。

一个**有意的副作用差异**（04 §L DIV-B4-4）：Django 在建第二份文档时才发现第一份之后的文件损坏，
数据库回滚但**磁盘上的第一份文件留在私有存储里**；本移植在事务前就把所有文件提取完，因此这种失败
一份文件都不写，也就没有孤儿。跨批失败仍可能留孤儿（与 Django 相同），这是存储层既有语义。

幂等 scope 与指纹按 06 §2：scope `imports.create_pdf:{project_id}`，指纹
`{checksums:[先 files 后 answer_files 的原始 sha256], subject_id, cycle_key, session_key, paper_code, source_kind}`；
`title`、文件名、MIME、`source_note`、`usage_scope`、`expected_session_count` **不参与**，所以只改文件名的重试
是重放而不是 409。claim 与写集在同一事务里，失败即释放（探针 P21–P23 钉住三种结局）。

## 5. 版式门禁对 PDF 候选的作用面

`refreshCandidateIssues` 用候选**自己**的 `(document_id, page_index)` 去匹配 `job.page_diagnostics`
（B1 已实现，本批次首次被真实 PDF 触发）：

- 双栏页的 8 个候选全部拿到 `multi_column_needs_review`（blocking，`page_indexes=[1]`，
  `reasons=['multi_column_layout']`）；
- 同 job 里干净页的候选**不被**扫描页/公式页牵连（`mixed_scanned`：第 2 页 `is_scanned`，第 1/3 页的候选
  review_issues 里没有 `page_without_text_layer_needs_manual_entry`）；
- `layout-confirm` 只清该候选（探针 P30：确认后 `review_issues=[]`、`status=ready`；相邻候选仍阻断）；
- `geometry_unavailable` / `too_many_fragments` 只把 `reading_order_reliable` 置 false，**不阻断**。

## 6. 验证

```bash
cd dsh-plugin
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
npm run verify     # typecheck → build → 523 测试（系统 Node 24.22.2 + DSH Electron Node 24.21 双跑）→ Cordis 加载烟测
```

- **测试数 523**（B3 的 502 → 523，新增 21：PDF 提取/版式 5、O09 HTTP 14、写集 2），双运行时全绿。
- **PDF 黄金向量**（`ef9aed31…4aea30d`，372160 bytes）：
  - 7 份真实 PDF：`text_two_pages` / `normal_page` / `two_columns` / `table_formula` / `cross_page` /
    `mixed_scanned` / `encrypted_empty_user_password`；
  - 逐页比对 **page_count / character_count / empty_pages / text / page_map / 每页 text / 字符数 /
    fragment_count / columns / has_table_grid / has_formula_tokens / is_scanned /
    reading_order_reliable / diagnostics / diagnostic_row** 全部相等；
  - 3 份用显式 `Tm` 的夹具（`two_columns` / `table_formula` / `cross_page`）**fragment 几何逐位相等**
    （x/y/width/height，1e-12）；其余 4 份因 pypdf 的 `TL` 缺陷只比文字与顺序（见 §7）；
  - 9 种拒绝（空 / 40 MiB / 非 PDF / 损坏 / 加密 / 0 页 / 201 页 / 200 万字符 / 无文字层）的
    `message` 与 `details` 逐字段相等；
  - 44 条版式向量覆盖全部阈值边界：`<` 与 `<=` 的分界（fragment 数 6、gutter 恰好 12pt、纵向重叠恰好
    0.5、crossing 恰好 0.25）、`_lines`/`_x_clusters` 的"比锚点不比邻居"、`_join_line` 的 0.36em 空格阈值、
    `_clamp_bbox` 的原点回推、`page_map` 的 Python 码点语义（`𝄞x` 长度 2）、以及
    "`unambiguous=true` 但重建丢字符 → 保留原文 + 追加 ambiguous"这条路径。
- **写集黄金向量**：12 组成功写集（单份 / 两份 / 试卷+答案 / 重复字节 / official_past 带 paper /
  practice_set 无 paper / 扫描页混合 / 双栏 / 跨页 / 同卷同号重复发布 / 无题目结构 / 500 行诊断截断）+
  6 组拒绝（空 files / 科目跨项目 / MIME 非 PDF / **第二份损坏整体回滚** / 纯扫描 / 加密）。
  比对 job 投影、documents（含 `page_texts`/`raw_text`/`page_count`/asset 形状）、候选
  （`draft_payload` 全字段、`review_issues` 顺序、region 的 bbox 与 char 偏移）、paper/revision、审计行、
  12 张表的行数增量。拒绝用例另断言**行数前后完全相同**。
- **HTTP 黑盒 14 条**：201 基础导入、答案匹配（三字段为 null 这一 Django 既有缺陷）、顺序匹配把
  `answers_matched` 抬成 warning、同请求内重复字节
  （复用同一文档、位置键 `1` / `1#2`、`duplicate_candidate`）、校验顺序
  （files → source_kind → cycle_key）、MIME/not_pdf/damaged 拒绝且零写入、纯扫描拒绝、
  扫描页混合不牵连干净页、双栏阻断 + `layout-confirm` 只清该候选、幂等重放/冲突、
  字节去重（文档与资产不增）、paper 修订（covered=1、未确认覆盖、effective 为空、第二次导入开 revision 2）、
  跨项目科目 404、`expected_session_count` 非整数 422。
- **Django 探针 40 例**（O09 32、O15 3、O17 1、O18 4）：见 [13-ingestion-b4-probe.md](./13-ingestion-b4-probe.md)。

## 7. 已知边界与有意的差异（详见 04 §L）

| 编号 | 差异 | 处理 |
|---|---|---|
| DIV-B4-1 | pypdf 5.1.0 的 `TL = operands[0] * font_size`（`pypdf/_page.py:1988`）使 `T*` 换行的页面第 2..n 行 baseline 多乘一个字号（14pt 行距被报成 168pt）。本移植用规范正确的 `CTM×TM`。 | 记录为**缺陷**；分类结论在全部夹具上不受影响；`build_layout_pdf`（显式 `Tm`）几何逐位相等，`T*` 夹具只比文字与顺序 |
| DIV-B4-2 | `metadata.title`：pypdf 对 `ByteStringObject` 返回 `str()` 即 bytes repr，pdfjs 解成 mojibake。 | metadata 本就不落库（06 §5.2），只比 `producer`；`metadata_comparable` 字段显式声明 |
| DIV-B4-3 | 适配层读 operator list；`getTextContent()` 的两处行为（框外截断、按 0.6em 拆 run）都会改变内容或发布门禁。 | 记录理由与实测反例；`table_formula` 夹具就是框外截断的向量 |
| DIV-B4-4 | 事务前提取导致"第二份损坏"零磁盘写入（Django 会留一个孤儿文件）。 | 有意的运维改良，方向是更少垃圾，不是更宽松 |
| KNOWN-B4-1 | `answer_match` 的 `source_page_index/document_id/document_title` 在命中时仍为 null（Django 的 `apply_answer_matches` success dict 丢了 provenance）。 | 按现状等价复刻，`paper_and_answers` 与探针 P03 都钉住 null |

**未做（不声称完成）**：
- O19/O20 变式与 extraction worker（B5）；
- 真实浏览器/DSH 宿主里的 O09 可达性：四条 ingestion 路径都含参数，仍只能声称进程内
  `Request`→`Response` 可达（与 B3 同一结论，见 12 §3）；
- 打包形态：`.deps` 不随 `files` 发布，正式安装时 `pdfjs-dist` 来自 `dependencies`（与 sharp 同）。

## 8. 回滚面

本批次没有 schema 变更、没有迁移、没有修改既有列语义。回滚 = 删除 `src/ingestion/pdf.ts`、
`src/domain/ingestion/pdf_layout.ts`、`src/services/ingestion_imports.ts` 里的 PDF 段、O09 路由与三条测试文件，
并从 `package.json` 去掉 `pdfjs-dist` 与两个 golden 脚本；`.deps/` 与 `node_modules` 都不入库。
`dsh-plugin/` 与 `docs/dsh-migration/` 仍未跟踪，未做任何 git 操作。
