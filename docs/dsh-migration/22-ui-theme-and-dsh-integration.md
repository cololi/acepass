# 22. UI 对齐 DSH 设计风格：暗黑 / 自动主题与 DSH 功能直连

> 状态：**已完成并验证**（2026-11-08，起点 `7b41d19`）。
> 需求三条：① UI 适配 DeepSeek Harness 的设计风格；② 支持暗黑模式与自动跟随系统；③ 能直接使用
> DSH 的一些功能。本文只写实测过的事实；未验证的部分集中在 §8。

## 1. 结论

| 需求 | 实现 |
|---|---|
| DSH 设计风格 | `app.css` 重写为 DSH token 设计层：颜色全部读 `--dsw-*`，字体读 `--dsw-font-family` / `--ds-font-family-code`，正文字号读 `--dsh-content-font-size`，圆角用 `--dsw-radius-*`，主按钮用 DSH 的 brand 填充（浅色黑底白字、深色白底黑字），卡片用 `settings-card-fill` + 描边，导航用 DSH 侧栏选中色 |
| 暗黑模式 | 语义 token 在 `body[data-ds-dark-theme]` 下原生切换，面板不维护第二套调色板；实测深色下面板底 `#151517`、卡片 `#2c2c2e`、正文 `#f9fafb` |
| 自动跟随 | 顶栏与设置页的三段式控件「自动 / 浅色 / 深色」；`自动` = DSH 的 `system`，由 `prefers-color-scheme` 解析 |
| 直接用 DSH 功能 | 主题服务 `ctx.theme`（写回 DSH 设置并同步整个界面）、`/acepass` 命令面板、设置页「外观与 DSH 集成」卡片、DSH 字号继承、侧栏入口（原有）、AI 走 `ctx.llm`（原有） |

**此前 UI 会破坏 DSH 外壳**：旧 `app.css` 里 `body / a / button / input / main` 是**全局选择器**，
`installCss()` 一挂载就把外壳的浅色背景、字体、控件样式覆盖掉；`overrides.css` 又把面板控件反向钉成
浅色。深色模式因此不可能生效，而且面板打开时整个 GUI 会被染成 `#f6f7f9`。本轮把样式全部收进
`.acepass-root`（158 个选择器，0 个泄漏，见 §7.2），并删掉浅色钉死规则。

## 2. 设计层（token 契约）

`app.css` 的结构：

1. `:root` / `:root[data-acepass-theme='dark']` 只定义**独立运行时的兜底色板** `--ap-palette-*`；
   在 DSH 内这些值永远不会被读取（`--dsw-*` 已存在）。
2. `.acepass-root` 定义语义别名，例如
   `--ap-bg: var(--dsw-alias-bg-base, var(--ap-palette-bg))`；
   DSH token 缺失时才落到兜底色板。
3. 所有组件规则以 `.acepass-root` 前缀；不再存在 `body`、`main`、`a`、`input` 等全局规则。

| 语义 | token |
|---|---|
| 页面底 / 卡片 / 浮层 | `--dsw-alias-bg-base` · `--dsw-alias-settings-card-fill` · `--dsw-alias-bg-layer-2` |
| 描边 | `--dsw-alias-settings-card-stroke` · `border-l1/l2/l3` |
| 正文 / 次要 / 弱化 | `--dsw-alias-label-primary` · `label-secondary` · `label-tertiary` |
| 链接 / 主按钮 | `--dsw-alias-link` · `button-primary-fill` + `label-primary-foreground` |
| 悬停 / 选中 / 导航选中 | `--dsw-alias-interactive-bg-hover` · `interactive-bg-hover-accent` · `specific-sidebar-nav-item-active` |
| 语义状态 | `state-success/warn/error-primary`，软色由 `color-mix()` 从同一 token 派生 |
| 代码 / 行内代码 | `--dsw-alias-markdown-code-block` · `markdown-tag` |
| 工具条 / chip | `--dsw-alias-bg-module-platform` · `markdown-tag` |
| 弹窗 / toast | `--dsw-alias-bg-layer-2` + `elevation-prominent` · `toast-bg` / `toast-label` |
| 字体 / 字号 | `--dsw-font-family` · `--ds-font-family-code` · `--dsh-content-font-size` |
| 圆角 / 焦点环 | `--dsw-radius-*` · `--dsw-focus-ring-color` / `--dsw-focus-ring-width` |

补充：

- 按钮层级按 DSH：`primary` = brand 填充（浅色近黑、深色近白），`default` = 表面 + 描边，`ghost` = 无边框，
  `danger` = 状态色描边 + 软底；高度 32px（`small` 26px）。
