# 代码结构与模块关联清理轮 — 交付记录（2026-11-09）

起点工作树：`7b41d19` + 已存在的未提交前端主题/迁移改动。
本轮**不新增业务能力**：只做结构清理与有测量证据的提速，不放宽任何既有门禁。

> 说明：工作区在本轮开始前就带着一组未提交改动（`frontend/src/app/AppShell.tsx`、
> `frontend/src/main.tsx`、`frontend/src/styles/app.css` 的主题重做，以及
> `backend/apps/learning/services/planner.py` 的 12 行改动）。本轮的改动叠在它们之上，
> 轮次自身的 diff 以下文清单为准，不要把主题重做算进本轮。

## 1. 门禁结果（全部为 Lead 实跑）

| 门禁 | 结果 |
|---|---|
| 后端全量 `pytest tests -q` | **501 passed**，138.01s（`POSTGRES_DB=acepass_final`） |
| `ruff check .` | All checks passed |
| `manage.py check` | no issues (0 silenced) |
| `makemigrations --check --dry-run` | No changes detected |
| 归档反例三组 | **11 passed / 9 passed (+1 deselected) / 3 passed**，`GATE OK` |
| 归档 p0 参考文件（不计门禁） | 13 passed / 1 failed（与基线记录一致） |
| 前端 `tsc --noEmit`（root / app / node 三工程） | exit 0 |
| 前端 `vitest run` | 5 passed |
| 前端 `vite build` | ✓ 752ms |
| 既有测试文件被修改 | **无**（`git diff --stat -- backend/tests frontend/tests backend/perfprobe` 为空） |

**未执行**：浏览器验收主套件（需要独占锁 `var/locks/browser-acceptance.lock` 与专门的批次服务，
本轮未占用）；真实模型凭据、真实 ≥24 小时学习效果、真实考试材料、远程 CI —— 与上轮一致，仍然未验证。

## 2. 结构清理

### 2.1 `ai/prompts/registry.py`：1049 行 → 7 个提示族模块 + 57 行显式桶

一次提示词修改要翻完整份千行文件，且七个互不相关的厂商提示混在一起。按提示族切开：

| 模块 | 行数 | 内容 |
|---|---:|---|
| `ai/prompts/extraction.py` | 71 | P0 图片→结构化候选的提示与校验 |
| `ai/prompts/explain.py` | 121 | P0 讲解提示与校验 |
| `ai/prompts/tags.py` | 81 | P1 大纲标签建议 |
| `ai/prompts/transcription.py` | 52 | P1 手写转写 |
| `ai/prompts/estimation.py` | 112 | P1 AI 估分 |
| `ai/prompts/diagnosis.py` | 125 | P1 AI 诊断 |
| `ai/prompts/variant.py` | 490 | P2 变式题（提示 + 内容契约 + 校验） |
| `ai/prompts/registry.py` | 57 | **兼容桶**，逐个名字再导出 |

八个调用点都写 `from ai.prompts import registry as prompts`，因此桶必须保留全部公开名。
校验方式：用 `ast` 取原始模块的 35 个顶层声明，逐一确认在桶里可解析（6 个 `_` 私有常量按设计不外露，
仓库内无外部引用）；再跑 44 条提示词相关用例，全绿。
`ast` 取精确行范围，保证没有一行被丢掉或写重。

### 2.2 重复实现合并成一个家

审计在 AST 层面确认了这些是**逐字相同**的函数体，此前被复制到多个 app：

| 重复项 | 原位置 | 归并到 |
|---|---|---|
| `_strip_code_fence` ×4 | practice `transcription`/`estimation`/`diagnosis`、tutoring `core` | `ai/validators/response_text.py` |
| `_blocks_text` ×2（+1 个纯转发包装） | `ai/prompts/registry.py`、`question_bank/services/variants.py` | `ai/validators/response_text.py` |
| `_record_call` ×3 | practice 三个 AI 服务 | `apps/audit/services/llm_runs.py` |
| `_record_failure` ×3 | 同上 | 同上 |
| `_model_identifier` ×2 | practice `estimation`/`diagnosis` | 同上 |

`ai/validators/response_text.py` 的文档字符串写明了**故意保留的三种变体**及其理由：
tutoring 的渲染要为图片块输出占位符（否则提示词看起来完整、模型却少了内容）、
knowledge 的渲染要扩展开 `list` 块并读 `value`、search 的渲染返回可索引字符串列表。
把这三个"合并"会静默改变提示词，属于 bug 而不是清理，所以它们留着并在原处说明。

`test 保留口径`：`apps/ingestion/services/extraction.py:335` 的变体用 `rstrip` 语义，与其它四份**不等价**，
保持原地不动。

### 2.3 空包与死结构

删除 `backend/domain/evidence/`、`backend/domain/planning/`：各自只有一个 0 字节 `__init__.py`，
grep 全仓 0 引用。

