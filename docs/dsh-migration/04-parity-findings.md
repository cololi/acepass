# 04 对拍发现（Python 实现 ↔ Node 实现）

对拍方法：用 **Python 源码**生成黄金向量（`dsh-plugin/scripts/gen_*_golden.py` → `tests/golden/*.json`），Node 实现必须逐位一致。
**黄金向量的真相源是 Django 实现的实际行为，而不是文档。** 下列条目是对拍过程中发现、并按"现状等价"原样移植的差异或缺陷。
它们**没有**被悄悄修复；是否修复应单独立项（修复会改变已存储评分的可复现性）。

## A. Django 实现中的真实缺陷（已按现状复现，待单独决策）

| ID | 位置 | 现象 | 影响 | 建议 |
|---|---|---|---|---|
| KNOWN-1 | `domain/grading/adapters.py::grade_constructed_response` | `rubric.criteria` 为**非空字符串**（或非空非列表的真值）时，`if not criteria` 为假，随后遍历得到 0 个 dict 评分点 → 结果 `status=void`、`parts=[]`、`pending_max_score=0` | 大题被判为"无效"而非"待评"。`void` 在 `_finalize` 里计入 pending，但这个结果没有任何可确认的评分点，人工无法逐点确认 | 在 rubric 校验层拒绝非列表 `criteria`（应在发布时拦截），并让 `grade_constructed_response` 对非列表返回 `_pending_all`。需补一个反例测试 |
| KNOWN-2 | `apps/learning/services/planner.py::allocate_budget` | 用户把每个项目的预算比例都设为 0 时，函数先记下「本日不分配任何项目时间」，随后最大余数分配仍给**每个**项目各 1 分钟（余数循环不跳过 0 份额项目） | 计划里出现「说好不分配却仍有 1 分钟」的项目；`allocated_minutes` 与实际任务分钟数可能对不上 | 余数循环跳过 `percent <= 0` 的项目；或在合计为 0 时直接返回全 0。改前需评估已生成计划的可复现性 |

## B. 有意的、方向安全的差异（Node 比 Python 更严格 → 转人工）

| ID | 内容 | 方向 |
|---|---|---|
| DIV-1 | 非 ASCII 十进制数字（如阿拉伯-印度数字 `١٢`）：Python `\d`/`float()`/`Decimal()` 接受，Node 拒绝 | 拒绝 = 转人工复核（安全方向）。已在 `decimal.test.ts` 与 `expressions.ts` 头部声明 |
| DIV-2 | `Decimal('NaN'/'Infinity'/'sNaN')` 不解析，抛 `invalid` | Python 会产出特殊值；评分路径上这些值只会来自畸形规则，拒绝即转人工 |

## C. JS 特有风险（Python 没有，已加防护和测试）

| ID | 风险 | 防护 |
|---|---|---|
| JS-1 | 变量名/空位 ID 命中 `Object.prototype`（`constructor`、`__proto__`、`toString`…） | 一律 `Object.hasOwn` 取值；`Object.create(null)` 作绑定表；`grading.test.ts` / `expressions.test.ts` 有专项用例 |
| JS-2 | 数值精度：Python float 与 JS number 同为 IEEE-754 双精度，但格式化不同 | `pyfmt.ts` 复刻 `repr(float)`、`format(x,'g')`；LCG 采样用 BigInt（`1103515245*state` 超过 2^53） |
| JS-3 | `eval`/`Function`/`vm`/动态 import | `expressions.test.ts` 对源文件做**静态扫描**，出现即失败 |
| JS-4 | `Number#toFixed` 把半数从零进位，CPython 用**精确二进制值 + 半数到偶** | `pyfmt.ts::pyFormatFixed` 用 BigInt 精确重构 + 半数到偶；1600 组随机/边界值与 `format(x,'.Nf')` 逐个一致 |

## D. 当前对拍覆盖（可复现：`npm run golden && npm run verify`）

| 模块 | 向量数 | 比对内容 |
|---|---|---|
| `fsrs.ts` | 184 条序列 / ~3000 步 | R、interval、phase、lapse、S、D、learning_step、`due_at`（微秒） |
| `expressions.ts` | compare 115 · normalize 190 · evaluate 33 · 采样网格 | 判定三态、错误类别、reason 文本、规范化字符串、采样点 |
| `decimal.ts` | 二元 2500 对 + 小整数 400 + quantize 400 + 解析 26 | `str(Decimal)`（含指数）、舍入、溢出/除零/无效操作 |
| `grading.ts` | **4883** 个完整 `grade()` 案例 | 状态/分数/各 part/detail/notes/`rule_snapshot`/`confirmed_fraction` |
| `contamination.ts` | 11 组真实行场景（真实 expose 台账/会话项/家族/谱系入库） | `seen`/`reasons`/`first_seen_at`/`sources`/`strict_independent_eligible`/`exclusion_reasons`（含证据行 id 与时刻） |
| `anchors.ts` | 4 组真实行场景 | 锚点时刻与来源；无锚点返回 `(None, "")` |
| `evidence.ts` | 609 条规则函数向量 + **24 条真实行场景** | 6 个维度 × 全部字段/排除原因/detail；两层对照（内存假对象图 + 真实库行） |
| `state.ts` | 288 条规则向量 + 6 条真实行序列（12 步） | summary/best_summary/计数/recent 窗口/needs_review/downgrade_reason/missing_evidence/source_evidence_ids |
| `pyfmt.ts` | **8200** 条 `format(x, '.Nf')` 向量（1640 值 × 0/1/2/3/6 位）+ 5 条定点回归 | 精确二进制值、半数到偶、非有限值打印 |
| `planner.ts` | 22 组预算切分 + 12 组题时估算 + `next_day`/`plan_delta_minutes` | 项目顺序（目标日期→创建时间→轮转偏移）、余数分配、百分比合计与提示文案、`round(x,4)`/`round()` 半数到偶 |

**不在黄金向量内（用性质测试替代）**：墙钟时间预算（`time_budget`）——`budget=0/负数/NaN/inf` 必为 `unknown/timeout`，过期预算不得产出 `equivalent`。

两个运行时均通过：系统 Node 24.18 与 **DSH 自带 Electron 44.7 / Node 24.21**（以后者为准）。

## E. 迁移期发现并已修复：`pyFormatFixed` 的尾数掩码错误

`pyfmt.ts` 原有实现从 IEEE-754 位模式重取尾数时用了 `hi & 0xffff`，而尾数高 20 位在 `hi & 0xfffff`。
少取 4 位会让 `2.625` 这类值算成 `2.00`（而不是 `2.62`）。此前没有测试覆盖到该分支，所以一直没暴露。
**已修复**，并落成可复现的对拍：`npm run golden:pyfmt`（`scripts/gen_pyfmt_golden.py` → `tests/golden/pyfmt.json`）
用 1640 个值（40 个边界值 + 1600 个随机值，覆盖次正规数、`1e300`、`2**53`、`0.1+0.2`、`inf`/`nan`）
× `places` 0/1/2/3/6 = **8200 条向量**与 CPython `format(x, '.Nf')` 逐个比对，`tests/pyfmt.test.ts` **0 处不一致**；
另有 `2.625 / 1.005 / -0.005 / -0.0 / 0.1+0.2` 的定点回归用例。这类"只在若干数值上错"的格式化 bug
不会被场景向量抓到，所以 `pyfmt` 的对拍必须是穷举式的；此前的"1600 组"只在临时脚本里跑过、没有进仓库，
**不能算已验证**——现在才算。

## F. 事实边界（移植时容易踩的契约细节）

1. **`source_evidence_ids` 的顺序来自查询返回顺序**：原实现 `LearningEvidence.objects.filter(...)` 没有 `ORDER BY`，
   `[str(row.id) for row in independent + delayed]` 因此是数据库自然顺序。编排层（阶段 2 的 store）必须保持同一顺序；
   黄金向量按"真相库自然顺序"冻结，若某天加了排序，必须显式改写这条基线而不是让它悄悄变化。
2. **无锚点时 `anchor_source` 是空串，不是 `"none"`**：`latest_learning_anchor` 返回 `(None, "")`，`detail.anchor_source` 存 `""`。
   证据投影的入参若把"无锚点"归一化成 `null`，detail 会印出 `"none"` → 与 Django 输出不一致。
   本仓库的做法是显式传 `{ at: null, source: "" }`，并用真实行场景锁住。
3. **`sameTemplateOtherQuestion` 是"每尝试一个布尔值"**：Python 在**每个**考点映射里单独查询同模板的其他独立正确。
   若一次作答映射到多个考点、且各考点模板不同（主权重考点 + 辅助标签考点可能出现），单一布尔值无法表达。
   `gen_evidence_golden.py` 现在遇到这种夹具会**直接报错**而不是随机挑一个；等阶段 2 的 store 真正接多模板时，
   必须把它改成 `Record<nodeId, boolean>`，并重新生成黄金向量。
16. **领域值不能直接 `JSON.stringify`**：`Instant` 是 BigInt → 抛 "Do not know how to serialize a BigInt"，`Decimal` 是类实例 → 会被摊成内部字段。HTTP 层必须显式转线上形态（instant→ISO 文本、decimal→字符串）。本仓库里 BigInt 只可能是 `Instant`（id 是字符串、计数是 number），转换是确定的而非猜测。
14. **外键图有环，单趟拓扑排序不存在**：`practice_attempt.current_grade_event_id` ↔ `practice_grade_event.attempt_id`、`question_bank_question.family_id` ↔ `question_bank_family`。导入必须**两阶段**：先把可空外键写 NULL 插行，全部插完再补写引用；`NOT NULL` 的外键若是环的一部分，就是任何顺序都装不进去，必须报错而不是留空。第一版贪心排序在遇到环时退化成按声明顺序，结果 `practice_session_item` 排在它的依赖之前，触发外键失败。
15. **对账摘要必须按"存储形态"算**：SQLite 里 datetime 是 ISO 文本、decimal 是文本、bool 是 0/1、JSON 是文本——和归档完全同形，只有 JSON 需要 `JSON.parse`。若先过仓储层 codec 再摘要，拿到的是 `Instant`/`Decimal` 对象，摘要必然不等。
13. **`Instant` 是微秒，`Date` 要毫秒**：算本地日期时除以 `1e6` 得到的是**秒**，`new Date(秒)` 会落到 1970 年。已改为 `/1000n`，并用跨时区用例（`2027-02-01T03:00Z` 在洛杉矶是 1 月 31 日）钉住。
11. **`findRows` 的 null 等值是个陷阱**：SQL 里 `col = NULL` 永不成立，所以按可空列过滤（如根节点的 `parent_id IS NULL`）会**静默匹配不到任何行**，调用方会误以为"没有这条记录"。仓储层已改为 null → `IS NULL`；这类错误不会抛异常，只会让业务以为数据不存在，属于最难发现的一类。
12. **词表同义名的合并是方向相关的**：`_find_existing` 只在**新行**的名字或别名命中已有节点时才合并，所以 `微分` 在前、`导数（微分）` 在后才会合并成一条；反过来会产生两个考点。按现状移植并用向量与测试钉住。
10. **延迟锚点是按考点解析的，不是每次作答一个值**：`_last_relevant_anchor(attempt, node_id, ...)` 在维度循环里**逐考点**调用，所以同一题映射到两个考点时可能得到两个不同锚点。`AttemptFacts` 原先只有单个 `anchor`，黄金向量因为都是单考点所以没暴露；现已加 `anchorFor(nodeId)`，`anchor` 仅作单考点简写保留。
8. **DSH 的 Fetch 注册表是精确路径**：`connection.fetch.register` 存进 `fetchRoutes` 后用 `fetchRoutes.get(url.pathname)` 取，**没有**参数段匹配。带 `:param` 的 REST 路径不能靠它挂载，因此 `/api/acepass/projects/:id` 这类路径改由 Remote 通道提供；静态路径仍用 Fetch 路由。
9. **幂等 claim 与副作用必须在同一事务**：Django 的 claim 提交在独立 savepoint 里，所以需要中间件显式 `release()`；本实现的 claim 与业务写入同属一个 `BEGIN IMMEDIATE` 事务，失败时回滚即释放。这不是简化而是更强的保证——但**不能**把 claim 挪出事务，否则失败请求会把键永久占住（有测试锁住）。
5. **`validate_content` 只有一个实现**：`src/ai/content.ts` 是移植后的唯一实现（对照 `apps/common/content.py`）。
   阶段 2 的发布门禁**必须 import 它**，不得在 store 里再写一份——两份实现即使都被 Python 向量钉住，也仍会各自漂移。
6. **能力常量只在 `src/llm/contract.ts` 定义一次**：`port.ts` 是 DSH 适配器、`ai/degrade.ts` 是纯降级表，两者都从这里取，
   避免"两处各有一份 `CAPABILITIES`"的漂移；`contract.ts` 不 import DSH，所以纯层与动作层都能安全依赖它。
