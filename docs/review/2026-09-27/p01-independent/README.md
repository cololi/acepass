# P0.1 独立复验资产

审查 HEAD `f809365`。这组结果由独立复验产生，区别于上一层原 P0 失败证据及 `rerun/` 的交付者记录。

主报告：[09-p0-1-independent-reacceptance.md](../../../09-p0-1-independent-reacceptance.md)。

| 资产 | 实际结果 |
|---|---|
| [existing-pytest.txt](existing-pytest.txt) | 现有164测试通过，36.33s |
| [existing-browser-acceptance.txt](existing-browser-acceptance.txt) | 新验收30测试通过，36.9s |
| [new-backend-regressions.txt](new-backend-regressions.txt) | 11条新增测试失败，7.73s |
| [photo-draft-regression.txt](photo-draft-regression.txt) | 浏览器照片草稿刷新丢失，1 failed |
| [fill-editor-regression.txt](fill-editor-regression.txt) | 浏览器填空正式答案未保存，1 failed |
| [worker.txt](worker.txt)、[worker-db-summary.json](worker-db-summary.json) | 正常异步链50/50 processed，144证据/3状态/7复习任务 |
| [ci-configuration.txt](ci-configuration.txt) | 按workflow的库名加载配置即拒绝 |

11条后端测试涵盖6条数据分支、3条outbox分支、2条辅导/导入分支，并非11个独立模块都未实现。测试使用真实PostgreSQL，辅导与视觉用stub/直接服务调用证明业务控制边界，不代表真实模型质量。

## 后端复跑

在仓库根目录执行：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p01-independent" \
  backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p01-independent/test_*_gaps.py \
  -c backend/pytest.ini --ds=p01_independent_settings -q -s
```

配置固定专用 TEST.NAME 为 `test_acepass_p01_independent_gaps`，由pytest创建/销毁。测试文件：[数据](test_data_gaps.py)、[outbox](test_outbox_gaps.py)、[辅导/导入](test_tutor_and_import_gaps.py)。并发测试用两个真实事务，autocommit测试显式使用transaction=True。

## 浏览器复跑

本次使用新建数据库 `acepass_acceptance_p01_independent`、Redis6394、API8014、Vite5184、独立媒体、真实Worker。先跑现有acceptance配置准备其专用账户，再在同一隔离环境运行两条反例；没有对业务库做reset/rebuild。完成后临时数据库与服务均已清理，不能直接复用已删除的环境。

重跑时创建另一个空库（以 `acepass_acceptance_` 开头），先确认6394/8014/5184空闲，再设置：

```bash
export POSTGRES_DB=acepass_acceptance_p01_rerun
export REDIS_URL=redis://127.0.0.1:6394/0
export DJANGO_SETTINGS_MODULE=config.settings.dev
export ACEPASS_INLINE_TASKS=false
export ACEPASS_PRIVATE_MEDIA_ROOT="$(mktemp -d /tmp/acepass-p01-browser.XXXXXX)"
export ACEPASS_BROWSER_API_PORT=8014
export ACEPASS_BROWSER_WEB_PORT=5184
export DJANGO_CSRF_TRUSTED_ORIGINS=http://127.0.0.1:5184,http://127.0.0.1:8014
```

在独立终端启动只监听本机的Redis `redis-server --bind 127.0.0.1 --port 6394 --save '' --appendonly no`；在backend目录使用同样环境启动 `.venv/bin/celery -A config worker --pool=solo -Q ingestion,tutoring,projection -c 1 -l INFO`。数据库须预先按本机认证方式创建，以上命令不会自动创建库。

先在frontend目录运行 `node_modules/.bin/playwright test --config playwright.acceptance.config.ts`，再回仓库根目录：

```bash
frontend/node_modules/.bin/playwright test \
  --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs
```

归档配置把实际临时配置整理为相对路径，增加环境检查；整理后仅做加载/发现检查。两条实际失败原始运行输出保留了当时/tmp路径。修复前预期失败，修复后应迁入常规套件。

测试：[照片草稿](draft-regression.spec.ts)、[填空编辑](fill-editor.spec.ts)；截图：[照片刷新](screenshots/photo-draft.png)、[填空保存](screenshots/fill-editor.png)。`fill-source.png` 是专用生成图片，不含用户材料。

Worker快照采于30测试与照片草稿测试完成后、填空校对测试开始前。它证明正常消费，不证明租约竞争/真实故障注入。原16浏览器套件本次未另跑，Compose全栈、真实provider和真实隔天也未独立复跑。
