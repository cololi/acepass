# P1 第三批交付：手写转写确认、AI 逐点估分、AI 诊断追问、经校验 SSE

日期：2026-09-27。起点：`44a0c6c`（P1 第二批交付完成）。任务来源：[17 走向 100% 的计划](17-remaining-plan-to-completion.md)
批次 3，对应验收 B07/B08。

**结论：批次 3 的两个验收条目已实现并通过本机实测验收。** B07 的三条要求——"AI 大题评分逐点评估"、
"人工确认前只有 estimated_score"、"有字迹不清时先确认转写"——都有可复现证据；B08 的
"SSE 断线重连不重复调用"与"只发送验证后的内容片段、失效来源被拦截"由真实 HTTP 流式读取与
数据库计数验证。**真实视觉/文本模型仍未验证**（本机凭据不可用），因此：

- 无视觉模型时，手写转写走**学习者人工录入**路径（`origin="manual"`，已确认、无模型调用），
  照片作答不会因为"没有模型"而永久无法估分或诊断；
- 有模型时，转写只是**建议**，学习者确认或修改后才生效，未确认前估分与诊断被 409 拒绝；
- AI 估分写入 `status=estimated` 的独立事件，**从不**成为正式分；浏览器验收中的 stub 环境
  故意不产出任何评分点分数，接口如实返回"没有可用估计"而不是 0 分。

| 检查 | 本轮实测结果 | 证据 |
|---|---|---|
| 正式后端全套 | **340 passed / 94.18s**（起点 316，本轮迁入 24 条） | [backend-suite.txt](review/2026-09-27/p1-batch3/backend-suite.txt) |
| 隔离浏览器验收（P0 36 + 批次 1 12 + 批次 2 10 + 本批 4） | **62 passed / 1.3m** | [browser-acceptance.txt](review/2026-09-27/p1-batch3/browser-acceptance.txt) |
| 隔离浏览器验收（stub provider 专跑，`--grep "@stub"`） | **6 passed / 16.1s** | [browser-acceptance-stub.txt](review/2026-09-27/p1-batch3/browser-acceptance-stub.txt) |
| 归档后端反例（三组，文件未改） | 11 passed / 9 passed（1 deselected）/ 3 passed | [reviewer-eleven.txt](review/2026-09-27/p1-batch3/reviewer-eleven.txt)、[archived-nine.txt](review/2026-09-27/p1-batch3/archived-nine.txt)、[reviewer-three.txt](review/2026-09-27/p1-batch3/reviewer-three.txt) |
| 归档浏览器反例（原文件未改） | **2 passed** | [archived-browser.txt](review/2026-09-27/p1-batch3/archived-browser.txt) |
| 真故障演练 | **ok=true** | [worker-drill.txt](review/2026-09-27/p1-batch3/worker-drill.txt)、[JSON](review/2026-09-27/p1-batch3/worker-drill.json) |
| 干净副本发布门槛 | 代理组件与真实全栈 HTTPS/CSRF 登录均 exit 0，哨兵不变 | [clean-export-release-gate.txt](review/2026-09-27/p1-batch3/clean-export-release-gate.txt) |

## 1. B07：手写转写确认

| 文件 | 作用 |
|---|---|
| [models.py](backend/apps/practice/models.py) | `AnswerTranscription`（`origin=model|manual`、`raw_text` 建议 / `confirmed_text` 唯一可信、`doubts` 原样保留、`is_stub`）；`DiagnosisFollowUp`；迁移 `0003_p1_transcription_and_follow_ups`、`0004_transcription_origin` |
| [transcription.py](backend/apps/practice/services/transcription.py) | `assert_transcription_confirmed` **唯一门禁**（被估分与诊断复用）、`handwriting_assets`、`request_transcription`（视觉 provider）、`record_manual_transcription`（无模型的人工路径，直接 confirmed）、`confirm_transcription` / `reject_transcription`（写 `ContentRevision`） |
| [registry.py](backend/ai/prompts/registry.py) | `p1-transcribe-v1`：只转写照片中真实存在的内容，看不清用占位符并写 doubts，不纠正推导、不给分、不给掌握结论；校验器拒绝空文本并保留疑点 |
| [AiAssistPanels.tsx](frontend/src/features/practice/AiAssistPanels.tsx) | 转写面板：逐个照片的建议/疑点/可编辑文本；人工录入按钮（`origin=manual` 显示为「人工录入（非模型识别）」）；`ai_not_configured` 时明示并给出可用的录入路径；确认后 409 提示立即消失 |

**实测**：没有 provider 时 `POST /transcriptions` 503 `ai_not_configured`（不写任何转写行）；stub 环境的
提案 `is_stub=true`、`origin=model`、`status=proposed`；确认写 `confirmed_text`+`ContentRevision`；
已确认的模型行不能被改写或重新转写；人工录入 `origin=manual`、`status=confirmed`、`llm_run_id=null`、
无置信度与疑点；空白人工录入 400 `invalid_input`（"不能为空"）。

## 2. B07：AI 逐点估分（人工确认前只有 estimated_score）

