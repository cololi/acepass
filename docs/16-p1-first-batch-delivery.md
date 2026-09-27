# P1 第一批交付：原生文字 PDF 导入、大纲人工映射、真实周期统计

日期：2026-09-27。起点：`5fff64e`（P0.2 最后四组遗漏修复完成）。功能提交：`2776276`；
收尾（结构整理 + 证据刷新）：`dd82e3b`；最终干净副本验证提交：`44de63f`。
任务来源：[14 最终复验](14-p0-2-final-independent-review.md) §4 的 P1 顺序，以及本轮口头补充的
"全部启动并必须保证完整交付成功"。

**结论：P1 第一批（A 原生文字 PDF 批量导入与人工校对、B 大纲词表/人工映射/真实周期统计）
已实现并全部通过验收；真实 AI 讲解与图片识别接入验证已实际发起，但被 provider 账户余额阻断，
保持【未验证】；真实 ≥24 小时验证无法在本轮产生证据，保持【未验证】。**

| 检查 | 本轮实测结果 | 证据 |
|---|---|---|
| 正式后端全套 | **226 passed / 173.57s**（重构后复跑） | [backend-suite.txt](review/2026-09-27/p1-batch/backend-suite.txt) |
| 本轮新增 P1 回归（正式套件） | **23 passed** | [p1-regressions.txt](review/2026-09-27/p1-batch/p1-regressions.txt) |
| 隔离浏览器验收（P0 36 + P1 12） | **48 passed / 1.0m**（重构后复跑） | [browser-acceptance.txt](review/2026-09-27/p1-batch/browser-acceptance.txt) |
| 归档浏览器反例（原文件未改） | **2 passed** | [archived-browser.txt](review/2026-09-27/p1-batch/archived-browser.txt) |
| 上轮有效后端反例（原文件未改） | **9 passed, 1 deselected** | [archived-nine.txt](review/2026-09-27/p1-batch/archived-nine.txt) |
| 复验者三条反例（原文件未改） | **3 passed** | [reviewer-three.txt](review/2026-09-27/p1-batch/reviewer-three.txt) |
| 真故障演练（真 FLUSHALL / 真 SIGKILL / 双消费者） | **ok=true** | [worker-drill.txt](review/2026-09-27/p1-batch/worker-drill.txt) |
| 干净副本发布门槛（组件 + 全栈 HTTPS/CSRF 登录） | 两步 **exit 0**，哨兵与资源隔离保持 | [clean-export-release-gate.txt](review/2026-09-27/p1-batch/clean-export-release-gate.txt) |
| 真实 AI 讲解接入 | **调用已发起，HTTP 402 余额不足 → 未验证** | [real-ai-provider.txt](review/2026-09-27/p1-batch/real-ai-provider.txt)、[JSON](review/2026-09-27/p1-batch/real-ai-provider.json) |

## 1. P1-A 原生文字 PDF 批量导入与人工校对

**实现范围**

| 文件 | 作用 |
|---|---|
| [pdf_text.py](backend/apps/ingestion/services/pdf_text.py) | 原生文字 PDF 逐页提取（pypdf，纯 Python，无 OCR、无模型）：PDF 头/加密/损坏/页数/文本量/大小上限的显式失败，扫描件返回 `no_text_layer` 并说明改走人工路径 |
| [text_parser.py](backend/apps/ingestion/services/text_parser.py) | 标签解析新增**材料题与子题**（`【材料】`/`【子题N】`/材料内编号）、行首题号（`1．【题型】…`）、**答案页解析**与**答案匹配**（题号优先、顺序兜底，每条答案只消费一次）、**逐条来源页归属** |
| [imports.py](backend/apps/ingestion/services/imports.py) | `start_pdf_import`：多文件批量、来源文档复用（同 checksum 不重复存）、材料父子候选、答案匹配候选、试卷身份登记与草稿版本、页级来源区域、任务问题清单 |
| [models.py](backend/apps/ingestion/models.py) + [0002 迁移](backend/apps/ingestion/migrations/0002_p1_pdf_import_and_paper_link.py) | `SourceDocument.page_texts`（逐页原文）、`ImportCandidate.parent_candidate / source_position_key / paper_revision / answer_match / publication_paper_item_id`（全部加法式、可空，无回填、无破坏） |
| [core.py](backend/apps/ingestion/services/core.py) | 发布路径：材料版本按需创建、子题挂到材料版本并回写 `material_child_version_ids`、**发布即写入试卷题项**（材料不计分、子题为计分叶子并挂父题项），发布幂等（`publication_paper_item_id`） |
| [ingestion/api.py](backend/apps/ingestion/api.py) | `POST /projects/{id}/imports/pdf`（multipart：`files` 试卷、`answer_files` 答案，真实试卷必须填周期与卷别） |
| [ImportsPage.tsx](frontend/src/features/imports/ImportsPage.tsx)、[CandidateReviewPage.tsx](frontend/src/features/imports/CandidateReviewPage.tsx) | 导入表单（默认收起，保持图片导入仍是唯一默认入口）、候选页显示卷面题号/来源页、答案匹配确认框、材料父子关系 |

