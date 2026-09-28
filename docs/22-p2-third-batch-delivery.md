# P2 第三批交付：限时模拟考试（C05）、诚实报告范围（C06）、受限数学判分（C07）、效果校准（C08）

日期：2026-09-27／28。起点：`ac58807`（P2 第二批交付完成）。任务来源：
[17 走向 100% 的计划](17-remaining-plan-to-completion.md) 批次 6——**P1/P2 规划的最后一批**。

**结论：批次 6 的四个验收条目已实现并通过本机实测验收。至此 `docs/05` §2/§3 的
A01—A42、B01—B08、C01—C08 全部有实现、有实际执行的验证与证据，或明确标注外部阻塞未验证。**

| 检查 | 本轮实测结果 | 证据 |
|---|---|---|
| 正式后端全套 | **489 passed / 251.38s**（起点 396，本轮迁入 93 条） | [backend-suite.txt](review/2026-09-27/p2-batch3/backend-suite.txt) |
| 隔离浏览器主套件 | **78 passed / 1.7m**，连续两次一致 | [browser-acceptance.txt](review/2026-09-27/p2-batch3/browser-acceptance.txt)、[复跑](review/2026-09-27/p2-batch3/browser-acceptance-rerun.txt) |
| 隔离浏览器 stub 专跑 | **8 passed** | [browser-acceptance-stub.txt](review/2026-09-27/p2-batch3/browser-acceptance-stub.txt) |
| 归档后端反例（三组，文件未改） | 11 / 9（1 deselected）/ 3 passed | [reviewer-eleven.txt](review/2026-09-27/p2-batch3/reviewer-eleven.txt)、[archived-nine.txt](review/2026-09-27/p2-batch3/archived-nine.txt)、[reviewer-three.txt](review/2026-09-27/p2-batch3/reviewer-three.txt) |
| 归档浏览器反例（原文件未改） | **2 passed** | [archived-browser.txt](review/2026-09-27/p2-batch3/archived-browser.txt) |
| 真故障演练 | **ok=true** | [worker-drill.txt](review/2026-09-27/p2-batch3/worker-drill.txt)、[JSON](review/2026-09-27/p2-batch3/worker-drill.json) |
| 干净副本发布门槛 | 代理组件与真实全栈 HTTPS/CSRF 登录均 exit 0，哨兵不变 | [clean-export-release-gate.txt](review/2026-09-27/p2-batch3/clean-export-release-gate.txt) |

## 1. C05 限时模拟考试

| 文件 | 作用 |
|---|---|
| [sessions.py](backend/apps/practice/services/sessions.py) | `create_session(mode=mock_exam)`：时长由显式 `duration_minutes`（5–600）或已发布规范的 `time_rules` 推出；`exam_started_at`/`exam_deadline` 由**服务端**写一次；`effective_deadline`、`expire_session_if_due`（行锁内二次校验，`finished_at = 截止时间`，一个 outbox 事件）、`assert_submission_open` |
| [models.py](backend/apps/practice/models.py) | `exam_started_at`/`expired_at`（迁移 `0005_p2_mock_exam_deadline`）；`save()` 守卫：已写入的截止时间不可改、已结束的会话不可重开 |
| [expire_mock_exams.py](backend/apps/practice/management/commands/expire_mock_exams.py) | 幂等的过期清理入口（worker/cron 可用；纯 Celery 任务需动 `config/`，故用管理命令） |
| [PracticePage.tsx](frontend/src/features/practice/PracticePage.tsx) | 开考卡片（科目/时长/题目数）、**服务端锚定**倒计时（`exam_deadline − server_time` + 单调时钟，只读一次墙钟）、考试中不出现任何分数/解析/辅导入口、一次性交卷（二次确认）、409 显示服务端消息、结束后才出现成绩与逐题结果 |

**实测（14 条）**：缺规范/时长无界 → 拒绝，不存在"没有截止时间的考试"；客户端传来的 `exam_deadline/deadline/now/started_at` 全部被忽略（断言存储值等于服务端时钟+时长）；
刷新、反复读取、呈现题项、断线重连都不会移动截止时间（存储值逐次相同）；重复交卷是空操作且不可重开；
过期后一次读取即自动结束（`finished_at == 截止时间`，不是"现在"）且只产生一个 outbox 事件；
过期后的提交被 409 拒绝且不落任何作答，截止前的提交成功；考试进行中会话/呈现/提交/成绩查询/确认评分/
reveal/辅导/评分队列/报告/错题本/AI 估分/含答案资源**全部**拒绝或隐藏（逐面断言真实载荷与状态码，
结束后同一批入口恢复正常）；两线程并发触发过期只结束一次（真实两条连接）。

