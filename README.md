# AcePass

> **2026-09-27 P1 第一批交付完成。** 原生文字 PDF 批量导入与人工校对（来源页可追溯、五题型与材料子题
> 关系完整、答案匹配只产生候选、重试/重复导入不重复发布、不依赖模型密钥）、大纲词表导入与人工映射
> （同义词合并、环依赖拒绝）、真实试卷周期统计（只按真实发生记录、完整/不完整周期与分母明确、
> 权重不重复、不足五个完整周期就显示不足）均已实现：后端 **226 passed**（含本轮迁入 23 条）、
> 隔离浏览器 **48 passed**（P0 36 + P1 12）、归档反例 2 + 9 + 3 原样通过、真故障演练 **ok=true**、
> 仅提交内容的干净副本下代理组件与真实全栈 HTTPS/CSRF 登录通过。**真实 AI 讲解已实际发起调用但被
> provider 账户余额阻断（HTTP 402），真实图片识别无视觉模型凭据，真实 ≥24 小时验证与 GitHub Actions
> 实际执行均未验证。** 逐条结果见 [16 P1 第一批交付](docs/16-p1-first-batch-delivery.md)，证据见
> [p1-batch](docs/review/2026-09-27/p1-batch/README.md)。

> **2026-09-27 P0.2 最后四组遗漏修复（C01/C02/C04/C05，起点 `2c87e0c`，提交 `7285991`）。**
> 后端 **203 passed**（含本轮迁入 9 条回归）、复验者三条原始反例原样 **3 passed**、上轮有效反例原样
> **9 passed / 1 deselected**、隔离浏览器 **36 passed**、归档浏览器 **2 passed**、真故障演练 **ok=true**、
> 仅提交内容的干净副本下代理组件与真实全栈 HTTPS/CSRF 登录通过且既有配置哨兵保持不变。
> **真实 provider、真实隔夜、真实学习效果与 GitHub Actions 实际执行仍未验证。**
> 逐条结果见 [15 最后四组遗漏修复](docs/15-p0-2-final-four-gaps-repair.md)，证据见
> [p02-final-gaps](docs/review/2026-09-27/p02-final-gaps/README.md)。

> **2026-09-27 P0.2 定向补漏完成（C01—C05）。** 后端 **194 passed**（含本轮迁入 17 条回归）、归档交叉反例
> **9/10 原样通过**（第 10 条按"安全拒绝歧义历史"调整后作废，业务断言已迁入正式套件）、浏览器 **36 passed**、
> 归档浏览器 **2 passed**、真故障演练 **ok=true**（含同一 event 重复投递与旧消费者超时返回）、代理组件与全栈
> 登录发布门槛在本机 Docker 实际执行通过。逐条结果见 [13 补漏报告](docs/13-p0-2-remaining-repair.md)，证据见
> [p02-remaining](docs/review/2026-09-27/p02-remaining/README.md)。该轮之后的独立复验（`2c87e0c`）保留的
> 四处遗漏已在 [15](docs/15-p0-2-final-four-gaps-repair.md) 关闭。

> **P0.2 复验（c168583）曾保留五组补漏。** 177后端、11归档反例、36浏览器、2归档浏览器均通过；交叉边界仍有失败。见 [12复验报告](docs/12-p0-2-independent-review.md)。下文保留各次交付记录。

> **2026-09-27 P0.2 收尾完成：B01—B07 与三项发布门槛已修复并有本轮实测证据。**
> 后端 177 passed、新版浏览器验收 36 passed、原浏览器套件 16 passed、复验者原始 11 条后端反例与
> 2 条浏览器反例全部转为通过；真实故障注入（真 `SIGKILL` + 真 Redis `FLUSHALL`）`ok: true`。
> 逐条改动与命令见 [P0.2 收尾验证报告](docs/11-p0-2-closeout-verification.md)，
> 问题基线见 [P0.1 独立复验](docs/09-p0-1-independent-reacceptance.md)（保留不删）。
> **真实 AI provider、真实隔天体验与 Compose 全栈仍未验证。**

以考试得分为目标的个性化刷题、补弱与学习验证系统。**本仓库已包含可运行的 P0 实现**，
不只是规格文档：多项目/多科目、五种题型、导入校对、确定性判分与人工评分、暴露台账、
配对验证与延迟复习、考点证据、今日计划与练习报告，前后端都可实际运行。

> 演示夹具在界面上全程标注为「演示」，它不是任何真实考试的官方规则，也不是历年真题；
> 未配置 AI 时图片识别与按需讲解会明确显示「AI 未配置」，其余功能不受影响。

