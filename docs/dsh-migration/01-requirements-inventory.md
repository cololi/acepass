# AcePass → DSH 迁移需求总清单

本文是迁移团队的需求基线：合并原始设想、正式契约、P0 修复和 P1/P2 交付，按能力去重，并保留实现边界与证据出处。
目标形态为用户指定的 DeepSeek Harness（DSH）Node/TypeScript 原生 Cordis 插件；这个目标来自本次迁移任务，不是旧架构文档已经交付的能力。
本文只盘点现有需求和实现，不指定新插件接口、数据库方案或迁移实施步骤。

## 0. 阅读规则、证据等级与来源

盘点日期：2026-11-04；只读检查时仓库 HEAD：`7b41d19`。
最后一轮已记录交付日期为 2026-09-28，见 [S24]；本文没有重新启动服务、运行测试、调用真实 provider 或修改业务数据。
“已实现”以交付记录及对应代码/测试路径为依据；历史测试通过数不是本次重新执行的结果，也不是 DSH 迁移后的验收结果。
静态代码与交付摘要不符时，保留原需求并把对应完整语义标为 `not verified`；这表示有待修正/补证的差异，不声称本轮运行了失败反例。

### 0.1 状态与敏感度

| 字段 | 精确定义 |
|---|---|
| `implemented` | 已有实现及仓库内交付/测试证据；仅覆盖该行描述的边界。 |
| `implemented-but-real-provider-unverified` | 能力接口、校验、失败处理或注入 provider 流程已实现，真实模型往返或真实输出质量未验证。 |
| `not verified` | 未取得该项证据；若文档明确未实现，会同时写明“未实现”，不把两者混为一谈。 |
| `High` | 业务不变量：相同输入事实、版本、权限、时刻下，业务结果、分值、资格、隔离及副作用必须逐项精确一致（bit-for-bit 意义上的业务等价）。 |
| `Med` | 能力与用户可见语义必须保留；框架、组件、存储或算法实现方式可以更换，但差异须明确验证。 |
| `Low` | 展示、运维包装或性能实现细节可以调整；仍须满足原有行为、诚实披露和可操作性。 |
| 原编号 `—` | 未找到独立 A/B/C 验收编号；不擅自编造映射。 |

High 不要求 Node 插件继续依赖 Django/Celery，也不要求沿用 Python 数据结构；要求保留精确十进制、时间边界、冻结版本、审计事实及可观察结果。
High 要求保留业务契约，不要求复制本清单明确指出的实现缺口；这些差异必须显式处理，不能作为“兼容”悄悄延续。
已知会话同时间戳排序差异单独列于 §6，不能用“逐字节一致”掩盖已知例外。
一项业务的实现与真实验证分开登记，例如延迟资格算法已实现，真实 ≥24h 学习效果仍未验证。

### 0.2 来源索引

下文 `[Sxx] §n` 指向本表的文件与原章节；所有路径相对仓库根。
原 A/B/C 编号默认专指 `docs/05-acceptance.md`，历史修复编号必须带文档前缀。

| 简称 | 文件 | 用途 |
|---|---|---|
| [S00] | `docs/00-original-requirements.md` | 原始愿景、质量边界；单考试/先客观题等旧范围已被覆盖。 |
| [S01] | `docs/01-product-spec.md` | 多项目、全题型、学习闭环、产品表达与非目标。 |
| [S02] | `docs/02-architecture.md` | 模块、鉴权、私有文件、异步、AI、部署架构契约。 |
| [S03] | `docs/03-domain-and-api.md` | 实体、版本、评分、暴露、调度、统计与 API 精确契约。 |
| [S05] | `docs/05-acceptance.md` | A01–A42、B01–B08、C01–C08 的正式含义。 |
| [SH] | `DEEPSEEK_HANDOFF.md` | 用户覆盖范围、10 条硬性不变量和交付证据规则。 |
| [HP0] | `DEEPSEEK_P0_FIX_HANDOFF.md` | 原 P0 业务闭环修复要求。 |
| [HP02] | `DEEPSEEK_P0_2_FIX_HANDOFF.md` | 并发重判、租约、延迟锚点、附件草稿与隔离验收修复要求。 |
| [HR] | `DEEPSEEK_P0_2_REMAINING.md` | 重放门禁、重判所有分支、最终提交所有权等修复要求。 |
| [HF] | `DEEPSEEK_P0_2_FINAL_GAPS.md` | finish 重放、题干分支代次、HTTP/Worker 所有权、干净副本隔离。 |
| [S16] | `docs/16-p1-first-batch-delivery.md` | 原生 PDF、大纲人工映射、真实发生周期统计、402 实测。 |
| [S17] | `docs/17-remaining-plan-to-completion.md` | 六批范围、完成定义和外部阻塞；保留历史起点。 |
| [S18] | `docs/18-p1-second-batch-delivery.md` | 前置关系、标签、混合检索、FSRS。 |
| [S19] | `docs/19-p1-third-batch-delivery.md` | 转写、估分、诊断、SSE。 |
| [S20] | `docs/20-p2-first-batch-delivery.md` | PDF 版式与污染。 |
| [S21] | `docs/21-p2-second-batch-delivery.md` | 封存、家族合并、变式校验。 |
| [S22] | `docs/22-p2-third-batch-delivery.md` | 模拟考试、报告范围、数学判分、效果校准。 |
| [S24] | `docs/24-code-optimization-delivery.md` | 最新性能基线、门禁结果及未覆盖窗口。 |
| [SI] | `docs/implementation-status.md` | 实现状态；顶部新记录与正文历史段落须分开读。 |
| [SA] | `docs/acceptance-results.md` | A 项逐条结果、后续批次证据及外部未验证。 |
| [SR] | `README.md` | 产品入口、环境实测、启动/备份/部署与历史交付摘要。 |

## 1. 产品目标、边界与硬性不变量

### 1.1 产品目标

AcePass 是以考试得分为目标的个性化刷题、补弱和学习验证系统，持续回答“接下来学什么最值得、当前卡在哪里、什么作答证据证明已经会做”。[S00] 开篇、[S01] §1。
核心闭环是导入与人审发布 → 保存原始作答 → 确定性/人工评分 → 按需辅导 → 审核过的 B 题即时验证 → C 题延迟验证 → 更新任务、证据与报告。[S01] §6。
学习证据优先于笔记或聊天数量；“看懂解析”、重复答对、记忆卡熟练与独立解题能力必须分别表达。[S01] §7、[S03] §5。
迁移覆盖当前已交付的 P0/P1/P2 能力；旧 handoff 的“先交付 P0、不自动进入 P1/P2”是当时执行范围，不能用于删除已交付能力。[SH]、[S17] 顶部更新、[S22]。

### 1.2 非目标与尚无依据的承诺

- 不做自由行动多 Agent、微服务拆分、模型微调、社交班级、支付商城、学习积分游戏、通过概率预测。[S01] §2。
- 不能退回单考试或只有客观题：五类可计分叶子题是单选、多选、判断、填空、大题；共享材料父题另行建模且不计分。[SH]、[S01] §5。
- 不硬编码某考试、年度、科目或官方计分规则；演示题/演示规则明确标识，实际考试规则由配置与人审确定。[S01] §3/§8。
- P0 项目仅 owner；组织共享、社交协作、公开题库不是已交付范围；规格中的内部授权 staff 复核也未证明存在完整的跨 owner 授权入口，见 R-AUTH-04/05。[S02] §4、[SI] §2。
- 不把个人系统称为防作弊平台；有数据库管理权限的人能够查看答案不在其防护承诺内。[S02] §4。
- 无真实材料、密钥、时间或部署目标时只阻塞对应真实验证；不能伪造 OCR、模型成功、官方细则或提分效果。[SH]。
- 复杂扫描 OCR、内容导出、图像旋转/裁剪交互以及复杂专业题型插件，不能因规格中出现就认定已经实现；详见 §5/§6。

### 1.3 十条硬性开发不变量

以下正文按 [SH]“开发必须遵守”原文保留，编号改为本清单 ID；迁移时均为 High。

1. **R-INV-01**：题目内容、真实考试出题记录、学习题项和用户作答分开。已发布版本不可原地改；不能丢失历史作答和当时评分依据。
2. **R-INV-02**：客观题按考试配置确定性评分；填空无法判断进入待复核；大题 P0 人工确认。AI 估计不得当正式分数，待评不得当错题或 0 分。
3. **R-INV-03**：LLM 只能生成经过校验的候选结构、讲解和诊断，不直接写正式评分、掌握状态、任务计划或统计数字。
4. **R-INV-04**：提示、答案、解析、编辑校对和题干展示都留下服务端暴露记录。重复刷题、看答案后答对、自评和严格独立能力证据分开。
5. **R-INV-05**：练习/验证模式由服务端限制。任何题干响应不得预带答案；来源图片、缓存、编辑和辅导入口同样受约束。
6. **R-INV-06**：每个查询、文件、任务、缓存与检索均检查 owner/project/subject。多个项目不能共享未授权内容、评分规则或学习状态。
7. **R-INV-07**：同卷重复导入不重复统计；跨年真实出题保留次数；父子题及多考点分值不重复累计。
8. **R-INV-08**：所有有业务副作用的请求和异步任务实现幂等。旧任务不得覆盖新版本，重判不会重复累加掌握次数。
9. **R-INV-09**：无 API Key 时继续完成不依赖模型的功能；明确 AI 未配置。测试 stub 仅在显式测试/演示模式启用，不能伪装真实模型成功。
10. **R-INV-10**：不为了通过测试弱化权限、发布审核、答案隔离或证据规则；不编造官方真题、评分细则、通过概率和学习效果。

| 不变量 | 来源位置 | 原验收关联 | 状态 | 敏感度 | 细化需求组 |
|---|---|---|---|---|---|
| R-INV-01 | [SH] 第 1 条 | A05/A22/A23 | not verified | High | QB、ANS、AUD；主要冻结链已实现，但已发布大纲节点存在原地编辑差异，见 R-QB-10 |
| R-INV-02 | [SH] 第 2 条 | A10–A17/A33/B07/C06 | implemented | High | GRADE、AI、REPORT |
| R-INV-03 | [SH] 第 3 条 | A28/A32/A34/B04/B07/C02 | implemented | High | AI、KNOW、VAR |
| R-INV-04 | [SH] 第 4 条 | A19/A20/A25/A41/C04 | implemented | High | EXP、EVID |
| R-INV-05 | [SH] 第 5 条 | A26/A38/B08/C03/C05 | implemented | High | ANS、SEAL、EXAM、SEC |
| R-INV-06 | [SH] 第 6 条 | A03/A04/A34/B05 | implemented | High | PROJ、AUTH、SEC |
| R-INV-07 | [SH] 第 7 条 | A08/A13/A14/B01/B02 | implemented | High | IMPORT、QB、REPORT |
| R-INV-08 | [SH] 第 8 条 | A21/A22/A24/A37/A40/B06 | implemented | High | ANS、ASYNC、MEM、CONS |
| R-INV-09 | [SH] 第 9 条 | A28/A36 | implemented | High | AI、DEGRADE；真实 provider 仍未验证 |
| R-INV-10 | [SH] 第 10 条 | A33/A36/C06/C08 | implemented | High | REPORT、CAL、OPS；指已交付守卫与证据纪律，不代表效果已验证 |

## 2. 功能需求清单

各表的“状态”只针对该行语义。原验收号可以多对多复用；业务规则只在主归属组展开，其他组引用以避免重复。
凡“未知”“待复核”“未配置”“未完成”“失效”状态均为产品正常状态，迁移不能改为成功或零分。

### 2.1 多项目、多科目与设置（PROJ）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-PROJ-01 | 一个用户可创建、编辑、切换、归档多个考试项目，每项目有多个科目及独立大纲/计分规则。 | [S01] §3；[SI] §2 | A01/A03 | implemented | High |
| R-PROJ-02 | 保存项目目标日期/目标分、科目满分/及格线及版本化考试规范和大纲，已使用规则通过新版本调整。 | [S01] §3；[S03] §2.1 | A05/A23 | implemented | High |
| R-PROJ-03 | 用户设置保存有效时区、每日总学习预算和项目分配比例，默认总预算为 60 分钟。 | [S01] §3；[SI] §2 | A29/A42 | implemented | High |
| R-PROJ-04 | 项目切换同步更新科目、题库、任务、报告、辅导和查询上下文，界面始终明确当前项目/科目。 | [S01] §3/§4；[SA] §2 | A03/A27 | implemented | High |
| R-PROJ-05 | 归档保留历史并停止新任务，有进行中会话时先完成或明确结束，不能直接丢弃作答。 | [S01] §3；[S03] §8.1 | A03 | implemented | High |
| R-PROJ-06 | 复制/同源内容跨本人项目保留谱系和既往暴露，但项目分数、规则与学习状态分别保存。 | [S03] §2.2/§5；[S20] §2 | A41/C04 | implemented | High |