- 输入框 / 下拉 / 文本域：表面填充 + `border-l2`，聚焦时品牌色 2px 光晕；`select` 的弹出层跟随
  `color-scheme`（见 §4 的修复）。
- 表格：表头 `label-tertiary` + 12.5px，行分隔用 `border-l1`，悬停 `interactive-bg-hover`。
- 布局：48px 顶栏（sticky、半透明 + 毛玻璃 + 发丝描边）、工具条、1180px 内容区、卡片 12px 圆角、
  980px 以下收成菜单按钮、720px 以下主题按钮只留图标、项目/科目选择各占一行。
- 用 `.surface-subtle` / `.row-selected` / `.surface-raised` / `.code-block` / `.thumb` /
  `.divider-top` / `.warn-panel` 七个工具类，替换掉 16 个页面里的 40 处硬编码浅色（`#fafbfc`、
  `#f5f8ff`、`#eef1f4` 等）。深色下这些位置现在是 `layer-2` / 选中色 / 语义告警色。

## 3. 主题控制

新模块 `dsh-plugin/src/client/app/theme.tsx`：

- 启动时读 `localStorage`（独立环境）并写 `html[data-acepass-theme]`（只给兜底色板用）。
- 在 DSH 内由 `client/index.ts` 注入 `ctx.theme`：
  - `attachDshThemeRuntime(theme, ctx)` 读取 `getTheme()` 的 `preference` 与 `active.colorScheme`；
  - `ctx.on('theme/change', …)` 跟随 DSH 设置页的修改；
  - 控件点击调用 `theme.setTheme(preference)`，**写回 DSH 的 `ui-theme` 设置**（由宿主持久化）。
- 无 DSH 服务时同一控件退化为 `localStorage` + `prefers-color-scheme`，接口不变。
- 修正了一个容易踩的坑：独立环境的兜底路径会给 `<html>` 写内联 `color-scheme`；一旦 DSH 服务接入，
  必须移除该内联值，否则会盖掉外壳的 `html { color-scheme: dark }`，让 select 弹出层/滚动条变浅色。
  现在 `applyResolved()` 在服务存在时 `style.removeProperty('color-scheme')`。

控件在两处出现：顶栏右侧与「设置 → 外观与 DSH 集成」。它是三段式 `role="group"`，`aria-pressed`
标记当前偏好，`title` 说明作用域（“切换整个 DSH 界面的主题”或“切换本页面主题”）。

## 4. DSH 功能直连

| 功能 | 接入点 | 行为 |
|---|---|---|
| 主题服务 | `ctx.theme` | 面板与 DSH 共用 light/dark/system；切换写入 DSH `ui-theme`，刷新后保持 |
| 命令面板 | `ctx.commandUi` | 在任意对话输入 `/acepass` → 打开面板。客户端命令，不需要 Host 命令目录；重复注册、服务缺失、layout 未挂载都被吞掉并告警，不影响面板 |
| 设置页集成卡片 | `SettingsPage` → `DshIntegrationCard` | 显示主题来源、当前偏好与解析结果、继承的 DSH 正文字号、`/acepass` 是否注册成功、AI 走 DSH 模型服务 |
| 字号 | CSS 继承 `--dsh-content-font-size` | 面板正文、标题、表格一起按 DSH 字号缩放，不在插件里另存字号 |
| 侧栏入口 | `sidebar.panellist`（原有） | 图标与标签保持，样式改成 DSH 12px 图标观感 |
| AI / 工具 | `ctx.llm`、`tools.register`（原有） | 讲解/诊断/估分和 `acepass` 工具继续走宿主模型；无模型时如实返回未配置 |
| 退出登录 | 已移除（原有） | DSH 会话负责准入，面板不提供登出 |

## 5. 改动清单

**插件（DSH 实际加载的部分）**

| 文件 | 说明 |
|---|---|
| `src/client/app/styles/app.css` | 重写：token 层 + 全部组件样式，1174 行，全部作用域化 |
| `src/client/overrides.css` | 只保留 slot 几何（高度、滚动容器、sticky 顶栏），删掉浅色钉死 |
| `src/client/app/theme.tsx` | 新增：主题运行时、`ThemeSwitch`、`describeThemeSource` |
| `src/client/dshCommands.ts` | 新增：`/acepass` 注册与幂等 disposer |
| `src/client/index.ts` | 注入 `ctx.theme`、`ctx.commandUi`；`openPanel` 复用 |
| `src/client/app/app/AppShell.tsx` | 顶栏加主题控件；导航响应式；项目/科目改为 `<label>` 行 |
| `src/client/app/features/settings/SettingsPage.tsx` | 新增「外观与 DSH 集成」；AI 说明改为 DSH 模型服务 |
| `src/client/app/features/**`（16 个文件） | 40 处内联浅色 → 工具类，文字/结构/`data-testid` 未改 |
| `tests/dsh_commands.test.ts` | 新增 4 条单测（形状、无服务、重复注册、openPanel 抛错） |

