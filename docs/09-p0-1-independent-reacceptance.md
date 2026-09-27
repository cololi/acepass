# P0.1 独立复验：主要修复有效，仍有阻断

日期：2026-09-27。审查 HEAD：`f809365`；本轮修复主要提交：`a794b1a`、`4eb1de0`、`c76e65b`。

**结论：P0.1 有实质进展，但目前仍不能确认 P0 完整通过。下一步只处理下列剩余问题，完成 P0.2 收尾后再进入 P1。** 不是重新推倒已完成的修复，也无需先等待模型凭据。

## 1. 本次独立执行结果

| 项目 | 本次结果 | 边界 |
|---|---|---|
| 后端现有全套 | **164 passed，36.33s** | 专用 PostgreSQL 测试库；含本轮新增回归 |
| 新浏览器验收套件 | **30 passed，36.9s** | 15 场景 × 桌面/手机；真实 API、Redis 和 Worker |
| Ruff、迁移一致性、TypeScript/Vite build | 通过 | 构建有 >500 kB chunk 提示，不作为业务阻断 |
| 新增独立后端反例 | **11 failed，7.73s** | 6 条数据一致性、3 条 outbox、2 条辅导/导入 |
| 新增独立浏览器反例 | **2 failed** | 照片草稿恢复、填空可视答案保存；各单独运行 |
| 真实 Worker 正常消费 | **50/50 processed，未处理主题为空** | 快照有 144 条证据、3 个知识状态、7 条复习任务；说明普通链路已接通 |
| CI 配置加载 | 失败 | 按 workflow 的 POSTGRES_DB=acepass，Playwright 在加载阶段拒绝 |
| Compose 全栈、真实模型、真实隔天 | 本次未独立复跑 | Compose 保留交付者记录；不能称本次独立通过 |

浏览器使用本次新建库 `acepass_acceptance_p01_independent`、Redis 6394、API 8014、Vite 5184 和独立媒体目录；pytest 另用专用测试库。现有业务库、8000/5173 服务未修改。测试结束已清理本次临时服务和浏览器数据库。

本轮只增加复验资产与文档，不修改应用代码，不提交或部署。完整证据见 [p01-independent](review/2026-09-27/p01-independent/README.md)。

## 2. 已确认有效的修复

- learning 路由与页面网络错误处理已补；不再出现上一轮三条端点固定 404。
- “全部评完”和“满分正确”已分开；0 分、8/10 部分分不再仅因失分而待评。
- 固定答案变争议后的普通提交有保护；旧重判晚完成的顺序用例已补。
- 会话自身隐藏验证分数、同题平行 practice 的显式 reveal 拒绝已生效。
- B→C 创建锚点、任务用途固定 verification 已修；但运行时重新计算与证据投影还有下列缺口。
- 图片 multipart、视觉提取任务接线、提交后辅导入口、提交后刷新 reveal、已提交照片展示均有实际修复。
- Worker 主题注册与正常消费已接通；Redis 持久化、内部健康探针、媒体空目录保护、镜像忽略规则等已补。

以上成果应保留。以下问题不能用现有套件全绿来排除。

## 3. 剩余阻断与复现

### B01：重判 HTTP 返回 500，代次分配也不满足并发唯一性

[attempts.py](../backend/apps/practice/services/attempts.py) 771、799–809 行新增行锁却没有事务。使用 `django_db(transaction=True)`，真实 autocommit 语义下 POST `/projects/{id}/regrades` 返回 **500 / TransactionManagementError**；此前已创建一条 run。普通 pytest 的外层事务掩盖了这个问题。

另用两个真实数据库事务同步请求：已有 generation=1，两次新请求均得到 **2**。只包 atomic 不能修复：锁的是“查询时上一条 run”，不是稳定的题目行。应先锁 Question 再分配序号，并用数据库唯一约束兜底。

证据：`test_regrade_http_works_without_test_wrapping_transaction`、`test_concurrent_regrade_requests_receive_distinct_generations`。

### B02：验证隔离仍可从普通判分和辅导旁路绕过

同题 verification 已呈现且保持活动时：

- 另开 practice，判断题提交 true，仍返回 **200、confirmed_score=2.00、is_correct=true**，可反推答案。
- 另开 practice 请求 tutor，返回 **201、succeeded、reveals_answer=true**。该项使用明确标记的 stub，证明服务端用途门禁未覆盖；不代表真实模型质量已验证。

位置：[practice/api.py](../backend/apps/practice/api.py) 297–304、329–341；[tutoring/services/core.py](../backend/apps/tutoring/services/core.py) 70–82、265；旧任务结果读取 [tutoring/api.py](../backend/apps/tutoring/api.py) 152–158 也没有内容门禁（读取旁路为静态确认）。

统一门禁必须覆盖所有答案信息的交付，包括普通作答评分、缓存任务和报告；同时保留无关内容可正常练习。不能只补 reveal。

### B03：重判执行时没有重新核验答案可信状态

申请对已检查 v2 重判 → v2 被置为 disputed → 执行排队任务，仍生成 **confirmed 2/2**，有效评分关联的答案 `is_disputed=true`。

位置：[attempts.py](../backend/apps/practice/services/attempts.py) 634–659。需要在执行事务内重新读取、锁定答案/rubric，明确争议期间的拒绝或待复核结果；申请时校验不足。

