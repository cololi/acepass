# P0.2 独立复验资产

审查 HEAD `c168583`，代码 `bfbbfbd`。主报告：[12独立复验](../../../12-p0-2-independent-review.md)。本目录与 `p02-closeout/` 的交付者运行记录分开保留。

| 文件 | 本次实际结果 |
|---|---|
| [existing-pytest.txt](existing-pytest.txt) | 177 passed / 51.17s |
| [archived-backend.txt](archived-backend.txt) | 上一轮原始11反例全部通过 / 5.05s |
| [browser-acceptance.txt](browser-acceptance.txt) | 36 passed / 51.1s |
| [archived-browser.txt](archived-browser.txt) | 上一轮原始2浏览器反例通过 / 4.4s |
| [archived-tests-integrity.json](archived-tests-integrity.json) | 对照上一轮ZIP，5份反例文件字节一致 |
| [remaining-regressions.txt](remaining-regressions.txt) | 10 failed / 7.40s；5门禁入口、3重判/延迟、2辅导恢复 |
| [audit-positive-results.txt](audit-positive-results.txt) | 1 passed；当前投影审计、superseded保留、前后值批次齐全 |
| [restore-unreachable.txt](restore-unreachable.txt) | 不可连数据库恢复 dry-run 明确退出1 |
| [worker-drill.txt](worker-drill.txt)、[JSON](worker-drill.json) | 真Redis清空与中途kill恢复通过；双消费者阶段1条未确认，整体ok=false |

## 定向后端回归

在仓库根目录执行：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-independent" \
  backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p02-independent/test_*.py \
  -c backend/pytest.ini --ds=p02_independent_settings -q -s
```

专用 TEST.NAME=`test_acepass_p02_independent_gaps`。测试为 [结果交付门禁](test_delivery_gates.py)、[重判/迁移/延迟](test_regrade_and_delay.py)、[辅导恢复](test_tutor_recovery.py)。迁移测试仅在专用测试事务内移除约束，以构造旧版实际可达数据，再执行迁移SQL；完成后数据库由pytest删除，禁止对业务库运行这些构造步骤。

正向审计测试保存在 [audit_positive_check.py](audit_positive_check.py)，可以用同一命令显式指定此文件单独运行。它在测试库中验证--apply，绝不指向业务库。

本组10个失败是有限的交叉边界集合，已在原始套件全绿后复现；修实现后迁入正式套件。辅导模型使用stub，进程中断/租约接管采用确定性交错模拟，不与下面的真故障证据混用。

## 浏览器与真故障环境

本次独立创建 `acepass_acceptance_p02_independent`；Redis6394整个实例、API8014、Vite5184、媒体目录都专用。环境变量模式与 [上一轮隔离说明](../p01-independent/README.md) 一致，另设 `ACEPASS_OUTBOX_LEASE_SECONDS=5` 以缩短故障恢复演练。

先启动专用Redis和浏览器Worker，在frontend运行 `node_modules/.bin/playwright test --config playwright.acceptance.config.ts`，然后在仓库根目录运行归档配置 `frontend/node_modules/.bin/playwright test --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs`。

故障脚本运行前停止浏览器Worker，并核对Redis没有其他使用者；只允许脚本自己的Worker运行。脚本会 **FLUSHALL整个Redis实例**，仅换Redis DB编号不能隔离。

```bash
ACEPASS_OUTBOX_LEASE_SECONDS=5 \
  ACEPASS_WORKER_DRILL_REPORT=/tmp/acepass-independent-drill.json \
  PYTHONPATH="$PWD/backend" \
  backend/.venv/bin/python scripts/verify_worker_e2e.py
```

以上依赖同一隔离环境的 POSTGRES_DB、REDIS_URL、DJANGO_SETTINGS_MODULE、ACEPASS_INLINE_TASKS=false、私有媒体变量；不能直接复制后用默认开发库/缓存执行。

本次先中止了一次尚有浏览器Worker存活的启动尝试，未将它计入验收；核实清理后重新执行的完整脚本结果保存在本目录。完整运行开始前1条遗留事件单独记账并在后续扫描恢复；最终未处理的1条属于新演练事件。Redis丢失与kill命中均为真实动作；双消费者最终超时，不能把文件里某个 evidence_rows=6 的局部ok=true当作整体通过。

诊断日志：[浏览器Worker](browser-worker.txt)、[drill-primary](drill-primary.log)、[drill-secondary](drill-secondary.log)。脚本退出后已确认自建Worker全部停止，停止自建Redis并删除本次浏览器数据库；现有8000/5173和业务库未改。

本轮没有另跑原16浏览器，也没有启动Docker/运行GitHub Actions/接真实provider/真实等待24h；对应历史记录或明确未验证状态均不冒充本次独立结果。