7. **`ai_capability_unsupported` 相对 Python 的拆分是有意偏离**：Python 两处都回 `ai_not_configured`。
   测试同时锁住"Python 合并"与"Node 拆分"两个事实；接口/UI 层必须接受这个更细的状态。
4. **`hintBeforeSubmit` 的语义**：Python 的第二条查询独立于 `reveals_answer`，只按 kind 取
   `hint_delivered / answer_delivered / explanation_delivered`；"提交前获得过提示"这句原因只在**没有**答题类辅助时出现。
   事实包把它拆成 `answerRevealingKinds` 与 `hintBeforeSubmit` 两个字段，两者组合出的原因顺序与 Python 一致。

## G. 题库/家族面移植时钉住的契约细节（阶段 3 续）

这些不是缺陷，而是**照代码现状移植后**必须写测试钉住的语义；按直觉"顺手改好"就会与 Django 输出分叉。

| # | 事实 | 为什么要钉住 |
|---|---|---|
| G1 | `POST /question-versions/{id}/withdraw` 的 `reason` 是 **query 参数**（Django Ninja 对未声明为 Schema 的 `str` 默认按 query 解析），幂等指纹是 `{"reason": ...}`；发布（`publish`）的指纹固定为 `{}`，客户端 body 不参与 | 若把 reason 当 body 读，重放判定会与 Django 不同：同一 key 在 Django 里是"同请求重放"，在错误实现里会变成 409 |
| G2 | 题目列表的 `has_trusted_answer` 只看**当前已发布版本**上的 checked 且未争议答案；`knowledge_nodes` 只取 primary 映射的 `canonical_name`，顺序是查询返回顺序 | 草稿上的可信答案不算"可发布"；把 auxiliary 映射也算进去会让列表显示错误考点 |
| G3 | `GET /questions/{id}` 预览**会写曝光**（`stem_delivered`/`purpose=preview`/`source=question_detail`），并且封存内容拒绝预览 | 把它当纯读接口会让污染判定少一条"题干已下发"，后续"严格独立"证据被高估 |
| G4 | 家族合并的暴露规则是"**合并家族里任一成员已见，则整个家族已见**"；`merge_impact` 必须用与 merge 相同的 helper 预测 | 预览与结果不一致会让人在错误信息上签字；合并后不重算会让旧证据继续支撑"陌生变式" |
| G5 | 合并使证据失效时**只置 `is_active=false` 并写固定原因**，绝不删除；随后重算受影响考点状态（只算 `knowledge_node_id` 非空的行） | 删除会毁掉历史可复现性；不重算会让掌握状态继续引用已失效证据 |
| G6 | 题族列表按 `subject.display_order → name`；映射按 `mapping_revision → node.canonical_name`；题目列表按 `-created_at` | 三处都曾按单一列排序，名字排序会把不同科目交错，映射按 node_id 排序则与 Django 的考点名顺序不同 |
| G7 | `MappingIn` 的 schema 默认值是 `is_primary=True`、`score_weight=1`、`note=""`；服务层的 `asWeight(undefined)` 却是 0 | 路由必须先补默认值，否则省略 `score_weight` 的合法请求会被判成"权重合计不为 1" |

## H. ingestion 文本解析（B0）钉住的语义

| # | 事实 | 为什么要钉住 |
|---|---|---|
| H1 | Python 的 `\b` 是 **Unicode 词边界**：`选A项` 中字母 A 两侧都是汉字，没有边界，`parse_answer` 因此解析不出任何选项 | JS 的 `\b` 是 ASCII 词类，会把 `选A项` 读成 `A` 并且"答案已知"。本仓库用 lookaround 模拟 Python 的 `(?<![L N _])(...[L N _])`，测试显式锁住"未匹配到任何选项 ID" |
| H2 | 题号/标签正则里的 `\d` 是 Unicode `Nd`、`\s` 含 `\x1c-\x1f`/`\x85`/`\u3000`、`splitlines()` 还在 `\v`/`\f`/`\u2028`/`\r\n` 处断行 | 只按 `\n` 拆行或只认 ASCII 空白会让 segment 边界与 Python 不同，进而改变候选条数与 `source_excerpt` |
| H3 | 所有偏移与截断都是**码点**：`source_char_start/end`、`## 3 答案页` 的 `[:50]`、`source_excerpt[:1000]`、anchor `[:40]`、span `[:2000]` | emoji 前缀会让 UTF-16 下标相对码点偏移；类型为"来源页"的字段一旦错位，前端高亮与研读定位会整体偏一格 |
| H4 | `_page_for_offset` 在 offset 落在所有页区间之外时，返回**最后一页的页码**（`page_map[-1][0] if page_map else 1`），不是 `None` | 初版按"找不到就 None"实现，黄金向量立刻暴露；页码缺失会让来源区域无法关联 |
| H5 | `_parse_labelled` 里 `【题干】` 之后紧接 `【题型】` 会**关闭上一题**（`if section in {"stem","question_type"} and current.get("stem_text"): close_question()`），于是模板把题干与选项/答案拆成两个候选 | 这是 Django 现状（模板推荐的顺序是 `【题型】` 在前）。移植若"顺手修好"会让候选数量与发布结果与基线不同；黄金向量保留了这种输入并记录同一输出 |
| H6 | Ninja 的 body 校验错误在出线前去掉 `input`，`loc` 以 `body` 开头：缺字段是 `{type:"missing",loc:["body","text"]}`，类型错是 `string_type`，body 非对象是 `model_attributes_type, loc:["body"]` | 客户端按 `details.errors[].loc` 定位字段；若改成自定义 `{field:...}`，前端表单回填逻辑会在新实现上失效 |

## I. ingestion B1 对拍发现（阶段 3 续）

对拍方式：`scripts/gen_ingestion_review_golden.py` 在一次性 PostgreSQL 测试库里造**真实行**，直接调用
`refresh_candidate_issues` / `job_summary` / `candidate_summary`，把行与输出一起冻结为
`tests/golden/ingestion_review.json`（30 组）；`gen_ingestion_layout_golden.py` 冻结 41 组布局向量。
另有 `scripts/probe_ingestion_b1.py` 对真实 Django HTTP 做了 114 例实测（报告见
[09-ingestion-b1-probe.md](./09-ingestion-b1-probe.md)）。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| I1 | **Ninja 的 body 校验错误 `loc` 多一层参数名**：`["body","payload","text"]`，不是 `["body","text"]`；完全无 body 时是 `["body","payload"]`；数组/标量 body 被 Ninja 当成空对象，于是必填字段报 `missing`（不是 `model_attributes_type`） | B0 的 O06 按 `["body","text"]` 实现，是**真实缺陷**；B1 已按实测修正 O06 与 `tests/ingestion_http.test.ts`，B1 全部 schema 校验共用同一形状（`ingestion_routes.ts`）。`details.errors[]` 只有 `loc/msg/type`，没有 `ctx`/`input` |
| I2 | **Django 错误信封当前不含 `request_id`**：114 例里 46 个错误响应全部只有 `code/message/details`；`attach_request_id` 没有调用点 | Node 的 router 始终附带 `request_id`（可选字段的超集）。这是**全局传输层**差异、不是 B1 引入的；不改 router（会动所有既有路由与测试），在此登记为已知差异 |
| I3 | `job.documents.all()` **没有 ORDER BY**：黄金夹具里 Django 返回的顺序与 through 表插入顺序相反 | 规格已声明“documents 无显式顺序”。Node 序列化按 through 行 id（插入顺序）输出；黄金测试对 `document_ids` 做集合比较，不把它当序列契约 |
| I4 | `refresh_candidate_issues` 里 `job.input_kind == "ai_variant"` 会追加独立变式校验（B5） | B1 没有任何路径能创建 `ai_variant` job，分支不可达；已在 `ingestion.ts` 注释与本文登记，**未**用近似实现冒充。导入 B5 时代归档数据时需补 |
| I5 | 病态 draft：`question_type` 是选择题而 `payload.content` 是非对象（如数组）时，Django 在 `content.get("options")` 处抛 `AttributeError` → 500；Node 的 `validateContent` 先报 `content_not_object`，随后按空 options 继续 | 方向：Node 更健壮，不把畸形草稿变成 500。属**有意差异**（安全方向），仅对畸形 PATCH 输入可见；不为了“逐位一致”故意崩溃 |
| I6 | pydantic 的 lax `int` 接受非 ASCII 十进制数字（Python `int("١٢") == 12`）；Node 的 `intQuery`/`expected_revision` 只接受 ASCII 数字 | 与 DIV-1 同方向：拒绝即 400 `int_parsing`（安全方向，不误读题号/分页） |
| I7 | `record_editorial_preview` 里 `detail.proofread_at` 与 exposure 的 `server_time` 是**两次** `timezone.now()`，可差几微秒；Node 用同一请求时刻 | 契约只要求 ISO 文本与字段存在；测试不比较二者差值。登记以免将来把“相等”当成不变量 |
| I8 | `parse` 的 pydantic 转换：`"false"/"no"/"off"/"0"/"y"/"n"/"t"/"f"`（大小写不敏感）与 0/1/0.0/1.0 被接受；其他字符串是 `bool_parsing`，其他数字/数组/对象是 `bool_type` | 幂等指纹使用**转换后**的值：`parse:"false"` 与 `parse:false` 是同一请求（O07 重放而非 409）。Node 已按此实现并有测试 |
| I9 | O07 重放返回**第一次的 201**（`record_result` 存的是原状态码），body 含原 `created_at`/`document_ids` | Node `recordResult` 存 `result.status`，重放返回该值；测试逐字段比较 |
| I10 | `candidate_status_counts` 的键来自 Python `set` 迭代（哈希顺序），空任务是 `{}` | 只比较映射内容，不比较键顺序，不补零 |
| I11 | query 的 `limit=1.5` 是 `int_parsing`（字符串），body 的 `expected_revision=3.7` 是 `int_from_float`（数字） | 两者不能共用一个错误模板；Node 分开实现并有测试 |

## J. ingestion B2 对拍发现（阶段 3 续：O18 发布写集）

对拍方式：`scripts/gen_ingestion_publish_golden.py` 用真实 `publish_candidate` / `publish_problems` 在一次性
PostgreSQL 测试库里发布 24 组候选（13 组成功写集 + 11 组拒绝）并冻结 13 组发布前校验向量
（`tests/golden/ingestion_publish.json`，重跑逐字节一致）；`scripts/probe_ingestion_b2.py` 对真实 Django
HTTP 记录 40 例（报告见 [11-ingestion-b2-probe.md](./11-ingestion-b2-probe.md)）。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| J1 | **Django 在保存 `DecimalField` 时按 `decimal_places` 量化**（`format_number`）：`score_weight`（4 位）存 `1.0000`/`0.5000`，`practice_max_score`（2 位）存 `2.00`，`confirmed_score` 存 `0.00`。Node 存储层此前按 `Decimal.toString()` 原样写，`1` 与 `1.0000` 混存 | **真实缺陷**，影响所有 decimal 列（不只是发布）。已在 `gen_schema.py` 输出 `decimalPlaces`、`repository.ts` 写入前 `quantize`。副作用：Django 对“刚 create 的映射”返回内存值（`"1"`）、对重新查询返回库值（`"1.0000"`），Node 统一返回库值；`tests/mappings.test.ts` 的期望已按库值更新。4 处测试期望随之修正（`pass_score`、`confirmed_score`×2、`score_weight`） |
| J2 | **`normalize_content` 的空数组真值**：Python `if content.get("options"):` 对 `[]` 为假（省略该键）；Node 用 JS 真值（`[]` 为真）保留空数组，导致 `content_digest` 不同 | O18 的材料题内容恰好是 `{blocks, options: []}`，发布时算出的 digest 与 Django 不一致。已改为 `pyTruthy`。这是 B0 起就存在的缺陷，B2 的黄金向量首次覆盖到 |
| J3 | **O18 的存储体与响应投影是两种形状**：Django 把 `candidate_summary(...) + question_id` 存进幂等表，但 `CandidateOut` 未声明 `question_id`，Ninja 序列化时过滤掉；重放也走响应模型，所以重放同样没有该键 | Node 的 `ingestionResource` 增加可选 `project` 投影：存含 `question_id` 的体，响应去掉它。测试同时断言两处 |
| J4 | **`create_question_version_draft` 的 `estimated_seconds` 缺省是 `None`**，不是 0 | B1 的 `createQuestionRevision` 用 `?? 0`，是 parity 缺陷；B2 改为 `null` 并纳入黄金向量（P32 实测为 `null`） |
| J5 | **rubric 校验的两种出口**：`upsert_rubric_version` 的 `full_clean` 失败 → 422 `结构校验失败` + `details.errors`（值是**消息数组**）；`publish_problems` 里的 `rubric_invalid` 消息是 Python `str(message_dict)` 的字典 repr（`{'total_score': ['…']}`） | 两条路径都要一致。O18 走的是前者（先 upsert 再 publish），后者只有直接写 rubric 行的路径可达；两者都有向量 |
| J6 | `ai_variant` 任务的候选在 `refresh_candidate_issues` 阶段就会带上 B5 的变式校验（实测 P27 → `variant_source_missing`），O18 的“强制 `ai_generated`”分支在 B2 不可达 | 代码保留该 3 行强制逻辑（与 Python 同形），但**不**声称 B2 端到端可达；B5 补齐变式门禁后才可验证。与 I4 同一条边界 |
| J7 | 幂等记录的 `resource_type`：Django 对 O07/O12 记 `import_job`，O16/O17/O18 记 `import_candidate` | B1 的 Node 包装没有传，存的是空串（真实缺陷）。B2 给 `ingestionResource` 增加资源元数据，并补齐 O07/O12/O16/O17/O18 的 `resource_type`/`resource_id` |
| J8 | `mark_project_stale_for_paper` 用 `QuerySet.update()`，**不**触发 `auto_now`：快照的 `updated_at` 不变，只有 `is_stale=1` | Node 的 `paper_stats.ts` 用裸 `UPDATE`（不动 `updated_at`），与 Django 一致 |
| J9 | O18 **不增加候选 revision**、不改 `reviewed_at`；重复发布（新幂等键）只多一条幂等记录 | 黄金向量与 HTTP 测试都断言 `revision` 保持 1；`publication_*` 指针是唯一的状态变化 |
| J10 | O18 写 PaperItem 时 `answer_key_version` 取该版本**最新**答案（`order_by("-version").first()`），不筛争议 | 与发布门禁的“可用答案”不同：门禁要求 checked+非争议，item 只是记录“卷面当时指向哪份答案”。按现状移植，不“修正” |
| J11 | `add_paper_item` 的科目不一致是 `ScopeViolation`（404），而模型 `full_clean` 的其他错误（父题项跨版本、AI 题挂真实卷、负分）是 422 + `errors` | 两者不能互换；P22 证明 404 时**整笔发布回滚**（question/version/answer 都不留） |
| J12 | O18 只校验规范属于**项目**，不校验与候选**同科目**（P10 用另一科目的已发布规范发布成功） | 不要顺手加“同科目”校验；那会改变既有可发布集合。若产品要收紧，应单独立项 |
| J13 | 材料题的版本由**第一个子题**发布时创建（草稿），材料题本身只能在其子题全部发布后发布；父 item 在材料发布时回连已发布子 item | 黄金向量同时冻结“子题发布后的父指针”和“材料发布后的 children 列表与 item 父子关系”；顺序写错会在两处显形 |