**独立前端（`frontend/`）**：镜像 `app.css`、`theme.tsx`、`AppShell` 主题控件、`main.tsx` 的
`.acepass-root` 包裹与 `data-acepass-standalone`，并同步设置页文案。`frontend/src/features/**` 的
内联颜色**没有**全量同步（该应用仍走 Django API，不在本轮范围，见 §8）。

**验收套件**：`frontend/tests/dsh/p1-import-and-cycles.spec.ts` 的一行断言从
`expect(node-error).not.toContainText('环')` 改为 `expect(node-editor).toHaveCount(0)`。
原因见 §7.5：编辑成功时组件会关闭编辑器（`updateNode.onSuccess` 清空 `editingNodeId`），
原断言只能在 PATCH 尚未返回的窗口内碰巧通过——它是计时竞态，不是 UI 行为；新断言检查
“成功即收起编辑器”的真实契约，反而更严格。

## 6. 主题实测值

在隔离 DSH Web（`dsh web` + 一次性 `DSH_HOME`，与桌面端同一份客户端代码）里用 Playwright 实测：

| 项目 | 浅色 | 深色 |
|---|---|---|
| `body[data-ds-dark-theme]` | 无 | 有 |
| `--dsw-alias-bg-base` | `#fff` | `#151517` |
| 面板底 / 文字 | `rgb(255,255,255)` / `rgb(15,17,21)` | `rgb(21,21,23)` / `rgb(249,250,251)` |
| 卡片底 | `#fff` | `rgb(44,44,46)` |
| `aria-pressed` | 浅色 | 深色 |
| 刷新后 | — | 仍是深色（偏好已在 profile 的 `ui-theme.preference` 持久化，实测 `preference: dark`） |
| `html` 内联 `color-scheme` | `(none)`（服务接入后不再写入） | `(none)` |

截图证据：`dsh-plugin/var/ui-theme-2026-11-08/`（01/02 浅色，03—06 深色，07—09 移动端，
10/11 命令面板；该目录在 `.gitignore` 的 `var/` 下，属本机证据）。

## 7. 验证

### 7.1 静态门禁

- `npm run typecheck`（server + client）通过；`npm run build` 通过（`lib/client.js` 1,895,771 B）。
- `frontend`：`npx tsc --noEmit` 通过。

### 7.2 作用域审计

用脚本解析 `app.css` 的所有选择器（去掉注释与 `@keyframes`）：**158 个选择器，0 个未限定在
`.acepass-root` / `:root` 兜底 / `html[data-acepass-standalone]` 之外**；`overrides.css` 3 个选择器
全部以 `.acepass-root` 开头。也就是说插件样式不再能改到 DSH 外壳。

### 7.3 单元测试

`npm test`：**772 passed**（B10 的 768 + `/acepass` 4 条）。新增 4 条覆盖：贡献形状、无命令服务、
注册抛错、`openPanel` 抛错不向上传播。`npm run verify` 双引擎全绿：系统 Node 24.22.2 与
DSH Electron Node 24.21 各 772 条 + `load-smoke OK`（真实 Cordis + `dsh-tools` 加载并执行工具）。

### 7.4 端到端主题验证

§6 的表全部来自一次真实浏览器会话：点“深色”→ 外壳 `body` 属性/ token/面板底色同时变化 →
刷新后仍为深色 → 点“浅色/自动”回到对应状态。设置卡片实测文字包含
「DSH 主题服务已连接（…偏好…）」与「命令面板：在对话输入框输入 /acepass 可直接打开本面板」。

### 7.5 浏览器主套件

`npx playwright test -c playwright.dsh.config.ts --grep-invert @stub`（隔离实例，desktop + mobile，
archive 项目也在本次命令内）：

- 第一轮：**80 passed / 1 failed**，失败是 §5 说明的计时竞态断言（desktop 与 mobile 交替触发）。
- 修正该断言后重跑整套：**81 passed，0 failed，29.6 分钟**（78 条主套件 +
  3 条归档反例）。其中 `p1-import-and-cycles` 的 cycle 用例 desktop 3.3s、mobile 34.0s 均通过。

> 说明：全套运行的是 `lib/client.js` 1,895,771 B 的构建。之后又修了独立环境深色主按钮对比度的
> 一个兜底变量（见 §2/§6），重打包（构建日志 1,895,857 B，文件 1,896,022 B，差值为换行）。该变量只在 `--dsw-*` 缺席时生效，
> DSH 内实测不变；最终构建另用 §7.6 的探针验证。

