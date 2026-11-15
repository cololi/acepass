# 08 ingestion B0：文本结构解析器与 O06

日期：2026-11-06。范围：阶段 3 的 **ingestion 第一批（B0）**。阶段状态以
[03 迁移方案](./03-dsh-compatibility-and-migration-plan.md) §4 为准，实施规格见
[06-ingestion-port-spec.md](./06-ingestion-port-spec.md)。本文只记录本批次做了什么、凭什么算完成、还差什么。

## 0. 一句话结论

`backend/apps/ingestion/services/text_parser.py` 的**整个模块**（6 个公开函数 + 全部私有 helper）已逐行移植，
并由真实 Python 函数生成的 151 组黄金向量对拍；O06 `POST .../imports/parse-text` 已挂到进程内路由。
`npm run verify` 双运行时 **328 条测试全绿 + Cordis 加载烟测通过**（314 → 328）。

操作数按规格 §0 更正为 **20 个**（不是任务描述里的 14 个）：本批次完成 **1/20**，其余 19 个按 B1–B5 推进。

## 1. 本批次完成面

| 交付 | 位置 | 说明 |
|---|---|---|
| Python 字符串语义 | `src/domain/ingestion/pystring.ts` | `splitlines`（`\r\n`/`\v`/`\f`/`\x1c-\x1e`/`\x85`/`\u2028`）、按**码点**的 `len/slice/find`、`rstrip(chars)`、Python 的 `\s`/`\d`/`\w` 字符类、Unicode `\b` 构造 |
| 解析器 | `src/domain/ingestion/text_parser.ts` | `parsePaste`、`parseAnswerPage`、`applyAnswerMatches`、`attachSourcePages`、`detectPageContinuations`、`attachCrossPageContinua`、`normaliseAnswerMap` |
| O06 路由 | `src/http/ingestion_routes.ts` | 项目作用域 → `TextParseIn` 校验 → `{count, segments}`；**零写入** |
| 黄金向量 | `tests/golden/ingestion_text.json`（生成器 `scripts/gen_ingestion_text_golden.py`） | 52 条粘贴样例 × 2 种模式（共 104 条向量）、19 条答案页、8 条匹配、6 条来源页、9 条跨页断点、5 条跨页切片 |
| 测试 | `tests/ingestion_text.test.ts`、`tests/ingestion_http.test.ts` | 逐字段对拍 + 5 条 HTTP 黑盒（形状/零写入/空文本/越权/参数错误） |

## 2. 为什么这算"移植"而不是"重写"

生成器 `scripts/gen_ingestion_text_golden.py` 先 `django.setup()`，再**直接调用** `text_parser` 的真实函数，
把返回的 dict 原样写进 fixture；TypeScript 侧只读 fixture 断言，不在测试里重算期望值。因此：

- 任何分支差异都会在 151 组向量里显形，而不是靠人读代码判断"看起来一样"；
- 生成器可重跑（`npm run golden:ingestion-text`），Python 侧行为若变更，fixture 会随之变化而不是继续撒谎。

覆盖的**易错语义**（不是 happy path）：

| 语义 | 为什么必须钉住 |
|---|---|
| Python `\b` 是 Unicode 词边界 | `选A项` 在 Python 里**没有**边界，答案解析为"未匹配到选项"；JS 的 ASCII `\b` 会误读成 A。已有独立测试钉住 |
| 码点偏移 | `source_char_start`/`source_char_end`/`[:1000]`/`[:2000]`/`[:40]` 全部按码点；emoji 前缀会让 UTF-16 下标偏移，向量里显式包含 astral 字符 |
| `\s` 集合 | Python 的空白含 `\x1c-\x1f`、`\x85`、`\u3000`，不含 JS 的 `\uFEFF`；标签、选项、题号解析全依赖它 |
| `str.splitlines()` | `\r\n`、`\v`、`\f`、`\u2028` 都断行；只按 `\n` 拆会改变 segment 边界 |
| 无 `$` 收尾的空行 | `parse_answer_page` 的"多行答案合并"只在遇到下一个编号时断开，空行不结束——按行循环必须复刻 |
| 材料块状态机 | 父子 `local_id`、`child_local_ids`、未知标签归材料、`【材料一】/【材料二】`、数字子题、无编号子题、孤立子题被丢弃，全部按原状态机 |
| 答案匹配的消费顺序 | 同号重复标签回退到按位置匹配；材料父题跳过；已消费条目不再参与——顺序错一位就会把 A 题的答案贴到 B 题 |

## 3. O06 与 Django 的参数错误形状

- 路径：`POST /api/acepass/projects/{project_id}/imports/parse-text`（Django 基线 `/api/v1/...`）。
- 请求体 `{"text": string}`；缺字段 / 非字符串 / body 不是对象的 400 与 Ninja **同形**：
  `invalid_input` + `请求参数校验失败` + `details.errors=[{type,loc,msg}]`。
  **B1 实测更正**：`loc` 是 `["body","payload","text"]`（Ninja 的 flatten map 会带上参数名 `payload`），
  完全无 body 时是 `["body","payload"]`，数组/标量 body 被当成空对象（必填字段报 `missing`）。
  B0 最初按 `["body","text"]` 实现，已在 B1 修正并更新测试（见 [04 §I1](./04-parity-findings.md)）。