**本轮发现的真实泄漏（已修）**：`verification_gate` 原来只覆盖 `verification` 模式，因此模拟考试进行中，
**同一题目的并行练习会话可以直接 reveal 出完整答案**（并会返回分数）。修复为 `GATED_MODES = (VERIFICATION, MOCK_EXAM)`，
覆盖范围仍以"已呈现"为条件、以考试截止时间为界（不同于验证的无限期）；反例测试先复原修复确认失败、再恢复通过。

## 2. C06 报告不得把未完成说成最终

| 文件 | 作用 |
|---|---|
| [reports.py](backend/apps/analytics/services/reports.py) | `incomplete_scope`（逐原因计数 + 受影响作答/题项，原因：`unscored`、`pending_review`、`partially_confirmed`、`disputed_content`、`invalidated_grade`、`void_grade`、`ai_estimated`）、`final_result`（**未完成时恒为 null**）、`aggregate`（`score_rate` 仅在 final 时给出，否则只给标注清楚的 `lower_bound` 与 `unresolved_max_score`）、每个分桶的 `is_final`/`fraction_status`；覆盖视图给出 `completion`（未全部完整时 `coverage_rate` 为 null） |
| [ReportsPage.tsx](frontend/src/features/reports/ReportsPage.tsx) | 「成绩未完成」横幅（逐条原因 + 数量 + 受影响项）、「已确认部分（下限）」卡片（含"还有 X 分未评"与"这不是最终得分率"）、分桶下限标注、覆盖完成度提示 |

**实测（11 条）**：未评分大题 → 出现在 `incomplete_scope`、`final_result` 为 null、载荷里**不存在**任何排名/通过率/百分比形式的最终结论键
（递归键集断言）；把评分点全部确认后该原因消失、`final_result` 出现（双向断言）；
争议答案、失效判分、作废判分各自出现在对应原因里；进行中的验证/模拟考试仍被排除且**不**被算成"待评"；
浏览器里再验证一次：确认一次评分后 `pending_review` 计数**恰好减一**、已确认分上升，报告界面同步。

## 3. C07 受限数学判分

| 文件 | 作用 |
|---|---|
| [expressions.py](backend/domain/grading/expressions.py) | 自带的词法/语法/求值器：只用数字、`+ - * / ^`、括号、白名单函数（`sqrt/abs/sin/cos/tan/log/ln/exp`）与常量（`pi/e`）；**没有** `eval`/`exec`/`compile`、没有属性/下标/字符串/关键字、没有白名单外的名字 |
| [adapters.py](backend/domain/grading/adapters.py) | 填空题可声明 `equivalence: "expression"`；先字面匹配 → 采样等价 → 任何"未知"（语法/超限/超时/定义域/未知符号）一律**转人工**，只有被证明不等价才按 `mismatch_policy` 记错；规则快照新增 `expression_blanks`；未加标记的填空行为逐字节不变 |

**限制（全部有常量与测试）**：输入长度 200、token 160、AST 节点 128、嵌套深度 12、
整次比较的求值步数 4000、指数上限 64（`9^9^9` 与 `2^65` 拒绝）、结果上限 1e30、变量数 2、采样点 24、
默认墙钟预算 50ms（上限 2s，可被单空覆盖但被钳制）；**超时/超限后永不返回"等价"**。

**"不能执行代码/读文件/联网"**：语法层没有承载字符串、点号、方括号或关键字的 token；
14 条恶意输入（`__import__("os").system(...)`、`open("/etc/passwd").read()`、`(1).__class__.__bases__`、
`lambda: 1`、`[x for x in ()]`、`x.__dict__`、`eval(x)`、`os.system(x)` …）全部是语法错误并转人工；
用 canary 文件 + `builtins.open` 触发线 + `socket.socket` 触发线证明没有打开/创建/联网；
另有**静态 AST 检查**（模块自身源码）：导入白名单、禁用名字（`eval/exec/compile/__import__/open/globals/...`）、
禁止的 dunder 与属性、调用目标必须是本模块函数或白名单内建——将来有人加一行 `import os` 或 `eval(...)` 会让测试直接失败。

## 4. C08 效果校准（说明可比性与样本数，不做因果结论）