## 1. 交付范围

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 工程与环境 | 已完成并实测 | Django 5.2 + Ninja 模块化单体、PostgreSQL、Celery/Redis 发件箱、私有存储、健康检查、Compose 编排 |
| M1 多项目与领域数据 | 已完成并实测 | 项目/科目/大纲/规范版本、试卷发生记录、题目/答案/rubric 版本、内容谱系、配对验证 |
| M2 导入与全题型内容 | 已完成并实测 | 文字模板与编号题解析、图片私有保存与人工结构化、校对问题清单、受控发布 |
| M3 全题型答题与评分 | 已完成并实测 | 五种题型作答、草稿乐观锁、幂等提交、确定性判分、填空待复核、大题逐点确认、重判 |
| M4 证据/任务/报告 | 已完成并实测 | 六维证据与排除原因、考点状态规则函数、A/B/C 配对与延迟任务、全局预算计划、报告 |
| M5 图片识别与按需辅导 | 代码完成，**真实 provider 未验证** | 能力接口、`llm_run` 审计、降级路径、stub 仅在测试/演示模式；无凭据故 A36 未运行 |

逐项证据见 [`docs/implementation-status.md`](docs/implementation-status.md) 与
[`docs/acceptance-results.md`](docs/acceptance-results.md)。P1/P2 未开始，也没有被标成已完成。

## 2. 本机环境（实测）

| 组件 | 实测版本 | 备注 |
|---|---|---|
| Python | 3.12.13 | `backend/.venv` |
| Django / django-ninja | 5.2.17 / 1.4.5 | 精确版本见 `backend/requirements/lock.txt` |
| PostgreSQL | 16.15 | 架构文档写 17 系列，本机为 16.15，属于兼容范围（见实施状态说明） |
| Redis | 8.10.2 | Celery broker 与缓存 |
| Node / npm | v24.18.0 / 12.1.0 | Vite 6.4.3、React 19 |
| Playwright | 1.49+（chromium headless shell 153） | 真实浏览器验收 |

## 3. 从零启动（以下命令均已实际执行）

```bash
# 1) 后端依赖
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements/lock.txt        # 运行依赖（精确锁定）
.venv/bin/pip install -r requirements/dev.txt         # 开发/测试额外依赖（pytest、ruff）

# 2) 数据库与缓存（本机已用 Homebrew 启动，也可用 infra/docker/docker-compose.yml）
brew services start postgresql@16
brew services start redis
psql -d postgres -c "CREATE ROLE acepass WITH LOGIN PASSWORD 'acepass_dev_pw' CREATEDB;"
psql -d postgres -c "CREATE DATABASE acepass OWNER acepass ENCODING 'UTF8';"

# 3) 迁移与账户（没有默认密码，也没有默认管理员）
export DJANGO_SETTINGS_MODULE=config.settings.dev
.venv/bin/python manage.py migrate
.venv/bin/python manage.py create_account you@example.com        # 交互输入密码
# 或脚本化：.venv/bin/python manage.py create_account you@example.com --generate-password

# 4) 可选的演示夹具（明确标记为 demo）
.venv/bin/python manage.py load_demo_fixture --email you@example.com

# 5) 启动后端
.venv/bin/python manage.py runserver 127.0.0.1:8000
curl -s http://127.0.0.1:8000/health/ready
# {"status": "ready", "checks": {"database": "ok", "cache": "ok", "ai_provider": "none"}}

# 6) 前端（另开一个终端）
cd ../frontend
npm install
npm run dev            # http://127.0.0.1:5173，/api 代理到 127.0.0.1:8000
# 生产构建：npm run build  → dist/ 由反向代理同源提供
```

异步任务（可选，未启动时同步事件会走发件箱并可由 `audit.scan_outbox` 补发）：

```bash
cd backend
.venv/bin/celery -A config worker -Q ingestion  -c 2 -l INFO
.venv/bin/celery -A config worker -Q tutoring   -c 2 -l INFO
.venv/bin/celery -A config worker -Q projection -c 2 -l INFO
.venv/bin/celery -A config beat -l INFO
```

## 4. 测试与校验命令（均已执行，结果见验收文档）

```bash
cd backend
.venv/bin/python -m pytest tests -q            # 119 passed（单元 + PostgreSQL 集成）
.venv/bin/python -m pytest tests/unit -q       # 只跑纯逻辑
.venv/bin/ruff check apps ai domain config     # All checks passed
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check

cd ../frontend
npx tsc -b && npx vite build                   # 类型检查与生产构建
npx playwright test                            # 真实浏览器：desktop + mobile 各 8 项
```

`DJANGO_SETTINGS_MODULE=config.settings.prod`（并以 `ACEPASS_RUNTIME_MODE=production` 运行，否则
没有默认密钥）下 `manage.py check --deploy` 无遗留问题：唯一有意接受的是 HSTS preload 未开启
（`security.W021`，preload 不可轻易回退，需要域名所有者自行决定），已在 `prod.py` 里显式
`SILENCED_SYSTEM_CHECKS`；CI 用 `--fail-level WARNING` 运行，任何**新的**部署告警都会让发布门槛失败：