## K. ingestion B3 对拍发现（阶段 3 续：O01/O02/O05/O08、存储、图片、门禁）

对拍方式：`scripts/gen_ingestion_b3_golden.py` 在一次性 PostgreSQL 库里造真实行，直接调用
`store_asset` / `create_image_document` / `find_duplicate_document` / `assert_asset_download_allowed` /
`start_image_import`，冻结 128 组向量（`tests/golden/ingestion_b3.json`，重跑逐字节一致，sha256
`f291cc88…ccb57b4`）；`scripts/probe_ingestion_b3.py` 对真实 Django HTTP 记录 64 例（报告见
[12-ingestion-b3-probe.md](./12-ingestion-b3-probe.md)）。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| K1 | **O01 不做 MIME × 真实格式的交叉校验**：PNG 字节 + `image/jpeg` → 201，`content_type` 落 `image/jpeg`、键后缀 `.jpg`，而落盘字节仍是 PNG（探针 P09 的 magic 是 `89504e47…`）；下载时这个声明会原样回给客户端 | 按现状移植：`content_type` 取声明、容器取检测、后缀取声明。三者在同一行里互相矛盾，但改任何一处都会改变既有客户端的表现 |
| K2 | **`sensitivity` 只有 O05/O08 按 role 推**：O01 传 `role=answer_page` 仍是 `public_to_owner`（P02） | 移植保留。不要「顺手」在 O01 里补 contains_answers——那会让已有上传的可见性发生变化 |
| K3 | **门禁顺序是 内部审核 → 封存 → editorial → contains_answers**：P28 用 contains_answers 资产 + `purpose=editorial` 拿到的是 editorial 文案，证明 editorial 先于 contains_answers | 顺序即契约（不同顺序会给出不同文案），Node 逐分支对齐并有 26 组向量 |
| K4 | **`allows_pre_submit_answers` 只看 mode、不看 status**：传一个 `status=finished` 的 verification session，仍然 403「当前会话模式在提交前不允许查看含答案的来源文件」 | 06 §3.2 的措辞（「然后 active 且非 practice」）容易被读成「已结束就放行」，实际不是。Node 按代码行为实现，并把这条写进向量 |
| K5 | **两处死代码**：(a) O08 的 `if not files: raise InvalidInput("请至少上传一张图片")` 不可达——`list[UploadedFile] = File(...)` 是必填，空列表在 Ninja 校验阶段就被拦成 400 `loc=["file","files"]`；(b) O05 的「来源角色无效」与 `store_asset` 的「资产角色无效」是两条不同消息，前者在视图里、后者在服务里 | (a) Node 复刻可观测行为（Ninja 形状的 400），不把不可达分支写成可达；(b) 两条消息都保留，测试各钉一条 |
| K6 | **去重键的不对称**：查重用**原始上传字节**的 sha256，`SourceDocument.checksum` 存的却是**重编码后**的 sha256。Django 的 Pillow 对干净 PNG 重编码是逐字节幂等的（`encoded_equals_raw: true`），所以同图二次上传**会**命中；JPEG/WebP/带元数据的 PNG 则**不会** | 算法完全一致，但换编码器后「干净 PNG 也不命中了」（K9）。这是**用户可见的行为差异**：同一张图在 Django 里复用来源、在移植里新建第二份。修它需要 `raw_checksum` 列或条件化重编码，属独立决策；本批次按 06 §5.1「先等价保留并写失败反例」处理，`tests/ingestion_b3_golden.test.ts` 有专门的 divergence 用例 |
| K7 | **调色板 PNG 会丢调色板且颜色改变**：`strip_metadata` 的 `Image.new(mode, size)` + `putdata(getdata())` 只复制索引、不复制 palette，存储仍是 `mode=P`，但颜色整体改变（向量：mean 20.643333 / max 105 通道误差） | **有意差异**：移植用 sharp 展开调色板，颜色逐点保留。Django 这里是数据丢失，移植更正确；不改回，也不声称「逐位一致」 |
| K8 | **WebP 的重编码在两边都是有损**：Pillow `save(format="WEBP")` 默认 `lossless=False, quality=80`，无损 WebP 上传后会被存成有损（向量 `webp_lossless_alpha`：mean 6.448333 / max 145） | 共有属性，不是差异。记录下来是为了避免将来某一侧「修好」后变成静默差异；性质测试只断言误差上界 |
| K9 | **sharp 的编码器与 Pillow 不是逐字节等价**：同一张 PNG 重编码后 363 → 3263 字节，JPEG 1131 → 614。`Asset.checksum`/`size_bytes` 因此与 Django 不同 | 06 §5.1 已声明「不可能普遍字节相等」。后果是 K6 的去重差异，以及**归档迁移时必须保留 Django 的 checksum 原值**（`src/migrate/archive.ts` 直接写行，不重算，已如此） |
| K10 | **空字节在 service 层不是「上传内容为空」**：`store_asset(content=b"", "image/png")` → 「图片内容无法解析，文件可能损坏或不是真实图片」；「上传内容为空」只存在于 O01/O05/O08 的 API 层 | Node 的 `prepareAssetImage` 对空字节同样报「无法解析」；API 层的空检查在路由里，两条文案各自成立 |
| K11 | **O05 接受非图片 MIME**：`text/plain` → 201，`document_type=image`、`asset.content_type=text/plain`、键后缀 `.bin`、宽高 null；而真 GIF（`image/gif`）会在 `store_asset` 的 allowlist 被拒成「仅支持 JPEG/PNG/WebP 图片」 | 两种现状都保留。开发中曾把非图片 MIME 也拒掉，被黄金向量抓回——这正是「先按现状移植」的意义 |
| K12 | **两条 404 文案不同**：asset 行不存在 → 「文件不存在或不属于当前项目」；行在但磁盘缺字节 → 「对象不存在或不在当前权限范围」（`Http404("asset bytes are missing")` 被统一映射） | 两条都实现，且不泄露路径 |
| K13 | **exposure 的关联完全由传入的 `session_item` 决定**：不传时，即使 asset 与题目有 source link / answer key 关系，`question/question_version/family/content_lineage` 也全为 null（P29） | 照搬。不要「顺手」按 asset 反查题目——那会改变污染判定 |
| K14 | **exposure 写在 `exists` 之后、`open` 之前**：开流失败仍可能留下台账 | 照搬（安全方向：漏记会让题目继续算「没被看过」） |
| K15 | **存储路径校验**：Django 是 `str(path).startswith(str(root))` 前缀比较，同前缀的兄弟目录（`/data/media` vs `/data/media-evil`）会通过；`..` 已被拒，所以不可达 | **有意（更严）差异**：Node 用路径边界比较。登记以免将来把「多一层防御」误当成行为改变 |
| K16 | **O01 的 role/sensitivity/subject 校验在图片解码之前**：`store_asset` 先查 role → sensitivity → subject，再 `validate_image` | 移植把「异步解码」提到事务外，因此显式先跑 `assertAssetFields`，错误顺序与 Django 一致（否则「role 非法 + 图片损坏」会报成图片错） |
| K17 | **Django 的 `SecurityMiddleware` 给每个响应都加 `x-content-type-options: nosniff`**，包括 404/403 的 JSON 信封 | 本批次顺手补进 router 的 JSON 响应（对既有路由无行为影响，只是多一个头） |
| K18 | **重复 query 参数的取值**：Django `QueryDict.get()` 返回**最后一个**，`URLSearchParams.get()` 返回第一个 | 已知传输差异，本批次不修（无探针覆盖、无客户端依赖）。新增的 O02 参数与既有参数保持同一规则（取第一个），至少文件内一致 |
| K19 | **O08 的视觉分支在响应返回前就跑完了**：测试设置下 `after_commit_dispatch()` 是内联的，响应体仍是派发前 summary（只有 `vision_extraction_queued`），而库里已多出 `vision_extracted_stub`、候选 revision=2、outbox 1 行、`audit_llm_run` 1 行 | 移植的 HTTP 端点固定 `useVision:false`，**不声称视觉链路已通**；`startImageImport` 的 `image_ai` 分支有写集测试（outbox 与 problem severity），消费端属 B5 |
| K20 | **同一次 O08 里两张空壳候选会互判重复**：`refresh_candidate_issues` 给第二个候选加 `duplicate_candidate` warning（内容完全相同） | B1 已移植的规则，B3 的向量第一次覆盖到「同 job 多候选」；不是新缺陷，但规格 §3.4 没写，登记以免被当成 bug 修掉 |
| K21 | **`image_imports` 的 `documents` 顺序不可依赖**：`job.documents.all()` 无 ORDER BY，`findRows` 也可能走索引；候选→区域→文档这条链才是两边一致建出来的顺序 | 黄金回放的排序规则写在测试注释里（按候选链定序、`document_ids` 排序后比较），不把「查询返回顺序」当契约 |

## L. ingestion B4 对拍发现（阶段 3 续：O09 PDF 导入、pdfjs 适配、版式分类）

