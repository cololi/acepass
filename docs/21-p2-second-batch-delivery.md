# P2 第二批交付：封存与家族合并（C03）、AI 生成变式（C02）

日期：2026-09-27。起点：`7b323df`（P2 第一批交付完成）。任务来源：
[17 走向 100% 的计划](17-remaining-plan-to-completion.md) 批次 5，对应验收 C03/C02。

**结论：批次 5 的两个验收条目已实现并通过本机实测验收。**

- **C03**：封存（holdout）现在有**唯一解析器**（`question_bank/services/sealing.py`，按最新策略修订判定），
  并被练习/验证会话创建、检索、AI 辅导的提示构造与投递、缓存投递、Worker 消费、每日计划、
  原页/答案/题图资源读取、题库预览逐一查询——每个入口都有反例测试，控制组仍然可用。
  家族合并是**两步**操作（先看影响，再确认），合并后按 C04 规则重新检查暴露、把不再成立的
  `unseen_variant`/`template_variant` 证据置为失效（保留不删除）并重算考点状态；重复合并是幂等的。
- **C02**：AI 变式在**任何**内容产生之前先过确定性校验（共享的内容契约、单选唯一、多选≥2、
  填空答案与空位一致、大题评分点合计一致、题干不得复制源题、不得含答案、不得是材料题、
  与已发布题目/家族成员/同批候选去重、目标考点必须属于该科目大纲），失败一律**留在候选**里并带问题；
  发布仍走唯一门禁，且 AI 变式的 `origin_type` 被强制为 `ai_generated`，永远不能挂到真实考试发生记录、
  也不进入周期统计。

| 检查 | 本轮实测结果 | 证据 |
|---|---|---|
| 正式后端全套 | **396 passed / 247.25s**（起点 366，本轮迁入 30 条） | [backend-suite.txt](review/2026-09-27/p2-batch2/backend-suite.txt) |
| 隔离浏览器主套件 | **72 passed / 1.6m**，连续两次一致 | [browser-acceptance.txt](review/2026-09-27/p2-batch2/browser-acceptance.txt)、[复跑](review/2026-09-27/p2-batch2/browser-acceptance-rerun.txt) |
| 隔离浏览器 stub 专跑 | **8 passed**（批次 3 的 6 条 + 本批 2 条） | [browser-acceptance-stub.txt](review/2026-09-27/p2-batch2/browser-acceptance-stub.txt) |
| 归档后端反例（三组，文件未改） | 11 / 9（1 deselected）/ 3 passed | [reviewer-eleven.txt](review/2026-09-27/p2-batch2/reviewer-eleven.txt)、[archived-nine.txt](review/2026-09-27/p2-batch2/archived-nine.txt)、[reviewer-three.txt](review/2026-09-27/p2-batch2/reviewer-three.txt) |
| 归档浏览器反例（原文件未改） | **2 passed** | [archived-browser.txt](review/2026-09-27/p2-batch2/archived-browser.txt) |
| 真故障演练 | **ok=true** | [worker-drill.txt](review/2026-09-27/p2-batch2/worker-drill.txt)、[JSON](review/2026-09-27/p2-batch2/worker-drill.json) |
| 干净副本发布门槛 | 代理组件与真实全栈 HTTPS/CSRF 登录均 exit 0，哨兵不变 | [clean-export-release-gate.txt](review/2026-09-27/p2-batch2/clean-export-release-gate.txt) |

## 1. C03 封存：一个解析器，九个入口

| 文件 | 作用 |
|---|---|
| [sealing.py](backend/apps/question_bank/services/sealing.py) | `is_sealed`/`sealed_question_ids`/`assert_not_sealed`/`sealed_family_ids`；`seal_question`/`seal_family`/`unseal` 追加**新策略修订**（从不改旧行）并写 `ContentRevision`；`sealed_exclusions(project, subject)` 供未来的导出调用 |
| [families.py](backend/apps/question_bank/services/families.py) | 家族 CRUD（创建/改名/确认关系/加入与移出成员）、`merge_impact`（影响预览）、`merge_families`（合并 + 暴露重查 + 证据失效 + 状态重算，幂等） |
| [models.py](backend/apps/question_bank/models.py) | `QuestionFamily.merged_into`/`merged_at` 审计对；`is_holdout` 的说明改为指向解析器 |

**逐入口反例（都有一条"控制组仍然可用"的断言）**：练习/验证会话创建（403 + 封存原因）、
检索的关键词与向量两条通道（索引行仍是 `is_searchable=True`，证明是实时门禁而不是过期标记）、
辅导提示构造（在产生任何 LLMRun 之前）与已缓存任务的投递（GET job / segments / SSE / 幂等重放四个面）、
Worker 消费（计数器证明模型**一次都没被调用**）、每日计划全部分类与 `start_task`、计划载荷、
原页/答案/题图资源读取、题库预览；另有 `sealed_exclusions()` 供导出使用。

**关于"缓存"和"导出"的诚实说明**：本仓库唯一的模型输出缓存是 `TutorJob`/`TutorSegment`/`LLMRun`
（全部读取路径都已设门禁，索引 `SearchDocument` 由实时过滤中和；Django cache 只用于登录限流与就绪探针，
不含内容）。**当前没有任何导出接口**；`plan_payload` 会过滤封存内容，而分析报告桶与试卷题项
**故意不过滤**——它们是作答聚合与试卷构成，删掉封存题会篡改学习者自己的历史。未来的导出器必须调用
`sealed_exclusions()`，这条契约写在模块与函数文档里。

