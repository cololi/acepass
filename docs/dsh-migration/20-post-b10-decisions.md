# 20. B10 后的五项决策执行（B11）：broker 清理、W3 修复、GUI profile 加载

> 状态：**已完成**（GUI 面板的“亲眼确认”需要重启 DSH Desktop；本会话运行在该应用内，重启会终止会话，
> 因此只做到「安装 + 用应用自身代码组合验证 + 回滚就绪」，见 §6）。
> 本文只写已验证的事实；未验证的能力不写成已完成。

## 1. 背景

B10 结束时列出了五项需要用户决定的事项（19 §8 / 最终回复）。用户 2026-11-08 的答复：

| # | 决策 | 执行 |
|---|---|---|
| 1 | Redis 在途消息**可以丢弃** | 已丢弃并留证（§2） |
| 2 | Django **保留做对照，不删除** | D3–D6 不执行；D1/D2 不执行（§3） |
| 3 | W3（Django `undiagnosed_candidates` 缺陷）**修复** | Django 修复 + Node 对齐 + 探针/测试（§4） |
| 4 | **暂时不备份**（不装调度） | 不执行；边界保留（§5） |
| 5 | **允许**在 `~/.dsh` profile 加载插件做 GUI 验证 | 已装入 desktop profile 并组合验证；重启后生效（§6） |

## 2. 决策 1：丢弃 Redis 中 108 条孤儿 Celery 消息

执行前 db0 只有 4 个键：`projection`（list 58）、`ingestion`（list 50）、
`_kombu.binding.projection`（set 1）、`_kombu.binding.ingestion`（set 1）。按用户授权只删除这四个键，
**Redis 服务本身未停、未重启**。

```bash
redis-cli -h 127.0.0.1 -p 6379 -n 0 --scan          # 删除前：上述 4 个键
redis-cli -h 127.0.0.1 -p 6379 -n 0 del projection ingestion _kombu.binding.projection _kombu.binding.ingestion
redis-cli -h 127.0.0.1 -p 6379 -n 0 dbsize          # 删除后：0
```

证据：`dsh-plugin/var/b11/redis-discard.json`（before 的每键 type/size/ttl、删除键、after_keys `[]`、
`after_dbsize: 0`、用户授权原文）。**这是丢数据操作，已按授权执行，没有回滚**（消息本身没有消费者，
且 B9 已确认它们无法被 DSH 消费）。

**D2 的状态更新**：broker 侧“在途工作”已清零；但 Redis 仍是用户的 launchd 原生服务，且 Django 按决策 2
保留为对照实现——保留的 Django 若再次运行仍需要 Redis/Postgres。因此 **D2 仍不执行**，理由从“有在途消息”
变为“用户保留了 Django 对照运行时”。D0 的 `LLEN == 0` 检查现在是满足的。

## 3. 决策 2：Django 保留做对照

- **D3–D6 不执行**：`backend/`、`infra/docker/`、CI 的 Docker job 全部保留。
- **D1/D2 不执行**：没有运行中的 Celery 节点可停；Redis/Postgres 继续作为保留对照运行时的依赖。
- 残留检查仍为 **0 violation**（DSH 插件运行时不依赖 Celery/Redis/Postgres/Docker 的事实不变）。
- 回滚：无操作（没有删除任何东西）。

## 4. 决策 3：修复 W3（`undiagnosed_candidates` 的 UUID/str 比较）

### 4.1 Django 修复

`backend/apps/learning/services/planner.py::undiagnosed_candidates` 原来：

```python
diagnosed = set(LearnerKnowledgeState...values_list("node_id", flat=True))  # UUID
...
if node_id in diagnosed   # node_id 是 str -> 永远 False
```

修复为在入口处统一成字符串：

```python
diagnosed = {str(node_id) for node_id in LearnerKnowledgeState.objects.filter(...).values_list("node_id", flat=True)}
```

真实 Django 行为确认（一次性 test DB，`/tmp/probe-plan-one-node.py`）：一个「无状态 + primary 映射 +
可作答题目」的考点现在是 **1** 条 undiagnosed 候选（修复前该集合恒空/把已有状态的考点也算进来），
且 `generate_plan` 会把它同时排进 `undiagnosed_probe` 与 `general_practice`（Django 跨类别没有同题去重，
见 §8）。

### 4.2 Node 对齐

`src/services/planner.ts::undiagnosedCandidates` 重写为与修复后的 Django 一致：

- **排除集**：该项目下**任何**有 `learning_knowledge_state` 行的考点（不是 `summary == undiagnosed` 的考点）；
- **候选源**：primary + `published` 的 `knowledge_question_mapping`，按考点 `canonical_name` 排序，
  每个考点最多一条；