对拍方式：`scripts/gen_ingestion_b4_pdf_golden.py` 用 `backend/tests/support/pdf_builder.py` 生成真实 PDF，
直接调用 `pdf_text.extract_native_text` 与 `_page_layout` / `_ordered_page_text` / `bbox_for_text` /
`_clamp_bbox` / `_normalise` / `_estimate_width_pt`，冻结 7 份夹具、9 种拒绝与 44 条版式向量
（`tests/golden/ingestion_b4_pdf.json`，sha256 `ef9aed31…4aea30d`，重跑逐字节一致）；
`scripts/gen_ingestion_b4_imports_golden.py` 在一次性 PostgreSQL 库里造真实行并调用真实
`start_pdf_import`，冻结 12 组成功写集 + 6 组拒绝（`tests/golden/ingestion_b4_imports.json`）；
`scripts/probe_ingestion_b4.py` 对真实 Django HTTP 记录 40 例（报告见
[13-ingestion-b4-probe.md](./13-ingestion-b4-probe.md)）。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| L1 | **pypdf 5.1.0 的 `TL` 缺陷（DIV-B4-1）**：`pypdf/_page.py:1988` 是 `TL = float(operands[0]) * font_size * scale_x`，而规范里 TL 就是无缩放文本空间单位。凡是靠 `T*` 换行的页面，第 2..n 行 baseline 被多乘一个字号：`build_text_pdf` 的 5 行页真实 y 是 800/786/772/758/744（14pt），pypdf 报 800/632/464/296/128（168pt = 14×12）。`text_two_pages` 夹具第 1 页后 5 个 fragment 的归一化 y 甚至 >1.0（1.03…1.83） | **缺陷，按缺陷记录**。本移植用规范正确的 `CTM × TM`（pdfjs 的 operator list 里矩阵是合成好的）。后果：`T*` 类夹具的 fragment y 不可比，只比文字、顺序与分类；显式 `Tm` 的夹具（`build_layout_pdf`）几何逐位相等。分类结论在全部 7 份夹具上不受影响（单栏页的 y 分布不影响 columns/grid），bbox 反而更准确 |
| L2 | **`metadata.title` 两边都不可信（DIV-B4-2）**：`/Title` 写成 UTF-8 字节且无 BOM 时，pypdf 保留 `ByteStringObject`，`_metadata` 的 `str(value)` 得到 Python bytes repr（`b'AcePass \xe6…'`）；pdfjs 按 PDFDocEncoding 解成 mojibake | metadata 本就不落库（06 §5.2 已写）。黄金向量用 `metadata_comparable: ["producer"]` 显式声明只比 producer，title 仅作文档记录 |
| L3 | **`getTextContent()` 丢弃页面框外的字形（DIV-B4-3）**：pdf.js `compareWithLastPosition` 有 `posX > viewBox[2] → return false`，该字形与其后整段被静默跳过。`table_formula` 夹具的 `【题干】…∫_0^1 f(x)dx 的值。` 比页面宽，`getTextContent()` 只回来 `…∫_0^1`，尾部 12 字符消失；pypdf 保留（`_clamp_bbox` 正是为此存在） | **这是内容截断，不是几何噪声**。适配层改读 `page.getOperatorList()`（`showText` 的 glyph 数组 + 内容流状态机），框外文字照常保留。黄金向量里 `table_formula` 就是这条的反例 |
| L4 | **`getTextContent()` 按 0.6em 视觉间隙拆 run**：`A. 甲` 变成 `"A." + " " + "甲"` 三个 item；双栏页每个选项行因此有 4 个 fragment。`_detect_table_grid` 只数"一行 ≥3 个 fragment"，于是**干净的双栏页凭空多出 `table_grid_detected` 阻断项** | 同上，operator list 一个 show-text 操作一个 fragment，与 pypdf 的 `visitor_operand_before` 同粒度。曾先试过"合并 ≤1em 的间隙空格"，虽然能修好夹具，但那是在用启发式猜 run 边界，已被 L3/L4 的根因方案取代 |
| L5 | **事务外提取使"第二份文件损坏"零磁盘写入（DIV-B4-4）**：Django 建完第一份文档、再提取第二份时抛错，数据库回滚但第一份文件留在私有存储（06 §5.1 已记录"DB rollback 不撤回已 rename 文件"）。本移植把所有提取放在事务前，因此这种失败一份都不写 | **有意的运维改良**（更少孤儿，不是更宽松）。跨批失败仍可能留孤儿，与 Django 相同；`error_second_file_corrupt` 用例断言行数前后完全相同 |
| L6 | **`answer_match` 命中时三个字段仍为 null（KNOWN-B4-1）**：`apply_answer_matches` 的 success dict 只有 `matched/method/label/raw/answer_payload/parse_issue`，`_create_candidates` 从 match 里 `.get()` 那三个 key 得到 None | 按现状复刻。`paper_and_answers` 写集与探针 P03 都钉住 `source_page_index/document_id/document_title = null`；不要"顺手"补 provenance——那会改变已存行的形状 |
| L7 | **`_detect_columns` 的三个"无栏"出口全部返回 `(1, True)`**：fragment 数 <6 的短路、过滤后 clusters<2、没有任何 qualifying 对。`unambiguous=False` **只可能**在 `columns≥2` 时出现 | 移植逐分支对齐。容易被误读成"无栏但不可靠"，实测不是 |
| L8 | **`unambiguous=true` 仍可能 `reading_order_reliable=false`**：当 `_column_major_text` 重建后可见字符变少，`_ordered_page_text` 保留原文、置 reliable=false，并**追加** `column_reading_order_ambiguous`——几何明明不模糊，理由却写成 ambiguous | 照搬（理由码的语义在这里被复用）。`ordering_rebuild_losing_characters_falls_back_to_source_text` 专门钉这条；`facts` 必须在**重排之后**快照，否则读到的还是降级前的状态 |
| L9 | **595pt 页上"恰好 12pt 的沟"会被浮点判成没有沟**：`12/595` 不是精确二进制，`gutter_end - gutter_start < gutter_width` 成立（实测差 7e-15） | 阈值向量统一用 512×512 页框（12/512、3/512、6/512、256/512 都精确）。**这是真实 PDF 上的行为**，不是测试技巧：A4 页上恰好 12pt 的窄沟可能被判成单栏。移植保持同一比较式，不"修" |
| L10 | **`needs_review` 与 `geometry_unavailable` / `too_many_fragments` 无关**：只由 `REASON_TO_ISSUE` 决定，这两个理由永远不进 issue 表 | 移植照搬。页面因此仍能导入并发布，只是 `reading_order_reliable=false` |
| L11 | **`_join_line` 的空格阈值是 0.36 em**（`gap > 0.3 * height`，而 `height = 1.2 * size / page_h`），不是 0.3 em；10pt 字即 3.6pt | 移植直接复用同一表达式；`join_line_gap_over/under_threshold` 两条向量钉住 |
| L12 | **`pdf_pages_without_text` 的文案里打印的是 Python list repr**：`f"{item['pages']} 页"` → `第 [2] 页` | 照搬（`pyListRepr`）。改成"第 2 页"会让 message 与 Django 不一致，而 message 是客户端会展示的原文 |
| L13 | **`page_diagnostics` 截断在恰好 500 行、且可能截断在某份文档中间**：`_collect_page_diagnostics` 在 append 后立即 `if len(rows) >= 500: return` | 移植照搬；`diagnostics_truncation` 用 3 份 200 页 PDF 断言恰好 500 行 |
| L14 | **一次导入可以同时有 `duplicate_input` 和 `duplicate_source_file`**：前者来自 `input_fingerprint`（由文档 checksum 拼成），后者来自本请求内的复用计数；两者互不替代 | 移植保留两条独立 problem；`duplicate_bytes` 写集按顺序断言 |
| L15 | **`no_segments` 的 job 永远停在 `awaiting_review`**：`maybe_complete_job` 的完成条件是 `pending==0 && candidates.exists()`，0 个候选因此不满足 | 照搬。这类导入靠人看 `no_recognised_segment` 收尾，不会被自动标完成 |
| L16 | **`covered_session_count = len(paper_files) if expected_session_count else None`**：`expected_session_count=0` 与 `None` 等价（Python 真值），都会得到 null | 移植用同一真值判断（`pyTruthy`），不写成 `!== null` |
| L17 | **`get_or_create_paper` 命中既有 Paper 时什么都不覆盖**：`source_kind`、`title`、`is_demo` 都保留旧值，只有新建时才写 defaults | 移植照搬。`duplicate_paper_position` 用例里第二轮导入的 `title` 与既有 Paper 不同，但 Paper 行不变（只有新 revision） |
| L18 | **每次导入都新开一条 draft 修订，且不确认覆盖、不设 effective**：`covered_session_count` 是"这次传了几份"，不是"这套卷共几份" | 移植照搬；`official_past_with_paper` 断言 `coverage_confirmed_at` 与 `effective_revision_id` 都为空 |
| L19 | **O09 的 `files` 缺失是 400 而非 422**：`InvalidInput` 映射 400，Ninja 校验错误也用同一信封（`error.details.errors[0].loc = ["file","files"]`） | 探针 P09 与 HTTP 黑盒都钉住；视图里那句「请至少上传一份试卷 PDF」不可达（必填参数先拦），只在服务层被直接调用时可见 |
| L20 | **`expected_session_count` 的非整数是 Ninja 的 `int_parsing` 422**：`loc=["body","payload","expected_session_count"]` | 移植手工复刻该形状（表单字段走的是同一个 Pydantic 校验），HTTP 黑盒断言 details 原文 |
| L21 | **同一请求里重复的字节只产生一条 `job_documents`，但指纹里 checksum 出现两次**：Django 的 `job.documents.set(documents)` 去重（表上也有唯一约束），而 `input_fingerprint` 是 `b"".join(document.checksum …)` 逐项拼接 | 移植在 M2M 插入处去重、指纹保持不去重。这条是探针 P04 暴露的真实缺陷：B1 的 `createImportJob` 曾按列表逐项插入，同请求重复上传直接撞唯一约束变成 500；HTTP 黑盒的「同请求重复字节」用例现在钉住 `1` / `1#2` 两个位置键 |

## M. ingestion B5 对拍发现（阶段 3 续：O19/O20 变式、extraction worker、LLM 审计适配）