**验收点与实测**

| 要求 | 实测 |
|---|---|
| 来源页可追溯 | 每个候选都有 `SourceRegion.page_index` 与原文片段；候选页显示"卷面题号：1 · 来源页：第 1 页（文档名）"；跨页题目归属到起始页 |
| 五题型、材料子题关系完整 | 一份 PDF 解析出单选/多选/判断/填空/大题 + `【材料一】` 父题与 2 个子题；发布后材料版本 `material_child_version_ids` 与 `child_versions` 完全一致，子题 PaperItem `parent_item` 指向材料题项；材料未发布子题时**阻断**发布（候选 issue + 发布校验双保险） |
| 答案匹配只产生候选 | 匹配写入 `answer_payload` 的同时强制 `answer_status_known=false` 并加阻断 issue `answer_match_pending_confirmation`；确认框勾选并保存后才可发布；匹配条目按题号优先、顺序兜底，同一条答案不会被两题消费 |
| 重试/重复导入不重复发布 | 同 checksum 复用来源文档；任务指纹识别重复导入；与已发布题号冲突的候选标 `duplicate_paper_position` 阻断；重试复用原有候选 |
| 不依赖模型密钥 | 全链路只有文本提取与规则解析；`ACEPASS_AI_PROVIDER=none` 下 23 条 P1 回归全绿 |

## 2. P1-B 大纲词表、人工映射与真实周期统计

| 文件 | 作用 |
|---|---|
| [outline.py](backend/apps/knowledge/services/outline.py) | 词表导入：缩进与编号共同决定层级（章/节/考点）；`函数（映射）` 等同义词合并到同一节点；`update_knowledge_node` 支持改名/别名/改父，**环依赖拒绝**（不能移动到自己的子孙下） |
| [cycles.py](backend/apps/analytics/services/cycles.py) | 周期分析：只统计 `official_past` 且非演示的真实发生记录；完整周期 = 该周期全部已登记试卷都有"已确认 + 覆盖人工确认完整 + 至少一个计分题项"的有效版本；每个周期给出分母总分与权重合计；主考点权重按题目版本计一次、辅助标签为 0、无映射进入"未分类"；不足 5 个完整周期返回 `insufficient_cycles` 并列出未完整周期与原因；同时给出未覆盖大纲考点 |
| [exams/api.py](backend/apps/exams/api.py)、[exams/services/core.py](backend/apps/exams/services/core.py) | 覆盖登记（预期/已覆盖场次 + 是否人工确认）、版本确认、有效版本指定——周期完整性必须由人明确声明，不能由"上传了文件"推断；`coverage_status` 现在只有**人工确认后**才可能是 `coverage_complete` |
| [knowledge/api.py](backend/apps/knowledge/api.py) | `POST /syllabus-versions/{id}/nodes/import` 词表导入、`PATCH /knowledge-nodes/{id}` 改名/别名/移动 |
| [analytics/api.py](backend/apps/analytics/api.py) | `GET /projects/{id}/papers/cycle-analysis?subject_id=&max_cycles=` |
| [KnowledgePage.tsx](frontend/src/features/knowledge/KnowledgePage.tsx)、[ReportsPage.tsx](frontend/src/features/reports/ReportsPage.tsx) | 词表导入面板 + 行内节点编辑（改名/别名/改父，环拒绝就地显示）；周期分析面板（不足 5 个完整周期时明确显示"不足"并拒绝给"近五年"结论）、各周期分布、平均占比、未覆盖考点、未完整周期原因、逐版本覆盖登记/确认按钮 |
| [bootstrap_acceptance.py](backend/apps/accounts/management/commands/bootstrap_acceptance.py) | 验收夹具新增"验收历年科目·周期统计"：5 个完整周期（每年 2 题、权重 1.0 与 0.6/0.4）+ 1 个未完成周期 + 1 份演示卷（必须被排除），全部标注为验收测试材料 |

**验收点与实测**

| 要求 | 实测 |
|---|---|
| 多项目/科目分别配置 | 大纲版本属于科目，词表导入按大纲落库；周期分析按科目查询；跨项目访问 404（API 用例断言） |
| 同义词合并、环依赖拒绝 | 二次导入同一词表 5 行全部合并、别名累加；把父节点移动到自己的子孙下返回 400 且含"环"，合法移动成功 |
| 权重不重复 | 写入口已强制"主考点权重合计 = 1、辅助标签权重 = 0"；周期内各考点占比合计 = 1.0000（含未分类），测试逐个周期断言 |
| 只按真实试卷发生记录统计 | 演示卷（`source_kind=demo`）与未完成周期都不进入分子/分母，只出现在"未完整周期"列表并给出原因（`demo_or_mock`、`no_effective_revision`…） |
| 明确完整/不完整周期与分母 | 每个计入周期返回试卷数、计分题数、分母总分（验收夹具 20.000）、权重合计（100.0%）；未完整周期给出逐卷原因 |
| 不足五个完整周期就显示不足 | 4 个完整周期 → `insufficient_cycles`、`missing_complete_cycles=1`、notes 明说不给"近五年"结论；浏览器用例断言面板不出现"近五年"结论；0 个完整周期同样明确显示 |

