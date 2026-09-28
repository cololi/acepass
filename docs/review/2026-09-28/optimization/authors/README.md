# 作者侧原始证据（Lead 归档，2026-09-28）

本目录是三个优化工作流**自己产出的原始证据**，由 Lead 从工作区的 `var/`（git 忽略区）复制进来，
目的只有一个：让交付记录里的数字可以被人复核，而不是只能相信一段总结。
**判据以独立复验者 [../README.md](../README.md) 的自写反例与门禁为准**，这里只提供作者侧的原始输出。

| 路径 | 内容 | 对应结论 |
|---|---|---|
| `w1/red-before.txt` | 用 `git show HEAD:` 换入优化前 `outbox.py` 后，新测试 **3 failed, 3 passed** | 缺陷在旧代码上真实存在 |
| `w1/green-after.txt` | 修复后同一命令 **6 passed** | 同一轮内被消费者领取并 `processed` |
| `w1/related-tests.txt` | 既有 outbox/worker 相关测试 **98 passed**（未改一行） | 无回归 |
| `w1/drill-after.txt` / `.json` | 真故障演练（Redis 6395、专用库）`{"ok": true}`，`unresolved={}`、18/18 processed | 真实 SIGKILL / FLUSHALL 恢复仍成立 |
| `w1/watch/*.log` | 演练 worker 原始日志，含第二个竞态窗口的现场（消息已在 broker、行仍被 UPDATE 锁着 → `is not claimable`） | 解释最终实现为何把投递记录放在 `send_task` 之前 |
| `w2/REPORT.md` | W2 自述：改动、命令、前后数字、EXPLAIN 决策、遗留风险 | `questions_list` 123→7、`practice_sessions_list` 67→8 |
| `w2/red-before.txt` | 测试写在改码之前：**2 failed**（26→56、19→31 查询） | "行数无关"是被断言锁住的 |
| `w2/body-diff.txt` | 10 个端点 before/after 响应体比对 | 行为不变（本轮结论由复验者用 oracle 再证一次） |
| `w2/explain-plans.txt` / `explain-at-scale.txt` / `bench-scale.txt` | 5000 题 / 20000 会话规模的 EXPLAIN 与基准 | 不加索引、不生成迁移的依据 |
| `measurements/baseline.json` | Lead 的量尺在**优化前**（`fe68b07` 干净树）的 10 个用例数据 | 全部 before 数字的出处 |
| `measurements/lead-verify.json` | Lead 冻结后独立复跑同一量尺 | 与作者数字一致，且 10 个端点响应字节数与基线逐项相同 |
| `measurements/after-w2.json` / `gate.json` | W2 自测与 Lead 终验门禁的探针输出 | — |
| `measurements/katex-runtime-probe.txt` | Lead 亲自重跑 W3 的浏览器探针（dev + 生产 preview） | 加载时 katex 请求 0、渲染后 3、字体 `KaTeX_Main` |

W3 的证据随源码提交在 [`frontend/perfprobe/`](../../../../frontend/perfprobe/)：
`baseline.json`、`after.json`、`report.md`、`vitest-before-after.txt`、`measure-dist.mjs`、
`math-probe.mjs`（可复跑的浏览器探针）。

复现命令：

```bash
bash scripts/dev/measure-hot-paths.sh                # 查询数与耗时（独立库 acepass_perfprobe）
bash scripts/dev/optimization-gate.sh                # 后端全量 + 静态检查 + 四组归档 + 探针
cd frontend && node perfprobe/measure-dist.mjs --label after --out perfprobe/after.json
cd frontend && node perfprobe/math-probe.mjs         # KaTeX 按需路径（dev + preview）
```