对拍方式：`scripts/gen_ingestion_b5_variants_golden.py` 在一次性 PostgreSQL 库里造真实行，直接调用
`_answer_consistency_problems` / `_proposed_score` / `_draft_payload` / `independent_checks` /
`variant_review_issues` / `variant_job_summary`，冻结 10 条纯规则、6 条评分、3 条草稿、8 条独立校验、
2 条复核、1 条序列化向量（`tests/golden/ingestion_b5_variants.json`，sha256 `da98000d…037b6`，
重跑逐字节一致）；`scripts/probe_ingestion_b5.py` 对真实 Django HTTP/服务记录 **26 例**
（O19 16 / O20 3 / extraction 7，报告见 [14-ingestion-b5-probe.md](./14-ingestion-b5-probe.md)）。
`propose_variants` 本身不写进黄金向量：它生成 `uuid4` job/candidate，会破坏"重跑逐字节一致"；
端到端行为由注入 fake `LlmPort` 的 HTTP 黑盒与探针钉住。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| M1 | **Django 的真实 provider 路径无法产出合格变式（DIV-B5-1）**：`OpenAICompatibleProvider.call` 返回 `AiCallResult(payload={"text": text})`（`backend/ai/providers/base.py:250`），而 `propose_variants` 把 `call.payload` 直接交给 `validate_variant_payload`（`variants.py:855`）。只有"已经解析好 payload 的" provider（测试 double/stub）能通过；真实 OpenAI 兼容 provider 的每次候选都会被判成 `not_object`。`suggest_tags` 有同一处 bug | **有意偏离**：Node 的端口只返回文本，服务再用 `parseModelJson(result.text)` 解析（与 extraction 的 `json.loads(call.raw_text)` 同形），因此真实模型可用。没有把 Django 的坏路径当 oracle 复刻；也没有修改 Django。修复 Django 应单独立项（改 provider 的 `payload` 语义会动所有能力） |
| M2 | **无能力时审计行与 API 文案分离**：Python 记 `provider="none"`、`error_message="当前 provider 不声明 propose_variant 能力（未配置文本模型）"`，API 503 文案是 `生成变式需要配置 AI 能力：未配置可生成变式的文本模型；请配置 provider 或人工录入变式`（探针 P01） | Node 的 API 文案逐字相同；审计行写 `provider="dsh-llm"`、`error_code` 保留端口实际 code（`ai_not_configured`，或 Node 拆分的 `ai_capability_unsupported`）、`error_message` 保留端口原因（"AI 未配置"）。这是 06 §6.1「DSH adapter 保持 API 文案，端口原因留审计」的具体落法；`details.error_code` 因此可能比 Python 更细 |
| M3 | **响应里的 `provider` 含义不同**：Python 返回 provider 实现名（`openai_compatible` / `stub`）；Node 返回 `result.route.provider`（DSH 路线），`model` 两侧都是实际模型标识（`result.route.model`） | 字段仍存在且诚实；黄金向量不含该字段（`VariantPropose` 由 HTTP 测试断言），不声称逐位相同。`llm_run.model_identifier` 同样从 `route.model` 写入 |
| M4 | **`is_stub` 在两个世界的含义**：Django 有 stub provider（测试/演示），探针用 `is_stub=True` 的 scripted provider 才看得到 `is_stub_output=true` 与 `vision_extracted_stub`；生产移植没有 stub，`is_stub/is_stub_output` 字面量 `false` | 生产路径永远不会新造 `true`；归档导入可以读旧 `true`，但不改写。HTTP 测试固定断言 `is_stub=false`；审计行 `is_stub` 是字面量类型 `false` |
| M5 | **`answer.blank_answer_missing` 的多个缺失空位顺序不确定**：Python `defined - {str(key) for key in answers}` 遍历 `set`，顺序随字符串哈希随机 | Node 用 `defined`（题干顺序）迭代，是**确定性超集**。黄金向量只放"单个缺失空位"用例；多缺失时两侧的 problem 集合相同、顺序可能不同，不能当逐位契约 |
| M6 | **extraction 的失败分支有 lost-update 风险（DIV-B5-2）**：`_mark_extraction_failed` 用的是调用前加载的 candidate 对象，只改 `needs_manual_structure` 后 `save(update_fields=["draft_payload"])`；若人工在模型调用期间改过草稿且该分支可达，会把人工版本覆盖回旧值 | Node 重新读当前行，只在 `needs_manual_structure` 为假时翻转该键，其余字段原样保留（更安全）。该分支在图片候选上通常不可达（初始就是 `true`），故探针不把它当活跃行为；登记以免将来把"更安全"误当行为改动 |
| M7 | **extraction 审计的 `document_id` 是 `job.documents.first()`，不是本次 document**：`_record_run` 的 `input_snapshot` 取 job 的第一份文档（`extraction.py:85`） | 移植照搬；探针 P21 与 P26 的 `input_snapshot.document_id` 分别指向第一份与唯一一份，Node 用 through 行 id 升序（Django 没有 ORDER BY，与 I3 同一条已知事实） |
| M8 | **缺"资产行"与缺"磁盘对象"不是同一条路径**：`_document_bytes` 在 `asset is None` 时抛 `FileNotFoundError`（被捕获 → `missing_source_image` + job warning），而 `storage.open` 缺文件抛 `ObjectNotFound(StorageError)`，`except FileNotFoundError` 不捕获（任务失败/重试） | Node 保留同一不对称：`document.asset_id` 为空（或资产行不存在）→ `missing_source_image`；`getStorage().open` 抛 `StorageError` → 让 worker `failClaim` 重试。不声称"缺文件已降级" |
| M9 | **`max_output_tokens=2000` 没有对应的宿主参数（DIV-B5-3）**：Python 的 `AiRequest.max_output_tokens` 会进 `max_tokens`；Node 的 `CapabilityRequest` 没有该字段，`port.ts` 的 `stream` 也未传 | **未达 parity**：没有为了"看起来一致"往 `stream` 里塞一个未经 SDK 证实的键。记录在 06 §6.2 与本文；若宿主后续提供已证实参数，再加字段与测试 |
| M10 | **O19 的幂等 claim 先提交、再调用模型**：Django 的 `idempotency.claim` 在独立 savepoint 提交，服务失败时中间件 `release()`；Node 在独立事务 claim，`await` 模型（不在 SQLite 长事务里），失败时 `release` 后抛 503 | 可观察行为相同：同 key 同 body 重放、异 body 409、失败后同 key 可重试。崩溃在 claim 之后会留下 in-flight 记录（Django 同样），不假装 exactly-once 计费 |
| M11 | **变式 run 的 `validation_result` 字段名与顺序**：`accepted/problems/validation_problems/independent_problems/content_digest/index`；被拒变式的 `error_code/error_message` 为空（探针 P12 的 run 只在 `validation_result` 里说明原因） | Node 逐字段照搬；`markRejected` 的 `ai_invalid_output` 会写 error_code，所以变式路径不用它，而是手工在同一行上写空 error 字段（"同一行、不新建第二条 run"） |
| M12 | **O19 的 body 校验是 400，不是 422**：`apps/common/errors.py` 把 Ninja 的 validation 映射为 `invalid_input` 400；`O20` 的 `limit=abc` 也一样（探针 P19，`loc=["query","limit"]`） | Node 与既有 ingestion 路由共用同一 `schemaError`（400）；O20 的 `limit` 用 `intQuery` 复刻 `int_parsing` 的 msg/type/loc |
| M13 | **失败候选同时带通用 `duplicate_candidate` 与 B5 的 `duplicate_pending_proposal`**（探针 P12）：B1 的通用扫描按 JSON 结构相等，B5 的检查按规范化题干 + digest | 两条独立 warning/blocking 都保留；不要因为"重复"就删掉其中一条 |
| M14 | **变式候选的基线 issue 一定包含 `answer_unknown`（blocking）与 `no_source_region`（warning）**：`draft.answer_status_known=false`，且变式没有来源区域（探针 P09） | 这是"AI 答案只是提案"的可观察形态；HTTP 测试断言 `answer_unknown`，并断言候选状态是 `draft` 而非 `ready` |
| M15 | **迟到 revision 的 extraction 结果整块写进 machine record**：`stale_revision/extraction_started_revision/applied_revision/pending_clean_payload`，草稿不动，job 加 `vision_extracted_stale`，外层仍返回 `"ok"`（探针 P25） | Node 的 `applyExtraction` 逐字段照搬，`extractImageCandidate` 同样返回 `ok`；worker 在应用前重新 `holdClaim`，租约丢失时只保留审计行、不写业务状态 |
| M16 | **O08 的视觉分支在 B5 才接上 HTTP**：B3 的 HTTP 固定 `use_vision=false`；B5 由端口 `availability().extract_question` 决定，无端口时仍是 manual（与 B3 兼容） | 探针 P20 走服务层（真实 `start_image_import(use_vision=True)`，`input_kind=image_ai`、1 条 outbox）；HTTP 侧的 branch 由 Node 测试的 fake port 断言。**不**声称探针的 outbox 已被消费——它是直接服务调用，状态停在 `pending` 是探针方法，不是缺陷 |
| M17 | **探针的 scripted provider 是 test double**：`is_stub=True`、`provider="probe-scripted"`、`model="probe-model"`，所以 P09/P21 的 `is_stub_output=true`、P21 走 `vision_extracted_stub` 文案 | 它证明的是"真实 Django 服务/路由在给定 provider 下的行为"，不是真实模型调用。生产移植没有 stub，Node 测试的 fake port 同样只存在于 tests，断言生产行 `is_stub=false` |
| M18 | **O19 成功响应把候选的问题平铺进 `problems`**：`[problem for candidate_row in candidates for problem in candidate_row["review_issues"]]`（`variants.py:962`），所以 `problems` 含基线的 `answer_unknown`/`no_source_region`，不只是变式校验问题 | Node 逐字段照搬；HTTP 测试按同一扁平顺序断言，不"只留变式问题" |

## N. analytics B6 对拍发现（阶段 3 续：5 个报表 + regrade/answer-review）

对拍方式：`scripts/gen_analytics_b6_golden.py` 在一次性 PostgreSQL 库里造真实行，冻结
`django.utils.timezone.now` 后直接调用真实 `build_practice_report` / `paper_coverage` /
`coverage_completion` / `cycle_analysis` / `build_effect_calibration` / `request_regrade` /
`execute_regrade_run`，冻结 practice 报告（含快照整行）、coverage、cycle、calibration、answer-reviews
与 4 组 regrade 写集（`tests/golden/analytics_b6.json`，sha256 `5585078…74d0`，重跑逐字节一致）；
`scripts/probe_analytics_b6.py` 对真实 Django + Ninja 路由记录 **61 例**（报告见
[15-analytics-b6-probe.md](./15-analytics-b6-probe.md)，sha256 `72e47a17…f70af`）。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| N1 | **重判的 `projection.refresh_paper_stats` 把科目 id 当 paper id（KNOWN-B6-1）**：`reports.py:911-915` 的 payload 是 `{"paper_id": str(run.subject_id)}`，消费端 `mark_project_stale_for_paper(paper_id)` 按 `Paper.id` 查，必然查不到并静默返回 0 | **Django 既有缺陷，按现状复刻**。后果：重判不会把项目报表快照标脏。探针 G27/enqueued_outbox 与黄金向量的 outbox 行都钉住该 payload。修复应另行决策（改成 subject→papers 的批量置脏会改变重算触发面） |
| N2 | **`invalidated_evidence` 一字段两义（B6-P3）**：正常/内容变更分支计**证据行数**（G27=2），拒绝分支计**被转待复核的作答数**（G25=1，证据行为 0） | 照搬字段名与计数口径；HTTP/黄金都断言两分支各自的值。不要“统一”成行数，那会改变响应契约 |
| N3 | **执行时目标争议是 HTTP 200 而不是 4xx（B6-P4）**：`run` 返回 `status:"failed"`、`error_message` 前缀 `重判被拒绝：`，`affected_attempts` 仍是创建时冻结的值 | 照搬。客户端必须看 `status`/`error_message`，不能只看 HTTP 码 |
| N4 | **`can_regrade` 只看答案不看 rubric（B6-P5）**：答案 checked、rubric 已争议时队列返回 `can_regrade=true`，用它创建 regrade 却 400 `重判目标 rubric 处于争议状态` | 照搬（队列投影与创建校验是两段逻辑）。黄金 answer-reviews 与探针 G14 同时钉住这个不一致 |
| N5 | **coverage 与 cycle-analysis 对同一试卷结论相反（B6-P6）**：`PaperRevision.coverage_status` 不看修订 `status`，演示卷也可以 `coverage_complete`；cycle 另要求 `source_kind=official_past`、非 demo、`status=confirmed` | 照搬两套口径，不合并。探针 V01/Y01 分别给出同一世界的两种结论 |
| N6 | **“覆盖完整”的卷覆盖率可以是 0.6667（B6-P7）**：`coverage_rate = 计分题 / 全部题项`，`is_scored=false` 的材料父项进分母；2 计分 + 1 不计分 = 2/3 | 照搬。不要把分母改成“计分题”，也不要改叫“场次覆盖率” |
| N7 | **`max_cycles` 一个参数三种语义（B6-P8）**：`0` 因 `or` 变 5、`99` 截到 10、`max_cycles=1` 时 `status` 从 `insufficient_cycles` 翻成 `ok`（`used >= horizon`） | 照搬；HTTP 黑盒分别断言 horizon 5/1/10/1 |
| N8 | **`by_knowledge_node.weight` 是“该节点第一次出现时的映射权重”（B6-P9）**：NODE_CHILD 报 1.0000，尽管同一题的其他轮次是 0.6/0.4；权重 0 的辅助映射仍产生 `attempts` 行与 `max_score:0`、`confirmed_fraction:null` 的桶 | 照搬桶的创建时机（首次遇到 mapping 时初始化 weight），不按节点重算 |
| N9 | **`totals.repeat_practice` 累计范围内全部作答（B6-P12）**：它是 `_accumulate` 的重复桶（25 次），不是“重复练习次数”；notes 里的“其中 1 次”来自证据维度 `repeat_practice` | 照搬。同名字段两种口径是原实现事实，迁移不“修正” |
| N10 | **calibration 的 `delta: None` 会触发自己的禁因果守卫（KNOWN-B6-2）**：`_comparability_between` 在不可比分支返回 `"delta": None`（`calibration.py:383/390/401/407/414`），而 `assert_no_causal_summary` 对非对象 delta 要求同行带 `sample_size/spread/caveats`（`:151-162`），于是**任意两个 `ok` 组不可比时整个请求抛 AssertionError**（Django 500） | **Django 既有缺陷，按现状复刻**（Node 也会抛，路由映射 500）。探针的世界只有 1 个 `ok` 组所以成功；calibration 单测在 verdict 层断言不可比结果，并单独断言 payload 级抛错。修复需单独立项（改守卫或改 verdict 形状都会动冻结契约） |
| N11 | **`POST /regrades` 在 test 设置下同步执行（B6-P1/P2）**：`ACEPASS_INLINE_TASKS=True` 使 `after_commit_dispatch()` 在请求内执行 run；201 body 仍是受理瞬间的 `queued/0`，数据库行已是 `succeeded/2`；幂等重放返回**过期的 201**，而 `GET /regrades/{id}` 返回终态 | 探针环境事实（生产是 Celery 异步）。Node 按生产语义：创建只入队，`/run` 或 worker 执行；重放返回第一次存储的 201。HTTP 测试同时断言 201、`GET` 终态与重放体，避免把探针的 inline 行为误当契约 |
| N12 | **过期模拟考的结算写 outbox（B6-P10）**：Django 的 `expire_session_if_due` 在报告读路径里入队 `learning.on_session_finished`，该事件延后到下一次 dispatch 才重建证据（G01 的 `practice_learning_evidence+6`） | **DIV-B6-3（有意差异）**：Node 结算会话（`status/finished_at/revealed_at/expired_at`）与 Django 完全一致，但不写该 outbox——worker 没有 `learning.on_session_finished` 消费者，写一条必然永久失败。可观察差异只在 outbox 行与证据重建时机，报告数字不受影响 |
| N13 | **状态投影此前把被取代 revision 的证据继续计数（B6 发现并修复）**：Python `refresh_node_state` 取 `is_active=True, grade_revision__gt=0`，Node 的 `stateRowsOf` 少了这两个过滤，导致重判后旧 revision 的 `independent_correct` 合格行仍让 `independent_correct_count` 保持为 1 | **已按 Python 修正**（`evidence_rebuild.ts::stateRowsOf`）。HTTP 闭环从“答对→重判成答错”断言 `independent_correct_count` 1→0、旧 revision 行只作历史保留；这是 R-INV 5“重判不重复累加”的直接证据 |
| N14 | **验证内容门禁此前会遮蔽未下发题项（B6 发现并修复）**：Python `_active_verification_items` 过滤 `first_delivered_at__isnull=False`，Node `verificationContentMap` 没有 | **已按 Python 修正**（`learning.ts`）。未展示的验证题项不能泄露答案，也不应把同内容的平行练习从报表里排除 |
| N15 | **`question_ids` 的排序基准是原始 UUID（B6 golden 细节）**：`incomplete_scope` 对 `sorted(set(str(question_id)))` 排序后再投影；按符号名排序会得到不同顺序 | 生成器保留真实 uuid、不做符号化；Node 直接比较原始 id。`session_item_ids`/`attempt_ids` 不排序，保持作答遍历顺序（`-submitted_at`，并列时保持存储顺序） |
| N16 | **generation 的分配（DIV-B6-2）**：Django 用 PostgreSQL sequence `analytics_regrade_generation_seq`，回滚的请求也会消耗编号；SQLite 没有 sequence，生成的 schema 也不能多一张计数表 | Node 在写事务内取 `MAX(generation)+1`。**排序性质保持**（旧代次永远小于新代次），差异只在“回滚后编号是否复用”；探针与黄金的编号序列（1,2,3,4,5）一致 |
| N17 | **拒绝分支的代次护栏比 Django 更严（DIV-B6-1）**：Python `invalidate_for_untrusted_regrade_target` 用 run 开始时的内存列表比较 `applied_regrade_generation`；若新代次在加载之后落地，老 run 仍可能撤销新结果。Node 在每次写入前重新读存储水位 | **有意加强**：与 `lock_attempt_for_regrade`/C02 的意图一致，且是“旧代次一行都不写”的硬要求。探针 G25 的 `applied=999` 作答在两侧都不动；Node 多覆盖“加载后又被新代次结算”的窗口 |
| N18 | **报表/校准的 `as_of` 取注入时钟（DIV-B6-4）**：Python 直接调 `timezone.now()`；Node 服务接收 `now` | 与 `buildPracticeReport`/`evidence_rebuild` 的既有约定一致，便于冻结黄金；HTTP 层传请求时刻，线上行为相同 |
| N19 | **`answer-reviews` 的 200 行截断与 snapshots 的 50 行上限没有真实观测**：探针只种了 24 条答案、3 条快照 | 代码按 `[:200]` / `max(1,min(limit,50))` 实现；不声称“截断行为已验证”，只声称边界公式来自源码并在 HTTP 测试里覆盖了 0/1/100/-3/abc |
| N20 | **`cycle-analysis` 对非 ASCII 年份数字的排序（DIV-B6-5）**：Python `str.isdigit()`/`int()` 接受任意 Unicode 十进制数字（如 `٢٠٢٤`），Node 的 `cycleSortKey` 只扫 ASCII 数字，这类键按 0 年排序 | 已知差异；`cycle_key` 是用户输入的自由文本，真实数据未出现该形态。若后续出现，需要按 Python 的 Unicode Nd 语义修 `cycleSortKey`，并补向量 |