## 3. 本轮执行的命令（可复现）

```bash
# 后端
cd backend && .venv/bin/python -m pytest tests -q                                  # 226 passed
.venv/bin/python -m pytest tests/integration/test_p1_*.py -q                       # 23 passed
.venv/bin/ruff check apps ai domain config tests                                   # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check        # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes
ACEPASS_RUNTIME_MODE=production DJANGO_SETTINGS_MODULE=config.settings.prod \
  .venv/bin/python manage.py check --deploy --fail-level WARNING                   # no issues (1 silenced)

# 归档反例（文件未改）
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-independent/test_*.py \
  -c backend/pytest.ini --ds=p02_independent_settings -q -k 'not generation_migration_cannot_promote'  # 9 passed
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-final-independent" \
  backend/.venv/bin/python -m pytest docs/review/2026-09-27/p02-final-independent/test_*.py \
  -c backend/pytest.ini --ds=review_settings -q                                    # 3 passed

# 浏览器（独占库/Redis 6394/媒体目录/端口 + 真实 Worker）
bash scripts/dev/reset-p1-batch-browser.sh
cd frontend && POSTGRES_DB=acepass_acceptance_p1_batch REDIS_URL=redis://127.0.0.1:6394/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false \
  ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/../var/private-media-p1-batch" POSTGRES_CONN_MAX_AGE=0 \
  ACEPASS_BROWSER_API_PORT=8014 ACEPASS_BROWSER_WEB_PORT=5184 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts        # 48 passed
cd .. && frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs   # 2 passed

# 真故障演练（独占 Redis，显式允许 FLUSHALL）
ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 POSTGRES_DB=acepass_acceptance_p1_batch_drill \
  REDIS_URL=redis://127.0.0.1:6394/0 ACEPASS_OUTBOX_LEASE_SECONDS=5 \
  PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py    # ok: true

# 干净副本发布门槛
CLEAN=$(mktemp -d) && git archive HEAD | tar -x -C "$CLEAN"
cp -R frontend/dist "$CLEAN/frontend/dist"
printf 'TEST_EXISTING_CONFIGURATION=preserve-this-existing-deployment\n' > "$CLEAN/infra/docker/.env"
cd "$CLEAN" && bash scripts/verify_proxy.sh component && bash scripts/verify_proxy.sh full-stack
```

## 4. 真实 AI 接入验证（本轮实际发起）

凭据仅从安全配置读取（`~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`），只在内存中注入子进程环境，
**未打印、未写入仓库、未写入任何文档**，运行后临时 env 文件已删除。验证脚本
[scripts/verify_real_ai.py](scripts/verify_real_ai.py) 会在非专用库、非真实 provider 时拒绝运行。

| 项目 | 实测 |
|---|---|
| provider / model / 提示词版本 | `openai_compatible` / `deepseek-chat` / `p0-explain-v1` |
| 请求是否真的到达 provider | **是**：`api.deepseek.com` 返回 **HTTP 402 Insufficient Balance**（该 key 账户余额不足） |
| 是否产生模型内容 | **否**（`result_blocks=[]`、`is_stub=false`、无 token、无费用记录） |
| 失败路径是否诚实 | 是：job 记为 `failed` + `error_code=ai_error` + 原始错误摘要；不写任何分数或掌握状态（`knowledge_states=0`、评分事件数不变） |
| 真实图片识别 | **未验证**：该凭据没有视觉模型（`vision_available=false`），未做真实视觉调用；未配置视觉模型时导入走人工校对 |
| stub 守卫 | 同一脚本在 `ACEPASS_AI_PROVIDER=stub` 下返回 `ok=false` 并说明"这不是真实模型验证" |
| 人工核验集 | **未完成**：本轮没有可展示的真实模型输出可供人工核验（被余额阻断）；需要可用凭据后重跑该脚本 |

## 5. 未验证项（保持未验证）

- **真实 AI 讲解**：调用已发起并被 provider 拒绝（余额不足），没有内容产出，因此不构成验证。
- **真实 AI 图片识别**：无视觉模型凭据，未做真实调用。
- **真实间隔 ≥24 小时的学习效果**：本轮没有经过真实时间，未产生证据。
- **GitHub Actions 实际执行**：CI 仍未推送触发；代理门槛只在本机以同一脚本验证。
- 浏览器与演练中的模型调用是 stub。

## 6. 与既有交付的关系

- P0/P0.2 的全部结论与证据保留；本轮的浏览器套件把 P0 的 36 条与 P1 的 12 条放在同一次运行里，
  P0 侧仅改动了两处**定位方式**（图片导入输入框改用 `data-testid="image-import-input"`），断言未动；
  复验者归档的浏览器反例与后端反例**文件未改**，继续通过。
- 为避免 P1 导入的题目影响 P0 套件按题型选题，P1 的导入用例放在 `验收科目三·专业实务`（P0 不驱动该科目）；
  PDF 导入表单默认收起，保持图片导入仍是该页唯一默认上传入口。