### B04：延迟启动和延迟证据仍使用不同或过期的锚点

两条独立复现：

1. B 在 26 小时前完成，C 存量 deadline 已到；1 分钟前又完成同考点训练，直接按 C 创建会话仍 **201**。启动校验仅比较存量 not_before，没有重算最新训练事件。
2. B 在 25 小时前打开、1 小时前提交，C 当前答对，仍算 **delayed_verification.qualifies=true**。证据优先取 B 的呈现时间，忽略更晚的提交；实际距训练完成约 59 分钟。

位置：[pairing.py](../backend/apps/learning/services/pairing.py) 337–362；[evidence.py](../backend/apps/learning/services/evidence.py) 128–157。统一任务创建、启动、证据计算的锚点规则；后台定时修正不能代替启动时检查。本次注入时间戳证明规则缺陷，不声称真实等待了 24 小时。

### B05：租约没有接入真实消费者，终态仍会退回

`claim_event` 只在内联执行调用；真实 Celery task 没有先 claim，完成/失败不携带 token。

新增三个反例均失败：另一活跃租约存在时 task.run 仍执行业务；旧消费者 failure 将 processed 改回 pending；max_attempts=1 的未确认消息仍被第二次投递，attempts=2。

位置：[outbox.py](../backend/apps/audit/services/outbox.py) 123、180–196、212、246–248；[audit/tasks.py](../backend/apps/audit/tasks.py) 29–48；[tutoring/tasks.py](../backend/apps/tutoring/tasks.py) 8–25。

真实消费者统一 claim、按 token 完成/失败，终态不可被旧消费者改写，重投也必须执行上限。反例直接调用生产 task.run 并保留真实数据库，尚未通过杀进程测试竞争；正常真实 Worker 50/50 成功不证明这些异常路径正确。

### B06：图片校对和作答草稿仍会丢失用户输入

| 场景 | 实际结果 | 位置 |
|---|---|---|
| 大题上传照片、等待草稿已保存、刷新 | 文本还在，照片预览 **1→0**，关联未进入草稿 | [PracticePage.tsx](../frontend/src/features/practice/PracticePage.tsx) 130、151–162、299–300 |
| 图片候选改填空，在可视表单输入答案 5 后保存 | PATCH 200；content.blanks 为 `["5"]`，正式 answer_payload 仍 **[]** | [CandidateReviewPage.tsx](../frontend/src/features/imports/CandidateReviewPage.tsx) 112–134、220–247、431–439 |
| 人工校对完成后迟到视觉结果回写 | HUMAN_REVIEW_MARKER 被 STALE_MODEL_OUTPUT 覆盖 | [extraction.py](../backend/apps/ingestion/services/extraction.py) 231–254 |

前两条是真实浏览器复现，第三条是独立 PostgreSQL 服务层回归。附件纳入版本化草稿；可视编辑器与 JSON 使用同一答案来源；提取任务固定输入 revision，过期模型结果留作候选而不能覆盖人工版本。

### B07：CI 浏览器配置与隔离规则不匹配

workflow 仍指定 POSTGRES_DB=acepass、未设置专用端口；新版 Playwright 强制专用库名和端口，因此 **加载配置即失败**。CI 也没配置浏览器所需 Redis/Worker，只执行原浏览器套件。

位置：[ci.yml](../.github/workflows/ci.yml) 129 起；[playwright.config.ts](../frontend/playwright.config.ts) 21–36。要修改 CI 环境使其满足隔离要求，并运行 acceptance 与非内联 Worker，不能放松安全校验。

## 4. 发布与历史数据的额外门槛

这些问题不混入上述 11 条测试计数：

- **恢复 dry-run 误报成功（已实测）**：数据库端口不可连时，restore.sh 110–113 行仍 exit 0 并声称目标库不存在。先确认查询执行成功，再判断存在性。
- **默认 HTTP 跳转端口（静态确认）**：Compose 默认宿主 8080/8443，但 nginx 41 行跳到 `https://$host` 的 443。按实际公开 origin 生成跳转，验收完整登录入口。
- **历史评分迁移（静态确认）**：audit_projection_semantics.py 109–113、156–167 行修改包含 superseded 在内的 GradeEvent 派生字段，未保存旧值审计。不能宣称历史未修改；应追加审计或通过有前后值的迁移批次处理。本次未执行 --apply；典型争议 invalidation 有跳过保护，不将其误报为必然恢复已争议评分。

## 5. 交付证据需要修正的范围

- `verify_worker_e2e.py` 中丢队列/杀 Worker 场景是手工修改 DB 状态模拟，未实际 flush Redis 或终止进程。可以证明补发逻辑，不能称为真实故障注入。
- 30 浏览器测试中，辅导仅收 HTTP 201 而不检查 job 最终成功；“跨项目”实际 A→A；科目过滤只检查 URL 参数；报告主要检查标题；原套件没有图片候选校对发布。补足对应断言，不将所有通过用例都否定。
- bootstrap_acceptance 通过服务层预建项目、规范、题库与验证任务；它不是从空账户经 UI 完成全部配置与导入。需补这条用户路径。
- 真实 provider、真实隔天、真实考试资料质量仍未验证，保留现有明确标识。Compose 全栈本次没有独立启动，引用交付者记录时应注明来源。

下一步：[P0.2 收尾计划](10-p0-2-closeout-plan.md)。