## O. Web 客户端 / Remote 通道 B7 对拍发现（阶段 6）

对拍方式：在**真实运行中的 DSH Web 应用**（`dsh web`，隔离 `DSH_HOME`、真实浏览器 Cookie 鉴权）里
逐条验证宿主行为，而不是只读 SDK 源码；凡是"进程内可达"与"浏览器可达"结论不同的，一律以浏览器为准。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| O1 | **`connection.fetch` 仍是精确路径注册表**：`fetchRoutes.get(url.pathname)`；`:param` 模式永不匹配，且**一条路径只能注册一次**（方法集合存）。同一路径的 GET+PATCH 必须合并成一次注册 | 03 §3 早先只记了"参数化路径挂不上"；B7 实测还发现"同路径多方法重复注册会抛 `already registered`"。`src/http/mount.ts` 按 pattern 分组、一次注册多方法，并有单测钉住（`/me/study-settings` 的 GET/PATCH 共用一个注册） |
| O2 | **profile 插件加载在子 Cordis 树**：`ctx.get('connection')` 得到的 `HostConnectionService` 不是挂在 Web 服务器上的那个；写进子实例的 Fetch 路由**永远 404 且无任何报错** | 这是 B3 记录"路由已挂载"却无法从浏览器访问的根因。B7 改为 `ctx.root.get('connection')`，并按**活路由表**（`fetchRoutes` 的 Set）而不是对象身份去重（Cordis 每次 `get` 返回新 Proxy，`includes` 永远为假） |
| O3 | **`connection.rpc.handle(channel, handler)` 对树外插件不可用**：`register()` 用连接服务自己的 Context 读 `webServer`，而该 Context 只注入了 `credentials`，调用抛 `cannot get property "webServer" without inject` | 参数化 REST 因此不能走"自定义 RPC 通道"，只能走**一条精确路径** `/api/acepass/rpc`，宿主用同一个 `createFetchHandler` 重放。`/api` 的 `rpc.intercept` 已被 Typert Gateway 独占，不能二次注册 |
| O4 | **Typert RemoteStream 需要生成型 `RemoteStreamHandle`**：树外插件没有仓库内的 Typert 生成管线，客户端 `ctx.remote.$mount()` 需要严格的生成 codec | 流改为 `GET /api/acepass/stream`（SSE over 精确 Fetch 路由）：单调 `id`/`seq`、`?after=` 严格恢复、`done`/`error` 终态、心跳、断开即 `cancel()`。这是传输层的有意差异（16 §3.3），语义由测试钉住（重连不重放、不跳过、终态唯一、断开停生产者） |
| O5 | **DSH 的 Web 鉴权是 Cookie 会话，首个导航必须带 `?token=`** | 浏览器验收的 `baseURL` 用带 token 的 URL 完成首次认证；之后所有 `/api/...` 与 `/plugins/...` 请求带同一 Cookie。验收 harness 不伪造 Cookie、不绕过鉴权 |
| O6 | **`dataRoot` 指向的新目录不会被创建**：`openStore` 抛 `unable to open database file`，Fetch 桥把它变成空 400 | **已修**：`index.ts` 在打开存储前 `mkdirSync(dirname(storePath), {recursive:true})`。这是真实缺陷（配置一个新 dataRoot 即触发），不是验收环境特例 |
| O7 | **首屏对话/弹窗会拦截点击**：`Get started`（无模型时）与 `Preview Notice` 两个 `role=dialog` 遮罩 | 验收 harness 在 `login()` 里先关闭所有 dialog，再点侧栏 `AcePass`。这是 DSH 首启 UI 事实，不改变任何断言 |
| O8 | **Django 的登录/CSRF 在 DSH 不存在** | 有意差异：无登录页、`ensureCsrf()` 为 no-op、`logout` 为 no-op；`/auth/me` 返回工作区所有者。验收的 `login()` 改为"打开面板"，断言（进入"我的备考项目"）不变 |
| O9 | **页面路由改为面板内 `HashRouter`**：真实 URL 不再存在，`#/questions` 可深链、可刷新 | 有意差异：验收里的 `page.goto('/questions')` 由共享 fixture 重写为 `/#/questions`；断言不改。深链到达时客户端自动选中 AcePass 面板，否则刷新会落回 Conversation |
| O10 | **逻辑响应不再有独立 URL**：`watchResponses` 原先看 `response.url()`，现在看 `POST /api/acepass/rpc` 的信封 | 验收 harness 读请求体里的 `{method,path}` 与返回的 `{status}` 还原"逻辑响应"，从而保持"某接口不得 4xx"的原断言语义。这是传输层适配，不改断言 |
| O11 | **`page.route('**/api/v1/...')` 无法拦截信封内请求** | 客户端暴露 `window.__acepassFaults`（`pathContains/status/body`）作为等价故障注入缝；默认空数组，生产不启用。对应验收用例仍是"学习接口失败时显示错误而不是空状态" |
| O12 | **DSH 没有 stub provider**（R-INV 4 禁止 stub 进产物） | `@stub` 8 条用例在 DSH 侧只能得到诚实的 `ai_not_configured`/`service_not_migrated`；不为了变绿加 stub。归类为**有意差异**，逐条记录实际文案 |
| O13 | **前端 API 面里有 24 个路径在阶段 3 白名单上尚未迁移**（tutor-jobs/segments、diagnosis/diagnosis-follow-ups、AI estimate/diagnosis、transcriptions confirm/reject、memory-cards 全组、knowledge-relations/prerequisites、tag-suggestions、search/reindex、question exposure/external-seen） | 页面保留真实错误路径（`ai_not_configured`/`not_found`），不编造数据；对应验收用例按"未迁移操作"归类失败，构成 B8 的范围（16 §6） |
| O14 | **KaTeX 的字体与样式表没有资源路由**：客户端 bundle 不能引用包内相对文件 | 构建期把 `katex.min.css` 的 woff2 内联为 data URL（`scripts/gen-client-assets.mjs`，约 370 KB），公式首次渲染时注入 `<style>`；不把 KaTeX 塞进首屏 |
| O15 | **DSH 深色主题会改写原生控件颜色** | `ACE-PASS` 面板根部 `.acepass-root` 固定页面底色，并把 `select/input/textarea` 的底色与前景钉回浅色；页面自身调色板不动（验收断言依赖类名与文案，不依赖主题变量） |
| O16 | **两个黄金向量生成器不是逐字节可复现**：`gen_contamination_golden.py` 与 `gen_evidence_golden.py` 让 Django 模型默认生成随机 UUID（`User/ExamProject/QuestionVersion/Attempt/ExposureEvent` 等），重跑会得到不同的 id；03 §7 曾笼统写成"全部黄金向量重跑逐字节一致" | B7 复跑 `npm run golden` 时实测：23/25 个文件哈希不变，`contamination.json` 与 `evidence.json` 变化，差异只在随机 id（文件内部自洽，11 条相关测试仍全绿）。**未在本批修复**：把 id 固定成确定性 UUID 会改动已提交 fixture 与两套生成器的建行方式，属独立决策；先按事实修正文档口径——"逐字节一致"只对其余 23 个文件成立 |
| O17 | **研究结构（规范/大纲/考点/试卷）的服务已移植但从未挂路由**：`listSpecVersions`/`createSpecVersion`/`publishSpecVersion`、`listSyllabusVersions`/`createSyllabusVersion`/`publishSyllabusVersion`、`createNode`/`patchNode`/`importOutline`、`registerPaper`/`recordPaperCoverage`/`confirmPaperRevision`/`setEffectiveRevision` 都有实现与测试，但 `src/http/routes.ts` 里没有对应路径；浏览器验收的第一步（自动创建规范）就 404 | B3 的"45 条路由"只覆盖了当时切片的一部分，文档却写成 exams 全部完成。B7 补挂 16 条路径（`src/http/study_routes.ts`，91 条路由），幂等 scope 与 Django 逐字一致（`specs.create:{project_id}`、`specs.publish:{spec_id}`、`syllabus.create:{project_id}`、`syllabus.publish:{id}`、`nodes.create:{project_id}`、`papers.register:{project_id}`），并用 HTTP 黑盒验证。**未挂**的仍是阶段 3 白名单操作（见 O13） |
| O18 | **`<img src>`/下载链接无法走 RPC 信封**：资产路径含两个标识，既不能进精确路由表，也不能 POST 信封 | 新增精确路由 `/api/acepass/asset?project_id=&asset_id=&purpose=`，重写到真实的参数化下载处理器（四道门禁原样生效）；客户端 `assetUrl()` 统一生成链接。测试断言未知项目经真实处理器返回 404 而不是被 shim 兜底 |
| O19 | **验收夹具的幂等生成方式与 Django 命令不同**：`bootstrap_acceptance` 在已有同名项目时先 `archive_project` 再 `create_project`，但 `uniq_project_name_per_owner` 是无条件唯一约束、`create_project` 对**已归档**的同名项目也拒绝，Django 命令在任何用过的库上都会抛"已存在同名项目"（它只在全新 migrate 的库上跑过）；Node 的 `scripts/acceptance-seed.mjs` 先把上一代**改名**为 `…（验收归档 <UTC 时间戳>）` 再归档，新一代替换原名称 | 夹具工具的差异，不是服务行为差异：旧行（科目/题目/作答）原样保留，只有名称与归档标记变化。验收断言只依赖当前一代的三个项目名，因此不受影响；如实记录以免被误读成 `create_project` 的重名规则变了（服务层仍拒绝同名） |
| O20 | **`/auth/me` 在账户有 ≥2 个项目时 500（B7 验收发现并修复）**：`getUserOut` 用 `findOne(db,'exams_project',{owner_id})` 判断"是否已有项目"，而 `findOne` 在谓词命中多行时**抛错**（repository 的刻意纪律）；Django 等价物是 `.exists()`。空账户（0/1 个项目）下一切正常，种子夹具一建就是 3 个项目，登录即失败 | **已修**：改用 `countRows(...) > 0`，并加回归测试「三个项目时 `/auth/me` 仍返回 `needs_project_setup:false`」。这条缺陷说明"单元测试只造 ≤1 个项目"会漏掉真实多项目账户；浏览器验收是唯一能稳定暴露它的门禁 |
| O21 | **`POST /practice-sessions` 返回数据库行而不是 `SessionOut`（B7 验收发现并修复）**：路由直接返回 `createSession(...)` 的 `{...session_row, item_count}`，标识键是 `id`；客户端按 Django 契约读 `session_id`，于是得到 `undefined`，跳到 `/practice-sessions/undefined`（404，刷题工作台永远建不出会话）。`GET /practice-sessions/{id}` 的投影也缺 `policy_version`/`grading_hidden`/`server_time`/`confirmed_score`/`pending_max_score`/`score_visible`/`items[].session_item_id` 等字段 | **已修**：`learning.ts::getSession` 现在是唯一的 `SessionOut` 序列化器（create 与 get 共用，杜绝再次漂移），按 Django `session_state` 输出全部字段；同时实现两条遮蔽规则（会话级 + 内容门禁）——隐藏时总分是 `null` 而非数字，受影响题项的 `grade` 为 `null` 且 `receipt_only:true`。回归测试断言 `session_id` 存在、`id` 不存在、`server_time/policy_version/score_visible/confirmed_score` 与逐题 `attempt.grade.is_correct`。**第二个同类缺陷**：快照里的时间字段最初用 `String(bigint)` 序列化，`created_at` 变成微秒整数（`1794073561054000`）而不是 Django 的 ISO 文本；`created_at/revealed_at/finished_at/exam_started_at/exam_deadline/expired_at/first_delivered_at/submitted_at` 已统一走 `formatPythonIso`。这类缺陷只有真实浏览器走完"题库→开始练习"才能暴露，单元测试只调服务函数 |
| O22 | **`POST /session-items/{id}/submit` 从未挂路由（B7 验收发现并修复）**：`submitAttempt` 有完整实现与测试，`src/http/routes.ts` 只挂了 `/presentation`；浏览器里每次提交都 404，刷题闭环在第一步就断 | **已挂载**（`src/http/study_routes.ts::submitRoute`）。语义按 Django：幂等 scope `items.submit:{item_id}`，**重放不用缓存的响应体，而是按当前门禁重新序列化**（验证进行中 → `receipt_only:true`、`grade:null`，R-INV 2 不因重放而放宽），响应是 `SubmitOut`。`/reveal`、`/draft`、`/confirm-grade` 仍属阶段 3 白名单，未在本批实现（`/reveal` 需要服务层移植与 Django 探针） |
| O23 | **封存题目进入练习返回 404 而不是 403（B7 验收发现并修复）**：`createSession` 的封存守卫抛 `ScopeViolation`（→404），而 Django 是 `PurposeNotAllowed`（403 `purpose_not_allowed`，message 带封存原因）。验收用例断言 403 + `purpose_not_allowed`，404 让用例在"封存后应被拒绝"这一步就失败，且失败后未解封，污染同一文件后续的单选练习用例 | **已修**：改抛 `PurposeNotAllowed`，`details.reason_code` 保留 `sealed_question_policy`；`tests/sessions.test.ts` 的旧断言从 `ScopeViolation` 改为 `PurposeNotAllowed`。验收里的 `variants/propose` 403 也被证实是同一污染的连锁（封存用例失败后题目仍封存），不是独立缺陷 |
| O24 | **`POST /session-items/{id}/submit` 的请求体适配错误（B7 验收发现并修复）**：Django 线上字段是 `answer`，而服务内部 `SubmitPayload` 叫 `raw_answer`；最初直接透传导致 422「作答必须是对象」，客户端读 `grade` 得到 undefined。另外 `presentation` 的 `first_delivered_at` 用 `String(bigint)` 输出微秒整数 | **已修**：路由做唯一一处字段适配（`answer`→`raw_answer`，`steps/confidence/client_active_ms` 透传）；带 `asset_ids` 的提交明确拒绝（附件属于阶段 3 白名单，静默丢弃会丢用户上传）；`presentItem` 的时间戳改 `formatPythonIso`。`getSession` 的同类时间戳问题已在 §O21 记录 |