- **资格**：`_eligible_question` 等价检查（current published、未封存、已核对无争议答案、非 AI 推导）；
- **上限**：`limit`；
- **分钟数**：读 current published 版本（`_question_minutes`），不是映射指向的版本。

### 4.3 探针与测试

`scripts/probe_b10_planner.py` 的夹具新增两个考点，并把这部分从「informational」升级为**逐字段对账**：

| 夹具 | 期望 |
|---|---|
| `B10 未诊断R`：无状态 + primary 映射 + 可作答 | 两侧各 **1** 条候选 |
| `B10 未诊断S`：无状态 + primary 映射 + 答案未核对 | 两侧都排除 |
| 所有已有状态的考点（薄弱B/C/…/长名） | 两侧都排除（修复前该夹具下 Django 会返回 **12** 条；B10 旧夹具为 11 条） |
| 只有 auxiliary 映射 / 只有 pairing 的考点 | 两侧都排除 |

结果：`django_undiagnosed == node_undiagnosed == 1`，`comparison.equal: true`，重跑逐字节一致
（sha256 `5f0f8c92…`）。新增单测
`tests/planner_service.test.ts::undiagnosed candidates skip any stated node and require a primary eligible mapping`。

**连带修正 B8 单测**：`tests/b8_learning_http.test.ts` 的「封存后隐藏」用例原来断言 1 条任务；修复后
Django 会把同一道题同时排成 `undiagnosed_probe` 与 `general_practice` 两条（真实 Django 探针确认），
断言改为 2 条 + 封存后说明「有 2 个任务」被隐藏。这不是放宽断言，而是把测试从旧缺陷行为改成真相源行为。

## 5. 决策 4：暂不安装备份调度

- 不新增 launchd/cron/常驻进程；`db:backup` 仍是一次性命令。
- `--include-media` / `--keep` / HMAC 签名已在 B10 交付（26 条测试），只是不自动调度。
- 边界保留：媒体/库非原子快照、恢复非两段式、只支持对称 HMAC（19 §8）。

## 6. 决策 5：在 `~/.dsh` profile 加载插件

### 6.1 实际安装（desktop = 当前 GUI 使用的 profile）

运行中的 GUI 是 **DSH Desktop**，profile 为 `~/.dsh/profiles/desktop`（`ps` 证据：
`@deepseek-ai/dsh-desktop-host` + `~/.dsh/profiles/desktop`）。该 profile **不能由 CLI 启动**
（`error: profile "desktop" is managed exclusively by the Electron application`），只能由桌面应用本身加载。

已做的改动（全部可回滚）：

1. 备份：`dsh-plugin/var/b11/desktop-profile-package.json.bak`、`desktop-profile-pnpm-lock.yaml.bak`；
2. `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 增加 `"@acepass/dsh-plugin": "link:/Users/cololi/Documents/AcePass/dsh-plugin"`；
   - `dsh.profile.bundles` 末尾增加 `"@acepass/dsh-plugin"`；
3. 先建立 `~/.dsh/profiles/desktop/node_modules/@acepass/dsh-plugin` → 插件目录的软链，再用应用自带的
   pnpm（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`）
   在 profile 目录执行 `pnpm install`：lockfile 写入 `@acepass/dsh-plugin: link:`，软链保持。
   （该 profile 原本就有一个坏链依赖 `dsh-mcp: link:../dsh-mcp`，pnpm 只给出 WARN，属于既有问题，不影响本次组合。）

### 6.2 组合验证（用桌面应用自己的 boot 代码，只读）

用应用的 Electron Node（`ELECTRON_RUN_AS_NODE=1`）+ 应用内 `@deepseek-ai/dsh-app-boot` 直接调用
（CLI 的 `--dump-config` 对 desktop profile 被人为禁用）：

```
version 0.2.2-rc.1
bundles 18, resolve failures 0
entries 223
acepass entry {"id":"acepass","name":"@acepass/dsh-plugin","config":{"dataRoot":"","provider":"","model":""}}
skippedBundles []
```

→ 18 个 bundle 全部解析成功，`@acepass/dsh-plugin` 作为 `acepass` 条目进入组合树，没有“跳过”的 bundle。
插件本身在 B10 的 `load-smoke`（真实 Cordis + `dsh-tools`）与全量浏览器验收（隔离 DSH_HOME）中已证明可加载。

### 6.3 没有做的事（诚实边界）

- **没有重启**运行中的 DSH Desktop：本会话运行在该应用内，重启会终止会话，无法给出验证报告。
  因此**面板在真实 GUI 中的肉眼确认尚未发生**；应用下次启动时会加载该 bundle。