**合并家族实测**：成员全部迁移到目标家族并 bump 修订，写审计；源家族成员被暴露过则合并后整个家族
（含目标成员）都算已见（新原因码 `family_variant_seen`）；合并影响下的 `unseen_variant`/`template_variant`
证据行被置 `is_active=False` + `invalidated_at` + 原因「家族合并后不再构成不同家族证据」（**不删除**），
随后按 (user, project, node) 重算考点状态；`merge_impact` 的预览计数与实际执行计数一致（测试断言相等）；
第二次相同合并无副作用；把家族合并到自己、跨科目、跨项目分别被 400/400/404 拒绝。

## 2. C02 AI 生成变式：先校验，后候选，人工发布

| 文件 | 作用 |
|---|---|
| [variants.py](backend/apps/question_bank/services/variants.py) | `propose_variants`（源题必须已发布、非材料题、**未被封存**；批量上限 3）、`independent_checks`（答案自洽、内容摘要去重、考点归属、`ai_generated` + `PaperItem` 规则探测）、`variant_review_issues`、候选摘要 |
| [registry.py](backend/ai/prompts/registry.py) | `p2-propose-variant-v1` 提示词 + `validate_variant_payload`（复用 `apps/common/content.validate_content`，不重复实现内容契约） |
| [api.py](backend/apps/ingestion/api.py) | `POST …/variants/propose`、`GET …/variants`（当前用户的变式任务与候选） |
| [core.py](backend/apps/ingestion/services/core.py) | 候选问题在**唯一发布门禁**里按已存载荷重算（改个字段无法洗掉重复/缺答案问题）；`ai_variant` 候选发布时**强制** `origin_type=ai_generated` |
| [VariantProposePanel.tsx](frontend/src/features/questions/VariantProposePanel.tsx)、[VariantsList.tsx](frontend/src/features/imports/VariantsList.tsx) | 逐题生成（考点、条数、难度说明）、诚实结果（"已生成 N 条候选，需人工校对"或"没有可用的变式"并逐条列问题）、候选跳转到既有校对页；列表页常驻"AI 生成内容永远不会成为真实考试发生记录" |

**实测（21 条）**：无 provider → 503 `ai_not_configured` 且不建任务/候选（只留一条 `unavailable` 审计）；
脚本 provider 产出良构单选 → 一条 `awaiting_review` 候选（唯一阻断问题是既有的"答案待人工确认"）、
`llm_run` 记录校验结果与摘要；两个正确选项的单选、填空答案与空位不符、大题评分点合计不符、
题干复制源题、重复已发布题、跨科目考点、材料题源、同批重复候选——全部被拦下并**留在候选**里；
确认答案后才可发布，发布后 `origin_type=ai_generated`，挂到 `official_past` 被既有规则拒绝，
周期统计分母不变；他人项目 404；`count=10` 被截断为 3 并明确说明。

## 3. 本轮暴露并修复的问题（含一个真实功能缺口）

1. **变式生成没有封存门禁（真实缺口，已修）**：前端在联调时发现 `propose_variants` 从不调用封存解析器，
   封存题目仍可作为变式源进入生成提示——这违反 C03 的"封存内容不进生成提示"。已在**服务层**加门禁
   （在任何 provider 调用与审计行之前）并补测试：封存源 → 403 `purpose_not_allowed`、
   模型调用次数为 0、无 `propose_variants` 的 `LLMRun`、无变式任务。
2. **验收脚本自身**：合并接口返回 201 而脚本断言 200；`variant-propose` 在每行都有，严格模式匹配到 7 个
   元素——都已按真实契约收紧（断言 201 范围、把断言限定到面板）。
3. **家族此前没有任何 API**：本轮补齐列表/创建/改名/加入与移出成员，合并流程也在浏览器里真正走通
   （创建两个家族 → 查看影响 → 确认合并 → 源家族从在用列表消失、目标家族保留）。

## 4. 本轮执行的命令（可复现）

```bash
# 后端
cd backend && POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q          # 396 passed
POSTGRES_CONN_MAX_AGE=0 POSTGRES_DB=acepass_p2b2_files .venv/bin/python -m pytest \
  tests/integration/test_p2_sealing_and_merge.py tests/integration/test_p2_variants.py -q   # 30 passed
.venv/bin/ruff check apps ai domain config tests                                    # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check          # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes

# 归档反例与真故障演练命令同 docs/19 §5（库/端口换成批次 5 的一套：acepass_acceptance_p2_batch2 / 6398 / 8018 / 5188）
bash scripts/dev/reset-p2-batch2-browser.sh
cd frontend
POSTGRES_DB=acepass_acceptance_p2_batch2 REDIS_URL=redis://127.0.0.1:6398/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false \
  ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/../var/private-media-p2-batch2" POSTGRES_CONN_MAX_AGE=0 \
  ACEPASS_BROWSER_API_PORT=8018 ACEPASS_BROWSER_WEB_PORT=5188 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep-invert "@stub"   # 72 passed
# stub 专跑：加 ACEPASS_AI_PROVIDER=stub ACEPASS_RUNTIME_MODE=demo 与 --grep "@stub"                 # 8 passed
```

## 5. 未验证项（保持未验证）

- **真实生成模型质量**：变式提示词从未对真实模型运行过（无凭据），验证只覆盖脚本 provider 与离线 stub
  （stub 的占位变式没有答案，必然被自己的校验拦下，因此永远不会被误当成生成结果）。
- **真实封存语义**：封存与合并都在验收夹具上验证，没有真实考试材料或真实保留策略。
- **真实 AI 讲解/图片识别/手写转写/估分/嵌入向量、真实 ≥24 小时学习效果、远程部署与 GitHub Actions 实际执行**。
- **家族成员列表接口缺失**：当前只能按题目 id 加入/移出，界面用服务的 `member_count` 展示数量；
  一个返回成员清单的只读接口仍是可用性缺口（不影响封存与合并的正确性）。
