# 26. 记忆驱动 · 考频定值 · 模型为念：交互学习逻辑重新设计

> 状态：**设计与实施规格（2026-11-14）**。本文重新设计 AcePass 的日常学习交互，
> 而不是再增加一个功能页。它定义：学习单位、记忆模型、考频统计、会话状态机、模型交互协议、
> 页面交互流、数据与接口契约、不变量与验收判据。实施落点是**正在使用的 DSH 插件**
> （`dsh-plugin/`，单用户、`node:sqlite`）；`backend/`（Django）继续作为对照实现与 SQLite
> schema 的生成来源，但本设计的新行为只在插件侧实现（理由见 §11）。
>
> 本文只把「可验证的事实」写成结论：凡是未实际运行的部分（真实模型输出、真实隔夜效果、
> 真实浏览器全量套件），§12 明确列为未验证。

## 1. 为什么要重做交互逻辑

当前实现（P0—P2 与 DSH 迁移）已经把「证据」做成了产品的地基：六维证据、排除原因、延迟验证、
配对任务、封存与限时考试。它回答的是**「怎样证明我会」**。但日常使用的主线仍然是一条**任务流水线**：

```
今日计划（5 类任务按固定顺序填充预算） → 打开刷题工作台 → 作答 → 判分 → 按需讲解 → 记忆卡复习
```

三个结构性缺口：

1. **记忆不是主线，只是旁支。** 记忆卡是「题目级 FSRS」，并且被明确设计为*不影响考点状态*；
   到期卡只是 5 类任务中的一类。学习者在一天里真正做的，是「被排到哪道题就做哪道题」，
   而不是「先回忆、再纠正、再巩固」。
2. **考频不参与决策。** 近五年真题的分值份额只出现在报告里（`cycles.py` / `cycles.ts`），
   不参与今日选择。用户看不到「这个考点值不值得现在记」，也看不到「我记住的东西里有多少是
   高频考点」。反过来，计划器的 reason codes 里没有任何一个与考频有关。
3. **模型是旁白，不是学习伙伴。** 辅导只能绑定在某个练习会话的题项上（`TutorSession` 必须
   有 `practice_session_id` + `session_item_id`），并且是一次性 job。模型无法参与「回忆检查、
   追问、渐进提示、纠错、收束」这些真正需要对话的环节；它只能在你点开一道题之后出现。

本设计把三者调换成一条主线：

```
考点（记忆体） ── 考频定值 ──> 今天先回忆什么、先学什么、练什么、何时再回来
        │
        └── 模型教练：出题式追问 / 覆盖检查 / 提示阶梯 / 错因追问 / 收束反思
```

**新的产品承诺**：每天打开面板，看到的是**一条按记忆规律组织的学习流**（开始 → 回忆 → 编码 →
练习 → 纠错 → 收束），而不是一组功能入口；每一步都告诉你**为什么是它**，并且**都由可核对的
事实驱动**（考频统计、记忆状态、证据、错因）。

## 2. 第一性原理 → 产品硬约束

以下每条都来自记忆与学习科学中稳定的结论，并翻译成**代码可执行的约束**。它们是这个设计
不可协商的部分；§10 把它们写成测试。