迁移关注：项目/科目不是纯 UI 筛选项；DSH 的会话或工作区身份不能自动替代持久化 owner/project/subject 边界。
考试与科目尚未指定不构成空功能的理由；已有演示夹具可运行，但其内容不具有官方效力。

### 2.2 导入、校对与 PDF 版式（IMPORT）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-IMPORT-01 | 文字粘贴保留原文、字符偏移和来源，解析负号、单位、选项、题号及五类题型与材料子题结构。 | [S03] §2.2；[SI] §3；[S16] §1 | A06/B03 | implemented | High |
| R-IMPORT-02 | 图片保存在私有存储，原图可查看和人工结构化；视觉提取只生成待校对候选。 | [SI] §3/§6；[S16] §4 | A07/A18/A36 | implemented-but-real-provider-unverified | High |
| R-IMPORT-03 | 缺项、模糊、缺图、答案冲突、重复或规则不完整进入问题队列，不能猜答案或自动发布。 | [S03] §3；[SA] A07/A09 | A07/A09 | implemented | High |
| R-IMPORT-04 | 候选编辑采用 revision 冲突保护，视觉任务绑定输入修订，迟到结果不得覆盖人工校对。 | [HP02] G05；[SI] 顶部 P0.2 收尾 | A24/A27 | implemented | High |
| R-IMPORT-05 | 同 checksum 复用来源、任务重试复用候选，同卷同题号重复发布阻断，并允许人工辨认重复。 | [S16] §1；[SA] A08/A24 | A08/A24/B03 | implemented | High |
| R-IMPORT-06 | 原生文字 PDF 优先直接提取，校验文件头、加密/损坏、大小、页数及文本量限制，不做无必要 OCR。 | [S16] §1 | B03 | implemented | Med |
| R-IMPORT-07 | 批量 PDF 可关联独立答案页，题号优先、顺序兜底且答案只消费一次，匹配结果必须人工确认。 | [S16] §1 | B03 | implemented | High |
| R-IMPORT-08 | 候选保留原文片段、文档名、题号、起始页及跨页来源区域，发布可关联真实试卷草稿版本与题项。 | [S16] §1；[S20] §1 | A06/A14/B03/C01 | implemented | High |
| R-IMPORT-09 | PDF 逐页识别文字层、分栏、表格、公式及阅读顺序可靠性，仅几何可判定时按栏重排。 | [S20] §1 | C01 | implemented | Med |
| R-IMPORT-10 | 跨页题合并并记录涉及页，表格/公式原始符号保留；可疑候选带版面阻断问题，人工确认只解除版面问题。 | [S20] §1 | C01 | implemented | High |
| R-IMPORT-11 | 扫描页无文字层时明确转人工录入；混合 PDF 其他可解析页可继续，不能伪装 OCR 成功。 | [S20] §1/§5 | C01 | implemented | High |
| R-IMPORT-12 | 复杂扫描 PDF 自动 OCR、真实旋转页/非常规字体/嵌套 Form XObject 的识别质量须另有验证。 | [S01] §2；[S20] §5 | C01 | not verified | Med |
| R-IMPORT-13 | 原图旋转/裁剪交互是保留的增强需求，不能把来源 bbox 或后端安全区域等同为已交付图像编辑器。 | [S01] §4；[SI] §3 | — | not verified | Low |

R-IMPORT-12 中扫描 PDF 自动 OCR 在 [S20] 明确为“能力不存在”，不是仅缺真实样本；已实现的是识别风险并转人工。
`geometry_unavailable` 当前退回整页框并标记诊断，交付文档明确其本身不阻断；不得笼统声称所有几何异常均被自动阻断。[S20] §1。

### 2.3 题库、来源、版本和真实发生记录（QB）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-QB-01 | 题目身份、题目版本、真实试卷发生记录、学习题项与用户作答分离，不能靠去重合并真实跨年出题。 | [S03] §1/§2；[SI] §2 | A05/A14 | implemented | High |
| R-QB-02 | 已发布题目正文、答案、rubric 和已使用规范通过草稿/后继版本修订并保留原因和引用；大纲节点例外单列 R-QB-10。 | [S03] §1/§3；[SA] A05 | A05/A23 | implemented | High |
| R-QB-03 | 区分题源 official_past/licensed_bank/user_authored/ai_generated/demo，答案来源与 pending/checked/disputed 审核状态独立。 | [S03] §2.2；[SI] §2 | A09/A33 | implemented | High |
| R-QB-04 | 发布在事务内锁定候选并校验结构、作用域、可信答案/rubric、分值和映射，生成版本、审计和 outbox。 | [S03] §3；[SI] §3 | A07/A09/A24 | implemented | High |
| R-QB-05 | 材料父题无答案、分值与 attempt，子题版本有序且同项目/科目无循环，仅叶子创建可提交题项。 | [S03] §2.2；[S16] §1 | A13/A40/B03 | implemented | High |
| R-QB-06 | 独立练习分值固定来自 practice_max_score 或显式保存的规范默认值，试卷题用 paper_item 分值，rubric/空位合计不符时拒绝。 | [S03] §2.2；[SA] A40 | A13/A17/A40 | implemented | High |
| R-QB-07 | 试卷自然键为 subject/cycle_key/session_key/paper_code，同修订 position_key 唯一，每卷只有一个有效统计版本。 | [S03] §2.1；[SI] §2 | A08/A14 | implemented | High |
| R-QB-08 | 题库列表不预取正文/答案，预览题干记录暴露；撤回/争议即时影响新会话、旧结果读取与后续证据。 | [S03] §3/§8；[SA] A23/A26 | A23/A26/A38 | implemented | High |
| R-QB-09 | 批量审核与重判影响预览属于 P1 规格范围，现有逐候选校对和直接创建重判任务不足以证明这两项完整交付。 | [S01] §2；`backend/apps/analytics/api.py` | — | not verified | Med |
| R-QB-10 | 已发布大纲内容也应版本化且旧引用可复原，但当前考点节点改名/别名/改父直接更新原行并只追加审计。 | [S03] §1；`backend/apps/knowledge/services/outline.py` | A05/A23 | not verified | High |

“官方来源”不等于题号匹配已核对；AI 多次一致不等于 checked。
无可靠答案内容只能保持待处理/探讨性质，不得进入正式计分和能力投影。[S03] §2.2。

### 2.4 作答、草稿与提交（ANS）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-ANS-01 | 服务端创建 practice/verification/mock_exam 会话并冻结题目、答案、rubric、规范、映射版本和分值，不接受客户端权威分数/模式推断。 | [S03] §2.3/§8；[SI] §4 | A23/A26/A38 | implemented | High |
| R-ANS-02 | 仅领取当前题项时记录首次呈现与 stem_delivered，未领取题无开始时间，刷新/重读不重置。 | [S03] §5.1；[SA] A38 | A38 | implemented | High |
| R-ANS-03 | 五类叶子题在桌面与手机均可输入，草稿本地缓存并同步服务端，旧 revision 返回 409 且不跨项目串稿。 | [S01] §4/§5；[SA] A27 | A27 | implemented | High |
| R-ANS-04 | 大题保存文字、步骤与多图附件，未提交可删除附件，草稿恢复含附件，提交后原始作答及附件不可替换。 | [HP0]；[HP02] G05；[SA] A18 | A18/A27 | implemented | High |
| R-ANS-05 | 提交锁定题项并在一个事务写 attempt、初评、有效评分指针和 outbox，同题项最多一个 attempt，重做新建题项。 | [S03] §4.3；[SI] §4 | A21/A24 | implemented | High |
| R-ANS-06 | 同幂等键同载荷回放同一资源、异载荷 409，换键重复提交已提交题项也返回冲突。 | [S03] §4.3；[SA] A21 | A21 | implemented | High |
| R-ANS-07 | practice 可提交前后按需 reveal/提示/讲解并记录辅助，不强迫先提交空答案；验证整场结束前只给收讫回执。 | [S01] §6；[S03] §4.3 | A19/A26/A37/A38 | implemented | High |
| R-ANS-08 | submit、confirm、finish、tutor 等敏感幂等重放按当前用途门禁重新序列化，不能直接返回历史缓存的分数/答案。 | [HR] 第 1 条；[HF] 第 1 条 | A21/A26/A38 | implemented | High |
| R-ANS-09 | elapsed_ms 按服务端首次呈现至提交计算，client_active_ms 仅作遥测；保存把握程度而不把自报值当能力证据。 | [S03] §8.2；[SI] §9 | A30/A38/C05 | implemented | High |

R-ANS-08 是历史反例揭示的关键规则：幂等保持业务副作用唯一，不授予永久读取敏感响应的权限。
门禁需覆盖同题、家族与内容谱系的并行会话，不能只检查当前路由的 session.mode。

### 2.5 五题型评分、人工确认、重判与表达式（GRADE）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-GRADE-01 | 单选按稳定选项 ID 判分；判断按布尔值判分，false 不等于未答，错误/空答按配置计分。 | [S03] §4.2；[SA] A10 | A10 | implemented | High |
| R-GRADE-02 | 多选按集合完全匹配或少选部分分模板，错选、空答与 partial_score 使用冻结规则并保存快照。 | [S03] §4.2；[SA] A11 | A10/A11 | implemented | High |
| R-GRADE-03 | 填空按固定 blank_id 逐空评分，仅应用显式归一化开关、accepted_values 和 mismatch_policy，原始负号/单位不丢失。 | [S03] §4.2；[SA] A12 | A12/A16 | implemented | High |
| R-GRADE-04 | 数值填空用 Decimal 判 abs(x−a) ≤ max(abs_tol, rel_tol×abs(a))，单位白名单/换算明确，未知单位或解析失败待复核。 | [S03] §4.2；[SA] A15 | A15 | implemented | High |
| R-GRADE-05 | 大题按 rubric 逐点评分并校验必填、上限和刻度，8/10 全部确认属于已评分而非待评，满分正确另行判断。 | [S03] §4；[HP0]；[SI] §4 | A17 | implemented | High |
| R-GRADE-06 | 人工确认提交 expected_grading_revision 与固定答案/rubric，过期 409；本人包括管理员评分均为 self_confirmed。 | [S03] §4.3；[SA] A39 | A17/A20/A39 | implemented | High |
| R-GRADE-07 | confirmed/pending_review/estimated/void 与 deterministic/self/reviewer/ai/mixed 分开，部分待评只展示确认分和待评分值。 | [S03] §4.1；[S22] §2 | A16/A33/C06 | implemented | High |
| R-GRADE-08 | 争议答案停止新计分题项，旧会话仍保存原作答但转待复核；历史证据失效并可重建。 | [S03] §3/§4.3；[SA] A23 | A09/A23 | implemented | High |
| R-GRADE-09 | 重判追加评分事件、锁定稳定题目分配 generation，所有 grade/evidence 分支先检查代次，旧任务不得覆盖新结果。 | [HP02] G01；[HR] 第 2 条；[HF] 第 2 条 | A22/A23 | implemented | High |
| R-GRADE-10 | 相容答案/规则纠错可重判，题干变更不能机械套新答案，家族/标签更正重建归属且不重复累加作答次数。 | [S03] §4.3；[HF] 第 2 条 | A22/A25 | implemented | High |
| R-GRADE-11 | 只有显式 equivalence=expression 的填空启用受限等价比较，未知语法/符号/定义域/超时/超限转人工，未启用题保持原行为。 | [S22] §3 | C07 | implemented | High |
| R-GRADE-12 | 表达式仅白名单数字、运算符、函数/常量，禁止输入代码执行、文件与网络访问，并受长度/深度/步数/时间等预算限制。 | [S22] §3 | C07 | implemented | High |
| R-GRADE-13 | rubric 评分点依赖应有明确执行语义；当前模型校验 depends_on 引用存在，但人工确认服务未据依赖限制给分。 | [S03] §4.2；`backend/apps/question_bank/models.py`；`backend/apps/practice/services/attempts.py` | A17 | not verified | High |

表达式当前交付限额：长度 200、token 160、AST 节点 128、深度 12、总求值步数 4000、指数 64、结果绝对值上限 1e30、变量 2、采样点 24；默认墙钟 50ms，上限 2s。[S22] §3。
白名单函数为 sqrt/abs/sin/cos/tan/log/ln/exp，常量 pi/e；不把采样等价夸大为通用符号定理证明或独立进程沙箱。
负分仅在版本化规则明确允许时生效；整卷封底不能隐式 clamp，真实考试规则仍须另证。[S03] §4.1、[SI] §4。