### 7.6 其他

- `@stub` 组：**8 failed，全部是 `503 ai_not_configured`**，不是 UI 回归。DSH 没有离线 stub
  provider（21 §6 已记为 R-INV 4 的有意差异）；断言 `201 + is_stub:true` 在该环境不可能成立。
  本轮没有为了让它们变绿而改断言。
- `/acepass` Composer 端到端：菜单行可见（`打开 AcePass` + 说明），回车后 `PANEL_OPEN true`。
- 最终构建的主按钮探针（DSH 内 + 无 DSH token 的独立页面）：

  | 场景 | 主按钮背景 | 文字 |
  |---|---|---|
  | DSH 浅色 | `rgb(15,17,21)` | `rgb(255,255,255)` |
  | DSH 深色 | `rgb(249,250,251)` | `rgb(15,17,21)` |
  | 独立页浅色 | `rgb(15,17,21)` | `rgb(255,255,255)` |
  | 独立页深色 | `rgb(245,246,247)` | `rgb(16,17,20)` |

  独立页深色下页面底 `rgb(21,21,23)`、卡片 `rgb(35,35,36)`，`--ap-on-fill` 分别解析为 `#ffffff`
  与 `#101114`——修复前深色下会是白底白字。

## 8. 已知边界

1. **桌面 GUI 尚未肉眼确认**：本会话运行在 DSH Desktop 内，重启会终止会话。插件已装入
   `~/.dsh/profiles/desktop`，**重启后**才会加载新的 `lib/client.js`；届时顶栏应出现三段式主题控件。
   本轮验证使用的是同一份客户端代码跑在 `dsh web`（隔离实例）里，不是运行中的桌面窗口本身。
2. `/acepass` 已做一次真实 Composer 端到端验证（隔离实例）：输入 `/acepass` 后弹出「打开 AcePass /
   acepass / 打开 AcePass 备考面板（今日学习、刷题、考点与报告）」，回车后 AcePass 面板出现
   （证据 `var/ui-theme-2026-11-08/10-command-menu.png`、`11-command-opened.png`）。该场景是
   一次性 Playwright 探测，**没有**并入常规验收套件；命令目录依赖会话状态，未做成回归用例。
3. **独立前端只镜像主题层**：`frontend/` 仍是 Django-era API；其 feature 页的内联颜色未全量替换，
   所以 standalone 应用在深色下的少数内嵌块可能仍偏浅。本轮目标与验收对象是 DSH 面板。
4. **第三方 DSH 主题**：样式只读 token，理论上跟随；没有用非内置主题做过实测。
5. **字号**：只继承，不在面板内修改（修改属于 DSH 设置）。
6. 本轮**没有**改后端、数据、AI 语义、生成计划/评分规则；DSH 不提供 provider 时仍返回
   `ai_not_configured`，不伪造结果。

## 9. 复现命令

```bash
export PATH="/Users/cololi/.local/share/fnm/node-versions/v24.22.2/installation/bin:$PATH"
cd /Users/cololi/Documents/AcePass/dsh-plugin

npm run typecheck
npm run build
npm test

# 作用域审计（158 / 0）
python3 - <<'PY'
import re
css = open('src/client/app/styles/app.css').read()
css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
css = re.sub(r'@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}', '', css)
sels = [m.group(1).strip() for m in re.finditer(r'(?:^|\})\s*([^{}@]+)\{', css) if m.group(1).strip()]
bad = [p.strip() for s in sels for p in s.split(',')
       if p.strip() and '.acepass-root' not in p and p.strip() != ':root'
       and "data-acepass-theme='dark'" not in p and 'data-acepass-standalone' not in p]
print(len(sels), 'selectors,', len(bad), 'unscoped:', bad)
PY

# 浏览器验收 + 主题截图（隔离实例；截图脚本不随仓库分发，见 docs/22 §6）
cd ../frontend
npx playwright test -c playwright.dsh.config.ts --grep-invert @stub
npx playwright test -c playwright.dsh.config.ts --grep @stub
npx playwright test -c playwright.dsh.config.ts --project=archive
```

重启桌面端之后的自查清单：

1. 顶栏右侧出现「自动 / 浅色 / 深色」三段控件；点「深色」整个 DSH 变深，刷新后保持。
2. 打开「设置」页，第一张卡片是「外观与 DSH 集成」，其中显示主题服务已连接、`/acepass` 已注册。
3. 在对话输入框输入 `/acepass` → 打开 AcePass 面板。
4. 打开面板时 DSH 侧栏、会话区颜色/字体不应被面板样式改动（这是本轮的主要修复）。
