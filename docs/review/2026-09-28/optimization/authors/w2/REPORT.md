# W2 热读路径 N+1 消除 — 证据包（backend-queries / task-2）

日期：2026-09-28 · 分支：main · 起点 `fe68b07`（工作区含 W1/W3 未提交改动）

## 1. 改了什么（写范围：backend/apps/**，audit/ 除外）

| 文件 | 改动 |
|---|---|
| `backend/apps/question_bank/api.py` | `list_questions`：`select_related("current_published_version")` + 两个相关子查询（最新版本号/题型）+ `Prefetch(to_attr)` 一次取本页的受信答案键与主考点映射 |
| `backend/apps/practice/api.py` | `list_sessions`：`annotate(item_count=Count("items", distinct=True), submitted_count=Count("items__attempt", distinct=True))` + `Prefetch(items)` 一次取本页所有题项（逐项门禁判断原样保留） |
| `backend/tests/integration/test_read_path_query_budget.py` | 新增 6 条回归测试（见 §4） |
| 迁移 | **无**（见 §6：EXPLAIN 未发现需要新索引的计划） |

未触碰：`backend/apps/audit/**`（W1）、`frontend/**`（W3）、`backend/perfprobe/**`（Lead 量尺）。

## 2. 查询数与耗时（同一条命令：`bash scripts/dev/measure-hot-paths.sh`）

夹具：demo 内容 + 20 个练习会话。原始数据 `var/perfprobe/baseline.json`（before）、`var/perfprobe/after-w2.json`（after）。

| 用例 | before 查询/中位 | after 查询/中位 |
|---|---:|---:|
| `questions_list` | **123** / 41.09 ms | **7** / 7.41 ms |
| `practice_sessions_list` | **67** / 19.85 ms | **8** / 6.26 ms |
| `grading_queue` | 7 / 7.65 ms | 7 / 6.77 ms |
| `memory_cards` | 5 | 5 / 4.57 ms |
| `knowledge_map` | 11 | 11 |
| `knowledge_nodes` | 12 | 12 |
| `today_plan` | 11 | 11 |
| `reports_practice` | 18 | 18 |
| `search_hybrid` | 6 | 6 |
| `question_families` | 5 | 5 |

目标 ≤12 均达成（7 和 8）。耗时受同机其他工作流影响有抖动：同一 `after-w2` 命令两次运行分别为 5.88/5.76 ms 与 7.41/6.26 ms，均远低于基线。

**与行数无关**（回归测试实测，HTTP 全路径含鉴权/中间件）：

- `questions_list`：6 行 26 queries → 12 行 26 queries；夹具直接调用 20 行 100 → 4、24 行 120 → 4。
- `practice_sessions_list`：4 行 19 queries → 8 行 19 queries；夹具直接调用 20 行 64 → 5。

## 3. 行为不变证据

### 3.1 10 个端点的响应体 before/after（`var/perfprobe/before|after/`）

`python3 var/opt-w2/diff_bodies.py` → 全部 `OK`（见 `var/opt-w2/body-diff.txt`）。两种口径：

- `positional`：UUID/ISO 时间戳按首次出现次序替换为占位符后逐行相同 → 字段名、字段顺序、数值、行序均未变；
- `projection`：把所有 UUID/时间戳剔除后，剩余标量序列完全相同 → 再排除"占位符编号恰好掩盖了行重排"的可能。

剔除项说明：两次运行使用各自新建的测试库，行主键与时间戳天然不同，因此归一化时**只**替换 UUID 与 ISO 时间戳，其余（含布尔、枚举、计数、字符串、`null`、数组长度与顺序）一律逐字符比对。

### 3.2 同库同行的 legacy↔live 逐字节比对（无任何归一化）

`var/opt-w2/snapshot/test_read_path_snapshot.py` 内置 `fe68b07` 版 `list_questions`/`list_sessions` 原文副本，
在同一次运行、同一批行上对比新旧实现：**12 个变体全部 `byte_equal: true`**（见 `var/perfprobe/after/_summary.json`）。