### 2.6 暴露台账与污染（EXP）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-EXP-01 | 服务端实际下发题干、提示、解析、答案、可推断答案的反馈、编辑预览与外部已见声明均形成可追溯暴露。 | [S03] §5.1；[S20] §2 | A19/A26/C04 | implemented | High |
| R-EXP-02 | 本题项首次呈现属于本次作答，其他历史预览/作答及展示未提交必须保留，不因刷新或重做重获首次资格。 | [S03] §5.1；[S20] §2 | A25/A38/C04 | implemented | High |
| R-EXP-03 | 跨标签页、会话、家族及本人跨项目同源查询暴露，复制、改版本、重算、重判不能洗成未见。 | [S03] §5.1；[S20] §2 | A19/A25/A41/C04 | implemented | High |
| R-EXP-04 | editorial_preview 和 external_seen 是保守的永久污染事实，外部已见更正只追加记录，不删除原标记。 | [S20] §2 | C04 | implemented | High |
| R-EXP-05 | 提交后 reveal 不倒改提交前辅助事实，自评仍独立排除；界面显示暴露原因、时间与证据。 | [S03] §5.1；[S20] §2 | A20/C04 | implemented | High |

模型内部生成而未返回内容不等于用户暴露；封存内容进入训练用途模型输入本身仍是隔离违规。[S03] §5.1。
校对入口已有暴露记录不代表系统能识别所有外部接触；产品只能说“系统内未见记录”，不能宣称绝对未见。

### 2.7 学习证据、状态与 A/B/C 验证（EVID）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-EVID-01 | 分开重复练习、无辅助完成、严格独立、同模板变式、陌生变式和延迟维度，保留资格及排除原因。 | [S03] §5.2；[SI] §5 | A19/A20/A25/A33 | implemented | High |
| R-EVID-02 | 严格独立要求可信内容、已确认非自评/非 AI 评分、符合暴露与用途时间要求，部分分不当独立正确。 | [S03] §4.1/§5.2 | A16/A20/A25/A33 | implemented | High |
| R-EVID-03 | 同题/近重复不能充当不同陌生题，陌生变式需审核变化及第二模板；关系未知显示待确认。 | [S03] §5.2；[SA] A25 | A25/C03 | implemented | High |
| R-EVID-04 | 考点状态由版本化规则计算：1 道严格正确支持独立，2 道及两模板支持陌生变式，3 道不同题/两模板/延迟正确支持延迟验证。 | [S03] §5.2；[SI] §5 | A25/A30/A31 | implemented | High |
| R-EVID-05 | 最近 3 次相关严格独立尝试中至少 2 次失败应触发 needs_review，历史最高保留；当前窗口的严格独立过滤与排序存在差异。 | [S03] §5.2；`backend/apps/learning/services/state.py` | A22/A25 | not verified | High |
| R-EVID-06 | A 讲解/解析下发或无需辅导时的确认评分触发唯一即时 B，B 确认评分触发唯一延迟 C，不要求 B 必须正确。 | [S03] §6；[SA] A31/A37 | A31/A37/A40 | implemented | High |
| R-EVID-07 | 配对版本同项目/科目且题目稳定 ID 不同，按 user/pairing/origin_item/task_kind 去重，缺合格 C 留缺题记录。 | [S03] §6；[SI] §5 | A31/A37/A40 | implemented | High |
| R-EVID-08 | 延迟资格以当前题项首次呈现前最近相关训练/教学为锚点，UTC 满 ≥24h 才成立，多考点逐点判断。 | [S03] §5.2；[HR] 第 3 条 | A30/A31 | implemented | High |
| R-EVID-09 | 新相关学习推动未开始 C 的 not_before，开始时复查；23h 打开、25h 提交不能补成延迟资格。 | [HP02] G03；[HR] 第 3 条 | A30 | implemented | High |
| R-EVID-10 | “需要补基础”应有确认诊断依据；当前 confirmed_gap 可直接来自有评分事件的错误证据，不能声称已完整实施该诊断门槛。 | [S01] §7；[S03] §5.2；`backend/apps/learning/services/state.py` | A32 | not verified | High |

状态门槛是可配置产品假设，不是经过校准的掌握概率；“需要补基础”需确认诊断依据，不能只看一次错选。[S01] §7。
R-EVID-08/09 的时钟边界已有逻辑证据；真实用户经过至少 24 小时再学习的观察独立列为 R-EXT-02。
R-EVID-05 的现代码按 `computed_at` 排序所有有效 `INDEPENDENT_CORRECT` 维度行；不合格作答也有该维度行，窗口未额外过滤辅助/污染等排除原因，不能无条件称为“最近严格独立尝试”。

### 2.8 考点、大纲、前置关系与标签候选（KNOW）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-KNOW-01 | 维护科目/章节/考点树与人工确认模板，可导入大纲词表、合并别名、改名/改父并拒绝环。 | [S16] §2 | B01/B02/B04 | implemented | Med |
| R-KNOW-02 | 每叶子题主考点分值权重合计 1、辅助标签权重 0，未分类显式保留，映射修订不改历史正文。 | [S03] §2.2；[S16] §2 | A13/B02 | implemented | High |
| R-KNOW-03 | 前置边同大纲、无自环及环路、唯一且停用不删除，失败返回环路径且原图不变。 | [S18] §1 | B04 | implemented | High |
| R-KNOW-04 | 补弱先安排未满足前置考点，前置无题保留原考点并给 prerequisite_missing_question 等解释。 | [S18] §1 | B04 | implemented | High |
| R-KNOW-05 | AI 标签只提受控大纲名称候选，未知名记录问题；采纳只写辅助标签新修订，不创建/改名考点。 | [S18] §2 | B04 | implemented-but-real-provider-unverified | High |

题型、模板、考点和家族不是同义概念：题型决定输入与评分；模板描述考法；考点承担分值归属；家族控制近重复污染。
实际前置关系模型名为 `KnowledgeRelation`，不要求新插件照抄规格示例名 `prerequisite_edge`。

### 2.9 中文关键词、向量与混合检索（SEARCH）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-SEARCH-01 | 检索索引仅含题干、选项、材料和考点名，不复制答案/rubric/解析，并可幂等重建。 | [S18] §3 | B05/A26 | implemented | High |
| R-SEARCH-02 | 所有通道打分前先过滤 owner/project/subject、实时发布/撤回和封存，陈旧索引或相似度 1.0 不能绕过。 | [S18] §3；[S21] §1 | B05/C03 | implemented | High |
| R-SEARCH-03 | 支持版本化中文单字/二元组分词、BM25、余弦向量和 RRF，返回通道名次、融合分与确定性排序。 | [S18] §3 | B05 | implemented | Med |
| R-SEARCH-04 | 向量不可用时 hybrid 明示降级为关键词，vector-only 返回空结果及原因，stub 不伪造向量。 | [S18] §3；`backend/apps/search/services/hybrid.py` | B05/A28 | implemented | High |
| R-SEARCH-05 | 嵌入 provider 的真实 HTTP 往返及真实向量混合排序质量须独立验证，注入确定性向量仅作功能证据。 | [S18] §7 | B05 | implemented-but-real-provider-unverified | Med |
| R-SEARCH-06 | 固定人工金标报告 recall/precision@k、MRR 和逐条 miss，无法解析金标标签必须失败退出。 | [S18] §3 | B05 | implemented | Med |

现有金标：10 篇验收文档、8 条中文查询，关键词 recall@5/@10 与 MRR 均为 1.000；这不是大题库、真实向量或生产检索质量结论。[S18] §3。
当前分词 `zh-char-ngram-v1`，BM25 k1=1.2、b=0.75，RRF k=60；迁移应保留可重现参数和排序对照，不默换“最新模型”。

### 2.10 FSRS 记忆卡（MEM）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-MEM-01 | 主动回忆卡支持创建、到期列表、again/hard/good/easy 四档复习、暂停/恢复与下次到期展示。 | [S18] §4 | B06 | implemented | Med |
| R-MEM-02 | 使用版本化 FSRS-4.5 默认参数调度，显式输入复习时间，保存参数版本、调度版本及前后状态。 | [S18] §4；`backend/domain/memory/fsrs.py` | B06 | implemented | High |
| R-MEM-03 | 复习日志追加保存且事务幂等，同键异评级 409，卡状态可按日志重放并检出不一致。 | [S18] §4 | B06/A21 | implemented | High |
| R-MEM-04 | 记忆卡复习不生成作答/评分/学习证据、不升级考点能力；只有到期卡进入总预算计划，撤回题不重排。 | [S18] §4 | B06/A29 | implemented | High |

实际实现是无第三方依赖的 `fsrs-4.5-default-v1`，17 个权重；不是已经接入 py-fsrs，也不是泛称“最新 FSRS”。
当前学习步长为 again 1 分钟、hard 5 分钟、good 进入下一学习步（10 分钟）、easy 直接毕业，详情以 `backend/domain/memory/fsrs.py` 为准。

### 2.11 今日计划、预算与复习入口（PLAN）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-PLAN-01 | 多项目共享一个每日总预算，按比例最大余数分配整数分钟并按当地日期轮换，不得每项目各用全部预算。 | [S03] §6；[SA] A29/A42 | A29/A42 | implemented | High |
| R-PLAN-02 | 放不下整题的项目余额应共享再分配、按日轮换且不跨日透支；当前逐项目排题后未消费 remaining 做跨项目再分配。 | [S03] §6；[SA] A42；`backend/apps/learning/services/planner.py` | A42 | not verified | High |
| R-PLAN-03 | 按到期验证/记忆复习、补弱、未诊断、一般练习顺序生成任务，跳过争议/撤回/封存等不合格题。 | [S03] §6；[SI] §5；[S18] §4 | A29/B06/C03 | implemented | High |
| R-PLAN-04 | 每任务保存原因码、证据、预计时长及规则版本，显示缺题、配额不足、积压和顺延，不伪造完成进度。 | [S03] §6；[SI] §5 | A29/A31 | implemented | High |
| R-PLAN-05 | 同日非刷新复用计划，刷新建修订且不删除旧进行中/完成行，任务 start 复核有效性和延迟边界并支持延期/跳过。 | [S03] §6；[HP02] G03；`backend/apps/learning/services/planner.py` | A29/A30/A42 | implemented | High |
| R-PLAN-06 | 错题/复习可按考点、原因和评分来源查看，展示配对与延迟任务、未知原因和失效内容。 | [S01] §4；[SI] §5 | A31/A32/A33 | implemented | Med |
| R-PLAN-07 | exam_weight×weakness×improvability/时间加逾期项的优先级公式属于可选增强，不能宣称当前已用真实数据校准。 | [S03] §6；`backend/apps/learning/services/planner.py` | — | not verified | Med |
| R-PLAN-08 | 未诊断时间配额应真正约束前面类别的支出；当前只计算 reserve 并事后提示，补弱任务可以先耗尽余额。 | [S03] §6；`backend/apps/learning/services/planner.py` | A29 | not verified | High |
| R-PLAN-09 | 刷新应将进行中/已完成项纳入当日展示与已用预算；当前新计划未关联这些旧行，也未扣除其分钟数。 | [S03] §6；`backend/apps/learning/services/planner.py` | A29 | not verified | High |
| R-PLAN-10 | 普通题的同日/同模板重复上限及跨类别/刷新去重是保留约束，当前仅见局部补弱去重和记忆卡开放任务复用。 | [S00] §6.3；[S03] §6；`backend/apps/learning/services/planner.py` | A25/A29 | not verified | High |

初始预计时长与未诊断 20% 配额是配置默认值，不是用户实测学习速度。[S03] §6。
代码仍采用明确类别排序并加入前置考点/记忆卡；效果校准报告不自动训练或改写计划参数。
R-PLAN-01 的整数预算分配已实现，不能由此推导 R-PLAN-02 的“两个项目各分到 1 分钟时合并成一道 2 分钟题”也已实现。
R-PLAN-05 只确认历史行没有删除，不等于刷新后的完整继承；当前 `plan_payload` 仅读取新 plan.tasks，详见 R-PLAN-09。

