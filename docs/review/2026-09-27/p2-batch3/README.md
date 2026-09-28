# P2 第三批交付证据（起点 `ac58807`，P1/P2 规划最后一批）

主报告：[22 P2 第三批交付](../../../22-p2-third-batch-delivery.md)。
本目录只保存本轮实际执行输出；未执行的项不写成通过。浏览器与演练使用独占库
`acepass_acceptance_p2_batch3`、独占 Redis 6399、端口 8019/5189。

## 1. 文件清单

| 文件 | 实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 正式后端全套 **489 passed / 251.38s**（起点 396 + 本轮迁入 93：模拟考试 14、表达式判分 68、报告范围与校准 11） |
| [browser-acceptance.txt](browser-acceptance.txt) | 隔离浏览器主套件 **78 passed / 1.7m**（P0 36 + 批次 1—5 的 36 + 本批 6） |
| [browser-acceptance-rerun.txt](browser-acceptance-rerun.txt) | 同一命令复跑 **78 passed**（两次一致） |
| [browser-acceptance-stub.txt](browser-acceptance-stub.txt) | stub 专跑 **8 passed** |
| [reviewer-eleven.txt](reviewer-eleven.txt) | 复验者原始后端反例（`p01-independent`，文件未改）**11 passed** |
| [archived-nine.txt](archived-nine.txt) | 上轮有效后端反例（`p02-independent`，文件未改）**9 passed, 1 deselected** |
| [reviewer-three.txt](reviewer-three.txt) | 复验者三条反例（`p02-final-independent`，文件未改）**3 passed** |
| [archived-browser.txt](archived-browser.txt) | 归档浏览器反例（未改）**2 passed** |
| [worker-drill.txt](worker-drill.txt)、[worker-drill.json](worker-drill.json) | 真故障演练 **ok=true** |
| [clean-export-release-gate.txt](clean-export-release-gate.txt) | 仅提交内容导出的干净副本：代理组件与真实全栈 HTTPS/CSRF 登录两步 exit 0，配置哨兵不变 |

## 2. 复现命令

见主报告 §5 与 `docs/19` §5（批次 6 使用库 `acepass_acceptance_p2_batch3`、Redis 6399、
API/Vite 端口 8019/5189、媒体目录 `var/private-media-p2-batch3`，重置脚本
`scripts/dev/reset-p2-batch3-browser.sh`）。浏览器两次运行（主套件 `--grep-invert "@stub"` 与 stub 专跑）。

## 3. 未验证项

- 真实模型能力（讲解/图片识别/手写转写/估分/标签建议/嵌入向量/变式生成）：无可用凭据，只有 stub 与脚本 provider 证据。
- 真实 ≥24 小时间隔的学习效果；真实考试材料（全部为明确标注的验收夹具）。
- 远程部署与 GitHub Actions 实际执行；真实 beat 计划下的到期清理调度；报告 1000 条上限的压测。