- 预览不创建 document/job/candidate/region/asset，也不写幂等 claim；测试对比**全部 57 张表**的行数前后一致。
- `parse=false` 是 O07 的字段，O06 的 `TextParseIn` 只有 `text`；多余字段被忽略（与 pydantic 默认一致）。

## 4. 传输边界（与上一批相同的宿主约束）

O06 的路径含 `:project_id`，DSH 的 `connection.fetch` 注册表按**精确 pathname** 索引，无法挂载
（`src/index.ts` 仍只注册静态路径）。本批次**只声称进程内 Request→Response 可达**，不声称 GUI/宿主可达；
参数化 REST 统一由阶段 6 的 Remote 通道承接（03 §F8）。O06 的 `EventSource`/前端调用在宿主切换前不会工作，这是已知且已记录的边界。

## 5. 验证

```bash
cd dsh-plugin
npm run golden:ingestion-text   # 重新生成 151 组向量（需要 backend/.venv）
npm run verify                  # typecheck → build → 328 测试（系统 Node）→ 328（DSH Electron Node）→ 加载烟测
```

结果：`328 pass / 0 fail`，`load-smoke OK`。schema 变更**只新增两张 through 表**（见 §8），没有列变更、没有数据迁移；
已有 `.acepass` 库打开时由幂等 DDL 自动补表。

## 6. 未完成 / 下一批前置

- **B1 的第一个前置**：两张 Django 自动 M2M through 表（`import_job_documents`、`import_candidate_source_regions`）
  尚未进入 `gen_schema.py` 的枚举与归档，`export_db.py` 会把它们导出为空并标 `no_model`。这是**归档数据丢失点**，
  必须先修 schema 生成器与归档覆盖，才能写 ingestion 的 job/candidate 服务。
- B1 范围：ingestion core/serializers + O03/O04/O07/O10–O17（文本导入、文档查询、候选 revision/ignore/layout-confirm），
  不依赖 LLM/PDF/sharp。
- 明确的"不做"：PDF 版式解析（B4）、图片/PDF 上传与私有存储（B3）、发布写集（B2）、AI 变式与异步 extraction（B5）；
  这些操作的请求字典与幂等 scope 已在规格 §1–§2 固定，实现时不得自行发明字段。

## 7. 回滚面

业务代码是**只新增文件**并在 `src/http/routes.ts` 追加一行 `...ingestionRoutes()` 的纯增量：
回滚 = 删除 `src/domain/ingestion/`、`src/http/ingestion_routes.ts`、两个测试、fixture 与生成器，
并移除 `routes.ts` 的 import/spread 与 `package.json` 的 `golden:ingestion-text`。

schema 变更（§8）不是纯增量：`schema.generated.ts` 多了两张表与两条唯一约束，`gen_schema.py`/`export_db.py` 改了枚举方式。
回滚 schema = 还原三个生成器/脚本改动并重跑 `npm run schema`，再把 `schema.test.ts`/`constraints.test.ts`/`store_file.test.ts`
的计数断言改回 57/31/58——注意这会让归档重新丢掉 through 表，只应在确认 B1 不继续时做。

## 8. 已完成的 B1 前置：两张自动 M2M through 表

规格 §0.1 指出的归档缺口**本批次一并修掉**，否则 B1 的 job/candidate 服务无法落库：

| 改动 | 位置 | 效果 |
|---|---|---|
| 枚举自动模型 | `scripts/gen_schema.py::collect_models` | `get_models(include_auto_created=True)` + 只收父表都在本 schema 内的 through 表；`accounts_user_groups`/`accounts_user_user_permissions` 因引用未移植的 `auth_group`/`auth_permission` **明确排除**（避免悬空外键） |
| through 表唯一对 | `scripts/gen_schema.py::build_table` | Django 把 M2M 唯一性放在 `_meta.unique_together`，不在 `meta.constraints`；新增分支按 Django 的 `_create_index_name + _uniq` 命名规则生成 `..._<digest>_uniq`，否则同一 (job, document) 可以重复插入 |
| 归档导出 | `scripts/export_db.py` | 同样的 `include_auto_created=True`，两张表不再导出为空并标 `no_model` |

结果：schema 从 57 张声明模型表变为 **59 张表 / 334 索引 / 33 唯一约束 / 6 检查约束**（+2 表、+4 索引、+2 唯一），
`TABLES.length=59`；`constraints.test.ts` 的两条 through 唯一约束也被"违反即拒绝"覆盖。
现有 `.acepass` 库无需迁移：`applySchema` 的 DDL 全是 `CREATE ... IF NOT EXISTS`，打开时自动补表。

仍然**未做**：`auth_group`/`auth_permission` 与 `accounts_user_groups` 三张 Django 内置表（DSH 拥有身份，移植不使用组/权限）；
它们若是 Django 归档的必需部分，应在 B1 的归档对账里显式列出而不是静默漏掉。