### 2.12 报告、真实周期统计与诚实范围（REPORT）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-REPORT-01 | 练习报告分列完全确认、部分待评、待复核、自评、辅助、重复、严格独立与 AI 估分，并显示分母及排除原因。 | [S03] §5；[SA] A33 | A33 | implemented | High |
| R-REPORT-02 | 真实周期统计纳入 official_past 非演示且有效修订已确认、覆盖完整的计分发生记录，生成题/重复导入由上游规则限制。 | [S16] §2；`backend/apps/analytics/services/cycles.py` | A08/A14/B01/B02 | implemented | High |
| R-REPORT-03 | 考点容量按题项分值×映射权重累加，父材料不计分、辅助标签不加分、未分类单列，归属总和等于纳入总分。 | [S03] §7；[S16] §2 | A13/B02 | implemented | High |
| R-REPORT-04 | 周期完整性依赖预期场次/卷别及人工覆盖确认，未知预期不能因上传单卷即称全年完整。 | [S03] §2.1；[S16] §2 | B01 | implemented | High |
| R-REPORT-05 | 已登记周期中选择最近五个完整周期并显示实际数量，列已登记不完整周期原因，不把缺数据补成零。 | [S16] §2；`backend/apps/analytics/services/cycles.py` | B01 | implemented | High |
| R-REPORT-06 | 按科目提供年度分布、覆盖缺口和未覆盖考点，不能把频率说成未来出题概率。 | [S00] §4.3；[S16] §2 | B01/B02 | implemented | High |
| R-REPORT-07 | incomplete_scope 逐项列出未评分、待复核、部分确认、争议、失效/作废评分和估分，未完成时 final_result 必须为 null。 | [S22] §2 | C06 | implemented | High |
| R-REPORT-08 | 未完成只给标注清楚的确认分下限与 unresolved_max_score，各桶标记是否最终，覆盖未完整时 coverage_rate 为 null。 | [S22] §2 | C06 | implemented | High |
| R-REPORT-09 | 进行中验证/考试从可披露报告范围排除且不伪装为待评；不得输出未经支持的最终排名或通过概率。 | [S22] §1/§2 | A26/A33/C05/C06 | implemented | High |
| R-REPORT-10 | 周期分析应过滤无效大纲/争议映射，跨大纲变化分组或说明不可比；当前按科目聚合并使用最新映射，未见这些过滤。 | [S03] §7；`backend/apps/analytics/services/cycles.py` | B01/B02 | not verified | High |
| R-REPORT-11 | 应显示预期但完全未登记的缺失周期；当前只从已登记 Paper 分组，无法由此自动产生空白年份行。 | [S03] §7；[S05] B01；`backend/apps/analytics/services/cycles.py` | B01 | not verified | High |

封存不是删除历史事实：学习者的聚合报告桶和试卷构成保留，但实际内容与评分仍受当前用途门禁约束。[S21] §1。
统计由确定性代码生成，LLM 最多解释已有结果；null、零分、缺失与未纳入必须保持不同含义。

### 2.13 限时模拟考试（EXAM）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-EXAM-01 | 模拟考试用 mock_exam 会话，显式 5–600 分钟或已发布规范推导时长，服务端只写一次开始与截止时间。 | [S22] §1 | C05 | implemented | High |
| R-EXAM-02 | 刷新、断线、重复读取及伪造客户端 now/deadline 不得延长期限，前端倒计时以服务端锚点展示。 | [S22] §1 | C05 | implemented | High |
| R-EXAM-03 | 交卷和过期结束持行锁且幂等，结束不可重开，过期 finished_at 固定为截止时刻，迟交 409 且不新增作答。 | [S22] §1 | C05 | implemented | High |
| R-EXAM-04 | 考试结束前所有分数/正误/答案/评分点/辅导/估分入口隐藏或拒绝，并封堵同题并行 practice 泄漏。 | [S22] §1/§6 | A26/A38/C05 | implemented | High |
| R-EXAM-05 | 到期由读路径兜底和幂等 expire_mock_exams 管理命令结束，未完成评分按 REPORT 组规则显示。 | [S22] §1/§2 | C05/C06 | implemented | High |

当前实现不是单独的 `/mock-exams` 子系统；服务端可能先持久化逐题评分，结束前不对用户交付评分反馈。
真实无人访问时的多进程 beat 到期调度尚未运行，不能把读路径/命令测试写成 scheduler 全链路通过。[S22] §7。

### 2.14 效果分组与校准（CAL）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-CAL-01 | 按题型×满分档难度代理×服务端时限条件×暴露状态分组，只统计符合条件的已确认分数。 | [S22] §4 | C08 | implemented | High |
| R-CAL-02 | 每组不足 5 个已确认样本时 statistics 为 null，明确样本数及不足原因，不输出数字后再附警告。 | [S22] §4 | C08 | implemented | High |
| R-CAL-03 | 只比较可比组，差值必须附样本量、离散度和 caveats，不可比组合列出原因。 | [S22] §4 | C08 | implemented | High |
| R-CAL-04 | 排除自评/AI 估分并强制禁止因果、整体提升、排名或通过率式汇总，满分档不能声称为认知难度。 | [S22] §4；`backend/apps/analytics/services/calibration.py` | C08 | implemented | High |

当前满分档为 ≤2、2–5、>5 分，属于冻结卷面分值代理；时限来自规范/题目配置，暴露复用污染规则。
该模块是只读分组分析，不写学习状态、快照或调度参数；“效果校准已交付”不代表真实提分因果已证明。

### 2.15 辅导、模型能力、转写、估分与 SSE（AI）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-AI-01 | Provider 声明文本/视觉/结构输出/嵌入能力，可替换实现，文本模型不能冒充视觉模型。 | [S02] §6；[SI] §6 | A28/A36 | implemented | High |
| R-AI-02 | 辅导绑定 session_item 且 attempt 可空，使用冻结题目/答案/rubric、大纲、实际作答步骤及允许图片构造上下文。 | [S03] §8；[HP0]；[SI] §6 | A34/A37 | implemented | High |
| R-AI-03 | 按需提供提示、条件解释或完整讲解，真实讲解/图片识别需记录模型和提示版本并经人工质量核验。 | [SH]；[S16] §4 | A36/A37 | implemented-but-real-provider-unverified | High |
| R-AI-04 | 输出先校验 schema、题型结构、引用集合及业务规则，伪造引用/非法 JSON/超时不得进入正式内容。 | [S02] §6；[SI] §6 | A28/A34 | implemented | High |
| R-AI-05 | 手写照片先生成转写建议并保留疑点，用户确认/修改后才进入诊断与估分，未确认返回 409。 | [S19] §1 | B07 | implemented-but-real-provider-unverified | High |
| R-AI-06 | 无视觉模型仍支持人工录入转写，标记 origin=manual、无模型调用，空白拒绝且已确认转写不可被迟到模型覆写。 | [S19] §1/§6 | A18/A28/B07 | implemented | High |
| R-AI-07 | AI 按冻结 rubric 给逐点估分/依据/缺失证据，仅写独立 estimated 事件，不改 current_grade_event、证据或考点状态。 | [S19] §2 | A33/B07 | implemented-but-real-provider-unverified | High |
| R-AI-08 | 空估分不当 0 分，估计预填只填人工表单，最终人工确认另建事件且保留原模型事件。 | [S19] §2 | A16/A33/B07 | implemented | High |
| R-AI-09 | 诊断只提受控原因及证据，无依据降级 unknown，追问可回答/跳过、原因可确认/否认且不改分数与掌握状态。 | [S19] §3；[SA] A32 | A32/B07 | implemented-but-real-provider-unverified | High |
| R-AI-10 | SSE 仅投递已校验持久化片段，支持 Last-Event-ID/after 重连，读取不重调模型、不创建 LLMRun/outbox。 | [S19] §4 | B08 | implemented | High |
| R-AI-11 | SSE、segments、job、幂等重放每次交付重查权限/版本/撤回/封存，失效来源只返回错误不泄漏片段。 | [S19] §4；[S21] §1 | A34/B08/C03 | implemented | High |
| R-AI-12 | HTTP 同步入口与 Worker 共用 claim，短事务一致提交 job/消息/暴露/审计，模型网络等待不持长事务锁。 | [HR] 第 4 条；[HF] 第 3 条 | A24/A34/A37 | implemented | High |

能力名称包括 extract_question、suggest_tags、explain、diagnose、estimate_grade、propose_variant、embed；转写在 P1 增补。[S02] §6、[SI] §6。
不能把 SSE 已校验分段称为原始 token 直播；当前实际事件/路由与设计期命名存在差异，见 §6。
模型输出没有任意 DB/文件/命令写工具；题干及检索资料内的指令按不可信数据处理。[S02] §6、[SA] A34。

### 2.16 生成变式（VAR）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-VAR-01 | 从已发布、非材料、未封存源题生成最多 3 条变式候选，目标考点必须属于同科目大纲。 | [S21] §2/§3 | C02/C03 | implemented-but-real-provider-unverified | High |
| R-VAR-02 | 共享内容校验检查条件结构、单选唯一、多选至少 2 项、填空空位与答案、大题合计及答案自洽。 | [S21] §2 | C02 | implemented | High |
| R-VAR-03 | 拦截复制源题、题干含答案、已发布题/家族成员/同批重复，失败保留候选及问题且发布时重算门禁。 | [S21] §2 | C02 | implemented | High |
| R-VAR-04 | 候选仍需人工确认答案，发布强制 ai_generated，不能挂 official_past 或进入真实周期统计。 | [S21] §2；[S03] §2.1 | C02/B02 | implemented | High |

结构自洽校验不等于真实学科答案已被独立证明；真实变式提示词尚未对真实模型验证。[S21] §5。
无 provider 时明确失败、不创建变式任务/候选，只保留 unavailable 调用审计；stub 占位题无答案，会被校验拦下。

### 2.17 家族、封存与合并（SEAL）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-SEAL-01 | 家族可创建/改名/确认关系及按题目 ID 加入/移出成员，封存/解封追加策略修订和审计。 | [S21] §1/§3 | C03 | implemented | High |
| R-SEAL-02 | 统一封存解析器按最新策略限制练习/验证、检索、AI 提示/缓存投递、Worker、计划/启动、原页资源及题库预览。 | [S21] §1 | C03 | implemented | High |
| R-SEAL-03 | 封存源不得进入变式提示，拒绝发生于 provider 调用前；过期缓存与索引不能绕过实时策略。 | [S21] §1/§3 | C02/C03 | implemented | High |
| R-SEAL-04 | 合并家族先预览影响再确认，拒绝自己/跨科目/跨项目合并，重复合并幂等且保留源家族合并审计。 | [S21] §1 | C03 | implemented | High |
| R-SEAL-05 | 合并后重查历史暴露，使不再成立的 unseen/template 证据失效但不删除，并按 user/project/node 重算状态。 | [S21] §1 | A25/C03/C04 | implemented | High |
| R-SEAL-06 | 将来内容导出必须调用 sealed_exclusions；当前没有导出接口，不把辅助函数当完整导出能力。 | [S21] §1 | C03 | not verified | High |
| R-SEAL-07 | 家族成员清单只读接口仍是可用性缺口，现界面仅有 member_count 与按 ID 的成员操作。 | [S21] §5 | C03 | not verified | Med |

严格封存测验需要可靠来源、首次测验前整个家族无训练/编辑暴露、考试模式及可确认评分。[S03] §5.2。
实际真实材料的封存策略/语义未验证；题目一经呈现就消耗首次资格，解封不能删除历史污染。

### 2.18 账户、认证和 CSRF（AUTH）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-AUTH-01 | 用账户命令初始化用户，无默认密码/管理员，登录后可完成空账户项目配置与导入闭环。 | [SR] §3；[SA] A01；[HP02] G07 | A01 | implemented | High |
| R-AUTH-02 | 当前采用服务端 Session Cookie，CSRF 覆盖登录、退出、上传、提交和评分，未登录业务请求被拒。 | [S02] §4；[SA] A02 | A02 | implemented | High |
| R-AUTH-03 | 登录限流，身份来自服务端认证，不能接受前端 user_id 选择用户，已知他人对象 ID 也不可访问。 | [S02] §4；`backend/apps/accounts/api.py` | A02/A04 | implemented | High |
| R-AUTH-04 | 本人管理员评分仍为 self_confirmed，服务层区分 staff 非本人评分；这不等于已具备跨 owner 授权复核入口。 | [SA] A39；`backend/apps/practice/services/attempts.py` | A20/A39 | implemented | High |
| R-AUTH-05 | 他人复核应有显式授权关系和可用入口；当前 reviewer 判断仅 staff+非本人，HTTP 又要求项目 owner，完整流程未获证明。 | [S02] §4；[S03] §4.3；`backend/apps/common/scope.py`；`backend/apps/practice/api.py` | A04/A39 | not verified | High |

当前登录节流常量为同邮箱/IP 窗口 300 秒、10 次尝试，成功后清理该键；DSH 认证机制替换仍需保留身份和用途隔离语义。
登录 UI 实际在 `frontend/src/app/AppRoot.tsx`，没有独立 `features/accounts` 页面目录。