| 文件 | 作用 |
|---|---|
| [estimation.py](backend/apps/practice/services/estimation.py) | `estimate_grade`：先过转写门禁与内容门禁，再调用 `estimate_grade` 能力；按 frozen rubric 逐点校验（未知 criterion 丢弃、超过满分截断并记录问题）；写入独立 `GradeEvent(kind=ai_estimate, status=estimated, method=ai_estimated, estimated_score=…, confirmed_score=None)`；**不动** `current_grade_event`、不写学习证据、不改考点状态；只把上一个 `ai_estimate` 标记 superseded |
| [GradingPage.tsx](frontend/src/features/practice/GradingPage.tsx) | 逐评分点估计表（满分/估计分/依据/缺失证据）、常驻「参考估计：未确认，不计入正式分数」、`按估计值预填`（只填充人工输入，绝不代替确认）；空估计显示"模型没有给出评分点估计"而不是 0 |

**实测（不变量断言）**：估分前后 `attempt.current_grade_event`、所有非 `ai_estimate` 评分事件
（含确认分、状态、方法、superseded 标记）、`LearningEvidence` 集合与用户证据计数、
`LearnerKnowledgeState` 行**完全一致**；估分后仍可正常人工确认，且确认不会与估计事件冲突；
stub 返回空 criteria 时接口 503 且**不写事件**（0 分会被误读成真实评分）。

## 3. B07：AI 诊断追问

| 文件 | 作用 |
|---|---|
| [diagnosis.py](backend/apps/practice/services/diagnosis.py) | `propose_diagnosis`：同样先过转写门禁；只接受受控 `error_type`（`DIAGNOSIS_ERROR_TYPES`），无证据的原因自动降级为 `unknown`；写入 `ErrorDiagnosis(origin=model, status=proposed)` 与 `DiagnosisFollowUp(pending)`；`answer_follow_up` / `skip_follow_up` |
| [AiAssistPanels.tsx](frontend/src/features/practice/AiAssistPanels.tsx) | 诊断面板：可能原因（带证据）+ 追问问题（回答/跳过）+ 人工确认/否定（走既有 `/diagnosis`），常驻"诊断不改变分数或掌握状态"；`unknown` 渲染为「证据不足，暂不判断」 |

**实测**：有证据的原因入库为 `proposed`，无证据的被降级为 `unknown`（不会出现"粗心"这类断言）；
追问可回答/跳过；诊断前后分数、证据与考点状态不变；无可用原因时不写任何行并返回空列表 + 说明。

## 4. B08：经校验的分段 SSE 与重连

| 文件 | 作用 |
|---|---|
| [models.py](backend/apps/tutoring/models.py) | `TutorSegment`（每个**已通过结构化校验**的结果块一行，`(job,index)` 唯一，`is_stale` + `stale_reason`）；迁移 `0003_b08_tutor_segment` |
| [streaming.py](backend/apps/tutoring/services/streaming.py) | `append_segments`（幂等镜像，随 `_finalize_success` 同事务提交）、`mark_stale`、`source_is_stale`（冻结题目/答案版本与实时内容不一致即失效）、`delivery_block_reason`、`stream_events`（`status → segment(index>after) → done`，飞行中只轮询数据库并发送 keep-alive，超时发 `timeout`） |
| [api.py](backend/apps/tutoring/api.py) | `GET …/tutor-jobs/{job_id}/stream`（`Last-Event-ID` 或 `?after=` 断点续传）与 `…/segments`；两者都只读：不调用模型、不创建 `LLMRun`、不入队 outbox |
| [tutorStream.ts](frontend/src/api/tutorStream.ts)、[AiAssistPanels.tsx](frontend/src/features/practice/AiAssistPanels.tsx) | 流式面板：逐段渲染、只渲染验证后片段、失效即隐藏并提示"内容已失效"，超时可"继续接收"（同样的 `?after=`，不重复调用模型），stub 内容明确标注 |

**实测**：真实 HTTP 流式读取得到 `status → id: 0 … → done`；`?after=0` 重连**不重发**已收到的分段、
`/ai-runs` 计数不变（重连零成本）；题目版本变更后流只发一个 `error: stale_source`、**零个**分段，
`/segments` 报告 `is_stale=true`；校验失败的 job 没有任何分段（不会出现"部分内容"）；他人 job 404。

## 5. 本轮执行的命令（可复现）

