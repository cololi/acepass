# P2 第一批交付：版式感知导入（C01）与污染规则（C04）

日期：2026-09-27。起点：`17f3fd8`（P1 第三批交付完成）。任务来源：
[17 走向 100% 的计划](17-remaining-plan-to-completion.md) 批次 4，对应验收 C01/C04。

**结论：批次 4 的两个验收条目已实现并通过本机实测验收。**

- **C01**：PDF 解析器现在会**分类每一页**（原生文字 / 扫描页 / 分栏 / 表格 / 公式 / 阅读顺序可靠），
  按栏重排只在几何真的可判定时发生，跨页题目合并并记录涉及的页；来自可疑页面的候选带**阻断问题**，
  发布仍然是唯一门禁——未经「确认版面无误」一律 422，确认后同一份内容才可发布。**没有 OCR**：
  扫描页明确要求人工录入，绝不猜测。
- **C04**：新增唯一的污染规则源（`apps/learning/services/contamination.py`）。
  **校对过（编辑预览）**、**外部标记已见**、**已展示未提交**、以及**跨项目同源内容**四种来源
  都会让题目永久失去"严格独立证据"资格；重新计算、重判、跨项目都无法把它洗回"未见"。
  四个来源各自留证（原因码 + 证据行 + 时间），界面与报告都给出人类可读的原因。

| 检查 | 本轮实测结果 | 证据 |
|---|---|---|
| 正式后端全套 | **366 passed / 144.02s**（起点 340，本轮迁入 26 条） | [backend-suite.txt](review/2026-09-27/p2-batch1/backend-suite.txt) |
| 隔离浏览器主套件 | **66 passed / 1.4m**，连续两次一致 | [browser-acceptance.txt](review/2026-09-27/p2-batch1/browser-acceptance.txt)、[复跑](review/2026-09-27/p2-batch1/browser-acceptance-rerun.txt) |
| 隔离浏览器 stub 专跑（批次 3 用例） | **6 passed** | [browser-acceptance-stub.txt](review/2026-09-27/p2-batch1/browser-acceptance-stub.txt) |
| 归档后端反例（三组，文件未改） | 11 / 9（1 deselected）/ 3 passed | [reviewer-eleven.txt](review/2026-09-27/p2-batch1/reviewer-eleven.txt)、[archived-nine.txt](review/2026-09-27/p2-batch1/archived-nine.txt)、[reviewer-three.txt](review/2026-09-27/p2-batch1/reviewer-three.txt) |
| 归档浏览器反例（原文件未改） | **2 passed** | [archived-browser.txt](review/2026-09-27/p2-batch1/archived-browser.txt) |
| 真故障演练 | **ok=true** | [worker-drill.txt](review/2026-09-27/p2-batch1/worker-drill.txt)、[JSON](review/2026-09-27/p2-batch1/worker-drill.json) |
| 干净副本发布门槛 | 代理组件与真实全栈 HTTPS/CSRF 登录均 exit 0，哨兵不变 | [clean-export-release-gate.txt](review/2026-09-27/p2-batch1/clean-export-release-gate.txt) |

## 1. C01 版式感知导入

| 文件 | 作用 |
|---|---|
| [pdf_text.py](backend/apps/ingestion/services/pdf_text.py) | 逐文本片段几何（pypdf 的 operand visitor + 字符映射解码，`visitor_text` 作为兜底）；页面分类：`multi_column_layout`、`table_grid_detected`、`formula_tokens_detected`、`page_without_text_layer`、`column_reading_order_ambiguous`、`geometry_unavailable`、`too_many_fragments`；只在栏间空隙真正为空时按栏重排，否则保留解析顺序并标记不可靠 |
| [layout.py](backend/apps/ingestion/services/layout.py) | **唯一**的"页面原因 → 候选阻断问题"映射（分栏→`multi_column_needs_review`、表格/公式→`table_or_formula_needs_review`、扫描页→`page_without_text_layer_needs_manual_entry`），以及 `layout_review_issues`：只阻断真正落在可疑页上的候选 |
| [text_parser.py](backend/apps/ingestion/services/text_parser.py) | 跨页续接检测与合并（`continues_on_pages`、非阻断问题 `cross_page_question`），起始页归属保持不变 |
| [imports.py](backend/apps/ingestion/services/imports.py) | `page_diagnostics` 在候选创建**之前**落库；每个候选的来源区域按页 span 记录归一化 bbox；任务问题清单加入三类阻断原因 |
| [core.py](backend/apps/ingestion/services/core.py)、[api.py](backend/apps/ingestion/api.py) | `refresh_candidate_issues` 写入阻断问题；`POST …/import-candidates/{id}/layout-confirm`（Idempotency-Key）是**唯一**清除动作，写 `ContentRevision`；发布仍是唯一门禁（422 + `details.problems`） |
| [pdf_builder.py](backend/tests/support/pdf_builder.py) | 测试用真实 PDF 生成器：逐片段显式定位（`build_layout_pdf`）与真正的无文字层页面（`build_scanned_pdf`，整页图片 XObject） |

**金标回归（`tests/integration/test_p2_layout_import.py`，16 条）**：分栏页**按栏顺序**解析（断言提取顺序，
而内容流是逐行交错的，所以这不是同义反复）、列内自上而下；跨页题目合并成一题且来源覆盖两页；
表格/公式页保留符号原文并阻断；混合文档里扫描页不产出候选、明确要求人工录入，其余页照常导入；
正常页不需要任何版面确认；几何缺失时退回整页框并标记 `geometry_unavailable`（不阻断）。