### 2.4 前端 `src/api/client.ts`：2932 行 → 39 行兼容桶 + 15 个模块

这是全仓最大的单体模块：189 个导出（106 类型 + 83 运行时值）、23 个引用点，
其中一半以上是某个懒加载路由才用得到的实现，却因为住在入口模块里被一起打进首屏。

| 模块 | 行数 | 职责 |
|---|---:|---|
| `api/transport.ts` | 113 | 请求管线：`apiRequest`、`ApiError`、CSRF 单例、幂等键 |
| `api/types/study.ts` | 382 | 账号/项目/题目/作答/计划 DTO（纯类型，零运行时） |
| `api/types/records.ts` | 385 | 报告/导入/试卷/队列/知识 DTO（纯类型） |
| `api/knowledge.ts` | 130 | 考点关系、前置、标签建议 |
| `api/search.ts` | 91 | 混合检索与重建索引 |
| `api/memory.ts` | 145 | FSRS 记忆卡 |
| `api/ai-assist.ts` | 468 | 转写、估分、诊断、讲解片段 |
| `api/imports.ts` | 128 | 版式复核、导入任务与候选 |
| `api/exposure.ts` | 138 | 题目暴露与污染证据 |
| `api/questions.ts` | 311 | 封存与题族 |
| `api/variants.ts` | 225 | AI 变式 |
| `api/practice.ts` | 156 | 考试时钟、已发布题目、模考 |
| `api/errors.ts` | 67 | 面向用户的错误文案 |
| `api/reports.ts` | 236 | 覆盖率、效果校准、表达式复核 |
| `api/normalize.ts` | 24 | 三个共享的 JSON 收敛器（原住在 AI 模块里，被四个域借用） |
| `api/client.ts` | **39** | 兼容桶，逐个名字显式再导出，**不用 `export *`** |

后端行为等价性的做法：切分是**逐行搬移**（脚本按行范围切片，不改一行代码），随后用
`tsc` 作为 oracle 补齐跨模块 import，最后逐个 name 核对导出集合 189 = 189、缺 0、多 0。

## 3. 提速（数字）

### 3.1 后端查询数（`scripts/dev/measure-hot-paths.sh`，同一命令前后各跑一次）

| 用例 | before | after | 说明 |
|---|---:|---:|---|
| `knowledge_nodes` | 12 | **5** | 每个考点一次 `.count()` → 一次带 `filter` 的 `Count` 注解 |
| `knowledge_map` | 11 | **7** | 同上 |
| `practice_sessions_list` | 8 | 8 | 上一轮已修，本轮不动 |
| `questions_list` | 7 | 7 | — |
| `reports_practice` | 18 | 18 | 仍有 N+1，见 §4 |
| `grading_queue` / `memory_cards` / `today_plan` / `question_families` / `search_hybrid` | 7/5/11/5/6 | 同 | 探针夹具为空，改动的收益在这里看不出来（见下表） |

> **口径**：查询数是确定性指标，可复跑。延迟列**本轮不可用** —— before 那次采集时四个审计进程
> 同时在跑（299–404 ms），after 时机器空闲（3–14 ms），两者不可比，因此不列延迟。
> 上一轮在安静机器上对同样查询数的记录是 1.6–7.7 ms。

探针夹具为空、因而必须单独测量的四项（由执行者在带有数据的确定性夹具上测得，响应体逐字节比对通过）：

| 端点 | before | after | 夹具 |
|---|---:|---:|---|
| 练习会话详情 (`session_state`) | **44** | **8** | 20 项（16 已评分） |
| 同上，小夹具 | 15 | 8 | 4 项 —— 证明不再随行数增长 |
| 变式任务列表 (`variant_jobs`) | **25** | **6** | 20 任务 × 5 候选 |
| 题目来源区域 (`list_source_regions`) | **10** | **7** | 4 版本 × 3 链接 |

另有四处按行数线性增长的查询被改成常数（由代码结构证明，未单独计时）：

| 位置 | 原来 | 现在 |
|---|---|---|
| `apps/tutoring/api.py` 辅导会话列表 | 每行 3 条（`count` + `exists` + `first`） | `Count` + `Subquery` 注解，0 条额外 |
| `apps/ingestion/services/imports.py` 导入任务列表 | 每任务 3 条 | 2 条批次查询 |
| `apps/ingestion/services/imports.py` 候选列表 | 每候选 2 条 | 2 条批次查询（带顺序的 `Prefetch(to_attr=...)`） |
| `apps/learning/services/planner.py` 今日计划 | 每任务 1 条反查复习任务 | `select_related("review_task")`，0 条额外 |
| `apps/practice/api.py` 评分队列 | 每行 1 条取评分标准 | `select_related("session_item__rubric_version")`，0 条额外 |

一条口径提醒：`apps/practice/services/sessions.py` 的 attempt 查询保留下来没合并，
因为它的累加顺序会影响总分展示；只把「逐项回读 attempt 与当前评分事件」变成 join。