```bash
# 后端
cd backend && POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q          # 340 passed
POSTGRES_CONN_MAX_AGE=0 POSTGRES_DB=acepass_b3_files .venv/bin/python -m pytest \
  tests/integration/test_p1_transcription_and_estimation.py tests/integration/test_p1_tutor_stream.py -q  # 24 passed
.venv/bin/ruff check apps ai domain config tests                                    # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check          # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes

# 归档反例（文件未改）：p01-independent 11、p02-independent 9(+1 deselected)、p02-final-independent 3
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p01-independent" backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p01-independent/test_*.py -c backend/pytest.ini --ds=p01_independent_settings -q

# 浏览器（独占库 acepass_acceptance_p1_batch3、Redis 6396、媒体目录、端口 8016/5186）
bash scripts/dev/reset-p1-batch3-browser.sh
cd frontend
# 1) 主套件：无 provider 环境（真实 AI 未配置时的诚实路径）
POSTGRES_DB=acepass_acceptance_p1_batch3 REDIS_URL=redis://127.0.0.1:6396/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false \
  ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/../var/private-media-p1-batch3" POSTGRES_CONN_MAX_AGE=0 \
  ACEPASS_BROWSER_API_PORT=8016 ACEPASS_BROWSER_WEB_PORT=5186 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep-invert "@stub"   # 62 passed
# 2) stub 专跑：显式 stub provider + demo 运行模式（stub 结果全程标注）
bash ../scripts/dev/reset-p1-batch3-browser.sh
POSTGRES_DB=acepass_acceptance_p1_batch3 REDIS_URL=redis://127.0.0.1:6396/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false ACEPASS_AI_PROVIDER=stub \
  ACEPASS_RUNTIME_MODE=demo ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/../var/private-media-p1-batch3" \
  POSTGRES_CONN_MAX_AGE=0 ACEPASS_BROWSER_API_PORT=8016 ACEPASS_BROWSER_WEB_PORT=5186 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep "@stub"          # 6 passed

# 归档浏览器反例（先由主套件建好夹具库，再指向同一库；harness 固定 8014/5184 与 Redis 6394）
cd .. && POSTGRES_DB=acepass_acceptance_p1_batch3 REDIS_URL=redis://127.0.0.1:6394/0 \
  ACEPASS_INLINE_TASKS=false ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/var/private-media-p1-batch3" \
  ACEPASS_BROWSER_API_PORT=8014 ACEPASS_BROWSER_WEB_PORT=5184 \
  frontend/node_modules/.bin/playwright test --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs  # 2 passed

# 真故障演练（演练库需先 migrate + bootstrap_acceptance --allow <db>）
ACEPASS_WORKER_DRILL_REPORT="$PWD/docs/review/2026-09-27/p1-batch3/worker-drill.json" \
  ACEPASS_WORKER_DRILL_ALLOW_FLUSHALL=1 ACEPASS_RUNTIME_MODE=test ACEPASS_AI_PROVIDER=stub \
  ACEPASS_INLINE_TASKS=false POSTGRES_DB=acepass_acceptance_p1_batch3_drill \
  REDIS_URL=redis://127.0.0.1:6396/0 ACEPASS_OUTBOX_LEASE_SECONDS=5 POSTGRES_CONN_MAX_AGE=0 \
  PYTHONPATH="$PWD/backend" backend/.venv/bin/python scripts/verify_worker_e2e.py      # ok: true

# 前端
cd frontend && npx tsc -b && npx vite build
```

## 6. 本轮暴露并修复的问题（都由浏览器/联调验收发现，不是"放宽断言"）

1. **转写确认/否决路径 404**：前端把 confirm/reject 拼成了 attempt 作用域
   （`/attempts/{id}/transcriptions/{tid}/confirm`），后端路由是项目作用域
   （`/transcriptions/{tid}/confirm`）。stub 专跑第一次执行时真实复现 404，已改为后端路由并重跑通过。
2. **无视觉模型时手写作答无处可去**：原先只实现了"模型转写 + 人工确认"，没有模型时照片作答会被
   409 卡死（P0 的"无模型走人工"规则被破坏）。本轮补上 `origin="manual"` 的人工录入路径，
   并在浏览器里验证：先 409（门禁），人工录入后 503（真实原因：未配置模型），全程不出现任何编造数字。
3. **空白人工录入静默走模型**：`text` 为空串时会落回模型分支。已改为"显式传入 text 即人工路径"，
   空白直接 400 且提示"不能为空"（测试同步收紧，验证的是这条消息而不是任意 400）。
4. **验收脚本自身的三处问题**（已修，未放宽任何产品断言）：主套件的转写用例原先假设估分面板在刷题页
   （实际在人工评分页）；SSE 用例读取的字段名应为 `tutor_job_id`（用 undefined 拼 URL 会得到 422）；
   重连零成本断言最初把"创建任务的 1 次调用"也算进去了，现改为任务完成后取基线。

## 7. 未验证项（保持未验证）

- **真实视觉模型转写**、**真实文本模型估分与诊断**：本机凭据不可用（DeepSeek key 余额 402、无视觉模型），
  浏览器 stub 专跑只证明流程与标注诚实；真实输出质量、成本与失败率未验证。
- **真实 AI 讲解/图片识别**（P0 A36）与 **真实嵌入向量检索**（B05）同前，仍为未验证。
- **真实 ≥24 小时学习效果**：仍未经过真实时间。
- **远程部署与 GitHub Actions 实际执行**：仍未验证，发布门槛只在提交内容的干净副本上本机执行。
- **真实多进程 Worker 下的飞行中流式**：SSE 的飞行中轮询只在真实排队任务 + 内联执行下验证过，
  没有第二个进程参与；并发重连与 finalize 事务竞争也没有并发测试。