### 2.19 审计、修订与可观测性（AUD）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-AUD-01 | 记录请求关联 ID、主体、路径、状态、耗时及内容修订的操作者/原因/前后摘要，不默认输出密钥或原始个人图片。 | [S02] §6/§8；`backend/apps/audit/models.py` | A34 | implemented | High |
| R-AUD-02 | 每模型调用记录 provider/model、能力、提示版本、输入快照/摘要、来源、校验、token、费用、延迟、尝试和错误，未知费用为 null。 | [S02] §6；[SI] §6 | A28/A36 | implemented | High |
| R-AUD-03 | stub 标志贯穿结果、UI 和 LLMRun，调用失败也留下真实失败审计，不伪造成功/用量。 | [S16] §4；[SI] §6 | A28/A36 | implemented | High |
| R-AUD-04 | 历史派生字段修复保存前后值审计，模糊重判顺序可安全拒绝迁移并输出清单，不能猜 generation 或重写原始作答。 | [HP02] G07；[HR] 第 2 条 | A22/A23 | implemented | High |

AI 费用/版本历史通过 `/ai-runs` 查看；这些审计能力不等于已交付生产监控仪表盘或真实模型费用评估。
事实账本和可重建投影要分别迁移：删除投影重算不能顺带删除暴露、评分事件或修订依据。

### 2.20 Outbox、Celery 与异步恢复（ASYNC）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-ASYNC-01 | 业务事务同时保存 outbox，业务状态以数据库为真相，提交后派发并周期扫描补发，不能仅依赖 on_commit(delay)。 | [S02] §5；[SI] §1/§2 | A24/A35 | implemented | High |
| R-ASYNC-02 | ingestion/tutoring/projection 分队列，在线与离线处理隔离，真实 Celery 消费者注册并处理全部业务主题。 | [S02] §5；[HP0]；`backend/apps/audit/tasks.py` | A24 | implemented | Med |
| R-ASYNC-03 | 消费者统一 claim/token/lease，processed_at 才是完成事实，重试有上限且旧消费者不能完成或回退接管者任务。 | [HP02] G04；[HR] 第 4 条 | A24 | implemented | High |
| R-ASYNC-04 | 模型最终提交校验所有权及输入代次，任务结果、助手消息、曝光和完成事实一致且业务副作用仅一次。 | [HR] 第 4 条；[HF] 第 3 条 | A24/A34/A37 | implemented | High |
| R-ASYNC-05 | Redis 丢队列、Worker 被杀、同事件重复投递可从数据库恢复，不能丢原始作答或重复发布/计分/配对。 | [S24] §5；[SA] P0.2 更新 | A24/A35/A37 | implemented | High |
| R-ASYNC-06 | 派发记录先在短事务提交，再发 broker，消息出现后不再更新同一行，避免快速消费者被派发锁跳过。 | [S24] §2 | A24 | implemented | High |

当前默认 outbox 租约为 300 秒、最大尝试 8 次；“恰好一次”指业务副作用，不承诺网络消息或模型调用恰好一次。
过期 processing 并发扫描可重复投递、提交派发记录后发 broker 前被杀两个窗口，见 R-GAP-04/05。

## 3. 非功能需求与迁移约束

以下条目补充跨能力契约；已在功能组定义的规则只引用，不重复创造新语义。
框架替换不允许降低权限、发布审核、证据规则或失败诚实度；具体新实现与现有算法的兼容证明属于后续迁移工作。

### 3.1 权限、文件与答案隔离（SEC）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-SEC-01 | 查询、外键、任务、文件、缓存及检索均检查 owner/project/subject，越权对象按既有 404/业务错误契约拒绝。 | [S03] §1/§8；[SA] A03/A04 | A03/A04/A34 | implemented | High |
| R-SEC-02 | 题干 DTO、编辑 DTO 与答案 DTO 分开，验证/考试隔离覆盖并行入口、旧结果、评分队列、报告和含答案资源。 | [S03] §8；[HF]；[S22] §1 | A26/A38/C05 | implemented | High |
| R-SEC-03 | 原始文件私有、对象键服务端生成、路径穿越拒绝；整页可能泄漏时仅允许审核安全区域，不安全图不得用于独立测验。 | [S02] §4；[SA] §4 | A04/A26 | implemented | High |
| R-SEC-04 | 图片验证 MIME 和实际解码、清 EXIF，限制格式/像素/大小/数量，不执行 SVG/HTML，题干和公式禁用危险脚本及信任渲染。 | [S02] §4；[SA] §4 | A18/A26/A27 | implemented | High |
| R-SEC-05 | 生产同源 HTTPS、Secure/HttpOnly Cookie，秘密仅环境/本机配置，不能进入 Git、前端构建变量或文档输出。 | [S02] §4/§8；[SR] §4；[S24] §7 | A02 | implemented | High |
| R-SEC-06 | 上传材料作为不可信数据，模型不获得任意 DB/文件/命令能力，内容不能借提示注入更改评分/状态。 | [S02] §6；[SA] A34 | A34 | implemented | High |
| R-SEC-07 | 云端模型调用前去除姓名/学号等信息是原始隐私需求，现有 EXIF 清理与日志约束不等同完整内容脱敏流水线。 | [S00] §11；[S02] §6 | — | not verified | High |

当前默认限制：JPEG/PNG/WebP；每图 10 MiB、25 MP；每次作答最多 6 张、累计 30 MiB，均可配置。[S02] §4、`backend/config/settings/base.py`。
这些上限不能在迁移时被 JavaScript 字节/像素转换或上传代理默认值静默放宽。

### 3.2 一致性、不可变性与接口（CONS）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-CONS-01 | 分值使用精确十进制、API 传十进制字符串，时间存带时区 UTC，用户时区仅决定展示/今日边界。 | [S03] §1 | A11/A15/A30/A42 | implemented | High |
| R-CONS-02 | 题目/答案/rubric/规范冻结引用及原始作答保留，评分/暴露/模型/审计事件保留历史，投影可重建且有效正式评分指针唯一。 | [S03] §1/§4；[SI] §2 | A05/A21/A22/A23 | implemented | High |
| R-CONS-03 | 副作用请求与异步操作有幂等作用域和载荷摘要，乐观编辑冲突 409，过时任务标 stale 不覆新状态。 | [S03] §4.3/§8；[HF] | A21/A22/A24/A27 | implemented | High |
| R-CONS-04 | 使用类型化输入/输出和统一 error.code/message/details/request_id，API 明确认证、用途及 400/401/403/404/409/422/429/503 语义。 | [S03] §8；[SI] §1 | A02/A04/A09/A21 | implemented | Med |
| R-CONS-05 | 列表有分页/上限，GET 不生成计划或评分；实际内容下发可追加暴露审计，不能被“GET 只读”优化删掉。 | [S03] §8；[SI] §5 | A26/A29/A38 | implemented | High |
| R-CONS-06 | 归档/撤回保留历史，不提供通用业务硬删除；账户删除及级联保留策略不属于已交付能力。 | [S03] §1 | A05/A23 | implemented | High |

通用列表契约默认 20、最多 100；具体检索当前默认 10、最多 50，报告也有自己的采样上限，不能一律套用同一分页值。
DSH 迁移中的 Decimal、时区/夏令时、UUID、null/false/空数组及幂等载荷规范化都须以现有金标逐项比对。

### 3.3 AI 降级、成本和资源限制（DEGRADE）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-DEGRADE-01 | 未配置 AI 时手工导入、确定性判分、人工评分、人工转写、复习、计划及报告继续可用，AI 明确 unavailable/未配置。 | [SI] §6；[S19] §1 | A28/A36/B07 | implemented | High |
| R-DEGRADE-02 | stub 仅在显式 test/demo 运行模式允许，生产拒绝；测试模型、真实模型、真实时间和浏览器证据分别标记。 | [SH]；[SI] §6/§8 | A28/A36 | implemented | High |
| R-DEGRADE-03 | 模型调用受墙钟超时与有限重试控制，认证/无效输入不无限循环，失败不写正式分数，费用未知仍标未知。 | [S02] §5；[SI] §6；[S16] §4 | A28/A36 | implemented | High |
| R-DEGRADE-04 | 结构修复、费用总预算和用户取消尚未发起请求是架构要求，不能仅因配置常量存在就声称完整执行已验证。 | [S02] §5；`backend/config/settings/base.py` | A28 | not verified | Med |

架构默认连接 10 秒、总超时 90 秒、最多 2 次退避重试、结构修复最多 1 次；独立连接时限/共享预算的精确执行需在迁移时补证。
缓存复用不得越过版本、用户、项目、用途及封存门禁；当前内容缓存载体是 TutorJob/TutorSegment/LLMRun，而非一个已验证的通用解析缓存系统。[S21] §1。

### 3.4 性能基线（PERF）

下表是 [S24] 的历史实测基线及局部量尺，不是生产 SLA、吞吐承诺或 Node 插件的既成结果。

| ID | 一句话需求/测量基线 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-PERF-01 | questions_list 在该夹具从 123 查询/41.09ms 降至 7/5.65ms，5→40 行仍为 7 查询，保留字段和门禁语义。 | [S24] §1/§3 | — | implemented | Med |
| R-PERF-02 | practice_sessions_list 从 67 查询/19.85ms 降至 8/4.84ms，5→40 行仍为 8 查询，不删逐项门禁。 | [S24] §1/§3 | — | implemented | Med |
| R-PERF-03 | 两条优化路径正常时间戳条件下与旧结果逐字节对照，其余 8 端点查询数不变，同时间戳排序例外公开。 | [S24] §3/§6 | — | implemented | High |
| R-PERF-04 | 前端入口 JS 为 39,762 B（gzip 12,490 B），首屏静态图合计 342,882 B/3 chunks，不把入口大小冒充首屏总量。 | [S24] §4 | — | implemented | Low |
| R-PERF-05 | 12 路由与 KaTeX 按需加载，加载失败有可见回退/重载，公式失败回退原始 LaTeX。 | [S24] §4 | A27 | implemented | Med |
| R-PERF-06 | outbox 快速消费者同一轮可领取并完成，不再因派发行锁被迫等待 300s 租约；保持租约和业务幂等。 | [S24] §2 | A24 | implemented | High |

其余包体数据：旧入口/首屏 886,357 B；新入口 CSS 7,376 B（旧 36,459 B）；按需 JS 548,365 B/16 chunks。[S24] §4。
5000 题/20000 会话局部测量中 20k 会话查询约 65–72ms；没有新增索引或迁移，这些不能外推真实生产延迟分位。[S24] §3。
KaTeX dev 与生产 preview 探针均测得首载 0 次、公式渲染后 3 次请求及有效字体样式，但尚非常设浏览器回归。[S24] §4/§6。
outbox “最坏约 5.5 分钟”是 300s 租约 + 30s beat 推算；实测结论为同一轮 processed，不是已测得平均耗时提升 5.5 分钟。

### 3.5 备份、恢复、部署与交付（OPS）

| ID | 一句话需求 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-OPS-01 | 备份数据库、私有媒体、SHA-256 清单和版本信息，默认保留 7 天可调，Redis 不作为业务事实备份依据。 | [S02] §8；[SR] §5 | A35 | implemented | High |
| R-OPS-02 | 恢复支持 dry-run，拒绝已有目标库/非空媒体/缺备份文件，核对 missing/extra/hash、原作答与冻结版本引用。 | [SR] §5；[SA] A35 | A35 | implemented | High |
| R-OPS-03 | 当前 Compose 有 web/api/三类 worker/scheduler/postgres/redis，同源 TLS、持久化和健康检查可在本机重现。 | [S02] §8；[SR] §7；[S24] §7 | A01/A02/A35 | implemented | Med |
| R-OPS-04 | 存活与就绪分开，数据库/缓存参与就绪，模型不可用仅降级 AI；数据库/Redis 不暴露公网。 | [S02] §8；[SI] §1 | A01/A28 | implemented | High |
| R-OPS-05 | 发布脚本使用唯一临时项目/资源/配置，只清理自身资源且保留用户 .env/无关卷，干净 checkout 含无密钥模板。 | [HF] 第 4 条；[S24] §7 | A01/A35 | implemented | High |
| R-OPS-06 | 验收库、媒体、端口和 Worker 隔离，FLUSHALL 故障演练必须独占 Redis，不能停止用户服务或清空业务库换通过。 | [HP0]；[HP02]；[HR]；[S17] §3 | A24/A35 | implemented | High |
| R-OPS-07 | 保留依赖锁、迁移、账户初始化、启动、测试、备份恢复命令和实际结果；本机门禁不冒充远程部署/CI。 | [SH] 最终交付；[SR] §3–§7；[S24] §7 | A01/A35/A36 | implemented | Med |