## P. 阶段 3 剩余操作 / 页面缺口 B8 对拍发现（阶段 6 续）

对拍方式与 §O 相同：先在**真实 Django**（一次性 PostgreSQL 测试库，`scripts/probe_b8_*.py`）里记录状态码/响应/
行数增量，再在 Node 侧用同一批行重放，最后用真实浏览器验收。B8 新增的每一条投影都有一条「探针响应 vs 移植响应」
的**形状比对**（键集合与值类型逐层比较），专门抓「静默少一个客户端要读的字段」这一类 B7 反复出现的缺陷。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| P1 | **`POST /attempts/{id}/confirm-grade` 的响应形状在 Django 内部不一致**：首次调用直接返回 `grade_payload(...)`（客户端读 `confirmed.status`），**幂等重放**却包成 `{"grade": …}` | 按实测复刻两种形状：首调平铺、重放包裹。验收只走首调；重放的包裹形状由 `tests/b8_practice_writes.test.ts` 钉住，避免「修一致性」时把首调也包起来（那会让评分页读不到 status） |
| P2 | **`POST /study-plans/today/generate` 返回 `TodayPlanOut`**（`{plan, tasks, notes, backlog, progress_notes}`），不是 plan 行；GET 同形。B3 的移植返回裸 plan 行 | 今日页读 `data.plan.daily_budget_minutes`，裸行会得到 `undefined`。已改为 `todayPayload`；`tests/http.test.ts` 的旧断言（`body.revision`）随之改为 `body.plan.revision`——这是**契约修正**，不是放宽断言 |
| P3 | **`presentation()` 返回 19 个字段**：`ordinal/purpose/tutoring_allowed/server_time/draft/draft_revision/assets/grading_hidden/exam_started_at/exam_deadline/expired_at` 全在其中。B7 的移植只返回 8 个 | 草稿、附件资产、辅导门禁、考试时钟全部丢失：照片草稿刷新后消失、延迟验证题仍显示辅导入口。已补齐并用探针 P01 做形状比对 |
| P4 | **`GET /attempts/{id}` 的字段名是 `attempt_id`**（不是 `id`），且带 `attachments`/`receipt_only`，读取时同样过内容门禁（`assert_grading_not_blocked`） | 刷新后的「查看答案」按 `attempt.attempt_id` 选稳定 attempts 路由；字段名错就退化成 session-item 路由。已修并加门禁（04 §O21 是同一类「序列化器漂移」） |
| P5 | **提交接受 `asset_ids`**：Django `_validate_attachments` 限制 ≤6 张、总大小 ≤30 MB、必须属于本项目/本人；B7 的提交路由明确拒绝（422） | 照片作答（大题）与评分页的「原始工作」都依赖它。已实现并加 HTTP 黑盒（越权 404、超限 400、成功写入 `attempt.attachments`） |
| P6 | **DSH 面板的 `page.goto('/x')` 是 hash 导航**：导航到**同一路由**时 React Router 不重建页面组件，而 Django 的 `page.goto` 是整页加载 | 验收 harness 在同路由导航后强制 `reload()`（只改传输机制，不改断言）。不这么做，`goto('/search')` 之后页面仍带着上一次的 `submittedQuery`，第二次检索不会发请求 |
| P7 | **`page.url()` 的 hash query**：`new URL(page.url()).searchParams` 看不到 `#/practice?session=…` 里的参数 | 验收里的 `sessionIdFromUrlOrNull` 改为同时读 hash query（同一类传输 seam，断言不变）。B7 时该用例先被 404 挡住，B8 揭示后才暴露 |
| P8 | **`study-tasks/{id}/start` 只返回 `create_session_hint`**：`{subject_id, question_ids, task_id, purpose}`；会话由客户端随后 `POST /practice-sessions` 创建，**mode 由 `task_kind` 决定**（`delayed_verification`/`paired_immediate` → `verification`），客户端不能降级 | `createSession` 已支持 `task_id`：复核 `delayedIntervalStatus`（不满足 400 + `not_before`）、按 `resolveTaskMode` 固定模式、`purpose=task_kind`、标记任务 `in_progress`、写 `origin_task_id`。验收 `p0-acceptance.spec.ts:457` 直接断言服务端固定的 mode |
| P9 | **配对触发点在 outbox**：Django 的 `create_initial_grade` enqueue `learning.on_attempt_graded`，worker 调 `pairing.on_attempt_graded` | Node 没有该 topic 的消费者；改为在 `submitAttempt`/`confirmGrade` 的**同一事务内**同步调用（幂等、失败回滚），不引入「已判分但没生成 B 任务」的中间态。夹具走同一函数 |
| P10 | **无模型时辅导任务的响应是 201，不是 503**：`POST …/messages` 创建 job 并内联执行，job 为 `status=unavailable`、`error_code=ai_not_configured`、`segment_count=0`；流发 `status(unavailable)` → `done`，零片段，**不发 error 帧**（error 只用于 `stale_source`） | 验收的 201 分支读面板里的 `error_message`（含「未配置」）。若改成 503 或伪造 error 帧就与 Django 不一致；@stub 8 条保持诚实失败（R-INV 4） |
| P11 | **转写闸门先于任何 provider 调用**：照片作答在转写确认前 `POST …/ai-estimate` 是 **409 `transcription_required`**；无视觉模型时 `POST …/transcriptions` 是 **503 `ai_not_configured`**；人工录入（带 `text`）是 **201 `origin=manual/status=confirmed/is_stub=false`** 并开闸 | 三条都在验收 `p1-batch3.spec.ts:106` 里逐条断言；顺序错（先调模型再判转写）会既泄露又产生无谓的 run 行 |
| P12 | **向量通道在 DSH 不可用**：`dsh-llm` 不暴露 embed 端点。`channels.vector.available=false`、`code=vector_not_configured`、`embeddings` 恒 0；混合检索降级到关键词 | 页面必须显示「向量通道未配置」而不是假装跑过；`p1-batch2.spec.ts:97` 断言该文案与关键词排名 |
| P13 | **`GET review-tasks` 的参数是 `subject_id` + `only_due`**，Django 没有 `limit`；`due_now` 是**重算**的间隔状态（不信任冻结的 `not_before`），锚点由 `_anchor_for` 在读取时重新取 | 任务书里的「limit」在 Django 不存在，按实测不加；`due_now` 的重算让「B 的新作答把 C 顺延」在页面上立即可见 |
| P14 | **`Idempotency-Key` 缺失/超长在 Django 是 409 `idempotency_conflict`**（`idempotency_key()`），而 B3–B7 既有 `study_routes.ts::effect()` 返回 400 `invalid_input`，且已有测试钉住 | B8 新路由按 Django 的 409；旧路由**不统一**（会改动既有契约测试与验收）。记录为已知不一致，留待单独决策 |
| P15 | **`study-tasks/{id}/start` 的失效写入顺序**：Django 先把任务标 `invalidated` 再抛 400；Node 的 claim 与副作用同事务，抛错会回滚失效行 | 改为服务抛 `UnusableQuestion`（带原因），路由在事务外补写失效；最终库状态与 Django 一致。代价：同键重试会重新校验而不是 409 in-flight（对用户更好） |
| P16 | **规划器 `reason_codes` 的追加语义**：Django `generate_plan` 对已存在的任务把候选的 `reason_codes` 追加进去（探针里出现重复 `due_delayed_verification`），移植版保留原值 | 不影响验收与页面；记录为未对齐项，改动会牵动 planner 的既有黄金向量 |
| P17 | **验收夹具的延迟验证链**：Django 的 `bootstrap_acceptance` 用真实服务路径 A→B→C（`create_verification_pairing` → 判分 → `on_attempt_graded` → 再判分），只把 C 的 `not_before` 挪到过去 | 夹具工具差异：① Django 命令每题不 `finishSession`（只在全新库跑过），Node 夹具每题结束会话，否则重跑时上一代项目归档会因「存在进行中的练习会话」失败；② 时间戳用夹具时钟（确定性），Django 用 wall clock。服务行为不变 |
| P18 | **节点改父的错误文案**：Django 是「不能把考点移动到自己的子节点下：会形成环，之后的覆盖统计将无法回到根节点」/「考点不能以自身为父（会形成环）」，移植版曾写成「子孙节点下」/「自己的父节点」 | 验收 `p1-import-and-cycles.spec.ts:251` 断言错误文案含「环」；缺这个字页面就显示不了环路径。已逐字对齐（`tests/knowledge.test.ts` 同步） |

## Q. 阶段 7 收尾 / B8 边界清账 B9 对拍发现