### 3.2 前端首屏包体

| 产物 | before | after | 变化 |
|---|---:|---:|---|
| **入口 `index-*.js`** | 43,143 B | **22,275 B** | **−20,868 B（−48.4%）** |
| 合计 JS | 894,962 B | 896,674 B | +1,712 B |
| JS 分块数 | 19 | 24 | +5 |
| CSS 合计 | 51,489 B | 50,731 B | −758 B |

口径：少掉的 20.9 KB 是**首屏传输量**，不是从整个应用里删除；总量略增是模块与分块管线开销。
五个新增分块（`questions-`、`variants-`、`reports-`、`exposure-`、`imports-`）由懒加载路由按需拉取。

### 3.3 前端渲染成本

| 改动 | 原问题 | 现在 |
|---|---|---|
| 考试倒计时隔离 | 每 500 ms 触发整页（1574 行）重渲染，连带重建封存 ID 集合与考试题池 —— 约 **120 次/分钟** | 只有标签自己的小组件重绘；到达截止时间时向父组件发一次信号，父组件才重渲染并执行原有的对账。终态后不再有定时器 |
| 知识页二次复杂度 | 每个考点一次 `states.find`，O(节点 × 状态) / 渲染 | 记忆化的 `stateByNodeId`，O(节点 + 状态)；另加 4 个记忆化派生值（可编辑节点表、祖先路径标签、移动选项、标签建议排序） |
| 项目切换重复请求 | 选择器与 effect 各自发一次 subjects GET（**2 次**），且旧响应可能覆盖新响应（只有失败分支有守卫） | 单一 owner，项目切换 **1 次** GET；成功分支也按代际丢弃过期响应（**这是本轮唯一的语义修复**） |
| 死 CSS | — | 删除 5 条规则 / 44 行（`.attachment-list`、`.modal` 等），经全 `src/**`（含动态 className 常量）核实无引用 |

## 4. 本轮没做的事（以及为什么）

| 项 | 原因 |
|---|---|
| 拆 `apps/practice/api.py`（1213 行） | ninja 的 operation id 由模块路径推导（今天是 `apps_practice_api_create_session`）；把它拆成 `api/sessions.py` 会让 OpenAPI 里**每个** operation id 改名，并同时动到多个既有 monkeypatch 接缝与注册顺序。收益是整洁度、代价是公开 API 面变动，判断为不值得在本轮承担。审计里的逐符号拆分方案已记录，可作为独立一轮 |
| 统一三个 `_new_run` | 三者只有 capability/提示版本/模型字段不同，但转写取的是 `vision_model`。共享工厂要么把 `TRANSCRIBE_CAPABILITY` 复制进 `audit`（正是本轮要消掉的漂移），要么把三函数模块的契约撑大。属设计决策，不是合并 |
| 7 个未用的 CSS 工具类 | `docs/dsh-migration/22-...` 把它们指定为替换 40 处硬编码浅色的词表，且 `dsh-plugin/src/client/app/styles/app.css` 与本文件**逐字节相同**、其页面已在用。单侧删除会让镜像失步，需一次覆盖两棵树的决定 |
| D18 provider 超时缺陷 | 实测：20 ms 截止时间 + 150 ms 的 provider 会 **165 ms** 才返回（executor 退出时等线程）。这是真 bug，但修复要改执行器生命周期，属行为变更，只记录不改 |
| 其余 N+1（报告映射 D02、效果校准 D09、题族 D14 等） | 都需要逐字节等价证明，且涉及历史修订与 Decimal 顺序语义；本轮时间用于把已有证据的 7 项做扎实 |
| 提交 | 本轮未执行 `git commit`。工作树里既有本轮的改动，也有开始前就存在的主题重做，混在一个提交里会把两件事绑死，交由人决定如何切分 |

## 5. 限制（如实登记）

1. 查询数可靠，**延迟不可比**（见 §3.1 口径）。
2. 前端渲染次数的下降是**结构性验证**（`setInterval` 全仓只剩倒计时组件内一处、派生值改记忆化），
   不是浏览器实测 —— 本仓没有 DOM 测试环境（`vitest` 为 `environment: 'node'`，无 jsdom），
   而安装测试依赖超出本轮范围。
3. `QuestionSourceLink` 没有 `Meta.ordering`，旧的逐版本读取其实按计划的 join key（`region_id`）返回。
   执行者用「UUID 逆序 + 同区域并列」的夹具实测确认过，因此 prefetch 显式钉住 `order_by("region_id")`：
   今天的字节相同，不再是计划依赖。
4. `candidate_status_counts` 的键顺序来自集合推导（受 `PYTHONHASHSEED` 影响），这是**既有**行为，
   改动前后都在，本轮未动。
5. 浏览器验收主套件本轮未跑（需要独占锁与专门批次），因此前端只到 `tsc` / `vitest` / 构建这一层。