历史恢复记录：attempts 30/30、grade_events 35/35、session_items 41/41、exposures 46/46、versions 324/324、answers 297/297、assets 2/2、tasks 19/19，媒体 SHA-256 一致。[SR] §5。
这些计数是当时备份验证集，不是本次库盘点结果，也不能与 36 个演示发布版本直接比较。

## 4. 原验收编号的完整覆盖索引

本节只做追溯，不新增需求；[S05] 的 58 个编号全部出现，A36 不因其他条目“关闭”而变成真实 provider 已通过。
`A30` 的调度逻辑实现与真实时间观察分开；B07/C02 的模型能力按真实 provider 未验证处理。

| 原编号 | 含义 | 主需求映射 |
|---|---|---|
| A01 | 空库、账户、登录与空项目 | R-AUTH-01、R-PROJ-01、R-OPS-03/07 |
| A02 | 认证及 CSRF | R-AUTH-02/03、R-SEC-05 |
| A03 | 项目/科目/规则切换与隔离 | R-PROJ-01/04、R-SEC-01 |
| A04 | 另一用户对象/文件/任务越权 | R-AUTH-03/05、R-SEC-01/03 |
| A05 | 已发布版本不可改 | R-QB-01/02/10、R-CONS-02 |
| A06 | 原文、负号、单位可追溯 | R-IMPORT-01/08 |
| A07 | 模糊/缺项/冲突阻断 | R-IMPORT-02/03、R-QB-04 |
| A08 | 同卷重复导入不重计 | R-IMPORT-05、R-QB-07、R-REPORT-02 |
| A09 | 发布结构与答案/rubric 审核 | R-QB-03/04、R-GRADE-08 |
| A10 | 稳定选项 ID/集合/false | R-GRADE-01/02 |
| A11 | 项目多选计分差异 | R-GRADE-02 |
| A12 | 显式填空归一化 | R-GRADE-03 |
| A13 | 父子计分与权重守恒 | R-QB-05/06、R-KNOW-02、R-REPORT-03 |
| A14 | 跨年真实重复与同卷去重 | R-QB-01/07、R-REPORT-02 |
| A15 | Decimal 容差与未知单位 | R-GRADE-04 |
| A16 | 部分确认/待评不当零分 | R-GRADE-03/07、R-AI-08 |
| A17 | 大题逐点评分与上限 | R-GRADE-05/06/13 |
| A18 | 照片作答不可替换 | R-ANS-04、R-AI-06 |
| A19 | 跨标签页辅助暴露 | R-ANS-07、R-EXP-01/03 |
| A20 | 提交后 reveal 与自评证据 | R-EXP-05、R-GRADE-06、R-EVID-02 |
| A21 | 并发提交与幂等冲突 | R-ANS-05/06/08、R-CONS-03 |
| A22 | 重判代次与历史 | R-GRADE-09/10、R-AUD-04 |
| A23 | 冻结版本与争议处理 | R-QB-02/08、R-GRADE-08/09 |
| A24 | 重投、发布恢复 | R-IMPORT-04/05、R-ASYNC-01–06 |
| A25 | 同题/同族非独立多证据 | R-EXP-02/03、R-EVID-01–05 |
| A26 | 验证所有入口答案隔离 | R-ANS-07/08、R-SEC-02/03 |
| A27 | 手机/桌面五题型和草稿 | R-ANS-03/04、R-PERF-05 |
| A28 | 无密钥/超时/坏 JSON/伪造引用 | R-AI-01/04、R-DEGRADE-01–04 |
| A29 | 全局预算、积压与保留任务 | R-PLAN-01/03/04/05/08/09/10 |
| A30 | UTC 延迟边界和更新锚点 | R-EVID-08/09、R-EXT-02 |
| A31 | A/B/C 及缺题/污染降级 | R-EVID-06/07、R-PLAN-06 |
| A32 | 原因未知/候选/否认 | R-AI-09、R-PLAN-06、R-EVID-10 |
| A33 | 正式/待评/自评/AI 分离 | R-GRADE-07、R-REPORT-01、R-AI-07/08 |
| A34 | 个性化隔离、撤回缓存、模型无写工具 | R-AI-02/04/11/12、R-SEC-01/06 |
| A35 | 数据/媒体恢复和 Redis 重建 | R-OPS-01/02、R-ASYNC-05 |
| A36 | 真实图像与文本 provider | R-AI-03、R-EXT-01 |
| A37 | 提交前辅导与唯一 B/C | R-ANS-07、R-EVID-06/07、R-AI-02 |
| A38 | 逐题呈现与整场验证零反馈 | R-ANS-02/07/08/09 |
| A39 | 过期自评页/管理员本人 | R-GRADE-06、R-AUTH-04/05 |
| A40 | 默认分值/材料叶子/唯一配对 | R-QB-05/06、R-EVID-06/07 |
| A41 | 跨本人项目复制保留污染 | R-PROJ-06、R-EXP-03 |
| A42 | 极小预算整题分配与日轮换 | R-PLAN-01/02/05 |
| B01 | 完整周期不足与缺失可见 | R-REPORT-02/04/05/06/10/11 |
| B02 | 分值守恒、未分类、真实跨年重复 | R-KNOW-02、R-REPORT-02/03/10 |
| B03 | 原生 PDF 与答案页匹配 | R-IMPORT-06/07/08 |
| B04 | 无环前置与受控标签 | R-KNOW-03/04/05 |
| B05 | 中文检索金标与权限过滤 | R-SEARCH-01–06 |
| B06 | FSRS 重放、版本与能力隔离 | R-MEM-01–04 |
| B07 | 转写确认、估分与诊断 | R-AI-05–09 |
| B08 | 校验分段 SSE 与重连 | R-AI-10/11、R-GAP-01 |
| C01 | 版式分类、跨页和人工门禁 | R-IMPORT-09–12 |
| C02 | 变式条件/答案校验与非真题 | R-VAR-01–04 |
| C03 | 封存、家族合并与各入口 | R-SEAL-01–07 |
| C04 | 编辑/外部已见/展示未交不洗白 | R-EXP-01–05 |
| C05 | 服务器考试期限与零反馈 | R-EXAM-01–05、R-GAP-02 |
| C06 | 未完成范围与无伪最终分 | R-REPORT-07/08/09 |
| C07 | 受限数学判分与失败转人工 | R-GRADE-11/12 |
| C08 | 分组样本、可比性、无因果推断 | R-CAL-01–04 |

## 5. 已知未验证、外部阻塞与工程缺口

本节不是要求当前执行任何联网、凭据读取、生产迁移或故障注入；它说明迁移团队不能越过的证据边界。
真实 provider 的历史 402 是仓库记录，不代表本次检查了账户当前余额或凭据状态。

### 5.1 外部阻塞

| ID | 未验证事项与必要证据 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-EXT-01 | 真实讲解、图片识别、标签、嵌入、手写转写、估分、诊断、变式需可用模型及人工金标；历史文本调用 402，无视觉/嵌入可用验证。 | [S16] §4；[S18] §7；[S19] §7；[S21] §5；[S22] §7 | A36/B04/B05/B07/C02 | not verified | High |
| R-EXT-02 | 用户实际经过 ≥24h 完成 C 及长期学习效果需要真实时间和观察；注入时钟仅证明边界逻辑。 | [SA] A30；[S22] §7 | A30/A31/C08 | not verified | High |
| R-EXT-03 | 真实试卷、大纲、评分细则与答案使用范围需提供并人工核对，版式/周期/封存/校准夹具不能冒充真实材料质量。 | [SA] §3；[S20] §5；[S22] §7 | A07/B01/B02/C01/C03/C08 | not verified | High |
| R-EXT-04 | 目标服务器、域名、受信任证书及生产资源/网络条件尚无实测部署证据，本机 Compose 不替代生产验收。 | [SR] §7；[S24] §7 | A01/A02/A35 | not verified | Med |
| R-EXT-05 | GitHub Actions 未实际推送触发，当前仅有本机运行同脚本/干净导出门禁证据。 | [S17] §4；[S24] §7 | — | not verified | Med |

真实 AI 成功验收必须同时有调用确实成功、内容产出、版本/用量审计和人工质量核验；一次真实 HTTP 错误仅证明失败路径诚实。
迁移到 DSH 后使用宿主模型能力也不能自动清除上述未验证状态；需按具体文本、视觉、嵌入能力分别补证。

### 5.2 不属于“只有外部阻塞”的已知缺口

| ID | 未验证或缺失的具体边界 | 来源 | 原编号 | 状态 | 敏感度 |
|---|---|---|---|---|---|
| R-GAP-01 | SSE 真实多进程飞行中轮询、并发重连与 finalize 事务竞争没有并发验证。 | [S19] §7 | B08 | not verified | High |
| R-GAP-02 | 考试到期命令/读路径已实现，但真实 beat 无人访问到期清理调度未运行。 | [S22] §7 | C05 | not verified | High |
| R-GAP-03 | 报告 1000 条上限的逐条污染查询未做大样本压测，不能从列表 N+1 优化外推报告性能。 | [S22] §7；[S24] §6 | C06/C08 | not verified | Med |
| R-GAP-04 | 过期 processing 行并发扫描可能重复投递，消费者租约/幂等保护已存在，但该并发投递窗口无专项测试。 | [S24] §6.3 | A24 | not verified | High |
| R-GAP-05 | 派发记录提交后、broker 调用前 dispatcher 被杀的窗口尚未单独故障注入。 | [S24] §6.4 | A24 | not verified | High |
| R-GAP-06 | 同 created_at 会话缺少次级排序键，当前结果集合/字段相同但顺序可与优化前不同。 | [S24] §6.1 | — | not verified | Med |
| R-GAP-07 | KaTeX 运行时正确性已有人工执行探针，但尚未固化到常设浏览器回归。 | [S24] §6.2 | A27 | not verified | Med |
| R-GAP-08 | 无吞吐压测、真实网络首屏或生产规模延迟统计，现有查询数/字节/局部耗时不构成端到端性能验收。 | [S24] §6.5 | — | not verified | Med |

明确未实现项另见 R-IMPORT-12（扫描 OCR）、R-IMPORT-13（图像旋转/裁剪交互）、R-SEAL-06（导出）、R-SEAL-07（家族成员清单）。
规格保留但未取得完整实现/验证依据的增强见 R-PLAN-07、R-SEC-07、R-DEGRADE-04；不以“规划全部完成”覆盖这些具体限制。
本次静态复核新增的契约差异还包括 R-QB-10、R-GRADE-13、R-EVID-05/10、R-PLAN-02/08/09/10、R-REPORT-10/11、R-AUTH-05；这些不是外部凭据阻塞，详见 §6 D26–D33。

## 6. 文档冲突、不一致与本清单处理原则

下表显式保留差异；本次不修改其他文档，也不通过选择有利表述消除真实限制。
“历史快照”表示时间点不同，并不自动意味着代码错误；“机制差异/缺口”需要迁移时作出明确决定或补证。