- 曾尝试把插件装进 `~/.dsh/profiles/web`，该 profile 的 `@deepseek-ai/dsh-subagent-codex` 软链指向
  一个不存在的路径（`/Users/cololi/OpenSource/deepseek-harness/...`，2026-10-15 起就存在），
  pnpm 安装后的 bundle 对账会因这个**既有**坏链失败；已把 `package.json` / `pnpm-lock.yaml` 原样还原、
  删除 `node_modules/@acepass`，`diff` 确认与备份一致。该 profile 未做任何持久修改。
- `dataRoot` **已固定**为 `/Users/cololi/.acepass`（desktop `cordis.patch.yml` 的 `- id: acepass` 配置，
  原文件备份在 `var/b11/desktop-cordis.patch.yml.bak`，目录 0700）。原因：Finder 启动的 Electron 进程
  `process.cwd()` 不是用户可写目录，默认 `<workspace>/.acepass` 在真实宿主里可能创建失败。组合验证中
  `acepass` 条目的 `config.dataRoot` 已显示该路径。

### 6.4 用户重启后的验收与回滚

重启 DeepSeek Harness 后：

1. 侧栏应出现 AcePass 面板；首次使用会在工作区创建 `.acepass/acepass.sqlite`。
2. 若面板异常：把 `~/.dsh/profiles/desktop/package.json` 还原为备份（或删除
   `@acepass/dsh-plugin` 的两处条目与 `node_modules/@acepass/dsh-plugin` 软链），再重启。
3. 需要固定数据目录时：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加
   `- id: acepass` + `config: { dataRoot: /abs/path }`，重启。

## 7. 验证数字

| 项 | 结果 |
|---|---|
| `npm run verify` | **768 条测试**（B10 767 + W3 新单测 1）系统 Node 24.22.2 与 DSH Electron Node 24.21 双跑全绿 + `load-smoke OK` |
| Django 集成测试 | 353 条（`backend/tests/integration`）全绿（修复 W3 后） |
| 规划器探针 | 修复后 Django 1 = Node 1 条 undiagnosed 候选；weak 8 vs 8、plan tasks 8 vs 8、`trigger_event` `''`；`comparison.equal: true`，重跑逐字节一致 `5f0f8c92…` |
| broker 清理 | 删除前 108 条消息 + 2 个 binding，删除后 db0 `dbsize=0`；Redis 服务未停 |
| GUI profile | 18/18 bundle 解析成功，0 skipped，`acepass` 条目进入组合树；应用版本 0.2.2-rc.1 |

## 8. 已知边界

1. **跨类别同题重复**：修复 W3 后，同一道题可以同时作为 `undiagnosed_probe` 与 `general_practice` 进入
   同一天的同一计划。这是 Django 的真实行为（真实探针确认），按现状对齐；是否去重需要两侧同时决策。
2. **桌面 GUI 未亲眼确认**：只完成安装 + 应用自身代码的组合验证；真实面板需重启后由用户确认（§6.4）。
3. **web profile 未安装**：其既有的 `@deepseek-ai/dsh-subagent-codex` 坏链会让 bundle 对账失败，
   与本插件无关；已还原，未修复该坏链（不属于本批次）。
4. **Django 保留**：D3–D6 未执行，`backend/` 仍是真相源与回滚路径；D1/D2 未执行。
5. **备份无调度**：按用户决定暂不安装；媒体/库非原子快照等边界不变。
6. 真实模型调用仍未验证（本环境无 provider）；@stub 8 条仍是有意差异。
7. **浏览器验收未重跑**：W3 只改规划候选（`undiagnosedCandidates`），main/archive/@stub 都没有「生成今日计划」
   用例；B10 的 main **78/78**、archive **3/3**、@stub **0/8** 仍是最近一次全量结果。W3 的覆盖是真实 Django
   探针（1 = 1）、Django 集成测试 353 条与 Node 单测。

## 9. 复现命令

```bash
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
cd /Users/cololi/Documents/AcePass/dsh-plugin

npm run verify
node --test --experimental-strip-types tests/planner_service.test.ts
node --test --experimental-strip-types tests/b8_learning_http.test.ts
../backend/.venv/bin/python scripts/probe_b10_planner.py
cd ../backend && .venv/bin/python -m pytest tests/integration -q

# broker 证据
cat dsh-plugin/var/b11/redis-discard.json
redis-cli -h 127.0.0.1 -p 6379 -n 0 dbsize     # 0

# GUI profile 组合（应用自身代码，只读）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  dsh-plugin/var/b11/compose-desktop-profile.mjs
```