| # | 原理 | 本设计中的硬约束 |
|---|---|---|
| P1 | 提取练习效应：回忆比重读更能形成长期记忆（Roediger & Karpicke, 2006） | 每个新知识点的学习步骤必须先有「尝试回忆」，再给完整内容；编码阶段每段讲解后必须有微回忆；**不允许纯阅读步骤作为唯一互动** |
| P2 | 间隔效应：分散复习优于集中重复（Cepeda et al., 2006） | 同一考点的两次有效回忆间隔由 FSRS 的稳定度决定；**同一会话内对同一考点的重复回忆不更新记忆调度**（只记练习事件） |
| P3 | 交错练习：混合相关题型提升辨别与迁移（Rohrer & Taylor, 2007） | 练习阶段同一考点连续出现不超过 2 步，考点/题型交替；编码早期允许阻塞练习（同一考点连续微步骤） |
| P4 | 合意困难：目标错误率带来更好学习（Bjork） | 练习选择以「目标正确率区间 0.80–0.90」为约束：连续答对则升难度/换模板，连续答错则降级并进入修复 |
| P5 | 生成与自我解释效应（Slamecka & Graf, 1978; Chi et al., 1994） | 每个编码单元结束必须有一次「用自己的话解释」；解释可自评，模型只能做覆盖检查（不评分） |
| P6 | 及时纠错与错误驱动的再编码 | 答错后必须产生：1 个最小讲解（只讲当前卡点）+ 1 个对比/边界 + 1 道不同题的再测；错因只从受控词表里选 |
| P7 | 元认知校准：学习者对「自己会不会」的判断经常失准（Dunlosky et al., 2013） | 每次回忆/练习前记录信心预测，结果出来后计算校准偏差；偏差进入会话选择（过度自信 → 增加无提示提取） |
| P8 | 认知负荷与先修：工作记忆有限，缺前置会阻断学习（Sweller） | 新知识点先检查前置掌握；单步只呈现一个核心问题；提示按 0→1→2→3 级展开，不直接给答案 |
| P9 | 巩固与睡眠：跨日间隔对长期保持关键 | 复习调度以「天」为粒度；当日重复不计入间隔记忆；首次间隔不短于 FSRS 的短步，且夜间跨日优先 |
| P10 | 迁移适宜性：练习形态应接近考试形态 | 练习使用与真题一致的题型/计分规则；成熟的考点进入「限时/无提示」步骤；能力证据维度保持不变 |
| P11 | 诚实边界：记忆强度 ≠ 解题能力；历史频率 ≠ 明年概率 | 记忆状态与能力状态**分表、分标签、分文案**；考频只报历史计数与样本量，绝不输出概率或「必考」 |

## 3. 学习单位：考点记忆体（KMU）

原子单位从「题目」换成**考点**。一个考点记忆体由六部分组成：

| 组成 | 来源 | 作用 |
|---|---|---|
| 核心内容卡 `NodeCard` | 人工确认 / 模型草稿（必须人工确认后才作为核对基准）/ 从已审核题目解析与 rubric 派生 | 定义、触发条件、公式/规则、易混对比；回忆题与覆盖检查的基准 |
| 记忆状态 `NodeMemoryState` | 只由确认后的回忆事件更新（FSRS-4.5） | 何时该再回忆 |
| 能力状态 `LearnerKnowledgeState`（既有） | 只由作答证据更新 | 是否算「会做」 |
| 考频画像 `FrequencyProfile` | 真实试卷（可计数周期）实时计算 | 值不值得记、先记哪个 |
| 前置关系（既有 `KnowledgeRelation`） | 大纲 / 人工确认 | 先修检查与排序 |
| 错因画像 | 既有诊断事件 + 会话中的受控错因 | 修复什么 |

> **关键区分**：`NodeMemoryState` 回答「这个考点的核心内容我现在还能不能提取出来」；
> `LearnerKnowledgeState` 回答「我能不能独立解题」。两者永不互相写入。
> 记忆卡（题目级 `MemoryCard`）继续保留，但降级为**小题记忆工具**，不再承担主线；
> 新主线使用考点级记忆状态。

### 3.1 核心内容卡（NodeCard）

- **版本化、追加式**：每次修改产生新 `revision`，旧版本保留；同一考点只有一个 `is_current`。
- **两种来源**：`manual`（用户手写）与 `model_candidate`（模型草稿，**必须人工确认**）。
- **状态**：`draft` / `confirmed`。只有 `confirmed` 的卡可以作为：
  1. 编码步骤的阅读材料；
  2. 回忆覆盖检查的关键点基准；
  3. 模型提示的引用来源。
- **关键点 `key_points`**：`[{id, text, required}]`。回忆覆盖检查按 `required=true` 的点计算
  覆盖率；`required=false` 的点用于加分/追问，不影响评级分档。
- **引用**：卡片必须带 `citations`（来自 `knowledge_node:{id}`、题目版本、已审核答案/解析、
  rubric），模型草稿的每个要点都要能指回来源；无来源的要点被标注为「模型补充（未核对）」，
  且该卡不能被确认为 `confirmed`（校验规则）。

### 3.2 记忆状态与记忆事件

- `NodeMemoryState(user, project, syllabus_version, node, modality='recall')`：保存 FSRS 投影
  （stability/difficulty/phase/due_at/last_recall_at/reps/lapses/learning_step/参数版本/目标保持率）。
- `RecallEvent`：追加式台账，保存 `rating`、`source`、`coverage`、`is_spaced`、
  `stability_before/after`、`difficulty_before/after`、`due_before/after`、`confidence_before`、
  `latency_ms`、`session/step`、`model_run_id`、幂等键。