| 编号 | 文档差异 | 核实依据与处理 |
|---|---|---|
| D01 | [S00] 首版单考试、先客观题；[SH]/[S01] 首版多项目和全题型。 | 用户覆盖范围明确；本清单采用多项目、五类叶子题与材料父题。 |
| D02 | [SH] 及多份 P0 handoff 禁止进入 P1/P2；[S17]/[S22] 已交付后续批次。 | 前者是当轮修复范围，当前迁移不得回退已交付 P1/P2。 |
| D03 | [S02] PostgreSQL 17；[SR] §2/[SI] §0 实测 16.15。 | 16.15 是记录中的实测环境；不能声称 17 已同等实测，也不在本次更换数据库。 |
| D04 | [S02] “精确依赖尚未安装/未生成骨架”；[SR]/[SI] 已有运行环境及实现。 | 设计期措辞过时；现有源码和后续交付证明骨架已实现。 |
| D05 | [S02] 规划 py-fsrs；[S18] §4 使用纯 Python FSRS-4.5。 | `backend/domain/memory/fsrs.py` 为 `fsrs-4.5-default-v1`，保存该算法/参数身份，不冒称 py-fsrs 或最新版。 |
| D06 | [S02] 规划 pgvector/PG 关键词索引；实际检索为 JSON embedding + Python 打分。 | `backend/apps/search/models.py` 的 embedding 是 JSONField，`services/hybrid.py` 在过滤候选上算 BM25/余弦/RRF；未证明 pgvector 已集成。 |
| D07 | [S02]/[S00] 示例 `services/*`、AI validators/workflows 等；实际路径不同。 | 评分在 `backend/domain/grading`，证据/计划在 `backend/apps/learning/services`，校验在 `backend/ai/prompts/registry.py`；空占位目录不是实现。 |
| D08 | [SI] 正文仍写 84 路由、10 业务模块；[SR] 目录已含 memory/search。 | 这些是 P0 快照；不把 84 当当前 API 总数，源码映射包含新增模块且本次未运行 OpenAPI 计数。 |
| D09 | 同一 README/状态/验收文件同时有 119/164/177/194/203/226/316/340/366/396/489/501 等后端数量。 | 各轮历史数量；最新 [S24] 为 501（489+12），不能相加，也不把“最近一次 177”的旧正文当当前基线。 |
| D10 | 浏览器有 desktop/mobile 各 8、30/36/48/58/62/66/72/78 及 stub 数量。 | 最新主套件 78、stub 8、归档 2 分开；86 个收集用例不是 86 个真实模型验证。 |
| D11 | [SI] §7 仍写 Compose 实际启动未完成；[SI] §0、[SR] §7、[S24] §7 已本机全栈通过。 | 采用后续本机 TLS/迁移/登录证据；远程服务器与真实证书仍未验证。 |
| D12 | [SI] §3/§4/§5 仍写复杂导入、模拟考试、手写识别、校准未开始。 | 后续 [S19]–[S22] 覆盖已交付部分；复杂扫描 OCR 仍不存在，不能整体改成全支持。 |
| D13 | [S17]/[SI]/[SA] 摘要“只剩外部阻塞/所有 A 关闭”；A36 和细节限制并未完成。 | A36 真实模型保留未验证；§5.2 收录内部并发、调度、接口与性能缺口。 |
| D14 | [SA] A36 表写“没有凭据、未运行”；[S16] §4 已实际调用并收到 HTTP 402。 | 真实文本请求已发起但无内容产出，不能算成功；真实视觉调用仍未做。 |
| D15 | [S01] P2 复杂扫描/公式表格批量解析；[S05] C01 已交付；[S20] 明确无 OCR。 | 已交付的是原生文字版式检测、部分重排/跨页和人工门禁，不是自动扫描识别完整能力。 |
| D16 | [S05] C03 包含导出；[S21] 明确当前没有导出接口。 | 仅存在未来导出用 sealed_exclusions 契约；家族成员清单也明确缺失。 |
| D17 | [S05] C07 写“受限进程”；[S22] 证明的是白名单解析器/预算/静态检查。 | 不宣称已有独立沙箱进程；保留安全行为要求，运行边界的机制差异单独说明。 |
| D18 | [S03] §8.3 设计 `/mock-exams` 与整卷结束后一次性评分；实际复用 practice session。 | `backend/apps/practice/services/sessions.py`/`attempts.py` 使用 mock_exam 模式及逐题持久化评分，用户反馈在结束前隐藏；不能误写为完全照搬设计路由/执行时机。 |
| D19 | [S02] SSE 事件 progress/validated_section；[S03] `/events`；[S19] 实际 status/segment/done 与 `/stream`、`/segments`。 | 迁移保留“校验后投递、可重连、零重复调用”，接口名称以实际实现为追溯依据。 |
| D20 | P0.2 handoff 的 B01–B07/C01–C05 与 [S05] P1/P2 的同名编号含义不同。 | 本文裸 A/B/C 只指 [S05]；修复要求标 [HP02]/[HR]/[HF]，不能把 P0.2 C01 重放门禁误作 P2 C01 PDF。 |
| D21 | [S24] 摘要“响应逐字节不变”；§6.1 承认同 created_at 排序不同。 | 正常夹具结果一致；并列时间戳是公开例外，列 R-GAP-06。 |
| D22 | [S24] “归档反例原样通过”与另一个原始 P0 文件仍有 1 failed。 | 通过的是 p01 11、p02 9(+1 deselected)、p02-final 3；`docs/review/2026-09-27/test_p0_regressions.py` 为 1 failed/13 passed，优化前后相同，迁入正式副本通过。 |
| D23 | [S05] 至少 30 叶子题；演示记录 36 发布版本/33 叶子+3 材料；恢复记录 324 versions。 | 验收最小数量、演示夹具数量和当时备份集不同；不据此推断题目丢失或现库总数。 |
| D24 | [S03] 可选优先级公式/真实数据校准；[S22] 标“效果校准交付”。 | 当前 planner 为类别/前置排序，calibration 为只读分组统计；没有据此证明自动调参或提分预测实现。 |
| D25 | [S18] 金标报告称 recall@5/@10；归档文本和 JSON 的 k 参数不同。 | `docs/review/2026-09-27/p1-batch2/search-eval.txt` 为 k=[5,10]，`search-eval.json` 为 k=[10]；不否定文本结果，但两文件不是完全同参数输出，均非真实向量验证。 |
| D26 | [S03] §6/[SA] A42 声称整题余额再分配；代码仅逐项目排题。 | `backend/apps/learning/services/planner.py` 的 generate_plan 没使用 _plan_project 返回的 remaining 做共享再分配；A42 对应测试只检查预算/轮换，没有断言 2 分钟题真正入计划，R-PLAN-02 降为未验证。 |
| D27 | [SI] §5 声称未诊断预留及刷新保留；实际只计算 reserve、保留旧行。 | planner 的 reserve 不限制前序消耗，新 plan 未关联/扣除旧进行中和完成项，普通题无统一跨类别/刷新重复上限；见 R-PLAN-08/09/10。 |
| D28 | [S03] §5.2/[SI] §5 写“最近严格独立尝试”；实际窗口按维度行和 computed_at。 | `backend/apps/learning/services/state.py` 未过滤窗口行的辅助/污染排除原因，`evidence.py` 对不合格尝试也生成该维度行；保留需求而不宣称该窗口已严格实现。 |
| D29 | [S03] §7 要求大纲适用/争议映射过滤、跨版本可比和缺失周期；[S16] 的实现范围较窄。 | `backend/apps/analytics/services/cycles.py` 只按已登记试卷/科目分组、取最新映射；未见上述过滤、跨大纲分组或完全缺年生成，见 R-REPORT-10/11。 |
| D30 | [S02]/[S03] 要求显式授权的他人复核；现代码仅有 staff+非本人判定。 | `backend/apps/common/scope.py` 的 is_reviewer_of 未查授权关系，`backend/apps/practice/api.py` 确认评分先 require_project(owner)；本人自评已验证不代表跨 owner 复核完整，见 R-AUTH-05。 |
| D31 | [S03] §1 要求发布大纲不可原地改；P1 考点编辑直接更新节点。 | `backend/apps/knowledge/services/outline.py` 更新原节点并写 ContentRevision；`backend/tests/integration/test_p1_cycle_and_syllabus.py` 在已发布大纲下允许改父。审计存在不等于旧大纲快照完整不可变，见 R-QB-10。 |
| D32 | [S01] §7/[S03] §5.2 要求确认诊断后才说“需要补基础”；状态投影可由错误证据直接触发。 | `backend/apps/learning/services/state.py` 的 confirmed_gap 检查 is_correct=False、维度和 grade_event，不查询已确认诊断；见 R-EVID-10。 |
| D33 | [S03] §4.2 包含评分依赖；模型字段与评分执行不是同一层保证。 | `backend/apps/question_bank/models.py` 验 depends_on ID 存在；`backend/apps/practice/services/attempts.py` 的 _confirm_rubric_parts 只逐项验必填、分数范围和刻度，没有依赖给分分支，见 R-GRADE-13。 |

关于测试诚实性：[S24] 的 p02 `1 deselected` 源于历史 generation 歧义迁移反例处理，不能改写成该组“10/10 原样通过”。
关于模型名称：“DeepSeek 开发交接”不等于产品只能用 DeepSeek；DSH 宿主也不能凭名称宣称具备视觉/嵌入能力。[S01] §8。

## 7. 实现与测试追溯矩阵

路径均经只读文件盘点；花括号是多个实际文件的缩写，不是额外虚构目录。
表内测试路径表示可查阅的证据资产，不表示本次执行；运行结果以 [SA]、各交付记录和 [S24] 为准。
`backend/tests/evaluation/` 当前仅有 `__init__.py`，不能把它写成已经运行真实模型评测集的证据。

### 7.1 后端、前端与正式测试