| 文件 | 作用 |
|---|---|
| [calibration.py](backend/apps/analytics/services/calibration.py) | 按（题型 × 难度档 × 时限条件 × 暴露状态）分组；只统计**已确认**判分；`MIN_GROUP_SAMPLE = 5`，样本不足的组 `statistics` 为 **null**（不是"给数字再警告"）；难度代理明确写作 `max_score_band`（题项冻结分值区间）并说明它不是认知难度；时限用服务端实测用时与规范时限比较；暴露状态复用 C04 的污染规则；`comparisons` 只在可比较的配对下给出差值，且差值必须带样本数与离散度；`caveats` 明确"同一个人、非因果、样本/内容/暴露条件不同、自评与 AI 估分已排除、要因果需设计实验" |
| [CalibrationPanel.tsx](frontend/src/features/reports/CalibrationPanel.tsx) | 分组表（题型/难度档/时限/暴露/样本数/状态）、样本不足组不显示任何统计量、逐组可比性说明、可比较配对的差值与样本量/离散度、不可比较清单与原因、caveats 原文展示 |

**"不做因果结论"是代码强制的**：`assert_no_causal_summary(payload)` 在每次返回前递归检查，
发现 `improvement*/gain/pass_probability/pass_rate/rank/overall_delta/causal*/提升*/通过概率` 之类的键，
或发现某条 `delta` 缺少样本数/离散度/caveats，直接抛错（开发中就抓到过一次形状错误）；
测试既断言序列化后的键集，也用三个坏载荷验证这个守卫真的会拦。

## 5. 本轮执行的命令（可复现）

```bash
# 后端
cd backend && POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q          # 489 passed
POSTGRES_CONN_MAX_AGE=0 POSTGRES_DB=acepass_p2b3_files .venv/bin/python -m pytest \
  tests/integration/test_p2_mock_exam.py tests/integration/test_p2_reports_scope_and_calibration.py \
  tests/unit/test_p2_expression_grading.py -q                                       # 93 passed
.venv/bin/ruff check apps ai domain config tests                                    # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check          # no issues
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run  # No changes

# 浏览器（独占库 acepass_acceptance_p2_batch3、Redis 6399、媒体目录、端口 8019/5189）
bash scripts/dev/reset-p2-batch3-browser.sh
cd frontend
POSTGRES_DB=acepass_acceptance_p2_batch3 REDIS_URL=redis://127.0.0.1:6399/0 \
  DJANGO_SETTINGS_MODULE=config.settings.dev ACEPASS_INLINE_TASKS=false \
  ACEPASS_PRIVATE_MEDIA_ROOT="$PWD/../var/private-media-p2-batch3" POSTGRES_CONN_MAX_AGE=0 \
  ACEPASS_BROWSER_API_PORT=8019 ACEPASS_BROWSER_WEB_PORT=5189 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep-invert "@stub"   # 78 passed
# stub 专跑：加 ACEPASS_AI_PROVIDER=stub ACEPASS_RUNTIME_MODE=demo 与 --grep "@stub"                 # 8 passed
# 归档反例、真故障演练、干净副本门槛命令同 docs/19 §5（库/端口换成批次 6 的一套）
```

## 6. 本轮暴露并修复的问题

1. **模拟考试期间的答案泄漏（真实缺陷，已修）**：内容门禁只覆盖验证模式，导致考试进行中并行练习会话
   可以拿到完整答案与分数。修复后新增反例（先证明旧代码会失败，再证明修复生效）。
2. **报告"下限"卡片在未完成时反而不显示**：前端把下限卡片放在 `!incomplete` 分支里，导致未完成时
   只看到横幅、看不到确切的下限数值。已改为未完成时显示下限、最终结果卡片另有守卫（服务端保证
   未完成时 `final_result` 为 null）。
3. **验收脚本自身两处**：倒计时断言改用服务端存储的截止时间不变性（浏览器刷新后字符串比较不可靠）；
   "评分后报告变最终"改为按服务端载荷断言 `pending_review` 计数恰好减一、已确认分上升，
   并在仍不完整时断言横幅与下限仍在（共享夹具里还有其他待评项，不能假设一次评分就变最终）。

## 7. 未验证项（保持未验证，不因交付完成而改口）

- **真实模型能力**：真实讲解、图片识别、手写转写、逐点估分、标签建议、嵌入向量、变式生成——
  本机凭据不可用（DeepSeek key 余额 HTTP 402、无视觉/嵌入模型），全部只有 stub/脚本 provider 证据。
- **真实 ≥24 小时间隔的学习效果**：没有真实经过时间，只有可注入时钟的逻辑证据。
- **真实考试材料**：版式、周期统计、封存与效果校准都建立在明确标注的验收夹具上，不是真实试卷。
- **远程部署与 GitHub Actions 实际执行**：发布门槛只在提交内容的干净副本上本机执行。
- **真实多进程 Worker 的到期清理调度**：过期清理以管理命令 + 读路径兜底实现，未在真实 beat 计划下运行。
- **性能**：报告在校验 1000 条上限时的逐条污染查询没有做大样本压测。