| 变体 | 行数 | legacy queries | live queries | byte_equal |
|---|---:|---:|---:|---|
| questions_list[default] | 20 | 100 | 4 | true |
| questions_list[subject] | 12 | 62 | 5 | true |
| questions_list[question_type] | 6 | 32 | 4 | true |
| questions_list[status_published] | 20 | 100 | 4 | true |
| questions_list[origin_type] | 20 | 100 | 4 | true |
| questions_list[search] | 4 | 22 | 4 | true |
| questions_list[page] (limit3/offset2) | 3 | 16 | 4 | true |
| questions_list[page_wide] (limit50) | 24 | 120 | 4 | true |
| questions_list[empty_page] (offset 1000) | 0 | 2 | 2 | true |
| practice_sessions_list[default] | 20 | 64 | 5 | true |
| practice_sessions_list[subject] | 20 | 65 | 6 | true |
| practice_sessions_list[page] (limit3) | 3 | 13 | 5 | true |

`question_type`/`status` 变体走的是 `.distinct()` 分支，`empty_page` 走的是"本页无行、预取短路"分支。

## 4. 回归测试（`backend/tests/integration/test_read_path_query_budget.py`，6 条）

| 测试 | 作用 |
|---|---|
| `test_questions_list_query_count_does_not_grow_with_rows` | 行数翻倍查询数必须相等且 ≤12 |
| `test_practice_sessions_list_query_count_does_not_grow_with_rows` | 同上（sessions） |
| `test_practice_sessions_keep_the_per_item_gate` | 运行中的验证只封住它覆盖的那条题项：同题会话 `grading_hidden` 变 true、无关内容仍 false |
| `test_questions_list_payload_is_exactly` | 6 行黄金载荷（含字段顺序断言），覆盖：有发布版+更新草稿、仅草稿、无版本、答案有争议、答案待核对、双主考点排序 |
| `test_practice_sessions_list_payload_is_exactly` | 4 行黄金载荷（含字段顺序断言），覆盖 practice/mock_exam/finished/active |
| `test_empty_session_and_page_past_the_end` | 0 题项会话计数为 0；空页/空科目不受预取影响 |

**先红后绿**：文件写在改代码之前，先在未优化代码上运行，输出存 `var/opt-w2/red-before.txt`：

```
E  AssertionError: questions_list issued 26 queries for 6 rows and 56 for 12 rows: the endpoint still queries per row
E  AssertionError: practice_sessions_list issued 19 queries for 4 rows and 31 for 8 rows: the endpoint still queries per row
2 failed, 3 passed
```

优化后：`6 passed`。（`red-before.txt` 捕获时尚无第 6 条边界测试，故为 3 passed。）

## 5. 门禁

| 命令 | 结果 |
|---|---|
| `POSTGRES_DB=acepass_opt_q POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest tests -q` | **500 passed, 3 warnings in 269.84s**（基线 489；其中 6 条为本任务新增，其余增量为 W1 同期新增的 outbox 测试；无 skip、无 fail） |
| `POSTGRES_CONN_MAX_AGE=0 .venv/bin/ruff check apps tests` | All checks passed |
| `DJANGO_SETTINGS_MODULE=config.settings.dev POSTGRES_CONN_MAX_AGE=0 .venv/bin/python manage.py check` | System check identified no issues |
| `... manage.py makemigrations question_bank practice --check --dry-run` | No changes detected（只对本任务涉及的两个 app 跑） |

## 6. EXPLAIN 证据与"不加索引"的决定

- `var/opt-w2/explain-plans.txt`（夹具规模）：questions 本页 3 条查询；主查询用
  `Index Scan question_bank_question_subject_id_*` + `question_bank_question_version_pkey`，
  两个"最新版本"相关子查询走 **`Index Only Scan Backward using uniq_question_version`**（(question, version) 唯一索引，O(log n)）；
  答案键预取走 `question_bank_answer_key_verification_status_*` 索引。sessions 本页 2 条查询，
  主查询走 `practice_session_project_id_*`，题项走 `practice_session_item_session_id_*`，attempt 走一对一唯一索引 `practice_attempt_session_item_id_key`。
  仅有的顺序扫描发生在 28–54 行的字典/夹具小表上。
