# 贡献指南

本项目的第一原则是：**结论必须跟着证据走**。这条原则同样适用于代码贡献 —— 改一个断言就必须给出反例，
声称「修好了」就必须能指出是哪条命令、哪份日志证明的。

## 1. 环境

| 组件 | 版本 |
|---|---|
| Python | 3.12 |
| PostgreSQL | 16（**测试必须跑在真实 PostgreSQL 上，不允许回落到 SQLite**） |
| Redis | 7+（Celery broker 与缓存） |
| Node.js | 22 或 24 |

```bash
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements/lock.txt -r requirements/dev.txt

cd ../frontend
npm ci
npx playwright install chromium
```

数据库初始化见 [README 快速开始](README.md#快速开始)。

## 2. 提交前必须通过的门禁

```bash
# 后端
cd backend
.venv/bin/python -m pytest tests -q
.venv/bin/ruff check apps ai domain config tests
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py check
DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py makemigrations --check --dry-run

# 前端
cd ../frontend
npx tsc -b
npx vite build
npx playwright test
```

`makemigrations --check` 失败意味着模型改了但迁移没提交 —— 不要用 `--no-verify` 绕过，补迁移。

## 3. 硬性规则

1. **断言变更必须带反例。** 修改或新增一条业务规则时，同时提交一条能证明旧行为错误（或新行为成立）的测试。
   只改实现不改测试的 PR 会被要求补证据。
2. **不允许为了绿灯修改测试。** 既有测试文件是契约的一部分；确需调整时，在 PR 描述里逐条说明为什么原断言不再成立。
3. **不伪造未验证的能力。** 没有真实 AI 凭据时，接口必须明示「未配置 / 不可用」，不得返回占位成功结果。
   新增能力若无法在本机验证，写进 [实现状态](docs/implementation-status.md) 的未验证清单。
4. **不静默缩小范围。** 未做、没跑、不敢保证的事写进文档，不用注释或空实现敷衍。
5. **判分与证据代码只增不改语义。** `backend/domain/` 下的判分、证据与 FSRS 逻辑是可信度核心，
   改变其语义需要在 PR 中给出前后对照与影响面。
6. **导航与文案要中英日韩一致。** 四份 README 同步更新；界面文案走既有 locale 文件，不在组件里硬编码。

## 4. 代码风格

- Python：ruff（`line-length = 120`，规则见 `backend/pyproject.toml`），类型注解写在不言自明的地方。
- TypeScript：严格模式，`npx tsc -b` 必须无错；API 调用按域放在 `frontend/src/api/`，不要往 `client.ts` 兼容桶里加新东西。
- 提交信息：一句话说清「改了什么 + 为什么」，正文放测量数字与验证命令；不要把多个不相关改动塞进一个提交。

## 5. 提交流程

1. Fork 或从 `main` 切分支：`feat/…`、`fix/…`、`docs/…`。
2. 小步提交，每个提交自身可构建。
3. PR 描述包含：动机、改动点、**验证命令与输出摘要**、已知限制。
4. CI 必须绿；后端与浏览器套件的失败一律当真，不重跑掩盖。

## 6. 报告问题

Issue 里请附：复现步骤、期望与实际、后端 / 前端版本（`git rev-parse HEAD`）、
以及相关日志（后端 traceback、浏览器 console、`var/logs/` 下的 worker 日志）。
涉及数据问题时请说明是否可复现于 `load_demo_fixture` 的演示数据，**不要上传真实作答或私有材料**。

## 7. 安全问题

不要在公开 issue 中贴密钥、私有材料或可利用细节；请通过仓库的 Security 页面私下报告。
