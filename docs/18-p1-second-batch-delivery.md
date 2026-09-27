# P1 第二批交付：前置关系与标签候选、混合检索、FSRS 记忆卡

日期：2026-09-27。起点：`75386ea`（P1 第一批交付完成）。任务来源：[17 走向 100% 的计划](17-remaining-plan-to-completion.md)
批次 2，对应验收 B04/B05/B06。

**结论：批次 2 的三个验收条目（B04 考点前置关系与标签候选、B05 中文关键词 + 向量混合检索、
B06 FSRS 主动回忆卡）已实现并通过本机实测验收。真实嵌入模型调用、真实模型标签建议与真实
≥24 小时学习效果仍为【未验证】（无可用凭据/未经过真实时间），本文档与证据文件都如实标注。**

| 检查 | 本轮实测结果 | 证据 |
|---|---|---|
| 正式后端全套 | **316 passed / 190.73s**（起点 226，本轮迁入 90 条） | [backend-suite.txt](review/2026-09-27/p1-batch2/backend-suite.txt) |
| 隔离浏览器验收（P0 36 + P1 第一批 12 + 本批 10） | **58 passed / 1.3m**，连续两次运行一致 | [browser-acceptance.txt](review/2026-09-27/p1-batch2/browser-acceptance.txt)、[复跑](review/2026-09-27/p1-batch2/browser-acceptance-rerun.txt) |
| 归档后端反例（三组，文件未改） | p01-independent **11 passed**、p02-independent **9 passed / 1 deselected**、p02-final-independent **3 passed** | [reviewer-eleven.txt](review/2026-09-27/p1-batch2/reviewer-eleven.txt)、[archived-nine.txt](review/2026-09-27/p1-batch2/archived-nine.txt)、[reviewer-three.txt](review/2026-09-27/p1-batch2/reviewer-three.txt) |
| 归档浏览器反例（原文件未改） | **2 passed** | [archived-browser.txt](review/2026-09-27/p1-batch2/archived-browser.txt) |
| 真故障演练（真 FLUSHALL / 真 SIGKILL / 双消费者） | **ok=true** | [worker-drill.txt](review/2026-09-27/p1-batch2/worker-drill.txt)、[JSON](review/2026-09-27/p1-batch2/worker-drill.json) |
| 中文检索固定金标集（B05） | 8 条查询 **recall@5 = 1.000、recall@10 = 1.000、MRR = 1.000**（关键词通道；向量通道未配置，原因明示） | [search-gold.json](review/2026-09-27/p1-batch2/search-gold.json)、[search-eval.txt](review/2026-09-27/p1-batch2/search-eval.txt)、[JSON](review/2026-09-27/p1-batch2/search-eval.json) |
| 金标文件不能静默忽略坏标签 | 故意写错标签 → 命令报 `unresolved_label` 并 **exit 1** | [search-eval-bad-gold.txt](review/2026-09-27/p1-batch2/search-eval-bad-gold.txt) |
| 干净副本发布门槛（仅提交内容） | 代理组件与真实全栈 HTTPS/CSRF 登录均 exit 0，既有配置哨兵保持不变 | [clean-export-release-gate.txt](review/2026-09-27/p1-batch2/clean-export-release-gate.txt) |
| 静态检查 | `ruff check` 通过、`manage.py check` 无问题、`makemigrations --check --dry-run` **No changes**、`tsc -b` 与 `vite build` 通过 | 见 §5 |

## 1. B04 考点前置关系（`knowledge_relation`）

| 文件 | 作用 |
|---|---|
| [models.py](backend/apps/knowledge/models.py) | `KnowledgeRelation`：同大纲有向边（前置 → 依赖）、`(from,to,type)` 唯一、自环 CheckConstraint、停用而非删除 |
| [relations.py](backend/apps/knowledge/services/relations.py) | 加边前 BFS 环检测（返回完整环路径与名称）、同大纲校验、`unmet_prerequisites`（未诊断 ≠ 已掌握）、`graph_summary` |
| [api.py](backend/apps/knowledge/api.py) | `GET/POST /projects/{id}/knowledge-relations`、`DELETE …/{relation_id}`、`GET …/knowledge-nodes/{node_id}/prerequisites` |
| [planner.py](backend/apps/learning/services/planner.py) | 补弱候选按前置关系重排：先排未满足的前置考点（`reason_codes` 含 `prerequisite_first`、`unblocks:<依赖考点>`）；前置无题时保留原考点并显式写 `prerequisite_missing_question` + `deficit_notice`，不静默替换 |
| [KnowledgePage.tsx](frontend/src/features/knowledge/KnowledgePage.tsx) | 前置关系面板：两个下拉、加边、边表与停用，环被拒绝时就地显示 `加入该关系会形成环：C → A → B → C` 与"服务器已拒绝，没有创建任何关系" |

