# 21. 下一步（B11 之后）：真实 GUI 验收、数据落点与运行准备

> 状态：**建议路线**（不含新的代码交付）。B10/B11 已完成并验证；插件已装入 desktop profile，
> 但**还没有在运行中的 GUI 里真正打开过**。下面按「不做就无法继续」到「可选优化」排序。

## 0. 一句话

先重启 DSH Desktop，把 AcePass 面板真正跑一遍（P0）；在重启前决定数据目录（P1）；再决定「从空库开始」
还是导入现有 `acepass` 库（P2）；最后才是 AI/嵌入与运维（P3/P4）。Django 退役已按你的决定暂停，不在下一步。

## 1. P0：重启后真实 GUI 验收（必须先做）

插件已安装、组合验证通过，但客户端面板与宿主 worker 还没有在真实 GUI 里跑过。重启 DeepSeek Harness 后：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 侧栏出现 AcePass 入口，点开 | 页面加载，无白屏/报错；不出现 `plugin load failed` |
| 2 | 首次进入 | 工作区下出现 `.acepass/acepass.sqlite`（或你在 P1 固定的目录）；`_acepass_meta.schema_version = 1` |
| 3 | 新建项目 → 科目 | 列表立即出现；刷新后仍在 |
| 4 | 建大纲/考点 → 建题 → 核对答案 → 发布 | 发布成功；已发布版本不能原地改（R-INV 1） |
| 5 | 开始练习 → 提交一题 | **不刷新页面**，几秒内知识页/证据页出现该次作答的 6 维证据（F1 worker 在真实宿主里消费；这是本轮最关键的一条） |
| 6 | 打开知识页 → 点考点 | “证据详情”显示缺失条件/排除原因（F6 形状修复在真实 GUI 的验证） |
| 7 | 关闭再打开面板 | 数据仍在；outbox 没有长期 `pending`（`npm run retire:d0 -- --data-root <dir>` → `ok:true`） |
| 8 | 看一眼日志 | 无 `[acepass] outbox worker error` / `route mount failed` |

如果第 5 条不成立，问题在真实宿主的 worker 启动或 HTTP 挂载；日志与 `.acepass` 的
`audit_outbox_event` 能直接定位（事件是否 `pending`、`last_error` 是什么）。

**验收脚本（可在新会话里跑）**：

```bash
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
cd /Users/cololi/Documents/AcePass/dsh-plugin
node --experimental-strip-types scripts/d0-check.mjs --data-root <你的 dataRoot>
sqlite3 <你的 dataRoot>/acepass.sqlite 'select topic,status,count(*) from audit_outbox_event group by 1,2'
```

## 2. P1：先决定 dataRoot（重启前）

桌面会话的默认数据目录是 **`<会话工作区>/.acepass`**。如果工作区是本仓库，会在仓库里生成 `.acepass/`
（目前 `.gitignore` 没有忽略它）。三个选项：

| 选项 | 做法 | 适用 |
|---|---|---|
| **A（已采用）** | `~/.acepass` | 单一用户、与仓库/工作区解耦；备份路径稳定 |
| B | `~/Documents/AcePass/.acepass` | 仍在本项目目录下，但需给 `.gitignore` 加一行 |
| C | 保持默认 | 每个会话工作区一份数据（会分叉），只适合试验 |

> **B11 已按 A 落地**：`~/.dsh/profiles/desktop/cordis.patch.yml` 已加 `- id: acepass` +
> `dataRoot: /Users/cololi/.acepass`（原文件备份在 `dsh-plugin/var/b11/desktop-cordis.patch.yml.bak`），
> 目录已建（0700）。组合验证显示 `acepass` 条目的 `config.dataRoot` 已是该路径。
> 理由不只是偏好：Finder 启动的 Electron 进程 `process.cwd()` 不是用户可写目录，未固定时插件的
> 懒加载 `mkdir` 可能失败，HTTP surface 就挂不上。

固定方式（desktop profile 的 patch 层，重启生效）：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml 追加
- id: acepass
  config:
    dataRoot: /Users/cololi/.acepass
```

> 若改选 B/C，改 patch 后重启；已有数据需要手动搬 `acepass.sqlite` + `private-media`。

## 3. P2：数据策略（空库 vs 导入现有 `acepass`）

现有本机 PostgreSQL `acepass` 库是 **demo/e2e 数据**（4 个用户：`demo@`、`e2e@` 等；4 个项目；
360 题；57 会话；42 次作答），不是生产用户数据。两条路：

1. **从空库开始（推荐）**：真实使用从零积累，证据/状态/计划都干净；旧库继续作为 Django 对照。
2. **导入旧库**：`scripts/reconcile_db.mjs` 已能导出→导入并对账（59/59 表、5383 行）。但插件是
   **单用户工作区**，而旧库有 4 个用户：导入后 `ensureOwner` 找的是 `owner@acepass.local`，不会自动把
   旧用户的项目挂到 DSH 身份上。真要走这条路，需要额外一步**用户映射**（把选定的旧用户邮箱改成
   `owner@acepass.local`，或把项目 `owner_id` 改到 DSH owner），并接受「多用户数据合并进一个工作区」
   的语义变化。这是单独的设计决策，不建议顺手做。

## 4. P3：AI 与检索

- **真实模型**：插件走 `ctx.llm`。桌面 profile 是否配置了可用 provider，重启后在面板里点一次「AI 讲解」
  即可判断：真实结果，或如实的 `ai_not_configured`（R-INV 4：无 stub、不伪造）。
- **向量通道（D-3）**：当前 `channels.vector.available=false`，检索降级到关键词。需要语义检索时，
  在部署侧配置独立嵌入端点（`embedding.baseUrl/model/apiKeyEnv`），不是代码缺口。
- **视觉输入**：转写/图片抽取需要模型声明 `inputModalities`；没有视觉模型时接口会明示拒绝。

## 5. P4：运行准备（可选，按需）

1. **手动备份**：`npm run db:backup -- --data-root <dir> --include-media --keep 7 --sign-key <key>`；
   `db:verify` 校验。调度已按你的决定暂不安装。
2. **D0/健康检查**：`npm run retire:d0 -- --data-root <dir>` 应在空闲时为 `ok:true`（有在途事件时
   等 worker 消费完再查）。
3. **数据目录权限**：`~/.acepass` 只给当前用户；`private-media` 同理。
4. **Django 对照**：`backend/` 保留，需要对照时手动起 Django + Postgres/Redis（当前本机 Redis 已空、
   Postgres 仍在）。

## 6. P5：可选的对齐项（不阻塞使用）

| 项 | 说明 |
|---|---|
| 跨类别同题重复 | W3 修复后同一题可同时进 `undiagnosed_probe` 与 `general_practice`（Django 真实行为）；要去重需两侧同时决定 |
| `on_explanation_delivered` | 已移植不接线（Django 生产零调用，W4）；接线需两侧同时决定 |
| @stub 8 条 | DSH 无离线 stub provider，属 R-INV 4 有意差异，不是缺陷 |
| web profile 坏链 | `@deepseek-ai/dsh-subagent-codex` 指向不存在的路径（2026-10-15 起），与本插件无关；若以后用 `dsh web` 需要先修 |

## 7. 不做什么

- **不删除 Django**：按你的决定保留对照（D3–D6 不执行）。
- **不自动装备份调度**：按你的决定暂不安装。
- **不在本会话重启 DSH Desktop**：会终止会话；重启由你操作，或在新会话里让我按 P0 清单验收。