**浏览器实测**（`frontend/tests/acceptance/p2-batch1.spec.ts`，真实两栏 PDF，逐行交错发出）：
第 1、2 题来自左栏、第 5 题是右栏第一题（证明按栏重排）；候选带分栏阻断问题；未确认时点发布得到
**422** 且 `details` 里就是 `multi_column_needs_review`；填写核对说明并确认版面后问题清空，
再补齐答案确认与练习分值即可正常发布（**版面确认不会顺带清掉其他复核门禁**）。

## 2. C04 污染规则

| 文件 | 作用 |
|---|---|
| [contamination.py](backend/apps/learning/services/contamination.py) | `exposure_state` / `exclusion_reasons` 单点规则；原因码：`external_seen`、`editorial_preview_seen`（两者**绝对**，不受时间窗口影响）、`stem_delivered` / `answer_delivered` / `explanation_delivered` / `hint_delivered` / `feedback_delivered`、`presented_without_submit`、`lineage_seen_in_other_project`；两个写入器：`record_editorial_preview`、`declare_external_seen` |
| [evidence.py](backend/apps/learning/services/evidence.py) | 严格独立/陌生变式等维度改为查询污染规则；排除行保留精确原因（人类可读），`RULE_VERSION` → `p2-c04` |
| [api.py](backend/apps/practice/api.py) | `GET …/questions/{qid}/exposure`、`POST …/questions/{qid}/external-seen`（追加式账本；`seen:false` 只是更正记录，污染标记保留）、`POST …/import-candidates/{cid}/editorial-preview` |
| [ingestion/api.py](backend/apps/ingestion/api.py) | 校对调用点：打开/编辑**已关联已发布题目**的再导入候选时记录 `EDITORIAL_PREVIEW`（同一候选重复打开复用同一行） |
| [ExposurePanel.tsx](frontend/src/features/questions/ExposurePanel.tsx) | 题库与复习页的暴露面板：状态用文字表达（「不会计入严格独立证据」/「系统内未见记录」）、逐条原因与证据、标记「系统外已见」与「记录更正」并明说标记不会消失 |

**实测（`tests/integration/test_p2_contamination.py`，10 条）**：校对后作答不再计入严格独立（原因
`editorial_preview_seen`），重复练习仍计入；仅"外部已见"声明就足以永久排除，同会话的另一道新题仍合格；
"已展示未提交"会污染同一题目的后续正确作答；跨项目同源内容污染 A 项目的严格证据但两项目学习状态仍分开；
污染后的作答在重算/重判后**不会**回到严格证据（两次重算结果稳定）；校对候选的真实 HTTP 路径确实写入
`EDITORIAL_PREVIEW`（重复打开不重复写入，未关联题目的候选不写入）；接口对他人项目 404。

## 3. 本轮执行的命令（可复现）

```bash
# 后端
cd backend && POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q          # 366 passed
POSTGRES_CONN_MAX_AGE=0 POSTGRES_DB=acepass_p2b1_files .venv/bin/python -m pytest \
  tests/integration/test_p2_layout_import.py tests/integration/test_p2_contamination.py -q   # 26 passed
.venv/bin/ruff check apps ai domain config tests                                    # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check          # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes

# 归档反例（文件未改）：11 / 9(+1 deselected) / 3，命令同 docs/19 §5
# 浏览器（独占库 acepass_acceptance_p2_batch1、Redis 6397、媒体目录、端口 8017/5187）
bash scripts/dev/reset-p2-batch1-browser.sh
cd frontend
POSTGRES_DB=acepass_acceptance_p2_batch1 REDIS_URL=redis://127.0.0.1:6397/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false \
  ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/../var/private-media-p2-batch1" POSTGRES_CONN_MAX_AGE=0 \
  ACEPASS_BROWSER_API_PORT=8017 ACEPASS_BROWSER_WEB_PORT=5187 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep-invert "@stub"   # 66 passed
# stub 专跑（批次 3 用例）同 docs/19 §5，仅把库/端口换成批次 4 的一套
# 归档浏览器反例、真故障演练、干净副本门槛的命令同 docs/19 §5（演练库换成 …_p2_batch1_drill）
```

## 4. 本轮暴露并修复的问题

1. **P0 浏览器用例的采样竞态**：`p0-acceptance` 的"新增科目后科目选择器立即出现"用例在
   科目列表请求返回前就同步统计 `option` 数量，偶发失败（本轮先后命中两次，均在 mobile）。
   已改为可重试断言（等待真实数据），断言本身没有放宽——它现在等的是产品数据而不是网络时序。
2. **浏览器两栏 PDF 夹具的几何不合格**：最初每栏只有 5 行、纵向跨度不足页面一半，检测器（正确地）
   不认为是分栏。夹具改为与后端金标相同的几何（左 60pt/右 330pt、行距 30pt、每栏 4 题、逐行交错），
   这样浏览器验的是真实的两栏页。
3. **发布门禁的完整性在浏览器里被验证**：版面确认只清除版面阻断问题，答案匹配确认与练习分值
   仍然必须人工补齐，否则发布继续 422 —— 这条不变量在浏览器用例里显式断言。

## 5. 未验证项（保持未验证）

- **真实试卷 PDF**：全部版式证据来自自动生成的 PDF；未在真实扫描件、真实双栏排版、旋转页面、
  非常规字体编码或 Form XObject 嵌套文本上验证。
- **扫描页 OCR**：明确不做（无视觉模型与 OCR 依赖），因此"扫描件自动识别"能力不存在，也不会被声称。
- **真实 AI 讲解/图片识别/手写转写/估分/嵌入向量**：仍为未验证（本机凭据不可用）。
- **真实 ≥24 小时学习效果、远程部署、GitHub Actions 实际执行**：仍未验证。
- 家族封存/合并（C03）与生成变式校验（C02）属于批次 5，尚未开始。