**实测**：加边成功 201、反向加边 400 且图不变（边数仍为 1）、停用后列表不再显示该边但数据库保留记录；
计划器在前置未满足时把前置考点排在前面，前置无题时给出说明。测试：`tests/integration/test_p1_prerequisites_and_tags.py`（6 条）。

## 2. B04 标签候选（AI 建议，人工决定）

| 文件 | 作用 |
|---|---|
| [suggestions.py](backend/apps/knowledge/services/suggestions.py) | `propose_tags`（provider 不支持 `suggest_tags` → 明确 `ai_not_configured`，写 `llm_run` 后失败）、`accept_suggestion`（只写入**新的辅助标签映射修订**，权重 0；主权重必须已合计 1）、`reject_suggestion`、`resolve_node_names`（逐字/别名/编码匹配） |
| [registry.py](backend/ai/prompts/registry.py) | `p1-suggest-tags-v1` 提示词与校验：只接受逐字来自本科目已发布大纲的名称，自创名称被丢弃并记录 `unknown_tag_name` |
| [KnowledgePage.tsx](frontend/src/features/knowledge/KnowledgePage.tsx) | 标签建议面板：生成建议、勾选、采纳/否决、显示新增名称、未解析名称与映射修订号；`ai_not_configured` 时就地显示「AI 未配置」，并常驻说明"采纳只写辅助标签（权重 0），不会创建或改名考点" |

**实测**：无 provider 时建议数为 0 且考点数量不变；测试用 provider 返回「已存在考点 + 自创考点」时，
只有逐字命中的那条进入建议，`llm_run.validation_result` 记录 `unknown_tag_name`；采纳后主权重合计仍为
`1`、新增行 `is_primary=false / weight=0`、旧修订原样保留；无法解析的名称被拒绝且不创建节点。

## 3. B05 中文关键词 + 向量混合检索

| 文件 | 作用 |
|---|---|
| [tokenize.py](backend/apps/search/services/tokenize.py) | NFKC + casefold；CJK 连续段 → 一元词 + 相邻二元词；拉丁/数字整体保留；标点/控制字符丢弃；`TOKENIZER_VERSION=zh-char-ngram-v1` |
| [models.py](backend/apps/search/models.py) | `SearchDocument` 投影（题干、选项、材料、考点名；**从不包含答案/rubric/解析**），条件唯一约束与范围索引 |
| [index.py](backend/apps/search/services/index.py) | `visibility_filter`：所有者 → 项目 → 实时校验 `published` 且未撤回 → 科目归属 → holdout 家族排除（P2 封存挂载点）；`reindex_project` 幂等，被排除行写 `exclusion_reason` |
| [hybrid.py](backend/apps/search/services/hybrid.py) | 先权限过滤，再 BM25（k1=1.2, b=0.75）与余弦向量通道，RRF（k=60）融合，确定性 tie-break |
| [vector.py](backend/apps/search/services/vector.py)、[embeddings.py](backend/ai/providers/embeddings.py) | 可配置嵌入 provider（真实 HTTPS，1 次重试）；未配置时 `available=false` 且给出中文原因；`AI_PROVIDER=stub` 不伪造向量 |
| [api.py](backend/apps/search/api.py) | `GET /projects/{id}/search`、`POST …/search/reindex` |
| [search_eval.py](backend/apps/search/management/commands/search_eval.py) | 固定金标集评测：标签运行时解析（重建库仍可复现）、recall/precision@k、MRR、逐条 miss、无法解析标签即失败退出；`--print-gold-template` 打印当前库可用标签 |
| [SearchPage.tsx](frontend/src/features/search/SearchPage.tsx) | 检索页：通道选择、逐通道名次与融合分、向量不可用横幅显示后端原因、重建索引与收录/排除计数、「没有匹配内容」空态 |