- `var/opt-w2/explain-at-scale.txt`（5000 题）：questions 本页 1 条主查询 2.06 ms，仍全部走索引，无顺序扫描。
- `var/opt-w2/bench-scale.txt`（20000 会话 / 40000 题项 / 10000 作答，同一夹具跑两次，反映同机负载抖动）：

  | 形状 | 查询数 | 中位耗时（run A / run B） |
  |---|---:|---:|
  | legacy（逐行 `.count()`） | 154 | 554.42 / 132.54 ms |
  | join + GROUP BY `Count(distinct=True)`（**采用**） | 2 | 72.26 / 65.38 ms |
  | 相关子查询 `Coalesce(Subquery(...))`（备选，已否） | 2 | 92.69 / 85.83 ms |
  | 端点处理函数实调用 | 5 | 79.41 / 69.39 ms |

  legacy 的耗时几乎全是 154 条查询的往返开销，因此对同机负载最敏感（132–554 ms）；
  两种新形状在大表上都只发 2 条查询、耗时 65–93 ms，且载荷与 legacy 逐字节一致。
  子查询备选在两次运行中都慢 25–32%，故保留更简单、更快且更 Django 惯用的 GROUP BY 写法。

**结论：没有加任何索引，也没有生成迁移**——没有出现顺序扫描大表或昂贵计划，两个目标查询的相关子查询/连接全部命中既有唯一索引与 FK 索引。

## 7. 复现步骤

```bash
cd backend

# 1) 基线与 after（量尺，独占库）
POSTGRES_DB=acepass_perfprobe PERFPROBE_LABEL=after-w2 bash ../scripts/dev/measure-hot-paths.sh

# 2) 回归测试（先红后绿）
POSTGRES_DB=acepass_opt_q POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest -c pytest.ini \
  tests/integration/test_read_path_query_budget.py -q

# 3) 响应体快照与逐字节比对
SNAPSHOT_OUT=../var/perfprobe/after POSTGRES_DB=acepass_opt_q_snap POSTGRES_CONN_MAX_AGE=0 \
  .venv/bin/python -m pytest -c pytest.ini ../var/opt-w2/snapshot/test_read_path_snapshot.py -q -s
python3 ../var/opt-w2/diff_bodies.py

# 4) EXPLAIN / 规模基准
POSTGRES_DB=acepass_opt_q_explain POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest -c pytest.ini \
  ../var/opt-w2/explain/test_explain_read_paths.py -q -s
POSTGRES_DB=acepass_opt_q_bench POSTGRES_CONN_MAX_AGE=0 .venv/bin/python -m pytest -c pytest.ini \
  ../var/opt-w2/bench/test_bench_sessions_scale.py -q -s
```

## 8. 遗留风险

1. **跨运行快照的 UUID/时间戳**：§3.1 的 before/after 只能做归一化比对；同一批行的严格逐字节结论来自 §3.2。
2. **群组聚合随会话数线性**：`practice_sessions_list` 的 COUNT 需要聚合该用户在该项目的全部会话后再 `LIMIT`。
   20k 会话实测 72 ms（legacy 554 ms），单用户会话量再高一个数量级时值得重估；届时的候选是
   `(user, project, -created_at)` 复合索引或改成"先取页、再按页内 id 求计数"，但**当前没有计划证据支持**，故未做。
3. **`content_map` 非空时的门禁**：合并后的实现仍在页内逐项调用 `content_gate_blocks_item`，
   并保留了 `select_related("question_version")`；但本任务只在"精确版本覆盖"上加了反例测试，
   family/lineage 扩展路径依赖 W4 的独立复验。
4. **同机并发**：耗时数字与其他工作流同机运行，存在抖动；查询数不受影响。
