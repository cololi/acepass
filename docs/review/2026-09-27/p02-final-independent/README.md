# `2c87e0c` 的独立定向复验资产

主报告：[14 独立复验](../../../14-p0-2-final-independent-review.md)。执行交接：[有限修复](../../../../DEEPSEEK_P0_2_FINAL_GAPS.md)。本目录只保存复验者证据，不改写交付者 `p02-remaining/` 或既往归档。

| 文件 | 结果与性质 |
|---|---|
| `backend-suite.txt` | 正式 194 条全部通过，真实独立 PostgreSQL 测试库 |
| `archived-nine.txt` | 原有效 9 条反例通过；旧迁移重编号测试明确 deselect，批准的安全拒绝语义在正式套件测试 |
| `remaining-three.txt` | 本目录三条新增业务反例的联合运行输出：3 failed，4.07s |
| `test_finish_replay.py` | C01：finish 重放不得绕过当前验证门禁 |
| `test_c02_version_branch.py` | C02：旧题干任务不得失效较新代次的证据 |
| `test_http_tutor_lease.py` | C04：实际 HTTP/autocommit 与 leased task 确定性交错，检查最终内容一致性 |
| `finish-replay-initial.txt`、`version-branch-initial.txt`、`http-tutor-initial.txt` | 各复验者首次定向运行；HTTP 最初用例约束较强，最终以联合运行和当前测试为准 |
| `proxy-component.txt` | 真实 Docker/nginx + 当前真实前端构建：组件通过 |
| `clean-checkout-template.txt`、`clean-export-full-stack.txt` | git 提交导出副本缺少模板，全栈检查实际退出 1 |
| `check_proxy_script_isolation.py`、`proxy-isolation-shim.json` | 完全拦截 Docker 的安全脚本检查；假 `.env` 哨兵被覆盖，记录默认 down -v 命令，未真实删卷 |
| `review_settings.py` | 专用测试数据库与临时媒体配置，不指向业务库 |

## 可复现入口

仓库根目录运行：

```bash
PYTHONPATH="$PWD/backend:$PWD/docs/review/2026-09-27/p02-final-independent" \
  backend/.venv/bin/python -m pytest \
  docs/review/2026-09-27/p02-final-independent/test_finish_replay.py \
  docs/review/2026-09-27/p02-final-independent/test_c02_version_branch.py \
  docs/review/2026-09-27/p02-final-independent/test_http_tutor_lease.py \
  -c backend/pytest.ini --ds=review_settings -q -s
```

专用 `TEST.NAME=test_acepass_review_4kdv8c`，pytest 完成后删除；使用前确认同名测试库不被其他运行占用。C04 的 provider 是 stub，交错是确定性模拟，不是本轮真实进程 kill 或真实模型。最终测试允许 Worker 在 HTTP 已持有租约时跳过，不规定必须调用模型两次。

原 9 条反例按原文件运行，仅用 `-k 'not generation_migration_cannot_promote'` 排除依赖已删除迁移接口的那 1 条；没有修改原反例以变绿。正式 194 条包括迁移安全拒绝/回滚/清单/正向路径。

干净导出复现使用 `git archive HEAD backend infra scripts` 到新临时目录，再复制本轮前端构建。脚本外显式设置 `COMPOSE_PROJECT_NAME=acepass_review_4kdv8c`、独立镜像标签和端口；这是本轮执行时的保护措施，不代表交付脚本自身已隔离。真实全栈停止于缺模板，没有读取或拷贝用户 `.env`。组件启动前确认固定容器名及端口均空闲，运行后容器、网络已清理。

本轮不重跑浏览器与 Worker 真故障演练；其交付者通过证据仍在原目录。未做业务迁移、部署、模型凭据读取或真实隔夜验证。只新增复验资产。