**实测（金标集，验收夹具 10 篇文档）**：8 条中文查询全部 **rank 1**（recall@5/@10 = 1.000，MRR = 1.000），
向量通道未配置时明确降级为关键词并给出原因；故意写错标签导致命令 exit 1（不会被静默忽略）。

**权限边界（自动化反例）**：把草稿版本、已撤回版本、holdout 题族与跨项目文档的
`is_searchable` 全部保持 `True`，并用脚本化 provider 让它们的余弦相似度 **等于 1.0**；
关键词、向量与混合三种通道都不返回它们，而对照组的项目 B 能返回自己的同一文档。

## 4. B06 FSRS 主动回忆卡

| 文件 | 作用 |
|---|---|
| [fsrs.py](backend/domain/memory/fsrs.py) | 纯 Python FSRS-4.5：17 个公开默认权重、`FSRS_VERSION=fsrs-4.5-default-v1`、纯函数 `schedule(state, rating, reviewed_at, …)`（从不读时钟）、间隔上限与难度钳制 |
| [models.py](backend/apps/memory/models.py) | `MemoryCard`（当前投影）+ `MemoryReviewLog`（只追加账本，含复习前后状态与版本），`(card, idempotency_key)` 唯一 |
| [scheduler.py](backend/apps/memory/services/scheduler.py) | `create_card/get_or_create_card`、`review_card`（事务 + 行锁 + 幂等重放 + 同键异评级 409）、`rebuild_card_from_logs`（按日志重放并报告是否一致）、`review_candidates`（可解释优先级） |
| [api.py](backend/apps/memory/api.py) | 列表/建卡/复习/日志/重放校验/暂停/恢复，全部所有者隔离（他人项目与卡片 404） |
| [planner.py](backend/apps/learning/services/planner.py) | 只把**已到期**的卡排进当日计划（`TaskKind.MEMORY_REVIEW`，任务带 `memory_card`），刷新计划不重复排队，题目撤回后不再重排；预算仍是唯一容量限制 |
| [MemoryPage.tsx](frontend/src/features/memory/MemoryPage.tsx) | 记忆卡页：建卡、到期列表、四档评级（请求飞行中禁用，双击不会重复复习）、下次到期与间隔、复习日志、重放校验、暂停/恢复，并常驻「记忆卡只反映记忆强度，不改变解题能力或考点掌握状态」 |

**实测**：复习写入恰好一条日志且卡片投影前进；同幂等键重放不产生第二条日志、响应逐字节相同；
手工破坏卡片状态后重放检测出 `matches=false` 并给出重放真值；复习前后 `LearningEvidence`、
`LearnerKnowledgeState`、评分事件与作答数**完全不变**；未到期的卡不会被提前排进计划；
题目撤回后记忆通道不再重排；极小预算下计划总额不超过预算。

## 5. 本轮执行的命令（可复现）