对拍方式：真实 PostgreSQL 导出→导入→全量对账（`dsh-plugin/scripts/reconcile_db.mjs`）、真实文件与真实
进程的备份/恢复演练（`tests/db_backup.test.ts`）、真实 Django 探针（`var/b9/boundary-p16-django-probe.py`）
以及只读的运行时依赖盘点（`var/b9/retirement-report.json`）。本节只记录**新发现**与**决策**。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| Q1 | **`Idempotency-Key` 缺失在 Django 是 409，不是 400**：`apps/common/api.py::idempotency_key` 先 `strip()`，缺失/空与超过 200 码点都抛 `IdempotencyConflict`（409）。B3–B7 的 `routes.ts::resource`、`study_routes.ts::effect`、`memory.ts::validateKey` 返回 400 `invalid_input` | **已统一**（B9）：新增 `src/services/idempotency_key.ts`，三处改为走同一规则；测试从 400 改为 409 + `idempotency_conflict` + Django 文案。B8 新路由本来就按 Django 的 409。客户端始终带 key，验收不受影响 |
| Q2 | **Django 的 `pairing.on_explanation_delivered` 是死代码**：定义在 `apps/learning/services/pairing.py:199`，生产代码零调用；唯一调用方是 `backend/tests/integration/test_learning_loop.py:141`（验证幂等）。Django 的讲解下发只写 `ExposureKind`，不触发配对 | 移植函数并测试幂等（`pairing.ts::onExplanationDelivered`），但**不接线** reveal/tutoring：接了会创建 Django 不创建的 B 任务。若未来要接线，必须先在 Django 侧接同一个触发点（W4） |
| Q3 | **规划器 `reason_codes` 的词表与追加语义都与 Django 不同**（P16 的完整形态）：Django 的候选是 `due_delayed_verification` / `weakness_repair`+`state_*` / `undiagnosed_node` / `general_practice`，且 `_task_candidate` 把候选码前缀到任务原有码、`_materialise_task` 重用任务时写回；Node 是 `delayed_due`/`weak_node`/`undiagnosed`/`general_pool`，重用分支只写 `plan_id`。前端 `TodayPage` 用 Django 词表做中文标签，旧词全部落到原始英文 | **已对齐**（B9）：4 处改动；真实 Django 探针显示跨天每次生成再前缀一次（1→2→3），Node 探针逐项一致。Django 的重复追加被照抄（对齐，不是替 Django 清理）。对账不受影响（只比导入行摘要）。已知边界：weak 前置重排、`trigger_event`（W1/W2） |
| Q4 | **`delayedIntervalStatus` 有两份实现**（`learning_extra.ts` 与 `pairing.ts`），文案格式一个用 `toFixed(2)`、一个用 `pyFormatFixed`；JS `toFixed` 是半数远离零，Python `f"{x:.2f}"` 是半数到偶 | **已合并**（B9）：`pairing.ts` 为唯一实现，`learning_extra.ts` re-export；文案统一走 `pyFormatFixed`。`b8_knowledge.json` 重跑逐字节不变（sha256 `24c1400124b3…`） |
| Q5 | **在线备份不能用 `sqlite.backup()` 对持续写入的库**：Node 文档明确「其他连接提交会让备份重启」；B9 演练里 1ms 一条写入时备份永不返回。`VACUUM INTO` 取一个固定读快照、不重启，2,000 行基线 + 子进程持续写入时 25ms 完成，快照行数落在写入前后之间 | 备份实现改用 `VACUUM INTO`；快照继承 WAL 后转 `journal_mode=DELETE` 成单文件。恢复用同一机制做恢复前快照。这是**运维语义**的选择，不是测试特例 |
| Q6 | **DSH 的 outbox 消费者有实现、无驱动**：`src/jobs/worker.ts::runOnce/drain/runOnceAsync` 在 `src/` 内零调用点（只有测试导入），而 `practice.ts`/`regrade_runs.ts` 仍 enqueue `evidence.rebuild_for_attempt`；另外 `plan.generated` 无 handler、两个 topic 改了名、3 个 Django 能力（`regrade_effects` 的证据重建、`rebuild_after_answer_change`、`on_session_finished`）在 Node 无等价实现 | **未修**（B9 只做退役盘点，不扩行为面）：F1–F4 写成退役前置条件与下一批范围（18 §4.5）。在接线前不能声称 Celery 异步链等价退役；也不能让 pending 事件跨实现导入（切换前必须清空） |
| Q7 | **真实 `acepass` 库落后于当前 Django 迁移**：51/59 业务表存在，缺 8 张表、7 张表各缺列（如 `practice_session.exam_started_at/expired_at`）；直接按当前 schema 导出会 `FieldError`。`reconcile_db.mjs` 先做 schema introspection：无 `--migrate-copy` 直接退出 3 并列出全部缺失项（不静默导出子集）；有 `--migrate-copy` 时用 `CREATE DATABASE … TEMPLATE acepass`（有连接时回退 `pg_dump \| psql`）克隆，只对克隆跑 Django 迁移后导出，`finally` 删除克隆；源库只读（跑完复核 60 表 / 35 migration / 4 users / 4 projects / 360 questions / 57 sessions / 42 attempts 未变） | 阶段 7 出口判据必须对**当前 schema**做，否则「51/59 表对上了」不是迁移。克隆+迁移是 Django 自己的代码，不是手写 fixture。证据见 18 §3 |
| Q8 | **浮点 JSON 让归档 manifest 的哈希契约在真实数据上不成立**：首轮真实库对账 manifest digest 只有 **56/59** 可复现。`accounts_user_settings.project_budget_percent` 的 `40.0`、`learning_study_plan.allocation[].percent` 的 `40.0`、`audit_idempotency_record.response_body` 里的浮点，被 `readArchive` 的 `JSON.parse` 收成 `40`，`pyJsonCanonical` 输出 `40`，而 Python `json.dumps` 写的是 `40.0`。`reconcileArchive` 两侧都走 `JSON.parse` 所以自洽——只有拿 manifest 对才知道不一致；之前的合成 drill 没有浮点 JSON，所以是绿的 | **已修**（B9）：`readArchive` 改用 `parsePyJson` 保留 `PyFloat`；`reviving` 对 JSON 列保留 token、其他列解包；`decodeForDigest` 的 JSON 分支用 `parsePyJson`；`codec.ts::encodeValue('json')` 含 `PyFloat` 时用 `pyJsonCanonical` 写（输出 `40.0`）。修复后 59/59 全等，新增回归测试 `tests/migrate.test.ts`（真实 Python canonical 字符串 + import/reconcile）。这是「哈希一致」第一次在带浮点 JSON 的真实库上成立 |

## R. 异步链接线与 B10 边界（B10 对拍发现）

对拍方式：真实 Django 服务级探针（`scripts/probe_b10_capabilities.py`，一次性 test DB，12 例）、
规划器真实 ORM 夹具 + 真实函数（`scripts/probe_b10_planner.py`，8 weak 候选 / 8 计划任务）、
真实浏览器验收（worker 运行中）、真实文件/真实进程的备份演练。本节只记录**新发现**与**决策**。

| # | 事实 | 为什么要钉住 / 处置 |
|---|---|---|
| R1 | **DSH outbox 有消费者、无驱动**（Q6 的完整形态）：提交/判分/重判入队的 `evidence.rebuild_for_attempt` 只在测试里被 `drain`，真实运行中永不消费 | **已修**（B10）：`startOutboxWorker`（有界、不重叠、可停止、可注入时钟、启动即一拍）在 HTTP surface 挂载后启动，dispose 先停 worker 再关库。测试证明「提交后不手动 drain 也重建证据」且 `as_of` 用的是注入时钟 |
| R2 | **topic 改名 + 归档导入**：`projection.rebuild_attempt_evidence`（Django）vs `evidence.rebuild_for_attempt`（Node）；导入的 pending 行会变未知 topic | **消费时别名**（`TOPIC_ALIASES`）+ **D0 零在途门禁**。**不改写导入行**：`audit_outbox_event` 是归档表，改写会破坏 `reconcileArchive` 的逐行摘要契约。`tutoring.run_job` 没有异步等价物 → handler 主动永久失败并给出重跑路径，不静默确认 |
| R3 | **`plan.generated` 无 handler**：drain 会把它记为永久失败；Django 对应 `learning.reconcile_plan`（同名 topic 有消费者） | **已修**：`plan_reconcile.ts::reconcilePlan` 按 `planner.py::reconcile_plan` 移植（空 plan_id 仍校正延迟任务、缺失计划返回 `plan_missing`、追加审计 note、superseded 判定）。`plan.generated` 与 `learning.reconcile_plan` 共用 handler |
| R4 | **Django 三个能力在 Node 无等价实现**：`projection.regrade_effects` 的证据重建、`projection.rebuild_after_answer_change`、`learning.on_session_finished` | **已补**（B10）：证据重建 + 状态刷新、按答案版本失效证据、逐 attempt 重建+刷新状态。Django 探针 12 例逐字段对拍（`pending_max_score` 取 `previous.max_score`、重复争议只计数、同秒去重键等易错点都钉住） |
| R5 | **Node 手动结束会话漏两步**（新）：`_finish_locked` 还会写 `revealed_at` 并把 origin task 置 completed；旧 Node 只写 `status/finished_at`，也不入队 | **已修**：手动/过期收敛到单一 `finishLocked`；晚于 deadline 的手动结束按 deadline 记 `finished_at`、`expired_at=发现时刻`；`learning.on_session_finished` 以 `session-finished:<id>` 去重 |
| R6 | **`learning-states` 的响应形状缺字段**（新，worker 接线后暴露）：Node 只返回 `detail` 嵌套，Django `states_for_project` 平铺 `missing_evidence`/`independent_attempts`/`thresholds` 并带 `subject_id`/`syllabus_is_user_provisional`/`rule_version`；此前状态表为空走空分支，所以未触发 | **已修**：补齐平铺字段 + `as_of`/`computed_at` 改为 Python ISO；保留 `detail`。浏览器验收 main 由失败转为通过（见 19 §3.1） |
| R7 | **Django 的答案争议没有 HTTP 路由**（新）：`dispute_answer_key_version` 只有 1 处定义 + 5 处集成测试调用、0 处生产调用 | Node **只做 service、不造路由**（与 Django 对齐）；作用域解析（answer→version→question→subject→project，越权 404）是适配点。证据在 `var/b10/f4-probe.md` |
| R8 | **本机退役环境的事实**（新，运维）：db0 有 **108 条 Celery 消息**（projection 58 + ingestion 50）且无消费者；原生 Redis `appendonly no`（AOF 关闭）；Docker daemon 不可达 | **B11 已按用户授权丢弃这 108 条消息**（只删 4 个 AcePass 键，Redis 服务未停；`dsh-plugin/var/b11/redis-discard.json`，之后 db0 `dbsize=0`）。D2 仍不执行：Django 按用户决定保留为对照运行时，Redis/Postgres 仍是它的依赖。D0 只覆盖 SQLite outbox，执行 D0/D1 必须同时检查 broker `LLEN` 与 `celery inspect active` |
| R9 | **规划器 W1/W2 的边界关闭**：weak 分支的选择集是 `needs_review=True`（**不是** `needs_review OR summary in (...)`，后者是 `state.py::weak_nodes`，planner 零调用）；`_question_for_node` active pairing 优先、其后只试**一条** primary published 映射；`deficit_notice` 不拷到任务行；`trigger_event` 空串 | **已对齐**：同一夹具真实 Django vs Node，改前 8 vs 1 候选（12 处差异）、计划任务 56 处差异；改后 **8 vs 8、0 字段差异**，`trigger_event` 两侧 `''`，`allocated_minutes` 42/42。探针 `parity-probe.json` 重跑逐字节一致 |
| R10 | **Django `undiagnosed_candidates` 的 UUID/str 比较缺陷**（新，W3）：`planner.py` 把 UUID 集合与 `str(mapping.node_id)` 比较，永远为 False，已有状态的考点也会被当未诊断；探针 informational 段 Django 11 条 vs Node 0 条 | **已修（B11，用户决定「修复」）**：Django 在入口把 `node_id` 统一为 `str`；Node 重写为「排除任何有状态的节点 + primary published 映射 + 资格检查 + 名称排序 + limit」。探针新增正/负夹具后 **Django 1 = Node 1**、0 差异；连带影响：同一道题会同时进入 `undiagnosed_probe` 与 `general_practice`（Django 跨类别无同题去重，真实探针确认），B8 单测按真相源改为 2 条。见 20 §4 |
| R11 | **备份/媒体/签名**（新能力）：Django 侧没有备份 management command；B9 的备份只含 SQLite | **新增**：`--include-media`（逐文件 sha256/字节数进 manifest、恢复端显式 `--restore-media`、缺失/篡改/多余三类拒绝）、`--keep N`（只删本工具目录）、可选 HMAC-SHA256（有签名无密钥 exit 4、错误密钥 exit 3）。`format_version` 保持 1，B9 产物不改一个字仍可校验。边界：库/媒体非原子快照、恢复非两段式事务、只支持对称 HMAC（19 §8） |
| R12 | **`d0-check --out` 的退出码**（小）：`--out` 指向不存在目录时曾抛裸栈 exit 1（契约是 0/3/2） | **已修**：写文件失败 → 错误信息 + exit 2。主判据（ok/不安全/读不了）不变 |
| R13 | **desktop profile 只能由 Electron 应用加载**（新，运维）：`dsh --profile desktop ...` 直接报 `profile "desktop" is managed exclusively by the Electron application`，包括 `--dump-config`；`~/.dsh/profiles/web` 还有一个 **2026-10-15 起就存在**的坏链：`@deepseek-ai/dsh-subagent-codex` 指向不存在的 `/Users/cololi/OpenSource/deepseek-harness/...`，pnpm 安装后 bundle 对账会因它失败 | **B11**：用应用自己的 Electron Node + `dsh-app-boot` 直接对 desktop profile 做只读组合验证：18/18 bundle 解析、0 skipped、`acepass` 条目进入 223 条 entry 树（应用版本 0.2.2-rc.1）。**没有重启**运行中的应用（会终止本会话），面板需重启后确认。web profile 的安装尝试已原样还原；坏链不在本批次修复范围。见 20 §6 |