- **可重放**：记忆行只是投影，`rebuild_node_memory_from_events` 按 `reviewed_at` 顺序 + 事件记录的
  参数版本重放；`matches=false` 时报告差异，不静默修复。
- **评级由确定性规则产生**（§5.2）。模型只能提供覆盖率候选，且必须由学习者确认；模型单独
  给出的评级不写台账。

## 4. 考频统计（FrequencyProfile）

### 4.1 口径（与既有周期分析完全一致，不另开一套）

只统计**真实考试发生记录**：
`source_kind=official_past` 且 `is_demo=false`，有效版本 `status=confirmed` 且
`coverage_status=coverage_complete`，且至少一个 `is_scored` 题项。演示、模拟、练习集、
未确认覆盖的周期一律不进分子分母。周期完整性规则复用 `cycles.ts`。

对每个可计数周期 `c`、每个考点 `k`：

- `appearances(k)`：该周期内主要映射（`is_primary=true` 且 `score_weight>0`）到 k 的计分题项数；
- `marks(k)`：这些题项按主权重归一后分到 k 的分值（与 `nodeShares` 完全同口径，避免重复计分）；
- `share(k) = marks(k) / 该周期分母总分`；
- `types(k)`：题型计数；
- `unclassified`：无主映射的计分题进入「未分类」，不计入任何考点，但在响应里单独报告。

### 4.2 派生指标

设实际使用的完整周期集合为 `C`（最多 5 个，近→远），`n = |C|`：

```
coverage   = |{c ∈ C : appearances(k,c) > 0}| / n            ∈ [0,1]
share_avg  = mean{ share(k,c) : c ∈ C 且该周期分母 > 0 }       ∈ [0,1]
recency    = Σ_c w_c · seen(k,c) / Σ_c w_c
             w_c = 0.5 ** (age_c / 2)      // 半衰期 2 个周期
value_index = 0.40·coverage + 0.40·min(1, share_avg/0.15) + 0.20·recency
```

- `value_index ∈ [0,1]` 是**排序分值**，不是出题概率，也不是「应该得多少分」。
- `0.15` 是分值份额的归一「满值」参考（经验参数，写入规则版本）；`share_avg=15%` 及以上
  视为满分份额。
- `trend`：按周期顺序对 `share` 做最小二乘斜率；**少于 3 个有数据的周期时返回 `null`**，
  不给趋势结论。
- `status`：
  - `no_real_data`：没有可计数周期 → 不给任何排序，只给「缺什么」；
  - `insufficient_cycles`：完整周期 < 2 → 展示原始计数与份额，但 `value_index=null`，不排名；
  - `ok`：≥2 个完整周期，给 `value_index` 与趋势（趋势仍需 ≥3 周期）。
- `question_types`：题型 → 次数；`last_seen_cycle`；`counted_cycles` / `missing_cycles`。
- **父子汇总**：章节节点的 `value_index` 用其子树内各考点的主映射分值合计后**重算**
  （不是把子节点 value 相加），杜绝重复计分；显式 `unclassified` 桶不参与汇总。

### 4.3 与调度的耦合（唯一的耦合方式）

- **目标保持率**：`desired_retention = clamp(0.85 + 0.10·value_index, 0.85, 0.95)`，
  在该考点第一次创建记忆状态时写入并固定；之后不因考频变化而静默改写（保证重放可复现）。
  `value_index=null` 时用 0.85。
- **优先级**：`value_index` 直接进入会话排序（§6.3）；`reason_codes` 会显示
  `high_exam_value`、`due_soon`、`forgetting_risk` 等可解释原因。
- 考频**从不**写入能力状态、证据或分数；也不产生「重点预测」文案。

## 5. 记忆调度与评级

### 5.1 调度器

复用 `domain/fsrs.ts`（FSRS-4.5，已与 Python 黄金向量对拍）。每个考点一条记忆状态，
`modality='recall'`（v1 只实现这一种；枚举保留 `method` 以便未来区分「方法/适用条件」）。

### 5.2 评级规则（确定性）

回忆结果由三部分组成：`coverage`（必要关键点覆盖率，0–1 或 null）、`hint_level`（本步使用的
提示级别 0–3）、`latency_ratio`（实际用时 / 预期用时）。学习者先给 `confidence_before`
（1–5）。评级：

```
若 coverage 为 null（无确认卡 / 无模型 / 未核对）：
    rating = 学习者自评（1..4 → again/hard/good/easy），source = self_report
否则：
    coverage < 0.50                       → again
    0.50 ≤ coverage < 0.80 或 hint_level ≥ 1 → hard
    0.80 ≤ coverage < 1.00                → good
    coverage = 1.00 且 latency_ratio ≤ 0.6 → easy
    其它（coverage=1 但慢）                 → good
```