```bash
# 后端
cd backend && POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q          # 316 passed
POSTGRES_CONN_MAX_AGE=0 POSTGRES_DB=acepass_batch2_a .venv/bin/python -m pytest \
  tests/unit/test_fsrs.py tests/unit/test_search_tokenize.py \
  tests/integration/test_memory_cards.py tests/integration/test_search_hybrid.py \
  tests/integration/test_p1_prerequisites_and_tags.py tests/integration/test_p1_memory_plan.py -q   # 90 passed
.venv/bin/ruff check apps ai domain config tests                                    # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check          # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes

# 归档反例（文件未改）
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p01-independent" backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p01-independent/test_*.py -c backend/pytest.ini --ds=p01_independent_settings -q   # 11 passed
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p02-independent/test_*.py -c backend/pytest.ini --ds=p02_independent_settings -q \
  -k 'not generation_migration_cannot_promote'                                       # 9 passed, 1 deselected
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-final-independent" backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p02-final-independent/test_*.py -c backend/pytest.ini --ds=review_settings -q        # 3 passed

# 浏览器（独占库 acepass_acceptance_p1_batch2、Redis 6395、媒体目录、端口 8015/5185、真实 Worker）
bash scripts/dev/reset-p1-batch2-browser.sh
cd frontend && POSTGRES_DB=acepass_acceptance_p1_batch2 REDIS_URL=redis://127.0.0.1:6395/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false \
  ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/../var/private-media-p1-batch2" POSTGRES_CONN_MAX_AGE=0 \
  ACEPASS_BROWSER_API_PORT=8015 ACEPASS_BROWSER_WEB_PORT=5185 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts          # 58 passed
# 归档浏览器反例（先由主套件建好夹具库，再指向同一个已建库运行）
cd .. && POSTGRES_DB=acepass_acceptance_p1_batch2 REDIS_URL=redis://127.0.0.1:6394/0 \
  ACEPASS_INLINE_TASKS=false ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/var/private-media-p1-batch2" \
  ACEPASS_BROWSER_API_PORT=8014 ACEPASS_BROWSER_WEB_PORT=5184 \
  frontend/node_modules/.bin/playwright test --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs   # 2 passed

# 真故障演练（独占 Redis，显式允许 FLUSHALL，stub provider 且必须显式关掉内联任务）
ACEPASS_WORKER_DRILL_REPORT="$PWD/docs/review/2026-09-27/p1-batch2/worker-drill.json" \
  ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub \
  ACEPASS_INLINE_TASKS=false POSTGRES_DB=acepass_acceptance_p1_batch2_drill \
  REDIS_URL=redis://127.0.0.1:6395/0 ACEPASS_OUTBOX_LEASE_SECONDS=5 POSTGRES_CONN_MAX_AGE=0 \
  PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py      # ok: true
# 演练库需先 `migrate` + `bootstrap_acceptance --allow <db>`（脚本本身不建库、不建账户）

# 检索金标集
cd backend && POSTGRES_DB=acepass_acceptance_p1_batch2 REDIS_URL=redis://127.0.0.1:6395/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev POSTGRES_CONN_MAX_AGE=0 \
  .venv/bin/python manage.py search_eval --project <项目A> --user acceptance@acepass.local \
  --gold ../docs/review/2026-09-27/p1-batch2/search-gold.json --k 5,10 --min-recall 0.8    # passed=True

# 干净副本发布门槛（在提交后的树上执行，见证据文件）
CLEAN=$(mktemp -d) && git archive HEAD | tar -x -C "$CLEAN"
cp -R frontend/dist "$CLEAN/frontend/dist"
printf 'TEST_EXISTING_CONFIGURATION=preserve-this-existing-deployment\n' > "$CLEAN/infra/docker/.env"
cd "$CLEAN" && bash scripts/verify_proxy.sh component && bash scripts/verify_proxy.sh full-stack

# 前端
cd frontend && npx tsc -b && npx vite build
```

## 6. 前端与验收运行说明

- 本批新增浏览器用例 5 条 × desktop/mobile 两个 project = 10 条（`frontend/tests/acceptance/p1-batch2.spec.ts`），
  与既有 P0 36 条、P1 第一批 12 条在同一隔离套件里运行。
- 首轮运行时出现过 3 条**测试自身竞态**导致的失败（异步下拉选项在一次采样时尚未到达；
  以及归档浏览器反例在未建库的库上运行）。已改为可重试断言（`expect.poll` / `toBeEnabled`）并在
  已建夹具库上重跑归档反例；修复后连续两次全绿（58 passed），失败原因与修复都已记录，未放宽任何产品断言。
- 归档浏览器反例的配置没有自己的 globalSetup：必须先用主套件的 globalSetup 建好夹具库，
  否则会在空库上因 `relation "accounts_user" does not exist` 失败（这是运行顺序问题，不是产品回归）。

## 7. 未验证项（保持未验证）

- **真实嵌入模型**：无可用凭据，`OpenAICompatibleEmbeddingProvider` 的真实 HTTP 往返未执行；
  向量通道的真实检索质量、以及真实向量下的混合排序都未验证。测试中的向量来自注入的确定性 provider。
- **真实模型标签建议**：无可用文本模型凭据（DeepSeek key 余额不足 HTTP 402），
  本轮的标签建议只由测试 provider 产出，`is_stub` 语义保持诚实。
- **真实 AI 讲解/图片识别**：与 P1 第一批相同，仍未验证。
- **真实 ≥24 小时学习效果**：仍未经过真实时间；FSRS 的排期逻辑只由可注入时间验证。
- **远程部署与 GitHub Actions 实际执行**：仍未验证，发布门槛只在提交内容的干净副本上本机执行。
