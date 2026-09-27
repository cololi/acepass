# P2 第二批交付证据（起点 `7b323df`）

主报告：[21 P2 第二批交付](../../../21-p2-second-batch-delivery.md)。
本目录只保存本轮实际执行输出；未执行的项不写成通过。浏览器与演练使用独占库
`acepass_acceptance_p2_batch2` 与独占 Redis 6398、端口 8018/5188。

## 1. 文件清单

| 文件 | 实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 正式后端全套 **396 passed / 247.25s**（起点 366 + 本轮迁入 30：封存与家族合并 9、变式 21） |
| [browser-acceptance.txt](browser-acceptance.txt) | 隔离浏览器主套件 **72 passed / 1.6m**（P0 36 + 批次 1—4 的 30 + 本批 6） |
| [browser-acceptance-rerun.txt](browser-acceptance-rerun.txt) | 同一命令复跑 **72 passed**（两次一致） |
| [browser-acceptance-stub.txt](browser-acceptance-stub.txt) | stub 专跑 **8 passed**（批次 3 的 6 条 + 本批 2 条） |
| [reviewer-eleven.txt](reviewer-eleven.txt) | 复验者原始后端反例（`p01-independent`，文件未改）**11 passed** |
| [archived-nine.txt](archived-nine.txt) | 上轮有效后端反例（`p02-independent`，文件未改）**9 passed, 1 deselected** |
| [reviewer-three.txt](reviewer-three.txt) | 复验者三条反例（`p02-final-independent`，文件未改）**3 passed** |
| [archived-browser.txt](archived-browser.txt) | 归档浏览器反例（未改）**2 passed** |
| [worker-drill.txt](worker-drill.txt)、[worker-drill.json](worker-drill.json) | 真故障演练 **ok=true** |
| [clean-export-release-gate.txt](clean-export-release-gate.txt) | 仅提交内容导出的干净副本：代理组件与真实全栈 HTTPS/CSRF 登录两步 exit 0，配置哨兵不变 |

## 2. 复现命令

见主报告 §4 与 `docs/19` §5（批次 5 使用库 `acepass_acceptance_p2_batch2`、Redis 6398、
API/Vite 端口 8018/5188、媒体目录 `var/private-media-p2-batch2`，重置脚本
`scripts/dev/reset-p2-batch2-browser.sh`）。浏览器同样两次运行（主套件 `--grep-invert "@stub"` 与 stub 专跑）。

## 3. 未验证项

- 真实生成模型质量（变式提示词从未对真实模型运行）；真实考试材料的封存/合并语义。
- 真实 AI 讲解/图片识别/手写转写/估分/嵌入向量；真实 ≥24 小时学习效果；远程部署与 GitHub Actions 实际执行。
- 家族成员清单只读接口缺失（只能按题目 id 加入/移出，数量来自服务端 `member_count`）。