- `source ∈ {self_report, deterministic, model_assisted_confirmed}`：
  只有「模型给覆盖候选 + 学习者确认」才算 `model_assisted_confirmed`；
  模型单独给的覆盖只在 UI 显示为建议。
- **间隔诚实**：若同一考点在 `SPACED_MIN_MINUTES = 10` 分钟内已有有效回忆事件，则
  `is_spaced=false`：事件照记（审计需要），但**不更新**记忆状态，返回 `memory_updated=false`。
- 复习提前：未到期的考点允许「提前回忆」，但评级最多 `hard`，并标记 `early_review=true`；
  这是产品规则，避免用高频重复伪造记忆。

### 5.3 会话中的记忆事件流

```
激活回忆步骤 → 学习者输入 → (可选) 模型覆盖检查 → 学习者确认覆盖/自评
     → 写 RecallEvent（含 before/after 投影）→ 更新 NodeMemoryState → 显示下一到期时间
```

练习步骤**不产生** `RecallEvent`，只走既有 `LearningEvidence`；反之回忆步骤**不产生**证据。

## 6. 学习会话（LearningSession）

### 6.1 会话与步骤

- `LearningInteractionSession`：`mode ∈ {daily, new_learn, repair, exam_prep, quick_recall}`，
  `status ∈ {planned, active, completed, abandoned, expired}`，绑定一个科目、
  可选绑定当天 `StudyPlan`、预算分钟数、聚合摘要。
- `LearningSessionStep`：`ordinal` 唯一，`stage ∈ {warmup, encode, practice, repair, transfer}`，
  `kind ∈ {recall, encode_read, self_explain, practice, repair_brief, repair_retest, transfer}`，
  `status ∈ {pending, active, submitted, completed, skipped, expired}`。
- **状态机**（服务端强制）：

```
planned --start--> active --(step 流转)--> ... --finish--> completed
   │                  │
   └──abandon──> abandoned     └──(超时/父工程截止)--> expired
```

- 步骤推进只允许：当前步骤或「显式跳过当前步骤」；`practice` 步骤的提交必须携带幂等键；
  限时步骤由服务端记录 `deadline_at`，过期后服务端拒绝提交并标记 `expired`。

### 6.2 会话编排（确定性，非模型）

创建会话时一次性生成步骤计划（修复步骤在答错时追加）：

1. **预算**：`budget = min(设置预算, 模式上限)`；`daily` 默认取用户每日预算的 60%（上限 45 分钟，
   下限 5 分钟）；分配：唤醒 30%、编码 30%、练习 30%、收束 10%（收束在 finish 时计算，不占步骤）。
2. **唤醒**（≤6 个考点，每个 2 分钟）：有记忆状态且 `due_at ≤ now` 的考点，按
   `value_index × forgetting_risk` 降序；`forgetting_risk = 1 - R(t,S)`。
3. **编码**（≤2 个考点）：无记忆状态或 `phase='new'`，且 `value_index` 可用的考点；优先有
   `confirmed` 卡片的；每个考点：读卡（2 分钟）→ 立即回忆（2 分钟）→ 自我解释（2 分钟，可选）。
4. **练习**（预算剩余）：候选来自唤醒/编码/薄弱/未诊断考点，按 §6.3 排序；每题预估分钟数；
   约束：同一考点连续不超过 2 步、优先不同模板、只用合格题目（已发布、已核对无争议答案、
   非 AI 推导、未封存）、最多 8 题。练习通过既有 `practice` 会话一次性创建，题项复用既有判分/证据链。
5. **修复**（追加）：练习步骤判分确认错误时，追加 `repair_brief`（1 分钟：最小讲解 + 对比/边界）
   与 `repair_retest`（2 分钟：同考点另一道题；没有可用题时记 `deficit_notice` 并跳过）。
6. **迁移**（可选）：若预算剩余且存在能力状态 ≥ `independent` 的考点，追加 1 道无提示限时题；
   没有则记「不足」说明。
7. 生成后写 `notes`：每个未安排的缺口都有原因（没有合格题、没有到期记忆、预算不足等）。

### 6.3 选择模型（可解释）

对每个候选考点：