| 需求组 | 后端实际模块/文件 | 前端实际特性/文件 | 正式测试证据 |
|---|---|---|---|
| PROJ | `backend/apps/exams/{models,api}.py`；`backend/apps/exams/services/core.py`；`backend/apps/accounts/services/settings.py` | `frontend/src/features/projects/HomePage.tsx`；`frontend/src/features/settings/SettingsPage.tsx`；`frontend/src/app/context.tsx` | `backend/tests/integration/test_practice_flow.py`、`test_isolation_and_idempotency.py`、`test_p0_2_closeout_gaps.py` |
| IMPORT：文字/图片/校对 | `backend/apps/ingestion/{models,api,storage}.py`；`backend/apps/ingestion/services/{core,imports,text_parser,extraction,access}.py`；`backend/ai/providers/base.py` | `frontend/src/features/imports/{ImportsPage,CandidateReviewPage}.tsx` | `backend/tests/unit/test_content_and_parsing.py`；`backend/tests/integration/test_isolation_and_idempotency.py`、`test_p0_regressions.py`、`test_p0_2_regressions.py` |
| IMPORT：PDF/版式 | `backend/apps/ingestion/services/{pdf_text,layout,text_parser,imports,core}.py` | `frontend/src/features/imports/{ImportsPage,CandidateReviewPage,LayoutReview}.tsx` | `backend/tests/integration/test_p1_pdf_import.py`、`test_p2_layout_import.py`；`backend/tests/support/pdf_builder.py`（夹具） |
| QB | `backend/apps/question_bank/{models,api}.py`；`backend/apps/question_bank/services/core.py`；`backend/apps/exams/services/core.py` | `frontend/src/features/questions/QuestionBankPage.tsx`；`frontend/src/features/imports/CandidateReviewPage.tsx` | `backend/tests/integration/test_isolation_and_idempotency.py`、`test_practice_flow.py`、`test_p1_pdf_import.py` |
| ANS | `backend/apps/practice/{models,api}.py`；`backend/apps/practice/services/{sessions,attempts,verification_gate}.py` | `frontend/src/features/practice/PracticePage.tsx` | `backend/tests/integration/test_practice_flow.py`、`test_isolation_and_idempotency.py`、`test_p0_2_final_gaps.py` |
| GRADE：规则/人工 | `backend/domain/grading/adapters.py`；`backend/apps/practice/services/attempts.py`；`backend/apps/common/{answers,content}.py` | `frontend/src/features/practice/{PracticePage,GradingPage}.tsx` | `backend/tests/unit/test_grading.py`；`backend/tests/integration/test_practice_flow.py`、`test_p0_regressions.py` |
| GRADE：重判 | `backend/apps/analytics/services/regrade.py`；`backend/apps/analytics/models.py`；`backend/apps/practice/services/attempts.py` | `frontend/src/features/practice/GradingPage.tsx`；`frontend/src/features/reports/ReportsPage.tsx` | `backend/tests/integration/test_isolation_and_idempotency.py`、`test_p0_2_regressions.py`、`test_p0_2_closeout_gaps.py`、`test_p0_2_final_gaps.py` |
| GRADE：受限表达式 | `backend/domain/grading/{expressions,adapters}.py` | `frontend/src/features/practice/{PracticePage,GradingPage}.tsx`（沿用填空与复核） | `backend/tests/unit/test_p2_expression_grading.py` |
| EXP | `backend/apps/practice/services/{exposure,verification_gate}.py`；`backend/apps/learning/services/contamination.py` | `frontend/src/features/questions/ExposurePanel.tsx`；`frontend/src/features/review/ReviewPage.tsx` | `backend/tests/integration/test_p2_contamination.py`、`test_isolation_and_idempotency.py`、`test_learning_loop.py` |
| EVID | `backend/apps/learning/services/{evidence,state,pairing,anchors}.py`；`backend/apps/learning/{models,api}.py`；`backend/apps/practice/models.py` | `frontend/src/features/knowledge/KnowledgePage.tsx`；`frontend/src/features/review/ReviewPage.tsx`；`frontend/src/features/today/TodayPage.tsx` | `backend/tests/integration/test_learning_loop.py`、`test_acceptance_ids.py`、`test_p0_2_regressions.py` |
| KNOW | `backend/apps/knowledge/services/{core,outline,relations,suggestions}.py`；`backend/apps/knowledge/{models,api}.py`；`backend/ai/prompts/registry.py` | `frontend/src/features/knowledge/KnowledgePage.tsx` | `backend/tests/integration/test_p1_cycle_and_syllabus.py`、`test_p1_prerequisites_and_tags.py`、`test_p1_api.py` |
| SEARCH | `backend/apps/search/services/{index,tokenize,vector,hybrid}.py`；`backend/apps/search/{models,api}.py`；`backend/ai/providers/embeddings.py` | `frontend/src/features/search/SearchPage.tsx` | `backend/tests/unit/test_search_tokenize.py`；`backend/tests/integration/test_search_hybrid.py`；`backend/apps/search/management/commands/search_eval.py` |
| MEM | `backend/domain/memory/fsrs.py`；`backend/apps/memory/{models,api}.py`；`backend/apps/memory/services/scheduler.py` | `frontend/src/features/memory/MemoryPage.tsx` | `backend/tests/unit/test_fsrs.py`；`backend/tests/integration/test_memory_cards.py`、`test_p1_memory_plan.py` |
| PLAN | `backend/apps/accounts/services/settings.py`；`backend/apps/learning/services/planner.py`；`backend/apps/learning/api.py`；`backend/apps/practice/services/mistakes.py` | `frontend/src/features/today/TodayPage.tsx`；`frontend/src/features/review/ReviewPage.tsx`；`frontend/src/features/settings/SettingsPage.tsx` | `backend/tests/integration/test_learning_loop.py`、`test_p1_memory_plan.py`、`test_p1_prerequisites_and_tags.py` |
| REPORT：周期 | `backend/apps/analytics/services/cycles.py`；`backend/apps/exams/services/core.py`；`backend/apps/analytics/api.py` | `frontend/src/features/reports/ReportsPage.tsx` | `backend/tests/integration/test_p1_cycle_and_syllabus.py`、`test_p1_api.py` |
| REPORT：练习/范围 | `backend/apps/analytics/services/reports.py`；`backend/apps/analytics/{models,api}.py`；`backend/apps/practice/services/verification_gate.py` | `frontend/src/features/reports/ReportsPage.tsx` | `backend/tests/integration/test_learning_loop.py`、`test_p2_reports_scope_and_calibration.py` |
| EXAM | `backend/apps/practice/services/{sessions,verification_gate}.py`；`backend/apps/practice/{models,api}.py`；`backend/apps/practice/management/commands/expire_mock_exams.py` | `frontend/src/features/practice/PracticePage.tsx`；`frontend/src/features/today/TodayPage.tsx` | `backend/tests/integration/test_p2_mock_exam.py` |
| CAL | `backend/apps/analytics/services/calibration.py`；`backend/apps/analytics/api.py` | `frontend/src/features/reports/CalibrationPanel.tsx` | `backend/tests/integration/test_p2_reports_scope_and_calibration.py` |
| AI：provider/辅导 | `backend/ai/providers/base.py`；`backend/ai/prompts/registry.py`；`backend/apps/tutoring/services/core.py`；`backend/apps/tutoring/{api,tasks,models}.py` | `frontend/src/features/practice/{PracticePage,AiAssistPanels}.tsx`；`frontend/src/features/settings/SettingsPage.tsx` | `backend/tests/integration/test_ai_providers.py`、`test_p0_regressions.py`、`test_p0_2_regressions.py`、`test_p0_2_final_gaps.py` |
| AI：转写/估分/诊断 | `backend/apps/practice/services/{transcription,estimation,diagnosis}.py`；`backend/apps/practice/{models,api}.py`；`backend/ai/prompts/registry.py` | `frontend/src/features/practice/{AiAssistPanels,GradingPage}.tsx` | `backend/tests/integration/test_p1_transcription_and_estimation.py` |
| AI：SSE | `backend/apps/tutoring/services/streaming.py`；`backend/apps/tutoring/{models,api}.py` | `frontend/src/features/practice/AiAssistPanels.tsx`；`frontend/src/api/tutorStream.ts` | `backend/tests/integration/test_p1_tutor_stream.py` |
| VAR | `backend/apps/question_bank/services/variants.py`；`backend/ai/prompts/registry.py`；`backend/apps/ingestion/{api.py,services/core.py}` | `frontend/src/features/questions/VariantProposePanel.tsx`；`frontend/src/features/imports/VariantsList.tsx` | `backend/tests/integration/test_p2_variants.py` |
| SEAL | `backend/apps/question_bank/services/{sealing,families}.py`；`backend/apps/question_bank/{models,api}.py` | `frontend/src/features/questions/SealingControls.tsx`；`frontend/src/features/knowledge/FamiliesPanel.tsx` | `backend/tests/integration/test_p2_sealing_and_merge.py`、`test_search_hybrid.py`、`test_p2_contamination.py` |
| AUTH | `backend/apps/accounts/{models,api,views}.py`；`backend/apps/accounts/management/commands/create_account.py`；`backend/apps/common/{api,scope}.py` | `frontend/src/app/AppRoot.tsx`（登录）；`frontend/src/api/client.ts`；`frontend/src/features/settings/SettingsPage.tsx` | `backend/tests/integration/test_practice_flow.py`、`test_api_contract.py`、`test_isolation_and_idempotency.py` |
| AUD | `backend/apps/audit/{models,middleware}.py`；`backend/apps/audit/services/idempotency.py`；`backend/apps/tutoring/services/core.py`；`backend/apps/practice/management/commands/audit_projection_semantics.py` | `frontend/src/features/settings/SettingsPage.tsx`（AI 配置）；`frontend/src/features/reports/ReportsPage.tsx`（AI 调用）；各特性的修订/暴露视图 | `backend/tests/integration/test_ai_providers.py`、`test_api_contract.py`、`test_p0_2_regressions.py`、`test_p0_2_closeout_gaps.py` |
| ASYNC | `backend/apps/audit/services/outbox.py`；`backend/apps/audit/{models,tasks}.py`；`backend/apps/tutoring/tasks.py`；`backend/config/celery.py` | `frontend/src/features/imports/ImportsPage.tsx`、`frontend/src/features/practice/AiAssistPanels.tsx`（状态/恢复；没有独立队列管理页） | `backend/tests/integration/test_outbox_contract.py`、`test_outbox_dispatch_lease.py`、`test_p0_2_closeout_gaps.py`；`scripts/verify_worker_e2e.py` |
| SEC/CONS/DEGRADE | `backend/apps/common/{scope,content,answers,errors,api}.py`；`backend/apps/ingestion/{storage.py,services/access.py}`；`backend/apps/audit/services/idempotency.py`；`backend/config/settings/{base,prod}.py` | `frontend/src/api/client.ts`；`frontend/src/components/Content.tsx`；全部受保护特性 | `backend/tests/integration/test_api_contract.py`、`test_isolation_and_idempotency.py`、`test_ai_providers.py`、`test_acceptance_ids.py` |
| PERF | `backend/apps/question_bank/api.py`；`backend/apps/practice/api.py`；`backend/apps/audit/services/outbox.py` | `frontend/src/app/AppRoot.tsx`；`frontend/src/components/Content.tsx`；`frontend/vite.config.ts` | `backend/tests/integration/test_read_path_query_budget.py`、`test_outbox_dispatch_lease.py`；`frontend/src/components/Content.test.tsx`；[S24] 探针 |
| OPS | `backend/config/settings/{base,dev,test,prod}.py`；`infra/docker/`；`infra/proxy/nginx.conf.template`；`scripts/{backup,restore,verify_proxy}.sh` | 无专门运维 feature；同源前端产物/登录链路参与验证 | `backend/tests/integration/test_api_contract.py`；[SR] §5 恢复记录；[S24] §7 发布门禁；`.github/workflows/ci.yml`（远程未运行） |

`backend/domain/evidence/`、`backend/domain/planning/`、`backend/ai/validators/` 只有空占位 `__init__.py`；不能因目录名存在而把需求错误分配给它们。
账户入口不在 features/accounts，封存 UI 跨 questions/knowledge，模拟考试复用 practice；新插件拆分应依据实际职责和不变量而非旧建议目录。

### 7.2 浏览器、归档反例与可重放证据

| 范围 | 证据路径 | 能证明什么/不能证明什么 |
|---|---|---|
| P0 五题型、多项目、空账户与回归 | `frontend/tests/acceptance/p0-acceptance.spec.ts`、`p0-2-regressions.spec.ts`、`p0-2-empty-account.spec.ts` | 实际 UI/网络载荷断言；不等于真实模型/学习效果。 |
| P1 PDF/周期 | `frontend/tests/acceptance/p1-import-and-cycles.spec.ts` | 文本 PDF 与人工覆盖确认。 |
| P1 前置/标签/搜索/记忆卡 | `frontend/tests/acceptance/p1-batch2.spec.ts` | 操作流程与失败说明；真实向量质量仍未验证。 |
| P1 转写/估分/SSE | `frontend/tests/acceptance/p1-batch3.spec.ts` | 主套件与 @stub 分开；没有真实多进程流式竞争证据。 |
| P2 版式/污染 | `frontend/tests/acceptance/p2-batch1.spec.ts` | 生成 PDF 夹具版式与校对门禁；不代表真实扫描 OCR。 |
| P2 封存/家族/变式 | `frontend/tests/acceptance/p2-batch2.spec.ts` | 受控合并与候选流程；真实生成质量未验证。 |
| P2 考试/报告/校准 | `frontend/tests/acceptance/p2-batch3.spec.ts` | 截止时间、零反馈、缺失范围和分组展示。 |
| P0.1/P0.2 归档反例 | `docs/review/2026-09-27/p01-independent/`、`p02-independent/`、`p02-final-independent/` | 后续每轮追踪 11 / 9(+1 deselected) / 3；不要混淆为新实现测试总数。 |
| 真实 Worker 故障 | `scripts/verify_worker_e2e.py`；`docs/review/2026-09-28/optimization/logs/25-gate-worker-drill.json` | 已记录 SIGKILL/FLUSHALL/重复消费恢复；不覆盖 §5.2 所有细分窗口。 |
| 优化独立复验 | `docs/review/2026-09-28/optimization/README.md`、`probes/`、`logs/` | 查询数、响应一致性、包体、公式运行时探针及本机发布门禁。 |
| 真实 AI 历史失败 | `scripts/verify_real_ai.py`；`docs/review/2026-09-27/p1-batch/real-ai-provider.json` | 请求被 HTTP 402 阻断且无内容产出；不是 A36 成功证据。 |

最新已记录门禁为后端 501 passed/0 failed/0 skipped，浏览器主套件 78、stub 8、归档浏览器 2，Vitest 5，真故障演练 ok=true，本机 component/full-stack 均 exit 0。[S24] §5/§7。
这些结果保留为迁移前对照；迁移后要对 High 项重新证明等价，不能沿用旧测试数量宣称 Node/Cordis 插件已验收。

## 8. 迁移验收时应保持的事实边界

本节汇总前述需求的应用方式，不增加独立功能或把未验证项改成通过。

- 数据迁移要保留题目/答案/rubric/规范/映射的冻结引用、原始作答、评分修订、内容谱系、暴露时间、任务触发和模型审计，见 R-INV-01/04/08。
- TypeScript 不能用普通浮点替代正式分值 Decimal，也不能把 false、null、待评、零分和缺失合并，见 GRADE、CONS、REPORT。
- 同一事实集重算必须保留独立资格、延迟边界、家族失效、预算轮换与 FSRS 日志结果；更换算法要显式新版本，见 EVID、PLAN、MEM。
- DSH 的模型工具、流式事件和后台任务须经过同样的权限/用途/版本/租约门禁；宿主能调用模型不等于允许直接写分数或计划，见 AI、SEC、ASYNC。
- 对当前未提供的扫描 OCR、内容导出、家族成员清单、真实 provider/时间/材料/远程 CI，不得在插件文案中写成迁移前已完成，见 §5。
- 本文只新增需求清单，未修改旧规格、实现、测试、配置、锁文件或任何业务数据。

[S00]: ../00-original-requirements.md
[S01]: ../01-product-spec.md
[S02]: ../02-architecture.md
[S03]: ../03-domain-and-api.md
[S05]: ../05-acceptance.md
[SH]: ../../DEEPSEEK_HANDOFF.md
[HP0]: ../../DEEPSEEK_P0_FIX_HANDOFF.md
[HP02]: ../../DEEPSEEK_P0_2_FIX_HANDOFF.md
[HR]: ../../DEEPSEEK_P0_2_REMAINING.md
[HF]: ../../DEEPSEEK_P0_2_FINAL_GAPS.md
[S16]: ../16-p1-first-batch-delivery.md
[S17]: ../17-remaining-plan-to-completion.md
[S18]: ../18-p1-second-batch-delivery.md
[S19]: ../19-p1-third-batch-delivery.md
[S20]: ../20-p2-first-batch-delivery.md
[S21]: ../21-p2-second-batch-delivery.md
[S22]: ../22-p2-third-batch-delivery.md
[S24]: ../24-code-optimization-delivery.md
[SI]: ../implementation-status.md
[SA]: ../acceptance-results.md
[SR]: ../../README.md