```bash
cd backend
ACEPASS_RUNTIME_MODE=production \
DJANGO_SECRET_KEY='<≥50 字符的占位密钥>' \
DJANGO_ALLOWED_HOSTS='acepass.example.com,localhost' \
DJANGO_CSRF_TRUSTED_ORIGINS='https://acepass.example.com' \
DJANGO_SETTINGS_MODULE=config.settings.prod \
.venv/bin/python manage.py check --deploy --fail-level WARNING
# → System check identified no issues (1 silenced).
```

## 5. 备份与恢复（已实测空目录恢复与拒绝覆盖）

```bash
# 备份：数据库 dump + 私有文件 tar + 校验清单 + 版本信息（默认保留 7 天）
./scripts/backup.sh                       # 输出到 var/backups/<UTC 时间戳>/

# 恢复前先 dry-run：只做前置检查并打印目标目录与清单差异，不写任何东西
./scripts/restore.sh --dry-run var/backups/<时间戳> acepass_restore_check
# 真实恢复：目标数据库必须不存在，目标媒体目录必须不存在或为空
./scripts/restore.sh var/backups/<时间戳> acepass_restore_check
```

恢复脚本在写入任何东西之前就会拒绝：目标媒体目录非空、目标数据库已存在、备份缺少
`database.dump`/`media.tar.gz`/`media-manifest.sha256`。恢复后按 `media-manifest.sha256`
（`backup.sh` 写入的 `shasum -a 256` 清单）逐个校验 SHA-256，并报告 missing（清单有、
恢复后没有）与 extra（恢复后多出、清单没有）；任一非空即失败退出。

实测结果（2026-09-27，源库 → 空库 + 空媒体目录）：attempts 30/30、grade_events 35/35、
session_items 41/41、exposures 46/46、versions 324/324、answers 297/297、assets 2/2、
tasks 19/19；两件私有图片的 SHA-256 与备份清单一致；原始作答与冻结版本引用可读。

2026-09-27 的运维演练（临时库 `acepass_ops_drill_*`，用完即删）另测：dry-run 通过；空目录恢复
exit 0 且清单逐字节一致；非空媒体目录的第二次恢复被拒绝（exit 1，且未创建目标库、未改动文件）；
目标库已存在时被拒绝；备份被篡改（多一个文件 / 少一个文件 / 内容被改）分别被 extra、missing、
SHA-256 校验拦住。**Redis 不在 backup.sh 的备份范围内**（业务事实在 PostgreSQL），但 Compose 中
Redis 已开启 AOF+RDB 持久化，重启不丢队列（见 `infra/docker/README.md`）。

## 6. 目录结构

```text
backend/
  config/{settings/{base,dev,test,prod},api,urls,celery}.py
  apps/{accounts,audit,exams,ingestion,question_bank,knowledge,practice,tutoring,learning,analytics}/
  apps/common/{enums,content,answers,scope,errors,api}.py
  ai/{providers,prompts}/            # 可替换 AI 能力接口 + 版本化提示词
  domain/grading/adapters.py         # 确定性判分适配器
  tests/{unit,integration}/          # PostgreSQL 集成测试
frontend/
  src/{app,components,features,api}/
  tests/e2e/                         # Playwright 真实浏览器验收
infra/{docker,proxy}/                # Compose 编排与同源反向代理（TLS 终止点，见 infra/docker/README.md）
scripts/{backup.sh,restore.sh,gen-dev-certs.sh,demo_live_flow.py}
docs/{01..05} 与 implementation-status.md / acceptance-results.md
```

## 7. 明确未完成 / 未验证

- **真实 AI provider 未验证**（没有 API Key）：A36 未运行；配置方式见下。
- **真实隔天学习效果未验证**：延迟验证只有可注入时钟的逻辑证据，没有真实等待 24 小时。
- **Docker Compose 已在本机（OrbStack）实际构建并启动验证**（8 个服务全部起来、api/web healthy、
  TLS 与探针闭合，见 `infra/docker/README.md` 第 6 节）；**未**在真实目标服务器、真实域名或
  受信任证书上验证。
- **未向任何远程服务器部署**：仓库内没有授权的部署目标。
- P1/P2（PDF 批量导入、向量检索、FSRS、生成题、限时模拟考试、效果校准）未开始。

配置真实模型（示例，OpenAI 兼容接口）：

```bash
export ACEPASS_AI_PROVIDER=openai_compatible
export ACEPASS_AI_BASE_URL=https://your-endpoint/v1
export ACEPASS_AI_API_KEY=...            # 不要提交到 Git
export ACEPASS_AI_TEXT_MODEL=...         # 讲解用
export ACEPASS_AI_VISION_MODEL=...       # 图片识别用；不配置则明确不支持图片识别
```

## 8. 文档关系

`docs/01`—`05` 是产品、架构、数据契约、实施计划与验收规格；`docs/implementation-status.md`
与 `docs/acceptance-results.md` 记录**实际执行了什么、没执行什么**。文档与实现有出入时以
「修正后的文档 + 状态文件」为准，不静默缩小范围。