```
score = 100 · V̂ · (1 + 0.8·risk + 0.5·gap)
      + 30 · prereq_urgency
      + 15 · novelty
      - 20 · consecutive_same_node
```

- `V̂ = value_index`（null 时用 0.5 的中性值，并加 `frequency_unknown` 原因码）；
- `risk = 1 - R(t,S)`（无记忆状态 → 0，靠 `novelty` 进入编码）；
- `gap = 1 - ability_score`（由 `LearnerKnowledgeState` 映射：undiagnosed=1、needs_foundation=0.8、
  completes_with_hints=0.5、independent=0.25、handles_unseen=0.1、delayed_verified=0）；
- `prereq_urgency`：该考点的「高频后代」有多少个未满足前置（复用 `unmetPrerequisites`）；
- `novelty`：未诊断/无记忆状态时 1，否则 0；
- `consecutive_same_node`：最近 2 步是否同一考点。
- **约束优先于分数**：到期唤醒 > 编码缺口 > 修复 > 练习 > 迁移（阶段顺序固定）；
  预算不能容纳整步时留空并解释，不为凑满而塞低价值内容。
- `reason_codes` 必须是稳定字符串（如 `due_memory`、`forgetting_risk=0.42`、
  `high_exam_value`、`prereq_unmet:节点名`、`ability_gap`、`interleave`、`novelty`），
  前端据此显示中文解释；不显示无法解释的分数。

### 6.4 收束与摘要

`finish` 返回（并写入 `summary`）：

- 各阶段步数与用时；回忆次数、评级分布、记忆稳定度变化（ΣΔS）；
- 下次到期时间（最早 3 个）；错误清单与错因；
- 校准：预测信心 vs 实际结果的偏差（过度自信/低估）与样本数；
- **模型反思**（可选）：只能引用本次会话的步骤与事件 ID，不得新增事实、不得给分；
- 明确未完成项与原因。

## 7. 模型教练（Coach）

### 7.1 用途与契约

模型只通过一个受控入口 `POST /projects/{p}/knowledge-nodes/{node_id}/coach` 参与；每次调用必须
声明 `purpose`，只接受以下用途：

| purpose | 何时使用 | 输出（校验后） | 禁止 |
|---|---|---|---|
| `recall_check` | 提交自由回忆后 | 每个关键点的覆盖状态、缺失点、无法判断项、一个追问 | 分数、评级、掌握判断 |
| `self_explain_check` | 自我解释后 | 同上（按要点覆盖） | 同上 |
| `hint` | 练习步请求提示（level 1–3） | 分级提示块 + `reveals_answer` + 引用 | level 4 完整答案（除非 purpose=explanation 且允许暴露） |
| `misconception_probe` | 答错后 | 受控错因候选 + 证据引文 + 一个追问 | 「粗心/态度」、分数 |
| `encode_briefing` | 生成考点卡草稿 | 卡片草稿（blocks + key_points + citations） | 直接写入 confirmed 卡 |
| `session_reflection` | 会话收束 | 只引用步骤/事件 ID 的反思 | 新事实、分数、计划 |

所有输出：**只输出 JSON**；引用只能使用本次允许集合（`knowledge_node:{id}`、
`node_card:{id}:{rev}`、`question_version:{id}`、`answer_key_version:{id}`、
`rubric_version:{id}`、`practice_attempt:{id}`）；结构校验不通过则整条丢弃并如实报错
（`ai_invalid_output`），绝不展示原始 token。

### 7.2 安全与降级

- **内容门禁**：活动验证/模拟考试中的内容禁止教练（复用 `verificationContentMap`）；
  封存内容禁止；`transfer`/限时步骤禁止提示。
- **答案暴露**：教练输出若包含答案/完整解法，必须写 `practice_exposure_event`
  （`answer_delivered` / `explanation_delivered`），并让后续独立证据按既有规则失效。
- **无模型**：所有功能可降级运行——回忆用自评；编码读已确认卡；提示用卡片/解析的固定摘录；
  生成考点卡草稿入口显示「AI 未配置」；会话仍可完整跑完。
- **审计**：每次调用写 `audit_llm_run`（能力、提示词版本、输入指纹、用量、耗时、校验结果、
  是否 stub=false），聊天记录写 `CoachTurn`（role/purpose/text/structured/citations）。

### 7.3 提示阶梯

| 级别 | 内容 | 记录 |
|---|---|---|
| 0 | 不给提示 | — |
| 1 | 方向/该关注哪个条件 | `hint_used=1` |
| 2 | 相关原理/方法名 | `hint_used=2` |
| 3 | 关键一步的部分展开 | `hint_used=3`，该步不再计入独立证据 |
| 4 | 完整答案/完整解法 | 仅 `explanation` 语义，写答案暴露；之后重做不算独立 |

提示使用会改变练习步骤的 `tutoring_used` 与证据排除原因（复用既有规则）。

## 8. 页面与交互流

### 8.1 学习台（`/study`，主入口）

```
┌ 今天的学习流 ───────────────────────────────────────────────┐
│ 日常会话 · 预算 22 分钟 · 预计 5 个回忆 / 2 个新考点 / 3 题  │
│  [ 开始今天的学习 ]        （已有进行中会话时改为「继续」）   │
└─────────────────────────────────────────────────────────────┘
┌ 到期记忆 ─ 6 个考点今天该回忆 ──────────────────────────────┐
│ 排列组合   R 68% · 考频 4/5 周期      [先回忆 2 分钟]        │
└─────────────────────────────────────────────────────────────┘
┌ 高价值考点 ─ 考频 × 记忆 × 能力 ───────────────────────────┐
│ ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

- 顶部会话卡：**只给一个主按钮**；展示模式、预算、预计构成、当前状态。
- 三个信息块按「时间紧迫 → 价值 → 卡点」排序；每个条目都可直接进入对应步骤或考点详情。
- 预算为 0 / 无题目 / 无大纲时显示明确缺什么（复用既有诚实空态），不生成空会话。

### 8.2 会话执行页（`/study/sessions/:id`）

布局：**左阶段导轨（步骤列表与状态）｜中交互区｜右上下文坞（考点卡 + 考频 + 记忆 + 前置 + 教练）**；
移动端上下堆叠、上下文坞折叠为底部抽屉。交互区按步骤类型：

| 步骤 | 交互 |
|---|---|
| `recall` | 大字提示「先别看答案，写下你能回忆的」→ 文本域 → 可选「让模型检查覆盖」（显示每个要点的覆盖/缺失/无法判断）→ 学习者确认或自评 → 立即显示评级、新的到期时间、历史记忆变化 |
| `encode_read` | 已确认考点卡（要点/条件/公式/易混对比 + 来源引用）→「我读完了，问我一个问题」 |
| `self_explain` | 「用你自己的话解释为什么 / 什么时候不适用」→ 提交 → 覆盖检查（模型或自评）→ 追问一个 |
| `practice` | 题干/选项/空位（轻量作答），提示阶梯按钮，信心预测，提交 → 立即判分或「待人工评分」→ 错误时出现修复入口 |
| `repair_brief` | 最小讲解 + 对比/边界 +「再试一道」 |
| `repair_retest` | 同考点另一道题，无提示 |
| `transfer` | 限时题，无提示；显示剩余时间（服务端时钟） |
| 收束 | 会话摘要：记忆变化、下次到期、错误与错因、校准偏差、模型反思（标注为建议） |

- 练习步骤沿用既有「题目呈现 / 提交 / 判分」接口与门禁（封存、验证、答案不下发）；
  构造性大题一键跳到刷题工作台，返回后会话自动同步结果（步骤状态由会话读取时重算）。
- 任何步骤可「暂时跳过」，原因写入会话备注；跳过不会伪造完成。

### 8.3 考点详情（`/study/nodes/:nodeId`）

抽屉/页面：记忆环（R、S、下次到期）、考频卡（出现周期数/总周期、平均份额、题型分布、
最近出现、趋势、样本量、口径说明）、核心内容卡（版本、来源、确认状态、编辑/确认、
模型草稿标识）、前置关系、证据（6 维）、错因、记忆历史（sparkline）、教练对话记录。
「开始 5 分钟回忆」直接创建一个 `quick_recall` 会话。

## 9. 数据与接口契约

### 9.1 新增表（6 张；Django 模型是 schema 真源，插件行为在 Node 侧）

| 表 | 关键字段 | 约束 |
|---|---|---|
| `knowledge_node_card` | node, syllabus_version, revision, is_current, status, origin, blocks JSON, key_points JSON, citations JSON, source_note, model_run, confirmed_at | unique(node, revision)；index(node, is_current) |
| `memory_node_state` | user, project, syllabus_version, node, modality, phase, stability, difficulty, due_at, last_recall_at, reps, lapses, learning_step, scheduler_version, params_version, desired_retention | unique(user, node, modality)；index(user, project, due_at) |
| `memory_recall_event` | 记忆状态, user, node, kind, rating, source, is_spaced, coverage JSON, prompt_text, answer_text, latency_ms, confidence_before, notes, session, step, question, session_item, model_run, idempotency_key, before/after 状态 | unique(memory_state, idempotency_key)；index(user, node, reviewed_at) |
| `learning_interaction_session` | user, project, subject, mode, status, stage, plan, practice_session, budget_minutes, estimated_minutes, started_at, finished_at, summary JSON, notes JSON, rule_version, revision | index(user, project, status, -started_at) |
| `learning_session_step` | session, ordinal, stage, kind, status, node, question, session_item, recall_event, estimated_minutes, hint_level, confidence_before, outcome, payload JSON, reason_codes JSON, deadline_at, started_at, finished_at | unique(session, ordinal) |
| `tutoring_coach_turn` | thread_key, user, project, node, session, step, purpose, role, ordinal, status, text, structured JSON, citations JSON, missing_information JSON, llm_run, prompt_version, error_code/message | unique(thread_key, ordinal)；index(thread_key, -ordinal) |

**不加**考频快照表：考频由真实试卷实时计算（数据量小、口径唯一、避免缓存漂移）。
如未来数据量大，再加快照并保留同一套口径测试。

### 9.2 主要接口（全部走既有 `/api/v1` + RPC 通道；写操作强制 Idempotency-Key）

```
GET    /projects/{p}/study-desk?subject_id=
POST   /projects/{p}/learning-sessions                      {subject_id, mode, budget_minutes?}
GET    /projects/{p}/learning-sessions/current?subject_id=
GET    /projects/{p}/learning-sessions/{sid}
POST   /projects/{p}/learning-sessions/{sid}/start
GET    /projects/{p}/learning-sessions/{sid}/steps/{ordinal}
POST   /projects/{p}/learning-sessions/{sid}/steps/{ordinal}/activate
POST   /projects/{p}/learning-sessions/{sid}/steps/{ordinal}/recall     {text, confidence_before, latency_ms?}
POST   /projects/{p}/learning-sessions/{sid}/steps/{ordinal}/recall/confirm {rating?, confirm_coverage?}
POST   /projects/{p}/learning-sessions/{sid}/steps/{ordinal}/answer     {answer, confidence?}
POST   /projects/{p}/learning-sessions/{sid}/steps/{ordinal}/hint       {level}
POST   /projects/{p}/learning-sessions/{sid}/steps/{ordinal}/skip       {reason}
POST   /projects/{p}/learning-sessions/{sid}/finish
GET    /projects/{p}/knowledge-nodes/{node_id}/memory
GET    /projects/{p}/knowledge-nodes/{node_id}/frequency?horizon=5
GET    /projects/{p}/knowledge-nodes/{node_id}/card
POST   /projects/{p}/knowledge-nodes/{node_id}/card                     手动草稿
POST   /projects/{p}/knowledge-nodes/{node_id}/card/generate            AI 草稿（无模型 503 降级）
POST   /projects/{p}/knowledge-nodes/{node_id}/card/confirm
POST   /projects/{p}/knowledge-nodes/{node_id}/recall                   会话外回忆
GET    /projects/{p}/knowledge-nodes/{node_id}/coach?purpose=
POST   /projects/{p}/knowledge-nodes/{node_id}/coach                    {purpose, message?, step_id?}
GET    /projects/{p}/subjects/{subject_id}/frequency
```

所有读接口返回「可解释事实」：样本量、口径版本、排除项、原因码；错误信封沿用
`{error:{code,message,details,request_id}}` 与既有状态码。

### 9.3 与既有模块的边界

- **复用**：题目呈现/提交/判分/证据/延迟任务/封存/验证门禁/FSRS/审计/发件箱。
- **不修改**：既有 `study-plans`、`practice-sessions`、`memory-cards` 接口语义；新会话可选引用
  `StudyPlan`，但不改写它。
- **不写入**：模型输出不得写 `practice_grade_event`、`learning_knowledge_state`、
  `learning_evidence`、`study_plan`；只有确定性服务在确认后写记忆台账。

## 10. 不变量与验收

### 10.1 不变量（新增/强化）

| 编号 | 不变量 | 测试方式 |
|---|---|---|
| M1 | 模型输出永不直接写记忆状态、证据、分数、计划 | 计行数前后不变的集成测试 + 代码守卫（服务不接受 model 输出直接写） |
| M2 | 记忆台账可重放：事件重放得到同一投影 | replay 测试（含参数版本） |
| M3 | 同一会话内重复回忆不更新记忆调度 | `is_spaced=false` 断言 + 投影不变 |
| M4 | 考频口径与周期分析一致；演示/不完整周期不进分子分母 | 与 `cycles.ts` 共用夹具的对照测试 |
| M5 | 样本不足不给排名/概率/趋势结论 | `insufficient_cycles` / `no_real_data` 断言 |
| M6 | 无 AI 时会话仍可完整跑完 | 无 provider 的完整会话流程测试 |
| M7 | 验证/考试中的内容禁止教练与提示 | 门禁测试（复用既有 gate 夹具） |
| M8 | 所有写操作幂等；重放不重复写事件 | 幂等键测试 |
| M9 | 步骤状态机不可跳过约束：只能推进当前步或显式跳过 | 非法推进 409/422 |
| M10 | 记忆与能力互不写入 | 计数断言（recall 不写 evidence；练习不写 recall） |

### 10.2 验收判据（本轮）

- 后端：新增单测/HTTP 测试全绿；**既有测试一条不改**（除 schema 表的计数与新表注册）。
- 静态：`npm run typecheck`、`npm run build` 通过；Django `manage.py check`、
  `makemigrations --check` 干净；`schema.generated.ts` 由生成器重跑逐字节一致。
- 交互：新页面可编译、可在隔离 DSH Web 中打开（若时间允许跑一条冒烟；否则如实记录未跑）。
- 诚实：无模型的降级路径可跑通；所有失败都明确可见。

### 10.3 本轮明确不做

- 真实模型质量（本机 provider 未配置）；真实 ≥24 小时记忆效果；真实考试材料。
- 跨科目交错（v1 会话为单科目；文档标注为下一步）。
- 知识地图热力叠加、完整记忆报告仪表盘（v1 只做学习台/会话/考点详情，报告保留既有）。
- Django 侧新行为的业务实现（只加 schema 模型；行为在插件）。
- 全量 Playwright 套件重跑（耗时且与本次改动弱相关，如实标注）。

## 11. 为什么实施在 DSH 插件而不是 Django

`docs/dsh-migration/` 的结论是：DSH 插件是已接受的部署形态（desktop profile 已加载、
`~/.acepass` 是真实数据目录），Django 保留作对照。新交互只在插件侧实现，避免双写；
但 SQLite schema 仍由 Django 模型生成（`scripts/gen_schema.py` 是唯一真源），
因此本设计的 6 张表会在 Django 模型里声明并生成迁移，插件实现行为。这样：

- 生成器/schema 漂移守卫继续有效（既有 `schema.test.ts`）；
- Django 仍然可以「读得懂」新数据结构，便于对照与未来迁移；
- 不承诺 Django API 提供新页面所需的业务接口（明确不在本轮范围）。

## 12. 实施批次与未验证边界

| 批次 | 内容 | 验证 |
|---|---|---|
| B1 schema + 领域纯函数 | 6 张表、迁移、schema 生成、评级/考频/排序纯函数 | 单测 + 生成器对拍 |
| B2 服务层 | 考频、考点记忆、考点卡、会话编排、教练（含提示词/校验/审计） | 服务测试（内存库 + 注入时钟） |
| B3 HTTP | 20 条路由、幂等、门禁、错误信封 | HTTP 黑盒测试 |
| B4 客户端 | 学习台、会话执行页、考点详情、导航、API 模块 | tsc + build + 单条冒烟 |
| B5 文档与门禁 | 交付文档、README/状态更新、全量测试 | `npm test`、既有门禁 |

**未验证（不写成已完成）**：真实模型输出质量与费用；真实跨日记忆效果；真实考试材料；
DSH Desktop 重启后的肉眼交互（需用户重启）；Playwright 新流程的完整浏览器验收。

## 13. 参考文献（用于原理，不用于效果承诺）

- Roediger & Karpicke (2006). Test-enhanced learning.
- Cepeda et al. (2006). Distributed practice in verbal recall tasks.
- Rohrer & Taylor (2007). The shuffling of mathematics problems improves learning.
- Bjork & Bjork (2011). Making things hard on yourself, but in a good way.
- Chi et al. (1994). Eliciting self-explanations improves understanding.
- Dunlosky et al. (2013). Improving students' learning with effective learning techniques.
- Sweller (1988). Cognitive load during problem solving.
- Karpicke & Blunt (2011). Retrieval practice produces more learning than elaborative studying.
